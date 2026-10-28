import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const entry=process.env.CAPACITY_TEST_ENTRY??new URL('./main',import.meta.url).pathname;
const sleep=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
for (const crash of [false, true]) test(`blocked import ${crash ? 'crash recovery' : 'completion'} releases device fence, preserves reservation and admits independent source concurrently`,()=>{
 const root=mkdtempSync(path.join(tmpdir(),'capacity-parallel-'));
 const gate=path.join(root,'import-blocked'),release=path.join(root,'release');
 let state;
 try {
  const bin=path.join(root,'bin');mkdirSync(bin);
  const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
  const sources=['slow','peer'].map(name=>{const repo=path.join(root,name);mkdirSync(repo);const git=(...a)=>execFileSync(realGit,['-C',repo,...a],{encoding:'utf8'}).trim();git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');writeFileSync(path.join(repo,'file'),name);git('add','.');git('commit','-m',name);return {repo,commit:git('rev-parse','HEAD')};});
  writeFileSync(path.join(bin,'git'),`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2);if(a.includes('fetch')&&a.some(x=>x.startsWith('+'+${JSON.stringify(sources[0].commit)}+':'))){fs.writeFileSync(${JSON.stringify(gate)},'blocked');const end=Date.now()+90000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}if (${crash} && a.includes('fetch') && fs.existsSync(${JSON.stringify(release)}) && fs.readFileSync(${JSON.stringify(release)},'utf8')==='crash'){fs.writeFileSync(${JSON.stringify(release)},'crashed');let pid=process.ppid;while(pid>1){if(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').includes('source-prepare')){process.kill(pid,'SIGKILL');break;}pid=Number(fs.readFileSync('/proc/'+pid+'/status','utf8').match(/PPid:\\s+(\\d+)/)[1]);}process.exit(0);}const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);`);chmodSync(path.join(bin,'git'),0o755);
  // Bound only the fixture's real flock wait to make old long-scope failure fast.
  mkdirSync(path.join(root,'workspaces'));const capacityLock=createHash('sha256').update('capacity:'+String(statSync(root).dev)).digest('hex');
  const flock=execFileSync('which',['flock'],{encoding:'utf8'}).trim();
  writeFileSync(path.join(bin,'flock'),`#!${process.execPath}\nconst cp=require('node:child_process'),fs=require('node:fs'),a=process.argv.slice(2);const i=a.indexOf('--wait');if(i>=0&&fs.readlinkSync('/proc/self/fd/3').endsWith(${JSON.stringify(capacityLock)}))a[i+1]='0.2';const r=cp.spawnSync(${JSON.stringify(flock)},a,{stdio:['inherit','inherit','inherit',3]});process.exit(r.status??1);`);chmodSync(path.join(bin,'flock'),0o755);
  state=path.join(root,'state','registry.sqlite3');
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
  const args=i=>['create','--root',path.join(root,'workspaces'),'--name',i?'peer':'slow','--repo',sources[i].repo,'--ref',sources[i].commit,'--owner','fixture','--intent','source-only','--headroom-gib','8','--growth-mib','512','--json'];
  const invoke=i=>spawnSync(entry,args(i),{env,encoding:'utf8',timeout:30000});
  assert.equal(invoke(0).status,75);
  const end=Date.now()+45000;while(!existsSync(gate)&&Date.now()<end)sleep();assert.ok(existsSync(gate));
  const db=new DatabaseSync(state,{readOnly:true});
  const table=db.prepare("SELECT name FROM sqlite_master WHERE name='workspace_source_capacity'").get();
  // Admission must progress while the first actual Git subprocess is still blocked.
  let peer;do{peer=invoke(1);if(peer.status===0)break;if(peer.status!==75)break;sleep();}while(Date.now()<end);
  assert.equal(peer.status,0,peer.stderr);assert.equal(JSON.parse(peer.stdout).state,'active');assert.equal(existsSync(release),false);
  assert.ok(table,'long source operation has a durable capacity reservation');
  const duplicate=invoke(0);assert.equal(duplicate.status,75,duplicate.stderr);
  const pending=db.prepare('SELECT * FROM workspace_source_capacity').all();assert.equal(pending.length,1);assert.equal(JSON.parse(pending[0].plan_json).growthBytes,512*1024**2);
  // Peer admission must actually include the still-active import's liability.
  const record=JSON.parse(peer.stdout);assert.ok(record.capacity.admission.reservedBytes>=512*1024**2);
  if(crash){writeFileSync(release,'crash');const crashedBy=Date.now()+5000;while(readFileSync(release,'utf8')!=='crashed'&&Date.now()<crashedBy)sleep();assert.equal(readFileSync(release,'utf8'),'crashed');assert.equal(db.prepare('SELECT count(*) n FROM workspace_source_capacity').get().n,1,'abrupt exit retains liability');}
  writeFileSync(release,'go');const finish=Date.now()+45000;let slow;do{slow=invoke(0);if(slow.status===0)break;assert.equal(slow.status,75,slow.stderr);sleep();}while(Date.now()<finish);
  assert.equal(slow.status,0,slow.stderr);assert.equal(JSON.parse(slow.stdout).state,'active');assert.equal(db.prepare('SELECT count(*) n FROM workspace_source_capacity').get().n,0);assert.equal(db.prepare("SELECT count(*) n FROM workspace WHERE path=? AND state='active'").get(path.join(root,'workspaces','slow')).n,1,'one final admission');const replay=invoke(0);assert.equal(replay.status,0,replay.stderr);assert.equal(JSON.parse(replay.stdout).id,JSON.parse(slow.stdout).id);db.close();
 }finally{writeFileSync(release,'go');sleep();rmSync(root,{recursive:true,force:true});}
});

test('source liability has no timed waiver, excludes only its exact destination and is additive with workspace reservations',async()=>{
 const {workspaceTesting}=await import('./workspace.mjs');
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(`CREATE TABLE workspace(id TEXT,owner TEXT,state TEXT,path TEXT,root TEXT,created_at INTEGER);
   CREATE TABLE workspace_capacity(workspace_id TEXT,device_id TEXT,plan_json TEXT);
   CREATE TABLE workspace_source_capacity(destination TEXT PRIMARY KEY,device_id TEXT,plan_json TEXT,receipt TEXT);`);
  const plan={intent:'source-only',estimate:'whole-tree-upper-bound',constructionBytes:100,growthBytes:50,headroomBytes:8192};
  db.prepare('INSERT INTO workspace_source_capacity VALUES(?,?,?,?)').run('/original','1',JSON.stringify(plan),'/old-receipt');
  const held=workspaceTesting.capacityReservations(db,'1','/peer');assert.deepEqual(held.priced,[150]);assert.equal(held.headroomBytes,8192);
  assert.deepEqual(workspaceTesting.capacityReservations(db,'1','/original').priced,[]);
  assert.deepEqual(workspaceTesting.capacityReservations(db,'other-device','/peer').priced,[]);
  assert.equal(workspaceTesting.capacityRequirement({...plan,constructionBytes:25},held.priced,held.headroomBytes),8417);
 }finally{db.close();}
});

// Protect the CPU admission of the real forty-client historical checks.
import {workspaceChecks} from './check.mjs';
test('the historical forty-client checks are isolated from ordinary checks', () => {
  const stress=['agent workspace 104/128','agent workspace 105/128'];
  const ordinary=workspaceChecks.map(([name])=>name).filter(name=>!stress.includes(name));
  assert.deepEqual(workspaceChecks.find(job=>job[0]===stress[0])[3].dependsOn, ordinary);
  assert.deepEqual(workspaceChecks.find(job=>job[0]===stress[1])[3].dependsOn, [stress[0]]);
});
