import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,chmodSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
const entry=new URL('./main',import.meta.url).pathname;
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const sha=value=>createHash('sha256').update(value).digest('hex');

function fixture(shortLocks){
 const root=mkdtempSync(path.join(tmpdir(),'mirror-concurrency-'));
 const source=path.join(root,'source'),bin=path.join(root,'bin'),state=path.join(root,'state','registry.sqlite3'),workspaces=path.join(root,'workspaces');
 mkdirSync(source);mkdirSync(bin);mkdirSync(workspaces);
 const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim(),realFlock=execFileSync('which',['flock'],{encoding:'utf8'}).trim();
 const git=(...args)=>execFileSync(realGit,['-C',source,...args],{encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');
 const commits=['slow','peer'].map(name=>{writeFileSync(path.join(source,name),name);git('add','.');git('commit','-m',name);return git('rev-parse','HEAD');});
 const mirror=path.join(root,'state','mirrors',sha(source).slice(0,24)+'.git');
 const gate=path.join(root,'blocked'),release=path.join(root,'release'),imports=path.join(root,'imports');
 // Hold the first commit's import inside its Git fetch until the test releases it.
 writeFileSync(path.join(bin,'git'),`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2);if(a.includes('fetch'))fs.appendFileSync(${JSON.stringify(imports)},JSON.stringify(a)+'\\n');if(a.includes('fetch')&&a.some(x=>x.startsWith('+'+${JSON.stringify(commits[0])}+':'))){fs.writeFileSync(${JSON.stringify(gate)},'blocked');const end=Date.now()+90000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);`);
 // Shorten only the named lock waits so a serialising implementation fails in seconds, not 30 s.
 writeFileSync(path.join(bin,'flock'),`#!${process.execPath}\nconst cp=require('node:child_process'),fs=require('node:fs'),a=process.argv.slice(2);const i=a.indexOf('--wait');const short=${JSON.stringify(shortLocks(mirror,commits).map(sha))};if(i>=0&&short.some(h=>fs.readlinkSync('/proc/self/fd/3').endsWith(h)))a[i+1]='0.3';const r=cp.spawnSync(${JSON.stringify(realFlock)},a,{stdio:['inherit','inherit','inherit',3]});process.exit(r.status??1);`);
 chmodSync(path.join(bin,'git'),0o755);chmodSync(path.join(bin,'flock'),0o755);
 const env={...process.env,PATH:`${bin}:${process.env.PATH}`,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
 const invoke=(name,commit)=>spawnSync(entry,['create','--root',workspaces,'--name',name,'--repo',source,'--ref',commit,'--owner','fixture','--intent','source-only','--headroom-gib','8','--growth-mib','512','--json'],{env,encoding:'utf8',timeout:30000});
 const until=(name,commit,ms=45000)=>{const end=Date.now()+ms;let result;do{result=invoke(name,commit);if(result.status!==75)break;sleep(50);}while(Date.now()<end);assert.equal(result.status,0,result.stderr);const record=JSON.parse(result.stdout);assert.equal(record.state,'active');assert.equal(record.sourceCommit,commit);return record;};
 const waitFor=(predicate,ms=45000)=>{const end=Date.now()+ms;while(!predicate()&&Date.now()<end)sleep(50);assert.ok(predicate());};
 const jobs=()=>{const dir=path.join(root,'state','source-preparations','jobs');return existsSync(dir)?readdirSync(dir).map(id=>path.join(dir,id)):[];};
 const read=file=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
 const jobFor=destination=>jobs().find(dir=>read(path.join(dir,'request.json'))?.destination===path.join(workspaces,destination));
 const fetchesOf=commit=>existsSync(imports)?readFileSync(imports,'utf8').trim().split('\n').filter(line=>line.includes(`+${commit}:`)).length:0;
 return {root,commits,gate,release,invoke,until,waitFor,jobFor,read,fetchesOf,cleanup(){writeFileSync(release,'go');sleep(100);rmSync(root,{recursive:true,force:true});}};
}

test('a blocked import neither serialises another commit of the same mirror nor is repeated by a same-commit peer',()=>{
 const f=fixture(mirror=>[`mirror:${mirror}`]);
 try {
  const [slow,peer]=f.commits;
  assert.equal(f.invoke('slow',slow).status,75);f.waitFor(()=>existsSync(f.gate));
  f.until('peer',peer,30000);
  assert.equal(existsSync(f.release),false,'the other commit became active while the first import was still inside git fetch');
  assert.equal(f.invoke('twin',slow).status,75);
  f.waitFor(()=>{const job=f.jobFor('twin');return job&&f.read(path.join(job,'progress.json'))?.value?.phase==='awaiting-mirror';});
  writeFileSync(f.release,'go');
  f.until('slow',slow);f.until('twin',slow);
  assert.equal(f.fetchesOf(slow),1,'the same-commit peer reused the in-flight import');
 } finally {f.cleanup();}
});

test('a busy same-commit wait records the holder and its phase, and the same request then recovers',()=>{
 const f=fixture((mirror,commits)=>[`mirror-source:${mirror}:${commits[0]}`]);
 try {
  const [slow]=f.commits;
  assert.equal(f.invoke('slow',slow).status,75);f.waitFor(()=>existsSync(f.gate));
  const observed=f.invoke('twin',slow);assert.ok([2,75].includes(observed.status),observed.stderr);
  let twin;f.waitFor(()=>{twin=f.jobFor('twin');return twin&&existsSync(path.join(twin,'result.json'));});
  const failed=f.read(path.join(twin,'result.json'));
  assert.equal(failed.error.code,'workspace-mirror-lock-busy');
  const [holder,...others]=failed.error.detail.holders;
  assert.equal(others.length,0);
  assert.equal(holder.job,f.jobFor('slow'));assert.equal(holder.phase,'importing');assert.equal(holder.mode,'exclusive');
  assert.match(holder.unit,/^pi-workspace-source-.*\.service$/u);
  assert.equal(failed.error.detail.waiterPhase,'awaiting-mirror');
  writeFileSync(f.release,'go');
  f.until('slow',slow);f.until('twin',slow);
  assert.equal(f.fetchesOf(slow),1);
 } finally {f.cleanup();}
});
