#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile


def main():
    parser = argparse.ArgumentParser(description='Install the declared shared Android Gradle distribution')
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    spec = json.loads(args.manifest.read_text())
    if set(spec) != {'version', 'distributionUrl', 'distributionSha256', 'installationRoot'}:
        return {'ok': False, 'error': 'invalid-toolchain-manifest'}
    version = spec['version']
    if not isinstance(version, str) or not all(c.isdigit() or c == '.' for c in version):
        return {'ok': False, 'error': 'invalid-toolchain-version'}
    root = Path(spec['installationRoot'])
    if os.geteuid() == 0 and root.exists():
        root.chmod(0o755)
    target = root / version
    receipt = target / 'kenan-toolchain.json'
    executable = target / 'bin/gradle'
    if target.exists():
        if os.geteuid() == 0 and receipt.exists():
            receipt.chmod(0o644)
        if receipt.is_file() and json.loads(receipt.read_text()) == spec and os.access(executable, os.X_OK):
            return {'ok': True, 'state': 'already-installed', 'executable': str(executable), 'manifest': spec}
        return {'ok': False, 'error': 'different-or-incomplete-toolchain', 'path': str(target)}
    if os.geteuid() != 0:
        return {'ok': False, 'error': 'root-install-required'}
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o755)
    with tempfile.TemporaryDirectory(prefix='.gradle-install-', dir=root) as scratch:
        scratch = Path(scratch)
        archive = scratch / 'distribution.zip'
        download = subprocess.run(['curl', '--fail', '--location', '--max-time', '120', '--silent', '--show-error', '--output', str(archive), spec['distributionUrl']], timeout=125)
        if download.returncode != 0:
            return {'ok': False, 'error': 'distribution-download-failed', 'exitCode': download.returncode}
        with archive.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        download_bytes = archive.stat().st_size
        if digest != spec['distributionSha256']:
            return {'ok': False, 'error': 'distribution-hash-mismatch', 'observed': digest}
        with zipfile.ZipFile(archive) as bundle:
            prefix = 'gradle-' + version + '/'
            if any(not n.startswith(prefix) or '..' in Path(n).parts for n in bundle.namelist()):
                return {'ok': False, 'error': 'unexpected-distribution-layout'}
            for member in bundle.infolist():
                relative = Path(member.filename).parts[1:]
                if relative and (relative[0] in {'bin', 'lib'} or len(relative) == 1 and relative[0] in {'LICENSE', 'NOTICE', 'README'}):
                    bundle.extract(member, scratch)
        expanded = scratch / ('gradle-' + version)
        if not (expanded / 'bin/gradle').is_file():
            return {'ok': False, 'error': 'distribution-executable-missing'}
        for path in expanded.rglob('*'):
            path.chmod(0o755 if path.is_dir() or path.name == 'gradle' else 0o644)
        (expanded / 'kenan-toolchain.json').write_text(json.dumps(spec, indent=2) + '\n')
        (expanded / 'kenan-toolchain.json').chmod(0o644)
        expanded.chmod(0o755)
        expanded.rename(target)
    return {'ok': True, 'state': 'installed', 'executable': str(executable), 'downloadBytes': download_bytes, 'manifest': spec}


if __name__ == '__main__':
    try:
        result = main()
    except (OSError, ValueError, subprocess.TimeoutExpired, zipfile.BadZipFile) as error:
        result = {'ok': False, 'error': 'toolchain-install-failed', 'detail': str(error)}
    print(json.dumps(result))
    raise SystemExit(0 if result['ok'] else 1)
