#!/usr/bin/env python3
"""Exact Git-byte CONTENT adapter installer. Default is read-only; never reloads/dispatches.
Apply only after the sole release owner supplies publication and paused-provider receipts.
"""
import argparse, hashlib, json, os, pathlib, re, shutil, subprocess, tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data, uid=0):
    path = pathlib.Path(path)
    fd, name = tempfile.mkstemp(prefix='.content-new-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, uid, -1)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def qualify(manifest, repo, runtime_uid):
    # Private module mode stays 0600: non-root loaders need a separately reviewed design.
    if runtime_uid != 0:
        raise ValueError('runtime_uid_cannot_read_root_0600')
    retired = '/home/kenan/work/clones/taxonomy-rebase-63d'
    if os.path.abspath(repo) == retired:
        raise ValueError('retired_source_repository')
    repo = pathlib.Path(repo).resolve(strict=True)
    if str(repo) == retired:
        raise ValueError('retired_source_repository')
    sha = manifest['adapterSourceCommit']
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('exact_40_character_commit_required')
    resolved = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', sha+'^{commit}'], text=True).strip()
    if resolved != sha:
        raise ValueError('commit_mismatch')
    pins = manifest['moduleSHA256']
    if not pins or manifest['nativeInfrastructureCompiler'] != 'PASS' or manifest['candidateOwnTests'] != 'PASS':
        raise ValueError('qualification_required')
    data = {}
    for name, want in pins.items():
        if not re.fullmatch('[a-z0-9-]+\.ts', name):
            raise ValueError('unsafe_module_name')
        entry = subprocess.check_output(['git', '-C', str(repo), 'ls-tree', sha, '--', 'infrastructure/release/'+name], text=True)
        if not entry.startswith('100644 blob '):
            raise ValueError('regular_git_blob_required:'+name)
        content = subprocess.check_output(['git', '-C', str(repo), 'show', sha+':infrastructure/release/'+name])
        if digest(content) != want:
            raise ValueError('module_hash_mismatch:'+name)
        data[name] = content
    roots = ['content-cadence-dispatch-native.ts', 'content-cadence-option-b-native.ts']
    if manifest.get('version') in (5, 6):
        roots.append('content-cadence-final-cleanup-native.ts')
    if manifest.get('version') not in (4, 5, 6) or manifest.get('closureRoots') != roots:
        raise ValueError('reviewed_closure_roots_required')
    scanner = pathlib.Path(__file__).parent.parent/'server/extensions/content-module-closure.ts'
    subprocess.run(['node', str(scanner), '--scan-content-closure'], input=json.dumps({'sources': {k:v.decode() for k,v in data.items()}, 'roots':manifest['closureRoots'], 'completeReviewed':True, 'reviewedVersion':manifest['version']}), text=True, check=True, capture_output=True)
    return data


def validate_authorization(manifest, repo, authorization):
    sha = manifest['adapterSourceCommit']
    if authorization.get('candidate') != sha or authorization.get('providerPausedOrAbsent') is not True or authorization.get('dispatchOff') is not True:
        raise ValueError('install_conditions_required')
    if authorization.get('publicationVerified') is True:
        return
    q = authorization.get('candidateOwnRuntimeQualification', {})
    if not isinstance(q, dict) or q.get('scope') != 'beta-content-adapter-only' or q.get('productTargetUnchanged') is not True or q.get('rollbackPrepared') is not True:
        raise ValueError('qualified_adapter_authority_required')
    receipt_path = pathlib.Path(q.get('nativeReceipt', ''))
    if not receipt_path.is_absolute() or not receipt_path.is_file():
        raise ValueError('native_receipt_required')
    raw = receipt_path.read_bytes()
    receipt = json.loads(raw)
    if digest(raw) != q.get('nativeReceiptSHA256') or receipt.get('sourceCommit') != sha or pathlib.Path(receipt.get('root', '')).resolve() != pathlib.Path(repo).resolve():
        raise ValueError('native_sha_root_mismatch')
    compiler = receipt.get('compiler', {})
    result_path = pathlib.Path(compiler.get('resultFile', ''))
    result_raw = result_path.read_bytes()
    if compiler.get('exitCode') != 0 or digest(result_raw) != compiler.get('resultSha256') or json.loads(result_raw).get('ok') is not True:
        raise ValueError('native_compiler_failed')
    tests_path = pathlib.Path(q.get('testReceipt', ''))
    tests_raw = tests_path.read_bytes()
    if digest(tests_raw) != q.get('testReceiptSHA256') or json.loads(tests_raw).get('headInclusive') != q.get('testSourceHead'):
        raise ValueError('test_receipt_mismatch')
    if not q.get('testSourceHead') or not isinstance(q.get('tests'), dict) or q['tests'].get('pass', 0) < 1 or q['tests'].get('fail') != 0 or q['tests'].get('sourceCommit') != sha:
        raise ValueError('test_qualification_required')


def apply(manifest, repo, runtime_pid, authorization, host, gate, backup):
    if os.geteuid() != 0:
        raise ValueError('root_required')
    uid = os.stat('/proc/'+str(runtime_pid)).st_uid
    data = qualify(manifest, repo, uid)
    sha = manifest['adapterSourceCommit']
    validate_authorization(manifest, repo, authorization)
    raw = host.read_bytes()
    diagnostic = gate.read_bytes()
    if digest(raw) != manifest['currentHostSha256'] or digest(diagnostic) != manifest['currentDiagnosticSha256']:
        raise ValueError('host_or_gate_drift_replan')
    old = json.loads(raw)
    if old['version'] not in (1, 2, 3, 4, 5, 6) or old['operatorConfig'] != manifest['productTarget']:
        raise ValueError('product_target_or_version_changed')
    base = pathlib.Path(old['acmeSourceRoot'])
    dest = base.parent / sha
    if dest.exists() or backup.exists():
        raise ValueError('destination_or_backup_exists_reconcile')
    backup.mkdir(mode=0o700)
    atomic(backup/'host-before.private.json', raw)
    atomic(backup/'diagnostic-before.private.json', diagnostic)
    stage = pathlib.Path(tempfile.mkdtemp(prefix='.content-stage-', dir=base.parent))
    bound = False
    try:
        subprocess.run(['cp', '-al', str(base)+'/.', str(stage)], check=True)
        for name, content in data.items():
            leaf = stage/'infrastructure/release'/name
            baseline = base/'infrastructure/release'/name
            atomic(leaf, content)
            assert not baseline.exists() or leaf.stat().st_ino != baseline.stat().st_ino
            assert leaf.stat().st_nlink == 1 and leaf.stat().st_mode & 0o777 == 0o600
            assert digest(leaf.read_bytes()) == manifest['moduleSHA256'][name]
        # cp -a copies the old immutable root mode/owner too. The new root
        # must follow its trusted parent, not inherit an old 0555 snapshot.
        os.chown(stage, 0, base.parent.stat().st_gid)
        os.chmod(stage, 0o750)
        os.rename(stage, dest)
        new = {**old, 'version': manifest['version'], 'closureRoots': manifest['closureRoots'], 'productTargetCommit': old['operatorConfig']['dispatch']['sourceCommit'], 'sourceCommit': sha, 'acmeSourceRoot': str(dest), 'moduleSHA256': manifest['moduleSHA256']}
        # Repeat snapshots immediately before the sole binding mutation.
        if host.read_bytes() != raw or gate.read_bytes() != diagnostic:
            raise ValueError('concurrent_binding_or_gate_change')
        atomic(host, json.dumps(new, indent=2).encode())
        bound = True
        assert gate.read_bytes() == diagnostic
    except BaseException:
        if bound:
            atomic(host, raw)
        # Keep immutable destination/backup for reconciliation; never replay an install.
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def rollback(host, backup):
    # Explicit local config rollback only; does not change diagnostic/provider state.
    atomic(host, (backup/'host-before.private.json').read_bytes())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', required=True)
    p.add_argument('--repo', required=True)
    p.add_argument('--runtime-pid', required=True, type=int)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--authorization')
    p.add_argument('--backup')
    args = p.parse_args()
    manifest = json.loads(pathlib.Path(args.manifest).read_text())
    uid = os.stat('/proc/'+str(args.runtime_pid)).st_uid
    qualified = qualify(manifest, args.repo, uid)
    if args.apply:
        if not args.authorization or not args.backup:
            p.error('--apply requires --authorization and --backup')
        apply(manifest, args.repo, args.runtime_pid, json.loads(pathlib.Path(args.authorization).read_text()), pathlib.Path('/etc/kenan/content-cadence-host.json'), pathlib.Path('/etc/kenan/content-cadence-diagnostic.json'), pathlib.Path(args.backup))
    print(json.dumps({'candidate': manifest['adapterSourceCommit'], 'modules': len(qualified), 'runtimeUid': uid, 'root0600Readable': uid == 0, 'applied': args.apply, 'reload': False, 'providerWrites': False}))


if __name__ == '__main__':
    main()
