import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
const noSttModel = process.argv.includes("--no-stt-model");
const revision = "2365baeacb507f821a0c8120fcee3d484dba7a07";
const modelDirectory = join(root, "src-tauri", "resources", "stt-model");
const outputDirectory = join(root, "release");
const files = [
  { name: "model.int8.onnx", size: 239_233_841 },
  { name: "tokens.txt", size: 315_894 },
];

async function ensureModel() {
  mkdirSync(modelDirectory, { recursive: true });
  for (const file of files) {
    const destination = join(modelDirectory, file.name);
    if (existsSync(destination) && statSync(destination).size === file.size) continue;
    const url = `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/${revision}/${file.name}`;
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    } catch (error) {
      throw new Error(`无法连接 Hugging Face 下载 ${file.name}：${error.message}`);
    }
    if (!response.ok || !response.body) throw new Error(`下载 ${file.name} 失败：HTTP ${response.status}`);
    const temporary = `${destination}.partial`;
    try {
      await pipeline(response.body, createWriteStream(temporary));
      if (statSync(temporary).size !== file.size) throw new Error(`${file.name} 文件大小不符，下载未完成`);
      renameSync(temporary, destination);
    } catch (error) {
      if (existsSync(temporary)) require("node:fs").unlinkSync(temporary);
      throw error;
    }
  }
}

function runTauri(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tauriCli, ...args], { cwd: root, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`tauri ${args.join(" ")} 退出，代码 ${code}`)));
  });
}

function copyInstaller(label) {
  const bundleDirectory = join(root, "src-tauri", "target", "release", "bundle", "nsis");
  const installer = readdirSync(bundleDirectory)
    .filter(name => name.endsWith("-setup.exe"))
    .sort((left, right) => statSync(join(bundleDirectory, right)).mtimeMs - statSync(join(bundleDirectory, left)).mtimeMs)[0];
  if (!installer) throw new Error("没有找到 Tauri NSIS 安装包");
  mkdirSync(outputDirectory, { recursive: true });
  const destination = join(outputDirectory, `NexusDesk-${label}.exe`);
  const source = join(bundleDirectory, installer);
  copyFileSync(source, destination);
  console.log(`已生成 ${destination}`);
}

try {
  await runTauri(["build"]);
  copyInstaller("不含STT内置模型");
  if (!noSttModel) {
    await ensureModel();
    await runTauri(["build", "--config", "src-tauri/tauri.model.conf.json"]);
    copyInstaller("内置语音模型");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
