import { validateManifest } from './common.js';
import { ResourceStore } from './store.js';
import { exportResourceZip, importResourceZip } from './zip.js';
import { render } from '../../vendor/preact.module.js';
import { html } from '../ui/components.js';
import { toast } from '../ui/toasts.js';
import { ResourceDialog, ResourceLauncher } from './view.js';

const MODE_KEY = 'stronghold-resource-mode';
let contextPromise, openDialog;
const mib = n => `${(n / 1048576).toFixed(1)} MiB`;
function preference(value) {
  try { if (value) localStorage.setItem(MODE_KEY, value); return localStorage.getItem(MODE_KEY); } catch { return null; }
}
function loadStyle() {
  if (document.getElementById('resource-manager-style')) return;
  const link = document.createElement('link');
  link.id = 'resource-manager-style'; link.rel = 'stylesheet'; link.href = '/css/resources.css';
  document.head.append(link);
}
function readableError(error) {
  if (error?.name === 'AbortError') return '已暂停。已完成的文件会保留，可继续下载或重新导入。';
  if (error?.name === 'QuotaExceededError' || /quota|disk|storage.*full/i.test(error?.message ?? '')) return '浏览器空间不足。请释放设备空间或清理旧资源，然后重试；也可选择按需加载。';
  return `未完成：${error?.message ?? '网络或存储暂不可用'}。已完成的文件会保留，可重试或按需加载。`;
}

async function workerReady() {
  const registration = await navigator.serviceWorker.register('/resource-sw.js', { type: 'module', scope: '/' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error('资源缓存服务启动超时，请重试')); }, 15000);
    const clean = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); };
    const changed = () => { if (navigator.serviceWorker.controller) { clean(); resolve(); } };
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    changed();
  });
  // Ask the controlling worker for the live site manifest after a deployment change.
  const channel = new MessageChannel();
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); channel.port1.close(); resolve(); };
    const timer = setTimeout(finish, 5000);
    channel.port1.onmessage = finish;
    navigator.serviceWorker.controller.postMessage({ type: 'resources:refresh' }, [channel.port2]);
  });
  return registration;
}

async function getContext() {
  return contextPromise ??= (async () => {
    try {
      const response = await fetch('/resource-manifest.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok || !response.headers.get('Content-Type')?.includes('json')) return null;
      const manifest = validateManifest(await response.json());
      if (!globalThis.isSecureContext || !globalThis.caches || !navigator.serviceWorker || !globalThis.crypto?.subtle) {
        return { manifest, unavailable: '此浏览器或连接不支持本地资源缓存。可继续按需加载；缓存功能需要 HTTPS 或 localhost。' };
      }
      return { manifest, store: new ResourceStore(manifest) };
    } catch { return null; } // Node installs without a generated manifest preserve their normal startup.
  })();
}

function showManager(context, firstTime = false) {
  if (openDialog) return openDialog;
  loadStyle();
  openDialog = new Promise(resolve => {
    const lastFocus = document.activeElement;
    const preparingBefore = window.__spResourcesPreparing;
    window.__spResourcesPreparing = true;
    const boot = document.getElementById('boot');
    const bootDisplay = boot?.style.display;
    if (boot) boot.style.display = 'none';
    const host = document.createElement('div');
    host.className = 'resource-manager-dialog-host';
    document.body.append(host);
    const background = ['app', 'resource-manager-host'].map(id => document.getElementById(id)).filter(Boolean)
      .map(element => ({ element, inert: element.inert }));
    for (const { element } of background) element.inert = true;
    let controller, operation, closing = false, closed = false;
    const state = { status: null, busy: true, phase: 'checking', message: context.startupError ?? '', error: !!context.startupError };
    function update(patch) {
      Object.assign(state, patch);
      if (closed) return;
      render(html`<${ResourceDialog} state=${state} firstTime=${firstTime} available=${!!context.store}
        totalBytes=${context.manifest.totalBytes} onClose=${close}
        onDownload=${() => run(options => context.store.download(options), 'download')}
        onImport=${file => run(options => importResourceZip(file, context.store, options), 'import')}
        onExport=${exportZip} onClear=${() => run(async () => { await context.store.clear(); return context.store.status(); }, 'clear')}
        onCancel=${() => { controller?.abort(); update({ message: '正在暂停…' }); }} />`, host);
    }
    function progress(status) { update({ status }); }
    async function refresh() {
      if (context.store) progress(await context.store.status());
      else update({ message: context.unavailable });
    }
    async function run(action, phase, doneText) {
      if (operation || closing || !context.store) return;
      controller = new AbortController();
      update({ busy: true, phase, message: '正在准备，请稍候…', error: false });
      operation = (async () => {
        try {
          await workerReady();
          if (controller.signal.aborted) return;
          const status = await action({ signal: controller.signal, onProgress: progress });
          preference('install');
          if (status) progress(status);
          const message = doneText ?? (status?.complete ? '全部资源已保存，可进入游戏。' : '操作已完成。');
          update({ message });
          if (!closing) toast(message, 'success');
        } catch (error) {
          const message = readableError(error);
          update({ message, error: error?.name !== 'AbortError' });
          if (!closing) toast(message, error?.name === 'AbortError' ? 'info' : 'error');
        } finally {
          await refresh().catch(error => { update({ message: readableError(error), error: true }); });
          operation = undefined;
          update({ busy: false });
        }
      })();
      await operation;
    }
    async function close() {
      if (closing) return;
      closing = true;
      controller?.abort();
      if (operation) await operation;
      preference(state.status?.complete ? 'install' : 'ondemand');
      closed = true;
      render(null, host); host.remove();
      for (const { element, inert } of background) element.inert = inert;
      window.__spResourcesPreparing = preparingBefore;
      if (boot) boot.style.display = bootDisplay;
      if (lastFocus?.isConnected) lastFocus.focus();
      openDialog = undefined; resolve();
    }
    async function exportZip() {
      if (operation || !state.status?.complete) return;
      const name = `stronghold-resources-${context.manifest.version.slice(0, 12)}.zip`;
      let writable = null;
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] });
          writable = await handle.createWritable();
        } catch (error) { if (error?.name === 'AbortError') return; }
      }
      // The picker can resolve after the match starts and closes the manager.
      if (closing) { await writable?.abort(); return; }
      await run(async options => {
        const blob = await exportResourceZip(context.store, { ...options, writable });
        if (!writable) saveBlob(blob, name);
        return context.store.status();
      }, 'export', `已导出 ${name}（${mib(context.manifest.totalBytes)}），发给朋友后在这里「导入本地 ZIP」即可。`);
    }
    update({});
    refresh().catch(error => { update({ message: readableError(error), error: true }); }).finally(() => update({ busy: false }));
  });
  return openDialog;
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Call before the game boots. No manifest (ordinary Node mode) means immediate continuation. */
export async function prepareResources() {
  const context = await getContext();
  if (!context) return;
  // Register even when skipped so an existing partial installation remains usable.
  if (context.store) {
    try {
      await workerReady();
      const status = await context.store.status();
      if (status.complete) return;
    } catch (error) { context.startupError = readableError(error); }
  }
  if (preference() === 'ondemand') return;
  await showManager(context, true);
}

/** Safe to call after boot; the shared launcher follows the app's route. */
export async function installResourceManager() {
  const context = await getContext();
  if (!context || document.getElementById('resource-manager-host')) return;
  loadStyle();
  const host = document.createElement('div');
  host.id = 'resource-manager-host';
  document.body.append(host);
  render(html`<${ResourceLauncher} onOpen=${() => { void showManager(context); }} />`, host);
}
