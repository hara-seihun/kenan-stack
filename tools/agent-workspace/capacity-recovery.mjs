import { randomUUID } from "node:crypto";

// The pre-typed deployed receipt is immutable; decode only its exact disk-refusal grammar.
export function capacityRecovery(terminal, previousJobId, observation, expectedMirror) {
  if (terminal?.state !== "failed" || !["workspace-capacity-refused", "source-preparation-failed", "workspace-capacity-lock-busy", "workspace-mirror-lock-busy"].includes(terminal.error?.code)) {
    return { state: "terminal" };
  }
  // A capacity fence acquisition precedes both admission and source import. Only this
  // exact exhausted-wait grammar is safe to recover; mirror/import failures are not.
  const lock = /^workspace resource busy: capacity:([0-9]+): ([1-9][0-9]*)ms lock budget exhausted$/u.exec(terminal.error.message);
  // Mirror acquisition precedes its action (no fetch/update-ref executed). Bind the
  // exact canonical mirror from the original creation request, not arbitrary prose.
  const mirrorLock = /^workspace resource busy: mirror:(\/[^\r\n]+): ([1-9][0-9]*)ms lock budget exhausted$/u.exec(terminal.error.message)
    ?? /^workspace resource busy: mirror-source:(\/[^\r\n]+):[0-9a-f]{4,40}: ([1-9][0-9]*)ms lock budget exhausted$/u.exec(terminal.error.message);
  const mirrorRecovery = typeof expectedMirror === "string" && mirrorLock !== null && mirrorLock[1] === expectedMirror;
  if (terminal.error.code === "workspace-mirror-lock-busy" && !mirrorRecovery) return { state: "terminal" };
  const lockRecovery = lock !== null && lock[1] === observation?.device;
  if (terminal.error.code === "workspace-capacity-lock-busy" && !lockRecovery) return { state: "terminal" };
  const [message, ...suffix] = terminal.error.message.split("\n");
  if (suffix.length > 0) {
    if (suffix.length !== 1 || !suffix[0].startsWith("capacity-detail: ")) return { state: "terminal" };
    let detail;
    try { detail = JSON.parse(suffix[0].slice("capacity-detail: ".length)); }
    catch { return { state: "terminal" }; }
    if (!detail || Array.isArray(detail) || typeof detail !== "object"
      || !Number.isSafeInteger(detail.freeBytes) || detail.freeBytes < 0
      || !Number.isSafeInteger(detail.requiredBytes) || detail.requiredBytes < 0
      || typeof detail.device !== "string" || !Number.isSafeInteger(detail.observedAt)
      || !detail.breakdown || detail.breakdown.requiredBytes !== detail.requiredBytes) return { state: "terminal" };
  }
  const refusal = /^(\d+\.\d{2}) GiB is free; (\d+\.\d{2}) GiB is required \((?:source forecast \+ declared growth \+ operating headroom \+ other reservations|unestimated full work \+ other reservations)\)$/u.exec(message);
  if (refusal === null && !lockRecovery && !mirrorRecovery) return { state: "terminal" };
  if (!/^[0-9a-f]{64}$/u.test(previousJobId) || !Number.isSafeInteger(observation?.observedAt)
    || typeof observation.device !== "string" || !Number.isSafeInteger(observation.freeBytes)
    || observation.freeBytes < 0 || !Number.isSafeInteger(observation.freeInodes)
    || !Number.isSafeInteger(observation.totalInodes)) {
    return { state: "invalid", error: { code: "capacity-recovery-invalid-observation", message: "capacity recovery requires fresh filesystem evidence and the original job identity" } };
  }
  return { state: "retry", value: { kind: "capacity-recovery", ...(mirrorRecovery ? { cause: "pre-import-mirror-lock", mirror: expectedMirror } : lockRecovery ? { cause: "pre-import-capacity-lock" } : {}), id: randomUUID(), previousJobId,
    originalRefusal: terminal.error, observation } };
}
