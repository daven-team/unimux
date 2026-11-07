//! The Tauri feed backend against a local HTTP server (a development feed, MC_UPDATE_FEED): latest.json is read with the
//! updater's headers, the artifact is downloaded with progress, verified with the key and kept; a corrupt signature is refused
//! and the file removed; through the coordinator a corrupt .sig ends in the error state.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use unimux_update::coordinator::{Backend, CheckReason, CoordinatorOptions, Progress, UpdateCoordinator};
use unimux_update::net::{NetBackend, NetBackendOptions, VERIFY_FAILED};
use unimux_update::state::Status;

const TEST_KEY: &str = include_str!("fixtures/test.key.pub");
const PAYLOAD: &[u8] = include_bytes!("fixtures/payload.bin");
const SIG: &str = include_str!("fixtures/payload.bin.sig");

struct Server {
    base: String,
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    requests: Arc<Mutex<Vec<String>>>,
}

async fn serve() -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let files: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
    let requests: Arc<Mutex<Vec<String>>> = Arc::default();
    let (f, r) = (files.clone(), requests.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let (f, r) = (f.clone(), r.clone());
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let mut head = Vec::new();
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    head.extend_from_slice(&buf[..n]);
                }
                let text = String::from_utf8_lossy(&head).to_string();
                r.lock().push(text.clone());
                let path = text.split_whitespace().nth(1).unwrap_or("/").to_string();
                let body = f.lock().get(&path).cloned();
                let response = match body {
                    Some(body) => {
                        let mut out = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())
                            .into_bytes();
                        out.extend_from_slice(&body);
                        out
                    }
                    None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                };
                let _ = socket.write_all(&response).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    Server { base, files, requests }
}

fn feed(base: &str, version: &str, signature: &str) -> Vec<u8> {
    let platforms: serde_json::Map<String, serde_json::Value> = unimux_update::feed::platform_keys()
        .iter()
        .map(|k| {
            (k.to_string(), serde_json::json!({ "url": format!("{base}/unimux-Setup-{version}.exe"), "signature": signature }))
        })
        .collect();
    serde_json::json!({ "version": version, "notes": "", "pub_date": "2026-11-07T00:00:00Z", "platforms": platforms })
        .to_string()
        .into_bytes()
}

fn backend(server: &Server, dir: &std::path::Path) -> Arc<NetBackend> {
    NetBackend::new(NetBackendOptions {
        client: None,
        dev_feed: Some(server.base.clone()),
        public_key: TEST_KEY.to_string(),
        current_version: "1.2.0".into(),
        download_dir: dir.join("pending"),
        manual: None,
        log: Arc::new(|_| {}),
    })
}

#[tokio::test]
async fn reads_the_feed_downloads_verifies_and_reuses_the_artifact() {
    let server = serve().await;
    server.files.lock().insert("/latest.json".into(), feed(&server.base, "1.2.1", SIG));
    server.files.lock().insert("/unimux-Setup-1.2.1.exe".into(), PAYLOAD.to_vec());
    let dir = tempfile::tempdir().unwrap();
    let b = backend(&server, dir.path());
    let found = b.lookup().await.unwrap();
    assert_eq!(found.latest.as_deref(), Some("1.2.1"));
    assert_eq!(found.update.as_ref().map(|u| u.version.as_str()), Some("1.2.1"));
    assert!(found.update.unwrap().manual.is_none());
    let head = server.requests.lock()[0].to_ascii_lowercase();
    assert!(head.starts_with("get /latest.json "), "{head}");
    assert!(head.contains("cache-control: no-cache") && head.contains("user-agent: unimux-updater"), "{head}");

    let reports: Arc<Mutex<Vec<Progress>>> = Arc::default();
    let r = reports.clone();
    b.download("1.2.1", Arc::new(move |p| r.lock().push(p)), CancellationToken::new()).await.unwrap();
    let artifact = b.artifact("1.2.1").unwrap();
    assert_eq!(std::fs::read(&artifact).unwrap(), PAYLOAD);
    assert_eq!(artifact.file_name().unwrap(), "unimux-Setup-1.2.1.exe");
    let last = *reports.lock().last().unwrap();
    assert_eq!((last.percent, last.transferred, last.total), (100.0, Some(PAYLOAD.len() as f64), Some(PAYLOAD.len() as f64)));
    // Nothing but the artifact is left in the folder (no partial file).
    assert_eq!(std::fs::read_dir(dir.path().join("pending")).unwrap().count(), 1);

    // A second run finds the verified copy and downloads nothing.
    let again = backend(&server, dir.path());
    again.lookup().await.unwrap();
    let before = server.requests.lock().len();
    again.download("1.2.1", Arc::new(|_| {}), CancellationToken::new()).await.unwrap();
    assert_eq!(server.requests.lock().len(), before);

    // Nothing newer: no update.
    let current = NetBackend::new(NetBackendOptions {
        current_version: "1.2.1".into(),
        ..NetBackendOptions {
            client: None,
            dev_feed: Some(server.base.clone()),
            public_key: TEST_KEY.to_string(),
            current_version: String::new(),
            download_dir: dir.path().join("pending"),
            manual: None,
            log: Arc::new(|_| {}),
        }
    });
    assert!(current.lookup().await.unwrap().update.is_none());
}

#[tokio::test]
async fn a_corrupt_signature_is_refused_and_the_file_removed() {
    let server = serve().await;
    // The signature of another file: well-formed, wrong.
    let mut other = PAYLOAD.to_vec();
    other.push(b'!');
    server.files.lock().insert("/latest.json".into(), feed(&server.base, "1.2.1", SIG));
    server.files.lock().insert("/unimux-Setup-1.2.1.exe".into(), other);
    let dir = tempfile::tempdir().unwrap();
    let b = backend(&server, dir.path());
    b.lookup().await.unwrap();
    let error = b.download("1.2.1", Arc::new(|_| {}), CancellationToken::new()).await.unwrap_err();
    assert_eq!(error, VERIFY_FAILED);
    assert!(b.artifact("1.2.1").is_none());
    assert_eq!(std::fs::read_dir(dir.path().join("pending")).unwrap().count(), 0);
}

#[tokio::test]
async fn a_corrupt_sig_through_the_coordinator_shows_the_error_state() {
    let server = serve().await;
    server.files.lock().insert("/latest.json".into(), feed(&server.base, "1.2.1", "bm90IGEgc2lnbmF0dXJl"));
    server.files.lock().insert("/unimux-Setup-1.2.1.exe".into(), PAYLOAD.to_vec());
    let dir = tempfile::tempdir().unwrap();
    let b = backend(&server, dir.path());
    let states: Arc<Mutex<Vec<Status>>> = Arc::default();
    let s = states.clone();
    let c = UpdateCoordinator::new(CoordinatorOptions::new(
        b.clone(),
        Arc::new(move |state| s.lock().push(state.status)),
        unimux_update::RELEASES_URL,
    ));
    assert_eq!(c.check(CheckReason::Background).await, Ok(Some("1.2.1".into())));
    let result = tokio::time::timeout(Duration::from_secs(20), c.download()).await.unwrap();
    assert!(result.is_err());
    let state = c.get_state();
    assert_eq!(
        (state.status, state.version.as_deref(), state.message.as_deref()),
        (Status::Error, Some("1.2.1"), Some(VERIFY_FAILED))
    );
    assert!(!c.lock_handover(Some("1.2.1")));
    assert!(!states.lock().contains(&Status::Ready));
}

#[tokio::test]
async fn a_server_error_and_a_broken_feed_are_reported() {
    let server = serve().await;
    let dir = tempfile::tempdir().unwrap();
    let b = backend(&server, dir.path());
    assert_eq!(b.lookup().await.unwrap_err(), unimux_update::net::SERVER_ERROR);
    server.files.lock().insert("/latest.json".into(), b"<html>".to_vec());
    assert_eq!(b.lookup().await.unwrap_err(), unimux_update::coordinator::CHECK_FAILED);
}

#[test]
fn artifact_names_come_from_the_url() {
    use unimux_update::net::file_name_of;
    assert_eq!(
        file_name_of("https://github.com/a/b/releases/download/v1/unimux-Setup-1.2.1.exe", "1.2.1"),
        "unimux-Setup-1.2.1.exe"
    );
    assert_eq!(file_name_of("https://x/unimux%20Setup%201.2.1.exe", "1.2.1"), "unimuxSetup1.2.1.exe");
    assert_eq!(file_name_of("https://x/..", "1.2.1"), "unimux-update-1.2.1");
    assert_eq!(file_name_of("not a url", "1.2.1"), "unimux-update-1.2.1");
}
