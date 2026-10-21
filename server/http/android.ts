import { readFile } from 'node:fs/promises';
import { createHash, verify, X509Certificate } from 'node:crypto';
import type { Context, Hono } from 'hono';
import identities from '../../android/channels.json' with { type: 'json' };
import { fail } from '../db/errors.js';

interface Manifest { protocol: number; package: string; label: string; versionCode: number; versionName: string; size: number; sha256: string; signerCertificateSha256: string }
/** Keep the installed Android updater's signed, public feed and content-addressed APK URLs. */
export function androidRoutes(app: Hono<any>, channel: 'beta' | 'production', root = `/var/lib/kenan/android/${channel}`) {
  const identity = identities[channel];
  async function artifact() {
    try {
      const [payload, signature, certificate] = await Promise.all(['manifest.json','manifest.sig','signer.der'].map(name => readFile(`${root}/${name}`)));
      if (!payload || !signature || !certificate || payload.length > 4096 || signature.length > 1024) throw new Error('Invalid release files');
      const manifest = JSON.parse(payload.toString()) as Manifest;
      const cert = new X509Certificate(certificate);
      if (manifest.protocol !== 1 || manifest.package !== identity.androidPackage || manifest.label !== identity.label || manifest.signerCertificateSha256 !== identity.signerCertificateSha256 ||
        !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1 || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 50 * 1024 * 1024 ||
        createHash('sha256').update(cert.raw).digest('hex') !== identity.signerCertificateSha256 || !verify('RSA-SHA256', payload, cert.publicKey, signature)) throw new Error('Android signature or channel mismatch');
      return { manifest, signed: { payload: payload.toString('base64'), signature: signature.toString('base64') } };
    } catch { return fail('unavailable', 'Android release is not available'); }
  }
  const serve = async (c: Context) => {
    const { manifest, signed } = await artifact();
    const path = c.req.path;
    c.header('cache-control', 'no-store');
    if (path === '/api/android/release') return c.json(signed);
    const download = `/api/android/apk/${manifest.sha256}.apk`;
    if (path === '/api/android/update' || path === '/api/device/android-update') return c.json({ url: identity.gatewayOrigin + download, size: manifest.size, sha256: manifest.sha256, versionCode: manifest.versionCode });
    if (path !== download && path !== '/app.apk') return fail('not_found','APK not found');
    const bytes = await readFile(`${root}/${manifest.sha256}.apk`).catch(() => fail('unavailable','Android APK is not available'));
    if (bytes.length !== manifest.size || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) return fail('unavailable','Android APK does not match its signed manifest');
    c.header('content-type','application/vnd.android.package-archive');
    c.header('content-length',String(bytes.length));
    c.header('content-disposition',`attachment; filename="${identity.apkStem}-${manifest.versionCode}.apk"`);
    c.header('x-content-type-options','nosniff');
    c.header('etag',`"${manifest.sha256}"`);
    if (path === download) c.header('cache-control','public, max-age=31536000, immutable');
    if (c.req.method === 'HEAD') return c.body(null);
    return c.body(new Uint8Array(bytes));
  };
  app.on(['GET','HEAD'],'/api/android/*',serve);
  app.on(['GET','HEAD'],'/api/device/android-update',serve);
  app.on(['GET','HEAD'],'/app.apk',serve);
}
