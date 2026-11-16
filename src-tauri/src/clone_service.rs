use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    process::{Child, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub(crate) const WORKER_ARGUMENT: &str = "--git-clone-worker";

#[derive(Deserialize, Serialize)]
pub(crate) struct CloneInput {
    pub url: String,
    pub target_path: String,
    pub token: String,
    pub host: Option<String>,
}

pub(crate) fn run_worker() {
    let mut stdin = BufReader::new(std::io::stdin());
    let mut line = String::new();
    let result = stdin
        .read_line(&mut line)
        .map_err(|error| format!("无法读取克隆参数：{error}"))
        .and_then(|_| serde_json::from_str::<CloneInput>(&line).map_err(|error| error.to_string()))
        .and_then(|input| {
            // 主进程退出会关闭管道，工作进程随之退出，避免后台遗留克隆任务。
            std::thread::spawn(move || {
                let _ = stdin.read(&mut [0]);
                std::process::exit(1);
            });
            clone_repository(input)
        });
    let success = result.is_ok();
    let mut stdout = std::io::stdout().lock();
    let written = serde_json::to_writer(&mut stdout, &result).is_ok() && stdout.flush().is_ok();
    drop(stdout);
    std::process::exit(if success && written { 0 } else { 1 });
}

fn clone_repository(input: CloneInput) -> Result<(), String> {
    let mut callbacks = git2::RemoteCallbacks::new();
    if let Some(host) = input.host.as_deref() {
        callbacks.credentials(|credential_url, _, allowed| {
            let trusted = reqwest::Url::parse(credential_url)
                .is_ok_and(|url| url.scheme() == "https" && url.host_str() == Some(host));
            if trusted && allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
                git2::Cred::userpass_plaintext("oauth2", &input.token)
            } else {
                Err(git2::Error::from_str("无法为该地址提供凭据"))
            }
        });
    }
    let mut fetch = git2::FetchOptions::new();
    fetch.remote_callbacks(callbacks);
    git2::build::RepoBuilder::new()
        .fetch_options(fetch)
        .clone(&input.url, std::path::Path::new(&input.target_path))
        .map(drop)
        .map_err(|error| error.to_string())
}

pub(crate) fn run(input: &CloneInput, cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("克隆已取消".into());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    // 使用文件接收结果，避免较长的错误信息填满管道后阻塞工作进程退出。
    let mut output = tempfile::tempfile().map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command
        .arg(WORKER_ARGUMENT)
        .stdin(Stdio::piped())
        .stdout(output.try_clone().map_err(|error| error.to_string())?)
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = CloneChild(
        command
            .spawn()
            .map_err(|error| format!("无法启动克隆进程：{error}"))?,
    );
    // Token 仅通过标准输入传递，不写入命令行或临时参数文件。
    let stdin = child.0.stdin.as_mut().ok_or("无法打开克隆进程输入")?;
    serde_json::to_writer(&mut *stdin, input)
        .map_err(|error| format!("无法传递克隆参数：{error}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("无法传递克隆参数：{error}"))?;
    let status = wait_for_child(&mut child, cancelled)?;
    output
        .seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let result: Result<(), String> =
        serde_json::from_reader(output).map_err(|_| format!("克隆进程异常退出（{status}）"))?;
    result?;
    if !status.success() {
        return Err(format!("克隆进程异常退出（{status}）"));
    }
    Ok(())
}

struct CloneChild(Child);

impl Drop for CloneChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_for_child(child: &mut CloneChild, cancelled: &AtomicBool) -> Result<ExitStatus, String> {
    loop {
        if cancelled.load(Ordering::Relaxed) {
            child
                .0
                .kill()
                .or_else(|error| child.0.try_wait()?.map(|_| ()).ok_or(error))
                .map_err(|error| format!("无法终止克隆进程：{error}"))?;
            child
                .0
                .wait()
                .map_err(|error| format!("无法等待克隆进程退出：{error}"))?;
            return Err("克隆已取消".into());
        }
        if let Some(status) = child.0.try_wait().map_err(|error| error.to_string())? {
            return Ok(status);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, path::Path, time::Instant};

    fn create_repository(path: &Path) {
        let repo = git2::Repository::init(path).unwrap();
        let mut index = repo.index().unwrap();
        for i in 0..100 {
            let name = format!("file{i:03}.txt");
            std::fs::write(path.join(&name), "content").unwrap();
            index.add_path(Path::new(&name)).unwrap();
        }
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
    }

    #[test]
    fn local_clone_preserves_contents_and_errors() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        create_repository(&source);
        let input = CloneInput {
            url: source.to_str().unwrap().to_string(),
            target_path: target.to_str().unwrap().to_string(),
            token: String::new(),
            host: None,
        };
        clone_repository(input).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("file099.txt")).unwrap(),
            "content"
        );
        assert!(git2::Repository::open(&target).is_ok());
        assert!(
            clone_repository(CloneInput {
                url: directory
                    .path()
                    .join("missing")
                    .to_str()
                    .unwrap()
                    .to_string(),
                target_path: directory
                    .path()
                    .join("failed")
                    .to_str()
                    .unwrap()
                    .to_string(),
                token: String::new(),
                host: None,
            })
            .is_err()
        );
    }

    #[test]
    fn cancellation_interrupts_network_wait_and_checkout() {
        for stage in ["network", "checkout"] {
            let directory = tempfile::tempdir().unwrap();
            let target = directory.path().join("target");
            std::fs::create_dir(&target).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let url = if stage == "network" {
                format!("http://{address}/repo.git")
            } else {
                let source = directory.path().join("source");
                create_repository(&source);
                source.to_str().unwrap().to_string()
            };
            let input = CloneInput {
                url,
                target_path: target.to_str().unwrap().to_string(),
                token: String::new(),
                host: None,
            };
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "clone_service::tests::clone_worker",
                    "--ignored",
                    "--nocapture",
                ])
                .env(
                    "NEXUSDESK_CLONE_TEST_INPUT",
                    serde_json::to_string(&input).unwrap(),
                )
                .env("NEXUSDESK_CLONE_TEST_STAGE", stage)
                .env("NEXUSDESK_CLONE_TEST_ADDRESS", address.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = CloneChild(command.spawn().unwrap());
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "{stage}: 工作进程未就绪");
                        assert!(
                            child.0.try_wait().unwrap().is_none(),
                            "{stage}: 工作进程提前退出"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            if stage == "network" {
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                assert!(stream.read(&mut [0; 4096]).unwrap() > 0);
            } else {
                assert!(target.join("file000.txt").exists());
                assert!(!target.join("file099.txt").exists());
            }
            let started = Instant::now();
            let error = wait_for_child(&mut child, &AtomicBool::new(true)).unwrap_err();
            assert_eq!(error, "克隆已取消");
            assert!(started.elapsed() < Duration::from_secs(2), "{stage}");
            assert!(child.0.try_wait().unwrap().is_some());
            std::fs::remove_dir_all(&target).unwrap();
            assert!(!target.exists());
        }
    }

    #[test]
    #[ignore = "由取消测试在独立进程中调用"]
    fn clone_worker() {
        let input: CloneInput =
            serde_json::from_str(&std::env::var("NEXUSDESK_CLONE_TEST_INPUT").unwrap()).unwrap();
        if std::env::var("NEXUSDESK_CLONE_TEST_STAGE").unwrap() == "network" {
            let _ = clone_repository(input);
        } else {
            let mut checkout = git2::build::CheckoutBuilder::new();
            let mut notified = false;
            checkout.progress(move |_, completed, _| {
                if completed > 0 && !notified {
                    notified = true;
                    let _stream = std::net::TcpStream::connect(
                        std::env::var("NEXUSDESK_CLONE_TEST_ADDRESS").unwrap(),
                    )
                    .unwrap();
                    std::thread::sleep(Duration::from_secs(10));
                }
            });
            let _ = git2::build::RepoBuilder::new()
                .with_checkout(checkout)
                .clone(&input.url, Path::new(&input.target_path));
        }
    }
}
