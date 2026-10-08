import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
export async function database() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    const dir=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'));
    return { db: db as unknown as D1Database, close: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}
