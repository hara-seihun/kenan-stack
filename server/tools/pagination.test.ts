import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createStore, type PgStore } from '../db/store.js';
import { freshSchema, testDatabaseUrl } from '../db/test-db.js';
import { arrayPage, pageKey, pageSize } from './pagination.js';
import { controlTools } from './control.js';

it('bounds every page, validates requests, and binds cursors to filters', () => {
  expect(pageSize()).toBe(20);
  for (const limit of [0,51,1.5,NaN]) expect(() => pageSize(limit)).toThrow();
  const rows=Array.from({length:2500},(_,i)=>({id:String(i).padStart(5,'0')}));
  const first=arrayPage(rows,{},'scope',r=>r.id);
  expect(first.items).toHaveLength(20);expect(first.nextCursor).toBeTruthy();
  expect(arrayPage(rows,{cursor:first.nextCursor!},'scope',r=>r.id).items[0]?.id).toBe('00020');
  expect(()=>pageKey(first.nextCursor!,'different')).toThrow();expect(()=>pageKey('garbage','scope')).toThrow();
});

describe.skipIf(!testDatabaseUrl)('bounded tool lists over real PostgreSQL',()=>{
  let store:PgStore,db:pg.Client;
  beforeAll(async()=>{
    const url=await freshSchema('t_pagination');store=createStore(url);await store.migrate();db=new pg.Client({connectionString:url});await db.connect();
    await store.upsertPerson({id:'alice',name:'Alice',kind:'human'});
    await store.upsertPerson({id:'other',name:'Other',kind:'human'});
    await db.query(`INSERT INTO goal(id,owner_id,title,status,priority,created_at,updated_at) SELECT md5('g'||i)::uuid,'alice','Goal '||i,CASE WHEN i<=40 THEN 'open' ELSE 'done' END,i%3,100,100 FROM generate_series(1,70) i;
      INSERT INTO person(id,name,kind,created_at) SELECT 'w'||i,'Worker '||i,'agent',100 FROM generate_series(1,2500) i;
      INSERT INTO agent(id,owner_id,role,conversation_id,goal_id,state,model,session_path,created_at,updated_at,last_report)
      SELECT 'w'||i,CASE WHEN i=2500 THEN 'other' ELSE 'alice' END,'worker',md5('c'||i)::uuid,md5('g1')::uuid,CASE WHEN i<=25 THEN 'running' WHEN i<=40 THEN 'idle' ELSE 'stopped' END,'m','/tmp/fixture',100,100,jsonb_build_object('status','done','text',repeat('x',20000),'at',100) FROM generate_series(1,2500) i;`);
  });
  afterAll(async()=>{await store?.close();await db?.end();});
  it('omits stopped workers by initial filter; pages all 2499 owned workers exactly once',async()=>{
    const initial=await store.listWorkersPage('alice',{});expect(initial.items).toHaveLength(20);expect(initial.items.every(w=>w.state==='running')).toBe(true);
    const seen=new Set<string>();let cursor:string|null=null;let stopped=false;
    do {const page=await store.listWorkersPage('alice',{state:'all',limit:50,...(cursor?{cursor}:{})});expect(page.items.length).toBeLessThanOrEqual(50);for(const row of page.items){expect(seen.has(row.id)).toBe(false);if(row.state==='stopped')stopped=true;else expect(stopped).toBe(false);expect(row.ownerId).toBe('alice');seen.add(row.id);}cursor=page.nextCursor;}while(cursor);
    expect(seen.size).toBe(2499);
    expect((await store.listWorkersPage('alice',{state:'stopped',limit:1})).items[0]?.state).toBe('stopped');
    expect((await store.listWorkersPage('alice',{goalId:'00000000-0000-0000-0000-000000000000'})).items).toEqual([]);
    await expect(store.listWorkersPage('alice',{state:'all',cursor:initial.nextCursor!})).rejects.toThrow('filters');
  });
  it('paginates open goals by priority with deterministic ties; summarizes worker counts',async()=>{
    const seen=new Set<string>();let cursor:string|null=null,prior=-Infinity;
    do{const page=await store.listGoalsPage('alice',{limit:7,...(cursor?{cursor}:{})});for(const g of page.items){expect(g.status).toBe('open');expect(g.priority).toBeGreaterThanOrEqual(prior);prior=g.priority;expect(seen.has(g.id)).toBe(false);expect('workerIds' in g).toBe(false);seen.add(g.id);}cursor=page.nextCursor;}while(cursor);
    expect(seen.size).toBe(40);expect((await store.listGoalsPage('alice',{status:'done'})).items).toHaveLength(20);
  });
  it('tool result is bounded and marks truncated report content',async()=>{
    const tools=controlTools({person:{id:'alice'},agent:{role:'manager'},deps:{store,now:()=>Date.now()}} as any,{} as any);
    const workerResult=await tools.find(t=>t.name==='workers')!.execute('fixture',{action:'list'},undefined,undefined,{} as any);
    const page=JSON.parse((workerResult.content[0] as any).text);
    expect(page.items.length).toBe(20);expect(page.items[0].lastReport.text.length).toBe(500);expect(page.items[0].lastReport.truncated).toBe(true);
    expect(JSON.stringify(page).length).toBeLessThan(22000);expect(page.nextCursor).toBeTruthy();
  });
  it('goals get and update take the 8-character id prefix agents quote, and refuse an ambiguous one',async()=>{
    const goals=controlTools({person:{id:'alice'},agent:{role:'manager'},deps:{store,bus:{toPerson(){},toConversation(){}}}} as any,{} as any).find(t=>t.name==='goals')!;
    const call=async(args:object)=>JSON.parse(((await goals.execute('fixture',args,undefined,undefined,{} as any)).content[0] as any).text);
    const [goal]=(await store.listGoals('alice')).slice(-1);
    expect((await call({action:'get',id:goal!.id.slice(0,8)})).id).toBe(goal!.id);
    expect((await call({action:'update',id:goal!.id.slice(0,8).toUpperCase(),notes:'2026-10-21 08:00Z — by prefix',replaceNotes:true})).notes).toBe('2026-10-21 08:00Z — by prefix');
    await expect(call({action:'update',id:goal!.id,notes:'one line'})).rejects.toThrow(/notes_replace_unconfirmed/);
    expect((await call({action:'update',id:goal!.id,appendNote:'moved'})).notes).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z — moved\n2026-10-21 08:00Z — by prefix$/);
    await db.query(`INSERT INTO goal(id,owner_id,title,status,priority,created_at,updated_at) VALUES ('abcdef01-0000-4000-8000-000000000001','alice','A','open',1,100,100),('abcdef01-0000-4000-8000-000000000002','alice','B','open',1,100,100)`);
    await expect(call({action:'get',id:'abcdef01'})).rejects.toThrow('ambiguous');
    await expect(call({action:'get',id:'abcdef0'})).rejects.toThrow('Goal not found');
  });
});
