import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../shared/contract.js';
import { agentStatus, agentTree, agentTreeContains, goalLine, statusText, waitingCount } from './AgentTree.js';
const agent = (id: string, parentAgentId: string | null, state: AgentInfo['state'], archived = false, wakes: AgentInfo['wakes'] = []): AgentInfo => ({ id, name:id, kind:'agent', ownerId:'human', role:parentAgentId ? 'worker':'manager', conversationId:`chat-${id}`, goalId:null, state, archived, parentAgentId, model:'test', createdAt:1, updatedAt:1, lastReport:null, wakes });
const ids = (nodes: ReturnType<typeof agentTree>) => { const out: string[] = []; const walk = (node: ReturnType<typeof agentTree>[number]) => { out.push(node.agent.id); node.children.forEach(walk); }; nodes.forEach(walk); return out; };
describe('agent lineage navigation', () => {
  it('shows every unarchived agent under its launcher, whether running, waiting on a wake or idle', () => {
    const nodes = agentTree([agent('manager',null,'idle'),agent('running','manager','running'),agent('waiting','manager','idle',false,[{at:2,on:null,since:1,goalId:null}]),agent('idle','manager','idle'),agent('call','idle','idle'),agent('done','manager','stopped',true)], false);
    expect(nodes.map(node=>node.agent.id)).toEqual(['manager']);
    expect(nodes[0]!.context).toBe(false);
    expect(nodes[0]!.children.map(node=>node.agent.id)).toEqual(['running','waiting','idle']);
    expect(nodes[0]!.children[2]!.children.map(node=>node.agent.id)).toEqual(['call']);
  });
  it('keeps an archived launcher as context for an active descendant and hides unrelated archived runs', () => {
    const nodes = agentTree([agent('manager',null,'idle'),agent('child','manager','stopped',true),agent('grandchild','child','running'),agent('old',null,'stopped',true)], false);
    expect(ids(nodes)).toEqual(['manager','child','grandchild']);
    expect(nodes[0]!.children[0]!.context).toBe(true);
    expect(agentTreeContains(nodes, 'chat-old')).toBe(false);
  });
  it('shows a waiting worker as a warning with how long it has waited, and a manager as holding its triggers', () => {
    const now = 3 * 3600_000, wake = [{ at: now + 600_000, on: 'event' as const, since: now - 2 * 3600_000, goalId: null }];
    const agents = [agent('manager',null,'idle',false,[{ at: null, on: 'mail', since: 0, goalId: 'g' }]),agent('waiting','manager','idle',false,wake),agent('running','manager','running')];
    const nodes = agentTree(agents, false);
    expect(ids(nodes)).toEqual(['manager','running','waiting']);
    expect(statusText(agentStatus(agents[1]!), undefined, now)).toMatch(/^Waiting 2h for an event until/);
    expect(agentStatus(agents[0]!)).toEqual({ kind: 'holding', count: 1 });
    expect(waitingCount(agents)).toBe(1);
  });
  it('makes archived runs discoverable only when requested', () => {
    const agents = [agent('manager',null,'idle'),agent('finished','manager','stopped',true)];
    expect(ids(agentTree(agents,false))).toEqual(['manager']);
    expect(agentTree(agents,true)[0]!.children[0]!.agent.id).toBe('finished');
  });
  it('says what a waiting agent is waiting for', () => {
    const at = new Date(2026, 9, 18, 15, 0).getTime(), now = new Date(2026, 9, 18, 9, 0).getTime();
    expect(statusText(agentStatus(agent('w','m','idle',false,[{at:null,on:'mail',since:now,goalId:null},{at,on:'text',since:now,goalId:null}])), undefined, now)).toMatch(/^Waiting for mail or a text until \d/);
    expect(statusText(agentStatus(agent('w','m','idle',false,[{at:null,on:'signal',since:now,goalId:null}])), undefined, now)).toBe('Waiting for Signal');
  });
  it('drops a goal title prefix that only repeats the agent name', () => {
    expect(goalLine('Android GPU engines', 'Android GPU engines: Vulkan + OpenCL')).toBe('Vulkan + OpenCL');
    expect(goalLine('Release', 'Ship the release')).toBe('Ship the release');
  });
  it('keeps orphans and malformed cycles reachable without recursive loops', () => {
    const nodes = agentTree([agent('orphan','missing','running'),agent('a','b','running'),agent('b','a','running')],false);
    expect(ids(nodes).sort()).toEqual(['a','b','orphan']);
  });
});
