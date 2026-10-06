// 联防 with several fields in the browser (more than 4 alive, a remake extension — owner decision 3; server side in
// test/match/unite-large.test.js): a helper plays and reports its own field, a leaker is shown the field holding its
// enemies (its team row leads there, 返回战场 goes back to it), everyone else may switch between the 联防 fields — the
// client-side combat HUD's ‹ 联防阵地 N ›, the legacy server-run switcher's numbered labels —, a leaker's ×N / pending LP
// comes from the replica on screen only when that replica is the leaker's own field, the phase banner names each field's
// helpers, and a reload while watching another 联防 field takes that watch back. Pure helpers (battle/observe.js,
// ui/gameLogic.js, ui/teamPanel.js, ui/combatHud.js) and the browser runner on real 联防 specs from a real 8-player
// match. With one 联防 field (1–4 alive) every helper answers exactly as before — pinned here next to each rule.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE } from '../../shared/constants.js';
import { validateC2S, RESULT_LIMITS } from '../../shared/protocol.js';
import {
  multiUnite, uniteFields, uniteFieldOf, uniteHomeField, uniteFieldNo, uniteLocalFor, uniteSwitchFields, backTarget,
  observeTarget, resumedWatch,
} from '../../public/js/battle/observe.js';
import { fieldLabel, switcherLabel, phaseBanner, watchTarget, homeFieldId, cycleField } from '../../public/js/ui/gameLogic.js';
import { rowLp } from '../../public/js/ui/teamPanel.js';
import { CombatHud, UniteFieldSwitch } from '../../public/js/ui/combatHud.js';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createReplayRunner } from '../../public/js/battle/replay-runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { Battle } from '../../server/sim/Battle.js';
import { uniteGroups } from '../../server/match/unite.js';
import { DATA, makeMatch } from '../match/harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);
const textOf = (v) => {
  if (v == null || typeof v === 'boolean') return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(textOf).join('');
  return typeof v === 'object' ? textOf(v.props?.children) : '';
};

// ---- an 8-player 联防 with two fields (the shape of server/match/Match.js publicView, test/match/unite-large.test.js) ----
// helpers: u = [h1, h2] (h1 on the right half), u2 = [h3, h4]; leakers l5, l8 on u, l6, l7 on u2
const P = (id, seat, extra = {}) => ({ playerId: id, seat, name: id.toUpperCase(), alive: true, lp: 30, fieldId: null, ...extra });
function pub8({ uLive = true, u2Live = true, mode = 'client', players = null } = {}) {
  return {
    phase: PHASE.UNITE, combatMode: mode, round: 6,
    players: players || [
      P('h1', 0, { fieldId: 'u', status: 'helping' }), P('h2', 1, { fieldId: 'u', status: 'helping' }),
      P('h3', 2, { fieldId: 'u2', status: 'helping' }), P('h4', 3, { fieldId: 'u2', status: 'helping' }),
      P('l5', 4, { status: 'done', uniteLeft: 6, pendingLp: 6 }), P('l6', 5, { status: 'done', uniteLeft: 13, pendingLp: 10 }),
      P('l7', 6, { status: 'done', uniteLeft: 2, pendingLp: 2 }), P('l8', 7, { status: 'done', uniteLeft: 3, pendingLp: 3 }),
    ],
    fields: [
      { fieldId: 'u', kind: 'unite', players: ['h1', 'h2'], live: uLive },
      { fieldId: 'u2', kind: 'unite', players: ['h3', 'h4'], live: u2Live },
    ],
    unite: {
      helpers: ['h1', 'h2', 'h3', 'h4'], leakers: ['l5', 'l6', 'l7', 'l8'],
      fields: [{ fieldId: 'u', helpers: ['h1', 'h2'], leakers: ['l5', 'l8'] }, { fieldId: 'u2', helpers: ['h3', 'h4'], leakers: ['l6', 'l7'] }],
    },
  };
}
// the official one-field 联防 (1–4 alive): no unite.fields
function pub4({ live = true, mode = 'client' } = {}) {
  return {
    phase: PHASE.UNITE, combatMode: mode, round: 6,
    players: [P('a', 0, { fieldId: 'u', status: 'helping' }), P('b', 1, { fieldId: 'u', status: 'helping' }), P('c', 2, { status: 'done', uniteLeft: 5 }), P('d', 3, { status: 'done', uniteLeft: 1 })],
    fields: [{ fieldId: 'u', kind: 'unite', players: ['a', 'b'], live }],
    unite: { helpers: ['a', 'b'], leakers: ['c', 'd'] },
  };
}
const row = (pub, id) => pub.players.find((p) => p.playerId === id);

describe('the 联防 fields of the view (battle/observe.js)', () => {
  test('several fields: m.public.unite.fields in field order; a helper\'s / leaker\'s field; the default field; numbers', () => {
    const v = pub8();
    assert.equal(multiUnite(v), true);
    assert.deepEqual(uniteFields(v).map((f) => [f.fieldId, f.helpers, f.leakers]), [['u', ['h1', 'h2'], ['l5', 'l8']], ['u2', ['h3', 'h4'], ['l6', 'l7']]]);
    assert.deepEqual(['h1', 'h3', 'l5', 'l6', 'l7', 'l8', 'zz'].map((id) => uniteFieldOf(v, id)), ['u', 'u2', 'u', 'u2', 'u2', 'u', null]);
    assert.deepEqual(['h4', 'l6', 'zz'].map((id) => uniteHomeField(v, id)), ['u2', 'u2', 'u'], 'anyone else: the first field (Match._uniteHomeField)');
    assert.deepEqual(['u', 'u2', 'n:h1'].map((f) => uniteFieldNo(v, f)), [1, 2, 0]);
  });

  test('one field (1–4 alive): the field m.public.fields lists with the union; no numbers; nothing outside 联防', () => {
    const v = pub4();
    assert.equal(multiUnite(v), false);
    assert.deepEqual(uniteFields(v), [{ fieldId: 'u', helpers: ['a', 'b'], leakers: ['c', 'd'] }]);
    assert.equal(uniteFieldOf(v, 'c'), 'u');
    assert.equal(uniteFieldNo(v, 'u'), 0, 'the single field keeps its label');
    assert.deepEqual(uniteFields({ phase: PHASE.COMBAT, fields: [] }), []);
    assert.equal(uniteHomeField({ phase: PHASE.COMBAT }, 'a'), null);
    // a one-entry fields list (never sent, but harmless) is one field too
    assert.equal(multiUnite({ ...v, unite: { ...v.unite, fields: [{ fieldId: 'u', helpers: ['a', 'b'], leakers: ['c', 'd'] }] } }), false);
  });
});

describe('who may look where (observeTarget — the mirror of Match._watchClient)', () => {
  test('a helper stays on its own field while it runs; afterwards it may look at the other one', () => {
    assert.match(observeTarget(row(pub8(), 'h3'), pub8(), 'h1').reason, /联防作战中无法查看其他联防阵地/);
    assert.match(observeTarget(row(pub8(), 'h2'), pub8(), 'h1').reason, /同一战场/, 'the partner: the ‹ › halves, as before');
    assert.deepEqual(observeTarget(row(pub8(), 'h3'), pub8({ uLive: false }), 'h1'), { fieldId: 'u2' }, 'its own field ended');
  });

  test('a leaker\'s row leads to the field holding its enemies (one field: no field, as before)', () => {
    const v = pub8();
    assert.deepEqual(observeTarget(row(v, 'l6'), v, 'l5'), { fieldId: 'u2' }, 'a leaker looks at another leaker\'s field');
    assert.deepEqual(observeTarget(row(v, 'h4'), v, 'l5'), { fieldId: 'u2' }, 'or a helper\'s');
    assert.deepEqual(observeTarget(row(v, 'l8'), v, 'h3', {}), { reason: '联防作战中无法查看其他联防阵地，作战结束后可前往查看' }, 'a helper of u2 cannot look at u');
    assert.match(observeTarget(row(v, 'l8'), v, 'h1').reason, /漏过的敌人就在你的联防阵地上/, 'a leaker of the helper\'s own field');
    const dead = pub8({ players: pub8().players.map((p) => (p.playerId === 'h1' ? { ...p, alive: false } : p)) });
    assert.deepEqual(observeTarget(row(dead, 'l6'), dead, 'h1'), { fieldId: 'u2' }, 'an eliminated player: anything');
    assert.match(observeTarget(row(v, 'l5'), v, 'l5').reason ?? '', /^$/, 'the own row');
    // one field: unchanged
    const one = pub4();
    assert.match(observeTarget(row(one, 'd'), one, 'c').reason, /该队友当前没有战场/);
    assert.deepEqual(observeTarget(row(one, 'b'), one, 'c'), { fieldId: 'u' });
    assert.match(observeTarget(row(one, 'b'), one, 'a').reason, /同一战场/);
  });

  test('the server-run legacy team row (watchTarget): a leaker\'s field with several fields, its own board id with one', () => {
    const v = pub8({ mode: 'server' });
    assert.deepEqual(watchTarget(row(v, 'l7'), v, 'h1'), { fieldId: 'u2' });
    assert.deepEqual(watchTarget(row(v, 'h3'), v, 'h1'), { fieldId: 'u2' });
    const one = pub4({ mode: 'server' });
    assert.deepEqual(watchTarget(row(one, 'c'), one, 'a'), { fieldId: 'n:c' }, 'one field: as before');
  });
});

describe('switching between the 联防 fields', () => {
  test('uniteSwitchFields: leakers, eliminated players and spectators may; a helper only once its own field ended; never with one field', () => {
    assert.deepEqual(uniteSwitchFields(pub8(), 'l5'), ['u', 'u2']);
    assert.deepEqual(uniteSwitchFields(pub8(), 'zz', { alive: false }), ['u', 'u2'], 'a spectator');
    assert.deepEqual(uniteSwitchFields(pub8(), 'h1'), [], 'a helper while its field runs');
    assert.deepEqual(uniteSwitchFields(pub8({ uLive: false }), 'h1'), ['u', 'u2'], 'its field ended');
    assert.deepEqual(uniteSwitchFields(pub8(), 'h1', { alive: false }), ['u', 'u2'], 'eliminated');
    assert.deepEqual(uniteSwitchFields(pub4(), 'c'), [], 'one field');
    assert.deepEqual(uniteSwitchFields({ ...pub8(), phase: PHASE.SETTLE }, 'l5'), [], 'outside 联防');
    // a field the view does not list (yet) is not offered
    assert.deepEqual(uniteSwitchFields({ ...pub8(), fields: [pub8().fields[0]] }, 'l5'), []);
  });

  test('返回战场 (backTarget): a leaker goes back to the field holding its enemies, anyone else to the first; one field as before', () => {
    const v = pub8();
    const home = (id) => homeFieldId(v, id);
    assert.equal(home('l6'), 'n:l6', 'a leaker has no field of its own (players[].fieldId null)');
    assert.equal(backTarget(v, 'l6', home('l6'), 'u'), 'u2');
    assert.equal(backTarget(v, 'l6', home('l6'), 'u2'), null, 'already there');
    assert.equal(backTarget(v, 'zz', 'n:zz', 'u2'), 'u', 'not in the 联防: the first field');
    assert.equal(backTarget(pub8({ uLive: false }), 'h1', homeFieldId(pub8({ uLive: false }), 'h1'), 'u2'), 'u', 'a helper: its own field');
    assert.equal(backTarget(pub8({ mode: 'server' }), 'l6', 'n:l6', 'u'), 'u2', 'server-run: the same field');
    // one field: exactly the old rule (client-side combat: only a listed field; server-run: the home id)
    const one = pub4();
    assert.equal(backTarget(one, 'c', homeFieldId(one, 'c'), 'u'), null, 'a leaker keeps the field it shows');
    assert.equal(backTarget(one, 'a', 'u', 'n:x'), 'u');
    assert.equal(backTarget(pub4({ mode: 'server' }), 'c', 'n:c', 'u'), 'n:c');
    assert.equal(backTarget({ phase: PHASE.PREP, combatMode: 'client', fields: [] }, 'a', 'n:a', 'n:b'), 'n:a', 'prep: the own board');
    assert.equal(backTarget({ phase: PHASE.COMBAT, combatMode: 'client', fields: [{ fieldId: 'n:a', kind: 'normal', players: ['a'] }] }, 'a', 'n:a', 'n:b'), 'n:a');
  });

  test('labels: 联防阵地 1 / 2 with several fields, 联防（自己） for a helper\'s own; one field unchanged; the legacy switcher reads them', () => {
    const v = pub8();
    assert.deepEqual(v.fields.map((f) => fieldLabel(f, v, 'l5')), ['联防阵地 1', '联防阵地 2']);
    assert.deepEqual(v.fields.map((f) => fieldLabel(f, v, 'h3')), ['联防阵地 1', '联防（自己）']);
    assert.equal(switcherLabel(v, 'u2', 'l5'), '联防阵地 2');
    assert.equal(fieldLabel(pub4().fields[0], pub4(), 'c'), '联防阵地');
    assert.equal(fieldLabel(pub4().fields[0], pub4(), 'a'), '联防（自己）');
    assert.equal(cycleField(v.fields, 'u', 1), 'u2');
  });

  test('the phase banner names each field\'s helpers; one field as before', () => {
    assert.equal(phaseBanner(PHASE.UNITE, pub8()).sub, '联防：H1、H2 / H3、H4');
    assert.equal(phaseBanner(PHASE.UNITE, pub4()).sub, '联防：A、B');
    assert.equal(phaseBanner(PHASE.UNITE, { ...pub8(), unite: { ...pub8().unite, fields: [{ fieldId: 'u', helpers: ['h1'], leakers: [] }, { fieldId: 'u2', helpers: ['h3'], leakers: ['l5'] }] } }).sub, '联防：H1 / H3');
  });

  test('a reload while watching another 联防 field takes the watch back (resumedWatch); one field: never', () => {
    const v = pub8();
    const b = (fieldId) => ({ battleId: `r6-${fieldId}`, fieldId, kind: 'unite', watch: true, done: false });
    const o = { pub: v, alive: true, watching: null, seen: null };
    assert.deepEqual(resumedWatch(b('u'), { ...o, myId: 'l6' }), { seen: 'r6-u', fieldId: 'u' }, 'a leaker of u2 on u');
    assert.deepEqual(resumedWatch(b('u2'), { ...o, myId: 'l6' }), { seen: 'r6-u2', fieldId: null }, 'its own field');
    assert.deepEqual(resumedWatch(b('u2'), { ...o, myId: 'zz' }), { seen: 'r6-u2', fieldId: 'u2' }, 'anyone else on the second');
    assert.deepEqual(resumedWatch(b('u'), { ...o, myId: 'zz' }), { seen: 'r6-u', fieldId: null });
    assert.deepEqual(resumedWatch(b('u2'), { ...o, pub: pub8({ uLive: false }), myId: 'h1' }), { seen: 'r6-u2', fieldId: 'u2' }, 'a helper after its field');
    assert.deepEqual(resumedWatch(b('u'), { ...o, myId: 'l6', alive: false }), { seen: 'r6-u', fieldId: null }, 'eliminated: its own rules');
    assert.deepEqual(resumedWatch(b('u'), { ...o, myId: 'l6', watching: 'u' }), { seen: 'r6-u', fieldId: null }, 'first seen while watching');
    assert.deepEqual(resumedWatch({ ...b('u'), watch: false }, { ...o, myId: 'h1' }), { seen: 'r6-u', fieldId: null }, 'a helper\'s own field');
    assert.deepEqual(resumedWatch(b('u'), { ...o, pub: pub8({ mode: 'server' }), myId: 'l6' }), { seen: 'r6-u', fieldId: null }, 'server-run combat');
    assert.deepEqual(resumedWatch({ ...b('u'), loading: true }, { ...o, myId: 'l6' }), { seen: null, fieldId: null }, 'loading: undecided');
    assert.deepEqual(resumedWatch(b('u'), { ...o, pub: pub4(), myId: 'c' }), { seen: 'r6-u', fieldId: null }, 'one field: never');
  });
});

describe('a leaker\'s ×N and pending LP per field (uniteLocalFor → rowLp)', () => {
  test('the replica on screen speaks only for the leakers of its own field; the others read m.public', () => {
    const v = pub8();
    const onU2 = { l6: 9 }; // the replica of u2: l7 has no enemy standing any more (absent = none left)
    const lp = (id, local, fid) => rowLp(row(v, id), v, null, { uniteLocal: uniteLocalFor(v, local, fid, id), cap: 10 });
    assert.deepEqual(lp('l6', onU2, 'u2'), { lp: 30, pending: 9, unite: true, left: 9 }, 'on screen, live');
    assert.deepEqual(lp('l7', onU2, 'u2'), { lp: 30, pending: 0, unite: true, left: 0 }, 'absent from its own field\'s replica: all struck down');
    assert.deepEqual(lp('l5', onU2, 'u2'), { lp: 30, pending: 6, unite: true, left: 6 }, 'a leaker of u: the server\'s count, never 0');
    assert.deepEqual(lp('l8', onU2, 'u2'), { lp: 30, pending: 3, unite: true, left: 3 });
    assert.deepEqual(lp('l5', { l5: 4 }, 'u'), { lp: 30, pending: 4, unite: true, left: 4 }, 'u on screen');
    assert.deepEqual(lp('l6', onU2, null), { lp: 30, pending: 10, unite: true, left: 13 }, 'no field id: the server');
    assert.equal(uniteLocalFor(v, null, 'u', 'l5'), null);
    // one field: the whole map, absent = 0 — exactly as before
    const one = pub4();
    assert.equal(uniteLocalFor(one, { c: 2 }, 'u', 'd').c, 2);
    assert.deepEqual(rowLp(row(one, 'd'), one, null, { uniteLocal: uniteLocalFor(one, { c: 2 }, 'u', 'd') }), { lp: 30, pending: 0, unite: true, left: 0 });
    assert.deepEqual(rowLp(row(one, 'd'), one, null, { uniteLocal: uniteLocalFor(one, { c: 2 }, 'x', 'd') }), { lp: 30, pending: 0, unite: true, left: 0 }, 'whatever the field id says');
  });

  test('wiring: the game screen hands the drawn field id with the counts; the team panel filters per row; the own ×N likewise', () => {
    const game = read('public/js/screens/game.js');
    assert.match(game, /const uniteField = uniteLocal \? drawnBattle\.fieldId : null;/);
    assert.match(game, /const ownUniteLocal = uniteLocalFor\(pub, uniteLocal, uniteField, myId\);\s*const localLeft = leaker && ownUniteLocal \? \(ownUniteLocal\[myId\] \?\? 0\) : undefined;/);
    assert.match(game, /<\$\{TeamPanel\}[^\n]*uniteLocal=\$\{uniteLocal\} uniteField=\$\{uniteField\}/);
    const panel = read('public/js/ui/teamPanel.js');
    assert.match(panel, /uniteLocal: uniteShown = null, uniteField = null \}\)/);
    assert.match(panel, /const uniteLocal = uniteLocalFor\(pub, uniteShown, uniteField, p\.playerId\);\s*const lp = rowLp\(p, pub, self \? selfLive : null, \{ uniteLocal, cap \}\);/);
  });
});

describe('‹ 联防阵地 N › (ui/combatHud.js)', () => {
  test('cycles the fields, labels the one on screen, picks through onPick; hidden with fewer than two', () => {
    const v = pub8();
    const picks = [];
    const sw = { list: ['u', 'u2'], current: 'u2', onPick: (f) => picks.push(f) };
    const out = UniteFieldSwitch({ pub: v, myId: 'l5', sw });
    assert.ok(hasClass(out, 'chud__fields') && hasClass(out, 'vswitch'));
    assert.match(textOf(out), /联防阵地 2/);
    const arrows = [...walk(out)].filter((x) => hasClass(x, 'vswitch__arrow'));
    assert.equal(arrows.length, 2);
    arrows[0].props.onClick();
    arrows[1].props.onClick();
    assert.deepEqual(picks, ['u', 'u'], 'two fields: either arrow goes to the other one');
    assert.equal(UniteFieldSwitch({ pub: v, myId: 'l5', sw: { ...sw, list: ['u'] } }), null);
    assert.equal(UniteFieldSwitch({ pub: v, myId: 'l5', sw: null }), null);
    assert.match(textOf(UniteFieldSwitch({ pub: v, myId: 'h3', sw: { ...sw } })), /联防（自己）/);
  });

  test('the client HUD shows it above the ‹ › pill only when handed one (one field: the HUD as before)', () => {
    const layers = [{ key: 'L', label: 'H2', self: false, watch: true }, { key: 'ALL', label: '全景', self: false, watch: false }, { key: 'R', label: 'H1', self: false, watch: true }];
    const base = { observing: null, onBack() {}, layers, layer: 'ALL', onLayer() {} };
    const with2 = CombatHud({ pub: pub8(), myId: 'l5', watching: null, hud: null, myDone: false, client: { ...base, uniteFields: { list: ['u', 'u2'], current: 'u', onPick() {} } } });
    const nodes = [...walk(with2)];
    const swAt = nodes.findIndex((x) => x.type === UniteFieldSwitch);
    const pillAt = nodes.findIndex((x) => hasClass(x, 'chud__layers'));
    assert.ok(swAt >= 0 && pillAt > swAt, 'above the ‹ › pill');
    const without = CombatHud({ pub: pub4(), myId: 'c', watching: null, hud: null, myDone: false, client: { ...base, uniteFields: null } });
    assert.ok(![...walk(without)].some((x) => x.type === UniteFieldSwitch));
    const legacy = CombatHud({ pub: pub4(), myId: 'c', watching: null, hud: null, myDone: false, client: base });
    assert.deepEqual(JSON.stringify([...walk(legacy)].map((x) => x.props?.class || null)), JSON.stringify([...walk(without)].map((x) => x.props?.class || null)));
  });

  test('wiring: offered under client-side combat on a 联防 field; a pick of the default field is 返回战场', () => {
    const game = read('public/js/screens/game.js');
    assert.match(game, /const uniteList = cc && phase === PHASE\.UNITE && field && field\.kind === 'unite' \? uniteSwitchFields\(pub, myId, \{ alive \}\) : \[\];/);
    assert.match(game, /uniteFields: uniteSw \}/);
    assert.match(game, /if \(L\.watching && fid === uniteHomeField\(L\.pub, L\.myId\)\) \{ backHome\(\); return; \}\s*requestWatch\(fid\);/);
    assert.match(game, /const target = backTarget\(L\.pub, L\.myId, L\.home, L\.watching\);\s*if \(target\) actions\.watch\(target\);/);
  });
});

// ---- the browser runner on real 联防 specs of a real 8-player match ---------------------------------------------------

const DS = new DataSource(DATA, null);

/** Real battles whose 联防 helpers strike down a leaked enemy every 3 game seconds (from 2 s on). */
class SlowHelpers extends Battle {
  constructor(opts) {
    super(opts);
    if (this.kind !== 'unite') return;
    let next = 2;
    this.on('tick', () => {
      if (this.time < next) return;
      const e = this.enemies.find((x) => x.alive && x.counted);
      if (!e) return;
      this.kill(e, null);
      next += 3;
    });
  }
}

const slime = (pid, n) => Array.from({ length: n }, () => ({ enemyKey: 'enemy_1007_slime', mods: null, lpr: 1, sourcePlayerId: pid, tag: null, counted: true }));

/**
 * An 8-human client-combat match driven into 联防 with the given leaks per seat (0 = a perfect round): the public
 * view and every player's b.start.
 */
function uniteMatch(leaks, seed = 811) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: leaks.length, seed, captureFrames: false, clientCombat: true, clients: false });
  h.m.start();
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 1, { ready: false });
  const m = h.m;
  m.phase = PHASE.COMBAT;
  m.fields = [];
  m.lastResults = new Map(leaks.map((n, i) => [`p_${i}`, n
    ? { leaked: slime(`p_${i}`, n), perfect: false, coins: 0, layerGains: {}, killed: 0, total: n, unitsEnd: [] }
    : { leaked: [], perfect: true, coins: 0, layerGains: {}, killed: 5, total: 5, unitsEnd: [] }]));
  m._afterCombat();
  assert.equal(m.phase, PHASE.UNITE);
  const out = { view: m.publicView(), starts: new Map(leaks.map((_, i) => [`p_${i}`, h.lastTo(`p_${i}`, 'b.start')])), groups: uniteGroups(m.unitePlan) };
  m.dispose();
  return out;
}

function rig() {
  let t = 1000;
  const frames = [];
  const sent = [];
  const handlers = new Map();
  const net = {
    on(ty, fn) { if (!handlers.has(ty)) handlers.set(ty, new Set()); handlers.get(ty).add(fn); return () => handlers.get(ty).delete(fn); },
    emit(ty, msg) { for (const fn of handlers.get(ty) || []) fn({ t: ty, ...msg }); },
    send(ty, fields) { const msg = { ...fields, t: ty }; assert.equal(validateC2S(msg), null, `invalid ${ty}: ${JSON.stringify(msg).slice(0, 300)}`); sent.push(msg); return true; },
    request(ty, fields) { const msg = { ...fields, t: ty, rid: 1 }; assert.equal(validateC2S(msg), null, `invalid ${ty}`); sent.push(msg); return Promise.resolve({ t: 'ok' }); },
  };
  const store = createStore(initialState);
  const spec = { ...specMod, createBattleFromSpec: (s, ds, o = {}) => specMod.createBattleFromSpec(s, ds, { ...o, BattleClass: SlowHelpers }) };
  const runner = createBattleRunner({
    net, store, doc: { hidden: false, addEventListener() {} }, now: () => t,
    raf: (fn) => { frames.push(fn); return frames.length; }, caf: () => {},
    setInterval: () => 1, clearInterval: () => {},
    loadSim: async () => ({ spec, ds: DS }),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  return {
    runner, net, store, sent,
    advance(ms, step = 1000 / 60) { const end = t + ms; while (t < end) { t = Math.min(end, t + step); for (const fn of frames.splice(0)) fn(t); } },
    async settle() { for (let i = 0; i < 50; i++) { await new Promise((res) => setImmediate(res)); for (const fn of frames.splice(0)) fn(t); } },
  };
}

test('runner, two 联防 fields: each helper runs and reports its own field (`left` = its own leakers); a leaker\'s replica is the field holding its enemies', async () => {
  // p_0..p_3 perfect (u = p_0, p_1; u2 = p_2, p_3); leakers p_4 (6) → u, p_5 (5) → u2, p_6 (4) → u2, p_7 (3) → u
  const { view, starts, groups } = uniteMatch([0, 0, 0, 0, 6, 5, 4, 3]);
  assert.deepEqual(groups.map((g) => [g.fieldId, g.helpers.map((p) => p.playerId), g.leakers.map((p) => p.playerId)]),
    [['u', ['p_0', 'p_1'], ['p_4', 'p_7']], ['u2', ['p_2', 'p_3'], ['p_5', 'p_6']]]);
  // the view the client reads
  assert.equal(multiUnite(view), true);
  assert.deepEqual(uniteFields(view).map((f) => [f.fieldId, f.helpers, f.leakers]), [['u', ['p_0', 'p_1'], ['p_4', 'p_7']], ['u2', ['p_2', 'p_3'], ['p_5', 'p_6']]]);
  assert.deepEqual(['p_0', 'p_2', 'p_4', 'p_5'].map((pid) => fieldLabel(view.fields.find((f) => f.fieldId === uniteHomeField(view, pid)), view, 'p_4')), ['联防阵地 1', '联防阵地 2', '联防阵地 1', '联防阵地 2']);
  // the b.starts: a helper its own field (the lowest-seat connected helper is the authority), a leaker the field holding its enemies
  const at = (pid) => starts.get(pid);
  assert.deepEqual(['p_0', 'p_1', 'p_2', 'p_3', 'p_4', 'p_5', 'p_6', 'p_7'].map((pid) => at(pid).fieldId), ['u', 'u', 'u2', 'u2', 'u', 'u2', 'u2', 'u']);
  assert.deepEqual(['p_0', 'p_1', 'p_2', 'p_3'].map((pid) => !!at(pid).authoritative), [true, false, true, false]);
  assert.ok(['p_4', 'p_5', 'p_6', 'p_7'].every((pid) => at(pid).watch && !at(pid).authoritative));
  assert.ok(at('p_2').battleId.endsWith('.u2'));
  for (const pid of ['p_0', 'p_2', 'p_4', 'p_5']) assert.equal(uniteHomeField(view, pid), at(pid).fieldId, `${pid}: the client\'s default field is the server\'s`);

  // the authority of u2 (p_2): it runs and reports u2 — b.progress `left` only for u2's leakers
  const H = rig();
  H.net.emit('b.start', at('p_2'));
  await H.settle();
  H.advance(12_000);
  const prog = H.sent.filter((x) => x.t === 'b.progress');
  assert.ok(prog.length >= 8, `${prog.length} reports`);
  assert.ok(prog.every((x) => x.battleId === at('p_2').battleId), 'its own field\'s battle');
  assert.deepEqual(Object.keys(prog[0].left).sort(), ['p_5', 'p_6'], 'the first report: both of u2\'s leakers, nobody of u');
  assert.ok(prog.every((x) => Object.keys(x.left).every((k) => k === 'p_5' || k === 'p_6')));
  const s = H.store.get().match.battle;
  assert.equal(s.fieldId, 'u2');
  assert.equal(s.authoritative, true);
  H.runner.dispose();

  // a leaker of u (p_7): its replica is u — its own count and p_4's come from it, u2's leakers from the server
  const L = rig();
  L.net.emit('b.start', at('p_7'));
  await L.settle();
  L.advance(4000);
  const ls = L.store.get().match.battle;
  assert.equal(ls.fieldId, 'u');
  assert.equal(ls.watch, true);
  assert.deepEqual(Object.keys(ls.uniteLeft).sort(), ['p_4', 'p_7']);
  assert.ok(ls.uniteLeft.p_7 > 0 && ls.uniteLeft.p_7 <= 3);
  assert.equal(L.sent.filter((x) => x.t === 'b.progress').length, 0, 'a replica never reports');
  assert.equal(uniteLocalFor(view, ls.uniteLeft, ls.fieldId, 'p_7'), ls.uniteLeft, 'its own ×N: the replica');
  assert.equal(uniteLocalFor(view, ls.uniteLeft, ls.fieldId, 'p_5'), null, 'a leaker of u2: not in this battle');
  const p5 = { ...view.players.find((p) => p.playerId === 'p_5') };
  assert.equal(p5.uniteLeft, 5, 'the server sends each leaker\'s own field count');
  assert.deepEqual(rowLp(p5, view, null, { uniteLocal: uniteLocalFor(view, ls.uniteLeft, ls.fieldId, 'p_5') }).left, 5, 'never read as 0 from the wrong field');
  L.runner.dispose();
});

test('replay: each 联防 field of a round plays back on its own field (u / u2, kind unite) to the live battle\'s end', () => {
  const { starts } = uniteMatch([0, 0, 0, 0, 6, 5, 4, 3]);
  for (const pid of ['p_0', 'p_2']) {
    const st = starts.get(pid);
    const live = specMod.createBattleFromSpec(st.spec, DS);
    while (!live.finished && live.tickCount < 30 * 400) live.step();
    assert.ok(live.finished, `${st.fieldId} ends`);
    // the record server/match/checkpoint.js archives for a client-run field (no tick inputs in a 联防)
    const record = { source: 'client', spec: st.spec, inputs: [], tick: live.tickCount, complete: true, round: 1, players: st.spec.players.map((p) => p.playerId), fieldId: st.fieldId, battleId: st.battleId, kind: 'unite' };
    const metas = [];
    const ids = new Set();
    let battle = null;
    const replay = createReplayRunner({
      engine: { createBattle: (spec) => (battle = specMod.createBattleFromSpec(spec, DS)) },
      onField: (meta) => metas.push(meta),
      onFrame: (f) => { ids.add(f.snapshot.fieldId); ids.add(f.events.fieldId); },
    });
    replay.select(record);
    replay.play();
    for (let i = 0; i < 4000 && replay.state().playing; i++) replay.advance(0.5);
    assert.deepEqual(metas.map((m) => [m.fieldId, m.kind]), [[st.fieldId, 'unite']]);
    assert.deepEqual([...ids], [st.fieldId], 'every frame is that field\'s');
    assert.equal(battle.tickCount, live.tickCount);
    assert.deepEqual(battle.snapshot(), live.snapshot());
    replay.dispose();
  }
});

test('runner, 8 alive and one perfect player: one field holding 7 leakers — every `left` report keeps all 7 and validates', async () => {
  const { view, starts } = uniteMatch([0, 2, 2, 2, 2, 2, 2, 2], 812);
  assert.equal(multiUnite(view), false, 'one helper: one field, no unite.fields');
  assert.equal(view.unite.leakers.length, 7);
  assert.ok(RESULT_LIMITS.players >= 7);
  const H = rig();
  H.net.emit('b.start', starts.get('p_0'));
  await H.settle();
  H.advance(6000);
  const prog = H.sent.filter((x) => x.t === 'b.progress');
  assert.ok(prog.length >= 3);
  assert.equal(Object.keys(prog[0].left).length, 7, 'no leaker cut from the report');
  H.runner.dispose();
});
