CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  participants JSONB NOT NULL DEFAULT '[]',
  transcript TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'final')),
  record JSONB,
  provider TEXT CHECK (provider IN ('groq', 'ollama', 'demo')),
  model TEXT,
  warnings JSONB NOT NULL DEFAULT '[]',
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meetings_project_date ON meetings(project_id, date DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  provider TEXT NOT NULL CHECK (provider IN ('groq', 'ollama', 'demo')),
  model TEXT,
  fingerprint TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error TEXT,
  error_code TEXT,
  fallback_available BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_meeting ON jobs(meeting_id) WHERE status IN ('queued', 'processing');
CREATE INDEX IF NOT EXISTS jobs_deduplication ON jobs(meeting_id, fingerprint, status);

CREATE TABLE IF NOT EXISTS action_items (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  owner TEXT,
  deadline TEXT,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  evidence TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS actions_meeting_status ON action_items(meeting_id, status);

CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
