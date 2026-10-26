# Kenan host retention

This Linux-only, Python standard-library job reclaims old disposable work data conservatively. It complements, and does not replace or change, `converge-host-cache-retention.timer`.

## Scope and limits

The command has three fixed roots, with no command-line root override:

- `/home/kenan/.bun/install/cache`: whole top-level entries only.
- `/home/kenan/.npm/_cacache/tmp`: temporary entries only.
- `/var/tmp/kenan-bg/kenan`: individual logs with exact retirement authority only.

The npm content and index stores are **retained, unsupported**, not bounded by this job. Deleting their entries independently could break npm's consistency. The report names this limitation explicitly.

An entire entry must be Kenan-owned, contain only ordinary directories and single-link regular files, and have every node older than 24 hours using the maximum of access, change and modification times. Symlinks are never followed or removed; special files and hardlinks retain the whole entry. Directory inspection uses `O_NOATIME`, and log hashing does too, so inspection does not create false recent access. A newly created file cannot qualify merely by backdating its modification time.

Every pass requires root and a complete host `/proc` inspection, including every task's command line, file descriptors, current directory, executable, root and mapped-file links. An unreadable live task prevents deletion. A vanished task can be ignored; a vanished descriptor in a still-live task discards the entire partial census. The job allows three whole-census attempts within the same overall budget for disappearance races only. A permission or other unknown error is never retried into permission to delete. Bun/npm installation, addition, CI and update commands prevent deletion globally. Open, mapped and directory inodes protect an entry. The tool repeats the census and exact tree checks immediately before detaching an entry and each subsequent removal. A changing host may therefore produce zero deletion; that is not fabricated reclamation.

The default pass is a dry run. `--apply` explicitly enables effects. Defaults bound a pass to 90 seconds, 2,000,000 inspected nodes/references, 64 deletion nodes (directories included), and 512 MiB of logical file bytes. Filesystem block savings are not claimed. The service adds a hard timeout, 256 MiB memory limit and CPU/IO limits. The budget is shared across discovery, process inspections, hashing and removal. A package larger than the whole pass allowance stays intact.

The job serializes itself with `flock`. It opens directory components without following symlinks, uses directory descriptors for effects, revalidates the root/quarantine identity, and refuses unsupported atomic rename behavior. It does not coordinate through or modify npm's index.

## Detachment, interruption and reports

Before an effect, a root-owned mode 0600 record under `/var/lib/kenan-host-retention/quarantine-<token>.json` binds the original absolute path, complete tree fingerprints, root/quarantine identities and a `detaching` state. The entire top-level entry is atomically renamed without replacement into a root-owned mode 0700 same-root `.kenan-host-retention-quarantine`. No partial Bun package is visible under its active package name. The target data retain Kenan ownership; only control directories and records belong to root.

If checks fail before any removal, restoration is allowed only after the complete tree/process checks still pass and the original name is unoccupied. If even one node was removed, the entry is never restored as a complete package. Changed trees, collisions, incomplete inspections and interrupted detached entries remain quarantined with their original custody; future passes do not infer safety or automatically continue deletion. Reconcile the exact journal, surviving tree and process custody as a separate deliberate repair. Do not delete a quarantine merely because a service is terminal. Interrupted records survive subsequent passes; `latest.json` is only the latest pass, not their replacement.

`latest.json` is atomically replaced with eligible/deleted node, file and byte counts, exact original paths, actual deleted paths, retained reasons and quarantine state. A process killed between an unlink and its next journal write leaves an incomplete `detached` record, never a claimed completed deletion. The next pass retains that uncertainty. A successful repeat does not repeat effects.

## Log retirement authority

Logs are retained by default, regardless of their age or terminal unit state. The tool never infers that event/evidence references are gone from a text search, a terminal service, missing files or an empty query. No retirement authority generator or automatic reference inference is provided.

An authorized custody owner must explicitly establish that **every event and evidence reference is retired**. Only then may a root-owned mode 0600, single-link JSON file be placed in the root-owned mode 0700 directory `/var/lib/kenan-host-retention/retirements`. Its filename is the lowercase SHA256 of the exact absolute log path's UTF-8 bytes, plus `.json`. Its body must be no larger than 64 KiB:

```json
{
  "schema": 1,
  "path": "/var/tmp/kenan-bg/kenan/EXACT.log",
  "device": 123,
  "inode": 456,
  "size": 789,
  "mtime_ns": 1234567890000000000,
  "sha256": "EXACT_SHA256_OF_ALL_LOG_BYTES",
  "retired_event_ids": ["EXACT_RETIRED_EVENT_ID"],
  "retired_evidence_ids": ["EXACT_RETIRED_EVIDENCE_ID"],
  "all_event_and_evidence_references_retired": true,
  "authority": "Attributed exact authority and the custody evidence establishing complete retirement."
}
```

Both ID lists must be nonempty and contain nonempty strings. Unknown or absent reference custody, malformed JSON, unsafe ownership/mode, changed identity/size/time, or a content hash mismatch retains the log. This declaration is an explicit authority boundary, not a claim that this script independently enumerates native references. Do not create it without the owning system's actual retirement evidence. The pass report retains the exact authority filename, hash and IDs when consumed. Authority records themselves are not removed.

## Tests and installation

From the repository root:

```sh
python3 -m unittest discover -s tools/host-retention -p 'test_*.py' -v
systemd-analyze verify tools/host-retention/kenan-host-retention.service tools/host-retention/kenan-host-retention.timer
```

The tests use disposable directories, injected age/process observations and synthetic `/proc` fixtures. They never apply to real caches. Real privileged host inspection is a separate installation acceptance check.

After committing the complete source, install this job alone:

```sh
sudo deploy/host-retention
```

The installer refuses uncommitted source or installer differences. It exports its exact commit, runs the fixture tests and unit validation first, and installs root-owned read-only source in `/usr/local/lib/kenan-host-retention/releases/<commit>`. Unit files and the `current` pointer are replaced atomically, with a durable rollback receipt created first. A failure restores the previous pointer, units and timer state. Previously installed source is preserved. Installation refuses an executing retention pass rather than killing it.

By default installation leaves the new hourly timer disabled and stopped and **does not run an apply pass**. After reviewing a real dry run, explicit scheduling is available with `sudo deploy/host-retention --enable-timer`; that starts only the hourly timer, never invokes the service directly. The service itself is intentionally configured with `--apply`. Rollback uses the exact command/installation ID printed by the installer, for example `sudo deploy/host-retention --rollback <installation-id>`. Rollback validates and tests the previous immutable source when one exists. A rollback can restore a previously active timer; no apply pass is directly invoked.

A manual installed dry run is:

```sh
sudo /usr/bin/python3 -I -B /usr/local/lib/kenan-host-retention/current/retention.py
sudo cat /var/lib/kenan-host-retention/latest.json
```

Do not hide `/proc`, use a private PID/user namespace, or remove inspection capabilities from this service: complete privileged process custody is a deletion prerequisite. No network, model calls, dependencies or secrets are needed.
