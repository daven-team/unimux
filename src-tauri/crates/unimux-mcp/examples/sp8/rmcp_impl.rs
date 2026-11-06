//! SP8 spike, candidate A: rmcp 3.9 `StreamableHttpService` behind an axum middleware for the 1.1.4 front checks
//! (Host 403, path 404, Bearer 401; rmcp checks Origin only when `allowed_origins` is set, which this candidate does
//! not). Built the way the rmcp docs recommend, with only the knobs rmcp exposes: sessions on (`legacy_session_mode`),
//! protocol versions limited to the 1.1.4 list, form elicitation through `Peer::create_elicitation_with_timeout`, progress
//! through `Peer::notify_progress`, cancellation through `ctx.ct`. What rmcp cannot express (MCP tasks of 2025-11-25,
//! `execution.taskSupport`, the per-request stateless/session choice, session-per-token binding and limits, the exact error
//! texts, aborting the calls of a vanished client) is listed in docs/tauri/spikes/SP8.md. Not shipped: SP8 chose the custom
//! dispatcher.

use std::borrow::Cow;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use parking_lot::Mutex;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ElicitRequestParams, Implementation, ListToolsResult,
    PaginatedRequestParams, ProgressNotificationParam, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::{Value, json};

use super::fake::{CallCtx, CallError, Elicit, ElicitAnswer, Fake, Progress, cap_result};

type Tokens = Arc<Mutex<HashMap<String, String>>>;

#[derive(Clone)]
struct Handler {
    fake: Arc<Fake>,
    tokens: Tokens,
    version: String,
    progress_every: Duration,
}

fn cell_of(tokens: &Tokens, headers: &HeaderMap) -> Option<String> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    tokens.lock().get(token).cloned()
}

impl Handler {
    fn cell(&self, ctx: &RequestContext<RoleServer>) -> Option<String> {
        let parts = ctx.extensions.get::<axum::http::request::Parts>()?;
        cell_of(&self.tokens, &parts.headers)
    }
}

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        // One handler per session, created without the request: the instructions cannot name the cell (1.1.4 does).
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("unimux", self.version.clone()))
            .with_instructions(self.fake.instructions.clone())
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Owned(vec![
            ProtocolVersion::V_2024_11_05,
            ProtocolVersion::V_2025_03_26,
            ProtocolVersion::V_2025_06_18,
            ProtocolVersion::V_2025_11_25,
        ])
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let cell = self.cell(&ctx).ok_or_else(|| McpError::invalid_request("Agent connection has expired.", None))?;
        self.fake.events.push(json!({ "kind": "tools-list", "cell": cell }));
        // The verbatim 1.1.4 tools go through rmcp's typed Tool: unknown keys (execution.taskSupport) are dropped here.
        let tools: Vec<Tool> = self.fake.tools_for(&cell).into_iter().filter_map(|t| serde_json::from_value(t).ok()).collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let Some(cell) = self.cell(&ctx) else {
            return Ok(CallToolResult::error(vec![ContentBlock::text("Agent connection has expired.")]).into());
        };
        let args = request.arguments.clone().map(Value::Object).unwrap_or_else(|| json!({}));
        let peer = ctx.peer.clone();
        let progress: Option<Progress> = ctx.meta.get_progress_token().map(|token| {
            let peer = peer.clone();
            Arc::new(move |progress: f64, total: f64, message: String| {
                let (peer, token) = (peer.clone(), token.clone());
                tokio::spawn(async move {
                    let mut param = ProgressNotificationParam::new(token, progress).with_total(total);
                    param.message = Some(message);
                    let _ = peer.notify_progress(param).await;
                });
            }) as Progress
        });
        let form = peer.peer_info().and_then(|i| i.capabilities.elicitation.clone()).is_some();
        let elicit: Option<Elicit> = form.then(|| {
            let peer = peer.clone();
            Arc::new(move |message: String, schema: Value| {
                let peer = peer.clone();
                Box::pin(async move {
                    let Ok(requested_schema) = serde_json::from_value(schema) else {
                        return ElicitAnswer { action: "cancel".into(), content: None };
                    };
                    let params = ElicitRequestParams::FormElicitationParams { meta: None, message, requested_schema };
                    match peer.create_elicitation_with_timeout(params, Some(Duration::from_secs(120))).await {
                        Ok(answer) => ElicitAnswer {
                            action: serde_json::to_value(answer.action)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_string))
                                .unwrap_or("cancel".into()),
                            content: answer.content,
                        },
                        Err(_) => ElicitAnswer { action: "cancel".into(), content: None },
                    }
                }) as super::fake::BoxFuture<'static, ElicitAnswer>
            }) as Elicit
        });
        let call = CallCtx { cell, cancel: ctx.ct.clone(), elicit, progress, progress_every: self.progress_every, task: false };
        match self.fake.call(&request.name, &args, call).await {
            Ok(value) => Ok(CallToolResult::success(vec![ContentBlock::text(cap_result(&value.to_string(), 60_000))]).into()),
            Err(CallError::Unknown) => Err(McpError::invalid_params(format!("Unknown tool: {}", request.name), None)),
            Err(CallError::Tool(text)) => Ok(CallToolResult::error(vec![ContentBlock::text(text)]).into()),
            Err(CallError::Aborted) => Ok(CallToolResult::error(vec![ContentBlock::text("This operation was aborted")]).into()),
        }
    }
}

pub struct RmcpServer {
    pub url: String,
    tokens: Tokens,
    pub sessions: Arc<LocalSessionManager>,
}

#[derive(Clone)]
struct Front {
    tokens: Tokens,
    port: u16,
}

/// The 1.1.4 front checks that rmcp leaves to the application (rmcp also checks Host; Origin only with `allowed_origins`).
async fn front(State(front): State<Front>, req: Request, next: Next) -> Response {
    let host = req.headers().get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
    let port = front.port;
    let empty = |s: StatusCode| Response::builder().status(s).body(Body::empty()).unwrap();
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return empty(StatusCode::FORBIDDEN);
    }
    if req.uri().path() != "/mcp" {
        return empty(StatusCode::NOT_FOUND);
    }
    if cell_of(&front.tokens, req.headers()).is_none() {
        return empty(StatusCode::UNAUTHORIZED);
    }
    next.run(req).await
}

impl RmcpServer {
    pub async fn start(fake: Arc<Fake>, version: String, progress_every: Duration) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let port = listener.local_addr()?.port();
        let tokens: Tokens = Arc::default();
        let sessions = Arc::new(LocalSessionManager::default());
        let handler = Handler { fake, tokens: tokens.clone(), version, progress_every };
        let config = StreamableHttpServerConfig::default()
            .with_legacy_session_mode(true)
            .with_sse_keep_alive(Some(Duration::from_secs(15)))
            .with_max_request_body_bytes(256 * 1024);
        let service = StreamableHttpService::new(move || Ok(handler.clone()), sessions.clone(), config);
        let app = Router::new()
            .route_service("/mcp", service)
            .layer(middleware::from_fn_with_state(Front { tokens: tokens.clone(), port }, front));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self { url: format!("http://127.0.0.1:{port}/mcp"), tokens, sessions })
    }

    pub fn issue_token(&self, cell: &str) -> String {
        self.revoke_cell(cell);
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("os random");
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.tokens.lock().insert(token.clone(), cell.to_string());
        token
    }

    /// Revocation reaches only the token map: rmcp sessions are not bound to tokens, so open sessions and running calls
    /// of the cell continue (1.1.4 closes them and aborts their calls).
    pub fn revoke_cell(&self, cell: &str) {
        self.tokens.lock().retain(|_, c| c != cell);
    }

    pub async fn session_count(&self) -> usize {
        self.sessions.sessions.read().await.len()
    }
}
