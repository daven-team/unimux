//! `Date.parse(text)` for transcript timestamps, as V8 parses them (src/date/dateparser-inl.h, ParseES5DateTime):
//!
//! - the ES date-time string format: `YYYY`, `±YYYYYY`, `-MM`, `-DD`, then `T` (or `t`) `HH:mm[:ss[.fraction]]` with `Z`
//!   (or `z`), `±HH:mm` or `±HHmm`; any number of fraction digits (the first three count); hour 24 only as 24:00[:00[.0]];
//!   a day 1 to 31 in every month (V8 rolls 2026-02-30 over to March 2);
//! - a date-only form is UTC, a date-time form without an offset is local time;
//! - once the `T` part has started, anything malformed or left over is NaN.
//!
//! V8 hands every other text (a date followed by a space, words like `Tue Oct 20 2026`) to its legacy parser. Of that only the
//! `YYYY-MM-DD HH:mm[:ss[.fraction]]` form with an optional `Z` / `UTC` / `GMT` / `±HH:mm` / `±HHmm` is ported (local time
//! without one); anything else gives NaN here (Claude Code and Codex write ISO strings with `Z`).

const MS_PER_DAY: f64 = 86_400_000.0;

/// `Date.parse(text)`; NaN when it is not a date.
pub fn parse(text: &str) -> f64 {
    let b = text.as_bytes();
    let mut p = Parser { b, i: 0 };
    match p.es5() {
        Outcome::Date(v) => v,
        Outcome::Invalid => f64::NAN,
        Outcome::Legacy(date) => p.legacy(date).unwrap_or(f64::NAN),
    }
}

enum Outcome {
    Date(f64),
    Invalid,
    /// The date part ended on something else: (year, month, day) read so far.
    Legacy((i64, i64, i64)),
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    /// A run of digits at the cursor: (value of its first 9 digits, length).
    fn digits(&self) -> (i64, usize) {
        let mut n = 0i64;
        let mut len = 0;
        while let Some(c) = self.b.get(self.i + len).filter(|c| c.is_ascii_digit()) {
            if len < 9 {
                n = n * 10 + i64::from(c - b'0');
            }
            len += 1;
        }
        (n, len)
    }

    fn fixed(&mut self, len: usize) -> Option<i64> {
        let (n, l) = self.digits();
        if l == len {
            self.i += l;
            Some(n)
        } else {
            None
        }
    }

    fn skip(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    /// A one-letter word (`T`, `Z`): the letter not followed by another letter.
    fn letter(&self, lower: u8) -> bool {
        self.peek().map(|c| c.to_ascii_lowercase()) == Some(lower)
            && !self.b.get(self.i + 1).is_some_and(|c| c.is_ascii_alphabetic())
    }

    fn es5(&mut self) -> Outcome {
        let year = match self.peek() {
            Some(s @ (b'+' | b'-')) => {
                self.i += 1;
                let Some(y) = self.fixed(6) else { return Outcome::Invalid };
                if s == b'-' && y == 0 {
                    return Outcome::Invalid;
                }
                if s == b'-' { -y } else { y }
            }
            _ => match self.fixed(4) {
                Some(y) => y,
                None => return Outcome::Invalid,
            },
        };
        let (mut month, mut day) = (1, 1);
        if self.skip(b'-') {
            match self.fixed(2).filter(|m| (1..=12).contains(m)) {
                Some(m) => month = m,
                None => return Outcome::Invalid,
            }
            if self.skip(b'-') {
                match self.fixed(2).filter(|d| (1..=31).contains(d)) {
                    Some(d) => day = d,
                    None => return Outcome::Invalid,
                }
            }
        }
        if !self.letter(b't') {
            if self.i < self.b.len() {
                return Outcome::Legacy((year, month, day));
            }
            return Outcome::Date(time_clip(make_date(year, month, day, 0.0)));
        }
        self.i += 1;
        let Some(time) = self.time() else { return Outcome::Invalid };
        let offset = if self.letter(b'z') {
            self.i += 1;
            Some(0)
        } else if matches!(self.peek(), Some(b'+' | b'-')) {
            match self.offset() {
                Some(o) => Some(o),
                None => return Outcome::Invalid,
            }
        } else {
            None
        };
        if self.i < self.b.len() {
            return Outcome::Invalid;
        }
        Outcome::Date(compose(year, month, day, time, offset))
    }

    /// `HH:mm[:ss[.fraction]]` as milliseconds of the day.
    fn time(&mut self) -> Option<f64> {
        let h = self.fixed(2).filter(|h| (0..=24).contains(h))?;
        let is24 = h == 24;
        if !self.skip(b':') {
            return None;
        }
        let m = self.fixed(2).filter(|m| (0..=59).contains(m) && !(is24 && *m > 0))?;
        let (mut s, mut ms) = (0, 0);
        if self.skip(b':') {
            s = self.fixed(2).filter(|s| (0..=59).contains(s) && !(is24 && *s > 0))?;
            if self.skip(b'.') {
                let (n, len) = self.digits();
                if len == 0 || (is24 && n > 0) {
                    return None;
                }
                self.i += len;
                ms = millis(n, len);
            }
        }
        Some(((h * 60 + m) * 60 + s) as f64 * 1000.0 + ms as f64)
    }

    /// `±HH:mm` or `±HHmm` in minutes east of UTC.
    fn offset(&mut self) -> Option<i64> {
        let sign = if self.peek() == Some(b'+') { 1 } else { -1 };
        self.i += 1;
        let (h, m) = if let Some(hm) = self.fixed(4) {
            (hm / 100, hm % 100)
        } else {
            let h = self.fixed(2)?;
            if !self.skip(b':') {
                return None;
            }
            (h, self.fixed(2)?)
        };
        if !(0..=23).contains(&h) || !(0..=59).contains(&m) {
            return None;
        }
        Some(sign * (h * 60 + m))
    }

    /// The ported part of the legacy parser: a full date, spaces, a time, an optional zone.
    fn legacy(&mut self, (year, month, day): (i64, i64, i64)) -> Option<f64> {
        if !matches!(self.peek(), Some(b' ')) {
            return None;
        }
        while self.skip(b' ') {}
        let time = self.time()?;
        while self.skip(b' ') {}
        let rest = &self.b[self.i..];
        let offset = if rest.is_empty() {
            None
        } else if rest.eq_ignore_ascii_case(b"z") || rest.eq_ignore_ascii_case(b"utc") || rest.eq_ignore_ascii_case(b"gmt") {
            Some(0)
        } else if matches!(rest[0], b'+' | b'-') {
            let o = self.offset()?;
            if self.i < self.b.len() {
                return None;
            }
            Some(o)
        } else {
            return None;
        };
        Some(compose(year, month, day, time, offset))
    }
}

/// ReadMilliseconds: one digit is tenths, two hundredths, more than three are cut to the first three.
fn millis(n: i64, len: usize) -> i64 {
    match len {
        1 => n * 100,
        2 => n * 10,
        3 => n,
        _ => {
            let mut n = n;
            let mut l = len.min(9);
            while l > 3 {
                n /= 10;
                l -= 1;
            }
            n
        }
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// MakeDate(MakeDay(year, month - 1, 1) + day - 1, time) as a wall-clock value.
fn make_date(year: i64, month: i64, day: i64, time: f64) -> f64 {
    (days_from_civil(year, month, 1) + day - 1) as f64 * MS_PER_DAY + time
}

fn time_clip(t: f64) -> f64 {
    if t.is_finite() && t.abs() <= 8.64e15 { t.trunc() + 0.0 } else { f64::NAN }
}

fn compose(year: i64, month: i64, day: i64, time: f64, offset_minutes: Option<i64>) -> f64 {
    let wall = make_date(year, month, day, time);
    match offset_minutes {
        Some(o) => time_clip(wall - o as f64 * 60_000.0),
        None => time_clip(local_to_utc(wall)),
    }
}

/// A local wall-clock time (ms as if UTC) to UTC ms, with the OS time zone rules for that date.
pub fn local_to_utc(wall: f64) -> f64 {
    if !wall.is_finite() {
        return f64::NAN;
    }
    match local_offset_ms(wall) {
        Some(offset) => wall - offset,
        None => wall,
    }
}

#[cfg(windows)]
fn local_offset_ms(wall: f64) -> Option<f64> {
    use windows::Win32::Foundation::SYSTEMTIME;
    use windows::Win32::System::Time::TzSpecificLocalTimeToSystemTime;
    let ms = wall as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    if !(1601..=30827).contains(&y) {
        return None;
    }
    let local = SYSTEMTIME {
        wYear: y as u16,
        wMonth: m as u16,
        wDayOfWeek: 0,
        wDay: d as u16,
        wHour: (rem / 3_600_000) as u16,
        wMinute: ((rem / 60_000) % 60) as u16,
        wSecond: ((rem / 1000) % 60) as u16,
        wMilliseconds: (rem % 1000) as u16,
    };
    let mut utc = SYSTEMTIME::default();
    // SAFETY: both pointers are to live SYSTEMTIME values; a null zone means the current one.
    unsafe { TzSpecificLocalTimeToSystemTime(None, &local, &mut utc) }.ok()?;
    let utc_ms = (days_from_civil(i64::from(utc.wYear), i64::from(utc.wMonth), i64::from(utc.wDay)) * 86_400_000
        + i64::from(utc.wHour) * 3_600_000
        + i64::from(utc.wMinute) * 60_000
        + i64::from(utc.wSecond) * 1000
        + i64::from(utc.wMilliseconds)) as f64;
    Some(wall.trunc() - utc_ms)
}

#[cfg(unix)]
fn local_offset_ms(wall: f64) -> Option<f64> {
    let ms = wall as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    // SAFETY: tm is zeroed and filled before mktime reads it.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = (y - 1900) as libc::c_int;
    tm.tm_mon = (m - 1) as libc::c_int;
    tm.tm_mday = d as libc::c_int;
    tm.tm_hour = (rem / 3_600_000) as libc::c_int;
    tm.tm_min = ((rem / 60_000) % 60) as libc::c_int;
    tm.tm_sec = ((rem / 1000) % 60) as libc::c_int;
    tm.tm_isdst = -1;
    // SAFETY: tm is a valid struct.
    let t = unsafe { libc::mktime(&mut tm) };
    if t == -1 {
        return None;
    }
    let utc_ms = t as f64 * 1000.0 + (rem % 1000) as f64;
    Some(wall.trunc() - utc_ms)
}

#[cfg(not(any(windows, unix)))]
fn local_offset_ms(_wall: f64) -> Option<f64> {
    None
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_strings_in_utc() {
        assert_eq!(parse("2026-10-20T08:00:00.500Z"), 1_792_483_200_500.0);
        assert_eq!(parse("2026-10-20T08:00:00Z"), 1_792_483_200_000.0);
        assert_eq!(parse("2026-10-20"), 1_792_454_400_000.0);
        assert_eq!(parse("2026-10-20T10:00:00+02:00"), 1_792_483_200_000.0);
        assert_eq!(parse("2026-10-20T10:00:00+0200"), 1_792_483_200_000.0);
        assert_eq!(parse("2026-10-20T08:00:00.5Z"), 1_792_483_200_500.0);
        assert_eq!(parse("2026-10-20T08:00:00.123456Z"), 1_792_483_200_123.0);
        assert_eq!(parse("2026-02-30"), parse("2026-03-02"));
        assert_eq!(parse("2026-10-20T24:00:00Z"), parse("2026-10-21T00:00:00Z"));
        assert!(parse("2026-10-20T24:01:00Z").is_nan());
        assert!(parse("2026-13-01").is_nan());
        assert!(parse("2026-10-20T08:00:00Zx").is_nan());
        assert!(parse("").is_nan());
        assert!(parse("yesterday").is_nan());
    }

    #[test]
    fn local_forms_use_the_os_zone() {
        let utc = parse("2026-10-20T08:00:00Z");
        let local = parse("2026-10-20T08:00:00");
        assert!(local.is_finite());
        assert!((utc - local).abs() <= 14.0 * 3_600_000.0);
        assert_eq!(parse("2026-10-20 08:00:00"), local);
        assert_eq!(parse("2026-10-20 08:00:00Z"), utc);
    }
}
