import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const source = fs.readFileSync(new URL('../src/lib/markdownPreview.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/from "([^"]+)"/g, (_match, name) => `from "${import.meta.resolve(name)}"`);
const { markdownRehypePlugins, markdownUrlTransform } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const render = content => renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm], rehypePlugins: markdownRehypePlugins, urlTransform: markdownUrlTransform,
    components: { img: ({ node: _node, src, ...props }) => React.createElement('img', { ...props, src: src || undefined }) },
}, content));

test('preview renders HTML tables, named anchors and embedded PNG images safely', () => {
    const html = render('[引言 1](#__RefHeading___Toc36820085)\n\n<a id="__RefHeading___Toc36820085"></a>\n\n<table><tbody><tr><td><p>正文</p></td></tr></tbody></table>\n\n![](data:image/png;base64,aGVsbG8=)');
    assert.match(html, /<table><tbody><tr><td><p>正文<\/p><\/td><\/tr><\/tbody><\/table>/);
    assert.match(html, /id="user-content-__RefHeading___Toc36820085"/);
    assert.match(html, /href="#__RefHeading___Toc36820085"/);
    assert.match(html, /src="data:image\/png;base64,aGVsbG8="/);
    assert.match(render('<a name="bookmark"></a>'), /name="user-content-bookmark"/);
});

test('preview removes scripts, event handlers and unsafe URLs', () => {
    const html = render('<script>alert(1)</script><img src="data:text/html;base64,xxx" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>\n\n![](data:image/svg+xml;base64,xxx)');
    assert.doesNotMatch(html, /<script|onerror|javascript:|data:text|data:image\/svg/);
    assert.equal(markdownUrlTransform('data:image/png;base64,xxx', 'href', { tagName: 'a' }), '');
    assert.match(render('![](.asset/image%20(1).png)'), /src=".asset\/image%20\(1\).png"/);
});

test('asset resolution preserves Base64 and decodes exported local image filenames', () => {
    const source = fs.readFileSync(new URL('../src/lib/assets.ts', import.meta.url), 'utf8');
    const js = ts.transpileModule(source.replace(/^import .*;\r?\n/m, '').replace(/export /g, ''), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const { resolveAsset, imageUrl } = new Function('convertFileSrc', js + '\nreturn { resolveAsset, imageUrl };')(() => { throw new Error('unexpected local conversion'); });
    const base64 = 'data:image/png;base64,aGVsbG8=';
    assert.equal(resolveAsset('C:/docs/note.md', base64), base64);
    assert.equal(imageUrl(base64), base64);
    assert.equal(resolveAsset('C:/docs/note.md', '.asset/image%20(1).png'), 'C:/docs/.asset/image (1).png');
});
