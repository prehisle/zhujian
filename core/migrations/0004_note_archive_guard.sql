-- Soft-delete (回收站) for processed notes, enforced at the storage layer.
--
-- A processed note is provenance: topics/tasks hang off it and its edit history
-- lives in note_revisions. So it must be soft-archived (status -> 'archived')
-- before it can ever be hard-deleted — moving it to the 回收站 first makes the
-- destructive step a deliberate, recoverable two-stage act, never a silent one.
--
-- This trigger guards that rule for *every* code path: a direct DELETE of a
-- still-'processed' note aborts. Inbox junk (status='inbox') and already-trashed
-- notes (status='archived') stay freely deletable. Legitimate cascades never
-- reach here — nothing cascades INTO `notes` (note_topic/task_note/note_revisions
-- all reference notes, not the other way), so only direct deletes are caught.
CREATE TRIGGER trg_note_no_delete_processed
BEFORE DELETE ON notes
FOR EACH ROW
WHEN OLD.status = 'processed'
BEGIN
    SELECT RAISE(ABORT, '已整理的想法不可硬删:请先移入回收站(archived)再彻底删除');
END;
