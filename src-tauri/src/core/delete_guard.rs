use std::path::Path;

/// Check the entire tree before either stashing or removing any entry.
/// Do not follow links into directories outside the deletion target.
pub fn check_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| check_error(path, e))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(());
    }
    check_tree(path)
}

fn check_error(path: &Path, error: std::io::Error) -> String {
    format!("无法删除目录：{} 可能被占用或无法访问，请关闭相关文件、终端或程序并解除占用后重试。未执行删除操作。\n{}", path.display(), error)
}

fn check_tree(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| check_error(path, e))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Request DELETE access to detect handles that deny deletion, including
        // directory handles. OPEN_REPARSE_POINT checks links themselves.
        let _handle = std::fs::OpenOptions::new()
            .access_mode(0x0001_0000)
            .share_mode(0x0000_0007)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(path)
            .map_err(|e| check_error(path, e))?;
    }
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        for entry in std::fs::read_dir(path).map_err(|e| check_error(path, e))? {
            let entry = entry.map_err(|e| check_error(path, e))?;
            check_tree(&entry.path())?;
        }
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    #[test]
    fn detects_occupied_root_nested_directory_and_file_without_changing_tree() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("noteide-delete-guard-{}-{stamp}", std::process::id()));
        let nested = root.join("child").join("grandchild");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("note.txt");
        std::fs::write(&file, "keep").unwrap();
        std::fs::write(root.join("sibling.txt"), "keep sibling").unwrap();
        assert!(check_directory(&root).is_ok());
        for target in [&root, &nested, &file] {
            let handle = std::fs::OpenOptions::new().read(true).share_mode(3)
                .custom_flags(0x0200_0000).open(target).unwrap();
            let error = check_directory(&root).unwrap_err();
            assert!(error.contains(&target.display().to_string()));
            assert!(error.contains("解除占用"));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep");
            assert_eq!(std::fs::read_to_string(root.join("sibling.txt")).unwrap(), "keep sibling");
            drop(handle);
            assert!(check_directory(&root).is_ok());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
