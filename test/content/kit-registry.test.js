// The Worker bundle (tools/build-worker.mjs) replaces server/sim/content/index.js's guarded dynamic imports with literal
// ones from a list of its own: every module the loader imports must be on that list, or the Worker silently runs without
// it (a forgotten entry falls back to generic kits there while Node and the browser have the real ones).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('every safeImport of the content loader is in the Worker build list', () => {
  const loader = readFileSync(new URL('../../server/sim/content/index.js', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../../tools/build-worker.mjs', import.meta.url), 'utf8');
  const literal = [...loader.matchAll(/safeImport\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(literal.includes('./kits/waiguan/index.js'));
  for (const p of literal) assert.ok(build.includes(`'${p}'`), `${p} missing from tools/build-worker.mjs contentImports`);
  // the templated imports (tiers, domains) are listed through the same arrays in both files
  assert.match(build, /\.\.\.\[1, 2, 3, 4, 5, 6\]\.map\(t => `\.\/kits\/tier\$\{t\}\.js`\)/);
});
