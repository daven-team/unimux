//! The text encodings mysql2 3.24 uses for a MySQL charset number (lib/constants/charset_encodings.js and
//! encoding_charset.js), and the Node / iconv-lite conversions behind them, for the two places where 1.1.4 follows the
//! session charset: the COM_QUERY text is encoded in the encoding of `character_set_client` (taken from the OK packet's
//! session-state tracking after `SET NAMES` / `SET CHARACTER SET`), and column names are decoded in the column
//! definition's charset (the client encoding when that is `binary`). Cell values are not affected: mysqlSession decodes
//! them as UTF-8 whatever the session says.
//!
//! Done here like Node: utf8, latin1 / binary (one byte per UTF-16 unit, the low byte), ascii (Node writes the low byte and
//! reads `byte & 0x7f`), ucs2 / utf16-le, and cesu8 (iconv-lite: every UTF-16 unit as its own 1-3 byte sequence). The other
//! encodings mysql2 hands to iconv-lite (big5, cp1250, koi8r, sjis ...) are `Other`: the spike refuses to send a query in
//! them and decodes such names as UTF-8 (D7 adds iconv-lite's tables; encoding_rs differs from iconv-lite at unmapped
//! bytes).

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
    /// An iconv-lite encoding the spike does not convert (the mysql2 name).
    Other(&'static str),
}

/// mysql2's encoding name for a charset number (`undefined` for an unknown number: Node then writes UTF-8).
pub fn encoding_name(charset: u16) -> Option<&'static str> {
    RUNS.iter().find(|(a, b, _)| (*a..=*b).contains(&charset)).map(|r| r.2)
}

pub fn enc_of(charset: u16) -> Enc {
    match encoding_name(charset) {
        None | Some("utf8") => Enc::Utf8,
        Some("latin1" | "binary") => Enc::Latin1,
        Some("ascii") => Enc::Ascii,
        Some("ucs2" | "utf16-le") => Enc::Ucs2,
        Some("cesu8") => Enc::Cesu8,
        Some(other) => Enc::Other(other),
    }
}

/// The encoding a column name is decoded with (column_definition.js: the client encoding for a `binary` column).
pub fn name_enc(column_charset: u16, client_charset: u16) -> Enc {
    if encoding_name(column_charset) == Some("binary") { enc_of(client_charset) } else { enc_of(column_charset) }
}

/// `Buffer.from(s, enc)` / iconv-lite `encode`. `Err(name)` for an encoding the spike does not convert.
pub fn encode(s: &str, enc: Enc) -> Result<Vec<u8>, &'static str> {
    Ok(match enc {
        Enc::Utf8 => s.as_bytes().to_vec(),
        Enc::Latin1 | Enc::Ascii => s.encode_utf16().map(|u| (u & 0xff) as u8).collect(),
        Enc::Ucs2 => s.encode_utf16().flat_map(u16::to_le_bytes).collect(),
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
        Enc::Other(name) => return Err(name),
    })
}

/// `buffer.toString(enc)` / iconv-lite `decode` (lone surrogates of ucs2 become U+FFFD, `Other` is read as UTF-8).
pub fn decode(b: &[u8], enc: Enc) -> String {
    match enc {
        Enc::Utf8 | Enc::Other(_) => String::from_utf8_lossy(b).into_owned(),
        Enc::Latin1 => b.iter().map(|&x| char::from(x)).collect(),
        Enc::Ascii => b.iter().map(|&x| char::from(x & 0x7f)).collect(),
        Enc::Ucs2 => {
            let units: Vec<u16> = b.as_chunks::<2>().0.iter().map(|p| u16::from_le_bytes(*p)).collect();
            String::from_utf16_lossy(&units)
        }
        Enc::Cesu8 => decode_cesu8(b),
    }
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
        assert_eq!(enc_of(26), Enc::Other("cp1250"));
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
        assert_eq!(encode("x", Enc::Other("cp1250")), Err("cp1250"));
    }
}
