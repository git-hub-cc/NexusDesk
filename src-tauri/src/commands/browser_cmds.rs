use tauri::{Emitter, Manager};

fn load_results() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static RESULTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> = std::sync::OnceLock::new();
    RESULTS.get_or_init(Default::default)
}

// Keep titles for speculative/retained views whose editor listener is not attached.
fn document_titles() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static TITLES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> = std::sync::OnceLock::new();
    TITLES.get_or_init(Default::default)
}

pub(super) fn clear_download_error(window: &tauri::Window, label: &str) {
    if let Ok(mut results) = load_results().lock() { results.insert(label.into(), String::new()); }
    let _ = window.emit_to(window.label(), &format!("browser-load-result-{label}"), "");
}

// OAuth query strings/fragments can contain credentials. Only record the route.
fn diagnostic_url(url: &tauri::Url) -> String {
    format!("{}://{}{}", url.scheme(), url.host_str().unwrap_or(""), url.path())
}

fn navigation_status(status: i32) -> &'static str {
    match status {
        0 => "UNKNOWN", 6 => "SERVER_UNREACHABLE", 7 => "TIMEOUT",
        9 => "REDIRECT_FAILED", 14 => "OPERATION_CANCELED", _ => "OTHER",
    }
}

fn navigation_message(success: bool, status: i32) -> Option<String> {
    if status == 14 { return None; }
    if success { return Some(String::new()); }
    Some(match status {
        6 => "无法连接服务器，请检查网络或代理后重试。".into(),
        7 => "网页连接超时，请重试。".into(),
        9 => "网页重定向失败，请重新加载；若登录仍失败，请在系统浏览器中打开。".into(),
        0 => "网页未能完成加载，请重新加载或在系统浏览器中打开。".into(),
        _ => format!("网页加载失败（错误代码 {status}），请刷新重试。"),
    })
}

fn trace_browser_result<T, E: std::fmt::Display>(label: &str, operation: &str, result: Result<T, E>) -> Result<T, String> {
    result.map_err(|error| {
        log::error!(target: "browser", "label={label} operation={operation} failed: {error}");
        error.to_string()
    })
}

// All tabs in a project must use the same directory AND environment options.
// WebView2 otherwise drops session cookies when its last browser process exits.
// Keep Wry's default arguments when overriding its browser arguments.
#[cfg(target_os = "windows")]
const BROWSER_BASE_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,IntensiveWakeUpThrottling ",
    // Tauri restores tabs itself; do not also restore Chromium's previous
    // browser session (which may have ended in an authentication transition).
    "--persist-session-cookies ",
    "--disable-quic ",
    "--disable-background-timer-throttling --disable-backgrounding-occluded-windows ",
    "--disable-renderer-backgrounding --enable-gpu-rasterization --ignore-gpu-blocklist ",
    "--disk-cache-size=1073741824"
);

#[cfg(target_os = "windows")]
fn browser_proxy_mode() -> &'static str {
    use winreg::{enums::{HKEY_CURRENT_USER, KEY_READ}, RegKey};

    let Ok(internet_settings) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", KEY_READ)
    else { return "unknown"; };
    let proxy_enabled = internet_settings.get_value::<u32, _>("ProxyEnable").unwrap_or_default() != 0
        && internet_settings.get_value::<String, _>("ProxyServer").is_ok_and(|value| !value.trim().is_empty());
    let pac_enabled = internet_settings.get_value::<String, _>("AutoConfigURL").is_ok_and(|value| !value.trim().is_empty());
    let auto_detect = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections", KEY_READ)
        .and_then(|connections| connections.get_raw_value("DefaultConnectionSettings"))
        .ok()
        .and_then(|value| value.bytes.get(4..8).map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap())))
        .is_some_and(|flags| flags & 8 != 0);

    match (proxy_enabled, pac_enabled, auto_detect) {
        (true, true, _) => "static+pac",
        (true, false, true) => "static+wpad",
        (true, false, false) => "static",
        (false, true, true) => "pac+wpad",
        (false, true, false) => "pac",
        (false, false, true) => "wpad",
        (false, false, false) => "direct",
    }
}

#[cfg(not(target_os = "windows"))]
fn browser_proxy_mode() -> &'static str { "platform-default" }

#[cfg(target_os = "windows")]
fn browser_args(proxy_mode: &str) -> String {
    let mut args = BROWSER_BASE_ARGS.to_string();
    if proxy_mode == "direct" { args.push_str("--proxy-auto-detect=false "); }
    args
}

fn browser_directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = crate::profiles::data_directory(app).join("browser");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory)
}

pub(super) fn open_extension_page(window: &tauri::Window, parent: &str, url: &str) -> Result<(), String> {
    window.emit_to(window.label(), &format!("browser-new-tab-{parent}"), url).map_err(|e| e.to_string())
}

fn close_browser_children(window: &tauri::Window, parent_label: &str) {
    let prefix = format!("{parent_label}-popup-");
    for (label, popup) in window.app_handle().webview_windows() {
        if label.starts_with(&prefix) {
            if let Err(error) = popup.destroy() {
                log::warn!(target: "browser", "label={label} cascade-close failed: {error}");
            }
        }
    }
}

pub fn close_window_popups(window: &tauri::Window) {
    close_browser_children(window, &format!("{}-browser", window.label()));
    let prefix = format!("{}-browser-", window.label());
    for (label, popup) in window.app_handle().webview_windows() {
        if label.starts_with(&prefix) { let _ = popup.destroy(); }
    }
}

fn browser_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|e| e.to_string())?;
    if !allowed_browser_url(&url) { return Err("不支持的网页地址".into()); }
    Ok(url)
}

fn is_extension_url(url: &tauri::Url) -> bool {
    url.scheme() == "chrome-extension" && url.host_str().is_some_and(|id|
        id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)))
        && url.username().is_empty() && url.password().is_none() && url.port().is_none()
}

fn allowed_browser_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank" || is_extension_url(url)
}

// Preserve an opener for authentication flows and explicitly sized popups.
// Blank windows may be navigated by their opener after an asynchronous request.
fn needs_native_popup(url: &tauri::Url, explicit_window: bool) -> bool {
    !is_extension_url(url) && (explicit_window
        || url.as_str() == "about:blank"
        || url.path().to_ascii_lowercase().split('/')
            .any(|part| matches!(part, "oauth" | "oauth2" | "authorize" | "authorization" | "login" | "signin" | "sso" | "saml"))
        || url.query_pairs().any(|(key, _)| matches!(key.as_ref(), "client_id" | "redirect_uri" | "response_type" | "SAMLRequest")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_failures_distinguish_cancellation_unknown_and_network_errors() {
        assert_eq!(navigation_message(false, 14), None);
        assert_eq!(navigation_message(true, 0), Some(String::new()));
        for status in [0, 6, 7, 9] {
            assert!(!navigation_message(false, status).unwrap().is_empty());
            assert_ne!(navigation_status(status), "OTHER");
        }
        assert!(!navigation_message(false, 0).unwrap().contains("代码 0"));
    }

    #[test]
    fn diagnostic_urls_remove_credentials_and_authentication_parameters() {
        assert_eq!(diagnostic_url(&tauri::Url::parse("https://user:secret@example.com/login?token=secret#code").unwrap()), "https://example.com/login");
        assert!(validate_label("main", "main-browser-123").is_ok());
        assert!(validate_label("main", "other-browser-123").is_err());
    }

    #[test]
    fn extension_pages_use_tabs_and_allow_navigation() {
        let id = "a".repeat(32);
        let value = format!("chrome-extension://{id}/pages/options.html#general");
        let url = browser_url(&value).unwrap();
        assert!(allowed_browser_url(&url));
        assert!(!needs_native_popup(&url, false));
        assert!(!needs_native_popup(&url, true));
        for value in ["chrome-extension://invalid/options.html", "file:///options.html", "javascript:alert(1)", "chrome://extensions/"] {
            assert!(browser_url(value).is_err());
        }
    }

    #[test]
    fn distinguishes_links_from_authentication_popups() {
        for value in ["https://example.com/docs", "https://example.com/blog/login-guide"] {
            assert!(!needs_native_popup(&tauri::Url::parse(value).unwrap(), false));
        }
        for value in ["https://example.com/oauth2/authorize", "https://example.com/login", "https://example.com/connect?client_id=app", "about:blank"] {
            assert!(needs_native_popup(&tauri::Url::parse(value).unwrap(), false));
        }
        assert!(needs_native_popup(&tauri::Url::parse("https://example.com/").unwrap(), true));
    }
}

fn child(window: &tauri::Window, label: &str) -> Result<tauri::Webview, String> {
    validate_label(window.label(), label)?;
    window.get_webview(label).ok_or_else(|| "网页标签已关闭".into())
}

fn validate_label(owner: &str, label: &str) -> Result<(), String> {
    if !label.starts_with(&format!("{owner}-browser-")) { return Err("无效的网页标签".into()); }
    Ok(())
}

fn clear_browser_state(window: &tauri::Window, label: &str) {
    if let Ok(mut titles) = document_titles().lock() { titles.remove(label); }
    if let Ok(mut results) = load_results().lock() { results.remove(label); }
    close_browser_children(window, label);
}

// WebView2 reports DOM fullscreen but leaves host fullscreen to the application.
// Switch the owner explicitly and forward the state so the child covers its UI
// (including fullscreen requests from cross-origin video frames).
#[cfg(target_os = "windows")]
fn observe_browser_fullscreen(view: &tauri::Webview, window: tauri::Window) -> Result<(), String> {
    let label = view.label().to_string();
    view.with_webview(move |platform| unsafe {
        let result = (|| {
            let core = platform.controller().CoreWebView2()?;
            let mut token = 0;
            let mut previous_fullscreen = None;
            core.add_ContainsFullScreenElementChanged(
                &webview2_com::ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(sender) = sender {
                        let mut fullscreen = Default::default();
                        sender.ContainsFullScreenElement(&mut fullscreen)?;
                        if fullscreen.as_bool() {
                            if previous_fullscreen.is_none() {
                                match trace_browser_result(&label, "read-host-fullscreen", window.is_fullscreen()) {
                                    Ok(previous) => {
                                        if trace_browser_result(&label, "enter-host-fullscreen", window.set_fullscreen(true)).is_ok() {
                                            previous_fullscreen = Some(previous);
                                        }
                                    }
                                    Err(_) => {}
                                }
                            }
                        } else if let Some(previous) = previous_fullscreen.take() {
                            let _ = trace_browser_result(&label, "restore-host-fullscreen", window.set_fullscreen(previous));
                        }
                        let _ = trace_browser_result(&label, "emit-fullscreen", window.emit_to(
                            window.label(), &format!("browser-fullscreen-{label}"), fullscreen.as_bool(),
                        ));
                    }
                    Ok(())
                })),
                &mut token,
            )
        })();
        if let Err(error) = result {
            log::error!(target: "browser", "register fullscreen observer failed: {error}");
        }
    }).map_err(|error| error.to_string())
}

// Wry reports Finished even for failed navigations. Surface the native result
// instead of leaving the browser's dark background as the only feedback.
#[cfg(target_os = "windows")]
fn observe_browser_navigation(view: &tauri::Webview, window: tauri::Window) -> Result<(), String> {
    let label = view.label().to_string();
    view.with_webview(move |platform| unsafe {
        let result = (|| {
            let core = platform.controller().CoreWebView2()?;
            let mut token = 0;
            let latest_navigation = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let navigation_trace = std::sync::Arc::new(std::sync::Mutex::new(None::<(u64, std::time::Instant, String)>));
            let latest = latest_navigation.clone();
            let trace = navigation_trace.clone();
            let start_label = label.clone();
            let start_window = window.clone();
            core.add_NavigationStarting(
                &webview2_com::NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut id = 0; args.NavigationId(&mut id)?;
                        latest.store(id, std::sync::atomic::Ordering::Relaxed);
                        let mut uri = windows::core::PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = webview2_com::take_pwstr(uri);
                        let route = tauri::Url::parse(&uri).ok().map(|url| diagnostic_url(&url)).unwrap_or_default();
                        if let Ok(mut trace) = trace.lock() {
                            let started = trace.as_ref().filter(|entry| entry.0 == id).map(|entry| entry.1)
                                .unwrap_or_else(std::time::Instant::now);
                            *trace = Some((id, started, route));
                        }
                        clear_download_error(&start_window, &start_label);
                    }
                    Ok(())
                })), &mut token,
            )?;
            // Same-document routes (pushState/replaceState/hash and history)
            // do not trigger navigation or page-load callbacks.
            let source_window = window.clone();
            let source_label = label.clone();
            core.add_SourceChanged(
                &webview2_com::SourceChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(sender) = sender {
                        let mut source = windows::core::PWSTR::null();
                        sender.Source(&mut source)?;
                        let url = webview2_com::take_pwstr(source);
                        let _ = trace_browser_result(&source_label, "emit-source", source_window.emit_to(
                            source_window.label(), &format!("browser-url-{source_label}"), url,
                        ));
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            core.add_NavigationCompleted(
                &webview2_com::NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut success = Default::default();
                        args.IsSuccess(&mut success)?;
                        let mut status = Default::default();
                        args.WebErrorStatus(&mut status)?;
                        let mut navigation = 0;
                        args.NavigationId(&mut navigation)?;
                        let detail = navigation_trace.lock().ok().and_then(|trace| trace.as_ref()
                            .filter(|entry| entry.0 == navigation).map(|entry| (entry.1.elapsed().as_millis(), entry.2.clone())))
                            .unwrap_or_default();
                        let Some(message) = navigation_message(success.as_bool(), status.0) else {
                            log::debug!(target: "browser", "label={label} navigation={navigation} canceled elapsed_ms={} url={}", detail.0, detail.1);
                            return Ok(());
                        };
                        let success = success.as_bool();
                        let status = status.0;
                        let label = label.clone(); let window = window.clone();
                        let latest = latest_navigation.clone();
                        // DownloadStarting can arrive just after NavigationCompleted.
                        // Match the navigation ID so real redirect errors still surface.
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                            let download = super::browser_downloads::is_download(&label, navigation);
                            if download || latest.load(std::sync::atomic::Ordering::Relaxed) != navigation
                                || window.get_webview(&label).is_none() {
                                log::debug!(target: "browser", "label={label} navigation={navigation} ignored download={download}");
                                return;
                            }
                            if success {
                                log::info!(target: "browser", "label={label} navigation={navigation} navigation-completed success=true status={status} elapsed_ms={} url={}", detail.0, detail.1);
                            } else {
                                log::warn!(target: "browser", "label={label} navigation={navigation} navigation-completed success=false status={status} reason={} elapsed_ms={} url={}", navigation_status(status), detail.0, detail.1);
                            }
                            if let Ok(mut results) = load_results().lock() { results.insert(label.clone(), message.clone()); }
                            let _ = window.emit_to(window.label(), &format!("browser-load-result-{label}"), message);
                        });
                    }
                    Ok(())
                })),
                &mut token,
            )
        })();
        if let Err(error) = result {
            log::error!(target: "browser", "register navigation observer failed: {error}");
        }
    }).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_browser(window: tauri::Window, label: String, url: String, x: f64, y: f64, width: f64, height: f64, visible: bool, suppress_initial_downloads: bool) -> Result<(), String> {
    let create_started = std::time::Instant::now();
    if !label.starts_with(&format!("{}-browser-", window.label())) { return Err("无效的网页标签".into()); }
    let directory = browser_directory(window.app_handle())?;
    let owner = window.clone();
    let event = format!("browser-url-{label}");
    let app_handle = window.app_handle().clone();
    let popup_directory = directory.clone();
    let popup_owner = window.clone();
    let proxy_mode = browser_proxy_mode();
    #[cfg(target_os = "windows")]
    let browser_args = browser_args(proxy_mode);
    #[cfg(target_os = "windows")]
    let popup_browser_args = browser_args.clone();
    log::info!(target: "browser", "label={label} create url={} profile={} proxy_mode={proxy_mode} args={}", diagnostic_url(&browser_url(&url)?), directory.display(), if cfg!(windows) { "persistent-session/default-feature-overrides" } else { "default" });
    let navigation_label = label.clone();
    let load_label = label.clone();
    let title_label = label.clone();
    let initial_url = browser_url(&url)?;
    let page_load_started = std::sync::Arc::new(std::sync::Mutex::new(None::<std::time::Instant>));
    let load_clock = page_load_started.clone();
    let popup_parent_label = label.clone();
    // Start the target navigation immediately using the measured editor bounds.
    let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(initial_url))
        .initialization_script(include_str!("browser_links.js"))
        .initialization_script(include_str!("browser_gemini.js"))
        .initialization_script(include_str!("browser_video_progress.js"))
        .initialization_script(include_str!("browser_extensions.js"))
        // Match --ide-bg (#2b2d30) before the page paints to avoid a white flash.
        .background_color(tauri::webview::Color(43, 45, 48, 255))
        // Reuse the on-disk profile across tabs and application restarts. Let the
        // engine cache HTTP resources according to their normal cache headers.
        .data_directory(directory)
        .incognito(false)
        .on_document_title_changed(move |view, title| {
            if let Ok(url) = view.url() {
                if let Ok(mut titles) = document_titles().lock() {
                    titles.insert(title_label.clone(), title.clone());
                }
                let _ = trace_browser_result(&title_label, "emit-title", view.emit_to(
                    view.window().label(), &format!("browser-title-{title_label}"),
                    serde_json::json!({ "url": url.as_str(), "title": title }),
                ));
            }
        })
        .on_navigation(move |url| {
            if url.scheme() == "nexusdesk-extension" {
                if owner.get_webview(&navigation_label)
                    .and_then(|view| view.url().ok()).is_some_and(|current| current.scheme() == "https" && current.host_str() == Some("chromewebstore.google.com")) {
                    if let Some((_, source)) = url.query_pairs().find(|(key, _)| key == "source") {
                        // Only store detail links can cross this page bridge.
                        if tauri::Url::parse(&source).is_ok_and(|source| source.scheme() == "https" && source.host_str() == Some("chromewebstore.google.com") && source.path().starts_with("/detail/")) {
                            let window = owner.clone(); let label = navigation_label.clone(); let source = source.into_owned();
                            tauri::async_runtime::spawn(async move {
                                let _ = super::browser_extensions::browser_install_extension(window, label, source).await;
                            });
                        }
                    }
                }
                return false;
            }
            if super::browser_passwords::password_navigation(owner.get_webview(&navigation_label), url) { return false; }
            log::info!(target: "browser", "label={navigation_label} navigation url={} allowed={}", diagnostic_url(url), allowed_browser_url(url));
            if !allowed_browser_url(url) { return false; }
            let _ = trace_browser_result(&navigation_label, "emit-navigation", owner.emit_to(owner.label(), &event, url.as_str()));
            true
        })
        .on_page_load(move |view, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if let Ok(mut started) = load_clock.lock() { *started = Some(std::time::Instant::now()); }
                if let Ok(mut results) = load_results().lock() { results.remove(&load_label); }
                let _ = view.emit_to(view.window().label(), &format!("browser-load-result-{load_label}"), "");
            }
            let load_elapsed_ms = if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                page_load_started.lock().ok().and_then(|mut started| started.take()).map(|started| started.elapsed().as_millis())
            } else { None };
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                // Google can replace its route without another navigation callback.
                let _ = view.emit_to(view.window().label(), &format!("browser-url-{load_label}"), payload.url().as_str());
                let _ = view.emit_to(view.window().label(), &format!("browser-document-ready-{load_label}"), ());
                super::browser_passwords::fill(&view, payload.url());
            }
            log::info!(target: "browser", "label={load_label} page-load event={:?} elapsed_ms={load_elapsed_ms:?} url={}", payload.event(), diagnostic_url(payload.url()));
        })
        .on_new_window(move |url, features| {
            log::info!(target: "browser", "label={popup_parent_label} popup-request url={} allowed={}", diagnostic_url(&url), allowed_browser_url(&url));
            if !allowed_browser_url(&url) {
                return tauri::webview::NewWindowResponse::Deny;
            }
            if !needs_native_popup(&url, features.size().is_some() || features.position().is_some()) {
                let _ = trace_browser_result(&label, "emit-new-tab", popup_owner.emit_to(
                    popup_owner.label(), &format!("browser-new-tab-{popup_parent_label}"), url.as_str(),
                ));
                return tauri::webview::NewWindowResponse::Deny;
            }
            let popup_label = format!(
                "{}-popup-{}",
                popup_parent_label,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_nanos())
                    .unwrap_or_default()
            );
            let builder = tauri::WebviewWindowBuilder::new(
                &app_handle,
                popup_label.clone(),
                // WebView2 supplies the requested URL when NewWindowResponse is
                // returned. Navigating here starts a competing download before
                // its observer exists, especially for small/cacheable files.
                tauri::WebviewUrl::External(tauri::Url::parse("about:blank").unwrap()),
            )
            .window_features(features)
            .data_directory(popup_directory.clone())
            .incognito(false)
            .on_navigation({
                let label = popup_label.clone();
                let app = app_handle.clone();
                move |url| {
                    if super::browser_passwords::password_navigation(app.get_webview(&label), url) { return false; }
                    log::info!(target: "browser", "label={label} popup-navigation url={}", diagnostic_url(url));
                    true
                }
            })
            .on_page_load({
                let label = popup_label.clone();
                move |view, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        if let Some(webview) = view.app_handle().get_webview(view.label()) {
                            super::browser_passwords::fill(&webview, payload.url());
                        }
                    }
                    log::info!(target: "browser", "label={label} popup-page-load event={:?} url={}", payload.event(), diagnostic_url(payload.url()));
                }
            })
            .title("网页授权");
            #[cfg(target_os = "windows")]
            let builder = builder.additional_browser_args(&popup_browser_args).browser_extensions_enabled(true);
            match builder.build() {
                Ok(window) => {
                    #[cfg(windows)]
                    if let Some(view) = app_handle.get_webview(&popup_label) {
                        let _ = super::browser_downloads::observe(&view, popup_owner.clone(), popup_parent_label.clone(), suppress_initial_downloads);
                    }
                    log::info!(target: "browser", "label={popup_label} popup-created parent={label}");
                    let event_label = popup_label.clone();
                    let parent_window = popup_owner.clone();
                    window.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            close_browser_children(&parent_window, &event_label);
                        }
                        log::info!(target: "browser", "label={event_label} popup-window event={event:?}");
                    });
                    tauri::webview::NewWindowResponse::Create { window }
                },
                Err(error) => {
                    log::error!(target: "browser", "label={popup_label} popup-create failed: {error}");
                    tauri::webview::NewWindowResponse::Deny
                },
            }
        });
    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args(&browser_args).browser_extensions_enabled(true);
    let (position, size) = (tauri::LogicalPosition::new(x, y), tauri::LogicalSize::new(width.max(1.), height.max(1.)));
    let view = trace_browser_result("new-child", "add-child", window.add_child(builder, position, size))?;
    #[cfg(target_os = "windows")]
    observe_browser_fullscreen(&view, window.clone())?;
    #[cfg(target_os = "windows")]
    observe_browser_navigation(&view, window.clone())?;
    #[cfg(target_os = "windows")]
    super::browser_downloads::observe(&view, window.clone(), view.label().into(), suppress_initial_downloads)?;
    #[cfg(target_os = "windows")]
    if let Err(error) = install_browser_blackhole(&view) {
        log::warn!(target: "browser", "optional resource filter failed: {error}");
    }
    log::info!(target: "browser", "label={} child-created elapsed_ms={} visible={visible}", view.label(), create_started.elapsed().as_millis());
    if !visible { trace_browser_result(view.label(), "initial-hide", view.hide())?; }
    Ok(())
}

// Narrow native filters avoid a COM roundtrip for every image/script. Do not
// block documents, authentication, generic CDN hosts or application APIs.
#[cfg(target_os = "windows")]
fn install_browser_blackhole(view: &tauri::Webview) -> Result<(), String> {
    view.with_webview(|platform| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        let result: windows::core::Result<()> = (|| {
            let core = platform.controller().CoreWebView2()?;
            let environment = platform.environment();
            let mut token = 0;
            core.add_WebResourceRequested(
                &webview2_com::WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                        args.ResourceContext(&mut context)?;
                        if context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT { return Ok(()); }
                        let request = args.Request()?;
                        let mut uri = windows::core::PWSTR::null();
                        request.Uri(&mut uri)?;
                        let uri = webview2_com::take_pwstr(uri);
                        if let Ok(url) = tauri::Url::parse(&uri) {
                            if matches!(url.host_str(), Some("www.google-analytics.com" | "www.googletagmanager.com" | "hm.baidu.com")) {
                                let response = environment.CreateWebResourceResponse(
                                    None::<&windows::Win32::System::Com::IStream>, 204,
                                    windows::core::w!("No Content"),
                                    windows::core::w!("Cache-Control: no-store\r\n"),
                                )?;
                                args.SetResponse(&response)?;
                            }
                        }
                    }
                    Ok(())
                })), &mut token,
            )?;
            for pattern in ["https://www.google-analytics.com/*", "https://www.googletagmanager.com/*", "https://hm.baidu.com/*"] {
                let pattern = windows::core::HSTRING::from(pattern);
                core.AddWebResourceRequestedFilter(&pattern, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
            }
            Ok(())
        })();
        if let Err(error) = result { log::warn!(target: "browser", "resource filter unavailable: {error}"); }
    }).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_layout(window: tauri::Window, label: String, x: f64, y: f64, width: f64, height: f64, visible: bool, reason: Option<String>, document_hidden: Option<bool>) -> Result<(), String> {
    validate_label(window.label(), &label)?;
    // A queued resize/hide can arrive after close. Treat it as an expired task.
    let Some(view) = window.get_webview(&label) else { return Ok(()); };
    log::info!(target: "browser", "label={label} layout x={x} y={y} width={width} height={height} visible={visible} reason={} document-hidden={document_hidden:?}", reason.as_deref().unwrap_or("unspecified"));
    if visible && width > 0. && height > 0. {
        trace_browser_result(&label, "set-bounds", view.set_bounds(tauri::Rect { position: tauri::LogicalPosition::new(x, y).into(), size: tauri::LogicalSize::new(width, height).into() }))?;
        trace_browser_result(&label, "show", view.show())
    } else {
        if width > 1. && height > 1. {
            trace_browser_result(&label, "hidden-bounds", view.set_bounds(tauri::Rect { position: tauri::LogicalPosition::new(x, y).into(), size: tauri::LogicalSize::new(width, height).into() }))?;
        }
        trace_browser_result(&label, "hide", view.hide())
    }
}

#[tauri::command]
pub fn browser_action(window: tauri::Window, label: String, action: String, url: Option<String>) -> Result<(), String> {
    validate_label(window.label(), &label)?;
    if action == "close" {
        clear_browser_state(&window, &label);
        return match window.get_webview(&label) {
            Some(view) => trace_browser_result(&label, "close", view.close()),
            None => Ok(()),
        };
    }
    log::info!(target: "browser", "label={label} action={action} url={}", url.as_deref().and_then(|value| tauri::Url::parse(value).ok()).map(|url| diagnostic_url(&url)).unwrap_or_default());
    let view = trace_browser_result(&label, "action-lookup", child(&window, &label))?;
    #[cfg(target_os = "windows")]
    if matches!(action.as_str(), "navigate" | "reload") {
        // Stop pending logout/redirect requests before starting another load.
        view.with_webview(|platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() { let _ = core.Stop(); }
        }).map_err(|error| error.to_string())?;
    }
    let result = match action.as_str() {
        "navigate" => view.navigate(browser_url(url.as_deref().unwrap_or(""))?),
        "sync" => {
            let url = view.url().map_err(|e| e.to_string())?;
            super::browser_passwords::fill(&view, &url);
            window.emit_to(window.label(), &format!("browser-url-{label}"), url.as_str()).map_err(|e| e.to_string())?;
            let cached_title = document_titles().lock().ok().and_then(|titles| titles.get(&label).cloned());
            if let Some(title) = cached_title {
                window.emit_to(window.label(), &format!("browser-title-{label}"),
                    serde_json::json!({ "url": url.as_str(), "title": title })).map_err(|e| e.to_string())?;
            }
            if let Ok(results) = load_results().lock() {
                if let Some(message) = results.get(&label) {
                    window.emit_to(window.label(), &format!("browser-load-result-{label}"), message).map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        },
        "focus-host" => window.get_webview(window.label()).ok_or_else(|| "Host webview unavailable".to_string())?.set_focus(),
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        "autofill" => {
            super::browser_passwords::fill(&view, &view.url().map_err(|e| e.to_string())?);
            Ok(())
        },
        _ => return Err("未知浏览器操作".into()),
    };
    trace_browser_result(&label, &action, result)
}

#[tauri::command]
pub async fn browser_can_go(window: tauri::Window, label: String, forward: bool) -> Result<bool, String> {
    let view = child(&window, &label)?;
    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        view.with_webview(move |platform| unsafe {
            let result = (|| {
                let core = platform.controller().CoreWebView2()?;
                let mut available = Default::default();
                if forward { core.CanGoForward(&mut available)?; } else { core.CanGoBack(&mut available)?; }
                Ok::<bool, windows::core::Error>(available.as_bool())
            })();
            let _ = tx.send(result.map_err(|e| e.to_string()));
        }).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (view, forward); Ok(false) }
}
