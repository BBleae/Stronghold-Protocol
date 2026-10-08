// The account forms (Workers deployment), built from the shared components only: the title screen's account card
// (登录 / 注册 with a username and password; GitHub when the server offers it) and the account menu's dialogs
// (修改代号, 修改密码). Each field is checked against the server's rules (shared/account-protocol.js) before anything is
// sent; a mistake shows under its field — the rule it breaks, or the server's answer about it — and anything else is
// a toast.

import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, Tabs, TextField } from './components.js';
import { toast, toastError } from './toasts.js';
import { account, accountRequest, githubLoginUrl, returnPath } from '../account.js';
import { identity, CLIENT_ERR_TEXT } from '../net.js';
import { store } from '../store.js';
import { normalizeName } from '../names.js';
import { USERNAME_PATTERN, validPassword, validNickname } from '../../../shared/account-protocol.js';
import { t, N_ } from '../../../shared/i18n.js';

// The rules a field is checked against: the code of the one it breaks (its text: net.js CLIENT_ERR_TEXT), or null.
const RULES = {
  username: (value) => (USERNAME_PATTERN.test(value) ? null : 'INVALID_USERNAME'),
  password: (value) => (validPassword(value) ? null : 'INVALID_PASSWORD'),
  nickname: (value) => (validNickname(normalizeName(value)) ? null : 'INVALID_NICKNAME'),
};

// The field an answer of the server is about.
const FIELD_OF = {
  INVALID_USERNAME: 'username',
  USERNAME_TAKEN: 'username',
  INVALID_PASSWORD: 'password',
  BAD_CREDENTIALS: 'password',
  INVALID_NICKNAME: 'nickname',
  NICKNAME_FULL: 'nickname',
  WRONG_PASSWORD: 'current',
};

/**
 * A form's values, the mistake shown under each field, and whether it is being sent. `field(name)` gives a TextField
 * its value, input and mistake; `submit(found, send)` sends only when no field has a mistake (found: { name: code or
 * null }). Mistakes stay until the next send (or `forget()`): a hint that went at the first keystroke would move the
 * fields while the player is still fixing one.
 */
function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [mistakes, setMistakes] = useState({});
  const [busy, setBusy] = useState(false);
  const field = (name) => ({
    name,
    value: values[name],
    onInput: (value) => setValues((current) => ({ ...current, [name]: value })),
    invalid: !!mistakes[name],
    hint: mistakes[name] ? html`<span class="t-red" role="alert">${t(CLIENT_ERR_TEXT[mistakes[name]])}</span>` : null,
  });
  const submit = async (found, send) => {
    const shown = Object.fromEntries(Object.entries(found).filter(([, code]) => code));
    setMistakes(shown);
    if (busy || Object.keys(shown).length) return;
    setBusy(true);
    try {
      await send();
    } catch (error) {
      const name = FIELD_OF[error.code];
      if (name && name in values) setMistakes({ [name]: error.code });
      else toastError(error);
      setBusy(false);
    }
  };
  return { values, field, submit, busy, forget: () => setMistakes({}) };
}

/**
 * Lead to the title screen's account card: this page's login is gone (logged out, expired, or never made). Nothing
 * else is dropped: a seat this tab was in is resumed after the new login (main.js boot).
 */
export function openLogin() {
  account.user = null;
  identity.setEntered(false);
  store.patch('session', { entered: false });
}

const TABS = [
  { id: 'login', label: N_('登录') },
  { id: 'register', label: N_('注册') },
];

/**
 * The title screen's account card (account mode, signed out): 登录 / 注册 with a username and password, 使用 GitHub 登录
 * when the server offers it, and 浏览在线大厅. A login starts the page over as the account (its preferences, its seat),
 * at the invite it was opened with. `autoFocus`: the username field takes the focus (not on touch screens, where it
 * would pop the keyboard up over the screen).
 */
export function AccountCard({ pendingJoin, autoFocus }) {
  const [tab, setTab] = useState('login');
  const form = useForm({ username: '', password: '', confirm: '', nickname: '' });
  const register = tab === 'register';
  const { username, password, confirm, nickname } = form.values;
  const send = (event) => {
    event.preventDefault();
    const found = { username: RULES.username(username), password: RULES.password(password) };
    if (register)
      Object.assign(found, {
        nickname: RULES.nickname(nickname),
        confirm: confirm === password ? null : 'PASSWORD_MISMATCH',
      });
    form.submit(found, async () => {
      if (register) await accountRequest('/api/auth/register', { username, password, nickname });
      else await accountRequest('/api/auth/login', { username, password });
      location.assign(returnPath(pendingJoin));
    });
  };
  const switchTab = (id) => {
    form.forget();
    setTab(id);
  };
  return html`
    <${Tabs} items=${TABS.map((item) => ({ ...item, label: t(item.label) }))} value=${tab} onChange=${switchTab} />
    <form class="title-login__form" onSubmit=${send}>
      <${TextField} label=${t('用户名')} micro="USERNAME" icon="user" autocomplete="username" maxLength=${20} autoFocus=${autoFocus}
        placeholder=${register ? t('仅用于登录，不会展示给其他博士') : t('输入用户名')} ...${form.field('username')} />
      ${
        register
          ? html`<${TextField} label=${t('博士代号')} micro="CALLSIGN" icon="edit" placeholder=${t('输入你的代号（最多 12 字）')}
        ...${form.field('nickname')} />`
          : null
      }
      <${TextField} label=${t('密码')} micro="PASSWORD" icon="shield" type="password" autocomplete=${register ? 'new-password' : 'current-password'}
        placeholder=${register ? t('8–128 位') : t('输入密码')} ...${form.field('password')} />
      ${
        register
          ? html`<${TextField} label=${t('确认密码')} micro="CONFIRM" icon="shield" type="password" autocomplete="new-password"
        placeholder=${t('再次输入密码')} ...${form.field('confirm')} />`
          : null
      }
      <${Button} type="submit" variant="primary" size="xl" block=${true} loading=${form.busy}>${register ? t('注册') : t('登录')}<//>
    </form>
    ${
      register
        ? null
        : html`
      ${
        account.github
          ? html`<${Button} class="title-login__github" variant="ghost" size="lg" block=${true}
        onClick=${() => location.assign(githubLoginUrl(pendingJoin))}>${t('使用 GitHub 登录')}<//>`
          : null
      }
      <${Button} variant="ghost" size="lg" block=${true} onClick=${() => store.patch('session', { entered: true })}>${t('浏览在线大厅')}<//>`
    }`;
}

// A dialog of the account menu: a form in a Modal, its buttons in the Modal's footer.
function AccountDialog({ id, title, form, onSubmit, onClose, children }) {
  return html`<${Modal} open=${true} title=${title} micro=${t('ACCOUNT // 账号')} onClose=${onClose}
    actions=${html`<${Button} variant="secondary" onClick=${onClose}>${t('取消')}<//>
      <${Button} type="submit" form=${id} variant="primary" icon="check" loading=${form.busy}>${t('确认')}<//>`}>
    <form id=${id} class="account-form" onSubmit=${(event) => {
      event.preventDefault();
      onSubmit();
    }}>${children}</form>
  <//>`;
}

/** 修改代号: the account's nickname; its discriminator stays when it is free under the new one. */
export function NicknameDialog({ onClose }) {
  const form = useForm({ nickname: account.user.nickname });
  const save = () =>
    form.submit({ nickname: RULES.nickname(form.values.nickname) }, async () => {
      const { user } = await accountRequest('/api/me/nickname', { nickname: form.values.nickname });
      account.user = user;
      store.patch('me', { name: user.name });
      toast(t('博士代号已改为 {name}', { name: user.name }), 'success');
      onClose();
    });
  return html`<${AccountDialog} id="account-nickname" title=${t('修改代号')} form=${form} onSubmit=${save} onClose=${onClose}>
    <${TextField} label=${t('博士代号')} micro="CALLSIGN" icon="edit" ...${form.field('nickname')} />
  <//>`;
}

/** 修改密码 (password accounts): needs the current password; the account's other logins end. */
export function PasswordDialog({ onClose }) {
  const form = useForm({ current: '', password: '', confirm: '' });
  const { current, password, confirm } = form.values;
  const save = () =>
    form.submit(
      {
        current: current ? null : 'WRONG_PASSWORD',
        password: RULES.password(password),
        confirm: confirm === password ? null : 'PASSWORD_MISMATCH',
      },
      async () => {
        await accountRequest('/api/me/password', { current, password });
        toast(t('密码已修改，其他设备上的登录已退出'), 'success');
        onClose();
      },
    );
  // The hidden username (for password managers) comes last: the dialog focuses its first input, 当前密码.
  return html`<${AccountDialog} id="account-password" title=${t('修改密码')} form=${form} onSubmit=${save} onClose=${onClose}>
    <${TextField} label=${t('当前密码')} micro="PASSWORD" icon="shield" type="password" autocomplete="current-password" ...${form.field('current')} />
    <${TextField} label=${t('新密码')} micro="NEW PASSWORD" icon="shield" type="password" autocomplete="new-password" ...${form.field('password')} />
    <${TextField} label=${t('确认新密码')} micro="CONFIRM" icon="shield" type="password" autocomplete="new-password" ...${form.field('confirm')} />
    <input type="text" name="username" autocomplete="username" value=${account.user.username} hidden />
  <//>`;
}
