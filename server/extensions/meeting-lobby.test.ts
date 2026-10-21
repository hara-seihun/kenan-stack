import { describe, expect, it } from 'vitest';
import { createSlackBotDm, LOBBY_REPING_MS, lobbyPingDue } from './meeting-lobby.js';

describe('notetaker lobby ping', () => {
  const end = 10 * LOBBY_REPING_MS;
  it('pings at once, reminds once after 2 minutes, then stays quiet', () => {
    expect(lobbyPingDue('lobby', [], 0, end, 'Weekly sync')).toEqual({ kind: 'first', text: 'Kenan notetaker is waiting in the lobby of Weekly sync — please admit it' });
    expect(lobbyPingDue('lobby', [0], LOBBY_REPING_MS - 1, end, 'Weekly sync')).toBeNull();
    expect(lobbyPingDue('lobby', [0], LOBBY_REPING_MS, end, 'Weekly sync')?.kind).toBe('reminder');
    expect(lobbyPingDue('lobby', [0, LOBBY_REPING_MS], 5 * LOBBY_REPING_MS, end, 'Weekly sync')).toBeNull();
  });
  it('never pings once admitted, gone, unknown or past the meeting end', () => {
    for (const state of ['entered', 'left', 'unknown'] as const) expect(lobbyPingDue(state, [], 0, end, 'x')).toBeNull();
    expect(lobbyPingDue('lobby', [], end, end, 'x')).toBeNull();
  });
  it('DMs the host found by email through the bot, and types an unknown host', async () => {
    const calls: string[] = [];
    const slack = createSlackBotDm('xoxb-fixture', async (url, init) => {
      const method = String(url).split('/api/')[1]!;
      calls.push(`${method} ${String(init?.body)}`);
      if (method === 'users.lookupByEmail') return Response.json(String(init?.body).includes('nobody') ? { ok: false, error: 'users_not_found' } : { ok: true, user: { id: 'U1' } });
      if (method === 'conversations.open') return Response.json({ ok: true, channel: { id: 'D1' } });
      return Response.json({ ok: true, ts: '1.2' });
    });
    expect(await slack.send('host@acme.example', 'hi')).toEqual({ ok: true, channel: 'D1', ts: '1.2' });
    expect(calls).toEqual(['users.lookupByEmail email=host%40acme.example', 'conversations.open users=U1', 'chat.postMessage channel=D1&text=hi']);
    expect(await slack.send('nobody@example.com', 'hi')).toEqual({ ok: false, error: { kind: 'host_unknown', detail: 'users.lookupByEmail: users_not_found' } });
  });
});
