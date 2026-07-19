-- migration 0013: 任务看板加「待确认」态(confirming)—— 进行中与已完成之间的可选验收去处。
--
-- 背景:用户工作流中,一件事做完后常异步等外部确认/回音,需要从「进行中」物理移走,
-- 否则看板分不清「还要我推进的」与「在等回音的」。故在状态机加第四态 confirming
-- (前端显示「待确认」)。沿用「灵活不受限」:不是强制关卡——doing→done 快捷路径保留,
-- 待确认只是可选去处,四态间自由双向流转(legal 在 task.rs,from != to 即合法)。
--
-- 做法:SQLite 不能直接改 CHECK,故沿用 0010 的「重建 tasks 表」手法。当前 tasks 上
-- 已无任何触发器(0010 建表重置后未再加,见其注释),DROP TABLE 仅连带删除索引,重建
-- 即可。所有显式 DROP 用 IF EXISTS。无状态需要转换(0012 后表已是干净 todo/doing/done),
-- position 各 active 列已唯一非负,原样搬入即满足 partial unique 索引。
--
-- 不变量变化:
--   * tasks.status CHECK: ('todo','doing','done') -> ('todo','doing','confirming','done')
--   * 其余列 / 约束 / 索引完全不变(照搬 0010 重建后的形状)。
--
-- PRAGMA foreign_keys=OFF 必须在 BEGIN 之前(事务内改该 pragma 是 no-op)。FK 关掉是
-- 为了 DROP/RENAME 期间不误伤 task_note(其 FK 按表名 'tasks' 解析,RENAME 后仍有效)。
-- 真实库迁移后须人工跑:PRAGMA foreign_key_check; PRAGMA integrity_check;
-- SELECT status,COUNT(*) FROM tasks GROUP BY status;

PRAGMA foreign_keys = OFF;

BEGIN;

DROP TABLE IF EXISTS tasks_new;

CREATE TABLE tasks_new (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'confirming', 'done')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    archived_at TEXT,
    due_on      TEXT CHECK (due_on IS NULL OR (date(due_on) IS NOT NULL AND date(due_on) = due_on)),
    priority    INTEGER CHECK (priority IS NULL OR priority IN (1, 2, 3)),
    topic_id    TEXT REFERENCES topics(id) ON DELETE SET NULL,
    position    INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position >= 0)
);

-- Straight copy: no status needs converting; positions stay as-is (each active column
-- keeps its unique non-negative slots, archived rows keep their old position — both are
-- fine for the partial unique index rebuilt below).
INSERT INTO tasks_new (id, title, status, created_at, updated_at, archived_at, due_on, priority, topic_id, position)
SELECT id, title, status, created_at, updated_at, archived_at, due_on, priority, topic_id, position
FROM tasks;

DROP TABLE IF EXISTS tasks;            -- drops old table + ALL its indexes (no triggers exist post-0010)
ALTER TABLE tasks_new RENAME TO tasks;

-- Rebuild the indexes the dropped table carried (same set 0010 established).
CREATE INDEX idx_tasks_status_updated_at ON tasks (status, updated_at);
CREATE INDEX idx_tasks_topic_id          ON tasks (topic_id);
CREATE UNIQUE INDEX idx_tasks_status_position ON tasks (status, position) WHERE archived_at IS NULL;

COMMIT;

PRAGMA foreign_keys = ON;
