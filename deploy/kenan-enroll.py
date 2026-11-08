#!/usr/bin/python3 -I
"""Root enrollment for the public entrance: a verified ACME Google identity in, that person's Kenan account out.

The entrance (server/public/entrance.ts, Unix user pi2-gateway) verifies the Google ID token itself (signature, iss, aud,
email_verified, hd == acme.example) and then asks this service, over a root-owned socket only it may use, for the account.
On first sign-in this creates, each step only when missing and under one lock:
  - a Unix user kp<20 hex> with uid in 30000-30999 and a private (0700) home; kenan-people-firewall.nft keeps that uid
    range off every local, private and link-local address (the metadata server included) apart from DNS;
  - a login secret (/etc/kenan/people/ID.login-key, root 0600) and its scrypt verifier in the channels' verifierDir;
  - one entry appended to /etc/kenan/beta.json and /etc/kenan/production.json, checked by the installed build's
    config check before it replaces the file: isolated from every other person, a daily model allowance, OpenAI models
    only, no extensions, peers, phones or channels, and a Kenaznia hosted on Beta;
  - the person added live to each running channel through its root owner-control socket (no restart).
Alice (account acme) never comes here: the entrance signs her in to her own account. Identity bindings never move:
the account id is derived from the Google account id exactly as the earlier Auth0 enrollment derived it, so people who
enrolled before keep their accounts, and an email already bound to another Google account is refused.

kenan-enroll serve              run the socket service (kenan-enroll.service)
kenan-enroll upgrade-existing   bring earlier employee entries to the same isolated defaults (takes effect at restart)
"""
import fcntl, hashlib, http.server, json, os, pwd, re, secrets, socket, socketserver, struct, subprocess, sys, tempfile, time
from pathlib import Path

ETC = Path(os.environ.get('KENAN_ENROLL_ETC', '/etc/kenan'))
CHANNELS = ('beta', 'production')
PEOPLE_DIR = ETC / 'people'
BINDINGS = Path(os.environ.get('KENAN_ENROLL_STATE', '/var/lib/kenan/people'))
LEGACY_BINDINGS = Path(os.environ.get('KENAN_ENROLL_LEGACY', '/var/lib/pi-stack-oidc/people'))
LEGACY_KEYS = Path(os.environ.get('KENAN_ENROLL_LEGACY_KEYS', '/etc/pi-stack-next/provision'))
SOCKET = os.environ.get('KENAN_ENROLL_SOCKET', '/run/kenan-enroll/enroll.sock')
CONTROL = os.environ.get('KENAN_ENROLL_CONTROL', '/run/kenan/{channel}-owner-control.sock')
LOCK = os.environ.get('KENAN_ENROLL_LOCK', '/run/kenan-enroll/enroll.lock')
ENTRANCE_USER = 'pi2-gateway'
DOMAIN = 'acme.example'
ADMIN_EMAIL = 'person39@example.com'
# The binding namespace of the earlier Auth0 enrollment, kept so an existing Google account maps to its existing account.
LEGACY_ISSUER = 'https://ACME-auth.us.auth0.com/'
UID_RANGE = range(30000, 31000)
DAILY_USD = 10
SPAWN_MODELS = ['gpt-6.1-sol', 'gpt-6-luna']
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
EMAIL = re.compile(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@acme.example")


class Refused(ValueError):
    """The identity may not have an account here (403)."""


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value, mode=0o600, owner=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        if owner:
            os.fchown(fd, *owner)
        with os.fdopen(fd, 'w') as stream:
            stream.write(value if isinstance(value, str) else json.dumps(value, indent=2) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(*argv, timeout=120):
    done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=ENV)
    if done.returncode:
        raise RuntimeError(f'{" ".join(argv[:3])} failed ({done.returncode}): {(done.stderr or done.stdout).strip()[-400:]}')
    return done.stdout


def identity(request):
    """The exact verified identity the entrance sends; anything else is refused."""
    if not isinstance(request, dict) or set(request) != {'subject', 'email', 'hostedDomain'}:
        raise Refused('Exact verified identity required')
    subject, email, domain = request['subject'], request['email'], request['hostedDomain']
    if not isinstance(subject, str) or not re.fullmatch(r'[0-9]{1,64}', subject):
        raise Refused('Google account id required')
    if domain != DOMAIN or not isinstance(email, str) or email != email.lower() or not EMAIL.fullmatch(email):
        raise Refused('Verified ACME Workspace identity required')
    if email == ADMIN_EMAIL:
        raise Refused('The administrator signs in to her own account')
    return {'subject': subject, 'email': email}


def account_id(subject):
    return 'e-' + hashlib.sha256((LEGACY_ISSUER + '\0' + 'google-oauth2|' + subject).encode()).hexdigest()[:20]


def unix_name(identifier):
    return 'kp' + identifier[2:]


def check_binding(person, identifier):
    """An email belongs to one Google account. A re-created Google account with the same address is refused, not merged."""
    rows = []
    for directory in (LEGACY_BINDINGS, BINDINGS):
        if directory.is_dir():
            rows += [read(p) for p in sorted(directory.glob('*.json'))]
    for row in rows:
        email = str(row.get('email', '')).lower()
        subject = row.get('subject', '')
        bound = subject if not str(subject).startswith('google-oauth2|') else subject[len('google-oauth2|'):]
        if email == person['email'] and bound != person['subject']:
            raise Refused('This email is bound to a different Google account; an administrator must reconcile it')


def profile(email, home, hosted):
    prompt = (f'You are Kenan, the Acme work assistant for {email} at ACME. You work only for this person, on their '
              'ACME and Acme work. Your shell and file tools run as this person\'s own private account on the Acme '
              f'host, with its home at {home}. You cannot see, and must never try to reach, anyone else\'s chats, files, agents, '
              'goals, mail, calendar, Slack or accounts, Alice\'s included; if a task needs something outside this workspace, '
              'say what is needed and who owns it. Model use has a daily allowance, so keep work proportionate to the request. '
              'Write in plain English sentences and lead with the result.')
    return {'name': 'Kenaznia' if hosted else 'Kenan', 'provider': 'openai-codex', 'model': 'gpt-6.1-sol', 'thinking': 'medium',
            'systemPrompt': prompt, 'contextFiles': [f'{home}/AGENTS.md'], 'refusalFallbackModels': [], 'allowedSpawnModels': SPAWN_MODELS}


def isolated_entry(identifier, email, unix_user, uid, gid, home, broker_port, channel):
    """Everything a new person is: their own account and Kenaznia, nothing of anyone else's."""
    return {'id': identifier, 'name': email, 'unixUser': unix_user, 'uid': uid, 'gid': gid, 'home': home,
            'brokerPort': broker_port, 'heartbeatFile': None, 'alertDir': None, 'signalStore': None, 'pronouns': None,
            'peers': [], 'phones': [], 'extensions': [], 'isolated': True, 'budget': {'dailyUsd': DAILY_USD, 'claude': False},
            'swarmMaxActive': 2,
            # Like Alice's, the Kenaznia runs on Beta only; production keeps the account with workers and chats only.
            'manager': profile(email, home, True) if channel == 'beta' else None, 'worker': profile(email, home, False)}


def config_check(channel):
    """Validates a candidate config with the build that will read it."""
    def check(path):
        build = Path(f'/srv/kenan/{channel}/dist/server/config-check.js')
        if not build.exists():
            return
        run('/usr/local/bin/node', '-e', 'import(process.argv[1]).then(m => m.checkChannelConfig(process.argv[2]))', str(build), str(path))
    return check


def update_config(path, change, check):
    """Applies change(config) -> bool to one channel file, validated before it replaces the original (mode and owner kept)."""
    path = Path(path)
    data = read(path)
    if not change(data):
        return False
    stat = path.stat()
    fd, candidate = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.json', dir=path.parent)
    try:
        os.fchmod(fd, stat.st_mode & 0o777)
        os.fchown(fd, stat.st_uid, stat.st_gid)
        with os.fdopen(fd, 'w') as stream:
            stream.write(json.dumps(data, indent=2) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        check(candidate)
        os.replace(candidate, path)
    finally:
        if os.path.exists(candidate):
            os.unlink(candidate)
    return True


def add_live(channel, identifier):
    """Asks the running channel to load the new entry. A channel that is not running reads it at its next start."""
    path = CONTROL.format(channel=channel)
    if not os.path.exists(path):
        return 'not_running'
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(60)
        s.connect(path)
        s.sendall((json.dumps({'addPerson': identifier}) + '\n').encode())
        answer = b''
        while not answer.endswith(b'\n'):
            chunk = s.recv(4096)
            if not chunk:
                break
            answer += chunk
    result = json.loads(answer.decode() or '{}')
    if not result.get('ok'):
        raise RuntimeError(f'{channel} did not add the person: {result.get("error")}')
    return 'already' if result.get('already') else 'added'


def login_key(identifier):
    for path in (PEOPLE_DIR / f'{identifier}.login-key', LEGACY_KEYS / f'{identifier}.login-key'):
        if path.exists():
            return path.read_text().strip()
    return None


def ensure_user(identifier, email):
    name = unix_name(identifier)
    try:
        account = pwd.getpwnam(name)
    except KeyError:
        used = {p.pw_uid for p in pwd.getpwall()}
        uid = next((u for u in UID_RANGE if u not in used), None)
        if uid is None:
            raise RuntimeError('No free uid in the people range')
        run('/usr/sbin/useradd', '--uid', str(uid), '--user-group', '--create-home', '--shell', '/bin/bash', '--comment', email, name)
        account = pwd.getpwnam(name)
    if account.pw_uid not in UID_RANGE or account.pw_dir != f'/home/{name}':
        raise RuntimeError('Existing Unix account is outside the people range')
    os.chmod(account.pw_dir, 0o700)
    agents = Path(account.pw_dir) / 'AGENTS.md'
    if not agents.exists():
        write(agents, f'# Kenan workspace of {email}\n\nThis is a private ACME work account on the Acme host. Its files belong to {email} '
              'alone. Keep work within this account and never try to reach other people\'s files, chats or accounts.\n', 0o644, (account.pw_uid, account.pw_gid))
    # Tools run in the person's own systemd user context.
    subprocess.run(['loginctl', 'enable-linger', name], capture_output=True, timeout=30, env=ENV)
    return account


def enroll(request, channels=CHANNELS, check=config_check, live=add_live, make_user=None):
    person = identity(request)
    identifier = account_id(person['subject'])
    Path(LOCK).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(LOCK, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        check_binding(person, identifier)
        configs = {c: read(ETC / f'{c}.json') for c in channels if (ETC / f'{c}.json').exists()}
        known = {c: next((p for p in data['people'] if p['id'] == identifier), None) for c, data in configs.items()}
        if any(entry and entry['id'] == 'acme' for entry in known.values()):
            raise Refused('The administrator account is never enrolled')
        binding = BINDINGS / f'{identifier}.json'
        if not binding.exists():
            write(binding, {'subject': person['subject'], 'email': person['email'], 'accountId': identifier, 'createdAt': int(time.time() * 1000)})
        secret = login_key(identifier)
        existing = next((e for e in known.values() if e), None)
        if existing is None:
            account = (make_user or ensure_user)(identifier, person['email'])
            unix_user, uid, gid, home = account.pw_name, account.pw_uid, account.pw_gid, account.pw_dir
        else:
            unix_user, uid, gid, home = existing['unixUser'], existing['uid'], existing['gid'], existing['home']
        if secret is None:
            secret = secrets.token_urlsafe(48)
            write(PEOPLE_DIR / f'{identifier}.login-key', secret)
        verifier_dir = Path(next(iter(configs.values()))['verifierDir'])
        verifier = verifier_dir / f'{identifier}.json'
        if not verifier.exists():
            salt = secrets.token_hex(32)
            digest = hashlib.scrypt(secret.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()
            write(verifier, {'version': 1, 'salt': salt, 'digest': digest})
        broker = next((e['brokerPort'] for e in configs.get('beta', {}).get('people', []) if e['id'] == 'acme'), 25100)
        for channel in configs:
            if known[channel] is None:
                entry = isolated_entry(identifier, person['email'], unix_user, uid, gid, home, broker, channel)
                update_config(ETC / f'{channel}.json', lambda data: (data['people'].append(entry), True)[1], check(channel))
            try:
                live(channel, identifier)
            except Exception as error:
                # The entrance signs people in to Beta. Another channel that cannot load the entry live (not running,
                # or an older build without addPerson) reads it from its config at its next start.
                if channel == 'beta':
                    raise
                print(json.dumps({'event': 'live_add_deferred', 'channel': channel, 'accountId': identifier, 'error': str(error)[-300:]}), flush=True)
        return {'accountId': identifier, 'accountSecret': secret}


def upgrade_existing(channels=CHANNELS, check=config_check):
    """Earlier employee entries (ids e-…) get the same isolated defaults; their Unix accounts, homes and broker ports stay."""
    changed = []
    for channel in channels:
        path = ETC / f'{channel}.json'
        if not path.exists():
            continue
        def change(data):
            moved = False
            for i, entry in enumerate(data['people']):
                if not entry['id'].startswith('e-') or entry.get('isolated'):
                    continue
                email = entry['name']
                binding = BINDINGS / f'{entry["id"]}.json'
                rows = [read(p) for p in LEGACY_BINDINGS.glob('*.json')] if LEGACY_BINDINGS.is_dir() else []
                legacy = next((r for r in rows if r.get('user') == entry['unixUser']), None)
                if legacy and '@' in str(legacy.get('email', '')):
                    email = legacy['email'].lower()
                if binding.exists():
                    email = read(binding)['email']
                data['people'][i] = isolated_entry(entry['id'], email, entry['unixUser'], entry['uid'], entry['gid'], entry['home'], entry['brokerPort'], channel)
                changed.append((channel, entry['id']))
                moved = True
            return moved
        update_config(path, change, check(channel))
    return changed


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        try:
            _, uid, _ = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != pwd.getpwnam(ENTRANCE_USER).pw_uid or self.path != '/enroll':
                raise Refused('Public entrance identity required')
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096:
                raise Refused('Bounded identity request required')
            response, status = enroll(json.loads(self.rfile.read(length))), 200
            print(json.dumps({'event': 'enrolled', 'accountId': response['accountId']}), flush=True)
        except Refused as error:
            response, status = {'error': str(error)}, 403
            print(json.dumps({'event': 'refused', 'reason': str(error)}), flush=True)
        except Exception as error:
            response, status = {'error': 'Your workspace is being prepared; retry sign-in in a minute'}, 503
            print(json.dumps({'event': 'failed', 'error': str(error)[-500:]}), flush=True)
        body = json.dumps(response).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve():
    Path(SOCKET).parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    with Server(SOCKET, Handler) as server:
        entrance = pwd.getpwnam(ENTRANCE_USER)
        os.chown(SOCKET, entrance.pw_uid, entrance.pw_gid)
        os.chmod(SOCKET, 0o600)
        server.serve_forever()


if __name__ == '__main__':
    if os.getuid() != 0:
        sys.exit('kenan-enroll runs as root')
    action = sys.argv[1] if len(sys.argv) > 1 else ''
    if action == 'serve':
        serve()
    elif action == 'upgrade-existing':
        print(json.dumps({'upgraded': upgrade_existing()}))
    else:
        sys.exit(__doc__)
