# Kenan Stack repository

Read DESIGN.md first. It is short and it is the contract for how this system works.

**Adding a feature starts by making the system simpler** (Alice). First look for complexity to remove; reuse or replace what exists instead of layering on top of it; prefer deleting. Leave the system no bigger than you found it.

- TypeScript ESM, Node 24, `.js` relative imports. Server code under `server/`, shared contract in `shared/contract.ts`, web app under `web/`.
- Keep it small. No recovery/custody layers, triggers, audits or workflow engines. Provider errors use only the bounded same-session durable continuation in DESIGN.md; no tool or original-input replay. Other failures return a plain error; Kenaznia fixes them on heartbeat.
- Every human message must be admitted in milliseconds and answered within seconds. Do not put anything slow on that path.
- `npm run check` (types) and `npm test` (vitest) must pass. Tests are for behavior that matters, not coverage. A test with a wall-clock bound goes in a `*.timing.test.ts` file: `vitest.config.ts` runs those alone after every other suite, so CPU contention can't flake them; keep the bound, never loosen it.
- Deploy: `deploy/deploy.sh beta` then, once good, `deploy/deploy.sh production`. Deploys stage the build first; frontend-only updates keep the backend running, and backend changes restart once. Push your commit to the shared repository first; a deploy that lacks a commit live on that channel is refused with the missing commits listed. Merge them in, or pass `--rollback` to remove them deliberately.

- Time-bound work wakes itself: the `wake` tool (`server/agents/wakes.ts`, table `wake`) resumes an agent at a time, on new mail/Signal/text, or whichever comes first. Signal wakes carry a required conversation scope (`chat`: direct, one group, or any), so a contact's group messages never fire a DM wake. Don't add heartbeat- or model-polling for waits; extend `WakeEvent` with a new source instead. Person config `signalStore` (path or null) is required by `loadConfig`.
