-- migration 0035: 条目留言(item_comment)—— 身份族第二批,identity-plan §4。
--
-- 动机:298 立项的四件里,设备别名(0033)让「那台是谁」说得出口,条目署名(0033/0034)
-- 让「这条是谁记的」看得见;留言是最后一件 —— 让两个人能就**同一条**内容说话,而不是
-- 各写各的条目。它是全新一等实体,**纯加法、不改任何既有语义**。
--
-- 两件事,合成一条迁移:
--
--   ① **oplog 词汇表加 `comment` 实体**(整表重建,0024/0028/0033 同手法:create-new →
--      copy → drop → rename → 重建索引/触发器;既有行逐字节原样搬,op_id/hlc/origin_seq
--      全保、不重编号)。与 0033 的 `device` 不同:留言**有真实的出生事件、而且要能删**,
--      故 kind = `create | tombstone`。
--      ⚠️ **没有 `set_field` —— 留言不可编辑**(identity-plan §4.1)。改错了删掉重写;
--      可编辑就要回答「留言的编辑历史归不归档」,而 item_revisions 那套触发器是条目级的。
--      这条**可逆**:日后要加编辑,走新 kind,旧端撞 UnsupportedVocab 挂起、升级即自愈;
--      反过来先做了编辑再想撤就撤不掉。
--      ⚠️ 本表体文本是新的单一 DDL 真相源:epoch::OPLOG_TABLE_DDL 与它**逐字同源(含
--      语句内注释)**,压实现场规范化 sqlite_schema 比对拒漂移——改这里必同步改那里。
--
--   ② **新建 `item_comment` 表** + 两只触发器(见下)。
--
-- **删除语义是「直接销毁」不是「进回收站」**(用户 2026-08-06 拍板):design-rules 那条
-- 「删除=进回收站」是**条目级**的用户主权分级;留言是附属物,进回收站会在回收站里造出
-- 一类「无宿主的碎片」。UI 上用两拍确认兜。
--
-- **item 删除时留言随 FK CASCADE 走,不逐条发 comment tombstone**(照 topic_tombstone 对
-- link 的处置)。于是「有 comment create、无行、无 comment tombstone、有 item tombstone」
-- 是**健康**终态 —— boot 的 strict_battery 必须认识这一形(identity-plan §4.3 第 6 条;
-- 设计审一轮 H2:原判据会把它判坏,那样**第一次删掉带留言的条目之后,那个库就再也过不了
-- 电池** —— 供快照 / 引导 / 压实前三条路全挂)。
--
-- 跨版本同步政策(每条新迁移必须声明,见 db.rs 头「迁移作者规则」):
--   **oplog 词汇新增 `comment` 实体 —— 协议变化**。**单版发布**(memory
--   `single-phase-until-scale`)。混版窗口:新端发 comment op → 旧端 validate_op_shape
--   落到词汇表外 = UnsupportedVocab,**挂起该 origin 直到升级**(engine 既定版本偏斜自愈)。
--   ⚠️ 代价说准(设计审一轮更正了我一句错话):水位是 **per-origin、全词汇共享**的 ——
--   v34 端在某个 origin 的 comment 上挂起后,该 origin 后续**即使是它认识的 item op**
--   也一起停到升级为止。**不会污染 item 的终态,但会停住它的同步**。发版说明照 304 口径写。
--   反方向(旧端发的任何 op → 新端收)零影响:comment 是新 entity,旧端一条都发不出。
--
-- 这是**新增**迁移,不改任何已应用迁移(见 memory「migration-trap」)。0029 起迁移文件只写
-- 事务体:无 BEGIN/COMMIT/PRAGMA user_version(runner 自有事务与版本号,事务体内的事务控制
-- 会被 SQLite authorizer 拒)。真实库迁移后人工跑 foreign_key_check / integrity_check。

-- ---- ① oplog 词汇表加 comment -----------------------------------------------------

CREATE TABLE oplog_new (
    op_id      TEXT NOT NULL PRIMARY KEY,
    hlc        TEXT NOT NULL,
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    -- 源设备发射序号,每 origin 从 1 连续编;远端 op 原样入库(连续性由收端引擎的
    -- 严格连续应用保证,sync-protocol §5.3)。
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 1),
    -- 来源设备,从 hlc 定长编码内嵌处派生(第 24 字符起),虚拟列不落存储。
    origin     TEXT GENERATED ALWAYS AS (substr(hlc, 24)) VIRTUAL,
    CHECK (
        (entity IN ('item', 'topic') AND kind IN ('create', 'set_field', 'tombstone'))
        OR (entity = 'link' AND kind IN ('link_add', 'link_remove'))
        OR (entity = 'image' AND kind IN ('image_add', 'image_tombstone'))
        -- 空间 profile 单例寄存器(space-name-sync-plan §3):无 create、无 tombstone。
        OR (entity = 'space' AND kind = 'set_field')
        -- 设备 profile 多实例寄存器(identity-plan §2.1):同样无 create、无 tombstone,
        -- 但 entity_id = 该设备的 device_id(不是固定字面量),故无单行钉死。
        OR (entity = 'device' AND kind = 'set_field')
        -- 条目留言(identity-plan §4.1):有真实出生事件、要能删,故 create + tombstone;
        -- **刻意无 set_field** —— 留言不可编辑,改错了删掉重写。
        OR (entity = 'comment' AND kind IN ('create', 'tombstone'))
    )
);

INSERT INTO oplog_new (op_id, hlc, entity, entity_id, kind, payload, origin_seq)
SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM oplog;

DROP TABLE oplog;
ALTER TABLE oplog_new RENAME TO oplog;

-- 索引与 append-only 触发器原样重建(0024/0028/0033 同源)。
CREATE UNIQUE INDEX idx_oplog_hlc ON oplog (hlc);
CREATE INDEX idx_oplog_entity ON oplog (entity, entity_id);
CREATE UNIQUE INDEX idx_oplog_origin_seq ON oplog (origin, origin_seq);

CREATE TRIGGER trg_oplog_immutable
BEFORE UPDATE ON oplog
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'op 是史实,不可改写');
END;

CREATE TRIGGER trg_oplog_no_delete
BEFORE DELETE ON oplog
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'op 是史实,不可删除');
END;

-- ---- ② item_comment ---------------------------------------------------------------

-- 一条留言一行。宿主走 FK CASCADE(item 死则留言随之走,不发 comment tombstone)。
--
-- **created_at 是排序编码,不是展示格式**(identity-plan §4.6.1,设计审三轮 M2):
-- 定宽 `YYYY-MM-DDTHH:MM:SS.sssZ` 恰 24 字节。小数秒宽度若不定,TEXT 序里 `.`(0x2E)
-- < `Z`(0x5A),`...00Z` 会排在真实更晚的 `...00.1Z` 前面 —— 破坏「按时间展示」的语义
-- 顺序(keyset 分页本身不跳行不重复,那只要求稳定全序)。这一列的产出方是 Rust 侧唯一
-- 的具名 formatter,validator 做 parse → format → 逐字相等。
-- ⚠️ 存储层这道 length CHECK 是**第二道**;第一道在 replay::validate_op_shape。
--
-- **born_device 可空**:NULL = 作者未知,是**规范表示**。唯一合法来源是跨空间移动
-- (identity-plan §4.5)—— 空间=账户=独立库、device_id 每空间一份,源作者的身份在目标
-- 空间的名册里根本不存在,填执行移动那台 = 把别人写的话署上搬运工的名。与 items 跨空间
-- 移动填**执行者**(§3.5 第 3 条)刻意不同,代价如实记:**搬过空间的留言,作者信息永久丢失**。
CREATE TABLE item_comment (
    id          TEXT PRIMARY KEY CHECK (
        length(id) = 26 AND id NOT GLOB '*[^0-9A-Z]*'
    ),
    item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL CHECK (length(created_at) = 24),
    born_device TEXT CHECK (
        born_device IS NULL
        OR (length(born_device) = 26 AND born_device NOT GLOB '*[^0-9A-Z]*')
    )
);

-- 分页索引:`WHERE item_id = ? ORDER BY created_at DESC, id DESC`(keyset 游标同序)。
CREATE INDEX idx_item_comment_item ON item_comment (item_id, created_at, id);

-- 新留言必须如实记录出生设备(单机路径),带**可信写入语境**豁免。
--
-- 与 trg_item_born_device_required(0033)逐条同构,含那道不可省的 NOT EXISTS:
-- `sync_meta` 的 device_id 行刻意不预插(0019:「SQL 里没有随机源」),若那行不存在,
-- `NEW.x <> (SELECT ...)` 求值为 NULL(非 TRUE)→ WHEN 不触发 → **静默放行**,落下一个
-- 永不可改的错署名。中间那条 NOT EXISTS 就是堵这个洞的。
--
-- ⚠️ **可信写入语境从两个变成三个**(identity-plan §4.2,设计审一轮 H1):
-- sync_replay_active 今天服务「远端回放」与「boot 引导导入」,本批加第三个 =
-- **跨空间导入的留言那一段**。三者同性质:写进去的值来自另一个权威来源,不是本机
-- 此刻现场产生的,所以「born_device 必须等于本机」这条对它们本就不成立。
-- 作用域窄到只包住插 item_comment 的那几行,由 move_item 的**事务所有权**入口
-- (`insert_moved_comment_rows`)在结构上保证,不靠调用方自觉;同事务里的
-- items / topics / item_image 三段**不在豁免下**,0022 那批守护照旧咬。
CREATE TRIGGER trg_comment_born_device_required
BEFORE INSERT ON item_comment
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM sync_replay_active)
     AND (NEW.born_device IS NULL
          OR NOT EXISTS (SELECT 1 FROM sync_meta WHERE key = 'device_id')
          OR NEW.born_device <> (SELECT value FROM sync_meta WHERE key = 'device_id'))
BEGIN
    SELECT RAISE(ABORT, '新留言必须如实记录出生设备(born_device = 本机 device_id)');
END;

-- 留言只增与删,行永不改写。**无 WHEN、无豁免** —— 没有任何合法路径要 UPDATE 它:
-- 本地新建是 INSERT、回放 create 是 INSERT、boot 导入是 INSERT、压实基线回放是 INSERT、
-- 跨空间导入是 INSERT;删除是 DELETE。(设计审一轮专门找过反例,未找到。)
-- 它同时是「留言不可编辑」这条产品决定在存储层的背板:即使日后有人在编排层写了
-- UPDATE,这里当场 ABORT。
CREATE TRIGGER trg_comment_immutable
BEFORE UPDATE ON item_comment
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, '留言不可编辑(只增与删),行是史实');
END;
