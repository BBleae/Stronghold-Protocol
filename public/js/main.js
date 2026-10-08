// Client entry: boot (fonts, identity, socket), net → store wiring, router, global overlays.
//
// Router (derived from the store, no URL routes):
//   not entered            → Title
//   m.public.phase ≠ LOBBY → Game (screens/game.js: briefing / band draft / match / result by phase)
//   room.inMatch           → Game (match starting, m.public on its way)
//   in a room              → Room
//   otherwise              → Lobby
// Deep link `?room=CODE`: remembered at boot, auto-joined once the player has entered and the
// session is online (after a short grace period in case the server restores a room on resume).
// Account mode (Workers, room-net.js): the join is an application sent from the menu; a logged-out
// player keeps the invite, and the login brings it back (account.js returnPath, githubLoginUrl).
// Reloading a tab that already passed the title re-enters automatically (sessionStorage flag) and
// resumes the server session with the saved token; stale room/match state is dropped if the
// server does not re-push it within RESTORE_GRACE_MS after `welcome`. Boot waits for
// `identity.init()` (which token this tab may use without stealing another live tab's session)
// before the first connect; a page restored from the back/forward cache reloads. In account mode
// the token resumes the account's seat (RoomNet.restore), and the menu forgets it.
// A `welcome` with a NEW playerId (the server restarted / the session expired) while a room or match was on screen:
// toast 「服务器会话已重置，上一局模拟已结束」 (store.js sessionResetNotice) and return to the lobby with nothing stale.
//
// Shared modules are imported relatively ('../../shared/…' resolves to /shared/… in the browser).
// Multi-device support (ui/device.js + css/devices.css): feature classes on <html>, no page zoom, safe areas, rotation
// re-layout; ui/compat.js polyfills are imported before anything else.
// 干员调配 (DESIGN §16): an overlay over any route (<LoadoutHost/>, opened from lobby / room / briefing); its loadout is
// kept in sync with the server by installLoadoutSync (room.loadout after every welcome and edit), its 干员持有 tab's
// not-owned list (0.2.0 补位) by installOwnershipSync (room.ownership, likewise), the 自选编队 picks (0.2.0 DIY) by
// installDiySync (room.diy, likewise; it also keeps welcome.diyKitted for the picker).
// Game data: every text of the game is static data (/data/*.json) downloaded once per page; the in-match files are
// warmed in the background as soon as the player is in a room (warmGameData), before the match needs them.
// Language (ui/lang.js, docs/I18N.md): chosen before the first render (initLang); App re-renders on a switch (useLang).
// Server texts are translated on arrival: m.toast / m.ticker frames (msgid + params, or the text as a msgid; a
// config.broadcasts line from its id + args), error codes (ui/toasts.js describeError) and room.closed reasons.

// Polyfills first (older Safari / Firefox ESR): every module evaluated after this one sees them.
import './ui/compat.js';
import { preferences } from './preferences.js';
import { render } from '../vendor/preact.module.js';
import { useErrorBoundary } from '../vendor/hooks.module.js';
import { html, UiHosts, Button, MicroLabel, closeAllDialogs } from './ui/components.js';
import { ConnectionBanner } from './ui/connBanner.js';
import { ToastHost, toast, toastError, describeError } from './ui/toasts.js';
import { net, identity, NetError, CLIENT_ERR_TEXT } from './net.js';
import { store, useStore, emptyMatch, selectRoute, sessionResetNotice, isSpectator } from './store.js';
import { data } from './data.js';
import { GAME_FILES } from './ui/gameComponents.js';
import { TitleScreen } from './screens/title.js';
import { sanitizeName } from './names.js';
import { LobbyScreen, rememberRoom, parseRoomParam } from './screens/lobby.js';
import { RoomScreen } from './screens/room.js';
import { GameScreen } from './screens/game.js';
import { installAudio, audio } from './audio.js';
import { settingsStore } from './ui/settings.js';
import { GuideHost } from './ui/guide.js';
import { installDeviceSupport } from './ui/device.js';
import { LoadoutHost } from './screens/loadout.js';
import { installLoadoutSync, installOwnershipSync, installDiySync } from './ui/loadoutSync.js';
import { account, loadAccount } from './account.js';
import { applicationSent } from './ui/accountMenu.js';
import { HistoryScreen } from './screens/history.js';
import { ReplayScreen } from './screens/replay.js';
import { startBuildGuard } from './ui/buildGuard.js';
import { presenceFacts } from './ui/presence.js';
import { initLang, useLang, tickerText } from './ui/lang.js';
import { t, N_, translateWire } from '../../shared/i18n.js';

const RESTORE_GRACE_MS = 1500;
const JOIN_DELAY_MS = 350;
const TICKER_KEEP = 20;
const EMOTE_KEEP = 20;

const SCREENS = { title: TitleScreen, lobby: LobbyScreen, room: RoomScreen, game: GameScreen };

/** Copy of a server message without transport fields. */
function payload(msg) {
  const { t, rid, ...rest } = msg; // eslint-disable-line no-unused-vars
  return rest;
}

function clearRoomParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('room')) return;
    url.searchParams.delete('room');
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore */ }
}

// ---- net → store wiring ---------------------------------------------------------------------------

let seq = 0;
let welcomeAt = 0;
let roomStateAt = 0;
let matchAt = 0;
let restoreTimer = null;
let joinTimer = null;
let joinInFlight = false;

function clearPendingJoin() {
  store.patch('ui', { pendingJoin: null });
  clearRoomParam();
}

/** The player has entered and the client can join a room: online, or (account mode) in the menu. */
const joinReady = (s) => s.session.entered && (s.connection.status === 'online' || s.connection.status === 'menu');

/** Auto-join the deep-linked room once joinReady (idempotent). */
function schedulePendingJoin() {
  clearTimeout(joinTimer);
  joinTimer = setTimeout(async () => {
    const s = store.get();
    const code = s.ui.pendingJoin;
    if (!code || joinInFlight || !joinReady(s)) return;
    // Logged out (account mode): the invite waits for the login, which brings it back.
    if (account.enabled && !account.user) return;
    if (s.room) {
      if (s.room.code !== code) toast(t('你已在其他同盟中，请先离开当前同盟'), 'warn');
      clearPendingJoin();
      return;
    }
    joinInFlight = true;
    try {
      const reply = await net.request('room.join', { code });
      if (reply?.application) applicationSent(code);
    } catch (err) {
      toastError(err);
    } finally {
      joinInFlight = false;
      clearPendingJoin();
    }
  }, JOIN_DELAY_MS);
}

/** End the post-resume "syncing" state early once the server re-pushed what we were showing. */
function maybeFinishRestore() {
  const s = store.get();
  if (!s.ui.restoring) return;
  const roomOk = !s.room || roomStateAt >= welcomeAt;
  const matchOk = !s.match.public || matchAt >= welcomeAt || !s.room?.inMatch;
  if (roomOk && matchOk) {
    clearTimeout(restoreTimer);
    store.patch('ui', { restoring: false });
  }
}

/**
 * Leave whatever room / match was on screen for the lobby with nothing stale left behind: open imperative dialogs,
 * the post-resume restore timer, ticker lines and emote bubbles of the old match (the battle runner and the 暂离 flag
 * follow the store themselves).
 */
function backToLobby() {
  clearTimeout(restoreTimer);
  const s = store.get();
  if (s.room || s.match.public) closeAllDialogs();
  store.set({ room: null, match: emptyMatch(), ticker: [], emotes: [] });
  store.patch('ui', { restoring: false });
}

function onWelcome(msg) {
  // Only an online session's token is worth resuming: a welcome RoomNet turned away (its room is over) left it in the menu.
  if (net.status === 'online') identity.saveToken(msg.token);
  const prev = store.get();
  const prevId = prev.me.playerId;
  const name = typeof msg.name === 'string' && msg.name ? msg.name : prev.me.name;
  store.set({ me: { playerId: msg.playerId ?? null, name, token: typeof msg.token === 'string' ? msg.token : null } });
  welcomeAt = Date.now();

  if (prevId != null && prevId !== msg.playerId) {
    // A brand-new server session (the server restarted — crashed / killed, so no room.closed arrived — or this session
    // expired on it): whatever we showed before is gone — back to the lobby cleanly and say why.
    const notice = sessionResetNotice(prev, msg.playerId);
    backToLobby();
    if (notice) toast(t(notice), 'warn', { ttl: 7000 });
  } else if (prev.room || prev.match.public) {
    // Resumed session: the server re-pushes room/match state; drop whatever it doesn't.
    store.patch('ui', { restoring: true });
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      const s = store.get();
      const patch = {};
      if (s.room && roomStateAt < welcomeAt) patch.room = null;
      if (s.match.public && matchAt < welcomeAt) patch.match = emptyMatch();
      store.set(patch);
      store.patch('ui', { restoring: false });
    }, RESTORE_GRACE_MS);
  }
}

function onRoomState(msg) {
  const room = payload(msg);
  roomStateAt = Date.now();
  const myId = store.get().me.playerId;
  const seats = Array.isArray(room.seats) ? room.seats : [];
  if (myId != null && seats.length && !seats.some((s) => s && s.playerId === myId) && !isSpectator(room, myId)) {
    // We are no longer seated (kicked / left elsewhere) — neither in a player seat nor a spectator (a spectator seat,
    // or a public match's spectator: it has no seat).
    if (store.get().room) toast(t('你已不在该同盟中'), 'warn');
    store.set({ room: null, match: emptyMatch() });
    return;
  }
  const prevRoom = store.get().room;
  // A (new) match starts: forget the previous match's state so stale results never show.
  if (room.inMatch && !(prevRoom && prevRoom.inMatch && prevRoom.code === room.code)) store.set({ match: emptyMatch() });
  store.set({ room });
  if (room.mode === 'coop' && typeof room.code === 'string') rememberRoom(room.code);
  maybeFinishRestore();
}

const CLOSE_REASON = {
  // 'timeout' = this player was removed after staying disconnected past the lobby grace (server/lobby.js)
  host_left: N_('创建者已离开，同盟已解散'), timeout: N_('由于长时间断开连接，你已离开同盟'), empty: N_('同盟已解散'),
  kicked: N_('你已被移出同盟'), ended: N_('模拟已结束'), expired: N_('同盟已过期'), shutdown: N_('服务器维护中，同盟已关闭'),
  restart: N_('服务器已更新或重启，本局已结束，请重新创建房间'),
  // account mode: the page was reloaded before its room was created; creating again finishes the reserved room
  unfinished: N_('房间尚未创建完成，请重新创建'),
  // account mode (room-net.js): 继续对局 on another page or device took this seat over
  replaced: N_('已在其他页面或设备继续对局'),
  // account mode: the room Worker cannot restore a match recorded by a newer deployment (a rollback)
  rollback: N_('服务器版本已回退，本局无法继续'),
};

function wireNet() {
  net.on('status', (snap) => {
    const cur = store.get().connection;
    // Account mode: back in the menu the tab is in no room, so its room token goes (a reload must not resume a room
    // the player left).
    if (snap.status === 'menu' && cur.status !== 'menu') identity.clearToken();
    store.set({
      connection: {
        status: snap.status, ping: snap.ping, attempt: snap.attempt, retryAt: snap.retryAt,
        lastError: snap.lastError, everOnline: cur.everOnline || snap.status === 'online',
      },
    });
  });
  net.on('clock', (c) => store.set({ clock: { offset: c.offset, rtt: c.rtt, synced: c.synced } }));
  net.on('welcome', onWelcome);
  net.on('helloError', (err) => toastError(err));
  net.on('replaced', () => toast(t('该身份已在其他页面登录，本页已断开'), 'warn', { ttl: 6000 }));
  net.on('unhandledError', (err) => toastError(err));
  net.on('room.state', onRoomState);
  // 匹配 (matchmaking queue): the queue the player waits in, and the room the server put it in
  net.on('queue.status', (msg) => {
    store.set({ queue: { ...payload(msg), matched: null } });
    // the account Worker's queue could not open its group's room (room-net.js; the Node server sends an error frame)
    if (msg.error) toastError(msg.error);
  });
  net.on('queue.matched', (msg) => {
    // `expect`: the humans a matched host waits for before AI teammates take the free seats (account mode only)
    store.patch('queue', { matched: { code: msg.code, difficulty: msg.difficulty, seated: !!msg.seated,
      expect: Number.isInteger(msg.expect) ? msg.expect : 0 } });
  });
  // 在线人数 (ui/presence.js): the live counters next to the version (title footer / lobby top bar). The server pushes
  // them once after `welcome` and again whenever they change; a page without the frames polls /healthz instead.
  net.on('presence', (msg) => store.set({ presence: { ...presenceFacts(msg), via: 'frame' } }));
  net.on('room.closed', (msg) => {
    // A match that ended with a result to show (spectators get it after room.closed: worker/rooms/spectators.js) stays on
    // screen for its final view and result; the result screen leads back to the lobby. Anything else leaves at once.
    if (msg.reason === 'ended' && msg.result && store.get().match.public) store.set({ room: null });
    else backToLobby();
    const known = Object.hasOwn(CLOSE_REASON, String(msg.reason)) ? CLOSE_REASON[msg.reason] : null;
    toast(known ? t(known) : typeof msg.reason === 'string' && msg.reason.length < 60 ? t('同盟已关闭：{reason}', { reason: msg.reason }) : t('同盟已关闭'), 'warn');
  });
  net.on('m.public', (msg) => { matchAt = Date.now(); store.patch('match', { public: payload(msg) }); maybeFinishRestore(); });
  net.on('m.private', (msg) => { matchAt = Date.now(); store.patch('match', { private: payload(msg) }); });
  net.on('m.field', (msg) => store.patch('match', { field: payload(msg) }));
  net.on('m.result', (msg) => store.patch('match', { result: payload(msg) }));
  net.on('m.toast', (msg) => {
    const kind = ['info', 'success', 'warn', 'error'].includes(msg.kind) ? msg.kind : 'info';
    // msgid + params (server ≥ 0.2.0) or the text itself as a msgid, in the current language
    toast(translateWire(msg), kind);
  });
  net.on('m.ticker', (msg) => {
    if (typeof msg.text !== 'string') return;
    const text = tickerText(msg);
    // type, player + the round it came in: a BOSS_HIT line is dropped once its boss round is over and superseded by the
    // same player's next one (ui/ticker.js tickerLineLive / tickerSupersedes)
    const type = typeof msg.type === 'string' ? msg.type : null;
    const playerId = typeof msg.playerId === 'string' ? msg.playerId : null;
    // its broadcast priority: the strip plays the highest first (ui/ticker.js enqueueTickerLines)
    const priority = Number.isFinite(msg.priority) ? msg.priority : 0;
    store.set((s) => ({ ticker: [...s.ticker.slice(-(TICKER_KEEP - 1)), { id: ++seq, text, at: Date.now(), type, playerId, round: s.match?.public?.round ?? null, priority }] }));
  });
  net.on('m.emote', (msg) => {
    store.set((s) => ({ emotes: [...s.emotes.slice(-(EMOTE_KEEP - 1)), { seq: ++seq, playerId: msg.playerId, id: msg.id, at: Date.now() }] }));
  });

  // The deep-link join goes out once the player has entered and the client can join (whichever comes last).
  store.subscribe((s, prev) => {
    if (joinReady(s) && !joinReady(prev)) schedulePendingJoin();
    // in a room (co-op or solo, also a resumed one) a match is near: its data starts downloading
    if (s.room && !prev.room) warmGameData();
    // an approved join application enters the room from any page: the account pages give way to it
    if (s.room && !prev.room && s.ui.accountPage) store.patch('ui', { accountPage: null });
    // 匹配: the queue put this player in a room — join it like a deep link would (once, while not already inside)
    if (s.queue.matched && s.queue.matched !== (prev.queue && prev.queue.matched) && s.queue.matched.seated) {
      const code = s.queue.matched.code;
      if (!s.room) {
        store.patch('ui', { pendingJoin: code });
        schedulePendingJoin();
      }
    }
  });
}

/**
 * Download every data file of the match UI (gameComponents GAME_FILES: operators, skills, bonds, items, enemies, 特质 …)
 * and the render engine's scripts in the background once the player is in a room — a match is near (the lobby alone never downloads them). The game's
 * texts are static data loaded once per page — never fetched during a match — and the match screen waits for these
 * files, so with them warmed it opens at once and no text ever appears late (user playtest #3 item 9). Idempotent (the
 * data store shares each file's promise).
 */
function warmGameData() {
  const go = () => {
    data.loadAll(GAME_FILES).catch(() => {});
    // the render engine too (its module graph + Pixi / pixi-spine): on a phone link the match's first field otherwise
    // waits for them (ui/fieldHost.js) — the 3D board's art stays lazy, it upgrades the 2D board when it lands
    import('./render/app.js').then((m) => m.ensurePixi?.()).catch(() => {});
    import('./assets.js').catch(() => {});
  };
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(go, { timeout: 2500 });
  else setTimeout(go, 600);
}

// ---- UI chrome (the connection banner lives in ui/connBanner.js) -----------------------------------

function ScreenCrashed({ error, reset }) {
  return html`<div class="screen crash">
    <div class="crash__box brackets">
      <${MicroLabel} tone="mint">SYSTEM FAULT<//>
      <h2>${t('界面发生错误')}</h2>
      <p class="t-lo">${String(error?.message || error).slice(0, 200)}</p>
      <${Button} variant="primary" icon="refresh" onClick=${reset}>${t('重新加载界面')}<//>
    </div>
  </div>`;
}

function App() {
  const route = useStore(selectRoute);
  const accountPage = useStore(s => s.ui.accountPage);
  useLang(); // a language switch re-renders the whole tree in place
  const [error, resetError] = useErrorBoundary((err) => console.error('[ui] screen crashed', err));
  const Screen = accountPage === 'replay' ? ReplayScreen : accountPage ? HistoryScreen : SCREENS[route] || LobbyScreen;
  return html`<div class="app-root">
    <div class="app-bg" aria-hidden="true"></div>
    ${error ? html`<${ScreenCrashed} error=${error} reset=${resetError} />` : html`<${Screen} key=${accountPage || route} statistics=${accountPage === 'statistics'} />`}
    <${ConnectionBanner} />
    <${ToastHost} />
    <${UiHosts} />
    <${GuideHost} />
    <${LoadoutHost} />
  </div>`;
}

// ---- boot -----------------------------------------------------------------------------------------

async function waitForFonts(ms) {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  const loads = [
    fonts.load('900 1em "Noto Sans SC"', '卫戍协议盟约'), // i18n-ignore (font sample)
    fonts.load('700 1em "Noto Sans SC"', '开始'), // i18n-ignore (font sample)
    fonts.load('700 1em Bender', '0123456789'),
    fonts.load('700 1em Rajdhani', '0123456789'),
  ].map((p) => p.catch(() => null));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, ms))]);
}

function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (ev) => {
    const err = ev.reason;
    // Media autoplay/abort rejections (audio.play() before a user gesture, interrupted loads) are
    // expected browser behaviour, not app errors: log quietly, never toast.
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) { console.warn('[app] ignored rejection', err.name); return; }
    console.error('[app] unhandled rejection', err);
    if (err instanceof NetError) toastError(err);
    else toast(t('发生意外错误：{error}', { error: describeError(err) }).slice(0, 120), 'error');
  });
  window.addEventListener('error', (ev) => {
    if (!(ev instanceof ErrorEvent)) return; // resource load errors are not script errors
    console.error('[app] uncaught error', ev.error || ev.message);
  });
}

async function boot() {
  installGlobalErrorHandlers();
  // touch / hover / fullscreen classes, zoom-gesture blocking, rotation re-layout (ui/device.js, css/devices.css)
  installDeviceSupport();
  // the language (and its UI translations) before the first render: no Chinese flash for an English player — and before
  // the Cloudflare page's first-visit resource dialog, which shows ahead of the App
  const langReady = initLang().catch((err) => console.warn('[app] language setup failed', err));
  if (document.documentElement.dataset.spRuntime === 'cloudflare') {
    await loadAccount();
    if (account.enabled) await preferences.start(account.user?.accountId);
    net.followAccount(account);
    const resources = await import('./resources/index.js');
    await langReady;
    await resources.prepareResources();
    resources.installResourceManager();
  }
  // A page restored from the back/forward cache has a dead socket and a stale token choice: start over.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  // Pick this tab's reconnect token (asks other live tabs; ≤150 ms) while fonts load.
  const identityReady = identity.init();

  const pendingJoin = parseRoomParam(location.search);
  // Account mode: the page shows the account's display name (昵称#NNNN, up to 17 characters); the room names the session
  // after the account, so the hello's name (at most NAME_MAX_LEN) is not used there.
  const savedName = account.user ? account.user.name : sanitizeName(identity.loadName());
  const entered = !!account.user || identity.wasEntered() && !!savedName;
  store.set((s) => ({
    me: { ...s.me, name: savedName },
    session: { entered },
    ui: { ...s.ui, pendingJoin },
  }));

  wireNet();
  installLoadoutSync({ net });
  installOwnershipSync({ net });
  installDiySync({ net });
  net.attachBrowserHooks();
  // Audio: unlock on first gesture, BGM and the battle voice follow the route / match (js/audio.js).
  installAudio({ getManifest: () => data.get('assets'), subscribe: store.subscribe, getState: store.get, selectRoute, settings: settingsStore.get() });
  data.load('assets').catch(() => {});
  // Warm the data cache in the background (missing files are tolerated).
  data.loadAll('config').catch(() => {});
  // Optional local-client art manifest (emotes, tutorial pages, official UI sprites; DESIGN §13).
  data.load('local').catch(() => {});

  const connectWhenReady = identityReady.then(() => {
    // Account mode: a reload, or a tab the browser discarded, mid-match resumes this tab's seat. That room's socket is
    // the first connection; without one the client starts in the menu (which forgets the token, see wireNet).
    if (account.enabled) net.restore(identity.getToken(), account.activeSeat).catch((err) => toastError(err));
    if (entered) net.setName(sanitizeName(savedName));
    else net.connect();
  });
  await Promise.all([waitForFonts(1200), connectWhenReady, langReady]);
  const root = document.getElementById('app');
  render(html`<${App} />`, root);
  // A GitHub login that did not complete came back with the code of what went wrong (worker/accounts/github.js).
  const authError = new URLSearchParams(location.search).get('authError');
  if (authError !== null) {
    toast(authError === 'GITHUB_UNAVAILABLE' ? t(CLIENT_ERR_TEXT.GITHUB_UNAVAILABLE) : t('GitHub 登录未完成，请重试'), 'warn');
    const url = new URL(location.href);
    url.searchParams.delete('authError');
    history.replaceState(null, '', url.pathname + url.search);
  }

  const splash = document.getElementById('boot');
  if (splash) {
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 300);
  }
  globalThis.__SP__ = { store, net, data, audio, version: 1 };
  // A page keeps the modules it imported at load time for its whole lifetime, so a deploy cannot reach an open tab
  // (ui/buildGuard.js): watch `/healthz.build`. Outside a match the page reloads itself; during a match the guard says
  // so instead (the connection banner offers 刷新页面) and reloads once the match — settlement screen included — is over,
  // so a running game is never thrown away.
  try {
    startBuildGuard({
      inMatch: () => selectRoute(store.get()) === 'game',
      onStale: ({ waiting }) => { if (waiting) store.patch('ui', { buildStale: true }); },
    });
  } catch (err) {
    console.warn('[app] build guard failed to start', err);
  }
}

boot().catch((err) => {
  console.error('[app] boot failed', err);
  const el = document.getElementById('boot-err');
  if (el) el.textContent = t('启动失败，请刷新页面重试');
});
