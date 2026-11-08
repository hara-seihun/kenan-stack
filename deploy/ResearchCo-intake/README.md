# Acme source intake on ResearchCo

This is a host timer, not part of the app. It reads bundles and adjacent JSON manifests from
`acme-host:/var/tmp/kenan-stack-to-ResearchCo/` once a minute, imports all deltas oldest first,
and records imported and completed commits in `~/.local/state/kenan-ResearchCo-intake/state.json`.
Any `*.bundle` export with an adjacent same-stem `.json` manifest is accepted, including descriptive names such as `740cb82c79a-male-voice.bundle`. The manifest's full `tip` selects the commit and must match the bundle's heads. Imports and deployment are deduplicated by that commit, not the filename; the optional digest is not an admission requirement. Completed tips are skipped from their cached manifests before reading or fetching their bundles; unfinished publications retry. Remote exports stay in place.
An incoming ancestor already in `rewrite/app-polish` needs no merge. An export with exactly the
same source tree as the canonical checkout also needs no merge, deployment or returned bundle;
independent merge commits from the two hosts must not keep echoing back and forth.
All queued changes are merged together and deployed once. Descendant exports already include
their earlier deltas, so only independent tips need merging. Pending exports are recorded before
changing the canonical branch, so a restart resumes an unfinished deployment even when that
branch has already advanced.

New changes merge in the service's dedicated Git worktree on `host/ResearchCo-intake`, based on
`rewrite/app-polish`. The clean canonical integration checkout is updated only by fast-forward.
Existing edits, concurrent commits and conflicts are never reset or rewritten. Merge conflicts
are aborted in the dedicated tree and reported with filenames to the intake repair goal. Failures send a deduplicated
`goal-0adb0d99-7e4b-4916-bbbe-ff5869be4f09:ResearchCo-intake` event; the next tick retries.
The repair goal holds an event wake so failures start a repair worker without firing personal wakes.
No app process needs to stay up for the timer or the durable event/peer queues to work.

For a combined batch that changes source, the service deploys ResearchCo Beta with `--wait`, then `deploy/bundle-acme.sh` returns the complete
integrated source. Each sender streams into its own temporary file and renames it in the same SSH session, so concurrent promotion and intake cannot consume each other’s uploads. Completion and duplicate messages stay in the service journal; returned bundles
are picked up automatically without peer notes. Merge conflicts needing a source decision send
a deduplicated note through `/var/lib/kenan/peer-outbox/alice/` to `manager:acme`.
Ordinary operational failures remain local events for the intake repair goal.

## Install and operate

Only the explicit command below installs and enables it. It is not called by normal deployment,
and refuses hosts other than ResearchCo. It needs kenan's existing passwordless admin sudo, read-only
Acme SSH access, `kenan-event` and the existing peer outbox.
It does not install keys, change permissions, or write Acme source/configuration.

```sh
python3 deploy/ResearchCo-intake/intake.py --inspect   # Read-only local status and remote listing
bash deploy/ResearchCo-intake/install.sh --enable
sudo systemctl start kenan-ResearchCo-intake.service  # Run now rather than on the next tick
sudo journalctl -u kenan-ResearchCo-intake.service
sudo systemctl disable --now kenan-ResearchCo-intake.timer  # Stop future runs
```

Installation copies the script and units; rerun the explicit installer to update them. To repair
an actionable failure, preserve/commit the named edits or merge the two histories in the canonical
checkout, then start the service again. Do not delete its state to retry deployment: pending commits
already retry, while completed commit IDs suppress repeated work. Retain the state and worktree
when disabling the timer. The service never resolves a merge by choosing one side automatically.
