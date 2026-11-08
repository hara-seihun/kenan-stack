// Per-person rolling allowance, checked at the stream boundary (also tool-loop, retry and compaction calls).
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { PersonConfig } from '../config.js';
import type { Store } from '../types.js';
import type { StreamFunction } from './refusal.js';

export const DAY_MS = 24 * 60 * 60_000;
export async function allowanceMessage(store: Pick<Store, 'personSpend'>, person: PersonConfig, now: number): Promise<string | null> {
  if (!person.budget) return null;
  const used = await store.personSpend(person.id, now - DAY_MS);
  return used < person.budget.dailyUsd ? null : `${person.name}'s daily Kenan allowance (API-equivalent USD) is used up: $${used.toFixed(2)} used of $${person.budget.dailyUsd.toFixed(2)}. It frees up on a rolling 24-hour window. Alice can raise it.`;
}
const synthetic = new WeakSet<object>();
export const isAllowanceMessage = (message: object): boolean => synthetic.has(message);

/** A local stop response uses the ordinary transcript and input-consumption path, without claiming a provider call. */
export function budgetStream(base: StreamFunction, check: () => Promise<string | null>, exhausted: () => void, now: () => number): StreamFunction {
  return async (model, context, options) => {
    const text = await check();
    if (!text) return base(model, context, options);
    exhausted();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, timestamp: now(), stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    synthetic.add(message);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message }); stream.end();
    return stream;
  };
}
