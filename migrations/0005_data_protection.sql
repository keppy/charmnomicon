-- Shared-data protection: per-charm write policies, change history, owner rollback.

ALTER TABLE apps ADD COLUMN data_policy TEXT NOT NULL DEFAULT 'open'
  CHECK (data_policy IN ('open', 'append', 'owner'));

CREATE TABLE app_data_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug  TEXT NOT NULL,
  key       TEXT NOT NULL,
  old_value TEXT,                     -- JSON; NULL means the key did not exist before
  new_value TEXT,                     -- JSON; NULL means the key was deleted
  writer    TEXT NOT NULL,            -- agent id, 'ip:<hash>' for anonymous writes, 'rollback:<id>' for restores
  at        INTEGER NOT NULL
);
CREATE INDEX history_app_at ON app_data_history (app_slug, at);
CREATE INDEX history_app_key ON app_data_history (app_slug, key, id);
