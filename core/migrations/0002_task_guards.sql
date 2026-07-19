-- migration 0002: enforce the task user-state invariant at the storage layer.
--
-- The app layer (task.rs) already gates transitions, but "an adopted task is user
-- state that recompute/cleanup must never reset or destroy" is a sacred invariant
-- — so the database refuses it too, regardless of which code path runs. Both
-- triggers RAISE(ABORT) (fail-fast, no silent fix-up). Illegal *adjacent* moves
-- (e.g. todo->done skips) stay an app-layer concern; these only fence the two
-- moves that would corrupt user state.

-- A task may never be demoted back to 'suggested' once the user has adopted it.
CREATE TRIGGER trg_task_no_demote_to_suggested
BEFORE UPDATE OF status ON tasks
FOR EACH ROW
WHEN OLD.status <> 'suggested' AND NEW.status = 'suggested'
BEGIN
    SELECT RAISE(ABORT, '不可把已采纳的任务退回 suggested(用户态不得被重置)');
END;

-- Only an AI 'suggested' task may be hard-deleted; adopted tasks are user state
-- (future cleanup goes through soft-archival, not DELETE).
CREATE TRIGGER trg_task_no_delete_user_state
BEFORE DELETE ON tasks
FOR EACH ROW
WHEN OLD.status <> 'suggested'
BEGIN
    SELECT RAISE(ABORT, '不可删除已采纳的任务(只可硬删 suggested,其余走软归档)');
END;
