use std::path::{Path, PathBuf};
use tauri::Manager;

pub struct ProjectProfile {
    pub directory: PathBuf,
    // Prevent two app instances (including launchers or switched projects)
    // from ever using the same active UDF, while preserving stable profiles.
    _lease: std::fs::File,
}

pub fn allocate(root: &Path, project: Option<&Path>) -> Result<ProjectProfile, String> {
    let directory = root.join(profile_key(project)?);
    let acquire = |directory: PathBuf, wait: bool| -> Result<ProjectProfile, String> {
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let file = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true)
            .open(directory.join(".instance.lock")).map_err(|error| error.to_string())?;
        if wait { file.lock().map_err(|error| error.to_string())?; }
        else { file.try_lock().map_err(|error| error.to_string())?; }
        Ok(ProjectProfile { directory, _lease: file })
    };
    match acquire(directory.clone(), false) {
        Ok(profile) => Ok(profile),
        Err(_) => acquire(directory.join("instances").join(std::process::id().to_string()), true),
    }
}

pub fn profile_key(project: Option<&Path>) -> Result<String, String> {
    let Some(project) = project else { return Ok("launcher".into()); };
    let path = std::fs::canonicalize(project).map_err(|error| error.to_string())?;
    let identity = path.to_string_lossy();
    #[cfg(windows)]
    let identity = identity.replace('/', "\\").to_lowercase();
    // Fixed FNV-1a 128, rather than Rust's unspecified DefaultHasher format.
    let mut hash = 0x6c62272e07bb014262b821756295c58du128;
    for byte in identity.as_bytes() {
        hash ^= u128::from(*byte);
        hash = hash.wrapping_mul(0x0000000001000000000000000000013b);
    }
    Ok(format!("{hash:032x}"))
}

pub fn data_directory(app: &tauri::AppHandle) -> PathBuf {
    app.state::<ProjectProfile>().directory.clone()
}

pub fn create_main(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() { return Ok(()); }
    let config = app.config().app.windows[0].clone();
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .data_directory(data_directory(app))
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_paths_are_isolated_and_aliases_resolve() {
        let root = std::env::temp_dir();
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(profile_key(Some(&cwd)).unwrap(), profile_key(Some(&cwd.join("."))).unwrap());
        assert_ne!(profile_key(Some(&cwd)).unwrap(), profile_key(Some(&root)).unwrap());
        assert_ne!(profile_key(Some(&cwd)).unwrap(), profile_key(None).unwrap());
        assert_eq!(profile_key(Some(&cwd)).unwrap().len(), 32);
    }

    #[test]
    fn simultaneous_instances_never_share_a_profile() {
        let root = std::env::temp_dir().join(format!("nexusdesk-profile-test-{}", std::process::id()));
        let first = allocate(&root, None).unwrap();
        let second = allocate(&root, None).unwrap();
        assert_ne!(first.directory, second.directory);
        let stable = first.directory.clone();
        drop(first);
        let next = allocate(&root, None).unwrap();
        assert_eq!(next.directory, stable);
        drop(next);
        drop(second);
        std::fs::remove_dir_all(root).unwrap();
    }
}
