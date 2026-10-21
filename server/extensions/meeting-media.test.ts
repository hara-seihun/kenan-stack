import { describe, expect, it, vi } from 'vitest';
import { installMeetingMedia, renderMeetingMediaPage } from './meeting-media.js';
const config = { meetingId: 'meeting', conversationId: 'native', voiceStartUrl: '/api/ext/voice/start', voiceBaseUrl: '/api/ext/voice' };
function fixture() {
  const track = { kind: 'audio', readyState: 'live', stop: vi.fn() };
  class Stream { tracks: any[] = []; getTracks() { return this.tracks; } getAudioTracks() { return this.tracks; } addTrack(t: any) { this.tracks.push(t); } }
  const audio = { autoplay: false, srcObject: null, setAttribute: vi.fn(), play: vi.fn(async () => {}), pause: vi.fn(), remove: vi.fn() };
  const peer = { ontrack: null as any, onconnectionstatechange: null, connectionState: 'new', localDescription: { sdp: 'real-offer' }, addTrack: vi.fn(), createDataChannel: vi.fn(), createOffer: vi.fn(async () => ({})), setLocalDescription: vi.fn(async () => {}), setRemoteDescription: vi.fn(async () => {}), close: vi.fn() };
  const fetch = vi.fn(async (..._args: any[]) => ({ ok: true, json: async () => ({ ok: true, value: { sessionId: 'voice-id', sdp: 'answer' } }) }));
  const env = { MediaStream: Stream, RTCPeerConnection: function () { return peer; }, document: { createElement: () => audio, body: { appendChild: vi.fn() }, getElementById: () => ({ textContent: '' }) }, fetch, addEventListener: vi.fn() };
  const input = { getAudioTracks: () => [track] };
  return { env, peer, fetch, input, track, audio };
}
describe('meeting media transport', () => {
  it('negotiates only explicit input through native voice and never stops borrowed tracks', async () => {
    const f = fixture(); const api = installMeetingMedia(config, f.env);
    expect(f.fetch).not.toHaveBeenCalled();
    await api.start(f.input);
    expect(JSON.parse(f.fetch.mock.calls[0]![1].body)).toEqual({ conversationId: 'native', sdp: 'real-offer' });
    expect(f.peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer' });
    f.peer.ontrack({ track: f.track });
    expect(api.outputStream.getTracks()).toEqual([f.track]);
    await api.stop(); await api.stop();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    expect(f.audio.remove).toHaveBeenCalledTimes(1);
  });
  it('rejects absent input and duplicate start', async () => {
    const f = fixture(); const api = installMeetingMedia(config, f.env);
    await expect(api.start({ getAudioTracks: () => [] })).rejects.toThrow('live meeting audio');
    await api.start(f.input);
    await expect(api.start(f.input)).rejects.toThrow('already started');
    await api.stop(); expect(f.track.stop).not.toHaveBeenCalled();
  });
  it('cleans up a session returned after an opt-out during start', async () => {
    const f = fixture(); let answer: any;
    f.fetch.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const api = installMeetingMedia(config, f.env);
    const pending = api.start(f.input);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    await api.stop();
    answer({ ok: true, json: async () => ({ ok: true, value: { sessionId: 'late', sdp: 'answer' } }) });
    await pending;
    expect(f.fetch.mock.calls[1]![0]).toBe('/api/ext/voice/late/end');
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
  });
  it('retains failed remote cleanup for explicit retry without restarting media', async () => {
    const f = fixture(); const api = installMeetingMedia(config, f.env); await api.start(f.input);
    f.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as any);
    await expect(api.stop()).rejects.toThrow('cleanup failed');
    expect(api.sessionId).toBe('voice-id'); await api.stop(); expect(api.sessionId).toBeUndefined();
    expect(f.peer.close).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed, oversized or unaligned PCM before creating audio resources', () => {
    const f = fixture(); const api = installMeetingMedia(config, f.env);
    for (const packet of [{ data: '***', sampleRate: 16000, channels: 1 }, { data: 'AA==', sampleRate: 16000, channels: 1 }, { data: 'AAAA', sampleRate: 16000, channels: 1 }, { data: 'AAAA', sampleRate: 999999, channels: 1 }]) {
      expect(() => api.pushAudio(packet)).toThrow();
    }
  });
  it('converts actual interleaved PCM into bounded continuous audio and releases owned tracks', async () => {
    const f = fixture(); const samples: Float32Array[] = []; const starts: number[] = [];
    const ownedTrack = { stop: vi.fn() };
    const source = () => ({ buffer: null, connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start: (time: number) => starts.push(time) });
    const close = vi.fn(async () => {});
    const context = { currentTime: 0, resume: vi.fn(async () => {}), close,
      createMediaStreamDestination: () => ({ stream: { getTracks: () => [ownedTrack], getAudioTracks: () => [{ readyState: 'live' }] } }),
      createBuffer: (channels: number, frames: number, rate: number) => {
        const data = Array.from({ length: channels }, () => new Float32Array(frames)); samples.push(...data);
        return { duration: frames / rate, getChannelData: (channel: number) => data[channel] };
      }, createBufferSource: source };
    Object.assign(f.env, { AudioContext: function () { return context; }, atob: (s: string) => Buffer.from(s, 'base64').toString('binary') });
    const api = installMeetingMedia(config, f.env);
    await api.startPCM();
    api.pushAudio({ data: Buffer.from([0,128,255,127]).toString('base64'), sampleRate: 16000, channels: 2 });
    expect(samples[0]![0]).toBe(-1); expect(samples[1]![0]).toBeCloseTo(32767 / 32768);
    api.pushAudio({ data: Buffer.alloc(32000).toString('base64'), sampleRate: 16000, channels: 1 });
    api.pushAudio({ data: Buffer.alloc(32000).toString('base64'), sampleRate: 16000, channels: 1 });
    expect(starts[1]).toBeCloseTo(0.0200625); expect(starts[2]).toBeCloseTo(1.0200625);
    expect(() => api.pushAudio({ data: 'AAA=', sampleRate: 16000, channels: 1 })).toThrow('backlog');
    await api.stop(); expect(ownedTrack.stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(() => api.pushAudio({ data: 'AAA=', sampleRate: 16000, channels: 1 })).toThrow('stopped');
  });
  it('embeds standalone controller without script injection or arbitrary provider URLs', () => {
    const html = renderMeetingMediaPage({ ...config, meetingId: '</script><script>evil()', title: '<bad>' });
    expect(html).not.toContain('</script><script>evil()'); expect(html).toContain('&lt;bad&gt;');
    expect(html).not.toContain('getUserMedia');
    expect(() => renderMeetingMediaPage({ ...config, voiceStartUrl: '//evil/start' })).toThrow();
    expect(() => renderMeetingMediaPage({ ...config, voiceBaseUrl: '/voice?token=x' })).toThrow();
  });
});
