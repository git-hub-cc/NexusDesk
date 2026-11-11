//! A linked workspace view, not a security boundary. Never recursively delete links.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

fn hash(value: &str) -> String {
    // Stable FNV-1a, independent of Rust's randomized/default hash implementation.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn component(value: &str) -> String {
    let safe: String = value
        .chars()
        .take(60)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    format!("{}-{}", safe.trim_matches(['.', ' ']), hash(value))
}

pub fn prepare(
    base: &Path,
    project: &Path,
    category: &str,
    sources: &[String],
) -> Result<PathBuf, String> {
    let project = project.canonicalize().map_err(|e| e.to_string())?;
    let directory = base
        .join(hash(&project.to_string_lossy()))
        .join(component(category));
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let manifest = directory.join(".nexusdesk-links.json");
    let previous: Vec<String> = match std::fs::read(&manifest) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid sandbox manifest: {e}"))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.to_string()),
    };
    let mut desired = HashSet::new();
    for source in sources {
        let source = Path::new(source);
        if !source.exists() {
            continue;
        }
        let source = source.canonicalize().map_err(|e| e.to_string())?;
        if directory.starts_with(&source) {
            return Err("沙箱不能链接其自身的上级目录".into());
        }
        let label = source.file_name().unwrap_or_default().to_string_lossy();
        let identity = hash(&source.to_string_lossy());
        let link_name = if source.is_file() {
            let stem = source.file_stem().unwrap_or_default().to_string_lossy();
            let extension = source
                .extension()
                .map(|ext| format!(".{}", ext.to_string_lossy()))
                .unwrap_or_default();
            format!("{}-{identity}{extension}", component(&stem))
        } else {
            format!("{}-{identity}", component(&label))
        };
        let link = directory.join(&link_name);
        if let Ok(metadata) = std::fs::symlink_metadata(&link) {
            if !metadata.file_type().is_symlink() {
                return Err(format!("沙箱入口已被普通文件占用：{}", link.display()));
            }
            if link.canonicalize().ok().as_ref() != Some(&source) {
                unlink(&link)?;
            }
        }
        if std::fs::symlink_metadata(&link).is_err() {
            create_link(&source, &link)?;
        }
        desired.insert(link_name);
        // Record each successful link so a subsequent retry can clean partial work.
        let all: HashSet<_> = previous
            .iter()
            .cloned()
            .chain(desired.iter().cloned())
            .collect();
        std::fs::write(
            &manifest,
            serde_json::to_vec(&all).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    for name in previous {
        if Path::new(&name).components().count() != 1 || name == "." || name == ".." {
            return Err("Invalid sandbox link name".into());
        }
        if !desired.contains(&name) {
            unlink(&directory.join(name))?;
        }
    }
    std::fs::write(
        manifest,
        serde_json::to_vec(&desired).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(directory)
}

fn unlink(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            #[cfg(windows)]
            if std::os::windows::fs::FileTypeExt::is_symlink_dir(&meta.file_type()) {
                return std::fs::remove_dir(path).map_err(|e| e.to_string());
            }
            std::fs::remove_file(path).map_err(|e| e.to_string())
        }
        Ok(_) => Err(format!("保留沙箱中的普通文件：{}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(unix)]
fn create_link(source: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(source, link).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn create_link(source: &Path, link: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return std::os::windows::fs::symlink_file(source, link)
            .map_err(|e| format!("无法创建文件符号链接，请启用 Windows 开发者模式：{e}"));
    }
    use std::os::windows::process::CommandExt;
    // Windows PowerShell's Junction provider expects ordinary Win32 paths.
    let target = source.to_string_lossy();
    let target = if let Some(unc) = target.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        target.strip_prefix("\\\\?\\").unwrap_or(&target).to_owned()
    };
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:NEXUSDESK_LINK -Target $env:NEXUSDESK_SOURCE | Out-Null"])
        .env("NEXUSDESK_LINK", link).env("NEXUSDESK_SOURCE", target)
        .creation_flags(0x08000000).output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_write_through_and_refresh_without_deleting_sources() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-sandbox-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let a = root.join("a/same");
        let b = root.join("b/same");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("note.md"), "original").unwrap();
        let sources = vec![
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        ];
        let sandbox = prepare(&root.join("mirrors"), &root, "../分类", &sources).unwrap();
        let links: Vec<_> = std::fs::read_dir(&sandbox)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap() != ".nexusdesk-links.json")
            .collect();
        assert_eq!(links.len(), 2);
        let link = links.iter().find(|p| p.join("note.md").exists()).unwrap();
        std::fs::write(link.join("note.md"), "changed").unwrap();
        assert_eq!(
            std::fs::read_to_string(a.join("note.md")).unwrap(),
            "changed"
        );
        std::fs::write(sandbox.join("user-file"), "keep").unwrap();
        prepare(&root.join("mirrors"), &root, "../分类", &[]).unwrap();
        assert!(links.iter().all(|p| std::fs::symlink_metadata(p).is_err()));
        assert!(a.join("note.md").exists());
        assert_eq!(
            std::fs::read_to_string(sandbox.join("user-file")).unwrap(),
            "keep"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
