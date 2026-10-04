import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareArchive } from '../../worker/archive/outbox.js';
import { createWorld } from './helpers/world.js';

// Finished matches wait for publication in the room's own archive rows, not in its snapshot. Rooms saved before
// that held them in the snapshot (raw, or already encoded); they move to the rows and publish as before.

function entry(accountId, matchId) {
  const common = { matchId, endedAt: 2000, startedAt: 1000, mode: 'solo', difficulty: 'FUNNY' };
  return {
    archiveEncoding: 2,
    facts: { ...common, participants: [accountId], result: { victory: true } },
    personal: [{ accountId, playerId: 'p_1', ...common, status: 'completed', victory: true, hiddenCleared: false, round: 14,
      stats: {}, operators: [], result: null }],
    replay: { schemaVersion: 1, rulesVersion: 'development-v1', battles: [{ battleId: matchId + ':b1', complete: false }] },
  };
}

test('archives a legacy snapshot held move to their own rows, publish, and leave nothing behind', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const { accountId } = await world.seed('a');
  const raw = entry(accountId, 'legacy:1');
  const frozen = entry(accountId, 'legacy:2');
  frozen.encodedReplay = await prepareArchive(frozen);
  delete frozen.replay;
  const snapshot = { version: 1, at: Date.now(), code: 'WXYZ', reservation: null, generation: 'legacy', resumeTickets: [], publicRoom: false,
    applications: [], archiveOutbox: [raw, frozen], interruptedUntil: 0, running: false, sessions: [], deadlines: [], room: null };
  await world.room('WXYZ', 'put', { key: 'snapshot-0', value: JSON.stringify(snapshot) });
  await world.room('WXYZ', 'put', { key: 'snapshot-meta', value: { parts: 1 } });
  await world.restart();

  // The wake stores both in rows and publishes them.
  await world.room('WXYZ', 'writes');
  let items = [];
  for (let i = 0; i < 100 && items.length < 2; i++) {
    items = (await world.api('a', '/api/me/matches')).body.items;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(items.map((item) => item.matchId).sort(), ['legacy:1', 'legacy:2']);
  for (const matchId of ['legacy:1', 'legacy:2']) {
    const archive = await world.api('a', `/api/matches/${matchId}`);
    assert.equal(archive.status, 200);
    assert.equal(archive.body.manifest.codec, 'gzip-base64');
    assert.equal((await world.api('a', `/api/matches/${matchId}/replay/0`)).status, 200);
  }
  // Published: the room had nothing else, so its storage is gone.
  for (let i = 0; i < 100 && await world.room('WXYZ', 'snapshot'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await world.room('WXYZ', 'snapshot'), null);
});

test('an archive that fails is logged and retried after its backoff, without holding up later archives', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const { accountId } = await world.seed('a');
  const failing = entry(accountId, 'stuck:1');
  const healthy = entry(accountId, 'stuck:2');
  // The account already holds another record under the first match id: publishing it ends in HISTORY_CONFLICT.
  await world.account(accountId, 'applyMatch', { ...failing.personal[0], victory: false });
  const snapshot = { version: 1, code: 'WXYZ', reservation: null, generation: 'stuck', resumeTickets: [], publicRoom: false,
    applications: [], archiveOutbox: [failing, healthy], interruptedUntil: 0, running: false, sessions: [], deadlines: [], room: null };
  await world.room('WXYZ', 'put', { key: 'snapshot-0', value: JSON.stringify(snapshot) });
  await world.room('WXYZ', 'put', { key: 'snapshot-meta', value: { parts: 1 } });
  await world.restart();

  const failures = async () => (await world.room('WXYZ', 'logs')).filter((line) => line.event === 'archive_publish_failed');
  let outbox = [];
  for (let i = 0; i < 100; i++) {
    outbox = await world.room('WXYZ', 'sql', { query: 'SELECT match_id, attempts, retry_at FROM archive_outbox' });
    if (outbox.length === 1 && outbox[0].attempts === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The later match was published; the failing one waits for its retry, logged once with its context.
  assert.deepEqual(outbox.map((row) => [row.match_id, row.attempts]), [['stuck:1', 1]]);
  assert.ok((await world.api('a', '/api/me/matches')).body.items.some((item) => item.matchId === 'stuck:2'));
  const [line, ...more] = await failures();
  assert.deepEqual(more, []);
  assert.deepEqual({ level: line.level, room: line.room, matchId: line.matchId, attempts: line.attempts, code: line.error.code },
    { level: 'error', room: 'WXYZ', matchId: 'stuck:1', attempts: 1, code: 'HISTORY_CONFLICT' });
  const retryAt = outbox[0].retry_at;
  assert.ok(retryAt - Date.now() > 20_000 && retryAt - Date.now() <= 30_000, 'first retry after 30 s');
  // Events in the meantime (here: status requests) do not retry it; the alarm is set for the retry.
  for (let i = 0; i < 3; i++) assert.equal((await world.api('a', '/api/rooms/WXYZ')).status, 404);
  assert.equal((await failures()).length, 1);
  assert.equal(await world.room('WXYZ', 'alarm'), retryAt);
});
