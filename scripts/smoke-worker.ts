import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { importSql } from '../src/content.ts';
const script=await readFile('.wrangler/build/index.js','utf8');
const outbound:unknown[]=[];
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-06-01',d1Databases:['DB'],
  bindings:{OWNER_ID:'1',BOT_TOKEN:'0:FAKE_TEST_TOKEN',WEBHOOK_SECRET:'test-secret'},
  outboundService:async(request)=>{
    outbound.push(await request.json());
    return new Response(JSON.stringify({ok:true,result:{message_id:42}}),{headers:{'content-type':'application/json'}}) as any;
  },
}));
try {
  const db=await mf.getD1Database('DB');
  for(const f of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(`migrations/${f}`,'utf8'));
  await db.exec(importSql([{id:'smoke',subject:'Demo',subtopic:'Runtime',question:'Question?',answer:'Answer',source:'Runtime test'}]));
  const health=await mf.dispatchFetch('http://localhost/health');
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{ok:true});
  const rejected=await mf.dispatchFetch('http://localhost/webhook',{method:'POST',body:'{}'});
  assert.equal(rejected.status,403);
  const sent=await mf.dispatchFetch('http://localhost/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-secret'},body:JSON.stringify({update_id:1,message:{message_id:1,from:{id:1},chat:{id:1,type:'private'},text:'/study'}})});
  assert.equal(sent.status,200);
  let row:any;
  for(let i=0;i<40;i++){
    row=await db.prepare('SELECT status,failures FROM updates WHERE id=1').first();
    if(row?.status==='done'||row?.failures)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(row?.status,'done',`Outgoing Worker-runtime Telegram call failed: ${JSON.stringify(row)}`);
  assert.equal(outbound.length,1);
  const menu=await db.prepare('SELECT id FROM study_menus WHERE active=1').first<{id:string}>();
  await mf.dispatchFetch('http://localhost/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-secret'},body:JSON.stringify({update_id:4,callback_query:{id:'cb-4',from:{id:1},data:`n:${menu!.id}:0`,message:{message_id:42,chat:{id:1,type:'private'}}}})});
  for(let i=0;i<40;i++){
    row=await db.prepare('SELECT status,failures FROM updates WHERE id=4').first();
    if(row?.status==='done'||row?.failures)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(row?.status,'done');
  const child=await db.prepare('SELECT id,choices FROM study_menus WHERE active=1').first<{id:string;choices:string}>();
  const topicIndex=JSON.parse(child!.choices).findIndex((c:any)=>c.topic?.subtopic==='Runtime');assert.ok(topicIndex>=0);
  await mf.dispatchFetch('http://localhost/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-secret'},body:JSON.stringify({update_id:5,callback_query:{id:'cb-5',from:{id:1},data:`m:${child!.id}:${topicIndex}`,message:{message_id:42,chat:{id:1,type:'private'}}}})});
  for(let i=0;i<40;i++){
    row=await db.prepare('SELECT status,failures FROM updates WHERE id=5').first();
    if(row?.status==='done'||row?.failures)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(row?.status,'done');
  const session=await db.prepare('SELECT id FROM sessions WHERE active=1').first<{id:string}>();
  assert.ok(session);
  for(const [id,data] of [[2,`v:${session!.id}:0`],[3,`r:${session!.id}:0:3`]] as const){
    await mf.dispatchFetch('http://localhost/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-secret'},body:JSON.stringify({update_id:id,callback_query:{id:`cb-${id}`,from:{id:1},data,message:{message_id:42,chat:{id:1,type:'private'}}}})});
    for(let i=0;i<40;i++){
      row=await db.prepare('SELECT status,failures FROM updates WHERE id=?').bind(id).first();
      if(row?.status==='done'||row?.failures)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(row?.status,'done');
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM reviews').first<{n:number}>())!.n,1);
  assert.equal((await db.prepare('SELECT sum(xp) AS n FROM rewards').first<{n:number}>())!.n,10);
  assert.ok((outbound as {text?:string}[]).some(m=>m.text?.includes('+10 XP this session')));
  console.log('Compiled Worker smoke test: health, authentication, topic picker, question, reveal, FSRS rating and XP summary pass through runtime fetch. No cloud resources created.');
}finally{await mf.dispose();}
