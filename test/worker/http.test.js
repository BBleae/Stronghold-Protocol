import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.js';

// Request limits that never refuse (wrangler.jsonc "ratelimits").
const unlimited = Object.fromEntries(['RESERVE_LIMIT', 'CONNECT_LIMIT', 'STATUS_LIMIT', 'AUTH_LIMIT', 'APPLICATION_LIMIT', 'API_LIMIT', 'QUEUE_LIMIT']
  .map((name) => [name, { limit: async () => ({ success: true }) }]));

test('private routes never reach a Durable Object and protocol failures have stable HTTP statuses', async () => {
  const env = { ...unlimited, ASSETS: { fetch: () => new Response('asset') } };
  const invoke = (path, init) => worker.fetch(new Request(`https://game.example${path}`, init), env);
  assert.equal((await invoke('/_reserve', { method: 'POST' })).status, 404);
  assert.equal((await invoke('/api/rooms/ABCD/_reserve', { method: 'POST' })).status, 404);
  assert.equal((await invoke('/ws?room=ABCD')).status, 426);
  assert.equal((await invoke('/api/rooms', { method: 'DELETE' })).status, 405);
  assert.equal((await invoke('/api/rooms', { method: 'POST', headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await invoke('/healthz')).status, 200);
  assert.equal(await (await invoke('/')).text(), 'asset');
});

test('request limits count the network the edge reports, never forwarded headers', async () => {
  const counts = new Map();
  const token = 'a'.repeat(64);
  const env = {
    SITES: { idFromName: (name) => name, get: () => ({ getSession: async () => ({ accountId: 'a', expiresAt: Date.now() + 60_000 }) }) },
    ACCOUNTS: { idFromName: (name) => name, get: () => ({ getActiveSeat: async () => null, claimSeat: async () => ({ ok: true }) }) },
    RESERVE_LIMIT: { async limit({ key }) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key) <= 8 };
    } },
    ROOMS: { idFromName(name) { return name; }, get() { return { fetch() {
      return Response.json({ code: 'ABCD', ticket: 'secret', generation: 'g' }, { status: 201 });
    } }; } },
  };
  const request = (ip, forwarded) => new Request('https://game.example/api/rooms', { method: 'POST',
    headers: { Origin: 'https://game.example', cookie: `__Host-sp_session=${token}`,
      'CF-Connecting-IP': ip, 'X-Forwarded-For': forwarded, 'X-Real-IP': forwarded } });
  for (let n = 0; n < 8; n++) assert.equal((await worker.fetch(request('8.8.8.8', `9.9.9.${n}`), env)).status, 201);
  const refused = await worker.fetch(request('8.8.8.8', '1.1.1.1'), env);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('Retry-After'), '10');
  // An IPv6 subscriber's /64 is one network.
  await worker.fetch(request('2001:db8:1:2::a', '9.9.9.9'), env);
  await worker.fetch(request('2001:db8:1:2:ffff::b', '9.9.9.9'), env);
  assert.deepEqual([...counts], [['net:8.8.8.8', 9], ['net:2001:db8:1:2::/64', 2]]);
});

test('every /api request counts against its network before it reaches the directory', async () => {
  let lookups = 0;
  const counts = new Map();
  const env = {
    ...unlimited,
    API_LIMIT: { async limit({ key }) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key) <= 3 };
    } },
    SITES: { idFromName: (name) => name, get: () => ({ async getSession() {
      lookups++;
      return null;
    } }) },
  };
  // A flood of requests with made-up session cookies, one of each route that looks the login up.
  const paths = ['/api/me', '/api/me/matches', '/api/matches/x:1', '/api/me/active-match', '/api/me/preferences',
    '/api/me/stats', '/api/matches/x:1/replay/0', '/api/rooms/ABCD/visibility'];
  const statuses = [];
  for (const path of paths) {
    const response = await worker.fetch(new Request(`https://game.example${path}`, {
      headers: { cookie: `__Host-sp_session=${'f'.repeat(64)}`, 'CF-Connecting-IP': '8.8.8.8' } }), env);
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [200, 401, 401, 429, 429, 429, 429, 429]);
  assert.equal(lookups, 3, 'a refused request never reaches the directory');
  assert.deepEqual([...counts], [['net:8.8.8.8', 8]]);
});

test('application requests count against the account as well as its network', async () => {
  const counts = new Map();
  const env = {
    SITES: { idFromName: (name) => name, get: () => ({ getSession: async () => ({ accountId: 'a', expiresAt: Date.now() + 60_000 }) }) },
    ACCOUNTS: { idFromName: (name) => name, get: () => ({ getActiveSeat: async () => null, getApplication: async () => null,
      getProfile: async () => ({ name: 'A#0001' }) }) },
    ROOMS: { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json({ id: 'x' }, { status: 201 }) }) },
    APPLICATION_LIMIT: { async limit({ key }) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key) <= 30 };
    } },
  };
  const apply = (ip) => worker.fetch(new Request('https://game.example/api/rooms/ABCD/applications', { method: 'POST',
    headers: { Origin: 'https://game.example', cookie: `__Host-sp_session=${'a'.repeat(64)}`, 'CF-Connecting-IP': ip },
    body: JSON.stringify({ action: 'apply' }) }), env);
  // A new network for every request: the account's 31st is refused.
  for (let n = 0; n < 30; n++) assert.equal((await apply(`10.0.${n}.1`)).status, 201);
  assert.equal((await apply('10.0.99.1')).status, 429);
  assert.equal(counts.get('account:a'), 31);
});

test('a request ends with its own status: client errors keep their code, failures are logged with their route', async (t) => {
  const lines = [];
  for (const level of ['warn', 'error']) t.mock.method(console, level, (line) => lines.push({ level, ...line }));
  const token = 'a'.repeat(64);
  let failure = null;
  const env = {
    ...unlimited,
    SITES: { idFromName: (name) => name, get: () => ({ async getSession() {
      if (failure) throw failure;
      return { accountId: 'a', expiresAt: Date.now() + 60_000 };
    } }) },
    ACCOUNTS: {},
  };
  const call = async (path, init = {}) => {
    const response = await worker.fetch(new Request(`https://game.example${path}`, { ...init,
      headers: { Origin: 'https://game.example', cookie: `__Host-sp_session=${token}`, ...init.headers } }), env);
    return { status: response.status, body: await response.json() };
  };
  const apply = (body) => call('/api/rooms/ABCD/applications', { method: 'POST', body });

  // Malformed or oversized bodies are the client's error, not an outage.
  assert.deepEqual(await apply('{"action":'), { status: 400, body: { error: 'BAD_MSG' } });
  assert.deepEqual(await apply('null'), { status: 400, body: { error: 'BAD_MSG' } });
  assert.deepEqual(await apply(JSON.stringify({ action: 'apply', pad: 'x'.repeat(4096) })), { status: 413, body: { error: 'BODY_TOO_LARGE' } });
  // A Durable Object's own error keeps its code and status across RPC (which drops the AccountError class).
  failure = Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN', status: 403, remote: true });
  assert.deepEqual(await call('/api/me/active-match'), { status: 403, body: { error: 'FORBIDDEN' } });
  assert.deepEqual(lines, [], 'client errors are not logged');

  // An overloaded object is unavailable for now; anything else is a bug.
  failure = Object.assign(new Error('Durable Object is overloaded.'), { overloaded: true });
  assert.deepEqual(await call('/api/me/active-match'), { status: 503, body: { error: 'UNAVAILABLE' } });
  failure = new TypeError('boom');
  assert.deepEqual(await call('/api/me/active-match'), { status: 500, body: { error: 'INTERNAL' } });
  assert.deepEqual(lines.map(({ level, event, method, path, error }) => ({ level, event, method, path, name: error.name, message: error.message })), [
    { level: 'warn', event: 'request_unavailable', method: 'GET', path: '/api/me/active-match', name: 'Error', message: 'Durable Object is overloaded.' },
    { level: 'error', event: 'request_failed', method: 'GET', path: '/api/me/active-match', name: 'TypeError', message: 'boom' },
  ]);
  assert.ok(!JSON.stringify(lines).includes(token), 'no session token in the logs');
});

test('the 匹配 queue\'s polls count against their own limit, not the one every other /api request shares', async () => {
  const counted = [];
  const env = {
    ...unlimited,
    API_LIMIT: { async limit() { throw new Error('the queue never counts against API_LIMIT'); } },
    QUEUE_LIMIT: { async limit({ key }) { counted.push(key); return { success: false }; } },
  };
  const response = await worker.fetch(new Request('https://game.example/api/queue', {
    method: 'POST', headers: { 'CF-Connecting-IP': '8.8.8.8' }, body: '{"action":"poll"}' }), env);
  assert.equal(response.status, 429);
  assert.deepEqual(counted, ['net:8.8.8.8']);
});
