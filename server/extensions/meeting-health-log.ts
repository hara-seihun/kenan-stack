import type {ReadState} from './meeting-receipt.js';
import {isDetectorCode,observerStages} from './meeting-observer.js';
/** The full durable state stays intact. Logs carry finite current identity and
 * counts, not growing history, paths, raw provider messages or credentials. */
export function observerHealthLog(ownerId:string,state:ReadState|null):string {
 const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(v)?v:'unknown';
 const operation=(v:unknown)=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v)?v:undefined;
 const time=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)?v:null;
 const text=state?.lastError??'', match=text.match(/meeting-detection-error\/([a-z0-9-]+)/), code=isDetectorCode(match?.[1])?match![1]!:'unclassified-detector-failure';
 const consumer=text.match(/^Meeting observer stage ([a-z-]+)\/(failed|stale|coverage-incomplete|invalid-json|enoent|eacces|eio|enospc|econnreset|econnrefused|etimedout|40001|40p01|23505) \(/);
 const consumerStage=consumer&&observerStages.includes(consumer[1] as typeof observerStages[number])?consumer[1]:null;
 const stale=text==='Meeting observation is stale';
 const termination=text.match(/termination (exit|signal|timeout|cancelled|unknown);/)?.[1]??'unknown';
 const exit=text.match(/\(exit (-?\d+);/)?.[1];
 return JSON.stringify({ownerId:id(ownerId),operationId:operation(state?.pendingRead?.operationId??state?.lastRead?.operationId??state?.interruptedRead?.operationId),lastAttemptAt:time(state?.lastAttemptAt),lastSuccessAt:time(state?.lastSuccessAt),consecutiveFailures:Number.isSafeInteger(state?.consecutiveFailures)?state!.consecutiveFailures:0,code:consumerStage?`observer-${consumer![2]}`:stale?'receipt-success-needs-validation':code,stage:consumerStage??(stale?'receipt-reconcile':null)??(/^(calendar|directory|iam|token|gcs|auth|policy)-/.test(code)?code.split('-')[0]:null),failedAt:time(state?.failedAt),termination,exitCode:exit?Number(exit):null,retryBlocked:state?.retryBlocked===true,retryNotBefore:Number.isSafeInteger(state?.retryNotBefore)?state!.retryNotBefore:null,priorInterruptedReadCount:state?.priorInterruptedReads?.length??0,interruptedOperationId:operation(state?.interruptedRead?.operationId)});
}
