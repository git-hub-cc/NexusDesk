# 项目协作规范

| 场景 | 要求使用 | 避免使用 |
| --- | --- | --- |
| PowerShell 5.1 | 用 `;` 或分开执行命令；读取文件使用 `Get-Content -LiteralPath <路径> -Encoding UTF8`；对文件或目录执行操作时，路径参数优先使用 `-LiteralPath`；搜索文本或显示匹配行时使用 `Select-String`；截取前后若干行时使用 `Select-Object -First` / `-Last`，跳过行时使用 `Select-Object -Skip`；替换文本时使用 PowerShell 的 `-replace`。 | Bash 的 `&&`、`||`；依赖默认文件编码；将可能含通配符或特殊字符的路径传给 `-Path`；禁止使用当前 PowerShell 环境中不可用的 Unix 命令，包括 `sed`、`head`、`tail`、`awk`、`grep`、`nl` 等。|
| 文件定位 | 使用明确的相对路径或绝对路径定位文件；路径含空格、方括号、星号等特殊字符时，对支持该参数的 cmdlet 使用 `-LiteralPath`，避免通配符展开；在命令中将路径作为单个参数传递。 | 依赖模糊的当前目录或未加引号的含空格路径；用 `-Path` 解释本应按字面处理的文件名。|
| 中文与文件编码 | 保持文件为 UTF-8； |  |
| 代码 | 遵循现有代码风格，遵循对应语言的 Google Style Guide；分别用 `npm run build`、`cargo fmt --check` 验证相关改动。 |  |
| UI 与交互 | 复用现有组件、交互模式。 |  |
| 代码注释 | 使用中文，仅在确有助于理解时添加。 |  |
