use std::{collections::HashMap, path::PathBuf, sync::Mutex};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, sync::oneshot};

#[derive(Default)]
pub struct PreviewState(pub Mutex<HashMap<u16, oneshot::Sender<()>>>);

fn decode_path(value: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        bytes.push(if byte == b'%' {
            let a = (input.next()? as char).to_digit(16)?;
            let b = (input.next()? as char).to_digit(16)?;
            (a * 16 + b) as u8
        } else { byte });
    }
    String::from_utf8(bytes).ok()
}

fn mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8", "css" => "text/css",
        "js" | "mjs" => "text/javascript", "json" | "map" => "application/json",
        "svg" => "image/svg+xml", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp", "gif" => "image/gif", "ico" => "image/x-icon",
        "woff" => "font/woff", "woff2" => "font/woff2", "ttf" => "font/ttf",
        "mp4" => "video/mp4", "webm" => "video/webm", "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub async fn start_html_preview(root: String, path: String, content: String, state: tauri::State<'_, PreviewState>) -> Result<String, String> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let entry = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !root.is_dir() || !entry.starts_with(&root) { return Err("根目录必须包含当前 HTML 文件".into()); }
    let relative = entry.strip_prefix(&root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
    let encoded: String = relative.as_bytes().iter().map(|b| {
        if b.is_ascii_alphanumeric() || b"/-_.~".contains(b) { (*b as char).to_string() } else { format!("%{b:02X}") }
    }).collect();
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (stop, mut stopped) = oneshot::channel();
    state.0.lock().map_err(|e| e.to_string())?.insert(port, stop);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else { break };
                    let root = root.clone(); let entry = entry.clone(); let content = content.clone();
                    tokio::spawn(async move {
                        let request = async {
                            let mut header = Vec::new();
                            while header.len() < 16384 {
                                let mut bytes = [0u8; 1024];
                                let count = socket.read(&mut bytes).await.ok()?;
                                if count == 0 { return None; }
                                header.extend_from_slice(&bytes[..count]);
                                if header.windows(4).any(|w| w == b"\r\n\r\n") { break; }
                            }
                            let text = String::from_utf8_lossy(&header);
                            let mut words = text.lines().next()?.split_whitespace();
                            let method = words.next()?;
                            let target = words.next()?;
                            if method != "GET" && method != "HEAD" { return None; }
                            let decoded = decode_path(target.split('?').next()?)?;
                            let relative = decoded.trim_start_matches('/');
                            if relative.contains('\\') || relative.contains(':') { return None; }
                            let mut path: PathBuf = root.join(relative);
                            if path.is_dir() { path = path.join("index.html"); }
                            let path = tokio::fs::canonicalize(path).await.ok()?;
                            if !path.starts_with(&root) { return None; }
                            let body = if path == entry { content.into_bytes() } else { tokio::fs::read(&path).await.ok()? };
                            Some((body, mime(&path), method == "HEAD"))
                        };
                        let result = tokio::time::timeout(std::time::Duration::from_secs(10), request).await.ok().flatten();
                        let (status, body, mime, head) = match result {
                            Some((body, mime, head)) => ("200 OK", body, mime, head),
                            None => ("404 Not Found", b"Not found".to_vec(), "text/plain", false),
                        };
                        let header = format!("HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
                        let _ = socket.write_all(header.as_bytes()).await;
                        if !head { let _ = socket.write_all(&body).await; }
                    });
                }
            }
        }
    });
    Ok(format!("http://127.0.0.1:{port}/{encoded}"))
}

#[tauri::command]
pub fn stop_html_preview(port: u16, state: tauri::State<'_, PreviewState>) {
    if let Ok(mut servers) = state.0.lock() {
        if let Some(stop) = servers.remove(&port) { let _ = stop.send(()); }
    }
}
