import { pageParameters } from './pagination.js';
import { readFile } from 'node:fs/promises';
import { Type } from 'typebox';
import type { AgentInfo, Goal } from '../../shared/contract.js';
import type { KenanTool, NotesChange, ToolContext, Wake } from '../types.js';
import { usageReport } from '../metrics/usage.js';
import { swarmCounts, swarmsOf } from '../../shared/swarm.js';
import { notify } from '../notifications.js';
import { waitingLine, wakeSummary } from '../agents/wakes.js';
import { PEEK_MAX_WORKERS, peekWorkers, resolveWorker } from './peek.js';
import { liveCallOf } from '../extensions/phone.js';
import { getMimeType } from 'hono/utils/mime';
import { attachErrorText, ATTACH_LIMITS, filePart, storeOwnerFiles } from '../files/files.js';

/** Pictures the Android notification can decode (no SVG). */
const PHONE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

export interface Controls {
  spawnWorker(ownerId: string, goalId: string, name: string, task: string, parentAgentId?: string, profile?: {model:string;thinking:string}): Promise<AgentInfo>;
  messageWorker(id: string, text: string, fromId?: string): Promise<MessageOutcome>;
  stopAgent(id: string): Promise<void>;
  archiveAgent(id: string, archived: boolean): Promise<AgentInfo>;
}
export type MessageOutcome = { delivered: true } | { delivered: false; error: 'recipient_archived'; agent: AgentInfo };
const parentOf = ({ deps, person, agent }: ToolContext) => agent.parentAgentId ?? deps.runtime.managerFor(person.id);
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });
export function controlTools(ctx: ToolContext, controls: Controls): KenanTool[] {
  const { deps, person, agent } = ctx;
  const swarmsOfPerson = async () => swarmsOf(await deps.store.listAgents(person.id, { includeArchived: true }));
  /** A worker waiting on its own wakes is a warning sign, so every list says so. */
  const warningOf = (worker: AgentInfo, wakes: Wake[]) => { const line = waitingLine(worker, wakes, deps.now()); return line ? { warning: line } : {}; };
  /** A coordinator's entry carries its swarm's counts; its sub-agents are listed with workers list parent=<id>. */
  const swarmOf = (swarms: Map<string, AgentInfo[]>, id: string) => { const children = swarms.get(id); return children ? { swarm: swarmCounts(children) } : {}; };
  const tools: KenanTool[] = [{
    name: 'web_search', files: 'none', label: 'Web search', description: 'Search the web for current information and sources.',
    parameters: Type.Object({ query: Type.String() }),
    execute: async (_id, args: any, signal) => {
      if (!deps.config.parallelApiKeyPath) throw new Error('Web search credential is not configured');
      const rawKey = (await readFile(deps.config.parallelApiKeyPath, 'utf8')).trim();
      const key = rawKey.startsWith('{') ? JSON.parse(rawKey).apiKey : rawKey;
      if (!key) throw new Error('Web search credential is empty');
      const response = await fetch('https://api.parallel.ai/v1beta/search', { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ objective: args.query, search_queries: [args.query], max_results: 6 }) });
      if (!response.ok) throw new Error(`Web search HTTP ${response.status}`);
      return result(await response.json());
    },
  }, {
    name: 'report', files: 'none', label: 'Report', description: 'Report completion or a block once. Workers report to the agent that launched them. A completed worker is archived when its turn ends; blocked workers stay available. Managers remain available until explicitly archived.',
    parameters: Type.Object({ status: Type.Union([Type.Literal('done'), Type.Literal('blocked')]), text: Type.String() }),
    execute: async (_id, args: any) => {
      const call = liveCallOf(agent.id);
      if (call) throw new Error(`call_live: you are the call agent for call session ${call.id}, which is still live. Keep answering its requests and end your turn between them; report once the call has ended and you have its transcript.`);
      const updated = await deps.store.updateAgent(agent.id, { lastReport: { status: args.status, text: args.text, at: deps.now() } });
      deps.bus.toPerson(person.id, { type: 'agent', agent: updated });
      const manager = parentOf(ctx);
      if (agent.role === 'worker' && manager) {
        const info = await deps.store.getAgent(manager);
        if (info) deps.runtime.deliver({ agentId: manager, kind: 'report', fromId: agent.id, conversationId: info.conversationId, text: `Worker ${agent.name} (${agent.id}), goal ${agent.goalId}, reports ${args.status}:\n${args.text}` });
      } else {
        const message = await deps.store.appendMessage({ conversationId: agent.conversationId, authorId: agent.id, role: 'notice', notice: 'report', text: args.text });
        deps.bus.toConversation(agent.conversationId, { type: 'message', message });
      }
      return result('Report delivered.');
    },
  }];
  /** A worker's mid-task note: shown in the parent's conversation and joined to its current turn; the worker keeps running. */
  const noteToParent = async (parentId: string, text: string) => {
    const parent = await deps.store.getAgent(parentId);
    if (!parent || parent.ownerId !== person.id) throw new Error(`Parent ${parentId} not found`);
    const message = await deps.store.appendMessage({ conversationId: parent.conversationId, authorId: agent.id, role: 'notice', notice: 'worker_note', text: `Note from worker ${agent.name}: ${text}` });
    deps.bus.toConversation(parent.conversationId, { type: 'message', message });
    deps.runtime.deliver({ agentId: parentId, kind: 'note', fromId: agent.id, conversationId: parent.conversationId, text: `Worker ${agent.name} (${agent.id}), goal ${agent.goalId}, sends a note mid-task and is still running. Reply with workers message id ${agent.id}.\n${text}` });
  };
  // Goals are named by their first 8 characters in chat and notes, so a unique id prefix of at least 8 characters selects one.
  const goalByRef = async (ref: unknown): Promise<Goal> => {
    if (typeof ref !== 'string' || !ref) throw new Error('id is required');
    const exact = await deps.store.getGoal(person.id, ref);
    if (exact) return exact;
    const matches = ref.length >= 8 && /^[0-9a-f-]+$/i.test(ref) ? (await deps.store.listGoals(person.id)).filter(goal => goal.id.startsWith(ref.toLowerCase())) : [];
    if (matches.length > 1) throw new Error(`Goal id prefix ${ref} is ambiguous: ${matches.map(goal => goal.id).join(', ')}`);
    if (!matches[0]) throw new Error('Goal not found');
    return matches[0];
  };
  tools.push({
    name: 'goals', files: 'none', label: 'Goals', description: 'List, get, create or update goals. Lists return {items,nextCursor}, 20 per page (max 50), open goals by priority first, with detail and notes cut to 500 characters (truncated: true); get returns one goal by id in full, with its worker ids, the triggers held for it (with handoffs) and its waiting workers. Use status=all for history; repeat cursor with the same filters. Notes are a dated log, newest first: update with appendNote adds one entry at the top, stamped with the time (YYYY-MM-DD HH:MMZ — …) unless it starts with one; handoffs land there the same way. notes replaces the whole notes field, history and handoffs included, and needs replaceNotes: true.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('get'), Type.Literal('create'), Type.Literal('update')]), id: Type.Optional(Type.String()), title: Type.Optional(Type.String()), detail: Type.Optional(Type.String()), priority: Type.Optional(Type.Number()), ...pageParameters, status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('dropped'), Type.Literal('all')])), appendNote: Type.Optional(Type.String()), notes: Type.Optional(Type.String()), replaceNotes: Type.Optional(Type.Boolean()) }),
    execute: async (_id, args: any) => {
      if (args.action === 'list') { const page = await deps.store.listGoalsPage(person.id, args); return result({ ...page, items: page.items.map(g => ({ ...g, detail: g.detail.slice(0,500), notes: g.notes.slice(0,500), truncated: g.detail.length > 500 || g.notes.length > 500 })) }); }
      if (args.status === 'all') throw new Error('status=all is only valid for list');
      if (args.action === 'get') {
        const goal = await goalByRef(args.id);
        const [agents, wakes] = await Promise.all([deps.store.listAgents(person.id), deps.store.pendingWakes(person.id)]);
        const held = wakes.filter(w => w.held?.goalId === goal.id).map(w => ({ ...wakeSummary(w), handoff: w.held!.handoff }));
        const waiting = agents.filter(a => a.goalId === goal.id).flatMap(a => { const line = waitingLine(a, wakes, deps.now()); return line ? [{ id: a.id, name: a.name, warning: line }] : []; });
        return result({ ...goal, held, waiting });
      }
      let goal;
      if (args.action === 'create') {
        if (!args.title) throw new Error('title is required');
        goal = await deps.store.createGoal({ ownerId: person.id, title: args.title, detail: args.detail, priority: args.priority });
      } else {
        const target = await goalByRef(args.id);
        if (args.notes !== undefined && args.appendNote !== undefined) throw new Error('notes_conflict: give appendNote (one new entry) or notes with replaceNotes: true (the whole field), not both');
        if (args.notes !== undefined && args.replaceNotes !== true) throw new Error('notes_replace_unconfirmed: notes replaces the goal\'s whole notes, its dated history and handoffs included, and nothing was changed. To log progress, use appendNote: it adds one dated entry at the top. To rewrite everything on purpose, pass the full new notes with replaceNotes: true.');
        const notes: NotesChange | undefined = args.appendNote !== undefined ? { kind: 'prepend', entry: args.appendNote } : args.notes !== undefined ? { kind: 'replace', text: args.notes } : undefined;
        const patch = Object.fromEntries(Object.entries(args).filter(([key, value]) => ['title', 'detail', 'priority', 'status'].includes(key) && value !== undefined));
        goal = await deps.store.updateGoal(target.id, { ...patch, notes });
      }
      deps.bus.toPerson(person.id, { type: 'goal', goal }); return result(goal);
    },
  }, {
    name: 'workers', files: 'none', label: 'Workers', description: `List workers, peek at what they are doing, spawn for an open goal, message, stop, archive or restore runs. message with a worker id reaches that worker\'s current turn (before its next model call) or starts its next turn if it is idle; an archived run refuses messages (recipient_archived) and stays archived. A worker can message its parent, the id that launched it (for example manager:alice), to hand off something urgent mid-task: the note appears in the parent\'s conversation, joins its current turn, and the sender keeps running. Lists return {items,nextCursor}, 20 per page (max 50), active workers (unarchived, not stopped) by default, running first; state narrows it. A worker idle with pending wakes is waiting, which is a warning sign: its entry carries warning ("waiting 2h on …"); a long wait should have been handed off to the manager as a held trigger (wake list shows those). Use includeArchived=true with state=all for history; repeat the same filters with the cursor. A child records you as its parent and reports to you. Archive finished runs, including your own run (omit id), when nothing remains to do. Restore makes a run available without starting it. Each listed worker shows its pending wakes. spawn may pin a worker's model and thinking (both together; the model must be an allowed subscription model, e.g. claude-opus-5-5, claude-haiku-5-5 or claude-fable-5-1, no fallback). A worker spawning for its own goal launches a swarm sub-agent (model and thinking required; swarm_full, swarm_quota_low and swarm_depth are typed refusals). list and peek leave sub-agents out and give their coordinator a swarm count; list with parent=<id> lists that agent's own children. peek shows what workers are doing right now, read from their stored conversations: with id (full or a unique 8+ character prefix), one worker in detail (last 6 messages with words, last 15 tool calls); without id, every active (unarchived, not stopped) worker compactly (last 2 messages, last 5 tool calls), running first, at most ${PEEK_MAX_WORKERS}; waiting workers carry warning. Each shows state, goal, the running turn (ageS, the inputs it answers, queued), live activity, idleS since its last stored activity, pending wakes and last report; tool calls carry short args and the start and end of their results; times are seconds ago; credential-looking text is redacted. An unknown or archived id is a typed error (worker_not_found, worker_archived, worker_id_ambiguous). Never spawn two active workers for one goal.`,
    parameters: Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('spawn'), Type.Literal('message'), Type.Literal('stop'), Type.Literal('archive'), Type.Literal('restore'), Type.Literal('peek')]), id: Type.Optional(Type.String()), goalId: Type.Optional(Type.String()), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), parent: Type.Optional(Type.String()), name: Type.Optional(Type.String()), text: Type.Optional(Type.String()), ...pageParameters, includeArchived: Type.Optional(Type.Boolean()), state: Type.Optional(Type.Union(['active','all','idle','running','stopped','interrupted','error'].map(v => Type.Literal(v)))) }),
    execute: async (_id, args: any) => {
      if (args.action === 'list') {
        const [page, wakes, swarms] = await Promise.all([deps.store.listWorkersPage(person.id, args), deps.store.pendingWakes(person.id), swarmsOfPerson()]);
        return result({ ...page, items: page.items.map(w => ({ ...w, lastReport: w.lastReport && { ...w.lastReport, text: w.lastReport.text.slice(0,500), truncated: w.lastReport.text.length > 500 }, wakes: wakes.filter(wake => wake.agentId === w.id).map(wakeSummary), ...warningOf(w, wakes), ...swarmOf(swarms, w.id) })) });
      }
      if (args.action === 'peek') {
        const workers = (await deps.store.listAgents(person.id, { includeArchived: true })).filter(w => w.role === 'worker');
        const wakes = await deps.store.pendingWakes(person.id);
        if (args.id) { const worker = resolveWorker(workers, args.id); return result({ now: new Date(deps.now()).toISOString(), worker: { ...(await peekWorkers(deps, person.id, [worker], 'detailed'))[0], ...warningOf(worker, wakes) } }); }
        const rank = (w: AgentInfo) => w.state === 'running' ? 0 : 1;
        const swarms = swarmsOf(workers), subAgents = new Set([...swarms.values()].flat().map(w => w.id));
        const active = workers.filter(w => !w.archived && w.state !== 'stopped' && !subAgents.has(w.id)).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
        const shown = await peekWorkers(deps, person.id, active.slice(0, PEEK_MAX_WORKERS), 'compact');
        return result({ now: new Date(deps.now()).toISOString(), workers: shown.map((view, i) => ({ ...view, ...warningOf(active[i]!, wakes), ...swarmOf(swarms, active[i]!.id) })), omitted: Math.max(0, active.length - PEEK_MAX_WORKERS) });
      }
      if (args.action === 'spawn') {
        if (!args.goalId || !args.text) throw new Error('goalId and text are required');
        if(!args.model&&!args.thinking)return result(await controls.spawnWorker(person.id,args.goalId,args.name??'Worker',args.text,agent.id));
        if(!args.model||!args.thinking)throw Error('Explicit worker admission requires both model and thinking');
        return result(await controls.spawnWorker(person.id,args.goalId,args.name??'Worker',args.text,agent.id,{model:args.model,thinking:args.thinking}));
      }
      const targetId = args.id ?? ((args.action === 'archive' || args.action === 'restore') ? agent.id : undefined);
      const parent = agent.role === 'worker' ? parentOf(ctx) : null;
      if (args.action === 'message' && parent && targetId === parent) {
        if (!args.text) throw new Error('text is required');
        await noteToParent(parent, args.text);
        return result(`Note delivered to ${parent}; keep working.`);
      }
      const worker = targetId ? await deps.store.getAgent(targetId) : null;
      if (!worker || worker.ownerId !== person.id || (worker.role !== 'worker' && worker.id !== agent.id)) throw new Error(`Worker ${targetId ?? '(no id)'} not found${parent ? `; to message your parent use id ${parent}` : ''}`);
      if (args.action === 'stop') await controls.stopAgent(worker.id);
      else if (args.action === 'archive' || args.action === 'restore') return result(await controls.archiveAgent(worker.id, args.action === 'archive'));
      else {
        if (!args.text) throw new Error('text is required');
        const sent = await controls.messageWorker(worker.id, args.text, agent.id);
        if (!sent.delivered) throw new Error(`recipient_archived: ${sent.agent.name} (${sent.agent.id}) is archived${sent.agent.lastReport ? ` after reporting ${sent.agent.lastReport.status}` : ''}; the message was not delivered and the run stays archived. Restore it with workers restore id ${sent.agent.id} first only if current work needs that run back.`);
      }
      return result('Done');
    },
  }, {
    name: 'attach', files: 'reads', label: 'Attach', description: `Send files as a chat message from you in your own conversation${agent.role === 'manager' ? ` with ${person.name}` : ` (${person.name} sees it when she opens your run; to put a file in front of her, give your parent the paths and it attaches them)`}. They look exactly like her own attachments: images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP) inline and tappable to full size, any other file as a download chip. paths: 1–${ATTACH_LIMITS.files} files your account can read (absolute, ~/… or relative to your home), each up to ${ATTACH_LIMITS.fileBytes / 1048576} MiB and ${ATTACH_LIMITS.totalBytes / 1048576} MiB together. They are copied when sent, so later edits on disk don't change the message. text: optional words shown with the files (markdown). An unreadable path sends nothing and returns attach_unreadable with the reason for each path.`,
    parameters: Type.Object({ paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: ATTACH_LIMITS.files }), text: Type.Optional(Type.String()) }),
    execute: async (_id, args: any) => {
      const stored = await storeOwnerFiles(deps, deps.placement, person, args.paths);
      if (!stored.ok) throw new Error(attachErrorText(stored.error));
      const message = await deps.store.appendMessage({ conversationId: agent.conversationId, authorId: agent.id, role: 'assistant', display: 'shown', text: args.text ?? '', parts: stored.files.map(filePart) });
      deps.bus.toConversation(agent.conversationId, { type: 'message', message });
      return result({ messageId: message.id, files: stored.files.map(f => ({ name: f.name, mime: f.mime, size: f.size })) });
    },
  }, {
    name: 'notify', files: 'reads', label: 'Notify', description: `Send ${person.name} a notification on her phone through the Kenan app. level "normal" is an ordinary notification. level "urgent" rings on the alarm stream through silent mode and Do Not Disturb: use it sparingly, only for something time-sensitive she must notice now (a delivery at the door, a call about to start, a real emergency), never for routine progress. Keep the title short; the body says what happened and what, if anything, she should do. imagePath (optional): an image file your account can read, shown as the notification's picture. connectedPhones counts Android apps listening right now (one that connects within a day still shows it, silently once it is over ten minutes old); webAppDevices counts installed web apps (an iPhone home-screen app) whose push service accepted it, where urgent is an ordinary notification because iOS gives web apps no alarm stream.`,
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }), body: Type.String({ minLength: 1, maxLength: 2000 }), level: Type.Union([Type.Literal('normal'), Type.Literal('urgent')]), imagePath: Type.Optional(Type.String({ minLength: 1 })) }),
    execute: async (_id, args: any) => {
      let imageFileId: string | null = null;
      if (args.imagePath !== undefined) {
        const mime = getMimeType(args.imagePath);
        if (!mime || !PHONE_IMAGES.has(mime)) throw new Error(`notify_image_not_image: ${args.imagePath} is ${mime ?? 'of unknown type'}; imagePath takes a .png, .jpg, .gif, .webp or .bmp file`);
        const stored = await storeOwnerFiles(deps, deps.placement, person, [args.imagePath]);
        if (!stored.ok) throw new Error(attachErrorText(stored.error));
        imageFileId = stored.files[0]!.id;
      }
      return result(await notify(deps, person.id, agent, { title: args.title, body: args.body, level: args.level, imageFileId }));
    },
  }, { name: 'usage', files: 'none', label: 'Usage', description: 'Read subscription quota, drain rate, projected exhaustion and spend.', parameters: Type.Object({}), execute: async () => result(await usageReport(deps, person.id)) });
  return tools;
}
