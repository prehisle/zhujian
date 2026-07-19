-- 标签颜色(可选,同步字段)。看板卡片的标签 chip 按此着色,便于一眼定位——用户手动
-- 给少数热标签点色,默认无色(纸墨本色)。
--
-- 语义与 title 同款:走 oplog `set_field` + 字段级 LWW 回放,跨设备同步。可空 = 无色
-- (create op 不带 color 键 → 回放 INSERT 不列此列 → NULL;出生态审计的 winner 也落 NULL)。
-- 表层只当不透明字符串;颜色格式(#RRGGBB)由命令层(notes::set_topic_color)校验,
-- 与 due_on/priority 等可空 LWW 字段是同一条已走熟的路(可设、可清)。
ALTER TABLE topics ADD COLUMN color TEXT;
