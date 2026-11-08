import type { PersonConfig, ServerConfig } from '../config.js';
import { channelPlacement, ownerProcess } from '../tools/owner.js';

const placeholders = /\{\{(?:LEGAL_NAME|BIRTHDATE|ADDRESS)\}\}/u;

/** The stored brief stays a template. Resolve only into the bridge's RAM-only launch spec.
 * The renderer is explicitly configured per person: the host's shared vault is not everyone's identity. */
export async function renderCallBrief(config: Pick<ServerConfig, 'channel'>, person: PersonConfig, brief: string): Promise<string> {
  if (!placeholders.test(brief)) return brief;
  if (!person.identityBriefRenderer) throw new Error('call_identity_unconfigured: this person has no identityBriefRenderer; nothing was dialled');
  let rendered: Awaited<ReturnType<typeof ownerProcess>>;
  try {
    rendered = await ownerProcess(channelPlacement(config), person, person.identityBriefRenderer, ['-'], brief, undefined, undefined, 120);
  } catch {
    throw new Error('call_identity_unavailable: the configured identity renderer could not run; nothing was dialled');
  }
  // Never copy renderer output or errors into logs: they may contain identity values.
  if (rendered.exitCode !== 0) throw new Error(rendered.exitCode === 3
    ? 'call_identity_missing: a requested identity field is missing; nothing was dialled'
    : 'call_identity_unavailable: the configured identity renderer failed; nothing was dialled');
  const text = rendered.output.toString('utf8').trimEnd();
  if (!text.trim() || placeholders.test(text)) throw new Error('call_identity_missing: the renderer left a requested identity field unresolved; nothing was dialled');
  return text;
}
