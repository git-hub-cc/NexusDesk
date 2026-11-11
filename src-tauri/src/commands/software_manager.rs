use serde::Serialize;
use std::path::PathBuf;
use tokio::process::Command;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSoftware {
    id: &'static str,
    name: &'static str,
}

const SOFTWARE: [ManagedSoftware; 11] = [
    ManagedSoftware {
        id: "Google.PlatformTools",
        name: "Android SDK Platform-Tools (ADB)",
    },
    ManagedSoftware {
        id: "yt-dlp.FFmpeg",
        name: "FFmpeg for yt-dlp",
    },
    ManagedSoftware {
        id: "yt-dlp.yt-dlp",
        name: "yt-dlp",
    },
    ManagedSoftware {
        id: "Genymobile.scrcpy",
        name: "scrcpy",
    },
    ManagedSoftware {
        id: "Git.Git",
        name: "Git 2.56.0.4",
    },
    ManagedSoftware {
        id: "OpenAI.Codex",
        name: "Codex CLI",
    },
    ManagedSoftware {
        id: "Rustlang.Rust.MSVC",
        name: "Rust 1.99 (MSVC 64-bit)",
    },
    ManagedSoftware {
        id: "Python.Python.3.14",
        name: "Python 3.14.10 (64-bit)",
    },
    ManagedSoftware {
        id: "Python.Launcher",
        name: "Python Launcher",
    },
    ManagedSoftware {
        id: "OpenJS.NodeJS",
        name: "Node.js",
    },
    ManagedSoftware {
        id: "TheDocumentFoundation.LibreOffice",
        name: "LibreOffice 26.8.2.2",
    },
];

async fn winget_path() -> Result<PathBuf, String> {
    let mut command = Command::new("where.exe");
    command.arg("winget.exe");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().await;
    if let Ok(output) = output {
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                return Ok(PathBuf::from(path.trim()));
            }
        }
    }
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| {
            "找不到 winget：LOCALAPPDATA 环境变量未设置。请先安装或启动一次“应用安装程序”。"
                .to_string()
        })?;
    let links = local_app_data.join("Microsoft/WindowsApps/winget.exe");
    if links.is_file() {
        return Ok(links);
    }
    Err("找不到 winget。请先安装或启动一次“应用安装程序”，然后重启 NexusDesk。".into())
}

async fn winget(args: &[&str]) -> Result<String, String> {
    let path = winget_path().await?;
    let mut command = Command::new(&path);
    command.args(args).arg("--disable-interactivity");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .await
        .map_err(|error| format!("无法启动 winget：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let details = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|text| !text.is_empty())
            .unwrap_or("winget 未返回错误详情");
        return Err(format!(
            "winget 操作失败（退出码 {}，{}）：{}",
            output.status,
            path.display(),
            details.chars().take(500).collect::<String>()
        ));
    }
    Ok(format!("{stdout}{stderr}"))
}

async fn package_is_installed(id: &str) -> Result<bool, String> {
    let output = winget(&[
        "list",
        "--id",
        id,
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
    ])
    .await;
    match output {
        Ok(output) => Ok(output
            .lines()
            .any(|line| line.split_whitespace().any(|column| column == id))),
        Err(error)
            if error.contains("0x8a150014")
                || error.contains("找不到与输入条件匹配的已安装程序包") =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn managed_software_list() -> Result<Vec<ManagedSoftware>, String> {
    winget(&["--version"]).await?;
    Ok(SOFTWARE.to_vec())
}

#[tauri::command]
pub async fn managed_software_status(id: String) -> Result<bool, String> {
    if !SOFTWARE.iter().any(|software| software.id == id) {
        return Err("未知的软件包 ID".into());
    }
    package_is_installed(&id).await
}

#[tauri::command]
pub async fn managed_software_install(id: String) -> Result<(), String> {
    if !SOFTWARE.iter().any(|software| software.id == id) {
        return Err("未知的软件包 ID".into());
    }
    winget(&[
        "install",
        "--id",
        &id,
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
    ])
    .await?;
    if !package_is_installed(&id).await? {
        return Err(format!(
            "winget 已返回成功，但没有检测到 {id}。请刷新软件状态后重试。"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn managed_software_uninstall(id: String) -> Result<(), String> {
    if !SOFTWARE.iter().any(|software| software.id == id) {
        return Err("未知的软件包 ID".into());
    }
    if !package_is_installed(&id).await? {
        return Ok(());
    }
    winget(&["uninstall", "--id", &id, "--exact", "--source", "winget"]).await?;
    if package_is_installed(&id).await? {
        return Err(format!(
            "winget 已返回成功，但 {id} 仍显示为已安装。请刷新软件状态后重试。"
        ));
    }
    Ok(())
}
