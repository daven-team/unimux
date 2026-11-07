//! Canonical folder spellings on REAL folders against the TS reference (PLAN G1 acceptance): a lab with 8.3 short names, a
//! junction (a symlink off Windows), a subst drive, missing children and odd case / slashes / prefixes. Every spelling goes to
//! src/main/gitPaths.ts through scripts/git-paths-golden.mjs (Node strips the types itself) and to the Rust port; the answers
//! must be identical, and the aliases must really resolve to one folder.
//!
//! The subst drive is created with `subst X: <lab folder>` and removed again (`subst X: /d`) when the test ends, even on a
//! failure; set UNIMUX_TEST_NO_SUBST=1 to leave it out. Nothing here opens a window.

#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use unimux_exec::{ExecOptions, Program};
use unimux_git::paths::{canonical_path, is_inside_path, normalize_spelling, realpath_native, relative_inside, same_path};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Runs the TS reference on the spellings; None when Node is not installed.
fn ts_answers(lab: &Path, paths: &[String], pairs: &[(String, String)]) -> Option<Value> {
    let input = lab.join("golden-input.json");
    std::fs::write(&input, json!({ "paths": paths, "pairs": pairs }).to_string()).unwrap();
    let script = repo_root().join("scripts/git-paths-golden.mjs");
    let program = Program::Args { program: "node".into(), args: vec![script.into(), input.into()] };
    let out = match unimux_exec::run(
        &program,
        &ExecOptions { timeout: Duration::from_secs(60), max_output: 16 * 1024 * 1024, ..Default::default() },
    ) {
        Ok(out) => out,
        Err(unimux_exec::ExecError::Spawn { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => panic!("node: {e}"),
    };
    assert!(out.ok(), "node failed: {}", String::from_utf8_lossy(&out.stderr));
    Some(serde_json::from_slice(&out.stdout).expect("node answer"))
}

#[cfg(windows)]
fn short_spelling(path: &Path) -> Option<String> {
    let mut env: HashMap<OsString, OsString> = unimux_exec::clean_process_env();
    env.insert("MC_SHORT_SOURCE".into(), path.as_os_str().to_owned());
    let program =
        Program::Raw { program: "cmd.exe".into(), raw: r#"/d /s /c "for %I in ("%MC_SHORT_SOURCE%") do @echo %~sI""#.into() };
    let out = unimux_exec::run(&program, &ExecOptions { env: Some(env), ..Default::default() }).ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let long = path.to_string_lossy();
    (!text.is_empty() && !text.eq_ignore_ascii_case(&long) && Path::new(&text).exists()).then_some(text)
}

/// A subst drive for the life of the test.
#[cfg(windows)]
struct Subst(char);

#[cfg(windows)]
impl Subst {
    fn create(target: &Path) -> Option<Self> {
        if std::env::var_os("UNIMUX_TEST_NO_SUBST").is_some() {
            return None;
        }
        let letter = ('M'..='Z').rev().find(|l| std::fs::metadata(format!("{l}:\\")).is_err())?;
        let program =
            Program::Args { program: "subst.exe".into(), args: vec![format!("{letter}:").into(), target.as_os_str().to_owned()] };
        let out = unimux_exec::run(&program, &ExecOptions::default()).ok()?;
        (out.ok() && Path::new(&format!("{letter}:\\")).exists()).then_some(Subst(letter))
    }
}

#[cfg(windows)]
impl Drop for Subst {
    fn drop(&mut self) {
        let program = Program::Args { program: "subst.exe".into(), args: vec![format!("{}:", self.0).into(), "/d".into()] };
        let _ = unimux_exec::run(&program, &ExecOptions::default());
    }
}

fn s(p: impl AsRef<Path>) -> String {
    p.as_ref().to_string_lossy().into_owned()
}

#[test]
fn canonical_paths_of_real_folders_match_the_ts_reference() {
    let tmp = tempfile::Builder::new().prefix("mc-spelling-rs-").tempdir().unwrap();
    let lab = PathBuf::from(realpath_native(&s(tmp.path())).unwrap());
    let long = lab.join("A Long Project Name");
    let sub = long.join("Packages").join("Application Name");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(long.join("a.txt"), "a").unwrap();
    let real = lab.join("real-target");
    std::fs::create_dir_all(real.join("inner")).unwrap();
    let link = lab.join("a-link");
    let dangling = lab.join("dangling-link");
    #[cfg(windows)]
    {
        junction::create(&real, &link).unwrap();
        std::fs::create_dir_all(lab.join("gone-target")).unwrap();
        junction::create(lab.join("gone-target"), &dangling).unwrap();
        std::fs::remove_dir(lab.join("gone-target")).unwrap();
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&real, &link).unwrap();
        std::os::unix::fs::symlink(lab.join("gone-target"), &dangling).unwrap();
    }

    let mut paths: Vec<String> = Vec::new();
    let mut pairs: Vec<(String, String)> = Vec::new();
    let long_s = s(&long);
    paths.extend([
        long_s.clone(),
        long_s.to_uppercase(),
        long_s.to_lowercase(),
        long_s.replace('\\', "/"),
        format!("{long_s}\\"),
        format!("{long_s}\\\\Packages\\\\"),
        format!(r"\\?\{long_s}"),
        s(long.join("a.txt")),
        s(long.join("missing child").join("deeper")),
        s(&sub),
        s(&link),
        s(link.join("inner")),
        s(link.join("sub").join("missing")),
        s(&dangling),
        s(dangling.join("x")),
        s(lab.join("nope").join("deeper")),
        s(&real),
    ]);
    pairs.extend([
        (s(&link), s(&real)),
        (s(&real), s(link.join("sub").join("missing"))),
        (long_s.clone(), s(&sub)),
        (long_s.to_uppercase(), s(&sub).to_lowercase()),
        (s(&sub), long_s.clone()),
        (long_s.clone(), format!("{long_s} 2")),
        (long_s.clone(), long_s.clone()),
    ]);

    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut aliases: Vec<(String, String, &str)> = vec![(s(&link), s(&real), if cfg!(windows) { "junction" } else { "symlink" })];
    #[cfg(windows)]
    let _subst = {
        paths.extend(["C:\\".to_string(), "c:".to_string(), "C:/Windows/../Windows".to_string()]);
        if let Some(short) = short_spelling(&long) {
            paths.extend([
                short.clone(),
                short.to_lowercase(),
                format!("{short}\\missing child\\deeper"),
                format!("{short}\\Packages"),
            ]);
            pairs.push((short.clone(), s(&sub)));
            pairs.push((short.clone(), long_s.clone()));
            aliases.push((short.clone(), long_s.clone(), "8.3 name"));
            if let Some(short_sub) = short_spelling(&sub) {
                paths.push(short_sub.clone());
                pairs.push((long_s.clone(), short_sub.clone()));
                aliases.push((short_sub, s(&sub), "8.3 name of a subfolder"));
            }
        } else {
            eprintln!("8.3 names are disabled on this volume: the short-name spellings are left out");
        }
        let subst = Subst::create(&long);
        if let Some(Subst(letter)) = &subst {
            let root = format!("{letter}:\\");
            paths.extend([
                root.clone(),
                format!("{letter}:"),
                format!("{}:/", letter.to_ascii_lowercase()),
                format!("{letter}:\\Packages\\Application Name"),
                format!("{letter}:\\missing\\x"),
                format!("{letter}:\\a.txt"),
            ]);
            pairs.push((root.clone(), long_s.clone()));
            pairs.push((long_s.clone(), format!("{letter}:\\Packages\\Application Name")));
            pairs.push((format!("{letter}:\\Packages"), s(&sub)));
            aliases.push((root, long_s.clone(), "subst drive"));
        } else {
            eprintln!("no subst drive (UNIMUX_TEST_NO_SUBST or no free letter): the subst spellings are left out");
        }
        subst
    };

    // the aliases really are one folder
    for (alias, target, what) in &aliases {
        assert!(same_path(alias, target), "{what}: {alias} vs {target}");
        assert_eq!(canonical_path(alias), canonical_path(target), "{what}");
    }

    let Some(ts) = ts_answers(&lab, &paths, &pairs) else {
        eprintln!("node is not installed: the TS comparison is skipped");
        return;
    };
    let mut bad = Vec::new();
    for p in &paths {
        let want = ts["canonical"][p].as_str().unwrap();
        let got = canonical_path(p);
        if got != want {
            bad.push(format!("canonical {p:?}: rust {got:?}, ts {want:?}"));
        }
        let want = ts["normalize"][p].as_str().unwrap();
        let got = normalize_spelling(p, cfg!(windows));
        if got != want {
            bad.push(format!("normalize {p:?}: rust {got:?}, ts {want:?}"));
        }
    }
    for (i, (a, b)) in pairs.iter().enumerate() {
        let want = &ts["pairs"][i];
        let got = json!({ "same": same_path(a, b), "inside": is_inside_path(a, b), "relative": relative_inside(a, b) });
        if &got != want {
            bad.push(format!("pair {a:?} / {b:?}: rust {got}, ts {want}"));
        }
    }
    assert!(bad.is_empty(), "{} differences:\n{}", bad.len(), bad.join("\n"));
    let kinds: Vec<&str> = aliases.iter().map(|(_, _, what)| *what).collect();
    eprintln!("{} spellings and {} pairs equal to the TS reference; aliases resolved: {kinds:?}", paths.len(), pairs.len());
}
