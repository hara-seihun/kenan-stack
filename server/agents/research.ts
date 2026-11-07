// Research workers (Alice, 2026-10-27: research runs on GPT; 2026-11-02 12:58 PT: every agent launched for her runs as her,
// "There should be no permission differences"). A worker on a research-only provider (config researchOnlyProviders), and
// every sub-agent of one, is a research worker. What sets it apart is only its model routing and its brief:
// - its default is the person's research profile (people[].research.worker: GPT, RESEARCH.md in its context);
//   workers choose any served model and thinking level for their sub-agents;
// - it starts with the core worker tools and adds any other with its tools tool, like every worker (tool-scope.ts);
// - its shell and file tools run as the person, exactly like Kenaznia's and every other worker's.
import { readFile } from 'node:fs/promises';
import { agentConfigDir } from './tool-scope.js';
import { join } from 'node:path';
import type { AgentInfo } from '../../shared/contract.js';
import type { Deps } from '../types.js';
import type { PersonConfig, ResearchConfig, ServerConfig } from '../config.js';

/** What a worker is for, which the manager says at spawn where the person has research workers. */
export type Work = 'research' | 'product';
/** What a spawn asks for: a model with its thinking, or thinking alone for the default model of that kind of spawn. */
export type SpawnRequest = { model?: string; thinking?: string };
export const RESEARCH_SCRATCH = '/var/tmp/kenan-research';

export class ResearchProfileMissing extends Error {
  readonly code = 'research_profile_missing';
  constructor(readonly personId: string) { super(`research_profile_missing: ${personId} has no people[].research in this channel's config, so research workers can't run for them; nothing was launched`); }
}
export function researchOf(person: PersonConfig): ResearchConfig {
  if (!person.research) throw new ResearchProfileMissing(person.id);
  return person.research;
}

export function researchPrompt(person: PersonConfig): string {
  return `You are a worker. Follow your assigned brief for research or product work and report the result. Research work includes derivations, measurements, experiments and the code they need. Product work includes Kenan Stack, lifecycle software, deploys, operations and messages. Your shell and file tools run as ${person.unixUser}, like every one of ${person.name}'s agents, with the same permissions; you start with the core tools and add any other (mail, Signal, the browser, notify, peer…) with the tools tool. Edit research directly in the live ResearchCo tree at ${person.home}/alice/ResearchCo. Use a private checkout of only the necessary paths when concurrent edits would disturb a build; fold the result back into the live tree when done. Coordinate findings, questions and overlapping work through workers message; use workers find to locate the right agent and workers message to a goal or subtree when several agents need the same fact. Run scratch goes in ${RESEARCH_SCRATCH}/<name>; kenan-bg and gpurun work as for every agent (Daytona, within the daily cap). Helpers (swarm sub-agents) should usually be Terra (GPT) or Haiku (Claude), but choose what the task needs. For any worker you launch or dispatch, choose the model that fits the task from the models and thinking levels the host serves; you can message any agent on the host to coordinate (workers message id; workers find lists them by goal, name or parent): other research workers and their sub-agents, your supervisor and other managers. Do product work yourself when it belongs to your task. When a separate lifecycle fix needs its own owner, first look for an active worker (workers find); message that worker, or dispatch with work "product" and a plain brief. Research workers do product work too, and may choose Claude or any other served model for separate work. Coordinate rentals, shared files and IDs with the research workers involved directly, and bring your parent results and decisions, not progress. Write every note, message and report, and every dispatch brief, as a person would: normal spacing between words, full sentences, plain English with no invented compound nouns or house metaphors (AGENTS.md, "No Claudish"). Short is good, and so is a few clear lines; lead with the result.`;
}

/** Models served by the channel's research-only providers, from the shared catalog. */
export async function researchModels(config: Pick<ServerConfig, 'modelsPath' | 'researchOnlyProviders'>): Promise<ReadonlySet<string>> {
  const only = config.researchOnlyProviders ?? [];
  if (!only.length) return new Set();
  const catalog = JSON.parse(await readFile(config.modelsPath, 'utf8'));
  const providers = catalog.catalog?.providers ?? catalog.providers;
  return new Set(only.flatMap(p => (providers?.[p]?.models ?? []).map((m: { id: string }) => m.id)));
}
/** A research agent: a worker on a research-only model, or a sub-agent of one (the same rule session() applies). */
export async function isResearchAgent(deps: Pick<Deps, 'config' | 'store'>, agent: AgentInfo): Promise<boolean> {
  if (agent.role !== 'worker') return false;
  if ((await readFile(join(agentConfigDir(deps.config.dataDir, agent.id), 'work'), 'utf8').catch(() => '')) === 'research') return true;
  const models = await researchModels(deps.config);
  if (models.has(agent.model)) return true;
  const parent = agent.parentAgentId ? await deps.store.getAgent(agent.parentAgentId) : null;
  return parent !== null && parent.role === 'worker' && (models.has(parent.model) || parent.model === 'stealth/crouton-alpha' && (await readFile(join(agentConfigDir(deps.config.dataDir, parent.id), 'work'), 'utf8').catch(() => '')) === 'research');
}
