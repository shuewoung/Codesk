import assert from 'node:assert/strict';
import test from 'node:test';
import { clampSize, createPtyFlush, createPtyHub, PTY_MISSING_MESSAGE } from './pty.js';

test('clampSize bounds cols and rows', () => {
  assert.deepEqual(clampSize(80, 24), { cols: 80, rows: 24 });
  assert.equal(clampSize(1, 1).cols, 20);
  assert.equal(clampSize(999, 999).rows, 120);
});

test('createPtyFlush merges by byte cap and timer', () => {
  const out = [];
  const timers = [];
  const flush = createPtyFlush({
    onFlush: (data) => out.push(data),
    intervalMs: 20,
    maxBytes: 8,
    schedule(fn) {
      timers.push(fn);
      return timers.length;
    },
    unschedule() {},
  });
  flush.push('abcd');
  assert.deepEqual(out, []);
  flush.push('efghij');
  assert.deepEqual(out, ['abcdefghij']);
  flush.push('xy');
  timers.pop()();
  assert.deepEqual(out, ['abcdefghij', 'xy']);
  flush.dispose();
});

function fakeProc() {
  const dataCbs = [];
  const exitCbs = [];
  const writes = [];
  const resizes = [];
  let killed = false;
  return {
    writes,
    resizes,
    get killed() { return killed; },
    emitData(chunk) { for (const cb of dataCbs) cb(chunk); },
    emitExit(ev) { for (const cb of exitCbs) cb(ev); },
    write(data) { writes.push(data); },
    resize(cols, rows) { resizes.push({ cols, rows }); },
    kill() { killed = true; },
    onData(cb) { dataCbs.push(cb); },
    onExit(cb) { exitCbs.push(cb); },
  };
}

test('pty hub open attach replay and close', () => {
  const procs = [];
  const hub = createPtyHub({
    maxLive: 4,
    intervalMs: 20,
    maxBytes: 4,
    schedule(fn) { fn(); return 1; },
    unschedule() {},
    spawnPty() {
      const proc = fakeProc();
      procs.push(proc);
      return proc;
    },
  });
  const a = [];
  const first = hub.open({
    threadId: 't1',
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    send: (msg) => a.push(msg),
  });
  assert.equal(first.attached, false);
  procs[0].emitData('hi!\n');
  assert.equal(a[0].type, 'pty_data');
  assert.equal(a[0].data, 'hi!\n');

  const b = [];
  const second = hub.open({
    threadId: 't1',
    cwd: process.cwd(),
    cols: 100,
    rows: 30,
    send: (msg) => b.push(msg),
  });
  assert.equal(second.attached, true);
  assert.equal(procs.length, 1);
  assert.deepEqual(procs[0].resizes.at(-1), { cols: 100, rows: 30 });
  assert.equal(b[0].data, 'hi!\n');

  assert.equal(hub.input('t1', 'dir\r'), true);
  assert.equal(procs[0].writes[0], 'dir\r');
  assert.equal(hub.close('t1'), true);
  assert.equal(procs[0].killed, true);
  hub.dispose();
});

test('pty hub evicts oldest beyond maxLive', () => {
  const hub = createPtyHub({
    maxLive: 2,
    schedule(fn) { fn(); return 1; },
    unschedule() {},
    spawnPty() { return fakeProc(); },
  });
  const events = [];
  hub.open({ threadId: 'a', cwd: process.cwd(), send: (m) => events.push(m) });
  hub.open({ threadId: 'b', cwd: process.cwd(), send: (m) => events.push(m) });
  hub.input('a', 'x');
  hub.open({ threadId: 'c', cwd: process.cwd(), send: (m) => events.push(m) });
  assert.equal(hub.has('a'), true);
  assert.equal(hub.has('b'), false);
  assert.equal(hub.has('c'), true);
  assert.equal(events.some((m) => m.type === 'pty_exit' && m.threadId === 'b'), true);
  hub.dispose();
});

test('missing node-pty message is stable', () => {
  assert.match(PTY_MISSING_MESSAGE, /node-pty/);
});
