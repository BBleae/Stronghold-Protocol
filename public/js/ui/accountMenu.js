// Account UI (Workers deployment): the lobby's account actions (继续对局, history, statistics, 修改代号 / 修改密码,
// login / logout), the public room list with join applications and spectating, and the host's application list in
// the room. Entering a room always goes through the room client (room-net.js enter()).

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Panel, MicroLabel, DifficultyTag } from './components.js';
import { account, accountRequest } from '../account.js';
import { net, identity } from '../net.js';
import { store, useStore } from '../store.js';
import { toast } from './toasts.js';
import { openLogin, NicknameDialog, PasswordDialog } from './accountForms.js';
import { t, N_ } from '../../../shared/i18n.js';

/**
 * An account GET kept fresh: loaded on mount, when the tab becomes visible, on refresh() and every `interval` ms
 * (null: no polling). Nothing is requested while `enabled` is false.
 */
export function useAccountPoll(path, interval = 10000, enabled = true) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false;
    let busy = false;
    const refresh = async () => {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const value = await accountRequest(path);
        if (!dead) {
          setData(value);
          setError('');
        }
      } catch (e) {
        if (!dead) setError(e.message);
      } finally {
        busy = false;
      }
    };
    refresh();
    const id = interval === null ? null : setInterval(refresh, interval);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      dead = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [path, interval, revision, enabled]);
  return { data, error, refresh: () => setRevision((x) => x + 1) };
}
const run = (fn) =>
  Promise.resolve()
    .then(fn)
    .catch((e) => toast(t(e.message), 'warn'));

/** A join application went out (join by code, invite link): the host decides, the room is entered on approval. */
export function applicationSent(code) {
  toast(t('已申请加入同盟 {code}，等待房主审批', { code }), 'info');
}

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    setBusy(true);
    try {
      await accountRequest('/api/auth/logout', {});
      net.close();
      identity.setEntered(false);
      location.reload();
    } catch (e) {
      setBusy(false);
      toast(t(e.message), 'warn');
    }
  };
  return html`<${Button} variant="ghost" size="sm" loading=${busy} disabled=${busy} onClick=${logout}>${t('退出登录')}<//>`;
}

/**
 * The lobby's account actions. 继续对局 shows while the account holds a seat, read again whenever the client is back in
 * the menu and after every 继续对局 attempt; a seat that is still a reservation (a create that failed) creates its room
 * with the lobby's `mode` and `difficulty`. 修改代号 for every account, 修改密码 for a password account (dialogs:
 * ui/accountForms.js). Signed out: 登录 leads to the title screen's account card.
 */
export function AccountMenu({ mode, difficulty }) {
  const inMenu = useStore((s) => s.connection.status === 'menu');
  const seat = useAccountPoll('/api/me/active-match', null, account.enabled && !!account.user && inMenu);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  if (!account.enabled) return null;
  const active = seat.data ? seat.data.activeSeat : account.activeSeat;
  const resume = async () => {
    setBusy(true);
    try {
      await net.enter({ kind: 'resume', mode, difficulty });
    } finally {
      setBusy(false);
      seat.refresh(); // a match that ended meanwhile takes the button away
    }
  };
  const closeDialog = () => setDialog(null);
  return html`<div class="account-actions">
    ${
      account.user
        ? html`
      ${active ? html`<${Button} size="sm" icon="play" loading=${busy} onClick=${() => run(resume)}>${t('继续对局')}<//>` : null}
      <${Button} variant="secondary" size="sm" icon="book" onClick=${() => store.patch('ui', { accountPage: 'history' })}>${t('对局记录')}<//>
      <${Button} variant="secondary" size="sm" icon="signal" onClick=${() => store.patch('ui', { accountPage: 'statistics' })}>${t('个人统计')}<//>
      <${Button} variant="secondary" size="sm" icon="edit" onClick=${() => setDialog('nickname')}>${t('修改代号')}<//>
      ${
        account.user.provider === 'password'
          ? html`<${Button} variant="secondary" size="sm" icon="shield" onClick=${() => setDialog('password')}>${t('修改密码')}<//>`
          : null
      }
      <${LogoutButton} />
    `
        : html`<${Button} size="sm" onClick=${openLogin}>${t('登录')}<//>`
    }
    ${dialog === 'nickname' ? html`<${NicknameDialog} onClose=${closeDialog} />` : null}
    ${dialog === 'password' ? html`<${PasswordDialog} onClose=${closeDialog} />` : null}
  </div>`;
}

const APPLICATION_TEXT = {
  pending: N_('等待房主审批'),
  approved: N_('已获批准'),
  joining: N_('正在加入'),
  joined: N_('已加入'),
  rejected: N_('申请已被拒绝'),
  expired: N_('申请已过期'),
  cancelled: N_('已取消'),
};

/** Public rooms: apply to join a waiting room, watch a running match; the account's application and its state. */
export function PublicRooms() {
  const [cursor, setCursor] = useState('');
  const rooms = useAccountPoll('/api/rooms?cursor=' + encodeURIComponent(cursor));
  const [application, setApplication] = useState(net.application);
  const [busy, setBusy] = useState(false);
  useEffect(() => net.on('application', setApplication), []);
  const applying = application?.status === 'pending' || application?.status === 'joining';
  const enterRoom = (room) =>
    run(async () => {
      setBusy(true);
      try {
        if (room.inMatch) await net.enter({ kind: 'spectate', code: room.roomId });
        else await net.request('room.join', { code: room.roomId });
      } finally {
        setBusy(false);
      }
    });
  const applicationText =
    application?.status === 'failed' ? t('加入失败：{message}', { message: t(application.error.message) }) : t(APPLICATION_TEXT[application?.status]);
  return html`<${Panel} class="public-rooms">
    <div class="account-row"><div><${MicroLabel} tone="mint">ACTIVE ALLIANCES<//><h2>${t('在线大厅')}</h2></div>
      <${Button} variant="ghost" size="sm" icon="refresh" onClick=${() => {
        setCursor('');
        rooms.refresh();
      }}>${t('刷新')}<//></div>
    ${rooms.error ? html`<p class="t-lo" role="alert">${t(rooms.error)}</p>` : null}
    ${
      application
        ? html`<div class="account-row"><span>${application.code} · ${applicationText}</span>
      ${application.status === 'pending' ? html`<${Button} size="sm" variant="ghost" onClick=${() => run(() => net.cancelApplication())}>${t('取消申请')}<//>` : null}
      ${application.status === 'failed' ? html`<${Button} size="sm" onClick=${() => net.retryApplication()}>${t('重试加入')}<//>` : null}
      ${applying ? null : html`<${Button} size="sm" variant="ghost" onClick=${() => net.watchApplication(null)}>${t('关闭')}<//>`}</div>`
        : null
    }
    <div class="public-rooms__list">
      ${
        rooms.data?.items?.length
          ? rooms.data.items.map(
              (room) => html`<div class="account-row public-room" key=${room.roomId}>
        <div><b>${room.hostName}</b><div class="t-lo"><span class="num">${room.roomId}</span> · ${t('{n} 人在线', { n: room.connectedHumans })} · ${room.occupied}/${room.capacity}${room.inMatch ? ` · ${t('{n} 人观战', { n: room.spectatorCount || 0 })}` : ''}</div></div>
        <${DifficultyTag} difficulty=${room.difficulty} />
        <${Button} size="sm" variant="secondary" disabled=${busy || applying || !account.user || (!room.inMatch && room.occupied >= room.capacity)}
          onClick=${() => enterRoom(room)}>${room.inMatch ? t('进入观战') : room.occupied >= room.capacity ? t('已满员') : t('申请加入')}<//>
      </div>`,
            )
          : html`<p class="t-lo">${rooms.data ? t('当前没有有真人在线的公开大厅') : t('正在查找在线大厅…')}</p>`
      }
    </div>
    <div class="account-row">
      ${cursor ? html`<${Button} variant="ghost" size="sm" onClick=${() => setCursor('')}>${t('返回首页')}<//>` : null}
      ${rooms.data?.nextCursor ? html`<${Button} variant="ghost" size="sm" onClick=${() => setCursor(rooms.data.nextCursor)}>${t('下一页')}<//>` : null}
    </div>
  <//>`;
}
export function Applications({ code }) {
  const state = useAccountPoll('/api/rooms/' + code + '/applications', 3000);
  if (!state.data?.host) return null;
  const action = async (body, path = 'applications') => {
    await accountRequest('/api/rooms/' + code + '/' + path, body);
    state.refresh();
  };
  return html`<${Panel} class="room-applications">
    <div class="account-row"><span>${t('加入申请')}</span><${Button} size="sm" variant="ghost"
      onClick=${() => run(() => action({ public: !state.data.public }, 'visibility'))}>${state.data.public ? t('公开大厅 · 点击设为私密') : t('私密大厅 · 点击公开')}<//></div>
    ${state.error ? html`<p role="alert">${t(state.error)}</p>` : null}
    ${state.data.items
      .filter((x) => x.status === 'pending')
      .map(
        (item) => html`<div class="account-row" key=${item.id}>
      <span>${item.name}</span>
      <${Button} size="sm" onClick=${() => run(() => action({ action: 'approve', id: item.id }))}>${t('同意')}<//>
      <${Button} size="sm" variant="ghost" onClick=${() => run(() => action({ action: 'reject', id: item.id }))}>${t('拒绝')}<//>
    </div>`,
      )}
  <//>`;
}
