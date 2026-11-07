#!/usr/bin/env python3
"""Build/apply the negotiated-SDP strict-RTP fix; see README.md. Run as root."""
import filecmp
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
CACHE = Path('/var/cache/kenan/asterisk-media')
MODULE = Path('/usr/lib') / sysconfig.get_config_var('MULTIARCH') / 'asterisk/modules/res_rtp_asterisk.so'
PATCH = HERE / 'negotiated-media-learning.patch'
INSTALLED = Path('/usr/local/lib/kenan/asterisk-media')
DROPIN = Path('/etc/systemd/system/asterisk.service.d/media-learning.conf')
APT_HOOK = Path('/etc/apt/apt.conf.d/99kenan-asterisk-media')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def same(a, b):
    return a.exists() and b.exists() and filecmp.cmp(a, b, shallow=False)


def version():
    return subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', 'asterisk'], text=True).strip()


def build():
    v = version()
    CACHE.mkdir(parents=True, exist_ok=True)
    binary = CACHE / 'res_rtp_asterisk.so'
    stamp = CACHE / 'package-version'
    if binary.exists() and stamp.exists() and stamp.read_text().strip() == v and same(PATCH, CACHE / 'applied.patch'):
        return binary
    dev = subprocess.run(['dpkg-query', '-W', '-f=${Version}', 'asterisk-dev'], capture_output=True, text=True)
    if dev.stdout.strip() != v or not shutil.which('cc') or not shutil.which('patch') or not Path('/usr/include/openssl/ssl.h').exists() or not Path('/usr/include/jansson.h').exists():
        os.environ['KENAN_ASTERISK_BUILD'] = '1'
        run('apt-get', '-o', 'DPkg::Lock::Timeout=60', 'install', '-y', '--no-install-recommends', f'asterisk-dev={v}', 'build-essential', 'patch', 'libssl-dev', 'libjansson-dev')
    source_version = v.split(':', 1)[-1].rsplit('-', 1)[0]
    base = f'https://archive.ubuntu.com/ubuntu/pool/universe/a/asterisk/asterisk_{source_version}'
    work = CACHE / 'build'
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()
    for name, suffix in [('asterisk', '.orig.tar.xz'), ('pjproject', '.orig-Xpjproject.tar.xz')]:
        archive = CACHE / (name + '.tar.xz')
        urllib.request.urlretrieve(base + suffix, archive)
        with tarfile.open(archive) as tar:
            tar.extractall(work, filter='data')
    ast = next(work.glob('asterisk-*'))
    pj = next(work.glob('pjproject-*'))
    shutil.copyfile(ast / 'third-party/pjproject/patches/config_site.h', pj / 'pjlib/include/pj/config_site.h')
    run('./configure', '--disable-sound', '--disable-video', '--disable-opencore-amr', '--disable-silk', '--disable-libwebrtc', cwd=pj)
    run('patch', '-p1', '-i', str(PATCH), cwd=ast)
    includes = [f'-I{pj / part / "include"}' for part in ['pjlib', 'pjlib-util', 'pjnath', 'pjmedia', 'pjsip']]
    run('cc', '-shared', '-fPIC', '-O2', '-g', '-D_GNU_SOURCE', '-DPJ_AUTOCONF=1', '-DPJ_IS_BIG_ENDIAN=0', '-DPJ_IS_LITTLE_ENDIAN=1',
        '-DAST_MODULE="res_rtp_asterisk"', '-DAST_MODULE_SELF_SYM=__internal_res_rtp_asterisk_self', *includes,
        str(ast / 'res/res_rtp_asterisk.c'), '-o', str(binary) + '.new', '-lssl', '-lcrypto')
    os.replace(str(binary) + '.new', binary)
    shutil.copyfile(PATCH, CACHE / 'applied.patch')
    stamp.write_text(v + '\n')
    return binary


def active_channels():
    running = subprocess.run(['systemctl', 'is-active', '--quiet', 'asterisk']).returncode == 0
    if not running:
        return ''
    return subprocess.check_output(['asterisk', '-rx', 'core show channels concise'], text=True).strip()


def maintain_install():
    INSTALLED.mkdir(parents=True, exist_ok=True)
    for source in (Path(__file__).resolve(), PATCH):
        target = INSTALLED / source.name
        if source != target:
            shutil.copyfile(source, target)
    content = '[Service]\nExecStartPre=/usr/bin/python3 /usr/local/lib/kenan/asterisk-media/install-media.py install\n'
    if not DROPIN.exists() or DROPIN.read_text() != content:
        DROPIN.parent.mkdir(parents=True, exist_ok=True)
        DROPIN.write_text(content)
        run('systemctl', 'daemon-reload')
    APT_HOOK.write_text('DPkg::Post-Invoke { "test x$KENAN_ASTERISK_BUILD = x1 || systemd-run --collect --no-block --unit=kenan-asterisk-media-upgrade-$(date +%s%N) /usr/bin/python3 /usr/local/lib/kenan/asterisk-media/install-media.py upgrade"; };\n')


def main():
    if os.geteuid() != 0:
        raise SystemExit('asterisk_media_requires_root')
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action not in ('build', 'install', 'apply', 'upgrade', 'uninstall'):
        raise SystemExit('usage: install-media.py build|install|apply|upgrade|uninstall')
    if action == 'uninstall':
        if active_channels():
            raise SystemExit('asterisk_media_busy: active calls; leave the running module alone')
        DROPIN.unlink(missing_ok=True)
        run('systemctl', 'daemon-reload')
        APT_HOOK.unlink(missing_ok=True)
        run('apt-get', 'install', '-y', '--reinstall', f'asterisk-modules={version()}')
        run('systemctl', 'restart', 'asterisk')
        return
    binary = build()
    if action == 'build':
        print(binary)
        return
    maintain_install()
    if same(binary, MODULE):
        print('asterisk_media_unchanged')
        return
    # install is also ExecStartPre: Asterisk is not running then. apply is the live deploy path.
    busy = bool(active_channels())
    if action != 'upgrade' and busy:
        raise SystemExit('asterisk_media_busy: module built; active calls must finish before applying')
    # Atomic replacement preserves the old mapped module for running calls. Package
    # upgrades retain their current ABI in memory; the next process gets this build.
    shutil.copyfile(binary, str(MODULE) + '.new')
    os.chmod(str(MODULE) + '.new', 0o644)
    os.replace(str(MODULE) + '.new', MODULE)
    if action == 'apply' or (action == 'upgrade' and not busy):
        run('systemctl', 'restart', 'asterisk')
    elif action == 'upgrade' and busy:
        print('asterisk_media_running_calls_preserved: patched module ready for next process start')
    print('asterisk_media_installed')


if __name__ == '__main__':
    main()
