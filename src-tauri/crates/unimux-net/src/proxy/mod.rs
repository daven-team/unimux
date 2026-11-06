//! Which proxy a request takes, per URL, the way Chromium (and so Electron's `net.fetch` in 1.1.4) decides it:
//!
//! - requests to the machine itself (localhost, loopback and link-local addresses) never use a proxy (Chromium's implicit
//!   bypass rules, so the hook and MCP servers on 127.0.0.1 stay direct);
//! - Windows: the user's Internet Options (`WinHttpGetIEProxyConfigForCurrentUser`); "Automatically detect settings" (WPAD) and
//!   "Use setup script" (PAC) are evaluated by `WinHttpGetProxyForUrl`; when that fails the manual proxy (with its bypass list)
//!   applies, like Chromium's fallback; otherwise direct;
//! - macOS: `CFNetworkCopySystemProxySettings` + `CFNetworkCopyProxiesForURL`, PAC through
//!   `CFNetworkExecuteProxyAutoConfigurationURL` (compile-checked only, no Mac yet);
//! - a PAC answer is a list ("PROXY a:8080; SOCKS5 b:1080; DIRECT"); the client tries the entries in order while they cannot be
//!   reached, as Chromium does.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
pub mod windows;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use url::Url;

/// How the client talks to a proxy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProxyScheme {
    /// Plain HTTP proxy: absolute-form requests for http URLs, `CONNECT` tunnels for https URLs.
    Http,
    /// HTTP proxy reached over TLS (PAC `HTTPS host:port`).
    Https,
    /// SOCKS v4: the client resolves the name itself (as Chromium does).
    Socks4,
    /// SOCKS v5 without authentication, the name is resolved by the proxy.
    Socks5,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ProxyServer {
    pub scheme: ProxyScheme,
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ProxyChoice {
    Direct,
    Proxy(ProxyServer),
}

/// Decides the proxy list for one URL. `resolve` may block (WinHTTP downloads and runs PAC scripts): the client calls it on a
/// blocking thread.
pub trait ProxyResolver: Send + Sync + 'static {
    fn resolve(&self, url: &Url) -> Vec<ProxyChoice>;
}

/// Always direct.
pub struct NoProxy;

impl ProxyResolver for NoProxy {
    fn resolve(&self, _url: &Url) -> Vec<ProxyChoice> {
        vec![ProxyChoice::Direct]
    }
}

/// A fixed list for every URL except the implicitly bypassed local ones (tests, a configured override).
pub struct FixedProxy(pub Vec<ProxyChoice>);

impl ProxyResolver for FixedProxy {
    fn resolve(&self, url: &Url) -> Vec<ProxyChoice> {
        if implicitly_bypassed(url) { vec![ProxyChoice::Direct] } else { self.0.clone() }
    }
}

/// The operating system's proxy settings, read again for every request (they are cheap to read; WinHTTP and CFNetwork cache the
/// PAC scripts themselves).
#[derive(Default)]
pub struct SystemProxy {
    #[cfg(windows)]
    win: windows::WinResolver,
}

impl SystemProxy {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ProxyResolver for SystemProxy {
    fn resolve(&self, url: &Url) -> Vec<ProxyChoice> {
        if implicitly_bypassed(url) {
            return vec![ProxyChoice::Direct];
        }
        #[cfg(windows)]
        {
            self.win.resolve(url)
        }
        #[cfg(target_os = "macos")]
        {
            macos::resolve(url)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            vec![ProxyChoice::Direct]
        }
    }
}

/// Chromium's implicit bypass rules (ProxyBypassRules::MatchesImplicitRules): localhost, *.localhost, loopback and link-local
/// addresses never go through a proxy, whatever the settings or the PAC script say.
pub fn implicitly_bypassed(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ipv4_local(ip),
        Some(url::Host::Ipv6(ip)) => ipv6_local(ip),
        None => false,
    }
}

fn ipv4_local(ip: Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
}

fn ipv6_local(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return ipv4_local(v4);
    }
    ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn default_port(scheme: ProxyScheme) -> u16 {
    match scheme {
        ProxyScheme::Http => 80,
        ProxyScheme::Https => 443,
        ProxyScheme::Socks4 | ProxyScheme::Socks5 => 1080,
    }
}

/// `host`, `host:port`, `[v6]:port`, optionally with a `scheme://` prefix (which then decides the proxy type) and a trailing `/`.
/// `fallback` is the type when no prefix is given.
pub fn parse_proxy_server(text: &str, fallback: ProxyScheme) -> Option<ProxyServer> {
    let mut text = text.trim();
    let mut scheme = fallback;
    if let Some((prefix, rest)) = text.split_once("://") {
        scheme = match prefix.to_ascii_lowercase().as_str() {
            "http" => ProxyScheme::Http,
            "https" => ProxyScheme::Https,
            "socks" | "socks4" => ProxyScheme::Socks4,
            "socks5" => ProxyScheme::Socks5,
            _ => return None,
        };
        text = rest;
    }
    let text = text.trim_end_matches('/');
    if text.is_empty() || text.contains(['/', '@', ' ']) {
        return None;
    }
    let (host, port) = if let Some(rest) = text.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => Some(port),
            None if after.is_empty() => None,
            None => return None,
        };
        (host.parse::<Ipv6Addr>().ok()?.to_string(), port)
    } else {
        match text.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host.to_string(), Some(port)),
            Some(_) => return None,
            None => (text.to_string(), None),
        }
    };
    if host.is_empty() {
        return None;
    }
    let port = match port {
        Some(port) => port.parse::<u16>().ok().filter(|p| *p != 0)?,
        None => default_port(scheme),
    };
    Some(ProxyServer { scheme, host, port })
}

/// A PAC answer as Chromium reads it (ProxyList::SetFromPacString): `;`-separated entries `DIRECT`, `PROXY h:p`, `HTTPS h:p`,
/// `SOCKS h:p` (v4), `SOCKS4 h:p`, `SOCKS5 h:p`; unknown or broken entries are skipped; nothing usable means DIRECT.
pub fn parse_pac_result(text: &str) -> Vec<ProxyChoice> {
    let mut out = Vec::new();
    for entry in text.split(';') {
        let mut words = entry.split_whitespace();
        let Some(kind) = words.next() else { continue };
        let target = words.next();
        if words.next().is_some() {
            continue;
        }
        let scheme = match kind.to_ascii_uppercase().as_str() {
            "DIRECT" => {
                if target.is_none() {
                    out.push(ProxyChoice::Direct);
                }
                continue;
            }
            "PROXY" => ProxyScheme::Http,
            "HTTPS" => ProxyScheme::Https,
            "SOCKS" | "SOCKS4" => ProxyScheme::Socks4,
            "SOCKS5" => ProxyScheme::Socks5,
            _ => continue,
        };
        if let Some(server) = target.filter(|t| !t.contains("://")).and_then(|t| parse_proxy_server(t, scheme)) {
            out.push(ProxyChoice::Proxy(server));
        }
    }
    if out.is_empty() {
        out.push(ProxyChoice::Direct);
    }
    dedup(out)
}

fn dedup(list: Vec<ProxyChoice>) -> Vec<ProxyChoice> {
    let mut out: Vec<ProxyChoice> = Vec::with_capacity(list.len());
    for choice in list {
        if !out.contains(&choice) {
            out.push(choice);
        }
    }
    out
}

/// The manual proxy of Internet Options (Chromium's ProxyConfig::ProxyRules::ParseFromString on the WinInet string):
/// `host:port` for every scheme, or `http=h:p;https=h:p;socks=h:p` per scheme, where `socks=` is the SOCKS v4 fallback for
/// schemes without their own entry.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ManualRules {
    pub single: Vec<ProxyServer>,
    pub http: Vec<ProxyServer>,
    pub https: Vec<ProxyServer>,
    pub socks: Vec<ProxyServer>,
}

impl ManualRules {
    pub fn parse(text: &str) -> Self {
        let mut rules = ManualRules::default();
        for entry in text.split([';', ' ', '\t', '\r', '\n']).map(str::trim).filter(|e| !e.is_empty()) {
            match entry.split_once('=') {
                None => {
                    // WinInet writes every-scheme proxies as a bare list.
                    for item in entry.split(',') {
                        if let Some(server) = parse_proxy_server(item, ProxyScheme::Http) {
                            rules.single.push(server);
                        }
                    }
                }
                Some((scheme, list)) => {
                    let (target, fallback) = match scheme.trim().to_ascii_lowercase().as_str() {
                        "http" => (&mut rules.http, ProxyScheme::Http),
                        "https" => (&mut rules.https, ProxyScheme::Http),
                        "socks" => (&mut rules.socks, ProxyScheme::Socks4),
                        _ => continue,
                    };
                    for item in list.split(',') {
                        if let Some(server) = parse_proxy_server(item, fallback) {
                            target.push(server);
                        }
                    }
                }
            }
        }
        rules
    }

    pub fn is_empty(&self) -> bool {
        self.single.is_empty() && self.http.is_empty() && self.https.is_empty() && self.socks.is_empty()
    }

    /// The proxies for `url`; empty means direct.
    pub fn for_url(&self, url: &Url) -> Vec<ProxyChoice> {
        let list = if !self.single.is_empty() {
            &self.single
        } else {
            let specific = match url.scheme() {
                "http" => &self.http,
                "https" => &self.https,
                _ => &self.socks,
            };
            if specific.is_empty() { &self.socks } else { specific }
        };
        list.iter().cloned().map(ProxyChoice::Proxy).collect()
    }
}

/// One entry of a bypass list ("ProxyOverride"): `<local>` (names without a dot), `*.example.com`, `.example.com`,
/// `example.com`, `10.*`, `192.168.0.0/16`, optionally `scheme://` before and `:port` after.
#[derive(Clone, Debug, PartialEq, Eq)]
enum BypassRule {
    Local,
    Host { scheme: Option<String>, pattern: String, port: Option<u16> },
    Cidr { scheme: Option<String>, net: IpAddr, prefix: u8 },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BypassList {
    rules: Vec<BypassRule>,
}

impl BypassList {
    pub fn parse(text: &str) -> Self {
        let mut rules = Vec::new();
        for entry in text.split([';', ',', ' ', '\t', '\r', '\n']).map(str::trim).filter(|e| !e.is_empty()) {
            if entry.eq_ignore_ascii_case("<local>") {
                rules.push(BypassRule::Local);
                continue;
            }
            let (scheme, rest) = match entry.split_once("://") {
                Some((scheme, rest)) => (Some(scheme.to_ascii_lowercase()), rest),
                None => (None, entry),
            };
            if let Some((net, prefix)) = rest.split_once('/') {
                let net = net.trim_start_matches('[').trim_end_matches(']');
                if let (Ok(net), Ok(prefix)) = (net.parse::<IpAddr>(), prefix.parse::<u8>()) {
                    let max = if net.is_ipv4() { 32 } else { 128 };
                    if prefix <= max {
                        rules.push(BypassRule::Cidr { scheme, net, prefix });
                    }
                }
                continue;
            }
            let (host, port) = split_host_port(rest);
            let mut pattern = host.to_ascii_lowercase();
            if pattern.starts_with('.') {
                pattern.insert(0, '*');
            }
            if !pattern.is_empty() {
                rules.push(BypassRule::Host { scheme, pattern, port });
            }
        }
        BypassList { rules }
    }

    pub fn matches(&self, url: &Url) -> bool {
        let Some(host) = url.host_str() else { return false };
        let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
        let port = url.port_or_known_default();
        let ip = host.parse::<IpAddr>().ok();
        self.rules.iter().any(|rule| match rule {
            BypassRule::Local => ip.is_none() && !host.contains('.'),
            BypassRule::Host { scheme, pattern, port: want } => {
                scheme.as_deref().is_none_or(|s| s == url.scheme())
                    && want.is_none_or(|p| Some(p) == port)
                    && glob_match(pattern.trim_start_matches('[').trim_end_matches(']'), &host)
            }
            BypassRule::Cidr { scheme, net, prefix } => {
                scheme.as_deref().is_none_or(|s| s == url.scheme()) && ip.is_some_and(|ip| in_cidr(ip, *net, *prefix))
            }
        })
    }
}

fn split_host_port(text: &str) -> (&str, Option<u16>) {
    if let Some(rest) = text.strip_prefix('[')
        && let Some((host, after)) = rest.split_once(']')
    {
        return (host, after.strip_prefix(':').and_then(|p| p.parse().ok()));
    }
    match text.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => match port.parse::<u16>() {
            Ok(port) => (host, Some(port)),
            Err(_) => (text, None),
        },
        _ => (text, None),
    }
}

fn in_cidr(ip: IpAddr, net: IpAddr, prefix: u8) -> bool {
    match (ip, net) {
        (IpAddr::V4(ip), IpAddr::V4(net)) => {
            let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(prefix)) };
            (u32::from(ip) & mask) == (u32::from(net) & mask)
        }
        (IpAddr::V6(ip), IpAddr::V6(net)) => {
            let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - u32::from(prefix)) };
            (u128::from(ip) & mask) == (u128::from(net) & mask)
        }
        _ => false,
    }
}

/// Case-insensitive `*` wildcard match over the whole text (both sides already lower case).
fn glob_match(pattern: &str, text: &str) -> bool {
    let p = pattern.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

/// The Internet Options proxy settings of the current user (the four fields of WINHTTP_CURRENT_USER_IE_PROXY_CONFIG).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IeProxyConfig {
    pub auto_detect: bool,
    pub auto_config_url: Option<String>,
    pub proxy: Option<String>,
    pub bypass: Option<String>,
}

impl IeProxyConfig {
    pub fn uses_auto(&self) -> bool {
        self.auto_detect || self.auto_config_url.as_deref().is_some_and(|u| !u.trim().is_empty())
    }
}

/// Chromium's order for a Windows configuration: automatic settings (WPAD, PAC) first; if they give no answer (no WPAD
/// server, script not downloadable or broken) the manual proxy with its bypass list; otherwise direct. `auto` evaluates the
/// automatic part (WinHTTP in the app, a stub in the tests) and returns None when it failed.
pub fn resolve_with_config(
    url: &Url,
    config: &IeProxyConfig,
    auto: impl FnOnce(&Url, &IeProxyConfig) -> Option<Vec<ProxyChoice>>,
) -> Vec<ProxyChoice> {
    if implicitly_bypassed(url) {
        return vec![ProxyChoice::Direct];
    }
    if config.uses_auto()
        && let Some(list) = auto(url, config)
    {
        return list;
    }
    if let Some(proxy) = config.proxy.as_deref().filter(|p| !p.trim().is_empty()) {
        let bypass = BypassList::parse(config.bypass.as_deref().unwrap_or(""));
        if !bypass.matches(url) {
            let list = ManualRules::parse(proxy).for_url(url);
            if !list.is_empty() {
                return list;
            }
        }
    }
    vec![ProxyChoice::Direct]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }
    fn http(host: &str, port: u16) -> ProxyChoice {
        ProxyChoice::Proxy(ProxyServer { scheme: ProxyScheme::Http, host: host.into(), port })
    }

    #[test]
    fn pac_answers_are_read_like_chromium() {
        assert_eq!(parse_pac_result("PROXY a:8080; DIRECT"), vec![http("a", 8080), ProxyChoice::Direct]);
        assert_eq!(
            parse_pac_result("  proxy a:1 ;SOCKS s:2; SOCKS5 t; HTTPS h:443;DIRECT"),
            vec![
                http("a", 1),
                ProxyChoice::Proxy(ProxyServer { scheme: ProxyScheme::Socks4, host: "s".into(), port: 2 }),
                ProxyChoice::Proxy(ProxyServer { scheme: ProxyScheme::Socks5, host: "t".into(), port: 1080 }),
                ProxyChoice::Proxy(ProxyServer { scheme: ProxyScheme::Https, host: "h".into(), port: 443 }),
                ProxyChoice::Direct,
            ]
        );
        assert_eq!(parse_pac_result("PROXY b"), vec![http("b", 80)]);
        assert_eq!(parse_pac_result("PROXY [::1]:3128"), vec![http("::1", 3128)]);
        // Broken entries are skipped, nothing usable means direct.
        assert_eq!(parse_pac_result("QUIC q:443; PROXY; PROXY a:x; PROXY a b"), vec![ProxyChoice::Direct]);
        assert_eq!(parse_pac_result(""), vec![ProxyChoice::Direct]);
        assert_eq!(parse_pac_result("BOGUS; PROXY ok:3"), vec![http("ok", 3)]);
    }

    #[test]
    fn manual_rules_pick_per_scheme_with_socks_fallback() {
        let all = ManualRules::parse("proxy.corp:3128");
        assert_eq!(all.for_url(&url("https://api.github.com/")), vec![http("proxy.corp", 3128)]);
        assert_eq!(all.for_url(&url("http://example.com/")), vec![http("proxy.corp", 3128)]);
        let split = ManualRules::parse("http=h:1;https=s:2;ftp=f:3");
        assert_eq!(split.for_url(&url("http://x/")), vec![http("h", 1)]);
        assert_eq!(split.for_url(&url("https://x/")), vec![http("s", 2)]);
        let socks = ManualRules::parse("http=h:1;socks=k:9");
        assert_eq!(
            socks.for_url(&url("https://x/")),
            vec![ProxyChoice::Proxy(ProxyServer { scheme: ProxyScheme::Socks4, host: "k".into(), port: 9 })]
        );
        assert!(ManualRules::parse("ftp=f:3").for_url(&url("https://x/")).is_empty());
        assert_eq!(ManualRules::parse("http://p.corp:8080/").for_url(&url("https://x/")), vec![http("p.corp", 8080)]);
    }

    #[test]
    fn bypass_lists_match_like_internet_options() {
        let list =
            BypassList::parse("<local>;*.corp.example;10.*;192.168.0.0/16;https://only-tls.example;intranet:8443;.dot.example");
        assert!(list.matches(&url("http://printer/")));
        assert!(!list.matches(&url("http://printer.example/")));
        assert!(list.matches(&url("https://a.corp.example/")));
        assert!(list.matches(&url("https://A.B.CORP.EXAMPLE/x")));
        assert!(!list.matches(&url("https://corp.example.evil/")));
        assert!(list.matches(&url("http://10.1.2.3/")));
        assert!(list.matches(&url("http://192.168.7.7:81/")));
        assert!(!list.matches(&url("http://192.169.0.1/")));
        assert!(list.matches(&url("https://only-tls.example/")));
        assert!(!list.matches(&url("http://only-tls.example/")));
        assert!(list.matches(&url("https://x.dot.example/")));
        let ports = BypassList::parse("intranet.example:8443");
        assert!(ports.matches(&url("https://intranet.example:8443/")));
        assert!(!ports.matches(&url("https://intranet.example/")));
        assert!(!BypassList::parse("").matches(&url("https://x/")));
    }

    #[test]
    fn local_addresses_are_always_direct() {
        for u in [
            "http://127.0.0.1:5/",
            "http://localhost/",
            "http://a.localhost/",
            "http://[::1]/",
            "http://169.254.1.1/",
            "http://[fe80::1]/",
            "http://0.0.0.0/",
        ] {
            assert!(implicitly_bypassed(&url(u)), "{u}");
        }
        for u in ["http://10.0.0.1/", "https://api.anthropic.com/", "http://localhost.example/"] {
            assert!(!implicitly_bypassed(&url(u)), "{u}");
        }
        let fixed = FixedProxy(vec![http("p", 1)]);
        assert_eq!(fixed.resolve(&url("http://127.0.0.1:9/")), vec![ProxyChoice::Direct]);
        assert_eq!(fixed.resolve(&url("http://example.com/")), vec![http("p", 1)]);
    }

    #[test]
    fn windows_config_order_auto_then_manual_then_direct() {
        let target = url("https://platform.claude.com/v1/oauth/token");
        let manual = IeProxyConfig { proxy: Some("m:1".into()), bypass: Some("<local>".into()), ..Default::default() };
        assert_eq!(resolve_with_config(&target, &manual, |_, _| panic!("no auto settings")), vec![http("m", 1)]);
        let auto = IeProxyConfig { auto_detect: true, ..manual.clone() };
        assert_eq!(resolve_with_config(&target, &auto, |_, _| Some(vec![http("pac", 2)])), vec![http("pac", 2)]);
        // WPAD found nothing / the script failed: the manual proxy applies.
        assert_eq!(resolve_with_config(&target, &auto, |_, _| None), vec![http("m", 1)]);
        let bypassed = IeProxyConfig { proxy: Some("m:1".into()), bypass: Some("*.claude.com".into()), ..Default::default() };
        assert_eq!(resolve_with_config(&target, &bypassed, |_, _| None), vec![ProxyChoice::Direct]);
        assert_eq!(resolve_with_config(&target, &IeProxyConfig::default(), |_, _| panic!()), vec![ProxyChoice::Direct]);
        assert_eq!(resolve_with_config(&url("http://127.0.0.1:1/"), &auto, |_, _| panic!()), vec![ProxyChoice::Direct]);
    }

    #[test]
    fn proxy_server_text_forms() {
        assert_eq!(parse_proxy_server("socks5://s:1", ProxyScheme::Http).unwrap().scheme, ProxyScheme::Socks5);
        assert_eq!(parse_proxy_server("https://s", ProxyScheme::Http).unwrap().port, 443);
        assert!(parse_proxy_server("s:0", ProxyScheme::Http).is_none());
        assert!(parse_proxy_server("s:99999", ProxyScheme::Http).is_none());
        assert!(parse_proxy_server("u:p@s:1", ProxyScheme::Http).is_none());
        assert!(parse_proxy_server("ftp://s:1", ProxyScheme::Http).is_none());
        assert!(parse_proxy_server("", ProxyScheme::Http).is_none());
    }
}
