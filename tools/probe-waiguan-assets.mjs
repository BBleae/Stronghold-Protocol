// Usage: node tools/probe-waiguan-assets.mjs [--out <file>] [--spine-sample N]
//
// Writes the probe file tools/gen-waiguan-operators.mjs reads (.cache/waiguan-assets-probe.json by default): the byte
// count of every 外援 / 甄选 candidate's avatar and portrait, measured with a HEAD against the jsDelivr mirror. Run it
// when the mirror moved on, before regenerating tools/assets/waiguan-operators.json.
//
// Only HEADs are sent (174 of them, 8 at a time). The Spine files are NOT probed one by one: jsDelivr refuses to list
// these repositories ("Package size exceeded the configured limit of 50 MB"), so there is no authoritative size for them,
// and the downloader validates existence anyway. `--spine-sample N` samples N candidates and reports the model size, which
// is what the roster's size estimate in docs/ASSETS.md rests on.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const OUT = arg('--out', join(ROOT, '.cache/waiguan-assets-probe.json'));
const SPINE_SAMPLE = Math.max(0, parseInt(arg('--spine-sample', '0'), 10) || 0);

const YY = 'https://cdn.jsdelivr.net/gh/yuanyan3060/ArknightsGameResource@main/';
const FX = 'https://cdn.jsdelivr.net/gh/fexli/ArknightsResource@main/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One HEAD with a short timeout; a definitive 404 is a miss, anything else that keeps failing is an error. */
async function head(url, tries = 2, timeout = 12_000) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      let res;
      try { res = await fetch(url, { method: 'HEAD', signal: ctl.signal }); } finally { clearTimeout(timer); }
      if (res.status === 404) return { status: 'miss' };
      if (!res.ok) { await sleep(200 * (i + 1)); continue; }
      const len = Number(res.headers.get('content-length'));
      return { status: 'ok', bytes: Number.isFinite(len) && len > 0 ? len : null };
    } catch { await sleep(200 * (i + 1)); }
  }
  return { status: 'error' };
}

const waiguan = JSON.parse(await readFile(join(ROOT, 'data/waiguan.json'), 'utf8'));
const charIds = waiguan.candidates.map((c) => c.charId).sort();
console.log(`${charIds.length} candidates; probing avatar + portrait on the mirror…`);

const jobs = [];
for (const id of charIds) {
  jobs.push([id, 'avatar', `${YY}avatar/${id}.png`]);
  jobs.push([id, 'portrait', `${YY}portrait/${id}_1.png`]);
}

const out = {};
let done = 0;
let ok = 0;
let miss = 0;
let err = 0;
let cursor = 0;
const worker = async () => {
  for (;;) {
    const i = cursor++;
    if (i >= jobs.length) return;
    const [id, kind, url] = jobs[i];
    const r = await head(url);
    (out[id] ||= {})[kind] = r;
    done++;
    if (r.status === 'ok') ok++; else if (r.status === 'miss') miss++; else err++;
    if (done % 40 === 0) console.log(`  ${done}/${jobs.length}  ok=${ok} miss=${miss} err=${err}`);
  }
};
await Promise.all(Array.from({ length: 8 }, worker));

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(out, null, 1)}\n`, 'utf8');
console.log(`\n${jobs.length} files probed: ok=${ok} miss=${miss} err=${err}`);
const sizes = charIds.map((id) => out[id].avatar?.bytes).filter((b) => typeof b === 'number');
if (sizes.length) {
  const sum = sizes.reduce((a, b) => a + b, 0);
  console.log(`avatars: ${sizes.length} sized, ${(sum / 1048576).toFixed(2)} MB total, ${Math.round(sum / sizes.length / 1024)} KB average`);
}
const bad = charIds.filter((id) => out[id].avatar?.status !== 'ok' || out[id].portrait?.status !== 'ok');
if (bad.length) console.log(`${bad.length} candidate(s) incomplete: ${bad.join(', ')}`);
console.log(`wrote ${OUT}`);

if (SPINE_SAMPLE) {
  const step = Math.max(1, Math.floor(charIds.length / SPINE_SAMPLE));
  const sample = charIds.filter((_, i) => i % step === 0).slice(0, SPINE_SAMPLE);
  let total = 0;
  let files = 0;
  console.log(`\nsampling ${sample.length} battle models (Front + Back)…`);
  for (const id of sample) {
    for (const side of ['Front', 'Back']) {
      for (const ext of ['skel', 'atlas', 'png']) {
        const r = await head(`${FX}spine/${id}/${id}/${side}/${id}.${ext}`, 3, 15_000);
        if (r.status === 'ok' && r.bytes) { total += r.bytes; files++; }
      }
    }
  }
  console.log(`  ${files} files, ${(total / 1048576).toFixed(1)} MB for ${sample.length} models`);
  console.log(`  average ${(total / sample.length / 1048576).toFixed(2)} MB per operator`);
}
