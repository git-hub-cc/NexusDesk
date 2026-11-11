use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use tauri::{State, ipc::Channel};

struct Session {
    owner: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for Session {
    fn drop(&mut self) {
        // Kill the entire process group on Unix and the assigned Job Object on
        // Windows before reaping the PTY leader.
        #[cfg(windows)]
        if let Some(pid) = self.child.process_id() {
            windows_job::terminate(pid);
        }
        #[cfg(unix)]
        if let Some(pid) = self.child.process_id() {
            // Query the still-owned PTY, rather than trusting a cached PID after
            // try_wait may have reaped the shell. kill(pid, 0) alone cannot
            // distinguish an unrelated process that reused that PID.
            if let Some(fd) = self.master.as_raw_fd() {
                let session = unsafe { libc::tcgetsid(fd) };
                let groups = [self.master.process_group_leader(), Some(pid as libc::pid_t)];
                for group in groups.into_iter().flatten() {
                    if session <= 0 || group <= 1 {
                        continue;
                    }
                    if unsafe { libc::getsid(group) } != session
                        || unsafe { libc::getpgid(group) } != group
                    {
                        continue;
                    }
                    let result = unsafe { libc::kill(-group, libc::SIGKILL) };
                    if result != 0 {
                        let error = std::io::Error::last_os_error();
                        if error.raw_os_error() != Some(libc::ESRCH) {
                            log::warn!("Terminal process group cleanup ({group}): {error}");
                        }
                    }
                }
            }
        }
        let _ = self.child.kill();
        if let Err(error) = self.child.wait() {
            log::warn!("Cannot reap terminal process: {error}");
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::{ffi::c_void, mem, sync::Mutex};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
            },
            Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
                PROCESS_TERMINATE,
            },
        },
    };

    static JOBS: Mutex<Vec<(u32, usize)>> = Mutex::new(Vec::new());

    pub fn assign(pid: u32) {
        unsafe {
            let process = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SET_QUOTA,
                0,
                pid,
            );
            if process.is_null() {
                log::warn!(
                    "Cannot open terminal process {pid} for Job Object: {}",
                    std::io::Error::last_os_error()
                );
                return;
            }
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                CloseHandle(process);
                log::warn!(
                    "Cannot create terminal Job Object: {}",
                    std::io::Error::last_os_error()
                );
                return;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // Only separately launched projects request breakaway. Shells and
            // their descendants still inherit this job for crash cleanup.
            if pid == std::process::id() {
                limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            }
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                mem::size_of_val(&limits) as u32,
            ) != 0;
            let assigned = configured && AssignProcessToJobObject(job, process) != 0;
            CloseHandle(process);
            if assigned {
                JOBS.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push((pid, job as usize));
            } else {
                CloseHandle(job);
                log::warn!(
                    "Cannot assign terminal process {pid} to Job Object: {}",
                    std::io::Error::last_os_error()
                );
            }
        }
    }

    pub fn terminate(pid: u32) {
        let mut jobs = JOBS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(index) = jobs.iter().position(|(job_pid, _)| *job_pid == pid) {
            let (_, job) = jobs.remove(index);
            let job = job as HANDLE;
            unsafe {
                TerminateJobObject(job, 1);
                CloseHandle(job);
            }
        } else {
            use std::os::windows::process::CommandExt;
            match std::process::Command::new("taskkill.exe")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .output()
            {
                Ok(output) if output.status.success() => {}
                Ok(output) => log::warn!(
                    "Terminal process tree cleanup ({pid}): {}",
                    String::from_utf8_lossy(&output.stderr)
                ),
                Err(error) => log::warn!("Terminal process tree cleanup ({pid}): {error}"),
            }
        }
    }
}

pub struct TerminalState(Arc<Mutex<HashMap<String, Session>>>);

impl Default for TerminalState {
    fn default() -> Self {
        // Bind the host before spawning shells: children inherit crash cleanup
        // even during the interval before their per-session job is assigned.
        #[cfg(windows)]
        windows_job::assign(std::process::id());
        Self(Arc::default())
    }
}

impl TerminalState {
    pub fn close_window(&self, owner: &str) {
        let removed = {
            let mut sessions = self.0.lock().unwrap_or_else(|error| error.into_inner());
            let ids: Vec<_> = sessions
                .iter()
                .filter(|(_, session)| session.owner == owner)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id))
                .collect::<Vec<_>>()
        };
        drop(removed);
    }
    pub fn shutdown(&self) {
        // Tauri may exit without dropping its managed state.
        let sessions =
            std::mem::take(&mut *self.0.lock().unwrap_or_else(|error| error.into_inner()));
        drop(sessions);
    }
}

static HISTORY_LOCK: Mutex<()> = Mutex::new(());

fn history_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join(".nexus/terminal_history.json"))
}

fn read_history() -> Result<Vec<String>, String> {
    match std::fs::read(history_path()?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn load_terminal_history() -> Result<Vec<String>, String> {
    let _guard = HISTORY_LOCK.lock().map_err(|e| e.to_string())?;
    read_history()
}

#[tauri::command]
pub fn save_terminal_history(command: String) -> Result<Vec<String>, String> {
    let _guard = HISTORY_LOCK.lock().map_err(|e| e.to_string())?;
    let mut history = read_history()?;
    let command = command.trim();
    if command.is_empty() || command.contains(['\r', '\n', '\0']) {
        return Ok(history);
    }
    history.retain(|entry| entry != command);
    history.insert(0, command.to_owned());
    history.truncate(2000);
    let path = history_path()?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&history).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(history)
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output(Vec<u8>),
    Exit,
}

#[cfg(windows)]
fn canonicalize_launcher(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    // Resolve each reparse point before traversing it. Opening the whole path
    // first can fail with ERROR_UNTRUSTED_MOUNT_POINT for Scoop's current junction.
    let mut path = std::path::absolute(path)?;
    for _ in 0..64 {
        let mut prefix = std::path::PathBuf::new();
        let mut components = path.components();
        let mut redirected = false;
        while let Some(component) = components.next() {
            prefix.push(component);
            if std::fs::symlink_metadata(&prefix)?.file_type().is_symlink() {
                let target = std::fs::read_link(&prefix)?;
                prefix.pop();
                path = prefix.join(target).join(components.as_path());
                redirected = true;
                break;
            }
        }
        if !redirected {
            return std::fs::canonicalize(path);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "启动程序路径包含过多链接或循环链接",
    ))
}

fn resolve_terminal_command(command: &str, cwd: Option<&str>) -> Result<String, String> {
    if command.trim().is_empty() {
        return Ok(command.into());
    }
    // Resolve the first command without executing the configured startup command.
    #[cfg(windows)]
    let mut probe = {
        use std::os::windows::process::CommandExt;
        let mut probe = std::process::Command::new("powershell.exe");
        probe.creation_flags(0x08000000);
        probe.args(["-NoLogo", "-NonInteractive", "-Command", r#"
            chcp 65001 > $null
            [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
            [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            $tokens = $null; $errors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseInput($env:NEXUSDESK_STARTUP_COMMAND, [ref]$tokens, [ref]$errors)
            if ($errors.Count) { [Console]::Error.Write('启动命令语法错误'); exit 2 }
            $first = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)
            if ($null -eq $first) { exit 0 }
            $name = $first.GetCommandName()
            if (-not $name) { [Console]::Error.Write('无法检测动态命令，请使用明确的工具名称或路径'); exit 2 }
            $resolved = Get-Command -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $resolved -and $name -eq 'codex') {
                $resolved = Get-Command -Name 'codex-*-pc-windows-msvc.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            }
            if (-not $resolved) {
                [Console]::Error.Write(('未找到命令 {0}。请先安装对应 CLI 并将其加入 PATH，或在命令行工具设置中修改启动命令。安装后请重启 NexusDesk。' -f $name)); exit 1
            }
            if ($resolved.CommandType -eq 'Application' -and $resolved.Path.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
                $shim = [IO.Path]::ChangeExtension($resolved.Path, '.shim')
                if (Test-Path -LiteralPath $shim -PathType Leaf) {
                    $metadata = Get-Content -LiteralPath $shim -Raw
                    $target = [regex]::Match($metadata, '(?m)^\s*path\s*=\s*"([^"\r\n]+)"\s*$')
                    $arguments = [regex]::Match($metadata, '(?m)^\s*args\s*=\s*(.+)$')
                    # Shims with their own arguments must retain their wrapper semantics.
                    if ($target.Success -and (-not $arguments.Success -or $arguments.Groups[1].Value.Trim() -eq '""')) {
                        $path = [Environment]::ExpandEnvironmentVariables($target.Groups[1].Value)
                        if (-not [IO.Path]::IsPathRooted($path)) { $path = Join-Path (Split-Path $shim) $path }
                        $element = $first.CommandElements[0].Extent
                        $prefix = $env:NEXUSDESK_STARTUP_COMMAND.Substring(0, $element.StartOffset)
                        if ($first.InvocationOperator.ToString() -eq 'Unknown') { $prefix += '& ' }
                        @{ path = $path; prefix = $prefix; suffix = $env:NEXUSDESK_STARTUP_COMMAND.Substring($element.EndOffset) } | ConvertTo-Json -Compress
                    }
                }
            }
        "#]);
        probe.env("NEXUSDESK_STARTUP_COMMAND", command);
        configure_windows_utf8_command(&mut probe);
        probe
    };
    #[cfg(not(windows))]
    let mut probe = {
        // Preserve quoted executable paths; never evaluate expansions during detection.
        let mut executable = String::new();
        let mut quote = None;
        for ch in command.trim().chars() {
            if let Some(delimiter) = quote {
                if ch == delimiter {
                    quote = None;
                } else {
                    executable.push(ch);
                }
            } else if ch == '\'' || ch == '"' {
                quote = Some(ch);
            } else if ch.is_whitespace() || matches!(ch, ';' | '|' | '&') {
                break;
            } else {
                executable.push(ch);
            }
        }
        if quote.is_some() || executable.is_empty() {
            return Err("请使用明确的工具名称或路径作为启动命令".into());
        }
        let mut probe =
            std::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
        probe.args([
            "-c",
            "command -v -- \"$1\" >/dev/null 2>&1",
            "nexusdesk-check",
            &executable,
        ]);
        probe
    };
    if let Some(path) = cwd {
        probe.current_dir(path);
    }
    let output = probe
        .output()
        .map_err(|error| format!("无法检测启动命令：{error}"))?;
    if output.status.success() {
        #[cfg(windows)]
        if !output.stdout.is_empty() {
            #[derive(serde::Deserialize)]
            struct ShimTarget {
                path: String,
                prefix: String,
                suffix: String,
            }
            let target: ShimTarget = serde_json::from_slice(&output.stdout)
                .map_err(|error| format!("无法解析启动程序：{error}"))?;
            let path =
                canonicalize_launcher(std::path::Path::new(&target.path)).map_err(|error| {
                    format!(
                        "启动程序目标不可用：{}：{error}。请修复或重新安装对应 CLI。",
                        target.path
                    )
                })?;
            // PowerShell expects a regular DOS/UNC path rather than a verbatim path.
            let path = path.to_string_lossy();
            let path = path
                .strip_prefix(r"\\?\UNC\")
                .map(|p| format!(r"\\{p}"))
                .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned());
            return Ok(format!(
                "{}'{}'{}",
                target.prefix,
                path.replace("'", "''"),
                target.suffix
            ));
        }
        return Ok(command.into());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if detail.is_empty() {
        "未找到启动命令。请安装对应 CLI 并将其加入 PATH，或在命令行工具设置中修改启动命令。安装后请重启 NexusDesk。".into()
    } else {
        detail
    })
}

fn validate_terminal_command(command: &str, cwd: Option<&str>) -> Result<(), String> {
    resolve_terminal_command(command, cwd).map(|_| ())
}

#[tauri::command]
pub async fn check_terminal_command(command: String, cwd: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_terminal_command(&command, cwd.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(windows)]
fn configure_windows_utf8_command(cmd: &mut std::process::Command) {
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("NODE_CLI_FORCE_UTF8", "1");
    cmd.env("NEXUSDESK_UTF8", "1");
}

#[cfg(windows)]
fn configure_windows_utf8_builder(cmd: &mut CommandBuilder) {
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("NODE_CLI_FORCE_UTF8", "1");
    cmd.env("NEXUSDESK_UTF8", "1");
}

#[cfg(windows)]
fn enforce_utf8_console() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetConsoleCP(code_page: u32) -> i32;
        fn SetConsoleOutputCP(code_page: u32) -> i32;
    }
    const CP_UTF8: u32 = 65001;
    // Best effort: GUI processes may have no attached console. The child shell
    // also initializes its own encodings after ConPTY has been created.
    unsafe {
        SetConsoleCP(CP_UTF8);
        SetConsoleOutputCP(CP_UTF8);
    }
}

// Parse literal native invocations out of process; never render a shell in PTY
// before handing control to a TUI. Complex shell expressions retain shell semantics.
#[cfg(windows)]
fn direct_terminal_command(
    command: &str,
    cwd: Option<&str>,
) -> Result<Option<CommandBuilder>, String> {
    use std::os::windows::process::CommandExt;
    if command.trim().is_empty() {
        return Ok(None);
    }
    let mut probe = std::process::Command::new("powershell.exe");
    probe.creation_flags(0x08000000);
    probe.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", r#"
        chcp 65001 > $null
        [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $OutputEncoding = [Text.UTF8Encoding]::new($false)
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($env:NEXUSDESK_STARTUP_COMMAND, [ref]$tokens, [ref]$errors)
        if ($errors.Count -or $ast.EndBlock.Statements.Count -ne 1) { exit 0 }
        $pipeline = $ast.EndBlock.Statements[0]
        if ($pipeline -isnot [Management.Automation.Language.PipelineAst] -or $pipeline.PipelineElements.Count -ne 1) { exit 0 }
        $call = $pipeline.PipelineElements[0]
        if ($call -isnot [Management.Automation.Language.CommandAst] -or $call.Redirections.Count -or $call.InvocationOperator.ToString() -eq 'Dot') { exit 0 }
        $values = @()
        foreach ($element in $call.CommandElements) {
            if ($element -is [Management.Automation.Language.StringConstantExpressionAst]) { $values += $element.Value }
            elseif ($element -is [Management.Automation.Language.CommandParameterAst] -and $null -eq $element.Argument) { $values += $element.Extent.Text }
            else { exit 0 }
        }
        $resolved = Get-Command -Name $values[0] -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $resolved -and $values[0] -eq 'codex') {
            $resolved = Get-Command -Name 'codex-*-pc-windows-msvc.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        }
        if (-not $resolved) { exit 0 }
        $path = $resolved.Path
        $arguments = @($values | Select-Object -Skip 1)
        if ($path -and [IO.Path]::GetExtension($path) -in @('.ps1', '.cmd')) {
            # npm's Codex launcher has a stable JS entry point beside its shim.
            $entry = Join-Path (Split-Path $path) 'node_modules/@openai/codex/bin/codex.js'
            if ([IO.Path]::GetFileNameWithoutExtension($path) -ne 'codex' -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) { exit 0 }
            $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $node) { exit 0 }
            $path = $node.Path; $arguments = @($entry) + $arguments
        }
        if (-not $path -or -not $path.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { exit 0 }
        # Let the shell bootstrap below initialize PowerShell's encodings. A
        # directly spawned PowerShell otherwise inherits the system (often GBK)
        # code page and its text is decoded as garbled UTF-8 by the terminal.
        if ([IO.Path]::GetFileName($path) -match '^(powershell|pwsh)\.exe$') { exit 0 }
        @{ path = $path; arguments = @($arguments) } | ConvertTo-Json -Compress
    "#]);
    configure_windows_utf8_command(&mut probe);
    probe.env("NEXUSDESK_STARTUP_COMMAND", command);
    if let Some(cwd) = cwd {
        probe.current_dir(cwd);
    }
    let output = probe.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    if output.stdout.is_empty() {
        return Ok(None);
    }
    #[derive(serde::Deserialize)]
    struct Invocation {
        path: String,
        arguments: Vec<String>,
    }
    let invocation: Invocation =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let mut cmd = CommandBuilder::new(invocation.path);
    cmd.args(invocation.arguments);
    Ok(Some(cmd))
}

#[tauri::command]
pub fn start_terminal(
    window: tauri::Window,
    id: String,
    cwd: Option<String>,
    command: String,
    cols: u16,
    rows: u16,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
    on_event: Channel<TerminalEvent>,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    let command = resolve_terminal_command(&command, cwd.as_deref())?;
    #[cfg(windows)]
    enforce_utf8_console();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: pixel_width.unwrap_or(0),
            pixel_height: pixel_height.unwrap_or(0),
        })
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let mut cmd = if let Some(cmd) = direct_terminal_command(&command, cwd.as_deref())? {
        cmd
    } else {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        // Keep Windows console code pages aligned with UTF-8 output from modern
        // CLI tools. Setting the .NET encodings also makes PowerShell's own
        // stdin/stdout handling consistent with the PTY byte stream.
        // 保持脚本固定，通过环境变量传递启动命令，避免 PowerShell 二次解析引号。
        let initialize_utf8 = "chcp 65001 > $null; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8'; $env:NEXUSDESK_UTF8 = '1'";
        let run_startup = "if ($env:NEXUSDESK_STARTUP_COMMAND) { & ([scriptblock]::Create($env:NEXUSDESK_STARTUP_COMMAND)) }";
        cmd.arg("-NoExit");
        cmd.arg("-Command");
        cmd.arg(format!("{initialize_utf8}; {run_startup}"));
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd =
            CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
        if !command.trim().is_empty() {
            cmd.arg("-c");
            cmd.arg(&command);
        } else {
            cmd.arg("-l");
        }
        cmd
    };
    if let Some(path) = cwd {
        cmd.cwd(path);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    #[cfg(windows)]
    configure_windows_utf8_builder(&mut cmd);
    // Keep common runtimes on UTF-8 even when Windows uses a GBK system locale.
    #[cfg(not(windows))]
    cmd.env("LANG", "en_US.UTF-8");
    #[cfg(not(windows))]
    cmd.env("LC_ALL", "en_US.UTF-8");
    #[cfg(not(windows))]
    cmd.env("PYTHONUTF8", "1");
    #[cfg(not(windows))]
    cmd.env("PYTHONIOENCODING", "utf-8");
    #[cfg(not(windows))]
    cmd.env("NODE_CLI_FORCE_UTF8", "1");
    #[cfg(windows)]
    cmd.env("WT_SESSION", "1");
    #[cfg(windows)]
    if !command.trim().is_empty() {
        // 将命令作为数据传递，避免把引号和转义符拼入固定的 PowerShell 启动脚本。
        cmd.env("NEXUSDESK_STARTUP_COMMAND", &command);
    }
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    #[cfg(windows)]
    if let Some(pid) = child.process_id() {
        windows_job::assign(pid);
    }
    let sessions = state.0.clone();
    let pid = child.process_id();
    state.0.lock().map_err(|e| e.to_string())?.insert(
        id.clone(),
        Session {
            owner: window.label().into(),
            master: pair.master,
            writer,
            child,
        },
    );
    // The shell may exit while a descendant still holds the PTY output open.
    // Poll the leader independently of reader EOF so handles and descendants
    // are reclaimed even in that case.
    let monitor_sessions = Arc::downgrade(&sessions);
    let monitor_id = id.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let Some(sessions) = monitor_sessions.upgrade() else {
                break;
            };
            let removed = {
                let mut sessions = sessions.lock().unwrap_or_else(|e| e.into_inner());
                let Some(session) = sessions.get_mut(&monitor_id) else {
                    break;
                };
                if session.child.process_id() != pid {
                    break;
                }
                match session.child.try_wait() {
                    Ok(Some(_)) => sessions.remove(&monitor_id),
                    Ok(None) => None,
                    Err(error) => {
                        log::warn!("Cannot poll terminal process: {error}");
                        sessions.remove(&monitor_id)
                    }
                }
            };
            if removed.is_some() {
                drop(removed);
                break;
            }
        }
    });
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if on_event
                        .send(TerminalEvent::Output(buffer[..count].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let removed = {
            let mut sessions = sessions.lock().unwrap_or_else(|e| e.into_inner());
            if sessions
                .get(&id)
                .is_some_and(|session| session.child.process_id() == pid)
            {
                sessions.remove(&id)
            } else {
                None
            }
        };
        drop(removed);
        let _ = on_event.send(TerminalEvent::Exit);
    });
    Ok(())
}

#[tauri::command]
pub fn write_terminal(
    id: String,
    data: String,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("终端会话已关闭")?;
    #[cfg(unix)]
    reset_terminal_after_interruption(session);
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| e.to_string())
}

#[cfg(unix)]
fn reset_terminal_after_interruption(session: &Session) {
    let Some(fd) = session.master.as_raw_fd() else {
        return;
    };
    let foreground = unsafe { libc::tcgetpgrp(fd) };
    let Some(shell_group) = session.master.process_group_leader() else {
        return;
    };
    if foreground != shell_group {
        return;
    }

    let mut attributes = unsafe { std::mem::zeroed::<libc::termios>() };
    if unsafe { libc::tcgetattr(fd, &mut attributes) } != 0 {
        return;
    }
    if attributes.c_lflag & libc::ISIG != 0 && attributes.c_lflag & libc::ICANON != 0 {
        return;
    }

    unsafe { libc::cfmakeraw(&mut attributes) };
    attributes.c_iflag |= libc::ICRNL | libc::IXON;
    attributes.c_oflag |= libc::OPOST;
    attributes.c_lflag |= libc::ISIG | libc::ICANON | libc::ECHO | libc::IEXTEN;
    attributes.c_cc[libc::VMIN] = 1;
    attributes.c_cc[libc::VTIME] = 0;
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &attributes) } != 0 {
        log::debug!(
            "Cannot restore terminal attributes after interrupted foreground process: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[tauri::command]
pub fn resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|e| e.to_string())?;
    sessions
        .get(&id)
        .ok_or("终端会话已关闭")?
        .master
        .resize(PtySize {
            cols: cols.max(1),
            rows: rows.max(1),
            pixel_width: pixel_width.unwrap_or(0),
            pixel_height: pixel_height.unwrap_or(0),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_terminal(id: String, state: State<'_, TerminalState>) -> Result<(), String> {
    let session = state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    drop(session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_terminal_command;

    #[cfg(windows)]
    #[test]
    fn launcher_resolves_directory_junction_before_traversing() {
        let root = std::env::temp_dir().join(format!("nexusdesk-junction-{}", std::process::id()));
        let version = root.join("1.0");
        std::fs::create_dir_all(version.join("bin")).unwrap();
        std::fs::write(version.join("bin/tool.exe"), []).unwrap();
        let junction = root.join("current");
        let result = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&version)
            .output()
            .unwrap();
        assert!(result.status.success(), "{result:?}");
        let resolved = super::canonicalize_launcher(&junction.join("bin/tool.exe")).unwrap();
        assert_eq!(
            resolved,
            std::fs::canonicalize(version.join("bin/tool.exe")).unwrap()
        );
        assert!(super::canonicalize_launcher(&junction.join("bin/missing.exe")).is_err());
        // Remove only the junction itself, never its target recursively.
        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn scoop_shim_resolves_target_and_preserves_arguments() {
        let root = std::env::temp_dir().join(format!("nexusdesk-shim-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let shim = root.join("tool.exe");
        std::fs::write(&shim, []).unwrap();
        let target = std::env::current_exe().unwrap();
        std::fs::write(
            shim.with_extension("shim"),
            format!("path = \"{}\"\n", target.display()),
        )
        .unwrap();
        let command = format!("& '{}' --message '中文 参数'", shim.display());
        let resolved = super::resolve_terminal_command(&command, None).unwrap();
        assert!(resolved.starts_with("& '"), "{resolved}");
        assert!(
            resolved.contains(target.file_name().unwrap().to_str().unwrap()),
            "{resolved}"
        );
        assert!(resolved.ends_with(" --message '中文 参数'"), "{resolved}");
        std::fs::write(shim.with_extension("shim"), "path = \"missing.exe\"\n").unwrap();
        assert!(
            super::resolve_terminal_command(&command, None)
                .unwrap_err()
                .contains("missing.exe")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn native_launch_preserves_literal_arguments_and_rejects_shell_expressions() {
        let cmd =
            super::direct_terminal_command("powershell.exe -NoProfile -Command 'exit 73'", None)
                .unwrap()
                .unwrap();
        let argv = cmd.get_argv();
        assert_eq!(argv[1], "-NoProfile");
        assert_eq!(argv[3], "exit 73");
        assert!(
            super::direct_terminal_command("powershell.exe; Write-Output dirty", None)
                .unwrap()
                .is_none()
        );
        assert!(
            super::direct_terminal_command("powershell.exe $env:PATH", None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn default_shell_needs_no_custom_command() {
        assert!(validate_terminal_command("  ", None).is_ok());
    }

    #[test]
    fn missing_tool_returns_installation_guidance() {
        let error =
            validate_terminal_command("nexusdesk_missing_tool_9f3c71 --version", None).unwrap_err();
        assert!(error.contains("PATH"), "{error}");
    }

    #[test]
    fn detection_does_not_execute_startup_arguments() {
        #[cfg(windows)]
        let command = "& 'powershell.exe' -Command 'exit 73'";
        #[cfg(not(windows))]
        let command = "'/bin/sh' -c 'exit 73'";
        assert!(validate_terminal_command(command, None).is_ok());
    }
}
