import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers.ts';
import {importSql} from '../src/content.ts';
import {Store} from '../src/store.ts';
import {handleUpdate} from '../src/bot.ts';

const now=new Date('2026-10-06T10:00:00Z');
const cards=Array.from({length:24},(_,i)=>({id:`c-${String(i).padStart(2,'0')}`,subject:'Torts',subtopic:'Duty',question:'Test?',answer:'Test.',source:'Software fixture, not legal authority'}));
async function review(store:Store,user:string,n:number,time:Date,rating=3){
  const s=(await store.session(user))!;
  await store.attach(s.id,s.position,n);await store.reveal(user,s.id,s.position,n);
  assert.equal(await store.rate(user,s.id,s.position,n,rating,n,time),true);
  return s;
}

test('five-card goal ends at five; all ratings award equal XP, replay does not award twice',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql(cards));const store=new Store(d.db);
    const first=(await store.start('1',now,undefined,5))!;
    assert.equal(first.goal,5);
    for(let i=0;i<5;i++)await review(store,'1',100+i,now,i%4+1);
    assert.equal(await store.session('1'),null);
    assert.equal((await store.progress('1',now)).todayXp,50);
    assert.equal((await store.progress('2',now)).xp,0);
    assert.equal((await store.completed('1',first.id))?.earned,50);
    assert.equal(await store.completed('2',first.id),null);
    assert.equal(await store.rate('1',first.id,0,100,3,100,now),false);
    assert.equal((await store.progress('1',now)).xp,50);
  }finally{await d.close();}
});

test('XP caps at 20 distinct cards daily, repeated cards stay unrewarded, Singapore days and weeks are correct',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql(cards));const store=new Store(d.db);
    for(let i=0;i<24;i++){
      if(!await store.session('1'))await store.start('1',now);
      await review(store,'1',1000+i,now);
    }
    assert.equal((await store.progress('1',now)).todayXp,200);
    await d.db.exec('UPDATE card_progress SET due=0;');
    await store.start('1',now);await review(store,'1',2000,now,1);
    assert.equal((await store.progress('1',now)).xp,200);
    await store.stop('1');
    const next=new Date('2026-10-06T16:01:00Z');
    await store.start('1',next);await review(store,'1',2001,next,1);
    const p=await store.progress('1',next);
    assert.equal(p.todayXp,10);assert.equal(p.xp,210);assert.equal(p.days,2);
    assert.equal(p.weeklyGoal,4);
    await store.setWeeklyGoal('1',3);assert.equal((await store.progress('1',next)).weeklyGoal,3);
    await assert.rejects(()=>store.setWeeklyGoal('1',0));
    assert.equal((await store.progress('1',new Date('2026-10-11T16:00:00Z'))).days,0);
    assert.equal((await store.progress('1',new Date('2026-10-11T16:00:00Z'))).xp,210);
  }finally{await d.close();}
});

test('topic picker has owner-bound goal controls; completion summary, continue and progress work',async()=>{
  const d=await database();let messageId=40;const calls:{method:string;body:any}[]=[];
  const tg={async call(method:string,body:any){calls.push({method,body});return {message_id:++messageId};}};
  const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'test'};
  const msg=(id:number,text:string)=>({update_id:id,message:{message_id:id,from:{id:1},chat:{id:1,type:'private'},text}});
  const cb=(id:number,data:string,message:number)=>({update_id:id,callback_query:{id:String(id),from:{id:1},data,message:{message_id:message,chat:{id:1,type:'private'}}}});
  try{
    await d.db.exec(importSql(cards));const store=new Store(d.db);
    await handleUpdate(msg(1,'/study'),env,tg,now);
    const menu=await d.db.prepare('SELECT id,message_id FROM study_menus WHERE active=1').first<{id:string;message_id:number}>();
    assert.match(calls.at(-1)!.body.text,/goal: 5/i);
    assert.equal(await store.setMenuGoal('2',menu!.id,menu!.message_id,10),false);
    await handleUpdate(cb(2,`g:${menu!.id}:10`,999),env,tg,now);
    await handleUpdate(cb(3,`g:${menu!.id}:10`,menu!.message_id),env,tg,now);
    assert.match(calls.filter(c=>c.method==='editMessageText').at(-1)!.body.text,/goal: 10/i);
    await handleUpdate(cb(4,`g:${menu!.id}:5`,menu!.message_id),env,tg,now);
    await handleUpdate(cb(5,`n:${menu!.id}:0`,menu!.message_id),env,tg,now);
    const subMenu=await d.db.prepare('SELECT id,message_id FROM study_menus WHERE active=1').first<{id:string;message_id:number}>();
    const choices=await store.menuChoices('1',subMenu!.id,subMenu!.message_id);
    const dutyIndex=choices!.findIndex(c=>c.topic?.subtopic==='Duty');assert.ok(dutyIndex>=0);
    await handleUpdate(cb(6,`m:${subMenu!.id}:${dutyIndex}`,subMenu!.message_id),env,tg,now);
    const s=(await store.session('1'))!;assert.equal(s.goal,5);
    assert.equal(await store.setMenuGoal('1',menu!.id,menu!.message_id,10),false);
    assert.match(calls.at(-1)!.body.text,/Commute goal: 0\/5/);
    for(let i=0;i<4;i++)await review(store,'1',100+i,now);
    await store.attach(s.id,4,104);await store.reveal('1',s.id,4,104);
    await handleUpdate(cb(105,`r:${s.id}:4:1`,104),env,tg,now);
    const summary=calls.filter(c=>c.method==='sendMessage').at(-1)!;
    assert.match(summary.body.text,/goal complete: 5\/5/i);
    assert.match(summary.body.text,/\+50 XP/);
    assert.match(summary.body.text,/1\/4/);
    assert.ok(summary.body.reply_markup.inline_keyboard.flat().some((b:any)=>b.text==='Continue 5'));
    const endMenu=await d.db.prepare('SELECT id,message_id FROM study_menus WHERE active=1').first<{id:string;message_id:number}>();
    await handleUpdate(cb(106,`m:${endMenu!.id}:0`,endMenu!.message_id),env,tg,now);
    assert.equal((await store.session('1'))?.goal,5);
    assert.equal((await store.session('1'))?.subtopic,'Duty');
    await store.stop('1');
    await handleUpdate(msg(110,'/progress'),env,tg,now);assert.match(calls.at(-1)!.body.text,/50 XP/);
    await handleUpdate(msg(111,'/goal 3'),env,tg,now);assert.equal((await store.progress('1',now)).weeklyGoal,3);
    await handleUpdate(msg(112,'/goal 99'),env,tg,now);assert.equal((await store.progress('1',now)).weeklyGoal,3);
  }finally{await d.close();}
});

test('same-day repeat earns no extra XP but remains a valid FSRS review; stopping keeps partial rewards',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql([cards[0]]));const store=new Store(d.db);
    await store.start('1',now,undefined,5);await review(store,'1',3000,now,1);
    await d.db.exec('UPDATE card_progress SET due=0;');
    await store.start('1',now,undefined,5);await review(store,'1',3001,now,4);
    assert.equal((await store.progress('1',now)).xp,10);
    assert.equal(JSON.parse((await store.card(cards[0].id))!.state!).reps,2);
    assert.equal((await store.progress('1',now)).days,1);
    await d.db.exec(importSql([cards[1],cards[2]]));
    const s=(await store.start('1',now,undefined,5))!;await review(store,'1',3002,now,2);
    await store.stop('1');
    assert.equal((await store.completed('1',s.id))?.position,1);
    assert.equal((await store.progress('1',now)).xp,20);
    assert.equal((await store.card(cards[2].id))?.state,null);
  }finally{await d.close();}
});

test('starting a direct session invalidates old summary buttons',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql(cards));const store=new Store(d.db);
    const menu=await store.menu('1',[{text:'Finish',finish:true}]);await store.attachMenu(menu,42);
    const s=(await store.start('1',now))!;
    assert.equal(await store.choose('1',menu,0,42,now),'stale');
    assert.equal((await store.session('1'))?.id,s.id);
  }finally{await d.close();}
});
