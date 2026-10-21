// Publish the signed native build through the existing outer gateway's static aliases.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,verify,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const channel=process.argv[2];
if(!['beta','production'].includes(channel))throw Error('channel required');
const source=`/var/lib/kenan/android/${channel}`, root='/var/lib/kenan/android-channels';
const [payload,signature,certificate]=await Promise.all(['manifest.json','manifest.sig','signer.der'].map(name=>fs.readFile(`${source}/${name}`)));
const manifest=JSON.parse(payload.toString()), cert=new X509Certificate(certificate);
const identities=JSON.parse(await fs.readFile(new URL('../android/channels.json',import.meta.url),'utf8'));
const identity=identities[channel];
if(manifest.package!==identity.androidPackage || createHash('sha256').update(cert.raw).digest('hex')!==identity.signerCertificateSha256 || !verify('RSA-SHA256',payload,cert.publicKey,signature))throw Error('Native signature/channel mismatch');
const bytes=await fs.readFile(`${source}/${manifest.sha256}.apk`);
if(bytes.length!==manifest.size || createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw Error('Native APK hash mismatch');
const old=await fs.realpath(`${root}/${channel}`);
const target=`${root}/releases/${channel}-${manifest.versionCode}-${manifest.sha256}`;
await fs.mkdir(`${target}/apk`,{recursive:true,mode:0o755});
await fs.mkdir(`${target}/legacy`,{recursive:true,mode:0o755});
for(const dir of ['apk','legacy']){
 for(const name of await fs.readdir(`${old}/${dir}`).catch(()=>[])){
  try {await fs.link(`${old}/${dir}/${name}`,`${target}/${dir}/${name}`);}catch(error){if(error.code!=='EEXIST')throw error;}
 }
}
async function write(name,value){const temporary=`${target}/${name}.tmp`;await fs.writeFile(temporary,JSON.stringify(value),{mode:0o644});await fs.rename(temporary,`${target}/${name}`);}
async function link(name){const targetPath=`${target}/${name}`;await fs.unlink(targetPath).catch(error=>{if(error.code!=='ENOENT')throw error;});await fs.link(`${source}/${manifest.sha256}.apk`,targetPath);}
await link(`apk/${manifest.sha256}.apk`);
await link('app.apk');
await write('release.json',{payload:payload.toString('base64'),signature:signature.toString('base64')});
await write('update.json',{url:`${identity.gatewayOrigin}/api/android/apk/${manifest.sha256}.apk`,size:manifest.size,sha256:manifest.sha256,versionCode:manifest.versionCode});
const legacy=JSON.parse(await fs.readFile(`${old}/legacy.json`,'utf8'));
const repo=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const revision=execFileSync('git',['-c',`safe.directory=${repo}`,'-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
// A deploy at this commit may already have mirrored the previous APK under it; the newer signed build replaces that entry.
await link(`legacy/${revision}.apk`);
await write('legacy.json',{...legacy,release:{...legacy.release,revision,versionCode:manifest.versionCode,applicationId:manifest.package,sha256:manifest.sha256,size:manifest.size,fileName:`${revision}.apk`}});
const temporary=`${root}/.${channel}-${process.pid}`;
await fs.symlink(path.relative(root,target),temporary);
await fs.rename(temporary,`${root}/${channel}`);
console.log(JSON.stringify({channel,versionCode:manifest.versionCode,sha256:manifest.sha256,staticDirectory:target}));
