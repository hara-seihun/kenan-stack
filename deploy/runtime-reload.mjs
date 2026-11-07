#!/usr/bin/env node
// The control socket is root-only. A reload response is sent after the new HTTP/runtime code is installed.
import { createConnection } from 'node:net';
const channel = process.argv[2];
if (!['beta', 'production'].includes(channel)) throw new Error('usage: runtime-reload.mjs beta|production');
const socket = createConnection(`/run/kenan/${channel}-owner-control.sock`);
let output = '';
socket.setTimeout(120_000, () => socket.destroy(new Error('live_reload_timeout')));
socket.on('connect', () => socket.write('{"reload":true}\n'));
socket.on('data', chunk => { output += chunk; if (output.length > 64 * 1024) socket.destroy(new Error('live_reload_response_too_large')); });
socket.on('end', () => {
  let result;
  try { result = JSON.parse(output.trim()); } catch { console.error('live_reload_invalid_response'); process.exitCode = 1; return; }
  if (result.ok === true && result.liveReload === true) return;
  // Only the pre-live-upgrade implementation returns this exact response to the new command.
  if (result.error === 'Error: invalid_person_or_url') { console.error('live_reload_unsupported'); process.exitCode = 75; return; }
  console.error(result.error ?? 'live_reload_failed'); process.exitCode = 1;
});
socket.on('error', error => { console.error(error.code ?? error.message); process.exitCode = error.code === 'ENOENT' ? 75 : 1; });
