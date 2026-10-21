import { describe, expect, it } from 'vitest';
import { dtmfFrames, parseDigits } from './phone-dtmf.js';

describe('keypad digits', () => {
  it('accepts keys and pauses and rejects anything else', () => {
    expect(parseDigits('1 2-3#')).toEqual({ ok: true, value: '123#' });
    expect(parseDigits('1w#')).toEqual({ ok: true, value: '1w#' });
    expect(parseDigits('one').ok).toBe(false);
    expect(parseDigits('').ok).toBe(false);
  });
  it('plays 100 ms of lead-in, then 200 ms of tone and 140 ms of quiet per key, 500 ms per pause', () => {
    const keys = parseDigits('1w');
    if (!keys.ok) throw new Error(keys.error);
    expect(dtmfFrames(keys.value, 8000).length).toBe(5 + 10 + 7 + 25);
  });
});
