import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const entry=new URL('./main',import.meta.url).pathname;
const run=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();

// seinari.git keeps data files as git-lfs-format pointers behind its own filter driver (2026-10-30).
test('a checkout whose files are pointers behind a known data filter is priced at the sizes the pointers name; another filter is still refused',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'pointer-pricing-'));
 try {
  const work=path.join(root,'work');mkdirSync(work);run(work,'init','-q','-b','main');run(work,'config','user.name','T');run(work,'config','user.email','t@example.invalid');
  writeFileSync(path.join(work,'.gitattributes'),'* filter=seinari-data\n');
  const size=64*1024**2;
  writeFileSync(path.join(work,'weights.bin'),`version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize ${size}\n`);
  writeFileSync(path.join(work,'notes.txt'),'small\n');
  run(work,'add','.');run(work,'commit','-qm','data');
  const env={...process.env,PI_WORKSPACE_STATE:path.join(root,'state','registry.sqlite3'),PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
  const workspaces=path.join(root,'workspaces');mkdirSync(workspaces);
  const create=(name)=>{
   const end=Date.now()+45000;let result;
   do{result=spawnSync(entry,['create','--root',workspaces,'--name',name,'--repo',work,'--owner','fixture','--intent','source-only','--headroom-gib','1','--growth-mib','512','--json'],{env:{...env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'filter.seinari-data.smudge',GIT_CONFIG_VALUE_0:'cat'},encoding:'utf8',timeout:30000});}
   while(result.status===75&&Date.now()<end);
   return result;
  };
  const priced=create('one');
  assert.equal(priced.status,0,priced.stderr+priced.stdout);
  const plan=JSON.parse(priced.stdout).plan ?? JSON.parse(priced.stdout).record?.plan ?? JSON.parse(priced.stdout);
  assert.ok(JSON.stringify(plan).includes('materializedBlobBytes'),priced.stdout.slice(0,2000));
  const blobBytes=Number(/"materializedBlobBytes":\s*(\d+)/u.exec(priced.stdout)[1]);
  assert.ok(blobBytes>=size,`priced ${blobBytes} bytes for a ${size}-byte data file`);

  writeFileSync(path.join(work,'.gitattributes'),'* filter=unknown-transform\n');run(work,'commit','-qam','other filter');
  const refused=create('two');
  assert.notEqual(refused.status,0);
  assert.match(refused.stderr,/checkout attribute transformation/u);
 } finally {rmSync(root,{recursive:true,force:true});}
});
