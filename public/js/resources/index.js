import { validateManifest } from './common.js';
import { ResourceStore } from './store.js';
import { importResourceZip } from './zip.js';

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
    const dialog = document.createElement('dialog');
    dialog.className = 'resource-dialog';
    dialog.setAttribute('aria-labelledby', 'resource-heading');
    // Omit accept: iOS file providers can label ZIPs with an unexpected type.
    // zip.js and the trusted manifest validate the selected file's actual contents.
    dialog.innerHTML = `<div class="resource-card">
      <p class="resource-kicker">STRONGHOLD PROTOCOL / RESOURCE MANAGER</p>
      <h2 id="resource-heading"></h2>
      <p class="resource-intro"></p>
      <div class="resource-stat" aria-live="polite">正在检查本地资源…</div>
      <progress class="resource-progress" max="1" value="0" aria-label="资源安装进度"></progress>
      <p class="resource-message" role="status"></p>
      <div class="resource-actions">
        <button type="button" class="resource-primary" data-action="download">在线下载 / 继续下载</button>
        <button type="button" data-action="import">导入本地 ZIP</button>
        <button type="button" data-action="cancel" hidden>暂停</button>
        <button type="button" data-action="clear">清理本地资源</button>
      </div>
      <input type="file" hidden aria-label="选择本地资源 ZIP" />
      <p class="resource-note">ZIP 只在本机读取，不会上传。仅导入与本站清单匹配的资源，其余文件直接跳过，不解压、不校验。浏览器可能自动清理缓存，之后可重新补齐。</p>
      <button type="button" class="resource-continue" data-action="continue"></button>
    </div>`;
    document.body.append(dialog);
    const $ = selector => dialog.querySelector(selector);
    $('#resource-heading').textContent = firstTime ? '准备游戏资源' : '资源管理';
    $('.resource-intro').textContent = `完整资源约 ${mib(context.manifest.totalBytes)}。提前保存可减少对局中的等待；在线模式支持按文件继续下载。`;
    const buttons = [...dialog.querySelectorAll('.resource-actions button')];
    const message = $('.resource-message');
    message.textContent = context.startupError ?? '';
    const continueButton = $('[data-action="continue"]');
    continueButton.textContent = firstTime ? '暂时跳过，按需加载' : '返回游戏';
    let controller, operation, completed = false, closing = false;
    function progress(status) {
      completed = status.complete;
      $('.resource-stat').textContent = `${status.count} / ${status.total} 个文件 · ${mib(status.bytes)} / ${mib(status.totalBytes)}`;
      $('.resource-progress').value = status.totalBytes ? status.bytes / status.totalBytes : 1;
      continueButton.textContent = completed ? '资源已就绪，进入游戏' : firstTime ? '暂时跳过，按需加载' : '返回游戏';
    }
    function busy(value) {
      for (const button of buttons) button.disabled = value || !context.store;
      $('[data-action="cancel"]').hidden = !value;
      $('[data-action="cancel"]').disabled = false;
    }
    async function refresh() {
      if (context.store) progress(await context.store.status());
      else { $('.resource-stat').textContent = '按需加载可用'; message.textContent = context.unavailable; busy(false); }
    }
    async function run(action) {
      if (operation || !context.store) return;
      controller = new AbortController();
      busy(true); message.textContent = '正在准备，请稍候…';
      operation = (async () => {
        try {
          await workerReady();
          if (controller.signal.aborted) return;
          const status = await action({ signal: controller.signal, onProgress: progress });
          preference('install');
          if (status) progress(status);
          message.textContent = status?.complete ? '全部资源已保存，可进入游戏。' : '操作已完成。';
        } catch (error) { message.textContent = readableError(error); }
        finally {
          await refresh().catch(error => { message.textContent = readableError(error); });
          busy(false); operation = undefined;
        }
      })();
      await operation;
    }
    async function close() {
      if (closing) return;
      closing = true;
      controller?.abort();
      if (operation) await operation;
      preference(completed ? 'install' : 'ondemand');
      dialog.close(); dialog.remove();
      window.__spResourcesPreparing = preparingBefore;
      if (boot) boot.style.display = bootDisplay;
      lastFocus?.focus();
      openDialog = undefined; resolve();
    }
    $('[data-action="download"]').onclick = () => run(options => context.store.download(options));
    $('[data-action="import"]').onclick = () => $('input').click();
    $('input').onchange = () => {
      const file = $('input').files[0];
      if (file) void run(options => importResourceZip(file, context.store, options));
      $('input').value = '';
    };
    $('[data-action="clear"]').onclick = () => run(async () => { await context.store.clear(); return context.store.status(); });
    $('[data-action="cancel"]').onclick = () => { controller?.abort(); message.textContent = '正在暂停…'; };
    continueButton.onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
    dialog.showModal();
    busy(true);
    refresh().catch(error => { message.textContent = readableError(error); }).finally(() => busy(false));
  });
  return openDialog;
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

/** Safe to call after boot; adds a permanent, small resource-manager entry. */
export async function installResourceManager() {
  const context = await getContext();
  if (!context || document.getElementById('resource-manager-open')) return;
  loadStyle();
  const button = document.createElement('button');
  button.id = 'resource-manager-open'; button.type = 'button'; button.textContent = '资源管理';
  button.title = '下载、导入或清理本地游戏资源';
  button.onclick = () => { void showManager(context); };
  document.body.append(button);
}
