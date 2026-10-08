import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.ts';
import { importSql } from '../src/content.ts';
import { handleUpdate, ingress, drain } from '../src/bot.ts';
import { Store } from '../src/store.ts';

const clock = new Date('2026-10-06T10:00:00Z');
const message = (id: number, text: string, user=1, type='private') => ({ update_id:id, message:{ message_id:id,from:{id:user},chat:{id:user,type},text } });
const callback = (id:number,data:string,msg:number) => ({update_id:id,callback_query:{id:`cb-${id}`,from:{id:1},data,message:{message_id:msg,chat:{id:1,type:'private'}}}});
const demo = { id:'demo',subject:'Demo',subtopic:'Math',question:'2 + 2?',answer:'4',source:'Non-law test' };
function transport() {
  let id=40;
  const calls: {method:string;body:any}[]=[];
  return {calls, async call(method:string,body:any) { calls.push({method,body}); return {message_id:++id}; }};
}

test('/study offers topics; selections bind to owner/message, switch safely and cannot replay',async()=>{
  const d=await database(),tg=transport();
  try{
    await d.db.exec(importSql([{...demo,id:'a',subtopic:'Duty'},{...demo,id:'b',subtopic:'Breach'}]));
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
    await handleUpdate(message(90,'/study'),env,tg,clock);
    const menu=tg.calls.at(-1)!;
    assert.match(menu.body.text,/Choose/);
    let rows=menu.body.reply_markup.inline_keyboard.flat();
    assert.ok(!rows.some((b:any)=>b.text.includes('Mixed Review')));
    assert.ok(!rows.some((b:any)=>b.text.includes('Duty')));
    const subject=rows.find((b:any)=>b.text.startsWith('Demo'));
    await handleUpdate(callback(89,subject.callback_data,41),env,tg,clock);
    rows=tg.calls.at(-1)!.body.reply_markup.inline_keyboard.flat();
    const duty=rows.find((b:any)=>b.text.includes('Duty'));
    assert.match(duty.text,/1/);
    assert.ok(rows.every((b:any)=>Buffer.byteLength(b.callback_data)<=64));
    await handleUpdate(callback(91,duty.callback_data,999),env,tg,clock);
    assert.equal(await new Store(d.db).session('1'),null);
    await handleUpdate(callback(92,duty.callback_data,41),env,tg,clock);
    const s=(await new Store(d.db).session('1'))!;
    assert.equal(s.card_id,'a');
    await handleUpdate(message(93,'/study'),env,tg,clock);
    const second=tg.calls.at(-1)!.body.reply_markup.inline_keyboard.flat();
    assert.ok(second.some((b:any)=>b.text==='Resume Session'));
    const resume=second.find((b:any)=>b.text==='Resume Session');
    const resumeMenu=await d.db.prepare('SELECT message_id FROM study_menus WHERE active=1').first<{message_id:number}>();
    await handleUpdate(callback(97,resume.callback_data,resumeMenu!.message_id),env,tg,clock);
    assert.equal((await new Store(d.db).session('1'))?.id,s.id);
    await handleUpdate(callback(98,resume.callback_data,resumeMenu!.message_id),env,tg,clock);
    assert.equal((await new Store(d.db).session('1'))?.id,s.id);
    await handleUpdate(message(99,'/study'),env,tg,clock);
    const switchRows=tg.calls.at(-1)!.body.reply_markup.inline_keyboard.flat();
    // Use the transport's actual returned sequence, including acknowledgements.
    const menuRow=await d.db.prepare('SELECT message_id FROM study_menus WHERE active=1').first<{message_id:number}>();
    await handleUpdate(callback(100,switchRows.find((b:any)=>b.text.startsWith('Demo')).callback_data,menuRow!.message_id),env,tg,clock);
    const breach=tg.calls.at(-1)!.body.reply_markup.inline_keyboard.flat().find((b:any)=>b.text.includes('Breach'));
    await handleUpdate(callback(94,breach.callback_data,menuRow!.message_id),env,tg,clock);
    assert.equal((await new Store(d.db).session('1'))?.card_id,'b');
    await handleUpdate(callback(95,duty.callback_data,41),env,tg,clock);
    assert.equal((await new Store(d.db).session('1'))?.card_id,'b');
    assert.equal((await new Store(d.db).card('a'))?.state,null);
    await new Store(d.db).stop('1');
    await handleUpdate(callback(96,breach.callback_data,menuRow!.message_id),env,tg,clock);
    assert.equal(await new Store(d.db).session('1'),null);
  }finally{await d.close();}
});

test('subject navigation isolates topics, preserves goals and sessions, and rejects stale or forged taps',async()=>{
  const d=await database(),tg=transport();
  try{
    await d.db.exec(importSql([{...demo,id:'t',subject:'Torts',subtopic:'Duty'},{...demo,id:'c',subject:'Contracts',subtopic:'Offer'}]));
    const store=new Store(d.db),env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
    const current=await store.start('1',clock);
    await handleUpdate(message(200,'/study'),env,tg,clock);
    let rows=tg.calls.at(-1)!.body.reply_markup.inline_keyboard.flat();
    const root=(await d.db.prepare('SELECT id,message_id FROM study_menus WHERE active=1').first<{id:string;message_id:number}>())!;
    assert.ok(rows.some((b:any)=>b.text.startsWith('Torts')));
    assert.ok(rows.some((b:any)=>b.text.startsWith('Contracts')));
    assert.ok(!rows.some((b:any)=>b.text.includes('Offer')||b.text.includes('Duty')));
    await handleUpdate(callback(201,rows.find((b:any)=>b.text==='10 cards').callback_data,root.message_id),env,tg,clock);
    const pick=rows.find((b:any)=>b.text.startsWith('Contracts'));
    await handleUpdate(callback(202,pick.callback_data,999),env,tg,clock);
    assert.ok(await store.menuChoices('1',root.id,root.message_id));
    await handleUpdate(callback(203,pick.callback_data,root.message_id),env,tg,clock);
    rows=tg.calls.at(-1)!.body.reply_markup.inline_keyboard.flat();
    assert.match(tg.calls.at(-1)!.body.text,/Contracts: choose a subtopic/);
    assert.ok(rows.some((b:any)=>b.text==='Selected: 10 cards'));
    assert.ok(rows.some((b:any)=>b.text.startsWith('Offer')));
    assert.ok(!rows.some((b:any)=>b.text.includes('Duty')));
    assert.equal((await store.session('1'))?.id,current?.id);
    const child=(await d.db.prepare('SELECT id FROM study_menus WHERE active=1').first<{id:string}>())!;
    await handleUpdate(callback(204,pick.callback_data,root.message_id),env,tg,clock);
    assert.ok(await store.menuChoices('1',child.id,root.message_id));
    await handleUpdate(callback(205,rows.find((b:any)=>b.text==='Back to Subjects').callback_data,root.message_id),env,tg,clock);
    rows=tg.calls.at(-1)!.body.reply_markup.inline_keyboard.flat();
    assert.ok(rows.some((b:any)=>b.text.startsWith('Torts')));
    assert.ok(rows.some((b:any)=>b.text==='Selected: 10 cards'));
    await store.stop('1');
    await handleUpdate(callback(206,rows.find((b:any)=>b.text.startsWith('Torts')).callback_data,root.message_id),env,tg,clock);
    assert.equal(await store.session('1'),null);
  }finally{await d.close();}
});

test('simultaneous topic choices create one session; empty topic leaves current progress untouched',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql([{...demo,id:'a',subtopic:'Duty'},{...demo,id:'b',subtopic:'Breach'}]));
    const store=new Store(d.db);
    const id=await store.menu('1',[{text:'Duty',topic:{subject:'Demo',subtopic:'Duty'}},{text:'Breach',topic:{subject:'Demo',subtopic:'Breach'}}]);
    await store.attachMenu(id,42);
    await Promise.all([store.choose('1',id,0,42,clock),store.choose('1',id,1,42,clock)]);
    assert.equal((await d.db.prepare('SELECT count(*) AS n FROM sessions WHERE active=1').first<{n:number}>())!.n,1);
    const s=(await store.session('1'))!;
    const empty=await store.menu('1',[{text:'Empty',topic:{subject:'Demo',subtopic:'Missing'}}]);
    await store.attachMenu(empty,43);
    assert.equal(await store.choose('1',empty,0,43,clock),'empty');
    assert.equal((await store.session('1'))?.id,s.id);
    assert.equal(await store.choose('2',empty,0,43,clock),'stale');
    assert.equal(await store.choose('1',empty,99,43,clock),'stale');
  }finally{await d.close();}
});

test('/stop invalidates an unselected study menu',async()=>{
  const d=await database(),tg=transport();
  try{
    await d.db.exec(importSql([demo]));
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
    await handleUpdate(message(1,'/study'),env,tg,clock);
    const pick=tg.calls.at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data;
    await handleUpdate(message(2,'/stop'),env,tg,clock);
    await handleUpdate(callback(3,pick,41),env,tg,clock);
    assert.equal(await new Store(d.db).session('1'),null);
  }finally{await d.close();}
});

test('private commands render questions, reveal controls, source, and rating advances once', async () => {
  const d=await database(); const tg=transport();
  try {
    await d.db.exec(importSql([demo]));
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
    await handleUpdate(message(1,'/study mixed'),env,tg,clock);
    const q=tg.calls.find(c=>c.method==='sendMessage')!;
    assert.match(q.body.text,/2 \+ 2/);
    const reveal=q.body.reply_markup.inline_keyboard[0][0].callback_data;
    const s=(await new Store(d.db).session('1'))!;
    await handleUpdate(callback(2,reveal,s.message_id!),env,tg,clock);
    const a=tg.calls.find(c=>c.method==='editMessageText')!;
    assert.match(a.body.text,/Non-law test/);
    assert.deepEqual(a.body.reply_markup.inline_keyboard[0].map((b:any)=>b.text),['Again','Hard','Good','Easy']);
    const rate=a.body.reply_markup.inline_keyboard[0][2].callback_data;
    await handleUpdate(callback(3,rate,s.message_id!),env,tg,clock);
    await handleUpdate(callback(4,rate,s.message_id!),env,tg,clock);
    assert.equal((await d.db.prepare('SELECT count(*) AS n FROM reviews').first<{n:number}>())!.n,1);
  } finally { await d.close(); }
});

test('webhook rejects bad secret, invalid payloads and other users before storing updates', async () => {
  const d=await database();
  try {
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
    const ctx={waitUntil(_p:Promise<unknown>) {}};
    const request=(body:string,secret='secret')=>new Request('https://example.com/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body});
    assert.equal((await ingress(request('{}','bad'),env,ctx)).status,403);
    assert.equal((await ingress(request('{'),env,ctx)).status,400);
    assert.equal((await ingress(request(JSON.stringify({update_id:2,message:{chat:null}})),env,ctx)).status,400);
    assert.equal((await ingress(request('x'.repeat(70000)),env,ctx)).status,413);
    assert.equal((await ingress(request(JSON.stringify(message(3,'/study',2))),env,ctx)).status,200);
    assert.equal((await ingress(request(JSON.stringify(message(4,'/study',1,'group'))),env,ctx)).status,200);
    assert.equal((await d.db.prepare('SELECT count(*) AS n FROM updates').first<{n:number}>())!.n,0);
  } finally { await d.close(); }
});

test('duplicate ingress drains once and completed rating survives Telegram failure and recovery', async () => {
  const d=await database(); const tg=transport();
  try {
    await d.db.exec(importSql([demo]));
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
    const promises:Promise<unknown>[]=[];
    const request=()=>new Request('https://example.com/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'secret'},body:JSON.stringify(message(1,'/study mixed'))});
    await ingress(request(),env,{waitUntil(p){promises.push(p)}},tg,clock);
    await ingress(request(),env,{waitUntil(p){promises.push(p)}},tg,clock);
    await Promise.all(promises);
    assert.equal(tg.calls.filter(c=>c.method==='sendMessage').length,1);
    const s=(await new Store(d.db).session('1'))!;
    await new Store(d.db).reveal('1',s.id,0,s.message_id!);
    const update=callback(2,`r:${s.id}:0:3`,s.message_id!);
    await d.db.prepare('INSERT INTO updates(id,payload) VALUES(?,?)').bind(2,JSON.stringify(update)).run();
    await drain(env,{async call(){throw new Error('Network offline')}},clock);
    assert.equal((await d.db.prepare('SELECT count(*) AS n FROM reviews').first<{n:number}>())!.n,1);
    assert.equal((await d.db.prepare('SELECT status FROM updates WHERE id=2').first<{status:string}>())!.status,'pending');
    await drain(env,tg,clock);
    assert.equal((await d.db.prepare('SELECT count(*) AS n FROM reviews').first<{n:number}>())!.n,1);
    assert.equal((await d.db.prepare('SELECT status FROM updates WHERE id=2').first<{status:string}>())!.status,'done');
  } finally { await d.close(); }
});

test('long answers preserve every character and source without exceeding Telegram limits', async () => {
  const d=await database(); const tg=transport();
  try {
    await d.db.exec(importSql([{...demo,answer:'a'.repeat(10000)}]));
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
    await handleUpdate(message(1,'/study mixed'),env,tg,clock);
    const s=(await new Store(d.db).session('1'))!;
    await handleUpdate(callback(2,`v:${s.id}:0`,s.message_id!),env,tg,clock);
    const answerCalls=tg.calls.filter(c=>c.method==='sendMessage').slice(1);
    assert.equal(answerCalls.map(c=>c.body.text).join('').match(/a/g)!.length,10001);
    assert.match(answerCalls.map(c=>c.body.text).join(''),/Non-law test/);
    assert.ok(tg.calls.filter(c=>c.body.text).every(c=>c.body.text.length<=4096));
    assert.ok(tg.calls.find(c=>c.method==='editMessageReplyMarkup'));
  } finally { await d.close(); }
});
