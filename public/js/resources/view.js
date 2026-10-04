import { useEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Button, Modal, Panel, MicroLabel, ProgressBar, Spinner } from '../ui/components.js';
import { ToastHost } from '../ui/toasts.js';
import { selectRoute, useStore } from '../store.js';

// The complete resource pack, served by the Worker (worker/pack.js); the import below accepts it.
const PACK_URL = '/stronghold-resources.zip';

const mib = (n) => `${(n / 1048576).toFixed(1)} MiB`;

export function ResourceDialog({ state, firstTime, totalBytes, onClose, onDownload, onImport, onClear, onCancel }) {
  const route = useStore(selectRoute);
  const input = useRef(null);
  useEffect(() => {
    if (!firstTime && route === 'game') void onClose();
  }, [route, firstTime, onClose]);
  const { status, busy, waiting, phase, message, error } = state;
  const complete = status?.complete ?? false;
  // Another page of the site (or this page's boot check) is using the local resources.
  const phaseLabel = waiting
    ? '等待其他资源操作完成'
    : { checking: '正在检查本地资源', download: '正在下载', import: '正在导入', clear: '正在清理' }[phase];
  const continueText = firstTime ? (complete ? '资源已就绪，进入游戏' : '暂时跳过，按需加载') : '返回游戏';
  return html`<${Modal} open=${true} class="resource-dialog" width="min(8rem, 94vw)"
    title=${firstTime ? '准备游戏资源' : '资源管理'} micro="RESOURCE MANAGER // 本地资源"
    closeOnBackdrop=${false} onClose=${onClose}
    actions=${html`<${Button} data-action="continue" iconRight="chevronRight" onClick=${onClose}>${continueText}<//>`}>
    <div class="resource-card">
      <p class="resource-intro modal__text">完整资源约 ${mib(totalBytes)}。提前保存可减少对局中的等待；下载中断后可以继续补齐。</p>
      <${Panel} class="resource-cache">
        <div class="resource-summary">
          <${MicroLabel} tone="mint">LOCAL CACHE // 本地缓存<//>
          ${
            busy
              ? html`<${Spinner} size="sm" label=${phaseLabel} />`
              : html`<${MicroLabel} tone=${complete ? 'mint' : undefined}>${complete ? 'READY // 已就绪' : '待补齐'}<//>`
          }
        </div>
        <div class="resource-stat num" aria-live="polite">${
          status
            ? `${status.count} / ${status.total} 个文件 · ${mib(status.bytes)} / ${mib(status.totalBytes)}`
            : '正在检查本地资源…'
        }</div>
        <${ProgressBar} class="resource-progress" value=${status?.bytes ?? 0} max=${status?.totalBytes || 1} />
      <//>
      <p class=${`resource-message ${error ? 't-gold' : 't-lo'}`} role="status">${message}</p>
      <div class="resource-actions">
        <${Button} variant="primary" data-action="download" disabled=${busy || complete} loading=${busy && phase === 'download'}
          onClick=${onDownload}>${complete ? '资源已全部保存' : '在线下载 / 继续下载'}<//>
        <${Button} data-action="import" disabled=${busy} loading=${busy && phase === 'import'}
          onClick=${() => input.current?.click()}>导入本地 ZIP<//>
        <a class="btn btn--secondary btn--md" data-action="pack" href=${PACK_URL} download>
          <span class="btn__label">下载资源包 ZIP</span></a>
        <${Button} variant="ghost" data-action="clear" disabled=${busy} onClick=${onClear}>清理本地资源<//>
        ${busy && phase !== 'checking' ? html`<${Button} class="resource-cancel" data-action="cancel" onClick=${onCancel}>暂停<//>` : null}
      </div>
      <input ref=${input} type="file" hidden aria-label="选择本地资源 ZIP" onChange=${(event) => {
        const file = event.currentTarget.files[0];
        if (file) onImport(file);
        event.currentTarget.value = '';
      }} />
      <div class="resource-note">
        <${MicroLabel}>LOCAL ONLY // 本机处理<//>
        <p>ZIP 只在本机读取，不会上传。仅导入本站需要的资源，其余文件直接跳过，不解压、不校验。</p>
        <p>资源包 ZIP 与本站资源一致，可用下载工具断点续传，也可以发给朋友导入。浏览器可能清理缓存，之后可重新补齐。</p>
      </div>
    </div>
  <//>${firstTime ? html`<${ToastHost} />` : null}`;
}
