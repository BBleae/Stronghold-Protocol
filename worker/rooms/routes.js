import { authenticate, accountOf, directoryOf, json, requireOrigin } from '../accounts/auth.js';
import { AccountError } from '../../shared/account-protocol.js';
import { clearStaleApplication,handleAccountRoutes } from '../accounts/routes.js';
export async function handleLobbyRoutes(request,env) {
  const url=new URL(request.url);
  if(url.pathname==='/api/rooms' && request.method==='GET') {
    if(!env.SITES) return json({items:[],nextCursor:null});
    try {return json(await directoryOf(env).listRooms({cursor:url.searchParams.get('cursor') || '',limit:Number(url.searchParams.get('limit') || 20)}));}
    catch(e) {return json({error:e.code || 'LOBBY_UNAVAILABLE'},e.status || 503);}
  }
  const match=/^\/api\/rooms\/([A-Z]{4})\/(applications|visibility)$/.exec(url.pathname);
  if(!match) return null;
  try {
    if(!['GET','POST'].includes(request.method)) return json({error:'METHOD'},405);
    if(request.method==='POST') requireOrigin(request);
    const session=await authenticate(request,env);
    if(!session || !env.ACCOUNTS) return json({error:'LOGIN_REQUIRED'},401);
    const body=request.method==='POST' ? await request.text() : null;
    if(body && body.length>2048) return json({error:'BAD_MSG'},413);
    if(body && JSON.parse(body).action==='apply') {
      const validated=await handleAccountRoutes(new Request(new URL('/api/me/active-match',request.url),{headers:request.headers}),env);
      if(!validated.ok)return validated;
      if((await validated.json()).activeSeat)return json({error:'ALREADY_SEATED'},409);
      await clearStaleApplication(env,session.accountId);
    }
    const response=await env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(new Request('https://room.internal/_'+match[2], {
      method:request.method,headers:{'X-Account-ID':session.accountId,'Content-Type':'application/json'},body}));
    return response;
  } catch(e) {return json({error:e.code || 'LOBBY_UNAVAILABLE'},e.status || 503);}
}
export async function roomApplications(rt,request,env) {
  const accountId=request.headers.get('X-Account-ID'), room=rt.lobby.getRoom(rt.code);
  if(!room || room.mode!=='coop') return json({error:'ROOM_NOT_FOUND'},404);
  const host=rt.registry.byId(room.hostId)?.accountId, queue=rt.applications;
  const account=accountOf(env,accountId);
  const path=new URL(request.url).pathname;
  try {
    if(path==='/_visibility') {
      if(accountId!==host) throw new AccountError('NOT_HOST',403);
      if(request.method==='POST') {
        const body=await request.json();
        if(typeof body.public!=='boolean') throw new AccountError('BAD_MSG');
        rt.publicRoom=body.public;if(!body.public) queue.invalidate();
      }
      return json({public:rt.publicRoom});
    }
    if(request.method==='GET') {
      const items=queue.list(accountId===host?null:accountId).map(item=>{
        const value={...item};if(item.accountId!==accountId) delete value.ticket;return value;
      });
      return json({items,host:accountId===host,public:rt.publicRoom});
    }
    const body=await request.json();
    if(body.action==='apply') {
      if(room.match) throw new AccountError('ROOM_STARTED',409);
      if(room.seats.filter(x=>!x).length<=queue.reservedCount()) throw new AccountError('ROOM_FULL',409);
      const claimed=await account.claimApplication({roomId:rt.code,expiresAt:Date.now()+120000});
      if(!claimed.ok) throw new AccountError(claimed.error,409);
      const profile=await account.getProfile();
      try {
        const item=queue.apply({accountId,name:profile?.name});
        await account.claimApplication({roomId:rt.code,id:item.id,expiresAt:item.expiresAt});
        return json(item,201);
      }
      catch(e) {await account.clearApplication(rt.code);throw e;}
    }
    if(body.action==='cancel') {
      const item=queue.cancel(accountId,body.id);
      await account.releaseSeat({claimId:item.id});await account.clearApplication(rt.code);
      return json(item);
    }
    if(body.action!=='approve' && body.action!=='reject') throw new AccountError('BAD_MSG');
    if(accountId!==host) throw new AccountError('NOT_HOST',403);
    const item=queue.list().find(x=>x.id===body.id);
    if(!item || item.status!=='pending') throw new AccountError('APPLICATION_EXPIRED',409);
    const applicant=accountOf(env,item.accountId);
    if(body.action==='approve') {
      const claim=await applicant.claimSeat({claimId:item.id,expiresAt:Date.now()+30000,
        seat:{roomId:rt.code,roomGeneration:rt.generation,matchId:null,seatId:null}});
      if(!claim.ok) throw new AccountError(claim.error,409);
      try {
        const approved=queue.decide(accountId,item.id,'approved',{hostId:host,inMatch:!!room.match,freeSeats:room.seats.filter(x=>!x).length});
        await applicant.clearApplication(rt.code);return json(approved);
      } catch(e) {await applicant.releaseSeat({claimId:item.id});throw e;}
    }
    const rejected=queue.decide(accountId,item.id,'rejected',{hostId:host,inMatch:!!room.match});
    await applicant.clearApplication(rt.code);return json(rejected);
  } catch(e) {return json({error:e.code || 'APPLICATION_FAILED'},e.status || 503);}
}
