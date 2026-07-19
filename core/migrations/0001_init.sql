-- ys-notebook initial schema (migration 0001)
-- IDs are ULIDs (TEXT). Timestamps are ISO-8601 / RFC3339 TEXT in UTC.
-- `foreign_keys` is enforced per-connection in db.rs — required for the
-- ON DELETE CASCADE rules below to take effect.

-- Original thoughts. `content` is append-only and never overwritten by AI.
-- `status` is process metadata and may change: inbox -> processed -> archived.
CREATE TABLE notes (
    id         TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('inbox', 'processed', 'archived')),
    created_at TEXT NOT NULL
);

-- AI clustering results (knowledge structure). title/summary may be updated,
-- but a topic id must never be reused for a different topic.
CREATE TABLE topics (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    summary    TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE note_topic (
    note_id  TEXT NOT NULL REFERENCES notes(id)  ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, topic_id)
);

-- Todos. Only `suggested` tasks are recomputable by AI; once the user accepts
-- (todo/doing/done) the row is user state and must not be overwritten.
CREATE TABLE tasks (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('suggested', 'todo', 'doing', 'done')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Provenance: which notes a task was distilled from.
CREATE TABLE task_note (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, note_id)
);

-- Agent memory: suggestions the user rejected, so AI does not re-propose them.
-- `fingerprint` is a hash of the normalized suggestion (e.g. normalized title).
CREATE TABLE rejected_suggestions (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL CHECK (type IN ('task', 'topic')),
    fingerprint TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (type, fingerprint)
);

CREATE INDEX idx_notes_status_created_at ON notes (status, created_at);
CREATE INDEX idx_tasks_status_updated_at ON tasks (status, updated_at);
CREATE INDEX idx_note_topic_topic_id     ON note_topic (topic_id);
CREATE INDEX idx_task_note_note_id       ON task_note (note_id);
-- (type, fingerprint) lookups are served by the UNIQUE constraint's index.
