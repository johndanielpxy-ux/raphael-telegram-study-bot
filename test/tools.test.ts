import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Telegram, chunks } from '../src/telegram.ts';
import { deliveryDiagnostic } from '../src/diagnostics.ts';
import { database } from './helpers.ts';
import { importSql } from '../src/content.ts';
import { Store } from '../src/store.ts';
import { handleUpdate } from '../src/bot.ts';

test('import CLI produces executable SQL that preserves quotes and multiline text',async()=>{
  const sql=execFileSync(process.execPath,['--import','tsx','scripts/import-cards.ts','cards/demo.json'],{encoding:'utf8'});
  const d=await database();
  try {
    await d.db.exec(sql);
    const c=await new Store(d.db).card('demo-retrieval');
    assert.match(c!.answer,/Close the answer/);
    const text="John's answer\nSecond line; DROP TABLE cards;";
    await d.db.exec(importSql([{id:'quoted',subject:'Demo',subtopic:'Text',question:'Quote?',answer:text,source:'Test'}]));
    assert.equal((await new Store(d.db).card('quoted'))?.answer,text);
  }finally{await d.close();}
});

test('Telegram errors never include token-bearing URLs',async()=>{
  const secret='123:DO_NOT_LOG';
  const tg=new Telegram(secret,async()=>{throw new Error(`https://api.telegram.org/bot${secret}/sendMessage`)});
  await assert.rejects(()=>tg.call('sendMessage',{text:'x'}),e=>e instanceof Error && !e.message.includes(secret));
  assert.equal(chunks('x'.repeat(3899)+'🌸end').join(''),'x'.repeat(3899)+'🌸end');
});

test('delivery diagnostics expose safe failure categories, never arbitrary upstream text',()=>{
  assert.equal(deliveryDiagnostic(new Error('Telegram sendMessage failed (400)')),'telegram_http_400');
  assert.equal(deliveryDiagnostic(new Error('Telegram network request failed')),'telegram_network');
  assert.equal(deliveryDiagnostic(new TypeError('https://api.telegram.org/bot123:SECRET')),'unexpected_TypeError');
});

test('future-due cards are not forced into a new session and status reports zero available',async()=>{
  const d=await database();
  try{
    await d.db.exec(importSql([{id:'future',subject:'Demo',subtopic:'Time',question:'Future?',answer:'Yes',source:'Test'}]));
    await d.db.prepare('UPDATE cards SET due=?').bind(Date.parse('2027-01-01T00:00:00Z')).run();
    const sent:string[]=[];
    const env={DB:d.db,OWNER_ID:'1',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
    const tg={async call(_method:string,body:Record<string,unknown>){if(body.text)sent.push(String(body.text));return{message_id:1};}};
    await handleUpdate({update_id:1,message:{message_id:1,chat:{id:1,type:'private'},from:{id:1},text:'/study'}},env,tg,new Date('2026-10-06T10:00:00Z'));
    assert.deepEqual(sent,['Choose a subject\n🚍 Commute goal: 5 cards\nAvailable / total cards']);
    const menu=await d.db.prepare('SELECT id FROM study_menus WHERE active=1').first<{id:string}>();
    await handleUpdate({update_id:2,callback_query:{id:'subject',from:{id:1},data:`n:${menu!.id}:0`,message:{message_id:1,chat:{id:1,type:'private'}}}},env,tg,new Date('2026-10-06T10:00:00Z'));
    const child=await d.db.prepare('SELECT id FROM study_menus WHERE active=1').first<{id:string}>();
    await handleUpdate({update_id:3,callback_query:{id:'empty',from:{id:1},data:`m:${child!.id}:0`,message:{message_id:1,chat:{id:1,type:'private'}}}},env,tg,new Date('2026-10-06T10:00:00Z'));
    assert.ok(sent.includes('No cards due in this topic.'));
    assert.equal(await new Store(d.db).session('1'),null);
  }finally{await d.close();}
});
