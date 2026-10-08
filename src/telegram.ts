import type { TelegramTransport } from './types.ts';
export class Telegram implements TelegramTransport {
  constructor(private token:string, private fetcher:typeof fetch=fetch) {}
  async call(method:string,body:Record<string,unknown>):Promise<{message_id?:number}> {
    let response:Response;
    try {
      // Workers fetch rejects an arbitrary object receiver; call it unbound.
      const fetcher=this.fetcher;
      response=await fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(4000),
      });
    } catch { throw new Error('Telegram network request failed'); }
    const payload=await response.json() as {ok:boolean;result?:{message_id?:number};description?:string};
    if (!response.ok || !payload.ok) {
      if (payload.description?.includes('message is not modified')) return {};
      // Do not include upstream text or request URLs: both can disclose credentials.
      throw new Error(`Telegram ${method} failed (${response.status})`);
    }
    return payload.result ?? {};
  }
}
export function chunks(text:string,size=3900):string[] {
  const result:string[]=[];
  while (text.length) {
    let end=Math.min(size,text.length);
    const code=text.charCodeAt(end-1);
    if (code>=0xD800 && code<=0xDBFF) end--;
    result.push(text.slice(0,end)); text=text.slice(end);
  }
  return result;
}
