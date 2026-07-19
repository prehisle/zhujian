-- migration 0022: 回放豁免标志 + items 表级硬约束降级 —— sync-plan P1 债表「必还」第五项。
--
-- 动机:远端 op 的应用(replay.rs::apply_remote_op)是**逐 op 的单字段写**,而单机时代
-- 立下的一批「用户主权 / 业务不变量」守护会把合法的回放拦死;并发合并的终态也可能违反
-- 单写者不变量(字段级 LWW 各字段独立胜出)。SQLite 没有会话级禁触发器,标准解法是
-- **单行标志表**:回放事务内插一行、事务尾删掉,守护触发器的 WHEN 里查它豁免——
-- 标志的置/清都在回放事务内,出错回滚即消失,不存在泄漏到正常路径的窗口。
--
-- 触发器可以加 WHEN,但 items 上有两类**表级硬约束**豁免不了,必须整表重建降级
-- (SQLite 改不了列内 CHECK / 唯一索引语义,同 0010/0012/0013/0014/0021 的重建手法):
--
--   1. stage<->position / 灵感态无 due·priority 两条**跨字段耦合 CHECK**(0021):
--      远端「转待办」是 set_field(stage) + set_field(position) 两条独立 op,回放第一条
--      时行上 position 还是 NULL——CHECK 对每条 UPDATE 评估新整行、不可延迟,必炸。
--      降级为带豁免的触发器:单机路径照拦,回放放行中间态。position 的 base62 **形态**
--      校验不耦合 stage,留在列 CHECK(远端值也必须形态合法,炸 = 数据损坏,fail-fast)。
--   2. UNIQUE (stage, position) 部分唯一索引:frindex::key_between 是确定性算法,
--      两端离线在**同一空隙**插卡会算出**同一个键**,合并后同列同键,回放第二条 op 撞
--      唯一索引即 ABORT、两端永不收敛。这是多写者的数学不是工程(0021 抬头「并发插同一
--      空隙只是各得一枚不同的键」那句写错了,以本迁移为准)。降为普通索引;读序 repo 层
--      本就 ORDER BY (position, id)——id 打平并列,确定性全序;同键并列是合并的合法
--      结局,用户拖一下即分开。单机侧「代码 bug 造同键」的守护改由 frindex::validate +
--      task.rs 单卡拖动契约 + cargo 测试兜。
--
-- 回放豁免的终态**允许违反单机不变量**(例:A 端撤回为灵感、B 端并发拖动,LWW 终态
-- stage=filed 却带 position 死值):纯字段级 LWW,不做无 op 背书的「顺手修补」——两端
-- 修补时机随 op 到达序漂移,必不收敛。读层全部按 stage 谓词查询,死值不伤;单机撤回
-- 路径本就显式发 position=NULL 的 set_field,常规场景终态干净。
--
-- 豁免范围(重建后 items 共 12 只触发器):
--   * 原样 4:trg_item_archive_on_edit(**刻意不豁免**——item_revisions 是本地派生数据,
--     回放远端编辑时本地照样长出历史,sync-plan §3.1)/ trg_item_no_insert_sealed /
--     trg_item_born_stage_required / trg_item_born_stage_frozen(后三只按回放契约永不
--     触发:create 快照 sealed 恒 NULL、stage 恒 == born_stage、白名单无 born_stage;
--     真触到 = 调用方违约,fail-fast 正是要的)。
--   * 加豁免 4:trg_item_no_delete_live_organized(远端 tombstone 可指任意 stage 的行)、
--     trg_item_seal_only_done / trg_item_sealed_frozen / trg_item_sealed_no_delete
--     (并发下「A 端合法归档」到达时本地 stage 可能已被 LWW 改走;sealed 行上更高 HLC
--     的字段编辑必须能落地;tombstone 支配 sealed——否则两端分叉)。
--   * 新增 4(带豁免):两条耦合 CHECK 的触发器化身,INSERT / UPDATE 各一只
--     (SQLite 一只触发器只挂一种事件)。
--
-- 这是**新增**迁移,不改任何已应用迁移(memory「migration-trap」);数据 SELECT 原样
-- 灌回,零值变换。真实库迁移后人工核验 PRAGMA foreign_key_check / integrity_check +
-- 行数 / 活跃列序逐张一致。
--
-- 同 0014/0021:PRAGMA foreign_keys=OFF 必须在 BEGIN 之前(事务内改该 pragma 是 no-op)。

PRAGMA foreign_keys = OFF;

BEGIN;

-- ---- 1) 单行回放标志表 -------------------------------------------------------
-- 空表 = 正常模式;有那一行 = 本连接正在回放远端 op。置/清只由 replay.rs 在回放
-- 事务内做,错误回滚连标志一起消失。PRIMARY KEY + CHECK 钉死「至多一行、值恒 1」。
CREATE TABLE sync_replay_active (
    flag INTEGER NOT NULL PRIMARY KEY CHECK (flag = 1)
);

-- ---- 2) 新结构(差异:两条耦合 CHECK 移除;position 留行内形态 CHECK) ---------
CREATE TABLE items_new (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    stage       TEXT NOT NULL CHECK (stage IN ('inbox', 'filed', 'todo', 'doing', 'confirming', 'done')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    archived_at TEXT,
    due_on      TEXT CHECK (due_on IS NULL OR (date(due_on) IS NOT NULL AND date(due_on) = due_on)),
    priority    INTEGER CHECK (priority IS NULL OR priority IN (1, 2, 3)),
    -- 行内值域:有值必须长得像 base62 排序键(字母开头 + 全字符在表内)。
    -- 「任务态必须有 / 灵感态必须无」的耦合降到下方触发器。
    position    TEXT CHECK (position IS NULL OR (position GLOB '[A-Za-z]*' AND NOT (position GLOB '*[^0-9A-Za-z]*'))),
    sealed_at   TEXT,
    born_stage  TEXT
);

-- ---- 3) 灌数(原样,零值变换) ------------------------------------------------
INSERT INTO items_new (id, content, stage, created_at, updated_at, archived_at,
                       due_on, priority, position, sealed_at, born_stage)
SELECT id, content, stage, created_at, updated_at, archived_at,
       due_on, priority, position, sealed_at, born_stage
FROM items;

-- ---- 4) 换表 ----------------------------------------------------------------
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

-- ---- 5) 索引(唯一差异:stage_position 从 UNIQUE 降普通,谓词保留) ------------
CREATE INDEX idx_items_stage_created ON items (stage, created_at);
CREATE INDEX idx_items_stage_updated ON items (stage, updated_at);
CREATE INDEX idx_items_stage_position
    ON items (stage, position)
    WHERE archived_at IS NULL AND sealed_at IS NULL AND position IS NOT NULL;

-- ---- 6) 触发器:原样 4 只 -----------------------------------------------------
-- 0014:编辑历史归档。回放**刻意不豁免**——远端编辑落地时,本地触发器照样把旧文
-- 归档进 item_revisions(它是本地派生数据、不参与同步,各端自己长历史)。
CREATE TRIGGER trg_item_archive_on_edit
BEFORE UPDATE OF content ON items
FOR EACH ROW
WHEN NEW.content <> OLD.content
BEGIN
    INSERT INTO item_revisions (item_id, content, archived_at)
    VALUES (OLD.id, OLD.content, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- 0017:禁生而归档。回放 create 的快照里 sealed_at 恒 NULL(出生不可能已归档),
-- 触到 = 回放调用方违约,fail-fast 兜底,不豁免。
CREATE TRIGGER trg_item_no_insert_sealed
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '新条目不能直接带归档标记');
END;

-- 0018:出生态两守护。create 快照 stage 恒 == born_stage(发射端出生时刻读行),
-- set_field 白名单没有 born_stage——两只都按契约永不触发,不豁免。
CREATE TRIGGER trg_item_born_stage_required
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.born_stage IS NULL OR NEW.born_stage <> NEW.stage
BEGIN
    SELECT RAISE(ABORT, '新条目必须如实记录出生态(born_stage = 插入时的 stage)');
END;

CREATE TRIGGER trg_item_born_stage_frozen
BEFORE UPDATE OF born_stage ON items
FOR EACH ROW
WHEN OLD.born_stage IS NOT NEW.born_stage
BEGIN
    SELECT RAISE(ABORT, '出生态是史实,不可修改');
END;

-- ---- 7) 触发器:加豁免 4 只(原 WHEN AND 标志表为空) -------------------------
-- 0014:删除守护。远端 tombstone 是「该实体已死」的不可逆事实,可指任意 stage 的行。
CREATE TRIGGER trg_item_no_delete_live_organized
BEFORE DELETE ON items
FOR EACH ROW
WHEN OLD.archived_at IS NULL AND OLD.stage <> 'inbox'
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '只有未归类(inbox)灵感可直接硬删:其余请先移入回收站再彻底删除');
END;

-- 0017:仅活跃 done 可归档。并发下远端合法归档到达时,本地 stage 可能已被 LWW 改走,
-- 收敛优先于单机不变量。
CREATE TRIGGER trg_item_seal_only_done
BEFORE UPDATE OF sealed_at ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL AND OLD.sealed_at IS NULL
     AND (OLD.stage <> 'done' OR OLD.archived_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '只有「已完成」且不在回收站的任务可以归档');
END;

-- 0017:归档后冻结。sealed 行上更高 HLC 的远端字段编辑必须能落地(字段级 LWW)。
CREATE TRIGGER trg_item_sealed_frozen
BEFORE UPDATE ON items
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '已归档的成就不可修改:请先取消归档');
END;

-- 0017:归档不可删。tombstone 支配 sealed(delete-wins-sticky),否则两端分叉。
CREATE TRIGGER trg_item_sealed_no_delete
BEFORE DELETE ON items
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '已归档的成就不可删除:先「取消归档」回看板,再走回收站');
END;

-- ---- 8) 触发器:新增 4 只(被降级的耦合 CHECK 的化身,带豁免) -----------------
-- stage<->position 耦合:任务态必须携带排序键、灵感态必须没有。
CREATE TRIGGER trg_item_stage_position_coupled_insert
BEFORE INSERT ON items
FOR EACH ROW
WHEN NOT ((NEW.stage IN ('todo', 'doing', 'confirming', 'done') AND NEW.position IS NOT NULL)
          OR (NEW.stage IN ('inbox', 'filed') AND NEW.position IS NULL))
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, 'stage 与 position 耦合:任务态必须有排序键,灵感态必须没有');
END;

CREATE TRIGGER trg_item_stage_position_coupled_update
BEFORE UPDATE OF stage, position ON items
FOR EACH ROW
WHEN NOT ((NEW.stage IN ('todo', 'doing', 'confirming', 'done') AND NEW.position IS NOT NULL)
          OR (NEW.stage IN ('inbox', 'filed') AND NEW.position IS NULL))
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, 'stage 与 position 耦合:任务态必须有排序键,灵感态必须没有');
END;

-- 灵感态不携带任务专属属性(due/priority)。
CREATE TRIGGER trg_item_idea_no_task_attrs_insert
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.stage IN ('inbox', 'filed')
     AND (NEW.due_on IS NOT NULL OR NEW.priority IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '灵感态不携带截止/优先级');
END;

CREATE TRIGGER trg_item_idea_no_task_attrs_update
BEFORE UPDATE OF stage, due_on, priority ON items
FOR EACH ROW
WHEN NEW.stage IN ('inbox', 'filed')
     AND (NEW.due_on IS NOT NULL OR NEW.priority IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '灵感态不携带截止/优先级');
END;

COMMIT;

PRAGMA foreign_keys = ON;
