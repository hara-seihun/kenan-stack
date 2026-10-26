import {createHash,randomUUID} from 'node:crypto';
// A submission is custody of work, never proof of physical release. Its original
// authenticated binding is immutable, including across a repeated foreground call.
export function submitRelease({database,record,request,binding,launch,settlement,observe=()=>({ceased:false})}) {
 database.exec(`CREATE TABLE IF NOT EXISTS workspace_release_submission (
  workspace_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, request_json TEXT NOT NULL,
  binding_json TEXT NOT NULL, unit_name TEXT NOT NULL, state TEXT NOT NULL, launch_json TEXT)`);
 const columns=database.prepare('PRAGMA table_info(workspace_release_submission)').all();
 for(const column of ['terminal_json','continuations_json'])if(!columns.some(c=>c.name===column))database.exec(`ALTER TABLE workspace_release_submission ADD COLUMN ${column} TEXT`);
 const requestText=JSON.stringify(request);
 let row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(record.id);
 if(row && row.request_json!==requestText)return {ok:false,error:{code:'release-submission-conflict',detail:'Reconcile the original submission before changing its candidate, custodian or release flags.'},requestId:row.request_id};
 if(row && record.state==='released' && settlement.kind==='completed')return {ok:true,action:'already-released',record,releaseSettlement:settlement};
 let continueKnown=false;
 if(row?.state==='terminal-known')continueKnown=observe(row).ceased===true;
 if(!row||continueKnown){
  const requestId=row?.request_id??randomUUID(),name=row?.unit_name??'aw-release-'+createHash('sha256').update(record.id+requestText).digest('hex').slice(0,32);
  if(!row)database.prepare('INSERT INTO workspace_release_submission(workspace_id,request_id,request_json,binding_json,unit_name,state,launch_json) VALUES(?,?,?,?,?,?,NULL)').run(record.id,requestId,requestText,JSON.stringify(binding),name,'launch-unknown');
  else {
   const history=JSON.parse(row.continuations_json??'[]');history.push({priorTerminal:JSON.parse(row.terminal_json),binding,continuedAt:Date.now()});
   database.prepare("UPDATE workspace_release_submission SET state='launch-unknown',terminal_json=NULL,continuations_json=? WHERE workspace_id=? AND request_id=?").run(JSON.stringify(history),record.id,requestId);
  }
  row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(record.id);
  // The durable reservation precedes detachment. A lost launch response is never retried blindly.
  let result;
  try {result=launch(name,requestId);}catch(error){result={ok:false,code:'release-launch-outcome-unknown',detail:error.code??error.name};}
  database.prepare('UPDATE workspace_release_submission SET state=?,launch_json=? WHERE workspace_id=? AND request_id=?')
   .run(result?.started?'submitted':'launch-unknown',JSON.stringify(result),record.id,requestId);
  row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(record.id);
 }
 return {ok:true,action:'release-submitted',completed:false,state:row.state,requestId:row.request_id,
  workspaceId:record.id,unitName:row.unit_name,originalBinding:JSON.parse(row.binding_json),launch:JSON.parse(row.launch_json??'null'),
  releaseSettlement:settlement,nextAction:{observe:['agent-workspace','status','--id',record.id,'--json'],settleInAuthenticatedBackground:['agent-workspace','release','--id',record.id,...request.flags.flatMap(([key,values])=>values.map(value=>`--${key}=${value}`)),'--json'],
   continuation:'If the recorded unit ended without a completed settlement, reconcile its log and original journal, then use that journal\'s exact settlement command in an authenticated background call.'}};
}
