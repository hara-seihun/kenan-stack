# Household operators

People Alice has made operators of this host (Carol 2026-10-18, Dave 2026-10-21; members of the host group
`kenan-operators`, whose list `/usr/local/sbin/kenan-user-grants` owns) operate and fix Kenan Stack without the
administrator account and without reading other people's private folders. Host-side grants (groups, the source
repository and channel-config ACLs) are reconciled by `/usr/local/sbin/kenan-user-grants`; see
`/home/kenan/machine/user-access.md`.

- `kenan-operator` (installed root-owned at `/usr/local/sbin/kenan-operator`, the only program `kenan-operator.sudoers`
  admits, for `%kenan-operators`): `deploy CHANNEL forward|rollback COMMIT` deploys a commit pushed to the shared repository from a root-owned
  checkout in `/var/lib/kenan/operator-deploy/CHANNEL`; `systemctl VERB UNIT...` for `kenan*` units; `apt
  update|install|reinstall|remove PACKAGE...` for archive packages by name. `deploy/deploy.sh` calls the deploy
  subcommand itself when the caller isn't an administrator, so operators deploy exactly like everyone else.
- `operator-db.sql`: each operator logs in to `kenan_beta`/`kenan_production` as their own Unix user and sees schema
  `operator` (their search path): operational tables whole, private tables only for their own rows, `session` never.
  Unclassified new tables get no view and a warning. `apply-db.sh CHANNEL` applies it for the group's current
  members (revoking roles that left); `deploy/deploy.sh` runs it after every deploy.
- Install or update: `deploy/operator/install.sh` as an administrator.
