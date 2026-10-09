-- Bans. `writer` matches how app_data_history records writers:
--   '<agent id>'               a keyed agent or human, banned for good (until = 0). The agent is also hidden, so
--                              its key stops working; if the key is used again, that connection is banned too, so
--                              it can't carry on writing anonymously.
--   'ip:<salted hash prefix>'  an anonymous connection. Expires after LIMITS.ipBanHours: phones on cellular share
--                              carrier IPs, and a permanent ban would lock out strangers.
CREATE TABLE bans (
  writer      TEXT PRIMARY KEY,
  until       INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
