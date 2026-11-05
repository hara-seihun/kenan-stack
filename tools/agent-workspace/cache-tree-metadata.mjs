// Classification needs tracked paths, not package/lockfile blob hydration.
// Deny transports as well as requesting no lazy fetch: older Git versions do
// not implement GIT_NO_LAZY_FETCH. Local alternate object stores remain usable.
const localEnvironment = {GIT_NO_LAZY_FETCH:'1', GIT_NO_REPLACE_OBJECTS:'1', GIT_ALLOW_PROTOCOL:''};
const localGit = (repository,args,command) => command('git', ['-c','protocol.allow=never','-C',repository,...args], {env:localEnvironment});
const unavailable = detail => {throw Object.assign(new Error(detail),{code:'cache-metadata-unavailable'});};
export function trackedCacheMetadata(repository, paths, command) {
 const result=localGit(repository,['ls-tree','-z','HEAD','--',...paths.map(p=>`:(top,literal)${p}`)],command);
 if(result.status!==0) unavailable('Local tracked cache metadata is unavailable; no classification was established.');
 const entries=new Map();
 for(const record of result.stdout.split('\0').filter(Boolean)) {
  const match=/^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/s.exec(record);
  if(match && paths.includes(match[3]))entries.set(match[3],match[2]);
 }
 return entries;
}
export function localTrackedCacheText(repository, name, command) {
 const object=trackedCacheMetadata(repository,[name],command).get(name);
 if(object===undefined)return undefined;
 const result=localGit(repository,['cat-file','blob',object],command);
 if(result.status!==0) unavailable(`Tracked ${name} bytes are not available locally; no classification was established.`);
 return result.stdout;
}
export function hasNodeDependencyMetadata(repository, relative, command) {
 let directory=relative.split('/').slice(0,-1).join('/');const candidates=[];
 for(;;) {
  const prefix=directory?directory+'/':'';
  candidates.push({manifest:prefix+'package.json',locks:['package-lock.json','bun.lock','bun.lockb','pnpm-lock.yaml','yarn.lock'].map(p=>prefix+p)});
  if(!directory)break;directory=directory.split('/').slice(0,-1).join('/');
 }
 const entries=trackedCacheMetadata(repository,candidates.flatMap(c=>[c.manifest,...c.locks]),command);
 return candidates.some(c=>entries.has(c.manifest)&&c.locks.some(p=>entries.has(p)));
}
