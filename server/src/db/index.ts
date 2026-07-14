import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, "repo-radar.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS scans (
  id            TEXT PRIMARY KEY,
  repo_url      TEXT,
  local_path    TEXT,
  repo_name     TEXT NOT NULL,
  label         TEXT,
  branch        TEXT,
  status        TEXT NOT NULL,
  config        TEXT NOT NULL,
  phases        TEXT NOT NULL,
  scores        TEXT,
  usage         TEXT NOT NULL,
  finding_count INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE TABLE IF NOT EXISTS findings (
  id            TEXT PRIMARY KEY,
  scan_id       TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  agent         TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  type          TEXT NOT NULL,
  severity      TEXT NOT NULL,
  file          TEXT,
  line          INTEGER,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  suggested_fix TEXT NOT NULL,
  confidence    REAL NOT NULL,
  reference     TEXT,
  fingerprint   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scan_id);

CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  scan_id    TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  audience   TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_scan ON reports(scan_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                     TEXT PRIMARY KEY,
  scan_id                TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  task_id                TEXT NOT NULL,
  agent                  TEXT NOT NULL,
  model                  TEXT NOT NULL,
  status                 TEXT NOT NULL,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd               REAL NOT NULL DEFAULT 0,
  duration_ms            INTEGER NOT NULL DEFAULT 0,
  detail                 TEXT,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_scan ON agent_runs(scan_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Idempotent migrations for pre-existing databases.
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
addColumnIfMissing("scans", "label", "label TEXT");
addColumnIfMissing("scans", "commit_sha", "commit_sha TEXT");
addColumnIfMissing("findings", "validation", "validation TEXT");
addColumnIfMissing("findings", "feedback", "feedback TEXT");
