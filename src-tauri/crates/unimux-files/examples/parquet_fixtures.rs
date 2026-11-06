//! Writes the Parquet files of the golden corpus (test/golden/parquet/*.parquet) with the parquet crate's low-level writer.
//! scripts/goldens-files.mjs reads every one of them through 1.1.4's readProjectFile (hyparquet) into
//! test/golden/files-parquet.jsonl, and tests/golden.rs compares the Rust preview with it.
//!
//!     cargo run -p unimux-files --example parquet_fixtures -- ../test/golden/parquet
//!
//! The files are committed; run this again only to change the corpus (then `node scripts/dump-goldens.mjs`).

use std::fs::{self, File};
use std::path::Path;
use std::sync::Arc;

use parquet::basic::Compression;
use parquet::data_type::{
    BoolType, ByteArray, ByteArrayType, DoubleType, FixedLenByteArray, FixedLenByteArrayType, FloatType, Int32Type, Int64Type,
    Int96, Int96Type,
};
use parquet::file::properties::{WriterProperties, WriterVersion};
use parquet::file::writer::SerializedFileWriter;
use parquet::schema::parser::parse_message_type;

/// One leaf column of one row group: the non-null values, then the definition and repetition levels (None: not needed).
enum Col {
    I32(Vec<i32>, Option<Vec<i16>>, Option<Vec<i16>>),
    I64(Vec<i64>, Option<Vec<i16>>, Option<Vec<i16>>),
    I96(Vec<Int96>, Option<Vec<i16>>),
    F32(Vec<f32>, Option<Vec<i16>>),
    F64(Vec<f64>, Option<Vec<i16>>),
    Bool(Vec<bool>, Option<Vec<i16>>),
    Bytes(Vec<Vec<u8>>, Option<Vec<i16>>, Option<Vec<i16>>),
    Fixed(Vec<Vec<u8>>, Option<Vec<i16>>),
}

fn write(dir: &Path, name: &str, schema: &str, props: WriterProperties, groups: Vec<Vec<Col>>) {
    let schema = Arc::new(parse_message_type(schema).unwrap_or_else(|e| panic!("{name}: {e}")));
    let file = File::create(dir.join(name)).unwrap();
    let mut writer = SerializedFileWriter::new(file, schema, Arc::new(props)).unwrap();
    for cols in groups {
        let mut group = writer.next_row_group().unwrap();
        for col in cols {
            let mut column = group.next_column().unwrap().expect("more columns than leaves");
            match col {
                Col::I32(v, d, r) => {
                    column.typed::<Int32Type>().write_batch(&v, d.as_deref(), r.as_deref()).unwrap();
                }
                Col::I64(v, d, r) => {
                    column.typed::<Int64Type>().write_batch(&v, d.as_deref(), r.as_deref()).unwrap();
                }
                Col::I96(v, d) => {
                    column.typed::<Int96Type>().write_batch(&v, d.as_deref(), None).unwrap();
                }
                Col::F32(v, d) => {
                    column.typed::<FloatType>().write_batch(&v, d.as_deref(), None).unwrap();
                }
                Col::F64(v, d) => {
                    column.typed::<DoubleType>().write_batch(&v, d.as_deref(), None).unwrap();
                }
                Col::Bool(v, d) => {
                    column.typed::<BoolType>().write_batch(&v, d.as_deref(), None).unwrap();
                }
                Col::Bytes(v, d, r) => {
                    let v: Vec<ByteArray> = v.into_iter().map(ByteArray::from).collect();
                    {
                        column.typed::<ByteArrayType>().write_batch(&v, d.as_deref(), r.as_deref()).unwrap();
                    }
                }
                Col::Fixed(v, d) => {
                    let v: Vec<FixedLenByteArray> = v.into_iter().map(FixedLenByteArray::from).collect();
                    {
                        column.typed::<FixedLenByteArrayType>().write_batch(&v, d.as_deref(), None).unwrap();
                    }
                }
            }
            column.close().unwrap();
        }
        assert!(group.next_column().unwrap().is_none(), "{name}: fewer columns than leaves");
        group.close().unwrap();
    }
    writer.close().unwrap();
}

fn props(compression: Compression) -> WriterProperties {
    WriterProperties::builder().set_compression(compression).build()
}

fn s(text: &str) -> Vec<u8> {
    text.as_bytes().to_vec()
}

fn int96(nanos_of_day: u64, julian_day: u32) -> Int96 {
    let mut v = Int96::new();
    v.set_data(nanos_of_day as u32, (nanos_of_day >> 32) as u32, julian_day);
    v
}

/// Big-endian two's complement of `v` in `len` bytes.
fn be(v: i128, len: usize) -> Vec<u8> {
    v.to_be_bytes()[16 - len..].to_vec()
}

fn f16(bits: u16) -> Vec<u8> {
    bits.to_le_bytes().to_vec()
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: parquet_fixtures <dir>");
    let dir = Path::new(&dir);
    fs::create_dir_all(dir).unwrap();

    // Every primitive kind and annotation 1.1.4's preview shows (4 rows; optional columns hold a null in row 2).
    let opt = || Some(vec![1, 0, 1, 1]);
    write(
        dir,
        "types.parquet",
        "message m {
            required int32 i32;
            optional int64 i64;
            required float f32;
            optional double f64;
            required boolean flag;
            optional binary s (UTF8);
            optional binary str (STRING);
            required binary raw;
            required binary en (ENUM);
            optional binary js (JSON);
            required int32 d (DATE);
            required int64 tsm (TIMESTAMP_MILLIS);
            required int64 tsu (TIMESTAMP(MICROS,true));
            required int64 tsn (TIMESTAMP(NANOS,false));
            required int32 tm (TIME(MILLIS,false));
            required int64 tu (TIME(MICROS,true));
            required int32 dec32 (DECIMAL(9,2));
            required int64 dec64 (DECIMAL(18,4));
            required fixed_len_byte_array(16) decf (DECIMAL(38,10));
            required binary decb (DECIMAL(20,3));
            required int32 u8 (INTEGER(8,false));
            required int32 u16 (INTEGER(16,false));
            required int32 u32 (INTEGER(32,false));
            required int64 u64 (INTEGER(64,false));
            required int32 i8 (INTEGER(8,true));
            required int64 i64s (INTEGER(64,true));
            required int32 lu32 (UINT_32);
            required int64 lu64 (UINT_64);
            required fixed_len_byte_array(16) id (UUID);
            optional fixed_len_byte_array(2) half (FLOAT16);
            required int96 i96;
            required fixed_len_byte_array(3) flba;
        }",
        props(Compression::SNAPPY),
        vec![vec![
            Col::I32(vec![0, -1, i32::MAX, i32::MIN], None, None),
            Col::I64(vec![1, -9_007_199_254_740_993, i64::MAX], opt(), None),
            Col::F32(vec![0.1, -0.0, f32::MAX, f32::NAN], None),
            Col::F64(vec![0.1, 1e21, f64::NEG_INFINITY], opt()),
            Col::Bool(vec![true, false, false, true], None),
            Col::Bytes(vec![s("Zażółć gęślą jaźń"), s(""), s("😀 \"q\" \\ \n")], opt(), None),
            Col::Bytes(vec![s("a"), s("b"), s("c")], opt(), None),
            Col::Bytes(vec![s("plain"), vec![0xff, 0xfe, 0x41], vec![], s("ł")], None, None),
            Col::Bytes(vec![s("RED"), s("GREEN"), s("BLUE"), s("RED")], None, None),
            Col::Bytes(vec![s(r#"{"b":1,"a":[1,2.5,"x",null],"0":true,"1e2":{}}"#), s("null"), s(r#""txt""#)], opt(), None),
            Col::I32(vec![0, 19_000, -1, 2_932_896], None, None),
            Col::I64(vec![0, 1_700_000_000_123, -1, 8_640_000_000_000_001], None, None),
            Col::I64(vec![0, 1_700_000_000_123_456, -1, -62_198_755_200_000_000], None, None),
            Col::I64(vec![0, 1_700_000_000_123_456_789, -1, i64::MAX], None, None),
            Col::I32(vec![0, 1, 86_399_999, 43_200_000], None, None),
            Col::I64(vec![0, 1, 86_399_999_999, 43_200_000_000], None, None),
            Col::I32(vec![0, 12_345, -1, 999_999_999], None, None),
            Col::I64(vec![0, 123_456_789, -1, 999_999_999_999_999_999], None, None),
            Col::Fixed(vec![be(0, 16), be(12_345_678_901_234_567_890, 16), be(-1, 16), be(i128::MAX / 7, 16)], None),
            Col::Bytes(vec![be(0, 1), be(123_456, 3), be(-5, 1), be(-123_456_789_012_345_678, 9)], None, None),
            Col::I32(vec![0, 1, 127, 255], None, None),
            Col::I32(vec![0, 1, 32_767, 65_535], None, None),
            Col::I32(vec![0, 1, i32::MAX, -1], None, None),
            Col::I64(vec![0, 1, i64::MAX, -1], None, None),
            Col::I32(vec![0, -1, 127, -128], None, None),
            Col::I64(vec![0, -1, i64::MAX, i64::MIN], None, None),
            Col::I32(vec![0, 1, -1, -2], None, None),
            Col::I64(vec![0, 1, -1, -2], None, None),
            Col::Fixed(
                vec![
                    vec![0; 16],
                    (0..16).collect(),
                    vec![0xff; 16],
                    vec![0x12, 0x3e, 0x45, 0x67, 0xe8, 0x9b, 0x12, 0xd3, 0xa4, 0x56, 0x42, 0x66, 0x14, 0x17, 0x40, 0x00],
                ],
                None,
            ),
            Col::Fixed(vec![f16(0x3c00), f16(0x8001), f16(0x7c00)], opt()),
            Col::I96(
                vec![int96(0, 2_440_588), int96(1_000_000_123, 2_460_000), int96(86_399_999_999_999, 0), int96(1, 2_440_587)],
                None,
            ),
            Col::Fixed(vec![s("abc"), vec![0, 1, 2], s("xyz"), s("ąb")[..3].to_vec()], None),
        ]],
    );

    // Nested values (zstd): 3-level LIST of strings, a legacy 2-level list, a MAP, a struct with a nested struct.
    write(
        dir,
        "nested.parquet",
        "message m {
            optional group tags (LIST) {
                repeated group list {
                    optional binary element (UTF8);
                }
            }
            optional group legacy (LIST) {
                repeated int32 item;
            }
            optional group attrs (MAP) {
                repeated group key_value {
                    required binary key (UTF8);
                    optional int64 value;
                }
            }
            optional group st {
                required int32 a;
                optional group inner {
                    optional double z;
                    optional binary when (UTF8);
                }
            }
            optional group nums (LIST) {
                repeated group list {
                    required group element (LIST) {
                        repeated group list {
                            required int32 element;
                        }
                    }
                }
            }
        }",
        props(Compression::ZSTD(Default::default())),
        vec![vec![
            // rows: ["a","b"] / [] / null / ["x", null]
            Col::Bytes(vec![s("a"), s("b"), s("x")], Some(vec![3, 3, 1, 0, 3, 2]), Some(vec![0, 1, 0, 0, 0, 1])),
            // rows: [1,2,3] / [] / null / [7]
            Col::I32(vec![1, 2, 3, 7], Some(vec![2, 2, 2, 1, 0, 2]), Some(vec![0, 1, 1, 0, 0, 0])),
            // keys: {"k":1,"2":null,"1":3} / {} / null / {"k":5,"k":6}
            Col::Bytes(
                vec![s("k"), s("2"), s("1"), s("k"), s("k")],
                Some(vec![2, 2, 2, 1, 0, 2, 2]),
                Some(vec![0, 1, 1, 0, 0, 0, 1]),
            ),
            Col::I64(vec![1, 3, 5, 6], Some(vec![3, 2, 3, 1, 0, 3, 3]), Some(vec![0, 1, 1, 0, 0, 0, 1])),
            // st: {a:1, inner:{z:0.5, when:"t"}} / {a:2, inner:null} / null / {a:4, inner:{z:null, when:null}}
            Col::I32(vec![1, 2, 4], Some(vec![1, 1, 0, 1]), None),
            Col::F64(vec![0.5], Some(vec![3, 1, 0, 2])),
            Col::Bytes(vec![s("t")], Some(vec![3, 1, 0, 2]), None),
            // nums: [[1,2],[3]] / [[]] / null / []
            Col::I32(vec![1, 2, 3], Some(vec![3, 3, 3, 2, 0, 1]), Some(vec![0, 2, 1, 0, 0, 0])),
        ]],
    );

    // 1500 rows in five row groups (brotli): the preview keeps the first 1000, totalRows says 1500.
    let groups = (0..5)
        .map(|g| {
            let ids: Vec<i64> = (g * 300..(g + 1) * 300).collect();
            let names: Vec<Vec<u8>> = ids.iter().map(|i| s(&format!("wiersz {i}"))).collect();
            vec![Col::I64(ids, None, None), Col::Bytes(names, None, None)]
        })
        .collect();
    write(
        dir,
        "many.parquet",
        "message m { required int64 id; required binary name (UTF8); }",
        props(Compression::BROTLI(Default::default())),
        groups,
    );

    // The other codecs, data page v2 and no dictionary.
    let schema = "message m { required int32 n; optional binary t (UTF8); }";
    for (name, codec) in [
        ("plain.parquet", Compression::UNCOMPRESSED),
        ("gzip.parquet", Compression::GZIP(Default::default())),
        ("lz4raw.parquet", Compression::LZ4_RAW),
        ("lz4.parquet", Compression::LZ4),
    ] {
        let rows = vec![vec![
            Col::I32(vec![1, 2, 3, 4], None, None),
            Col::Bytes(vec![s("ą"), s("b"), s("ą")], Some(vec![1, 1, 0, 1]), None),
        ]];
        write(dir, name, schema, props(codec), rows);
    }
    let v2 = WriterProperties::builder()
        .set_writer_version(WriterVersion::PARQUET_2_0)
        .set_dictionary_enabled(false)
        .set_compression(Compression::SNAPPY)
        .build();
    write(
        dir,
        "v2.parquet",
        schema,
        v2,
        vec![vec![
            Col::I32(vec![1, 2, 3, 4], None, None),
            Col::Bytes(vec![s("ą"), s("b"), s("ą")], Some(vec![1, 1, 0, 1]), None),
        ]],
    );

    // No rows at all, and a column type hyparquet refuses (BSON).
    write(dir, "empty.parquet", schema, props(Compression::SNAPPY), vec![]);
    write(
        dir,
        "bson.parquet",
        "message m { required int32 n; optional binary b (BSON); }",
        props(Compression::UNCOMPRESSED),
        vec![vec![Col::I32(vec![1], None, None), Col::Bytes(vec![vec![5, 0, 0, 0, 0]], Some(vec![1]), None)]],
    );

    // Damaged files: not Parquet at all, cut in the middle, the footer magic only.
    fs::write(dir.join("garbage.parquet"), b"this is not a parquet file").unwrap();
    let many = fs::read(dir.join("many.parquet")).unwrap();
    fs::write(dir.join("truncated.parquet"), &many[..many.len() / 2]).unwrap();
    fs::write(dir.join("magic-only.parquet"), b"PAR1PAR1").unwrap();
}
