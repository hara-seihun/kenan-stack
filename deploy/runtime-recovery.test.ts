import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
it('independent supervisor starts only enabled inactive channels, never disabled or stopping channels',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'runtime-recovery-'));try{
 await writeFile(join(dir,'systemctl'),'#!/bin/sh\ncase "$1" in\n is-enabled) [ "$3" = "kenan@beta.service" ];;\n show) echo "${STATE:-inactive}";;\n start) echo "$2" >> "$LOG";;\nesac\n',{mode:0o755});
 const env={...process.env,PATH:dir+':'+process.env.PATH,LOG:join(dir,'started')};
 execFileSync('/bin/bash',['deploy/kenan-runtime-recover'],{env});expect(await readFile(env.LOG,'utf8')).toBe('kenan@beta.service\n');
 for(const STATE of ['active','activating','deactivating'])execFileSync('/bin/bash',['deploy/kenan-runtime-recover'],{env:{...env,STATE}});
 expect(await readFile(env.LOG,'utf8')).toBe('kenan@beta.service\n');
 const restart=await readFile('deploy/kenan-runtime-restart','utf8');expect(restart).toContain('ExecStopPost=/usr/bin/systemctl start');expect(restart).toContain('/usr/bin/systemd-run');expect(restart).not.toContain('BindsTo=');
 }finally{await rm(dir,{recursive:true,force:true});}
});
