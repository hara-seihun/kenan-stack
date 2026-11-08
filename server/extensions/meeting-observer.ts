export function isDetectorCode(value:unknown):boolean {
 return typeof value==='string' && (/^(calendar|directory|iam|token|gcs|auth|policy)-(network|timeout|aborted|unavailable|invalid-response|http-[45][0-9]{2})$/.test(value) || ['detector-unavailable','calendar-coverage-incomplete'].includes(value) || detectorCodes.has(value));
}
/** Discovery failure is unknown policy, never an empty successful snapshot. */
const detectorCodes = new Set(['native-credential-unset','native-cookie-unset','directory-cache-invalid','directory-membership-out-of-bounds','invalid-policy-series','required-calendar-coverage-incomplete','unknown-detector-mode','observation-expired']);
export class ObserverFailure extends Error {
 constructor(message:string,readonly retryNotBefore?:number,readonly retryBlocked=false,readonly failedAt?:string){super(message);}
}
export const observerStages = ['launch','snapshot-read','snapshot-parse','policy-validation','session-update','notification','health-commit'] as const;
export type ObserverStage = typeof observerStages[number];
export function observerStageFailure(stage:ObserverStage,error:unknown,result?:{exitCode:number;termination?:string;signal?:NodeJS.Signals|null}):ObserverFailure {
 if(error instanceof ObserverFailure)return error;
 const errno=(error as {code?:unknown}|null)?.code;
 const reason=['ENOENT','EACCES','EIO','ENOSPC','ECONNRESET','ECONNREFUSED','ETIMEDOUT','40001','40P01','23505'].includes(String(errno))?String(errno).toLowerCase():error instanceof SyntaxError?'invalid-json':error instanceof Error && error.message==='Meeting observation is stale'?'stale':error instanceof Error && error.message==='Meeting calendar coverage is incomplete'?'coverage-incomplete':'failed';
 const termination=['exit','signal','timeout','cancelled'].includes(result?.termination??'')?result!.termination:'unknown';
 const signal=['SIGTERM','SIGKILL','SIGINT'].includes(result?.signal??'')?result!.signal:result?.signal?'other':'none';
 return new ObserverFailure(`Meeting observer stage ${stage}/${reason} (exit ${Number.isInteger(result?.exitCode)?result!.exitCode:'unknown'}; termination ${termination}; signal ${signal})`);
}
/** Only finite detector protocol fields cross into status; raw bodies never do. */
export function observerDiagnostic(error: unknown): string {
  if (error instanceof ObserverFailure) return error.message;
  const text = error instanceof Error ? error.message : '';
  if (['Meeting observation is stale','Meeting calendar coverage is incomplete','Invalid meeting snapshot','Invalid meeting observation','Meeting observer is not configured'].includes(text)) return text;
  return 'Meeting observation unavailable (unclassified failure; raw detail withheld)';
}
export function assertObserverSuccess(result: {exitCode: number; output: Buffer; signal?: NodeJS.Signals | null; termination?: string}, now=Date.now()): void {
  if (result.exitCode === 0) return;
  let code = 'unclassified-detector-failure';
  let retryNotBefore:number|undefined, retryBlocked=false, failedAt:string|undefined;
  for (const line of result.output.subarray(0, 16384).toString().split('\n')) {
    try {
      const data = JSON.parse(line) as {kind?:unknown;code?:unknown;retryNotBefore?:unknown;retryBlocked?:unknown;failedAt?:unknown};
      if (data.kind !== 'meeting-detection-error' || typeof data.code !== 'string') continue;
      if (isDetectorCode(data.code) || /^native-login-http-[45][0-9]{2}$/.test(data.code)) code = data.code;
      else if (/^native-http-[45][0-9]{2}-/.test(data.code)) code = data.code.slice(0, 15); // status only, never remote error text
      if(data.code===code && typeof data.failedAt==='string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(data.failedAt)&&Number.isFinite(Date.parse(data.failedAt)))failedAt=data.failedAt;
      if(data.code===code && /^(calendar|directory)-http-(408|429|5[0-9]{2})$/.test(code)){
        if(data.retryBlocked===true)retryBlocked=true;
        if(typeof data.retryNotBefore==='number' && Number.isFinite(data.retryNotBefore) && data.retryNotBefore>now){
          if(!Number.isSafeInteger(data.retryNotBefore) || data.retryNotBefore-now>7*86400000)retryBlocked=true;
          else retryNotBefore=Math.max(retryNotBefore??0,data.retryNotBefore);
        }
      }
    } catch { /* Raw stderr, provider bodies and unknown protocol fields stay private. */ }
  }
  const termination = ['exit','signal','timeout','cancelled'].includes(result.termination ?? '') ? result.termination : 'unknown';
  const signal = result.signal === 'SIGTERM' || result.signal === 'SIGKILL' || result.signal === 'SIGINT' ? result.signal : result.signal ? 'other' : 'none';
  throw new ObserverFailure(`Meeting observer failed (exit ${Number.isInteger(result.exitCode) ? result.exitCode : 'unknown'}; termination ${termination}; signal ${signal}; timeout limit 90s): meeting-detection-error/${code}`,retryNotBefore,retryBlocked,failedAt);
}
export interface ObserverHealthState {lastAttemptAt:string;lastSuccessAt:string|null;consecutiveFailures:number;lastError:string|null;nextPeriodicAttemptAt:string;retryNotBefore?:number;retryBlocked?:boolean;failedAt?:string}
export function createObserverHealth() {
  const states = new Map<string, ObserverHealthState>();
  return {
    status: (id: string) => states.get(id) ?? null,
    restore(id:string,state:ObserverHealthState){ states.set(id,state); },
    assertReady(id:string,now:number){const s=states.get(id);if(s?.retryBlocked || (s?.retryNotBefore??0)>now)throw new ObserverFailure('Meeting discovery deferred by read dependency cooldown',s?.retryNotBefore,s?.retryBlocked);},
    ready: (id: string, now: number) => !states.get(id)?.retryBlocked && now >= (states.get(id)?.retryNotBefore??0) && (!states.get(id)?.consecutiveFailures || now >= Date.parse(states.get(id)!.nextPeriodicAttemptAt)),
    success(id: string, now: number, observedAt: string) {
      // A delayed older success cannot clear a newer dependency restriction.
      const prior=states.get(id);if(prior?.retryBlocked || (prior?.retryNotBefore??0)>now)return;
      states.set(id, {lastAttemptAt:new Date(now).toISOString(), lastSuccessAt:observedAt, consecutiveFailures:0, lastError:null, nextPeriodicAttemptAt:new Date(now+30000).toISOString()});
    },
    failure(id: string, now: number, error: unknown) {
      const prior=states.get(id), failures=(prior?.consecutiveFailures ?? 0)+1;
      const retryNotBefore=Math.max(prior?.retryNotBefore??0,error instanceof ObserverFailure?error.retryNotBefore??0:0);
      const retryBlocked=prior?.retryBlocked || (error instanceof ObserverFailure && error.retryBlocked);
      states.set(id, {retryNotBefore,retryBlocked,...(error instanceof ObserverFailure&&error.failedAt?{failedAt:error.failedAt}:{}),lastAttemptAt:new Date(now).toISOString(), lastSuccessAt:prior?.lastSuccessAt ?? null, consecutiveFailures:failures, lastError:observerDiagnostic(error), nextPeriodicAttemptAt:new Date(Math.max(retryNotBefore,now+Math.min(120000,30000*2**Math.min(failures-1,2)))).toISOString()});
    },
  };
}

/** A single fresh read may recover a terminal transient; never retry a provider effect,
 * a consumer failure, unknown termination or a dependency's retry restriction. */
export function retryableObserverRead(error: unknown, settled: {settled:boolean;state:ObserverHealthState & {pendingRead?:unknown}}): boolean {
  return settled.settled && !settled.state.pendingRead && !settled.state.retryBlocked && !settled.state.retryNotBefore
    && error instanceof ObserverFailure && !error.retryBlocked && !error.retryNotBefore
    && error.message === 'Meeting observer failed (exit 1; termination exit; signal none; timeout limit 90s): meeting-detection-error/detector-unavailable';
}
