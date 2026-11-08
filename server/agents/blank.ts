// Blank chats (Alice, 2026-11-01: "a temporary chat that I can close. It has no context except for just access to the file
// system and I can choose what model to spin it off as… I want to see what a no-priors model thinks about some stuff").
// A blank chat is an agent with role `blank`: its own conversation with the person, the model and thinking level she picked,
// a one-line neutral system prompt and only the file and shell tools. It gets no context files, no extension tools or notes,
// no goals, workers, wakes, messaging or sending, no clock line naming "the person you work for" and no chat context lines.
// It is never a worker: heartbeats, the ask tracker, workers list/find/message and the agent tree leave it out. Closing it
// archives it (PATCH /api/agents/:id). Its tools run as the person, like every agent's.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentInfo, BlankModel, ConversationSummary } from '../../shared/contract.js';
import type { PersonConfig } from '../config.js';
import type { Deps } from '../types.js';
import { assertPersonModel } from './worker-quota.js';
import { admitModel, admitProviderAvailability, routeChoices, type RouteChoice, type RouteRefusal } from './model-route.js';

/** The whole system prompt a blank chat's model gets after the provider's own identity line. */
export const BLANK_PROMPT = 'You can read and write files and run shell commands on this computer with your tools.';

export class BlankRefused extends Error {
  constructor(readonly code: RouteRefusal['code'], message: string) { super(message); }
}

/** The route's current choices, filtered by the person's model budget. */
async function choices(deps: Pick<Deps, 'config'>, person: PersonConfig): Promise<RouteChoice[]> {
  const route = await routeChoices(deps.config.modelsPath, deps.config.allowedProviders, person);
  if (!route.ok) throw new BlankRefused(route.error.code, route.error.message);
  return route.value.filter(c => person.budget?.claude !== false || !c.model.startsWith('claude-'));
}
async function catalogName(deps: Pick<Deps, 'config'>, choice: RouteChoice): Promise<string> {
  const source = JSON.parse(await readFile(deps.config.modelsPath, 'utf8'));
  const models: { id: string; name?: string }[] = (source.catalog?.providers ?? source.providers)?.[choice.provider]?.models ?? [];
  return models.find(m => m.id === choice.model)?.name ?? choice.model;
}

/** Every model and thinking level a blank chat can start with right now, named as the catalog names them. */
export async function blankModels(deps: Pick<Deps, 'config'>, person: PersonConfig): Promise<BlankModel[]> {
  return Promise.all((await choices(deps, person)).map(async c => ({ model: c.model, name: await catalogName(deps, c), thinking: c.thinking })));
}

/** A new blank chat on the model and thinking level asked for, admitted only as the subscription route serves them. */
export async function startBlankChat(deps: Pick<Deps, 'config' | 'store' | 'bus'>, person: PersonConfig, model: string, thinking: string): Promise<{ agent: AgentInfo; conversation: ConversationSummary }> {
  assertPersonModel(person, model);
  const admitted = admitModel(await choices(deps, person), model, thinking);
  if (!admitted.ok) throw new BlankRefused(admitted.error.code, admitted.error.message);
  const availability = await admitProviderAvailability(admitted.value, person);
  if (!availability.ok) throw new BlankRefused(availability.error.code, availability.error.message);
  const name = await catalogName(deps, admitted.value);
  const id = randomUUID();
  const agent = await deps.store.createAgent({
    id, name: `Blank chat · ${name}`, ownerId: person.id, parentAgentId: null, role: 'blank', goalId: null, model, thinking: admitted.value.level,
    sessionPath: join(deps.config.dataDir, 'sessions', `${id}.jsonl`), originConversationId: null, conversationTitle: `🧪 ${name} · ${admitted.value.level}`,
  });
  const conversation = (await deps.store.getConversation(agent.conversationId, person.id))!;
  deps.bus.toPerson(person.id, { type: 'agent', agent });
  deps.bus.toPerson(person.id, { type: 'conversation', conversation });
  return { agent, conversation };
}
