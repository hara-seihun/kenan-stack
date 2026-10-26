# Agent workspace manager

`agent-workspace` owns temporary Git clones and worktrees used by agents. It gives every checkout a lease, records its owner and durable source commit, blocks new allocation when disk or inode reserves are low, and removes a checkout only after proving that it has no unique local work. Processes, active systemd units, Docker containers, and durable work in this Unix person's thread databases count as live owners.

## Refusal-driven sampling and terminal source growth

New source and registration admissions and explicit growth heartbeats refresh the stale or missing samples that contribute to a capacity refusal, largest remaining liability first. Sampling runs outside the device admission fence with a 30-second total budget. Each decision rereads physical capacity and all reservations under the fence. Admission stops sampling as soon as it fits. A failed or incomplete observation never grants credit or changes a source lease, plan, checkout or cache. Foreground source preparation delegates slow work to its original durable request rather than occupying its short foreground budget.

Explicit `measure-capacity` selectors use their full requested deadline rather than a two-second fleet slice. Fleet observations remain incremental, and incomplete walks preserve prior successful measurements.

Ordinary release and the ended-owner release sweep already retire future growth even when source must be retained. Pushed source alone is not evidence that a live writer has ended. Native root preparation can additionally project zero future growth after every exact declared stage has authentically settled, source identity still matches, and a fresh consumer census is empty. Pending, uncertain, frozen or active custody retains its liability. Explicit subsequent growth restoration overrides older terminal evidence. Projection changes no source, generated files, lease, original growth promise or headroom. Its bounded consumer census is outside the device admission fence.

## Declared dependency symlinks during release

Recursive cache declarations discover matching symlink entries but never traverse them. Release may unlink only an exact declared, Git-ignored, untracked symlink owned by the executing user, beneath unaliased workspace ancestors. Fresh native checks cover both the original path and the resolved target, including read-only file descriptors, queued work, installed references and qualification custody. Any active or unknown reference retains the link. The final check pins its inode, contents and ancestor identities before unlinking only that entry. The external dependency tree is never deleted, moved or given new ownership. Unknown, tracked, foreign-owned, dangling and cyclic links remain protected, including links to empty directories.

The focused regression is `node --test tools/agent-workspace/cache-symlink.test.mjs`. The native proof is `node tools/agent-workspace/cache-symlink-installed.mjs`; it uses a disposable checkout, proves that a read-only descriptor through the link protects the real target, then releases the checkout after the reader exits while preserving the external bytes. It does not use test safety overrides.

## Complete repricing observation

Ordinary `reprice-capacity` reads only the target's fresh identity-bound allocation sample and the device's reservation ledger. It never reads or refreshes another workspace's allocation cache, walks another checkout, performs a fleet consumer census, or waits for another checkout's lock. Other reservations retain their full outstanding growth and pending construction promises, shared maximum headroom, source-import promises and execution reservations. These are conservative reservation bounds, not fabricated current allocation samples; actual physical use is separately reflected in the fresh filesystem free-space observation. The receipt labels this `otherReservationsObservation: "conservative-ledger-promises"` and `otherAllocationSamplesRead: false`. A refusal is final for this call, not a restart of a fleet sampling loop. Explicit `resume-growth` keeps its separate existing admission behavior.

For both old and requested effective demands, compare remaining growth plus the maximum of the target's headroom and the other ledger floors, with unchanged other promises added to both. An unestimated construction allowance is shared headroom, not private growth. For example, replacing a 30 GiB unestimated plan with 6 GiB remaining growth and 8 GiB headroom is a 16 GiB decrease when the other floor is 8 GiB, but a 6 GiB increase when another plan still holds 30 GiB. A non-increase cannot worsen an existing deficit and needs no global measurement. An increase must fit the conservative complete ledger against actual free bytes and inode limits. The target's existing automatic growth discount cannot be silently restored as a no-increase. Missing target samples fail with the supported target-only `measure-capacity --id ID --budget-ms 40000 --json` recovery. No capacity is fabricated, no other promise is discounted, and live writes, source paths, identity and lease stay intact.

The device and checkout fences cover the decision, and one immediate ledger transaction revalidates the exact target record, owner, plan, device and sample before the compare-and-swap and repricing journal are committed. Owner-bound active reductions additionally retain all source, lease, borrower and fresh target-walk guards.

Active reduction runs inside one explicit bounded operation: `--budget-ms 25000`, an integer from1 to40000. Workspace/group/capacity fence acquisition and Git observations share its absolute deadline. The final complete allocated-block walk under those fences gets the remaining budget minus2000ms for validation/commit and the same2000000-entry ceiling as explicit capacity measurement. Exhaustion returns an error before plan mutation; it never credits a partial walk. The original cached sample remains immutable, and accounting uses the maximum of cached and complete fresh allocation. All source/owner/lease/borrower/sample/plan/capacity and8GiB guards remain.

Single-selector command errors name the actual command and distinguish both-supplied mutually exclusive flags from missing/invalid input. Heartbeat and release both reject ID+path; their rejection does not change a lease or release source.

## Resuming a retired writing budget

`resume-growth (--id ID [--path PATH]|--path PATH)` requires explicit owner, current plan SHA, intent, remaining growth and headroom. If both selectors are supplied they must name the same original workspace. Shared CLI contracts generate its help and selector errors; errors name `resume-growth`.

A retired source-only plan can explicitly resume as source-only or expand to budgeted; a retired budgeted plan resumes as budgeted. Fresh allocation/capacity admission, original owner/current plan, existing headroom and all original retained history remain required. A source-only resume does not manufacture a budgeted intent, lower admission floors or authorize dependency installation.

Ordinary release honors unique/dirty/unpublished source custody before detaching generated caches. Explicit generated-only retirement retains its separate resource contract. If local tracking refs are stale, bounded read-only exact branch-head observations can prove remote custody without fetching or altering the checkout; unavailable/mismatched/unproven heads remain protected. Release JSON distinguishes lease release, source physical disposition and cache detachment-for-retirement (never inferred free bytes).

## Batched release reachability

Release snapshots local branch and remote-tracking object IDs once and performs a
single union reachability walk (`rev-list --max-count=1 --stdin`) against remote
and immutable durable-source ancestry. This is the same any-uncovered-commit
predicate as separate per-branch counts, without walking shared history once per
branch. When tracking refs are stale, release (and `dispose-local-merges`) reads
every head each configured remote advertises now (`ls-remote --heads`, at most 16
remotes, 4 s each), keeps the advertised commits that are present locally, and
does at most one more union walk. A commit pushed under any branch name counts,
not only under the local branch's name; a remote tip that isn't present locally
covers nothing. Revision input is stdin, not an argument per tip. Failed/late Git
and malformed output never establish safe source custody. Source refs, configuration,
working files, leases, foreign records and deletion guards are unchanged.

Focused checks: `node --test tools/agent-workspace/release-reachability.test.mjs tools/agent-workspace/release-custody.test.mjs`.

## Authenticated ordinary release custody

Ordinary `release`, including `--end-retention` and grouped releases, authenticates the current native tool caller against its root-created scope and exact tool call in the native store before any release journal, lease, state or filesystem transition. Every selected group member must belong to that caller. A registered native UUID is authoritative; otherwise the stored native binding or a byte-exact checkout admission receipt authenticated in the native store determines custody. Unknown or conflicting custody refuses without mutation. Neither the free `--owner` label nor an authorization string grants another agent release rights.

A native owner can explicitly transfer responsibility with `reassign` to the recipient's full native UUID. The authenticated current custodian must issue that transfer; the recipient may then release, while the previous owner cannot. Renaming a free task label retains the same native custodian. A native caller cannot seize an unbound historical task by writing an authorization string. The positively identified non-native operator route remains available for those old tasks. Missing native scope authentication or unreadable ancestry never silently selects that operator route. No environment variable or force flag bypasses these checks. The ended-owner sweep retains its separate native liveness proof and normal physical safety checks.

The focused regression is `node --test tools/agent-workspace/release-authority.test.mjs`. It compares every registry row and checkout inode, mode, modification time and content hash before and after rejection, including grouped custody, admission recovery, explicit transfer, spoofed identity and the legacy operator route.

## Interrupted ordinary release

Before dropping any single/group writing lease, ordinary release atomically records an original request identity and registered owner, an explicit `owned-retention` receipt, and `repair-required` state. This commit precedes native/queue/Git inspection and physical work. A caller deadline, TERM, or whole-process KILL cannot leave the previous ACTIVE/lease0/no-result combination. No signal handler, longer caller timeout, polling worker, or Stack-runtime change is required.

`status --id ID --json` returns `releaseSettlement`: `unset`, `owned-retention` (physical disposition explicitly `unsettled`, exact observe/settle argv), or `completed` with the actual terminal result. A stopped caller's owner still owns settlement. The exact same supported release request resumes that retained identity with fresh normal safety/source checks; changed owner/source/group/policy bindings are explicit errors. A new dirty/unpublished edit remains protected. Group peers commit their retention together. Final result persistence precedes stdout, so loss of the response does not lose its disposition. These receipts never authorize replaying the caller's surrounding batch or external effects.

`status --limit` accepts integers **1..500**, with initial page size100. JSON `nextAfter` feeds `--after` with the same filters; stop at null. Status does not execute, renew, retry, or settle a release.

## Ordinary release settles retained future growth

An explicit ordinary `release` ending in lease0/repair-required retained source
now attempts a separately journalled future-growth settlement. Dirty/unpublished
source, branches, generated dependencies and all runtime bytes remain untouched;
existing headroom remains charged. This is an explicit end-writing request, not
an archive/expiry inference. The same locked `retire-growth` transition performs
fresh privileged process/writable-FD, systemd, container, native queue and borrower
observations, current sample validation and exact source/plan/root/lease CAS.
Native queue observation is also required by direct `retire-growth`.

`futureGrowthSettlement.kind` distinguishes `retired` (journal sequence and evidence
hash) from `retained` (typed cause and supported observe/settle commands). Failed,
stale, live, uncertain or active-borrower evidence retains the full allowance;
release success alone never implies capacity credit. Original release settlement
and retirement journal survive a lost stdout. Repeating release after repairing
cessation reobserves the same retained tree; already retired custody remains
non-destructive and cannot silently resume writes. Resume needs supported full
capacity admission. No source publication or actual freed disk bytes are claimed.

A subsequent ordinary release by ID or path can finish cleanup after its own earlier completed ordinary release retired future growth. It reuses the original request identity, requires the unchanged owner, path, source and zero writing lease, and runs the existing locked terminal retention checks. It does not resume allocation or writing. Fresh runtime, queue, borrower and source checks still protect a real consumer, dirty work or unpublished commits. Explicitly retained reservations without that original ordinary-release receipt still require the bound `--end-retention` contract.

## Owner-liveness release of ended native owners

A checkout whose registered owner is a Kenan Stack native worker id (a UUID) used to keep its reservation forever once that worker was stopped or archived, because only the owner could declare an ordinary release and a lease of `0` never expires. `agent-workspace release-ended-owners [--root PATH | --id ID | --path PATH] [--execute] [--budget-ms 30000] [--max-records 16] [--after ID|start] --json` performs that ordinary `--preserve-runtime` release on the ended owner's behalf. Without `--execute` it only reports `would-release-ended-owner`. An unselected executing run persists its own cursor (scope `owner-liveness:ROOT` or `owner-liveness:*`) so a timer covers the whole registry in bounded pages.

The native verdict (`owner-liveness.mjs`) is one-sided. An owner is `ended` only when a complete read-only observation of every serving channel (`agent` and pending `wake` rows in each `kenan_CHANNEL`) finds a positive row for that exact id, every such row is stopped or archived, and no pending wake is owned by or held for it. An owner absent from every channel is `unknown`, never ended: absence is not evidence of retirement and never permits deletion of an existing checkout. Non-UUID owners (task names, `manager:` ids) with existing paths are never candidates. Missing paths are also candidates, including historical non-native owners: a complete native observation, no positive live owner, no pending wake, and fresh strict runtime cessation are required before the reservation is released. No source bytes are deleted for an absent path. Any channel failure, including a missing `SELECT` grant on `wake`, makes every owner unknown and exits 75. A pending wake (held trigger or ordinary wake) whose message, handoff or event names the checkout by absolute path, relative path or bare directory name keeps it, as does a held trigger for the ended owner's goal, so the worker that resumes that goal still finds its source. Before acting, the command takes the checkout lock, rereads the native store and refuses if the owner, path, source or verdict changed.

The verdict replaces only the owner's end-of-writing declaration. Archive or stop is never treated as proof that nothing is running: the shared ordinary release still observes running tool calls, live workers that name the path, processes, writable descriptors, units, containers, threads and Git borrowers, and refuses on any of them. A clean checkout covered by remote refs or durable ancestry is physically released. Dirty or unpublished source stays byte-for-byte in place; only its future growth is settled through the shared locked `retire-growth` transition, which needs a fresh allocation sample, the exact binding and its own terminal writer observation, and keeps the headroom floor. When the release retains a tree whose sample is stale, the command measures that one checkout outside every lifecycle lock (through the host's UID-preserving `sudo -n setpriv` read-capability route, falling back to an unprivileged walk), bounded by the run's own budget, then repeats the settlement under the checkout lock with a fresh native verdict. A measurement that cannot complete keeps the full allowance. Release work stops starting new groups when less than ten seconds of the budget remain. A checkout protected by live native intent or an uncertain observation keeps its full allowance. Each executed release journals the verdict, the observation and the result in `workspace_owner_liveness_release`; the retirement journal's `ownerEvidence` names the owner-liveness release request.

The host runs this on a timer (`agent-workspace-owner-liveness.{service,timer}`, host source in the machine handbook). The observer role needs `SELECT` on `agent` and `wake` in every channel database.

## Terminal release and bounded queue observation

An explicit ordinary release transfers source intent to its durable Git/task custody; every single/group physical inspection keeps that resource scope. Actual reserved tools, native executions, unknown operations, FD/cwd readers and Git borrowers still retain the checkout. Dirty/unpublished source remains protected.

Kenan Stack queue observation (`cache-queue.mjs`) reads every installed channel: each `/srv/kenan/CHANNEL` with a `source-commit` maps to database `kenan_CHANNEL` on the `kenan-postgres` socket `/run/kenan/pg`. It connects as the invoking Unix user through peer authentication; that role needs membership in `kenan_workspace_observer`, which has only `SELECT` on `agent`, `message` and (for owner-liveness release) `wake`. A running tool call (`message` role `tool`, state `streaming`) whose arguments name the checkout is a physical consumer. In source scope, a live worker (non-archived, not stopped) whose conversation names the checkout is source intent. Finished tool history and manager transcripts are not consumers. The caller's own tool call is excluded only by its exact agent and call identity from the active, root-created systemd scope, authenticated against the matching root-owned Kenan Stack server in the process ancestry and the native message store. The admission shell and flock wrappers may intervene in that ancestry. A sibling tool with identical arguments remains protected, and ambiguous or unavailable identity never grants an exemption. A retained queue verdict includes both the actual references and the per-channel caller observations so another tool's custody cannot be mistaken for the releaser's own call. Observation requires an absolute `deadline` and retains the 4000ms PostgreSQL statement cap. Its client process uses a hard-kill timeout bounded by that deadline and at most6000ms. Output uses private regular descriptors so a descendant's inherited pipe cannot extend the wait; failed commands terminate their owned process group. A missing channel inventory, missing role/grant, schema change or failed/late observation returns unknown safety, never an empty authoritative queue. Each channel database carries the partial index `message_streaming ON message (conversation_id) WHERE state = 'streaming'`, so finding running tool calls does not scan the whole message table. `node tools/agent-workspace/queue-installed-check.mjs [--condition FILE]` checks the installed observer against the live stack: channel inventory, each channel's configured database, role grant, index and a complete probe observation in both scopes. With `--condition`, failure writes that machine-alert condition and a healthy run removes it.

`retire-growth --id ID --path PATH` requires both bindings. `release (--id ID|--path PATH) --end-retention` requires exactly one selector. Shared CLI contracts drive selector validation and these help forms. A `future-growth-not-retired` error supplies executable measurement/status commands, the explicit owner-disposition schema, and command templates with named unset file/hash inputs; no disposition or owner evidence is invented.

Cache deleting continuations retain the original journal/request/stage/manifest. After fresh native/queue/Git authorization, checked removal pins directory FDs, validates inode/type/content against that manifest, and visits only actual remaining names. Unknown names and replaced directories refuse; symlinks unlink without traversal. It does not repeatedly snapshot all already-removed leaves. Deadline expiry retains pending/deleting and actual partial progress for the same request. The35s operation budget remains unchanged.

Owned read-only staged directories (including0500 package payloads) are handled by the owning engine: after all normal authorization and manifest/name/inode checks, an already pinned directory FD may gain only its owner-write bit when its numeric UID equals the executing UID. No source directory, unlisted inode, symlink target or foreign-owned directory gains permissions. The same checked-removal primitive serves qualified source materializations. A permission failure outside that case retains the original pending journal. An administrator can deliberately execute the SAME CLI/request under a finite UID-preserving CAP_DAC_OVERRIDE unit, preserving original HOME, registry, Git trust and native guards; changing to root instead can invalidate linked-worktree Git trust and is not a substitute for those checks.

## Checks

`node tools/agent-workspace/check.mjs` checks component deployment and partitions the lifecycle fixtures into 24 disjoint index shards. Each fixture runs exactly once; each shard has a 55-second deadline and shares the root check runner's concurrency budget. Fine-grained shards keep Git/SQLite-backed fixture batches bounded without increasing deadlines or dropping custody contracts.

## Normal flow

For source edits from an existing local repository, declare source-only intent and a growth budget. Use `budgeted` with enough growth for dependencies/builds when the task installs or generates them. A remote URL can use priced intent when its requested commit is already in the URL's independent durable mirror; pass the exact commit to avoid remote ref discovery. New remote imports have no local-source forecast; omit intent explicitly for that unestimated route.

```bash
agent-workspace create \
  --root ~/work/clones --name claim-123 --repo /absolute/local/project \
  --ref EXACT_COMMIT --owner claim-123 --mode writer \
  --intent source-only --headroom-gib 8 --growth-mib 512 --json

# Unestimated remote import:
agent-workspace create \
  --root ~/worktrees \
  --name claim-123 \
  --repo https://github.com/example/project.git \
  --ref refs/heads/main \
  --owner claim-123 \
  --mode writer \
  --cache deploy/generated \
  --json

agent-workspace heartbeat --path ~/worktrees/claim-123
agent-workspace release --path ~/worktrees/claim-123
```

For source delivery, call `release` as soon as the repository's durable publisher acknowledges custody of the immutable commit. Threads with unfinished input, execution, registered dependency waits or cancellation intents, and other live processes keep the checkout referenced even after its lease is released. The manager excludes its own invocation ancestry from the process check, so release can reclaim the calling shell's current directory after its thread has settled. A subsequent allocation still works with absolute paths or Git URLs. Relative filesystem operands require a directory that still exists. The manager resolves local repositories and their relative remote URLs before starting subprocesses in the home directory, outside any disposable checkout. Mirror inspection failures are reported without attempting to add a remote.

The publication worker continues checks, merge, deployment, and verification without the originating model or workspace. Lifecycle/publication operators use a stable owning cwd and absolute source/artifact paths, rather than inheriting a source worker's disposable checkout. A completed idle source conversation does not reserve its old cwd for later assignments; continued source work first admits its own workspace. A registered dependency wait is unfinished work, even when its model turn has settled.

Creation resolves and validates the source commit before reserving a destination. Durable custody is checked at the requested scope, never inferred from a present commit alone. Full checkouts verify reachable tree/blob/history closure. Sparse checkouts verify the commit/root tree, complete tree topology needed by Git's index, selected blobs and checkout attributes, without traversing ancestor history or opening excluded blobs. Both cached-source shortcuts and zero-import pricing use that scope. Import forecasts and Git negotiation share up to16 independently full-closure-qualified ancestral ref tips from the durable mirror. Already-custodied ancestry is excluded from the import budget; checkout construction, growth and headroom floors stay unchanged. Incomplete or unqualified custody retains the full import/refetch route. A successful verification is cached per mirror, commit and exact sparse patterns. Loose-object fanout and pack metadata changes invalidate it; immutable object bodies are not reread on every admission. An incomplete mirror is refetched without trusting its negotiation claims and checked again before admission. Mirror imports retain packs (`fetch.unpackLimit=1`): zero means unlimited loose-object unpacking, which made a 107,169-file source spend minutes creating small files on encrypted storage. Priced remote admission refuses incomplete custody before making a reservation; recover through the explicitly unestimated import route, or a priced local source whose full history import is budgeted. Invalid refs, non-commit objects and interrupted source fetches leave no reservation. Abbreviated commit hashes resolve against the local source or the freshly fetched remote mirror; an unavailable or ambiguous abbreviation needs a full commit or remote ref. The manager records the request, immutable source commit and `creating` state before materializing the checkout. Repeat the same command after interruption. Retry keeps the recorded commit even if the source's HEAD advances. A completed retry returns the same registry ID without renewing its lease. A different request for that path is refused.

`agent-workspace cancel-creation --id ID --json` explicitly retires a pending reservation only when its destination is absent. It takes the same checkout and group fences as creation, including locks inherited by surviving Git children. It never removes files, source refs or grouped peers. Any filesystem entry, including a dangling symlink, causes refusal. Materialized checkouts stay resumable and protected. The command also repairs source-less reservations left by interrupted creation before source validation moved ahead of reservation. Ordinary release and reconciliation continue to retain pending creations; they do not silently cancel them.

Source preparation has a 1.5-second foreground budget. An import or slower verification/forecast is owned by a systemd user job, not by the foreground request. `create` returns temporary-unavailable exit75 with JSON `{ok:true,state:"preparing",jobId,progressPath,nextAction}` without claiming a workspace exists; use the advertised observer while pending, then repeat the exact request after successful preparation to perform admission. Repeats observe the same pending job before acquiring admission locks. The job records forecasting/importing progress and an explicit ready or failed result under the registry's `source-preparations/jobs/`; its private environment is mode0600. An interrupted read/import job, including a preparation child terminated by signal before publishing a result, resumes under its original identity. A normal child exit without a result remains a terminal failure, even with exit code zero; published ready or failed results remain immutable. Ready pricing is cached against the resulting object-store stamp; changed custody requires fresh preparation. A reachable user systemd manager is required for this route. When connection variables are absent, the owning source-job layer resolves `/run/user/EFFECTIVE_UID` and its bus socket after checking private directory ownership and socket ownership. It passes that resolved environment to control commands and persists it for workers, so managed callers need no XDG/DBUS exports. Explicit settings remain explicit; invalid or unavailable runtime state returns `source-job-user-environment` without submission. Native controllers and application services are untouched.

`agent-workspace job-status --job-id SHA256 --json` observes either a source preparation or a checkout job without submitting, retrying, renewing a lease or opening the mutable registry. Create receipts explicitly identify `jobKind` and advertise the matching read-only `observeCommand`. A ready checkout includes its workspace ID. `source-status` remains source-specific: passing a known checkout returns `state:"observation-error"`, `job-kind-mismatch` and a usable `job-status` command, never a fabricated failed source job. Unknown identities return `job-not-found` with unset (`null`) kind; ambiguous identities and failed/bounded filesystem lookup return explicit observation errors. Checkout identity lookup reads at most4096 retained workspace directory entries; it never traverses source checkouts. `agent-workspace source-status --job-id SHA256 --json` observes the exact source preparation without submitting or retrying it. Exit0 means ready, exit2 means terminal failure/interruption/invalid state, and exit75 means a currently active job. The immutable result takes priority over historical progress; stopped jobs without a result report interruption. New completions project their terminal result into progress and refuse later running updates. Retained older progress files remain untouched evidence. Preparation receipts advertise this observer and the immutable result path; consumers must not wait on progress alone. Repeat the original create request to perform admission/recovery.

New clone materialization belongs to a durable systemd user job, with an automatically scaled deadline: at least 300 seconds, plus allowance for immutable tree path count and forecasted construction bytes (100 paths/second and 8 MiB/second, capped at one day). The foreground submits without waiting under its checkout fence; unfinished work returns exit75 with `{ok:true,state:"creating",id,path,jobId,progressPath,nextAction}`. Repeat the exact create request to observe completion. Killing the foreground command (including the agent's 55-second bash ceiling) cannot kill the job. Git runs against a private sibling `.NAME.creating-ID-GENERATION-BUDGET`; only a clean, fully checked-out candidate is atomically renamed to the requested destination. Timeout, Git failure and service interruption remove that private staging, including any index.lock, empty index or truncated file. A systemd `ExecStopPost` cleanup also runs after forced worker termination. Checkout units restart on abnormal termination: even whole-cgroup SIGKILL that races into cleanup resumes the same durable command from clean staging. Published terminal results are never replayed. The reservation and original source commit remain pending; retry never lowers admission floors or changes existing workspaces. Failure is reported explicitly; the next identical request starts another attempt. Raise the budget for a timeout. A stopped job without a terminal result resumes under its original identity; explicit `systemctl stop` remains a stop, and the next create request resumes it. Linked worktrees and materialized pending checkouts from earlier releases retain the conservative resume/finalization route below. Use `--creation-timeout-seconds N` (1–86400) for a different budget. This operational budget is not part of the reserved request identity, so a retry may raise it without losing the original source commit. Checkout uses the remaining creation budget rather than the generic 30-second subprocess timeout. Expiry terminates the durable creator and its Git process group, cleans new clone staging, retains the pending reservation, and reports how to retry; it never marks a partial checkout active. An existing materialized pending clone from a previous release resumes without deleting the directory. Matching review HEAD alone does not prove materialization finished: a no-checkout clone is detached at the reserved commit but still needs its index and files populated. Resume finishes an interrupted clone checkout only when its index is absent, empty or the reserved tree, every materialized source file matches that tree, origin matches the request, and all local commits are covered by remote refs or the reserved source; other edits, untracked files and unique commits remain for repair. Creation's cleanliness check agrees with `git status --porcelain`; ignored output does not prevent resuming and is never deleted during creation. Normal release still removes only declared generated caches and retains unclassified ignored output. Reconciliation and release preserve a pending creation and its group; pool adoption and heartbeat cannot turn it into a completed checkout.

If work has already continued in a completed checkout after interruption, use `agent-workspace finalize-creation --id ID --json` (or `--path PATH`). It takes the checkout and group fences, requires a clean Git root of the recorded checkout type, and proves the current HEAD descends from the journal's immutable source commit. Writer checkouts must have an attached branch; review checkouts must remain detached. A clone's origin must match the original source or its canonical upstream; resume and finalization compare the locally stored `remote.origin.url`, not Git's `insteadOf`-rewritten transport URL, and still refuse a genuinely different origin. A linked worktree must belong to the recorded mirror. The original disposable source may already be absent. Finalization installs the standard `+refs/heads/*:refs/remotes/origin/*` fetch mapping when missing or empty, preserving existing explicit mappings. It does not fetch or invent remote refs: `git fetch origin main` then updates `origin/main` through that mapping. Finalization preserves HEAD, branch names, remote URLs, ignored files, source custody, request journal and group peers, while activating only that row with the recorded lease duration. Repeating it on an active row returns that row without renewing the lease. It does not prove publication or authorize deletion: follow with normal release, which still retains unpushed commits and unclassified ignored files.

`create` uses a shared bare mirror but gives the agent an independent checkout. Clone materialization reads only the reserved commit through an immutable `pi-workspace-source-SHA` tag in that mirror, using `--single-branch --no-tags --branch TAG`. The checkout receives that custody tag and its own writer branch (or detached review HEAD), not the original source's HEAD, other branches or unrelated tags. Remote-tracking refs appear only after a normal `git fetch origin` or push; creation never labels an unpublished local source branch as published upstream. This uses Git 2.39-compatible options. A temporary `workspace-source` clone remote points at the mirror; `origin` records the original repository and standard branch fetch mapping before cloning begins, and normal completion removes that temporary remote and configures canonical origin fetch/push URLs with the standard branch fetch refspec. An interrupted clone therefore remains identifiable and resumable even if the original source moves or disappears. Materialization uses Git's transport negotiation through `--no-local`, so it does not copy every loose or unreachable object from the source. On September 15, local object copying took 31.56 seconds on Converge even with a reference mirror, and cancellation left a complete but unregistered checkout. Reference clones disable commit-graph reads and writes with `core.commitGraph=false`, `gc.writeCommitGraph=false` and `fetch.writeCommitGraph=false`. The mirror rewrites its graph chain during refresh, so borrowing that mutable chain would leave a checkout naming graph files the mirror has replaced. They also set `gc.auto=0` and `maintenance.auto=false` before the initial clone fetch. Temporary clones retain their local objects until whole-checkout reclamation. Alternates point only at independent durable mirrors, never disposable source checkouts or mutable transitive chains. Mirrors retain immutable source and imported-object refs and disable automatic maintenance; do not prune mirror objects that borrowers may still use. It defaults to the repository's current `HEAD`, including a detached `HEAD`; pass `--ref` to select another commit. Use a ref the source repository can fetch, such as `refs/heads/main`, a branch name, or a commit. `origin/main` names a local remote-tracking ref and is not a remote branch name. `--strategy worktree` uses a linked Git worktree instead. When `--repo` names a local checkout, the new workspace inherits that checkout's canonical `origin` fetch and push URLs. Explicit source push grants are preserved, except for Converge's redundant `https://github.com/owi-link/converge[.git]` push URL equal to fetch: new imports omit that default so the host's work deploy-key `pushInsteadOf` route remains effective. A distinct explicit Converge write route remains intact, as do explicit equal routes for other repositories. An implicit local source never pins its effective rewritten push URL. URL-only imports likewise keep Git's `url.<base>.pushInsteadOf` rewriting (an explicit push URL would disable it); a programme checkout cloned from the read-only remote therefore pushes through the host's write rewrite. The mirror uses a separate `workspace-source` remote to read a local detached or unpushed commit. Mirror refreshes keep fetched source refs outside the local branch namespace, so creating one worktree cannot rewrite another worktree's branch. Release checks only the linked checkout's `HEAD`; branches checked out by its peers belong to those peers. New allocations require 30 GiB of free disk and 10 percent free inodes. There is no default checkout-count limit. A fixed cap blocked the thirty-worker math fleet once active work and retained repair checkouts exceeded 32, despite 1.5 TiB of free disk. Retaining unique work must not block unrelated allocations. Callers can impose a count limit with `--max-count N`; zero disables that optional limit. Disk and inode reserves still apply.

Use repeatable `--cache PATH` flags on `create`, `register`, or `adopt` for repository-generated ignored output. A comma-separated list also works. `--cache-owned OUTPUT=TRACKED_SOURCE` declares an output only in repositories that track its executable owner and ignore the output. This lets one pool adoption classify `src/docs/swagger-output.json` only where `src/docs/swagger.js` owns it, for example. Declarations extend the built-in set, which covers the output a normal build or test pass leaves behind: `node_modules`, `**/node_modules`, `dist`, `**/dist`, `.nx`, `.react-router`, `**/.react-router`, `.converge-cache`, `build`, `**/build`, `.gradle`, `**/.gradle`, `**/__pycache__`, `**/.pytest_cache`, `**/.mypy_cache`, `**/.ruff_cache`, `.lake`, `**/.lake`, `target`, and `**/target`. Pool owners can pass `--replace-cache` to `register` or `adopt` when they have recomputed the complete repository-specific policy and need to remove stale declarations. The current built-in set is applied when releasing existing records too, without rewriting their saved declarations. Cache paths must be relative exact paths or `**/directory` patterns. The manager removes only declared paths, and never one holding files the repository tracks, so a committed `build/` survives while a generated one does not. The tracked-file check runs in the target's owning Git repository, including nested submodules. A superproject's index records only the submodule link and cannot answer whether files inside it are tracked. Record any further test, build, or infrastructure cache a normal agent pass can create before doing the work.

A repository can carry its own declaration instead of relying on every caller: a tracked `.agent-workspace-caches` file at the repository root, one cache path per line with `#` comments, extends the record's declared paths whenever caches are stripped. The manager reads it from `HEAD`, so an untracked or working-tree-only manifest classifies nothing; declaring generated output is a repository decision with history. Entries use the same exact-path or `**/name` forms, where `**/name` matches a generated directory or file of that name anywhere in the checkout; an invalid line is reported and skipped.

A released or expired checkout is reclaimable only when it is clean and every local branch and detached `HEAD` commit is covered by a remote ref or by the immutable source commit recorded during creation and its ancestry. The source base already has durable custody, even if the original disposable source and its temporary remote are gone and no remote ref contains that base. New commits outside that ancestry still require remote coverage on every branch, including when `HEAD` has returned to the recorded source. Dirty files, unclassified ignored output, and unpushed commits move it to `repair-required`. Release and executing reconciliation return the persisted post-transition record for both single checkouts and groups, so `action: released` carries `record.state: released`. Registration and adoption first import a mutable alternate borrower's refs and reflog tips into durable mirror custody and atomically replace its alternates. Any remaining registered Git dependency still retains its source until that import succeeds. Declared generated trees are removed once no runtime uses the checkout, even when unique source work still needs repair. Cleanup checks exact paths first, then discovers every recursive cache name in one directory walk. Removed trees are not traversed. Retained tracked directories are traversed so generated caches inside them can still be reclaimed. This avoids repeating a full source-tree scan for each recursive declaration.

Give related repositories the same `--group` value when one agent task spans them. A heartbeat on any member renews the whole group. Release removes the group only when every member is recoverable, so a clean frontend checkout cannot disappear while its backend peer still contains unique work.

Re-registering an existing non-released path inspects its current Git layout and refreshes `checkoutType`: an owner may have replaced a clean linked worktree with an independent shared clone, or the reverse. Registration preserves the existing row identity, owner, source custody, lease and exact capacity plan (including its original admission and allocation baseline); it does not bless new commits as published. Explicit `--owner`, `--source-commit`, `--mode`, `--kind` and `--root` must match the existing record, otherwise registration fails with `registration-metadata-mismatch` before changing its cache or group policy. Omitting them preserves the record; it does not assert a new owner or baseline. Cache and group declarations still follow their normal rules. Pending creations remain pending and require their explicit resume or finalization transition.

`register --json`, `status --json` and completed `create --json` expose the same recorded `capacity` plan. `capacity: null` explicitly means no plan is recorded (for example preservation-only registration). Omission in older register/status responses did not mean admission had been erased; do not reprice an already-admitted writer to repair display.

New or previously unpriced writer registration uses the same device admission lock, shared headroom, reservation ledger and typed `workspace-capacity-refused` result as create. It prices future writes, not a second checkout of already-present bytes. Supply `--intent source-only|budgeted --headroom-gib N --growth-mib N`, or the same explicitly unestimated `--min-free-gib N` route as create (30 GiB by default). Admission and a fresh allocation baseline precede registration, native owner binding or Git custody mutation. A refused writer registration preserves source and any previous record. An unavailable allocation baseline refuses rather than spending future growth on old files.

`register --adopt-accounted` explicitly adopts an existing unreleased, already-priced registration without changing its plan or renewing its lease. It refuses a missing plan and cannot carry new pricing flags; use `reprice-capacity` to change an existing reservation. Ordinary re-registration of an already-priced checkout preserves the same behavior for compatibility. `register --retained` remains preservation-only with zero lease and no future-writing grant. Review registrations are nonwriters and do not receive growth admission.

## Authorized writer reassignment

When the previous author has ended and both author and borrower have authorized reuse, reassign the existing writer explicitly. This is a responsibility handoff, not a new allocation or an authorization-granting mechanism:

```sh
agent-workspace reassign --id EXISTING_ID --path /absolute/existing/checkout \
  --from-owner PREVIOUS_OWNER --from-source-commit PREVIOUS_BASELINE --from-state active \
  --owner BORROWER --source-commit CURRENT_FULL_HEAD \
  --authorization 'receipt/reference: previous author ended; author and borrower approved reuse' --json
```

All flags above are required. Use `unset` only for an actually null previous source. Source IDs are full lowercase Git object IDs. `--id` and `--path` must name the same row; expected owner, source and state must match under the checkout/group fences and an immediate registry transaction. Known retained states `active`, `referenced`, `blocked` and `repair-required` permit handoff; creating, released, reclaiming and unknown states do not. The existing Git root, checkout type, origin and attached writer HEAD must agree with the record and requested new baseline. Dirty files and ignored evidence may remain: reassignment never alters files, refs, remotes, caches or Git configuration. A competing handoff or stale replay fails rather than reapplying it.

Success is `{ ok: true, record, transfer }`. Refusal is `{ ok: false, error: { code, detail } }` with exit 2, or exit 75 for a busy resource fence. Parse failures use `invalid-request`; unexpected registry failures use `reassignment-failed`. The durable `workspace_reassignment` journal records each old/new owner and baseline, authorization reference, path, sequence and timestamp. The command changes only the selected row's owner and update timestamp, plus that journal. It preserves ID, creation time/request, original source custody, state/detail, lease expiry, group peers, cache policy and every capacity reservation. It neither renews nor releases a lease, drains disposal, changes admission headroom, nor checks consent from the authorization text; the caller must already have that consent.

`record.sourceCommit` and status's `sourceCommit` report the current working baseline from the journal. `durableSourceCommit` remains the original source commit used by release to prove recoverability. The raw `workspace.source_commit` also stays immutable, so an older in-flight client cannot mistake the borrower's unpublished HEAD for durable deletion ancestry. A new baseline is not publication: every new commit still needs remote coverage before deletion.

### Tool-only deployment

From clean committed Pi Stack source, `tools/agent-workspace/deploy` publishes this component on an already managed host without runtime/service activation or workspace-record mutation. It uses the normal shared deployment lock and publication reservation fence. The candidate must descend from the selected tools commit and leave every other tool and `config/tools.json` unchanged; otherwise use the full release owner. When the selected commit's Git object is not in this repository (a source projected to public `main` by `public-source`), `installed-base.mjs` accepts the newest ancestor whose `tools/agent-workspace` files, modes and blob hashes equal the installed component exactly; any installed difference refuses. It stages the selected tools tree, replaces only agent-workspace, retains dependency links and other tool bodies, and atomically selects a commit-addressed tools release. `agent-workspace/.component-release.json` records the baseline and source SHA. Normal full Pi Stack releases continue to own the complete tools tree. Push the committed source through its owning repository so the next full release retains the repair.

## Forecasted local-source allocations

A source-only writer is not an unpriced dependency install. Use explicit intent and budgets when the immutable source is already in a local Git object store or the remote URL's durable mirror:

```sh
agent-workspace create --root ~/work/clones --name source-inspection \
  --repo /absolute/current/repository --ref EXACT_COMMIT --mode writer \
  --intent source-only --headroom-gib 20 --growth-mib 256 --json
```

Keep the normal sparse patterns if needed. `source-only` declares source inspection/edits, without dependency installation. `budgeted` declares additional work, including an own dependency install; for a measured 1.6 GiB install use, for example, `--intent budgeted --headroom-gib 20 --growth-mib 2048`. These are explicit caller budgets, not new host defaults. Choose operating headroom for the host and growth for the work. Use `reprice-capacity` to expand a completed allocation before exceeding its allowance; an active allocation's budget cannot silently change on creation retry.

The tool forecasts immutable checkout construction: `whole-tree-upper-bound` for a full checkout or `git-sparse-upper-bound` for an explicit non-cone sparse selection. Git's native sparse checkout evaluates the recorded patterns in an isolated temporary repository with the selected commit's complete path/mode topology and tiny synthetic blobs, including ordered exclusions/re-inclusions, directory patterns, wildcards and escaped names. No source blob is materialized for forecasting; this uses the same checkout engine on Git 2.39 and newer. Tree listing omits blob sizes until after sparse selection, so excluded large or absent blobs do not add object reads. Only selected blobs contribute materialization bytes, with filesystem block rounding and CRLF expansion. Full-tree index records, temporary topology-tree objects, Git metadata and source-history import remain charged even when no blobs are selected. Excluded files do not receive per-file filesystem-block or inode charges: they exist only as records in the shared index. Pricing version4 reserves four uncompressed 128-byte-plus-path records per source entry, four filesystem blocks per topology directory, and separately charges selected file/directory metadata and block-rounded payloads. The 16 MiB fixed allowance and existing payload expansion/import bounds remain. `checkoutAllocation` exposes each component. Deep selected directories and all excluded tree topology remain counted. Preparation/forecast cache identities include the pricing version; existing admitted plans and immutable failed receipts are unchanged. The temporary repository is removed on success or error; source files, index and configuration are untouched. `sourceImportBytes` reserves a conservative uncompressed-history transfer/construction budget when the selected commit is absent from the durable mirror; existing mirror custody costs no additional import budget. It imports the selected commit's missing history into an independent durable mirror, then shares that mirror's objects. Allocations with the same canonical upstream reuse mirror custody; disposable sources can repack, detach their own alternates and be reclaimed without invalidating a child's imported refs. Remote URLs with an already-custodied commit are forecast from the independent mirror, with the same sparse selection and zero history-import bytes. Exact commits require no remote fetch or ref discovery, including when custody was originally imported from a local source with that canonical upstream. Named refs resolve through `ls-remote`; abbreviations must resolve unambiguously in existing mirror custody. Missing remote commits are refused before import, checkout reservation or materialization. Pending unpriced creations use the same custody-backed forecast when repriced for resumption. New remote imports, checkout filters/encoding transforms and explicit worktree strategy have unknown forecasts and are refused in this mode. The successful creation response carries the byte plan and source commit. A sparse selection reduces only checkout materialization, not imported history or full-index costs. Unknown attribute transforms remain errors even when the attributes file is excluded. Existing whole-tree reservation plans retain their original conservative budgets; retries never silently reprice them.

Admission requires incoming source construction + all outstanding construction/growth reservations + one shared operating headroom floor. Headroom is the maximum requested by the incoming allocation and every retained allocation on that filesystem, not the sum of a safety floor for each checkout. A per-filesystem fence covers different roots, and reservation/creation rows commit together. Reservations charge only the remaining budget: `max(0, budget - allocated growth)`. A creating row budgets construction plus growth, with a zero baseline; a completed row budgets growth only. Completion records `completedAllocationBytes` from a bounded allocated-block walk, atomically with activation. Earlier rows without that measurement use the source construction upper bound, excluding `sourceImportBytes` held outside the checkout, as a conservative baseline. If completion cannot measure the baseline, it records explicit `null` plus `completedAllocationError` and retains the full growth reservation until a successful off-hot-path refresh permits the source-upper-bound baseline. Lease expiry, dirty/unpublished work and safety-blocked release retain their remaining reservations. Removing generated files restores the outstanding growth reservation. This is admission accounting, not a filesystem quota.

Admission reads allocated-block measurement caches, not checkout trees. `agent-workspace measure-capacity --budget-ms 240000 --json` refreshes the live priced checkouts whose samples the ledger reads, under each one's lifecycle fence, without changing files, leases or source state. It skips rows the ledger never measures (retired future growth, and plans with no growth and no pending construction). It measures first the rows charged in full because their sample is missing, failed or stale, largest charge first, then current samples oldest first. The output is `{kind: "capacity-measurement", progress, results}`: `progress` counts eligible, skipped, measured, error and deferred rows, the bytes charged in full before and after the pass, the remaining uncredited rows by code and the age of the oldest current sample. Cache failures carry separate codes: `allocated-block-cache-missing`, `-stale`, `-future-dated`, `-root-changed`, `-root-unavailable` and `allocated-block-measurement-failed`. The host's read-only sampler timer owns periodic refresh independently of cleanup. A targeted `--id` or `--path` refresh is also supported. Each off-hot-path walk is bounded to 60 seconds and two million entries, within the command's explicit aggregate budget (1–300000 ms); unfinished rows are reported as deferred for a later pass.

The walk measures `st_blocks * 512` without following symlinks or crossing filesystems. Shared hardlinked files never earn growth credit; their blocks do count in the completion baseline. Separately registered descendant roots are excluded from their parent's credit, so allocations cannot spend the same subtree twice. Complete samples record exclusive and total allocated bytes, measurement start/completion times, root device and inode in `workspace_capacity_measurement`. Admission accepts a successful sample only for the same root identity and at most **15 minutes from measurement start**, with neither timestamp in the future. Credited allocated bytes subtract a mid-growth margin of **max(64 MiB, 1% of measured exclusive blocks)** before subtracting the baseline. Growth after an earlier sample therefore retains extra reservation rather than spending unseen writes. The sample is an admission estimate, not a filesystem quota or atomic filesystem snapshot. Manager-owned cache stripping invalidates the sample under the same lifecycle fence; after other large deletions/truncations, refresh explicitly before relying on credit.

Missing, replaced-root, unreadable or failed measurements retain the full reservation; complete bound stale measurements use the admission forecast below. Unavailable measurements emit an explicit diagnostic in stderr and `admission.measurementFailures`; disk/inode refusal still fails normally. Creation seeds a cache when its 500 ms/50000-entry baseline measurement succeeds. Admission performs only root identity stats and cache reads, then reads filesystem free space. Existing pending creations without a price are explicitly unknown. An active creator's checkout fence blocks admission; an unowned dormant reservation is reported as `unpricedDormant` rather than inventing a size or charging nonexistent current writes. Its original resume acquires a price under the filesystem admission fence before source import or materialization can restart. Its source, files and pending state remain untouched while dormant. Unestimated ordinary clone/work retains the existing 30 GiB filesystem guard (or its explicit caller override), without claiming a small-source or dependency-growth forecast. Older unestimated ledger rows store that guard in `constructionBytes`; completed rows contribute it to shared headroom rather than additive growth. Pending unestimated creations additionally retain their construction reservation until completion/cancellation. Remaining declared growth stays additive even when an expired checkout is dirty or runtime-owned. Released rows contribute neither growth nor headroom. Admission reports `reservedBytes` separately from `sharedHeadroomBytes`; ledger/source/lease records are not rewritten to free capacity. Source import also runs inside that filesystem admission fence and is checked again before reserving the destination.

Admission separately projects zero future growth for an authenticated native owner that is stopped or archived, or has been idle for more than one hour. The canonical native binding and a complete observation of every serving channel establish that classification; a free-form task label, an absent native owner, a failed observation or an invalid idle timestamp does not. Current native tool calls and actual process children keep the original future growth charged, even after their parent ends. This bounded observation does not walk checkout trees. A heartbeat, including an explicit growth heartbeat, cannot recreate liability for a dead writer. A genuinely active writer restores ordinary accounting on the next admission. Pending construction, source imports, execution reservations and the shared operating headroom remain funded. Existing allocation samples remain unchanged, including stale or failed samples. No physical free bytes, deletion authority or source disposition are inferred from this forecast, and pending wakes retain their stricter cleanup protection.

This ledger is native workspace state, `workspace_capacity` in the same registry. Its additive schema leaves existing source custody, leases and cleanup guards unchanged. No dependency installation, runtime activation or cache deletion occurs during admission.

## Repricing operating admission

A completed unestimated clone can opt into an explicit priced allowance, and a source-only or budgeted checkout can expand to a budgeted install/build allowance, without changing its source, files, lease, owner, state or original creation request:

```sh
agent-workspace measure-capacity --path /absolute/checkout --budget-ms 40000 --json
agent-workspace reprice-capacity --path /absolute/checkout \
  --intent budgeted --headroom-gib 8 --growth-mib 512 --json
```

Use source-only when the continuing work is only source edits; choose budgeted and enough growth for continuing installs/builds. Here `growth-mib` declares **additional remaining writes**, not a replacement total that forgets consumed growth. The tool requires a fresh successful root-identity-bound sample and immutable Git source custody. It forecasts the original source at its recorded sparse selection from the existing object store (no history import or import charge), uses that conservative checkout-only source upper bound as baseline, and sets the growth budget to measured growth plus the requested remaining allowance. Admission applies the same 64 MiB/1% measurement margin. Repricing all completed unestimated rows removes their shared 30 GiB guard in favor of the maximum explicitly requested floor; other rows retain their own floors and remaining growth.

For source-only → budgeted or budgeted → budgeted expansion, the existing source forecast, import accounting and completion baseline stay unchanged. Growth already measured through the margin-discounted cache (`repricing.accountedGrowthBytes`; the raw sample stays in `sampledGrowthBytes`) is added to the explicitly requested **remaining** allowance, so bytes the existing reservation still covers are not booked twice. Without explicit active-reduction evidence neither the remaining growth reservation nor headroom may decrease.

Admission charges a re-price only for its increment. Under one free-space observation and one conservative ledger-only set of other reservations it prices the liability the row already holds (unspent growth plus the headroom it imposes, including an unestimated plan's 30 GiB guard) and the liability it asks for. When the new requirement is no larger (`admission.kind: "reprice-within-reservation"`, `incrementalBytes <= 0`), the re-price is admitted even on an oversubscribed device, because it cannot worsen the deficit (`deficitBytesBefore`/`deficitBytesAfter` record it). Any real increment (`reprice-increment`: more remaining growth, or headroom above the shared floor) must still fit the whole ledger, other reservations and headroom included; a refusal carries `capacity.reprice` with the increment. Regression: `reprice-admission.test.mjs` (the Converge 2026-10-21 case: 512 MiB source-only → budgeted refused at 42.56 GiB free against 78.05 GiB). This changes mutable operating admission, not immutable submitted execution/proof source. For example, a source-only checkout admitted with 512 MiB can request `--intent budgeted --headroom-gib 8 --growth-mib 2048` before installing dependencies; it need not be cloned again.

Ordinary repricing accepts active/referenced/blocked/repair-required rows with an unestimated plan or a source-only/budgeted → budgeted transition. The explicit active reduction below additionally accepts source-only → source-only. Pending, reclaiming, released, unpriced, unsupported transitions and unmeasurable rows fail without mutation. The checkout/group and filesystem fences cover pricing and fresh-cache validation; admission excludes only the replaced reservation and accounts for every other live row. A compare-and-swap and `workspace_capacity_repricing` journal atomically preserve the previous plan, new plan and exact sample. Disk/inode refusal leaves the original budget, source and checkout intact. Dirty, live and unpublished work remain protected. This is a budget declaration, not evidence that work is published or deletable. Refresh after large manual deletion before repricing; never manufacture admission by editing the ledger.

## Finding out what became of a checkout

Records outlive the directory. When a checkout is gone, the registry still holds why, so this is answerable rather than a matter of guesswork:

```bash
agent-workspace status --path p3-ob50-review          # substring, not the full path
agent-workspace status --owner some-task --json
agent-workspace status                               # first bounded pool page
agent-workspace list --json --limit 100               # { records, matched, limit, nextAfter }
agent-workspace list --json --after CURSOR             # next page; repeat the same filters
```

`list` is accepted as an alias, since that is what people reach for first. Status and list return at most 100 records by default; `--limit` accepts 1–500. JSON returns `{ records, matched, limit, nextAfter }`, not an unbounded array. Follow `nextAfter` until null, keeping the same root/path/owner filters; `--after start` begins again. Ordering is the stable `(root, path, id)` key, so deleting an earlier record does not shift the next page. Concurrent registry changes remain visible on a subsequent scan rather than claiming a transaction-spanning snapshot. Text output states page coverage and the continuation command.

Pool status intentionally omits `cachePaths` and pending creation payloads. It returns their stored byte lengths as `cacheDeclarationBytes` and `creationRequestBytes`, without decoding them. Lifecycle commands continue to consume the full declarations and creation request. This is a read projection, not a registry rewrite: retained records, history, cache policy and pending creation custody remain unchanged. The September 30 Converge registry exceeded JavaScript's maximum string size when unbounded JSON serialized repeated cache declarations; both row selection and pool output are now bounded at the owning query before decoding. Both commands leave the disposal queue alone. Dry-run reconciliation also leaves it untouched; `reconcile --execute` drains it. Root, path and owner filters run in SQLite before decoding matched records. Path and owner substrings are literal and case-sensitive, including `%` and `_`; a relative path also matches its resolved absolute path. Text output counts the root-scoped pool separately without loading its cache declarations. This prevents a narrow custody lookup from decoding unrelated history. The September 16 Converge registry held 8,193 records with 298 MB of cache declarations; filtering after decoding took 6.42 seconds.

The answer that matters is the `state` and its `detail`. `released` with `every local branch commit exists on a remote ref or in durable source ancestry` means the manager proved new work was on a remote and any remaining base history was already in source custody before removing the tree. A local hash that no longer resolves was almost certainly rewritten by a rebase before the push. Look for the content on `main` rather than for the hash. `repair-required` is the opposite, and means unique local work is still there and the tree was kept.

A path that matches no record has no retained registration. Before creation requests were recorded, an interrupted create could leave an unregistered Git checkout. Inspect such a checkout before adopting it.

## Reconciliation

Registry connections install SQLite's five-second busy handler before reading journal or schema state. Schema version 1 initializes WAL and the workspace schema once under the `registry-schema` resource fence and an immediate transaction. Already-initialized connections read the version and journal mode without acquiring the writer lock. On September 15, unconditional migration transactions made status and setup calls compete with every native writer, producing `database is locked` before creation could reserve a row. The registry keeps existing rows and source custody during version adoption.

The manager fences checkout mutations and group lifecycle operations with advisory locks under the registry's `locks/` directory. Heartbeat, adoption, release and reconciliation use the same fences. Root admission holds a separate lock only while checking capacity and reserving a creation row. A pending row counts toward an explicit checkout-count limit even before its directory exists. Capacity checks skip directory and registry counts when that optional limit is disabled; disk and inode reserves always apply. The additive `workspace_pending` partial index covers root/path lookups for pending reservations without reading historical cache payloads. Schema version stays 1 so an already-running pre-update client can finish safely during deployment; existing records and leases are unchanged.

Mirror locking is scoped to what actually conflicts (October 21 Converge `lock busy` on 605c2856: two preparations of one commit started together; the second waited out its 30 s budget while the first held the whole-mirror lock through import base selection, `git fetch` and full closure traversal). Source imports hold `mirror:<path>` **shared**, so imports of different commits into one mirror run concurrently; Git object writes are content-addressed and atomic, and each import fetches from its own request's repository URL with `--no-write-fetch-head`, not through the shared `workspace-source` remote another import may be rewriting. Only one import per commit runs, under `mirror-source:<path>:<commit>`; a same-commit peer waits for that in-flight result (in a durable worker, up to the 30-minute import timeout plus a minute) and then reuses its custody without fetching again. Mirror configuration writes happen only when a value differs, under the short `mirror-config:<path>` fence, and abbreviated-hash upstream refreshes under `mirror-origin:<path>`. Maintenance imports into a mirror still take `mirror:<path>` exclusive, which also fences every importer of an older installed release. A foreground `create` never waits on these locks; it hands busy custody to the durable source job. A closure proof stays valid when concurrent imports move the object-store stamp (only its memoization is skipped), and a completed job whose mirror moved meanwhile is re-proved instead of failing "source changed during preparation". Every held lock writes a diagnostic record in `lock-holders/` beside `locks/` (key, mode, pid and process start time, systemd unit, source job, phase); a busy wait's error carries `detail` with the lock, mode, waited ms, the waiter's phase and job, and every live holder with its current job phase. Durable job results keep that `detail`, and the create failure prints it. Records of dead processes are ignored and pruned by the next acquirer of that lock; the flock itself stays the only exclusion. Regression: `mirror-concurrency.test.mjs`.

Mirror mutation holds its own lock only while resolving source. Local repository refs, including default `HEAD`, resolve to an immutable commit before taking that fence. Local source imports fetch only that commit, without refreshing every upstream branch; an already-custodied commit skips mirror mutation entirely. Remote moving refs resolve through `ls-remote` before that fence, including peeled annotated tags, then import just the advertised commit. Concurrent clients resolving the same commit share its immutable custody rather than serializing full upstream refreshes. Abbreviated remote hashes alone still require an upstream fetch to discover their full commit. This prevents local and remote HEAD fleets from serializing branch refreshes under one mirror lock (October 3 Converge timeout incident). Clone and checkout run outside the mirror lock, so unrelated creations and lease operations can proceed together. Git children inherit the held lock descriptors, so killing only the creator does not expose a still-writing checkout. Lock ownership ends when the last descriptor closes, not at a timestamp. Lock files contain no source and remain reusable after their owner exits. A lock wait exhausts its 30-second budget with exit 75, without changing the fenced record.

Adopt existing children of a pool, then inspect before changing anything:

```bash
agent-workspace adopt --root ~/worktrees --kind project-agent --mode writer --json
agent-workspace reconcile --root ~/worktrees --json
agent-workspace reconcile --root ~/worktrees --execute --json
```

Use `--nested-groups` when a direct child is a task directory containing sibling repositories or a checkout containing an independent nested repository. The manager discovers those Git roots one level below each pool child and assigns the parent and children to one durable group. Existing ungrouped records join that group. Newly found siblings inherit an existing member's lease, so discovering a repository cannot postpone recovery of an inactive group or shorten an active lease. A record already assigned to another group makes the request fail without changing any grouping. Parent status excludes registered nested roots because the nested repository has its own recoverability check. The manager removes nested roots before their parent and removes a task directory only when it is empty after the whole group is released.

Reconciliation inspects at most 32 ownership groups or 20 seconds per invocation. It returns every selected record, marking unchecked groups `deferred` with `action: none` and a `continuationAfter` ID. A deferred record is not a cleanliness or safety verdict. Read-only callers continue with `--after ID`; use `--after start` to restart the scan. Executing calls save their cursor in the registry and continue on the next invocation, including after the preceding checkout was released. A group stays together. `--max-groups N` sets the page size and `--budget-ms N` sets the inspection budget up to 40000 milliseconds. Safety snapshots and Git inspection reads share that deadline; a timed-out read retains the checkout and reports `blocked`. Already-started cleanup or owner shutdown finishes through its normal lifecycle rather than being killed at the inspection deadline.

A September 18 Converge pool with 533 directories exposed the former unbounded serial scan. The manager now reads tracked, untracked and ignored status in one Git walk and returns bounded coverage instead of waiting for every checkout. An executing timer makes progress across pages without discarding dirty, unpushed, leased or runtime-owned work. If any member of a group remains runtime-referenced or safety-blocked, cache cleanup for the group does not run.

An expired lease with a pending or running thread, live process, active systemd unit, Docker container or registered Git dependent remains referenced. Thread references come from the invoking Unix person's fleet database and application databases under the fleet ledger directory, plus that person's Remote database. The Remote path comes from `PI_REMOTE_DATA` or the invoking person's registered environment, and `PI_THREAD_DATABASE` adds the calling session's owning database. An existing database that cannot be read blocks cleanup. Finished idle threads do not keep historical checkouts indefinitely; queued input (including held input), active execution claims and persisted wait/cancellation intents do. The lifecycle API's waiting state is a projection: its owner stores a settled model turn as `thread.state='idle'` with `metadata.agentWait`. The snapshot reads that durable intent rather than equating an idle row with completed work. Cleanup checks these durable references again before removing generated caches or the checkout. Work admitted concurrently after the last check still needs ThreadService's startup guard to fail visibly if its checkout is gone.

A linked worktree's common Git directory depends on its parent clone even when the worktree is leased and the parent is clean. The manager retains the parent until the child has been released. An unreadable linked-worktree Git directory stops cleanup rather than treating it as an absent dependency. Cleanup never stops a process, unit or container to obtain cessation evidence, including with `--reap-expired`. That legacy flag does not override live physical custody. Referenced workspaces and groups remain intact, including their caches; clean, unreferenced expired clones can still be released. Use `reconcile --root PATH --execute --after start --json` and follow each returned continuation. Stop unwanted execution through its owning lifecycle, then reconcile its actual cessation.

The safety snapshot (`safety-census.mjs`) runs its whole-host censuses (processes, Docker, user and system systemd managers, thread databases, registered Git dependents, installed references under `/opt`, `/srv` and `/etc/systemd`) in parallel worker threads and returns their union only when every census completed inside the caller's deadline. Any failed or unfinished census refuses the whole snapshot with an explicit error naming it; nothing partial or empty is substituted. Docker containers are inspected in batches rather than one CLI call each, and linked worktrees resolve their common directory from Git's `gitdir`/`commondir` files (Git itself is asked only for other layouts). Installed-reference and thread-database observations are cached beside the registry (`installed-references.v1.json`, `thread-references.v1.json`). An entry is reused only when the device, inode, size, mtime and ctime of every file it depends on (a thread database plus its `-wal` and `-journal`) still match and their last change precedes the original read by more than two seconds, Git's racy-entry rule; otherwise the file is read again. Kernels before Linux 6.13 (converge-kenan runs 6.12) stamp files from a coarse clock, so two writes within one tick (about 4 ms) share mtime and ctime, and a same-length rewrite keeps the whole identity; the window makes that harmless, because any write after a cached read lands at least two seconds after the cached change time. Thread databases are opened read-only with a busy handler bounded by the remaining deadline: concurrent read-only openers of an idle WAL database otherwise fail immediately with `SQLITE_BUSY_RECOVERY` ("database is locked"). `AGENT_WORKSPACE_CENSUS_TIMINGS=1` prints each census's milliseconds to stderr.

Runtime discovery follows the caller's authority. Process inspection covers the caller's UID; user/system unit references and registered Git borrowers are still checked. Systemd unit discovery consumes `list-units --output=json`, never the human table: transient-unit descriptions may contain multiline commands. Invalid JSON, malformed unit records or failed property reads block cleanup. Active units still retain a checkout through their working directory or serialized `ExecStart` references. Docker discovery resolves the selected context, honoring `DOCKER_CONTEXT` before `DOCKER_HOST`. A foreign-owned Unix socket without a filesystem write grant is outside that account's Docker authority, so it is not queried. This lets ordinary accounts release workspaces on hosts with an administrator-only Docker daemon without granting Docker access. Writable local sockets, rootless daemons and remote endpoints still require a complete container snapshot. Broken context resolution, inaccessible owned sockets, missing sockets, unexpected filesystem errors and failed daemon queries block cleanup. An administrator who attaches containers to another person's private checkout owns that cross-account reference; ordinary release does not inspect the administrator's daemon.

Reference-clone maintenance is reconciled before lease and group checks, including for active workspaces. Registration and adoption apply it too. On September 10, disabling graph reads alone left graph writes enabled: a normal Converge publication commit produced `.git/gc.log`, which then suppressed later automatic Git cleanup. The manager now disables both operations and automatic clone maintenance. It removes a `gc.log` only when every line is one of the diagnosed disabled-graph or unreachable-loose-object warnings and no `gc.pid` remains. Unknown failures stay in place and block reconciliation for inspection. Mutable alternate chains are repaired by importing HEAD, every ref and reflog tip into independent mirror custody under the mirror fence, pinning those object tips, then atomically replacing the clone's alternates file. A failed import leaves the previous alternates intact. Dry runs report `would-import-durable-mirror` without importing or replacing anything. Existing independent mirror borrowers report `durable-mirror`; successful repairs report `imported-durable-mirror`. Clone refs, worktrees, source custody, leases and cache policy remain unchanged. This operation does not recover objects already lost before maintenance; an unavailable source object produces an explicit failure and retains the checkout.

Inspect or repair maintenance configuration and object custody, without lease changes, cache cleanup, checkout deletion or draining the disposal queue:

```sh
agent-workspace maintain --root /absolute/workspaces --budget-ms 10000 --max-records 16 --json
# Execute only after the actual prior operation has a canonical settled reconciliation:
agent-workspace maintain --path /absolute/checkout --budget-ms 10000 --max-records 16 --execute --operation-id UUID --prior-state /absolute/prior.json --prior-state-sha256 SHA256 --json
```

The operation selects registered reference clones and reports changed configuration keys, warning-log disposition and object-custody status. Missing paths, ordinary clones and linked worktrees are not modified. Mirrors own independent object stores; they never inherit another repository's alternates.

An executing reconcile also forgets released records older than thirty days whose trees are gone, so the registry stays the size of the pool's recent history rather than its whole past. With `--root`, history pruning and preexisting disposal collection are scoped to that root's registered workspace IDs. Unrelated or unidentifiable disposal entries remain for an unscoped lifecycle owner.

The registry defaults to `~/.local/state/pi-workspaces/registry.sqlite3`. Set `PI_WORKSPACE_STATE` when a host needs another persistent location. Removed trees are atomically moved into the registry's `gc/` directory and deleted by a detached low-priority collector, so large dependency trees disappear from the active pool immediately.

### Explicit sparse creation for large repositories

For clone creation, repeat `--sparse-pattern PATTERN` to select Git non-cone sparse-checkout patterns. Quote globs; e.g. `--sparse-pattern '*.md' --sparse-pattern 'requirements*.txt'`. These patterns are written before the first checkout; excluded archives are not materialized. The selected policy is part of the creation request identity, so retries must use exactly the same selection; the timeout may change. Omitting this flag retains full-checkout behavior and compatibility with existing reservations. Linked worktree creation rejects this flag rather than changing a shared repository configuration.

New clone checkouts publish atomically from tool-owned staging. Repeat the original create command to observe or retry the durable job; a failed attempt removes only its private candidate. An existing materialized pending checkout from an earlier release is never implicitly disposable: resumption verifies untouched files and refuses modified or truncated files rather than guessing they are safe to overwrite. Finalization accepts a clean descendant in the correct writer/review mode, including an intentionally repaired sparse checkout; it does not reset an index, delete files, or force a branch. A truncated file must be preserved or explicitly repaired by its owner before resumption/finalization. Increasing the creation budget cannot by itself repair already damaged files.


## Capacity recovery of terminal source preparation

Repeating an ordinary creation after disk-space recovery can start a new capacity-recovery generation. Only a typed disk-capacity refusal (or the exact pre-typed deployed disk-refusal receipt) is eligible. The fresh filesystem observation and original job ID/refusal are retained in `source-preparations/recoveries/` and the successor job request. Original request, progress and terminal result files never change. The active preparation pointer selects the new generation under the destination preparation fence; submission remains single-writer under the source job fence.

The owned `capacity-detail` diagnostic may be followed by the finite `capacity-refresh` observation from fair sampling. Recovery validates both structured suffixes and preserves their original bytes; malformed, unknown or extra diagnostics remain terminal. These observations never grant admission.

Recovery eligibility is evidence for a new attempt, never admission. The durable worker recomputes the source forecast, filesystem/reservation/inode guards and source custody under the existing capacity fence. Checkout registration checks them again. Ordinary source-only 8 GiB headroom / 512 MiB growth is unchanged. Forecasts are retained before admission, keyed by immutable source, repository, custody stamp, sparse selection, intent and allocation unit; refusals retain the exact capacity snapshot. Every explicit retry first attempts a bounded current forecast and fresh fenced admission; a fresh refusal stays failed without changing the original job. A slow forecast transfers to a linked durable generation to finish the same guards. Historical rounded requirements never gate retries. Non-capacity failures remain terminal. Interrupted workers still resume the same job identity; they are distinct from a terminal capacity recovery. A ready/failed-fast worker now has its deterministic job identity retained before submission too.

## Retained custody without future build growth

`retire-growth` is an explicit owner lifecycle transition, not disposal or a smaller
historical allocation. It keeps the original plan's growth/construction/baseline,
physical allocation sample, source, refs, unpublished work, ignored runtime trees
and Git borrowers. Admission charges zero **future** growth for that row while
keeping its entire existing headroom floor. It never calls release, cache stripping,
service control or Git configuration writes. Unestimated/pending/unknown states
cannot retire; price an unestimated plan through its existing supported route first.

1. Obtain the current exact binding (no host walk):
   `agent-workspace growth-status --id ID --path PATH --json`.
   A stale sample requires only a targeted `measure-capacity --id ID` refresh.
2. The current owner supplies a disposition JSON, with `binding` copied exactly
   from that result, plus:
   ```json
   {"kind":"retire-future-growth","retainedUse":"source","remainingGrowthBytes":0,
    "growthWriters":"none","writingLease":"retire","observedAt":1792160000000,
    "reason":"future local build/install/generation work completed",
    "ownerEvidence":"exact current-owner terminal disposition receipt","binding":{}}
   ```
   `retainedUse` is `source` or `runtime` custody, not permission to assume a live
   process is read-only. Use the actual current millisecond observation time;
   the example's time and empty binding are intentionally not executable evidence.
3. Execute `agent-workspace retire-growth --id ID --path PATH --owner OWNER
   --disposition FILE --disposition-sha256 SHA256 --json`.

The SHA binds the exact disposition bytes. Current owner, working/durable source,
HEAD, path/id, state/update epoch, writing lease, root device/inode, exact plan and
sample SHA, and registered borrower epochs are compare-and-swapped under lifecycle
and filesystem locks. The successful sample and owner observation must be current
(15 minutes) and not future-dated. A still-valid or expired writing lease may be
explicitly relinquished with `writingLease:retire`; expiration itself proves nothing.
The transition atomically sets that lease to zero and journals its prior value.
All other workspace custody fields remain unchanged. The append-only
`workspace_growth_retirement` journal keeps the exact old/new plan, sample,
workspace record, disposition bytes and relevant safety observations. Replays fail
with `growth-already-retired`; stale inputs never silently refresh or mutate.

Strict, bounded observation checks all-UID processes (through passwordless root
read-only `/proc` observation), writable file descriptors, containers, user/system
units and unfinished thread custody. Inspection errors, active references, active
borrower leases and unknown linked worktrees refuse retirement. Registered dormant
linked/alternate borrowers are preserved without treating their topology as proof
of read-only use; their lifecycle fences and runtime paths are checked too. No raw
process argument inventory is returned or journalled. Missing root observation
privilege yields `growth-writer-unknown`, not an empty-safe result.

Ordinary heartbeat, create replay, registration/adoption and reassignment cannot
resume retired writing; ordinary release/reconcile, including group reaping, cannot
strip or delete retained custody. A linked borrower cannot renew/register/reassign
while its shared Git parent is retained. These are custody guards, not publication
or deletion evidence. Resume the parent first if its shared Git objects will grow.

To resume growth, take fresh priced admission explicitly:
`agent-workspace resume-growth --id ID --owner OWNER --expected-plan-sha256 SHA
--intent budgeted --headroom-gib N --growth-mib N --json`.
This uses the current root-bound sample, original baseline and normal filesystem
admission; headroom cannot fall. New declared remaining growth is added to sampled
consumed growth, and the prior plan remains in `workspace_capacity_repricing`.
Refusal preserves retirement. Successful admission removes the retirement marker;
only then can normal writing/heartbeat and later ordinary disposal proceed. This
is admission accounting, not a filesystem quota or authority to resume stopped work.

Focused proof: `node --test tools/agent-workspace/growth-lifecycle.test.mjs`.
Managed-host read-only process observer proof:
`node tools/agent-workspace/growth-process-installed.mjs` (private disposable fixture).

Retirement shares one 25-second observation/lock budget; exhausted dependency observation returns `growth-observation-timeout`, never permission to retire. Dependency topology streams only registry identity/path/type columns, not cache or creation payloads. Unreadable alternate-object metadata refuses rather than disappearing from the dependency graph.


### Measured active future-growth reduction

An active owning writer may reduce its declared **remaining** growth without retiring
its writing lease or losing source custody. First run `measure-capacity`, then obtain
`growth-status --id ID --path PATH --json`. Use the returned exact `binding` in a JSON
file with `kind: "reduce-active-future-growth"`, positive `remainingGrowthBytes`,
`reason`, `ownerEvidence` and current epoch-millisecond `observedAt`. The owner evidence
must account for that writer's remaining work; this is not permission to discount
another workspace or work outside its allocation. Hash the exact JSON bytes.

```
agent-workspace reprice-capacity --id ID --path PATH --owner OWNER \
  --intent budgeted --headroom-gib 8 --growth-mib 64 \
  --reduction /absolute/reduction.json --reduction-sha256 SHA256 --json
```

The example preserves an existing **budgeted** intent. For an already source-only writer use `--intent source-only`; reducing an allowance never proves that a build or database writer stopped. Active reduction supports source-only→source-only, source-only→budgeted and budgeted→budgeted only. Budgeted→source-only returns typed `capacity-intent-downgrade` with a supported next action, without changing any record. Completed work with no future writes uses `retire-growth`, not an intent downgrade.

This opt-in extends the existing repricing interface, not a second ledger. It requires
an active unexpired owning lease, positive remaining allowance, a lower total growth
budget, immutable source and an exact current plan/sample/root/HEAD/borrower binding.
Actual allocation is remeasured inside the filesystem fence. The larger of the bound
cache and this current measurement is used, so an unrefreshed deletion cannot silently
create credit. Both measurements remain in the evidence. The total becomes measured
growth above the unchanged completion baseline plus the
requested remaining allowance. Existing conservative measurement credit margins are
retained, so released reservation is **not** simply old allowance minus new allowance.
The source/import/construction baseline, other writers, original sample, workspace row
and writing lease do not change. The existing workspace/group and filesystem fences,
SQLite CAS/journal, inode admission and all other reservations still apply; the
previous headroom cannot fall, and reduction additionally retains an 8 GiB minimum.
The full declaration and SHA are retained in the repricing journal's new plan.
Stale/foreign evidence, expired lease, invalid amount, retired source or unsafe admission
refuses without mutation. Changed input after success needs a fresh binding; an old
reduction is never replayed. Zero-future-growth retirement remains `retire-growth`.


A pure active reduction is admitted by **monotonicity**, not as a fresh capacity grant.
Within the same filesystem fence and SQLite transaction, the tool compares old and new
whole-host requirements using one filesystem observation and the same set of other
reservations. The future bill and total requirement must strictly decrease; the
capacity deficit must not worsen. The response records both requirements/deficits and
`newWritesAuthorized: false`. It may succeed while already oversubscribed because it
removes an existing liability without allocating space or expanding the writer's budget.
The existing headroom (at least 8 GiB), inode guard, baseline, source and writing lease
remain protected. Headroom increases which outweigh the savings, nondecreases and stale
or foreign declarations refuse. Fresh allocations and budget increases still require
full absolute free-space admission. No nominal or manual credit is inferred from this
operation; the measured journal owns the released reservation.

### Ending completed retained custody

Retiring future growth preserves source/runtime custody. Plain release and automatic
reconciliation keep that retention. When the owner finishes using the checkout,
`growth-status --id ID --path PATH --json` supplies its current plan hash. Use:

```sh
agent-workspace release --id ID --end-retention --owner OWNER --expected-plan-sha256 SHA --json
```

This is terminal release, with no writing/growth admission. It requires retired
future growth, a retired writing lease, current owner/plan binding and no runtime,
thread, process, registered or unregistered borrower, dirty or unpublished source
obligation. It never stops references. A protected result exits2 and preserves
custody. A qualified release journals the original record, capacity plan and safety
inspection, preserves retirement history, removes only the released checkout and
returns its terminal record. Group retention needs a per-member disposition and is
refused here. Repeating an already completed release is safe.

### Retire a classified cache without disposing source

`cache-plan` binds one exact registered ended/expired workspace and one relative
cache directory. `retire-cache` consumes that independently retained request and
its byte SHA256. Neither command cleans source or edits the original lifecycle,
capacity plan, creation/repricing/retirement histories or Git custody.

```sh
agent-workspace cache-plan --id ID --path ABS_WORKSPACE --owner OWNER \
  --cache node_modules --classification node-dependencies \
  --operation-id UNIQUE_ID --evidence 'Ended owner/use evidence' --json > plan.json
jq '.value.request' plan.json > request.json
sha256sum request.json
agent-workspace retire-cache --id ID --path ABS_WORKSPACE --owner OWNER \
  --request ABS_REQUEST_FILE --request-sha256 EXACT_BYTE_SHA --json
```

Keep plan/request outside the workspace. A plan is a no-effect request, not a
safety or physical-capacity result. Run each selected directory independently.
`node-dependencies` requires an existing declared ignored `node_modules` tree
and tracked package manifest/lockfile. `declared-build-cache` additionally requires
that exact relative output in the tracked `.agent-workspace-caches` at HEAD.
Tracked content, source/evidence paths, aliased roots, unregistered/registered Git
borrowers and active leases refuse. Dirty/unpublished source and unclassified
ignored evidence outside the selected cache remain byte-for-byte in place.
Dependency symlinks are unlinked without following them; shared hardlinks never
claim freed physical blocks. The existing generated-retirement engine retains
inode inventory and restart-safe staging/deletion intent. Original record/plan/
measurement are separately journaled; the live measurement is invalidated, never
converted into implicit capacity credit. Recreated output is not removed by a
completed-operation replay. A new output needs a new request and operation ID.

Fresh all-UID read/write-FD, process, native/container/systemd, Legacy queued-thread
and Kenan Stack running-tool/live-worker reference observations protect every
cache-removal consumer, including release/reconcile and source materialization.
A queue error is a protected typed result, never an empty queue. The operator's
own tool call is identified from its process ancestry and exact arguments, not a
caller-selected exclusion.

Each operation has a35s observation/lock budget and1000000-entry inventory limit;
limit or safety failures retain the request/journal for an explicit same-operation
continuation. Exit0 means completed, exit2 is explicit refusal/error.

The journal (registry table `workspace_generated_retirement`) is written before
the move and records the operation, workspace, request SHA256, staging path and
each entry's phase (planned, deleting, removed). After a crash at any point,
re-running the identical `retire-cache` command (same request bytes and SHA,
same owner) resumes: it moves the cache if the move had not happened, then
deletes only the inventoried entries of that staging directory. Different
request bytes for the same operation, a second operation on a workspace with a
pending one, or another owner are refused. A completed operation replays its
receipt (`replayed: true`). `removedAllocatedBytes` is the pre-move inventory;
`freedBytes` is what deletion actually freed: the blocks of every inode whose
last link it removed, read at unlink time and checkpointed every 2 s. Entries an
interrupted run removed after its last checkpoint are counted from the inventory
and reported separately as `freedBytesEstimatedAfterInterruption`.
`filesystemAvailableBytesAfter` is the free space seen at completion.

`retire-cache-status (--id ID|--stage STAGING_NAME) --json` is read-only. It
lists cache retirement journals for a workspace, or the one owning a staging
directory under `generated-retirement/`, with phase, whether staging is still
present, the receipt, and for a pending operation the exact resume command and
the stored request bytes (requests recorded from this version on), so a lost
request file can be rewritten byte-exactly. `cache-retirement-crash.test.mjs`
kills the process before the move, right after it and mid-delete, and proves the
resume, the freed bytes, the refusals and the third-run replay. `node tools/agent-workspace/cache-retirement-installed.mjs`
runs a disposable native read-FD refusal then cache-only preservation proof.

`cache-safety --id ID --path PATH --owner OWNER --cache RELATIVE --json` is the read-only current
borrower observation. It reports exact IDs/kinds and unknowns, without cache
classification, inode qualification or retirement. Reference errors retain those
same identifiers rather than a generic denial. Live worker conversations and
completed tool history are source intent; running tool calls remain physical
consumers. No Kenan Stack conversation or agent state is changed.

An explicit owner `release` separates lease completion from physical disposition.
Its JSON includes `leaseRelease` and `physicalDisposition`. Durable/pushed source
qualification may transfer the mutable checkout after that terminal request;
pure prose intent remains with canonical input/task and exact durable source.
Dirty/unpublished/unclassified data and native/runtime/Git borrowers still retain
it. Automatic expiry alone does not authorize this source-intent transfer.
Completed cache journals explicitly record `retired-regenerable`; later dependency
regeneration needs an admitted writing lease. Full source materialization retains
its own strict source-custody contract.

For public source from private integrated ancestry, fetch the exact public parent,
then use `bash tools/agent-workspace/public-source REMOTE_URL PUBLIC_PARENT SOURCE_COMMIT`.
It projects only this component through a separate index, proves other public
paths unchanged, and uses one ordinary fast-forward push. Its private source
parents never transfer; a divergent public head is an explicit Git error.

Large cache retirement uses a bounded manifest with direct inode comparisons and
per-entry unlink/rmdir. It never recursively deletes unlisted/recreated content;
deadline expiry retains deleting intent and the same-operation continuation.
Single-member retirement validates at its rename/deletion boundary; repeated
pre-journal authorization and redundant whole-manifest comparison are eliminated.

For pending staging, use read-only
`cache-safety --id ID --path PATH --owner OWNER --request FILE --request-sha256 SHA --json`
with the SAME retained request. It derives the original stage identity through the
same engine transform, observes source+stage runtime/queued/Git references, and
makes no plan, lease, journal or cache transition. It never infers that an absent
original cache means retirement completed. Existing `--cache RELATIVE` mode is
an initial cache-path observation and cannot substitute for pending-stage proof.

The current path lookup uses literal-q jsonb_path_exists predicates over exact
eligible payloads. Literal punctuation is data, not a regular expression. Five
positive/control path roots over one92-candidate READONLY snapshot matched the
prior string-leaf predicate with zero mismatches. The installed eligible-ID
baseline also passed; this predicate change is an equivalent optimization, not
a claim that it caused every historical query-timeout recovery.

For an already-deleting cache journal, binding/manifest inspection is read-only;
the complete native/FD/queue/Git verdict is taken once at the actual unlink
boundary. A previously completed rename does not trigger another native verdict.
A planned rename retains its separate boundary authorization. Source retirement
keeps its initial authorization. This removes repeated no-effect observation
cost without relaxing the35s budget or physical/reference/replacement checks.

Component public-source publication pushes its immutable projected object directly; it does not manufacture a local workspace branch. Existing branches remain preserved in their independent durable repositories. This removes unnecessary local-only public projection refs that otherwise honestly prevent ordinary source release.

### Interrupted maintenance: checkpoint protocol

`maintain` is reference-clone Git/object-custody maintenance, not cache cleanup or reservation retirement. Explicit finite budgets are mandatory: 1000–20000ms and 1–32 records. The parent bounds the entire child, including registry open, prior-evidence reads, Git, locks, fsync/checkpoint work and inherited output pipes; command budget plus 1000ms is the hard worker limit. The parent reaps the owned worker process group on normal return as well as timeout, so a terminated Git wrapper cannot leave inherited-pipe grandchildren running. Each resource lock waits at most 100ms in maintenance, and each Git command receives remaining budget capped at 2000ms. The installed source and journal-module hashes bind the exact operation.

`maintenance-journal.sqlite3` beside the selected registry is canonical, not final stdout. FULL synchronous transactions persist selected record identity, frozen inputs, prepared→uncertain-before-dispatch→settled effects, transition events and atomic record-result/cursor checkpoints. Unknown state or identity mismatch is an explicit error. Output contains at most 32 record results. Exit75 is pending/uncertain, not success. An absent or malformed journal, empty stdout, timeout, failed process or cgroup cessation does not establish that an effect did not happen.

Resume uses the **same** operation ID, scope, source and prior-evidence hash with `--resume`. Before any further traversal, uncertain effects require `--resume --reconcile`; reconciliation only observes exact postconditions under existing ownership locks and never performs the effect. Unsupported, partial or unknown postconditions stay uncertain. A separate `--resume` then consumes the settled cursor; it does not reset it. Source changes need an explicit migration/disposition rather than silently resuming under different code. Preserve the original operation, receipts and journal.

The mandatory prior-state JSON is `maintenance-canonical-reconciliation` with the original operation ID, `state: settled`, absolute canonical journal, and complete nonempty effects. Each applied effect carries its ID, an absolute `canonicalReceipt` and SHA256. Receipts are `maintenance-settled-effect` with operation/effect IDs plus digests of the canonical spec/result. The validator reads the canonical journal read-only, requires its settled operation, exact same selected scope and exact complete effect set, verifies every receipt hash and binding, and refuses unknown/omitted/conflicting evidence. A convenient summary alone is not authority. In particular the original e2e35 retained-format report and its zero-byte stdout are **indeterminate**, not a journal or completed cleanup; the owning reconciliation must not be replaced by a new maintenance run.

Offline regressions exercise actual SIGKILL windows, typed SQL state transitions, exact cursor resume, forged/omitted receipts, the disposable Git CLI, partial command timeout with inherited-pipe children, and a permanently blocked synchronous prior-state read. Existing fetched-object and active-lease/unpublished-work checks retain their assertions under explicit fixture-only protocol inputs.

## Cleanup-only pre-import physical reclaim gate

Cleanup/release reconciliation adopts 637's `cleanup-custody-budget.mjs` before `maintainReferenceClone`/`prepareMirror`. Complete borrowed object upper bound versus exclusive nlink1 allocated blocks refuses nonpositive reclaim; positive forecast still requires an independently reserved import peak and refuses `CUSTODY_IMPORT_RESERVATION_REQUIRED`. Unknown is never zero and forecast grants no physical credit. Normal create/register remain unchanged; actual public CLI fixture proves cleanup refusal before Git config/mirror mutation while normal borrowed registration succeeds. Physical retirement remains ceased.

`custody-import-budget.mjs` retains independently qualified finite measurement helpers; it is NOT wired into normal create/register/maintenance admission. Tools-only deploy helper `deploy-custody-gate.mjs` accepts a fresh exact selected recovery inventory or known selected commit inventory, publishes a staged qualified immutable successor by host-lock/CAS, preserves every other tool/dependency and retains rollback. It does not execute cleanup or mutate the workspace registry.


### Source-import capacity isolation
Source import durably reserves its complete forecast under the device fence before Git work. Slow mirror waits/fetches run outside that fence. All other admissions count that liability; the same destination cannot replace another original receipt. Interrupted imports retain liability until the original operation reconciles (never by time expiry). Schema 2 refuses older readers: deployment must quiesce old mutable helpers first, and rollback must retain reservation-aware code. Completion/failure settles only the matching destination+receipt under the fence; final workspace admission rechecks current capacity.

Converge tools-only source deployment uses `install-capacity-host REPO FULL_RECOVERED_BASE_SHA EXPECTED_SELECTED_ROOT RECEIPT` (committed clean source). This installs `admission-launcher` and `admission-tmpfiles.conf`, then obtains the standard host deployment lock followed by exclusive CLI admission. Existing detached helpers finish naturally under an 80-second drain; failure releases admission without changing the selected component. New invocations resolve `main` only after acquiring shared admission, and never hold exclusive capacity while transporting Git. Selection prepares a schema2-aware serial-transport rollback before atomic publication. Never select the schema1 predecessor against a schema2 registry. `*.serial-rollback` retains all schema2 accounting but deliberately serializes import as the reversible fallback. Other tools, runtime services, and all workspace records are preserved.

### READY source continuation after shared mirror writes

A completed immutable source request is not invalidated just because unrelated imports or mirror configuration writes changed the global object-store stamp. On a stale stamp, the creator refreshes the exact commit's independent closure proof and both source/mirror checkout-filter guards within a 1500ms foreground budget. A successful refresh reuses the original conservative pricing and job identity, without an import or editing terminal job receipts; final workspace admission still recomputes free space and reservations. Missing/changed closure, alternates, changed commit, filters or an exhausted proof budget do not authorize reuse. Slow or genuinely missing custody follows ordinary durable preparation. The original READY outcome remains immutable.

### Resumable mirror contention

Exact exhausted mirror-lock acquisition waits, on `mirror:<path>` or the per-commit `mirror-source:<path>:<commit>`, are typed `workspace-mirror-lock-busy`. Repeating the original create links a successor generation through the existing recovery record, retaining original terminal bytes/job/attempt. Legacy generic receipts recover only with the exact exhausted-wait grammar bound to that request’s canonical mirror. Action errors, settlement failures, unknown custody and failed flock execution never qualify. The successor rechecks capacity/source custody; no lock is evicted and no reservation is bypassed.

### Recent ancestral import custody
Before the existing 16 lexical mirror-tip fallback, import pricing checks at most 128 first-parent ancestors of the exact requested source (including that source). Only an independently full-closure-qualified ancestor can exclude history. This avoids enumerating years of objects merely because the first lexical mirror refs are stale. Missing/incomplete ancestors earn no credit; no recent match retains conservative existing full-history pricing, including explicit timeout/unknown failure. The existing command deadline, complete size accounting, sparse checkout charge, growth/headroom, original preparation receipts and operation identities are unchanged.

## Terminal retained source headroom

`reduce-retained-headroom --id ID --path PATH --owner OWNER --disposition FILE --disposition-sha256 SHA --json` lowers only the retained operating floor (minimum 8GiB). Obtain a fresh `growth-status` binding after retiring growth. Disposition kind is `reduce-retained-headroom`, retainedUse `source`, growthWriters/futureWrites `none`, sourceCustody `remote-verified`, sourceEvidence/reason/ownerEvidence nonempty, observedAt current and headroomBytes strictly lower. Every local branch and HEAD must be covered by freshly read remote heads; tracking refs alone never qualify. Unknown, executing or future-writing borrowers refuse. Complete inactive retained borrowers remain physically preserved and are observed under borrower locks, source custody and native queue checks. No application/release effect or new writing authority follows. Future writes require new full capacity admission; retained registration/heartbeat cannot reactivate.

`register --retained` creates preservation-only referenced custody with exactly zero writing lease; no maintenance or files are changed. Ordinary NEW registration defaults to six hours (existing ordinary registration does not renew). `custody-status --id ID --path PATH --json` returns the exact source/root/owner binding. For an already accidentally active **unpriced** record, `end-writing` with the same exact flags and a fresh retire-future-growth disposition ends its lease atomically and journals source preservation. Priced records use retire-growth. Neither command deletes files or grants a new writer.

The narrow capacity publisher optionally accepts a full source commit after its reservation-aware rollback argument, allowing immutable bootstrap source custody without checking out or modifying a shared canonical writer. Installed preimage, complete other-tool inventory, exclusive admission and deploy fence still apply.

Terminal headroom is a no-file-effect, no-new-writing capacity transition. Its queue check uses current streaming tool reservations (`physical-checkout`) rather than historical conversational source intent (`source`); merely discussing a path is not a current writer. Complete privileged current process/FD, units/containers, exact lease/borrower locks and future admission fences remain mandatory. `terminal-safety --id ID --path PATH --owner OWNER --json` observes these conditions without mutation. Launch exact CLI directly from the native Bash tool when possible: detached systemd loses authenticated caller ancestry and conservatively includes that tool as a competing reference. Physical deletion/source retirement keeps its original stricter source-intent check.

### Terminal source job abandonment
`source-job-abandon --job-id SHA256 --owner OWNER --permit-sha256 SHA256 --json`
is an explicit terminal **ABANDONED**, never a completed preparation. A finite
root-owned mode600 permit in `/etc/pi-stack/source-job-abandon/JOB.json` binds
one original request/attempt byte SHA, unit, adopted workspace, actual native
applying agent/goal and channel. The repair operator creates this permit only
from authenticated manager custody. It is not a generic retry/cleanup grant.
The native streaming Bash caller, supported owner adoption, retired zero-lease
custody and HEAD must match. Live/unknown unit/process/FD/cgroup holders refuse.
An absent collected unit alone is not proof: retained prior PID0/empty-cgroup
custody plus fresh privileged whole-host and cgroup census are required.
The original submission lock serializes abandonment with restart admission.
The exclusive immutable result retains prior progress and uncertainty as
`historicalEffects: UNKNOWN_RETAINED`, `automaticRetry: false`; all original
request/attempt/command/progress bytes stay untouched. Matching reapplication
returns the original result without another effect. `job-status` shows abandoned
with exit2, never ready; create cannot retry the same abandoned identity. The
contention producer clears via its normal immutable-result check. No source,
lease, reservation, provider outcome or capacity credit is invented.

### Source import commit boundary

A successful Git fetch is object transport, not source custody acceptance. The importer verifies the exact independently owned closure, creates a missing request-bound source ref by no-overwrite CAS, verifies readback, and uses Git object/reference fsync before READY. Crash-left objects may repair only the requested immutable commit; a conflicting ref or missing closure fails without overwriting custody or substituting donor HEAD. Original failed job receipts remain unchanged.

`growth-status --id ID --path PATH` requires both selectors to bind custody. `reprice-capacity (--id ID|--path PATH)` accepts exactly one.

Local shallow donors require explicit `fetch --update-shallow`: Git otherwise exits zero while rejecting the destination ref, leaving unreferenced objects without the donor's shallow boundary. The shared independent mirror imports that explicit boundary, then verifies closure and exact ref readback; it never invents parent objects or treats missing history as complete. Real shallow-donor regression retains this prior RED.

### Ephemeral execution capacity (non-Git)

Use `execution-reserve --root ABS_EMPTY_OWNED_DIRECTORY --owner OWNER --operation-id UUID --growth-mib N --headroom-gib 8 --holder-pid PID --json` **before starting a producer**. The PID must have a stable native service/scope cgroup. The explicit positive growth allowance is an `operator-budget`, not a measured peak (`measuredPeakBytes: null`); unknown/unestimated growth is refused until an operator supplies a conservative allowance. This reserves future growth on the root's actual filesystem in the existing `workspace_capacity` table and under the exact device admission lock. Ordinary workspace creators, source imports and repricing consume it too. No Git workspace registration, new registry, lease expiry, measurement-based credit, capacity waiver or PG execution occurs.

Persist the returned `id`, `owner`, `root`, `planSha256` and `holder` in the consumer's existing operation receipt. `execution-status --id execution:UUID --json` reads that exact original. Replaying an identical operation returns its original result; changed parameters conflict and a released operation cannot authorize a new run. Root must be empty, owned and canonical, with unchanged device/inode and holder identity at admission.

After stopping the producer and deleting its disposable state, call `execution-release --id execution:UUID --owner OWNER --expected-plan-sha256 SHA --json`. **Inside a still-live native holder it must refuse**. The outer native qualification finalizer calls it after observing the original job terminal. Release independently requires root absence plus privileged complete original-cgroup/process census (including descendants), not a caller assertion or PG-PID-only observation. Unknown state or a changed boot retains the full reservation; no timer clears it. Released rows retain the original plan, admission and cessation receipt, and contribute zero future liability. This is cooperative disk admission, not a filesystem quota or a measured workload-size guarantee. Consumer admission failure must prevent `initdb`; abandoned/still-live state remains owned repair work.

Regression: `node --test tools/agent-workspace/execution-capacity.test.mjs` covers actual concurrent CLI admission, shared workspace accounting, restart, identity conflicts, invalid budgets/roots, live cgroups and conservative unknown cessation. Installation uses the maintained selective `install-capacity-host`/`capacity-deploy.mjs` path; the serial rollback stays execution-reservation-aware.

## Frozen source handoff and scoped writer custody

A handoff announcement, owner row, or compiler seal does not revoke filesystem
write access. `writer-run` is the supported mutable-workspace writer: it requires
exact `--id --path --owner --expected-head`, `--command-json '["exe","arg"]'`
and `--timeout-ms N` (1..3600000). It checks active lease/writer/growth custody
under the existing group/checkout locks and retains those locks through the
foreground child. Children inherit lock descriptions; bounded process-group
cessation precedes release. `reassign` uses the same locks. Another checkout is
not locked. Child exit/output is returned in the result, not inferred success.
This is cooperative writer admission, **not protection against raw editors**.

For an actual immutable handoff, prepare a **separately admitted source-only
snapshot workspace** at the exact source SHA. Private Git custody and the normal
managed, independent mirror alternate are supported. For a managed alternate,
the freezer preserves the minimal borrowed object boundary with permanent,
create-or-verify mirror refs under `refs/pi-workspace-frozen/WORKSPACE/HEAD/`.
Local commit, tree and blob objects remain inside the immutable snapshot. Full
source and mirror-boundary closure is checked before and after pin publication;
ordinary mirror pruning therefore cannot remove the required borrowed objects.
There is no object copy, repack or full-history growth charge. These refs remain
preservation custody even after an explicit thaw; no capacity credit is implied.
Unmanaged or nested alternates, shared worktrees, shallow/grafted/replaced Git,
hardlinked regular files, nested mounts, external symlinks and generated,
ignored or untracked files refuse. Do not freeze a compiler/build workspace.

```
agent-workspace freeze-source --id SNAPSHOT_ID --path SNAPSHOT_PATH \
  --owner SOURCE_OWNER --expected-head FULL_SHA --recipient BUILD_OWNER \
  --authorization HANDOFF_EVIDENCE --json
```

Under the checkout lock and the managed mirror's mutation lock, eligibility is
fully validated before any intent fence is written. An eligibility refusal leaves
no writer fence. This then freezes the complete private snapshot's regular
files/directories using Linux immutable flags and transfers recorded custody
only after post-freeze HEAD/clean-tree validation. Ordinary raw writes, Git
commits, deletes and renames fail with EPERM, without chmod/chown or touching
other writers. Internal symlinks are not followed; their immutable parent
protects names. Root/sudo remains an authorized operator, not a defended-against
adversary. A privileged, fsynced original-flags journal is retained at
`/var/lib/agent-workspace/frozen-source/`; failures roll back only immutable bits
this transaction added, preserving existing flags. Interrupted operations retain
the original journal and fail closed via the `.git/pi-frozen-handoff.json`
intent. Never delete that marker to manufacture a completed freeze.

The consumer must create a separately admitted **writable build workspace** from
this frozen exact Git source with the normal build growth allowance; it retains
bootstrap source pins and actual HEAD checks. Compile there, not in the frozen
snapshot. `writer-run` refuses the frozen source even for the recipient.
7ed's next-new-root handoff uses this source-snapshot/build-root separation;
existing a7 compiler roots and in-flight receipts are explicitly unchanged.
The snapshot and its lifetime have independent preservation custody, not capacity
credit. Cleanup cannot silently remove immutable source. Explicit rollback:
`thaw-source --id SNAPSHOT_ID --path SNAPSHOT_PATH --owner CURRENT_OWNER
--expected-head FULL_SHA --json` replays only that exact original-flags journal,
under custody locks, and keeps recipient ownership. A historical rejected intent
without a journal is cleared only after a complete inode-bound observation proves
that no immutable flags remain; unknown physical custody retains the fence.
A failed freeze reconciles its original journal before removing its intent.
It is a deliberate new
mutable-source operation, never a timer-based waiver.

Focused qualification: `node --test tools/agent-workspace/writer-custody.test.mjs
 tools/agent-workspace/freeze-eligibility.test.mjs
 tools/agent-workspace/frozen-object-custody.test.mjs
 tools/agent-workspace/bounded-command.test.mjs` and
`sudo -n python3 tools/agent-workspace/frozen-source.test.py`.
Publication uses the existing tools-only `install-capacity-host` selective
installer and exact installed-base CAS. No provider/product publication follows.
Rollback the tool selection only after explicitly reconciling/thawing any new
frozen snapshots; older tooling does not understand their intent markers.

### Exact native caller identity

Kenan Stack binds SDK `callId`, actual agent and channel into the description of the root-created system-manager scope **before** dropping privileges. The workspace observer reads the actual caller's `/proc` cgroup and its system-manager scope Description/ControlGroup/Transient/ActiveState, requiring a matching root server ancestor and exact channel. It then matches exact agent/conversation and streaming message part callId. Ambiguous matches exempt nothing. Shell expansion, quoting and final exec cannot change that operation identity; editable shell environment grants no exemption. Another worker or another same-agent tool call remains protected. There is no command-substring fallback. Install native scope-identity propagation locally before this observer; an older runtime remains conservative and may report its own tool as a reference until upgraded.

## Owner-directed terminal preparation finalizer

`node tools/agent-workspace/terminal-finalizer.mjs REQUEST.json SHA256` is the
non-deleting preparation-finalizer entry point. Call it from the **outer**
preparation owner after its native job has completed, not from the live holder.
It does not infer completion from an expired lease, archived worker, or elapsed
time. The publication owner adopts this entry point in its next maintenance
qualification; adding source does not claim deployment or activate any timer.

The hash-bound request is `kind: "terminal-growth-finalization"`, exact `owner`
and absolute `path`, `frozen: false`, `futureWrites: "none"`,
`deleteSource: false`, the original execution `holder` (PID/startTime/bootId/
cgroup/UID as recorded at launch), `units: [{unit, manager: "user" | "system",
invocationId}]`, and `disposition`: the **unchanged current** native
`retire-future-growth` owner disposition, including full `growth-status.binding`,
`observedAt`, source retention and evidence. Obtain a fresh complete allocation
sample before sealing the binding. Missing/changed/frozen/foreign custody refuses.
Do not fabricate a holder from a PID observed after the fact.

Every declared unit must be the exact successful `oneshot`, `RemainAfterExit=yes`,
`Restart=no`, active/exited invocation with MainPID=ControlPID=0 and empty cgroup,
no stop hooks and no trigger relationships. All units are preflighted; each is
rechecked immediately before `stop` to clear only an inert completed registration.
The original holder must be one declared unit. A privileged complete original
cgroup/process census then proves cessation; native terminal safety observes
processes, queued tools and borrowers again. `retire-growth` rechecks the exact
owner, source/plan/sample/root binding under existing locks, CAS and durable
journal. An unknown observation or a concurrent writer retains the reservation.
A same-custody already-retired result performs no unit effects. A partial unit
cleanup followed by refusal remains source-preserving; obtain current terminal
custody rather than replaying any original job.

This entry point never invokes `release`, deletes source, strips dependencies,
lowers the operating floor or changes a producer, queue or application. Unpushed
source and rollback remain on disk; growth retirement is not reclaimed disk bytes.
Frozen/operator readers are not eligible unless their owner explicitly ends that
preservation contract; an automatic finalizer must not manufacture that decision.

Capacity sampling now fences each **individual checkout/group** and carries its
absolute requested deadline into that acquisition. It no longer takes a global
`capacity-measurement` lock around a pool walk. A 240-second sampler cannot trap
an unrelated targeted refresh behind a 30-second global wait. Same-root concurrent
observations serialize; busy/deadline/partial observations store failure, not
capacity credit. Admission still consumes only complete, current identity-bound
samples and retains full liability on failed measurement.

Focused checks: `node --test tools/agent-workspace/{terminal-finalizer,measurement-isolation,growth-lifecycle}.test.mjs`.

## Recorded disposal of candidate-local merges

A candidate checkout often holds merge commits that combine leaves already durable on a remote (for example pull-request heads merged into a staging candidate). Those merges are never pushed, so release retains the checkout as having "commits absent from remote refs". `agent-workspace dispose-local-merges --id ID --path PATH --owner OWNER --json` records an owner-bound disposal for them. It succeeds only when every commit absent from remote refs and durable source ancestry is a two-parent merge whose parents are remote-durable (or are themselves such merges) and whose tree is exactly the conflict-free merge of those parents. Ordinary commits, octopus merges, conflict resolutions and merges carrying any extra edit are unique source and are refused. The command only writes a receipt under the repository's common git directory (`agent-workspace-merge-disposals/`); it deletes and moves nothing. Every later release re-verifies against current remote tips, so work added after the disposal stays protected. Checks: `node --test tools/agent-workspace/local-merge-disposal.test.mjs`.

`release` takes exactly one selector, `(--id ID|--path PATH)`; its help line is generated from the same CLI contract that validates it, and a test fails if a help line and the contract diverge.

### Terminal reclamation without growth admission

The ended-owner sweep includes retained custody. For a singleton retained checkout, it uses the same locked terminal retention release as `release --end-retention`, with a fresh owner verdict and exact plan binding instead of requiring the departed owner to return. No new growth admission or allocation is involved. Existing source must still pass ordinary dirty-file and commit-reachability checks; unpushed or dirty work remains in place. Pending generated/source materialization, shared retained parents, groups, live processes (including writable file descriptors), tool calls, containers, units and Git borrowers remain protected. The terminal transition and owner sweep both retain durable receipts. Missing paths can end historical source-retention markers as well, but runtime observations and native wake checks remain mandatory. Channel failure preserves every reservation, including missing paths. The recurring owner-liveness timer uses this same path, so missing directories and previously retired growth cannot strand reservations forever.


An ordinary `release` whose result is `blocked` (a frozen or unknown-frozen tree, an unobservable queue, retained custody) prints that result and exits 2, so a caller cannot read exit 0 as released.

Frozen source is never implicitly thawed by reclamation. A `pi-frozen-handoff.json` marker or filesystem immutable flag produces a typed `FROZEN_CUSTODY` refusal before ownership repair or removal. The destructive boundary also scans descendants without following symlinks; the observation's time allowance grows with the tree (20 seconds plus 0.5 ms per entry seen, at most 15 minutes, with no entry-count limit), so a large tree is not refused for its size. An unavailable or over-budget observation produces `FROZEN_CUSTODY_UNKNOWN` and preserves the tree. Only the explicit, owner-bound snapshot thaw lifecycle can undo the original freeze. This applies even to positively ended native owners.

### Authenticated native owner bindings

`--owner` remains a human-readable label, not proof of a running worker. Creation and new registration record an authenticated native caller from its root-created tool-call scope when available. Reassignment updates that binding or clears it when no native caller is authenticated. UUID owner labels keep their existing meaning.

`agent-workspace bind-native-owners --root PATH --json` proposes migration of older task-labelled records. Add `--execute` to record bindings proven by exact checkout-job creation receipts and the matching tool call in that native agent's conversation on exactly one serving channel. Malformed, missing, changed or ambiguous evidence stays unbound. This changes no checkout, writing lease or retention condition. `release-ended-owners` uses these bindings for positive native liveness evidence, including pending wakes, and repeats all existing source, immutable, runtime and borrower checks before any deletion.

Ordinary release authenticates the current native call against the root-created scope and the native message store. A swarm worker may release its own published checkout, not its parent’s checkout. Shell identity variables are not an authority grant. `release-caller-unverified` includes a bounded, typed `diagnostic` when scope query, cgroup, description, channel, binding, or server-ancestry observation fails. These causes distinguish a failed observation from absent runtime propagation; they never bypass authentication or disclose the call identity or raw subprocess output. The owning operator must reconcile an original unexplained refusal rather than assume that every swarm lacks identity.

### Prepared qualification and queue train custody

A prepared but undispatched qualification is still active custody, even when no native process or tool is running. Every source, physical-checkout and generated-cache terminal check also reads bounded Converge release authority and merge-queue records. Current requests and paired trains protect their root and prepared workspace. Exact completed settlement, explicit request withdrawal or an exact terminal refusal is required before treating an old request as settled; a retryable capacity refusal is not settlement. Malformed or contradictory records fail closed. Never reclaim all publisher roots from a general request to reclaim settled work.

### Automatic behavior-based remaining growth

Completed source-only and budgeted workspaces older than one hour retain the
smaller of their original growth request and `max(512 MiB, twice the positive
allocated growth observed in the last hour)`. This applies to active roots and
reader-held roots as well; it neither ends their leases nor removes their source.
The original plan remains preserved. New checkouts, pending construction,
non-Git execution reservations, shared operating headroom and source import
reservations keep their original protections. Missing or malformed allocation
or policy evidence retains the full original growth reservation. Complete stale
observations use the conservative admission forecast described below.

The periodic bounded sampler maintains a rolling observation journal. Until an
hour of samples exists, the completed checkout baseline conservatively attributes
all positive growth since creation to the last hour. Each measured increment over
64 MiB restores the original amount for one hour; smaller measurement variance
does not hold it forever. Positive increments are summed, so deletion cannot
cancel later regrowth. Ordinary heartbeat renews custody without resetting idle
pricing. `heartbeat --id ID --growth-mib N` explicitly restores at least the
original growth amount for one hour, or requests a larger original amount. The
increment must pass the normal device admission before policy or lease changes.
A refused request changes neither. `capacity-status --root PATH --json` reports
the exact effective reservations, original requests and causal policy decisions.

Zero-future-growth retirement remains a separate explicit owner disposition.
Its runtime observation now distinguishes stable read-only process references
from writable descriptors under the root. Writable or unknown descriptors and
uncovered native references continue to refuse retirement. This distinction
never changes physical deletion, generated-cache or source-custody guards.

## Durable pushed source handoff

Do not advertise a child-owned checkout as surviving the child's completion or
archive. A pushed branch or a verified bundle is the source handoff contract;
a checkout path without transferred custody is disposable. Before reporting done,
produce a native receipt for a clean, exact pushed branch:

```sh
agent-workspace source-handoff --id ID --path PATH --owner CHILD_ID \
  --expected-head FULL_SHA --recipient PARENT_ID --remote origin \
  --branch agent/your-source --json
```

This read-only Git check observes the exact remote branch tip, checks the source
again under its checkout lock, and atomically publishes a hash-bound receipt and
Git tree manifest outside the checkout, beside the workspace registry. It does
not push, freeze, extend a lease, transfer ownership or retain the child tree.
Ignored dependency and build output is accepted only under the workspace’s existing
generated-cache declarations (including defaults and the tracked repository manifest).
The receipt explicitly retains those paths in child checkout custody without transferring
or deleting them. The recipient regenerates its own dependencies; ordinary release and
cache retirement retain their existing cleanup safeguards. Unknown ignored output,
untracked files and modified tracked source still refuse the handoff.
The receipt names the recipient, exact commit and tree, and explicitly warns that
the child checkout can disappear after archive. Pass the receipt path and its
SHA-256 in the done report, not a promise that the child checkout remains live.
The recipient creates its own admitted checkout using its authorized remote route
and verifies the exact commit. The manifest contains Git object identities, not
SHA-256 hashes of individual file bytes. URLs and credentials are not recorded.
The existing `freeze-source` atomic immutable recipient transfer is unchanged;
its accepted custody guarantee is distinct from an informally frozen Git commit.


### Incremental allocation sampling and stale growth rates

Fleet sampling gives each eligible checkout a bounded slice and persists traversal
progress outside the source tree. Oldest attempted stale reservations come first,
with the oldest successful observation and largest reservation breaking ties.
Partial walks rotate fairly and continue in additional rounds while the pass has
budget. Only a complete walk publishes allocation bytes; failures preserve the
last successful observation. Root identity and nested checkout exclusions are
checked again before a saved traversal is resumed. The two million entry bound
still applies. Progress across timer passes prevents a large tree from restarting
at its root on every exhausted budget.

Staleness alone does not erase a complete allocation measurement. Admission may
use a forecast only when that measurement and its complete rate history name the
same absolute root, device, inode and exact capacity-plan SHA256. Old unbound
samples require a supported refresh first. Missing, malformed, partial,
future-dated, changed-plan or changed-root samples keep the full allowance;
detached rate history cannot supply credit. The existing fair on-demand sampler
still sees stale samples as stale and refreshes them when they decide admission.

The forecast is the last complete measured size plus an uncertainty allowance
`U = min(original growth, 512 MiB + ceil(2 * positive hourly rate * age in hours))`.
Age starts at measurement start, including time spent walking. The rate sums
positive deltas, so deletions never cancel later regrowth; a single complete
sample conservatively attributes all growth over the completed source baseline
to one hour. The 512 MiB minimum protects an idle observation against a new burst,
and positive growth increases uncertainty with age until no allocation credit
remains. This is a disclosed admission estimate, not an enforced filesystem quota
or a guaranteed maximum write rate.

For allocation accounting, credit is at most the last observed consumed growth
after the existing `max(64 MiB, 1 percent)` margin, less `U`, and never negative.
The forecast does not claim that uncertainty bytes are already allocated. The
separate automatic future-growth policy uses twice the positive hourly growth
anchored to the latest actual observation, with the same calculation before and
after the 900-second freshness boundary. Its 512 MiB minimum is independent of
`U`, which discounts historical allocation credit, not future writes. New
workspaces keep their original allowance less only this discounted consumed-growth credit. Explicit growth
restores retain the original allowance. Status and refusal details expose the
forecast, observed consumption, credit, uncertainty, age and rate separately.

Unobserved external deletions remain estimation risk, not newly freed capacity.
A known lifecycle cache/source removal must invalidate the allocation sample;
a missing sample also disables detached rate-history pricing until a complete
refresh. Fresh-sample requirements for reductions, repricing, retirement and
writer admission are unchanged. Source construction, source imports, non-Git
execution reservations, actual free blocks and maximum shared headroom retain
their existing protections. An exact
completed qualification or terminal refusal removes remaining preparation growth
only when the complete qualification census shows no current request or train
reference. Its source retention, original plan, lease and operating headroom do
not change. The supported release command remains the route for physical cleanup.

### Automatic native root-precheck growth settlement

Capacity projection also recognizes the native root-precheck plans in
`~/data/converge-root-precheck`. It credits only the exact registered root and
candidate workspace identities after **every declared compile, tests and smoke
command** has a settled root-owned heavy-authority record. The read-only privileged
observer returns only command/source/operation identity and terminal state, never
grant tokens. Missing stages, changed source or commands, another plan sharing the
root, and any pending or uncertain authority preserve the reservation. An explicit
growth restoration newer than settlement restores the original charge.

Before credit, the current source HEAD must match, and a fresh complete native
process, queued-tool, runtime and borrower census must show no consumer. Frozen
roots and unknown observations are ineligible. The bounded immutable-attribute
observation can conservatively retain very large trees rather than delay admission.
No plan, source file, lease, root-owned authority record or reservation plan is
modified; zero future growth is projected anew on each capacity read. Source
custody and the original operating headroom remain. This is not source deletion,
release, reclaimed disk, successful qualification, activation or deployment. Settled
owner-directed source workspaces still use ordinary `release`/`release-ended-owners`;
a push or an expired lease alone never establishes ended writing.

Durable checkout materialization repeats capacity admission through the same bounded
on-demand measurement refresh used by source preparation and reservation creation.
A stale sample appearing between those stages is refreshed before Git writes begin;
only the deciding reservations are sampled, outside the device fence. The original
checkout request and reservation survive, and a genuine remaining deficit still
refuses materialization. No source, lease or growth plan is retired by this refresh.
Admission also resumes the sampler's durable incremental walks in one-second
slices instead of restarting a potentially huge targeted walk. Every deciding
reservation gets a turn before any partial walk repeats. The thirty-second total
repair budget and conservative treatment of incomplete samples are unchanged.
An exhausted refusal includes `capacity-refresh` observations in its retained
stderr, so wrappers do not lose which samples were attempted. Explicit targeted
`measure-capacity` keeps its full requested budget unless `--incremental` is used.

### Periodic authenticated owner reaper

`agent-workspace reap-ended-owners --execute --json` first runs bounded authenticated receipt binding (128 records, 15 seconds), then the existing guarded ended-owner release (64 records, at most 40 seconds). The reaper accepts a total `--budget-ms` (default 90000, range 2000..120000); release receives at most 40000 milliseconds after the binding phase budget. A failed authentication observation prevents that pass from releasing anything. No free-label owner is guessed. Both phases persist independent fair cursors; binding authenticates at most 512 exact pairs per pass. `bind-native-owners` accepts `--max-records 1..512` and `--after ID|start` for explicit non-wrapping pages. Unselected executing passes wrap and skip already bound or native-ID records. Release observes a fair window of at most 512 owners before choosing its action page, prioritizing positively ended owners over live owners. All ordinary runtime, wake, frozen-source, dirty-file and unpublished-commit protections remain in force.

After normal component deployment, `bash tools/agent-workspace/install-owner-reaper` installs the component-owned user service and timer. The service invokes the supported CLI through its host admission wrapper, with a 120-second startup limit (including the wrapper's 30-second admission wait), a five-second termination limit and one GiB of memory. The timer schedules the next pass one minute after the preceding service ends. Component deployment alone does not install or enable the timer.

Native root precheck plans in `/home/kenan/data/converge-root-precheck/*.plan.json` protect every absolute execution dependency from stage, finish and candidate-finish arguments, not only root and smoke checkouts. A plan remains future-request custody even between native runs or after an unknown or terminal-looking state. An exact `state: cancelled` withdraws only that future request, for both native root plans and publisher plan copies; it is not proof that any dispatched process, container, unit, queued tool, installed source or prepared runtime has ceased. Those independent references still prevent cleanup. Otherwise, an explicit `.custody-released.json` sidecar with the exact plan SHA-256, publisher owner, reason and complete dependency paths can end plan protection; malformed or contradictory records retain custody. An archived original owner never overrides publisher adoption or plan custody.

Prepared Original40 configurations in `/home/kenan/data/omni-loop-9681/host-preparation-*/CONFIG.json`, the current configuration pointer and explicit publisher adoption records retain their source and helper dependencies before a process is launched. A host exit never gives up prepared custody. New publisher adoptions belong in `/home/kenan/data/converge-releases/publisher-custody`; malformed or contradictory custody fails closed. The exact configuration digest and full dependency list must match a publisher disposition before cleanup can remove its source.

### Atomic allocation observation and admission recovery

A completed successful allocation observation and its matching growth journal
commit in one transaction under the checkout and device locks. Capacity-lock
exhaustion or journal failure preserves both previous records. Historical split
publication can be reconciled read-only by appending the exact complete cached
observation to an otherwise valid, identically bound history; malformed,
conflicting, overlong or differently bound history never gains credit.

Ordinary repricing uses the same bounded deciding-reservation refresh as source
admission, releasing its original checkout and device locks before walking
another checkout. Every retry rebuilds the proposal, rereads actual free blocks
and shared headroom, and can journal consumption only once. A fleet sampling
command can finish successfully with explicitly reported deferred rows; admission
continues sampling the rows it needs within its own deadline rather than assuming
that an exit status of zero made the entire fleet fresh.

Successful sample publication waits for its actual remaining bounded budget, up
to 30 seconds, at the device fence. It does not use the 100 ms traversal lock
probe as an activation deadline: forty concurrent creators may serialize their
atomic journal commits without losing their completed measurements.

## Native parent and publisher custody

When a source worker ends, automatic cleanup transfers its exact registered checkout to the parent recorded by the native store, before considering disposal. This transfer preserves the workspace ID, source baseline, lease, state and bytes. The locked transaction records the native relationship in `workspace_parent_custody` and, where the source baseline is set, the assignment history. It does not fabricate a parent tool call. Missing, conflicting or unobservable parents retain the checkout with a typed error. A stopped parent receives custody as well, allowing subsequent sweeps to follow the native parent chain. Managers retain explicit ownership until they release or transfer it.

Automatic owner cleanup uses source-scope native observations, even after future growth has retired. A live publisher reference and an unsettled qualification plan protect the source between test completion and final proof consumption. A source handoff receipt proves durable Git custody, not adoption of the physical checkout. Qualification preparation must transfer the exact source checkout to its publisher before planning tests, and persist its native source plan before execution. The publisher releases plan custody only after activation or explicit cancellation with a digest-bound settlement covering every dependency. Registry entry bounds and exact settlements still apply; owner termination and elapsed time are not substitutes for consumption.

### Automatic idle future-growth retirement

`retire-idle-growth --budget-ms 90000 --max-records 128 --json` advances a durable round-robin cursor and a resumable per-workspace allocated-block walk. The ordinary capacity sampler also runs a short retirement page. Install the continuous maintenance timer with `bash /srv/pi/tools/agent-workspace/install-idle-growth`; its source-controlled launcher uses the existing same-UID read capability for protected generated files.

The policy retires only a completed priced workspace's future promise. It preserves the original growth amount, all files (including dirty unpublished work), owner, source, shared headroom and allocation baseline. Retirement records a journal, sets the existing retired-growth lifecycle and relinquishes the writing lease in one transaction. `writer-run`, registration, heartbeat, ordinary repricing and bootstrap's existing growth checks cannot reactivate it. A new writer must use `resume-growth` with the exact current owner and plan, passing genuine capacity admission.

Two real, identity-bound samples must have equal allocated bytes. This is **not** last-write evidence: the complete tree observation separately reads every inode's modification and change times, including same-size changes, and their maximum must be more than an hour old. Missing samples, recent construction or resumed admission, changed plan/source/owner, active processes, units, native streaming tools or borrower writers retain the promise. A fresh complete second walk under the same checkout, borrower and device locks rejects writes during observation. The final ledger transaction revalidates the exact binding. No age or lease expiry alone grants credit. An unsupported external filesystem writer is not kernel-fenced; subsequent observation detects writes truthfully, and supported writers must first re-admit growth.

### Sampled repricing and hardlink-only inode changes

A genuine increase through `reprice-capacity` now reads the same current sample,
margin, stale forecast and future-growth policy projection as CREATE. Physical
allocation is already reflected in filesystem free bytes: it is not also charged
as unused future growth. This foreground projection does not walk unrelated
checkouts or refresh their trees inside the command's observation budget. Missing,
failed or unbound stale observations retain their conservative commitments; the
ordinary resumable sampler refreshes them independently. A complete non-increase
still uses ledger-only accounting and never reads unrelated samples. Existing
source, owner, sample and plan compare-and-swap checks remain mandatory.

The allocated-block sampler maintains a shared-inode content proof journal in
`workspace_inode_content`. Only a full SHA-256 match, identical device/inode/birth
time, size, blocks, mode, owner, group and nanosecond mtime, plus a changed link
count, proves that an inode ctime change was link-only. The hash reads an open
non-symlink descriptor with stable metadata checked both before and after, and
rechecks the pathname identity afterwards. Its previous payload timestamp is then
preserved. A first observation uses real current ctime; it never manufactures an
old timestamp from an old mtime. Payload changes, same-size writes, unexplained
ctime changes, changed identity or permissions and incomplete proofs remain recent.
No proof weakens the process/unit/native execution, owner/source/plan, two-sample,
one-hour payload-idleness or final under-lock verification requirements. Complete
final walks use the same proof journal. Old incremental cursor versions restart
rather than retaining obsolete ctime-only evidence. Concurrent proof publication
cannot replace newer inode evidence or lower a proved payload-write timestamp.

This is cooperative admission and content observation, not kernel enforcement.
An unsupported external writer remains possible; a changed payload, unknown
observation or final write race retains the original reservation truthfully.

### Creation capacity and payload-idleness evidence are separate

CREATE and its pre-materialization recheck share the existing bounded sampled
allocation/history/policy admission rules. Stale-cache warnings name conservative
commitments; they are not by themselves a terminal creation failure. Final
activation measures the admitted checkout's allocated blocks under its checkout
lock and atomically binds the actual root identity, completed allocation baseline,
capacity plan and active state. It does not require SHA-256 hashing of every
payload as a prerequisite for capacity admission. An allocation-only sample is
explicitly marked `writeObservationComplete: false` and cannot establish idle
future-growth retirement. Repeat the original CREATE or use supported
`finalize-creation` after genuine cessation; neither path deletes preserved files,
forges a READY receipt or clears another reservation.

A shared link changing during the separate payload census is incomplete idleness
evidence, not failed allocated-block accounting. It publishes no content proof,
retains the idleness veto across resumable slices and requires another complete
successful payload census before automatic retirement. Actual root replacement,
allocation measurement failure or budget exhaustion still refuses finalization,
leaves the original pending operation recoverable and never fabricates capacity.

### Shared checkout shallow history

Priced shared-object checkouts inherit the durable mirror's actual shallow
boundaries before publishing their source refs. Git alternates share objects,
not the `shallow` file; omitting that file makes valid truncated history appear
corrupt after an ordinary upstream fetch. Boundary publication uses Git's
`shallow.lock`, an atomic rename and fsync, preserves existing boundaries on
resumption, and never invents a boundary for a missing ancestor. A complete
mirror creates no shallow metadata. Closure qualification and import accounting
are unchanged. The native regression creates a real shallow donor, advances its
upstream, performs an ordinary fetch in the admitted clone and admits that clone
as a subsequent source.

### Allocation measurement and native background identity

Ordinary `measure-capacity` walks allocated blocks only, with the requested deadline and resumable fleet slices. It does not read or hash payloads, and it skips the unrelated terminal-plan census for a targeted request. Its samples explicitly carry `writeObservationComplete: false`: allocation credit is not retirement or payload-idleness proof. `--content-proof` opts into the separate complete payload observation; the idle-growth retirement path continues to request that proof itself. Switching measurement modes resets incomplete traversal state. Failed or unfinished walks retain previous successful allocation samples.

The current Kenan `kenan-bg` uses `background-launch.mjs` for native UUID workers. It authenticates the actual root-created native tool scope before launching a root-created system-manager service as the original Unix user. That service's root-owned description binds the exact worker, channel and original call; its current control group, UID, transient status, active state and invocation are checked on read. Raw inherited tool IDs remain stripped. User-manager services, wrong workers, stale units and mismatched control groups cannot impersonate this route. Legacy non-native callers retain their existing user-manager behavior.

### Adopt an ended Converge Actions checkout

`agent-workspace adopt-ended-actions --id ID --path PATH --repository owi-link/converge --run RUN --attempt ATTEMPT --source-commit SHA --json` explicitly adopts a previously non-native deployment checkout into the current authenticated native caller's custody. It checks the exact original runner request, branch, registered source, current HEAD and authenticated GitHub terminal attempt. Existing native custodians and malformed or conflicting admission receipts cannot be overridden. This local lifecycle command changes neither the lease nor the source and performs no application or provider effect. A failed workflow remains failed; an independently succeeded continuation keeps its own receipt. Normal release must still prove source durability and refuse live processes, containers, units, prepared consumers and unresolved runtime references. It is not an application release gate or a watcher.

Durable failed source/checkout job results retain their original typed error within the 64 KiB machine-reader boundary. Oversized diagnostics are stored completely in an immutable `failure-diagnostic-SHA256.json` beside the job. The result identifies that file, its exact byte size and SHA-256. Existing terminal receipts are never rewritten, including historical oversized failures; their original operation must be reconciled rather than replayed.

An authenticated native `kenan-bg` cleanup batch is not an external systemd consumer of its own bare path arguments. This exemption requires the current release's native-store-confirmed agent, channel and full tool-call identity to match the root-created background scope, its exact system unit and actual MainPID cgroup. The MainPID must remain an ancestor with the invoking UID and with its actual cwd and executable outside the checkout. Checkout descendants, foreign or unknown services, real child processes, installed resources and generated caches remain protected. Ordinary non-background releases retain the exact single-target argument check. Historical native message payloads that are not JSON arrays cannot authenticate a tool call and no longer prevent a valid current pair from being checked; authentication still refuses incomplete channel observations and ambiguous identities, with a bounded diagnostic cause and channel count.
### Independent resumable measurement modes

The allocation sampler and optional payload-idleness observer retain separate durable traversal progress. Alternating fleet sampling and idle-growth proof sweeps cannot reset each other's partial walks. Explicitly tagged legacy content walks migrate transactionally to the content slot; untagged or malformed progress restarts conservatively. Only complete observations update allocation samples; allocation-only results never establish payload idleness. The existing timer schedule and allocation-credit freshness policy are unchanged.

### Durable ordinary release from native foreground calls

A native foreground `release` authenticates its original full caller binding and reserves one immutable submission before launching a root-created `kenan-bg` worker. It returns exit 75 with `action: release-submitted`, `completed: false`, the original request identity, unit, log and status command. That is accepted work, not completed release or reclaimed capacity. A repeated request adopts the same submission and never launches a competing writer. Changed custody or flags require reconciliation of the original request. An already completed settlement remains idempotent.

The background worker authenticates normally; there is no internal identity flag or environment grant. It retains the existing original safety/physical journal and can finish removal after the submitting foreground call ends. Its bounded checkout-lock attempts emit `release-resource-busy` without changing the lease or starting removal, and retry that same request automatically. The same inspection deadline covers authorization, checkout locking and safety observations. A stopped worker or unknown launch response must be reconciled against its exact unit, log and original journal before the recorded settlement command is continued in authenticated background. Status exposes the original submission independently from physical settlement. The component installer removes the superseded recovery-era top-level marker; `agent-workspace/.component-release.json` names the actual immutable installed source and rollback baseline.
Fleet sampling uses a bounded completion-first quantum of at most 30 seconds per row before moving on. Each actual checkout lock remains at most two seconds, and oldest-attempt ordering still rotates unfinished rows on subsequent activations. This avoids spreading every walk's start across a whole large fleet before any observation can finish within the unchanged 15-minute freshness window. An allocation-only traversal already older than that window restarts conservatively; its prior complete sample and growth history remain intact. Timer cadence, optional content-proof requirements, aggregate budgets and physical allocation credit are unchanged.
