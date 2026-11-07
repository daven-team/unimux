//! Binary frames of the pty data plane (spike SP5, the base of P2): host -> renderer output travels as raw bytes over a
//! `tauri::ipc::Channel`, never as JSON strings. One Channel message carries one or more frames (a per-window batch):
//!
//! `[u8 kind][u16 LE idLen][id: idLen bytes UTF-8][u32 LE payloadLen][payload]`
//!
//! The payload length is what lets several terminals' output share one message (SP5 measured the per-message cost of a
//! Channel; see docs/tauri/spikes/SP5.md). `data` payloads are the pty's bytes as read (UTF-8 is cut anywhere; the
//! renderer keeps a streaming decoder per terminal), `exit` payloads are the exit code as i32 LE. P2 adds `replay` (a
//! terminal's tail with the sizes it was written at: `[u32 LE headerLen][header JSON {"sizes":[{"at","cols","rows"}]},
//! byte offsets][tail bytes]`) and `json` (any other host -> renderer message of the pty port as UTF-8 JSON, id empty), so
//! everything a window gets from the pty host travels in one ordered stream (src/shared/ptyFrames.ts decodes it). `reset`
//! (empty payload) starts a new terminal under an id: the renderer drops that id's UTF-8 decoder state (bytes of a
//! character the killed terminal was cut in the middle of), as node-pty decoded per process in 1.1.4.

pub const KIND_DATA: u8 = 1;
pub const KIND_EXIT: u8 = 2;
pub const KIND_REPLAY: u8 = 3;
pub const KIND_JSON: u8 = 4;
pub const KIND_RESET: u8 = 5;

/// The payload of a `replay` frame.
pub fn replay_payload(data: &[u8], sizes: &[crate::flow::ReplaySize]) -> Vec<u8> {
    let sizes: Vec<serde_json::Value> =
        sizes.iter().map(|s| serde_json::json!({ "at": s.at, "cols": s.cols, "rows": s.rows })).collect();
    let header = serde_json::json!({ "sizes": sizes }).to_string();
    let mut out = Vec::with_capacity(4 + header.len() + data.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(data);
    out
}

/// Appends one frame to `out`.
pub fn encode(out: &mut Vec<u8>, kind: u8, id: &str, payload: &[u8]) {
    let id = id.as_bytes();
    let id_len = u16::try_from(id.len()).expect("terminal id longer than 65535 bytes");
    let payload_len = u32::try_from(payload.len()).expect("frame payload over 4 GiB");
    out.reserve(1 + 2 + id.len() + 4 + payload.len());
    out.push(kind);
    out.extend_from_slice(&id_len.to_le_bytes());
    out.extend_from_slice(id);
    out.extend_from_slice(&payload_len.to_le_bytes());
    out.extend_from_slice(payload);
}

/// One decoded frame.
#[derive(Debug, PartialEq, Eq)]
pub struct Frame<'a> {
    pub kind: u8,
    pub id: &'a str,
    pub payload: &'a [u8],
}

/// Splits a message into its frames; `None` for a malformed message.
pub fn decode(mut buf: &[u8]) -> Option<Vec<Frame<'_>>> {
    let mut frames = Vec::new();
    while !buf.is_empty() {
        if buf.len() < 3 {
            return None;
        }
        let kind = buf[0];
        let id_len = u16::from_le_bytes([buf[1], buf[2]]) as usize;
        buf = &buf[3..];
        if buf.len() < id_len + 4 {
            return None;
        }
        let id = std::str::from_utf8(&buf[..id_len]).ok()?;
        buf = &buf[id_len..];
        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        buf = &buf[4..];
        if buf.len() < len {
            return None;
        }
        frames.push(Frame { kind, id, payload: &buf[..len] });
        buf = &buf[len..];
    }
    Some(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_of_a_batch() {
        let mut out = Vec::new();
        encode(&mut out, KIND_DATA, "cell-1", b"hello \xc4");
        encode(&mut out, KIND_DATA, "zażółć", b"\x85 world");
        encode(&mut out, KIND_EXIT, "cell-1", &3i32.to_le_bytes());
        encode(&mut out, KIND_DATA, "", b"");
        let frames = decode(&out).unwrap();
        assert_eq!(frames.len(), 4);
        assert_eq!(frames[0], Frame { kind: KIND_DATA, id: "cell-1", payload: b"hello \xc4" });
        assert_eq!(frames[1].id, "zażółć");
        assert_eq!(i32::from_le_bytes(frames[2].payload.try_into().unwrap()), 3);
        assert_eq!(frames[3].payload, b"");
    }

    #[test]
    fn replay_payload_layout() {
        let p = replay_payload(b"ab", &[crate::flow::ReplaySize { at: 1, cols: 80, rows: 24 }]);
        let n = u32::from_le_bytes(p[..4].try_into().unwrap()) as usize;
        assert_eq!(&p[4..4 + n], br#"{"sizes":[{"at":1,"cols":80,"rows":24}]}"#);
        assert_eq!(&p[4 + n..], b"ab");
    }

    #[test]
    fn truncated_messages_are_refused() {
        let mut out = Vec::new();
        encode(&mut out, KIND_DATA, "a", b"xyz");
        for cut in 1..out.len() {
            assert!(decode(&out[..cut]).is_none(), "cut at {cut}");
        }
    }
}
