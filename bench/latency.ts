// Admission benchmark: an isolated room without agents makes no model calls.
// KENAN_URL=https://... KENAN_ACCOUNT=alice KENAN_SECRET_FILE=/path/to/secret npx tsx bench/latency.ts
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const origin=process.env.KENAN_URL;
if(!origin||!process.env.KENAN_ACCOUNT||!process.env.KENAN_SECRET_FILE)throw Error('Set KENAN_URL, KENAN_ACCOUNT and KENAN_SECRET_FILE');
let cookie='';
async function request(path:string,method='GET',body?:unknown){
 const response=await fetch(origin+path,{method,headers:{'content-type':'application/json','x-kenan-client':'native',cookie},body:body===undefined?undefined:JSON.stringify(body)});
 cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')||cookie;
 const result=await response.json() as {ok:boolean,value:any,error?:unknown};
 if(!response.ok||!result.ok)throw Error(JSON.stringify(result));return result.value;
}
await request('/api/login','POST',{accountId:process.env.KENAN_ACCOUNT,secret:(await readFile(process.env.KENAN_SECRET_FILE,'utf8')).trim()});
const room=await request('/api/conversations','POST',{title:'Admission benchmark',memberIds:[]});
const times:number[]=[];
try{
 for(let i=0;i<20;i++){
  const start=performance.now();
  await request(`/api/conversations/${room.id}/messages`,'POST',{text:'Admission benchmark',clientId:randomUUID(),clientSentAt:Date.now()});
  times.push(performance.now()-start);
 }
 times.sort((a,b)=>a-b);
 const percentile=(p:number)=>times[Math.min(times.length-1,Math.floor(times.length*p))];
 console.log(JSON.stringify({samples:times.length,roundTripMs:{p50:percentile(.5),p90:percentile(.9),p99:percentile(.99)},server:await request('/api/metrics')},null,2));
}finally{
 await request(`/api/conversations/${room.id}`,'PATCH',{archived:true});
 await request('/api/logout','POST',{});
}
