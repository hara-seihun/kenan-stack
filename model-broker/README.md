# Subscription model broker

## Upstream connections

The service selects IPv4 first and disables Node's dual-stack connection race. DNS and connection failures before request upload retry on the same account for up to 60 seconds, with exponential backoff and client cancellation. Lookups resolve normally; only a resolution failure can reuse the last successful answer, for up to 24 hours. Requests whose response stream has started are never replayed by this retry. Broker startup applies the same network defaults after graceful reloads, and undici's global dispatcher adapter keeps native Node fetch compatible. Transport logs retain bounded error names, codes, stack locations and nested aggregate causes without provider messages, URLs or credentials.

This component runs Kenan Stack's model requests through your own ChatGPT/Codex, Claude, or Grok/X subscription OAuth accounts. It shares account refresh, quota observations, conversation affinity and usage accounting across agents. It does not accept paid inference API keys or fall back to a metered provider.

The source is the standalone dependency set of the running Kenan broker, with a small broker-only CLI. The unrelated Pi Stack application and its host configuration are not included. The free Crouton relay is not included. `src/models.json` supplies model definitions; listener grants and the provider's account entitlements determine what can actually run.

## Requirements

- Linux with Node.js 24 or newer and npm. Node's built-in SQLite stores the ledger.
- For the service installer: systemd, Python 3, util-linux (`runuser`), nftables, root access, and the Stack service account `kenan` with home `/home/kenan`.
- At least one supported subscription for actual model requests. Sign in to accounts you own or are authorized to operate. Provider subscription terms still apply.

This is an independent npm package. Its dependencies and TypeScript settings are separate from the app's. The app's root TypeScript configuration does not include this directory.

## Install on a fresh host

From the cloned repository, after creating the `kenan` service account and installing Node:

```sh
sudo install -d -m 755 /etc/kenan
sudo install -o root -g kenan -m 640 model-broker/config.example.json /etc/kenan/model-broker.json
sudoedit /etc/kenan/model-broker.json
sudo bash deploy/install-model-broker.sh
```

Edit `principal` to the Stack person's ID (and Unix user for access control), `port` to a free loopback port, `accounts` to your local account aliases, and `models` to the exact provider/model IDs you want to grant. Delete unused provider grants and aliases. Set the same port in that person's app configuration as `people[].brokerPort`. Never put credentials in this file or in the source tree.

The installer builds from `model-broker/`, installs a release under `/srv/kenan/broker/`, selects `current`, installs the supervisor and port-access services, and starts the configured broker. State directories are created privately for `kenan`; existing auth files are never replaced. The grants file must be root-owned and not group/other writable. State and logs stay outside the repository.

`deploy/prepare.sh` and forward `deploy/install-build.sh` call this installer too. App rollbacks leave the installed shared broker alone. On hosts whose `current` points to an independently managed broker, the installer preserves that service and its release. An installation created here has `.stack-bundled` and is updated from the bundled source on every forward deploy; there is no version allowlist. Independent public-source update scripts should also run `sudo bash "$SOURCE/deploy/install-model-broker.sh"` before replacing the app.

## Subscription sign-in

Run login as the service account so tokens are owned by the broker. Match aliases to the config's `accounts` list:

```sh
sudo -u kenan node /srv/kenan/broker/current/dist/cli.js login /etc/kenan/model-broker.json openai-codex codex-main
sudo -u kenan node /srv/kenan/broker/current/dist/cli.js login /etc/kenan/model-broker.json anthropic claude-main
sudo -u kenan node /srv/kenan/broker/current/dist/cli.js login /etc/kenan/model-broker.json xai grok-main
```

Run only the providers you use. The CLI prints the provider authorization link or device code and handles its prompts. Complete authorization in your browser. It saves the refreshable OAuth credential privately in `authPath` and registers the account in `ledgerPath`; it never prints stored tokens. Re-run the same command to replace an expired or revoked login. Do not copy the same refreshable account to multiple broker hosts; each account must have one refresh owner.

A broker with no signed-in accounts can start for setup and local smoke checks. `/v1/usage` reports no accounts; a model request is refused with an error, not fabricated output. Account registration and refreshed grants become visible without restarting the service.

Inspect local account aliases without exposing credentials:

```sh
sudo -u kenan node /srv/kenan/broker/current/dist/cli.js accounts /etc/kenan/model-broker.json
curl --fail http://127.0.0.1:2465/v1/usage
sudo journalctl -u kenan-model-broker.service
```

The usage endpoint is local and principal-scoped. Inference routes are `POST /backend-api/codex/responses`, `POST /v1/messages`, and `POST /v1/responses` for Codex, Claude and Grok respectively. Codex requires inline input, `stream:true` and `store:false`. Models not granted to the listener are refused. Codex's served-model list is `GET /backend-api/codex/models`; an account without entitlement cannot make a model available merely by adding a config entry.

## Local build and smoke start

```sh
cd model-broker
npm ci --include=dev
npm run build
npm run check
# Use a root-owned, service-readable config with your own absolute scratch
# ledgerPath/authPath and an unused port for an isolated check.
node dist/cli.js model-broker /absolute/path/to/smoke-config.json
```

The smoke config can be copied from `config.example.json` with just the two state paths and listener port changed. No credentials are required. Query `/v1/usage`, then stop this foreground process with SIGINT or SIGTERM. Its SQLite and auth paths must not point into a source checkout.

## Operations and access

`sudo systemctl reload kenan-model-broker` starts a new generation and drains accepted streams in the old one. Editing account/model grants is noticed live; listener topology changes require reload. For rollback, select the previous installed release with an atomic `current` symlink replacement and reload. Retain old releases until their streams finish.

Listeners bind only to `127.0.0.1` and have no bearer-token login. The installer starts `kenan-port-access.service` to reserve each port for root, `kenan`, and the listener's Unix user, and reject traffic arriving off loopback. Do not expose or forward these ports to untrusted callers. A manual foreground broker without that host policy is accessible to other local users; use it only on a trusted development host. App authentication is separate.

The optional `backgroundRouting.fiveHourReservePercent` controls the subscription quota reserved from background workers. `codexAutoReset` defaults off; enabling it can redeem existing banked subscription resets, but never buys credit. `weeklyUsd`, when used per listener, limits attributed subscription usage value; it is not an API spending account.

## Account identity checks

“Identity verification is required” is an account restriction, not a bad request or an expired token. The broker marks the account `identity-verification-required` in its shared OAuth store and retries the unchanged request on another eligible account before responding to the client. With no alternative it returns HTTP 503 and code `identity_verification_required`. A restriction inside an already-started stream marks the account for future requests without replaying the stream. Credentials stay intact. The account holder completes the provider’s check, then the account owner restores its login; refreshing OAuth does not complete identity verification.
