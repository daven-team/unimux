//! The Windows command line of a pty child, built exactly like node-pty 1.1.0 (`argsToCommandLine` in windowsPtyAgent.js),
//! so a shell or agent CLI started by 1.2.0 sees the same argv as under 1.1.4.

/// `file` and `args` joined with node-pty's quoting: an argument is quoted when it is empty, or contains a space or a tab
/// and is longer than one character and not already enclosed in quotes on both ends; quotes inside are escaped with
/// backslashes, and backslashes in front of a quote (or the closing quote) are doubled.
pub fn args_to_command_line(file: &str, args: &[String]) -> String {
    let mut result = String::new();
    let argv = std::iter::once(file).chain(args.iter().map(String::as_str));
    for (index, arg) in argv.enumerate() {
        if index > 0 {
            result.push(' ');
        }
        let chars: Vec<char> = arg.chars().collect();
        // JS: arg[0] / arg[arg.length - 1] are undefined for '' (never equal to '"').
        let first_quote = chars.first() == Some(&'"');
        let last_quote = chars.last() == Some(&'"');
        let lopsided = first_quote != last_quote;
        let no_enclosing = !first_quote && !last_quote;
        // `arg.length` in JS counts UTF-16 units.
        let js_len: usize = chars.iter().map(|c| c.len_utf16()).sum();
        let quote = arg.is_empty() || ((arg.contains(' ') || arg.contains('\t')) && js_len > 1 && (lopsided || no_enclosing));
        if quote {
            result.push('"');
        }
        let mut backslashes = 0usize;
        for &c in &chars {
            if c == '\\' {
                backslashes += 1;
            } else if c == '"' {
                result.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                result.push('"');
                backslashes = 0;
            } else {
                result.extend(std::iter::repeat_n('\\', backslashes));
                backslashes = 0;
                result.push(c);
            }
        }
        if quote {
            result.extend(std::iter::repeat_n('\\', backslashes * 2));
            result.push('"');
        } else {
            result.extend(std::iter::repeat_n('\\', backslashes));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::args_to_command_line;
    use serde_json::Value;

    /// Golden cases written by node-pty 1.1.0 itself (scripts/sp5/cmdline-golden.cjs).
    #[test]
    fn matches_node_pty() {
        let rows: Value = serde_json::from_str(include_str!("../tests/fixtures/cmdline.json")).unwrap();
        for row in rows.as_array().unwrap() {
            let file = row["file"].as_str().unwrap();
            let args: Vec<String> = row["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
            assert_eq!(args_to_command_line(file, &args), row["line"].as_str().unwrap(), "{file} {args:?}");
        }
    }
}
