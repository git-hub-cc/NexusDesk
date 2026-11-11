use base64::Engine;
use reqwest::{
    Client, Method,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tauri::State;
use tokio::sync::oneshot;

#[derive(Default)]
pub struct HttpState(pub Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    time_ms: u128,
    size_bytes: usize,
    is_binary: bool,
    truncated: bool,
}

#[tauri::command]
pub async fn send_http_request(
    request_id: String,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: String,
    timeout: Option<u64>,
    max_size_bytes: Option<usize>,
    state: State<'_, HttpState>,
) -> Result<HttpResponse, String> {
    let timeout = timeout.unwrap_or(300);
    let max_size = max_size_bytes.unwrap_or(20 * 1024 * 1024);
    if timeout == 0 || max_size == 0 {
        return Err("Timeout and response size limit must be positive".into());
    }
    let (tx, mut rx) = oneshot::channel();
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(request_id.clone(), tx);

    let result = async {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(timeout))
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let req_method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut req_headers = HeaderMap::new();
        for (k, v) in headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(&v),
            ) {
                req_headers.insert(name, value);
            }
        }

        let mut request = client.request(req_method, &url).headers(req_headers);
        if !body.is_empty() {
            request = request.body(body);
        }

        let start_time = Instant::now();

        let response_future = request.send();

        let mut response = tokio::select! {
            res = response_future => res.map_err(|e| e.to_string())?,
            _ = &mut rx => {
                return Err("Request cancelled".into());
            }
        };

        let status = response.status().as_u16();
        let status_text = response
            .status()
            .canonical_reason()
            .unwrap_or("Unknown")
            .to_string();

        let mut res_headers = Vec::new();
        let mut is_binary = false;
        for (k, v) in response.headers() {
            let val_str = v.to_str().unwrap_or("").to_string();
            res_headers.push((k.as_str().to_string(), val_str.clone()));
            if k == reqwest::header::CONTENT_TYPE {
                let lower = val_str.to_lowercase();
                if lower.starts_with("image/")
                    || (!lower.contains("text")
                        && !lower.contains("json")
                        && !lower.contains("xml")
                        && !lower.contains("javascript"))
                {
                    is_binary = true;
                }
            }
        }

        let mut bytes = Vec::new();
        let mut truncated = false;
        loop {
            let chunk = tokio::select! {
                res = response.chunk() => res.map_err(|e| e.to_string())?,
                _ = &mut rx => return Err("Request cancelled during body download".into()),
            };
            let Some(chunk) = chunk else { break };
            let remaining = max_size - bytes.len();
            bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            if chunk.len() > remaining {
                truncated = true;
                break;
            }
        }
        let time_ms = start_time.elapsed().as_millis();
        let size_bytes = bytes.len();
        let display_bytes = &bytes[..];

        let body_str = if is_binary {
            base64::prelude::BASE64_STANDARD.encode(display_bytes)
        } else {
            String::from_utf8_lossy(display_bytes).into_owned()
        };

        Ok(HttpResponse {
            status,
            status_text,
            headers: res_headers,
            body: body_str,
            time_ms,
            size_bytes,
            is_binary,
            truncated,
        })
    }
    .await;
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id);
    result
}

#[tauri::command]
pub fn cancel_http_request(request_id: String, state: State<'_, HttpState>) -> Result<(), String> {
    if let Some(tx) = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id)
    {
        let _ = tx.send(());
    }
    Ok(())
}
