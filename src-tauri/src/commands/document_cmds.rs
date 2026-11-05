use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;

fn target_format(extension: &str) -> Result<(&'static str, &'static str), String> {
    match extension {
        "doc" => Ok(("docx", "docx:Office Open XML Text")),
        "ppt" => Ok(("pptx", "pptx:Impress MS PowerPoint 2007 XML")),
        _ => Err("LibreOffice 转换仅支持旧版 DOC/PPT。".into()),
    }
}

fn find_libreoffice() -> Result<PathBuf, String> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in if cfg!(windows) { &["soffice.com", "soffice.exe"][..] } else { &["libreoffice", "soffice"][..] } {
                paths.push(directory.join(name));
            }
            // Scoop exposes shims on PATH, not the actual program directory.
            #[cfg(windows)]
            if directory.file_name().is_some_and(|name| name.eq_ignore_ascii_case("shims")) {
                if let Some(root) = directory.parent() {
                    paths.extend(scoop_libreoffice_paths(root));
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let mut roots: Vec<PathBuf> = ["SCOOP", "SCOOP_GLOBAL"].into_iter()
            .filter_map(std::env::var_os).filter(|value| !value.is_empty())
            .map(PathBuf::from).collect();
        if let Some(home) = std::env::var_os("USERPROFILE") {
            roots.push(PathBuf::from(home).join("scoop"));
        }
        if let Some(data) = std::env::var_os("ProgramData") {
            roots.push(PathBuf::from(data).join("scoop"));
        }
        for root in roots {
            paths.extend(scoop_libreoffice_paths(&root));
        }
    }
    #[cfg(windows)]
    for root in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(directory) = std::env::var_os(root) {
            paths.push(PathBuf::from(&directory).join("LibreOffice/program/soffice.com"));
            paths.push(PathBuf::from(directory).join("LibreOffice/program/soffice.exe"));
        }
    }
    #[cfg(target_os = "macos")]
    paths.push(PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"));
    paths.into_iter().find(|path| path.is_file())
        .ok_or_else(|| "未找到 LibreOffice。支持普通安装和 Scoop 安装；如使用自定义 Scoop 目录，请设置 SCOOP / SCOOP_GLOBAL 环境变量，或将 LibreOffice 的 program 目录加入 PATH 后重启应用，再重试提取。".into())
}

#[cfg(any(windows, test))]
fn scoop_libreoffice_paths(root: &std::path::Path) -> [PathBuf; 4] {
    let current = root.join("apps/libreoffice/current");
    [
        current.join("LibreOffice/program/soffice.com"),
        current.join("LibreOffice/program/soffice.exe"),
        current.join("program/soffice.com"),
        current.join("program/soffice.exe"),
    ]
}

struct ConversionDirectory(PathBuf);

impl ConversionDirectory {
    fn create() -> Result<Self, String> {
        // Atomic creation prevents concurrent conversions from sharing files or profiles.
        loop {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?.as_nanos();
            let path = std::env::temp_dir().join(format!("nexusdesk-office-{}-{stamp}", std::process::id()));
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("无法创建转换临时目录：{error}")),
            }
        }
    }
}

impl Drop for ConversionDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tauri::command]
pub async fn convert_legacy_office(bytes: Vec<u8>, extension: String) -> Result<Vec<u8>, String> {
    let extension = extension.to_ascii_lowercase();
    let (target, filter) = target_format(&extension)?;
    let executable = find_libreoffice()?;
    let directory = ConversionDirectory::create()?;
    let source = directory.0.join(format!("document.{extension}"));
    tokio::fs::write(&source, bytes).await.map_err(|e| format!("无法写入转换临时文件：{e}"))?;
    let profile = reqwest::Url::from_directory_path(directory.0.join("profile"))
        .map_err(|_| "无法创建 LibreOffice 临时配置路径".to_string())?;
    let mut command = Command::new(executable);
    command.arg(format!("-env:UserInstallation={profile}"))
        .args(["--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--convert-to", filter, "--outdir"])
        .arg(&directory.0).arg(&source)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|e| format!("无法启动 LibreOffice：{e}"))?;
    let status = match tokio::time::timeout(Duration::from_secs(120), child.wait()).await {
        Ok(status) => status.map_err(|e| format!("LibreOffice 转换失败：{e}"))?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("LibreOffice 转换超时（120 秒），请检查文档后重试。".into());
        }
    };
    if !status.success() {
        return Err(format!("LibreOffice 转换失败（{status}），请检查文档是否损坏或受密码保护。"));
    }
    // LibreOffice may exit successfully without producing a file (e.g. encrypted input).
    let result = tokio::fs::read(directory.0.join(format!("document.{target}"))).await
        .map_err(|_| "LibreOffice 未生成转换文件，请检查文档是否损坏或受密码保护。".to_string())?;
    if result.is_empty() {
        return Err("LibreOffice 生成的转换文件为空。".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoop_installations_resolve_real_executables() {
        // Cover user, global and custom roots without changing process environment.
        let directory = ConversionDirectory::create().unwrap();
        for root in ["Users/test/scoop", "ProgramData/scoop", "custom scoop"] {
            let root = directory.0.join(root);
            let paths = scoop_libreoffice_paths(&root);
            assert_eq!(paths[0], root.join("apps/libreoffice/current/LibreOffice/program/soffice.com"));
            assert_eq!(paths[1], root.join("apps/libreoffice/current/LibreOffice/program/soffice.exe"));
            assert_eq!(paths[2], root.join("apps/libreoffice/current/program/soffice.com"));
            assert_eq!(paths[3], root.join("apps/libreoffice/current/program/soffice.exe"));
            std::fs::create_dir_all(paths[2].parent().unwrap()).unwrap();
            std::fs::write(&paths[3], b"test").unwrap();
            assert_eq!(paths.iter().find(|path| path.is_file()), Some(&paths[3]));
            std::fs::write(&paths[2], b"test").unwrap();
            assert_eq!(paths.iter().find(|path| path.is_file()), Some(&paths[2]));
            std::fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
            // EXE-only installations must work too; prefer COM when both exist.
            std::fs::write(&paths[1], b"test").unwrap();
            assert_eq!(paths.iter().find(|path| path.is_file()), Some(&paths[1]));
            std::fs::write(&paths[0], b"test").unwrap();
            assert_eq!(paths.iter().find(|path| path.is_file()), Some(&paths[0]));
        }
    }

    #[test]
    fn legacy_formats_use_matching_ooxml_filters() {
        assert_eq!(target_format("doc").unwrap(), ("docx", "docx:Office Open XML Text"));
        assert_eq!(target_format("ppt").unwrap(), ("pptx", "pptx:Impress MS PowerPoint 2007 XML"));
        assert!(target_format("../doc").is_err());
        assert!(target_format("docx").is_err());
    }

    #[test]
    fn conversion_directories_are_isolated_and_cleaned_on_error() {
        let first = ConversionDirectory::create().unwrap();
        let second = ConversionDirectory::create().unwrap();
        assert_ne!(first.0, second.0);
        let path = first.0.clone();
        let result: Result<(), ()> = (|| {
            let directory = first;
            std::fs::write(directory.0.join("document.doc"), b"test").unwrap();
            Err(())
        })();
        assert!(result.is_err());
        assert!(!path.exists());
        assert!(second.0.is_dir());
    }
}
