// tools/build-replay.mjs — rules versions: the identity of the code that runs a match (docs/ACCOUNTS-HISTORY.md).
//
// A rules version is CONTENT-ADDRESSED. Its id is the hash of the two engine bundles built from the current sources
// with a placeholder id: the browser replay engine (worker/replay-engine.js) and the server recovery engine
// (worker/recovery-engine.js). Only what the engines contain decides the id, so docs, the Worker's HTTP code, build
// plumbing or a machine's git-ignored files never mint a version, and the same sources give the same id on every
// machine. esbuild is pinned exactly in package.json: another esbuild may emit other bytes, i.e. another version.
//
// replay-versions.json lists every version a deployment ran, oldest first, with the sha256 of its archived bundles
// (replay-versions/<id>.json.gz, committed, never changed). The browser replays an old match with that match's own
// engine, so every archived replay engine is published forever (static assets: cheap). The Worker script embeds the
// server recovery engines of only the RECOVERY_RETAINED newest older versions: a live match restores with its own
// rules after a deploy; an older one ends as interrupted (worker/room-runtime.js).
//
// Minting is explicit. `npm run deploy:worker` runs `node tools/build-replay.mjs --release` first: from a clean tree it
// archives a new current version (then commit it and deploy again) or confirms the current one is archived. Other
// builds (`wrangler dev`, tests) never touch the committed files, and a CI build (Workers Builds) refuses a current
// version that is not archived, so production only ever runs committed versions.

import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The id the engines are built with before their real id is known (20 characters, like a real id). */
export const PLACEHOLDER = '__sp_rules_version__';
/** Older versions whose server recovery engine the Worker keeps, besides the current one. */
export const RECOVERY_RETAINED = 3;
/** The two bundles of a version: archive member → entry module. */
export const ENGINES = Object.freeze({ 'engine.js': 'worker/replay-engine.js', 'recovery.mjs': 'worker/recovery-engine.js' });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Workers Builds and other CI: nobody commits what such a build would mint. */
export const isCI = (env = process.env) => !!(env.WORKERS_CI || env.CI);

export async function readManifest(root = ROOT) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, 'replay-versions.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { formatVersion: 1, entries: [] };
    throw error;
  }
}

/** Unpack every archived version into .replay-engines/<id>/ after checking its committed hashes. */
async function unpackArchives(root, manifest) {
  for (const entry of manifest.entries) {
    const archive = JSON.parse(gunzipSync(await fs.readFile(path.join(root, 'replay-versions', entry.id + '.json.gz'))));
    const dir = path.join(root, '.replay-engines', entry.id);
    await fs.mkdir(dir, { recursive: true });
    for (const name of Object.keys(ENGINES)) {
      if (typeof archive[name] !== 'string') throw new Error(`Rules version ${entry.id}: archive lacks ${name}`);
      const bytes = Buffer.from(archive[name]);
      if (sha256(bytes) !== entry.hashes[name]) throw new Error(`Rules version ${entry.id}: archived ${name} does not match its committed hash`);
      await fs.writeFile(path.join(dir, name), bytes);
    }
  }
}

/**
 * Build the engines of the current sources and derive their id: { id, files: { name → bytes with the real id } }.
 * `bundle` is tools/build-worker.mjs bundleWorker (injected: tests use a stub).
 */
export async function currentEngines({ root = ROOT, bundle }) {
  const work = await fs.mkdtemp(path.join(tmpdir(), 'sp-engines-'));
  try {
    const built = {};
    for (const [name, entry] of Object.entries(ENGINES)) {
      const outfile = path.join(work, name);
      await bundle({ root, outfile, entry, rulesVersion: PLACEHOLDER });
      built[name] = (await fs.readFile(outfile)).toString('utf8');
      if (!built[name].includes(PLACEHOLDER)) throw new Error(`${entry} does not embed its rules version`);
    }
    const hash = createHash('sha256');
    for (const name of Object.keys(ENGINES)) hash.update(name).update('\0').update(built[name]).update('\0');
    const id = hash.digest('hex').slice(0, 20);
    const files = {};
    for (const name of Object.keys(ENGINES)) files[name] = Buffer.from(built[name].replaceAll(PLACEHOLDER, id));
    return { id, files };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/**
 * Prepare the rules versions of a build. Unpacks the archives, builds the current engines into .replay-engines/<id>/
 * and returns { current, entries, archived, minted }. With `mint`, a current version that is not archived yet is
 * archived (replay-versions.json + replay-versions/<id>.json.gz); in CI that is an error instead.
 */
export async function buildReplayVersions({ root = ROOT, bundle, mint = false, ci = isCI() } = {}) {
  bundle ||= (await import('./build-worker.mjs')).bundleWorker;
  const manifest = await readManifest(root);
  await unpackArchives(root, manifest);
  const { id, files } = await currentEngines({ root, bundle });
  const dir = path.join(root, '.replay-engines', id);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(dir, name), bytes);

  const archived = manifest.entries.some((entry) => entry.id === id);
  if (archived || !mint) {
    if (!archived && ci) {
      throw new Error(`Rules version ${id} is not archived. Run \`npm run deploy:worker\` (or \`node tools/build-replay.mjs --release\`) `
        + 'from a clean checkout, commit replay-versions.json and the new replay-versions/*.json.gz, then deploy that commit.');
    }
    return { current: id, entries: manifest.entries, archived, minted: false };
  }
  const hashes = {};
  const archive = {};
  for (const [name, bytes] of Object.entries(files)) {
    hashes[name] = sha256(bytes);
    archive[name] = bytes.toString('utf8');
  }
  manifest.entries.push({ id, hashes });
  await fs.mkdir(path.join(root, 'replay-versions'), { recursive: true });
  await fs.writeFile(path.join(root, 'replay-versions', id + '.json.gz'), gzipSync(JSON.stringify(archive), { level: 9 }));
  await fs.writeFile(path.join(root, 'replay-versions.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { current: id, entries: manifest.entries, archived: true, minted: true };
}

/** The archived versions whose recovery engine a Worker running `current` embeds: the newest few other ones. */
export function retainedRecovery(entries, current, keep = RECOVERY_RETAINED) {
  return entries.filter((entry) => entry.id !== current).slice(-keep);
}

/**
 * `--release`: what `npm run deploy:worker` checks before deploying. Exit 0: the current sources are a committed,
 * archived rules version — deploy. Exit 1: dirty tree, or a new version was just archived (commit it, run again).
 */
async function release(root) {
  // Every change to tracked files, and untracked files where deployed code lives, must be committed first: the
  // deployed Worker and its rules version must be a commit.
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  if (status.status !== 0) throw new Error('git status failed: ' + status.stderr);
  const dirty = status.stdout.split('\n').filter((line) => line
    && (!line.startsWith('??') || /^\?\? (server|shared|data|worker|public|tools)\//.test(line)));
  if (dirty.length) {
    console.error('Deploy from a clean checkout: commit or stash these changes first.\n' + dirty.join('\n'));
    return 1;
  }
  // CI never mints (nobody would commit it): an unarchived version fails there instead
  const versions = await buildReplayVersions({ root, mint: !isCI() });
  if (versions.minted) {
    console.error(`New rules version ${versions.current} archived. Commit replay-versions.json and `
      + `replay-versions/${versions.current}.json.gz, then run \`npm run deploy:worker\` again.`);
    return 1;
  }
  console.log(`Rules version ${versions.current} is archived; ${retainedRecovery(versions.entries, versions.current).length} older recovery engine(s) retained.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--release')) {
    console.error('Usage: node tools/build-replay.mjs --release');
    process.exit(2);
  }
  process.exit(await release(ROOT));
}
