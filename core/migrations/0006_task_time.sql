-- migration 0006: task time dimension (截止日期 + 优先级).
--
-- Two new optional columns of pure user-state metadata on a task. Neither touches
-- the suggested→todo→doing→done lifecycle, the archive invariant, or note
-- immutability — they are just facts about a todo. (Reviewed by codex: GO.)
--
-- `due_on` is a user-local CALENDAR DAY (`YYYY-MM-DD`), deliberately NOT an
-- `*_at` RFC3339 UTC instant like created_at/updated_at/archived_at. A deadline is
-- a day, not a moment; storing it as a UTC datetime would invite off-by-one bugs
-- across the date line. "今天到期/逾期" is therefore decided on the FRONTEND, which
-- alone knows the user's local today — Rust never computes a local "today".
-- The CHECK rejects malformed strings AND impossible dates: date(due_on) returns
-- NULL for unparseable input and re-normalizes an invalid day (e.g. 2026-02-31 ->
-- 2026-03-03), so `date(due_on) = due_on` only holds for a real, canonical day.
--
-- `priority` is NULL = 未设(普通), or 1/2/3 = 低/中/高. No migration default (the
-- project's fail-fast rule shuns silent defaults) — existing rows get NULL.

ALTER TABLE tasks ADD COLUMN due_on TEXT
    CHECK (due_on IS NULL OR (date(due_on) IS NOT NULL AND date(due_on) = due_on));

ALTER TABLE tasks ADD COLUMN priority INTEGER
    CHECK (priority IS NULL OR priority IN (1, 2, 3));

-- Freeze due_on/priority while a task is archived (in the 回收站), mirroring the
-- 0005 status-freeze. An archived task is done + trashed; its time metadata should
-- not change until it is restored. Without this, a stale board view or raw SQL
-- could edit a trashed task's deadline. RAISE(ABORT), fail-fast — the repo set
-- commands also guard on `archived_at IS NULL`, but this enforces it at the
-- storage layer regardless of code path (same philosophy as 0002/0004/0005).
CREATE TRIGGER trg_task_meta_frozen_while_archived
BEFORE UPDATE OF due_on, priority ON tasks
FOR EACH ROW
WHEN OLD.archived_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '已归档的任务须先还原才能修改截止日期或优先级(回收站中的任务已冻结)');
END;
