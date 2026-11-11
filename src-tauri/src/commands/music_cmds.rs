use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg(test)]
fn signature_time_fallback() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    id: String,
    title: String,
    artist: String,
    album: String,
    duration: u64,
    path: Option<String>,
    #[serde(default)]
    cover_path: Option<String>,
}

fn music_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| client))
}

#[tauri::command]
pub async fn music_cover_url(id: String) -> Result<Option<String>, String> {
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }
    let data: serde_json::Value = music_client()?
        .get("https://music.163.com/api/song/detail/")
        .query(&[("id", id.clone()), ("ids", format!("[{id}]"))])
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(data
        .pointer("/songs/0/album/picUrl")
        .and_then(serde_json::Value::as_str)
        .and_then(|url| reqwest::Url::parse(url).ok())
        .and_then(|mut url| {
            if url.scheme() == "http" {
                url.set_scheme("https").ok()?;
            }
            if url.scheme() != "https" || url.host_str().is_none() {
                return None;
            }
            url.query_pairs_mut().append_pair("param", "300y300");
            Some(url.to_string())
        }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicChorus {
    start_time: u64,
    end_time: u64,
}

#[tauri::command]
pub async fn music_chorus(id: String) -> Result<Option<MusicChorus>, String> {
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }
    let data: serde_json::Value = music_client()?
        .get("https://music.163.com/api/song/chorus")
        .query(&[("ids", format!("[{id}]"))])
        .header("Referer", "https://music.163.com/")
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if data["code"].as_u64() != Some(200) {
        return Err("获取副歌时间失败".into());
    }
    Ok(data
        .get("chorus")
        .or_else(|| data.get("data"))
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item["id"]
                    .as_u64()
                    .map(|value| value.to_string())
                    .as_deref()
                    == Some(id.as_str())
            })
        })
        .and_then(|item| {
            let start_time = item["startTime"].as_u64()?;
            let end_time = item["endTime"].as_u64()?;
            (end_time > start_time).then_some(MusicChorus {
                start_time,
                end_time,
            })
        }))
}

fn music_dir() -> Result<PathBuf, String> {
    let directory = dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join(".nexus")
        .join("music");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicPlaylist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
    #[serde(default)]
    pub track_metadata: std::collections::HashMap<String, MusicPlaylistTrack>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct MusicPlaylistTrack {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: u64,
}

fn playlist_file() -> Result<PathBuf, String> {
    let path = music_dir()?.join("playlists.json");
    Ok(path)
}

#[tauri::command]
pub fn list_music_playlists() -> Result<Vec<MusicPlaylist>, String> {
    let path = playlist_file()?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_music_playlists(playlists: Vec<MusicPlaylist>) -> Result<(), String> {
    let path = playlist_file()?;
    let bytes = serde_json::to_vec_pretty(&playlists).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_local_music(id: String) -> Result<(), String> {
    let directory = music_dir()?;
    // Imported tracks use their library path as ID.
    let imported = PathBuf::from(&id);
    if imported.is_absolute() {
        let path = imported.canonicalize().map_err(|e| e.to_string())?;
        let root = directory.canonicalize().map_err(|e| e.to_string())?;
        if path.parent() != Some(root.as_path())
            || !path.is_file()
            || !path.extension().and_then(|v| v.to_str()).is_some_and(|v| {
                super::media_import::AUDIO_EXTENSIONS.contains(&v.to_ascii_lowercase().as_str())
            })
        {
            return Err("只能删除本地曲库中的歌曲".into());
        }
        let cover = super::media_import::matching_cover(&path);
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        if let Some(cover) = cover {
            std::fs::remove_file(cover).map_err(|e| e.to_string())?;
        }
        let sidecar = path.with_extension("json");
        if sidecar.is_file() {
            std::fs::remove_file(sidecar).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let prefix = format!("{id} - ");
    let mut deleted = false;
    for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|ext| {
                ["mp3", "flac", "m4a", "ogg", "wav", "aac"]
                    .contains(&ext.to_ascii_lowercase().as_str())
            })
            && path
                .file_stem()
                .and_then(|v| v.to_str())
                .is_some_and(|stem| stem.starts_with(&prefix))
        {
            if std::fs::read(path.with_extension("json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<MusicTrack>(&bytes).ok())
                .is_some_and(|saved| PathBuf::from(saved.id).is_absolute())
            {
                continue;
            }
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            if let Some(cover) = super::media_import::matching_cover(&path) {
                std::fs::remove_file(cover).map_err(|e| e.to_string())?;
            }
            let sidecar = path.with_extension("json");
            if sidecar.is_file() {
                std::fs::remove_file(sidecar).map_err(|e| e.to_string())?;
            }
            deleted = true;
        }
    }
    if deleted {
        Ok(())
    } else {
        Err("本地歌曲文件不存在".into())
    }
}

fn safe_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    cleaned
        .trim_matches([' ', '.'])
        .chars()
        .take(100)
        .collect::<String>()
}

fn audio_extension(
    url: &reqwest::Url,
    content_type: Option<&reqwest::header::HeaderValue>,
) -> &'static str {
    if let Some(extension) = url
        .path_segments()
        .and_then(Iterator::last)
        .and_then(|name| {
            name.rsplit_once('.')
                .map(|(_, ext)| ext.to_ascii_lowercase())
        })
    {
        match extension.as_str() {
            "mp3" => return "mp3",
            "flac" => return "flac",
            "m4a" => return "m4a",
            "ogg" => return "ogg",
            "wav" => return "wav",
            "aac" => return "aac",
            _ => {}
        }
    }
    match content_type
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
    {
        "audio/flac" => "flac",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/aac" => "aac",
        _ => "mp3",
    }
}

fn existing_track(
    directory: &std::path::Path,
    id: &str,
    title: &str,
    artist: &str,
) -> Result<Option<MusicTrack>, String> {
    let prefix = format!("{id} - ");
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["mp3", "flac", "m4a", "ogg", "wav", "aac"].contains(&extension.as_str()) {
            continue;
        }
        let Some(file_name) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if file_name.starts_with(&prefix) {
            let track = restore_metadata(MusicTrack {
                id: id.to_string(),
                title: title.to_string(),
                artist: artist.to_string(),
                album: String::new(),
                duration: 0,
                path: Some(path.to_string_lossy().into_owned()),
                cover_path: None,
            });
            if track.id == id {
                return Ok(Some(track));
            }
        }
    }
    Ok(None)
}

fn restore_metadata(mut track: MusicTrack) -> MusicTrack {
    if let Some(path) = &track.path {
        let path = PathBuf::from(path);
        if let Ok(bytes) = std::fs::read(path.with_extension("json")) {
            if let Ok(saved) = serde_json::from_slice::<MusicTrack>(&bytes) {
                let saved_path = PathBuf::from(&saved.id);
                let is_import = saved.id == path.to_string_lossy()
                    || (saved_path.is_absolute()
                        && saved_path
                            .canonicalize()
                            .ok()
                            .zip(path.canonicalize().ok())
                            .is_some_and(|(left, right)| left == right));
                if is_import {
                    track.id = saved.id.clone();
                    track.title = saved.title.clone();
                    track.artist = saved.artist.clone();
                }
                if saved.id == track.id {
                    track.album = saved.album;
                    track.duration = saved.duration;
                }
            }
        }
        track.cover_path = super::media_import::matching_cover(&path)
            .map(|cover| cover.to_string_lossy().into_owned());
    }
    track
}

async fn save_artwork(client: &reqwest::Client, track: MusicTrack) -> MusicTrack {
    let mut track = restore_metadata(track);
    if track.cover_path.is_some() {
        return track;
    }
    // Older downloads can also recover their artwork from song details.
    let result = async {
        let details: serde_json::Value = client
            .get("https://music.163.com/api/song/detail/")
            .query(&[("id", track.id.clone()), ("ids", format!("[{}]", track.id))])
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let song = &details["songs"][0];
        if let Some(album) = song
            .pointer("/album/name")
            .and_then(serde_json::Value::as_str)
        {
            track.album = album.to_string();
        }
        if let Some(duration) = song.get("duration").and_then(serde_json::Value::as_u64) {
            track.duration = duration;
        }
        if let Some(url) = song
            .pointer("/album/picUrl")
            .and_then(serde_json::Value::as_str)
        {
            let url = url.replacen("http://", "https://", 1);
            let response = client
                .get(url)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await?
                .error_for_status()?;
            if response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("image/"))
            {
                let bytes = response.bytes().await?;
                if !bytes.is_empty() {
                    if let Some(path) = &track.path {
                        let cover = PathBuf::from(path).with_extension("jpg");
                        if std::fs::write(&cover, bytes).is_ok() {
                            track.cover_path = Some(cover.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
        Ok::<(), reqwest::Error>(())
    }
    .await;
    // Artwork failure must not discard a successfully downloaded song.
    if let Err(error) = result {
        log::warn!("Music artwork download failed: {error}");
    }
    if let Some(path) = &track.path {
        if let Ok(bytes) = serde_json::to_vec(&track) {
            let _ = std::fs::write(PathBuf::from(path).with_extension("json"), bytes);
        }
    }
    track
}

#[tauri::command]
pub async fn music_service_resource(path: String) -> Result<String, String> {
    let url = reqwest::Url::parse(&format!("https://music.gdstudio.org{path}"))
        .map_err(|e| e.to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("music.gdstudio.org")
        || !matches!(
            url.path(),
            "/" | "/time" | "/js/player.js" | "/js/crc32.min.js" | "/api.php"
        )
    {
        return Err("无效的音乐服务资源地址".into());
    }
    let response = music_client()?
        .get(url)
        .header("Cache-Control", "no-cache")
        .header("Referer", "https://music.gdstudio.org/")
        .send()
        .await
        .map_err(|e| format!("无法连接音乐服务：{e}"))?
        .error_for_status()
        .map_err(|e| format!("音乐服务请求失败：{e}"))?;
    if response.url().host_str() != Some("music.gdstudio.org") || response.url().scheme() != "https"
    {
        return Err("音乐服务资源重定向无效".into());
    }
    response.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_music(
    id: String,
    title: String,
    artist: String,
    url: String,
) -> Result<MusicTrack, String> {
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("无效的歌曲编号".into());
    }
    let directory = music_dir()?;
    let client = reqwest::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36").timeout(std::time::Duration::from_secs(90)).build().map_err(|e| e.to_string())?;
    if let Some(track) = existing_track(&directory, &id, &title, &artist)? {
        return Ok(save_artwork(&client, track).await);
    }
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("无效的歌曲下载地址".into());
    }
    let audio = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| "下载歌曲失败，请稍后重试".to_string())?
        .error_for_status()
        .map_err(|_| "歌曲文件当前不可下载".to_string())?;
    if audio.url().scheme() != "https" || audio.url().host_str().is_none() {
        return Err("歌曲服务跳转到了不安全的地址".into());
    }
    let extension = audio_extension(
        audio.url(),
        audio.headers().get(reqwest::header::CONTENT_TYPE),
    );
    let bytes = audio
        .bytes()
        .await
        .map_err(|_| "歌曲下载不完整".to_string())?;
    if bytes.is_empty() {
        return Err("歌曲文件为空".into());
    }
    let stem = safe_filename(&format!("{id} - {} - {}", artist, title));
    let stem = if stem.is_empty() {
        format!("track-{id}")
    } else {
        stem
    };
    for index in 0..10000 {
        let name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        let path = directory.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                if let Err(error) = file.write_all(&bytes) {
                    let _ = std::fs::remove_file(&path);
                    return Err(error.to_string());
                }
                return Ok(save_artwork(
                    &client,
                    MusicTrack {
                        id,
                        title,
                        artist,
                        album: String::new(),
                        duration: 0,
                        path: Some(path.to_string_lossy().into_owned()),
                        cover_path: None,
                    },
                )
                .await);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("同名歌曲过多，无法保存".into())
}

#[tauri::command]
pub async fn list_local_music() -> Result<Vec<MusicTrack>, String> {
    let directory = music_dir()?;
    let mut tracks = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !path.is_file() {
            continue;
        }
        if !["mp3", "flac", "m4a", "ogg", "wav", "aac"].contains(&extension.as_str()) {
            continue;
        }
        let Some(file_name) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let (id, artist, title) = match file_name.split_once(" - ") {
            Some((id, rest)) if id.bytes().all(|byte| byte.is_ascii_digit()) => {
                let (artist, title) = rest.split_once(" - ").unwrap_or(("未知歌手", rest));
                (id.to_string(), artist.to_string(), title.to_string())
            }
            Some((artist, title)) => (
                path.to_string_lossy().into_owned(),
                artist.to_string(),
                title.to_string(),
            ),
            None => (
                path.to_string_lossy().into_owned(),
                "本地音乐".to_string(),
                file_name.to_string(),
            ),
        };
        tracks.push(restore_metadata(MusicTrack {
            id,
            title,
            artist,
            album: "已下载".into(),
            duration: 0,
            path: Some(path.to_string_lossy().into_owned()),
            cover_path: None,
        }));
    }
    tracks.sort_by(|left, right| left.title.to_lowercase().cmp(&right.title.to_lowercase()));
    Ok(tracks)
}

#[cfg(test)]
mod tests {

    #[test]
    fn local_metadata_and_artwork_survive_reload() {
        let directory = std::env::temp_dir().join(format!(
            "nexusdesk-music-{}-{}",
            std::process::id(),
            super::signature_time_fallback()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("123 - Artist - Song.mp3");
        let track = super::MusicTrack {
            id: "123".into(),
            title: "Song".into(),
            artist: "Artist".into(),
            album: "Album".into(),
            duration: 123000,
            path: Some(path.to_string_lossy().into_owned()),
            cover_path: None,
        };
        std::fs::write(
            path.with_extension("json"),
            serde_json::to_vec(&track).unwrap(),
        )
        .unwrap();
        std::fs::write(path.with_extension("jpg"), b"cached artwork").unwrap();
        let restored = super::restore_metadata(super::MusicTrack {
            album: String::new(),
            duration: 0,
            ..track
        });
        assert_eq!(restored.album, "Album");
        assert_eq!(restored.duration, 123000);
        assert_eq!(
            restored.cover_path,
            Some(path.with_extension("jpg").to_string_lossy().into_owned())
        );
        std::fs::remove_file(path.with_extension("jpg")).unwrap();
        assert!(super::restore_metadata(restored).cover_path.is_none());
        std::fs::remove_file(path.with_extension("json")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn imported_numeric_filename_keeps_its_local_identity_after_reload() {
        let directory = std::env::temp_dir().join(format!(
            "nexusdesk-import-metadata-{}-{}",
            std::process::id(),
            super::signature_time_fallback()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("123 - Artist - Song.mp3");
        std::fs::write(&path, b"audio").unwrap();
        let local_id = path.canonicalize().unwrap().to_string_lossy().into_owned();
        let saved = super::MusicTrack {
            id: local_id.clone(),
            title: "Song".into(),
            artist: "Artist".into(),
            album: "本地音乐".into(),
            duration: 0,
            path: Some(path.to_string_lossy().into_owned()),
            cover_path: None,
        };
        std::fs::write(
            path.with_extension("json"),
            serde_json::to_vec(&saved).unwrap(),
        )
        .unwrap();
        std::fs::write(path.with_extension("PNG"), b"cover").unwrap();
        let restored = super::restore_metadata(super::MusicTrack {
            id: "123".into(),
            title: String::new(),
            artist: String::new(),
            ..saved
        });
        assert_eq!(restored.id, local_id);
        assert_eq!(restored.title, "Song");
        assert_eq!(restored.artist, "Artist");
        assert_eq!(
            restored.cover_path,
            Some(path.with_extension("PNG").to_string_lossy().into_owned())
        );
        assert!(
            super::existing_track(&directory, "123", "Song", "Artist")
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
