import {readFileSync,readlinkSync,readdirSync} from 'node:fs';
import {processAncestry,within} from './safety-census.mjs';

function statFields(pid) {
 const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
 return stat.slice(stat.lastIndexOf(')')+2).split(' ');
}
function identity(pid) {
 const status=readFileSync(`/proc/${pid}/status`,'utf8');
 return {pid,uid:Number(status.match(/^Uid:\s+(\d+)/m)[1]),start:statFields(pid)[19]};
}
// Captured only after normal native release authorization. This is a wait hint,
// not authority or an exemption from any physical safety observation.
// The caller's shell is an ancestor; the other members of its pipeline are not. In
// `cd CHECKOUT; agent-workspace release --path CHECKOUT | tee FILE` the tee is the shell's
// child in this process's own process group, and on November 5 it alone retained a
// released checkout (disk-census-b511) because it was still exiting with the shell. Such
// siblings get the same identity-bound bounded recheck: the worker still re-inspects
// everything and keeps the checkout while any of them is alive.
export function captureReleaseCallers(target) {
 const callers=[],ancestors=new Set(processAncestry());
 const capture=pid=>{
  try {
   const entry=identity(pid);
   if(entry.uid===process.getuid()&&within(target,readlinkSync(`/proc/${pid}/cwd`)))callers.push(entry);
  }catch{} // Missing custody never permits the special retry.
 };
 for(const pid of ancestors) if(pid!==process.pid) capture(pid);
 let group;
 try {group=statFields(process.pid)[2];} catch {return callers;}
 const shells=new Set(callers.map(caller=>String(caller.pid)));
 let entries=[];
 try {entries=readdirSync('/proc').filter(entry=>/^\d+$/u.test(entry));} catch {}
 for(const entry of entries) {
  const pid=Number(entry);
  if(ancestors.has(pid)||pid===process.pid)continue;
  try {
   const fields=statFields(pid);
   if(shells.has(fields[1])&&fields[2]===group)capture(pid);
  }catch{}
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
