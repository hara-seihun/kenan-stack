// Source scope is checked before launcher mutation and repeated under publication lock.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export function sourceScope(repo, base, installed, manifestPath, sourceRef) {
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 if(!sourceRef && git('status','--porcelain'))throw Error('unclean source');
 if(git('rev-parse','--verify',base+'^{commit}')!==base)throw Error('full canonical base SHA required');
 const head=git('rev-parse','--verify',(sourceRef??'HEAD')+'^{commit}');
 if(sourceRef && head!==sourceRef)throw Error('full canonical source SHA required');
 const leaves=git('diff','--name-only',base,head,'--','tools/agent-workspace').split('\n').filter(Boolean).filter(p=>!p.endsWith('/deploy')).sort();
 const selected=JSON.parse(fs.readFileSync(path.join(installed,'agent-workspace/.component-release.json'),'utf8')).sourceCommit;
 const parents=git('show','-s','--format=%P',head).split(' ');
 let scope={kind:'installed-base',base,source:head,leaves};
 if(manifestPath){
  const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(m.base!==base || m.source!==head || !Array.isArray(m.leaves) || m.leaves.some(p=>typeof p!=='string') || JSON.stringify([...m.leaves].sort())!==JSON.stringify(leaves))throw Error('source scope mismatch: expected exact base, source and component leaf set');
  if(selected!==base && !(m.correction===true && typeof m.reason==='string' && m.reason.trim()))throw Error('source scope correction requires an explicit reason');
  scope={...scope,kind:m.correction===true?'scope-correction':'expected-leaves',reason:m.reason??null};
 }else if(selected!==base || parents.length!==1 || parents[0]!==base){
  throw Error('source scope diverged: anchor one commit to installed source or supply an exact expected-leaves manifest; correction requires a reason');
 }
 return scope;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const [repo,base,installed,manifest,source]=process.argv.slice(2);
 console.log(JSON.stringify(sourceScope(repo,base,installed,manifest||undefined,source||undefined)));
}
