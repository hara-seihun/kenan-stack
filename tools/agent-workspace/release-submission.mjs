import {createHash,randomUUID} from 'node:crypto';
// A submission is custody of work, never proof of physical release. Its original
// authenticated binding is immutable, including across a repeated foreground call.
export function submitRelease({database,record,request,binding,launch,settlement,observe=()=>({ceased:false}),custodyLineage=[]}) {
 database.exec(`CREATE TABLE IF NOT EXISTS workspace_release_submission (
  workspace_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, request_json TEXT NOT NULL,
  binding_json TEXT NOT NULL, unit_name TEXT NOT NULL, state TEXT NOT NULL, launch_json TEXT)`);
 const columns=database.prepare('PRAGMA table_info(workspace_release_submission)').all();
 for(const column of ['terminal_json','continuations_json'])if(!columns.some(c=>c.name===column))database.exec(`ALTER TABLE workspace_release_submission ADD COLUMN ${column} TEXT`);
 const requestText=JSON.stringify(request);
 let row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(record.id);
 if(row && record.state==='released' && settlement.kind==='completed')return {ok:true,action:'already-released',record,releaseSettlement:settlement};
 const originalRequest=row?(JSON.parse(row.continuations_json??'[]').at(-1)?.request??JSON.parse(row.request_json)):null;
 // A completed, retained ordinary release may safely continue with the documented
 // non-destructive runtime-preservation flag. Preserve original custody and wait
 // for its exact worker to cease before admitting that linked continuation.
 const preservingContinuation=row && row.state==='terminal-known' && settlement.kind==='completed' &&
  settlement.result?.physicalDisposition?.kind==='retained' &&
  JSON.stringify({...originalRequest,flags:undefined})===JSON.stringify({...request,flags:undefined}) &&
  !originalRequest.flags.some(([key])=>key==='preserve-runtime') &&
  JSON.stringify(request.flags)===JSON.stringify([...originalRequest.flags,['preserve-runtime',['true']]].sort(([a],[b])=>a.localeCompare(b))) &&
  observe(row).ceased===true;
 // Custody adopted from an ended owner (release-ended-owners) continues that owner's
 // submission: same request identity and unit history, new authenticated custodian. Only
 // after the original unit ceased with a known launch, and never over an unsettled physical
 // transition; the original binding stays immutable and the prior request is kept in history.
 const lineage=new Set(custodyLineage);
 const adoptedContinuation=Boolean(row && !preservingContinuation && JSON.stringify(originalRequest)!==requestText &&
  ['submitted','terminal-known'].includes(row.state) && settlement.kind!=='owned-retention' &&
  request.owner===record.owner && binding.agentId===record.owner && originalRequest.owner!==record.owner &&
  lineage.has(record.owner) && lineage.has(originalRequest.owner) && lineage.has(JSON.parse(row.binding_json).agentId) &&
  JSON.stringify({...originalRequest,owner:undefined,flags:undefined})===JSON.stringify({...request,owner:undefined,flags:undefined}) &&
  observe(row).ceased===true);
 if(row && JSON.stringify(originalRequest)!==requestText && !preservingContinuation && !adoptedContinuation)return {ok:false,error:{code:'release-submission-conflict',detail:'Reconcile the original submission before changing its candidate, custodian or release flags.'},requestId:row.request_id,
  nextAction:{observe:['agent-workspace','status','--id',record.id,'--json'],
   settleInAuthenticatedBackground:['env','KENAN_BG_IDENTITY=1','kenan-bg','workspace-release-continuation','--','agent-workspace','release','--id',record.id,...request.flags.flatMap(([key,values])=>values.map(value=>`--${key}=${value}`)),'--json'],
   continuation:'After reconciling the original terminal effect, the authenticated current custodian may settle retained disposal in this background route. Normal custody and physical safety checks still apply; this does not replace the original submission or settlement.'}};

 // A successful retry must return its new settled result, not replay a launch or
 // expose the pre-continuation capacity refusal as the current settlement.
 if(row?.state==='terminal-known' && JSON.stringify(originalRequest)===requestText &&
    JSON.parse(row.terminal_json??'{}').exitCode===0 && settlement.kind==='completed' &&
    settlement.result?.futureGrowthSettlement?.kind==='retired')
  return {ok:true,action:'release-completed',completed:true,requestId:row.request_id,
   workspaceId:record.id,result:settlement.result,releaseSettlement:settlement};
 let launchedNow=false;
 let continueKnown=false;
 if(adoptedContinuation)continueKnown=true;
 else if(row?.state==='terminal-known')continueKnown=observe(row).ceased===true;
 if(!row||continueKnown){
  const requestId=row?.request_id??randomUUID(),name=row?.unit_name??'aw-release-'+createHash('sha256').update(record.id+requestText).digest('hex').slice(0,32);
  if(!row)database.prepare('INSERT INTO workspace_release_submission(workspace_id,request_id,request_json,binding_json,unit_name,state,launch_json) VALUES(?,?,?,?,?,?,NULL)').run(record.id,requestId,requestText,JSON.stringify(binding),name,'launch-unknown');
  else {
   const history=JSON.parse(row.continuations_json??'[]');history.push({priorTerminal:JSON.parse(row.terminal_json??'null')??{state:row.state,ceased:true},binding,request,continuedAt:Date.now(),...(adoptedContinuation?{custodyAdoptedFrom:originalRequest.owner}:{})});
   database.prepare("UPDATE workspace_release_submission SET state='launch-unknown',terminal_json=NULL,continuations_json=? WHERE workspace_id=? AND request_id=?").run(JSON.stringify(history),record.id,requestId);
  }
  row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(record.id);
  // The durable reservation precedes detachment. A lost launch response is never retried blindly.
  launchedNow=true;
  let result;
  try {result=launch(name,requestId);}catch(error){result={ok:false,code:'release-launch-outcome-unknown',detail:error.code??error.name};}
  database.prepare('UPDATE workspace_release_submission SET state=?,launch_json=? WHERE workspace_id=? AND request_id=?')
   .run(result?.started?'submitted':'launch-unknown',JSON.stringify(result),record.id,requestId);
  row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(record.id);
 }
 return {ok:true,action:'release-submitted',completed:false,state:row.state,requestId:row.request_id,
  workspaceId:record.id,unitName:row.unit_name,originalBinding:JSON.parse(row.binding_json),launch:JSON.parse(row.launch_json??'null'),
  ...(launchedNow?{previousReleaseSettlement:settlement}:{releaseSettlement:settlement}),nextAction:{observe:['agent-workspace','status','--id',record.id,'--json'],settleInAuthenticatedBackground:['agent-workspace','release','--id',record.id,...request.flags.flatMap(([key,values])=>values.map(value=>`--${key}=${value}`)),'--json'],
   continuation:'If the recorded unit ended without a completed settlement, reconcile its log and original journal, then use that journal\'s exact settlement command in an authenticated background call.'}};
}
