import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {database} from './helpers.ts';
import {importSql,type CardContent} from '../src/content.ts';
import {Store} from '../src/store.ts';

test('public demo imports two subjects, four subtopics and stable teaching order',async()=>{
  const cards:CardContent[]=JSON.parse(await readFile('cards/demo.json','utf8'));
  assert.equal(cards.length,10);
  assert.ok(cards.every(c=>c.source.includes('synthetic')||c.source.includes('fictional')));
  const d=await database();
  try{
    await d.db.exec(importSql(cards));
    const store=new Store(d.db),now=new Date('2026-10-08T00:00:00Z');
    assert.equal((await store.topics(now)).length,4);
    assert.equal((await store.counts(now)).total,10);
    const session=await store.start('1',now,{subject:'Bot basics',subtopic:'Recall'});
    assert.equal(session?.card_id,'demo-retrieval');
    await d.db.exec(importSql(cards));
    assert.equal((await store.counts(now)).total,10);
  }finally{await d.close();}
});
