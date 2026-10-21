import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, {recursive:true,force:true}); });
const script = fileURLToPath(new URL('./lineage.sh', import.meta.url));
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'kenan-lineage-')); roots.push(root);
 const shared = join(root, 'shared.git'), live = join(root, 'live'), mine = join(root, 'mine'), target = join(root, 'target');
 mkdirSync(target);
 const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd, encoding: 'utf8'}).trim();
 git(root, 'init', '-q', '--bare', '-b', 'main', shared);
 const commit = (cwd: string, name: string) => { writeFileSync(join(cwd, name), name); git(cwd, 'add', name); git(cwd, 'commit', '-qm', name); return git(cwd, 'rev-parse', 'HEAD'); };
 for (const clone of [live, mine]) git(root, 'clone', '-q', shared, clone);
 commit(live, 'base'); git(live, 'push', '-q', 'origin', 'main'); git(mine, 'pull', '-q', 'origin', 'main');
 const deployed = (sha: string) => writeFileSync(join(target, 'source-commit'), sha + '\n');
 const check = (mode: string) => spawnSync('bash', [script, target, mine, mode], {encoding: 'utf8'});
 return {live, mine, git, commit, deployed, check};
}
it('lets a deploy that contains the live commit through and reports the live commit for the swap', () => {
 const f = fixture();
 const live = f.git(f.live, 'rev-parse', 'HEAD'); f.deployed(live);
 f.commit(f.mine, 'feature'); f.git(f.mine, 'push', '-q', 'origin', 'HEAD:main');
 const r = f.check('forward');
 expect(r.status).toBe(0); expect(r.stdout.trim()).toBe(live);
});
it('names the live commits a deploy would drop, and allows it only as an explicit rollback', () => {
 const f = fixture();
 f.commit(f.live, 'live fix'); f.git(f.live, 'push', '-q', 'origin', 'HEAD:fix');
 f.deployed(f.git(f.live, 'rev-parse', 'HEAD'));
 f.commit(f.mine, 'other work'); f.git(f.mine, 'push', '-q', 'origin', 'HEAD:other');
 const r = f.check('forward');
 expect(r.status).toBe(8); expect(r.stderr).toContain('deploy_would_drop_live_commits'); expect(r.stderr).toContain('live fix');
 const back = f.check('rollback');
 expect(back.status).toBe(0); expect(back.stderr).toContain('live fix');
});
it('refuses a live commit nobody shared, an unpublished commit and uncommitted changes', () => {
 const f = fixture();
 f.deployed(f.commit(f.live, 'private deploy'));
 f.commit(f.mine, 'mine'); f.git(f.mine, 'push', '-q', 'origin', 'HEAD:main');
 expect(f.check('forward').stderr).toContain('deploy_live_commit_unknown');
 f.commit(f.mine, 'unpushed');
 expect(f.check('rollback').stderr).toContain('deploy_commit_unpublished');
 f.git(f.mine, 'push', '-q', 'origin', 'HEAD:main'); writeFileSync(join(f.mine, 'mine'), 'edited');
 expect(f.check('rollback').stderr).toContain('deploy_uncommitted_changes');
});
