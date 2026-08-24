-- migration 0036: 看板列成为一等实体的 **schema 检查点** —— board-columns-plan B-b(第 1 段)。
--
-- 动机(用户 2026-08-23 提的两件):「往四态中间插入其他状态」+「支持自定义看板」。定形 =
-- `items.stage` 从**六值枚举**改成**指向 `board_column` 一行的身份**,列的名称 / 顺序 / 增删
-- 成为同步事实。⛔ 本条**只**落地物理形(表 + 六种子 + FK + 守护),**不接任何新实体词汇**
-- ——oplog 词汇表、replay 两臂、shape 校验、boot 审计、epoch 基线与指纹、entity_registry
-- 十一面全部归 **B-c**(plan §8.1-1 十轮定形:「同一张面不许切给两道工序」,而「oplog 词汇表」
-- 正是 `entity_registry` 那十一个具名面的第一面)。⇒ **本迁移之后、B-c 之前,库里不可能存在
-- 任何一枚 `board_column` op**,下方 ④ 的授权路径在这一版是**结构上不可达**的(见 ④ 头注)。
--
-- 跨版本同步政策(每条新迁移必须声明,见 db.rs 头「迁移作者规则」):
--   **纯本地 schema,新旧客户端混跑安全**。本条不新增/不改动任何 oplog 词汇、不发射 op、
--   不改协议;六个种子沿用旧 stage 字面量(见 ③),故本版发出的每一枚 item op 的 stage 值
--   与 v35 端逐字相同,旧端一个字都不用改。
--   ⚠ **这句只覆盖到本条迁移**:B 系列**整体**选的是 db.rs 那三选一里的
--   「**协议或 oplog 词汇变化,先发兼容 reader、下一版才开 writer**」(= plan §8 的 V1/V2
--   工序),而 **B-b 按 plan §8.2 不可单独发布**(`items.stage` 已是 FK 而实体语义未完成)。
--   ⛔ 别把这两句读成一句:本条**混跑安全**,但它**不是一个可发布的版本**。
--
-- 0029 起迁移文件只写事务体:无 BEGIN/COMMIT/PRAGMA user_version(runner 自有事务与版本号,
-- 事务体内的事务控制会被 SQLite authorizer 拒)。
--
-- ⭐ **本条是仓里第一条 `ForeignKeys::DisabledDuringBody`**(db.rs `MIGRATIONS` 第二格):
-- `items` 被 5 张子表 FK 引用,`DROP TABLE items` 在外键开着时要先跑一次隐式 DELETE、当场
-- 撞违例;而 0029 起事务体内 `PRAGMA foreign_keys=OFF` 是**静默 no-op**。故由 runner 在
-- `BEGIN` **之前**关、提交/异常/panic 三条路径由 `FkGuard` 归位(475/B-b0 交付的声明位,
-- plan §7.0)。事务体末尾 runner 照旧跑 `PRAGMA foreign_key_check` —— 整表重建的最终一致性
-- 由它兜,不由逐行拦截兜。真实库迁移后另行人工核 foreign_key_check / integrity_check。
--
-- ---------------------------------------------------------------------------------------
-- 这条迁移干四件事:
--   ① `board_column` 表 + 位置索引(⛔ **普通索引,绝不是 UNIQUE**,见下)
--   ② `sync_board_column_tombstone_apply` 授权表(墓碑写者的登记处)
--   ③ 六个种子行(**schema-seeded,不发 create op**)
--   ④ `items` 整表重建:去掉 stage 六值枚举 CHECK、换成指向 `board_column(id)` 的 FK,
--      索引与触发器原样还回(**4 只耦合触发器合并成 2 只**,见 ④),再建 6 只列守护
-- ---------------------------------------------------------------------------------------

-- ---- ① board_column ------------------------------------------------------------------
--
-- 形近 topics(ULID id + title + frindex position + kind + create/set_field/tombstone),
-- **刻意照抄那套**:十一个登记面各有一份可对照的既有实现,设计风险最低。
--
-- `system` 与 `kind` 是**两根不同的轴**,都保留(plan §2.3,codex 五轮推翻了「删掉 system」
-- 的倾向):`system` = 所有者 / 可删除性,`kind` = 流程空间(灵感态 vs 任务态)。删掉 system
-- 会把「不可删」错误地退化成 `kind='idea'`,并失去将来表达「不可删的 task 列」的能力。
--
-- 表级 CHECK **只能是单向的**,且方向是 `system=0 ⇒ kind='task'`(codex 六轮 H 纠正了
-- 五轮写反的那个方向):它守的是「**用户只能建 task 列**」——反方向那条(`system=1 ⇒
-- kind='idea'`)本来就由「保留 id」守,而且将来的 `system=1, kind='task'`(不可删的任务列)
-- 必须留得出口。⚠ 这一层只是四层里的第一层;另三层(shape/apply 拦「非保留 id 却
-- system=1」、boot 逐行出生审计、epoch/strict battery 共用同一个 birth validator)归 B-c
-- ——⛔ 别以为有了这条 CHECK 就守住了,远端 op 根本不过命令层,boot 与 epoch 都是直写。
--
-- `tombstoned_at` 存**墓碑那一枚 op 的 HLC 原文**,⛔ 不存 RFC3339(codex 五轮判,推翻了
-- 原倾向):RFC3339 只保 wall-ms、**丢掉 HLC 的 counter 与 device_id** ⇒ 两枚并发墓碑可能落成
-- 同一个值,§2.3 那个确定性 `min` 就失去了全序。代价照实记:这一列与 archived_at / sealed_at /
-- created_at(全是 RFC3339)**形态不一致** ⇒ UI 要显示人类时间时在**读取层**把 wall-ms 转
-- RFC3339,⛔ 不改存储形态。
CREATE TABLE board_column (
    id            TEXT PRIMARY KEY,           -- 新列 = ULID;六个种子 = 旧 stage 字面量(见 ③)
    title         TEXT NOT NULL,              -- 用户可见列名(种子存 canonical,显示走 §7.1d 的终态判据)
    kind          TEXT NOT NULL CHECK (kind IN ('idea', 'task')),
    system        INTEGER NOT NULL CHECK (system IN (0, 1)),
    -- frindex 排序键(同 items.position / topics.position)。行内只兜住明显的垃圾
    -- (字母开头 + 全字符落在 base62 表),**完整规范形态由 frindex::validate 守**——
    -- 这道是**第二道**,第一道在生成侧与 B-c 的 shape/apply/boot 三处(plan §2.1a)。
    position      TEXT NOT NULL CHECK (position GLOB '[A-Za-z]*' AND NOT (position GLOB '*[^0-9A-Za-z]*')),
    created_at    TEXT NOT NULL,
    -- 已删 = 该列墓碑的 HLC 原文(定长 23+26=49,`clock::Hlc::encode`)。⛔ 行永不物理删除
    -- (plan 不变量 5:回收站与成就归档里的条目仍指着它们出生/被删时所在的列,而「归档 =
    -- 史实,可查不可删」是铁律 ⇒ 列行消失就等于那些条目的 stage 指向不存在的行)。
    -- length 这道同样是第二道(照 0035 的 created_at):它答不了「hex 位对不对、device 后缀
    -- 是不是规范 ULID」,那半归 `Hlc::parse`。
    tombstoned_at TEXT CHECK (tombstoned_at IS NULL OR length(tombstoned_at) = 49),
    -- system=0 ⇒ kind='task'(见上方长注:方向是被 codex 六轮纠正过的,⛔ 别写反)
    CHECK (system = 1 OR kind = 'task')
);

-- ⛔⛔ **普通索引,绝不能是 UNIQUE**(codex 五轮 H)。`0022_replay_exemption.sql:16-22` 早就
-- 判过同一件事:`frindex::key_between` 是**确定性算法**,两端离线在**同一空隙**插入会算出
-- **同一个键**,合并后同键,回放第二条 op 撞唯一索引即 ABORT、**两端永不收敛**——这是多写者
-- 的数学不是工程。⇒ 列的读序一律 `ORDER BY (position, id)`,id 打平并列得确定性全序;同键
-- 并列是合并的合法结局,用户拖一下即分开。单机侧「代码 bug 造同键」的守护照 0022 的形靠
-- frindex::validate + 命令层契约 + cargo 测试,**不靠唯一索引**。
CREATE INDEX idx_board_column_position ON board_column (position);

-- ---- ② 墓碑写者授权表 -----------------------------------------------------------------
--
-- 它存在的理由(plan §2.3「④ 的形」,七轮定形,**证伪了「纯行内谓词」那个反案**):
-- 墓碑 marker 的合法改写有三条真路径(首次盖 / 并发取 min / 压实重基线),而**行内谓词
-- 只能检查状态关系,绑不住这次 UPDATE 的所有者** —— replay 语境下有的是「转换本身满足谓词、
-- 却根本不是 tombstone apply」的路径(boot 或将来的修复路径顺手把 marker 改成一个更小的
-- 合法 HLC)。⇒ 把「哪一条转换、由哪一枚 op 授权、按哪种写者契约」显式登记下来。
--
-- ⛔ 也**不能只靠 `sync_replay_active` 豁免**(六轮 H):那个标志不只是 board tombstone 的
-- 语境 —— replay 设它、**boot 也设它**、epoch 相关路径也设。
--
-- 三者分工:`from/to` = 这次转换合不合法;`mode` = 哪种写者契约;`op_id` = 具体哪一枚 op。
-- ⭐ `mode` 的价值**不是**表达 `(from,to)` 已有的数值关系(B-a 八轮自审时判错过),而是
-- **防止将来把 `epoch_rebase` 那个「向上改写」的许可误用到普通 apply 上**。
--
-- ⚠ **写入顺序被 `op_id` 这一格钉死**:要能验 op 就必须**先有 op、再改行**。replay 本来
-- 就是这个序(先记 oplog 再分发)⇒ **本地 writer 与 epoch rebase 也必须照这个序**。
-- ⚠ 该表**常态恒空**:一枚墓碑落地即被 ⑥ 当场消费。空表由 strict battery 兜底审计
-- (`board::audit_tombstone_apply_empty`)—— ⛔ 那道审计的定位是「发现实现 bug / 报告残留
-- 状态」,**它不是**防止第二枚正常 op 重复授权的机制(八轮把这条定位改准了)。
CREATE TABLE sync_board_column_tombstone_apply (
    column_id TEXT NOT NULL PRIMARY KEY REFERENCES board_column(id),
    op_id     TEXT NOT NULL,                       -- 绑到具体那一枚 tombstone op
    from_hlc  TEXT,                                -- 可 NULL = 首次盖墓碑
    to_hlc    TEXT NOT NULL,
    mode      TEXT NOT NULL CHECK (mode IN ('apply_min', 'epoch_rebase'))
);

-- ---- ③ 六个种子(schema-seeded,**不发 create op**) ------------------------------------
--
-- **为什么用旧字面量当 id、不给旧列换 ULID**:`items.stage` 存量行、`born_stage` 存量值、
-- `oplog` 里**全部历史 op** 的 payload 都写着这六个字面量,而 oplog 是 append-only 史实
-- (0020 触发器)。换 id 就得重写历史 ⇒ 直接否决。⇒ 存量数据**零改动**,只是 FK 从此指得到人。
--
-- **为什么不发六条 `board_column/create`**:旧端会收到一个它不认识的新 entity,正好违反
-- 「V1 不发新词汇」这条前提(plan §7.1a)。⇒ 六行都是 schema 提供的,不进 live oplog。
--
-- ⭐ **六个种子分两类,不是一类**(codex 五轮推翻 B-a 的形,plan §7.1a):
--   * `inbox`/`filed`(system=1)= **真 schema-owned**:永无 create/set_field/tombstone,
--     boot 跳过复制、与固定 canonical 行**逐字段严格相等**、`tombstoned_at` 必须 NULL。
--   * `todo`/`doing`/`confirming`/`done`(system=0)= **schema-seeded implicit genesis**:
--     不发 create,但此后 title / position / tombstone **全走普通 board_column op**
--     —— 按不变量 2 它们**可改名、可排序、可删**,那就是用户数据,必须能从同步日志重建。
--     ⛔ 故 boot 的过滤条件是 `system = 0 AND id NOT IN SEED_IDS`,**不能只看 system=0**。
--   (两条都归 B-c 落地;本条只负责把六行放对。)
--
-- ⛔ `created_at` 是**迁移文件里写死的 canonical 字面量**,不是各端各取一次当前时间
-- (codex 五轮:seed 行无 op 背书,各端时刻不同 = 无 op 可依的分叉)。position 同理。
-- ⭐ 这六行的**唯一描述源是 core 生产代码里的 `board::SEED_COLUMNS`**(plan §7.1e):迁移
-- 这份字面量与它的一致性由 `board::audit_seed_columns` 在 strict battery 上逐字段核。
INSERT INTO board_column (id, title, kind, system, position, created_at) VALUES
    ('inbox',      '未归类', 'idea', 1, 'a0', '2026-08-24T00:00:00.000Z'),
    ('filed',      '已归类', 'idea', 1, 'a1', '2026-08-24T00:00:00.000Z'),
    ('todo',       '待办',   'task', 0, 'a2', '2026-08-24T00:00:00.000Z'),
    ('doing',      '进行中', 'task', 0, 'a3', '2026-08-24T00:00:00.000Z'),
    ('confirming', '待确认', 'task', 0, 'a4', '2026-08-24T00:00:00.000Z'),
    ('done',       '已完成', 'task', 0, 'a5', '2026-08-24T00:00:00.000Z');

-- ---- ④ items 整表重建:stage 枚举 CHECK → 指向 board_column 的 FK -----------------------
--
-- SQLite 改不了列内 CHECK ⇒ 整表重建(同 0010/0012/0013/0014/0021/0022 的手法)。
-- ⛔ **列清单要取最新,别照 0021 抄**(codex 四轮 H5):0021 之后 0030 加了 `done_at`、
-- 0033/0034 加了 `born_device`,照 0021 那份列清单抄会把这两列**静默丢掉**。
-- 物理列序与今天的表逐位相同(id…born_stage 来自 0022,done_at 来自 0030 的 ALTER ADD,
-- born_device 来自 0033 的 ALTER ADD),`SELECT *` 的既有消费者不受影响。
--
-- 唯一的结构差异:`stage` 的 `CHECK (stage IN (六值))` **整个消失**,换成
-- `REFERENCES board_column(id)`。「live 回放撞枚举 CHECK」那一格改由 B-c 的
-- `DependencyMissing` 前置承接(plan §4.2)。
CREATE TABLE items_new (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    -- ⛔ FK 只保证「指向某一行」,表达不了「该行的 kind 决定 position/due/priority 的约束」
    --    (codex 二轮 H3)——那条耦合由下方两只带豁免的触发器守。
    stage       TEXT NOT NULL REFERENCES board_column(id),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    archived_at TEXT,
    due_on      TEXT CHECK (due_on IS NULL OR (date(due_on) IS NOT NULL AND date(due_on) = due_on)),
    priority    INTEGER CHECK (priority IS NULL OR priority IN (1, 2, 3)),
    -- 行内值域原样(0022):有值必须长得像 base62 排序键。「任务列必须有 / 灵感列必须无」
    -- 的耦合在触发器里,⛔ 别让耦合触发器承担全部值域(plan §2.2)。
    position    TEXT CHECK (position IS NULL OR (position GLOB '[A-Za-z]*' AND NOT (position GLOB '*[^0-9A-Za-z]*'))),
    sealed_at   TEXT,
    born_stage  TEXT,
    done_at     TEXT,
    born_device TEXT
);

-- 灌数:原样,零值变换(六个 stage 字面量此刻已在 board_column 里等着,FK 指得到人)。
INSERT INTO items_new (id, content, stage, created_at, updated_at, archived_at,
                       due_on, priority, position, sealed_at, born_stage, done_at, born_device)
SELECT id, content, stage, created_at, updated_at, archived_at,
       due_on, priority, position, sealed_at, born_stage, done_at, born_device
FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

-- 索引原样(0022 的形:stage_position 是**普通**索引,谓词保留)。
CREATE INDEX idx_items_stage_created ON items (stage, created_at);
CREATE INDEX idx_items_stage_updated ON items (stage, updated_at);
CREATE INDEX idx_items_stage_position
    ON items (stage, position)
    WHERE archived_at IS NULL AND sealed_at IS NULL AND position IS NOT NULL;

-- ---- ④-a items 触发器:随 DROP TABLE 一并消失的那些,原样还回 -------------------------
--
-- 今天这张表上有 15 只(0022 的 12 只 —— 其中两只**已被 0025 换过版本**,见下 —— 加
-- 0030 的 1 只 + 0033/0034 的 required 与 frozen 各 1 只)。⚠ **别把 0033 与 0034 的加起来
-- 数**:0034 是先 DROP 再重建 frozen,终态是**一只 required + 一只 frozen**。
-- 本条之后是 **13 只**:0022 那 4 只跨字段耦合触发器**合并成 2 只**(见 ④-b),其余原样。
--
-- ⚠ **`'inbox'` / `'done'` 这两个字面量刻意留着**:硬删只许发生在未归类灵感、封存只许发生
-- 在已完成任务 —— 这两条语义钉在**那两个种子列的身份**上,而种子 id 恒为这两个字面量。
-- ⛔ 别顺手改成「按 kind 判」:那会把「任何 idea 列的条目都能硬删」「任何 task 列都能封存」
-- 当成本轮的顺带扩张(单轮单件事),而这两条语义要不要跟着自定义列走是 B-f 的产品问题。

-- 0014:编辑历史归档。**刻意不豁免** —— item_revisions 是本地派生数据,回放远端编辑时
-- 本地照样长出历史(sync-plan §3.1)。
CREATE TRIGGER trg_item_archive_on_edit
BEFORE UPDATE OF content ON items
FOR EACH ROW
WHEN NEW.content <> OLD.content
BEGIN
    INSERT INTO item_revisions (item_id, content, archived_at)
    VALUES (OLD.id, OLD.content, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- 0017 → **0025 那一份**:禁生而归档,**带引导豁免**。
-- ⛔⛔ 这两只(它与下面的 born_stage_required)在 0022 里是**不带豁免**的,**0025 把它们
--     DROP 后重建、补上了豁免** —— 引导导入的是**别机的终态行**:已归档成就生而带
--     sealed_at、0018 前的存量行 born_stage 为 NULL、转过待办的行 born_stage ≠ stage,
--     三种合法史实照 0022 那版**必然被拦死**。
-- ⭐ 判例记档:B-a 那张「要还回什么」的清单(plan §7.2)数了 0022 / 0030 / 0033 / 0034,
--     **漏了 0025** —— 首版照它抄,boot 那一族当场 8 只红。**整表重建的还原清单不能照
--     计划书数,只能照真库 `sqlite_master` 抄**(本条的做法:先 dump 一份 v35 的
--     `tbl_name='items'` 全量,再逐条对拍;那份对拍已固化成
--     `board::tests::items_schema_survives_the_rebuild_byte_for_byte`)。
CREATE TRIGGER trg_item_no_insert_sealed
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '新条目不能直接带归档标记');
END;

-- 0018 → **0025 那一份**:出生态必填且如实(单机路径),带引导豁免。
CREATE TRIGGER trg_item_born_stage_required
BEFORE INSERT ON items
FOR EACH ROW
WHEN (NEW.born_stage IS NULL OR NEW.born_stage <> NEW.stage)
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '新条目必须如实记录出生态(born_stage = 插入时的 stage)');
END;

-- 0018:出生态是史实,永不改写(⛔ 无豁免 —— 导入只 INSERT,永不改写出生态)。

CREATE TRIGGER trg_item_born_stage_frozen
BEFORE UPDATE OF born_stage ON items
FOR EACH ROW
WHEN OLD.born_stage IS NOT NEW.born_stage
BEGIN
    SELECT RAISE(ABORT, '出生态是史实,不可修改');
END;

-- 0014:删除守护(带豁免)。远端 tombstone 是「该实体已死」的不可逆事实,可指任意列的行。
CREATE TRIGGER trg_item_no_delete_live_organized
BEFORE DELETE ON items
FOR EACH ROW
WHEN OLD.archived_at IS NULL AND OLD.stage <> 'inbox'
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '只有未归类(inbox)灵感可直接硬删:其余请先移入回收站再彻底删除');
END;

-- 0017:仅活跃 done 可归档(带豁免)。并发下远端合法归档到达时本地 stage 可能已被 LWW 改走。
CREATE TRIGGER trg_item_seal_only_done
BEFORE UPDATE OF sealed_at ON items
FOR EACH ROW
WHEN NEW.sealed_at IS NOT NULL AND OLD.sealed_at IS NULL
     AND (OLD.stage <> 'done' OR OLD.archived_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '只有「已完成」且不在回收站的任务可以归档');
END;

-- 0017:归档后冻结(带豁免)。sealed 行上更高 HLC 的远端字段编辑必须能落地。
CREATE TRIGGER trg_item_sealed_frozen
BEFORE UPDATE ON items
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '已归档的成就不可修改:请先取消归档');
END;

-- 0017:归档不可删(带豁免)。tombstone 支配 sealed,否则两端分叉。
CREATE TRIGGER trg_item_sealed_no_delete
BEFORE DELETE ON items
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '已归档的成就不可删除:先「取消归档」回看板,再走回收站');
END;

-- 0030:生而 NULL(带豁免)。done_at 只由「进入已完成」盖。
CREATE TRIGGER trg_item_no_insert_done_at
BEFORE INSERT ON items
FOR EACH ROW
WHEN NEW.done_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '新条目不能直接带完成时间(done_at 由进入「已完成」时盖)');
END;

-- 0033:出生设备必填(带可信写入语境豁免)。中间那条 NOT EXISTS **不可省** —— sync_meta 的
-- device_id 行刻意不预插,那行不存在时 `NEW.x <> (SELECT ...)` 求值为 NULL(非 TRUE)→ WHEN
-- 不触发 → 静默放行,落下一个永不可改的错署名。
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

-- 0033/0034:出生设备是史实,永不改写(无豁免)。
-- ⚠ 0033 与 0034 各有一份定义,活着的是 0034 那份(0034 先 DROP 再原样重建)。**本条起
-- 活着的是这一份** —— 三份逐字相同,行为测与变异对照都必须打**当前这一份**(302 判例:
-- 打 0033 那份是绿的,因为 0034 又把它建回来了)。
CREATE TRIGGER trg_item_born_device_frozen
BEFORE UPDATE OF born_device ON items
FOR EACH ROW
WHEN OLD.born_device IS NOT NEW.born_device
BEGIN
    SELECT RAISE(ABORT, '出生设备是史实,不可修改');
END;

-- ---- ④-b 耦合触发器:0022 的 4 只 → 2 只(**必须带回放豁免**) -------------------------
--
-- 0022 把两条跨字段耦合 CHECK 降级成 4 只触发器(stage↔position 的 insert/update +
-- 灵感态无 due/priority 的 insert/update)。本条把**两个方向合并进同一个合法性谓词**,
-- INSERT / UPDATE 各一只 = 恰 2 只(codex 四轮判:2 只够,这正是 0022 的既有结构)。
--
-- 谓词从 `board_column.kind` 取,不再从 stage 字面量列表判 —— 这就是本次改造的全部意义:
-- 「灵感态 vs 任务态」这条二分由列的 kind 承载,不再由 stage 字面值散布判断(不变量 3)。
-- ⚠ `kind` 不在 items 上 ⇒ **不进 `UPDATE OF` 列表**;content/archived_at/sealed_at/
-- done_at/born_stage/born_device 不影响这条耦合。
--
-- ⭐ **必须带 `NOT EXISTS (SELECT 1 FROM sync_replay_active)`**(codex 四轮纠正了 B-a 读反的
-- 那条):`0022:178` 那节的标题原文就是「触发器:新增 4 只(**被降级的耦合 CHECK 的化身,
-- 带豁免**)」。不带的话,远端「转待办」的 stage op 与 position op **分开到达**时第一条就会
-- 被错误拒绝。⚠ 而 `replay.rs` 那句「该 CHECK 未被 0022 回放豁免」说的是 **stage 枚举
-- CHECK**,不是耦合 CHECK —— 0021 那张表上有三个约束,0022 只降级了后两个。
--
-- ⚠ 谓词里 `(SELECT kind FROM board_column WHERE id = NEW.stage)` 取不到行时求值为 NULL,
-- 两臂皆假 ⇒ 单机路径当场 ABORT。回放路径豁免它,但外键那道仍在(replay 不关 FK)——
-- 「列还没到」这个形归 B-c 的 `DependencyMissing` 前置,不归这里。
CREATE TRIGGER trg_item_stage_kind_coupling_insert
BEFORE INSERT ON items
FOR EACH ROW
WHEN NOT (
        ((SELECT kind FROM board_column WHERE id = NEW.stage) = 'task'
             AND NEW.position IS NOT NULL)
        OR
        ((SELECT kind FROM board_column WHERE id = NEW.stage) = 'idea'
             AND NEW.position IS NULL AND NEW.due_on IS NULL AND NEW.priority IS NULL))
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, 'stage 与列的 kind 耦合:任务列必须有排序键,灵感列必须没有排序键/截止/优先级');
END;

CREATE TRIGGER trg_item_stage_kind_coupling_update
BEFORE UPDATE OF stage, position, due_on, priority ON items
FOR EACH ROW
WHEN NOT (
        ((SELECT kind FROM board_column WHERE id = NEW.stage) = 'task'
             AND NEW.position IS NOT NULL)
        OR
        ((SELECT kind FROM board_column WHERE id = NEW.stage) = 'idea'
             AND NEW.position IS NULL AND NEW.due_on IS NULL AND NEW.priority IS NULL))
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, 'stage 与列的 kind 耦合:任务列必须有排序键,灵感列必须没有排序键/截止/优先级');
END;

-- ---- ④-c board_column 的五只守护 + 一只消费者(plan §2.3) -----------------------------
--
-- ⭐ **哪只带豁免、哪只不带,是这一节的全部要害**(codex 四轮 H1)。判据 = **本地命令要拦、
-- 合法的远端事实要放**。五只按类别分(codex 五轮给的分类,B-a 那条「全局不变量 vs 本地 UX」
-- 二分不完整):
--   本地命令前置    ① 非空列不许删      → **带豁免**,放行合法远端事实
--   全局所有权不变量 ② 系统列不可删      → 不豁免
--   出生 / 历史不变量 ③ kind·system 不可改 → 不豁免
--   可合并的单调状态 ④ 墓碑 marker       → **受控豁免**:不看 sync_replay_active,看授权表
--   存储历史锚点    ⑤ 禁物理删行        → 不豁免

-- ① 非空列不许删(带豁免)。⚠ 多写者下它**挡不住并发**:A 端删空列的同一时刻 B 端拖一张卡
-- 进来,两条 op 各自在本地都合法 ⇒ 孤儿卡的落点由 plan §4.3 定义(远端 tombstone 恒放行、
-- 卡留在已删列上当只读收容区),**不靠这只守护**。不带豁免的话,远端一枚合法 tombstone 会归
-- InvalidOp、把整条流隔离。
CREATE TRIGGER trg_board_column_no_tombstone_nonempty
BEFORE UPDATE OF tombstoned_at ON board_column
FOR EACH ROW
WHEN NEW.tombstoned_at IS NOT NULL AND OLD.tombstoned_at IS NULL
     AND EXISTS (SELECT 1 FROM items
                 WHERE stage = OLD.id AND archived_at IS NULL AND sealed_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM sync_replay_active)
BEGIN
    SELECT RAISE(ABORT, '该列还有未归档条目,请先移走再删除');
END;

-- ② 系统列不可删(⛔ 不带豁免:不变量 2 是全局的,远端也不许违反)。
CREATE TRIGGER trg_board_column_system_no_tombstone
BEFORE UPDATE OF tombstoned_at ON board_column
FOR EACH ROW
WHEN OLD.system = 1 AND NEW.tombstoned_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, '系统列不可删除');
END;

-- ③ kind/system 是出生字段,永不改写(⛔ 不带豁免)。改 kind 会让该列上全部条目的耦合约束
-- 当场反转(有 position 的行忽然要求 NULL);改 system 能把灵感列降级成可删。两者都没有合法
-- 用途,故协议层禁 set_field、存储层这只兜底。
-- ⚠ B-a 原文把这只写成监听 `tombstoned_at`(codex 四轮 H4:**监听错了字段 = 等于没冻结**)。
CREATE TRIGGER trg_board_column_birth_immutable
BEFORE UPDATE OF kind, system ON board_column
FOR EACH ROW
WHEN OLD.kind IS NOT NEW.kind OR OLD.system IS NOT NEW.system
BEGIN
    SELECT RAISE(ABORT, 'kind/system 是出生字段,不可改写');
END;

-- ④ 墓碑只能由**登记在案的那一枚 tombstone writer** 改写(八轮定形)。
--    ⛔ `sync_replay_active` **不参与**这一只 —— 理由见 ② 上方的授权表长注。
--    触发器**读全四列**(from/to/mode/op_id)并要求 oplog 里真有那一枚 op 背书。
--
--    真值表按 `NEW`:
--      NEW IS NULL                      → 恒拒(**永不复活**,任何语境;含 NULL→NULL 这种
--                                          无意义写:没有任何合法路径会写它,fail-fast)
--      NEW == OLD(非空等值)            → 放行(**等值一律 no-op 不 ABORT**,七轮 M:
--                                          「本地只做 NULL→HLC」是规格推论不是实现事实,
--                                          幂等重试会被误伤)
--      其余                             → 必须有一行精确匹配的授权
--
--    ⚠ **本版(B-b)这条路径结构上不可达**:oplog 的词汇表 CHECK 要到 B-c 才认识
--    `board_column`,故此刻库里造不出任何一枚 `board_column/tombstone` op ⇒ 下方那句
--    `EXISTS (... FROM oplog ...)` 恒假 ⇒ 任何 marker 改写都会被拒。这是**刻意的**:
--    B-b 不该有能盖墓碑的路径。⛔ 代价照实记:④ 的**肯定半边**(首次盖 / 并发 min /
--    epoch_rebase / 等值 no-op)在本版**测不了**,那几格是 B-c 的验收项;若那时发现这只
--    触发器写错了,只能靠**新增一条迁移 DROP + CREATE** 修(0034 判例),⛔ 别回头改本条。
CREATE TRIGGER trg_board_column_tombstone_reject
BEFORE UPDATE OF tombstoned_at ON board_column
FOR EACH ROW
WHEN NEW.tombstoned_at IS NULL
  OR (NEW.tombstoned_at IS NOT OLD.tombstoned_at
      AND NOT EXISTS (
        SELECT 1 FROM sync_board_column_tombstone_apply a
        WHERE a.column_id = OLD.id
          AND a.from_hlc IS OLD.tombstoned_at
          AND a.to_hlc   IS NEW.tombstoned_at
          -- mode 决定**方向**(八轮:两个 mode 的差异就在这一格,不在 from/to 的值本身)。
          -- 显式 `COLLATE BINARY`:HLC 字典序 == 逻辑序成立、SQLite 默认也是 BINARY,
          -- 但那是**默认语义不是仓内显式契约**(七轮 M)。
          AND (   (a.mode = 'apply_min'
                   AND (a.from_hlc IS NULL
                        OR a.to_hlc < a.from_hlc COLLATE BINARY))
               OR (a.mode = 'epoch_rebase'
                   AND a.to_hlc > a.from_hlc COLLATE BINARY))
          -- op_id 把授权绑到**具体那一枚日志事实**上。
          AND EXISTS (SELECT 1 FROM oplog o
                      WHERE o.op_id = a.op_id
                        AND o.entity = 'board_column' AND o.kind = 'tombstone'
                        AND o.entity_id = OLD.id
                        AND o.hlc IS a.to_hlc)))
BEGIN
    SELECT RAISE(ABORT, '列的墓碑只能由登记的 tombstone writer 改写');
END;

-- ⑥ 授权行由**触发器自己消费**,不靠 apply 记得删(八轮:堵死「事务提交了但忘删」那条路)。
--
-- ⭐ **它是 AFTER,不是 BEFORE —— 这是本条对 plan §2.3 那段 SQL 的一处实现层订正**:
-- SQLite 对**同表同事件同时机**的多只触发器**不保证触发顺序**(文档原文:the order of
-- firing is undefined)。④ 与 ⑥ 若都是 BEFORE,⑥ 先跑就会把 ④ 要读的授权行删掉 ⇒ ④ 当场
-- 判「无授权」ABORT,整个墓碑路径**靠触发器创建顺序碰运气**。改成 AFTER 之后顺序由 SQLite
-- 的语义定死(全部 BEFORE 跑完 → 改行 → 全部 AFTER),且语义更准:**行真的改了才消费**。
-- ⚠ ①②④ 三只 BEFORE 之间无所谓顺序 —— 它们只 RAISE,没有副作用。
CREATE TRIGGER trg_board_column_tombstone_consume
AFTER UPDATE OF tombstoned_at ON board_column
FOR EACH ROW
WHEN NEW.tombstoned_at IS NOT OLD.tombstoned_at
BEGIN
    DELETE FROM sync_board_column_tombstone_apply WHERE column_id = OLD.id;
END;

-- ⑤ 行永不物理删除(⛔ 不带豁免,不变量 5)。
-- ⚠ 它同时是「`board_column/tombstone` 不许复用通用的 `apply_entity_tombstone`」这条规格
-- (codex 四轮 H2)在存储层的背板:那只通用 apply 是 `DELETE FROM {table} WHERE id = ?`,
-- 照抄它会直接违背不变量 5,并造出这条死路 —— tombstone 先到 → 只有 oplog 墓碑、没有物化行
-- → 后到的 create 被 sticky 压制 → 引用该列的 item op **永远等不到 FK 行**。
CREATE TRIGGER trg_board_column_no_delete
BEFORE DELETE ON board_column
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, '列是史实,只可 tombstone 不可删行');
END;
