import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers.ts';
import {Store} from '../src/store.ts';
import {handleUpdate} from '../src/bot.ts';
import {importSql} from '../src/content.ts';
import type {Update,TelegramTransport} from '../src/types.ts';

const now=new Date('2026-10-07T02:00:00Z');
const card={id:'repair-fixture',subject:'Demo',subtopic:'Synthetic',question:'Which fact changes this synthetic answer?',answer:'Synthetic answer, not legal advice.',source:'Synthetic fixture'};
const msg=(id:number,text:string,user=1):Update=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:user,type:'private'},text}});
const tap=(id:number,data:string,messageId:number,user=1):Update=>({update_id:id,callback_query:{id:String(id),from:{id:user},data,message:{message_id:messageId,chat:{id:user,type:'private'}}}});
function transport(){let mid=100;const calls:{method:string;body:any;mid:number}[]=[];const tg:TelegramTransport={async call(method,body){calls.push({method,body,mid:++mid});return{message_id:mid};}};return{tg,calls};}
const env=(db:D1Database)=>({DB:db,OWNER_ID:'1',BOT_TOKEN:'dummy',WEBHOOK_SECRET:'dummy'});
async function active(store:Store,user='1',mid=10){const s=(await store.start(user,now))!;await store.attach(s.id,0,mid);return s;}

test('/repair empty state and help explain a private, optional desk queue',async()=>{
 const d=await database();try{
  const {tg,calls}=transport();await handleUpdate(msg(1,'/repair'),env(d.db),tg,now);
  assert.match(calls.at(-1)!.body.text,/repair queue is empty/i);
  await handleUpdate(msg(2,'/start'),env(d.db),tg,now);assert.match(calls.at(-1)!.body.text,/\/repair/);
  await handleUpdate(msg(3,'/repair',3),env(d.db),tg,now);assert.equal(calls.length,2);
 }finally{await d.close();}
});

test('question and revealed answer expose save without advancing or awarding XP',async()=>{
 const d=await database();try{
  await d.db.exec(importSql([card]));const store=new Store(d.db),{tg,calls}=transport();
  await handleUpdate(msg(1,'/study mixed'),env(d.db),tg,now);
  const q=calls.at(-1)!,s=(await store.session('1'))!;
  const save=q.body.reply_markup.inline_keyboard.flat().find((b:any)=>b.text==='Practise This Later');assert.ok(save);
  await handleUpdate(tap(2,save.callback_data,q.mid),env(d.db),tg,now);
  assert.equal((await store.repairs('1')).length,1);assert.deepEqual(await store.session('1'),s);
  assert.equal((await store.progress('1',now)).xp,0);assert.equal((await store.card(card.id))!.state,null);
  await handleUpdate(tap(3,`v:${s.id}:0`,q.mid),env(d.db),tg,now);
  const rows=calls.at(-1)!.body.reply_markup.inline_keyboard;
  assert.deepEqual(rows[0].map((b:any)=>b.text),['Again','Hard','Good','Easy']);assert.ok(rows.flat().some((b:any)=>b.text==='Practise This Later'));
 }finally{await d.close();}
});

test('concurrent saves deduplicate; stale, foreign and wrong-message callbacks cannot save',async()=>{
 const d=await database();try{
  await d.db.exec(importSql([card]));const store=new Store(d.db);await store.allowFriend('2',now);const s=await active(store);
  const original=await store.card(card.id);
  assert.equal(await store.saveRepair('2',s.id,0,10,now),false);
  assert.equal(await store.saveRepair('1',s.id,1,10,now),false);assert.equal(await store.saveRepair('1',s.id,0,11,now),false);
  const results=await Promise.all(Array.from({length:20},()=>store.saveRepair('1',s.id,0,10,now)));assert.ok(results.every(Boolean));
  assert.equal((await store.repairs('1')).length,1);assert.equal((await store.repairs('2')).length,0);
  await store.stop('1');assert.equal(await store.saveRepair('1',s.id,0,10,now),false);
  assert.deepEqual(await store.card(card.id),original);
  assert.equal((await d.db.prepare('SELECT count(*) n FROM reviews').first<{n:number}>())!.n,0);
 }finally{await d.close();}
});

test('repair reveal and completion leave FSRS, session and XP intact; retry is idempotent',async()=>{
 const d=await database();try{
  await d.db.exec(importSql([card]));const store=new Store(d.db),s=await active(store);await store.saveRepair('1',s.id,0,10,now);
  const original=await store.session('1'),c=await store.card(card.id),{tg,calls}=transport();
  await handleUpdate(msg(20,'/repair'),env(d.db),tg,now);const q=calls.at(-1)!;
  assert.match(q.body.text,/Which fact changes/);assert.doesNotMatch(q.body.text,/Synthetic answer/);
  assert.match(q.body.text,/No need to do this now/);assert.match(q.body.text,/material fact/);
  const reveal=q.body.reply_markup.inline_keyboard.flat().find((b:any)=>b.text==='Show Reference Answer');assert.ok(reveal);
  const item=(await store.repairs('1'))[0];
  assert.equal(await store.finishRepair('1',item.id,q.mid,30,now),false);
  await handleUpdate(tap(21,reveal.callback_data,q.mid),env(d.db),tg,now);
  assert.ok(calls.some(c=>c.body.text?.includes(card.source)));
  const finish=calls.at(-1)!.body.reply_markup.inline_keyboard.flat().find((b:any)=>b.text==='Reviewed For Now');assert.ok(finish);
  await handleUpdate(tap(22,finish.callback_data,q.mid),env(d.db),tg,now);
  assert.equal((await store.repairs('1')).length,0);
  await handleUpdate(tap(22,finish.callback_data,q.mid),env(d.db),tg,now);
  assert.equal((await store.repairs('1')).length,0);assert.deepEqual(await store.card(card.id),c);
  assert.deepEqual(await store.session('1'),original);assert.equal((await store.progress('1',now)).xp,0);
 }finally{await d.close();}
});

test('repair views isolate users and invalidate older views; completed card can be requeued safely',async()=>{
 const d=await database();try{
  await d.db.exec(importSql([card]));const store=new Store(d.db);await store.allowFriend('2',now);
  const owner=await active(store),friend=await active(store,'2',11);
  await store.saveRepair('1',owner.id,0,10,now);await store.saveRepair('2',friend.id,0,11,now);
  const item=(await store.repairs('1'))[0];await store.attachRepair('1',item.id,50);await store.attachRepair('1',item.id,51);
  assert.equal(await store.revealRepair('1',item.id,50),false);assert.equal(await store.revealRepair('2',item.id,51),false);
  assert.equal(await store.revealRepair('1',item.id,51),true);
  assert.equal(await store.finishRepair('2',item.id,51,60,now),false);assert.equal(await store.finishRepair('1',item.id,51,60,now),true);
  assert.equal(await store.finishRepair('1',item.id,51,61,now),false);
  await store.saveRepair('1',owner.id,0,10,now);
  assert.equal((await store.repairs('1')).length,1);assert.equal((await store.repairs('2')).length,1);
  assert.equal(await store.finishRepair('1',item.id,51,60,now),false);
  assert.equal(await store.revealRepair('1',item.id,51),false);
 }finally{await d.close();}
});

test('repair queue handles long answers without oversize Telegram messages',async()=>{
 const d=await database();try{
  await d.db.exec(importSql([{...card,answer:'Long reference. '.repeat(900)}]));const store=new Store(d.db),s=await active(store),{tg,calls}=transport();
  await store.saveRepair('1',s.id,0,10,now);await handleUpdate(msg(1,'/repair'),env(d.db),tg,now);const q=calls.at(-1)!;
  await handleUpdate(tap(2,q.body.reply_markup.inline_keyboard[0][0].callback_data,q.mid),env(d.db),tg,now);
  for(const c of calls)if(c.body.text)assert.ok(c.body.text.length<=4096);
  assert.ok(calls.filter(c=>c.method==='sendMessage').length>2);
 }finally{await d.close();}
});

test('clear confirmation removes only the confirming user repair queue',async()=>{
 const d=await database();try{
  await d.db.exec(importSql([card]));const store=new Store(d.db);await store.allowFriend('2',now);
  const a=await active(store),b=await active(store,'2',11);await store.saveRepair('1',a.id,0,10,now);await store.saveRepair('2',b.id,0,11,now);
  const menu=await store.menu('1',[{text:'Reset',clear:true}]);await store.attachMenu(menu,90);
  assert.equal(await store.choose('1',menu,0,90,now),'cleared');assert.equal((await store.repairs('1')).length,0);assert.equal((await store.repairs('2')).length,1);
 }finally{await d.close();}
});
