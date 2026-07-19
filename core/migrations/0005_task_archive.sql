-- migration 0005: done-task soft-archive (任务回收站).
--
-- `archived_at` is a SECOND axis on top of `status`, not a fifth status value:
-- a `done` task with `archived_at` set is trashed (hidden from the board,
-- restorable). `status` stays 'done' through the whole archive→restore round-trip,
-- so the suggested→todo→doing→done lifecycle (and its 0002 guards) is untouched.
--
-- Invariant: archived_at IS NOT NULL  =>  status = 'done'.
-- Maintained by two things together:
--   1. the archive write guards on `status='done' AND archived_at IS NULL`
--      (only a live done task can be archived — see repo::archive_task), and
--   2. the freeze trigger below (an archived row's status cannot change until it
--      is restored, i.e. archived_at cleared).

ALTER TABLE tasks ADD COLUMN archived_at TEXT;

-- An archived task is frozen: its status cannot change until it is restored.
-- Without this, a stale board view could call update_task_status on an archived
-- done task and turn it into todo/doing while archived_at is still set, leaving a
-- dirty (archived_at!=NULL && status!='done') row. RAISE(ABORT), fail-fast.
CREATE TRIGGER trg_task_frozen_while_archived
BEFORE UPDATE OF status ON tasks
FOR EACH ROW
WHEN OLD.archived_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '已归档的任务须先还原才能改变状态(回收站中的任务已冻结)');
END;

-- Enforce the cross-column invariant at the storage layer (like 0002/0004): a row
-- may carry `archived_at` only while `status='done'`. The freeze trigger above
-- guards the `status` side (status can't change while archived); these two guard
-- the `archived_at` side — no write path (repo, future code, or raw SQL) may set
-- archived_at on a non-done task, nor set both status and archived_at into an
-- inconsistent pair in a single statement. Together: archived_at IS NOT NULL is
-- only ever true for a done task. RAISE(ABORT), fail-fast.
CREATE TRIGGER trg_task_archived_only_done_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN NEW.archived_at IS NOT NULL AND NEW.status <> 'done'
BEGIN
    SELECT RAISE(ABORT, '只有「已完成」的任务可被归档(archived_at 仅在 status=done 时允许)');
END;

CREATE TRIGGER trg_task_archived_only_done_update
BEFORE UPDATE ON tasks
FOR EACH ROW
WHEN NEW.archived_at IS NOT NULL AND NEW.status <> 'done'
BEGIN
    SELECT RAISE(ABORT, '只有「已完成」的任务可被归档(archived_at 仅在 status=done 时允许)');
END;

-- Relax the user-state delete guard from 0002: an archived task may now be
-- permanently purged (explicit user cleanup, mirroring notes 回收站), but a *live*
-- user-state task (todo/doing/done with archived_at NULL) still cannot be
-- hard-deleted. Only AI 'suggested' tasks and archived tasks are directly deletable.
DROP TRIGGER trg_task_no_delete_user_state;
CREATE TRIGGER trg_task_no_delete_user_state
BEFORE DELETE ON tasks
FOR EACH ROW
WHEN OLD.status <> 'suggested' AND OLD.archived_at IS NULL
BEGIN
    SELECT RAISE(ABORT, '不可删除活跃的用户态任务(只可硬删 suggested 或回收站中已归档的任务)');
END;
