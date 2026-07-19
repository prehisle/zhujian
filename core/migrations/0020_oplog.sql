-- migration 0020: 本地操作日志 oplog ——sync-plan P1「oplog 骨架」的存储层。
--
-- 动机:同步的数据层是自研字段级 LWW oplog(sync-plan §3.1)。全部写操作在编排层
-- 与数据写入**同一事务**追加一条 op 进本表;它既是将来离线追赶的弹药库(每台设备持久化
-- 自己见过的全部 op),也是纯本地阶段的又一层「数据永不丢」。
--
--   * op_id:ULID,op 的**身份**(去重、水位向量数「收到第几条」);
--   * hlc:HLC 时间戳的定长编码「13位hex毫秒-8位hex计数器-device_id」(clock.rs),
--     **字典序 == 逻辑序**,是 LWW 的排序轴;设备来源内嵌其中(第 24 字符起),
--     不另设列。每次追加取一次号,故全局唯一(UNIQUE 索引兜底);
--   * entity / entity_id:哪类对象的哪一个(link 的 entity_id = "item_id:topic_id");
--   * kind:词汇表定死(见 CHECK)——item/topic 走 create/set_field/tombstone,
--     link 走 link_add/link_remove(OR-set 语义收在合并层),image 走
--     image_add/image_tombstone(图片字节走旁路,op 只带元数据);
--   * payload:JSON。create=出生快照,set_field={"field","value"},其余各自元数据。
--
-- 刻意不做的:不用触发器捕获(op 承载命令语义,不是行级 CDC);item_revisions /
-- items.updated_at 是本地派生/簿记,不进 op;topic tombstone 不展开级联的 link 死亡
-- (FK 级联是各端共享的 schema 知识,回放同样生效)。
--
-- append-only 铁律(0014 item_revisions 同款哲学,存储层兜底):op 是史实,
-- 不许改写、不许删除。将来若做压缩(compaction),由那时的迁移显式调整触发器。

BEGIN;

CREATE TABLE oplog (
    -- 非 INTEGER 的 PRIMARY KEY 在 SQLite 里不自带 NOT NULL,显式兜底(codex 评审)。
    op_id     TEXT NOT NULL PRIMARY KEY,
    hlc       TEXT NOT NULL,
    entity    TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    kind      TEXT NOT NULL,
    -- 坏 JSON 不许进史册:正常路径走 oplog::append(serde 序列化),这是绕行路径的兜底。
    payload   TEXT NOT NULL CHECK (json_valid(payload)),
    CHECK (
        (entity IN ('item', 'topic') AND kind IN ('create', 'set_field', 'tombstone'))
        OR (entity = 'link' AND kind IN ('link_add', 'link_remove'))
        OR (entity = 'image' AND kind IN ('image_add', 'image_tombstone'))
    )
);

-- 字典序 == HLC 逻辑序:同步/回放按它扫;取号全局唯一,UNIQUE 是完整性兜底。
CREATE UNIQUE INDEX idx_oplog_hlc ON oplog (hlc);
-- 按对象回看它的 op 流(合并、测试断言都走这)。
CREATE INDEX idx_oplog_entity ON oplog (entity, entity_id);

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
