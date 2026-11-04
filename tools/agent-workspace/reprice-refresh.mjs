// Only a pre-effect, own-sample refusal is retryable. All pricing arguments and
// admission checks are kept by decide; partial walks never authorize new writes.
export function repriceWithSample({decide,refresh,defer,deadline,now=Date.now}) {
  const observations=[];
  while(true) {
    try { return decide(); }
    catch(error) { if(error.code!=='reprice-sample-required')throw error; }
    if(now()>=deadline-2000)return defer(observations);
    const observation=refresh();
    observations.push(observation);
    if(observation.kind==='partial')continue;
    if(['fresh','measured'].includes(observation.kind)) {
      // The exact original operation rechecks identity, freshness and capacity.
      return decide();
    }
    if(observation.kind==='deferred')return defer(observations);
    throw Object.assign(new Error(`capacity repricing sample refresh failed: ${observation.detail??observation.kind}; original capacity plan retained`),
      {code:'reprice-sample-refresh-failed',sampling:observations});
  }
}
