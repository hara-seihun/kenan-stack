import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectedArguments,selectorSyntax} from './cli-contract.mjs';
import {main} from './workspace.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
for(const command of ['heartbeat','release','cancel-creation','finalize-creation','measure-capacity','reconcile','maintain'])test(command+' identifies mutually exclusive selectors without effects',()=>{
 const x=selectedArguments(command,{id:'identity',path:'/fixture'});assert.equal(x.ok,false);assert.equal(x.error.code,'invalid-workspace-selector');
 assert.match(x.error.detail,new RegExp('^'+command+' accepts exactly one selector'));assert.match(x.error.detail,/both supplied/);
 assert.equal(x.error.nextAction.command,command);assert.equal(selectorSyntax(command),'(--id ID|--path PATH)');
 assert.equal(selectedArguments(command,{id:'identity'}).ok,true);assert.equal(selectedArguments(command,{path:'/fixture'}).ok,true);
 const root=mkdtempSync(path.join(tmpdir(),'selector-'));const code=process.exitCode;
 try{assert.throws(()=>main([command,'--id','identity','--path','/fixture','--json'],path.join(root,'db')),e=>e.code==='invalid-workspace-selector'&&e.message.startsWith(command+' accepts exactly one selector'));}finally{process.exitCode=code;rmSync(root,{recursive:true,force:true});}
});

test('growth-status help and parser both require bound id and path; reprice accepts exactly one',()=>{
 assert.equal(selectorSyntax('growth-status'),'--id ID --path PATH');
 for(const values of [{},{id:'identity'},{path:'/fixture'}])assert.equal(selectedArguments('growth-status',values).ok,false);
 assert.equal(selectedArguments('growth-status',{id:'identity',path:'/fixture'}).ok,true);
 assert.equal(selectorSyntax('reprice-capacity'),'(--id ID|--path PATH)');
 assert.equal(selectedArguments('reprice-capacity',{id:'identity',path:'/fixture'}).ok,false);
 for(const values of [{id:'identity'},{path:'/fixture'}])assert.equal(selectedArguments('reprice-capacity',values).ok,true);
});
