use std::fs::{self, Metadata};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const CONFLICT: &str = "FILE_CONFLICT: 文件已被其他程序修改，自动保存已暂停";

pub fn version(content: &str) -> String {
    blake3::hash(content.as_bytes()).to_hex().to_string()
}

pub fn metadata(path: &Path) -> Result<Option<Metadata>, String> {
    match fs::metadata(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn unchanged(before: &Option<Metadata>, after: &Option<Metadata>) -> bool {
    match (before, after) {
        (None, None) => true,
        (Some(before), Some(after)) => {
            before.len() == after.len()
                && before.modified().ok() == after.modified().ok()
                && before.created().ok() == after.created().ok()
        }
        _ => false,
    }
}

#[cfg(unix)]
fn has_multiple_links(path: &Path) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(fs::metadata(path)
        .map_err(|error| error.to_string())?
        .nlink()
        > 1)
}

#[cfg(windows)]
fn has_multiple_links(path: &Path) -> Result<bool, String> {
    use std::os::windows::io::AsRawHandle;
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut info = std::mem::MaybeUninit::<
        windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION,
    >::uninit();
    let result = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle(
            file.as_raw_handle() as _,
            info.as_mut_ptr(),
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(unsafe { info.assume_init() }.nNumberOfLinks > 1)
}

pub struct PreparedWrite {
    original: PathBuf,
    target: PathBuf,
    temporary: tempfile::TempPath,
    before: Option<Metadata>,
}

pub fn prepare_write(
    path: &Path,
    content: &str,
    before: &Option<Metadata>,
) -> Result<PreparedWrite, String> {
    // 跟随文件链接写入目标，避免原子替换意外将链接本身变成普通文件。
    let target = if before.is_some() {
        path.canonicalize().map_err(|error| error.to_string())?
    } else {
        path.to_path_buf()
    };
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if before
        .as_ref()
        .is_some_and(|meta| meta.permissions().readonly())
    {
        return Err("文件为只读，无法保存".into());
    }
    #[cfg(unix)]
    if before.is_some() {
        // 原子替换只要求目录可写，仍需校验原文件的写权限（包括 ACL）。
        fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .map_err(|error| error.to_string())?;
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".nexusdesk-save-")
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;
    temporary.flush().map_err(|error| error.to_string())?;
    if let Some(before) = before {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let source = path.canonicalize().map_err(|error| error.to_string())?;
            let result = unsafe {
                libc::fchown(
                    std::os::fd::AsRawFd::as_raw_fd(temporary.as_file()),
                    before.uid(),
                    before.gid(),
                )
            };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EPERM) {
                    return Err(error.to_string());
                }
            }
            // 共享文件可能无法保留所有者；变更所有者后不能继承特权位。
            let permissions = if result == 0 {
                before.permissions()
            } else {
                fs::Permissions::from_mode(before.mode() & !0o6000)
            };
            temporary
                .as_file()
                .set_permissions(permissions)
                .map_err(|error| error.to_string())?;
            for attribute in xattr::list(&source).map_err(|error| error.to_string())? {
                if let Some(value) =
                    xattr::get(&source, &attribute).map_err(|error| error.to_string())?
                {
                    xattr::set(temporary.path(), &attribute, &value)
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        #[cfg(not(unix))]
        temporary
            .as_file()
            .set_permissions(before.permissions())
            .map_err(|error| error.to_string())?;
    }
    Ok(PreparedWrite {
        original: path.to_path_buf(),
        target,
        temporary: temporary.into_temp_path(),
        before: before.clone(),
    })
}

impl PreparedWrite {
    pub fn commit(self) -> Result<(), String> {
        let Self {
            original,
            target,
            temporary,
            before,
        } = self;
        // 不强制每次刷盘；替换前再次检查，缩小外部写入的竞争窗口。
        if !unchanged(&before, &metadata(&original)?) {
            return Err(CONFLICT.into());
        }
        if before.is_some() && has_multiple_links(&target)? {
            // 硬链接共享 inode，必须原位更新，原子替换会让其他链接留在旧内容。
            let content = fs::read(&temporary).map_err(|error| error.to_string())?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .open(&target)
                .map_err(|error| error.to_string())?;
            file.set_len(0).map_err(|error| error.to_string())?;
            file.write_all(&content)
                .map_err(|error| error.to_string())?;
            file.flush().map_err(|error| error.to_string())?;
            return Ok(());
        }
        #[cfg(windows)]
        if before.is_some() {
            use std::os::windows::ffi::OsStrExt;
            let destination: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
            let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            // ReplaceFileW 保留目标文件的 ACL 等元数据；失败时保留原文件。
            let result = unsafe {
                windows_sys::Win32::Storage::FileSystem::ReplaceFileW(
                    destination.as_ptr(),
                    source.as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            return if result == 0 {
                Err(std::io::Error::last_os_error().to_string())
            } else {
                Ok(())
            };
        }
        if before.is_none() {
            temporary
                .persist_noclobber(&target)
                .map_err(|error| error.to_string())?;
        } else {
            temporary
                .persist(&target)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_writes_preserve_original_until_commit_and_clean_up_on_abort() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("中文.txt");
        fs::write(&path, "original").unwrap();
        let prepared = prepare_write(&path, "replacement", &metadata(&path).unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        drop(prepared);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        prepare_write(&path, "完整的新内容", &metadata(&path).unwrap())
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "完整的新内容");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn changes_during_staging_reject_replacement_and_keep_external_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.txt");
        fs::write(&path, "original").unwrap();
        let prepared = prepare_write(&path, "replacement", &metadata(&path).unwrap()).unwrap();
        fs::write(&path, "external change").unwrap();
        assert!(prepared.commit().unwrap_err().contains("FILE_CONFLICT:"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "external change");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn creation_never_clobbers_a_file_created_during_staging() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("new.txt");
        let prepared = prepare_write(&path, "replacement", &None).unwrap();
        fs::write(&path, "external creation").unwrap();
        assert!(prepared.commit().is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external creation");
        fs::remove_file(&path).unwrap();
        prepare_write(&path, "new file", &None)
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new file");
    }

    #[cfg(unix)]
    #[test]
    fn shared_file_saves_without_permission_to_preserve_ownership() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        use std::os::unix::process::CommandExt;

        const CHILD_DIRECTORY: &str = "NEXUSDESK_SHARED_FILE_TEST_DIRECTORY";
        if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
            let path = Path::new(&directory).join("shared.txt");
            prepare_write(&path, "replacement", &metadata(&path).unwrap())
                .unwrap()
                .commit()
                .unwrap();
            let saved = fs::metadata(&path).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
            assert_eq!(saved.uid(), unsafe { libc::geteuid() });
            assert_eq!(saved.mode() & 0o6000, 0);

            let protected = Path::new(&directory).join("protected.txt");
            assert!(
                prepare_write(&protected, "replacement", &metadata(&protected).unwrap()).is_err()
            );
            assert_eq!(fs::read_to_string(&protected).unwrap(), "original");
            return;
        }
        // 需要 root 创建其他用户拥有的文件，再由无特权子进程验证保存。
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o777)).unwrap();
        let path = directory.path().join("shared.txt");
        fs::write(&path, "original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o6666)).unwrap();
        let protected = directory.path().join("protected.txt");
        fs::write(&protected, "original").unwrap();
        fs::set_permissions(&protected, fs::Permissions::from_mode(0o644)).unwrap();
        let executable = directory.path().join("text-save-test");
        let current_executable = std::env::current_exe().unwrap();
        if fs::hard_link(&current_executable, &executable).is_err() {
            fs::copy(&current_executable, &executable).unwrap();
        }
        let output = std::process::Command::new(executable)
            .args([
                "--exact",
                "core::text_file::tests::shared_file_saves_without_permission_to_preserve_ownership",
                "--nocapture",
            ])
            .env(CHILD_DIRECTORY, directory.path())
            .uid(65534)
            .gid(65534)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn hard_link_target_updates_all_aliases() {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.txt");
        let alias = directory.path().join("alias.txt");
        fs::write(&path, "original").unwrap();
        fs::hard_link(&path, &alias).unwrap();
        #[cfg(unix)]
        xattr::set(&path, "user.nexusdesk-test", b"kept").unwrap();
        let before = metadata(&path).unwrap();
        prepare_write(&path, "replacement", &before)
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read_to_string(&alias).unwrap(), "replacement");
        #[cfg(unix)]
        assert_eq!(
            metadata(&path).unwrap().unwrap().ino(),
            before.as_ref().unwrap().ino()
        );
        #[cfg(unix)]
        assert_eq!(
            xattr::get(&path, "user.nexusdesk-test").unwrap().as_deref(),
            Some(&b"kept"[..])
        );
    }

    #[cfg(windows)]
    #[test]
    fn sharing_violations_leave_original_intact_and_remove_temporary_files() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("locked.txt");
        fs::write(&path, "original").unwrap();
        let prepared = prepare_write(&path, "replacement", &metadata(&path).unwrap()).unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(prepared.commit().is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        drop(locked);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    #[ignore = "手动测量开发构建的摘要与原子替换开销"]
    fn save_cost_samples() {
        use std::time::Instant;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("benchmark.txt");
        for size in [1024 * 1024, 10 * 1024 * 1024] {
            let text = "x".repeat(size);
            fs::write(&path, &text).unwrap();
            let mut hashing = Vec::new();
            let mut writing = Vec::new();
            for _ in 0..20 {
                let start = Instant::now();
                std::hint::black_box(version(&text));
                hashing.push(start.elapsed().as_secs_f64() * 1000.0);
                let before = metadata(&path).unwrap();
                let start = Instant::now();
                prepare_write(&path, &text, &before)
                    .unwrap()
                    .commit()
                    .unwrap();
                writing.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            hashing.sort_by(f64::total_cmp);
            writing.sort_by(f64::total_cmp);
            println!(
                "{} MiB: hash P50={:.2}ms P95={:.2}ms; atomic write P50={:.2}ms P95={:.2}ms",
                size / 1024 / 1024,
                hashing[9],
                hashing[18],
                writing[9],
                writing[18]
            );
        }
    }
}
