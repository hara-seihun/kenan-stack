import { zoneOrHome } from '../../shared/zone.js';

/** The broker refuses background work while every shared account's five-hour window is below the reserve kept for people, and says when the hold lifts. */
export const QUOTA_HOLD_CODE = 'background_reserve';
/** The hold lifts when the window resets; the meters refresh a little after, so the resume waits a moment longer. */
export const RESUME_SLACK_MS = 20_000;

/** When a failed model call's hold lifts (epoch ms), or null if the failure is not a broker hold that names its reset. */
export function quotaHoldUntil(failure: string): number | null {
  const last = failure.split(' (after ')[0]!;
  if (!last.includes(`"code":"${QUOTA_HOLD_CODE}"`)) return null;
  const at = /"retry_at":(\d{10,})/.exec(last)?.[1];
  return at ? Number(at) : null;
}

export const quotaResumeAt = (holdUntil: number, now: number): number => Math.max(holdUntil, now) + RESUME_SLACK_MS;
export const QUOTA_WAKE_REASON = 'the broker held this run\'s model calls (every five-hour window below the reserve) until its reset';

export const quotaResumeText = (model: string) =>
  `Your model calls on ${model} were held by the broker (every shared account's five-hour window was below the reserve kept for people), and the hold has now lifted. This is not a block and nothing needs reporting: carry on exactly where you stopped, with your task and conversation unchanged. If a model call is refused the same way again, the run parks and resumes by itself.`;

export function quotaParkedText(name: string, id: string, goalId: string | null, resumeAt: number, zone: string | null): string {
  const tz = zoneOrHome(zone);
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(resumeAt);
  return `Worker ${name} (${id})${goalId ? `, goal ${goalId}` : ''} is parked: the broker is holding background model calls until the five-hour reset at ${local}. It resumes by itself then, with the same model and conversation; no blocked report.`;
}
