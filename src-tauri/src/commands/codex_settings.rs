use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::{fs, path::PathBuf, sync::Mutex};

static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSettings {
    model: String,
    proxy_url: String,
    api_key_configured: bool,
    trust_mode: bool,
    show_tooltips: bool,
    check_for_update_on_startup: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSettingsInput {
    model: String,
    proxy_url: String,
    api_key: Option<String>,
    trust_mode: bool,
    show_tooltips: bool,
    check_for_update_on_startup: bool,
}

fn codex_dir() -> Result<PathBuf, String> {
    // 桌面应用统一读取当前用户的 Codex 配置，避免继承启动进程中的 CODEX_HOME。
    dirs::home_dir().map(|home| home.join(".codex"))
        .ok_or_else(|| "找不到 Codex 配置目录".into())
}

pub(super) struct ApiConfig {
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub account_id: Option<String>,
    pub wire_api: String,
}

fn non_empty_string(value: Option<&JsonValue>) -> Option<String> {
    value
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn auth_credentials(auth: &JsonValue) -> (Option<String>, Option<String>) {
    let tokens = auth.get("tokens");
    let api_key = non_empty_string(auth.get("OPENAI_API_KEY"))
        .or_else(|| non_empty_string(tokens.and_then(|value| value.get("access_token"))))
        .or_else(|| non_empty_string(auth.get("access_token")));
    let account_id = non_empty_string(tokens.and_then(|value| value.get("account_id")))
        .or_else(|| non_empty_string(auth.get("account_id")));
    (api_key, account_id)
}

pub(super) fn api_config() -> Result<ApiConfig, String> {
    let dir = codex_dir()?;
    let config = read_config(&dir.join("config.toml"))?;
    let provider = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .unwrap_or("");
    let model = config
        .get("model")
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if model.is_empty() {
        return Err("请先在 Codex 设置中配置模型".into());
    }
    let base_url = config
        .get("model_providers")
        .and_then(|providers| providers.get(provider))
        .and_then(|item| item.get("base_url"))
        .and_then(toml::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://api.openai.com/v1")
        .trim()
        .trim_end_matches('/')
        .to_owned();
    let wire_api = config
        .get("model_providers")
        .and_then(|providers| providers.get(provider))
        .and_then(|item| item.get("wire_api"))
        .and_then(toml::Value::as_str)
        .unwrap_or("responses")
        .to_owned();
    let auth = read_json(&dir.join("auth.json"))?;
    let (api_key, account_id) = auth_credentials(&auth);
    Ok(ApiConfig {
        model,
        base_url,
        api_key,
        account_id,
        wire_api,
    })
}

fn read_json(path: &PathBuf) -> Result<JsonValue, String> {
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|error| format!("无法解析 auth.json：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(JsonValue::Object(Default::default()))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn write_atomic(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("配置文件路径无效")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    // Windows 的 rename 不会覆盖已有文件，先删除目标再完成替换。
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

fn read_config(path: &PathBuf) -> Result<toml::Value, String> {
    match fs::read_to_string(path) {
        Ok(source) => source
            .parse()
            .map_err(|error| format!("无法解析 config.toml：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(toml::Value::Table(Default::default()))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn update_base_url(config: &mut toml::Value, value: &str) -> Result<(), String> {
    let table = config.as_table_mut().ok_or("config.toml 顶层必须是表")?;
    let configured_provider = table
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .filter(|provider| !provider.is_empty())
        .map(str::to_owned);
    let generated_provider = configured_provider.is_none() && !value.is_empty();
    let provider_id = configured_provider.unwrap_or_else(|| "openai".to_owned());
    if generated_provider {
        table.insert(
            "model_provider".into(),
            toml::Value::String("nexusdesk".into()),
        );
        let providers = table
            .entry("model_providers")
            .or_insert_with(|| toml::Value::Table(Default::default()))
            .as_table_mut()
            .ok_or("model_providers 必须是表")?;
        let provider = providers
            .entry("nexusdesk")
            .or_insert_with(|| toml::Value::Table(Default::default()))
            .as_table_mut()
            .ok_or("当前 Codex 模型提供方配置必须是表")?;
        provider.insert("name".into(), toml::Value::String("NexusDesk".into()));
        provider.insert("base_url".into(), toml::Value::String(value.into()));
        return Ok(());
    }
    let provider = table
        .get_mut("model_providers")
        .and_then(toml::Value::as_table_mut)
        .and_then(|providers| providers.get_mut(&provider_id));
    match (provider, value.is_empty()) {
        (Some(provider), false) => {
            let provider = provider
                .as_table_mut()
                .ok_or("当前 Codex 模型提供方配置必须是表")?;
            let name_missing = provider
                .get("name")
                .and_then(toml::Value::as_str)
                .is_none_or(|name| name.trim().is_empty());
            if name_missing {
                provider.insert("name".into(), toml::Value::String(provider_id.clone()));
            }
            provider.insert("base_url".into(), toml::Value::String(value.into()));
        }
        (Some(provider), true) => {
            if let Some(provider) = provider.as_table_mut() {
                provider.remove("base_url");
            }
        }
        (None, false) => {
            return Err(format!(
                "config.toml 中不存在 model_providers.{provider_id}，无法更新 base_url"
            ));
        }
        (None, true) => {}
    }
    Ok(())
}

#[tauri::command]
pub fn codex_settings_read() -> Result<CodexSettings, String> {
    let dir = codex_dir()?;
    let config = read_config(&dir.join("config.toml"))?;
    let provider = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .unwrap_or("");
    let proxy_url = config
        .get("model_providers")
        .and_then(|providers| providers.get(provider))
        .and_then(|item| item.get("base_url"))
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .to_owned();
    let auth = read_json(&dir.join("auth.json"))?;
    let (api_key, _) = auth_credentials(&auth);
    let api_key_configured = api_key.is_some();
    Ok(CodexSettings {
        model: config
            .get("model")
            .and_then(toml::Value::as_str)
            .unwrap_or("")
            .to_owned(),
        proxy_url,
        api_key_configured,
        trust_mode: config
            .get("sandbox_mode")
            .and_then(toml::Value::as_str)
            == Some("danger-full-access"),
        show_tooltips: config
            .get("tui")
            .and_then(|tui| tui.get("show_tooltips"))
            .and_then(toml::Value::as_bool)
            .unwrap_or(true),
        check_for_update_on_startup: config
            .get("check_for_update_on_startup")
            .and_then(toml::Value::as_bool)
            .unwrap_or(true),
    })
}

#[tauri::command]
pub fn codex_settings_save(input: CodexSettingsInput) -> Result<(), String> {
    let _write_guard = SETTINGS_WRITE_LOCK
        .lock()
        .map_err(|error| format!("无法锁定 Codex 配置：{error}"))?;
    let dir = codex_dir()?;
    let key = input
        .api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty());

    let auth_bytes = if let Some(key) = key {
        let mut auth = read_json(&dir.join("auth.json"))?;
        let object = auth
            .as_object_mut()
            .ok_or("auth.json 顶层必须是 JSON 对象")?;
        object.insert("OPENAI_API_KEY".into(), JsonValue::String(key.to_owned()));
        Some(serde_json::to_vec_pretty(&auth).map_err(|error| error.to_string())?)
    } else {
        None
    };

    let path = dir.join("config.toml");
    let mut config = read_config(&path)?;
    let table = config.as_table_mut().ok_or("config.toml 顶层必须是表")?;
    let model = input.model.trim();
    if model.is_empty() {
        table.remove("model");
    } else {
        table.insert("model".into(), toml::Value::String(model.into()));
    }
    if input.trust_mode {
        table.insert(
            "sandbox_mode".into(),
            toml::Value::String("danger-full-access".into()),
        );
    } else {
        table.remove("sandbox_mode");
    }

    let tui = table
        .entry("tui")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or("tui 必须是表")?;
    tui.insert("show_tooltips".into(), toml::Value::Boolean(input.show_tooltips));
    table.insert(
        "check_for_update_on_startup".into(),
        toml::Value::Boolean(input.check_for_update_on_startup),
    );

    let proxy_url = input.proxy_url.trim();
    if !proxy_url.is_empty() {
        let parsed =
            reqwest::Url::parse(proxy_url).map_err(|error| format!("代理地址无效：{error}"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("代理地址必须是 HTTP 或 HTTPS URL".into());
        }
    }
    update_base_url(&mut config, proxy_url)?;

    let source = toml::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    write_atomic(&path, source.as_bytes())?;
    if let Some(auth_bytes) = auth_bytes {
        write_atomic(&dir.join("auth.json"), &auth_bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{auth_credentials, update_base_url};

    #[test]
    fn reads_oauth_access_token_and_account_id() {
        let auth = serde_json::json!({
            "tokens": { "access_token": "oauth-token", "account_id": "acct_123" }
        });
        let (key, account_id) = auth_credentials(&auth);
        assert_eq!(key.as_deref(), Some("oauth-token"));
        assert_eq!(account_id.as_deref(), Some("acct_123"));
    }

    #[test]
    fn ignores_blank_credentials() {
        let auth = serde_json::json!({
            "OPENAI_API_KEY": " ",
            "tokens": { "access_token": " " }
        });
        let (key, account_id) = auth_credentials(&auth);
        assert!(key.is_none());
        assert!(account_id.is_none());
    }

    #[test]
    fn updating_proxy_changes_only_existing_provider_base_url() {
        let mut config: toml::Value = r#"
model = "gpt-5-codex"
model_provider = "openai"

[model_providers.openai]
name = "OpenAI"
wire_api = "responses"
base_url = "https://old.example/v1"
"#
        .parse()
        .unwrap();

        update_base_url(&mut config, "https://new.example/v1").unwrap();
        assert_eq!(
            config["model_providers"]["openai"]["base_url"].as_str(),
            Some("https://new.example/v1")
        );
        assert_eq!(
            config["model_providers"]["openai"]["name"].as_str(),
            Some("OpenAI")
        );
        assert_eq!(
            config["model_providers"]["openai"]["wire_api"].as_str(),
            Some("responses")
        );
        assert!(
            config
                .get("model_providers")
                .unwrap()
                .get("nexusdesk")
                .is_none()
        );

        update_base_url(&mut config, "").unwrap();
        assert!(
            config["model_providers"]["openai"]
                .get("base_url")
                .is_none()
        );
    }

    #[test]
    fn proxy_update_creates_provider_when_model_provider_is_missing() {
        let mut config: toml::Value = "model = \"gpt-5-codex\"".parse().unwrap();
        update_base_url(&mut config, "https://api.example/v1").unwrap();
        assert_eq!(config["model_provider"].as_str(), Some("nexusdesk"));
        assert_eq!(
            config["model_providers"]["nexusdesk"]["base_url"].as_str(),
            Some("https://api.example/v1")
        );
        assert_eq!(
            config["model_providers"]["nexusdesk"]["name"].as_str(),
            Some("NexusDesk")
        );
    }

    #[test]
    fn proxy_update_repairs_empty_provider_name() {
        let mut config: toml::Value = r#"
model_provider = "custom"

[model_providers.custom]
name = ""
"#
        .parse()
        .unwrap();

        update_base_url(&mut config, "https://api.example/v1").unwrap();
        assert_eq!(
            config["model_providers"]["custom"]["name"].as_str(),
            Some("custom")
        );
    }
}
