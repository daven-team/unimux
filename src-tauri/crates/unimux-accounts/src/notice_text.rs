//! The texts of the limit warnings and the automatic-switch notices (`limitNoticeText` of src/shared/limitAlerts.ts,
//! `resetClock` / `autoSwitchText` of src/shared/autoSwitch.ts).
//!
//! 1.1.4 formatted the reset time with `toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })` and the day
//! with `toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'numeric' })`. The app has exactly six
//! languages, so the CLDR patterns of those two calls are written out here instead of pulling a date-format engine in; the
//! table matches Node 26 / ICU 78 (`notice_text::tests::matches_node_intl`, strings taken from Node).

use crate::auto_switch::{NoticeKind, SwitchNotice};
use crate::limit_alerts::LimitNotice;
use crate::localtime::local_fields;
use crate::usage::types::{Provider, WindowId};
use unimux_core::i18n::translate;

const TITLE: &str = "Konta i limity";

/// Short weekday names (Sunday first, like `getDay`) per language.
fn weekdays(language: &str) -> [&'static str; 7] {
    match language {
        "en" => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        "de" => ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."],
        "es" => ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
        "fr" => ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
        "pt" => ["dom.", "seg.", "ter.", "qua.", "qui.", "sex.", "sáb."],
        _ => ["niedz.", "pon.", "wt.", "śr.", "czw.", "pt.", "sob."],
    }
}

/// `toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })` in the OS time zone.
pub fn locale_time(ms: f64, language: &str) -> String {
    let t = local_fields(ms);
    if language == "en" {
        let h12 = match t.hour % 12 {
            0 => 12,
            h => h,
        };
        return format!("{h12:02}:{:02} {}", t.minute, if t.hour < 12 { "AM" } else { "PM" });
    }
    format!("{:02}:{:02}", t.hour, t.minute)
}

/// `toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'numeric' })` in the OS time zone.
pub fn locale_short_date(ms: f64, language: &str) -> String {
    let t = local_fields(ms);
    let wd = weekdays(language)[t.weekday as usize % 7];
    let (d, m) = (t.day, t.month);
    match language {
        "en" => format!("{wd}, {m}/{d}"),
        "de" => format!("{wd}, {d}.{m}."),
        "es" => format!("{wd}, {d}/{m}"),
        "fr" => format!("{wd} {d:02}/{m:02}"),
        "pt" => format!("{wd}, {d:02}/{m:02}"),
        _ => format!("{wd}, {d}.{m}"),
    }
}

/// `toDateString()` equality in the OS time zone.
fn same_local_day(a_ms: f64, b_ms: f64) -> bool {
    local_fields(a_ms).same_day(&local_fields(b_ms))
}

/// `(email || 'Claude' / 'Codex').slice(0, 60)` (UTF-16 units; a cut surrogate pair is dropped).
fn name_of(email: Option<&str>, provider: Provider) -> String {
    let name = email.filter(|e| !e.is_empty()).unwrap_or(match provider {
        Provider::Claude => "Claude",
        Provider::Codex => "Codex",
    });
    let mut units = 0;
    let mut out = String::new();
    for c in name.chars() {
        units += c.len_utf16();
        if units > 60 {
            break;
        }
        out.push(c);
    }
    out
}

/// `String(n)` for the percent (whole numbers in practice).
fn number(n: f64) -> String {
    crate::js::num(n).to_string()
}

/// `limitNoticeText`: title and body of a limit warning.
pub fn limit_notice_text(notice: &LimitNotice, language: &str, now_ms: f64) -> (String, String) {
    let tr = |key: &str, params: &[(&str, &str)]| translate(language, key, params);
    let account = name_of(notice.email.as_deref(), notice.provider);
    let window = if notice.window == WindowId::FiveHour { "5 h".to_string() } else { tr("7 dni", &[]) };
    let title = tr(TITLE, &[]);
    if notice.reset {
        return (title, tr("Konto {account}: limit {window} znowu dostępny", &[("account", &account), ("window", &window)]));
    }
    let at = notice.resets_at * 1000.0;
    let time = locale_time(at, language);
    let percent = number(notice.percent.unwrap_or(0.0));
    let mut params = vec![("account", account.as_str()), ("window", window.as_str()), ("percent", percent.as_str()), ("time", time.as_str())];
    if same_local_day(at, now_ms) {
        return (title, tr("Konto {account}: limit {window} wykorzystany w {percent}%, reset o {time}", &params));
    }
    let date = locale_short_date(at, language);
    params.push(("date", date.as_str()));
    (title, tr("Konto {account}: limit {window} wykorzystany w {percent}%, reset {date} o {time}", &params))
}

/// `resetClock`: "21:00", or "pt., 7.11 o 21:00"-like for another day.
pub fn reset_clock(resets_at: f64, language: &str, now_ms: f64) -> String {
    let at = resets_at * 1000.0;
    let time = locale_time(at, language);
    if same_local_day(at, now_ms) {
        return time;
    }
    let date = locale_short_date(at, language);
    translate(language, "{date} o {time}", &[("date", &date), ("time", &time)])
}

/// `autoSwitchText`: what the notifications and the panel say about a switch, an offer, no room anywhere or a failure.
pub fn auto_switch_text(event: &SwitchNotice, language: &str, now_ms: f64) -> (String, String) {
    let tr = |key: &str, params: &[(&str, &str)]| translate(language, key, params);
    let title = tr(TITLE, &[]);
    let to = name_of(event.to_email.as_deref(), event.provider);
    let from = name_of(event.from_email.as_deref(), event.provider);
    let window = if event.window == Some(WindowId::SevenDay) { tr("7 dni", &[]) } else { "5 h".to_string() };
    let percent = number(event.percent.unwrap_or(0.0));
    let p = [("to", to.as_str()), ("from", from.as_str()), ("window", window.as_str()), ("percent", percent.as_str())];
    let body = match event.kind {
        NoticeKind::Switched => tr("Przełączono na {to}: limit {window} konta {from} wykorzystany w {percent}%", &p),
        NoticeKind::Returned => tr("Wrócono na konto podstawowe {to}: jego limit znowu jest dostępny", &p),
        NoticeKind::Offer => tr("Limit {window} konta {from} wykorzystany w {percent}%. Konto {to} ma zapas.", &p),
        NoticeKind::ReturnOffer => tr("Konto podstawowe {to} znowu ma zapas.", &p),
        NoticeKind::Exhausted => {
            let when = match event.resets_at {
                Some(r) if r != 0.0 => reset_clock(r, language, now_ms),
                _ => String::new(),
            };
            let q = [("to", to.as_str()), ("time", when.as_str())];
            match (event.target_only, when.is_empty()) {
                (true, false) => {
                    tr("Wybrane konto {to} też przekroczyło próg, reset {time}. Konto główne zostaje bez zmian.", &q)
                }
                (true, true) => tr("Wybrane konto {to} nie może teraz przejąć pracy. Konto główne zostaje bez zmian.", &q),
                (false, false) => tr("Wszystkie konta przekroczyły próg, najbliższy reset: {to} o {time}", &q),
                (false, true) => tr("Wszystkie konta przekroczyły próg. Konto główne zostaje bez zmian.", &[]),
            }
        }
        NoticeKind::Failed => tr("Nie udało się przełączyć na {to}. Konto główne zostało bez zmian.", &p),
    };
    (title, body)
}

/// The offer button: "Przełącz na {to}".
pub fn switch_button_text(event: &SwitchNotice, language: &str) -> String {
    translate(language, "Przełącz na {to}", &[("to", &name_of(event.to_email.as_deref(), event.provider))])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::localtime::{days_from_civil, local_to_utc};

    /// A local wall-clock time as epoch ms (what `new Date(y, m - 1, d, h, min)` gives).
    fn local(y: i64, m: u32, d: u32, h: u32, min: u32) -> f64 {
        let wall = (days_from_civil(y, i64::from(m), i64::from(d)) * 86_400_000) as f64 + f64::from(h * 3600 + min * 60) * 1000.0;
        local_to_utc(wall)
    }

    #[test]
    fn matches_node_intl() {
        // Node 26 (ICU 78): `new Date(2026, 10, d + 1, 9, 5).toLocaleDateString(l, { weekday: 'short', day: 'numeric',
        // month: 'numeric' })` for d = 1..7, four times of 2026-01-03 and 2026-12-25.
        let expected: [(&str, [&str; 12]); 6] = [
            ("pl", ["pon., 2.11", "wt., 3.11", "śr., 4.11", "czw., 5.11", "pt., 6.11", "sob., 7.11", "niedz., 8.11", "00:07", "09:07", "12:07", "21:30", "pt., 25.12"]),
            ("en", ["Mon, 11/2", "Tue, 11/3", "Wed, 11/4", "Thu, 11/5", "Fri, 11/6", "Sat, 11/7", "Sun, 11/8", "12:07 AM", "09:07 AM", "12:07 PM", "09:30 PM", "Fri, 12/25"]),
            ("de", ["Mo., 2.11.", "Di., 3.11.", "Mi., 4.11.", "Do., 5.11.", "Fr., 6.11.", "Sa., 7.11.", "So., 8.11.", "00:07", "09:07", "12:07", "21:30", "Fr., 25.12."]),
            ("es", ["lun, 2/11", "mar, 3/11", "mié, 4/11", "jue, 5/11", "vie, 6/11", "sáb, 7/11", "dom, 8/11", "00:07", "09:07", "12:07", "21:30", "vie, 25/12"]),
            ("fr", ["lun. 02/11", "mar. 03/11", "mer. 04/11", "jeu. 05/11", "ven. 06/11", "sam. 07/11", "dim. 08/11", "00:07", "09:07", "12:07", "21:30", "ven. 25/12"]),
            ("pt", ["seg., 02/11", "ter., 03/11", "qua., 04/11", "qui., 05/11", "sex., 06/11", "sáb., 07/11", "dom., 08/11", "00:07", "09:07", "12:07", "21:30", "sex., 25/12"]),
        ];
        for (lang, want) in expected {
            let mut got: Vec<String> = (1..=7).map(|d| locale_short_date(local(2026, 11, d + 1, 9, 5), lang)).collect();
            for (h, m) in [(0, 7), (9, 7), (12, 7), (21, 30)] {
                got.push(locale_time(local(2026, 1, 3, h, m), lang));
            }
            got.push(locale_short_date(local(2026, 12, 25, 21, 30), lang));
            assert_eq!(got, want, "{lang}");
        }
    }

    #[test]
    fn limit_and_switch_texts() {
        let now = local(2026, 11, 6, 10, 0);
        let same_day = local(2026, 11, 6, 21, 0) / 1000.0;
        let next_day = local(2026, 11, 7, 21, 0) / 1000.0;
        let n = LimitNotice {
            reset: false,
            provider: Provider::Claude,
            email: Some("support@example.com".into()),
            window: WindowId::FiveHour,
            percent: Some(82.0),
            resets_at: same_day,
        };
        assert_eq!(
            limit_notice_text(&n, "pl", now),
            ("Konta i limity".into(), "Konto support@example.com: limit 5 h wykorzystany w 82%, reset o 21:00".into())
        );
        let later = LimitNotice { resets_at: next_day, window: WindowId::SevenDay, email: None, ..n.clone() };
        assert_eq!(limit_notice_text(&later, "pl", now).1, "Konto Claude: limit 7 dni wykorzystany w 82%, reset sob., 7.11 o 21:00");
        let reset = LimitNotice { reset: true, ..n };
        assert_eq!(limit_notice_text(&reset, "pl", now).1, "Konto support@example.com: limit 5 h znowu dostępny");

        let mut e = SwitchNotice::new(NoticeKind::Exhausted, Provider::Codex);
        e.to_email = Some("b@x.io".into());
        e.resets_at = Some(same_day);
        assert_eq!(auto_switch_text(&e, "pl", now).1, "Wszystkie konta przekroczyły próg, najbliższy reset: b@x.io o 21:00");
        e.resets_at = None;
        assert_eq!(auto_switch_text(&e, "pl", now).1, "Wszystkie konta przekroczyły próg. Konto główne zostaje bez zmian.");
        let mut s = SwitchNotice::new(NoticeKind::Switched, Provider::Claude);
        s.from_email = Some("a@x.io".into());
        s.window = Some(WindowId::FiveHour);
        s.percent = Some(95.0);
        assert_eq!(auto_switch_text(&s, "pl", now).1, "Przełączono na Claude: limit 5 h konta a@x.io wykorzystany w 95%");
        assert_eq!(switch_button_text(&s, "pl"), "Przełącz na Claude");
        assert_eq!(name_of(Some(&"x".repeat(80)), Provider::Claude).len(), 60);
    }
}
