CREATE TABLE data_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL CHECK(mode IN ('append','replace')),
  document jsonb NOT NULL,
  revision text NOT NULL,
  restore_ids boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '15 minutes'),
  committed_at timestamptz
);
CREATE INDEX data_previews_owner_idx ON data_previews(user_id,created_at DESC,id);
CREATE TABLE data_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK(reason IN ('clear','replace','restore')),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_backups_owner_idx ON data_backups(user_id,created_at DESC,id);
