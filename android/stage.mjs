#!/usr/bin/env node
import channels from './channels.json' with {type:'json'};
import { open, mkdir, realpath, chmod, rm } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash, X509Certificate, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const result = (code, message) => ({ ok: false, error: { code, message, retry: 'after-state-change' } });
let created = null;
try {
  const [apk, releaseRoot, signer, channel] = process.argv.slice(2);
  if (process.argv.length!==6 || !['beta','production'].includes(channel) || !isAbsolute(apk ?? '') || !isAbsolute(releaseRoot ?? '') || resolve(releaseRoot) !== releaseRoot || !/^[a-f0-9]{64}$/.test(signer ?? '')) throw result('invalid_input', 'Usage: node android/stage.mjs ABS_APK EXISTING_EXACT_ABS_RELEASE_ROOT EXPECTED_SIGNER_SHA256 beta|production');
  const selected=channels[channel];const identity={package:selected.androidPackage,label:selected.label};
  if (await realpath(releaseRoot) !== releaseRoot || await realpath(apk) !== apk) throw result('forbidden', 'APK and release root must be canonical paths, not selection symlinks');
  const source = await open(apk, 'r'); let bytes;
  try { const size = await source.stat(); if (!size.isFile() || size.size < 1 || size.size > 50 * 1024 * 1024) throw result('invalid_input', 'APK must be a bounded ordinary file'); bytes = await source.readFile(); if (bytes.length !== size.size) throw result('identity_conflict', 'APK changed while reading'); }
  finally { await source.close(); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = `${releaseRoot}/android`;
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw result('identity_conflict', 'Android release stage already exists; immutable artifacts are never overwritten'); throw error; }
  created = directory;
  const path = `${directory}/${sha256}.apk`;
  const file = await open(path, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const command = (name, args) => execFileSync(`/opt/android-sdk/build-tools/36.0.0/${name}`, args, { timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const certificates = command('apksigner', ['verify', '--print-certs', path]);
  const signers = [...certificates.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})$/gm)].map(match => match[1]);
  if (signers.length !== 1 || signers[0] !== signer) throw result('identity_conflict', 'APK signature does not match the declared independent release signer');
  const badging = command('aapt', ['dump', 'badging', path]);
  const metadata = /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'/m.exec(badging);
  if (!metadata || metadata[1] !== identity.package || !badging.split('\n').includes(`application-label:'${identity.label}'`)) throw result('invalid_input', 'APK identity must match the selected release channel');
  const versionCode = Number(metadata[2]);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000 || metadata[3].length > 100) throw result('invalid_input', 'APK version metadata is invalid');
  const manifest = { protocol: 1, package: metadata[1], label: identity.label, versionCode, versionName: metadata[3], size: bytes.length, sha256, signerCertificateSha256: signer };
  const manifestFile = await open(`${directory}/manifest.json`, 'wx', 0o600); try { await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await manifestFile.sync(); } finally { await manifestFile.close(); }
  execFileSync('/usr/lib/jvm/java-21-openjdk-amd64/bin/java', [fileURLToPath(new URL('./SignRelease.java', import.meta.url)), directory, channel], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  const certificate = new X509Certificate(await readFile(`${directory}/signer.der`));
  if (certificate.publicKey.asymmetricKeyType !== 'rsa' || createHash('sha256').update(certificate.raw).digest('hex') !== signer ||
      !verify('RSA-SHA256', await readFile(`${directory}/manifest.json`), certificate.publicKey, await readFile(`${directory}/manifest.sig`)))
    throw result('identity_conflict', 'Feed signing identity or signature differs from selected APK signer');
  await chmod(`${directory}/manifest.sig`, 0o644); await chmod(`${directory}/signer.der`, 0o644);
  await chmod(path, 0o644); await chmod(`${directory}/manifest.json`, 0o644); await chmod(directory, 0o755);
  for (const directoryPath of [directory, releaseRoot]) { const parent = await open(directoryPath, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
  console.log(JSON.stringify({ ok: true, value: { directory, manifest } }));
} catch (error) {
  let outcome = error?.ok === false ? error : error?.code === 'ENOENT' ? result('invalid_input', 'APK and canonical release root must already exist; no Android stage was published') : result('storage_failure', 'Android artifact staging failed; input APK custody remains unchanged');
  if (created) { try { await rm(created, { recursive: true, force: true }); } catch { outcome = result('storage_failure', `Android staging cleanup failed; incomplete directory remains at ${created}`); } }
  console.log(JSON.stringify(outcome));
  process.exitCode = 1;
}
