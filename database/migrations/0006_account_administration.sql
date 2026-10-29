ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'));
ALTER TABLE users ADD COLUMN disabled_at timestamptz;
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
CREATE INDEX users_admin_roster_idx ON users(role) WHERE disabled_at IS NULL AND deleted_at IS NULL;
CREATE TABLE admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_username text NOT NULL,
  target_id uuid NOT NULL REFERENCES users(id),
  target_username text NOT NULL,
  action text NOT NULL CHECK(action IN ('bootstrap','create','update','reset_password','disable','enable','delete','restore')),
  before_state jsonb,
  after_state jsonb NOT NULL,
  request_id text NOT NULL,
  ip text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_logs_page_idx ON admin_audit_logs(created_at DESC,id);
CREATE INDEX admin_audit_logs_target_idx ON admin_audit_logs(target_id,created_at DESC);
CREATE FUNCTION protect_admin_audit_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Administration audit logs are append-only'; END;
$$;
CREATE TRIGGER admin_audit_logs_immutable BEFORE UPDATE OR DELETE ON admin_audit_logs
FOR EACH ROW EXECUTE FUNCTION protect_admin_audit_log();
