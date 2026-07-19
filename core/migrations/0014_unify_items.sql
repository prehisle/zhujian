-- migration 0014: 单实体重构 —— notes + tasks 合并为一张 items 表。
--
-- 产品模型扶正:「想法」和「待办」是同一主体的不同**阶段**,不是两个实体。此前
-- 「转待办」会新建一条 task 并保留原 note(task_note 1:1 link),不编辑标题时留下两条
-- 内容相同的当前记录 —— 纯重复,违背「最小化 / 同一主体」。这里收成单实体:
--   items.stage ∈ (inbox, filed, todo, doing, confirming, done)
--   转待办 = stage inbox/filed -> todo;撤回为灵感 = stage todo -> inbox/filed。零副本。
--
-- 统一生命周期(灵感态 + 任务态共用一行):
--   * 灵感态 inbox/filed:position/due_on/priority 必须 NULL(列内 CHECK 守);
--   * 任务态 todo/doing/confirming/done:position 必须非负整数(per-stage 手动序),
--     due_on/priority 可空可有效值;
--   * 回收站:archived_at 轴(冻结当前 stage,restore 回原 stage),沿用现 tasks 软删机制;
--   * 标签:item_topic(item_id, topic_id) M:N —— 任务也获多标签(原 task.topic_id 单标签
--     并入),想法的多标签不丢;
--   * 编辑历史:item_revisions(原 note_revisions 升格),0003 触发器改写为覆盖**全 stage**,
--     故改任务标题也自动归档历史。
--
-- 不变量(codex 评审补齐):
--   * position nullable + stage 耦合 CHECK:任务态非负整数、灵感态 NULL —— 否则 todo 能用
--     NULL 逃过 partial unique;
--   * partial unique (stage, position) WHERE archived_at IS NULL AND position IS NOT NULL;
--   * due_on/priority 仅任务态可非 NULL(列内 CHECK);
--   * 标签冻结不下沉触发器(会挡 topic 删/并、item purge 的级联),交命令层守卫;
--   * 删除守护(原 0004)升级:仅未归类(inbox 且未归档)可硬删,已归档可 purge,其余 live
--     直删 ABORT。
--
-- 迁移合并语义(三类来源):
--   1. linked pair(task 有 1:1 源 note):合成 1 条 item,id = note.id(note_topic 引用它,
--      保留省改),content = task.title(当前用户所见的面),stage/archived_at/due/priority/
--      position 取自 **task**(双轴权威:解决「源想法已删但任务仍活跃」这类冲突,统一以任务为准),
--      note 原文若 ≠ task.title 则作为最新一条历史压入 item_revisions(原文不丢、仍可搜),
--      created_at 取 note.created_at(主体诞生于捕获时);
--   2. standalone task(无源 note,手工建):id = task.id,content = task.title,照搬 task 列,无历史;
--   3. standalone note(纯想法,无 task):id = note.id,content = note.content,
--      stage 映射 inbox->inbox / processed->filed / archived->filed+archived_at(回收站),
--      历史 + 标签沿用。
--
-- ID 撞号:note 与 task 都是 ULID(碰撞概率可忽略),但库内无跨表唯一约束。若某 standalone
-- task.id 恰等于某 note.id,灌 items 时 PRIMARY KEY 会**直接 ABORT 整个迁移**(事务回滚、
-- user_version 不前进),绝不静默合并 —— fail-fast,不赌。
--
-- archived 想法没有真实归档时间(notes 无 archived_at 列):用其 created_at 作 archived_at,
-- 既给回收站一个稳定排序键(旧「灵感回收站」本就按 created_at DESC 排),又不伪装成精确历史
-- (见注释,是迁移近似)。divergence 历史的 archived_at 用 task.updated_at(标题最近一次变更的
-- 近似),同理标注近似。
--
-- 同 0010/0012/0013:PRAGMA foreign_keys=OFF 必须在 BEGIN 之前(事务内改该 pragma 是 no-op);
-- 这次是整库搬家而非单表重建。真实库迁移后须人工跑:
--   PRAGMA foreign_key_check; PRAGMA integrity_check;
--   SELECT stage, COUNT(*) FROM items GROUP BY stage;
--   -- 双轴冲突统计(有意折叠):源想法已归档但任务仍活跃的 linked pair 条数
-- 这是**新增**迁移,不改任何已应用迁移,真实库与 fresh DB 不分叉(见 memory「migration-trap」)。

PRAGMA foreign_keys = OFF;

BEGIN;

-- ---- 1) 新结构 ------------------------------------------------------------
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS item_topic;
DROP TABLE IF EXISTS item_revisions;

CREATE TABLE items (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    stage       TEXT NOT NULL CHECK (stage IN ('inbox', 'filed', 'todo', 'doing', 'confirming', 'done')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    archived_at TEXT,
    due_on      TEXT CHECK (due_on IS NULL OR (date(due_on) IS NOT NULL AND date(due_on) = due_on)),
    priority    INTEGER CHECK (priority IS NULL OR priority IN (1, 2, 3)),
    position    INTEGER,
    -- stage<->position 耦合:任务态必须有非负整数 position,灵感态必须 NULL。
    CHECK (
        (stage IN ('todo', 'doing', 'confirming', 'done')
            AND typeof(position) = 'integer' AND position >= 0)
        OR
        (stage IN ('inbox', 'filed') AND position IS NULL)
    ),
    -- 灵感态不携带任务专属属性(due/priority)。
    CHECK (
        stage IN ('todo', 'doing', 'confirming', 'done')
        OR (due_on IS NULL AND priority IS NULL)
    )
);

CREATE TABLE item_topic (
    item_id  TEXT NOT NULL REFERENCES items(id)  ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, topic_id)
);

CREATE TABLE item_revisions (
    revision_id INTEGER PRIMARY KEY,  -- surrogate rowid; nothing references it
    item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,        -- the superseded text
    archived_at TEXT NOT NULL         -- when this version stopped being current
);

-- ---- 2) 灌数:三类来源 ----------------------------------------------------
-- 1. linked pair:task 携 1:1 源 note,合成一行(id=note.id、面=task.title、任务轴权威)。
INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, due_on, priority, position)
SELECT
    n.id,
    t.title,
    t.status,
    n.created_at,         -- 主体诞生于捕获时
    t.updated_at,
    t.archived_at,        -- 双轴权威:以任务为准
    t.due_on,
    t.priority,
    t.position
FROM task_note tn
JOIN tasks t ON t.id = tn.task_id
JOIN notes n ON n.id = tn.note_id;

-- 2. standalone task:无源 note 的手工任务,照搬。
INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, due_on, priority, position)
SELECT
    t.id, t.title, t.status, t.created_at, t.updated_at, t.archived_at, t.due_on, t.priority, t.position
FROM tasks t
WHERE t.id NOT IN (SELECT task_id FROM task_note);

-- 3. standalone note:纯想法,无 task。processed/archived 都落 filed 阶段;archived 还在回收站。
INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, due_on, priority, position)
SELECT
    n.id,
    n.content,
    CASE n.status WHEN 'inbox' THEN 'inbox' ELSE 'filed' END,
    n.created_at,
    n.created_at,                                                  -- notes 无 updated_at:种为 created_at
    CASE n.status WHEN 'archived' THEN n.created_at ELSE NULL END, -- 回收站;近似归档时间(见抬头注释)
    NULL, NULL, NULL                                               -- 灵感态:无 due/priority/position
FROM notes n
WHERE n.id NOT IN (SELECT note_id FROM task_note);

-- ---- 3) 标签并集(item_topic) --------------------------------------------
-- 每条 note 都已成为同 id 的 item,故 note_topic 直接平移。
INSERT INTO item_topic (item_id, topic_id)
SELECT note_id, topic_id FROM note_topic;

-- 再把每个 task 的单标签 topic_id 并到它对应的 item 上(linked -> note.id,standalone -> task.id);
-- OR IGNORE 使其与上面的 note_topic 行做集合并(共享同一 topic 时去重)。
INSERT OR IGNORE INTO item_topic (item_id, topic_id)
SELECT COALESCE(tn.note_id, t.id), t.topic_id
FROM tasks t
LEFT JOIN task_note tn ON tn.task_id = t.id
WHERE t.topic_id IS NOT NULL;

-- ---- 4) 编辑历史(item_revisions) ----------------------------------------
-- 既有 note 编辑历史平移(每条 note 现为同 id 的 item)。按 rowid 升序灌入,新代理主键
-- 单调,显示序(revision_id DESC)与旧库一致。
-- 注:**用 rowid 而非 revision_id 排序**——真实库存在 migration-trap 分叉:旧 0003 建的
-- note_revisions 主键列叫 `id`(TEXT,可空,触发器没填故全 NULL),仓库现行 0003 才是
-- `revision_id INTEGER`。rowid 在两种结构上都存在(新结构里 revision_id 就是 rowid 别名),
-- 是唯一稳健的插入序。只读的 note_id/content/archived_at 三列两种结构都有。
-- 本迁移 DROP note_revisions、新建干净的 item_revisions,顺带把该分叉一并修正。
INSERT INTO item_revisions (item_id, content, archived_at)
SELECT note_id, content, archived_at FROM note_revisions ORDER BY rowid;

-- linked pair 中 note 原文 ≠ task.title 的:把(已被 task.title 取代的)note 原文作为**最新**
-- 一条历史补入,使用户写过的原文不丢、仍可被「连历史搜索」找到。archived_at 用 task.updated_at
-- (标题最近变更的近似;精确分叉时间不存在)。排在 note 既有历史之后 -> revision_id 更大 -> 显示最前。
INSERT INTO item_revisions (item_id, content, archived_at)
SELECT n.id, n.content, t.updated_at
FROM task_note tn
JOIN tasks t ON t.id = tn.task_id
JOIN notes n ON n.id = tn.note_id
WHERE n.content <> t.title;

-- ---- 5) 拆旧结构 + 触发器 -------------------------------------------------
-- DROP TABLE 连带删除各表自身的触发器(0003 在 notes/note_revisions、0004 在 notes)与索引。
-- 子/关联表先删,再删 notes/tasks(FK 已 OFF,顺序其实无碍,child-first 求干净)。
DROP TABLE IF EXISTS note_topic;
DROP TABLE IF EXISTS task_note;
DROP TABLE IF EXISTS note_revisions;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS notes;

-- ---- 6) 索引 --------------------------------------------------------------
CREATE INDEX idx_items_stage_created ON items (stage, created_at);
CREATE INDEX idx_items_stage_updated ON items (stage, updated_at);
-- 任务态列内 position 唯一(active);灵感态 position 为 NULL,被 WHERE 排除;归档行被排除。
-- 若迁移数据违反(两 active 同 stage 撞 position)此处建索引会 ABORT —— 又一道兜底。
CREATE UNIQUE INDEX idx_items_stage_position
    ON items (stage, position) WHERE archived_at IS NULL AND position IS NOT NULL;
CREATE INDEX idx_item_topic_topic_id    ON item_topic (topic_id);
CREATE INDEX idx_item_revisions_item_id ON item_revisions (item_id, revision_id);

-- ---- 7) 触发器(0003/0004 的 item 版) ------------------------------------
-- 编辑历史:content 真改动时先快照旧版 —— 任何代码路径都绕不过,且覆盖全 stage(改任务标题
-- 也进历史)。INSERT 不触发(BEFORE UPDATE OF content),故上面批量灌数不会重复归档。
CREATE TRIGGER trg_item_archive_on_edit
BEFORE UPDATE OF content ON items
FOR EACH ROW
WHEN NEW.content <> OLD.content
BEGIN
    INSERT INTO item_revisions (item_id, content, archived_at)
    VALUES (OLD.id, OLD.content, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- 历史只追加:旧版本不可改写(fail-fast)。
CREATE TRIGGER trg_item_revision_immutable
BEFORE UPDATE ON item_revisions
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, '历史版本不可修改(item_revisions 只追加)');
END;

-- 删除守护(原 0004 升级):仅「未归类且未归档」可硬删(捕获箱快速丢垃圾);已归档可 purge;
-- 其余 live(filed/任务态)直接 DELETE 一律 ABORT —— 必须先移入回收站。item_topic /
-- item_revisions 的级联是对那两张表的 DELETE,不触发本(items 上的)守护。
CREATE TRIGGER trg_item_no_delete_live_organized
BEFORE DELETE ON items
FOR EACH ROW
WHEN OLD.archived_at IS NULL AND OLD.stage <> 'inbox'
BEGIN
    SELECT RAISE(ABORT, '只有未归类(inbox)灵感可直接硬删:其余请先移入回收站再彻底删除');
END;

COMMIT;

PRAGMA foreign_keys = ON;
