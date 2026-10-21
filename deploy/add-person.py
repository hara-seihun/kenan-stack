#!/usr/bin/python3 -I
"""Add a person to Kenan Stack on kenan-server in one command.

kenan-add-person ID NAME --pronouns PRONOUNS|none --like TEMPLATE [--mesh-key]

Creates (each step only when missing) the Unix account and personal folder, their
instructions, account state, tool domain, login secret and verifier, model-broker
listener, entries in both channel configs (Kenaznia hosted on production), the
household grants and the Headscale identity; restarts what must restart and
verifies the login against production. TEMPLATE is an existing production person
whose tool domain and agent profiles are copied with names and paths substituted.
Secrets are written to /etc/kenan/provision and only their paths are printed.
"""
import argparse, copy, fcntl, grp, hashlib, json, os, pwd, re, secrets, shutil, socket, subprocess, sys, time
from pathlib import Path

ETC = Path('/etc/kenan')
CHANNELS = {c: ETC / f'{c}.json' for c in ('beta', 'production')}
BROKER = ETC / 'model-broker.json'
PROVISION = ETC / 'provision'
STATE = Path('/var/lib/kenan/account-state')
PRODUCTION_URL = 'https://kenan.example.com'
ID = re.compile(r'[a-z][a-z0-9-]{0,30}')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root'}


class Failure(Exception):
    pass


def run(*argv, input=None):
    done = subprocess.run(argv, input=input, capture_output=True, text=True, timeout=120, env=ENV)
    if done.returncode:
        raise Failure(f'{" ".join(argv[:3])} failed ({done.returncode}): {done.stderr.strip()[-400:]}')
    return done.stdout


def write_json(path, data, mode):
    """Rewrite in place so the file keeps its ACLs (kenan-user-grants also reconciles them)."""
    text = json.dumps(data, indent=2, ensure_ascii=False) + '\n'
    if path.exists():
        with open(path, 'r+') as f:
            f.seek(0); f.write(text); f.truncate()
    else:
        path.write_text(text)
    os.chmod(path, mode)


def substitute(value, pairs):
    if isinstance(value, str):
        for old, new in pairs:
            value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [substitute(v, pairs) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, pairs) for k, v in value.items()}
    return value


def ensure_account(person):
    try:
        account = pwd.getpwnam(person)
        return account.pw_uid, False
    except KeyError:
        pass
    uid = next(u for u in range(1006, 60000) if not _taken(u))
    run('groupadd', '-g', str(uid), person)
    run('useradd', '-u', str(uid), '-g', str(uid), '-m', '-d', f'/home/{person}', '-s', '/bin/bash', person)
    os.chmod(f'/home/{person}', 0o700)
    return uid, True


def _taken(uid):
    for lookup in (pwd.getpwuid, grp.getgrgid):
        try:
            lookup(uid); return True
        except KeyError:
            pass
    return False


INSTRUCTIONS = """# Your workspace

You are Kenan, working for {name} as the Unix user `{person}` on kenan-server, a household machine that Alice administers.

Your home is `/home/{person}`. Create projects, install user-local tools and organise files there. {name}'s personal folder is `/home/{person}/{person}`; keep their notes, memory and personal context there. It starts empty: learn who {name} is from them, and record what they tell you about themselves and their preferences the moment you learn it.

{name} talks to you in the Kenan app at {url} (Kenan Stack, production channel). Their **Kenaznia** is the managing agent in their main conversation: it answers them, keeps their goals with the `goals` tool, starts a worker per goal with `workers spawn`, and gets each worker's single report. Use `wake` to resume at a time or on an email instead of waiting. Every model call goes through the household's Claude subscriptions via the shared broker; never use a pay-per-token API key for inference.

Your account retains its own write and remote-service identity. Shared system programs and Kenan Stack's installed code are available for use, not modification. For system packages, host services or additional access, ask Alice's Kenan through {name}: include the command, the error and what you need.

Keep project instructions with the project. Never put passwords or tokens into documentation or logs. Every shell command needs an explicit bounded timeout.
"""


def ensure_files(person, name, uid, template):
    created = []
    home = Path(f'/home/{person}')
    for path, mode in ((home / person, 0o700), (home / person / 'context', 0o700)):
        if not path.exists():
            path.mkdir(mode=mode); os.chown(path, uid, uid); created.append(str(path))
    instructions = ETC / 'users' / person / 'AGENTS.md'
    if not instructions.exists():
        instructions.parent.mkdir(parents=True, exist_ok=True)
        instructions.write_text(INSTRUCTIONS.format(name=name, person=person, url=PRODUCTION_URL))
        os.chmod(instructions, 0o644); created.append(str(instructions))
    link = home / 'AGENTS.md'
    if not link.is_symlink():
        link.symlink_to(instructions); created.append(str(link))
    state = STATE / person / 'home'
    for sub in ('', 'agent', 'browser', 'providers'):
        d = state / sub if sub else state
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
    for d in (STATE / person, state, state / 'agent', state / 'browser', state / 'providers'):
        os.chown(d, uid, uid); os.chmod(d, 0o700)
    auth = state / 'agent' / 'auth.json'
    if not auth.exists():
        auth.write_text('{}'); os.chown(auth, uid, uid); os.chmod(auth, 0o600)
    live = state / 'providers' / 'acme-live.key'
    if not live.exists():
        shutil.copyfile(STATE / template / 'home' / 'providers' / 'acme-live.key', live)
        os.chown(live, uid, uid); os.chmod(live, 0o600)
    domain = ETC / 'domains' / f'{person}.json'
    if not domain.exists():
        source = json.loads((ETC / 'domains' / f'{template}.json').read_text())
        data = substitute(source, [(f'/account-state/{template}/', f'/account-state/{person}/'), (f'{template}-kenan', f'{person}-kenan')])
        data['tools']['editor'] = None
        write_json(domain, data, 0o640); created.append(str(domain))
    return created


def ensure_login(person):
    key, verifier = PROVISION / f'{person}.login-key', ETC / 'verifiers' / f'{person}.json'
    if key.exists() and verifier.exists():
        return key, False
    secret = key.read_text().strip() if key.exists() else secrets.token_urlsafe(32)
    salt = secrets.token_hex(32)
    digest = hashlib.scrypt(secret.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()
    key.write_text(secret + '\n'); os.chmod(key, 0o600)
    write_json(verifier, {'version': 1, 'salt': salt, 'digest': digest}, 0o600)
    return key, True


def ensure_listener(person, template):
    config = json.loads(BROKER.read_text())
    existing = next((l for l in config['listeners'] if l['principal'] == person), None)
    if existing:
        return existing['port'], False
    model = next(l for l in config['listeners'] if l['principal'] == template)
    used = {l['port'] for l in config['listeners']}
    port = next(p for p in range(2461, 2600) if p not in used and _free(p))
    config['listeners'].append({**copy.deepcopy(model), 'principal': person, 'port': port})
    write_json(BROKER, config, 0o644)
    return port, True


def _free(port):
    with socket.socket() as s:
        try:
            s.bind(('127.0.0.1', port)); return True
        except OSError:
            return False


def ensure_people(person, name, uid, port, pronouns, template):
    changed = []
    for channel, path in CHANNELS.items():
        config = json.loads(path.read_text())
        if any(p['id'] == person for p in config['people']):
            continue
        model = next(p for p in config['people'] if p['id'] == template)
        pairs = [(f'/home/{template}/', f'/home/{person}/'), (f'/etc/kenan/domains/{template}.json', f'/etc/kenan/domains/{person}.json'), (f"{model['name']}'s", f"{name}'s"), (f"for {model['name']}", f"for {name}"), (f"answers {model['name']}", f"answers {name}")]
        entry = substitute(copy.deepcopy(model), pairs)
        entry.update(id=person, name=name, unixUser=person, uid=uid, gid=uid, home=f'/home/{person}', brokerPort=port,
                     heartbeatFile=f'/home/{person}/{person}/HEARTBEAT.md', extensionConfigPath=f'/etc/kenan/domains/{person}.json',
                     alertDir=None, signalStore=None, pronouns=pronouns, peers=[])
        if channel == 'beta':
            entry['manager'] = {'elsewhere': PRODUCTION_URL}
        elif not (isinstance(entry['manager'], dict) and 'provider' in entry['manager']):
            raise Failure(f'template {template} has no Kenaznia hosted on production')
        config['people'].append(entry)
        write_json(path, config, 0o660)
        changed.append(channel)
    return changed


def ensure_mesh(person, name, mesh_key):
    users = {u['name']: u for u in json.loads(run('headscale', 'users', 'list', '-o', 'json') or '[]')}
    created = person not in users
    if created:
        run('headscale', 'users', 'create', person, '--display-name', name)
        users = {u['name']: u for u in json.loads(run('headscale', 'users', 'list', '-o', 'json'))}
    if not mesh_key:
        return created, None
    key = json.loads(run('headscale', 'preauthkeys', 'create', '--user', str(users[person]['id']), '--expiration', '168h', '-o', 'json'))['key']
    path = PROVISION / f'{person}.mesh-key'
    path.write_text(key + '\n'); os.chmod(path, 0o600)
    return created, str(path)


def verify_login(person, key):
    body = json.dumps({'accountId': person, 'secret': key.read_text().strip()}).encode()
    request = (b'POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nx-kenan-client: native\r\n'
               b'Connection: close\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
    deadline, last = time.monotonic() + 90, 'not started'
    while time.monotonic() < deadline:
        try:
            with socket.socket(socket.AF_UNIX) as s:
                s.settimeout(10); s.connect('/run/kenan/production.sock'); s.sendall(request)
                response = b''
                while chunk := s.recv(65536):
                    response += chunk
            head, _, payload = response.partition(b'\r\n\r\n')
            if head.startswith(b'HTTP/1.1 200') and b'"ok":true' in payload.replace(b' ', b''):
                return True
            last = head.split(b'\r\n', 1)[0].decode()
        except OSError as error:
            last = str(error)
        time.sleep(2)
    raise Failure(f'production login for {person} did not succeed: {last}')


def main():
    parser = argparse.ArgumentParser(prog='kenan-add-person', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('id'); parser.add_argument('name')
    parser.add_argument('--pronouns', required=True, help='e.g. he/him, she/her, they/them, or none')
    parser.add_argument('--like', required=True, help='existing production person to copy tool and agent profiles from')
    parser.add_argument('--mesh-key', action='store_true', help='also mint a single-use 7-day Headscale pre-auth key for the first device')
    args = parser.parse_args()
    if os.geteuid() != 0:
        os.execv('/usr/bin/sudo', ['sudo', '-n', os.path.realpath(sys.argv[0]), *sys.argv[1:]])
    if not ID.fullmatch(args.id):
        raise Failure('ID must be a lowercase Unix name')
    pronouns = None if args.pronouns == 'none' else args.pronouns
    Path('/run/kenan').mkdir(exist_ok=True)
    with open('/run/kenan/add-person.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not any(p['id'] == args.like for p in json.loads(CHANNELS['production'].read_text())['people']):
            raise Failure(f'unknown template person {args.like}')
        uid, new_account = ensure_account(args.id)
        files = ensure_files(args.id, args.name, uid, args.like)
        key, new_login = ensure_login(args.id)
        port, new_listener = ensure_listener(args.id, args.like)
        channels = ensure_people(args.id, args.name, uid, port, pronouns, args.like)
        # kenan-user-grants derives the same deny from production.json on every reconcile; its full reload takes about a minute.
        run('setfacl', '-m', f'u:{args.id}:---', '/home/kenan/alice')
        run('systemctl', 'reload', 'kenan-port-access')
        if new_listener:
            # The old broker drains its in-flight streams first; agents retry transient model errors meanwhile.
            run('systemctl', 'restart', '--no-block', 'kenan-model-broker')
        mesh_created, mesh_key = ensure_mesh(args.id, args.name, args.mesh_key)
        if channels or new_login:
            run('systemctl', 'restart', 'kenan@production')
        verify_login(args.id, key)
    print(json.dumps({'id': args.id, 'uid': uid, 'accountCreated': new_account, 'filesCreated': files, 'brokerPort': port,
                      'listenerCreated': new_listener, 'channelsAdded': channels, 'loginKeyPath': str(key), 'loginVerified': True,
                      'meshUserCreated': mesh_created, 'meshKeyPath': mesh_key,
                      'pending': ['beta loads the new person at its next restart or deploy'] if 'beta' in channels else []}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Failure as error:
        print(f'kenan-add-person: {error}', file=sys.stderr)
        sys.exit(1)
