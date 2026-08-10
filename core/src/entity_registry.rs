//! 同步实体登记表与结构锚 —— 「加一个新实体要改几处」这件事的**单一清单**。
//!
//! # 为什么存在
//!
//! 这个库里的每个 oplog 实体(`item` / `topic` / `link` / `image` / `space` / `device` /
//! `comment`)都要在**九个互不相邻的横切面**上各登记一次:词汇表、catalog 核心表、压实
//! 指纹、压实基线、引导导入、墓碑复活审计、无背书行、依赖前置、收敛指纹。少登记一处,
//! 后果从「catalog 拒开库」到「第一次删掉带留言的条目之后那个库永远过不了电池」不等,
//! 而**漏掉的那一处不会自己报错**——它只是少干活。
//!
//! 2026-08-06 加 `comment` 时的实测:我自己列出 10 处落地面,设计审补出 7 处,其中五处
//! 就在这九个面里(identity-plan §4.3 第 11-16 条)。**靠人记清单已经证明记不全。**
//!
//! # 它守什么
//!
//! [`ENTITIES`] 是声明,九个提取器从**源码本身**解析出「实际登记了谁」,两边比对。
//! 于是:
//!
//! - 加了新实体却漏掉某个面 → 该面的实际集合缺一项 → 红;
//! - 表里声称登记了、源码里其实没做 → 同样红;
//! - 加一个新面 = [`Entity`] 加一个字段,**编译器强制每个实体都填**(这是本表选具名字段
//!   而不是数组的唯一理由——数组能少写几行,但漏填一格只是长度不齐,不是编译错)。
//!
//! # 它**不**守什么(如实写明,别当它是全覆盖)
//!
//! 1. **九个面之外的落地面不在此列**:两壳命令面、前端 UI、`replay` 的分发臂与
//!    `validate_op_shape`、`VALIDATOR_VER` 的 bump、`move_item` 的跨空间随迁。前两者靠
//!    e2e 与真机验收;后三者对**既有**实体的破坏会被既有行为测打红,但对**新**实体不会——
//!    漏 replay 两臂的真实形态是「同版本对端的合法 op 落 UnsupportedVocab → 该 origin
//!    挂起 + 误导性升级提示」(validate 兜底臂)或撞分发臂的 `unreachable!`,得靠新实体
//!    **自带**的回放/收敛测试兜(每加实体必配:314 comment、329 device 两判例)。故本轮
//!    不铺第十面,但别拿「既有测会红」当理由跳过那两处——那句对新实体是假的。
//! 2. **[`Match::Superset`] 的面守漏登记、不守假登记**:那几处的实际集合里本就混着非实体
//!    表(`oplog` / `sync_meta` / `item_revisions` …),要求精确相等就得再维护一份「非实体
//!    表」名单,那是把同一个腐烂点搬个家。
//! 3. **「进了表」不等于「被覆盖」**:`convergence` 那一面只验表进没进指纹 SQL,验不了
//!    随机命令流真的产过这个实体的 op。314 给 `comment` 配的 `COMMENT_ADDS`/`COMMENT_REMOVES`
//!    覆盖计数才是那一格的判据,本锚不复制它。

use crate::test_src::{
    const_body, fn_body, sql_from_tables, sql_insert_tables, str_literals, strip_line_comments,
    Repo,
};
use std::collections::BTreeSet;

/// 一个实体在某个横切面上的登记状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Facet {
    /// 必须登记:锚在源码里验证它**真的**出现在那一面上。
    Required,
    /// 结构上不适用:锚验证它**不**出现。理由字符串非空由锚断言(空理由 = 没想过)。
    NotApplicable(&'static str),
    /// 该有但今天没有 —— **已知缺口**。锚验证它不出现(与 `NotApplicable` 同行为),
    /// 但测试末尾会把每一条响亮列出,且 Gap 总数受 [`GAP_BUDGET`] 硬限:新开一个口子
    /// 必须显式改那个数字,不许悄悄多一条。
    ///
    /// ⚠ **328 起没有任何一格在用它**(327 那条唯一的缺口 —— device 的收敛覆盖 —— 已补齐,
    /// 预算随之降到 0),故编译器报 `never constructed`。**刻意留着而不删**:这张表最怕的
    /// 事是把缺陷写成 [`Facet::NotApplicable`] 合法化,而「没有诚实落点」时那恰恰是最省事的
    /// 写法。留着它,下次发现缺口的人有个不必撒谎的格子填。
    ///
    /// 它不是死码而是**今天为空的机制**,字据 = 变异对照:把任一格 `Required` 翻成 `Gap`
    /// 而不动预算,锚当场红(328 跑过)。
    #[allow(dead_code)]
    Gap(&'static str),
}

impl Facet {
    fn is_required(self) -> bool {
        matches!(self, Facet::Required)
    }
    /// `NotApplicable` / `Gap` 携带的理由(`Required` 无理由)。
    fn reason(self) -> Option<&'static str> {
        match self {
            Facet::Required => None,
            Facet::NotApplicable(r) | Facet::Gap(r) => Some(r),
        }
    }
}

/// 一个同步实体在九个横切面上的登记。
///
/// **加字段 = 加一个面**,每个实体都得填一格,编译器不许漏。
struct Entity {
    /// oplog 词汇表里的 entity 名(本表主键)。
    name: &'static str,
    /// 它的物化表名。
    table: &'static str,

    /// ① oplog 词汇表(最新那条重建 `oplog` 的迁移里的 CHECK)。
    vocab: Facet,
    /// ② `spaces::CORE_TABLES` —— 缺表 = catalog 当场拒,不拖到写入时。
    core_tables: Facet,
    /// ③ `epoch::table_fingerprints` —— 压实终态等价检查。
    compact_fingerprint: Facet,
    /// ④ `epoch::synthesize_baseline` —— 压实时合成 op 基线。
    compact_baseline: Facet,
    /// ⑤ `boot::import_attached` —— 引导快照的表级导入 / 物化。
    boot_import: Facet,
    /// ⑥ `boot::audit_tombstone_resurrection` —— 有墓碑就不许还有行。
    tombstone_audit: Facet,
    /// ⑦ `boot::count_unbacked_rows` —— 无 create 背书的行要在请求快照**前**就拒。
    unbacked_rows: Facet,
    /// ⑧ `boot::audit_op_preconditions` —— 父依赖与因果序(漏了能造出「boot 过得去、
    /// live 永久 DependencyMissing」的快照)。
    op_preconditions: Facet,
    /// ⑨ `convergence::FINGERPRINTS` —— 三实例收敛 property test 的比对面。
    convergence: Facet,
}

/// 全部同步实体。**新增实体 = 这里加一行**,九格填满。
const ENTITIES: &[Entity] = &[
    Entity {
        name: "item",
        table: "items",
        vocab: Facet::Required,
        core_tables: Facet::Required,
        compact_fingerprint: Facet::Required,
        compact_baseline: Facet::Required,
        boot_import: Facet::Required,
        tombstone_audit: Facet::Required,
        unbacked_rows: Facet::Required,
        op_preconditions: Facet::Required,
        convergence: Facet::Required,
    },
    Entity {
        name: "topic",
        table: "topics",
        vocab: Facet::Required,
        core_tables: Facet::Required,
        compact_fingerprint: Facet::Required,
        compact_baseline: Facet::Required,
        boot_import: Facet::Required,
        tombstone_audit: Facet::Required,
        unbacked_rows: Facet::Required,
        op_preconditions: Facet::Required,
        convergence: Facet::Required,
    },
    Entity {
        name: "link",
        table: "item_topic",
        vocab: Facet::Required,
        core_tables: Facet::Required,
        compact_fingerprint: Facet::Required,
        compact_baseline: Facet::Required,
        boot_import: Facet::Required,
        tombstone_audit: Facet::NotApplicable(
            "link 没有 tombstone(它的删是 link_remove,OR-set 的移除半边),\
             「有墓碑却还有行」这个形对它不成立",
        ),
        unbacked_rows: Facet::Required,
        op_preconditions: Facet::Required,
        convergence: Facet::Required,
    },
    Entity {
        name: "image",
        table: "item_image",
        vocab: Facet::Required,
        core_tables: Facet::Required,
        compact_fingerprint: Facet::Required,
        compact_baseline: Facet::Required,
        boot_import: Facet::Required,
        tombstone_audit: Facet::Required,
        unbacked_rows: Facet::Required,
        op_preconditions: Facet::Required,
        convergence: Facet::Required,
    },
    Entity {
        name: "space",
        table: "space_profile",
        vocab: Facet::Required,
        core_tables: Facet::Required,
        compact_fingerprint: Facet::Required,
        compact_baseline: Facet::Required,
        boot_import: Facet::Required,
        tombstone_audit: Facet::NotApplicable(
            "单例 LWW 寄存器:词汇里只有 set_field,没有 create 也没有 tombstone",
        ),
        unbacked_rows: Facet::NotApplicable(
            "同上——没有 create,「无 create 背书的行」这个判据对寄存器不成立;\
             它的行↔op 一致性由 boot::audit_space_profile_semantics 双侧预审管",
        ),
        op_preconditions: Facet::NotApplicable(
            "寄存器没有父实体,不存在依赖前置与因果序",
        ),
        convergence: Facet::Required,
    },
    Entity {
        name: "device",
        table: "device_profile",
        vocab: Facet::Required,
        core_tables: Facet::Required,
        compact_fingerprint: Facet::Required,
        compact_baseline: Facet::Required,
        boot_import: Facet::Required,
        tombstone_audit: Facet::NotApplicable("多实例 LWW 寄存器,理由同 space"),
        unbacked_rows: Facet::NotApplicable(
            "同上——无 create;行↔op 一致性由 boot::audit_device_profile_semantics 双侧预审管",
        ),
        op_preconditions: Facet::NotApplicable("寄存器没有父实体,理由同 space"),
        // 327 立项时这一格是本表唯一一条 `Gap`(301 落地 device 时漏了收敛覆盖,而
        // 314 给 comment 两边都补了);328 已补齐:`FINGERPRINTS` 加 device_profile 一行 +
        // `random_command` 加一支 set_device_alias(命名对象从 origin 池里挑,故 LWW 撞写
        // 真会发生)+ DEVICE_ALIAS_SETS/CLEARS 两个覆盖计数把「零覆盖的空绿」堵掉。
        convergence: Facet::Required,
    },
    Entity {
        name: "comment",
        table: "item_comment",
        vocab: Facet::Required,
        core_tables: Facet::Required,
        compact_fingerprint: Facet::Required,
        compact_baseline: Facet::Required,
        boot_import: Facet::Required,
        tombstone_audit: Facet::Required,
        unbacked_rows: Facet::Required,
        op_preconditions: Facet::Required,
        convergence: Facet::Required,
    },
];

/// 今天允许存在的 [`Facet::Gap`] 条数。**只许降不许升**——真要新开口子,连同理由一起
/// 改这个数字,那是个显式动作,不是悄悄多一条。
///
/// 327 立表时是 1(device 的收敛覆盖),**328 补齐后降到 0** —— 九个面上再没有已知缺口。
const GAP_BUDGET: usize = 0;

// ---- 面的描述:键取谁、从哪解析、怎么比 --------------------------------------------

/// 这个面按什么键登记。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    /// oplog 词汇里的 entity 名。
    Entity,
    /// 物化表名。
    Table,
}

/// 声明集合与实际集合怎么比。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Match {
    /// 恰好相等(在**已知键**范围内取交集之后比,故 `oplog` 之类的非实体表自动出局)。
    /// 同时守住漏登记与假登记。
    Exact,
    /// 只要求「声明 Required 的都在」。用于实际集合里本就混着非实体表的面 —— 那几处
    /// 要精确相等就得再维护一份非实体表名单,等于把腐烂点搬个家。
    Superset,
}

struct FacetSpec {
    /// 面名(错误消息里给人看的)。
    what: &'static str,
    /// 这一格在源码里的落点,给报错时指路。
    site: &'static str,
    key: Key,
    matching: Match,
    /// 从 [`Entity`] 里取这一格。
    pick: fn(&Entity) -> Facet,
    /// 从源码解析出「实际登记了谁」。
    extract: fn(&Repo) -> BTreeSet<String>,
}

const FACETS: &[FacetSpec] = &[
    FacetSpec {
        what: "oplog 词汇表",
        site: "core/migrations/<最新那条重建 oplog 的>.sql 的 CHECK",
        key: Key::Entity,
        matching: Match::Exact,
        pick: |e| e.vocab,
        extract: extract_vocab,
    },
    FacetSpec {
        what: "catalog 核心表",
        site: "core/src/spaces.rs 的 CORE_TABLES",
        key: Key::Table,
        matching: Match::Superset,
        pick: |e| e.core_tables,
        extract: extract_core_tables,
    },
    FacetSpec {
        what: "压实终态指纹",
        site: "core/src/epoch.rs 的 fn table_fingerprints",
        key: Key::Table,
        matching: Match::Superset,
        pick: |e| e.compact_fingerprint,
        extract: extract_compact_fingerprint,
    },
    FacetSpec {
        what: "压实 op 基线",
        site: "core/src/epoch.rs 的 fn synthesize_baseline",
        key: Key::Entity,
        matching: Match::Exact,
        pick: |e| e.compact_baseline,
        extract: extract_compact_baseline,
    },
    FacetSpec {
        what: "引导导入",
        site: "core/src/sync/boot.rs 的 fn import_attached",
        key: Key::Table,
        matching: Match::Superset,
        pick: |e| e.boot_import,
        extract: extract_boot_import,
    },
    FacetSpec {
        what: "墓碑复活审计",
        site: "core/src/sync/boot.rs 的 fn audit_tombstone_resurrection",
        key: Key::Entity,
        matching: Match::Exact,
        pick: |e| e.tombstone_audit,
        extract: extract_tombstone_audit,
    },
    FacetSpec {
        what: "无 create 背书的行",
        site: "core/src/sync/boot.rs 的 fn count_unbacked_rows",
        key: Key::Table,
        matching: Match::Exact,
        pick: |e| e.unbacked_rows,
        extract: extract_unbacked_rows,
    },
    FacetSpec {
        what: "op 依赖前置",
        site: "core/src/sync/boot.rs 的 fn audit_op_preconditions",
        key: Key::Entity,
        matching: Match::Exact,
        pick: |e| e.op_preconditions,
        extract: extract_op_preconditions,
    },
    FacetSpec {
        what: "三实例收敛指纹",
        site: "core/src/sync/convergence.rs 的 FINGERPRINTS",
        key: Key::Table,
        matching: Match::Superset,
        pick: |e| e.convergence,
        extract: extract_convergence,
    },
];

// ---- 九个提取器:从源码解析出「实际登记了谁」 ----------------------------------------
//
// 源码读取与切片件(Repo / strip_line_comments / fn_body / const_body / balanced /
// sql_from_tables / sql_insert_tables / str_literals)327 时首铸在本文件,后收拢成
// 共享工具箱 [`crate::test_src`](基底就是这份最硬化的,判例头注随件走)。

/// ① 词汇表:`entity = 'X'` 与 `entity IN ('X', 'Y')` 两种形。
fn extract_vocab(repo: &Repo) -> BTreeSet<String> {
    let src = repo.newest_oplog_migration();
    let mut out = BTreeSet::new();
    // 单值形:entity = 'X'
    for (i, _) in src.match_indices("entity = '") {
        let rest = &src[i + 10..];
        if let Some(end) = rest.find('\'') {
            out.insert(rest[..end].to_string());
        }
    }
    // 集合形:entity IN ('X', 'Y')
    for (i, _) in src.match_indices("entity IN (") {
        let rest = &src[i + 11..];
        let seg = &rest[..rest.find(')').unwrap_or(0)];
        for part in seg.split(',') {
            let t = part.trim().trim_matches('\'');
            if !t.is_empty() {
                out.insert(t.to_string());
            }
        }
    }
    out
}

/// ② `CORE_TABLES` 常量里的字符串字面量。
fn extract_core_tables(repo: &Repo) -> BTreeSet<String> {
    let src = repo.read("core/src/spaces.rs");
    let body = const_body(&src, "const CORE_TABLES: &[&str] = &");
    str_literals(&strip_line_comments(&body))
}

/// ③ `table_fingerprints` 函数体里 `FROM <表>` 的表名。
fn extract_compact_fingerprint(repo: &Repo) -> BTreeSet<String> {
    let src = repo.read("core/src/epoch.rs");
    sql_from_tables(&strip_line_comments(&fn_body(&src, "table_fingerprints")))
}

/// ④ `synthesize_baseline` 函数体里的字符串字面量(entity 名混在 kind / entity_id 里,
/// 由上层与已知实体名取交集自动分离)。
fn extract_compact_baseline(repo: &Repo) -> BTreeSet<String> {
    let src = repo.read("core/src/epoch.rs");
    str_literals(&strip_line_comments(&fn_body(&src, "synthesize_baseline")))
}

/// ⑤ `import_attached` 函数体里 `INSERT INTO <表>` 的表名(表级复制与 UPSERT 物化
/// 两种形都是这句起头)。
fn extract_boot_import(repo: &Repo) -> BTreeSet<String> {
    let src = repo.read("core/src/sync/boot.rs");
    sql_insert_tables(&strip_line_comments(&fn_body(&src, "import_attached")))
}

/// ⑥ `audit_tombstone_resurrection` 函数体里的字符串字面量。
fn extract_tombstone_audit(repo: &Repo) -> BTreeSet<String> {
    let src = repo.read("core/src/sync/boot.rs");
    str_literals(&strip_line_comments(&fn_body(&src, "audit_tombstone_resurrection")))
}

/// ⑦ `count_unbacked_rows` 函数体里 `FROM <表>` 的表名。
fn extract_unbacked_rows(repo: &Repo) -> BTreeSet<String> {
    let src = repo.read("core/src/sync/boot.rs");
    sql_from_tables(&strip_line_comments(&fn_body(&src, "count_unbacked_rows")))
}

/// ⑧ `audit_op_preconditions` 函数体里出现的实体名。**两个来源合并,缺一不可**:
///
/// - `for (entity, table) in [("item", "items"), …]` 那只循环里的 Rust 字面量 ——
///   item / topic 走参数绑定(`o.entity = ?1`),SQL 文本里根本没有它们的名字;
/// - `o.entity = 'X'` —— link / image / comment 是写死在 SQL 里的。
///
/// ⚠ **主语前缀 `o.` 不能省**(变异⑧的判例,首版就栽在这):该函数的子查询里满是
/// `xt.entity='topic'`、`ci.entity='item'` 这类**父实体**引用。不带前缀地搜 `entity='`
/// 会把父实体当成「被审计的实体」抓进来 —— 于是把 topic 自己那一支**整个删掉**,锚
/// 照样绿(topic 从 link 的父检查里被顶了包)。`o` 是本函数里「当前这条被审计的 op」
/// 的固定别名,`x`/`c`/`ci`/`ct`/`xi`/`xt` 才是父。
fn extract_op_preconditions(repo: &Repo) -> BTreeSet<String> {
    let src = repo.read("core/src/sync/boot.rs");
    let body = strip_line_comments(&fn_body(&src, "audit_op_preconditions"));
    let from_loop = str_literals(&body);
    let mut from_sql = BTreeSet::new();
    for pat in ["o.entity = '", "o.entity='"] {
        for (i, _) in body.match_indices(pat) {
            let rest = &body[i + pat.len()..];
            if let Some(end) = rest.find('\'') {
                from_sql.insert(rest[..end].to_string());
            }
        }
    }
    // 两个来源各自都得有货 —— 哪天 `o` 这个别名改了名,这里**响亮红**,而不是悄悄
    // 只剩循环那一半(那会让 link/image/comment 三格集体假绿)。
    assert!(
        !from_sql.is_empty(),
        "audit_op_preconditions 里一个 `o.entity = 'X'` 都没解析到 —— 那只循环之外的\
         三个实体(link / image / comment)是写死在 SQL 里的,一个都抓不到说明 `o` 这个\
         别名改了名,提取器要跟着改"
    );
    from_loop.into_iter().chain(from_sql).collect()
}

/// ⑨ `FINGERPRINTS` 常量里 `FROM <表>` 的表名(label 那半是给人看的话术,如
/// 「item_image(含字节)」,不能当表名解析)。
fn extract_convergence(repo: &Repo) -> BTreeSet<String> {
    let src = repo.read("core/src/sync/convergence.rs");
    let body = const_body(&src, "const FINGERPRINTS: &[(&str, &str)] = &");
    sql_from_tables(&strip_line_comments(&body))
}

// ---- 锚 ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn key_of(e: &Entity, k: Key) -> &'static str {
        match k {
            Key::Entity => e.name,
            Key::Table => e.table,
        }
    }

    /// 结构锚:[`ENTITIES`] 声明的九格,与从源码解析出的实际登记逐面比对。
    ///
    /// 四道防「静默变绿」(形照 312 `every_transport_submodule_is_scanned` /
    /// 326 `every_temp_dir_call_site_uses_a_swept_prefix`):
    ///
    /// 1. **读不动 / 找不着即 panic**:文件名、函数名、常量名任一改了都当场红,不许
    ///    「解析不到就当没有」——那正是本锚要防的死法。
    /// 2. **看不懂的形状一律红**:括号配不平就 panic,不猜。
    /// 3. **反向探针**:每个面至少要有一个 `Required`,且解析出的实际集合与已知键的交集
    ///    非空。提取器要是什么都没抓到(正则写错 / 源码换了形),这一条第一个红 ——
    ///    这比断一个「至少 N 项」的数字强,那种数字会随代码增删静默腐烂。
    /// 4. **Gap 有预算**:已知缺口逐条列出且总数受 [`GAP_BUDGET`] 限,新开口子是显式动作。
    #[test]
    fn every_entity_is_registered_on_every_facet() {
        let repo = Repo::open();

        // 表自身的卫生:主键不重、理由不空。
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for e in ENTITIES {
            assert!(seen.insert(e.name), "ENTITIES 里 {} 出现了两次", e.name);
            for f in FACETS {
                let facet = (f.pick)(e);
                if let Some(r) = facet.reason() {
                    assert!(
                        !r.trim().is_empty(),
                        "{} 在「{}」这一面填了 NotApplicable/Gap 却没写理由 —— \
                         空理由 = 没想过,不许过",
                        e.name,
                        f.what
                    );
                }
            }
        }

        // 防线 5(前门):下面每个面都先与 all_keys 取交集再比对——Superset 面的 raw
        // 混着非实体表(oplog/sync_meta/…),降噪是必要的;代价是「进了词汇表 CHECK、却
        // 忘在 ENTITIES 加行」的新实体会被交集静默滤掉,九面对它全部照绿,恰好复现本表
        // 要防的「漏掉的那处不会自己报错」。词汇表这一面的 raw 可证无噪声(CHECK 里只有
        // 实体名),单独反向核一遍,把「进清单」这个动作本身也纳入 fail-closed:
        {
            let vocab = extract_vocab(&repo);
            let all_keys: BTreeSet<String> =
                ENTITIES.iter().map(|e| e.name.to_string()).collect();
            let unregistered: Vec<&String> = vocab.difference(&all_keys).collect();
            assert!(
                unregistered.is_empty(),
                "词汇表 CHECK 里有 ENTITIES 没登记的实体:{unregistered:?} —— \
                 新实体先在 ENTITIES 加一行(前门),九面守护才对它生效。"
            );
        }

        for f in FACETS {
            let declared: BTreeSet<String> = ENTITIES
                .iter()
                .filter(|e| (f.pick)(e).is_required())
                .map(|e| key_of(e, f.key).to_string())
                .collect();
            let all_keys: BTreeSet<String> =
                ENTITIES.iter().map(|e| key_of(e, f.key).to_string()).collect();

            // 防线 3 上半:每个面都得有人 Required。全空 = 这一面什么都没守。
            assert!(
                !declared.is_empty(),
                "「{}」这一面一个 Required 都没有 —— 那它什么都不守",
                f.what
            );

            let raw = (f.extract)(&repo);
            let actual: BTreeSet<String> = raw.intersection(&all_keys).cloned().collect();

            // 防线 3 下半:解析出的实际集合与已知键交集为空 = 网根本没架上
            //(提取器的形状写错、或那处源码换了写法),而不是「真的一个都没登记」。
            assert!(
                !actual.is_empty(),
                "「{}」({})解析出的实际集合与已知实体没有交集 —— \
                 提取器没抓到东西(那处源码换形了?),不是那里真的空着。\
                 原始解析结果:{raw:?}",
                f.what,
                f.site
            );

            let missing: Vec<&String> = declared.difference(&actual).collect();
            assert!(
                missing.is_empty(),
                "「{}」漏登记:{missing:?}\n落点:{}\n\
                 —— 新实体要在这一面也登记一次;真不适用就把 ENTITIES 里那一格改成 \
                 NotApplicable 并写明理由。",
                f.what,
                f.site
            );

            if f.matching == Match::Exact {
                let extra: Vec<&String> = actual.difference(&declared).collect();
                assert!(
                    extra.is_empty(),
                    "「{}」实际登记了 {extra:?},但 ENTITIES 里那几格声明的是 \
                     NotApplicable/Gap\n落点:{}\n\
                     —— 要么源码这一处该撤,要么登记表那一格该改回 Required。",
                    f.what,
                    f.site
                );
            }
        }

        // 防线 4:已知缺口逐条列出,总数受预算硬限。
        let gaps: Vec<String> = ENTITIES
            .iter()
            .flat_map(|e| {
                FACETS.iter().filter_map(move |f| match (f.pick)(e) {
                    Facet::Gap(r) => Some(format!("{} @ {}:{r}", e.name, f.what)),
                    _ => None,
                })
            })
            .collect();
        assert!(
            gaps.len() <= GAP_BUDGET,
            "已知缺口 {} 条,超出 GAP_BUDGET={GAP_BUDGET}:\n{}\n\
             —— 新开口子要连同理由一起改那个数字(显式动作),不许悄悄多一条。",
            gaps.len(),
            gaps.join("\n")
        );
    }
}
