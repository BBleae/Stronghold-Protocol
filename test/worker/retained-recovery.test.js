import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { bundleWorker, ROOT } from '../../tools/build-worker.mjs';

// A retained recovery engine is an archived esbuild bundle whose minified names may contain `$`: a rules version's
// recovery.mjs ends in `export{YM as create,$M as restore}`, and every later build must still wrap it.
test('a retained recovery engine whose minified export names contain $ is wrapped and restores lazily', async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'sp-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = '33333333333333333333';
  const file = path.join(dir, 'recovery.mjs');
  await fs.writeFile(file, 'var Y$=()=>null;function $M(c,{referenceEvents:e=!1}={}){return{c,e}}'
    + 'export{Y$ as create,$M as restore};\n');
  const entry = path.join(dir, 'fixture.js');
  const versions = JSON.stringify(path.join(ROOT, 'worker/match-versions.js'));
  await fs.writeFile(entry, `export {retainedMatchVersions,prepareMatchVersion} from ${versions};`);
  const outfile = path.join(dir, 'release.mjs');
  await bundleWorker({ entry: path.relative(ROOT, entry), outfile, versionModules: [{ id, file }] });
  const release = await import(pathToFileURL(outfile));
  assert.throws(() => release.retainedMatchVersions[id]('checkpoint'), /not prepared/);
  await release.prepareMatchVersion(id);
  // the build turned its referenceEvents default on: no clone of the event history
  assert.deepEqual(release.retainedMatchVersions[id]('checkpoint'), { c: 'checkpoint', e: true });
});
