/// <reference lib="dom" />
/**
 * Signs the notetaker's Chrome profile in to Google, so tools.meeting.native.profile can point at it.
 * Run as the account the joiner runs as (its uid owns the profile). Two ways:
 *   printf '%s\n%s\n' "$PASSWORD" "$BACKUP_CODE" | node dist/server/extensions/meeting-joiner-login.js PROFILE_DIR EMAIL
 *     signs in here. The second line (an 8-digit 2-Step Verification backup code) is used only if Google asks for one.
 *     Google answers a datacenter address (a cloud VM) with a CAPTCHA; that is reported, never solved.
 *   sudo cat STATE.json | node dist/server/extensions/meeting-joiner-login.js PROFILE_DIR EMAIL --storage-state
 *     imports a session signed in elsewhere (a browser with residential egress), as Playwright storageState JSON
 *     ({cookies:[...]}) or a bare cookie array, then checks Google and Meet accept it from this host.
 * Prints the signed-in account on success; exits 1 with what Google showed otherwise. Secrets only ever arrive on stdin.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { devtoolsPort, startXvfb } from './meeting-joiner.js';
import { startCloudBrowser, stopCloudBrowser } from './meeting-cloud-browser.js';

/** Google's sign-in page asks for typed text from an image or audio clip: a CAPTCHA this tool must not answer. */
export const isCaptcha = (pageText: string) => /type the text you hear or see/i.test(pageText);

export type ImportedCookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' };
/**
 * The cookies to import from storageState JSON or a cookie array. Session cookies (expires -1) would vanish when the
 * profile's Chrome closes, and every meeting starts a fresh Chrome on a copy, so they get sessionDays of life instead.
 */
export function cookiesToImport(raw: unknown, now: number, sessionDays = 30): ImportedCookie[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { cookies?: unknown }).cookies) ? (raw as { cookies: unknown[] }).cookies : null;
  if (!list) throw new Error('storage state must be Playwright storageState JSON ({"cookies":[...]}) or a cookie array');
  const cookies = list.map((c, i): ImportedCookie => {
    const r = c as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.value !== 'string' || typeof r.domain !== 'string') throw new Error(`cookie ${i} needs name, value and domain`);
    const expires = typeof r.expires === 'number' && r.expires > 0 ? r.expires : Math.floor(now / 1000) + sessionDays * 86400;
    const sameSite: ImportedCookie['sameSite'] = r.sameSite === 'Strict' || r.sameSite === 'Lax' || r.sameSite === 'None' ? r.sameSite : 'Lax';
    return { name: r.name, value: r.value, domain: r.domain, path: typeof r.path === 'string' ? r.path : '/', expires, httpOnly: r.httpOnly === true, secure: r.secure === true || sameSite === 'None', sameSite };
  });
  if (!cookies.some(c => /(^|\.)google\.com$/.test(c.domain.replace(/^\./, '')) && /SID$/.test(c.name))) throw new Error('storage state has no Google sign-in cookies (no *SID cookie for google.com)');
  return cookies;
}

async function main() {
  const [profile, email, mode] = process.argv.slice(2);
  // PROFILE is a local Chrome user-data directory, or, with --cloud, a Browser Use profile name (cloud-browser).
  if (!profile || !email || (mode !== undefined && mode !== '--storage-state' && mode !== '--cloud')) { console.error('usage: meet-joiner-login PROFILE EMAIL [--storage-state | --cloud]  (password and optional backup code, or storage state JSON, on stdin)'); process.exit(2); }
  const input = await new Promise<string>(resolve => { let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => resolve(s)); });
  const imported = mode === '--storage-state' ? cookiesToImport(JSON.parse(input), Date.now()) : null;
  const [password, backupCode] = imported ? [] : input.split('\n').map(s => s.trim());
  const cloud = mode === '--cloud';
  if (!cloud) mkdirSync(profile, { recursive: true, mode: 0o700 });
  const children: ChildProcess[] = [];
  let code = 1;
  let closeGracefully: (() => Promise<void>) | null = null;
  let shown: (() => Promise<string>) | null = null;
  try {
    const { chromium } = await import('playwright-core');
    let browser: import('playwright-core').Browser;
    if (cloud) {
      // Stopping the cloud browser saves its profile, cookies included.
      const remote = await startCloudBrowser(profile, 15);
      closeGracefully = async () => { await stopCloudBrowser(remote.session); };
      browser = await chromium.connectOverCDP(remote.cdp);
    } else {
      const display = await startXvfb(children);
      const chrome = spawn('/opt/google/chrome/chrome', [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--lang=en-US', 'about:blank'],
        { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
      children.push(chrome);
      const local = await chromium.connectOverCDP(`http://127.0.0.1:${await devtoolsPort(profile, 30_000)}`);
      browser = local;
      // Always close Chrome gracefully, even after a failed check: Google rotates session cookies as they are used, and
      // a hard kill would drop the rotated ones, leaving the profile (and the imported file) with stale cookies.
      closeGracefully = async () => {
        const exited = new Promise(resolve => { if (chrome.exitCode !== null) resolve(null); else chrome.once('exit', resolve); });
        await (await local.newBrowserCDPSession()).send('Browser.close').catch(() => {});
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 15_000))]);
      };
    }
    const context = browser.contexts()[0] ?? await browser.newContext(), page = context.pages()[0] ?? await context.newPage();
    const text = async () => (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 600);
    shown = async () => `${page.url().split('?')[0]}: ${await text()}`;
    const signedIn = async () => {
      await page.goto('https://myaccount.google.com/?hl=en', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      return page.url().startsWith('https://myaccount.google.com') && (await text()).toLowerCase().includes(email.toLowerCase());
    };
    if (imported) {
      await context.addCookies(imported);
    } else if (!(cloud && await signedIn())) {
      if (!password) throw new Error('not signed in, and no password on stdin');
      await page.goto('https://accounts.google.com/signin/v2/identifier?hl=en&continue=https://myaccount.google.com/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      // A profile that was signed in before shows an account chooser ("Signed out") instead of the email field.
      if (/accountchooser/.test(page.url())) await page.getByText(email, { exact: true }).first().click({ timeout: 15_000 });
      else { await page.locator('#identifierId').fill(email); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(4000);
      if (isCaptcha(await text())) throw new Error('Google asked for a CAPTCHA before the password (this host is a datacenter address). Sign in with --cloud, or from a browser with residential egress and import its storage state with --storage-state.');
      await page.locator('input[name=Passwd]').fill(password, { timeout: 20_000 }); await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
      if (/challenge\/(bc|selection)/.test(page.url())) {
        if (!backupCode) throw new Error(`Google wants 2-Step Verification and no backup code was given: ${await text()}`);
        if (/selection/.test(page.url())) await page.getByText('Enter one of your 8-digit backup codes').click();
        await page.locator('input[type=tel], input[name=backupCode]').first().fill(backupCode, { timeout: 15_000 }); await page.keyboard.press('Enter');
        await page.waitForTimeout(5000);
      } else if (/challenge\//.test(page.url())) throw new Error(`Google wants another verification step: ${page.url().split('?')[0]}: ${await text()}`);
    }
    if (!await signedIn()) throw new Error(`not signed in as ${email}; Google shows: ${await text()}`);
    // meet.google.com itself shows signed-out visitors a product page; /landing signs a Google session in to Meet.
    await page.goto('https://meet.google.com/landing?hl=en', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    if (!page.url().startsWith('https://meet.google.com/')) throw new Error(`Meet did not accept the session; it shows ${page.url()}`);
    console.log(`signed in as ${email}; ${cloud ? 'cloud profile' : 'profile'} ${profile}`);
    code = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (shown) console.error(`page: ${await shown().catch(() => 'unreadable')}`);
  }
  finally {
    if (closeGracefully) await closeGracefully().catch(error => console.error(`closing the browser failed: ${error instanceof Error ? error.message : String(error)}`));
    for (const c of children.reverse()) { try { c.kill('SIGTERM'); } catch {} }
  }
  process.exit(code);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
