-- Derive progress at read time: no parent writes, version changes or offline conflicts.
CREATE FUNCTION weekly_progress_value(owner_id uuid, task_id uuid, manual_value numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT round(100.0*count(*) FILTER (WHERE done)/nullif(count(*),0))
    FROM daily_tasks WHERE user_id=owner_id AND weekly_task_id=task_id
      AND deleted_at IS NULL AND archived_at IS NULL AND NOT terminated),manual_value)
$$;
CREATE FUNCTION monthly_progress_value(owner_id uuid, goal_id uuid, manual_value numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT round(avg(weekly_progress_value(user_id,id,
    coalesce(progress,CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 50 WHEN 'block' THEN 15 ELSE 100 END))))
    FROM weekly_tasks WHERE user_id=owner_id AND monthly_goal_id=goal_id
      AND deleted_at IS NULL AND archived_at IS NULL AND NOT terminated),manual_value)
$$;
CREATE OR REPLACE FUNCTION annual_progress_value(owner_id uuid, goal_id uuid, mode text, manual_value numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN mode='auto' THEN coalesce((
    SELECT round(sum(monthly_progress_value(user_id,id,progress)*weight)/nullif(sum(weight),0))
    FROM monthly_goals WHERE user_id=owner_id AND annual_goal_id=goal_id
      AND deleted_at IS NULL AND archived_at IS NULL AND NOT terminated),0) ELSE manual_value END
$$;
CREATE VIEW weekly_progress_read AS
  SELECT (jsonb_populate_record(NULL::weekly_tasks,to_jsonb(w)||jsonb_build_object(
    'progress',v.progress,'status',CASE WHEN v.progress=100 THEN 'done'
      WHEN v.progress=0 THEN 'todo' ELSE 'doing' END))).*
  FROM weekly_tasks w CROSS JOIN LATERAL (SELECT weekly_progress_value(w.user_id,w.id,
    coalesce(w.progress,CASE w.status WHEN 'todo' THEN 0 WHEN 'doing' THEN 50 WHEN 'block' THEN 15 ELSE 100 END)) AS progress) v;
CREATE VIEW monthly_progress_read AS
  SELECT (jsonb_populate_record(NULL::monthly_goals,to_jsonb(m)||jsonb_build_object(
    'progress',monthly_progress_value(m.user_id,m.id,m.progress)))).* FROM monthly_goals m;
