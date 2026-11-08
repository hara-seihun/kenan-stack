// Places one call through the bridge and Asterisk without the Kenan server, for checking the SIP leg end to end.
// Usage (root): node --import tsx deploy/phone-sip-check.ts CONFIG.json PERSON +E164 [brief]
//   or, for an inbound call (the script plays the answering channel's part and calls the line through Asterisk's
//   loopback test context kenan-test-caller): ... CONFIG.json PERSON --inbound
//   or, to answer the next real call to the line from the carrier: ... CONFIG.json PERSON --wait
// The config's database needs only kenan_phone_call. Prints the transcript, end reason and the call log.
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../server/config.js';
import { PHONE_COLUMNS, PHONE_TABLE, inboundApp, liveConfig, liveKey, lineVariable, mediaSettings, telephoneConfig } from '../server/extensions/phone.js';
import { bridgeHost, bridgeSpec } from '../server/extensions/phone-host.js';
import { ari, ariConfig, ariEvents, type AriEvent } from '../server/extensions/phone-ari.js';
import { callLogDirectory } from '../server/extensions/phone-log.js';

const [configPath, person, to, brief] = process.argv.slice(2);
if (!configPath || !person || !to) throw new Error('usage: phone-sip-check.ts CONFIG PERSON +E164 [brief]');
const config = loadConfig(configPath);
const db = new pg.Client({ connectionString: config.databaseUrl });
await db.connect();
await db.query(PHONE_TABLE);
for (const statement of PHONE_COLUMNS) await db.query(statement);
const id = randomUUID();
if (to === '--inbound' || to === '--wait') {
  const telephone = telephoneConfig(mediaSettings(config.people.find(p => p.id === person)!).telephone);
  if (telephone.kind !== 'configured') throw new Error('no telephone');
  const asterisk = ariConfig(telephone.ariConfigPath);
  const app = inboundApp(config.channel);
  const arrived = new Promise<AriEvent>(resolve => { const s = ariEvents(asterisk, app, e => { if (e.type === 'StasisStart') { resolve(e); s.close(); } }, () => {}); void s.opened.then(() => ari(asterisk, 'POST', '/asterisk/variable', { variable: lineVariable(telephone.fromNumber), value: app })).then(() => to === '--wait' ? undefined : ari(asterisk, 'POST', '/channels', { endpoint: `Local/${telephone.fromNumber.slice(1)}@kenan-inbound`, context: 'kenan-test-caller', extension: 'caller', priority: 1 })); });
  const event = await arrived;
  await ari(asterisk, 'POST', `/channels/${encodeURIComponent(event.channel!.id)}/ring`);
  console.log(JSON.stringify({ stasis: event.args, channel: event.channel!.id }));
  await db.query(`INSERT INTO kenan_phone_call(id,owner_id,direction,name,call_agent_id,placed_by_id,to_number,token,brief,callback_number,provider_call_id,created_at) VALUES($1,$2,'inbound','SIP check','check','check',NULL,$3,$4,$5,$6,$7)`,
    [id, person, randomBytes(32), brief ?? 'Caller ID: withheld. Greet with a short bilingual "Bonjour, hello", say you are Kenan, an AI assistant testing this line, then say goodbye.', telephone.fromNumber, event.channel!.id, Date.now()]);
} else await db.query(`INSERT INTO kenan_phone_call(id,owner_id,direction,name,call_agent_id,placed_by_id,to_number,token,brief,callback_number,created_at) VALUES($1,$2,'outbound','SIP check','check','check',$3,$4,$5,NULL,$6)`,
  [id, person, to, randomBytes(32), brief ?? 'Test call. Introduce yourself as Kenan, an AI assistant testing a phone line, say one short sentence about the weather, then say goodbye.', Date.now()]);
const owner = config.people.find(p => p.id === person)!;
const media = mediaSettings(owner), line = telephoneConfig(media.telephone);
if (line.kind !== 'configured') throw new Error('no telephone');
// The bridge runs where the line's Asterisk runs: here, or on the phone edge from the build in RELEASE (default the
// channel's own; a test build can be copied to /opt/kenan-edge/test).
const host = bridgeHost(line.bridge);
const spec = bridgeSpec(config, owner, media, host, id, ariConfig(line.ariConfigPath), liveKey(liveConfig(media.live)));
let code: unknown;
if (host.kind === 'local') {
  mkdirSync('/run/kenan/phone-bridge', { recursive: true, mode: 0o700 });
  const specPath = `/run/kenan/phone-bridge/${id}.json`;
  writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  const bridge = spawn(process.execPath, ['--import', 'tsx', 'server/extensions/phone-bridge.ts', specPath], { stdio: 'inherit' });
  code = await new Promise(resolve => bridge.on('exit', resolve));
} else {
  const release = process.env.RELEASE ?? `${host.edge.releaseRoot}/${config.channel}`;
  const ssh = ['-i', host.edge.sshKeyPath, '-o', `UserKnownHostsFile=${host.edge.knownHostsPath}`, '-o', 'BatchMode=yes', `${host.edge.user}@${host.edge.host}`];
  const bridge = spawn('ssh', [...ssh, `install -d -m 700 /run/kenan-edge && umask 077 && cat > /run/kenan-edge/${id}.json && node ${release}/dist/server/extensions/phone-bridge.js /run/kenan-edge/${id}.json`], { stdio: ['pipe', 'inherit', 'inherit'] });
  bridge.stdin.end(JSON.stringify(spec));
  code = await new Promise(resolve => bridge.on('exit', resolve));
}
const row = (await db.query('SELECT transcript, end_reason, provider_call_id FROM kenan_phone_call WHERE id=$1', [id])).rows[0];
console.log(JSON.stringify({ id, code, ...row }, null, 1));
const log = join(callLogDirectory(spec.dataDir, Date.now()), `${id}.jsonl`);
if (host.kind === 'local') console.log(readFileSync(log, 'utf8').split('\n').filter(line => !/"(voiced|hops)"/.test(line) || /hops/.test(line)).slice(0, 60).join('\n'));
else console.log(`log on the edge: ${log}`);
await db.end();
