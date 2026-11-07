import type { Goal, GoalCategory } from '../../shared/contract.js';
import type { Deps } from '../types.js';
import { componentOf } from './components.js';

export const categoryGuidance = 'category is independent of work research/product. Use upkeep (shown under System) for host tools, Kenan Stack app/backend fixes, intake/merge/deploy plumbing, disk and credential repairs. Use work for research, compiler, company, life-admin and Acme outcomes. Goals create defaults to work; spawn/respawn and sub-agents inherit their goal. An explicit category on spawn/dispatch/respawn reclassifies the whole goal, including existing workers; goals update category reclassifies it later. Dispatch infers upkeep for standing host tools or tool/system repairs, otherwise work. Set category explicitly when the title or brief could be ambiguous.';

/** Classify the outcome, not the worker's model or research/product profile. */
export function classifyGoalCategory(input: { title: string; text?: string; category?: GoalCategory }): GoalCategory {
  if (input.category !== undefined) return input.category;
  if (componentOf(input.title) || /^(?:app|kenan[ -]stack)(?:\s*[:—-]|$)/i.test(input.title.trim()) || /\b(?:megabatch|rcargo|phonectl|phone_settings)\b/i.test(input.title)) return 'upkeep';
  // Only the title and first paragraph describe the requested outcome. A research brief may mention a tool
  // failure as background, and a compiler, company or Acme fix is still ordinary work.
  const subject = `${input.title}\n${input.text?.split(/\n\s*\n/)[0] ?? ''}`;
  const repair = /\b(fix(?:es|ing)?|repair\w*|improv\w*|slow\w*|latency|broke[n]?|bug\w*|fail\w*|crash\w*|stuck|stall\w*|hang\w*|timeout\w*|reject\w*|refus\w*|missing permission|credential\w*|disk (?:full|space)|permission denied|ENOSPC)\b/i;
  const system = /\b(kenan[ -]?(?:stack|beta)|pi[ -]?stack|host (?:tool|service|system)|system (?:tool|service|bug)|agent (?:tool|runtime)|tool (?:call|bug|failure)|workers tool|goals tool|wake tool|browser|cloud[ -]browser|tool[ -]scope|lifecycle|intake|deploy(?:ment)?|merge (?:pipeline|plumbing)|disk|credential|model[ -]broker|mail[ -](?:send|search)|verification[ -]code|cloud[ -]browser|kenan[ -][a-z-]+)\b/i;
  if (repair.test(subject) && system.test(subject)) return 'upkeep';
  // Routine host maintenance is upkeep even without an error.
  if (/\b(?:intake|deploy|deployment|disk|credential)\b.*\b(?:plumbing|repair|maintenance|cleanup)\b|\b(?:repair|maintain|clean up)\b.*\b(?:host|disk|credential|deployment)\b/i.test(subject)) return 'upkeep';
  return 'work';
}

/** Goal categories are read dynamically; send fresh worker records so every child moves immediately in the app. */
export async function publishGoalCategory(deps: Pick<Deps, 'store' | 'bus'>, goal: Goal): Promise<void> {
  deps.bus.toPerson(goal.ownerId, { type: 'goal', goal });
  await Promise.all(goal.workerIds.map(async id => {
    const agent = await deps.store.getAgent(id);
    if (agent) deps.bus.toPerson(goal.ownerId, { type: 'agent', agent });
  }));
}

/** Pagination covers both groups; each worker is emitted exactly once. */
export function categoryGroups<T extends { id: string; category?: GoalCategory }>(items: T[]) {
  const system = items.filter(item => item.category === 'upkeep');
  return { items: items.filter(item => item.category !== 'upkeep'), system: { label: 'System', count: system.length, items: system } };
}
