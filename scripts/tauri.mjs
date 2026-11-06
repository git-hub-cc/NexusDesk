import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const env = { ...process.env };
const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: "inherit", windowsHide: true });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
