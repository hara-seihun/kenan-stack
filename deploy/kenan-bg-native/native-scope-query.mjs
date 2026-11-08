import {boundedCommand} from './bounded-command.mjs';
const env={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LC_ALL:'C',SYSTEMD_COLORS:'0'};
// Root systemctl uses systemd's private socket, which can stall independently of
// the ordinary system bus under concurrent transient-unit construction. Both
// routes read the same root system manager; neither trusts caller-supplied data.
function queryOnce(unit,{execute=boundedCommand,onSecondaryTimeout=()=>{}}={}){
 const primary=execute('/usr/bin/systemctl',['--system','show',unit,'--no-pager','--property=Description,ControlGroup,Transient,ActiveState,User,InvocationID'],{encoding:'utf8',timeout:2000,maxBuffer:8192,env});
 if(primary.status===0&&!primary.error)return primary;
 if(!/^(agent-tool-[a-z][a-z0-9-]*-[a-f0-9-]{36}\.scope|kenan-bg-[a-f0-9-]{36}-[-A-Za-z0-9._]{1,60}\.service)$/.test(unit))return primary;
 const object='/org/freedesktop/systemd1/unit/'+[...unit].map(c=>/[a-zA-Z0-9]/.test(c)?c:'_'+c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
 const values={};
 try{
  for(const kind of ['Unit',unit.endsWith('.scope')?'Scope':'Service']){
   const result=execute('/usr/bin/busctl',['--system','--timeout=1s','--json=short','call','org.freedesktop.systemd1',object,'org.freedesktop.DBus.Properties','GetAll','s','org.freedesktop.systemd1.'+kind],{encoding:'utf8',timeout:1500,maxBuffer:131072,env});
   if(result.status!==0||result.error){if(result.error?.code==='ETIMEDOUT')onSecondaryTimeout();return primary;}
   const parsed=JSON.parse(result.stdout);if(parsed.type!=='a{sv}'||!Array.isArray(parsed.data)||parsed.data.length!==1)throw Error('invalid properties');
   Object.assign(values,parsed.data[0]);
  }
  const string=name=>{if(values[name]?.type!=='s'||typeof values[name].data!=='string'||/[\r\n\x00]/.test(values[name].data))throw Error('invalid string');return values[name].data;};
  if(values.Transient?.type!=='b'||typeof values.Transient.data!=='boolean')throw Error('invalid transient');
  const props={Description:string('Description'),ControlGroup:string('ControlGroup'),ActiveState:string('ActiveState'),Transient:values.Transient.data?'yes':'no'};
  if(unit.endsWith('.service')){
   props.User=string('User');const bytes=values.InvocationID;if(bytes?.type!=='ay'||!Array.isArray(bytes.data)||bytes.data.length!==16||bytes.data.some(x=>!Number.isSafeInteger(x)||x<0||x>255))throw Error('invalid invocation');props.InvocationID=Buffer.from(bytes.data).toString('hex');
  }
  return {status:0,stdout:Object.entries(props).map(([key,value])=>key+'='+value).join('\n')+'\n',stderr:''};
 }catch{return primary;}
}

// Only a timeout can be transient. Retry the exact read once; typed bad or
// foreign metadata is returned to the strict parser unchanged, never retried as
// another identity or replaced with a caller-supplied grant.
export function queryNativeScope(unit,options={}){
 let secondaryTimeout=false;
 const first=queryOnce(unit,{...options,onSecondaryTimeout:()=>{secondaryTimeout=true;}});
 if(!secondaryTimeout||first.error?.code!=='ETIMEDOUT'||!/^(agent-tool-[a-z][a-z0-9-]*-[a-f0-9-]{36}\.scope|kenan-bg-[a-f0-9-]{36}-[-A-Za-z0-9._]{1,60}\.service)$/.test(unit))return first;
 const second=queryOnce(unit,options);return second.status===0&&!second.error?second:first;
}
