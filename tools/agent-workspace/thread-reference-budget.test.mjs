import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {workspaceTesting as t} from './workspace.mjs';
test('thread reference set preserves all protections without correlated history rescans',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'thread-budget-')),file=path.join(root,'threads.sqlite3');
 const db=new DatabaseSync(file);
 try{
  db.exec(`CREATE TABLE thread(id TEXT PRIMARY KEY,cwd TEXT,state TEXT,metadata TEXT); CREATE TABLE thread_work(thread_id TEXT,status TEXT); CREATE TABLE thread_execution(thread_id TEXT,ended_at INTEGER); BEGIN`);
  const insert=db.prepare('INSERT INTO thread VALUES(?,?,?,?)');
  for(let i=0;i<10000;i++){insert.run('t'+i,'/keep/'+i,'finished','{}');db.prepare('INSERT INTO thread_execution VALUES(?,1)').run('t'+i);}
  db.exec(`INSERT INTO thread VALUES ('running','/running','running','{}'),('wait','/wait','finished','{"agentWait":{}}'),('cancel','/cancel','finished','{"cancellationRequest":true}');INSERT INTO thread_work VALUES('t8','pending'),('t9','done'),('t8','pending'),('missing','pending');INSERT INTO thread_execution VALUES('t10',NULL),('t10',NULL); COMMIT`);
  const old=db.prepare(`SELECT t.id,t.cwd FROM thread t WHERE t.state='running' OR json_extract(t.metadata,'$.agentWait') IS NOT NULL OR json_extract(t.metadata,'$.cancellationRequest') IS NOT NULL OR EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=t.id AND w.status!='done') OR EXISTS(SELECT 1 FROM thread_execution e WHERE e.thread_id=t.id AND e.ended_at IS NULL)`).all().map(x=>x.id).sort();
  const actual=t.duringInspection(Date.now()+5000,()=>t.threadSnapshot([file])).map(x=>x.id).sort();
  assert.deepEqual(actual,old);assert.deepEqual(actual,['cancel','running','t10','t8','wait']);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

// Exercise durable progress rather than merely increasing a timeout. Every
// interrupted call must throw, including the one which completed a database.
import {threadSnapshot,withCensusDeadline} from './safety-census.mjs';
import {readFileSync} from 'node:fs';
test('bounded thread scans resume exactly, invalidate mutations, and retain completed databases',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'thread-resume-')),cacheFile=path.join(root,'cache.json');
 const files=[path.join(root,'a.sqlite3'),path.join(root,'b.sqlite3')];
 const dbs=files.map(file=>new DatabaseSync(file));
 try {
  for(const [n,db] of dbs.entries()) {
   db.exec('CREATE TABLE thread(id TEXT PRIMARY KEY,cwd TEXT,state TEXT,metadata TEXT); CREATE TABLE thread_work(thread_id TEXT,status TEXT); CREATE TABLE thread_execution(thread_id TEXT,ended_at INTEGER)');
   const insert=db.prepare('INSERT INTO thread VALUES(?,?,?,?)');
   for(let i=0;i<27;i++)insert.run('t'+i,'/db'+n+'/'+i,i===1?'running':'finished',i===2?' {"agentWait":{}}':i===3?'{"cancellationRequest":false}':'{}');
   db.exec("INSERT INTO thread_work VALUES('t4','pending'),('t4','pending'),('missing','pending'),('t5','done'); INSERT INTO thread_execution VALUES('t6',NULL),('t6',NULL),('t7',1)");
  }
  const options={cacheFile,racyWindowNs:-1_000_000_000n,batchSize:5};
  let pauses=0,result;
  // Simulate process interruption immediately after a durable atomic checkpoint.
  for(let attempt=0;attempt<100;attempt++) {
   try {result=threadSnapshot(files,{...options,onCheckpoint:()=>{pauses++;throw Error('interrupted fixture');}});break;}
   catch(e){assert.equal(e.message,'interrupted fixture');}
  }
  assert.ok(result);assert.ok(pauses>12);
  const expected=files.flatMap((file,n)=>[1,2,3,4,6].map(i=>({id:'t'+i,cwd:'/db'+n+'/'+i,database:file})));
  assert.deepEqual(result,expected);
  const retained=JSON.parse(readFileSync(cacheFile)).entries[files[0]];
  assert.equal(retained.phase,4);
  // A later database mutation must not reuse its earlier complete result.
  dbs[1].exec("UPDATE thread SET state='running' WHERE id='t9'");
  assert.throws(()=>threadSnapshot(files,{...options,onCheckpoint:()=>{throw Error('paused changed database');}}),/paused changed database/);
  assert.deepEqual(JSON.parse(readFileSync(cacheFile)).entries[files[0]],retained);
  const changed=threadSnapshot(files,options);
  assert.ok(changed.some(row=>row.id==='t9'&&row.database===files[1]));
  // A deadline cannot return partially observed protection, even with warm entries.
  assert.throws(()=>withCensusDeadline(Date.now()-1,()=>threadSnapshot(files,options)),/observation budget exhausted/);
 }finally{dbs.forEach(db=>db.close());rmSync(root,{recursive:true,force:true});}
});

test('a database modified within a chunk refuses and discards its checkpoint',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'thread-race-')),file=path.join(root,'db'),cacheFile=path.join(root,'cache');
 const db=new DatabaseSync(file);
 try {
  db.exec("CREATE TABLE thread(id TEXT PRIMARY KEY,cwd TEXT,state TEXT,metadata TEXT); CREATE TABLE thread_work(thread_id TEXT,status TEXT); CREATE TABLE thread_execution(thread_id TEXT,ended_at INTEGER); INSERT INTO thread VALUES('a','/a','finished','{}')");
  db.exec("PRAGMA journal_mode=WAL");
  let first=true;
  assert.throws(()=>threadSnapshot([file],{cacheFile,racyWindowNs:-1_000_000_000n,batchSize:1,onCheckpoint:()=>{if(first){first=false;db.exec("UPDATE thread SET state='running'");}}}),/database changed/);
  assert.equal(JSON.parse(readFileSync(cacheFile)).entries[file],undefined);
  assert.deepEqual(threadSnapshot([file],{cacheFile,racyWindowNs:-1_000_000_000n}),[{id:'a',cwd:'/a',database:file}]);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
