import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Panel, MicroLabel, DifficultyTag, Spinner } from '../ui/components.js';
import { store } from '../store.js';
import { accountRequest } from '../account.js';
import { DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { fmtNum, normalizeResult } from '../ui/gameLogic.js';
import { useGameData } from '../ui/gameComponents.js';
import { PlayerCard } from './result.js';
import { t, N_ } from '../../../shared/i18n.js';
const LABELS = {
  dmgDealt: N_('造成伤害'),
  healing: N_('治疗量'),
  kills: N_('击倒敌人'),
  leaks: N_('未击倒'),
  bossDamage: N_('领袖伤害'),
  perfectRounds: N_('完美作战'),
  gold: N_('消耗资金'),
  refreshes: N_('刷新次数'),
  merges: N_('晋升次数'),
  lpLost: N_('损失生命'),
  buys: N_('招募次数'),
  sells: N_('出售次数'),
};
/**
 * The name of a 常用干员 entry (shared/history.js aggregateStats): a chess by its base id, else a 自选 operator by its
 * charId (data/backups.json units — how a 自选 piece is recorded, server/match/checkpoint.js, and what an old 外援 record
 * counts as), else the id itself (an operator the data no longer has).
 * @param {{ chess: (id: string) => any, backups?: any }} gd useGameData() @param {string} id
 */
export function operatorName(gd, id) {
  return gd.chess(id)?.name || gd.backups?.units?.[id]?.name || id;
}

export function HistoryScreen({ statistics = false }) {
  const gd = useGameData();
  const [mode, setMode] = useState(''),
    [difficulty, setDifficulty] = useState(''),
    [data, setData] = useState(null),
    [error, setError] = useState(''),
    [detail, setDetail] = useState(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  const query = new URLSearchParams({ mode, difficulty }).toString();
  useEffect(() => {
    let dead = false;
    setData(null);
    setError('');
    setDetail(null);
    accountRequest('/api/me/' + (statistics ? 'stats' : 'matches') + '?' + query).then(
      (r) => {
        if (!dead) setData(r);
      },
      (e) => {
        if (!dead) setError(e.message);
      },
    );
    return () => {
      dead = true;
    };
  }, [statistics, query, revision]);
  const open = async (id) => {
    setBusy(true);
    try {
      setDetail(await accountRequest('/api/matches/' + id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const more = async () => {
    setBusy(true);
    try {
      const r = await accountRequest('/api/me/matches?' + query + '&cursor=' + encodeURIComponent(data.nextCursor));
      setData({ ...r, items: [...data.items, ...r.items] });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="screen account-screen">
    <header class="topbar"><div class="topbar__left"><${Button} variant="ghost" icon="chevronLeft" onClick=${() => (detail ? setDetail(null) : store.patch('ui', { accountPage: null }))}>${t('返回')}<//></div>
      <div class="topbar__center"><${MicroLabel} tone="mint">${statistics ? 'PERSONAL RECORD' : 'SIMULATION ARCHIVE'}<//><h1 class="topbar__title">${statistics ? t('个人统计') : t('对局记录')}</h1></div>
      <div class="topbar__right"><${Button} variant="ghost" icon="refresh" onClick=${() => setRevision((x) => x + 1)}>${t('刷新')}<//></div></header>
    <main class="account-body screen__scroll">
      <div class="account-filters">
        ${[
          ['', t('全部模式')],
          ['solo', t('独立模拟')],
          ['coop', t('同盟模拟')],
        ].map(
          ([v, n]) =>
            html`<${Button} key=${v} size="sm" variant=${mode === v ? 'primary' : 'secondary'} onClick=${() => setMode(v)}>${n}<//>`,
        )}
        ${[['', N_('全部难度')], ...Object.entries(DIFFICULTY_NAMES)].map(([v, n]) => html`<${Button} key=${v} size="sm" variant=${difficulty === v ? 'primary' : 'ghost'} onClick=${() => setDifficulty(v)}>${t(n)}<//>`)}
      </div>
      ${error ? html`<${Panel}><p role="alert">${t(error)}</p><//>` : null}
      ${!data && !error ? html`<${Spinner} />` : null}
      ${
        detail
          ? html`<${Panel}><div class="account-row"><h2>${detail.result.victory ? t('模拟成功') : t('模拟结束')}</h2><${DifficultyTag} difficulty=${detail.difficulty}/>
        <${Button} icon="play" disabled=${!detail.manifest?.chunks?.length} onClick=${() => store.patch('ui', { accountPage: 'replay', replayMatchId: detail.matchId })}>${t('观看回放')}<//></div>
        <div class="history-players">${normalizeResult(detail.result).players.map((p) => html`<${PlayerCard} key=${p.playerId} p=${p} myId=${null} titles=${gd.config?.titles || []} best=${{}} solo=${detail.mode === 'solo'}/>`)}</div><//>`
          : statistics && data
            ? html`<${Panel}><div class="account-stats">
          ${[
            [t('总场次'), data.total],
            [t('完成场次'), data.completed],
            [t('胜率'), data.winRate == null ? '—' : (data.winRate * 100).toFixed(1) + '%'],
            [t('最高到达回合'), data.highestRound],
            [t('隐秘核心通关'), data.hiddenCleared],
            [t('提前离开'), data.left],
            [t('对局中断'), data.interrupted],
            ...Object.entries(data.totals).map(([k, v]) => [LABELS[k] ? t(LABELS[k]) : k, fmtNum(v)]),
          ].map(
            ([label, value]) =>
              html`<div class="rstat" key=${label}><span>${label}</span><b class="num">${value}</b></div>`,
          )}
        </div><p class="t-lo">${t('胜率仅计算已完成的胜负对局；提前离开与中断单独统计。')}</p><h2>${t('常用干员')}</h2>
        ${data.operators.length ? data.operators.slice(0, 20).map((op) => html`<div class="account-row" key=${op.id}><span>${operatorName(gd, op.id)}</span><b class="num">${t('{matches} 场', { matches: op.matches })}</b></div>`) : html`<p class="t-lo">${t('完成对局后显示出场记录')}</p>`}<//>`
            : data
              ? html`<div class="history-list">${
                  data.items.length
                    ? data.items.map(
                        (item) => html`<${Panel} key=${item.matchId}><div class="account-row">
          <div><b>${item.status === 'left' ? t('提前离开') : item.status === 'interrupted' ? t('对局中断') : item.victory ? t('模拟成功') : t('模拟失败')}</b><div class="t-lo">${new Date(item.endedAt).toLocaleString()} · ${item.mode === 'solo' ? t('独立') : t('同盟')} · ${t('第 {round} 回合', { round: item.round })}</div></div>
          <${DifficultyTag} difficulty=${item.difficulty}/><${Button} size="sm" variant="secondary" loading=${busy} onClick=${() => open(item.matchId)}>${t('查看详情')}<//></div><//>`,
                      )
                    : html`<${Panel}><p class="t-lo">${t('暂无对局记录。完成一次模拟后，记录会保存在这里。')}</p><//>`
                }
          ${data.nextCursor ? html`<${Button} loading=${busy} onClick=${more}>${t('加载更多')}<//>` : null}</div>`
              : null
      }
    </main></div>`;
}
