-- Kenan Stack schema. Plain tables, no triggers. Applied idempotently at startup.
-- Timestamps are epoch milliseconds (bigint).

-- A database created before this schema must already be at its shape: the migrations that reached it were removed
-- on 2026-10-21. Such a database records them in schema_migration (kept, so an earlier build still starts on it); one that lacks them
-- is refused before anything changes.
CREATE TABLE IF NOT EXISTS schema_migration (id text PRIMARY KEY);
DO $$ BEGIN
  IF to_regclass('agent') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM schema_migration WHERE id = 'baseline-2026-10-21') THEN
    IF (SELECT count(*) FROM schema_migration WHERE id IN ('agent-archive-v1', 'heartbeat-digest-v1', 'wake-signal-chat-v1',
        'wake-event-topic-v1', 'wake-time-or-event-v1', 'message-notice-kind-v1', 'message-display-v1', 'message-notice-kinds-v2')) <> 8
      OR to_regclass('conversation_file') IS NULL OR to_regclass('todo') IS NULL THEN
      RAISE EXCEPTION 'schema_predates_baseline: start Kenan Stack 41e99a1b on this database once before this build';
    END IF;
    DROP TRIGGER IF EXISTS wake_listen_unset ON wake;
    DROP FUNCTION IF EXISTS wake_listen_unset();
    ALTER TABLE wake RENAME CONSTRAINT wake_check1 TO wake_settled;
    UPDATE agent SET state = 'idle' WHERE state = 'parked';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS person (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('human','agent')),
  created_at  bigint NOT NULL,
  layout      text NOT NULL DEFAULT 'classic' CHECK (layout IN ('classic', 'organized')),
  -- Organized onboarding already given (shared/contract.ts ONBOARDING): the welcome message and each first-visit tip, once each.
  seen        text[] NOT NULL DEFAULT '{}' CHECK (seen <@ ARRAY['welcome', 'home', 'chats', 'todo', 'bubble'])
);
-- The IANA zone the person's app last reported from their device (PUT /api/zone); null until it reports one (shared/zone.ts HOME_ZONE).
-- The footer tray tiles the person chose, in order (shared/contract.ts TRAY_TILES); null: their configured default.
ALTER TABLE person ADD COLUMN IF NOT EXISTS tray_tiles text[];
ALTER TABLE person ADD COLUMN IF NOT EXISTS time_zone text;
ALTER TABLE person ADD COLUMN IF NOT EXISTS phone_time_zone text;
ALTER TABLE person ADD COLUMN IF NOT EXISTS quiet_hours jsonb NOT NULL DEFAULT '{"enabled":false,"start":"00:00","end":"09:00"}';
-- The kind of device that last reported time_zone (shared/zone.ts DEVICES); 'unknown' also for zones reported before apps said.
ALTER TABLE person ADD COLUMN IF NOT EXISTS zone_device text NOT NULL DEFAULT 'unknown' CONSTRAINT person_zone_device CHECK (zone_device IN ('phone', 'tablet', 'computer', 'unknown'));
UPDATE person SET phone_time_zone=time_zone WHERE phone_time_zone IS NULL AND zone_device='phone';
-- Onboarding arrived on 2026-10-22: whoever already used Organized then (Carol, who designed it) has had all of it,
-- the hidden-bubble note (added the same evening) included.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migration WHERE id = 'onboarding-v1') THEN
    ALTER TABLE person ADD COLUMN IF NOT EXISTS seen text[] NOT NULL DEFAULT '{}' CHECK (seen <@ ARRAY['welcome', 'home', 'chats', 'todo']);
    UPDATE person SET seen = ARRAY['welcome', 'home', 'chats', 'todo'] WHERE layout = 'organized';
    INSERT INTO schema_migration VALUES ('onboarding-v1');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migration WHERE id = 'onboarding-bubble') THEN
    ALTER TABLE person DROP CONSTRAINT IF EXISTS person_seen_check;
    ALTER TABLE person ADD CONSTRAINT person_seen_check CHECK (seen <@ ARRAY['welcome', 'home', 'chats', 'todo', 'bubble']);
    UPDATE person SET seen = array_append(seen, 'bubble') WHERE layout = 'organized' AND NOT 'bubble' = ANY (seen);
    INSERT INTO schema_migration VALUES ('onboarding-bubble');
  END IF;
  -- 'bubble' became the 🌀 tip shown the first time the bubble appears (2026-10-25); whoever already uses Organized knows it.
  IF NOT EXISTS (SELECT 1 FROM schema_migration WHERE id = 'onboarding-bubble-tip') THEN
    UPDATE person SET seen = array_append(seen, 'bubble') WHERE layout = 'organized' AND NOT 'bubble' = ANY (seen);
    INSERT INTO schema_migration VALUES ('onboarding-bubble-tip');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent (
  id              text PRIMARY KEY REFERENCES person(id),
  owner_id        text NOT NULL REFERENCES person(id),
  role            text NOT NULL CHECK (role IN ('manager','worker','blank')),
  conversation_id uuid NOT NULL,
  goal_id         uuid,
  state           text NOT NULL DEFAULT 'idle',
  model           text NOT NULL,
  session_path    text NOT NULL,                 -- Pi JSONL session file
  last_report     jsonb,
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL,
  parent_agent_id text REFERENCES agent(id),
  archived        boolean NOT NULL DEFAULT false,
  -- Explicit admissions pin thinking; workers without it keep their owner's configured thinking.
  thinking        text CHECK (thinking IS NULL OR thinking IN ('off','minimal','low','medium','high','xhigh','max'))
);
-- listAgents reads every agent of an owner, archived ones included, in creation order: without an ordered index that sort
-- (9,600 agents, 12 MB) spilled past work_mem to temp files and failed when the disk filled (2026-10-29).
-- How fast its model calls run (server/agents/speed.ts): fast and ultrafast are Codex service tiers; admission checks the route offers it.
ALTER TABLE agent ADD COLUMN IF NOT EXISTS speed text NOT NULL DEFAULT 'normal' CONSTRAINT agent_speed CHECK (speed IN ('normal','fast','ultrafast'));
-- 'blank' (2026-11-01): a temporary chat with a model the person chose and no context (server/agents/blank.ts).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_role' AND conrelid = 'agent'::regclass) THEN
    ALTER TABLE agent DROP CONSTRAINT IF EXISTS agent_role_check;
    ALTER TABLE agent ADD CONSTRAINT agent_role CHECK (role IN ('manager', 'worker', 'blank'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS agent_owner_created ON agent(owner_id, created_at, id);
CREATE INDEX IF NOT EXISTS agent_created ON agent(created_at, id);
DROP INDEX IF EXISTS agent_owner;
CREATE INDEX IF NOT EXISTS agent_parent ON agent(parent_agent_id);
CREATE INDEX IF NOT EXISTS agent_goal ON agent(goal_id, created_at, id);

-- Topics carry an emoji, a pin with an optional key date ("Due Oct 29") and a title the person set herself (locked
-- against auto-renaming). A topic can be a project with a status line; other rooms can be grouped under it.
CREATE TABLE IF NOT EXISTS conversation (
  id           uuid PRIMARY KEY,
  title        text NOT NULL,
  owner_id     text NOT NULL REFERENCES person(id),
  agent_id     text REFERENCES person(id),
  archived     boolean NOT NULL DEFAULT false,
  color        text,
  last_seq     bigint NOT NULL DEFAULT 0,
  created_at   bigint NOT NULL,
  updated_at   bigint NOT NULL,
  emoji        text,
  pinned_at    bigint,
  key_date     text CHECK (key_date IS NULL OR key_date ~ '^\d{4}-\d{2}-\d{2}$'),
  key_label    text,
  title_locked boolean NOT NULL DEFAULT false,
  project      boolean NOT NULL DEFAULT false,
  status_line  text,
  project_id   uuid REFERENCES conversation(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS member (
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  person_id       text NOT NULL REFERENCES person(id),
  read_through    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, person_id)
);
CREATE INDEX IF NOT EXISTS member_person ON member(person_id);

-- A notice carries its kind (shared/contract.ts NoticeKind) and every message how the app draws it (MessageDisplay).
CREATE TABLE IF NOT EXISTS message (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  author_id       text NOT NULL,
  role            text NOT NULL CHECK (role IN ('human','assistant','tool','notice')),
  text            text NOT NULL DEFAULT '',
  parts           jsonb NOT NULL DEFAULT '[]',
  state           text NOT NULL DEFAULT 'done',
  client_id       text,
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL,
  notice          text,
  display         text NOT NULL CONSTRAINT message_display CHECK (display IN ('shown', 'background', 'silent')),
  UNIQUE (conversation_id, seq),
  CONSTRAINT message_notice CHECK ((role = 'notice') = (notice IS NOT NULL)
    AND notice IN ('worker_note', 'worker_report', 'peer_message', 'wake', 'heartbeat', 'system', 'report', 'agent_error', 'meeting_caption', 'imported', 'channel', 'membership', 'agent_message'))
);
-- Direct messages to workers and membership notices are shown in the chat.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_notice' AND conrelid = 'message'::regclass AND pg_get_constraintdef(oid) LIKE '%agent_message%') THEN
    ALTER TABLE message DROP CONSTRAINT IF EXISTS message_notice;
    ALTER TABLE message ADD CONSTRAINT message_notice CHECK ((role = 'notice') = (notice IS NOT NULL)
      AND notice IN ('worker_note', 'worker_report', 'peer_message', 'wake', 'heartbeat', 'system', 'report', 'agent_error', 'meeting_caption', 'imported', 'channel', 'membership', 'agent_message'));
  END IF;
END $$;
ALTER TABLE message ADD COLUMN IF NOT EXISTS background_summary text;
ALTER TABLE message ADD COLUMN IF NOT EXISTS edited_at bigint;
ALTER TABLE message ADD COLUMN IF NOT EXISTS deleted_at bigint;
CREATE UNIQUE INDEX IF NOT EXISTS message_client ON message(client_id) WHERE client_id IS NOT NULL;
-- store.ts PREVIEWABLE: a conversation's preview is its newest shown message with words or files.
CREATE INDEX IF NOT EXISTS message_preview ON message (conversation_id, seq)
  WHERE display = 'shown' AND role <> 'tool' AND (btrim(text, E' \t\n\r') <> '' OR parts @> '[{"type":"file"}]' OR parts @> '[{"type":"image"}]');

CREATE TABLE IF NOT EXISTS goal (
  id          uuid PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES person(id),
  title       text NOT NULL,
  detail      text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  priority    int NOT NULL DEFAULT 100,
  notes       text NOT NULL DEFAULT '',
  created_at  bigint NOT NULL,
  updated_at  bigint NOT NULL
);

-- A goal owns its category; workers (including sub-agents) read it dynamically, never copy it.
-- Existing open infrastructure tasks are classified only when this column is first added, so later starts never
-- overwrite a person's explicit reclassification. The column and backfill commit atomically in this block.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'goal'::regclass AND attname = 'category' AND NOT attisdropped) THEN
    ALTER TABLE goal ADD COLUMN category text NOT NULL DEFAULT 'work' CHECK (category IN ('work', 'upkeep'));
    UPDATE goal SET category = 'upkeep' WHERE status = 'open' AND (
      title ~* '\m(gpurun|hfstage|hfstore|dt[.]py|megabatch|demorun|gpujob|agent[-_ ]?browser|cpu[-_ ]?slot|lean[-_ ]?slot|ResearchCo[-_ ]?history|kenan[-_ ]?(cold|snap|spend|disk[-_ ]?census|bg)|model[-_ ]?broker)\M'
      OR title ~* '\m(mail[-_ ]?send|mail send|cold (tier|restore|storage)|spend ledger|disk census)\M'
      OR title ~* '^app([ :]|$)'
      OR (title ~* '\m(stack|environment|host|system|deploy|pipeline|browser)\M' AND title ~* '\m(fix|fixes|repair|broken|slow|stall|stalls|fail|failure|crash|permission|migration|move)\M')
      OR title ~* '(move kenan[-_ ]?server|kenan[-_ ]?server.*migrat)'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS file (
  id          uuid PRIMARY KEY,
  owner_id    text NOT NULL,
  name        text NOT NULL,
  mime        text NOT NULL,
  size        bigint NOT NULL,
  path        text NOT NULL,
  created_at  bigint NOT NULL
);

-- Which conversations show a file: people see a file they own or one shown in a conversation they are a member of.
-- appendMessage/updateMessage keep it current.
CREATE TABLE IF NOT EXISTS conversation_file (
  file_id         uuid NOT NULL REFERENCES file(id),
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, conversation_id)
);

-- One row per human message; filled in as the reply progresses.
CREATE TABLE IF NOT EXISTS latency (
  message_id        uuid PRIMARY KEY,
  conversation_id   uuid NOT NULL,
  client_sent_at    bigint,
  received_at       bigint NOT NULL,
  admitted_at       bigint NOT NULL,
  model_request_at  bigint,
  first_token_at    bigint,
  first_text_at     bigint
);
CREATE INDEX IF NOT EXISTS latency_admitted ON latency(admitted_at);

-- One row per model call (usage accounting for drain rate and per-agent spend).
CREATE TABLE IF NOT EXISTS model_call (
  id            bigserial PRIMARY KEY,
  agent_id      text NOT NULL,
  model         text NOT NULL,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read    bigint NOT NULL DEFAULT 0,
  cache_write   bigint NOT NULL DEFAULT 0,
  cost_usd      numeric NOT NULL DEFAULT 0,
  at            bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS model_call_at ON model_call(at);
CREATE INDEX IF NOT EXISTS model_call_agent_at ON model_call(agent_id, at) INCLUDE (cost_usd);

-- Usage plan samples from the broker, for drain-rate computation.
CREATE TABLE IF NOT EXISTS usage_sample (
  source        text NOT NULL,             -- broker:<port>; brokers can differ per person
  provider      text NOT NULL,
  metric        text NOT NULL,
  account       text NOT NULL,             -- one row per subscription account; plan-wide averages are not stored
  percent_left  double precision,
  reset_at      bigint,
  window_hours  double precision,
  reading_at    bigint NOT NULL,           -- when the broker read the account's meter
  at            bigint NOT NULL            -- when Kenan polled the broker
);
CREATE INDEX IF NOT EXISTS usage_sample_at ON usage_sample(at);

-- Login sessions (cookie kenan_session carries the HMAC-signed id).
CREATE TABLE IF NOT EXISTS session (
  id          text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES person(id),
  expires_at  bigint NOT NULL,
  created_at  bigint NOT NULL
);

-- Errors worth showing Kenaznia on heartbeat (bounded; old rows pruned on heartbeat).
CREATE TABLE IF NOT EXISTS error_log (
  id      bigserial PRIMARY KEY,
  scope   text NOT NULL,          -- e.g. agent:<id>, http, heartbeat
  message text NOT NULL,
  at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS error_log_at ON error_log(at);
-- Every input delivered to an agent, stored before delivery is acknowledged and deleted once the agent's transcript holds it (or it is dropped), so restarts and crashes lose nothing.
-- Restart continuity: inputs queued but not started at shutdown, delivered once on the next start.
-- Delivery keys outlive pending rows so redelivery after consumption remains a duplicate.
CREATE TABLE IF NOT EXISTS agent_input_delivery_key (
  delivery_key text PRIMARY KEY,
  owner_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_pending_input (
  id          bigserial PRIMARY KEY,
  agent_id    text NOT NULL REFERENCES agent(id),
  input       jsonb NOT NULL,
  created_at  bigint NOT NULL
);

-- Attribute already-recorded delivery keys before person-scoped database exports.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agent_input_delivery_key' AND column_name = 'owner_id') THEN
    ALTER TABLE agent_input_delivery_key ADD COLUMN owner_id text;
    UPDATE agent_input_delivery_key k SET owner_id = a.owner_id FROM agent_pending_input i JOIN agent a ON a.id = i.agent_id WHERE i.input->>'deliveryKey' = k.delivery_key;
    UPDATE agent_input_delivery_key SET owner_id = split_part(delivery_key, ':', 2) WHERE owner_id IS NULL AND delivery_key LIKE 'peer:%';
  END IF;
END $$;

-- What each manager's last delivered heartbeat showed (at) and when it was last compared (checked_at); one row per manager.
CREATE TABLE IF NOT EXISTS agent_heartbeat (
  agent_id    text PRIMARY KEY REFERENCES agent(id),
  at          bigint NOT NULL,
  error_id    bigint NOT NULL,
  goals       jsonb NOT NULL,
  workers     jsonb NOT NULL,
  checked_at  bigint NOT NULL,
  alerts      jsonb NOT NULL,
  checklist   text
);
-- When the last heartbeat with every goal and the whole HEARTBEAT.md was delivered; NULL after a compaction.
ALTER TABLE agent_heartbeat ADD COLUMN IF NOT EXISTS shown_full_at bigint;
-- Host alerts by file name as the last delivered heartbeat listed them (title, severity, when); unchanged ones are only counted.
ALTER TABLE agent_heartbeat ADD COLUMN IF NOT EXISTS alerts_shown jsonb NOT NULL DEFAULT '{}';

-- Phone notifications agents send their owner. The Android app streams them and replays ids after its last one.
CREATE TABLE IF NOT EXISTS notification (
  id              bigserial PRIMARY KEY,
  person_id       text NOT NULL REFERENCES person(id),
  agent_id        text NOT NULL REFERENCES agent(id),
  conversation_id uuid NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  level           text NOT NULL CHECK (level IN ('normal','urgent')),
  created_at      bigint NOT NULL,
  image_file_id   uuid REFERENCES file(id)
);
ALTER TABLE notification ADD COLUMN IF NOT EXISTS collapse_key text;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS dismissed boolean NOT NULL DEFAULT false;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS quiet_held boolean NOT NULL DEFAULT false;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS quiet_summarized boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS notification_person ON notification(person_id, id);
-- Web Push subscriptions (installed web apps, e.g. an iPhone home-screen app): notify sends each of the person's
-- notifications to every one; a push service answering 404/410 removes it.
CREATE TABLE IF NOT EXISTS push_subscription (
  endpoint   text PRIMARY KEY,
  person_id  text NOT NULL REFERENCES person(id),
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscription_person ON push_subscription(person_id);

-- Self-scheduled resumes (server/agents/wakes.ts): an agent wakes itself at a time, on an event (mail, Signal, a text,
-- a host event topic), or whichever comes first. Fires once. Every wake also listens for anything addressed to its agent
-- that arrived since listen_since and no wake carried ('addressed'), unless it is a clock wake (time only; clock_reason
-- says why the time itself is the trigger). 'own' records a settled wake that listened only for its own trigger.
-- Signal wakes name their conversation: direct, one group, or any.
-- Held triggers (wakes.ts handOff): a worker whose wait would be long hands it to its manager. The wake belongs to the
-- manager and carries the goal, the worker that handed it off (null when the manager holds one for a goal itself) and the handoff.
CREATE TABLE IF NOT EXISTS wake (
  id           uuid PRIMARY KEY,
  agent_id     text NOT NULL REFERENCES agent(id),
  owner_id     text NOT NULL REFERENCES person(id),
  message      text NOT NULL,
  at           bigint,
  event        jsonb,
  status       text NOT NULL CHECK (status IN ('pending','fired','cancelled','dropped')),
  reason       text CHECK (reason IN ('time','event','cancelled','agent_archived','agent_stopped','agent_missing')),
  detail       text,
  created_at   bigint NOT NULL,
  settled_at   bigint,
  listen       text NOT NULL,
  listen_since bigint,
  clock_reason text,
  goal_id      uuid REFERENCES goal(id),
  held_for     text REFERENCES agent(id),
  handoff      text,
  CONSTRAINT wake_settled CHECK ((status = 'pending') = (reason IS NULL AND settled_at IS NULL)),
  CONSTRAINT wake_trigger CHECK (at IS NOT NULL OR event IS NOT NULL OR listen = 'addressed'),
  CONSTRAINT wake_listen CHECK (CASE listen
    WHEN 'addressed' THEN listen_since IS NOT NULL AND clock_reason IS NULL
    WHEN 'clock' THEN coalesce(btrim(clock_reason) <> '', false) AND listen_since IS NULL AND event IS NULL AND at IS NOT NULL
    WHEN 'own' THEN listen_since IS NULL AND clock_reason IS NULL
    ELSE false END),
  CONSTRAINT wake_signal_chat CHECK (CASE WHEN event->>'source' = 'signal' THEN coalesce(
    event->'chat'->>'kind' IN ('direct', 'any') OR (event->'chat'->>'kind' = 'group' AND event->'chat'->>'group' <> ''), false) ELSE true END),
  CONSTRAINT wake_event_topic CHECK (CASE WHEN event->>'source' = 'event' THEN coalesce(
    event->>'topic' ~ '^[A-Za-z0-9._:@/-]{1,200}$' AND jsonb_typeof(event->'prefix') = 'boolean', false) ELSE true END),
  CONSTRAINT wake_held CHECK ((goal_id IS NULL) = (handoff IS NULL) AND (held_for IS NULL OR goal_id IS NOT NULL) AND (handoff IS NULL OR btrim(handoff) <> ''))
);
-- A pending 'own' wake (2026-10-28) is one a sub-agent hands its coordinator: it fires only on its event or deadline, never on what is addressed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wake_listen' AND conrelid = 'wake'::regclass AND pg_get_constraintdef(oid) LIKE '%status%') THEN
    ALTER TABLE wake DROP CONSTRAINT wake_listen;
    ALTER TABLE wake ADD CONSTRAINT wake_listen CHECK (CASE listen
      WHEN 'addressed' THEN listen_since IS NOT NULL AND clock_reason IS NULL
      WHEN 'clock' THEN coalesce(btrim(clock_reason) <> '', false) AND listen_since IS NULL AND event IS NULL AND at IS NOT NULL
      WHEN 'own' THEN listen_since IS NULL AND clock_reason IS NULL
      ELSE false END);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS wake_pending ON wake(owner_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS wake_agent ON wake(agent_id, created_at);
CREATE INDEX IF NOT EXISTS wake_goal ON wake (goal_id) WHERE goal_id IS NOT NULL;

-- Host events (server/event-inbox.ts): taken from /var/lib/kenan/events/PERSON; they fire `on: event` wakes by topic.
-- id is the producer's idempotency key; consumed_at is when a wake first carried the event.
CREATE TABLE IF NOT EXISTS host_event (
  owner_id     text NOT NULL REFERENCES person(id),
  id           text NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  topic        text NOT NULL CHECK (topic ~ '^[A-Za-z0-9._:@/-]{1,200}$'),
  body         jsonb NOT NULL,
  arrived_at   bigint NOT NULL,
  consumed_at  bigint,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS host_event_topic ON host_event(owner_id, topic, arrived_at);
CREATE INDEX IF NOT EXISTS host_event_unconsumed ON host_event(owner_id, arrived_at) WHERE consumed_at IS NULL;

-- Messages between this person's Kenaznia and a peer Kenaznia on another host (config people[].peers).
-- 'out' rows wait for the relay to hand them to the peer (relayed_at); 'in' rows are kept once per sender id.
-- to_agent is the agent on the receiving side a message is addressed to; NULL addresses that side's Kenaznia.
-- Keyed by (owner_id, id): when both Kenaznias live in one database (two people on one channel), the sender's 'out'
-- row and the receiver's 'in' row share the message id.
CREATE TABLE IF NOT EXISTS peer_message (
  id          uuid NOT NULL,
  owner_id    text NOT NULL REFERENCES person(id),
  peer_id     text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('out','in')),
  from_agent  text NOT NULL,
  text        text NOT NULL,
  created_at  bigint NOT NULL,
  relayed_at  bigint,
  to_agent    text CONSTRAINT peer_message_to_agent CHECK (to_agent IS NULL OR length(to_agent) BETWEEN 1 AND 200),
  CHECK (direction = 'out' OR relayed_at IS NULL),
  CONSTRAINT peer_message_pkey PRIMARY KEY (owner_id, id)
);
-- Until 2026-11-01 the key was id alone, so a receiver on the sender's database saw every message as already received.
DO $$ BEGIN
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'peer_message'::regclass AND conname = 'peer_message_pkey') = 'PRIMARY KEY (id)' THEN
    ALTER TABLE peer_message DROP CONSTRAINT peer_message_pkey;
    ALTER TABLE peer_message ADD CONSTRAINT peer_message_pkey PRIMARY KEY (owner_id, id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS peer_message_outbox ON peer_message(owner_id, peer_id, created_at) WHERE direction = 'out' AND relayed_at IS NULL;
CREATE INDEX IF NOT EXISTS peer_message_history ON peer_message(owner_id, peer_id, created_at);

-- To-do list per person (server/extensions/todos.ts). Deleting sets deleted_at, so Undo restores it.
CREATE TABLE IF NOT EXISTS todo (
  id              uuid PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES person(id),
  text            text NOT NULL CHECK (btrim(text) <> ''),
  level           text NOT NULL CONSTRAINT todo_level_check CHECK (level IN ('today', 'soon', 'later', 'someday', 'week')),
  tag             text,
  due_at          bigint,
  remind          boolean NOT NULL DEFAULT false,
  position        double precision NOT NULL,
  conversation_id uuid REFERENCES conversation(id) ON DELETE SET NULL,
  done_at         bigint,
  deleted_at      bigint,
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_owner ON todo (owner_id, level, position) WHERE deleted_at IS NULL;
-- own_room: conversation_id is the chat opened for this to-do by tapping it; it closes when the to-do is done or deleted
-- and reopens with it. Linking the to-do to another room clears it, so no other chat is ever closed this way.
ALTER TABLE todo ADD COLUMN IF NOT EXISTS own_room boolean NOT NULL DEFAULT false;
-- Levels today|soon|later|someday (Carol 2026-10-22) replace today|week|someday: 'week' rows become 'soon'. The check
-- still admits 'week' so a rolled-back build can write it; the server never stores it (the API maps it to 'soon').
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'todo_level_check' AND conrelid = 'todo'::regclass AND pg_get_constraintdef(oid) LIKE '%later%') THEN
    ALTER TABLE todo DROP CONSTRAINT IF EXISTS todo_level_check;
    ALTER TABLE todo ADD CONSTRAINT todo_level_check CHECK (level IN ('today', 'soon', 'later', 'someday', 'week'));
  END IF;
END $$;
UPDATE todo SET level = 'soon' WHERE level = 'week';
-- on_date: the day a to-do is for, without a time (in shared/todo.ts TODO_ZONE); from that day on it shows in Today.
ALTER TABLE todo ADD COLUMN IF NOT EXISTS on_date date;
-- on_home: she asked for this item on Home ("Waiting on you") whatever its level; done items leave Home, reopening keeps it.
ALTER TABLE todo ADD COLUMN IF NOT EXISTS on_home boolean NOT NULL DEFAULT false;
-- details: background, links, steps and notes (markdown), shown at the top of the to-do's chat; text stays a short title.
ALTER TABLE todo ADD COLUMN IF NOT EXISTS details text;
-- A question Kenaznia asks her (the question tool): options are the 2–4 answers she taps, answer the one she chose.
ALTER TABLE todo ADD COLUMN IF NOT EXISTS options text[];
ALTER TABLE todo ADD COLUMN IF NOT EXISTS answer text;
-- dismissed_at: she tapped Dismiss on the question (to write a fuller answer in the chat); deleted_at is set with it.
ALTER TABLE todo ADD COLUMN IF NOT EXISTS dismissed_at bigint;

-- A person's chat groups (Organized Chats sections). A room's group is per member (member.group_id), and the
-- composite key makes a group usable only by its owner; deleting a group leaves its rooms ungrouped.
CREATE TABLE IF NOT EXISTS chat_group (
  id         uuid PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES person(id),
  name       text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 60),
  emoji      text CHECK (emoji IS NULL OR length(emoji) <= 16),
  family     text NOT NULL CHECK (family IN ('amber', 'garnet', 'plum', 'blue', 'teal', 'lime')),
  position   double precision NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (id, owner_id)
);
CREATE INDEX IF NOT EXISTS chat_group_owner ON chat_group (owner_id, position);
ALTER TABLE member ADD COLUMN IF NOT EXISTS group_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_group' AND conrelid = 'member'::regclass) THEN
    ALTER TABLE member ADD CONSTRAINT member_group FOREIGN KEY (group_id, person_id) REFERENCES chat_group (id, owner_id) ON DELETE SET NULL (group_id);
  END IF;
END $$;

-- The 🛒 To buy list (server/extensions/shopping.ts): a person's sections, then items. A person has no sections until the
-- list is first read, which creates the three starting ones; the last section can't be deleted. Bought items leave the list.
CREATE TABLE IF NOT EXISTS buy_section (
  id         uuid PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES person(id),
  name       text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 40),
  emoji      text CHECK (emoji IS NULL OR length(emoji) <= 16),
  color      text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  position   double precision NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (id, owner_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS buy_section_name ON buy_section (owner_id, lower(name));
CREATE TABLE IF NOT EXISTS buy_item (
  id         uuid PRIMARY KEY,
  owner_id   text NOT NULL,
  section_id uuid NOT NULL,
  text       text NOT NULL CHECK (btrim(text) <> '' AND length(text) <= 200),
  position   double precision NOT NULL,
  bought_at  bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  FOREIGN KEY (section_id, owner_id) REFERENCES buy_section (id, owner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS buy_item_open ON buy_item (owner_id, section_id, position) WHERE bought_at IS NULL;

-- A room's organisation is each member's own (shared/contract.ts ConversationSummary): emoji, colour, pin with its key
-- date, project page and status line, and the project it is filed under, which must be a room that member is in (leaving
-- it unfiles the room). The conversation table's copies of these columns are no longer read; they stay for a rollback.
ALTER TABLE member ADD COLUMN IF NOT EXISTS emoji text,
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS pinned_at bigint,
  ADD COLUMN IF NOT EXISTS key_date text CONSTRAINT member_key_date CHECK (key_date IS NULL OR key_date ~ '^\d{4}-\d{2}-\d{2}$'),
  ADD COLUMN IF NOT EXISTS key_label text,
  ADD COLUMN IF NOT EXISTS project boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status_line text,
  ADD COLUMN IF NOT EXISTS project_id uuid CONSTRAINT member_project_other CHECK (project_id <> conversation_id);
-- Each member's own colours for the people's messages in a room (person id -> #rrggbb, shared/colors.ts MEMBER_COLORS).
ALTER TABLE member ADD COLUMN IF NOT EXISTS member_colors jsonb NOT NULL DEFAULT '{}' CONSTRAINT member_member_colors CHECK (jsonb_typeof(member_colors) = 'object');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_project' AND conrelid = 'member'::regclass) THEN
    ALTER TABLE member ADD CONSTRAINT member_project FOREIGN KEY (project_id, person_id) REFERENCES member (conversation_id, person_id) ON DELETE SET NULL (project_id);
  END IF;
  -- Each human member keeps what the room showed them. A room filed under a project was organised by the members of that
  -- project page, so when any human member is in it, only those members inherit the room's organisation.
  IF NOT EXISTS (SELECT 1 FROM schema_migration WHERE id = 'member-organisation-v1') THEN
    UPDATE member m SET emoji = c.emoji, color = c.color, pinned_at = c.pinned_at, key_date = c.key_date, key_label = c.key_label,
        project = c.project, status_line = c.status_line,
        project_id = CASE WHEN EXISTS (SELECT 1 FROM member pm WHERE pm.conversation_id = c.project_id AND pm.person_id = m.person_id) THEN c.project_id END
      FROM conversation c, person p
      WHERE c.id = m.conversation_id AND p.id = m.person_id AND p.kind = 'human'
        AND (c.project_id IS NULL
          OR EXISTS (SELECT 1 FROM member pm WHERE pm.conversation_id = c.project_id AND pm.person_id = m.person_id)
          OR NOT EXISTS (SELECT 1 FROM member o JOIN member pm ON pm.conversation_id = c.project_id AND pm.person_id = o.person_id
            JOIN person op ON op.id = o.person_id AND op.kind = 'human' WHERE o.conversation_id = c.id));
    INSERT INTO schema_migration(id) VALUES ('member-organisation-v1');
  END IF;
  -- Carol's chat palette E (shared/colors.ts CHAT_PALETTE, 2026-10-25): each colour of the palettes before it becomes
  -- its nearest palette colour (ΔE2000), with near ties split so colours that sat side by side stay apart (plum to
  -- lavender, indigo to violet, green to jade); warm reds become magenta or pink. Colours already in the palette stay.
  IF NOT EXISTS (SELECT 1 FROM schema_migration WHERE id = 'chat-palette-e') THEN
    CREATE TEMP TABLE palette_e (old text PRIMARY KEY, new text NOT NULL) ON COMMIT DROP;
    INSERT INTO palette_e VALUES ('#ffc21a', '#f2b42a'), ('#ffa21f', '#f2b42a'), ('#ff8410', '#f08a2e'), ('#ff9433', '#f08a2e'),
      ('#e83a3a', '#f06fb7'), ('#d6304f', '#f06fb7'), ('#b3305f', '#cc3f9e'), ('#d63384', '#cc3f9e'), ('#c03b8f', '#cc3f9e'),
      ('#b23fb8', '#b67cf7'), ('#9a48b8', '#b67cf7'), ('#8a4fd6', '#8a64f0'), ('#5f63d8', '#8a64f0'), ('#7a6fc0', '#8a64f0'),
      ('#5b7fd0', '#4a74e8'), ('#5fa3e0', '#2aa7c9'), ('#2a96a8', '#2aa7c9'), ('#2fb3a8', '#2fb58a'), ('#3fc4b4', '#2fb58a'),
      ('#5fb85a', '#2fb58a'), ('#b5d334', '#9bc53d');
    UPDATE member m SET color = p.new FROM palette_e p WHERE m.color = p.old;
    UPDATE buy_section s SET color = p.new FROM palette_e p WHERE s.color = p.old;
    INSERT INTO schema_migration(id) VALUES ('chat-palette-e');
  END IF;
  -- Her final palette E3 (2026-10-25) replaces four E colours: jade by sea green, teal by pale blue, sapphire by royal
  -- blue, lavender by a paler lavender.
  IF NOT EXISTS (SELECT 1 FROM schema_migration WHERE id = 'chat-palette-e3') THEN
    CREATE TEMP TABLE palette_e3 (old text PRIMARY KEY, new text NOT NULL) ON COMMIT DROP;
    INSERT INTO palette_e3 VALUES ('#2fb58a', '#17b8a0'), ('#2aa7c9', '#6aafff'), ('#4a74e8', '#2f6ff2'), ('#b67cf7', '#c9a0ff');
    UPDATE member m SET color = p.new FROM palette_e3 p WHERE m.color = p.old;
    UPDATE buy_section s SET color = p.new FROM palette_e3 p WHERE s.color = p.old;
    INSERT INTO schema_migration(id) VALUES ('chat-palette-e3');
  END IF;
END $$;

-- Origin chats (server/agents/origin.ts): the chat whose turn started a worker, scheduled a wake or wrote to a peer. For
-- a person on the Organized layout, background answers about that work go back there. Null: the agent's own chat.
ALTER TABLE agent ADD COLUMN IF NOT EXISTS origin_conversation_id uuid REFERENCES conversation(id) ON DELETE SET NULL;
ALTER TABLE wake ADD COLUMN IF NOT EXISTS origin_conversation_id uuid REFERENCES conversation(id) ON DELETE SET NULL;
ALTER TABLE peer_message ADD COLUMN IF NOT EXISTS origin_conversation_id uuid REFERENCES conversation(id) ON DELETE SET NULL;
-- The chat the agent's latest turn answers ({conversationId, chatBound}), written as the turn starts: a turn cut off by
-- a restart resumes there.
ALTER TABLE agent ADD COLUMN IF NOT EXISTS turn_chat jsonb;
-- A goal's chat: the topic chat its workers, reports, answers and held triggers land in unless a call names another.
ALTER TABLE goal ADD COLUMN IF NOT EXISTS chat_id uuid REFERENCES conversation(id) ON DELETE SET NULL;

-- A fresh database is born at the shape the removed migrations reached, so it records them too: an earlier build
-- started on it (a rollback) then skips them instead of re-adding columns that already exist.
INSERT INTO schema_migration(id) VALUES ('baseline-2026-10-21'), ('agent-archive-v1'), ('heartbeat-digest-v1'), ('wake-signal-chat-v1'),
  ('wake-event-topic-v1'), ('wake-time-or-event-v1'), ('message-notice-kind-v1'), ('message-display-v1'), ('message-notice-kinds-v2')
  ON CONFLICT DO NOTHING;

-- One row per credential redaction of an already-stored record (server/redact-cli.ts). Content-free: which record,
-- which credential classes and how many, and hashes of the record before and after; never the secret.
CREATE TABLE IF NOT EXISTS transcript_redaction (
  id              uuid PRIMARY KEY,
  target          text NOT NULL CHECK (target IN ('message', 'session_file')),
  message_id      uuid,
  conversation_id uuid,
  seq             bigint,
  author_id       text,
  path            text,
  classes         jsonb NOT NULL,
  before_sha256   text NOT NULL,
  after_sha256    text NOT NULL,
  requested_by    text NOT NULL,
  reason          text NOT NULL,
  at              bigint NOT NULL,
  CHECK ((target = 'message') = (message_id IS NOT NULL AND conversation_id IS NOT NULL AND seq IS NOT NULL AND path IS NULL)),
  CHECK ((target = 'session_file') = (path IS NOT NULL AND message_id IS NULL))
);
-- The built-in morning to-do check of a person on the Organized layout (server/extensions/organized.ts): on unless they
-- turn it off, at at_minute (minutes after midnight in the person's own time zone). last_day: the latest day it was sent (in
-- the zone it was sent in), or the day the row was made, so it never comes twice a day and starts the day after Organized
-- first runs for them. sent_at: when it was last sent (null: never), so a zone change that starts a new local day soon
-- after a check doesn't send another.
CREATE TABLE IF NOT EXISTS morning_check (
  owner_id  text PRIMARY KEY REFERENCES person(id),
  enabled   boolean NOT NULL,
  at_minute smallint NOT NULL CHECK (at_minute BETWEEN 0 AND 1439),
  last_day  date NOT NULL
);
ALTER TABLE morning_check ADD COLUMN IF NOT EXISTS sent_at bigint;
-- 📰 What's new (server/extensions/changelog.ts): each commit's plain-language line, written once by Haiku and shared by
-- every person (null: a behind-the-scenes change), and how far each person has read (the newest commit time they saw).
CREATE TABLE IF NOT EXISTS changelog_line (
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{40}$'),
  line text CHECK (line IS NULL OR length(line) BETWEEN 1 AND 300),
  at   bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS changelog_seen (
  person_id text PRIMARY KEY REFERENCES person(id),
  through   bigint NOT NULL
);
-- A person's own organisation of a shared chat held on the other channel of this host (server/channels/rooms.ts): the
-- chat, its members and messages stay in that channel's database; how this person files it (emoji, colour, pin, project
-- page, the project and chat group it sits under) is theirs and lives here, where their groups and projects are.
CREATE TABLE IF NOT EXISTS remote_member (
  conversation_id uuid NOT NULL,
  person_id       text NOT NULL REFERENCES person(id),
  color           text,
  emoji           text,
  pinned_at       bigint,
  key_date        text CHECK (key_date IS NULL OR key_date ~ '^\d{4}-\d{2}-\d{2}$'),
  key_label       text,
  project         boolean NOT NULL DEFAULT false,
  status_line     text,
  project_id      uuid,
  group_id        uuid,
  PRIMARY KEY (conversation_id, person_id),
  CONSTRAINT remote_member_group FOREIGN KEY (group_id, person_id) REFERENCES chat_group (id, owner_id) ON DELETE SET NULL (group_id),
  CONSTRAINT remote_member_project FOREIGN KEY (project_id, person_id) REFERENCES member (conversation_id, person_id) ON DELETE SET NULL (project_id)
);
ALTER TABLE remote_member ADD COLUMN IF NOT EXISTS member_colors jsonb NOT NULL DEFAULT '{}' CONSTRAINT remote_member_member_colors CHECK (jsonb_typeof(member_colors) = 'object');

-- Private phone location history. Epoch times are milliseconds; duplicate measurements are immutable.
CREATE TABLE IF NOT EXISTS phone_location (
  person_id text NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  measured_at bigint NOT NULL,
  received_at bigint NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision NOT NULL CHECK (accuracy >= 0 AND accuracy < 'Infinity'::float8),
  place text,
  wifi_ssid text,
  at_home boolean NOT NULL,
  home_since bigint,
  PRIMARY KEY (person_id, measured_at)
);
CREATE INDEX IF NOT EXISTS phone_location_age ON phone_location (measured_at);

-- Retire shared agent posts. Cascades remove messages, members and file links; other chats stay intact.
-- Operator views depend on the column/table being dropped and are rebuilt by deploy/operator/apply-db.sh.
DO $$ BEGIN
  DELETE FROM agent_pending_input WHERE input->>'agentRoom' IN ('batch', 'mention') OR input ? 'agentRoomPosts';
  IF EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'conversation'::regclass AND attname = 'agent_room' AND NOT attisdropped) THEN
    DELETE FROM latency WHERE conversation_id IN (SELECT id FROM conversation WHERE agent_room);
    DELETE FROM notification WHERE conversation_id IN (SELECT id FROM conversation WHERE agent_room);
    DELETE FROM remote_member WHERE conversation_id IN (SELECT id FROM conversation WHERE agent_room);
    DELETE FROM conversation WHERE agent_room;
    ALTER TABLE conversation DROP COLUMN agent_room CASCADE;
  END IF;
  DROP TABLE IF EXISTS agent_room_cursor CASCADE;
END $$;

-- Exact social-post proposals. A signed client decision, not a to-do answer or status, authorizes publication.
CREATE TABLE IF NOT EXISTS ResearchCo_post_proposal (
  id uuid PRIMARY KEY,
  todo_id uuid NOT NULL UNIQUE REFERENCES todo(id),
  payload text NOT NULL,
  seal text NOT NULL,
  test boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  decision text CHECK (decision IN ('Yes','No','Edit')),
  decided_at bigint,
  signature text,
  claimed_at bigint,
  superseded_at bigint
);

-- Predictions are immutable. Reveal changes only the public message, never this original commitment.
CREATE TABLE IF NOT EXISTS sealed_guess (
  id uuid PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES person(id),
  author_id text NOT NULL REFERENCES person(id),
  call_id text NOT NULL,
  guess text NOT NULL,
  salt text NOT NULL,
  hash text NOT NULL,
  sealed_at bigint NOT NULL,
  UNIQUE(author_id, call_id)
);

ALTER TABLE sealed_guess ADD COLUMN IF NOT EXISTS topic text;
