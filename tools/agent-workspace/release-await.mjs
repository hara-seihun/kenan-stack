// A native foreground release submits its physical work to an authenticated background
// unit and used to return exit 75 at once. Callers read 75 as a failure (worker b101d217,
// October 29: the release actually completed three seconds later). The foreground call now
// observes its own submission for a bounded time and reports the real outcome:
//  - "completed": the record is released, its tree is gone and its settlement is committed (exit 0);
//  - "terminal": the background unit ended without releasing (retained or refused; exit 2);
//  - "pending": still running when the observation budget ended (exit 75, accepted work).
// The observation is read-only; it never launches, retries or changes custody.
export const RELEASE_AWAIT_MS = 30_000;
const pause = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = ms => { Atomics.wait(pause, 0, 0, ms); };

export function awaitSubmittedRelease({read, budgetMs = RELEASE_AWAIT_MS, intervalMs = 250, now = Date.now, sleep = sleepSync}) {
  const until = now() + budgetMs;
  for (;;) {
    const observed = read();
    if (observed.recordState === 'released' && observed.pathExists === false && observed.settlementKind === 'completed') return {kind: 'completed', observed};
    if (observed.submissionState === 'terminal-known' || observed.unitCeased === true) return {kind: 'terminal', observed};
    if (observed.submissionState !== 'submitted') return {kind: 'pending', observed};
    const left = until - now();
    if (left <= 0) return {kind: 'pending', observed};
    sleep(Math.min(intervalMs, left));
  }
}

// A terminal receipt can be visible just before its worker unit deactivates.
// Wait briefly, read-only, for that same unit to cease before deciding whether
// its retained release may continue. An unknown or still-active effect is never relaunched.
export const RELEASE_CESSATION_AWAIT_MS = 5_000;
export function awaitUnitCessation({observe, budgetMs = RELEASE_CESSATION_AWAIT_MS, intervalMs = 100, now = Date.now, sleep = sleepSync}) {
  const until = now() + budgetMs;
  for (;;) {
    const observed = observe();
    if (observed?.ceased === true) return observed;
    const left = until - now();
    if (left <= 0) return observed ?? {ceased: false};
    sleep(Math.min(intervalMs, left));
  }
}
