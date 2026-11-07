-- The phone edge's call bridges read and update their own call rows, nothing else (deploy/phone-edge/install.sh).
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kenan_phone_edge') THEN CREATE ROLE kenan_phone_edge LOGIN; END IF;
END $$;
GRANT CONNECT ON DATABASE :"dbname" TO kenan_phone_edge;
GRANT USAGE ON SCHEMA public TO kenan_phone_edge;
GRANT SELECT, UPDATE ON public.kenan_phone_call TO kenan_phone_edge;
