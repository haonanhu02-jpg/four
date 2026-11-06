-- Keep the manually entered value in progress. Auto mode is calculated at read
-- time so changing a child never destroys a parent's manual value or draft.
ALTER TABLE annual_goals
  ADD COLUMN progress_mode text NOT NULL DEFAULT 'manual' CHECK (progress_mode IN ('manual','auto')),
  ADD COLUMN due_date date;
ALTER TABLE daily_tasks
  ADD COLUMN note text NOT NULL DEFAULT '' CHECK (length(note) <= 10000),
  ADD COLUMN time_text text NOT NULL DEFAULT '' CHECK (length(time_text) <= 100);

CREATE FUNCTION annual_progress_value(owner_id uuid, goal_id uuid, mode text, manual_value numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN mode='auto' THEN coalesce((
    SELECT round(sum(progress*weight)/nullif(sum(weight),0))
    FROM monthly_goals
    WHERE user_id=owner_id AND annual_goal_id=goal_id
      AND deleted_at IS NULL AND archived_at IS NULL
  ),0) ELSE manual_value END
$$;
