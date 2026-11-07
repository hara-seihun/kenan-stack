#!/usr/bin/env python3
"""kenan-reset-login ID: give a person a fresh Kenan login password (they forgot it).

Writes a new random secret to /etc/kenan/provision/ID.login-key and its scrypt verifier to
/etc/kenan/verifiers/ID.json (the server reads the verifier on every login, so no restart), then
prints the secret on stdout and nothing else. Hand it to the person yourself (Signal or their
own mailbox), never log it. Existing sessions stay signed in. Run as kenan; re-runs itself under sudo."""
import hashlib, http.client, json, os, re, secrets, socket, sys
from pathlib import Path

ETC = Path('/etc/kenan')


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[a-z][a-z0-9_-]*', sys.argv[1]):
        sys.exit('usage: kenan-reset-login ID')
    if os.geteuid() != 0:
        os.execv('/usr/bin/sudo', ['sudo', '-n', os.path.realpath(sys.argv[0]), *sys.argv[1:]])
    person = sys.argv[1]
    verifier = ETC / 'verifiers' / f'{person}.json'
    if not verifier.exists():
        sys.exit(f'kenan-reset-login: {person} has no login verifier')
    secret = secrets.token_urlsafe(32)
    salt = secrets.token_hex(32)
    digest = hashlib.scrypt(secret.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()
    # Rewrite in place so each file keeps its ACLs.
    for path, text in ((ETC / 'provision' / f'{person}.login-key', secret + '\n'),
                       (verifier, json.dumps({'version': 1, 'salt': salt, 'digest': digest}, indent=2) + '\n')):
        with open(path, 'r+' if path.exists() else 'w') as f:
            f.seek(0); f.write(text); f.truncate()
        os.chmod(path, 0o600)
    # Prove it: log in over every running channel's socket, the way the browser does.
    for sock in sorted(Path('/run/kenan').glob('*.sock')):
        if sock.name.endswith('-link.sock'):
            continue
        conn = http.client.HTTPConnection('localhost')
        conn.sock = socket.socket(socket.AF_UNIX); conn.sock.settimeout(20); conn.sock.connect(str(sock))
        conn.request('POST', '/api/login', json.dumps({'accountId': person, 'secret': secret}),
                     {'content-type': 'application/json', 'x-kenan-client': 'native'})
        r = conn.getresponse()
        if r.status != 200:
            sys.exit(f'kenan-reset-login: the new password was written but {sock.name} rejected it (HTTP {r.status})')
    print(secret)


if __name__ == '__main__':
    main()
