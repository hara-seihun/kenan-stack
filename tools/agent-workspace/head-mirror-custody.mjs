import fs from 'node:fs';
import path from 'node:path';

// Release may rely on remote publication. Offline pricing requires this separate,
// exact closure in the canonical mirror, not merely a clone's borrowed object store.
export function observeHeadMirrorCustody({workspace, mirror, command, timeout = 1000}) {
 const env = {GIT_NO_LAZY_FETCH:'1', GIT_NO_REPLACE_OBJECTS:'1', GIT_ALTERNATE_OBJECT_DIRECTORIES:''};
 let commit = null;
 const evidence = (kind, detail) => ({kind, commit, mirror,
  sourcePricing:kind === 'complete' ? 'eligible' : kind === 'absent-or-incomplete' ? 'unestimated' : 'unknown',
  detail});
 try {
  const head = command('git',['-C',workspace,'rev-parse','--verify','HEAD^{commit}'],{env,timeout});
  if (head.status !== 0 || head.error || !/^[a-f0-9]{40}$/.test(head.stdout)) return evidence('unknown','The checkout HEAD could not be observed.');
  commit = head.stdout;
  if (!fs.existsSync(mirror)) return evidence('absent-or-incomplete','No canonical mirror exists. Remote publication is not an offline closure proof.');
  if (fs.existsSync(path.join(mirror,'objects/info/alternates'))) return evidence('absent-or-incomplete','The canonical mirror does not own its objects independently.');
  const closure = command('git',['--git-dir',mirror,'rev-list','--objects','--quiet','--missing=error',`${commit}^{commit}`],{env,timeout});
  if (closure.error || closure.signal || closure.status === null) return evidence('unknown','The bounded offline closure observation did not finish.');
  return closure.status === 0 ? evidence('complete','The canonical mirror independently holds this exact HEAD closure. Capacity and other admission checks remain separate.')
   : evidence('absent-or-incomplete','This exact HEAD closure is absent or incomplete. Re-admit through the unestimated import route before requesting priced work.');
 } catch {
  return evidence('unknown','The bounded offline closure observation was unavailable. No custody or pricing eligibility is claimed.');
 }
}
