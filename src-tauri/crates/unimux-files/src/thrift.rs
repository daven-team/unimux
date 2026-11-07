//! A small Thrift compact protocol reader and writer for the Parquet footer (FileMetaData). The parquet crate fills a
//! column's converted type in from its logical type when the file has none, while hyparquet (1.1.4) only looks at the
//! converted type the file really has; [`raw_converted_types`] reads that from the footer. The writer is for the golden
//! fixtures (examples/parquet_fixtures.rs writes a file whose columns carry a logical type only).

/// A Thrift value as the compact protocol carries it.
#[derive(Debug, Clone, PartialEq)]
pub enum TValue {
    Bool(bool),
    Byte(i8),
    I16(i16),
    I32(i32),
    I64(i64),
    Double(f64),
    Binary(Vec<u8>),
    /// A list or set: the element type and the elements.
    List(u8, Vec<TValue>),
    Set(u8, Vec<TValue>),
    /// Key type, value type, entries.
    Map(u8, u8, Vec<(TValue, TValue)>),
    /// Fields by id, in the order they came.
    Struct(Vec<(i16, TValue)>),
}

const T_TRUE: u8 = 1;
const T_FALSE: u8 = 2;
const T_BYTE: u8 = 3;
const T_I16: u8 = 4;
const T_I32: u8 = 5;
const T_I64: u8 = 6;
const T_DOUBLE: u8 = 7;
const T_BINARY: u8 = 8;
const T_LIST: u8 = 9;
const T_SET: u8 = 10;
const T_MAP: u8 = 11;
const T_STRUCT: u8 = 12;

/// Nesting deeper than this is refused (a damaged footer must not overflow the stack).
const MAX_DEPTH: usize = 64;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> Option<u8> {
        let b = *self.bytes.get(self.at)?;
        self.at += 1;
        Some(b)
    }
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let end = self.at.checked_add(n)?;
        let out = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(out)
    }
    fn varint(&mut self) -> Option<u64> {
        let mut out = 0u64;
        for shift in (0..70).step_by(7) {
            let b = self.byte()?;
            if shift < 64 {
                out |= ((b & 0x7f) as u64) << shift;
            }
            if b & 0x80 == 0 {
                return Some(out);
            }
        }
        None
    }
    fn zigzag(&mut self) -> Option<i64> {
        let v = self.varint()?;
        Some((v >> 1) as i64 ^ -((v & 1) as i64))
    }

    fn value(&mut self, ty: u8, depth: usize) -> Option<TValue> {
        if depth > MAX_DEPTH {
            return None;
        }
        Some(match ty {
            T_TRUE => TValue::Bool(true),
            T_FALSE => TValue::Bool(false),
            T_BYTE => TValue::Byte(self.byte()? as i8),
            T_I16 => TValue::I16(self.zigzag()? as i16),
            T_I32 => TValue::I32(self.zigzag()? as i32),
            T_I64 => TValue::I64(self.zigzag()?),
            T_DOUBLE => TValue::Double(f64::from_le_bytes(self.take(8)?.try_into().ok()?)),
            T_BINARY => {
                let n = self.varint()? as usize;
                TValue::Binary(self.take(n)?.to_vec())
            }
            T_LIST | T_SET => {
                let head = self.byte()?;
                let elem = head & 0x0f;
                let n = if head >> 4 == 0x0f { self.varint()? as usize } else { (head >> 4) as usize };
                // Every element takes at least one byte (a boolean of a list too).
                if n > self.bytes.len() - self.at {
                    return None;
                }
                let mut items = Vec::with_capacity(n);
                for _ in 0..n {
                    items.push(if elem == T_TRUE || elem == T_FALSE {
                        TValue::Bool(self.byte()? == T_TRUE)
                    } else {
                        self.value(elem, depth + 1)?
                    });
                }
                if ty == T_LIST { TValue::List(elem, items) } else { TValue::Set(elem, items) }
            }
            T_MAP => {
                let n = self.varint()? as usize;
                if n == 0 {
                    return Some(TValue::Map(0, 0, Vec::new()));
                }
                if n > self.bytes.len() - self.at {
                    return None;
                }
                let kinds = self.byte()?;
                let (k, v) = (kinds >> 4, kinds & 0x0f);
                let mut entries = Vec::with_capacity(n);
                for _ in 0..n {
                    entries.push((self.value(k, depth + 1)?, self.value(v, depth + 1)?));
                }
                TValue::Map(k, v, entries)
            }
            T_STRUCT => {
                let mut fields = Vec::new();
                let mut last: i16 = 0;
                loop {
                    let head = self.byte()?;
                    if head == 0 {
                        break;
                    }
                    let kind = head & 0x0f;
                    let id = match head >> 4 {
                        0 => self.zigzag()? as i16,
                        delta => last.checked_add(delta as i16)?,
                    };
                    last = id;
                    fields.push((id, self.value(kind, depth + 1)?));
                }
                TValue::Struct(fields)
            }
            _ => return None,
        })
    }
}

/// Reads one struct from `bytes` (None when it is not a well-formed compact struct).
pub fn read_struct(bytes: &[u8]) -> Option<TValue> {
    Reader { bytes, at: 0 }.value(T_STRUCT, 0)
}

fn type_of(v: &TValue) -> u8 {
    match v {
        TValue::Bool(true) => T_TRUE,
        TValue::Bool(false) => T_FALSE,
        TValue::Byte(_) => T_BYTE,
        TValue::I16(_) => T_I16,
        TValue::I32(_) => T_I32,
        TValue::I64(_) => T_I64,
        TValue::Double(_) => T_DOUBLE,
        TValue::Binary(_) => T_BINARY,
        TValue::List(..) => T_LIST,
        TValue::Set(..) => T_SET,
        TValue::Map(..) => T_MAP,
        TValue::Struct(_) => T_STRUCT,
    }
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn put_zigzag(out: &mut Vec<u8>, v: i64) {
    put_varint(out, ((v << 1) ^ (v >> 63)) as u64);
}

fn write_value(out: &mut Vec<u8>, v: &TValue) {
    match v {
        TValue::Bool(_) => {} // carried in the field header (or written as an element by write_items)
        TValue::Byte(b) => out.push(*b as u8),
        TValue::I16(n) => put_zigzag(out, *n as i64),
        TValue::I32(n) => put_zigzag(out, *n as i64),
        TValue::I64(n) => put_zigzag(out, *n),
        TValue::Double(d) => out.extend_from_slice(&d.to_le_bytes()),
        TValue::Binary(b) => {
            put_varint(out, b.len() as u64);
            out.extend_from_slice(b);
        }
        TValue::List(elem, items) | TValue::Set(elem, items) => {
            if items.len() < 15 {
                out.push(((items.len() as u8) << 4) | elem);
            } else {
                out.push(0xf0 | elem);
                put_varint(out, items.len() as u64);
            }
            for item in items {
                match item {
                    TValue::Bool(b) => out.push(if *b { T_TRUE } else { T_FALSE }),
                    other => write_value(out, other),
                }
            }
        }
        TValue::Map(k, val, entries) => {
            put_varint(out, entries.len() as u64);
            if !entries.is_empty() {
                out.push((k << 4) | val);
            }
            for (a, b) in entries {
                write_value(out, a);
                write_value(out, b);
            }
        }
        TValue::Struct(fields) => {
            let mut last: i16 = 0;
            for (id, value) in fields {
                let kind = type_of(value);
                let delta = id.wrapping_sub(last);
                if delta > 0 && delta <= 15 {
                    out.push(((delta as u8) << 4) | kind);
                } else {
                    out.push(kind);
                    put_zigzag(out, *id as i64);
                }
                last = *id;
                write_value(out, value);
            }
            out.push(0);
        }
    }
}

/// The compact encoding of a struct.
pub fn write_struct(v: &TValue) -> Vec<u8> {
    let mut out = Vec::new();
    write_value(&mut out, v);
    out
}

/// The footer of a Parquet file: the FileMetaData bytes (between the data and the closing length + `PAR1`).
pub fn footer(file: &[u8]) -> Option<&[u8]> {
    let n = file.len();
    if n < 12 || &file[n - 4..] != b"PAR1" {
        return None;
    }
    let len = u32::from_le_bytes(file[n - 8..n - 4].try_into().ok()?) as usize;
    file.get(n.checked_sub(8 + len)?..n - 8)
}

/// The `converted_type` (SchemaElement field 6) of every schema element of a FileMetaData, in the footer's order (the
/// depth-first order of the schema tree, the root first); None for an element without one.
pub fn raw_converted_types(meta: &[u8]) -> Option<Vec<Option<i32>>> {
    let TValue::Struct(fields) = read_struct(meta)? else { return None };
    let (_, TValue::List(_, elements)) = fields.iter().find(|(id, _)| *id == 2)? else { return None };
    elements
        .iter()
        .map(|e| match e {
            TValue::Struct(f) => Some(f.iter().find_map(|(id, v)| match (id, v) {
                (6, TValue::I32(n)) => Some(*n),
                _ => None,
            })),
            _ => None,
        })
        .collect()
}

/// `meta` with the converted type of the schema elements named in `names` taken out (the fixture of a writer that writes
/// logical types only).
pub fn drop_converted_types(meta: &[u8], names: &[&str]) -> Option<Vec<u8>> {
    let TValue::Struct(mut fields) = read_struct(meta)? else { return None };
    let (_, TValue::List(_, elements)) = fields.iter_mut().find(|(id, _)| *id == 2)? else { return None };
    for e in elements.iter_mut() {
        if let TValue::Struct(f) = e {
            let named =
                f.iter().any(|(id, v)| *id == 4 && matches!(v, TValue::Binary(b) if names.iter().any(|n| n.as_bytes() == b)));
            if named {
                f.retain(|(id, _)| *id != 6);
            }
        }
    }
    Some(write_struct(&TValue::Struct(fields)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let v = TValue::Struct(vec![
            (1, TValue::I32(-2)),
            (2, TValue::List(T_STRUCT, vec![TValue::Struct(vec![(4, TValue::Binary(b"m".to_vec())), (6, TValue::I32(6))])])),
            (3, TValue::I64(1 << 40)),
            (5, TValue::List(T_TRUE, vec![TValue::Bool(true), TValue::Bool(false)])),
            (7, TValue::Bool(true)),
            (40, TValue::Map(T_BINARY, T_I16, vec![(TValue::Binary(vec![1]), TValue::I16(-7))])),
            (41, TValue::List(T_I32, (0..20).map(TValue::I32).collect())),
            (42, TValue::Double(0.5)),
        ]);
        let bytes = write_struct(&v);
        assert_eq!(read_struct(&bytes), Some(v));
        assert_eq!(raw_converted_types(&bytes), Some(vec![Some(6)]));
        let dropped = drop_converted_types(&bytes, &["m"]).unwrap();
        assert_eq!(raw_converted_types(&dropped), Some(vec![None]));
        assert_eq!(read_struct(&bytes[..bytes.len() - 3]), None);
        assert_eq!(footer(b"PAR1"), None);
    }
}
