import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function popup() {
  const html = fs.readFileSync(new URL('../src/native-menu.html', import.meta.url), 'utf8');
  const handlers = {};
  const navigations = [];
  const location = { get href() { return navigations.at(-1) || ''; }, set href(value) { navigations.push(value); } };
  const window = {};
  const stats = { inserted: 0, replaced: 0, focused: 0, observing: false };
  let resize;
  let current;
  let height = 120;
  const timers = new Map();
  let timerId = 0;
  const document = {
    body: { prepend(content) { current = content; stats.inserted++; } },
    createElement() {
      const menu = { querySelector: () => null, scrollTop: 0, getBoundingClientRect: () => ({ height }) };
      return {
        style: {}, menu,
        querySelector: selector => selector === '.native-menu' ? menu : { focus() { stats.focused++; } },
        replaceWith(content) { current = content; stats.replaced++; },
      };
    },
    addEventListener(name, callback) { handlers[name] = callback; },
    querySelector(selector) { return selector === '#menu-content' ? current : selector === '.native-menu' ? current?.menu : null; },
    querySelectorAll() { return []; },
  };
  class ResizeObserver {
    constructor(callback) { resize = callback; }
    observe() { stats.observing = true; }
    disconnect() { stats.observing = false; }
  }
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, location, window, ResizeObserver, URLSearchParams,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { handlers, location, navigations, window, stats, tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); }, setHeight(value) { height = value; }, resize() { resize(); }, get menu() { return current.menu; } };
}
test('native popup routes actions and color values without exposing callbacks to the popup', () => {
  const { handlers, location } = popup();
  handlers.click({ target: { closest: selector => selector.includes('submenu') ? null : { dataset: { action: '12' }, disabled: false } } });
  assert.equal(location.href, 'nexusdesk-menu://action/12?request=null');
  handlers.change({ target: { matches: () => true, dataset: { action: '14' }, value: '#60a5fa' } });
  assert.equal(location.href, 'nexusdesk-menu://action/14?value=%2360a5fa&request=null');
});
test('disabled items do not dispatch and Escape dismisses the popup', () => {
  const { handlers, location } = popup();
  handlers.click({ target: { closest: selector => selector.includes('submenu') ? null : { dataset: { action: '0' }, disabled: true } } });
  assert.equal(location.href, '');
  handlers.keydown({ key: 'Escape' });
  assert.equal(location.href, 'nexusdesk-menu://action/close?request=null');
});
test('submenus expand inside the native popup without dispatching an action', () => {
  const { handlers, location } = popup();
  let toggled;
  handlers.click({ target: { closest: () => ({ parentElement: { classList: { toggle: value => { toggled = value; } } } }) } });
  assert.equal(toggled, 'open');
  assert.equal(location.href, '');
});


test('passive suggestions update in place without showing or resizing the window again', () => {
  const view = popup();
  view.window.__setMenu('first', 'suggestions', true);
  assert.deepEqual(view.navigations, ['nexusdesk-menu://ready/120?request=suggestions']);
  assert.equal(view.stats.focused, 0);
  view.menu.scrollTop = 35;

  view.window.__setMenu('first', 'suggestions', true);
  assert.equal(view.stats.replaced, 0);
  view.window.__setMenu('changed selection', 'suggestions', true);
  assert.equal(view.stats.replaced, 1);
  assert.equal(view.stats.inserted, 1);
  assert.equal(view.menu.scrollTop, 35);
  assert.equal(view.navigations.length, 1);

  view.setHeight(80);
  view.window.__setMenu('filtered results', 'suggestions', true);
  assert.equal(view.navigations.length, 1);
  assert.equal(view.stats.observing, false);
  assert.equal(view.stats.focused, 0);
});

test('a new menu session still shows the popup and focuses ordinary menu items', () => {
  const view = popup();
  view.window.__setMenu('suggestions', 'first', true);
  view.window.__setMenu('ordinary menu', 'second');
  assert.equal(view.location.href, 'nexusdesk-menu://ready/120?request=second');
  assert.equal(view.stats.focused, 1);
});


test('suggestion viewport changes never start a native resize feedback loop', () => {
  const view = popup();
  view.window.__setMenu('suggestions', 'passive-session', true);
  // Simulate delayed ResizeObserver deliveries and rounding at 125% / 150% DPI.
  for (const height of [119.2, 120, 119.2, 120, 179.5, 180, 179.5, 180]) {
    view.setHeight(height);
    view.resize();
  }
  assert.deepEqual(view.navigations, ['nexusdesk-menu://ready/120?request=passive-session']);
  assert.equal(view.stats.observing, false);
  assert.equal(view.stats.focused, 0);
});

test('ordinary menus still observe content size and can expand submenus', () => {
  const view = popup();
  view.window.__setMenu('menu', 'ordinary-session');
  assert.equal(view.stats.observing, true);
  view.setHeight(210);
  view.resize();
  view.tick();
  assert.equal(view.location.href, 'nexusdesk-menu://resize/210?request=ordinary-session');
  view.resize();
  assert.equal(view.navigations.length, 2);
});

test('resize bursts send only the latest height and cancel across sessions', () => {
  const view = popup();
  view.window.__setMenu('menu', 'first');
  for (const height of [140, 180, 210]) { view.setHeight(height); view.resize(); }
  assert.equal(view.navigations.length, 1);
  view.tick();
  assert.equal(view.location.href, 'nexusdesk-menu://resize/210?request=first');
  view.setHeight(250);
  view.window.__setMenu('updated menu', 'first');
  view.setHeight(270);
  view.resize();
  view.tick();
  assert.equal(view.location.href, 'nexusdesk-menu://resize/270?request=first');
  view.setHeight(300);
  view.resize();
  view.window.__setMenu('suggestions', 'second', true);
  const count = view.navigations.length;
  view.tick();
  assert.equal(view.navigations.length, count);
});

test('suggestion presses dispatch the complete URL before blur and do not dispatch twice', () => {
  const view = popup();
  view.window.__setMenu('suggestions', 'address', true);
  const url = 'https://example.com/path?q=%E4%B8%AD%E6%96%87&next=/page#section';
  const target = { closest: selector => selector.startsWith('button') ? null : ({ dataset: { action: url }, disabled: false }) };
  let prevented = false;
  view.handlers.pointerdown({ target, button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const action = new URL(view.location.href);
  assert.equal(decodeURIComponent(action.pathname.slice(1)), url);
  assert.equal(action.searchParams.get('request'), 'address');
  const count = view.navigations.length;
  view.handlers.click({ target, detail: 1 });
  assert.equal(view.navigations.length, count);
  view.handlers.mousedown({ preventDefault() { prevented = true; } });
});

test('right clicks on suggestions do not navigate', () => {
  const view = popup();
  view.window.__setMenu('suggestions', 'address', true);
  view.handlers.pointerdown({ button: 2 });
  assert.equal(view.navigations.length, 1);
});

test('consecutive delete presses route the URL value without opening the row or double dispatching', () => {
  const view = popup();
  view.window.__setMenu('suggestions', 'address', true);
  for (const url of ['https://example.com/a', 'https://example.com/b']) {
    const button = { dataset: { action: 'browser-history-remove', value: url } };
    const target = { closest: () => button };
    view.handlers.pointerdown({ target, button: 0, preventDefault() {}, stopPropagation() {} });
    const action = new URL(view.location.href);
    assert.equal(action.pathname, '/browser-history-remove');
    assert.equal(action.searchParams.get('value'), url);
    const count = view.navigations.length;
    view.handlers.click({ target, detail: 1 });
    assert.equal(view.navigations.length, count);
  }
});

test('keyed suggestion updates retain rows and scroll offset and animate gap closure', () => {
  const html = fs.readFileSync(new URL('../src/native-menu.html', import.meta.url), 'utf8');
  const code = html.slice(html.indexOf('const updateSuggestions='), html.indexOf('window.__setMenu='));
  const animations = [];
  let list;
  const row = key => ({ dataset: { action: key }, className: '', id: key,
    getBoundingClientRect() { return { top: list.children.indexOf(this) * 40 }; },
    querySelector() { return null; }, setAttribute() {}, getAttribute() { return 'false'; },
    getAnimations() { return []; }, animate(frames) { animations.push({ key, frames }); } });
  const a = row('a'), b = row('b'), c = row('c');
  list = { children: [a, b, c], replaceChildren(...rows) { this.children = rows; } };
  const menu = { scrollTop: 45, children: [list], querySelector() { return list; } };
  const nextList = { children: [row('b'), row('c'), row('d')] };
  const nextMenu = { children: [nextList] };
  const previous = { querySelector() { return menu; } };
  const content = { querySelector(selector) { return selector === '[role=listbox]' ? nextList : nextMenu; } };
  const context = { previous, content, matchMedia: () => ({ matches: false }) };
  vm.runInNewContext(code + ';updateSuggestions(previous,content)', context);
  assert.equal(menu.scrollTop, 45);
  assert.equal(list.children[0], b);
  assert.equal(list.children[1], c);
  assert.deepEqual(animations.map(item => item.key), ['b', 'c']);
  assert.equal(animations[0].frames[0].transform, 'translateY(40px)');
});
