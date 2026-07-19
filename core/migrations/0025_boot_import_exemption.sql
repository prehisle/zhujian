-- migration 0025: 引导导入的两只 INSERT 守护触发器补回放豁免 —— P2-f(sync-protocol §6.2)。
--
-- 0022 给 items 的守护触发器分「加豁免 / 原样保留」两批时,论证「后三只按回放契约
-- 永不触发」——那是对**逐 op 回放**(replay.rs::apply_remote_op)说的:create 出生
-- 快照确实恒 sealed_at NULL、恒 stage == born_stage。但引导(§6.2「快照直通 + 表级
-- 导入合并」)INSERT 的是**终态行**,三种合法史实必然触雷:
--
--   * 已归档成就:sealed_at 非空 → trg_item_no_insert_sealed ABORT;
--   * 0018 之前的存量行:born_stage NULL(老数据「未知不回填」是拍板的史实语义)
--     → trg_item_born_stage_required ABORT;
--   * 转过待办的行:born_stage(如 inbox)≠ 当前 stage(如 todo)→ 同上 ABORT。
--
-- 故给这两只 INSERT 守护补上与 0022 同款的豁免 WHEN:导入发生在置了
-- sync_replay_active 标志的单事务内(boot.rs),放行终态行;单机路径照拦不松。
-- trg_item_born_stage_frozen(UPDATE 守护)不动——导入只 INSERT,永不改写出生态。
--
-- 触发器 DROP + 重建是**新增**迁移(不改已应用的 0022,memory「migration-trap」);
-- 纯触发器改写,零数据变换。真实库迁移后核验 integrity/FK + 行数零变。

BEGIN;

DROP TRIGGER trg_item_no_insert_sealed;

-- 0017:禁生而归档(单机路径)。回放豁免下放行——引导导入的快照行里,归档成就
-- 就是生而带 sealed_at 的终态(逐 op 回放的 create 快照仍恒 NULL,契约不变)。
CREATE TRIGGER trg_item_no_insert_sealed
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '新条目不能直接带归档标记');
END;

DROP TRIGGER trg_item_born_stage_required;

-- 0018:出生态必填且如实(单机路径)。回放豁免下放行——快照行的 born_stage 是
-- 别机的史实原样搬运:NULL(0018 前遗产)与 ≠ stage(转过待办)都合法。
CREATE TRIGGER trg_item_born_stage_required
BEFORE INSERT ON items
FOR EACH ROW
WHEN (NEW.born_stage IS NULL OR NEW.born_stage <> NEW.stage)
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '新条目必须如实记录出生态(born_stage = 插入时的 stage)');
END;

COMMIT;
