// Read-only adapter for the frozen Acme observer. Never sends starts or joins.
import {readFileSync,writeFileSync,renameSync,existsSync,appendFileSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export function removedSubject(status, body, directoryStatus) {
 return status===400 && body?.error==='invalid_grant' && /invalid email|invalid user|user.*(deleted|not found|does not exist)/i.test(body.error_description ?? '') && directoryStatus===404;
}
/** The Beta supervisor kills the detector at 90 s (SIGTERM, then SIGKILL 1 s later). The adapter ends
 * itself first, so every exit it can observe leaves a terminal failure receipt instead of an
 * "interrupted, result unknown" read (operations eaa8dddd and aa86828b, November 6, 2026). */
export const RUN_DEADLINE_MS = 75000;
const TRANSIENT_STATUS = new Set([429,500,502,503,504]);
/** Which finite detector stage a Google request belongs to (codes Beta's isDetectorCode accepts). */
export function stageOf(input) {
 let url; try { url = new URL(String(input instanceof Request ? input.url : input)); } catch { return null; }
 if (url.hostname === 'iamcredentials.googleapis.com') return 'iam';
 if (url.hostname === 'oauth2.googleapis.com') return 'token';
 if (url.hostname === 'admin.googleapis.com') return 'directory';
 if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/calendar/')) return 'calendar';
 if (url.hostname === 'storage.googleapis.com' || (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/storage/'))) return 'gcs';
 if (url.hostname === 'metadata.google.internal' || url.hostname === '169.254.169.254') return 'auth';
 return null;
}
/** Token minting is signing or exchanging a fixed assertion, so a fresh attempt has no side effect.
 * Calendar, Directory and Storage reads keep their own bounded retries. */
function retriesTransient(stage, init) {
 if (stage !== 'iam' && stage !== 'token' && stage !== 'auth') return false;
 const body = init?.body;
 return body === undefined || body === null || typeof body === 'string' || body instanceof URLSearchParams;
}
/** One Google request with a per-attempt bound, and for token stages up to `attempts` tries on
 * 429/5xx or a network failure, with backoff (Retry-After honoured up to 2 s). The caller's own
 * signal still bounds the whole call, and the final 5xx response is returned unchanged so the
 * detector classifies it exactly as before (for example iam-http-503). */
export async function boundedGoogleFetch(request, input, init, {attempts = 3, attemptTimeoutMs, sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random} = {}) {
 init ??= {};
 const stage = stageOf(input), retry = retriesTransient(stage, init), tries = retry ? attempts : 1;
 // Token calls are small; reads may stream a page, so they keep the longer bound their own code also sets.
 const bound = attemptTimeoutMs ?? (retry ? 10000 : 20000);
 for (let attempt = 1; ; attempt++) {
  const signals = [AbortSignal.timeout(bound)]; if (init.signal) signals.push(init.signal);
  let response;
  try { response = await request(input, {...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0]}); }
  catch (error) {
   if (attempt >= tries || init.signal?.aborted) throw error;
   await sleep(Math.round(250 * 3 ** (attempt - 1) + random() * 200));
   continue;
  }
  if (!TRANSIENT_STATUS.has(response.status) || attempt >= tries) return response;
  const hint = response.headers.get('retry-after');
  const requested = hint === null ? NaN : /^\d+$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint) - Date.now();
  if (Number.isFinite(requested) && requested > 2000) return response; // a long server delay is left to a later poll
  await response.body?.cancel().catch(() => {});
  await sleep(Number.isFinite(requested) ? Math.max(250, requested) : Math.round(250 * 3 ** (attempt - 1) + random() * 200));
 }
}
/** The stage to blame when the deadline passes: the request in flight in the current phase, else any
 * request in flight, else the phase itself. */
export function timeoutCode(phase, inflight) {
 if ((inflight[phase] ?? 0) > 0) return phase + '-timeout';
 for (const stage of ['iam','token','auth','directory','calendar','gcs']) if ((inflight[stage] ?? 0) > 0) return stage + '-timeout';
 return phase + '-timeout';
}
/** Frozen detector messages the frozen finiteDetectionCode leaves as the generic detector-unavailable, by stage.
 * 'Workspace DWD token exchange unavailable.' is two 4 s OAuth timeouts or network failures in a row: it caused the
 * 9-10 s detector-unavailable runs on November 2-6, 2026 (operations b0be51b5 and a35304bc among them). */
const KNOWN_MESSAGES = [
 [/^Workspace DWD token exchange unavailable\.?$/, 'token-unavailable'],
 [/^Workspace DWD token exchange did not contain access_token\.?$/, 'token-invalid-response'],
 [/^Workspace DWD signJwt response did not contain signedJwt\.?$/, 'iam-invalid-response'],
 [/^Could not mint an IAM Credentials access token/, 'auth-unavailable'],
 [/^Workspace directory returned no ACME users\.?$/, 'directory-invalid-response'],
 [/^Google Calendar meeting (lookup returned the wrong event|read returned a non-object response)/, 'calendar-invalid-response'],
 [/^Tracked meeting .* does not name its calendar and event\.?$/, 'calendar-invalid-response'],
];
/** A finite stage code for an error the frozen classifier calls detector-unavailable: a known frozen message, else
 * the failed Google request's stage and kind, else the phase in flight. Every result is one Beta's isDetectorCode
 * accepts, so a failure names where it happened instead of "detector-unavailable". */
export function stageFailureCode(error, phase, lastFetchFailure) {
 const message = error instanceof Error ? error.message : '';
 for (const [pattern, code] of KNOWN_MESSAGES) if (pattern.test(message)) return code;
 if (lastFetchFailure?.stage) return lastFetchFailure.stage + '-' + lastFetchFailure.kind;
 if (error instanceof SyntaxError) return phase + '-invalid-response';
 return phase + '-unavailable';
}
export function fetchFailureKind(error) {
 return error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network';
}
/** Private, bounded diagnostic text: never a bearer token, signed assertion or access token. */
export function redact(text) {
 return String(text ?? '').replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [redacted]').replace(/ya29\.[\w.\-~+/]+=*/g, '[token]')
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[jwt]').replace(/(assertion|access_token|refresh_token|signedJwt)(["'=:\s]+)[^\s"'&,]+/gi, '$1$2[redacted]').slice(0, 300);
}
const DIAGNOSTIC_LIMIT = 262144;
/** Appends one line to the private observer-diagnostics.jsonl (mode 0600, rotated at 256 KiB). Beta discards the
 * detector's stderr, so without this an unclassified failure leaves no trace of its cause. Never throws. */
export function recordDiagnostic(stateDirectory, entry) {
 try {
  const path = join(stateDirectory, 'observer-diagnostics.jsonl');
  try { if (statSync(path).size > DIAGNOSTIC_LIMIT) renameSync(path, path + '.1'); } catch { /* absent */ }
  appendFileSync(path, JSON.stringify(entry) + '\n', {mode: 0o600});
 } catch { /* Diagnostics never change the read's outcome. */ }
}
/** One in-process retry of a whole read-only pass when the first failed with an unclassified transient and enough of
 * the deadline remains. Every frozen read is a dry-run read, so a second pass has no side effect. */
export const RETRY_BUDGET_MS = 35000;
/** The receipt the frozen runObserverReceipt admitted for this run, once its process record exists. */
export function admittedReceipt(args) {
 if (args.length !== 6 || args[1] !== '--dry-run' || args[2] !== '--observer-op' || args[4] !== '--observer-receipt' || !/^[a-f0-9-]{36}$/.test(args[3] ?? '')) return null;
 return {operationId: args[3], path: args[5]};
}
export async function main(detector,args,options={}) {
 const root=resolve(dirname(detector),'../../../..');
 const load=p=>import(pathToFileURL(join(root,p)).href);
 const calendar=await load('products/kenan/src/meeting-agent/calendar.ts');
 const {configFrom,Ledger,coverageSnapshot}=await load('infrastructure/architecture/tools/meeting-discovery/handoff.ts');
 const {parseMeetingAttendancePolicy}=await load('products/kenan/src/meeting-agent/attendance-policy.ts');
 const {createMeetingStorage}=await load('products/kenan/src/meeting-agent/gcs.ts');
 const {runObserverReceipt,atomicReceipt}=await load('infrastructure/architecture/tools/meeting-discovery/observer-receipt.ts');
 const {finiteDetectionFailure}=await load('products/kenan/src/meeting-agent/read-request.ts');
 const config=configFrom(JSON.parse(readFileSync(args[0],'utf8')));
 process.env.WORKSPACE_DWD_SERVICE_ACCOUNT_EMAIL=config.dwdServiceAccount;
 for(const key of ['GOOGLE_IMPERSONATE_SERVICE_ACCOUNT','CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT','GOOGLE_APPLICATION_CREDENTIALS']) delete process.env[key];
 const request=globalThis.fetch, failures=new Map(), tokenErrors=new Map(), inflight={};
 let phase='directory', settled=false, lastFetchFailure=null, decided=null;
 // Every exit path the adapter can observe leaves a terminal receipt: its own deadline, a SIGTERM or
 // SIGINT from the supervisor, and (through runObserverReceipt) every thrown error.
 const receipt=admittedReceipt(args);
 const terminate=code=>{
  if(settled)process.exit(process.exitCode??0);
  settled=true;
  const failure={kind:'meeting-detection-error',code,failedAt:new Date().toISOString()};
  if(receipt && existsSync(receipt.path+'.process.json')){try{atomicReceipt(receipt.path,{version:1,operationId:receipt.operationId,terminal:'failure',...failure});}catch{/* An already written receipt stands. */}}
  console.error(JSON.stringify(failure));
  process.exit(1);
 };
 const deadline=setTimeout(()=>terminate(timeoutCode(phase,inflight)),options.deadlineMs??RUN_DEADLINE_MS);
 const onSignal=()=>terminate(timeoutCode(phase,inflight));
 process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
 globalThis.fetch=async(input,init)=>{
  const stage=stageOf(input);
  if(stage)inflight[stage]=(inflight[stage]??0)+1;
  let response;
  try{response=stage?await boundedGoogleFetch(request,input,init,options.fetchOptions):await request(input,init);}
  catch(error){if(stage)lastFetchFailure={stage,kind:fetchFailureKind(error)};throw error;}
  finally{if(stage)inflight[stage]--;}
  const url=new URL(String(input instanceof Request?input.url:input));
  if(url.hostname==='oauth2.googleapis.com' && response.status===400){
   const assertion=new URLSearchParams(init?.body).get('assertion');
   const sub=assertion?JSON.parse(Buffer.from(assertion.split('.')[1],'base64url').toString()).sub:null;
   if(sub) tokenErrors.set(sub,await response.clone().json());
  }
  if(url.hostname==='www.googleapis.com' && url.pathname.startsWith('/calendar/v3/calendars/') && [403,404].includes(response.status)){
   const body=await response.clone().json(); const email=decodeURIComponent(url.pathname.split('/')[4]);
   const reason=body.error?.errors?.[0]?.reason;
   failures.set(email,{calendar:email,status:response.status,...(/^[a-zA-Z0-9_]{1,64}$/.test(reason??'')?{reason}:{})});
  }
  return response;
 };
 const run=async()=>{
  const now=Date.now(), cachePath=join(config.stateDirectory,'coverage-account-cache.json');
  let cache={};try{cache=JSON.parse(readFileSync(cachePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const mint=calendar.cachedWorkspaceTokenMinter();
  const directoryToken=()=>mint(config.directory.subject,'https://www.googleapis.com/auth/admin.directory.user.readonly');
  const directoryPath=join(config.stateDirectory,'directory.json');
  let directory;try{directory=JSON.parse(readFileSync(directoryPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!directory || now-directory.at>=config.directory.refreshMinutes*60000){directory={at:now,calendars:await calendar.listWorkspaceCalendars(config.directory.subject,mint)};writeFileSync(directoryPath+'.tmp',JSON.stringify(directory),{mode:0o600});renameSync(directoryPath+'.tmp',directoryPath);}
  const calendars=[...new Set([...config.calendars,...directory.calendars])].sort();
  if(!calendars.length || calendars.length>config.directory.maximumCalendars)throw Error('directory-membership-out-of-bounds');
  phase='token';
  // Bounded batches; a known missing account is checked again after six hours, not every minute.
  for(let i=0;i<calendars.length;i+=16)await Promise.all(calendars.slice(i,i+16).map(async email=>{
   if(cache[email]?.until>now)return;
   delete cache[email];
   try{await mint(email,calendar.workspaceCalendarScope());}catch(error){
    if(!tokenErrors.has(email))throw error;
    const r=await request(`https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}?viewType=domain_public&fields=primaryEmail`,{headers:{authorization:`Bearer ${await directoryToken()}`},signal:AbortSignal.timeout(20000)});
    if(!removedSubject(400,tokenErrors.get(email),r.status))throw error;
    cache[email]={until:now+6*3600000,calendar:email,status:400,reason:'invalidUserAndDirectory404'};
   }
  }));
  phase='gcs';
  const [bytes]=await createMeetingStorage().bucket(config.policyBucket).file(config.policyObject).download();
  const policy=parseMeetingAttendancePolicy(JSON.parse(bytes.toString()));
  phase='calendar';
  const ledger=new Ledger(join(config.stateDirectory,'ledger.sqlite'));
  const snapshot=await calendar.readWorkMeetings({calendars:calendars.filter(c=>!cache[c]),mintToken:s=>mint(s,calendar.workspaceCalendarScope()),triggerEmail:config.triggerEmail,lookaheadDays:config.lookaheadDays,attendancePolicy:policy,routingTarget:config.routingTarget,trackedMeetings:ledger.prior().filter(p=>Date.parse(p.meeting.endAt)>now).map(p=>p.meeting)});
  for(const [email,f] of failures)if(f.reason==='notACalendarUser')cache[email]={...f,until:now+6*3600000};
  for(const email of calendars)if(cache[email])failures.set(email,{calendar:email,status:cache[email].status,reason:cache[email].reason});
  snapshot.unreadableCalendars=[...new Set([...snapshot.unreadableCalendars,...calendars.filter(c=>cache[c])])].sort();
  const unknown=snapshot.unreadableCalendars;
  const proof={at:new Date().toISOString(),policySha256:createHash('sha256').update(bytes).digest('hex'),policyUpdatedAt:policy.updatedAt,policyRoute:`gs://${config.policyBucket}/${config.policyObject}`,calendars,coverage:{discovered:calendars.length,readable:calendars.length-unknown.length,unknownCalendars:unknown,kind:unknown.length?'partial':'complete',failures:[...failures.values()],optedInEmails:policy.uninvitedIncludedEmails??[]},snapshot:coverageSnapshot(snapshot,config.calendars)};
  for(const [p,data] of [[cachePath,cache],[join(config.stateDirectory,'latest.json'),proof]]){writeFileSync(p+'.tmp',JSON.stringify(data),{mode:0o600});renameSync(p+'.tmp',p);}
  console.log(JSON.stringify({kind:'dry-run',at:proof.at,coverage:proof.coverage}));
 };
 const startedAt=Date.now();
 // An error the frozen classifier would call detector-unavailable is recorded privately, retried once as a fresh
 // read-only pass, and if it fails again ends with a stage code (receipt first, as terminate() does).
 const guarded=async()=>{
  for(let attempt=1;;attempt++){
   phase='directory';lastFetchFailure=null;
   try{await run();return;}
   catch(error){
    if(finiteDetectionFailure(error).code!=='detector-unavailable')throw error;
    const code=stageFailureCode(error,phase,lastFetchFailure);
    recordDiagnostic(config.stateDirectory,{at:new Date().toISOString(),operationId:receipt?.operationId??null,attempt,phase,code,
     name:error?.name??null,errno:typeof error?.code==='string'?error.code:null,cause:error?.cause?.name??null,message:redact(error?.message)});
    if(!settled && attempt===1 && Date.now()-startedAt<(options.retryBudgetMs??RETRY_BUDGET_MS))continue;
    decided={kind:'meeting-detection-error',code,failedAt:new Date().toISOString()};
    if(receipt && existsSync(receipt.path+'.process.json')){try{atomicReceipt(receipt.path,{version:1,operationId:receipt.operationId,terminal:'failure',...decided});}catch{/* An already written receipt stands. */}}
    throw error;
   }
  }
 };
 try{if(args.includes('--observer-op'))await runObserverReceipt(args,guarded);else {if(args.length!==2||args[1]!=='--dry-run')throw Error('coverage-observer-read-only');await guarded();}}
 catch(error){if(!settled){console.error(JSON.stringify(decided??finiteDetectionFailure(error)));process.exitCode=1;}}
 finally{settled=true;clearTimeout(deadline);process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);globalThis.fetch=request;}
}
if(import.meta.main)await main(process.argv[2],process.argv.slice(3));
