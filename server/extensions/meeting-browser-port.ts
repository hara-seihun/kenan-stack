import { spawn } from 'node:child_process';
export interface BrowserAdapterConfig { executable: string; args: string[]; uid: number; gid: number; home: string; }
/** Only the configured WORK guarded adapter is invoked; no browser eval or cookie import. */
export function callMeetingBrowser(config: BrowserAdapterConfig, request: { action: 'prepare' | 'join' | 'inspect' | 'leave'; session: string; url?: string }): Promise<{ state: string; observation?: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, config.args, { uid: config.uid, gid: config.gid, cwd: config.home,
      env: { PATH: process.env.PATH, HOME: config.home, LANG: 'C.UTF-8', XDG_RUNTIME_DIR: `/run/user/${config.uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${config.uid}/bus` }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let output = '', size = 0;
    let failure: Error | undefined;
    const cancel = (message: string) => { failure = new Error(message); if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const timer = setTimeout(() => cancel('Browser adapter timeout; reconcile original session before another effect'), 120000);
    child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > 2 * 1024 * 1024) cancel('Browser adapter output exceeded limit'); else output += data.toString(); });
    // Do not expose raw stderr or browser internals in runtime logs.
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      try {
        const reply = JSON.parse(output) as { state: string; observation?: unknown };
        if (code !== 0 || !reply.state || reply.state === 'not-completed') throw new Error('Guarded browser refused; inspect current WORK session without replay');
        resolve(reply);
      } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
  });
}
