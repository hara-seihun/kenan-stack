import { describe, expect, it } from 'vitest';
import { finishReply, liveAnswered, streamReply } from './live.js';

describe('live replies', () => {
  it('speaks each sentence as soon as it is written and the rest when the call completes, once each', () => {
    const spoken: string[] = [];
    const speak = (chunk: string) => spoken.push(chunk);
    const final = 'Shortest hop is Central to Harbour: one stop. About seven minutes, so leave at one.';
    for (let at = 1; at < final.length; at += 7) streamReply('call_1', 'del_1', final.slice(0, at), speak);
    expect(spoken[0]).toBe('Shortest hop is Central to Harbour:');
    expect(liveAnswered('del_1')).toBe(false);
    finishReply('call_1', 'del_1', final, speak);
    expect(spoken.join(' ')).toBe(final);
    expect(liveAnswered('del_1')).toBe(true);
  });
});
