import fs from 'node:fs';
import {nativeCaller, nativeOwnerBinding, admissionReceipts, authenticateToolCalls, receiptBinding} from './native-owner.mjs';
import {OWNER_AGENT_ID,NATIVE_CUSTODIAN_ID} from './owner-liveness.mjs';
import {serverChannel} from './cache-queue.mjs';

const refused = (code, detail) => ({ok:false, error:{code, detail}});

// A failed native identity observation must not turn into the historical operator route.
// Neither argv flags nor environment variables select that route.
export function releaseCaller({caller=nativeCaller, pid=process.pid,
  cgroup=p=>fs.readFileSync(`/proc/${p}/cgroup`,'utf8'),
  argv=p=>fs.readFileSync(`/proc/${p}/cmdline`,'utf8').split('\0'),
  parent=p=>{const stat=fs.readFileSync(`/proc/${p}/stat`,'utf8');return Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);}}={}) {
  try {
    let diagnostic;
    const binding=caller({onError:error=>{diagnostic=error;}});
    if(binding!==null)return {ok:true, kind:'native', binding};
    for(let current=pid, depth=0;current>1&&depth<64;depth++) {
      if(cgroup(current).includes('/agent-tool-')||/\/kenan-bg-(?:[a-f0-9]{8}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})-/.test(cgroup(current))||serverChannel(argv(current))!==null)
        return {...refused('release-caller-unverified','The native tool context exists, but its authenticated caller identity is unavailable.'+(diagnostic?` ${diagnostic.code}: ${diagnostic.detail}`:'')),...(diagnostic?{diagnostic}: {})};
      const up=parent(current);
      if(!Number.isSafeInteger(up)||up<1||up===current)
        return refused('release-caller-unverified','The caller ancestry is incomplete.');
      current=up;
      if(current===1)return {ok:true,kind:'operator'};
    }
    return refused('release-caller-unverified','The caller ancestry observation exceeded its bound.');
  } catch(error) {return refused('release-caller-unverified',String(error.message));}
}

function ownerOf(database,record,statePath,deadline,authenticate) {
  if(NATIVE_CUSTODIAN_ID.test(record.owner))return {ok:true,agentId:record.owner,channel:null};
  const binding=nativeOwnerBinding(database,record.id);
  if(binding.state==='set')return {ok:true,agentId:binding.agentId,channel:binding.channel};
  const request=database.prepare('SELECT creation_request FROM workspace WHERE id=?').get(record.id)?.creation_request;
  const receipt=admissionReceipts(statePath,record.id,request,{deadline});
  if(receipt.kind==='none')return {ok:true,agentId:null,channel:null};
  if(receipt.kind==='invalid')return refused('release-owner-unverified',`${record.id}: ${receipt.code}`);
  const result=receiptBinding(receipt,authenticate(receipt.pairs,{deadline}));
  return result.kind==='bindable'?{ok:true,agentId:result.binding.agentId,channel:result.binding.channel}:
    refused('release-owner-unverified',`${record.id}: ${result.code}`);
}

// This observation is read-only. In particular it never binds an admission receipt, drops a
// lease, starts a release journal or changes the checkout on a rejected request.
export function authorizeWorkspaceRelease(database,records,statePath,{caller=releaseCaller,authenticate=authenticateToolCalls,
  deadline=Date.now()+30000}={}) {
  const self=caller();
  if(!self.ok)return self;
  if(self.kind==='operator')return {ok:true,kind:'operator'};
  if(self.kind!=='native'||!NATIVE_CUSTODIAN_ID.test(self.binding?.agentId??''))
    return refused('release-caller-unverified','An authenticated native caller is required.');
  const binding=self.binding;
  const authentication=authenticate([binding],{deadline});
  const channels=authentication.confirmed.get(binding.agentId+'\0'+binding.callId)??[];
  if(authentication.errors.length||channels.length!==1||channels[0]!==binding.channel) {
    const code=authentication.errors.length?'caller-tool-store-unavailable':channels.length===0?'caller-tool-unconfirmed':channels.length>1?'caller-tool-channel-ambiguous':'caller-tool-channel-mismatch';
    // Keep the first bounded error line, not SQL context, quoted values or the private identity.
    const errors=authentication.errors.slice(0,16).map(error=>String(error).split(/[\r\n]/)[0]
      .replaceAll(binding.agentId,'[agent]').replaceAll(binding.callId,'[call]')
      .replace(/['"][^'"\r\n]*['"]/g,'[value]').replace(/[\x00-\x1f\x7f]/g,'').slice(0,350));
    return {...refused('release-caller-unverified',`The exact caller tool call is not uniquely authenticated in its native store (${code}; ${channels.length} channels).`),
      diagnostic:{code,channelCount:channels.length,errors}};
  }
  for(const record of records) {
    const owner=ownerOf(database,record,statePath,deadline,authenticate);
    if(!owner.ok)return owner;
    if(owner.agentId===null)return refused('release-owner-unbound',`${record.id}: This checkout has no authenticated native custodian. Use an explicit transfer by the existing non-native operator before releasing it.`);
    if(owner.agentId!==binding.agentId||owner.channel!==null&&owner.channel!==binding.channel)
      return refused('release-owner-mismatch',`${record.id}: The native caller ${binding.agentId} does not own this checkout; its custodian is ${owner.agentId}.`);
  }
  return {ok:true,kind:'native',binding};
}
