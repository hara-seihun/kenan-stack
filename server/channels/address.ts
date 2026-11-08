// Channels: every place Kenaznia hears people and answers them (Kenan shared chats, Signal, Discord, mail, texts) is a
// channel with one address, "platform:target". Inbound messages carry the address to answer on; the send tool takes it.
export const PLATFORMS = ['kenan', 'signal', 'discord', 'mail', 'texts'] as const;
export type Platform = typeof PLATFORMS[number];

/** Where a channel's inbound messages go: straight to Kenaznia, through the Haiku watcher, only those addressed to
 *  Kenaznia (Kenan shared chats), or nowhere. */
export const MODES = ['direct', 'filtered', 'addressed', 'off'] as const;
export type Mode = typeof MODES[number];
/** Modes each platform can take: only a Kenan chat knows whether a message is addressed to Kenaznia. */
export const PLATFORM_MODES: Record<Platform, readonly Mode[]> = {
  kenan: ['addressed', 'direct', 'filtered', 'off'],
  signal: ['direct', 'filtered', 'off'],
  discord: ['direct', 'filtered', 'off'],
  mail: ['direct', 'filtered', 'off'],
  texts: ['direct', 'filtered', 'off'],
};

export type Address =
  | { platform: 'kenan'; chatId: string }
  | { platform: 'signal'; to: string; account?: 'kenan-own' }
  | { platform: 'discord'; kind: 'channel' | 'user'; id: string }
  | { platform: 'mail'; to: string[] }
  | { platform: 'texts'; to: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const SNOWFLAKE = /^\d{5,25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^(\+[1-9]\d{6,14}|\d{3,8})$/;
const MAIL = /^[^\s@,]+@[^\s@,]+$/;

export const ADDRESS_FORMS = 'kenan:CHAT_ID (a shared Kenan chat), signal:CONTACT or signal-kenan:CONTACT (a name, number, UUID, or group:GROUP_ID), discord:CHANNEL_ID or discord:user:USER_ID, mail:ADDRESS[,ADDRESS…] (or just mail with replyTo), texts:+E164';

/** Parses "platform:target"; bare "mail" is a reply whose recipients come from replyTo. */
export function parseAddress(raw: string): Parsed<Address> {
  const text = raw.trim();
  const colon = text.indexOf(':');
  const platform = (colon < 0 ? text : text.slice(0, colon)).toLowerCase();
  const target = colon < 0 ? '' : text.slice(colon + 1).trim();
  const bad = (why: string): Parsed<Address> => ({ ok: false, error: `channel_invalid: "${raw}" ${why}; channels are ${ADDRESS_FORMS}` });
  switch (platform) {
    case 'kenan': return UUID.test(target) ? { ok: true, value: { platform, chatId: target.toLowerCase() } } : bad('needs a chat id');
    case 'signal-kenan': return target ? { ok: true, value: { platform: 'signal', to: target, account: 'kenan-own' } } : bad('needs a contact or group');
    case 'signal': return target ? { ok: true, value: { platform, to: target } } : bad('needs a contact or group');
    case 'discord': {
      if (target.startsWith('user:')) { const id = target.slice(5); return SNOWFLAKE.test(id) ? { ok: true, value: { platform, kind: 'user', id } } : bad('needs a user id'); }
      return SNOWFLAKE.test(target) ? { ok: true, value: { platform, kind: 'channel', id: target } } : bad('needs a channel id');
    }
    case 'mail': {
      const to = target ? target.split(',').map(a => a.trim()).filter(Boolean) : [];
      return to.every(a => MAIL.test(a)) ? { ok: true, value: { platform, to } } : bad('needs mail addresses');
    }
    case 'texts': return PHONE.test(target) ? { ok: true, value: { platform, to: target } } : bad('needs an E.164 number like +12025550106');
    default: return bad('names no platform');
  }
}

export function formatAddress(a: Address): string {
  switch (a.platform) {
    case 'kenan': return `kenan:${a.chatId}`;
    case 'signal': return `${a.account ? 'signal-kenan' : 'signal'}:${a.to}`;
    case 'discord': return a.kind === 'user' ? `discord:user:${a.id}` : `discord:${a.id}`;
    case 'mail': return a.to.length ? `mail:${a.to.join(',')}` : 'mail';
    case 'texts': return `texts:${a.to}`;
  }
}

export const platformOf = (address: string): Platform | null => {
  const p0 = address.split(':', 1)[0]!.toLowerCase();
  const p = p0 === 'signal-kenan' ? 'signal' : p0;
  return (PLATFORMS as readonly string[]).includes(p) ? p as Platform : null;
};
