CREATE TABLE deployment_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  cache_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO deployment_state DEFAULT VALUES;
