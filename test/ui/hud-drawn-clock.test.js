// Wiring guards of the drawn-clock HUD (review point 7): MatchScreen cannot be mounted in Node, so these read the source
// of screens/game.js for the decisions that make the own field's values follow the picture — and for what must NOT:
// the server-clock values (teammates' rows, team LP, boss pool, settlement) are relayed by the original as well and stay
// undelayed. The behaviour itself is tested on the pure parts: gameLogic.test.js (queue, setPaused, gates) and
// test/match/runner-ui-clock.test.js (a real battle through the queue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
const lines = src.split('\n');
const code = lines.filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('the queue is fed by the snapshot (kills, DP, boss, unit HP) and the runner state — nothing else', () => {
  assert.equal([...code.matchAll(/hudDelay\.(push|pushBattle)\(/g)].length, 2);
  assert.match(code, /hudDelay\.push\(cur, snapHud\(snap\), lagMs\(\), Array\.isArray\(snap\.units\) \? \{ units: snapUnits\(snap\) \} : null\)/);
  assert.match(code, /battleRunner\.on\('state', onState\)/, 'subscribed to the runner\'s state');
  assert.match(code, /const b = pickDrawn\(s\);\s*if \(b && b\.fieldId === lastFieldRef\.current\) hudDelay\.pushBattle\(b\.fieldId, b, lagMs\(\)\)/, 'null / a field not entered yet is ignored');
  assert.match(code, /onUnits: \(u\) => \{ snapUnitsRef\.current = u; \}/, 'the unit card\'s HP is released with the frame, not at arrival');
  assert.doesNotMatch(code, /snapUnitsRef\.current = (mp|snapUnits\(snap\))/, 'never set at arrival');
});

test('the capsule\'s kills and every battle-slice change skip the 5 Hz throttle; DP alone keeps it', () => {
  assert.match(code, /if \(hudChanged\(prev, h\) \|\| dt >= HUD_HZ_MS\) flush\(\);/);
  assert.match(code, /onBattle: \(b\) => \{[^}]*drawnChanged\(drawnRef\.current, b\)[^}]*setDrawn\(b\);\s*flush\(\);/s);
});

test('entering a field: the entry frame is drawn at once — the slice is seeded from state(), the queue restarts', () => {
  assert.match(code, /hudDelayRef\.current\?\.clear\(\);/);
  assert.match(code, /const seed = pickDrawn\(battleRunner \? battleRunner\.state\(\) : null\);\s*drawnRef\.current = seed && seed\.fieldId === field\.fieldId \? seed : null;/);
  assert.match(code, /snapUnitsRef\.current = snapUnits\(earlySnap\)/);
});

test('solo pause: the queue stands still with the frozen picture, in its own small effect', () => {
  assert.match(code, /useEffect\(\(\) => \{ hudDelayRef\.current\?\.setPaused\(paused\); \}, \[view, paused\]\);/);
});

test('own-field values read the drawn slice; the pill and 前往查看 follow the picture, the pause gate the sim, the server joins afterwards', () => {
  assert.match(code, /const drawnBattle = drawnOf\(battleState, drawn\);/);
  assert.match(code, /const gate = ownFieldGate\(cc \? battleState : null, drawn, ownFieldId\(myId\)\);/);
  assert.match(code, /drawnBattle\.leaks\[ownFieldId\(myId\)\]/, 'LP −N');
  assert.match(code, /drawnBattle\.uniteLeft/, '联防 ×N, also the teammates\' leaker rows (uniteLocal)');
  assert.match(code, /bondLayers: drawnBattle\?\.bondLayers/);
  assert.match(code, /const liveLayers = \(combat \|\| settleMode\) && drawnBattle\?\.bondLayers/);
  assert.match(code, /ownLeaks\(localLeaks, gate\.serverOk \? meP\?\.pendingLp : undefined\)/);
  assert.match(code, /uniteRemaining\(localLeft, gate\.serverOk \? meP\?\.uniteLeft : undefined\)/);
  assert.match(code, /const myDone = combat && \(cc \? phase === PHASE\.COMBAT && \(gate\.onScreen \? gate\.drawnDone : meP\?\.status === 'done'\) : meP\?\.status === 'done'\);/);
  assert.match(code, /const canPause = pauseAvailable\(pub, \{ solo, alive, done: meP\?\.status === 'done' \|\| gate\.simDone \}\);/, 'pause stays on the sim');
  const observes = [...code.matchAll(/observeTarget\([^)]*\)/g)].map((m) => m[0]);
  assert.equal(observes.length, 2);
  assert.ok(observes.every((o) => /ownHeld/.test(o) && /ownDone: (gate|L)\.drawnDone/.test(o)), 'both 前往查看 gates follow the pill');
});

test('server clock, by design: teammates\' rows, team LP, the boss pool and settlement never read the drawn slice or the queue', () => {
  for (const l of lines) {
    if (/^\s*\/\//.test(l)) continue;
    if (/teammateProgress\(|pub\??\.teamLp|pub\??\.bossHp|bossHp|teamLp|pendingLp\s*[,)]/i.test(l) && !/gate\.serverOk|ownLeaks\(localLeaks/.test(l)) {
      assert.doesNotMatch(l, /drawn|hudDelay|gate\./, `server-clock value on the drawn clock: ${l.trim()}`);
    }
  }
  // the components that show them take m.public as it comes: no queue, no drawn slice inside
  for (const f of ['ui/teamPanel.js', 'ui/combatHud.js', 'ui/hud.js', 'ui/topBar.js']) {
    let body = '';
    try { body = readFileSync(path.join(ROOT, 'public/js', f), 'utf8'); } catch { continue; }
    assert.doesNotMatch(body, /createHudDelay|hudDelay|drawnOf|pickDrawn|ownFieldGate/, `${f} reads the server's values directly`);
  }
  // the teammates' rows get the drawn 联防 replica count only (the player's own screen shows that field), like before
  assert.match(code, /<\$\{TeamPanel\} pub=\$\{pub\} myId=\$\{myId\}[^\n]*uniteLocal=\$\{uniteLocal\}/);
  assert.match(code, /const progress = cc && phase === PHASE\.COMBAT \? teammateProgress\(pub, myId\) : null;/);
});
