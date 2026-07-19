-- Task→topic tagging (migration 0007).
--
-- A task may carry at most one topic, NULL = 无主题 (the default). This is a
-- *user-set board tag* — a "current topic pointer" — letting the 任务看板 filter
-- 所有 / 无主题 / 每个主题, and letting even a manually-created task (no source
-- note) be grouped.
--
-- This is deliberately DISTINCT from note_topic (the recomputable note→topic
-- knowledge projection): task.topic_id does not reverse-derive notes, is not part
-- of any AI recompute, and never touches rejected_suggestions.
--
-- It is also a deliberate EXCEPTION to the archived-freeze laws (0005/0006): there
-- is NO freeze trigger here. A topic delete/merge is a knowledge-structure change
-- that must stay free, and an archived task is merely done+in-trash, so its tag
-- being re-pointed (merge) or cleared (delete, via ON DELETE SET NULL) is a
-- harmless, expected spill-over of the projection changing. Forbidding a *user*
-- from editing an archived task's tag is a command-layer guard (set_task_topic's
-- WHERE clause), not a storage invariant — a freeze trigger here would abort
-- topic delete/merge, because SQLite FK actions (SET NULL) themselves fire
-- triggers and cannot be told apart from a plain UPDATE.
ALTER TABLE tasks ADD COLUMN topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL;

-- Serves the board's per-topic filter and keeps topic delete/merge from scanning
-- the whole tasks table. (The 无主题 = NULL filter uses this index fine.)
CREATE INDEX idx_tasks_topic_id ON tasks (topic_id);
