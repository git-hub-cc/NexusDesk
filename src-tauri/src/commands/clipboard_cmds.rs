use std::sync::{Mutex, OnceLock};

static PASTE_TARGET: OnceLock<Mutex<Option<isize>>> = OnceLock::new();

pub fn remember_foreground_window() -> bool {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetForegroundWindow() -> *mut std::ffi::c_void;
            fn GetWindowThreadProcessId(window: *mut std::ffi::c_void, process_id: *mut u32)
            -> u32;
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcessId() -> u32;
        }
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return false;
        }
        let mut process_id = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut process_id);
        }
        if process_id == unsafe { GetCurrentProcessId() } {
            return false;
        }
        let hwnd = hwnd as isize;
        if let Ok(mut target) = PASTE_TARGET.get_or_init(|| Mutex::new(None)).lock() {
            *target = (hwnd != 0).then_some(hwnd);
        }
        return true;
    }
    #[cfg(not(windows))]
    false
}

#[tauri::command]
pub fn write_text_clipboard(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| error.to_string())
}

/// 将文本写入系统剪贴板，并粘贴到前台应用。
#[tauri::command]
pub fn paste_text(
    window: tauri::Window,
    text: String,
    request_id: Option<String>,
) -> Result<(), String> {
    let request_id = request_id.as_deref().unwrap_or("unknown");
    let mut hash = 2166136261u32;
    for byte in text.as_bytes() {
        hash = hash.wrapping_mul(16777619) ^ u32::from(*byte);
    }
    log::info!(target: "speech", "paste-start request_id={request_id} text_length={} text_hash={hash:08x} window={}", text.len(), window.label());
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text.clone()))
        .map_err(|error| error.to_string())?;

    #[cfg(windows)]
    {
        use std::{thread, time::Duration};
        #[link(name = "user32")]
        unsafe extern "system" {
            fn SetForegroundWindow(window: *mut std::ffi::c_void) -> i32;
            fn GetForegroundWindow() -> *mut std::ffi::c_void;
            fn IsWindow(window: *mut std::ffi::c_void) -> i32;
            fn GetWindowThreadProcessId(window: *mut std::ffi::c_void, process_id: *mut u32)
            -> u32;
            fn AttachThreadInput(id_attach: u32, id_attach_to: u32, attach: i32) -> i32;
            fn SendInput(c_inputs: u32, p_inputs: *mut INPUT, cb_size: i32) -> u32;
            fn GetAsyncKeyState(key: i32) -> i16;
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentThreadId() -> u32;
            fn GetCurrentProcessId() -> u32;
        }
        #[repr(C)]
        struct INPUT {
            type_: u32,
            u: INPUT_UNION,
        }
        #[repr(C)]
        union INPUT_UNION {
            mi: MOUSEINPUT,
            ki: KEYBDINPUT,
            hi: HARDWAREINPUT,
        }
        #[repr(C)]
        #[derive(Copy, Clone)]
        struct MOUSEINPUT {
            dx: i32,
            dy: i32,
            mouse_data: u32,
            dw_flags: u32,
            time: u32,
            dw_extra_info: usize,
        }
        #[repr(C)]
        #[derive(Copy, Clone)]
        struct KEYBDINPUT {
            w_vk: u16,
            w_scan: u16,
            dw_flags: u32,
            time: u32,
            dw_extra_info: usize,
        }
        #[repr(C)]
        #[derive(Copy, Clone)]
        struct HARDWAREINPUT {
            u_msg: u32,
            w_param_l: u16,
            w_param_h: u16,
        }

        const INPUT_KEYBOARD: u32 = 1;
        const KEYEVENTF_KEYUP: u32 = 0x0002;
        const VK_CONTROL: u16 = 0x11;
        const VK_V: u16 = 0x56;

        let remembered_target = PASTE_TARGET
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "无法读取外部应用窗口")?
            .to_owned();
        let foreground = unsafe { GetForegroundWindow() };
        let target = if !foreground.is_null() {
            let mut process_id = 0;
            unsafe {
                GetWindowThreadProcessId(foreground, &mut process_id);
            }
            if process_id != unsafe { GetCurrentProcessId() } {
                Some(foreground as isize)
            } else if window.label() == "nexusdesk-speech" {
                remembered_target
            } else {
                Some(foreground as isize)
            }
        } else {
            remembered_target
        };
        let target = target.ok_or("未找到外部应用窗口，请先切换到目标软件或按 Ctrl+Alt+空格")?;
        unsafe {
            let hwnd = target as *mut std::ffi::c_void;
            if IsWindow(hwnd) == 0 {
                return Err("外部应用窗口已关闭，请重新按 Ctrl+Alt+空格".into());
            }
        }
        unsafe {
            let hwnd = target as *mut std::ffi::c_void;
            let target_thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
            let current_thread = GetCurrentThreadId();
            if target_thread != current_thread {
                AttachThreadInput(current_thread, target_thread, 1);
                SetForegroundWindow(hwnd);
                AttachThreadInput(current_thread, target_thread, 0);
            } else {
                SetForegroundWindow(hwnd);
            }

            let mut retries = 10;
            while retries > 0 && GetForegroundWindow() != hwnd {
                thread::sleep(Duration::from_millis(10));
                retries -= 1;
            }
            if GetForegroundWindow() != hwnd {
                return Err("无法切回记录的外部应用窗口，请重新按 Ctrl+Alt+空格".into());
            }
        }

        // 等待用户松开快捷键，避免 Ctrl+Alt/Shift 将粘贴变成其它命令。
        let modifiers = [0x10, 0x11, 0x12, 0x5b, 0x5c];
        let mut released = false;
        for _ in 0..100 {
            if modifiers
                .iter()
                .all(|key| unsafe { GetAsyncKeyState(*key) } >= 0)
            {
                released = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        if !released {
            return Err("请松开 Ctrl、Alt、Shift 和 Windows 键后继续语音输入".into());
        }
        // 等待期间用户可能切换窗口，此时停止本次粘贴。
        if unsafe { GetForegroundWindow() } != target as *mut std::ffi::c_void {
            return Err("输入窗口已切换，请在目标输入框重新开始语音输入".into());
        }

        unsafe {
            let mut inputs = [
                INPUT {
                    type_: INPUT_KEYBOARD,
                    u: INPUT_UNION {
                        ki: KEYBDINPUT {
                            w_vk: VK_CONTROL,
                            w_scan: 0,
                            dw_flags: 0,
                            time: 0,
                            dw_extra_info: 0,
                        },
                    },
                },
                INPUT {
                    type_: INPUT_KEYBOARD,
                    u: INPUT_UNION {
                        ki: KEYBDINPUT {
                            w_vk: VK_V,
                            w_scan: 0,
                            dw_flags: 0,
                            time: 0,
                            dw_extra_info: 0,
                        },
                    },
                },
                INPUT {
                    type_: INPUT_KEYBOARD,
                    u: INPUT_UNION {
                        ki: KEYBDINPUT {
                            w_vk: VK_V,
                            w_scan: 0,
                            dw_flags: KEYEVENTF_KEYUP,
                            time: 0,
                            dw_extra_info: 0,
                        },
                    },
                },
                INPUT {
                    type_: INPUT_KEYBOARD,
                    u: INPUT_UNION {
                        ki: KEYBDINPUT {
                            w_vk: VK_CONTROL,
                            w_scan: 0,
                            dw_flags: KEYEVENTF_KEYUP,
                            time: 0,
                            dw_extra_info: 0,
                        },
                    },
                },
            ];
            if SendInput(4, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) != 4 {
                return Err("无法向外部应用发送粘贴快捷键".into());
            }
        }
    }
    #[cfg(not(windows))]
    return Err("当前系统暂不支持跨应用自动粘贴，文本已复制到剪贴板".into());
    #[cfg(windows)]
    log::info!(target: "speech", "paste-complete request_id={request_id} text_length={} text_hash={hash:08x}", text.len());
    Ok(())
}

#[tauri::command]
pub fn read_text_clipboard() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(serde::Serialize)]
pub struct FileClipboard {
    sequence: u32,
    paths: Vec<String>,
    cut: bool,
}

#[tauri::command]
pub fn read_file_clipboard() -> Result<FileClipboard, String> {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "user32")]
        unsafe extern "system" {
            fn OpenClipboard(owner: *mut c_void) -> i32;
            fn CloseClipboard() -> i32;
            fn GetClipboardData(format: u32) -> *mut c_void;
            fn RegisterClipboardFormatW(name: *const u16) -> u32;
            fn GetClipboardSequenceNumber() -> u32;
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GlobalLock(memory: *mut c_void) -> *mut c_void;
            fn GlobalUnlock(memory: *mut c_void) -> i32;
            fn GlobalSize(memory: *mut c_void) -> usize;
        }
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn DragQueryFileW(drop: *mut c_void, index: u32, buffer: *mut u16, size: u32) -> u32;
        }
        struct ClipboardGuard;
        impl Drop for ClipboardGuard {
            fn drop(&mut self) {
                unsafe {
                    CloseClipboard();
                }
            }
        }
        // CF_HDROP contains the complete paths copied by Windows Explorer.
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return Err("系统剪贴板正忙，请重试。".into());
            }
            let _guard = ClipboardGuard;
            let sequence = GetClipboardSequenceNumber();
            let drop = GetClipboardData(15);
            let mut paths = Vec::new();
            if !drop.is_null() {
                let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
                for index in 0..count {
                    let length = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
                    let mut buffer = vec![0u16; length as usize + 1];
                    let read =
                        DragQueryFileW(drop, index, buffer.as_mut_ptr(), buffer.len() as u32);
                    paths.push(String::from_utf16_lossy(&buffer[..read as usize]));
                }
            }
            let name: Vec<u16> = "Preferred DropEffect"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let format = RegisterClipboardFormatW(name.as_ptr());
            let effect = if format == 0 {
                std::ptr::null_mut()
            } else {
                GetClipboardData(format)
            };
            let mut cut = false;
            if !effect.is_null() && GlobalSize(effect) >= 4 {
                let data = GlobalLock(effect);
                if !data.is_null() {
                    cut = std::ptr::read_unaligned(data as *const u32) & 2 != 0;
                    GlobalUnlock(effect);
                }
            }
            Ok(FileClipboard {
                sequence,
                paths,
                cut,
            })
        }
    }
    #[cfg(not(windows))]
    {
        Ok(FileClipboard {
            sequence: 0,
            paths: Vec::new(),
            cut: false,
        })
    }
}

// DROPFILES: 20-byte header followed by a double-NUL-terminated UTF-16 path list.
fn encode_file_drop(paths: &[String]) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; 20];
    bytes[..4].copy_from_slice(&20u32.to_le_bytes());
    bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
    for path in paths {
        if path.contains('\0') {
            return Err("Invalid clipboard path".into());
        }
        for unit in path.encode_utf16().chain(Some(0)) {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    Ok(bytes)
}

#[tauri::command]
pub fn write_file_clipboard(
    window: tauri::Window,
    paths: Vec<String>,
    cut: bool,
    expected_sequence: Option<u32>,
) -> Result<(), String> {
    if window.label().starts_with("window-snapshot-") && cut {
        return Err("历史快照为只读，无法剪切文件".into());
    }
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "user32")]
        unsafe extern "system" {
            fn OpenClipboard(owner: *mut c_void) -> i32;
            fn CloseClipboard() -> i32;
            fn EmptyClipboard() -> i32;
            fn SetClipboardData(format: u32, data: *mut c_void) -> *mut c_void;
            fn RegisterClipboardFormatW(name: *const u16) -> u32;
            fn GetClipboardSequenceNumber() -> u32;
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GlobalAlloc(flags: u32, size: usize) -> *mut c_void;
            fn GlobalLock(memory: *mut c_void) -> *mut c_void;
            fn GlobalUnlock(memory: *mut c_void) -> i32;
            fn GlobalFree(memory: *mut c_void) -> *mut c_void;
        }
        struct Memory(*mut c_void);
        impl Drop for Memory {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe {
                        GlobalFree(self.0);
                    }
                }
            }
        }
        fn allocate(bytes: &[u8]) -> Result<Memory, String> {
            unsafe {
                let memory = Memory(GlobalAlloc(0x42, bytes.len()));
                if memory.0.is_null() {
                    return Err("Cannot allocate clipboard memory".into());
                }
                let data = GlobalLock(memory.0);
                if data.is_null() {
                    return Err("Cannot lock clipboard memory".into());
                }
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), data as *mut u8, bytes.len());
                GlobalUnlock(memory.0);
                Ok(memory)
            }
        }
        let paths = paths
            .iter()
            .map(|path| {
                let path = std::path::Path::new(path);
                if !path.is_absolute() {
                    return Err("Clipboard requires absolute file paths".to_string());
                }
                std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
                Ok(path.to_string_lossy().replace('/', "\\"))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut drop = allocate(&encode_file_drop(&paths)?)?;
        let mut effect = allocate(&(if cut { 2u32 } else { 1u32 }).to_le_bytes())?;
        let owner = window.hwnd().map_err(|e| e.to_string())?.0 as *mut c_void;
        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {
                unsafe {
                    CloseClipboard();
                }
            }
        }
        unsafe {
            if OpenClipboard(owner) == 0 {
                return Err("System clipboard is busy; please retry".into());
            }
            let _guard = Guard;
            if expected_sequence.is_some_and(|sequence| sequence != GetClipboardSequenceNumber()) {
                return Ok(());
            }
            let name: Vec<u16> = "Preferred DropEffect"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let format = RegisterClipboardFormatW(name.as_ptr());
            if format == 0 {
                return Err("Cannot register clipboard format".into());
            }
            if EmptyClipboard() == 0 {
                return Err("Cannot empty clipboard".into());
            }
            if paths.is_empty() {
                return Ok(());
            }
            if SetClipboardData(15, drop.0).is_null() {
                return Err("Cannot write file clipboard".into());
            }
            drop.0 = std::ptr::null_mut(); // Ownership transfers to Windows on success.
            if SetClipboardData(format, effect.0).is_null() {
                return Err("Cannot write clipboard drop effect".into());
            }
            effect.0 = std::ptr::null_mut();
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, paths, cut, expected_sequence);
        Err("System file clipboard is currently supported on Windows only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_drop_encodes_unicode_multiple_paths_and_header() {
        let paths = vec![
            "C:\\notes\\one.md".to_string(),
            "C:\\notes\\\u{4e8c}.md".to_string(),
        ];
        let bytes = encode_file_drop(&paths).unwrap();
        assert_eq!(&bytes[..4], &20u32.to_le_bytes());
        assert_eq!(&bytes[16..20], &1u32.to_le_bytes());
        let units: Vec<u16> = bytes[20..]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        assert_eq!(
            String::from_utf16(&units).unwrap(),
            format!("{}\0{}\0\0", paths[0], paths[1])
        );
        assert!(encode_file_drop(&["bad\0path".into()]).is_err());
    }
}
