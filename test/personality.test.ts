import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers.ts';
import {handleUpdate} from '../src/bot.ts';
import {Store} from '../src/store.ts';
import {importSql} from '../src/content.ts';

const now=new Date('2026-10-06T02:00:00Z');
const msg=(id:number,text:string,user=1)=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:user,type:'private'},text}});
test('/start variants always credit John, describe commute recall and leave sessions intact',async()=>{
  const d=await database();const sent:string[]=[];
  const tg={async call(_method:string,body:any){if(body.text)sent.push(body.text);return {message_id:42};}};
  try{
    await d.db.exec(importSql([{id:'test',subject:'Torts',subtopic:'Duty',question:'Plain question?',answer:'Plain answer.',source:'Plain source.'}]));
    const store=new Store(d.db),session=await store.start('1',now);
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'test'};
    for(let i=1;i<=3;i++)await handleUpdate(msg(i,'/start'),env,tg,now);
    assert.equal(new Set(sent).size,3);
    for(const text of sent){
      assert.ok(text.startsWith("Hi, I'm Raphael, created by John Phua."));
      assert.match(text,/commute/i);assert.match(text,/\/study/);assert.match(text,/\/progress/);
      for(const label of ['Again:','Hard:','Good:','Easy:'])assert.ok(text.includes(label));
      assert.match(text,/Again, not Hard/);assert.match(text,/same XP/);
    }
    assert.equal((await store.session('1'))?.id,session?.id);
    await handleUpdate(msg(4,'/start',2),env,tg,now);assert.equal(sent.length,3);
    await handleUpdate(msg(5,'/help'),env,tg,now);
    for(const label of ['Again','Hard','Good','Easy'])assert.ok(sent.at(-1)!.includes(label));
    assert.match(sent.at(-1)!,/same XP/);
  }finally{await d.close();}
});

test('goal and XP messages use emojis while substantive question and answer stay plain',async()=>{
  const d=await database();const calls:{method:string;body:any}[]=[];
  const tg={async call(method:string,body:any){calls.push({method,body});return {message_id:42};}};
  try{
    await d.db.exec(importSql([{id:'test',subject:'Torts',subtopic:'Duty',question:'Plain question?',answer:'Plain answer.',source:'Plain source.'}]));
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'test'};
    await handleUpdate(msg(1,'/study'),env,tg,now);assert.match(calls.at(-1)!.body.text,/🚍 Commute goal/);
    await handleUpdate(msg(2,'/study mixed'),env,tg,now);
    const store=new Store(d.db),s=(await store.session('1'))!;
    assert.equal(calls.at(-1)!.body.text.split('\n\n').at(-1),'Plain question?');
    const cb=(id:number,data:string)=>({update_id:id,callback_query:{id:String(id),from:{id:1},data,message:{message_id:42,chat:{id:1,type:'private'}}}});
    await handleUpdate(cb(3,`v:${s.id}:0`),env,tg,now);
    assert.ok(calls.at(-1)!.body.text.endsWith('Plain answer.\n\nSource: Plain source.'));
    await handleUpdate(cb(4,`r:${s.id}:0:3`),env,tg,now);
    assert.match(calls.at(-1)!.body.text,/✨ \+10 XP/);
    await handleUpdate(msg(5,'/progress'),env,tg,now);assert.match(calls.at(-1)!.body.text,/✨ 10 XP total/);
  }finally{await d.close();}
});
