use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

const MENU_LABEL: &str = "nexusdesk-native-menu";

#[derive(Clone)]
struct MenuSession {
    owner: String,
    request: String,
    width: f64,
    scale: f64,
    passive: bool,
}

type MenuSessionState = Arc<Mutex<Option<MenuSession>>>;

fn dismiss_owner_menu(app: &tauri::AppHandle, owner: &str) {
    let state = app.state::<MenuSessionState>();
    let current = {
        let Ok(mut session) = state.lock() else { return; };
        if session.as_ref().is_some_and(|session| session.owner == owner) {
            session.take()
        } else { None }
    };
    if let Some(current) = current {
        if let Some(popup) = app.get_webview_window(MENU_LABEL) { let _ = hide_menu_window(&popup); }
        let _ = app.emit_to(&current.owner, "native-menu-closed", &current.request);
    }
}

#[tauri::command]
pub fn native_menu_close(window: tauri::Window, request: Option<String>) {
    if let Some(request) = request {
        let state = window.state::<MenuSessionState>();
        if !state.lock().ok().is_some_and(|state| state.as_ref().is_some_and(|session| session.request == request)) { return; }
    }
    dismiss_owner_menu(window.app_handle(), window.label());
}

// WebView2 can move native focus before delivering pointerdown to the popup.
// Keep the owner's action listener mounted while that click is in flight.
#[tauri::command]
pub fn native_menu_contains_pointer(window: tauri::Window) -> bool {
    let app = window.app_handle();
    let state = app.state::<MenuSessionState>();
    let owned_suggestions = state.lock().ok().is_some_and(|state| {
        state.as_ref().is_some_and(|session| session.owner == window.label() && session.passive)
    });
    if !owned_suggestions { return false; }
    let Some(popup) = app.get_webview_window(MENU_LABEL) else { return false; };
    let (Ok(pointer), Ok(origin), Ok(size)) = (app.cursor_position(), popup.outer_position(), popup.outer_size()) else { return false; };
    pointer.x >= origin.x as f64 && pointer.y >= origin.y as f64
        && pointer.x < origin.x as f64 + size.width as f64
        && pointer.y < origin.y as f64 + size.height as f64
}

#[cfg(target_os = "windows")]
fn disable_window_transitions(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut std::ffi::c_void,
            attribute: u32,
            value: *const std::ffi::c_void,
            size: u32,
        ) -> i32;
    }
    if let Ok(handle) = window.window_handle() {
        if let RawWindowHandle::Win32(handle) = handle.as_raw() {
            const DWMWA_TRANSITIONS_FORCEDISABLED: u32 = 3;
            let disabled: i32 = 1;
            unsafe {
                DwmSetWindowAttribute(
                    handle.hwnd.get() as *mut std::ffi::c_void,
                    DWMWA_TRANSITIONS_FORCEDISABLED,
                    &disabled as *const i32 as *const std::ffi::c_void,
                    std::mem::size_of_val(&disabled) as u32,
                );
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn disable_window_transitions(_: &tauri::WebviewWindow) {}

// Tauri/tao's normal show() uses SW_SHOW after window creation, even when
// the window was built with focused(false). That activates the suggestion
// popup, blurs the address field, closes the popup, and can refocus/reopen it.
#[cfg(target_os = "windows")]
fn set_passive_menu_visible(popup: &tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    #[link(name = "user32")]
    unsafe extern "system" {
        fn ShowWindowAsync(hwnd: *mut std::ffi::c_void, command: i32) -> i32;
    }
    let handle = popup.window_handle().map_err(|error| error.to_string())?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else { return Err("Expected a Win32 popup".into()); };
    const SW_SHOWNOACTIVATE: i32 = 4;
    const SW_HIDE: i32 = 0;
    let command = if visible { SW_SHOWNOACTIVATE } else { SW_HIDE };
    // The return value describes the previous visibility, not success. Zero
    // is expected when opening a previously hidden suggestion window.
    unsafe { ShowWindowAsync(handle.hwnd.get() as *mut std::ffi::c_void, command); }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_passive_menu_visible(popup: &tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    (if visible { popup.show() } else { popup.hide() }).map_err(|error| error.to_string())
}

fn hide_menu_window(popup: &tauri::WebviewWindow) -> Result<(), String> {
    // Keep tao's visibility state in sync for ordinary menus, and also hide
    // passive windows that were shown directly without activation.
    popup.hide().map_err(|error| error.to_string())?;
    set_passive_menu_visible(popup, false)
}

#[cfg(target_os = "windows")]
fn watch_application_focus(app: &tauri::AppHandle, session: MenuSessionState) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> *mut std::ffi::c_void;
        fn GetWindowThreadProcessId(hwnd: *mut std::ffi::c_void, process: *mut u32) -> u32;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let current = session.lock().ok().and_then(|state| state.clone());
        let Some(current) = current else { continue; };
        let mut process = 0;
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.is_null() { continue; }
            GetWindowThreadProcessId(foreground, &mut process);
        }
        if process == 0 || process == std::process::id() { continue; }
        let dismiss_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            // A queued check must never dismiss a newer menu session.
            let state = dismiss_app.state::<MenuSessionState>();
            let matches = state.lock().ok().is_some_and(|state| {
                state.as_ref().is_some_and(|session| session.request == current.request)
            });
            if matches { dismiss_owner_menu(&dismiss_app, &current.owner); }
        });
    });
}

fn create_menu_window(app: &tauri::AppHandle, session: MenuSessionState) -> tauri::Result<()> {
    let events = session.clone();
    let navigation_app = app.clone();
    let popup = tauri::WebviewWindowBuilder::new(
        app,
        MENU_LABEL,
        tauri::WebviewUrl::App("src/native-menu.html".into()),
    )
    .title("NexusDesk menu")
    .data_directory(crate::profiles::data_directory(app))
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .initialization_script("window.__setMenu = (...args) => { window.__pendingMenu = args; };")
    .on_navigation(move |url| {
        let app = &navigation_app;
        if url.scheme() != "nexusdesk-menu" {
            return url.scheme() == "tauri" || url.scheme() == "http" || url.scheme() == "https";
        }
        let current = events.lock().ok().and_then(|state| state.clone());
        if let Some(current) = current {
            let request = url.query_pairs().find(|(key, _)| key == "request").map(|(_, value)| value.into_owned());
            if request.as_deref() != Some(current.request.as_str()) { return false; }
            if matches!(url.host_str(), Some("resize" | "ready")) {
                // Address suggestions are measured by their owner before opening.
                // Resizing from this webview's content creates a viewport/observer
                // feedback loop (notably at fractional display scaling).
                if current.passive {
                    if url.host_str() == Some("ready") {
                        if let Some(popup) = app.get_webview_window(MENU_LABEL) {
                            if !popup.is_visible().unwrap_or(false) {
                                if let Err(error) = set_passive_menu_visible(&popup, true) { log::error!("Cannot show browser suggestions: {error}"); }
                            }
                        }
                    }
                    return false;
                }
                if let Ok(height) = url.path().trim_start_matches('/').parse::<f64>() {
                    if let Some(popup) = app.get_webview_window(MENU_LABEL) {
                        let mut height = height.clamp(10.0, 600.0) * current.scale;
                        if let (Ok(position), Ok(Some(monitor))) = (popup.outer_position(), popup.current_monitor()) {
                            let area = monitor.work_area();
                            height = height.min(area.size.height as f64);
                            let y = (position.y as f64).min(area.position.y as f64 + area.size.height as f64 - height).max(area.position.y as f64);
                            if position.y != y as i32 { let _ = popup.set_position(tauri::PhysicalPosition::new(position.x, y as i32)); }
                        }
                        let size = tauri::PhysicalSize::new(current.width as u32, height.ceil() as u32);
                        if popup.inner_size().ok() != Some(size) { let _ = popup.set_size(size); }
                        if url.host_str() == Some("ready") {
                            if !popup.is_visible().unwrap_or(false) { let _ = popup.show(); }
                            if !current.passive { let _ = popup.set_focus(); }
                        }
                    }
                }
                return false;
            }
            let id = url.path().trim_start_matches('/');
            let value = url.query_pairs().find(|(key, _)| key == "value").map(|(_, value)| value.into_owned());
            let _ = app.emit_to(&current.owner, "native-menu-action", serde_json::json!({"request": current.request, "id": id, "value": value}));
            // Deletion updates the existing suggestion session, without hiding
            // its window or dismissing the owner's action listeners.
            if current.passive && id == "browser-history-remove" { return false; }
            if let Ok(mut state) = events.lock() { *state = None; }
            if let Some(popup) = app.get_webview_window(MENU_LABEL) { let _ = hide_menu_window(&popup); }
            let _ = app.emit_to(&current.owner, "native-menu-closed", &current.request);
        }
        false
    })
    .build()?;
    disable_window_transitions(&popup);
    let focus_session = session;
    let dismiss = popup.clone();
    popup.on_window_event(move |event| {
        let popup = &dismiss;
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            let current = focus_session.lock().ok().and_then(|state| state.clone());
            if let Some(current) = current.filter(|session| !session.passive) {
                if let Ok(mut state) = focus_session.lock() { *state = None; }
                let _ = hide_menu_window(&popup);
                let _ = popup.emit_to(&current.owner, "native-menu-closed", &current.request);
            }
        }
    });
    Ok(())
}

pub fn warmup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let session: MenuSessionState = Arc::new(Mutex::new(None));
    app.manage(session.clone());
    create_menu_window(app, session.clone())?;
    #[cfg(target_os = "windows")]
    watch_application_focus(app, session);
    // A hidden utility window must not keep the process alive after the last owner closes.
    for (label, window) in app.webview_windows() {
        if label == MENU_LABEL { continue; }
        let app = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Destroyed) {
                dismiss_owner_menu(&app, &label);
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn native_menu_open(
    window: tauri::Window,
    request: String,
    html: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    passive: Option<bool>,
) -> Result<(), String> {
    let app = window.app_handle();
    let popup = app.get_webview_window(MENU_LABEL).ok_or("Menu window is not initialized")?;
    let session = app.state::<MenuSessionState>().inner().clone();
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let passive = passive.unwrap_or(false);
    let updating = session.lock().map_err(|e| e.to_string())?.as_ref().is_some_and(|current| current.request == request);
    if !updating {
        hide_menu_window(&popup)?;
        popup.set_focusable(!passive).map_err(|e| e.to_string())?;
    }
    if let Some(previous) = session.lock().map_err(|e| e.to_string())?.take() {
        if previous.request != request { let _ = app.emit_to(&previous.owner, "native-menu-closed", &previous.request); }
    }
    *session.lock().map_err(|e| e.to_string())? = Some(MenuSession { owner: window.label().into(), request: request.clone(), width, scale, passive });
    let monitor = app.monitor_from_point(x, y).map_err(|e| e.to_string())?;
    let mut px = x;
    let mut py = y;
    let mut physical_height = height.clamp(10.0, 600.0) * scale;
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        physical_height = physical_height.min(area.size.height as f64);
        px = px.min(area.position.x as f64 + area.size.width as f64 - width).max(area.position.x as f64);
        py = py.min(area.position.y as f64 + area.size.height as f64 - physical_height).max(area.position.y as f64);
    }
    let payload = serde_json::to_string(&html).map_err(|e| e.to_string())?;
    let size = tauri::PhysicalSize::new(width as u32, physical_height.ceil() as u32);
    if popup.inner_size().ok() != Some(size) { popup.set_size(size).map_err(|e| e.to_string())?; }
    let position = tauri::PhysicalPosition::new(px as i32, py as i32);
    if popup.outer_position().ok() != Some(position) { popup.set_position(position).map_err(|e| e.to_string())?; }
    popup.eval(&format!("window.__setMenu({payload},{},{passive})", serde_json::to_string(&request).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
    Ok(())
}
