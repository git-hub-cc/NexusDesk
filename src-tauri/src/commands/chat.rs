use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    role: String,
    content: String,
}

fn response_text(payload: &serde_json::Value) -> Option<String> {
    if let Some(text) = payload
        .get("output_text")
        .and_then(serde_json::Value::as_str)
    {
        if !text.trim().is_empty() {
            return Some(text.to_owned());
        }
    }
    if let Some(text) = payload
        .pointer("choices.0.message.content")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            payload
                .pointer("choices.0.text")
                .and_then(serde_json::Value::as_str)
        })
    {
        if !text.trim().is_empty() {
            return Some(text.to_owned());
        }
    }

    let mut parts = Vec::new();
    if let Some(content) = payload
        .pointer("choices.0.message.content")
        .and_then(serde_json::Value::as_array)
    {
        parts.extend(content.iter());
    }
    if let Some(outputs) = payload.get("output").and_then(serde_json::Value::as_array) {
        for output in outputs {
            if let Some(content) = output.get("content").and_then(serde_json::Value::as_array) {
                parts.extend(content.iter());
            }
        }
    }
    let text = parts
        .iter()
        .filter_map(|part| {
            part.get("text")
                .or_else(|| part.get("refusal"))
                .and_then(serde_json::Value::as_str)
                .or_else(|| part.as_str())
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.trim().is_empty()).then_some(text)
}

#[tauri::command]
pub async fn chat_completion(messages: Vec<ChatMessage>) -> Result<String, String> {
    if messages.is_empty() || messages.len() > 40 {
        return Err("对话消息数量无效".into());
    }
    if messages.iter().any(|message| {
        !matches!(message.role.as_str(), "user" | "assistant") || message.content.trim().is_empty()
    }) {
        return Err("对话内容无效".into());
    }
    if messages
        .iter()
        .map(|message| message.content.chars().count())
        .sum::<usize>()
        > 32_000
    {
        return Err("对话内容过长，请开启新对话".into());
    }

    let config = super::codex_settings::api_config()?;
    let mut endpoint = reqwest::Url::parse(&config.base_url).map_err(|_| "Codex API 地址无效")?;
    if !matches!(endpoint.scheme(), "http" | "https") || endpoint.host_str().is_none() {
        return Err("Codex API 地址必须是 HTTP 或 HTTPS URL".into());
    }
    let path = match config.wire_api.as_str() {
        "responses" => ["responses"].as_slice(),
        "chat" | "chat_completions" => ["chat", "completions"].as_slice(),
        _ => return Err("Codex 提供方的 wire_api 配置不受支持".into()),
    };
    endpoint
        .path_segments_mut()
        .map_err(|_| "Codex API 地址无效")?
        .pop_if_empty()
        .extend(path.iter().copied());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "无法创建 API 请求")?;
    let request_body = if config.wire_api == "responses" {
        serde_json::json!({
            "model": config.model,
            "input": messages.iter().map(|message| serde_json::json!({
                "role": message.role,
                "content": message.content,
            })).collect::<Vec<_>>(),
            "stream": false,
        })
    } else {
        serde_json::json!({
            "model": config.model,
            "messages": messages.iter().map(|message| serde_json::json!({
                "role": message.role,
                "content": message.content,
            })).collect::<Vec<_>>(),
            "stream": false,
        })
    };
    let mut request = client.post(endpoint).json(&request_body);
    if let Some(api_key) = config.api_key {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "连接 Codex API 失败，请检查请求地址和网络")?;
    let status = response.status();
    let body = response.bytes().await.map_err(|_| "读取 API 回复失败")?;
    if !status.is_success() {
        return Err(format!("API 请求失败（HTTP {status}）"));
    }
    let payload: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "API 返回了无效 JSON")?;
    response_text(&payload).ok_or_else(|| {
        let fields = payload
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>().join(", "))
            .unwrap_or_else(|| "未知".into());
        format!("API 已成功响应，但没有识别到文本内容（字段：{fields}）")
    })
}

#[cfg(test)]
mod tests {
    use super::response_text;

    #[test]
    fn parses_responses_api_output_text() {
        let payload = serde_json::json!({
            "output": [
                { "type": "reasoning", "summary": [] },
                { "content": [{ "type": "output_text", "text": "hello" }] }
            ]
        });
        assert_eq!(response_text(&payload).as_deref(), Some("hello"));
    }

    #[test]
    fn parses_chat_completion_text_parts() {
        let payload = serde_json::json!({
            "choices": [{ "message": { "content": [
                { "type": "text", "text": "hello " }, { "type": "text", "text": "world" }
            ] } }]
        });
        assert_eq!(response_text(&payload).as_deref(), Some("hello world"));
    }
}
