#!/usr/bin/env node
import net from 'node:net';
import {createRequire} from 'node:module';
import {Worker,isMainThread,parentPort} from 'node:worker_threads';
import {serveRequest} from './background-launch.mjs';

if(!isMainThread){
 parentPort.on('message',({input,peer})=>parentPort.postMessage(serveRequest(input,peer)));
}else{
 if(process.getuid()!==0)throw Error('background_root_required');
 if(process.env.LISTEN_PID!==String(process.pid)||process.env.LISTEN_FDS!=='1')throw Error('background_activation_required');
 const {credentials}=createRequire(import.meta.url)('./peer-credentials.node');
 const warm=4,workers=new Set(),idle=[];
 let closing=false,connections=0;
 const error=code=>({ok:false,error:{code}});
 const worker=()=>{
  const thread=new Worker(new URL(import.meta.url));
  const entry={thread,reply:null,timer:null};workers.add(entry);
  thread.on('message',response=>{
   const reply=entry.reply;entry.reply=null;reply?.(response);
   if(closing){workers.delete(entry);thread.terminate();finish();return;}
   idle.push(entry);
   if(workers.size>warm){entry.timer=setTimeout(()=>{
    const at=idle.indexOf(entry);if(at<0)return;
    idle.splice(at,1);workers.delete(entry);thread.terminate();
   },60000);entry.timer.unref();}
  });
  const failed=()=>{
   if(!workers.delete(entry))return;
   clearTimeout(entry.timer);const at=idle.indexOf(entry);if(at>=0)idle.splice(at,1);
   // Work may already have reached systemd. Never submit it again after a worker failure.
   entry.reply?.(error('background_launch_outcome_unknown'));entry.reply=null;
   if(!closing&&workers.size<warm)idle.push(worker());
   finish();
  };
  thread.on('error',failed);thread.on('exit',failed);
  return entry;
 };
 const finish=()=>{if(closing&&workers.size===0)process.exit(0);};
 for(let i=0;i<warm;i++)idle.push(worker());
 const server=net.createServer({allowHalfOpen:true},socket=>{
  connections++;
  socket.once('close',()=>connections--);
  socket.on('error',()=>{});
  const reply=response=>{if(!socket.destroyed)socket.end(JSON.stringify(response)+'\n');};
  let peer;try{peer=credentials(socket._handle.fd);}catch(e){reply(error(e.message));return;}
  if(closing||connections>256){reply(error('background_launch_busy'));return;}
  let bytes=0,chunks=[],submitted=false;
  socket.setTimeout(60000,()=>socket.destroy());
  socket.on('data',chunk=>{
   bytes+=chunk.length;
   if(bytes>2**20){chunks=[];reply(error('background_request_too_large'));socket.destroy();return;}
   chunks.push(chunk);
  });
  socket.on('end',()=>{
   if(submitted||bytes>2**20)return;submitted=true;
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reply(error('background_invalid_launch'));return;}finally{chunks=[];}
   // A warm idle thread handles ordinary calls. Bursts get another thread immediately,
   // not a shared queue behind a slow systemd request or stop operation.
   const entry=idle.pop()??worker();clearTimeout(entry.timer);entry.reply=reply;
   entry.thread.postMessage({input,peer});
  });
 });
 server.listen({fd:3});
 process.on('SIGTERM',()=>{
  closing=true;server.close();
  for(const entry of idle.splice(0)){clearTimeout(entry.timer);workers.delete(entry);entry.thread.terminate();}
  finish();
 });
}
