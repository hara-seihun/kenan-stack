import type { CapacityAccount, CapacityBalance, CapacityMeter, CapacityProvider, PlanCosts, UsagePlan } from '../../shared/contract.js';

const freshMs = 15 * 60_000;
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const date = (v: unknown): number | null => typeof v === 'number' ? number(v) : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const providerId = (id: string) => ({ 'openai-codex': 'openai', 'google-cli': 'google', grok: 'xai' }[id] ?? id);
const names: Record<string, string> = { anthropic: 'Claude', openai: 'Codex', google: 'Google · Antigravity', xai: 'Grok', nvidia: 'NVIDIA', openrouter: 'OpenRouter' };
const sources: Record<string, string> = { anthropic: 'Claude OAuth usage', openai: 'Codex usage', google: 'Antigravity native quota', xai: 'Grok subscription billing', nvidia: 'NVIDIA free route', openrouter: 'OpenRouter free route' };
export const meterSources: Record<string, string> = { anthropic: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work', openai: 'https://learn.chatgpt.com/docs/pricing', google: 'https://antigravity.google/docs/plans', xai: 'https://docs.x.ai/grok/faq', nvidia: 'https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317', openrouter: 'https://openrouter.ai/collections/free-models' };

const rules: Record<string,string> = {
  anthropic: 'Session and weekly limits apply independently. Verified Ultra accounts may have no session limit; Fable can have a separate weekly limit. Only reported windows are shown.',
  openai: 'Included limits and prepaid credits are separate. Pro has no five-hour limit; the account’s actual reported windows determine these meters.',
  google: 'Native Antigravity reports remaining quota and reset times per model. Models can have different allowances; only provider-reported windows are shown.',
  xai: 'The weekly allowance is shared across Grok products. Prepaid balance is shown separately from the included allowance.',
  nvidia: 'The request counter is the live 60-second admission window enforced by our broker. NVIDIA does not return an upstream quota counter in its response headers.',
  openrouter: 'Spending comes directly from OpenRouter’s key API. This key has a lifetime zero-dollar paid-spend cap; that does not block the free model. The deprecated rate-limit field is not treated as a quota.'
};
/** Actual windows, not the broker's effective-headroom aliases. Percentages never become credits or dollars. */
export function capacityOverview(raw: any, plans: UsagePlan[], costs: PlanCosts | { unavailable: string }, enabled: string[], now: number): CapacityProvider[] {
  const providers = new Map<string, CapacityProvider>();
  const get = (id: string) => {
    id = providerId(id);
    let p = providers.get(id);
    if (!p) { p = { id, name: names[id] ?? id, state: 'unknown', rule: rules[id] ?? 'Only provider-reported limits are shown.', accounts: [], meters: [], balances: [], monthlyUsd: 0, source: sources[id] ?? id, documentation: meterSources[id] ?? null }; providers.set(id,p); }
    return p;
  };
  const account = (id: string, key: string): CapacityAccount => {
    const p = get(id); let a = p.accounts.find(a=>a.id===key);
    if (!a) { a = { id:key, plan:null, weight:1, enabled:true, reason:null, meters:[], balances:[] }; p.accounts.push(a); }
    return a;
  };
  for (const id of enabled) get(id);
  const costRows = 'accounts' in costs ? costs.accounts : [];
  for (const row of costRows) {
    const a=account(row.provider,row.accountId);a.plan=row.plan;a.weight=row.capacityMultiplier ?? 1;a.enabled=row.inPool;a.reason=row.inPool?null:row.status ?? `On ${row.host}`;
    get(row.provider).monthlyUsd += row.usdPerMonth;
  }
  const addMeter = (a: CapacityAccount, id: string, hours: number|null, scope: string, left: unknown, at: unknown, reset: unknown, source: string) => {
    const readAt=date(at), value=number(left);
    const meter: CapacityMeter = { id, label: hours===168?'Week':hours===5?'5h':hours===null?'Allowance':`${hours}h`, scope, windowHours:hours, percentLeft:value===null?null:Math.max(0,Math.min(100,value)), resetAt:date(reset), observedAt:readAt, state:value===null?'unknown':readAt===null || now-readAt>freshMs?'stale':'fresh', source, coverage:1, total:1 };
    const index=a.meters.findIndex(m=>m.id===id);if(index<0)a.meters.push(meter);else if((a.meters[index]!.observedAt??0)<(readAt??0))a.meters[index]=meter;
  };
  for (const [provider, p] of Object.entries<any>(raw?.plans?.plans ?? {})) for (const [metric, m] of Object.entries<any>(p.metrics ?? {})) for(const row of m.accounts ?? []) {
    if(typeof row.accountId!=='string')continue;
    const id=providerId(provider), a=account(id,row.accountId);a.enabled=true;a.reason=null;
    const hours=number(row.windowHours);
    // A missing short window may be a broker alias for a weekly cap. The actual meter identity wins.
    if(row.meterId && hours!==null && !raw?.observedAccounts?.some((a:any)=>a.accountId===row.accountId)) {
      const scope=/fable|7d_oi/i.test(row.meterId)?'Fable':/sonnet/i.test(row.meterId)?'Sonnet':'All models';
      addMeter(a,row.meterId,hours,scope,row.percentLeft,row.readingAt,row.resetAt,sources[id]??id);
    }
    if(row.credits && number(row.credits.balance)!==null) {
      const at=date(row.credits.at);const fresh=at!==null && now-at<=5*60_000;
      const b:CapacityBalance={id:'credits',unit:'credits',remaining:row.credits.balance,available:fresh?row.credits.available===true:null,observedAt:at,expiresAt:null,burnPerHour:fresh?number(row.credits.burnPerHour):null,burnPerDay:fresh?number(row.credits.burnPerDay):null,runsOutAt:fresh?date(row.credits.runsOutAt):null,historyHours:number(row.credits.historyHours)};
      a.balances=[...a.balances.filter(b=>b.id!=='credits'),b];
    }
    if(number(row.bankedResets)!==null && row.bankedResets>0) a.balances=[...a.balances.filter(b=>b.id!=='resets'),{id:'resets',unit:'resets',remaining:row.bankedResets,available:date(row.bankedResetsAt)!==null&&now-date(row.bankedResetsAt)!<freshMs?true:null,observedAt:date(row.bankedResetsAt),expiresAt:date(row.bankedResetExpiresAt)}];
  }
  for (const row of raw?.observedAccounts ?? []) {
    if(typeof row.accountId!=='string' || typeof row.provider!=='string')continue;
    const a=account(row.provider,row.accountId);a.enabled=row.enabled===true;
    const newest=Math.max(0,...(row.readings??[]).map((m:any)=>m.observed_at));
    for(const m of row.readings??[]) {
      if(number(m.windowHours)===null)continue;
      // A historical short meter is not evidence that the current plan still has that limit.
      if(m.windowHours<24 && ((m.reset_at!==null&&m.reset_at<=now)||m.observed_at<newest-60_000))continue;
      addMeter(a,m.meter_id,m.windowHours,/fable|7d_oi/i.test(m.meter_id)?'Fable':'All models',100-m.used_percent,m.observed_at,m.reset_at,sources[providerId(row.provider)]??row.provider);
    }
  }
  const nv=raw?.freeUsage?.nvidia, or=raw?.freeUsage?.openrouter;
  if(nv&&number(nv.used)!==null&&number(nv.limit)!==null)get('nvidia').observations=[{label:'Broker rate',used:nv.used,limit:nv.limit,unit:'requests/min',observedAt:nv.observedAt,source:nv.source}];
  if(or&&number(or.spentDayUsd)!==null)get('openrouter').observations=[{label:'Spent today',used:or.spentDayUsd,limit:null,unit:'USD',observedAt:or.observedAt,source:'OpenRouter key API'}, {label:'Paid spend',used:or.spentUsd,limit:or.limitUsd,unit:'USD',observedAt:or.observedAt,source:'OpenRouter key API'}];
  // Google converts native remainingFraction into percent without inventing quota windows.
  for(const p of plans.filter(p=>p.provider==='google'))for(const row of p.accounts){
    const scope=p.metric==='weekly'||p.metric==='five-hour'?'Gemini':p.metric.replace(/ (weekly|five-hour)$/,'');
    const hours=p.metric.endsWith('weekly')?168:p.metric.endsWith('five-hour')?5:null;
    addMeter(account('google',row.accountId),`${scope}:${hours}`,hours,scope,row.percentLeft,row.readingAt,row.resetAt,sources.google!);
  }
  const grok=raw?.availability?.providers?.xai;
  if(grok){
    const a=account('xai',costRows.find(r=>providerId(r.provider)==='xai'&&r.inPool)?.accountId??'xai');a.enabled=true;a.reason=grok.reason??null;
    addMeter(a,'weekly',168,'All products',grok.percentLeft,grok.observedAt,grok.resetAt,sources.xai!);
    if(number(grok.prepaidUsd)!==null)a.balances.push({id:'prepaid',unit:'USD',remaining:grok.prepaidUsd,available:grok.prepaidUsd>0,observedAt:date(grok.observedAt),expiresAt:null});
  }
  for(const p of providers.values()){
    const active=p.accounts.filter(a=>a.enabled);
    const ids=[...new Set(active.flatMap(a=>a.meters.map(m=>`${m.scope}:${m.windowHours}`)))];
    for(const id of ids){
      const pairs=active.flatMap(a=>a.meters.filter(m=>`${m.scope}:${m.windowHours}`===id).map(m=>({a,m})));
      const known=pairs.filter(({m})=>m.percentLeft!==null);if(!pairs.length)continue;
      const weight=known.reduce((s,{a})=>s+a.weight,0);
      p.meters.push({...pairs[0]!.m,id,percentLeft:weight?known.reduce((s,{a,m})=>s+a.weight*m.percentLeft!,0)/weight:null,observedAt:known.length?Math.min(...known.map(x=>x.m.observedAt??0)):null,resetAt:known.some(x=>x.m.percentLeft!<100&&x.m.resetAt!==null&&x.m.resetAt>now)?Math.min(...known.filter(x=>x.m.percentLeft!<100&&x.m.resetAt!==null&&x.m.resetAt>now).map(x=>x.m.resetAt!)):null,state:known.length===pairs.length&&known.every(x=>x.m.state==='fresh')?'fresh':known.length?'stale':'unknown',coverage:known.length,total:active.length});
    }
    for(const unit of ['credits','USD','resets'] as const){
      const b=active.flatMap(a=>a.balances.filter(b=>b.unit===unit));if(!b.length)continue;
      const remaining=b.reduce((s,b)=>s+b.remaining,0);
      const sumRate=(key:'burnPerHour'|'burnPerDay')=>b.length===active.length&&b.every(x=>number(x[key])!==null)?b.reduce((s,x)=>s+x[key]!,0):null;
      const burnPerHour=sumRate('burnPerHour'),burnPerDay=sumRate('burnPerDay');
      p.balances.push({id:unit,unit,remaining,available:b.some(b=>b.available===true)?true:b.every(b=>b.available===false)?false:null,observedAt:Math.min(...b.map(b=>b.observedAt??0)),expiresAt:null,
        ...(unit==='credits'?{burnPerHour,burnPerDay,runsOutAt:remaining===0?now:burnPerHour!==null&&burnPerHour>0?now+remaining/burnPerHour*3_600_000:null}:{}),
      });
    }
    const balance=p.balances.some(b=>b.available===true&&b.remaining>0);
    const ready=active.some(a=>{const general=a.meters.filter(m=>p.id==='google'||['All models','Gemini','All products'].includes(m.scope));return general.length>0&&(p.id==='google'?general.some(m=>m.state==='fresh'&&m.percentLeft!==null&&m.percentLeft>0):general.every(m=>m.state==='fresh'&&m.percentLeft!==null&&m.percentLeft>0));});
    const limited=active.length>0&&active.every(a=>p.id==='google'?a.meters.length>0&&a.meters.every(m=>m.state==='fresh'&&m.percentLeft===0):a.meters.some(m=>['All models','Gemini','All products'].includes(m.scope)&&m.state==='fresh'&&m.percentLeft===0));
    p.state=ready?'available':balance?'credits':limited?'limited':p.observations?.some(o=>now-o.observedAt<freshMs)?'readings':'unknown';
    if(p.id==='xai'&&grok?.exhausted===true&&date(grok.observedAt)!==null&&now-date(grok.observedAt)!<=freshMs)p.state='limited';
    p.accounts.sort((a,b)=>Number(b.enabled)-Number(a.enabled)||a.id.localeCompare(b.id));
    p.meters.sort((a,b)=>(a.windowHours??1e9)-(b.windowHours??1e9)||a.scope.localeCompare(b.scope));
  }
  return [...providers.values()].sort((a,b)=>['anthropic','openai','google','xai','nvidia','openrouter'].indexOf(a.id)-['anthropic','openai','google','xai','nvidia','openrouter'].indexOf(b.id));
}
