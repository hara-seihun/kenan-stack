import { chromium } from 'playwright-core';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { meet, type JoinerEvent } from '../server/extensions/meeting-joiner.ts';
const [cfgPath, url, out, mic] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(cfgPath!, 'utf8'));
const b = await chromium.connectOverCDP(cfg.cdp);
const ctx = b.contexts()[0]!;
for (const p of ctx.pages()) await p.goto('about:blank').catch(() => {});
await ctx.addInitScript('globalThis.__name ??= (f => f)');
if (mic) { await ctx.addInitScript({ path: mic }); await ctx.grantPermissions(['microphone', 'camera'], { origin: 'https://meet.google.com' }).catch(() => {}); }
const page = await ctx.newPage();
writeFileSync(out!, '');
const emit = (e: JoinerEvent) => { appendFileSync(out!, JSON.stringify(e) + '\n'); };
const t = Date.now();
if (process.env.RAW) { const { readMeetPage } = await import('../server/extensions/meeting-joiner.ts'); setInterval(async () => { try { const p = await page.evaluate(readMeetPage); appendFileSync(process.env.RAW!, JSON.stringify({ at: Date.now(), captions: p.captions, participants: p.participants, badge: p.peopleBadge, chat: p.chat }) + '\n'); } catch {} }, 1000); }
let stop: string | null = null;
setTimeout(() => { stop = 'harness time limit'; }, Number(process.env.LIMIT_MS ?? 240000));
const reason = await meet(page, { sessionId: 'h', meetingUrl: url!, displayName: 'Kenan (notetaker)', announcement: 'Hi, I am Kenan, a notetaker taking notes and a transcript for Alice. If you would rather I did not, type or say "Kenan, leave" and I will leave right away.', chrome: '', profile: null, admitUntil: t + 120000, capAt: t + 600000, aloneGraceMs: Number(process.env.ALONE_MS ?? 600000) }, emit, () => null, () => stop, (reason, detail) => { emit({ kind: 'state', state: 'left', at: Date.now(), reason, detail }); return reason; });
console.log('reason', reason);
await page.screenshot({ path: '/var/tmp/meet-proto/harness-end.png' }).catch(() => {});
process.exit(0);
