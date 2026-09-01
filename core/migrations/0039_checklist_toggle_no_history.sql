-- migration 0039: 勾一下方框不再长一版编辑历史 —— backlog 用户面 63。
--
-- 动机:561 起正文行首 `- [ ] ` 画成可点的方框,而点一下 = **整条正文写回** ⇒ 0014 那只
-- `trg_item_archive_on_edit` 照常把旧文归进 `item_revisions`。一个 8 项的清单从头勾到尾就是
-- 8 条只差一个 `x` 的历史版本,而历史**用户在卡片上看得见**(两端都有入口)。561 交付时把
-- 它记成「已知代价」,用户当面拍了修法,本迁移是那个修法的一半。
--
-- **判据刻意不放在 op 类型上,放在文本比对上**(用户拍的形):写入前在 Rust 侧算一句
-- 「旧文本 → 新文本 是不是纯勾选变更」(`core/src/checklist.rs::is_checklist_toggle_only`),
-- 是就在**本事务内**立起下面这面旗,让那只触发器跳过这一次。
--   ⭐ **同步 op 一个字不改** —— 发出去的仍是普通的 content `set_field`,旧版本客户端收到
--      照常应用(只是它自己那边会多归档一条)⇒ **混版零风险,不碰协议、不碰词汇表**。
--   ⭐ **本地写入与回放远端都盖住了**:三条写正文的路(`repo::update_item_content` /
--      `repo::rename_task` / `replay::apply_item_set_field` 的 content 臂)各经同一个 helper。
--      ⚠ 立账时以为是「同一处」,实读代码是**三处** —— 如实记在 progress-log。
--
-- **这是给一条拍过板的裁决开例外,故写清为什么**:0022 那份迁移里白纸黑字写着这只触发器
-- 「**刻意不豁免**」,理由 = `item_revisions` 是本地派生数据,回放远端编辑时本地照样长历史
-- (sync-plan §3.1)。那条理由今天仍然成立,本迁移**不推翻它** —— 豁免的不是「远端来的编辑」,
-- 是「这次编辑的内容只有几个勾变了」,**与 op 从哪来无关**:本地勾一下与回放对端勾的那一下,
-- 两边都跳过,各端的历史仍然各自完整、仍然对称。⛔ 别把这面旗读成第二个「回放豁免」。
--
-- **误判方向是有代价的,判据因此写窄**(见 checklist.rs 头注):判 false(该豁免没豁免)只是
-- 多存一版历史 = 退化成今天的行为;判 true 判错则是**永久少一版用户看得见的历史**,那是
-- 「原文永不被覆盖而不留历史」那条设计铁律的载体。
--
-- 形上的两处刻意:
--   * **不重建 items 表** —— 只 DROP + CREATE 这一只触发器(WHEN 多一个条件)。比 0022/0036
--     那两次整表重建便宜得多,也不碰任何列定义、索引、外键。
--   * 标志表**照 0022 `sync_replay_active` 的形**(单行、`PRIMARY KEY` + `CHECK (flag = 1)`
--     钉死至多一行值恒 1),置/清都在业务事务内,出错回滚即消失,不存在泄漏到正常路径的窗口。
--     ⛔ **别把它与 `sync_replay_active` 合并成一面旗**:那面旗的语义是「这些写来自另一个
--     权威来源,单机守护让路」,这面旗的语义是「这次编辑没有信息量,别记账」——两者的作用
--     范围、生命周期、谁有权立它都不同,合并会让任何一处置旗顺带获得另一处的豁免。
--
-- 这是**新增**迁移,不改任何已应用迁移(memory「migration-trap」);零数据变换、零表重建。
--
-- ⛔ **不写 BEGIN / COMMIT**:29 起走的是 runner 自管事务的新路径,它挂着 authorizer
-- 把事务控制三族(Transaction / Savepoint / Attach·Detach)全拒(db.rs 头注 + §7.0)——
-- 照 0022 那种「SQL 自带事务」的老形写,第一次跑就是「not authorized」(本轮真栽了一次:
-- 29 支 notes 测试**集体**红在 `open migrated db`,而红的位置离迁移很远)。

-- ---- 1) 单行「这次编辑只是勾选」标志表 ---------------------------------------
-- 空表 = 正常模式(照常归档);有那一行 = 本连接正在写一次纯勾选变更。
CREATE TABLE item_checklist_toggle (
    flag INTEGER NOT NULL PRIMARY KEY CHECK (flag = 1)
);

-- ---- 2) 归档触发器:WHEN 多一个豁免条件 ---------------------------------------
-- 与 0036 里那一份逐字相同,只在 WHEN 上加了最后一行。
DROP TRIGGER trg_item_archive_on_edit;

CREATE TRIGGER trg_item_archive_on_edit
BEFORE UPDATE OF content ON items
FOR EACH ROW
WHEN NEW.content <> OLD.content
     AND NOT EXISTS (SELECT 1 FROM item_checklist_toggle)
BEGIN
    INSERT INTO item_revisions (item_id, content, archived_at)
    VALUES (OLD.id, OLD.content, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

