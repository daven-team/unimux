//! Local wall-clock time of the OS time zone (JavaScript's `Date` getters: `getHours`, `toDateString`, ...), without a date
//! crate: Windows asks `SystemTimeToTzSpecificLocalTime` / `TzSpecificLocalTimeToSystemTime`, Unix `localtime_r` /
//! `mktime`. A time the OS cannot convert is taken as UTC.

/// The local calendar fields of one instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i64,
    /// 1 to 12.
    pub month: u32,
    /// 1 to 31.
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// 0 = Sunday (`getDay`).
    pub weekday: u32,
}

impl LocalTime {
    /// `toDateString()` equality: the same local calendar day.
    pub fn same_day(&self, other: &LocalTime) -> bool {
        (self.year, self.month, self.day) == (other.year, other.month, other.day)
    }
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar (Howard Hinnant's algorithm).
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
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

/// (year, month, day) to days since 1970-01-01.
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The fields of `ms` read as UTC (also the fallback when the OS cannot convert).
pub fn utc_fields(ms: f64) -> LocalTime {
    let ms = ms as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    LocalTime {
        year,
        month,
        day,
        hour: (rem / 3_600_000) as u32,
        minute: ((rem / 60_000) % 60) as u32,
        weekday: (days + 4).rem_euclid(7) as u32,
    }
}

/// The local fields of the instant `ms` (epoch milliseconds).
pub fn local_fields(ms: f64) -> LocalTime {
    if !ms.is_finite() {
        return utc_fields(0.0);
    }
    match local_offset_at(ms) {
        Some(offset) => utc_fields(ms + offset),
        None => utc_fields(ms),
    }
}

/// A local wall-clock time (ms as if UTC) to the instant, with the OS rules for that date.
pub fn local_to_utc(wall: f64) -> f64 {
    if !wall.is_finite() {
        return f64::NAN;
    }
    match offset_of_wall(wall) {
        Some(offset) => wall - offset,
        None => wall,
    }
}

#[cfg(windows)]
fn systemtime_of(ms: i64) -> Option<windows::Win32::Foundation::SYSTEMTIME> {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    if !(1601..=30827).contains(&y) {
        return None;
    }
    Some(windows::Win32::Foundation::SYSTEMTIME {
        wYear: y as u16,
        wMonth: m as u16,
        wDayOfWeek: 0,
        wDay: d as u16,
        wHour: (rem / 3_600_000) as u16,
        wMinute: ((rem / 60_000) % 60) as u16,
        wSecond: ((rem / 1000) % 60) as u16,
        wMilliseconds: (rem % 1000) as u16,
    })
}

#[cfg(windows)]
fn ms_of(t: &windows::Win32::Foundation::SYSTEMTIME) -> f64 {
    (days_from_civil(i64::from(t.wYear), i64::from(t.wMonth), i64::from(t.wDay)) * 86_400_000
        + i64::from(t.wHour) * 3_600_000
        + i64::from(t.wMinute) * 60_000
        + i64::from(t.wSecond) * 1000
        + i64::from(t.wMilliseconds)) as f64
}

/// Local minus UTC at the instant `ms`.
#[cfg(windows)]
fn local_offset_at(ms: f64) -> Option<f64> {
    use windows::Win32::System::Time::SystemTimeToTzSpecificLocalTime;
    let utc = systemtime_of(ms as i64)?;
    let mut local = windows::Win32::Foundation::SYSTEMTIME::default();
    // SAFETY: both pointers are to live SYSTEMTIME values; no zone means the current one.
    unsafe { SystemTimeToTzSpecificLocalTime(None, &utc, &mut local) }.ok()?;
    Some(ms_of(&local) - ms_of(&utc))
}

/// Local minus UTC for the local wall-clock time `wall`.
#[cfg(windows)]
fn offset_of_wall(wall: f64) -> Option<f64> {
    use windows::Win32::System::Time::TzSpecificLocalTimeToSystemTime;
    let local = systemtime_of(wall as i64)?;
    let mut utc = windows::Win32::Foundation::SYSTEMTIME::default();
    // SAFETY: both pointers are to live SYSTEMTIME values; no zone means the current one.
    unsafe { TzSpecificLocalTimeToSystemTime(None, &local, &mut utc) }.ok()?;
    Some(ms_of(&local) - ms_of(&utc))
}

#[cfg(unix)]
fn local_offset_at(ms: f64) -> Option<f64> {
    let t = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: tm is zeroed and filled by localtime_r, which only reads `t`.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::localtime_r(&t, &mut tm) };
    if r.is_null() {
        return None;
    }
    Some(tm.tm_gmtoff as f64 * 1000.0)
}

#[cfg(unix)]
fn offset_of_wall(wall: f64) -> Option<f64> {
    let f = utc_fields(wall);
    let rem = (wall as i64).rem_euclid(60_000);
    // SAFETY: tm is zeroed and filled before mktime reads it.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = (f.year - 1900) as libc::c_int;
    tm.tm_mon = (f.month - 1) as libc::c_int;
    tm.tm_mday = f.day as libc::c_int;
    tm.tm_hour = f.hour as libc::c_int;
    tm.tm_min = f.minute as libc::c_int;
    tm.tm_sec = (rem / 1000) as libc::c_int;
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
fn local_offset_at(_ms: f64) -> Option<f64> {
    None
}

#[cfg(not(any(windows, unix)))]
fn offset_of_wall(_wall: f64) -> Option<f64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_fields_and_weekdays() {
        // 2026-11-06 (a Friday) 12:30 UTC.
        let f = utc_fields(1_793_968_200_000.0);
        assert_eq!((f.year, f.month, f.day, f.hour, f.minute, f.weekday), (2026, 11, 6, 12, 30, 5));
        assert_eq!(utc_fields(0.0).weekday, 4);
        assert_eq!(days_from_civil(2026, 11, 6), 20_763);
    }

    #[test]
    fn local_round_trip() {
        let at = 1_793_968_200_000.0;
        let f = local_fields(at);
        let wall = (days_from_civil(f.year, i64::from(f.month), i64::from(f.day)) * 86_400_000
            + i64::from(f.hour) * 3_600_000
            + i64::from(f.minute) * 60_000) as f64;
        assert_eq!(local_to_utc(wall), at);
    }
}
