import { authenticate, accountOf, json, requireOrigin } from './auth.js';
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
  if (!['/api/me/active-match','/api/me/resume'].includes(path)) return null;
  try {
    if (request.method !== (path.endsWith('/resume') ? 'POST' : 'GET')) return json({error:'METHOD'},405);
    if (request.method === 'POST') requireOrigin(request);
    const session = await authenticate(request,env);
    if (!session || !env.ACCOUNTS) return json({error:'LOGIN_REQUIRED'},401);
    const account = accountOf(env,session.accountId), seat = await account.getActiveSeat();
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
