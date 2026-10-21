/** Discovery failure is unknown policy, never an empty successful snapshot. */
const detectorCodes = new Set(['native-credential-unset','native-cookie-unset','directory-cache-invalid','directory-membership-out-of-bounds','invalid-policy-series','required-calendar-coverage-incomplete','unknown-detector-mode','observation-expired']);
export class ObserverFailure extends Error {
 constructor(message:string,readonly retryNotBefore?:number,readonly retryBlocked=false){super(message);}
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
  let retryNotBefore:number|undefined, retryBlocked=false;
  for (const line of result.output.subarray(0, 16384).toString().split('\n')) {
    try {
      const data = JSON.parse(line) as {kind?:unknown;code?:unknown;retryNotBefore?:unknown;retryBlocked?:unknown};
      if (data.kind !== 'meeting-detection-error' || typeof data.code !== 'string') continue;
      if (/^(calendar|directory|iam|token)-(network|timeout|unavailable|invalid-response|http-[45][0-9]{2})$/.test(data.code) || data.code === 'detector-unavailable' || data.code === 'calendar-coverage-incomplete' || detectorCodes.has(data.code) || /^native-login-http-[45][0-9]{2}$/.test(data.code)) code = data.code;
      else if (/^native-http-[45][0-9]{2}-/.test(data.code)) code = data.code.slice(0, 15); // status only, never remote error text
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
  throw new ObserverFailure(`Meeting observer failed (exit ${Number.isInteger(result.exitCode) ? result.exitCode : 'unknown'}; termination ${termination}; signal ${signal}; timeout limit 90s): meeting-detection-error/${code}`,retryNotBefore,retryBlocked);
}
export interface ObserverHealthState {lastAttemptAt:string;lastSuccessAt:string|null;consecutiveFailures:number;lastError:string|null;nextPeriodicAttemptAt:string;retryNotBefore?:number;retryBlocked?:boolean}
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
      states.set(id, {retryNotBefore,retryBlocked,lastAttemptAt:new Date(now).toISOString(), lastSuccessAt:prior?.lastSuccessAt ?? null, consecutiveFailures:failures, lastError:observerDiagnostic(error), nextPeriodicAttemptAt:new Date(Math.max(retryNotBefore,now+Math.min(120000,30000*2**Math.min(failures-1,2)))).toISOString()});
    },
  };
}
