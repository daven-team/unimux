//! macOS: the system proxy settings through CFNetwork, PAC scripts (URL or inline JavaScript) through
//! `CFNetworkExecuteProxyAutoConfigurationURL` / `...Script` on a private run loop mode of the calling (blocking) thread.
//! Compile-checked only: no Mac was available for B3.

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation_sys::base::{CFEqual, CFGetTypeID, CFIndex, CFRelease, CFRetain, CFTypeRef, kCFAllocatorDefault};
use core_foundation_sys::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
use core_foundation_sys::error::CFErrorRef;
use core_foundation_sys::number::{CFNumberGetTypeID, CFNumberGetValue, CFNumberRef, kCFNumberSInt32Type};
use core_foundation_sys::runloop::{
    CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRemoveSource, CFRunLoopRunInMode, CFRunLoopSourceInvalidate,
    CFRunLoopSourceRef, CFRunLoopStop,
};
use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef, kCFStringEncodingUTF8};
use core_foundation_sys::url::{CFURLCreateWithBytes, CFURLGetTypeID, CFURLRef};
use url::Url;

use super::{ProxyChoice, ProxyScheme, ProxyServer};

/// A PAC script that does not answer within this time counts as failed (direct).
const PAC_TIMEOUT_SECS: f64 = 10.0;

#[repr(C)]
struct CFStreamClientContext {
    version: CFIndex,
    info: *mut c_void,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
}

type PacCallback = extern "C" fn(client: *mut c_void, proxies: CFArrayRef, error: CFErrorRef);

#[link(name = "CFNetwork", kind = "framework")]
unsafe extern "C" {
    fn CFNetworkCopySystemProxySettings() -> CFDictionaryRef;
    fn CFNetworkCopyProxiesForURL(url: CFURLRef, settings: CFDictionaryRef) -> CFArrayRef;
    fn CFNetworkExecuteProxyAutoConfigurationURL(
        pac_url: CFURLRef,
        target: CFURLRef,
        callback: PacCallback,
        context: *mut CFStreamClientContext,
    ) -> CFRunLoopSourceRef;
    fn CFNetworkExecuteProxyAutoConfigurationScript(
        script: CFStringRef,
        target: CFURLRef,
        callback: PacCallback,
        context: *mut CFStreamClientContext,
    ) -> CFRunLoopSourceRef;
    static kCFProxyTypeKey: CFStringRef;
    static kCFProxyHostNameKey: CFStringRef;
    static kCFProxyPortNumberKey: CFStringRef;
    static kCFProxyAutoConfigurationURLKey: CFStringRef;
    static kCFProxyAutoConfigurationJavaScriptKey: CFStringRef;
    static kCFProxyTypeNone: CFStringRef;
    static kCFProxyTypeHTTP: CFStringRef;
    static kCFProxyTypeHTTPS: CFStringRef;
    static kCFProxyTypeSOCKS: CFStringRef;
    static kCFProxyTypeAutoConfigurationURL: CFStringRef;
    static kCFProxyTypeAutoConfigurationJavaScript: CFStringRef;
}

struct Owned(CFTypeRef);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: we own one reference (a Create/Copy result or an explicit retain).
            unsafe { CFRelease(self.0) };
        }
    }
}

fn cf_url(text: &str) -> Option<Owned> {
    // SAFETY: the bytes are valid for the call; the result follows the create rule.
    let url = unsafe {
        CFURLCreateWithBytes(kCFAllocatorDefault, text.as_ptr(), text.len() as CFIndex, kCFStringEncodingUTF8, ptr::null())
    };
    if url.is_null() { None } else { Some(Owned(url as CFTypeRef)) }
}

/// SAFETY: `dict` is a valid CFDictionary.
unsafe fn get(dict: CFDictionaryRef, key: CFStringRef) -> CFTypeRef {
    unsafe { CFDictionaryGetValue(dict, key as *const c_void) }
}

/// SAFETY: `value` is null or a valid CF object.
unsafe fn string_of(value: CFTypeRef) -> Option<String> {
    if value.is_null() || unsafe { CFGetTypeID(value) } != unsafe { CFStringGetTypeID() } {
        return None;
    }
    Some(unsafe { CFString::wrap_under_get_rule(value as CFStringRef) }.to_string())
}

pub fn resolve(url: &Url) -> Vec<ProxyChoice> {
    // SAFETY: CFNetwork calls with owned references released by `Owned`.
    unsafe {
        let settings = CFNetworkCopySystemProxySettings();
        if settings.is_null() {
            return vec![ProxyChoice::Direct];
        }
        let settings = Owned(settings as CFTypeRef);
        let Some(target) = cf_url(url.as_str()) else { return vec![ProxyChoice::Direct] };
        let list = CFNetworkCopyProxiesForURL(target.0 as CFURLRef, settings.0 as CFDictionaryRef);
        if list.is_null() {
            return vec![ProxyChoice::Direct];
        }
        let list = Owned(list as CFTypeRef);
        let out = read_list(list.0 as CFArrayRef, target.0 as CFURLRef, 0);
        if out.is_empty() { vec![ProxyChoice::Direct] } else { out }
    }
}

/// SAFETY: `list` is a valid CFArray of proxy dictionaries, `target` a valid CFURL.
unsafe fn read_list(list: CFArrayRef, target: CFURLRef, depth: u8) -> Vec<ProxyChoice> {
    let mut out = Vec::new();
    let count = unsafe { CFArrayGetCount(list) };
    for i in 0..count {
        let entry = unsafe { CFArrayGetValueAtIndex(list, i) } as CFDictionaryRef;
        if entry.is_null() {
            continue;
        }
        let kind = unsafe { get(entry, kCFProxyTypeKey) };
        if kind.is_null() {
            continue;
        }
        let is = |k: CFStringRef| unsafe { CFEqual(kind, k as CFTypeRef) } != 0;
        if is(unsafe { kCFProxyTypeNone }) {
            out.push(ProxyChoice::Direct);
        } else if is(unsafe { kCFProxyTypeHTTP }) || is(unsafe { kCFProxyTypeHTTPS }) {
            // kCFProxyTypeHTTPS is the HTTP proxy used for https URLs (CONNECT), not a TLS proxy.
            if let Some(server) = unsafe { server_of(entry, ProxyScheme::Http) } {
                out.push(ProxyChoice::Proxy(server));
            }
        } else if is(unsafe { kCFProxyTypeSOCKS }) {
            if let Some(server) = unsafe { server_of(entry, ProxyScheme::Socks5) } {
                out.push(ProxyChoice::Proxy(server));
            }
        } else if depth == 0 && is(unsafe { kCFProxyTypeAutoConfigurationURL }) {
            let pac = unsafe { get(entry, kCFProxyAutoConfigurationURLKey) };
            if !pac.is_null() && unsafe { CFGetTypeID(pac) == CFURLGetTypeID() } {
                out.extend(unsafe { run_pac(Pac::Url(pac as CFURLRef), target) });
            }
        } else if depth == 0 && is(unsafe { kCFProxyTypeAutoConfigurationJavaScript }) {
            let script = unsafe { get(entry, kCFProxyAutoConfigurationJavaScriptKey) };
            if !script.is_null() && unsafe { CFGetTypeID(script) == CFStringGetTypeID() } {
                out.extend(unsafe { run_pac(Pac::Script(script as CFStringRef), target) });
            }
        }
    }
    out
}

/// SAFETY: `entry` is a valid proxy dictionary.
unsafe fn server_of(entry: CFDictionaryRef, scheme: ProxyScheme) -> Option<ProxyServer> {
    let host = unsafe { string_of(get(entry, kCFProxyHostNameKey)) }?;
    let number = unsafe { get(entry, kCFProxyPortNumberKey) };
    let mut port: i32 = 0;
    if !number.is_null() && unsafe { CFGetTypeID(number) == CFNumberGetTypeID() } {
        unsafe { CFNumberGetValue(number as CFNumberRef, kCFNumberSInt32Type, (&mut port as *mut i32).cast()) };
    }
    let port = u16::try_from(port).ok().filter(|p| *p != 0).unwrap_or(match scheme {
        ProxyScheme::Http => 80,
        ProxyScheme::Https => 443,
        ProxyScheme::Socks4 | ProxyScheme::Socks5 => 1080,
    });
    Some(ProxyServer { scheme, host, port })
}

enum Pac {
    Url(CFURLRef),
    Script(CFStringRef),
}

/// Written by the CFNetwork callback, read by `run_pac` on the same thread between run loop turns (atomics, so the compiler
/// never assumes the loop condition stays the same).
struct PacResult {
    done: AtomicBool,
    list: AtomicPtr<c_void>,
}

extern "C" fn pac_done(client: *mut c_void, proxies: CFArrayRef, error: CFErrorRef) {
    // SAFETY: `client` is the PacResult on the stack of `run_pac`, which runs the loop until this sets `done` (and
    // invalidates the source before it returns).
    let result = unsafe { &*(client as *const PacResult) };
    if error.is_null() && !proxies.is_null() {
        // SAFETY: keep the list beyond the callback; released by `run_pac`.
        unsafe { CFRetain(proxies as CFTypeRef) };
        result.list.store(proxies as *mut c_void, Ordering::SeqCst);
    }
    result.done.store(true, Ordering::SeqCst);
    // SAFETY: stops the run loop of this thread (the callback runs on it).
    unsafe { CFRunLoopStop(CFRunLoopGetCurrent()) };
}

/// SAFETY: `pac` and `target` are valid CF objects.
unsafe fn run_pac(pac: Pac, target: CFURLRef) -> Vec<ProxyChoice> {
    let result = PacResult { done: AtomicBool::new(false), list: AtomicPtr::new(ptr::null_mut()) };
    let mut context = CFStreamClientContext {
        version: 0,
        info: (&result as *const PacResult).cast_mut().cast(),
        retain: ptr::null(),
        release: ptr::null(),
        copy_description: ptr::null(),
    };
    let source = match pac {
        Pac::Url(url) => unsafe { CFNetworkExecuteProxyAutoConfigurationURL(url, target, pac_done, &mut context) },
        Pac::Script(script) => unsafe { CFNetworkExecuteProxyAutoConfigurationScript(script, target, pac_done, &mut context) },
    };
    if source.is_null() {
        return Vec::new();
    }
    let source = Owned(source as CFTypeRef);
    let mode = CFString::new("com.unimux.pac");
    let run_loop = unsafe { CFRunLoopGetCurrent() };
    unsafe { CFRunLoopAddSource(run_loop, source.0 as CFRunLoopSourceRef, mode.as_concrete_TypeRef()) };
    let started = std::time::Instant::now();
    loop {
        if result.done.load(Ordering::SeqCst) {
            break;
        }
        let left = PAC_TIMEOUT_SECS - started.elapsed().as_secs_f64();
        if left <= 0.0 {
            break;
        }
        unsafe { CFRunLoopRunInMode(mode.as_concrete_TypeRef(), left, 0) };
    }
    unsafe {
        CFRunLoopRemoveSource(run_loop, source.0 as CFRunLoopSourceRef, mode.as_concrete_TypeRef());
        CFRunLoopSourceInvalidate(source.0 as CFRunLoopSourceRef);
    }
    let list = result.list.load(Ordering::SeqCst);
    if list.is_null() {
        return Vec::new();
    }
    let list = Owned(list as CFTypeRef);
    unsafe { read_list(list.0 as CFArrayRef, target, 1) }
}
