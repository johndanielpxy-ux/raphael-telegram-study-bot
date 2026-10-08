import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Telegram } from '../src/telegram.ts';

// Secrets stay in memory and travel to Wrangler over stdin, never argv or files.
async function hidden(question:string):Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Run this setup in an interactive Terminal, not in chat');
  process.stdout.write(question);
  const muted=new Writable({write(_chunk,_encoding,done){done();}});
  const rl=createInterface({input:process.stdin,output:muted,terminal:true});
  try { return (await rl.question('')).trim(); }
  finally { rl.close(); process.stdout.write('\n'); }
}
async function api(token:string,method:string,body:Record<string,unknown>={}) {
  try {
    const res=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const data=await res.json() as {ok:boolean;result:any};
    if (!res.ok || !data.ok) throw new Error('Telegram rejected the setup request');
    return data.result;
  } catch { throw new Error('Telegram setup request failed; check the token and internet connection'); }
}

try {
  const token=await hidden('Paste the NEW BotFather token here (hidden): ');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('That does not look like a BotFather token');
  const me=await api(token,'getMe');
  console.log(`Connected to @${me.username}. Send /start to this bot from your own Telegram account.`);
  const rl=createInterface({input:process.stdin,output:process.stdout});
  let owner:string, url:string;
  try {
    await rl.question('Press Enter once you have sent /start. ');
    const webhook=await api(token,'getWebhookInfo');
    if (webhook.url) throw new Error('This bot already has a webhook. Use a new bot; setup will not replace an existing integration.');
    const updates=await api(token,'getUpdates',{timeout:0});
    const ids=[...new Set<string>(updates.filter((u:any)=>u.message?.chat?.type==='private' && u.message?.from?.id===u.message?.chat?.id).map((u:any)=>String(u.message.from.id)))];
    console.log(`Private sender IDs seen by YOUR bot: ${ids.join(', ') || 'none yet'}`);
    owner=(await rl.question('Enter your Telegram sender ID from that list: ')).trim();
    if (!ids.includes(owner)) throw new Error('Owner ID must match a private sender seen by this bot');
    url=(await rl.question('Paste the deployed Worker URL (https://...workers.dev): ')).trim();
    const parsed=new URL(url);
    if (parsed.protocol!=='https:' || !parsed.hostname.endsWith('.workers.dev') || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use your HTTPS workers.dev URL');
    url=parsed.origin;
    const confirm=await rl.question(`Configure @${me.username} for ONLY user ${owner}, at ${url}? Type yes: `);
    if (confirm!=='yes') throw new Error('Cancelled without changing the bot');
  } finally { rl.close(); }
  const secret=Array.from(randomBytes(32),byte=>byte.toString(16).padStart(2,'0')).join('');
  for (const [name,value] of [['BOT_TOKEN',token],['OWNER_ID',owner],['WEBHOOK_SECRET',secret]]) {
    const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','put',name],{input:value+'\n',encoding:'utf8'});
    if (result.status!==0) throw new Error(`Cloudflare secret ${name} could not be saved. Sign in with npx wrangler login, then retry.`);
    console.log(`Saved ${name} securely to Cloudflare.`);
  }
  const tg=new Telegram(token);
  await tg.call('setMyCommands',{commands:[{command:'study',description:'Start a short review session'},{command:'status',description:'View progress'},{command:'stop',description:'End session'}]});
  // Read pending updates above without advancing offset; do not drop pending updates here.
  await api(token,'setWebhook',{url:`${url}/webhook`,secret_token:secret,allowed_updates:['message','callback_query'],max_connections:1});
  const info=await api(token,'getWebhookInfo');
  if (info.url!==`${url}/webhook`) throw new Error('Webhook verification failed');
  console.log('Webhook configured. Open the bot and send /study. No secrets were saved locally.');
} catch(error) { console.error(error instanceof Error?error.message:'Setup failed'); process.exitCode=1; }
