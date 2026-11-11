#[derive(serde::Serialize)]
pub struct BrowserExtensionInfo {
    id: String,
    name: String,
    enabled: bool,
    removable: bool,
    options_url: Option<String>,
    popup_url: Option<String>,
}

#[cfg(windows)]
mod windows_impl {
    use std::{
        io::{Cursor, Read, Write},
        path::{Path, PathBuf},
        time::Duration,
    };
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::{HSTRING, Interface};

    const MAX_DOWNLOAD: usize = 100 * 1024 * 1024;
    const MAX_EXTRACTED: u64 = 300 * 1024 * 1024;

    // COM objects stay on the WebView UI thread; only plain data crosses to IPC.
    pub async fn manage(
        window: tauri::Window,
        label: String,
        remove: Option<String>,
    ) -> Result<Vec<super::BrowserExtensionInfo>, String> {
        if !label.starts_with(&format!("{}-browser-", window.label())) {
            return Err("无效的网页标签".into());
        }
        let view = window.get_webview(&label).ok_or("请先打开网页")?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        view.with_webview(move |platform| unsafe {
            let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
            let completed = sender.clone();
            let result = (|| -> windows::core::Result<()> {
                let profile = platform.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?
                    .Profile()?.cast::<ICoreWebView2Profile7>()?;
                profile.GetBrowserExtensions(&webview2_com::ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |status, extensions| {
                    let result = (|| -> Result<Option<Vec<super::BrowserExtensionInfo>>, String> {
                        status.map_err(|e| e.to_string())?;
                        let extensions = extensions.ok_or("无法读取已安装扩展")?;
                        let mut count = 0;
                        extensions.Count(&mut count).map_err(|e| e.to_string())?;
                        let mut items = Vec::new();
                        for index in 0..count {
                            let extension = extensions.GetValueAtIndex(index).map_err(|e| e.to_string())?;
                            let mut id = windows::core::PWSTR::null();
                            extension.Id(&mut id).map_err(|e| e.to_string())?;
                            let id = webview2_com::take_pwstr(id);
                            let mut name = windows::core::PWSTR::null();
                            extension.Name(&mut name).map_err(|e| e.to_string())?;
                            let name = webview2_com::take_pwstr(name);
                            // WebView2 exposes these runtime components in the extension list,
                            // but does not support uninstalling them through Remove.
                            let removable = !name.eq_ignore_ascii_case("Microsoft Edge PDF Viewer")
                                && !name.eq_ignore_ascii_case("Microsoft Clipboard Extension");
                            if remove.as_deref() == Some(id.as_str()) {
                                if !removable { return Err("这是 WebView2 内置扩展，不支持删除".into()); }
                                let removed = completed.clone();
                                extension.Remove(&webview2_com::BrowserExtensionRemoveCompletedHandler::create(Box::new(move |status| {
                                    if let Some(sender) = removed.lock().unwrap().take() {
                                        let _ = sender.send(status.map(|_| Vec::new()).map_err(|e| e.to_string()));
                                    }
                                    Ok(())
                                }))).map_err(|e| e.to_string())?;
                                return Ok(None);
                            }
                            let mut enabled = windows::core::BOOL::default();
                            extension.IsEnabled(&mut enabled).map_err(|e| e.to_string())?;
                            items.push(super::BrowserExtensionInfo { id, name, enabled: enabled.as_bool(), removable, options_url: None, popup_url: None });
                        }
                        if remove.is_some() { return Err("扩展已被删除或不存在，请刷新列表".into()); }
                        items.sort_by(|a, b| a.name.cmp(&b.name));
                        Ok(Some(items))
                    })();
                    match result {
                        Ok(None) => {}, // Remove completes through its own callback.
                        result => if let Some(sender) = completed.lock().unwrap().take() {
                            let _ = sender.send(result.map(Option::unwrap));
                        },
                    }
                    Ok(())
                })))
            })();
            if let Err(error) = result {
                if let Some(sender) = sender.lock().unwrap().take() { let _ = sender.send(Err(error.to_string())); }
            }
        }).map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(60), receiver)
            .await
            .map_err(|_| "扩展管理操作超时，请刷新列表检查结果".to_string())?
            .map_err(|_| "扩展管理回调已关闭".to_string())?
    }

    fn valid_id(value: &str) -> bool {
        value.len() == 32 && value.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
    }

    fn extension_page(id: &str, page: &str) -> Option<String> {
        if !valid_id(id) || page.trim().is_empty() {
            return None;
        }
        let base = reqwest::Url::parse(&format!("chrome-extension://{id}/")).ok()?;
        let url = base.join(page).ok()?;
        (url.scheme() == "chrome-extension"
            && url.host_str() == Some(id)
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none())
        .then(|| url.to_string())
    }

    fn manifest_pages(id: &str, manifest: &serde_json::Value) -> (Option<String>, Option<String>) {
        let resolve =
            |value: &serde_json::Value| value.as_str().and_then(|page| extension_page(id, page));
        let options =
            resolve(&manifest["options_ui"]["page"]).or_else(|| resolve(&manifest["options_page"]));
        let popup = resolve(&manifest["action"]["default_popup"])
            .or_else(|| resolve(&manifest["browser_action"]["default_popup"]))
            .or_else(|| resolve(&manifest["page_action"]["default_popup"]));
        (options, popup)
    }

    pub fn add_pages(root: &Path, items: &mut [super::BrowserExtensionInfo]) {
        let packages = root.join("browser-extensions");
        let mut directories = std::collections::HashMap::new();
        // New installs retain the runtime ID, which can differ from the store ID.
        if let Ok(entries) = std::fs::read_dir(&packages) {
            for entry in entries.flatten() {
                if let Ok(id) = std::fs::read_to_string(entry.path().join("extension-id")) {
                    if valid_id(id.trim()) {
                        directories.insert(id.trim().to_owned(), entry.path().join("unpacked"));
                    }
                }
            }
        }
        // Existing installations predate the ID sidecar. Chromium retains their
        // unpacked paths in its profile preferences; do not reload them to discover IDs.
        for profile in [
            root.join("browser/EBWebView/Default"),
            root.join("browser/Default"),
        ] {
            for file in ["Preferences", "Secure Preferences"] {
                let preferences = std::fs::read(profile.join(file))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
                if let Some(settings) = preferences
                    .as_ref()
                    .and_then(|value| value["extensions"]["settings"].as_object())
                {
                    for (id, value) in settings {
                        if let Some(path) = value["path"].as_str() {
                            directories
                                .entry(id.clone())
                                .or_insert_with(|| PathBuf::from(path));
                        }
                    }
                }
            }
        }
        let Ok(packages) = packages.canonicalize() else {
            return;
        };
        for item in items {
            let Some(directory) = directories
                .get(&item.id)
                .and_then(|path| path.canonicalize().ok())
            else {
                continue;
            };
            if !directory.starts_with(&packages) {
                continue;
            }
            let manifest = std::fs::read(directory.join("manifest.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            if let Some(manifest) = manifest {
                (item.options_url, item.popup_url) = manifest_pages(&item.id, &manifest);
            }
        }
    }

    fn download_url(source: &str) -> Result<reqwest::Url, String> {
        let source = source.trim();
        let id = if valid_id(source) {
            Some(source.to_owned())
        } else {
            let url = reqwest::Url::parse(source)
                .map_err(|_| "请输入扩展 ID、Chrome 商店链接或 HTTPS CRX 地址")?;
            if url.scheme() != "https" {
                return Err("扩展下载地址必须使用 HTTPS".into());
            }
            if matches!(
                url.host_str(),
                Some("chromewebstore.google.com" | "chrome.google.com")
            ) {
                Some(
                    url.path_segments()
                        .and_then(|parts| parts.filter(|part| !part.is_empty()).next_back())
                        .filter(|id| valid_id(id))
                        .ok_or("商店链接中缺少有效的扩展 ID")?
                        .to_owned(),
                )
            } else {
                return Ok(url);
            }
        };
        let mut url =
            reqwest::Url::parse("https://clients2.google.com/service/update2/crx").unwrap();
        url.query_pairs_mut()
            .append_pair("response", "redirect")
            .append_pair("prodversion", "142.0.0.0")
            .append_pair("acceptformat", "crx2,crx3")
            .append_pair("x", &format!("id={}&uc", id.unwrap()));
        Ok(url)
    }

    // CRX2: key length + signature length. CRX3: protobuf header length.
    // Do not scan for a ZIP signature: headers may contain those bytes too.
    fn zip_payload(bytes: &[u8]) -> Result<&[u8], String> {
        let number = |offset: usize| -> Result<usize, String> {
            let value: [u8; 4] = bytes
                .get(offset..offset + 4)
                .ok_or("CRX 文件头不完整")?
                .try_into()
                .unwrap();
            Ok(u32::from_le_bytes(value) as usize)
        };
        if bytes.get(..4) != Some(b"Cr24") {
            return Err("下载内容不是 CRX 文件".into());
        }
        let offset = match number(4)? {
            2 => 16usize
                .checked_add(number(8)?)
                .and_then(|n| n.checked_add(number(12).ok()?)),
            3 => 12usize.checked_add(number(8)?),
            _ => return Err("不支持的 CRX 版本".into()),
        }
        .ok_or("CRX 文件头长度溢出")?;
        let payload = bytes.get(offset..).ok_or("CRX 文件头长度超出文件大小")?;
        if !payload.starts_with(b"PK\x03\x04") {
            return Err("CRX 不包含有效的 ZIP 内容".into());
        }
        Ok(payload)
    }

    fn extract(bytes: &[u8], directory: &Path) -> Result<(), String> {
        let mut archive =
            zip::ZipArchive::new(Cursor::new(zip_payload(bytes)?)).map_err(|e| e.to_string())?;
        if archive.len() > 20_000 {
            return Err("扩展包含过多文件".into());
        }
        let mut remaining = MAX_EXTRACTED;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
            let name = entry.enclosed_name().ok_or("扩展包含越界路径")?;
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("扩展包含符号链接".into());
            }
            let target = directory.join(name);
            if entry.is_dir() {
                std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
                continue;
            }
            if entry.size() > remaining {
                return Err("扩展解压大小超出限制".into());
            }
            std::fs::create_dir_all(target.parent().ok_or("无效的扩展路径")?)
                .map_err(|e| e.to_string())?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|e| e.to_string())?;
            let written = std::io::copy(&mut (&mut entry).take(remaining + 1), &mut file)
                .map_err(|e| e.to_string())?;
            remaining = remaining
                .checked_sub(written)
                .ok_or("扩展解压大小超出限制")?;
        }
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("manifest.json"))
                .map_err(|_| "扩展根目录缺少 manifest.json")?,
        )
        .map_err(|e| e.to_string())?;
        if !manifest["manifest_version"].is_u64()
            || !manifest["name"].is_string()
            || !manifest["version"].is_string()
        {
            return Err("扩展 manifest.json 缺少必要字段".into());
        }
        Ok(())
    }

    async fn load(view: tauri::Webview, directory: PathBuf) -> Result<String, String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        view.with_webview(move |platform| unsafe {
            // Both immediate COM errors and asynchronous completion reach the caller.
            let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
            let completed = sender.clone();
            let result = (|| -> windows::core::Result<()> {
                let profile = platform
                    .controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_13>()?
                    .Profile()?
                    .cast::<ICoreWebView2Profile7>()?;
                profile.AddBrowserExtension(
                    &HSTRING::from(directory.as_path()),
                    &webview2_com::ProfileAddBrowserExtensionCompletedHandler::create(Box::new(
                        move |status, extension| {
                            let result = status.map_err(|e| e.to_string()).and_then(|_| {
                                let extension = extension.ok_or("WebView2 未返回扩展对象")?;
                                let mut id = windows::core::PWSTR::null();
                                extension.Id(&mut id).map_err(|e| e.to_string())?;
                                Ok(webview2_com::take_pwstr(id))
                            });
                            if let Some(sender) = completed.lock().unwrap().take() {
                                let _ = sender.send(result);
                            }
                            Ok(())
                        },
                    )),
                )
            })();
            if let Err(error) = result {
                if let Some(sender) = sender.lock().unwrap().take() {
                    let _ = sender.send(Err(format!(
                        "无法加载扩展，请检查 WebView2 Runtime 是否支持扩展：{error}"
                    )));
                }
            }
        })
        .map_err(|e| e.to_string())?;
        // Keep installed files even if the UI stops waiting; COM may still complete.
        tokio::time::timeout(Duration::from_secs(60), receiver)
            .await
            .map_err(|_| "扩展加载等待超时，请重启应用后检查".to_string())?
            .map_err(|_| "扩展加载回调已关闭".to_string())?
    }

    pub async fn install(
        window: tauri::Window,
        label: String,
        source: String,
    ) -> Result<String, String> {
        if !label.starts_with(&format!("{}-browser-", window.label())) {
            return Err("无效的网页标签".into());
        }
        let view = window.get_webview(&label).ok_or("请先打开网页")?;
        let url = download_url(&source)?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .https_only(true)
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_DOWNLOAD as u64)
        {
            return Err("CRX 文件超过 100 MB".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > MAX_DOWNLOAD {
                return Err("CRX 文件超过 100 MB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let root = crate::profiles::data_directory(window.app_handle()).join("browser-extensions");
        let directory = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
            std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            let key = format!(
                "{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            );
            let package = root.join(key);
            std::fs::create_dir(&package).map_err(|e| e.to_string())?;
            let result = (|| {
                let mut file = std::fs::File::create(package.join("extension.crx"))
                    .map_err(|e| e.to_string())?;
                file.write_all(&bytes).map_err(|e| e.to_string())?;
                let directory = package.join("unpacked");
                std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
                extract(&bytes, &directory)?;
                Ok(directory)
            })();
            if result.is_err() {
                let _ = std::fs::remove_dir_all(&package);
            }
            result
        })
        .await
        .map_err(|e| e.to_string())??;
        let id = load(view, directory.clone()).await?;
        std::fs::write(
            directory
                .parent()
                .ok_or("无效的扩展路径")?
                .join("extension-id"),
            &id,
        )
        .map_err(|e| format!("扩展已安装，但保存配置页索引失败：{e}"))?;
        Ok(id)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn resolves_options_and_popup_pages_within_extension_origin() {
            let id = "a".repeat(32);
            let manifest = serde_json::json!({
                "options_ui": { "page": "settings/index.html?tab=general#theme" },
                "options_page": "legacy.html",
                "action": { "default_popup": "popup.html" }
            });
            let (options, popup) = manifest_pages(&id, &manifest);
            assert_eq!(
                options.unwrap(),
                format!("chrome-extension://{id}/settings/index.html?tab=general#theme")
            );
            assert_eq!(
                popup.unwrap(),
                format!("chrome-extension://{id}/popup.html")
            );
            let legacy = serde_json::json!({ "options_page": "options.html", "browser_action": { "default_popup": "/popup.html" } });
            assert!(manifest_pages(&id, &legacy).0.is_some());
            assert!(manifest_pages(&id, &legacy).1.is_some());
            assert_eq!(manifest_pages(&id, &serde_json::json!({})), (None, None));
            for page in [
                "",
                "https://example.com/options.html",
                "//example.com/options.html",
                "javascript:alert(1)",
            ] {
                assert!(extension_page(&id, page).is_none());
            }
            assert!(extension_page("invalid", "options.html").is_none());
        }

        #[test]
        fn discovers_pages_for_new_and_existing_installations() {
            let root = std::env::temp_dir().join(format!(
                "nexusdesk-extension-pages-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap()
            ));
            let directory = root.join("browser-extensions/package/unpacked");
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                directory.join("manifest.json"),
                br#"{"options_page":"options.html"}"#,
            )
            .unwrap();
            let id = "a".repeat(32);
            let make_item = || super::super::BrowserExtensionInfo {
                id: id.clone(),
                name: "Test".into(),
                enabled: true,
                removable: true,
                options_url: None,
                popup_url: None,
            };
            std::fs::write(directory.parent().unwrap().join("extension-id"), &id).unwrap();
            let mut items = vec![make_item()];
            add_pages(&root, &mut items);
            assert_eq!(
                items[0].options_url.as_deref(),
                Some(format!("chrome-extension://{id}/options.html").as_str())
            );
            std::fs::remove_file(directory.parent().unwrap().join("extension-id")).unwrap();
            let profile = root.join("browser/EBWebView/Default");
            std::fs::create_dir_all(&profile).unwrap();
            let preferences = serde_json::json!({ "extensions": { "settings": { (id.clone()): { "path": directory } } } });
            std::fs::write(profile.join("Secure Preferences"), preferences.to_string()).unwrap();
            let mut legacy = vec![make_item()];
            add_pages(&root, &mut legacy);
            assert_eq!(legacy[0].options_url, items[0].options_url);
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn crx_headers_and_invalid_lengths() {
            for version in [2u32, 3] {
                let mut bytes = b"Cr24".to_vec();
                bytes.extend(version.to_le_bytes());
                bytes.extend(4u32.to_le_bytes());
                if version == 2 {
                    bytes.extend(2u32.to_le_bytes());
                }
                bytes.extend(vec![0; if version == 2 { 6 } else { 4 }]);
                bytes.extend(b"PK\x03\x04payload");
                assert_eq!(zip_payload(&bytes).unwrap(), b"PK\x03\x04payload");
                assert!(zip_payload(&bytes[..12]).is_err());
            }
            assert!(zip_payload(b"<html>not a crx</html>").is_err());
            assert!(zip_payload(b"Cr24\x03\0\0\0\xff\xff\xff\xff").is_err());
        }

        #[test]
        fn resolves_store_links_and_rejects_invalid_sources() {
            let id = "a".repeat(32);
            let direct = download_url(&id).unwrap();
            assert_eq!(
                direct,
                download_url(&format!(
                    "https://chromewebstore.google.com/detail/test/{id}"
                ))
                .unwrap()
            );
            assert_eq!(
                download_url("https://example.com/test.crx")
                    .unwrap()
                    .host_str(),
                Some("example.com")
            );
            assert!(download_url("http://example.com/test.crx").is_err());
            assert!(download_url("https://chromewebstore.google.com/detail/bad").is_err());
        }

        #[test]
        fn extracts_manifest_and_rejects_parent_paths() {
            fn package(name: &str, content: &[u8]) -> Vec<u8> {
                let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(content).unwrap();
                let archive = writer.finish().unwrap().into_inner();
                let mut bytes = b"Cr24\x03\0\0\0\0\0\0\0".to_vec();
                bytes.extend(archive);
                bytes
            }
            let root = std::env::temp_dir().join(format!(
                "nexusdesk-extension-test-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap()
            ));
            std::fs::create_dir(&root).unwrap();
            let manifest = br#"{"manifest_version":3,"name":"Test","version":"1.0"}"#;
            extract(&package("manifest.json", manifest), &root).unwrap();
            assert_eq!(std::fs::read(root.join("manifest.json")).unwrap(), manifest);
            assert!(extract(&package("../outside.json", b"bad"), &root).is_err());
            assert!(!root.parent().unwrap().join("outside.json").exists());
            assert!(extract(&package("manifest.json", manifest), &root).is_err());
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[tauri::command]
pub async fn browser_install_extension(
    window: tauri::Window,
    label: String,
    source: String,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::collections::HashSet;
        use std::sync::{Mutex, OnceLock};
        use tauri::{Emitter, Manager};
        static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
        let key = label.clone();
        if !label.starts_with(&format!("{}-browser-", window.label()))
            || window.get_webview(&label).is_none()
        {
            return Err("无效的网页标签".into());
        }
        if !ACTIVE
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(key.clone())
        {
            return Err("此网页已有扩展正在安装，请等待完成".into());
        }
        struct Guard(String);
        impl Drop for Guard {
            fn drop(&mut self) {
                ACTIVE.get().unwrap().lock().unwrap().remove(&self.0);
            }
        }
        let _guard = Guard(key);
        let emit = |state: &str, message: &str| {
            let _ = window.emit_to(
                window.label(),
                "browser-extension-install",
                serde_json::json!({
                    "label": label, "source": source, "state": state, "message": message
                }),
            );
        };
        emit("installing", "正在下载并安装扩展…");
        let result = windows_impl::install(window.clone(), label.clone(), source.clone()).await;
        match &result {
            Ok(_) => emit(
                "completed",
                "扩展已安装并保存在当前项目中，请刷新需要使用扩展的网页。",
            ),
            Err(error) => emit(
                "failed",
                &format!("扩展安装失败：{error}。可在 NexusDesk 扩展面板重试。"),
            ),
        }
        result
    }
    #[cfg(not(windows))]
    {
        let _ = (window, label, source);
        Err("仅 Windows 支持浏览器扩展".into())
    }
}

#[tauri::command]
pub async fn browser_list_extensions(
    window: tauri::Window,
    label: String,
) -> Result<Vec<BrowserExtensionInfo>, String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let root = crate::profiles::data_directory(window.app_handle());
        let mut items = windows_impl::manage(window, label, None).await?;
        tokio::task::spawn_blocking(move || {
            windows_impl::add_pages(&root, &mut items);
            items
        })
        .await
        .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, label);
        Err("仅 Windows 支持浏览器扩展".into())
    }
}

#[tauri::command]
pub async fn browser_open_extension_page(
    window: tauri::Window,
    label: String,
    id: String,
    page: String,
) -> Result<(), String> {
    let extension = browser_list_extensions(window.clone(), label.clone())
        .await?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or("扩展已被删除，请刷新列表")?;
    if !extension.enabled {
        return Err("请先启用此扩展".into());
    }
    let url = match page.as_str() {
        "options" => extension.options_url,
        "popup" => extension.popup_url,
        _ => return Err("无效的扩展页面类型".into()),
    }
    .ok_or("此扩展未提供该页面")?;
    super::browser_cmds::open_extension_page(&window, &label, &url)
}

#[tauri::command]
pub async fn browser_remove_extension(
    window: tauri::Window,
    label: String,
    id: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::manage(window, label, Some(id))
            .await
            .map(|_| ())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, label, id);
        Err("仅 Windows 支持浏览器扩展".into())
    }
}
