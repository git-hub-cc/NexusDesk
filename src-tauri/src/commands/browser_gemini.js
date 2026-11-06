(() => {
  if (window.top !== window || location.hostname !== 'gemini.google.com') return;
  const prompt = new URLSearchParams(location.search).get('prompt');
  if (!prompt?.trim()) return;

  // Gemini renders its editor asynchronously. Stop after filling it once.
  let observer, timeout;
  const stop = () => {
    observer?.disconnect();
    clearTimeout(timeout);
  };
  const fill = () => {
    const editor = document.querySelector('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"]');
    if (!editor || !editor.getClientRects().length || editor.getAttribute('aria-disabled') === 'true') return;
    // Preserve text the user has already started typing.
    if (editor.textContent.trim()) { stop(); return; }
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    // Native editing updates the rich text editor's internal state too.
    if (!document.execCommand('insertText', false, prompt)) {
      editor.textContent = prompt;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    }
    stop();
  };
  const start = () => {
    observer = new MutationObserver(fill);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable', 'aria-disabled', 'class'] });
    timeout = setTimeout(stop, 60000);
    fill();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
