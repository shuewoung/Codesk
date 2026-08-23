import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPinsToGlobalState,
  collectDesiredArchivedIds,
  collectDesiredPinIds,
  parseArchivesJsonl,
  parsePinsJsonl,
  pinKey,
  pinSetsEqual,
  reconcileDesktopArchiveChange,
  reconcileDesktopPinChange,
  resolveIsArchived,
  resolveIsPinned,
  resolveProjectIsPinned,
} from './pins.js';

test('parsePinsJsonl last write wins', () => {
  const map = parsePinsJsonl([
    '{"id":"t1","kind":"thread","pinned":true,"updated_at":"2026-01-01T00:00:00.000Z"}',
    '{"id":"t1","kind":"thread","pinned":false,"updated_at":"2026-01-02T00:00:00.000Z"}',
    '{"id":"p1","kind":"project","pinned":true,"updated_at":"2026-01-03T00:00:00.000Z"}',
    'not-json',
  ].join('\n'));
  assert.equal(map.get('thread:t1').pinned, false);
  assert.equal(map.get('project:p1').pinned, true);
});

test('resolveIsPinned prefers override then sidecar then catalog', () => {
  const pinMap = new Map([[pinKey('thread', 'a'), { pinned: true, upd: '1' }]]);
  const overrideMap = new Map([[pinKey('thread', 'a'), { pinned: false, upd: '2' }]]);
  assert.equal(resolveIsPinned('thread', 'a', { overrideMap, pinMap, fallback: true }), false);
  assert.equal(resolveIsPinned('thread', 'a', { pinMap, fallback: false }), true);
  assert.equal(resolveIsPinned('thread', 'b', { fallback: true }), true);
});

test('project override wins even when catalog still has the pin', () => {
  const catalogPinnedIds = new Set(['p1']);
  const overrideMap = new Map([[pinKey('project', 'p1'), { pinned: false, upd: '9' }]]);
  assert.equal(resolveProjectIsPinned({ id: 'p1', name: 'Demo' }, {
    overrideMap,
    pinMap: new Map(),
    catalogPinnedIds,
  }), false);
  assert.equal(resolveProjectIsPinned({ id: 'p1', name: 'Demo' }, {
    overrideMap: new Map(),
    pinMap: new Map(),
    catalogPinnedIds,
  }), true);
});

test('collectDesiredPinIds merges sidecar over catalog', () => {
  const pinMap = new Map([
    [pinKey('thread', 'keep'), { id: 'keep', kind: 'thread', pinned: true, upd: '2' }],
    [pinKey('thread', 'drop'), { id: 'drop', kind: 'thread', pinned: false, upd: '2' }],
  ]);
  const got = collectDesiredPinIds({
    catalogThreadIds: ['drop', 'old'],
    catalogProjectIds: ['proj'],
    pinMap,
    overrideMap: new Map([[pinKey('project', 'proj'), { id: 'proj', kind: 'project', pinned: false, upd: '3' }]]),
  });
  assert.deepEqual(got.threadIds.sort(), ['keep', 'old']);
  assert.deepEqual(got.projectIds, []);
});

test('applyPinsToGlobalState rewrites ids and canonical order keys', () => {
  const next = applyPinsToGlobalState({
    'pinned-thread-ids': ['gone'],
    'pinned-project-ids': [],
    'electron-persisted-atom-state': {
      'unified-sidebar-pinned-order-v1': [
        'codex:thread:local:gone',
        'codex:thread:019ea612-1559-7901-9204-d5235e14a7ff',
        'codex:project:p1',
      ],
    },
  }, {
    threadIds: ['t-new', '019ea612-1559-7901-9204-d5235e14a7ff'],
    projectIds: ['p1'],
  });
  assert.deepEqual(next['pinned-thread-ids'], ['t-new', '019ea612-1559-7901-9204-d5235e14a7ff']);
  assert.deepEqual(next['pinned-project-ids'], ['p1']);
  assert.deepEqual(next['electron-persisted-atom-state']['unified-sidebar-pinned-order-v1'], [
    'codex:thread:local:019ea612-1559-7901-9204-d5235e14a7ff',
    'codex:project:p1',
    'codex:thread:local:t-new',
  ]);
});

test('reconcileDesktopPinChange only applies ids Desktop actually changed', () => {
  const updates = reconcileDesktopPinChange({
    prevThreadIds: ['keep-remote', 'desk'],
    prevProjectIds: [],
    catalogThreadIds: ['keep-remote', 'desk-new'],
    catalogProjectIds: ['p1'],
  });
  const byId = Object.fromEntries(updates.map((u) => [`${u.kind}:${u.id}`, u]));
  assert.equal(byId['thread:keep-remote'], undefined);
  assert.equal(byId['thread:desk'].pinned, false);
  assert.equal(byId['thread:desk-new'].pinned, true);
  assert.equal(byId['project:p1'].pinned, true);
  assert.equal(reconcileDesktopPinChange({
    catalogThreadIds: ['x'],
    catalogProjectIds: [],
  }).length, 0);
});

test('archive sidecar last write wins and override hides threads', () => {
  const archiveMap = parseArchivesJsonl([
    '{"id":"t1","archived":true,"updated_at":"2026-01-01T00:00:00.000Z"}',
    '{"id":"t1","archived":false,"updated_at":"2026-01-02T00:00:00.000Z"}',
  ].join('\n'));
  assert.equal(archiveMap.get('t1').archived, false);
  const overrideMap = new Map([['t1', { archived: true, upd: '9' }]]);
  assert.equal(resolveIsArchived('t1', { overrideMap, archiveMap, fallback: false }), true);
  assert.deepEqual(collectDesiredArchivedIds({
    catalogArchivedIds: ['old'],
    archiveMap,
    overrideMap,
  }).sort(), ['old', 't1']);
});

test('reconcileDesktopArchiveChange diffs sqlite archived set', () => {
  const updates = reconcileDesktopArchiveChange({
    prevArchivedIds: ['keep', 'gone'],
    catalogArchivedIds: ['keep', 'new'],
  });
  const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
  assert.equal(byId.keep, undefined);
  assert.equal(byId.gone.archived, false);
  assert.equal(byId.new.archived, true);
  assert.equal(reconcileDesktopArchiveChange({ catalogArchivedIds: ['x'] }).length, 0);
});

test('pinSetsEqual ignores order and duplicates', () => {
  assert.equal(pinSetsEqual(
    { threadIds: ['a', 'b', 'a'], projectIds: ['p'] },
    { threadIds: ['b', 'a'], projectIds: ['p'] },
  ), true);
  assert.equal(pinSetsEqual(
    { threadIds: ['a'], projectIds: [] },
    { threadIds: ['a'], projectIds: ['p'] },
  ), false);
});
