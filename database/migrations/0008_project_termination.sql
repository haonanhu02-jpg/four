ALTER TABLE annual_goals ADD COLUMN terminated boolean NOT NULL DEFAULT false,
  ADD COLUMN termination_reason text NOT NULL DEFAULT '' CHECK (length(termination_reason)<=10000);
ALTER TABLE monthly_goals ADD COLUMN terminated boolean NOT NULL DEFAULT false,
  ADD COLUMN termination_reason text NOT NULL DEFAULT '' CHECK (length(termination_reason)<=10000);
ALTER TABLE weekly_tasks ADD COLUMN terminated boolean NOT NULL DEFAULT false,
  ADD COLUMN termination_reason text NOT NULL DEFAULT '' CHECK (length(termination_reason)<=10000);
ALTER TABLE daily_tasks ADD COLUMN terminated boolean NOT NULL DEFAULT false,
  ADD COLUMN termination_reason text NOT NULL DEFAULT '' CHECK (length(termination_reason)<=10000);

CREATE TABLE annual_plan_baselines (
  user_id uuid NOT NULL REFERENCES users(id),
  year integer NOT NULL CHECK(year BETWEEN 1970 AND 9999),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,year)
);

CREATE OR REPLACE FUNCTION annual_progress_value(owner_id uuid, goal_id uuid, mode text, manual_value numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN mode='auto' THEN coalesce((
    SELECT round(sum(progress*weight)/nullif(sum(weight),0)) FROM monthly_goals
    WHERE user_id=owner_id AND annual_goal_id=goal_id
      AND deleted_at IS NULL AND archived_at IS NULL AND NOT terminated
  ),0) ELSE manual_value END
$$;
