export interface Env { DB: D1Database; OWNER_ID: string; BOT_TOKEN: string; WEBHOOK_SECRET: string }
export interface TelegramMessage { message_id:number; chat:{id:number;type:string}; from?:{id:number}; text?:string }
export interface Update { update_id:number; message?:TelegramMessage; callback_query?:{id:string;from:{id:number};data?:string;message?:TelegramMessage} }
export interface TelegramTransport { call(method:string,body:Record<string,unknown>):Promise<{message_id?:number}> }
export interface Background { waitUntil(promise:Promise<unknown>):void }
