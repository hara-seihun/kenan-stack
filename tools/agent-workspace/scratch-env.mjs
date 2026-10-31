import './test-slot.mjs';
import {statfsSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';

const required=16*1024**3;
const free=dir=>{const s=statfsSync(dir);return s.bavail*s.bsize;};

// Test fixtures admit real capacity reservations with the 8 GiB operating floor in os.tmpdir(). A small
// tmpfs /tmp (12 GiB on kenan-server, shared with concurrent tests) refuses those admissions, which looks
// like a code failure. Importing this module points TMPDIR at a roomy disk-backed directory for this test
// process and the processes it spawns; a TMPDIR that already has room is kept.
const candidates=[tmpdir(),'/var/tmp'].filter(existsSync);
const roomy=candidates.find(dir=>free(dir)>=required);
if(roomy===undefined) throw Object.assign(new Error(`tests need ${required} free bytes of scratch; ${candidates.map(dir=>`${dir} has ${free(dir)}`).join(', ')}; set TMPDIR to a larger disk`),{code:'test-scratch-too-small'});
process.env.TMPDIR=roomy;

// Fixtures observe each create attempt's own receipt; a test that wants the waiting create sets this itself.
process.env.PI_WORKSPACE_CREATE_WAIT_SECONDS ??= '0';
// Fixture repositories are throwaway; the host's `core.fsync = committed` flushes every loose object and
// turned a 9,000-file fixture `git add` into 17-100 s on the busy RAID (2026-10-31).
if (process.env.GIT_CONFIG_COUNT === undefined) Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsync', GIT_CONFIG_VALUE_0: 'none' });
