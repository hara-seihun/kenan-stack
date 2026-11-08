import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

export type StreamFunction = AgentSession['agent']['streamFunction'];
export type RequestModel = Parameters<StreamFunction>[0];

// Pi collapses Anthropic's stop_reason "refusal" (and safety stops) into an error carrying the provider's explanation;
// the raw stop reason stays on the message. OpenAI's cyber classifier answers "This content was flagged for possible
// cybersecurity risk" (2026-10-29). \brefus: a connection refused (ECONNREFUSED) is a network failure, not a rejection.
const REFUSAL = /\brefus|usage policy|violative|terms of service|provider stopped with: sensitive|flagged for possible/i;
export const isRefusalMessage = (message: string) => REFUSAL.test(message);
/** The provider rejected the request itself (a safety or policy refusal): sending it again gets the same answer. */
export const isRefusal = (message: Pick<AssistantMessage, 'stopReason' | 'errorMessage'> & { rawStopReason?: string }) =>
  message.stopReason === 'error' && (message.rawStopReason === 'refusal' || (!!message.errorMessage && isRefusalMessage(message.errorMessage)));

/** What the person sees where a rejected request's answer would have been (Alice, 2026-11-01). */
export const REJECTED = 'That message was rejected by the API.';
export const rejectedText = (provider: string) =>
  `${REJECTED} The provider said: "${provider}" It has been taken out of the conversation, so your next message goes ahead without it.`;

/** A worker's blocked report after a rejection says what happened and that a message continues it. */
export const rejectedFailure = (model: string, provider: string) =>
  `the provider rejected the request on ${model} ("${provider.slice(0, 300)}"); that step was taken out of the run's context and is never sent again, so a message continues the run without it`;

const accepted = (message: Message) => message.role === 'assistant' && (message.stopReason === 'stop' || message.stopReason === 'toolUse' || message.stopReason === 'length');
const rejected = (message: Message) => message.role === 'assistant' && isRefusal(message);
const textOf = (content: Message['content']) => typeof content === 'string' ? content : content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');

/** One input in a rejected span, named without its content: the time it arrived and who it came from. */
function describeInput(text: string): string[] {
  const at = /^\[Local time[^\n]*?(\d{1,2}:\d{2}),/.exec(text)?.[1];
  const from = [...text.matchAll(/^\[(\w+) from ([^\]\n]{1,120})\]/gm)].map(([, kind, who]) => `a ${kind} from ${who}`);
  const names = from.length ? from : ['a message from the person'];
  return names.map(name => at ? `${name} (${at})` : name);
}

/**
 * The model's context with every rejected request taken out (Alice, 2026-11-01: "a definitive provider safety/policy
 * rejection must stop retries of that rejected message"). On Beta that night one tool result (Kenaznia reading its own
 * thinking back out of the database) made Anthropic refuse every later request of the conversation, because each one
 * carried it again: every message Alice sent after it was rejected too.
 *
 * A rejected request's context is the last one the provider accepted plus what came after the last accepted response:
 * inputs, and that response's tool calls and results. That part goes, and one notice stands in its place, naming what
 * went without quoting it; the transcript and the person's chat keep everything. A response without tool calls stays
 * (nothing of it is dangling), unless the conversation was rejected again after it, in which case it goes too. A
 * response with tool calls goes with its results, so no tool call is ever left without its result. The result depends
 * only on the transcript, so it holds across restarts, steered input and queued input alike, and a span stops growing
 * (and its prompt cache settles) once a response is accepted after it.
 */
export function withoutRejected(messages: Message[]): Message[] {
  type Span = { anchor: number; start: number; end: number; rejections: AssistantMessage[] };
  const spans: Span[] = [];
  let lastAccepted = -1;
  messages.forEach((message, index) => {
    if (accepted(message)) { lastAccepted = index; return; }
    if (!rejected(message)) return;
    const open = spans.at(-1);
    if (open && open.end > lastAccepted) { open.end = index; open.rejections.push(message as AssistantMessage); return; }
    const anchor = messages[lastAccepted];
    const calls = anchor?.role === 'assistant' && anchor.content.some(part => part.type === 'toolCall');
    spans.push({ anchor: lastAccepted, start: calls ? lastAccepted : lastAccepted + 1, end: index, rejections: [message as AssistantMessage] });
  });
  if (!spans.length) return messages;
  for (const span of spans) if (span.rejections.length > 1 && span.anchor >= 0 && span.start > span.anchor) span.start = span.anchor;
  const out: Message[] = [];
  let next = 0;
  for (const span of spans) {
    out.push(...messages.slice(next, span.start));
    out.push({ role: 'user', content: [{ type: 'text', text: rejectionNotice(messages.slice(span.start, span.end + 1), span.rejections) }], timestamp: span.rejections[0]!.timestamp });
    next = span.end + 1;
  }
  out.push(...messages.slice(next));
  return out;
}

function rejectionNotice(span: Message[], rejections: AssistantMessage[]): string {
  const inputs = span.flatMap(message => message.role === 'user' ? describeInput(textOf(message.content)) : []);
  // Tool names only: arguments can carry the very material that was rejected.
  const counts = new Map<string, number>();
  for (const message of span) if (message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted')
    for (const part of message.content) if (part.type === 'toolCall') counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
  const calls = [...counts].map(([name, n]) => n === 1 ? name : `${name} (${n} calls)`);
  const answered = span.some(message => message.role === 'assistant' && accepted(message) && !message.content.some(part => part.type === 'toolCall'));
  const said = rejections[0]!.errorMessage ?? 'no explanation';
  const list = (items: string[]) => items.slice(0, 12).join('; ') + (items.length > 12 ? `; and ${items.length - 12} more` : '');
  return `[notice from system]\nThe provider rejected ${rejections.length === 1 ? 'a request' : `${rejections.length} requests in a row`} at this point in the conversation (it said: "${said.slice(0, 300)}"). `
    + 'That part was taken out of your context and is not sent again; the transcript and the person\'s chat keep it, and the person was told "That message was rejected by the API." '
    + (inputs.length ? `Inputs taken out: ${list(inputs)}. Look up any you still need (goals, workers peek) without quoting what was rejected. ` : '')
    + (answered ? 'Your last answer before the rejection was taken out too. ' : '')
    + (calls.length ? `Tool calls in that part had already run and their results were taken out: ${list(calls)}. Their effects stand: check what they changed before doing anything that would repeat them. ` : '')
    + 'Carry on from the next input, and avoid repeating the material that was rejected.';
}
