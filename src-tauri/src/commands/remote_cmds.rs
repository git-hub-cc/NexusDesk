use super::terminal_cmds::TerminalEvent;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    sync::{Mutex, mpsc},
    time::{Duration, Instant},
};
use tauri::{State, ipc::Channel};

type Reply = mpsc::Sender<Result<serde_json::Value, String>>;
enum Request {
    Files(String, Reply),
    Read(String, Reply),
    ReadBinary(String, usize, Reply),
    Write(String, String, Reply),
    Operation(String, String, Option<String>, Reply),
    Upload(String, String, Reply),
    Shell(
        String,
        Option<String>,
        String,
        u16,
        u16,
        Channel<TerminalEvent>,
        Reply,
    ),
    Input(String, String),
    Resize(String, u16, u16),
    CloseShell(String),
    Close,
}
#[derive(Default)]
pub struct RemoteState(Mutex<HashMap<String, mpsc::Sender<Request>>>);

impl RemoteState {
    pub fn shutdown(&self) {
        let connections =
            std::mem::take(&mut *self.0.lock().unwrap_or_else(|error| error.into_inner()));
        for connection in connections.into_values() {
            let _ = connection.send(Request::Close);
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    host: String,
    port: u16,
    username: String,
    password: String,
    fingerprint: Option<String>,
}

#[tauri::command]
pub async fn connect_remote(
    config: Connection,
    id: String,
    state: State<'_, RemoteState>,
) -> Result<serde_json::Value, String> {
    if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("Invalid connection ID".into());
    }
    let saved_config = serde_json::to_vec(&config).map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::channel();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        if config.host.trim().is_empty() || config.username.trim().is_empty() || config.port == 0 {
            return Err("请填写有效的主机、端口和用户名".into());
        }
        let addresses = (config.host.as_str(), config.port)
            .to_socket_addrs()
            .map_err(|e| e.to_string())?;
        let mut socket = None;
        for address in addresses {
            if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
                socket = Some(stream);
                break;
            }
        }
        let socket = socket.ok_or("连接服务器失败，请检查地址和端口")?;
        let mut ssh = ssh2::Session::new().map_err(|e| e.to_string())?;
        ssh.set_tcp_stream(socket);
        ssh.set_timeout(10000);
        ssh.handshake().map_err(|e| e.to_string())?;
        let hash = ssh
            .host_key_hash(ssh2::HashType::Sha256)
            .ok_or("无法读取 SSH 主机指纹")?;
        let fingerprint = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();
        if config.fingerprint.as_deref() != Some(&fingerprint) {
            return Ok((
                serde_json::json!({"fingerprint": fingerprint, "trusted": false}),
                None,
            ));
        }
        ssh.userauth_password(&config.username, &config.password)
            .map_err(|e| format!("SSH 认证失败：{e}"))?;
        if !ssh.authenticated() {
            return Err("SSH 认证失败".into());
        }
        // libssh2 keepalive requests are driven by the worker even when the shell is idle.
        ssh.set_keepalive(true, 30);
        let sftp = ssh.sftp().map_err(|e| e.to_string())?;
        let home = sftp
            .realpath(Path::new("."))
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        Ok((
            serde_json::json!({"trusted": true, "home": home, "fingerprint": fingerprint}),
            Some((ssh, sftp)),
        ))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some((ssh, sftp)) = result.1 {
        let dir = dirs::config_dir()
            .ok_or("SFTP operation failed; check connection, path and permissions")?
            .join("NexusDesk")
            .join("sftp-connections");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(&id), saved_config).map_err(|e| e.to_string())?;
        state.0.lock().map_err(|e| e.to_string())?.insert(id, tx);
        std::thread::spawn(move || worker(ssh, sftp, rx));
    }
    Ok(result.0)
}

struct RemoteShell {
    channel: ssh2::Channel,
    events: Channel<TerminalEvent>,
    pending: Vec<u8>,
}

fn remove_remote_entry(sftp: &ssh2::Sftp, path: &Path) -> Result<(), String> {
    let stat = sftp.lstat(path).map_err(|e| e.to_string())?;
    if stat.is_dir() {
        for (child, _) in sftp.readdir(path).map_err(|e| e.to_string())? {
            if child
                .file_name()
                .is_some_and(|name| name != "." && name != "..")
            {
                remove_remote_entry(sftp, &child)?;
            }
        }
        sftp.rmdir(path).map_err(|e| e.to_string())
    } else {
        sftp.unlink(path).map_err(|e| e.to_string())
    }
}

fn remote_operation(
    sftp: &ssh2::Sftp,
    operation: &str,
    path: &str,
    content: Option<String>,
) -> Result<serde_json::Value, String> {
    match operation {
        "upload_bytes" => {
            let bytes: Vec<u8> = serde_json::from_str(
                &content.ok_or("SFTP operation failed; check connection, path and permissions")?,
            )
            .map_err(|e| e.to_string())?;
            let mut file = sftp
                .open_mode(
                    Path::new(path),
                    ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                    0o644,
                    ssh2::OpenType::File,
                )
                .map_err(|e| e.to_string())?;
            let result = file
                .write_all(&bytes)
                .and_then(|_| file.close().map_err(std::io::Error::other));
            if result.is_err() {
                let _ = sftp.unlink(Path::new(path));
            }
            result.map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "stat" => Ok(serde_json::json!(
            sftp.stat(Path::new(path))
                .map(|stat| stat.is_dir())
                .unwrap_or(false)
        )),
        "mkdir" => {
            sftp.mkdir(Path::new(path), 0o755)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "create" => {
            sftp.open_mode(
                Path::new(path),
                ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                0o644,
                ssh2::OpenType::File,
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "rename" => {
            let target = content.ok_or("缺少目标路径")?;
            sftp.rename(
                Path::new(path),
                Path::new(&target),
                Some(ssh2::RenameFlags::empty()),
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::json!(target))
        }
        "delete" => {
            if path.trim_end_matches('/').is_empty() {
                return Err("不能删除服务器根目录".into());
            }
            remove_remote_entry(sftp, Path::new(path))?;
            Ok(serde_json::Value::Null)
        }
        _ => Err("不支持的远程文件操作".into()),
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn worker(ssh: ssh2::Session, sftp: ssh2::Sftp, rx: mpsc::Receiver<Request>) {
    let mut shells = HashMap::<String, RemoteShell>::new();
    let mut last_keepalive = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(15)) {
            Ok(Request::Close) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Ok(Request::Input(id, data)) => {
                if let Some(shell) = shells.get_mut(&id) {
                    shell.pending.extend_from_slice(data.as_bytes());
                }
            }
            Ok(Request::Resize(id, cols, rows)) => {
                if let Some(shell) = shells.get_mut(&id) {
                    let _ = shell.channel.request_pty_size(
                        cols.max(1) as u32,
                        rows.max(1) as u32,
                        None,
                        None,
                    );
                }
            }
            Ok(Request::CloseShell(id)) => {
                if let Some(mut shell) = shells.remove(&id) {
                    let _ = shell.channel.close();
                }
            }
            Ok(request) => {
                ssh.set_blocking(true);
                let (reply, result) = match request {
                    Request::Upload(source, target, reply) => {
                        (reply, upload_local(&sftp, Path::new(&source), &target))
                    }
                    Request::Operation(operation, path, content, reply) => {
                        (reply, remote_operation(&sftp, &operation, &path, content))
                    }
                    Request::Files(path, reply) => {
                        let result = sftp.readdir(Path::new(&path)).map(|entries| {
                            let mut entries: Vec<_> = entries.into_iter().filter_map(|(path, stat)| {
                                let name = path.file_name()?.to_string_lossy().into_owned();
                                if name == "." || name == ".." { return None; }
                                let directory = stat.is_dir() || (stat.perm.map(|mode| mode & 0o170000 == 0o120000).unwrap_or(false) && sftp.stat(&path).map(|target| target.is_dir()).unwrap_or(false));
                                Some(serde_json::json!({"path": path.to_string_lossy(), "name": name, "directory": directory, "size": stat.size}))
                            }).collect();
                            entries.sort_by(|a, b| b["directory"].as_bool().cmp(&a["directory"].as_bool()).then_with(|| a["name"].as_str().cmp(&b["name"].as_str())));
                            serde_json::json!(entries)
                        }).map_err(|e| e.to_string());
                        (reply, result)
                    }
                    Request::Read(path, reply) => {
                        let result = (|| -> Result<_, String> {
                            let file = sftp.open(Path::new(&path)).map_err(|e| e.to_string())?;
                            let mut bytes = Vec::new();
                            file.take(4 * 1024 * 1024 + 1)
                                .read_to_end(&mut bytes)
                                .map_err(|e| e.to_string())?;
                            if bytes.len() > 4 * 1024 * 1024 {
                                return Err("仅支持编辑 4 MB 以内的文本文件".into());
                            }
                            if bytes.contains(&0) {
                                return Err("不支持编辑二进制文件".into());
                            }
                            Ok(serde_json::json!(
                                String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本")?
                            ))
                        })();
                        (reply, result)
                    }
                    Request::ReadBinary(path, max_size_bytes, reply) => {
                        let result = (|| -> Result<_, String> {
                            let file = sftp.open(Path::new(&path)).map_err(|e| e.to_string())?;
                            let mut bytes = Vec::new();
                            file.take(max_size_bytes.saturating_add(1) as u64)
                                .read_to_end(&mut bytes)
                                .map_err(|e| e.to_string())?;
                            if bytes.len() > max_size_bytes {
                                return Err(format!(
                                    "图片文件超过 {} MB 限制",
                                    max_size_bytes / (1024 * 1024)
                                ));
                            }
                            Ok(serde_json::json!(bytes))
                        })();
                        (reply, result)
                    }
                    Request::Write(path, content, reply) => {
                        let path = match sftp.realpath(Path::new(&path)) {
                            Ok(target) => target.to_string_lossy().into_owned(),
                            Err(error) => {
                                let _ = reply.send(Err(error.to_string()));
                                ssh.set_blocking(false);
                                continue;
                            }
                        };
                        // Write a sibling temporary file, then atomically replace to avoid partial saves.
                        let nonce = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_nanos();
                        let temp = format!("{path}.nexusdesk-{}-{nonce}.tmp", std::process::id());
                        let mut created = false;
                        let result = (|| -> Result<_, String> {
                            let stat = sftp.stat(Path::new(&path)).map_err(|e| e.to_string())?;
                            let mut file = match sftp.open_mode(
                                Path::new(&temp),
                                ssh2::OpenFlags::WRITE
                                    | ssh2::OpenFlags::CREATE
                                    | ssh2::OpenFlags::EXCLUSIVE,
                                stat.perm.unwrap_or(0o600) as i32 & 0o777,
                                ssh2::OpenType::File,
                            ) {
                                Ok(file) => file,
                                // A writable file need not have a writable parent directory.
                                Err(error) if error.code() == ssh2::ErrorCode::SFTP(3) => {
                                    write_existing_file(&sftp, &path, &content)?;
                                    return Ok(serde_json::Value::Null);
                                }
                                Err(error) => {
                                    return Err(format!(
                                        "Cannot create remote save temporary file: {error}"
                                    ));
                                }
                            };
                            created = true;
                            file.write_all(content.as_bytes())
                                .map_err(|e| e.to_string())?;
                            file.close().map_err(|e| e.to_string())?;
                            if let Err(error) = sftp.rename(
                                Path::new(&temp),
                                Path::new(&path),
                                Some(ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::OVERWRITE),
                            ) {
                                if !rename_needs_direct_write(&error) {
                                    return Err(format!("Cannot replace remote file: {error}"));
                                }
                                // SFTP v3 servers may not implement atomic/overwrite rename.
                                // Never unlink the original file to emulate replacement.
                                write_existing_file(&sftp, &path, &content)?;
                                let _ = sftp.unlink(Path::new(&temp));
                            }
                            Ok(serde_json::Value::Null)
                        })();
                        if created && result.is_err() {
                            let _ = sftp.unlink(Path::new(&temp));
                        }
                        (reply, result)
                    }
                    Request::Shell(id, cwd, command, cols, rows, events, reply) => {
                        let result = (|| -> Result<_, String> {
                            if shells.contains_key(&id) {
                                return Err("远程 Shell 已启动".into());
                            }
                            let mut channel = ssh.channel_session().map_err(|e| e.to_string())?;
                            channel
                                .request_pty(
                                    "xterm-256color",
                                    None,
                                    Some((cols.max(1) as u32, rows.max(1) as u32, 0, 0)),
                                )
                                .map_err(|e| e.to_string())?;
                            channel
                                .handle_extended_data(ssh2::ExtendedData::Merge)
                                .map_err(|e| e.to_string())?;
                            channel.shell().map_err(|e| e.to_string())?;
                            let mut pending = Vec::new();
                            if let Some(cwd) = cwd {
                                if cwd.chars().any(|ch| ch.is_control()) {
                                    return Err("远程终端目录包含控制字符".into());
                                }
                                pending.extend_from_slice(
                                    format!("cd -- {}\n", shell_quote(&cwd)).as_bytes(),
                                );
                            }
                            if !command.trim().is_empty() {
                                pending.extend_from_slice(format!("{command}\n").as_bytes());
                            }
                            shells.insert(
                                id,
                                RemoteShell {
                                    channel,
                                    events,
                                    pending,
                                },
                            );
                            Ok(serde_json::Value::Null)
                        })();
                        (reply, result)
                    }
                    _ => unreachable!(),
                };
                ssh.set_blocking(false);
                let _ = reply.send(result);
            }
        }
        ssh.set_blocking(false);
        if last_keepalive.elapsed() >= Duration::from_secs(30) {
            if let Err(error) = ssh.keepalive_send() {
                if error.code() != ssh2::ErrorCode::Session(-37) {
                    break;
                }
            }
            last_keepalive = Instant::now();
        }
        let mut exited = Vec::new();
        for (id, shell) in &mut shells {
            if !shell.pending.is_empty() {
                match shell.channel.write(&shell.pending) {
                    Ok(n) => {
                        shell.pending.drain(..n);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => {
                        exited.push(id.clone());
                        continue;
                    }
                }
            }
            let mut buffer = [0u8; 16384];
            match shell.channel.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    if shell
                        .events
                        .send(TerminalEvent::Output(buffer[..n].to_vec()))
                        .is_err()
                    {
                        exited.push(id.clone());
                        continue;
                    }
                }
                Err(e) if e.kind() != std::io::ErrorKind::WouldBlock => {
                    exited.push(id.clone());
                    continue;
                }
                _ => {}
            }
            if shell.channel.eof() {
                exited.push(id.clone());
            }
        }
        for id in exited {
            if let Some(shell) = shells.remove(&id) {
                let _ = shell.events.send(TerminalEvent::Exit);
            }
        }
    }
    for (_, shell) in shells {
        let _ = shell.events.send(TerminalEvent::Exit);
    }
    let _ = ssh.disconnect(None, "NexusDesk disconnected", None);
}

fn sender(state: &RemoteState, id: &str) -> Result<mpsc::Sender<Request>, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or("远程连接已关闭".into())
}

#[tauri::command]
pub async fn remote_files(
    id: String,
    operation: String,
    path: String,
    content: Option<String>,
    state: State<'_, RemoteState>,
) -> Result<serde_json::Value, String> {
    let sender = sender(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        let request = match operation.as_str() {
            "upload" => Request::Upload(
                content.ok_or("SFTP operation failed; check connection, path and permissions")?,
                path,
                tx,
            ),
            "list" => Request::Files(path, tx),
            "read" => Request::Read(path, tx),
            "read_binary" => {
                let max_size_bytes = content
                    .ok_or("缺少图片大小限制")?
                    .parse::<usize>()
                    .map_err(|_| "无效的图片大小限制")?;
                if max_size_bytes == 0 {
                    return Err("图片大小限制必须大于 0".into());
                }
                Request::ReadBinary(path, max_size_bytes, tx)
            }
            "write" => Request::Write(path, content.ok_or("缺少文件内容")?, tx),
            "upload_bytes" | "stat" | "create" | "mkdir" | "rename" | "delete" => {
                Request::Operation(operation, path, content, tx)
            }
            _ => return Err("不支持的远程操作".into()),
        };
        sender.send(request).map_err(|_| "远程连接已断开")?;
        rx.recv().map_err(|_| "远程连接已断开")?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_remote_terminal(
    id: String,
    terminal_id: String,
    cwd: Option<String>,
    command: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
    state: State<'_, RemoteState>,
) -> Result<(), String> {
    let sender = sender(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        sender
            .send(Request::Shell(
                terminal_id,
                cwd,
                command,
                cols,
                rows,
                on_event,
                tx,
            ))
            .map_err(|_| "远程连接已断开")?;
        rx.recv().map_err(|_| "远程连接已断开")??;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn write_remote_terminal(
    id: String,
    terminal_id: String,
    data: String,
    state: State<'_, RemoteState>,
) -> Result<(), String> {
    sender(&state, &id)?
        .send(Request::Input(terminal_id, data))
        .map_err(|_| "远程连接已断开".into())
}
#[tauri::command]
pub fn resize_remote_terminal(
    id: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, RemoteState>,
) -> Result<(), String> {
    sender(&state, &id)?
        .send(Request::Resize(terminal_id, cols, rows))
        .map_err(|_| "远程连接已断开".into())
}
#[tauri::command]
pub fn close_remote_terminal(
    id: String,
    terminal_id: String,
    state: State<'_, RemoteState>,
) -> Result<(), String> {
    sender(&state, &id)?
        .send(Request::CloseShell(terminal_id))
        .map_err(|_| "远程连接已断开".into())
}
#[tauri::command]
pub fn close_remote(id: String, state: State<'_, RemoteState>) -> Result<(), String> {
    if let Some(sender) = state.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = sender.send(Request::Close);
    }
    Ok(())
}

// Connection IDs are generated UUIDs; never accept filesystem components here.
#[tauri::command]
pub async fn reconnect_remote(
    id: String,
    state: State<'_, RemoteState>,
) -> Result<serde_json::Value, String> {
    if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("SFTP operation failed; check connection, path and permissions".into());
    }
    if state.0.lock().map_err(|e| e.to_string())?.contains_key(&id) {
        return Ok(serde_json::json!({"trusted": true}));
    }
    let path = dirs::config_dir()
        .ok_or("SFTP operation failed; check connection, path and permissions")?
        .join("NexusDesk")
        .join("sftp-connections")
        .join(&id);
    let config = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    connect_remote(config, id, state).await
}

fn upload_local(
    sftp: &ssh2::Sftp,
    source: &Path,
    target: &str,
) -> Result<serde_json::Value, String> {
    let metadata = std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("SFTP operation failed; check connection, path and permissions".into());
    }
    if metadata.is_dir() {
        if let Ok(stat) = sftp.stat(Path::new(target)) {
            if !stat.is_dir() {
                return Err(format!(
                    "Upload target already exists or is not a directory: {target}"
                ));
            }
        } else {
            sftp.mkdir(Path::new(target), 0o755)
                .map_err(|e| e.to_string())?;
        }
        for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            upload_local(
                sftp,
                &entry.path(),
                &format!(
                    "{}/{}",
                    target.trim_end_matches('/'),
                    entry.file_name().to_string_lossy()
                ),
            )?;
        }
    } else {
        if sftp.lstat(Path::new(target)).is_ok() {
            return Err(format!(
                "Upload target already exists or is not a directory: {target}"
            ));
        }
        let mut input = std::fs::File::open(source).map_err(|e| e.to_string())?;
        let mut output = sftp
            .open_mode(
                Path::new(target),
                ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                0o644,
                ssh2::OpenType::File,
            )
            .map_err(|e| e.to_string())?;
        let result = std::io::copy(&mut input, &mut output)
            .map_err(|e| e.to_string())
            .and_then(|_| output.close().map_err(|e| e.to_string()));
        if result.is_err() {
            let _ = sftp.unlink(Path::new(target));
        }
        result?;
    }
    Ok(serde_json::Value::Null)
}

fn rename_needs_direct_write(error: &ssh2::Error) -> bool {
    // Some SFTP v3 servers report generic FAILURE when overwrite rename is unavailable.
    matches!(
        error.code(),
        ssh2::ErrorCode::SFTP(4) | ssh2::ErrorCode::SFTP(8) | ssh2::ErrorCode::Session(-33)
    )
}

fn write_existing_file(sftp: &ssh2::Sftp, path: &str, content: &str) -> Result<(), String> {
    // No CREATE: a file removed since it was opened must remain a save error.
    let mut file = sftp
        .open_mode(
            Path::new(path),
            ssh2::OpenFlags::WRITE | ssh2::OpenFlags::TRUNCATE,
            0,
            ssh2::OpenType::File,
        )
        .map_err(|e| format!("Cannot open remote file for saving: {e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Cannot write remote file: {e}"))?;
    file.close()
        .map_err(|e| format!("Cannot close remote saved file: {e}"))
}

#[cfg(test)]
mod save_tests {
    use super::*;
    #[test]
    fn fallback_for_generic_or_unsupported_rename() {
        assert!(rename_needs_direct_write(&ssh2::Error::new(
            ssh2::ErrorCode::SFTP(8),
            "unsupported"
        )));
        assert!(rename_needs_direct_write(&ssh2::Error::new(
            ssh2::ErrorCode::Session(-33),
            "unsupported"
        )));
        assert!(rename_needs_direct_write(&ssh2::Error::new(
            ssh2::ErrorCode::SFTP(4),
            "failure"
        )));
        for code in [2, 3, 6, 7] {
            assert!(!rename_needs_direct_write(&ssh2::Error::new(
                ssh2::ErrorCode::SFTP(code),
                "failure"
            )));
        }
    }
}
