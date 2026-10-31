import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// A create request usually names a moving ref (HEAD or a branch). Preparing its source and
// checking it out takes tens of seconds, and a busy repository (seinari) moves HEAD in that
// time. Resolving the ref again on every repeat keyed a brand-new preparation each time, so
// admission never finished (2026-10-31). The first call pins the commit it resolved; repeats
// of the same request reuse it while it is recent and still an ancestor of the ref.
export const REF_PIN_MAX_AGE_MS = 30 * 60 * 1000;

export function refPinPath(statePath, destination, request) {
  const key = createHash("sha256").update(JSON.stringify({ destination, request })).digest("hex");
  return path.join(path.dirname(statePath), "source-preparations", "ref-pins", `${key}.json`);
}

// isAncestor(pinned, resolved) returns true, false, or null when it cannot tell (for a remote
// source whose new head has not been imported yet); null keeps a recent pin.
export function pinnedSourceCommit({ file, resolved, isAncestor, now = Date.now() }) {
  let pin = null;
  try { pin = JSON.parse(readFileSync(file, "utf8")); } catch {}
  if (pin && /^[0-9a-f]{40}$/u.test(pin.sourceCommit ?? "") && Number.isSafeInteger(pin.at)
    && now >= pin.at && now - pin.at < REF_PIN_MAX_AGE_MS
    && (pin.sourceCommit === resolved || isAncestor(pin.sourceCommit, resolved) !== false)) return pin.sourceCommit;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify({ sourceCommit: resolved, at: now }), { mode: 0o600 });
  renameSync(temporary, file);
  return resolved;
}

export function clearRefPin(file) {
  rmSync(file, { force: true });
}
