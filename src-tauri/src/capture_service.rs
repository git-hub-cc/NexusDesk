//! One detached capture host per user. Persistent authenticated loopback connections
//! are client leases: closing a project releases only its own lease.
use crate::commands::{
    capture_cmds::{self, CaptureState},
    native_capture,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[derive(Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Packet {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    focused: bool,
    #[serde(default)]
    payload: serde_json::Value,
}
struct Peer {
    stream: TcpStream,
    focus: u64,
}
#[derive(Default)]
struct Peers {
    clients: HashMap<u64, Peer>,
    sequence: u64,
    owner: Option<u64>,
}
#[derive(Clone, Default)]
struct Host(Arc<Mutex<Peers>>);
#[derive(Default)]
struct Client {
    stream: Mutex<Option<TcpStream>>,
}

pub fn is_service() -> bool {
    std::env::args_os().any(|arg| arg == "--capture-service")
}
fn directory() -> PathBuf {
    dirs::home_dir()
        .expect("Cannot find home directory")
        .join(".nexus/capture-service")
}
fn send(stream: &mut TcpStream, packet: &Packet) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(packet).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())
}
fn read(reader: &mut BufReader<TcpStream>) -> Result<Packet, String> {
    let mut bytes = Vec::new();
    // Bound messages from local clients rather than allocating an unlimited line.
    use std::io::Read;
    reader
        .take(1024 * 1024)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| format!("read kind={:?} os={:?}: {e}", e.kind(), e.raw_os_error()))?;
    if bytes.last() != Some(&b'\n') {
        return Err(format!("EOF or oversized/incomplete packet (bytes={})", bytes.len()));
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn configure_stream(stream: &TcpStream) -> std::io::Result<()> {
    // Windows accept() inherits FIONBIO from the listener. A read timeout does
    // not restore blocking mode: without this, idle reads fail with WSAEWOULDBLOCK.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(4)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))
}

fn host_running() -> bool {
    let Ok(lease) = OpenOptions::new().create(true).truncate(false).read(true).write(true)
        .open(directory().join("host.lock")) else { return false; };
    // A live (or still starting) host holds this lease. Do not spawn more hosts
    // just because its endpoint is stale or its handshake failed.
    lease.try_lock().is_err()
}

fn reconnect_delay(failures: u32) -> Duration {
    let base = 500 * (1u64 << failures.saturating_sub(1).min(4));
    Duration::from_millis(base + (std::process::id() as u64 * 37 + failures as u64 * 97) % 251)
}
fn selected(peers: &Peers) -> Option<u64> {
    peers
        .clients
        .iter()
        .max_by_key(|(id, peer)| (peer.focus, **id))
        .map(|(id, _)| *id)
}
pub fn emit(app: &tauri::AppHandle, name: &str, payload: serde_json::Value) {
    if let Some(host) = app.try_state::<Host>() {
        let mut peers = host.0.lock().unwrap();
        let target = peers
            .owner
            .filter(|id| peers.clients.contains_key(id))
            .or_else(|| selected(&peers));
        if let Some(peer) = target.and_then(|id| peers.clients.get_mut(&id)) {
            let _ = send(
                &mut peer.stream,
                &Packet {
                    kind: name.into(),
                    payload,
                    ..Default::default()
                },
            );
        }
    } else {
        let _ = app.emit(name, payload);
    }
}
pub fn request(app: &tauri::AppHandle, kind: &str) -> Result<(), String> {
    let client = app.state::<Client>();
    let mut guard = client.stream.lock().unwrap();
    let stream = guard.as_mut().ok_or("截图服务正在连接，请稍后重试")?;
    send(
        stream,
        &Packet {
            kind: kind.into(),
            ..Default::default()
        },
    )
}
fn open() -> Result<BufReader<TcpStream>, String> {
    let endpoint: Endpoint = serde_json::from_slice(
        &std::fs::read(directory().join("endpoint.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut stream = TcpStream::connect_timeout(
        &([127, 0, 0, 1], endpoint.port).into(),
        Duration::from_secs(1),
    )
    .map_err(|e| e.to_string())?;
    configure_stream(&stream).map_err(|e| e.to_string())?;
    send(
        &mut stream,
        &Packet {
            kind: "hello".into(),
            token: endpoint.token,
            ..Default::default()
        },
    )?;
    let mut reader = BufReader::new(stream);
    if read(&mut reader)?.kind != "ready" {
        return Err("截图服务握手失败".into());
    }
    Ok(reader)
}
pub fn connect(app: tauri::AppHandle) {
    app.manage(Client::default());
    // Heartbeats both retain the host and remember the latest focused project.
    let heartbeat = app.clone();
    std::thread::spawn(move || {
        loop {
            let focused = heartbeat
                .windows()
                .values()
                .any(|window| window.is_focused().unwrap_or(false));
            if let Some(stream) = heartbeat.state::<Client>().stream.lock().unwrap().as_mut() {
                let _ = send(
                    stream,
                    &Packet {
                        kind: "ping".into(),
                        focused,
                        ..Default::default()
                    },
                );
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
    std::thread::spawn(move || {
        let mut last_spawn = Instant::now() - Duration::from_secs(10);
        let mut last_warning = Instant::now() - Duration::from_secs(30);
        let mut failures = 0u32;
        loop {
            let error = match open() {
                Ok(mut reader) => {
                    let connected = Instant::now();
                    log::info!("Connected to shared capture service after {failures} failures");
                    *app.state::<Client>().stream.lock().unwrap() =
                        reader.get_ref().try_clone().ok();
                    let error = loop {
                        let packet = match read(&mut reader) {
                            Ok(packet) => packet,
                            Err(error) => break error,
                        };
                        if packet.kind == "status" {
                            *app.state::<CaptureState>().shortcut_error.lock().unwrap() =
                                serde_json::from_value(packet.payload).unwrap_or(None);
                        } else if packet.kind.starts_with("capture-") {
                            let _ = app.emit(&packet.kind, packet.payload);
                        }
                    };
                    *app.state::<Client>().stream.lock().unwrap() = None;
                    if connected.elapsed() >= Duration::from_secs(10) { failures = 0; }
                    format!("disconnected after {}ms: {error}", connected.elapsed().as_millis())
                }
                Err(error) => {
                    if last_spawn.elapsed() >= Duration::from_secs(5) && !host_running() {
                        last_spawn = Instant::now();
                        match std::env::current_exe().map(|exe| {
                            crate::commands::project_cmds::independent_command(exe)
                                .arg("--capture-service")
                                .spawn()
                        }) {
                            Ok(Ok(mut child)) => {
                                std::thread::spawn(move || { let _ = child.wait(); });
                            }
                            other => log::error!("Cannot launch capture service: {other:?}"),
                        }
                    }
                    error
                }
            };
            failures = failures.saturating_add(1);
            let delay = reconnect_delay(failures);
            if last_warning.elapsed() >= Duration::from_secs(30) {
                log::warn!("Capture service unavailable failures={failures} retry_ms={}: {error}", delay.as_millis());
                last_warning = Instant::now();
            }
            std::thread::sleep(delay);
        }
    });
}
fn serve(app: tauri::AppHandle, listener: TcpListener, token: String) {
    std::thread::spawn(move || {
        let mut idle = Instant::now();
        let mut next_id = 0;
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    next_id += 1;
                    let id = next_id;
                    let app = app.clone();
                    let token = token.clone();
                    std::thread::spawn(move || {
                        if let Err(error) = configure_stream(&stream) {
                            log::warn!("Capture peer={id} socket configuration failed: {error}");
                            return;
                        }
                        let mut reader = BufReader::new(stream);
                        let hello = match read(&mut reader) {
                            Ok(hello) => hello,
                            Err(error) => {
                                log::warn!("Capture peer={id} handshake failed: {error}");
                                return;
                            }
                        };
                        if hello.kind != "hello" || hello.token != token {
                            return;
                        }
                        let Ok(writer) = reader.get_ref().try_clone() else {
                            return;
                        };
                        let host = app.state::<Host>();
                        {
                            let mut peers = host.0.lock().unwrap();
                            peers.clients.insert(
                                id,
                                Peer {
                                    stream: writer,
                                    focus: 0,
                                },
                            );
                            let stream = &mut peers.clients.get_mut(&id).unwrap().stream;
                            let _ = send(
                                stream,
                                &Packet {
                                    kind: "ready".into(),
                                    ..Default::default()
                                },
                            );
                            let status = app
                                .state::<CaptureState>()
                                .shortcut_error
                                .lock()
                                .unwrap()
                                .clone();
                            let _ = send(
                                stream,
                                &Packet {
                                    kind: "status".into(),
                                    payload: serde_json::json!(status),
                                    ..Default::default()
                                },
                            );
                        }
                        let connected = Instant::now();
                        loop {
                            let packet = match read(&mut reader) {
                                Ok(packet) => packet,
                                Err(error) => {
                                    if error.starts_with("read kind=") {
                                        log::warn!("Capture peer={id} read failed after {}ms: {error}", connected.elapsed().as_millis());
                                    } else {
                                        log::debug!("Capture peer={id} disconnected after {}ms: {error}", connected.elapsed().as_millis());
                                    }
                                    break;
                                }
                            };
                            match packet.kind.as_str() {
                                "ping" => {
                                    let mut peers = host.0.lock().unwrap();
                                    peers.sequence += 1;
                                    let sequence = peers.sequence;
                                    if let Some(peer) = peers.clients.get_mut(&id) {
                                        if packet.focused {
                                            peer.focus = sequence;
                                        }
                                        if let Err(error) = send(
                                            &mut peer.stream,
                                            &Packet {
                                                kind: "pong".into(),
                                                ..Default::default()
                                            },
                                        ) {
                                            log::warn!("Capture peer={id} heartbeat reply failed: {error}");
                                            break;
                                        }
                                    }
                                }
                                "start" => start(&app, Some(id)),
                                "cancel" => {
                                    if host.0.lock().unwrap().owner == Some(id) {
                                        capture_cmds::capture_cancel(app.clone());
                                    }
                                }
                                _ => {}
                            }
                        }
                        host.0.lock().unwrap().clients.remove(&id);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => {
                    log::error!("Capture listener: {e}");
                    app.exit(1);
                    break;
                }
            }
            let has_clients = !app.state::<Host>().0.lock().unwrap().clients.is_empty();
            let capture_active = app.state::<CaptureState>().active.load(std::sync::atomic::Ordering::SeqCst);
            if has_clients || capture_active {
                idle = Instant::now();
            }
            if idle.elapsed() >= Duration::from_secs(1) {
                app.exit(0);
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}
fn start(app: &tauri::AppHandle, owner: Option<u64>) {
    let host = app.state::<Host>();
    let mut peers = host.0.lock().unwrap();
    // Keep the original recipient until selection and post-processing finish.
    if app
        .state::<CaptureState>()
        .active
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    peers.owner = owner.or_else(|| selected(&peers));
    let result = capture_cmds::start(app);
    drop(peers);
    if let Err(error) = result {
        capture_cmds::report_error(app, error);
    }
}
pub fn run() {
    let result = (|| -> Result<(), String> {
        std::fs::create_dir_all(directory()).map_err(|e| e.to_string())?;
        let lease = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory().join("host.lock"))
            .map_err(|e| e.to_string())?;
        if lease.try_lock().is_err() {
            return Ok(());
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        // RandomState uses independent OS-randomized seeds. The token prevents
        // unauthenticated local pages from issuing loopback capture commands.
        use std::hash::{BuildHasher, Hasher};
        let token = format!(
            "{:016x}{:016x}",
            std::collections::hash_map::RandomState::new()
                .build_hasher()
                .finish(),
            std::collections::hash_map::RandomState::new()
                .build_hasher()
                .finish()
        );
        let endpoint = Endpoint {
            port: listener.local_addr().map_err(|e| e.to_string())?.port(),
            token: token.clone(),
        };
        tauri::Builder::default()
            .manage(lease)
            .manage(Host::default())
            .manage(CaptureState::default())
            .plugin(tauri_plugin_dialog::init())
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                            return;
                        }
                        if shortcut.key == tauri_plugin_global_shortcut::Code::F3 {
                            if let Err(error) = capture_cmds::toggle_pin(app) {
                                capture_cmds::report_error(app, error);
                            }
                        } else {
                            start(app, None);
                        }
                    })
                    .build(),
            )
            .setup(move |app| {
                native_capture::init(app.handle().clone())?;
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let mut errors = Vec::new();
                for key in ["F3", "Alt+A"] {
                    if let Err(error) = app.global_shortcut().register(key) {
                        log::error!("Cannot register {key}: {error}");
                        errors.push(format!("{key} 注册失败：{error}"));
                    }
                }
                *app.state::<CaptureState>().shortcut_error.lock().unwrap() =
                    (!errors.is_empty()).then(|| errors.join("；"));
                std::fs::write(
                    directory().join("endpoint.json"),
                    serde_json::to_vec(&endpoint)?,
                )?;
                log::info!("Shared capture service ready on port {}", endpoint.port);
                serve(app.handle().clone(), listener, token);
                Ok(())
            })
            .build(tauri::generate_context!())
            .map_err(|e| e.to_string())?
            .run(|app, event| match event {
                tauri::RunEvent::ExitRequested {
                    code: None, api, ..
                } => api.prevent_exit(),
                tauri::RunEvent::Exit => app.state::<CaptureState>().shutdown(),
                _ => {}
            });
        Ok(())
    })();
    if let Err(error) = result {
        log::error!("Capture service failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        (client, listener.accept().unwrap().0)
    }
    #[test]
    fn accepted_connection_waits_for_delayed_heartbeat_and_preserves_buffered_packets() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let server = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("accept failed: {error}"),
            }
        };
        configure_stream(&server).unwrap();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            client.write_all(b"{\"kind\":\"hello\"}\n{\"kind\":\"ping\"}\n").unwrap();
            std::thread::sleep(Duration::from_millis(100));
            client.write_all(b"{\"kind\":\"ping\"}\n").unwrap();
        });
        let mut reader = BufReader::new(server);
        assert_eq!(read(&mut reader).unwrap().kind, "hello");
        assert_eq!(read(&mut reader).unwrap().kind, "ping");
        assert_eq!(read(&mut reader).unwrap().kind, "ping");
        writer.join().unwrap();
        assert!(read(&mut reader).is_err());
    }
    #[test]
    fn repeated_disconnects_back_off_with_a_bounded_delay() {
        assert!(reconnect_delay(1) >= Duration::from_millis(500));
        assert!(reconnect_delay(2) >= Duration::from_secs(1));
        assert!(reconnect_delay(1000) <= Duration::from_millis(8250));
    }
    #[test]
    fn closing_project_a_keeps_project_b_connected() {
        let (a, a_server) = pair();
        let (b, b_server) = pair();
        let mut peers = Peers::default();
        peers.clients.insert(
            1,
            Peer {
                stream: a_server,
                focus: 2,
            },
        );
        peers.clients.insert(
            2,
            Peer {
                stream: b_server,
                focus: 1,
            },
        );
        assert_eq!(selected(&peers), Some(1));
        drop(a);
        let mut a_reader =
            BufReader::new(peers.clients.get(&1).unwrap().stream.try_clone().unwrap());
        assert!(read(&mut a_reader).is_err());
        peers.clients.remove(&1);
        assert_eq!(selected(&peers), Some(2));
        send(
            &mut peers.clients.get_mut(&2).unwrap().stream,
            &Packet {
                kind: "capture-complete".into(),
                payload: serde_json::json!({"text":"识别结果"}),
                ..Default::default()
            },
        )
        .unwrap();
        let packet = read(&mut BufReader::new(b)).unwrap();
        assert_eq!(packet.kind, "capture-complete");
        assert_eq!(packet.payload["text"], "识别结果");
    }
    #[test]
    fn service_lease_prevents_duplicate_hosts_and_recovers_after_exit() {
        let path =
            std::env::temp_dir().join(format!("nexusdesk-capture-lease-{}.lock", std::process::id()));
        let open = || {
            OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&path)
                .unwrap()
        };
        let first = open();
        first.try_lock().unwrap();
        let second = open();
        assert!(second.try_lock().is_err());
        drop(first);
        second.try_lock().unwrap();
        drop(second);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn protocol_rejects_incomplete_or_oversized_messages() {
        let (mut client, server) = pair();
        client.write_all(b"{\"kind\":\"start\"}").unwrap();
        drop(client);
        assert!(read(&mut BufReader::new(server)).is_err());
        let (mut client, server) = pair();
        let writer = std::thread::spawn(move || {
            let _ = client.write_all(&vec![b'x'; 1024 * 1024 + 1]);
        });
        assert!(read(&mut BufReader::new(server)).is_err());
        writer.join().unwrap();
    }
}
