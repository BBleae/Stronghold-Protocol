// 资源管理: the button that opens the local resource dialog (js/resources/), placed by the screens next to 玩法说明
// (title, lobby, room; never in a match). The resource manager installs its opener at boot (Cloudflare mode, in a browser
// that can keep local resources); without one there is no button.
import { html, Button } from './components.js';
import { t } from '../../../shared/i18n.js';

let open = null;

/** The resource manager's opener (js/resources/index.js installResourceManager). */
export function installResourceOpener(opener) {
  open = opener;
}

/** Standard 资源管理 trigger button. `square`: the glyph alone (the lobby's top bar, beside ⚙ / 📖), the name stays
 *  title / aria-label. */
export function ResourceButton({ class: cls, size = 'sm', variant = 'ghost', square = false }) {
  if (!open) return null;
  return html`<${Button} id="resource-manager-open" class=${cls} size=${size} variant=${variant} icon="archive" square=${square}
    onClick=${open} title=${t('下载、导入、导出或清理本地游戏资源')} aria-label=${t('资源管理')}>${square ? null : t('资源管理')}<//>`;
}
