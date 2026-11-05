if (location.origin !== site || window.top !== window) return;
window.__noteidePasswordCleanup?.();
const cleanups = [];
const visible = el => !el.disabled && !el.readOnly && el.getClientRects().length > 0;
const set = (el, value) => {
  if (!el || !visible(el)) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const installed = new WeakSet();
const accountKey = '__noteidePasswordAccount';
let selectedUsername;
try { selectedUsername = sessionStorage.getItem(accountKey); } catch {}
const remember = entry => {
  selectedUsername = entry.username;
  try { sessionStorage.setItem(accountKey, entry.username); } catch {}
};
const choose = (anchor, fill) => {
  if (installed.has(anchor)) return;
  installed.add(anchor);
  const select = document.createElement('select');
  select.setAttribute('aria-label', '选择已保存的登录账号');
  select.style.cssText = 'display:block;max-width:100%;margin:6px 0;padding:6px;color:#222;background:#fff;border:1px solid #aaa;border-radius:4px;';
  select.add(new Option('NoteIDE：选择账号以自动填充', ''));
  entries.forEach((entry, i) => select.add(new Option(entry.username || '（无用户名）', String(i))));
  select.addEventListener('change', () => { if (select.value !== '') fill(entries[Number(select.value)]); });
  anchor.insertAdjacentElement('afterend', select);
  cleanups.push(() => select.remove());
};
let successTimer;
let pendingCapture = false;
const send = (action, entry) => {
  if (location.origin !== site) return;
  location.href = `noteide-password://${action}/${entry ? `?data=${encodeURIComponent(JSON.stringify(entry))}` : ''}`;
};
const capture = event => {
  if (!event.isTrusted || (event.type === 'change' && event.target.type !== 'password')) return;
  const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
  if (!password?.value || password.autocomplete === 'new-password') return;
  const scope = password.form || document;
  if (scope.querySelector('input[autocomplete="new-password"]')) return;
  const username = [...scope.querySelectorAll('input')].find(el => visible(el) && (el.autocomplete === 'username' || el.type === 'email'));
  const entry = entries.find(entry => entry.username === (username?.value || selectedUsername)) || (entries.length === 1 ? entries[0] : null);
  if (!entry) return;
  pendingCapture = true;
  send('capture', { name: '', note: '', username: username?.value || entry.username, password: password.value, url: `${location.origin}${location.pathname}` });
};
document.addEventListener('submit', capture, true);
document.addEventListener('change', capture, true);
cleanups.push(() => { clearTimeout(successTimer); document.removeEventListener('submit', capture, true); document.removeEventListener('change', capture, true); });
const scan = () => {
  if (location.origin !== site) return;
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(el => visible(el) && !['new-password', 'one-time-code'].includes(el.autocomplete));
  const identifiers = [...document.querySelectorAll('input')].filter(el => visible(el) && (el.autocomplete === 'username' || el.type === 'email' || el.id === 'identifierId'));
  if (!passwords.length) {
    for (const username of identifiers) {
      const fill = entry => { remember(entry); set(username, entry.username); };
      if (entries.length === 1) {
        if (!installed.has(username) && !username.value) { installed.add(username); fill(entries[0]); }
      } else { choose(username, fill); }
    }
  }
  clearTimeout(successTimer);
  if (pendingCapture && ![...document.querySelectorAll('input[type="password"], input[autocomplete="one-time-code"]')].some(visible) && !identifiers.length && !document.querySelector('[role="alert"], [aria-invalid="true"]')) {
    successTimer = setTimeout(() => {
      if (location.origin !== site || !pendingCapture) return;
      pendingCapture = false;
      send('commit');
    }, 2000);
  }
  for (const password of passwords) {
    const scope = password.form || document;
    if (scope.querySelector('input[autocomplete="new-password"]') || [...scope.querySelectorAll('input[type="password"]')].filter(visible).length !== 1) continue;
    const inputs = [...scope.querySelectorAll('input')].filter(el => visible(el) && ['text', 'email', 'tel'].includes(el.type) && el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    const username = inputs.find(el => el.autocomplete === 'username') || inputs.at(-1);
    const fill = entry => { if (location.origin !== site) return; remember(entry); set(username, entry.username); set(password, entry.password); };
    const account = entries.find(entry => entry.username === (username?.value || document.querySelector('[data-identifier]')?.getAttribute('data-identifier') || selectedUsername));
    if (entries.length === 1 || account) {
      const entry = account || entries[0];
      if (!installed.has(password) && !password.value && (!username?.value || username.value === entry.username)) {
        installed.add(password);
        fill(entry);
      }
      continue;
    }
    choose(password, fill);
  }
};
let timer;
let lastScan = 0;
const loginSelector = 'input[type="password"], input[autocomplete="username"], input[type="email"], input#identifierId';
const observed = new WeakSet();
const scheduleScan = () => {
  if (timer !== undefined) return;
  timer = setTimeout(() => { timer = undefined; lastScan = Date.now(); scan(); observeLogin(); }, 500);
};
const observer = new MutationObserver(() => scheduleScan());
const observeLogin = () => {
  for (const input of document.querySelectorAll(loginSelector)) {
    // Observe only the login container, never a complex page's entire DOM.
    const scope = input.form || input.parentElement;
    if (!scope || scope === document.body || scope === document.documentElement || observed.has(scope)) continue;
    observed.add(scope);
    observer.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'autocomplete', 'hidden'] });
    // Detect removal of the whole form after a captured login.
    if (scope.parentElement && !observed.has(scope.parentElement)) {
      observed.add(scope.parentElement);
      observer.observe(scope.parentElement, { childList: true });
    }
  }
};
const onFocus = event => {
  if (event?.target && !(event.target instanceof HTMLInputElement)) return;
  if (Date.now() - lastScan > 250) { lastScan = Date.now(); scan(); observeLogin(); }
};
// Lazy discovery also handles SPA login dialogs inserted into a page that had
// no account fields when it first loaded, without inspecting added subtrees.
document.addEventListener('focusin', onFocus);
const onInteraction = () => scheduleScan();
document.addEventListener('click', onInteraction, true);
window.__noteidePasswordCleanup = () => {
  observer.disconnect(); clearTimeout(timer);
  document.removeEventListener('focusin', onFocus);
  document.removeEventListener('click', onInteraction, true);
  cleanups.forEach(fn => fn());
};
scan();
observeLogin();
