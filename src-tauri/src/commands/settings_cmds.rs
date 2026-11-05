use serde_json::{Map, Value};
use std::{collections::BTreeMap, fs::OpenOptions, path::{Path, PathBuf}};

type Settings = BTreeMap<String, String>;

fn settings_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir().ok_or("Cannot find home directory")?.join(".note/global_settings.json"))
}

fn allowed(key: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct Contract { keys: Vec<String>, prefixes: Vec<String> }
    static CONTRACT: std::sync::OnceLock<Contract> = std::sync::OnceLock::new();
    let contract = CONTRACT.get_or_init(|| serde_json::from_str(
        include_str!("../../../src/lib/globalSettingKeys.json")
    ).expect("Invalid global setting key contract"));
    contract.keys.iter().any(|allowed| allowed == key)
        || contract.prefixes.iter().any(|prefix| key.starts_with(prefix))
}

// Lock a separate file so atomic replacement of the JSON cannot bypass the lock.
fn transaction<T>(path: &Path, operation: impl FnOnce(&mut Settings) -> Result<T, String>, write: bool) -> Result<T, String> {
    std::fs::create_dir_all(path.parent().ok_or("Missing settings directory")?).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true)
        .open(path.with_extension("lock")).map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    let mut values = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Settings>(&bytes).map_err(|e| format!("Invalid global settings: {e}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::new(),
        Err(error) => return Err(error.to_string()),
    };
    let result = operation(&mut values)?;
    if write {
        use std::io::Write;
        let temporary = path.with_extension("json.tmp");
        let mut file = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&values).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())?;
    }
    Ok(result)
}

fn identity(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned).or_else(|| value.get("id").or_else(|| value.get("url"))?.as_str().map(str::to_owned))
}

// Three-way merge preserves unrelated edits made by another project since read.
fn merge(current: &Value, before: &Value, after: &Value) -> Value {
    if before == after { return current.clone(); }
    if current == before { return after.clone(); }
    if let (Some(current), Some(before), Some(after)) = (current.as_object(), before.as_object(), after.as_object()) {
        let mut result = current.clone();
        for key in before.keys().chain(after.keys()) {
            if before.get(key) == after.get(key) { continue; }
            if let Some(value) = after.get(key) {
                result.insert(key.clone(), merge(current.get(key).unwrap_or(&Value::Null), before.get(key).unwrap_or(&Value::Null), value));
            } else { result.remove(key); }
        }
        return Value::Object(result);
    }
    if let (Some(current), Some(before), Some(after)) = (current.as_array(), before.as_array(), after.as_array()) {
        if current.iter().chain(before).chain(after).all(|entry| identity(entry).is_some()) {
            let mut result = Vec::new();
            for entry in after {
                let id = identity(entry);
                let old = before.iter().find(|item| identity(item) == id);
                let remote = current.iter().find(|item| identity(item) == id);
                // A locally unchanged entry must not resurrect a remote deletion.
                if old == Some(entry) && remote.is_none() { continue; }
                result.push(merge(remote.unwrap_or(&Value::Null), old.unwrap_or(&Value::Null), entry));
            }
            for entry in current {
                let id = identity(entry);
                if !before.iter().chain(after).any(|item| identity(item) == id) { result.push(entry.clone()); }
            }
            return Value::Array(result);
        }
    }
    after.clone()
}

fn update(values: &mut Settings, key: &str, previous: Option<&str>, value: &str) -> String {
    let decode = |text: &str| serde_json::from_str(text).unwrap_or(Value::String(text.into()));
    let before = previous.map(decode).unwrap_or(Value::Object(Map::new()));
    let current = values.get(key).map(|value| decode(value)).unwrap_or_else(|| before.clone());
    let mut merged = merge(&current, &before, &decode(value));
    if key == "noteide-workspace-storage" {
        if let Some(entries) = merged.pointer_mut("/state/recentProjects").and_then(Value::as_array_mut) { entries.truncate(10); }
    }
    if key == "noteide-browser-history" {
        if let Some(entries) = merged.pointer_mut("/state/entries").and_then(Value::as_array_mut) {
            entries.sort_by_key(|entry| std::cmp::Reverse(entry.get("visitedAt").and_then(Value::as_u64).unwrap_or(0)));
            entries.truncate(500);
        }
    }
    let result = match merged { Value::String(text) if serde_json::from_str::<Value>(value).is_err() => text,
        value => value.to_string() };
    values.insert(key.into(), result.clone());
    result
}

pub fn needs_migration() -> Result<bool, String> { Ok(!settings_path()?.exists()) }

fn import_entries(values: &mut Settings, entries: Settings) {
    for (key, value) in entries { if allowed(&key) { values.entry(key).or_insert(value); } }
}

pub fn start_migration(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Only this short-lived webview uses the legacy default UDF. No project UI
    // is created until it imports settings and closes.
    tauri::WebviewWindowBuilder::new(app, "settings-migration", tauri::WebviewUrl::App("src/settings-migration.html".into()))
        .visible(false).focused(false).skip_taskbar(true).build()?;
    Ok(())
}

#[tauri::command]
pub async fn import_global_settings(window: tauri::WebviewWindow, entries: Settings) -> Result<(), String> {
    use tauri::Manager;
    if window.label() != "settings-migration" { return Err("Only the migration window can import settings".into()); }
    tauri::async_runtime::spawn_blocking(move || transaction(&settings_path()?, |values| {
        import_entries(values, entries);
        Ok(())
    }, true)).await.map_err(|e| e.to_string())??;
    let app = window.app_handle().clone();
    window.destroy().map_err(|e| e.to_string())?;
    crate::profiles::create_main(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_global_settings() -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(|| transaction(&settings_path()?, |values| Ok(values.clone()), false))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_global_setting(key: String, previous: Option<String>, value: String) -> Result<String, String> {
    if !allowed(&key) { return Err(format!("Unknown global setting: {key}")); }
    tauri::async_runtime::spawn_blocking(move || transaction(&settings_path()?, |values|
        Ok(update(values, &key, previous.as_deref(), &value)), true)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_migration_preserves_existing_settings_and_only_imports_global_keys() {
        let mut values = Settings::from([("noteide-terminal-profiles".into(), "new".into())]);
        import_entries(&mut values, Settings::from([
            ("noteide-terminal-profiles".into(), "old".into()),
            ("noteide-workspace-storage".into(), "recent".into()),
            ("sftp-label:server".into(), "user@server".into()),
            ("noteide-snapshot-storage".into(), "snapshot".into()),
        ]));
        assert_eq!(values.len(), 3);
        assert_eq!(values["noteide-terminal-profiles"], "new");
        assert_eq!(values["noteide-workspace-storage"], "recent");
    }

    #[test]
    fn concurrent_history_and_recent_updates_preserve_additions_and_deletions() {
        let before = json!({ "state": { "recentProjects": ["A", "B"] }, "version": 0 });
        let first = json!({ "state": { "recentProjects": ["C", "A", "B"] }, "version": 0 });
        let second = json!({ "state": { "recentProjects": ["D", "A"] }, "version": 0 });
        let merged = merge(&first, &before, &second);
        assert_eq!(merged["state"]["recentProjects"], json!(["D", "A", "C"]));
        let before = json!([{ "url": "a", "title": "old", "visitedAt": 1 }]);
        let first = json!([{ "url": "a", "title": "new", "visitedAt": 2 }, { "url": "b" }]);
        assert_eq!(merge(&first, &before, &json!([])), json!([{ "url": "b" }]));
        assert_eq!(merge(&json!([]), &before, &before), json!([]));
    }

    #[test]
    fn changing_runtime_sessions_does_not_overwrite_newer_terminal_configuration() {
        let before = json!({ "state": { "profiles": [{ "id": "shell", "command": "" }], "defaultProfileId": "shell" } });
        let remote = json!({ "state": { "profiles": [{ "id": "shell", "command": "pwsh" }], "defaultProfileId": "shell" } });
        assert_eq!(merge(&remote, &before, &before), remote);
        let local = json!({ "state": { "profiles": [{ "id": "shell", "command": "" }, { "id": "codex", "command": "codex" }], "defaultProfileId": "codex" } });
        let merged = merge(&remote, &before, &local);
        assert_eq!(merged["state"]["profiles"][0]["command"], "pwsh");
        assert_eq!(merged["state"]["defaultProfileId"], "codex");
    }

    #[test]
    fn process_writer() {
        let Some(path) = std::env::var_os("NOTEIDE_SETTINGS_TEST_PATH") else { return; };
        let prefix = std::env::var("NOTEIDE_SETTINGS_TEST_PREFIX").unwrap();
        for number in 0..12 {
            transaction(Path::new(&path), |values| {
                values.insert(format!("{prefix}-{number}"), number.to_string());
                Ok(())
            }, true).unwrap();
        }
    }

    #[test]
    fn atomic_settings_writes_are_safe_across_processes() {
        let root = std::env::temp_dir().join(format!("noteide-settings-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("global_settings.json");
        let executable = std::env::current_exe().unwrap();
        let mut children = ["a", "b"].map(|prefix| {
            let mut command = std::process::Command::new(&executable);
            command.args(["--exact", "commands::settings_cmds::tests::process_writer"])
                .env("NOTEIDE_SETTINGS_TEST_PATH", &path).env("NOTEIDE_SETTINGS_TEST_PREFIX", prefix);
            #[cfg(windows)]
            { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
            command.spawn().unwrap()
        });
        for child in &mut children { assert!(child.wait().unwrap().success()); }
        transaction(&path, |values| { assert_eq!(values.len(), 24); Ok(()) }, false).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_settings_are_preserved_instead_of_overwritten() {
        let root = std::env::temp_dir().join(format!("noteide-settings-corrupt-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("global_settings.json");
        std::fs::write(&path, b"corrupted").unwrap();
        assert!(transaction(&path, |_| Ok(()), true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"corrupted");
        std::fs::remove_dir_all(root).unwrap();
    }
}
