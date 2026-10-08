import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers.ts';
import {importSql} from '../src/content.ts';
import {Store} from '../src/store.ts';
import {handleUpdate} from '../src/bot.ts';
const now=new Date('2026-10-06T10:00:00Z');
const base={subject:'Torts',subtopic:'Duty',question:'Question?',answer:'Answer',source:'Test fixture'};
test('module menus contain subject-only mixed review and gauntlet, not a global mixed choice',async()=>{
 const d=await database();let mid=100;const calls:any[]=[];
 const tg={async call(method:string,body:any){calls.push({method,body});return {message_id:++mid};}};
 const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'test'};
 try{
  await d.db.exec(importSql([{...base,id:'t1'},{...base,id:'t2',subtopic:'Breach'},{...base,id:'c1',subject:'Contracts'}]));
  await handleUpdate({update_id:1,message:{message_id:1,from:{id:1},chat:{id:1,type:'private'},text:'/study'}},env,tg,now);
  let buttons=calls.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.ok(!buttons.some((b:any)=>b.text.includes('Mixed Review')));
  const pick=buttons.find((b:any)=>b.text.startsWith('Torts'));
  await handleUpdate({update_id:2,callback_query:{id:'pick',from:{id:1},data:pick.callback_data,message:{message_id:101,chat:{id:1,type:'private'}}}},env,tg,now);
  buttons=calls.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b:any)=>b.text.startsWith('Mixed Review')));
  assert.ok(buttons.some((b:any)=>b.text.includes('Endless Gauntlet')));
  const menu=await d.db.prepare('SELECT choices FROM study_menus WHERE active=1').first<{choices:string}>();
  const choices=JSON.parse(menu!.choices),mixed=choices.find((c:any)=>c.text.startsWith('Mixed Review'));
  assert.deepEqual(mixed.topic,{subject:'Torts',subtopic:''});
 }finally{await d.close();}
});
test('subject-only mixed review spans subtopics but excludes other modules and future cards',async()=>{
 const d=await database(),store=new Store(d.db);
 try{
  await d.db.exec(importSql([{...base,id:'a',subject:'Contracts'},{...base,id:'b'},{...base,id:'c',subtopic:'Breach'},{...base,id:'d'}]));
  await d.db.prepare("UPDATE cards SET due=? WHERE id='d'").bind(now.getTime()+86400000).run();
  const menu=await store.menu('1',[{text:'Mixed Review',topic:{subject:'Torts',subtopic:''},goal:5}]);await store.attachMenu(menu,1);
  assert.equal(await store.choose('1',menu,0,1,now),'ok');
  for(const id of ['b','c']){
   const s=(await store.session('1'))!;assert.equal(s.card_id,id);await store.attach(s.id,s.position,2);await store.reveal('1',s.id,s.position,2);await store.rate('1',s.id,s.position,2,3,100+s.position,now);
  }
  assert.equal(await store.session('1'),null);
 }finally{await d.close();}
});
test('gauntlet cycles all module cards beyond ten without rescheduling, replay XP, or cross-user effects',async()=>{
 const d=await database(),store=new Store(d.db);
 try{
  await d.db.exec(importSql([{...base,id:'a',subject:'Contracts'},{...base,id:'b'},{...base,id:'c',subtopic:'Breach'}]));
  await d.db.prepare("UPDATE cards SET due=? WHERE id='c'").bind(now.getTime()+86400000).run();
  const menu=await store.menu('1',[{text:'Endless Gauntlet',topic:{subject:'Torts',subtopic:''},endless:true}]);await store.attachMenu(menu,1);
  assert.equal(await store.choose('2',menu,0,1,now),'stale');
  assert.equal(await store.choose('1',menu,0,1,now),'ok');
  await d.db.prepare("INSERT INTO card_progress(user_id,card_id,state,due) VALUES('1','c','saved-owner-state',?),('2','b','saved-friend-state',?)").bind(now.getTime()+86400000,now.getTime()+86400000).run();
  const original=(await d.db.prepare('SELECT id,state,due FROM cards ORDER BY id').all()).results;
  const progress=(await d.db.prepare('SELECT * FROM card_progress ORDER BY user_id,card_id').all()).results;
  for(let i=0;i<25;i++){
   const s=(await store.session('1'))!;assert.ok(s);assert.equal(s.position,i);assert.equal(s.card_id,i%2===0?'b':'c');
   await store.attach(s.id,i,2+i);await store.reveal('1',s.id,i,2+i);
   const results=await Promise.all([store.rate('1',s.id,i,2+i,3,1000+i*2,now),store.rate('1',s.id,i,2+i,3,1001+i*2,now)]);
   assert.equal(results.filter(Boolean).length,1);
  }
  assert.equal((await store.session('1'))?.position,25);
  assert.deepEqual((await d.db.prepare('SELECT id,state,due FROM cards ORDER BY id').all()).results,original);
  assert.deepEqual((await d.db.prepare('SELECT * FROM card_progress ORDER BY user_id,card_id').all()).results,progress);
  assert.equal((await store.progress('1',now)).todayXp,20);
  assert.equal((await store.progress('2',now)).xp,0);
  assert.equal((await d.db.prepare('SELECT count(*) n FROM reviews WHERE practice=1').first<{n:number}>())!.n,25);
  await store.stop('1');assert.equal(await store.session('1'),null);
 }finally{await d.close();}
});
test('gauntlet renders and resumes as practice; stop invalidates its buttons',async()=>{
 const d=await database(),store=new Store(d.db);let mid=100;const calls:any[]=[];
 const tg={async call(method:string,body:any){calls.push({method,body});return {message_id:++mid};}};
 const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'test'};
 const cb=(id:number,data:string,message:number)=>({update_id:id,callback_query:{id:String(id),from:{id:1},data,message:{message_id:message,chat:{id:1,type:'private'}}}});
 try{
  await d.db.exec(importSql([{...base,id:'one'}]));
  await d.db.prepare('UPDATE cards SET due=?').bind(now.getTime()+86400000).run();
  const menu=await store.menu('1',[{text:'Endless Gauntlet',topic:{subject:'Torts',subtopic:''},endless:true}]);await store.attachMenu(menu,1);
  await handleUpdate(cb(1,`m:${menu}:0`,1),env,tg,now);
  assert.match(calls.at(-1).body.text,/Endless Gauntlet/);assert.match(calls.at(-1).body.text,/schedule unchanged/);
  assert.doesNotMatch(calls.at(-1).body.text,/of up to/);
  let s=(await store.session('1'))!;
  await handleUpdate(cb(2,`v:${s.id}:0`,s.message_id!),env,tg,now);
  assert.match(calls.at(-1).body.text,/Source: Test fixture/);
  await handleUpdate(cb(3,`r:${s.id}:0:1`,s.message_id!),env,tg,now);
  s=(await store.session('1'))!;assert.equal(s.position,1);assert.equal(s.card_id,'one');
  await handleUpdate({update_id:4,message:{message_id:4,from:{id:1},chat:{id:1,type:'private'},text:'/study mixed'}},env,tg,now);
  assert.equal((await store.session('1'))!.id,s.id);assert.match(calls.at(-1).body.text,/Card 2/);
  await handleUpdate({update_id:5,message:{message_id:5,from:{id:1},chat:{id:1,type:'private'},text:'/stop'}},env,tg,now);
  await handleUpdate(cb(6,`v:${s.id}:1`,s.message_id!),env,tg,now);
  assert.equal(await store.session('1'),null);assert.equal((await store.progress('1',now)).xp,10);
 }finally{await d.close();}
});
test('legacy global mixed menus and direct commands cannot create a cross-module session',async()=>{
 const d=await database(),store=new Store(d.db);
 try{
  await d.db.exec(importSql([{...base,id:'t'},{...base,id:'c',subject:'Contracts'}]));
  const menu=await store.menu('1',[{text:'Mixed Review',goal:5}]);await store.attachMenu(menu,1);
  assert.equal(await store.choose('1',menu,0,1,now),'stale');
  await handleUpdate({update_id:1,message:{message_id:1,from:{id:1},chat:{id:1,type:'private'},text:'/study mixed'}},{DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'test'},{async call(){return {message_id:2};}},now);
  assert.equal(await store.session('1'),null);
 }finally{await d.close();}
});
