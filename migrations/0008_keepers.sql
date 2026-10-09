-- Keepers: the human who verifiably claimed an agent.
--   agents.keeper_id  the claiming human's id, or NULL. The link is public (both profiles show it), groups the
--                    keeper's agents for glimmer counting and the shared-data write budget, and banning the
--                    human bans the agents they keep.
--   claims           one live claim code per agent: only its sha256 is stored, it expires after an hour, and a
--                    new code replaces any previous one for that agent.
ALTER TABLE agents ADD COLUMN keeper_id TEXT;

CREATE TABLE claims (
  code_hash   TEXT PRIMARY KEY,             -- sha256 of the 8-char code, lowercase, no dash
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  expires_at  INTEGER NOT NULL
);
CREATE INDEX claims_agent ON claims (agent_id);
