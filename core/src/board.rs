//! 看板列(`board_column`)—— board-columns-plan B 系列的数据层。
//!
//! `items.stage` 自迁移 0036 起不再是六值枚举,而是**指向 `board_column` 一行的身份**:
//! 列的名称 / 顺序 / 增删成为同步事实,「灵感态 vs 任务态」这条二分由列的 `kind` 承载
//! (不变量 3),灵感那两列(`inbox`/`filed`)是不可改不可删的系统列(不变量 2)。
//!
//! # 本模块今天负责什么
//!
//! **B-b 第 1 段**(476)= schema 检查点:[`SEED_COLUMNS`] 这份唯一 seed 描述源,
//! 以及两道跟着它走的审计([`audit_seed_columns`] / [`audit_tombstone_apply_empty`],
//! 由 `boot::strict_battery` 消费)。
//!
//! **B-b 第 2 段(本轮)= read model + 「什么是任务态」的唯一判据**:[`list_columns`]
//! (两端 UI 的读模型,含 §7.1d 那个 [`BoardColumnRow::is_title_overridden`])、
//! [`column_kind`] / [`is_live_task_column`],以及给 SQL 用的两片 id 集合
//! [`TASK_COLUMN_IDS`] / [`IDEA_COLUMN_IDS`]。⭐ **不变量 3「灵感态 vs 任务态由列的 `kind`
//! 承载」的唯一正式子就在本模块** —— `repo` / `task` / `move_item` 一律引用这里,
//! ⛔ 别在别处再写一遍六值字面量(清单 14:同一条规则的第二份描述就是漂移源)。
//!
//! **写命令面(建列 / 改名 / 排序 / 删列)不在本段**:它要发 `board_column/create` 等 op,
//! 而 oplog 的词汇表 CHECK 归 **B-c** ⇒ 本版的库里造不出那种 op(plan §11 那个排序问题,
//! 已按出路 ① 定:第 2 段只做「不发 op 的那半」,写命令随 B-c 落)。
//! 实体面(oplog 词汇 / replay 两臂 / shape / boot 审计 / epoch 基线与指纹 /
//! `entity_registry` 十一面)整个归 **B-c**(plan §8.1-1)。
//!
//! # ⭐ 为什么 [`SEED_COLUMNS`] 必须是**唯一**的 seed 描述源(plan §7.1e,七轮判 H)
//!
//! 「哪六个 id 是种子」这份知识要出现在**六处**:迁移 SQL / replay apply 的 seed 分支 /
//! `count_unbacked_rows` 豁免 / `audit_op_preconditions` 分支 / `audit_create_multiplicity`
//! 禁令 / epoch 基线分类。**漂一处就是一个安静的洞**,而最坏后果跨过了「门禁停止扩张线」
//! 那条判据(CLAUDE.md 工作节奏 5):
//!
//! * 漏掉一个真 seed id ⇒ 合法 seed op 被当普通用户 op,**boot/fresh 可能永久拒**;
//! * 把普通用户 id 错列成 seed ⇒ 无 create 背书的行被豁免,**可能穿过 boot/battery =
//!   静默不同步**;
//! * epoch 漏掉 seed ⇒ 合成错误的 create,远端撞已有 genesis 行或错误隔离。
//!
//! ⇒ 上述六个面**全部消费这一份**;迁移 SQL 里仍有固定字面量(它必须是字面量,见下),
//! 两者的一致性由 [`audit_seed_columns`] 在每次严格电池上逐字段核。
//! ⛔ **不给 `entity_registry` 加「seed policy」第 12 面**(七轮明确否):它只登记**实体级**
//! 的面,而 seed 例外是**同一个 `board_column` 在已有五个面上的特殊值策略**,不是新实体面。
//!
//! # ⚠ 种子分两类,不是一类(plan §7.1a,codex 五轮推翻了「六个一律是 schema 常量」)
//!
//! 共同点:两类都**不发 `board_column/create`**(否则 V1 就给旧端发了它不认识的新 entity)。
//! 差别在**此后**:
//!
//! | 行类 | 同步语义 | 校验 |
//! |---|---|---|
//! | `inbox`/`filed`(`system=1`) | 真 schema-owned:**永无** create/set_field/tombstone | 与 canonical 行**逐字段严格相等**,`tombstoned_at` 必须 NULL |
//! | 四个 task 种子(`system=0`) | **schema-seeded implicit genesis**:不发 create,但此后 `title`/`position`/`tombstone` **全走普通 op** | 只核出生字段;⛔ **title/position/墓碑不与默认值盲比**——按不变量 2 它们可改名、可排序、可删,那就是用户数据 |

use rusqlite::{Connection, OptionalExtension};
use ulid::Ulid;

use crate::clock::Clock;
use crate::{frindex, oplog, repo};

pub mod gate;

/// 能力 token:「本端认识 `board_column` 这套词汇」(plan §6 / §5.5,B-d 落)。
///
/// ⭐ **它只有这一份,两个用途共用**(清单 14:同一条规则的第二份描述就是漂移源):
///
/// * **线上**——每一枚出站 [`crate::sync::engine::Msg::Hello`] 的 `caps` 都带它,
///   收端据此记下 per-peer 观测(plan §6 / §6.2);
/// * **闩**——§5.5 那枚单调闩存的是 `(account_id, BOARD_COLUMNS_CAP_GEN)`,而规格原文
///   写死「Hello 宣告**同一枚 token**」⇒ **B-e 直接引本常量**,⛔ 别另定一个
///   `BOARD_COLUMNS_CAP_GEN`(两份必漂,而漂的方向是「闩认为全员具备、线上宣告的却是别的
///   token」= 朝 `true` 错算 = §5.3 判 H)。
///
/// ⚠ **什么时候必须 bump**(plan §14 那行,§5.5 (α)):凡与 board_columns 语义有关的
/// schema / validator / 线上形态变化,一律显式换新 token 串(如 `board_columns_v2`);
/// ⛔ 反过来,与本案无关的迁移或 `VALIDATOR_VER` bump **不许**无谓换它 —— 换一次就把
/// 全账户已立起来的闩清一次,功能跟着关一轮。
///
/// ⛔ **与 `sync_proto::CAP_ACCOUNT_STATUS_V1` / `CAP_DEVICE_ROSTER_V1` 是两个键空间**
/// (plan §6):那两枚讲「**服务器**认不认」、挂 `ClientMsg::Auth`,服务器看得见;这一枚讲
/// 「**对端设备**认不认」、挂 E2EE 内层的 `Msg::Hello`,服务器一个字节都看不到。不许串。
pub(crate) const CAP_BOARD_COLUMNS_V1: &str = "board_columns_v1";

/// ⭐ **编译期钉死「这枚 token 过得了入口卫生」**。
///
/// `sync_proto::has_capability` 会**跳过**超 32 字节或含非 ASCII 的项(§6:垃圾项跳过而
/// 不拒整枚 Hello)。⇒ 哪天有人把 token 改长或改成中文,后果不是报错,而是:本端照发、
/// 对端照收、`has_capability` 一声不吭地滤掉它 ⇒ **全账户的能力观测永远为假、功能永久
/// 关着**,而且没有任何一条日志会说为什么。这句 `assert!` 把那个静默失败搬到编译期。
const _: () = assert!(CAP_BOARD_COLUMNS_V1.len() <= 32 && CAP_BOARD_COLUMNS_V1.is_ascii());

/// 一个种子列的 canonical 出生形。**六行的唯一描述源**(见模块头注)。
///
/// ⚠ 字段全是 `&'static str` / `bool` 的**值**而不是从库里读出来的:它要能在「库还没建
/// 起来」「库是坏的」两种语境下当判据用。
pub(crate) struct SeedColumn {
    /// 旧 stage 字面量。⛔ **不给旧列换 ULID**:`items.stage` 存量行、`born_stage` 存量值、
    /// `oplog` 里全部历史 op 的 payload 都写着这六个字面量,而 oplog 是 append-only 史实
    /// (0020 触发器)⇒ 换 id 就得重写历史。存量数据零改动,只是 FK 从此指得到人。
    pub(crate) id: &'static str,
    /// 迁移里那份 canonical 中文名。⚠ **不是显示文案**:显示走 plan §7.1d 的**终态判据**
    /// (`title != canonical` ⇒ 用同步来的名;相等 ⇒ 按 id 查本端字典),判据在 core 求值,
    /// ⛔ canonical 串不进前端。
    pub(crate) canonical_title: &'static str,
    /// `idea` | `task`。出生字段,协议禁 `set_field`,存储层由 `trg_board_column_birth_immutable` 冻结。
    pub(crate) kind: &'static str,
    /// 系统列 = 不可删(所有者轴)。⚠ 与 `kind`(流程空间轴)是**两根不同的轴**,
    /// 别把「不可删」退化成 `kind='idea'`——那样就表达不了将来的「不可删的 task 列」。
    pub(crate) system: bool,
    /// frindex 排序键。迁移里写死的固定值(见 [`SEED_COLUMNS`] 头上那段)。
    pub(crate) position: &'static str,
    /// ⛔ **迁移文件里写死的 canonical 字面量**,不是各端各取一次当前时间:seed 行无 op
    /// 背书,各端时刻不同 = 一个**无 op 可依的分叉**(codex 五轮)。
    pub(crate) created_at: &'static str,
}

/// 迁移 0036 种下的六行。**顺序 == `position` 的升序**(读序另由 `(position, id)` 定)。
///
/// ⚠ 这份**必须与 `core/migrations/0036_board_column.sql` 里那条 INSERT 逐字段相等**,
/// 由 [`audit_seed_columns`] 与本模块的单测两头钉住。⛔ 改这里就要改那里 —— 迁移是
/// append-only 的史实,真要改 canonical 值只能新增一条迁移(0034 判例)。
pub(crate) const SEED_COLUMNS: &[SeedColumn] = &[
    SeedColumn {
        id: "inbox",
        canonical_title: "未归类",
        kind: "idea",
        system: true,
        position: "a0",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "filed",
        canonical_title: "已归类",
        kind: "idea",
        system: true,
        position: "a1",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "todo",
        canonical_title: "待办",
        kind: "task",
        system: false,
        position: "a2",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "doing",
        canonical_title: "进行中",
        kind: "task",
        system: false,
        position: "a3",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "confirming",
        canonical_title: "待确认",
        kind: "task",
        system: false,
        position: "a4",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "done",
        canonical_title: "已完成",
        kind: "task",
        system: false,
        position: "a5",
        created_at: "2026-08-24T00:00:00.000Z",
    },
];

/// 六个种子 id 的 SQL 集合字面量 `('inbox', 'filed', …)`,给 `id IN {…}` / `NOT IN {…}` 用。
///
/// ⛔ **判据是「那六个明确 id」,不是 `system = 0`、也不是 `kind = 'task'`**(plan §7.1a/§7.1e):
/// 四个 task 种子正是 `system = 0`,拿 system 当过滤条件会把它们当用户行处理 —— 而它们在
/// 两端**必然相交**(种子由 schema 提供),表级复制当场撞 PRIMARY KEY。反过来把用户 id 错
/// 列成种子,则会让无 create 背书的行被豁免、**静默穿过 boot/battery**。
pub(crate) fn seed_ids_sql() -> String {
    id_set_sql(SEED_COLUMNS.iter().map(|s| s.id))
}

/// 四个 **task** 种子(`system = 0` 的那半:可改名 / 可排序 / 可删)的 SQL 集合字面量。
///
/// 它们是 **schema-seeded implicit genesis**(plan §7.1a):不发 create,但此后
/// `title` / `position` / `tombstone` 全走普通 op ⇒ 引导时**必须从合并后的 oplog 物化**,
/// ⛔ 不与迁移里那份默认值盲比(按不变量 2 它们就是用户数据)。
pub(crate) fn task_seed_ids_sql() -> String {
    id_set_sql(SEED_COLUMNS.iter().filter(|s| !s.system).map(|s| s.id))
}

/// ⚠ 拼的是 **`SEED_COLUMNS` 里那六个写死的字面量**,没有任何一格来自外部输入 ——
/// 这不是「用字符串拼 SQL」的那个坑。真要换成绑定参数就得把 `IN (?,?,…)` 的元数也拼出来,
/// 那才是把同一份知识写第二遍。
fn id_set_sql<'a>(ids: impl Iterator<Item = &'a str>) -> String {
    let inner: Vec<String> = ids.map(|id| format!("'{id}'")).collect();
    format!("({})", inner.join(", "))
}

// ---- 「什么是任务态」的唯一正式子(不变量 3) ------------------------------------------

/// SQL 片段:**任务态列的 id 集合**,给 `stage IN {TASK_COLUMN_IDS}` 用。
///
/// ⭐ 0036 之前这里是六值字面量 `('todo','doing','confirming','done')`,并由 `items` 上那条
/// stage 枚举 CHECK 在底下兜着;0036 起 CHECK 换成了指向 `board_column` 的 FK,**「这一行是
/// 不是任务」只有一个答案:它那列的 `kind`**(不变量 3)。
///
/// ⚠ **含已盖墓碑的列**,这是刻意的:删掉的列是「只读收容区」,行永不物理删除(不变量 5),
/// 上面的卡**仍然是任务** —— 回收站 / 成就归档 / 统计轴都还要数得到它们(plan §4.3)。
/// 要「活着的列」用 [`is_live_task_column`],别在 SQL 里另拼一份带 `tombstoned_at` 的。
pub(crate) const TASK_COLUMN_IDS: &str = "(SELECT id FROM board_column WHERE kind = 'task')";

/// SQL 片段:**灵感态列的 id 集合**(同 [`TASK_COLUMN_IDS`] 的形)。
///
/// ⚠ 今天它恒等于 `('inbox','filed')` —— 不变量 2 + §2.3 那条 `CHECK (system = 1 OR
/// kind = 'task')` 合起来钉死「`kind='idea'` ⟹ id ∈ {inbox, filed}」。**照样走 kind**:
/// 判据只许有一个正式子,不许因为「今天算出来一样」就退回字面量。
pub(crate) const IDEA_COLUMN_IDS: &str = "(SELECT id FROM board_column WHERE kind = 'idea')";

/// 这个 id 是不是**迁移种下的那六个之一**。
///
/// ⚠ 它答的是「id 在不在 [`SEED_COLUMNS`] 这份清单里」,**不查库** —— 故意的:
/// 跨空间移动要在**目标库**上判「这个落点是不是内置列」,而那句判断必须与本机库的
/// 现状无关(§8.3:目标 stage 恒 ∈ `{inbox, filed, todo}`,全是旧端也认识的值)。
/// 行在不在、是什么 kind,另问 [`column_kind`]。
pub(crate) fn is_seed_column(id: &str) -> bool {
    SEED_COLUMNS.iter().any(|s| s.id == id)
}

/// 这个 id 是不是**系统种子**(`system=1` 的那两个,即灵感的 `inbox`/`filed`)。
///
/// ⭐ 它与 [`is_seed_column`] 的差别正是 plan §7.1a 那条「六个种子**分两类**」:
/// 系统那两个是**真 schema-owned** —— 永无 create / set_field / tombstone,任何一枚
/// 打在它们身上的 op 都是坏 op(不变量 2 是全局的,远端也不许违反);四个 task 种子是
/// **schema-seeded implicit genesis**,不发 create 但此后 title/position/tombstone 全走普通 op。
///
/// ⚠ 同 [`is_seed_column`],它**不查库**:判据是「这个 id 在不在 [`SEED_COLUMNS`] 里且
/// `system` 为真」,shape 层要在不开事务的前提下用它(plan §4.1:shape 层不许查库)。
pub(crate) fn is_system_seed_column(id: &str) -> bool {
    SEED_COLUMNS.iter().any(|s| s.id == id && s.system)
}

/// 一列的当前身份。⛔ 别用 stage 字面量代答这两格中的任何一格。
///
/// ⚠ **刻意不含 `system`**:这一层的消费者(拖拽目标判据 / 跨空间落点 / 指纹)一个都不看
/// 「是不是系统列」,那一格只有 read model 的 UI 要(见 [`BoardColumnRow::system`])
/// —— 算出来没人用的值就是判据缺失的影子(首版自检清单「修完之后」第 3 问)。
pub(crate) struct ColumnKind {
    /// `idea` | `task`(出生字段,`trg_board_column_birth_immutable` 冻结)。
    pub(crate) kind: String,
    /// 已盖墓碑 = 只读收容区(不变量 5:行永不物理删除)。
    pub(crate) deleted: bool,
}

impl ColumnKind {
    pub(crate) fn is_task(&self) -> bool {
        self.kind == "task"
    }
}

/// 读一列的身份;**列不存在 → `None`**。
///
/// ⚠ 拿 `items.stage` 来查时 `None` 是**不可达**的(0036 起那是 FK)⇒ 调用方碰上它要响亮报
/// 「数据损坏」,⛔ 别写成默认值分支。
pub(crate) fn column_kind(conn: &Connection, id: &str) -> rusqlite::Result<Option<ColumnKind>> {
    conn.query_row(
        "SELECT kind, tombstoned_at IS NOT NULL FROM board_column WHERE id = ?1",
        [id],
        |r| Ok(ColumnKind { kind: r.get(0)?, deleted: r.get(1)? }),
    )
    .optional()
}

/// 「这个 id 是不是一个**活着的任务列**」——看板拖拽 / 流转的**目标**判据。
///
/// 三格缺一不可:行在(不是凭空一个 id)、`kind='task'`(不许把卡拖进灵感列)、
/// **未盖墓碑**(已删列是只读收容区,卡只出不进,plan §4.3)。
pub(crate) fn is_live_task_column(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(column_kind(conn, id)?.is_some_and(|c| c.is_task() && !c.deleted))
}

/// 该列上**未归档未封存**的条目数 —— 「删列要先清空」(不变量 4)那条判据的唯一 Rust 侧
/// 正式子;[`list_columns`] 与 [`delete_column`] 共用。
///
/// ⚠ **仓里还有第三份,住在迁移 0036 里**:`trg_board_column_no_tombstone_nonempty`
/// 那只**带回放豁免**的守护(plan §2.3 ①)。它与这里必须逐字同口径。⛔ 那份改不了
/// (迁移是 append-only 史实),所以要漂只会往这边漂 —— 两边分工写在 [`delete_column`] 头上。
pub(crate) fn live_item_count(conn: &Connection, column_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM items \
          WHERE stage = ?1 AND archived_at IS NULL AND sealed_at IS NULL",
        [column_id],
        |r| r.get(0),
    )
}

// ---- 477 那笔账:两列身上挂着**产品语义** ⇒ 永不可删(480 用户拍板) -----------------

/// 「新任务落哪一列」的唯一正式子。**三条产品主线共用**:转待办
/// (`repo::promote_to_todo`)、新建任务(`repo::insert_task`,连 `born_stage` 一起)、
/// 撤回为灵感的前提(`repo::revert_to_idea` —— 只有这一列的卡能退回灵感)。
pub(crate) const LANDING_COLUMN: &str = "todo";

/// 「完成」这个**角色**住在哪一列。**四条产品主线共用**:进这一列才盖 `done_at`
/// (`task::done_fields`)、单卡与一键成就归档(`repo::seal_task` / `seal_all_done`)、
/// 取消归档的回落点(`repo::unseal_task`)、归档统计。
pub(crate) const DONE_COLUMN: &str = "done";

/// 挂着产品语义、故**永不可删**的那两列。
///
/// ⭐ **它与上面两个常量是同一份知识**(数组由常量本身构成)⇒ 改常量必然改这里,
/// 结构上漂不了。这正是 477 那笔账要的:落点与「不许删」若各写一份,某天把 `done`
/// 从禁删名单里拿掉,`seal_all` 会**安静地**变成恒 0 条 —— 不是响亮拒。
const ROLE_COLUMNS: [&str; 2] = [LANDING_COLUMN, DONE_COLUMN];

/// 这一列**永远**不许删的理由;`None` = 允许删。
///
/// ⚠ 「允许删」**不等于**「现在能删」:非空列要先清空(不变量 4),那一格是**动态**的、
/// 由 [`live_item_count`] 说了算,不在这儿。
///
/// 两条判据是**两根不同的轴**,⛔ 别合并成一条:
///
/// * `system = 1`(灵感两列)—— **不变量 2**,连改名、改 kind 一起禁,是**全局**不变量
///   (远端也不许违反 ⇒ shape 层 `validate_board_column_entity_id` 与存储层 ② 那只
///   **不带豁免**的守护另有两道);
/// * [`ROLE_COLUMNS`](`todo` / `done`)—— **477 那笔账**:产品语义钉在这一列身上,
///   删了它那条主线会**安静地**停摆。⭐ 它**只禁删** —— 这两列照样可改名、可排序,
///   用户把「待办」改名成「本周」是合法的,id 没变、语义就没变。
///
/// ⭐ **这条只放命令层,⛔ 不进 shape / 不加触发器**,判据是「最坏后果」:一枚打在
/// `done` 上的远端 tombstone 顶多让**这台**的成就归档退化,既不丢数据也不分叉 ⇒ 与
/// 不变量 4 同一类(plan §2.3 那张分类表第一行「本地命令前置 → 豁免,放行合法远端事实」)。
/// 放进 shape 就成了硬协议规则:哪天产品改主意允许删,旧端会把新端整条 origin 隔离
/// —— 那正是 §4.0 那条病根。
pub(crate) fn undeletable_reason(id: &str, system: bool) -> Option<String> {
    if system {
        return Some(format!("「{id}」是系统列(灵感),不可删除"));
    }
    if id == LANDING_COLUMN {
        return Some(
            "这一列是新任务的落点(转待办 / 新建任务都落在这里),不可删除;想换个说法可以改名"
                .to_string(),
        );
    }
    if id == DONE_COLUMN {
        return Some(
            "这一列承载「完成」(完成时刻、成就归档都认它),不可删除;想换个说法可以改名"
                .to_string(),
        );
    }
    debug_assert!(!ROLE_COLUMNS.contains(&id), "ROLE_COLUMNS 多了一格却没在上面逐条给理由");
    None
}

// ---- read model(两端 UI 的唯一读法) ---------------------------------------------------

/// 一列的当前态。**两端 UI 只读这个**,⛔ 别各自去查 `board_column`。
pub struct BoardColumnRow {
    pub id: String,
    /// 同步来的原文。⚠ **系统列的显示文案不一定是它** —— 见 [`Self::is_title_overridden`]。
    pub title: String,
    /// `idea` | `task`。灵感视图取前者两列,看板取后者。
    pub kind: String,
    /// 系统列:不可改名、不可删、不可改 kind(不变量 2)。
    pub system: bool,
    /// frindex 排序键。⚠ 读序已由本函数按 `(position, id)` 排好,**同键并列是合法结局**
    /// (0022:两端在同一空隙插列必得同一个键)⇒ ⛔ 前端别拿它再排一次。
    pub position: String,
    /// §7.1d 的**终态判据**,⛔ 不是「查过 oplog 有没有改名」(压实会 DROP 旧 oplog)。
    ///
    /// * `true` → 显示 [`Self::title`](用户/同步来的名);
    /// * `false` → **按 [`Self::id`] 查本端字典**(六个种子的 canonical 名是各端各自的语言)。
    ///
    /// ⭐ 判据在 core 求值 ⇒ **canonical 串只活在迁移 SQL 与 [`SEED_COLUMNS`] 两处、不进前端**,
    /// 「三份 canonical title 会漂」这个问题被消掉而不是被门禁看住。
    /// ⚠ 用户自己建的列没有 canonical ⇒ 恒 `true`。
    pub is_title_overridden: bool,
    /// 已删 = 只读收容区(不变量 5)。⚠ 只给布尔,不给时刻:库里存的是 HLC 原文
    /// (§3,为了 `min` 有全序),而今天没有任何一处 UI 要显示「什么时候删的」
    /// ⇒ 需要人类时间那天再在这一层把 wall-ms 转 RFC3339,⛔ 别改存储形态。
    pub deleted: bool,
    /// 该列上**未归档未封存**的条目数。UI 的「已删除的列(N)」用它(plan §4.3),
    /// 删列前的「先清空」提示也用它。⚠ 回收站 / 成就归档里的条目不计。
    pub live_items: i64,
    /// 这一列**允许**被删吗(480 定案,判据的唯一正式子见 [`undeletable_reason`])。
    ///
    /// ⚠ **不是「现在能不能删」**:非空列还要先清空 —— 那一格看 [`Self::live_items`]。
    /// UI 该按 `deletable && live_items == 0` 决定「删除」是可点还是灰,⛔ 别自己重写
    /// 这条规则(plan §8.1-2:B-f 不拥有任何数据安全判定)。
    pub deletable: bool,
}

/// 全部列(**含已删的**),按 `(position, id)` 升序 —— 与 `items` 的读序同一条规矩。
///
/// ⚠ 一次全量返回而不分「活的 / 删的」两个查询:列是个位数量级,分两趟只会给 UI 造出
/// **第二份口径**;要哪一族由调用方按 [`BoardColumnRow::kind`] / [`BoardColumnRow::deleted`] 分。
pub fn list_columns(conn: &Connection) -> rusqlite::Result<Vec<BoardColumnRow>> {
    // 两趟:先把行读完(`live_items` 要另调 [`live_item_count`],不能在 query_map 的闭包里
    // 借着同一个 conn 再查)。⚠ 那是**刻意**的 N+1 —— 列是个位数量级,而把「什么算 live
    // 条目」的判据写成本文件里的第二份子查询才是真代价(清单 14;那条判据还有第三份住在
    // 迁移 0036 的守护 ① 里,改不动)。
    let mut stmt = conn.prepare(
        "SELECT id, title, kind, system, position, tombstoned_at IS NOT NULL \
         FROM board_column ORDER BY position, id",
    )?;
    let rows: Vec<(String, String, String, bool, String, bool)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get::<_, i64>(3)? == 1,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter()
        .map(|(id, title, kind, system, position, deleted)| {
            let is_title_overridden = title_is_overridden(&id, &title);
            let deletable = undeletable_reason(&id, system).is_none();
            let live_items = live_item_count(conn, &id)?;
            Ok(BoardColumnRow {
                id,
                title,
                kind,
                system,
                position,
                is_title_overridden,
                deleted,
                live_items,
                deletable,
            })
        })
        .collect()
}

/// §7.1d 的终态判据(单一正式子;[`list_columns`] 是它唯一的生产消费者)。
fn title_is_overridden(id: &str, title: &str) -> bool {
    match SEED_COLUMNS.iter().find(|s| s.id == id) {
        Some(seed) => title != seed.canonical_title,
        // 用户建的列:没有 canonical 可比,那名字本来就只能照显。
        None => true,
    }
}

/// 种子行的值一致性审计(plan §7.1e:「并进已有的 migration / strict-battery 验收」)。
///
/// **两类种子核的东西不一样**(plan §7.1a,⛔ 别把四个 task 种子也拿去与默认值盲比):
///
/// * 六个都核:行在 + `kind` + `system` + `created_at`。这三格是**出生字段**——协议禁
///   `set_field`(白名单只有 `title`/`position`),存储层另有 `trg_board_column_birth_immutable`
///   冻结 kind/system ⇒ 任何一格漂了都不是用户干的,是 bug 或库被改过。
/// * `system=1` 那两个另核:`title` + `position` + `tombstoned_at IS NULL`。它们**永不接受
///   任何 op**(不变量 2),故这三格也恒是 canonical 值。
/// * 四个 task 种子的 `title`/`position`/`tombstoned_at` **刻意不核**:可改名、可排序、可删
///   ⇒ 那是**用户数据**,由合并后的 oplog 物化(B-c 的 op-backed 语义审计管它,不归这里)。
///
/// ⚠ 诚实边界:它答得了「这六行还是不是它们自己」,答不了「有没有多出一个假冒的系统列」
/// ——那一格归 B-c 的出生校验(「非保留 id 却 `system=1`」)。
pub(crate) fn audit_seed_columns(conn: &Connection) -> Result<(), String> {
    for seed in SEED_COLUMNS {
        let row = conn
            .query_row(
                "SELECT title, kind, system, position, created_at, tombstoned_at \
                 FROM board_column WHERE id = ?1",
                [seed.id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .map_err(|e| format!("种子列「{}」读不到({e})——库结构残缺,整体拒", seed.id))?;
        let (title, kind, system, position, created_at, tombstoned_at) = row;
        if kind != seed.kind {
            return Err(format!(
                "种子列「{}」的 kind 是「{kind}」,应为「{}」(出生字段被改写)",
                seed.id, seed.kind
            ));
        }
        if system != i64::from(seed.system) {
            return Err(format!(
                "种子列「{}」的 system 是 {system},应为 {}(出生字段被改写)",
                seed.id,
                i64::from(seed.system)
            ));
        }
        if created_at != seed.created_at {
            return Err(format!(
                "种子列「{}」的 created_at 是「{created_at}」,应为「{}」\
                 (它是迁移里写死的 canonical 字面量,漂了 = 两端会分叉)",
                seed.id, seed.created_at
            ));
        }
        if !seed.system {
            continue;
        }
        if title != seed.canonical_title {
            return Err(format!(
                "系统列「{}」的 title 是「{title}」,应为「{}」(系统列不可改名)",
                seed.id, seed.canonical_title
            ));
        }
        if position != seed.position {
            return Err(format!(
                "系统列「{}」的 position 是「{position}」,应为「{}」(系统列不可排序)",
                seed.id, seed.position
            ));
        }
        if tombstoned_at.is_some() {
            return Err(format!("系统列「{}」带着墓碑标记——系统列不可删除", seed.id));
        }
    }
    Ok(())
}

/// 看板列的 op-backed 语义审计 —— **词汇 / 坐标 / 值 / 墓碑 marker 四轴**,双侧可跑。
///
/// `prefix` 同 `boot::audit_device_profile_semantics`:`""` = 本库,`"boot."` = 只读挂载的
/// 快照(**attached 库的 CHECK/PK 可被篡改,不信 schema、实查**);`who` 只进话术。
///
/// ⭐ **为什么快照侧也要单独跑一遍**(照 space / device / comment 三次同型的判例):引导会把
/// 四个 task 种子**从合并后的日志物化**,于是「快照的行与它自己的日志矛盾」这种损坏会被
/// 合并**顺手修好**、再让 battery 误过。⇒ 绝不让下方的合并物化替源库掩盖问题。
///
/// # 分工(⛔ 每条只写一遍,别在别处再描述一次)
///
/// * 「无 create 背书的用户列」→ `boot::count_unbacked_rows`(它是登记表第 ⑦ 面,
///   且 `check_fresh_to_account` 与导入审计两个消费者共用同一条判据);
/// * 「有墓碑 op 却没盖 marker」→ `boot::audit_tombstone_resurrection`(第 ⑥ 面);
/// * 「set_field/tombstone 指向无行无背书的列 / set-before-create」→
///   `boot::audit_op_preconditions`(第 ⑧ 面);
/// * 出生字段是否还是 canonical → [`audit_seed_columns`]。
pub(crate) fn audit_board_column_semantics(
    conn: &Connection,
    prefix: &str,
    who: &str,
) -> Result<(), String> {
    let one = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    let seeds = seed_ids_sql();
    let system_seeds = id_set_sql(SEED_COLUMNS.iter().filter(|s| s.system).map(|s| s.id));

    // ① 词汇与坐标合规。NULL 语义照 space/device 那两只:`json_extract` 缺键、被篡改的
    //    attached 库列为 NULL 时 `<>` 是三值逻辑、不计入 ⇒ 一律先 COALESCE 再比。
    //    (a) kind 只有三种;(b) set_field 的字段名只有 title | position。
    let bad_ops = one(&format!(
        "SELECT COUNT(*) FROM {prefix}oplog WHERE entity = 'board_column' AND ( \
             COALESCE(kind, '') NOT IN ('create', 'set_field', 'tombstone') \
             OR (COALESCE(kind, '') = 'set_field' \
                 AND COALESCE(json_extract(payload, '$.field'), '') NOT IN ('title', 'position')))"
    ))?;
    if bad_ops > 0 {
        return Err(format!(
            "看板列语义审计({who}):{bad_ops} 条 board_column op 词汇非法\
             (只认 create/set_field/tombstone,且 set_field 只改 title|position),整体回滚"
        ));
    }
    // (c) **灵感那两列身上一枚 op 都不许有**(不变量 2 是全局的,远端也不许违反)。
    //     ⚠ 这一格与 replay 的 shape 闸是同一条规则的两个入口:那道守 live,这道守
    //     **快照直接携带**的日志 —— boot 是 `INSERT … SELECT`,根本不过 shape 校验。
    let system_ops = one(&format!(
        "SELECT COUNT(*) FROM {prefix}oplog \
          WHERE entity = 'board_column' AND entity_id IN {system_seeds}"
    ))?;
    if system_ops > 0 {
        return Err(format!(
            "看板列语义审计({who}):{system_ops} 条 op 打在系统列(灵感两列)身上\
             ——它们不可改名、不可删、不可改 kind(不变量 2),整体回滚"
        ));
    }
    // (d) **六个种子都不发 create**(§7.1a):收到即坏。
    let seed_creates = one(&format!(
        "SELECT COUNT(*) FROM {prefix}oplog \
          WHERE entity = 'board_column' AND kind = 'create' AND entity_id IN {seeds}"
    ))?;
    if seed_creates > 0 {
        return Err(format!(
            "看板列语义审计({who}):{seed_creates} 条内置列的 create op\
             ——六个种子是 schema 提供的,永无 create(§7.1a),整体回滚"
        ));
    }

    // ② op 在行缺:有 create 背书的列必须有行。⛔ **与 item/topic 那条不同 —— 有 tombstone
    //    也照样必须有行**(不变量 5:列行永不物理删除,墓碑只是标志位)。
    let missing = one(&format!(
        "SELECT COUNT(*) FROM (SELECT DISTINCT entity_id FROM {prefix}oplog \
             WHERE entity = 'board_column' AND kind = 'create') o \
         WHERE NOT EXISTS (SELECT 1 FROM {prefix}board_column c WHERE c.id = o.entity_id)"
    ))?;
    if missing > 0 {
        return Err(format!(
            "看板列语义审计({who}):{missing} 个有 create op 的列没有行\
             ——列行永不物理删除(不变量 5),整体回滚"
        ));
    }

    // ③ 值不符(**用户列**):title / position == 自身日志的 LWW 赢家。走共享的
    //    `count_field_mismatches`,它的扫描面就是「有 create 背书的行」⇒ 六个种子天然在外。
    for field in ["title", "position"] {
        let bad = crate::sync::boot::count_field_mismatches(
            conn,
            prefix,
            "board_column",
            "board_column",
            field,
            Some(field),
        )?;
        if bad > 0 {
            return Err(format!(
                "看板列语义审计({who}):{bad} 个用户列的 {field} 与自身日志的 LWW 赢家不符\
                 (状态与日志矛盾),整体回滚"
            ));
        }
    }

    // ④ 值不符(**四个 task 种子**,schema-seeded implicit genesis):它们没有 create,
    //    故赢家 = 该字段全部 set_field 里 HLC 最大者;**一条 op 都没有时兜底值是
    //    [`SEED_COLUMNS`] 里那份 canonical**(⛔ 不是「没 op 就不查」——那样快照随手改一个
    //    种子标题就能穿过审计)。
    for seed in SEED_COLUMNS.iter().filter(|s| !s.system) {
        for (field, canonical) in
            [("title", seed.canonical_title), ("position", seed.position)]
        {
            let winner: Option<Option<String>> = conn
                .query_row(
                    &format!(
                        "SELECT json_extract(payload, '$.value') FROM {prefix}oplog \
                          WHERE entity = 'board_column' AND entity_id = ?1 AND kind = 'set_field' \
                            AND json_extract(payload, '$.field') = ?2 \
                          ORDER BY hlc DESC LIMIT 1"
                    ),
                    (seed.id, field),
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            // 赢家的 value 为 JSON null 在 shape 层就被拒了(title/position 都不接受 null)
            // ⇒ 这里落到 `None` 只可能是「日志被篡改」,当损坏拒,⛔ 别退回 canonical。
            let expect = match winner {
                Some(Some(v)) => v,
                Some(None) => {
                    return Err(format!(
                        "看板列语义审计({who}):内置列「{}」的 {field} 赢家是 null\
                         ——协议不接受(排序键永不清、标题不可为空),整体回滚",
                        seed.id
                    ))
                }
                None => canonical.to_string(),
            };
            let actual: Option<String> = conn
                .query_row(
                    &format!("SELECT {field} FROM {prefix}board_column WHERE id = ?1"),
                    [seed.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if actual.as_deref() != Some(expect.as_str()) {
                return Err(format!(
                    "看板列语义审计({who}):内置列「{}」的 {field} 是 {actual:?},\
                     按自身日志应为「{expect}」(状态与日志矛盾),整体回滚",
                    seed.id
                ));
            }
        }
    }

    // ⑤ 墓碑 marker 的**值**:非空时必须 == 该列全部 tombstone op 的 **MIN(hlc)**。
    //    ⚠ 是 **MIN 不是 MAX**(plan §2.3 定形 2 的确定性 min):两端各自删同一个空列是
    //    完全合法的用户操作,取 min 才让两端收敛到同一枚。
    //    ⚠ 反方向那半(「有墓碑 op 却没盖 marker」)在 `boot::audit_tombstone_resurrection`。
    //    ⚠ 「marker 非空却一条 tombstone op 都没有」也在这条里:`MIN` 取不到值 ⇒ 不相等。
    let bad_marker = one(&format!(
        "SELECT COUNT(*) FROM {prefix}board_column c WHERE c.tombstoned_at IS NOT NULL \
           AND NOT (c.tombstoned_at IS (SELECT MIN(o.hlc) FROM {prefix}oplog o \
                     WHERE o.entity = 'board_column' AND o.kind = 'tombstone' \
                       AND o.entity_id = c.id))"
    ))?;
    if bad_marker > 0 {
        return Err(format!(
            "看板列语义审计({who}):{bad_marker} 个列的墓碑标记 ≠ 自身日志里最小的那枚\
             tombstone HLC(确定性 min 被破坏,两端会分叉),整体回滚"
        ));
    }
    Ok(())
}

/// 墓碑授权表的**空表审计**(plan §2.3「授权行泄漏」那节,八轮把它的定位改准了)。
///
/// ⭐ **它不是**「防止第二枚正常 op 重复授权」的机制 —— 那件事由
/// `trg_board_column_tombstone_consume` 在触发器里当场消费授权行做掉(⑥),
/// 不靠 apply 记得删。**这道审计只干三件**:发现实现 bug、报告残留状态、
/// 在 boot / strict battery 上 fail-closed。
///
/// 判据 = 常态恒空:授权行的生命周期整个关在一枚 tombstone 的写事务里(先记 oplog →
/// 登记授权 → UPDATE 行 → ⑥ 消费),事务失败即随回滚消失。**跨事务还留着 = 有一条路径
/// 绕过了 ⑥**,那是 H 级数据损坏路径的信号,⛔ 别当成清理没做干净就顺手删了了事。
pub(crate) fn audit_tombstone_apply_empty(conn: &Connection) -> Result<(), String> {
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM sync_board_column_tombstone_apply", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if n > 0 {
        return Err(format!(
            "墓碑授权表残留 {n} 行(常态恒空)——有路径绕过了 trg_board_column_tombstone_consume,\
             整体拒;⛔ 别直接删了事,先查那条路径"
        ));
    }
    Ok(())
}

// ---- 写命令面(建列 / 改名 / 排序 / 删列;plan §8.1-2、B-c 第 3 段) -------------------
//
// ⭐ **这是唯一会往外发 `board_column` op 的路**(plan §8.4)。四条命令都照 topic 那套
// 的形(`notes::create_topic` / `rename_topic` / `reorder_topic` / `delete_topic`):
// 自持事务、改行 + 发 op 同一笔、fail-fast 不静默 no-op。
//
// ⛔ **命令层不是唯一入口**(plan §2.3 那三条已证实的旁路:远端 op 不过命令层 / boot 是
// `INSERT…SELECT` / epoch 基线直写 staging oplog)⇒ 这里每一道拒绝都要先想清楚它属哪一类:
// **全局不变量**(远端也不许违反)要在 shape/存储层另有守护;**本地命令前置**(合法的
// 远端事实要放行)才只住在这儿。逐条见各函数头注与 [`undeletable_reason`]。
//
// ⚠ **刻意不拒重名**:两台设备离线各建一个「本周」是完全合法的,拒不掉也不该拒
// (topic 那边拒重名是因为 `topic_id_by_title` 真有按名查找的消费者;列只按 id 认人)。
//
// ⭐ **四条一律先过发送端闸**([`gate::ensure_can_emit`],plan §5;B-e 第 1 段起):
// 它们发的是 `board_column/*` op —— 旧端的词汇表 CHECK 认不得 ⇒ `UnsupportedVocab` ⇒
// **整条 origin 挂起**。⚠ 这一档比拖卡那条(`item/set_field{stage}` 带自定义列 id ⇒
// `InvalidOp` = per-origin **持久隔离**)轻,但同样会把对端的同步停住,故**不分 seed 还是
// 自定义列、一律要闸**:给 `todo` 改个名发的也是 `board_column/set_field`。
// ⛔ 别照「拖卡那条只在目标是自定义列时才要闸」的形去给这四条也加个条件 —— 那条的判据是
// 「op 的 payload 里有没有旧端不认识的值」,这四条的判据是「op 的 entity 旧端认不认识」。

/// 建一个新的任务列,落在**全部列的末键之后**。返回它的 id(新铸 ULID)。
///
/// ⛔ **只能建 task 列**:`kind='task'` + `system=0` 是写死的,不给参数 —— 灵感那两列由
/// schema 提供(不变量 2),而 shape 层的 create 那一臂正是按这个推导把两个键钉死的
/// (「六个种子都不发 create ⇒ entity_id 恒非保留 id ⇒ system 恒 0 ⇒ 表级
/// `CHECK (system = 1 OR kind = 'task')` 逼出 kind='task'」)。
///
/// ⚠ **末键取的是全表最大值,含已 tombstone 的行**:列行永不物理删除(不变量 5),
/// 让新列去顶一个死列的键只会造出并列。⇒ 键单调增长,新列恒在最右。
pub fn create_column(
    conn: &mut Connection,
    clock: &mut Clock,
    title: &str,
    facts: &gate::RuntimeFacts,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("列名不能为空".to_string());
    }
    repo::ensure_content_fits(title)?;
    let id = Ulid::new().to_string();
    // ⛔ **`now_iso_millis` 不是 `now_iso`**:shape 层的 create 那一臂走 `validate_iso_millis`
    // (定宽 `…THH:MM:SS.sssZ`),而 `now_iso` 出的是不带毫秒的 RFC3339 ⇒ 换成它,本机
    // 一切正常、op 到**对端**才被判 `InvalidOp` = per-origin 持久隔离(plan §4.0)。
    // ⚠ 这类「本地发端与收端 shape 不同源」的缺陷本地测照不出来,故那只建列测把刚发的 op
    // 原样送去过一遍 `validate_op_shape`(`wire_shape_ok`)—— 那才是这一句的守卫。
    //
    // ⚠ 这里**刻意没有**「id 是不是 26 位严格 ULID」的自检:`Ulid::new()` 的首字符由 48 位
    // 毫秒时间戳的高 3 位定,要越过 `'7'` 得等到公元 3084 年 ⇒ 那是不可达的防护(清单 5)。
    // 形态由那只测的 `is_new_column_id` 断言钉住,不由死码守。
    let created_at = repo::now_iso_millis();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // ⭐ **闸排在全部本地前置之前**(plan §5.1 是顶层谓词):它问的是「本机此刻能不能
    //    往外发这种 op」,与改的是哪一列无关。在事务里问,故它读到的配置键与下面
    //    这笔写是同一个快照(首版自检清单 10)。
    gate::ensure_can_emit(&tx, facts)?;
    let last: Option<String> = tx
        .query_row("SELECT position FROM board_column ORDER BY position DESC LIMIT 1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let position = frindex::key_between(last.as_deref(), None)?;
    tx.execute(
        "INSERT INTO board_column (id, title, kind, system, position, created_at) \
         VALUES (?1, ?2, 'task', 0, ?3, ?4)",
        (&id, title, &position, &created_at),
    )
    .map_err(|e| format!("建列失败({id}):{e}"))?;
    // 读行发声:payload 的五格全从刚落的行上读回,⛔ 别在这里另攒一份。
    oplog::board_column_create(&tx, clock, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// 给一列改名。系统列拒(不变量 2)、已删的列拒(只读收容区,plan §4.3)。
///
/// ⭐ **`todo`/`done` 照改不误**:[`undeletable_reason`] 那条只禁删 —— 「待办」改名成
/// 「本周」时 id 没变,挂在这一列上的产品语义一格都没动。
pub fn rename_column(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    title: &str,
    facts: &gate::RuntimeFacts,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("列名不能为空".to_string());
    }
    repo::ensure_content_fits(title)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // ⭐ **闸排在全部本地前置之前**(plan §5.1 是顶层谓词):它问的是「本机此刻能不能
    //    往外发这种 op」,与改的是哪一列无关。在事务里问,故它读到的配置键与下面
    //    这笔写是同一个快照(首版自检清单 10)。
    gate::ensure_can_emit(&tx, facts)?;
    ensure_editable(&tx, id, "改名")?;
    let n = tx
        .execute("UPDATE board_column SET title = ?2 WHERE id = ?1", (id, title))
        .map_err(|e| format!("改列名失败({id}):{e}"))?;
    if n != 1 {
        return Err(format!("改列名失败:影响行数 {n}"));
    }
    oplog::board_column_set(&tx, clock, id, &["title"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 把一列拖到两个邻居之间(`prev_id` / `next_id`,`None` = 真·列端边界)。
///
/// 形与 `notes::reorder_topic` 逐条同构:**只重写被拖那一列**(一条 op),新键由邻居的
/// **当前**键算出;指名的邻居若没有行则 fail-fast —— ⛔ 别把它当开边界,那会让
/// `key_between` 悄悄落到列首/尾、静默错排。
///
/// ⚠ **邻居不筛死活、也不筛 kind**:列行永不物理删除,一个已 tombstone 的列仍然占着
/// 排序轴上的那个位置,拿它的键算中点是正确的。UI 只在活着的任务列之间拖 ⇒ 那一格
/// 由调用方的可见集合决定,不由这里再判一次(判了也只是把 UI 的取舍抄第二遍)。
pub fn reorder_column(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    prev_id: Option<&str>,
    next_id: Option<&str>,
    facts: &gate::RuntimeFacts,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // ⭐ **闸排在全部本地前置之前**(plan §5.1 是顶层谓词):它问的是「本机此刻能不能
    //    往外发这种 op」,与改的是哪一列无关。在事务里问,故它读到的配置键与下面
    //    这笔写是同一个快照(首版自检清单 10)。
    gate::ensure_can_emit(&tx, facts)?;
    ensure_editable(&tx, id, "排序")?;
    let resolve = |who: &str, nb: Option<&str>| -> Result<Option<String>, String> {
        let Some(nid) = nb else { return Ok(None) };
        let key: Option<String> = tx
            .query_row("SELECT position FROM board_column WHERE id = ?1", [nid], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        key.map(Some).ok_or_else(|| format!("{who}的列已不存在,已忽略本次排序,请重试"))
    };
    let prev = resolve("前一个", prev_id)?;
    let next = resolve("后一个", next_id)?;
    let key = frindex::key_between(prev.as_deref(), next.as_deref())?;
    let n = tx
        .execute("UPDATE board_column SET position = ?2 WHERE id = ?1", (id, &key))
        .map_err(|e| format!("列排序写入失败({id}):{e}"))?;
    if n != 1 {
        return Err(format!("列排序写入失败:影响行数 {n}"));
    }
    oplog::board_column_set(&tx, clock, id, &["position"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 删一列 = **盖墓碑,⛔ 不删行**(不变量 5)。四道拒绝,逐条见下。
///
/// # 四道拒绝分别属哪一类(⛔ 别把它们当成同一种东西)
///
/// | 拒 | 类别 | 别处还有谁守 |
/// |---|---|---|
/// | 行不在 | 本地前置 | — |
/// | 不许删(系统列 / 角色列) | 系统列 = **全局不变量**(shape + 存储层 ②);角色列 = **本地命令前置**(仅此一道,理由见 [`undeletable_reason`]) | |
/// | 已经删过了 | 本地前置(幂等在**回放**那边:`apply` 取 min、等值 no-op) | |
/// | 还有 live 条目(不变量 4) | **本地命令前置** | 存储层 ① 那只**带回放豁免**的守护 |
///
/// ⭐ 最后一道**刻意两处都写**,分工是:这里给用户一句可行动的话(**带条数**,触发器给不出),
/// 触发器挡住任何绕过命令层的本地写。两份判据逐字同口径([`live_item_count`] 头注)。
/// ⚠ 它俩漂了的话是**响亮**的(一边放一边拒,当场看得见),不是静默错 —— 这是接受
/// 这份重复的理由。
///
/// # 写入顺序被授权表钉死:**先发 op → 再登记授权 → 再改行**
///
/// §2.3 ④ 那只不带豁免的守护逐字段核 `op_id`/`from_hlc`/`to_hlc`/`mode`,并要求 oplog 里
/// 真有这一枚 tombstone op;⑥(AFTER)在行真的改了之后当场消费掉授权行。
/// ⛔ 别在这里写 `DELETE FROM sync_board_column_tombstone_apply` —— 「事务提交了但忘删」
/// 那条路正是八轮用触发器消费堵死的。
pub fn delete_column(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    facts: &gate::RuntimeFacts,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // ⭐ **闸排在全部本地前置之前**(plan §5.1 是顶层谓词):它问的是「本机此刻能不能
    //    往外发这种 op」,与改的是哪一列无关。在事务里问,故它读到的配置键与下面
    //    这笔写是同一个快照(首版自检清单 10)。
    gate::ensure_can_emit(&tx, facts)?;
    let row: Option<(i64, Option<String>)> = tx
        .query_row(
            "SELECT system, tombstoned_at FROM board_column WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((system, tombstoned_at)) = row else {
        return Err(format!("列不存在:{id}"));
    };
    if let Some(why) = undeletable_reason(id, system == 1) {
        return Err(why);
    }
    if tombstoned_at.is_some() {
        return Err(format!("这一列已经删除了:{id}"));
    }
    let live = live_item_count(&tx, id).map_err(|e| e.to_string())?;
    if live > 0 {
        return Err(format!("该列还有 {live} 个未归档条目,请先移走再删除"));
    }
    let (op_id, hlc) = oplog::board_column_tombstone(&tx, clock, id)?;
    // ⚠ `from_hlc` 恒 NULL:上面刚判过这一列没有 marker。⛔ 别改成「读回当前值」——
    // 那会让「本地删一个已删的列」看起来像合法的 min 合并,而本地那条路只许 NULL → hlc
    // (plan §2.3 定形 3);已有 marker 的合并是**回放**的事。
    tx.execute(
        "INSERT INTO sync_board_column_tombstone_apply \
             (column_id, op_id, from_hlc, to_hlc, mode) \
         VALUES (?1, ?2, NULL, ?3, 'apply_min')",
        (id, &op_id, &hlc),
    )
    .map_err(|e| format!("登记列墓碑授权失败({id}):{e}"))?;
    let n = tx
        .execute("UPDATE board_column SET tombstoned_at = ?2 WHERE id = ?1", (id, &hlc))
        .map_err(|e| format!("删列失败({id}):{e}"))?;
    if n != 1 {
        return Err(format!("删列失败:影响行数 {n}"));
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 改名 / 排序共用的前置:行要在、不是系统列、没盖墓碑。
///
/// ⛔ **系统列这一道与「不许删」是两回事**:`inbox`/`filed` 连改名和排序一起禁
/// (不变量 2),而 [`ROLE_COLUMNS`] 那两列只禁删。别把两者合并成一个谓词。
fn ensure_editable(tx: &Connection, id: &str, what: &str) -> Result<(), String> {
    let row: Option<(i64, Option<String>)> = tx
        .query_row(
            "SELECT system, tombstoned_at FROM board_column WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((system, tombstoned_at)) = row else {
        return Err(format!("列不存在:{id}"));
    };
    if system == 1 {
        return Err(format!("「{id}」是系统列(灵感),不可{what}"));
    }
    if tombstoned_at.is_some() {
        return Err(format!("这一列已删除,不可{what}(已删的列是只读的)"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
