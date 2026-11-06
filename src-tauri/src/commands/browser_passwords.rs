use serde::{Deserialize, Serialize};
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Serialize, Deserialize)]
pub struct Password { pub name: String, pub url: String, pub username: String, pub password: String, #[serde(default)] pub note: String }

fn path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir().ok_or("找不到用户目录")?.join(".nexus/browser/passwords.bin"))
}

#[cfg(windows)]
fn crypt(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    #[repr(C)] struct Blob { len: u32, data: *mut u8 }
    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(input: *const Blob, description: *const u16, entropy: *const Blob, reserved: *mut std::ffi::c_void, prompt: *mut std::ffi::c_void, flags: u32, output: *mut Blob) -> i32;
        fn CryptUnprotectData(input: *const Blob, description: *mut *mut u16, entropy: *const Blob, reserved: *mut std::ffi::c_void, prompt: *mut std::ffi::c_void, flags: u32, output: *mut Blob) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" { fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void; }
    let input = Blob { len: bytes.len().try_into().map_err(|_| "密码文件过大")?, data: bytes.as_ptr() as *mut u8 };
    let mut output = Blob { len: 0, data: std::ptr::null_mut() };
    unsafe {
        let ok = if decrypt { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), 1, &mut output) }
        else { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), 1, &mut output) };
        if ok == 0 { return Err("无法访问本机加密密码库".into()); }
        let result = std::slice::from_raw_parts(output.data, output.len as usize).to_vec();
        LocalFree(output.data.cast());
        Ok(result)
    }
}
#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> Result<Vec<u8>, String> { Err("当前平台暂不支持加密密码库".into()) }

fn load() -> Result<Vec<Password>, String> {
    let path = path()?;
    if !path.exists() { return Ok(Vec::new()); }
    let bytes = std::fs::read(path).map_err(|_| "读取密码库失败")?;
    serde_json::from_slice(&crypt(&bytes, true)?).map_err(|_| "密码库格式无效".into())
}

// RFC 4180: quoted commas, escaped quotes and multiline fields (including Chrome notes).
fn csv_rows(text: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::new(); let mut row = Vec::new(); let mut field = String::new();
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    let mut quoted = false; let mut closed = false;
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' { if chars.peek() == Some(&'"') { chars.next(); field.push('"'); } else { quoted = false; closed = true; } }
            else { field.push(c); }
        } else {
            match c {
                '"' if field.is_empty() && !closed => quoted = true,
                ',' => { row.push(std::mem::take(&mut field)); closed = false; }
                '\r' | '\n' => { if c == '\r' && chars.peek() == Some(&'\n') { chars.next(); } row.push(std::mem::take(&mut field)); rows.push(std::mem::take(&mut row)); closed = false; }
                _ if closed || c == '"' => return Err("CSV 引号格式无效".into()),
                _ => field.push(c),
            }
        }
    }
    if quoted { return Err("CSV 引号未闭合".into()); }
    if !row.is_empty() || !field.is_empty() || closed { row.push(field); rows.push(row); }
    Ok(rows)
}

fn origin(url: &str) -> Option<String> {
    let url = tauri::Url::parse(url).ok()?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() { return None; }
    Some(url.origin().ascii_serialization())
}

fn trusted(view: &tauri::Webview) -> Result<(), String> {
    let url = view.url().map_err(|e| e.to_string())?;
    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions) && url.origin().ascii_serialization() == "http://127.0.0.1:1420");
    if !local || view.label().contains("-browser-") { return Err("无权访问密码库".into()); }
    Ok(())
}

#[derive(Serialize)]
pub struct ImportResult { imported: usize, updated: usize, skipped: usize }

#[derive(Serialize)]
pub struct PasswordStats { sites: usize, passwords: usize, updated_at: Option<String> }

#[tauri::command]
pub fn browser_password_stats(webview: tauri::Webview) -> Result<PasswordStats, String> {
    trusted(&webview)?;
    let _guard = LOCK.lock().map_err(|_| "密码库繁忙")?;
    let entries = load()?;
    let sites = entries.iter().filter_map(|entry| origin(&entry.url)).collect::<std::collections::HashSet<_>>().len();
    let updated_at = std::fs::metadata(path()?).ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
    Ok(PasswordStats { sites, passwords: entries.len(), updated_at })
}

#[tauri::command]
pub fn browser_import_passwords(webview: tauri::Webview, file: String) -> Result<ImportResult, String> {
    trusted(&webview)?;
    let _guard = LOCK.lock().map_err(|_| "密码库繁忙")?;
    if std::fs::metadata(&file).map_err(|_| "无法读取 CSV 文件")?.len() > 10 * 1024 * 1024 { return Err("CSV 文件不能超过 10 MB".into()); }
    let text = std::fs::read_to_string(file).map_err(|_| "请选择 UTF-8 编码的 CSV 文件")?;
    let rows = csv_rows(&text)?;
    let header = rows.first().ok_or("CSV 文件为空")?;
    let column = |name: &str| header.iter().position(|v| v.trim().eq_ignore_ascii_case(name));
    let (url, username, password) = (column("url").ok_or("缺少 url 列")?, column("username").ok_or("缺少 username 列")?, column("password").ok_or("缺少 password 列")?);
    let mut entries = load()?;
    let mut result = ImportResult { imported: 0, updated: 0, skipped: 0 };
    for row in rows.iter().skip(1) {
        if row.len() != header.len() { result.skipped += 1; continue; }
        let get = |index: Option<usize>| index.and_then(|i| row.get(i)).cloned().unwrap_or_default();
        let entry = Password { name: get(column("name")), url: get(Some(url)), username: get(Some(username)), password: get(Some(password)), note: get(column("note")) };
        let Some(site) = origin(&entry.url) else { result.skipped += 1; continue; };
        if entry.password.is_empty() { result.skipped += 1; continue; }
        if let Some(existing) = entries.iter_mut().find(|e| origin(&e.url).as_ref() == Some(&site) && e.username == entry.username) { *existing = entry; result.updated += 1; }
        else { entries.push(entry); result.imported += 1; }
    }
    let bytes = crypt(&serde_json::to_vec(&entries).map_err(|_| "密码序列化失败")?, false)?;
    let path = path()?; std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "无法创建密码库")?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, bytes).map_err(|_| "保存密码库失败")?;
    std::fs::rename(temp, path).map_err(|_| "替换密码库失败")?;
    Ok(result)
}

#[tauri::command]
pub fn browser_export_passwords(webview: tauri::Webview, file: String) -> Result<usize, String> {
    trusted(&webview)?;
    let _guard = LOCK.lock().map_err(|_| "密码库繁忙")?;
    let entries = load()?;
    let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let mut csv = String::from("\u{feff}name,url,username,password,note\r\n");
    for e in &entries { csv.push_str(&[&e.name, &e.url, &e.username, &e.password, &e.note].map(|s| quote(s)).join(",")); csv.push_str("\r\n"); }
    std::fs::write(file, csv).map_err(|_| "导出密码失败")?;
    Ok(entries.len())
}

pub fn fill(view: &tauri::Webview, url: &tauri::Url) {
    let Some(site) = origin(url.as_str()) else { return; };
    let result = (|| -> Result<(), String> {
        let _guard = LOCK.lock().map_err(|_| "密码库繁忙")?;
        let entries: Vec<_> = load()?.into_iter().filter(|e| origin(&e.url).as_ref() == Some(&site)).collect();
        if entries.is_empty() { return Ok(()); }
        let data = serde_json::to_string(&(site, entries)).map_err(|e| e.to_string())?;
        view.eval(&format!("(() => {{ const [site, entries] = {data}; {} }})();", include_str!("browser_autofill.js"))).map_err(|e| e.to_string())
    })();
    if result.is_err() { log::warn!(target: "browser", "Password autofill unavailable"); }
}

// This private navigation is always cancelled; credentials never leave the webview.
pub fn password_navigation(view: Option<tauri::Webview>, url: &tauri::Url) -> bool {
    if url.scheme() != "nexusdesk-password" { return false; }
    let result = (|| -> Result<(), String> {
        type Pending = std::collections::HashMap<String, (Password, std::time::Instant)>;
        static PENDING: std::sync::OnceLock<Mutex<Pending>> = std::sync::OnceLock::new();
        let view = view.ok_or("Missing browser")?;
        let source = view.url().map_err(|e| e.to_string())?;
        let site = origin(source.as_str()).ok_or("Invalid source")?;
        let mut pending = PENDING.get_or_init(|| Mutex::new(Pending::new())).lock().map_err(|_| "Password update busy")?;
        pending.retain(|_, (_, time)| time.elapsed().as_secs() < 120);
        if url.host_str() == Some("capture") {
            let entry: Password = serde_json::from_str(&url.query_pairs().find(|(key, _)| key == "data").ok_or("Missing data")?.1).map_err(|e| e.to_string())?;
            if origin(&entry.url).as_ref() != Some(&site) || entry.password.is_empty() { return Err("Invalid credential source".into()); }
            pending.insert(view.label().to_string(), (entry, std::time::Instant::now()));
            return Ok(());
        }
        if url.host_str() != Some("commit") { return Ok(()); }
        let Some((entry, _)) = pending.remove(view.label()) else { return Ok(()); };
        if origin(&entry.url).as_ref() != Some(&site) || entry.password.is_empty() { return Err("Invalid credential source".into()); }
        let _guard = LOCK.lock().map_err(|_| "Password store busy")?;
        let mut entries = load()?;
        let existing = entries.iter_mut().find(|e| origin(&e.url).as_ref() == Some(&site) && e.username == entry.username).ok_or("Unknown account")?;
        existing.url = entry.url;
        existing.password = entry.password;
        let bytes = crypt(&serde_json::to_vec(&entries).map_err(|e| e.to_string())?, false)?;
        let path = path()?;
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(temp, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() { log::warn!(target: "browser", "Password update unavailable"); }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn csv_handles_chrome_exports() {
        let rows = csv_rows("\u{feff}name,url,username,password,note\r\nsite,https://example.com,alice,\"a,b\"\"c\",\"line1\nline2\"\r\n").unwrap();
        assert_eq!(rows[1][3], "a,b\"c"); assert_eq!(rows[1][4], "line1\nline2");
        assert!(csv_rows("a,\"broken").is_err());
    }
    #[test] fn matches_exact_origin_only() {
        assert_eq!(origin("https://accounts.google.com/v3/signin/challenge/pwd"), origin("https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn"));
        assert_eq!(origin("https://example.com/login"), origin("https://example.com/other"));
        assert_ne!(origin("https://example.com"), origin("https://sub.example.com"));
        assert_ne!(origin("https://example.com"), origin("http://example.com"));
        assert!(origin("https://user:pass@example.com").is_none());
        assert!(origin("file:///test").is_none());
    }
    #[cfg(windows)]
    #[test] fn encrypted_roundtrip() { let bytes = b"secret"; let encrypted = crypt(bytes, false).unwrap(); assert_ne!(encrypted, bytes); assert_eq!(crypt(&encrypted, true).unwrap(), bytes); }
}
