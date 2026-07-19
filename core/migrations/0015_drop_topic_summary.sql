-- migration 0015: 删掉 topics.summary 死列。
--
-- 背景:summary(主题「备注」)是早期 AI「知识结构」设想的遗留字段。㉚ 起「主题」对用户
-- 重定位为「标签」(轻量分类),summary 在 UI 已停用、后端恒写空串、前端从不读取;㉝ 一并
-- 清理。这是纯删列,不改任何语义、不动任何有效数据(summary 早已无有效内容)。
--
-- 做法:summary 是普通列,全库无索引/触发器/外键/生成列/视图依赖它(仅 0001 的列定义引用),
-- 故 SQLite 3.35+ 的 ALTER TABLE ... DROP COLUMN 可直接删,无需重建表。bundled SQLite
-- (rusqlite 0.32 features=["bundled"])远高于 3.35。其余列/约束/索引/行数据完全不变。
-- 真实库迁移后可核验:PRAGMA integrity_check;  SELECT COUNT(*) FROM topics;(行数应不变)

BEGIN;

ALTER TABLE topics DROP COLUMN summary;

COMMIT;
