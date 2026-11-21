//! The plan fields of `GET /api/oauth/profile` (1.2.6, after claude-swap 1.1.0's subscription.py): read only when the usage
//! endpoint answered 403, with the access token that was just used (never renewed for this), to tell a lapsed subscription
//! from other refusals. An answer counts only when its account and organisation UUIDs match the login it was read for.

use serde_json::Value;

use crate::identity::AccountIdentity;

/// The rate-limit tier of an account without a paid plan.
pub const FREE_TIER: &str = "default_claude_ai";

/// What the profile says about the organisation's plan (no token, no e-mail).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Profile {
    pub tier: String,
    pub subscription_status: Option<String>,
    pub organization_type: Option<String>,
    pub plan_display_name: Option<String>,
    pub billing_type: Option<String>,
    pub account_uuid: Option<String>,
    pub organization_uuid: Option<String>,
    /// 1.2.7: the page that pays an overdue invoice (`payment_auth_hosted_invoice_url`), only a claude.ai address.
    pub payment_url: Option<String>,
}

/// 1.2.7: the only address a payment link may open.
pub const PAYMENT_URL_PREFIX: &str = "https://claude.ai/";

/// A payment link the card may open: a claude.ai page without spaces or control characters, at most 300 characters.
pub fn payment_url(raw: Option<String>) -> Option<String> {
    raw.filter(|u| u.starts_with(PAYMENT_URL_PREFIX) && u.len() <= 300 && !u.chars().any(|c| c.is_whitespace() || c.is_control()))
}

fn text(o: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    o.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The profile body; `None` without an organisation or a non-empty `rate_limit_tier` (no answer rather than an empty plan).
pub fn parse_profile(body: &Value) -> Option<Profile> {
    let org = body.get("organization")?.as_object()?;
    let tier = text(org, "rate_limit_tier")?;
    Some(Profile {
        tier,
        subscription_status: text(org, "subscription_status"),
        organization_type: text(org, "organization_type"),
        plan_display_name: text(org, "plan_display_name"),
        billing_type: text(org, "billing_type"),
        account_uuid: body.get("account").and_then(Value::as_object).and_then(|a| text(a, "uuid")),
        organization_uuid: text(org, "uuid"),
        payment_url: payment_url(text(org, "payment_auth_hosted_invoice_url")),
    })
}

impl Profile {
    /// Every UUID the login records must match, and at least one must be recorded: a login without either cannot confirm
    /// whose answer this is.
    pub fn belongs_to(&self, identity: &AccountIdentity) -> bool {
        let pairs = [(&identity.account_uuid, &self.account_uuid), (&identity.organization_uuid, &self.organization_uuid)];
        let recorded: Vec<_> = pairs.iter().filter(|(r, _)| r.as_deref().is_some_and(|s| !s.is_empty())).collect();
        !recorded.is_empty() && recorded.iter().all(|(r, seen)| r == seen)
    }

    /// Lapsed: `canceled` AND back on the free tier (neither alone), and not a Pro, Team or Enterprise organisation (a
    /// paying Pro reports the free tier too).
    pub fn lapsed(&self) -> bool {
        let org_plan = matches!(self.organization_type.as_deref(), Some("claude_pro" | "claude_team" | "claude_enterprise"));
        self.subscription_status.as_deref() == Some("canceled") && self.tier == FREE_TIER && !org_plan
    }

    /// 1.2.7: the subscription is not paid (`past_due`, `unpaid`): the plan stays, the limits are refused until it is paid.
    pub fn unpaid(&self) -> bool {
        matches!(self.subscription_status.as_deref(), Some("past_due" | "unpaid"))
    }

    /// The plan badge: the organisation type where it names the plan, else the server's plan name, else the tier's label,
    /// else the raw tier (claude-swap's `plan_label`).
    pub fn label(&self) -> String {
        let org = match self.organization_type.as_deref() {
            Some("claude_team") => Some("Team"),
            Some("claude_enterprise") => Some("Enterprise"),
            Some("claude_pro") => Some("Pro"),
            _ => None,
        };
        if let Some(o) = org {
            return o.to_string();
        }
        let label = match self.tier.as_str() {
            FREE_TIER => "Free",
            "default_claude_max_5x" => "Max 5x",
            "default_claude_max_20x" => "Max 20x",
            other => other,
        };
        // The server's name wins unless the table names the same plan more precisely ("Max" vs "Max 5x").
        match self.plan_display_name.as_deref() {
            Some(name) if !label.starts_with(name) => name.to_string(),
            _ => label.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn identity(account: Option<&str>, org: Option<&str>) -> AccountIdentity {
        AccountIdentity {
            account_uuid: account.map(str::to_string),
            organization_uuid: org.map(str::to_string),
            ..AccountIdentity::default()
        }
    }

    fn body(status: &str, tier: &str, org_type: &str) -> Value {
        json!({
            "account": { "uuid": "acc-1", "email": "a@x.io" },
            "organization": { "uuid": "org-1", "subscription_status": status, "rate_limit_tier": tier,
                              "organization_type": org_type, "billing_type": "none" },
        })
    }

    #[test]
    fn a_lapsed_subscription_needs_both_canceled_and_the_free_tier() {
        let lapsed = parse_profile(&body("canceled", "default_claude_ai", "claude_max")).unwrap();
        assert!(lapsed.lapsed());
        assert_eq!(lapsed.label(), "Free");
        // Cancelled but still in its period: the tier is still Max.
        assert!(!parse_profile(&body("canceled", "default_claude_max_5x", "claude_max")).unwrap().lapsed());
        assert!(!parse_profile(&body("active", "default_claude_ai", "claude_max")).unwrap().lapsed());
        // A paying Pro and Team / Enterprise seats report the default tier too.
        for org in ["claude_pro", "claude_team", "claude_enterprise"] {
            assert!(!parse_profile(&body("canceled", "default_claude_ai", org)).unwrap().lapsed(), "{org}");
        }
        assert!(parse_profile(&json!({ "organization": { "uuid": "o" } })).is_none());
        assert!(parse_profile(&json!([])).is_none());
    }

    #[test]
    fn an_unpaid_subscription_keeps_its_plan_and_offers_only_a_claude_ai_payment_page() {
        let mut b = body("past_due", "default_claude_max_5x", "claude_max");
        b["organization"]["payment_auth_hosted_invoice_url"] =
            json!("https://claude.ai/settings/billing/x?action=pay_overdue_invoice");
        let p = parse_profile(&b).unwrap();
        assert!(p.unpaid() && !p.lapsed());
        assert_eq!(p.label(), "Max 5x");
        assert_eq!(p.payment_url.as_deref(), Some("https://claude.ai/settings/billing/x?action=pay_overdue_invoice"));
        assert!(parse_profile(&body("unpaid", "default_claude_max_5x", "claude_max")).unwrap().unpaid());
        assert!(!parse_profile(&body("active", "default_claude_max_5x", "claude_max")).unwrap().unpaid());
        for bad in [
            "https://evil.example/pay",
            "http://claude.ai/pay",
            "https://claude.ai.evil.io/x",
            "https://claude.ai/a b",
            "javascript:alert(1)",
        ] {
            assert_eq!(payment_url(Some(bad.into())), None, "{bad}");
        }
    }

    #[test]
    fn an_answer_counts_only_for_the_login_it_belongs_to() {
        let p = parse_profile(&body("canceled", "default_claude_ai", "claude_max")).unwrap();
        assert!(p.belongs_to(&identity(Some("acc-1"), Some("org-1"))));
        assert!(p.belongs_to(&identity(Some("acc-1"), None)));
        assert!(p.belongs_to(&identity(None, Some("org-1"))));
        assert!(!p.belongs_to(&identity(Some("acc-2"), Some("org-1"))));
        assert!(!p.belongs_to(&identity(Some("acc-1"), Some("org-2"))));
        assert!(!p.belongs_to(&identity(None, None)), "nothing recorded: nothing proven");
    }

    #[test]
    fn plan_labels_follow_claude_swap() {
        let label = |tier: &str, org: &str, name: Option<&str>| {
            let mut b = body("active", tier, org);
            if let Some(n) = name {
                b["organization"]["plan_display_name"] = json!(n);
            }
            parse_profile(&b).unwrap().label()
        };
        assert_eq!(label("default_claude_max_5x", "claude_max", None), "Max 5x");
        assert_eq!(label("default_claude_max_5x", "claude_max", Some("Max")), "Max 5x");
        assert_eq!(label("default_claude_max_20x", "claude_max", Some("Ultra")), "Ultra");
        assert_eq!(label("default_claude_ai", "claude_pro", None), "Pro");
        assert_eq!(label("default_claude_zero", "claude_enterprise", None), "Enterprise");
        assert_eq!(label("default_claude_new", "claude_max", None), "default_claude_new");
    }
}
