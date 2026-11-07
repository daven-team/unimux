//! token-transport "sends one JSON POST with the three fields and the product User-Agent, and stores the rotated tokens":
//! a renewal through the real http_fetch client against a local mock token endpoint (the exact header set on the wire).

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use unimux_accounts::refresh::renew::{OAUTH_CLIENT_ID, RefreshDeps, Renewer};
use unimux_accounts::refresh::{ProfileLocks, RefreshOutcome};

async fn read_request(sock: &mut tokio::net::TcpStream) -> (String, String) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = sock.read(&mut chunk).await.unwrap();
        assert!(n > 0, "connection closed early");
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf).into_owned();
        if let Some(end) = text.find("\r\n\r\n") {
            let head = text[..end].to_string();
            let len = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                .unwrap_or(0);
            if buf.len() >= end + 4 + len {
                return (head, text[end + 4..end + 4 + len].to_string());
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_renewal_sends_exactly_the_token_headers_and_stores_the_rotated_tokens() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let (head, body) = read_request(&mut sock).await;
        let answer = r#"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":60}"#;
        let reply =
            format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{answer}", answer.len());
        sock.write_all(reply.as_bytes()).await.unwrap();
        (head, body)
    });

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".credentials.json"),
        r#"{"claudeAiOauth":{"accessToken":"old-access","refreshToken":"old-refresh","expiresAt":1}}"#,
    )
    .unwrap();
    let renewer = Renewer::new(Arc::new(ProfileLocks::new()));
    let deps = RefreshDeps {
        fetch: Arc::new(unimux_net::HttpClient::new().unwrap()),
        now: Arc::new(|| 1000.0),
        token_url: Some(format!("http://127.0.0.1:{port}/v1/oauth/token")),
        delay: None,
        user_agent: Some("unimux/1.2.0".into()),
        limits: None,
        random: None,
    };
    assert_eq!(renewer.refresh(dir.path(), &deps).await, RefreshOutcome::Ok);
    let (head, body) = server.await.unwrap();
    let mut lines = head.lines();
    assert_eq!(lines.next(), Some("POST /v1/oauth/token HTTP/1.1"));
    let mut names: Vec<String> = lines.map(|l| l.split(':').next().unwrap().trim().to_ascii_lowercase()).collect();
    names.sort();
    assert_eq!(names, ["connection", "content-length", "content-type", "host", "user-agent"]);
    assert!(head.to_ascii_lowercase().contains("user-agent: unimux/1.2.0"));
    assert!(head.to_ascii_lowercase().contains("connection: close"));
    assert_eq!(
        body,
        format!(r#"{{"grant_type":"refresh_token","refresh_token":"old-refresh","client_id":"{OAUTH_CLIENT_ID}"}}"#)
    );
    let stored = std::fs::read_to_string(dir.path().join(".credentials.json")).unwrap();
    assert_eq!(stored, r#"{"claudeAiOauth":{"accessToken":"new-access","refreshToken":"new-refresh","expiresAt":61000}}"#);
}
