# Kenan Stack

Kenan Stack is a small, self-hosted multi-agent assistant platform. One Node.js
process per release channel (`beta`, `production`) serves a web app and an
Android client, keeps conversations, goals and workers in PostgreSQL, and runs
long-lived agents on the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent engine.

Each person on the host gets a **manager** agent (Kenaznia) that talks with them,
keeps a goal list and spawns **worker** agents for individual goals. Workers run
tools as that person's Unix user and report back when they are done or blocked.
Agents can schedule their own wakes (time, mail, texts, host events), send phone
notifications, attach files, place and answer phone calls, drive a browser,
read and send mail, and message other people's Kenaznias. Human messages always
take priority over background work, and a restart resumes interrupted turns.

This repository is a sanitised public snapshot of the source that runs one
private deployment. Host configuration, credentials and personal data are not
part of it; names in tests and examples are placeholders, hostnames are
`*.example.com`, and the launcher icons are neutral placeholders. It is
published as a single commit without the private history.

## Layout

| Path | Contents |
|---|---|
| `DESIGN.md` | Principles and architecture: agents, lanes, wakes, heartbeat, latency targets |
| `shared/contract.ts` | HTTP + SSE contract shared by server and web |
| `server/` | Hono server: database store, auth, event bus, agent runtime, tools and extensions (mail, calendar, browser, texts, voice/phone, meetings) |
| `web/` | Preact web app (also the Android app's UI) |
| `android/` | Android client: WebView shell with notifications and a signed update channel |
| `deploy/` | systemd units, nginx entrance, build/deploy scripts, backups, host helpers |
| `bench/` | Latency and startup benchmarks |
| `config/channel.example.json` | Example channel configuration |

## Running it

Requires Linux with systemd ≥ 254, Node.js 24 and PostgreSQL 18.

```sh
npm ci
npm run check     # type-check
npm test          # vitest; database tests need KENAN_TEST_DATABASE_URL
npm run build     # dist/server and dist/web
```

The server reads `/etc/kenan/CHANNEL.json`; start from
`config/channel.example.json` and `server/config.ts`, which documents and
validates every field. Each person needs a Unix account, a login verifier in
`verifierDir`, and a model route: agents reach models through a local
subscription broker on the person's `brokerPort` (see `server/pool.ts`).
Then:

```sh
KENAN_CONFIG=/etc/kenan/beta.json node dist/server/main.js
```

`deploy/README.md` describes how the original host installs units, deploys
channels (`deploy/deploy.sh CHANNEL`) and rolls back. Paths and units there are
that host's; adapt them to yours.

## License

MIT; see `LICENSE`.
