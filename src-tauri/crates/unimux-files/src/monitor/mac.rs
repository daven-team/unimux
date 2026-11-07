//! macOS: libproc instead of 1.1.4's `ps -A -o pid=,ppid=,rss=,time=,lstart=,comm=` (the same fields: resident size in
//! bytes, user + system CPU time, the start time, the executable's file name). WKWebView's processes are started by
//! launchd for the app, not as its children: they are found by the pid "responsible" for them (what Activity Monitor
//! groups by), read through `responsibility_get_pid_responsible_for_pid` when the system has it.

use std::ffi::{CStr, c_int, c_void};

use super::model::{AppProcInfo, RawProc};

/// Mach absolute time units per nanosecond (1/1 on Intel, 125/3 on Apple Silicon); libc marks the binding deprecated in
/// favour of the mach2 crate, which is not worth a dependency for one call.
#[allow(deprecated)]
fn timebase() -> (u32, u32) {
    let mut info = libc::mach_timebase_info { numer: 0, denom: 0 };
    // SAFETY: fills the struct.
    let ok = unsafe { libc::mach_timebase_info(&mut info) } == 0;
    if ok && info.denom != 0 { (info.numer, info.denom) } else { (1, 1) }
}

fn pids() -> Vec<c_int> {
    // SAFETY: a null buffer asks for the count; the second call fills our buffer of that size.
    unsafe {
        let n = libc::proc_listallpids(std::ptr::null_mut(), 0);
        if n <= 0 {
            return Vec::new();
        }
        let mut buf = vec![0 as c_int; n as usize + 64];
        let bytes = (buf.len() * std::mem::size_of::<c_int>()) as c_int;
        let got = libc::proc_listallpids(buf.as_mut_ptr().cast::<c_void>(), bytes);
        if got <= 0 {
            return Vec::new();
        }
        buf.truncate(got as usize);
        buf
    }
}

fn path_name(pid: c_int) -> Option<String> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is PROC_PIDPATHINFO_MAXSIZE bytes long.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast::<c_void>(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    let path = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
    Some(path.rsplit('/').next().unwrap_or(&path).to_string())
}

fn comm(raw: &[libc::c_char]) -> String {
    // SAFETY: pbi_comm / pbi_name are NUL-terminated within their array (the kernel writes them so).
    let bytes: Vec<u8> = raw.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// One system snapshot. A process whose task info cannot be read (another user's) keeps its parent and start with CPU 0
/// and memory 0: it can only ever be a link of a tree, never one of the app's or a cell's own processes.
pub fn snapshot() -> Result<Vec<RawProc>, String> {
    let list = pids();
    if list.is_empty() {
        return Err("proc_listallpids failed".into());
    }
    let (numer, denom) = timebase();
    let ticks_to_ms = |t: u64| t as f64 * f64::from(numer) / f64::from(denom) / 1e6;
    let mut out = Vec::with_capacity(list.len());
    for pid in list {
        if pid <= 0 {
            continue;
        }
        let mut all: libc::proc_taskallinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskallinfo>() as c_int;
        // SAFETY: the struct is `size` bytes long.
        let n = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDTASKALLINFO, 0, (&mut all as *mut libc::proc_taskallinfo).cast(), size)
        };
        let (bsd, cpu_ms, mem) = if n == size {
            (all.pbsd, ticks_to_ms(all.ptinfo.pti_total_user + all.ptinfo.pti_total_system), all.ptinfo.pti_resident_size as f64)
        } else {
            let mut bsd: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as c_int;
            // SAFETY: as above.
            let n =
                unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut bsd as *mut libc::proc_bsdinfo).cast(), size) };
            if n != size {
                continue;
            }
            (bsd, 0.0, 0.0)
        };
        let start = bsd.pbi_start_tvsec as f64 * 1000.0 + (bsd.pbi_start_tvusec as f64 / 1000.0).floor();
        let name = path_name(pid).unwrap_or_else(|| {
            let long = comm(&bsd.pbi_name);
            if long.is_empty() { comm(&bsd.pbi_comm) } else { long }
        });
        out.push(RawProc { pid: pid as u32, ppid: bsd.pbi_ppid, cpu_ms, mem, start, name });
    }
    Ok(out)
}

type Responsible = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

fn responsible_fn() -> Option<Responsible> {
    static FN: std::sync::OnceLock<Option<usize>> = std::sync::OnceLock::new();
    let addr = *FN.get_or_init(|| {
        let name: &CStr = c"responsibility_get_pid_responsible_for_pid";
        // SAFETY: a lookup in the already loaded images.
        let p = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
        (!p.is_null()).then_some(p as usize)
    });
    // SAFETY: the symbol has this signature (pid_t -> pid_t) on every macOS that exports it.
    addr.map(|a| unsafe { std::mem::transmute::<usize, Responsible>(a) })
}

/// The kind and label of a WebKit process by its executable name.
pub fn webkit_kind(name: &str) -> Option<(&'static str, Option<String>)> {
    let rest = name.strip_prefix("com.apple.WebKit.")?;
    Some(match rest {
        "WebContent" => ("renderer", None),
        "GPU" => ("gpu", None),
        other => ("utility", Some(other.to_string())),
    })
}

/// The WKWebView processes this app is responsible for.
pub fn webkit_processes(main_pid: u32, procs: &[RawProc]) -> Vec<AppProcInfo> {
    let Some(responsible) = responsible_fn() else { return Vec::new() };
    procs
        .iter()
        .filter_map(|p| {
            let (kind, name) = webkit_kind(&p.name)?;
            // SAFETY: a plain query by pid.
            let owner = unsafe { responsible(p.pid as libc::pid_t) };
            (owner as u32 == main_pid).then(|| AppProcInfo { pid: p.pid, kind: kind.to_string(), name })
        })
        .collect()
}
