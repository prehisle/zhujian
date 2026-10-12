-- migration 0041: 配图进回收站(item_image.removed_at + oplog 词汇 `image × set_field`)
-- —— backlog 用户面 149,全案 docs/image-trash-plan.md(codex 设计审三弹 GO)。
--
-- 动机:删图原是硬删行 + `image_tombstone`,字节只住行里,删了就没了 —— 与「删除 = 进回收站、
-- 销毁只在回收站里发生」对不上。改成:删图 = 打删除标记(行、字节、编号、缩略图全留),在回收站
-- 里可还原到原编号;真销毁仍走既有 `image_tombstone`,语义一字不改。
--
-- 三件事:
--   ① `item_image.removed_at TEXT`(可空):NULL = 在用;非 NULL = 已删、在回收站,值 = 删除
--      时刻(RFC3339)。形上照抄 `items.archived_at`:**生而为 NULL、不进 `image_add` payload、
--      只由 set_field 承载**(往既有 add payload 加键 = 旧端存日志丢值,0033 → 0034 判例)。
--      表层不加列内 CHECK:格式的正式子在代码层(`replay::validate_image_field_shape`),同 0040。
--   ② `trg_item_image_immutable` 放开 removed_at 一列(规格 §6.2):id / item_id / data / mime /
--      created_at 任何时候不可变;seq 只许在回放事务内改;removed_at 回放内外都可改(本机删 /
--      还原走 `images.rs`,远端走 `apply_image_set_field`)。
--   ③ oplog 词汇加 `image × set_field`(只有 removed_at 一个字段,LWW 寄存器,规格 §3.2 / §3.3)。
--
-- 跨版本同步政策(db.rs 头「迁移作者规则」三选一):**协议 / oplog 词汇变化,单版直发
-- forward**(2026-07-22 用户拍板的 forward 政策,memory `single-phase-until-scale`;0040 同口径)。
-- 存量旧端收到 `image set_field` 落 `validate_op_shape` 兜底臂 = **UnsupportedVocab** = 该
-- origin 内存挂起、水位不动、**升级即自愈、零丢失**(首版自检清单 15 的等待型)⇒ 不需要发送端闸。
-- 诚实边界:挂起期间该 origin 后续的其他 op 也一起停到旧端升级 ⇒ 发布说明提示两端一起更新。
-- 反方向:旧端删图仍发 `image_tombstone`,新端照删(那张不进回收站)—— 混版窗口里可接受。
--
-- 存量不回填:迁移前删掉的图已经没有行,无从软删;在用的图 removed_at = NULL 就是正确初值。
-- ⛔ 同步字段本就不许在迁移里 UPDATE(表有值 op 无 = 引导审计判「表 / 日志矛盾」+ 跨端分叉)。
--
-- 0029 起迁移文件只写事务体:无 BEGIN/COMMIT/PRAGMA user_version。这是**新增**迁移,不改任何
-- 已应用迁移(memory「migration-trap」)。oplog 重建照 0037 的「搬运表 → DROP → 最终名重建」,
-- ⛔ 不用 RENAME —— 理由见 0037 头注(`board_column` 上那只引用 oplog 的触发器);oplog 缺席的
-- 窗口里别碰 `board_column.tombstoned_at`。
--
-- ⚠️ 下方 `CREATE TABLE oplog` 的表体文本是新的单一 DDL 真相源:`epoch::OPLOG_TABLE_DDL` 与它
-- **逐字同源(含语句内注释)**,改这里必同步改那里。

-- ---- ① 列 + 回收站列表用的部分索引 -----------------------------------------------------
ALTER TABLE item_image ADD COLUMN removed_at TEXT;

CREATE INDEX idx_item_image_removed ON item_image (removed_at) WHERE removed_at IS NOT NULL;

-- ---- ② 触发器:放开 removed_at ---------------------------------------------------------
DROP TRIGGER trg_item_image_immutable;

-- 图只增删不改。两处例外:回放事务里的「图N」顺延只许改 seq;removed_at(软删标记)随时可改。
CREATE TRIGGER trg_item_image_immutable
BEFORE UPDATE ON item_image
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
     OR NEW.item_id IS NOT OLD.item_id
     OR NEW.data IS NOT OLD.data
     OR NEW.mime IS NOT OLD.mime
     OR NEW.created_at IS NOT OLD.created_at
     OR (NEW.seq IS NOT OLD.seq AND NOT EXISTS (SELECT 1 FROM sync_replay_active))
BEGIN
    SELECT RAISE(ABORT, 'item_image 只追加 / 删除,不可修改(换图请删旧加新;回放顺延仅改 seq;软删只改 removed_at)');
END;

-- ---- ③ oplog 词汇:搬运表(裸表;origin 是生成列,列表点名避开) -------------------------
CREATE TABLE oplog_carry (
    op_id      TEXT NOT NULL,
    hlc        TEXT NOT NULL,
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    origin_seq INTEGER NOT NULL
);

INSERT INTO oplog_carry (op_id, hlc, entity, entity_id, kind, payload, origin_seq)
SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM oplog;

DROP TABLE oplog;

CREATE TABLE oplog (
    op_id      TEXT NOT NULL PRIMARY KEY,
    hlc        TEXT NOT NULL,
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    -- 源设备发射序号,每 origin 从 1 连续编;远端 op 原样入库(连续性由收端引擎的
    -- 严格连续应用保证,sync-protocol §5.3)。
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 1),
    -- 来源设备,从 hlc 定长编码内嵌处派生(第 24 字符起),虚拟列不落存储。
    origin     TEXT GENERATED ALWAYS AS (substr(hlc, 24)) VIRTUAL,
    CHECK (
        (entity IN ('item', 'topic') AND kind IN ('create', 'set_field', 'tombstone'))
        OR (entity = 'link' AND kind IN ('link_add', 'link_remove'))
        -- 配图:set_field 只承载 removed_at(软删标记,image-trash-plan §3.2);销毁仍是 image_tombstone。
        OR (entity = 'image' AND kind IN ('image_add', 'image_tombstone', 'set_field'))
        -- 空间 profile 单例寄存器(space-name-sync-plan §3):无 create、无 tombstone。
        OR (entity = 'space' AND kind = 'set_field')
        -- 设备 profile 多实例寄存器(identity-plan §2.1):同样无 create、无 tombstone,
        -- 但 entity_id = 该设备的 device_id(不是固定字面量),故无单行钉死。
        OR (entity = 'device' AND kind = 'set_field')
        -- 条目留言(identity-plan §4.1):有真实出生事件、要能删,故 create + tombstone;
        -- **刻意无 set_field** —— 留言不可编辑,改错了删掉重写。
        OR (entity = 'comment' AND kind IN ('create', 'tombstone'))
        -- 看板列(board-columns-plan §3):形近 topic —— 有出生事件、可改名可排序可删。
        -- ⛔ 六个种子**不发 create**(§7.1a);⛔ set_field 白名单只有 title | position,
        -- kind/system/created_at 是出生字段(改 kind 会让该列上全部条目的耦合约束当场
        -- 反转,改 system 能把灵感列降级成可删——两者都没有合法用途)。
        OR (entity = 'board_column' AND kind IN ('create', 'set_field', 'tombstone'))
    )
);

INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq)
SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM oplog_carry;

DROP TABLE oplog_carry;

-- 索引与 append-only 触发器原样重建(0024/0028/0033/0035/0037 同源)。
CREATE UNIQUE INDEX idx_oplog_hlc ON oplog (hlc);
CREATE INDEX idx_oplog_entity ON oplog (entity, entity_id);
CREATE UNIQUE INDEX idx_oplog_origin_seq ON oplog (origin, origin_seq);

CREATE TRIGGER trg_oplog_immutable
BEFORE UPDATE ON oplog
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'op 是史实,不可改写');
END;

CREATE TRIGGER trg_oplog_no_delete
BEFORE DELETE ON oplog
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'op 是史实,不可删除');
END;
