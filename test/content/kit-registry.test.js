// The Worker bundle (tools/build-worker.mjs) replaces the content loaders' guarded dynamic imports with literal ones from
// lists of its own: every module a loader imports must be on that list, or the Worker silently runs without it (a
// forgotten entry falls back to generic kits there while Node and the browser have the real ones). Two loaders import
// by path: server/sim/content/index.js (the kit registry and the domain modules, `safeImport(...)`) and
// server/sim/content/kits/index.js (one file per kit, `import(`./ops/${file}`)` over KIT_FILES / STANDIN_KIT_FILES /
// OPERATOR_KIT_FILES, upstream 0.2.0's split of the former kits/tier1…6.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('every safeImport of the content loader is in the Worker build list', () => {
  const loader = read('../../server/sim/content/index.js');
  const build = read('../../tools/build-worker.mjs');
  const literal = [...loader.matchAll(/safeImport\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(literal.includes('./kits/index.js'), 'the kit registry is loaded through kits/index.js');
  for (const p of literal) assert.ok(build.includes(`'${p}'`), `${p} missing from tools/build-worker.mjs contentImports`);
  // the templated imports (domains) are listed through the same array in both files
  const domains = /const DOMAIN_NAMES = (\[[^\]]+\])/.exec(loader);
  assert.ok(domains, 'content/index.js DOMAIN_NAMES');
  assert.ok(build.includes(`...${domains[1]}.map(`), 'tools/build-worker.mjs lists the domains of content/index.js DOMAIN_NAMES');
});

test('every kit file of kits/index.js is in the Worker build list', () => {
  const kits = read('../../server/sim/content/kits/index.js');
  const build = read('../../tools/build-worker.mjs');
  assert.match(kits, /import\(`\.\/ops\/\$\{file\}`\)/, 'kits/index.js loads ./ops/<file>');
  // the build enumerates the same three lists (imported from kits/index.js, never copied by hand)
  for (const name of ['KIT_FILES', 'STANDIN_KIT_FILES', 'OPERATOR_KIT_FILES']) {
    assert.match(kits, new RegExp(`export const ${name} = `), `kits/index.js exports ${name}`);
    assert.ok(build.includes(name), `tools/build-worker.mjs enumerates kits/index.js ${name}`);
  }
});
