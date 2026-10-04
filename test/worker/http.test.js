import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { AdmissionDurableObject } from '../../worker/index.js';

test('private routes never reach a Durable Object and protocol failures have stable HTTP statuses', async () => {
  const env = { ASSETS: { fetch: () => new Response('asset') } };
  const invoke = (path, init) => worker.fetch(new Request(`https://game.example${path}`, init), env);
  assert.equal((await invoke('/_reserve', { method: 'POST' })).status, 404);
  assert.equal((await invoke('/api/rooms/ABCD/_reserve', { method: 'POST' })).status, 404);
  assert.equal((await invoke('/ws?room=ABCD')).status, 426);
  assert.equal((await invoke('/ws?room=IIII', { headers: { Upgrade: 'websocket' } })).status, 400);
  assert.equal((await invoke('/api/rooms', { method: 'DELETE' })).status, 405);
  assert.equal((await invoke('/api/rooms', { method: 'POST', headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await invoke('/healthz')).status, 200);
  assert.equal(await (await invoke('/')).text(), 'asset');
});

test('forwarded headers cannot spoof edge identity; reservation limits persist across instance reset', async () => {
  const values = new Map();
  const storage = { async get(k) { return values.get(k); }, async put(k, v) { values.set(k, structuredClone(v)); },
    async setAlarm() {}, async deleteAll() { values.clear(); } };
  const state = { storage, blockConcurrencyWhile(fn) { return fn(); } };
  let limiter = new AdmissionDurableObject(state, {});
  const admission = { idFromName(name) { return name; }, get() { return { fetch(req) { return limiter.fetch(req); } }; } };
  const names = [];
  const env = { ADMISSION: { ...admission, idFromName(name) { names.push(name); return name; } },
    ROOMS: { idFromName(name) { return name; }, get() { return { fetch() { return Response.json({ code: 'ABCD', ticket: 'secret' }, { status: 201 }); } }; } } };
  const request = (xff) => new Request('https://game.example/api/rooms', { method: 'POST',
    headers: { 'CF-Connecting-IP': '8.8.8.8', 'X-Forwarded-For': xff, 'X-Real-IP': xff } });
  for (let n = 0; n < 8; n++) assert.equal((await worker.fetch(request(`9.9.9.${n}`), env)).status, 201);
  limiter = new AdmissionDurableObject(state, {});
  assert.equal((await worker.fetch(request('1.1.1.1'), env)).status, 429);
  assert.equal(new Set(names).size, 1);
});

test('a request ends with its own status: client errors keep their code, failures are logged with their route', async (t) => {
  const lines = [];
  for (const level of ['warn', 'error']) t.mock.method(console, level, (line) => lines.push({ level, ...line }));
  const token = 'a'.repeat(64);
  let failure = null;
  const env = {
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
