import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// The pin is accepted source custody, not a cache. Only successful transfer to
// the workspace row clears it; time and ref rewrites cannot authorize new work.
export function refPinPath(statePath, destination, request) {
  const key = createHash("sha256").update(JSON.stringify({ destination, request })).digest("hex");
  return path.join(path.dirname(statePath), "source-preparations", "ref-pins", `${key}.json`);
}

// Resolve lazily: even an unavailable or deleted mutable ref cannot displace
// an already accepted source preparation on its exact retry.
export function pinnedSourceCommit({ file, resolve, now = Date.now() }) {
  try {
    const pin = JSON.parse(readFileSync(file, "utf8"));
    if (!/^[0-9a-f]{40}$/u.test(pin.sourceCommit ?? "")) throw new Error("invalid accepted source pin");
    return pin.sourceCommit;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const resolved = resolve();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify({ sourceCommit: resolved, at: now }), { mode: 0o600 });
  renameSync(temporary, file);
  return resolved;
}

export function clearRefPin(file) {
  rmSync(file, { force: true });
}
