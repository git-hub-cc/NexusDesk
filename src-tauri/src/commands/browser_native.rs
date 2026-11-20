use std::collections::HashSet;
use tauri::{Webview, Window};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
use windows_sys::Win32::{
    Foundation::{HWND, POINT, RECT},
    UI::WindowsAndMessaging::{
        DestroyWindow, GW_CHILD, GW_HWNDNEXT, GWL_STYLE, GetClassNameW, GetWindow, GetWindowLongW,
        GetWindowRect, HWND_TOP, IsChild, IsWindow, IsWindowVisible, SW_HIDE, SW_SHOWNOACTIVATE,
        SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos, ShowWindow, WS_VISIBLE, WindowFromPoint,
    },
};

const PARKED_X: i32 = -32;
const PARKED_Y: i32 = -32;

fn child_containers(parent: HWND) -> HashSet<HWND> {
    let mut result = HashSet::new();
    unsafe {
        let mut child = GetWindow(parent, GW_CHILD);
        let mut class_name = [0; 32];
        while !child.is_null() {
            let length = GetClassNameW(child, class_name.as_mut_ptr(), class_name.len() as i32);
            if length > 0
                && String::from_utf16_lossy(&class_name[..length as usize]) == "WRY_WEBVIEW"
            {
                result.insert(child);
            }
            child = GetWindow(child, GW_HWNDNEXT);
        }
    }
    result
}

pub(super) fn add_child(
    window: &Window,
    label: &str,
    builder: tauri::webview::WebviewBuilder<tauri::Wry>,
) -> Result<Webview, String> {
    let parent = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
    let before = child_containers(parent);
    // Wry 创建容器后才初始化 WebView2。初始化期间先把容器放到客户区外。
    let result = window.add_child(
        builder,
        tauri::PhysicalPosition::new(PARKED_X, PARKED_Y),
        tauri::PhysicalSize::new(1, 1),
    );
    match result {
        Ok(view) => {
            if let Err(error) = hide(&view) {
                let _ = view.close();
                return Err(error);
            }
            Ok(view)
        }
        Err(error) => {
            // 调用方串行创建子视图。只清理本次失败时新增的直接子容器。
            for &hwnd in child_containers(parent).difference(&before) {
                let removed = unsafe {
                    ShowWindow(hwnd, SW_HIDE);
                    DestroyWindow(hwnd) != 0 && IsWindow(hwnd) == 0
                };
                if removed {
                    log::info!(target: "browser", "label={label} rolled back native container hwnd={hwnd:p}");
                } else {
                    log::error!(target: "browser", "label={label} could not destroy native container hwnd={hwnd:p}: {}", std::io::Error::last_os_error());
                }
            }
            Err(error.to_string())
        }
    }
}

fn with_controller(
    view: &Webview,
    apply: impl FnOnce(ICoreWebView2Controller, HWND) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    // 调用方已在窗口线程，Tauri 会在当前线程内执行回调。
    let (send, receive) = std::sync::mpsc::channel();
    view.with_webview(move |platform| {
        let controller = platform.controller();
        let mut hwnd = Default::default();
        let result = unsafe { controller.ParentWindow(&mut hwnd) }
            .map_err(|error| error.to_string())
            .and_then(|_| apply(controller, hwnd.0 as HWND));
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    receive.try_recv().map_err(|error| error.to_string())?
}

pub(super) fn hide(view: &Webview) -> Result<(), String> {
    let label = view.label().to_owned();
    with_controller(view, move |controller, hwnd| unsafe {
        let mut before = std::mem::zeroed::<RECT>();
        let was_visible = IsWindowVisible(hwnd) != 0 && GetWindowRect(hwnd, &mut before) != 0;
        ShowWindow(hwnd, SW_HIDE);
        let controller_result = controller.SetIsVisible(false);
        let parked = SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            PARKED_X,
            PARKED_Y,
            1,
            1,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
        if parked == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_VISIBLE != 0 {
            return Err("原生浏览器子窗口仍处于可见状态".into());
        }
        controller_result.map_err(|error| error.to_string())?;
        if was_visible {
            let point = POINT {
                x: (before.left + before.right) / 2,
                y: (before.top + before.bottom) / 2,
            };
            let hit = WindowFromPoint(point);
            let still_hits = hit == hwnd || IsChild(hwnd, hit) != 0;
            log::info!(target: "browser", "label={label} hidden hwnd={hwnd:p} previous_rect=({},{},{},{}) hit_hwnd={hit:p} still_hits={still_hits}", before.left, before.top, before.right, before.bottom);
            if still_hits {
                return Err("鼠标仍命中已隐藏的浏览器子窗口".into());
            }
        }
        Ok(())
    })
}

pub(super) fn show(
    view: &Webview,
    bounds: tauri::Rect,
    scale: f64,
    fullscreen: bool,
) -> Result<(), String> {
    let position = bounds.position.to_physical::<i32>(scale);
    let size = bounds.size.to_physical::<i32>(scale);
    with_controller(view, move |controller, hwnd| unsafe {
        controller
            .SetBounds(windows::Win32::Foundation::RECT {
                left: 0,
                top: 0,
                right: size.width,
                bottom: size.height,
            })
            .map_err(|error| error.to_string())?;
        let flags = SWP_NOACTIVATE | if fullscreen { 0 } else { SWP_NOZORDER };
        if SetWindowPos(
            hwnd,
            HWND_TOP,
            position.x,
            position.y,
            size.width,
            size.height,
            flags,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        controller
            .SetIsVisible(true)
            .map_err(|error| error.to_string())?;
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        Ok(())
    })
}
