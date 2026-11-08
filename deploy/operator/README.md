# Household operators

People Alice has made operators of this host (Carol 2026-10-18, Dave 2026-10-21, and Alice's own account `kenan`
2026-10-22 so her agents read the database views without the superuser; members of the host group
`kenan-operators`, whose list `/usr/local/sbin/kenan-user-grants` owns) operate and fix Kenan Stack without the
administrator account and without reading other people's private folders. Host-side grants (groups, the source
repository and channel-config ACLs) are reconciled by `/usr/local/sbin/kenan-user-grants`; see
`/home/kenan/machine/user-access.md`.

- `kenan-operator` (installed root-owned at `/usr/local/sbin/kenan-operator`, the only program `kenan-operator.sudoers`
  admits, for `%kenan-operators`): `deploy CHANNEL forward|rollback COMMIT` deploys a commit pushed to the shared repository from a root-owned
  checkout in `/var/lib/kenan/operator-deploy/CHANNEL`; `android-release CHANNEL COMMIT` builds, signs and publishes the
  channel's next APK from a pushed commit as kenan (whose Gradle cache and signing custody the build needs) in unit
  `kenan-android-release-CHANNEL`, from the kenan-owned checkout `/var/lib/kenan/operator-android/CHANNEL`; when the unit ends,
  `kenan-android-release-notify` (root ExecStopPost, `/usr/local/libexec`) sends the caller host event
  `android-release:CHANNEL` `{channel, commit, result: published|failed, versionCode, log}`. `android/release.sh` calls it
  for anyone who isn't kenan, so operators release with the same command. `broker-install COMMIT` tests, builds and switches the model broker (`kenan-model-broker`) to a commit pushed to
  `/home/kenan/work/repos/model-broker.git` from the root-owned checkout `/var/lib/kenan/operator-broker`, reloading and
  rolling back by itself if the new release doesn't serve every listener; `broker-select RELEASE` rolls back to an earlier
  release folder, `broker-releases` lists them, and `broker-config backgroundRouting JSON|unset` edits that one tunable of
  the root-owned broker config (see `deploy/model-broker-supervisor/README.md`). `move-self FROM TO [--check]` moves the caller's own person between channels with `deploy/move-person.py` from Beta's live commit (`--check` inline; the move detached in unit `kenan-move-PERSON`, result as host event `move-person:PERSON`); `compact CHANNEL AGENT_ID` makes that agent compact its conversation at its next model request, below the 600k trigger (the same one-pass checkpoint, appended to the journal and marked `requested: operator`; nothing is deleted), for example to replace replies the model keeps imitating; `systemctl VERB UNIT...` for `kenan*` units; `apt
  update|install|reinstall|remove PACKAGE...` for archive packages by name. `deploy/deploy.sh` calls the deploy
  subcommand itself when the caller isn't an administrator, so operators deploy exactly like everyone else.
- `operator-db.sql`: each operator logs in to `kenan_beta`/`kenan_production` as their own Unix user and sees schema
  `operator`: operational tables whole, private tables only for the rows of the person their Unix user is
  (`operator.identity`; Alice's account `kenan` is person `alice`), `session` never. Unclassified new tables get no view and
  a warning. Meeting model transcripts use their own `owner_id`, matching the writer and owner-only meeting inspection;
  sharing a conversation or meeting does not grant transcript access. Their search path in those two databases only is `"$user", operator`, so plain names (`error_log`, `goal`)
  reach the views. An operator that also holds privileges on public tables is a service identity too: `kenan` runs the
  calendar link, queue observer and contention-watch, which name `kenan_calendar`, `agent`, `message`,
  `wake` and `agent_pending_input` unqualified. Its own schema (named after the role, marked by its comment) holds a `security_invoker` pass-through view of each such table, so those names reach the real tables
  with exactly the role's own privileges, for its services and for its psql alike (on 2026-10-22 an operator-first path
  sent those services to the filtered views: `permission denied for view kenan_calendar`, a queue observer timeout). A
  schema of that name that isn't ours fails the apply with `operator_schema_taken`. After applying, `apply-db.sh` logs in
  as each operator and fails with `operator_session_path_wrong` unless `error_log` reaches the operator view and every
  table it holds privileges on reaches its own schema. `apply-db.sh CHANNEL` applies it for the group's current
  members, paired with their person by `operator-identities.sh` from the channel config (a member who is no person
  fails the run with `operator_person_missing`), and revokes roles that left; `deploy/deploy.sh` runs it after every
  deploy. Applying reconciles normalized view definitions, options, grants and identity mappings in place;
  unchanged permanent objects are untouched, so a database dump's read locks do not delay deployments or live
  queries. A changed object has a one-second lock timeout rather than queuing behind a long backup. Regression: `operator-db.test.ts` (runs where kenan-postgres and passwordless sudo exist).
- Plain `psql` as an operator: `apply-db.sh` also writes `/etc/postgresql-common/user_clusters` (generated by
  `operator-clusters.sh`), so `psql`, `pg_dump` and `pg_isready` as an operator, with no host or database given,
  connect to kenan-postgres (`/run/kenan/pg`) and the database of the channel hosting their manager (kenan: `kenan_beta`;
  carol, dave: `kenan_production`). Other users keep Ubuntu's default cluster. Libraries (psycopg, node-postgres)
  don't read that file; give them `host=/run/kenan/pg dbname=...`.
- Install or update: `deploy/operator/install.sh` as an administrator.
