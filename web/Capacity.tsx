import { quotaCell } from './quotaTable.js';
import type { CapacityBalance, CapacityMeter, CapacityProvider } from '../shared/contract.js';
import { ago, clock, points, relative } from './usageSummary.js';

const status = { available: 'Available', credits: 'Credits available', limited: 'At limit', readings: 'Live readings', unknown: 'Not reported' };
function balance(b: CapacityBalance) { return `${b.unit === 'USD' ? '$' : ''}${b.remaining.toLocaleString('en-US', { maximumFractionDigits: b.unit === 'USD' ? 2 : 0 })}${b.unit === 'USD' ? '' : ` ${b.unit}`}${b.available === null ? ' · stale' : b.available === false ? ' · unavailable' : ''}`; }
const creditNumber = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
function CreditBurn({ b, now }: { b: CapacityBalance; now: number }) {
  return <><td>{creditNumber(b.remaining)}{b.available === null && <small>Last reading</small>}</td><td title={b.historyHours == null ? 'Recent observed credit decreases' : `${creditNumber(Math.min(1,b.historyHours)*60)} minutes observed; top-ups excluded`}>{b.burnPerHour == null ? 'Collecting history' : creditNumber(b.burnPerHour)}</td><td title={b.historyHours == null ? 'Recent observed credit decreases, normalized to 24 hours' : `${creditNumber(Math.min(24,b.historyHours))} hours observed; normalized to 24 hours; top-ups excluded`}>{b.burnPerDay == null ? 'Collecting history' : creditNumber(b.burnPerDay)}</td><td>{b.runsOutAt != null ? <span title={clock(b.runsOutAt, now)}>{b.remaining === 0 ? 'Empty' : clock(b.runsOutAt, now)}</span> : b.burnPerHour === 0 ? 'No recent burn' : 'Collecting history'}</td></>;
}
function CodexCredits({ provider: p, now }: { provider: CapacityProvider; now: number }) {
  const total=p.balances.find(b=>b.unit==='credits');
  const accounts=p.accounts.filter(a=>a.enabled);
  return <section className="meter codex-credits" aria-label="Codex credits"><h3>Codex credits</h3>
    <div className="table-scroll"><table><thead><tr><th>Account</th><th>Credits left</th><th>Credits / hour</th><th>Credits / day</th><th>Projected run-out</th></tr></thead><tbody>
      {total && <tr><th>Pool total</th><CreditBurn b={total} now={now}/></tr>}
      {accounts.map(a=>{const b=a.balances.find(b=>b.unit==='credits');return <tr key={a.id}><th>{a.id}</th>{b?<CreditBurn b={b} now={now}/>:<td colSpan={4}>Balance not reported</td>}</tr>})}
    </tbody></table></div>
  </section>;
}
function Meter({ meter: m, now }: { meter: CapacityMeter; now: number }) {
  const title = `${m.scope} · ${m.source}${m.observedAt ? ` · read ${ago(m.observedAt, now)}` : ''}${m.resetAt ? ` · resets ${clock(m.resetAt, now)}` : ''} · ${m.coverage}/${m.total} accounts read`;
  return <span className={`capacity-meter ${m.state}`} title={title}><span>{m.scope !== 'All models' && m.scope !== 'All products' ? `${m.scope} ` : ''}{m.label}</span><b>{m.percentLeft === null ? '—' : points(m.percentLeft)}</b>{m.percentLeft !== null && <progress max={100} value={m.percentLeft} aria-label={`${m.scope} ${m.label} remaining`}/>} {m.state !== 'fresh' && <small>{m.state}</small>}</span>;
}
function reset(p: CapacityProvider, now: number) { const times=p.meters.flatMap(m=>m.resetAt!==null&&m.resetAt>now&&m.percentLeft!==null&&m.percentLeft<100?[m.resetAt]:[]);return times.length?Math.min(...times):null; }
function AccountDetails({ providers, now }: { providers: CapacityProvider[]; now: number }) {
  return <section className="capacity-overview" aria-label="Account details">
    <div className="capacity-heading"><span>Plan</span><span>Remaining</span><span>Next reset</span></div>
    {providers.map(p=>{const at=reset(p,now);const active=p.accounts.filter(a=>a.enabled).length;return <details className="capacity-provider" key={p.id}>
      <summary><span className="capacity-name"><b>{p.name}</b><small>{status[p.state]}{p.accounts.length ? ` · ${active}/${p.accounts.length} accounts` : ''}</small></span>
        <span className="capacity-values">{p.meters.map(m=><Meter key={m.id} meter={m} now={now}/>)}{p.balances.map(b=><span className="capacity-balance" key={b.id}>{balance(b)}</span>)}{p.observations?.map(o=><span className="capacity-balance" key={o.label} title={`${o.source} · read ${ago(o.observedAt,now)}`}>{o.label} {o.unit==='USD'?'$':''}{o.used.toLocaleString('en-US',{maximumFractionDigits:2})}{o.limit!==null?` / ${o.unit==='USD'?'$':''}${o.limit.toLocaleString('en-US')}`:''}{o.unit==='USD'?'':' req/min'}{now-o.observedAt>15*60_000?' · stale':''}</span>)}{!p.meters.length&&!p.balances.length&&!p.observations?.length&&<small>No quota feed</small>}</span>
        <span className="capacity-reset" title={at===null?'No reset reported':clock(at,now)}>{at===null?'—':relative(at,now)}<small>{p.monthlyUsd ? `$${p.monthlyUsd.toLocaleString('en-US')}/mo` : ''}</small></span>
      </summary>
      <div className="capacity-detail">{p.accounts.length>0?<div className="table-scroll"><table><thead><tr><th>Account / plan</th><th>Remaining</th><th>Balance</th><th>Next reset</th></tr></thead><tbody>{p.accounts.map(a=>{const times=a.meters.flatMap(m=>m.resetAt!==null&&m.resetAt>now?[m.resetAt]:[]);return <tr key={a.id} className={!a.enabled?'capacity-disabled':undefined}><th>{a.id}<small>{a.plan}{a.weight!==1?` · ${a.weight}×`:''}{!a.enabled?` · ${a.reason??'Not in pool'}`:''}</small></th><td>{a.meters.length?a.meters.map(m=><Meter key={m.id} meter={m} now={now}/>):'Not reported'}</td><td>{a.balances.length?a.balances.map(b=><div key={b.id}>{balance(b)}</div>):'—'}</td><td>{times.length?clock(Math.min(...times),now):'—'}</td></tr>})}</tbody></table></div>:<p>No account quota is exposed by this route. This does not mean unlimited usage.</p>}
        <p>{p.rule}</p><div className="capacity-source"><span>{p.source}</span>{p.documentation&&<a href={p.documentation} target="_blank" rel="noreferrer">How limits work ↗</a>}</div>
      </div>
    </details>})}
  </section>;
}

function WindowCell({ provider, hours, now }: { provider: CapacityProvider; hours: number; now: number }) {
  const q=quotaCell(provider,hours,now);
  if(!q.meter)return <td className="quota-empty"><strong>—</strong><span className="quota-bar-gap"/>{q.noSession&&<small>No 5h limit</small>}</td>;
  return <td className={q.meter.state==='fresh'?'':'quota-stale'}><strong>{q.meter.percentLeft===null?'—':points(q.meter.percentLeft)}</strong><progress className="quota-bar" max={100} value={q.meter.percentLeft??0} aria-label={`${provider.name} ${hours===5?'5-hour':'weekly'} remaining`}/>
    {q.at!==null?<><small>+{points(q.gain??0)} {relative(q.at,now)}</small><small>{clock(q.at,now)}</small></>:<small>{q.meter.percentLeft===100?'Full':'Reset not reported'}</small>}
    {q.meter.state!=='fresh'&&<small>Last reading</small>}
  </td>;
}
export function Capacity({providers,now}:{providers:CapacityProvider[];now:number}) {
  return <section className="quota-overview" aria-label="Provider quotas">
    <table className="quota-table"><thead><tr><th>Provider</th><th>5-hour left</th><th>Weekly left</th></tr></thead><tbody>{providers.map(p=><tr key={p.id}><th>{p.name}{p.balances.some(b=>b.available&&b.remaining>0)&&<small>Credits available</small>}{!p.meters.length&&<small>Request limits</small>}</th><WindowCell provider={p} hours={5} now={now}/><WindowCell provider={p} hours={168} now={now}/></tr>)}</tbody></table>
    {providers.filter(p=>p.id==='openai').map(p=><CodexCredits key={p.id} provider={p} now={now}/>)}
    <details className="quota-details"><summary>Accounts, credits & other limits</summary><AccountDetails providers={providers} now={now}/></details>
  </section>;
}
