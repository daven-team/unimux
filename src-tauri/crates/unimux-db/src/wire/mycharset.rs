//! The text encodings mysql2 3.24 uses for a MySQL charset number (lib/constants/charset_encodings.js and
//! encoding_charset.js), and the Node / iconv-lite conversions behind them, for the two places where 1.1.4 follows the
//! session charset: the COM_QUERY text is encoded in the encoding of `character_set_client` (taken from the OK packet's
//! session-state tracking after `SET NAMES` / `SET CHARACTER SET`), and column names are decoded in the column
//! definition's charset (the client encoding when that is `binary`). Cell values are not affected: mysqlSession decodes
//! them as UTF-8 whatever the session says.
//!
//! Done here like Node: utf8, latin1 / binary (one byte per UTF-16 unit, the low byte), ascii (Node writes the low byte and
//! reads `byte & 0x7f`), ucs2 / utf16-le, and cesu8 (iconv-lite: every UTF-16 unit as its own 1-3 byte sequence). D7 adds
//! the encodings mysql2 hands to iconv-lite 0.7.3: the single-byte codepages exactly (tables generated from iconv-lite by
//! scripts/gen-mysql-sbcs.mjs, `sbcs_tables.rs`), utf16 / utf32 with iconv-lite's endianness detection, and the double-byte
//! ones (big5, eucjp, sjis / cp932, euckr, gb2312 / gbk, gb18030) through encoding_rs: the same characters, but invalid
//! byte sequences may give a different number of U+FFFD than iconv-lite's DBCS decoder (open, PROGRESS.md D7). Names
//! iconv-lite does not know (dec8, hp8, swe7, keybcs2, geostd8, eucjpms) are `Unknown`: a query in them is refused with
//! iconv-lite's error text and such column names are read as UTF-8.

use super::sbcs_tables::SBCS;

/// (first, last, encoding) runs of mysql2's charset_encodings.js (generated from mysql2 3.24).
#[rustfmt::skip]
const RUNS: &[(u16, u16, &str)] = &[
    (0, 0, "utf8"), (1, 1, "big5"), (2, 2, "latin2"), (3, 3, "dec8"), (4, 4, "cp850"), (5, 5, "latin1"), (6, 6, "hp8"),
    (7, 7, "koi8r"), (8, 8, "latin1"), (9, 9, "latin2"), (10, 10, "swe7"), (11, 11, "ascii"), (12, 12, "eucjp"),
    (13, 13, "sjis"), (14, 14, "cp1251"), (15, 15, "latin1"), (16, 16, "hebrew"), (17, 17, "utf8"), (18, 18, "tis620"),
    (19, 19, "euckr"), (20, 20, "latin7"), (21, 21, "latin2"), (22, 22, "koi8u"), (23, 23, "cp1251"), (24, 24, "gb2312"),
    (25, 25, "greek"), (26, 26, "cp1250"), (27, 27, "latin2"), (28, 28, "gbk"), (29, 29, "cp1257"), (30, 30, "latin5"),
    (31, 31, "latin1"), (32, 32, "armscii8"), (33, 33, "cesu8"), (34, 34, "cp1250"), (35, 35, "ucs2"), (36, 36, "cp866"),
    (37, 37, "keybcs2"), (38, 38, "macintosh"), (39, 39, "macroman"), (40, 40, "cp852"), (41, 42, "latin7"),
    (43, 43, "macintosh"), (44, 44, "cp1250"), (45, 46, "utf8"), (47, 49, "latin1"), (50, 52, "cp1251"),
    (53, 53, "macroman"), (54, 55, "utf16"), (56, 56, "utf16-le"), (57, 57, "cp1256"), (58, 59, "cp1257"),
    (60, 61, "utf32"), (62, 62, "utf16-le"), (63, 63, "binary"), (64, 64, "armscii8"), (65, 65, "ascii"),
    (66, 66, "cp1250"), (67, 67, "cp1256"), (68, 68, "cp866"), (69, 69, "dec8"), (70, 70, "greek"), (71, 71, "hebrew"),
    (72, 72, "hp8"), (73, 73, "keybcs2"), (74, 74, "koi8r"), (75, 75, "koi8u"), (76, 76, "cesu8"), (77, 77, "latin2"),
    (78, 78, "latin5"), (79, 79, "latin7"), (80, 80, "cp850"), (81, 81, "cp852"), (82, 82, "swe7"), (83, 83, "cesu8"),
    (84, 84, "big5"), (85, 85, "euckr"), (86, 86, "gb2312"), (87, 87, "gbk"), (88, 88, "sjis"), (89, 89, "tis620"),
    (90, 90, "ucs2"), (91, 91, "eucjp"), (92, 93, "geostd8"), (94, 94, "latin1"), (95, 96, "cp932"),
    (97, 98, "eucjpms"), (99, 99, "cp1250"), (100, 124, "utf16"), (125, 127, "utf8"), (128, 151, "ucs2"),
    (152, 158, "utf8"), (159, 159, "ucs2"), (160, 183, "utf32"), (184, 191, "utf8"), (192, 215, "cesu8"),
    (216, 222, "utf8"), (223, 223, "cesu8"), (224, 247, "utf8"), (248, 250, "gb18030"), (251, 309, "utf8"),
    (1025, 1025, "big5"), (1026, 1026, "latin2"), (1027, 1027, "dec8"), (1028, 1028, "cp850"), (1029, 1029, "latin1"),
    (1030, 1030, "hp8"), (1031, 1031, "koi8r"), (1032, 1032, "latin1"), (1033, 1033, "latin2"), (1034, 1034, "swe7"),
    (1035, 1035, "ascii"), (1036, 1036, "eucjp"), (1037, 1037, "sjis"), (1038, 1038, "cp1251"), (1039, 1039, "latin1"),
    (1040, 1040, "hebrew"), (1041, 1041, "utf8"), (1042, 1042, "tis620"), (1043, 1043, "euckr"), (1044, 1044, "latin7"),
    (1045, 1045, "latin2"), (1046, 1046, "koi8u"), (1047, 1047, "cp1251"), (1048, 1048, "gb2312"), (1049, 1049, "greek"),
    (1050, 1050, "cp1250"), (1051, 1051, "latin2"), (1052, 1052, "gbk"), (1053, 1053, "cp1257"), (1054, 1054, "latin5"),
    (1055, 1055, "latin1"), (1056, 1056, "armscii8"), (1057, 1057, "cesu8"), (1058, 1058, "cp1250"), (1059, 1059, "ucs2"),
    (1060, 1060, "cp866"), (1061, 1061, "keybcs2"), (1062, 1062, "macintosh"), (1063, 1063, "macroman"),
    (1064, 1064, "cp852"), (1065, 1066, "latin7"), (1067, 1067, "macintosh"), (1068, 1068, "cp1250"),
    (1069, 1070, "utf8"), (1071, 1073, "latin1"), (1074, 1076, "cp1251"), (1077, 1077, "macroman"), (1078, 1079, "utf16"),
    (1080, 1080, "utf16-le"), (1081, 1081, "cp1256"), (1082, 1083, "cp1257"), (1084, 1085, "utf32"),
    (1086, 1086, "utf16-le"), (1087, 1087, "binary"), (1088, 1088, "armscii8"), (1089, 1089, "ascii"),
    (1090, 1090, "cp1250"), (1091, 1091, "cp1256"), (1092, 1092, "cp866"), (1093, 1093, "dec8"), (1094, 1094, "greek"),
    (1095, 1095, "hebrew"), (1096, 1096, "hp8"), (1097, 1097, "keybcs2"), (1098, 1098, "koi8r"), (1099, 1099, "koi8u"),
    (1100, 1100, "cesu8"), (1101, 1101, "latin2"), (1102, 1102, "latin5"), (1103, 1103, "latin7"), (1104, 1104, "cp850"),
    (1105, 1105, "cp852"), (1106, 1106, "swe7"), (1107, 1107, "cesu8"), (1108, 1108, "big5"), (1109, 1109, "euckr"),
    (1110, 1110, "gb2312"), (1111, 1111, "gbk"), (1112, 1112, "sjis"), (1113, 1113, "tis620"), (1114, 1114, "ucs2"),
    (1115, 1115, "eucjp"), (1116, 1117, "geostd8"), (1118, 1118, "latin1"), (1119, 1120, "cp932"),
    (1121, 1122, "eucjpms"), (1123, 1123, "cp1250"), (1124, 1148, "utf16"), (1149, 1151, "utf8"), (1152, 1175, "ucs2"),
    (1176, 1182, "utf8"), (1183, 1183, "ucs2"), (1184, 1207, "utf32"), (1208, 1215, "utf8"), (1216, 1239, "cesu8"),
    (1240, 1246, "utf8"), (1247, 1247, "cesu8"), (1248, 1271, "utf8"), (1272, 1274, "gb18030"), (1275, 1333, "utf8"),
    (2048, 2303, "cesu8"), (2304, 2559, "utf8"), (2560, 2815, "ucs2"), (2816, 3071, "utf16"), (3072, 3327, "utf32"),
];

/// mysql2's encoding_charset.js: the charset number mysql2 switches to when the server reports this
/// `character_set_client` (an unknown name leaves the number as it is).
pub fn charset_of_name(name: &str) -> Option<u16> {
    Some(match name {
        "big5" => 1,
        "latin2" => 2,
        "dec8" => 3,
        "cp850" => 4,
        "latin1" => 5,
        "hp8" => 6,
        "koi8r" => 7,
        "swe7" => 10,
        "ascii" => 11,
        "eucjp" => 12,
        "sjis" => 13,
        "cp1251" => 14,
        "hebrew" => 16,
        "tis620" => 18,
        "euckr" => 19,
        "latin7" => 20,
        "koi8u" => 22,
        "gb2312" => 24,
        "greek" => 25,
        "cp1250" => 26,
        "gbk" => 28,
        "cp1257" => 29,
        "latin5" => 30,
        "armscii8" => 32,
        "cesu8" => 33,
        "ucs2" => 35,
        "cp866" => 36,
        "keybcs2" => 37,
        "macintosh" => 38,
        "macroman" => 39,
        "cp852" => 40,
        "utf8" | "utf8mb4" => 45,
        "utf16" => 54,
        "utf16le" => 56,
        "cp1256" => 57,
        "utf32" => 60,
        "binary" => 63,
        "geostd8" => 92,
        "cp932" => 95,
        "eucjpms" => 97,
        "gb18030" => 248,
        "utf8mb3" => 192,
        _ => return None,
    })
}

/// How a text in one encoding is converted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enc {
    Utf8,
    /// latin1 and binary (Node `latin1` / `binary`).
    Latin1,
    Ascii,
    /// ucs2, utf16-le (Node `ucs2`).
    Ucs2,
    Cesu8,
    /// An iconv-lite single-byte codepage (the mysql2 name and its decode table).
    Sbcs(&'static str, &'static [u16; 256]),
    /// iconv-lite `utf16`: encodes BOM + UTF-16LE, decodes with BOM / ASCII-position detection (default LE).
    Utf16,
    /// iconv-lite `utf32`: encodes BOM + UTF-32LE, decodes with BOM / validity detection (default LE).
    Utf32,
    /// An iconv-lite double-byte encoding, converted through encoding_rs (the mysql2 name and the encoding).
    Dbcs(&'static str, &'static encoding_rs::Encoding),
    /// A name iconv-lite does not know (the mysql2 name).
    Unknown(&'static str),
}

/// mysql2's encoding name for a charset number (`undefined` for an unknown number: Node then writes UTF-8).
pub fn encoding_name(charset: u16) -> Option<&'static str> {
    RUNS.iter().find(|(a, b, _)| (*a..=*b).contains(&charset)).map(|r| r.2)
}

fn sbcs_table(name: &str) -> Option<(&'static str, &'static [u16; 256])> {
    SBCS.iter().find(|(n, _)| *n == name).map(|(n, t)| (*n, t))
}

/// The encoding behind a mysql2 encoding name (as iconv-lite resolves it).
pub fn enc_of_name(name: &'static str) -> Enc {
    match name {
        "utf8" => Enc::Utf8,
        "latin1" | "binary" => Enc::Latin1,
        "ascii" => Enc::Ascii,
        "ucs2" | "utf16-le" => Enc::Ucs2,
        "cesu8" => Enc::Cesu8,
        "utf16" => Enc::Utf16,
        "utf32" => Enc::Utf32,
        // iconv-lite: big5 is big5hkscs, euckr cp949, gb2312 cp936, sjis and cp932 shiftjis
        "big5" => Enc::Dbcs(name, encoding_rs::BIG5),
        "eucjp" => Enc::Dbcs(name, encoding_rs::EUC_JP),
        "sjis" | "cp932" => Enc::Dbcs(name, encoding_rs::SHIFT_JIS),
        "euckr" => Enc::Dbcs(name, encoding_rs::EUC_KR),
        "gb2312" | "gbk" => Enc::Dbcs(name, encoding_rs::GBK),
        "gb18030" => Enc::Dbcs(name, encoding_rs::GB18030),
        other => match sbcs_table(other) {
            Some((n, t)) => Enc::Sbcs(n, t),
            None => Enc::Unknown(other),
        },
    }
}

pub fn enc_of(charset: u16) -> Enc {
    match encoding_name(charset) {
        None => Enc::Utf8,
        Some(name) => enc_of_name(name),
    }
}

/// iconv-lite's error for a name it does not know (`getCodec`).
pub fn unknown_encoding_message(name: &str) -> String {
    let searched: String = name.to_lowercase().chars().filter(char::is_ascii_alphanumeric).collect();
    format!("Encoding not recognized: '{name}' (searched as: '{searched}')")
}

/// The encoding a column name is decoded with (column_definition.js: the client encoding for a `binary` column).
pub fn name_enc(column_charset: u16, client_charset: u16) -> Enc {
    if encoding_name(column_charset) == Some("binary") { enc_of(client_charset) } else { enc_of(column_charset) }
}

/// `Buffer.from(s, enc)` / iconv-lite `encode`. `Err(name)` for an encoding iconv-lite does not know.
pub fn encode(s: &str, enc: Enc) -> Result<Vec<u8>, &'static str> {
    Ok(match enc {
        Enc::Utf8 => s.as_bytes().to_vec(),
        Enc::Latin1 | Enc::Ascii => s.encode_utf16().map(|u| (u & 0xff) as u8).collect(),
        Enc::Ucs2 => s.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        // iconv-lite's utf16 / utf32 encoders (getEncoder(name, {})) write a little-endian BOM first
        Enc::Utf16 => [0xff, 0xfe].into_iter().chain(s.encode_utf16().flat_map(u16::to_le_bytes)).collect(),
        Enc::Utf32 => [0xff, 0xfe, 0, 0].into_iter().chain(s.chars().flat_map(|c| u32::from(c).to_le_bytes())).collect(),
        Enc::Sbcs(_, table) => {
            // SBCSCodec: a 64K table filled with '?', then every byte written at its unit (the last byte wins)
            s.encode_utf16().map(|u| table.iter().rposition(|&t| t == u).map_or(b'?', |b| b as u8)).collect()
        }
        Enc::Dbcs(_, encoding) => encode_dbcs(s, encoding),
        Enc::Unknown(name) => return Err(name),
        Enc::Cesu8 => {
            let mut out = Vec::with_capacity(s.len());
            for u in s.encode_utf16() {
                let u = u32::from(u);
                if u < 0x80 {
                    out.push(u as u8);
                } else if u < 0x800 {
                    out.extend([0xc0 | (u >> 6) as u8, 0x80 | (u & 0x3f) as u8]);
                } else {
                    out.extend([0xe0 | (u >> 12) as u8, 0x80 | ((u >> 6) & 0x3f) as u8, 0x80 | (u & 0x3f) as u8]);
                }
            }
            out
        }
    })
}

/// A double-byte encoding: unmappable characters become '?' (iconv-lite's defaultCharSingleByte), not the HTML numeric
/// reference encoding_rs writes.
fn encode_dbcs(s: &str, encoding: &'static encoding_rs::Encoding) -> Vec<u8> {
    let mut encoder = encoding.new_encoder();
    let mut out = Vec::with_capacity(s.len() * 2);
    let mut rest = s;
    let mut buf = [0u8; 1024];
    loop {
        let (result, read, written) = encoder.encode_from_utf8_without_replacement(rest, &mut buf, true);
        out.extend_from_slice(&buf[..written]);
        rest = &rest[read..];
        match result {
            encoding_rs::EncoderResult::InputEmpty => return out,
            encoding_rs::EncoderResult::OutputFull => {}
            // iconv-lite's DBCS encoder writes one '?' per character, also outside the BMP
            encoding_rs::EncoderResult::Unmappable(_) => out.push(b'?'),
        }
    }
}

/// `buffer.toString(enc)` / iconv-lite `decode` (lone surrogates become U+FFFD, `Unknown` is read as UTF-8).
pub fn decode(b: &[u8], enc: Enc) -> String {
    match enc {
        Enc::Utf8 | Enc::Unknown(_) => String::from_utf8_lossy(b).into_owned(),
        Enc::Latin1 => b.iter().map(|&x| char::from(x)).collect(),
        Enc::Ascii => b.iter().map(|&x| char::from(x & 0x7f)).collect(),
        Enc::Ucs2 => utf16_units(b, false),
        Enc::Cesu8 => decode_cesu8(b),
        Enc::Sbcs(_, table) => {
            let units: Vec<u16> = b.iter().map(|&x| table[usize::from(x)]).collect();
            String::from_utf16_lossy(&units)
        }
        Enc::Utf16 => strip_bom(utf16_units(b, utf16_is_be(b))),
        Enc::Utf32 => {
            let be = utf32_is_be(b);
            let s = b
                .as_chunks::<4>()
                .0
                .iter()
                .map(|q| char::from_u32(if be { u32::from_be_bytes(*q) } else { u32::from_le_bytes(*q) }).unwrap_or('\u{fffd}'))
                .collect();
            strip_bom(s)
        }
        Enc::Dbcs(_, encoding) => strip_bom(encoding.decode_without_bom_handling(b).0.into_owned()),
    }
}

/// iconv-lite strips a leading BOM when it decodes (stripBOM defaults to on).
fn strip_bom(s: String) -> String {
    match s.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_owned(),
        None => s,
    }
}

fn utf16_units(b: &[u8], be: bool) -> String {
    let units: Vec<u16> =
        b.as_chunks::<2>().0.iter().map(|p| if be { u16::from_be_bytes(*p) } else { u16::from_le_bytes(*p) }).collect();
    String::from_utf16_lossy(&units)
}

/// iconv-lite utf16.js `detectEncoding`: a BOM, else the side the ASCII bytes are on (first 100 units), default LE.
fn utf16_is_be(b: &[u8]) -> bool {
    let pairs = b.as_chunks::<2>().0;
    match pairs.first() {
        Some([0xff, 0xfe]) => return false,
        Some([0xfe, 0xff]) => return true,
        _ => {}
    }
    let (mut le, mut be) = (0, 0);
    for p in pairs.iter().take(100) {
        if p[0] == 0 && p[1] != 0 {
            be += 1;
        }
        if p[0] != 0 && p[1] == 0 {
            le += 1;
        }
    }
    be > le
}

/// iconv-lite utf32.js `detectEncoding`: a BOM, else BMP characters minus invalid ones per side, default LE.
fn utf32_is_be(b: &[u8]) -> bool {
    let quads = b.as_chunks::<4>().0;
    match quads.first() {
        Some([0xff, 0xfe, 0, 0]) => return false,
        Some([0, 0, 0xfe, 0xff]) => return true,
        _ => {}
    }
    let (mut invalid_le, mut invalid_be, mut bmp_le, mut bmp_be) = (0i32, 0i32, 0i32, 0i32);
    for q in quads.iter().take(100) {
        if q[0] != 0 || q[1] > 0x10 {
            invalid_be += 1;
        }
        if q[3] != 0 || q[2] > 0x10 {
            invalid_le += 1;
        }
        if q[0] == 0 && q[1] == 0 && (q[2] != 0 || q[3] != 0) {
            bmp_be += 1;
        }
        if (q[0] != 0 || q[1] != 0) && q[2] == 0 && q[3] == 0 {
            bmp_le += 1;
        }
    }
    bmp_be - invalid_be > bmp_le - invalid_le
}

/// CESU-8: UTF-8 whose supplementary characters come as two 3-byte surrogate sequences.
fn decode_cesu8(b: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(b) {
        return s.to_owned();
    }
    let mut units: Vec<u16> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let x = b[i];
        let cont = |k: usize| b.get(i + k).copied().filter(|c| c & 0xc0 == 0x80);
        if x < 0x80 {
            units.push(u16::from(x));
            i += 1;
        } else if x & 0xe0 == 0xc0
            && let Some(c1) = cont(1)
        {
            units.push(u16::from(x & 0x1f) << 6 | u16::from(c1 & 0x3f));
            i += 2;
        } else if x & 0xf0 == 0xe0
            && let (Some(c1), Some(c2)) = (cont(1), cont(2))
        {
            units.push(u16::from(x & 0x0f) << 12 | u16::from(c1 & 0x3f) << 6 | u16::from(c2 & 0x3f));
            i += 3;
        } else {
            units.push(0xfffd);
            i += 1;
        }
    }
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_names_like_mysql2() {
        assert_eq!(enc_of(45), Enc::Utf8);
        assert_eq!(enc_of(224), Enc::Utf8);
        assert_eq!(enc_of(8), Enc::Latin1);
        assert_eq!(enc_of(5), Enc::Latin1);
        assert_eq!(enc_of(63), Enc::Latin1);
        assert_eq!(enc_of(33), Enc::Cesu8);
        assert!(matches!(enc_of(26), Enc::Sbcs("cp1250", _)));
        assert_eq!(enc_of(3), Enc::Unknown("dec8"));
        assert_eq!(enc_of(28), Enc::Dbcs("gbk", encoding_rs::GBK));
        assert_eq!(enc_of(5000), Enc::Utf8);
        assert_eq!(charset_of_name("latin1"), Some(5));
        assert_eq!(charset_of_name("utf8mb3"), Some(192));
        assert_eq!(charset_of_name("nope"), None);
        assert_eq!(name_enc(63, 5), Enc::Latin1);
        assert_eq!(name_enc(63, 45), Enc::Utf8);
    }

    #[test]
    fn conversions_like_node() {
        // node: Buffer.from('é€😀', 'latin1') -> e9 ac 3d 00
        assert_eq!(encode("é€😀", Enc::Latin1).unwrap(), [0xe9, 0xac, 0x3d, 0x00]);
        assert_eq!(decode(&[0xe9, 0x78], Enc::Latin1), "éx");
        assert_eq!(decode(&[0xe9, 0x41], Enc::Ascii), "iA");
        assert_eq!(encode("a😀", Enc::Ucs2).unwrap(), [0x61, 0, 0x3d, 0xd8, 0x00, 0xde]);
        // iconv-lite cesu8: U+1F600 as ED A0 BD ED B8 80
        let c = encode("a😀", Enc::Cesu8).unwrap();
        assert_eq!(c, [0x61, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]);
        assert_eq!(decode(&c, Enc::Cesu8), "a😀");
        assert_eq!(encode("x", Enc::Unknown("dec8")), Err("dec8"));
        assert_eq!(unknown_encoding_message("dec8"), "Encoding not recognized: 'dec8' (searched as: 'dec8')");
    }

    #[test]
    fn iconv_lite_codepages() {
        // node -e "require('iconv-lite').encode('a€😀ł','cp1250')" -> 61 80 3f 3f b3
        assert_eq!(encode("a€😀ł", enc_of(26)).unwrap(), [0x61, 0x80, 0x3f, 0x3f, 0xb3]);
        // iconv-lite decode([0x81, 0x80], 'cp1250') -> "�€"
        assert_eq!(decode(&[0x81, 0x80], enc_of(26)), "\u{fffd}€");
        assert_eq!(decode(&[0xc1], enc_of(7)), "а");
        assert_eq!(encode("б", enc_of(7)).unwrap(), [0xc2]);
        // gbk / big5 through encoding_rs; one '?' per unmappable character (iconv-lite getEncoder)
        assert_eq!(encode("中x😀", enc_of(28)).unwrap(), [0xd6, 0xd0, b'x', b'?']);
        assert_eq!(encode("中x😀", enc_of(1)).unwrap(), [0xa4, 0xa4, b'x', b'?']);
        assert_eq!(encode("😀", enc_of(248)).unwrap(), [0x94, 0x39, 0xfc, 0x36]);
        assert_eq!(decode(&[0xd6, 0xd0], enc_of(28)), "中");
    }

    #[test]
    fn utf16_and_utf32_detection() {
        // MySQL's utf16 is big-endian: iconv-lite sees the ASCII bytes on the BE side
        assert_eq!(decode(&[0, b'i', 0, b'd'], enc_of(54)), "id");
        assert_eq!(decode(&[b'i', 0, b'd', 0], enc_of(54)), "id");
        assert_eq!(decode(&[0xfe, 0xff, 0, b'a'], enc_of(54)), "a");
        assert_eq!(encode("a", enc_of(54)).unwrap(), [0xff, 0xfe, b'a', 0]);
        assert_eq!(decode(&[0, 0, 0, b'a'], enc_of(60)), "a");
        assert_eq!(decode(&[b'a', 0, 0, 0], enc_of(60)), "a");
        assert_eq!(encode("a", enc_of(60)).unwrap(), [0xff, 0xfe, 0, 0, b'a', 0, 0, 0]);
    }
}
