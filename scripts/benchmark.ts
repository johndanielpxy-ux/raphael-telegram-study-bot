import { schedule } from '../src/scheduler.ts';
const now=new Date('2026-10-06T10:00:00Z');
let state:string|null=null;
for(let i=0;i<100;i++)state=schedule(state,3,new Date(now.getTime()+i*86400000)).state;
const samples:number[]=[];
for(let i=0;i<1000;i++){
  const start=performance.now();
  schedule(state,i%4+1,new Date(now.getTime()+101*86400000));
  samples.push(performance.now()-start);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({samples:samples.length,median_ms:samples[500],p95_ms:samples[950],max_ms:samples[999],scope:'Local FSRS adapter only; not Cloudflare CPU or whole-webhook compliance'},null,2));
