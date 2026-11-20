const TEXT_INPUT_TYPES = new Set([
  "text", "search", "email", "url", "tel", "password", "number",
  "date", "datetime-local", "month", "week", "time",
]);

function acceptsKeyboardInput(element: Element): boolean {
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type);
  if (element instanceof HTMLTextAreaElement) return true;
  return (element instanceof HTMLElement && element.isContentEditable)
    || element.matches('[data-android-mirror-input="true"]');
}

export function installFocusPolicy(): void {
  // 阻止鼠标默认聚焦，保留按钮点击、拖动及当前输入框的选区。
  document.addEventListener("mousedown", event => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest(
      'input, textarea, select, button, a[href], area[href], summary, iframe, [tabindex], [contenteditable]',
    );
    if (target && !acceptsKeyboardInput(target)) event.preventDefault();
  }, true);

  // 同时覆盖自动聚焦、脚本聚焦和浏览器隐式聚焦的滚动容器。
  document.addEventListener("focus", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || acceptsKeyboardInput(target)) return;
    event.stopImmediatePropagation();
    target.blur();
  }, true);

  window.addEventListener("keydown", event => {
    if (event.key !== "Tab" || (event.target instanceof Element
      && event.target.closest('.cm-editor, .xterm, [data-android-mirror-input="true"]'))) return;
    const fields = [...document.querySelectorAll<HTMLElement>("input, textarea, [contenteditable]")]
      .filter(field => acceptsKeyboardInput(field) && !field.matches(":disabled")
        && field.getClientRects().length > 0 && !field.closest('[aria-hidden="true"], [inert]'));
    event.preventDefault();
    if (!fields.length) return;
    const index = fields.indexOf(document.activeElement as HTMLElement);
    const nextIndex = index < 0
      ? (event.shiftKey ? fields.length - 1 : 0)
      : (index + (event.shiftKey ? -1 : 1) + fields.length) % fields.length;
    fields[nextIndex].focus();
  }, true);
}
