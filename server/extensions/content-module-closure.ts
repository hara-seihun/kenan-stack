import {parseSync} from 'rolldown/experimental';
export const CONTENT_FINAL_CLEANUP_MODULES=['content-cadence-final-cleanup.ts','content-cadence-final-cleanup-native.ts'] as const;
export const CONTENT_FINAL_CLEANUP_ROOTS=['content-cadence-dispatch-native.ts','content-cadence-option-b-native.ts','content-cadence-final-cleanup-native.ts'] as const;
export const CONTENT_REVIEWED_MODULES=[
 ...CONTENT_FINAL_CLEANUP_MODULES,
 'content-cadence-cumulative-cost.ts','content-cadence-final-attempt-native.ts','content-cadence-dispatch-native.ts','content-cadence-dispatch.ts','content-cadence-recovery.ts','content-cadence-operation-readback.ts','content-cadence-job-contract.ts','content-cadence-pilot.ts','content-cadence-control-auth.ts','config.ts','content-cadence-lifecycle.ts','content-cadence-provider-reader.ts','content-cadence-acceptance.ts','content-cadence-continuation.ts','content-cadence-floor-binding.ts','content-cadence-failure-archive.ts','content-cadence-option-b.ts','content-cadence-option-b-native.ts',
] as const;
export const CONTENT_REPLACEMENT_MODULES=[...CONTENT_REVIEWED_MODULES,'content-cadence-final-scope.ts'] as const;
const externals=new Set(['@google-cloud/storage','google-auth-library','node:crypto','node:util','node:os','node:path','node:fs/promises','node:fs','node:url']);
function fail(code:string):never{throw Error('content_host:closure_'+code);}
/** Parse actual TS, not regex/string matching: comments, type-only imports and
 * dead-looking dynamic imports are deliberately different. Every executable
 * import must be a literal reviewed local module or a fixed package capability. */
export function contentModuleImports(name:string,source:string):string[]{
 const result=parseSync(name,source);if(result.errors.length)fail('syntax');const deps=new Set<string>();
 function dependency(value:unknown){if(typeof value!=='string')fail('mutable_import');if(value.startsWith('./')){const local=value.slice(2);if(!/^[a-z0-9-]+\.ts$/u.test(local)||!(CONTENT_REPLACEMENT_MODULES as readonly string[]).includes(local))fail('unreviewed_local');deps.add(local);}else if(!externals.has(value))fail('external');}
 function walk(value:unknown):void{
  if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const item of value)walk(item);return;}const n=value as Record<string,unknown>,type=n['type'];
  if(['TSImportType','TSInterfaceDeclaration','TSTypeAliasDeclaration'].includes(String(type)))return;
  if(type==='ImportDeclaration'){if(n['importKind']!=='type'){const spec=n['specifiers'] as Record<string,unknown>[];if(!spec.length||spec.some(s=>s['importKind']!=='type'))dependency((n['source'] as Record<string,unknown>)['value']);}return;}
  if(type==='ExportAllDeclaration'||type==='ExportNamedDeclaration'){if(n['source']&&n['exportKind']!=='type')dependency((n['source'] as Record<string,unknown>)['value']);}
  if(type==='ImportExpression')dependency((n['source'] as Record<string,unknown>)?.['value']);
  if(type==='TSImportEqualsDeclaration')fail('require');
  if(type==='CallExpression'||type==='NewExpression'){const callee=n['callee'] as Record<string,unknown>|undefined;if(callee?.['type']==='Identifier'&&['require','eval','Function'].includes(String(callee['name'])))fail('mutable_loader');}
  for(const [key,child]of Object.entries(n))if(!['start','end','type','raw'].includes(key))walk(child);
 }
 walk(result.program);return [...deps].sort();
}
export function assertContentImportClosure(sources:Record<string,string>,roots:readonly string[]):Record<string,string[]>{
 if(!roots.length||roots.some(x=>!Object.hasOwn(sources,x)))fail('roots');const edges:Record<string,string[]>={};
 for(const [name,source]of Object.entries(sources)){if(!(CONTENT_REPLACEMENT_MODULES as readonly string[]).includes(name))fail('unreviewed_module');edges[name]=contentModuleImports(name,source);for(const dep of edges[name]!)if(!Object.hasOwn(sources,dep))fail('missing_module:'+dep);}
 const reached=new Set<string>();function visit(name:string){if(reached.has(name))return;reached.add(name);for(const dep of edges[name]??[])visit(dep);}for(const root of roots)visit(root);
 if(reached.size!==Object.keys(sources).length)fail('unreachable_module');return edges;
}
// Read-only installer subprocess. Never loads a Acme module or provider.
if(process.argv[2]==='--scan-content-closure'){
 let input='';for await(const chunk of process.stdin){input+=String(chunk);if(Buffer.byteLength(input)>16777216)fail('input_size');}
 const parsed=JSON.parse(input) as {sources:Record<string,string>;roots:string[];completeReviewed?:boolean;reviewedVersion?:number};
 const expected=parsed.reviewedVersion===6?CONTENT_REPLACEMENT_MODULES:parsed.reviewedVersion===4?CONTENT_REVIEWED_MODULES.filter(x=>!CONTENT_FINAL_CLEANUP_MODULES.includes(x as typeof CONTENT_FINAL_CLEANUP_MODULES[number])):CONTENT_REVIEWED_MODULES;if(parsed.completeReviewed&&(Object.keys(parsed.sources).length!==expected.length||expected.some(x=>!Object.hasOwn(parsed.sources,x))))fail('complete_reviewed_set');console.log(JSON.stringify(assertContentImportClosure(parsed.sources,parsed.roots)));
}
