-- Read-only database access for household operators (machine/user-access.md), applied to each channel's database by
-- deploy/operator/apply-db.sh (after every deploy and from deploy/operator/install.sh). It passes psql variables
-- `operators`, the members of the host group kenan-operators each paired with their person id from the channel config
-- (`unixuser=person,...`; Alice's account is `kenan=alice`), and `operator_role`, the group role (kenan_operator); roles
-- that left the group lose it. Operators log in as their own Unix user (peer auth) and see the schema `operator`:
-- views over every public table showing operational tables whole and private tables (conversations, messages, goals,
-- files, calls, wakes...) only for rows that belong to the operator's person, looked up in operator.identity.
-- A table listed in neither map gets no view, so a new table stays invisible until it is classified here.
-- Their search path in this database is "$user", operator: plain names reach the views, except that an operator holding
-- privileges on public tables (a service identity) reaches those through its own schema (below).
\set ON_ERROR_STOP on
SET client_min_messages = warning;
-- A changed view must never queue an exclusive lock behind a long database dump and stall live reads.
SET lock_timeout = '1s';
-- Parse the desired SELECT into a temporary view, then compare PostgreSQL's normalized definition and options.
-- This takes only read locks on source tables; unchanged permanent views and their grants are left untouched.
CREATE FUNCTION pg_temp.operator_view(schema_name text, view_name text, definition text, options text[], target_role text, privileges text[])
RETURNS void LANGUAGE plpgsql AS $view$
DECLARE
  target text := format('%I.%I', schema_name, view_name);
  current_oid oid := to_regclass(target);
  desired text;
  privilege text;
BEGIN
  EXECUTE format('CREATE TEMP VIEW __kenan_operator_candidate %s AS %s',
    CASE WHEN cardinality(options) > 0 THEN 'WITH (' || array_to_string(options, ', ') || ')' ELSE '' END, definition);
  desired := pg_get_viewdef('pg_temp.__kenan_operator_candidate'::regclass, true);
  IF current_oid IS NULL OR pg_get_viewdef(current_oid, true) IS DISTINCT FROM desired
      OR (SELECT coalesce(array_agg(o ORDER BY o), array[]::text[]) FROM pg_class c, unnest(c.reloptions) o WHERE c.oid = current_oid)
        IS DISTINCT FROM (SELECT coalesce(array_agg(o ORDER BY o), array[]::text[]) FROM unnest(options) o) THEN
    BEGIN
      EXECUTE format('CREATE OR REPLACE VIEW %s AS %s', target, desired);
    EXCEPTION WHEN invalid_table_definition THEN
      -- PostgreSQL cannot replace a view that lost or renamed columns. Only that changed view needs dropping.
      EXECUTE format('DROP VIEW %s', target);
      EXECUTE format('CREATE VIEW %s AS %s', target, desired);
    END;
    EXECUTE format('ALTER VIEW %s RESET (security_barrier, security_invoker)', target);
    IF cardinality(options) > 0 THEN
      EXECUTE format('ALTER VIEW %s SET (%s)', target, array_to_string(options, ', '));
    END IF;
    current_oid := to_regclass(target);
  END IF;
  DROP VIEW pg_temp.__kenan_operator_candidate;
  FOREACH privilege IN ARRAY array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF privilege = ANY (privileges) THEN
      IF NOT has_table_privilege(target_role, current_oid, privilege) THEN
        EXECUTE format('GRANT %s ON %s TO %I', privilege, target, target_role);
      END IF;
    ELSIF EXISTS (SELECT FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
        WHERE c.oid = current_oid AND r.rolname = target_role AND a.privilege_type = privilege) THEN
      EXECUTE format('REVOKE %s ON %s FROM %I', privilege, target, target_role);
    END IF;
  END LOOP;
END $view$;
SET kenan.operators = :'operators';
SET kenan.operator_role = :'operator_role';
DO $$
DECLARE
  pairs text[] := coalesce(string_to_array(nullif(current_setting('kenan.operators'), ''), ','), array[]::text[]);
  group_role text := current_setting('kenan.operator_role');
  operators text[] := array[]::text[];
  persons text[] := array[]::text[];
  pair text;
  everyone text[] := array['changelog_line', 'error_log', 'model_call', 'person', 'schema_applied', 'schema_migration', 'usage_sample'];
  withheld text[] := array['session', 'sealed_guess'];  -- login tokens and unrevealed predictions
  me text := '(select person_id from operator.identity where role_name = current_user)';
  own_conversations text := '(select id from public.conversation where owner_id = ' || me || ' union select conversation_id from public.member where person_id = ' || me || ')';
  own_agents text := '(select id from public.agent where owner_id = ' || me || ')';
  private jsonb := jsonb_build_object(
    'agent', 'owner_id = ' || me,
    'agent_heartbeat', 'agent_id in ' || own_agents,
    'agent_input_delivery_key', 'owner_id = ' || me,
    'agent_pending_input', 'agent_id in ' || own_agents,
    'buy_item', 'owner_id = ' || me,
    'buy_section', 'owner_id = ' || me,
    'changelog_seen', 'person_id = ' || me,
    'chat_group', 'owner_id = ' || me,
    'conversation', 'id in ' || own_conversations,
    'conversation_file', 'conversation_id in ' || own_conversations,
    'file', 'owner_id = ' || me,
    'goal', 'owner_id = ' || me,
    'host_event', 'owner_id = ' || me,
    'kenan_ask', 'owner_id = ' || me,
    'kenan_ask_position', 'owner_id = ' || me,
    'kenan_ask_unreadable', 'owner_id = ' || me,
    'kenan_calendar', 'owner_id = ' || me,
    'kenan_calendar_reminder', 'owner_id = ' || me,
    'kenan_meeting_coverage_notice', 'owner_id = ' || me,
    'kenan_meeting_join_request', 'owner_id = ' || me,
    'kenan_meeting_observer_health', 'owner_id = ' || me,
    'kenan_meeting_provider', 'owner_id = ' || me,
    'kenan_meeting_sessions', 'owner_id = ' || me,
    'kenan_meeting_slack_since', 'owner_id = ' || me,
    'kenan_meeting_voice', 'owner_id = ' || me,
    'kenan_meeting_voice_transcript', 'owner_id = ' || me,
    'kenan_meeting_voice_usage', 'owner_id = ' || me,
    'kenan_phone_call', 'owner_id = ' || me,
    'latency', 'conversation_id in ' || own_conversations,
    'member', 'person_id = ' || me,
    'message', 'conversation_id in ' || own_conversations,
    'morning_check', 'owner_id = ' || me,
    'notification', 'person_id = ' || me,
    'peer_message', 'owner_id = ' || me,
    'phone_location', 'person_id = ' || me,
    'push_subscription', 'person_id = ' || me,
    'remote_member', 'person_id = ' || me,
    'ResearchCo_post_proposal', 'todo_id in (select id from public.todo where owner_id = ' || me || ')',
    'todo', 'owner_id = ' || me,
    'transcript_redaction', 'conversation_id in ' || own_conversations || ' or author_id in ' || own_agents,
    'wake', 'owner_id = ' || me);
  path_setting text := 'search_path="$user", operator';
  own_marker text := 'kenan operator: pass-through views of the public tables this operator holds privileges on (deploy/operator/operator-db.sql)';
  name text;
  wanted text[];
  t record;
BEGIN
  IF group_role !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'operator_role_invalid: %', group_role;
  END IF;
  FOREACH pair IN ARRAY pairs LOOP
    IF pair !~ '^[a-z_][a-z0-9_-]*=[a-z0-9_-]+$' THEN
      RAISE EXCEPTION 'operator_mapping_invalid: % (expected unixuser=person)', pair;
    END IF;
    operators := operators || split_part(pair, '=', 1);
    persons := persons || split_part(pair, '=', 2);
  END LOOP;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = group_role) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', group_role); END IF;
  FOREACH name IN ARRAY operators LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN EXECUTE format('CREATE ROLE %I LOGIN', name); END IF;
    IF NOT pg_has_role(name, group_role, 'MEMBER') THEN EXECUTE format('GRANT %I TO %I', group_role, name); END IF;
    -- Roles are shared by every database in the cluster (the kenan role also runs the test suites in kenan_test), so
    -- the search path is set for this database only, and only on change so parallel deploys don't collide.
    IF NOT EXISTS (SELECT FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole JOIN pg_database d ON d.oid = s.setdatabase
        WHERE r.rolname = name AND d.datname = current_database() AND path_setting = ANY (s.setconfig)) THEN
      EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path = "$user", operator', name, current_database());
    END IF;
    IF EXISTS (SELECT FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
        WHERE r.rolname = name AND s.setdatabase = 0 AND 'search_path=operator' = ANY (s.setconfig)) THEN
      EXECUTE format('ALTER ROLE %I RESET search_path', name);
    END IF;
  END LOOP;
  FOR name IN SELECT m.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE r.rolname = group_role AND NOT m.rolname = ANY (operators) LOOP
    EXECUTE format('REVOKE %I FROM %I', group_role, name);
    EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET search_path', name, current_database());
    IF EXISTS (SELECT FROM pg_namespace WHERE nspname = name AND obj_description(oid, 'pg_namespace') = own_marker) THEN
      EXECUTE format('DROP SCHEMA %I CASCADE', name);
    END IF;
  END LOOP;
  -- An operator that also holds privileges on public tables is a service identity too: kenan runs the calendar link,
  -- queue observer and contention-watch, which name those tables unqualified. Its own schema ("$user",
  -- first on the path) holds a pass-through view of each, checked with the operator's own privileges, so its services
  -- keep reaching the tables while every other bare name reaches the operator views.
  FOREACH name IN ARRAY operators LOOP
    IF EXISTS (SELECT FROM pg_namespace WHERE nspname = name AND obj_description(oid, 'pg_namespace') IS DISTINCT FROM own_marker) THEN
      IF EXISTS (SELECT FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v')
          AND has_table_privilege(name, oid, 'SELECT,INSERT,UPDATE,DELETE')) THEN
        RAISE EXCEPTION 'operator_schema_taken: schema % exists and is not operator-db.sql''s, so its public tables can''t be put on its path', name;
      END IF;
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v')
      AND has_table_privilege(name, oid, 'SELECT,INSERT,UPDATE,DELETE')) THEN
      IF EXISTS (SELECT FROM pg_namespace WHERE nspname = name) THEN EXECUTE format('DROP SCHEMA %I CASCADE', name); END IF;
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = name) THEN
      EXECUTE format('CREATE SCHEMA %I', name);
      EXECUTE format('COMMENT ON SCHEMA %I IS %L', name, own_marker);
    END IF;
    IF NOT has_schema_privilege(name, name, 'USAGE') THEN EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', name, name); END IF;
    wanted := array[]::text[];
    FOR t IN SELECT c.relname, array_agg(p) AS privileges FROM pg_class c, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v') AND has_table_privilege(name, c.oid, p)
        GROUP BY c.relname ORDER BY c.relname LOOP
      PERFORM pg_temp.operator_view(name, t.relname, format('SELECT * FROM public.%I', t.relname), array['security_invoker=true'], name, t.privileges);
      wanted := wanted || t.relname;
    END LOOP;
    FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = name AND c.relkind = 'v' AND NOT c.relname = ANY (wanted) LOOP
      EXECUTE format('DROP VIEW %I.%I', name, t.relname);
    END LOOP;
  END LOOP;
  IF NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'operator') THEN CREATE SCHEMA operator; END IF;
  IF NOT has_schema_privilege(group_role, 'operator', 'USAGE') THEN EXECUTE format('GRANT USAGE ON SCHEMA operator TO %I', group_role); END IF;
  IF to_regclass('operator.identity') IS NULL THEN CREATE TABLE operator.identity (role_name name PRIMARY KEY, person_id text NOT NULL); END IF;
  DELETE FROM operator.identity WHERE NOT role_name = ANY (operators);
  INSERT INTO operator.identity SELECT * FROM unnest(operators::name[], persons)
    ON CONFLICT (role_name) DO UPDATE SET person_id = excluded.person_id WHERE identity.person_id IS DISTINCT FROM excluded.person_id;
  IF NOT has_table_privilege(group_role, 'operator.identity', 'SELECT') THEN EXECUTE format('GRANT SELECT ON operator.identity TO %I', group_role); END IF;
  wanted := array[]::text[];
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
    IF t.tablename = ANY (everyone) THEN
      PERFORM pg_temp.operator_view('operator', t.tablename, format('SELECT * FROM public.%I', t.tablename), array[]::text[], group_role, array['SELECT']);
    ELSIF private ? t.tablename THEN
      PERFORM pg_temp.operator_view('operator', t.tablename, format('SELECT * FROM public.%I WHERE %s', t.tablename, private ->> t.tablename), array['security_barrier=true'], group_role, array['SELECT']);
    ELSIF t.tablename = ANY (withheld) THEN
      CONTINUE;
    ELSE
      RAISE WARNING 'operator: public.% is unclassified, so operators cannot read it; add it to deploy/operator/operator-db.sql', t.tablename;
      CONTINUE;
    END IF;
    wanted := wanted || t.tablename;
  END LOOP;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'operator' AND c.relkind = 'v' AND NOT c.relname = ANY (wanted) LOOP
    EXECUTE format('DROP VIEW operator.%I', t.relname);
  END LOOP;

END $$;
