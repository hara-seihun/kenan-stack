// The measured Converge release has four fresh local/queue passes, 29 declared
// generated outputs and over 13,000 remote heads. Its execution belongs in the
// existing 150-second physical inspection bound, not the 20-second foreground
// submission bound. Scope identity chooses detachment; it never grants custody.
export const RELEASE_INSPECTION_MS = 150_000;
export function releaseBudgetMs(scope) {
  return scope && scope.background !== true ? 20_000 : RELEASE_INSPECTION_MS;
}
