#!/usr/bin/env node
/** Receive into sole-refresh custody, grant, and prove actual serving in one resumable command.
 * A sender must already have removed admission and drained the account. This tool
 * never logs a credential, deletes a packet or changes the sender's custody.
 */
import { readFileSync, writeFileSync, renameSync, statSync, chownSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export async function receiveClaudeAccount({packet, alias, migration, store, withAuth, grant, probe}) {
  if (!/^anthropic-\d+$/.test(alias) || packet?.alias !== alias || packet.migration !== migration || !packet.id
    || packet.credential?.type !== 'oauth' || !packet.credential.access || !packet.credential.refresh
    || !Number.isFinite(packet.credential.expires)) throw Error('Invalid incoming account packet');
  const key = `broker-receive:${packet.id}`;
  const accepted = await withAuth((auth, save) => {
    const previous = auth[key];
    if (previous) {
      if (previous.alias !== alias || previous.migration !== migration) throw Error('Receive identity conflict');
      // A token may have rotated since import. Never replace it from the packet.
      return previous;
    }
    if (auth[alias]?.type === 'oauth') throw Error('An active credential already occupies this alias');
    const record = {id:packet.id,alias,migration,phase:'received',receivedAt:new Date().toISOString()};
    auth[alias] = packet.credential;
    auth[key] = record;
    save(); // The credential and receive marker commit in one auth-lock write.
    return record;
  });
  if (accepted.phase === 'proven') return accepted;
  store.upsertAccount({id:alias,provider:'anthropic',label:alias,enabled:true,concurrency:4});
  await grant(alias);
  const proof = await probe(alias);
  if (!proof?.completed || !proof?.meterFresh || !proof?.granted || !proof?.leaseId)
    throw Error('Account received, but grant and actual serving proof are incomplete; resume the same packet');
  const result = {...accepted,phase:'proven',provenAt:new Date().toISOString(),proof};
  await withAuth((auth, save) => { auth[key] = result; save(); });
  return result;
}

export function readClaudeAdmission(store, alias, since) {
  // An ended lease alone also describes a failed request. Require actual Opus
  // output accounting on that same lease, a current meter, and the loaded grant.
  const lease = store.db.prepare("SELECT l.id FROM lease l WHERE l.account_id=? AND l.started_at>=? AND l.ended_at IS NOT NULL AND EXISTS (SELECT 1 FROM usage_hour u WHERE u.run_id=l.id AND u.account_id=l.account_id AND u.model='claude-opus-5-5' AND u.component='output' AND u.tokens>0) ORDER BY l.started_at DESC LIMIT 1").get(alias,since);
  const fresh = store.latestMeters(alias).some(m=>m.observed_at>=since);
  const declared = JSON.parse(store.control('broker-grant:converge')??'null');
  if (lease && fresh && declared?.accounts.includes(alias))
    return {completed:true,meterFresh:true,granted:true,leaseId:lease.id};
}

export async function main(args) {
  const options = Object.fromEntries(Array.from({length:args.length/2},(_,i)=>[args[i*2],args[i*2+1]]));
  if (args.length !== 6 || !options['--packet'] || !options['--alias'] || !options['--migration'])
    throw Error('Usage: sudo node deploy/receive-claude-account.mjs --packet FILE --alias anthropic-N --migration ID');
  if (process.getuid() !== 0) throw Error('Receiving an account requires root');
  const root = '/opt/kenan-claude-broker/current';
  const {withSharedAuth} = await import(pathToFileURL(`${root}/dist/auth/shared-oauth.js`));
  const {acquireDirectoryLock} = await import(pathToFileURL(`${root}/dist/auth/directory-lock.js`));
  const {Store} = await import(pathToFileURL(`${root}/dist/store.js`));
  const configPath = '/etc/kenan-claude-broker/broker.json';
  const packetInfo = statSync(options['--packet']);
  if (packetInfo.uid !== 0 || (packetInfo.mode & 0o077)) throw Error('Packet must be root-only');
  const packet = JSON.parse(readFileSync(options['--packet']));
  const config = JSON.parse(readFileSync(configPath));
  const signal = AbortSignal.timeout(120000);
  const release = await acquireDirectoryLock(`${configPath}.receive`, signal, 'Another receive is active');
  const store = Store.open(config.ledgerPath);
  try {
    const result = await receiveClaudeAccount({packet,alias:options['--alias'],migration:options['--migration'],store,
      withAuth:fn=>withSharedAuth(config.authPath,signal,fn),
      grant:async alias=>{
        const current = JSON.parse(readFileSync(configPath));
        const listener = current.listeners.find(l=>l.principal === 'converge');
        if (!listener) throw Error('Converge listener is missing');
        listener.accounts = [...new Set([...listener.accounts,alias])];
        const st = statSync(configPath), temporary = `${configPath}.receive-${process.pid}`;
        writeFileSync(temporary,JSON.stringify(current,null,2)+'\n',{mode:st.mode&0o777});
        chownSync(temporary,st.uid,st.gid);renameSync(temporary,configPath);
      },
      probe:async alias=>{
        // The grant file reloads every two seconds. Real burst calls use fresh
        // sessions so the ordinary scheduler, not an account-pin bypass, proves admission.
        const start = Date.now();
        const accounts = JSON.parse(readFileSync(configPath)).listeners.find(l=>l.principal==='converge').accounts;
        for (let n=0; n<accounts.length*3; n++) {
          const response = await fetch('http://127.0.0.1:25100/v1/messages',{method:'POST',signal,headers:{'content-type':'application/json','anthropic-version':'2023-06-01','anthropic-beta':'claude-code-20250219,oauth-2025-04-20','x-claude-code-session-id':`receive-${packet.id}-${randomUUID()}`},body:JSON.stringify({model:'claude-opus-5-5',max_tokens:16,stream:true,system:[{type:'text',text:"You are Claude Code, Anthropic's official CLI for Claude."}],messages:[{role:'user',content:'Reply with exactly ok.'}]})});
          const text = await response.text();
          if (response.status !== 200 || !text.includes('"message_stop"')) throw Error(`Receive proof failed with HTTP ${response.status}`);
          const admitted = readClaudeAdmission(store,alias,start);
          if (admitted) return admitted;
        }
        throw Error('Received account was not selected by the ordinary scheduler');
      }});
    console.log(JSON.stringify(result));
  } finally {store.close();release();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
