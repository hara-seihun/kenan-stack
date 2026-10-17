// Content-addressed baseline proof for component deployment. When the selected tools release names a
// source commit whose Git object is not available here (for example a source projected to public main
// by `public-source`), the installed agent-workspace tree itself is the evidence: find the newest
// ancestor of HEAD whose tools/agent-workspace (without `deploy`) has exactly the installed files,
// modes and Git blob hashes (without `.component-release.json`). Prints that commit, or exits 65.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const blob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export function installedEntries(root){
 const result=[];
 (function visit(directory){for(const name of fs.readdirSync(directory).sort()){
  const file=path.join(directory,name),stat=fs.lstatSync(file),relative=path.relative(root,file).split(path.sep).join('/');
  if(stat.isDirectory()){visit(file);continue;}
  if(relative==='.component-release.json')continue;
  if(stat.isSymbolicLink())result.push(`120000 ${blob(Buffer.from(fs.readlinkSync(file)))} ${relative}`);
  else if(stat.isFile())result.push(`${stat.mode&0o111?'100755':'100644'} ${blob(fs.readFileSync(file))} ${relative}`);
  else throw new Error('unsupported installed entry '+relative);
 }})(root);
 return result.sort();
}
export function matchInstalledBase(repository,destination,{limit=200}={}){
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',timeout:10000,maxBuffer:1<<26});
 const installed=installedEntries(path.join(destination,'agent-workspace')).join('\n');
 for(const commit of git('rev-list',`--max-count=${limit}`,'HEAD','--','tools/agent-workspace').split('\n').filter(Boolean)){
  const tree=git('ls-tree','-r',commit,'--','tools/agent-workspace').split('\n').filter(Boolean).map(line=>{
   const [meta,name]=line.split('\t');const [mode,,object]=meta.split(' ');return `${mode} ${object} ${name.replace('tools/agent-workspace/','')}`;
  }).filter(entry=>!entry.endsWith(' deploy')&&!entry.endsWith(' .component-release.json')).sort().join('\n');
  if(tree===installed)return commit;
 }
 return null;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 try{
  if(process.argv.length!==4)throw new Error('usage: installed-base.mjs REPOSITORY TOOLS_DEST');
  const commit=matchInstalledBase(process.argv[2],process.argv[3]);
  if(!commit){console.error('installed agent-workspace matches no recent ancestor of HEAD');process.exitCode=65;}
  else console.log(commit);
 }catch(error){console.error(error.message);process.exitCode=65;}
}
