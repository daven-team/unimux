//! The request body as hooks.ts reads it: `req.setEncoding('utf8')` (a streaming decoder: a character split between two
//! chunks is joined, an invalid sequence becomes U+FFFD, an incomplete one at the end too) and limits counted in UTF-16 code
//! units (`string.length`). Nothing is kept that the event does not need.

/// Node's StringDecoder for UTF-8: bytes in, text out, a split sequence carried to the next chunk.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    /// Decodes a chunk; an incomplete sequence at its end waits for the next one.
    pub fn push(&mut self, chunk: &[u8], out: &mut String) {
        let joined;
        let mut bytes: &[u8] = if self.pending.is_empty() {
            chunk
        } else {
            joined = [std::mem::take(&mut self.pending).as_slice(), chunk].concat();
            &joined
        };
        loop {
            match std::str::from_utf8(bytes) {
                Ok(s) => {
                    out.push_str(s);
                    return;
                }
                Err(e) => {
                    let good = e.valid_up_to();
                    // SAFETY-free: the prefix up to valid_up_to is valid UTF-8.
                    out.push_str(std::str::from_utf8(&bytes[..good]).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            bytes = &bytes[good + n..];
                        }
                        None => {
                            self.pending = bytes[good..].to_vec();
                            return;
                        }
                    }
                }
            }
        }
    }

    /// The end of the body: an incomplete sequence left over is one U+FFFD (`decoder.end()`).
    pub fn finish(&mut self, out: &mut String) {
        if !self.pending.is_empty() {
            self.pending.clear();
            out.push('\u{fffd}');
        }
    }
}

/// Head and tail of a tool hook payload: the first `head_max` UTF-16 units and the last `tail_max` of the rest.
pub struct HeadTail {
    head_max: usize,
    tail_max: usize,
    pub head: Vec<u16>,
    pub tail: Vec<u16>,
}

impl HeadTail {
    pub fn new(head_max: usize, tail_max: usize) -> Self {
        Self { head_max, tail_max, head: Vec::new(), tail: Vec::new() }
    }

    pub fn push(&mut self, text: &str) {
        for u in text.encode_utf16() {
            if self.head.len() < self.head_max {
                self.head.push(u);
            } else {
                self.tail.push(u);
            }
        }
        if self.tail.len() > self.tail_max * 2 {
            let cut = self.tail.len() - self.tail_max;
            self.tail.drain(..cut);
        }
    }

    pub fn finish(&mut self) {
        if self.tail.len() > self.tail_max {
            let cut = self.tail.len() - self.tail_max;
            self.tail.drain(..cut);
        }
    }
}

/// A body kept whole up to `max` UTF-16 units; one byte more and it is "oversized" (and nothing more is kept).
pub struct Capped {
    max: usize,
    units: usize,
    pub text: String,
    pub oversized: bool,
}

impl Capped {
    pub fn new(max: usize) -> Self {
        Self { max, units: 0, text: String::new(), oversized: false }
    }

    pub fn push(&mut self, text: &str) {
        if self.oversized {
            return;
        }
        self.units += super::payload::utf16_len(text);
        if self.units > self.max {
            self.oversized = true;
            self.text = String::new();
            return;
        }
        self.text.push_str(text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_a_character_split_between_chunks_and_replaces_bad_bytes() {
        let mut d = Utf8Stream::default();
        let mut out = String::new();
        let bytes = "aą😀".as_bytes();
        for b in bytes {
            d.push(std::slice::from_ref(b), &mut out);
        }
        d.push(&[0xff, b'x', 0xf0, 0x9f], &mut out);
        d.finish(&mut out);
        assert_eq!(out, "aą😀\u{fffd}x\u{fffd}");
    }

    #[test]
    fn head_and_tail_count_utf16_units_and_may_cut_a_pair() {
        let mut h = HeadTail::new(3, 2);
        h.push("ab😀cdefg");
        h.finish();
        assert_eq!(String::from_utf16_lossy(&h.head), "ab\u{fffd}");
        assert_eq!(String::from_utf16_lossy(&h.tail), "fg");
        let mut c = Capped::new(3);
        c.push("ab");
        c.push("😀");
        assert!(c.oversized);
    }
}
