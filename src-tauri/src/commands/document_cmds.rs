use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;

fn target_format(extension: &str) -> Result<(&'static str, &'static str), String> {
    match extension {
        "doc" => Ok(("docx", "docx:Office Open XML Text")),
        "ppt" => Ok(("pptx", "pptx:Impress MS PowerPoint 2007 XML")),
        "xls" => Ok(("xlsx", "xlsx:Calc MS Excel 2007 XML")),
        _ => Err("LibreOffice 转换仅支持旧版 DOC/PPT/XLS。".into()),
    }
}

fn find_libreoffice() -> Result<PathBuf, String> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in if cfg!(windows) {
                &["soffice.com", "soffice.exe"][..]
            } else {
                &["libreoffice", "soffice"][..]
            } {
                paths.push(directory.join(name));
            }
            // Scoop exposes shims on PATH, not the actual program directory.
            #[cfg(windows)]
            if directory
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("shims"))
            {
                if let Some(root) = directory.parent() {
                    paths.extend(scoop_libreoffice_paths(root));
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let mut roots: Vec<PathBuf> = ["SCOOP", "SCOOP_GLOBAL"]
            .into_iter()
            .filter_map(std::env::var_os)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .collect();
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
    for root in [
        "ProgramW6432",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "LOCALAPPDATA",
    ] {
        if let Some(directory) = std::env::var_os(root) {
            paths.push(PathBuf::from(&directory).join("LibreOffice/program/soffice.com"));
            paths.push(PathBuf::from(directory).join("LibreOffice/program/soffice.exe"));
        }
    }
    #[cfg(target_os = "macos")]
    paths.push(PathBuf::from(
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ));
    paths.into_iter().find(|path| path.is_file())
        .ok_or_else(|| "未找到 LibreOffice。请在软件管理中安装；支持普通安装和 Scoop 安装。如使用自定义 Scoop 目录，请设置 SCOOP / SCOOP_GLOBAL 环境变量，或将 LibreOffice 的 program 目录加入 PATH 后重启应用，再重试转换。".into())
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
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("nexusdesk-office-{}-{stamp}", std::process::id()));
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
    convert_office(bytes, &extension, target, filter, &executable).await
}

async fn convert_office(
    bytes: Vec<u8>,
    extension: &str,
    target: &str,
    filter: &str,
    executable: &std::path::Path,
) -> Result<Vec<u8>, String> {
    let directory = ConversionDirectory::create()?;
    let source = directory.0.join(format!("document.{extension}"));
    tokio::fs::write(&source, bytes)
        .await
        .map_err(|e| format!("无法写入转换临时文件：{e}"))?;
    let profile = reqwest::Url::from_directory_path(directory.0.join("profile"))
        .map_err(|_| "无法创建 LibreOffice 临时配置路径".to_string())?;
    let settings = directory.0.join("profile/user");
    tokio::fs::create_dir_all(&settings)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(settings.join("registrymodifications.xcu"), r#"<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateLinks" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
</oor:items>"#).await.map_err(|e| e.to_string())?;
    let mut command = Command::new(executable);
    command
        .arg(format!("-env:UserInstallation={profile}"))
        .args([
            "--headless",
            "--nologo",
            "--nodefault",
            "--nofirststartwizard",
            "--convert-to",
            filter,
            "--outdir",
        ])
        .arg(&directory.0)
        .arg(&source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 LibreOffice：{e}"))?;
    let status = match tokio::time::timeout(Duration::from_secs(120), child.wait()).await {
        Ok(status) => status.map_err(|e| format!("LibreOffice 转换失败：{e}"))?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("LibreOffice 转换超时（120 秒），请检查文档后重试。".into());
        }
    };
    if !status.success() {
        return Err(format!(
            "LibreOffice 转换失败（{status}），请检查文档是否损坏或受密码保护。"
        ));
    }
    // LibreOffice may exit successfully without producing a file (e.g. encrypted input).
    let result = tokio::fs::read(directory.0.join(format!("document.{target}")))
        .await
        .map_err(|_| "LibreOffice 未生成转换文件，请检查文档是否损坏或受密码保护。".to_string())?;
    if result.is_empty() {
        return Err("LibreOffice 生成的转换文件为空。".into());
    }
    Ok(result)
}

static PREVIEW_CONVERSION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
static PREVIEW_QUEUE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
> = std::sync::LazyLock::new(Default::default);

#[tauri::command]
pub fn cancel_document_preview(request_id: String) {
    if let Ok(mut queue) = PREVIEW_QUEUE.lock() {
        if let Some(cancel) = queue.remove(&request_id) {
            let _ = cancel.send(());
        }
    }
}

async fn wait_for_preview(
    request_id: String,
) -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    PREVIEW_QUEUE
        .lock()
        .map_err(|e| e.to_string())?
        .insert(request_id.clone(), cancel);
    let result = tokio::select! {
        biased;
        _ = cancelled => Err("预览任务已取消".to_string()),
        permit = PREVIEW_CONVERSION.acquire() => permit.map_err(|e| e.to_string()),
    };
    PREVIEW_QUEUE
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id);
    result
}

#[tauri::command]
pub async fn prepare_document_preview(
    app: tauri::AppHandle,
    path: String,
    request_id: String,
) -> Result<Vec<u8>, String> {
    use std::hash::{Hash, Hasher};
    use tauri::Manager;

    let _permit = wait_for_preview(request_id).await?;
    let source = tokio::fs::canonicalize(&path)
        .await
        .map_err(|e| e.to_string())?;
    let extension = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "doc" | "docx" | "ppt" | "pptx" | "xls") {
        return Err("不支持的 Office 预览格式".into());
    }
    let executable = find_libreoffice()?;
    let metadata = tokio::fs::metadata(&source)
        .await
        .map_err(|e| e.to_string())?;
    let converter = tokio::fs::metadata(&executable)
        .await
        .map_err(|e| e.to_string())?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        "preview-v1",
        &source,
        metadata.len(),
        metadata.modified().ok(),
        &executable,
        converter.len(),
        converter.modified().ok(),
    )
        .hash(&mut hash);
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("office-preview");
    let output = cache.join(format!(
        "{:016x}.{}",
        hash.finish(),
        if extension == "xls" { "xlsx" } else { "pdf" }
    ));
    if let Ok(bytes) = tokio::fs::read(&output).await {
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    let mut bytes = tokio::fs::read(&source).await.map_err(|e| e.to_string())?;
    let modern = match extension.as_str() {
        "doc" | "ppt" | "xls" => {
            let (target, filter) = target_format(&extension)?;
            bytes = convert_office(bytes, &extension, target, filter, &executable).await?;
            target
        }
        _ => extension.as_str(),
    };
    if modern != "xlsx" {
        let filter = if modern == "docx" {
            "pdf:writer_pdf_Export"
        } else {
            "pdf:impress_pdf_Export"
        };
        bytes = convert_office(bytes, modern, "pdf", filter, &executable).await?;
    }
    tokio::fs::create_dir_all(&cache)
        .await
        .map_err(|e| e.to_string())?;
    // 新增缓存时清理超过七天的旧结果，原文件始终保持不变。
    if let Ok(mut entries) = tokio::fs::read_dir(&cache).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Ok(metadata) = entry.metadata().await {
                if metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(7 * 24 * 60 * 60))
                {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
    }
    tokio::fs::write(&output, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(bytes)
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
            assert_eq!(
                paths[0],
                root.join("apps/libreoffice/current/LibreOffice/program/soffice.com")
            );
            assert_eq!(
                paths[1],
                root.join("apps/libreoffice/current/LibreOffice/program/soffice.exe")
            );
            assert_eq!(
                paths[2],
                root.join("apps/libreoffice/current/program/soffice.com")
            );
            assert_eq!(
                paths[3],
                root.join("apps/libreoffice/current/program/soffice.exe")
            );
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
        assert_eq!(
            target_format("doc").unwrap(),
            ("docx", "docx:Office Open XML Text")
        );
        assert_eq!(
            target_format("ppt").unwrap(),
            ("pptx", "pptx:Impress MS PowerPoint 2007 XML")
        );
        assert!(target_format("../doc").is_err());
        assert!(target_format("docx").is_err());
        assert_eq!(
            target_format("xls").unwrap(),
            ("xlsx", "xlsx:Calc MS Excel 2007 XML")
        );
    }

    #[tokio::test]
    async fn cancelled_preview_leaves_queue_without_starting_conversion() {
        let permit = PREVIEW_CONVERSION.acquire().await.unwrap();
        let waiting = tokio::spawn(wait_for_preview("cancel-test".into()));
        loop {
            if PREVIEW_QUEUE.lock().unwrap().contains_key("cancel-test") {
                break;
            }
            tokio::task::yield_now().await;
        }
        cancel_document_preview("cancel-test".into());
        let result = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        assert!(!PREVIEW_QUEUE.lock().unwrap().contains_key("cancel-test"));
        drop(permit);
        assert!(wait_for_preview("next-test".into()).await.is_ok());
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

    #[tokio::test]
    #[ignore = "需要本机安装 LibreOffice"]
    async fn libreoffice_converts_legacy_documents_through_modern_formats() {
        let executable = find_libreoffice().unwrap();
        let fixtures = [
            (
                "fodt",
                "doc",
                "doc:MS Word 97",
                "text",
                "<office:text><text:p>Word preview 测试</text:p></office:text>",
            ),
            (
                "fodp",
                "ppt",
                "ppt:MS PowerPoint 97",
                "presentation",
                "<office:presentation><draw:page draw:name=\"Slide 1\"><draw:frame svg:width=\"10cm\" svg:height=\"3cm\" svg:x=\"1cm\" svg:y=\"1cm\"><draw:text-box><text:p>Slide preview 测试</text:p></draw:text-box></draw:frame></draw:page></office:presentation>",
            ),
            (
                "fods",
                "xls",
                "xls:MS Excel 97",
                "spreadsheet",
                "<office:spreadsheet><table:table table:name=\"工作表一\"><table:table-row><table:table-cell office:value-type=\"string\"><text:p>Excel preview 测试</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>",
            ),
        ];
        for (flat, legacy, legacy_filter, kind, body) in fixtures {
            let source = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.{kind}">
<office:body>{body}</office:body></office:document>"#
            );
            let old = convert_office(
                source.into_bytes(),
                flat,
                legacy,
                legacy_filter,
                &executable,
            )
            .await
            .unwrap();
            assert!(old.starts_with(&[0xd0, 0xcf]), "{legacy} 应为旧版 OLE 文件");
            let (modern, filter) = target_format(legacy).unwrap();
            let converted = convert_office(old, legacy, modern, filter, &executable)
                .await
                .unwrap();
            assert!(converted.starts_with(b"PK"), "{modern} 应为 OOXML 文件");
            if modern != "xlsx" {
                let filter = if modern == "docx" {
                    "pdf:writer_pdf_Export"
                } else {
                    "pdf:impress_pdf_Export"
                };
                let pdf = convert_office(converted, modern, "pdf", filter, &executable)
                    .await
                    .unwrap();
                assert!(pdf.starts_with(b"%PDF-"));
            }
        }
    }
}
