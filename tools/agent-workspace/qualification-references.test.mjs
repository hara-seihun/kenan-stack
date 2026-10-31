import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qualificationReferences, protects, releaseDirectories } from "./qualification-references.mjs";

const A = "74551659-ca7f-47cc-92ff-c3e4b786e9e9";
const B = "11111111-2222-4333-8444-555555555555";
const C = "99999999-2222-4333-8444-555555555555";
const OWNER = "226bb31d-e421-4f2b-99bb-ced3e5606ad9";
const BASE = "3".repeat(40), LEAF1 = "a".repeat(40), LEAF2 = "b".repeat(40);
const CLONES = "/fixture/clones";

function fixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "qualification-references-"));
  const directories = releaseDirectories(data);
  for (const dir of [directories.requestsDir, directories.preparedDir, directories.producerAdmissionDir, directories.launcherDir, path.dirname(directories.queueStateFile)]) fs.mkdirSync(dir, { recursive: true });
  const write = (file, value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  write(directories.queueStateFile, { batches: [] });
  const request = (id, { root = `${CLONES}/root-${id.slice(0, 4)}`, name = `queue-${id.slice(0, 4)}`, leaves = [LEAF1, LEAF2] } = {}) => ({
    version: 1, root, rootSource: "c".repeat(40), name, args: [],
    pipeline: { operation: id, owner: OWNER, intent: "publish", through: "publication", base: BASE, leaves },
  });
  return {
    data, directories, write, request,
    addRequest(id, options = {}, { prepared = true, raw } = {}) {
      const record = request(id, options);
      write(path.join(directories.requestsDir, `${id}.json`), raw ?? record);
      if (prepared) {
        write(path.join(directories.preparedDir, `${id}.json.workspace.json`), { id: "ws-" + id.slice(0, 4), path: `${CLONES}/prepared-${id}`, owner: OWNER });
        write(path.join(directories.preparedDir, `${id}.json.assembly.json`), { request: record, candidate: "d".repeat(40) });
      }
      return record;
    },
    complete(id, overrides = {}) {
      write(path.join(directories.producerAdmissionDir, `${id}.completed.json`), { version: "1", identity: { operation: id, owner: OWNER, base: BASE, leaves: [LEAF1, LEAF2], ...overrides }, state: "completed" });
    },
    refuse(id, extra = {}) {
      const bytes = fs.readFileSync(path.join(directories.requestsDir, `${id}.json`));
      write(path.join(directories.launcherDir, `${id}.qualification-refused.json`), { version: 1, operation: id, requestSHA256: crypto.createHash("sha256").update(bytes).digest("hex"), error: "QUALIFICATION_AUTHORITY_REFUSED:x", ...extra });
    },
    train(name, leaves = [LEAF1, LEAF2]) {
      const state = JSON.parse(fs.readFileSync(directories.queueStateFile, "utf8"));
      state.batches.push({ name, leaves, owners: [OWNER], base: BASE, after: null });
      write(directories.queueStateFile, state);
    },
  };
}
const census = (f, roots = null) => qualificationReferences(roots, f.directories);

test("a current undispatched request protects its root and prepared workspace", () => {
  const f = fixture();
  f.addRequest(A, { root: `${CLONES}/root-c52-p226` });
  const result = census(f);
  assert.deepEqual(result.errors, []);
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].state, "undispatched");
  assert.equal(result.references[0].preparedPath, `${CLONES}/prepared-${A}`);
  assert.equal(protects(result, `${CLONES}/root-c52-p226`), true);
  assert.equal(protects(result, `${CLONES}/prepared-${A}`), true);
  assert.equal(protects(result, `${CLONES}/prepared-${B}`), false);
});

test("an active train pairs with its request and protects it even after the request settles", () => {
  const f = fixture();
  f.addRequest(A, { name: "queue-1" });
  f.train("queue-1");
  f.complete(A);
  const result = census(f);
  assert.deepEqual(result.errors, []);
  assert.ok(result.references.some((r) => r.kind === "queue_train" && r.id === "queue-1" && r.paths.length === 2));
  assert.equal(protects(result, `${CLONES}/prepared-${A}`), true);
});

test("a train whose leaves contradict its request is an error and the census protects everything", () => {
  const f = fixture();
  f.addRequest(A, { name: "queue-1" });
  f.train("queue-1", [LEAF1]);
  const result = census(f);
  assert.equal(result.complete, false);
  assert.match(result.errors.join("\n"), /contradicts/u);
  assert.equal(protects(result, "/anything/else"), true);
});

test("an exact completed settlement releases an old request without consulting its age", () => {
  const f = fixture();
  f.addRequest(B);
  f.complete(B);
  const old = new Date(2020, 0, 1);
  fs.utimesSync(path.join(f.directories.requestsDir, `${B}.json`), old, old);
  const result = census(f);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.references, []);
  assert.equal(result.released[0].state, "completed");
  assert.equal(protects(result, `${CLONES}/root-${B.slice(0, 4)}`), false);
});

test("a retryable launcher refusal still protects, but an explicitly terminal refusal with the exact digest releases", () => {
  const f = fixture();
  f.addRequest(A);
  f.refuse(A);
  let result = census(f);
  assert.equal(result.references[0].state, "refused-retryable");
  f.refuse(A, { terminal: true });
  result = census(f);
  assert.deepEqual(result.references, []);
  assert.equal(result.released[0].state, "refused");
});

test("a refusal for different request bytes is contradictory and fails closed", () => {
  const f = fixture();
  f.addRequest(A);
  f.refuse(A, { terminal: true, requestSHA256: "0".repeat(64) });
  const result = census(f);
  assert.equal(result.complete, false);
  assert.equal(protects(result, `${CLONES}/prepared-${A}`), true);
  assert.equal(result.references[0].state, "refusal-contradictory");
});

test("missing receipts and a missing dispatch grant protect; a grant without settlement is dispatched-unsettled", () => {
  const f = fixture();
  f.addRequest(A);
  f.addRequest(B);
  f.write(path.join(f.directories.preparedDir, `${B}.json.grant.json`), { token: "t", spec: {} });
  const states = Object.fromEntries(census(f).references.map((r) => [r.id, r.state]));
  assert.deepEqual(states, { [A]: "undispatched", [B]: "dispatched-unsettled" });
});

test("a retired queue does not retain unrelated paths or discard active request custody", () => {
  const f = fixture();
  f.addRequest(A);
  fs.rmSync(f.directories.queueStateFile);
  let result = census(f);
  assert.equal(result.complete, true);
  assert.deepEqual(result.errors, []);
  assert.equal(protects(result, "/x/y"), false);
  assert.equal(protects(result, `${CLONES}/prepared-${A}`), true);
  f.complete(A);
  result = census(f);
  assert.equal(result.complete, true);
  assert.deepEqual(result.references, []);
  assert.equal(protects(result, `${CLONES}/prepared-${A}`), false);
  fs.rmSync(f.directories.requestsDir, { recursive: true });
  result = census(f);
  assert.equal(result.complete, true);
  assert.equal(result.observations[0].state, "not-installed");
});

test("malformed or contradictory records fail closed and keep the paths that can still be named", () => {
  const f = fixture();
  f.addRequest(A, {}, { raw: "{not json" });
  let result = census(f);
  assert.equal(result.complete, false);
  assert.ok(result.references.some((r) => r.id === A && r.state === "unreadable-request" && r.paths.includes(`${CLONES}/prepared-${A}`)));
  const g = fixture();
  const record = g.addRequest(B);
  g.write(path.join(g.directories.requestsDir, `${B}.json`), { ...record, pipeline: { ...record.pipeline, operation: C } });
  result = census(g);
  assert.equal(result.complete, false);
  assert.match(result.errors.join("\n"), /does not match the file name/u);
  const h = fixture();
  h.addRequest(A);
  h.write(path.join(h.directories.preparedDir, `${A}.json.assembly.json`), { request: { root: "/elsewhere" } });
  assert.match(census(h).errors.join("\n"), /assembled root contradicts/u);
  const i = fixture();
  i.addRequest(A);
  i.complete(A, { base: "4".repeat(40) });
  assert.match(census(i).errors.join("\n"), /settlement contradicts/u);
  assert.equal(census(i).references.length, 1);
});

test("an unreadable request is released only by its exact positive settlement", () => {
  const f = fixture();
  f.addRequest(A, {}, { raw: "{broken" });
  f.complete(A);
  const result = census(f);
  assert.deepEqual(result.errors, []);
  assert.equal(result.released[0].state, "completed");
});

test("withdrawn request files are terminal and unrelated roots have no reference", () => {
  const f = fixture();
  f.write(path.join(f.directories.requestsDir, `${C}.json.withdrawn-held-abc123`), "{}");
  f.addRequest(A);
  const result = census(f, ["/fixture/clones/unrelated-root"]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.references, []);
  assert.equal(protects(result, "/fixture/clones/unrelated-root"), false);
  assert.ok(census(f).released.some((r) => r.id === C && r.state === "withdrawn"));
  assert.equal(census(f, [`${CLONES}/root-7455`]).references.length, 1);
});

test("the census is bounded and only reads", () => {
  const f = fixture();
  f.addRequest(A);
  const before = fs.readdirSync(f.directories.requestsDir).length;
  const limited = qualificationReferences(null, { ...f.directories, limits: { maxEntries: 0 } });
  assert.equal(limited.complete, false);
  assert.match(limited.errors[0], /entry bound/u);
  const bytes = qualificationReferences(null, { ...f.directories, limits: { maxFileBytes: 8 } });
  assert.equal(bytes.complete, false);
  assert.equal(fs.readdirSync(f.directories.requestsDir).length, before);
  assert.equal(qualificationReferences(["relative"], f.directories).complete, false);
});

test("a current request also protects its carried root workspace before dispatch",()=>{
 const f=fixture();try{f.addRequest(A);const carried=`${CLONES}/carry-root-${A}`;f.write(path.join(f.directories.preparedDir,`${A}.json.root-workspace.json`),{id:B,path:carried,root:BASE});const result=census(f);assert.deepEqual(result.errors,[]);assert.equal(protects(result,carried),true);assert.equal(protects(result,carried+'/infrastructure'),true);}finally{fs.rmSync(f.data,{recursive:true,force:true});}
});

test("a host with only release locks and historical residue has no installed qualification component",()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'qualification-uninstalled-'));try{
 fs.mkdirSync(path.join(data,'locks'));fs.mkdirSync(path.join(data,'old-scout'));const result=qualificationReferences(null,{dataRoot:data});assert.deepEqual(result.errors,[]);assert.equal(result.complete,true);assert.equal(result.references.length,0);assert.equal(result.observations[0].state,'not-installed');
 fs.mkdirSync(path.join(data,'qualification-authority-requests'));assert.equal(qualificationReferences(null,{dataRoot:data}).complete,true,'an empty request directory does not require the optional retired queue');
 }finally{fs.rmSync(data,{recursive:true,force:true});}
});

function retainedFixture() {
 const f=fixture(),request=f.addRequest(A);
 request.pipeline.intent='qualify-only';request.pipeline.through='staging';
 f.write(path.join(f.directories.requestsDir,A+'.json'),request);
 const dir=path.join(f.directories.producerAdmissionDir,'retained-stage');fs.mkdirSync(dir);
 const closurePath=path.join(dir,A+'.staged.json');
 const closure={kind:'retained-stage-closure',identity:request.pipeline,candidate:'d'.repeat(40),products:['omniscience'],publication:'unpublished',originalSha256:'e'.repeat(64),qualificationSha256:'f'.repeat(64),hashes:{omniscience:'a'.repeat(64)}};
 f.write(closurePath,closure);
 const record={...closure,version:1,kind:'retained-stage',state:'completed',completion:{receipt:closurePath,sha256:crypto.createHash('sha256').update(fs.readFileSync(closurePath)).digest('hex')}};
 const recordPath=path.join(dir,A+'.json');f.write(recordPath,record);
 return {...f,record,recordPath,closurePath};
}
test('completed retained staging releases only its exact qualification request',()=>{
 const f=retainedFixture(),r=census(f);assert.deepEqual(r.errors,[]);assert.deepEqual(r.references,[]);assert.equal(r.released[0].evidence,f.closurePath);
});
test('active or incomplete retained staging remains protected',()=>{
 for(const state of ['active','unknown',undefined]){const f=retainedFixture();f.record.state=state;f.write(f.recordPath,f.record);assert.equal(protects(census(f),`${CLONES}/prepared-${A}`),true);}
});
test('changed retained closure, identity, path, or publication authority refuses',()=>{
 for(const change of [f=>f.write(f.closurePath,{}),f=>f.record.identity.owner='different',f=>f.record.completion.receipt='/other/closure',f=>f.record.identity.through='publication',f=>f.record.candidate='invalid']){
  const f=retainedFixture();change(f);f.write(f.recordPath,f.record);const r=census(f);assert.equal(r.complete,false);assert.equal(protects(r,'/anything'),true);
 }
});
test('a publish request is never completed by a retained staging closure',()=>{
 const f=retainedFixture(),request=f.request(A);f.write(path.join(f.directories.requestsDir,A+'.json'),request);assert.equal(census(f).complete,false);
});

 test("an existing malformed queue still fails closed", () => {
  const f = fixture();
  f.write(f.directories.queueStateFile, "{broken");
  const result = census(f);
  assert.equal(result.complete, false);
  assert.match(result.errors.join("\n"), /malformed JSON/u);
  assert.equal(protects(result, "/unrelated/path"), true);
});
