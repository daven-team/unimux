//! Streaming UTF-8 decoding of pty output, like the string node-pty hands to `onData` (a StringDecoder): a sequence split
//! across two reads is held back until it is complete, invalid bytes become U+FFFD.

#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

/// How many bytes at the end of `b` start a sequence that is not complete yet (0 to 3).
fn incomplete_tail(b: &[u8]) -> usize {
    for back in 1..=b.len().min(3) {
        let byte = b[b.len() - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let need = match byte {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => 1,
        };
        return if need > back { back } else { 0 };
    }
    0
}

impl Utf8Stream {
    pub fn push(&mut self, data: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(data);
        let keep = incomplete_tail(&buf);
        self.pending = buf.split_off(buf.len() - keep);
        match String::from_utf8(buf) {
            Ok(s) => s,
            Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
        }
    }

    /// The rest at the end of the stream (an incomplete sequence becomes U+FFFD).
    pub fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&rest).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_sequences_are_joined() {
        let text = "zażółć 日本 🎉 end";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut s = Utf8Stream::default();
            let mut got = s.push(&bytes[..cut]);
            got += &s.push(&bytes[cut..]);
            got += &s.finish();
            assert_eq!(got, text, "cut at {cut}");
        }
        // one byte at a time
        let mut s = Utf8Stream::default();
        let got: String = bytes.iter().map(|b| s.push(&[*b])).collect();
        assert_eq!(got, text);
    }

    #[test]
    fn invalid_bytes_become_replacement() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(b"a\xFFb"), "a\u{FFFD}b");
        assert_eq!(s.push(b"x\xE2\x82"), "x");
        assert_eq!(s.finish(), "\u{FFFD}");
    }
}
