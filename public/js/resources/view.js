import { useEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Button, Modal, Panel, MicroLabel, ProgressBar, Spinner } from '../ui/components.js';
import { ToastHost } from '../ui/toasts.js';
import { selectRoute, useStore } from '../store.js';

const mib = n => `${(n / 1048576).toFixed(1)} MiB`;

export function ResourceDialog({ state, firstTime, totalBytes, onClose, onImport, onClear, onCancel }) {
  const route = useStore(selectRoute);
  const input = useRef(null);
  useEffect(() => { if (!firstTime && route === 'game') void onClose(); }, [route, firstTime, onClose]);
  const { status, busy, waiting, phase, message, error } = state;
  const complete = status?.complete ?? false;
  // Another page of the site (or this page's boot check) is using the local resources.
  const phaseLabel = waiting ? '等待其他资源操作完成'
    : { checking: '正在检查本地资源', import: '正在导入', clear: '正在清理' }[phase];
  const continueText = firstTime ? complete ? '资源已就绪，进入游戏' : '暂时跳过（使用占位图）' : '返回游戏';
  return html`<${Modal} open=${true} class="resource-dialog" width="min(8rem, 94vw)"
    title=${firstTime ? '准备游戏资源' : '资源管理'} micro="RESOURCE MANAGER // 本地资源"
    closeOnBackdrop=${false} onClose=${onClose}
    actions=${html`<${Button} data-action="continue" iconRight="chevronRight" onClick=${onClose}>${continueText}<//>`}>
    <div class="resource-card">
      <p class="resource-intro modal__text">原版美术与音频需要导入本地资源 ZIP（完整约 ${mib(totalBytes)}），只在本机读取，不会上传。未导入时，游戏使用占位图，没有声音。</p>
      <${Panel} class="resource-cache">
        <div class="resource-summary">
          <${MicroLabel} tone="mint">LOCAL CACHE // 本地缓存<//>
          ${busy ? html`<${Spinner} size="sm" label=${phaseLabel} />`
            : html`<${MicroLabel} tone=${complete ? 'mint' : undefined}>${complete ? 'READY // 已就绪' : '待补齐'}<//>`}
        </div>
        <div class="resource-stat num" aria-live="polite">${status
          ? `${status.count} / ${status.total} 个文件 · ${mib(status.bytes)} / ${mib(status.totalBytes)}`
          : '正在检查本地资源…'}</div>
        <${ProgressBar} class="resource-progress" value=${status?.bytes ?? 0} max=${status?.totalBytes || 1} />
      <//>
      <p class=${`resource-message ${error ? 't-gold' : 't-lo'}`} role="status">${message}</p>
      <div class="resource-actions">
        <${Button} variant=${complete ? 'secondary' : 'primary'} data-action="import" disabled=${busy}
          loading=${busy && phase === 'import'} onClick=${() => input.current?.click()}>导入本地 ZIP<//>
        <${Button} variant="ghost" data-action="clear" disabled=${busy} onClick=${onClear}>清理本地资源<//>
        ${busy && phase !== 'checking' ? html`<${Button} class="resource-cancel" data-action="cancel" onClick=${onCancel}>取消<//>` : null}
      </div>
      <input ref=${input} type="file" hidden aria-label="选择本地资源 ZIP" onChange=${event => {
        const file = event.currentTarget.files[0];
        if (file) onImport(file);
        event.currentTarget.value = '';
      }} />
      <div class="resource-note">
        <${MicroLabel}>LOCAL ONLY // 本机处理<//>
        <p>本站不提供资源 ZIP，可以向已有的朋友索取。</p>
        <p>仅导入本站需要的资源，其余文件直接跳过，不解压、不校验。</p>
        <p>导入的资源保存在本浏览器的网站数据中；清除网站数据后，需要重新导入。</p>
      </div>
    </div>
  <//>${firstTime ? html`<${ToastHost} />` : null}`;
}
