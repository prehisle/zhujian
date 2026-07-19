-- migration 0018: 出生态 born_stage ——「这条是生而为灵感,还是生而为任务」的史实。
--
-- 动机:灵感流转统计(每周捕获多少灵感 / 灵感转待办比例)。转待办=翻 stage 零副本,
-- 不留痕;看板「新建任务」直接生成任务态——所以一条现在是 todo 的条目,分不清它是
-- 灵感转来的还是直接建的。补一列出生态,统计才有分母。
--
-- 设计:
--   * 插入时必须如实记录(触发器强制 born_stage = 插入时的 stage),此后永不改写
--     (「出生态是史实」——0014「不可变性是历史级」哲学的自然延伸);
--   * 0018 之前的老行保持 NULL = 未知,不回填不猜(现存灵感「几乎肯定」生而为灵感,
--     但撤回功能存在,「几乎肯定」不是史实)。统计诚实排除未知行,从本迁移起积累;
--   * 不建流转日志/事件表:sync-plan 的 oplog 将来会带完整流转史,现在为两个统计数
--     建事件表是过度建设。统计本身全是派生数,只算不存。
--
-- 这是**新增**迁移,不改任何已应用迁移(见 memory「migration-trap」);真实库迁移后
-- 人工跑 PRAGMA foreign_key_check / integrity_check 验证。

BEGIN;

ALTER TABLE items ADD COLUMN born_stage TEXT;

-- 新行必须如实记录出生态。born_stage = 插入时的 stage,由此自动落在 stage 的六个
-- 合法值里(stage 自有 CHECK),无需再重复一个值域 CHECK。
CREATE TRIGGER trg_item_born_stage_required
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.born_stage IS NULL OR NEW.born_stage <> NEW.stage
BEGIN
    SELECT RAISE(ABORT, '新条目必须如实记录出生态(born_stage = 插入时的 stage)');
END;

-- 出生态是史实,永不改写;NULL 的老行也保持未知,不许事后补猜。
CREATE TRIGGER trg_item_born_stage_frozen
BEFORE UPDATE OF born_stage ON items
FOR EACH ROW
WHEN OLD.born_stage IS NOT NEW.born_stage
BEGIN
    SELECT RAISE(ABORT, '出生态是史实,不可修改');
END;

COMMIT;
