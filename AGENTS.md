# 项目协作规范

| 场景 | 要求使用 | 避免使用 |
| --- | --- | --- |
| PowerShell 5.1 | 用 `;` 或分开执行命令；读取文件时指定 `Get-Content -Encoding UTF8`。 | Bash 的 `&&`、`||`；依赖默认文件编码。 |
| 中文与文件编码 | 保持文件为 UTF-8；读写前确认编码，检查终端输出是否乱码，必要时设置 UTF-8 控制台编码。 |  |
| TypeScript/React 与 Rust/Tauri | 遵循现有代码风格，遵循对应语言的 Google Style Guide；分别用 `npm run build`、`cargo fmt --check` 验证相关改动。 |  |
| UI 与交互 | 复用现有组件、设计令牌和交互模式。 |  |
| 代码注释 | 使用中文，仅在确有助于理解时添加。 |  |
