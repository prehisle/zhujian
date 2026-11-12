-- migration 0043: 多看板(board 实体 + board_column.board_id 出生字段 + 角色指针)
-- —— backlog 用户面 170,全案 docs/multiboard-plan.md(codex 设计审两轮,二轮 GO-with-fixes)。
--
-- 动机:看板的「落点」「完成」两个角色原本写死在 `todo` / `done` 两个列 id 上(board.rs
-- LANDING_COLUMN / DONE_COLUMN)。多看板 = 一个空间多块看板、每块自己一套列,角色改成**每块
-- 看板上的两根指针**(完成那根可空 = 这块看板只分类、不完成)。卡不另存「属于哪块看板」:
-- `item.stage → board_column.board_id → board`(plan §1 不变量 2)。
--
-- 五件事:
--   ① 新表 `board` + 种子行 `'tasks'`(implicit genesis,同种子列:不发 create,行由本迁移种下)。
--      两根角色指针**不挂 FK**:它们是 LWW 寄存器,可被并发墓碑弄成悬空,悬空由读侧解析降级
--      (plan §3),不在存储层拒。种子行的指针存 'todo' / 'done' 而不是 NULL:NULL 的含义是
--      「最左列 / 没有完成列」,而种子看板今天的语义是「todo 落点、done 完成」。
--   ② `board_column.board_id`(可空,NULL = 种子看板):**出生字段**,只由新 kind
--      `board_column/create_in_board` 写入(plan §2.2)。既有列全 NULL ⇒ 零表重建、零回填。
--   ③ 出生冻结:重建 `trg_board_column_birth_immutable`,加入 board_id(⛔ 不带回放豁免);
--      `board` 的 created_at 同样冻结;看板行永不物理删除、种子看板不可删(⛔ 都不带豁免);
--      看板墓碑 marker 照列那套(0036 ④⑥)只能由**登记在案的 tombstone writer** 改写
--      (codex 实现审一轮 M1:授权表守的是「具体 op 背书 + 普通 min / 压实 rebase 的方向」,
--      不是「先清空」—— 原稿以「看板的先清空只是命令前置」为由降级,理由读错了分工)。
--   ④ 重写 `trg_item_seal_only_done`:原判据是字面量 `OLD.stage <> 'done'`,改成「OLD.stage 是
--      它所在看板**解析后的完成列**」(看板活、列活、归属对、完成指针指着它);⛔ 用 NOT EXISTS,
--      别写 `OLD.stage <> (子查询)` —— 子查询为 NULL(没有完成列)时 `<>` 得 NULL、漏拒。
--      仍带 `sync_replay_active` 豁免:远端 seal 到达时本机角色可能已改(0017 同理)。
--   ⑤ oplog 词汇:`board × {create, set_field, tombstone}` 与 `board_column × create_in_board`。
--
-- 跨版本同步政策(db.rs 头「迁移作者规则」三选一):**协议 / oplog 词汇变化,单版直发
-- forward**(同 0040–0042;用户 2026-11-11 拍「不设版本门」,plan §0 ⑪)。存量旧端收到
-- `board/*` 或 `board_column/create_in_board` 落 `validate_op_shape` 兜底臂 = **UnsupportedVocab**
-- = 该 origin 内存挂起、水位不动、升级即自愈、零丢失。⛔ 既有 `board_column/create` 恰五键、
-- 多一键即 InvalidOp(持久隔离)⇒ 归属**只能**走新 kind,绝不往五键 create 里加键。
--
-- ⛔ 同步字段本就不许在迁移里 UPDATE(表有值 op 无 = 引导审计判「表 / 日志矛盾」)—— 本迁移
-- 只种 `'tasks'` 一行(它是 implicit genesis,审计按 SEED_BOARDS 豁免),不改任何既有行。
--
-- 0029 起迁移文件只写事务体:无 BEGIN/COMMIT/PRAGMA user_version。oplog 重建照 0041 的
-- 「搬运表 → DROP → 最终名重建」,⛔ 不用 RENAME(0037 头注:`board_column` 上有引用 oplog
-- 的触发器);oplog 缺席的窗口里别碰 `board_column.tombstoned_at`。
--
-- ⚠️ 下方 `CREATE TABLE oplog` 的表体文本是新的单一 DDL 真相源:`epoch::OPLOG_TABLE_DDL` 与它
-- **逐字同源(含语句内注释)**,改这里必同步改那里。

-- ---- ① board ------------------------------------------------------------------------
CREATE TABLE board (
    id                TEXT PRIMARY KEY,   -- 新看板 = 26 位严格 ULID;种子看板 = 字面量 'tasks'
    title             TEXT NOT NULL,
    position          TEXT NOT NULL,      -- frindex 排序键;⛔ 普通索引,绝不 UNIQUE(0022 同理)
    landing_column_id TEXT,               -- NULL = 本看板最左那枚非完成活列(plan §3)
    done_column_id    TEXT,               -- NULL = 本看板没有完成列(纯分类)
    created_at        TEXT NOT NULL,
    tombstoned_at     TEXT                -- 墓碑 HLC 原文;⛔ 行永不物理删除(同 board_column)
);

CREATE INDEX idx_board_position ON board (position);

-- 种子看板(implicit genesis)。created_at 与种子列同值(board::SEED_COLUMNS)。
INSERT INTO board (id, title, position, landing_column_id, done_column_id, created_at, tombstoned_at)
VALUES ('tasks', '任务', 'a0', 'todo', 'done', '2026-08-24T00:00:00.000Z', NULL);

-- 种子看板不可删(⛔ 不带豁免:它装着 todo / done 两枚永不可删的列,跨空间移动恒落 todo)。
CREATE TRIGGER trg_board_seed_no_tombstone
BEFORE UPDATE OF tombstoned_at ON board
FOR EACH ROW
WHEN OLD.id = 'tasks' AND NEW.tombstoned_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '种子看板不可删除');
END;

-- 看板行永不物理删除(⛔ 不带豁免;codex 实现审一轮 H1)。种子看板的列 `board_id` 全是 NULL,
-- FK 保不住 'tasks' 这一行 —— 没有这只,一条 DELETE 就能让种子看板消失。
CREATE TRIGGER trg_board_no_delete
BEFORE DELETE ON board
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, '看板是史实,只可 tombstone 不可删行');
END;

-- 看板墓碑写者授权表(形照 0036 的 `sync_board_column_tombstone_apply`,理由见那里的长注):
-- 常态恒空;一枚墓碑「先记 oplog → 登记授权 → 改行 → AFTER 触发器当场消费」。
CREATE TABLE sync_board_tombstone_apply (
    board_id  TEXT NOT NULL PRIMARY KEY REFERENCES board(id),
    op_id     TEXT NOT NULL,                       -- 绑到具体那一枚 tombstone op
    from_hlc  TEXT,                                -- 可 NULL = 首次盖墓碑
    to_hlc    TEXT NOT NULL,
    mode      TEXT NOT NULL CHECK (mode IN ('apply_min', 'epoch_rebase'))
);

-- 墓碑 marker 只能由登记的 writer 改写(⛔ `sync_replay_active` 不参与,同 0036 ④)。
-- NEW IS NULL 恒拒(永不复活);等值 no-op 放行;其余必须有一行精确匹配、且 oplog 里真有那枚 op。
CREATE TRIGGER trg_board_tombstone_reject
BEFORE UPDATE OF tombstoned_at ON board
FOR EACH ROW
WHEN NEW.tombstoned_at IS NULL
  OR (NEW.tombstoned_at IS NOT OLD.tombstoned_at
      AND NOT EXISTS (
        SELECT 1 FROM sync_board_tombstone_apply a
        WHERE a.board_id = OLD.id
          AND a.from_hlc IS OLD.tombstoned_at
          AND a.to_hlc   IS NEW.tombstoned_at
          AND (   (a.mode = 'apply_min'
                   AND (a.from_hlc IS NULL
                        OR a.to_hlc < a.from_hlc COLLATE BINARY))
               OR (a.mode = 'epoch_rebase'
                   AND a.to_hlc > a.from_hlc COLLATE BINARY))
          AND EXISTS (SELECT 1 FROM oplog o
                      WHERE o.op_id = a.op_id
                        AND o.entity = 'board' AND o.kind = 'tombstone'
                        AND o.entity_id = OLD.id
                        AND o.hlc IS a.to_hlc)))
BEGIN
    SELECT RAISE(ABORT, '看板的墓碑只能由登记的 tombstone writer 改写');
END;

-- 授权行由触发器自己消费(AFTER,理由同 0036 ⑥:同时机多只触发器顺序未定义)。
CREATE TRIGGER trg_board_tombstone_consume
AFTER UPDATE OF tombstoned_at ON board
FOR EACH ROW
WHEN NEW.tombstoned_at IS NOT OLD.tombstoned_at
BEGIN
    DELETE FROM sync_board_tombstone_apply WHERE board_id = OLD.id;
END;

-- created_at 是出生字段(⛔ 不带豁免)。
CREATE TRIGGER trg_board_birth_immutable
BEFORE UPDATE OF created_at ON board
FOR EACH ROW
WHEN OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'board.created_at 是出生字段,不可改写');
END;

-- ---- ② board_column.board_id ------------------------------------------------------------
-- 灵感列(kind='idea')与系统列恒 NULL;非 NULL 只许在用户建的任务列上。
ALTER TABLE board_column ADD COLUMN board_id TEXT REFERENCES board(id)
    CHECK (board_id IS NULL OR (kind = 'task' AND system = 0));

-- ---- ③ 出生冻结:kind / system / board_id(⛔ 不带豁免) --------------------------------
DROP TRIGGER trg_board_column_birth_immutable;

CREATE TRIGGER trg_board_column_birth_immutable
BEFORE UPDATE OF kind, system, board_id ON board_column
FOR EACH ROW
WHEN OLD.kind IS NOT NEW.kind OR OLD.system IS NOT NEW.system OR OLD.board_id IS NOT NEW.board_id
BEGIN
    SELECT RAISE(ABORT, 'kind/system/board_id 是出生字段,不可改写');
END;

-- ---- ④ 归档只认「所在看板解析后的完成列」(带豁免) ---------------------------------------
DROP TRIGGER trg_item_seal_only_done;

CREATE TRIGGER trg_item_seal_only_done
BEFORE UPDATE OF sealed_at ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL AND OLD.sealed_at IS NULL
     AND (OLD.archived_at IS NOT NULL
          OR NOT EXISTS (
              SELECT 1
              FROM board_column c
              JOIN board b ON b.id = COALESCE(c.board_id, 'tasks')
              WHERE c.id = OLD.stage
                AND c.kind = 'task'
                AND c.tombstoned_at IS NULL
                AND b.tombstoned_at IS NULL
                AND b.done_column_id = c.id))
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '只有在所在看板「完成列」里、且不在回收站的卡可以归档');
END;

-- ---- ⑤ oplog 词汇:搬运表(裸表;origin 是生成列,列表点名避开) -------------------------
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
        -- 0043:非种子看板上的列走 create_in_board(五键 + board_id 的出生快照),种子看板
        -- 上的列照旧走五键 create —— 一枚列只有一种合法编码(multiboard-plan §2.3)。
        OR (entity = 'board_column' AND kind IN ('create', 'create_in_board', 'set_field', 'tombstone'))
        -- 看板(multiboard-plan §2.3):有出生事件、可改名可排序可删、两根角色指针。
        -- ⛔ 种子 'tasks' 不发 create、不可删;set_field 白名单 title | position |
        -- landing_column_id | done_column_id。
        OR (entity = 'board' AND kind IN ('create', 'set_field', 'tombstone'))
    )
);

INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq)
SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM oplog_carry;

DROP TABLE oplog_carry;

-- 索引与 append-only 触发器原样重建(0024/0028/0033/0035/0037/0041 同源)。
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
