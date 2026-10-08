import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';

const source = `
export { SiteDirectory as TestObject } from './worker/accounts/directory.js';
import { AccountDurableObject as Account } from './worker/accounts/account.js';
// storage as an older build left it (a test-only write that skips the validation)
export class AccountDurableObject extends Account {
  async seedStored(value) { await this.ctx.storage.put('preferences', value); }
  async readStored() { return (await this.ctx.storage.get('preferences')) ?? null; }
}
import { handleAccountRoutes } from './worker/accounts/routes.js';
import { hash } from './worker/accounts/auth.js';
import { errorResponse } from './worker/http.js';
export default {async fetch(req,env) {
  const input=await req.json(), actor=input.actor || 'a';
  if(input.seed) {
    await env.TEST.get(env.TEST.idFromName('directory')).saveSession(await hash(actor.repeat(64)),
      {accountId:actor,expiresAt:Date.now()+600000});
    return Response.json({ok:true});
  }
  if(input.stored) {
    await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(actor)).seedStored(input.stored);
    return Response.json({ok:true});
  }
  if(input.readStored) return Response.json(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(actor)).readStored());
  env.SITES=env.TEST;
  // As the Worker answers it: an error ends in its route wrapper (worker/index.js, worker/http.js errorResponse).
  try {
    return await handleAccountRoutes(new Request('https://game.example/api/me/preferences',{
      method:input.method || 'GET',headers:{Origin:'https://game.example',
        cookie:'__Host-sp_session='+actor.repeat(64),...input.headers},
      body:input.raw ?? (input.body ? JSON.stringify(input.body) : undefined)}),env)
      || new Response('missing preferences endpoint',{status:404});
  } catch (error) { return errorResponse(error, {}); }
}};`;

const choices = {
  loadout: { v: 1, entries: { chess_test: { skill: 0, module: 'none' } } },
  // the 自选编队 picks and the 干员持有 list follow the account like the loadout (DESIGN §F3: they replaced the 外援 picks)
  diy: { v: 1, picks: { chess_char_5_diy1_a: { charId: 'char_112_siege' }, chess_char_6_diy1_a: { charId: 'char_003_kalts', skillIndex: 2, uniEquipId: null } } },
  ownership: { v: 1, notOwned: ['chess_char_3_01_a', 'chess_char_3_05_a'] },
  'lobby.mode': 'solo',
  'lobby.difficulty': 'HARD',
  recentRooms: ['ABCD', 'EFGH'],
  emoteTheme: 'emoticon_originium_slug',
};

test(
  'account preferences survive restart, merge fields, and stay isolated between accounts',
  { timeout: 60000 },
  async (t) => {
    const h = await createAccountHarness(source, {
      durableObjects: { ACCOUNTS: { className: 'AccountDurableObject', useSQLite: true } },
    });
    t.after(() => h.dispose());
    await h.fetch({ seed: true });
    await h.fetch({ seed: true, actor: 'b' });
    assert.deepEqual(await (await h.fetch({})).json(), { accountId: 'a', preferences: null });
    const write = (body) => h.fetch({ method: 'POST', body: { accountId: 'a', ...body } });
    assert.equal((await write({ patch: choices, initialize: true })).status, 200);
    // A second device migrating old local values cannot replace an existing cloud profile.
    await write({ patch: { 'lobby.mode': 'coop' }, initialize: true });
    await Promise.all([
      write({ patch: { 'lobby.difficulty': 'ABYSS' } }),
      write({ patch: { emoteTheme: 'emoticon_foolsday_amiya' } }),
    ]);
    await h.restart();
    assert.deepEqual((await (await h.fetch({})).json()).preferences, {
      ...choices,
      'lobby.difficulty': 'ABYSS',
      emoteTheme: 'emoticon_foolsday_amiya',
    });
    assert.equal((await (await h.fetch({ actor: 'b' })).json()).preferences, null);
    await write({ patch: { loadout: { v: 1, entries: {} }, recentRooms: [] } });
    assert.deepEqual((await (await h.fetch({})).json()).preferences.loadout, { v: 1, entries: {} });
    // clearing every 自选 slot / every 未持有 mark is a value of its own (the room is then told to forget them)
    await write({ patch: { diy: { v: 1, picks: {} }, ownership: { v: 1, notOwned: [] } } });
    const cleared = (await (await h.fetch({})).json()).preferences;
    assert.deepEqual([cleared.diy, cleared.ownership], [{ v: 1, picks: {} }, { v: 1, notOwned: [] }]);
    assert.equal(
      (await write({ patch: { recentRooms: ['A1B2'] } })).status,
      200,
      'keep room codes accepted by the lobby',
    );
  },
);

test(
  'preferences require the current account, origin, bounded body, and valid allowlisted values',
  { timeout: 60000 },
  async (t) => {
    const h = await createAccountHarness(source, {
      durableObjects: { ACCOUNTS: { className: 'AccountDurableObject', useSQLite: true } },
    });
    t.after(() => h.dispose());
    await h.fetch({ seed: true });
    const post = (body, headers = {}) => h.fetch({ method: 'POST', body, headers });
    assert.equal((await h.fetch({ actor: 'c' })).status, 401);
    assert.equal((await post({ accountId: 'a', patch: {} }, { Origin: 'https://elsewhere.example' })).status, 403);
    assert.equal((await post({ accountId: 'b', patch: { 'lobby.mode': 'solo' } })).status, 409);
    assert.equal((await h.fetch({ method: 'DELETE' })).status, 405);
    for (const patch of [
      { settings: { muted: true } },
      { 'lobby.mode': 'unknown' },
      { 'lobby.difficulty': 'IMPOSSIBLE' },
      { recentRooms: ['ABCD', 'ABCD'] },
      { recentRooms: ['ABCD', 'EFGH', 'JKLM', 'NPQR', 'STUV'] },
      { emoteTheme: 'unknown' },
      { loadout: { v: 1, entries: { chess_test: { skill: 99 } } } },
      { loadout: { v: 2, entries: {} } },
      // the retired 外援 key is no preference any more
      { waiguan: { v: 1, picks: {} } },
      { diy: { v: 1, picks: { chess_char_5_diy1_a: 'char_003_kalts' } } },
      { diy: { v: 1, picks: { chess_char_5_diy1_a: { charId: 'not an id' } } } },
      { diy: { v: 1, picks: { chess_char_5_diy1_a: { charId: 'char_003_kalts', skillIndex: 12 } } } },
      { diy: { v: 1, picks: { chess_char_5_diy1_a: { charId: 'char_003_kalts', note: 'x' } } } },
      { diy: { v: 1, picks: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`slot_${i}`, null])) } },
      { diy: { v: 2, picks: {} } },
      { diy: { v: 1, picks: {}, extra: 1 } },
      { diy: { chess_char_5_diy1_a: { charId: 'char_003_kalts' } } },
      JSON.parse('{"diy":{"v":1,"picks":{"__proto__":{"charId":"char_003_kalts"}}}}'),
      { ownership: ['chess_char_3_05_a'] },
      { ownership: { v: 1, notOwned: ['chess_char_3_05_a', 'chess_char_3_05_a'] } },
      { ownership: { v: 1, notOwned: ['__proto__'] } },
      JSON.parse('{"__proto__":{}}'),
    ]) {
      assert.equal((await post({ accountId: 'a', patch })).status, 400, JSON.stringify(patch));
    }
    assert.equal((await h.fetch({ method: 'POST', raw: '{' })).status, 400);
    assert.equal((await h.fetch({ method: 'POST', raw: ' '.repeat(65537) })).status, 413);
    assert.equal((await (await h.fetch({})).json()).preferences, null, 'invalid writes leave storage unchanged');
  },
);

test(
  'a stored preference that was retired (the 外援 picks) is left out of reads and dropped by the next save',
  { timeout: 60000 },
  async (t) => {
    const h = await createAccountHarness(source, {
      durableObjects: { ACCOUNTS: { className: 'AccountDurableObject', useSQLite: true } },
    });
    t.after(() => h.dispose());
    await h.fetch({ seed: true });
    // an account saved before 自选编队 replaced 外援 / 甄选 (DESIGN §F3)
    await h.fetch({ stored: { loadout: choices.loadout, 'lobby.mode': 'coop', waiguan: { v: 1, picks: { t5a: 'char_1028_texas2' } } } });
    const read = async () => (await (await h.fetch({})).json()).preferences;
    const stored = async () => (await h.fetch({ readStored: true })).json();
    assert.deepEqual(await read(), { loadout: choices.loadout, 'lobby.mode': 'coop' });
    assert.ok('waiguan' in await stored(), 'a read writes nothing');
    // a first-login migration of another device still finds the existing profile (without the retired key)
    const init = await h.fetch({ method: 'POST', body: { accountId: 'a', patch: { 'lobby.mode': 'solo' }, initialize: true } });
    assert.deepEqual((await init.json()).preferences, { loadout: choices.loadout, 'lobby.mode': 'coop' });
    const saved = await h.fetch({ method: 'POST', body: { accountId: 'a', patch: { diy: choices.diy } } });
    assert.deepEqual((await saved.json()).preferences, { loadout: choices.loadout, 'lobby.mode': 'coop', diy: choices.diy });
    await h.restart();
    assert.deepEqual(await stored(), { loadout: choices.loadout, 'lobby.mode': 'coop', diy: choices.diy }, 'the save dropped it');
  },
);
