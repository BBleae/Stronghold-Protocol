import { PREFERENCE_KEYS, validPreference, cleanPreferences } from './preferenceSchema.js';
import { LOADOUT_PREF, parseStored, toStored } from './ui/loadoutModel.js';
import { DIY_PREF, parseStoredDiy, toStoredDiy } from './ui/diyModel.js';
import { OWNERSHIP_PREF, parseStoredOwnership, toStoredOwnership } from './ui/ownershipModel.js';
import { t } from '../../shared/i18n.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A device-local value in the stored form its account key takes (an older build's shape is parsed and re-saved). */
const STORED_FORM = {
  [LOADOUT_PREF]: (value) => toStored(parseStored(value)),
  [DIY_PREF]: (value) => toStoredDiy(parseStoredDiy(value)),
  [OWNERSHIP_PREF]: (value) => toStoredOwnership(parseStoredOwnership(value)),
};
async function requestPreferences(body) {
  const response = await fetch('/api/me/preferences', {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(8000), keepalive: body !== undefined,
    headers: body === undefined ? undefined : {'Content-Type':'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error); error.code = result.error; throw error; }
  return result;
}

/** Local fallback plus an account-scoped cache/outbox; only explicitly edited fields are patched. */
export function createPreferences({storage = () => globalThis.localStorage, request = requestPreferences,
  timers = globalThis, events = globalThis, onError = () => {}} = {}) {
  let accountId = null, values = {}, pending = {}, hydrated = false, blocked = false;
  // this browser's old local values of keys this account's cache has never held (a key that joined the synced set later,
  // e.g. the 自选编队 picks and the 干员持有 list): uploaded at hydration where the cloud has nothing for them — never over a cloud value
  let lateLegacy = {};
  let timer = null, flight = null, status = 'local', disposed = false, generation = 0, errorNotified = false;
  const listeners = new Set();
  const read = (key, fallback = null) => { try { const raw = storage()?.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; } };
  const write = (key, value) => { try { storage()?.setItem(key, JSON.stringify(value)); } catch { /* storage may be disabled */ } };
  const emit = key => { for (const listener of listeners) listener(key); };
  const state = next => { if (status !== next) { status = next; emit(null); } };
  const persist = () => write(`sp.accountPrefs.${accountId}`, {values, pending, ...(Object.keys(lateLegacy).length ? {legacy: lateLegacy} : {})});
  const apply = next => {
    const previous = values; values = next; persist();
    for (const key of PREFERENCE_KEYS) if (!same(previous[key], values[key])) emit(key);
  };
  const schedule = (delay = 350) => {
    timers.clearTimeout(timer);
    if (!blocked && !disposed) timer = timers.setTimeout(() => { timer = null; void flush(); }, delay);
  };
  const checkAccount = result => {
    if (result?.accountId !== accountId) { const error = new Error('ACCOUNT_CHANGED'); error.code = 'ACCOUNT_CHANGED'; throw error; }
    return result.preferences;
  };

  async function sync(myGeneration) {
    try {
      if (!hydrated) {
        state('loading');
        let result = await request();
        if (generation !== myGeneration || disposed) return;
        let remote = checkAccount(result);
        if (remote == null) {
          result = await request({accountId, patch:values, initialize:true});
          if (generation !== myGeneration || disposed) return;
          remote = checkAccount(result);
        }
        hydrated = true;
        for (const [key, value] of Object.entries(lateLegacy)) if (remote[key] === undefined && pending[key] === undefined) pending[key] = value;
        lateLegacy = {};
        apply({...cleanPreferences(remote), ...pending}); // persists without the legacy values (they are pending or dropped)
      }
      while (Object.keys(pending).length) {
        const patch = {...pending}; state('saving');
        const result = await request({accountId, patch});
        if (generation !== myGeneration || disposed) return;
        const remote = checkAccount(result);
        for (const key of Object.keys(patch)) if (same(pending[key], patch[key])) delete pending[key];
        apply({...cleanPreferences(remote), ...pending});
      }
      errorNotified = false; state('synced');
    } catch (error) {
      if (generation !== myGeneration || disposed) return;
      blocked = ['ACCOUNT_CHANGED','LOGIN_REQUIRED','INVALID_PREFERENCES'].includes(error.code);
      state('error');
      if (!errorNotified) { errorNotified = true; onError(error); }
      schedule(5000);
    }
  }
  function flush() {
    timers.clearTimeout(timer); timer = null;
    if (!accountId || blocked || disposed) return Promise.resolve();
    if (flight) return flight;
    const myGeneration = generation;
    flight = sync(myGeneration).finally(() => { if (generation === myGeneration) flight = null; });
    return flight;
  }
  async function start(id) {
    generation++; timers.clearTimeout(timer); flight = null;
    accountId = id || null; hydrated = false; blocked = false; errorNotified = false; lateLegacy = {};
    if (!accountId) { values = {}; pending = {}; state('local'); for (const key of PREFERENCE_KEYS) emit(key); return; }
    const cached = read(`sp.accountPrefs.${accountId}`);
    values = cleanPreferences(cached?.values); pending = cleanPreferences(cached?.pending); lateLegacy = cleanPreferences(cached?.legacy);
    // Unscoped values from older builds can belong to only the first account using this browser.
    const owner = read('sp.accountPrefs.legacyOwner');
    if (!owner) write('sp.accountPrefs.legacyOwner', accountId);
    if (!owner || owner === accountId) {
      const known = {...values, ...pending};
      for (const key of PREFERENCE_KEYS) {
        if (cached && (key in known || key in lateLegacy)) continue;
        let value = read(`sp.pref.${key}`);
        if (value != null && STORED_FORM[key]) value = STORED_FORM[key](value);
        if (!validPreference(key, value)) continue;
        if (cached) lateLegacy[key] = value; // a first login migrates everything below; a cached account only fills gaps
        else values[key] = value;
      }
      if (cached) for (const [key, value] of Object.entries(lateLegacy)) if (values[key] === undefined) values[key] = value;
    }
    values = {...values, ...pending}; persist();
    for (const key of PREFERENCE_KEYS) emit(key);
    await flush();
  }
  const wake = () => { if (accountId && (!hydrated || Object.keys(pending).length)) void flush(); };
  const hide = () => { if (globalThis.document?.visibilityState === 'hidden') wake(); };
  events.addEventListener?.('online', wake);
  events.addEventListener?.('pagehide', wake);
  globalThis.document?.addEventListener?.('visibilitychange', hide);
  return {
    start, flush,
    get status() { return status; },
    load(key, fallback) { return accountId && PREFERENCE_KEYS.includes(key) ? values[key] ?? fallback : read(`sp.pref.${key}`, fallback); },
    save(key, value) {
      if (accountId && PREFERENCE_KEYS.includes(key)) {
        if (!validPreference(key, value) || same(values[key], value)) return;
        values = {...values, [key]:structuredClone(value)}; pending[key] = values[key]; persist();
        if (!blocked) state('pending'); emit(key); schedule();
      } else { write(`sp.pref.${key}`, value); emit(key); }
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      disposed = true; timers.clearTimeout(timer);
      events.removeEventListener?.('online', wake); events.removeEventListener?.('pagehide', wake);
      globalThis.document?.removeEventListener('visibilitychange', hide); listeners.clear();
    },
  };
}

export const preferences = createPreferences({onError: error => {
  // Loaded lazily to keep the preference store independent of UI boot order.
  void import('./ui/toasts.js').then(({toast}) => toast(
    ['ACCOUNT_CHANGED','LOGIN_REQUIRED'].includes(error.code) ? t('登录状态已变化，请刷新页面以继续保存账号偏好')
      : t('账号偏好暂未同步，修改已在本机保留，将自动重试'), 'warn'));
}});
