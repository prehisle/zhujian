-- migration 0032: 缩略图本地派生表(item_image_thumb)—— image-perf-plan §3。
--
-- 起因(§2 量出来的):渲染一张缩略图今天的链路是「读整张 BLOB → base64(+33%)→ 跨 IPC
-- 字符串 → WebView 解码整张位图 → canvas 方裁 144² → 再编码 JPEG」。一屏十张卡 = 读 7.8 MB、
-- 解码 10 张全尺寸位图(本机主库均值 780 KB/张)。安卓为此不得不加全局并发闸挡「几十张全
-- 尺寸图同时 canvas 解码」。把算好的小图落一张本地表,第二次起就只读几 KB。
--
-- **四条性质(§3.1,都要守住)**:
--   ① **纯本地派生** —— 不进 oplog、不进同步、不进 boot 表级导入、不进 strict_battery 审计、
--      不进 spaces::CORE_TABLES。故本迁移**完全不动协议词汇表**。
--   ② **丢了能重建** —— 任何时候整表 DELETE 都无害,下次看图自动补回。
--   ③ **惰性填充** —— 不在上传时生成(存量图没有),第一次要显示时由前端算完回存。
--   ④ **规格带版本** —— spec 不匹配当未命中重算;日后改 144 / q0.8 这些旋钮只改
--      `thumbs::THUMB_SPEC` 一个常量,存量行当场全体未命中、看一次即刷新,不用写迁移。
--
-- 形上的两处刻意:
--   * **普通 rowid 表,不用 WITHOUT ROWID**(§3.1 ⚠):后者只适合行远小于一页的表,缩略图
--     几 KB 会溢出、反而更慢。
--   * **data 的字节上界写进 CHECK**(131072 = `thumbs::MAX_THUMB_BYTES`,两处由 repo 测试对
--     拍钉死):单笔最大合法负载 × 图张数 = 这张派生表的天花板。144² 的 JPEG 实测约 8 KB、
--     未压缩 PNG 上限约 82 KB,128 KiB 挡的是「把整图当缩略图塞进来」那个量级(整图均值
--     780 KB)。同 0016 用 CHECK 兜 MIME 白名单的手法:命令层先给人话错,DB 是背板。
--
-- 删图的连带(§3.4):`ON DELETE CASCADE` 跟着 item_image 走 —— 删图(images::remove /
-- replay 的远端墓碑 / 跨空间移动的源删)与删条目(items → item_image 两级级联)都自动带走
-- 缩略图,一行生命周期管理都不必写。FK 在三条开库路径上都已 enforce(db.rs / spaces.rs),
-- 迁移 runner 每条迁移后另跑 foreign_key_check。
--
-- 跨版本同步政策(每条新迁移必须声明,见 db.rs 头「迁移作者规则」):
--   **纯本地 schema,新旧客户端混跑安全** —— 零 oplog 词汇变化、零协议改动、不进引导快照的
--   表级导入。旧端不认识这张表也不会收到任何提及它的 op;新端拿到旧端来的图,照常惰性补算。
--
-- 0029 起迁移文件只写事务体:无 BEGIN/COMMIT/PRAGMA user_version(runner 自有事务与版本号,
-- 事务体内的事务控制会被 SQLite authorizer 拒)。纯新增表,存量数据零触碰。

CREATE TABLE item_image_thumb (
    image_id   TEXT NOT NULL PRIMARY KEY REFERENCES item_image(id) ON DELETE CASCADE,
    -- 规格指纹(如 '144sq-jpeg80');唯一真相源是 thumbs::THUMB_SPEC,由 thumbs::put 写死、
    -- 不由调用方传(往返式校验被判为伪契约,见 thumbs::put 文档);thumbs::get 拿它当
    -- `AND spec = ?` 过滤,改常量即存量行全体未命中、看一次自动刷新。
    spec       TEXT NOT NULL CHECK (typeof(spec) = 'text' AND length(spec) > 0),
    data       BLOB NOT NULL CHECK (typeof(data) = 'blob' AND length(data) > 0
                                    AND length(data) <= 131072),
    created_at TEXT NOT NULL
);
