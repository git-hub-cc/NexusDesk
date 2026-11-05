//! Read Codex's HTTP diagnostics without opening its credential files.
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRequest {
    id: i64,
    url: String,
    method: String,
    status: Option<u16>,
    started_at: i64,
    failed: bool,
    request_message: String,
    response_message: String,
}

#[derive(Serialize)]
pub struct Batch {
    cursor: i64,
    requests: Vec<CodexRequest>,
    available: bool,
}

fn parse_request(id: i64, timestamp: i64, body: &str) -> Option<CodexRequest> {
    // Do not forward the complete log line: tracing spans can contain unrelated data.
    let (_, message) = body.rsplit_once(": Request ")?;
    let regex = regex::Regex::new(r"^(completed|failed) method=([A-Z]+) url=(\S+)").ok()?;
    let captures = regex.captures(message)?;
    let failed = &captures[1] == "failed";
    let method = captures[2].to_owned();
    // Credentials and query strings never belong in diagnostics exported to the UI.
    let mut url = reqwest::Url::parse(captures[3].trim_matches('"')).ok()?;
    let _ = url.set_username("");
    let _ = url.set_password(None);
    if url.query().is_some() { url.set_query(Some("redacted")); }
    url.set_fragment(None);
    let url = url.to_string();
    let status: Option<u16> = regex::Regex::new(r" status=(\d{3})\b").ok()?
        .captures(message).and_then(|c| c[1].parse().ok());
    let mut headers = Vec::new();
    if let Some((_, raw)) = message.split_once(" headers=") {
        if let Some(Ok(Value::Object(values))) = serde_json::Deserializer::from_str(raw).into_iter::<Value>().next() {
            // Only diagnostic response headers are exposed; cookies and arbitrary
            // provider headers can include secrets.
            for (name, value) in values {
                let lower = name.to_ascii_lowercase();
                if matches!(lower.as_str(), "date" | "content-type" | "content-length" | "transfer-encoding" | "server" | "retry-after" | "cache-control" | "x-request-id" | "x-oneapi-request-id" | "openai-processing-ms") {
                    if let Some(value) = value.as_str() { headers.push(format!("{name}: {value}")); }
                }
            }
        }
    }
    let request_message = format!("{method} {url}\r\n\r\n[Codex 本机日志未记录请求头和请求正文，无法从登录凭据解密 TLS。]");
    let response_message = format!("{}\r\n{}\r\n\r\n{}", status.map(|s| s.to_string()).unwrap_or_else(|| "请求失败".into()), headers.join("\r\n"),
        if failed { "[Codex 记录请求失败；日志未提供完整错误正文。]" } else { "[Codex 本机日志未记录响应正文。此记录来自 HTTP 日志，不是完整解密报文。]" });
    Some(CodexRequest { id, url, method, status, started_at: timestamp, failed, request_message, response_message })
}

fn read_batch(cursor: Option<i64>) -> Result<Batch, String> {
    let root = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".codex"))).ok_or("找不到 Codex 目录")?;
    if !root.is_dir() { return Ok(Batch { cursor: 0, requests: vec![], available: false }); }
    let mut databases: Vec<_> = std::fs::read_dir(root).map_err(|e| e.to_string())?
        .filter_map(Result::ok).filter_map(|entry| {
            let name = entry.file_name();
            let version = name.to_str()?.strip_prefix("logs_")?.strip_suffix(".sqlite")?.parse::<u32>().ok()?;
            Some((version, entry.path()))
        }).collect();
    databases.sort_by_key(|(version, _)| *version);
    let Some((_, path)) = databases.pop() else { return Ok(Batch { cursor: 0, requests: vec![], available: false }); };
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_millis(250)).map_err(|e| e.to_string())?;
    let maximum: i64 = db.query_row("SELECT COALESCE(MAX(id), 0) FROM logs WHERE target = 'codex_http_client::client'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let after = cursor.filter(|c| *c <= maximum).unwrap_or(0);
    let initial = cursor.is_none() || cursor.is_some_and(|c| c > maximum);
    let sql = if initial {
        "SELECT id, ts * 1000 + ts_nanos / 1000000, feedback_log_body FROM (SELECT * FROM logs WHERE target = 'codex_http_client::client' AND id > ? ORDER BY id DESC LIMIT 100) ORDER BY id"
    } else {
        "SELECT id, ts * 1000 + ts_nanos / 1000000, feedback_log_body FROM logs WHERE target = 'codex_http_client::client' AND id > ? ORDER BY id LIMIT 500"
    };
    let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = statement.query_map([after], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))).map_err(|e| e.to_string())?;
    let mut batch = Batch { cursor: after, requests: Vec::new(), available: true };
    for row in rows {
        let (id, ts, body) = row.map_err(|e| e.to_string())?;
        batch.cursor = id;
        if let Some(request) = parse_request(id, ts, &body) { batch.requests.push(request); }
    }
    Ok(batch)
}

#[tauri::command]
pub async fn codex_network_requests(cursor: Option<i64>) -> Result<Batch, String> {
    tauri::async_runtime::spawn_blocking(move || read_batch(cursor)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_http_metadata_and_excludes_secrets() {
        let item = parse_request(7, 123, r#"span{token=secret}: Request completed method=POST url=https://user:pass@example.com/responses?key=secret status=200 OK headers={"content-type":"text/event-stream","set-cookie":"secret","authorization":"secret","x-private-key":"secret"} version=HTTP/1.1"#).unwrap();
        assert_eq!(item.status, Some(200));
        assert_eq!(item.url, "https://example.com/responses?redacted");
        assert!(item.response_message.contains("content-type: text/event-stream"));
        assert!(!item.request_message.contains("secret"));
        assert!(!item.response_message.contains("secret"));
    }
    #[test]
    fn failed_requests_and_unrelated_logs() {
        let item = parse_request(1, 0, "span: Request failed method=POST url=https://example.com/responses is_timeout=true").unwrap();
        assert!(item.failed);
        assert_eq!(item.status, None);
        assert!(parse_request(2, 0, "custom CA configured").is_none());
    }
}
