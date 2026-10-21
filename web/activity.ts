import type { Activity } from '../shared/contract.js';

const STATE_TEXT: Record<Activity['state'], string> = { thinking: 'Thinking', tool: 'Running a tool', streaming: 'Writing' };

export const activityText = (activity: Activity) => activity.label || STATE_TEXT[activity.state];

/** Apply a live activity event: null means the conversation's run ended. */
export function withActivity(current: Record<string, Activity>, conversationId: string, next: Activity | null): Record<string, Activity> {
  if (next) return { ...current, [conversationId]: next };
  if (!(conversationId in current)) return current;
  const { [conversationId]: _ended, ...rest } = current;
  return rest;
}
