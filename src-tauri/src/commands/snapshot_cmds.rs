use std::path::{Path, PathBuf};

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = std::process::Command::new("git");
    command.arg("-C").arg(root).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

// An allowlist also covers less visible write paths (images, Git and terminals).
pub fn allowed_command(command: &str) -> bool {
    matches!(
        command,
        "read_file"
            | "read_binary_file"
            | "read_directory"
            | "is_directory"
            | "read_global_settings"
            | "project_directory_exists"
            | "search_everywhere"
            | "cancel_search"
            | "get_git_status"
            | "get_git_tree_status"
            | "is_git_repository"
            | "is_git_installed"
            | "get_git_log"
            | "get_git_diff"
            | "get_git_image_diff"
            | "get_git_revision_files"
            | "get_git_revision_content"
            | "get_git_revision_changes"
            | "get_git_revision_diff"
            | "native_menu_open"
            | "native_menu_close"
            | "write_file_clipboard"
            | "write_text_clipboard"
            | "write_console_logs"
            | "start_html_preview"
            | "stop_html_preview"
    )
}

fn remove(root: &Path, path: &Path) {
    if let Err(error) = git(
        root,
        &["worktree", "remove", "--force", &path.to_string_lossy()],
    ) {
        log::error!("Snapshot cleanup {}: {error}", path.display());
    }
}

#[tauri::command]
pub async fn open_git_snapshot(
    app: tauri::AppHandle,
    repo_path: String,
    commit_id: String,
) -> Result<(), String> {
    let (root, path, oid, label) = tauri::async_runtime::spawn_blocking(move || {
        // Only accept full object IDs; never let a revision be interpreted as a Git option.
        if commit_id.len() != 40 || !commit_id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid commit ID".to_string());
        }
        let root = PathBuf::from(repo_path);
        let oid = git(
            &root,
            &["rev-parse", "--verify", &format!("{commit_id}^{{commit}}")],
        )?;
        let token = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let label = format!("window-snapshot-{}-{token}", std::process::id());
        // A separate directory per window handles repeated commits and different repositories.
        let base = dirs::home_dir()
            .ok_or("Missing home directory")?
            .join(".nexus/worktrees")
            .join(&oid);
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let path = base.join(&label);
        git(
            &root,
            &["worktree", "add", "--detach", &path.to_string_lossy(), &oid],
        )?;
        Ok::<_, String>((root, path, oid, label))
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut url = tauri::Url::parse("http://localhost/").map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("project", &path.to_string_lossy())
        .append_pair("snapshot", &oid);
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(format!("index.html?{}", url.query().unwrap_or_default()).into()),
    )
    .title(format!("NexusDesk @{} (read-only)", &oid[..8]))
    .data_directory(crate::profiles::data_directory(&app))
    .visible(false)
    .inner_size(1100.0, 760.0)
    .decorations(false)
    .disable_drag_drop_handler()
    .build();
    match window {
        Ok(window) => {
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    let root = root.clone();
                    let path = path.clone();
                    tauri::async_runtime::spawn_blocking(move || remove(&root, &path));
                }
            });
            Ok(())
        }
        Err(error) => {
            tauri::async_runtime::spawn_blocking(move || remove(&root, &path))
                .await
                .map_err(|e| e.to_string())?;
            Err(error.to_string())
        }
    }
}

#[cfg(test)]
mod permission_tests {
    #[test]
    fn snapshot_commands_exclude_all_mutation_channels() {
        for command in [
            "write_file",
            "write_binary_file",
            "stage_git_file",
            "undo_git_commit",
            "start_terminal",
            "write_terminal",
            "init_project_db",
            "sync_project_index",
            "import_asset",
            "open_git_snapshot",
        ] {
            assert!(!super::allowed_command(command), "{command}");
        }
        for command in [
            "read_file",
            "read_directory",
            "search_everywhere",
            "get_git_log",
            "write_file_clipboard",
            "write_text_clipboard",
        ] {
            assert!(super::allowed_command(command), "{command}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detached_snapshot_preserves_source_and_can_be_removed() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-snapshot-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();
        let repo = git2::Repository::init(&source).unwrap();
        std::fs::write(source.join("note.md"), "historical").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("note.md")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let author = git2::Signature::now("Test", "test@example.com").unwrap();
        let oid = repo
            .commit(Some("HEAD"), &author, &author, "initial", &tree, &[])
            .unwrap();
        std::fs::write(source.join("note.md"), "staged").unwrap();
        index.add_path(Path::new("note.md")).unwrap();
        index.write().unwrap();
        let index_before = std::fs::read(repo.path().join("index")).unwrap();
        std::fs::write(source.join("note.md"), "unsaved on disk").unwrap();
        let snapshot = root.join("snapshot");
        git(
            &source,
            &[
                "worktree",
                "add",
                "--detach",
                &snapshot.to_string_lossy(),
                &oid.to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(snapshot.join("note.md")).unwrap(),
            "historical"
        );
        assert!(
            git2::Repository::open(&snapshot)
                .unwrap()
                .head_detached()
                .unwrap()
        );
        remove(&source, &snapshot);
        assert!(!snapshot.exists());
        assert_eq!(
            std::fs::read_to_string(source.join("note.md")).unwrap(),
            "unsaved on disk"
        );
        assert_eq!(
            std::fs::read(repo.path().join("index")).unwrap(),
            index_before
        );
        drop(tree);
        drop(index);
        drop(repo);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn snapshot_blocks_mutations_and_shells() {
        for command in [
            "write_file",
            "write_binary_file",
            "move_entry",
            "delete_entry",
            "stage_git_file",
            "commit_git",
            "save_git_settings",
            "start_terminal",
            "write_terminal",
            "init_project_db",
            "sync_project_index",
        ] {
            assert!(!allowed_command(command), "{command}");
        }
        for command in [
            "read_file",
            "read_directory",
            "search_everywhere",
            "get_git_log",
        ] {
            assert!(allowed_command(command), "{command}");
        }
    }
}
