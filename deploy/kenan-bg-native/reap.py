#!/usr/bin/python3
"""Stop background work whose native worker has been archived or stopped."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlparse, parse_qsl, unquote

ROOT = Path('/var/lib/kenan-bg/background-launch')
WORKER = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
CHANNEL = re.compile(r'[a-z][a-z0-9_-]*')


def run(argv, **kwargs):
    return subprocess.run(argv, capture_output=True, text=True, check=True, timeout=20, **kwargs)


def reap():
    if os.getuid() != 0:
        raise RuntimeError('background_root_required')
    units = json.loads(run(['/usr/bin/systemctl', '--system', 'list-units', '--all', '--type=service',
                            '--state=active,activating,reloading', '--output=json', 'kenan-bg-*']).stdout)
    jobs = []
    for unit in units:
        if not unit['description'].startswith('kenan-tool-call:'):
            continue
        owner = json.loads(unit['description'].removeprefix('kenan-tool-call:'))
        if not owner.get('background') or owner.get('keep') is True or not WORKER.fullmatch(owner.get('agentId', '')):
            continue
        if not CHANNEL.fullmatch(owner.get('channel', '')):
            continue
        # Use root-created native identity only; never infer an owner from a name or user environment.
        if not unit['unit'].startswith('kenan-bg-' + owner['agentId'] + '-'):
            continue
        jobs.append((unit['unit'], owner))
    if not jobs:
        return
    configs = {}
    for path in Path('/etc/kenan').glob('*.json'):
        config = json.loads(path.read_text())
        if isinstance(config, dict) and config.get('channel') == path.stem:
            configs[path.stem] = config
    ended = set()
    wakes = []
    query_failed = False
    for channel in configs:
        owners = {owner['agentId'] for _, owner in jobs if owner['channel'] == channel}
        if channel not in configs:
            print(f'kenan-bg reap: no local configuration for {channel}; jobs unchanged', flush=True)
            continue
        # Connection settings stay in the environment, not process arguments or diagnostics.
        owner_filter = 'id IN (' + ','.join("'" + owner + "'" for owner in owners) + ')' if owners else 'FALSE'
        query = "SELECT json_build_object('ended', (SELECT coalesce(json_agg(id),'[]'::json) FROM agent WHERE (archived OR state='stopped') AND " + owner_filter + "), 'wakes', (SELECT coalesce(json_agg(json_build_object('agent',agent_id,'heldFor',held_for,'event',event)),'[]'::json) FROM wake WHERE status='pending'));"
        url = urlparse(configs[channel]['databaseUrl'])
        if url.scheme not in ('postgres', 'postgresql'):
            raise RuntimeError('background_database_url_invalid')
        params = dict(parse_qsl(url.query))
        env = {**os.environ, 'PGDATABASE': unquote(url.path.lstrip('/')),
               'PGCONNECT_TIMEOUT': '3', 'PGOPTIONS': '-c statement_timeout=4000'}
        for name, value in [('host', url.hostname), ('port', url.port), ('user', url.username), ('password', url.password)]:
            if value is not None:
                env['PG' + name.upper()] = unquote(str(value))
        # These are libpq's environment names; connection values never enter argv.
        names = {'dbname': 'PGDATABASE', 'user': 'PGUSER', 'password': 'PGPASSWORD',
                 'host': 'PGHOST', 'hostaddr': 'PGHOSTADDR', 'port': 'PGPORT',
                 'sslmode': 'PGSSLMODE', 'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY',
                 'sslrootcert': 'PGSSLROOTCERT', 'service': 'PGSERVICE', 'options': 'PGOPTIONS',
                 'connect_timeout': 'PGCONNECT_TIMEOUT', 'application_name': 'PGAPPNAME'}
        for name, value in params.items():
            if name not in names:
                raise RuntimeError('background_database_parameter_unsupported')
            env[names[name]] = value
        try:
            rows = json.loads(run(['/usr/bin/psql', '-XqAt', '--no-password', '--set=ON_ERROR_STOP=1'],
                                  input=query, env=env).stdout)
            ended.update((channel, owner) for owner in rows['ended'])
            wakes.extend(rows['wakes'])
        except (subprocess.SubprocessError, ValueError):
            print(f'kenan-bg reap: owner/wake query failed for {channel}; jobs unchanged', flush=True)
            query_failed = True
    if query_failed:
        raise RuntimeError('background_owner_wake_query_failed')
    def watched(unit, owner):
        name = unit.removeprefix('kenan-bg-' + owner['agentId'] + '-').removesuffix('.service')
        topic = 'job:' + owner['agentId'] + ':' + name
        for wake in wakes:
            event = wake.get('event') or {}
            if event.get('source') == 'event':
                wanted = event.get('topic', '')
                if topic.startswith(wanted) if event.get('prefix') else topic == wanted:
                    return True
            if event.get('source') == 'any' and owner['agentId'] in (wake['agent'], wake['heldFor']):
                return True
        return False
    def stop(job):
        unit, owner = job
        if (owner['channel'], owner['agentId']) not in ended or watched(unit, owner):
            return
        try:
            saved = json.loads((ROOT / (unit + '.json')).read_text())
            if saved['channel'] != owner['channel'] or saved['uid'] != owner['uid'] or saved.get('keep') is True:
                raise RuntimeError('background_owner_mismatch')
            log = saved['log']
            try:
                fd = os.open(log, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
                with os.fdopen(fd, 'w') as stream:
                    stream.write('\n[kenan-bg] stopping: owner worker is archived or stopped and no pending wake watches this job\n')
            except OSError:
                print(f'kenan-bg reap: cannot append reason to log for {unit}', flush=True)
            script = "import {stopBackground,jobMarker} from './background-launch.mjs'; import fs from 'node:fs'; const {unit,log}=JSON.parse(fs.readFileSync(0,'utf8')); const result=stopBackground(unit,{marker:jobMarker(unit,log)}); console.log(JSON.stringify(result)); if(result.state==='stopping')process.exitCode=1;"
            result = run(['/usr/local/bin/node', '--input-type=module', '-e', script],
                         cwd=Path(__file__).resolve().parent, input=json.dumps({'unit': unit, 'log': log}))
            print('kenan-bg reap: ' + result.stdout.strip(), flush=True)
        except Exception as error:
            # No exception text: database URLs and subprocess environments may contain credentials.
            print(f'kenan-bg reap: stop failed for {unit} ({type(error).__name__}); retry next minute', flush=True)
            raise
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(stop, jobs))


if __name__ == '__main__':
    reap()
