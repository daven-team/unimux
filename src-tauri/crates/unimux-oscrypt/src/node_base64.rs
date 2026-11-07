//! `Buffer.from(text, 'base64')` of Node (Electron 45.2.2 = Node 24.22.2): how 1.1.x turned a stored `"secret"` string back
//! into the blob it handed to `safeStorage.decryptString`. Node's decoder never fails, so a strict decoder would lock secrets
//! 1.1.4 still reads (no padding, line breaks, the URL-safe alphabet). Measured rules (tests/fixtures/node-base64.json, made
//! by Electron's own Node):
//!
//! - the input is read as UTF-16 code units and only the low byte of each counts (Node's legacy decoder casts to uint8_t):
//!   `ı` (U+0131) reads as `1`, `Ł` (U+0141) as `A`, and the high surrogate of an emoji (U+D83D) as `=`;
//! - both alphabets count (`+/` and `-_`);
//! - every other byte is skipped (whitespace, `!`, `é`, `ą`), except `=`, which ends the input;
//! - a last group of 2 or 3 characters gives 1 or 2 bytes; a single leftover character gives nothing.

/// The 6-bit value of a base64 character of either alphabet.
fn sextet(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Decodes like `Buffer.from(text, 'base64')`.
pub fn decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 2);
    let mut group = [0u8; 4];
    let mut n = 0;
    for unit in text.encode_utf16() {
        let c = unit as u8;
        if c == b'=' {
            break;
        }
        let Some(v) = sextet(c) else { continue };
        group[n] = v;
        n += 1;
        if n == 4 {
            out.push(group[0] << 2 | group[1] >> 4);
            out.push(group[1] << 4 | group[2] >> 2);
            out.push(group[2] << 6 | group[3]);
            n = 0;
        }
    }
    if n >= 2 {
        out.push(group[0] << 2 | group[1] >> 4);
    }
    if n == 3 {
        out.push(group[1] << 4 | group[2] >> 2);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_on_the_measured_cases() {
        let text = include_str!("../tests/fixtures/node-base64.json");
        let fixture: serde_json::Value = serde_json::from_str(text).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 20);
        for case in cases {
            let input = case[0].as_str().unwrap();
            let hex: String = decode(input).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, case[1].as_str().unwrap(), "input {input:?}");
        }
    }

    #[test]
    fn round_trips_standard_base64() {
        use base64::Engine;
        for len in 0..70usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let text = base64::engine::general_purpose::STANDARD.encode(&bytes);
            assert_eq!(decode(&text), bytes);
            assert_eq!(decode(text.trim_end_matches('=')), bytes);
        }
    }
}
