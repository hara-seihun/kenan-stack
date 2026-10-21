// Usage (after npm run build): node deploy/web-push/live-check.mjs REPO_DIR VAPID_KEY_JSON  — exits 0 when the pushed notification was shown.
// Live Web Push check: real Chrome subscribes through the built service worker, the server's sender pushes via the real push service.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
const repo = process.argv[2], keyPath = process.argv[3];
const { createWebPush, loadVapidKeys, pushPayload, pushOptions } = await import(join(repo, 'dist/server/server/web-push.js')).catch(() => import(join(repo, 'dist/server/web-push.js')));
const root = join(repo, 'dist/web');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = join(root, path === '/' ? 'index.html' : path);
  if (path.startsWith('/api/') || !existsSync(file)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false}'); }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;
const browser = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'push-live-')), { executablePath: '/srv/kenan/toolchains/chrome-154.0.8037.92/chrome', headless: process.env.HEADED ? false : true, args: ['--no-sandbox'] });
try {
  await browser.grantPermissions(['notifications'], { origin });
  const page = await browser.newPage();
  await page.goto(origin + '/');
  const keys = loadVapidKeys(keyPath);
  const sender = createWebPush(keys, 'https://kenan.example.com');
  const subscription = await page.evaluate(async publicKey => {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    return (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })).toJSON();
  }, sender.publicKey);
  console.log('subscribed endpoint origin:', new URL(subscription.endpoint).origin);
  const sentAt = Date.now();
  const outcome = await sender.send(subscription, pushPayload({ id: 4242, title: 'Live push check', body: 'Sent through ' + new URL(subscription.endpoint).host, level: 'normal', conversationId: '00000000-0000-0000-0000-000000000001' }), pushOptions('normal'));
  console.log('push service outcome:', JSON.stringify(outcome));
  const shown = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    for (let i = 0; i < 60; i++) { const list = await registration.getNotifications(); if (list.length) return list.map(n => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })); await new Promise(r => setTimeout(r, 500)); }
    return [];
  });
  console.log('service worker showed:', JSON.stringify(shown), `after ${Date.now() - sentAt} ms`);
  process.exitCode = shown.length ? 0 : 1;
} finally { await browser.close(); server.close(); }
