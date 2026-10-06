// Lobby screen: pick 独立模拟 / 同盟模拟 and a difficulty (标准/险境/绝境/终极), create a room,
// or join one with a 同盟密钥 (recent codes remembered) — as a player (加入同盟) or in one of its MAX_SPECTATORS
// spectator seats (观战: room.spectate, also while its match runs; community report #26, a remake feature — the
// official room has none; the Node server only: account mode watches a public match from the online lobby's 进入观战,
// ui/accountMenu.js PublicRooms). Shows connection status + ping.
//
// Difficulty descriptions come from data/config.json `modes[modeId]` when present, else from the
// official act2autochess `modeDataDict` texts embedded below (desc + effectDescList), so the
// screen is complete before data is generated. Rounds: solo 标准 = 9, everything else 14 (+R15
// hidden core on 险境+), per research 00-INDEX §2. Battlefield pool (`modes[].stages`): 标准 always
// plays 战场#01, 险境 draws one of 8, 绝境 / 终极 one of 7 (m01 excluded).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, ROOM_CODE_LEN, MAX_SEATS, DEFAULT_SEATS, MAX_SPECTATORS, ERR, modeIdFor } from '../../../shared/constants.js';
import {
  html, Button, Icon, MicroLabel, Panel, TextField, PingPill, AvatarFrame, Tooltip, Spinner, DifficultyIcon, doctorNo, PlayerName, Fragment,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { GuideButton } from '../ui/guide.js';
import { ResourceButton } from '../ui/resourceButton.js';
import { LoadoutButton } from './loadout.js';
import { net, identity } from '../net.js';
import { account } from '../account.js';
import { AccountMenu, PublicRooms, applicationSent } from '../ui/accountMenu.js';
import { store, useStore, shallowEqual, loadPref, savePref, usePref } from '../store.js';
import { getConfig, getMode, getStage, useData } from '../data.js';

/** Official mode texts (activity_table act2autochess.modeDataDict), fallback when config.json is absent. */
export const MODE_TEXT = {
  single: {
    FUNNY: { code: 'AC-1', desc: '时长较短的模拟训练', effects: ['可以快速完成作战', '常规奖励'] },
    NORMAL: { code: 'AC-2', desc: '敌方攻击强度较高的模拟训练', effects: ['可使用盟约数增加', '大幅增加奖励'] },
    HARD: { code: 'AC-3', desc: '敌方攻击强度极高的模拟训练', effects: ['作战环境困难', '出现更加危险的敌人'] },
    ABYSS: { code: 'AC-4', desc: '敌方攻击强度到达极限的模拟训练', effects: ['作战环境无比困难', '出现极度危险的敌人'] },
  },
  multi: {
    FUNNY: { code: 'AC-1', desc: '敌方攻击强度较低的模拟训练', effects: ['作战环境较为温和', '常规奖励'] },
    NORMAL: { code: 'AC-2', desc: '敌方攻击强度较高的模拟训练', effects: ['可使用盟约数增加', '大幅增加奖励'] },
    HARD: { code: 'AC-3', desc: '敌方攻击强度极高的模拟训练', effects: ['作战环境困难', '出现更加危险的敌人'] },
    ABYSS: { code: 'AC-4', desc: '敌方攻击强度到达极限的模拟训练', effects: ['作战环境无比困难', '出现极度危险的敌人'] },
  },
};

/** Battlefield pool per difficulty when config.json is absent (the modes' `stages` lists; same for solo and co-op). */
export const STAGE_POOL = { FUNNY: ['act1autochess_m01'], NORMAL: 8, HARD: 7, ABYSS: 7 };

/**
 * Display name of a stage: stages.json when it is loaded, else derived from the id (act1 m0N → 战场#0N, act2 m0N → 战场#0(N+4)).
 * @param {string} id e.g. 'act1autochess_m01'
 */
export function stageLabel(id) {
  const rec = getStage(id);
  if (rec && typeof rec.name === 'string' && rec.name) return rec.name.split(/\s+/)[0];
  const m = String(id || '').match(/^act(\d)autochess_m(\d+)$/);
  return m ? `战场#${String(Number(m[2]) + (m[1] === '2' ? 4 : 0)).padStart(2, '0')}` : '';
}

/**
 * The battlefield note of a difficulty (official wording): a single-stage pool is fixed ("战场固定为 战场#01"), a larger
 * one is drawn at random ("战场随机（共8张）").
 * @param {string[] | number | null | undefined} stages the mode's `stages` list (or a count)
 * @returns {string} '' when unknown
 */
export function stageNote(stages) {
  if (Array.isArray(stages)) {
    const ids = stages.filter((s) => typeof s === 'string' && s);
    if (ids.length === 1) { const name = stageLabel(ids[0]); return name ? `战场固定为 ${name}` : '战场固定'; }
    return ids.length > 1 ? `战场随机（共${ids.length}张）` : '';
  }
  return Number.isInteger(stages) && stages > 1 ? `战场随机（共${stages}张）` : '';
}

const MODE_CARDS = [
  {
    id: 'solo', name: '独立模拟', en: 'SOLO SIMULATION', icon: 'user',
    desc: '独自调配资金与干员，以自己的节奏完成整场模拟。',
    points: ['1 名博士', '休整期与机变阶段不限时'],
  },
  {
    id: 'coop', name: '同盟模拟', en: 'ALLIANCE SIMULATION', icon: 'users',
    // up to MAX_SEATS (8) doctors: a room has DEFAULT_SEATS (4, the official room) until its host adds seats in the room
    // (同盟席位, a remake extension)
    desc: `与至多 ${MAX_SEATS - 1} 名博士组成同盟，共享干员池，联防协作抵御敌潮。`,
    points: [`1–${MAX_SEATS} 名博士 · 可由 AI 队友补位`, `默认 ${DEFAULT_SEATS} 席 · 创建者可扩至 ${MAX_SEATS} 席`, '联防阶段 · 最终攻势合并生命值'],
  },
];

/**
 * Text for a difficulty card, preferring data/config.json.
 * @param {'solo'|'coop'} roomMode
 * @param {string} difficulty
 * @returns {{ code: string, desc: string, effects: string[], rounds: number, hidden: boolean, stageNote: string }}
 */
export function difficultyInfo(roomMode, difficulty) {
  const fallback = MODE_TEXT[roomMode === 'solo' ? 'single' : 'multi'][difficulty] || { code: '', desc: '', effects: [] };
  // modeIdFor() lower-cases the difficulty: never call it with a value the server did not validate.
  const m = DIFFICULTIES.includes(difficulty) ? getMode(modeIdFor(roomMode, difficulty)) : null;
  const effects = Array.isArray(m?.effectDescList)
    ? m.effectDescList.map((e) => String(e).replace(/^[·•\s]+/, '')).filter(Boolean)
    : fallback.effects;
  const rounds = Number.isFinite(m?.lastRound) ? m.lastRound : roomMode === 'solo' && difficulty === 'FUNNY' ? 9 : 14;
  return {
    code: typeof m?.code === 'string' ? m.code : fallback.code,
    desc: typeof m?.desc === 'string' ? m.desc : fallback.desc,
    effects,
    rounds,
    hidden: difficulty !== 'FUNNY',
    stageNote: stageNote(Array.isArray(m?.stages) && m.stages.length ? m.stages : STAGE_POOL[difficulty]),
  };
}

const CODE_RE = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LEN}}$`);
/**
 * Normalise user input into a room code: accepts a pasted invite link (`…?room=ABCD`), keeps
 * upper-cased alphanumerics and clamps to the code length.
 * @param {string} v
 * @returns {string}
 */
export function normalizeCode(v) {
  let s = String(v ?? '');
  const m = s.match(/[?&]room=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN);
}

/**
 * A handler that Preact binds as `onClick=${fn}` receives the click EVENT as its first argument, and a default
 * parameter only applies to `undefined` — so `fn(c = code)` would normalise the event target into a nonsense code
 * (`String(el)` → `"[object HTMLElement]"` → "OBJE"). Only a string is ever a code; anything else falls back to the
 * input field. Returns null when neither yields a well-formed code.
 * @param {unknown} arg the argument a handler was called with
 * @param {string} field the current input-field value
 * @returns {string|null}
 */
export function codeArg(arg, field) {
  const k = normalizeCode(typeof arg === 'string' ? arg : field);
  return CODE_RE.test(k) ? k : null;
}

/**
 * Room code from a deep link query string (`?room=CODE`), or null when absent/malformed.
 * Accepts ROOM_CODE_LEN..ROOM_CODE_LEN+2 alphanumerics (the protocol's join limit).
 * @param {string} search e.g. location.search
 * @returns {string|null}
 */
export function parseRoomParam(search) {
  try {
    const raw = new URLSearchParams(search || '').get('room');
    if (!raw) return null;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code.length >= ROOM_CODE_LEN && code.length <= ROOM_CODE_LEN + 2 ? code : null;
  } catch {
    return null;
  }
}

/** Recently joined/created co-op room codes (most recent first). */
export function recentRooms() {
  const list = loadPref('recentRooms', []);
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && CODE_RE.test(c)).slice(0, 4) : [];
}

/** @param {string} code */
export function rememberRoom(code) {
  if (!CODE_RE.test(code)) return;
  savePref('recentRooms', [code, ...recentRooms().filter((c) => c !== code)].slice(0, 4));
}

const FALLBACK_TIPS = [
  '联合模拟在选择策略时可以进行一次跳过',
  '调度中心即使冻结，依然可以主动刷新',
  '两件同名装备可以合成一件更强力的装备',
  '只有达成完美作战的队友可以进行联防',
];
const TIP_ROTATE_MS = 5000; // matchingTipRotateInterval

/**
 * 匹配 (matchmaking) panel: shown in place of the 快速匹配 button while the player waits. The server groups the waiting
 * players of one difficulty into a fresh 同盟 room and answers queue.matched; the missed seats become AI teammates once
 * the room opens (screens/room.js).
 */
function QueuePanel({ q, difficulty, onCancel, busy }) {
  const secs = Math.max(0, Math.round((q.waitedMs || 0) / 1000));
  const need = Math.max(1, (q.minSeats || 2) - (q.count || 1));
  return html`<div class="queue-panel brackets" role="status" aria-live="polite">
    <div class="queue-panel__head">
      <${Spinner} size="sm" />
      <span class="queue-panel__title">正在匹配 · ${DIFFICULTY_NAMES[difficulty] || difficulty}</span>
      <span class="queue-panel__time num">${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}</span>
    </div>
    <div class="queue-panel__body">
      <span><b class="num">${q.count || 1}</b> 人在等待</span>
      <span class="t-dim">${need > 0 ? `再等 ${need} 人即可开始` : '即将开始'}</span>
    </div>
    <${Button} variant="ghost" size="sm" data-testid="queue-cancel" onClick=${onCancel} loading=${busy === 'unqueue'}>取消匹配<//>
  </div>`;
}

/** Rotating tactical tips (config.json `tips`, weighted list of { tip, weight }). */function TipsPanel() {
  const cfg = getConfig();
  const tips = Array.isArray(cfg?.tips)
    ? cfg.tips.map((t) => (typeof t === 'string' ? t : t?.tip)).filter((t) => typeof t === 'string' && t)
    : FALLBACK_TIPS;
  const list = tips.length ? tips : FALLBACK_TIPS;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * list.length));
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => i + 1), TIP_ROTATE_MS);
    return () => clearInterval(id);
  }, []);
  const i = ((idx % list.length) + list.length) % list.length;
  return html`<div class="tips brackets">
    <div class="tips__head">
      <${Icon} name="info" />
      <span>作战提示</span>
      <${MicroLabel}>TACTICAL TIPS<//>
      <span class="tips__idx num">${String(i + 1).padStart(2, '0')}<span class="t-dim">/${String(list.length).padStart(2, '0')}</span></span>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i - 1 + list.length)} aria-label="上一条"><${Icon} name="chevronLeft" /></button>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i + 1)} aria-label="下一条"><${Icon} name="chevronRight" /></button>
    </div>
    <p key=${i} class="tips__text">${list[i]}</p>
  </div>`;
}

function ModeCard({ card, selected, onSelect }) {
  return html`<button type="button" class=${`mode-card brackets${selected ? ' is-selected' : ''}`} onClick=${() => onSelect(card.id)}
      aria-pressed=${selected ? 'true' : 'false'}>
    <span class="mode-card__bg" aria-hidden="true"></span>
    <span class="mode-card__icon"><${Icon} name=${card.icon} /></span>
    <span class="mode-card__text">
      <${MicroLabel} tone=${selected ? 'mint' : undefined}>${card.en}<//>
      <span class="mode-card__name">${card.name}</span>
      <span class="mode-card__desc">${card.desc}</span>
      <span class="mode-card__points">${card.points.map((p) => html`<span key=${p}>${p}</span>`)}</span>
    </span>
    <span class="mode-card__check" aria-hidden="true"><${Icon} name="check" />已选定</span>
  </button>`;
}

function DifficultyCard({ roomMode, difficulty, selected, onSelect }) {
  const info = difficultyInfo(roomMode, difficulty);
  return html`<button type="button" class=${`diff-card${selected ? ' is-selected' : ''}`}
      style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`} onClick=${() => onSelect(difficulty)} aria-pressed=${selected ? 'true' : 'false'}>
    <span class="diff-card__bar" aria-hidden="true"></span>
    <span class="diff-card__head">
      <${DifficultyIcon} difficulty=${difficulty} class="diff-card__glyph" />
      <span class="diff-card__name">${DIFFICULTY_NAMES[difficulty]}</span>
      <span class="diff-card__code num">${info.code}</span>
      <span class="diff-card__meta">
        <span class="num">${info.rounds}</span> 回合${info.hidden ? html`<span class="diff-card__hidden">+ 隐秘核心</span>` : null}
      </span>
    </span>
    <span class="diff-card__desc">${info.desc}</span>
    <span class="diff-card__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}${info.stageNote ? html`<span key="stage" class="diff-card__stage"><${Icon} name="rook" />${info.stageNote}</span>` : null}</span>
    <span class="diff-card__check" aria-hidden="true"><${Icon} name="check" /><span>已选定</span></span>
  </button>`;
}

/** Lobby screen component. */
export function LobbyScreen() {
  const me = useStore((s) => s.me, shallowEqual);
  const displayName = account.user?.name || me.name;
  const conn = useStore((s) => s.connection, shallowEqual);
  const queue = useStore((s) => s.queue, shallowEqual);
  useData('config');
  const [savedMode, pickMode] = usePref('lobby.mode', 'coop');
  const [savedDifficulty, pickDifficulty] = usePref('lobby.difficulty', 'FUNNY');
  const roomMode = savedMode === 'solo' ? 'solo' : 'coop';
  const difficulty = DIFFICULTIES.includes(savedDifficulty) ? savedDifficulty : 'FUNNY';
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  usePref('recentRooms', null);
  const recent = recentRooms();
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);

  // Rooms can be created or joined: the session is online, or (account mode, room-net.js) the client is in the menu.
  const ready = conn.status === 'online' || conn.status === 'menu';
  const codeOk = CODE_RE.test(code);

  const run = async (kind, fn) => {
    if (account.enabled && !account.user) { toast('请先登录', 'warn'); return; }
    if (inFlight.current) return;
    if (!ready) { toast('尚未连接到服务器，请稍候', 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const create = () => run('create', () => net.request('room.create', { mode: roomMode, difficulty }));
  // 匹配 (matchmaking queue): wait for other players of the same difficulty instead of hand-sharing a key. The ticker the
  // panel shows is driven by the server's queue.status frames (store.queue), so it survives a reconnect.
  const queueJoin = () => run('queue', () => net.request('queue.join', { difficulty }));
  const queueLeave = () => run('unqueue', () => net.request('queue.leave', {}));
  const join = (c = code) => {
    // `onClick=${join}` hands the click EVENT as the first argument, and a default parameter only applies to
    // `undefined` — codeArg keeps an event target out of the key and falls back to the input field
    const k = codeArg(c, code);
    if (!k) { toast(`同盟密钥为 ${ROOM_CODE_LEN} 位字母或数字`, 'warn'); return; }
    run('join', async () => {
      // account mode: joining by code is an application to the host
      const reply = await net.request('room.join', { code: k });
      if (reply?.application) applicationSent(k);
    });
  };
  // a spectator seat: no player seat taken, nothing to do but watch (also a match already running)
  const spectate = (c = code) => {
    // same guard as join: `onClick=${spectate}` passes the click event, not a code
    const k = codeArg(c, code);
    if (!k) { toast(`同盟密钥为 ${ROOM_CODE_LEN} 位字母或数字`, 'warn'); return; }
    run('spectate', () => net.request('room.spectate', { code: k }).catch((err) => {
      // Clearer than the bare ERR_TEXT: the usual cause is a code that is not the host's (a remembered one from an
      // earlier room, or another machine's) — the server can only answer "no such room".
      if (err?.code === ERR.ROOM_NOT_FOUND) {
        toast(`没有找到密钥 ${k} 对应的同盟：请和房主核对密钥（同盟结束后密钥即失效）`, 'warn');
        return;
      }
      if (err?.code === ERR.ALREADY) {
        toast('你已经是该同盟的博士：先离开同盟，才能以观战身份进入', 'warn');
        return;
      }
      throw err;
    }));
  };
  const backToTitle = () => {
    identity.setEntered(false);
    store.set((s) => ({ session: { ...s.session, entered: false } }));
  };

  return html`<div class="screen lobby-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${backToTitle} title="返回标题">返回<//>
        ${conn.status !== 'menu' ? html`<${PingPill} ms=${conn.ping} online=${conn.status === 'online'} />` : null}
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">SIMULATION PROTOCOL SELECT<//>
        <h1 class="topbar__title">选择模拟协议</h1>
      </div>
      <div class="topbar__right">
        <${GuideButton} class="lobby-guide" variant="secondary" />
        <${ResourceButton} class="lobby-res" variant="secondary" />
        <${LoadoutButton} from="lobby" size="sm" class="lobby-loadout" />
        <div class="me-chip">
          <${AvatarFrame} size="sm" name=${displayName} src=${account.user?.avatarUrl} seat=${0} self=${true} />
          <div class="me-chip__text">
            <span class="me-chip__name" title=${displayName || '博士'}><${PlayerName} name=${displayName || '博士'} /></span>
            <${MicroLabel}>${account.enabled || me.playerId == null ? 'DOCTOR' : `DOCTOR #${doctorNo(me.playerId)}`}<//>
          </div>
        </div>
      </div>
    </header>

    ${account.enabled ? html`<${AccountMenu} mode=${roomMode} difficulty=${difficulty} />` : null}
    <div class="lobby-body screen__scroll">
      <section class="lobby-left">
        ${account.enabled?html`<${PublicRooms} />`:null}
        <div class="section-label"><span class="section-label__idx num">01</span>模拟方式<${MicroLabel}>MODE<//></div>
        <div class="mode-cards">
          ${MODE_CARDS.map((c) => html`<${ModeCard} key=${c.id} card=${c} selected=${roomMode === c.id} onSelect=${pickMode} />`)}
        </div>

        <div class="section-label"><span class="section-label__idx num">03</span>加入同盟<${MicroLabel}>JOIN WITH ALLIANCE KEY<//></div>
        <${Panel} class="join-panel" tone="amber">
          <div class="join-row">
            <${TextField} size="code" icon="key" value=${code} placeholder="输入同盟密钥 / 粘贴邀请链接"
              autoCapitalize="characters" enterKeyHint="go" transform=${normalizeCode} onInput=${(v) => setCode(normalizeCode(v))} onEnter=${() => join()} />
            <${Button} variant="amber" size="lg" icon="users" loading=${busy === 'join'} disabled=${!codeOk || !ready} onClick=${() => join()}>加入同盟<//>
            ${account.enabled ? null : html`<${Tooltip} text=${`以观战者身份进入：不占博士席位，只能观看（每个同盟最多 ${MAX_SPECTATORS} 名，模拟进行中也可进入）`}>
              <${Button} variant="secondary" size="lg" icon="eye" class="join-spectate" loading=${busy === 'spectate'} disabled=${!codeOk || !ready} onClick=${spectate}>观战<//>
            <//>`}
          </div>
          <div class="join-foot">
            ${recent.length ? html`<span class="t-lo">最近的同盟</span>
              ${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title="填入密钥（不会直接加入）"
                onClick=${() => setCode(c)}>${c}</button>`)}`
              : html`<span class="t-dim">向同伴索取 ${ROOM_CODE_LEN} 位同盟密钥，或直接打开邀请链接</span>`}
          </div>
        <//>
        <${TipsPanel} />
      </section>

      <section class="lobby-right">
        <div class="section-label"><span class="section-label__idx num">02</span>模拟难度<${MicroLabel}>DIFFICULTY<//></div>
        <div class="diff-list">
          ${DIFFICULTIES.map((d) => html`<${DifficultyCard} key=${d} roomMode=${roomMode} difficulty=${d} selected=${difficulty === d} onSelect=${pickDifficulty} />`)}
        </div>
        <div class="create-box">
          ${queue.waiting
            ? html`<${QueuePanel} q=${queue} difficulty=${queue.difficulty || difficulty} busy=${busy} onCancel=${queueLeave} />`
            : html`<${Fragment}>
                <${Tooltip} block=${true} text=${ready ? null : '正在连接服务器…'}>
                  <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" loading=${busy === 'create'} disabled=${!ready} onClick=${create}>
                    ${roomMode === 'solo' ? '开始独立模拟' : '创建同盟'}
                  <//>
                <//>
                ${roomMode === 'coop'
                  ? html`<${Tooltip} block=${true} text=${ready ? '自动寻找同一难度的博士，凑齐后自动进入同盟房间；缺人的席位会用 AI 队友补齐' : '正在连接服务器…'}>
                      <${Button} variant="secondary" size="lg" block=${true} icon="users" data-testid="queue-join" loading=${busy === 'queue'} disabled=${!ready} onClick=${queueJoin}>
                        快速匹配（${DIFFICULTY_NAMES[difficulty]}）
                      <//>
                    <//>`
                  : null}
              <//>`}
          <div class="create-box__hint">
            ${!queue.waiting && !ready
              ? html`<${Spinner} size="sm" label="CONNECTING" />`
              : html`<span>${queue.waiting
                    ? '匹配期间可以点「取消匹配」退出队列'
                    : roomMode === 'solo' ? '创建后即可开始模拟' : '创建后可邀请好友或添加 AI 队友'}</span>`}
          </div>
        </div>
      </section>
    </div>
  </div>`;
}
