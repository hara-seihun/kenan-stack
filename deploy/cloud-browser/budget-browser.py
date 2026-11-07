#!/usr/bin/python3
"""Opt-in, isolated local HTTP acquisition with a persistent dispatch budget.

No existing profile, cloud attachment, credentials, interactions or arbitrary CDP
commands are accepted. Ordinary agent-browser sessions are never modified.
"""
import argparse
import asyncio
import base64
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse
import websockets


class Failure(Exception):
    pass


def browser_binary():
    # Reuse the host's real browser. Ubuntu's chromium-browser can be only a
    # snap installer shim, while Debian supplies /usr/bin/chromium.
    for name in ('chromium', 'google-chrome-stable', 'google-chrome', 'chromium-browser'):
        binary = shutil.which(name)
        if not binary:
            continue
        try:
            version = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=5)
            if version.returncode == 0 and version.stdout.startswith(('Chromium ', 'Google Chrome ')):
                return binary
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise Failure('BUDGET_ENFORCEMENT_UNAVAILABLE: Install a working Chromium or Google Chrome executable.')


class BudgetParser(argparse.ArgumentParser):
    def error(self, message):
        raise Failure('BUDGET_CONFIGURATION_UNSUPPORTED: Use only the documented isolated acquisition options; cloud attachment and profiles are not supported.')


def persist(path, state):
    temporary = path.with_suffix('.next')
    with open(temporary, 'w') as file:
        os.chmod(temporary, 0o600)
        json.dump(state, file)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def parent_death():
    # Children cannot retain an uncontrolled browser if this process is killed.
    parent = os.getpid()
    def setup():
        ctypes.CDLL(None).prctl(1, signal.SIGKILL)
        if os.getppid() != parent:
            os.kill(os.getpid(), signal.SIGKILL)
    return setup


async def wait_path(path, child):
    deadline = time.monotonic() + 10
    while not path.exists():
        if child.poll() is not None or time.monotonic() > deadline:
            raise Failure('BUDGET_ENFORCEMENT_UNAVAILABLE: A controlled child failed to start.')
        await asyncio.sleep(.025)


class CDP:
    def __init__(self, ws):
        self.ws, self.index, self.pending = ws, 0, {}
        self.loaded = asyncio.Queue()

    async def receive(self):
        try:
            async for raw in self.ws:
                message = json.loads(raw)
                if message.get('id') in self.pending:
                    self.pending.pop(message['id']).set_result(message)
                elif message.get('method') == 'Page.loadEventFired':
                    self.loaded.put_nowait(True)
        finally:
            for future in self.pending.values():
                future.set_exception(Failure('BUDGET_BROWSER_DISCONNECTED'))

    async def call(self, method, params=None):
        self.index += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.index] = future
        await self.ws.send(json.dumps({'id': self.index, 'method': method, 'params': params or {}}))
        reply = await asyncio.wait_for(future, 15)
        if 'error' in reply:
            raise Failure('BUDGET_BROWSER_PROTOCOL_ERROR')
        return reply.get('result', {})


async def acquire(args, ledger):
    executable = browser_binary()
    children = []
    with tempfile.TemporaryDirectory(prefix='budget-browser-') as temporary:
        root = Path(temporary)
        os.chmod(root, 0o700)
        ready = root / 'ready'
        certificate = root / 'proxy.pem'
        key = root / 'proxy.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(key), '-out', str(certificate), '-days', '1',
                        '-subj', '/CN=Isolated acquisition proxy'], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        public = subprocess.check_output(['openssl', 'x509', '-in', str(certificate), '-pubkey', '-noout'])
        der = subprocess.check_output(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public)
        spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
        certificate.write_bytes(certificate.read_bytes() + key.read_bytes())
        # The temporary certificate is trusted only by this disposable browser.
        # mitmproxy still verifies the actual upstream site's TLS certificate.
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            proxy_port = sock.getsockname()[1]
        environment = {**os.environ, 'BROWSER_BUDGET_LEDGER': str(ledger),
                       'BROWSER_BUDGET_READY': str(ready)}
        if args.allowed_host:
            environment['BROWSER_BUDGET_ALLOWED_HOSTS'] = ','.join(args.allowed_host)
        else:
            environment.pop('BROWSER_BUDGET_ALLOWED_HOSTS', None)
        try:
            with open(root / 'proxy.log', 'w') as log:
                proxy_options = []
                if args.upstream_ca:
                    proxy_options = ['--set', f'ssl_verify_upstream_trusted_ca={args.upstream_ca.resolve()}']
                proxy = subprocess.Popen([
                    '/usr/bin/mitmdump', '--quiet', '--listen-host', '127.0.0.1',
                    '--listen-port', str(proxy_port), '--set', f'confdir={root / "mitm"}',
                    '--certs', f'*={certificate}', '--set', 'connection_strategy=lazy',
                    '--set', 'upstream_cert=false', '--set', 'http2=false',
                    '--set', 'rawtcp=false', '--set', 'websocket=false',
                    '-s', str(Path(__file__).resolve().with_name('request-budget.py')), *proxy_options],
                    env=environment, stdout=log, stderr=log, preexec_fn=parent_death())
                children.append(proxy)
                await wait_path(ready, proxy)
                profile = root / 'chrome'
                chrome = subprocess.Popen([
                    executable, '--headless=new', '--no-sandbox', '--password-store=basic',
                    '--disable-dev-shm-usage', '--remote-debugging-port=0',
                    f'--user-data-dir={profile}', f'--proxy-server=http://127.0.0.1:{proxy_port}',
                    '--proxy-bypass-list=<-loopback>', '--disable-quic',
                    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
                    '--disable-background-networking', '--disable-component-update',
                    '--disable-sync', '--no-first-run', '--no-default-browser-check',
                    '--disable-default-apps', '--disable-extensions',
                    '--disable-features=MediaRouter,OptimizationHints,Prerender2,SpeculationRulesPrefetch',
                    '--disable-breakpad', '--disable-domain-reliability',
                    '--safebrowsing-disable-auto-update',
                    f'--ignore-certificate-errors-spki-list={spki}', 'about:blank'],
                    stdout=log, stderr=log, preexec_fn=parent_death())
                children.append(chrome)
                active = profile / 'DevToolsActivePort'
                await wait_path(active, chrome)
                lines = active.read_text().splitlines()
                async with websockets.connect(f'ws://127.0.0.1:{lines[0]}{lines[1]}', max_size=8*1024*1024) as browser:
                    await browser.send(json.dumps({'id': 1, 'method': 'Target.getTargets'}))
                    while True:
                        response = json.loads(await browser.recv())
                        if response.get('id') == 1:
                            break
                    target = next(t['targetId'] for t in response['result']['targetInfos'] if t['type'] == 'page')
                async with websockets.connect(f'ws://127.0.0.1:{lines[0]}/devtools/page/{target}', max_size=8*1024*1024) as ws:
                    cdp = CDP(ws)
                    reader = asyncio.create_task(cdp.receive())
                    try:
                        await cdp.call('Page.enable')
                        for url in args.url:
                            state = json.loads(ledger.read_text())
                            if state['reserved'] >= state['limit']:
                                state['exhausted'] = True
                                persist(ledger, state)
                                break
                            if not ready.exists() or proxy.poll() is not None:
                                raise Failure('BUDGET_ENFORCEMENT_UNAVAILABLE')
                            while not cdp.loaded.empty():
                                cdp.loaded.get_nowait()
                            result = await cdp.call('Page.navigate', {'url': url})
                            if not result.get('errorText'):
                                try:
                                    await asyncio.wait_for(cdp.loaded.get(), 8)
                                except asyncio.TimeoutError:
                                    pass
                            # A short bounded rendering interval also permits ordinary
                            # on-load XHR; the proxy remains the enforcement boundary.
                            await asyncio.sleep(.2)
                            text = await cdp.call('Runtime.evaluate', {'expression': 'document.body?.innerText || ""', 'returnByValue': True})
                            state = json.loads(ledger.read_text())
                            print(json.dumps({'type': 'BUDGET_PAGE', 'url': url,
                                              'reserved': state['reserved'],
                                              'text': text.get('result', {}).get('value', ''),
                                              'navigationError': result.get('errorText')}), flush=True)
                        if not ready.exists() or proxy.poll() is not None:
                            raise Failure('BUDGET_ENFORCEMENT_UNAVAILABLE')
                    finally:
                        reader.cancel()
        finally:
            for child in reversed(children):
                if child.poll() is None:
                    child.terminate()
            for child in reversed(children):
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def main():
    parser = BudgetParser(description=__doc__)
    parser.add_argument('--acquisition', type=Path, required=True,
                        help='Private persistent directory. Reuse it for all commands in one acquisition.')
    parser.add_argument('--http-request-budget', type=int, required=True)
    parser.add_argument('--upstream-ca', type=Path,
                        help='Optional public CA bundle for upstream TLS verification. Verification is never disabled.')
    parser.add_argument('--allowed-host', action='append', default=[],
                        help='Optional exact host allowlist, applied before upstream dispatch.')
    parser.add_argument('--url', action='append', required=True, help='Public HTTP(S) document. Repeat for subsequent navigations.')
    args = parser.parse_args()
    if args.http_request_budget < 1:
        raise Failure('BUDGET_CONFIGURATION_UNSUPPORTED: The budget must be a positive integer.')
    for url in args.url:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise Failure('BUDGET_CONFIGURATION_UNSUPPORTED: Only public HTTP(S) URLs without credentials are supported.')
    args.acquisition = args.acquisition.expanduser().resolve()
    args.acquisition.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.acquisition.stat().st_uid != os.getuid() or args.acquisition.stat().st_mode & 0o077:
        raise Failure('BUDGET_CONFIGURATION_UNSUPPORTED: The acquisition directory must be private and owned by this user.')
    with open(args.acquisition / 'lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure('BUDGET_ACQUISITION_BUSY')
        ledger = args.acquisition / 'budget.json'
        if ledger.exists():
            state = json.loads(ledger.read_text())
            if state.get('limit') != args.http_request_budget or state.get('version') != 1:
                raise Failure('BUDGET_CONFIGURATION_UNSUPPORTED: An acquisition cannot change its original budget.')
            if type(state.get('reserved')) is not int or not 0 <= state['reserved'] <= state['limit']:
                raise Failure('BUDGET_ENFORCEMENT_UNAVAILABLE: The existing ledger is invalid.')
        else:
            state = {'version': 1, 'limit': args.http_request_budget, 'reserved': 0, 'exhausted': False}
            persist(ledger, state)
        if state['reserved'] < state['limit']:
            asyncio.run(acquire(args, ledger))
        state = json.loads(ledger.read_text())
        exhausted = state.get('exhausted') or state['reserved'] >= state['limit']
        kind = 'BUDGET_EXHAUSTED' if exhausted else ('BUDGET_PROTOCOL_REFUSED' if state.get('refusedProtocol') else 'BUDGET_OK')
        print(json.dumps({'success': kind == 'BUDGET_OK', 'type': kind, **state}), flush=True)
        return 2 if kind != 'BUDGET_OK' else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        kind = str(error).split(':')[0] if isinstance(error, Failure) else 'BUDGET_ENFORCEMENT_UNAVAILABLE'
        print(json.dumps({'success': False, 'type': kind, 'error': str(error)}), flush=True)
        sys.exit(1)
