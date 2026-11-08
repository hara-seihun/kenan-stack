import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { StreamFunction } from './refusal.js';

type Context = Parameters<StreamFunction>[1];
type RequestModel = Parameters<StreamFunction>[0];

/**
 * A request carries thinking only from the model it goes to. Pi replays another model's thinking (Opus history in a session
 * that moved to Fable) as ordinary assistant text, so the new model sees hundreds of turns of "thinking summary, then answer"
 * text: Fable imitated it and wrote its own summaries into the reply text Alice reads, and Anthropic's filter refused the
 * conversation as "duplicating model outputs" (2026-11-01; reproduced with a five-message history, clean once dropped).
 * Anthropic ignores earlier turns' thinking anyway and can't verify another model's signature, so nothing is lost.
 */
export function withoutForeignThinking(model: Pick<RequestModel, 'provider' | 'api' | 'id'>, context: Context): Context {
  let changed = false;
  const messages = context.messages.map(message => {
    if (message.role !== 'assistant') return message;
    if (message.provider === model.provider && message.api === model.api && message.model === model.id) return message;
    if (!message.content.some(block => block.type === 'thinking')) return message;
    changed = true;
    return { ...message, content: message.content.filter(block => block.type !== 'thinking') };
  });
  return changed ? { ...context, messages } : context;
}

/** Installed innermost, so every request (compaction summaries on a fallback model included) is cleaned for the model it is sent to. */
export function dropForeignThinking(session: AgentSession): void {
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => stream(model, withoutForeignThinking(model, context), options);
}
