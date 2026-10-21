-- Read-only database access for household operators (machine/user-access.md), applied to each channel's database by
-- deploy/operator/apply-db.sh (after every deploy and from deploy/operator/install.sh), which passes the members of the
-- host group kenan-operators as psql variable `operators` (comma-separated); roles that left the group lose the grant. Operators log in as their own Unix user (peer
-- auth) and see the schema `operator`: views over every public table showing operational tables whole and private
-- tables (conversations, messages, goals, files, calls, wakes...) only for rows that belong to the operator.
-- A table listed in neither map gets no view, so a new table stays invisible until it is classified here.
\set ON_ERROR_STOP on
SET client_min_messages = warning;
SET kenan.operators = :'operators';
DO $$
DECLARE
  operators text[] := coalesce(string_to_array(nullif(current_setting('kenan.operators'), ''), ','), array[]::text[]);
  everyone text[] := array['error_log', 'model_call', 'person', 'schema_migration', 'usage_sample'];
  withheld text[] := array['session'];  -- login tokens
  own_conversations text := '(select id from public.conversation where owner_id = current_user union select conversation_id from public.member where person_id = current_user)';
  own_agents text := '(select id from public.agent where owner_id = current_user)';
  private jsonb := jsonb_build_object(
    'agent', 'owner_id = current_user',
    'agent_heartbeat', 'agent_id in ' || own_agents,
    'agent_pending_input', 'agent_id in ' || own_agents,
    'conversation', 'id in ' || own_conversations,
    'conversation_file', 'conversation_id in ' || own_conversations,
    'file', 'owner_id = current_user',
    'goal', 'owner_id = current_user',
    'host_event', 'owner_id = current_user',
    'kenan_calendar', 'owner_id = current_user',
    'kenan_meeting_observer_health', 'owner_id = current_user',
    'kenan_meeting_provider', 'owner_id = current_user',
    'kenan_meeting_sessions', 'owner_id = current_user',
    'kenan_phone_call', 'owner_id = current_user',
    'latency', 'conversation_id in ' || own_conversations,
    'member', 'person_id = current_user',
    'message', 'conversation_id in ' || own_conversations,
    'notification', 'person_id = current_user',
    'peer_message', 'owner_id = current_user',
    'push_subscription', 'person_id = current_user',
    'todo', 'owner_id = current_user',
    'wake', 'owner_id = current_user');
  name text;
  t record;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kenan_operator') THEN CREATE ROLE kenan_operator NOLOGIN; END IF;
  FOREACH name IN ARRAY operators LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN EXECUTE format('CREATE ROLE %I LOGIN', name); END IF;
    IF NOT pg_has_role(name, 'kenan_operator', 'MEMBER') THEN EXECUTE format('GRANT kenan_operator TO %I', name); END IF;
    -- Roles are shared by both channels' databases; writing only on change keeps parallel deploys from colliding.
    IF NOT EXISTS (SELECT FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
        WHERE r.rolname = name AND s.setdatabase = 0 AND 'search_path=operator' = ANY (s.setconfig)) THEN
      EXECUTE format('ALTER ROLE %I SET search_path = operator', name);
    END IF;
  END LOOP;
  FOR name IN SELECT m.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE r.rolname = 'kenan_operator' AND NOT m.rolname = ANY (operators) LOOP
    EXECUTE format('REVOKE kenan_operator FROM %I', name);
  END LOOP;
  DROP SCHEMA IF EXISTS operator CASCADE;
  CREATE SCHEMA operator;
  GRANT USAGE ON SCHEMA operator TO kenan_operator;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
    IF t.tablename = ANY (everyone) THEN
      EXECUTE format('CREATE VIEW operator.%I AS SELECT * FROM public.%I', t.tablename, t.tablename);
    ELSIF private ? t.tablename THEN
      EXECUTE format('CREATE VIEW operator.%I WITH (security_barrier) AS SELECT * FROM public.%I WHERE %s', t.tablename, t.tablename, private ->> t.tablename);
    ELSIF t.tablename = ANY (withheld) THEN
      CONTINUE;
    ELSE
      RAISE WARNING 'operator: public.% is unclassified, so operators cannot read it; add it to deploy/operator/operator-db.sql', t.tablename;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT SELECT ON operator.%I TO kenan_operator', t.tablename);
  END LOOP;
END $$;
