// Local resource cache: boot integration and the resource manager dialog.
//
// The site serves every resource file (art, audio, fonts). A player can keep them all locally — downloaded in the
// dialog or imported from the resource ZIP — and the service worker answers them from the local cache; what the cache
// lacks loads from the site on demand.
import { render } from '../../vendor/preact.module.js';
import { html } from '../ui/components.js';
import { toast } from '../ui/toasts.js';
import { ResourceStore } from './store.js';
import { exportResourceZip, importResourceZip } from './zip.js';
import { ResourceDialog } from './view.js';
import { installResourceOpener } from '../ui/resourceButton.js';
import { appBundled } from '../appShell.js';
import { t } from '../../../shared/i18n.js';

// The player's choice: 'install' (keep every resource file locally) or 'ondemand'. Unset until the first visit's
// dialog closes; a returning player's boot never waits for the resource layer. Releases whose site hosted no resource
// files stored 'visited' here: those players play on demand.
const MODE_KEY = 'stronghold-resource-mode';
// The Web Lock every cache operation holds, in every page of the site.
const LOCK_NAME = 'stronghold-resources';
let storePromise, openDialog;

const mib = n => `${(n / 1048576).toFixed(1)} MiB`;

function preference(value) {
  if (value) localStorage.setItem(MODE_KEY, value);
  return localStorage.getItem(MODE_KEY);
}

/** Cache Storage, service workers and Web Locks need a secure context and site data; some in-app browsers lack them. */
function supported() {
  // the Android app carries the files and answers their requests itself (appShell.js): nothing to download or keep
  if (appBundled()) return false;
  const apis = globalThis.isSecureContext && 'serviceWorker' in navigator && 'caches' in globalThis && 'locks' in navigator;
  if (!apis) return false;
  try {
    localStorage.getItem(MODE_KEY);
    return true;
  } catch {
    return false; // site data blocked: storage access throws
  }
}

/**
 * Register the worker and have it serve this page. Resolves at once when the worker is registered already; a page
 * loaded past it (a hard reload bypasses the worker) asks it to take over. Rejects where the browser cannot run the
 * (module) service worker: then nothing would serve stored files.
 */
async function registerWorker() {
  const registration = await navigator.serviceWorker.register('/resource-sw.js', { type: 'module', scope: '/' });
  if (!navigator.serviceWorker.controller) registration.active?.postMessage('claim');
}

function loadStore() {
  return storePromise ??= ResourceStore.load().catch(error => {
    storePromise = undefined; // the next caller tries again
    throw error;
  });
}

/**
 * Run `operation` holding the resource lock. Cache Storage is shared by every page of the site, so one cache
 * operation (the boot check; the dialog's check, download, import, export and clear) runs at a time across all of them:
 * interleaved, two pages reconciling at once can each keep the cache the other deletes, and a clear deletes what a
 * download is storing. `onWait` is called when another operation holds the lock; aborting `signal` stops the wait.
 */
async function exclusive(operation, { signal, onWait } = {}) {
  const { held } = await navigator.locks.query();
  if (held.some(lock => lock.name === LOCK_NAME)) onWait?.();
  return navigator.locks.request(LOCK_NAME, { signal }, operation);
}

/** The installation's status. One that holds files asks the browser not to evict them under storage pressure. */
async function checkStatus(store) {
  const status = await store.check();
  if (status.count) void navigator.storage.persist();
  return status;
}

function readableError(error) {
  if (error.name === 'AbortError') return t('已暂停。已完成的文件会保留，可继续下载或重新导入。');
  if (error.name === 'QuotaExceededError') return t('浏览器存储空间不足。请释放设备空间后重试，或选择按需加载。');
  const reason = error.name === 'TypeError' ? t('网络连接失败（{message}）', { message: error.message }) : error.message;
  return t('未完成：{reason}。已完成的文件会保留，可重试或按需加载。', { reason });
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
  if (!store) {
    preference('ondemand'); // reported by openStore(); the 资源管理 button can try again later
    return;
  }
  const status = await showManager(store, true);
  // A first visit that ends without installing plays on demand.
  if (!preference()) preference(status?.complete ? 'install' : 'ondemand');
}

/** Drop what a new site version changed; remind a player who installs resources of the files still missing. */
async function checkInstallation() {
  const store = await loadStore();
  const status = await exclusive(() => checkStatus(store));
  if (preference() === 'install' && !status.complete) {
    const missing = t('{n} 个文件（{size}）', { n: status.total - status.count, size: mib(status.totalBytes - status.bytes) });
    toast(t('本地资源缺少 {missing}，可在「资源管理」继续下载。', { missing }), 'info', { ttl: 8000 });
  }
}

/** The screens' 资源管理 button opens the resource dialog (ui/resourceButton.js). */
export function installResourceManager() {
  if (supported()) installResourceOpener(openManager);
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
    toast(t('本地资源缓存不可用：{message}。游戏资源将按需加载。', { message: error.message }), 'warn', { ttl: 6000 });
    return null;
  }
}

/** Save a Blob under 
ame through the browser's downloads. */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Show the dialog; resolves with the installation's last known status when it closes. */
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
    const background = ['app'].map(id => document.getElementById(id)).filter(Boolean)
      .map(element => ({ element, inert: element.inert }));
    for (const { element } of background) element.inert = true;

    // Aborts the check or operation in progress (暂停, closing the dialog), also while it waits for the lock.
    let controller = null;
    let operation = null;
    let closing = false;
    let closed = false;
    const state = { status: null, busy: true, waiting: false, phase: 'checking', message: '', error: false };

    function update(patch) {
      Object.assign(state, patch);
      if (closed) return;
      render(html`<${ResourceDialog} state=${state} firstTime=${firstTime} totalBytes=${store.manifest.totalBytes}
        onClose=${close} onDownload=${download} onImport=${importZip} onExport=${exportZip} onClear=${clear}
        onCancel=${() => { controller?.abort(); update({ message: t('正在暂停…') }); }} />`, host);
    }

    /** Run `task` holding the resource lock; the dialog shows when it waits for another operation. */
    function locked(task) {
      controller = new AbortController();
      const { signal } = controller;
      return exclusive(() => {
        update({ waiting: false });
        return task(signal);
      }, { signal, onWait: () => update({ waiting: true }) });
    }

    async function check() {
      try {
        update({ status: await locked(() => checkStatus(store)), busy: false });
      } catch (error) {
        if (error.name === 'AbortError') return; // the dialog closed while the check waited
        console.error('[resources] local resource check failed', error);
        update({ message: readableError(error), error: true, busy: false });
      }
    }

    async function run(phase, action, done) {
      if (operation || closing) return;
      update({ busy: true, phase, message: t('正在准备，请稍候…'), error: false });
      operation = (async () => {
        try {
          const result = await locked(async signal => {
            try {
              return await action(signal);
            } finally {
              // What the operation left, read before another operation can change it.
              update({ status: await checkStatus(store) });
            }
          });
          const message = done(result);
          update({ message });
          toast(message, 'success');
        } catch (error) {
          const paused = error.name === 'AbortError';
          if (!paused) console.error(`[resources] ${phase} failed`, error);
          const message = readableError(error);
          update({ message, error: !paused });
          toast(message, paused ? 'info' : 'error');
        }
        update({ busy: false, waiting: false });
        operation = null;
      })();
      await operation;
    }

    function download() {
      if (state.status?.complete) return;
      preference('install');
      return run('download', signal => store.download({ signal, onProgress: status => update({ status }) }),
        () => t('全部资源已保存，可进入游戏。'));
    }

    function importZip(file) {
      preference('install');
      const action = signal => importResourceZip(file, store, { signal, onProgress: status => update({ status }) });
      return run('import', action, ({ complete, imported, skipped, total, count }) => {
        if (complete) return t('全部资源已保存，可进入游戏。');
        const rest = t('点「在线下载」补齐剩下的 {n} 个', { n: total - count });
        return skipped
          ? t('已导入 {imported} 个文件；{skipped} 个与本站版本不一致已跳过，{rest}。', { imported, skipped, rest })
          : t('已导入 {imported} 个文件，{rest}。', { imported, rest });
      });
    }

    async function exportZip() {
      if (operation || closing || !state.status?.complete) return;
      // Chrome / Edge write straight to the file the player picks; elsewhere the pack is made in memory, then saved.
      let writable = null;
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: `stronghold-resources-${store.manifest.version.slice(0, 12)}.zip`,
            types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] });
          writable = await handle.createWritable();
        } catch (error) {
          if (error?.name === 'AbortError') return; // the player closed the save dialog
        }
      }
      // The save dialog can resolve after a match start closed this one.
      if (closing) { await writable?.abort().catch(() => {}); return; }
      return run('export', async signal => {
        const { name, blob } = await exportResourceZip(store, { signal, writable, onProgress: status => update({ status }) });
        if (blob) saveBlob(blob, name);
        return name;
      }, name => t('已导出 {name}（{size}），发给朋友后在「资源管理」点「导入本地 ZIP」即可。', { name, size: mib(store.manifest.totalBytes) }));
    }

    function clear() {
      preference('ondemand');
      return run('clear', () => store.clear(), () => t('本地资源已清理。'));
    }

    async function close() {
      if (closing) return;
      closing = true;
      controller?.abort();
      await operation;
      closed = true;
      render(null, host);
      host.remove();
      for (const { element, inert } of background) element.inert = inert;
      window.__spResourcesPreparing = preparingBefore;
      if (boot) boot.style.display = bootDisplay;
      if (lastFocus?.isConnected) lastFocus.focus();
      openDialog = undefined;
      resolve(state.status);
    }

    update({});
    void check();
  });
  return openDialog;
}
