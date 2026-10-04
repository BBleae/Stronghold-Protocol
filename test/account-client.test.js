import test from 'node:test';
import assert from 'node:assert/strict';
import { account, accountRequest, loadAccount, githubLoginUrl, returnPath, ACCOUNT_REQUEST_TIMEOUT_MS } from '../public/js/account.js';
import { NetError } from '../public/js/net.js';

const answer = (status, body) => async () => Response.json(body, { status });

test('loadAccount reads /api/me once: capabilities, user, seat and application', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ user: { name: 'Alice#0042' }, capabilities: { password: true, github: false },
      activeSeat: { roomId: 'ABCD' }, application: null });
  };
  assert.equal((await loadAccount(fetch)).user.name, 'Alice#0042');
  assert.deepEqual(calls.map((c) => c.url), ['/api/me']);
  assert.deepEqual({ ...account }, { enabled: true, github: false, user: { name: 'Alice#0042' }, activeSeat: { roomId: 'ABCD' }, application: null });
  assert.equal(await accountRequest('/api/auth/logout', {}, async () => new Response(null, { status: 204 })), null);
});

test('account errors are NetErrors with the player-facing text of their code', async () => {
  const cases = {
    LOGIN_REQUIRED: '登录已失效，请重新登录',
    ALREADY_SEATED: '你已有一个房间，请先继续对局或离开',
    APPLICATION_PENDING: '已有一个加入申请，请先取消或等待处理',
    ROOM_FULL: '房间已满', // the socket's text for the same code
    INVALID_PAGE: '请求失败，请稍后重试（INVALID_PAGE）', // a developer error still reads as Chinese
  };
  for (const [code, text] of Object.entries(cases)) {
    await assert.rejects(accountRequest('/api/rooms', {}, answer(409, { error: code })), (e) => e instanceof NetError && e.code === code && e.message === text);
  }
});

test('every code the account API answers in a player flow has Chinese text', () => {
  // worker/index.js, worker/accounts/*, worker/rooms/*, worker/archive/routes.js: answers to the lobby, applications,
  // seats, history and replays (APPLICANT_BUSY: the host approves an applicant who is seated elsewhere meanwhile)
  const codes = ['LOGIN_REQUIRED', 'GITHUB_UNAVAILABLE', 'INVALID_USERNAME', 'USERNAME_TAKEN', 'INVALID_PASSWORD', 'INVALID_NICKNAME',
    'NICKNAME_FULL', 'BAD_CREDENTIALS', 'WRONG_PASSWORD', 'RATE_LIMITED', 'ACCOUNT_UNAVAILABLE', 'ALREADY_SEATED', 'APPLICATION_PENDING',
    'APPLICATION_EXPIRED', 'APPLICATION_NOT_FOUND', 'ALREADY_JOINED', 'TOO_MANY_APPLICATIONS', 'APPLICATION_FAILED',
    'APPLICANT_BUSY', 'LOBBY_UNAVAILABLE', 'HISTORY_UNAVAILABLE', 'ARCHIVE_NOT_READY', 'REPLAY_INCOMPLETE', 'FORBIDDEN',
    'ROOM_NOT_FOUND', 'ROOM_FULL', 'ROOM_STARTED', 'NOT_HOST', 'RATE', 'BAD_MSG', 'INTERNAL'];
  for (const code of codes) assert.match(new NetError(code).message, /[一-鿿]/, code);
});

test('a stalled request times out (headers or body) and is aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const aborted = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  for (const stall of ['headers', 'body']) {
    let signal;
    const request = accountRequest('/api/me/resume', {}, async (_url, init) => {
      signal = init.signal;
      return stall === 'headers' ? aborted(signal) : { status: 200, ok: true, json: () => aborted(signal) };
    });
    const rejected = assert.rejects(request, { code: 'TIMEOUT', message: '请求超时，请重试' });
    await Promise.resolve();
    t.mock.timers.tick(ACCOUNT_REQUEST_TIMEOUT_MS);
    await rejected;
    assert.equal(signal.aborted, true, stall);
  }
});

test('no answer is OFFLINE; an answer that is not the API\'s JSON is UNAVAILABLE and logged', async (t) => {
  await assert.rejects(accountRequest('/api/me', undefined, async () => { throw new TypeError('Failed to fetch'); }),
    { code: 'OFFLINE', message: '未连接到服务器' });
  const warn = t.mock.method(console, 'warn', () => {});
  await assert.rejects(accountRequest('/api/me', undefined, async () => new Response('<html>Bad Gateway</html>', { status: 502 })),
    { code: 'UNAVAILABLE', message: '服务器暂时不可用，请稍后重试' });
  assert.equal(warn.mock.callCount(), 1);
});

test('a login (password or GitHub) carries a pending invite code back, nothing else', () => {
  assert.equal(returnPath(), '/');
  assert.equal(returnPath('ABCD'), '/?room=ABCD');
  assert.equal(githubLoginUrl(), '/api/auth/github/start');
  assert.equal(githubLoginUrl('ABCD'), '/api/auth/github/start?return=%2F%3Froom%3DABCD');
  for (const room of ['AB12', 'abcd', 'ABCDE', '/evil']) {
    assert.equal(returnPath(room), '/');
    assert.equal(githubLoginUrl(room), '/api/auth/github/start');
  }
});

test('the sign-in texts are the ones the player is told', () => {
  const texts = { INVALID_USERNAME: '用户名为 3–20 位字母、数字或下划线', USERNAME_TAKEN: '用户名已被使用', INVALID_PASSWORD: '密码长度为 8–128 位',
    INVALID_NICKNAME: '代号为 1–12 个字，不能包含 #', NICKNAME_FULL: '这个代号已被太多人使用，请换一个', BAD_CREDENTIALS: '用户名或密码错误',
    WRONG_PASSWORD: '当前密码不正确', RATE_LIMITED: '尝试次数过多，请稍后再试', GITHUB_UNAVAILABLE: 'GitHub 登录暂不可用' };
  for (const [code, text] of Object.entries(texts)) assert.equal(new NetError(code).message, text, code);
});
