//! scrcpy 3.3.4 / 5.0.1 wire protocols, normalized to one frontend packet format.
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{Shutdown, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::ipc::{Channel, Response};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Protocol {
    Legacy,
    SessionMetadata,
}

fn protocol(version: &str) -> Result<Protocol, String> {
    match version {
        "3.3.4" => Ok(Protocol::Legacy),
        "5.0.1" => Ok(Protocol::SessionMetadata),
        _ => Err(format!(
            "暂不支持 scrcpy {version}，当前支持 3.3.4 和 5.0.1"
        )),
    }
}
type Sessions = Arc<Mutex<HashMap<String, Arc<Session>>>>;
#[derive(Default)]
pub struct MirrorState(Sessions);
struct Session {
    owner: String,
    serial: String,
    port: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
    video: Mutex<Option<TcpStream>>,
    audio: Mutex<Option<TcpStream>>,
    control: Mutex<Option<TcpStream>>,
    stopped: AtomicBool,
    visible: AtomicBool,
}

fn adb() -> Command {
    let executable = resolve_adb();
    hidden_command(executable)
}

fn resolve_adb() -> PathBuf {
    let executable_name = if cfg!(windows) { "adb.exe" } else { "adb" };
    if let Some(explicit) = std::env::var_os("NEXUSDESK_ADB").map(PathBuf::from) {
        return std::fs::canonicalize(&explicit).unwrap_or(explicit);
    }

    let mut directories = tool_directories();
    directories.extend(android_sdk_directories());
    if let Some(path) = directories
        .iter()
        .map(|dir| dir.join(executable_name))
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .find(|path| adb_runtime_files_exist(path))
    {
        return path;
    }

    PathBuf::from(executable_name)
}

fn adb_runtime_files_exist(executable: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        let Some(directory) = executable.parent() else { return false };
        return directory.join("AdbWinApi.dll").is_file()
            && directory.join("AdbWinUsbApi.dll").is_file();
    }
    #[cfg(not(windows))]
    {
        let _ = executable;
        true
    }
}

fn android_sdk_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for variable in ["ANDROID_SDK_ROOT", "ANDROID_HOME"] {
        if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
            directories.push(root.join("platform-tools"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        directories.push(local.join("Android/Sdk/platform-tools"));
    }
    for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(program_files) = std::env::var_os(variable).map(PathBuf::from) {
            directories.push(program_files.join("Android/android-sdk/platform-tools"));
        }
    }
    directories
}

fn hidden_command(executable: PathBuf) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn output(command: Command) -> Result<String, String> {
    output_with_timeout(command, Duration::from_secs(15))
}

fn output_with_timeout(command: Command, timeout: Duration) -> Result<String, String> {
    output_with_timeout_untrimmed(command, timeout).map(|text| text.trim().to_owned())
}

fn output_with_timeout_untrimmed(command: Command, timeout: Duration) -> Result<String, String> {
    output_bytes_with_timeout(command, timeout).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn output_bytes_with_timeout(mut command: Command, timeout: Duration) -> Result<Vec<u8>, String> {
    // Poll a child with a deadline so unplugged devices cannot block shutdown forever.
    let executable = command.get_program().to_string_lossy().into_owned();
    log::info!(target: "android_mirror", "adb command start executable={executable}");
    let started = Instant::now();
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if cfg!(windows) && e.raw_os_error() == Some(126) {
                format!("无法启动 {executable}：缺少 AdbWinApi.dll 或 AdbWinUsbApi.dll。请将完整的 Android SDK Platform-Tools 解压到 platform-tools 目录，或设置 NEXUSDESK_ADB 指向包含这些 DLL 的 adb.exe。")
            } else {
                format!("无法启动 {executable}，请检查工具安装路径或环境变量：{e}")
            }
        })?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let collect = |mut pipe: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            bytes
        })
    };
    let out = collect(Box::new(stdout));
    let err = collect(Box::new(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(30)),
            other => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("{executable} 超时或退出失败：{other:?}"));
            }
        }
    };
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    let status = status?;
    if !status.success() {
        let error = String::from_utf8_lossy(&err).trim().to_owned();
        log::error!(target: "android_mirror", "adb command failed executable={executable} elapsed_ms={} status={status} stderr={error}", started.elapsed().as_millis());
        return Err(error);
    }
    log::info!(target: "android_mirror", "adb command complete executable={executable} elapsed_ms={} stdout_bytes={}", started.elapsed().as_millis(), out.len());
    Ok(out)
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct AndroidFileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

fn remote_path(path: &str) -> Result<&str, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("手机路径必须是绝对路径且不能包含空字符".into());
    }
    Ok(path)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn parse_file_entries(text: &str, path: &str) -> Result<Vec<AndroidFileEntry>, String> {
    let mut fields = text.split_terminator('\0');
    let mut entries = Vec::new();
    while let Some(kind) = fields.next() {
        let name = fields.next().ok_or("手机目录数据不完整")?;
        if !matches!(kind, "d" | "f")
            || name.is_empty()
            || name.contains('/')
            || matches!(name, "." | "..")
        {
            return Err("手机目录数据无效".into());
        }
        entries.push(AndroidFileEntry {
            name: name.into(),
            path: format!("{}/{}", path.trim_end_matches('/'), name),
            is_dir: kind == "d",
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
pub async fn mirror_list_files(
    serial: String,
    path: String,
) -> Result<Vec<AndroidFileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        remote_path(&path)?;
        // Let ls report missing directories / permission errors. Use NUL-delimited
        // shell globs for names so spaces, newlines and symlinks survive intact.
        let script = format!(
            "dir={}; [ -d \"$dir\" ] || {{ echo '目录不存在或无法访问' >&2; exit 1; }}; ls -a \"$dir\" >/dev/null || exit; for entry in \"${{dir%/}}\"/* \"${{dir%/}}\"/.[!.]* \"${{dir%/}}\"/..?*; do [ -e \"$entry\" ] || [ -L \"$entry\" ] || continue; kind=f; [ ! -d \"$entry\" ] || kind=d; printf '%s\\000%s\\000' \"$kind\" \"${{entry##*/}}\"; done",
            shell_quote(&path)
        );
        let mut command = adb();
        command.args(["-s", &serial, "shell", &script]);
        parse_file_entries(&output(command)?, &path)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mirror_push_file(
    serial: String,
    local_path: String,
    remote_dir: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remote_path(&remote_dir)?;
        let local =
            std::fs::canonicalize(&local_path).map_err(|e| format!("无法读取本地文件：{e}"))?;
        if !local.is_file() && !local.is_dir() {
            return Err("请选择本地文件或目录".into());
        }
        let name = local.file_name().ok_or("无法上传根目录")?.to_string_lossy();
        let destination = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
        let mut check = adb();
        let script = format!("[ -d {dir} ] || {{ echo '目标目录不存在' >&2; exit 1; }}; if [ -e {dst} ] || [ -L {dst} ]; then echo '手机目录中已有同名项目，请重命名后重试' >&2; exit 1; fi", dir = shell_quote(&remote_dir), dst = shell_quote(&destination));
        check.args(["-s", &serial, "shell", &script]);
        output(check)?;
        let mut command = adb();
        command
            .args(["-s", &serial, "push"])
            .arg(local)
            .arg(destination);
        output_with_timeout(command, Duration::from_secs(1800)).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mirror_download_file(serial: String, remote_path: String, local_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        self::remote_path(&remote_path)?;
        let directory = std::path::Path::new(&local_dir);
        if !directory.is_absolute() || !directory.is_dir() {
            return Err("请选择本地目标目录".into());
        }
        let name = remote_path.trim_end_matches('/').rsplit('/').next().ok_or("无效的文件名")?;
        if name.is_empty() || matches!(name, "." | "..") || name.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
            || name.ends_with(['.', ' ']) || name.chars().any(|c| c.is_control()) {
            return Err("手机文件名不适用于本地文件系统".into());
        }
        // Download separately, then use the existing copy policy to keep both files on name collisions.
        struct TemporaryDownload(PathBuf);
        impl Drop for TemporaryDownload {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        static NEXT_DOWNLOAD: AtomicU32 = AtomicU32::new(0);
        let temporary = loop {
            let id = NEXT_DOWNLOAD.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("nexusdesk-android-{}-{id}", std::process::id()));
            match std::fs::create_dir(&path) {
                Ok(()) => break TemporaryDownload(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        };
        let downloaded = temporary.0.join(name);
        let mut command = adb();
        command.args(["-s", &serial, "pull", &remote_path]).arg(&downloaded);
        output_with_timeout(command, Duration::from_secs(1800))?;
        crate::core::fs::transfer_entry(&downloaded, directory, true, &Default::default())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn mirror_read_file(serial: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        remote_path(&path)?;
        let script = format!("[ -f {0} ] || {{ echo '不是普通文件' >&2; exit 1; }}; cat -- {0}", shell_quote(&path));
        let mut command = adb();
        command.args(["-s", &serial, "shell", &script]);
        output_with_timeout_untrimmed(command, Duration::from_secs(30))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mirror_read_image(serial: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        remote_path(&path)?;
        let script = format!("[ -f {0} ] || {{ echo '不是普通文件' >&2; exit 1; }}; cat -- {0}", shell_quote(&path));
        let mut command = adb();
        // exec-out avoids terminal processing of binary image bytes.
        command.args(["-s", &serial, "exec-out", &script]);
        let bytes = output_bytes_with_timeout(command, Duration::from_secs(30))?;
        let format = image::guess_format(&bytes).map_err(|e| format!("无法识别图片格式：{e}"))?;
        Ok(format!("data:{};base64,{}", format.to_mime_type(), base64::engine::general_purpose::STANDARD.encode(bytes)))
    }).await.map_err(|e| e.to_string())?
}

fn delete_script(paths: &[String]) -> Result<String, String> {
    if paths.is_empty() { return Err("请选择要删除的项目".into()); }
    let mut quoted = Vec::new();
    for path in paths {
        remote_path(path)?;
        if path.split('/').filter(|part| !part.is_empty()).any(|part| matches!(part, "." | ".."))
            || path.trim_matches('/').is_empty() {
            return Err("不能删除根目录或包含相对路径的项目".into());
        }
        quoted.push(shell_quote(path.trim_end_matches('/')));
    }
    Ok(format!("rm -rf -- {}", quoted.join(" ")))
}

#[tauri::command]
pub async fn mirror_delete_files(serial: String, paths: Vec<String>) -> Result<(), String> {
    let script = delete_script(&paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = adb();
        command.args(["-s", &serial, "shell", &script]);
        output_with_timeout(command, Duration::from_secs(1800)).map(|_| ())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mirror_create_folder(serial: String, parent: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remote_path(&parent)?;
        if name.is_empty() || matches!(name.as_str(), "." | "..") || name.contains(['/', '\\', '\0']) {
            return Err("鏂囦欢澶瑰悕绉颁笉鑳藉寘鍚矾寰勫垎闅旂".into());
        }
        let destination = format!("{}/{}", parent.trim_end_matches('/'), name);
        let script = format!(
            "[ -d {parent} ] || {{ echo '鐖剁洰褰曚笉瀛樺湪鎴栨棤娉曡闂? >&2; exit 1; }}; [ ! -e {destination} ] && [ ! -L {destination} ] || {{ echo '宸插瓨鍦ㄥ悓鍚嶉」鐩? >&2; exit 1; }}; mkdir -- {destination}",
            parent = shell_quote(&parent),
            destination = shell_quote(&destination),
        );
        let mut command = adb();
        command.args(["-s", &serial, "shell", &script]);
        output(command).map(|_| ())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn mirror_copy_file(serial: String, source_path: String, remote_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remote_path(&source_path)?;
        remote_path(&remote_dir)?;
        let name = source_path.rsplit('/').find(|part| !part.is_empty()).ok_or("无效的源文件路径")?;
        let destination = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
        let script = format!("[ -e {src} ] || {{ echo '源文件不存在' >&2; exit 1; }}; [ -d {dst_dir} ] || {{ echo '目标目录不存在' >&2; exit 1; }}; cp -R -- {src} {dst}", src = shell_quote(&source_path), dst_dir = shell_quote(&remote_dir), dst = shell_quote(&destination));
        let mut command = adb();
        command.args(["-s", &serial, "shell", &script]);
        output_with_timeout(command, Duration::from_secs(1800)).map(|_| ())
    }).await.map_err(|e| e.to_string())?
}

impl Session {
    fn stop(&self) {
        self.stop_with_forward_cleanup(true);
    }

    fn stop_with_forward_cleanup(&self, cleanup_forward: bool) {
        self.stopped.store(true, Ordering::Release);
        for socket in [&self.video, &self.audio, &self.control] {
            if let Some(stream) = socket.lock().unwrap().take() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(port) = self.port.lock().unwrap().take().filter(|_| cleanup_forward) {
            let mut command = adb();
            command.args([
                "-s",
                &self.serial,
                "forward",
                "--remove",
                &format!("tcp:{port}"),
            ]);
            let _ = output(command);
        }
    }
}

impl MirrorState {
    pub fn close_window(&self, owner: &str) {
        self.close_matching(|s| s.owner == owner);
    }
    pub fn shutdown(&self) {
        let sessions = {
            let mut map = self.0.lock().unwrap();
            map.drain().map(|(_, session)| session).collect::<Vec<_>>()
        };
        for session in sessions {
            session.stop_with_forward_cleanup(false);
        }
    }
    fn close_matching(&self, matches: impl Fn(&Session) -> bool) {
        let sessions = {
            let mut map = self.0.lock().unwrap();
            let keys: Vec<_> = map
                .iter()
                .filter(|(_, s)| matches(s))
                .map(|(k, _)| k.clone())
                .collect();
            keys.iter()
                .filter_map(|k| map.remove(k))
                .collect::<Vec<_>>()
        };
        for session in sessions {
            session.stop();
        }
    }
    fn session(&self, owner: &str, id: &str) -> Result<Arc<Session>, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .filter(|s| s.owner == owner && !s.stopped.load(Ordering::Acquire))
            .cloned()
            .ok_or_else(|| "投屏已断开".into())
    }
}

#[derive(serde::Serialize)]
pub struct Device {
    serial: String,
    status: String,
    model: String,
}

fn parse_devices(output: &str) -> Vec<Device> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?;
            let status = fields.next()?;
            if serial == "List"
                || serial.starts_with('*')
                || ![
                    "device",
                    "offline",
                    "unauthorized",
                    "recovery",
                    "sideload",
                    "bootloader",
                    "no",
                ]
                .contains(&status)
            {
                return None;
            }
            let model = fields
                .find_map(|s| s.strip_prefix("model:"))
                .unwrap_or(serial)
                .replace('_', " ");
            Some(Device {
                serial: serial.into(),
                status: if status == "no" {
                    "no permissions"
                } else {
                    status
                }
                .into(),
                model,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn mirror_devices(recover: Option<bool>) -> Result<Vec<Device>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let list = || {
            let mut command = adb();
            command.args(["devices", "-l"]);
            output(command).map(|text| parse_devices(&text))
        };
        let mut devices = list()?;
        if recover.unwrap_or(false)
            && (devices.is_empty() || devices.iter().any(|device| device.status == "offline"))
        {
            // Recover stale transports without restarting the shared ADB server or
            // interrupting healthy sessions in other tabs / Android tools.
            let mut command = adb();
            command.args(["reconnect", "offline"]);
            output(command)?;
            for delay in [250, 500, 1000] {
                thread::sleep(Duration::from_millis(delay));
                devices = list()?;
                if !devices.is_empty() && devices.iter().all(|device| device.status != "offline") {
                    break;
                }
            }
        }
        Ok(devices)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mirror_connect_wifi(serial: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut devices = adb();
        devices.args(["devices", "-l"]);
        if !parse_devices(&output(devices)?)
            .iter()
            .any(|device| device.serial == serial && device.status == "device" && !serial.contains(':'))
        {
            return Err("请先通过 USB 连接并授权手机，再切换 Wi-Fi 投屏。".into());
        }

        let mut address = adb();
        address.args(["-s", &serial, "shell", "ip", "-f", "inet", "addr", "show", "wlan0"]);
        let address = output(address).unwrap_or_default();
        let ip = address
            .lines()
            .find_map(|line| line.trim().strip_prefix("inet "))
            .and_then(|value| value.split('/').next())
            .filter(|value| value.parse::<std::net::Ipv4Addr>().is_ok())
            .map(str::to_owned)
            .or_else(|| {
                let mut property = adb();
                property.args(["-s", &serial, "shell", "getprop", "dhcp.wlan0.ipaddress"]);
                output(property).ok().filter(|value| value.parse::<std::net::Ipv4Addr>().is_ok())
            })
            .ok_or("手机尚未连接 Wi-Fi。请让手机和电脑接入同一局域网后重试。")?;

        let mut tcpip = adb();
        tcpip.args(["-s", &serial, "tcpip", "5555"]);
        output(tcpip)?;
        let endpoint = format!("{ip}:5555");
        let mut connect = adb();
        connect.args(["connect", &endpoint]);
        let result = output(connect)?;
        if result.contains("unable") || result.contains("failed") {
            return Err(format!("无法连接到 {endpoint}：{result}"));
        }
        Ok(endpoint)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn tool_directories() -> Vec<PathBuf> {
    let paths: Vec<_> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    let mut directories = Vec::new();
    for path in paths {
        // Scoop places only launchers in PATH; the server is beside the real executable.
        if let Ok(shim) = std::fs::read_to_string(path.join("scrcpy.shim")) {
            if let Some(executable) = shim
                .lines()
                .find_map(|line| line.trim().strip_prefix("path = "))
            {
                if let Some(parent) = PathBuf::from(executable.trim_matches('"')).parent() {
                    directories.push(parent.to_owned());
                }
            }
        }
        if let Ok(executable) = std::fs::canonicalize(path.join(if cfg!(windows) {
            "scrcpy.exe"
        } else {
            "scrcpy"
        })) {
            if let Some(directory) = executable.parent() {
                directories.push(directory.to_owned());
            }
        }
        directories.push(path);
    }
    let scoop = std::env::var_os("SCOOP")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join("scoop")));
    if let Some(root) = scoop {
        directories.push(root.join("apps/scrcpy/current"));
    }
    let global = std::env::var_os("SCOOP_GLOBAL")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("ProgramData").map(|root| PathBuf::from(root).join("scoop")));
    if let Some(root) = global {
        directories.push(root.join("apps/scrcpy/current"));
    }
    directories
}

fn find_server(explicit: Option<PathBuf>, directories: &[PathBuf]) -> Result<PathBuf, String> {
    let path = explicit.or_else(|| {
        directories
            .iter()
            .map(|dir| dir.join("scrcpy-server"))
            .find(|path| path.is_file())
    });
    path.filter(|path| path.is_file()).ok_or_else(||
        "未找到 scrcpy-server，请安装 scrcpy，或将 NEXUSDESK_SCRCPY_SERVER 指向该文件（支持 3.3.4 / 5.0.1）".into())
}

fn parse_version(output: &str) -> Result<String, String> {
    let version = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("scrcpy "))
        .and_then(|line| line.split_whitespace().next())
        .ok_or("无法读取 scrcpy 版本")?;
    protocol(version)?;
    Ok(version.into())
}

fn server_tools() -> Result<(PathBuf, String, Protocol), String> {
    let server = find_server(
        std::env::var_os("NEXUSDESK_SCRCPY_SERVER").map(PathBuf::from),
        &tool_directories(),
    )?;
    let version = if let Ok(version) = std::env::var("NEXUSDESK_SCRCPY_VERSION") {
        version.trim().to_owned()
    } else {
        let executable = server.with_file_name(if cfg!(windows) {
            "scrcpy.exe"
        } else {
            "scrcpy"
        });
        if !executable.is_file() {
            return Err("scrcpy-server 同目录下缺少 scrcpy 可执行文件；单独配置 server 时请同时设置 NEXUSDESK_SCRCPY_VERSION（3.3.4 或 5.0.1）".into());
        }
        let mut command = hidden_command(executable);
        command.arg("--version");
        parse_version(&output(command)?)?
    };
    let protocol = protocol(&version)?;
    Ok((server, version, protocol))
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn start(
    session: &Arc<Session>,
    max_size: u32,
    channel: Channel<Response>,
    audio_channel: Channel<Response>,
) -> Result<(), String> {
    let (server, version, protocol) = server_tools()?;
    let adb_path = resolve_adb();
    log::info!(target: "android_mirror", "start serial={} max_size={} adb={} scrcpy={} server={} protocol={protocol:?}", session.serial, max_size, adb_path.display(), version, server.display());
    let scid = std::process::id()
        .wrapping_mul(65537)
        .wrapping_add(NEXT_ID.fetch_add(1, Ordering::Relaxed))
        & 0x7fffffff;
    let remote = format!("/data/local/tmp/nexusdesk-scrcpy-{scid:08x}.jar");
    let mut push = adb();
    push.args(["-s", &session.serial, "push"])
        .arg(server)
        .arg(&remote);
    log::info!(target: "android_mirror", "stage=push-server serial={}", session.serial);
    let result = output(push).and_then(|_| {
        let mut forward = adb();
        forward.args([
            "-s",
            &session.serial,
            "forward",
            "tcp:0",
            &format!("localabstract:scrcpy_{scid:08x}"),
        ]);
        // Hold the resource lock across allocation: stop() must see every acquired resource.
        let port = {
            let mut port = session.port.lock().unwrap();
            if session.stopped.load(Ordering::Acquire) {
                return Err("连接已取消".into());
            }
            log::info!(target: "android_mirror", "stage=allocate-forward serial={}", session.serial);
            let allocated = output(forward)?;
            *port = Some(allocated.clone());
            allocated.parse::<u16>().map_err(|_| "ADB 返回了无效端口")?
        };
        let mut command = adb();
        command.args([
            "-s",
            &session.serial,
            "shell",
            &format!("CLASSPATH={remote}"),
            "app_process",
            "/",
            "com.genymobile.scrcpy.Server",
            &version,
            &format!("scid={scid:08x}"),
            "tunnel_forward=true",
            "audio=true",
            "audio_codec=raw",
            "audio_source=output",
            "video_codec=h264",
            "control=true",
            "cleanup=true",
            "clipboard_autosync=false",
            "max_fps=60",
            "video_bit_rate=4000000",
            "video_codec_options=i-frame-interval=1",
            &format!("max_size={max_size}"),
        ]);
        {
            log::info!(target: "android_mirror", "stage=launch-scrcpy serial={} port={port}", session.serial);
            let mut child = session.child.lock().unwrap();
            if session.stopped.load(Ordering::Acquire) {
                return Err("连接已取消".into());
            }
            *child = Some(
                command
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())?,
            );
        }
        let deadline = Instant::now() + Duration::from_secs(12);
        log::info!(target: "android_mirror", "stage=wait-video-socket serial={} port={port}", session.serial);
        let mut video = loop {
            if session.stopped.load(Ordering::Acquire) {
                return Err("连接已取消".into());
            }
            if let Ok(mut socket) = TcpStream::connect_timeout(
                &([127, 0, 0, 1], port).into(),
                Duration::from_millis(200),
            ) {
                let _ = socket.set_read_timeout(Some(Duration::from_millis(300)));
                let mut dummy = [0];
                if socket.read_exact(&mut dummy).is_ok() {
                    break socket;
                }
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "scrcpy 启动失败：请检查 USB 调试授权和 server 版本（当前使用 {version}）"
                ));
            }
            thread::sleep(Duration::from_millis(100));
        };
        // scrcpy accepts sockets in video, audio, control order.
        let mut audio =
            TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2))
                .map_err(|e| e.to_string())?;
        let control =
            TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2))
                .map_err(|e| e.to_string())?;
        control
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        video
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| e.to_string())?;
        {
            let mut slot = session.video.lock().unwrap();
            if session.stopped.load(Ordering::Acquire) {
                return Err("连接已取消".into());
            }
            *slot = Some(video.try_clone().map_err(|e| e.to_string())?);
        }
        {
            let mut slot = session.audio.lock().unwrap();
            if session.stopped.load(Ordering::Acquire) {
                return Err("连接已取消".into());
            }
            *slot = Some(audio.try_clone().map_err(|e| e.to_string())?);
        }
        {
            let mut slot = session.control.lock().unwrap();
            if session.stopped.load(Ordering::Acquire) {
                return Err("连接已取消".into());
            }
            *slot = Some(control);
        }
        // v5 moves the dimensions out of the initial header into session packets.
        let mut metadata = vec![0; if protocol == Protocol::Legacy { 76 } else { 68 }];
        log::info!(target: "android_mirror", "stage=read-video-metadata serial={}", session.serial);
        video.read_exact(&mut metadata).map_err(|e| e.to_string())?;
        if &metadata[64..68] != b"h264" {
            return Err("设备未提供 H.264 视频".into());
        }
        // Static screens may produce no frames for an arbitrary period.
        log::info!(target: "android_mirror", "video metadata serial={} header_bytes={} protocol={protocol:?}", session.serial, metadata.len());
        video.set_read_timeout(None).map_err(|e| e.to_string())?;
        let audio_session = session.clone();
        thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                audio
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .map_err(|e| e.to_string())?;
                read_audio_header(&mut audio)?;
                audio.set_read_timeout(None).map_err(|e| e.to_string())?;
                loop {
                    let packet = read_audio_packet(&mut audio, protocol)?;
                    audio_channel
                        .send(Response::new(packet))
                        .map_err(|e| e.to_string())?;
                }
            })();
            if !audio_session.stopped.load(Ordering::Acquire) {
                log::info!("Android mirror audio ended: {result:?}");
            }
            if let Some(stream) = audio_session.audio.lock().unwrap().take() {
                let _ = stream.shutdown(Shutdown::Both);
            }
            // Audio capture can fail independently (e.g. Android < 11).
            let _ = audio_channel.send(Response::new(Vec::<u8>::new()));
        });
        let session = session.clone();
        thread::spawn(move || {
            let mut config = Vec::new();
            let mut was_visible = false;
            let mut stats_started = Instant::now();
            let mut packets = 0u64;
            let mut bytes = 0u64;
            let mut sent = 0u64;
            let mut hidden = 0u64;
            let mut read_ms = 0u64;
            let result = (|| -> Result<(), String> {
                loop {
                    let read_started = Instant::now();
                    let packet = read_packet(&mut video, protocol)?;
                    read_ms += read_started.elapsed().as_millis() as u64;
                    packets += 1;
                    bytes += packet.len() as u64;
                    if packet[0] & 0x80 != 0 {
                        config = packet.clone();
                    }
                    let visible = session.visible.load(Ordering::Acquire);
                    if visible {
                        if !was_visible && !config.is_empty() {
                            channel
                                .send(Response::new(config.clone()))
                                .map_err(|e| e.to_string())?;
                        }
                        channel
                            .send(Response::new(packet))
                            .map_err(|e| e.to_string())?;
                        sent += 1;
                    } else {
                        hidden += 1;
                    }
                    if stats_started.elapsed() >= Duration::from_secs(1) {
                        log::info!(target: "android_mirror", "video serial={} packets={} sent={} hidden={} bytes={} avg_read_ms={:.1} visible={}", session.serial, packets, sent, hidden, bytes, read_ms as f64 / packets.max(1) as f64, visible);
                        stats_started = Instant::now();
                        packets = 0; bytes = 0; sent = 0; hidden = 0; read_ms = 0;
                    }
                    was_visible = visible;
                }
            })();
            if !session.stopped.load(Ordering::Acquire) {
                log::info!("Android mirror ended: {result:?}");
            }
            session.stop();
            let _ = channel.send(Response::new(Vec::<u8>::new()));
        });
        Ok(())
    });
    // The server has loaded the dex at this point; no deployment files are retained.
    let mut remove = adb();
    remove.args(["-s", &session.serial, "shell", "rm", "-f", &remote]);
    let _ = output(remove);
    result
}

fn read_audio_header(reader: &mut impl Read) -> Result<(), String> {
    let mut codec = [0; 4];
    reader.read_exact(&mut codec).map_err(|e| e.to_string())?;
    match &codec {
        b"\0raw" => Ok(()),
        [0, 0, 0, 0 | 1] => Err("设备无法转发音频".into()),
        _ => Err("设备未提供 PCM 音频".into()),
    }
}

fn read_audio_packet(reader: &mut impl Read, protocol: Protocol) -> Result<Vec<u8>, String> {
    let packet = read_packet(reader, protocol)?;
    // scrcpy raw audio is 48 kHz stereo signed 16-bit PCM, up to 1024 frames.
    let size = packet.len() - 12;
    if size == 0 || size > 4096 || size % 4 != 0 || packet[0] & 0x80 != 0 {
        return Err("无效的 PCM 音频数据".into());
    }
    Ok(packet)
}

fn read_packet(reader: &mut impl Read, protocol: Protocol) -> Result<Vec<u8>, String> {
    let mut header = [0; 12];
    loop {
        reader.read_exact(&mut header).map_err(|e| e.to_string())?;
        if protocol != Protocol::SessionMetadata {
            break;
        }
        if header[0] & 0x80 == 0 {
            // v5: config=bit 62, key=bit 61. The frontend uses the v3 bit layout.
            header[0] = (header[0] & 0x1f) | ((header[0] & 0x60) << 1);
            break;
        }
        // Session metadata is exactly 12 bytes, with no following payload.
        let width = u32::from_be_bytes(header[4..8].try_into().unwrap());
        let height = u32::from_be_bytes(header[8..12].try_into().unwrap());
        if width == 0 || height == 0 || width > u16::MAX.into() || height > u16::MAX.into() {
            return Err("无效的 scrcpy 画面尺寸".into());
        }
    }
    let size = u32::from_be_bytes(header[8..12].try_into().unwrap()) as usize;
    if size > 16 * 1024 * 1024 {
        return Err("scrcpy 视频包过大".into());
    }
    let mut packet = Vec::with_capacity(12 + size);
    packet.extend_from_slice(&header);
    packet.resize(12 + size, 0);
    reader
        .read_exact(&mut packet[12..])
        .map_err(|e| e.to_string())?;
    Ok(packet)
}

#[tauri::command]
pub async fn mirror_start(
    window: tauri::Window,
    state: tauri::State<'_, MirrorState>,
    id: String,
    serial: String,
    max_size: u32,
    channel: Channel<Response>,
    audio_channel: Channel<Response>,
) -> Result<(), String> {
    log::info!(target: "android_mirror", "connect request window={} serial={} max_size={max_size}", window.label(), serial);
    if serial.is_empty()
        || serial.len() > 256
        || serial.starts_with('-')
        || ![720, 1080, 1440].contains(&max_size)
    {
        return Err("无效的设备或分辨率".into());
    }
    let sessions = state.0.clone();
    let session = Arc::new(Session {
        owner: window.label().into(),
        serial,
        port: Mutex::new(None),
        child: Mutex::new(None),
        video: Mutex::new(None),
        audio: Mutex::new(None),
        control: Mutex::new(None),
        stopped: AtomicBool::new(false),
        visible: AtomicBool::new(true),
    });
    {
        let mut map = sessions.lock().unwrap();
        if map.contains_key(&id) {
            return Err("投屏会话已存在".into());
        }
        map.insert(id.clone(), session.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        log::info!(target: "android_mirror", "connect worker started serial={}", session.serial);
        let result = start(&session, max_size, channel, audio_channel);
        match &result {
            Ok(()) => log::info!(target: "android_mirror", "connect worker initialized serial={}", session.serial),
            Err(error) => log::error!(target: "android_mirror", "connect worker failed serial={} error={error}", session.serial),
        }
        if result.is_err() {
            session.stop();
            sessions.lock().unwrap().remove(&id);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mirror_stop(
    window: tauri::Window,
    state: tauri::State<'_, MirrorState>,
    id: String,
) -> Result<(), String> {
    let session = {
        let mut map = state.0.lock().unwrap();
        if map.get(&id).is_some_and(|s| s.owner == window.label()) {
            map.remove(&id)
        } else {
            None
        }
    };
    if let Some(session) = session {
        tauri::async_runtime::spawn_blocking(move || session.stop())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn mirror_visible(
    window: tauri::Window,
    state: tauri::State<'_, MirrorState>,
    id: String,
    visible: bool,
) -> Result<(), String> {
    state
        .session(window.label(), &id)?
        .visible
        .store(visible, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub async fn mirror_control(
    window: tauri::Window,
    state: tauri::State<'_, MirrorState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // Only permit scrcpy key, text, touch, display-power and rotate messages.
    let valid = match data.first() {
        Some(0) => data.len() == 14,
        Some(1) => {
            data.len() >= 5
                && data.len() <= 305
                && u32::from_be_bytes(data[1..5].try_into().unwrap()) as usize == data.len() - 5
        }
        Some(2) => data.len() == 32,
        Some(10) => data.len() == 2 && data[1] <= 1,
        Some(11) => data.len() == 1,
        _ => false,
    };
    if !valid {
        return Err("无效的投屏控制消息".into());
    }
    let session = state.session(window.label(), &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut control = session.control.lock().unwrap();
        control
            .as_mut()
            .ok_or("设备尚未连接")?
            .write_all(&data)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Cursor, net::TcpListener};

    #[test]
    fn deletion_rejects_root_and_traversal_and_quotes_special_names() {
        for path in ["/", "//", "/sdcard/..", "/sdcard/./a", "relative", "/sdcard/\0"] {
            assert!(delete_script(&[path.into()]).is_err(), "{path:?}");
        }
        assert!(delete_script(&[]).is_err());
        assert_eq!(delete_script(&["/sdcard/中文 ' $(id).png".into(), "/sdcard/folder/".into()]).unwrap(),
            "rm -rf -- '/sdcard/中文 '\\'' $(id).png' '/sdcard/folder'");
    }

    #[test]
    #[cfg(windows)]
    fn binary_command_output_preserves_non_utf8_and_whitespace() {
        let mut command = hidden_command("powershell.exe".into());
        command.args(["-NoProfile", "-Command", "[Console]::OpenStandardOutput().Write([byte[]](32,0,255,128,13,10,32),0,7)"]);
        assert_eq!(output_bytes_with_timeout(command, Duration::from_secs(15)).unwrap(), vec![32, 0, 255, 128, 13, 10, 32]);
    }

    #[tokio::test]
    #[ignore = "Requires an authorized Android device; set NEXUSDESK_MIRROR_TEST_SERIAL to opt in"]
    async fn file_transfers_round_trip_binary_directories_and_special_names() {
        let serial = std::env::var("NEXUSDESK_MIRROR_TEST_SERIAL").expect("set NEXUSDESK_MIRROR_TEST_SERIAL");
        let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let local = std::env::temp_dir().join(format!("nexusdesk-transfer-test-{id}"));
        let remote = format!("/sdcard/Download/.nexusdesk-transfer-test-{id}");
        struct Cleanup { local: PathBuf, remote: String, serial: String }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let mut command = adb();
                command.args(["-s", &self.serial, "shell", &format!("rm -rf -- {}", shell_quote(&self.remote))]);
                let _ = output(command);
                let _ = std::fs::remove_dir_all(&self.local);
            }
        }
        let _cleanup = Cleanup { local: local.clone(), remote: remote.clone(), serial: serial.clone() };
        std::fs::create_dir_all(local.join("source/folder/nested")).unwrap();
        std::fs::create_dir_all(local.join("downloads")).unwrap();
        let name = "中文 ' $file.bin";
        let bytes = vec![0, 255, 1, 128, 10, 13, 0];
        std::fs::write(local.join("source").join(name), &bytes).unwrap();
        let text = "  hello 安卓\n\n";
        std::fs::write(local.join("source/folder/nested/note.txt"), text).unwrap();
        std::fs::write(local.join("source/folder/nested/中文.bin"), &bytes).unwrap();
        let mut mkdir = adb();
        mkdir.args(["-s", &serial, "shell", &format!("mkdir -p -- {}", shell_quote(&remote))]);
        output(mkdir).unwrap();
        for name in [name, "folder"] {
            mirror_push_file(serial.clone(), local.join("source").join(name).to_string_lossy().into_owned(), remote.clone()).await.unwrap();
        }
        let entries = mirror_list_files(serial.clone(), remote.clone()).await.unwrap();
        assert!(entries.iter().any(|entry| entry.name == name), "Uploaded file name changed: {entries:?}");
        // Existing device content must survive another upload of the same name.
        assert!(mirror_push_file(serial.clone(), local.join("source").join(name).to_string_lossy().into_owned(), remote.clone()).await.is_err());
        let directory = local.join("downloads").to_string_lossy().into_owned();
        let remote_file = format!("{remote}/{name}");
        let first = mirror_download_file(serial.clone(), remote_file.clone(), directory.clone()).await.unwrap();
        let second = mirror_download_file(serial.clone(), remote_file, directory.clone()).await.unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).unwrap(), bytes);
        assert_eq!(std::fs::read(second).unwrap(), bytes);
        let folder = mirror_download_file(serial.clone(), format!("{remote}/folder"), directory).await.unwrap();
        assert_eq!(std::fs::read_to_string(std::path::Path::new(&folder).join("nested/note.txt")).unwrap(), text);
        assert_eq!(std::fs::read(std::path::Path::new(&folder).join("nested/中文.bin")).unwrap(), bytes);
        assert_eq!(mirror_read_file(serial, format!("{remote}/folder/nested/note.txt")).await.unwrap().replace("\r\n", "\n"), text);
    }

    #[test]
    fn file_listing_preserves_special_names_and_sorts_directories_first() {
        let entries =
            parse_file_entries("f\0中文 ' $x\n.txt\0d\0Download\0f\0.hidden \0", "/sdcard/")
                .unwrap();
        assert_eq!(entries[0].path, "/sdcard/Download");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].name, ".hidden ");
        assert_eq!(entries[2].name, "中文 ' $x\n.txt");
        assert_eq!(
            parse_file_entries("f\0file\0", "/").unwrap()[0].path,
            "/file"
        );
        assert!(parse_file_entries("f\0../escape\0", "/sdcard").is_err());
        assert!(parse_file_entries("f\0", "/sdcard").is_err());
        assert!(parse_file_entries("", "/sdcard").unwrap().is_empty());
    }

    #[test]
    fn remote_paths_are_absolute_and_shell_values_are_quoted() {
        assert!(remote_path("/sdcard/中文 ' $(id)").is_ok());
        assert!(remote_path("relative").is_err());
        assert!(remote_path("/sdcard/\0").is_err());
        assert_eq!(shell_quote("/sdcard/a'b;$(id)"), "'/sdcard/a'\\''b;$(id)'");
    }

    #[test]
    fn device_discovery_preserves_unavailable_devices_and_ignores_daemon_messages() {
        let devices = parse_devices(
            "* daemon started successfully *\nList of devices attached\n\nphone device product:test model:Pixel_9 transport_id:1\nlocked unauthorized usb:1\nstale offline model:Old_Phone\nusb no permissions (check udev rules)\nadb server version (41) doesn't match\n",
        );
        assert_eq!(devices.len(), 4);
        assert_eq!(devices[0].serial, "phone");
        assert_eq!(devices[0].model, "Pixel 9");
        assert_eq!(devices[1].status, "unauthorized");
        assert_eq!(devices[1].model, "locked");
        assert_eq!(devices[2].status, "offline");
        assert_eq!(devices[3].status, "no permissions");
        assert!(parse_devices("List of devices attached\n\n").is_empty());
    }

    fn session(owner: &str) -> Arc<Session> {
        Arc::new(Session {
            owner: owner.into(),
            serial: "test".into(),
            port: Mutex::new(None),
            child: Mutex::new(None),
            video: Mutex::new(None),
            audio: Mutex::new(None),
            control: Mutex::new(None),
            stopped: AtomicBool::new(false),
            visible: AtomicBool::new(true),
        })
    }

    #[test]
    fn versions_are_explicit_and_scoop_server_discovery_honors_overrides() {
        assert_eq!(
            parse_version("scrcpy 5.0.1 <https://github.com/Genymobile/scrcpy>\nDependencies:")
                .unwrap(),
            "5.0.1"
        );
        assert_eq!(protocol("3.3.4").unwrap(), Protocol::Legacy);
        assert_eq!(protocol("5.0.1").unwrap(), Protocol::SessionMetadata);
        assert!(parse_version("scrcpy 99.0").is_err());
        assert!(parse_version("unrelated tool 5.0.1").is_err());
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-mirror-discovery-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let install = root.join("apps/scrcpy/current");
        std::fs::create_dir_all(&install).unwrap();
        let server = install.join("scrcpy-server");
        std::fs::write(&server, []).unwrap();
        assert_eq!(
            find_server(None, &[root.join("shims"), install.clone()]).unwrap(),
            server
        );
        assert!(find_server(Some(root.join("missing-server")), &[install]).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v5_session_and_rotation_headers_are_skipped_and_flags_normalized() {
        fn session_header(width: u32, height: u32) -> Vec<u8> {
            [
                0x80000000u32.to_be_bytes(),
                width.to_be_bytes(),
                height.to_be_bytes(),
            ]
            .concat()
        }
        fn packet(flags: u8, data: &[u8]) -> Vec<u8> {
            let mut header = vec![0; 12];
            header[0] = flags;
            header[7] = 123;
            header[8..12].copy_from_slice(&(data.len() as u32).to_be_bytes());
            [header, data.to_vec()].concat()
        }
        let config = packet(0x40, &[0, 0, 0, 1, 0x67]);
        let key = packet(0x20, &[0, 0, 0, 1, 0x65]);
        let mut stream = Cursor::new(
            [
                session_header(720, 1280),
                config.clone(),
                key.clone(),
                session_header(1280, 720),
                config.clone(),
                key,
            ]
            .concat(),
        );
        for expected in [0x80, 0x40, 0x80, 0x40] {
            let frame = read_packet(&mut stream, Protocol::SessionMetadata).unwrap();
            assert_eq!(frame[0], expected);
            assert_eq!(frame[7], 123);
            assert_eq!(frame.len(), 17);
        }
        assert!(read_packet(&mut stream, Protocol::SessionMetadata).is_err());
        assert!(
            read_packet(
                &mut Cursor::new(session_header(0, 720)),
                Protocol::SessionMetadata
            )
            .is_err()
        );
        assert!(read_packet(&mut Cursor::new(&config[..13]), Protocol::SessionMetadata).is_err());
    }

    #[test]
    #[ignore = "Requires an authorized Android device; set NEXUSDESK_MIRROR_TEST_SERIAL to opt in"]
    fn installed_scrcpy_streams_h264_and_pcm_and_releases_its_forward() {
        let serial =
            std::env::var("NEXUSDESK_MIRROR_TEST_SERIAL").expect("set NEXUSDESK_MIRROR_TEST_SERIAL");
        let (_, version, _) = server_tools().unwrap();
        let session = Arc::new(Session {
            serial,
            ..Arc::try_unwrap(session("smoke-test")).ok().unwrap()
        });
        let (sender, receiver) = std::sync::mpsc::channel();
        let saw_config = Arc::new(AtomicBool::new(false));
        let config = saw_config.clone();
        let channel = Channel::<Response>::new(move |message| {
            if let tauri::ipc::InvokeResponseBody::Raw(packet) = message {
                if packet.len() > 12 {
                    if packet[0] & 0x80 != 0 {
                        config.store(true, Ordering::Release);
                    }
                    if packet[0] & 0x40 != 0 {
                        let _ = sender.send(packet.len());
                    }
                }
            }
            Ok(())
        });
        let (audio_sender, audio_receiver) = std::sync::mpsc::sync_channel(1);
        let audio_channel = Channel::<Response>::new(move |message| {
            if let tauri::ipc::InvokeResponseBody::Raw(packet) = message {
                let _ = audio_sender.try_send(packet);
            }
            Ok(())
        });
        let started = start(&session, 720, channel, audio_channel);
        let frame = if started.is_ok() {
            receiver.recv_timeout(Duration::from_secs(10)).ok()
        } else {
            None
        };
        let audio = if started.is_ok() {
            audio_receiver.recv_timeout(Duration::from_secs(10)).ok()
        } else {
            None
        };
        let port = session.port.lock().unwrap().clone();
        session.stop();
        started.unwrap();
        assert!(
            saw_config.load(Ordering::Acquire),
            "No H.264 config received"
        );
        assert!(frame.is_some(), "No H.264 keyframe received");
        let audio = audio.expect("No PCM audio received (requires Android 11+)");
        assert!(audio.len() > 12, "Audio capture disabled by device");
        assert_eq!((audio.len() - 12) % 4, 0);
        assert!(session.child.lock().unwrap().is_none());
        assert!(session.audio.lock().unwrap().is_none());
        if let Some(port) = port {
            let mut command = adb();
            command.args(["forward", "--list"]);
            let forwards = output(command).unwrap();
            assert!(
                !forwards
                    .split_whitespace()
                    .any(|entry| entry == format!("tcp:{port}"))
            );
        }
        println!(
            "scrcpy {version}: received H.264 keyframe ({} bytes) and PCM ({} bytes); sockets, child and forward released",
            frame.unwrap(),
            audio.len() - 12
        );
    }

    #[test]
    fn packets_preserve_flags_and_boundaries_and_reject_truncation() {
        let mut frame = vec![0; 12];
        frame[0] = 0xc0;
        frame[11] = 3;
        frame.extend_from_slice(&[0, 1, 2]);
        let mut stream = Cursor::new([frame.clone(), frame.clone()].concat());
        assert_eq!(read_packet(&mut stream, Protocol::Legacy).unwrap(), frame);
        assert_eq!(read_packet(&mut stream, Protocol::Legacy).unwrap(), frame);
        assert!(read_packet(&mut stream, Protocol::Legacy).is_err());
        assert!(read_packet(&mut Cursor::new(&frame[..14]), Protocol::Legacy).is_err());
        frame[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            read_packet(&mut Cursor::new(frame), Protocol::Legacy).unwrap_err(),
            "scrcpy 视频包过大"
        );
    }

    #[test]
    fn raw_audio_headers_and_packets_support_both_protocols() {
        assert!(read_audio_header(&mut Cursor::new(b"\0raw")).is_ok());
        for header in [b"\0\0\0\0", b"\0\0\0\x01", b"opus", b"\0raw".split_at(3).0] {
            assert!(read_audio_header(&mut Cursor::new(header)).is_err());
        }
        for protocol in [Protocol::Legacy, Protocol::SessionMetadata] {
            let mut packet = vec![0; 12];
            packet[11] = 8;
            packet.extend_from_slice(&[0, 128, 255, 127, 0, 0, 255, 255]);
            let mut stream = Cursor::new([packet.clone(), packet.clone()].concat());
            assert_eq!(read_audio_packet(&mut stream, protocol).unwrap(), packet);
            assert_eq!(read_audio_packet(&mut stream, protocol).unwrap(), packet);
            assert!(read_audio_packet(&mut stream, protocol).is_err());
            assert!(read_audio_packet(&mut Cursor::new(&packet[..19]), protocol).is_err());
            for size in [0u32, 3, 4100] {
                let mut invalid = vec![0; 12 + size as usize];
                invalid[8..12].copy_from_slice(&size.to_be_bytes());
                assert!(read_audio_packet(&mut Cursor::new(invalid), protocol).is_err());
            }
        }
    }

    #[test]
    fn stopping_a_session_unblocks_media_reads_and_is_idempotent() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut reader = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, _) = listener.accept().unwrap();
        reader
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let session = session("main");
        *session.video.lock().unwrap() = Some(reader.try_clone().unwrap());
        *session.audio.lock().unwrap() = Some(reader.try_clone().unwrap());
        let worker = thread::spawn(move || reader.read_exact(&mut [0]));
        session.stop();
        session.stop();
        assert!(worker.join().unwrap().is_err());
        assert!(session.stopped.load(Ordering::Acquire));
    }

    #[test]
    fn window_cleanup_preserves_other_windows_and_rejects_foreign_sessions() {
        let state = MirrorState::default();
        let main = session("main");
        let other = session("window-2");
        state
            .0
            .lock()
            .unwrap()
            .extend([("a".into(), main.clone()), ("b".into(), other.clone())]);
        assert!(state.session("main", "b").is_err());
        state.close_window("main");
        assert!(main.stopped.load(Ordering::Acquire));
        assert!(!other.stopped.load(Ordering::Acquire));
        assert_eq!(state.0.lock().unwrap().len(), 1);
        state.shutdown();
        assert!(other.stopped.load(Ordering::Acquire));
        assert!(state.0.lock().unwrap().is_empty());
    }
}
