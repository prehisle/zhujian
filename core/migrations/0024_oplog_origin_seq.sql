-- migration 0024: oplog 加 origin_seq —— 同步的「传输与水位轴」(sync-protocol §5.1/§7,P2-b)。
--
-- 三轴并存不互代:op_id(ULID)=身份、hlc=合并排序轴(LWW)、origin_seq=传输与水位轴。
-- 为什么必须有第三轴:HLC 不稠密,收端无法从 HLC 判断「中间还有没有没到的 op」;服务器
-- 信箱 TTL/溢出丢帧后,没有 gap 检测的水位会静默越过缺口——那条 op 从此全网只有源设备有、
-- 且永不再传,是无声的数据丢失。连续号让缺口可检、可等、可补:收端严格连续应用(只喂
-- watermark+1),水位 = 本机日志内每 origin 的 MAX(origin_seq),派生不存(项目铁律)。
--
-- origin 是虚拟生成列(substr(hlc, 24) = HLC 内嵌的 device_id;SQLite 1-based,对应
-- Rust 侧 &hlc[23..]):不落存储、恒不与 hlc 漂移。UNIQUE(origin, origin_seq) 是发射
-- 取号 MAX+1 的响亮兜底——取号的安全前提不是 append-only 本身,而是「进程内单写者
-- (write_locks 全局互斥)+ 取号与数据写同一事务」(sync-protocol §7);前提被破坏
-- (如未来多进程开同库)时撞唯一索引失败,不静默分叉。
--
-- oplog 带 append-only 触发器(0020),backfill 需 UPDATE → 整表重建(0021/0022 同
-- 手法;这是新增迁移,不改任何已应用迁移)。既有行按 hlc 序 ROW_NUMBER 补号。前提
-- (迁移前由真实库副本探针核验):0024 落地时全部真实库的 oplog 只含本机 op(P2 未
-- 开闸,replay 只在测试的 fresh DB 里跑过);即便库里已有多 origin,PARTITION BY 也
-- 各自成序,与「per-origin seq 序 == hlc 序」不变量一致(本机日志恒是每 origin 的
-- 连续前缀时,补出的号 == 源设备自己的编号)。
--
-- oplog 无外键出入,不需要 0022 的 PRAGMA foreign_keys=OFF 序曲。

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
    )
);

INSERT INTO oplog_new (op_id, hlc, entity, entity_id, kind, payload, origin_seq)
SELECT op_id, hlc, entity, entity_id, kind, payload,
       ROW_NUMBER() OVER (PARTITION BY substr(hlc, 24) ORDER BY hlc)
FROM oplog;

DROP TABLE oplog;
ALTER TABLE oplog_new RENAME TO oplog;

-- 0020 的两索引原样重建;第三个 = 水位轴唯一性兜底(见抬头)。
CREATE UNIQUE INDEX idx_oplog_hlc ON oplog (hlc);
CREATE INDEX idx_oplog_entity ON oplog (entity, entity_id);
CREATE UNIQUE INDEX idx_oplog_origin_seq ON oplog (origin, origin_seq);

-- append-only 铁律原样重建(0020):op 是史实,不许改写、不许删除。
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

COMMIT;
