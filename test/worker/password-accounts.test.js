// Password accounts on the production Worker (Miniflare): registration and login with their rules and limits, display
// names (昵称#NNNN, unique site-wide), a new nickname, a new password, and the administrator's password reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';
import { PBKDF2_ITERATIONS } from '../../worker/accounts/passwords.js';

const ADMIN_TOKEN = 'admin-'.repeat(8);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
let network = 0;
/** A network of its own, so that one scenario's attempts never count against another's limit. */
const freshIp = () => `10.${(++network >> 8) & 255}.${network & 255}.1`;

function accounts(world) {
  const post = (path, body, { cookie = '', ip = freshIp(), headers } = {}) => world.api('z', path, { method: 'POST', body, cookie, ip, headers });
  return {
    register: (username, password, nickname, options) => post('/api/auth/register', { username, password, nickname }, options),
    login: (username, password, options) => post('/api/auth/login', { username, password }, options),
    logout: (cookie) => post('/api/auth/logout', {}, { cookie }),
    me: async (cookie) => (await world.api('z', '/api/me', { cookie })).body,
    rename: (cookie, nickname) => post('/api/me/nickname', { nickname }, { cookie }),
    changePassword: (cookie, current, password, options) => post('/api/me/password', { current, password }, { cookie, ...options }),
    reset: (username, password, token = ADMIN_TOKEN) => world.api('z', '/api/admin/accounts/password', { method: 'POST',
      body: { username, password }, cookie: '', headers: token ? { Authorization: 'Bearer ' + token } : {} }),
  };
}

test('register, log in and log out; a username is unique in any case and never needed again but to log in', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const a = accounts(world);
  const created = await a.register('Doctor_01', 'correct horse', '  晴猫 ');
  assert.equal(created.status, 201);
  const user = created.body.user;
  assert.match(user.discriminator, /^\d{4}$/);
  assert.deepEqual(user, { accountId: user.accountId, provider: 'password', username: 'Doctor_01', nickname: '晴猫', nicknameSource: 'user',
    discriminator: user.discriminator, name: '晴猫#' + user.discriminator, avatarUrl: null });
  assert.ok(created.session, 'registering signs in');
  assert.deepEqual((await a.me(created.session)).user, user);
  assert.deepEqual((await a.me(created.session)).capabilities, { password: true, github: false });

  const [row] = await world.exec('SELECT username, account_id, password FROM local_users WHERE username_key=?', 'doctor_01');
  assert.equal(row.username, 'Doctor_01', 'the username as typed');
  assert.equal(row.account_id, user.accountId);
  const stored = JSON.parse(row.password);
  assert.deepEqual(Object.keys(stored).sort(), ['alg', 'hash', 'iterations', 'salt']);
  assert.equal(stored.alg, 'pbkdf2-sha256');
  assert.equal(stored.iterations, PBKDF2_ITERATIONS);
  assert.ok(stored.iterations <= 100_000, 'Cloudflare Workers allow at most 100,000 PBKDF2 iterations');
  assert.ok(!row.password.includes('correct horse'));

  for (const username of ['doctor_01', 'DOCTOR_01']) {
    assert.deepEqual((await a.register(username, 'another one', '别人')).body, { error: 'USERNAME_TAKEN' }, username);
  }

  const login = await a.login('DOCTOR_01', 'correct horse');
  assert.equal(login.status, 200, 'any case logs in');
  assert.deepEqual(login.body.user, user);
  assert.ok(login.session && login.session !== created.session);
  // A wrong password and an unknown username get the same answer.
  for (const [username, password] of [['Doctor_01', 'wrong horse'], ['nobody_here', 'correct horse'], ['no', 'correct horse'], ['Doctor_01', '']]) {
    const refused = await a.login(username, password);
    assert.deepEqual(refused, { status: 401, body: { error: 'BAD_CREDENTIALS' } }, `${username}/${password}`);
  }
  assert.deepEqual((await a.login(['Doctor_01'], 'correct horse')).body, { error: 'BAD_MSG' });

  assert.equal((await a.logout(login.session)).status, 204);
  assert.equal((await a.me(login.session)).user, null, 'that session ended');
  assert.deepEqual((await a.me(created.session)).user, user, 'the other one did not');
});

test('registration refuses invalid usernames, passwords and nicknames', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const a = accounts(world);
  const cases = [
    [['ab', 'long enough', '代号'], 'INVALID_USERNAME'],
    [['a'.repeat(21), 'long enough', '代号'], 'INVALID_USERNAME'],
    [['bad name', 'long enough', '代号'], 'INVALID_USERNAME'],
    [['博士名字', 'long enough', '代号'], 'INVALID_USERNAME'],
    [['dash-name', 'long enough', '代号'], 'INVALID_USERNAME'],
    [[null, 'long enough', '代号'], 'INVALID_USERNAME'],
    [['gooduser', 'seven77', '代号'], 'INVALID_PASSWORD'],
    [['gooduser', 'x'.repeat(129), '代号'], 'INVALID_PASSWORD'],
    [['gooduser', '😀'.repeat(129), '代号'], 'INVALID_PASSWORD'],
    [['gooduser', 12345678, '代号'], 'INVALID_PASSWORD'],
    [['gooduser', 'long enough', ''], 'INVALID_NICKNAME'],
    [['gooduser', 'long enough', ` ${ZERO_WIDTH_SPACE} `], 'INVALID_NICKNAME'],
    [['gooduser', 'long enough', 'a#b'], 'INVALID_NICKNAME'],
    [['gooduser', 'long enough', '晴猫＃1'], 'INVALID_NICKNAME'],
    [['gooduser', 'long enough', '名'.repeat(13)], 'INVALID_NICKNAME'],
    [['gooduser', 'long enough', undefined], 'INVALID_NICKNAME'],
  ];
  for (const [args, error] of cases) {
    const response = await a.register(...args);
    assert.deepEqual([response.status, response.body], [400, { error }], JSON.stringify(args));
  }
  assert.equal((await world.exec('SELECT COUNT(*) AS n FROM local_users'))[0].n, 0);
  // The limits themselves are allowed: 3 and 20 characters, 8 and 128 (code points), a 12-character nickname.
  const longest = await a.register('u'.repeat(20), '😀'.repeat(128), '名'.repeat(12));
  assert.equal(longest.status, 201);
  assert.equal(longest.body.user.name, '名'.repeat(12) + '#' + longest.body.user.discriminator, 'a 17-character name, uncut');
  assert.equal((await a.register('abc', '12345678', `a${ZERO_WIDTH_SPACE}b`)).body.user.nickname, 'ab', 'invisible characters are dropped');
});

test('credential attempts are limited per network and per username', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const a = accounts(world);
  const ip = freshIp();
  for (let n = 0; n < 3; n++) assert.equal((await a.register('limited' + n, 'long enough', '代号', { ip })).status, 201);
  assert.deepEqual((await a.register('limited9', 'long enough', '代号', { ip })).body, { error: 'RATE_LIMITED' }, 'a 4th registration a minute');
  assert.equal((await a.register('limited9', 'long enough', '代号')).status, 201, 'another network registers');

  const network = freshIp();
  for (let n = 0; n < 10; n++) assert.equal((await a.login('unknown' + n, 'whatever1', { ip: network })).status, 401);
  assert.deepEqual((await a.login('limited0', 'long enough', { ip: network })).body, { error: 'RATE_LIMITED' }, 'an 11th login from one network');

  for (let n = 0; n < 5; n++) assert.equal((await a.login('Limited1', 'wrong guess' + n)).status, 401);
  const blocked = await a.login('limited1', 'long enough');
  assert.deepEqual(blocked, { status: 429, body: { error: 'RATE_LIMITED' } }, 'a 6th login of one username, even right, from anywhere');
  assert.equal((await a.login('limited2', 'long enough')).status, 200, 'other usernames are not affected');
});

test('concurrent registrations with one nickname get distinct discriminators until none is left', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const a = accounts(world);
  const created = await Promise.all(Array.from({ length: 12 }, (_, n) => a.register('same' + n, 'long enough', n % 2 ? '同名' : '同名 ')));
  assert.deepEqual(created.map((r) => r.status), Array(12).fill(201));
  const discriminators = created.map((r) => r.body.user.discriminator);
  assert.equal(new Set(discriminators).size, 12);
  assert.deepEqual((await world.exec("SELECT COUNT(*) AS n FROM display_names WHERE name_key='同名'"))[0].n, 12);

  // Look-alike and case variants share the discriminators: 'Ｆｕｌｌ' and 'full' are one nickname key.
  await world.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9998)
    INSERT INTO display_names SELECT 'full', printf('%04d', i), 'filler-' || i FROM n`);
  const last = await a.register('lastone', 'long enough', 'Ｆｕｌｌ');
  assert.equal(last.body.user.name, 'Ｆｕｌｌ#9999', 'the one discriminator left');
  assert.deepEqual((await a.register('toomany', 'long enough', 'FULL')).body, { error: 'NICKNAME_FULL' });
  assert.deepEqual((await world.exec("SELECT COUNT(*) AS n FROM local_users WHERE username_key='toomany'"))[0].n, 0, 'nothing of it stays');
  assert.deepEqual((await a.rename(created[0].session, 'full')).body, { error: 'NICKNAME_FULL' });
});

test('a new nickname keeps the discriminator when it is free, and frees the old name', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const a = accounts(world);
  const { body: { user }, session } = await a.register('renamer', 'long enough', '旧代号');
  const renamed = await a.rename(session, '  新代号 ');
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.user, { ...user, nickname: '新代号', name: '新代号#' + user.discriminator });
  assert.deepEqual((await a.me(session)).user, renamed.body.user);
  assert.deepEqual(await world.exec('SELECT name_key, disc FROM display_names WHERE account_id=?', user.accountId),
    [{ name_key: '新代号', disc: user.discriminator }], 'the old pair is free');
  // Its discriminator is taken under the next nickname: another one.
  await world.exec('INSERT INTO display_names VALUES (?,?,?)', 'busy', user.discriminator, 'someone-else');
  const moved = (await a.rename(session, 'Busy')).body.user;
  assert.notEqual(moved.discriminator, user.discriminator);
  assert.equal(moved.name, 'Busy#' + moved.discriminator);
  assert.equal((await a.rename(session, 'busy')).body.user.discriminator, moved.discriminator, 'a case change keeps it');
  for (const nickname of ['', 'a#b', '名'.repeat(13), 42]) assert.deepEqual((await a.rename(session, nickname)).body, { error: 'INVALID_NICKNAME' });
  assert.equal((await a.rename('', 'x')).status, 401);
  assert.equal((await world.api('z', '/api/me/nickname', { method: 'POST', body: { nickname: 'x' }, cookie: session,
    headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('a new password needs the current one and ends every other session', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const a = accounts(world);
  const { session } = await a.register('changer', 'first password', '改密码');
  const other = (await a.login('changer', 'first password')).session;
  assert.deepEqual((await a.changePassword(session, 'not it at all', 'second password')).body, { error: 'WRONG_PASSWORD' });
  assert.deepEqual((await a.changePassword(session, 'first password', 'short')).body, { error: 'INVALID_PASSWORD' });
  assert.equal((await a.changePassword(session, 'first password', 'second password')).status, 204);
  assert.equal((await a.me(other)).user, null, 'the other session ended');
  assert.equal((await a.me(session)).user.username, 'changer', 'this one stays');
  assert.equal((await a.login('changer', 'first password')).status, 401);
  assert.equal((await a.login('changer', 'second password')).status, 200);
  // GitHub accounts have no password to change.
  await world.seed('e');
  assert.deepEqual((await world.api('e', '/api/me/password', { method: 'POST', body: { current: 'x', password: 'new password' } })).body,
    { error: 'NO_PASSWORD' });
});

test('an administrator resets a password with the admin token, ending every session of the account', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t, { bindings: { ACCOUNT_ADMIN_TOKEN: ADMIN_TOKEN } });
  const a = accounts(world);
  const { body: { user }, session } = await a.register('forgetful', 'lost password', '健忘');
  for (const token of [null, 'admin', ADMIN_TOKEN + 'x']) assert.equal((await a.reset('forgetful', 'brand new pass', token)).status, 403);
  // A player's session is no authorization.
  assert.equal((await world.api('z', '/api/admin/accounts/password', { method: 'POST', body: { username: 'forgetful', password: 'brand new pass' },
    cookie: session })).status, 403);
  assert.deepEqual((await a.reset('nobody_here', 'brand new pass')).body, { error: 'ACCOUNT_NOT_FOUND' });
  assert.deepEqual((await a.reset('forgetful', 'short')).body, { error: 'INVALID_PASSWORD' });
  assert.equal((await a.reset('FORGETFUL', 'brand new pass')).status, 204);
  assert.equal((await a.me(session)).user, null, 'its sessions ended');
  assert.equal((await a.login('forgetful', 'lost password')).status, 401);
  assert.equal((await a.login('forgetful', 'brand new pass')).body.user.accountId, user.accountId);
  const logs = await world.room('ABCD', 'logs');
  assert.ok(logs.some((line) => line.event === 'account_password_reset' && line.accountId === user.accountId));
  assert.ok(!JSON.stringify(logs).includes('brand new pass'), 'never a password in the logs');
});

test('without ACCOUNT_ADMIN_TOKEN (or a short one) there is no password reset', { timeout: 120000 }, async (t) => {
  for (const bindings of [{}, { ACCOUNT_ADMIN_TOKEN: 'too-short-to-be-a-token' }]) {
    const world = await createWorld(t, { bindings });
    const a = accounts(world);
    await a.register('someone', 'some password', '某人');
    assert.equal((await a.reset('someone', 'brand new pass', bindings.ACCOUNT_ADMIN_TOKEN ?? ADMIN_TOKEN)).status, 403);
  }
});
