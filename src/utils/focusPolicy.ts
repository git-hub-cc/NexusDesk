const TEXT_INPUT_TYPES = new Set([
  "text", "search", "email", "url", "tel", "password", "number",
  "date", "datetime-local", "month", "week", "time",
]);

const FILE_TREE_TAB_STOP = '.explorer-tree [role="tree"][tabindex="0"]';
const FILE_TREE_FOCUS_TARGET = '.explorer-tree[tabindex], .explorer-tree div[tabindex]';
const NATIVE_SELECT_TAB_STOP = 'select[data-allow-native-focus]';

function acceptsKeyboardInput(element: Element): boolean {
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type);
  if (element instanceof HTMLTextAreaElement) return true;
  return (element instanceof HTMLElement && element.isContentEditable)
    || element.matches(NATIVE_SELECT_TAB_STOP)
    || element.matches('[data-android-mirror-input="true"]');
}

function allowsFocus(element: Element): boolean {
  return acceptsKeyboardInput(element) || element.matches(FILE_TREE_FOCUS_TARGET);
}

export function installFocusPolicy(): void {
  // 阻止鼠标默认聚焦，保留按钮点击、拖动及当前输入框的选区。
  document.addEventListener("mousedown", event => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest(
      'input, textarea, select, button, a[href], area[href], summary, iframe, [tabindex], [contenteditable]',
    );
    if (target && !allowsFocus(target)) event.preventDefault();
  }, true);

  // 同时覆盖自动聚焦、脚本聚焦和浏览器隐式聚焦的滚动容器。
  document.addEventListener("focus", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || allowsFocus(target)) return;
    event.stopImmediatePropagation();
    target.blur();
  }, true);

  window.addEventListener("keydown", event => {
    if (event.key !== "Tab" || (event.target instanceof Element
      && event.target.closest('.cm-editor, .xterm, [data-android-mirror-input="true"]'))) return;
    const tabStops = [...document.querySelectorAll<HTMLElement>(`input, textarea, [contenteditable], ${NATIVE_SELECT_TAB_STOP}, ${FILE_TREE_TAB_STOP}`)]
      .filter(element => (acceptsKeyboardInput(element) || element.matches(FILE_TREE_TAB_STOP))
        && !element.matches(":disabled") && element.getClientRects().length > 0
        && !element.closest('[aria-hidden="true"], [inert]'));
    event.preventDefault();
    if (!tabStops.length) return;
    const active = document.activeElement as HTMLElement | null;
    // 文件树的行可以获得焦点，但 Tab 将整棵树视为一个停靠点。
    const current = active && (acceptsKeyboardInput(active) ? active : active.closest<HTMLElement>(FILE_TREE_TAB_STOP));
    const index = current ? tabStops.indexOf(current) : -1;
    const nextIndex = index < 0
      ? (event.shiftKey ? tabStops.length - 1 : 0)
      : (index + (event.shiftKey ? -1 : 1) + tabStops.length) % tabStops.length;
    tabStops[nextIndex].focus();
  }, true);
}
