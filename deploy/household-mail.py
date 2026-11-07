#!/usr/bin/python3 -I
"""A person's mailbox in the household Purelymail account (one US$10/year account for everyone).

household-mail UNIXUSER LOCALPART SUBDOMAIN FROMNAME "DNS comment"
    creates person6@example.com: the Cloudflare records in zone kenan.example.com (MX, SPF, ownership TXT,
    three DKIM CNAMEs, DMARC CNAME), the Purelymail domain and user, the credential file
    /var/lib/kenan/account-state/UNIXUSER/home/mail/ADDRESS.json (UNIXUSER, 0600) and the entry
    tools.mail.mailboxes[ADDRESS] in /etc/kenan/domains/UNIXUSER.json. Idempotent; a fresh subdomain's ownership
    check fails for about a minute after its records appear, so it retries for up to three minutes.
household-mail --undo UNIXUSER ADDRESS
    deletes that mailbox: the Purelymail user, its domain when no other user is on it, the domain's DNS records,
    the credential file and the tools.mail entry.

Runs as kenan (the Purelymail token is /home/kenan/.config/purelymail/household.json, the Cloudflare token is
vault item Agent/kenan.example.com Cloudflare); file changes go through sudo.
"""
import json, os, secrets, subprocess, sys, time, urllib.error, urllib.request

PURELYMAIL = '/home/kenan/.config/purelymail/household.json'
ZONE = 'kenan.example.com'


class Failure(Exception):
    pass


def vault_field(title, name):
    out = subprocess.run(['timeout', '60', 'pass-cli', 'item', 'view', '--vault-name', 'Agent', '--item-title', title, '--output', 'json'],
                         capture_output=True, text=True)
    if out.returncode:
        raise Failure(f'pass-cli could not read Agent/{title}: {out.stderr.strip()[-300:]}')

    def find(o):
        if isinstance(o, dict):
            if o.get('name') == name:
                v = o.get('content') or o.get('value')
                while isinstance(v, dict):
                    v = v.get('value', next(iter(v.values())))
                return v
            return next((r for r in map(find, o.values()) if r), None)
        if isinstance(o, list):
            return next((r for r in map(find, o) if r), None)
        return None
    value = find(json.loads(out.stdout))
    if not value:
        raise Failure(f'vault field {title}/{name} missing')
    return value


class Apis:
    def __init__(self):
        self.pm_token = json.load(open(PURELYMAIL))['apiToken']
        self.cf_token = vault_field('kenan.example.com Cloudflare', 'cloudflare_token_account_admin')
        self.zone = self._cf_request('GET', f'https://api.cloudflare.com/client/v4/zones?name={ZONE}')['result'][0]['id']

    def pm(self, endpoint, body):
        request = urllib.request.Request('https://purelymail.com/api/v0/' + endpoint, data=json.dumps(body).encode(), method='POST',
                                         headers={'Purelymail-Api-Token': self.pm_token, 'Content-Type': 'application/json'})
        try:
            return json.load(urllib.request.urlopen(request, timeout=60))
        except urllib.error.HTTPError as e:
            return json.load(e)

    def _cf_request(self, method, url, body=None):
        request = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, method=method,
                                         headers={'Authorization': 'Bearer ' + self.cf_token, 'Content-Type': 'application/json'})
        try:
            return json.load(urllib.request.urlopen(request, timeout=60))
        except urllib.error.HTTPError as e:
            return json.load(e)

    def cf(self, method, path, body=None):
        return self._cf_request(method, f'https://api.cloudflare.com/client/v4/zones/{self.zone}{path}', body)


def records(domain, code):
    return [('MX', domain, 'mailserver.purelymail.com', 50), ('TXT', domain, 'v=spf1 include:_spf.purelymail.com ~all', None),
            ('TXT', domain, code, None)] + \
           [('CNAME', f'purelymail{i}._domainkey.{domain}', f'key{i}.dkimroot.purelymail.com', None) for i in (1, 2, 3)] + \
           [('CNAME', f'_dmarc.{domain}', 'dmarcroot.purelymail.com', None)]


def wire(config, address, path, name):
    """Edit the tool domain as root, in place so it keeps its ACLs. name None removes the entry."""
    script = r'''
import json,sys
cfg,addr,path,name=sys.argv[1:5]
d=json.load(open(cfg))
tools=d.setdefault("tools",{})
mail=tools.get("mail") or {"mailboxes":{}}
if "mailboxes" not in mail: sys.exit(f"{cfg} tools.mail is not a hosted mailboxes map")
if name=="-": mail["mailboxes"].pop(addr,None)
else: mail["mailboxes"][addr]={"account":path,"fromName":name}
tools["mail"]=mail
with open(cfg,"r+") as f: f.seek(0); f.write(json.dumps(d,indent=2,ensure_ascii=False)+"\n"); f.truncate()
'''
    subprocess.run(['sudo', '-n', 'python3', '-c', script, config, address, path, name or '-'], check=True, timeout=30)


def create(unix, local, sub, from_name, comment):
    apis = Apis()
    domain, address = f'{sub}.{ZONE}', f'{local}@{sub}.{ZONE}'
    code = apis.pm('getOwnershipCode', {})['result']['code']
    existing = apis.cf('GET', '/dns_records?per_page=500')['result']
    for kind, name, content, priority in records(domain, code):
        if any(r['type'] == kind and r['name'] == name and r['content'].strip('"') == content for r in existing):
            continue
        body = {'type': kind, 'name': name, 'content': content, 'ttl': 1, 'proxied': False, 'comment': comment}
        if priority is not None:
            body['priority'] = priority
        created = apis.cf('POST', '/dns_records', body)
        if not created['success']:
            raise Failure(f'DNS {kind} {name}: {created["errors"]}')
        print('dns created', kind, name)
    deadline = time.monotonic() + 180
    while domain not in [d['name'] for d in apis.pm('listDomains', {})['result']['domains']]:
        added = apis.pm('addDomain', {'domainName': domain})
        if added['type'] == 'success':
            print('domain added', domain)
            break
        if 'ownership' not in added.get('message', '') or time.monotonic() > deadline:
            raise Failure(f'addDomain {domain}: {added}')
        time.sleep(15)
    path = f'/var/lib/kenan/account-state/{unix}/home/mail/{address}.json'
    if address not in apis.pm('listUser', {})['result']['users']:
        if subprocess.run(['sudo', '-n', 'test', '-e', path]).returncode == 0:
            raise Failure(f'{path} exists but {address} is not a Purelymail user; refusing to overwrite it')
        password = secrets.token_urlsafe(24)
        made = apis.pm('createUser', {'userName': local, 'domainName': domain, 'password': password, 'enablePasswordReset': False,
                                      'enableSearchIndexing': True, 'sendWelcomeEmail': False})
        if made['type'] != 'success':
            raise Failure(f'createUser {address}: {made}')
        account = {'email': address, 'password': password, 'imap': {'host': 'imap.purelymail.com', 'port': 993, 'security': 'tls'},
                   'smtp': {'host': 'smtp.purelymail.com', 'port': 587, 'security': 'starttls'}, 'addresses': [address]}
        subprocess.run(['sudo', '-n', 'install', '-d', '-m', '700', '-o', unix, '-g', unix, os.path.dirname(path)], check=True, timeout=30)
        subprocess.run(['sudo', '-n', 'install', '-m', '600', '-o', unix, '-g', unix, '/dev/stdin', path],
                       input=json.dumps(account, indent=1).encode(), check=True, timeout=30)
        print('user created', address)
    wire(f'/etc/kenan/domains/{unix}.json', address, path, from_name)
    print('done', address, path)


def undo(unix, address):
    apis = Apis()
    local, _, domain = address.partition('@')
    if not local or not domain.endswith('.' + ZONE):
        raise Failure(f'{address} is not a household address')
    users = apis.pm('listUser', {})['result']['users']
    if address in users:
        deleted = apis.pm('deleteUser', {'userName': address})
        if deleted['type'] != 'success':
            raise Failure(f'deleteUser {address}: {deleted}')
        print('user deleted', address)
    others = [u for u in users if u != address and u.endswith('@' + domain)]
    if not others:
        if domain in [d['name'] for d in apis.pm('listDomains', {})['result']['domains']]:
            dropped = apis.pm('deleteDomain', {'name': domain})
            if dropped['type'] != 'success':
                raise Failure(f'deleteDomain {domain}: {dropped}')
            print('domain deleted', domain)
        mine = {(kind, name) for kind, name, _, _ in records(domain, '')}
        for r in apis.cf('GET', '/dns_records?per_page=500')['result']:
            if (r['type'], r['name']) in mine:
                gone = apis.cf('DELETE', f'/dns_records/{r["id"]}')
                if not gone['success']:
                    raise Failure(f'DNS delete {r["type"]} {r["name"]}: {gone["errors"]}')
                print('dns deleted', r['type'], r['name'])
    path = f'/var/lib/kenan/account-state/{unix}/home/mail/{address}.json'
    subprocess.run(['sudo', '-n', 'rm', '-f', path], check=True, timeout=30)
    config = f'/etc/kenan/domains/{unix}.json'
    if subprocess.run(['sudo', '-n', 'test', '-e', config]).returncode == 0:
        wire(config, address, path, None)
    print('undone', address)


def main(argv):
    if argv[:1] == ['--undo'] and len(argv) == 3:
        undo(*argv[1:])
    elif len(argv) == 5 and not argv[0].startswith('-'):
        create(*argv)
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Failure as error:
        print(f'household-mail: {error}', file=sys.stderr)
        sys.exit(1)
