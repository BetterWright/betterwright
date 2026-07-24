PRAGMA foreign_keys = ON;

-- API-key secrets are never stored. key_hash is an HMAC-SHA-256 digest of
-- the complete bw_live_<id>_<secret> credential under API_KEY_HMAC_SECRET.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER,
  revoked_at_ms INTEGER
) STRICT;

CREATE INDEX api_keys_by_user
  ON api_keys (user_id, revoked_at_ms, created_at_ms DESC);

-- The trigger makes the five-active-key limit race safe inside D1.
CREATE TRIGGER api_keys_max_five
BEFORE INSERT ON api_keys
WHEN (
  SELECT COUNT(*) FROM api_keys
  WHERE user_id = NEW.user_id AND revoked_at_ms IS NULL
) >= 5
BEGIN
  SELECT RAISE(ABORT, 'active_api_key_limit');
END;

-- Capability plaintext and the viewer root key are never persisted. The two
-- capability columns hold role-separated HMAC-SHA-256 digests only.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  host_cap_hash TEXT NOT NULL,
  viewer_cap_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  ended_reason TEXT,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
) STRICT;

CREATE INDEX sessions_by_user
  ON sessions (user_id, created_at_ms DESC);
CREATE INDEX sessions_active
  ON sessions (ended_at_ms, expires_at_ms);

CREATE TABLE relay_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  kill_switch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch_enabled IN (0, 1)),
  reason TEXT NOT NULL DEFAULT '',
  updated_at_ms INTEGER NOT NULL
) STRICT;

INSERT INTO relay_control (singleton, kill_switch_enabled, reason, updated_at_ms)
VALUES (1, 0, '', 0);
