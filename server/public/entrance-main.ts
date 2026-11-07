// systemd entry for the public entrance (pi-stack-next-public-ingress.service, installed by deploy/install-entrance.sh).
// The configuration, with the Google client secret and Alice's account secret, arrives only as a systemd credential.
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createEntrance, type Account, type EntranceConfig } from './entrance.js';
import type { GoogleIdentity } from './google-identity.js';

export const ENROLL_SOCKET = '/run/kenan-enroll/enroll.sock';
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Asks the root enrollment service (deploy/kenan-enroll.py) for this verified person's account, creating it on first sign-in. */
export function enroll(identity: GoogleIdentity, socketPath = ENROLL_SOCKET): Promise<Account> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/enroll', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 16384) req.destroy(new Error('Enrollment response exceeded bound')); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`Enrollment answered ${res.statusCode}`);
          const account = JSON.parse(body) as Account;
          if (typeof account.accountId !== 'string' || !ACCOUNT_ID.test(account.accountId) || typeof account.accountSecret !== 'string' || account.accountSecret.length < 24) throw new Error('Invalid enrollment response');
          resolve(account);
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(120000, () => req.destroy(new Error('Enrollment timed out')));
    req.on('error', reject);
    req.end(JSON.stringify({ subject: identity.subject, email: identity.email, hostedDomain: identity.hostedDomain }));
  });
}

const directory = process.env.CREDENTIALS_DIRECTORY;
if (!directory) throw new Error('Systemd-owned entrance credentials required');
const configuration = JSON.parse(await readFile(`${directory}/configuration`, 'utf8')) as EntranceConfig;
createEntrance(configuration, identity => enroll(identity)).listen(8788, '127.0.0.1', () => console.log(JSON.stringify({ type: 'started', listen: '127.0.0.1:8788', signIn: 'google', hostedDomain: configuration.google.hostedDomain })));
