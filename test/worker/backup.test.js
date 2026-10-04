import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../../worker/accounts/auth.js';
import { sealBackup,validateBackup,handleBackupRoutes } from '../../worker/storage/backup.js';
import { createAccountHarness } from './helpers/account-harness.js';
test('backup validates independent content and refuses unknown versions and player credentials',async()=>{
  const text='{"battles":[]}',chunk={index:0,text,hash:await hash(text)};
  const facts={matchId:'m',participants:['a'],personal:[{accountId:'a',matchId:'m'}],manifest:{rulesVersion:'v1',chunks:[{index:0,hash:chunk.hash}]}};
  const backup=await sealBackup(facts,[chunk]);assert.equal((await validateBackup(backup,['v1'])).ok,true);
  await assert.rejects(validateBackup(backup,['v2']),/BACKUP_VERSION/);
  const changed=structuredClone(backup);changed.chunks[0].text+=' ';await assert.rejects(validateBackup(changed,['v1']),/BACKUP_HASH/);
  const response=await handleBackupRoutes(new Request('https://game.example/api/admin/backup/catalog',{headers:{cookie:'__Host-sp_session='+'a'.repeat(64)}}),{});
  assert.equal(response.status,403);
});
test('export, default dry-run and restore rebuild history without exporting sessions', {timeout:60000},async t=>{
  const create=()=>createAccountHarness(`
    export {SiteDirectory as TestObject} from './worker/accounts/directory.js';
    export {AccountDurableObject} from './worker/accounts/account.js';
    export {MatchArchive} from './worker/archive/archive.js';
    import {handleBackupRoutes} from './worker/storage/backup.js';
    import {publishArchive} from './worker/archive/outbox.js';
    import {hash} from './worker/accounts/auth.js';
    export default {async fetch(req,env){const i=await req.json();
      const d=env.SITES.get(env.SITES.idFromName('directory'));
      if(i.seed){const p=await d.resolveGithubUser({id:'42',login:'Alice',avatarUrl:null});
        await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(p.accountId)).setProfile(p);
        await d.saveSession(await hash('a'.repeat(64)),{accountId:p.accountId,expiresAt:Date.now()+60000});
        await publishArchive(env,{archiveEncoding:2,facts:{matchId:'m',participants:[p.accountId],result:{victory:true}},
          personal:[{matchId:'m',accountId:p.accountId,endedAt:1,mode:'solo',difficulty:'FUNNY',status:'completed',victory:true}],
          replay:{rulesVersion:'development-v1',battles:[]}});return Response.json(p);}
      if(i.session)return Response.json(await d.getSession(await hash('a'.repeat(64))));
      if(i.injectSession){await d.saveSession(await hash('a'.repeat(64)),{accountId:i.injectSession,expiresAt:Date.now()+60000});return Response.json({ok:true});}
      if(i.profile)return Response.json(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(i.profile)).getProfile());
      if(i.stats)return Response.json(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(i.stats)).getStats());
      return handleBackupRoutes(new Request('https://game.example/api/admin/backup/'+i.path,{method:i.body?'POST':'GET',
        headers:{Authorization:'Bearer '+(i.body?'i':'e').repeat(40)},body:i.body?JSON.stringify(i.body):undefined}),env);
    }};`,{durableObjects:{SITES:{className:'TestObject',useSQLite:true},ACCOUNTS:{className:'AccountDurableObject',useSQLite:true},MATCH_ARCHIVES:{className:'MatchArchive',useSQLite:true}},
      bindings:{ARCHIVE_EXPORT_TOKEN:'e'.repeat(40),ARCHIVE_IMPORT_TOKEN:'i'.repeat(40)}});
  const h=await create();t.after(()=>h.dispose());
  const p=await (await h.fetch({seed:true})).json();
  const backup=await (await h.fetch({path:'archive?id=m'})).json();
  assert.equal(backup.facts.manifest.codec,'gzip-base64');
  assert.ok(backup.hash);assert.ok(!JSON.stringify(backup).includes('session'));
  assert.equal((await (await h.fetch({path:'archive',body:{backup}})).json()).written,0);
  const destination=await create();t.after(()=>destination.dispose());
  assert.equal((await (await destination.fetch({stats:p.accountId})).json()).completed,0);
  assert.equal((await (await destination.fetch({path:'archive',body:{backup}})).json()).written,0);
  assert.equal(await (await destination.fetch({profile:p.accountId})).json(),null);
  await destination.fetch({injectSession:p.accountId});
  assert.equal((await (await destination.fetch({path:'profile',body:{profile:p,dryRun:false}})).json()).written,1);
  assert.equal(await (await destination.fetch({session:true})).json(),null,'restore revokes previous sessions');
  for(let i=0;i<2;i++)assert.equal((await (await destination.fetch({path:'archive',body:{backup,dryRun:false}})).json()).written,1);
  await destination.restart();
  assert.equal((await (await destination.fetch({stats:p.accountId})).json()).completed,1);
  assert.deepEqual((await (await destination.fetch({path:'archive?id=m'})).json()),backup);
  await h.restart();
  for(let i=0;i<2;i++)assert.equal((await (await h.fetch({path:'archive',body:{backup,dryRun:false}})).json()).written,1);
  assert.equal((await (await h.fetch({stats:p.accountId})).json()).completed,1);
});

// Accounts in backups: password accounts with their hashes, display names, and identities that must not change hands.
test('accounts export with their identities and display names, and restore without taking another account\'s', {timeout:60000}, async t => {
  const create = () => createAccountHarness(`
    import { SiteDirectory } from './worker/accounts/directory.js';
    export { AccountDurableObject } from './worker/accounts/account.js';
    export { MatchArchive } from './worker/archive/archive.js';
    import { handleBackupRoutes } from './worker/storage/backup.js';
    import { hash } from './worker/accounts/auth.js';
    import { hashPassword, verifyPassword } from './worker/accounts/passwords.js';
    export class TestObject extends SiteDirectory {
      exec(query, ...params) { return this.sql.exec(query, ...params).toArray(); }
    }
    export default { async fetch(req, env) {
      const i = await req.json();
      const site = env.SITES.get(env.SITES.idFromName('directory'));
      const account = (id) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id));
      if (i.register) {
        const accountId = crypto.randomUUID();
        return Response.json(await account(accountId).register({ accountId, username: i.register.username,
          password: await hashPassword(i.register.password), nickname: i.register.nickname }));
      }
      if (i.github) {
        const identity = await site.resolveGithubUser(i.github);
        return Response.json(await account(identity.accountId).applyGithubLogin(identity));
      }
      if (i.verify) return Response.json(await verifyPassword(i.verify.password, (await site.localUser(i.verify.username))?.password ?? null));
      if (i.session) {
        if (i.session.accountId) await site.saveSession(await hash(i.session.token), { accountId: i.session.accountId, expiresAt: Date.now() + 60000 });
        return Response.json(await site.getSession(await hash(i.session.token)));
      }
      if (i.exec) return Response.json(await site.exec(...i.exec));
      if (i.profile) return Response.json(await account(i.profile).getProfile());
      return handleBackupRoutes(new Request('https://game.example/api/admin/backup/' + i.path, { method: i.body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + (i.body ? 'i' : 'e').repeat(40) }, body: i.body ? JSON.stringify(i.body) : undefined }), env)
        .catch((error) => Response.json({ error: error.code }, { status: error.status }));
    }};`, { durableObjects: { SITES: { className: 'TestObject', useSQLite: true }, ACCOUNTS: { className: 'AccountDurableObject', useSQLite: true },
    MATCH_ARCHIVES: { className: 'MatchArchive', useSQLite: true } }, bindings: { ARCHIVE_EXPORT_TOKEN: 'e'.repeat(40), ARCHIVE_IMPORT_TOKEN: 'i'.repeat(40) } });
  const source = await create(); t.after(() => source.dispose());
  const call = async (h, body) => (await h.fetch(body)).json();
  const local = await call(source, { register: { username: 'Doctor_01', password: 'correct horse', nickname: '晴猫' } });
  const github = await call(source, { github: { id: '42', login: 'BBleae', name: 'GitHub 猫', avatarUrl: null } });

  const catalog = await call(source, { path: 'catalog?kind=profiles' });
  const entries = Object.fromEntries(catalog.items.map((entry) => [entry.accountId, entry]));
  assert.deepEqual(entries[github.accountId], github, 'a GitHub account: its profile');
  const { password, createdAt, ...profile } = entries[local.accountId];
  assert.deepEqual(profile, local, 'a password account: its profile…');
  assert.equal(password.alg, 'pbkdf2-sha256');
  assert.ok(Number.isSafeInteger(createdAt), '…its password hash and creation time');
  assert.ok(!JSON.stringify(catalog).includes('correct horse'));

  const destination = await create(); t.after(() => destination.dispose());
  // Someone else has the GitHub account's display name there: nothing is written.
  await call(destination, { exec: ['INSERT INTO display_names VALUES (?,?,?)', 'github 猫', github.discriminator, 'someone-else'] });
  assert.deepEqual(await call(destination, { path: 'profile', body: { profile: entries[github.accountId], dryRun: true } }), { error: 'IDENTITY_CONFLICT' });
  await call(destination, { exec: ['DELETE FROM display_names'] });
  // Nor may the username belong to another account.
  const other = await call(destination, { register: { username: 'doctor_01', password: 'another one', nickname: 'Other' } });
  assert.deepEqual(await call(destination, { path: 'profile', body: { profile: entries[local.accountId], dryRun: false } }), { error: 'IDENTITY_CONFLICT' });
  assert.equal(await call(destination, { profile: local.accountId }), null);
  await call(destination, { exec: ['DELETE FROM local_users WHERE account_id=?', other.accountId] });

  // Restored: the same accounts, names and password; the restored account's earlier sessions end, nobody else's.
  await call(destination, { session: { token: 'b'.repeat(64), accountId: local.accountId } });
  await call(destination, { session: { token: 'c'.repeat(64), accountId: other.accountId } });
  for (const entry of catalog.items) {
    assert.deepEqual(await call(destination, { path: 'profile', body: { profile: entry } }), { ok: true, written: 0 }, 'a dry run by default');
    assert.deepEqual(await call(destination, { path: 'profile', body: { profile: entry, dryRun: false } }), { ok: true, written: 1 });
  }
  assert.deepEqual(await call(destination, { profile: local.accountId }), local);
  assert.deepEqual(await call(destination, { profile: github.accountId }), github);
  assert.equal(await call(destination, { verify: { username: 'DOCTOR_01', password: 'correct horse' } }), true);
  assert.equal(await call(destination, { session: { token: 'b'.repeat(64) } }), null);
  assert.equal((await call(destination, { session: { token: 'c'.repeat(64) } })).accountId, other.accountId);
  assert.deepEqual((await call(destination, { exec: ['SELECT name_key, disc, account_id FROM display_names ORDER BY name_key'] })),
    [{ name_key: 'github 猫', disc: github.discriminator, account_id: github.accountId }, { name_key: 'other', disc: other.discriminator,
      account_id: other.accountId }, { name_key: '晴猫', disc: local.discriminator, account_id: local.accountId }]);
  // Restoring again changes nothing.
  for (const entry of catalog.items) assert.equal((await call(destination, { path: 'profile', body: { profile: entry, dryRun: false } })).written, 1);
  assert.deepEqual(await call(destination, { profile: local.accountId }), local);

  // Entries that are not an account are refused.
  for (const entry of [{ ...entries[local.accountId], password: { ...password, iterations: 100001 } }, { ...entries[local.accountId], name: 'other#0000' },
    { ...entries[local.accountId], nickname: 'a#b', name: 'a#b#' + local.discriminator }, { ...entries[github.accountId], githubId: undefined },
    { ...entries[github.accountId], avatarUrl: 'https://evil.example/a.png' }, { ...entries[local.accountId], username: 'no' }]) {
    assert.deepEqual(await call(destination, { path: 'profile', body: { profile: entry } }), { error: 'INVALID_PROFILE' });
  }
});
