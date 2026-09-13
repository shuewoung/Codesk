import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { decodedBase64Size, fetchJsonWithDeadline, forceClearThreadWriterLock, logoutLan, loginLan, pairWithCode, revokeDevice, uploadLan } from './api';
import { HOLDER_ALIVE_CODE, isHolderAliveError } from './force-clear-lock';

const originalFetch = globalThis.fetch;
const calls: { url: string; init: RequestInit }[] = [];

afterEach(() => {
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const req = init || {};
    calls.push({ url, init: req });
    return handler(url, req);
  }) as typeof fetch;
}

test('force clear requires confirmation, a thread and direct Hub HTTP; never fetches in Relay', async () => {
  mockFetch(() => { throw new Error('must not fetch'); });
  await assert.rejects(() => forceClearThreadWriterLock('relay', 'http://127.0.0.1:18990', 'relay-token', 't1', true), /Relay/);
  await assert.rejects(() => forceClearThreadWriterLock('', 'http://127.0.0.1:18990', '', 't1', true), /直连/);
  await assert.rejects(() => forceClearThreadWriterLock('lan', '', '', 't1', true), /直连/);
  await assert.rejects(() => forceClearThreadWriterLock('lan', 'http://127.0.0.1:18990', '', 't1', false), /确认/);
  await assert.rejects(() => forceClearThreadWriterLock('lan', 'http://127.0.0.1:18990', '', ' ', true), /会话 ID/);
  assert.equal(calls.length, 0);
});

for (const cleared of [true, false]) {
  test(`force clear posts exact thread and confirmation with cookie/Bearer auth: cleared=${cleared}`, async () => {
    mockFetch(() => Response.json({ ok: true, cleared, threadId: 't1' }));
    assert.deepEqual(await forceClearThreadWriterLock('lan', '127.0.0.1:18990/', 'sess', 't1', true), { ok: true, cleared, threadId: 't1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:18990/api/thread-writer-lock/force-clear');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'include');
    assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer sess' });
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { threadId: 't1', confirmed: true });
  });
}

test('force clear uses the existing public same-origin Hub mapping and cookie-only auth', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {
    origin: 'https://cds.zhangsw.work', hostname: 'cds.zhangsw.work', protocol: 'https:', port: '',
  } } });
  try {
    mockFetch(() => Response.json({ ok: true, cleared: false, threadId: 't1' }));
    await forceClearThreadWriterLock('lan', 'https://cds.zhangsw.work:18990', '', 't1', true);
    assert.equal(calls[0].url, 'https://cds.zhangsw.work/api/thread-writer-lock/force-clear');
    assert.equal(calls[0].init.credentials, 'include');
    assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('force clear surfaces JSON errors and rejects invalid or other-thread responses without retry', async () => {
  for (const response of [
    Response.json({ error: '认证失败' }, { status: 401 }),
    Response.json({ message: '删除失败' }, { status: 500 }),
    new Response('<html>gateway</html>'),
    Response.json({ ok: true, cleared: true, threadId: 'other-thread' }),
    Response.json({ ok: true, cleared: 'true', threadId: 't1' }),
  ]) {
    mockFetch(() => response);
    await assert.rejects(() => forceClearThreadWriterLock('lan', 'http://127.0.0.1:18990', '', 't1', true), /认证失败|删除失败|无效|不匹配/);
  }
  assert.equal(calls.length, 5);
  mockFetch(() => { throw new TypeError('network down'); });
  await assert.rejects(() => forceClearThreadWriterLock('lan', 'http://127.0.0.1:18990', '', 't1', true), /结果未知/);
  assert.equal(calls.length, 6);
});

test('force clear throws an identifiable holder_alive error on 409 without acknowledgeHolderAlive', async () => {
  mockFetch(() => Response.json(
    { ok: false, error: HOLDER_ALIVE_CODE, holderAlive: true, message: '桌面 codex 进程仍在运行' },
    { status: 409 },
  ));
  await assert.rejects(
    () => forceClearThreadWriterLock('lan', 'http://127.0.0.1:18990', '', 't1', true),
    (err: unknown) => {
      assert.ok(isHolderAliveError(err), '错误应可识别为 holder_alive');
      const e = err as Error & { code?: string; error?: string; holderAlive?: boolean };
      assert.equal(e.code, HOLDER_ALIVE_CODE);
      assert.equal(e.error, HOLDER_ALIVE_CODE);
      assert.equal(e.holderAlive, true);
      assert.equal(e.message, '桌面 codex 进程仍在运行');
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { threadId: 't1', confirmed: true });
});

test('force clear posts acknowledgeHolderAlive:true only when explicitly requested', async () => {
  for (const options of [{ acknowledgeHolderAlive: true }, { acknowledgeHolderAlive: false }, undefined]) {
    mockFetch(() => Response.json({ ok: true, cleared: true, threadId: 't1' }));
    assert.deepEqual(
      await forceClearThreadWriterLock('lan', 'http://127.0.0.1:18990', 'sess', 't1', true, options),
      { ok: true, cleared: true, threadId: 't1' },
    );
    const body = JSON.parse(String(calls.at(-1)!.init.body)) as Record<string, unknown>;
    assert.equal(body.acknowledgeHolderAlive, options?.acknowledgeHolderAlive === true ? true : undefined);
    assert.deepEqual(Object.keys(body).sort(), (options?.acknowledgeHolderAlive === true
      ? ['acknowledgeHolderAlive', 'confirmed', 'threadId'] : ['confirmed', 'threadId']).sort());
  }
});

test('pairWithCode requires relay url and code', async () => {
  await assert.rejects(() => pairWithCode('', 'ABC'), /中继地址/);
  await assert.rejects(() => pairWithCode('https://relay.example.com', '  '), /配对码/);
});

test('pairWithCode posts JSON and returns deviceToken/hubId', async () => {
  mockFetch(() =>
    new Response(JSON.stringify({ deviceToken: 'odt_x', hubId: 'hub-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const result = await pairWithCode('relay.example.com/', 'abc123');
  assert.deepEqual(result, { deviceToken: 'odt_x', hubId: 'hub-1', hubE2ePub: '' });
  assert.equal(calls[0].url, 'https://relay.example.com/api/relay/pair');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, JSON.stringify({ code: 'abc123' }));
});

test('pairWithCode surfaces relay error message', async () => {
  mockFetch(() =>
    new Response(JSON.stringify({ code: 'invalid_code', message: 'invalid pairing code' }), { status: 401 }),
  );
  await assert.rejects(() => pairWithCode('https://relay.example.com', 'NOPE'), /配对码不对/);
});

test('pairWithCode coalesces parallel scans of the same code', async () => {
  let hits = 0;
  mockFetch(async () => {
    hits += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return new Response(JSON.stringify({ deviceToken: 'odt_x', hubId: 'hub-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const [a, b] = await Promise.all([
    pairWithCode('https://relay.example.com', 'ABC123'),
    pairWithCode('https://relay.example.com', 'abc123'),
  ]);
  assert.equal(hits, 1);
  assert.equal(a.deviceToken, 'odt_x');
  assert.equal(b.deviceToken, 'odt_x');
});

test('pairWithCode maps fetch failure to network error', async () => {
  mockFetch(() => {
    throw new TypeError('Network request failed');
  });
  await assert.rejects(() => pairWithCode('https://relay.example.com', 'ABC'), /网络不通/);
});

test('loginLan posts password/code to hub', async () => {
  mockFetch(() =>
    new Response(JSON.stringify({ token: 'sess', hubId: 'hub-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const result = await loginLan('127.0.0.1:18990', 'ABC123');
  assert.deepEqual(result, { token: 'sess', hubId: 'hub-1' });
  assert.equal(calls[0].url, 'http://127.0.0.1:18990/api/auth/login');
  assert.equal(calls[0].init.body, JSON.stringify({ password: 'ABC123', code: 'ABC123' }));
});

test('loginLan rejects html success without session token', async () => {
  mockFetch(() => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(() => loginLan('https://cds.zhangsw.work', 'ABCD'), /无法连接/);
});

test('loginLan maps fetch failure to a chinese error', async () => {
  mockFetch(() => {
    throw new TypeError('Network request failed');
  });
  await assert.rejects(() => loginLan('http://192.168.1.8:18990', 'ABC'), /无法连接/);
});

test('loginLan explains public :18990 tunnel miss', async () => {
  mockFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(
    () => loginLan('https://codex.zhangsw.work:18990', 'WWBS'),
    /不要访问 :18990/,
  );
});

test('revokeDevice sends Bearer token and rejects missing creds', async () => {
  mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await assert.rejects(() => revokeDevice('', 'tok'), /凭据/);
  await assert.rejects(() => revokeDevice('https://relay.example.com', ''), /凭据/);
  assert.equal(calls.length, 0);
  await revokeDevice('https://relay.example.com', 'odt_x');
  assert.equal(calls[0].url, 'https://relay.example.com/api/relay/revoke');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer odt_x');
});

test('decodedBase64Size and uploadLan post binary to hub', async () => {
  assert.equal(decodedBase64Size('AQID'), 3);
  mockFetch(() =>
    new Response(JSON.stringify({ success: true, path: 'D:\\hub-uploads\\a.bin', name: 'a.bin' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const result = await uploadLan('http://127.0.0.1:18990', 'sess', 'a.bin', 'AQID', 'application/octet-stream');
  assert.equal(result.path, 'D:\\hub-uploads\\a.bin');
  assert.match(calls[0].url, /\/api\/upload\?name=a\.bin/);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer sess');
});

for (const bodyHangs of [false, true]) {
  test(`HTTP deadline covers ${bodyHangs ? 'body' : 'fetch'} even without abort support`, async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url, init) => {
      signal = init?.signal;
      if (!bodyHangs) return await new Promise<Response>(() => {});
      return { json: () => new Promise(() => {}) } as unknown as Response;
    }) as typeof fetch;
    await assert.rejects(() => fetchJsonWithDeadline('https://example.com', {}, 10), /超时/);
    assert.equal(signal?.aborted, true);
  });
}

test('login coalesces same credentials and permits retry after a failure', async () => {
  let resolve!: (res: Response) => void;
  mockFetch(() => new Promise<Response>(done => { resolve = done; }));
  const first = loginLan('http://localhost:18990', 'ABCD');
  const second = loginLan('http://localhost:18990', 'ABCD');
  assert.equal(calls.length, 1);
  resolve(Response.json({ token: 'token', hubId: 'hub' }));
  assert.deepEqual(await first, await second);
  mockFetch(() => Response.json({ error: 'bad code' }, { status: 401 }));
  await assert.rejects(() => loginLan('http://localhost:18990', 'ABCD'), /bad code/);
  mockFetch(() => Response.json({ token: 'new' }));
  assert.equal((await loginLan('http://localhost:18990', 'ABCD')).token, 'new');
});

test('logoutLan posts cookie and optional Bearer and requires explicit success', async () => {
  for (const token of ['', 'session-secret']) {
    mockFetch(() => Response.json({ success: true }));
    await logoutLan('http://localhost:18990', token);
    const call = calls.at(-1)!;
    assert.equal(call.url, 'http://localhost:18990/api/auth/logout');
    assert.equal(call.init.credentials, 'include');
    assert.equal(call.init.method, 'POST');
    assert.equal((call.init.headers as Record<string, string>).Authorization, token ? `Bearer ${token}` : undefined);
  }
});

test('remote logout and revoke reject HTTP, malformed and negative acknowledgements', async () => {
  for (const operation of [() => logoutLan('http://localhost:18990', 'secret'), () => revokeDevice('https://relay.example', 'secret')]) {
    for (const response of [Response.json({ ok: true, success: true }, { status: 500 }), Response.json({}), Response.json({ ok: false, success: false }), new Response('<html>gateway</html>')]) {
      mockFetch(() => response);
      await assert.rejects(operation, /失败/);
    }
    mockFetch(() => { throw new Error('offline'); });
    await assert.rejects(operation, /offline/);
  }
});
