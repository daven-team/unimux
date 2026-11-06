//! The Parquet table preview (1.1.4 `readParquet` over hyparquet 1.32 with hyparquet-compressors): the column names, the
//! type names hyparquet reports (`logical_type.type ?? converted_type ?? type`), the first 1000 rows as display strings
//! (1.1.4 `cellText`: dates as ISO text, 64-bit integers as digits, bytes as `<n B>`, nested values as JSON) and the row
//! count. Values are converted the way hyparquet's `convert()` does for each column (decimals to numbers, any BYTE_ARRAY
//! to text, INT96 and TIMESTAMP to dates, UUID text, FLOAT16, JSON parsed). Golden rows: test/golden/files-parquet.jsonl.

use crate::preview::Preview;

pub const PARQUET_ROWS: usize = 1000;
pub const PARQUET_FAILED: &str = "Nie udało się odczytać pliku Parquet.";

#[cfg(not(feature = "parquet"))]
pub fn read_parquet(_target: &str, _size: u64) -> Preview {
    Preview::error(PARQUET_FAILED)
}

#[cfg(feature = "parquet")]
pub fn read_parquet(target: &str, size: u64) -> Preview {
    // A malformed file can make the reader panic (an index out of range): that is a failed read, never a crash.
    let result = std::panic::catch_unwind(|| imp::read(target, size));
    match result {
        Ok(Ok(table)) => Preview::Table(table),
        _ => Preview::error(PARQUET_FAILED),
    }
}

/// A JavaScript value as hyparquet hands it to `cellText` (only the kinds it can produce).
#[derive(Debug, Clone, PartialEq)]
pub enum Js {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    /// A BigInt, as its decimal digits.
    Big(String),
    Str(String),
    /// A Date by its time value (NaN: Invalid Date).
    Date(f64),
    /// A Uint8Array of this length.
    Bytes(usize),
    Arr(Vec<Js>),
    Obj(Vec<(String, Js)>),
}

/// `String(n)` of a JS number.
pub fn js_number(n: f64) -> String {
    if n == 0.0 {
        return "0".into();
    }
    ryu_js::Buffer::new().format(n).to_string()
}

/// `new Date(t)`: TimeClip (beyond 8.64e15 ms is Invalid Date, else truncated toward zero).
pub fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > 8.64e15 { f64::NAN } else { t.trunc() + 0.0 }
}

/// `Date.prototype.toISOString()` of a valid time value.
pub fn iso_string(t: f64) -> String {
    let ms = t as i64;
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    };
    format!(
        "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// An array index key of a JS object (`"0"`, `"12"`, below 2^32 - 1): those come first, ascending.
fn index_key(key: &str) -> Option<u32> {
    unimux_core::js_json::index_key(key)
}

/// Keys in the order a JS object enumerates them (index keys ascending, then insertion order); a repeated key keeps its
/// first place and takes the last value.
fn js_object(entries: Vec<(String, Js)>) -> Vec<(String, Js)> {
    let mut out: Vec<(String, Js)> = Vec::new();
    for (k, v) in entries {
        match out.iter_mut().find(|(key, _)| *key == k) {
            Some(slot) => slot.1 = v,
            None => out.push((k, v)),
        }
    }
    let (mut index, rest): (Vec<_>, Vec<_>) = out.into_iter().partition(|(k, _)| index_key(k).is_some());
    index.sort_by_key(|(k, _)| index_key(k));
    index.extend(rest);
    index
}

/// `JSON.stringify(value, replacer)` of 1.1.4's cellText (BigInt as its digits, bytes as `<n B>`); None for undefined.
fn stringify(value: &Js, out: &mut String) -> bool {
    match value {
        Js::Undefined => return false,
        Js::Null => out.push_str("null"),
        Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Js::Num(n) => out.push_str(&if n.is_finite() { js_number(*n) } else { "null".into() }),
        Js::Big(digits) => unimux_core::js_json::write_string(out, digits),
        Js::Str(s) => unimux_core::js_json::write_string(out, s),
        Js::Date(t) => {
            if t.is_nan() {
                out.push_str("null");
            } else {
                unimux_core::js_json::write_string(out, &iso_string(*t));
            }
        }
        Js::Bytes(n) => unimux_core::js_json::write_string(out, &format!("<{n} B>")),
        Js::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !stringify(item, out) {
                    out.push_str("null");
                }
            }
            out.push(']');
        }
        Js::Obj(entries) => {
            out.push('{');
            let mut first = true;
            for (k, v) in entries {
                let mut item = String::new();
                if !stringify(v, &mut item) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                unimux_core::js_json::write_string(out, k);
                out.push(':');
                out.push_str(&item);
            }
            out.push('}');
        }
    }
    true
}

/// 1.1.4 `cellText(value)`.
pub fn cell_text(value: &Js) -> Option<String> {
    match value {
        Js::Undefined | Js::Null => None,
        Js::Date(t) => Some(if t.is_nan() { "Invalid Date".into() } else { iso_string(*t) }),
        Js::Big(digits) => Some(digits.clone()),
        Js::Bytes(n) => Some(format!("<{n} B>")),
        Js::Arr(_) | Js::Obj(_) => {
            let mut out = String::new();
            stringify(value, &mut out);
            Some(out)
        }
        Js::Num(n) => Some(js_number(*n)),
        Js::Bool(b) => Some(b.to_string()),
        Js::Str(s) => Some(s.clone()),
    }
}

/// A parsed JSON value (hyparquet `jsonFromBytes`) as a JS value.
pub fn js_of_json(v: &serde_json::Value) -> Js {
    use serde_json::Value;
    match v {
        Value::Null => Js::Null,
        Value::Bool(b) => Js::Bool(*b),
        Value::Number(n) => Js::Num(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => Js::Str(s.clone()),
        Value::Array(items) => Js::Arr(items.iter().map(js_of_json).collect()),
        Value::Object(map) => Js::Obj(js_object(map.iter().map(|(k, v)| (k.clone(), js_of_json(v))).collect())),
    }
}

#[cfg(feature = "parquet")]
mod imp {
    use std::collections::HashMap;
    use std::fs::File;

    use parquet::basic::{ConvertedType, LogicalType, Repetition, TimeUnit, Type as Physical};
    use parquet::column::reader::get_typed_column_reader;
    use parquet::data_type::{Int96, Int96Type};
    use parquet::file::reader::{FileReader, SerializedFileReader};
    use parquet::record::{Field, List, Map, Row};
    use parquet::schema::types::{Type, TypePtr};
    use serde_json::{Value, json};

    use super::{Js, PARQUET_ROWS, cell_text, js_object, js_of_json, time_clip};

    pub fn read(target: &str, size: u64) -> Result<Value, String> {
        let file = File::open(target).map_err(|e| e.to_string())?;
        let reader = SerializedFileReader::new(file).map_err(|e| e.to_string())?;
        let meta = reader.metadata().file_metadata();
        let total_rows = meta.num_rows();
        let root = meta.schema_descr().root_schema_ptr();
        let fields = root.get_fields().to_vec();
        // hyparquet refuses these outright ("parquet bson / interval not supported").
        for leaf in meta.schema_descr().columns() {
            if matches!(leaf.converted_type(), ConvertedType::BSON | ConvertedType::INTERVAL) {
                return Err("unsupported type".into());
            }
        }
        let columns: Vec<String> = fields.iter().map(|f| f.name().to_string()).collect();
        let types: Vec<String> = fields.iter().map(|f| type_name(f)).collect();
        let int96 = flat_int96(&reader, &fields)?;
        let mut rows = Vec::new();
        if total_rows > 0 {
            for (r, row) in reader.get_row_iter(None).map_err(|e| e.to_string())?.take(PARQUET_ROWS).enumerate() {
                let row = row.map_err(|e| e.to_string())?;
                let cells: Vec<Value> = row
                    .get_column_iter()
                    .zip(fields.iter())
                    .enumerate()
                    .map(|(c, ((_, field), ty))| {
                        let value = match int96.get(&c) {
                            Some(raw) => raw.get(r).copied().flatten().map_or(Js::Undefined, int96_date),
                            None => convert(field, ty)?,
                        };
                        Ok(cell_text(&value).map_or(Value::Null, Value::String))
                    })
                    .collect::<Result<_, String>>()?;
                rows.push(Value::Array(cells));
            }
        }
        Ok(
            json!({ "kind": "table", "format": "parquet", "columns": columns, "types": types, "rows": rows, "totalRows": total_rows, "size": size }),
        )
    }

    /// The raw values of the top-level INT96 columns (first PARQUET_ROWS rows, None for null), by field index. The record
    /// reader hands INT96 over as `Int96::to_millis` (the nanoseconds of the day floored), while hyparquet truncates the
    /// whole nanosecond count toward zero: a pre-1970 value with a sub-millisecond part would be 1 ms off. INT96 nested in
    /// a list or struct keeps the record reader's value.
    fn flat_int96(reader: &SerializedFileReader<File>, fields: &[TypePtr]) -> Result<HashMap<usize, Vec<Option<Int96>>>, String> {
        let schema = reader.metadata().file_metadata().schema_descr();
        let mut out = HashMap::new();
        for (c, field) in fields.iter().enumerate() {
            if !field.is_primitive()
                || field.get_physical_type() != Physical::INT96
                || field.get_basic_info().repetition() == Repetition::REPEATED
            {
                continue;
            }
            let Some(leaf) = (0..schema.num_columns()).find(|&i| {
                let path = schema.column(i).path().parts().to_vec();
                path.len() == 1 && path[0] == field.name()
            }) else {
                continue;
            };
            let mut values: Vec<Option<Int96>> = Vec::new();
            for g in 0..reader.num_row_groups() {
                if values.len() >= PARQUET_ROWS {
                    break;
                }
                let group = reader.get_row_group(g).map_err(|e| e.to_string())?;
                let mut column = get_typed_column_reader::<Int96Type>(group.get_column_reader(leaf).map_err(|e| e.to_string())?);
                let want = PARQUET_ROWS - values.len();
                let (mut defs, mut vals) = (Vec::new(), Vec::new());
                let optional = schema.column(leaf).max_def_level() > 0;
                let (records, _, _) =
                    column.read_records(want, optional.then_some(&mut defs), None, &mut vals).map_err(|e| e.to_string())?;
                let mut next = vals.into_iter();
                if optional {
                    values.extend(defs.iter().take(records).map(|d| if *d > 0 { next.next() } else { None }));
                } else {
                    values.extend(next.take(records).map(Some));
                }
            }
            out.insert(c, values);
        }
        Ok(out)
    }

    /// hyparquet `timestampFromNanoseconds(parseInt96Nanos(v))`: the 96 bits as `BigInt(high) << 64n | low` (low signed),
    /// days since the Julian epoch of 1970, then `new Date(Number(nanos / 1000000n))`.
    fn int96_date(v: Int96) -> Js {
        let d = v.data();
        let low = ((d[1] as u64) << 32 | d[0] as u64) as i64;
        let high = d[2] as i32;
        let value: i128 = ((high as i128) << 64) | (low as i128);
        let days = (value >> 64) - 2_440_588;
        let nanos = value & 0xffff_ffff_ffff_ffff;
        let ms = (days * 86_400_000_000_000 + nanos) / 1_000_000;
        Js::Date(time_clip(ms as f64))
    }

    /// `String(element.logical_type?.type ?? element.converted_type ?? element.type ?? '')`.
    fn type_name(ty: &Type) -> String {
        let info = ty.get_basic_info();
        if let Some(logical) = info.logical_type_ref() {
            return logical_name(logical).to_string();
        }
        if info.converted_type() != ConvertedType::NONE {
            return info.converted_type().to_string();
        }
        if ty.is_primitive() { ty.get_physical_type().to_string() } else { String::new() }
    }

    fn logical_name(l: &LogicalType) -> &'static str {
        match l {
            LogicalType::String => "STRING",
            LogicalType::Map => "MAP",
            LogicalType::List => "LIST",
            LogicalType::Enum => "ENUM",
            LogicalType::Decimal(_) => "DECIMAL",
            LogicalType::Date => "DATE",
            LogicalType::Time(_) => "TIME",
            LogicalType::Timestamp(_) => "TIMESTAMP",
            LogicalType::Integer(_) => "INTEGER",
            LogicalType::Unknown => "NULL",
            LogicalType::Json => "JSON",
            LogicalType::Bson => "BSON",
            LogicalType::Uuid => "UUID",
            LogicalType::Float16 => "FLOAT16",
            LogicalType::Variant(_) => "VARIANT",
            LogicalType::Geometry(_) => "GEOMETRY",
            LogicalType::Geography(_) => "GEOGRAPHY",
            _ => "undefined",
        }
    }

    fn is_list_like(ty: &Type) -> bool {
        if ty.is_primitive() || ty.get_basic_info().converted_type() != ConvertedType::LIST {
            return false;
        }
        let children = ty.get_fields();
        children.len() == 1
            && (children[0].is_primitive() || children[0].get_fields().len() <= 1)
            && children[0].get_basic_info().repetition() == parquet::basic::Repetition::REPEATED
    }

    fn is_map_like(ty: &Type) -> bool {
        if ty.is_primitive() || !matches!(ty.get_basic_info().converted_type(), ConvertedType::MAP | ConvertedType::MAP_KEY_VALUE)
        {
            return false;
        }
        let children = ty.get_fields();
        children.len() == 1 && !children[0].is_primitive() && children[0].get_fields().len() == 2
    }

    /// The element type of a LIST group (3-level `list.element`, or the 2-level legacy repeated child).
    fn list_element(ty: &Type) -> &Type {
        let repeated = &ty.get_fields()[0];
        if !repeated.is_primitive() && repeated.get_fields().len() == 1 { &repeated.get_fields()[0] } else { repeated }
    }

    pub(super) fn convert(field: &Field, ty: &Type) -> Result<Js, String> {
        Ok(match field {
            Field::Null => Js::Undefined,
            Field::ListInternal(list) => convert_list(list, ty)?,
            Field::MapInternal(map) => convert_map(map, ty)?,
            Field::Group(row) => convert_group(row, ty)?,
            primitive => convert_primitive(primitive, ty)?,
        })
    }

    fn convert_list(list: &List, ty: &Type) -> Result<Js, String> {
        let element = if is_list_like(ty) { list_element(ty) } else { ty };
        let mut elements = list.elements();
        // A legacy 2-level list (`repeated int32 item` right under the LIST group) comes from the record reader wrapped in
        // one more list; hyparquet gives the plain array.
        if is_list_like(ty)
            && ty.get_fields()[0].is_primitive()
            && let [Field::ListInternal(inner)] = elements
        {
            elements = inner.elements();
        }
        Ok(Js::Arr(elements.iter().map(|f| convert(f, element)).collect::<Result<_, _>>()?))
    }

    fn convert_map(map: &Map, ty: &Type) -> Result<Js, String> {
        let (key_ty, value_ty) = if is_map_like(ty) {
            let kv = ty.get_fields()[0].get_fields();
            (kv[0].clone(), kv[1].clone())
        } else {
            return Err("map without key and value".into());
        };
        let mut entries = Vec::new();
        for (k, v) in map.entries() {
            let key = js_key(&convert(k, &key_ty)?);
            let value = match convert(v, &value_ty)? {
                Js::Undefined => Js::Null,
                other => other,
            };
            entries.push((key, value));
        }
        Ok(Js::Obj(js_object(entries)))
    }

    /// A map key as a JS object key (`String(key)`).
    fn js_key(key: &Js) -> String {
        match key {
            Js::Undefined => "undefined".into(),
            Js::Null => "null".into(),
            Js::Date(t) if t.is_nan() => "Invalid Date".into(),
            other => cell_text(other).unwrap_or_default(),
        }
    }

    fn convert_group(row: &Row, ty: &Type) -> Result<Js, String> {
        if ty.is_primitive() {
            return Err("group for a primitive".into());
        }
        let entries = row
            .get_column_iter()
            .zip(ty.get_fields())
            // hyparquet: a missing value of a present struct is null for a primitive field, absent for a nested one.
            .map(|((name, f), child)| match f {
                Field::Null if child.is_primitive() => Ok((name.clone(), Js::Null)),
                f => convert(f, child).map(|v| (name.clone(), v)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Js::Obj(entries))
    }

    fn big_of_bytes(bytes: &[u8]) -> f64 {
        // parseDecimal: big-endian two's complement, then Number(bigint) (round to nearest).
        if bytes.is_empty() {
            return 0.0;
        }
        if bytes.len() <= 16 {
            let mut v: i128 = if bytes[0] & 0x80 != 0 { -1 } else { 0 };
            for b in bytes {
                v = (v << 8) | *b as i128;
            }
            return v as f64;
        }
        let negative = bytes[0] & 0x80 != 0;
        let mut v = 0f64;
        for b in bytes {
            v = v * 256.0 + if negative { (!*b) as f64 } else { *b as f64 };
        }
        if negative { -(v + 1.0) } else { v }
    }

    fn uuid_text(bytes: &[u8]) -> String {
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let part = |a: usize, b: usize| hex.get(a..b.min(hex.len())).unwrap_or("").to_string();
        format!("{}-{}-{}-{}-{}", part(0, 8), part(8, 12), part(12, 16), part(16, 20), part(20, 32))
    }

    fn float16(bits: u16) -> f64 {
        let sign = if bits >> 15 != 0 { -1.0 } else { 1.0 };
        let exp = (bits >> 10) & 0x1f;
        let frac = (bits & 0x3ff) as f64;
        if exp == 0 {
            return sign * 2f64.powi(-14) * (frac / 1024.0);
        }
        if exp == 0x1f {
            return if frac != 0.0 { f64::NAN } else { sign * f64::INFINITY };
        }
        sign * 2f64.powi(exp as i32 - 15) * (1.0 + frac / 1024.0)
    }

    /// The raw integer of a numeric field (the record reader already typed it by the converted type).
    fn integer(field: &Field) -> Option<i128> {
        Some(match field {
            Field::Byte(v) => *v as i128,
            Field::Short(v) => *v as i128,
            Field::Int(v) => *v as i128,
            Field::Long(v) => *v as i128,
            Field::UByte(v) => *v as i128,
            Field::UShort(v) => *v as i128,
            Field::UInt(v) => *v as i128,
            Field::ULong(v) => *v as i128,
            Field::Date(v) => *v as i128,
            Field::TimeMillis(v) => *v as i128,
            Field::TimeMicros(v) => *v as i128,
            Field::TimestampMillis(v) => *v as i128,
            Field::TimestampMicros(v) => *v as i128,
            _ => return None,
        })
    }

    fn date_of_ms(ms: i128) -> Js {
        Js::Date(time_clip(ms as f64))
    }

    /// hyparquet `convert()` for one value of a primitive column.
    fn convert_primitive(field: &Field, ty: &Type) -> Result<Js, String> {
        let physical = ty.get_physical_type();
        let info = ty.get_basic_info();
        let ctype = info.converted_type();
        let ltype = info.logical_type_ref();
        let scale = match ty {
            Type::PrimitiveType { scale, .. } => *scale,
            _ => 0,
        };
        // DECIMAL first (hyparquet checks the converted type).
        if ctype == ConvertedType::DECIMAL {
            let factor = 10f64.powi(scale.max(0));
            let unscaled = match field {
                Field::Decimal(d) => match d {
                    parquet::data_type::Decimal::Bytes { value, .. } => {
                        let n = big_of_bytes(value.data());
                        return Ok(Js::Num(if scale > 308 { n * 10f64.powi(-scale) } else { n / factor }));
                    }
                    other => big_of_bytes(other.data()),
                },
                other => integer(other).ok_or("decimal value")? as f64,
            };
            return Ok(Js::Num(unscaled / factor));
        }
        if physical == Physical::INT96 && ctype == ConvertedType::NONE {
            // The record reader gives the INT96 timestamp in milliseconds already.
            return Ok(date_of_ms(integer(field).ok_or("int96 value")?));
        }
        match ctype {
            ConvertedType::DATE => return Ok(date_of_ms(integer(field).ok_or("date value")? * 86_400_000)),
            ConvertedType::TIMESTAMP_MILLIS => return Ok(date_of_ms(integer(field).ok_or("timestamp value")?)),
            ConvertedType::TIMESTAMP_MICROS => return Ok(date_of_ms(integer(field).ok_or("timestamp value")? / 1000)),
            ConvertedType::JSON => {
                let text = bytes_text(field)?;
                let value = unimux_core::js_json::parse(&text).map_err(|e| e.to_string())?;
                return Ok(js_of_json(&value));
            }
            _ => {}
        }
        if let Some(LogicalType::Uuid) = ltype {
            return Ok(Js::Str(uuid_text(&raw_bytes(field)?)));
        }
        if ctype == ConvertedType::UTF8 || matches!(ltype, Some(LogicalType::String)) || physical == Physical::BYTE_ARRAY {
            return Ok(Js::Str(bytes_text(field)?));
        }
        if let Some(LogicalType::Float16) = ltype {
            let b = raw_bytes(field).or_else(|_| match field {
                Field::Float16(f) => Ok(f.to_le_bytes().to_vec()),
                _ => Err("float16 value".to_string()),
            })?;
            return Ok(Js::Num(float16(u16::from_le_bytes([b[0], b[1]]))));
        }
        if let Some(LogicalType::Timestamp(ts)) = ltype {
            let v = integer(field).ok_or("timestamp value")?;
            return Ok(date_of_ms(match ts.unit {
                TimeUnit::MILLIS => v,
                TimeUnit::MICROS => v / 1000,
                TimeUnit::NANOS => v / 1_000_000,
            }));
        }
        let unsigned64 = ctype == ConvertedType::UINT_64
            || matches!(ltype, Some(LogicalType::Integer(t)) if t.bit_width == 64 && !t.is_signed);
        let unsigned32 = ctype == ConvertedType::UINT_32
            || matches!(ltype, Some(LogicalType::Integer(t)) if t.bit_width == 32 && !t.is_signed);
        Ok(match field {
            Field::Bool(b) => Js::Bool(*b),
            Field::Float(f) => Js::Num(*f as f64),
            Field::Double(f) => Js::Num(*f),
            Field::Float16(f) => Js::Num(f.to_f64()),
            Field::Bytes(b) => Js::Bytes(b.len()),
            Field::Str(s) => Js::Str(s.clone()),
            other => {
                let v = integer(other).ok_or("value")?;
                match physical {
                    // INT64 columns are BigInt in hyparquet (UINT_64: BigUint64).
                    Physical::INT64 if unsigned64 => Js::Big((v as i64 as u64).to_string()),
                    Physical::INT64 => Js::Big((v as i64).to_string()),
                    Physical::INT32 if unsigned32 => Js::Num((v as i32 as u32) as f64),
                    // UINT_8 / UINT_16 stay the raw signed INT32 in hyparquet.
                    Physical::INT32 => Js::Num((v as i32) as f64),
                    _ => Js::Num(v as f64),
                }
            }
        })
    }

    fn raw_bytes(field: &Field) -> Result<Vec<u8>, String> {
        match field {
            Field::Bytes(b) => Ok(b.data().to_vec()),
            Field::Str(s) => Ok(s.as_bytes().to_vec()),
            _ => Err("bytes value".into()),
        }
    }

    /// `new TextDecoder().decode(bytes)` (replacement characters for malformed UTF-8).
    fn bytes_text(field: &Field) -> Result<String, String> {
        Ok(String::from_utf8_lossy(&raw_bytes(field)?).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_formatting() {
        assert_eq!(js_number(0.1f32 as f64), "0.10000000149011612");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(f64::NAN), "NaN");
        assert_eq!(iso_string(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(-1.0), "1969-12-31T23:59:59.999Z");
        assert_eq!(iso_string(8.64e15), "+275760-09-13T00:00:00.000Z");
        assert_eq!(iso_string(-62198755200000.0), "-000001-01-01T00:00:00.000Z");
        assert!(time_clip(8.64e15 + 1.0).is_nan());
        let v = Js::Obj(vec![
            ("b".into(), Js::Big("12".into())),
            ("a".into(), Js::Undefined),
            ("c".into(), Js::Arr(vec![Js::Undefined, Js::Bytes(3), Js::Date(0.0)])),
        ]);
        assert_eq!(cell_text(&v).unwrap(), r#"{"b":"12","c":[null,"<3 B>","1970-01-01T00:00:00.000Z"]}"#);
    }
}
