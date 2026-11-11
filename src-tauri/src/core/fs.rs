use crate::core::db;
use gray_matter::Matter;
use gray_matter::engine::YAML;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileNode {
    pub id: String,
    pub name: String,
    pub children: Option<Vec<FileNode>>,
    #[serde(rename = "isLeaf")]
    pub is_leaf: bool,
    #[serde(default)]
    pub missing: bool,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferOptions {
    #[serde(default)]
    pub merge_folders: bool,
    #[serde(default)]
    pub overwrite_all: bool,
    #[serde(default)]
    pub skip_all: bool,
    #[serde(default)]
    pub overwrite_paths: Vec<String>,
    #[serde(default)]
    pub skip_paths: Vec<String>,
}

pub fn read_dir_shallow<P: AsRef<Path>>(path: P) -> Result<Vec<FileNode>, String> {
    let mut nodes = Vec::new();
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let id = path.to_string_lossy().to_string();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            // Do not follow links (including Windows directory junctions).
            if file_type.is_symlink() {
                continue;
            }
            let is_dir = file_type.is_dir();

            if name == ".git" {
                continue;
            }

            let mut node = FileNode {
                id,
                name,
                children: None,
                is_leaf: !is_dir,
                missing: false,
            };

            if is_dir {
                node.children = Some(Vec::new());
            }

            nodes.push(node);
        }
    }

    nodes.sort_by(|a, b| {
        if a.is_leaf == b.is_leaf {
            a.name.cmp(&b.name)
        } else if a.is_leaf {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        }
    });

    Ok(nodes)
}

pub fn read_markdown_file<P: AsRef<Path>>(path: P) -> Result<String, String> {
    let path = path.as_ref();
    const MAX_TEXT_FILE_SIZE: u64 = 100 * 1024 * 1024;
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_TEXT_FILE_SIZE {
        return Err("超过 100 MB 的文件不支持文本编辑".into());
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut header = [0u8; 8192];
    let count = std::io::Read::read(&mut file, &mut header).map_err(|e| e.to_string())?;
    let invalid_utf8 = match std::str::from_utf8(&header[..count]) {
        Ok(_) => false,
        // 读取边界可能截断合法的多字节字符，完整读取时再做最终校验。
        Err(error) => error.error_len().is_some(),
    };
    if header[..count].contains(&0) || invalid_utf8 {
        return Err("二进制文件不支持文本编辑".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn write_markdown_file<P: AsRef<Path>>(path: P, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

pub fn index_links<P: AsRef<Path>>(
    path: P,
    content: &str,
    conn: &Connection,
) -> Result<(), String> {
    let links = collect_links(path.as_ref(), content)?;
    db::replace_links(conn, &path.as_ref().to_string_lossy(), &links)
        .map_err(|e| e.to_string())
        .or_else(|e| {
            if e.contains("no such table") {
                Ok(())
            } else {
                Err(e)
            }
        })
}

fn collect_links(path: &Path, content: &str) -> Result<Vec<(String, String)>, String> {
    let re = regex::Regex::new(r"\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]")
        .map_err(|e| e.to_string())?;
    let mut links = Vec::new();
    for cap in re.captures_iter(content) {
        let decode = |value: &str| {
            value
                .replace("&#91;", "[")
                .replace("&#93;", "]")
                .replace("&#124;", "|")
        };
        let raw = decode(cap[1].trim());
        let anchor = decode(cap.get(2).map(|m| m.as_str()).unwrap_or(""));
        if raw.is_empty() && anchor.is_empty() {
            continue;
        }
        let mut target = if raw.is_empty() {
            path.to_path_buf()
        } else {
            path.parent().unwrap_or(Path::new(".")).join(raw)
        };
        if target.extension().is_none() {
            target.set_extension("md");
        }
        // Resolve parent segments without requiring the destination to exist.
        let mut normalized = std::path::PathBuf::new();
        for component in target.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    if normalized.file_name().is_some_and(|name| name != "..") {
                        normalized.pop();
                    } else if !normalized.has_root() {
                        normalized.push("..");
                    }
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        target = normalized;
        links.push((target.to_string_lossy().to_string(), anchor));
    }
    Ok(links)
}

pub fn copy_file<P: AsRef<Path>, Q: AsRef<Path>>(from: P, to: Q) -> Result<(), String> {
    fs::copy(from, to).map(|_| ()).map_err(|e| e.to_string())
}

pub fn create_empty_file<P: AsRef<Path>>(path: P) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn create_directory<P: AsRef<Path>>(path: P) -> Result<(), String> {
    fs::create_dir(path).map_err(|e| e.to_string())
}

#[derive(Default)]
pub struct WatcherState(
    pub std::sync::Mutex<std::collections::HashMap<String, notify::RecommendedWatcher>>,
);

pub fn start_file_watcher(
    path: &str,
    app: tauri::AppHandle,
    state: &WatcherState,
) -> Result<(), String> {
    use notify::Watcher;
    use tauri::Emitter;
    let root = std::path::PathBuf::from(path);
    let watched_root = root.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(path.to_string(), watcher);
    std::thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut events = vec![first];
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(150);
            while let Ok(event) =
                receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            {
                events.push(event);
                if std::time::Instant::now() >= deadline {
                    break;
                }
            }
            let paths: std::collections::HashSet<_> = events
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| !matches!(e.kind, notify::EventKind::Access(_)))
                .flat_map(|e| e.paths)
                .filter(|p| {
                    p.strip_prefix(&watched_root)
                        .map(|relative| {
                            !relative.components().any(|part| part.as_os_str() == ".git")
                        })
                        .unwrap_or(false)
                })
                .collect();
            if !paths.is_empty() {
                let _ = app.emit(
                    "workspace-changed",
                    serde_json::json!({"root": watched_root, "paths": paths}),
                );
            }
        }
    });
    Ok(())
}

pub struct IndexedFile {
    path: String,
    logical_type: Option<String>,
    modified: i64,
    links: Vec<(String, String)>,
}

// Filesystem reads and parsing must finish before acquiring the database mutex.
pub fn collect_workspace_metadata(path: &Path) -> Result<Vec<IndexedFile>, String> {
    let mut files = Vec::new();
    collect_directory_metadata(path, &mut files)?;
    Ok(files)
}

fn collect_directory_metadata(path: &Path, files: &mut Vec<IndexedFile>) -> Result<(), String> {
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    let matter = Matter::<YAML>::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name() == ".git" {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            // Preserve best-effort indexing of inaccessible subdirectories.
            let _ = collect_directory_metadata(&path, files);
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            if let Ok(content) = fs::read_to_string(&path) {
                let logical_type = matter.parse(&content).data.and_then(|parsed| {
                    parsed.as_hashmap().ok().and_then(|fields| {
                        fields.get("type").and_then(|value| value.as_string().ok())
                    })
                });
                let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
                let modified = metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                    .duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                let links = collect_links(&path, &content)?;
                files.push(IndexedFile {
                    path: path.to_string_lossy().into_owned(),
                    logical_type,
                    modified,
                    links,
                });
            }
        }
    }
    Ok(())
}

// Database-only phase: callers can apply the snapshot in one short transaction.
pub fn apply_workspace_metadata(files: &[IndexedFile], conn: &Connection) -> Result<(), String> {
    for file in files {
        db::replace_links(conn, &file.path, &file.links)
            .map_err(|e| e.to_string())
            .or_else(|e| {
                if e.contains("no such table") {
                    Ok(())
                } else {
                    Err(e)
                }
            })?;
        db::upsert_file_meta(
            conn,
            &file.path,
            file.logical_type.as_deref(),
            None,
            file.modified,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
pub fn sync_workspace_to_db<P: AsRef<Path>>(path: P, conn: &Connection) -> Result<(), String> {
    apply_workspace_metadata(&collect_workspace_metadata(path.as_ref())?, conn)
}

// Return a fresh destination; never overwrite an existing project entry.
pub fn transfer_entry(
    source: &Path,
    target_dir: &Path,
    copy: bool,
    opts: &TransferOptions,
) -> Result<String, String> {
    transfer_entry_named(source, target_dir, copy, None, opts)
}

pub fn transfer_entry_named(
    source: &Path,
    target_dir: &Path,
    copy: bool,
    new_name: Option<&str>,
    opts: &TransferOptions,
) -> Result<String, String> {
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    let target_dir = target_dir.canonicalize().map_err(|e| e.to_string())?;
    if !target_dir.is_dir() {
        return Err("Invalid directory or source path".into());
    }
    if source.is_dir() && target_dir.starts_with(&source) {
        return Err("Cannot transfer a directory into itself".into());
    }
    if !copy && new_name.is_none() && source.parent() == Some(target_dir.as_path()) {
        return Ok(source
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string());
    }
    if let Some(name) = new_name {
        if name.is_empty()
            || name.trim() != name
            || name.ends_with('.')
            || name.contains(['/', '\\', '<', '>', ':', '"', '|', '?', '*'])
            || name.chars().any(|c| c.is_control())
        {
            return Err("Invalid entry name".into());
        }
    }
    let name = new_name
        .map(std::ffi::OsStr::new)
        .or_else(|| source.file_name())
        .ok_or("Invalid directory or source path")?;
    let mut target = target_dir.join(name);
    if target == source && !copy {
        return Ok(source
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string());
    }

    if target.exists()
        && copy
        && new_name.is_none()
        && !opts.merge_folders
        && !opts.overwrite_all
        && opts.overwrite_paths.is_empty()
    {
        let mut index = 1;
        while target.exists() {
            let stem = if source.is_dir() {
                name.to_string_lossy()
            } else {
                source.file_stem().unwrap_or(name).to_string_lossy()
            };
            let extension = if source.is_file() {
                source
                    .extension()
                    .map(|ext| format!(".{}", ext.to_string_lossy()))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            target = target_dir.join(format!("{} (copy {}){}", stem, index, extension));
            index += 1;
        }
    }

    transfer_recursive(&source, &target, copy, opts)?;

    // Match the paths returned by read_dir_shallow on Windows (without verbatim prefixes).
    Ok(target
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string())
}

#[cfg(test)]
mod read_file_tests {
    use super::read_markdown_file;

    #[test]
    fn accepts_utf8_character_split_at_header_boundary() {
        let path = std::env::temp_dir().join(format!(
            "nexusdesk-read-boundary-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut bytes = vec![b'a'; 8191];
        bytes.extend_from_slice("中".as_bytes());
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            read_markdown_file(&path).unwrap(),
            String::from_utf8(bytes).unwrap()
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_invalid_utf8_in_header() {
        let path = std::env::temp_dir().join(format!(
            "nexusdesk-read-invalid-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, [b'a', 0xff]).unwrap();
        assert!(read_markdown_file(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_text_file_over_size_limit() {
        let path = std::env::temp_dir().join(format!(
            "nexusdesk-read-large-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(100 * 1024 * 1024 + 1).unwrap();
        assert!(read_markdown_file(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}

fn transfer_recursive(
    source: &Path,
    target: &Path,
    copy: bool,
    opts: &TransferOptions,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Symbolic links cannot be transferred".into());
    }

    if metadata.is_dir() {
        if target.exists() {
            if target.is_file() {
                return Err(format!("CONFLICT:FILE:{}", target.to_string_lossy()));
            }
            if !opts.merge_folders {
                return Err(format!("CONFLICT:DIR:{}", target.to_string_lossy()));
            }
        } else {
            fs::create_dir_all(target).map_err(|e| e.to_string())?;
        }

        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            transfer_recursive(&entry.path(), &target.join(entry.file_name()), copy, opts)?;
        }
        if !copy {
            let _ = fs::remove_dir(source); // Ignore error if not empty (due to skipped files)
        }
    } else {
        if target.exists() {
            let target_str = target.to_string_lossy().to_string();
            if opts.skip_all || opts.skip_paths.contains(&target_str) {
                return Ok(());
            }
            if !opts.overwrite_all && !opts.overwrite_paths.contains(&target_str) {
                return Err(format!("CONFLICT:FILE:{}", target_str));
            }
            if !copy {
                fs::remove_file(target).map_err(|e| e.to_string())?;
            }
        }
        if copy {
            fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(target)
                .and_then(|mut output| {
                    let mut input = fs::File::open(source)?;
                    std::io::copy(&mut input, &mut output)
                })
                .map_err(|e| e.to_string())?;
        } else {
            if let Err(_) = fs::rename(source, target) {
                // Fallback for cross-device moves
                fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(target)
                    .and_then(|mut output| {
                        let mut input = fs::File::open(source)?;
                        std::io::copy(&mut input, &mut output)
                    })
                    .map_err(|e| e.to_string())?;
                fs::remove_file(source).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod transfer_tests {
    use super::{TransferOptions, transfer_entry_named};
    #[test]
    fn rename_preserves_contents_and_rejects_overwrite_and_invalid_names() {
        let root = std::env::temp_dir().join(format!("nexusdesk-rename-{}", std::process::id()));
        std::fs::create_dir_all(root.join("folder")).unwrap();
        std::fs::write(root.join("folder/note.md"), "content").unwrap();
        transfer_entry_named(
            &root.join("folder"),
            &root,
            false,
            Some("renamed"),
            &TransferOptions::default(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("renamed/note.md")).unwrap(),
            "content"
        );
        std::fs::write(root.join("occupied.md"), "keep").unwrap();
        assert!(
            transfer_entry_named(
                &root.join("renamed/note.md"),
                &root,
                false,
                Some("occupied.md"),
                &TransferOptions::default()
            )
            .is_err()
        );
        assert!(
            transfer_entry_named(
                &root.join("renamed"),
                &root,
                false,
                Some("../escape"),
                &TransferOptions::default()
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(root.join("occupied.md")).unwrap(),
            "keep"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creating_existing_entries_preserves_contents() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-create-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("note.txt");
        super::create_empty_file(&path).unwrap();
        std::fs::write(&path, "keep me").unwrap();
        assert!(super::create_empty_file(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep me");
        assert!(super::create_directory(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn listing_shows_root_and_nested_gitignore_but_hides_git_metadata() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-dotfiles-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        for path in [".gitignore", "docs/.gitignore", ".env"] {
            std::fs::write(root.join(path), "").unwrap();
        }
        let shallow = super::read_dir_shallow(&root).unwrap();
        assert!(shallow.iter().any(|n| n.name == ".gitignore" && n.is_leaf));
        assert!(shallow.iter().any(|n| n.name == ".env" && n.is_leaf));
        assert!(!shallow.iter().any(|n| n.name == ".git"));
        let docs = super::read_dir_shallow(root.join("docs")).unwrap();
        assert_eq!(docs[0].name, ".gitignore");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn shallow_listing_defers_nested_directories() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-shallow-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("folder/nested")).unwrap();
        std::fs::write(root.join("folder/nested/note.md"), "content").unwrap();
        std::fs::write(root.join("root.md"), "root").unwrap();
        let entries = super::read_dir_shallow(&root).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(!entries[0].is_leaf);
        assert!(entries[0].children.as_ref().unwrap().is_empty());
        assert!(entries[1].is_leaf);
        let children = super::read_dir_shallow(root.join("folder")).unwrap();
        assert_eq!(children[0].name, "nested");
        assert!(children[0].children.as_ref().unwrap().is_empty());
        assert_eq!(
            super::read_dir_shallow(root.join("folder/nested")).unwrap()[0].name,
            "note.md"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_and_copy_preserve_data_and_reject_cycles() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-transfer-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("source/nested")).unwrap();
        std::fs::create_dir(root.join("destination")).unwrap();
        std::fs::write(root.join("source/nested/note.txt"), "original").unwrap();
        assert!(
            super::transfer_entry(
                &root.join("source"),
                &root.join("source/nested"),
                false,
                &TransferOptions::default()
            )
            .is_err()
        );
        let copied = super::transfer_entry(
            &root.join("source"),
            &root.join("destination"),
            true,
            &TransferOptions::default(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&copied).join("nested/note.txt")).unwrap(),
            "original"
        );
        let second = super::transfer_entry(
            &root.join("source"),
            &root.join("destination"),
            true,
            &TransferOptions::default(),
        )
        .unwrap();
        assert_ne!(copied, second);
        assert!(
            super::transfer_entry(
                &root.join("source"),
                &root.join("destination"),
                false,
                &TransferOptions::default()
            )
            .is_err()
        );
        let moved = super::transfer_entry(
            &root.join("source/nested/note.txt"),
            &root,
            false,
            &TransferOptions::default(),
        )
        .unwrap();
        assert!(!root.join("source/nested/note.txt").exists());
        assert_eq!(std::fs::read_to_string(moved).unwrap(), "original");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copying_binary_file_in_same_directory_creates_unique_intact_copies() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-binary-copy-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let bytes = [0, 255, 128, 10, 13, 0];
        let source = root.join("资源.bin");
        std::fs::write(&source, bytes).unwrap();
        let first =
            super::transfer_entry(&source, &root, true, &TransferOptions::default()).unwrap();
        let second =
            super::transfer_entry(&source, &root, true, &TransferOptions::default()).unwrap();
        assert_ne!(first, second);
        assert_ne!(std::path::Path::new(&first), source);
        for path in [
            &source,
            std::path::Path::new(&first),
            std::path::Path::new(&second),
        ] {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
