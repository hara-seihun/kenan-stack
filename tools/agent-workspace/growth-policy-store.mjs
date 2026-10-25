import {repriceGrowthReservation,HOUR_MS} from './growth-reprice.mjs';

// The original plan remains immutable under automatic repricing. This small, bounded
// observation journal is separate from leases, source custody and explicit reductions.
export function ensureGrowthPolicyStore(db){db.exec(`CREATE TABLE IF NOT EXISTS workspace_growth_policy(workspace_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)`);}
const valid=(n)=>Number.isSafeInteger(n)&&n>=0;
function read(db,row,plan){
 const saved=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_growth_policy'").get() ? db.prepare('SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?').get(row.id) : undefined;
 if(!saved)return {version:1,planGrowthBytes:plan.growthBytes,samples:[]};
 let state;try{state=JSON.parse(saved.state_json);}catch{return null;}
 if(state?.version!==1||!valid(state.planGrowthBytes)||!Array.isArray(state.samples)||state.samples.length>512)return null;
 let previous=null;
 for(const point of state.samples){
  if(!point||!valid(point.at)||!valid(point.bytes)||previous&&(point.at<previous.at||point.at===previous.at&&point.bytes!==previous.bytes))return null;
  previous=point;
 }
 if(state.restoreAt!==undefined&&!valid(state.restoreAt))return null;
 // An explicit capacity request changed the amount; it is a new original budget.
 if(state.planGrowthBytes!==plan.growthBytes)return {version:1,planGrowthBytes:plan.growthBytes,samples:[]};
 return state;
}
function append(state,sample){
 const samples=[...state.samples];
 if(sample?.ok&&valid(sample.completedAt)&&valid(sample.bytes)){
  const last=samples.at(-1);
  if(!last||last.at!==sample.completedAt||last.bytes!==sample.bytes)samples.push({at:sample.completedAt,bytes:sample.bytes});
 }
 return {...state,samples};
}
export function projectGrowthPolicy(db,row,plan,sample,now=Date.now()){
 const full=(reason)=>({effectiveRemainingBytes:plan.growthBytes,fullReservation:true,reason});
 if(row.state==='creating'||!['source-only','budgeted'].includes(plan.intent)||plan.growthBytes===0||plan.growthLifecycle)return null;
 if(!sample?.ok)return full('measurement-unavailable');
 const state=read(db,row,plan);if(state===null)return full('invalid-policy-state');
 const next=append(state,sample);
 return repriceGrowthReservation({now,createdAt:row.created_at,originalGrowthBytes:plan.growthBytes,
  samples:next.samples,restoreAt:state.restoreAt,completedBaselineBytes:plan.completedAllocationBytes,
  maxSampleAgeMs:15*60_000});
}
export function recordGrowthSample(db,row,plan,sample){
 if(!sample?.ok||row.state==='creating'||!['source-only','budgeted'].includes(plan.intent)||plan.growthLifecycle)return;
 const state=read(db,row,plan);if(state===null)return; // Malformed authority is never silently repaired into credit.
 const next=append(state,sample),cut=sample.completedAt-HOUR_MS;
 // Retain one real anchor before the window and all observations in the window.
 let anchor=-1;for(let i=0;i<next.samples.length;i++)if(next.samples[i].at<=cut)anchor=i;
 if(anchor>0)next.samples=next.samples.slice(anchor);
 // Never discard unaccounted positive growth to manufacture a smaller reservation.
 if(next.samples.length>512){next.samples=[];next.restoreAt=sample.completedAt;}
 db.prepare('INSERT OR REPLACE INTO workspace_growth_policy VALUES(?,?)').run(row.id,JSON.stringify(next));
}
export function restoreGrowthPolicy(db,row,plan,now=Date.now()){
 const state=read(db,row,plan);
 // Explicit admission is the supported way to repair a damaged policy record.
 const next=state??{version:1,planGrowthBytes:plan.growthBytes,samples:[]};next.restoreAt=now;
 db.prepare('INSERT OR REPLACE INTO workspace_growth_policy VALUES(?,?)').run(row.id,JSON.stringify(next));
 return next;
}
