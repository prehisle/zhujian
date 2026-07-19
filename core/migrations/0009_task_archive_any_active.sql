-- migration 0009: allow soft-archiving ANY active user-state task, not just done.
--
-- 0005 let only a `done` task carry `archived_at` (回收站). The board now needs a
-- 删除 affordance on every card, so a todo/doing/done task can be soft-archived into
-- the 回收站, recoverable. Archiving FREEZES its status (trg_task_frozen_while_archived,
-- 0005, unchanged) so restore returns it to its ORIGINAL column. `suggested` stays
-- un-archivable — it is AI-recomputable and is removed via dismiss (hard delete), never
-- trashed. So the core invariant relaxes:
--     archived_at IS NOT NULL  =>  status = 'done'   (0005)
--   becomes
--     archived_at IS NOT NULL  =>  status <> 'suggested'   (0009)
--
-- `position` is NOT a dense invariant. The real, storage-enforced invariant (0008
-- partial unique index + valid triggers) is "unique, non-negative integer position
-- per ACTIVE status column". Order is read by `ORDER BY position ASC`; the next end
-- slot is MAX+1. Archiving a middle card therefore leaves a gap, which every read /
-- reorder / restore path tolerates — exactly as a cross-column reorder already vacates
-- a source slot today. A drag-reorder normalizes the column it touches back to dense
-- 0..n-1, but density is best-effort, not a guarantee.

-- Replace 0005's done-only archive guards with suggested-exclusion guards.
-- IF EXISTS is required, not cosmetic: the real production DB was migrated through
-- version 5 BEFORE these two triggers were appended to 0005 (added in a later codex
-- round — see CLAUDE.md 进度⑬). A migration runs once per version, so editing an
-- already-applied file never back-fills it — the triggers exist on every FRESH db
-- (tests/e2e) but are ABSENT on the user's real db. A bare DROP would then panic
-- ("no such trigger") on the real db while passing all fresh-db tests.
DROP TRIGGER IF EXISTS trg_task_archived_only_done_insert;
DROP TRIGGER IF EXISTS trg_task_archived_only_done_update;

-- archived_at may be set only on a user-state task (todo/doing/done) — never on a
-- 'suggested' row. RAISE(ABORT), fail-fast.
CREATE TRIGGER trg_task_archived_not_suggested_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN NEW.archived_at IS NOT NULL AND NEW.status = 'suggested'
BEGIN
    SELECT RAISE(ABORT, '建议态任务不可归档(archived_at 仅用户态任务允许;suggested 走 dismiss)');
END;

-- On update, reject both a 'suggested' archived row AND adopting straight into the trash
-- (OLD.status='suggested' while setting archived_at in one statement) — so archived_at is
-- only ever set on a row that was already user state.
CREATE TRIGGER trg_task_archived_not_suggested_update
BEFORE UPDATE ON tasks
FOR EACH ROW
WHEN NEW.archived_at IS NOT NULL AND (NEW.status = 'suggested' OR OLD.status = 'suggested')
BEGIN
    SELECT RAISE(ABORT, '建议态任务不可归档(archived_at 仅用户态任务允许;suggested 走 dismiss)');
END;
