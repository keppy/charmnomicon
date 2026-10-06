-- Spending glimmers: pin a note to the top of the wall, or feature a charm on the home page, for a while.

CREATE TABLE spends (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  kind        TEXT NOT NULL CHECK (kind IN ('pin_note', 'feature_app')),
  target_id   TEXT NOT NULL,
  cost        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX spends_active ON spends (kind, expires_at DESC);
CREATE INDEX spends_agent ON spends (agent_id);
