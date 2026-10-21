import { pageParameters, arrayPage } from '../tools/pagination.js';
import { randomUUID } from 'node:crypto';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import { Type } from 'typebox';
import type { Deps, Extension } from '../types.js';
import { finishReply, streamReply } from '../agents/live.js';
import { LIVE_REQUEST, acceptInbound, answerSilently, replied, speaker, takeWithheld, calls, hangUp, inboundLine, liveClient, liveConfig, mediaSettings as settings, phoneSockets, placeCall, pressDigits, startPhone, stopPhone, telephoneConfig } from './phone.js';
import { parseDigits } from './phone-dtmf.js';

type VoiceSession = { id: string; ownerId: string; conversationId: string; providerId: string; socket: SidebandWS; transcript: string; delegations: Set<string>; unsubscribe: () => void };
type Say = { sessionId: string; delegationId: string; text: string };
const isSay = (args: Record<string, unknown>): args is Say & Record<string, unknown> => args.action === 'say' && typeof args.sessionId === 'string' && typeof args.delegationId === 'string' && typeof args.text === 'string';
const sessions = new Map<string, VoiceSession>();
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
function close(session: VoiceSession) {
  try { session.socket.send({ type: 'session.close' }); } finally { session.socket.close(); session.unsubscribe(); sessions.delete(session.id); }
}

export const voiceExtension: Extension = {
  id: 'voice', name: 'Voice',
  promptSnippet: 'Live voice and phone calls delegate requests to you with a voice session and delegation ID. Act on the request and use voice(action="say", sessionId, delegationId, text) to return a natural spoken reply. Use voice(action="end") only when asked to end the call. To phone someone, use voice(action="call", to, name, brief, callback): it dials from Kenan\'s number and starts a dedicated call agent with full tools that handles the conversation and reports the outcome and transcript back to you. The brief must say who the person is and the context, the goal of the call, what may and may not be revealed, and how to act in the owner\'s best interest. Before any call or message to a person, model their mind: simulate what they want, fear, already know and are incentivised by, how they will read the contact, and what would make agreeing easy for them. Callers that flatten the other person into a function fail; put that model in the brief. callback is "kenan-line" only when the person may call back on Kenan\'s own line; otherwise "none", and the caller then gives no phone number at all. The caller never states contact details that are not in the brief. Voicemail is handled on the line: the caller waits for the beep, then leaves the brief\'s message once, so give a voicemail message in the brief.',
  tool: ctx => {
    /** Where a reply to this delegation is spoken, if the session and delegation are the owner's. */
    const replyTo = (sessionId: string, delegationId: string): ((chunk: string) => void) | null => {
      const call = calls.get(sessionId);
      if (call) return call.ownerId === ctx.person.id ? speaker(call, delegationId) : null;
      const session = sessions.get(sessionId);
      if (!session || session.ownerId !== ctx.person.id || !session.delegations.has(delegationId)) return null;
      return chunk => session.socket.send({ type: 'session.commentary.append', event_id: randomUUID(), delegation_id: delegationId, content: chunk });
    };
    return {
    name: 'voice', files: 'none', label: 'Voice', description: 'Place outbound phone calls, or reply to, list or end live voice and phone sessions. call takes to (E.164), name, brief and callback and returns the session and call agent. digits presses keypad keys on a live phone call (sessionId, digits, and delegationId when a live request asked for the key: it answers that request silently). List returns {items,nextCursor}, up to 20 active sessions per page (max 50). status reports live, meeting and telephone capability.',
    parameters: Type.Object({ ...pageParameters, action: Type.Union([Type.Literal('list'), Type.Literal('say'), Type.Literal('end'), Type.Literal('status'), Type.Literal('call'), Type.Literal('digits')]), digits: Type.Optional(Type.String({ description: 'Keypad keys for action digits: 0-9, *, #, A-D, and w for a half-second pause' })), callback: Type.Optional(Type.Union([Type.Literal('kenan-line'), Type.Literal('none')], { description: 'Required for call. kenan-line: the caller may give Kenan\'s own line as the callback number. none: it gives no phone number.' })), sessionId: Type.Optional(Type.String()), delegationId: Type.Optional(Type.String()), text: Type.Optional(Type.String()), to: Type.Optional(Type.String({ description: 'E.164 number to call, e.g. +15105550100' })), name: Type.Optional(Type.String({ description: 'Who is being called' })), brief: Type.Optional(Type.String({ description: 'Who they are and context, a model of their mind (what they want, fear, know and are incentivised by, how they will likely read this call and react, what would make yes easy for them), the goal, what may and may not be revealed, and how to act in the owner\'s best interest' })) }),
    streamArgs(callId: string, args: Record<string, unknown>) {
      if (!isSay(args)) return;
      const speak = replyTo(args.sessionId, args.delegationId);
      if (speak) streamReply(callId, args.delegationId, args.text, speak);
    },
    async execute(callId: string, args: any) {
      const config = settings(ctx.person);
      if (args.action === 'status') return result({ live: config.live?.kind, meeting: config.meeting?.kind, telephone: telephoneConfig(config.telephone).kind });
      if (args.action === 'list') return result(arrayPage([...[...sessions.values()].filter(s => s.ownerId === ctx.person.id).map(s => ({ id: s.id, kind: 'live', conversationId: s.conversationId })), ...[...calls.values()].filter(c => c.ownerId === ctx.person.id).map(c => ({ id: c.id, kind: 'phone', to: c.to, callAgentId: c.callAgentId }))], args, `voice:${ctx.person.id}`, s => s.id));
      if (args.action === 'call') {
        const telephone = telephoneConfig(config.telephone);
        if (telephone.kind !== 'configured') throw new Error(`Telephone is unavailable: ${telephone.factor}`);
        if (typeof args.to !== 'string' || typeof args.brief !== 'string' || typeof args.name !== 'string') throw new Error('to, name and brief are required');
        if (args.callback !== 'kenan-line' && args.callback !== 'none') throw new Error(`callback is required: "kenan-line" lets the caller give Kenan's line ${telephone.fromNumber} as the callback number, "none" means it gives no phone number`);
        return result(await placeCall(ctx.deps, ctx.person, ctx.agent, telephone, { to: args.to, brief: args.brief, name: args.name, callback: args.callback }));
      }
      if (isSay(args) && args.text) {
        const speak = replyTo(args.sessionId, args.delegationId);
        if (!speak) throw new Error('Current delegationId and text required: this session has no such delegation');
        const { streamed } = finishReply(callId, args.delegationId, args.text, speak);
        const call = calls.get(args.sessionId);
        if (!call) return result({ spoken: true });
        replied(call, args.delegationId, streamed, args.text.length);
        const withheld = takeWithheld(call, args.delegationId);
        return result(withheld.length ? { spoken: 'partly', withheld, error: 'name_withheld: these sentences name the person you assist by a name this call\'s brief does not use, so they were not spoken. Say them again with voice say, naming the person only as the brief does, or as "the person I assist".' } : { spoken: true });
      }
      const call = calls.get(args.sessionId ?? '');
      if (call && call.ownerId === ctx.person.id) {
        if (args.action === 'end') { await hangUp(call); return result({ ending: true }); }
        if (args.action === 'digits') {
          const digits = parseDigits(args.digits);
          if (!digits.ok) throw new Error(digits.error);
          await pressDigits(call, digits.value);
          if (typeof args.delegationId !== 'string') return result({ pressing: digits.value });
          const answered = answerSilently(call, args.delegationId, `Kenan is pressing ${digits.value} on the keypad now. Say nothing about it; keep listening silently.`);
          return result({ pressing: digits.value, request: answered ? 'answered silently' : `no delegation ${args.delegationId} on this call to answer` });
        }
        throw new Error('Current delegationId and text required');
      }
      const session = sessions.get(args.sessionId ?? '');
      if (!session || session.ownerId !== ctx.person.id) throw new Error('Voice session not found');
      if (args.action === 'end') { close(session); return result({ ended: true }); }
      throw new Error('Current delegationId and text required');
    },
  };
  },
  publicSockets: phoneSockets,
  hooks(app, deps) {
    // Retell's inbound-call webhook for Kenan's line: which agent answers this call.
    app.post('/phone/inbound/:capability', async c => {
      const body = await c.req.json().catch(() => null) as { event?: unknown; call_inbound?: { call_id?: unknown; from_number?: unknown; to_number?: unknown } } | null;
      const inbound = body?.event === 'call_inbound' ? body.call_inbound : undefined;
      if (!inbound || typeof inbound.call_id !== 'string' || !/^call_[A-Za-z0-9]{1,195}$/.test(inbound.call_id) || typeof inbound.to_number !== 'string') return c.json({ error: 'not an inbound call' }, 400);
      const line = inboundLine(deps, inbound.to_number, c.req.param('capability'));
      if (!line) return c.json({ error: 'unknown line' }, 404);
      const from = typeof inbound.from_number === 'string' && /^\+[1-9]\d{7,14}$/.test(inbound.from_number) ? inbound.from_number : null;
      try {
        const agentId = await acceptInbound(deps, line, { providerCallId: inbound.call_id, from });
        return c.json({ call_inbound: { override_agent_id: agentId } });
      } catch (e) {
        await deps.store.logError('phone', `inbound ${inbound.call_id} from ${from ?? 'withheld'}: ${String(e)}`);
        return c.json({ error: 'could not answer' }, 503);
      }
    });
  },
  routes(app, deps) {
    app.post('/start', async c => {
      const ownerId = c.get('me' as never) as string;
      const person = deps.person(ownerId);
      if (!person?.extensions.includes('voice')) return c.json({ ok: false, error: { code: 'forbidden', message: 'Voice is not enabled' } }, 403);
      const body = await c.req.json();
      const conversation = await deps.store.getConversation(body.conversationId, ownerId);
      if (!conversation || !conversation.agentId || typeof body.sdp !== 'string') return c.json({ ok: false, error: { code: 'invalid_input', message: 'Agent conversation and SDP required' } }, 400);
      const config = settings(person);
      if (config.live?.kind !== 'configured' || config.voice?.kind !== 'configured') return c.json({ ok: false, error: { code: 'unavailable', message: 'Live voice is unavailable' } }, 503);
      const live = liveConfig(config.live);
      const client = liveClient(live);
      const response = await client.live.create({ session: { model: live.model, delegation: { type: 'client' }, instructions: `${config.voice.instructions}\n\nDelegation policy:\n${config.voice.delegationPolicy}`, audio: { output: { voice: config.voice.voice } }, store: false, client: { data_channel: { allowed_client_events: ['session.input_audio.mute', 'session.input_audio.unmute', 'session.close'], allowed_server_events: [{ type: 'session.started' }, { type: 'session.closed' }, { type: 'session.input_transcript.delta' }, { type: 'session.output_transcript.delta' }, { type: 'error' }] } } }, transport: { type: 'webrtc', sdp: body.sdp } });
      const socket = new SidebandWS(client, { session_id: response.session.id, graceful_close: true }, { reconnect: null, maxQueueSize: 65536 });
      const session: VoiceSession = { id: randomUUID(), ownerId, conversationId: conversation.id, providerId: response.session.id, socket, transcript: '', delegations: new Set(), unsubscribe: () => {} };
      sessions.set(session.id, session);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error('Voice connection timed out')); }, config.live.timeoutMs);
        socket.socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.socket.once('error', () => { clearTimeout(timer); reject(new Error('Voice connection failed')); });
      });
      void (async () => {
        try {
          for await (const incoming of socket.stream({ maxBufferedEvents: 256 })) {
            if (incoming.type !== 'message') continue;
            const event = incoming.message as any;
            if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') session.transcript += `${event.type === 'session.input_transcript.delta' ? 'Human' : 'Voice'}: ${event.delta}\n`;
            if (event.type === 'session.delegation.created' && event.delegation?.target === 'client' && !session.delegations.has(event.delegation.id)) {
              session.delegations.add(event.delegation.id);
              deps.runtime.deliver({ agentId: conversation.agentId!, kind: 'human', live: { delegationId: event.delegation.id }, fromId: ownerId, conversationId: conversation.id, text: `${LIVE_REQUEST} Session ${session.id}; delegation ${event.delegation.id}.\n${session.transcript}` });
            }
            if (event.type === 'session.closed') { socket.close(); sessions.delete(session.id); break; }
          }
        } catch (e) { await deps.store.logError('voice', String(e)); socket.close(); sessions.delete(session.id); }
      })();
      return c.json({ ok: true, value: { sessionId: session.id, sdp: response.transport.sdp } });
    });
    app.post('/:id/end', c => {
      const session = sessions.get(c.req.param('id'));
      if (!session || session.ownerId !== c.get('me' as never)) return c.json({ ok: false, error: { code: 'not_found', message: 'Voice session not found' } }, 404);
      close(session); return c.json({ ok: true, value: null });
    });
  },
  start: startPhone,
  async stop() { for (const session of sessions.values()) close(session); await stopPhone(); },
};
