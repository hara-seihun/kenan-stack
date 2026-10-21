import fs from 'node:fs';
export function liveGroupMembers(pgid) {
 const members=[];
 for(const name of fs.readdirSync('/proc')) {
  if(!/^\d+$/.test(name))continue;
  let stat;try{stat=fs.readFileSync(`/proc/${name}/stat`,'utf8');}catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
  const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  if(fields.length<20||!/^\d+$/.test(fields[2]))throw Error('checkout-cessation-unknown: malformed process stat');
  if(Number(fields[2])===pgid&&!['Z','X'].includes(fields[0]))members.push(Number(name));
 }
 return members;
}
export async function ceaseCheckoutGroup(pgid,budgetMs=2000) {
 if(!Number.isSafeInteger(pgid)||pgid<1)throw Error('checkout-cessation-unknown: invalid owned group');
 try{process.kill(-pgid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
 const deadline=Date.now()+budgetMs;
 do {
  if(liveGroupMembers(pgid).length===0)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }while(Date.now()<deadline);
 throw Error('checkout-cessation-unknown: live owned group; private staging retained');
}
