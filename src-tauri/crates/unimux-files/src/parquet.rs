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
    // A malformed file can make the reader panic (an index out of range, a negative column chunk offset): that is a
    // failed read, never a crash, so the app's panic hook stays quiet (no crash.log entry, no error dialog).
    let result = unimux_core::panic_guard::catch_expected(|| imp::read(target, size));
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
    /// A Uint8Array.
    Bytes(Vec<u8>),
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
        Js::Bytes(b) => unimux_core::js_json::write_string(out, &format!("<{} B>", b.len())),
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
        Js::Bytes(b) => Some(format!("<{} B>", b.len())),
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

/// `String(value)`: how a map key becomes an object key (hyparquet assembleMaps `obj[key] = ...`). A Date key stays its ISO
/// text: V8's `Date.prototype.toString` is local time with ICU's localized zone name ("Thu Jan 01 1970 01:00:00 GMT+0100
/// (czas środkowoeuropejski standardowy)"), an accepted deviation (PROGRESS.md, G5 open issues).
pub fn js_string(value: &Js) -> String {
    match value {
        Js::Undefined => "undefined".into(),
        Js::Null => "null".into(),
        Js::Bool(b) => b.to_string(),
        Js::Num(n) => js_number(*n),
        Js::Big(digits) => digits.clone(),
        Js::Str(s) => s.clone(),
        Js::Date(t) => {
            if t.is_nan() {
                "Invalid Date".into()
            } else {
                iso_string(*t)
            }
        }
        Js::Bytes(b) => b.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","),
        Js::Arr(items) => items
            .iter()
            .map(|v| match v {
                Js::Undefined | Js::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Js::Obj(_) => "[object Object]".into(),
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

/// `new TextDecoder().decode(bytes)` (one call per value, as hyparquet's stringFromBytes / jsonFromBytes): malformed UTF-8
/// becomes U+FFFD and one leading UTF-8 BOM is dropped.
pub fn utf8_decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)).into_owned()
}

/// hyparquet `wkbToGeojson` (src/wkb.js) of a GEOMETRY / GEOGRAPHY value: ISO WKB (either byte order, Z / M / ZM by the
/// thousands of the type) as a GeoJSON object. Reading past the end is an error (DataView's RangeError), like an
/// unsupported geometry type: the whole preview fails, as in 1.1.4.
pub fn wkb_to_geojson(bytes: &[u8]) -> Result<Js, String> {
    struct Flags {
        little: bool,
        kind: u32,
        dim: u32,
        count: u32,
    }
    struct Reader<'a> {
        b: &'a [u8],
        at: usize,
    }
    impl Reader<'_> {
        fn take<const N: usize>(&mut self) -> Result<[u8; N], String> {
            let out = self.b.get(self.at..self.at + N).ok_or("Offset is outside the bounds of the DataView")?;
            self.at += N;
            Ok(out.try_into().unwrap())
        }
        fn u32(&mut self, little: bool) -> Result<u32, String> {
            let b = self.take::<4>()?;
            Ok(if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
        }
        fn flags(&mut self) -> Result<Flags, String> {
            let little = self.take::<1>()?[0] == 1;
            let raw = self.u32(little)?;
            let (kind, flags) = (raw % 1000, raw / 1000);
            let count = if kind > 1 && kind <= 7 { self.u32(little)? } else { 0 };
            let dim = 2 + u32::from(flags != 0) + u32::from(flags == 3);
            Ok(Flags { little, kind, dim, count })
        }
        fn position(&mut self, f: &Flags) -> Result<Js, String> {
            let mut out = Vec::new();
            for _ in 0..f.dim {
                let b = self.take::<8>()?;
                out.push(Js::Num(if f.little { f64::from_le_bytes(b) } else { f64::from_be_bytes(b) }));
            }
            Ok(Js::Arr(out))
        }
        fn line(&mut self, f: &Flags, count: u32) -> Result<Js, String> {
            // Every position takes 16 bytes or more: a count beyond the data fails at the end of it.
            (0..count).map(|_| self.position(f)).collect::<Result<_, _>>().map(Js::Arr)
        }
        fn polygon(&mut self, f: &Flags) -> Result<Js, String> {
            let mut rings = Vec::new();
            for _ in 0..f.count {
                let n = self.u32(f.little)?;
                rings.push(self.line(f, n)?);
            }
            Ok(Js::Arr(rings))
        }
        fn geometry(&mut self, depth: usize) -> Result<Js, String> {
            if depth > 64 {
                return Err("Maximum call stack size exceeded".into());
            }
            let f = self.flags()?;
            let shape = |name: &str, coordinates: Js| {
                Js::Obj(vec![("type".into(), Js::Str(name.into())), ("coordinates".into(), coordinates)])
            };
            Ok(match f.kind {
                1 => shape("Point", self.position(&f)?),
                2 => shape("LineString", self.line(&f, f.count)?),
                3 => shape("Polygon", self.polygon(&f)?),
                4..=6 => {
                    let mut items = Vec::new();
                    for _ in 0..f.count {
                        let inner = self.flags()?;
                        items.push(match f.kind {
                            4 => self.position(&inner)?,
                            5 => self.line(&inner, inner.count)?,
                            _ => self.polygon(&inner)?,
                        });
                    }
                    let name = ["MultiPoint", "MultiLineString", "MultiPolygon"][f.kind as usize - 4];
                    shape(name, Js::Arr(items))
                }
                7 => {
                    let geometries = (0..f.count).map(|_| self.geometry(depth + 1)).collect::<Result<_, _>>()?;
                    Js::Obj(vec![
                        ("type".into(), Js::Str("GeometryCollection".into())),
                        ("geometries".into(), Js::Arr(geometries)),
                    ])
                }
                other => return Err(format!("Unsupported geometry type: {other}")),
            })
        }
    }
    Reader { b: bytes, at: 0 }.geometry(0)
}

#[cfg(feature = "parquet")]
mod imp {
    use std::collections::{HashMap, HashSet};
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};
    use std::sync::Arc;

    use parquet::basic::{ConvertedType, LogicalType, Repetition, TimeUnit, Type as Physical};
    use parquet::column::reader::get_typed_column_reader;
    use parquet::data_type::{Int96, Int96Type};
    use parquet::file::metadata::KeyValue;
    use parquet::file::reader::{FileReader, SerializedFileReader};
    use parquet::record::{Field, List, Map, Row};
    use parquet::schema::types::{Type, TypePtr};
    use serde_json::{Value, json};

    use super::{Js, PARQUET_ROWS, cell_text, js_object, js_of_json, js_string, time_clip, wkb_to_geojson};

    /// The schema types whose element in the file has no converted type. The parquet crate fills one in from the logical
    /// type (`DATE`, `DECIMAL`, `JSON` ...), but hyparquet converts by the converted type the file really has, so a column
    /// written with a logical type only stays its raw value there (a day number, an unscaled integer, the JSON text).
    /// Also the GeoParquet columns (hyparquet `markGeoColumns`): a BYTE_ARRAY leaf without a logical type that the file's
    /// `geo` metadata lists with WKB encoding reads as GEOMETRY (GEOGRAPHY for spherical edges), the value true here.
    struct Raw {
        no_ctype: HashSet<*const Type>,
        geo: HashMap<*const Type, bool>,
    }

    impl Raw {
        fn read(target: &str, root: &TypePtr, key_values: Option<&Vec<KeyValue>>) -> Result<Raw, String> {
            let mut no_ctype = HashSet::new();
            let mut order = Vec::new();
            depth_first(root, &mut order);
            if let Some(raw) = footer_converted_types(target)
                && order.len() == raw.len()
            {
                no_ctype.extend(order.iter().zip(raw).filter(|(_, c)| c.is_none()).map(|(t, _)| Arc::as_ptr(t)));
            }
            let geo = mark_geo_columns(&order, key_values)?;
            Ok(Raw { no_ctype, geo })
        }

        /// hyparquet's `element.converted_type` (NONE when the file has none).
        fn ctype(&self, ty: &Type) -> ConvertedType {
            if self.no_ctype.contains(&(ty as *const Type)) { ConvertedType::NONE } else { ty.get_basic_info().converted_type() }
        }

        /// The geometry logical type hyparquet sees: the file's own, or the GeoParquet mark (true: GEOGRAPHY).
        fn geo(&self, ty: &Type) -> Option<bool> {
            match ty.get_basic_info().logical_type_ref() {
                Some(LogicalType::Geometry(_)) => Some(false),
                Some(LogicalType::Geography(_)) => Some(true),
                _ => self.geo.get(&(ty as *const Type)).copied(),
            }
        }
    }

    /// `value[key]` for a JSON value as JS reads it (undefined: None); a string or an array by index.
    fn js_prop<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
        match value {
            Value::Object(map) => map.get(key),
            Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i)),
            _ => None,
        }
    }

    /// JS truthiness of a JSON value.
    fn truthy(value: Option<&Value>) -> bool {
        match value {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
            Some(Value::String(s)) => !s.is_empty(),
            Some(_) => true,
        }
    }

    /// `value?.[key]` (undefined and null both stop).
    fn opt_prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
        match value {
            None | Some(Value::Null) => None,
            Some(v) => js_prop(v, key),
        }
    }

    /// hyparquet `markGeoColumns` (src/geoparquet.js) over the schema elements in the footer's order (`order`, root
    /// first). What throws there (a `geo` value that is not JSON, a column entry that is null, a CRS id without a code)
    /// fails the whole read here too.
    fn mark_geo_columns(order: &[TypePtr], key_values: Option<&Vec<KeyValue>>) -> Result<HashMap<*const Type, bool>, String> {
        let mut marks = HashMap::new();
        let geo = key_values.and_then(|kv| kv.iter().find(|k| k.key == "geo")).and_then(|k| k.value.as_deref());
        let Some(geo) = geo.filter(|g| !g.is_empty()) else { return Ok(marks) };
        let parsed = unimux_core::js_json::parse(geo).map_err(|e| e.to_string())?;
        let mut columns: HashMap<String, bool> = HashMap::new();
        let entries: Vec<(String, &Value)> = match opt_prop(Some(&parsed), "columns") {
            Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
            Some(Value::Array(items)) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
            // Object.entries of a string: one entry per UTF-16 unit, none of which has an encoding.
            _ => Vec::new(),
        };
        for (name, column) in entries {
            if column.is_null() {
                return Err("Cannot read properties of null (reading 'encoding')".into());
            }
            if js_prop(column, "encoding") != Some(&Value::String("WKB".into())) {
                continue;
            }
            let spherical = js_prop(column, "edges") == Some(&Value::String("spherical".into()));
            let crs = js_prop(column, "crs");
            let id = match opt_prop(crs, "id") {
                None | Some(Value::Null) => opt_prop(opt_prop(crs, "ids"), "0"),
                some => some,
            };
            if truthy(id) && matches!(opt_prop(id, "code"), None | Some(Value::Null)) {
                return Err("Cannot read properties of undefined (reading 'toString')".into());
            }
            columns.insert(name, spherical);
        }
        // Root-level BYTE_ARRAY leaves without a logical type; a group skips its direct children count only.
        let mut i = 1;
        while i < order.len() {
            let ty = &order[i];
            let children = if ty.is_primitive() { 0 } else { ty.get_fields().len() };
            if children > 0 {
                i += children + 1;
                continue;
            }
            if ty.is_primitive()
                && ty.get_physical_type() == Physical::BYTE_ARRAY
                && ty.get_basic_info().logical_type_ref().is_none()
                && let Some(spherical) = columns.get(ty.name())
            {
                marks.insert(Arc::as_ptr(ty), *spherical);
            }
            i += 1;
        }
        Ok(marks)
    }

    fn depth_first(ty: &TypePtr, out: &mut Vec<TypePtr>) {
        out.push(ty.clone());
        if !ty.is_primitive() {
            for f in ty.get_fields() {
                depth_first(f, out);
            }
        }
    }

    /// The converted types of the footer's schema elements (thrift.rs), in their depth-first order.
    fn footer_converted_types(target: &str) -> Option<Vec<Option<i32>>> {
        let mut file = File::open(target).ok()?;
        let size = file.seek(SeekFrom::End(0)).ok()?;
        if size < 12 {
            return None;
        }
        let mut tail = [0u8; 8];
        file.seek(SeekFrom::End(-8)).ok()?;
        file.read_exact(&mut tail).ok()?;
        let len = u32::from_le_bytes(tail[..4].try_into().ok()?) as u64;
        if &tail[4..] != b"PAR1" || len + 8 > size {
            return None;
        }
        let mut meta = vec![0u8; len as usize];
        file.seek(SeekFrom::End(-8 - len as i64)).ok()?;
        file.read_exact(&mut meta).ok()?;
        crate::thrift::raw_converted_types(&meta)
    }

    pub fn read(target: &str, size: u64) -> Result<Value, String> {
        let file = File::open(target).map_err(|e| e.to_string())?;
        let reader = SerializedFileReader::new(file).map_err(|e| e.to_string())?;
        let meta = reader.metadata().file_metadata();
        let total_rows = meta.num_rows();
        let root = meta.schema_descr().root_schema_ptr();
        let raw = Raw::read(target, &root, meta.key_value_metadata())?;
        let fields = root.get_fields().to_vec();
        // hyparquet refuses these outright ("parquet bson / interval not supported").
        for leaf in meta.schema_descr().columns() {
            if matches!(raw.ctype(leaf.self_type()), ConvertedType::BSON | ConvertedType::INTERVAL) {
                return Err("unsupported type".into());
            }
        }
        let columns: Vec<String> = fields.iter().map(|f| f.name().to_string()).collect();
        let types: Vec<String> = fields.iter().map(|f| type_name(&raw, f)).collect();
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
                            None => convert(&raw, field, ty)?,
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
    fn type_name(raw: &Raw, ty: &Type) -> String {
        let info = ty.get_basic_info();
        if let Some(logical) = info.logical_type_ref() {
            return logical_name(logical).to_string();
        }
        if let Some(spherical) = raw.geo(ty) {
            return if spherical { "GEOGRAPHY" } else { "GEOMETRY" }.into();
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

    fn convert(raw: &Raw, field: &Field, ty: &Type) -> Result<Js, String> {
        Ok(match field {
            Field::Null => Js::Undefined,
            Field::ListInternal(list) => convert_list(raw, list, ty)?,
            Field::MapInternal(map) => convert_map(raw, map, ty)?,
            Field::Group(row) => convert_group(raw, row, ty)?,
            primitive => convert_primitive(raw, primitive, ty)?,
        })
    }

    fn convert_list(raw: &Raw, list: &List, ty: &Type) -> Result<Js, String> {
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
        Ok(Js::Arr(elements.iter().map(|f| convert(raw, f, element)).collect::<Result<_, _>>()?))
    }

    fn convert_map(raw: &Raw, map: &Map, ty: &Type) -> Result<Js, String> {
        let (key_ty, value_ty) = if is_map_like(ty) {
            let kv = ty.get_fields()[0].get_fields();
            (kv[0].clone(), kv[1].clone())
        } else {
            return Err("map without key and value".into());
        };
        let mut entries = Vec::new();
        for (k, v) in map.entries() {
            let key = js_string(&convert(raw, k, &key_ty)?);
            let value = match convert(raw, v, &value_ty)? {
                Js::Undefined => Js::Null,
                other => other,
            };
            entries.push((key, value));
        }
        Ok(Js::Obj(js_object(entries)))
    }

    fn convert_group(raw: &Raw, row: &Row, ty: &Type) -> Result<Js, String> {
        if ty.is_primitive() {
            return Err("group for a primitive".into());
        }
        let entries = row
            .get_column_iter()
            .zip(ty.get_fields())
            // hyparquet: a missing value of a present struct is null for a primitive field, absent for a nested one.
            .map(|((name, f), child)| match f {
                Field::Null if child.is_primitive() => Ok((name.clone(), Js::Null)),
                f => convert(raw, f, child).map(|v| (name.clone(), v)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        // `obj[key] = ...` (hyparquet invertStruct): index keys first, ascending, like a map or a JSON object.
        Ok(Js::Obj(js_object(entries)))
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
    fn convert_primitive(raw: &Raw, field: &Field, ty: &Type) -> Result<Js, String> {
        let physical = ty.get_physical_type();
        let info = ty.get_basic_info();
        let ctype = raw.ctype(ty);
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
        if raw.geo(ty).is_some() {
            return wkb_to_geojson(&raw_bytes(field)?);
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
            Field::Bytes(b) => Js::Bytes(b.data().to_vec()),
            Field::Str(s) => Js::Str(s.clone()),
            // A decimal the file annotates with a logical type only (the parquet crate typed it as one): hyparquet keeps
            // the raw INT32 / INT64 (BigInt) / fixed bytes.
            Field::Decimal(parquet::data_type::Decimal::Int32 { value, .. }) => Js::Num(i32::from_be_bytes(*value) as f64),
            Field::Decimal(parquet::data_type::Decimal::Int64 { value, .. }) => Js::Big(i64::from_be_bytes(*value).to_string()),
            Field::Decimal(parquet::data_type::Decimal::Bytes { value, .. }) => Js::Bytes(value.data().to_vec()),
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
            Field::Decimal(parquet::data_type::Decimal::Bytes { value, .. }) => Ok(value.data().to_vec()),
            _ => Err("bytes value".into()),
        }
    }

    /// `new TextDecoder().decode(bytes)`: replacement characters for malformed UTF-8, and one leading BOM dropped (the
    /// decoder's ignoreBOM is false and every value is a separate decode call).
    fn bytes_text(field: &Field) -> Result<String, String> {
        Ok(super::utf8_decode(&raw_bytes(field)?))
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
            ("c".into(), Js::Arr(vec![Js::Undefined, Js::Bytes(vec![1, 2, 3]), Js::Date(0.0)])),
        ]);
        assert_eq!(cell_text(&v).unwrap(), r#"{"b":"12","c":[null,"<3 B>","1970-01-01T00:00:00.000Z"]}"#);
        assert_eq!(js_string(&Js::Bytes(vec![1, 2, 3])), "1,2,3");
        assert_eq!(js_string(&Js::Bytes(vec![])), "");
        assert_eq!(js_string(&Js::Arr(vec![Js::Num(1.0), Js::Null, Js::Arr(vec![Js::Str("a".into())])])), "1,,a");
        assert_eq!(js_string(&Js::Obj(vec![])), "[object Object]");
        assert_eq!(js_string(&Js::Num(-0.0)), "0");
        assert_eq!(js_string(&Js::Date(f64::NAN)), "Invalid Date");
    }
}
