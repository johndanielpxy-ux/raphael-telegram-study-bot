import type { CardContent } from './content.ts';
import { schedule } from './scheduler.ts';
export interface SavedCard extends CardContent { state: string | null; due: number }
export interface Topic { subject:string; subtopic:string }
export interface Session { id: string; user_id: string; card_id: string | null; position: number; seen: string; revealed: number; message_id: number | null; active: number; subject:string|null; subtopic:string|null; goal:number; endless:number }
export interface RepairItem {id:string;user_id:string;card_id:string;created_at:number;updated_at:number;message_id:number|null;revealed:number;resolved_at:number|null;resolved_update_id:number|null}
export type StudyChoice={text:string; topic?:Topic; subject?:string; back?:boolean; resume?:string; goal?:number; endless?:boolean; progress?:boolean; finish?:boolean; clear?:boolean; cancel?:boolean};
interface StudyMenu {id:string;choices:string;message_id:number|null;selected:number|null;applied:number}

function localDay(now:Date){return new Date(now.getTime()+8*3600000).toISOString().slice(0,10);}

// Legacy schedules belong only to the original owner; new users always start fresh.
const scopedCards=`SELECT c.id,c.subject,c.subtopic,c.question,c.answer,c.source,c.learning_order,
  CASE WHEN p.card_id IS NOT NULL THEN p.state WHEN ?=? THEN c.state ELSE NULL END AS state,
  coalesce(p.due,CASE WHEN ?=? THEN c.due ELSE 0 END) AS due
  FROM cards c LEFT JOIN card_progress p ON p.card_id=c.id AND p.user_id=?`;

export class Store {
  constructor(public db: D1Database, private owner='1') {}
  private scope(user:string){return [user,this.owner,user,this.owner,user];}
  card(id: string,user=this.owner) { return this.db.prepare(`SELECT * FROM (${scopedCards}) WHERE id=?`).bind(...this.scope(user),id).first<SavedCard>(); }
  async friend(){return (await this.db.prepare('SELECT user_id FROM friend_access WHERE slot=1').first<{user_id:string}>())?.user_id??null;}
  async allowed(user:string){return user===this.owner||user===await this.friend();}
  async allowFriend(user:string,now:Date){
    if(!/^[1-9]\d*$/.test(user)||!Number.isSafeInteger(Number(user))||user===this.owner)return false;
    await this.db.prepare('INSERT OR IGNORE INTO friend_access(slot,user_id,added_at) VALUES(1,?,?)').bind(user,now.getTime()).run();
    return await this.friend()===user;
  }
  async revokeFriend(user:string){
    if(user===this.owner)return false;
    const result=await this.db.batch([
      this.db.prepare('UPDATE sessions SET active=0 WHERE user_id=? AND active=1 AND EXISTS(SELECT 1 FROM friend_access WHERE user_id=?)').bind(user,user),
      this.db.prepare('UPDATE study_menus SET active=0 WHERE user_id=? AND active=1 AND EXISTS(SELECT 1 FROM friend_access WHERE user_id=?)').bind(user,user),
      this.db.prepare('DELETE FROM friend_access WHERE user_id=?').bind(user),
    ]);
    return result[2].meta.changes>0;
  }
  session(user: string) { return this.db.prepare('SELECT * FROM sessions WHERE user_id=? AND active=1').bind(user).first<Session>(); }
  async saveRepair(user:string,id:string,position:number,message:number,now:Date){
    // The session/message gate is inside the write, so a rating race cannot save a different card.
    const result=await this.db.prepare(`INSERT INTO repair_queue(id,user_id,card_id,created_at,updated_at)
      SELECT ?,user_id,card_id,?,? FROM sessions WHERE user_id=? AND id=? AND position=? AND message_id=? AND active=1 AND card_id IS NOT NULL
      ON CONFLICT(user_id,card_id) DO UPDATE SET
        created_at=CASE WHEN repair_queue.resolved_at IS NOT NULL THEN excluded.created_at ELSE repair_queue.created_at END,
        updated_at=max(repair_queue.updated_at,excluded.updated_at),
        message_id=CASE WHEN repair_queue.resolved_at IS NOT NULL THEN NULL ELSE repair_queue.message_id END,
        revealed=CASE WHEN repair_queue.resolved_at IS NOT NULL THEN 0 ELSE repair_queue.revealed END,
        resolved_at=NULL,resolved_update_id=NULL`).bind(crypto.randomUUID(),now.getTime(),now.getTime(),user,id,position,message).run();
    return result.meta.changes>0;
  }
  async repairs(user:string){
    return (await this.db.prepare('SELECT * FROM repair_queue WHERE user_id=? AND resolved_at IS NULL ORDER BY created_at,id').bind(user).all<RepairItem>()).results;
  }
  repair(user:string,id:string,message:number){
    return this.db.prepare('SELECT * FROM repair_queue WHERE user_id=? AND id=? AND message_id=? AND resolved_at IS NULL').bind(user,id,message).first<RepairItem>();
  }
  async attachRepair(user:string,id:string,message:number){
    await this.db.prepare('UPDATE repair_queue SET message_id=?,revealed=0 WHERE user_id=? AND id=? AND resolved_at IS NULL').bind(message,user,id).run();
  }
  async revealRepair(user:string,id:string,message:number){
    const result=await this.db.prepare('UPDATE repair_queue SET revealed=1 WHERE user_id=? AND id=? AND message_id=? AND resolved_at IS NULL').bind(user,id,message).run();
    return result.meta.changes>0;
  }
  async finishRepair(user:string,id:string,message:number,updateId:number,now:Date){
    const result=await this.db.prepare('UPDATE repair_queue SET resolved_at=?,resolved_update_id=? WHERE user_id=? AND id=? AND message_id=? AND revealed=1 AND resolved_at IS NULL').bind(now.getTime(),updateId,user,id,message).run();
    if(result.meta.changes)return true;
    // Resume delivery after a committed completion, without completing a second item.
    return !!await this.db.prepare('SELECT 1 FROM repair_queue WHERE user_id=? AND id=? AND message_id=? AND resolved_update_id=? AND resolved_at IS NOT NULL').bind(user,id,message,updateId).first();
  }
  async topics(now:Date,user=this.owner) {
    return (await this.db.prepare(`SELECT subject,subtopic,count(*) AS total,sum(due<=?) AS due FROM (${scopedCards}) GROUP BY subject,subtopic ORDER BY subject,subtopic`).bind(now.getTime(),...this.scope(user)).all<Topic & {total:number;due:number}>()).results;
  }
  private next(user:string,now: Date, seen: string, topic?:Topic,endless=false) {
    return this.db.prepare(`SELECT * FROM (${scopedCards}) WHERE (?=1 OR due<=?) AND id NOT IN (SELECT value FROM json_each(?)) AND (? IS NULL OR (subject=? AND (? IS NULL OR subtopic=?))) ORDER BY CASE WHEN due=0 THEN 1 WHEN due<=? THEN 0 ELSE 2 END,due,CASE WHEN due=0 THEN learning_order ELSE 0 END,id LIMIT 1`).bind(...this.scope(user),endless?1:0,now.getTime(),seen,topic?.subject??null,topic?.subject??null,topic?.subtopic||null,topic?.subtopic||null,now.getTime()).first<SavedCard>();
  }
  async start(user: string, now: Date, topic?:Topic,goal=10) {
    if(goal!==5&&goal!==10)throw new Error('Invalid session goal');
    const existing = await this.session(user);
    if (existing) return existing;
    const card = await this.next(user,now, '[]',topic);
    if (!card) return null;
    await this.db.batch([
      this.db.prepare('UPDATE study_menus SET active=0 WHERE user_id=? AND active=1').bind(user),
      this.db.prepare('INSERT OR IGNORE INTO sessions(id,user_id,card_id,subject,subtopic,goal) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),user,card.id,topic?.subject??null,topic?.subtopic??null,goal),
    ]);
    return this.session(user);
  }
  async menu(user:string,choices:StudyChoice[]) {
    const id=crypto.randomUUID();
    await this.db.batch([
      this.db.prepare('UPDATE study_menus SET active=0 WHERE user_id=? AND active=1').bind(user),
      this.db.prepare('INSERT INTO study_menus(id,user_id,choices) VALUES(?,?,?)').bind(id,user,JSON.stringify(choices)),
    ]);
    return id;
  }
  async attachMenu(id:string,message:number) {await this.db.prepare('UPDATE study_menus SET message_id=? WHERE id=?').bind(message,id).run();}
  async navigateMenu(user:string,id:string,index:number,message:number,choices:StudyChoice[]){
    const next=crypto.randomUUID();
    await this.db.batch([
      this.db.prepare('UPDATE study_menus SET selected=? WHERE id=? AND user_id=? AND message_id=? AND active=1 AND selected IS NULL').bind(index,id,user,message),
      this.db.prepare('INSERT INTO study_menus(id,user_id,choices,message_id) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM study_menus WHERE id=? AND user_id=? AND message_id=? AND active=1 AND selected=? AND applied=0)').bind(next,user,JSON.stringify(choices),message,id,user,message,index),
      this.db.prepare('UPDATE study_menus SET active=0,applied=1 WHERE id=? AND EXISTS(SELECT 1 FROM study_menus WHERE id=?)').bind(id,next),
    ]);
    return await this.menuChoices(user,next,message)?next:null;
  }
  async menuChoices(user:string,id:string,message:number){
    const row=await this.db.prepare('SELECT choices FROM study_menus WHERE id=? AND user_id=? AND message_id=? AND active=1').bind(id,user,message).first<{choices:string}>();
    return row?JSON.parse(row.choices) as StudyChoice[]:null;
  }
  async setMenuGoal(user:string,id:string,message:number,goal:number){
    if(goal!==5&&goal!==10)return false;
    const result=await this.db.prepare("UPDATE study_menus SET choices=(SELECT json_group_array(json_set(value,'$.goal',?)) FROM json_each(study_menus.choices)) WHERE id=? AND user_id=? AND message_id=? AND active=1 AND selected IS NULL").bind(goal,id,user,message).run();
    return result.meta.changes>0;
  }
  async choose(user:string,id:string,index:number,message:number,now:Date):Promise<'ok'|'empty'|'stale'|'progress'|'finish'|'cleared'|'cancelled'> {
    const m=await this.db.prepare('SELECT * FROM study_menus WHERE id=? AND user_id=? AND message_id=? AND active=1').bind(id,user,message).first<StudyMenu>();
    if(!m||!Number.isSafeInteger(index)||index<0) return 'stale';
    const choice=(JSON.parse(m.choices) as StudyChoice[])[index];
    if(!choice||(m.selected!==null&&m.selected!==index)) return 'stale';
    if(choice.cancel){const result=await this.db.prepare('UPDATE study_menus SET active=0 WHERE id=? AND user_id=? AND message_id=? AND active=1 AND selected IS NULL').bind(id,user,message).run();return result.meta.changes?'cancelled':'stale';}
    if(choice.clear){
      if(m.applied)return 'cleared';
      const gate='EXISTS(SELECT 1 FROM study_menus WHERE id=? AND user_id=? AND message_id=? AND selected=? AND applied=0 AND active=1)';
      // Every destructive write is gated by the same single-use confirmation transaction.
      await this.db.batch([
        this.db.prepare('UPDATE study_menus SET selected=? WHERE id=? AND user_id=? AND message_id=? AND active=1 AND selected IS NULL').bind(index,id,user,message),
        this.db.prepare(`DELETE FROM rewards WHERE user_id=? AND ${gate}`).bind(user,id,user,message,index),
        this.db.prepare(`DELETE FROM repair_queue WHERE user_id=? AND ${gate}`).bind(user,id,user,message,index),
        this.db.prepare(`DELETE FROM reviews WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?) AND ${gate}`).bind(user,id,user,message,index),
        this.db.prepare(`DELETE FROM sessions WHERE user_id=? AND ${gate}`).bind(user,id,user,message,index),
        this.db.prepare(`INSERT INTO card_progress(user_id,card_id,state,due) SELECT ?,id,NULL,0 FROM cards WHERE ${gate} ON CONFLICT(user_id,card_id) DO UPDATE SET state=NULL,due=0`).bind(user,id,user,message,index),
        this.db.prepare(`UPDATE study_menus SET active=0 WHERE user_id=? AND id<>? AND ${gate}`).bind(user,id,id,user,message,index),
        this.db.prepare('UPDATE study_menus SET applied=1 WHERE id=? AND user_id=? AND message_id=? AND selected=? AND applied=0 AND active=1').bind(id,user,message,index),
      ]);
      const done=await this.db.prepare('SELECT applied FROM study_menus WHERE id=? AND user_id=? AND message_id=? AND active=1').bind(id,user,message).first<{applied:number}>();
      return done?.applied?'cleared':'stale';
    }
    if(choice.subject||choice.back)return 'stale';
    if(choice.progress)return 'progress';
    if(choice.finish){await this.stop(user);return 'finish';}
    if(m.applied) return (await this.session(user))?.id===(choice.resume??id)?'ok':'stale';
    if(choice.resume) {
      if((await this.session(user))?.id!==choice.resume)return 'stale';
      await this.db.prepare('UPDATE study_menus SET selected=?,applied=1 WHERE id=? AND selected IS NULL').bind(index,id).run();
      return 'ok';
    }
    if(choice.text.startsWith('Mixed Review')&&!choice.topic)return 'stale';
    if(choice.endless&&!choice.topic?.subject)return 'stale';
    const card=await this.next(user,now,'[]',choice.topic,!!choice.endless);
    if(!card)return 'empty';
    // The menu claim gates switching and creation together; repeated taps cannot reset a session.
    await this.db.batch([
      this.db.prepare('UPDATE study_menus SET selected=? WHERE id=? AND selected IS NULL AND active=1').bind(index,id),
      this.db.prepare('UPDATE sessions SET active=0 WHERE user_id=? AND active=1 AND EXISTS(SELECT 1 FROM study_menus WHERE id=? AND selected=? AND applied=0 AND active=1)').bind(user,id,index),
      this.db.prepare('INSERT OR IGNORE INTO sessions(id,user_id,card_id,subject,subtopic,goal,endless) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM study_menus WHERE id=? AND selected=? AND applied=0 AND active=1)').bind(id,user,card.id,choice.topic?.subject??null,choice.topic?.subtopic??null,choice.goal===5?5:10,choice.endless?1:0,id,index),
      this.db.prepare('UPDATE study_menus SET applied=1 WHERE id=? AND selected=? AND applied=0 AND active=1').bind(id,index),
    ]);
    return (await this.session(user))?.id===id?'ok':'stale';
  }
  async attach(id: string, position: number, message: number) {
    await this.db.prepare('UPDATE sessions SET message_id=? WHERE id=? AND position=? AND active=1').bind(message,id,position).run();
  }
  async reveal(user: string, id: string, position: number, message: number) {
    const result = await this.db.prepare('UPDATE sessions SET revealed=1 WHERE user_id=? AND id=? AND position=? AND message_id=? AND active=1').bind(user,id,position,message).run();
    return result.meta.changes > 0;
  }
  async rate(user: string, id: string, position: number, message: number, rating: number, updateId: number, now: Date) {
    const s = await this.session(user);
    if (!s || s.id!==id || s.position!==position || s.message_id!==message || !s.revealed) return false;
    const c = await this.card(s.card_id!,user);
    if (!c) return false;
    const after = s.endless ? {state:c.state??'null',due:c.due} : schedule(c.state, rating, now);
    let seen = JSON.stringify([...JSON.parse(s.seen), c.id]);
    const topic=s.subject!==null?{subject:s.subject,subtopic:s.subtopic??''}:undefined;
    let next = s.endless||position<s.goal-1 ? await this.next(user,now,seen,topic,!!s.endless) : null;
    if(s.endless&&!next){seen='[]';next=await this.next(user,now,seen,topic,true);}
    // A unique session/position claim gates every write in the same transaction.
    const result = await this.db.batch([
      this.db.prepare('INSERT OR IGNORE INTO reviews(update_id,session_id,position,card_id,rating,reviewed_at,before_state,after_state,practice) SELECT ?,id,position,card_id,?,?,?,?,endless FROM sessions WHERE user_id=? AND id=? AND position=? AND message_id=? AND revealed=1 AND active=1').bind(updateId,rating,now.getTime(),c.state,after.state,user,id,position,message),
      this.db.prepare('INSERT OR IGNORE INTO rewards(review_id,user_id,session_id,card_id,day) SELECT update_id,?,?,card_id,? FROM reviews WHERE update_id=? AND applied=0 AND (SELECT count(*) FROM rewards WHERE user_id=? AND day=?)<20').bind(user,id,localDay(now),updateId,user,localDay(now)),
      this.db.prepare('INSERT INTO card_progress(user_id,card_id,state,due) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM reviews WHERE update_id=? AND applied=0 AND practice=0) ON CONFLICT(user_id,card_id) DO UPDATE SET state=excluded.state,due=excluded.due').bind(user,c.id,after.state,after.due,updateId),
      this.db.prepare('UPDATE sessions SET card_id=?,position=position+1,seen=?,revealed=0,message_id=NULL,active=? WHERE id=? AND EXISTS(SELECT 1 FROM reviews WHERE update_id=? AND applied=0)').bind(next?.id ?? null,seen,next?1:0,id,updateId),
      this.db.prepare('UPDATE reviews SET applied=1 WHERE update_id=? AND applied=0').bind(updateId),
    ]);
    return result[0].meta.changes > 0;
  }
  async stop(user: string) {
    await this.db.batch([
      this.db.prepare('UPDATE sessions SET active=0 WHERE user_id=? AND active=1').bind(user),
      this.db.prepare('UPDATE study_menus SET active=0 WHERE user_id=? AND active=1').bind(user),
    ]);
  }
  async counts(now: Date,user=this.owner) {
    return (await this.db.prepare(`SELECT count(*) AS total,coalesce(sum(due<=?),0) AS due FROM (${scopedCards})`).bind(now.getTime(),...this.scope(user)).first<{total:number;due:number}>())!;
  }
  async completed(user:string,id:string){
    return this.db.prepare('SELECT s.*,coalesce((SELECT sum(xp) FROM rewards WHERE session_id=s.id AND user_id=?),0) AS earned FROM sessions s WHERE s.id=? AND s.user_id=? AND s.active=0').bind(user,id,user).first<Session&{earned:number}>();
  }
  async setWeeklyGoal(user:string,goal:number){
    if(!Number.isInteger(goal)||goal<1||goal>7)throw new Error('Invalid weekly goal');
    await this.db.prepare('INSERT INTO study_preferences(user_id,weekly_goal) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET weekly_goal=excluded.weekly_goal').bind(user,goal).run();
  }
  async progress(user:string,now:Date){
    const day=localDay(now),today=new Date(`${day}T00:00:00Z`);
    const monday=new Date(today);monday.setUTCDate(today.getUTCDate()-(today.getUTCDay()+6)%7);
    const start=monday.toISOString().slice(0,10);
    const xp=(await this.db.prepare('SELECT coalesce(sum(xp),0) AS xp,coalesce(sum(CASE WHEN day=? THEN xp ELSE 0 END),0) AS todayXp FROM rewards WHERE user_id=? AND day<=?').bind(day,user,day).first<{xp:number;todayXp:number}>())!;
    const days=(await this.db.prepare("SELECT DISTINCT strftime('%Y-%m-%d',r.reviewed_at/1000,'unixepoch','+8 hours') AS day FROM reviews r JOIN sessions s ON s.id=r.session_id WHERE s.user_id=? AND r.applied=1 AND r.reviewed_at<=? AND strftime('%Y-%m-%d',r.reviewed_at/1000,'unixepoch','+8 hours') BETWEEN ? AND ? ORDER BY day").bind(user,now.getTime(),start,day).all<{day:string}>()).results;
    const pref=await this.db.prepare('SELECT weekly_goal FROM study_preferences WHERE user_id=?').bind(user).first<{weekly_goal:number}>();
    const active=new Set(days.map(d=>d.day));
    const activity=Array.from({length:7},(_,i)=>{const d=new Date(monday);d.setUTCDate(monday.getUTCDate()+i);const date=d.toISOString().slice(0,10);return {day:date,active:active.has(date),future:date>day};});
    return {...xp,days:days.length,weeklyGoal:pref?.weekly_goal??4,activity};
  }
}
