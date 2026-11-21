use crate::core::db;
use crate::core::fs::{self, FileNode};
use crate::core::path_operations::{self, Scan, Write};
use crate::state::AppState;
use std::path::PathBuf;
use tauri::{Emitter, State};

fn project_db(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, Option<rusqlite::Connection>>, String> {
    db::lock_db(&state.db_conn)
}

#[tauri::command]
pub async fn prepare_logical_sandbox(
    project: String,
    category: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if project.starts_with("sftp:") {
        return Err("镜像沙箱仅支持本地项目".into());
    }
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        static PREPARATIONS: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _preparation = PREPARATIONS.lock().map_err(|error| error.to_string())?;
        let base = dirs::home_dir()
            .ok_or("无法获取用户目录")?
            .join(".nexus/sandboxes");
        let sources = sandbox_sources(&connection, &category)?;
        let existing = sources
            .iter()
            .filter(|path| std::path::Path::new(path).exists())
            .cloned()
            .collect::<Vec<_>>();
        let sandbox = crate::core::sandbox::prepare(
            &base,
            std::path::Path::new(&project),
            &category,
            &existing,
        )?;
        if sandbox_sources(&connection, &category)? != sources {
            return Err("沙箱准备期间分类成员已变更，请重试".into());
        }
        Ok(sandbox.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sandbox_sources(
    connection: &std::sync::Mutex<Option<rusqlite::Connection>>,
    category: &str,
) -> Result<Vec<String>, String> {
    let guard = connection.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("数据库未初始化")?;
    let tree = db::read_logical_tree(conn).map_err(|e| e.to_string())?;
    let node = tree
        .iter()
        .find(|node| node.name == category)
        .ok_or("分类不存在")?;
    let mut statement = conn
        .prepare("SELECT path FROM logical_hidden WHERE category=?1")
        .map_err(|e| e.to_string())?;
    let hidden = statement
        .query_map([category], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut sources = node
        .children
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|entry| !hidden.contains(&entry.id))
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();
    sources.sort_unstable();
    sources.dedup();
    Ok(sources)
}

#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || std::fs::read(path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_binary_file_limited(
    path: String,
    max_size_bytes: usize,
) -> Result<Vec<u8>, String> {
    if max_size_bytes == 0 {
        return Err("图片大小限制必须大于 0".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;

        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(max_size_bytes.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > max_size_bytes {
            return Err(format!(
                "图片文件超过 {} MB 限制",
                max_size_bytes / (1024 * 1024)
            ));
        }
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(path, bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_asset(
    note_path: String,
    target_dir: Option<String>,
    source_path: Option<String>,
    name: Option<String>,
    bytes: Option<Vec<u8>>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let note = std::path::Path::new(&note_path);
        let directory = match target_dir {
            Some(path) => PathBuf::from(path),
            None => note.parent().ok_or("Invalid note path")?.join(".asset"),
        };
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        if let Some(source) = source_path {
            if !std::path::Path::new(&source).is_file() {
                return Err("Only files can be inserted into Markdown".into());
            }
            return fs::transfer_entry(
                std::path::Path::new(&source),
                &directory,
                true,
                &fs::TransferOptions::default(),
            );
        }
        let name = name.ok_or("Missing asset name")?;
        if name.is_empty()
            || name.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*'])
            || name == "."
            || name == ".."
            || name.ends_with(['.', ' '])
            || name.chars().any(|c| c.is_control())
        {
            return Err("Invalid asset name".into());
        }
        let bytes = bytes.ok_or("Missing asset data")?;
        let path = std::path::Path::new(&name);
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        let extension = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        for index in 0..10000 {
            let target = directory.join(if index == 0 {
                name.clone()
            } else {
                format!("{stem} ({index}){extension}")
            });
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
            {
                Ok(mut output) => {
                    use std::io::Write;
                    output.write_all(&bytes).map_err(|e| e.to_string())?;
                    return Ok(target.to_string_lossy().to_string());
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("Too many duplicate assets".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod asset_tests {
    #[tokio::test]
    async fn imports_binary_assets_beside_note_without_overwriting_or_moving_source() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-assets-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let note = root.join("notes/note.md").to_string_lossy().to_string();
        let bytes = vec![0, 255, 128, 0, 10];
        let source = root.join("图片.png");
        std::fs::write(&source, &bytes).unwrap();
        let first = super::import_asset(
            note.clone(),
            None,
            Some(source.to_string_lossy().to_string()),
            None,
            None,
        )
        .await
        .unwrap();
        let second = super::import_asset(
            note.clone(),
            None,
            None,
            Some("图片.png".into()),
            Some(bytes.clone()),
        )
        .await
        .unwrap();
        assert_ne!(first, second);
        assert_eq!(
            std::path::Path::new(&first).parent().unwrap(),
            root.join("notes/.asset")
        );
        assert_eq!(std::fs::read(&first).unwrap(), bytes);
        assert_eq!(std::fs::read(&second).unwrap(), bytes);
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        assert!(
            super::import_asset(
                note.clone(),
                None,
                None,
                Some("../escape.png".into()),
                Some(bytes.clone())
            )
            .await
            .is_err()
        );
        assert!(
            super::import_asset(
                note,
                None,
                Some(root.to_string_lossy().to_string()),
                None,
                None
            )
            .await
            .is_err()
        );
        let target = super::import_asset(
            String::new(),
            Some(root.to_string_lossy().to_string()),
            None,
            Some("附件.bin".into()),
            Some(bytes.clone()),
        )
        .await
        .unwrap();
        assert_eq!(std::path::Path::new(&target).parent().unwrap(), root);
        assert_eq!(std::fs::read(target).unwrap(), bytes);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
pub async fn project_directory_exists(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || match std::fs::metadata(&path) {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("{}: {}", path, error)),
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn is_directory(path: String) -> Result<bool, String> {
    let metadata = std::fs::metadata(&path).map_err(|error| format!("{}: {}", path, error))?;
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(format!("Unsupported path: {}", path));
    }
    Ok(metadata.is_dir())
}

#[tauri::command]
pub async fn init_project_db(
    path: String,
    app: tauri::AppHandle,
    watcher: State<'_, fs::WatcherState>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    fs::start_file_watcher(&path, app, &watcher)?;
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        init_project_db_blocking(&AppState {
            db_conn: connection,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn init_project_db_blocking(state: &AppState) -> Result<(), String> {
    let _guard = project_db(state)?;
    Ok(())
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fs::read_markdown_file(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn text_version(content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::core::text_file::version(&content))
        .await
        .map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    version: String,
}

#[tauri::command]
pub async fn read_file_snapshot(
    path: String,
    allow_missing: Option<bool>,
    known_version: Option<String>,
) -> Result<TextSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if allow_missing == Some(true)
            && crate::core::text_file::metadata(std::path::Path::new(&path))?.is_none()
        {
            return Ok(TextSnapshot {
                content: Some(String::new()),
                version: "missing".into(),
            });
        }
        let content = fs::read_markdown_file(&path)?;
        let version = crate::core::text_file::version(&content);
        let content = if known_version.as_deref() == Some(&version) {
            None
        } else {
            Some(content)
        };
        Ok(TextSnapshot { content, version })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSaveResult {
    logical_changed: bool,
    version: String,
}

#[tauri::command]
pub async fn write_file_snapshot(
    path: String,
    content: String,
    expected_version: String,
    state: State<'_, AppState>,
) -> Result<TextSaveResult, String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let logical_changed =
            write_file_checked(&path, &content, &connection, Some(&expected_version))?;
        Ok(TextSaveResult {
            logical_changed,
            version: crate::core::text_file::version(&content),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || write_file_blocking(&path, &content, &connection))
        .await
        .map_err(|e| e.to_string())?
}

fn write_file_blocking(
    path: &str,
    content: &str,
    connection: &std::sync::Mutex<Option<rusqlite::Connection>>,
) -> Result<bool, String> {
    write_file_checked(path, content, connection, None)
}

fn write_file_checked(
    path: &str,
    content: &str,
    connection: &std::sync::Mutex<Option<rusqlite::Connection>>,
    expected_version: Option<&str>,
) -> Result<bool, String> {
    use std::sync::{Arc, Mutex, OnceLock, Weak};
    static WRITES: OnceLock<Mutex<std::collections::HashMap<String, Weak<Mutex<()>>>>> =
        OnceLock::new();
    let file_lock = {
        let mut writes = WRITES
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|e| e.to_string())?;
        writes.retain(|_, lock| lock.strong_count() > 0);
        let canonical = std::path::Path::new(path).canonicalize().ok();
        let identity = canonical
            .as_deref()
            .unwrap_or(std::path::Path::new(path))
            .to_string_lossy();
        let key = if cfg!(windows) {
            identity.replace('\\', "/").to_lowercase()
        } else {
            identity.into_owned()
        };
        let lock = writes
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        writes.insert(key, Arc::downgrade(&lock));
        lock
    };
    let _file_guard = file_lock.lock().map_err(|e| e.to_string())?;
    let key = path_operations::canonical_key_path(std::path::Path::new(path));
    let _operation = Write::begin([key.as_path()])?;
    let before = crate::core::text_file::metadata(std::path::Path::new(path))?;
    let (old, existed) = match std::fs::read_to_string(path) {
        Ok(text) => (text, true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), false),
        Err(e) => return Err(e.to_string()),
    };
    let disk_version = if existed {
        crate::core::text_file::version(&old)
    } else {
        "missing".into()
    };
    if !crate::core::text_file::unchanged(
        &before,
        &crate::core::text_file::metadata(std::path::Path::new(path))?,
    ) {
        return Err(crate::core::text_file::CONFLICT.into());
    }
    if expected_version.is_some_and(|expected| expected != disk_version)
        && (!existed || old != content)
    {
        return Err(crate::core::text_file::CONFLICT.into());
    }
    let content_changed = !existed || old != content;
    let original_time = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|t| t.as_millis() as i64)
        .unwrap_or_else(crate::core::local_history::now);
    let markdown = path.to_lowercase().ends_with(".md");
    let logical_type = markdown.then(|| fs::markdown_type(content)).flatten();
    let logical_changed = !existed || (markdown && fs::markdown_type(&old) != logical_type);
    let links = fs::collect_links(std::path::Path::new(path), content)?;
    // 大文件写入临时文件时不占用项目数据库锁。
    let prepared = if content_changed {
        Some(crate::core::text_file::prepare_write(
            std::path::Path::new(path),
            content,
            &before,
        )?)
    } else {
        None
    };
    {
        let guard = connection.lock().map_err(|e| e.to_string())?;
        if let Some(conn) = guard.as_ref() {
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            if content_changed {
                crate::core::local_history::record(&tx, path, &old, content, original_time)?;
                prepared
                    .expect("changed content has a prepared write")
                    .commit()?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        } else {
            if let Some(prepared) = prepared {
                prepared.commit()?;
            }
        }
    }
    let modified = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let guard = connection.lock().map_err(|e| e.to_string())?;
    if let Some(conn) = guard.as_ref() {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        db::replace_links(&tx, path, &links).map_err(|e| e.to_string())?;
        if markdown {
            db::upsert_file_meta(&tx, path, logical_type.as_deref(), None, modified)
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    fs::invalidate_index_snapshot(path);
    Ok(logical_changed && content_changed)
}

#[cfg(test)]
mod text_save_tests {
    use super::*;
    use crate::core::{local_history, text_file};
    use std::sync::Mutex;

    #[tokio::test]
    async fn matching_versions_do_not_send_file_contents_back_to_the_watcher() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.txt");
        std::fs::write(&path, "unchanged").unwrap();
        let baseline = text_file::version("unchanged");
        let snapshot = read_file_snapshot(
            path.to_string_lossy().into_owned(),
            None,
            Some(baseline.clone()),
        )
        .await
        .unwrap();
        assert!(snapshot.content.is_none());
        assert_eq!(snapshot.version, baseline);
        let snapshot = read_file_snapshot(
            path.to_string_lossy().into_owned(),
            None,
            Some("outdated".into()),
        )
        .await
        .unwrap();
        assert_eq!(snapshot.content.as_deref(), Some("unchanged"));
    }

    #[cfg(windows)]
    #[test]
    fn failed_replacement_rolls_back_history_and_can_be_retried() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("locked.md");
        let connection = Mutex::new(Some(
            db::init_db(Some(directory.path().to_str().unwrap())).unwrap(),
        ));
        std::fs::write(&path, "original").unwrap();
        let baseline = text_file::version("original");
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(
            write_file_checked(
                path.to_str().unwrap(),
                "local",
                &connection,
                Some(&baseline)
            )
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
        assert!(
            local_history::list(
                connection.lock().unwrap().as_ref().unwrap(),
                path.to_str().unwrap()
            )
            .unwrap()
            .is_empty()
        );
        drop(locked);
        write_file_checked(
            path.to_str().unwrap(),
            "local",
            &connection,
            Some(&baseline),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "local");
    }

    #[test]
    fn same_size_external_changes_require_a_new_baseline_and_preserve_history() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        let connection = Mutex::new(Some(
            db::init_db(Some(directory.path().to_str().unwrap())).unwrap(),
        ));
        std::fs::write(&path, "first").unwrap();
        let baseline = text_file::version("first");
        std::fs::write(&path, "other").unwrap();
        let error = write_file_checked(
            path.to_str().unwrap(),
            "local",
            &connection,
            Some(&baseline),
        )
        .unwrap_err();
        assert!(error.contains("FILE_CONFLICT:"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "other");
        assert!(
            local_history::list(
                connection.lock().unwrap().as_ref().unwrap(),
                path.to_str().unwrap()
            )
            .unwrap()
            .is_empty()
        );
        write_file_checked(
            path.to_str().unwrap(),
            "local",
            &connection,
            Some(&text_file::version("other")),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "local");
        let guard = connection.lock().unwrap();
        let conn = guard.as_ref().unwrap();
        let entries = local_history::list(conn, path.to_str().unwrap()).unwrap();
        assert!(entries.iter().any(|entry| {
            local_history::content(conn, path.to_str().unwrap(), entry.id).unwrap() == "other"
        }));
        let count = entries.len();
        write_file_checked(
            path.to_str().unwrap(),
            "local",
            &Mutex::new(None),
            Some(&baseline),
        )
        .unwrap();
        assert_eq!(
            local_history::list(conn, path.to_str().unwrap())
                .unwrap()
                .len(),
            count
        );
    }

    #[test]
    fn retrying_an_already_written_file_repairs_link_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        let connection = Mutex::new(Some(
            db::init_db(Some(directory.path().to_str().unwrap())).unwrap(),
        ));
        std::fs::write(&path, "[[target.md]]").unwrap();
        let version = text_file::version("[[target.md]]");
        write_file_checked(
            path.to_str().unwrap(),
            "[[target.md]]",
            &connection,
            Some(&version),
        )
        .unwrap();
        {
            let guard = connection.lock().unwrap();
            guard
                .as_ref()
                .unwrap()
                .execute("DELETE FROM links", [])
                .unwrap();
        }
        assert!(
            !write_file_checked(
                path.to_str().unwrap(),
                "[[target.md]]",
                &connection,
                Some("stale-version"),
            )
            .unwrap()
        );
        let guard = connection.lock().unwrap();
        assert_eq!(
            db::get_links(guard.as_ref().unwrap(), path.to_str().unwrap(), false)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn deleted_files_are_not_recreated_without_explicit_missing_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deleted.md");
        let connection = Mutex::new(None);
        let error = write_file_checked(
            path.to_str().unwrap(),
            "local",
            &connection,
            Some(&text_file::version("old")),
        )
        .unwrap_err();
        assert!(error.contains("FILE_CONFLICT:"));
        assert!(!path.exists());
        write_file_checked(
            path.to_str().unwrap(),
            "local",
            &connection,
            Some("missing"),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "local");
    }

    #[test]
    fn concurrent_windows_cannot_both_save_against_the_same_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shared.md");
        std::fs::write(&path, "baseline").unwrap();
        let barrier = std::sync::Barrier::new(2);
        let connection = Mutex::new(None);
        let outcomes = std::thread::scope(|scope| {
            let handles: Vec<_> = ["first edit", "second edit"]
                .into_iter()
                .map(|content| {
                    let path = &path;
                    let barrier = &barrier;
                    let connection = &connection;
                    scope.spawn(move || {
                        barrier.wait();
                        write_file_checked(
                            path.to_str().unwrap(),
                            content,
                            connection,
                            Some(&text_file::version("baseline")),
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|result| result
                    .as_ref()
                    .is_err_and(|error| error.contains("FILE_CONFLICT:")))
                .count(),
            1
        );
    }
}

#[tauri::command]
pub async fn get_file_links(
    path: String,
    reverse: bool,
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map(|c| db::get_links(c, &path, reverse).map_err(|e| e.to_string()))
        .unwrap_or(Ok(Vec::new()))
}

#[tauri::command]
pub async fn read_directory(path: String) -> Result<Vec<FileNode>, String> {
    tauri::async_runtime::spawn_blocking(move || fs::read_dir_shallow(path))
        .await
        .map_err(|e| e.to_string())?
}

fn index_scopes(root: &std::path::Path, paths: Option<Vec<String>>) -> Vec<PathBuf> {
    let root_key = fs::index_path_key(&root.to_string_lossy());
    let mut scopes: Vec<PathBuf> = paths
        .unwrap_or_else(|| vec![root.to_string_lossy().into_owned()])
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| {
            let key = fs::index_path_key(&path.to_string_lossy());
            (key == root_key || key.starts_with(&format!("{root_key}/")))
                && !path.components().any(|part| {
                    matches!(
                        part.as_os_str().to_str(),
                        Some(".." | ".git" | ".nexus" | "node_modules")
                    )
                })
        })
        .collect();
    scopes.sort_by_key(|path| fs::index_path_key(&path.to_string_lossy()));
    scopes.dedup_by_key(|path| fs::index_path_key(&path.to_string_lossy()));
    let mut selected: Vec<PathBuf> = Vec::new();
    let mut selected_keys = std::collections::HashSet::new();
    for scope in scopes {
        let key = fs::index_path_key(&scope.to_string_lossy());
        if !scope
            .ancestors()
            .any(|parent| selected_keys.contains(&fs::index_path_key(&parent.to_string_lossy())))
        {
            selected_keys.insert(key);
            selected.push(scope);
        }
    }
    selected
}

#[tauri::command]
pub async fn sync_project_index(
    path: String,
    paths: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        sync_project_index_blocking(path, paths, &connection)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sync_project_index_blocking(
    path: String,
    paths: Option<Vec<String>>,
    connection: &std::sync::Mutex<Option<rusqlite::Connection>>,
) -> Result<(), String> {
    let root = std::path::Path::new(&path);
    let scopes = index_scopes(root, paths);
    let keys = scopes
        .iter()
        .map(|path| path_operations::canonical_key_path(path))
        .collect::<Vec<_>>();
    loop {
        let scan = Scan::begin(keys.iter().map(PathBuf::as_path));
        match try_sync_project_index(&scopes, connection, &scan) {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error) if scan.apply(|| ()).is_some() => return Err(error),
            Err(_) => {}
        }
    }
}

fn try_sync_project_index(
    scopes: &[PathBuf],
    connection: &std::sync::Mutex<Option<rusqlite::Connection>>,
    scan: &Scan,
) -> Result<bool, String> {
    let indexed_paths = {
        let guard = connection.lock().map_err(|e| e.to_string())?;
        let Some(conn) = guard.as_ref() else {
            return Ok(true);
        };
        let collation = if cfg!(windows) { " COLLATE NOCASE" } else { "" };
        let normalized = format!("REPLACE(path, '\\', '/'){collation}");
        let sql = format!(
            "SELECT path FROM file_meta WHERE {normalized}=?1 OR ({normalized}>=?2 AND {normalized}<?3)"
        );
        let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut paths = Vec::new();
        for scope in scopes {
            let key = fs::index_path_key(&scope.to_string_lossy());
            paths.extend(
                statement
                    .query_map(
                        rusqlite::params![key, format!("{key}/"), format!("{key}0")],
                        |r| r.get::<_, String>(0),
                    )
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?,
            );
        }
        paths
    };
    let mut files = Vec::new();
    for scope in scopes {
        if scope.exists() {
            files.extend(fs::collect_workspace_metadata(scope)?);
        }
    }
    let missing: Vec<_> = indexed_paths
        .into_iter()
        .filter_map(|p| {
            let revision = fs::index_revision(&p);
            (!std::path::Path::new(&p).exists()).then_some((p, revision))
        })
        .collect();

    let guard = connection.lock().map_err(|e| e.to_string())?;
    scan.apply(|| {
        let Some(conn) = guard.as_ref() else { return Ok(true); };
        let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        fs::apply_workspace_metadata(&files, &transaction)?;
        for (p, revision) in missing {
            if fs::index_revision(&p) != revision {
                continue;
            }
            transaction.execute("INSERT OR IGNORE INTO logical_refs(path, category) SELECT path, logical_type FROM file_meta WHERE path=?1 AND logical_type IS NOT NULL AND logical_type != ''", [&p]).map_err(|e| e.to_string())?;
            transaction
                .execute("DELETE FROM file_meta WHERE path=?1", [&p])
                .map_err(|e| e.to_string())?;
            transaction
                .execute("DELETE FROM links WHERE source_path=?1", [&p])
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }).unwrap_or(Ok(false))
}

#[tauri::command]
pub async fn get_logical_tree(state: State<'_, AppState>) -> Result<Vec<FileNode>, String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_logical_tree_blocking(&AppState {
            db_conn: connection,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct LogicalSyncEntry {
    pub path: String,
    pub category: String,
    pub kind: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct LogicalSyncData {
    pub workspace: String,
    #[serde(
        default,
        rename = "legacyWorkspace",
        skip_serializing_if = "Option::is_none"
    )]
    pub legacy_workspace: Option<String>,
    pub folders: Vec<String>,
    pub entries: Vec<LogicalSyncEntry>,
    #[serde(
        default,
        rename = "deletedFolders",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub deleted_folders: Vec<String>,
}

pub(super) fn relative_workspace_path(root: &std::path::Path, path: &str) -> Option<String> {
    let normalize = |value: &str| {
        value
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| value.strip_prefix(r"\\?\").map(str::to_string))
            .unwrap_or_else(|| value.to_string())
    };
    let root = normalize(&root.to_string_lossy());
    let path = normalize(path);
    let relative = std::path::Path::new(&path)
        .strip_prefix(std::path::Path::new(&root))
        .ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(relative.to_string_lossy().replace('\\', "/"))
}

fn sync_absolute_path(path: &str) -> String {
    path.strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| path.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or_else(|| path.to_string())
        .replace('\\', "/")
}

fn logical_sync_data(conn: &rusqlite::Connection, root: &str) -> Result<LogicalSyncData, String> {
    let legacy_workspace = std::fs::canonicalize(root)
        .ok()
        .map(|path| logical_workspace_id(&path));
    let workspace = "global".to_string();
    let mut entries = Vec::new();
    for (table, kind) in [
        ("logical_refs", "reference"),
        ("logical_copies", "copy"),
        ("logical_hidden", "hidden"),
    ] {
        let mut stmt = conn
            .prepare(&format!("SELECT path, category FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, category) = row.map_err(|e| e.to_string())?;
            entries.push(LogicalSyncEntry {
                path: sync_absolute_path(&path),
                category,
                kind: kind.into(),
            });
        }
    }
    let mut metadata = conn
        .prepare("SELECT path, logical_type FROM file_meta WHERE logical_type IS NOT NULL AND logical_type != '' AND path NOT IN (SELECT path FROM logical_refs)")
        .map_err(|e| e.to_string())?;
    let rows = metadata
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (path, category) = row.map_err(|e| e.to_string())?;
        entries.push(LogicalSyncEntry {
            path: sync_absolute_path(&path),
            category,
            kind: "reference".into(),
        });
    }
    entries.sort_by(|a, b| (&a.path, &a.category, &a.kind).cmp(&(&b.path, &b.category, &b.kind)));
    let mut folders = entries
        .iter()
        .map(|entry| entry.category.clone())
        .filter(|category| !category.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    let mut stmt = conn
        .prepare("SELECT name FROM logical_folders")
        .map_err(|e| e.to_string())?;
    for folder in stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        folders.insert(folder.map_err(|e| e.to_string())?);
    }
    Ok(LogicalSyncData {
        workspace,
        legacy_workspace,
        folders: folders.into_iter().collect(),
        entries,
        deleted_folders: Vec::new(),
    })
}

pub(super) fn logical_workspace_id(root: &std::path::Path) -> String {
    let remote = git2::Repository::discover(root)
        .ok()
        .and_then(|repo| {
            repo.find_remote("origin")
                .ok()
                .and_then(|remote| remote.url().map(str::to_owned))
        })
        .map(|url| {
            let without_credentials = url.rsplit_once('@').map(|(_, rest)| rest).unwrap_or(&url);
            without_credentials
                .trim_end_matches(".git")
                .trim_end_matches('/')
                .to_lowercase()
        });
    remote
        .map(|value| format!("git:{value}"))
        .unwrap_or_else(|| {
            format!(
                "folder:{}",
                root.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
            )
        })
}

#[cfg(test)]
mod logical_sync_tests {
    #[test]
    fn logical_sync_snapshot_shares_absolute_paths_across_projects() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-logical-sync-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("notes/inside.md");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::write(&inside, "note").unwrap();
        let outside = root.parent().unwrap().join("outside.md");
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE file_meta(path TEXT UNIQUE, logical_type TEXT);
             CREATE TABLE logical_folders(id INTEGER PRIMARY KEY, name TEXT UNIQUE);
             CREATE TABLE logical_refs(path TEXT PRIMARY KEY, category TEXT NOT NULL);
             CREATE TABLE logical_copies(path TEXT NOT NULL, category TEXT NOT NULL, PRIMARY KEY(path, category));
             CREATE TABLE logical_hidden(path TEXT NOT NULL, category TEXT NOT NULL, PRIMARY KEY(path, category));
             INSERT INTO logical_folders(name) VALUES ('notes'), ('empty');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO logical_refs(path,category) VALUES (?1,'notes')",
            [inside.to_string_lossy().as_ref()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO logical_copies(path,category) VALUES (?1,'copy')",
            [outside.to_string_lossy().as_ref()],
        )
        .unwrap();

        let snapshot = super::logical_sync_data(&conn, root.to_str().unwrap()).unwrap();
        assert_eq!(snapshot.workspace, "global");
        assert_eq!(snapshot.entries.len(), 2);
        assert!(
            snapshot
                .entries
                .iter()
                .any(|entry| entry.path == super::sync_absolute_path(inside.to_str().unwrap()))
        );
        assert!(
            snapshot
                .entries
                .iter()
                .any(|entry| entry.path == super::sync_absolute_path(outside.to_str().unwrap()))
        );
        let other = super::logical_sync_data(&conn, "nonexistent-project").unwrap();
        assert_eq!(other.workspace, snapshot.workspace);
        assert_eq!(other.entries.len(), snapshot.entries.len());
        assert!(snapshot.folders.contains(&"empty".to_string()));
        conn.execute(
            "INSERT INTO file_meta(path,logical_type) VALUES (?1,'notes')",
            [inside.to_string_lossy().as_ref()],
        )
        .unwrap();
        let mut invalid: super::LogicalSyncData =
            serde_json::from_value(serde_json::to_value(&snapshot).unwrap()).unwrap();
        invalid.entries[0].path = "relative.md".into();
        assert!(super::apply_logical_sync_data_in_db(&conn, "", invalid).is_err());
        assert_eq!(
            super::logical_sync_data(&conn, "").unwrap().entries.len(),
            2
        );
        let restored: super::LogicalSyncData =
            serde_json::from_value(serde_json::to_value(&snapshot).unwrap()).unwrap();
        super::apply_logical_sync_data_in_db(&conn, "another-project", restored).unwrap();
        assert_eq!(
            super::logical_sync_data(&conn, "").unwrap().entries.len(),
            2
        );
        super::apply_logical_sync_data_in_db(
            &conn,
            root.to_str().unwrap(),
            super::LogicalSyncData {
                workspace: snapshot.workspace,
                legacy_workspace: None,
                folders: vec!["empty".into()],
                entries: vec![],
                deleted_folders: vec!["notes".into()],
            },
        )
        .unwrap();
        let after = super::logical_sync_data(&conn, root.to_str().unwrap()).unwrap();
        assert_eq!(after.folders, vec!["empty"]);
        assert!(after.entries.iter().all(|entry| entry.category != "notes"));
        let outside_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM logical_copies", [], |row| row.get(0))
            .unwrap();
        assert_eq!(outside_count, 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
pub fn get_logical_sync_data(
    root: String,
    state: State<'_, AppState>,
) -> Result<LogicalSyncData, String> {
    let guard = project_db(&state)?;
    logical_sync_data(guard.as_ref().ok_or("数据库未初始化")?, &root)
}

#[tauri::command]
pub fn apply_logical_sync_data(
    root: String,
    data: LogicalSyncData,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = project_db(&state)?;
    apply_logical_sync_data_in_db(guard.as_ref().ok_or("数据库未初始化")?, &root, data)?;
    use tauri::Emitter;
    let _ = app.emit("logical-tree-updated", ());
    Ok(())
}

fn apply_logical_sync_data_in_db(
    conn: &rusqlite::Connection,
    _root: &str,
    data: LogicalSyncData,
) -> Result<(), String> {
    if data.workspace != "global" {
        return Err("云端逻辑分区必须使用全局数据".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare("SELECT path FROM file_meta UNION SELECT path FROM logical_refs UNION SELECT path FROM logical_copies UNION SELECT path FROM logical_hidden")
        .map_err(|e| e.to_string())?;
    let existing_paths = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let path_key = |path: &str| {
        let value = sync_absolute_path(path);
        if cfg!(windows) {
            value.to_lowercase()
        } else {
            value
        }
    };
    let existing_paths: std::collections::HashMap<_, _> = existing_paths
        .into_iter()
        .map(|path| (path_key(&path), path))
        .collect();
    for table in [
        "logical_refs",
        "logical_copies",
        "logical_hidden",
        "logical_folders",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| e.to_string())?;
    }
    for folder in &data.folders {
        db::insert_logical_folder(&tx, folder).map_err(|e| e.to_string())?;
    }
    for folder in &data.deleted_folders {
        tx.execute("DELETE FROM logical_folders WHERE name=?1", [folder])
            .map_err(|e| e.to_string())?;
    }
    // 保留显式空引用，阻止旧 frontmatter 分类在下次读取时恢复已删除条目。
    let mut stmt = tx
        .prepare("SELECT path FROM file_meta WHERE logical_type IS NOT NULL AND logical_type != ''")
        .map_err(|e| e.to_string())?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for path in paths {
        tx.execute(
            "INSERT OR IGNORE INTO logical_refs(path, category) VALUES (?1, '')",
            [&path],
        )
        .map_err(|e| e.to_string())?;
    }
    for entry in data.entries {
        if !std::path::Path::new(&entry.path).is_absolute() {
            return Err("云端逻辑分区必须使用绝对路径".into());
        }
        let path = existing_paths
            .get(&path_key(&entry.path))
            .unwrap_or(&entry.path);
        if !entry.category.is_empty() {
            db::insert_logical_folder(&tx, &entry.category).map_err(|e| e.to_string())?;
        }
        let table = match entry.kind.as_str() {
            "reference" => "logical_refs",
            "copy" => "logical_copies",
            "hidden" => "logical_hidden",
            _ => return Err("云端逻辑分区包含未知记录类型".into()),
        };
        tx.execute(
            &format!("INSERT OR REPLACE INTO {table}(path, category) VALUES (?1, ?2)"),
            rusqlite::params![path, entry.category],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn get_logical_tree_blocking(state: &AppState) -> Result<Vec<FileNode>, String> {
    let snapshot = {
        let guard = project_db(state)?;
        match guard.as_ref() {
            Some(conn) => db::read_logical_tree(conn).map_err(|e| e.to_string())?,
            None => Vec::new(),
        }
    };
    Ok(db::resolve_logical_tree(snapshot))
}

#[tauri::command]
pub async fn create_logical_folder(
    name: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        create_logical_folder_blocking(
            name,
            &AppState {
                db_conn: connection,
            },
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    use tauri::Emitter;
    let _ = app.emit("logical-tree-updated", ());
    Ok(())
}

fn create_logical_folder_blocking(name: String, state: &AppState) -> Result<(), String> {
    let guard = state.db_conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        db::insert_logical_folder(conn, &name).map_err(|e| e.to_string())
    } else {
        Err("数据库未初始化".to_string())
    }
}

#[tauri::command]
pub async fn update_file_frontmatter(
    path: String,
    new_type: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        update_file_frontmatter_blocking(
            path,
            new_type,
            &AppState {
                db_conn: connection,
            },
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    use tauri::Emitter;
    let _ = app.emit("logical-tree-updated", ());
    Ok(())
}

#[tauri::command]
pub fn remove_logical_file(
    path: String,
    category: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = project_db(&state)?;
    let conn = guard
        .as_ref()
        .expect("project_db initializes the connection");
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::insert_logical_folder(&tx, &category).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO logical_hidden(path, category) VALUES (?1, ?2)",
        rusqlite::params![path, category],
    )
    .map_err(|e| e.to_string())?;
    // An empty override hides legacy frontmatter membership without editing the file.
    tx.execute("INSERT INTO logical_refs(path, category) SELECT path, '' FROM file_meta WHERE path=?1 AND logical_type=?2 AND path NOT IN (SELECT path FROM logical_refs)", rusqlite::params![path, category]).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE logical_refs SET category='' WHERE path=?1 AND category=?2",
        rusqlite::params![path, category],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM logical_copies WHERE path=?1 AND category=?2",
        rusqlite::params![path, category],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    use tauri::Emitter;
    let _ = app.emit("logical-tree-updated", ());
    Ok(())
}

#[tauri::command]
pub fn get_hidden_logical_files(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let guard = project_db(&state)?;
    let conn = guard
        .as_ref()
        .expect("project_db initializes the connection");
    let mut stmt = conn
        .prepare("SELECT path, category FROM logical_hidden")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn update_file_frontmatter_blocking(
    path: String,
    new_type: String,
    state: &AppState,
) -> Result<(), String> {
    let guard = project_db(state)?;
    let conn = guard
        .as_ref()
        .expect("project_db initializes the connection");
    if !std::path::Path::new(&path).exists() {
        return Err("Source does not exist".into());
    }
    // All entries, including Markdown, store membership in .nexus/index.db.
    // Explicit references override legacy frontmatter without changing user files.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM logical_hidden WHERE path=?1 AND category=?2",
        rusqlite::params![path, new_type],
    )
    .map_err(|e| e.to_string())?;
    db::insert_logical_folder(&tx, &new_type).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO logical_refs(path, category) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET category=excluded.category", rusqlite::params![path, new_type]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn copy_file_to_dir(
    source_path: String,
    target_dir: String,
    opts: Option<fs::TransferOptions>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::transfer_entry(
            std::path::Path::new(&source_path),
            std::path::Path::new(&target_dir),
            true,
            &opts.unwrap_or_default(),
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn move_entry(
    source_path: String,
    target_dir: String,
    opts: Option<fs::TransferOptions>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<fs::MoveOutcome, String> {
    move_local_entry(
        source_path,
        target_dir,
        None,
        opts,
        app,
        state.db_conn.clone(),
    )
    .await
}

#[tauri::command]
pub async fn rename_entry(
    source_path: String,
    name: String,
    opts: Option<fs::TransferOptions>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<fs::MoveOutcome, String> {
    let target_dir = std::path::Path::new(&source_path)
        .parent()
        .ok_or("Invalid source path")?
        .to_string_lossy()
        .to_string();
    move_local_entry(
        source_path,
        target_dir,
        Some(name),
        opts,
        app,
        state.db_conn.clone(),
    )
    .await
}

async fn move_local_entry(
    source_path: String,
    target_dir: String,
    name: Option<String>,
    opts: Option<fs::TransferOptions>,
    app: tauri::AppHandle,
    connection: std::sync::Arc<std::sync::Mutex<Option<rusqlite::Connection>>>,
) -> Result<fs::MoveOutcome, String> {
    let database = connection.clone();
    let (mut outcome, retry) = tauri::async_runtime::spawn_blocking(move || {
        let opts = opts.unwrap_or_default();
        let plan = fs::MovePlan::new(
            std::path::Path::new(&source_path),
            std::path::Path::new(&target_dir),
            name.as_deref(),
            &opts,
        )?;
        execute_local_move(&database, &plan, || plan.execute(&opts))
    })
    .await
    .map_err(|error| error.to_string())??;
    if let Some(operation) = retry {
        outcome.index_pending = true;
        let moved = outcome.moved.clone();
        tauri::async_runtime::spawn(async move {
            let mut delay = std::time::Duration::from_millis(250);
            let work = std::sync::Arc::new((operation, connection, moved));
            loop {
                tokio::time::sleep(delay).await;
                let attempt = work.clone();
                match tauri::async_runtime::spawn_blocking(move || {
                    commit_move_index(&attempt.1, &attempt.2)
                })
                .await
                {
                    Ok(Ok(())) => break,
                    Ok(Err(error)) => log::warn!("移动后的索引重试失败: {error}"),
                    Err(error) => log::warn!("移动后的索引重试任务失败: {error}"),
                }
                delay = (delay * 2).min(std::time::Duration::from_secs(30));
            }
            drop(work);
            emit_move_index_updated(&app);
        });
    } else if !outcome.moved.is_empty() {
        emit_move_index_updated(&app);
    }
    Ok(outcome)
}

fn execute_local_move(
    connection: &std::sync::Mutex<Option<rusqlite::Connection>>,
    plan: &fs::MovePlan,
    execute: impl FnOnce() -> fs::MoveOutcome,
) -> Result<(fs::MoveOutcome, Option<Write>), String> {
    let operation = Write::begin([plan.source.as_path(), plan.target.as_path()])?;
    let outcome = execute();
    if !outcome.moved.is_empty() {
        if let Err(error) = commit_move_index(connection, &outcome.moved) {
            log::warn!("移动后的索引提交失败，将重试: {error}");
            return Ok((outcome, Some(operation)));
        }
    }
    Ok((outcome, None))
}

fn emit_move_index_updated(app: &tauri::AppHandle) {
    let _ = app.emit("logical-tree-updated", ());
    let _ = app.emit("workspace-move-indexed", ());
}

fn commit_move_index(
    connection: &std::sync::Mutex<Option<rusqlite::Connection>>,
    moved: &[fs::MovedPath],
) -> Result<(), String> {
    let mut files = Vec::new();
    for path in moved {
        let target = std::path::Path::new(&path.target);
        if path.subtree || target.is_file() {
            files.extend(fs::collect_workspace_metadata(target)?);
        }
    }
    let guard = connection.lock().map_err(|error| error.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(());
    };
    // 其他进程占用写锁时，交给后台重试，避免阻塞此进程的其他数据库操作。
    conn.busy_timeout(std::time::Duration::ZERO)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
        update_moved_paths(&tx, moved)?;
        clear_moved_links(&tx, moved)?;
        fs::apply_workspace_metadata(&files, &tx)?;
        tx.commit().map_err(|error| error.to_string())
    })();
    conn.busy_timeout(db::BUSY_TIMEOUT)
        .map_err(|error| error.to_string())?;
    result
}

#[cfg(test)]
fn remap_entry_paths(
    conn: &rusqlite::Connection,
    source_path: &str,
    target: &str,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    update_moved_paths(
        &tx,
        &[fs::MovedPath {
            source: source_path.into(),
            target: target.into(),
            subtree: true,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())
}

fn update_moved_paths(conn: &rusqlite::Connection, moved: &[fs::MovedPath]) -> Result<(), String> {
    for table in [
        "file_meta",
        "logical_refs",
        "logical_copies",
        "logical_hidden",
        "local_history",
        "local_history_heads",
        "graph_files",
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            continue;
        }
        let path_expr = db::indexed_path_expression("path");
        let suffix = format!("substr({}, length(?1) + 1)", path_expr);
        let suffix = if cfg!(windows) {
            format!("replace({}, '/', char(92))", suffix)
        } else {
            suffix
        };
        let updated = format!("?2 || {}", suffix);
        let mut exact = conn
            .prepare_cached(&format!(
                "UPDATE OR REPLACE {table} SET path=?2 WHERE {path_expr}=?1"
            ))
            .map_err(|error| error.to_string())?;
        let mut descendants = conn.prepare_cached(&format!(
            "UPDATE OR REPLACE {table} SET path={updated} WHERE {path_expr}>=?3 AND {path_expr}<?4"
        )).map_err(|error| error.to_string())?;
        for path in moved {
            let source = fs::index_path_key(&path.source);
            let target = &path.target;
            exact
                .execute(rusqlite::params![source, target])
                .map_err(|error| error.to_string())?;
            if path.subtree {
                descendants
                    .execute(rusqlite::params![
                        source,
                        target,
                        format!("{source}/"),
                        format!("{source}0")
                    ])
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn clear_moved_links(conn: &rusqlite::Connection, moved: &[fs::MovedPath]) -> Result<(), String> {
    let path = db::indexed_path_expression("source_path");
    let mut exact = conn
        .prepare_cached(&format!("DELETE FROM links WHERE {path}=?1"))
        .map_err(|error| error.to_string())?;
    let mut descendants = conn
        .prepare_cached(&format!("DELETE FROM links WHERE {path}>=?1 AND {path}<?2"))
        .map_err(|error| error.to_string())?;
    for path in moved {
        for name in [&path.source, &path.target] {
            let key = fs::index_path_key(name);
            exact.execute([&key]).map_err(|error| error.to_string())?;
            if path.subtree {
                descendants
                    .execute([format!("{key}/"), format!("{key}0")])
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn create_physical_file(path: String) -> Result<(), String> {
    fs::create_empty_file(path)
}

#[tauri::command]
pub fn create_physical_dir(path: String) -> Result<(), String> {
    fs::create_directory(path)
}

#[tauri::command]
pub async fn compare_text(left: String, right: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut options = git2::DiffOptions::new();
        options.context_lines(10000);
        options.force_text(true);
        options.ignore_whitespace_eol(true);
        options.ignore_whitespace_change(true);
        let mut patch = git2::Patch::from_buffers(
            left.as_bytes(),
            None,
            right.as_bytes(),
            None,
            Some(&mut options),
        )
        .map_err(|error| error.to_string())?;
        let buffer = patch.to_buf().map_err(|error| error.to_string())?;
        Ok(String::from_utf8_lossy(buffer.as_ref()).into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn touch_file(path: String, state: State<'_, AppState>) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Ok(());
    }
    if let Some(conn) = state.db_conn.lock().map_err(|e| e.to_string())?.as_ref() {
        db::touch_file(conn, &path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn recent_files(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(vec![]);
    };
    let mut stmt = conn.prepare("SELECT path FROM file_meta WHERE last_accessed IS NOT NULL ORDER BY last_accessed DESC, path").map_err(|e| e.to_string())?;
    let paths = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    paths
        .filter_map(|r| match r {
            Ok(p) if std::path::Path::new(&p).is_file() => Some(Ok(p)),
            Ok(_) => None,
            Err(e) => Some(Err(e.to_string())),
        })
        .take(100)
        .collect()
}

// Deleted entries live outside the project until restored. Never overwrite a backup.
#[tauri::command]
pub async fn stash_entry(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = path_operations::canonical_key_path(std::path::Path::new(&path));
        let _operation = Write::begin([key.as_path()])?;
        crate::core::delete_guard::check_directory(std::path::Path::new(&path))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("nexusdesk-trash-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let source = std::path::Path::new(&path);
        let target = directory.join(source.file_name().ok_or("Invalid entry path")?);
        // Same-volume deletion is an atomic rename, including directories and links.
        if std::fs::rename(source, &target).is_ok() {
            return Ok(target.to_string_lossy().to_string());
        }
        // Complete the backup before removing anything on another volume.
        let backup = fs::transfer_entry(source, &directory, true, &fs::TransferOptions::default())?;
        if source.is_dir() {
            std::fs::remove_dir_all(source)
        } else {
            std::fs::remove_file(source)
        }
        .map_err(|e| e.to_string())?;
        Ok(backup)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_entry(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&path);
        let key = path_operations::canonical_key_path(path);
        let _operation = Write::begin([key.as_path()])?;
        crate::core::delete_guard::check_directory(path)?;
        let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        }
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_local_history(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::core::local_history::Entry>, String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    crate::core::local_history::list(
        guard.as_ref().ok_or("Local History database unavailable")?,
        &path,
    )
}
#[tauri::command]
pub fn local_history_content(
    path: String,
    id: i64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("Local History database unavailable")?;
    crate::core::local_history::prune(conn).map_err(|e| e.to_string())?;
    crate::core::local_history::content(conn, &path, id)
}

#[tauri::command]
pub fn edit_logical_folder(
    name: String,
    new_name: Option<String>,
    copy: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("数据库未初始化")?;
    edit_logical_folder_in_db(conn, &name, new_name.as_deref(), copy)?;
    use tauri::Emitter;
    let _ = app.emit("logical-tree-updated", ());
    Ok(())
}

fn edit_logical_folder_in_db(
    conn: &rusqlite::Connection,
    name: &str,
    new_name: Option<&str>,
    copy: bool,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let tree = db::get_logical_tree(&tx).map_err(|e| e.to_string())?;
    let source = tree
        .iter()
        .find(|node| node.name == name)
        .ok_or("分类不存在")?;
    if let Some(target) = &new_name {
        if target.trim().is_empty()
            || tree
                .iter()
                .any(|node| node.name.to_lowercase() == target.to_lowercase())
        {
            return Err("分类名称为空或已存在".into());
        }
        db::insert_logical_folder(&tx, target).map_err(|e| e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO logical_hidden(path, category) SELECT path, ?1 FROM logical_hidden WHERE category=?2", rusqlite::params![target, name]).map_err(|e| e.to_string())?;
        for child in source.children.as_deref().unwrap_or_default() {
            tx.execute(
                "INSERT OR IGNORE INTO logical_copies(path, category) VALUES (?1, ?2)",
                rusqlite::params![child.id, target],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if !copy {
        // An explicit empty override prevents indexed frontmatter from restoring a removed category.
        tx.execute("INSERT INTO logical_refs(path, category) SELECT path, '' FROM file_meta WHERE logical_type=?1 AND path NOT IN (SELECT path FROM logical_refs)", [&name]).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE logical_refs SET category='' WHERE category=?1",
            [&name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM logical_copies WHERE category=?1", [&name])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM logical_hidden WHERE category=?1", [&name])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM logical_folders WHERE name=?1", [&name])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod logical_folder_tests {
    #[test]
    fn markdown_membership_is_persisted_without_modifying_source() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-membership-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("note.md");
        // Even malformed frontmatter must not prevent assigning a category.
        let content = "---\r\ntags: [broken\r\n---\r\nKeep this content\r\n";
        std::fs::write(&file, content).unwrap();
        let state = crate::state::AppState {
            db_conn: std::sync::Arc::new(std::sync::Mutex::new(Some(
                crate::core::db::init_db(Some(root.to_str().unwrap())).unwrap(),
            ))),
        };
        for category in ["first", "second"] {
            super::update_file_frontmatter_blocking(
                file.to_string_lossy().into_owned(),
                category.into(),
                &state,
            )
            .unwrap();
            assert_eq!(std::fs::read(&file).unwrap(), content.as_bytes());
        }
        drop(state);
        let conn = crate::core::db::init_db(Some(root.to_str().unwrap())).unwrap();
        crate::core::fs::sync_workspace_to_db(&root, &conn).unwrap();
        let tree = crate::core::db::get_logical_tree(&conn).unwrap();
        let category = tree.iter().find(|node| node.name == "second").unwrap();
        assert_eq!(
            category.children.as_ref().unwrap()[0].id,
            file.to_str().unwrap()
        );
        assert!(
            tree.iter()
                .find(|node| node.name == "first")
                .unwrap()
                .children
                .as_ref()
                .unwrap()
                .is_empty()
        );
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn category_operations_preserve_files_and_survive_reindexing() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-categories-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("note.md");
        let content = "---\ntype: original\n---\nKeep this content";
        std::fs::write(&file, content).unwrap();
        let conn = crate::core::db::init_db(Some(root.to_str().unwrap())).unwrap();
        let index = || {
            crate::core::db::upsert_file_meta(
                &conn,
                file.to_str().unwrap(),
                Some("original"),
                None,
                0,
            )
            .unwrap()
        };
        index();
        super::edit_logical_folder_in_db(&conn, "original", Some("copy"), true).unwrap();
        assert_eq!(crate::core::db::get_logical_tree(&conn).unwrap().len(), 2);
        assert!(super::edit_logical_folder_in_db(&conn, "original", Some("COPY"), true).is_err());
        super::edit_logical_folder_in_db(&conn, "original", Some("renamed"), false).unwrap();
        index();
        let tree = crate::core::db::get_logical_tree(&conn).unwrap();
        assert_eq!(
            tree.iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            vec!["copy", "renamed"]
        );
        assert!(
            tree.iter()
                .all(|node| node.children.as_ref().unwrap()[0].id == file.to_str().unwrap())
        );
        super::edit_logical_folder_in_db(&conn, "renamed", None, false).unwrap();
        super::edit_logical_folder_in_db(&conn, "copy", None, false).unwrap();
        index();
        assert!(crate::core::db::get_logical_tree(&conn).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(file).unwrap(), content);
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod path_remap_tests {
    use super::*;

    #[test]
    fn moving_files_leaves_database_available_and_invalidates_older_scan() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("from.md");
        let destination = root.path().join("to");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(&source, "[[next.md]]").unwrap();
        let conn = db::init_db(root.path().to_str()).unwrap();
        conn.execute("INSERT INTO terminal_history VALUES ('command', 0)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO logical_refs VALUES (?1, 'category')",
            [source.to_str().unwrap()],
        )
        .unwrap();
        let connection = std::sync::Mutex::new(Some(conn));
        let opts = fs::TransferOptions::default();
        let plan = fs::MovePlan::new(&source, &destination, None, &opts).unwrap();
        let old_scan = Scan::begin([root.path()]);
        let (outcome, pending) = execute_local_move(&connection, &plan, || {
            let guard = connection.try_lock().expect("磁盘操作期间不能持有数据库锁");
            let conn = guard.as_ref().unwrap();
            assert_eq!(
                conn.query_row("SELECT command FROM terminal_history", [], |row| row
                    .get::<_, String>(0))
                    .unwrap(),
                "command"
            );
            conn.execute(
                "INSERT INTO global_settings VALUES ('setting', 'value')",
                [],
            )
            .unwrap();
            assert!(Write::begin([plan.source.as_path()]).is_err());
            drop(guard);
            let outcome = plan.execute(&opts);
            assert!(old_scan.apply(|| ()).is_none());
            outcome
        })
        .unwrap();
        assert!(pending.is_none());
        assert!(outcome.error.is_none());
        assert!(!source.exists());
        let guard = connection.lock().unwrap();
        let conn = guard.as_ref().unwrap();
        assert_eq!(
            conn.query_row("SELECT path FROM logical_refs", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            outcome.target
        );
        let links = db::get_links(conn, &outcome.target, false).unwrap();
        assert_eq!(links.len(), 1);
        assert!(links[0].0.ends_with("/to/next.md"));
    }

    #[test]
    fn merging_moves_only_entries_that_were_not_skipped() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target_dir = root.path().join("target");
        let destination = target_dir.join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        let skipped = source.join("keep.md");
        let moved = source.join("move.md");
        for file in [&skipped, &moved, &destination.join("keep.md")] {
            std::fs::write(file, "note").unwrap();
        }
        let conn = db::init_db(root.path().to_str()).unwrap();
        for path in [&skipped, &moved] {
            conn.execute(
                "INSERT INTO logical_refs VALUES (?1, 'category')",
                [path.to_str().unwrap()],
            )
            .unwrap();
        }
        let opts = fs::TransferOptions {
            merge_folders: true,
            skip_all: true,
            ..Default::default()
        };
        let plan = fs::MovePlan::new(&source, &target_dir, None, &opts).unwrap();
        let connection = std::sync::Mutex::new(Some(conn));
        let (outcome, pending) =
            execute_local_move(&connection, &plan, || plan.execute(&opts)).unwrap();
        assert!(outcome.error.is_none());
        assert!(pending.is_none());
        assert_eq!(outcome.moved.len(), 1);
        assert!(skipped.exists());
        assert!(!moved.exists());
        let guard = connection.lock().unwrap();
        let conn = guard.as_ref().unwrap();
        for path in [skipped.to_string_lossy().as_ref(), &outcome.moved[0].target] {
            assert!(
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM logical_refs WHERE path=?1)",
                    [path],
                    |row| row.get::<_, bool>(0)
                )
                .unwrap()
            );
        }
    }

    #[test]
    fn index_write_contention_can_retry_without_moving_the_file_again() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.md");
        std::fs::write(&source, "note").unwrap();
        let conn = db::init_db(root.path().to_str()).unwrap();
        conn.execute(
            "INSERT INTO logical_refs VALUES (?1, 'category')",
            [source.to_str().unwrap()],
        )
        .unwrap();
        let blocker = rusqlite::Connection::open(root.path().join(".nexus/index.db")).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        let connection = std::sync::Mutex::new(Some(conn));
        let opts = fs::TransferOptions::default();
        let plan = fs::MovePlan::new(&source, root.path(), Some("target.md"), &opts).unwrap();
        let (outcome, pending) =
            execute_local_move(&connection, &plan, || plan.execute(&opts)).unwrap();
        let pending = pending.expect("应保留索引提交任务");
        assert!(!source.exists());
        assert!(plan.target.is_file());
        let guard = connection.try_lock().unwrap();
        assert_eq!(
            guard
                .as_ref()
                .unwrap()
                .query_row("SELECT path FROM logical_refs", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            source.to_string_lossy()
        );
        drop(guard);
        blocker.execute_batch("COMMIT").unwrap();
        commit_move_index(&connection, &outcome.moved).unwrap();
        drop(pending);
        let guard = connection.lock().unwrap();
        assert_eq!(
            guard
                .as_ref()
                .unwrap()
                .query_row("SELECT path FROM logical_refs", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            outcome.target
        );
    }
    #[test]
    fn moving_back_to_an_indexed_path_preserves_source_metadata() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE file_meta(path TEXT UNIQUE, tags TEXT);
            CREATE TABLE logical_refs(path TEXT PRIMARY KEY, category TEXT);
            CREATE TABLE graph_files(category TEXT, path TEXT, PRIMARY KEY(category,path));
            INSERT INTO file_meta VALUES ('project/old.md','stale'), ('project/new.md','current');
            INSERT INTO logical_refs VALUES ('project/old.md','stale'), ('project/new.md','current');
            INSERT INTO graph_files VALUES ('shared','project/old.md'), ('shared','project/new.md'), ('extra','project/new.md');").unwrap();
        super::remap_entry_paths(&conn, "project/new.md", "project/old.md").unwrap();
        let tags: String = conn
            .query_row(
                "SELECT tags FROM file_meta WHERE path='project/old.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tags, "current");
        let category: String = conn
            .query_row(
                "SELECT category FROM logical_refs WHERE path='project/old.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(category, "current");
        let memberships: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM graph_files WHERE path='project/old.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(memberships, 2);
        super::remap_entry_paths(&conn, "project/old.md", "project/new.md").unwrap();
        assert_eq!(
            conn.query_row("SELECT tags FROM file_meta", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "current"
        );
    }

    #[test]
    fn directory_move_replaces_stale_nested_index_entries() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE file_meta(path TEXT UNIQUE, tags TEXT);
            INSERT INTO file_meta VALUES ('project/folder/note.md','current');",
        )
        .unwrap();
        let target = std::path::Path::new("project/moved").join("note.md");
        conn.execute(
            "INSERT INTO file_meta VALUES (?1,'stale')",
            [target.to_str().unwrap()],
        )
        .unwrap();
        super::remap_entry_paths(&conn, "project/folder", "project/moved").unwrap();
        let rows: (i64, String) = conn
            .query_row("SELECT COUNT(*), tags FROM file_meta", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(rows, (1, "current".into()));
    }

    #[test]
    fn rename_and_directory_move_preserve_graph_memberships() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE graph_files(category TEXT, path TEXT, PRIMARY KEY(category,path));
            INSERT INTO graph_files VALUES ('a','project/old.tree'), ('b','project/old.tree'), ('c','project/folder/nested.tree'), ('d','project/folder-other/keep.tree');").unwrap();
        super::remap_entry_paths(&conn, "project/old.tree", "project/new.tree").unwrap();
        super::remap_entry_paths(&conn, "project/folder", "project/moved").unwrap();
        let count = |path: &str| {
            conn.query_row(
                "SELECT COUNT(*) FROM graph_files WHERE replace(path, char(92), '/')=?1",
                [path],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
        };
        assert_eq!(count("project/new.tree"), 2);
        assert_eq!(count("project/moved/nested.tree"), 1);
        assert_eq!(count("project/folder-other/keep.tree"), 1);
        assert_eq!(count("project/old.tree"), 0);
    }
}

#[cfg(test)]
mod index_performance_tests {
    use super::*;

    fn workspace() -> (PathBuf, std::sync::Mutex<Option<rusqlite::Connection>>) {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-incremental-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let conn = db::init_db(Some(root.to_str().unwrap())).unwrap();
        (root, std::sync::Mutex::new(Some(conn)))
    }

    fn category(
        connection: &std::sync::Mutex<Option<rusqlite::Connection>>,
        path: &std::path::Path,
    ) -> String {
        connection
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .query_row(
                "SELECT logical_type FROM file_meta WHERE path=?1",
                [path.to_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn git_ignored_documents_keep_categories_and_links_in_full_and_incremental_indexes() {
        let (root, conn) = workspace();
        std::fs::create_dir_all(root.join("private")).unwrap();
        std::fs::write(root.join(".gitignore"), "private/\n").unwrap();
        std::fs::write(root.join(".ignore"), "private/\n").unwrap();
        let path = root.join("private").join("note.md");
        std::fs::write(&path, "---\ntype: initial\n---\n[[old.md]]").unwrap();
        let root_path = root.to_string_lossy().into_owned();
        let file_path = path.to_string_lossy().into_owned();
        sync_project_index_blocking(root_path.clone(), None, &conn).unwrap();
        assert_eq!(category(&conn, &path), "initial");

        std::fs::write(&path, "---\ntype: updated\n---\n[[new.md]]").unwrap();
        sync_project_index_blocking(root_path.clone(), Some(vec![file_path.clone()]), &conn)
            .unwrap();
        assert_eq!(category(&conn, &path), "updated");

        std::fs::write(&path, "---\ntype: rescanned\n---\n[[final.md]]").unwrap();
        sync_project_index_blocking(root_path, None, &conn).unwrap();
        assert_eq!(category(&conn, &path), "rescanned");
        {
            let guard = conn.lock().unwrap();
            let links = db::get_links(guard.as_ref().unwrap(), &file_path, false).unwrap();
            assert_eq!(links.len(), 1);
            assert!(links[0].0.ends_with("/final.md"));
        }
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incremental_index_only_reads_changed_paths_and_preserves_renamed_references() {
        let (root, conn) = workspace();
        let old_dir = root.join("old");
        std::fs::create_dir_all(&old_dir).unwrap();
        let a = old_dir.join("a.md");
        let b = root.join("b.md");
        std::fs::write(&a, "---\ntype: alpha\n---\n[[../b.md]]").unwrap();
        std::fs::write(&b, "---\ntype: beta\n---").unwrap();
        sync_project_index_blocking(root.to_string_lossy().into_owned(), None, &conn).unwrap();
        std::fs::write(&a, "---\ntype: changed\n---").unwrap();
        std::fs::write(&b, "---\ntype: not-in-this-event\n---").unwrap();
        sync_project_index_blocking(
            root.to_string_lossy().into_owned(),
            Some(vec![a.to_string_lossy().into_owned()]),
            &conn,
        )
        .unwrap();
        assert_eq!(category(&conn, &a), "changed");
        assert_eq!(category(&conn, &b), "beta");
        let new_dir = root.join("renamed");
        std::fs::rename(&old_dir, &new_dir).unwrap();
        sync_project_index_blocking(
            root.to_string_lossy().into_owned(),
            Some(vec![
                old_dir.to_string_lossy().into_owned(),
                new_dir.to_string_lossy().into_owned(),
            ]),
            &conn,
        )
        .unwrap();
        assert_eq!(category(&conn, &new_dir.join("a.md")), "changed");
        let tree = get_logical_tree_blocking(&AppState {
            db_conn: std::sync::Arc::new(conn),
        })
        .unwrap();
        let entries = tree
            .iter()
            .find(|n| n.name == "changed")
            .unwrap()
            .children
            .as_ref()
            .unwrap();
        assert!(
            entries
                .iter()
                .any(|n| n.id == a.to_string_lossy() && n.missing)
        );
        assert!(
            entries
                .iter()
                .any(|n| n.id == new_dir.join("a.md").to_string_lossy() && !n.missing)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saved_metadata_cannot_be_overwritten_by_an_older_index_snapshot() {
        let (root, conn) = workspace();
        let path = root.join("note.md");
        std::fs::write(&path, "---\ntype: old\n---\n[[old.md]]").unwrap();
        let snapshot = fs::collect_workspace_metadata(&root).unwrap();
        assert!(
            write_file_blocking(
                path.to_str().unwrap(),
                "---\ntype: new\n---\n[[new.md]]",
                &conn
            )
            .unwrap()
        );
        {
            let guard = conn.lock().unwrap();
            let db = guard.as_ref().unwrap();
            fs::apply_workspace_metadata(&snapshot, db).unwrap();
            let links = db::get_links(db, path.to_str().unwrap(), false).unwrap();
            assert_eq!(links.len(), 1);
            assert!(links[0].0.ends_with("/new.md"));
        }
        assert_eq!(category(&conn, &path), "new");
        assert!(
            !write_file_blocking(
                path.to_str().unwrap(),
                "---\ntype: new\n---\nbody only",
                &conn
            )
            .unwrap()
        );
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changed_scopes_merge_subtrees_and_reject_outside_paths() {
        let root = PathBuf::from("workspace");
        let scopes = index_scopes(
            &root,
            Some(vec![
                "workspace/a/note.md".into(),
                "workspace/a".into(),
                "workspace/a-other/note.md".into(),
                "workspace2/out.md".into(),
                "workspace/../out.md".into(),
            ]),
        );
        assert_eq!(scopes, vec![root.join("a"), root.join("a-other/note.md")]);
    }
}
