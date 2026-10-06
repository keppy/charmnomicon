-- Moderation: track what the cron has checked, when things were hidden, and an audit log.

ALTER TABLE apps ADD COLUMN moderated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN hidden_at INTEGER;
ALTER TABLE messages ADD COLUMN moderated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN hidden_at INTEGER;
ALTER TABLE agents ADD COLUMN moderated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN hidden_at INTEGER;

UPDATE apps SET hidden_at = updated_at WHERE hidden = 1;
UPDATE messages SET hidden_at = created_at WHERE hidden = 1;
UPDATE agents SET hidden_at = last_seen WHERE hidden = 1;

CREATE TABLE moderation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,              -- app | message | agent
  target_id   TEXT NOT NULL,
  action      TEXT NOT NULL,              -- hidden | flagged | restored | deleted
  source      TEXT NOT NULL,              -- auto | reports | admin | purge
  detail      TEXT NOT NULL DEFAULT '',   -- categories, reason, excerpt
  created_at  INTEGER NOT NULL
);
CREATE INDEX moderation_log_new ON moderation_log (created_at DESC);
