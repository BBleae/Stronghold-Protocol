// 安装: install the site as an app (PWA: public/manifest.webmanifest). The title screen's button
//   - Chromium (desktop, Android) offers its own install prompt: the beforeinstallprompt event is kept from page load
//     and replayed on the click;
//   - iPhone / iPad, Safari on the Mac and Android browsers without that event install from a menu: the button explains how;
//   - in-app browsers (WeChat, QQ, …) cannot install at all: it says to open the page in a browser first.
// Hidden where the page already runs as an installed app (display-mode standalone / fullscreen, iOS navigator.standalone)
// and where none of the above applies (Firefox on the desktop).

import { useEffect, useReducer } from '../../vendor/hooks.module.js';
import { html, Button, alertDialog } from './components.js';
import { detectFeatures } from './device.js';
import { t } from '../../../shared/i18n.js';

let deferred = null;       // the beforeinstallprompt event, until it is used
let installed = false;     // appinstalled fired in this page
const listeners = new Set();
const notify = () => { for (const fn of [...listeners]) fn(); };

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; installed = true; notify(); });
}

const IN_APP = /MicroMessenger|\bQQ\/|Weibo|DingTalk|AlipayClient|Lark\/|FBAN|FBAV|Instagram|\bLine\//i;

/**
 * How this browser installs the site (pure; tests).
 * @param {{ ua?: string, standalone?: boolean, canPrompt?: boolean, maxTouchPoints?: number }} env
 * @returns {null|'prompt'|'inapp'|'ios'|'mac-safari'|'android'} null: already an app, or no way to install
 */
export function installMode({ ua = '', standalone = false, canPrompt = false, maxTouchPoints = 0 } = {}) {
  if (standalone) return null;
  if (IN_APP.test(ua)) return 'inapp';
  if (canPrompt) return 'prompt';
  // iPadOS Safari presents itself as a Mac; only the touch points tell
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(ua)) {
    const v = /Version\/(\d+)/.exec(ua);
    if (v && Number(v[1]) >= 17) return 'mac-safari';   // 添加到程序坞 since Safari 17
  }
  return null;
}

function currentMode() {
  if (installed || typeof navigator === 'undefined') return null;
  return installMode({ ua: navigator.userAgent || '', standalone: detectFeatures().standalone, canPrompt: !!deferred,
    maxTouchPoints: Number(navigator.maxTouchPoints) || 0 });
}

const steps = (...items) => html`<ol class="install-steps">${items.map((s, i) => html`<li key=${i}>${s}</li>`)}</ol>`;
// the texts are getters: read when the dialog opens, in the language of that moment (docs/I18N.md)
const after = () => html`<p class="modal__text">${t('之后从图标打开，就是全屏的应用，不再有浏览器的地址栏。')}</p>`;
export const INSTALL_HELP = Object.freeze({
  ios: {
    get title() { return t('添加到主屏幕'); },
    get text() { return html`${steps(t('点浏览器的「分享」按钮（Safari 在底部工具栏，iPad 在右上角）'), t('在列表里选「添加到主屏幕」'), t('点「添加」'))}${after()}`; },
  },
  'mac-safari': {
    get title() { return t('添加到程序坞'); },
    get text() { return html`${steps(t('点菜单栏的「文件」'), t('选「添加到程序坞」'))}<p class="modal__text">${t('之后从程序坞或启动台打开，就是独立的应用窗口。')}</p>`; },
  },
  android: {
    get title() { return t('安装到桌面'); },
    get text() { return html`${steps(t('点浏览器右上角的菜单（⋮ 或 ≡）'), t('选「安装应用」或「添加到主屏幕」'))}${after()}`; },
  },
  inapp: {
    get title() { return t('请先用浏览器打开'); },
    get text() { return html`<p class="modal__text">${t('微信、QQ 等应用里打开的页面不能安装。请点右上角的「…」，选「在浏览器打开」，再在浏览器里点「安装」。')}</p>`; },
  },
});

/** Standard 安装 trigger (title screen); renders nothing where the site cannot be installed or already is. */
export function InstallButton({ class: cls, size = 'sm', variant = 'ghost' }) {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    const display = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)');
    display?.addEventListener?.('change', force);
    return () => { listeners.delete(force); display?.removeEventListener?.('change', force); };
  }, []);
  const mode = currentMode();
  if (!mode) return null;
  const onClick = async () => {
    if (mode === 'prompt' && deferred) {
      const e = deferred;
      deferred = null;   // a prompt can be shown once; Chromium fires the event again if the player declines
      notify();
      try { await e.prompt(); await e.userChoice; } catch { /* the browser refused: nothing to do */ }
      return;
    }
    const help = INSTALL_HELP[mode];
    if (help) await alertDialog({ title: help.title, micro: 'INSTALL', text: help.text, okText: t('知道了') });
  };
  return html`<${Button} id="install-app" class=${cls} size=${size} variant=${variant} icon="download"
    onClick=${onClick} title=${t('把游戏安装到桌面或主屏幕，像应用一样打开')}>${t('安装')}<//>`;
}
