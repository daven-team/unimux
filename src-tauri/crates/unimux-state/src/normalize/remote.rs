//! SSH hosts and identities (shared/ssh.ts, shared/sshIdentity.ts), an SSH cell's reference, the remembered SFTP places
//! (shared/sftpView.ts) and the saved database connections with their folder colours (shared/db.ts).

use super::js;
use super::settings::is_ssh_theme;
use serde_json::{Map, Value, json};

fn clip(text: &str, max: usize) -> String {
    if js::len16(text) > max { js::slice16(text, max) } else { text.to_string() }
}

/// `stamp(v)`: a non-negative number, else 0.
fn stamp(v: Option<&Value>) -> Value {
    match js::number(v) {
        Some(n) if n >= 0.0 => v.cloned().unwrap_or(Value::from(0)),
        _ => Value::from(0),
    }
}

/// `normalizeAddress`: trimmed, without the brackets of an IPv6 literal, lower-cased.
pub fn normalize_address(raw: &str) -> String {
    let t = js::trim(raw);
    let inner =
        t.strip_prefix('[').and_then(|s| s.strip_suffix(']')).filter(|s| !s.chars().any(js::is_line_terminator)).unwrap_or(t);
    inner.to_lowercase()
}

/// `addressProblem(address) === null`.
pub fn address_ok(a: &str) -> bool {
    if a.is_empty() || js::len16(a) > 253 || js::has_space(a) || js::has_control(a) || a.starts_with('-') {
        return false;
    }
    // /^[^:]+:\d+$/: a port in the address.
    if let Some((host, port)) = a.rsplit_once(':')
        && !host.is_empty()
        && !host.contains(':')
        && !port.is_empty()
        && port.bytes().all(|b| b.is_ascii_digit())
    {
        return false;
    }
    if a.contains(':') {
        if a.matches(':').count() < 2 {
            return false;
        }
        // /^[0-9a-f:.]+(%[\w.-]+)?$/
        let (main, zone) = match a.split_once('%') {
            Some((m, z)) => (m, Some(z)),
            None => (a, None),
        };
        let main_ok =
            !main.is_empty() && main.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b':' || b == b'.');
        let zone_ok = zone
            .is_none_or(|z| !z.is_empty() && z.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-'));
        return main_ok && zone_ok;
    }
    a.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'.' || b == b'_' || b == b'-')
}

fn valid_username(u: &str) -> bool {
    let n = js::len16(u);
    (1..=64).contains(&n) && !js::has_space(u) && !js::has_control(u)
}

fn normalize_tags(raw: Option<&Value>) -> Vec<Value> {
    let mut out: Vec<String> = Vec::new();
    let Some(list) = raw.and_then(Value::as_array) else { return vec![] };
    for v in list {
        let Some(s) = v.as_str() else { continue };
        let lower = js::trim(s).to_lowercase();
        // .replace(/\s+/g, '-')
        let mut tag = String::new();
        let mut in_space = false;
        for c in lower.chars() {
            if js::is_space(c) {
                if !in_space {
                    tag.push('-');
                }
                in_space = true;
            } else {
                tag.push(c);
                in_space = false;
            }
        }
        if tag.is_empty() || js::len16(&tag) > 24 || js::has_control(&tag) || out.contains(&tag) {
            continue;
        }
        out.push(tag);
        if out.len() == 8 {
            break;
        }
    }
    out.into_iter().map(Value::from).collect()
}

/// `startupProblem(text) === null`: at most 8 KiB, no control character but TAB, LF and CR.
fn startup_ok(text: &str) -> bool {
    js::len16(text) <= 8192
        && !text.chars().any(|c| matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'))
}

fn normalize_ssh_host(raw: &Value) -> Option<Value> {
    let r = raw.as_object()?;
    if !js::is_uuid(r.get("id")) {
        return None;
    }
    let address = normalize_address(js::string(r.get("address"))?);
    let username = js::trim(js::string(r.get("username"))?).to_string();
    if !address_ok(&address) || !valid_username(&username) {
        return None;
    }
    let label = match js::string(r.get("label")) {
        Some(l) if !js::trim(l).is_empty() && !js::has_control(l) => clip(js::trim(l), 80),
        _ => address.clone(),
    };
    let port = match js::integer(r.get("port")) {
        Some(p) if (1.0..=65535.0).contains(&p) => r["port"].clone(),
        _ => Value::from(22),
    };
    let mut h = Map::new();
    h.insert("id".into(), r["id"].clone());
    h.insert("label".into(), Value::from(label));
    h.insert("address".into(), Value::from(address));
    h.insert("port".into(), port);
    h.insert("username".into(), Value::from(username));
    h.insert("createdAt".into(), stamp(r.get("createdAt")));
    h.insert("updatedAt".into(), stamp(r.get("updatedAt")));
    let group = js::string(r.get("group")).map(|g| clip(js::trim(g), 60)).unwrap_or_default();
    if !group.is_empty() && !js::has_control(&group) {
        h.insert("group".into(), Value::from(group));
    }
    let tags = normalize_tags(r.get("tags"));
    if !tags.is_empty() {
        h.insert("tags".into(), Value::Array(tags));
    }
    for k in ["keyId", "identityId"] {
        if js::is_uuid(r.get(k)) {
            h.insert(k.into(), r[k].clone());
        }
    }
    if let Some(s) = js::string(r.get("startupCommand"))
        && !js::trim(s).is_empty()
        && startup_ok(s)
    {
        h.insert("startupCommand".into(), Value::from(s));
    }
    if let Some(c) = js::string(r.get("color")).filter(|c| js::is_hex_color(c)) {
        h.insert("color".into(), Value::from(c));
    }
    if js::is_true(r.get("reconnectOnStart")) {
        h.insert("reconnectOnStart".into(), Value::Bool(true));
    }
    if js::is_true(r.get("sftpSudo")) {
        h.insert("sftpSudo".into(), Value::Bool(true));
    }
    if let Some(s) = js::string(r.get("sftpCommand")) {
        let t = js::trim(s);
        if !t.is_empty() && js::len16(t) <= 512 && !js::has_control(t) {
            h.insert("sftpCommand".into(), Value::from(t));
        }
    }
    if is_ssh_theme(r.get("theme")) {
        h.insert("theme".into(), r["theme"].clone());
    }
    Some(Value::Object(h))
}

/// A list of unique items (by id) of at most `limit`.
fn unique_by_id(raw: Option<&Value>, limit: usize, one: impl Fn(&Value) -> Option<Value>) -> Value {
    let Some(list) = raw.and_then(Value::as_array) else { return json!([]) };
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for entry in list {
        let Some(item) = one(entry) else { continue };
        let id = item["id"].as_str().unwrap_or_default().to_string();
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        out.push(item);
        if out.len() >= limit {
            break;
        }
    }
    Value::Array(out)
}

pub fn normalize_ssh_hosts(raw: Option<&Value>) -> Value {
    unique_by_id(raw, 500, normalize_ssh_host)
}

fn normalize_ssh_identity(raw: &Value) -> Option<Value> {
    let r = raw.as_object()?;
    if !js::is_uuid(r.get("id")) {
        return None;
    }
    let username = js::trim(js::string(r.get("username"))?).to_string();
    if !valid_username(&username) {
        return None;
    }
    let label = match js::string(r.get("label")) {
        Some(l) if !js::trim(l).is_empty() && !js::has_control(l) => js::slice16(js::trim(l), 80),
        _ => username.clone(),
    };
    let mut i = Map::new();
    i.insert("id".into(), r["id"].clone());
    i.insert("label".into(), Value::from(label));
    i.insert("username".into(), Value::from(username));
    i.insert("createdAt".into(), stamp(r.get("createdAt")));
    i.insert("updatedAt".into(), stamp(r.get("updatedAt")));
    if js::is_uuid(r.get("keyId")) {
        i.insert("keyId".into(), r["keyId"].clone());
    }
    Some(Value::Object(i))
}

pub fn normalize_ssh_identities(raw: Option<&Value>) -> Value {
    unique_by_id(raw, 200, normalize_ssh_identity)
}

/// `keepableCwd`: an absolute POSIX folder of a sane length without control characters or backslashes.
fn keepable_cwd(v: Option<&Value>) -> bool {
    js::string(v).is_some_and(|s| {
        s.starts_with('/') && js::len16(s) <= 1024 && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}' || c == '\\')
    })
}

/// `normalizeSshCellRef`: `{ hostId, cwd?, resume? }` or None.
pub fn normalize_ssh_cell_ref(raw: Option<&Value>) -> Option<Value> {
    if !js::object_like(raw) {
        return None;
    }
    let host = js::get(raw, "hostId").filter(|h| h.is_string())?;
    let mut out = Map::new();
    out.insert("hostId".into(), host.clone());
    if keepable_cwd(js::get(raw, "cwd")) {
        out.insert("cwd".into(), js::get(raw, "cwd").cloned().unwrap_or(Value::Null));
    }
    if js::is_true(js::get(raw, "resume")) {
        out.insert("resume".into(), Value::Bool(true));
    }
    Some(Value::Object(out))
}

/// `validLocalPath`: an absolute local path the app may remember.
fn valid_local_path(v: Option<&Value>) -> bool {
    js::string(v).is_some_and(|p| {
        let n = js::len16(p);
        let b = p.as_bytes();
        n > 0
            && n <= 4096
            && !p.chars().any(|c| c <= '\u{1f}')
            && (p.starts_with('/')
                || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\')
                || p.starts_with("\\\\"))
    })
}

/// `validRemotePath`.
pub fn valid_remote_path(v: Option<&Value>) -> bool {
    js::string(v).is_some_and(|p| p.starts_with('/') && js::len16(p) <= 4096 && !p.contains(['\0', '\r', '\n', '\\']))
}

/// `posixNormalize`.
fn posix_normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if !out.is_empty() && out.last() != Some(&"..") {
                out.pop();
            } else if !absolute {
                out.push("..");
            }
            continue;
        }
        out.push(part);
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}

/// `/^[\w-]{1,64}$/`.
fn is_host_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `normalizeSftpPlaces`: the last local folder and the last remote folder per host (the newest 200).
pub fn normalize_sftp_places(raw: Option<&Value>) -> Value {
    let mut out = Map::new();
    let r = js::record(raw);
    if let Some(r) = r
        && valid_local_path(r.get("localPath"))
    {
        out.insert("localPath".into(), r["localPath"].clone());
    }
    let mut remote = Map::new();
    if let Some(paths) = r.and_then(|r| r.get("remotePaths")).and_then(Value::as_object) {
        let kept: Vec<(&String, &Value)> =
            paths.iter().filter(|(k, v)| is_host_key(k) && k.as_str() != "__proto__" && valid_remote_path(Some(v))).collect();
        for (k, v) in js::last_n(&kept, 200) {
            remote.insert(k.clone(), Value::from(posix_normalize(v.as_str().unwrap_or_default())));
        }
    }
    // defaultSftpPlaces() is { remotePaths: {} }; localPath goes after it.
    let mut placed = Map::new();
    placed.insert("remotePaths".into(), js::js_object(remote));
    if let Some(l) = out.remove("localPath") {
        placed.insert("localPath".into(), l);
    }
    Value::Object(placed)
}

// ── databases ──────────────────────────────────────────────────────────────

fn is_port(v: Option<&Value>) -> bool {
    js::integer(v).is_some_and(|p| (1.0..=65535.0).contains(&p))
}

fn clean_text(v: Option<&Value>, max: usize) -> Option<String> {
    let t = js::trim(js::string(v)?);
    (!t.is_empty() && js::len16(t) <= max && !js::has_control(t)).then(|| t.to_string())
}

fn valid_host(v: Option<&Value>) -> Option<String> {
    let a = normalize_address(js::string(v)?);
    address_ok(&a).then_some(a)
}

fn valid_database(v: Option<&Value>) -> bool {
    js::string(v).is_some_and(|s| (1..=64).contains(&js::len16(s)) && !js::has_control(s))
}

fn valid_db_file_path(v: Option<&Value>) -> bool {
    js::string(v).is_some_and(|s| {
        let b = s.as_bytes();
        let n = js::len16(s);
        let start = (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
            || (b.len() >= 3 && b[0] == b'\\' && b[1] == b'\\' && !matches!(b[2], b'\\' | b'/'))
            || s.starts_with('/');
        (2..=4096).contains(&n) && !js::has_control(s) && js::trim(s) == s && start && !s.ends_with(['\\', '/'])
    })
}

fn put_color_group(c: &mut Map<String, Value>, r: &Map<String, Value>) {
    if let Some(color) = js::string(r.get("color")).filter(|s| js::is_hex_color(s)) {
        c.insert("color".into(), Value::from(color));
    }
    if let Some(g) = clean_text(r.get("group"), 60) {
        c.insert("group".into(), Value::from(g));
    }
}

fn normalize_sqlite(r: &Map<String, Value>) -> Option<Value> {
    if !valid_db_file_path(r.get("path")) {
        return None;
    }
    let path = r["path"].as_str().unwrap_or_default();
    let base = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let name = clean_text(r.get("name"), 80).unwrap_or_else(|| clip(base, 80));
    let mut c = Map::new();
    c.insert("id".into(), r["id"].clone());
    c.insert("kind".into(), Value::from("sqlite"));
    c.insert("name".into(), Value::from(name));
    c.insert("host".into(), Value::from(""));
    c.insert("port".into(), Value::from(0));
    c.insert("user".into(), Value::from(""));
    c.insert("tls".into(), Value::from("disable"));
    c.insert("ssh".into(), Value::Null);
    c.insert("readOnly".into(), Value::Bool(js::is_true(r.get("readOnly"))));
    c.insert("path".into(), Value::from(path));
    c.insert("createdAt".into(), stamp(r.get("createdAt")));
    c.insert("updatedAt".into(), stamp(r.get("updatedAt")));
    put_color_group(&mut c, r);
    Some(Value::Object(c))
}

fn normalize_db_connection(raw: &Value) -> Option<Value> {
    let r = raw.as_object()?;
    let kind = js::string(r.get("kind")).filter(|k| ["postgres", "mysql", "redis", "sqlite"].contains(k))?;
    if !js::is_uuid(r.get("id")) {
        return None;
    }
    if kind == "sqlite" {
        return normalize_sqlite(r);
    }
    let host = valid_host(r.get("host"))?;
    let user = js::string(r.get("user")).map(js::trim).unwrap_or("");
    let user_ok = js::len16(user) <= 128 && !js::has_control(user) && js::trim(user) == user;
    if !user_ok || (kind != "redis" && user.is_empty()) {
        return None;
    }
    let default_port = match kind {
        "postgres" => 5432,
        "mysql" => 3306,
        _ => 6379,
    };
    let tls = js::string(r.get("tls"))
        .filter(|t| ["disable", "prefer", "require", "verify-full"].contains(t))
        .unwrap_or(if kind == "redis" { "disable" } else { "prefer" });
    let mut c = Map::new();
    c.insert("id".into(), r["id"].clone());
    c.insert("kind".into(), Value::from(kind));
    c.insert("name".into(), Value::from(clean_text(r.get("name"), 80).unwrap_or_else(|| host.clone())));
    c.insert("host".into(), Value::from(host));
    c.insert("port".into(), if is_port(r.get("port")) { r["port"].clone() } else { Value::from(default_port) });
    c.insert("user".into(), Value::from(user));
    c.insert("tls".into(), Value::from(tls));
    c.insert("ssh".into(), Value::Null);
    c.insert("readOnly".into(), Value::Bool(js::is_true(r.get("readOnly"))));
    c.insert("createdAt".into(), stamp(r.get("createdAt")));
    c.insert("updatedAt".into(), stamp(r.get("updatedAt")));
    put_color_group(&mut c, r);
    match kind {
        "postgres" => {
            let db = if valid_database(r.get("database")) { r["database"].clone() } else { Value::from("postgres") };
            c.insert("database".into(), db);
        }
        "mysql" => {
            if valid_database(r.get("database")) {
                c.insert("database".into(), r["database"].clone());
            }
            if let Some(f) = js::string(r.get("flavor")).filter(|f| *f == "mysql" || *f == "mariadb") {
                c.insert("flavor".into(), Value::from(f));
            }
        }
        _ => {
            let idx = match js::integer(r.get("dbIndex")) {
                Some(n) if (0.0..=10_000.0).contains(&n) => r["dbIndex"].clone(),
                _ => Value::from(0),
            };
            c.insert("dbIndex".into(), idx);
        }
    }
    if tls == "verify-full" {
        let ok = js::string(r.get("caPath")).is_some_and(|s| (1..=4096).contains(&js::len16(s)) && !js::has_control(s));
        if !ok {
            return None;
        }
        c.insert("caPath".into(), r["caPath"].clone());
    }
    match r.get("ssh") {
        None | Some(Value::Null) => {}
        Some(Value::Object(ssh)) => {
            if !js::is_uuid(ssh.get("hostId")) || !is_port(ssh.get("dbPort")) {
                return None;
            }
            let db_host = valid_host(ssh.get("dbHost"))?;
            c.insert("ssh".into(), json!({"hostId": ssh["hostId"], "dbHost": db_host, "dbPort": ssh["dbPort"]}));
        }
        Some(_) => return None,
    }
    if kind != "redis"
        && let Some(ms) = js::integer(r.get("statementTimeoutMs"))
        && ms > 0.0
        && ms <= 86_400_000.0
    {
        c.insert("statementTimeoutMs".into(), r["statementTimeoutMs"].clone());
    }
    Some(Value::Object(c))
}

pub fn normalize_db_connections(raw: Option<&Value>) -> Value {
    unique_by_id(raw, 500, normalize_db_connection)
}

/// `normalizeDbGroupColors(raw, connections)`: colours of folders that hold a connection; a state from before 1.0.3 (`raw`
/// undefined) takes the first coloured connection of each folder. Names Object.prototype has (`out[name]` finds them) never get one.
pub fn normalize_db_group_colors(raw: Option<&Value>, connections: &Value) -> Value {
    let list = connections.as_array().map(Vec::as_slice).unwrap_or_default();
    let groups: Vec<&str> =
        list.iter().filter_map(|c| c.get("group").and_then(Value::as_str)).filter(|g| !g.is_empty()).collect();
    let mut out = Map::new();
    match raw {
        None => {
            for c in list {
                let (Some(g), Some(color)) = (js::string(c.get("group")), js::string(c.get("color"))) else { continue };
                if g.is_empty() || color.is_empty() || js::is_proto_key(g) || out.contains_key(g) {
                    continue;
                }
                out.insert(g.into(), Value::from(color));
            }
        }
        Some(Value::Object(o)) => {
            for (name, color) in o {
                if groups.contains(&name.as_str()) && color.as_str().is_some_and(js::is_hex_color) && name != "__proto__" {
                    out.insert(name.clone(), color.clone());
                }
            }
        }
        Some(_) => {}
    }
    js::js_object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        for ok in ["example.com", "10.0.0.1", "::1", "fe80::1%eth0", "a_b-c.d"] {
            assert!(address_ok(ok), "{ok}");
        }
        for bad in ["", "host:22", "-x", "a b", "Example", "1:2:g", "fe80::1%", "a:b"] {
            assert!(!address_ok(bad), "{bad}");
        }
        assert_eq!(normalize_address(" [FE80::1] "), "fe80::1");
        assert_eq!(normalize_address("\u{212a}.com"), "k.com");
    }

    #[test]
    fn group_colors_skip_prototype_names() {
        let conns = json!([{"group": "constructor", "color": "#aaaaaa"}, {"group": "a", "color": "#bbbbbb"}, {"group": "a", "color": "#cccccc"}]);
        assert_eq!(normalize_db_group_colors(None, &conns), json!({"a": "#bbbbbb"}));
        let raw = json!({"constructor": "#111111", "__proto__": "#222222", "zz": "#333333"});
        let conns = json!([{"group": "constructor"}, {"group": "__proto__"}]);
        assert_eq!(normalize_db_group_colors(Some(&raw), &conns), json!({"constructor": "#111111"}));
    }
}
