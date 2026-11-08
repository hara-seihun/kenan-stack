import { RECALL_BOT_NAME, readMachineSecrets } from './meeting-recall.js';

type Fetch = typeof fetch;
export const LOBBY_REPING_MS = 120_000;

/** Lobby pings already sent for one provider session, oldest first; at most two (first and the 2-minute reminder). */
export type LobbyPings = number[];
export type LobbyPing = { kind: 'first' | 'reminder'; text: string };

/** What to send for an observed lobby state: a first ping, one reminder after 2 minutes, then nothing until the meeting ends. */
export function lobbyPingDue(state: 'lobby' | 'entered' | 'left' | 'unknown', pings: LobbyPings, now: number, endsAt: number, title: string, botName: string = RECALL_BOT_NAME): LobbyPing | null {
  if (state !== 'lobby' || now >= endsAt) return null;
  const meeting = title.trim() || 'your meeting';
  if (pings.length === 0) return { kind: 'first', text: `${botName} is waiting in the lobby of ${meeting} — please admit it` };
  if (pings.length === 1 && now - pings[0]! >= LOBBY_REPING_MS) return { kind: 'reminder', text: `Reminder: ${botName} is still waiting in the lobby of ${meeting} — please admit it` };
  return null;
}

export type SlackDmError = { kind: 'host_unknown' | 'slack_refused' | 'slack_unreachable'; detail: string };
export type SlackDmResult = { ok: true; channel: string; ts: string } | { ok: false; error: SlackDmError };

/** The Kenan bot's direct messages to a workspace member found by email. Bot lane only: the token is the bot's. */
export function createSlackBotDm(token: string, request: Fetch = fetch) {
  const call = async (method: string, body: Record<string, string>): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: SlackDmError }> => {
    let response: Response;
    try {
      response = await request(`https://slack.com/api/${method}`, { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    } catch (error) { return { ok: false, error: { kind: 'slack_unreachable', detail: `${method}: ${error instanceof Error ? error.message : String(error)}` } }; }
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!data) return { ok: false, error: { kind: 'slack_unreachable', detail: `${method}: HTTP ${response.status} without JSON` } };
    if (data.ok !== true) return { ok: false, error: { kind: method === 'users.lookupByEmail' && data.error === 'users_not_found' ? 'host_unknown' : 'slack_refused', detail: `${method}: ${String(data.error)}` } };
    return { ok: true, value: data };
  };
  return {
    async send(email: string, text: string): Promise<SlackDmResult> {
      const user = await call('users.lookupByEmail', { email });
      if (!user.ok) return user;
      const userId = (user.value.user as { id?: unknown } | undefined)?.id;
      if (typeof userId !== 'string') return { ok: false, error: { kind: 'slack_refused', detail: 'users.lookupByEmail: no user id' } };
      const opened = await call('conversations.open', { users: userId });
      if (!opened.ok) return opened;
      const channel = (opened.value.channel as { id?: unknown } | undefined)?.id;
      if (typeof channel !== 'string') return { ok: false, error: { kind: 'slack_refused', detail: 'conversations.open: no channel id' } };
      const posted = await call('chat.postMessage', { channel, text });
      if (!posted.ok) return posted;
      return { ok: true, channel, ts: String(posted.value.ts) };
    },
    /** A reply in the thread of the message it answers. */
    async reply(channel: string, threadTs: string, text: string): Promise<SlackDmResult> {
      const posted = await call('chat.postMessage', { channel, thread_ts: threadTs, text });
      if (!posted.ok) return posted;
      return { ok: true, channel, ts: String(posted.value.ts) };
    },
    /** Slack's conversation type, not the channel id's prefix: a 1:1 DM is is_im and not is_mpim. */
    async conversationKind(channel: string): Promise<{ ok: true; kind: 'one-to-one-dm' | 'other' } | { ok: false; error: SlackDmError }> {
      const info = await call('conversations.info', { channel });
      if (!info.ok) return info;
      const record = info.value.channel as { is_im?: unknown; is_mpim?: unknown } | undefined;
      if (!record || typeof record !== 'object') return { ok: false, error: { kind: 'slack_refused', detail: 'conversations.info: no channel' } };
      return { ok: true, kind: record.is_im === true && record.is_mpim !== true ? 'one-to-one-dm' : 'other' };
    },
    /** Whether the bot already answered in the thread (an answer sent just before a crash): it answers each request once. */
    async threadHasReply(channel: string, threadTs: string, botUserId: string): Promise<{ ok: true; found: boolean } | { ok: false; error: SlackDmError }> {
      const replies = await call('conversations.replies', { channel, ts: threadTs, limit: '200' });
      if (!replies.ok) return replies;
      const messages = replies.value.messages;
      if (!Array.isArray(messages)) return { ok: false, error: { kind: 'slack_refused', detail: 'conversations.replies: no messages' } };
      return { ok: true, found: messages.some(m => (m as { user?: unknown }).user === botUserId && (m as { ts?: unknown }).ts !== threadTs) };
    },
    /** The bot's own Slack user id, so its own messages are never read as requests. */
    async userId(): Promise<{ ok: true; userId: string } | { ok: false; error: SlackDmError }> {
      const me = await call('auth.test', {});
      if (!me.ok) return me;
      return typeof me.value.user_id === 'string' ? { ok: true, userId: me.value.user_id } : { ok: false, error: { kind: 'slack_refused', detail: 'auth.test: no user_id' } };
    },
  };
}

export async function loadKenanSlackBot(request: Fetch = fetch) {
  const [token] = await readMachineSecrets(['slack-bot-token'], 'Kenan Slack bot', request);
  if (!token?.startsWith('xoxb-')) throw new Error('Kenan Slack bot grant is not a bot token');
  return createSlackBotDm(token, request);
}

export type KenanSlackBot = ReturnType<typeof createSlackBotDm>;
export async function loadKenanSlackApp(request: Fetch = fetch) {
  const [token] = await readMachineSecrets(['shared-slack-kenan-app-token-global'], 'Kenan Slack app', request);
  if (!token?.startsWith('xapp-')) throw new Error('Kenan Slack app grant is not an app-level token');
  return token;
}
