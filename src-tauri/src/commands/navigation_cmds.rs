use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Url, header::CONTENT_TYPE};
use std::{sync::OnceLock, time::Duration};

fn is_navigation_webview(webview: &tauri::Webview) -> Result<bool, String> {
    let label = webview.label();
    let project_window = label == "main"
        || label.strip_prefix("window-").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        });
    let url = webview.url().map_err(|error| error.to_string())?;
    let local_app = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions)
            && url.origin().ascii_serialization() == "http://127.0.0.1:1420");
    Ok(project_window && local_app)
}

#[tauri::command]
pub fn navigation_export_data(
    webview: tauri::Webview,
    file: String,
    content: String,
) -> Result<(), String> {
    if !is_navigation_webview(&webview)? {
        return Err("无权导出导航数据".into());
    }
    if content.len() > 20 * 1024 * 1024 {
        return Err("导航数据超过 20 MB".into());
    }
    std::fs::write(file, content).map_err(|error| format!("无法写入导出文件：{error}"))
}

#[tauri::command]
pub async fn navigation_fetch_icon(webview: tauri::Webview, url: String) -> Option<String> {
    if !is_navigation_webview(&webview).ok()? {
        return None;
    }
    let url = Url::parse(&url).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }

    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            Client::builder()
                .timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::limited(5))
                .referer(false)
                .build()
                .ok()
        })
        .as_ref()?;
    let mut response = client.get(url).send().await.ok()?.error_for_status().ok()?;
    let mime = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let image_type = mime.strip_prefix("image/").is_some_and(|subtype| {
        !subtype.is_empty()
            && subtype
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
    });
    if !image_type && !matches!(mime.as_str(), "" | "application/octet-stream") {
        return None;
    }

    const MAX_ICON_BYTES: usize = 512 * 1024;
    if response
        .content_length()
        .is_some_and(|len| len > MAX_ICON_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > MAX_ICON_BYTES - bytes.len() {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let mime = if image_type && !bytes.is_empty() {
        mime.as_str()
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        "image/x-icon"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
