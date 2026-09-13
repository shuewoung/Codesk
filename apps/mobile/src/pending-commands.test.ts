import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pending from './pending-commands';
import * as composer from './composer-draft';
import * as protocol from './protocol';

const row = { namespace: '["hub","A"]', requestId: 'req', clientUserMessageId: 'user', threadId: 'thread', createdAt: 1 };

test('pending journal serializes concurrent writes, strips nonessential payload and never evicts unresolved entries', async () => {
  let raw: string | null = null;
  const store = pending.createPendingCommandStorage(async () => raw, async next => { raw = next; });
  await Promise.all([
    store.put({ ...row, ...{ text: 'SECRET', input: [{ path: '/private' }] } }),
    store.put({ ...row, requestId: 'second' }),
    store.put({ ...row, namespace: '["hub","B"]' }),
  ]);
  assert.equal((await store.load(row.namespace)).length, 2);
  assert.equal(raw?.includes('SECRET'), false); assert.equal(raw?.includes('/private'), false);
  await store.remove(row.namespace, row.requestId);
  assert.equal((await store.load(row.namespace)).length, 1);
  assert.equal((await store.load('["hub","B"]')).length, 1);
  await assert.rejects(store.put({ ...row, requestId: 'second', threadId: 'different' }), /identity conflict/);
});

test('corrupt or unavailable durable storage rejects instead of pretending an empty journal', async () => {
  let raw = '{bad';
  const store = pending.createPendingCommandStorage(async () => raw, async next => { raw = next; });
  await assert.rejects(store.load(row.namespace));
  await assert.rejects(store.put(row));
  raw = '[]';
  await store.put(row);
  assert.equal((await store.load(row.namespace)).length, 1);
  const full = pending.createPendingCommandStorage(async () => JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ ...row, requestId: `existing-${i}` }))), async () => { assert.fail('must not overwrite full journal'); });
  await assert.rejects(full.put(row), /storage full/);
});

test('Web production storage uses independent per-command keys and propagates quota failure', async () => {
  const data = new Map<string, string>();
  let fail = false;
  const localStorage = {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (fail) throw new Error('quota'); data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const module = { exports: {} as any };
  const code = ts.transpileModule(readFileSync(new URL('./storage.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const modules: Record<string, unknown> = {
    'expo-secure-store': {}, 'react-native': { Platform: { OS: 'web' } },
    './pending-commands': pending, './composer-draft': composer, './protocol': protocol,
  };
  vm.runInNewContext(code, { module, exports: module.exports, localStorage, URL, require: (name: string) => modules[name] });
  const storage = module.exports;
  await Promise.all([storage.savePendingCommand(row), storage.savePendingCommand({ ...row, requestId: 'another' })]);
  assert.equal(data.size, 2);
  assert.equal((await storage.loadPendingCommands(row.namespace)).length, 2);
  assert.equal((await storage.loadPendingCommands('["hub","other"]')).length, 0);
  await storage.removePendingCommand(row.namespace, row.requestId);
  assert.equal(data.size, 1);
  fail = true;
  await assert.rejects(storage.savePendingCommand(row), /quota/);
  assert.equal(data.size, 1);
});
