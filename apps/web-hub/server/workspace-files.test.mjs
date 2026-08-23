import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  filesMatchingPlanStep,
  listArtifactFiles,
  searchWorkspaceFiles,
} from './workspace-files.js';

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesk-ws-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), 'export {}\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(root, 'notes.xlsx'), 'fake');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'api.ts'), 'skip');
  return root;
}

test('searchWorkspaceFiles finds nested names and skips node_modules', () => {
  const root = makeTree();
  const hits = searchWorkspaceFiles(root, 'api');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'api.ts');
  assert.match(hits[0].path, /src/);
});

test('listArtifactFiles prefers recent office/md files', () => {
  const root = makeTree();
  const files = listArtifactFiles(root);
  const names = files.map((f) => f.name);
  assert.ok(names.includes('notes.xlsx'));
  assert.ok(names.includes('README.md'));
  assert.ok(!names.includes('api.ts'));
});

test('filesMatchingPlanStep matches filename tokens', () => {
  const hits = filesMatchingPlanStep('改 api.ts 接口', [
    { path: 'src/api.ts' },
    { path: 'src/other.ts' },
  ]);
  assert.deepEqual(hits.map((f) => f.path), ['src/api.ts']);
});
