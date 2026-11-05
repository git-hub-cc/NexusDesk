use std::{fs, io::{self, Write}, path::{Path, PathBuf}};
use serde::Serialize;

pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "m4a", "ogg", "wav", "aac"];
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "webm", "mov", "mkv", "avi", "ogv"];
const COVER_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"];

pub fn matching_cover(audio: &Path) -> Option<PathBuf> {
    let stem = audio.file_stem()?.to_string_lossy();
    let mut matches: Vec<_> = fs::read_dir(audio.parent()?).ok()?.flatten().map(|entry| entry.path())
        .filter(|path| path.is_file() && path.file_stem().is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(&stem)))
        .filter_map(|path| {
            let extension = path.extension()?.to_str()?.to_ascii_lowercase();
            Some((COVER_EXTENSIONS.iter().position(|item| *item == extension)?, path))
        }).collect();
    matches.sort();
    matches.into_iter().next().map(|(_, path)| path)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    imported: usize,
    skipped: usize,
    covers: usize,
    errors: Vec<String>,
}

// Reserve the destination first so a concurrent import cannot overwrite a file.
fn copy_new(source: &Path, destination: &Path) -> io::Result<()> {
    let mut input = fs::File::open(source)?;
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(destination)?;
    let copied = io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    drop(output);
    if copied.is_err() { let _ = fs::remove_file(destination); }
    copied
}

fn import_one(source: &Path, destination: &Path, music: bool) -> Result<Option<bool>, String> {
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    if !source.is_file() { return Err("请选择文件".into()); }
    let extension = source.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    if !(if music { AUDIO_EXTENSIONS } else { VIDEO_EXTENSIONS }).contains(&extension.as_str()) {
        return Err("不支持的文件格式".into());
    }
    if source.parent() == Some(destination) { return Ok(None); }
    let cover = if music { matching_cover(&source) } else { None };
    let stem = source.file_stem().ok_or("无效的文件名")?.to_string_lossy();
    for index in 0..10000 {
        let name = if index == 0 { stem.to_string() } else { format!("{stem} ({index})") };
        let target = destination.join(format!("{name}.{extension}"));
        // Sidecars belong to a stem; reserve a new stem even across audio formats.
        if music && fs::read_dir(destination).map_err(|e| e.to_string())?.flatten()
            .any(|entry| entry.path().file_stem().is_some_and(|v| v.to_string_lossy().eq_ignore_ascii_case(&name))) { continue; }
        match copy_new(&source, &target) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
            Ok(()) => {}
        }
        if let Some(cover) = &cover {
            let target_cover = target.with_extension(cover.extension().unwrap());
            if let Err(error) = copy_new(cover, &target_cover) {
                let _ = fs::remove_file(&target);
                return Err(format!("封面复制失败：{error}"));
            }
        }
        if music {
            // A local path ID keeps imports distinct from online tracks, including
            // files whose names happen to start with an online song number.
            let (artist, title) = stem.split_once(" - ").unwrap_or(("本地音乐", &stem));
            let metadata = serde_json::json!({ "id": target.to_string_lossy(), "title": title,
                "artist": artist, "album": "本地音乐", "duration": 0,
                "path": target.to_string_lossy(), "coverPath": null });
            let sidecar = target.with_extension("json");
            let saved = match fs::OpenOptions::new().write(true).create_new(true).open(&sidecar) {
                Ok(mut file) => {
                    let result = file.write_all(metadata.to_string().as_bytes()).and_then(|_| file.sync_all());
                    drop(file);
                    if result.is_err() { let _ = fs::remove_file(&sidecar); }
                    result
                }
                Err(error) => Err(error),
            };
            if let Err(error) = saved {
                let _ = fs::remove_file(&target);
                if let Some(cover) = &cover { let _ = fs::remove_file(target.with_extension(cover.extension().unwrap())); }
                return Err(format!("歌曲信息保存失败：{error}"));
            }
        }
        return Ok(Some(cover.is_some()));
    }
    Err("同名文件过多，无法导入".into())
}

fn import_files(paths: Vec<String>, destination: &Path, music: bool) -> Result<ImportResult, String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let destination = destination.canonicalize().map_err(|e| e.to_string())?;
    let mut result = ImportResult::default();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let source = Path::new(&path);
        if !seen.insert(source.canonicalize().unwrap_or_else(|_| source.to_path_buf())) { result.skipped += 1; continue; }
        match import_one(source, &destination, music) {
            Ok(Some(cover)) => { result.imported += 1; result.covers += usize::from(cover); }
            Ok(None) => result.skipped += 1,
            Err(error) => result.errors.push(format!("{}：{error}", source.file_name().unwrap_or_default().to_string_lossy())),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn import_media_files(paths: Vec<String>, kind: String) -> Result<ImportResult, String> {
    if !matches!(kind.as_str(), "music" | "video") { return Err("无效的媒体类型".into()); }
    let destination = dirs::home_dir().ok_or("无法获取用户目录")?.join(".note").join(&kind);
    tauri::async_runtime::spawn_blocking(move || import_files(paths, &destination, kind == "music"))
        .await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_copies_music_and_case_insensitive_cover_without_overwriting() {
        let root = std::env::temp_dir().join(format!("noteide-import-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let source = root.join("source");
        let library = root.join("library");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&library).unwrap();
        fs::write(source.join("Artist - Song.MP3"), b"new audio").unwrap();
        fs::write(source.join("ARTIST - SONG.PNG"), b"new cover").unwrap();
        fs::write(library.join("Artist - Song.flac"), b"old audio").unwrap();
        fs::write(library.join("Artist - Song.jpg"), b"old cover").unwrap();
        let audio = source.join("Artist - Song.MP3").to_string_lossy().into_owned();
        let result = import_files(vec![audio.clone(), audio, source.join("missing.mp3").to_string_lossy().into_owned()], &library, true).unwrap();
        assert_eq!((result.imported, result.covers, result.skipped, result.errors.len()), (1, 1, 1, 1));
        let copied = library.join("Artist - Song (1).mp3");
        assert_eq!(fs::read(&copied).unwrap(), b"new audio");
        let metadata: serde_json::Value = serde_json::from_slice(&fs::read(copied.with_extension("json")).unwrap()).unwrap();
        assert_eq!(metadata["id"].as_str().unwrap(), copied.canonicalize().unwrap().to_string_lossy());
        assert_eq!(fs::read(matching_cover(&copied).unwrap()).unwrap(), b"new cover");
        assert_eq!(fs::read(source.join("Artist - Song.MP3")).unwrap(), b"new audio");
        assert_eq!(fs::read(library.join("Artist - Song.jpg")).unwrap(), b"old cover");
        let result = import_files(vec![copied.to_string_lossy().into_owned()], &library, true).unwrap();
        assert_eq!((result.imported, result.skipped), (0, 1));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn video_import_continues_after_invalid_files_and_preserves_collisions() {
        let root = std::env::temp_dir().join(format!("noteide-video-import-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let source = root.join("source");
        let library = root.join("library");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&library).unwrap();
        fs::write(source.join("clip.MP4"), b"new video").unwrap();
        fs::write(source.join("bad.txt"), b"text").unwrap();
        fs::write(library.join("clip.mp4"), b"old video").unwrap();
        let paths = ["bad.txt", "clip.MP4"].iter().map(|name| source.join(name).to_string_lossy().into_owned()).collect();
        let result = import_files(paths, &library, false).unwrap();
        assert_eq!((result.imported, result.errors.len()), (1, 1));
        assert_eq!(fs::read(library.join("clip.mp4")).unwrap(), b"old video");
        assert_eq!(fs::read(library.join("clip (1).mp4")).unwrap(), b"new video");
        assert!(source.join("clip.MP4").is_file());
        assert!(matching_cover(&library.join("clip (1).mp4")).is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
