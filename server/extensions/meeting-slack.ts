import type { JoinRequestMessage } from './meeting-request.js';

type Fetch = typeof fetch;
export interface SocketLike {
  onopen: (() => void) | null; onclose: (() => void) | null; onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void; close(): void;
}
export type OpenSocket = (url: string) => SocketLike;
export type SlackListenerStatus = { kind: 'connecting' } | { kind: 'connected'; at: number } | { kind: 'retrying'; reason: string; at: number } | { kind: 'stopped' };

const BOT_USER = /^U[A-Z0-9]+$/;

export interface SlackObservation extends JoinRequestMessage {
  type: 'message';
  bot_id?: string;
  directMessageWithKenan: boolean;
  thread_ts?: string;
  parent_user_id?: string;
  subtype?: string;
  files?: { id: string; name?: string; title?: string; mimetype?: string; filetype?: string }[];
}

/** Read the current body of an edit, and retain useful text from rich-only Slack messages. */
export function slackObservation(envelope: unknown): SlackObservation | null {
  const event = (envelope as { payload?: { event?: Record<string, unknown> } } | null)?.payload?.event;
  if (!event || (event.type !== 'message' && event.type !== 'app_mention')) return null;
  const body = event.subtype === 'message_changed' ? event.message as Record<string, unknown> | undefined : event;
  if (!body || typeof body !== 'object') return null;
  const channel = event.channel, ts = body.ts ?? event.ts;
  if (typeof channel !== 'string' || typeof ts !== 'string') return null;
  const parts: string[] = [];
  const add = (value: unknown) => { if (typeof value === 'string' && value && !parts.includes(value)) parts.push(value); };
  add(body.text);
  const richText = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) richText(item); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    // Flattening rich text must not turn a pasted transcript into the author's instructions.
    if (item.type === 'rich_text_preformatted' || item.type === 'rich_text_quote') {
      const start = parts.length;
      richText(item.elements);
      const quoted = parts.splice(start).join('\n');
      if (quoted) parts.push(item.type === 'rich_text_preformatted'
        ? '```\n' + quoted + '\n```' : quoted.split('\n').map(line => '> ' + line).join('\n'));
      return;
    }
    // Slack attachments, Block Kit text objects and rich_text elements, not their opaque metadata.
    for (const key of ['text', 'title', 'value', 'pretext', 'fallback', 'name', 'alt_text', 'url', 'title_link', 'permalink']) {
      const field = item[key];
      if (typeof field === 'string') add(field);
      else if (field && typeof field === 'object') richText(field);
    }
    for (const key of ['blocks', 'elements', 'fields', 'attachments', 'files']) richText(item[key]);
    if (item.type === 'user' && typeof item.user_id === 'string') add(`<@${item.user_id}>`);
    if (item.type === 'channel' && typeof item.channel_id === 'string') add(`<#${item.channel_id}>`);
  };
  // Slack's text already renders the blocks with fences and quotation markers. Appending a
  // flattened second rendering destroys those boundaries (Gabriel's Mongo migration transcript).
  if (!parts.length) richText(body.blocks);
  // Attachments are referenced content, not a first-party stop instruction.
  const start = parts.length;
  for (const key of ['attachments', 'files']) richText(body[key]);
  const referenced = parts.splice(start).join('\n');
  if (referenced) parts.push(parts.length ? referenced.split('\n').map(line => '> ' + line).join('\n') : referenced);
  return { channel, ts, user: typeof body.user === 'string' ? body.user : '', text: parts.join('\n'), type: 'message',
    ...(typeof body.subtype === 'string' ? { subtype: body.subtype } : {}),
    ...(typeof body.parent_user_id === 'string' ? { parent_user_id: body.parent_user_id } : {}),
    ...(typeof body.bot_id === 'string' ? { bot_id: body.bot_id } : {}),
    directMessageWithKenan: event.channel_type === 'im',
    ...(typeof body.thread_ts === 'string' ? {thread_ts: body.thread_ts} : {}),
    ...(Array.isArray(body.files) ? {files: body.files.filter((file): file is Record<string, unknown> & {id: string} =>
      !!file && typeof file === 'object' && typeof (file as Record<string, unknown>).id === 'string').map(file => ({id: file.id,
      ...Object.fromEntries(['name', 'title', 'mimetype', 'filetype'].flatMap(key => typeof file[key] === 'string' ? [[key, file[key]]] : []))}))} : {}) };
}

/**
 * The human message in a Socket Mode envelope that was sent to Kenan: a DM, or a channel message that @-mentions it.
 * Bots, edits, joins and Kenan's own messages are not requests.
 */
export function slackMessageToKenan(envelope: unknown, kenanUserId: string): JoinRequestMessage | null {
  const event = (envelope as { payload?: { event?: Record<string, unknown> } } | null)?.payload?.event;
  if (!event || typeof event !== 'object') return null;
  const { type, channel_type: channelType, subtype, bot_id: botId, user, text, channel, ts } = event as Record<string, unknown>;
  if (typeof user !== 'string' || !BOT_USER.test(user) || user === kenanUserId || botId !== undefined || subtype !== undefined) return null;
  if (typeof text !== 'string' || typeof channel !== 'string' || typeof ts !== 'string') return null;
  const direct = type === 'message' && channelType === 'im';
  const mention = type === 'app_mention' || (type === 'message' && text.includes(`<@${kenanUserId}>`));
  if (!direct && !mention) return null;
  return { channel, ts, user, text };
}

/**
 * Kenan's Slack app over Socket Mode: every message envelope is persisted before acknowledgement, and each message to Kenan is
 * handed to onMessage seconds after it is sent. Reconnects with backoff until the returned stop is called.
 * Slack redelivers unacknowledged envelopes, so onMessage must be idempotent per channel/ts.
 */
export function listenToSlack(options: {
  appToken: string; kenanUserId: string; onMessage: (message: JoinRequestMessage) => void;
  onObservation?: (message: SlackObservation) => unknown;
  onStatus?: (status: SlackListenerStatus) => void; request?: Fetch; openSocket?: OpenSocket; now?: () => number; retryMs?: (attempt: number) => number;
}): () => void {
  const request = options.request ?? fetch;
  const openSocket = options.openSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? (attempt => Math.min(60_000, 1000 * 2 ** attempt));
  let stopped = false, attempt = 0, socket: SocketLike | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  const status = (s: SlackListenerStatus) => options.onStatus?.(s);
  const retry = (reason: string) => {
    if (stopped || timer) return;
    socket?.close(); socket = null;
    status({ kind: 'retrying', reason, at: now() });
    timer = setTimeout(() => { timer = null; void connect(); }, retryMs(attempt++));
    timer.unref?.();
  };
  const connect = async () => {
    if (stopped) return;
    status({ kind: 'connecting' });
    let url: string;
    try {
      const response = await request('https://slack.com/api/apps.connections.open', { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${options.appToken}`, 'content-type': 'application/x-www-form-urlencoded' } });
      const body = await response.json() as { ok?: boolean; url?: string; error?: string };
      if (!body.ok || typeof body.url !== 'string') return retry(`apps.connections.open: ${body.error ?? `HTTP ${response.status}`}`);
      url = body.url;
    } catch (error) { return retry(`apps.connections.open: ${error instanceof Error ? error.message : String(error)}`); }
    if (stopped) return;
    const current = openSocket(url);
    socket = current;
    current.onopen = () => { attempt = 0; status({ kind: 'connected', at: now() }); };
    current.onerror = () => { if (socket === current) retry('socket error'); };
    current.onclose = () => { if (socket === current) retry('socket closed'); };
    current.onmessage = async event => {
      let envelope: { envelope_id?: string; type?: string; reason?: string };
      try { envelope = JSON.parse(String(event.data)); } catch { return; }
      if (envelope.type === 'disconnect') return retry(`slack disconnect: ${envelope.reason ?? 'unspecified'}`);
      if (envelope.type !== 'events_api') {
        if (envelope.envelope_id) current.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        return;
      }
      const observation = slackObservation(envelope);
      try {
        const persisted = observation ? options.onObservation?.(observation) : undefined;
        if (persisted instanceof Promise) await persisted;
      }
      catch { return retry('observation persistence failed'); }
      if (envelope.envelope_id) current.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      const message = slackMessageToKenan(envelope, options.kenanUserId);
      if (message) options.onMessage(message);
    };
  };
  void connect();
  return () => { stopped = true; if (timer) clearTimeout(timer); socket?.close(); socket = null; status({ kind: 'stopped' }); };
}

/**
 * Decides which listener status changes are worth an error. Slack Socket Mode rotates connections routinely, so a reconnect
 * that succeeds is only logged at info level. An error is raised when reconnects repeat more than maxRetries times within
 * windowMs, or when the listener stays down longer than downMs after it dropped.
 */
export function slackReconnectMonitor(options: {
  label: string; logError: (message: string) => void; logInfo?: (message: string) => void; now?: () => number;
  maxRetries?: number; windowMs?: number; downMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (handle: unknown) => void;
}): (status: SlackListenerStatus) => void {
  const now = options.now ?? Date.now, maxRetries = options.maxRetries ?? 3, windowMs = options.windowMs ?? 600_000, downMs = options.downMs ?? 60_000;
  const setTimer = options.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const logInfo = options.logInfo ?? (message => console.log(message));
  let retries: number[] = [], downSince: number | null = null, lastReason = '', downTimer: unknown = null, downReported = false;
  return status => {
    if (status.kind === 'retrying') {
      const at = status.at; lastReason = status.reason;
      retries = [...retries.filter(t => at - t < windowMs), at];
      if (retries.length > maxRetries) options.logError(`Slack listener for ${options.label} reconnected ${retries.length} times in ${Math.round(windowMs / 60000)} minutes; last reason: ${status.reason}`);
      if (downSince === null) {
        downSince = at; downReported = false;
        downTimer = setTimer(() => { downTimer = null; if (downSince !== null) { downReported = true; options.logError(`Slack listener for ${options.label} down for over ${Math.round(downMs / 1000)} s: ${lastReason}`); } }, downMs);
      }
    } else if (status.kind === 'connected') {
      if (downSince !== null) logInfo(`Slack listener for ${options.label} reconnected after ${Math.round((status.at - downSince) / 1000)} s (${lastReason})${downReported ? '; recovered' : ''}`);
      downSince = null; if (downTimer !== null) { clearTimer(downTimer); downTimer = null; }
    } else if (status.kind === 'stopped') {
      downSince = null; if (downTimer !== null) { clearTimer(downTimer); downTimer = null; }
    }
  };
}
