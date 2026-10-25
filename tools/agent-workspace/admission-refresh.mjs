// Admission must precede every effect in decide. Only its typed pre-effect refusal
// is retryable; sampling never holds the device admission fence.
export function admitWithRefresh({decide, refresh, candidates, now=Date.now, budgetMs=30_000}) {
  let first;
  try { return decide(); }
  catch (error) {
    if (error.code !== 'workspace-capacity-refused') throw error;
    first=error;
  }
  const deadline=now()+budgetMs, observations=[];
  for (const candidate of candidates(first)) {
    if (now()>=deadline) break;
    try { observations.push({path:candidate.path,...refresh(candidate,deadline)}); }
    catch (error) { observations.push({path:candidate.path,kind:'failed',detail:error.message}); }
    try { return decide(observations); }
    catch (error) {
      if (error.code!=='workspace-capacity-refused') throw error;
      first=error;
    }
  }
  // Preserve the final genuine refusal and its current accounting, never waive it.
  first.capacityRefresh={observations,budgetMs};
  throw first;
}
