import { ingress, drain } from './bot.ts';
import type { Env, Background } from './types.ts';
export default {
  scheduled(_controller:ScheduledController,env:Env,ctx:Background):void {
    ctx.waitUntil(drain(env));
  },
  async fetch(request:Request,env:Env,ctx:Background):Promise<Response> {
    const path=new URL(request.url).pathname;
    if (request.method==='GET' && path==='/health') return Response.json({ok:true});
    if (request.method!=='POST' || path!=='/webhook') return new Response('Not found',{status:404});
    try { return await ingress(request,env,ctx); }
    catch { return new Response('Temporarily unavailable',{status:503}); }
  },
};
