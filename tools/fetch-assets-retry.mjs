// Usage: node tools/fetch-assets-retry.mjs [--rounds N] [--concurrency N] [--asset-source=direct|mirror] [--dry-run]
//
// `tools/fetch-assets.mjs` writes data/assets.json only when nothing required is missing, so one stubborn file keeps the
// whole manifest from being written. On some networks the jsDelivr mirror drops large responses (operator Spine pages are
// 0.4-0.9 MB) or fails the TLS chain check on ONE of its host names, so this script separates "download" from "write the
// manifest": it downloads the files that are missing on disk, over several rounds with growing timeouts, and then
// `node tools/fetch-assets.mjs` (which skips files that are already there) writes the manifest.
//
// Job list = the manifest template leaves (tools/assets/manifest.mjs collectLeaves) PLUS plan.models, which holds the
// Spine models separately ({ skel, atlas, pngs[] }, downloaded by assets/spine.mjs processModels). Missing the models here
// leaves every operator model un-downloaded - the first version of this script did exactly that. The plan is built from
// the same inputs as tools/fetch-assets.mjs (data/*.json through its dataExtras, the committed local-client model
// files), without the operator voice (run fetch-assets for that).
//
// Mirror host rotation: the project mirrors raw.githubusercontent.com to cdn.jsdelivr.net (tools/assets/sources.mjs
// mirrorUrl). Any jsDelivr host serves the same path, so each jsDelivr URL is also tried on the hosts below. This machine
// cannot reach raw.githubusercontent.com at all and fastly.jsdelivr.net fails TLS (UNABLE_TO_VERIFY_LEAF_SIGNATURE), while
// cdn / gcore / b-cdn answer; rotating hosts keeps one bad node from stalling a whole batch.
//
// GitHub mirror (docs/DEPLOY.md 国内镜像下载): the same opt-in as tools/fetch-assets.mjs — --asset-source=mirror (or
// SP_ASSET_SOURCE=mirror; the option wins) adds the prefix-proxy copy (SP_GITHUB_PROXY, default https://gh-proxy.com/;
// empty disables it) of every GitHub URL as the first candidate, tried once per round behind the run-wide circuit
// breaker of tools/assets/network.mjs MirrorPolicy (3 failures in a row turn it off for the run). Every download is
// checked like the Downloader does (tools/assets/formats.mjs validate), so a proxy's error page is never kept.
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadIndexes } from './assets/cache.mjs';
import { indexAudio } from './assets/audio.mjs';
import { buildPlan } from './assets/plan.mjs';
import { collectLeaves } from './assets/manifest.mjs';
import { loadLocalSpines, LOCAL_ENEMY_SPINES_FILE, LOCAL_TOKEN_SPINES_FILE } from './assets/spine.mjs';
import { kindOf, validate } from './assets/formats.mjs';
import { MirrorPolicy, validateSource } from './assets/network.mjs';
import { githubProxyUrl, normalizeProxyPrefix } from './assets/sources.mjs';
import { dataExtras } from './fetch-assets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
/** `--name value` or `--name=value` (fetch-assets.mjs spells its options the second way). */
const arg = (name, def) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ROUNDS = Math.max(1, parseInt(arg('--rounds', '6'), 10) || 6);
const DRY = argv.includes('--dry-run');
const CONC = Math.max(1, parseInt(arg('--concurrency', '4'), 10) || 4);
const SOURCE = validateSource(arg('--asset-source', process.env.SP_ASSET_SOURCE || 'direct'));
const PROXY_PREFIX = SOURCE === 'mirror' ? normalizeProxyPrefix(process.env.SP_GITHUB_PROXY) : '';
const network = new MirrorPolicy({ source: SOURCE, proxyPrefix: PROXY_PREFIX, log: (m) => console.log(m) });
if (SOURCE === 'mirror') console.log(`[network] GitHub 镜像：${PROXY_PREFIX || '代理已禁用'}（每个文件先试一次，文件仅校验格式和大小）`);

const MIRROR_HOSTS = ['cdn.jsdelivr.net', 'gcore.jsdelivr.net', 'jsdelivr.b-cdn.net'];

const readJson = async (rel) => JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [assets07, ops03, enemies05, maps05] = await Promise.all([
  readJson('docs/research/07-assets.json'),
  readJson('docs/research/03-operators.json'),
  readJson('docs/research/05-enemies.json'),
  readJson('docs/research/05-maps.json'),
]);
const { audioData, modelsData } = await loadIndexes(ROOT, { offline: true, log: () => {} });
const audio = indexAudio(audioData);
const [dataEnemies, dataTokens, dataBosses, dataBackups, dataChess] = await Promise.all(
  ['data/enemies.json', 'data/tokens.json', 'data/bosses.json', 'data/backups.json', 'data/chess.json'].map((f) => readJson(f).catch(() => null)));
const extras = dataExtras(dataBackups, dataChess);
const extraHandbook = {};
for (const b of Object.values(dataBosses || {})) if (b?.enemyKey && typeof b.handbookId === 'string') extraHandbook[b.enemyKey] = b.handbookId;

const plan = buildPlan({
  assets07, ops03, enemies05, maps05, audio, modelsData,
  extraEnemyIds: Object.keys(dataEnemies || {}),
  extraTokenIds: [...Object.keys(dataTokens || {}), ...extras.tokenIds],
  extraHandbook,
  localEnemySpines: await loadLocalSpines(join(ROOT, LOCAL_ENEMY_SPINES_FILE)).catch(() => ({})),
  localTokenSpines: await loadLocalSpines(join(ROOT, LOCAL_TOKEN_SPINES_FILE)).catch(() => ({})),
  extraOperators: extras.extraOperators,
  moduleTypes: extras.moduleTypes,
});

/** Every downloadable in the plan: { rel, urls, bytes, mutable, kind }. */
const jobs = [];
const addJob = (a) => {
  if (a && typeof a.rel === 'string' && Array.isArray(a.urls) && a.urls.length) jobs.push({ rel: a.rel, urls: a.urls, bytes: a.bytes, mutable: !!a.mutable, kind: a.kind || kindOf(a.rel) });
};
for (const { leaf } of collectLeaves(plan.template)) for (const a of leaf?.alts || []) addJob(a);
for (const m of plan.models.values()) for (const a of [m.skel, m.atlas, ...(m.pngs || [])]) addJob(a);

/**
 * Every usable URL for one candidate, in preference order. A raw.githubusercontent.com URL is unreachable on this
 * machine (and offers no fallback in the plan for the token avatars / 炎佑 icon), so it is ALSO tried as its jsDelivr
 * equivalent on every usable host - the same mapping tools/assets/sources.mjs mirrorUrl performs, but on hosts that
 * answer here. A jsDelivr URL is rotated across those hosts too.
 */
function expandUrls(urls) {
  const out = [];
  const mirrorOf = (u) => {
    const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(u);
    return m ? `/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}` : null;
  };
  for (const u of urls) {
    const raw = mirrorOf(u);
    if (raw) {
      for (const h of MIRROR_HOSTS) out.push(`https://${h}${raw}`);
      out.push(u); // last: kept for completeness, it cannot work on this network
      continue;
    }
    out.push(u);
    const m = /^https:\/\/([a-z0-9.-]*jsdelivr[a-z0-9.-]*)\/(.*)$/i.exec(u);
    if (m) for (const h of MIRROR_HOSTS) if (h !== m[1]) out.push(`https://${h}/${m[2]}`);
  }
  return [...new Set(out)];
}

/** --asset-source=mirror: the prefix-proxy copies of a job's GitHub URLs, tried before the rotated candidates. */
const proxyUrls = (urls) => (PROXY_PREFIX ? [...new Set(urls.map((u) => githubProxyUrl(u, PROXY_PREFIX)).filter(Boolean))] : []);

const sizeOf = async (rel) => { try { return (await stat(join(ROOT, 'public/assets', rel))).size; } catch { return -1; } };

/**
 * Download one job: the proxy copies first (mirror mode, once each), then every candidate URL, twice each. `salt`
 * rotates which host name is tried first.
 */
async function fetchOne(job, timeoutMs, salt = 0) {
  let lastError = 'no candidate url';
  const urls = expandUrls(job.urls);
  const rotated = urls.length > 1 ? [...urls.slice(salt % urls.length), ...urls.slice(0, salt % urls.length)] : urls;
  const ordered = [...proxyUrls(job.urls), ...rotated];
  for (const url of ordered) {
    if (network.skip(url)) continue; // the mirror tripped its circuit breaker for this run
    const attempts = network.isProxy(url) ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        // the request (and, for the proxy, the body idle deadline) of tools/assets/network.mjs
        const res = await network.request(url, fetch, {}, timeoutMs);
        if (res.status === 404) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          network.succeeded(url); // a missing file is not a proxy outage
          lastError = `HTTP 404 (${url.slice(0, 60)})`;
          break;
        }
        if (!res.ok) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          throw new Error(`HTTP ${res.status}`);
        }
        const buf = await network.readBody(url, res);
        if (buf.length === 0) throw new Error('empty body');
        if (Number.isInteger(job.bytes) && job.bytes > 0 && !job.mutable && buf.length !== job.bytes) {
          throw new Error(`size ${buf.length} != expected ${job.bytes}`);
        }
        if (!validate(job.kind, buf)) throw new Error(`invalid ${job.kind} payload (${buf.length} B)`);
        network.succeeded(url);
        const dest = join(ROOT, 'public/assets', job.rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(`${dest}.tmp`, buf);
        await rename(`${dest}.tmp`, dest);
        return { ok: true, bytes: buf.length, url };
      } catch (e) {
        network.failed(url);
        lastError = `${e.name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`;
        await sleep(300 + Math.random() * 500);
      }
    }
  }
  return { ok: false, error: lastError };
}

/** Jobs whose file is absent or the wrong size. */
async function missingJobs() {
  const out = [];
  for (const job of jobs) {
    const size = await sizeOf(job.rel);
    const want = Number.isInteger(job.bytes) && job.bytes > 0 && !job.mutable ? job.bytes : null;
    if (size > 0 && (!want || size === want)) continue;
    out.push(job);
  }
  return out;
}

let left = await missingJobs();
console.log(`plan ${jobs.length} files; missing ${left.length} (${plan.models.size} models)`);
if (left.length && process.env.SP_DEBUG_URLS) {
  for (const j of left.slice(0, 3)) console.log('[urls]', j.rel, '=>', JSON.stringify([...proxyUrls(j.urls), ...expandUrls(j.urls)]));
}
// the manifest run that follows keeps this run's source choice (it only downloads what is still missing)
const NEXT = `node tools/fetch-assets.mjs${SOURCE === 'mirror' ? ' --asset-source=mirror' : ''}`;
if (process.env.SP_DEBUG_PLAN) {
  const ids = ['char_617_sharp2'];
  for (const path of ["chars.char_617_sharp2.avatar", "chars.char_617_sharp2.avatarE2", "chars.char_617_sharp2.portraitE2"]) {
    const hit = collectLeaves(plan.template).find((l) => l.path === path);
    console.log('[plan]', path, hit ? JSON.stringify(hit.leaf).slice(0, 300) : '(absent)');
  }
  void ids;
}
if (!left.length) { console.log(`nothing missing - run: ${NEXT}`); process.exit(0); }
if (DRY) { for (const j of left.slice(0, 10)) console.log('  ', j.rel); process.exit(0); }

for (let round = 1; round <= ROUNDS && left.length; round++) {
  const timeout = 60_000 + round * 30_000;
  console.log(`\nround ${round}/${ROUNDS}: ${left.length} files, timeout ${Math.round(timeout / 1000)}s, concurrency ${CONC}`);
  let cursor = 0; let ok = 0; let fail = 0;
  const errors = new Map();
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= left.length) return;
      const r = await fetchOne(left[i], timeout, i + round);
      if (r.ok) ok++;
      else {
        fail++;
        const key = String(r.error).slice(0, 90);
        if (!errors.has(key)) errors.set(key, { n: 0, sample: left[i].rel });
        errors.get(key).n++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`  ok=${ok} fail=${fail}`);
  for (const [msg, e] of [...errors].sort((a, b) => b[1].n - a[1].n).slice(0, 4)) console.log(`  x${e.n}  ${msg}   (e.g. ${e.sample})`);
  left = await missingJobs();
  if (left.length) await sleep(1500 + round * 1000);
}
console.log(`\ndone: ${left.length} still missing${left.length ? '' : ` - run: ${NEXT}`}`);
for (const j of left.slice(0, 20)) console.log('  !', j.rel);
process.exit(left.length ? 1 : 0);
