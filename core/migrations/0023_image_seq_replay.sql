-- migration 0023: 「图N」取号 op 化的存储层配套 —— sync-plan P1 债表最后一项。
--
-- 多写者下「编号全局唯一 / 双端离线取号 / 编号永不改指」三者无法三全(sync-plan §3.1),
-- 拍板放宽一处:同条目双端并发取到同一个「图N」时,HLC 大者**确定性顺延**重取新号。
-- 顺延的落实在 replay.rs::reconcile_item_images——有效编号是「该条目全部 image_add op
-- 按 HLC 升序逐条分配」的纯函数,行上的 seq 只是它的缓存;被翻案的本地行要 UPDATE seq。
--
-- 本迁移做两件事:
--
--   1. trg_item_image_immutable 加回放豁免(0016 立的「图只增删不改」单机铁律,放宽的
--      **只有回放事务里改 seq 这一处**):WHEN 改为「非回放,或回放却动了 seq 以外的列」
--      都照样 ABORT——比 0022 对 items 的整只豁免更窄,因为这里没有别的合法回放写。
--      (0022 手法同源:sync_replay_active 单行标志表,置/清都在回放事务内。)
--
--   2. item_image_counter 一次性治理:补缺行 + 把落后于行上最大编号的 counter 抬平。
--      顺延纯函数的遗产下界(floor = 最早一条 add op 的 seq - 1)依赖不变量
--      「counter ≥ 该条目一切已用编号」;单机路径归纳成立,但手工/损坏数据可能留下
--      stale counter——在此钉死,此后由取号/回放两条路径共同维护(codex 评审加固)。
--      P2 引导快照落库后必须做同样校验(契约记在 sync-plan §3.5)。
--
-- 触发器 DROP + 重建是**新增**迁移(不改已应用的 0016,memory「migration-trap」);
-- 数据零变换(counter 治理对健康库是 no-op)。真实库迁移后核验 integrity/FK + 行数零变。

BEGIN;

DROP TRIGGER trg_item_image_immutable;

-- 图只增删不改,唯一例外:回放事务里的「图N」顺延只许改 seq(其余列动一下都 ABORT)。
CREATE TRIGGER trg_item_image_immutable
BEFORE UPDATE ON item_image
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM sync_replay_active)
     OR NEW.id IS NOT OLD.id
     OR NEW.item_id IS NOT OLD.item_id
     OR NEW.data IS NOT OLD.data
     OR NEW.mime IS NOT OLD.mime
     OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'item_image 只追加 / 删除,不可修改(换图请删旧加新;回放顺延仅改 seq)');
END;

-- counter 治理①:行有图、counter 却没行(正常路径不会发生,防手工/损坏数据)。
INSERT INTO item_image_counter (item_id, last_seq)
SELECT item_id, MAX(seq) FROM item_image
WHERE item_id NOT IN (SELECT item_id FROM item_image_counter)
GROUP BY item_id;

-- counter 治理②:counter 落后于行上最大编号(同上,钉死「counter ≥ 一切已用编号」)。
UPDATE item_image_counter
SET last_seq = (SELECT MAX(seq) FROM item_image
                WHERE item_image.item_id = item_image_counter.item_id)
WHERE last_seq < (SELECT MAX(seq) FROM item_image
                  WHERE item_image.item_id = item_image_counter.item_id);

COMMIT;
