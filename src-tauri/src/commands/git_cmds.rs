use crate::core::git;
use serde::Deserialize;

#[tauri::command]
pub async fn is_git_installed() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut command = std::process::Command::new("git");
        command.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command.output().is_ok_and(|output| output.status.success())
    }).await.map_err(|error| error.to_string())
}

fn provider_host(provider: &str) -> Result<&'static str, String> {
    match provider {
        "github" => Ok("github.com"),
        "gitlab" => Ok("gitlab.com"),
        "gitee" => Ok("gitee.com"),
        _ => Err("不支持的 Git 平台".into()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepository { name: String, full_name: String, clone_url: String, private: bool }

fn parse_repository(provider: &str, value: &serde_json::Value) -> Option<GitRepository> {
    let field = |key: &str| value[key].as_str().unwrap_or_default().to_owned();
    let (full_name, mut clone_url, private) = if provider == "gitlab" {
        (field("path_with_namespace"), field("http_url_to_repo"), field("visibility") != "public")
    } else { (field("full_name"), field("clone_url"), value["private"].as_bool().unwrap_or(false)) };
    if clone_url.is_empty() && provider == "gitee" {
        let html_url = field("html_url");
        if !html_url.is_empty() { clone_url = format!("{}.git", html_url.trim_end_matches('/').trim_end_matches(".git")); }
    }
    if clone_url.is_empty() { return None; }
    Some(GitRepository { name: field("name"), full_name, clone_url, private })
}

fn validate_clone_host(url: &str, provider: &str) -> Result<&'static str, String> {
    let host = provider_host(provider)?;
    let parsed = reqwest::Url::parse(url).map_err(|_| "使用 Token 克隆时请输入 HTTPS 仓库地址".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some(host) || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("仓库地址必须是所选平台的 HTTPS 地址".into());
    }
    Ok(host)
}

#[tauri::command]
pub async fn list_git_repositories(provider: String, token: String) -> Result<Vec<GitRepository>, String> {
    provider_host(&provider)?;
    let token = token.trim();
    if token.is_empty() { return Err("请输入访问 Token".into()); }
    let client = reqwest::Client::builder()
        .user_agent("NexusDesk")
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build().map_err(|_| "无法创建网络连接".to_string())?;
    let endpoint = match provider.as_str() {
        "github" => "https://api.github.com/user/repos?affiliation=owner&sort=updated",
        "gitlab" => "https://gitlab.com/api/v4/projects?owned=true&order_by=last_activity_at",
        _ => "https://gitee.com/api/v5/user/repos?type=owner&sort=updated",
    };
    let mut repositories = Vec::new();
    let mut page = 1usize;
    loop {
        let mut request = client.get(format!("{endpoint}&per_page=100&page={page}"));
        request = if provider == "gitlab" { request.header("PRIVATE-TOKEN", token) }
            else if provider == "gitee" { request.query(&[("access_token", token)]) }
            else { request.bearer_auth(token) };
        let response = request.send().await.map_err(|_| "获取项目失败，请检查网络连接".to_string())?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 => "Token 无效或已过期".into(),
                403 => "Token 权限不足或请求过于频繁".into(),
                status => format!("获取项目失败（HTTP {status}）"),
            });
        }
        let values: Vec<serde_json::Value> = response.json().await.map_err(|_| "项目列表格式无效".to_string())?;
        let count = values.len();
        repositories.extend(values.iter().filter_map(|value| parse_repository(&provider, value)));
        if count < 100 { break; }
        page += 1;
    }
    Ok(repositories)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSettingsInput { pub remote: String, pub proxy: String, pub token: String }
#[tauri::command]
pub fn get_git_settings(repo_path: String) -> Result<git::GitSettings, String> { git::get_settings(&repo_path) }
#[tauri::command]
pub fn save_git_settings(repo_path: String, settings: GitSettingsInput) -> Result<(), String> { git::save_settings(&repo_path, &settings.remote, &settings.proxy, "oauth2", &settings.token) }
#[tauri::command]
pub async fn clone_git_repository(url: String, target_path: String, token: Option<String>, provider: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = url.trim();
        if url.is_empty() { return Err("请输入 Git 仓库链接".to_string()); }
        let target = std::path::Path::new(&target_path);
        if !target.parent().is_some_and(std::path::Path::is_dir) { return Err("本地保存位置不存在".to_string()); }
        if target.exists() { return Err("目标目录已存在，请更换项目名称".to_string()); }
        let token = token.as_deref().unwrap_or_default().trim();
        let mut callbacks = git2::RemoteCallbacks::new();
        if !token.is_empty() {
            let host = validate_clone_host(url, provider.as_deref().unwrap_or("github"))?;
            callbacks.credentials(move |credential_url, _, allowed| {
                let trusted = reqwest::Url::parse(credential_url).is_ok_and(|url| url.scheme() == "https" && url.host_str() == Some(host));
                if trusted && allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
                    git2::Cred::userpass_plaintext("oauth2", token)
                } else { Err(git2::Error::from_str("无法为该地址提供凭据")) }
            });
        }
        let mut fetch = git2::FetchOptions::new();
        fetch.remote_callbacks(callbacks);
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fetch);
        builder.clone(url, target).map_err(|error| error.to_string())?;
        if !token.is_empty() {
            git::save_settings(&target_path, "", "", "oauth2", token)
                .map_err(|_| "仓库已克隆，但 Token 保存失败，请打开项目后重新配置".to_string())?;
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn init_git_repository(repo_path: String) -> Result<(), String> { git::init_repository(&repo_path) }

#[tauri::command]
pub fn is_git_repository(repo_path: String) -> Result<bool, String> { git::is_repository(&repo_path) }
#[tauri::command]
pub async fn push_git_repository(repo_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::push(&repo_path)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn undo_git_commit(repo_path: String, commit_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::undo_commit(&repo_path, &commit_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn get_git_tree_status(repo_path: String) -> Result<Vec<git::TreeStatus>, String> { git::tree_status(&repo_path) }
#[tauri::command]
pub fn get_git_image_diff(repo_path: String, path: String, staged: bool, commit_id: Option<String>) -> Result<(Option<Vec<u8>>, Option<Vec<u8>>), String> {
    git::image_diff(&repo_path, &path, staged, commit_id.as_deref())
}
#[tauri::command]
pub fn get_git_status(repo_path: String) -> Result<Vec<git::FileStatus>, String> { git::get_status(&repo_path) }
#[tauri::command]
pub fn stage_git_file(repo_path: String, path: String, staged: bool) -> Result<(), String> { git::stage(&repo_path, &path, staged) }
#[tauri::command]
pub fn commit_git(repo_path: String, message: String) -> Result<String, String> { git::commit(&repo_path, &message) }
#[tauri::command]
pub fn get_git_log(repo_path: String, limit: usize) -> Result<Vec<git::LogEntry>, String> { git::log(&repo_path, limit) }
#[tauri::command]
pub async fn get_git_path_history(path: String, limit: usize) -> Result<git::PathHistory, String> {
    tauri::async_runtime::spawn_blocking(move || git::path_history(&path, limit)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn get_git_diff(repo_path: String, path: String, staged: bool) -> Result<String, String> { git::diff(&repo_path, &path, staged) }
#[tauri::command]
pub fn get_git_revision_files(repo_path: String, commit_id: String) -> Result<Vec<git::RevisionFile>, String> { git::revision_files(&repo_path, &commit_id) }
#[tauri::command]
pub fn get_git_revision_content(repo_path: String, commit_id: String, path: String) -> Result<String, String> { git::revision_content(&repo_path, &commit_id, &path) }
#[tauri::command]
pub fn get_git_revision_changes(repo_path: String, commit_id: String) -> Result<Vec<git::RevisionChange>, String> { git::revision_changes(&repo_path, &commit_id) }
#[tauri::command]
pub fn get_git_revision_diff(repo_path: String, commit_id: String, path: String) -> Result<String, String> { git::revision_diff(&repo_path, &commit_id, &path) }
#[tauri::command]
pub fn revert_git_file(repo_path: String, path: String) -> Result<(), String> { git::revert_files(&repo_path, &[path]) }
#[tauri::command]
pub fn revert_git_files(repo_path: String, paths: Vec<String>) -> Result<(), String> { git::revert_files(&repo_path, &paths) }
#[tauri::command]
pub fn undo_git_revert(repo_path: String) -> Result<Vec<String>, String> { git::undo_revert(&repo_path) }
#[tauri::command]
pub fn ignore_git_file(repo_path: String, path: String) -> Result<(), String> { git::ignore_file(&repo_path, &path) }

#[cfg(test)]
mod clone_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn token_clone_requires_selected_https_host() {
        assert!(validate_clone_host("https://github.com/me/project.git", "github").is_ok());
        for url in ["http://github.com/me/project.git", "https://github.com.evil.test/project.git",
            "https://github.com@evil.test/project.git", "https://user:secret@github.com/me/project.git",
            "https://gitlab.com/me/project.git", "git@github.com:me/project.git"] {
            assert!(validate_clone_host(url, "github").is_err(), "{url}");
        }
        assert!(validate_clone_host("https://github.com/me/project.git", "unknown").is_err());
    }

    #[test]
    fn maps_github_and_gitlab_private_repositories() {
        let github = parse_repository("github", &json!({"name":"project", "full_name":"me/project", "clone_url":"https://github.com/me/project.git", "private":true})).unwrap();
        assert_eq!(github.full_name, "me/project");
        assert!(github.private);
        let gitlab = parse_repository("gitlab", &json!({"name":"Display name", "path_with_namespace":"me/project", "http_url_to_repo":"https://gitlab.com/me/project.git", "visibility":"private"})).unwrap();
        assert_eq!(gitlab.clone_url, "https://gitlab.com/me/project.git");
        assert!(gitlab.private);
        assert!(parse_repository("github", &json!({})).is_none());
    }

    #[test]
    fn gitee_can_derive_clone_url_from_web_url() {
        let repository = parse_repository("gitee", &json!({"name":"project", "full_name":"me/project", "html_url":"https://gitee.com/me/project", "private":false})).unwrap();
        assert_eq!(repository.clone_url, "https://gitee.com/me/project.git");
        assert!(!repository.private);
    }
}
