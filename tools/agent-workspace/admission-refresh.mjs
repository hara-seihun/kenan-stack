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
  let pending=[...candidates(first)];
  while(pending.length && now()<deadline) {
    const next=[];
    for (const candidate of pending) {
      if (now()>=deadline) break;
      let observation;
      try { observation=refresh(candidate,deadline); }
      catch (error) { observation={kind:'failed',detail:error.message}; }
      observations.push({path:candidate.path,...observation});
      try { return decide(observations); }
      catch (error) {
        if (error.code!=='workspace-capacity-refused') throw error;
        first=error;
      }
      // A large tree gets another resumable slice only after every other
      // deciding reservation has had a turn. Failed walks are never hot-looped.
      if(observation.kind==='partial')next.push(candidate);
    }
    pending=next;
  }
  // Preserve the final genuine refusal and its current accounting, never waive it.
  first.capacityRefresh={observations,budgetMs};
  // The CLI and its callers retain stderr rather than Error object fields.
  first.message+=`\ncapacity-refresh: ${JSON.stringify(first.capacityRefresh)}`;
  throw first;
}
