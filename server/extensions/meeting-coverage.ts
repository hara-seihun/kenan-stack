/** Coverage notices are summaries, not a diagnosis inferred from a missing calendar. */
export interface Coverage { discovered?: number; readable?: number; unknownCalendars: string[]; failures?: {calendar: string; status: number; reason?: string}[]; optedInEmails?: string[] }
export interface CoverageNotice { at: number; discovered: number; readable: number; unknown: string[]; observedUnknown?: string[] }
export function coverageNoticeDue(coverage: Coverage, prior: CoverageNotice | null, now: number): boolean {
  const unknown=coverage.unknownCalendars;
  const newlyMissing=unknown.filter(c=>!(prior?.observedUnknown ?? prior?.unknown ?? []).includes(c));
  const critical=new Set(['person39@example.com', ...(coverage.optedInEmails ?? [])]);
  if(newlyMissing.some(c=>critical.has(c))) return true;
  if(prior && prior.readable>0 && (prior.readable-(coverage.readable ?? prior.readable))/prior.readable>0.10) return true;
  return unknown.length>0 && (!prior || now-prior.at>=86400000);
}
export function coverageNoticeText(proof: {coverage: Coverage}, uncovered: readonly string[]): string {
  const c=proof.coverage, failures=c.failures ?? [];
  const counts=new Map<string,number>();
  for(const email of uncovered) { const f=failures.find(f=>f.calendar===email); const reason=f?`HTTP ${f.status}${f.reason?` (${f.reason})`:''}`:'HTTP 403 or 404 (the older detector did not retain the exact status)'; counts.set(reason,(counts.get(reason)??0)+1); }
  return `Meeting discovery coverage is partial: ${c.readable} of ${c.discovered} calendars are readable; ${uncovered.length} are unreadable${uncovered.length?`: ${uncovered.join(', ')}`:''}. ${[...counts].map(([reason,n])=>`${n} returned ${reason}`).join('; ')}. These responses do not establish suspension, deletion or an ACL change. Discovery and consent checks continue for readable calendars. Routine coverage notices are limited to once per 24 hours; a drop greater than 10% or a newly unreadable Alice or opted-in calendar is reported promptly.`;
}
