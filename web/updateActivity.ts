// Reloads must wait for microphone work and the final words being saved to a draft.
let active = 0;

/** Hold automatic reload until this work ends. Releasing twice is harmless. */
export function beginUpdateActivity(): () => void {
  active++;
  let released = false;
  return () => { if (!released) { released = true; active--; } };
}

export function updateActivityBusy(): boolean { return active > 0; }
