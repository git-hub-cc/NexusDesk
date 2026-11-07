use std::{ffi::OsString, path::PathBuf, process::Command};

pub struct StartupProject(pub Option<PathBuf>);
pub struct StartupUrl(pub Option<String>);
pub struct StartupFile(pub Option<PathBuf>);

pub fn project_argument(args: impl IntoIterator<Item = OsString>) -> Option<PathBuf> {
    let mut args = args.into_iter();
    args.next(); // executable
    while let Some(arg) = args.next() {
        if arg == "--project" {
            return args.next().filter(|path| !path.is_empty()).map(PathBuf::from);
        }
    }
    None
}

pub fn startup_url_argument(args: impl IntoIterator<Item = OsString>) -> Option<String> {
    let mut args = args.into_iter();
    args.next();
    while let Some(arg) = args.next() {
        if arg == "--project" {
            let _ = args.next();
            continue;
        }
        let value = arg.to_string_lossy();
        let Ok(url) = tauri::Url::parse(&value) else { continue; };
        if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
            return Some(url.to_string());
        }
    }
    None
}

pub fn startup_file_argument(args: impl IntoIterator<Item = OsString>) -> Option<PathBuf> {
    let mut args = args.into_iter();
    args.next();
    while let Some(arg) = args.next() {
        if arg == "--project" {
            let _ = args.next();
            continue;
        }
        let value = arg.to_string_lossy();
        if value.starts_with('-') || value.starts_with("http://") || value.starts_with("https://") { continue; }
        let path = PathBuf::from(arg);
        if path.is_file() { return Some(path); }
    }
    None
}

#[tauri::command]
pub fn startup_project(state: tauri::State<'_, StartupProject>) -> Option<String> {
    state.0.as_ref().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn startup_url(state: tauri::State<'_, StartupUrl>) -> Option<String> {
    state.0.clone()
}

#[tauri::command]
pub fn startup_file(state: tauri::State<'_, StartupFile>) -> Option<String> {
    state.0.as_ref().map(|path| path.to_string_lossy().into_owned())
}

fn project_command(executable: PathBuf, project: PathBuf) -> Command {
    let mut command = independent_command(executable);
    // Pass a single literal argument, including spaces, Unicode and shell syntax.
    command.arg("--project").arg(project);
    command
}

pub(crate) fn independent_command(executable: PathBuf) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A project must outlive its launcher. The host's terminal cleanup job
        // permits explicit breakaway; ordinary terminal children stay in it.
        command.creation_flags(0x08000000 | 0x01000000); // CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB
    }
    command
}

#[tauri::command]
pub fn open_project_instance(path: String) -> Result<u32, String> {
    // Keep the ordinary Windows path form used by frontend path comparisons;
    // canonicalize would introduce a verbatim \\?\ prefix.
    let project = std::path::absolute(&path).map_err(|error| error.to_string())?;
    if !project.is_dir() { return Err("Project path is not a directory".into()); }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    // A separate host process owns its own UI thread and TSF thread manager.
    // Do not attach it to terminal jobs or kill it when the launching window exits.
    let mut child = project_command(executable, project).spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn project_survives_launcher_exit() {
        const MARKER_ENV: &str = "NEXUSDESK_PROJECT_BREAKAWAY_TEST_MARKER";
        if let Some(marker) = std::env::var_os(MARKER_ENV) {
            // Reproduce the real host job in an isolated test process so its
            // exit cannot terminate the test runner or other parallel tests.
            let _terminals = crate::commands::terminal_cmds::TerminalState::default();
            let mut command = independent_command(PathBuf::from("powershell.exe"));
            command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                    "Start-Sleep -Milliseconds 500; [IO.File]::WriteAllText($env:NEXUSDESK_PROJECT_BREAKAWAY_TEST_MARKER, 'alive')"])
                .env(MARKER_ENV, marker);
            command.spawn().unwrap();
            return;
        }
        let marker = std::env::temp_dir().join(format!("nexusdesk-breakaway-{}.txt", std::process::id()));
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "commands::project_cmds::tests::project_survives_launcher_exit"])
            .env(MARKER_ENV, &marker).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(marker.exists(), "project child was terminated with its launcher");
        std::fs::remove_file(marker).unwrap();
    }

    #[test]
    fn startup_path_is_one_literal_argument() {
        let path = PathBuf::from("C:/项目 notes/a & $(test) #?%");
        let command = project_command(PathBuf::from("NexusDesk.exe"), path.clone());
        let args: Vec<_> = command.get_args().map(OsString::from).collect();
        assert_eq!(args, vec![OsString::from("--project"), path.clone().into_os_string()]);
        let mut launch = vec![OsString::from("NexusDesk.exe")];
        launch.extend(args);
        assert_eq!(project_argument(launch), Some(path));
    }

    #[test]
    fn ordinary_launch_has_no_project_override() {
        for args in [vec!["NexusDesk.exe"], vec!["NexusDesk.exe", "--project"], vec!["NexusDesk.exe", "--project", ""]] {
            assert_eq!(project_argument(args.into_iter().map(OsString::from)), None);
        }
    }

    #[test]
    fn startup_url_accepts_only_http_urls() {
        assert_eq!(startup_url_argument(["NexusDesk.exe", "https://example.com/a?q=1"].into_iter().map(OsString::from)), Some("https://example.com/a?q=1".into()));
        assert_eq!(startup_url_argument(["NexusDesk.exe", "--project", "C:/notes", "http://example.com"].into_iter().map(OsString::from)), Some("http://example.com/".into()));
        assert_eq!(startup_url_argument(["NexusDesk.exe", "file:///tmp/a"].into_iter().map(OsString::from)), None);
    }

    #[test]
    fn file_cannot_be_launched_as_a_project() {
        let executable = std::env::current_exe().unwrap();
        assert!(open_project_instance(executable.to_string_lossy().into_owned()).is_err());
    }
}
