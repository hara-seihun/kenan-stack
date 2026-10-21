import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

export type StreamFunction = AgentSession['agent']['streamFunction'];
export type RequestModel = Parameters<StreamFunction>[0];

// Pi collapses Anthropic's stop_reason "refusal" (and safety stops) into an error carrying the provider's explanation.
const REFUSAL = /refus|usage policy|violative|provider stopped with: sensitive/i;
export const isRefusalMessage = (message: string) => REFUSAL.test(message);
export const isRefusal = (message: Pick<AssistantMessage, 'stopReason' | 'errorMessage'>) =>
  message.stopReason === 'error' && !!message.errorMessage && isRefusalMessage(message.errorMessage);

/** One model declining one request: what it said and what the attempt cost. */
export interface Refusal { model: string; message: string; usage: AssistantMessage['usage'] }
export interface RefusalEvents {
  /** `refusal` was answered by retrying the same request on `next`. */
  retried(refusal: Refusal, next: string): void;
}
export interface RefusalRecovery {
  /** The unwrapped provider stream, for calls that handle refusals themselves (context summaries). */
  base: StreamFunction;
  /** Models that refused during the current turn go last until the turn ends. */
  resetTurn(): void;
}

/**
 * A refused request is sent again, unchanged, to the next model of [requested model, ...fallbacks] (same subscription
 * broker), as one model response: events already streamed by a refused attempt are superseded by the next attempt's
 * partials, and only the last attempt's result reaches the transcript. Each model is tried at most once per request,
 * so a request costs at most 1 + fallbacks calls; when all refuse, the last refusal is the response.
 */
export function installRefusalRecovery(session: AgentSession, fallbacks: RequestModel[], events: RefusalEvents): RefusalRecovery {
  const base = session.agent.streamFunction;
  const refusedThisTurn = new Set<string>();
  session.agent.streamFunction = async (model, context, options) => {
    const candidates = [model, ...fallbacks.filter(fallback => fallback.id !== model.id)]
      .sort((a, b) => Number(refusedThisTurn.has(a.id)) - Number(refusedThisTurn.has(b.id)));
    const first = await base(candidates[0]!, context, options);
    if (candidates.length === 1) return first;
    const out = createAssistantMessageEventStream();
    void (async () => {
      let started = false;
      let response = first;
      for (const [index, candidate] of candidates.entries()) {
        let terminal: Extract<AssistantMessageEvent, { type: 'done' | 'error' }> | undefined;
        for await (const event of response) {
          if (event.type === 'done' || event.type === 'error') { terminal = event; break; }
          if (event.type === 'start') { if (started) continue; started = true; }
          out.push(event);
        }
        const result = await response.result();
        const next = candidates[index + 1];
        if (!next || !isRefusal(result) || options?.signal?.aborted) {
          if (terminal) out.push(terminal); else out.end(result);
          return;
        }
        refusedThisTurn.add(candidate.id);
        events.retried({ model: candidate.id, message: result.errorMessage!, usage: result.usage }, next.id);
        response = await base(next, context, options);
      }
    })().catch((error: unknown) => {
      out.push({ type: 'error', reason: options?.signal?.aborted ? 'aborted' : 'error', error: {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error),
      } });
    });
    return out;
  };
  return { base, resetTurn: () => refusedThisTurn.clear() };
}

/** Context for an agent whose request every configured model refused; it continues the work instead of ending idle. */
export const refusalNotice = (models: string[], message: string) =>
  `Your last model request was refused by the provider's content filter on every configured model (${models.join(', ')}): "${message.slice(0, 300)}". `
  + 'This is usually a false positive on something in the conversation (raw dumps, exploit-like or security wording, binary or encoded data), not on the task itself. Nothing in the refused response was executed. '
  + 'Continue the task: take the next step a different way, summarize instead of quoting the material that likely triggered it, and avoid repeating it. If the work genuinely cannot proceed, say so plainly (a worker reports blocked).';
