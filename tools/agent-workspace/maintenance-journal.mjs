import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class MaintenanceError extends Error { constructor(code){super(code);this.code=code;} }
const stop=code=>{throw new MaintenanceError(code);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const json=value=>JSON.stringify(value);
export function priorDisposition(file,sha,expectedScope){
 if(!path.isAbsolute(file)||!/^[a-f0-9]{64}$/.test(sha))stop('maintenance-prior-evidence-required');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let body;try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size===0||s.size>262144)stop('maintenance-prior-state-unknown');body=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
 if(createHash('sha256').update(body).digest('hex')!==sha)stop('maintenance-prior-evidence-conflict');
 let value;try{value=JSON.parse(body);}catch{stop('maintenance-prior-state-unknown');}
 if(!value||typeof value!=='object')stop('maintenance-prior-state-unknown');
 // Absence of stdout, absence of a journal, or a failed process is never a disposition.
 if(value.kind==='original-maintenance-retained-evidence-and-source-format-only')stop('maintenance-original-effects-indeterminate');
 if(value.kind!=='maintenance-canonical-reconciliation'||!uuid(value.originalOperationId)||value.state!=='settled'||!Array.isArray(value.effects)||value.effects.length===0)stop('maintenance-prior-state-unknown');
 if(!path.isAbsolute(value.journal??''))stop('maintenance-canonical-journal-required');
 let canonical;
 try{
  canonical=new DatabaseSync(value.journal,{readOnly:true});
  const operation=canonical.prepare('SELECT * FROM maintenance_operation WHERE id=?').get(value.originalOperationId);
  if(!operation||operation.done!==1||canonical.prepare("SELECT id FROM maintenance_effect WHERE operation=? AND state<>'settled' LIMIT 1").get(value.originalOperationId))stop('maintenance-prior-state-unknown');
  if(expectedScope!==undefined&&digest(JSON.parse(operation.binding).scope)!==digest(expectedScope))stop('maintenance-prior-scope-conflict');
  const count=canonical.prepare('SELECT count(*) AS count FROM maintenance_effect WHERE operation=?').get(value.originalOperationId).count;
  if(count!==value.effects.length)stop('maintenance-incomplete-reconciliation');
  const seen=new Set();
  for(const effect of value.effects){
   if(effect.state!=='applied'||typeof effect.effectId!=='string'||seen.has(effect.effectId)||typeof effect.canonicalReceipt!=='string'||!/^[a-f0-9]{64}$/.test(effect.receiptSha256))stop('maintenance-prior-state-unknown');seen.add(effect.effectId);
   const bytes=fs.readFileSync(effect.canonicalReceipt);if(createHash('sha256').update(bytes).digest('hex')!==effect.receiptSha256)stop('maintenance-prior-evidence-conflict');
   const receipt=JSON.parse(bytes),row=canonical.prepare('SELECT * FROM maintenance_effect WHERE operation=? AND id=?').get(value.originalOperationId,effect.effectId);
   if(!row||row.state!=='settled'||receipt.kind!=='maintenance-settled-effect'||receipt.operationId!==value.originalOperationId||receipt.effectId!==effect.effectId||receipt.specDigest!==digest(JSON.parse(row.spec))||receipt.resultDigest!==digest(JSON.parse(row.result)))stop('maintenance-prior-evidence-conflict');
  }
 }catch(error){if(error instanceof MaintenanceError)throw error;stop('maintenance-canonical-journal-unknown');}finally{canonical?.close();}
 return {originalOperationId:value.originalOperationId,sha256:sha};
}
export class MaintenanceJournal {
 constructor(file,operation,binding,{resume=false,now=Date.now,deadline,hook=()=>{}}){
  if(!uuid(operation)||!Number.isFinite(deadline))stop('maintenance-operation-contract-required');
  if(resume){
   if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink())stop('maintenance-journal-unknown');
   let probe;try{probe=new DatabaseSync(file,{readOnly:true});const known=probe.prepare('SELECT binding FROM maintenance_operation WHERE id=?').get(operation);if(!known)stop('maintenance-journal-unknown');if(known.binding!==json(binding))stop('maintenance-operation-identity-conflict');}catch(error){if(error instanceof MaintenanceError)throw error;stop('maintenance-journal-unknown');}finally{probe?.close();}
  }
  this.now=now;this.deadline=deadline;this.hook=hook;this.operation=operation;this.file=file;
  // FULL synchronous SQLite commits are the checkpoints, not final stdout.
  this.db=new DatabaseSync(file);try{this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS maintenance_operation(id TEXT PRIMARY KEY,binding TEXT NOT NULL,cursor TEXT NOT NULL,current TEXT,done INTEGER NOT NULL CHECK(done IN(0,1)));
   CREATE TABLE IF NOT EXISTS maintenance_effect(operation TEXT NOT NULL,id TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('prepared','uncertain','settled')),result TEXT CHECK((state='settled' AND json_valid(result)) OR (state<>'settled' AND result IS NULL)),PRIMARY KEY(operation,id));
   CREATE TABLE IF NOT EXISTS maintenance_frozen(operation TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(operation,id));
   CREATE TABLE IF NOT EXISTS maintenance_record_result(operation TEXT NOT NULL,record TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(operation,record));
   CREATE INDEX IF NOT EXISTS maintain_active ON maintenance_operation(done,id);
   CREATE INDEX IF NOT EXISTS maintain_uncertain ON maintenance_effect(operation,state,id);
   CREATE TABLE IF NOT EXISTS maintenance_event(sequence INTEGER PRIMARY KEY,operation TEXT NOT NULL,effect TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
   CREATE TRIGGER IF NOT EXISTS maintain_insert AFTER INSERT ON maintenance_effect BEGIN INSERT INTO maintenance_event(operation,effect,state,result) VALUES(new.operation,new.id,new.state,new.result); END;
   CREATE TRIGGER IF NOT EXISTS maintain_transition BEFORE UPDATE ON maintenance_effect WHEN old.operation<>new.operation OR old.id<>new.id OR old.spec<>new.spec OR NOT ((old.state='prepared' AND new.state='uncertain') OR (old.state='uncertain' AND new.state='settled')) BEGIN SELECT RAISE(ABORT,'maintenance-invalid-effect-transition'); END;
   CREATE TRIGGER IF NOT EXISTS maintain_update AFTER UPDATE ON maintenance_effect BEGIN INSERT INTO maintenance_event(operation,effect,state,result) VALUES(new.operation,new.id,new.state,new.result); END;`);
  if(this.db.prepare("SELECT id FROM maintenance_effect WHERE state NOT IN('prepared','uncertain','settled') LIMIT 1").get())stop('maintenance-journal-state-unknown');
  const existing=this.db.prepare('SELECT * FROM maintenance_operation WHERE id=?').get(operation);
  const active=this.db.prepare('SELECT id FROM maintenance_operation WHERE done=0 AND id<>? LIMIT 1').get(operation);
  if(active)stop('maintenance-other-operation-unsettled');
  if(existing){if(!resume)stop('maintenance-resume-required');if(existing.binding!==json(binding))stop('maintenance-operation-identity-conflict');}
  else{if(resume)stop('maintenance-journal-unknown');this.check();this.db.prepare('INSERT INTO maintenance_operation VALUES(?,?,?,NULL,0)').run(operation,json(binding),'');}
  }catch(error){this.db.close();throw error;}
 }
 check(reserve=250){if(this.now()+reserve>=this.deadline)stop('maintenance-checkpoint-budget-exhausted');}
 remaining(){this.check();return Math.max(1,Math.min(2000,this.deadline-this.now()-250));}
 row(){return this.db.prepare('SELECT * FROM maintenance_operation WHERE id=?').get(this.operation);}
 freeze(id,produce){const row=this.db.prepare('SELECT value FROM maintenance_frozen WHERE operation=? AND id=?').get(this.operation,id);if(row)return JSON.parse(row.value);this.check();const value=produce();const text=json(value);if(text.length>1048576)stop('maintenance-frozen-input-bound');this.check();this.db.prepare('INSERT INTO maintenance_frozen VALUES(?,?,?)').run(this.operation,id,text);return value;}
 effect(spec,execute){
  this.check();const id=digest(spec),encoded=json(spec);let row=this.db.prepare('SELECT * FROM maintenance_effect WHERE operation=? AND id=?').get(this.operation,id);
  if(row&&!['prepared','uncertain','settled'].includes(row.state))stop('maintenance-journal-state-unknown');
  if(row&&row.spec!==encoded)stop('maintenance-effect-identity-conflict');
  if(row?.state==='settled')return JSON.parse(row.result);
  if(row?.state==='uncertain')stop('maintenance-effect-outcome-unknown');
  const unknown=this.db.prepare("SELECT id FROM maintenance_effect WHERE operation=? AND state='uncertain' LIMIT 1").get(this.operation);if(unknown)stop('maintenance-reconciliation-required');
  if(!row){this.db.prepare("INSERT INTO maintenance_effect VALUES(?,?,?,'prepared',NULL)").run(this.operation,id,encoded);this.hook('prepared',spec);}
  this.check();this.db.prepare("UPDATE maintenance_effect SET state='uncertain' WHERE operation=? AND id=? AND state='prepared'").run(this.operation,id);this.hook('uncertain',spec);
  // Even a thrown syscall or nonzero child can have partial effects. Leave it uncertain.
  const result=execute();this.hook('effect-returned',spec);const resultText=json(result??null);if(resultText.length>262144)stop('maintenance-result-bound');this.check();
  this.db.prepare("UPDATE maintenance_effect SET state='settled',result=? WHERE operation=? AND id=? AND state='uncertain'").run(resultText,this.operation,id);this.hook('settled',spec);return result;
 }
 unknown(){return this.db.prepare("SELECT id,spec FROM maintenance_effect WHERE operation=? AND state='uncertain' ORDER BY id LIMIT 128").all(this.operation).map(row=>({...row,spec:JSON.parse(row.spec)}));}
 reconcile(observe){
  for(const row of this.unknown()){this.check();const result=observe(row.spec);if(result?.kind!=='applied'||!result.evidence)stop('maintenance-effect-outcome-unknown');this.check();this.db.prepare("UPDATE maintenance_effect SET state='settled',result=? WHERE operation=? AND id=? AND state='uncertain'").run(json(result.result??null),this.operation,row.id);this.db.prepare('INSERT INTO maintenance_event(operation,effect,state,result) VALUES(?,?,?,?)').run(this.operation,row.id,'canonical-postcondition-observed',json(result.evidence));}
  return this.status();
 }
 run({next,inspect,execute,maxRecords}){
  if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>32)stop('maintenance-record-bound-required');
  if(this.unknown().length)stop('maintenance-reconciliation-required');
  let count=0;
  while(count<maxRecords){this.check();let row=this.row();if(row.done)return this.status();let current=row.current&&JSON.parse(row.current);
   if(!current){current=next(row.cursor);if(!current){this.check();this.db.prepare('UPDATE maintenance_operation SET done=1 WHERE id=?').run(this.operation);return this.status();}this.check();this.db.prepare('UPDATE maintenance_operation SET current=? WHERE id=?').run(json(current),this.operation);this.hook('record-prepared',current);}
   const currentBinding=digest(current);this.check();inspect(current);this.check();const result=execute(current,this);this.check();
   this.db.exec('BEGIN IMMEDIATE');try{
    this.db.prepare('INSERT INTO maintenance_record_result VALUES(?,?,?)').run(this.operation,current.id,json(result??null));
    this.db.prepare('UPDATE maintenance_operation SET cursor=?,current=NULL WHERE id=? AND current=?').run(current.id,this.operation,json(current));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}this.hook('record-checkpoint',current);count++;
   if(currentBinding!==digest(current))stop('maintenance-record-identity-conflict');
  }
  return this.status();
 }
 status(){const row=this.row();return {kind:'maintenance-checkpoint',operationId:this.operation,journal:this.file,state:row.done?'settled':this.unknown().length?'uncertain':'checkpointed',cursor:row.cursor,current:row.current?JSON.parse(row.current).id:null,unsettled:this.unknown().map(row=>row.id),results:this.db.prepare('SELECT result FROM maintenance_record_result WHERE operation=? ORDER BY record DESC LIMIT 32').all(this.operation).map(row=>JSON.parse(row.result)).filter(value=>value!==null)};}
 close(){this.db.close();}
}
