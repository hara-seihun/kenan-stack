#!/usr/bin/env node
// Installed check: the Kenan Stack queue observer can see every serving channel's database.
// Exit 0 healthy, 1 observed failure. With --condition FILE, a failure writes that machine-alert
// condition and a healthy run removes it, so a broken observer becomes a visible host condition.
import fs from 'node:fs';
import path from 'node:path';
import {boundedCommand} from './bounded-command.mjs';
import {currentStackQueueReferences,kenanChannels,channelDatabase,KENAN_PG_SOCKET_DIR} from './cache-queue.mjs';

const args=process.argv.slice(2);
const conditionIndex=args.indexOf('--condition');
const condition=conditionIndex>=0?args[conditionIndex+1]:null;
if(conditionIndex>=0&&(!condition||!path.isAbsolute(condition))){console.error('usage: queue-installed-check.mjs [--condition ABSOLUTE_FILE]');process.exit(64);}

function stackConfig(channel){
 const file=`/etc/kenan/${channel}.json`;
 try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='EACCES')throw error;}
 const read=boundedCommand('sudo',['-n','cat',file],{encoding:'utf8',timeout:5000,maxBuffer:1<<20});
 if(read.status!==0)throw new Error(`cannot read ${file} (directly or with sudo -n): ${String(read.error?.code??read.stderr).slice(0,300)}`);
 return JSON.parse(read.stdout);
}

const failures=[],observed={};
let channels=[];
try{channels=kenanChannels();observed.channels=channels;}catch(error){failures.push(String(error.message));}
for(const channel of channels){
 try{
  const url=new URL(stackConfig(channel).databaseUrl);
  const database=decodeURIComponent(url.pathname.slice(1)),host=url.searchParams.get('host');
  if(database!==channelDatabase(channel)||host!==KENAN_PG_SOCKET_DIR)failures.push(`${channel} serves database ${database} on ${host}; observer expects ${channelDatabase(channel)} on ${KENAN_PG_SOCKET_DIR}`);
 }catch(error){failures.push(`${channel} configuration: ${String(error.message).trim()}`);}
}
const probe='/nonexistent/agent-workspace-queue-check/'+process.pid;
for(const resourceKind of channels.length?['physical-checkout','source']:[]){
 const result=currentStackQueueReferences([probe],{resourceKind,deadline:Date.now()+15000});
 observed[resourceKind]=result.observations?.map(o=>o.channel);
 if(result.errors.length)failures.push(`${resourceKind}: ${result.errors.join('; ')}`);
 else if(result.observations.map(o=>o.channel).join()!==channels.join())failures.push(`${resourceKind}: observed ${result.observations.map(o=>o.channel)} instead of ${channels}`);
 else if(result.references.length)failures.push(`${resourceKind}: probe path unexpectedly referenced`);
}

const report={ok:failures.length===0,failures,observed,checkedAt:new Date().toISOString()};
if(condition){
 if(report.ok)fs.rmSync(condition,{force:true});
 else{
  const body=`# agent-workspace cannot observe the Kenan Stack queue\n\nObserved ${report.checkedAt} by \`agent-workspace-queue-check\` (installed \`${path.dirname(new URL(import.meta.url).pathname)}/queue-installed-check.mjs\`). While this holds, \`agent-workspace release\` and \`reconcile\` retain every checkout as \`blocked\` and nothing is physically reclaimed.\n\n${failures.map(f=>'- '+f).join('\n')}\n\nOwner: [agent-workspace README](/srv/pi/tools/agent-workspace/README.md#terminal-release-and-bounded-queue-observation), \`cache-queue.mjs\` in Pi Stack \`tools/agent-workspace\`. Host grants: /home/kenan/machine/agent-workspace-reconcile/README.md. Fix the observer or its database grant, redeploy, and this condition clears on the next healthy check.\n`;
  const temporary=condition+'.tmp-'+process.pid;fs.writeFileSync(temporary,body,{mode:0o644});fs.renameSync(temporary,condition);
 }
}
console.log(JSON.stringify(report));
process.exit(report.ok?0:1);
