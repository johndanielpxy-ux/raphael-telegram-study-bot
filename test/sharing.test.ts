import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers.ts';
import {Store} from '../src/store.ts';
import {handleUpdate,ingress,drain} from '../src/bot.ts';
import {importSql} from '../src/content.ts';
import type {TelegramTransport,Update} from '../src/types.ts';

const now=new Date('2026-10-06T10:00:00Z');
const card={id:'shared',subject:'Torts',subtopic:'Duty',question:'Recall?',answer:'Answer',source:'Non-law test fixture'};
const message=(id:number,text:string,user=1):Update=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:user,type:'private'},text}});
function transport(){
  const calls:{method:string;payload:any}[]=[];
  const tg:TelegramTransport={async call(method,payload){calls.push({method,payload});return {message_id:500+calls.length};}};
  return {tg,calls};
}

test('shared deck keeps scheduling, availability, XP and callback ownership separate',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql([card]));const store=new Store(d.db);
    const owner=(await store.start('1',now))!,friend=(await store.start('2',now))!;
    await store.attach(owner.id,0,10);await store.attach(friend.id,0,20);
    assert.equal(await store.reveal('2',owner.id,0,10),false);
    await store.reveal('1',owner.id,0,10);
    await store.rate('1',owner.id,0,10,4,1,now);
    assert.equal((await store.card('shared','2'))?.state,null);
    assert.equal((await store.counts(now,'2')).due,1);
    assert.equal((await store.counts(now,'1')).due,0);
    const saved=await store.card('shared','1');
    await store.reveal('2',friend.id,0,20);await store.rate('2',friend.id,0,20,1,2,now);
    assert.deepEqual(await store.card('shared','1'),saved);
    assert.equal((await store.progress('1',now)).xp,10);
    assert.equal((await store.progress('2',now)).xp,10);
    assert.notEqual((await store.card('shared','2'))?.due,saved?.due);
    assert.equal((await store.topics(now,'2'))[0].due,0);
    await d.db.exec(importSql([{...card,answer:'Updated answer'}]));
    assert.equal((await store.card('shared','2'))?.answer,'Updated answer');
    assert.equal((await store.card('shared','1'))?.due,saved?.due);
  }finally{await d.close();}
});

test('legacy owner schedules are never inherited by a fresh friend',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql([card]));
    await d.db.prepare('UPDATE cards SET state=?,due=?').bind('legacy-state',now.getTime()+86400000).run();
    const store=new Store(d.db,'9');
    assert.equal((await store.card(card.id,'9'))?.state,'legacy-state');
    assert.equal((await store.counts(now,'9')).due,0);
    assert.equal((await store.counts(now,'2')).due,1);
    assert.equal((await store.card(card.id,'2'))?.state,null);
    assert.ok(await store.start('2',now));
  }finally{await d.close();}
});

test('private /id grants no study access; only owner may approve one friend or revoke',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql([card]));
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'}, {tg,calls}=transport();
    await handleUpdate(message(10,'/id',2),env,tg,now);
    assert.match(calls.at(-1)!.payload.text,/Telegram ID: 2/);
    await handleUpdate(message(11,'/study mixed',2),env,tg,now);
    assert.equal(await new Store(d.db).session('2'),null);
    await handleUpdate(message(12,'/allow 2'),env,tg,now);
    assert.match(calls.at(-1)!.payload.text,/approved/i);
    await handleUpdate(message(13,'/study mixed',2),env,tg,now);
    assert.ok(await new Store(d.db).session('2'));
    await handleUpdate(message(14,'/allow 3',2),env,tg,now);
    await handleUpdate(message(15,'/study mixed',3),env,tg,now);
    assert.equal(await new Store(d.db).session('3'),null);
    await handleUpdate(message(16,'/allow 3'),env,tg,now);
    assert.match(calls.at(-1)!.payload.text,/revoke/i);
    await handleUpdate(message(17,'/revoke 2'),env,tg,now);
    assert.equal(await new Store(d.db).session('2'),null);
    const count=calls.length;
    await handleUpdate(message(18,'/study mixed',2),env,tg,now);
    assert.equal(calls.length,count);
    await handleUpdate(message(19,'/allow 0'),env,tg,now);
    assert.match(calls.at(-1)!.payload.text,/positive numeric/i);
  }finally{await d.close();}
});

test('webhook exposes only private self-ID to outsiders, and revoked queued study cannot execute',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql([card]));const {tg,calls}=transport();
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'},pending:Promise<unknown>[]=[];
    const ctx={waitUntil(p:Promise<unknown>){pending.push(p);}};
    const request=(u:Update)=>new Request('https://test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'secret'},body:JSON.stringify(u)});
    await ingress(request(message(20,'/id',2)),env,ctx,tg,now);await Promise.all(pending);
    assert.match(calls.at(-1)!.payload.text,/Telegram ID: 2/);
    assert.equal((await d.db.prepare('SELECT count(*) n FROM updates').first<{n:number}>())!.n,0);
    const forged=message(21,'/id',2);forged.message!.chat.id=1;
    const group=message(22,'/id',2);group.message!.chat.type='group';
    const count=calls.length;
    await ingress(request(forged),env,ctx,tg,now);await ingress(request(group),env,ctx,tg,now);
    assert.equal(calls.length,count);
    await handleUpdate(message(23,'/allow 2'),env,tg,now);
    await d.db.prepare('INSERT INTO updates(id,payload) VALUES(?,?)').bind(24,JSON.stringify(message(24,'/study mixed',2))).run();
    await handleUpdate(message(25,'/revoke 2'),env,tg,now);
    await drain(env,tg,now);
    assert.equal(await new Store(d.db).session('2'),null);
  }finally{await d.close();}
});
