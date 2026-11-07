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
published as a single commit without the private history. Private test fixtures,
benchmarks, operational notes and artwork are omitted.

## Layout

| Path | Contents |
|---|---|
| `DESIGN.md` | Principles and architecture: agents, lanes, wakes, heartbeat, latency targets |
| `shared/contract.ts` | HTTP + SSE contract shared by server and web |
| `server/` | Hono server: database store, auth, event bus, agent runtime, tools and extensions (mail, calendar, browser, texts, voice/phone, meetings) |
| `web/` | Preact web app (also the Android app's UI) |
| `android/` | Android client: WebView shell with notifications and a signed update channel |
| `deploy/` | systemd units, nginx entrance, build/deploy scripts, backups, host helpers |
| `model-broker/` | Subscription model broker, account login CLI, example configuration and setup instructions |
| `config/channel.example.json` | Example channel configuration |

## What you need to run this

- Linux with systemd ≥ 254, Node.js >=24 with npm, and PostgreSQL 18.
- Build tools: GCC, G++, make and libc headers (`build-essential` on Debian/Ubuntu), `pkg-config`, `libjson-c-dev`, `libsystemd-dev`, `libnode-dev` (N-API headers for the background helper), Python 3 and Git.
- Your own supported model subscription and its login. The subscription broker is included in `model-broker/`; follow [its setup guide](model-broker/README.md) to sign in and create your local broker configuration. No metered model API key is required.
- Local Unix accounts, a PostgreSQL database, channel configuration and login verifiers. Optional mail, calendar, phone, browser and live voice integrations need their own configuration; leave unused extensions disabled.

Credentials, subscription tokens and personal context stay outside this repository. This is the canonical source repository; the earlier `pi-stack` repository is archived. Its Git history is preserved on the `recovery/pi-stack` branch here.

On Debian/Ubuntu, `sudo bash deploy/install-build-deps.sh` installs missing build dependencies. It checks headers and native library linking, and names missing dependencies on other distributions or when it cannot install. Install Node.js >=24 with npm separately; the helper never replaces your Node installation. `bash deploy/install-build-deps.sh --check` only checks.

## Running it

```sh
sudo bash deploy/install-build-deps.sh
npm ci
npm run check     # type-check
npm run build     # dist/server and dist/web
```

The server reads `/etc/kenan/CHANNEL.json`; start from
`config/channel.example.json` and `server/config.ts`, which documents and
validates every field. Each person needs a Unix account, a login verifier in
`verifierDir`, and a model route: agents reach models through a local
included subscription broker on the person's `brokerPort` (see [broker setup](model-broker/README.md) and `server/pool.ts`). The fresh-host deploy path installs and starts the broker from this source when `/etc/kenan/model-broker.json` is configured. For a manual development run, start the broker first using its guide.
Then:

```sh
KENAN_CONFIG=/etc/kenan/beta.json node dist/server/main.js
```

`deploy/README.md` describes how the original host installs units, deploys
channels (`deploy/deploy.sh CHANNEL`) and rolls back. Paths and units there are
that host's; adapt them to yours. Every systemd install also runs `sudo bash deploy/install-runtime-control.sh` after writing its channel config, and every independent updater (including `kenan-update`) runs it from the new source before replacing the app. This small installer supplies the detached restart command that the Bash tool requires, its recovery service/timer, and exact sudo grants for the configured local Unix owners. It preserves your app, credentials and host-specific service settings. Every fresh systemd install and independent updater must also run `sudo sh deploy/install-mail.sh install` from the new source before starting or replacing the app, even for frontend-only updates: the mail extension calls the installed `mail-send` and `mail-search` CLIs, not a bundled copy. Standard `prepare.sh` and forward `install-build.sh` paths already do this. Independent updaters also run `bash "$SOURCE/deploy/install-build-deps.sh"` as root before `npm ci` or any build; all standard deploy/install paths and npm install/build hooks call the same helper.

## Microphone and live voice

The Organized layout includes microphone dictation in the composer and floating quick-chat bubble.
Enable `organized`, `rooms`, `dictation`, `bubble` and `busyline` for the person and choose Organized in the app menu.
Dictation runs locally with whisper.cpp and ffmpeg. The deployment preparation installs its models when `dictation` is enabled.
For a live voice conversation, enable `voice` and set `composerVoice: true`; configure the live voice provider too.
The browser must have microphone permission and a secure origin (HTTPS or localhost).
These features require each install's own provider credentials; none are included here.

## Updating an existing clone

Each public snapshot replaces history. To keep local commits while updating:

```sh
git pull --rebase origin main
sudo bash deploy/install-build-deps.sh
npm ci
```

Public history is replaced on each publish. If pull cannot find a common base, save local changes first,
then use `git fetch origin && git reset --hard origin/main` for an unmodified install; do not merge an old
snapshot root back into the new snapshot. Keep local configuration outside the repository.
Deploy the updated source to Beta with your installation's
`deploy/deploy.sh beta`, then promote with `deploy/promote.sh`. Hosts with different directories or users must
adapt the paths in those scripts. For an unmodified clone you may instead run `git fetch origin` followed by
`git reset --hard origin/main` (this discards local changes).

## License

MIT; see `LICENSE`.
