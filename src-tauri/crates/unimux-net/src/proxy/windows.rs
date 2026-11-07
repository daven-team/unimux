//! Windows: the current user's Internet Options proxy settings and WinHTTP's WPAD / PAC evaluation.
//!
//! The PAC answer is read with `WinHttpGetProxyForUrlEx` + `WinHttpGetProxyResult`, which keep every entry of the script's
//! answer (DIRECT and SOCKS included, so "PROXY a:8080; DIRECT" still falls back to direct like Chromium). The older
//! `WinHttpGetProxyForUrl` (which drops DIRECT entries) is only the fallback when the resolver API is unavailable.

use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use url::Url;
use windows::Win32::Foundation::{GetLastError, GlobalFree, HGLOBAL};
use windows::Win32::Networking::WinHttp::{
    WINHTTP_ACCESS_TYPE_NAMED_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_ASYNC_RESULT, WINHTTP_AUTO_DETECT_TYPE_DHCP,
    WINHTTP_AUTO_DETECT_TYPE_DNS_A, WINHTTP_AUTOPROXY_AUTO_DETECT, WINHTTP_AUTOPROXY_CONFIG_URL, WINHTTP_AUTOPROXY_OPTIONS,
    WINHTTP_CALLBACK_FLAG_GETPROXYFORURL_COMPLETE, WINHTTP_CALLBACK_FLAG_REQUEST_ERROR,
    WINHTTP_CALLBACK_STATUS_GETPROXYFORURL_COMPLETE, WINHTTP_CALLBACK_STATUS_REQUEST_ERROR, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG,
    WINHTTP_FLAG_ASYNC, WINHTTP_INTERNET_SCHEME_HTTP, WINHTTP_INTERNET_SCHEME_HTTPS, WINHTTP_INTERNET_SCHEME_SOCKS,
    WINHTTP_PROXY_INFO, WINHTTP_PROXY_RESULT, WinHttpCloseHandle, WinHttpCreateProxyResolver, WinHttpFreeProxyResult,
    WinHttpGetIEProxyConfigForCurrentUser, WinHttpGetProxyForUrl, WinHttpGetProxyForUrlEx, WinHttpGetProxyResult, WinHttpOpen,
    WinHttpSetStatusCallback, WinHttpSetTimeouts,
};
use windows::core::{BOOL, PCWSTR, PWSTR, w};

use super::{BypassList, IeProxyConfig, ManualRules, ProxyChoice, ProxyScheme, ProxyServer, resolve_with_config};

/// After WPAD or the PAC script failed, the automatic settings are skipped for this long (Chromium polls a failed script
/// again later too); a changed configuration is tried at once.
const AUTO_FAILURE_HOLD: Duration = Duration::from_secs(120);
/// Longest wait for one WPAD / PAC evaluation.
const AUTO_TIMEOUT: Duration = Duration::from_secs(20);
const WINHTTP_AUTOPROXY_RUN_INPROCESS: u32 = 0x0001_0000;
const ERROR_IO_PENDING: u32 = 997;
const ERROR_WINHTTP_TIMEOUT: u32 = 12002;
const ERROR_WINHTTP_LOGIN_FAILURE: u32 = 12015;
const ERROR_WINHTTP_AUTOPROXY_SERVICE_ERROR: u32 = 12178;

type Handle = *mut core::ffi::c_void;

struct Session(Handle);
// SAFETY: a WinHTTP session handle may be used from any thread.
unsafe impl Send for Session {}

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: the handle came from WinHttpOpen and is closed once.
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

#[derive(Default)]
pub struct WinResolver {
    sync_session: Mutex<Option<Session>>,
    async_session: Mutex<Option<Session>>,
    failed: Mutex<Option<(IeProxyConfig, Instant)>>,
}

enum AutoError {
    /// The resolver API cannot be used: try the old one.
    Unavailable,
    Failed(u32),
}

/// The options of one evaluation; owns the wide strings the WinHTTP struct points into.
struct AutoOptions {
    flags: u32,
    detect: u32,
    pac: Option<Vec<u16>>,
    target: Vec<u16>,
}

impl AutoOptions {
    fn raw(&self, extra: u32, logon: bool) -> WINHTTP_AUTOPROXY_OPTIONS {
        WINHTTP_AUTOPROXY_OPTIONS {
            dwFlags: self.flags | extra,
            dwAutoDetectFlags: self.detect,
            lpszAutoConfigUrl: self.pac.as_ref().map(|p| PCWSTR(p.as_ptr())).unwrap_or(PCWSTR::null()),
            lpvReserved: std::ptr::null_mut(),
            dwReserved: 0,
            fAutoLogonIfChallenged: BOOL::from(logon),
        }
    }
}

fn session(slot: &Mutex<Option<Session>>, flags: u32) -> Result<Handle, u32> {
    let mut guard = slot.lock();
    if let Some(session) = guard.as_ref() {
        return Ok(session.0);
    }
    // SAFETY: plain WinHTTP calls with valid static strings; the handle is owned by `Session` (kept for the process).
    let handle = unsafe { WinHttpOpen(w!("unimux"), WINHTTP_ACCESS_TYPE_NO_PROXY, PCWSTR::null(), PCWSTR::null(), flags) };
    if handle.is_null() {
        // SAFETY: reads the thread's last error.
        return Err(unsafe { GetLastError().0 });
    }
    // SAFETY: valid handle; the timeouts bound the script download (resolve, connect, send, receive in ms).
    unsafe {
        let _ = WinHttpSetTimeouts(handle, 5_000, 5_000, 5_000, 10_000);
    }
    *guard = Some(Session(handle));
    Ok(handle)
}

/// Shared between `auto_ex` and the WinHTTP callback (through the context pointer).
struct Completion {
    tx: Mutex<Option<mpsc::SyncSender<Result<(), u32>>>>,
}

unsafe extern "system" fn on_proxy_result(_handle: Handle, context: usize, status: u32, info: *mut core::ffi::c_void, _len: u32) {
    if context == 0
        || (status != WINHTTP_CALLBACK_STATUS_GETPROXYFORURL_COMPLETE && status != WINHTTP_CALLBACK_STATUS_REQUEST_ERROR)
    {
        return;
    }
    // SAFETY: `context` is an `Arc<Completion>` pointer that `auto_ex` keeps alive until the sender has been taken out and the
    // lock released (it frees it only after `recv` returned), or leaks after a timeout.
    let completion = unsafe { &*(context as *const Completion) };
    let result = if status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR {
        // SAFETY: for REQUEST_ERROR the status information is a WINHTTP_ASYNC_RESULT.
        Err(if info.is_null() { 0 } else { unsafe { (*(info as *const WINHTTP_ASYNC_RESULT)).dwError } })
    } else {
        Ok(())
    };
    // Take the sender and release the lock BEFORE signalling: once `send` wakes `auto_ex`, it may free `Completion` (and the
    // mutex inside it) at any moment, so this callback must not touch `completion` after the send.
    let tx = {
        let mut slot = completion.tx.lock();
        slot.take()
    };
    if let Some(tx) = tx {
        let _ = tx.send(result);
    }
}

impl WinResolver {
    pub fn resolve(&self, url: &Url) -> Vec<ProxyChoice> {
        let config = current_user_config().unwrap_or_default();
        resolve_with_config(url, &config, |url, config| {
            if let Some((failed, at)) = self.failed.lock().as_ref()
                && failed == config
                && at.elapsed() < AUTO_FAILURE_HOLD
            {
                return None;
            }
            match self.auto(url, config.auto_detect, config.auto_config_url.as_deref()) {
                Ok(list) => {
                    *self.failed.lock() = None;
                    Some(list)
                }
                Err(_) => {
                    *self.failed.lock() = Some((config.clone(), Instant::now()));
                    None
                }
            }
        })
    }

    /// WinHTTP's answer for `url` under automatic settings: WPAD (DHCP + DNS) when `auto_detect`, the script at `pac_url`.
    /// Err carries the Win32 error (no WPAD server, script not downloadable, script error, timeout).
    pub fn auto(&self, url: &Url, auto_detect: bool, pac_url: Option<&str>) -> Result<Vec<ProxyChoice>, u32> {
        // The script sees the URL as Chromium hands it over (https without path and query).
        let target = super::pac_target(url);
        let mut options =
            AutoOptions { flags: 0, detect: 0, pac: None, target: target.as_str().encode_utf16().chain([0]).collect() };
        if auto_detect {
            options.flags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
            options.detect = WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
        }
        if let Some(pac) = pac_url.map(str::trim).filter(|u| !u.is_empty()) {
            options.flags |= WINHTTP_AUTOPROXY_CONFIG_URL;
            options.pac = Some(pac.encode_utf16().chain([0]).collect());
        }
        if options.flags == 0 {
            return Ok(vec![ProxyChoice::Direct]);
        }
        let attempt = |extra: u32, logon: bool| -> Result<Vec<ProxyChoice>, u32> {
            match self.auto_ex(&options, extra, logon) {
                Ok(list) => Ok(list),
                Err(AutoError::Failed(code)) => Err(code),
                Err(AutoError::Unavailable) => self.auto_sync(url, &options, extra, logon),
            }
        };
        // Microsoft's recommended order: without credentials first, with the user's logon only when the script server asks.
        match attempt(0, false) {
            Err(ERROR_WINHTTP_LOGIN_FAILURE) => attempt(0, true),
            Err(ERROR_WINHTTP_AUTOPROXY_SERVICE_ERROR) => attempt(WINHTTP_AUTOPROXY_RUN_INPROCESS, false),
            other => other,
        }
    }

    fn auto_ex(&self, options: &AutoOptions, extra: u32, logon: bool) -> Result<Vec<ProxyChoice>, AutoError> {
        let session = session(&self.async_session, WINHTTP_FLAG_ASYNC).map_err(|_| AutoError::Unavailable)?;
        let mut resolver: Handle = std::ptr::null_mut();
        // SAFETY: valid async session; the resolver handle is closed below on every path.
        if unsafe { WinHttpCreateProxyResolver(session, &mut resolver) } != 0 || resolver.is_null() {
            return Err(AutoError::Unavailable);
        }
        let close = |h: Handle| {
            // SAFETY: closes the resolver handle once.
            unsafe {
                let _ = WinHttpCloseHandle(h);
            }
        };
        // SAFETY: registers our callback for the two notifications on this resolver handle only.
        unsafe {
            WinHttpSetStatusCallback(
                resolver,
                Some(on_proxy_result),
                WINHTTP_CALLBACK_FLAG_GETPROXYFORURL_COMPLETE | WINHTTP_CALLBACK_FLAG_REQUEST_ERROR,
                0,
            );
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let completion = Arc::new(Completion { tx: Mutex::new(Some(tx)) });
        let context = Arc::into_raw(completion.clone()) as usize;
        let raw = options.raw(extra, logon);
        // SAFETY: the option strings live in `options` beyond the evaluation (we wait for it or leak the context).
        let rc = unsafe { WinHttpGetProxyForUrlEx(resolver, PCWSTR(options.target.as_ptr()), &raw, Some(context)) };
        if rc != ERROR_IO_PENDING {
            close(resolver);
            // SAFETY: no evaluation is running, the callback will not use the context.
            drop(unsafe { Arc::from_raw(context as *const Completion) });
            return Err(AutoError::Failed(rc));
        }
        let outcome = rx.recv_timeout(AUTO_TIMEOUT);
        let result = match outcome {
            Ok(Ok(())) => {
                let mut result = WINHTTP_PROXY_RESULT::default();
                // SAFETY: the evaluation completed; WinHTTP fills and later frees the result.
                let rc = unsafe { WinHttpGetProxyResult(resolver, &mut result) };
                if rc != 0 {
                    Err(AutoError::Failed(rc))
                } else {
                    // SAFETY: `pEntries` holds `cEntries` entries until WinHttpFreeProxyResult.
                    let list = unsafe { read_entries(&result) };
                    unsafe { WinHttpFreeProxyResult(&mut result) };
                    Ok(if list.is_empty() { vec![ProxyChoice::Direct] } else { list })
                }
            }
            Ok(Err(code)) => Err(AutoError::Failed(code)),
            Err(_) => Err(AutoError::Failed(ERROR_WINHTTP_TIMEOUT)),
        };
        close(resolver);
        if outcome.is_ok() {
            // SAFETY: the callback took the sender out and released the lock before it sent, so it no longer touches the
            // context.
            drop(unsafe { Arc::from_raw(context as *const Completion) });
        }
        // After a timeout the context stays allocated (a late callback may still read it): a few bytes, rarely.
        result
    }

    fn auto_sync(&self, url: &Url, options: &AutoOptions, extra: u32, logon: bool) -> Result<Vec<ProxyChoice>, u32> {
        let session = session(&self.sync_session, 0)?;
        let mut raw = options.raw(extra, logon);
        let mut info = WINHTTP_PROXY_INFO::default();
        // SAFETY: the strings outlive the call; WinHTTP allocates the result strings with GlobalAlloc, freed below.
        let ok = unsafe { WinHttpGetProxyForUrl(session, PCWSTR(options.target.as_ptr()), &mut raw, &mut info) };
        if ok.is_err() {
            // SAFETY: reads the thread's last error right after the failed call.
            return Err(unsafe { GetLastError().0 });
        }
        // SAFETY: the strings are WinHTTP's GlobalAlloc'd copies (or null).
        let proxy = unsafe { take_string(info.lpszProxy) };
        let bypass = unsafe { take_string(info.lpszProxyBypass) };
        if info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY
            && let Some(proxy) = proxy
        {
            if bypass.as_deref().is_some_and(|b| BypassList::parse(b).matches(url)) {
                return Ok(vec![ProxyChoice::Direct]);
            }
            return Ok(parse_winhttp_list(&proxy, url));
        }
        Ok(vec![ProxyChoice::Direct])
    }
}

/// SAFETY: `result` was filled by WinHttpGetProxyResult and not freed yet.
unsafe fn read_entries(result: &WINHTTP_PROXY_RESULT) -> Vec<ProxyChoice> {
    let mut out = Vec::new();
    if result.pEntries.is_null() {
        return out;
    }
    // SAFETY: see the function contract.
    let entries = unsafe { std::slice::from_raw_parts(result.pEntries, result.cEntries as usize) };
    for entry in entries {
        if !entry.fProxy.as_bool() {
            out.push(ProxyChoice::Direct);
            continue;
        }
        // SAFETY: a NUL-terminated string owned by the result.
        let Some(host) = (unsafe { entry.pwszProxy.to_string() }).ok().filter(|h| !h.is_empty()) else { continue };
        let scheme = match entry.ProxyScheme {
            s if s == WINHTTP_INTERNET_SCHEME_HTTP => ProxyScheme::Http,
            s if s == WINHTTP_INTERNET_SCHEME_HTTPS => ProxyScheme::Https,
            // PAC "SOCKS" (v4, as in Chromium); WinHTTP drops "SOCKS5" entries of a PAC answer altogether.
            s if s == WINHTTP_INTERNET_SCHEME_SOCKS => ProxyScheme::Socks4,
            _ => continue,
        };
        let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
        let port = if entry.ProxyPort == 0 { super::default_port(scheme) } else { entry.ProxyPort };
        out.push(ProxyChoice::Proxy(ProxyServer { scheme, host, port }));
    }
    super::dedup(out)
}

/// WinHTTP's old API turns a PAC answer into `host:port;host:port` (DIRECT entries dropped). Read with the manual rules.
pub fn parse_winhttp_list(text: &str, url: &Url) -> Vec<ProxyChoice> {
    let list = ManualRules::parse(text).for_url(url);
    if list.is_empty() { vec![ProxyChoice::Direct] } else { list }
}

/// SAFETY: `p` is null or a NUL-terminated wide string allocated with GlobalAlloc that nobody else frees.
unsafe fn take_string(p: PWSTR) -> Option<String> {
    if p.is_null() {
        return None;
    }
    // SAFETY: see the function contract.
    let text = unsafe { p.to_string() }.ok();
    // SAFETY: frees the GlobalAlloc'd buffer once.
    unsafe {
        let _ = GlobalFree(Some(HGLOBAL(p.0.cast())));
    }
    text.filter(|t| !t.trim().is_empty())
}

/// Internet Options of the current user; None when WinHTTP cannot read them.
pub fn current_user_config() -> Option<IeProxyConfig> {
    let mut raw = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
    // SAFETY: WinHTTP fills the struct with GlobalAlloc'd strings, each taken (and freed) below.
    unsafe {
        WinHttpGetIEProxyConfigForCurrentUser(&mut raw).ok()?;
        Some(IeProxyConfig {
            auto_detect: raw.fAutoDetect.as_bool(),
            auto_config_url: take_string(raw.lpszAutoConfigUrl),
            proxy: take_string(raw.lpszProxy),
            bypass: take_string(raw.lpszProxyBypass),
        })
    }
}
