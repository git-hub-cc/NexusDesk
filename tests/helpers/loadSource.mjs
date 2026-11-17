import { readFileSync } from "node:fs";
import ts from "typescript";

export function moduleUrl(path, dependencies = {}) {
  const source = readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from (["'])([^"']+)\1/g, (match, quote, name) =>
    dependencies[name] ? `from ${JSON.stringify(dependencies[name])}` : match);
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

export const pathsUrl = moduleUrl("utils/paths.ts");
export const paths = await import(pathsUrl);
export const pathDeclarations = readFileSync(new URL("../../src/utils/paths.ts", import.meta.url), "utf8").replace(/export /g, "");
export const assetsUrl = moduleUrl("utils/assets.ts", {
  "@tauri-apps/api/core": "data:text/javascript,export const convertFileSrc = path => path;",
});
