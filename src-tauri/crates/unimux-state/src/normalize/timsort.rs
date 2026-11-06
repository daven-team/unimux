//! `Array.prototype.sort(comparefn)` as V8 runs it (third_party/v8/builtins/array-sort.tq): TimSort with binary insertion
//! for short runs, run merging by the stack invariants and galloping. The comparator answers a number like a JS comparefn
//! and NaN counts as +0 (SortCompare). An inconsistent comparator (damaged timestamps give NaN) then leaves the same order
//! 1.1.4 leaves, where `slice::sort_by` would order differently or panic on a non-total order.

const MIN_GALLOP: usize = 7;
const SHORT_ARRAY: usize = 8;

struct Sort<'a, T, F> {
    work: &'a mut [T],
    cmp: F,
    min_gallop: usize,
    runs: Vec<(usize, usize)>,
}

/// Sorts `items` in place the way V8 sorts an array with `comparefn` (`cmp(a, b) < 0` means a goes first).
pub fn sort_by<T: Clone, F: FnMut(&T, &T) -> f64>(items: &mut [T], mut cmp: F) {
    // SortCompare: "If v is NaN, return +0".
    let cmp = move |a: &T, b: &T| {
        let v = cmp(a, b);
        if v.is_nan() { 0.0 } else { v }
    };
    let length = items.len();
    if length < 2 {
        return;
    }
    let mut s = Sort { work: items, cmp, min_gallop: MIN_GALLOP, runs: Vec::new() };
    // V8 sorts fewer than 8 elements by binary insertion alone, without looking for a run first (measured on V8 14.6, the
    // comparator calls are those of BinaryInsertionSort(0, 0, length)).
    if length < SHORT_ARRAY {
        s.binary_insertion_sort(0, 0, length);
        return;
    }
    let mut remaining = length;
    let mut low = 0;
    let min_run = min_run_length(remaining);
    while remaining != 0 {
        let mut run = s.count_and_make_run(low, low + remaining);
        if run < min_run {
            let forced = min_run.min(remaining);
            s.binary_insertion_sort(low, low + run, low + forced);
            run = forced;
        }
        s.runs.push((low, run));
        s.merge_collapse();
        low += run;
        remaining -= run;
    }
    s.merge_force_collapse();
}

fn min_run_length(mut n: usize) -> usize {
    let mut r = 0;
    while n >= 64 {
        r |= n & 1;
        n >>= 1;
    }
    n + r
}

impl<T: Clone, F: FnMut(&T, &T) -> f64> Sort<'_, T, F> {
    fn less(&mut self, a: &T, b: &T) -> bool {
        (self.cmp)(a, b) < 0.0
    }

    fn binary_insertion_sort(&mut self, low: usize, start: usize, high: usize) {
        let mut start = if low == start { start + 1 } else { start };
        while start < high {
            let (mut left, mut right) = (low, start);
            let pivot = self.work[start].clone();
            while left < right {
                let mid = left + ((right - left) >> 1);
                let m = self.work[mid].clone();
                if self.less(&pivot, &m) {
                    right = mid;
                } else {
                    left = mid + 1;
                }
            }
            let mut p = start;
            while p > left {
                self.work[p] = self.work[p - 1].clone();
                p -= 1;
            }
            self.work[left] = pivot;
            start += 1;
        }
    }

    fn count_and_make_run(&mut self, low_arg: usize, high: usize) -> usize {
        let low = low_arg + 1;
        if low == high {
            return 1;
        }
        let mut run = 2;
        let element_low = self.work[low].clone();
        let element_pre = self.work[low - 1].clone();
        let descending = self.less(&element_low, &element_pre);
        let mut previous = element_low;
        for idx in low + 1..high {
            let current = self.work[idx].clone();
            let order = (self.cmp)(&current, &previous);
            // V8: descending breaks on `order >= 0`, ascending on `order < 0` (NaN continues both).
            if descending {
                if order >= 0.0 {
                    break;
                }
            } else if order < 0.0 {
                break;
            }
            previous = current;
            run += 1;
        }
        if descending {
            self.work[low_arg..low_arg + run].reverse();
        }
        run
    }

    fn invariant(&self, n: usize) -> bool {
        if n < 2 {
            return true;
        }
        self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1
    }

    fn merge_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.invariant(n + 1) || !self.invariant(n) {
                if self.runs[n - 1].1 < self.runs[n + 1].1 {
                    n -= 1;
                }
                self.merge_at(n);
            } else if self.runs[n].1 <= self.runs[n + 1].1 {
                self.merge_at(n);
            } else {
                break;
            }
        }
    }

    fn merge_force_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if n > 0 && self.runs[n - 1].1 < self.runs[n + 1].1 {
                n -= 1;
            }
            self.merge_at(n);
        }
    }

    fn merge_at(&mut self, i: usize) {
        let (mut base_a, mut length_a) = self.runs[i];
        let (base_b, mut length_b) = self.runs[i + 1];
        self.runs[i].1 = length_a + length_b;
        self.runs.remove(i + 1);
        let key_right = self.work[base_b].clone();
        let k = gallop_right(&mut self.cmp, self.work, &key_right, base_a, length_a, 0);
        base_a += k;
        length_a -= k;
        if length_a == 0 {
            return;
        }
        let key_left = self.work[base_a + length_a - 1].clone();
        length_b = gallop_left(&mut self.cmp, self.work, &key_left, base_b, length_b, length_b - 1);
        if length_b == 0 {
            return;
        }
        if length_a <= length_b {
            self.merge_low(base_a, length_a, base_b, length_b);
        } else {
            self.merge_high(base_a, length_a, base_b, length_b);
        }
    }

    fn merge_low(&mut self, base_a: usize, mut length_a: usize, base_b: usize, mut length_b: usize) {
        let temp: Vec<T> = self.work[base_a..base_a + length_a].to_vec();
        let mut dest = base_a;
        let mut cursor_temp = 0;
        let mut cursor_b = base_b;
        self.work[dest] = self.work[cursor_b].clone();
        dest += 1;
        cursor_b += 1;
        enum End {
            Succeed,
            CopyB,
        }
        let end = 'outer: {
            length_b -= 1;
            if length_b == 0 {
                break 'outer End::Succeed;
            }
            if length_a == 1 {
                break 'outer End::CopyB;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a = 0;
                let mut wins_b = 0;
                loop {
                    let b = self.work[cursor_b].clone();
                    if self.less(&b, &temp[cursor_temp]) {
                        self.work[dest] = b;
                        dest += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'outer End::Succeed;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[dest] = temp[cursor_temp].clone();
                        dest += 1;
                        cursor_temp += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'outer End::CopyB;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = self.work[cursor_b].clone();
                    wins_a = gallop_right(&mut self.cmp, &temp, &key, cursor_temp, length_a, 0);
                    if wins_a > 0 {
                        self.work[dest..dest + wins_a].clone_from_slice(&temp[cursor_temp..cursor_temp + wins_a]);
                        dest += wins_a;
                        cursor_temp += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'outer End::CopyB;
                        }
                        // An inconsistent comparator can empty run A here.
                        if length_a == 0 {
                            break 'outer End::Succeed;
                        }
                    }
                    self.work[dest] = self.work[cursor_b].clone();
                    dest += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'outer End::Succeed;
                    }
                    let key = temp[cursor_temp].clone();
                    wins_b = gallop_left(&mut self.cmp, self.work, &key, cursor_b, length_b, 0);
                    if wins_b > 0 {
                        for j in 0..wins_b {
                            self.work[dest + j] = self.work[cursor_b + j].clone();
                        }
                        dest += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'outer End::Succeed;
                        }
                    }
                    self.work[dest] = temp[cursor_temp].clone();
                    dest += 1;
                    cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'outer End::CopyB;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                if length_a > 0 {
                    self.work[dest..dest + length_a].clone_from_slice(&temp[cursor_temp..cursor_temp + length_a]);
                }
            }
            End::CopyB => {
                // The last element of run A belongs at the end of the merge.
                for j in 0..length_b {
                    self.work[dest + j] = self.work[cursor_b + j].clone();
                }
                self.work[dest + length_b] = temp[cursor_temp].clone();
            }
        }
    }

    fn merge_high(&mut self, base_a: usize, mut length_a: usize, base_b: usize, mut length_b: usize) {
        let temp: Vec<T> = self.work[base_b..base_b + length_b].to_vec();
        // Cursors run downwards and may step below 0 (V8 uses signed Smis): isize.
        let mut dest = (base_b + length_b - 1) as isize;
        let mut cursor_temp = length_b as isize - 1;
        let mut cursor_a = (base_a + length_a - 1) as isize;
        let w = |i: isize| i as usize;
        self.work[w(dest)] = self.work[w(cursor_a)].clone();
        dest -= 1;
        cursor_a -= 1;
        enum End {
            Succeed,
            CopyA,
        }
        let end = 'outer: {
            length_a -= 1;
            if length_a == 0 {
                break 'outer End::Succeed;
            }
            if length_b == 1 {
                break 'outer End::CopyA;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a = 0;
                let mut wins_b = 0;
                loop {
                    let a = self.work[w(cursor_a)].clone();
                    if self.less(&temp[w(cursor_temp)], &a) {
                        self.work[w(dest)] = a;
                        dest -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'outer End::Succeed;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[w(dest)] = temp[w(cursor_temp)].clone();
                        dest -= 1;
                        cursor_temp -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'outer End::CopyA;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = temp[w(cursor_temp)].clone();
                    let k = gallop_right(&mut self.cmp, self.work, &key, base_a, length_a, length_a - 1);
                    wins_a = length_a - k;
                    if wins_a > 0 {
                        dest -= wins_a as isize;
                        cursor_a -= wins_a as isize;
                        for j in (0..wins_a).rev() {
                            self.work[w(dest + 1) + j] = self.work[w(cursor_a + 1) + j].clone();
                        }
                        length_a -= wins_a;
                        if length_a == 0 {
                            break 'outer End::Succeed;
                        }
                    }
                    self.work[w(dest)] = temp[w(cursor_temp)].clone();
                    dest -= 1;
                    cursor_temp -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'outer End::CopyA;
                    }
                    let key = self.work[w(cursor_a)].clone();
                    let k = gallop_left(&mut self.cmp, &temp, &key, 0, length_b, length_b - 1);
                    wins_b = length_b - k;
                    if wins_b > 0 {
                        dest -= wins_b as isize;
                        cursor_temp -= wins_b as isize;
                        self.work[w(dest + 1)..w(dest + 1) + wins_b]
                            .clone_from_slice(&temp[w(cursor_temp + 1)..w(cursor_temp + 1) + wins_b]);
                        length_b -= wins_b;
                        if length_b == 1 {
                            break 'outer End::CopyA;
                        }
                        // An inconsistent comparator can empty run B here.
                        if length_b == 0 {
                            break 'outer End::Succeed;
                        }
                    }
                    self.work[w(dest)] = self.work[w(cursor_a)].clone();
                    dest -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'outer End::Succeed;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                if length_b > 0 {
                    let at = w(dest - (length_b as isize - 1));
                    self.work[at..at + length_b].clone_from_slice(&temp[..length_b]);
                }
            }
            End::CopyA => {
                dest -= length_a as isize;
                cursor_a -= length_a as isize;
                for j in (0..length_a).rev() {
                    self.work[w(dest + 1) + j] = self.work[w(cursor_a + 1) + j].clone();
                }
                self.work[w(dest)] = temp[w(cursor_temp)].clone();
            }
        }
    }
}

/// The leftmost position in `array[base..base + length]` where `key` can go (every element before it is less than `key`).
fn gallop_left<T, F: FnMut(&T, &T) -> f64>(cmp: &mut F, array: &[T], key: &T, base: usize, length: usize, hint: usize) -> usize {
    let mut last_ofs: usize = 0;
    let mut offset: usize = 1;
    let (mut lo, mut hi);
    if cmp(&array[base + hint], key) < 0.0 {
        let max_ofs = length - hint;
        while offset < max_ofs {
            if cmp(&array[base + hint + offset], key) >= 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        lo = last_ofs as isize + hint as isize;
        hi = offset as isize + hint as isize;
    } else {
        let max_ofs = hint + 1;
        while offset < max_ofs {
            if cmp(&array[base + hint - offset], key) < 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        lo = hint as isize - offset as isize;
        hi = hint as isize - last_ofs as isize;
    }
    lo += 1;
    while lo < hi {
        let m = lo + ((hi - lo) >> 1);
        if cmp(&array[base + m as usize], key) < 0.0 {
            lo = m + 1;
        } else {
            hi = m;
        }
    }
    hi as usize
}

/// The rightmost position in `array[base..base + length]` where `key` can go (no element after it is less than `key`).
fn gallop_right<T, F: FnMut(&T, &T) -> f64>(cmp: &mut F, array: &[T], key: &T, base: usize, length: usize, hint: usize) -> usize {
    let mut last_ofs: usize = 0;
    let mut offset: usize = 1;
    let (mut lo, mut hi);
    if cmp(key, &array[base + hint]) < 0.0 {
        let max_ofs = hint + 1;
        while offset < max_ofs {
            if cmp(key, &array[base + hint - offset]) >= 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        lo = hint as isize - offset as isize;
        hi = hint as isize - last_ofs as isize;
    } else {
        let max_ofs = length - hint;
        while offset < max_ofs {
            if cmp(key, &array[base + hint + offset]) < 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        lo = last_ofs as isize + hint as isize;
        hi = offset as isize + hint as isize;
    }
    lo += 1;
    while lo < hi {
        let m = lo + ((hi - lo) >> 1);
        if cmp(key, &array[base + m as usize]) < 0.0 {
            hi = m;
        } else {
            lo = m + 1;
        }
    }
    hi as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_like_a_stable_sort_for_a_consistent_comparator() {
        let mut seed = 7u64;
        for len in [0usize, 1, 2, 5, 31, 32, 33, 64, 65, 200, 1000, 5000] {
            let mut v: Vec<(i64, usize)> = (0..len)
                .map(|i| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    (((seed >> 33) % 50) as i64, i)
                })
                .collect();
            let mut want = v.clone();
            want.sort_by_key(|x| x.0);
            sort_by(&mut v, |a, b| (a.0 - b.0) as f64);
            assert_eq!(v, want, "len {len}");
        }
    }

    #[test]
    fn never_panics_on_nan() {
        let mut seed = 3u64;
        for len in 0..300usize {
            let mut v: Vec<f64> = (0..len)
                .map(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    if (seed >> 40).is_multiple_of(3) { f64::NAN } else { ((seed >> 33) % 1000) as f64 }
                })
                .collect();
            let n = v.len();
            sort_by(&mut v, |a, b| a - b);
            assert_eq!(v.len(), n);
        }
    }
}
