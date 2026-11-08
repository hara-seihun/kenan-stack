// Live voice with this chat's agent (extension `voice`), loaded lazily: tap the waveform to talk; the voice session
// answers aloud and hands real work to the chat's agent. In a call the button becomes a red pill (pulsing dot, the
// call's clock, End) with a mute toggle beside it. Leaving the chat ends the call.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiPath } from '../path.js';
import { beginUpdateActivity } from '../updateActivity.js';
import './Voice.css';

/** lucide's AudioLines, Mic, MicOff and PhoneOff, inline: importing lucide here would make the startup chunk export them. */
const Svg = ({ children }: { children: ReactNode }) => <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{children}</svg>;
const AudioLines = () => <Svg><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></Svg>;
const Mic = () => <Svg><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></Svg>;
const MicOff = () => <Svg><path d="M12 19v3"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M16.95 16.95A7 7 0 0 1 5 12v-2"/><path d="M18.89 13.23A7 7 0 0 0 19 12v-2"/><path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/></Svg>;
const PhoneOff = () => <Svg><path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272"/><path d="M22 2 2 22"/><path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"/></Svg>;

type Call = { pc: RTCPeerConnection; media: MediaStream; channel: RTCDataChannel; sessionId: string | null };
type Phase = { kind: 'idle' } | { kind: 'connecting' } | { kind: 'live'; since: number; muted: boolean };
type StartResponse = { ok: true; value: { sessionId: string; sdp: string } } | { ok: false; error: { code: string; message: string } };
/** Safari 16.4+: a call should use the play-and-record route (speaker with echo cancellation), not media playback. */
type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const finishSession = (id: string) => fetch(apiPath(`/api/ext/voice/${encodeURIComponent(id)}/end`), { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => undefined, () => undefined);
function micProblem(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') return 'Voice needs the microphone: allow it for this site (on iPhone: Settings → Apps → Safari → Microphone, or the aA menu → Website Settings) and tap the waveform again.';
  if (name === 'NotFoundError') return 'Voice found no microphone on this device.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app; close it and try again.';
  return `Voice could not start: ${error instanceof Error ? error.message : String(error)}`;
}
function setAudioSession(type: 'play-and-record' | 'auto') {
  const session = (navigator as AudioSessionNavigator).audioSession;
  if (session) session.type = type;
}

export function Voice({ conversationId, onError }: { conversationId: string; onError(message: string): void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const call = useRef<Call | null>(null);
  const generation = useRef(0);
  const activity = useRef<(() => void) | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const report = useRef(onError); report.current = onError;

  function end() {
    generation.current++;
    activity.current?.(); activity.current = null;
    const current = call.current; call.current = null;
    if (current) {
      current.media.getTracks().forEach(track => track.stop());
      current.channel.close(); current.pc.close();
      if (current.sessionId) void finishSession(current.sessionId);
    }
    const element = audio.current;
    if (element) { element.pause(); element.srcObject = null; }
    setAudioSession('auto');
    setPhase({ kind: 'idle' });
  }
  const fail = (attempt: number, message: string) => { if (attempt !== generation.current) return; end(); report.current(message); };

  useEffect(() => end, [conversationId]);
  useEffect(() => { const leave = () => end(); addEventListener('pagehide', leave); return () => removeEventListener('pagehide', leave); }, []);
  useEffect(() => {
    if (phase.kind !== 'live') return;
    // iOS mutes page microphone capture whenever the screen locks or the page is hidden, and no web API can prevent it
    // (WebKit bug 226620); the wake lock keeps the screen from auto-locking, and the warning says what happened.
    let sentinel: WakeLockSentinel | null = null, released = false;
    const hold = () => { if (released || document.visibilityState !== 'visible') return; void navigator.wakeLock?.request('screen').then(s => { if (released) void s.release(); else sentinel = s; }, () => undefined); };
    const tracks = call.current?.media.getAudioTracks() ?? [];
    const onMute = () => report.current('iPhone mutes the microphone when the screen locks. Keep the screen on.');
    const onVisible = () => { if (document.visibilityState === 'visible') hold(); };
    hold();
    document.addEventListener('visibilitychange', onVisible);
    tracks.forEach(t => t.addEventListener('mute', onMute));
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(id); released = true; void sentinel?.release();
      document.removeEventListener('visibilitychange', onVisible);
      tracks.forEach(t => t.removeEventListener('mute', onMute));
    };
  }, [phase.kind]);

  async function start() {
    activity.current?.();
    activity.current = beginUpdateActivity();
    const attempt = ++generation.current;
    setPhase({ kind: 'connecting' });
    if (!navigator.mediaDevices?.getUserMedia) return fail(attempt, 'This browser offers no microphone here.');
    // getUserMedia is the first await so that it runs inside the tap, which Safari requires.
    let media: MediaStream;
    try { media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { return fail(attempt, micProblem(e)); }
    if (attempt !== generation.current) { media.getTracks().forEach(track => track.stop()); return; }
    try {
      setAudioSession('play-and-record');
      const pc = new RTCPeerConnection();
      const channel = pc.createDataChannel('oai-events');
      const current: Call = { pc, media, channel, sessionId: null };
      call.current = current;
      pc.ontrack = event => {
        const element = audio.current;
        if (!element) return;
        element.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        // Safari lets a MediaStream play with sound while the page is capturing the microphone.
        void element.play().catch(e => fail(attempt, `Voice could not play the answer: ${e instanceof Error ? e.message : String(e)}`));
      };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') fail(attempt, 'The voice connection dropped.'); };
      channel.onmessage = message => {
        const event = JSON.parse(String(message.data)) as { type?: string; error?: { message?: string } };
        if (event.type === 'session.closed') { if (attempt === generation.current) end(); }
        else if (event.type === 'error') report.current(`Voice: ${event.error?.message ?? 'the session reported an error'}`);
      };
      media.getTracks().forEach(track => pc.addTrack(track, media));
      await pc.setLocalDescription(await pc.createOffer());
      if (attempt !== generation.current) return;
      const response = await fetch(apiPath('/api/ext/voice/start'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId, sdp: pc.localDescription!.sdp }) });
      const data = await response.json() as StartResponse;
      if (!data.ok) return fail(attempt, `Voice could not start: ${data.error.message}`);
      // The chat may have changed while the server was opening the session; end() already ran without its id.
      if (attempt !== generation.current) { void finishSession(data.value.sessionId); return; }
      current.sessionId = data.value.sessionId;
      await pc.setRemoteDescription({ type: 'answer', sdp: data.value.sdp });
      if (attempt !== generation.current) return;
      setNow(Date.now());
      setPhase({ kind: 'live', since: Date.now(), muted: false });
    } catch (e) { media.getTracks().forEach(track => track.stop()); fail(attempt, `Voice could not start: ${e instanceof Error ? e.message : String(e)}`); }
  }
  function toggleMute() {
    if (phase.kind !== 'live' || !call.current) return;
    const muted = !phase.muted, { media, channel } = call.current;
    media.getAudioTracks().forEach(track => { track.enabled = !muted; });
    if (channel.readyState === 'open') channel.send(JSON.stringify({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' }));
    setPhase({ ...phase, muted });
  }

  const player = <audio ref={audio} autoPlay playsInline/>;
  if (phase.kind === 'live') return <>
    {player}
    <button type="button" className={phase.muted ? 'voice-mute muted' : 'voice-mute'} aria-pressed={phase.muted} aria-label={phase.muted ? 'Unmute microphone' : 'Mute microphone'} title={phase.muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>{phase.muted ? <MicOff/> : <Mic/>}</button>
    <button type="button" className="voice-end" aria-label="End voice call" onClick={end}><span className="voice-dot" aria-hidden="true"/><span className="voice-clock" role="timer">{clock(now - phase.since)}</span><PhoneOff/></button>
  </>;
  const connecting = phase.kind === 'connecting';
  return <>{player}<button type="button" className={connecting ? 'voice connecting' : 'voice'} aria-busy={connecting} aria-label={connecting ? 'Connecting voice: tap to cancel' : 'Talk by voice'} title={connecting ? 'Connecting… (tap to cancel)' : 'Talk by voice'} onClick={() => connecting ? end() : void start()}><AudioLines/></button></>;
}
