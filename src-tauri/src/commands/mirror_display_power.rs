pub(super) struct DisplayWakeLock {
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
}

impl DisplayWakeLock {
    pub(super) fn acquire() -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::{
                Foundation::INVALID_HANDLE_VALUE,
                System::{
                    Power::{PowerCreateRequest, PowerRequestDisplayRequired, PowerSetRequest},
                    SystemServices::POWER_REQUEST_CONTEXT_VERSION,
                    Threading::{
                        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
                    },
                },
            };

            let mut reason: Vec<u16> = "NexusDesk 安卓投屏全屏观看\0".encode_utf16().collect();
            let context = REASON_CONTEXT {
                Version: POWER_REQUEST_CONTEXT_VERSION,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 {
                    SimpleReasonString: reason.as_mut_ptr(),
                },
            };
            let handle = unsafe { PowerCreateRequest(&context) };
            if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
            if unsafe { PowerSetRequest(handle.as_raw_handle(), PowerRequestDisplayRequired) } == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(Self { handle })
        }
        #[cfg(not(windows))]
        Ok(Self {})
    }
}

#[cfg(windows)]
impl Drop for DisplayWakeLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Power::{PowerClearRequest, PowerRequestDisplayRequired};

        // 句柄随会话释放，进程异常退出时 Windows 也会回收电源请求。
        if unsafe { PowerClearRequest(self.handle.as_raw_handle(), PowerRequestDisplayRequired) }
            == 0
        {
            log::warn!(target: "android_mirror", "释放显示器常亮请求失败：{}", std::io::Error::last_os_error());
        }
    }
}
