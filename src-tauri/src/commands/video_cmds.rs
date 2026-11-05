use serde::Serialize;
use std::{path::{Path, PathBuf}, process::Stdio};
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tokio::{io::AsyncWriteExt, process::Command};
use tokio::sync::oneshot;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoToolStatus {
    pub yt_dlp_available: bool,
    pub path: Option<String>,
    pub ffmpeg_available: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVideo { pub path: String, pub name: String, pub size: u64, pub modified: u64 }

#[tauri::command]
pub fn list_local_videos() -> Result<Vec<LocalVideo>, String> {
    let root = dirs::home_dir().ok_or("无法获取用户目录")?.join(".nexus").join("video");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut videos = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || !path.extension().and_then(|v| v.to_str()).is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "mp4" | "m4v" | "webm" | "mov" | "mkv" | "avi" | "ogv")) { continue; }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let modified = meta.modified().ok().and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |v| v.as_secs());
        videos.push(LocalVideo { path: path.to_string_lossy().into_owned(), name: entry.file_name().to_string_lossy().into_owned(), size: meta.len(), modified });
    }
    videos.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(videos)
}

fn candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in if cfg!(windows) { vec!["yt-dlp.exe", "yt-dlp"] } else { vec!["yt-dlp"] } { paths.push(dir.join(name)); }
        }
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local").join("bin").join(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" }));
        #[cfg(windows)]
        {
            paths.push(home.join("scoop/shims/yt-dlp.exe"));
            paths.push(home.join("AppData/Local/Microsoft/WinGet/Links/yt-dlp.exe"));
            paths.push(home.join("pipx/venvs/yt-dlp/Scripts/yt-dlp.exe"));
            paths.push(home.join(".local/pipx/venvs/yt-dlp/Scripts/yt-dlp.exe"));
            for root in [home.join("AppData/Roaming/Python"), home.join("AppData/Local/Programs/Python")] {
                if let Ok(entries) = std::fs::read_dir(root) {
                    for entry in entries.flatten() {
                        if entry.file_name().to_string_lossy().starts_with("Python") {
                            paths.push(entry.path().join("Scripts/yt-dlp.exe"));
                        }
                    }
                }
            }
        }
    }
    paths
}
fn video_tool_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

async fn find_working_tool(paths: Vec<PathBuf>, version_flag: &str) -> Option<PathBuf> {
    let mut checked = std::collections::HashSet::new();
    for path in paths.into_iter().filter(|path| path.is_file()) {
        if !checked.insert(path.clone()) { continue; }
        let result = tokio::time::timeout(std::time::Duration::from_secs(5),
            video_tool_command(&path).arg(version_flag).stdout(Stdio::null()).stderr(Stdio::null()).status()).await;
        if matches!(result, Ok(Ok(status)) if status.success()) { return Some(path); }
    }
    None
}

async fn find_ytdlp() -> Option<PathBuf> {
    find_working_tool(candidates(), "--version").await
}

async fn find_ffmpeg(ytdlp: Option<&Path>) -> Option<PathBuf> {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut paths = Vec::new();
    if let Some(dir) = ytdlp.and_then(Path::parent) { paths.push(dir.join(name)); }
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/bin").join(name));
        #[cfg(windows)]
        for dir in ["scoop/shims", "scoop/apps/ffmpeg/current/bin", "AppData/Local/Microsoft/WinGet/Links"] {
            paths.push(home.join(dir).join(name));
        }
    }
    find_working_tool(paths, "-version").await
}

fn ytdlp_download_command(program: &Path, destination: &Path, url: &reqwest::Url, ffmpeg: Option<&Path>, cookies: Option<&str>) -> Command {
    let mut command = video_tool_command(program);
    command.args(["--ignore-config", "--no-playlist", "--no-progress", "--windows-filenames", "--hls-prefer-native"])
        // 与内置 WebView2 的浏览器标识保持一致，避免 Cookie 与客户端不匹配。
        .args(["--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"])
        .arg("-P").arg(destination).arg("-o").arg("%(title).180B [%(id)s].%(ext)s");
    if let Some(ffmpeg) = ffmpeg {
        // yt-dlp invokes this FFmpeg to merge separate tracks; fall back to a
        // combined format for sites that do not offer separate tracks.
        command.arg("--ffmpeg-location").arg(ffmpeg)
            .args(["-f", "bestvideo+bestaudio/best[vcodec!=none][acodec!=none]"]);
    } else {
        // Never fall back to a silent video when merging is unavailable.
        command.args(["-f", "best[vcodec!=none][acodec!=none]"]);
    }
    if let Some(cookies) = cookies.filter(|value| !value.is_empty()) {
        command.arg("--add-header").arg(format!("Cookie: {cookies}"));
    }
    command.arg("--").arg(url.as_str()).stdout(Stdio::null()).stderr(Stdio::piped());
    command
}

fn is_hls(url: &reqwest::Url, mime: &str) -> bool {
    url.path().to_ascii_lowercase().ends_with(".m3u8") || matches!(
        mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str(),
        "application/vnd.apple.mpegurl" | "application/x-mpegurl" | "audio/mpegurl" | "audio/x-mpegurl" | "video/mpegurl" | "video/x-mpegurl"
    )
}
fn safe_filename(value: &str) -> String {
    let name: String = value.chars().map(|ch| if ch.is_control() || r#"<>:"/\|?*"#.contains(ch) { '_' } else { ch }).collect();
    let name = name.trim().trim_matches('.');
    if name.is_empty() { "video".into() } else { name.chars().take(140).collect() }
}

fn parse_video_input(input: &str) -> Result<reqwest::Url, String> {
    // A copied share message contains text before and after the actual link.
    let links = regex::Regex::new(r#"(?i)https?://[^\s<>"'，。！？；、（）【】《》]+"#).unwrap();
    let candidate = links.find(input.trim()).ok_or("请输入有效的视频链接或包含链接的分享文案")?.as_str()
        .trim_end_matches(['.', ',', '!', '?', ';', ')', ']']);
    let url = reqwest::Url::parse(candidate).map_err(|_| "请输入有效的视频链接")?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("仅支持 HTTP 或 HTTPS 视频链接".into());
    }
    Ok(url)
}

fn douyin_target(input: &reqwest::Url) -> Result<reqwest::Url, String> {
    let host = input.host_str().unwrap_or_default().to_ascii_lowercase();
    let douyin_host = host == "douyin.com" || host.ends_with(".douyin.com");
    let iesdouyin_host = host == "iesdouyin.com" || host.ends_with(".iesdouyin.com");
    if !douyin_host && !iesdouyin_host { return Err("无效的抖音链接".into()); }
    if host == "v.douyin.com" { return Ok(input.clone()); }
    let numeric = |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    let id = input.query_pairs()
        .find(|(key, value)| matches!(key.as_ref(), "modal_id" | "aweme_id" | "item_id") && numeric(value))
        .map(|(_, value)| value.into_owned())
        .or_else(|| {
            let segments: Vec<_> = input.path_segments()?.collect();
            segments.windows(2).find(|pair| matches!(pair[0], "video" | "note") && numeric(pair[1]))
                .map(|pair| pair[1].to_string())
        }).ok_or("无法从抖音链接中识别视频 ID，请使用视频详情链接或分享短链")?;
    reqwest::Url::parse(&format!("https://www.douyin.com/video/{id}/")).map_err(|e| e.to_string())
}

async fn resolve_douyin(app: &tauri::AppHandle, input: &reqwest::Url) -> Result<(String, String), String> {
    let target = douyin_target(input)?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let label = format!("nexusdesk-douyin-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let (tx, rx) = oneshot::channel::<Result<(String, String), String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let callback_tx = tx.clone();
    let script = include_str!("douyin_resolver.js");
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(target))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        .initialization_script(script).inner_size(1.0, 1.0).visible(false).focused(false).skip_taskbar(true)
        .on_navigation(move |url| {
            if url.scheme() == "nexusdesk-douyin" {
                let result = (|| { let video = url.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned()).ok_or("抖音没有返回视频地址".to_string())?;
                    let title = url.query_pairs().find(|(k, _)| k == "title").map(|(_, v)| v.into_owned()).unwrap_or_else(|| "抖音视频".into());
                    let video_url = reqwest::Url::parse(&video).map_err(|e| e.to_string())?;
                    if video_url.scheme() != "https" { return Err("抖音返回了无效的视频地址".into()); } Ok((video_url.to_string(), title)) })();
                if let Ok(mut slot) = callback_tx.lock() { if let Some(sender) = slot.take() { let _ = sender.send(result); } }
                return false;
            }
            matches!(url.scheme(), "http" | "https")
        }).build().map_err(|e| format!("无法启动抖音解析器：{e}"))?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), rx).await
        .map_err(|_| "抖音解析超时，请检查网络或分享链接".to_string()).and_then(|received| received.map_err(|_| "抖音解析已中断".to_string()));
    let _ = window.close();
    result?
}

#[tauri::command]
pub async fn video_tool_status() -> VideoToolStatus {
    let path = find_ytdlp().await;
    let ffmpeg = find_ffmpeg(path.as_deref()).await;
    VideoToolStatus { yt_dlp_available: path.is_some(), path: path.map(|p| p.to_string_lossy().into_owned()), ffmpeg_available: ffmpeg.is_some() }
}

#[tauri::command]
pub async fn download_video(app: tauri::AppHandle, url: String, destination: String) -> Result<String, String> {
    let parsed = parse_video_input(&url)?;
    let dest = Path::new(&destination);
    if !dest.is_dir() { return Err("请选择一个已存在的保存目录".into()); }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let is_douyin = host == "douyin.com" || host.ends_with(".douyin.com") || host == "iesdouyin.com" || host.ends_with(".iesdouyin.com");
    let (download_url, suggested_title) = if is_douyin { resolve_douyin(&app, &parsed).await? } else { (parsed.to_string(), String::new()) };
    if !is_douyin { if let Some(program) = find_ytdlp().await {
        let ffmpeg = find_ffmpeg(Some(&program)).await;
        let cookies = if host == "youtube.com" || host.ends_with(".youtube.com") || host == "youtu.be" || host.ends_with(".youtu.be") {
            crate::commands::browser_downloads::cookies_for_url(&app, "https://www.youtube.com/").ok()
        } else { None };
        let output = ytdlp_download_command(&program, dest, &parsed, ffmpeg.as_deref(), cookies.as_deref()).output().await.map_err(|e| format!("无法启动 yt-dlp：{e}"))?;
        if output.status.success() { return Ok("下载完成".into()); }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if ffmpeg.is_none() && stderr.contains("Requested format is not available") {
            return Err("该链接未提供自带音频的视频格式，请安装 FFmpeg 后重试，以便分别下载音视频并合并。".into());
        }
        let detail = stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("下载失败");
        return Err(format!("yt-dlp 下载失败：{}", detail.chars().take(240).collect::<String>()));
    } }
    if !is_douyin && is_hls(&parsed, "") { return Err("下载 m3u8 视频需要安装 yt-dlp，安装后可重新尝试下载。".into()); }
    let video_url = reqwest::Url::parse(&download_url).map_err(|e| e.to_string())?;
    let mut request = reqwest::Client::builder().user_agent("Mozilla/5.0").timeout(std::time::Duration::from_secs(180)).build().map_err(|e| e.to_string())?.get(video_url.clone());
    if is_douyin { request = request.header(reqwest::header::REFERER, "https://www.douyin.com/"); }
    let mut response = request.send().await.map_err(|e| format!("无法获取视频：{e}"))?.error_for_status().map_err(|e| format!("视频请求失败：{e}"))?;
    let mime = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    if is_hls(response.url(), mime) { return Err("下载 m3u8 视频需要安装 yt-dlp，安装后可重新尝试下载。".into()); }
    if !mime.starts_with("video/") && !mime.contains("octet-stream") { return Err(if is_douyin { "抖音未返回可下载的视频内容，请检查链接是否公开。" } else { "链接没有返回可下载的视频文件；此类网站请安装 yt-dlp。" }.into()); }
    let ext = match mime.split(';').next().unwrap_or("").trim() { "video/webm" => "webm", "video/quicktime" => "mov", "video/x-matroska" => "mkv", _ => "mp4" };
    let name = if !suggested_title.trim().is_empty() { suggested_title } else { video_url.path_segments().and_then(|mut segments| segments.next_back()).filter(|name| !name.is_empty() && name.len() < 160 && !name.contains(['/', '\\'])).unwrap_or("video").to_string() };
    let name = safe_filename(&name);
    let name = if Path::new(&name).extension().is_some() { name } else { format!("{name}.{ext}") };
    let mut path = dest.join(&name);
    if path.exists() { let stem = Path::new(&name).file_stem().unwrap_or_default().to_string_lossy(); let suffix = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or(ext); path = dest.join(format!("{stem}-{}.{}", chrono::Utc::now().timestamp(), suffix)); }
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| format!("无法创建文件：{e}"))?;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("读取视频失败：{e}"))? { file.write_all(&chunk).await.map_err(|e| format!("保存失败：{e}"))?; }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(format!("已保存到 {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_format_requires_audio_and_only_merges_with_ffmpeg() {
        let url = parse_video_input("https://www.youtube.com/watch?v=abc123").unwrap();
        let program = Path::new("yt-dlp");
        let destination = Path::new("videos");
        let args = |command: Command| command.as_std().get_args()
            .map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>();
        let without = args(ytdlp_download_command(program, destination, &url, None, None));
        assert!(without.windows(2).any(|pair| pair == ["-f", "best[vcodec!=none][acodec!=none]"]));
        assert!(!without.iter().any(|arg| arg == "--ffmpeg-location"));

        let ffmpeg = Path::new("tools with spaces/ffmpeg.exe");
        let with = args(ytdlp_download_command(program, destination, &url, Some(ffmpeg), None));
        assert!(with.windows(2).any(|pair| pair == ["--ffmpeg-location", "tools with spaces/ffmpeg.exe"]));
        assert!(with.windows(2).any(|pair| pair == ["-f", "bestvideo+bestaudio/best[vcodec!=none][acodec!=none]"]));
    }

    #[test]
    fn extended_download_links_are_passed_as_a_single_url() {
        for value in [
            "https://www.youtube.com/watch?v=abc123&list=playlist",
            "https://cdn.example.com/live/index.m3u8?token=a%2Bb&expires=123",
        ] {
            let url = parse_video_input(value).unwrap();
            let command = ytdlp_download_command(Path::new("yt-dlp"), Path::new("videos with spaces"), &url, None, None);
            let args: Vec<_> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
            assert_eq!(&args[args.len() - 2..], &["--", value]);
            assert!(args.iter().any(|arg| arg == "--no-playlist"));
            assert!(args.iter().any(|arg| arg == "--hls-prefer-native"));
            assert!(args.windows(2).any(|pair| pair == ["-P", "videos with spaces"]));
        }
    }

    #[test]
    fn hls_manifests_are_not_saved_as_video_files() {
        let stream = parse_video_input("https://example.com/INDEX.M3U8?token=123").unwrap();
        assert!(is_hls(&stream, "application/octet-stream"));
        let endpoint = parse_video_input("https://example.com/stream?id=123").unwrap();
        for mime in ["application/vnd.apple.mpegurl", "application/x-mpegURL; charset=utf-8", "video/x-mpegurl"] {
            assert!(is_hls(&endpoint, mime));
        }
        assert!(!is_hls(&endpoint, "video/mp4"));
        assert!(!is_hls(&endpoint, "video/webm"));
    }

    #[test]
    fn douyin_supported_links() {
        let id = "7647476676246875035";
        for value in [
            format!("https://www.douyin.com/video/{id}"),
            format!("https://www.douyin.com/note/{id}/?from=share"),
            format!("https://www.iesdouyin.com/share/video/{id}/"),
            format!("https://www.douyin.com/user/abc?modal_id={id}"),
            format!("https://www.douyin.com/?aweme_id={id}"),
            format!("https://www.iesdouyin.com/share/?item_id={id}"),
        ] {
            assert_eq!(douyin_target(&parse_video_input(&value).unwrap()).unwrap().as_str(),
                format!("https://www.douyin.com/video/{id}/"));
        }
        let share = "2.51 :9pm 01/29 zTy:/ h@b.nD 娶不到这样的我就不死了 # cos # 芙宁娜 # 私设 # 原神  https://v.douyin.com/ty73Ij6q1Bo/ 复制此链接，打开Dou音搜索，直接观看视频！";
        assert_eq!(douyin_target(&parse_video_input(share).unwrap()).unwrap().as_str(),
            "https://v.douyin.com/ty73Ij6q1Bo/");
        assert_eq!(parse_video_input("分享（https://v.douyin.com/ty73Ij6q1Bo/）。").unwrap().as_str(),
            "https://v.douyin.com/ty73Ij6q1Bo/");
    }

    #[test]
    fn rejects_invalid_video_inputs() {
        for value in ["", "只有分享文案", "file:///tmp/video.mp4", "javascript:alert(1)"] {
            assert!(parse_video_input(value).is_err());
        }
        for value in ["https://www.douyin.com/video/abc", "https://www.douyin.com/?modal_id=abc",
            "https://www.douyin.com/user/123", "https://douyin.com.example.com/video/123"] {
            assert!(douyin_target(&parse_video_input(value).unwrap()).is_err());
        }
        assert_eq!(parse_video_input("https://example.com/video.mp4?token=a&x=2").unwrap().as_str(),
            "https://example.com/video.mp4?token=a&x=2");
    }
}
