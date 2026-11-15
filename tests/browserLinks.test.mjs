import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src-tauri/src/commands/browser_links.js', import.meta.url), 'utf8');
function click({ hostname = 'www.google.com', pathname = '/search', result = true, heading = true, href = 'https://example.com/article', modified = false, meta = false, shift = false, alt = false, defaultPrevented = false, nested = false, middle = false, download = false, target = null, baseTarget = null } = {}) {
  let handler;
  const opened = [];
  const navigated = [];
  class Element {
    closest(selector) { return selector === 'a[href]' ? this : result ? {} : null; }
    querySelector() { return heading ? {} : null; }
    hasAttribute() { return download; }
    getAttribute() { return target; }
    href = href;
  }
  const window = { open: (...args) => opened.push(args) }; window.top = window;
  const location = { hostname, pathname, href: `https://${hostname}${pathname}?q=test`, assign: url => navigated.push(url) };
  vm.runInNewContext(source, { window, document: { addEventListener: (_, fn) => { handler = fn; }, querySelector: () => baseTarget === null ? null : { getAttribute: () => baseTarget } }, location, Element, URL });
  let prevented = false;
  const anchor = new Element();
  const element = nested ? Object.assign(new Element(), { closest: () => anchor }) : anchor;
  handler?.({ button: middle ? 1 : 0, ctrlKey: modified, metaKey: meta, shiftKey: shift, altKey: alt, defaultPrevented, target: element, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  return { opened, navigated, prevented };
}
test('Google result title navigates the current tab and updates its address', () => {
  assert.deepEqual(click().navigated, ['https://example.com/article']);
  assert.deepEqual(click({ modified: true }).navigated, ['nexusdesk-tab://open?url=https%3A%2F%2Fexample.com%2Farticle']);
  assert.equal(click().prevented, true);
  assert.equal(click({ hostname: 'www.google.co.uk' }).navigated.length, 1);
});
test('Google result links preserve explicit and inherited browsing targets', () => {
  for (const options of [{ target: '_blank' }, { baseTarget: '_blank' }, { target: 'articles' }]) {
    const result = click(options);
    assert.deepEqual(result.opened, [['https://example.com/article', options.target ?? options.baseTarget, 'noopener']]);
    assert.deepEqual(result.navigated, []);
    assert.equal(result.prevented, true);
  }
  for (const target of ['', '_self', '_SELF', '_top', '_parent']) {
    const result = click({ target, baseTarget: '_blank' });
    assert.deepEqual(result.opened, []);
    assert.deepEqual(result.navigated, ['https://example.com/article']);
  }
  assert.deepEqual(click({ target: '_self', modified: true }).navigated, ['nexusdesk-tab://open?url=https%3A%2F%2Fexample.com%2Farticle']);
});
test('search controls, other sites, middle clicks and downloads retain native behavior', () => {
  for (const options of [{ result: false }, { heading: false }, { pathname: '/' }, { hostname: 'accounts.google.com' }, { hostname: 'www.google.com.evil.test' }, { middle: true }, { download: true }, { href: 'javascript:void(0)' }]) {
    assert.deepEqual(click(options).opened, []);
    assert.equal(click(options).prevented, false);
  }
});

test('Ctrl and Cmd clicks on ordinary and nested links request background tabs', () => {
  const href = 'https://example.com/article?q=a%26b#section';
  for (const modifier of [{ modified: true }, { meta: true }]) {
    for (const target of [null, '_self', '_blank', 'articles']) {
      const result = click({ hostname: 'example.com', result: false, nested: true, target, href, ...modifier });
      assert.deepEqual(result.opened, []);
      assert.deepEqual(result.navigated, [`nexusdesk-tab://open?url=${encodeURIComponent(href)}`]);
      assert.equal(result.prevented, true);
    }
  }
});

test('modified clicks preserve downloads, unsupported protocols and other gestures', () => {
  for (const options of [{ download: true }, { href: 'javascript:void(0)' }, { href: 'mailto:test@example.com' }, { middle: true }, { shift: true }, { alt: true }, { defaultPrevented: true }]) {
    const result = click({ hostname: 'example.com', modified: true, ...options });
    assert.deepEqual(result.opened, []);
    assert.deepEqual(result.navigated, []);
    assert.equal(result.prevented, false);
  }
});

test('Baidu nested title links open a new tab without replacing the current page', () => {
  const href = 'https://www.baidu.com/s?wd=%E6%80%BB%E4%B9%A6%E8%AE%B0&sa=fyb_n_homepage&rsv_dl=fyb_n_homepage&from=super&cl=3&tn=baidutop10';
  for (const target of ['_blank', '_BLANK']) {
    const result = click({ hostname: 'www.baidu.com', pathname: '/', result: false, heading: false, target, href });
    assert.deepEqual(result.opened, [[href, '_blank', 'noopener']]);
    assert.deepEqual(result.navigated, []);
    assert.equal(result.prevented, true);
  }
  const inherited = click({ hostname: 'example.com', baseTarget: '_blank' });
  assert.equal(inherited.opened.length, 1);
  for (const options of [{ download: true }, { href: 'javascript:void(0)' }, { target: '_self' }]) {
    assert.equal(click({ hostname: 'www.baidu.com', target: '_blank', ...options }).prevented, false);
  }
});
