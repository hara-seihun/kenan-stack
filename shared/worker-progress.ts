import type { AgentInfo, AgentWake } from './contract.js';
import { subAgentActive, workerDescendants } from './swarm.js';

export type WorkerProgress = { kind: 'coordinating'; helpers: number } | { kind: 'job'; names: string[] };

/** Run state stays idle: these labels describe work continuing between model calls. */
export function workerProgress(agent: AgentInfo, agents: AgentInfo[]): WorkerProgress | null {
  if (agent.role !== 'worker' || agent.state !== 'idle' || !subAgentActive(agent)) return null;
  const jobs = agent.runningJobs ?? [];
  const matchingJobs = (wake: AgentWake) => {
    if (wake.goalId !== null || wake.on !== 'event' || !wake.event) return [];
    const event = wake.event;
    return jobs.filter(job => {
      const normalize = (topic: string) => job.kind === 'gpurun' ? topic.replace(/^gpurun-done:/, 'gpurun:') : topic;
      const topic = normalize(job.topic), requested = normalize(event.topic);
      const namespace = `${job.kind === 'gpurun' ? 'gpurun' : 'job'}:${agent.id}:`;
      // A wildcard must still name this owner's job namespace, not an outside event stream.
      return topic.startsWith(namespace) && requested.startsWith(namespace)
        && (event.prefix ? topic.startsWith(requested) : topic === requested);
    });
  };
  const helpers = (workerDescendants(agents).get(agent.id) ?? []).filter(helper => subAgentActive(helper) && helper.state !== 'error' && helper.state !== 'interrupted').length;
  if (helpers && agent.wakes.every(wake => wake.goalId === null && (wake.on === 'any' || matchingJobs(wake).length > 0))) return { kind: 'coordinating', helpers };
  if (!agent.wakes.length || !agent.wakes.every(wake => matchingJobs(wake).length > 0)) return null;
  return { kind: 'job', names: [...new Set(agent.wakes.flatMap(wake => matchingJobs(wake).map(job => job.name)))] };
}

export function progressText(progress: WorkerProgress): string {
  return progress.kind === 'coordinating'
    ? `coordinating ${progress.helpers} ${progress.helpers === 1 ? 'helper' : 'helpers'}`
    : `running job ${progress.names.join(', ')}`;
}
