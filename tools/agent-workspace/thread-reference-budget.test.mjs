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
