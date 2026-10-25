import { fileURLToPath, pathToFileURL } from "node:url";
import { runJobs } from "../../scripts/run-jobs.mjs";

const shardCount = 128;
export const workspaceChecks = [["agent workspace frozen source", "sudo", ["-n","/usr/bin/python3",fileURLToPath(new URL("./frozen-source.test.py",import.meta.url))],{timeoutMs:30_000}],...['capacity-deploy','capacity-lock','mirror-lock','mirror-concurrency','capacity-parallel'].map(name=>[`agent workspace ${name}`,process.execPath,['--test',fileURLToPath(new URL(`./${name}.test.mjs`,import.meta.url))],{timeoutMs:150_000}]),...['admission-refresh','incremental-allocation','source-handoff','register-capacity','growth-reprice','automatic-growth','root-terminal-growth','growth-writer-observation','release-growth-settlement','release-self-reference','terminal-finalizer','measurement-isolation','writer-custody','execution-capacity','source-ref','source-job-abandon','terminal-custody','retained-headroom','import-ancestors','checkout-cessation','source-ready-reuse','release-reachability','local-merge-disposal','maintenance-journal','maintenance-cli','bounded-command','resume-growth','reprice-admission','release-custody','release-interruption','cache-queue','safety-census','safety-budget','thread-reference-budget','installed-references','stdout-records','owner-liveness','native-owner','native-owner-integration','qualification-references','sampler-priority','frozen-unreadable'].map(name=>[`agent workspace ${name}`,process.execPath,['--test',fileURLToPath(new URL(`./${name}.test.mjs`,import.meta.url))],{timeoutMs:55_000}]), ["agent workspace protected-source cache retirement", process.execPath, ["--test", fileURLToPath(new URL("./cache-retirement.test.mjs", import.meta.url))]], ["agent workspace cache retirement crash resume", process.execPath, ["--test", fileURLToPath(new URL("./cache-retirement-crash.test.mjs", import.meta.url))]], ["agent workspace terminal retained release", process.execPath, ["--test", fileURLToPath(new URL("./terminal-release.test.mjs", import.meta.url))]], ["agent workspace exact source materialization", process.execPath, ["--test", fileURLToPath(new URL("./source-materialization.test.mjs", import.meta.url))]], ["agent workspace supported source retirement CLI", process.execPath, ["--test", fileURLToPath(new URL("./source-materialization-public.test.mjs", import.meta.url))]], ["agent workspace active growth reduction", process.execPath, ["--test", fileURLToPath(new URL("./growth-reduction.test.mjs", import.meta.url))]], ["agent workspace kind-aware job observation", process.execPath, ["--test", fileURLToPath(new URL("./job-observation.test.mjs", import.meta.url))]], ["agent workspace retained growth lifecycle", process.execPath, ["--test", fileURLToPath(new URL("./growth-lifecycle.test.mjs", import.meta.url))]], ["agent workspace capacity recovery", process.execPath,
  ["--test", fileURLToPath(new URL("./capacity-recovery.test.mjs", import.meta.url))]], ["agent workspace component deployment", process.execPath,
  ["--test", fileURLToPath(new URL("./deploy.test.mjs", import.meta.url))]],
  ["agent workspace durable source preparation", process.execPath,
    ["--test", fileURLToPath(new URL("./source-job.test.mjs", import.meta.url))]],
  ["agent workspace atomic durable checkout", process.execPath,
    ["--test", fileURLToPath(new URL("./checkout-job.test.mjs", import.meta.url))], { timeoutMs: 55_000 }], ...Array.from({ length: shardCount }, (_, index) => [
  `agent workspace ${index + 1}/${shardCount}`,
  process.execPath,
  ["--test", fileURLToPath(new URL("./test.mjs", import.meta.url))],
  { timeoutMs: index===104?240_000:index===81?120_000:55_000, env: { AGENT_WORKSPACE_TEST_SHARD: `${index}/${shardCount}` } },
])];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runJobs(workspaceChecks, { concurrency: 1 });
}
