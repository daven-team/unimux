//! Shell integration against the 1.1.4 reference: the `withShellIntegration` and `encodePowerShell` rows of
//! test/golden/launch.jsonl (scripts/goldens-launch.mjs).

use std::path::PathBuf;

use serde_json::{Value, json};
use unimux_pty::shell::{Launch, Platform, ShellKind};
use unimux_pty::shell_integration::{encode_power_shell, with_shell_integration};

fn rows() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/golden/launch.jsonl");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    text.lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str(l).expect("golden row")).collect()
}

fn env_of(v: &Value) -> Vec<(String, String)> {
    v.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect()
}

#[test]
fn shell_integration_rows_answer_like_the_ts_reference() {
    let mut checked = 0;
    for row in rows() {
        let args = row["args"].as_array().unwrap();
        match row["fn"].as_str().unwrap() {
            "encodePowerShell" => {
                assert_eq!(encode_power_shell(args[0].as_str().unwrap()), row["out"].as_str().unwrap());
            }
            "withShellIntegration" => {
                let kind = ShellKind::parse(args[0].as_str().unwrap()).unwrap();
                let l = &args[1];
                let list: Vec<&str> = l["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
                let launch = Launch::new(l["file"].as_str().unwrap(), &list);
                let platform = match args[2]["platform"].as_str().unwrap() {
                    "win32" => Platform::Windows,
                    "darwin" => Platform::MacOs,
                    _ => Platform::Linux,
                };
                let out = with_shell_integration(kind, &launch, &env_of(&l["env"]), args[2]["dir"].as_str().unwrap(), platform);
                let env: serde_json::Map<String, Value> = out.env.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
                let files: serde_json::Map<String, Value> = out.files.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
                let got = json!({ "file": out.launch.file, "args": out.launch.args, "env": env, "files": files });
                // As text: the key order of the environment counts (PROMPT keeps its place).
                assert_eq!(got.to_string(), row["out"].to_string(), "{}", Value::Array(args.clone()));
            }
            _ => continue,
        }
        checked += 1;
    }
    assert!(checked > 70, "only {checked} rows checked");
}
