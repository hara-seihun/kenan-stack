import {readFileSync,readlinkSync} from 'node:fs';
import {processAncestry,within} from './safety-census.mjs';

function identity(pid) {
 const status=readFileSync(`/proc/${pid}/status`,'utf8');
 const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
 return {pid,uid:Number(status.match(/^Uid:\s+(\d+)/m)[1]),start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};
}
// Captured only after normal native release authorization. This is a wait hint,
// not authority or an exemption from any physical safety observation.
export function captureReleaseCallers(target) {
 const callers=[];
 for(const pid of processAncestry()) {
  if(pid===process.pid)continue;
  try {
   const entry=identity(pid);
   if(entry.uid===process.getuid()&&within(target,readlinkSync(`/proc/${pid}/cwd`)))callers.push(entry);
  }catch{} // Missing custody never permits the special retry.
 }
 return callers;
}
export function transientReleaseCaller(receipt,callers=[]) {
 const items=Array.isArray(receipt)?receipt:[receipt];
 const transient=item=>{
  const i=item?.inspection;
  if(i?.classification!=='referenced'||i.sourceRetention||i.currentStackQueueProtected||
     !Array.isArray(i.processes)||!i.processes.length||i.containers?.length||i.systemdUnits?.length)return false;
  return i.processes.every(ref=>{
   const captured=callers.find(c=>c.pid===ref.pid);
   if(!captured||!Array.isArray(ref.matches)||!ref.matches.length||!ref.matches.every(m=>m.startsWith('cwd:')))return false;
   try {const current=identity(ref.pid);return current.uid===captured.uid&&current.start===captured.start;}
   catch(error){return error.code==='ENOENT';} // Exit is exactly the condition being awaited.
  });
 };
 const settled=item=>item?.physicalDisposition?.kind==='removed'||item?.action==='released'||item?.record?.state==='released';
 return items.some(transient)&&items.every(item=>transient(item)||settled(item));
}
