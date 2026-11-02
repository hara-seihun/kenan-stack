#!/usr/bin/env python3
"""Install the small Claude sharing fix without replacing unrelated broker code.

The installed broker predates main and carries its own qualified runtime changes.
Copy that immutable runtime, apply only the reviewed selector and one affinity
expression, and retain its dependencies. SIGTERM drains active requests before
systemd starts the new release. The old release is the printed rollback.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

BASE_SELECTOR = '516883aa4bb97d30d149c28f2f163442aabe4dc3adc3baaf6248394d52e7019c'
OLD = 'const affinity = scoped(listener.principal, body.prompt_cache_key ?? req.headers["session-id"] ?? req.headers["session_id"] ?? req.headers["x-claude-code-session-id"]);'
NEW = OLD[:-2] + ' ?? randomUUID());'


def patch_sources(selector, desired, broker):
    if selector != desired and hashlib.sha256(selector.encode()).hexdigest() != BASE_SELECTOR:
        raise RuntimeError('Installed selector changed; preserve it and integrate this fix explicitly')
    if OLD in broker:
        if broker.count(OLD) != 1:
            raise RuntimeError('Affinity anchor is ambiguous')
        broker = broker.replace(OLD, NEW)
    elif NEW not in broker:
        raise RuntimeError('Installed broker affinity changed; no unreviewed replacement')
    return desired, broker


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=240, **kwargs)


def readiness_dropin():
    # The firewall deliberately permits only root and the outer broker's UID.
    # ExecStartPost otherwise inherits the unprivileged Claude broker UID and
    # cannot connect to its own port, turning a healthy restart into a loop.
    # Elevate only the bounded socket probe, not the broker or its firewall.
    return '[Service]\nExecStartPost=\nExecStartPost=+/usr/bin/python3 /opt/kenan-claude-broker/deploy/wait-ready.py 25121 60\n'


def install_readiness():
    directory = Path('/etc/systemd/system/kenan-claude-broker.service.d')
    directory.mkdir(mode=0o755, exist_ok=True)
    path = directory / 'readiness.conf'
    temporary = directory / f'.readiness-{os.getpid()}'
    temporary.write_text(readiness_dropin())
    temporary.chmod(0o644)
    os.replace(temporary, path)
    run(['systemctl', 'daemon-reload'])


def main():
    if os.getuid() != 0:
        raise RuntimeError('Install requires root')
    root = Path(__file__).resolve().parents[1]
    source = root / 'packages/orchestrator/src/auth/account-selection.ts'
    receiver = root / 'deploy/receive-claude-account.mjs'
    for path in [source, Path(__file__), receiver]:
        run(['git', '-c', f'safe.directory={root}', '-C', str(root), 'diff', '--exit-code', 'HEAD', '--', str(path)], stdout=subprocess.DEVNULL)
    commit = run(['git', '-c', f'safe.directory={root}', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    base = Path('/opt/kenan-claude-broker')
    current = base / 'current'
    old = current.resolve()
    selector, broker = patch_sources((old/'src/auth/account-selection.ts').read_text(),source.read_text(),(old/'src/model-broker.ts').read_text())
    install_readiness()
    receiving_path = base / 'deploy/receive-claude-account.mjs'
    run(['install', '-o', 'root', '-g', 'root', '-m', '755', str(receiver), str(receiving_path)])
    run(['ln', '-sfn', str(receiving_path), '/usr/local/sbin/kenan-claude-account-receive'])
    if selector == (old/'src/auth/account-selection.ts').read_text() and broker == (old/'src/model-broker.ts').read_text():
        run(['systemctl','start','kenan-claude-broker.service'])
        run(['systemctl','is-active','--quiet','kenan-claude-broker.service'])
        print(json.dumps({'sourceCommit':commit,'release':str(old),'runtimeUnchanged':True,'readinessRepaired':True}))
        return
    dest = base / ('sharing-' + commit[:12])
    if dest.exists():
        raise RuntimeError('Release already exists; inspect its manifest before activating it again')
    run(['cp', '-a', '--reflink=auto', str(old), str(dest)])
    manifest = {'sourceCommit':commit,'base':str(old),'files':{}}
    for relative, content in [('auth/account-selection',selector),('model-broker',broker)]:
        ts = dest / ('src/' + relative + '.ts')
        js = dest / ('dist/' + relative + '.js')
        ts.write_text(content)
        # The installed esbuild only erases TypeScript. All imports and the old
        # runtime's unrelated code remain intact; there is no bundle or npm update.
        program = "const{createRequire}=require('node:module');const fs=require('node:fs');const esbuild=createRequire(process.argv[1]+'/package.json')('esbuild');fs.writeFileSync(process.argv[3],esbuild.transformSync(fs.readFileSync(process.argv[2],'utf8'),{loader:'ts',format:'esm',target:'es2022'}).code);"
        run(['/usr/local/bin/node','-e',program,str(old),str(ts),str(js)])
        run(['/usr/local/bin/node','--check',str(js)])
        manifest['files'][relative] = {'sourceSha256':hashlib.sha256(content.encode()).hexdigest(),'artifactSha256':hashlib.sha256(js.read_bytes()).hexdigest()}
    (dest/'sharing-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    # Dry fixture acceptance of the actual emitted selector, before activation.
    program = "const {Store}=await import(process.argv[1]+'/dist/store.js');const{chooseInteractiveAccount}=await import(process.argv[1]+'/dist/auth/account-selection.js');const s=Store.open(':memory:');for(const[id,p]of[['anthropic-2',68],['anthropic-5',69],['anthropic-6',46]]){s.upsertAccount({id,provider:'anthropic'});s.recordMeter(id,'anthropic-7d',p,Date.now()+86400000);}const seen=new Set();for(let n=0;n<9;n++){const a=chooseInteractiveAccount(s,{has:()=>true},'anthropic');seen.add(a.id);s.createLease('fixture-'+n,a.id,'interactive',undefined,Date.now()+n);s.endLease('fixture-'+n);}s.close();if(seen.size!==3)throw Error('Compiled selector did not share');"
    run(['/usr/local/bin/node','--input-type=module','-e',program,str(dest)])
    temporary = base / f'.current-{os.getpid()}'
    temporary.symlink_to(dest)
    os.replace(temporary,current)
    try:
        run(['systemctl','restart','kenan-claude-broker.service'])
        run(['systemctl','is-active','--quiet','kenan-claude-broker.service'])
    except Exception:
        temporary.symlink_to(old);os.replace(temporary,current)
        run(['systemctl','restart','kenan-claude-broker.service'])
        raise
    print(json.dumps({**manifest,'release':str(dest),'rollback':f'ln -sfn {old} /opt/kenan-claude-broker/current && systemctl restart kenan-claude-broker.service'}))


if __name__ == '__main__':
    main()
