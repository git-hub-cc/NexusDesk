use git2::{Repository, StatusOptions, Status, ErrorCode, Sort, DiffOptions, Cred, CredentialType, RemoteCallbacks, PushOptions, ProxyOptions};
use serde::Serialize;
use std::path::{Path, Component};
mod revert_history;
pub use revert_history::{revert_files, undo_revert};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus { pub path: String, pub worktree_path: String, pub staged: bool, pub unstaged: bool, pub conflict: bool, pub status: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry { pub id: String, pub parents: Vec<String>, pub message: String, pub author: String, pub time: i64, pub refs: Vec<String>, pub pushed: bool, #[serde(rename = "isHead")] pub is_head: bool }
fn open(path: &str) -> Result<Repository, String> { Repository::discover(path).map_err(|e| e.to_string()) }
pub fn is_repository(path: &str) -> Result<bool, String> {
    match Repository::discover(path) {
        Ok(_) => Ok(true),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}
pub fn init_repository(path: &str) -> Result<(), String> {
    if Repository::discover(path).is_ok() { return Err("该目录已经是 Git 仓库".into()); }
    Repository::init(path).map(|_| ()).map_err(|e| e.to_string())
}
fn valid_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\\') || !Path::new(path).components().all(|c| matches!(c, Component::Normal(_))) || path.split('/').any(|p| p.eq_ignore_ascii_case(".git")) { return Err("Invalid repository-relative file path".into()); }
    Ok(())
}
fn head_tree(repo: &Repository) -> Result<Option<git2::Tree<'_>>, String> {
    match repo.head() {
        Ok(head) => head.peel_to_tree().map(Some).map_err(|e| e.to_string()),
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSettings { pub remote: String, pub proxy: String, pub token: String }
fn token_path(repo: &Repository) -> Result<std::path::PathBuf, String> {
    let base = dirs::config_dir().ok_or("无法定位应用配置目录")?;
    let identity = repo.workdir().unwrap_or(repo.path()).to_string_lossy();
    let hash = format!("{:x}", identity.bytes().fold(2166136261u32, |hash, byte| (hash ^ byte as u32).wrapping_mul(16777619)));
    Ok(base.join("NexusDesk").join("git-credentials").join(hash))
}
fn load_credentials(repo: &Repository) -> Result<(String, String), String> {
    let path = token_path(repo)?;
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(_) => return Err("无法读取已保存的 Git Token，请在版本控制设置中重新保存".into()),
    };
    serde_json::from_str(&raw).map_err(|_| "已保存的 Git 凭据格式无效，请重新保存 Token".into())
}
pub fn get_settings(repo_path: &str) -> Result<GitSettings, String> {
    let repo = open(repo_path)?;
    let config = repo.config().map_err(|e| e.to_string())?;
    let remote = repo.find_remote("origin").ok().and_then(|remote| remote.url().map(str::to_owned)).unwrap_or_default();
    let (_, token) = load_credentials(&repo)?;
    Ok(GitSettings { remote, proxy: config.get_string("http.proxy").unwrap_or_default(), token })
}
pub fn save_settings(repo_path: &str, remote_url: &str, proxy: &str, username: &str, token: &str) -> Result<(), String> {
    let repo = open(repo_path)?;
    let remote_url = remote_url.trim();
    if !remote_url.is_empty() && !remote_url.contains("://") && !remote_url.contains('@') { return Err("远程地址格式无效".into()); }
    if !proxy.trim().is_empty() && !(proxy.starts_with("http://") || proxy.starts_with("https://") || proxy.starts_with("socks5://")) { return Err("代理地址需以 http://、https:// 或 socks5:// 开头".into()); }
    let mut config = repo.config().map_err(|e| e.to_string())?;
    if !remote_url.is_empty() {
        if repo.find_remote("origin").is_ok() { repo.remote_set_url("origin", remote_url).map_err(|e| e.to_string())?; }
        else { repo.remote("origin", remote_url).map_err(|e| e.to_string())?; }
    }
    if proxy.trim().is_empty() { let _ = config.remove("http.proxy"); } else { config.set_str("http.proxy", proxy.trim()).map_err(|e| e.to_string())?; }
    let path = token_path(&repo)?;
    if !token.is_empty() {
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let data = serde_json::to_vec(&(username, token)).map_err(|e| e.to_string())?;
        std::fs::write(path, data).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn get_status(repo_path: &str) -> Result<Vec<FileStatus>, String> {
    let repo = match Repository::discover(repo_path) {
        Ok(repo) => repo,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).include_ignored(false).recurse_untracked_dirs(true).renames_head_to_index(false).renames_index_to_workdir(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    Ok(statuses.iter().filter_map(|e| e.path().map(|path| {
        let s = e.status();
        FileStatus { path: path.into(), worktree_path: repo.workdir().unwrap_or_else(|| Path::new(repo_path)).join(path).to_string_lossy().replace('\\', "/"), staged: s.intersects(Status::INDEX_NEW | Status::INDEX_MODIFIED | Status::INDEX_DELETED | Status::INDEX_TYPECHANGE | Status::INDEX_RENAMED), unstaged: s.intersects(Status::WT_NEW | Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_TYPECHANGE | Status::WT_RENAMED), conflict: s.is_conflicted(), status: if s.is_conflicted() { "冲突" } else if s.intersects(Status::WT_DELETED | Status::INDEX_DELETED) { "删除" } else if s.intersects(Status::WT_NEW | Status::INDEX_NEW) { "新增" } else { "修改" }.into() }
    })).collect())
}
#[derive(Serialize)]
pub struct TreeStatus { pub path: String, pub status: String }

// Keep ignored entries separate from the commit panel's actionable changes.
pub fn tree_status(repo_path: &str) -> Result<Vec<TreeStatus>, String> {
    let repo = match Repository::discover(repo_path) {
        Ok(repo) => repo,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let workdir = repo.workdir().ok_or("Bare repository")?;
    let mut opts = StatusOptions::new();
    opts.include_unmodified(true).include_untracked(true).include_ignored(true).recurse_untracked_dirs(true)
        .recurse_ignored_dirs(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    Ok(statuses.iter().filter_map(|entry| entry.path().map(|path| {
        let s = entry.status();
        let status = if s.is_conflicted() { "conflict" }
            else if s.is_ignored() { "ignored" }
            else if s.intersects(Status::INDEX_DELETED | Status::WT_DELETED) { "deleted" }
            else if s.contains(Status::INDEX_NEW) { "added" }
            else if s.contains(Status::WT_NEW) { "untracked" }
            else if s.is_empty() { "clean" }
            else { "modified" };
        TreeStatus { path: workdir.join(path).to_string_lossy().replace('\\', "/"), status: status.into() }
    })).collect())
}

pub fn stage(repo_path: &str, path: &str, staged: bool) -> Result<(), String> {
    valid_path(path)?;
    let repo = open(repo_path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    if staged {
        // add_path bypasses ignore rules; only allow ignored paths already in the index.
        if index.get_path(Path::new(path), 0).is_none() && repo.status_should_ignore(Path::new(path)).map_err(|e| e.to_string())? {
            return Err("此文件已被 Git 忽略，不能暂存".into());
        }
        if repo.status_file(Path::new(path)).map_err(|e| e.to_string())?.is_conflicted() { return Err("请先解决文件冲突".into()); }
        if repo.workdir().ok_or("Bare repository")?.join(path).symlink_metadata().is_ok() { index.add_path(Path::new(path)).map_err(|e| e.to_string())?; }
        else { index.remove_path(Path::new(path)).map_err(|e| e.to_string())?; }
    } else {
        let parent = match repo.head() {
            Ok(head) => Some(head.peel_to_commit().map_err(|e| e.to_string())?),
            Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => None,
            Err(e) => return Err(e.to_string()),
        };
        repo.reset_default(parent.as_ref().map(|c| c.as_object()), [path]).map_err(|e| e.to_string())?;
        return Ok(());
    }
    index.write().map_err(|e| e.to_string())
}
pub fn commit(repo_path: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() { return Err("提交说明不能为空".into()); }
    let repo = open(repo_path)?;
    if repo.state() != git2::RepositoryState::Clean { return Err("请先通过 Git 完成当前合并或变基操作".into()); }
    let mut index = repo.index().map_err(|e| e.to_string())?;
    if index.has_conflicts() { return Err("请先解决冲突".into()); }
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let parent_tree = head_tree(&repo)?;
    if parent_tree.as_ref().map(|t| t.id() == tree_id).unwrap_or(tree.is_empty()) { return Err("没有已暂存的更改".into()); }
    let signature = repo.signature().map_err(|_| "请先配置 Git user.name 和 user.email".to_string())?;
    let parent = match repo.head() { Ok(h) => Some(h.peel_to_commit().map_err(|e| e.to_string())?), Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => None, Err(e) => return Err(e.to_string()) };
    let parents: Vec<_> = parent.iter().collect();
    repo.commit(Some("HEAD"), &signature, &signature, message.trim(), &tree, &parents).map(|id| id.to_string()).map_err(|e| e.to_string())
}
pub fn push(repo_path: &str) -> Result<(), String> {
    let repo = open(repo_path)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    if !head.is_branch() { return Err("当前 HEAD 不是本地分支，请先切换到要推送的分支".into()); }
    let branch = head.shorthand().ok_or("当前 HEAD 不是本地分支")?;
    let local_ref = head.name().ok_or("无法读取当前分支名称")?.to_string();
    let config = repo.config().map_err(|e| e.to_string())?;
    let proxy_url = config.get_string("http.proxy").ok().filter(|url| !url.trim().is_empty());
    let remote_name = config.get_string(&format!("branch.{branch}.remote")).unwrap_or_else(|_| "origin".into());
    if remote_name == "." { return Err("当前分支配置为推送到本地仓库，暂不支持此操作".into()); }
    let remote_ref = config.get_string(&format!("branch.{branch}.merge")).unwrap_or_else(|_| local_ref.clone());
    let mut remote = repo.find_remote(&remote_name).map_err(|e| format!("无法找到远程仓库 {remote_name}: {e}"))?;
    let (saved_username, saved_token) = load_credentials(&repo)?;
    let mut push_rejection = None;
    let mut callbacks = RemoteCallbacks::new();
    callbacks.push_update_reference(|reference, status| {
        if let Some(reason) = status {
            push_rejection = Some(format!("远程拒绝推送 {reference}: {reason}"));
        }
        Ok(())
    });
    callbacks.credentials(move |url, username, allowed| {
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            push_https_credentials(&config, url, username, &saved_username, &saved_token)
        } else if allowed.contains(CredentialType::USERNAME) {
            Cred::username(if saved_username.trim().is_empty() { username.unwrap_or("git") } else { saved_username.trim() })
        } else if allowed.contains(CredentialType::SSH_KEY) {
            Cred::ssh_key_from_agent(username.unwrap_or("git"))
        } else if allowed.contains(CredentialType::DEFAULT) {
            Cred::default()
        } else {
            Err(git2::Error::from_str("No supported credentials available"))
        }
    });
    let mut options = PushOptions::new();
    if let Some(proxy) = proxy_url {
        let mut proxy_options = ProxyOptions::new();
        proxy_options.url(&proxy);
        options.proxy_options(proxy_options);
    }
    options.remote_callbacks(callbacks);
    remote.push(&[format!("{local_ref}:{remote_ref}")], Some(&mut options)).map_err(|e| e.to_string())?;
    // A successful transport can still contain a server-side ref rejection.
    // Release the callback borrow before checking it or updating tracking refs.
    drop(options);
    if let Some(error) = push_rejection { return Err(error); }
    if let Some(branch_name) = remote_ref.strip_prefix("refs/heads/") {
        let tracking_ref = format!("refs/remotes/{remote_name}/{branch_name}");
        if let Some(target) = head.target() {
            repo.reference(&tracking_ref, target, true, "push").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn push_https_credentials(config: &git2::Config, url: &str, username: Option<&str>, saved_username: &str, token: &str) -> Result<Cred, git2::Error> {
    let https = url.get(..8).is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"));
    if !token.trim().is_empty() {
        if !https {
            return Err(git2::Error::from_str("已保存 Token，但当前认证地址不是 HTTPS。请将远程地址改为 https://github.com/用户名/仓库.git；SSH 地址需配置 SSH 密钥"));
        }
        return Cred::userpass_plaintext(if saved_username.trim().is_empty() { username.unwrap_or("git") } else { saved_username.trim() }, token.trim());
    }
    Cred::credential_helper(config, url, username).map_err(|_| git2::Error::from_str("未找到可用的 Git 凭据，请在当前项目的版本控制设置中填写并保存访问 Token；GitHub Token 推送请使用 HTTPS 远程地址"))
}

#[cfg(test)]
mod push_tests {
    use super::*;
    use std::io::{Read, Write};

    #[cfg(any())]
    #[test]
    fn saved_token_does_not_require_local_credential_helper() {
        let config = git2::Config::new().unwrap();
        for url in ["https://github.com/me/project.git", "HTTPS://github.com/me/project.git"] {
            let credential = push_https_credentials(&config, url, None, "", " test-token ").unwrap();
            assert!(credential.has_username());
        }
    }

    #[cfg(any())]
    #[test]
    fn missing_token_and_insecure_address_have_actionable_errors() {
        let config = git2::Config::new().unwrap();
        let missing = push_https_credentials(&config, "https://github.com/me/project.git", None, "", "").err().unwrap();
        assert!(missing.message().contains("填写并保存访问 Token"));
        let insecure = push_https_credentials(&config, "http://github.com/me/project.git", None, "", "test-token").err().unwrap();
        assert!(insecure.message().contains("不是 HTTPS"));
    }

    fn packet(value: &str) -> String { format!("{:04x}{value}", value.len() + 4) }

    // Exercise libgit2's real HTTP transport: HTTP 200 and unpack success do
    // not imply that the server accepted the requested branch update.
    fn http_push(rejected: bool) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let advertisement = format!("{}0000{}0000", packet("# service=git-receive-pack\n"),
                packet("0000000000000000000000000000000000000000 capabilities^{}\0report-status\n"));
            let status = if rejected { "ng refs/heads/main permission denied\n" } else { "ok refs/heads/main\n" };
            let report = format!("{}{}0000", packet("unpack ok\n"), packet(status));
            for (kind, body) in [("advertisement", advertisement), ("result", report)] {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(std::time::Instant::now() < deadline, "timed out waiting for {kind}");
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                let length = header.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                }).unwrap_or(0);
                stream.read_exact(&mut vec![0; length]).unwrap();
                if header.to_ascii_lowercase().contains("transfer-encoding: chunked") {
                    loop {
                        let mut line = Vec::new();
                        while !line.ends_with(b"\r\n") {
                            let mut byte = [0];
                            stream.read_exact(&mut byte).unwrap();
                            line.push(byte[0]);
                        }
                        let size = usize::from_str_radix(String::from_utf8(line).unwrap().trim(), 16).unwrap();
                        stream.read_exact(&mut vec![0; size + 2]).unwrap();
                        if size == 0 { break; }
                    }
                }
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/x-git-receive-pack-{kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let directory = std::env::temp_dir().join(format!("nexusdesk-push-{}-{}", std::process::id(), address.port()));
        std::fs::create_dir_all(&directory).unwrap();
        let repo = Repository::init(&directory).unwrap();
        repo.set_head("refs/heads/main").unwrap();
        let blob = repo.blob(b"project content").unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder.insert("README.md", blob, 0o100644).unwrap();
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let commit = repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[]).unwrap();
        repo.remote("origin", &format!("http://{address}/project.git")).unwrap();
        // Keep the test independent of the user's proxy configuration.
        repo.config().unwrap().set_str("http.proxy", "").unwrap();
        let result = push(directory.to_str().unwrap());
        server.join().unwrap();
        if rejected {
            assert!(result.unwrap_err().contains("permission denied"));
            assert!(repo.find_reference("refs/remotes/origin/main").is_err());
            assert!(!log(directory.to_str().unwrap(), 10).unwrap()[0].pushed);
        } else {
            result.unwrap();
            assert_eq!(repo.find_reference("refs/remotes/origin/main").unwrap().target(), Some(commit));
            assert!(log(directory.to_str().unwrap(), 10).unwrap()[0].pushed);
        }
        drop(tree);
        drop(builder);
        drop(repo);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejected_first_push_does_not_mark_commits_as_pushed() { http_push(true); }

    #[test]
    fn accepted_first_push_updates_tracking_reference() { http_push(false); }
}

pub fn undo_commit(repo_path: &str, commit_id: &str) -> Result<(), String> {
    let repo = open(repo_path)?;
    if repo.state() != git2::RepositoryState::Clean { return Err("请先完成当前合并或变基操作".into()); }
    let oid = git2::Oid::from_str(commit_id).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| e.to_string())?;
    if head.target() != Some(oid) { return Err("只能撤销当前分支最新的提交".into()); }
    for reference in repo.references().map_err(|e| e.to_string())? {
        let reference = reference.map_err(|e| e.to_string())?;
        if reference.name().unwrap_or("").starts_with("refs/remotes/") {
            if let Ok(remote_commit) = reference.peel_to_commit() {
                if remote_commit.id() == oid || repo.graph_descendant_of(remote_commit.id(), oid).map_err(|e| e.to_string())? {
                    return Err("此提交已推送到远程，不能撤销".into());
                }
            }
        }
    }
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let branch = head.name().ok_or("无法读取当前分支名称")?.to_string();
    if let Ok(parent) = commit.parent(0) {
        repo.reset(parent.as_object(), git2::ResetType::Soft, None).map_err(|e| e.to_string())?;
    } else {
        repo.find_reference(&branch).map_err(|e| e.to_string())?.delete().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn log(repo_path: &str, limit: usize) -> Result<Vec<LogEntry>, String> {
    let repo = match Repository::discover(repo_path) {
        Ok(repo) => repo,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    if head_tree(&repo)?.is_none() { return Ok(vec![]); }
    let mut refs = std::collections::HashMap::<String, Vec<String>>::new();
    let mut pushed = std::collections::HashSet::new();
    let head_id = repo.head().ok().and_then(|head| head.target());
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.to_string())?;
    walk.push_head().map_err(|e| e.to_string())?;
    for reference in repo.references().map_err(|e| e.to_string())? {
        let reference = reference.map_err(|e| e.to_string())?;
        if let Ok(commit) = reference.peel_to_commit() {
            walk.push(commit.id()).map_err(|e| e.to_string())?;
            let name = reference.name().unwrap_or("");
            if name.starts_with("refs/remotes/") {
                let mut remote_walk = repo.revwalk().map_err(|e| e.to_string())?;
                remote_walk.push(commit.id()).map_err(|e| e.to_string())?;
                for id in remote_walk { pushed.insert(id.map_err(|e| e.to_string())?); }
            }
            refs.entry(commit.id().to_string()).or_default().push(reference.shorthand().unwrap_or("").into());
        }
    }
    walk.take(limit.clamp(1, 2000)).map(|id| {
        let c = repo.find_commit(id.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(LogEntry { id: c.id().to_string(), parents: c.parent_ids().map(|id| id.to_string()).collect(), message: c.message().unwrap_or("").into(), author: c.author().name().unwrap_or("").into(), time: c.time().seconds(), refs: refs.remove(&c.id().to_string()).unwrap_or_default(), pushed: pushed.contains(&c.id()), is_head: head_id == Some(c.id()) })
    }).collect()
}
#[derive(Serialize)]
pub struct PathHistory { pub root: String, pub entries: Vec<PathHistoryEntry> }
#[derive(Serialize)]
pub struct PathHistoryEntry { pub commit: LogEntry, pub changes: Vec<RevisionChange> }

pub fn path_history(path: &str, limit: usize) -> Result<PathHistory, String> {
    let target = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let repo = Repository::discover(&target).map_err(|_| "所选路径不在 Git 仓库中".to_string())?;
    let root = std::fs::canonicalize(repo.workdir().ok_or("不支持裸仓库")?).map_err(|e| e.to_string())?;
    let scope = target.strip_prefix(&root).map_err(|e| e.to_string())?;
    let mut result = PathHistory { root: root.to_string_lossy().into_owned(), entries: Vec::new() };
    if head_tree(&repo)?.is_none() { return Ok(result); }
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.to_string())?;
    walk.push_head().map_err(|e| e.to_string())?;
    for id in walk {
        let commit = repo.find_commit(id.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let changes: Vec<_> = revision_changes(&result.root, &commit.id().to_string())?.into_iter()
            .filter(|change| Path::new(&change.path).starts_with(scope)).collect();
        if changes.is_empty() { continue; }
        result.entries.push(PathHistoryEntry { commit: LogEntry {
            id: commit.id().to_string(), parents: commit.parent_ids().map(|id| id.to_string()).collect(),
            message: commit.message().unwrap_or("").into(), author: commit.author().name().unwrap_or("").into(),
            time: commit.time().seconds(), refs: vec![], pushed: false, is_head: false,
        }, changes });
        if result.entries.len() >= limit.clamp(1, 2000) { break; }
    }
    Ok(result)
}

pub fn diff(repo_path: &str, path: &str, staged: bool) -> Result<String, String> {
    valid_path(path)?;
    let repo = open(repo_path)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(path).disable_pathspec_match(true).include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true).context_lines(10000);
    opts.ignore_whitespace_eol(true);
    opts.ignore_whitespace_change(true);
    let tree = head_tree(&repo)?;
    let diff = if staged { repo.diff_tree_to_index(tree.as_ref(), None, Some(&mut opts)) } else { repo.diff_index_to_workdir(None, Some(&mut opts)) }.map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_, _, line| {
        if matches!(line.origin(), '+' | '-' | ' ') { output.push(line.origin() as u8); }
        output.extend_from_slice(line.content()); true
    }).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("nexusdesk-git-{}-{}-{serial}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            let repo = Repository::init(&path).unwrap();
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap(); config.set_str("user.email", "test@example.com").unwrap();
            Self(path)
        }
        fn path(&self) -> &str { self.0.to_str().unwrap() }
        fn write(&self, content: &str) { std::fs::write(self.0.join("note.md"), content).unwrap(); }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    #[test]
    fn path_history_filters_before_limiting_and_respects_directory_boundaries() {
        let f = Fixture::new();
        std::fs::create_dir(f.0.join("notes")).unwrap();
        std::fs::create_dir(f.0.join("notes-other")).unwrap();
        std::fs::write(f.0.join("notes/a.md"), "first").unwrap();
        stage(f.path(), "notes/a.md", true).unwrap();
        let first = commit(f.path(), "scoped first").unwrap();
        std::fs::write(f.0.join("notes-other/b.md"), "outside").unwrap();
        stage(f.path(), "notes-other/b.md", true).unwrap();
        commit(f.path(), "unrelated latest").unwrap();
        for path in [f.0.join("notes"), f.0.join("notes/a.md")] {
            let history = path_history(path.to_str().unwrap(), 1).unwrap();
            assert_eq!(history.entries.len(), 1);
            assert_eq!(history.entries[0].commit.id, first);
            assert_eq!(history.entries[0].changes[0].path, "notes/a.md");
        }
        assert_eq!(path_history(f.path(), 100).unwrap().entries.len(), 2);
    }
    #[test]
    fn status_provides_real_worktree_paths_when_opened_from_a_subdirectory() {
        let f = Fixture::new();
        f.write("editable\n");
        let nested = f.0.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let statuses = get_status(nested.to_str().unwrap()).unwrap();
        let file = statuses.iter().find(|file| file.path == "note.md").unwrap();
        assert!(Path::new(&file.worktree_path).is_absolute());
        assert_eq!(std::fs::read_to_string(&file.worktree_path).unwrap(), "editable\n");
        std::fs::write(&file.worktree_path, "edited\n").unwrap();
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "edited\n");
    }
    #[test]
    fn ignore_directory_preserves_tracked_and_unstages_new_files() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.0.join("docs/nested")).unwrap();
        std::fs::write(f.0.join("docs/tracked.md"), "original").unwrap();
        stage(f.path(), "docs/tracked.md", true).unwrap();
        commit(f.path(), "initial").unwrap();
        std::fs::write(f.0.join("docs/tracked.md"), "modified").unwrap();
        stage(f.path(), "docs/tracked.md", true).unwrap();
        std::fs::write(f.0.join("docs/nested/new.md"), "new").unwrap();
        stage(f.path(), "docs/nested/new.md", true).unwrap();
        std::fs::write(f.0.join("outside.md"), "outside").unwrap();
        ignore_file(f.path(), "docs/").unwrap();
        ignore_file(f.path(), "docs/").unwrap();
        assert_eq!(std::fs::read_to_string(f.0.join(".gitignore")).unwrap(), "/docs/\n");
        let status = get_status(f.path()).unwrap();
        assert!(status.iter().any(|f| f.path == "docs/tracked.md" && f.staged));
        assert!(!status.iter().any(|f| f.path == "docs/nested/new.md"));
        assert!(status.iter().any(|f| f.path == "outside.md"));
        assert!(f.0.join("docs/nested/new.md").exists());
    }

    #[test]
    fn persistent_revert_undo_restores_multiple_operations_and_index() {
        let f = Fixture::new();
        f.write("original");
        stage(f.path(), "note.md", true).unwrap();
        commit(f.path(), "initial").unwrap();
        f.write("staged");
        stage(f.path(), "note.md", true).unwrap();
        f.write("working");
        let binary = vec![0, 255, 128, 10];
        std::fs::write(f.0.join("new.bin"), &binary).unwrap();
        revert_files(f.path(), &["note.md".into(), "new.bin".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "original");
        assert!(!f.0.join("new.bin").exists());
        std::fs::remove_file(f.0.join("note.md")).unwrap();
        revert_files(f.path(), &["note.md".into()]).unwrap();
        // A fresh repository handle and disk records are sufficient to replay after restart.
        std::fs::write(f.0.join("other.md"), "unrelated").unwrap();
        stage(f.path(), "other.md", true).unwrap();
        assert_eq!(undo_revert(f.path()).unwrap(), vec!["note.md"]);
        assert!(!f.0.join("note.md").exists());
        assert_eq!(undo_revert(f.path()).unwrap(), vec!["note.md", "new.bin"]);
        assert_eq!(std::fs::read(f.0.join("new.bin")).unwrap(), binary);
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "working");
        let repo = open(f.path()).unwrap();
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new("note.md"), 0).unwrap();
        assert_eq!(repo.find_blob(entry.id).unwrap().content(), b"staged");
        assert!(index.get_path(Path::new("other.md"), 0).is_some());
        assert!(index.get_path(Path::new("new.bin"), 0).is_none());
        assert!(undo_revert(f.path()).unwrap().is_empty());
    }

    #[test]
    fn revert_backup_validation_preserves_files_and_failed_undo_can_retry() {
        let f = Fixture::new();
        f.write("original");
        stage(f.path(), "note.md", true).unwrap();
        commit(f.path(), "initial").unwrap();
        f.write("keep");
        assert!(revert_files(f.path(), &["note.md".into(), "../outside".into()]).is_err());
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "keep");
        revert_files(f.path(), &["note.md".into()]).unwrap();
        std::fs::remove_file(f.0.join("note.md")).unwrap();
        std::fs::create_dir(f.0.join("note.md")).unwrap();
        assert!(undo_revert(f.path()).is_err());
        std::fs::remove_dir(f.0.join("note.md")).unwrap();
        undo_revert(f.path()).unwrap();
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "keep");
    }

    #[test]
    fn revert_and_ignore_individual_files() {
        let f = Fixture::new(); f.write("original\n");
        stage(f.path(), "note.md", true).unwrap(); commit(f.path(), "initial").unwrap();
        f.write("staged\n"); stage(f.path(), "note.md", true).unwrap(); f.write("working\n");
        std::fs::write(f.0.join("other.md"), "keep").unwrap();
        revert_file(f.path(), "note.md").unwrap();
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "original\n");
        assert!(!get_status(f.path()).unwrap().iter().any(|f| f.path == "note.md"));
        std::fs::remove_file(f.0.join("note.md")).unwrap();
        revert_file(f.path(), "note.md").unwrap();
        assert!(f.0.join("note.md").exists());
        ignore_file(f.path(), "other.md").unwrap(); ignore_file(f.path(), "other.md").unwrap();
        assert_eq!(std::fs::read_to_string(f.0.join(".gitignore")).unwrap(), "/other.md\n");
        assert!(f.0.join("other.md").exists());
        assert!(!get_status(f.path()).unwrap().iter().any(|f| f.path == "other.md"));
        std::fs::write(f.0.join("new.md"), "new").unwrap(); stage(f.path(), "new.md", true).unwrap();
        revert_file(f.path(), "new.md").unwrap(); assert!(!f.0.join("new.md").exists());
        assert!(revert_file(f.path(), "../outside").is_err());
        assert!(ignore_file(f.path(), "../outside").is_err());
    }
    #[test]
    fn ignoring_staged_new_file_removes_it_from_changes_without_deleting_content() {
        let f = Fixture::new();
        f.write("keep staged content\n");
        stage(f.path(), "note.md", true).unwrap();
        ignore_file(f.path(), "note.md").unwrap();
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "keep staged content\n");
        assert!(!get_status(f.path()).unwrap().iter().any(|s| s.path == "note.md"));
        assert!(open(f.path()).unwrap().index().unwrap().get_path(Path::new("note.md"), 0).is_none());
        ignore_file(f.path(), "note.md").unwrap();
        assert_eq!(std::fs::read_to_string(f.0.join(".gitignore")).unwrap(), "/note.md\n");
    }
    #[test]
    fn ignore_rules_refresh_and_preserve_tracked_changes() {
        let f = Fixture::new();
        f.write("tracked\n");
        stage(f.path(), "note.md", true).unwrap();
        commit(f.path(), "initial").unwrap();
        std::fs::create_dir_all(f.0.join("cache")).unwrap();
        std::fs::create_dir_all(f.0.join("docs")).unwrap();
        std::fs::write(f.0.join("cache/output.txt"), "ignored").unwrap();
        std::fs::write(f.0.join("docs/.gitignore"), "*.tmp\n!keep.tmp\n").unwrap();
        std::fs::write(f.0.join("docs/drop.tmp"), "ignored").unwrap();
        std::fs::write(f.0.join("docs/keep.tmp"), "keep").unwrap();
        assert!(get_status(f.path()).unwrap().iter().any(|s| s.path == "cache/output.txt"));
        std::fs::write(f.0.join(".gitignore"), "cache/\nnote.md\n").unwrap();
        f.write("changed\n");
        let statuses = get_status(f.path()).unwrap();
        for path in [".gitignore", "docs/.gitignore", "docs/keep.tmp", "note.md"] {
            assert!(statuses.iter().any(|s| s.path == path), "missing {path}");
        }
        for path in ["cache/output.txt", "docs/drop.tmp"] {
            assert!(!statuses.iter().any(|s| s.path == path));
            assert!(stage(f.path(), path, true).is_err());
        }
        stage(f.path(), "note.md", true).unwrap();
        stage(f.path(), "docs/keep.tmp", true).unwrap();
        std::fs::write(f.0.join(".gitignore"), "").unwrap();
        assert!(get_status(f.path()).unwrap().iter().any(|s| s.path == "cache/output.txt"));
    }
    #[test]
    fn initial_commit_unstage_and_split_changes() {
        let f = Fixture::new(); f.write("first\n");
        assert!(log(f.path(), 100).unwrap().is_empty());
        assert!(diff(f.path(), "note.md", false).unwrap().contains("+first"));
        stage(f.path(), "note.md", true).unwrap();
        stage(f.path(), "note.md", false).unwrap();
        assert!(!get_status(f.path()).unwrap()[0].staged);
        stage(f.path(), "note.md", true).unwrap();
        let first = commit(f.path(), "initial").unwrap();
        f.write("second\n"); stage(f.path(), "note.md", true).unwrap(); f.write("third\n");
        let status = get_status(f.path()).unwrap(); assert!(status[0].staged && status[0].unstaged);
        assert!(diff(f.path(), "note.md", true).unwrap().contains("+second"));
        assert!(diff(f.path(), "note.md", false).unwrap().contains("+third"));
        commit(f.path(), "only staged").unwrap();
        assert!(!get_status(f.path()).unwrap()[0].staged);
        let history = log(f.path(), 100).unwrap(); assert_eq!(history[0].parents, vec![first]);
        assert!(commit(f.path(), "empty").is_err()); assert!(commit(f.path(), " ").is_err());
    }
    #[test]
    fn undo_latest_unpushed_commit_preserves_its_changes_staged() {
        let f = Fixture::new();
        f.write("first\n");
        stage(f.path(), "note.md", true).unwrap();
        let first = commit(f.path(), "first").unwrap();
        f.write("second\n");
        stage(f.path(), "note.md", true).unwrap();
        let second = commit(f.path(), "second").unwrap();

        assert!(undo_commit(f.path(), &first).is_err());
        undo_commit(f.path(), &second).unwrap();
        let history = log(f.path(), 100).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, first);
        assert!(history[0].is_head);
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "second\n");
        assert!(get_status(f.path()).unwrap().iter().any(|file| file.path == "note.md" && file.staged));
    }
    #[test]
    fn undoing_unpushed_root_commit_leaves_files_staged_on_unborn_branch() {
        let f = Fixture::new();
        f.write("root\n");
        stage(f.path(), "note.md", true).unwrap();
        let root_commit = commit(f.path(), "root").unwrap();

        undo_commit(f.path(), &root_commit).unwrap();
        assert!(log(f.path(), 100).unwrap().is_empty());
        assert!(get_status(f.path()).unwrap().iter().any(|file| file.path == "note.md" && file.staged));
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "root\n");
    }
    #[test]
    fn push_marks_local_history_as_published() {
        let f = Fixture::new();
        let remote_path = f.0.with_extension("remote.git");
        let remote_repo = Repository::init_bare(&remote_path).unwrap();
        drop(remote_repo);
        f.write("first\n");
        stage(f.path(), "note.md", true).unwrap();
        let commit_id = commit(f.path(), "initial").unwrap();
        open(f.path()).unwrap().remote("origin", remote_path.to_str().unwrap()).unwrap();

        assert!(!log(f.path(), 100).unwrap()[0].pushed);
        push(f.path()).unwrap();
        let history = log(f.path(), 100).unwrap();
        assert_eq!(history[0].id, commit_id);
        assert!(history[0].pushed);
        assert!(undo_commit(f.path(), &commit_id).is_err());

        drop(Repository::open_bare(&remote_path).unwrap());
        std::fs::remove_dir_all(remote_path).unwrap();
    }
    #[test]
    fn revision_changes_only_include_changed_files_and_support_deleted_paths() {
        let f = Fixture::new();
        f.write("before\n");
        std::fs::write(f.0.join("unchanged.md"), "keep\n").unwrap();
        std::fs::write(f.0.join("removed.md"), "deleted text\n").unwrap();
        for path in ["note.md", "unchanged.md", "removed.md"] { stage(f.path(), path, true).unwrap(); }
        let first = commit(f.path(), "initial").unwrap();
        assert_eq!(revision_changes(f.path(), &first).unwrap().len(), 3);
        assert!(revision_diff(f.path(), &first, "note.md").unwrap().contains("+before"));
        f.write("after\n");
        std::fs::remove_file(f.0.join("removed.md")).unwrap();
        std::fs::write(f.0.join("added.md"), "new text\n").unwrap();
        for path in ["note.md", "removed.md", "added.md"] { stage(f.path(), path, true).unwrap(); }
        let second = commit(f.path(), "changes").unwrap();
        let changes = revision_changes(f.path(), &second).unwrap();
        assert_eq!(changes.len(), 3);
        assert!(!changes.iter().any(|c| c.path == "unchanged.md"));
        assert!(changes.iter().any(|c| c.path == "removed.md" && c.status == "删除"));
        assert!(changes.iter().any(|c| c.path == "added.md" && c.status == "新增"));
        assert!(changes.iter().any(|c| c.path == "note.md" && c.status == "修改"));
        let patch = revision_diff(f.path(), &second, "note.md").unwrap();
        assert!(patch.contains("-before") && patch.contains("+after"));
        assert!(revision_diff(f.path(), &second, "removed.md").unwrap().contains("-deleted text"));
        assert!(revision_diff(f.path(), &second, "unchanged.md").unwrap().is_empty());
        // Explicitly verify the merge diff uses the first parent.
        let repo = open(f.path()).unwrap();
        let first_commit = repo.find_commit(git2::Oid::from_str(&first).unwrap()).unwrap();
        let second_commit = repo.find_commit(git2::Oid::from_str(&second).unwrap()).unwrap();
        let signature = repo.signature().unwrap();
        let merge = repo.commit(None, &signature, &signature, "merge", &second_commit.tree().unwrap(), &[&second_commit, &first_commit]).unwrap();
        assert!(revision_changes(f.path(), &merge.to_string()).unwrap().is_empty());
        assert!(get_status(f.path()).unwrap().is_empty());
    }
    #[test]
    fn historical_snapshots_do_not_change_worktree_or_index() {
        let f = Fixture::new();
        f.write("old content\n");
        std::fs::create_dir(f.0.join("docs")).unwrap();
        std::fs::write(f.0.join("docs/nested.md"), "nested\n").unwrap();
        stage(f.path(), "note.md", true).unwrap();
        stage(f.path(), "docs/nested.md", true).unwrap();
        let first = commit(f.path(), "initial").unwrap();
        std::fs::remove_file(f.0.join("docs/nested.md")).unwrap();
        stage(f.path(), "docs/nested.md", true).unwrap();
        f.write("new content\n");
        stage(f.path(), "note.md", true).unwrap();
        let second = commit(f.path(), "update").unwrap();
        f.write("local edits\n");
        assert_eq!(revision_files(f.path(), &first).unwrap().len(), 2);
        assert_eq!(revision_files(f.path(), &second).unwrap().len(), 1);
        assert_eq!(revision_content(f.path(), &first, "docs/nested.md").unwrap(), "nested\n");
        assert_eq!(revision_content(f.path(), &first, "note.md").unwrap(), "old content\n");
        assert_eq!(revision_content(f.path(), &second, "note.md").unwrap(), "new content\n");
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "local edits\n");
        assert!(!get_status(f.path()).unwrap()[0].staged);
        assert!(revision_content(f.path(), &first, "../outside").is_err());
        assert!(revision_files(f.path(), "invalid-id").is_err());
    }
    #[test]
    fn restoring_revision_file_overwrites_or_removes_working_file_without_changing_index() {
        let f = Fixture::new();
        f.write("snapshot\n");
        stage(f.path(), "note.md", true).unwrap();
        let first = commit(f.path(), "initial").unwrap();
        f.write("local content\n");
        assert!(get_status(f.path()).unwrap()[0].unstaged);
        restore_revision_file(f.path(), &first, "note.md").unwrap();
        assert_eq!(std::fs::read_to_string(f.0.join("note.md")).unwrap(), "snapshot\n");
        assert!(get_status(f.path()).unwrap().is_empty());

        std::fs::write(f.0.join("picture.png"), [0, 1, 255]).unwrap();
        stage(f.path(), "picture.png", true).unwrap();
        let with_image = commit(f.path(), "add image").unwrap();
        std::fs::write(f.0.join("picture.png"), [9, 9]).unwrap();
        restore_revision_file(f.path(), &with_image, "picture.png").unwrap();
        assert_eq!(std::fs::read(f.0.join("picture.png")).unwrap(), [0, 1, 255]);

        std::fs::remove_file(f.0.join("note.md")).unwrap();
        stage(f.path(), "note.md", true).unwrap();
        let deleted = commit(f.path(), "delete note").unwrap();
        f.write("recreated locally\n");
        restore_revision_file(f.path(), &deleted, "note.md").unwrap();
        assert!(!f.0.join("note.md").exists());
        assert!(restore_revision_file(f.path(), &first, "../outside").is_err());
    }
    #[test]
    fn restoring_revision_directory_replaces_the_full_snapshot() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.0.join("docs/nested")).unwrap();
        std::fs::write(f.0.join("docs/a.md"), "first a\n").unwrap();
        std::fs::write(f.0.join("docs/nested/b.md"), "first b\n").unwrap();
        for path in ["docs/a.md", "docs/nested/b.md"] { stage(f.path(), path, true).unwrap(); }
        commit(f.path(), "initial").unwrap();
        std::fs::write(f.0.join("docs/a.md"), "selected a\n").unwrap();
        stage(f.path(), "docs/a.md", true).unwrap();
        let selected = commit(f.path(), "selected snapshot").unwrap();

        std::fs::write(f.0.join("docs/a.md"), "local a\n").unwrap();
        std::fs::write(f.0.join("docs/nested/b.md"), "local b\n").unwrap();
        std::fs::write(f.0.join("docs/extra.md"), "local only\n").unwrap();
        restore_revision_directory(f.path(), &selected, "docs").unwrap();

        assert_eq!(std::fs::read_to_string(f.0.join("docs/a.md")).unwrap(), "selected a\n");
        assert_eq!(std::fs::read_to_string(f.0.join("docs/nested/b.md")).unwrap(), "first b\n");
        assert!(!f.0.join("docs/extra.md").exists());
        assert!(restore_revision_directory(f.path(), &selected, "../outside").is_err());
    }
    #[test]
    fn image_diff_binary_versions_and_missing_sides() {
        let f = Fixture::new();
        let path = "picture.png";
        let first = vec![0, 137, 80, 78, 71, 255];
        let second = vec![0, 137, 80, 78, 71, 254];
        let third = vec![0, 137, 80, 78, 71, 253];
        std::fs::write(f.0.join(path), &first).unwrap();
        assert_eq!(image_diff(f.path(), path, false, None).unwrap(), (None, Some(first.clone())));
        stage(f.path(), path, true).unwrap();
        assert_eq!(image_diff(f.path(), path, true, None).unwrap(), (None, Some(first.clone())));
        let initial = commit(f.path(), "initial image").unwrap();
        assert_eq!(image_diff(f.path(), path, false, Some(&initial)).unwrap(), (None, Some(first.clone())));
        std::fs::write(f.0.join(path), &second).unwrap();
        stage(f.path(), path, true).unwrap();
        std::fs::write(f.0.join(path), &third).unwrap();
        assert_eq!(image_diff(f.path(), path, true, None).unwrap(), (Some(first.clone()), Some(second.clone())));
        assert_eq!(image_diff(f.path(), path, false, None).unwrap(), (Some(second.clone()), Some(third)));
        let changed = commit(f.path(), "changed image").unwrap();
        assert_eq!(image_diff(f.path(), path, false, Some(&changed)).unwrap(), (Some(first), Some(second.clone())));
        std::fs::remove_file(f.0.join(path)).unwrap();
        assert_eq!(image_diff(f.path(), path, false, None).unwrap(), (Some(second.clone()), None));
        stage(f.path(), path, true).unwrap();
        assert_eq!(image_diff(f.path(), path, true, None).unwrap(), (Some(second.clone()), None));
        let deleted = commit(f.path(), "delete image").unwrap();
        assert_eq!(image_diff(f.path(), path, false, Some(&deleted)).unwrap(), (Some(second), None));
        assert!(image_diff(f.path(), "../outside.png", false, None).is_err());
    }
    #[test]
    fn deletion_and_path_validation() {
        let f = Fixture::new(); f.write("content\n"); stage(f.path(), "note.md", true).unwrap(); commit(f.path(), "initial").unwrap();
        std::fs::remove_file(f.0.join("note.md")).unwrap(); stage(f.path(), "note.md", true).unwrap();
        assert!(diff(f.path(), "note.md", true).unwrap().contains("-content"));
        stage(f.path(), "note.md", false).unwrap(); assert!(get_status(f.path()).unwrap()[0].unstaged);
        stage(f.path(), "note.md", true).unwrap(); commit(f.path(), "delete").unwrap();
        assert!(get_status(f.path()).unwrap().is_empty());
        for path in ["../outside", "/absolute", ".git/config", "C:\\outside", ""] { assert!(stage(f.path(), path, true).is_err()); }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionFile { pub path: String }

pub fn revision_files(repo_path: &str, commit_id: &str) -> Result<Vec<RevisionFile>, String> {
    let repo = open(repo_path)?;
    let commit = repo.find_commit(git2::Oid::from_str(commit_id).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            if let Some(name) = entry.name() { files.push(RevisionFile { path: format!("{}{}", dir, name) }); }
        }
        git2::TreeWalkResult::Ok
    }).map_err(|e| e.to_string())?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

pub fn revision_content(repo_path: &str, commit_id: &str, path: &str) -> Result<String, String> {
    valid_path(path)?;
    let repo = open(repo_path)?;
    let commit = repo.find_commit(git2::Oid::from_str(commit_id).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = tree.get_path(Path::new(path)).map_err(|e| e.to_string())?;
    let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
    if blob.is_binary() { return Err("二进制文件暂不支持文本预览".into()); }
    if blob.size() > 5 * 1024 * 1024 { return Err("文件超过 5 MB，暂不支持预览".into()); }
    String::from_utf8(blob.content().to_vec()).map_err(|_| "文件不是 UTF-8 文本，无法预览".into())
}

/*
pub fn restore_revision_file(repo_path: &str, commit_id: &str, path: &str) -> Result<(), String> {
    valid_path(path)?;
    let repo = open(repo_path)?;
    if repo.state() != git2::RepositoryState::Clean { return Err("请先完成当前合并或变基操作".into()); }
    let target = safe_work_path(&repo, path)?;
    let commit = repo.find_commit(git2::Oid::from_str(commit_id).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let Some(entry) = tree.get_path(Path::new(path)).ok() else {
        match target.symlink_metadata() {
            Ok(metadata) if metadata.file_type().is_dir() => return Err("目标路径是目录，无法用已删除文件覆盖".into()),
            Ok(_) => std::fs::remove_file(target).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(e.to_string()),
        }
        return Ok(());
    };
    if entry.kind() != Some(git2::ObjectType::Blob) { return Err("提交中的目标不是普通文件".into()); }
    let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
    if let Some(parent) = target.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    std::fs::write(target, blob.content()).map_err(|e| e.to_string())
}
*/

/*
pub fn restore_revision_directory(repo_path: &str, commit_id: &str, path: &str) -> Result<(), String> {
    valid_path(path)?;
    let repo = open(repo_path)?;
    if repo.state() != git2::RepositoryState::Clean { return Err("请先完成当前合并或变基操作".into()); }
    let target = safe_work_path(&repo, path)?;
    let commit = repo.find_commit(git2::Oid::from_str(commit_id).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = tree.get_path(Path::new(path)).map_err(|e| e.to_string())?;
    if entry.kind() != Some(git2::ObjectType::Tree) { return Err("提交中的目标不是目录".into()); }
    let directory = repo.find_tree(entry.id()).map_err(|e| e.to_string())?;
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) if !metadata.file_type().is_dir() => return Err("目标路径不是目录".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.to_string()),
        _ => {},
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let _ = remove_directory_contents(&target)?;
    write_revision_tree(&repo, &directory, &target)?;
    Ok(())
}
*/

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionChange { pub path: String, pub status: String }

pub fn image_diff(repo_path: &str, path: &str, staged: bool, commit_id: Option<&str>) -> Result<(Option<Vec<u8>>, Option<Vec<u8>>), String> {
    valid_path(path)?;
    let repo = open(repo_path)?;
    let from_tree = |tree: Option<&git2::Tree<'_>>| -> Result<Option<Vec<u8>>, String> {
        let Some(tree) = tree else { return Ok(None); };
        let entry = match tree.get_path(Path::new(path)) {
            Ok(entry) => entry,
            Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        repo.find_blob(entry.id()).map(|blob| Some(blob.content().to_vec())).map_err(|e| e.to_string())
    };
    if let Some(id) = commit_id {
        let commit = repo.find_commit(git2::Oid::from_str(id).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let tree = commit.tree().map_err(|e| e.to_string())?;
        let parent = parent_tree(&commit)?;
        return Ok((from_tree(parent.as_ref())?, from_tree(Some(&tree))?));
    }
    let index = repo.index().map_err(|e| e.to_string())?;
    let indexed = match index.get_path(Path::new(path), 0) {
        Some(entry) => Some(repo.find_blob(entry.id).map_err(|e| e.to_string())?.content().to_vec()),
        None => None,
    };
    if staged { return Ok((from_tree(head_tree(&repo)?.as_ref())?, indexed)); }
    let target = safe_work_path(&repo, path)?;
    if target.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("不能预览符号链接图片".into()); }
    let working = match std::fs::read(target) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    Ok((indexed, working))
}

fn parent_tree<'repo>(commit: &git2::Commit<'repo>) -> Result<Option<git2::Tree<'repo>>, String> {
    if commit.parent_count() == 0 { Ok(None) }
    else { commit.parent(0).and_then(|p| p.tree()).map(Some).map_err(|e| e.to_string()) }
}

// Merge commits are compared with their first parent, like the default Git log diff.
pub fn revision_changes(repo_path: &str, commit_id: &str) -> Result<Vec<RevisionChange>, String> {
    let repo = open(repo_path)?;
    let commit = repo.find_commit(git2::Oid::from_str(commit_id).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent = parent_tree(&commit)?;
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), None).map_err(|e| e.to_string())?;
    let mut changes = Vec::new();
    for delta in diff.deltas() {
        let path = if delta.status() == git2::Delta::Deleted { delta.old_file().path() } else { delta.new_file().path() };
        if let Some(path) = path {
            changes.push(RevisionChange { path: path.to_string_lossy().replace('\\', "/"), status: match delta.status() { git2::Delta::Added => "新增", git2::Delta::Deleted => "删除", _ => "修改" }.into() });
        }
    }
    Ok(changes)
}

pub fn revision_diff(repo_path: &str, commit_id: &str, path: &str) -> Result<String, String> {
    valid_path(path)?;
    let repo = open(repo_path)?;
    let commit = repo.find_commit(git2::Oid::from_str(commit_id).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent = parent_tree(&commit)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(path).disable_pathspec_match(true).context_lines(10000);
    opts.ignore_whitespace_eol(true);
    opts.ignore_whitespace_change(true);
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_, _, line| {
        if matches!(line.origin(), '+' | '-' | ' ') { output.push(line.origin() as u8); }
        output.extend_from_slice(line.content()); true
    }).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn safe_work_path(repo: &Repository, path: &str) -> Result<std::path::PathBuf, String> {
    valid_path(path)?;
    let root = repo.workdir().ok_or("Bare repository")?;
    let mut parent = root.to_path_buf();
    let parts: Vec<_> = path.split('/').collect();
    for part in &parts[..parts.len() - 1] {
        parent.push(part);
        if parent.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("不能操作符号链接目录中的文件".into()); }
    }
    Ok(root.join(path))
}
pub fn revert_file(repo_path: &str, path: &str) -> Result<(), String> {
    let repo = open(repo_path)?;
    let target = safe_work_path(&repo, path)?;
    if repo.state() != git2::RepositoryState::Clean { return Err("请先完成当前合并或变基操作".into()); }
    let tree = head_tree(&repo)?;
    if let Some(tree) = tree.as_ref().filter(|tree| tree.get_path(Path::new(path)).is_ok()) {
        let mut opts = git2::build::CheckoutBuilder::new();
        let mut literal = String::new();
        for ch in path.chars() {
            if matches!(ch, '*' | '?' | '[' | ']' | '\\') { literal.push('\\'); }
            literal.push(ch);
        }
        opts.force().path(literal);
        repo.checkout_tree(tree.as_object(), Some(&mut opts)).map_err(|e| e.to_string())?;
    } else if target.symlink_metadata().is_ok() {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    }
    stage(repo_path, path, false)
}
pub fn ignore_file(repo_path: &str, path: &str) -> Result<(), String> {
    let directory = path.ends_with('/');
    let path = if directory { &path[..path.len() - 1] } else { path };
    let repo = open(repo_path)?;
    safe_work_path(&repo, path)?;
    if path == ".gitignore" || path.contains(['\n', '\r']) { return Err("不能忽略此文件路径".into()); }
    // Newly staged files are already in the index, so ignore rules alone do
    // not hide them. Unstage these files while preserving their disk contents.
    // Files present in HEAD must remain tracked to avoid staging deletions.
    let tracked_in_head = head_tree(&repo)?.as_ref().map(|tree| tree.get_path(Path::new(path)).is_ok()).unwrap_or(false);
    let target = safe_work_path(&repo, ".gitignore")?;
    if target.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err(".gitignore 不能是符号链接".into()); }
    let mut content = match std::fs::read_to_string(&target) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.to_string()),
    };
    let mut pattern = String::from("/");
    for ch in path.chars() {
        if matches!(ch, '*' | '?' | '[' | ']' | '!' | '#' | ' ') { pattern.push('\\'); }
        pattern.push(ch);
    }
    if directory { pattern.push('/'); }
    if !content.lines().any(|line| line == pattern) {
        let newline = if content.contains("\r\n") { "\r\n" } else { "\n" };
        if !content.is_empty() && !content.ends_with('\n') { content.push_str(newline); }
        content.push_str(&pattern); content.push_str(newline);
        std::fs::write(target, content).map_err(|e| e.to_string())?;
    }
    if directory {
        let tree = head_tree(&repo)?;
        for file in get_status(repo_path)? {
            if file.path.starts_with(&format!("{path}/")) && file.staged
                && !tree.as_ref().map(|tree| tree.get_path(Path::new(&file.path)).is_ok()).unwrap_or(false) {
                stage(repo_path, &file.path, false)?;
            }
        }
    } else if !tracked_in_head {
        stage(repo_path, path, false)?;
    }
    Ok(())
}
