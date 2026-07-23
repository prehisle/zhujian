-- migration 0030: 完成时刻轴 done_at ——「已完成」任务最近一次真正进入 stage='done' 的时刻。
--
-- 动机:任务看板「已完成」列看不到「什么时候完成的」(用户点名的痛点)。归档册按 sealed_at
-- 分组是「归档日」而非「完成日」,批量归档会把一周的活压成归档那天,答不准「何时干完」。
--
-- 语义(与 sealed_at 的根本差异):
--   * sealed_at 既是同步时间戳**又是活性轴**(大量 WHERE sealed_at IS NULL 过滤 + 冻结触发器);
--     done_at 只是**时间戳、不是轴**——不进位置唯一索引、不冻结行、不加 IS NULL 守卫。
--   * **只在「stage 真正变成 done」那条边盖一次 now,永不主动清除**:撤回(done→todo)、
--     seal/unseal、回收站还原、软删都不碰它,故归档后完成时刻天然保住。
--   * **存储可空**(NULL = 完成时刻未知:本功能上线前已完成的老卡,同 born_stage「未知不回填」);
--     但它的 **set_field 协议值非空**(只增不清,replay 拒 null,防「NaN月NaN日」与静默清空)。
--   * 生而 NULL:任何 create 出生快照都不带 done_at(oplog/epoch/move 的 create payload 均不含),
--     apply_item_create 的 INSERT 列清单也不列它 → 列默认 NULL。下方触发器把「生而 NULL」升为
--     存储级不变量(单机路径拦、回放/引导豁免放行终态行,同 0025 对 sealed/born_stage 的做法)。
--
-- 跨版本同步政策(db.rs 迁移作者规则 M7):**oplog 词汇新增 done_at set_field 字段——协议
-- 变化**。**单版发布**(2026-07-22 用户拍板:推广早期用户少、双端自控,不背两版发布的中间
-- 过程;达量后新同步字段才值得分阶段——见 memory `single-phase-until-scale`)——reader
-- (认识/回放/压实/引导)与 writer(进 done 盖 done_at)+ UI 合成**一版**发出。
--
-- 混版窗口两个方向,都非破坏,但不对称(codex v2 复审 M1,诚实记):
--   * 新端发 → 旧端收:旧端判 UnsupportedVocab、挂起该 origin 直到升级,升级后队列里的
--     done_at op 照常应用 = **升级即补齐**(engine 既定版本偏斜自愈)。
--   * 旧端完成 → 新端收:旧 writer 完成任务只发 stage/position(它压根不认识 done_at),
--     新端**不从 stage=done 反推**完成时刻(反推跨设备非确定、会分叉)→ 该任务 done_at 留
--     NULL = **未知**(与老卡同路:看板不显「完成于」、归档册回落 sealed_at 分组)。这半边
--     **升级不补**(没有可补的 op),且撤回后旧端重完成会让 done_at 停在上一次值。**非破坏、
--     不丢数据**(done_at 只是展示轴,非活性/身份/同步轴),仅完成时刻在窗口内可能未知/偏旧。
-- 故 **发布须提示两端尽快一起更新**,把这半边的窗口压到最短。
--
-- 新增迁移,不改任何已应用迁移(memory「migration-trap」)。0029 起迁移文件只写事务体:
-- 无 BEGIN/COMMIT/PRAGMA user_version(runner 所有);触发器体的 BEGIN…END 不是事务控制。
-- 真实库迁移后核验 PRAGMA foreign_key_check / integrity_check + 行数零变。

ALTER TABLE items ADD COLUMN done_at TEXT;

-- 生而 NULL(单机路径):新条目不能直接带完成时间——done_at 只由「进入已完成」盖。
-- 回放/引导豁免(NOT EXISTS sync_replay_active):逐 op 回放的 create 快照本就不带 done_at;
-- 引导(boot.rs)在置了 sync_replay_active 标志的单事务内 INSERT 终态行,已完成的卡带非空
-- done_at 是合法史实,放行。镜像 0025 对 trg_item_no_insert_sealed 的豁免。
CREATE TRIGGER trg_item_no_insert_done_at
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.done_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '新条目不能直接带完成时间(done_at 由进入「已完成」时盖)');
END;
