/** A bounded recovery command, never a general shell outside the job memory budget. */
export function recoveryArgs(command: string): string[] | null {
  if (!/^\s*kenan-recover(?:\s|$)/.test(command)) return null;
  const match = /^\s*kenan-recover(?:\s+(status)|\s+(kill)\s+([1-9]\d{0,9}))?\s*$/.exec(command);
  if (!match) throw new Error('recovery_invalid: use exactly kenan-recover [status|kill PID]; shell expressions are not accepted.');
  return match[2] ? ['kill', match[3]!] : ['status'];
}

/** Runs as the owner in a small, separate system scope; pidfds prevent killing a reused PID. */
export const RECOVERY_RUNNER = String.raw`
import os, sys, json, signal, select

def read(path):
    with open(path, errors='replace') as f: return f.read().strip()

def process(pid):
    root = '/proc/' + str(pid)
    status = read(root + '/status')
    values = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
    uid = int(values['Uid'].split()[0])
    cg = read(root + '/cgroup')
    return {'pid': int(pid), 'uid': uid, 'rssKiB': int(values.get('VmRSS', '0 kB').split()[0]),
            'command': read(root + '/comm'), 'cgroup': cg,
            'start': read(root + '/stat').rsplit(')', 1)[1].split()[19]}

try:
    action = sys.argv[1]
    if action == 'status':
        processes = []
        for pid in os.listdir('/proc'):
            if not pid.isdigit(): continue
            try:
                p = process(pid)
                if p['uid'] == os.getuid() and p['cgroup'].startswith('0::/user.slice/'):
                    p.pop('start'); processes.append(p)
            except (OSError, ValueError, KeyError): pass
        memory = {}
        for name in ['current', 'high', 'max', 'events']:
            try: memory[name] = read('/sys/fs/cgroup/user.slice/memory.' + name)
            except OSError as e: memory[name] = str(e)
        print(json.dumps({'ok': True, 'action': 'status', 'memory': memory,
                          'pressure': read('/proc/pressure/memory'), 'recoveryCgroup': read('/proc/self/cgroup'),
                          'processes': sorted(processes, key=lambda p: p['rssKiB'], reverse=True)[:20]}))
    elif action == 'kill':
        pid = int(sys.argv[2])
        before = process(pid)
        fd = os.pidfd_open(pid)
        try:
            now = process(pid)
            if now['start'] != before['start']:
                raise ValueError('recovery_pid_changed: process exited before it could be selected')
            if now['uid'] != os.getuid() or not now['cgroup'].startswith('0::/user.slice/'):
                raise ValueError('recovery_target_refused: only this owner\'s processes inside user.slice may be stopped')
            signal.pidfd_send_signal(fd, signal.SIGTERM)
            signals = ['SIGTERM']
            if not select.select([fd], [], [], 1)[0]:
                signal.pidfd_send_signal(fd, signal.SIGKILL); signals.append('SIGKILL')
            exited = bool(select.select([fd], [], [], 2)[0])
            print(json.dumps({'ok': exited, 'action': 'kill', 'pid': pid, 'command': now['command'],
                              'signals': signals, 'exited': exited,
                              **({} if exited else {'error': 'recovery_process_still_exiting'})}))
            if not exited: sys.exit(1)
        finally: os.close(fd)
    else: raise ValueError('recovery_invalid_action')
except (OSError, ValueError, KeyError) as e:
    code = ('recovery_not_running' if isinstance(e, ProcessLookupError) else
            'recovery_permission_denied' if isinstance(e, PermissionError) else
            str(e).split(':', 1)[0] if isinstance(e, ValueError) else 'recovery_failed')
    print(json.dumps({'ok': False, 'action': sys.argv[1], 'error': code, 'detail': str(e),
                      **({'pid': int(sys.argv[2])} if sys.argv[1] == 'kill' else {})})); sys.exit(1)
`;
