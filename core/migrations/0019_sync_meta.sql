-- migration 0019: 同步元数据 sync_meta ——设备身份(device_id)+ HLC 时钟水位(last_hlc)。
--
-- 动机:sync-plan P1 第一笔债「device_id + HLC 时钟模块」——一切合并的前提。
--   * device_id:本设备的永久身份,首次启动由代码生成(ULID)后永不改变;
--     HLC 平局裁决、op 来源标记、水位向量的键都靠它。
--   * last_hlc:本机已发出/已见过的最大 HLC 时间戳(定长编码「13位hex毫秒-8位hex计数器」),
--     每次取号/观察随事务落盘。它是崩溃后的单调性背书:崩溃 + 时钟回拨同时发生时
--     内存时钟态已丢,重启从它恢复,保证永不发出倒退的时间戳(详见 clock.rs)。
--
-- key-value 单表(目前仅这两行),刻意不预插行:device_id 必须由代码生成,SQL 里
-- 没有随机源;首启初始化在 clock.rs::Clock::load(显式初始化,非静默默认值)。
--
-- 这是**新增**迁移,不改任何已应用迁移(见 memory「migration-trap」);真实库迁移后
-- 人工跑 PRAGMA foreign_key_check / integrity_check 验证。

BEGIN;

CREATE TABLE sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 设备身份是史实:一经生成永不改写、不许删除(0018 born_stage 同款哲学,存储层兜底)。
-- last_hlc 不冻结——它每次取号/观察都要更新,故触发器按行(key)甄别而非按表。
CREATE TRIGGER trg_sync_meta_device_id_frozen
BEFORE UPDATE ON sync_meta
FOR EACH ROW
WHEN OLD.key = 'device_id'
BEGIN
    SELECT RAISE(ABORT, '设备身份不可改写');
END;

CREATE TRIGGER trg_sync_meta_device_id_no_delete
BEFORE DELETE ON sync_meta
FOR EACH ROW
WHEN OLD.key = 'device_id'
BEGIN
    SELECT RAISE(ABORT, '设备身份不可删除');
END;

COMMIT;
