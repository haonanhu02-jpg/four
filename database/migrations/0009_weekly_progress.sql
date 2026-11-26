-- Nullable legacy rows keep their version and pending offline edits. Readers
-- derive their progress from the existing status until the next normal write.
ALTER TABLE weekly_tasks ADD COLUMN progress numeric(5,2)
  CHECK (progress BETWEEN 0 AND 100);

CREATE FUNCTION sync_weekly_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.progress IS DISTINCT FROM OLD.progress AND NEW.progress IS NOT NULL THEN
      NEW.status := CASE
        WHEN NEW.progress=100 THEN 'done'
        WHEN NEW.progress=0 THEN 'todo'
        WHEN NEW.status='block' THEN 'block'
        ELSE 'doing' END;
    ELSIF NEW.status IS DISTINCT FROM OLD.status
      AND (NEW.progress IS NULL OR NEW.status IS DISTINCT FROM
        CASE WHEN NEW.progress=100 THEN 'done'
             WHEN NEW.progress=0 THEN 'todo' ELSE 'doing' END) THEN
      NEW.progress := CASE NEW.status WHEN 'todo' THEN 0
        WHEN 'doing' THEN 50 WHEN 'block' THEN 15 ELSE 100 END;
    END IF;
  END IF;
  IF NEW.progress IS NULL THEN
    NEW.progress := CASE NEW.status WHEN 'todo' THEN 0
      WHEN 'doing' THEN 50 WHEN 'block' THEN 15 ELSE 100 END;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.status := CASE WHEN NEW.progress=100 THEN 'done'
      WHEN NEW.progress=0 THEN 'todo'
      WHEN NEW.status='block' THEN 'block' ELSE 'doing' END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER weekly_progress BEFORE INSERT OR UPDATE ON weekly_tasks
  FOR EACH ROW EXECUTE FUNCTION sync_weekly_progress();
