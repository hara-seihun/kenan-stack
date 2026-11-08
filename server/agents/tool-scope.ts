// Which tools a worker declares to its model. Kenaznia (the manager) declares every tool it has. A worker
// declares the core tools below plus the optional ones its goal needs: the personal and channel tools (send, peer,
// notify and every extension tool but the browser: mail, Signal, Discord, texts, voice, calendar, rooms, to-dos, phone
// settings…) cost about 15,000 tokens a turn and most workers never call them (instruction audit, 2026-10-29).
//
// The grant is chosen at spawn (the spawn's `tools`, plus names the brief and the goal make likely) and kept in the
// worker's agent-config folder; the worker adds more itself with the `tools` tool, which declares them from its next
// model call on. Every worker starts with the same core tools.
import { Type } from 'typebox';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KenanTool } from '../types.js';

/** Tools every worker declares. */
export const CORE_WORKER_TOOLS: ReadonlySet<string> = new Set(['bash', 'read', 'write', 'edit', 'web_search', 'report', 'goals', 'workers', 'wake', 'usage', 'attach', 'browser', 'tools']);

/** Names a spawn may give for several tools at once. */
export const TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  messaging: ['send', 'mail', 'signal', 'discord', 'inbox', 'channels', 'peer'],
  personal: ['calendar', 'todos', 'rooms', 'phone_settings', 'phone', 'voice', 'notify'],
};
export const ALL_TOOLS = 'all';
/** Words in a brief or goal that make an optional tool likely. A miss costs the worker one `tools` call; a false hit costs its tokens. */
const HINTS: readonly [string, RegExp][] = [
  ['mail', /\b(e-?mail|mails?|inbox|imap|mailbox)\b/i],
  ['send', /\b(e-?mail|send (it|them|her|him|a|an|the) |reply to|post (it |a |the )?(to|in|on)|discord|signal|message (him|her|them|the|a)\b)/i],
  ['calendar', /\b(calendar|appointments?|reschedul\w*)\b/i],
  ['inbox', /\b(sms|text messages?|texts? (from|to)|verification code|sign-in code|one-time code|otp|2fa|inbox)\b/i],
  ['signal', /\bsignal (chat|group|message|messages|history|contact)s?\b|\bon signal\b|\bher signal\b/i],
  ['discord', /\bdiscord\b/i],
  ['voice', /\b(phone call|call (him|her|them|the|a|an)\b|place a call|voicemail|dial)\b/i],
  ['phone_settings', /\b(phone settings|wireless debugging|adb|her phone|android settings|bloat)\b/i],
  ['phone', /\b(her phone's screen|on her phone|phone screen)\b/i],
  ['rooms', /\b(rooms?|rename (the|her) chat)\b/i],
  ['todos', /\b(to-?dos?|to-do list|shopping list|to buy list|groceries)\b/i],
  ['channels', /\b(channel (mode|settings?)|watcher|incoming messages)\b/i],
  ['peer', /\b(peer|acme's kenaznia|carol's kenaznia|do[gğ]a's kenaznia|their kenaznia|other kenaznia)\b/i],
  ['notify', /\b(notify (her|alice)|notification to her|push (a )?notification|alert her|ring her)\b/i],
  ['meeting', /\b(meetings?|notetaker|google meet|zoom)\b/i],
];

/** Tools that changed name: a grant or a spawn that still says the old name gets the new one. */
const RENAMED_TOOLS: Readonly<Record<string, string>> = { texts: 'inbox' };
const renamed = (name: string) => RENAMED_TOOLS[name] ?? name;

/** Expands group names and drops unknown words; `all` stays as itself. */
export function expandTools(names: readonly string[]): string[] {
  return [...new Set(names.flatMap(name => {
    const key = name.trim().toLowerCase();
    return key === ALL_TOOLS ? [ALL_TOOLS] : TOOL_GROUPS[key] ?? [renamed(key)];
  }).filter(Boolean))];
}

/** The optional tools a new worker starts with: the spawn's explicit names plus what its brief and goal mention. */
export function chooseTools(texts: readonly string[], explicit: readonly string[] = []): string[] {
  const text = texts.join('\n');
  return [...new Set([...expandTools(explicit), ...HINTS.filter(([, hint]) => hint.test(text)).map(([name]) => name)])].sort();
}

export const agentConfigDir = (dataDir: string, id: string) => join(dataDir, 'agent-config', id.replaceAll(':', '-'));
const grantPath = (dir: string) => join(dir, 'tools.json');

/** The worker's optional-tool grant, or null for a worker spawned before grants existed (it declares every tool). */
export async function readGrant(dir: string): Promise<string[] | null> {
  const text = await readFile(grantPath(dir), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
  if (text === null) return null;
  const value = JSON.parse(text) as { tools?: unknown };
  if (!Array.isArray(value.tools) || value.tools.some(t => typeof t !== 'string')) throw new Error(`tool_grant_invalid: ${grantPath(dir)} must be {"tools": [names]}`);
  return (value.tools as string[]).map(renamed);
}
export async function writeGrant(dir: string, tools: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = grantPath(dir), temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ tools: [...new Set(tools)].sort() })}\n`);
  await rename(temporary, path);
}

/** Adds names to a worker's grant; a worker with no grant keeps every tool. */
export async function extendGrant(dir: string, names: readonly string[]): Promise<void> {
  await writeGrant(dir, [...(await readGrant(dir) ?? [ALL_TOOLS]), ...names]);
}

/** Which of these tools a worker with this grant declares. */
export function declared(tools: readonly KenanTool[], grant: readonly string[] | null): KenanTool[] {
  if (grant === null || grant.includes(ALL_TOOLS)) return [...tools];
  const granted = new Set(grant);
  return tools.filter(t => CORE_WORKER_TOOLS.has(t.name) || granted.has(t.name));
}

/** The first sentence of a tool's description, for the list of tools a worker can add. */
export const summaryOf = (tool: KenanTool) => (tool.description ?? '').split(/(?<=[.!?])\s/)[0]!.slice(0, 140);

export interface ToolsToolOptions {
  /** Every tool the worker could declare, core ones included. */
  all: () => readonly KenanTool[];
  /** Names declared now. */
  active: () => readonly string[];
  /** Declare these names from the next model call on and keep them across restarts. */
  activate: (names: string[]) => Promise<void>;
  /** The prompt note that comes with a tool's extension, if any. */
  noteFor: (name: string) => string | undefined;
}

/** The worker's way to add tools it wasn't given at spawn. */
export function toolsTool(options: ToolsToolOptions): KenanTool {
  const available = () => { const active = new Set(options.active()); return options.all().filter(t => !active.has(t.name)); };
  const groups = Object.entries(TOOL_GROUPS).map(([name, members]) => `${name} (${members.join(', ')})`).join('; ');
  return {
    name: 'tools', files: 'none', records: 'none', label: 'Tools',
    description: `Add tools you weren't given at spawn. Your core tools are always here; the personal and channel tools (send, peer, notify, mail, signal, discord, texts, voice, calendar, rooms, todos, phone_settings, channels…) are added on request. action "list" names the ones you can add, each with a one-line summary; action "add" with names (tool names, groups ${groups}, or "all") declares them from your next step on.`,
    parameters: Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('add')]), names: Type.Optional(Type.Array(Type.String())) }),
    execute: async (_id, args: { action: 'list' | 'add'; names?: string[] }) => {
      const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });
      if (args.action === 'list') return text({ available: available().map(t => ({ name: t.name, summary: summaryOf(t) })) });
      const wanted = expandTools(args.names ?? []);
      if (!wanted.length) throw new Error('names_required: give the tool names (or a group, or "all") to add');
      const pool = available();
      const adding = wanted.includes(ALL_TOOLS) ? pool : pool.filter(t => wanted.includes(t.name));
      const known = new Set(options.all().map(t => t.name));
      const unknown = wanted.filter(name => name !== ALL_TOOLS && !known.has(name) && !Object.hasOwn(TOOL_GROUPS, name));
      if (!adding.length) return text(unknown.length ? `tool_not_available: ${unknown.join(', ')}; action "list" names the tools you can add` : 'already_declared: you have these tools already');
      await options.activate(adding.map(t => t.name));
      const notes = adding.flatMap(t => { const note = options.noteFor(t.name); return note ? [note] : []; });
      return text(`Added ${adding.map(t => t.name).join(', ')}: callable from your next step.${unknown.length ? ` Not available here: ${unknown.join(', ')}.` : ''}${notes.length ? `\n\nNotes for them:\n${notes.join('\n')}` : ''}`);
    },
  };
}
