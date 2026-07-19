-- migration 0008: manual task ordering (拖动调整看板列内顺序).
--
-- The board's columns (待办/进行中/已完成) previously ordered cards by an automatic
-- urgency sort (due_on → priority → updated_at). The user wants to drag cards into
-- a manual order, so this adds `position` as the single per-column ordering axis:
-- within a column, cards sort strictly by `position`; due_on/priority become pure
-- highlight hints and no longer decide order. (Reviewed by codex, two rounds: GO.)
--
-- Scope is PER-STATUS: each column carries its own 0..n-1 dense order. A card moved
-- to another column (or freshly created) lands at that column's end (MAX+1); a drag
-- reorder rewrites the whole target column's positions in one transaction. The
-- invariant — every active (board) task has a unique, non-negative integer position
-- within its status — is enforced below at the storage layer, not just by the repo.
--
-- archived_at is a second axis (0005): an archived task lives in the 回收站, ordered
-- by archived_at, so its `position` is meaningless. The unique index is therefore
-- PARTIAL (active rows only); restore re-assigns a fresh end-of-column position.

ALTER TABLE tasks ADD COLUMN position INTEGER;   -- nullable here; backfilled below, then hard-guarded

-- Backfill each column from the old urgency order, so the first board render after
-- upgrade matches what the user saw before. `id ASC` is a stable tie-break so the
-- initial order is reproducible. Runs before the guard triggers exist, so it is not
-- blocked by them; runs before the unique index, which then builds over unique values.
WITH ordered AS (
    SELECT id, ROW_NUMBER() OVER (
        PARTITION BY status
        ORDER BY due_on IS NULL, due_on ASC, priority IS NULL, priority DESC, updated_at DESC, id ASC
    ) - 1 AS pos
    FROM tasks
)
UPDATE tasks SET position = (SELECT pos FROM ordered WHERE ordered.id = tasks.id);

-- The core invariant: within a status, no two ACTIVE tasks share a position. Partial
-- (archived_at IS NULL) so a trashed task's stale position never collides. A drag
-- reorder must therefore write positions in two phases (high temp band, then final
-- 0..n-1) to avoid a transient duplicate — see task::reorder.
CREATE UNIQUE INDEX idx_tasks_status_position ON tasks (status, position) WHERE archived_at IS NULL;

-- Hard-guard position as a non-null, non-negative INTEGER on every write path. ALTER
-- cannot add a NOT NULL column without a default, and a silent default would violate
-- fail-fast, so the constraint lives in triggers instead. `typeof <> 'integer'` also
-- rejects TEXT/REAL that could slip past a bare `< 0` check.
CREATE TRIGGER trg_task_position_valid_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN typeof(NEW.position) <> 'integer' OR NEW.position < 0
BEGIN
    SELECT RAISE(ABORT, 'task.position 必须为非负整数');
END;

CREATE TRIGGER trg_task_position_valid_update
BEFORE UPDATE OF position ON tasks
FOR EACH ROW
WHEN typeof(NEW.position) <> 'integer' OR NEW.position < 0
BEGIN
    SELECT RAISE(ABORT, 'task.position 必须为非负整数');
END;
