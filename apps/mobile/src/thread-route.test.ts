import assert from 'node:assert/strict';
import test from 'node:test';
import { hrefWithThreadId, parseThreadIdFromHref } from './thread-route';

const ID = '01a01ffb-f027-7f23-8187-22f9dfc5ac34';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('parseThreadIdFromHref reads hash, query and path', () => {
  assert.equal(parseThreadIdFromHref(`http://127.0.0.1:18990/#thread-${ID}`), ID);
  assert.equal(parseThreadIdFromHref(`http://127.0.0.1:18990/?threadId=${ID}`), ID);
  assert.equal(parseThreadIdFromHref(`http://127.0.0.1:18990/?thread=${ID}`), ID);
  assert.equal(parseThreadIdFromHref(`onedesk://thread/${ID}`), ID);
  assert.equal(parseThreadIdFromHref(`http://127.0.0.1:18990/thread/${ID}`), ID);
  assert.equal(parseThreadIdFromHref('http://127.0.0.1:18990/?pair=ABC123'), '');
  assert.equal(parseThreadIdFromHref(''), '');
});

test('parseThreadIdFromHref prefers hash over query', () => {
  assert.equal(
    parseThreadIdFromHref(`http://127.0.0.1:18990/?threadId=${OTHER}#thread-${ID}`),
    ID,
  );
});

test('hrefWithThreadId writes hash and drops thread query', () => {
  assert.equal(
    hrefWithThreadId(`http://127.0.0.1:18990/?pair=ABC&threadId=${OTHER}`, ID),
    `/?pair=ABC#thread-${ID}`,
  );
  assert.equal(
    hrefWithThreadId(`http://127.0.0.1:18990/#thread-${OTHER}`, ID),
    `/#thread-${ID}`,
  );
  assert.equal(hrefWithThreadId('http://127.0.0.1:18990/', ''), '/');
});
