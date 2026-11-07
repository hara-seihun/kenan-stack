/**
 * The agents answering for Kenan in a meeting that is still live ("Meeting: …" agents). They idle between requests
 * with no report and no wake by design, so the manager heartbeat must not list them as stuck: on November 4, 2026 a
 * manager archived one from that list mid-meeting and the next delegation fell to the manager. The meeting extension
 * registers the reader; without it (no meetings on this channel) the list is empty.
 */
let reader: (() => Promise<string[]>) | null = null;
export function setLiveMeetingAgentsReader(read: (() => Promise<string[]>) | null): void { reader = read; }
export async function liveMeetingAgentIds(): Promise<string[]> {
  if (!reader) return [];
  try { return await reader(); } catch { return []; }
}

/**
 * A live meeting agent answers the people in the call (voice say, meeting chat), never other agents: on November 6,
 * 2026 two meeting agents sent meeting answers to their manager instead of speaking them ("Rivka pushed signing to
 * Friday…"). Returns the refusal for workers message from such an agent, or null.
 */
export async function meetingAgentMessageRefusal(agentId: string, live: () => Promise<string[]> = liveMeetingAgentIds): Promise<string | null> {
  if (!(await live()).includes(agentId)) return null;
  return 'meeting_agent_answers_the_meeting: you are the meeting agent of a live meeting. Answer the person who asked with voice(action="say", sessionId, delegationId, text), or in the meeting chat with meeting(action="chat"); never message the manager or other agents during the meeting. Report only when the meeting has ended.';
}
