use super::*;
use serde::{Deserialize, Serialize};
use std::fs;

// Disk records belong to the worktree's Git directory and survive application restarts.
// Serialize mutations so repeated shortcuts cannot consume the same record twice.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Serialize, Deserialize)]
struct Snapshot {
    path: String,
    content: Option<Vec<u8>>,
    mode: Option<u32>,
    staged: Option<(Vec<u8>, u32, u16, u16)>,
}

fn capture(repo: &Repository, path: &str) -> Result<Snapshot, String> {
    let target = safe_work_path(repo, path)?;
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => Some(metadata),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if metadata.as_ref().is_some_and(|m| !m.is_file()) {
        return Err(format!("无法备份非普通文件：{path}"));
    }
    #[cfg(unix)]
    let mode = { use std::os::unix::fs::PermissionsExt; metadata.as_ref().map(|m| m.permissions().mode()) };
    #[cfg(not(unix))]
    let mode = None;
    let index = repo.index().map_err(|e| e.to_string())?;
    if index.has_conflicts() { return Err("请先解决暂存区冲突".into()); }
    let staged = index.get_path(Path::new(path), 0).map(|entry| {
        let blob = repo.find_blob(entry.id).map_err(|e| e.to_string())?;
        Ok::<_, String>((blob.content().to_vec(), entry.mode, entry.flags, entry.flags_extended))
    }).transpose()?;
    Ok(Snapshot { path: path.into(), content: metadata.map(|_| fs::read(target)).transpose().map_err(|e| e.to_string())?, mode, staged })
}

fn restore(repo: &Repository, snapshots: &[Snapshot]) -> Result<(), String> {
    // Validate every destination before modifying any file.
    for snapshot in snapshots { capture(repo, &snapshot.path)?; }
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for snapshot in snapshots {
        let target = safe_work_path(repo, &snapshot.path)?;
        if let Some(content) = &snapshot.content {
            if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
            fs::write(&target, content).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            if let Some(mode) = snapshot.mode {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
            }
        } else if target.exists() { fs::remove_file(&target).map_err(|e| e.to_string())?; }
        if let Some((content, mode, flags, flags_extended)) = &snapshot.staged {
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0), mtime: git2::IndexTime::new(0, 0),
                dev: 0, ino: 0, mode: *mode, uid: 0, gid: 0, file_size: 0,
                id: repo.blob(content).map_err(|e| e.to_string())?,
                flags: *flags, flags_extended: *flags_extended, path: snapshot.path.as_bytes().to_vec(),
            };
            index.add(&entry).map_err(|e| e.to_string())?;
        } else {
            match index.remove_path(Path::new(&snapshot.path)) {
                Ok(()) => (),
                Err(e) if e.code() == ErrorCode::NotFound => (),
                Err(e) => return Err(e.to_string()),
            }
        }
    }
    index.write().map_err(|e| e.to_string())
}

pub fn revert_files(repo_path: &str, paths: &[String]) -> Result<(), String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    if paths.is_empty() { return Ok(()); }
    let repo = open(repo_path)?;
    if repo.state() != git2::RepositoryState::Clean { return Err("请先完成当前合并或变基操作".into()); }
    let snapshots = paths.iter().map(|path| capture(&repo, path)).collect::<Result<Vec<_>, _>>()?;
    let directory = repo.path().join("noteide-revert-history");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let record = directory.join(format!("{id:039}.json"));
    let temporary = directory.join(format!("{id:039}.tmp"));
    let bytes = serde_json::to_vec(&snapshots).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temporary, record).map_err(|e| e.to_string())?;
    // Keep the durable backup even if a later checkout fails or the process exits.
    for path in paths { revert_file(repo_path, path)?; }
    Ok(())
}

pub fn undo_revert(repo_path: &str) -> Result<Vec<String>, String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let repo = open(repo_path)?;
    if repo.state() != git2::RepositoryState::Clean { return Err("请先完成当前合并或变基操作".into()); }
    let directory = repo.path().join("noteide-revert-history");
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut records = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|ext| ext == "json") { records.push(path); }
    }
    records.sort();
    let Some(record) = records.last() else { return Ok(Vec::new()); };
    let snapshots: Vec<Snapshot> = serde_json::from_slice(&fs::read(record).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    restore(&repo, &snapshots)?;
    fs::remove_file(record).map_err(|e| e.to_string())?;
    Ok(snapshots.into_iter().map(|s| s.path).collect())
}
