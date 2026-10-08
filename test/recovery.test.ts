import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.ts';
import { drain, handleUpdate } from '../src/bot.ts';
import { Store } from '../src/store.ts';
import { importSql } from '../src/content.ts';
import worker from '../src/index.ts';

const card={id:'one',subject:'Demo',subtopic:'Time',question:'Question?',answer:'Answer',source:'Test'};
const now=new Date('2026-10-06T10:00:00Z');

test('mature FSRS dates round-trip through D1 across sessions',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql([card]));
    const store=new Store(d.db);
    let reviewTime=now;
    for(let i=0;i<4;i++){
      const s=(await store.start('1',reviewTime))!;
      assert.ok(s);
      await store.attach(s.id,0,40+i);
      await store.reveal('1',s.id,0,40+i);
      assert.equal(await store.rate('1',s.id,0,40+i,3,100+i,reviewTime),true);
      const saved=(await store.card('one'))!;
      assert.equal(JSON.parse(saved.state!).reps,i+1);
      assert.ok(saved.due>reviewTime.getTime());
      reviewTime=new Date(saved.due);
    }
  }finally{await d.close();}
});

test('poisoned updates stop blocking new commands after bounded failures',async()=>{
  const d=await database();
  try{
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
    const u={update_id:1,message:{message_id:1,chat:{id:1,type:'private'},from:{id:1},text:'/study'}};
    await d.db.prepare('INSERT INTO updates(id,payload) VALUES(?,?)').bind(1,JSON.stringify(u)).run();
    for(let i=0;i<3;i++)await drain(env,{async call(){throw new Error('offline')}},now);
    assert.equal((await d.db.prepare('SELECT status FROM updates WHERE id=1').first<{status:string}>())!.status,'failed');
    await d.db.prepare('INSERT INTO updates(id,payload) VALUES(?,?)').bind(2,JSON.stringify({...u,update_id:2})).run();
    const texts:string[]=[];
    await drain(env,{async call(_method,body){texts.push(String(body.text));return{message_id:42};}},now);
    assert.deepEqual(texts,['No cards loaded yet.']);
    assert.equal((await d.db.prepare('SELECT payload FROM updates WHERE id=2').first<{payload:string}>())!.payload,'{}');
  }finally{await d.close();}
});

test('stopped-session buttons cannot reveal or rate a replacement session',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql([card]));
    const store=new Store(d.db), s=(await store.start('1',now))!;
    await store.attach(s.id,0,42);
    await store.stop('1');
    const replacement=(await store.start('1',now))!;
    assert.notEqual(replacement.id,s.id);
    assert.equal(await store.reveal('1',s.id,0,42),false);
    assert.equal(await store.rate('1',s.id,0,42,3,3,now),false);
    assert.equal((await store.card('one'))?.state,null);
  }finally{await d.close();}
});

test('Worker routes expose only health and fail closed without configuration',async()=>{
  const d=await database();
  try{
    const env={DB:d.db,OWNER_ID:'',BOT_TOKEN:'',WEBHOOK_SECRET:''},ctx={waitUntil(_p:Promise<unknown>){}};
    assert.equal((await worker.fetch(new Request('https://example.com/health'),env,ctx)).status,200);
    assert.equal((await worker.fetch(new Request('https://example.com/'),env,ctx)).status,404);
    assert.equal((await worker.fetch(new Request('https://example.com/webhook',{method:'POST',body:'{}'}),env,ctx)).status,503);
  }finally{await d.close();}
});
