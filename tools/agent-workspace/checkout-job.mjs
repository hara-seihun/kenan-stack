#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rmSync,existsSync,readFileSync,writeFileSync,renameSync } from "node:fs";
import path from "node:path";
import {ceaseCheckoutGroup} from "./checkout-cessation.mjs";
import { finishSourceJob, writeSourceJobProgress } from "./source-job.mjs";

async function clean(staging) {
  if (!path.isAbsolute(staging) || !/^\..+\.creating-[0-9a-f-]{36}(?:-\d+-\d+)?$/.test(path.basename(staging))) {
    throw new Error("invalid checkout staging path");
  }
  const custody=staging+'.custody.json';
  if(existsSync(custody)) {
    const owner=JSON.parse(readFileSync(custody,'utf8'));
    if(!Number.isSafeInteger(owner.pgid)||typeof owner.start!=="string")throw Error("checkout-cessation-unknown: invalid custody");
    if(existsSync(`/proc/${owner.pgid}/stat`)) {
      const stat=readFileSync(`/proc/${owner.pgid}/stat`,'utf8');
      if(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]!==owner.start)throw Error("checkout-cessation-unknown: group identity changed");
    }
    await ceaseCheckoutGroup(owner.pgid);
  }
  rmSync(staging, { recursive: true, force: true });
  rmSync(custody,{force:true});
}

if (process.argv[2] === "--cleanup") {
  await clean(process.argv[3]);
} else {
  const [statePath, id, staging, budget, ...args] = process.argv.slice(2);
  const directory = process.env.PI_WORKSPACE_SOURCE_JOB_DIR;
  if (!directory || !path.isAbsolute(statePath) || !Number.isFinite(Number(budget))) {
    throw new Error("invalid checkout job request");
  }
  await clean(staging);
  writeSourceJobProgress(directory, { phase: "materializing", id });
  // No workspace or Git code executes until original group custody is durable.
  const entry=new URL("workspace.mjs",import.meta.url).href;
  const bootstrap=`await new Promise((resolve,reject)=>{process.stdin.once('data',b=>b.toString()==='ready'?resolve():reject(Error('checkout admission missing')));process.stdin.once('end',()=>reject(Error('checkout admission closed')));});process.stdin.destroy();process.argv=[process.argv[0],${JSON.stringify(new URL("workspace.mjs",import.meta.url).pathname)},'create',...process.argv.slice(1)];await import(${JSON.stringify(entry)});`;
  const child = spawn(process.execPath, ["--input-type=module","-e",bootstrap,"--",...args], {
    cwd: process.env.HOME,
    env: { ...process.env, PI_WORKSPACE_STATE: statePath, PI_WORKSPACE_CREATE_CHILD: statePath,
      PI_WORKSPACE_CHECKOUT_JOB: id, PI_WORKSPACE_CHECKOUT_STAGE: staging },
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", errors = "", interrupted;
  child.stdout.on("data", bytes => { output = (output + bytes).slice(-65536); });
  child.stderr.on("data", bytes => { errors = (errors + bytes).slice(-65536); });
  const stop = reason => {
    interrupted = reason;
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop(`interrupted by ${signal}`));
  const timer = setTimeout(() => stop("checkout budget exhausted"), Number(budget) + 1000);
  // The leader may die while Git descendants still own staging and its fence.
  // Reap that exact detached group on exit, before inherited pipes can delay close.
  let cessation;
  child.once("exit",()=>{cessation=ceaseCheckoutGroup(child.pid);cessation.catch(()=>{});});
  const exiting = new Promise(resolve => {
    child.once("error", error => resolve({ code: null, error: error.message }));
    child.once("exit", (code, signal) => resolve({ code, error: signal }));
  });
  child.stdin.on("error",()=>{});
  try {
  const stat=readFileSync(`/proc/${child.pid}/stat`,'utf8');
  const custody=staging+'.custody.json';
  writeFileSync(custody+'.tmp',JSON.stringify({pgid:child.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}),{mode:0o600});
  renameSync(custody+'.tmp',custody);
    child.stdin.end("ready");
  }catch(error){stop(`checkout admission failed: ${error.message}`);}
  const exit=await exiting;
  clearTimeout(timer);
  try { if(child.pid)await (cessation??ceaseCheckoutGroup(child.pid)); }
  catch(error) {
    const finished=finishSourceJob(directory,{state:"failed",error:{code:"checkout-cessation-unknown",message:String(error.message)}});
    if(!finished.ok)throw Error(finished.error.message);
    child.stdout.destroy();child.stderr.destroy();
    throw error; // Never clean an unproven live staging tree.
  }
  child.stdout.destroy();child.stderr.destroy();
  await clean(staging);
  const result = exit.code === 0 && !interrupted
    ? { state: "ready", value: { id } }
    : { state: "failed", error: { code: "checkout-materialization-failed",
      message: `${interrupted ?? (errors.trim() || exit.error || `exit ${exit.code}`)}; private staging removed; destination not partially published. Repeat the request; for timeout, raise --creation-timeout-seconds (maximum 86400).` } };
  const finished = finishSourceJob(directory, result);
  if (!finished.ok) throw new Error(finished.error.message);
  if (result.state === "failed") process.exitCode = 1;
}
