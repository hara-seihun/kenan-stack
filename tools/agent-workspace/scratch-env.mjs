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
