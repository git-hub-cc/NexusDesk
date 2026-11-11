use std::path::{Path, PathBuf};
use tauri::Manager;

#[cfg(windows)]
static PROJECT_INSTANCE_MUTEX: std::sync::OnceLock<std::sync::Mutex<Option<(String, isize)>>> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn project_instance_mutex() -> &'static std::sync::Mutex<Option<(String, isize)>> {
    PROJECT_INSTANCE_MUTEX.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(windows)]
pub fn activate_existing_project(project: Option<&Path>) -> bool {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HWND, LPARAM},
        System::Threading::CreateMutexW,
        UI::WindowsAndMessaging::{
            EnumWindows, GetPropW, IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindow,
        },
    };

    let Some(project) = project else {
        return false;
    };
    let Ok(key) = profile_key(Some(project)) else {
        return false;
    };
    let mutex_name: Vec<u16> = OsStr::new(&format!("Local\\NexusDeskProject-{key}"))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr()) };
    if mutex.is_null() {
        return false;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(mutex);
        }
        let property_name: Vec<u16> = OsStr::new(&format!("NexusDeskProject-{key}"))
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        struct Search {
            property: Vec<u16>,
            found: HWND,
        }
        unsafe extern "system" fn find_window(hwnd: HWND, data: LPARAM) -> i32 {
            unsafe {
                let search = &mut *(data as *mut Search);
                if !GetPropW(hwnd, search.property.as_ptr()).is_null() {
                    search.found = hwnd;
                    return 0;
                }
            }
            1
        }
        let mut search = Search {
            property: property_name,
            found: std::ptr::null_mut(),
        };
        for _ in 0..40 {
            search.found = std::ptr::null_mut();
            unsafe {
                EnumWindows(Some(find_window), &mut search as *mut Search as LPARAM);
            }
            if !search.found.is_null() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if !search.found.is_null() {
            unsafe {
                if IsIconic(search.found) != 0 {
                    ShowWindow(search.found, SW_RESTORE);
                }
                SetForegroundWindow(search.found);
            }
        }
        return true;
    }
    *project_instance_mutex().lock().unwrap() = Some((key, mutex as isize));
    false
}

#[cfg(windows)]
fn claim_project_window(window: &tauri::Window, project: &Path) -> Result<bool, String> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::{ERROR_ALREADY_EXISTS, GetLastError},
        System::Threading::CreateMutexW,
        UI::WindowsAndMessaging::{RemovePropW, SetPropW},
    };

    let key = profile_key(Some(project))?;
    let mut current = project_instance_mutex()
        .lock()
        .map_err(|error| error.to_string())?;
    if current
        .as_ref()
        .is_some_and(|(current_key, _)| current_key == &key)
    {
        return Ok(true);
    }
    let mutex_name: Vec<u16> = OsStr::new(&format!("Local\\NexusDeskProject-{key}"))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr()) };
    if mutex.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(mutex);
        }
        activate_project_window(&key);
        return Ok(false);
    }

    let property_name = project_property_name(&key);
    if let Some((previous_key, previous_mutex)) = current.take() {
        let previous_property = project_property_name(&previous_key);
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                RemovePropW(hwnd.0 as _, previous_property.as_ptr());
            }
        }
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(previous_mutex as _);
        }
    }
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            SetPropW(hwnd.0 as _, property_name.as_ptr(), 1usize as _);
        }
    }
    *current = Some((key, mutex as isize));
    Ok(true)
}

#[cfg(not(windows))]
fn claim_project_window(_: &tauri::Window, _: &Path) -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
pub fn register_project_instance(window: tauri::Window, path: String) -> Result<bool, String> {
    let project = PathBuf::from(path);
    if !project.is_dir() {
        return Err("Project path is not a directory".into());
    }
    claim_project_window(&window, &project)
}

#[cfg(windows)]
fn project_property_name(key: &str) -> Vec<u16> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    OsStr::new(&format!("NexusDeskProject-{key}"))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn activate_project_window(key: &str) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetPropW, IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindow,
    };
    struct Search {
        property: Vec<u16>,
        found: HWND,
    }
    unsafe extern "system" fn find_window(hwnd: HWND, data: LPARAM) -> i32 {
        unsafe {
            let search = &mut *(data as *mut Search);
            if !GetPropW(hwnd, search.property.as_ptr()).is_null() {
                search.found = hwnd;
                return 0;
            }
        }
        1
    }
    let mut search = Search {
        property: project_property_name(key),
        found: std::ptr::null_mut(),
    };
    for _ in 0..40 {
        search.found = std::ptr::null_mut();
        unsafe {
            EnumWindows(Some(find_window), &mut search as *mut Search as LPARAM);
        }
        if !search.found.is_null() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !search.found.is_null() {
        unsafe {
            if IsIconic(search.found) != 0 {
                ShowWindow(search.found, SW_RESTORE);
            }
            SetForegroundWindow(search.found);
        }
    }
}

#[cfg(not(windows))]
pub fn activate_existing_project(_: Option<&Path>) -> bool {
    false
}

#[cfg(windows)]
pub fn mark_project_window(window: &tauri::Window, project: Option<&Path>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetPropW;
    let Some(project) = project else {
        return;
    };
    let Ok(key) = profile_key(Some(project)) else {
        return;
    };
    let property_name = project_property_name(&key);
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            SetPropW(hwnd.0 as _, property_name.as_ptr(), 1usize as _);
        }
    }
}

#[cfg(not(windows))]
pub fn mark_project_window(_: &tauri::Window, _: Option<&Path>) {}

pub struct ProjectProfile {
    pub directory: PathBuf,
    // Prevent two app instances (including launchers or switched projects)
    // from ever using the same active UDF, while preserving stable profiles.
    _lease: std::fs::File,
}

pub fn allocate(root: &Path, project: Option<&Path>) -> Result<ProjectProfile, String> {
    let directory = root.join(profile_key(project)?);
    let acquire = |directory: PathBuf, wait: bool| -> Result<ProjectProfile, String> {
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join(".instance.lock"))
            .map_err(|error| error.to_string())?;
        if wait {
            file.lock().map_err(|error| error.to_string())?;
        } else {
            file.try_lock().map_err(|error| error.to_string())?;
        }
        Ok(ProjectProfile {
            directory,
            _lease: file,
        })
    };
    match acquire(directory.clone(), false) {
        Ok(profile) => Ok(profile),
        Err(_) => acquire(
            directory
                .join("instances")
                .join(std::process::id().to_string()),
            true,
        ),
    }
}

pub fn profile_key(project: Option<&Path>) -> Result<String, String> {
    let Some(project) = project else {
        return Ok("launcher".into());
    };
    let path = std::fs::canonicalize(project).map_err(|error| error.to_string())?;
    let identity = path.to_string_lossy();
    #[cfg(windows)]
    let identity = identity.replace('/', "\\").to_lowercase();
    // Fixed FNV-1a 128, rather than Rust's unspecified DefaultHasher format.
    let mut hash = 0x6c62272e07bb014262b821756295c58du128;
    for byte in identity.as_bytes() {
        hash ^= u128::from(*byte);
        hash = hash.wrapping_mul(0x0000000001000000000000000000013b);
    }
    Ok(format!("{hash:032x}"))
}

pub fn data_directory(app: &tauri::AppHandle) -> PathBuf {
    app.state::<ProjectProfile>().directory.clone()
}

pub fn create_main(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let config = app.config().app.windows[0].clone();
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .data_directory(data_directory(app))
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_paths_are_isolated_and_aliases_resolve() {
        let root = std::env::temp_dir();
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            profile_key(Some(&cwd)).unwrap(),
            profile_key(Some(&cwd.join("."))).unwrap()
        );
        assert_ne!(
            profile_key(Some(&cwd)).unwrap(),
            profile_key(Some(&root)).unwrap()
        );
        assert_ne!(profile_key(Some(&cwd)).unwrap(), profile_key(None).unwrap());
        assert_eq!(profile_key(Some(&cwd)).unwrap().len(), 32);
    }

    #[test]
    fn simultaneous_instances_never_share_a_profile() {
        let root =
            std::env::temp_dir().join(format!("nexusdesk-profile-test-{}", std::process::id()));
        let first = allocate(&root, None).unwrap();
        let second = allocate(&root, None).unwrap();
        assert_ne!(first.directory, second.directory);
        let stable = first.directory.clone();
        drop(first);
        let next = allocate(&root, None).unwrap();
        assert_eq!(next.directory, stable);
        drop(next);
        drop(second);
        std::fs::remove_dir_all(root).unwrap();
    }
}
