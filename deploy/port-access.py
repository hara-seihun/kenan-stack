#!/usr/bin/python3 -I
"""Reserve loopback listeners: each model broker port for root, kenan and that listener's person;
each port in /etc/kenan/owner-ports.json (code-server, adb) for root and kenan only."""
import json
import pwd
import subprocess

listeners = json.load(open('/etc/kenan/model-broker.json'))['listeners']
owner_ports = json.load(open('/etc/kenan/owner-ports.json'))['ports']
owner = pwd.getpwnam('kenan').pw_uid


def person(principal):
    try:
        return [pwd.getpwnam(principal).pw_uid]
    except KeyError:
        return []


allowed = {listener['port']: {0, owner, *person(listener['principal'])} for listener in listeners}
allowed.update({port: {0, owner} for port in owner_ports})
rules = ['destroy table inet kenan_port_access', 'table inet kenan_port_access {', ' chain output {',
         '  type filter hook output priority -20; policy accept;']
for port, uids in sorted(allowed.items()):
    rules.append(f'  fib daddr type local tcp dport {port} meta skuid != {{ {", ".join(map(str, sorted(uids)))} }} reject with tcp reset')
rules += [' }', ' chain input {', '  type filter hook input priority -20; policy accept;',
          f'  iifname != "lo" tcp dport {{ {", ".join(map(str, sorted(allowed)))} }} reject with tcp reset', ' }', '}']
subprocess.run(['/usr/sbin/nft', '-f', '-'], input='\n'.join(rules) + '\n', text=True, check=True)
