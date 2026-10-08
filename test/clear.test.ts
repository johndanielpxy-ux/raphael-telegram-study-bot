import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers.ts';
import {Store} from '../src/store.ts';
import {handleUpdate} from '../src/bot.ts';
import {importSql} from '../src/content.ts';
import type {Update,TelegramTransport} from '../src/types.ts';

const now=new Date('2026-10-06T10:00:00Z');
const card={id:'clear-fixture',subject:'Demo',subtopic:'Synthetic',question:'Q?',answer:'A',source:'Synthetic test'};
const message=(id:number,text:string,user=1):Update=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:user,type:'private'},text}});
function transport(){const calls:{method:string;body:any}[]=[];const tg:TelegramTransport={async call(method,body){calls.push({method,body});return{message_id:100+calls.length};}};return{tg,calls};}
function tap(id:number,data:string,messageId:number,user=1):Update{return{update_id:id,callback_query:{id:String(id),from:{id:user},message:{message_id:messageId,chat:{id:user,type:'private'}},data}};}
async function learned(store:Store,user:string,id:number){const s=(await store.start(user,now))!;await store.attach(s.id,0,id);await store.reveal(user,s.id,0,id);await store.rate(user,s.id,0,id,3,id,now);}

test('/clear requires confirmation, resets only owner including legacy state, preserves cards and friend',{timeout:30000},async()=>{
 const d=await database();try{
  await d.db.exec(importSql([card]));const store=new Store(d.db);await store.allowFriend('2',now);
  await learned(store,'1',1);await learned(store,'2',2);
  await d.db.prepare('UPDATE cards SET state=?,due=?').bind('legacy',now.getTime()+86400000).run();
  const friend=await store.card(card.id,'2'),e={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'dummy',WEBHOOK_SECRET:'dummy'}, {tg,calls}=transport();
  await handleUpdate(message(10,'/clear'),e,tg,now);
  assert.equal((await store.progress('1',now)).xp,10);
  const sent=calls.at(-1)!;assert.match(sent.body.text,/reset/i);
  const data=sent.body.reply_markup.inline_keyboard[0][0].callback_data;
  await handleUpdate(tap(11,data,100+calls.length),e,tg,now);
  assert.equal((await store.progress('1',now)).xp,0);assert.equal((await store.card(card.id))!.state,null);
  assert.equal((await store.counts(now)).due,1);assert.deepEqual(await store.card(card.id,'2'),friend);
  assert.equal((await store.progress('2',now)).xp,10);assert.equal(await store.friend(),'2');
  assert.equal((await d.db.prepare('SELECT count(*) n FROM reviews').first<{n:number}>())!.n,1);
  assert.equal((await store.counts(now)).total,1);
 }finally{await d.close();}
});

test('friend clear cannot reset owner; foreign confirmation and cancel have no destructive effect',{timeout:30000},async()=>{
 const d=await database();try{
  await d.db.exec(importSql([card]));const store=new Store(d.db);await store.allowFriend('2',now);await learned(store,'1',1);await learned(store,'2',2);
  const e={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'dummy',WEBHOOK_SECRET:'dummy'}, {tg,calls}=transport();
  await handleUpdate(message(10,'/clear',2),e,tg,now);const sent=calls.at(-1)!,mid=100+calls.length;
  const buttons=sent.body.reply_markup.inline_keyboard[0];
  await handleUpdate(tap(11,buttons[0].callback_data,mid,1),e,tg,now);
  assert.equal((await store.progress('1',now)).xp,10);assert.equal((await store.progress('2',now)).xp,10);
  await handleUpdate(tap(12,buttons[1].callback_data,mid,2),e,tg,now);
  await handleUpdate(tap(13,buttons[0].callback_data,mid,2),e,tg,now);
  assert.equal((await store.progress('2',now)).xp,10);
  await handleUpdate(message(14,'/clear',2),e,tg,now);const next=calls.at(-1)!;
  await handleUpdate(tap(15,next.body.reply_markup.inline_keyboard[0][0].callback_data,100+calls.length,2),e,tg,now);
  assert.equal((await store.progress('2',now)).xp,0);assert.equal((await store.progress('1',now)).xp,10);
 }finally{await d.close();}
});

test('clear confirmation replay after new study cannot wipe new progress',{timeout:30000},async()=>{
 const d=await database();try{
  await d.db.exec(importSql([card]));const store=new Store(d.db),e={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'dummy',WEBHOOK_SECRET:'dummy'}, {tg,calls}=transport();
  await handleUpdate(message(10,'/clear'),e,tg,now);const sent=calls.at(-1)!,mid=100+calls.length,data=sent.body.reply_markup.inline_keyboard[0][0].callback_data;
  await handleUpdate(tap(11,data,mid),e,tg,now);await learned(store,'1',500);
  await handleUpdate(tap(12,data,mid),e,tg,now);assert.equal((await store.progress('1',now)).xp,10);
 }finally{await d.close();}
});

test('reset transaction failure preserves history and XP; concurrent confirmation retries apply one reset',{timeout:30000},async()=>{
 const d=await database();try{
  await d.db.exec(importSql([card]));const store=new Store(d.db);await learned(store,'1',1);
  const id=await store.menu('1',[{text:'Reset',clear:true},{text:'Cancel',cancel:true}]);await store.attachMenu(id,77);
  await d.db.prepare("CREATE TRIGGER clear_outage BEFORE UPDATE ON card_progress BEGIN SELECT RAISE(ABORT,'synthetic reset failure'); END").run();
  await assert.rejects(store.choose('1',id,0,77,now));
  assert.equal((await store.progress('1',now)).xp,10);assert.ok((await store.card(card.id))!.state);
  assert.equal((await d.db.prepare('SELECT count(*) n FROM reviews').first<{n:number}>())!.n,1);
  await d.db.prepare('DROP TRIGGER clear_outage').run();
  const results=await Promise.all(Array.from({length:50},()=>store.choose('1',id,0,77,now)));
  assert.ok(results.every(r=>r==='cleared'));assert.equal((await store.progress('1',now)).xp,0);
  assert.equal((await store.card(card.id))!.state,null);assert.equal(await store.session('1'),null);
  await learned(store,'1',500);assert.equal(await store.choose('1',id,0,77,now),'stale');
  assert.equal((await store.progress('1',now)).xp,10);
 }finally{await d.close();}
});
