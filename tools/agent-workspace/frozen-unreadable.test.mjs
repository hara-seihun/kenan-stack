import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {frozenCustody} from './frozen-custody.mjs';

// Converge's qualification left root-owned 0600 bytecode in prepared checkouts; the immutable census raised
// PermissionError on them and blocked terminal release.
const sudo=(...args)=>spawnSync('sudo',['-n',...args],{encoding:'utf8',timeout:10000});
const privileged=process.getuid()!==0&&sudo('true').status===0;
function tree(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frozen-unreadable-'));
 t.after(()=>{sudo('chattr','-R','-i',root);sudo('rm','-rf','--',root);});
 const cache=path.join(root,'pkg','__pycache__');fs.mkdirSync(cache,{recursive:true});
 const file=path.join(cache,'module.cpython-314.pyc');fs.writeFileSync(file,'bytecode');
 assert.equal(sudo('chown','root:root',file).status,0);assert.equal(sudo('chmod','600',file).status,0);
 return {root,cache,file};
}
test('root-owned unreadable files are observed, not refused',{skip:!privileged&&'needs sudo -n to make root-owned fixtures'},t=>{
 const f=tree(t);
 assert.throws(()=>fs.readFileSync(f.file));
 assert.equal(frozenCustody(f.root,{recursive:true,privileged:()=>null}),null);
 assert.equal(sudo('chattr','+i',f.file).status,0);
 assert.equal(frozenCustody(f.root,{recursive:true,privileged:()=>null})?.code,'FROZEN_CUSTODY');
});
test('an unsearchable directory is read through the read-search route, or is unknown without it',{skip:!privileged&&'needs sudo -n to make root-owned fixtures'},t=>{
 const f=tree(t);
 assert.equal(sudo('chown','root:root',f.cache).status,0);assert.equal(sudo('chmod','700',f.cache).status,0);
 const refused=frozenCustody(f.root,{recursive:true,privileged:()=>null});
 assert.equal(refused?.code,'FROZEN_CUSTODY_UNKNOWN');assert.match(refused.reason,/could not read/);
 assert.equal(frozenCustody(f.root,{recursive:true}),null);
 assert.equal(sudo('chattr','+i',f.file).status,0);
 assert.equal(frozenCustody(f.root,{recursive:true})?.code,'FROZEN_CUSTODY');
});
