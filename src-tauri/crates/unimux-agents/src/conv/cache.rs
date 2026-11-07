//! `conversation-index-v2.bin`: the index between runs (1.2.0). 1.1.4 wrote `conversation-index.bin` with `v8.serialize`,
//! which Rust cannot read; that file is left alone (an Electron 1.1.x run after a downgrade still finds it) and the first
//! 1.2.0 pass reads every transcript once.
//!
//! Layout (little endian): the magic `UNIMUXCI`, a u32 format version, a u32 entry count, then per entry the file record and
//! its document. Strings are a u32 byte length + UTF-8; UTF-16 texts (they may hold a lone surrogate) a u32 unit count, a u8
//! width and the units: width 1 when every unit is below 256 (one byte each, like V8's one-byte strings; most folded texts),
//! else width 2 (u16 each); `Option` a u8 flag. A short, foreign or broken file decodes to None (a full first pass, as in 1.1.4).

use std::sync::Arc;

use super::ConvCli;
use super::indexer::{DocState, Entry};
use super::parse::ConvMeta;
use super::search::ConvDoc;

const MAGIC: &[u8; 8] = b"UNIMUXCI";
pub const VERSION: u32 = 3;

struct W(Vec<u8>);

impl W {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn len(&mut self, n: usize) {
        self.u32(u32::try_from(n).unwrap_or(u32::MAX));
    }
    fn str(&mut self, s: &str) {
        self.len(s.len());
        self.0.extend_from_slice(s.as_bytes());
    }
    fn opt(&mut self, s: &Option<String>) {
        match s {
            Some(s) => {
                self.u8(1);
                self.str(s);
            }
            None => self.u8(0),
        }
    }
    fn units(&mut self, u: &[u16]) {
        self.len(u.len());
        if u.iter().all(|&x| x < 256) {
            self.u8(1);
            self.0.extend(u.iter().map(|&x| x as u8));
        } else {
            self.u8(2);
            self.0.reserve(u.len() * 2);
            for x in u {
                self.0.extend_from_slice(&x.to_le_bytes());
            }
        }
    }
}

struct R<'a> {
    b: &'a [u8],
    i: usize,
}

impl R<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.b.get(self.i..self.i.checked_add(n)?)?;
        self.i += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn f64(&mut self) -> Option<f64> {
        Some(f64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn len(&mut self) -> Option<usize> {
        Some(self.u32()? as usize)
    }
    fn str(&mut self) -> Option<String> {
        let n = self.len()?;
        String::from_utf8(self.take(n)?.to_vec()).ok()
    }
    fn opt(&mut self) -> Option<Option<String>> {
        match self.u8()? {
            0 => Some(None),
            1 => Some(Some(self.str()?)),
            _ => None,
        }
    }
    fn units(&mut self) -> Option<Vec<u16>> {
        let n = self.len()?;
        match self.u8()? {
            1 => Some(self.take(n)?.iter().map(|&b| u16::from(b)).collect()),
            2 => Some(self.take(n.checked_mul(2)?)?.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect()),
            _ => None,
        }
    }
    fn bool(&mut self) -> Option<bool> {
        match self.u8()? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }
}

pub fn encode<'a>(entries: impl ExactSizeIterator<Item = &'a Entry>) -> Vec<u8> {
    let mut w = W(Vec::new());
    w.0.extend_from_slice(MAGIC);
    w.u32(VERSION);
    w.len(entries.len());
    for e in entries {
        w.str(&e.file);
        w.u8(if e.cli == ConvCli::Codex { 1 } else { 0 });
        w.u64(e.size);
        w.f64(e.mtime_ms);
        w.f64(e.birthtime_ms);
        w.u64(e.ino);
        w.u64(e.offset);
        let s = &*e.doc;
        let m = &s.meta;
        w.opt(&m.id);
        w.str(&m.cwd);
        w.f64(m.first_ts);
        w.f64(m.last_ts);
        w.opt(&m.model);
        w.opt(&m.custom);
        w.opt(&m.ai);
        w.opt(&m.prompt);
        w.u64(s.len as u64);
        w.u8(u8::from(s.visible));
        let d = &s.doc;
        w.str(&d.id);
        w.str(&d.cwd);
        w.str(&d.title);
        w.f64(d.started_at);
        w.f64(d.updated_at);
        w.opt(&d.model);
        w.units(&d.text);
        w.units(&d.folded);
        w.len(d.starts.len());
        for s in &d.starts {
            w.u32(*s);
        }
        w.len(d.roles.len());
        w.0.extend_from_slice(&d.roles);
        w.len(d.times.len());
        for t in &d.times {
            w.f64(*t);
        }
        w.u8(u8::from(d.capped));
    }
    w.0
}

pub fn decode(bytes: &[u8]) -> Option<Vec<Entry>> {
    let mut r = R { b: bytes, i: 0 };
    if r.take(8)? != MAGIC || r.u32()? != VERSION {
        return None;
    }
    let count = r.len()?;
    let mut out = Vec::with_capacity(count.min(1 << 16));
    for _ in 0..count {
        let file = r.str()?;
        let cli = if r.u8()? == 1 { ConvCli::Codex } else { ConvCli::Claude };
        let (size, mtime_ms, birthtime_ms, ino, offset) = (r.u64()?, r.f64()?, r.f64()?, r.u64()?, r.u64()?);
        let meta = ConvMeta {
            id: r.opt()?,
            cwd: r.str()?,
            first_ts: r.f64()?,
            last_ts: r.f64()?,
            model: r.opt()?,
            custom: r.opt()?,
            ai: r.opt()?,
            prompt: r.opt()?,
        };
        let len = r.u64()? as usize;
        let visible = r.bool()?;
        let mut doc = ConvDoc {
            cli,
            id: r.str()?,
            cwd: r.str()?,
            title: r.str()?,
            started_at: r.f64()?,
            updated_at: r.f64()?,
            model: r.opt()?,
            file: file.clone(),
            text: r.units()?,
            folded: r.units()?,
            ..Default::default()
        };
        let n = r.len()?;
        doc.starts = (0..n).map(|_| r.u32()).collect::<Option<_>>()?;
        let n = r.len()?;
        doc.roles = r.take(n)?.to_vec();
        let n = r.len()?;
        doc.times = (0..n).map(|_| r.f64()).collect::<Option<_>>()?;
        doc.capped = r.bool()?;
        if doc.folded.len() != doc.text.len() || doc.roles.len() != doc.starts.len() || doc.times.len() != doc.starts.len() {
            return None;
        }
        out.push(Entry {
            file,
            cli,
            size,
            mtime_ms,
            birthtime_ms,
            ino,
            offset,
            doc: Arc::new(DocState { doc, meta, len, visible }),
        });
    }
    if r.i != bytes.len() {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_refuses_broken_files() {
        let mut doc = DocState::empty(ConvCli::Codex, "f.jsonl");
        doc.doc.text = vec![0x61, 0xd83d, 0, 0x62];
        // Both widths: the text holds a unit over 255, the folded text does not.
        doc.doc.folded = vec![0x61, 0xff, 0, 0x62];
        doc.doc.starts = vec![0, 3];
        doc.doc.roles = b"ua".to_vec();
        doc.doc.times = vec![1.5, 0.0];
        doc.meta.prompt = Some("p".into());
        doc.visible = true;
        let e = Entry {
            file: "f.jsonl".into(),
            cli: ConvCli::Codex,
            size: 9,
            mtime_ms: 1.25,
            birthtime_ms: 0.5,
            ino: 7,
            offset: 9,
            doc: Arc::new(doc),
        };
        let bytes = encode([e.clone()].iter());
        assert_eq!(decode(&bytes), Some(vec![e]));
        assert_eq!(decode(&bytes[..bytes.len() - 1]), None);
        assert_eq!(decode(b"garbage"), None);
        assert_eq!(decode(&[]), None);
        // An unknown width is a broken file.
        let mut bad = bytes.clone();
        let at = bytes.windows(5).position(|w| w == [4, 0, 0, 0, 2]).unwrap() + 4;
        bad[at] = 3;
        assert_eq!(decode(&bad), None);
    }
}
