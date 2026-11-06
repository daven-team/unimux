//! Binary frames of the pty data plane (spike SP5, the base of P2): host -> renderer output travels as raw bytes over a
//! `tauri::ipc::Channel`, never as JSON strings. One Channel message carries one or more frames (a per-window batch):
//!
//! `[u8 kind][u16 LE idLen][id: idLen bytes UTF-8][u32 LE payloadLen][payload]`
//!
//! The payload length is what lets several terminals' output share one message (SP5 measured the per-message cost of a
//! Channel; see docs/tauri/spikes/SP5.md). `data` payloads are the pty's bytes as read (UTF-8 is cut anywhere; xterm's
//! `write(Uint8Array)` keeps the decoder state per terminal), `exit` payloads are the exit code as i32 LE.

pub const KIND_DATA: u8 = 1;
pub const KIND_EXIT: u8 = 2;

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
    fn truncated_messages_are_refused() {
        let mut out = Vec::new();
        encode(&mut out, KIND_DATA, "a", b"xyz");
        for cut in 1..out.len() {
            assert!(decode(&out[..cut]).is_none(), "cut at {cut}");
        }
    }
}
