//! The few JavaScript value semantics the tool layer needs (truthiness, `String(v)`, `||`, `===`, `.length`), over
//! `serde_json::Value` with `None` for `undefined`.

use serde_json::{Map, Value};

pub use unimux_state::normalize::js::truthy;

/// `String(v)` of a present value.
pub fn to_string(v: &Value) -> String {
    unimux_state::normalize::js::to_string(Some(v))
}

/// `String(v)` (`undefined` for None).
pub fn to_string_opt(v: Option<&Value>) -> String {
    unimux_state::normalize::js::to_string(v)
}

/// `a === b` for the primitives the tool layer compares (strings, numbers, booleans, null, undefined).
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    unimux_state::normalize::js::strict_eq(a, b)
}

/// `v === 'text'`
pub fn is_str(v: Option<&Value>, text: &str) -> bool {
    matches!(v, Some(Value::String(s)) if s == text)
}

/// `a || b`: the first truthy operand, else the last.
pub fn or(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    if truthy(a) { a.cloned() } else { b.cloned() }
}

/// `v || undefined`
pub fn or_undefined(v: Option<&Value>) -> Option<Value> {
    if truthy(v) { v.cloned() } else { None }
}

/// `v.length` of an array (0 for anything else, where 1.1.4 would have thrown).
pub fn array_len(v: Option<&Value>) -> usize {
    v.and_then(Value::as_array).map_or(0, Vec::len)
}

/// A JS number as a JSON value (whole numbers as integers).
pub fn num(f: f64) -> Value {
    unimux_state::normalize::js::num(f)
}

/// The keys of a plain object, `{}` for anything else.
pub fn object(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `o.key` (None for a missing key or a non-object).
pub fn get<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v.and_then(|v| v.as_object()).and_then(|m| m.get(key))
}

/// Builds an object literal: `None` values are left out (JSON.stringify drops `undefined`).
#[derive(Default)]
pub struct Obj(pub Map<String, Value>);

impl Obj {
    pub fn new() -> Self {
        Self(Map::new())
    }
    /// `{...v}`: the own keys of an object (nothing for anything else).
    pub fn spread(v: Option<&Value>) -> Self {
        Self(object(v))
    }
    /// `key: value` (an existing key keeps its place, as a later key of an object literal does).
    pub fn set(mut self, key: &str, value: Option<Value>) -> Self {
        match value {
            Some(v) => {
                self.0.insert(key.to_string(), v);
            }
            None => {
                // `key: undefined` over a spread value: JSON.stringify drops it.
                self.0.shift_remove(key);
            }
        }
        self
    }
    pub fn put(self, key: &str, value: Value) -> Self {
        self.set(key, Some(value))
    }
    /// `const { key, ...rest } = o` (rest without these keys).
    pub fn without(mut self, keys: &[&str]) -> Self {
        for k in keys {
            self.0.shift_remove(*k);
        }
        self
    }
    /// mcpTools.ts compact: drops `undefined`, `null` and empty arrays.
    pub fn compact(mut self) -> Self {
        self.0.retain(|_, v| !(v.is_null() || v.as_array().is_some_and(Vec::is_empty)));
        self
    }
    pub fn value(self) -> Value {
        Value::Object(self.0)
    }
}
