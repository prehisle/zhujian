-- migration 0028: 空间名跨端同步(space-name-sync-plan §3/§4.1)。
--
-- 两件事:
-- ① oplog 词汇表加 `space` 实体(唯一 kind = set_field)——空间 profile 是**无 create
--    的单例 LWW 寄存器**(entity_id 恒 'profile'):并发首次命名若走 create 会撞行
--    进 quarantine,无 create 的 upsert 寄存器并发 set_field 走字段级 LWW 天然收敛。
--    CHECK 改动须整表重建(0024 同手法:create-new → copy → drop → rename → 重建
--    索引/触发器;既有行逐字节原样搬,op_id/hlc/origin_seq 全保,不重编号)。
--    ⚠️ 本表体文本是新的单一 DDL 真相源:epoch::OPLOG_TABLE_DDL 与它**逐字同源
--    (含语句内注释)**,压实现场规范化 sqlite_schema 比对拒漂移——改这里必同步改那里。
-- ② 新建 `space_profile` 物化单行表(状态⟺日志双重审计的状态侧)。
--    sync_meta['space_name'] 自此退役:存量值由开库常驻自愈步(spaces::
--    heal_legacy_space_name)补发进 op 流后删除,本迁移不动它(补发需要 HLC 取号,
--    SQL 层做不了;自愈步可重入,见 §5)。
--
-- ③ user_version 在本事务内自设(§4.1 runner 崩溃窗闭合):迁移执行器是
--    「execute_batch → 另 pragma 写版本」两步,COMMIT 后、pragma 前崩溃会让重启
--    重跑本非幂等迁移(CREATE 撞表直接 Err,连自愈步都到不了)。user_version 写
--    DB 头、随事务原子提交;执行器事后的 pragma 只是冗余幂等。
--
-- oplog 无外键出入,不需要 PRAGMA foreign_keys=OFF 序曲。

BEGIN;

CREATE TABLE oplog_new (
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
    )
);

INSERT INTO oplog_new (op_id, hlc, entity, entity_id, kind, payload, origin_seq)
SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM oplog;

DROP TABLE oplog;
ALTER TABLE oplog_new RENAME TO oplog;

-- 索引与 append-only 触发器原样重建(0024 同源)。
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

-- 空间 profile 物化表(恰零或一行):name NULL = 显式清名(规范表示,压实基线
-- 「行存在就合成一条 op,含 value:null」——见 space-name-sync-plan §4.4)。
CREATE TABLE space_profile (
    key   TEXT PRIMARY KEY CHECK (key = 'profile'),
    name  TEXT
) WITHOUT ROWID;

PRAGMA user_version = 28;

COMMIT;
