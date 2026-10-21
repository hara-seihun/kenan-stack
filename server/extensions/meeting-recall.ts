export interface RecallGrant { apiKey: string; region: string }
export interface RecallEvidence {
  botId: string; state: 'joining' | 'lobby' | 'entered' | 'left' | 'failed' | 'unknown';
  status: string; observedAt: string; providerAt: string | null;
}
type Fetch = typeof fetch;
/** Hosts admit the bot by this name; the lobby DM and the channel note use it too. */
export const RECALL_BOT_NAME = 'Kenan notetaker';
/** Never round past the event end or create a bot too late for the provider's minimum. */
export function remainingMeetingSeconds(endsAt: number, now: number): number {
  const seconds = Math.floor((endsAt - now) / 1000);
  if (!Number.isFinite(seconds) || seconds < 30) throw new Error('Meeting has insufficient remaining duration');
  return Math.min(14400, seconds);
}
/** Reads acme-project Secret Manager secrets with the attached machine identity. No login or identity fallback. */
export async function readMachineSecrets(names: string[], label: string, request: Fetch = fetch): Promise<string[]> {
  const metadata = await request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(10000),
  });
  if (!metadata.ok) throw new Error(`${label} machine identity unavailable (${metadata.status})`);
  const token = (await metadata.json() as { access_token?: string }).access_token;
  if (!token) throw new Error(`${label} machine identity missing`);
  const values: string[] = [];
  for (const name of names) {
    const response = await request(`https://secretmanager.googleapis.com/v1/projects/acme-project/secrets/${name}/versions/latest:access`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`${label} existing grant unavailable (${response.status})`);
    const data = await response.json() as { payload?: { data?: string } };
    if (!data.payload?.data) throw new Error(`${label} existing grant missing`);
    values.push(Buffer.from(data.payload.data, 'base64').toString('utf8').trim());
  }
  return values;
}
/** Existing attached-machine grant only. No login, grant changes or identity fallback. */
export async function loadExistingRecallGrant(request: Fetch = fetch): Promise<RecallGrant> {
  const [apiKey, region] = await readMachineSecrets(['meeting-recall-api-key', 'meeting-recall-region'], 'Recall', request);
  if (!apiKey || !region || !/^[a-z]{2}-[a-z]+-\d+$/.test(region)) throw new Error('Recall existing grant invalid');
  return { apiKey, region };
}
export function normalizeRecallEvidence(botId: string, body: unknown, now = Date.now()): RecallEvidence {
  const changes = (body as { status_changes?: { code?: string; created_at?: string }[] } | null)?.status_changes;
  const last = Array.isArray(changes) ? changes.at(-1) : undefined;
  const status = typeof last?.code === 'string' ? last.code : 'unknown';
  const states: Record<string, RecallEvidence['state']> = {
    joining_call: 'joining', in_waiting_room: 'lobby', in_call_not_recording: 'entered',
    in_call_recording: 'entered', call_ended: 'left', done: 'left', fatal: 'failed',
  };
  return { botId, state: states[status] ?? 'unknown', status, observedAt: new Date(now).toISOString(),
    providerAt: last?.created_at && Number.isFinite(Date.parse(last.created_at)) ? last.created_at : null };
}
/** Caller owns fresh policy, durable reservation/bot id and cleanup timer. Never retries a create. */
export function createRecallMeetingClient(grant: RecallGrant, request: Fetch = fetch) {
  if (!grant.apiKey || !/^[a-z]{2}-[a-z]+-\d+$/.test(grant.region)) throw new Error('Invalid Recall grant');
  const base = `https://${grant.region}.recall.ai/api/v1`;
  const id = (value: string) => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid Recall bot identity');
    return value;
  };
  async function call(path: string, method = 'GET', body?: unknown) {
    let response: Response;
    try { response = await request(base + path, { method,
      headers: { authorization: `Token ${grant.apiKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    } catch { throw new Error(method === 'POST' ? 'Recall effect uncertain; reconcile original reservation before another attempt' : 'Recall inspection unavailable'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Recall ${method} failed (${response.status}); reconcile original identity`); }
    return response.status === 204 ? null : await response.json() as unknown;
  }
  return {
    async join(input: { meetingUrl: string; effectId: string; durationSeconds: number }): Promise<RecallEvidence> {
      if (!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(input.meetingUrl)) throw new Error('Invalid Meet URL');
      if (!input.effectId || input.effectId.length > 200 || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 30 || input.durationSeconds > 14400) throw new Error('Invalid Recall reservation');
      const data = await call('/bot/', 'POST', { meeting_url: input.meetingUrl, bot_name: RECALL_BOT_NAME, recording_config: null,
        automatic_leave: { waiting_room_timeout: input.durationSeconds, noone_joined_timeout: 120, in_call_not_recording_timeout: input.durationSeconds },
        metadata: { source: 'acme-meeting', effectId: input.effectId } });
      const botId = (data as { id?: string } | null)?.id;
      if (!botId) throw new Error('Recall create identity missing; reconcile original reservation');
      return normalizeRecallEvidence(id(botId), data);
    },
    /** Complete bounded read only scan; null means no match, never authorizes a create retry. */
    async reconcile(effectId: string, meetingUrl: string): Promise<RecallEvidence | null> {
      if (!effectId || effectId.length > 200 || !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingUrl)) throw new Error('Invalid Recall reconciliation identity');
      let path = '/bot/?meeting_url=' + encodeURIComponent(meetingUrl) + '&page_size=100';
      const visited = new Set<string>();
      const matches = new Set<string>();
      for (let page = 0; page < 5; page++) {
        if (visited.has(path)) throw new Error('Recall reconciliation pagination loop');
        visited.add(path);
        const data = await call(path) as { results?: unknown[]; next?: unknown } | null;
        if (!data || !Array.isArray(data.results) || data.results.length > 100) throw new Error('Recall reconciliation incomplete');
        for (const row of data.results) {
          if (!row || typeof row !== 'object') throw new Error('Recall reconciliation malformed result');
          const bot = row as { id?: string; meeting_url?: string; metadata?: { effectId?: string } };
          if (bot.metadata?.effectId === effectId && bot.meeting_url === meetingUrl) {
            matches.add(id(bot.id ?? ''));
            if (matches.size > 1) throw new Error('Recall reconciliation ambiguous');
          }
        }
        if (data.next === null || data.next === undefined || data.next === '') {
          const found = [...matches][0];
          return found ? normalizeRecallEvidence(found, await call(`/bot/${found}/`)) : null;
        }
        if (typeof data.next !== 'string') throw new Error('Recall reconciliation invalid pagination');
        const next = new URL(data.next, base + '/bot/');
        if (next.origin !== new URL(base).origin || next.pathname !== '/api/v1/bot/' || next.hash || next.username || next.password) throw new Error('Recall reconciliation foreign pagination');
        path = next.pathname.slice('/api/v1'.length) + next.search;
      }
      throw new Error('Recall reconciliation page bound reached; original effect remains uncertain');
    },
    async inspect(botId: string) { return normalizeRecallEvidence(id(botId), await call(`/bot/${id(botId)}/`)); },
    async leave(botId: string) {
      await call(`/bot/${id(botId)}/leave_call/`, 'POST', {});
      // A leave ACK is not evidence of departure.
      return normalizeRecallEvidence(botId, await call(`/bot/${id(botId)}/`));
    },
  };
}
