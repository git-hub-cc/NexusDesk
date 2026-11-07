use futures_util::StreamExt;
use serde::Deserialize;
use std::time::Duration;
use tauri::Emitter;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage { role: String, content: String }

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatOverrides {
    api: Option<String>,
    key: Option<String>,
    model: Option<String>,
    format: Option<String>,
}

fn stream_delta(payload: &serde_json::Value, wire_api: &str) -> Option<String> {
    if wire_api == "responses" {
        return payload.get("delta").and_then(serde_json::Value::as_str).map(str::to_owned);
    }
    payload.pointer("choices.0.delta.content").and_then(serde_json::Value::as_str).map(str::to_owned)
}

fn emit_error(app: &tauri::AppHandle, request_id: &str, message: String) -> String {
    let event = format!("chat-stream-error-{request_id}");
    let _ = app.emit(event.as_str(), message.clone());
    message
}

#[tauri::command]
pub async fn chat_completion(app: tauri::AppHandle, request_id: String, messages: Vec<ChatMessage>, overrides: Option<ChatOverrides>) -> Result<(), String> {
    if request_id.trim().is_empty() || request_id.len() > 128 { return Err("请求标识无效".into()); }
    if messages.is_empty() || messages.len() > 40 { return Err("对话消息数量无效".into()); }
    if messages.iter().any(|message| !matches!(message.role.as_str(), "user" | "assistant") || message.content.trim().is_empty()) {
        return Err("对话内容无效".into());
    }
    if messages.iter().map(|message| message.content.chars().count()).sum::<usize>() > 32_000 {
        return Err("对话内容过长，请开启新对话".into());
    }
    let config = super::codex_settings::api_config()?;
    let overrides = overrides.unwrap_or_default();
    let base_url = overrides.api.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or(&config.base_url);
    let model = overrides.model.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or(&config.model);
    let wire_api = overrides.format.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or(&config.wire_api);
    let mut endpoint = reqwest::Url::parse(base_url).map_err(|_| "Codex API 地址无效")?;
    if !matches!(endpoint.scheme(), "http" | "https") || endpoint.host_str().is_none() { return Err("Codex API 地址必须是 HTTP 或 HTTPS URL".into()); }
    let path = match wire_api {
        "responses" => ["responses"].as_slice(),
        "chat" | "chat_completions" => ["chat", "completions"].as_slice(),
        _ => return Err("Codex 提供方的 wire_api 配置不受支持".into()),
    };
    let endpoint_path = endpoint.path().trim_end_matches('/');
    let already_points_to_api = (wire_api == "responses" && endpoint_path.ends_with("/responses"))
        || (wire_api != "responses" && endpoint_path.ends_with("/chat/completions"));
    if !already_points_to_api {
        endpoint.path_segments_mut().map_err(|_| "Codex API 地址无效")?.pop_if_empty().extend(path.iter().copied());
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).build().map_err(|_| "无法创建 API 请求")?;
    let request_body = if wire_api == "responses" {
        serde_json::json!({ "model": model, "input": messages.iter().map(|message| serde_json::json!({ "role": message.role, "content": message.content })).collect::<Vec<_>>(), "stream": true })
    } else {
        serde_json::json!({ "model": model, "messages": messages.iter().map(|message| serde_json::json!({ "role": message.role, "content": message.content })).collect::<Vec<_>>(), "stream": true })
    };
    let mut request = client.post(endpoint).json(&request_body);
    let api_key = overrides.key.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned).or(config.api_key);
    if let Some(api_key) = api_key { request = request.bearer_auth(api_key); }
    if let Some(account_id) = config.account_id { request = request.header("ChatGPT-Account-ID", account_id); }
    let response = request.send().await.map_err(|_| emit_error(&app, &request_id, "连接 Codex API 失败，请检查请求地址和网络".into()))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let detail = body.trim().chars().take(300).collect::<String>();
        let message = if detail.is_empty() { format!("API 请求失败（HTTP {status}）") } else { format!("API 请求失败（HTTP {status}）：{detail}") };
        return Err(emit_error(&app, &request_id, message));
    }
    let mut buffer = String::new();
    let mut response_stream = response.bytes_stream();
    while let Some(chunk) = response_stream.next().await {
        let chunk = chunk.map_err(|_| emit_error(&app, &request_id, "读取 API 响应失败".into()))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].trim_end_matches('\r').to_owned();
            buffer.drain(..=index);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" { continue; }
            let payload = match serde_json::from_str::<serde_json::Value>(data) {
                Ok(payload) => payload,
                Err(_) if data.starts_with('{') => return Err(emit_error(&app, &request_id, "API 流式响应格式无效".into())),
                Err(_) => continue,
            };
            if let Some(delta) = stream_delta(&payload, wire_api) { if !delta.is_empty() { let event = format!("chat-stream-{request_id}"); let _ = app.emit(event.as_str(), delta); } }
        }
    }
    if let Some(data) = buffer.trim().strip_prefix("data:").map(str::trim) {
        match serde_json::from_str::<serde_json::Value>(data) {
            Ok(payload) => if let Some(delta) = stream_delta(&payload, wire_api) { let event = format!("chat-stream-{request_id}"); let _ = app.emit(event.as_str(), delta); },
            Err(_) if data.starts_with('{') => return Err(emit_error(&app, &request_id, "API 流式响应格式无效".into())),
            Err(_) => {},
        }
    }
    let event = format!("chat-stream-done-{request_id}");
    let _ = app.emit(event.as_str(), ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::stream_delta;
    #[test]
    fn parses_responses_delta() { let payload = serde_json::json!({"delta": "hello"}); assert_eq!(stream_delta(&payload, "responses").as_deref(), Some("hello")); }
    #[test]
    fn parses_chat_delta() { let payload = serde_json::json!({"choices": [{"delta": {"content": "hello"}}]}); assert_eq!(stream_delta(&payload, "chat").as_deref(), Some("hello")); }
}
