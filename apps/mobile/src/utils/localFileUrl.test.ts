import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupCachedFile, normalizeFsPath } from './localFileUrl';

test('lookupCachedFile matches requestPath and relative suffix', () => {
  const file = {
    path: 'D:\\work\\src\\a.ts',
    requestPath: 'src/a.ts',
    fileName: 'a.ts',
  };
  const files = {
    'D:\\work\\src\\a.ts': file,
    'src/a.ts': file,
  };
  assert.equal(lookupCachedFile(files, 'src/a.ts'), file);
  assert.equal(lookupCachedFile(files, 'D:/work/src/a.ts'), file);
  assert.equal(lookupCachedFile(files, 'a.ts')?.fileName, 'a.ts');
  assert.equal(normalizeFsPath('D:\\work\\src\\a.ts'), 'd:/work/src/a.ts');
});
