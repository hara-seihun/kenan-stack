// Spoken replies to live voice and phone delegations. The agent's reply streams to GPT Live while the model is still
// writing it: each complete sentence is sent the moment it exists, the remainder when the tool call completes.
const answered = new Set<string>();
/** Whether a delegation's spoken reply has been completed; until then a new live request joins the turn answering it. */
export const liveAnswered = (delegationId: string) => answered.has(delegationId);

type Reply = { delegationId: string; sent: number };
const replies = new Map<string, Reply>();
/** The end of the last complete sentence or clause in text after `from`, or `from` when there is none yet. */
export function spokenUpTo(text: string, from: number): number {
  let cut = from;
  for (const match of text.slice(from).matchAll(/[.!?…;:]["'”’)\]]*\s+|\n+/g)) cut = from + match.index + match[0].length;
  return cut;
}
/** A partial reply as the model writes it (tool call `callId`): sends every newly completed sentence. */
export function streamReply(callId: string, delegationId: string, text: string, speak: (chunk: string) => void): void {
  let reply = replies.get(callId);
  if (!reply) { reply = { delegationId, sent: 0 }; replies.set(callId, reply); }
  if (reply.delegationId !== delegationId) return;
  const cut = spokenUpTo(text, reply.sent);
  if (cut === reply.sent) return;
  const chunk = text.slice(reply.sent, cut).trim();
  reply.sent = cut;
  if (chunk) speak(chunk);
}
/** The complete reply: sends what streaming has not, and marks the delegation answered. */
export function finishReply(callId: string, delegationId: string, text: string, speak: (chunk: string) => void): { streamed: number } {
  const reply = replies.get(callId);
  replies.delete(callId);
  const sent = reply?.delegationId === delegationId ? reply.sent : 0;
  const rest = text.slice(sent).trim();
  if (rest) speak(rest);
  answered.add(delegationId);
  return { streamed: sent };
}
