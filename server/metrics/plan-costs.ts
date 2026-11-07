// What the AI subscriptions cost: the plan-prices file (example-data/admin/ai-plans.json) joined with the broker's live quota.
import { readFile } from 'node:fs/promises';
import type { PlanAccountCost, PlanCosts, UsagePlan } from '../../shared/contract.js';

const PROVIDERS = ['anthropic', 'openai', 'xai'] as const;
const DAYS_PER_YEAR = 365;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface PlanEntry { id: string; provider: UsagePlan['provider']; email: string; plan: string; usdPerMonth: number | null; payer: string; card: string; renews: string | null; host: string; note: string }

function parsePlans(json: unknown, path: string): PlanEntry[] {
  const accounts = (json as { accounts?: unknown })?.accounts;
  if (!Array.isArray(accounts)) throw new Error(`${path} must be {"accounts": [...]}`);
  return accounts.map((a, i) => {
    const where = `${path} accounts[${i}]`;
    const str = (k: string) => { const v = a?.[k]; if (typeof v !== 'string' || !v) throw new Error(`${where}.${k} must be a non-empty string`); return v as string; };
    const provider = str('provider');
    if (!(PROVIDERS as readonly string[]).includes(provider)) throw new Error(`${where}.provider must be one of ${PROVIDERS.join(', ')}`);
    const usd = a.usdPerMonth;
    if (usd !== null && (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)) throw new Error(`${where}.usdPerMonth must be a number of dollars or null (unknown)`);
    const renews = a.renews;
    if (renews !== null && (typeof renews !== 'string' || !ISO_DATE.test(renews))) throw new Error(`${where}.renews must be YYYY-MM-DD or null`);
    return { id: str('id'), provider: provider as UsagePlan['provider'], email: str('email'), plan: str('plan'), usdPerMonth: usd, payer: str('payer'), card: str('card'), renews, host: str('host'), note: typeof a.note === 'string' ? a.note : '' };
  });
}

/** The next renewal on or after today: the file's date, moved forward a month at a time. */
export function renewsOn(iso: string | null, today: string): string | null {
  if (iso === null) return null;
  let [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  const at = () => `${y}-${pad(m)}-${pad(Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate()))}`;
  while (at() < today) { m += 1; if (m > 12) { m = 1; y += 1; } }
  return at();
}

/** Plans we pay for, with this person's live quota per account. Plans another party pays (ACME) are not ours and stay out. */
export async function planCosts(plansPath: string | undefined, plans: UsagePlan[], now: number): Promise<PlanCosts | { unavailable: string }> {
  if (!plansPath) return { unavailable: 'This channel has no plan-prices file (plansPath).' };
  let entries: PlanEntry[];
  try { entries = parsePlans(JSON.parse(await readFile(plansPath, 'utf8')), plansPath); }
  catch (e) { return { unavailable: `Plan prices unreadable: ${String((e as Error)?.message ?? e)}` }; }
  const today = new Date(now).toISOString().slice(0, 10);
  const brokerAccounts = new Set(plans.flatMap(p => p.accounts.map(a => a.accountId)));
  const xaiServed = plans.some(p => p.provider === 'xai');
  const accounts: PlanAccountCost[] = entries.filter(e => e.usdPerMonth !== null && !e.payer.startsWith('ACME')).map(e => ({
    accountId: e.id, provider: e.provider, email: e.email, plan: e.plan, usdPerMonth: e.usdPerMonth!, payer: e.payer, card: e.card,
    renewsOn: renewsOn(e.renews, today), host: e.host, note: e.note,
    inPool: e.provider === 'xai' ? xaiServed : brokerAccounts.has(e.id),
    quota: plans.flatMap(p => p.accounts.filter(a => a.accountId === e.id).map(a => ({ metric: p.metric, percentUsed: a.percentLeft === null ? null : 100 - a.percentLeft, resetAt: a.resetAt, readingAt: a.readingAt }))),
  })).sort((a, b) => Number(b.inPool) - Number(a.inPool) || b.usdPerMonth - a.usdPerMonth || a.accountId.localeCompare(b.accountId));
  const monthly = accounts.reduce((t, a) => t + a.usdPerMonth, 0);
  const known = new Set(entries.map(e => e.id));
  return {
    monthlyUsd: monthly, dailyUsd: monthly * 12 / DAYS_PER_YEAR,
    poolMonthlyUsd: accounts.filter(a => a.inPool).reduce((t, a) => t + a.usdPerMonth, 0),
    accounts, unpriced: [...brokerAccounts].filter(id => !known.has(id)).sort(),
  };
}
