-- migration 0038: 留言已读水位(item_comment_seen)—— backlog 用户面 38「留言的未读」。
--
-- 动机:卡片上有 `💬 N` 徽章(0035),但「有没有**新**留言」无从判起 —— `item_comment`
-- 只有 create | tombstone 两种 op、没有任何读位。这张表给每条目记一格「本机看到哪儿了」,
-- 徽章据此点亮「未读」态。**应用内红点,不是系统通知**(后者是另一件事,见 backlog 39)。
--
-- **性质:纯本地用户状态**(同类是 localStorage 那族「本机偏好/状态」,不是 0032 那种
-- 可重建派生缓存 —— 「读没读过」丢了重建不出来,只能保守归「已读」):
--   ① **不进 oplog、不进同步、不进 strict_battery 审计、不进 spaces::CORE_TABLES**。
--      「A 机读过」不等于「B 机读过」,这格状态天生就不该跨端 —— 故本迁移完全不动协议词汇表。
--   ② **刻意不进 strip_derived_from_snapshot**(与 0032 相反,boot.rs 那儿有签字):
--      它不是可重建缓存,剥了 = 恢复出的库全条目变「未读」满屏误报;不剥则加密备份
--      自然携带、恢复自然回。引导快照那条路收端本就按 CORE_TABLES 白名单导入(不导它),
--      供端多带的几十字节无所谓。
--   ③ **收端引导导入完成后回填成「全部已读」**(boot::import_attached 尾):历史留言的
--      追赶不是「新消息」,新设备落地满屏红点是误报。下面的存量回填同理。
--
-- 水位轴 = **留言 id(ULID)的 TEXT 全序**,「未读」= 存在 `id > seen_id` 的留言。
-- 为什么不用 created_at:它是发端时钟,**迟到到达**(对端早发、同步晚到)的留言会落在
-- 水位之下被漏报;而水位只推进到「本机实际见过的最大 id」,迟到留言只要没被见过、其 id
-- 大于已见最大者就会点亮 —— per-origin 按序传输(oplog origin_seq)保证同一台设备的留言
-- 不会乱序到达。诚实边界(签字,不是疏忽):**三台以上设备 + 发端时钟偏差**下,后到达的
-- 更小 id 会被漏报一次;后果只是红点少亮一回,下一条任何新留言到达即自愈 —— 这是徽章
-- 装饰,不是数据,不为它建到达序簿记(那要给同步回放加钩子,复杂度不成比例)。
--
-- 形上的三处刻意:
--   * `seen_id` **无 FK**:水位是「读到哪」的标尺,不指向一条活留言 —— 若 CASCADE 跟着
--     留言走,对端删掉最新那条会把水位整行带走,剩下的旧留言全体复活成「未读」(误报)。
--   * `item_id` 有 FK CASCADE:条目死则水位随之走(同 0032 跟 item_image 的形),
--     生命周期零手写。
--   * CHECK 形与 item_comment.id 同(26 位 Crockford):水位收的就是那张表的 id 值域。
--
-- 跨版本同步政策(每条新迁移必须声明,见 db.rs 头「迁移作者规则」):
--   **纯本地 schema,新旧客户端混跑安全** —— 零 oplog 词汇变化、零协议改动、不进引导
--   快照的表级导入。旧端不认识这张表也不会收到任何提及它的 op。
--
-- 0029 起迁移文件只写事务体:无 BEGIN/COMMIT/PRAGMA user_version(runner 自有事务与
-- 版本号,事务体内的事务控制会被 SQLite authorizer 拒)。

CREATE TABLE item_comment_seen (
    item_id TEXT NOT NULL PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    seen_id TEXT NOT NULL CHECK (
        length(seen_id) = 26 AND seen_id NOT GLOB '*[^0-9A-Z]*'
    )
);

-- 存量回填:升级瞬间把已有留言全体归「已读」。没有这一句,装上本版的那一刻起每条
-- 带留言的条目都点亮红点 —— 那些留言用户早看过,满屏红点是误报不是提示。
-- ⚠ 这**不是** memory「同步字段存量非空值走开库自愈别在迁移回填」说的那件事:那条
-- 禁令管的是同步字段(表有值 op 无 = 跨端分叉);本表纯本地、不发 op,回填只关本机。
INSERT INTO item_comment_seen (item_id, seen_id)
SELECT item_id, MAX(id) FROM item_comment GROUP BY item_id;
