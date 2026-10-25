// Read-only census of Converge-owned qualification custody: nonterminal qualification
// authority requests, their prepared workspaces and merge-queue trains. The native
// process/streaming-tool guards see nothing for a request that is prepared but not yet
// dispatched, so release/reconcile consults this census as well. Every verdict comes
// from exact records; no verdict depends on age. Anything missing, malformed or
// contradictory protects (fail closed) and is reported as an error.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_RELEASE_DATA = "/home/kenan/data/converge-releases";
export const LIMITS = Object.freeze({ maxEntries: 4096, maxFileBytes: 4 << 20, maxTotalBytes: 128 << 20 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const WITHDRAWN = /^([0-9a-f-]{36})\.json\.withdrawn-[A-Za-z0-9._-]+$/u;

export function releaseDirectories(dataRoot = DEFAULT_RELEASE_DATA) {
  return {
    requestsDir: path.join(dataRoot, "qualification-authority-requests"),
    preparedDir: path.join(dataRoot, "prepared-qualifications"),
    producerAdmissionDir: path.join(dataRoot, "producer-admission"),
    launcherDir: path.join(dataRoot, "release-launcher"),
    queueStateFile: path.join(dataRoot, "merge-queue", "state.json"),
  };
}

class Budget {
  constructor(limits) { this.limits = limits; this.total = 0; }
  read(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    if (stat.size > this.limits.maxFileBytes) throw new Error(`${file} exceeds the ${this.limits.maxFileBytes} byte record bound`);
    this.total += stat.size;
    if (this.total > this.limits.maxTotalBytes) throw new Error("qualification census exceeded its total byte bound");
    return fs.readFileSync(file);
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const absolute = (value) => typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value.replace(/\/+$/u, "") && value !== "/";
const sameSet = (left, right) => left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item));

function readJson(budget, file) {
  let bytes;
  try { bytes = budget.read(file); } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    return { error: `${file}: ${error.message}` };
  }
  try { return { value: JSON.parse(bytes.toString("utf8")), sha256: crypto.createHash("sha256").update(bytes).digest("hex") }; } catch (error) {
    return { error: `${file}: malformed JSON: ${error.message}` };
  }
}

function listDirectory(dir, limits) {
  try {
    const names = fs.readdirSync(dir);
    if (names.length > limits.maxEntries) return { error: `${dir}: ${names.length} entries exceed the ${limits.maxEntries} entry bound` };
    return { names: names.sort() };
  } catch (error) {
    return { error: `${dir}: ${error.code === "ENOENT" ? "directory missing" : error.message}` };
  }
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * qualificationReferences(roots, options) -> { errors, references, released, observations, complete, observedAt }
 *
 * roots: absolute paths being considered for release, or null/undefined for every reference.
 * options: dataRoot or explicit directories (requestsDir, preparedDir, producerAdmissionDir,
 *   launcherDir, queueStateFile) for fixtures, plus limits.
 * references: { kind, id, state, resourceClass: "qualification-request", targetPath, paths, ... }
 *   kind is "qualification_request" or "queue_train"; paths are the protected roots and prepared workspaces.
 * errors: strings. Any error means the census is incomplete, and protects() then protects every path.
 */
export function qualificationReferences(roots = null, options = {}) {
  const directories = { ...releaseDirectories(options.dataRoot), ...Object.fromEntries(Object.entries(options).filter(([key]) => key.endsWith("Dir") || key === "queueStateFile")) };
  const limits = { ...LIMITS, ...(options.limits ?? {}) };
  const budget = new Budget(limits);
  const errors = [], references = [], released = [], ignored = [];
  if (roots !== null && (!Array.isArray(roots) || roots.some((root) => !absolute(root)))) {
    return { errors: ["exact absolute reference roots required"], references: [], released, observations: [], complete: false, observedAt: Date.now() };
  }

  const queue = readJson(budget, directories.queueStateFile);
  let batches = [];
  if (queue.missing) errors.push(`${directories.queueStateFile}: merge-queue state missing; train custody cannot be established`);
  else if (queue.error) errors.push(queue.error);
  else if (!isObject(queue.value) || !Array.isArray(queue.value.batches)) errors.push(`${directories.queueStateFile}: merge-queue state has no batches array`);
  else {
    batches = queue.value.batches;
    for (const batch of batches) {
      if (!isObject(batch) || typeof batch.name !== "string" || !Array.isArray(batch.leaves) || !batch.leaves.every((leaf) => SHA.test(leaf)))
        errors.push(`${directories.queueStateFile}: malformed batch record ${JSON.stringify(batch)?.slice(0, 120)}`);
    }
  }
  const trains = new Map(batches.filter((batch) => isObject(batch) && typeof batch.name === "string").map((batch) => [batch.name, batch]));

  const listing = listDirectory(directories.requestsDir, limits);
  if (listing.error) {
    errors.push(listing.error);
    return finish(roots, errors, references, released, ignored);
  }
  const requestPathsByTrain = new Map();

  for (const name of listing.names) {
    const withdrawn = WITHDRAWN.exec(name);
    if (withdrawn !== null) { released.push({ id: withdrawn[1], state: "withdrawn", evidence: path.join(directories.requestsDir, name) }); continue; }
    if (!name.endsWith(".json")) { ignored.push(name); continue; }
    const id = name.slice(0, -".json".length);
    if (!UUID.test(id)) { errors.push(`${path.join(directories.requestsDir, name)}: request file name is not an operation id`); continue; }
    const requestFile = path.join(directories.requestsDir, name);
    const request = readJson(budget, requestFile);
    const terminal = terminalEvidence(budget, directories, id, request);
    if (request.error || request.missing || !isObject(request.value)) {
      if (terminal.state === "completed") { released.push({ id, state: "completed", evidence: terminal.file, note: "request unreadable but its exact settlement is positive" }); continue; }
      errors.push(request.error ?? `${requestFile}: request record unreadable`);
      protectPrepared(id, null, "unreadable-request");
      continue;
    }
    const value = request.value;
    const contradictions = [];
    if (value.version !== 1) contradictions.push("unsupported version");
    if (value.pipeline?.operation !== id) contradictions.push("pipeline operation does not match the file name");
    if (!absolute(value.root)) contradictions.push("request root is not an exact absolute path");
    if (!isObject(value.pipeline) || !Array.isArray(value.pipeline.leaves) || !value.pipeline.leaves.every((leaf) => SHA.test(leaf))) contradictions.push("pipeline leaves malformed");
    if (contradictions.length) {
      errors.push(`${requestFile}: ${contradictions.join("; ")}`);
      protectPrepared(id, absolute(value.root) ? value.root : null, "contradictory-request");
      continue;
    }

    const prepared = preparedPaths(budget, directories, id, value, errors);
    const paths = [value.root, ...prepared.paths];
    const train = trains.get(value.name);
    if (train !== undefined) {
      if (!sameSet(train.leaves, value.pipeline.leaves) || (Array.isArray(train.owners) && train.owners.length && value.pipeline.owner !== undefined && !train.owners.includes(value.pipeline.owner))) {
        errors.push(`${requestFile}: queue train ${value.name} contradicts the request's leaves or owner`);
      }
      requestPathsByTrain.set(value.name, [...(requestPathsByTrain.get(value.name) ?? []), ...paths]);
    }

    if (terminal.error) { errors.push(terminal.error); }
    if (terminal.state === "completed") {
      if (terminal.contradiction) errors.push(`${terminal.file}: settlement contradicts the request identity (${terminal.contradiction})`);
      else if (train === undefined) { released.push({ id, state: "completed", evidence: terminal.file }); continue; }
      // A completed request whose train is still listed stays protected through the train reference.
      else { released.push({ id, state: "completed-train-listed", evidence: terminal.file, note: "request settled; the listed train protects its roots" }); continue; }
    }
    const refusal = refusalEvidence(budget, directories, id, request.sha256, errors);
    if (refusal.state === "terminal-refusal") { released.push({ id, state: "refused", evidence: refusal.file }); continue; }
    const grant = readJson(budget, path.join(directories.preparedDir, `${id}.json.grant.json`));
    if (grant.error) errors.push(grant.error);
    const state = refusal.state ?? (grant.missing ? "undispatched" : grant.value ? "dispatched-unsettled" : "unverifiable");
    references.push({
      kind: "qualification_request", id, state, resourceClass: "qualification-request", targetPath: value.root, paths,
      root: value.root, rootSource: value.rootSource, name: value.name, owner: value.pipeline.owner, leaves: value.pipeline.leaves,
      preparedPath: prepared.paths[0] ?? null, workspaceId: prepared.workspaceId ?? null, requestSha256: request.sha256,
      train: train === undefined ? null : train.name, refusal: refusal.file ?? null,
    });
  }

  for (const [name, train] of trains) {
    const paths = [...new Set(requestPathsByTrain.get(name) ?? [])];
    references.push({
      kind: "queue_train", id: name, state: "train-listed", resourceClass: "qualification-request", targetPath: paths[0] ?? null, paths,
      leaves: train.leaves, owners: train.owners ?? [], after: train.after ?? null, requestFound: paths.length > 0,
    });
  }
  return finish(roots, errors, references, released, ignored);

  function protectPrepared(id, root, state) {
    const prepared = preparedPaths(budget, directories, id, null, errors);
    const paths = [...(root ? [root] : []), ...prepared.paths];
    if (!paths.length) { errors.push(`${id}: no root or prepared workspace could be established for an unreadable request`); return; }
    references.push({ kind: "qualification_request", id, state, resourceClass: "qualification-request", targetPath: paths[0], paths });
  }
}

function terminalEvidence(budget, directories, id, request) {
  const file = path.join(directories.producerAdmissionDir, `${id}.completed.json`);
  const record = readJson(budget, file);
  if (record.missing) return { state: "none", file };
  if (record.error) return { state: "unreadable", file, error: record.error };
  const value = record.value;
  if (!isObject(value) || value.state !== "completed" || !isObject(value.identity) || value.identity.operation !== id)
    return { state: "unreadable", file, error: `${file}: not an exact completed settlement for ${id}` };
  let contradiction = null;
  const pipeline = request?.value?.pipeline;
  if (isObject(pipeline)) {
    if (value.identity.owner !== pipeline.owner) contradiction = "owner";
    else if (value.identity.base !== pipeline.base) contradiction = "base";
    else if (!Array.isArray(value.identity.leaves) || !sameSet(value.identity.leaves, pipeline.leaves ?? [])) contradiction = "leaves";
  }
  return { state: "completed", file, contradiction };
}

// A launcher refusal alone is not terminal: its own text leaves the request to its owner to retry.
// Only a refusal that carries an explicit terminal disposition and the exact request digest releases.
function refusalEvidence(budget, directories, id, requestSha256, errors) {
  const file = path.join(directories.launcherDir, `${id}.qualification-refused.json`);
  const record = readJson(budget, file);
  if (record.missing) return { state: null };
  if (record.error) { errors.push(record.error); return { state: "refusal-unreadable", file }; }
  const value = record.value;
  if (!isObject(value) || value.operation !== id || value.requestSHA256 !== requestSha256) {
    errors.push(`${file}: refusal does not match this operation and request digest`);
    return { state: "refusal-contradictory", file };
  }
  if (value.terminal === true || value.disposition === "terminal") return { state: "terminal-refusal", file };
  return { state: "refused-retryable", file };
}

function preparedPaths(budget, directories, id, request, errors) {
  const paths = [];
  const workspace = readJson(budget, path.join(directories.preparedDir, `${id}.json.workspace.json`));
  const assembly = readJson(budget, path.join(directories.preparedDir, `${id}.json.assembly.json`));
  let workspaceId = null;
  if (workspace.error) errors.push(workspace.error);
  else if (!workspace.missing) {
    if (isObject(workspace.value) && absolute(workspace.value.path)) {
      paths.push(workspace.value.path);
      workspaceId = typeof workspace.value.id === "string" ? workspace.value.id : null;
    } else errors.push(`${directories.preparedDir}/${id}.json.workspace.json: no exact workspace path`);
  }
  if (assembly.error) errors.push(assembly.error);
  else if (!assembly.missing && request !== null) {
    const root = assembly.value?.request?.root;
    if (root !== request.root) errors.push(`${directories.preparedDir}/${id}.json.assembly.json: assembled root contradicts the request root`);
  }
  return { paths, workspaceId };
}

function finish(roots, errors, references, released, ignored) {
  const complete = errors.length === 0;
  const selected = roots === null ? references : references.filter((reference) => reference.paths.some((p) => roots.some((root) => overlaps(p, root))));
  return {
    errors, complete, references: selected, released, observedAt: Date.now(),
    observations: [{ source: "qualification-records", requests: references.filter((r) => r.kind === "qualification_request").length, trains: references.filter((r) => r.kind === "queue_train").length, released: released.length, ignored }],
  };
}

/** True when the census protects the path; an incomplete census protects everything. */
export function protects(result, candidate) {
  if (!result.complete) return true;
  return result.references.some((reference) => reference.paths.some((p) => overlaps(p, candidate)));
}
