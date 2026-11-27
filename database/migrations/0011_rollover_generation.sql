-- One generated child per parent and natural period, retained after deletion.
CREATE TABLE rollover_generation (
  user_id uuid NOT NULL REFERENCES users(id),
  parent_type text NOT NULL CHECK(parent_type IN ('annual','monthly')),
  parent_id uuid NOT NULL,
  period date NOT NULL,
  item_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,parent_type,parent_id,period)
);
