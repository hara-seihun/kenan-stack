import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { freshSchema, testDatabaseUrl } from '../db/test-db.js';
import { createCalendarExtension } from './calendar.js';

describe.skipIf(!testDatabaseUrl)('calendar tool pagination',()=>{
 const extension=createCalendarExtension();let db:pg.Client;
 const ctx:any={person:{id:'alice'}};
 beforeAll(async()=>{
  const url=await freshSchema('t_calendar_pages');await extension.start!({config:{databaseUrl:url}} as any);db=new pg.Client({connectionString:url});await db.connect();
  await db.query(`INSERT INTO kenan_calendar(owner_id,id,data)
    SELECT 'alice',i::text,jsonb_build_object('id',i::text,'title','Event '||i,'start','2030-01-01T12:00:00Z') FROM generate_series(1,65) i;
    INSERT INTO kenan_calendar VALUES ('alice','past','{"id":"past","start":"2000-01-01"}'),('alice','deleted','{"id":"deleted","start":"2030-01-01","deleted":true}'),('alice','subscription','{"id":"subscription","start":"2030-01-01","type":"subscription"}'),('other','private','{"id":"private","start":"2030-01-01"}');`);
 });
 afterAll(async()=>{await extension.stop!();await db?.end();});
 it('returns bounded upcoming pages, excludes deleted/subscriptions/other owners, and terminates',async()=>{
  const tool=extension.tool!(ctx);const ids=new Set<string>();let cursor:string|null=null;
  do{const result=await tool.execute('fixture',{action:'list',from:'2029-01-01',to:'2031-01-01',...(cursor?{cursor}:{})},undefined,undefined,{} as any);const page=JSON.parse((result.content[0] as any).text);expect(page.items.length).toBeLessThanOrEqual(20);for(const row of page.items){expect(ids.has(row.id)).toBe(false);ids.add(row.id);}cursor=page.nextCursor;}while(cursor);
  expect(ids.size).toBe(65);expect(ids.has('past')).toBe(false);expect(ids.has('deleted')).toBe(false);expect(ids.has('private')).toBe(false);
 });
});
