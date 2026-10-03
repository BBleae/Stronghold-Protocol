import { authenticate, accountOf, json, requireOrigin } from './auth.js';
import { AccountError } from '../../shared/account-protocol.js';
import { validatePreferencePatch } from '../../public/js/preferenceSchema.js';

async function preferenceBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('INVALID_PREFERENCES');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new AccountError('BODY_TOO_LARGE', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AccountError('INVALID_PREFERENCES'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(k => !['accountId','patch','initialize'].includes(k))
    || (body.initialize !== undefined && typeof body.initialize !== 'boolean')) throw new AccountError('INVALID_PREFERENCES');
  validatePreferencePatch(body.patch);
  return body;
}
export async function clearStaleApplication(env,accountId) {
  const account=accountOf(env,accountId),pending=await account.getApplication();
  if(!pending)return;
  const response=await env.ROOMS.get(env.ROOMS.idFromName(pending.roomId)).fetch(new Request('https://room.internal/_applications',{headers:{'X-Account-ID':accountId}}));
  if(response.status===404){await account.clearApplication(pending.roomId,pending.id);return;}
  if(!response.ok)throw new Error('APPLICATION_UNAVAILABLE');
  const body=await response.json();
  if(!body.items.some(x=>x.id===pending.id && ['pending','approved'].includes(x.status)))await account.clearApplication(pending.roomId,pending.id);
}
export async function handleAccountRoutes(request, env) {
  const path = new URL(request.url).pathname;
  if (!['/api/me/active-match','/api/me/resume','/api/me/preferences'].includes(path)) return null;
  try {
    const preferences = path === '/api/me/preferences';
    if (preferences ? !['GET','POST'].includes(request.method) : request.method !== (path.endsWith('/resume') ? 'POST' : 'GET')) return json({error:'METHOD'},405);
    if (request.method === 'POST') requireOrigin(request);
    const session = await authenticate(request,env);
    if (!session || !env.ACCOUNTS) return json({error:'LOGIN_REQUIRED'},401);
    const account = accountOf(env,session.accountId);
    if (preferences) {
      if (request.method === 'GET') return json({accountId:session.accountId,preferences:await account.getPreferences()});
      const body = await preferenceBody(request);
      // A tab left open under another account must not write using its replacement session cookie.
      if (body.accountId !== session.accountId) return json({error:'ACCOUNT_CHANGED'},409);
      return json({accountId:session.accountId,preferences:await account.savePreferences(body.patch,body.initialize === true)});
    }
    const seat = await account.getActiveSeat();
    if (!seat) return json({activeSeat:null});
    const stub=env.ROOMS.get(env.ROOMS.idFromName(seat.roomId));
    const response=await stub.fetch(new Request('https://room.internal/_account' + (request.method==='POST'?'?resume=1':''), {
      method:request.method,headers:{'X-Account-ID':session.accountId,'X-Room-Generation':seat.roomGeneration}}));
    if (response.status===404) {
      await account.releaseSeat({claimId:seat.claimId}); return json({activeSeat:null});
    }
    return response;
  } catch(e) {return json({error:e.code || 'ACCOUNT_UNAVAILABLE'},e.status || 503);}
}
