import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { read, utils, write } from 'xlsx';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import * as CFB from 'cfb';
import { deflateSync } from 'node:zlib';

globalThis.DOMParser = DOMParser;

const source = fs.readFileSync(new URL('../src/lib/documentConverter.ts', import.meta.url), 'utf8');
// Use Mammoth's browser entry to exercise the same ArrayBuffer API that Vite selects.
const compiled = ts.transpileModule(source.replace(/export /g, '').replace('import("mammoth")', 'import("mammoth/mammoth.browser.js")')
    .replace('import("@tauri-apps/api/core")', 'Promise.resolve({ invoke: invokeLegacy })'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
let invokeLegacy = async () => { throw new Error('未找到 LibreOffice'); };
const converter = new Function('invokeLegacy', compiled + '\nreturn { markdownTable, isConvertibleDocument, convertDocumentToMarkdown };')((...args) => invokeLegacy(...args));
const buffer = text => new TextEncoder().encode(text).buffer;

test('tables preserve zero, false, sparse columns and escape cell markup', () => {
    const markdown = converter.markdownTable([['A'], [0, false, 'x|y\n<tag>\\']]);
    assert.equal(markdown, '| A |  |  |\n| --- | --- | --- |\n| 0 | false | x&#124;y<br>&lt;tag&gt;&#92; |');
    assert.equal(converter.markdownTable([]), '');
});

test('UTF-8 CSV retains Chinese and quoted multiline values', async () => {
    const markdown = await converter.convertDocumentToMarkdown(buffer('名称,值\r\n中文,0\r\n"两\n行",2'), 'CSV');
    assert.match(markdown, /中文 \| 0/);
    assert.match(markdown, /两<br>行/);
});

test('workbooks extract every nonempty sheet and format cells', async () => {
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([['Name', 'Count'], ['A', 0]]), 'First');
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([['Other'], ['B', 'extra']]), 'Second');
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([]), 'Empty');
    for (const bookType of ['xlsx', 'biff8']) {
        const bytes = write(workbook, { type: 'array', bookType });
        assert.equal(read(bytes).SheetNames.length, 3);
        const markdown = await converter.convertDocumentToMarkdown(bytes, bookType === 'xlsx' ? 'xlsx' : 'xls');
        assert.match(markdown, /## First/);
        assert.match(markdown, /A \| 0/);
        assert.match(markdown, /## Second/);
        assert.doesNotMatch(markdown, /## Empty/);
    }
});

test('DOCX converts headings and text from a real ZIP document', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p><w:p><w:r><w:t>中文内容</w:t></w:r></w:p></w:body></w:document>');
    const markdown = await converter.convertDocumentToMarkdown(await zip.generateAsync({ type: 'arraybuffer' }), 'docx');
    assert.match(markdown, /# Title/);
    assert.match(markdown, /中文内容/);
    const legacyBytes = [0xd0, 0xcf, 0x11, 0xe0];
    invokeLegacy = async (command, args) => {
        assert.equal(command, 'convert_legacy_office');
        assert.deepEqual(args, { bytes: legacyBytes, extension: 'doc' });
        return Array.from(await zip.generateAsync({ type: 'uint8array' }));
    };
    assert.equal(await converter.convertDocumentToMarkdown(new Uint8Array(legacyBytes).buffer, 'DOC'), markdown);
});

test('legacy PPT dispatches converted bytes to PPTX extraction', async () => {
    invokeLegacy = async (command, args) => {
        assert.equal(command, 'convert_legacy_office');
        assert.deepEqual(args, { bytes: [1, 2, 3], extension: 'ppt' });
        return [1, 2, 3];
    };
    await assert.rejects(converter.convertDocumentToMarkdown(new Uint8Array([1, 2, 3]).buffer, 'PPT'), /corrupted zip/i);
});

async function presentationFixture() {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>');
    zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="slide" Target="slides/slide2.xml"/></Relationships>');
    zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
    return zip;
}

function nativeAttachment(name, payload) {
    const string = value => Buffer.from(value + '\0');
    const length = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
    const native = Buffer.concat([length(0), Buffer.from([2, 0]), string(name), string('C:\\source\\' + name), length(0), length(1), Buffer.from([0]), length(payload.length), payload]);
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, '\x01Ole10Native', native);
    return Buffer.from(CFB.write(cfb, { type: 'buffer' }));
}

test('PPTX preserves image-only slides and unwraps embedded files with encoded links', async () => {
    const zip = await presentationFixture();
    const image = Buffer.from([1, 2, 3]);
    const payload = Buffer.from('attachment contents');
    zip.file('ppt/media/image.png', image);
    zip.file('ppt/embeddings/ole.bin', nativeAttachment('notes (1).txt', payload));
    zip.file('ppt/slides/_rels/slide2.xml.rels', '<Relationships><Relationship Id="image" Type="rel/image" Target="../media/image.png"/><Relationship Id="attachment" Type="rel/oleObject" Target="../embeddings/ole.bin"/><Relationship Id="again" Type="rel/image" Target="../media/image.png"/></Relationships>');
    const saved = [];
    const bytes = await zip.generateAsync({ type: 'arraybuffer' });
    const markdown = await converter.convertDocumentToMarkdown(bytes, 'pptx', {
        saveImage: async (data, name) => { saved.push({ data: Buffer.from(data), name }); return '.asset/' + encodeURIComponent(name); },
    });
    assert.match(markdown, /!\[image.png\]\(.asset\/image.png\)/);
    assert.ok(markdown.includes('[notes (1).txt](.asset/notes%20%281%29.txt)'));
    assert.deepEqual(saved, [{ data: image, name: 'image.png' }, { data: payload, name: 'notes (1).txt' }]);
    await assert.rejects(converter.convertDocumentToMarkdown(bytes, 'pptx', {
        saveImage: async () => { throw new Error('asset write failed'); },
    }), /asset write failed/);
    zip.remove('ppt/embeddings/ole.bin');
    await assert.rejects(converter.convertDocumentToMarkdown(await zip.generateAsync({ type: 'arraybuffer' }), 'pptx'), /附件缺失/);
});

test('PPTX extracts native OLE bitmaps and preserves unknown native objects', async () => {
    // A 1x1 24-bit BMP stored directly after Ole10Native's size field.
    const bitmap = Buffer.alloc(58);
    bitmap.write('BM');
    bitmap.writeUInt32LE(bitmap.length, 2);
    bitmap.writeUInt32LE(54, 10);
    bitmap.writeUInt32LE(40, 14);
    bitmap.writeInt32LE(1, 18);
    bitmap.writeInt32LE(1, 22);
    bitmap.writeUInt16LE(1, 26);
    bitmap.writeUInt16LE(24, 28);
    const wrap = payload => {
        const length = Buffer.alloc(4);
        length.writeUInt32LE(payload.length);
        const cfb = CFB.utils.cfb_new();
        CFB.utils.cfb_add(cfb, '\x01Ole10Native', Buffer.concat([length, payload]));
        return Buffer.from(CFB.write(cfb, { type: 'buffer' }));
    };
    const unknown = wrap(Buffer.from('unknown native format'));
    const zip = await presentationFixture();
    zip.file('ppt/embeddings/bitmap.bin', wrap(bitmap));
    zip.file('ppt/embeddings/unknown.bin', unknown);
    zip.file('ppt/slides/_rels/slide2.xml.rels', '<Relationships><Relationship Id="bitmap" Type="rel/oleObject" Target="../embeddings/bitmap.bin"/><Relationship Id="unknown" Type="rel/oleObject" Target="../embeddings/unknown.bin"/></Relationships>');
    const saved = [];
    const markdown = await converter.convertDocumentToMarkdown(await zip.generateAsync({ type: 'arraybuffer' }), 'pptx', {
        saveAsset: async (data, name) => { saved.push({ data: Buffer.from(data), name }); return '.asset/' + name; },
    });
    assert.deepEqual(saved, [{ data: bitmap, name: 'bitmap.bmp' }, { data: unknown, name: 'unknown.ole' }]);
    assert.match(markdown, /\[bitmap.bmp\]\(.asset\/bitmap.bmp\)/);
    assert.match(markdown, /\[unknown.ole\]\(.asset\/unknown.ole\)/);
});

test('legacy PPT recovers compressed original attachments discarded by LibreOffice', async () => {
    const payload = Buffer.from('shell script\n');
    const ole = nativeAttachment('test.sh', payload);
    const compressed = deflateSync(ole);
    const header = Buffer.alloc(12);
    header.writeUInt16LE(16, 0); // recInstance = 1: compressed storage
    header.writeUInt16LE(4113, 2);
    header.writeUInt32LE(compressed.length + 4, 4);
    header.writeUInt32LE(ole.length, 8);
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, 'PowerPoint Document', Buffer.concat([header, compressed]));
    const input = Uint8Array.from(CFB.write(cfb, { type: 'buffer' })).buffer;
    const zip = await presentationFixture();
    zip.file('ppt/slides/slide2.xml', '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Slide text</a:t></a:r></a:p>');
    invokeLegacy = async () => Array.from(await zip.generateAsync({ type: 'uint8array' }));
    const saved = [];
    const markdown = await converter.convertDocumentToMarkdown(input, 'ppt', {
        saveAsset: async (data, name) => { saved.push({ data: Buffer.from(data), name }); return '.asset/' + name; },
    });
    assert.match(markdown, /Slide text/);
    assert.match(markdown, /## 附件\n\n- \[test.sh\]\(.asset\/test.sh\)/);
    assert.deepEqual(saved, [{ data: payload, name: 'test.sh' }]);
});

test('Word tables, bookmarks and external images survive DOCX and legacy DOC conversion', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
      <w:p><w:hyperlink w:anchor="__RefHeading___Toc36820085"><w:r><w:t>引言 1</w:t></w:r></w:hyperlink></w:p>
      <w:p><w:bookmarkStart w:id="1" w:name="__RefHeading___Toc36820085"/><w:r><w:t>引言</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>x|y</w:t></w:r></w:p><w:p><w:r><w:t>next</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:drawing><wp:inline><wp:docPr id="2" name="Picture"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    </w:body></w:document>`);
    zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    zip.file('word/media/image1.png', image);
    const docx = await zip.generateAsync({ type: 'arraybuffer' });
    invokeLegacy = async () => Array.from(new Uint8Array(docx));
    for (const extension of ['docx', 'doc']) {
        const saved = [];
        const markdown = await converter.convertDocumentToMarkdown(docx, extension, {
            saveImage: async (bytes, name) => {
                saved.push({ bytes, name });
                return '.asset/image%20(1).png';
            },
        });
        assert.match(markdown, /\| A \| B \|\n\| --- \| --- \|/);
        assert.match(markdown, /x\\?&#124;y<br>/);
        assert.doesNotMatch(markdown, /<table|data:image/);
        assert.match(markdown, /<a id="__RefHeading___Toc36820085"><\/a>/);
        assert.match(markdown, /\]\(#__RefHeading___Toc36820085\)/);
        assert.ok(markdown.includes('![](.asset/image%20\\(1\\).png)'));
        assert.equal(saved.length, 1);
        assert.equal(saved[0].name, 'image-1.png');
        assert.deepEqual(Buffer.from(saved[0].bytes), image);
    }
    await assert.rejects(converter.convertDocumentToMarkdown(docx, 'docx', {
        saveImage: async () => { throw new Error('image write failed'); },
    }), /image write failed/);
});

test('supported extensions and actionable empty/legacy errors', async () => {
    assert.equal(converter.isConvertibleDocument('C:\\docs\\A.PPTX'), true);
    assert.equal(converter.isConvertibleDocument('/dir.pdf/note.md'), false);
    await assert.rejects(converter.convertDocumentToMarkdown(buffer(''), 'csv'), /未提取到/);
    invokeLegacy = async () => { throw new Error('未找到 LibreOffice，请安装后重试'); };
    for (const extension of ['doc', 'ppt']) {
        assert.equal(converter.isConvertibleDocument(`file.${extension}`), true);
        await assert.rejects(converter.convertDocumentToMarkdown(buffer(''), extension), /未找到 LibreOffice/);
    }
});
