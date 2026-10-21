import{it,expect}from'vitest';import{mkdtemp,writeFile,rm,mkdir}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID,createHash}from'node:crypto';import{reconcileRead,receiptPath,type ReadState}from'./meeting-receipt.js';
const now=Date.parse('2026-10-18T12:00:00Z');
async function fixture(run:(s:ReadState)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'read-receipt-')),id=randomUUID(),snapshot=join(dir,'latest.json');await mkdir(join(dir,'observer-receipts'));const state:ReadState={lastAttemptAt:new Date(now).toISOString(),lastSuccessAt:new Date(now-1000).toISOString(),consecutiveFailures:0,lastError:'unsettled',nextPeriodicAttemptAt:new Date(now).toISOString(),retryBlocked:true,pendingRead:{operationId:id,receiptPath:receiptPath(snapshot,id),snapshotPath:snapshot,admittedAt:now,repairOwner:'manager-original',reconcileAt:now+95000}};try{await run(state);}finally{await rm(dir,{recursive:true,force:true});}}
it('crash before receipt retains original identity owner and future durable wake without reads',async()=>fixture(async s=>{const result=await reconcileRead(JSON.parse(JSON.stringify(s)),now+96000);expect(result.settled).toBe(false);expect(result.state.retryBlocked).toBe(true);expect(result.state.pendingRead?.reconcileAt).toBe(now+126000);expect(result.state.pendingRead?.operationId).toBe(s.pendingRead?.operationId);expect(result.state.pendingRead?.repairOwner).toBe('manager-original');}));
it('receipt before PGcommit restores120s minimum across restart, not30stick; consumes only once',async()=>fixture(async s=>{const p=s.pendingRead!;await writeFile(p.receiptPath,JSON.stringify({version:1,operationId:p.operationId,terminal:'failure',kind:'meeting-detection-error',code:'calendar-http-429',retryNotBefore:now+120000,private:'SECRET'}));const result=await reconcileRead(JSON.parse(JSON.stringify(s)),now+96000);expect(result.settled).toBe(true);expect(result.state.retryNotBefore).toBe(now+120000);expect(result.state.lastSuccessAt).toBe(s.lastSuccessAt);expect(JSON.stringify(result.state)).not.toContain('SECRET');expect(result.state.pendingRead).toBeUndefined();expect((await reconcileRead(JSON.parse(JSON.stringify(result.state)),now+96001)).settled).toBe(false);}));
it('old receipt cannot settle new operation and malformed receipt remains protectedunknown',async()=>fixture(async s=>{for(const data of [{version:1,operationId:randomUUID(),terminal:'success'}, {version:1,operationId:s.pendingRead!.operationId,terminal:'success',observedAt:'broken',snapshotSha256:'x'}]){await writeFile(s.pendingRead!.receiptPath,JSON.stringify(data));const result=await reconcileRead(s,now+96000);expect(result.settled).toBe(false);expect(result.state.retryBlocked).toBe(true);expect(result.state.pendingRead?.operationId).toBe(s.pendingRead!.operationId);}}));
it('matching terminal success restores only actualfreshproof; stale receipt does not forge lastgood',async()=>fixture(async s=>{const p=s.pendingRead!,bytes=JSON.stringify({at:new Date(now).toISOString(),coverage:{kind:'complete',unknownCalendars:[]},snapshot:{meetings:[],withdrawnEventKeys:[]}});await writeFile(p.snapshotPath,bytes);await writeFile(p.receiptPath,JSON.stringify({version:1,operationId:p.operationId,terminal:'success',observedAt:new Date(now).toISOString(),snapshotSha256:createHash('sha256').update(bytes).digest('hex')}));const fresh=await reconcileRead(s,now+30000);expect(fresh.settled).toBe(true);expect(fresh.state.lastSuccessAt).toBe(s.lastSuccessAt);expect(fresh.state.lastError).toContain('stale');expect(fresh.state.retryBlocked).toBe(false);const stale=await reconcileRead(s,now+96000);expect(stale.settled).toBe(true);expect(stale.state.lastSuccessAt).toBe(s.lastSuccessAt);expect(stale.state.lastError).toContain('stale');expect(stale.state.pendingRead).toBeUndefined();}));

it('symlink or foreign receipt cannot settle protected original operation',async()=>fixture(async s=>{const fs=await import('node:fs/promises'),p=s.pendingRead!;const target=join(tmpdir(),'foreign-'+p.operationId+'.json');await writeFile(target,JSON.stringify({version:1,operationId:p.operationId,terminal:'failure',kind:'meeting-detection-error',code:'calendar-http-503'}));try{await fs.symlink(target,p.receiptPath);expect((await reconcileRead(s,now)).settled).toBe(false);}finally{await fs.unlink(target);}}));

it('process readback distinguishes exact current process, reused pid and missing process without launching',async()=>fixture(async s=>{
 const {readFile}=await import('node:fs/promises');const {originalProcess}=await import('./meeting-receipt.js');
 const p=s.pendingRead!,stat=await readFile(`/proc/${process.pid}/stat`,'utf8');
 const record={operationId:p.operationId,pid:process.pid,bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),startTicks:stat.split(') ')[1]!.split(' ')[19]};
 await writeFile(p.receiptPath+'.process.json',JSON.stringify(record));expect(await originalProcess(p)).toBe('running');
 await writeFile(p.receiptPath+'.process.json',JSON.stringify({...record,startTicks:'not-original'}));expect(await originalProcess(p)).toBe('ended');
 await writeFile(p.receiptPath+'.process.json',JSON.stringify({...record,operationId:randomUUID()}));expect(await originalProcess(p)).toBe('unknown');
 await writeFile(p.receiptPath+'.process.json',JSON.stringify({...record,bootId:'other-boot'}));expect(await originalProcess(p)).toBe('ended');
}));
it('missing detector process receipt uses prelaunch custody only after launcher death, never elapsed time',async()=>fixture(async s=>{
 const {launchCessation}=await import('./meeting-receipt.js'),{readFile}=await import('node:fs/promises');const p=s.pendingRead!;
 p.launchUnit=`agent-tool-beta-meeting-${p.operationId}.scope`;
 p.launcher={pid:process.pid,bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),startTicks:(await readFile(`/proc/${process.pid}/stat`,'utf8')).split(') ')[1]!.split(' ')[19]!};
 expect(await launchCessation(p)).toBe('unknown');expect((await reconcileRead(s,now+86400000)).state.pendingRead?.operationId).toBe(p.operationId);
 s.interruptedRead={...p,operationId:'prior-interrupted',reason:'process-ended-without-terminal-receipt'};
 p.launcher.bootId='prior-boot';expect(await launchCessation(p)).toBe('ended');const result=await reconcileRead(s,now+86400001);expect(result.state.interruptedRead?.operationId).toBe(p.operationId);expect(result.state.pendingRead).toBeUndefined();expect(result.state.lastSuccessAt).toBe(s.lastSuccessAt);expect(result.state.priorInterruptedReads).toEqual([s.interruptedRead]);
}));
it('ENOSPC zero temporary terminal and dead exact process become interruption, never a fabricated server result; a new read is eligible only after cessation',async()=>fixture(async s=>{
 const {readFile}=await import('node:fs/promises');const p=s.pendingRead!;
 await writeFile(p.receiptPath+'.tmp','');
 await writeFile(p.receiptPath+'.process.json',JSON.stringify({operationId:p.operationId,pid:process.pid,bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),startTicks:'reused-pid'}));
 const result=await reconcileRead(s,now+96000);
 expect(result.settled).toBe(false);expect(result.process).toBe('ended');expect(result.state.pendingRead).toBeUndefined();
 expect(result.state.interruptedRead?.operationId).toBe(p.operationId);expect(result.state.retryBlocked).toBe(false);
 expect(result.state.lastSuccessAt).toBe(s.lastSuccessAt);expect(result.state.lastError).toContain('retry hint unknown');
 const restart=await reconcileRead(JSON.parse(JSON.stringify(result.state)),now+86400000);expect(restart.state).toEqual(result.state);expect(restart.settled).toBe(false);
}));

it('successful health reset preserves every original interrupted operation without claiming its result',async()=>fixture(async s=>{
 const {preserveReadLineage}=await import('./meeting-receipt.js');const pending={...s,interruptedRead:{...s.pendingRead!,reason:'process-ended-without-terminal-receipt' as const},priorInterruptedReads:[{operationId:'original-earlier',result:'UNKNOWN'}]};const health={lastAttemptAt:'new',lastSuccessAt:'new',lastError:null,consecutiveFailures:0,nextPeriodicAttemptAt:'next'};
 const actual=preserveReadLineage(health,pending);expect(actual.lastSuccessAt).toBe('new');expect(actual.interruptedRead?.operationId).toBe(s.pendingRead!.operationId);expect(actual.priorInterruptedReads).toEqual(pending.priorInterruptedReads);expect(actual.pendingRead).toBeUndefined();
}));
it('terminal rate-limit failure preserves all earlier UNKNOWN lineage and exact server retry deadline',async()=>fixture(async s=>{
 s.interruptedRead={...s.pendingRead!,operationId:'prior-unknown',reason:'process-ended-without-terminal-receipt'};s.priorInterruptedReads=[{operationId:'earlier-unknown'}];
 await writeFile(s.pendingRead!.receiptPath,JSON.stringify({version:1,operationId:s.pendingRead!.operationId,terminal:'failure',kind:'meeting-detection-error',code:'calendar-http-429',retryNotBefore:now+120000,retryBlocked:false}),{mode:0o600});
 const result=await reconcileRead(s,now);expect(result.settled).toBe(true);expect(result.state.interruptedRead).toEqual(s.interruptedRead);expect(result.state.priorInterruptedReads).toEqual(s.priorInterruptedReads);expect(result.state.retryNotBefore).toBe(now+120000);expect(result.state.pendingRead).toBeUndefined();
}));
