# Kenan Stack

A self-hosted multi-agent assistant: one Node.js process per channel, PostgreSQL,
a web app and an Android client, and long-lived agents on the Pi engine.

## Principles (non-negotiable)

1. **Real-time first.** A human message is admitted (stored + broadcast) in
   milliseconds and Kenaznia's first streamed token arrives in seconds. Nothing
   — background work, heartbeats, worker reports — may delay a human message.
2. **Minimal overhead.** No recovery/custody/repair/adoption machinery, no
   workflow engine, no lifecycle triggers, no audits, no admission fences, no
   approval flows. Plain functions plus a small number of event handlers.
3. **Agents are fully trusted operators.** There are no humans operating this
   system. Anything an agent cannot do is a bug. No security checks against
   agents. Tools run with real shell access as the person's Unix user.
4. **Recovery is the heartbeat plus resume after restart.** Every 30 minutes
   the runtime checks whether anything moved; if so (or after 4 hours of
   in-flight work or a checklist), Kenaznia is woken with the person's
   `HEARTBEAT.md` plus a generated status
   block (goals, workers, per-account usage, latency, new errors). If something
   is broken, Kenaznia fixes it then. A restart cuts nothing off: shutdown marks
   running turns `interrupted` and keeps not-yet-prompted inputs; startup sends
   each interrupted agent a restart notice so it continues where it stopped, and
   redelivers the kept inputs. A transient model-call failure (connection error,
   broker restart, 5xx, overload) never ends a turn: Pi's own retry continues the
   same turn with backoff up to a minute, for as long as the cause lasts, and an
   explicit stop, preemption or shutdown cancels it.
   Restarts refuse no request: systemd holds each channel's socket
   (`deploy/kenan@.socket`) and passes it to the server, so requests made while
   the process restarts wait in its queue; shutdown waits at most 5 s for turns
   to end (`shutdown_slow` names the agents that didn't). The app turns any
   reply that isn't Kenan's JSON into a typed `unreachable` error (never shown
   raw), queues a send until the stream is live again, and drops a saved screen
   or cached shell from another build instead of drawing it (`web/client.ts`,
   `web/recover.ts`).
5. **Right-sized agents.** Kenaznia owns a curated goal list and spawns workers
   only for goals, never two for the same goal. No hard worker cap: Kenaznia
   watches total usage and drain rate and terminates/merges workers to fit.
   Workers never send progress reports; they report once, `done` or `blocked`,
   which wakes Kenaznia immediately.
6. **Privacy is etiquette.** Each person has a plain home folder. Agents can read
   anything; the shared instructions ask them not to open other people's
   folders unless asked. No encryption layers.

## Shape

```
nginx entrance (beta / production)  ──unix socket (held by systemd)──>  kenan server (one Node process per channel, runs as root)
                                                          │  Postgres 18 (one cluster, db kenan_beta / kenan_production)
                                                          │  Pi agent engine (upstream 1.1.0, unpatched), JSONL session per agent
                                                          │  kenan-model-broker on each person's loopback port for model calls + /v1/usage
                                                          └─ tools spawn as the person's Unix user (uid/gid), cwd = their home
```

Directory layout:

| Path | Owner (parallel agent) | Contents |
|---|---|---|
| `shared/contract.ts` | lead | HTTP + SSE contract shared by server and web. Change only via lead. |
| `server/main.ts`, `server/config.ts`, `server/types.ts` | lead | Wiring, config, module interfaces |
| `server/db/` | core | `schema.sql`, `store.ts` (implements `Store`) |
| `server/http/`, `server/auth/`, `server/events/`, `server/files/`, `server/metrics/` | core | Hono app, login/cookies, SSE bus, uploads, latency metrics |
| `server/agents/`, `server/tools/` | runtime | Pi sessions, scheduler/lanes, heartbeat, goals/workers/usage, prompts, built-in tools |
| `server/extensions/` + `web/extensions/` | extensions | voice (live/Meet/phone), mail, calendar (repeating series: an RRULE + IANA zone expanded by `recurrence.ts` with ical.js, occurrence ids `<series>@<local start>`, per-occurrence cancellation in `exceptions`), browser (an agent's commands go to the Kernel session it started/attached until it stops it, bound in `DATADIR/browser-bindings/PERSON/AGENT.json`; an ended Kernel session is the typed `kernel_session_ended`, never local Chrome; the local route passes no `--config`, so the person's `~/.agent-browser/config.json` credential plugins serve `auth fill`), texts |
| `web/` (except `web/extensions/`) | web | React-API app running on Preact (`build/preact.ts`); startup path in `docs/startup-STATE.md` |
| `android/` | deploy | WebView shell; `NoticeService` streams `GET /api/notifications` and shows agent notifications (ordinary, or urgent on the alarm stream through silent/DND); forwards incoming SMS and the default messaging app's notifications to the texts extension; `android/release.sh` publishes |
| `deploy/`, `bench/` | deploy | systemd/nginx, build+restart deploy, latency benchmark |

## Agents

- **Kenaznia** (role `manager`). Each person's `manager` in the channel config
  places it: a profile hosts it on this channel, `{"elsewhere": URL}` names the
  channel app that hosts it (the app shows a link there), `null` means workers
  only. Startup reconciles to that placement: a hosted manager is created or
  restored, a manager row on a channel that does not host it is archived. A
  hosted manager can't be stopped or archived (typed `conflict`; Stop ends its
  turn), so a person never lands in an app with no one answering. Heartbeats
  fire only when something moved (see Heartbeat below). System
  prompt = person's manager prompt + all configured context files (the
  person's own notes). Tools (11): `bash read edit write web_search report goals
  workers usage notify attach wake`. Talks to the human in the person's manager conversation.
- **Workers** (role `worker`). Each has its own conversation (visible in the
  UI), a goal id, and the person's `AGENTS.md` only plus a short platform
  prompt. Tools: the manager's set (workers spawn their own children). A worker's turn
  ends; when its task is complete or it cannot continue it calls
  `report({status:'done'|'blocked', text})` which posts to the manager's inbox
  and marks the worker idle. Workers can be re-messaged by Kenaznia.
  **Waiting is a warning, long waits are handoffs** (`server/agents/wakes.ts` `planWait`/`SHORT_WAIT_MS`,
  `store.handOff`; Alice 2026-10-21). A worker idle with its own pending wakes is *waiting*, and every view shows it
  as a warning with how long and on what (`waitingLine`: `workers list` items and `peek` carry `warning`, the
  heartbeat marks it ⚠, the sidebar shows an amber triangle and "Waiting 2h for mail until …" and counts "⚠ N
  waiting"). Workers don't sit waiting: a worker keeps a wake only when its deadline is at most `SHORT_WAIT_MS`
  (30 min; on Beta those waited 3–14 min on average, longer deadlines 45 min–10 h), or while it has active sub-agents.
  A longer wait, or one with no deadline, needs `handoff` (state, files, what to do when it fires; `wake_needs_handoff`
  otherwise) and becomes a **held trigger**: in one transaction the wake is created on the person's manager with
  `goal_id`, `held_for` (the worker) and `handoff`, the handoff goes on top of the goal's notes (a dated log, newest first: `goals update appendNote` adds an entry the same way, and `notes` replaces the whole field only with `replaceNotes: true`), and the worker's
  report becomes `handed_off`, which archives it when its turn ends like `done`. A held trigger listens for its own
  event and time and for anything addressed to the worker that handed it off or to the goal (`listenerOf`), so
  `acme:<worker>` and `gpujob:<worker>:*` events still fire it. When it fires the manager gets `heldText`: the
  event, the handoff, the note, the goal's other held triggers and the instruction to launch a fresh worker for the
  goal (or message its active worker); `spawnWorker` appends the goal's held triggers to a fresh worker's task, and a
  worker may list and cancel its goal's held triggers. A manager can hold a trigger for a goal itself (`goalId` +
  `handoff`). Sub-agents are refused long waits (`long_wait_sub_agent`); a worker with no goal or no hosted manager
  gets `long_wait_without_goal`/`long_wait_without_manager`. `wake list` for a manager returns every held trigger with
  goal, title and handoff plus the workers still waiting; `goals get` returns the goal's held triggers and waiting
  workers; the heartbeat shows each goal's held triggers, lists the goals waiting on one, and flags open goals with
  no worker and no held trigger. Column CHECK `wake_held`. The interim parked state (`b3a9064f`, live 07:15Z 2026-10-21 until this change)
  is gone; startup sets any `parked` agent back to `idle`. A worker
  hands off something urgent mid-task with `workers message` to its parent's id
  (its `parentAgentId`, e.g. `manager:alice`): a `note` input plus a notice in the
  parent's conversation; the worker keeps running.
- **Swarms** (`shared/swarm.ts`, spawn in `AgentRuntime.spawnWorker`, regression `server/agents/swarm.test.ts`).
  A worker that spawns a worker for its own goal launches a *sub-agent*: the coordinator's child on the same goal,
  so one goal still has one top-level worker and Kenaznia sees one run. Sub-agents need an explicit model and
  thinking (typically `claude-haiku-5-5`/`low`; `swarm_profile_required` otherwise), at most `SWARM_MAX_ACTIVE` (20)
  are active per coordinator (`swarm_full`; launches for one coordinator are admitted one at a time), a sub-agent
  cannot launch its own (`swarm_depth`), and a launch is refused with `swarm_quota_low` while any subscription meter
  the model draws is under `SWARM_QUOTA_RESERVE_PERCENT` (8%) of the pool, so a swarm never takes the last quota
  from human-facing work; in-flight 429s and an exhausted pool retry inside the turn like every agent's (backing off
  to a minute). Reports go to the coordinator, which verifies them and reports once. Stopping or finishing the
  coordinator stops its sub-agents. A sub-agent whose turn settles with no report and no pending wake is asked
  once to report (`SUB_AGENT_REPORT_MISSING`); if it settles silently again its coordinator gets a note (the first demo's
  Haiku agents did this 2 times in 20). `workers list` and compact `workers peek` leave sub-agents out and give the
  coordinator `swarm: {total, active, running, done, blocked}`; `workers list parent=ID` lists one agent's children.
  `usage` carries `swarms[]` (counts and last-day cost of coordinator and sub-agents). Top-level workers get
  `COORDINATOR_PROMPT`, sub-agents `SUB_AGENT_PROMPT`. The sidebar folds a swarm under its coordinator
  ("N sub-agents") until opened.
- **workers peek** (every agent; `server/tools/peek.ts`): what workers are doing right now, read straight from their
  stored conversations (`store.recentWork`: the newest 400 messages, cut in SQL) and the runtime's live turn
  (`runtime.turnOf`: start, inputs, queue). Without an id, every active worker of the person, running first, at most
  30, compactly (last 2 messages with words or reasoning, last 5 tool calls, ~3 KB each; 15 workers in ~30 ms); with an
  id or unique 8+ character prefix, one worker in detail (6 messages, 15 calls). Each shows state, goal, turn age and
  inputs, live activity, seconds idle, pending wakes and last report; calls carry key=value args and the start and end
  of their output. Credential-looking text is redacted before it is cut. Unknown, ambiguous and archived ids are typed
  errors (`worker_not_found`, `worker_id_ambiguous`, `worker_archived` with its last report).
- **attach** (every agent): `attach({paths, text?})` posts a chat message from the agent in its own conversation
  carrying the files. Each path is read by an owner process as the person's Unix user (what the account can't read
  fails), copied into the file store owned by the person (so later edits on disk don't change the message), at most
  10 files, 50 MiB each and 100 MiB together; any unreadable path sends nothing and returns `attach_unreadable` with
  a reason per path. Parts are the same `image`/`file` parts a human upload makes, so the app draws them identically:
  browser-drawable images inline and tappable into a scrollable full-size viewer, other files as download chips
  (`?download=1`). A worker's files land in its own run; its parent attaches what the person should see.
- **Files** are visible to their owner and to members of any conversation showing them (`conversation_file`, kept by
  `appendMessage`/`updateMessage`); `GET /api/files/:id` refuses anyone else. A message may only carry uploads its
  sender owns. Scriptable types (SVG, HTML, XML) are served with a sandbox CSP.
- **notify** (every agent, any role): `notify({title, body, level: normal|urgent, imagePath?})` stores a
  `notification` row (imagePath: a PNG/JPEG/GIF/WebP/BMP the account can read, copied in as the notification picture) and streams it to the person's phone; the phone replays the last day after its cursor.
- **wake** (every agent): an agent schedules its own resume. A `wake` row (Postgres, so it survives restarts)
  fires once: at a time, on an event (new mail matching IMAP criteria, compared against the matching message ids
  present when scheduled; a Signal data message whose sender name/number/UUID contains `from`, in the wake's
  required `chat` scope (`direct`: the sender's 1:1 chat with the person; `group` with `group`, a part of the group
  name or id; `any`: every chat including groups; there is no default, and a CHECK constraint refuses unscoped
  rows), read from the person's `signalStore` (signal-receiver's `receive.sqlite3`; `groupInfo` marks group messages); a text matching a query), or on the event with the
  time as deadline. Signal reads are read-only with a short SQLite busy timeout; a read that still meets the
  receiver's write lock is retried within the same poll after async pauses. Each poll re-reads from the oldest
  pending Signal wake's creation, so a failed read skips nothing; a Signal wake's deadline waits for a readable
  store, and only a store unreadable for 5 minutes is logged (once per outage) and lets deadlines fire. A mail wake's
  search failure is likewise logged only once it has failed for 5 minutes (`Outages`), so a passing timeout is not an error. `WakeScheduler` (`server/agents/wakes.ts`) checks pending rows every 10 s (mail once a minute
  per wake, server-side; the model never polls), settles the row, clears a blocked report and delivers a `wake`
  input. Wakes of archived, stopped or deleted agents settle as `dropped` with `agent_archived`, `agent_stopped`
  or `agent_missing`. Only archiving (an explicit archive, `workers stop`, or a done worker's settled turn) stops a
  run; a person's Stop button ends the current turns in that conversation and leaves the agents idle with their wakes,
  and restore returns an archived run as idle. Pending wakes show in `workers list` and on each worker's heartbeat line; drops since the
  previous heartbeat are listed. `wake({action:'list'|'cancel'})` lists or cancels.
  **Host events** (`server/event-inbox.ts`, `host-inbox.ts`): host processes queue `{topic, id, body}` files in
  `/var/lib/kenan/events/PERSON/` (`kenan-event`); the channel hosting the person's manager records each in
  `host_event` (unique per person and `id`, kept 14 days) and ticks the scheduler at once. A wake `on: "event"` with
  `topic` (exact, or a prefix written with a trailing `*`; stored as `{topic, prefix}`) fires on every matching event
  that arrived since it was scheduled or that no wake has carried yet, so an event that lands before its worker
  schedules is not lost; the wake text carries up to 10 events' topic, arrival, id and JSON body, and the events are
  marked carried in the same transaction that settles the wake. Workers are told their own id, which is the
  conventional topic suffix (`acme:<agent id>` for Acme release events).
  **Time or event, never time alone** (2026-10-21): every wake also listens for anything *addressed* to its agent
  (`listen = 'addressed'`): a host event whose topic
  has the agent's id or goal id (full or 8-character prefix) as a `:` segment after the first, or starts `goal-<goal>`,
  that arrived since the agent was created and no wake has carried (`addressOf`, `addressedEventsFor`). Such events
  fire the wake once they have been quiet for `ADDRESSED_QUIET_MS` (60 s) or the oldest is `ADDRESSED_CAP_MS` (3 min)
  old, so a release's burst of per-product events is one turn; a wake `on: "event"` for a named topic fires at once.
  **Every wake that fires, for any reason (its time, its event, a report or note, mail), carries the uncarried events
  addressed to its agent** after its own, oldest first, up to `EVENT_BATCH` (10) in full; the text says how many more
  wait for the next wake. `store.fireWake` takes the events, writes the wake's detail from exactly those and marks only
  those carried, in one transaction, so an event is never settled without being in a delivered wake text (2026-10-21:
  a report firing worker fffd215b's wake mid-burst had left four Acme inbox events unread for good, because the
  next wake listened only from the last fired one). And, for a worker, a `report`, `note` or
  `agent` message delivered to it (a manager gets reports all day and its wakes wait on other things) (`fireOnInput`, called from `deliver`; the fired wake joins the turn that input
  starts, since `wake` inputs steer like messages). `on: "any"` waits only for that. A time alone is refused with
  `wake_needs_event` (naming the agent's own topics) unless it gives `clock`, the reason the time itself is the
  trigger (`listen = 'clock'`, `clock_reason`); clock wakes listen for nothing else. Wakes settled before the
  contract record `listen = 'own'`. CHECK `wake_listen` keeps the three states exact.
- **texts** (extension, people with `texts` enabled): the phone POSTs incoming SMS and its messaging app's
  notification messages (RCS) to `/api/ext/texts`; they are appended once each to
  `<home>/.local/share/kenan/texts.jsonl` (owned by the person, 0600) and nowhere else. `texts({action:'recent'|'wait'})`
  reads them; `wait` watches the file, so a code sent to either channel's server reaches agents on both.
- **Room agents**: any agent can be a member of a room. Agents receive room
  messages from humans; from other agents only when @mentioned by id/name.

### Lanes and priority (per agent)

Each agent has one Pi session and an inbox. Inputs are `human`, `report`
(from a worker), `note` (worker → parent mid-task), `heartbeat`, `agent`
(manager → worker message), `room`, `wake`, `restart`.
- Human input to an idle agent → start a turn immediately.
- Human input while the agent runs a non-human turn → abort that turn
  (Pi `abort()`) and start the human turn. An input is consumed once its turn
  is prompted: it is in the transcript and is never sent again. The human turn
  carries a notice to finish the cut-off work after answering. Input aborted
  before its prompt is re-queued.
- Human input during a human turn → steer into the running turn (Pi `steer`).
- `agent`, `note` and `report` inputs while the recipient runs any turn → steer
  into it; the model reads them before its next call. Steered input the turn
  ended without reading is taken back from Pi's queue and starts the next turn
  (a worker that reported `done` is not archived while it waits); a restart
  retains it.
- Non-human inputs queue FIFO behind human inputs; multiple queued non-human
  inputs are batched into one turn.

### What the person sees: NO_REPLY and background updates

Every message carries `display` (`shared/contract.ts` `MessageDisplay`): `shown`, `background` or `silent`.
Human messages are shown; a notice takes its display from its kind (`NOTICE_DISPLAY`). Inputs from no person
that leave no other trace (a worker's report to its launcher, a fired wake, a heartbeat, a restart or refusal
notice) get a background notice in the recipient's conversation when they arrive (`INPUT_NOTICES` in
`server/agents/runtime.ts`; inputs retained across a restart keep the one they have); worker notes and peer
messages bring their own. A manager's turn whose inputs include no human or room message answers background
input: its tool calls and wordless messages are `background`, and an assistant message becomes `shown` as soon
as it has words that can no longer become NO_REPLY. An assistant message whose whole text is exactly `NO_REPLY`
is `silent`: stored and kept in the agent's transcript, never drawn, previewed, counted unread or routed to a
room. Text that may still become NO_REPLY is held back from streaming. A background turn whose final answer is
silent folds its earlier shown messages into the background, so it shows the person nothing. A turn that answers
a person (a human or room input, or a restart/refusal continuation while the newest human message has no finished
reply with words, `store.awaitingReply`) never folds words: when it ends NO_REPLY (often after background notes
steered into it) only its wordless work folds (2026-10-21: two of Kenaznia's answers to Alice had folded away). A worker's own chat is its
work, so its turns are shown. The app (`web/transcriptRows.ts`, the same bundle on Android) drops silent
messages and folds each run of background messages into one collapsed "N background updates" line (N counts
the notices; "Background work" for history whose inputs left none); conversation previews and unread marks
come from the newest `previewable` message. Regressions: `server/agents/runtime.test.ts` (turn outcomes), `server/db/store.test.ts`,
`web/transcriptRows.test.ts`.

### Reading size

The stylesheet's `:root` font-size is 16px. Message text inherits the root; fixed-pixel chrome (labels, tool cards) does not.

### Replying to a message

Swipe a message to the right to reply, like Signal (`web/swipe.ts`; with a mouse, a small ↩ appears on hover). The message follows the finger, and an ↩ shows once it has gone far enough. A long press is left to the browser, so it selects text the usual way: the word is highlighted with handles, then Copy. A swipe never starts while text is selected, or inside a horizontally scrolling table or code block. Replying puts a "Replying to" strip above the composer (× cancels it). On send, the message starts with a Markdown quote of the reply target (author, a one-line excerpt of up to 160 characters, and a line for each file), and the target's files are attached again so an agent sees the very picture (`web/reply.ts`). Client-only.

### Usage page summary

Each subscription plan on the Usage & latency page starts with one plain line (`web/usageSummary.ts`): what share is left and when the next account refills, e.g. "17% left · next account refills Wed 12:00 AM". The per-account table follows unchanged.

### Image viewer

Tapping an inline image opens `ImageViewer` (`web/FilePart.tsx`) on every image attachment loaded in the same transcript, in order (`web/gallery.ts`, read from the DOM at open time). Swipe left/right (`swipeDirection`: at least 50px and mostly horizontal; off in Actual size, where the finger pans), the side arrows or the arrow keys move between images. The bar shows "3 / 8", and the message's words are shown under each image as its caption.

### Folded work steps

The sidebar footer's "Work steps" button (per device, `localStorage` key `kenan.workSteps`, `web/workSteps.ts`) chooses Shown (default, unchanged) or Folded. Folded, `transcriptRows(messages, { foldWork: true })` turns each run of consecutive shown messages that carry only tool calls or thinking (`isWorkOnly`: no words for the person, no files) into one small expandable line such as "6 steps · Shell, Browser, Read file" (`workLabel`). Words, human messages, notices and files are never folded.

### Organized layout (opt-in)

A person whose channel config lists the `organized` extension chooses a layout per person on the server
(`person.layout`, `PUT /api/layout`, `Bootstrap.layout`, a `layout` stream event): **Classic** (the sidebar app, the
default) or **Organized** (`web/organized/`, Carol's approved mockups, 2026-10-21). Classic renders byte-for-byte as
before for everyone without the extension (`web/classic.test.ts` compares against `web/__fixtures__/classic.html`,
rendered by the pre-Organized app); with it, Classic's ☰ footer gains **To-do** and the **Layout** switch. Organized is
its own lazily loaded chunk (JS and CSS), so Classic's startup download is unchanged.

- **Screens.** Phone: Home (☰ menu panel, Pinned, Waiting on you = today's to-dos, Recent, To-do/Calendar shortcuts,
  ＋ new chat, and one footer line "date · ✈️ N days until PLACE" from the next calendar event whose title starts with ✈️),
  Chats (Open/Pinned/Workers/Closed), Activity (workers' reports and live runs), To-do (By urgency/By list/Done), and the
  topic, calendar, goals and usage views Classic uses. Wide screens (≥ 900 px): three panes, menu | list | open topic.
- **Topics** are conversations: `emoji`, `pinned_at` with an optional `key_date`/`key_label` ("Due Oct 29"), close =
  archive (Undo toast), Closed tab = archived. `title_locked`: a title set through `PATCH /api/conversations/:id` locks it
  (unless `titleLocked` says otherwise); anything that renames conversations automatically must leave locked ones alone.
- **To-do** (`server/extensions/organized.ts`, table `todo`): items with level today|week|someday, tag, due time, 🔔 remind,
  position, optional project conversation, `done_at`, `deleted_at` (delete is undoable). `/api/ext/organized/todos`
  (GET open + done in 30 days, POST, PATCH, DELETE), `todo` stream events, and the agents' `todos` tool
  (list|add|update|done|reopen|move|delete), Kenaznia being the main writer. The first start with the extension seeds a
  person's empty list once from `HOME/ID/memory/todo.md` (`parseTodoMarkdown`).
- **Project pages**: a topic with `project` set (⋯ → Make it a project page, or Kenaznia) opens as a page: its one-line
  `status_line` (tap to edit; Kenaznia sets it too), its to-dos (`todo.conversation_id`), its chats (the topic itself and
  rooms whose `project_id` points at it, ＋ New), its files (`GET /api/ext/organized/projects/:id/files`, from
  `conversation_file`) and the key date. On wide screens the page sits in the list pane next to its chat.
- **Rooms tool** (extension `rooms`): agents `list`, `create` (members: the person and her Kenaznia), `rename` (refused
  with `title_locked` for a name she chose unless `herRequest`), `project` (page on/off, status) and `group` (projectId),
  so Kenaznia can suggest and open a new room when the subject changes.
- **Calendar** (Organized only, `web/organized/CalendarViews.tsx`): Day/Week/Month switch, ‹ › and Today, swipe to move,
  tap a day to open it; pinch zooms the hour scale (20–120 px/hour, anchored, per device) with Ctrl+wheel and − ＋ as
  alternatives; "List & add event" shows Classic's calendar page.
- **Colours** (`web/organized/colors.ts`): gradient by position, warm for to-dos, cool for recent topics, precomputed
  `#RRGGBBAA` tints (never `color-mix()`); a test keeps white text ≥ 4.5:1 on every tint (gold is capped at 50%).
- **Back.** Overlays close first (useOverlay); otherwise Back from any Organized screen returns Home, and Back on Home
  leaves the app. In Classic with the extension, on a phone, Back from a page opens the conversation list first.

### Prompt caching and token economy

Most spend is the context re-read on every call, so the structure keeps it cached and small (measurements and
before/after in `work/kenan/token-spend` on kenan-server):
- **One-hour cache** (`longPromptCache`, `server/agents/runtime.ts`): every request writes its prompt cache with the
  one-hour lifetime. Agents idle minutes between inputs; with the five-minute default each wake, report, note or
  heartbeat after a gap rewrote the whole context (Beta, 2026-10-20/21: 34% of the day's spend).
- **Prompt sections**: the system prompt is the profile's text, then each context file, the extensions' notes and the
  agent's role as separate Pi sections (`promptSections`, `contextSections`). A restarted session whose files or role
  text changed gets only the changed sections in a mid-conversation update, not a copy of the whole prompt.
- **Shared prefix** (`shareSystemPrefix`): everything before the role section, and the tools (whose descriptions name
  no agent id), is the same for every agent of a person, so it is its own cached block and a new worker reads it instead
  of writing it. The Claude Code identity block gives up its breakpoint for this, keeping Anthropic's four.
- **Routine events** (`addressedSettled`, `server/agents/wakes.ts`): host events marked `routine: true` by their producer
  (the Acme event relay marks deploys going live, queue admissions, qualified merges, resolved contention and flaky
  reruns) settle a burst after 3 quiet minutes or 10 from the first, so a release's per-product events are one turn.
- **Peer replies go to the agent that asked** (`server/peers.ts`): a peer message may name `to`, an agent on the
  receiving side; a live one gets it directly, otherwise the Kenaznia does with a note saying so. The note tells the
  recipient to reply `to` the sending agent, so worker↔worker exchanges across hosts stop passing through both
  Kenaznias.

### Context compaction

`installContextBudget` (`server/agents/context-budget.ts`) runs before every model request. At 600k tokens
(or the model's own budget) it summarizes all but the latest ~40k tokens into a compaction entry; the session
journal keeps every original. A compaction always completes, so it is never retried on the next request:
each chronological segment is summarized from the full transcript, then from a reduced one (no thinking, no raw
tool output, hex/base64 dumps removed), each on the agent's model and then on its profile's
`refusalFallbackModels` (same subscription broker; a model that refused goes last for later segments). Anthropic's
cyber classifier refuses nondeterministically and per model: on 36e1d1e0's real history Opus 5.5 refused a segment
that Opus 5 and Sonnet 5 summarized. If every attempt on a segment fails (refusal, outage after bounded retries,
missing auth) the rest becomes a mechanical checkpoint (previous checkpoint, instructions, files touched, last tool
calls and notes, the transcript path). A worker's first instruction is
pinned verbatim in every checkpoint. The route (`model`/`reduced`/`structured`) and each typed failure
(`refused`/`truncated`/`failed`) go into the compaction entry, and non-`model` routes into `error_log` as
`context_compaction_recovered`. Regression: `server/agents/compaction-refusal.test.ts`.

### Provider refusals on agent turns

Anthropic's streaming classifier can stop an ordinary response mid-stream (thinking and a partial tool call, then
`stop_reason: refusal`, which Pi reports as an error). `installRefusalRecovery` (`server/agents/refusal.ts`) wraps the
session's provider stream: a refused request is sent again, unchanged, to the next of [agent's model, ...profile
`refusalFallbackModels`] (same subscription broker), and the response the agent loop sees is the first one that is not
a refusal; the refused partials are superseded and never reach the transcript or run a tool. Each model is tried at
most once per request, and models that refused go last for the rest of the turn. Every refused attempt is recorded
(`model_call` usage, `error_log` `model_refusal_recovered`). If every model refuses, the turn ends with the refusal and
the runtime delivers one `refusal` input (`refusalNotice`) so the agent continues with the refusal in context
(`model_refusal_continued`); if that continuation is refused by every model too, nothing more is sent to the agent:
`model_refusal_unrecovered` is logged and a worker's launcher gets a note. Compaction summaries use the unwrapped
stream (`CompactionPolicy.stream`) because they try each model themselves. Regression:
`server/agents/refusal.test.ts`.

### Heartbeat

Timer per person with a manager: every `heartbeatMinutes` (30) since the last
check, both stored in `agent_heartbeat`, so restarts add none. A check compares a
cheap digest against the last *delivered* heartbeat (`decideHeartbeat` in
`server/agents/heartbeat.ts`): open goals and their `updatedAt`, unarchived
workers and their state, host alert files (name and heading), the sha256 of
`HEARTBEAT.md`, plus any error logged or wake dropped since. Pending wakes are no
reason (each fires itself). If nothing moved, only `checked_at` is written and no
model turn runs. A manager with open goals, workers or a `HEARTBEAT.md` still gets
one after `HEARTBEAT_FLOOR_MS` (4 h) of no change, so time-based checklist items
and stalled work are reviewed; with none of those it is never woken idle. The
status block opens with `Why now:` and the reasons. Input text =
contents of the person's `HEARTBEAT.md` (if absent, a one-line default) +
`<status>` block rendered by a pure function from the store: one line per open
goal with its workers (waiting ones marked ⚠ with how long and on what) and the triggers held for it, marked when
moved since the previous heartbeat, then the goals waiting on a held trigger and, flagged ⚠, open goals with no worker
and no held trigger; usage per
pool with each account's own share left, drain, projected exhaustion and reset
(a reset is never negative drain; the pool runs out when every account has, each
refilling on its own schedule). Drain is a typed state per account and metric:
measured only from 30+ minutes of readings whose latest is under 15 minutes old,
otherwise `stale` or `unmeasured`; the pool projects from measured drains alone,
names the accounts whose drain is unknown, and is `stale` when no reading is
fresh (idle accounts or failed polls); spend; latency for the last day; errors
since the previous heartbeat; and, when the person's `alertDir` is set, every
open host condition in that inbox (one `*.md` file each, deleted by its producer
once resolved; kenan-server uses `/var/lib/machine-alerts/inbox`).

## Latency (acceptance gate)

Every human message records `clientSentAt` (client clock), `receivedAt`
(request entry), `admittedAt` (after insert + broadcast), `modelRequestAt`,
`firstTokenAt` (first text delta of the reply), `firstTextAt` (client-reported
first render). `/api/metrics` returns p50/p90/p99 of each interval. Targets:
receive→admit p99 < 50 ms; admit→first token p50 < 2 s, p99 < 5 s.
`bench/latency.ts` measures end to end against a channel.
