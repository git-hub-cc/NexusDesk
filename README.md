# NexusDesk

NexusDesk 是一个集成代码编辑、文件管理、浏览器、音乐、视频和本地语音识别功能的桌面工作台。项目基于 React、Vite 和 Tauri 构建。

## 网络资源说明

部分功能依赖第三方网站或在线下载服务。网络可达性取决于所在地区、运营商、DNS、目标站点策略和临时服务状态；在中国大陆网络环境下，以下功能可能无法打开、搜索超时、下载失败或内容不完整：

| 功能 | 可能访问的服务 | 影响 |
| --- | --- | --- |
| 音乐页的在线搜索和歌曲下载 | 在线音乐搜索/播放接口及其音频、封面资源 | 搜索结果为空、播放失败或无法下载；已导入的本地音乐不受影响 |
| 导航和浏览器中的境外网站 | Google、YouTube、GitHub、Hugging Face、部分 AI 和视频站点 | 页面无法加载、登录失败或资源请求超时 |
| 视频下载 | 视频来源站点、`yt-dlp` 所需的站点接口 | 解析失败、下载速度慢或无法获取媒体 |
| GitHub 同步和远程 Git 操作 | GitHub API、GitHub 仓库地址 | 拉取、推送、同步或扩展下载可能失败 |

这些限制不是应用本身的离线功能故障。请先检查网络连接，再根据所在网络环境选择合适的代理或镜像，并遵守当地法律法规及相关网站的使用条款。

### 语音识别模型

语音识别使用本地 SenseVoice 模型。Windows 安装包分为内置模型版和轻量版：内置模型版安装后即可离线识别；轻量版会在首次使用时下载模型，成功后可离线识别。

在 Windows 开发环境中运行 `npm run package:windows`，会在 `release` 目录输出 `NexusDesk-不含STT内置模型.exe` 和 `NexusDesk-内置语音模型.exe`。运行 `npm run package:windows-no-stt-model` 可只生成不含 STT 内置模型的安装包。该版本仍可下载模型使用语音转文字。内置模型版打包前会从固定版本的 Hugging Face 仓库获取约 239 MB 的模型和词表，因此需要可访问该站点的网络。

若轻量版自动下载失败，请：

1. 在可以访问 Hugging Face 的网络环境中重试首次下载。
2. 确认应用具有访问网络和写入用户数据目录的权限。
3. 将模型文件通过合规的网络或镜像获取后，按应用提示放置到模型目录，再重新打开语音识别。

模型下载过程中请保持网络稳定；不完整的下载文件需要删除后重新尝试。模型来源和版本由项目代码固定，修改来源时请同时检查许可证和文件完整性。

### 音乐和视频

- 在线音乐页需要访问远程搜索和音频服务。网络受限时，可以使用“导入音乐”将本地音频加入曲库，播放和歌单管理仍可用。
- 视频下载依赖目标站点和本机的下载工具。请优先使用自己拥有或获授权的内容，并注意站点的访问限制。
- 导航页会标记部分需要代理的站点；打开代理模式只会控制这些站点的显示，不会替用户提供代理服务。

## 开发

```bash
npm install
npm run dev
```

构建生产版本：

```bash
npm run build
```

运行桌面端开发命令请参阅 `package.json` 中的 Tauri 脚本及项目文档。Node.js、Rust 和 Tauri 的系统依赖需要提前安装。

### Windows 旧版本安装 WinGet

Windows 10 及更早版本的 Windows 可能未预装 `winget`。如果开发脚本或依赖安装提示找不到 `winget`，可以在 **PowerShell（建议以管理员身份运行）** 中执行以下脚本。脚本会从 Microsoft、NuGet 和 GitHub 下载 WinGet 及其依赖，因此同样受网络限制影响。

```powershell
# 1. 建立临时工作目录
$workDir = "$env:TEMP\winget_install"
if (Test-Path $workDir) { Remove-Item -Path $workDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

# 2. 下载所有必需组件
Write-Host "正在下载 VC++ 运行库..." -ForegroundColor Green
Invoke-WebRequest -Uri "https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx" -OutFile "$workDir\VCLibs.appx"

Write-Host "正在从 NuGet 下载 Microsoft.UI.Xaml 依赖..." -ForegroundColor Green
Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.UI.Xaml/2.8.6" -OutFile "$workDir\xaml.zip"
Expand-Archive -Path "$workDir\xaml.zip" -DestinationPath "$workDir\xaml_extracted" -Force

Write-Host "正在下载 WinGet 主程序包..." -ForegroundColor Green
Invoke-WebRequest -Uri "https://github.com/microsoft/winget-cli/releases/download/v1.7.11261/Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle" -OutFile "$workDir\WinGet.msixbundle"

# 3. 按依赖顺序依次安装
Write-Host "正在安装 VC++ 运行库..." -ForegroundColor Yellow
Add-AppxPackage -Path "$workDir\VCLibs.appx"

Write-Host "正在安装 UI.Xaml 依赖框架..." -ForegroundColor Yellow
Add-AppxPackage -Path "$workDir\xaml_extracted\tools\AppX\x64\Release\Microsoft.UI.Xaml.2.8.appx"

Write-Host "正在安装 WinGet 主程序..." -ForegroundColor Yellow
Add-AppxPackage -Path "$workDir\WinGet.msixbundle"

# 4. 清理临时文件
Remove-Item -Path $workDir -Recurse -Force
Write-Host "WinGet 安装全部完成！" -ForegroundColor Green
```

执行前请确认系统为 64 位 Windows，并确保 PowerShell 能够访问上述下载地址。若 `Add-AppxPackage` 报依赖、签名或权限错误，请先安装系统更新并确认使用了与系统架构匹配的安装包；也可以从 Microsoft Store 或微软官方 WinGet 发布页安装最新版。不要从不可信来源替换这些安装包。

## 隐私与数据

语音识别在本地运行，录音和识别结果不会因识别流程自动上传到云端；但浏览器、音乐、视频、Git 和导航功能会按目标服务的规则发起网络请求。使用 GitHub Token、代理或其他凭据时，请只在可信环境中保存，并避免将凭据提交到项目文件或日志中。
