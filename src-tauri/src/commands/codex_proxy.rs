use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, Request, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use futures_util::{stream, Stream, StreamExt};
use reqwest::Url;
use serde::Serialize;
use std::{
    collections::VecDeque,
    pin::Pin,
    sync::{atomic::{AtomicI64, Ordering}, Arc, Mutex},
    time::Instant,
};
use tauri::State as TauriState;

const MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;
const MAX_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECORDS: usize = 12;
static NEXT_REQUEST_ID: AtomicI64 = AtomicI64::new(1);
static NEXT_REVISION: AtomicI64 = AtomicI64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProxyRequest {
    id: i64,
    #[serde(skip)]
    revision: i64,
    url: String,
    method: String,
    status: Option<u16>,
    started_at: i64,
    time_ms: u64,
    failed: bool,
    request_bytes: u64,
    response_bytes: u64,
    request_message: String,
    response_message: String,
    truncated: bool,
    in_flight: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInfo {
    running: bool,
    upstream_url: Option<String>,
    proxy_base_url: Option<String>,
    provider_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyBatch {
    cursor: i64,
    requests: Vec<CodexProxyRequest>,
    info: ProxyInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProvider {
    provider_id: Option<String>,
    upstream_url: Option<String>,
}

#[derive(Default)]
struct CaptureStore {
    next_id: AtomicI64,
    requests: Mutex<VecDeque<CodexProxyRequest>>,
}

#[derive(Clone)]
struct ProxyRuntime {
    upstream: Url,
    local_path_prefix: String,
    client: reqwest::Client,
    captures: Arc<CaptureStore>,
}

struct RunningProxy {
    info: ProxyInfo,
    captures: Arc<CaptureStore>,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct CodexProxyState(Mutex<Option<RunningProxy>>);

fn current_provider() -> DetectedProvider {
    let path = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .map(|root| root.join("config.toml"));
    let Some(path) = path else { return DetectedProvider { provider_id: None, upstream_url: None }; };
    let Ok(source) = std::fs::read_to_string(path) else { return DetectedProvider { provider_id: None, upstream_url: None }; };
    let Ok(config) = source.parse::<toml::Value>() else { return DetectedProvider { provider_id: None, upstream_url: None }; };
    let Some(provider_id) = config.get("model_provider").and_then(toml::Value::as_str).map(str::to_owned) else {
        return DetectedProvider { provider_id: None, upstream_url: None };
    };
    let upstream_url = config.get("model_providers")
        .and_then(|providers| providers.get(&provider_id))
        .and_then(|provider| provider.get("base_url"))
        .and_then(toml::Value::as_str)
        .and_then(|value| validate_upstream(value).ok().map(|url| url.to_string()));
    DetectedProvider { provider_id: Some(provider_id), upstream_url }
}

fn validate_upstream(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|error| format!("上游地址无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("上游地址必须是 HTTP 或 HTTPS URL".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("上游地址不能包含用户名、密码、查询参数或片段".into());
    }
    Ok(url)
}

fn safe_url(url: &Url) -> String {
    let mut safe = url.clone();
    safe.set_query(url.query().map(|_| "[redacted]"));
    safe.set_fragment(None);
    safe.to_string()
}

fn is_hop_header(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization" |
        "te" | "trailer" | "transfer-encoding" | "upgrade" | "host")
}

fn is_secret_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("token") || lower.contains("secret") || lower.ends_with("-key") || matches!(lower.as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "set-cookie" |
        "api-key" | "x-api-key" | "x-goog-api-key" | "openai-api-key")
}

fn display_headers(headers: &HeaderMap) -> String {
    let mut values = Vec::new();
    for (name, value) in headers.iter() {
        let name = name.as_str();
        let value = if is_secret_header(name) { "[REDACTED]".to_owned() }
            else { value.to_str().unwrap_or("[non-text header]").to_owned() };
        values.push(format!("{name}: {value}"));
    }
    values.join("\r\n")
}

fn body_text(bytes: &[u8], total_bytes: u64) -> (String, bool) {
    let truncated = total_bytes > bytes.len() as u64;
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => format!("[二进制正文，Base64]\r\n{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)),
    };
    if truncated { (format!("{text}\r\n\r\n[正文已截断：显示 {} / {total_bytes} 字节]", bytes.len()), true) }
    else { (text, false) }
}

// Decode only the diagnostic copy. The bytes sent upstream stay untouched,
// including Codex versions that compress JSON requests with zstd.
fn captured_body(bytes: &[u8], total_bytes: u64, encoding: Option<&str>) -> (String, bool) {
    use std::io::Read;
    if total_bytes > bytes.len() as u64 { return body_text(bytes, total_bytes); }
    let decoder: Option<Box<dyn Read + '_>> = match encoding.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "gzip" => Some(Box::new(flate2::read::GzDecoder::new(bytes))),
        "deflate" => Some(Box::new(flate2::read::ZlibDecoder::new(bytes))),
        "zstd" => match zstd::stream::read::Decoder::new(bytes) {
            Ok(decoder) => Some(Box::new(decoder)),
            Err(_) => None,
        },
        _ => None,
    };
    if let Some(decoder) = decoder {
        let mut decoded = Vec::new();
        match decoder.take((MAX_CAPTURE_BYTES + 1) as u64).read_to_end(&mut decoded) {
            Ok(_) => {
                let truncated = decoded.len() > MAX_CAPTURE_BYTES;
                decoded.truncate(MAX_CAPTURE_BYTES);
                let (text, _) = body_text(&decoded, decoded.len() as u64);
                let note = if truncated { "，解压后的正文超过显示限制，已截断" } else { "" };
                return (format!("[正文已按 Content-Encoding 解压显示{note}；转发保留原始字节]\r\n{text}"), truncated);
            }
            Err(_) => return (format!("[正文解压失败，以下为原始内容]\r\n{}", body_text(bytes, total_bytes).0), false),
        }
    }
    body_text(bytes, total_bytes)
}

fn push_capture(store: &CaptureStore, mut request: CodexProxyRequest) -> i64 {
    if request.id == 0 { request.id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed); }
    let id = request.id;
    let mut items = store.requests.lock().unwrap_or_else(|error| error.into_inner());
    request.revision = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
    store.next_id.store(request.revision, Ordering::Relaxed);
    items.retain(|item| item.id != id);
    items.push_back(request);
    while items.len() > MAX_RECORDS { items.pop_front(); }
    id
}

fn response_error(status: StatusCode, message: &str) -> Response<Body> {
    let mut response = Response::new(Body::from(message.to_owned()));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

fn upstream_target(upstream: &Url, local_path_prefix: &str, uri: &axum::http::Uri) -> Result<Url, String> {
    let local_path = uri.path();
    let suffix = local_path.strip_prefix(local_path_prefix).unwrap_or(local_path);
    let suffix = if suffix.is_empty() { "/" } else if suffix.starts_with('/') { suffix } else { "__invalid__" };
    if suffix == "__invalid__" { return Err("Codex 请求路径无效".into()); }
    let mut target = upstream.clone();
    let base_path = upstream.path().trim_end_matches('/');
    target.set_path(&format!("{base_path}{suffix}"));
    target.set_query(uri.query());
    Ok(target)
}

async fn forward_request(State(runtime): State<ProxyRuntime>, request: Request<Body>) -> Response<Body> {
    let started = Instant::now();
    let started_at = chrono::Utc::now().timestamp_millis();
    let method = request.method().clone();
    let method_text = method.to_string();
    let uri = request.uri().clone();
    let headers = request.headers().clone();
    let target = match upstream_target(&runtime.upstream, &runtime.local_path_prefix, &uri) {
        Ok(target) => target,
        Err(error) => return response_error(StatusCode::BAD_REQUEST, &error),
    };
    let shown_url = safe_url(&target);
    let body = match to_bytes(request.into_body(), MAX_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => return response_error(StatusCode::PAYLOAD_TOO_LARGE, "Codex 请求正文超过本地代理的 128 MiB 限制"),
    };
    let request_bytes = body.len() as u64;
    let (request_body, request_truncated) = captured_body(&body[..body.len().min(MAX_CAPTURE_BYTES)], request_bytes,
        headers.get(header::CONTENT_ENCODING).and_then(|value| value.to_str().ok()));
    let request_message = format!("{method_text} {shown_url}\r\n{}\r\n\r\n{request_body}", display_headers(&headers));
    let request_id = push_capture(&runtime.captures, CodexProxyRequest {
        id: 0, revision: 0, url: shown_url.clone(), method: method_text.clone(), status: None,
        started_at, time_ms: 0, failed: false, request_bytes, response_bytes: 0,
        request_message: request_message.clone(), response_message: "[正在等待上游响应]".into(),
        truncated: request_truncated, in_flight: true,
    });

    let mut outgoing = runtime.client.request(method, target.clone()).body(body);
    for (name, value) in &headers {
        if is_hop_header(name.as_str()) || name == header::CONTENT_LENGTH { continue; }
        outgoing = outgoing.header(name, value);
    }
    let response = match outgoing.send().await {
        Ok(response) => response,
        Err(error) => {
            let error = error.without_url();
            let elapsed = started.elapsed().as_millis() as u64;
            let response_message = format!("502 Bad Gateway\r\n\r\n{error}");
            push_capture(&runtime.captures, CodexProxyRequest {
                id: request_id, revision: 0, url: shown_url, method: method_text, status: Some(502), started_at,
                time_ms: elapsed, failed: true, request_bytes, response_bytes: 0,
                request_message, response_message, truncated: request_truncated, in_flight: false,
            });
            return response_error(StatusCode::BAD_GATEWAY, &error.to_string());
        }
    };

    let status = response.status();
    let response_headers = response.headers().clone();
    let response_header_text = display_headers(&response_headers);
    let response_stream: Pin<Box<dyn Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send>> = Box::pin(response.bytes_stream());
    let mut capture = ResponseCapture {
        id: request_id,
        stream: response_stream,
        store: runtime.captures,
        method: method_text,
        url: shown_url,
        status: status.as_u16(),
        started_at,
        started,
        request_bytes,
        response_bytes: 0,
        request_message,
        response_headers: response_header_text,
        response_encoding: response_headers.get(header::CONTENT_ENCODING).and_then(|value| value.to_str().ok()).map(str::to_owned),
        response_body: Vec::new(),
        truncated: request_truncated,
        finished: false,
        published_at: Instant::now(),
    };
    capture.publish(None);
    let output = stream::unfold(capture, |mut state| async move {
        if state.finished { return None; }
        match state.stream.next().await {
            Some(Ok(chunk)) => {
                state.response_bytes += chunk.len() as u64;
                let remaining = MAX_CAPTURE_BYTES.saturating_sub(state.response_body.len());
                let keep = remaining.min(chunk.len());
                state.response_body.extend_from_slice(&chunk[..keep]);
                if keep < chunk.len() { state.truncated = true; }
                if state.published_at.elapsed() >= std::time::Duration::from_secs(1) {
                    state.publish(None);
                    state.published_at = Instant::now();
                }
                Some((Ok::<_, std::io::Error>(chunk), state))
            }
            Some(Err(error)) => {
                let error_text = error.without_url().to_string();
                state.complete(Some(&error_text));
                Some((Err(std::io::Error::other(error_text)), state))
            }
            None => {
                state.complete(None);
                None
            }
        }
    });
    let mut outgoing = Response::new(Body::from_stream(output));
    *outgoing.status_mut() = status;
    for (name, value) in response_headers.iter() {
        if is_hop_header(name.as_str()) { continue; }
        if let Ok(name) = HeaderName::from_bytes(name.as_str().as_bytes()) {
            outgoing.headers_mut().append(name, value.clone());
        }
    }
    outgoing
}

struct ResponseCapture {
    id: i64,
    stream: Pin<Box<dyn Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send>>,
    store: Arc<CaptureStore>,
    method: String,
    url: String,
    status: u16,
    started_at: i64,
    started: Instant,
    request_bytes: u64,
    response_bytes: u64,
    request_message: String,
    response_headers: String,
    response_encoding: Option<String>,
    response_body: Vec<u8>,
    truncated: bool,
    finished: bool,
    published_at: Instant,
}

impl ResponseCapture {
    fn complete(&mut self, error: Option<&str>) {
        self.finished = true;
        self.publish(error);
    }

    fn publish(&mut self, error: Option<&str>) {
        let (body, body_truncated) = captured_body(&self.response_body, self.response_bytes, self.response_encoding.as_deref());
        let response_message = format!("{} {}\r\n{}\r\n\r\n{}{}",
            self.status, StatusCode::from_u16(self.status).unwrap_or(StatusCode::OK).canonical_reason().unwrap_or(""),
            self.response_headers, body, error.map(|value| format!("\r\n\r\n[响应流中断：{value}]")).unwrap_or_default());
        self.id = push_capture(&self.store, CodexProxyRequest {
            id: self.id, revision: 0, url: self.url.clone(), method: self.method.clone(), status: Some(self.status),
            started_at: self.started_at, time_ms: self.started.elapsed().as_millis() as u64,
            failed: error.is_some() || self.status >= 400, request_bytes: self.request_bytes,
            response_bytes: self.response_bytes, request_message: self.request_message.clone(),
            response_message, truncated: self.truncated || body_truncated, in_flight: !self.finished,
        });
    }
}

impl Drop for ResponseCapture {
    fn drop(&mut self) {
        if !self.finished { self.complete(Some("客户端已断开连接")); }
    }
}

#[tauri::command]
pub fn codex_proxy_detect() -> DetectedProvider { current_provider() }

#[tauri::command]
pub fn codex_proxy_status(state: TauriState<'_, CodexProxyState>) -> ProxyInfo {
    state.0.lock().unwrap_or_else(|error| error.into_inner())
        .as_ref().map(|running| running.info.clone())
        .unwrap_or_else(|| ProxyInfo { running: false, upstream_url: None, proxy_base_url: None, provider_id: current_provider().provider_id })
}

#[tauri::command]
pub async fn codex_proxy_start(upstream_url: String, state: TauriState<'_, CodexProxyState>) -> Result<ProxyInfo, String> {
    let upstream = validate_upstream(&upstream_url)?;
    let provider_id = current_provider().provider_id;
    {
        let current = state.0.lock().map_err(|error| error.to_string())?;
        if let Some(running) = current.as_ref() {
            if running.info.upstream_url.as_deref() == Some(upstream.as_str()) { return Ok(running.info.clone()); }
            return Err("本地 Codex 代理已运行；请先停止，再修改上游地址".into());
        }
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let local_path_prefix = upstream.path().trim_end_matches('/').to_owned();
    let path = if local_path_prefix.is_empty() { String::new() } else { local_path_prefix.clone() };
    let proxy_base_url = format!("http://127.0.0.1:{}{}", address.port(), path);
    let runtime = ProxyRuntime {
        upstream: upstream.clone(), local_path_prefix,
        client: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
            .build().map_err(|error| error.to_string())?,
        captures: Arc::new(CaptureStore::default()),
    };
    let app = Router::new().fallback(any(forward_request)).with_state(runtime.clone());
    let (shutdown, receive) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, app).with_graceful_shutdown(async { let _ = receive.await; }).await {
            log::error!("Codex local proxy stopped: {error}");
        }
    });
    let info = ProxyInfo {
        running: true, upstream_url: Some(upstream.to_string()),
        proxy_base_url: Some(proxy_base_url), provider_id,
    };
    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    if current.is_some() {
        let _ = shutdown.send(());
        task.abort();
        return Err("本地 Codex 代理刚刚启动，请稍后重试".into());
    }
    *current = Some(RunningProxy { info: info.clone(), captures: runtime.captures, shutdown, task });
    Ok(info)
}

#[tauri::command]
pub async fn codex_proxy_stop(state: TauriState<'_, CodexProxyState>) -> Result<(), String> {
    let running = state.0.lock().map_err(|error| error.to_string())?.take();
    if let Some(running) = running {
        let _ = running.shutdown.send(());
        running.task.abort();
    }
    Ok(())
}

#[tauri::command]
pub fn codex_proxy_requests(cursor: Option<i64>, state: TauriState<'_, CodexProxyState>) -> ProxyBatch {
    let guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
    let Some(running) = guard.as_ref() else {
        return ProxyBatch { cursor: cursor.unwrap_or(0), requests: vec![], info: ProxyInfo {
            running: false, upstream_url: None, proxy_base_url: None, provider_id: current_provider().provider_id,
        }};
    };
    let items = running.captures.requests.lock().unwrap_or_else(|error| error.into_inner());
    let latest = running.captures.next_id.load(Ordering::Relaxed);
    let start = cursor.filter(|value| *value <= latest).unwrap_or(0);
    let requests = items.iter().filter(|item| item.revision > start).cloned().collect::<Vec<_>>();
    ProxyBatch { cursor: latest, requests, info: running.info.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_url_keeps_provider_prefix_and_query_for_forwarding() {
        let upstream = Url::parse("https://api.example.test/v1").unwrap();
        let uri = "/v1/responses?stream=true".parse().unwrap();
        assert_eq!(upstream_target(&upstream, "/v1", &uri).unwrap().as_str(), "https://api.example.test/v1/responses?stream=true");
    }

    #[test]
    fn display_redacts_credentials_and_limits_large_body_capture() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer hidden"));
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        let shown = display_headers(&headers);
        assert!(shown.contains("[REDACTED]"));
        assert!(!shown.contains("hidden"));
        let (body, truncated) = body_text(b"shown", 100);
        assert!(truncated);
        assert!(body.contains("5 / 100"));
    }

    #[test]
    fn rejects_upstream_urls_that_can_hide_credentials() {
        assert!(validate_upstream("https://user:pass@example.test/v1").is_err());
        assert!(validate_upstream("https://example.test/v1?api_key=hidden").is_err());
        assert!(validate_upstream("file:///etc/passwd").is_err());
    }

    #[test]
    fn decodes_compressed_diagnostic_copies() {
        use std::io::Write;
        let original = br#"{"input":"test","stream":true}"#;
        let zstd = zstd::stream::encode_all(&original[..], 1).unwrap();
        let (text, truncated) = captured_body(&zstd, zstd.len() as u64, Some("zstd"));
        assert!(text.ends_with(std::str::from_utf8(original).unwrap()));
        assert!(!truncated);
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(original).unwrap();
        let gzip = gzip.finish().unwrap();
        let (text, truncated) = captured_body(&gzip, gzip.len() as u64, Some("gzip"));
        assert!(text.ends_with(std::str::from_utf8(original).unwrap()));
        assert!(!truncated);
    }

    #[tokio::test]
    async fn forwards_exact_request_and_streams_before_completion() {
        use tokio::{net::TcpListener, sync::oneshot, time::{timeout, Duration}};

        let (release, receive) = oneshot::channel::<()>();
        let (sent, received) = oneshot::channel();
        let release_receive = Arc::new(Mutex::new(Some(receive)));
        let sent = Arc::new(Mutex::new(Some(sent)));
        let upstream = Router::new().fallback(any(move |request: Request<Body>| {
            let release_receive = release_receive.clone();
            let sent = sent.clone();
            async move {
                let headers = request.headers().clone();
                let uri = request.uri().to_string();
                let body = to_bytes(request.into_body(), MAX_REQUEST_BYTES).await.unwrap();
                sent.lock().unwrap().take().unwrap().send((uri, headers, body)).unwrap();
                let receive = release_receive.lock().unwrap().take().unwrap();
                let first = stream::once(async { Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"data: first\n\n")) });
                let last = stream::once(async move {
                    let _ = receive.await;
                    Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"data: last\n\n"))
                });
                Response::builder().status(201)
                    .header("content-type", "text/event-stream")
                    .header("set-cookie", "hidden-response-cookie")
                    .body(Body::from_stream(first.chain(last))).unwrap()
            }
        }));
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}/v1", upstream_listener.local_addr().unwrap());
        let upstream_task = tokio::spawn(async move { axum::serve(upstream_listener, upstream).await.unwrap(); });
        let captures = Arc::new(CaptureStore::default());
        let runtime = ProxyRuntime {
            upstream: Url::parse(&upstream_url).unwrap(), local_path_prefix: "/v1".into(),
            client: reqwest::Client::new(), captures: captures.clone(),
        };
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}/v1/responses?trace=private", proxy_listener.local_addr().unwrap());
        let proxy_task = tokio::spawn(async move {
            axum::serve(proxy_listener, Router::new().fallback(any(forward_request)).with_state(runtime)).await.unwrap();
        });
        let original = r#"{ "input": [{"role":"user","content":"你好"}], "encrypted_content":"opaque", "stream":true }"#;
        let response = timeout(Duration::from_secs(3), reqwest::Client::new().post(proxy_url)
            .header("authorization", "Bearer hidden-request-token")
            .header("content-type", "application/json")
            .body(original).send()).await.unwrap().unwrap();
        assert_eq!(response.status(), 201);
        assert_eq!(response.headers()["set-cookie"], "hidden-response-cookie");
        let (uri, headers, body) = received.await.unwrap();
        assert_eq!(uri, "/v1/responses?trace=private");
        assert_eq!(body.as_ref(), original.as_bytes());
        assert_eq!(headers["authorization"], "Bearer hidden-request-token");
        let mut chunks = response.bytes_stream();
        let first = timeout(Duration::from_secs(2), chunks.next()).await.unwrap().unwrap().unwrap();
        assert_eq!(first.as_ref(), b"data: first\n\n");
        let id = {
            let records = captures.requests.lock().unwrap();
            assert_eq!(records.len(), 1);
            let record = records.front().unwrap();
            assert!(record.in_flight);
            assert!(record.request_message.ends_with(original));
            assert!(!record.request_message.contains("hidden-request-token"));
            assert!(!record.url.contains("private"));
            record.id
        };
        release.send(()).unwrap();
        let mut result = first.to_vec();
        while let Some(chunk) = timeout(Duration::from_secs(2), chunks.next()).await.unwrap() {
            result.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(result, b"data: first\n\ndata: last\n\n");
        let records = captures.requests.lock().unwrap();
        assert_eq!(records.len(), 1, "stream snapshots update the same record");
        let record = records.front().unwrap();
        assert_eq!(record.id, id);
        assert!(!record.in_flight);
        assert!(!record.failed);
        assert_eq!(record.request_bytes, original.len() as u64);
        assert_eq!(record.response_bytes, result.len() as u64);
        assert!(record.response_message.ends_with("data: first\n\ndata: last\n\n"));
        assert!(!record.response_message.contains("hidden-response-cookie"));
        upstream_task.abort();
        proxy_task.abort();
    }
}
