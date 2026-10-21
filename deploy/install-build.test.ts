import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, {recursive:true,force:true}); });
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'kenan-deploy-')); roots.push(root);
 const source=join(root,'source'),target=join(root,'target'),bin=join(root,'bin'),trace=join(root,'trace'),state=join(root,'state');
 for(const base of [source,target]) {
  for(const dir of ['dist/server','dist/shared','dist/web/assets','node_modules']) mkdirSync(join(base,dir),{recursive:true});
  for(const [file,text] of Object.entries({'dist/server/main.js':'same server','dist/shared/contract.js':'same contract','dist/web/index.html':'old index','dist/web/assets/old.js':'old asset','node_modules/version':'old deps','package.json':'same package','package-lock.json':'same lock'})) writeFileSync(join(base,file),text);
 }
 mkdirSync(bin);writeFileSync(state,'running');
 // Callers (often agents) may themselves run inside a kenan@ unit; the fixture starts outside the app.
 writeFileSync(join(bin,'grep'),'#!/bin/bash\nexit 1\n',{mode:0o755});
 writeFileSync(join(bin,'systemctl'),`#!/bin/bash\necho "service $*" >> "$TRACE"\ncase "$1" in\n is-active) test "$(cat "$STATE")" = running;;\n stop) echo stopped > "$STATE";;\n start) test -f "$TARGET/dist/server/main.js" && test -f "$TARGET/node_modules/version" || exit 1; echo running > "$STATE";;\nesac\n`,{mode:0o755});
 writeFileSync(join(bin,'cp'),`#!/bin/bash\ncase "$*" in\n *source/node_modules/.*) echo "dependency-copy $(cat "$STATE")" >> "$TRACE"; test "$FAIL_COPY" != yes || exit 1;;\nesac\nexec /bin/cp "$@"\n`,{mode:0o755});
 const run=(extra={})=>execFileSync('bash',[fileURLToPath(new URL('./install-build.sh',import.meta.url)),'beta',source,target,'abc1234',(extra as {EXPECTED_LIVE?:string}).EXPECTED_LIVE??'none'],{env:{...process.env,PATH:bin+':'+process.env.PATH,TRACE:trace,STATE:state,TARGET:target,...extra},encoding:'utf8'});
 return {source,target,bin,run,trace:()=>readFileSync(trace,'utf8'),state:()=>readFileSync(state,'utf8').trim()};
}
it('publishes frontend-only changes without stopping the server and retains cached assets',()=>{
 const f=fixture();writeFileSync(join(f.source,'dist/web/index.html'),'new index');writeFileSync(join(f.source,'dist/web/assets/new.js'),'new asset');
 expect(f.run()).toContain('backend restarted: false');
 expect(f.trace()).not.toMatch(/service (stop|start) /);
 expect(readFileSync(join(f.target,'dist/web/index.html'),'utf8')).toBe('new index');
 expect(readFileSync(join(f.target,'dist/web/assets/old.js'),'utf8')).toBe('old asset');
 expect(readFileSync(join(f.target,'dist/web/assets/new.js'),'utf8')).toBe('new asset');
});
it('stages dependencies while serving, then starts the complete backend once',()=>{
 const f=fixture();writeFileSync(join(f.source,'package-lock.json'),'new lock');writeFileSync(join(f.source,'node_modules/version'),'new deps');writeFileSync(join(f.source,'dist/server/main.js'),'new server');
 expect(f.run()).toContain('backend restarted: true');
 const trace=f.trace();expect(trace.indexOf('dependency-copy running')).toBeLessThan(trace.indexOf('service stop'));
 expect(trace.match(/service stop/g)).toHaveLength(1);expect(trace.match(/service start/g)).toHaveLength(1);
 expect(readFileSync(join(f.target,'node_modules/version'),'utf8')).toBe('new deps');expect(f.state()).toBe('running');
 expect(readdirSync(f.target).some(name=>name.startsWith('.deploy-'))).toBe(false);
});
it('leaves the serving version untouched if staging fails',()=>{
 const f=fixture();writeFileSync(join(f.source,'package-lock.json'),'new lock');
 expect(()=>f.run({FAIL_COPY:'yes'})).toThrow();
 expect(f.trace()).not.toContain('service stop');expect(f.state()).toBe('running');
 expect(readFileSync(join(f.target,'package-lock.json'),'utf8')).toBe('same lock');
});

it('refuses to publish when the channel moved after the lineage check',()=>{
 const f=fixture();writeFileSync(join(f.target,'source-commit'),'f'.repeat(40)+'\n');writeFileSync(join(f.source,'dist/server/main.js'),'new server');
 expect(()=>f.run({EXPECTED_LIVE:'e'.repeat(40)})).toThrow(/deploy_channel_moved/);
 expect(readFileSync(join(f.target,'dist/server/main.js'),'utf8')).toBe('same server');
 expect(f.run({EXPECTED_LIVE:'f'.repeat(40)})).toContain('backend restarted: true');
 expect(readFileSync(join(f.target,'source-commit'),'utf8')).toBe('abc1234\n');
});

it('dispatches app-initiated deployments outside the app service before touching its files',()=>{
 const f=fixture();
 writeFileSync(join(f.bin,'grep'),'#!/bin/bash\nexit 0\n',{mode:0o755});
 writeFileSync(join(f.bin,'systemd-run'),'#!/bin/bash\nprintf "%s\\n" "$@" >> "$TRACE"\n',{mode:0o755});
 expect(f.run()).toContain('Deployment continues independently');
 expect(f.trace()).toContain('--unit=kenan-deploy-beta-');
 expect(f.trace()).toContain('install-build.sh');
 expect(f.trace()).not.toContain('service stop');
 expect(f.state()).toBe('running');
});
