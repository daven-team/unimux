//! The part of zod 4 (4.6.7, en locale) the automation and MCP tool schemas use, with the same results: the parsed output
//! (trimmed strings, filled defaults, keys in shape order, absent optionals left out) or the same issue list (code, path,
//! message, in zod's order). zod 4.6.7 measures string lengths in Unicode code points (an emoji is 1), not UTF-16 units.
//!
//! zod's order, as checked against `test/golden/mcp-zod.jsonl`:
//! - an object reports its shape keys in shape order, then one `unrecognized_keys` issue (strict objects) naming the
//!   unknown keys in input order;
//! - a string runs its checks in declaration order (trim first, min, max, regex) and reports every failed one; a value of
//!   the wrong type gets the type issue and still the min / max checks when it has a length (a string or an array);
//! - a number that is not an integer fails `.int()` alone (it aborts); one outside the safe range gets the `int` range
//!   issue and the later min / max checks too;
//! - an array longer than its max reports only `too_big` (zod's size cap aborts before the items); otherwise the item
//!   issues come first, then `min`.
//!
//! Deviations a Rust value cannot avoid: a number beyond the f64 range reaches a schema as null (JSON.parse gives
//! Infinity, so zod says `received Infinity`), and a lone surrogate in a string is U+FFFD.

use serde_json::{Map, Value};
use unimux_core::js_json;
use unimux_core::utf16;

/// One step of an issue path (`path.join('.')` writes both as text).
#[derive(Debug, Clone, PartialEq)]
pub enum PathPart {
    Key(String),
    Index(usize),
}

impl PathPart {
    fn to_json(&self) -> Value {
        match self {
            PathPart::Key(k) => Value::String(k.clone()),
            PathPart::Index(i) => Value::from(*i),
        }
    }
    fn text(&self) -> String {
        match self {
            PathPart::Key(k) => k.clone(),
            PathPart::Index(i) => i.to_string(),
        }
    }
}

/// A zod issue (code, path, message as the en locale writes it).
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub code: &'static str,
    pub path: Vec<PathPart>,
    pub message: String,
}

impl Issue {
    /// `{code, path, message}` as the golden corpus stores it.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("code".into(), Value::from(self.code));
        m.insert("path".into(), Value::Array(self.path.iter().map(PathPart::to_json).collect()));
        m.insert("message".into(), Value::from(self.message.clone()));
        Value::Object(m)
    }
}

/// mcpTools.ts describeError of a ZodError: `Invalid arguments - ` and the first five issues as `path: message`
/// (`arguments` for the root).
pub fn describe(issues: &[Issue]) -> String {
    let parts: Vec<String> = issues
        .iter()
        .take(5)
        .map(|i| {
            let path = i.path.iter().map(PathPart::text).collect::<Vec<_>>().join(".");
            format!("{}: {}", if path.is_empty() { "arguments" } else { &path }, i.message)
        })
        .collect();
    format!("Invalid arguments - {}", parts.join("; "))
}

/// A `z.string().regex(...)` pattern: its source (the message shows `/source/`) and the test.
#[derive(Clone, Copy)]
pub struct Pattern {
    pub source: &'static str,
    pub test: fn(&str) -> bool,
}

/// A number check in declaration order.
#[derive(Debug, Clone, Copy)]
pub enum NumCheck {
    /// `.min(n)`
    Gte(f64),
    /// `.positive()` (`> 0`)
    Gt(f64),
    /// `.max(n)`
    Lte(f64),
}

/// The schema kinds the automation and tool schemas are made of.
#[derive(Clone)]
pub enum Schema {
    /// `z.string()` with `.trim()`, `.min()`, `.max()`, `.regex()` in that order.
    Str {
        trim: bool,
        min: Option<usize>,
        max: Option<usize>,
        pattern: Option<Pattern>,
    },
    /// `z.number()` with `.int()` first and then the checks.
    Num {
        int: bool,
        checks: Vec<NumCheck>,
    },
    Bool,
    Unknown,
    /// `z.literal(true)`
    True,
    /// `z.enum([...])`
    Enum(Vec<&'static str>),
    /// `z.array(item)` with `.min()` / `.max()`.
    Array {
        item: Box<Schema>,
        min: Option<usize>,
        max: Option<usize>,
    },
    /// `z.object(shape)`, `.strict()` when `strict`.
    Object {
        shape: Vec<(&'static str, Schema)>,
        strict: bool,
    },
    Optional(Box<Schema>),
    Nullable(Box<Schema>),
    /// `.default(value)`: an absent value becomes the default (not parsed again).
    Default(Box<Schema>, Value),
}

// --- builders ---

pub fn string() -> Schema {
    Schema::Str { trim: false, min: None, max: None, pattern: None }
}
pub fn number() -> Schema {
    Schema::Num { int: false, checks: Vec::new() }
}
pub fn int() -> Schema {
    Schema::Num { int: true, checks: Vec::new() }
}
pub fn boolean() -> Schema {
    Schema::Bool
}
pub fn unknown() -> Schema {
    Schema::Unknown
}
pub fn literal_true() -> Schema {
    Schema::True
}
pub fn enumeration(values: &[&'static str]) -> Schema {
    Schema::Enum(values.to_vec())
}
pub fn array(item: Schema) -> Schema {
    Schema::Array { item: Box::new(item), min: None, max: None }
}
/// A strict object (every object schema of the automation and the tools is strict).
pub fn object(shape: Vec<(&'static str, Schema)>) -> Schema {
    Schema::Object { shape, strict: true }
}

impl Schema {
    pub fn trim(mut self) -> Self {
        if let Schema::Str { trim, .. } = &mut self {
            *trim = true;
        }
        self
    }
    /// `.min(n)`: string length, array length or number (`>=`).
    pub fn min(mut self, n: f64) -> Self {
        match &mut self {
            Schema::Str { min, .. } | Schema::Array { min, .. } => *min = Some(n as usize),
            Schema::Num { checks, .. } => checks.push(NumCheck::Gte(n)),
            _ => {}
        }
        self
    }
    /// `.max(n)`: string length, array length or number (`<=`).
    pub fn max(mut self, n: f64) -> Self {
        match &mut self {
            Schema::Str { max, .. } | Schema::Array { max, .. } => *max = Some(n as usize),
            Schema::Num { checks, .. } => checks.push(NumCheck::Lte(n)),
            _ => {}
        }
        self
    }
    pub fn positive(mut self) -> Self {
        if let Schema::Num { checks, .. } = &mut self {
            checks.push(NumCheck::Gt(0.0));
        }
        self
    }
    pub fn regex(mut self, p: Pattern) -> Self {
        if let Schema::Str { pattern, .. } = &mut self {
            *pattern = Some(p);
        }
        self
    }
    pub fn optional(self) -> Self {
        Schema::Optional(Box::new(self))
    }
    pub fn nullable(self) -> Self {
        Schema::Nullable(Box::new(self))
    }
    pub fn default(self, value: Value) -> Self {
        Schema::Default(Box::new(self), value)
    }
    /// `.extend(more).strict()` of an object schema.
    pub fn extend(self, more: Vec<(&'static str, Schema)>) -> Self {
        match self {
            Schema::Object { mut shape, strict } => {
                for (k, s) in more {
                    match shape.iter_mut().find(|(key, _)| *key == k) {
                        Some(slot) => slot.1 = s,
                        None => shape.push((k, s)),
                    }
                }
                Schema::Object { shape, strict }
            }
            other => other,
        }
    }

    /// The keys of an object schema (zod `.shape`).
    pub fn shape_keys(&self) -> Vec<&'static str> {
        match self {
            Schema::Object { shape, .. } => shape.iter().map(|(k, _)| *k).collect(),
            _ => Vec::new(),
        }
    }

    /// `schema.safeParse(input)`: the output or the issues.
    pub fn parse(&self, input: &Value) -> Result<Value, Vec<Issue>> {
        let mut issues = Vec::new();
        let mut path = Vec::new();
        let out = self.run(Some(input), &mut path, &mut issues);
        if issues.is_empty() { Ok(out.unwrap_or(Value::Null)) } else { Err(issues) }
    }

    /// Absent in, absent out is allowed (`.optional()` with no value).
    fn optional_out(&self) -> bool {
        matches!(self, Schema::Optional(_) | Schema::Unknown)
    }

    fn run(&self, input: Option<&Value>, path: &mut Vec<PathPart>, issues: &mut Vec<Issue>) -> Option<Value> {
        let issue = |issues: &mut Vec<Issue>, path: &Vec<PathPart>, code: &'static str, message: String| {
            issues.push(Issue { code, path: path.clone(), message });
        };
        match self {
            Schema::Optional(inner) => match input {
                None => None,
                Some(_) => inner.run(input, path, issues),
            },
            Schema::Nullable(inner) => match input {
                Some(Value::Null) => Some(Value::Null),
                _ => inner.run(input, path, issues),
            },
            Schema::Default(inner, value) => match input {
                None => Some(value.clone()),
                Some(_) => inner.run(input, path, issues),
            },
            Schema::Unknown => input.cloned(),
            Schema::Bool => match input {
                Some(Value::Bool(b)) => Some(Value::Bool(*b)),
                _ => {
                    issue(issues, path, "invalid_type", invalid_type("boolean", input));
                    input.cloned()
                }
            },
            Schema::True => {
                if input != Some(&Value::Bool(true)) {
                    issue(issues, path, "invalid_value", "Invalid input: expected true".into());
                }
                input.cloned()
            }
            Schema::Enum(values) => {
                let ok = matches!(input, Some(Value::String(s)) if values.contains(&s.as_str()));
                if !ok {
                    let message = if values.len() == 1 {
                        format!("Invalid input: expected \"{}\"", values[0])
                    } else {
                        let joined = values.iter().map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join("|");
                        format!("Invalid option: expected one of {joined}")
                    };
                    issue(issues, path, "invalid_value", message);
                }
                input.cloned()
            }
            Schema::Str { trim, min, max, pattern } => {
                let Some(Value::String(s)) = input else {
                    issue(issues, path, "invalid_type", invalid_type("string", input));
                    // The length checks run on anything with a `.length` (zod's `when`), the type issue notwithstanding.
                    length_checks(input, *min, *max, path, issues);
                    return input.cloned();
                };
                let value = if *trim { utf16::js_trim(s) } else { s.as_str() };
                let trimmed = Value::String(value.to_string());
                length_checks(Some(&trimmed), *min, *max, path, issues);
                if let Some(p) = pattern
                    && !(p.test)(value)
                {
                    issue(issues, path, "invalid_format", format!("Invalid string: must match pattern /{}/", p.source));
                }
                Some(trimmed)
            }
            Schema::Num { int, checks } => {
                let Some(Value::Number(n)) = input else {
                    issue(issues, path, "invalid_type", invalid_type("number", input));
                    return input.cloned();
                };
                let f = n.as_f64().unwrap_or(f64::NAN);
                if *int {
                    if f.fract() != 0.0 {
                        issue(issues, path, "invalid_type", "Invalid input: expected int, received number".into());
                        return input.cloned();
                    }
                    if f > MAX_SAFE {
                        issue(issues, path, "too_big", format!("Too big: expected int to be <={}", num_text(MAX_SAFE)));
                    } else if f < -MAX_SAFE {
                        issue(issues, path, "too_small", format!("Too small: expected int to be >={}", num_text(-MAX_SAFE)));
                    }
                }
                for check in checks {
                    match *check {
                        NumCheck::Gte(m) if f < m => {
                            issue(issues, path, "too_small", format!("Too small: expected number to be >={}", num_text(m)))
                        }
                        NumCheck::Gt(m) if f <= m => {
                            issue(issues, path, "too_small", format!("Too small: expected number to be >{}", num_text(m)))
                        }
                        NumCheck::Lte(m) if f > m => {
                            issue(issues, path, "too_big", format!("Too big: expected number to be <={}", num_text(m)))
                        }
                        _ => {}
                    }
                }
                input.cloned()
            }
            Schema::Array { item, min, max } => {
                let Some(Value::Array(items)) = input else {
                    issue(issues, path, "invalid_type", invalid_type("array", input));
                    length_checks(input, *min, *max, path, issues);
                    return input.cloned();
                };
                // zod's size cap: an array over its max is refused before its items are looked at.
                if let Some(n) = max
                    && items.len() > *n
                {
                    issue(issues, path, "too_big", format!("Too big: expected array to have <={n} items"));
                    return input.cloned();
                }
                let mut out = Vec::with_capacity(items.len());
                for (i, v) in items.iter().enumerate() {
                    path.push(PathPart::Index(i));
                    out.push(item.run(Some(v), path, issues).unwrap_or(Value::Null));
                    path.pop();
                }
                length_checks(input, *min, None, path, issues);
                Some(Value::Array(out))
            }
            Schema::Object { shape, strict } => {
                let Some(Value::Object(map)) = input else {
                    issue(issues, path, "invalid_type", invalid_type("object", input));
                    return input.cloned();
                };
                let mut out = Map::new();
                for (key, schema) in shape {
                    let value = map.get(*key);
                    path.push(PathPart::Key((*key).to_string()));
                    let result = schema.run(value, path, issues);
                    path.pop();
                    if value.is_none() && schema.optional_out() {
                        continue;
                    }
                    if let Some(v) = result {
                        out.insert((*key).to_string(), v);
                    }
                }
                if *strict {
                    let unknown: Vec<&String> = map.keys().filter(|k| !shape.iter().any(|(s, _)| s == k)).collect();
                    if !unknown.is_empty() {
                        let names = unknown.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ");
                        let s = if unknown.len() > 1 { "s" } else { "" };
                        issue(issues, path, "unrecognized_keys", format!("Unrecognized key{s}: {names}"));
                    }
                }
                Some(Value::Object(out))
            }
        }
    }
}

/// zod's min / max length checks: they run on any value with a `.length` (a string, counted in code points, or an array),
/// with the value's own kind in the message.
fn length_checks(input: Option<&Value>, min: Option<usize>, max: Option<usize>, path: &[PathPart], issues: &mut Vec<Issue>) {
    let (len, origin, unit) = match input {
        Some(Value::String(s)) => (s.chars().count(), "string", "characters"),
        Some(Value::Array(a)) => (a.len(), "array", "items"),
        _ => return,
    };
    if let Some(n) = min
        && len < n
    {
        issues.push(Issue {
            code: "too_small",
            path: path.to_vec(),
            message: format!("Too small: expected {origin} to have >={n} {unit}"),
        });
    }
    if let Some(n) = max
        && len > n
    {
        issues.push(Issue {
            code: "too_big",
            path: path.to_vec(),
            message: format!("Too big: expected {origin} to have <={n} {unit}"),
        });
    }
}

/// Number.MAX_SAFE_INTEGER.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// JavaScript's `String(n)` of a number.
fn num_text(n: f64) -> String {
    match serde_json::Number::from_f64(n) {
        Some(num) => js_json::number_text(&num),
        None => n.to_string(),
    }
}

/// zod's parsedType name of a value.
fn received(input: Option<&Value>) -> &'static str {
    match input {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn invalid_type(expected: &str, input: Option<&Value>) -> String {
    format!("Invalid input: expected {expected}, received {}", received(input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn issues_and_messages_follow_zod_4() {
        let s = object(vec![("a", string()), ("b", int().min(1.0).max(5.0).optional())]);
        let err = s.parse(&json!({ "b": 1.5, "c": 1, "d": 2 })).unwrap_err();
        let messages: Vec<&str> = err.iter().map(|i| i.message.as_str()).collect();
        assert_eq!(
            messages,
            [
                "Invalid input: expected string, received undefined",
                "Invalid input: expected int, received number",
                "Unrecognized keys: \"c\", \"d\""
            ]
        );
        assert_eq!(
            describe(&err),
            "Invalid arguments - a: Invalid input: expected string, received undefined; b: Invalid input: expected int, received number; arguments: Unrecognized keys: \"c\", \"d\""
        );
    }

    #[test]
    fn defaults_fill_in_shape_order_and_absent_optionals_stay_absent() {
        let s = object(vec![
            ("acknowledge", boolean().default(json!(false))),
            ("limit", int().default(json!(50))),
            ("x", string().optional()),
        ]);
        let out = s.parse(&json!({ "limit": 7 })).unwrap();
        assert_eq!(js_json::stringify(&out), r#"{"acknowledge":false,"limit":7}"#);
    }

    #[test]
    fn strings_count_code_points_after_the_trim() {
        let s = string().trim().min(1.0).max(2.0);
        assert!(s.parse(&json!("\u{1F600}")).is_ok());
        assert!(s.parse(&json!("a\u{1F600}")).is_ok());
        assert!(s.parse(&json!("ab\u{1F600}")).is_err());
        assert_eq!(s.parse(&json!("\u{feff} a \u{3000}")).unwrap(), json!("a"));
    }
}
