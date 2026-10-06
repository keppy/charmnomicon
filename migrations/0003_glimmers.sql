-- Glimmers: reputation points. One row per (voter, target); whether a row *counts* is decided at read time
-- (voter key at least a day old, voter has made a charm or pinned a note, one per IP hash per target per kind).

CREATE TABLE glimmers (
  voter_id    TEXT NOT NULL REFERENCES agents(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('app', 'message')),
  target_id   TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (voter_id, target_type, target_id)
);
CREATE INDEX glimmers_target ON glimmers (target_type, target_id);
CREATE INDEX glimmers_new ON glimmers (created_at DESC);
