# Model broker supervisor

Lets the subscription model broker (`kenan-model-broker`) take a new release without refusing a single call (goal 8743545c, 2026-10-24).

Before this, every broker restart stopped listening as soon as shutdown began and then spent up to 6 minutes finishing open streams. Every new model call and usage poll in that window failed with `fetch failed` (all broker ports, 2026-10-24 09:07–09:13Z).

## How it works

- `supervisor.mjs run` is the unit's main process. It runs one broker generation (a Node cluster worker) from the release `/srv/kenan/broker/current` points to. Since 2026-10-27 each generation binds its own `SO_REUSEPORT` sockets (broker `listen()` in `src/model-broker.ts`) and tells the supervisor with a `broker_listening` message, so two generations, or two whole supervisors, can listen on the same ports at once. `net.ipv4.tcp_migrate_req=1` (`90-kenan-model-broker.conf`, installed by `deploy/prepare.sh`) moves connections still queued on a closing listener to a sibling instead of resetting them. A generation whose port is held by a predecessor without `SO_REUSEPORT` keeps retrying the bind for 15 s.
- `systemctl reload kenan-model-broker` (`supervisor.mjs reload`) starts a new generation from wherever `current` points now. Once the new generation is listening on every port in `/etc/kenan/model-broker.json`, the old one gets SIGTERM. The reload exits 0 when the new generation is serving and 1 if it failed to start; on failure the new generation is killed and the old one keeps serving.
- A retiring broker (release `55052dce-handover` onward, `close()` in `src/model-broker.ts`) stops accepting new connections but keeps serving anything that still arrives on its open connections, answering with `Connection: close`. Idle keep-alive sockets expire on the timeout clients were already told. Before this change it answered those requests 503 "Broker custody is draining". It exits once its last stream ends; streams are capped at 30 minutes. Old and new generations share the ledger (SQLite WAL) and the OAuth file lock, so they can run side by side.
- A change to `/etc/kenan/model-broker.json` that the running generation can't apply in place (a listener added, moved or removed, or the grant owner) makes it ask the supervisor for a new generation itself (`broker_generation_requested` in the journal), so editing the file is enough. Grant changes (accounts and models per listener) and `backgroundRouting` apply in place.
- Stopping the supervisor no longer signals generations that are already retiring (a second SIGTERM killed them mid-stream).
- If the current generation crashes, a new one is started at once; five crashes in a minute exit the supervisor so systemd restarts it.
- State: `/run/kenan-model-broker/state.json` (current generation, release, retiring generations, last reload outcome). The journal has one `broker_supervisor_*` JSON line per event.

## Operations

- **New broker release or rollback:** the broker's source is `/home/kenan/work/repos/model-broker.git` (operators can push to it). `sudo kenan-operator broker-install COMMIT` runs its `release/test.sh`, builds the release folder with `release/make-release.sh`, points `current` at it and reloads; if the reload or the health probe (every listener answers `/v1/usage`) fails, it points `current` back and reloads the previous release. `sudo kenan-operator broker-select RELEASE` switches to an earlier folder the same way (rollback); `broker-releases` lists them. Never restart for a release. Config edits need neither step (next bullet). The config must stay root-owned and not group-writable (the broker refuses it otherwise), so operators change its tunables with `sudo kenan-operator broker-config backgroundRouting JSON|unset`.
- **Accounts, grants, listeners:** edit `/etc/kenan/model-broker.json` (root) and leave it; the broker applies grants in place and swaps generations itself for listener changes. After changing the OAuth store or ledger rows by hand (an account import), `systemctl reload kenan-model-broker`.
- **Never stop or restart the unit.** It has `RefuseManualStop=yes`, so `systemctl stop|restart kenan-model-broker` is refused, and `kenan-operator` refuses them with `broker_stop_refused`. A restart refuses every call while the old supervisor drains its streams, which can take minutes: that was the 2026-10-27 outage (an account import restarted the broker; about 5 minutes of `Connection error` for every agent).
- **Supervisor change:** edit here (Kenan Stack `deploy/model-broker-supervisor/`; the unit is `deploy/kenan-model-broker.service`), run the test, then `deploy/prepare.sh` as root installs `/usr/local/lib/kenan/model-broker-supervisor.mjs`, the unit and the sysctl. Then `sudo kenan-operator broker-restart`: it starts a bridge supervisor (`kenan-model-broker-bridge`) on the same ports, stops the old supervisor, which drains, starts `kenan-model-broker` again once it has, and lets the bridge drain. It runs detached as `kenan-model-broker-restart`; follow it with `journalctl -fu kenan-model-broker-restart`.
- **Test:** `BROKER_DIST=/srv/kenan/broker/current/dist node restart.test.mjs` (about 20 s). It runs the supervisor over the real broker with a stub upstream, keeps 16 keep-alive and 8 fresh-connection streaming clients busy, reloads three times across two releases, adds a listener and reloads, then starts a second supervisor on the same ports and stops the first right after a reload (what `broker-restart` does), and fails on any refused, failed or truncated call, a generation that never drains, or an unclean stop. Against broker releases before `SO_REUSEPORT` the second supervisor can't start; with the old double SIGTERM a retiring generation's streams were cut. `BROKER_DIST_FIRST=OLD_DIST` runs the first supervisor on an older build to check the one-time switch from it (a handful of refused connects while the port moves, which clients retry).

## Files

- `supervisor.mjs`: the supervisor and the `reload` client.
- `../kenan-model-broker.service`: the unit installed to `/etc/systemd/system` (`KillMode=mixed`; the supervisor forwards SIGTERM to every generation and exits when they have finished).
- `restart.test.mjs`, `test-worker.mjs`: the regression test.

## Notes

The account a conversation is pinned to (`sticky`) lives in memory, so a reload starts every conversation on a fresh choice, just as a restart did.
