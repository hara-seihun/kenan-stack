import {createHash,randomUUID} from 'node:crypto';
// A submission is custody of work, never proof of physical release. Its original
// authenticated binding is immutable, including across a repeated foreground call.
export function submitRelease({database,record,request,binding,launch,settlement}) {
 database.exec(`CREATE TABLE IF NOT EXISTS workspace_release_submission (
  workspace_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, request_json TEXT NOT NULL,
  binding_json TEXT NOT NULL, unit_name TEXT NOT NULL, state TEXT NOT NULL, launch_json TEXT)`);
 const requestText=JSON.stringify(request);
 let row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(record.id);
 if(row && row.request_json!==requestText)return {ok:false,error:{code:'release-submission-conflict',detail:'Reconcile the original submission before changing its candidate, custodian or release flags.'},requestId:row.request_id};
 if(row && record.state==='released' && settlement.kind==='completed')return {ok:true,action:'already-released',record,releaseSettlement:settlement};
 if(!row){
  const requestId=randomUUID(),name='aw-release-'+createHash('sha256').update(record.id+requestText).digest('hex').slice(0,32);
  database.prepare('INSERT INTO workspace_release_submission VALUES(?,?,?,?,?,?,NULL)').run(record.id,requestId,requestText,JSON.stringify(binding),name,'launch-unknown');
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
