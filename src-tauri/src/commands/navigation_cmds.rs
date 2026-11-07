#[tauri::command]
pub fn navigation_export_data(
    webview: tauri::Webview,
    file: String,
    content: String,
) -> Result<(), String> {
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
    if !project_window || !local_app {
        return Err("无权导出导航数据".into());
    }
    if content.len() > 20 * 1024 * 1024 {
        return Err("导航数据超过 20 MB".into());
    }
    std::fs::write(file, content).map_err(|error| format!("无法写入导出文件：{error}"))
}
