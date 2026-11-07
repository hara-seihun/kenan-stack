/**
 * Standing component owners (Alice, 2026-10-30: "we have a fuck ton of agents stepping over each other trying to fix
 * gpurun… when agents spawn root agents they have to look for if an agent already exists that is doing what they're
 * spawning for and just message that one"). Each host tool or service below has at most one owner: the active worker of
 * the oldest open goal whose title names it. While it has one, every dispatch naming the component goes to that worker
 * as a message (and onto its goal's notes) instead of launching a second fixer; when the owner finishes, the next
 * dispatch naming it launches the new owner. This table is the one list of components and how people spell them; the
 * owner itself is derived from open goals and live workers, so there is nothing else to keep in step.
 */
export const COMPONENTS: Readonly<Record<string, readonly string[]>> = {
  gpurun: ['gpurun', 'hfstage', 'hfstore', 'dt\\.py'],
  'cpu-slot': ['cpu slot'],
  'lean-slot': ['lean slot'],
  demorun: ['demorun'],
  gpujob: ['gpujob'],
  'ResearchCo-history': ['ResearchCo history', 'research history'],
  'kenan-cold': ['kenan cold', 'cold tier', 'cold restore', 'cold storage'],
  'kenan-snap': ['kenan snap'],
  'kenan-spend': ['kenan spend', 'spend ledger'],
  'kenan-disk-census': ['kenan disk census', 'disk census'],
  'kenan-bg': ['kenan bg'],
  'model-broker': ['model broker'],
};
/** A spelling matches with any of space, hyphen, underscore or nothing between its words, as a whole word. */
const spellingPattern = (spelling: string) => spelling.split(' ').join('[-_\\s]?');
const COMPONENT_PATTERNS = Object.entries(COMPONENTS).map(([name, spellings]) => ({ name, key: squash(name), pattern: new RegExp(`(?<![a-z0-9])(?:${[name, ...spellings].map(spellingPattern).join('|')})(?![a-z0-9])`, 'g') }));
function squash(name: string) { return name.replace(/[^a-z0-9]/g, ''); }
/** The component a title is about: the first one it names, or none. */
export function componentOf(title: string): string | undefined {
  const t = title.toLowerCase();
  let best: { name: string; at: number } | undefined;
  for (const c of COMPONENT_PATTERNS) { c.pattern.lastIndex = 0; const m = c.pattern.exec(t); if (m && (!best || m.index < best.at)) best = { name: c.name, at: m.index }; }
  return best?.name;
}
/** One spelling per component: every spelling of a known component becomes its squashed name ("cpuslot"). */
export const canonical = (text: string) => COMPONENT_PATTERNS.reduce((t, c) => t.replace(c.pattern, c.key), text.toLowerCase());
export const componentsOf = (title: string) => {
  const t = canonical(title);
  return new Set([...COMPONENT_PATTERNS.map(c => c.key).filter(k => t.includes(k)), ...(title.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)+/g) ?? []).map(squash)]);
};
