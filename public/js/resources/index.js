// Local resource cache: boot integration, the resource manager dialog and its launcher.
import { render } from '../../vendor/preact.module.js';
import { html } from '../ui/components.js';
import { toast } from '../ui/toasts.js';
import { ResourceStore } from './store.js';
import { importResourceZip } from './zip.js';
import { ResourceDialog, ResourceLauncher } from './view.js';

// The player's choice: 'install' (keep every resource file locally) or 'ondemand'. Unset until the first visit's
// dialog closes; a returning player's boot never waits for the resource layer.
const MODE_KEY = 'stronghold-resource-mode';
let workerPromise, storePromise, openDialog;

const mib = n => `${(n / 1048576).toFixed(1)} MiB`;

function preference(value) {
  if (value) localStorage.setItem(MODE_KEY, value);
  return localStorage.getItem(MODE_KEY);
}

/** Cache Storage and service workers need a secure context and site data; some in-app browsers have neither. */
function supported() {
  if (!globalThis.isSecureContext || !('serviceWorker' in navigator) || !('caches' in globalThis)) return false;
  try {
    localStorage.getItem(MODE_KEY);
    return true;
  } catch {
    return false; // site data blocked: storage access throws
  }
}

/** Rejects where the browser cannot run the (module) service worker: then nothing would serve stored files. */
function registerWorker() {
  return workerPromise ??= navigator.serviceWorker.register('/resource-sw.js', { type: 'module', scope: '/' });
}

function loadStore() {
  return storePromise ??= ResourceStore.load().catch(error => {
    storePromise = undefined; // the next caller tries again
    throw error;
  });
}

// One cache operation at a time: the boot check, and the dialog's check, download, import and clear. Interleaved, a
// check that scans while the cache is cleared would record files that are gone.
let operations = Promise.resolve();
function exclusive(operation) {
  const result = operations.then(operation);
  operations = result.then(() => {}, () => {}); // the outcome is the caller's
  return result;
}

function readableError(error) {
  if (error.name === 'AbortError') return '已暂停。已完成的文件会保留，可继续下载或重新导入。';
  if (error.name === 'QuotaExceededError') return '浏览器存储空间不足。请释放设备空间后重试，或选择按需加载。';
  const reason = error.name === 'TypeError' ? `网络连接失败（${error.message}）` : error.message;
  return `未完成：${reason}。已完成的文件会保留，可重试或按需加载。`;
}

/**
 * Call before the game boots. A returning player never waits: the local cache is checked in the background while the
 * service worker already answers from it. A first visit shows the resource dialog: download, import or skip.
 */
export async function prepareResources() {
  if (!supported()) return;
  if (preference()) {
    registerWorker().catch(error => console.error('[resources] service worker registration failed', error));
    checkInstallation().catch(error => console.error('[resources] local resource check failed', error));
    return;
  }
  const store = await openStore();
  if (store) await showManager(store, true);
  else preference('ondemand'); // reported by openStore(); the launcher can try again later
}

/** Drop what a new site version changed; remind a player who installs resources of the files still missing. */
async function checkInstallation() {
  const store = await loadStore();
  const status = await exclusive(() => store.check());
  if (preference() === 'install' && !status.complete) {
    const missing = `${status.total - status.count} 个文件（${mib(status.totalBytes - status.bytes)}）`;
    toast(`本地资源缺少 ${missing}，可在「资源管理」继续下载。`, 'info', { ttl: 8000 });
  }
}

/** The launcher of the resource dialog (hidden during matches). */
export function installResourceManager() {
  if (!supported() || document.getElementById('resource-manager-host')) return;
  const host = document.createElement('div');
  host.id = 'resource-manager-host';
  document.body.append(host);
  render(html`<${ResourceLauncher} onOpen=${openManager} />`, host);
}

async function openManager() {
  const store = await openStore();
  if (store) await showManager(store);
}

/** The store for the dialog, or null (reported) when the service worker or the manifest is unavailable. */
async function openStore() {
  try {
    await registerWorker();
    return await loadStore();
  } catch (error) {
    console.error('[resources] resource cache unavailable', error);
    toast(`本地资源缓存不可用：${error.message}。游戏资源将按需加载。`, 'warn', { ttl: 6000 });
    return null;
  }
}

function showManager(store, firstTime = false) {
  openDialog ??= new Promise(resolve => {
    const lastFocus = document.activeElement;
    // index.html's slow-boot hint stays away while the first visit's dialog replaces the boot screen
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

    let controller = null;
    let operation = null;
    let closing = false;
    let closed = false;
    const state = { status: null, busy: true, phase: 'checking', message: '', error: false };

    function update(patch) {
      Object.assign(state, patch);
      if (closed) return;
      render(html`<${ResourceDialog} state=${state} firstTime=${firstTime} totalBytes=${store.manifest.totalBytes} onClose=${close}
        onDownload=${download} onImport=${importZip} onClear=${clear}
        onCancel=${() => { controller?.abort(); update({ message: '正在暂停…' }); }} />`, host);
    }

    async function refresh() {
      try {
        update({ status: await exclusive(() => store.check()), busy: false });
      } catch (error) {
        console.error('[resources] local resource check failed', error);
        update({ message: readableError(error), error: true, busy: false });
      }
    }

    async function run(phase, action, done) {
      if (operation || closing) return;
      controller = new AbortController();
      update({ busy: true, phase, message: '正在准备，请稍候…', error: false });
      operation = (async () => {
        try {
          const status = await exclusive(() => action(controller.signal));
          const message = done(status);
          update({ message });
          toast(message, 'success');
          // Ask the browser not to evict a complete installation under storage pressure.
          if (status?.complete) void navigator.storage.persist();
        } catch (error) {
          const paused = error.name === 'AbortError';
          if (!paused) console.error(`[resources] ${phase} failed`, error);
          const message = readableError(error);
          update({ message, error: !paused });
          toast(message, paused ? 'info' : 'error');
        }
        await refresh();
        operation = null;
      })();
      await operation;
    }

    function download() {
      if (state.status?.complete) return;
      preference('install');
      return run('download', signal => store.download({ signal, onProgress: status => update({ status }) }),
        () => '全部资源已保存，可进入游戏。');
    }

    function importZip(file) {
      preference('install');
      return run('import', signal => importResourceZip(file, store, { signal, onProgress: status => update({ status }) }), status => {
        if (status.complete) return '全部资源已保存，可进入游戏。';
        const rest = `点「在线下载」补齐剩下的 ${status.total - status.count} 个`;
        return status.skipped
          ? `已导入 ${status.imported} 个文件；${status.skipped} 个与本站版本不一致已跳过，${rest}。`
          : `已导入 ${status.imported} 个文件，${rest}。`;
      });
    }

    function clear() {
      preference('ondemand');
      return run('clear', async () => { await store.clear(); }, () => '本地资源已清理。');
    }

    async function close() {
      if (closing) return;
      closing = true;
      controller?.abort();
      await operation;
      // A first visit that ends without installing plays on demand.
      if (!preference()) preference(state.status?.complete ? 'install' : 'ondemand');
      closed = true;
      render(null, host);
      host.remove();
      for (const { element, inert } of background) element.inert = inert;
      window.__spResourcesPreparing = preparingBefore;
      if (boot) boot.style.display = bootDisplay;
      if (lastFocus?.isConnected) lastFocus.focus();
      openDialog = undefined;
      resolve();
    }

    update({});
    void refresh();
  });
  return openDialog;
}
