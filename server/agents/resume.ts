import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { isRefusal } from './refusal.js';

type Message = AgentSession['messages'][number];
const failedAttempt = (message: Message) => message.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted');

/**
 * Whether the transcript ends waiting for a model response that no tool can be part of: its last message (ignoring failed
 * or aborted attempts, which providers never replay, and system prompt updates) is not an assistant's, and every tool
 * call of the last completed assistant message has its result. Sending the model call again then repeats nothing.
 * A transcript that ends on a request the provider rejected owes nothing: that request is never sent again.
 */
export function owedModelCall(messages: readonly Message[]): boolean {
  const lastAttempt = messages.findLast(message => message.role !== 'system');
  if (lastAttempt?.role === 'assistant' && isRefusal(lastAttempt)) return false;
  const valid = messages.filter(message => !failedAttempt(message) && message.role !== 'system');
  const last = valid.at(-1);
  if (!last || last.role === 'assistant') return false;
  const at = valid.findLastIndex(message => message.role === 'assistant');
  if (at < 0) return true;
  const assistant = valid[at]!;
  if (assistant.role !== 'assistant') return false;
  const answered = new Set(valid.slice(at + 1).flatMap(message => message.role === 'toolResult' ? [message.toolCallId] : []));
  return assistant.content.every(part => part.type !== 'toolCall' || answered.has(part.id));
}

/**
 * The AgentSession members a resumed call uses. Pi has no public way to send the owed model call again: prompt() always
 * adds a user message. This runs exactly what prompt() runs after it builds that message, with none, so the request is
 * the transcript as it stands, with Pi's retries, compaction and per-turn system prompt intact.
 * runtime-provider.test.ts pins it against the installed Pi.
 */
interface PiSessionInternals {
  _extensionRunner?: { emitBeforeAgentStart(prompt: string, images: undefined, options: unknown): Promise<{ systemPromptOptions: { selectedTools: string[] } }> };
  _baseSystemPromptOptions?: unknown;
  _preparePromptAndToolLoadout?(options: unknown): unknown;
  _runSystemPromptOptions?: unknown;
  _runAgentPrompt?(messages: unknown[]): Promise<void>;
  _omitRecoveryAttempt?(message: Message): void;
}
export class PiResumeUnavailable extends Error {
  constructor(member: string) { super(`pi_resume_unavailable: this Pi version has no AgentSession.${member}`); }
}
export async function resumeModelCall(session: AgentSession): Promise<void> {
  const pi = session as unknown as PiSessionInternals;
  if (!pi._extensionRunner) throw new PiResumeUnavailable('_extensionRunner');
  if (pi._baseSystemPromptOptions === undefined) throw new PiResumeUnavailable('_baseSystemPromptOptions');
  if (typeof pi._preparePromptAndToolLoadout !== 'function') throw new PiResumeUnavailable('_preparePromptAndToolLoadout');
  if (typeof pi._runAgentPrompt !== 'function') throw new PiResumeUnavailable('_runAgentPrompt');
  if (!owedModelCall(session.messages)) throw new Error('pi_resume_no_model_call_owed');
  // Pi's provider projection ignores failed assistants, but its agent.continue()
  // requires the physical tail to be user/tool-result. Omitting only the new
  // timeout otherwise exposes a retained pre-restart aborted assistant. Use Pi's
  // own durable context edit, retaining audit history and every tool result.
  // A rejection stays: it marks the part of the transcript later requests leave out (refusal.ts withoutRejected).
  const attempts = session.messages.filter(message => failedAttempt(message) && !(message.role === 'assistant' && isRefusal(message)));
  if (attempts.length && typeof pi._omitRecoveryAttempt !== 'function') throw new PiResumeUnavailable('_omitRecoveryAttempt');
  for (const attempt of attempts) pi._omitRecoveryAttempt!(attempt);

  const { systemPromptOptions } = await pi._extensionRunner.emitBeforeAgentStart('', undefined, pi._baseSystemPromptOptions);
  systemPromptOptions.selectedTools = session.getActiveToolNames();
  const update = pi._preparePromptAndToolLoadout.call(session, systemPromptOptions);
  pi._runSystemPromptOptions = systemPromptOptions;
  await pi._runAgentPrompt.call(session, update ? [update] : []);
}
