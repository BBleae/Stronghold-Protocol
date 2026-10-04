// Local resource cache: boot integration, the resource manager dialog and its launcher.
//
// The site hosts no resource files (art, audio, fonts). A player imports them from a resource ZIP, read on this device
// only; the service worker answers them from the local cache. Without them the game draws placeholders.
import { render } from '../../vendor/preact.module.js';
import { html } from '../ui/components.js';
import { toast } from '../ui/toasts.js';
import { ResourceStore } from './store.js';
import { importResourceZip } from './zip.js';
import { ResourceDialog } from './view.js';
import { installResourceOpener } from '../ui/resourceButton.js';

// Set (to any value) once the first visit's resource dialog has closed. Earlier releases stored the player's choice
// ('install' / 'ondemand') under this key: those players have had their first visit.
const VISITED_KEY = 'stronghold-resource-mode';
// The Web Lock every cache operation holds, in every page of the site.
const LOCK_NAME = 'stronghold-resources';
let storePromise, openDialog;

/** Cache Storage, service workers and Web Locks need a secure context and site data; some in-app browsers lack them. */
function supported() {
  const apis = globalThis.isSecureContext && 'serviceWorker' in navigator && 'caches' in globalThis && 'locks' in navigator;
  if (!apis) return false;
  try {
    localStorage.getItem(VISITED_KEY);
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
 * operation (the boot check; the dialog's check, import and clear) runs at a time across all of them: interleaved,
 * two pages reconciling at once can each keep the cache the other deletes, and a clear deletes what an import is
 * storing. `onWait` is called when another operation holds the lock; aborting `signal` stops the wait.
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
  if (error.name === 'AbortError') return '已取消。已导入的文件会保留。';
  if (error.name === 'QuotaExceededError') return '浏览器存储空间不足，已导入的文件会保留。请释放设备空间后重新导入。';
  const reason = error.name === 'TypeError' ? `网络连接失败（${error.message}）` : error.message;
  return `未完成：${reason}。`;
}

/**
 * Call before the game boots. A returning player never waits: the local cache is checked in the background while the
 * service worker already answers from it. A first visit shows the resource dialog: import a ZIP or skip.
 */
export async function prepareResources() {
  if (!supported()) {
    toast('当前浏览器无法保存本地资源，游戏将使用占位图。请用最新版 Chrome、Edge、Safari 或 Firefox 打开本站。', 'warn', { ttl: 8000 });
    return;
  }
  if (localStorage.getItem(VISITED_KEY)) {
    registerWorker().catch(error => console.error('[resources] service worker registration failed', error));
    checkInstallation().catch(error => console.error('[resources] local resource check failed', error));
    return;
  }
  const store = await openStore();
  if (!store) return; // reported by openStore(); the next visit asks again
  const status = await showManager(store, true);
  localStorage.setItem(VISITED_KEY, 'visited');
  if (status?.count) {
    // This page asked for /fonts/fonts.css before the service worker could answer it: start over with the files.
    location.reload();
    await new Promise(() => {}); // the reload replaces this page; its boot goes no further
  }
}

/** Bring the cache to the live site version: a new version drops the files it changed. */
async function checkInstallation() {
  const store = await loadStore();
  await exclusive(() => checkStatus(store));
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
    toast(`本地资源不可用：${error.message}。`, 'warn', { ttl: 6000 });
    return null;
  }
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

    // Aborts the check or operation in progress (取消, closing the dialog), also while it waits for the lock.
    let controller = null;
    let operation = null;
    let closing = false;
    let closed = false;
    const state = { status: null, busy: true, waiting: false, phase: 'checking', message: '', error: false };

    function update(patch) {
      Object.assign(state, patch);
      if (closed) return;
      render(html`<${ResourceDialog} state=${state} firstTime=${firstTime} totalBytes=${store.manifest.totalBytes}
        onClose=${close} onImport=${importZip} onClear=${clear}
        onCancel=${() => { controller?.abort(); update({ message: '正在取消…' }); }} />`, host);
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
      update({ busy: true, phase, message: '正在准备，请稍候…', error: false });
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
          const cancelled = error.name === 'AbortError';
          if (!cancelled) console.error(`[resources] ${phase} failed`, error);
          const message = readableError(error);
          update({ message, error: !cancelled });
          toast(message, cancelled ? 'info' : 'error');
        }
        update({ busy: false, waiting: false });
        operation = null;
      })();
      await operation;
    }

    function importZip(file) {
      const action = signal => importResourceZip(file, store, { signal, onProgress: status => update({ status }) });
      return run('import', action, ({ complete, imported, skipped, total, count }) => {
        const result = complete ? '全部资源已导入。'
          : skipped ? `已导入 ${imported} 个文件，${skipped} 个与本站版本不一致已跳过，还缺 ${total - count} 个。`
          : `已导入 ${imported} 个文件，还缺 ${total - count} 个。`;
        // The first visit's page starts over when the dialog closes; a running page uses the files it loads from now on.
        return firstTime ? result : `${result}刷新页面后完全生效。`;
      });
    }

    function clear() {
      return run('clear', () => store.clear(), () => '本地资源已清理。');
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
