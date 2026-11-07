-- Rows for schema-catalog-proof.sh: at least one row in every table of the 2026-10-21 baseline shape, so the proof can
-- show an upgrade, a rollback start and a forward start again keep every existing row byte for byte. Only columns that
-- existed at the baseline are named; a base commit that dropped one of them makes the seed fail loudly (seed_failed).
INSERT INTO person (id, name, kind, created_at, layout) VALUES
  ('proof-human', 'Proof Human', 'human', 1792600000000, 'organized'),
  ('proof-manager', 'Proof Manager', 'agent', 1792600000001, 'classic'),
  ('proof-worker', 'Proof Worker', 'agent', 1792600000002, 'classic');

INSERT INTO conversation (id, title, owner_id, agent_id, archived, color, last_seq, created_at, updated_at, emoji, pinned_at,
    key_date, key_label, title_locked, project, status_line, project_id) VALUES
  ('00000000-0000-4000-8000-000000000101', 'Project room', 'proof-human', 'proof-manager', false, '#336699', 2, 1792600000010,
    1792600000011, '📁', 1792600000012, '2026-10-22', 'Due', true, true, 'running', NULL),
  ('00000000-0000-4000-8000-000000000102', 'Chat in project', 'proof-human', 'proof-manager', false, NULL, 1, 1792600000013,
    1792600000014, NULL, NULL, NULL, NULL, false, false, NULL, '00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000103', 'Worker room', 'proof-human', 'proof-worker', true, NULL, 0, 1792600000015,
    1792600000016, NULL, NULL, NULL, NULL, false, false, NULL, NULL);

INSERT INTO goal (id, owner_id, title, detail, status, priority, notes, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000201', 'proof-human', 'Proof goal', 'detail', 'open', 1, 'note', 1792600000020, 1792600000021);

INSERT INTO agent (id, owner_id, role, conversation_id, goal_id, state, model, session_path, last_report, created_at, updated_at,
    parent_agent_id, archived, thinking) VALUES
  ('proof-manager', 'proof-human', 'manager', '00000000-0000-4000-8000-000000000101', NULL, 'idle', 'claude-opus-5-5',
    '/sessions/manager.jsonl', NULL, 1792600000030, 1792600000031, NULL, false, 'high'),
  ('proof-worker', 'proof-human', 'worker', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000201',
    'running', 'claude-haiku-5-5', '/sessions/worker.jsonl', '{"status":"done","text":"ok"}', 1792600000032, 1792600000033,
    'proof-manager', false, NULL);

INSERT INTO chat_group (id, owner_id, name, emoji, family, position, created_at) VALUES
  ('00000000-0000-4000-8000-000000000301', 'proof-human', 'Work', '💼', 'teal', 1.5, 1792600000040);

INSERT INTO member (conversation_id, person_id, read_through, group_id) VALUES
  ('00000000-0000-4000-8000-000000000101', 'proof-human', 2, '00000000-0000-4000-8000-000000000301'),
  ('00000000-0000-4000-8000-000000000101', 'proof-manager', 0, NULL),
  ('00000000-0000-4000-8000-000000000102', 'proof-human', 1, NULL);

INSERT INTO message (id, conversation_id, seq, author_id, role, text, parts, state, client_id, created_at, updated_at, notice, display) VALUES
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000101', 1, 'proof-human', 'human', 'hello',
    '[{"type":"text","text":"hello"}]', 'done', 'client-1', 1792600000050, 1792600000050, NULL, 'shown'),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000101', 2, 'proof-worker', 'notice', 'report',
    '[]', 'done', NULL, 1792600000051, 1792600000052, 'worker_report', 'background');

INSERT INTO file (id, owner_id, name, mime, size, path, created_at) VALUES
  ('00000000-0000-4000-8000-000000000501', 'proof-human', 'a.png', 'image/png', 42, '/files/a.png', 1792600000060);

INSERT INTO conversation_file (file_id, conversation_id) VALUES
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000101');

INSERT INTO latency (message_id, conversation_id, client_sent_at, received_at, admitted_at, model_request_at, first_token_at, first_text_at) VALUES
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000101', 1792600000049, 1792600000050, 1792600000051,
    1792600000052, 1792600000053, 1792600000054);

INSERT INTO model_call (agent_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, at) VALUES
  ('proof-worker', 'claude-haiku-5-5', 100, 20, 5, 1, 0.0123, 1792600000070);

INSERT INTO usage_sample (source, provider, metric, account, percent_left, reset_at, window_hours, reading_at, at) VALUES
  ('broker:1', 'anthropic', 'weekly', 'acct-1', 77.5, 1792700000000, 168, 1792600000080, 1792600000081);

INSERT INTO session (id, person_id, expires_at, created_at) VALUES ('proof-session', 'proof-human', 1792700000000, 1792600000090);

INSERT INTO error_log (scope, message, at) VALUES ('agent:proof-worker', 'model_stream_failed', 1792600000100);

INSERT INTO agent_pending_input (agent_id, input, created_at) VALUES ('proof-worker', '{"kind":"note","text":"hi"}', 1792600000110);

INSERT INTO agent_heartbeat (agent_id, at, error_id, goals, workers, checked_at, alerts, checklist) VALUES
  ('proof-manager', 1792600000120, 1, '[]', '[]', 1792600000121, '{}', 'checklist');

INSERT INTO notification (person_id, agent_id, conversation_id, title, body, level, created_at, image_file_id) VALUES
  ('proof-human', 'proof-manager', '00000000-0000-4000-8000-000000000101', 'Title', 'Body', 'urgent', 1792600000130,
    '00000000-0000-4000-8000-000000000501');

INSERT INTO push_subscription (endpoint, person_id, p256dh, auth, created_at) VALUES
  ('https://push.example/1', 'proof-human', 'p256dh', 'auth', 1792600000140);

INSERT INTO wake (id, agent_id, owner_id, message, at, event, status, reason, detail, created_at, settled_at, listen, listen_since,
    clock_reason, goal_id, held_for, handoff) VALUES
  ('00000000-0000-4000-8000-000000000601', 'proof-worker', 'proof-human', 'event wait', 1792600009000,
    '{"source":"event","topic":"acme:proof","prefix":false}', 'pending', NULL, NULL, 1792600000150, NULL, 'addressed',
    1792600000150, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000602', 'proof-manager', 'proof-human', 'clock', 1792600009001, NULL, 'fired', 'time',
    'fired at time', 1792600000151, 1792600009001, 'clock', NULL, 'reminder', NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000603', 'proof-manager', 'proof-human', 'held', 1792600009002, NULL, 'pending', NULL, NULL,
    1792600000152, NULL, 'addressed', 1792600000152, NULL, '00000000-0000-4000-8000-000000000201', 'proof-worker', 'handoff text');

INSERT INTO host_event (owner_id, id, topic, body, arrived_at, consumed_at) VALUES
  ('proof-human', 'evt-1', 'acme:proof', '{"ok":true}', 1792600000160, NULL);

INSERT INTO peer_message (id, owner_id, peer_id, direction, from_agent, text, created_at, relayed_at, to_agent) VALUES
  ('00000000-0000-4000-8000-000000000701', 'proof-human', 'acme', 'out', 'proof-worker', 'hello peer', 1792600000170,
    1792600000171, 'c73'),
  ('00000000-0000-4000-8000-000000000702', 'proof-human', 'acme', 'in', 'c73', 'reply', 1792600000172, NULL, NULL);

INSERT INTO todo (id, owner_id, text, level, tag, due_at, remind, position, conversation_id, done_at, deleted_at, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000801', 'proof-human', 'Do the thing', 'today', 'work', 1792700000000, true, 1,
    '00000000-0000-4000-8000-000000000102', NULL, NULL, 1792600000180, 1792600000181),
  ('00000000-0000-4000-8000-000000000802', 'proof-human', 'Done thing', 'someday', NULL, NULL, false, 2, NULL, 1792600000182,
    NULL, 1792600000180, 1792600000182);

-- transcript_redaction exists from ff970ba0; older bases don't have it.
DO $$ BEGIN
  IF to_regclass('transcript_redaction') IS NOT NULL THEN
    INSERT INTO transcript_redaction (id, target, message_id, conversation_id, seq, author_id, path, classes, before_sha256, after_sha256, requested_by, reason, at) VALUES
      ('00000000-0000-4000-8000-000000000901', 'message', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000101', 1,
        'proof-worker', NULL, '{"api_key":1}', repeat('a', 64), repeat('b', 64), 'proof', 'fixture', 1792600000190),
      ('00000000-0000-4000-8000-000000000902', 'session_file', NULL, NULL, NULL, NULL, '/var/lib/kenan/proof/sessions/a.jsonl',
        '{"jwt":1}', repeat('c', 64), repeat('d', 64), 'proof', 'fixture', 1792600000191);
  END IF;
END $$;

INSERT INTO morning_check (owner_id, enabled, at_minute, last_day, sent_at) VALUES ('proof-human', true, 510, '2026-10-21', 1792600000190);

-- Tables newer than some bases this seed is applied to: filled only where they exist.
DO $$ BEGIN
  IF to_regclass('buy_section') IS NOT NULL THEN
    EXECUTE $q$INSERT INTO buy_section (id, owner_id, name, emoji, color, position, created_at) VALUES
      ('00000000-0000-4000-8000-000000000901', 'proof-human', 'Groceries', '🥕', '#9bc53d', 1, 1792600000200)$q$;
    EXECUTE $q$INSERT INTO buy_item (id, owner_id, section_id, text, position, bought_at, created_at, updated_at) VALUES
      ('00000000-0000-4000-8000-000000000902', 'proof-human', '00000000-0000-4000-8000-000000000901', 'Milk', 1, NULL, 1792600000201, 1792600000201),
      ('00000000-0000-4000-8000-000000000903', 'proof-human', '00000000-0000-4000-8000-000000000901', 'Eggs', 2, 1792600000203, 1792600000202, 1792600000203)$q$;
  END IF;
END $$;
