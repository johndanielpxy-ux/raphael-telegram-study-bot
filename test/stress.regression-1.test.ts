import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers.ts';
import {Store} from '../src/store.ts';
import {drain,handleUpdate,ingress} from '../src/bot.ts';
import {importSql,type CardContent} from '../src/content.ts';
import worker from '../src/index.ts';
import type {TelegramTransport,Update,Env} from '../src/types.ts';

const now=new Date('2026-10-06T10:00:00Z');
const fixture={id:'stress',subject:'Demo',subtopic:'Synthetic',question:'Recall?',answer:'Answer',source:'Synthetic stress fixture'};
const message=(id:number,text:string,user=1):Update=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:user,type:'private'},text}});
const env=(DB:D1Database):Env=>({DB,OWNER_ID:'1',BOT_TOKEN:'dummy',WEBHOOK_SECRET:'dummy'});
function transport(){
  const calls:{method:string;body:Record<string,unknown>}[]=[];
  const tg:TelegramTransport={async call(method,body){calls.push({method,body});if(typeof body.text==='string')assert.ok(body.text.length<=4096);return{message_id:calls.length+100};}};
  return{tg,calls};
}

test('100 competing approvals cannot replace the sole friend or remove owner access',{timeout:120000},async()=>{
  const d=await database();try{
    const store=new Store(d.db);
    const results=await Promise.all(Array.from({length:100},(_,i)=>store.allowFriend(String(i+2),now)));
    assert.equal(results.filter(Boolean).length,1);
    assert.equal((await d.db.prepare('SELECT count(*) n FROM friend_access').first<{n:number}>())!.n,1);
    assert.equal(await store.revokeFriend('1'),false);assert.equal(await store.allowed('1'),true);
    for(const id of ['0','-2','2.5','1','9007199254740992','2 OR 1=1'])assert.equal(await store.allowFriend(id,now),false);
  }finally{await d.close();}
});

test('200 concurrent starts and 200 competing ratings preserve two independent single-review states',{timeout:120000},async()=>{
  const d=await database();try{
    await d.db.exec(importSql([fixture]));const store=new Store(d.db);
    const starts=await Promise.all(Array.from({length:200},(_,i)=>store.start(String(i%2+1),now)));
    for(const user of ['1','2'])assert.equal(new Set(starts.filter(s=>s?.user_id===user).map(s=>s!.id)).size,1);
    const a=(await store.session('1'))!,b=(await store.session('2'))!;
    await store.attach(a.id,0,10);await store.attach(b.id,0,20);
    await store.reveal('1',a.id,0,10);await store.reveal('2',b.id,0,20);
    const taps=await Promise.all(Array.from({length:200},(_,i)=>{
      const user=String(i%2+1),s=user==='1'?a:b;
      return store.rate(user,s.id,0,user==='1'?10:20,i%4+1,1000+i,now);
    }));
    assert.equal(taps.filter(Boolean).length,2);
    assert.equal((await d.db.prepare('SELECT count(*) n FROM reviews').first<{n:number}>())!.n,2);
    for(const user of ['1','2']){assert.equal((await store.progress(user,now)).xp,10);assert.equal(JSON.parse((await store.card(fixture.id,user))!.state!).reps,1);}
  }finally{await d.close();}
});

test('396 synthetic cards reveal and rate across 20 topics with bounded Telegram payloads',{timeout:120000},async()=>{
  // Exercise the original deck's size without distributing private course content.
  const cards:CardContent[]=Array.from({length:396},(_,i)=>({
    id:`synthetic-${i}`,subject:`Demo subject ${i%2}`,subtopic:`Topic ${i%20}`,
    question:`Synthetic retrieval question ${i}?`,answer:`Synthetic answer ${i}.`,
    source:'Generated software stress fixture, not course material',learning_order:i%3,
  }));
  const unique=[...new Map(cards.map(c=>[c.id,c])).values()];
  assert.equal(unique.length,396);
  const d=await database();try{
    await d.db.exec(importSql(unique));const store=new Store(d.db),{tg,calls}=transport(),e=env(d.db);
    let update=10000;
    while(true){
      const session=await store.start('1',now);if(!session)break;
      await handleUpdate(message(update++,'/study mixed'),e,tg,now);
      const s=(await store.session('1'))!;
      const cb=(data:string):Update=>({update_id:update++,callback_query:{id:String(update),from:{id:1},message:{message_id:s.message_id!,chat:{id:1,type:'private'}},data}});
      await handleUpdate(cb(`v:${s.id}:${s.position}`),e,tg,now);
      await handleUpdate(cb(`r:${s.id}:${s.position}:${s.position%4+1}`),e,tg,now);
    }
    assert.equal((await d.db.prepare('SELECT count(*) n FROM reviews').first<{n:number}>())!.n,396);
    assert.equal((await store.progress('1',now)).todayXp,200);
    assert.equal((await store.counts(now,'2')).due,396);
    assert.equal((await store.topics(now)).length,20);
    assert.ok(calls.length>1000);
  }finally{await d.close();}
});

// Regression: ISSUE-001 - accepted backlog and failed delivery lacked an idle recovery trigger.
// Regression retained from the private prototype's delivery audit.
test('idle scheduled recovery drains a burst without another Telegram message',{timeout:120000},async()=>{
  const d=await database();try{
    const e=env(d.db),{tg,calls}=transport();
    for(let i=0;i<25;i++)await d.db.prepare('INSERT INTO updates(id,payload) VALUES(?,?)').bind(i,JSON.stringify(message(i,'/progress'))).run();
    await drain(e,tg,now);
    assert.ok((await d.db.prepare("SELECT count(*) n FROM updates WHERE status='pending'").first<{n:number}>())!.n>0);
    assert.equal(typeof (worker as any).scheduled,'function');
    const fetchMock=mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
      calls.push({method:'scheduled-send',body:JSON.parse(String(init.body))});
      return Response.json({ok:true,result:{message_id:1000+calls.length}});
    });
    try{for(let i=0;i<5;i++){
      const tasks:Promise<unknown>[]=[];
      (worker as any).scheduled({},e,{waitUntil(p:Promise<unknown>){tasks.push(p);}});
      await Promise.all(tasks);
    }}finally{fetchMock.mock.restore();}
    assert.equal((await d.db.prepare("SELECT count(*) n FROM updates WHERE status='done'").first<{n:number}>())!.n,25);
    assert.equal(calls.length,25);
  }finally{await d.close();}
});

test('database failure never acknowledges an authorized event as successfully queued',{timeout:120000},async()=>{
  const {tg,calls}=transport();const broken={prepare(){throw new Error('injected storage outage');}} as unknown as D1Database;
  const response=await ingress(new Request('https://synthetic/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'dummy'},body:JSON.stringify(message(1,'/study'))}),env(broken),{waitUntil(){}},tg,now);
  assert.equal(response.status,503);assert.equal(calls.length,0);
});

test('held drain lease prevents delivery; expired lease and duplicate ingress recover exactly one event',{timeout:120000},async()=>{
  const d=await database();try{
    const e=env(d.db),{tg,calls}=transport(),tasks:Promise<unknown>[]=[];
    await d.db.prepare('UPDATE drain_lock SET token=?,expires=? WHERE id=1').bind('synthetic-lease',Date.now()+60000).run();
    const request=()=>new Request('https://synthetic/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'dummy'},body:JSON.stringify(message(900,'/progress'))});
    const results=await Promise.all(Array.from({length:50},()=>ingress(request(),e,{waitUntil(p){tasks.push(p);}},tg,now)));
    await Promise.all(tasks);assert.ok(results.every(r=>r.status===200));assert.equal(calls.length,0);
    assert.equal((await d.db.prepare('SELECT count(*) n FROM updates').first<{n:number}>())!.n,1);
    await d.db.prepare('UPDATE drain_lock SET expires=0 WHERE id=1').run();
    await Promise.all(Array.from({length:20},()=>drain(e,tg,now)));
    assert.equal(calls.length,1);
    assert.equal((await d.db.prepare('SELECT status FROM updates WHERE id=900').first<{status:string}>())!.status,'done');
  }finally{await d.close();}
});

test('idle retries stop poison events at three attempts then deliver later work; empty timer makes no writes',{timeout:120000},async()=>{
  const d=await database();try{
    const e=env(d.db),{tg,calls}=transport();
    for(let id=1;id<=2;id++)await d.db.prepare('INSERT INTO updates(id,payload) VALUES(?,?)').bind(id,JSON.stringify(message(id,'/progress'))).run();
    let attempts=0;
    for(let i=0;i<3;i++)await drain(e,{async call(){attempts++;throw new Error('injected transport outage');}},now);
    assert.equal(attempts,3);
    assert.equal((await d.db.prepare('SELECT status FROM updates WHERE id=1').first<{status:string}>())!.status,'failed');
    await drain(e,tg,now);assert.equal(calls.length,1);
    assert.equal((await d.db.prepare('SELECT status FROM updates WHERE id=2').first<{status:string}>())!.status,'done');
    const lease=await d.db.prepare('SELECT * FROM drain_lock').first();
    await drain(e,tg,now);assert.deepEqual(await d.db.prepare('SELECT * FROM drain_lock').first(),lease);
  }finally{await d.close();}
});

test('failure inside review transaction rolls back history, XP, scheduling and position; retry applies once',{timeout:120000},async()=>{
  const d=await database();try{
    await d.db.exec(importSql([fixture]));const store=new Store(d.db),s=(await store.start('1',now))!;
    await store.attach(s.id,0,77);await store.reveal('1',s.id,0,77);
    await d.db.prepare("CREATE TRIGGER injected_outage BEFORE INSERT ON card_progress BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END").run();
    await assert.rejects(store.rate('1',s.id,0,77,3,500,now));
    assert.equal((await store.session('1'))!.position,0);
    assert.equal((await store.card(fixture.id))!.state,null);
    assert.equal((await store.progress('1',now)).xp,0);
    assert.equal((await d.db.prepare('SELECT count(*) n FROM reviews').first<{n:number}>())!.n,0);
    await d.db.prepare('DROP TRIGGER injected_outage').run();
    assert.equal(await store.rate('1',s.id,0,77,3,500,now),true);
    assert.equal(await store.rate('1',s.id,0,77,3,500,now),false);
    assert.equal((await store.progress('1',now)).xp,10);
  }finally{await d.close();}
});

test('invalid webhook matrix and oversized bodies produce no queued or outbound effects',{timeout:120000},async()=>{
  const d=await database();try{
    const e=env(d.db),{tg,calls}=transport();
    const bodies=['null','[]','{}','not json',JSON.stringify({update_id:-1}),JSON.stringify({update_id:1,message:{message_id:1,chat:{id:1,type:'private'}}}),JSON.stringify(message(2,'/study',99)),JSON.stringify({...message(3,'/id'),message:{...message(3,'/id').message,chat:{id:-10,type:'group'}}})];
    for(const body of bodies){const r=await ingress(new Request('https://synthetic/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'dummy'},body}),e,{waitUntil(){throw new Error('must not enqueue');}},tg,now);assert.ok([200,400].includes(r.status));}
    const oversized=await ingress(new Request('https://synthetic/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'dummy'},body:'x'.repeat(65537)}),e,{waitUntil(){}},tg,now);
    assert.equal(oversized.status,413);
    assert.equal(calls.length,0);
    assert.equal((await d.db.prepare('SELECT count(*) n FROM updates').first<{n:number}>())!.n,0);
  }finally{await d.close();}
});
