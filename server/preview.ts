// Read-only chat preview. Run only behind an nginx that authenticates the visitor,
// replaces X-Kenan-Preview-Person, and alone can reach this process's socket.
import { loadConfig } from './config.js';
import { createStore, type Session } from './db/store.js';
import { createBus } from './events/bus.js';
import { createApp } from './http/app.js';
import { listen, listenerFor } from './http/listen.js';
import { managerIdOf } from './channels/kenan.js';
import type { Deps } from './types.js';

const path = process.argv[2] ?? process.env.KENAN_CONFIG;
if (!path) throw new Error('usage: preview.js <config.json>');
const config = loadConfig(path);
// Never call another channel, even if the copied configuration names one.
config.link = undefined;
const db = new URL(config.databaseUrl);
db.searchParams.set('options', '-c default_transaction_read_only=on');
const store = createStore(db.toString());
// Login and cookie renewal must never write to the copied database.
const sessions = new Map<string, Session>();
const originalGet = store.getSession.bind(store);
store.createSession = async s => { sessions.set(s.id, s); };
store.getSession = async id => sessions.get(id) ?? await originalGet(id);
store.extendSession = async (id, expiresAt) => { const s = sessions.get(id) ?? await originalGet(id); if (s) sessions.set(id, { ...s, expiresAt }); };
store.deleteSession = async id => { sessions.delete(id); };
const people = new Map(config.people.map(p => [p.id, p]));
const deps = { config, store, bus: createBus(store), extensions: [], person: (id: string) => people.get(id), now: () => Date.now(), runtime: { managerFor: managerIdOf } } as unknown as Deps;
const server = await listen(createApp(deps, true), listenerFor(config.listen, process.env, process.pid));
console.log(JSON.stringify({ type: 'preview_started', listen: config.listen }));
const stop = () => { server.close(); void store.close().finally(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
