import assert from 'node:assert/strict';
import test from 'node:test';
import { createSocketMaintenance, drainPending, transportIdentity } from './session-transport';

const creds = { mode: 'relay', relayUrl: 'https://relay', deviceToken: 'token', hubId: 'hub',
  lanUrl: '', lanPassword: '', localTrusted: false, contentKey: 'old' };

test('cached-key Relay reconnect drains same-identity queue, including after key rotation', () => {
  const identity = transportIdentity(creds);
  const queue = [1, 2, 3].map(message => ({ identity, message }));
  const sent: number[] = [];
  drainPending(queue, transportIdentity({ ...creds, contentKey: 'new' } as typeof creds), message => {
    sent.push(message); return true;
  });
  assert.deepEqual(sent, [1, 2, 3]);
  assert.deepEqual(queue, []);
});

for (const throws of [false, true]) {
  test(`failed queue send retains head and tail (${throws ? 'throw' : 'false'})`, () => {
    const queue = [1, 2, 3].map(message => ({ identity: 'a', message }));
    const sent: number[] = [];
    drainPending(queue, 'a', message => {
      if (message === 2) { if (throws) throw new Error('socket closed'); return false; }
      sent.push(message); return true;
    });
    assert.deepEqual(sent, [1]);
    assert.deepEqual(queue.map(x => x.message), [2, 3]);
    drainPending(queue, 'a', message => { sent.push(message); return true; });
    assert.deepEqual(sent, [1, 2, 3]);
    assert.equal(queue.length, 0);
  });
}

test('endpoint, token, hub and mode changes never replay another identity', () => {
  for (const change of [{ relayUrl: 'https://other' }, { deviceToken: 'new' }, { hubId: 'other' },
    { mode: 'lan', lanUrl: 'http://100.64.0.1', lanPassword: 'pw' }]) {
    const identity = transportIdentity({ ...creds, ...change });
    const queue = [{ identity: transportIdentity(creds), message: 'old' }, { identity, message: 'new' }];
    const sent: string[] = [];
    drainPending(queue, identity, message => { sent.push(message); return true; });
    assert.deepEqual(sent, ['new']);
  }
});

test('maintenance stops in background and resumes on OPEN without duplicate intervals', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let beats = 0;
  let retries = 0;
  const maintenance = createSocketMaintenance(() => beats++, () => retries++);
  maintenance.start();
  maintenance.start();
  t.mock.timers.tick(20000);
  assert.equal(beats, 1);
  assert.equal(retries, 2);
  maintenance.stop();
  t.mock.timers.tick(80000);
  assert.equal(beats, 1);
  assert.equal(retries, 2);
  maintenance.start();
  maintenance.start();
  t.mock.timers.tick(20000);
  assert.equal(beats, 2);
  assert.equal(retries, 4);
  maintenance.stop();
});
