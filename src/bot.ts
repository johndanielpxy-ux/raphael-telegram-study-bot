import { Store, type Session, type StudyChoice } from './store.ts';
import { Telegram, chunks } from './telegram.ts';
import { deliveryDiagnostic } from './diagnostics.ts';
import type { Env, Update, TelegramMessage, TelegramTransport, Background } from './types.ts';

function privateUser(update:Update):string|null {
  const m=update.callback_query?.message ?? update.message;
  const from=update.callback_query?.from ?? update.message?.from;
  return m && from && Number.isSafeInteger(from.id) && from.id>0 && m.chat.type==='private' && m.chat.id===from.id ? String(from.id) : null;
}
const commandOf=(update:Update)=>update.message?.text?.trim().split(/\s+/)[0].split('@')[0];
const buttons=(s:Session,rating=false)=>({inline_keyboard:[rating
  ? ['Again','Hard','Good','Easy'].map((text,i)=>({text,callback_data:`r:${s.id}:${s.position}:${i+1}`}))
  : [{text:'Reveal Answer',callback_data:`v:${s.id}:${s.position}`}],
  [{text:'Practise This Later',callback_data:`p:${s.id}:${s.position}`}]]});

const greetings=[
  "How's your day going? A few cards on the commute can be enough for today.",
  'On your way home? Let\'s keep your commute light with a short memory workout.',
  'Good to see you. Ready for a little recall practice on your commute?',
];
const commands='/study - choose a module, topic, mixed review or Endless Gauntlet\n/repair - your private practise-later queue\n/progress - XP and weekly activity\n/goal 4 - weekly study-day target\n/stop - end session or gauntlet\n/clear - reset your progress and repair queue (confirmation required)\n/id - your Telegram ID\n/help - rating buttons';
const accessHelp='/allow 123456789 - approve one friend\n/revoke 123456789 - remove their access\n/access - check approved account';
const ratingHelp='Again: I forgot or got it wrong.\nHard: I recalled it correctly, but struggled.\nGood: I recalled it correctly with normal effort.\nEasy: I recalled it correctly and effortlessly.\n\nThese ratings guide when the card returns. Forgot the answer? Choose Again, not Hard. All ratings earn the same XP, subject to the daily limits.';

function menuView(id:string,choices:StudyChoice[],goal:number){
  const subject=choices.find(c=>c.topic)?.topic?.subject;
  return {text:`${subject?`${subject}: choose a subtopic`:'Choose a subject'}\n🚍 Commute goal: ${goal} cards\nAvailable / total cards`,reply_markup:{inline_keyboard:[
    [5,10].map(n=>({text:`${n===goal?'Selected: ':''}${n} cards`,callback_data:`g:${id}:${n}`})),
    ...choices.map((c,i)=>[{text:c.text,callback_data:`${c.subject||c.back?'n':'m'}:${id}:${i}`}]),
  ]}};
}
async function studyChoices(store:Store,user:string,now:Date,goal:number,subject?:string):Promise<StudyChoice[]>{
  const topics=await store.topics(now,user);
  if(subject)return [
    {text:`Mixed Review (${topics.filter(t=>t.subject===subject).reduce((n,t)=>n+t.due,0)} available)`,goal,topic:{subject,subtopic:''}},
    {text:'⚔️ Endless Gauntlet',goal,endless:true,topic:{subject,subtopic:''}},
    ...topics.filter(t=>t.subject===subject).map(t=>({text:`${t.subtopic} (${t.due}/${t.total})`,goal,topic:{subject:t.subject,subtopic:t.subtopic}})),
    {text:'Back to Subjects',back:true,goal},
  ];
  const choices:StudyChoice[]= [...new Set(topics.map(t=>t.subject))].map(subject=>{
    const subset=topics.filter(t=>t.subject===subject);
    return {text:`${subject} (${subset.reduce((n,t)=>n+t.due,0)}/${subset.reduce((n,t)=>n+t.total,0)})`,subject,goal};
  });
  const s=await store.session(user);
  if(s)choices.unshift({text:'Resume Session',resume:s.id,goal});
  return choices;
}
async function showProgress(store:Store,user:string,tg:TelegramTransport,now:Date){
  const p=await store.progress(user,now),counts=await store.counts(now,user),repairs=await store.repairs(user);
  const labels=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const activity=p.activity.map((d,i)=>`${labels[i]} ${d.active?'✅':d.future?'⏳':'-'}`).join(' | ');
  await tg.call('sendMessage',{chat_id:user,text:`✨ ${p.xp} XP total\n${p.todayXp}/200 XP today\n📅 Study days this week: ${p.days}/${p.weeklyGoal}\n${activity}\n${counts.due} cards available / ${counts.total} total\n${repairs.length} saved for desk practice: /repair\nXP tracks participation, not mastery.`});
}
async function showRepair(store:Store,user:string,tg:TelegramTransport){
  const items=await store.repairs(user),item=items[0];
  if(!item){await tg.call('sendMessage',{chat_id:user,text:'Your repair queue is empty. Save a card with Practise This Later during /study. Nothing is added automatically from your ratings.'});return;}
  const c=await store.card(item.card_id,user);
  if(!c)throw new Error('Repair card missing');
  const sent=await tg.call('sendMessage',{chat_id:user,text:`${c.subject} / ${c.subtopic}\nSaved for desk practice: ${items.length}\nNo need to do this now.\n\n${c.question}\n\nWhen ready, try your own answer before checking the reference. State the rule and one qualification, then change one material fact and explain whether the reasoning changes.\n\nThis is optional practice, not a scored test. Your review schedule is unchanged.`,reply_markup:{inline_keyboard:[[{text:'Show Reference Answer',callback_data:`a:${item.id}`}]]}});
  if(!Number.isSafeInteger(sent.message_id))throw new Error('Telegram did not return a message ID');
  await store.attachRepair(user,item.id,sent.message_id!);
}
async function render(store:Store,user:string,tg:TelegramTransport,now:Date,completedId?:string) {
  const s=await store.session(user);
  if (!s) {
    const done=completedId?await store.completed(user,completedId):null;
    if(!done){await tg.call('sendMessage',{chat_id:user,text:'Session complete. /study for another short session.'});return;}
    const p=await store.progress(user,now);
    const choices:StudyChoice[]=[5,10].map(goal=>({text:`Continue ${goal}`,goal,topic:done.subject!==null?{subject:done.subject,subtopic:done.subtopic!}:undefined}));
    choices.push({text:'My Progress',progress:true},{text:'Finish',finish:true});
    const id=await store.menu(user,choices);
    const sent=await tg.call('sendMessage',{chat_id:user,text:`🏁 ${done.position>=done.goal?'Commute goal complete':'Available cards complete'}: ${done.position}/${done.goal}\n✨ +${done.earned} XP this session\n${p.xp} XP total\n📅 Study days this week: ${p.days}/${p.weeklyGoal}`,reply_markup:{inline_keyboard:[choices.slice(0,2).map((c,i)=>({text:c.text,callback_data:`m:${id}:${i}`})),choices.slice(2).map((c,i)=>({text:c.text,callback_data:`m:${id}:${i+2}`}))]}});
    if(!Number.isSafeInteger(sent.message_id))throw new Error('Telegram did not return a message ID');
    await store.attachMenu(id,sent.message_id!);return;
  }
  const c=await store.card(s.card_id!,user);
  if (!c) throw new Error('Session card missing');
  const heading=`${c.subject} / ${c.subtopic}\n${s.endless?`⚔️ Endless Gauntlet · Card ${s.position+1}\nPractice mode: schedule unchanged. /stop to finish.`:`🚍 Commute goal: ${s.position}/${s.goal}\nCard ${s.position+1} of up to ${s.goal}`}\n\n${c.question}`;
  if (!s.revealed) {
    if (s.message_id!==null) {
      await tg.call('editMessageText',{chat_id:user,message_id:s.message_id,text:heading,reply_markup:buttons(s)});
    } else {
      const sent=await tg.call('sendMessage',{chat_id:user,text:heading,reply_markup:buttons(s)});
      if (!Number.isSafeInteger(sent.message_id)) throw new Error('Telegram did not return a message ID');
      await store.attach(s.id,s.position,sent.message_id!);
    }
    return;
  }
  const answer=`${c.answer}\n\nSource: ${c.source}`;
  if (heading.length+answer.length+2<=4096) {
    await tg.call('editMessageText',{chat_id:user,message_id:s.message_id,text:`${heading}\n\n${answer}`,reply_markup:buttons(s,true)});
  } else {
    for (const text of chunks(answer)) await tg.call('sendMessage',{chat_id:user,text});
    await tg.call('editMessageReplyMarkup',{chat_id:user,message_id:s.message_id,reply_markup:buttons(s,true)});
  }
}

export async function handleUpdate(update:Update,env:Env,tg:TelegramTransport,now=new Date()):Promise<void> {
  const user=privateUser(update);
  if(!user)return;
  const command=commandOf(update);
  if(command==='/id'){
    await tg.call('sendMessage',{chat_id:user,text:`Telegram ID: ${user}\n\nSend this number privately to the bot owner for approval. This command does not grant study access.`});
    return;
  }
  const store=new Store(env.DB,env.OWNER_ID);
  if(!await store.allowed(user))return;
  if(command==='/allow'||command==='/revoke'||command==='/access'){
    if(user!==env.OWNER_ID){await tg.call('sendMessage',{chat_id:user,text:'Only the bot owner can manage access.'});return;}
    if(command==='/access'){
      const friend=await store.friend();
      await tg.call('sendMessage',{chat_id:user,text:`${friend?`Approved friend: ${friend}`:'No friend approved.'}\n\n${accessHelp}`});return;
    }
    const args=update.message!.text!.trim().split(/\s+/),target=args[1];
    if(args.length!==2||!target||!/^[1-9]\d*$/.test(target)||!Number.isSafeInteger(Number(target))||target===env.OWNER_ID){
      await tg.call('sendMessage',{chat_id:user,text:'Use a positive numeric Telegram ID belonging to your friend, not your own ID.\n\n'+accessHelp});return;
    }
    const ok=command==='/allow'?await store.allowFriend(target,now):await store.revokeFriend(target);
    await tg.call('sendMessage',{chat_id:user,text:command==='/allow'
      ?ok?`Approved ${target}. They can now send /start or /study. Their reviews and XP are separate from yours.`:'One friend is already approved. Use /access, then /revoke their ID before approving someone else.'
      :ok?`Access revoked for ${target}. Active sessions and menus were stopped; their saved progress remains private.`:'That ID is not the approved friend.'});
    return;
  }
  const cb=update.callback_query;
  if (cb) {
    const parts=cb.data?.split(':') ?? [];
    const [action,id,pos,value]=parts, position=Number(pos);
    let valid=false;
    if((action==='a'||action==='d')&&parts.length===2&&id&&cb.message){
      valid=action==='a'
        ?await store.revealRepair(user,id,cb.message.message_id)
        :await store.finishRepair(user,id,cb.message.message_id,update.update_id,now);
      await tg.call('answerCallbackQuery',{callback_query_id:cb.id,text:valid?'':'This repair button is no longer active.'}).catch(()=>{});
      if(!valid)return;
      if(action==='d'){await showRepair(store,user,tg);return;}
      const item=await store.repair(user,id,cb.message.message_id);
      if(!item)return;
      const c=await store.card(item.card_id,user);
      if(!c)throw new Error('Repair card missing');
      for(const text of chunks(`${c.answer}\n\nSource: ${c.source}\n\nCompare this with your attempt. Reviewed For Now removes it from this queue, not from spaced repetition, and does not certify mastery. Keep it here if you want another attempt.`))await tg.call('sendMessage',{chat_id:user,text});
      await tg.call('editMessageReplyMarkup',{chat_id:user,message_id:cb.message.message_id,reply_markup:{inline_keyboard:[[{text:'Show Reference Answer',callback_data:`a:${id}`}],[{text:'Reviewed For Now',callback_data:`d:${id}`}]]}});
      return;
    }
    if(action==='p'&&parts.length===3&&id&&cb.message&&/^\d+$/.test(pos)&&Number.isSafeInteger(position)){
      valid=await store.saveRepair(user,id,position,cb.message.message_id,now);
      await tg.call('answerCallbackQuery',{callback_query_id:cb.id,text:valid?'Saved privately. /repair whenever you are ready. Schedule unchanged.':'This card is no longer active.'}).catch(()=>{});
      return;
    }
    if(action==='n'&&parts.length===3&&id&&cb.message&&/^\d+$/.test(pos)){
      const choices=await store.menuChoices(user,id,cb.message.message_id);
      const choice=choices?.[position];
      const goal=choice?.goal===10?10:5;
      const next=choice&&(choice.subject||choice.back)
        ?await store.navigateMenu(user,id,position,cb.message.message_id,await studyChoices(store,user,now,goal,choice.subject)):null;
      await tg.call('answerCallbackQuery',{callback_query_id:cb.id,text:next?'':'This menu is no longer active.'}).catch(()=>{});
      if(next){const rows=await store.menuChoices(user,next,cb.message.message_id);if(rows)await tg.call('editMessageText',{chat_id:user,message_id:cb.message.message_id,...menuView(next,rows,goal)});}
      return;
    }
    if(action==='g'&&parts.length===3&&id&&cb.message&&/^(5|10)$/.test(pos)){
      valid=await store.setMenuGoal(user,id,cb.message.message_id,position);
      await tg.call('answerCallbackQuery',{callback_query_id:cb.id,text:valid?'':'This menu is no longer active.'}).catch(()=>{});
      if(valid){const choices=await store.menuChoices(user,id,cb.message.message_id);if(choices)await tg.call('editMessageText',{chat_id:user,message_id:cb.message.message_id,...menuView(id,choices,position)});}
      return;
    }
    if(action==='m' && parts.length===3 && id && cb.message && /^\d+$/.test(pos)) {
      const result=await store.choose(user,id,position,cb.message.message_id,now);
      await tg.call('answerCallbackQuery',{callback_query_id:cb.id,text:result==='stale'?'This menu is no longer active.':result==='empty'?'No cards due in this topic.':''}).catch(()=>{});
      if(result==='ok')await render(store,user,tg,now);
      if(result==='progress')await showProgress(store,user,tg,now);
      if(result==='finish')await tg.call('sendMessage',{chat_id:user,text:'Finished. Your progress is saved.'});
      if(result==='cleared')await tg.call('sendMessage',{chat_id:user,text:'Your review history, schedule, XP and repair queue have been reset. All cards are fresh. Your weekly goal, access and the other account are unchanged. Send /study to begin. Old Telegram messages remain.'});
      if(result==='cancelled')await tg.call('sendMessage',{chat_id:user,text:'Reset cancelled. Your progress is unchanged.'});
      return;
    }
    if (id && Number.isSafeInteger(position) && position>=0 && cb.message) {
      if (action==='v' && parts.length===3) valid=await store.reveal(user,id,position,cb.message.message_id);
      if (action==='r' && parts.length===4 && /^[1-4]$/.test(value)) {
        valid=await store.rate(user,id,position,cb.message.message_id,Number(value),update.update_id,now);
        // Retry after an outbound failure: the already-committed review stays intact.
        if (!valid) valid=!!await env.DB.prepare('SELECT 1 FROM reviews r JOIN sessions s ON s.id=r.session_id WHERE r.update_id=? AND r.session_id=? AND r.position=? AND s.user_id=?').bind(update.update_id,id,position,user).first();
      }
    }
    // Callback acknowledgements are best effort: an expired callback must not block recovery.
    await tg.call('answerCallbackQuery',{callback_query_id:cb.id,text:valid?'':'This button is no longer active.'}).catch(()=>{});
    if (valid) await render(store,user,tg,now,action==='r'?id:undefined);
    return;
  }
  if(command==='/clear'){
    const choices:StudyChoice[]=[{text:'Reset My Progress',clear:true},{text:'Cancel',cancel:true}];
    const id=await store.menu(user,choices);
    const sent=await tg.call('sendMessage',{chat_id:user,text:'Reset your progress? This permanently deletes your review history, XP and private repair queue, resets all your cards to fresh, and ends your session. Cards, weekly goal, access and the other account are kept. It does not delete Telegram messages.\n\nOnly confirm if you want to start over.',reply_markup:{inline_keyboard:[choices.map((c,i)=>({text:c.text,callback_data:`m:${id}:${i}`}))]}});
    if(!Number.isSafeInteger(sent.message_id))throw new Error('Telegram did not return a message ID');
    await store.attachMenu(id,sent.message_id!);
  } else if(command==='/repair'){
    await showRepair(store,user,tg);
  } else if(command==='/start'){
    const greeting=greetings[update.update_id%greetings.length];
    await tg.call('sendMessage',{chat_id:user,text:`Hi, I'm Raphael, created by John Phua.\n\n${greeting}\n\nI help you practise memory work with short, spaced-repetition reviews. Try recalling an answer before revealing it, then rate how it went.\n\n${ratingHelp}\n\n${commands}`});
  } else if(command==='/help'){
    await tg.call('sendMessage',{chat_id:user,text:`${ratingHelp}\n\n${commands}${user===env.OWNER_ID?`\n\nPrivate sharing:\n${accessHelp}`:''}`});
  } else if (command==='/study') {
      const topics=await store.topics(now,user);
      if(update.message?.text?.trim().split(/\s+/)[1]==='mixed'){
        const current=await store.session(user);
        const subjects=[...new Set(topics.map(t=>t.subject))];
        const session=current??(subjects.length===1?await store.start(user,now,{subject:subjects[0],subtopic:''}):null);
        if(session){await render(store,user,tg,now);return;}
      }
      if(!topics.length){await tg.call('sendMessage',{chat_id:user,text:'No cards loaded yet.'});return;}
      const choices=await studyChoices(store,user,now,5);
      const id=await store.menu(user,choices);
      const sent=await tg.call('sendMessage',{chat_id:user,...menuView(id,choices,5)});
      if(!Number.isSafeInteger(sent.message_id))throw new Error('Telegram did not return a message ID');
      await store.attachMenu(id,sent.message_id!);
      return;
  } else if (command==='/stop') {
    await store.stop(user);
    await tg.call('sendMessage',{chat_id:user,text:'Session stopped. The current card was not rated.'});
  } else if(command==='/progress'){
    await showProgress(store,user,tg,now);
  } else if(command==='/goal'){
    const value=update.message?.text?.trim().split(/\s+/)[1];
    if(!value||! /^[1-7]$/.test(value)){await tg.call('sendMessage',{chat_id:user,text:'Choose 1 to 7 study days per week: /goal 4'});return;}
    await store.setWeeklyGoal(user,Number(value));await showProgress(store,user,tg,now);
  } else if (command==='/status') {
    const counts=await store.counts(now,user), s=await store.session(user);
    const date=new Intl.DateTimeFormat('en-SG',{timeZone:'Asia/Singapore',dateStyle:'medium'}).format(now);
    await tg.call('sendMessage',{chat_id:user,text:`${date}\n${counts.due} cards available / ${counts.total} total${s?`\n${s.position} rated in this session`:''}`});
  } else {
    await tg.call('sendMessage',{chat_id:user,text:commands});
  }
}

function validMessage(m:unknown):m is TelegramMessage {
  if (!m || typeof m!=='object') return false;
  const v=m as TelegramMessage;
  return Number.isSafeInteger(v.message_id) && !!v.chat && Number.isSafeInteger(v.chat.id) && typeof v.chat.type==='string' && (v.text===undefined || typeof v.text==='string');
}
function validUpdate(v:unknown):v is Update {
  if (!v || typeof v!=='object') return false;
  const u=v as Update;
  if (!Number.isSafeInteger(u.update_id) || u.update_id<0) return false;
  if (u.message) return validMessage(u.message) && !!u.message.from && Number.isSafeInteger(u.message.from.id);
  const cb=u.callback_query;
  return !!cb && typeof cb.id==='string' && !!cb.from && Number.isSafeInteger(cb.from.id) && (cb.data===undefined || typeof cb.data==='string') && !!cb.message && validMessage(cb.message);
}

export async function ingress(request:Request,env:Env,ctx:Background,tg:TelegramTransport=new Telegram(env.BOT_TOKEN),now=new Date()):Promise<Response> {
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !/^\d+$/.test(env.OWNER_ID ?? '')) return new Response('Not configured',{status:503});
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.WEBHOOK_SECRET) return new Response('Forbidden',{status:403});
  const reader=request.body?.getReader();
  if (!reader) return new Response('Invalid update',{status:400});
  let size=0; const parts:Uint8Array[]=[];
  while (true) {
    const {value,done}=await reader.read(); if (done) break;
    size+=value.byteLength;
    if (size>65536) { await reader.cancel(); return new Response('Too large',{status:413}); }
    parts.push(value);
  }
  const bytes=new Uint8Array(size); let offset=0;
  for (const part of parts) { bytes.set(part,offset); offset+=part.length; }
  let update:unknown;
  try { update=JSON.parse(new TextDecoder().decode(bytes)); } catch { return new Response('Invalid JSON',{status:400}); }
  if (!validUpdate(update)) return new Response('Invalid update',{status:400});
  const user=privateUser(update);
  if(!user)return new Response('OK');
  try {
    // Self-ID is read-only, never enters the study queue and needs no allowlist entry.
    if(commandOf(update)==='/id'){await handleUpdate(update,env,tg,now);return new Response('OK');}
    if(!await new Store(env.DB,env.OWNER_ID).allowed(user))return new Response('OK');
    await env.DB.prepare('INSERT OR IGNORE INTO updates(id,payload) VALUES(?,?)').bind(update.update_id,JSON.stringify(update)).run();
    ctx.waitUntil(drain(env,tg,now));
    return new Response('OK');
  } catch { return new Response('Storage unavailable',{status:503}); }
}

export async function drain(env:Env,tg:TelegramTransport=new Telegram(env.BOT_TOKEN),now=new Date()):Promise<void> {
  if(!await env.DB.prepare("SELECT 1 FROM updates WHERE status='pending' LIMIT 1").first())return;
  const token=crypto.randomUUID(), start=Date.now();
  const lease=await env.DB.prepare('UPDATE drain_lock SET token=?,expires=? WHERE id=1 AND expires<?').bind(token,start+60000,start).run();
  if (!lease.meta.changes) return;
  try {
    for (let i=0;i<5 && Date.now()-start<20000;i++) {
      const row=await env.DB.prepare("SELECT id,payload FROM updates WHERE status='pending' ORDER BY id LIMIT 1").first<{id:number;payload:string}>();
      if (!row) break;
      try {
        await handleUpdate(JSON.parse(row.payload) as Update,env,tg,now);
        await env.DB.prepare("UPDATE updates SET status='done',payload='{}' WHERE id=?").bind(row.id).run();
      } catch (error) {
        await env.DB.prepare("UPDATE updates SET failures=failures+1,status=CASE WHEN failures>=2 THEN 'failed' ELSE 'pending' END WHERE id=?").bind(row.id).run();
        console.warn('Delivery diagnostic:',deliveryDiagnostic(error));
        break;
      }
    }
  } finally { await env.DB.prepare('UPDATE drain_lock SET expires=0,token=NULL WHERE id=1 AND token=?').bind(token).run(); }
}
