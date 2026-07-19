-- migration 0021: position 改 fractional index —— sync-plan P1 债表「必还」第四项。
--
-- 动机(多写者):整数密排的 position 配 (stage, position) 部分唯一索引,单写者阶段是
-- 好的完整性守护;两端离线各自拖动后合并必然撞号,且一次拖动要重排整列(oplog 一次发
-- 整列 op,64 记录的已知噪音)。改成 fractional index(base62 短字符串,字节序 == 排序
-- 序,见 src/frindex.rs):插到任意两张卡之间只写这一张卡,一次拖动一条 op,并发插同一
-- 空隙只是各得一枚不同的键,不撞索引。
--
-- SQLite 改不了列内 CHECK,整表重建(同 0010/0012/0013 的单表重建手法):
--   * position INTEGER -> TEXT;任务态 CHECK 从「非负整数」改「base62 排序键形态」
--     (头字符必须是字母 + 全字符落在 base62 表;完整规范形态由 frindex::validate 在
--     生成侧守,SQL 只兜住明显的垃圾);灵感态仍必须 NULL;
--   * 既有整数位序按 (stage 分区, position 升序) 转成短键:第 n 张卡得 'a'||digit
--     (n<62)或 'b'||两位(n<3906)——序不变、键合规;回收站/归档册的冻结行一并转
--     (它们不在唯一索引里,但 CHECK 对任务态行一视同仁);一列超过 3906 行则 CASE 落
--     NULL、任务态 CHECK 直接 ABORT 整个迁移(fail-fast:个人看板不可能,真撞上说明库
--     出了别的问题,绝不静默截断);
--   * (stage, position) 部分唯一索引与全部 items 触发器(0014×2 + 0017×4 + 0018×2)
--     原样重建;item_topic/item_revisions/item_image 的 FK 按名引用 items,重命名后
--     自动指向新表,id 全程不变。
--
-- oplog 兼容:0021 之前发射的 position op 的 value 是整数——历史,append-only 不改写。
-- 将来的回放层按「0021 前的 op 只存在于本机日志」处理(同步在 P2 才开闸,届时全部设备
-- 都已过 0021,新发射的 position 一律是字符串键)。
--
-- 这是**新增**迁移,不改任何已应用迁移(见 memory「migration-trap」);真实库迁移后
-- 人工跑 PRAGMA foreign_key_check / integrity_check + 行数/列序核验。
--
-- 同 0014:PRAGMA foreign_keys=OFF 必须在 BEGIN 之前(事务内改该 pragma 是 no-op)。

PRAGMA foreign_keys = OFF;

BEGIN;

-- ---- 1) 新结构(唯一差异:position 的类型与 CHECK) -------------------------
CREATE TABLE items_new (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    stage       TEXT NOT NULL CHECK (stage IN ('inbox', 'filed', 'todo', 'doing', 'confirming', 'done')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    archived_at TEXT,
    due_on      TEXT CHECK (due_on IS NULL OR (date(due_on) IS NOT NULL AND date(due_on) = due_on)),
    priority    INTEGER CHECK (priority IS NULL OR priority IN (1, 2, 3)),
    position    TEXT,
    sealed_at   TEXT,
    born_stage  TEXT,
    -- stage<->position 耦合:任务态必须是 base62 排序键(字母开头、全字符在表内),
    -- 灵感态必须 NULL。完整规范形态(整数段长度/尾随 '0')由生成侧 frindex::validate 守。
    CHECK (
        (stage IN ('todo', 'doing', 'confirming', 'done')
            AND typeof(position) = 'text'
            AND position GLOB '[A-Za-z]*'
            AND NOT (position GLOB '*[^0-9A-Za-z]*'))
        OR
        (stage IN ('inbox', 'filed') AND position IS NULL)
    ),
    -- 灵感态不携带任务专属属性(due/priority)。
    CHECK (
        stage IN ('todo', 'doing', 'confirming', 'done')
        OR (due_on IS NULL AND priority IS NULL)
    )
);

-- ---- 2) 灌数:整数位序 -> 短键(序不变) ------------------------------------
-- 每个 stage 内按旧 position 升序编号(id 打平并列——只有冻结行可能与活跃行同号),
-- 第 n 名得 'a'||digit / 'b'||两位;灵感态行 position 本就 NULL,原样保持。
INSERT INTO items_new (id, content, stage, created_at, updated_at, archived_at,
                       due_on, priority, position, sealed_at, born_stage)
SELECT id, content, stage, created_at, updated_at, archived_at,
       due_on, priority,
       CASE
         WHEN position IS NULL THEN NULL
         WHEN rn < 62 THEN 'a' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', rn + 1, 1)
         WHEN rn < 3906 THEN 'b' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (rn - 62) / 62 + 1, 1)
                             || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (rn - 62) % 62 + 1, 1)
         -- 3906+:落 NULL,任务态 CHECK ABORT,整个迁移回滚(fail-fast,见抬头注释)
       END,
       sealed_at, born_stage
FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY stage ORDER BY position ASC, id ASC) - 1 AS rn
    FROM items
);

-- ---- 3) 换表 ----------------------------------------------------------------
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

-- ---- 4) 索引(0014 两个普通 + 0017 版部分唯一) ------------------------------
CREATE INDEX idx_items_stage_created ON items (stage, created_at);
CREATE INDEX idx_items_stage_updated ON items (stage, updated_at);
CREATE UNIQUE INDEX idx_items_stage_position
    ON items (stage, position)
    WHERE archived_at IS NULL AND sealed_at IS NULL AND position IS NOT NULL;

-- ---- 5) 触发器原样重建(随 DROP TABLE 一并消失的 8 个) ----------------------
-- 0014:编辑历史归档 + 删除守护。
CREATE TRIGGER trg_item_archive_on_edit
BEFORE UPDATE OF content ON items
FOR EACH ROW
WHEN NEW.content <> OLD.content
BEGIN
    INSERT INTO item_revisions (item_id, content, archived_at)
    VALUES (OLD.id, OLD.content, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER trg_item_no_delete_live_organized
BEFORE DELETE ON items
FOR EACH ROW
WHEN OLD.archived_at IS NULL AND OLD.stage <> 'inbox'
BEGIN
    SELECT RAISE(ABORT, '只有未归类(inbox)灵感可直接硬删:其余请先移入回收站再彻底删除');
END;

-- 0017:成就归档轴四守护。
CREATE TRIGGER trg_item_no_insert_sealed
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '新条目不能直接带归档标记');
END;

CREATE TRIGGER trg_item_seal_only_done
BEFORE UPDATE OF sealed_at ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL AND OLD.sealed_at IS NULL
     AND (OLD.stage <> 'done' OR OLD.archived_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, '只有「已完成」且不在回收站的任务可以归档');
END;

CREATE TRIGGER trg_item_sealed_frozen
BEFORE UPDATE ON items
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '已归档的成就不可修改:请先取消归档');
END;

CREATE TRIGGER trg_item_sealed_no_delete
BEFORE DELETE ON items
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '已归档的成就不可删除:先「取消归档」回看板,再走回收站');
END;

-- 0018:出生态两守护。
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

COMMIT;

PRAGMA foreign_keys = ON;
