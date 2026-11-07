//! The fallback of [`super::payload::js_parse`] for the two texts JSON.parse accepts and serde_json refuses: numbers beyond
//! f64 and nesting deeper than 128 levels. An iterative (no recursion, so no stack limit) strict JSON check with the
//! grammar of JSON.parse; a valid text is rewritten with such numbers as `0` and every container below `max_depth` as
//! `null`, which serde_json then reads. An invalid text gives None (JSON.parse throws).

#[derive(Clone, Copy, PartialEq, Eq)]
enum Want {
    Value,
    ValueOrClose,
    KeyOrClose,
    Key,
    Colon,
    CommaOrClose,
    End,
}

fn json_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// The end of the string token starting at `at` (the opening quote), or None when it is not a valid JSON string.
fn string_end(b: &[u8], at: usize) -> Option<usize> {
    let mut i = at + 1;
    loop {
        match *b.get(i)? {
            b'"' => return Some(i + 1),
            b'\\' => match *b.get(i + 1)? {
                b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => i += 2,
                b'u' => {
                    let hex = b.get(i + 2..i + 6)?;
                    if !hex.iter().all(u8::is_ascii_hexdigit) {
                        return None;
                    }
                    i += 6;
                }
                _ => return None,
            },
            c if c < 0x20 => return None,
            _ => i += 1,
        }
    }
}

/// The end of the number token starting at `at`: `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`.
fn number_end(b: &[u8], at: usize) -> Option<usize> {
    let digits = |mut i: usize| {
        let from = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        (i > from).then_some(i)
    };
    let mut i = at;
    if b.get(i) == Some(&b'-') {
        i += 1;
    }
    i = if b.get(i) == Some(&b'0') { i + 1 } else { digits(i)? };
    if b.get(i) == Some(&b'.') {
        i = digits(i + 1)?;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        i = digits(i)?;
    }
    Some(i)
}

/// See the module doc.
pub fn simplified(text: &str, max_depth: usize) -> Option<String> {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len().min(1 << 20));
    let mut stack: Vec<u8> = Vec::new();
    // The stack height at which output stopped (a container below max_depth was replaced by null).
    let mut muted: Option<usize> = None;
    let mut want = Want::Value;
    let mut i = 0;
    loop {
        while i < b.len() && json_space(b[i]) {
            i += 1;
        }
        let Some(&c) = b.get(i) else {
            return (want == Want::End).then_some(out);
        };
        let emit = |out: &mut String, s: &str, muted: Option<usize>| {
            if muted.is_none() {
                out.push_str(s);
            }
        };
        let after_value = |stack: &Vec<u8>| if stack.is_empty() { Want::End } else { Want::CommaOrClose };
        match want {
            Want::End => return None,
            Want::Colon => {
                if c != b':' {
                    return None;
                }
                emit(&mut out, ":", muted);
                i += 1;
                want = Want::Value;
            }
            Want::KeyOrClose | Want::Key => {
                if c == b'}' && want == Want::KeyOrClose {
                    // An empty object.
                    let height = stack.len();
                    stack.pop();
                    if muted == Some(height) {
                        muted = None;
                    } else {
                        emit(&mut out, "}", muted);
                    }
                    i += 1;
                    want = after_value(&stack);
                    continue;
                }
                if c != b'"' {
                    return None;
                }
                let end = string_end(b, i)?;
                emit(&mut out, &text[i..end], muted);
                i = end;
                want = Want::Colon;
            }
            Want::CommaOrClose => {
                let top = *stack.last()?;
                if c == b',' {
                    emit(&mut out, ",", muted);
                    i += 1;
                    want = if top == b'{' { Want::Key } else { Want::Value };
                } else if (c == b'}' && top == b'{') || (c == b']' && top == b'[') {
                    let height = stack.len();
                    stack.pop();
                    if muted == Some(height) {
                        muted = None;
                    } else {
                        emit(&mut out, if c == b'}' { "}" } else { "]" }, muted);
                    }
                    i += 1;
                    want = after_value(&stack);
                } else {
                    return None;
                }
            }
            Want::Value | Want::ValueOrClose => {
                if c == b']' && want == Want::ValueOrClose {
                    let height = stack.len();
                    stack.pop();
                    if muted == Some(height) {
                        muted = None;
                    } else {
                        emit(&mut out, "]", muted);
                    }
                    i += 1;
                    want = after_value(&stack);
                    continue;
                }
                match c {
                    b'{' | b'[' => {
                        stack.push(c);
                        if muted.is_none() && stack.len() > max_depth {
                            out.push_str("null");
                            muted = Some(stack.len());
                        } else {
                            emit(&mut out, if c == b'{' { "{" } else { "[" }, muted);
                        }
                        i += 1;
                        want = if c == b'{' { Want::KeyOrClose } else { Want::ValueOrClose };
                    }
                    b'"' => {
                        let end = string_end(b, i)?;
                        emit(&mut out, &text[i..end], muted);
                        i = end;
                        want = after_value(&stack);
                    }
                    b'-' | b'0'..=b'9' => {
                        let end = number_end(b, i)?;
                        let token = &text[i..end];
                        let finite = token.parse::<f64>().is_ok_and(f64::is_finite);
                        emit(&mut out, if finite { token } else { "0" }, muted);
                        i = end;
                        want = after_value(&stack);
                    }
                    _ => {
                        let literal = ["true", "false", "null"].into_iter().find(|l| b[i..].starts_with(l.as_bytes()))?;
                        emit(&mut out, literal, muted);
                        i += literal.len();
                        want = after_value(&stack);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_what_json_parse_accepts_and_nothing_else() {
        for ok in ["{}", "[]", " 1 ", "-0.5e+3", "\"a\\u00e9\"", "{\"a\":[1,{\"b\":null}],\"c\":true}", "1e400", "[[[]]]"] {
            assert!(simplified(ok, 64).is_some(), "{ok}");
        }
        for bad in ["", "{", "[1,]", "{\"a\":1,}", "01", "1.", ".5", "+1", "\"\t\"", "\"\\x\"", "nul", "[1]x", "{a:1}", "[}"] {
            assert!(simplified(bad, 64).is_none(), "{bad}");
        }
    }

    #[test]
    fn deep_containers_become_null_and_huge_numbers_zero() {
        assert_eq!(simplified(r#"{"a":[[1,[2]],3],"n":-1e400}"#, 2).as_deref(), Some(r#"{"a":[null,3],"n":0}"#));
        let deep = format!("{{\"k\":{}{}}}", "[".repeat(100_000), "]".repeat(100_000));
        assert_eq!(simplified(&deep, 3).as_deref(), Some(r#"{"k":[[null]]}"#));
    }
}
