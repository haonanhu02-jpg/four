CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  password_hash text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register', 'login', 'reset')),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  UNIQUE (email, purpose)
);
CREATE INDEX auth_codes_expiry_idx ON auth_codes(expires_at);

CREATE TABLE auth_rate_limits (
  bucket text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE TABLE annual_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 10000),
  year integer NOT NULL CHECK (year BETWEEN 1970 AND 9999),
  progress numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  weight numeric(5,2) NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  archived_at timestamptz,
  UNIQUE (id, user_id)
);
CREATE INDEX annual_goals_period_idx ON annual_goals(user_id, year) WHERE deleted_at IS NULL;

CREATE TABLE monthly_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  annual_goal_id uuid,
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 10000),
  original_month date NOT NULL CHECK (extract(day FROM original_month) = 1),
  current_month date NOT NULL CHECK (extract(day FROM current_month) = 1),
  due_date date,
  progress numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  weight numeric(5,2) NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  archived_at timestamptz,
  UNIQUE (id, user_id),
  FOREIGN KEY (annual_goal_id, user_id) REFERENCES annual_goals(id, user_id)
);
CREATE INDEX monthly_goals_period_idx ON monthly_goals(user_id, current_month) WHERE deleted_at IS NULL;
CREATE INDEX monthly_goals_parent_idx ON monthly_goals(user_id, annual_goal_id);

CREATE TABLE weekly_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  monthly_goal_id uuid,
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 10000),
  original_start date NOT NULL,
  original_end date NOT NULL CHECK (original_end >= original_start),
  current_start date NOT NULL,
  current_end date NOT NULL CHECK (current_end >= current_start),
  priority text NOT NULL DEFAULT 'P1' CHECK (priority IN ('P0', 'P1', 'P2')),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'block', 'done')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  archived_at timestamptz,
  UNIQUE (id, user_id),
  FOREIGN KEY (monthly_goal_id, user_id) REFERENCES monthly_goals(id, user_id)
);
CREATE INDEX weekly_tasks_period_idx ON weekly_tasks(user_id, current_start, current_end) WHERE deleted_at IS NULL;
CREATE INDEX weekly_tasks_parent_idx ON weekly_tasks(user_id, monthly_goal_id);

CREATE TABLE daily_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  weekly_task_id uuid,
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  original_date date NOT NULL,
  scheduled_date date NOT NULL,
  minutes integer NOT NULL DEFAULT 30 CHECK (minutes BETWEEN 0 AND 1440),
  done boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  archived_at timestamptz,
  UNIQUE (id, user_id),
  FOREIGN KEY (weekly_task_id, user_id) REFERENCES weekly_tasks(id, user_id),
  CHECK (done = (completed_at IS NOT NULL))
);
CREATE INDEX daily_tasks_period_idx ON daily_tasks(user_id, scheduled_date) WHERE deleted_at IS NULL;
CREATE INDEX daily_tasks_parent_idx ON daily_tasks(user_id, weekly_task_id);

CREATE FUNCTION bump_work_item_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER annual_version BEFORE UPDATE ON annual_goals FOR EACH ROW EXECUTE FUNCTION bump_work_item_version();
CREATE TRIGGER monthly_version BEFORE UPDATE ON monthly_goals FOR EACH ROW EXECUTE FUNCTION bump_work_item_version();
CREATE TRIGGER weekly_version BEFORE UPDATE ON weekly_tasks FOR EACH ROW EXECUTE FUNCTION bump_work_item_version();
CREATE TRIGGER daily_version BEFORE UPDATE ON daily_tasks FOR EACH ROW EXECUTE FUNCTION bump_work_item_version();

CREATE TABLE schedule_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  item_type text NOT NULL CHECK (item_type IN ('annual', 'monthly', 'weekly', 'daily')),
  item_id uuid NOT NULL,
  from_version integer NOT NULL CHECK (from_version > 0),
  original_period jsonb NOT NULL,
  target_period text NOT NULL,
  new_period jsonb NOT NULL,
  reason text NOT NULL,
  snapshot jsonb NOT NULL,
  batch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, item_type, item_id, from_version, target_period)
);
CREATE INDEX schedule_history_item_idx ON schedule_history(user_id, item_type, item_id, created_at);

CREATE TABLE activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  item_type text NOT NULL CHECK (item_type IN ('annual', 'monthly', 'weekly', 'daily')),
  item_id uuid NOT NULL,
  action text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_logs_item_idx ON activity_logs(user_id, item_type, item_id, created_at);

CREATE TABLE period_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  period_type text NOT NULL CHECK (period_type IN ('year', 'month', 'week', 'day')),
  period_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, period_type, period_key)
);

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY(user_id, operation_id)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);
