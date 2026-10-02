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
