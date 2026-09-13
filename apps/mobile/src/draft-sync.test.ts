import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveDraft, validRemoteDraft } from './draft-sync';
import { createDraftStorage, draftNamespace, legacyDraftNamespace, scopedDraftKey } from './composer-draft';

test('CAS conflict retains local text and attachments alongside the authoritative remote version', () => {
  const local = { text: 'local edit', attachments: [{ name: 'local', path: '/local', image: false }] };
  const remote = { version: 4, text: 'remote edit', attachments: [] };
  const state = receiveDraft({ status: 'saving', local }, remote, true);
  assert.equal(state.status, 'conflict');
  assert.equal(state.local, local);
  assert.equal(state.remote, remote);
});

test('draft ACK does not call newer local edits synced or regress remote versions', () => {
  const local = { text: 'typed after save', attachments: [] };
  const remote = { version: 5, text: 'sent before typing', attachments: [] };
  const conflict = receiveDraft({ status: 'saving', local }, remote);
  assert.equal(conflict.status, 'conflict');
  assert.equal(receiveDraft(conflict, { ...remote, version: 4 }), conflict);
  assert.equal(receiveDraft({ ...conflict, local: remote }, remote).status, 'synced');
});

test('wire draft rejects malformed CAS versions and attachment containers', () => {
  for (const invalid of [null, {}, { version: -1, text: '', attachments: [] }, { version: 0.5, text: '', attachments: [] }, { version: 0, text: '', attachments: {} }]) assert.equal(validRemoteDraft(invalid), false);
  assert.equal(validRemoteDraft({ version: 0, text: '', attachments: [] }), true);
});

test('stable Hub identity shares drafts across LAN/Relay but never across Hubs', () => {
  const lan = { mode: 'lan', hubId: 'hub-a', lanUrl: 'http://192.168.1.2:18990' };
  const relay = { mode: 'relay', hubId: 'hub-a', relayUrl: 'https://relay.example' };
  assert.equal(draftNamespace(lan), draftNamespace(relay));
  assert.notEqual(draftNamespace(lan), draftNamespace({ ...lan, hubId: 'hub-b' }));
  assert.notEqual(legacyDraftNamespace(lan), draftNamespace(lan));
});

test('namespace migration copies old transport drafts without deleting backups or overwriting conflicts', async () => {
  const source = scopedDraftKey('t', 'lan-old');
  const target = scopedDraftKey('t', 'hub-stable');
  const draft = { text: 'saved on LAN', pending: [], updatedAt: 1, sending: undefined };
  let raw = JSON.stringify({ [source]: draft });
  const storage = createDraftStorage(async () => raw, async value => { raw = value; });
  await storage.migrateNamespace('lan-old', 'hub-stable');
  assert.deepEqual(await storage.load(target), draft);
  assert.deepEqual(await storage.load(source), draft);
  await storage.save(target, { ...draft, text: 'edited on Relay' });
  await storage.migrateNamespace('lan-old', 'hub-stable');
  assert.equal((await storage.load(target))?.text, 'edited on Relay');
  assert.equal((await storage.load(source))?.text, 'saved on LAN');
});
