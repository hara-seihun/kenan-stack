import {redactCredentials} from '../redact.js';
/** A database diagnostic is bounded UTF-8, never half a serialized JSON record. */
export function boundedErrorLog(message:string):string {
 const safe=redactCredentials(message).text;
 if(Buffer.byteLength(safe,'utf8')<=4000)return safe;
 const prefix=Array.from(safe).slice(0,600).join('');
 // A JSON envelope works for arbitrary text too; no invalid surrogate/JSON cut.
 return JSON.stringify({truncated:true,originalBytes:Buffer.byteLength(safe,'utf8'),preview:prefix});
}
