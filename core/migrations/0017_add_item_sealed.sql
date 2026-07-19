-- migration 0017: 成就归档轴 sealed_at ——「已完成」任务的正经存档(历史成就)。
--
-- 与回收站(archived_at)彻底分开的第二根轴,概念隔离:
--   * 回收站 = 「我不要了」(两段式删除的前半,可还原、可彻底删);
--   * 归档   = 「我干完了、留着看」(可查、不可删的史实,成就册)。
-- 二者互斥:只有活跃(未进回收站)的 done 任务可归档;归档后整行冻结(除「取消归档」
-- 外禁一切 UPDATE),硬删/软删一律 ABORT——「史实不删」是 0014「历史级不可变」哲学的
-- 自然延伸。取消归档 = sealed_at 置回 NULL、position 重排到 done 列尾(镜像
-- restore_task),条目回到看板「已完成」列;想删走正常两段式——删除主权仍在用户手里,
-- 只是要多走一步(防冲动删)。
--
-- 命名刻意避开 archive_*:archived_at 已被回收站占用,内部标识用 sealed(封存),
-- 用户可见中文才叫「归档」。
--
-- position:归档行冻结原 position(同回收站冻结 stage),但必须从 partial unique 索引
-- 中排除——否则活跃 done 卡的 MAX+1 会撞上归档行的旧号。故重建 idx_items_stage_position
-- 加 sealed_at IS NULL 条件;取消归档时由 repo::unseal_task 重排到列尾。
--
-- 这是**新增**迁移,不改任何已应用迁移(见 memory「migration-trap」);真实库迁移后
-- 人工跑 PRAGMA foreign_key_check / integrity_check 验证。

BEGIN;

ALTER TABLE items ADD COLUMN sealed_at TEXT;

-- 归档行退出「活跃列内 position 唯一」的约束范围(冻结,不占活跃号段)。
DROP INDEX idx_items_stage_position;
CREATE UNIQUE INDEX idx_items_stage_position
    ON items (stage, position)
    WHERE archived_at IS NULL AND sealed_at IS NULL AND position IS NOT NULL;

-- 条目不能生而归档:归档是 done 之后的动作,不是初始态。
CREATE TRIGGER trg_item_no_insert_sealed
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '新条目不能直接带归档标记');
END;

-- 只有「已完成」且不在回收站的任务可归档(两轴互斥在此守住)。
CREATE TRIGGER trg_item_seal_only_done
BEFORE UPDATE OF sealed_at ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL AND OLD.sealed_at IS NULL
     AND (OLD.stage <> 'done' OR OLD.archived_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, '只有「已完成」且不在回收站的任务可以归档');
END;

-- 已归档 = 史实,整行冻结:除「取消归档」(sealed_at 置回 NULL)外禁一切修改
-- (含改归档时间戳、改标题、设截止/优先级、移入回收站)。
CREATE TRIGGER trg_item_sealed_frozen
BEFORE UPDATE ON items
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '已归档的成就不可修改:请先取消归档');
END;

-- 已归档不可删除(硬删 ABORT;软删已被上面的冻结触发器挡)。
CREATE TRIGGER trg_item_sealed_no_delete
BEFORE DELETE ON items
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '已归档的成就不可删除:先「取消归档」回看板,再走回收站');
END;

COMMIT;
