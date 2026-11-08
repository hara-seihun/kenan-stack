import { Capacity } from './Capacity.js';
import { useEffect, useState } from 'react';
import type { PlanAccountCost, CacheFigures, CacheReport, LatencyReport, UsageReport, GpuFleetReport, GpuMachine, GpuPool, MercuryReport } from '../shared/contract.js';
import { hit, savedShare, tokens, usd } from '../shared/cache-summary.js';
import { ago, clock, relative } from './usageSummary.js';
import { api } from './client.js';
import { formatDate } from './dates.js';
import './Usage.css';

const providerName = (provider: string | null) => provider === 'anthropic' ? 'Claude' : provider === 'openai' || provider === 'openai-codex' ? 'OpenAI' : provider === 'xai' || provider === 'grok' ? 'Grok' : provider ?? 'Subscription';

const WINDOWS = [['hour', 'Last hour'], ['day', 'Last 24 h'], ['week', 'Last 7 days']] as const;
type WindowKey = typeof WINDOWS[number][0];
/** Below this an agent's or model's hit rate shows in amber. */
const LOW_HIT = 0.9;

function CacheRow({ name, f, extra }: { name: string; f: CacheFigures; extra?: string }) {
  return <tr><th title={name}>{name}</th><td className={f.hitRate !== null && f.hitRate < LOW_HIT ? 'cache-low' : undefined}>{hit(f.hitRate)}</td><td>{tokens(f.promptTokens)}</td><td>{extra ?? usd(f.savedUsd)}</td></tr>;
}

function Cache({ cache }: { cache: CacheReport }) {
  const [key, setKey] = useState<WindowKey>('day');
  const w = cache[key], o = w.overall, share = savedShare(o);
  return <section className="meter cache">
    <div className="meter-head"><h3>Prompt cache</h3><strong>{hit(o.hitRate)}</strong></div>
    <div className="cache-windows" role="group" aria-label="Window">{WINDOWS.map(([k, label]) => <button key={k} type="button" aria-pressed={k === key} onClick={() => setKey(k)}>{label}{k !== key && cache[k].overall.hitRate !== null ? ` · ${hit(cache[k].overall.hitRate)}` : ''}</button>)}</div>
    <p className="meter-reset">{o.promptTokens ? <>{tokens(o.cacheRead)} of {tokens(o.promptTokens)} prompt tokens read from cache over {o.calls.toLocaleString('en-US')} calls · caching saved <b>{usd(o.savedUsd)}</b>{share !== null && <> ({Math.round(share * 100)}% of list-price spend)</>}</> : 'No model calls in this window'}</p>
    {w.byProvider.length > 0 && <details className="usage-more" open><summary>By provider</summary><div className="table-scroll"><table><thead><tr><th>Provider</th><th>Hit</th><th>Prompt</th><th>Saved</th></tr></thead><tbody>{w.byProvider.map(p => <CacheRow key={p.provider} name={providerName(p.provider)} f={p}/>)}</tbody></table></div></details>}
    {o.promptTokens > 0 && <>
      <details className="usage-more" open><summary>By model</summary><div className="table-scroll"><table><thead><tr><th>Model</th><th>Hit</th><th>Prompt</th><th>Saved</th></tr></thead><tbody>{w.byModel.map(m => <CacheRow key={m.model} name={m.model} f={m}/>)}</tbody></table></div></details>
      {w.worstAgents.length > 0 && <details className="usage-more" open><summary>Most extra fresh tokens</summary><p className="cache-note">Agents sending the most prompt tokens fresh beyond the overall rate</p><div className="table-scroll"><table><thead><tr><th>Agent</th><th>Hit</th><th>Prompt</th><th>Extra fresh</th></tr></thead><tbody>{w.worstAgents.map(a => <CacheRow key={a.agentId} name={a.name} f={a} extra={tokens(a.excessMiss)}/>)}</tbody></table></div></details>}
      <details className="usage-more"><summary>Top agents</summary><div className="table-scroll"><table><thead><tr><th>Agent</th><th>Hit</th><th>Prompt</th><th>Saved</th></tr></thead><tbody>{w.topAgents.map(a => <CacheRow key={a.agentId} name={a.name} f={a}/>)}</tbody></table></div></details>
    </>}
  </section>;
}

const renewal = (date: string | null) => { if (!date) return 'Unknown'; const [y, m, d] = date.split('-').map(Number); return formatDate(new Date(y!, m! - 1, d), { month: 'short', day: 'numeric' }); };
const wholeUsd = (value: number) => `$${Math.round(value).toLocaleString('en-US')}`;
const usedPercent = (account: PlanAccountCost, metric: string) => { const q = account.quota.find(x => x.metric === metric); return !q || q.percentUsed === null ? '–' : `${Math.round(q.percentUsed)}%`; };
const nextQuotaReset = (account: PlanAccountCost, now: number) => { const at = account.quota.flatMap(q => q.resetAt !== null && q.resetAt > now ? [q.resetAt] : []); return at.length ? clock(Math.min(...at), now) : '–'; };

/** What the subscriptions cost: plan prices, who pays and when each renews, with each account's quota used. */
function PlanCosts({ costs, now }: { costs: UsageReport['planCosts']; now: number }) {
  if ('unavailable' in costs) return <section className="meter"><h3>Plan prices</h3><p className="cache-note">{costs.unavailable}</p></section>;
  const poolDaily = costs.poolMonthlyUsd * 12 / 365;
  return <section className="meter usage-spend">
    <h3>Plan prices</h3>
    <div className="usage-figures"><div><strong>{wholeUsd(costs.monthlyUsd)}</strong><span>Per month</span></div><div><strong>{wholeUsd(costs.dailyUsd)}</strong><span>Per day</span></div><div><strong>{wholeUsd(costs.poolMonthlyUsd)}</strong><span>In this host’s pool per month · {wholeUsd(poolDaily)}/day</span></div></div>
    <div className="table-scroll"><table>
      <thead><tr><th>Account</th><th>Plan</th><th>Capacity</th><th>Per month</th><th>Paid by</th><th>Renews</th><th>Weekly used</th><th>5-hour used</th><th>Next reset</th></tr></thead>
      <tbody>{costs.accounts.map(a => <tr key={a.accountId} title={`${a.email} · ${a.card}${a.note ? ` · ${a.note}` : ''}`}><th>{a.accountId}{!a.inPool && <small> · {a.status || a.host}</small>}</th><td>{providerName(a.provider)} {a.plan}</td><td>{a.capacityMultiplier ?? 1}×</td><td>{usd(a.usdPerMonth)}</td><td>{a.payer}</td><td>{renewal(a.renewsOn)}</td><td>{usedPercent(a, 'weekly')}</td><td>{usedPercent(a, 'five-hour')}</td><td>{nextQuotaReset(a, now)}</td></tr>)}</tbody>
    </table></div>
    {costs.unpriced.length > 0 && <p className="cache-note">No plan price recorded for {costs.unpriced.join(', ')}.</p>}
  </section>;
}
const cents = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** ResearchCo's Mercury bank balances and what has been spent since the account opened. */
function Mercury({ mercury, now }: { mercury: UsageReport['mercury']; now: number }) {
  if ('unavailable' in mercury) return <section className="meter"><h3>Mercury</h3><p className="cache-note">{mercury.unavailable}</p></section>;
  const card = mercury.creditCard;
  return <section className="meter usage-spend">
    <h3>Mercury</h3>
    <div className="usage-figures"><div><strong>{cents(mercury.cash.available)}</strong><span>Available</span></div><div><strong>{cents(mercury.spent.thisMonth)}</strong><span>Spent in {mercury.spent.monthLabel}</span></div><div><strong>{cents(mercury.spent.sinceOpening)}</strong><span>Spent since opening</span></div></div>
    <div className="table-scroll"><table>
      <thead><tr><th>Account</th><th>Available</th><th>Current</th></tr></thead>
      <tbody>{mercury.accounts.map(a => <tr key={a.name}><th>{a.name.replace('Mercury ', '')}</th><td>{cents(a.available)}</td><td>{cents(a.current)}</td></tr>)}
        <tr><th>IO credit card</th><td>{card.limit === null ? '–' : cents(card.limit - card.current)}</td><td>{cents(card.current)}{card.limit !== null && ` of ${cents(card.limit)}`}</td></tr></tbody>
    </table></div>
    <div className="table-scroll"><table>
      <thead><tr><th>Spent on</th><th>This month</th><th>Since opening</th></tr></thead>
      <tbody>{Object.entries(mercury.spentByGroup).map(([name, v]) => <tr key={name}><th>{name}</th><td>{cents(v.thisMonth)}</td><td>{cents(v.sinceOpening)}</td></tr>)}</tbody>
    </table></div>
    {mercury.problem ? <p className="cache-note">{mercury.problem}</p> : <p className="cache-note">Card spent {cents(card.spentToDate)} to date · read {ago(mercury.observedAt, now)}</p>}
  </section>;
}
const TABS = ['Plans', 'Costs', 'Cache', 'GPUs'] as const;
type Tab = typeof TABS[number];

export function Usage({ usage, metrics }: { usage: UsageReport | null; metrics: LatencyReport | null }) {
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState<Tab>('Plans');
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, [usage]);
  return <div className="panel usage">
    <div className="usage-tabs" role="tablist" aria-label="Usage categories">{TABS.map((name, i) => <button key={name} id={`usage-tab-${name}`} type="button" role="tab" aria-selected={tab === name} aria-controls={`usage-panel-${name}`} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={event => {
      const next = event.key === 'ArrowRight' ? (i + 1) % TABS.length : event.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
      if (next !== null) { event.preventDefault(); setTab(TABS[next]!); document.getElementById(`usage-tab-${TABS[next]}`)?.focus(); }
    }}>{name}</button>)}</div>
    <div id={`usage-panel-${tab}`} role="tabpanel" aria-labelledby={`usage-tab-${tab}`}>
      {tab === 'GPUs' ? <GPUs now={now}/> : !usage ? <p role="status">Loading usage…</p> : tab === 'Cache' ? <Cache cache={usage.cache}/> : <>
        {tab === 'Costs' ? <><Mercury mercury={usage.mercury} now={now}/><PlanCosts costs={usage.planCosts} now={now}/></> : <Capacity providers={usage.capacity ?? []} now={now}/>}
        {metrics && <details className="usage-more"><summary>Latency</summary><p>{metrics.count} messages in the last {Math.round(metrics.windowMs / 3600000)} hours</p><div className="table-scroll"><table><thead><tr><th>Interval</th><th>p50</th><th>p90</th><th>p99</th></tr></thead><tbody>{Object.entries(metrics.intervals).map(([name, values]) => <tr key={name}><th>{name}</th>{[values.p50, values.p90, values.p99].map((v, i) => <td key={i}>{v === null ? 'Unknown' : `${Math.round(v)} ms`}</td>)}</tr>)}</tbody></table></div></details>}
        <p className="usage-updated">Updated {ago(usage.observedAt, now)} · Refreshes every 30 seconds</p>
      </>}
    </div>
  </div>;
}

const perHour = (value: number) => `${usd(value)}/h`;
const computeUnits = (value: number) => `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} CU`;
const cuPerHour = (value: number) => `${computeUnits(value)}/h`;
const machineRate = (m: GpuMachine) => m.computeUnitsPerHour != null ? cuPerHour(m.computeUnitsPerHour) : m.usdPerHour === null ? '–' : m.usdPerHour === 0 ? 'Free' : perHour(m.usdPerHour);
const KIND_LABEL = { credit: 'Credit', money: 'Money', free: 'Free' } as const;

function ownerName(m: GpuMachine): string {
  const o = m.owner;
  if (!o) return m.unknown.owner ?? 'No owner recorded';
  if (o.kind === 'worker') return o.name ?? `Agent ${o.id.slice(0, 8)}`;
  if (o.kind === 'service') return o.name;
  return o.workers.length ? o.workers.length === 1 ? o.workers[0]!.name : `${o.label} · ${o.workers.length} active` : o.label;
}

function MachineRow({ m, now, pools }: { m: GpuMachine; now: number; pools: Map<string, GpuPool> }) {
  const pool = m.pool ? pools.get(m.pool) : undefined;
  const facts: string[] = [`${m.gpus ? `${m.gpus}× ` : ''}${m.card ?? 'Unknown card'}`, m.provider];
  if (m.memoryMiB != null) facts.push(`${m.memoryMiB.toLocaleString('en-US')} MiB`);
  if (m.gpuUtil !== null) facts.push(`${Math.round(m.gpuUtil)}% busy`);
  if (m.endsAt !== null) facts.push(m.endsAt > now ? `ends ${relative(m.endsAt, now)}` : 'past its end');
  const o = m.owner;
  return <details className={`gpu-row${m.idle ? ' gpu-idle' : ''}${m.stale ? ' gpu-stale' : ''}`}>
    <summary>
      <span className="gpu-who">{ownerName(m)}</span>
      <span className="gpu-rate">{machineRate(m)}</span>
      <span className="gpu-facts">{facts.join(' · ')}</span>
      <span className="gpu-doing">{m.idle ? `⚠ ${m.idle}` : m.doing ?? m.unknown.doing}</span>
    </summary>
    <dl>
      {o?.kind === 'worker' && <><dt>Worker</dt><dd>{o.name ?? o.id}{o.state ? ` · ${o.state}` : ''}</dd>{o.goal && <><dt>Goal</dt><dd>{o.goal}</dd></>}</>}
      {o?.kind === 'shared' && <><dt>Used by</dt><dd>{o.workers.length ? o.workers.map(w => w.name).join(', ') : 'No active workers'}</dd></>}
      <dt>Doing</dt><dd>{m.doing ?? m.unknown.doing}</dd>
      <dt>Machine</dt><dd>{m.name}{m.status ? ` · ${m.status}` : ''}</dd>
      <dt>Started</dt><dd>{m.startedAt === null ? m.unknown.startedAt : `${clock(m.startedAt, now)} · ${ago(m.startedAt, now)}`}</dd>
      <dt>Ends</dt><dd>{m.endsAt === null ? m.endsWhy : `${clock(m.endsAt, now)} · ${m.endsWhy}`}</dd>
      {(m.computeUnitsUsed != null || pool?.unit === 'compute-unit') && <><dt>Used compute units</dt><dd>{m.computeUnitsUsed != null ? computeUnits(m.computeUnitsUsed) : m.unknown.computeUnitsUsed ?? 'Not reported by the provider'}</dd></>}
      {m.memoryMiB != null && <><dt>GPU memory</dt><dd>{m.memoryMiB.toLocaleString('en-US')} MiB</dd></>}
      <dt>Cost so far</dt><dd>{m.costUsd === null ? m.unknown.costUsd : usd(m.costUsd)}</dd>
      <dt>Paid from</dt><dd>{pool ? `${pool.label} (${KIND_LABEL[pool.kind].toLowerCase()})` : m.unknown.pool}</dd>
      <dt>Rate</dt><dd>{m.computeUnitsPerHour != null ? cuPerHour(m.computeUnitsPerHour) : m.usdPerHour === null ? m.unknown.usdPerHour : perHour(m.usdPerHour)}{m.rateWhy ? ` · ${m.rateWhy}` : ''}</dd>
      {m.computeUnitsPerHour != null && m.usdPerHour === null && <><dt>USD rate</dt><dd>{m.unknown.usdPerHour}</dd></>}
      <dt>GPU busy</dt><dd>{m.gpuUtil === null ? m.unknown.gpuUtil : `${Math.round(m.gpuUtil)}%`}</dd>
      {m.stale && <><dt>Reading</dt><dd>Provider did not answer; last good reading</dd></>}
    </dl>
  </details>;
}

function GPUs({ now }: { now: number }) {
  const [report, setReport] = useState<GpuFleetReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true, request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      const current = ++request;
      try { const value = await api<GpuFleetReport>('/usage/gpus'); if (active && current === request) { setReport(value); setError(null); } }
      catch (e) { if (active && current === request) setError(e instanceof Error ? e.message : 'Could not read the GPU record'); }
      finally { if (active && current === request) timer = setTimeout(() => void refresh(), 30_000); }
    };
    const ready = () => { void refresh(); };
    void refresh();
    window.addEventListener('kenan-refresh', ready);
    return () => { active = false; clearTimeout(timer); window.removeEventListener('kenan-refresh', ready); };
  }, [retry]);
  if (!report) return error ? <p className="usage-error" role="alert">The GPU record could not be read. {error} <button onClick={() => setRetry(n => n + 1)}>Try again</button></p> : <p role="status">Reading the GPU record…</p>;
  if (!report.available) return <p>No GPU providers are connected for this account.</p>;
  const t = report.totals;
  const pools = new Map(report.pools.map(p => [p.id, p]));
  const idle = report.machines.filter(m => m.idle);
  const machines = [...report.machines].sort((a, b) => Number(!!b.idle) - Number(!!a.idle) || (b.usdPerHour ?? 0) - (a.usdPerHour ?? 0) || a.provider.localeCompare(b.provider));
  const failing = report.providers.filter(p => !p.ok);
  const unitPools = report.pools.filter(p => p.unit === 'compute-unit');
  const knownUnitRates = unitPools.filter(p => p.computeUnitsPerHour != null);
  const unitRate = knownUnitRates.reduce((sum, p) => sum + p.computeUnitsPerHour!, 0);
  return <>
    {(error || report.problem) && <p className="usage-error" role="alert">{report.problem ?? `Refresh failed; showing the last reading. ${error}`}</p>}
    <section className="meter gpu-top">
      <div className="usage-figures">
        <div><strong>{perHour(t.usdPerHour)}</strong><span>USD burn now</span></div>
        {unitPools.length > 0 && <div><strong>{knownUnitRates.length ? cuPerHour(unitRate) : '–'}</strong><span>Compute units now{knownUnitRates.length < unitPools.length ? ' (known rates)' : ''}</span></div>}
        <div><strong>{t.gpus}</strong><span>GPUs on {t.machines} {t.machines === 1 ? 'machine' : 'machines'}</span></div>
        <div><strong>{usd(t.todayUsd)}</strong><span>USD spent today</span></div>
      </div>
      <div className="table-scroll"><table className="gpu-pools">
        <thead><tr><th>Paid from</th><th>Now</th><th>Today (USD)</th>{unitPools.length > 0 && <th>Used CU</th>}<th>Left</th></tr></thead>
        <tbody>{report.pools.map(p => <tr key={p.id} title={p.todayWhy ?? undefined}>
          <th><i className={`gpu-kind gpu-kind-${p.kind}`}>{KIND_LABEL[p.kind]}</i>{p.label}</th>
          <td>{p.unit === 'compute-unit' ? p.computeUnitsPerHour != null ? cuPerHour(p.computeUnitsPerHour) : '–' : p.usdPerHour ? perHour(p.usdPerHour) : p.kind === 'free' && p.machines ? 'Free' : '–'}</td>
          <td>{p.todayUsd ? usd(p.todayUsd) : '–'}{p.capTodayUsd ? <small> of {usd(p.capTodayUsd)}</small> : null}</td>
          {unitPools.length > 0 && <td title={p.unit === 'compute-unit' ? 'Actual usage reported by the provider' : undefined}>{p.unit === 'compute-unit' && p.computeUnitsUsed != null ? computeUnits(p.computeUnitsUsed) : '–'}</td>}
          <td>{p.unit === 'compute-unit' ? p.remainingComputeUnits != null ? computeUnits(p.remainingComputeUnits) : '–' : p.remainingUsd === null ? '–' : usd(p.remainingUsd)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    {idle.length > 0 && <section className="meter gpu-alert" role="alert">
      <h3>Billing but idle</h3>
      <ul>{idle.map(m => <li key={m.key}><b>{ownerName(m)}</b> · {m.provider} {m.name} · {m.idle}{m.computeUnitsPerHour != null || m.usdPerHour ? ` · ${machineRate(m)}` : ''}</li>)}</ul>
    </section>}
    <section className="meter gpu-list">
      {machines.length === 0 ? <p>Nothing is running.</p> : machines.map(m => <MachineRow key={m.key} m={m} now={now} pools={pools}/>)}
    </section>
    {failing.length > 0 && <p className="usage-error">{failing.map(p => `${p.name}: ${p.error}`).join(' · ')}</p>}
    <p className="usage-updated">Updated {ago(report.observedAt, now)} · {report.providers.length} providers read every minute</p>
  </>;
}
