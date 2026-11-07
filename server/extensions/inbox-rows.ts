// One row per message on any of a person's channels, whatever store keeps it. Each source turns its own records into
// rows (signal.ts, texts.ts, discord.ts; mail and Kenan chats come from the channels watcher's log), and the inbox tool
// (inbox.ts) merges, filters and formats them.
import type { Platform } from '../channels/address.js';

export interface InboxRow {
  /** The watcher's channel item id for the message (`signal:ID`, `discord:ID`, `texts:ID`): the key its triage is logged under. */
  id: string;
  source: Platform;
  account?: 'kenan-own';
  /** Epoch milliseconds of the message itself. */
  at: number;
  from: string;
  /** The chat or channel it was said in. */
  where: string;
  text: string;
  /** The id the source's history or send takes: a Signal chat id, a Discord channel id, the number to text back. Null when there is none. */
  chatId: string | null;
}

/** Keeps a row whose sender, chat, chat id or text contains `query`, and whose chat or chat id contains `chat`; both case-insensitive. */
export const rowMatches = (query?: string, chat?: string) => (r: InboxRow) => {
  const q = query?.toLowerCase(), c = chat?.toLowerCase();
  return (!q || `${r.from}\n${r.where}\n${r.chatId ?? ''}\n${r.text}`.toLowerCase().includes(q))
    && (!c || `${r.where}\n${r.chatId ?? ''}`.toLowerCase().includes(c));
};

/** `2026-11-01T18:28:00-08:00`: the wall clock of `at` in `zone`, with its UTC offset. */
export function isoIn(at: number, zone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(x => [x.type, x.value]));
  const wall = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  const offset = Math.round((Date.parse(`${wall}Z`) - Math.floor(at / 1000) * 1000) / 60_000);
  const abs = Math.abs(offset);
  return `${wall}${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
