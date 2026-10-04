import { hash,accountOf,directoryOf,json } from '../accounts/auth.js';
import { archiveOf } from '../archive/routes.js';
import { RULES_VERSION } from '../../shared/rules-version.js';
import { publishedRulesVersions } from '../match-versions.js';
import { AccountError,requireId } from '../../shared/account-protocol.js';
import {decodeReplayChunk,REPLAY_MAX_BYTES,REPLAY_CHUNK_BYTES} from '../../shared/replay-codec.js';
import { readJson } from '../http.js';

export async function sealBackup(facts,chunks) {
  const body={formatVersion:1,facts,chunks};return {...body,hash:await hash(JSON.stringify(body))};
}
// An archive can be imported when this deployment publishes the replay engine of its rules version.
export async function validateBackup(backup,versions=[RULES_VERSION,...publishedRulesVersions]) {
  if(backup?.formatVersion!==1 || !backup.facts || !Array.isArray(backup.chunks))throw new AccountError('INVALID_BACKUP');
  const {formatVersion,facts,chunks}=backup;
  requireId(facts.matchId);
  if(await hash(JSON.stringify({formatVersion,facts,chunks}))!==backup.hash)throw new AccountError('BACKUP_HASH');
  if(!versions.includes(facts.manifest?.rulesVersion))throw new AccountError('BACKUP_VERSION');
  if(!Array.isArray(facts.personal) || !Array.isArray(facts.participants) || !facts.participants.length ||
    facts.personal.length!==facts.participants.length || facts.personal.some(p=>!facts.participants.includes(p.accountId) || p.matchId!==facts.matchId))throw new AccountError('INVALID_BACKUP');
  if(!Array.isArray(facts.manifest.chunks) || chunks.length>10001 || chunks.length!==facts.manifest.chunks.length)throw new AccountError('BACKUP_INCOMPLETE');
  const compressed=facts.manifest.codec==='gzip-base64';let decoded=0;
  if(facts.manifest.codec && !compressed || compressed && (facts.manifest.schemaVersion!==2 || !Number.isSafeInteger(facts.manifest.decodedBytes) || facts.manifest.decodedBytes<1 || facts.manifest.decodedBytes>REPLAY_MAX_BYTES))throw new AccountError('INVALID_BACKUP');
  if(compressed && (facts.manifest.chunks.some(c=>!Number.isSafeInteger(c.rawBytes) || c.rawBytes<1 || c.rawBytes>REPLAY_CHUNK_BYTES) ||
    facts.manifest.chunks.reduce((n,c)=>n+c.rawBytes,0)!==facts.manifest.decodedBytes))throw new AccountError('BACKUP_INCOMPLETE');
  for(const [index,chunk] of chunks.entries()) {
    if(chunk.index!==index || typeof chunk.text!=='string' || chunk.text.length>64000 || chunk.hash!==await hash(chunk.text) || chunk.hash!==facts.manifest.chunks[index].hash)throw new AccountError('BACKUP_HASH');
    if(compressed)decoded+=(await decodeReplayChunk(chunk.text,facts.manifest.chunks[index].rawBytes)).length;
  }
  if(compressed && decoded!==facts.manifest.decodedBytes)throw new AccountError('BACKUP_INCOMPLETE');
  return {ok:true};
}
export async function handleBackupRoutes(request,env) {
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/admin/backup'))return null;
  const isWrite=request.method==='POST',secret=isWrite?env.ARCHIVE_IMPORT_TOKEN:env.ARCHIVE_EXPORT_TOKEN;
  const supplied=request.headers.get('Authorization')?.replace(/^Bearer /,'');
  // A player session is deliberately irrelevant to administrator authorization.
  if(!secret || secret.length<32 || !supplied || await hash(supplied)!==await hash(secret))return json({error:'FORBIDDEN'},403);
  const directory=directoryOf(env);
  if(request.method==='GET' && url.pathname==='/api/admin/backup/catalog')return json(await directory.backupCatalog({kind:url.searchParams.get('kind') || 'profiles',cursor:url.searchParams.get('cursor') || ''}));
  if(request.method==='GET' && url.pathname==='/api/admin/backup/archive') {
    const id=requireId(url.searchParams.get('id'));
    const archive=await archiveOf(env,id).exportArchive();return json(await sealBackup(archive.facts,archive.chunks));
  }
  if(!isWrite)return json({error:'METHOD'},405);
  const input=await readJson(request,32*1024*1024,'INVALID_BACKUP'),dryRun=input.dryRun!==false;
  if(url.pathname==='/api/admin/backup/profile') {
    const p=input.profile;
    if(!p || !/^[0-9]{1,20}$/.test(p.githubId) || typeof p.name!=='string' || p.name.length>80)throw new AccountError('INVALID_PROFILE');
    requireId(p.accountId);
    const profile={accountId:p.accountId,githubId:p.githubId,name:p.name,avatarUrl:typeof p.avatarUrl==='string' && /^https:\/\/avatars\.githubusercontent\.com\//.test(p.avatarUrl)?p.avatarUrl:null};
    await directory.restoreProfile(profile,dryRun);
    if(!dryRun){await directory.revokeAllSessions();await accountOf(env,p.accountId).setProfile(profile);}
    return json({ok:true,written:dryRun?0:1});
  }
  if(url.pathname!=='/api/admin/backup/archive')return json({error:'NOT_FOUND'},404);
  await validateBackup(input.backup);
  const {facts,chunks}=input.backup,archive=archiveOf(env,facts.matchId);
  await archive.checkImport(facts,chunks);
  for(const p of facts.personal) {
    const profile=await accountOf(env,p.accountId).getProfile();
    if(!dryRun && !profile)throw new AccountError('RESTORE_PROFILES_FIRST');
  }
  if(!dryRun) {
    for(const chunk of chunks)await archive.appendChunk({index:chunk.index,text:chunk.text});
    await archive.finalize(facts);await directory.registerArchive(facts.matchId);
    for(const p of facts.personal)await accountOf(env,p.accountId).applyMatch(p);
  }
  return json({ok:true,written:dryRun?0:1});
}
