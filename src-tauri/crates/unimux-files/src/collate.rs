//! The file tree's name order: 1.1.4's `new Intl.Collator('pl', { numeric: true, sensitivity: 'base' })`, through ICU4X
//! (strength primary = sensitivity base, `kn` = numeric). Golden rows: test/golden/files-collate.jsonl (V8's order).

use std::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use icu_locale_core::locale;

fn collator() -> &'static CollatorBorrowed<'static> {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR.get_or_init(|| {
        let mut prefs = CollatorPreferences::from(&locale!("pl"));
        prefs.numeric_ordering = Some(CollationNumericOrdering::True);
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Primary);
        Collator::try_new(prefs, options).expect("the compiled collation data has Polish")
    })
}

/// `nameOrder.compare(a, b)`.
pub fn compare_names(a: &str, b: &str) -> Ordering {
    collator().compare(a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_case_insensitive_polish() {
        let mut names = vec!["file10.txt", "File2.txt", "b", "ą", "a", "z", "ż", "ź"];
        names.sort_by(|a, b| compare_names(a, b));
        assert_eq!(names, ["a", "ą", "b", "File2.txt", "file10.txt", "z", "ź", "ż"]);
        assert_eq!(compare_names("Abc", "abc"), Ordering::Equal);
    }
}
