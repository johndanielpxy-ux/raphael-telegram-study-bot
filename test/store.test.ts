import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.ts';
import { Store } from '../src/store.ts';
import { importSql } from '../src/content.ts';

const now = new Date('2026-10-06T10:00:00Z');
const cards = Array.from({ length: 12 }, (_, i) => ({
  id: `demo-${i}`, subject: 'Demo', subtopic: 'Numbers', question: `Number ${i}?`,
  answer: String(i), source: 'Non-law software test',
}));

test('topic sessions stay filtered through ratings and counts distinguish due from total', async () => {
  const d=await database();
  try {
    await d.db.exec(importSql([
      {...cards[0],id:'a',subject:'Torts',subtopic:'Duty'},
      {...cards[0],id:'b',subject:'Torts',subtopic:'Breach'},
      {...cards[0],id:'c',subject:'Torts',subtopic:'Duty'},
    ]));
    const store=new Store(d.db);
    await d.db.prepare('UPDATE cards SET due=? WHERE id=?').bind(now.getTime()+100000,'c').run();
    assert.deepEqual(await store.topics(now),[
      {subject:'Torts',subtopic:'Breach',total:1,due:1},
      {subject:'Torts',subtopic:'Duty',total:2,due:1},
    ]);
    const s=(await store.start('1',now,{subject:'Torts',subtopic:'Duty'}))!;
    assert.equal(s.card_id,'a');
    await store.attach(s.id,0,42); await store.reveal('1',s.id,0,42);
    await store.rate('1',s.id,0,42,3,200,now);
    assert.equal(await store.session('1'),null);
    assert.equal(await store.start('1',now,{subject:'Torts',subtopic:'Duty'}),null);
    assert.equal((await store.card('b'))?.state,null);
  } finally {await d.close();}
});

test('imports require complete, unique cards and preserve learned state', async () => {
  assert.throws(() => importSql([cards[0], cards[0]]));
  assert.throws(() => importSql([{ ...cards[0], source: '' }]));
  const d = await database();
  try {
    await d.db.exec(importSql(cards));
    const store = new Store(d.db);
    const s = await store.start('1', now);
    assert.ok(s);
    await store.attach(s.id, s.position, 42);
    await store.reveal('1', s.id, s.position, 42);
    assert.equal(await store.rate('1', s.id, s.position, 42, 3, 100, now), true);
    const before = await store.card(s.card_id!);
    await d.db.exec(importSql([{ ...cards[0], question: 'Updated question' }]));
    assert.equal((await store.card(s.card_id!))?.state, before?.state);
  } finally { await d.close(); }
});

test('all FSRS ratings persist a future due date and history', async () => {
  const d = await database();
  try {
    for (const rating of [1, 2, 3, 4]) {
      await d.db.exec('DELETE FROM sessions; DELETE FROM reviews; DELETE FROM cards;');
      await d.db.exec(importSql([cards[0]]));
      const store = new Store(d.db);
      const s = (await store.start('1', now))!;
      await store.attach(s.id, 0, 42);
      await store.reveal('1', s.id, 0, 42);
      assert.equal(await store.rate('1', s.id, 0, 42, rating, rating, now), true);
      const c = (await new Store(d.db).card(s.card_id!))!;
      assert.ok(c.due > now.getTime());
      assert.equal(JSON.parse(c.state!).reps, 1);
      assert.equal((await d.db.prepare('SELECT count(*) AS n FROM reviews').first<{n:number}>())!.n, 1);
    }
  } finally { await d.close(); }
});

test('rating requires reveal, current owner, message and position; concurrent taps count once', async () => {
  const d = await database();
  try {
    await d.db.exec(importSql(cards));
    const store = new Store(d.db);
    const s = (await store.start('1', now))!;
    await store.attach(s.id, 0, 42);
    assert.equal(await store.rate('1', s.id, 0, 42, 3, 1, now), false);
    assert.equal(await store.reveal('2', s.id, 0, 42), false);
    await store.reveal('1', s.id, 0, 42);
    assert.equal(await store.rate('1', s.id, 0, 99, 3, 2, now), false);
    const results = await Promise.all([3, 4].map(id => store.rate('1', s.id, 0, 42, 3, id, now)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await d.db.prepare('SELECT count(*) AS n FROM reviews').first<{n:number}>())!.n, 1);
    assert.equal(await store.rate('1', s.id, 0, 42, 3, 5, now), false);
  } finally { await d.close(); }
});

test('due cards precede new, unfinished sessions resume, ten cards stop, and empty deck is clear', async () => {
  const d = await database();
  try {
    const store = new Store(d.db);
    assert.equal(await store.start('1', now), null);
    await d.db.exec(importSql(cards));
    await d.db.prepare('UPDATE cards SET due=?, state=? WHERE id=?').bind(now.getTime()-1, null, 'demo-9').run();
    const first = (await store.start('1', now))!;
    assert.equal(first.card_id, 'demo-9');
    assert.equal((await store.start('1', now))?.id, first.id);
    for (let i = 0; i < 10; i++) {
      const s = (await store.session('1'))!;
      await store.attach(s.id, s.position, 42+i);
      await store.reveal('1', s.id, s.position, 42+i);
      assert.equal(await store.rate('1', s.id, s.position, 42+i, 3, 100+i, now), true);
    }
    assert.equal(await store.session('1'), null);
    const next = (await store.start('1', now))!;
    await store.stop('1');
    assert.equal(await store.session('1'), null);
    assert.equal((await store.card(next.card_id!))?.state, null);
  } finally { await d.close(); }
});
