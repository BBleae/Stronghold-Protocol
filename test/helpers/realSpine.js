// test/helpers/realSpine.js — the REAL Spine 3.8 runtime (@pixi-spine/runtime-3.8: AnimationState, Skeleton) for
// render/spine.js SpineActor tests, without textures or a display. Review of the upstream PR (2026-10): the hand-written
// fake AnimationState behaved unlike runtime 3.8 — an array `queue` of queued clips where the real `state.queue` is its
// event queue and queued clips hang off TrackEntry.next; no mixing, no delay, no events, no TrackEntry pooling — so bugs
// in the attack / base-clip hand-over were invisible to the tests.
//
// skeletonData(entry): a SkeletonData built from the committed manifest (data/assets.json: clip durations and the
// OnAttack times `hits`, one event timeline per clip) — no bones to pose, but the AnimationState runs exactly as on the
// game's .skel (clip timing, queue / delay / mix, events). gameSkeletonData(entry): the game's own .skel when it is
// downloaded (public/assets, `npm run assets`; null otherwise).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '@pixi-spine/runtime-3.8';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));

/** Manifest Spine entry of a character (`side` 'front' | 'back'), enemy or token; null without one. */
export function spineEntry(id, side = 'front') {
  const c = MANIFEST.chars?.[id] || MANIFEST.enemies?.[id] || MANIFEST.tokens?.[id] || null;
  const sp = c?.spine;
  return sp?.[side] || (sp?.skel ? sp : null); // enemies / tokens: one skeleton, no front / back
}

const synth = new Map();

/** Skeleton data from the manifest entry (cached per entry). */
export function skeletonData(entry) {
  if (synth.has(entry)) return synth.get(entry);
  const sd = new S.SkeletonData();
  sd.name = entry.skel || 'synthetic';
  sd.bones.push(new S.BoneData(0, 'root', null));
  const onAttack = new S.EventData('OnAttack');
  sd.events.push(onAttack);
  for (const [name, dur] of Object.entries(entry.animations || {})) {
    const timelines = [];
    const hits = entry.hits?.[name];
    if (Array.isArray(hits) && hits.length) {
      const tl = new S.EventTimeline(hits.length);
      hits.forEach((t, i) => tl.setFrame(i, new S.Event(t, onAttack)));
      timelines.push(tl);
    }
    sd.animations.push(new S.Animation(name, timelines, dur > 0 ? dur : 1));
  }
  synth.set(entry, sd);
  return sd;
}

/** Attachments without textures: animation timing and events only need the skeleton data. */
const LOADER = {
  newRegionAttachment: (skin, name) => new S.RegionAttachment(name),
  newMeshAttachment: (skin, name) => new S.MeshAttachment(name),
  newBoundingBoxAttachment: (skin, name) => new S.BoundingBoxAttachment(name),
  newPathAttachment: (skin, name) => new S.PathAttachment(name),
  newPointAttachment: (skin, name) => new S.PointAttachment(name),
  newClippingAttachment: (skin, name) => new S.ClippingAttachment(name),
};
const parsed = new Map();

/** The game's own skeleton data (.skel, cached); null when it is not downloaded. */
export function gameSkeletonData(entry) {
  if (!entry?.skel) return null;
  if (parsed.has(entry.skel)) return parsed.get(entry.skel);
  const file = path.join(ROOT, 'public', entry.skel);
  const data = fs.existsSync(file) ? new S.SkeletonBinary(LOADER).readSkeletonData(new Uint8Array(fs.readFileSync(file))) : null;
  parsed.set(entry.skel, data);
  return data;
}

/** What render/spine.js uses of PIXI.spine.Spine, on the real AnimationState / Skeleton (no display object). */
export class RealSpine {
  constructor(data) {
    this.spineData = data;
    this.skeleton = new S.Skeleton(data);
    this.stateData = new S.AnimationStateData(data);
    this.state = new S.AnimationState(this.stateData);
    this.autoUpdate = false;
  }

  update(dt) {
    this.state.update(dt);
    this.state.apply(this.skeleton);
  }

  destroy() {}
}

/** Install RealSpine as PIXI.spine.Spine; returns the restore function. */
export function installRealSpine() {
  const prev = globalThis.PIXI;
  globalThis.PIXI = { ...(prev || {}), spine: { ...(prev?.spine || {}), Spine: RealSpine } };
  return () => { globalThis.PIXI = prev; };
}
