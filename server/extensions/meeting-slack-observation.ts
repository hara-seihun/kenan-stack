import { existsSync } from 'node:fs';
import { access, mkdir, rename, rm, writeFile, open, stat, chown } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { immediateReaction, reactionAddressed } from './slack-immediate-reaction.js';
import type { SlackObservation } from './meeting-slack.js';
import { redactSecrets } from './slack-redact.js';

/** One ordered writer on the existing socket; a failed write does not poison later observations. */
export function slackObservationPublisher(options: {
  host?: string; enabledPath?: string; directory?: string; react?: typeof immediateReaction;
} = {}): (message: SlackObservation) => Promise<void> {
  const host = options.host ?? hostname();
  const enabledPath = options.enabledPath ?? '/etc/kenan/slack-haiku-enabled';
  const directory = options.directory ?? '/home/kenan/data/slack-lane/priority-observations';
  let pending = Promise.resolve();
  return message => {
    const eventReceivedAt = Date.now() / 1000;
    const socketReactionDispatched = host === 'acme-host' && existsSync(enabledPath) && reactionAddressed(message);
    if (socketReactionDispatched) (options.react ?? immediateReaction)(message);
    const publish = async () => {
      if (host !== 'acme-host') return;
      try { await access(enabledPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const source = `slack:${message.channel}/${message.ts}`;
      const digest = createHash('sha256').update(source).digest('hex');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, source, message: redactSecrets(message), eventReceivedAt, socketReactionDispatched }) + '\n', { mode: 0o600, flag: 'wx' });
        // Beta may run as root while the canonical intake service runs as the lane owner.
        // Inherit the established private directory owner; never widen message permissions.
        const owner = await stat(directory);
        await chown(temporary, owner.uid, owner.gid);
        const file = await open(temporary, 'r');
        try { await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(directory, `${digest}.json`));
        const dir = await open(directory, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      } finally { await rm(temporary, { force: true }); }
    };
    const next = pending.then(publish);
    pending = next.catch(() => {});
    return next;
  };
}
