// Chat groups (the Chats sections of the Organized layout): table chat_group in schema.sql, owned by this module.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { GROUP_FAMILIES, type ChatGroup, type ChatGroupInput, type GroupFamily } from '../../../shared/contract.js';
import type { Bus, Store } from '../../../server/types.js';
import { fail } from '../../../server/db/errors.js';

const groupName = (v: unknown): string => typeof v === 'string' && v.trim() && v.trim().length <= 60 ? v.trim() : fail('invalid_input', 'name must be 1–60 characters');
const groupEmoji = (v: unknown): string | null => v === null ? null : typeof v === 'string' && v.trim() && v.length <= 16 ? v.trim() : fail('invalid_input', 'emoji must be one emoji or null');
const family = (v: unknown): GroupFamily => GROUP_FAMILIES.find(f => f === v) ?? fail('invalid_input', `family must be one of ${GROUP_FAMILIES.join(', ')}`);
export const uuidOrNull = (v: unknown, name: string): string | null => v === null ? null : typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : fail('invalid_input', `${name} must be an id or null`);
/** A new chat group: name and family are required; no emoji means none. */
export function parseGroupInput(b: Record<string, unknown>): ChatGroupInput {
  return { name: groupName(b.name), emoji: b.emoji === undefined ? null : groupEmoji(b.emoji), family: family(b.family) };
}
export type GroupPatch = Partial<ChatGroupInput> & { position?: number };
export function parseGroupPatch(b: Record<string, unknown>): GroupPatch {
  const patch: GroupPatch = {};
  if (b.name !== undefined) patch.name = groupName(b.name);
  if (b.emoji !== undefined) patch.emoji = groupEmoji(b.emoji);
  if (b.family !== undefined) patch.family = family(b.family);
  if (b.position !== undefined) patch.position = typeof b.position === 'number' && Number.isFinite(b.position) ? b.position : fail('invalid_input', 'position must be a number');
  if (!Object.keys(patch).length) fail('invalid_input', 'Nothing to change');
  return patch;
}

const toGroup = (r: Record<string, unknown>): ChatGroup => ({ id: r.id as string, name: r.name as string, emoji: r.emoji as string | null, family: r.family as GroupFamily, position: r.position as number });
export function groupStore(pool: pg.Pool) {
  return {
    async list(owner: string): Promise<ChatGroup[]> {
      return (await pool.query('SELECT * FROM chat_group WHERE owner_id = $1 ORDER BY position, created_at', [owner])).rows.map(toGroup);
    },
    async create(owner: string, input: ChatGroupInput): Promise<ChatGroup> {
      return toGroup((await pool.query(`INSERT INTO chat_group (id, owner_id, name, emoji, family, position, created_at)
        VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(position), 0) + 1 FROM chat_group WHERE owner_id = $2), $6) RETURNING *`,
        [randomUUID(), owner, input.name, input.emoji, input.family, Date.now()])).rows[0]!);
    },
    async update(owner: string, id: string, patch: GroupPatch): Promise<ChatGroup> {
      const params: unknown[] = [id, owner], sets: string[] = [];
      for (const [key, column] of [['name', 'name'], ['emoji', 'emoji'], ['family', 'family'], ['position', 'position']] as const) {
        if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${column} = $${params.length}`); }
      }
      if (!sets.length) fail('invalid_input', 'Nothing to change');
      const r = (await pool.query(`UPDATE chat_group SET ${sets.join(', ')} WHERE id = $1 AND owner_id = $2 RETURNING *`, params)).rows[0];
      return r ? toGroup(r) : fail('not_found', 'Group not found');
    },
    /** Deletes the group; its rooms (the owner's) become ungrouped through the schema's ON DELETE rule. Answers the rooms it held. */
    async remove(owner: string, id: string): Promise<{ conversationIds: string[] }> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const rooms = (await client.query('SELECT conversation_id FROM member WHERE group_id = $1 AND person_id = $2', [id, owner])).rows.map(r => r.conversation_id as string);
        if (!(await client.query('DELETE FROM chat_group WHERE id = $1 AND owner_id = $2 RETURNING 1', [id, owner])).rowCount) fail('not_found', 'Group not found');
        await client.query('COMMIT');
        return { conversationIds: rooms };
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    },
  };
}

/** Chat group changes, each followed by the owner's whole list (and, after a delete, the rooms it left ungrouped). */
export function chatGroups(store: Store, bus: Bus, groups: ReturnType<typeof groupStore>) {
  const publish = async (owner: string) => bus.toPerson(owner, { type: 'chat_groups', groups: await groups.list(owner) });
  return {
    list: (owner: string) => groups.list(owner),
    async create(owner: string, input: ChatGroupInput): Promise<ChatGroup> { const g = await groups.create(owner, input); await publish(owner); return g; },
    async update(owner: string, id: string, patch: GroupPatch): Promise<ChatGroup> { const g = await groups.update(owner, id, patch); await publish(owner); return g; },
    async remove(owner: string, id: string): Promise<{ conversationIds: string[] }> {
      const r = await groups.remove(owner, id);
      await publish(owner);
      for (const cid of r.conversationIds) { const c = await store.getConversation(cid, owner); if (c) bus.toPerson(owner, { type: 'conversation', conversation: c }); }
      return r;
    },
  };
}
