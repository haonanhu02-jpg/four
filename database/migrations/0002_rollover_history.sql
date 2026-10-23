ALTER TABLE monthly_goals ADD COLUMN rollover_count integer NOT NULL DEFAULT 0 CHECK (rollover_count>=0);
ALTER TABLE weekly_tasks ADD COLUMN rollover_count integer NOT NULL DEFAULT 0 CHECK (rollover_count>=0);
ALTER TABLE daily_tasks ADD COLUMN rollover_count integer NOT NULL DEFAULT 0 CHECK (rollover_count>=0);
ALTER TABLE period_snapshots ADD CONSTRAINT period_snapshots_owner_unique UNIQUE(id,user_id);
CREATE TABLE period_snapshot_items (
  snapshot_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  item_type text NOT NULL CHECK(item_type IN ('annual','monthly','weekly','daily')),
  item_id uuid NOT NULL,
  title text NOT NULL,
  completed boolean NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(snapshot_id,item_type,item_id),
  FOREIGN KEY(snapshot_id,user_id) REFERENCES period_snapshots(id,user_id) ON DELETE CASCADE
);
CREATE INDEX snapshot_items_page_idx ON period_snapshot_items(user_id,snapshot_id,item_type,completed,item_id);
CREATE INDEX snapshot_periods_owner_idx ON period_snapshots(user_id,created_at DESC,id);
CREATE TABLE rollover_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  checked_date date NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE year_carryovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  monthly_goal_id uuid NOT NULL,
  from_year integer NOT NULL,
  target_year integer NOT NULL,
  source_annual_id uuid,
  source jsonb NOT NULL,
  decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','keep','relink','superseded')),
  resolved_annual_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(user_id,monthly_goal_id,target_year),
  FOREIGN KEY(monthly_goal_id,user_id) REFERENCES monthly_goals(id,user_id)
);
CREATE INDEX carryovers_pending_idx ON year_carryovers(user_id,target_year,created_at,id) WHERE decision='pending';
