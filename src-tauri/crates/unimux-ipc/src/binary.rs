//! Binary results on the raw IPC path (ARCHITECTURE section 3, "binary payloads"). Tauri hands a raw response to JS as one
//! ArrayBuffer, so a result that holds bytes inside an object (`sound:load` answers `{ data: Uint8Array | null, ... }`) is
//! framed: the JSON value with `{"$mcBytes": <index>}` where each byte part goes, then the parts themselves, no base64.
//!
//! Frame: `MCB1`, the header length (u32 little endian), the header `{"value": <json>, "parts": [<len>, ...]}` (UTF-8 JSON),
//! then every part one after the other. A plain `Reply::Bytes(b)` is the frame whose value is `{"$mcBytes": 0}`, so the
//! bridge decodes every raw answer the same way (src/renderer/src/bridge/transport.ts `decodeBinaryReply`).

use serde_json::{Value, json};

pub const MAGIC: &[u8; 4] = b"MCB1";
/// The placeholder key of a byte part inside the value.
pub const PART_KEY: &str = "$mcBytes";

/// The placeholder for part `index` (put it where the Uint8Array goes).
pub fn part(index: usize) -> Value {
    json!({ PART_KEY: index })
}

/// Frames `value` (with placeholders) and its byte parts.
pub fn encode(value: &Value, parts: &[Vec<u8>]) -> Vec<u8> {
    let header = json!({ "value": value, "parts": parts.iter().map(Vec::len).collect::<Vec<_>>() }).to_string();
    let total: usize = parts.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(8 + header.len() + total);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    for p in parts {
        out.extend_from_slice(p);
    }
    out
}

/// The reverse of [`encode`] (tests and Rust-side consumers): the value with placeholders and the parts.
pub fn decode(frame: &[u8]) -> Option<(Value, Vec<Vec<u8>>)> {
    if frame.get(..4)? != MAGIC {
        return None;
    }
    let len = u32::from_le_bytes(frame.get(4..8)?.try_into().ok()?) as usize;
    let header: Value = serde_json::from_slice(frame.get(8..8 + len)?).ok()?;
    let mut at = 8 + len;
    let mut parts = Vec::new();
    for n in header["parts"].as_array()? {
        let n = n.as_u64()? as usize;
        parts.push(frame.get(at..at + n)?.to_vec());
        at += n;
    }
    (at == frame.len()).then(|| (header["value"].clone(), parts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_nested_parts() {
        let value = json!({ "data": part(0), "name": "done.wav", "more": [part(1), null] });
        let parts = vec![vec![1u8, 2, 3], vec![]];
        let frame = encode(&value, &parts);
        assert_eq!(&frame[..4], MAGIC);
        assert_eq!(decode(&frame), Some((value, parts)));
    }

    #[test]
    fn plain_bytes_are_a_frame_with_one_part() {
        let frame = encode(&part(0), &[vec![9, 8]]);
        assert_eq!(decode(&frame), Some((json!({ "$mcBytes": 0 }), vec![vec![9, 8]])));
        assert_eq!(decode(b"MCB1"), None);
        assert_eq!(decode(b"nope"), None);
    }
}
