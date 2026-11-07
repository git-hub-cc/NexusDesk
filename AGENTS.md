# Windows PowerShell compatibility

Windows PowerShell 5.1 does not support the Bash command operators `&&` or `||`.
Run commands separately or use `;` to separate them. Do not append `|| $true` to
commands whose non-zero exit code is expected; PowerShell continues to the next
statement by default, so write `rg ...; git diff --check` instead.

When a command contains complex quoting, pass arguments as an array or write a
temporary `.ps1` script rather than embedding nested quotes in a single shell
line.

Avoid using the `nl` command in PowerShell; use `Select-String` instead.

Never use `\"` to escape a double quote in PowerShell; backslash is not a quote escape character. Put regex patterns containing double quotes in a single-quoted PowerShell string. For example:

```powershell
Select-String -Path src-tauri/src/commands/chat.rs -Pattern 'stream_delta|stream": true|bytes_stream|chat-stream'
```

The form `-Pattern "stream_delta|stream\": true|..."` is invalid in Windows PowerShell 5.1 because the inner double quote terminates the string.

In PowerShell, backslash (`\`) does not escape quote characters. For regular expressions containing both single and double quotes, use a single-quoted PowerShell string and double embedded single quotes. For example:

```powershell
rg -n 'from [''"]xlsx|require\([''"]xlsx|xlsx\.' src package.json
```

When command output contains garbled Chinese characters, check that the console code page and PowerShell input/output encodings are compatible. For UTF-8 output, use `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` and `chcp 65001` as needed.

# UI consistency

- When similar components or interactions exist, reuse the existing component and follow its interaction behavior, visual hierarchy, spacing, typography, colors, states, and accessibility patterns. Avoid introducing a second pattern for the same kind of task.
- Keep the interface visually consistent across pages and features. Prefer shared components, design tokens, and existing styles; when a genuinely new pattern is needed, make it fit the established design system.

# Code style

- Follow the official Google Style Guide for the language being edited (for example, the Google TypeScript Style Guide for TypeScript). Keep changes consistent with the repository's existing formatter, lint rules, and conventions where the guide leaves room for choice.
- Write code comments in Chinese.
