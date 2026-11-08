import type { CacheWindow, UsageReport } from '../../shared/contract.js';
import { cacheLines } from '../../shared/cache-summary.js';

function cacheSummary(window: CacheWindow) {
  const { calls, promptTokens, hitRate, costUsd, savedUsd } = window.overall;
  return {
    calls, promptTokens, hitRate, costUsd, savedUsd,
    providerColumns: ['provider', 'hitRate', 'promptTokens'],
    providers: window.byProvider.map(p => [p.provider, p.hitRate, p.promptTokens]),
    modelColumns: ['model', 'hitRate', 'promptTokens'],
    models: window.byModel.map(m => [m.model, m.hitRate, m.promptTokens]),
  };
}

/** The tool's short operational view; detailed keeps the complete original tool response. */
export function usageToolResult(report: UsageReport, detailed = false) {
  if (detailed) return { ...report, cache: cacheLines(report.cache) };
  return {
    observedAt: report.observedAt,
    plans: report.capacity ?? report.plans.map(plan => ({
      provider: plan.provider, metric: plan.metric, percentLeft: plan.percentLeft, binding: plan.binding,
      ...(plan.quotaUnavailableReason ? { quotaUnavailableReason: plan.quotaUnavailableReason } : {}),
      ...(plan.availability ? { availability: plan.availability } : {}),
      ...(plan.credits ? { credits: plan.credits } : {}),
      projection: plan.projection,
      accounts: plan.accounts.map(account => [account.accountId, account.percentLeft, account.readingAt,
        account.resetAt, account.drain.state === 'measured' ? account.drain.percentPerHour : account.drain.state,
        account.projectedExhaustionAt]),
    })),
    accountColumns: ['accountId', 'percentLeft', 'readingAt', 'resetAt', 'drainPercentPerHourOrState', 'projectedExhaustionAt'],
    planCosts: 'unavailable' in report.planCosts ? report.planCosts : {
      monthlyUsd: report.planCosts.monthlyUsd, dailyUsd: report.planCosts.dailyUsd, poolMonthlyUsd: report.planCosts.poolMonthlyUsd, unpriced: report.planCosts.unpriced,
      accountColumns: ['accountId', 'plan', 'usdPerMonth', 'payer', 'renewsOn', 'inPool'],
      accounts: report.planCosts.accounts.map(a => [a.accountId, a.plan, a.usdPerMonth, a.payer, a.renewsOn, a.inPool]),
    },
    // API list prices of the recorded calls, not what we pay: the plans above are the real cost.
    providerSpend: report.providerSpend,
    spend: { lastHourUsd: report.spend.lastHourUsd, lastDayUsd: report.spend.lastDayUsd },
    // Normal speed needs no warning. Non-normal workers and their quota multipliers remain visible.
    speeds: report.speeds.filter(speed => speed.workers.length),
    cache: { hour: cacheSummary(report.cache.hour), day: cacheSummary(report.cache.day), week: cacheSummary(report.cache.week) },
  };
}
