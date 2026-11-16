import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function setup(isSnapshot = false) {
  const values = new Map();
  const events = new EventTarget();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  let slots = [];
  let cursor = 0;
  let notifications = 0;
  const cleanups = [];
  function memo(create, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      slots[index] = { dependencies, value: create() };
    }
    return slots[index].value;
  }
  function load(path, modules) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    new Function("require", "exports", "window", "setTimeout", "clearTimeout", compiled)(name => {
      assert.ok(name in modules, `Unexpected module: ${name}`);
      return modules[name];
    }, exports, events, () => 1, () => {});
    return exports;
  }
  const ui = load("../src/lib/uiPersistence.ts", {
    "./globalSettings": { settingsStorage: storage },
    "./paths": { pathKey: path => path.toLowerCase().replaceAll("\\", "/") },
    "./snapshot": { isSnapshot },
  });
  const hooks = load("../src/hooks/usePersistentState.ts", {
    react: {
      useCallback: (callback, dependencies) => memo(() => callback, dependencies),
      useMemo: memo,
      useSyncExternalStore(subscribe, read) {
        memo(() => { cleanups.push(subscribe(() => notifications++)); }, []);
        return read();
      },
    },
    "@/lib/globalSettings": { settingsStorage: storage },
    "@/lib/uiPersistence": ui,
  });
  return {
    hooks, storage, ui,
    get notifications() { return notifications; },
    render(callback) { cursor = 0; return callback(hooks); },
    remount() { cleanups.splice(0).forEach(cleanup => cleanup()); slots = []; },
  };
}

test("个人偏好保存后重新挂载可恢复，函数更新读取最新值，异常值回退", () => {
  const app = setup();
  const normalize = value => app.hooks.storedNumber(value, 0.75, 0, 1);
  const render = () => app.render(hooks => hooks.useGlobalPreference("nexusdesk.music.volume", normalize));
  assert.equal(render()[0], 0.75);
  const update = render()[1];
  update(0.2);
  update(value => value + 0.1);
  assert.ok(app.notifications >= 2);
  app.remount();
  assert.ok(Math.abs(render()[0] - 0.3) < 0.00001);
  app.storage.setItem("nexusdesk.music.volume", "invalid JSON");
  assert.equal(render()[0], 0.75);
  update(10);
  assert.equal(render()[0], 1);
  app.storage.setItem("nexusdesk.music.volume", '"wrong type"');
  assert.equal(render()[0], 0.75);
});

test("项目和文件状态隔离，待写入状态立即可读，刷新存储后可恢复", () => {
  const app = setup();
  const normalize = value => app.hooks.storedNumber(value, 1, 1, 10);
  const render = (root, file) => app.render(hooks => hooks.useProjectUIState(root, `pdf.page:${file}`, normalize));
  render("project-a", "a.pdf")[1](7);
  assert.equal(render("project-a", "a.pdf")[0], 7);
  assert.equal(render("project-b", "a.pdf")[0], 1);
  assert.equal(render("project-a", "b.pdf")[0], 1);
  app.ui.flushUIState();
  app.remount();
  assert.equal(render("PROJECT-A", "a.pdf")[0], 7);
});

test("对象偏好在相同存储内容下保持引用稳定，新增全局键已注册", () => {
  const app = setup();
  const normalize = value => ({ regex: value?.regex === true });
  const render = () => app.render(hooks => hooks.useGlobalPreference("nexusdesk.search.options", normalize));
  const initial = render()[0];
  assert.equal(render()[0], initial);
  render()[1]({ regex: true });
  assert.equal(render()[0].regex, true);
  const { keys } = JSON.parse(readFileSync(new URL("../src/lib/globalSettingKeys.json", import.meta.url), "utf8"));
  for (const key of ["music.volume", "music.playbackMode", "search.options", "image.tool", "image.color", "image.width", "android.maxSize"]) {
    assert.ok(keys.includes(`nexusdesk.${key}`));
  }
});

test("快照窗口的界面状态可交互和重新挂载恢复，但不会写入持久存储", () => {
  const app = setup(true);
  const normalize = value => value === "image" ? "image" : "text";
  const render = (root = "project", file = "a.svg") => app.render(hooks => hooks.useProjectUIState(root, `svg.mode:${file}`, normalize));
  assert.equal(render()[0], "text");
  const update = render()[1];
  update("image");
  assert.equal(render()[0], "image");
  update(value => value === "image" ? "text" : "image");
  assert.equal(render()[0], "text");
  update("image");
  assert.equal(render("other")[0], "text");
  assert.equal(render("project", "b.svg")[0], "text");
  app.ui.flushUIState();
  app.remount();
  assert.equal(render()[0], "image");
  assert.deepEqual(app.storage.getItem("nexusdesk-ui:project:svg.mode:a.svg"), null);
});
