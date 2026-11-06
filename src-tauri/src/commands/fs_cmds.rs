use crate::core::fs::{self, FileNode};
use crate::core::db;
use crate::state::AppState;
use tauri::State;
use std::path::PathBuf;

fn project_db(state: &AppState) -> Result<std::sync::MutexGuard<'_, Option<rusqlite::Connection>>, String> {
    let mut guard = state.db_conn.lock().map_err(|error| error.to_string())?;
    if guard.is_none() {
        *guard = Some(db::init_db(None).map_err(|error| error.to_string())?);
    }
    Ok(guard)
}

#[tauri::command]
pub async fn prepare_logical_sandbox(project: String, category: String, state: State<'_, AppState>) -> Result<String, String> {
    if project.starts_with("sftp:") { return Err("镜像沙箱仅支持本地项目".into()); }
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize preparations with category mutations and other preparations.
        let guard = connection.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("数据库未初始化")?;
        let tree = db::get_logical_tree(conn).map_err(|e| e.to_string())?;
        let node = tree.iter().find(|node| node.name == category).ok_or("分类不存在")?;
        let mut statement = conn.prepare("SELECT path FROM logical_hidden WHERE category=?1").map_err(|e| e.to_string())?;
        let hidden = statement.query_map([&category], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?
            .collect::<Result<std::collections::HashSet<_>, _>>().map_err(|e| e.to_string())?;
        let sources = node.children.as_deref().unwrap_or_default().iter()
            .filter(|entry| !entry.missing && !hidden.contains(&entry.id)).map(|entry| entry.id.clone()).collect::<Vec<_>>();
        let base = dirs::home_dir().ok_or("无法获取用户目录")?.join(".nexus/sandboxes");
        crate::core::sandbox::prepare(&base, std::path::Path::new(&project), &category, &sources)
            .map(|path| path.to_string_lossy().into_owned())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || std::fs::read(path).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(path, bytes).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_asset(note_path: String, target_dir: Option<String>, source_path: Option<String>, name: Option<String>, bytes: Option<Vec<u8>>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let note = std::path::Path::new(&note_path);
        let directory = match target_dir { Some(path) => PathBuf::from(path), None => note.parent().ok_or("Invalid note path")?.join(".asset") };
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        if let Some(source) = source_path {
            if !std::path::Path::new(&source).is_file() { return Err("Only files can be inserted into Markdown".into()); }
            return fs::transfer_entry(std::path::Path::new(&source), &directory, true, &fs::TransferOptions::default());
        }
        let name = name.ok_or("Missing asset name")?;
        if name.is_empty() || name.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*']) || name == "." || name == ".." || name.ends_with(['.', ' ']) || name.chars().any(|c| c.is_control()) { return Err("Invalid asset name".into()); }
        let bytes = bytes.ok_or("Missing asset data")?;
        let path = std::path::Path::new(&name);
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        let extension = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        for index in 0..10000 {
            let target = directory.join(if index == 0 { name.clone() } else { format!("{stem} ({index}){extension}") });
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
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
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod asset_tests {
    #[tokio::test]
    async fn imports_binary_assets_beside_note_without_overwriting_or_moving_source() {
        let root = std::env::temp_dir().join(format!("nexusdesk-assets-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let note = root.join("notes/note.md").to_string_lossy().to_string();
        let bytes = vec![0, 255, 128, 0, 10];
        let source = root.join("图片.png");
        std::fs::write(&source, &bytes).unwrap();
        let first = super::import_asset(note.clone(), None, Some(source.to_string_lossy().to_string()), None, None).await.unwrap();
        let second = super::import_asset(note.clone(), None, None, Some("图片.png".into()), Some(bytes.clone())).await.unwrap();
        assert_ne!(first, second);
        assert_eq!(std::path::Path::new(&first).parent().unwrap(), root.join("notes/.asset"));
        assert_eq!(std::fs::read(&first).unwrap(), bytes);
        assert_eq!(std::fs::read(&second).unwrap(), bytes);
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        assert!(super::import_asset(note.clone(), None, None, Some("../escape.png".into()), Some(bytes.clone())).await.is_err());
        assert!(super::import_asset(note, None, Some(root.to_string_lossy().to_string()), None, None).await.is_err());
        let target = super::import_asset(String::new(), Some(root.to_string_lossy().to_string()), None, Some("附件.bin".into()), Some(bytes.clone())).await.unwrap();
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
    }).await.map_err(|error| error.to_string())?
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
pub async fn init_project_db(path: String, app: tauri::AppHandle, watcher: State<'_, fs::WatcherState>, state: State<'_, AppState>) -> Result<(), String> {
    fs::start_file_watcher(&path, app, &watcher)?;
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || init_project_db_blocking(&AppState { db_conn: connection }))
        .await.map_err(|e| e.to_string())?
}

fn init_project_db_blocking(state: &AppState) -> Result<(), String> {
    let _guard = project_db(state)?;
    Ok(())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_markdown_file(path)
}

#[tauri::command]
pub fn write_file(path: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    let old = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.to_string()),
    };
    let original_time = std::fs::metadata(&path).and_then(|m|m.modified()).ok()
        .and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t|t.as_millis() as i64)
        .unwrap_or_else(crate::core::local_history::now);
    if let Some(conn) = guard.as_ref() {
        let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
        crate::core::local_history::record(&tx,&path,&old,&content,original_time)?;
        tx.commit().map_err(|e|e.to_string())?;
    }
    fs::write_markdown_file(&path, &content)?;
    if let Some(conn) = guard.as_ref() {
        let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        fs::index_links(&path, &content, &transaction)?;
        if path.to_lowercase().ends_with(".md") {
            let matter = gray_matter::Matter::<gray_matter::engine::YAML>::new();
            let logical_type = matter.parse(&content).data.and_then(|data| data.as_hashmap().ok())
                .and_then(|fields| fields.get("type").and_then(|value| value.as_string().ok()));
            let modified = std::fs::metadata(&path).and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                .duration_since(std::time::SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
            db::upsert_file_meta(&transaction, &path, logical_type.as_deref(), None, modified).map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_file_links(path: String, reverse: bool, state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    guard.as_ref().map(|c| db::get_links(c, &path, reverse).map_err(|e| e.to_string())).unwrap_or(Ok(Vec::new()))
}

#[tauri::command]
pub async fn read_directory(path: String) -> Result<Vec<FileNode>, String> {
    tauri::async_runtime::spawn_blocking(move || fs::read_dir_shallow(path))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sync_project_index(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Snapshot existing paths briefly, then perform every filesystem operation unlocked.
        let indexed_paths = {
            let guard = connection.lock().map_err(|e| e.to_string())?;
            let Some(conn) = guard.as_ref() else { return Ok(()); };
            let mut statement = conn.prepare("SELECT path FROM file_meta").map_err(|e| e.to_string())?;
            statement.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let root = std::path::Path::new(&path);
        let files = fs::collect_workspace_metadata(root)?;
        let missing: Vec<_> = indexed_paths.into_iter().filter(|p| {
            let candidate = std::path::Path::new(p);
            candidate.starts_with(root) && !candidate.exists()
        }).collect();

        let guard = connection.lock().map_err(|e| e.to_string())?;
        if let Some(conn) = guard.as_ref() {
            let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            fs::apply_workspace_metadata(&files, &transaction)?;
            for p in missing {
                transaction.execute("INSERT OR IGNORE INTO logical_refs(path, category) SELECT path, logical_type FROM file_meta WHERE path=?1 AND logical_type IS NOT NULL AND logical_type != ''", [&p]).map_err(|e| e.to_string())?;
                transaction.execute("DELETE FROM file_meta WHERE path=?1", [&p]).map_err(|e| e.to_string())?;
                transaction.execute("DELETE FROM links WHERE source_path=?1", [&p]).map_err(|e| e.to_string())?;
            }
            transaction.commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_logical_tree(state: State<'_, AppState>) -> Result<Vec<FileNode>, String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || get_logical_tree_blocking(&AppState { db_conn: connection }))
        .await.map_err(|e| e.to_string())?
}

fn get_logical_tree_blocking(state: &AppState) -> Result<Vec<FileNode>, String> {
    let guard = state.db_conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        db::get_logical_tree(conn).map_err(|e| e.to_string())
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn create_logical_folder(name: String, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || create_logical_folder_blocking(name, &AppState { db_conn: connection }))
        .await.map_err(|e| e.to_string())??;
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
pub async fn update_file_frontmatter(path: String, new_type: String, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || update_file_frontmatter_blocking(path, new_type, &AppState { db_conn: connection }))
        .await.map_err(|e| e.to_string())??;
    use tauri::Emitter;
    let _ = app.emit("logical-tree-updated", ());
    Ok(())
}

#[tauri::command]
pub fn remove_logical_file(path: String, category: String, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let guard = project_db(&state)?;
    let conn = guard.as_ref().expect("project_db initializes the connection");
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::insert_logical_folder(&tx, &category).map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO logical_hidden(path, category) VALUES (?1, ?2)", rusqlite::params![path, category]).map_err(|e| e.to_string())?;
    // An empty override hides legacy frontmatter membership without editing the file.
    tx.execute("INSERT INTO logical_refs(path, category) SELECT path, '' FROM file_meta WHERE path=?1 AND logical_type=?2 AND path NOT IN (SELECT path FROM logical_refs)", rusqlite::params![path, category]).map_err(|e| e.to_string())?;
    tx.execute("UPDATE logical_refs SET category='' WHERE path=?1 AND category=?2", rusqlite::params![path, category]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM logical_copies WHERE path=?1 AND category=?2", rusqlite::params![path, category]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    use tauri::Emitter;
    let _ = app.emit("logical-tree-updated", ());
    Ok(())
}

#[tauri::command]
pub fn get_hidden_logical_files(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    let guard = project_db(&state)?;
    let conn = guard.as_ref().expect("project_db initializes the connection");
    let mut stmt = conn.prepare("SELECT path, category FROM logical_hidden").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn update_file_frontmatter_blocking(path: String, new_type: String, state: &AppState) -> Result<(), String> {
    let guard = project_db(state)?;
    let conn = guard.as_ref().expect("project_db initializes the connection");
    if !std::path::Path::new(&path).exists() { return Err("Source does not exist".into()); }
    // All entries, including Markdown, store membership in .nexus/index.db.
    // Explicit references override legacy frontmatter without changing user files.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM logical_hidden WHERE path=?1 AND category=?2", rusqlite::params![path, new_type]).map_err(|e| e.to_string())?;
    db::insert_logical_folder(&tx, &new_type).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO logical_refs(path, category) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET category=excluded.category", rusqlite::params![path, new_type]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn copy_file_to_dir(source_path: String, target_dir: String, opts: Option<fs::TransferOptions>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || fs::transfer_entry(std::path::Path::new(&source_path), std::path::Path::new(&target_dir), true, &opts.unwrap_or_default()).map(|_| ()))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn move_entry(source_path: String, target_dir: String, opts: Option<fs::TransferOptions>, state: State<'_, AppState>) -> Result<String, String> {
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || move_entry_blocking(source_path, target_dir, None, opts.unwrap_or_default(), &AppState { db_conn: connection }))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_entry(source_path: String, name: String, opts: Option<fs::TransferOptions>, state: State<'_, AppState>) -> Result<String, String> {
    let target_dir = std::path::Path::new(&source_path).parent().ok_or("Invalid source path")?.to_string_lossy().to_string();
    let connection = state.db_conn.clone();
    tauri::async_runtime::spawn_blocking(move || move_entry_blocking(source_path, target_dir, Some(name), opts.unwrap_or_default(), &AppState { db_conn: connection }))
        .await.map_err(|e| e.to_string())?
}

fn move_entry_blocking(source_path: String, target_dir: String, name: Option<String>, opts: fs::TransferOptions, state: &AppState) -> Result<String, String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    let target = fs::transfer_entry_named(std::path::Path::new(&source_path), std::path::Path::new(&target_dir), false, name.as_deref(), &opts)?;
    if let Some(conn) = guard.as_ref() {
        remap_entry_paths(conn, &source_path, &target)?;
    }
    Ok(target)
}

fn remap_entry_paths(conn: &rusqlite::Connection, source_path: &str, target: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for table in ["file_meta", "logical_refs", "logical_copies", "logical_hidden", "local_history", "local_history_heads", "graph_files"] {
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table], |row| row.get(0)).map_err(|e| e.to_string())?;
        if !exists { continue; }
        // Compare literal component prefixes, not LIKE patterns (% and _ are valid names).
        // Normalize separators on Windows, where stored paths may use either spelling.
        let normalize = |path: &str| {
            if cfg!(windows) { path.replace('\\', "/") } else { path.to_string() }
        };
        let source = normalize(source_path).trim_end_matches('/').to_string();
        let destination = target.trim_end_matches(['/', std::path::MAIN_SEPARATOR]).to_string();
        let path_expr = if cfg!(windows) { "replace(path, char(92), '/')" } else { "path" };
        let suffix = format!("substr({}, length(?1) + 1)", path_expr);
        let suffix = if cfg!(windows) { format!("replace({}, '/', char(92))", suffix) } else { suffix };
        let updated = format!("?2 || {}", suffix);
        tx.execute(&format!(
            "UPDATE OR REPLACE {table} SET path={updated} WHERE {path_expr}=?1 OR substr({path_expr}, 1, length(?1)+1)=?1 || '/'"
        ), rusqlite::params![source, destination]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
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
        let mut patch = git2::Patch::from_buffers(left.as_bytes(), None, right.as_bytes(), None, Some(&mut options))
            .map_err(|error| error.to_string())?;
        let buffer = patch.to_buf().map_err(|error| error.to_string())?;
        Ok(String::from_utf8_lossy(buffer.as_ref()).into_owned())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn touch_file(path: String, state: State<'_, AppState>) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() { return Ok(()); }
    if let Some(conn) = state.db_conn.lock().map_err(|e| e.to_string())?.as_ref() { db::touch_file(conn, &path).map_err(|e| e.to_string())?; }
    Ok(())
}
#[tauri::command]
pub fn recent_files(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else { return Ok(vec![]); };
    let mut stmt = conn.prepare("SELECT path FROM file_meta WHERE last_accessed IS NOT NULL ORDER BY last_accessed DESC, path").map_err(|e| e.to_string())?;
    let paths = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    paths.filter_map(|r| match r { Ok(p) if std::path::Path::new(&p).is_file() => Some(Ok(p)), Ok(_) => None, Err(e) => Some(Err(e.to_string())) }).take(100).collect()
}

// Deleted entries live outside the project until restored. Never overwrite a backup.
#[tauri::command]
pub async fn stash_entry(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::core::delete_guard::check_directory(std::path::Path::new(&path))?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let directory = std::env::temp_dir().join(format!("nexusdesk-trash-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let source = std::path::Path::new(&path);
        let target = directory.join(source.file_name().ok_or("Invalid entry path")?);
        // Same-volume deletion is an atomic rename, including directories and links.
        if std::fs::rename(source, &target).is_ok() {
            return Ok(target.to_string_lossy().to_string());
        }
        // Complete the backup before removing anything on another volume.
        let backup = fs::transfer_entry(source, &directory, true, &fs::TransferOptions::default())?;
        if source.is_dir() { std::fs::remove_dir_all(source) } else { std::fs::remove_file(source) }.map_err(|e| e.to_string())?;
        Ok(backup)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_entry(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&path);
        crate::core::delete_guard::check_directory(path)?;
        let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        }.map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_local_history(path: String, state: State<'_, AppState>) -> Result<Vec<crate::core::local_history::Entry>, String> {
    let guard=state.db_conn.lock().map_err(|e|e.to_string())?;
    crate::core::local_history::list(guard.as_ref().ok_or("Local History database unavailable")?, &path)
}
#[tauri::command]
pub fn local_history_content(path: String, id: i64, state: State<'_, AppState>) -> Result<String,String> {
    let guard=state.db_conn.lock().map_err(|e|e.to_string())?;
    let conn=guard.as_ref().ok_or("Local History database unavailable")?;
    crate::core::local_history::prune(conn).map_err(|e|e.to_string())?;
    crate::core::local_history::content(conn,&path,id)
}

#[tauri::command]
pub fn edit_logical_folder(name: String, new_name: Option<String>, copy: bool, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.db_conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("数据库未初始化")?;
    edit_logical_folder_in_db(conn, &name, new_name.as_deref(), copy)?;
    use tauri::Emitter;
    let _ = app.emit("logical-tree-updated", ());
    Ok(())
}

fn edit_logical_folder_in_db(conn: &rusqlite::Connection, name: &str, new_name: Option<&str>, copy: bool) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let tree = db::get_logical_tree(&tx).map_err(|e| e.to_string())?;
    let source = tree.iter().find(|node| node.name == name).ok_or("分类不存在")?;
    if let Some(target) = &new_name {
        if target.trim().is_empty() || tree.iter().any(|node| node.name.to_lowercase() == target.to_lowercase()) {
            return Err("分类名称为空或已存在".into());
        }
        db::insert_logical_folder(&tx, target).map_err(|e| e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO logical_hidden(path, category) SELECT path, ?1 FROM logical_hidden WHERE category=?2", rusqlite::params![target, name]).map_err(|e| e.to_string())?;
        for child in source.children.as_deref().unwrap_or_default() {
            tx.execute("INSERT OR IGNORE INTO logical_copies(path, category) VALUES (?1, ?2)", rusqlite::params![child.id, target]).map_err(|e| e.to_string())?;
        }
    }
    if !copy {
        // An explicit empty override prevents indexed frontmatter from restoring a removed category.
        tx.execute("INSERT INTO logical_refs(path, category) SELECT path, '' FROM file_meta WHERE logical_type=?1 AND path NOT IN (SELECT path FROM logical_refs)", [&name]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE logical_refs SET category='' WHERE category=?1", [&name]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM logical_copies WHERE category=?1", [&name]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM logical_hidden WHERE category=?1", [&name]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM logical_folders WHERE name=?1", [&name]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod logical_folder_tests {
    #[test]
    fn markdown_membership_is_persisted_without_modifying_source() {
        let root = std::env::temp_dir().join(format!("nexusdesk-membership-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("note.md");
        // Even malformed frontmatter must not prevent assigning a category.
        let content = "---\r\ntags: [broken\r\n---\r\nKeep this content\r\n";
        std::fs::write(&file, content).unwrap();
        let state = crate::state::AppState {
            db_conn: std::sync::Arc::new(std::sync::Mutex::new(Some(crate::core::db::init_db(Some(root.to_str().unwrap())).unwrap()))),
        };
        for category in ["first", "second"] {
            super::update_file_frontmatter_blocking(file.to_string_lossy().into_owned(), category.into(), &state).unwrap();
            assert_eq!(std::fs::read(&file).unwrap(), content.as_bytes());
        }
        drop(state);
        let conn = crate::core::db::init_db(Some(root.to_str().unwrap())).unwrap();
        crate::core::fs::sync_workspace_to_db(&root, &conn).unwrap();
        let tree = crate::core::db::get_logical_tree(&conn).unwrap();
        let category = tree.iter().find(|node| node.name == "second").unwrap();
        assert_eq!(category.children.as_ref().unwrap()[0].id, file.to_str().unwrap());
        assert!(tree.iter().find(|node| node.name == "first").unwrap().children.as_ref().unwrap().is_empty());
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn category_operations_preserve_files_and_survive_reindexing() {
        let root = std::env::temp_dir().join(format!("nexusdesk-categories-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("note.md");
        let content = "---\ntype: original\n---\nKeep this content";
        std::fs::write(&file, content).unwrap();
        let conn = crate::core::db::init_db(Some(root.to_str().unwrap())).unwrap();
        let index = || crate::core::db::upsert_file_meta(&conn, file.to_str().unwrap(), Some("original"), None, 0).unwrap();
        index();
        super::edit_logical_folder_in_db(&conn, "original", Some("copy"), true).unwrap();
        assert_eq!(crate::core::db::get_logical_tree(&conn).unwrap().len(), 2);
        assert!(super::edit_logical_folder_in_db(&conn, "original", Some("COPY"), true).is_err());
        super::edit_logical_folder_in_db(&conn, "original", Some("renamed"), false).unwrap();
        index();
        let tree = crate::core::db::get_logical_tree(&conn).unwrap();
        assert_eq!(tree.iter().map(|node| node.name.as_str()).collect::<Vec<_>>(), vec!["copy", "renamed"]);
        assert!(tree.iter().all(|node| node.children.as_ref().unwrap()[0].id == file.to_str().unwrap()));
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
        let tags: String = conn.query_row("SELECT tags FROM file_meta WHERE path='project/old.md'", [], |r| r.get(0)).unwrap();
        assert_eq!(tags, "current");
        let category: String = conn.query_row("SELECT category FROM logical_refs WHERE path='project/old.md'", [], |r| r.get(0)).unwrap();
        assert_eq!(category, "current");
        let memberships: i64 = conn.query_row("SELECT COUNT(*) FROM graph_files WHERE path='project/old.md'", [], |r| r.get(0)).unwrap();
        assert_eq!(memberships, 2);
        super::remap_entry_paths(&conn, "project/old.md", "project/new.md").unwrap();
        assert_eq!(conn.query_row("SELECT tags FROM file_meta", [], |r| r.get::<_, String>(0)).unwrap(), "current");
    }

    #[test]
    fn directory_move_replaces_stale_nested_index_entries() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE file_meta(path TEXT UNIQUE, tags TEXT);
            INSERT INTO file_meta VALUES ('project/folder/note.md','current');").unwrap();
        let target = std::path::Path::new("project/moved").join("note.md");
        conn.execute("INSERT INTO file_meta VALUES (?1,'stale')", [target.to_str().unwrap()]).unwrap();
        super::remap_entry_paths(&conn, "project/folder", "project/moved").unwrap();
        let rows: (i64, String) = conn.query_row("SELECT COUNT(*), tags FROM file_meta", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(rows, (1, "current".into()));
    }

    #[test]
    fn rename_and_directory_move_preserve_graph_memberships() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE graph_files(category TEXT, path TEXT, PRIMARY KEY(category,path));
            INSERT INTO graph_files VALUES ('a','project/old.tree'), ('b','project/old.tree'), ('c','project/folder/nested.tree'), ('d','project/folder-other/keep.tree');").unwrap();
        super::remap_entry_paths(&conn, "project/old.tree", "project/new.tree").unwrap();
        super::remap_entry_paths(&conn, "project/folder", "project/moved").unwrap();
        let count = |path: &str| conn.query_row("SELECT COUNT(*) FROM graph_files WHERE replace(path, char(92), '/')=?1", [path], |row| row.get::<_, i64>(0)).unwrap();
        assert_eq!(count("project/new.tree"), 2);
        assert_eq!(count("project/moved/nested.tree"), 1);
        assert_eq!(count("project/folder-other/keep.tree"), 1);
        assert_eq!(count("project/old.tree"), 0);
    }
}
