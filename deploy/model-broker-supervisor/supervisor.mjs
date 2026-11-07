#!/usr/bin/env node
// Zero-downtime supervisor for the subscription model broker.
//
//   supervisor.mjs run --state DIR --release LINK --entry REL --ports CONFIG -- WORKER_ARGS...
//   supervisor.mjs reload --state DIR [--timeout-ms N]
//
// `run` is the unit's main process. It owns the listening sockets (Node cluster, SCHED_NONE: every
// worker accepts on the same kernel socket) and runs one broker generation from the release LINK
// points to. SIGHUP starts a new generation from wherever LINK points now; once it listens on every
// port in CONFIG's listeners, the old generation gets SIGTERM and finishes its open streams while
// the new one takes every new connection. A generation that fails to start is killed and the old
// one keeps serving. `reload` sends SIGHUP and waits for that outcome (exit 0 ready, 1 failed).
import cluster from "node:cluster";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const READY_TIMEOUT_MS = 90_000;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 5;

const log = (event, fields = {}) => console.log(JSON.stringify({ event: `broker_supervisor_${event}`, at: new Date().toISOString(), ...fields }));

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  let tail = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--") { tail = rest.slice(i + 1); break; }
    const match = /^--([a-z-]+)$/.exec(rest[i]);
    if (!match || i + 1 >= rest.length) return { ok: false, error: `bad argument ${rest[i]}` };
    options[match[1]] = rest[++i];
  }
  return { ok: true, value: { command, options, tail } };
}

function readState(dir) {
  try { return { ok: true, value: JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

function expectedPorts(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const ports = config.listeners.map(listener => listener.port);
  if (!ports.length || ports.some(port => !Number.isInteger(port))) throw new Error(`no listener ports in ${configPath}`);
  return new Set(ports);
}

function runPrimary({ state: stateDir, release: releaseLink, entry, ports: portsConfig }, workerArgs) {
  cluster.schedulingPolicy = cluster.SCHED_NONE;
  let generation = 0;
  let current;
  const retiring = new Map();
  let signals = 0;
  let lastReload;
  let reloading = false;
  let reloadQueued = false;
  let stopping = false;
  const crashes = [];

  const writeState = () => {
    const state = {
      pid: process.pid, signals, reload: lastReload,
      current: current && { generation: current.generation, pid: current.worker.process.pid, release: current.release, readyAt: current.readyAt },
      retiring: [...retiring.values()].map(gen => ({ generation: gen.generation, pid: gen.worker.process.pid, release: gen.release, since: gen.retiringSince })),
    };
    const path = join(stateDir, "state.json");
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${path}.tmp`, path);
  };

  const start = () => new Promise(resolve => {
    let release, ports;
    try {
      release = realpathSync(releaseLink);
      ports = expectedPorts(portsConfig);
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const gen = { generation: ++generation, release, worker: undefined, readyAt: undefined };
    cluster.setupPrimary({ exec: join(release, entry), args: workerArgs, silent: false });
    gen.worker = cluster.fork({ KENAN_BROKER_GENERATION: String(gen.generation) });
    const seen = new Set();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      gen.worker.off("listening", listening);
      gen.worker.off("message", announced);
      gen.worker.off("exit", exited);
      resolve(result);
    };
    const listen = (port) => {
      if (ports.has(port)) seen.add(port);
      if (seen.size === ports.size) { gen.readyAt = new Date().toISOString(); finish({ ok: true, value: gen }); }
    };
    const listening = (address) => listen(address.port);
    const announced = (message) => { if (message?.type === "broker_listening" && Array.isArray(message.ports)) message.ports.forEach(listen); };
    const exited = (code, signal) => finish({ ok: false, error: `generation ${gen.generation} exited before listening (code ${code}, signal ${signal})` });
    const timer = setTimeout(() => {
      gen.worker.process.kill("SIGKILL");
      finish({ ok: false, error: `generation ${gen.generation} listened on ${seen.size}/${ports.size} ports after ${READY_TIMEOUT_MS} ms` });
    }, READY_TIMEOUT_MS);
    gen.worker.on("listening", listening);
    gen.worker.on("message", announced);
    gen.worker.on("exit", exited);
  });

  const retire = (gen) => {
    gen.retiringSince = new Date().toISOString();
    retiring.set(gen.worker.id, gen);
    gen.worker.process.kill("SIGTERM");
    log("retiring", { generation: gen.generation, pid: gen.worker.process.pid });
  };

  const adopt = (gen) => {
    const previous = current;
    current = gen;
    log("ready", { generation: gen.generation, pid: gen.worker.process.pid, release: gen.release });
    if (previous) retire(previous);
  };

  const reload = async () => {
    if (stopping) return;
    if (reloading) { reloadQueued = true; return; }
    reloading = true;
    const covers = signals;
    const started = await start();
    if (started.ok && !stopping) adopt(started.value);
    else if (started.ok) started.value.worker.process.kill("SIGTERM");
    else log("reload_failed", { error: started.error });
    lastReload = started.ok
      ? { covers, outcome: "ready", generation: started.value.generation, release: started.value.release, at: new Date().toISOString() }
      : { covers, outcome: "failed", error: started.error, at: new Date().toISOString() };
    writeState();
    reloading = false;
    if (reloadQueued) { reloadQueued = false; void reload(); }
  };

  cluster.on("exit", (worker, code, signal) => {
    const old = retiring.get(worker.id);
    if (old) {
      retiring.delete(worker.id);
      log("drained", { generation: old.generation, pid: worker.process.pid, code, signal });
    } else if (current?.worker === worker) {
      log("worker_exited", { generation: current.generation, pid: worker.process.pid, code, signal, stopping });
      current = undefined;
      if (!stopping) {
        const now = Date.now();
        crashes.push(now);
        while (crashes.length && crashes[0] < now - CRASH_WINDOW_MS) crashes.shift();
        if (crashes.length >= CRASH_LIMIT) { log("crash_loop", { crashes: crashes.length }); process.exit(1); }
        void reload();
      }
    }
    writeState();
    if (stopping && Object.keys(cluster.workers ?? {}).length === 0) { log("stopped"); process.exit(0); }
  });

  process.on("SIGHUP", () => { signals++; writeState(); log("reload_requested", { signals }); void reload(); });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("stopping", { workers: Object.keys(cluster.workers ?? {}).length });
    // A retiring generation already has its SIGTERM; a second one would kill it mid-stream.
    for (const worker of Object.values(cluster.workers ?? {})) if (!retiring.has(worker.id)) worker.process.kill("SIGTERM");
    if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  void (async () => {
    const started = await start();
    if (!started.ok) { log("start_failed", { error: started.error }); process.exit(1); }
    adopt(started.value);
    lastReload = { covers: 0, outcome: "ready", generation: started.value.generation, release: started.value.release, at: new Date().toISOString() };
    writeState();
  })();
}

async function requestReload({ state: stateDir, "timeout-ms": timeoutMs = "120000" }) {
  const before = readState(stateDir);
  if (!before.ok) { console.error(`reload: no supervisor state in ${stateDir}: ${before.error}`); return 2; }
  const covered = before.value.signals;
  process.kill(before.value.pid, "SIGHUP");
  const deadline = Date.now() + Number(timeoutMs);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const now = readState(stateDir);
    if (now.ok && now.value.reload && now.value.reload.covers > covered) {
      console.log(JSON.stringify(now.value.reload));
      return now.value.reload.outcome === "ready" ? 0 : 1;
    }
  }
  console.error(`reload: no outcome within ${timeoutMs} ms`);
  return 1;
}

if (cluster.isPrimary) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) { console.error(parsed.error); process.exit(2); }
  const { command, options, tail } = parsed.value;
  if (command === "run") {
    const missing = ["state", "release", "entry", "ports"].filter(key => !options[key]);
    if (missing.length || !tail.length) { console.error(`run needs --${missing.join(", --") || "-- WORKER_ARGS"}`); process.exit(2); }
    runPrimary(options, tail);
  } else if (command === "reload") {
    if (!options.state) { console.error("reload needs --state"); process.exit(2); }
    process.exit(await requestReload(options));
  } else {
    console.error("usage: supervisor.mjs run|reload ...");
    process.exit(2);
  }
}
