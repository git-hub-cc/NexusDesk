# 项目协作规范

| 场景 | 要求使用 | 避免使用 |
| --- | --- | --- |
| PowerShell 5.1 | 用 `;` 或分开执行命令；读取文件时指定 `Get-Content -Encoding UTF8`。 | Bash 的 `&&`、`||`； |
| 中文与文件编码 | 保持文件为 UTF-8； |  |
| 代码 | 遵循现有代码风格，遵循对应语言的 Google Style Guide；分别用 `npm run build`、`cargo fmt --check` 验证相关改动。 |  |
| UI 与交互 | 复用现有组件、交互模式。 |  |
| 代码注释 | 使用中文，仅在确有助于理解时添加。 |  |
