import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';

const source = `
import { appendEvent, readEvents } from './worker/storage/journal.js';
export class TestObject {
  constructor(ctx) { this.storage = ctx.storage; }
  async fetch(req) {
    const body = await req.json();
    try {
      if (body.read != null) return Response.json(await readEvents(this.storage, body.read));
      const storage = body.fail ? {
        sql: this.storage.sql,
        transactionSync: fn => this.storage.transactionSync(() => { fn(); throw new Error('disk failure'); }),
      } : this.storage;
      return Response.json(await appendEvent(storage, body.event));
    } catch (e) { return Response.json({error: e.message}, {status: 400}); }
  }
}
export default { fetch(req, env) { return env.TEST.get(env.TEST.idFromName('journal')).fetch(req); } };
`;
test('journal commits once, rolls back failed transitions and survives a real runtime restart', {timeout: 60000}, async t => {
  const h = await createAccountHarness(source); t.after(() => h.dispose());
  const event = {commandId: 'purchase:1', at: 1000, kind: 'command', payload: {price: 5}};
  const send = async body => (await h.fetch(body)).json();
  assert.deepEqual(await send({event}), {seq: 1, duplicate: false});
  assert.deepEqual(await send({event}), {seq: 1, duplicate: true});
  assert.equal((await h.fetch({event: {...event, payload: {price: 0}}})).status, 400);
  assert.equal((await h.fetch({event: {...event, commandId: 'failed'}, fail: true})).status, 400);
  assert.deepEqual(await send({event: {...event, commandId: 'purchase:2'}}), {seq: 2, duplicate: false});
  await h.restart();
  const rows = await send({read: 0});
  assert.deepEqual(rows.map(r => r.commandId), ['purchase:1', 'purchase:2']);
  assert.equal((await send({read: 1})).length, 1);
  assert.equal((await h.fetch({event: {...event, at: -1}})).status, 400);
  assert.equal((await h.fetch({event: {...event, unknown: true}})).status, 400);
});
