// public/js/ui/presence.js — the 在线人数 readout: the numbers shown next to the release version in the title footer and
// in the lobby's top bar. A remake addition, ported from Jerryzhu1234510's fork (4f4e848f; the owner's decision of
// 2026-10-08).
//
// Two sources, one store slice (`presence`, store.js):
//   * the `presence` frame { online, inRoom } (shared/protocol.js; server/lobby.js presence): the Node server sends it
//     right after every `welcome` and again whenever the numbers change, so a page with a session needs no polling;
//   * GET /healthz, whose body carries the same two numbers: the path of a page without a session — the title screen
//     (its socket says hello only on entering), and the account mode's menu (room-net.js: no socket outside a room;
//     the Cloudflare Worker may answer only /healthz). startPresencePoll reads it every PRESENCE_POLL_MS while such a
//     screen is up, and stops asking while the frames reach this page (a frame arrived and the session is online).
// `online` counts the pages with the game open (the live sockets), `inRoom` the humans holding a seat plus the
// spectators. A number that is not known (no frame and no answer yet, a server that does not report it, a failed read)
// shows as — (em dash).

import { useEffect } from '../../vendor/hooks.module.js';
import { t } from '../../../shared/i18n.js';
import { store } from '../store.js';

/** How often a page without a pushed feed (the title screen, the account menu) re-reads the counters from /healthz. */
export const PRESENCE_POLL_MS = 10_000;

/** Give up on a /healthz that does not answer: a hanging request must not pile up on the next poll. */
export const PRESENCE_FETCH_TIMEOUT_MS = 5_000;

/** The slice before anything is known (store.js initialState.presence). */
export const UNKNOWN_PRESENCE = Object.freeze({ online: null, inRoom: null, via: null });

/**
 * Normalise the numbers of a `presence` frame, a /healthz body or the store's slice: a non-negative whole number, or
 * null while the number is unknown.
 * @param {any} p `{ online, inRoom }`
 * @returns {{ online: number|null, inRoom: number|null }}
 */
export function presenceFacts(p) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
  return { online: n(p?.online), inRoom: n(p?.inRoom) };
}

/** The readout's text: 「在线 3 人 · 房间内 1 人」; a number that is not known shows as —. */
export function presenceLabel(p) {
  const { online, inRoom } = presenceFacts(p);
  return t('在线 {online} 人 · 房间内 {inRoom} 人', { online: online ?? '—', inRoom: inRoom ?? '—' });
}

/** The readout's tooltip (what the two numbers count). */
export function presenceHint() {
  return t('本服务器当前的在线人数，以及其中在房间里（含观战）的人数');
}

/**
 * Read the counters from `GET /healthz`. Never throws: an offline server, a 404, broken JSON or a slow answer are all
 * null ("unknown"); a body without the counters (an older server) gives `{ online: null, inRoom: null }`.
 * @param {Function} [fetchFn] injectable for tests
 * @param {{ timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function }} [o]
 * @returns {Promise<{ online: number|null, inRoom: number|null } | null>}
 */
export async function fetchPresence(fetchFn = (url, init) => globalThis.fetch(url, init), o = {}) {
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : PRESENCE_FETCH_TIMEOUT_MS;
  const setT = o.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = o.clearTimeout || ((h) => globalThis.clearTimeout(h));
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const tooSlow = new Promise((_, reject) => {
    timer = setT(() => { try { ctrl?.abort(); } catch { /* ignore */ } reject(new Error('timeout')); }, timeoutMs);
  });
  tooSlow.catch(() => {}); // settled by the race below, or never looked at
  try {
    const res = await Promise.race([fetchFn('/healthz', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }), tooSlow]);
    if (!res || !res.ok) return null;
    const body = await Promise.race([res.json(), tooSlow]);
    return body && typeof body === 'object' ? presenceFacts(body) : null;
  } catch {
    return null;
  } finally {
    if (timer != null) clearT(timer);
  }
}

/** Whether the server pushes the counters to this page: a frame set them and the session is still online. */
export const presencePushed = (s) => s.presence?.via === 'frame' && s.connection?.status === 'online';

/**
 * Keep the store's counters fresh from /healthz while a screen that shows them is up: one read now, then one every
 * `intervalMs` — skipped while the page is hidden (a background tab costs the server nothing; it reads again when it
 * comes back) and while the frames reach this page (presencePushed). A failed read shows the numbers as unknown.
 * @param {{ fetchFn?: Function, store?: typeof store, intervalMs?: number, timeoutMs?: number, doc?: any,
 *           setInterval?: Function, clearInterval?: Function, setTimeout?: Function, clearTimeout?: Function }} [o]
 * @returns {() => void} stop
 */
export function startPresencePoll(o = {}) {
  const st = o.store || store;
  const doc = o.doc !== undefined ? o.doc : globalThis.document;
  const setIv = o.setInterval || ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIv = o.clearInterval || ((h) => globalThis.clearInterval(h));
  const intervalMs = Number.isFinite(o.intervalMs) && o.intervalMs > 0 ? o.intervalMs : PRESENCE_POLL_MS;
  let alive = true;
  let busy = false;
  const tick = async () => {
    if (!alive || busy || doc?.visibilityState === 'hidden' || presencePushed(st.get())) return;
    busy = true;
    try {
      const p = await fetchPresence(o.fetchFn, o);
      // a frame that arrived meanwhile is newer than this answer
      if (!alive || presencePushed(st.get())) return;
      const next = { ...(p || presenceFacts(null)), via: 'healthz' };
      const cur = st.get().presence;
      if (!cur || cur.online !== next.online || cur.inRoom !== next.inRoom || cur.via !== next.via) st.set({ presence: next });
    } finally {
      busy = false;
    }
  };
  void tick();
  const id = setIv(() => { void tick(); }, intervalMs);
  const onVisible = () => { if (doc?.visibilityState === 'visible') void tick(); };
  doc?.addEventListener?.('visibilitychange', onVisible);
  return () => {
    alive = false;
    clearIv(id);
    doc?.removeEventListener?.('visibilitychange', onVisible);
  };
}

/** The screens' hook: startPresencePoll while the component is mounted. */
export function usePresencePoll() {
  useEffect(() => startPresencePoll(), []);
}
