/** Browser-only media bridge. Routes/authentication and meeting policy belong to the caller.
 * No microphone acquisition, model client, provider credentials or automatic reconnect here.
 */
export type MeetingMediaPageOptions = {
  meetingId: string;
  conversationId: string;
  voiceStartUrl: string;
  /** Session id is appended as /:id/end. */
  voiceBaseUrl: string;
  title?: string;
};

/** Kept self-contained so the exact tested controller is embedded in the standalone page. */
export function installMeetingMedia(config: MeetingMediaPageOptions, env: any = globalThis): any {
  let stopped = false, starting = false, pc: any, context: any, destination: any;
  let ownedInput: any, input: any, sessionId: string | undefined, generation = 0, nextAudioTime = 0;
  const sources = new Set<any>();
  const output = new env.MediaStream();
  const audio = env.document.createElement('audio');
  audio.autoplay = true;
  audio.setAttribute('playsinline', '');
  audio.srcObject = output;
  env.document.body.appendChild(audio);
  const status = (text: string) => {
    const element = env.document.getElementById('status');
    if (element) element.textContent = text;
  };
  async function endRemote(id: string) {
    const response = await env.fetch(`${config.voiceBaseUrl}/${encodeURIComponent(id)}/end`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', keepalive: true,
    });
    if (!response.ok) throw new Error('Voice session cleanup failed');
  }
  async function stop() {
    if (!stopped) {
      stopped = true; generation++;
      if (pc) { pc.ontrack = null; pc.onconnectionstatechange = null; pc.close(); }
      for (const source of sources) { try { source.stop(); } catch {} source.disconnect(); }
      sources.clear();
      for (const track of ownedInput?.getTracks() ?? []) track.stop();
      for (const track of output.getTracks()) track.stop();
      audio.pause(); audio.srcObject = null; audio.remove();
      if (context) await context.close();
      status('Meeting media stopped');
    }
    // Retain the id when cleanup fails: an explicit subsequent stop may retry cleanup only.
    if (sessionId) { const id = sessionId; await endRemote(id); if (sessionId === id) sessionId = undefined; }
  }
  function ensureContext() {
    if (stopped) throw new Error('Meeting media stopped');
    if (!context) {
      context = new env.AudioContext(); destination = context.createMediaStreamDestination();
      ownedInput = destination.stream;
    }
    return context;
  }
  async function start(stream: any) {
    if (stopped || starting || pc) throw new Error('Meeting media is stopped or already started');
    const tracks = stream?.getAudioTracks().filter((track: any) => track.readyState === 'live');
    if (!tracks?.length) throw new Error('A live meeting audio input is required');
    starting = true; input = stream;
    const attempt = ++generation;
    try {
      pc = new env.RTCPeerConnection();
      pc.ontrack = (event: any) => {
        if (stopped || event.track.kind !== 'audio') return;
        output.addTrack(event.track);
        void audio.play().catch((error: unknown) => { status(`Audio playback failed: ${String(error)}`); void stop().catch((e: unknown) => status(String(e))); });
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(pc.connectionState) && !stopped) void stop().catch((e: unknown) => status(String(e)));
      };
      for (const track of tracks) pc.addTrack(track, input);
      pc.createDataChannel('oai-events');
      await pc.setLocalDescription(await pc.createOffer());
      if (stopped || attempt !== generation) return;
      const response = await env.fetch(config.voiceStartUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: config.conversationId, sdp: pc.localDescription?.sdp }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || typeof data.value?.sessionId !== 'string') throw new Error(data.error?.message ?? 'Voice start failed');
      sessionId = data.value.sessionId;
      if (stopped || attempt !== generation) { await stop(); return; }
      if (typeof data.value.sdp !== 'string') throw new Error('Voice SDP answer missing');
      await pc.setRemoteDescription({ type: 'answer', sdp: data.value.sdp });
      if (!stopped) status('Meeting voice connected');
    } catch (error) {
      try { await stop(); } catch (cleanup) { status(`Cleanup failed: ${String(cleanup)}`); }
      throw error;
    } finally { starting = false; }
  }
  /** Raw signed little-endian PCM from a real meeting audio transport, not synthetic speech.
   * Bounded queue prevents unbounded catch-up and enforces no silent audio drops.
   */
  function pushAudio(packet: { data: string; sampleRate: number; channels: number }) {
    if (stopped) throw new Error('Meeting media stopped');
    if (!packet || typeof packet.data !== 'string' || packet.data.length > 262144 ||
        !Number.isInteger(packet.sampleRate) || packet.sampleRate < 8000 || packet.sampleRate > 48000 ||
        ![1, 2].includes(packet.channels) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.data)) throw new Error('Invalid PCM packet');
    const binary = env.atob(packet.data);
    if (!binary.length || binary.length % (2 * packet.channels)) throw new Error('Unaligned PCM packet');
    const frames = binary.length / (2 * packet.channels);
    if (frames / packet.sampleRate > 1) throw new Error('PCM packet exceeds one second');
    const ctx = ensureContext();
    if (nextAudioTime - ctx.currentTime > 2) throw new Error('Meeting audio backlog exceeds two seconds');
    const buffer = ctx.createBuffer(packet.channels, frames, packet.sampleRate);
    for (let channel = 0; channel < packet.channels; channel++) {
      const values = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) {
        const offset = (frame * packet.channels + channel) * 2;
        const unsigned = binary.charCodeAt(offset) | binary.charCodeAt(offset + 1) << 8;
        values[frame] = (unsigned >= 32768 ? unsigned - 65536 : unsigned) / 32768;
      }
    }
    const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(destination);
    sources.add(source); source.onended = () => { sources.delete(source); source.disconnect(); };
    const when = Math.max(ctx.currentTime + 0.02, nextAudioTime);
    source.start(when); nextAudioTime = when + buffer.duration;
  }
  async function startPCM() {
    const ctx = ensureContext(); await ctx.resume();
    return start(ownedInput);
  }
  /** Explicit camera output for transports consuming a MediaStream instead of capturing the page.
   * No meeting content is painted here; the branded slate is the safe default.
   */
  function enableVideo() {
    if (stopped) throw new Error('Meeting media stopped');
    if (output.getTracks().some((track: any) => track.kind === 'video')) return output;
    const canvas = env.document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const paint = canvas.getContext('2d');
    if (!paint || typeof canvas.captureStream !== 'function') throw new Error('Canvas video unavailable');
    paint.fillStyle = '#111827'; paint.fillRect(0, 0, 1280, 720);
    paint.fillStyle = '#ffffff'; paint.font = '64px system-ui'; paint.textAlign = 'center';
    paint.fillText('Kenan', 640, 360);
    const stream = canvas.captureStream(1);
    for (const track of stream.getVideoTracks()) output.addTrack(track);
    return output;
  }
  const api = { start, startPCM, pushAudio, enableVideo, stop, outputStream: output,
    get stopped() { return stopped; }, get sessionId() { return sessionId; } };
  env.kenanMeetingMedia = api;
  env.addEventListener('pagehide', () => { void stop().catch(() => {}); }, { once: true });
  status('Waiting for authorized meeting audio');
  return api;
}

export function renderMeetingMediaPage(options: MeetingMediaPageOptions): string {
  for (const path of [options.voiceStartUrl, options.voiceBaseUrl]) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n?#]/.test(path)) throw new Error('Same-origin voice route required');
  }
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const config = JSON.stringify(options).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escape(options.title ?? 'Kenan meeting')}</title><style>html,body{margin:0;height:100%;background:#111827;color:white;font:24px system-ui}main{height:100%;display:grid;place-content:center;text-align:center}small{font-size:14px}</style></head><body><main><h1>Kenan</h1><small id="status">Waiting for meeting audio</small></main><script type="module">(${installMeetingMedia.toString()})(${config});</script></body></html>`;
}
