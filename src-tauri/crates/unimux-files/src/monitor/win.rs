//! Windows: one NtQuerySystemInformation(SystemProcessInformation) call per snapshot, read like 1.1.4's helper did (the same
//! fields: pid, parent pid, user + kernel time in 100 ns, the private working set, the create time as FILETIME, the image
//! name), plus the command line of a WebView2 process for its label.

use std::ffi::c_void;

use windows::Wdk::System::SystemInformation::{NtQuerySystemInformation, SystemProcessInformation};
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
use windows::Win32::Foundation::{CloseHandle, HANDLE, NTSTATUS, STATUS_INFO_LENGTH_MISMATCH};
use windows::Win32::System::SystemInformation::{GetSystemInfo, SYSTEM_INFO};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess};

use super::model::RawProc;

/// The start of SYSTEM_PROCESS_INFORMATION on 64-bit Windows (winternl.h with the fields winternl.h calls Reserved named as
/// in the NT headers; the offsets are those 1.1.4's helper read: 0, 8, 32, 40, 48, 56, 64, 80, 88).
#[repr(C)]
struct ProcessInformation {
    next_entry_offset: u32,
    number_of_threads: u32,
    working_set_private_size: i64,
    hard_fault_count: u32,
    number_of_threads_high_watermark: u32,
    cycle_time: u64,
    create_time: i64,
    user_time: i64,
    kernel_time: i64,
    image_name_length: u16,
    image_name_maximum_length: u16,
    image_name_buffer: *const u16,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

const _: () = {
    assert!(std::mem::offset_of!(ProcessInformation, create_time) == 32);
    assert!(std::mem::offset_of!(ProcessInformation, image_name_length) == 56);
    assert!(std::mem::offset_of!(ProcessInformation, image_name_buffer) == 64);
    assert!(std::mem::offset_of!(ProcessInformation, unique_process_id) == 80);
    assert!(std::mem::offset_of!(ProcessInformation, inherited_from_unique_process_id) == 88);
};

/// The reused buffer of the snapshots (1 MiB to start, grown when the system asks for more; 1.1.4: up to 8 tries).
pub struct SnapshotBuffer {
    buf: Vec<u64>,
}

impl Default for SnapshotBuffer {
    fn default() -> Self {
        Self { buf: vec![0u64; (1 << 20) / 8] }
    }
}

impl SnapshotBuffer {
    pub fn snapshot(&mut self) -> Result<Vec<RawProc>, String> {
        let mut tries = 0;
        loop {
            let mut need = 0u32;
            let bytes = (self.buf.len() * 8) as u32;
            // SAFETY: the buffer is writable for `bytes` bytes and outlives the call.
            let status: NTSTATUS = unsafe {
                NtQuerySystemInformation(SystemProcessInformation, self.buf.as_mut_ptr().cast::<c_void>(), bytes, &mut need)
            };
            if status == STATUS_INFO_LENGTH_MISMATCH && tries < 8 {
                tries += 1;
                let size = (bytes as usize * 2).max(need as usize + 65_536);
                self.buf = vec![0u64; size.div_ceil(8)];
                continue;
            }
            if status.is_err() {
                return Err(format!("NtQuerySystemInformation: {:#x}", status.0));
            }
            break;
        }
        let base = self.buf.as_ptr().cast::<u8>();
        let total = self.buf.len() * 8;
        let mut out = Vec::with_capacity(512);
        let mut off = 0usize;
        while off + std::mem::size_of::<ProcessInformation>() <= total {
            // SAFETY: `off` stays inside the filled part of the buffer (the system's own offsets); unaligned reads.
            let info = unsafe { std::ptr::read_unaligned(base.add(off).cast::<ProcessInformation>()) };
            let name = if info.image_name_buffer.is_null() || info.image_name_length == 0 {
                String::new()
            } else {
                // SAFETY: ImageName points into the same buffer, `Length` bytes long.
                let units =
                    unsafe { std::slice::from_raw_parts(info.image_name_buffer, usize::from(info.image_name_length) / 2) };
                String::from_utf16_lossy(units)
            };
            let pid = info.unique_process_id as u64;
            // 1.1.4 dropped pid 0 (the idle process) and anything that is not a safe positive integer.
            if pid > 0
                && let Ok(pid) = u32::try_from(pid)
            {
                out.push(RawProc {
                    pid,
                    ppid: u32::try_from(info.inherited_from_unique_process_id).unwrap_or(0),
                    cpu_ms: (info.user_time as f64 + info.kernel_time as f64) / 1e4,
                    mem: info.working_set_private_size as f64,
                    start: info.create_time as f64 / 1e4,
                    name,
                });
            }
            if info.next_entry_offset == 0 {
                break;
            }
            off += info.next_entry_offset as usize;
        }
        Ok(out)
    }
}

/// libuv's `uv_cpu_info` count (GetSystemInfo's dwNumberOfProcessors), which `os.cpus().length` gave 1.1.4.
pub fn logical_cores() -> u32 {
    let mut info = SYSTEM_INFO::default();
    // SAFETY: fills the struct.
    unsafe { GetSystemInfo(&mut info) };
    info.dwNumberOfProcessors.max(1)
}

/// `process.kill(pid)` on Windows: libuv opens the process and calls TerminateProcess(handle, 1).
pub fn terminate(pid: u32) -> bool {
    // SAFETY: a handle opened for termination only and closed again.
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) else { return false };
        let ok = TerminateProcess(handle, 1).is_ok();
        let _ = CloseHandle(handle);
        ok
    }
}

/// The command line of a process of this user (None when it cannot be read: another user's, protected, gone).
pub fn command_line(pid: u32) -> Option<String> {
    // SAFETY: a query handle closed again; the answer is a UNICODE_STRING whose buffer lies inside our own buffer.
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u64; 512];
        let mut result = None;
        for _ in 0..4 {
            let mut need = 0u32;
            let bytes = (buf.len() * 8) as u32;
            let status = NtQueryInformationProcess(
                handle,
                ProcessCommandLineInformation,
                buf.as_mut_ptr().cast::<c_void>(),
                bytes,
                &mut need,
            );
            if status.is_err() {
                if need as usize > bytes as usize {
                    buf = vec![0u64; (need as usize).div_ceil(8) + 1];
                    continue;
                }
                break;
            }
            let base = buf.as_ptr().cast::<u8>();
            let length = std::ptr::read_unaligned(base.cast::<u16>()) as usize;
            let text = std::ptr::read_unaligned(base.add(8).cast::<*const u16>());
            if !text.is_null() && length > 0 {
                let start = text.cast::<u8>() as usize;
                let inside = start >= base as usize && start + length <= base as usize + bytes as usize;
                if inside {
                    result = Some(String::from_utf16_lossy(std::slice::from_raw_parts(text, length / 2)));
                }
            } else {
                result = Some(String::new());
            }
            break;
        }
        let _ = CloseHandle(handle);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn a_snapshot_finds_this_process_with_its_parent_start_and_name() {
        let mut buffer = SnapshotBuffer::default();
        let procs = buffer.snapshot().unwrap();
        assert!(procs.len() > 10, "{}", procs.len());
        let me = procs.iter().find(|p| p.pid == std::process::id()).expect("own pid in the snapshot");
        let exe = std::env::current_exe().unwrap();
        assert!(me.name.eq_ignore_ascii_case(&exe.file_name().unwrap().to_string_lossy()), "{}", me.name);
        assert!(me.mem > 0.0);
        assert!(me.cpu_ms >= 0.0);
        // The start is a FILETIME in ms: 1601 to now, so it is the Unix time plus 11,644,473,600 s.
        let unix_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as f64;
        let start_unix = me.start - 11_644_473_600_000.0;
        assert!(start_unix <= unix_ms + 1000.0 && start_unix > unix_ms - 3_600_000.0, "{start_unix} vs {unix_ms}");
        assert!(procs.iter().any(|p| p.pid == me.ppid), "parent {} listed", me.ppid);
        assert!(procs.iter().all(|p| p.pid != 0));
        // The System process (pid 4).
        assert!(procs.iter().any(|p| p.pid == 4));
    }

    #[test]
    fn a_tiny_buffer_grows_to_what_the_system_needs() {
        let mut buffer = SnapshotBuffer { buf: vec![0u64; 16] };
        assert!(buffer.snapshot().unwrap().iter().any(|p| p.pid == std::process::id()));
    }

    #[test]
    fn a_snapshot_takes_well_under_20_ms() {
        let mut buffer = SnapshotBuffer::default();
        buffer.snapshot().unwrap();
        let mut times: Vec<f64> = (0..15)
            .map(|_| {
                let t = Instant::now();
                buffer.snapshot().unwrap();
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        times.sort_by(f64::total_cmp);
        let median = times[times.len() / 2];
        eprintln!("snapshot ms: median {median:.2}, max {:.2}", times[times.len() - 1]);
        assert!(median < 20.0, "median {median} ms");
    }

    #[test]
    fn reads_the_command_line_of_an_own_process() {
        let line = command_line(std::process::id()).unwrap();
        let exe = std::env::current_exe().unwrap();
        assert!(line.to_lowercase().contains(&exe.file_stem().unwrap().to_string_lossy().to_lowercase()), "{line}");
        assert_eq!(command_line(0), None);
    }

    #[test]
    fn cores_and_terminate() {
        assert!(logical_cores() >= 1);
        let mut child = std::process::Command::new("ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        assert!(terminate(child.id()));
        assert_eq!(child.wait().unwrap().code(), Some(1));
    }
}
