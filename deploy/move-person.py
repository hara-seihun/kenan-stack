#!/usr/bin/env python3
"""Move a person's Kenaznia, history and files from one channel to the other.

Usage (root): deploy/move-person.py PERSON FROM TO TARGET_URL [--check] [--notify-uid UID --notify-topic TOPIC]

--check copies the rows inside a transaction that is rolled back, with both channels running, and changes nothing.

FROM must host the person's manager; TO must name it elsewhere. Both channels stop (service and socket) while the
person's rows are copied from FROM's database into TO's (upserted by primary key; serial-keyed rows are replaced),
paths under /var/lib/kenan/FROM/ are rewritten to TO and their files copied. TO's config then gets FROM's whole person
entry, FROM's entry gets {"elsewhere": TARGET_URL}, and both channels start. FROM's database keeps its copy, so
restoring the two saved configs (written next to the copy files) rolls the move back.
"""
import json, os, shutil, subprocess, sys, tempfile, time

def die(code, text):
    print(f"{code}: {text}", file=sys.stderr)
    sys.exit(1)

args = sys.argv[1:]
check = '--check' in args
if check: args.remove('--check')
notify_uid = notify_topic = None
if '--notify-uid' in args:
    i = args.index('--notify-uid'); notify_uid = args[i + 1]; del args[i:i + 2]
if '--notify-topic' in args:
    i = args.index('--notify-topic'); notify_topic = args[i + 1]; del args[i:i + 2]
if len(args) != 4:
    die('move_usage', __doc__.strip().splitlines()[2])
person, src, dst, target_url = args
if {src, dst} != {'beta', 'production'}:
    die('move_usage', 'FROM and TO must be beta and production, one each')
if os.geteuid() != 0:
    die('move_not_root', 'run as root')

def load(channel):
    with open(f'/etc/kenan/{channel}.json') as f:
        return json.load(f)

def entry(config, channel):
    found = [p for p in config['people'] if p['id'] == person]
    if len(found) != 1:
        die('move_person_unknown', f'{person} is not in /etc/kenan/{channel}.json')
    return found[0]

src_cfg, dst_cfg = load(src), load(dst)
src_entry, dst_entry = entry(src_cfg, src), entry(dst_cfg, dst)
def hosts(e): return isinstance(e.get('manager'), dict) and 'elsewhere' not in e['manager']
# A move whose configs are already written (an interrupted run) copies the rows again and restarts both channels.
resync = src_entry.get('manager') == {'elsewhere': target_url} and hosts(dst_entry)
if not resync and not hosts(src_entry):
    die('move_source_not_hosting', f'{src} does not host {person}\'s manager')
if not resync and hosts(dst_entry):
    die('move_target_not_elsewhere', f'{dst} already hosts {person}\'s manager')

if resync:
    src_entry = entry(dst_cfg, dst)
new_dst = json.loads(json.dumps(dst_cfg))
new_dst['people'] = [json.loads(json.dumps(src_entry)) if p['id'] == person else p for p in dst_cfg['people']]
new_src = json.loads(json.dumps(src_cfg))
for p in new_src['people']:
    if p['id'] == person:
        p['manager'] = {'elsewhere': target_url}
        p['peers'] = []

work = tempfile.mkdtemp(prefix=f'move-{person}-{src}-{dst}-', dir='/var/tmp')
for name, cfg in [(f'{src}.json.before', src_cfg), (f'{dst}.json.before', dst_cfg), (f'{src}.json.after', new_src), (f'{dst}.json.after', new_dst)]:
    with open(os.path.join(work, name), 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False); f.write('\n')
for channel, name in [(src, f'{src}.json.after'), (dst, f'{dst}.json.after')]:
    subprocess.run(['node', '-e', 'import(process.argv[1]).then(m => m.loadConfig(process.argv[2]))',
                    f'/srv/kenan/{channel}/dist/server/config.js', os.path.join(work, name)], check=True)

def url(channel):
    return f'postgresql:///kenan_{channel}?host=/run/kenan/pg&user=root'

def psql(channel, sql, single=True):
    cmd = ['psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', url(channel)]
    if single: cmd.append('-1')
    r = subprocess.run(cmd, input=sql, text=True, capture_output=True)
    if r.returncode != 0:
        die('move_sql_failed', f'{channel}: {r.stderr.strip()}')
    return r.stdout

P = person.replace("'", "''")
AGENTS = f"(SELECT id FROM agent WHERE owner_id = '{P}')"
CONVS = f"(SELECT id FROM conversation WHERE owner_id = '{P}')"
FILES = f"(SELECT id FROM file WHERE owner_id = '{P}')"
OWNED = f"owner_id = '{P}'"
# table -> (rows of the person, serial id column replaced instead of upserted)
TABLES = [
    ('person', f"id = '{P}' OR id IN {AGENTS}", None),
    ('agent', OWNED, None),
    ('conversation', OWNED, None),
    ('chat_group', OWNED, None),
    ('member', f"conversation_id IN {CONVS} OR person_id = '{P}'", None),
    ('message', f"conversation_id IN {CONVS}", None),
    ('goal', OWNED, None),
    ('file', OWNED, None),
    ('conversation_file', f"conversation_id IN {CONVS} OR file_id IN {FILES}", None),
    ('latency', f"conversation_id IN {CONVS}", None),
    ('session', f"person_id = '{P}'", None),
    ('agent_heartbeat', f"agent_id IN {AGENTS}", None),
    ('push_subscription', f"person_id = '{P}'", None),
    ('wake', OWNED, None),
    ('host_event', OWNED, None),
    ('peer_message', OWNED, None),
    ('todo', OWNED, None),
    ('buy_section', OWNED, None),
    ('buy_item', OWNED, None),
    ('morning_check', OWNED, None),
    ('kenan_calendar', OWNED, None),
    ('kenan_phone_call', OWNED, None),
    ('agent_pending_input', f"agent_id IN {AGENTS}", 'id'),
    ('notification', f"person_id = '{P}'", 'id'),
    ('model_call', f"agent_id IN {AGENTS}", 'id'),
]
SRC_PREFIX, DST_PREFIX = f'/var/lib/kenan/{src}/', f'/var/lib/kenan/{dst}/'
REWRITE = {'agent': ['session_path'], 'file': ['path']}

def columns(channel, table):
    out = psql(channel, f"SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '{table}' ORDER BY ordinal_position")
    return out.split()

def pkey(channel, table):
    out = psql(channel, f"""SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'public.{table}'::regclass AND i.indisprimary""")
    return out.split()

def notify(result, detail):
    if notify_uid and notify_topic:
        subprocess.run(['/usr/local/bin/kenan-event', '--uid', notify_uid, notify_topic],
                       input=json.dumps({'result': result, 'detail': detail, 'work': work}), text=True)

# The recovery timer starts any stopped enabled channel within 30 s, so it is held for the whole copy.
units = ['kenan-runtime-recovery.timer'] + [f'kenan@{c}.{k}' for c in (src, dst) for k in ('socket', 'service')]
moved = {}
try:
    if not check: subprocess.run(['systemctl', 'stop', *units], check=True)
    if not check and any(subprocess.run(['systemctl', 'is-active', '--quiet', u]).returncode == 0 for u in units):
        die('move_channels_running', 'a channel is still running after stop')
    script = ["BEGIN;", "SET session_replication_role = replica;"]
    for table, where, serial in TABLES:
        src_cols, dst_cols = columns(src, table), columns(dst, table)
        if not src_cols:
            continue
        if set(src_cols) != set(dst_cols):
            die('move_schema_differs', f'{table} columns differ between {src} and {dst}')
        cols = [c for c in src_cols if c != serial]
        csv = os.path.join(work, f'{table}.csv')
        psql(src, f"\\copy (SELECT {', '.join(cols)} FROM {table} WHERE {where} ORDER BY 1) TO '{csv}' WITH (FORMAT csv)", single=False)
        moved[table] = int(psql(src, f"SELECT count(*) FROM {table} WHERE {where}", single=False))
        col_list = ', '.join(cols)
        script.append(f"CREATE TEMP TABLE in_{table} AS SELECT {col_list} FROM {table} WITH NO DATA;")
        script.append(f"\\copy in_{table} ({col_list}) FROM '{csv}' WITH (FORMAT csv)")
        for col in REWRITE.get(table, []):
            script.append(f"UPDATE in_{table} SET {col} = '{DST_PREFIX}' || substr({col}, {len(SRC_PREFIX) + 1}) WHERE starts_with({col}, '{SRC_PREFIX}');")
        if serial:
            script.append(f"DELETE FROM {table} WHERE {where};")
            script.append(f"INSERT INTO {table} ({col_list}) SELECT {col_list} FROM in_{table};")
        else:
            keys = pkey(dst, table)
            updates = ', '.join(f'{c} = EXCLUDED.{c}' for c in cols if c not in keys)
            action = f'DO UPDATE SET {updates}' if updates else 'DO NOTHING'
            script.append(f"INSERT INTO {table} ({col_list}) SELECT {col_list} FROM in_{table} ON CONFLICT ({', '.join(keys)}) {action};")
    # The heartbeat counts errors after error_id; ids from the other database mean nothing here.
    script.append(f"UPDATE agent_heartbeat SET error_id = (SELECT coalesce(max(id), 0) FROM error_log) WHERE agent_id IN {AGENTS};")
    script.append("ROLLBACK;" if check else "COMMIT;")
    psql(dst, '\n'.join(script) + '\n', single=False)
    if check:
        print(json.dumps({'check': 'ok', 'rows': moved, 'work': work})); sys.exit(0)

    paths = psql(src, f"SELECT session_path FROM agent WHERE {OWNED} UNION ALL SELECT path FROM file WHERE {OWNED}", single=False).split('\n')
    copied = 0
    for path in filter(None, paths):
        if path.startswith(SRC_PREFIX) and os.path.exists(path):
            target = DST_PREFIX + path[len(SRC_PREFIX):]
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(path, target); copied += 1
    config_root = f'{SRC_PREFIX}agent-config'
    for agent_id in psql(src, f"SELECT id FROM agent WHERE {OWNED}", single=False).split():
        name = agent_id.replace(':', '-')
        if os.path.isdir(os.path.join(config_root, name)):
            shutil.copytree(os.path.join(config_root, name), f'{DST_PREFIX}agent-config/{name}', dirs_exist_ok=True, symlinks=True)

    for channel, name in [(src, f'{src}.json.after'), (dst, f'{dst}.json.after')]:
        live = f'/etc/kenan/{channel}.json'
        st = os.stat(live)
        acl = subprocess.run(['getfacl', '-p', '--absolute-names', live], capture_output=True, text=True, check=True).stdout
        tmp = live + '.move'
        shutil.copyfile(os.path.join(work, name), tmp)
        os.chown(tmp, st.st_uid, st.st_gid); os.chmod(tmp, st.st_mode & 0o7777)
        subprocess.run(['setfacl', '--set-file=-', tmp], input='\n'.join(l for l in acl.splitlines() if not l.startswith('#')), text=True, check=True)
        os.replace(tmp, live)
    # Peer relays reach a person's Kenaznia through the socket of the channel hosting it.
    relays = []
    relay_dir = '/etc/kenan/peer-relay'
    for name in sorted(os.listdir(relay_dir)) if os.path.isdir(relay_dir) else []:
        path = os.path.join(relay_dir, name)
        text = open(path).read()
        old_sock, new_sock = f'/run/kenan/{src}-peer/{person}.sock', f'/run/kenan/{dst}-peer/{person}.sock'
        if old_sock in text:
            with open(path + '.move', 'w') as f: f.write(text.replace(old_sock, new_sock))
            shutil.copymode(path, path + '.move'); os.replace(path + '.move', path)
            relays.append(f'kenan-peer-relay-host@{name.removesuffix(".json")}.service')
except SystemExit as exit_:
    if check or exit_.code == 0: raise
    subprocess.run(['systemctl', 'start', *units])
    notify('failed', 'see the unit journal')
    raise
except Exception as error:
    subprocess.run(['systemctl', 'start', *units])
    notify('failed', repr(error))
    raise
subprocess.run(['systemctl', 'start', *units], check=True)
for channel in (src, dst):
    for _ in range(300):
        ok = subprocess.run(['curl', '--fail', '--silent', '--max-time', '5', '--unix-socket', f'/run/kenan/{channel}.sock',
                             'http://localhost/api/accounts'], capture_output=True).returncode == 0
        if ok: break
        time.sleep(1)
    else:
        notify('failed', f'{channel} did not answer after the move'); die('move_channel_unhealthy', channel)
if relays: subprocess.run(['systemctl', 'restart', *relays], check=True)
summary = {'rows': moved, 'filesCopied': copied, 'relaysRestarted': relays}
print(json.dumps(summary))
notify('done', summary)
