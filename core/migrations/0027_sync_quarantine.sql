-- migration 0027: typed poison 持久隔离表(epoch-plan §4)。
--
-- 动机:live 收端此前对一切 apply Err 一律内存态挂起+不动点重试——毒 op(已知词汇下
-- 的形态/值域/状态型非法,OpError::InvalidOp)混在「依赖未到」「版本偏斜」里空转,
-- 重启即忘、重连再吸。分型(工序1)之后,InvalidOp 落**持久隔离**:
--
--   * 每 origin 一行(PRIMARY KEY):存**首个被拒 op 的完整规范化 RemoteOp**——被拒
--     op 不进 oplog、此后帧到即丢、原始帧会从服务器信箱消失、源设备可能永不重发,
--     不存则升级重验无材料(codex 二轮裁决);
--   * relay_from_first / relay_from_last:UI「origin + relay-from 双坐标」跨重启兑现
--     (不得断言 origin 设备 = 作恶发送者,吊谁由运营者依两坐标判断);
--   * op_blob 为 NULL = 单 op 超限(> 256 KiB),只存 op_sha256 指纹,标「不可自动
--     重验」要人工;CHECK 保证两者至少存一;
--   * validator_ver:隔离时的校验器版本,升级重验状态机(engine)按它筛;
--   * 资源上界(行数 ≤ 64 / 总字节 ≤ 16 MiB)与 poison-breaker(fail-closed,
--     sync_meta KV『poison_breaker』)在 engine 层执行,表只是载体;
--   * 设备本地簿记,不进 oplog、不随快照导出(make_snapshot 只 VACUUM 主库——快照
--     含此表无害:导入端 fresh 库该表为空,表级导入白名单不含它)。
--
-- 纪元压实(epoch-plan §2.3)会整表清空并复位 breaker:新纪元不许带着已满的隔离
-- 额度启动。

BEGIN;

CREATE TABLE sync_quarantine (
    origin           TEXT PRIMARY KEY,
    op_id            TEXT NOT NULL,
    origin_seq       INTEGER NOT NULL,
    op_blob          BLOB,
    op_sha256        TEXT,
    reason           TEXT NOT NULL,
    error_stage      TEXT NOT NULL CHECK (error_stage IN ('shape', 'apply')),
    relay_from_first TEXT,
    relay_from_last  TEXT,
    validator_ver    INTEGER NOT NULL,
    at               TEXT NOT NULL,
    CHECK (op_blob IS NOT NULL OR op_sha256 IS NOT NULL)
);

COMMIT;
