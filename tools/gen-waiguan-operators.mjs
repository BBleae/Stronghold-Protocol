// Usage: node tools/gen-waiguan-operators.mjs [--probe <file>] [--verify]
//
// Regenerates the committed tools/assets/waiguan-operators.json: the avatar / portrait / battle Spine / skill-icon entries
// of the 外援 / 甄选 (DIY) roster (DESIGN §27), in the same shape as an operator entry of docs/research/07-assets.json.
// tools/assets/plan.mjs consumes them through buildPlan({ extraOperators }) and tools/fetch-assets.mjs merges them into
// the download plan.
//
// Inputs:
//   data/waiguan.json                     the 87 candidates and their records (skills come from here: data/chess.json
//                                         only holds the four EMPTY slot templates)
//   .cache/waiguan-assets-probe.json      byte counts of avatar / portrait measured against the mirror (see below)
//   docs/research/07-assets.json          who research already covers (those entries are NOT duplicated, see below)
//
// `--verify` HEAD-checks every avatar / portrait URL again (slow, for a fresh network).
//
// The probe file is produced by a small script that HEADs avatar/<id>.png and portrait/<id>_1.png on the jsDelivr mirror.
// Run it again when the mirror moved on; a candidate with no byte count still gets its entry (the size is optional).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools/assets/waiguan-operators.json');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const probeFile = arg('--probe', join(ROOT, '.cache/waiguan-assets-probe.json'));
const verify = process.argv.includes('--verify');

const YY_RAW = 'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/';
const YY_CDN = 'https://cdn.jsdelivr.net/gh/yuanyan3060/ArknightsGameResource@main/';
const FX_RAW = 'https://raw.githubusercontent.com/fexli/ArknightsResource/main/';
const FX_CDN = 'https://cdn.jsdelivr.net/gh/fexli/ArknightsResource@main/';

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const waiguan = await readJson(join(ROOT, 'data/waiguan.json'));
const probe = await readJson(probeFile);

// research 07 is the authority for the operators it lists. A candidate that also appears there (char_617_sharp2 is both a
// 甄选 candidate and a pool operator) must NOT be duplicated here: plan.mjs merges extraOperators OVER the research
// entries, so a thinner entry would silently drop fields the research one has (E2 avatar / portrait, skill SFX).
const research = await readJson(join(ROOT, 'docs/research/07-assets.json'));
const researchIds = new Set(Object.keys(research.operators || {}));

// Every skill the roster's records offer, so the loadout screen's per-skill data has its icon (the plan keys them by
// `iconId`, and the file is skill/skill_icon_<iconId>.png on the same operator-art mirror).
const rosterRecords = [...Object.values(waiguan.chess || {}), ...Object.values(waiguan.chessT5 || {})];
const skillsByChar = new Map();
for (const rec of rosterRecords) {
  if (!rec || !rec.charId) continue;
  const set = skillsByChar.get(rec.charId) || new Set();
  for (const s of rec.skills || []) if (s && typeof s.skillId === 'string') set.add(s.skillId);
  skillsByChar.set(rec.charId, set);
}
/**
 * A skill entry: index, the skill id, its icon (`url` the jsDelivr mirror, `mirror` the upstream raw URL; plan.mjs
 * entryUrls tries raw first, like a pool operator's file, so --asset-source=mirror reaches it through the gh-proxy).
 */
const skillEntry = (skillId, index) => ({
  index, skillId, iconId: skillId,
  icon: { url: `${YY_CDN}skill/skill_icon_${skillId}.png`, mirror: `${YY_RAW}skill/skill_icon_${skillId}.png` },
});
/**
 * The skills of one operator. `index` is the position in this array: plan.mjs reads `skills[].index` to decide which
 * skill icons, skill SFX and Spine skill clips to plan, so the numbering has to match the array it is read from.
 */
const skillsOf = (charId) => [...(skillsByChar.get(charId) || [])].sort().map((sid, i) => skillEntry(sid, i));

const bytesOf = (id, kind) => {
  const b = probe[id]?.[kind]?.bytes;
  return Number.isInteger(b) && b > 0 ? b : undefined;
};

/** One Spine side: each file names the jsDelivr mirror (`url`) and the upstream raw URL (`mirror`, tried first by plan.mjs). */
const spineSide = (id, side) => ({
  skel: { url: `${FX_CDN}spine/${id}/${id}/${side}/${id}.skel`, mirror: `${FX_RAW}spine/${id}/${id}/${side}/${id}.skel` },
  atlas: { url: `${FX_CDN}spine/${id}/${id}/${side}/${id}.atlas`, mirror: `${FX_RAW}spine/${id}/${id}/${side}/${id}.atlas` },
  png: { url: `${FX_CDN}spine/${id}/${id}/${side}/${id}.png`, mirror: `${FX_RAW}spine/${id}/${id}/${side}/${id}.png` },
});

const out = {};
let missing = 0;
let skipped = 0;
for (const c of waiguan.candidates) {
  const id = c.charId;
  if (researchIds.has(id)) { skipped++; continue; }
  const p = probe[id] || {};
  if (p.avatar?.status !== 'ok' || p.portrait?.status !== 'ok') {
    missing++;
    console.warn(`  ! ${id} avatar/portrait probe incomplete (avatar=${p.avatar?.status} portrait=${p.portrait?.status})`);
  }
  const avatarBytes = bytesOf(id, 'avatar');
  const portraitBytes = bytesOf(id, 'portrait');
  out[id] = {
    name: c.name,
    rarity: 'TIER_6',
    profession: c.profession,
    subProfessionId: c.subProfessionId,
    nationId: c.nationId || null,
    waiguan: true,
    avatar: {
      e0e1: { url: `${YY_CDN}avatar/${id}.png`, mirror: `${YY_RAW}avatar/${id}.png`, ...(avatarBytes ? { bytes: avatarBytes } : {}) },
    },
    portrait: {
      e0e1: { url: `${YY_CDN}portrait/${id}_1.png`, mirror: `${YY_RAW}portrait/${id}_1.png`, ...(portraitBytes ? { bytes: portraitBytes } : {}) },
    },
    battleSpine: { front: spineSide(id, 'Front'), back: spineSide(id, 'Back') },
    skills: skillsOf(id),
  };
}

if (verify) {
  console.log('verifying avatar / portrait URLs (HEAD)…');
  const ids = Object.keys(out);
  const bad = [];
  let ok = 0;
  for (const id of ids) {
    for (const [kind, url] of [['avatar', out[id].avatar.e0e1.url], ['portrait', out[id].portrait.e0e1.url]]) {
      let good = false;
      for (let t = 0; t < 3 && !good; t++) {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 15_000);
          let res;
          try { res = await fetch(url, { method: 'HEAD', signal: ctl.signal }); } finally { clearTimeout(timer); }
          good = res.ok;
        } catch { /* retry */ }
      }
      if (good) ok++; else bad.push(`${id}:${kind}`);
    }
  }
  console.log(`  ok=${ok}/${ids.length * 2}${bad.length ? `  failed: ${bad.slice(0, 10).join(', ')}` : ''}`);
}

await writeFile(OUT, `${JSON.stringify({
  note: '外援 / 甄选 (DIY) roster asset entries (DESIGN §27). Generated by tools/gen-waiguan-operators.mjs from data/waiguan.json plus a live mirror probe; consumed by tools/assets/plan.mjs buildPlan({ extraOperators }).',
  source: 'https://cdn.jsdelivr.net/gh/{yuanyan3060/ArknightsGameResource@main, fexli/ArknightsResource@main}',
  operators: out,
}, null, 1)}\n`, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`  skipped ${skipped} already listed by research 07 (keeps their E2 art and skill SFX)`);
console.log(`  ${Object.keys(out).length} operators; avatar without a byte count ${Object.values(out).filter((o) => !o.avatar.e0e1.bytes).length}, portrait ${Object.values(out).filter((o) => !o.portrait.e0e1.bytes).length}; probe incomplete ${missing}`);
