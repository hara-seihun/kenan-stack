import type { CapacityProvider } from '../shared/contract.js';
export function quotaCell(provider: CapacityProvider, hours: number, now: number) {
  const scope=provider.id==='google'?'Gemini':provider.id==='xai'?'All products':'All models';
  const meter=provider.meters.find(m=>m.windowHours===hours&&m.scope===scope);
  const active=provider.accounts.filter(a=>a.enabled);
  const noSession=hours===5&&!meter&&active.length>0&&active.every(a=>/pro/i.test(a.plan??''))&&provider.id==='openai';
  if(!meter)return {meter:null,noSession,at:null,gain:null};
  const readings=active.flatMap(a=>a.meters.filter(m=>m.windowHours===hours&&m.scope===scope).map(m=>({weight:a.weight,m})));
  const denominator=readings.reduce((s,r)=>s+r.weight,0);
  const refill=readings.filter(r=>r.m.percentLeft!==null&&r.m.percentLeft<100&&r.m.resetAt!==null&&r.m.resetAt>now);
  const at=refill.length?Math.min(...refill.map(r=>r.m.resetAt!)):null;
  const gain=at===null||!denominator?null:refill.filter(r=>r.m.resetAt===at).reduce((s,r)=>s+r.weight*(100-r.m.percentLeft!),0)/denominator;
  return {meter,noSession:false,at,gain};
}
