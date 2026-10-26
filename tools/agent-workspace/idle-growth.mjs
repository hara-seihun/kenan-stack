// Allocation stability is not last-write evidence. A complete same-root tree
// observation must separately bound every inode's mtime AND ctime.
import {GrowthLifecycleError} from './growth-lifecycle.mjs';
const refuse=(code,message)=>{throw new GrowthLifecycleError(code,message);};
export function assertIdleGrowth({record,plan,sample,history,safety,planSha256,now=Date.now()}) {
 if(!['active','referenced','blocked','repair-required'].includes(record.state)||!['source-only','budgeted'].includes(plan.intent)||plan.growthLifecycle||!(plan.growthBytes>0))refuse('idle-growth-ineligible','No outstanding priced future growth.');
 if(!Array.isArray(safety?.references)||!Array.isArray(safety?.errors)||safety.errors.length||safety.references.length)refuse('idle-growth-active','A process, unit, writer, borrower or unknown execution remains.');
 const bound=history?.allocationBinding;
 if(!sample?.ok||sample.writeObservationComplete===false||sample.partial||sample.rootPath!==record.path||sample.planSha256!==planSha256||!bound||['rootPath','planSha256','device','inode'].some(k=>bound[k]!==sample[k])||!Number.isSafeInteger(sample.startedAt)||!Number.isSafeInteger(sample.completedAt)||sample.startedAt>sample.completedAt||sample.completedAt>now||now-sample.startedAt>15*60000)refuse('idle-growth-sample-required','A fresh complete identity-bound observation is required.');
 const points=history.samples?.slice(-2);
 if(history.planGrowthBytes!==plan.growthBytes||!points||points.length!==2||!points.every(p=>Number.isSafeInteger(p.at)&&Number.isSafeInteger(p.bytes)&&p.bytes>=0)||points[0].at>=points[1].at||points[1].at!==sample.completedAt||points[1].bytes!==sample.bytes||points[1].bytes!==points[0].bytes)refuse('idle-growth-unstable','The last two real allocation samples must be stable.');
 if(!Number.isSafeInteger(sample.lastWriteAt)||sample.lastWriteAt<0||sample.lastWriteAt>sample.completedAt||now-Math.max(sample.lastWriteAt,record.createdAt,history.restoreAt??0)<=3600000)refuse('idle-growth-recent-write','Actual tree mtime and ctime, creation and resumed admission must be more than one hour old.');
 return {lastWriteAt:sample.lastWriteAt,samples:points,observedAt:now};
}

export function assertIdleObservation(expected,current) {
 if(!current?.ok||current.writeObservationComplete===false||['device','inode','bytes','allocatedBytes','lastWriteAt'].some(k=>expected[k]!==current[k]))refuse('idle-growth-write-race','The complete last-write, allocation or root observation changed; retain the original promise.');
}
