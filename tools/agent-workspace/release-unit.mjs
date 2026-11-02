import {boundedCommand} from './bounded-command.mjs';

// UUID workers and full manager identities use root-created system services. Older
// manager launches used the first eight characters ("manager:") in the USER manager.
// Looking for that legacy unit in the system manager said "not-found" while it ran,
// so the foreground release falsely reported a terminal failure with an empty log.
export function releaseUnitCessation(row,{execute=boundedCommand}={}) {
 try {
  const unit=JSON.parse(row.launch_json??'null')?.started;
  if(typeof unit!=='string')return {ceased:false};
  const system=/^kenan-bg-(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|manager:[a-z][a-z0-9-]{0,63})-[-A-Za-z0-9._]{1,60}$/.test(unit);
  const legacy=/^kenan-bg-manager:-[-A-Za-z0-9._]{1,60}$/.test(unit);
  if(!system&&!legacy)return {ceased:false};
  const observed=execute('systemctl',[system?'--system':'--user','show',
   '--property=LoadState','--property=ActiveState','--property=MainPID','--property=ControlPID',unit+'.service'],{encoding:'utf8',timeout:2000});
  if(observed.error||observed.signal||observed.status!==0)return {ceased:false};
  const fields=Object.fromEntries(String(observed.stdout??'').trim().split('\n').map(line=>line.split('=')));
  return {ceased:fields.LoadState==='not-found'||fields.LoadState==='loaded'&&fields.MainPID==='0'&&fields.ControlPID==='0'&&['inactive','failed'].includes(fields.ActiveState)};
 }catch{return {ceased:false};}
}
