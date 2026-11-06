# Windows PowerShell compatibility

Windows PowerShell 5.1 does not support `&&` as a command separator. Run commands separately or use `;` to separate them.

Avoid using the `nl` command in PowerShell; use `Select-String` instead.

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
