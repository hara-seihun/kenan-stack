import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PersonConfig } from '../config.js';
import { parseTexts, readTexts, storeTexts, textsFile, waitForText } from './texts.js';

const person = async () => ({ home: await mkdtemp(join(tmpdir(), 'texts-')), uid: process.getuid!(), gid: process.getgid!() }) as PersonConfig;
const sms = { id: 'sms:1', source: 'sms' as const, app: 'com.google.android.apps.messaging', sender: '32665', body: 'Your DoorDash code is 482913', at: 1_000_000 };

describe('texts', () => {
  it('keeps each message once, even when it arrives both as an SMS and as its notification, in a private file', async () => {
    const p = await person();
    expect(await storeTexts(p, [sms], 5)).toHaveLength(1);
    expect(await storeTexts(p, [sms, { ...sms, id: 'n:1', source: 'notification', sender: 'DoorDash', at: sms.at + 3000 }], 6)).toHaveLength(0);
    expect(await storeTexts(p, [{ ...sms, id: 'sms:2', body: 'Your DoorDash code is 111111' }], 7)).toHaveLength(1);
    expect((await readTexts(p)).map(t => t.id)).toEqual(['sms:1', 'sms:2']);
    expect((await stat(textsFile(p))).mode & 0o777).toBe(0o600);
  });

  it('rejects malformed uploads', () => {
    expect(parseTexts({ texts: [{ ...sms, source: 'mms' }] }).ok).toBe(false);
    expect(parseTexts({ texts: [{ ...sms, body: '' }] }).ok).toBe(false);
    expect(parseTexts({ texts: [sms] })).toEqual({ ok: true, value: [sms] });
  });

  it('wait resolves with a matching text stored after it began, and times out otherwise', async () => {
    const p = await person();
    await storeTexts(p, [{ ...sms, id: 'old', body: 'old DoorDash code 000000' }], Date.now() - 60_000);
    const waiting = waitForText(p, 'doordash', Date.now(), 5000);
    setTimeout(() => void storeTexts(p, [{ ...sms, id: 'other', body: 'Hi from mum' }, { ...sms, id: 'new' }], Date.now()), 50);
    expect((await waiting)?.id).toBe('new');
    expect(await waitForText(p, 'nothing like this', Date.now(), 100)).toBeNull();
  });
});
