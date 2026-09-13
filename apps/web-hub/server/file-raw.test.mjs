import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDirectoryHtml,
  decodeRequestedPath,
  findWebPreview,
  hubRawFileHref,
  pickRawServePath,
  PREVIEW_DIR,
  resolveRequestedPath,
} from './file-raw.js';

test('decodeRequestedPath restores encoded Windows paths', () => {
  const encoded = 'D:%5Ctmp%5C20260825%5CHNFZ-%E5%8D%8E%E8%83%BD';
  assert.equal(decodeRequestedPath(encoded), 'D:\\tmp\\20260825\\HNFZ-华能');
  assert.equal(decodeRequestedPath('file:///D:/tmp/a.docx'), 'D:/tmp/a.docx');
});

test('resolveRequestedPath finds files and directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesk-file-raw-'));
  const dir = path.join(root, 'docs');
  const file = path.join(dir, 'a.txt');
  fs.mkdirSync(dir);
  fs.writeFileSync(file, 'hi');
  const fileHit = resolveRequestedPath(file);
  const dirHit = resolveRequestedPath(dir);
  assert.equal(fileHit.isDir, false);
  assert.equal(fileHit.path, file);
  assert.equal(dirHit.isDir, true);
  assert.equal(dirHit.path, dir);
  assert.equal(resolveRequestedPath('a.txt', dir).path, file);
});

test('office files prefer .web-preview pdf', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesk-preview-'));
  const src = path.join(root, '合同.doc');
  const preview = path.join(root, PREVIEW_DIR, '合同.pdf');
  fs.writeFileSync(src, 'ole');
  fs.mkdirSync(path.dirname(preview));
  fs.writeFileSync(preview, '%PDF');
  assert.equal(findWebPreview(src), preview);
  const picked = pickRawServePath(src, false);
  assert.equal(picked.kind, 'preview');
  assert.equal(picked.path, preview);
  assert.match(picked.mime, /pdf/);
});

test('directory html lists files and preview links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesk-dir-'));
  const doc = path.join(root, '采购文件.docx');
  const preview = path.join(root, PREVIEW_DIR, '采购文件.pdf');
  fs.writeFileSync(doc, 'zip');
  fs.mkdirSync(path.dirname(preview));
  fs.writeFileSync(preview, '%PDF');
  const html = buildDirectoryHtml(root);
  assert.match(html, /采购文件\.docx/);
  assert.match(html, /在浏览器中查看/);
  assert.ok(html.includes(hubRawFileHref(preview).replace(/&/g, '&amp;')));
  assert.doesNotMatch(html, />\.web-preview\/</);
});

import { rawPreviewHeaders } from './file-raw.js';
test('active previews are sandboxed while PDF and raster images remain unchanged', () => {
  for (const ext of ['html', 'htm', 'svg', 'xml']) {
    const target = pickRawServePath(`/tmp/document.${ext}`, false);
    const csp = rawPreviewHeaders(target.mime)['Content-Security-Policy'];
    assert.match(csp, /^sandbox;/);
    assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
  }
  for (const ext of ['pdf', 'png', 'jpg', 'gif', 'webp']) {
    assert.deepEqual(rawPreviewHeaders(pickRawServePath(`/tmp/document.${ext}`, false).mime), {});
  }
});
