-- migration 0010: 纯人工重定位 — 移除 AI 的 `suggested` 任务态 + 删 rejected_suggestions。
--
-- 产品已定为「纯人工 + 灵活 + 维护性高」,AI(organize/distill)从代码与 schema 撤出。
-- 此前几乎所有任务触发器都是为防「AI/系统在用户背后静默改数据」才下沉存储层的;
-- 单用户、无 AI 后,它们既锁住用户自己又抬高维护成本,故一并撤掉,把存储层收缩到
-- 「数据形状约束(CHECK/FK/唯一索引)+ note 历史保全(0003,不动)」。
--
-- 做法:SQLite 不能直接改 CHECK,故重建 tasks 表。`DROP TABLE tasks` 会**自动连带
-- 删除该表上的所有触发器与索引**(0002/0005/0006/0008/0009 累积的 8 个 task 触发器
-- 全部随之消失),因此无需逐个具名 DROP TRIGGER —— 也就天然规避了「某触发器名在真实
-- 库不存在导致裸 DROP panic」的踩坑史(见 0009 注释)。所有显式 DROP 仍用 IF EXISTS。
--
-- 不变量变化:
--   * tasks.status CHECK: ('suggested','todo','doing','done') -> ('todo','doing','done')
--   * archived_at ⇒ status≠suggested(0009)等归档冻结/用户态删除守护 全部移除
--     (归档冻结是流程政策,非数据保全;删除改由命令层 回收站 两段式把关)
--   * position 的非负整数约束从触发器(0008)折进列内联 CHECK
--   * 残留的 'suggested' 历史行(纯人工后理论上没有,旧库可能残留)-> 转 'todo' 保留,
--     绝不静默删除(可能含有价值的标题/来源 link);排在各自 todo 列已有项之后。
--
-- PRAGMA foreign_keys=OFF 必须在 BEGIN 之前(事务内改该 pragma 是 no-op)。FK 关掉是
-- 为了 DROP/RENAME 期间不误伤 task_note(其 FK 按表名 'tasks' 解析,RENAME 后仍有效)。
-- 真实库迁移后须人工跑:PRAGMA foreign_key_check; PRAGMA integrity_check;
-- SELECT status,COUNT(*) FROM tasks GROUP BY status; 触发器列表确认无残留。

PRAGMA foreign_keys = OFF;

BEGIN;

DROP TABLE IF EXISTS tasks_new;

CREATE TABLE tasks_new (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    archived_at TEXT,
    due_on      TEXT CHECK (due_on IS NULL OR (date(due_on) IS NOT NULL AND date(due_on) = due_on)),
    priority    INTEGER CHECK (priority IS NULL OR priority IN (1, 2, 3)),
    topic_id    TEXT REFERENCES topics(id) ON DELETE SET NULL,
    position    INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position >= 0)
);

-- Normalize suggested->todo, then renumber each ACTIVE column to a dense 0..n-1 so the
-- partial unique index below is satisfied; converted suggested rows sort after existing
-- todos (was_suggested ASC). Archived rows keep their old position (excluded from the
-- partial index, collisions harmless). Every row gets a valid non-negative integer
-- position (the NOT NULL/CHECK never fails).
WITH normalized AS (
    SELECT
        id,
        title,
        CASE status WHEN 'suggested' THEN 'todo' ELSE status END AS status,
        (status = 'suggested') AS was_suggested,
        created_at,
        updated_at,
        archived_at,
        due_on,
        priority,
        topic_id,
        CASE WHEN typeof(position) = 'integer' AND position >= 0 THEN position ELSE 0 END AS old_position
    FROM tasks
),
ordered AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY status
            ORDER BY was_suggested ASC, old_position ASC, updated_at DESC, id ASC
        ) - 1 AS active_position
    FROM normalized
    WHERE archived_at IS NULL
)
INSERT INTO tasks_new (id, title, status, created_at, updated_at, archived_at, due_on, priority, topic_id, position)
SELECT
    n.id, n.title, n.status, n.created_at, n.updated_at, n.archived_at, n.due_on, n.priority, n.topic_id,
    COALESCE(o.active_position, n.old_position)
FROM normalized n
LEFT JOIN ordered o ON o.id = n.id;

DROP TABLE IF EXISTS tasks;            -- drops old table + ALL its triggers + indexes
ALTER TABLE tasks_new RENAME TO tasks;

-- Rebuild the indexes the dropped table carried (0001 + 0007 + 0008).
CREATE INDEX idx_tasks_status_updated_at ON tasks (status, updated_at);
CREATE INDEX idx_tasks_topic_id          ON tasks (topic_id);
CREATE UNIQUE INDEX idx_tasks_status_position ON tasks (status, position) WHERE archived_at IS NULL;

-- Agent memory for AI rejections — gone with the AI.
DROP TABLE IF EXISTS rejected_suggestions;

COMMIT;

PRAGMA foreign_keys = ON;
