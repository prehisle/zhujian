-- migration 0037: oplog 词汇表认识 `board_column` —— board-columns-plan B-c(第 1 段)。
--
-- 0036 只落了物理形(表 + 六种子 + FK + 守护),**刻意不接任何新实体词汇**
-- (plan §8.1-1 十轮定形:「B-b 保持纯 schema checkpoint」)。于是那一版的库里造不出
-- 任何一枚 `board_column` op,0036 里 ④ 那只墓碑守护的肯定半边**结构上不可达**。
-- 本条把词汇这一面接上:列的名称 / 顺序 / 增删从此是同步事实。
--
-- ⚠ 词汇表这一面是 `entity_registry` 那十一个具名面的**第一面**,而它的比对是
-- `Match::Exact` + 反向探针(「进了 CHECK 却没在 ENTITIES 加行」当场红)⇒ **本条落地的
-- 同一轮必须把十一格全部填满**:catalog 核心表 / 压实指纹 / 压实基线 / 引导导入 /
-- 墓碑复活审计 / 无背书行 / 依赖前置 / 收敛指纹 / 回放分发臂 / op 形状校验。
-- ⛔ 别只推这条 SQL 就走。
--
-- 三种 kind,照 topic 的形(plan §3):
--   create      出生快照 {title, kind, system, position, created_at}
--   set_field   白名单 **只有 title | position**(kind/system/created_at 是出生字段,禁 set)
--   tombstone   payload {};`tombstoned_at` = 该 op 的 **HLC 原文**,apply 层取 min
-- ⛔ **六个种子不发 create**(plan §7.1a):`inbox`/`filed` 是真 schema-owned、永无任何 op;
--    四个 task 种子是 **schema-seeded implicit genesis** —— 不发 create,但此后
--    title / position / tombstone 全走普通 op(不变量 2:它们可改名、可排序、可删)。
--
-- 跨版本同步政策(每条新迁移必须声明,见 db.rs 头「迁移作者规则」):
--   **oplog 词汇新增 `board_column` 实体 —— 协议变化**,走 db.rs 那三选一里的
--   「**先发兼容 reader、下一版才开 writer**」(= plan §8 的 V1/V2 工序)。
--   本条是 reader 侧的一半:v37 端认识 board_column op,但**开不开 writer 由 B-e 那道
--   发送端闸说了算**,而 B-f 到 V2 才给用户入口。
--   ⚠ 混版窗口的代价与 0035 逐字同构:新端发 board_column op → 旧端 validate_op_shape
--   落词汇表外 = UnsupportedVocab,**挂起该 origin 直到升级**(水位是 per-origin、全词汇
--   共享的 ⇒ 该 origin 后续即使是它认识的 item op 也一起停)。反方向零影响。
--   ⛔⛔ 真正比 0035 重的那一格**不在这条迁移里**:item op 的 `stage` 携带自定义列 id 时,
--   旧端归的是 `InvalidOp` = **per-origin 持久隔离**(比挂起重得多)。那一格由 §4 的分型
--   改判(B-c 第 2 段)+ §5 的发送端闸(B-e)一起兜,**本条一个字都不改 item 的分型**。
--
-- 0029 起迁移文件只写事务体:无 BEGIN/COMMIT/PRAGMA user_version(runner 自有事务与版本号,
-- 事务体内的事务控制会被 SQLite authorizer 拒)。这是**新增**迁移,不改任何已应用迁移
-- (见 memory「migration-trap」)。真实库迁移后人工跑 foreign_key_check / integrity_check。
--
-- ---------------------------------------------------------------------------------------
-- ⛔⛔ **不能照 0035 抄那条「建 oplog_new → 拷 → DROP oplog → RENAME 顶上」的老手法**
-- ---------------------------------------------------------------------------------------
-- 0036 起 `board_column` 上有一只**跨表引用 oplog** 的触发器
-- (`trg_board_column_tombstone_reject`:墓碑授权必须有那一枚 op 背书,plan §2.3 八轮定形)。
-- 而 `ALTER TABLE … RENAME` 在非 legacy 模式下会**重解析整个 schema**,RENAME 那一刻
-- `oplog` 正好不存在 ⇒
--   `error in trigger trg_board_column_tombstone_reject: no such table: main.oplog`
-- ⇒ 整条迁移当场失败。**476 已经栽过同一句**:`epoch::compact` 因此改成了「先 DROP、
-- 再用最终名建」,并在那儿留了一行「同一件事会咬到 B-c」的警告。就是这里。
--
-- 本条同法,只是多一步 —— compact 的基线早在内存里,迁移却要保住全部历史 op:
--   ① 七列搬进一张**裸的**搬运表(无 CHECK / 无索引 / 无触发器,它只是搬运工)
--   ② DROP oplog  —— ⚠ `DROP TABLE` 本身**不重解析** schema(476 实测:compact 那条
--      DROP 照跑不误),故那只引用 oplog 的触发器不碍事
--   ③ **直接用最终名 `oplog`** 建新表(全程无 RENAME ⇒ 无重解析)
--   ④ 灌回、删搬运表、重建索引与两只 append-only 触发器
-- ⚠ **在 oplog 缺席的那个窗口里别碰 `board_column.tombstoned_at`** —— 那只触发器会当场
--   报「no such table」。本条不碰,将来在这中间插语句的人要先读这段。
-- ⚠ 代价照实记:比老手法**多一次全表拷贝**(carry 一次 + 灌回一次)。一次性迁移,认了。
--
-- ⚠️ 下方 `CREATE TABLE oplog` 的表体文本是新的单一 DDL 真相源:`epoch::OPLOG_TABLE_DDL`
-- 与它**逐字同源(含语句内注释)**——压实现场的规范化 sqlite_schema 比对拒漂移,
-- 改这里必同步改那里。

-- ---- ① 搬运表(裸表;origin 是生成列,列表点名避开) ---------------------------------
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

-- ---- ② DROP(索引与两只 append-only 触发器随表一并消失,下方原样重建) ---------------
DROP TABLE oplog;

-- ---- ③ 用最终名重建(⛔ 不是 oplog_new + RENAME,理由见上方长注) ---------------------
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
        OR (entity = 'image' AND kind IN ('image_add', 'image_tombstone'))
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

-- ---- ④ 灌回 + 收工 ------------------------------------------------------------------
INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq)
SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM oplog_carry;

DROP TABLE oplog_carry;

-- 索引与 append-only 触发器原样重建(0024/0028/0033/0035 同源)。
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
