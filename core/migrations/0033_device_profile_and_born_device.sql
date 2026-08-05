-- migration 0033: 身份族第一批 —— 设备别名(device_profile)+ 条目署名(items.born_device)。
-- identity-plan §2/§3。
--
-- 动机:这个系统里至今没有「用户」这一层。有的只是 device_id(26 位规范 ULID,「设备 ×
-- 空间」粒度),而它今天在用户面几乎不可见——同步面板只显示一个数字「另有 N 台设备在线」。
-- 两个人共用一个空间时,既说不出「那台是谁」,也看不出「这条是谁记的」。本迁移落地这两件
-- 的地基:一张跨端收敛的设备名册,和一列不可变的出生设备。
--
-- 三件事,合成一条迁移(它们同属一个协议版本,拆开发布只会造出一个没人受益的中间态):
--
--   ① **oplog 词汇表加 `device` 实体**(整表重建,0024/0028 同手法:create-new → copy →
--      drop → rename → 重建索引/触发器;既有行逐字节原样搬,op_id/hlc/origin_seq 全保、
--      不重编号)。`device` 照 0028 的 `space` 是**无 create、无 tombstone 的 LWW 寄存器**,
--      唯一差别是**多实例**:entity_id = 该设备的 device_id,而不是固定字面量 'profile'。
--      故 space_profile 那个 `CHECK (key='profile')` 的单行钉死**不可照搬**。
--      无 create 的理由与 0028 逐字相同:并发首次命名若走 create 会撞行进 quarantine;
--      无 create 的 upsert 寄存器,并发 set_field 走字段级 LWW 天然收敛。
--      ⚠️ 本表体文本是新的单一 DDL 真相源:epoch::OPLOG_TABLE_DDL 与它**逐字同源(含
--      语句内注释)**,压实现场规范化 sqlite_schema 比对拒漂移——改这里必同步改那里。
--      oplog 无外键出入(全库无 `REFERENCES oplog`,已核),DROP/RENAME 不需要
--      foreign_keys=OFF 序曲(0029 起那也是事务内 no-op,见 db.rs 头「已声明的债」)。
--
--   ② **新建 `device_profile` 物化表**(状态⟺日志双重审计的状态侧)。
--
--   ③ **items 加 `born_device`**——「这条是哪台设备记的」的史实,照 born_stage 的四段形
--      (0018 + 0022 + 0025):INSERT 必填且如实 → UPDATE 永久冻结 → 回放/引导豁免 →
--      存量 NULL 不回填。
--
-- **为什么署名必须落列,不能从 oplog 派生**(identity-plan §3.1,本案最关键的一条):
-- 每条 op 天然带 origin(`substr(hlc,24)`),看起来查 `oplog WHERE kind='create'` 就有了。
-- 但**纪元压实会 DROP TABLE oplog 整表丢弃**,再用现值合成一批基线 op,而这批 op 的 origin
-- **全部是执行压实那台设备的新 device_id**(epoch.rs 注释原文)。生产库 2026-07-15 已经压过
-- 一次——今天库里每条老条目的「创建者」都已指向锚点设备,与真实创建者无关。故:
-- 「谁创建的」不是可长期派生的事实,是「当前账本里恰好还在」的偶然,压实一次即归零。
--
-- 存量行 born_device 保持 NULL = 未知,**不回填不猜**(0018 原文:「几乎肯定」不是史实)。
-- UI 未知就不显示署名,不显示「未知设备」这种噪音。
--
-- 跨版本同步政策(每条新迁移必须声明,见 db.rs 头「迁移作者规则」):
--   **oplog 词汇新增 `device` 实体 + item create payload 新增 born_device 键 —— 协议变化**。
--   **单版发布**(memory `single-phase-until-scale`,2026-07-22 拍板:推广早期用户少、双端
--   自控,不背两版发布的中间过程)。混版窗口两个方向都非破坏,但**不对称**,诚实记:
--     * 新端发 device op → 旧端收:旧端 validate_op_shape 落到词汇表外 = UnsupportedVocab,
--       **挂起该 origin 直到升级**(engine 既定版本偏斜自愈,升级即补齐)。代价是:混版期
--       在新端改一次别名,会让旧端从这台设备的同步整条停住,直到旧端升级。非破坏、不丢
--       数据,但**发布须提示两端尽快一起更新**。
--     * 旧端发 item create(payload 无 born_device 键)→ 新端收:**必须按「缺键 = null =
--       未知」放行**,绝不可判 InvalidOp——InvalidOp 会**持久隔离**该 origin(engine.rs
--       「毒 op」臂),而老端的历史 create op 是不可改写的史实,永远长不出这个键,判严了
--       就是把老设备整条 op 流打进隔离。replay::validate_op_shape 的 item create 臂据此
--       对 born_device **只校验形态、不要求键在**(与 born_stage 的「必带」刻意不同——
--       born_stage 诞生于 0018,早于同步存在,从无混版窗口)。
--
-- 这是**新增**迁移,不改任何已应用迁移(见 memory「migration-trap」)。0029 起迁移文件只写
-- 事务体:无 BEGIN/COMMIT/PRAGMA user_version(runner 自有事务与版本号,事务体内的事务控制
-- 会被 SQLite authorizer 拒)。真实库迁移后人工跑 foreign_key_check / integrity_check。

-- ---- ① oplog 词汇表加 device ------------------------------------------------------

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
    )
);

INSERT INTO oplog_new (op_id, hlc, entity, entity_id, kind, payload, origin_seq)
SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM oplog;

DROP TABLE oplog;
ALTER TABLE oplog_new RENAME TO oplog;

-- 索引与 append-only 触发器原样重建(0024/0028 同源)。
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

-- ---- ② 设备 profile 物化表 --------------------------------------------------------

-- 每台见过的设备至多一行。alias NULL = **显式清名**,是规范表示、不是「没这行」
-- (照 space_profile.name 的语义:压实基线「行存在就合成一条 op,含 value:null」)。
--
-- device_id 的形态闸与 clock::is_canonical_device_id 同口径的**第二道**:26 位、字符集
-- 收在 0-9A-Z(Rust 侧那把尺更严,另去掉 I/L/O/U)。它挡的是**非规范 id 白得一行**,
-- **不是行数**——一个已认证设备照样能发 N 条 device op、每条一个不同的合法 ULID。本表
-- 行数与 items/topics 同级、无协议上界(此处原写「记录数天然有界于账户设备数」,已由
-- codex 301 实现审 M3 证伪;非恶意的增长源是纪元压实:每压一次换一套 device_id,名册
-- 只增不减)。
--
-- ⚠️ 这是 **boot 正表**(identity-plan §4.9 第 11 条):进 boot 表级导入、进 strict_battery
-- 审计、进 spaces::CORE_TABLES;**不得**进 boot::strip_derived_from_snapshot(那是 299 给
-- 纯本地派生数据 item_image_thumb 加的剥离步,与本表性质相反)。
CREATE TABLE device_profile (
    device_id TEXT PRIMARY KEY CHECK (
        length(device_id) = 26 AND device_id NOT GLOB '*[^0-9A-Z]*'
    ),
    alias     TEXT
) WITHOUT ROWID;

-- ---- ③ items.born_device ----------------------------------------------------------

ALTER TABLE items ADD COLUMN born_device TEXT;

-- 新行必须如实记录出生设备(单机路径),带回放/引导豁免——豁免的必要性同 0025:
-- 引导导入的是**别机的终态行**,其 born_device 恒 ≠ 本机 device_id(NULL 的存量行同理)。
--
-- **`sync_meta` 的 device_id 行刻意不预插**(0019:「SQL 里没有随机源」,由 clock.rs::
-- Clock::load 首启生成)。若那行不存在,`NEW.x <> (SELECT ...)` 求值为 NULL(非 TRUE)
-- → WHEN 不触发 → **静默放行**,落下一个永不可改的错署名。中间那条 `NOT EXISTS` 就是
-- 堵这个洞的,**不可省**(identity-plan §6.3 单列为必须有行为测的三点之一)。
--
-- 触发器 WHEN 里跨表取标量子查询已实测可用(SQLite 3.47.2)。全仓此前只有
-- `NOT EXISTS (SELECT 1 FROM sync_replay_active)` 一种跨表形态,这是第一处「跨表取值再比对」。
CREATE TRIGGER trg_item_born_device_required
BEFORE INSERT ON items
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM sync_replay_active)
     AND (NEW.born_device IS NULL
          OR NOT EXISTS (SELECT 1 FROM sync_meta WHERE key = 'device_id')
          OR NEW.born_device <> (SELECT value FROM sync_meta WHERE key = 'device_id'))
BEGIN
    SELECT RAISE(ABORT, '新条目必须如实记录出生设备(born_device = 本机 device_id)');
END;

-- 出生设备是史实,永不改写;NULL 的老行也保持未知,不许事后补猜。**无豁免**——照
-- trg_item_born_stage_frozen(0025 原文:「导入只 INSERT,永不改写出生态」)。
--
-- ⚠️ **0034 起,本定义只在「库恰好停在 v33」这个暂态里有效**:0034 的恢复步必须先 DROP 掉
-- 这只触发器才动得了列,完事**原样重建** —— 于是任何跑完整迁移链的库上,活着的是 **0034
-- 里那一份**。(这不是推测:302 的变异对照把这句 WHEN 改坏,测试照样绿 —— 因为 0034 又把
-- 它建回来了。)
-- **两份都是历史检查点,谁都不该再改**:要改冻结触发器的行为就新增一条迁移去 DROP + CREATE。
-- 纪元压实会换掉每台设备的 device_id,但**绝不重写历史 born_device**(identity-plan
-- §4.9 第 6 条);旧 id 靠 device_profile 全表跨压实存活来翻成人话(§3.6)。
CREATE TRIGGER trg_item_born_device_frozen
BEFORE UPDATE OF born_device ON items
FOR EACH ROW
WHEN OLD.born_device IS NOT NEW.born_device
BEGIN
    SELECT RAISE(ABORT, '出生设备是史实,不可修改');
END;
