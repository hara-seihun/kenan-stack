import { apiPath } from '../path.js';
import { useEffect, useRef, useState } from 'react';

type VoiceResources = { pc: RTCPeerConnection; media: MediaStream; audio: HTMLAudioElement; id?: string };
const finishSession = async (id: string) => {
  await fetch(apiPath(`/api/ext/voice/${encodeURIComponent(id)}/end`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
};
const release = (value: VoiceResources) => {
  value.media.getTracks().forEach(track => track.stop()); value.pc.close(); value.audio.pause(); value.audio.srcObject = null;
};
export function Voice({ conversationId }: { conversationId: string }) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resources = useRef<VoiceResources | null>(null);
  const generation = useRef(0);
  const end = async () => {
    generation.current++;
    const value = resources.current; resources.current = null;
    if (value) release(value);
    setActive(false); setBusy(false);
    if (value?.id) await finishSession(value.id);
  };
  useEffect(() => () => { void end(); }, [conversationId]);
  async function start() {
    const attempt = ++generation.current;
    setError(''); setBusy(true);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt !== generation.current) { media.getTracks().forEach(track => track.stop()); return; }
      const pc = new RTCPeerConnection(); const audio = new Audio(); audio.autoplay = true;
      const value: VoiceResources = { pc, media, audio }; resources.current = value;
      pc.ontrack = event => { audio.srcObject = event.streams[0] ?? new MediaStream([event.track]); void audio.play().catch(() => {}); };
      media.getTracks().forEach(track => pc.addTrack(track, media)); pc.createDataChannel('oai-events');
      await pc.setLocalDescription(await pc.createOffer());
      if (attempt !== generation.current) return;
      const response = await fetch(apiPath('/api/ext/voice/start'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId, sdp: pc.localDescription?.sdp }) });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error?.message ?? 'Voice could not start');
      value.id = data.value.sessionId;
      // A conversation change may happen while the server is creating the session.
      if (attempt !== generation.current) { await finishSession(value.id!); return; }
      await pc.setRemoteDescription({ type: 'answer', sdp: data.value.sdp });
      if (attempt !== generation.current) return;
      pc.onconnectionstatechange = () => { if (attempt === generation.current && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) void end(); };
      setActive(true);
    } catch (e) {
      if (attempt === generation.current) { setError(String(e instanceof Error ? e.message : e)); await end(); }
    } finally { if (attempt === generation.current) setBusy(false); }
  }
  return <span><button type="button" disabled={busy} onClick={() => void (active ? end() : start())}>{busy ? 'Connecting…' : active ? 'End voice' : 'Voice'}</button>{error && <span role="alert">{error}</span>}</span>;
}
