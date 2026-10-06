// Room screen (同盟等待室): one seat card per seat of the room (avatar frame, name, ready state, AI badge, host crown) —
// the room's capacity (room.state.capacity): 4 cards in one row as in the official room, 5–8 (a remake extension) in two
// rows of 4 smaller cards —, host controls (difficulty picker, 同盟席位 picker 4–8 in co-op, add/remove AI in co-op,
// start), invite code with copy code / copy link, ready toggle and leave.
//
// Start rule (server/lobby.js): room.start needs every *other* human connected and ready; the
// host's start counts as the host's ready. So 开始模拟 is enabled exactly then and sends room.start
// alone (no separate room.ready round trip that could leave the host "ready" after a failed start).
// Solo rooms show a single seat.
// Spectator seats (community report #26, a remake feature): a co-op room with spectators shows the 观战席 strip under
// the seats — names, offline marks, the host's ✕ (room.removeSpectator) — and a spectator's own view swaps the ready
// button for 观战中 and offers 入座 (room.join of the room) while a player seat is free.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, MAX_SEATS, DEFAULT_SEATS, MAX_SPECTATORS } from '../../../shared/constants.js';
import {
  html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyTag, DifficultyIcon, Tooltip, confirmDialog, doctorNo, PlayerName,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { copyText } from '../ui/clipboard.js';
import { GuideButton } from '../ui/guide.js';
import { ResourceButton } from '../ui/resourceButton.js';
import { useWakeLock } from '../ui/device.js';
import { LoadoutButton } from './loadout.js';
import { net } from '../net.js';
import { account } from '../account.js';
import { data, useData } from '../data.js';
import { chessAvatarUrl, bandIconUrl } from '../ui/assetUrls.js';
import { Applications } from '../ui/accountMenu.js';
import { store, useStore, shallowEqual, emptyMatch, isSpectating } from '../store.js';
import { difficultyInfo } from './lobby.js';

/**
 * The room's player seats: solo 1; co-op room.state `capacity` (else its seat list's length), DEFAULT_SEATS..MAX_SEATS.
 * @param {any} room room.state payload
 * @returns {number}
 */
export function roomCapacity(room) {
  if (room?.mode === 'solo') return 1;
  const n = Number.isInteger(room?.capacity) ? room.capacity : Array.isArray(room?.seats) ? room.seats.length : 0;
  return Math.min(MAX_SEATS, Math.max(DEFAULT_SEATS, n));
}

/**
 * Seats padded to the room's capacity (roomCapacity: co-op 4–8, solo 1), each null or a seat record.
 * @param {any} room room.state payload
 * @returns {(null | {seat:number, playerId:any, name:string, isBot:boolean, ready:boolean, connected:boolean})[]}
 */
export function normalizeSeats(room) {
  const cap = roomCapacity(room);
  const src = Array.isArray(room?.seats) ? room.seats : [];
  const out = [];
  for (let i = 0; i < cap; i++) {
    const s = src[i];
    out.push(s && typeof s === 'object' ? { ...s, seat: Number.isInteger(s.seat) ? s.seat : i } : null);
  }
  return out;
}

/**
 * Derived room facts for the local player.
 * @param {any} room
 * @param {any} myId
 */
export function roomFacts(room, myId) {
  const seats = normalizeSeats(room);
  const occupied = seats.filter(Boolean);
  const humans = occupied.filter((s) => !s.isBot);
  const mine = occupied.find((s) => s.playerId === myId) || null;
  const isHost = room?.hostId != null && room.hostId === myId;
  const others = humans.filter((s) => s.playerId !== myId);
  // The host never readies: starting the match is the host's ready (server rule), so the count
  // treats the host as ready — "已就绪 0/1" next to "准许进入模拟" would contradict itself.
  const isReady = (s) => !!s.ready || s.playerId === room?.hostId;
  const readyHumans = humans.filter(isReady).length;
  const othersReady = others.every((s) => s.ready && s.connected !== false);
  return {
    seats, occupied, humans, mine, isHost, readyHumans, isReady,
    capacity: seats.length,
    emptySeats: seats.filter((s) => !s).length,
    canStart: isHost && othersReady && !!mine,
    othersReady,
    // spectator seats (never players: not in `humans`, never counted for ready / start)
    spectators: Array.isArray(room?.spectators) ? room.spectators.filter((s) => s && typeof s === 'object') : [],
    spectating: isSpectating(room, myId),
  };
}

/** Invite link for a room code (current page URL with ?room=CODE). */
export function inviteLink(code) {
  const loc = globalThis.location;
  const base = loc ? `${loc.origin}${loc.pathname}` : '';
  return `${base}?room=${encodeURIComponent(code)}`;
}

/**
 * Copy text to the clipboard (async API with a textarea fallback for insecure contexts). Moved to ui/clipboard.js so
 * 干员调配 can use it without importing this screen (which imports loadout.js): re-exported here for existing callers.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export { copyText };

function SeatCard({ seat, index, room, facts, myId, busy, onAddBot, onRemoveBot, onKick }) {
  useData('chess', 'assets', 'bands');
  const coop = room.mode !== 'solo';
  if (!seat) {
    const canAdd = coop && facts.isHost;
    return html`<article class="seat seat--empty" style=${`--seat-i:${index}`}>
      <header class="seat__head"><span class="seat__no num">P${index + 1}</span><${MicroLabel}>SEAT ${String(index + 1).padStart(2, '0')}<//></header>
      <div class="seat__art seat__art--empty">
        <div class="seat__radar" aria-hidden="true"></div>
        <span class="seat__wait">等待博士加入</span>
        <${MicroLabel}>AWAITING DOCTOR<//>
      </div>
      <footer class="seat__foot">
        ${canAdd
          ? html`<${Button} variant="secondary" size="sm" icon="robot" block=${true} loading=${busy === `add`} onClick=${onAddBot}>添加 AI 队友<//>`
          : html`<span class="seat__state t-dim">空位</span>`}
      </footer>
    </article>`;
  }
  const isMe = seat.playerId === myId;
  const botCharacter = seat.isBot && Object.values(data.get('chess') || {}).find(c => !c.isGolden && c.name === seat.name.replace(/^AI[·・\s]*/, ''));
  const botBand = seat.isBot && Object.values(data.get('bands') || {}).find(b => b.name === seat.name.replace(/^AI[·・\s]*/, ''));
  const avatar = seat.isBot ? chessAvatarUrl(data.get('assets'), botCharacter) || bandIconUrl(data.get('assets'), botBand?.bandId) : seat.avatarUrl || (isMe ? account.user?.avatarUrl : null);
  const isHostSeat = seat.playerId === room.hostId;
  const offline = seat.connected === false && !seat.isBot;
  // The host never needs to toggle ready: starting the match readies them (server rule).
  const state = offline ? 'offline' : seat.ready || seat.isBot ? 'ready' : isHostSeat ? 'host' : 'waiting';
  return html`<article class=${`seat brackets${isMe ? ' is-me' : ''}${isHostSeat ? ' is-host' : ''}${seat.isBot ? ' is-bot' : ''} is-${state}`}
      style=${`--seat-i:${index}`}>
    <header class="seat__head">
      <span class="seat__no num">P${index + 1}</span>
      <${MicroLabel}>SEAT ${String(index + 1).padStart(2, '0')}<//>
      ${isHostSeat ? html`<span class="seat__host"><${Icon} name="crown" />创建者</span>` : null}
    </header>
    <div class="seat__art">
      <div class="seat__stripes" aria-hidden="true"></div>
      <${AvatarFrame} size="xl" name=${seat.name} src=${avatar} seat=${index} bot=${seat.isBot} self=${isMe} ready=${state === 'ready'} offline=${offline} />
      ${seat.isBot ? html`<span class="seat__bot-label"><${Icon} name="robot" />AI 队友</span>` : null}
    </div>
    <div class="seat__who">
      <span class="seat__name" title=${seat.name || '博士'}><${PlayerName} name=${seat.name || '博士'} /></span>
      ${isMe ? html`<span class="seat__you">你</span>` : null}
    </div>
    <${MicroLabel}>${seat.isBot ? 'AUTONOMOUS UNIT' : account.enabled ? 'DOCTOR' : `DOCTOR #${doctorNo(seat.playerId)}`}<//>
    <footer class="seat__foot">
      <span class=${`seat__state seat__state--${state}`}>
        ${state === 'ready' ? html`<${Icon} name="check" />已就绪`
          : state === 'offline' ? html`<${Icon} name="wifiOff" />连接中断`
          : state === 'host' ? html`<${Icon} name="crown" />待命中`
          : html`<${Icon} name="hourglass" />准备中`}
      </span>
      ${seat.isBot && facts.isHost ? html`<${Tooltip} text="移除该 AI 队友">
        <${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rm${index}`} onClick=${() => onRemoveBot(index)} aria-label="移除 AI 队友" />
      <//>` : null}
      ${!seat.isBot && !isMe && facts.isHost ? html`<${Tooltip} text="将该博士移出同盟">
        <${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `kick${index}`} onClick=${() => onKick(index, seat.name, seat.playerId)} aria-label="移出该博士" />
      <//>` : null}
    </footer>
  </article>`;
}

/** 观战席: the room's spectators (host: ✕ frees a seat), and 入座 for a spectator while a player seat is free. */
function SpectatorBar({ facts, myId, busy, onRemove, onSit }) {
  if (!facts.spectators.length) return null;
  return html`<section class="specbar" aria-label="观战席">
    <span class="specbar__label"><${Icon} name="eye" />观战席<b class="num">${facts.spectators.length}</b><span class="num t-dim">/${MAX_SPECTATORS}</span></span>
    ${facts.spectators.map((s) => html`<span key=${s.playerId} class=${`specbar__who${s.playerId === myId ? ' is-me' : ''}${s.connected === false ? ' is-offline' : ''}`}>
      ${s.connected === false ? html`<${Icon} name="wifiOff" />` : null}${s.name || '博士'}${s.playerId === myId ? html`<span class="seat__you">你</span>` : null}
      ${facts.isHost ? html`<${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rs${s.playerId}`}
        onClick=${() => onRemove(s.playerId)} aria-label=${`移出观战者 ${s.name || ''}`} title="移出该观战者" />` : null}
    </span>`)}
    ${facts.spectating && facts.emptySeats > 0 ? html`<${Button} size="sm" icon="user" loading=${busy === 'sit'} onClick=${onSit}>入座<//>` : null}
  </section>`;
}

function InviteBox({ code, name, difficulty }) {
  const copy = async (what) => {
    const ok = await copyText(what === 'code' ? code : `${inviteLink(code)} ${name}邀请你加入卫戍协议：盟约【${DIFFICULTY_NAMES[difficulty]}】`);
    if (ok) toast(what === 'code' ? `已复制同盟密钥 ${code}` : '已复制邀请链接', 'success');
    else toast('复制失败，请手动复制', 'warn');
  };
  return html`<div class="invite brackets">
    <div class="invite__label"><${Icon} name="key" /><span>同盟密钥</span><${MicroLabel}>ALLIANCE KEY<//></div>
    <div class="invite__code num selectable" aria-label=${`同盟密钥 ${code}`}>${[...String(code)].map((ch, i) => html`<span key=${i}>${ch}</span>`)}</div>
    <div class="invite__btns">
      <${Button} size="sm" icon="copy" onClick=${() => copy('code')}>复制密钥<//>
      <${Button} size="sm" icon="link" onClick=${() => copy('link')}>复制链接<//>
    </div>
  </div>`;
}

function DifficultyPicker({ room, isHost, busy, onPick }) {
  if (!isHost) {
    return html`<div class="dpick dpick--ro">
      <${DifficultyTag} difficulty=${room.difficulty} size="lg" code=${difficultyInfo(room.mode, room.difficulty).code} />
      <span class="t-dim">由创建者选择</span>
    </div>`;
  }
  return html`<div class="dpick" role="radiogroup" aria-label="模拟难度">
    ${DIFFICULTIES.map((d) => html`<button key=${d} type="button" role="radio" aria-checked=${room.difficulty === d ? 'true' : 'false'}
        class=${`dpick__opt${room.difficulty === d ? ' is-active' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[d]}`}
        disabled=${!!busy} onClick=${() => room.difficulty !== d && onPick(d)}>
      <${DifficultyIcon} difficulty=${d} />${DIFFICULTY_NAMES[d].replace('模拟', '')}
    </button>`)}
  </div>`;
}

/**
 * 同盟席位 (host, co-op): the room's seat count, DEFAULT_SEATS..MAX_SEATS (above 4 a remake extension). A size below the
 * occupied seats is disabled (the server refuses it too).
 */
function CapacityPicker({ facts, busy, onPick }) {
  const sizes = [];
  for (let n = DEFAULT_SEATS; n <= MAX_SEATS; n++) sizes.push(n);
  return html`<div class="dpick cpick" role="radiogroup" aria-label="同盟席位">
    ${sizes.map((n) => html`<button key=${n} type="button" role="radio" aria-checked=${facts.capacity === n ? 'true' : 'false'}
        class=${`dpick__opt cpick__opt num${facts.capacity === n ? ' is-active' : ''}`}
        title=${n < facts.occupied.length ? '席位不能少于已入座的博士与 AI 队友' : `${n} 席${n > DEFAULT_SEATS ? '（扩展：超过官方 4 人上限）' : ''}`}
        disabled=${!!busy || n < facts.occupied.length} onClick=${() => facts.capacity !== n && onPick(n)}>${n}</button>`)}
  </div>`;
}

/** Room screen component. */
export function RoomScreen() {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);
  useWakeLock();   // waiting for the others with the phone in hand: no lock screen while the room is open

  if (!room) return null;
  const online = conn.status === 'online';
  const coop = room.mode !== 'solo';
  const facts = roomFacts(room, me.playerId);
  const myReady = !!facts.mine?.ready;
  const info = difficultyInfo(room.mode, room.difficulty);

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast('连接中断，请稍候重试', 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const toggleReady = () => run('ready', () => net.request('room.ready', { ready: !myReady }));
  const start = () => run('start', () => net.request('room.start', {}));
  const addBot = () => run('add', () => net.request('room.addBot', {}));
  const removeBot = (seat) => run(`rm${seat}`, () => net.request('room.removeBot', { seat }));
  // the host removes a human before the match (community report #17): asked first; the player may join again. The
  // confirmed player's id goes along: if they left and someone else took the seat meanwhile, the server refuses it.
  const kick = async (seat, name, playerId) => {
    if (inFlight.current) return;
    const ok = await confirmDialog({ title: '移出同盟', text: `确定将「${name || '博士'}」移出同盟吗？对方可以凭同盟密钥重新加入。`, okText: '移出', danger: true });
    if (ok) run(`kick${seat}`, () => net.request('room.kick', { seat, playerId }));
  };
  const setDifficulty = (difficulty) => run('diff', () => net.request('room.setDifficulty', { difficulty }));
  const setCapacity = (capacity) => run('cap', () => net.request('room.setCapacity', { capacity }));
  // spectator seats: the host frees one; a spectator takes a free player seat with room.join of this room
  const removeSpectator = (playerId) => run(`rs${playerId}`, () => net.request('room.removeSpectator', { playerId }));
  const sit = () => run('sit', () => net.request('room.join', { code: room.code }));
  const leave = async () => {
    if (inFlight.current) return;
    const othersHere = facts.humans.some((s) => s.playerId !== me.playerId);
    if (facts.isHost && othersHere) {
      const ok = await confirmDialog({ title: '离开同盟', text: '你是同盟的创建者，离开后创建者身份将移交或同盟解散。确定离开吗？', okText: '离开', danger: true });
      if (!ok) return;
    }
    inFlight.current = true;
    setBusy('leave');
    try {
      await net.request('room.leave', {});
    } catch (err) {
      if (err?.code !== 'NOT_IN_ROOM') toastError(err);
    } finally {
      // Leaving locally is always safe: the server either confirmed or no longer has us in the room.
      store.set({ room: null, match: emptyMatch() });
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const statusLine = !online
    ? html`<span class="t-orange"><${Icon} name="wifiOff" />连接中断，正在重连…</span>`
    : facts.spectating
      ? html`<span class="t-lo"><${Icon} name="eye" />观战中 · 不占博士席位，模拟开始后可切换观看各位博士</span>`
    : !coop
      ? html`<span class="t-mint">*模拟协议已就绪，准许进入模拟</span>`
    : facts.isHost
      ? facts.canStart
        ? html`<span class="t-mint">*同盟人数达标，准许进入模拟</span>`
        : html`<span class="t-lo">等待所有博士准备就绪</span>`
      : myReady
        ? html`<span class="t-mint">已就绪 · 等待创建者开始模拟</span>`
        : html`<span class="t-lo">准备就绪后，创建者即可开始模拟</span>`;

  return html`<div class="screen room-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${Tooltip} text="离开同盟" placement="bottom">
          <${Button} variant="danger" size="lg" square=${true} icon="exit" loading=${busy === 'leave'} onClick=${leave} aria-label="离开同盟" />
        <//>
        <div class="room-ping">
          <${PingPill} ms=${conn.ping} online=${online} />
          <${MicroLabel}>当前延迟<//>
        </div>
        <${GuideButton} class="room-guide" variant="secondary" />
        <${ResourceButton} class="room-res" variant="secondary" />
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">${coop ? 'ALLIANCE LOBBY' : 'SOLO SIMULATION'}<//>
        <h1 class="topbar__title">${coop ? '同盟模拟' : '独立模拟'}<span class="topbar__sep"></span><${DifficultyTag} difficulty=${room.difficulty} size="lg" /></h1>
      </div>
      <div class="topbar__right">
        ${coop ? html`<${InviteBox} code=${room.code} name=${me.name} difficulty=${room.difficulty} />` : html`<div class="solo-note"><${MicroLabel}>SINGLE OPERATOR<//><span>仅限 1 名博士</span></div>`}
      </div>
    </header>

    <main class=${`seats${coop ? '' : ' seats--solo'}${facts.capacity > DEFAULT_SEATS ? ' seats--wide' : ''}`}>
      ${facts.seats.map((s, i) => html`<${SeatCard} key=${s ? `p${s.playerId}` : `e${i}`} seat=${s} index=${i} room=${room} facts=${facts}
        myId=${me.playerId} busy=${busy} onAddBot=${addBot} onRemoveBot=${removeBot} onKick=${kick} />`)}
      ${coop ? null : html`<aside class="solo-brief brackets">
        <${MicroLabel} tone="mint">BRIEFING<//>
        <h2>${DIFFICULTY_NAMES[room.difficulty] || ''}<span class="num t-dim"> ${info.code}</span></h2>
        <p>${info.desc}</p>
        <ul>
          ${info.effects.map((e) => html`<li key=${e}>${e}</li>`)}
          <li>共 <b class="num">${info.rounds}</b> 回合${info.hidden ? '，满足条件时进入隐秘核心' : ''}</li>
          <li>独立模拟中休整期与机变阶段不限时</li>
        </ul>
      </aside>`}
    </main>
    <${SpectatorBar} facts=${facts} myId=${me.playerId} busy=${busy} onRemove=${removeSpectator} onSit=${sit} />

    ${account.enabled && coop && facts.isHost?html`<${Applications} code=${room.code} />`:null}
    <footer class="room-bar">
      <div class=${`room-bar__left${coop && facts.isHost ? ' has-seats' : ''}`}>
        <span class="room-bar__label">模拟难度<${MicroLabel}>DIFFICULTY<//></span>
        <${DifficultyPicker} room=${room} isHost=${facts.isHost} busy=${busy} onPick=${setDifficulty} />
        ${coop && facts.isHost ? html`<span class="room-bar__label">同盟席位<${MicroLabel}>SEATS<//></span>
          <${CapacityPicker} facts=${facts} busy=${busy} onPick=${setCapacity} />` : null}
      </div>
      <div class="room-bar__center">
        <div class="ready-count" hidden=${!coop}>
          <span class="t-lo">已就绪</span>
          <b class="num">${facts.readyHumans}</b><span class="num t-dim">/${facts.humans.length}</span>
          <span class=${`ready-count__icons${facts.humans.length > DEFAULT_SEATS ? ' is-many' : ''}`} aria-hidden="true">
            ${facts.humans.map((s) => html`<${Icon} key=${s.playerId} name="user" class=${facts.isReady(s) ? 'is-on' : ''} />`)}
          </span>
        </div>
        <div class="room-bar__status">${statusLine}</div>
      </div>
      <div class="room-bar__right">
        <${LoadoutButton} from="room" size="lg" class="room-loadout" />
        ${facts.isHost
          ? html`<${Tooltip} text=${facts.canStart ? null : '仍有博士未准备就绪'}>
              <${Button} variant="primary" size="xl" icon="play" loading=${busy === 'start'} disabled=${!facts.canStart || !online} onClick=${start}>开始模拟<//>
            <//>`
          : facts.spectating
            ? html`<${Button} variant="secondary" size="xl" icon="eye" disabled=${true}>观战中<//>`
          : html`<${Button} variant=${myReady ? 'primary' : 'secondary'} size="xl" icon=${myReady ? 'check' : 'hourglass'} active=${myReady}
              loading=${busy === 'ready'} disabled=${!online || !facts.mine} onClick=${toggleReady}>${myReady ? '已就绪' : '准备就绪'}<//>`}
      </div>
    </footer>
  </div>`;
}
