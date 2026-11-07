// What our own agents did on outside services in the last half hour, for the message watcher (2026-11-02: it flagged
// our agents' own sign-in codes, "password changed", "new sign-in" and "signup denied" mail from AWS, Google, Hetzner and
// Mercury as possible attacks, because it could not see that a worker was signing in there at that moment).
// Every tool call is read as it starts; only the services it names are kept (sites opened, vault items filled, mail and
// code waits, hosts in shell commands), per agent, in memory for ACTIVITY_WINDOW_MS. A restart forgets it: the window
// is short, and the guide still says which accounts are ours.

export const ACTIVITY_WINDOW_MS = 30 * 60_000;
const PER_AGENT = 12;
const AGENTS_SHOWN = 25;
const TOKEN_CHARS = 80;

interface Seen { at: number; what: string }
interface AgentActivity { name: string; seen: Seen[] }
const byPerson = new Map<string, Map<string, AgentActivity>>();

const clip = (text: string) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > TOKEN_CHARS ? `${flat.slice(0, TOKEN_CHARS - 1)}…` : flat; };
const str = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const hostOf = (url: string) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; } };

/** Hosts, vault items, CLIs and code waits a shell command names; local addresses and plain file work name nothing. */
export function shellServices(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(/https?:\/\/[^\s'"`)<>]+/g)) { const host = hostOf(m[0]); if (host && !/^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(host)) out.add(host); }
  for (const m of command.matchAll(/--item(?:-title)?[ =](?:"([^"]+)"|'([^']+)'|(\S+))/g)) out.add(`vault item "${m[1] ?? m[2] ?? m[3]}"`);
  for (const m of command.matchAll(/PROTON_PASS_AGENT_REASON=(?:"([^"]+)"|'([^']+)')/g)) out.add(`vault: ${m[1] ?? m[2]}`);
  for (const m of command.matchAll(/\bverification-code\b([^|;&<>\n]*)/g)) { const how = clip(m[1]!.replace(/\s\d*$/, '')); out.add(`waits for a verification code${how ? ` (${how})` : ''}`); }
  for (const m of command.matchAll(/\bPAGE=(\S+)/g)) out.add(m[1]!);
  for (const m of command.matchAll(/(?:^|[\s;&|(])(aws|gcloud|gsutil|hcloud|az|doctl|oci|flyctl|vercel|stripe|cloud-browser)\s/g)) out.add(`${m[1]} CLI`);
  return [...out].map(clip);
}

/** The services one tool call names, or none. */
export function servicesOf(tool: string, args: unknown): string[] {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  switch (tool) {
    case 'bash': return str(a.command) ? shellServices(a.command as string) : [];
    case 'browser': {
      const action = str(a.action), url = str(a.url), argv = Array.isArray(a.args) ? a.args.filter((x): x is string => typeof x === 'string') : [];
      if (action === 'open' && url) { const host = hostOf(url); return host ? [`browser on ${host}`] : []; }
      if (action === 'start') return [`cloud browser${str(a.profile) ? ` (profile ${a.profile})` : ''}`];
      const item = argv.indexOf('--item');
      if (argv[0] === 'auth' && item >= 0 && argv[item + 1]) return [clip(`browser login with vault item "${argv[item + 1]}"`)];
      if (argv[0] === 'open' && argv[1]) { const host = hostOf(argv[1]); return host ? [`browser on ${host}`] : []; }
      return [];
    }
    case 'mail': {
      const action = str(a.action);
      if (action !== 'wait' && action !== 'search') return [];
      const criteria = str(a.criteria);
      return [clip(`mail ${action}${str(a.folder) ? ` in ${a.folder}` : ''}${criteria ? ` ${criteria}` : ''}`)];
    }
    case 'inbox': return str(a.action) === 'wait' ? [clip(`waits for a ${str(a.source) ?? 'message'}${str(a.query) ? ` matching "${a.query}"` : ''}`)] : [];
    default: return [];
  }
}

/** Records a tool call as it starts; calls that name no outside service are ignored. */
export function noteToolCall(personId: string, agent: { id: string; name: string }, tool: string, args: unknown, now: number): void {
  const what = servicesOf(tool, args);
  if (!what.length) return;
  const agents = byPerson.get(personId) ?? new Map<string, AgentActivity>();
  byPerson.set(personId, agents);
  const entry = agents.get(agent.id) ?? { name: agent.name, seen: [] };
  agents.set(agent.id, entry);
  for (const item of what) { entry.seen = entry.seen.filter(s => s.what !== item); entry.seen.push({ at: now, what: item }); }
  if (entry.seen.length > PER_AGENT) entry.seen.splice(0, entry.seen.length - PER_AGENT);
}

/** One line per agent active on outside services in the window, newest first; older entries are dropped. */
export function recentServiceActivity(personId: string, now: number): string[] {
  const agents = byPerson.get(personId);
  if (!agents) return [];
  const since = now - ACTIVITY_WINDOW_MS;
  const lines: { at: number; line: string }[] = [];
  for (const [id, entry] of agents) {
    entry.seen = entry.seen.filter(s => s.at >= since);
    if (!entry.seen.length) { agents.delete(id); continue; }
    const last = Math.max(...entry.seen.map(s => s.at));
    lines.push({ at: last, line: `- ${entry.name}, last ${Math.max(0, Math.round((now - last) / 60_000))} min ago: ${entry.seen.map(s => s.what).join('; ')}` });
  }
  return lines.sort((x, y) => y.at - x.at).slice(0, AGENTS_SHOWN).map(l => l.line);
}

/** Test hook: forgets everything recorded. */
export function forgetServiceActivity(): void { byPerson.clear(); }
