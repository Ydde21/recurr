-- Recurr schema v1 — incidents, replays, regression scenarios.

CREATE TABLE IF NOT EXISTS _recurr_migrations (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS executions (
  id          TEXT PRIMARY KEY,              -- RUN-XXXXXX / RPL-XXXXXX
  kind        TEXT NOT NULL CHECK (kind IN ('incident', 'replay')),
  replay_of   TEXT REFERENCES executions(id),
  service     TEXT NOT NULL,
  env         TEXT NOT NULL,
  method      TEXT,
  path        TEXT,
  status      INT,
  error_name  TEXT,
  captured_at TIMESTAMPTZ NOT NULL,
  duration_ms DOUBLE PRECISION,
  record      JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS executions_replay_of_idx ON executions (replay_of);
CREATE INDEX IF NOT EXISTS executions_service_time_idx ON executions (service, captured_at DESC);
CREATE INDEX IF NOT EXISTS executions_kind_time_idx ON executions (kind, captured_at DESC);

CREATE TABLE IF NOT EXISTS regression_scenarios (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  incident_id         TEXT NOT NULL REFERENCES executions(id),
  expected_bug_status INT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
