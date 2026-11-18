use futures_util::{SinkExt, StreamExt};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::Notify, time::timeout};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{ErrorResponse, Request, Response},
        protocol::WebSocketConfig,
    },
};

const MAX_AGE: Duration = Duration::from_millis(120);
const MAX_FRAMES: usize = 6;
const MAX_BYTES: usize = 17 * 1024 * 1024;

struct Frame {
    config: Option<bytes::Bytes>,
    packet: bytes::Bytes,
    queued: Instant,
}

#[derive(Default)]
struct Queue {
    frames: VecDeque<Frame>,
    bytes: usize,
    synced: bool,
    dropped: u64,
}

impl Queue {
    fn discard(&mut self) {
        self.dropped += self.frames.len() as u64;
        self.frames.clear();
        self.bytes = 0;
        self.synced = false;
    }

    fn expire(&mut self, now: Instant) {
        if self
            .frames
            .front()
            .is_some_and(|frame| now.duration_since(frame.queued) > MAX_AGE)
        {
            self.discard();
        }
    }

    fn push(&mut self, packet: Vec<u8>, config: &[u8], now: Instant) -> bool {
        self.expire(now);
        if self.frames.len() >= MAX_FRAMES || self.bytes + packet.len() > MAX_BYTES {
            self.discard();
        }
        let config = if self.synced {
            None
        } else if packet[0] & 0x40 != 0
            && !config.is_empty()
            && packet.len() + config.len() <= MAX_BYTES
        {
            self.synced = true;
            Some(bytes::Bytes::copy_from_slice(config))
        } else {
            self.dropped += 1;
            return false;
        };
        self.bytes += packet.len() + config.as_ref().map_or(0, bytes::Bytes::len);
        self.frames.push_back(Frame {
            config,
            packet: packet.into(),
            queued: now,
        });
        true
    }

    fn pop(&mut self, now: Instant) -> Option<Frame> {
        self.expire(now);
        let frame = self.frames.pop_front()?;
        self.bytes -= frame.packet.len() + frame.config.as_ref().map_or(0, bytes::Bytes::len);
        Some(frame)
    }
}

#[derive(Default)]
struct State {
    queue: Queue,
    fallback: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Notify,
    closed: Notify,
}

pub(super) struct VideoSocket(Arc<Shared>);

impl VideoSocket {
    pub(super) async fn bind(id: String, origin: String) -> std::io::Result<(Self, String)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let path = format!("/{}", uuid::Uuid::new_v4());
        let url = format!("ws://{}{}", listener.local_addr()?, path);
        let shared = Arc::new(Shared::default());
        let task = shared.clone();
        tauri::async_runtime::spawn(async move {
            let result = tokio::select! {
                _ = task.closed.notified() => return,
                result = run(listener, &path, &origin, &task, &id) => result,
            };
            let mut state = task.state.lock().unwrap();
            state.fallback = true;
            state.queue.discard();
            log::warn!(target: "android_mirror", "video socket fallback id={id} reason={result}");
        });
        Ok((Self(shared), url))
    }

    pub(super) fn push(&self, packet: Vec<u8>, config: &[u8]) -> Result<bool, Vec<u8>> {
        let mut state = self.0.state.lock().unwrap();
        if state.fallback {
            return Err(packet);
        }
        let queued = state.queue.push(packet, config, Instant::now());
        if queued {
            self.0.changed.notify_one();
        }
        Ok(queued)
    }

    pub(super) fn discard(&self) {
        self.0.state.lock().unwrap().queue.discard();
    }

    pub(super) fn dropped(&self) -> u64 {
        self.0.state.lock().unwrap().queue.dropped
    }
}

impl Drop for VideoSocket {
    fn drop(&mut self) {
        self.0.closed.notify_one();
    }
}

async fn run(
    listener: TcpListener,
    path: &str,
    origin: &str,
    shared: &Shared,
    id: &str,
) -> &'static str {
    let Ok(Ok(mut socket)) = timeout(Duration::from_secs(3), accept(&listener, path, origin)).await
    else {
        return "handshake timeout or listener error";
    };
    drop(listener);
    log::info!(target: "android_mirror", "video socket connected id={id}");
    loop {
        let frame = tokio::select! {
            _ = socket.next() => return "connection closed",
            frame = async {
                loop {
                    let changed = shared.changed.notified();
                    if let Some(frame) = shared.state.lock().unwrap().queue.pop(Instant::now()) {
                        break frame;
                    }
                    changed.await;
                }
            } => frame,
        };
        if let Some(config) = frame.config {
            if !send(&mut socket, config).await {
                return "configuration acknowledgement failed";
            }
        }
        // 只允许一个未确认的包进入系统缓冲区，从 Worker 收包处施加背压。
        if !send(&mut socket, frame.packet).await {
            return "frame acknowledgement failed";
        }
    }
}

async fn accept(
    listener: &TcpListener,
    path: &str,
    origin: &str,
) -> std::io::Result<WebSocketStream<tokio::net::TcpStream>> {
    loop {
        let (stream, _) = listener.accept().await?;
        stream.set_nodelay(true)?;
        let result = timeout(
            Duration::from_millis(500),
            accept_hdr_async_with_config(
                stream,
                |request: &Request, response: Response| {
                    if request.uri().path_and_query().map(|value| value.as_str()) == Some(path)
                        && request
                            .headers()
                            .get("origin")
                            .and_then(|value| value.to_str().ok())
                            == Some(origin)
                    {
                        Ok(response)
                    } else {
                        let mut denied = ErrorResponse::new(None);
                        *denied.status_mut() = 403.try_into().unwrap();
                        Err(denied)
                    }
                },
                Some(
                    WebSocketConfig::default()
                        .max_message_size(Some(32))
                        .max_frame_size(Some(32)),
                ),
            ),
        )
        .await;
        if let Ok(Ok(socket)) = result {
            return Ok(socket);
        }
    }
}

async fn send(socket: &mut WebSocketStream<tokio::net::TcpStream>, packet: bytes::Bytes) -> bool {
    matches!(
        timeout(Duration::from_secs(2), async {
            socket.send(Message::Binary(packet)).await?;
            Ok::<_, tokio_tungstenite::tungstenite::Error>(socket.next().await)
        }).await,
        Ok(Ok(Some(Ok(Message::Text(ack))))) if ack.as_str() == "ack"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

    #[test]
    fn expired_frames_require_a_fresh_key_with_config() {
        let mut queue = Queue::default();
        let now = Instant::now();
        assert!(queue.push(vec![0x40], &[0x80], now));
        assert!(queue.push(vec![0], &[0x80], now));

        let later = now + MAX_AGE + Duration::from_millis(1);
        assert!(queue.pop(later).is_none());
        assert!(!queue.push(vec![0], &[0x80], later));
        assert!(queue.push(vec![0x40], &[0x81], later));
        let frame = queue.pop(later).unwrap();
        assert_eq!(frame.config.unwrap().as_ref(), &[0x81]);
        assert_eq!(frame.packet.as_ref(), &[0x40]);
        assert_eq!(queue.dropped, 3);
    }

    #[test]
    fn queue_capacity_discards_the_dependent_chain() {
        let mut queue = Queue::default();
        let now = Instant::now();
        assert!(queue.push(vec![0x40], &[0x80], now));
        for _ in 1..MAX_FRAMES {
            assert!(queue.push(vec![0], &[0x80], now));
        }
        assert!(!queue.push(vec![0], &[0x80], now));
        assert!(queue.pop(now).is_none());
        assert!(queue.push(vec![0x40], &[0x80], now));
        assert!(queue.pop(now).unwrap().config.is_some());
    }

    #[tokio::test]
    async fn loopback_requires_matching_origin_and_acknowledgement_before_next_packet() {
        let origin = "http://tauri.localhost";
        let (transport, address) = VideoSocket::bind("test".into(), origin.into())
            .await
            .unwrap();
        let request = |origin: &'static str| {
            let mut request = address.as_str().into_client_request().unwrap();
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
            request
        };
        let rejected = connect_async(request("http://example.com")).await;
        assert!(
            matches!(rejected, Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if response.status().as_u16() == 403)
        );

        let (mut client, _) = connect_async(request(origin)).await.unwrap();
        assert_eq!(transport.push(vec![0x40], &[0x80]), Ok(true));
        assert_eq!(
            client.next().await.unwrap().unwrap().into_data().as_ref(),
            &[0x80]
        );
        assert!(
            timeout(Duration::from_millis(25), client.next())
                .await
                .is_err()
        );
        client.send(Message::Text("ack".into())).await.unwrap();
        assert_eq!(
            client.next().await.unwrap().unwrap().into_data().as_ref(),
            &[0x40]
        );
        client.send(Message::Close(None)).await.unwrap();

        timeout(Duration::from_secs(2), async {
            loop {
                if transport.push(vec![0x40], &[0x80]).is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("落回兼容通道");
    }
}
