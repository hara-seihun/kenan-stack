// Startup measurement: opens the app like a phone would and records bytes, requests, first paint and the
// moment the chat is usable (composer present and history rendered). Run inside the kenan-phone network
// namespace (phone-netns.sh) to model a cellular mesh link; CPU is throttled like a mid-range phone.
//
//   node bench/startup/measure.mjs --origin https://beta.kenan.example.com \
//     --cookies ~/.cache/app-fast-load/beta-alice.cookies --runs 3 [--cpu 4] [--resolve 10.211.0.1] [--viewport phone|desktop]
//
// Scenarios: `first` (empty profile: first ever open), `cold` (browser restarted with the same profile:
// the app process starting again with its caches), `warm` (the same page reloaded in a running browser).
import { chromium } from 'playwright-core';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: {
  origin: { type: 'string' }, cookies: { type: 'string' }, runs: { type: 'string', default: '3' }, cpu: { type: 'string', default: '4' },
  resolve: { type: 'string' }, viewport: { type: 'string', default: 'phone' }, chrome: { type: 'string', default: '/srv/kenan/toolchains/chrome-154.0.8037.92/chrome' },
  label: { type: 'string', default: '' },
} });
if (!opt.origin || !opt.cookies) throw new Error('--origin and --cookies are required');
const origin = new URL(opt.origin);
const cookieLine = (await readFile(opt.cookies, 'utf8')).trim().split('\n').find(l => l.includes('kenan_session'));
if (!cookieLine) throw new Error(`no kenan_session in ${opt.cookies}`);
const token = cookieLine.split('\t').at(-1);
const viewport = opt.viewport === 'desktop' ? { viewport: { width: 1280, height: 900 } } : { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
const args = opt.resolve ? [`--host-resolver-rules=MAP ${origin.hostname} ${opt.resolve}`] : [];

const probe = () => {
  const t = { usable: null, history: null, composer: null, live: null };
  const check = () => {
    const now = performance.now();
    if (t.composer === null && document.querySelector('.composer textarea')) t.composer = now;
    if (t.history === null && document.querySelector('.transcript article.message')) t.history = now;
    if (t.usable === null && t.composer !== null && t.history !== null) t.usable = now;
    if (t.live === null && document.documentElement.dataset.live === 'true') t.live = now;
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-live'] });
  window.__startup = t;
};

async function open(context) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(opt.cpu) });
  const requests = new Map();
  let bytes = 0, usableAt = null;
  cdp.on('Network.requestWillBeSent', e => { if (usableAt === null) requests.set(e.requestId, { url: e.request.url, bytes: 0, fromCache: false }); });
  cdp.on('Network.requestServedFromCache', e => { const r = requests.get(e.requestId); if (r) r.fromCache = true; });
  cdp.on('Network.responseReceived', e => { const r = requests.get(e.requestId); if (r && (e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache)) r.fromCache = true; });
  cdp.on('Network.dataReceived', e => { if (usableAt !== null) return; const r = requests.get(e.requestId); if (r) { r.bytes += e.encodedDataLength; bytes += e.encodedDataLength; } });
  cdp.on('Network.loadingFinished', e => { if (usableAt !== null) return; const r = requests.get(e.requestId); if (r && e.encodedDataLength > r.bytes) { bytes += e.encodedDataLength - r.bytes; r.bytes = e.encodedDataLength; } });
  await page.addInitScript(probe);
  const started = Date.now();
  await page.goto(origin.href, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__startup !== undefined && window.__startup.usable !== null && window.__startup.live !== null, null, { timeout: 60_000, polling: 50 })
    .catch(async e => { console.error(await page.evaluate(() => [JSON.stringify(window.__startup), document.body?.innerHTML.slice(0, 400)])); throw e; });
  const t = await page.evaluate(() => ({ ...window.__startup, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, nav: performance.timeOrigin }));
  usableAt = Date.now();
  const network = [...requests.values()].filter(r => !r.url.startsWith('data:'));
  return { page, wall: usableAt - started, fcp: t.fcp, history: t.history, usable: t.usable, live: t.live, bytes, requests: network.length, network: network.filter(r => !r.fromCache).length,
    detail: network.map(r => `${r.fromCache ? 'cache' : 'net'} ${r.bytes} ${new URL(r.url).pathname.slice(0, 60)}`) };
}

const results = { first: [], cold: [], warm: [] };
for (let run = 0; run < Number(opt.runs); run++) {
  const profile = await mkdtemp(join(tmpdir(), 'kenan-startup-'));
  const launch = () => chromium.launchPersistentContext(profile, { headless: true, executablePath: opt.chrome, args, ...viewport });
  let context = await launch();
  await context.addCookies([{ name: 'kenan_session', value: token, domain: origin.hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 86400 }]);
  let r = await open(context); results.first.push(r);
  await r.page.waitForTimeout(3000); // let caches and any service worker settle, as after a real first use
  await context.close();
  context = await launch();
  r = await open(context); results.cold.push(r);
  await r.page.waitForTimeout(1500);
  await r.page.close();
  r = await open(context); results.warm.push(r);
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
const median = xs => { const s = xs.filter(x => x !== null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const round = x => x === null ? null : Math.round(x);
const summary = Object.fromEntries(Object.entries(results).map(([k, rs]) => [k, {
  usableMs: round(median(rs.map(r => r.usable))), liveMs: round(median(rs.map(r => r.live))), fcpMs: round(median(rs.map(r => r.fcp))), historyMs: round(median(rs.map(r => r.history))),
  kB: Math.round(median(rs.map(r => r.bytes)) / 102.4) / 10, requests: median(rs.map(r => r.requests)), fromNetwork: median(rs.map(r => r.network)),
  runs: rs.map(r => round(r.usable)),
}]));
console.log(JSON.stringify({ label: opt.label, origin: origin.href, cpu: Number(opt.cpu), summary, sample: Object.fromEntries(Object.entries(results).map(([k, rs]) => [k, rs[0].detail])) }, null, 1));
