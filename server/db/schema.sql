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
  layout      text NOT NULL DEFAULT 'classic' CHECK (layout IN ('classic', 'organized'))
);

CREATE TABLE IF NOT EXISTS agent (
  id              text PRIMARY KEY REFERENCES person(id),
  owner_id        text NOT NULL REFERENCES person(id),
  role            text NOT NULL CHECK (role IN ('manager','worker')),
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
CREATE INDEX IF NOT EXISTS agent_owner ON agent(owner_id);
CREATE INDEX IF NOT EXISTS agent_parent ON agent(parent_agent_id);

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
    AND notice IN ('worker_note', 'worker_report', 'peer_message', 'wake', 'heartbeat', 'system', 'report', 'agent_error', 'meeting_caption', 'imported'))
);
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

-- Restart continuity: inputs queued but not started at shutdown, delivered once on the next start.
CREATE TABLE IF NOT EXISTS agent_pending_input (
  id          bigserial PRIMARY KEY,
  agent_id    text NOT NULL REFERENCES agent(id),
  input       jsonb NOT NULL,
  created_at  bigint NOT NULL
);

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
    WHEN 'own' THEN status <> 'pending' AND listen_since IS NULL AND clock_reason IS NULL
    ELSE false END),
  CONSTRAINT wake_signal_chat CHECK (CASE WHEN event->>'source' = 'signal' THEN coalesce(
    event->'chat'->>'kind' IN ('direct', 'any') OR (event->'chat'->>'kind' = 'group' AND event->'chat'->>'group' <> ''), false) ELSE true END),
  CONSTRAINT wake_event_topic CHECK (CASE WHEN event->>'source' = 'event' THEN coalesce(
    event->>'topic' ~ '^[A-Za-z0-9._:@/-]{1,200}$' AND jsonb_typeof(event->'prefix') = 'boolean', false) ELSE true END),
  CONSTRAINT wake_held CHECK ((goal_id IS NULL) = (handoff IS NULL) AND (held_for IS NULL OR goal_id IS NOT NULL) AND (handoff IS NULL OR btrim(handoff) <> ''))
);
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
CREATE TABLE IF NOT EXISTS peer_message (
  id          uuid PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES person(id),
  peer_id     text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('out','in')),
  from_agent  text NOT NULL,
  text        text NOT NULL,
  created_at  bigint NOT NULL,
  relayed_at  bigint,
  to_agent    text CONSTRAINT peer_message_to_agent CHECK (to_agent IS NULL OR length(to_agent) BETWEEN 1 AND 200),
  CHECK (direction = 'out' OR relayed_at IS NULL)
);
CREATE INDEX IF NOT EXISTS peer_message_outbox ON peer_message(owner_id, peer_id, created_at) WHERE direction = 'out' AND relayed_at IS NULL;
CREATE INDEX IF NOT EXISTS peer_message_history ON peer_message(owner_id, peer_id, created_at);

-- To-do list per person (server/extensions/todos.ts). Deleting sets deleted_at, so Undo restores it.
CREATE TABLE IF NOT EXISTS todo (
  id              uuid PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES person(id),
  text            text NOT NULL CHECK (btrim(text) <> ''),
  level           text NOT NULL CHECK (level IN ('today', 'week', 'someday')),
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

INSERT INTO schema_migration(id) VALUES ('baseline-2026-10-21') ON CONFLICT DO NOTHING;
