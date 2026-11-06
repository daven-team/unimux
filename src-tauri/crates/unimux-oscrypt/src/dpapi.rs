//! DPAPI (CryptProtectData / CryptUnprotectData, current user scope), as Chromium 156's OSCrypt calls it: no entropy,
//! description `Chromium`, flag CRYPTPROTECT_AUDIT (0x10). Measured on the `Local State` key of Electron 45.2.2 (SP2): a key
//! wrapped any other way is re-wrapped by Chromium on its next start (same key, new `encrypted_key`), which is harmless but
//! rewrites `Local State`, so we wrap it exactly like Chromium does.

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_AUDIT, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};
use windows::core::w;
use zeroize::Zeroizing;

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
}

/// Copies the output blob out and frees it (zeroed first: it can hold the key).
fn take(out: CRYPT_INTEGER_BLOB) -> Zeroizing<Vec<u8>> {
    // SAFETY: on success DPAPI returns a LocalAlloc'd buffer of cbData bytes owned by the caller.
    unsafe {
        let slice = std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize);
        let copy = Zeroizing::new(slice.to_vec());
        slice.fill(0);
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        copy
    }
}

pub fn protect(data: &[u8]) -> windows::core::Result<Vec<u8>> {
    let input = blob(data);
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input points at `data` for the duration of the call; out receives a buffer freed by `take`.
    unsafe { CryptProtectData(&input, w!("Chromium"), None, None, None, CRYPTPROTECT_AUDIT, &mut out)? };
    Ok(take(out).to_vec())
}

pub fn unprotect(data: &[u8]) -> windows::core::Result<Zeroizing<Vec<u8>>> {
    let input = blob(data);
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`.
    unsafe { CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)? };
    Ok(take(out))
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip_for_the_current_user() {
        let sealed = super::protect(b"0123456789abcdef0123456789abcdef").unwrap();
        assert_ne!(sealed.as_slice(), b"0123456789abcdef0123456789abcdef");
        assert_eq!(super::unprotect(&sealed).unwrap().as_slice(), b"0123456789abcdef0123456789abcdef");
        assert!(super::unprotect(b"garbage").is_err());
    }

    #[test]
    fn wraps_like_chromium() {
        // DPAPI blob: version(4) provider(16) master key version(4) master key(16) flags(4) description length(4) description.
        let sealed = super::protect(&[0u8; 32]).unwrap();
        assert_eq!(u32::from_le_bytes(sealed[40..44].try_into().unwrap()), 0x10, "CRYPTPROTECT_AUDIT");
        let len = u32::from_le_bytes(sealed[44..48].try_into().unwrap()) as usize;
        let desc: Vec<u16> = sealed[48..48 + len].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16(&desc).unwrap(), "Chromium\0");
    }
}
