# 项目协作规范

| 场景 | 避免使用 | 要求使用 |
| --- | --- | --- |
| PowerShell 5.1 命令连接 | Bash 的 `&&`、`\|\|`。 | 分开执行命令，或用 `;` 分隔，例如 `rg ...; git diff --check`。 |
| 预期命令返回非零状态 | 在命令后追加 `\|\| $true`。 | 直接运行命令；PowerShell 默认会继续执行后续语句。 |
| 复杂命令引号 | 在单行命令中嵌套多层引号。 | 将参数作为数组传入，或写入临时 `.ps1` 脚本。 |
| 在 PowerShell 中查看行号 | 使用 `nl`。 | 使用 `Select-String`。 |
| PowerShell 中转义双引号 | 使用 `\"`；反斜杠不能转义 PowerShell 的引号。 | 对包含双引号的正则表达式使用单引号字符串，例如：<br>`Select-String -Path src-tauri/src/commands/chat.rs -Pattern 'stream_delta\|stream": true\|bytes_stream\|chat-stream'` |
| 正则表达式同时包含单双引号 | 用反斜杠转义 PowerShell 字符串中的引号。 | 使用单引号字符串，并将内部单引号写成两个单引号，例如：<br>`rg -n 'from [''"]xlsx\|require\([''"]xlsx\|xlsx\.' src package.json` |
| 中文命令输出乱码 | 忽略编码问题或直接改文件内容。 | 检查控制台代码页及输入/输出编码；需要 UTF-8 时设置 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 并运行 `chcp 65001`。 |
| 实现已有组件或交互 | 创建重复模式，或偏离已有的交互行为、视觉层级、间距、字体、颜色、状态和无障碍规范。 | 复用现有组件，并遵循已有设计与交互模式。 |
| 跨页面保持 UI 一致 | 为新功能另建一套视觉规范。 | 优先使用共享组件和设计令牌；确需新模式时，使其符合现有设计系统。 |
| 编写或修改代码 | 忽略项目格式化、lint 规则或语言风格指南。 | 遵循对应语言的 Google Style Guide，并兼容仓库现有格式化与 lint 约定。 |
| 编写代码注释 | 使用中文以外的注释。 | 使用中文注释。 |