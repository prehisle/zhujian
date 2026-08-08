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
//!    e2e 与真机验收,后三者漏了会被既有行为测当场打红(不是静默少干活),故本轮不铺。
//! 2. **[`Match::Superset`] 的面守漏登记、不守假登记**:那几处的实际集合里本就混着非实体
//!    表(`oplog` / `sync_meta` / `item_revisions` …),要求精确相等就得再维护一份「非实体
//!    表」名单,那是把同一个腐烂点搬个家。
//! 3. **「进了表」不等于「被覆盖」**:`convergence` 那一面只验表进没进指纹 SQL,验不了
//!    随机命令流真的产过这个实体的 op。314 给 `comment` 配的 `COMMENT_ADDS`/`COMMENT_REMOVES`
//!    覆盖计数才是那一格的判据,本锚不复制它。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

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

// ---- 源码读取与切片 ----------------------------------------------------------------

/// 仓内源码的取用口。路径一律相对仓根,读不动即 panic(扫描面写错 = 什么都没扫到,
/// 那正是本锚要防的静默变绿)。
struct Repo {
    root: PathBuf,
}

impl Repo {
    fn open() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core/ 的上一级就是仓根")
            .to_path_buf();
        Repo { root }
    }

    fn read(&self, rel: &str) -> String {
        let p = self.root.join(rel);
        std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("读不动 {rel}:{e} —— 文件改名了?名单要跟着改"))
    }

    /// 最新那条重建 `oplog` 表的迁移(词汇表 CHECK 住在它里面)。按文件名排序取最后一个,
    /// 故加一条新迁移重建 oplog 时锚自动跟过去,不必改名单。
    fn newest_oplog_migration(&self) -> String {
        let dir = self.root.join("core/migrations");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("读不动 {}:{e}", dir.display()))
            .map(|e| e.expect("读目录项").file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".sql"))
            .collect();
        names.sort();
        let hit = names
            .iter()
            .rev()
            .find(|n| {
                std::fs::read_to_string(dir.join(n))
                    .is_ok_and(|s| s.contains("CREATE TABLE oplog"))
            })
            .unwrap_or_else(|| {
                panic!("core/migrations 里没有任何一条迁移建 oplog 表 —— 扫描面写错了?")
            });
        std::fs::read_to_string(dir.join(hit)).expect("上一步已读过一次")
    }
}

/// 剥掉行注释(`//` 到行尾)。**注释里提到某个实体名不算登记** —— 不剥的话,一句
/// 「本表刻意不含 device」就能让那一格假绿。
///
/// 块注释不特判:仓里这几处没有,真出现了会让下方的形状解析对不上而响亮红。
fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|l| match l.find("//") {
            // 只在**字符串外**的 `//` 才是注释起点。这几个面里没有含 `//` 的字面量
            // (SQL 里不会有),故用「该行 `//` 之前的引号个数为偶数」这条便宜判据。
            Some(i) if l[..i].matches('"').count() % 2 == 0 => &l[..i],
            _ => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 切出一个函数体(不含外层花括号)。跳过字符串字面量与行注释里的花括号,故
/// `format!("… FROM {table} …")` 这类不会把配平算歪。
///
/// 找不到该函数 = panic:名单里的函数改名了就得一起改,不许静默跳过。
fn fn_body(src: &str, name: &str) -> String {
    let needle = format!("fn {name}(");
    let at = src
        .match_indices(&needle)
        .map(|(i, _)| i)
        .find(|i| {
            // 排在注释行里的同名字样不算(文档注释里点名函数很常见)。
            let line_start = src[..*i].rfind('\n').map_or(0, |p| p + 1);
            !src[line_start..*i].trim_start().starts_with("//")
        })
        .unwrap_or_else(|| panic!("源码里找不到 `fn {name}(` —— 它改名了?锚的名单要跟着改"));
    let open = src[at..]
        .find('{')
        .unwrap_or_else(|| panic!("`fn {name}` 之后没有函数体"))
        + at;
    balanced(src, open, '{', '}', &format!("fn {name}"))
}

/// 切出一个常量数组体(不含外层方括号)。
///
/// ⚠ 起点必须跨过 `decl` 本身:`const CORE_TABLES: &[&str] = &` 的类型里就带一对
/// `[`,从 decl 开头找第一个 `[` 会切出 `&str` 而不是数组体(首版实测,被反向探针
/// 当场抓住)。
fn const_body(src: &str, decl: &str) -> String {
    let at = src
        .find(decl)
        .unwrap_or_else(|| panic!("源码里找不到 `{decl}` —— 它改名了?锚的名单要跟着改"));
    let after = at + decl.len();
    let open = src[after..]
        .find('[')
        .unwrap_or_else(|| panic!("`{decl}` 之后没有 `[`"))
        + after;
    balanced(src, open, '[', ']', decl)
}

/// 从 `open`(那一枚开括号的下标)起做配平切片,返回**括号内**的内容。
///
/// 扫描时跳过 Rust 字符串字面量(含 `\"` 转义)与行注释——不跳的话,SQL 里的
/// `'$.item_id'` 无所谓,但 `format!("{table}")` 的花括号会把配平算歪。
fn balanced(src: &str, open: usize, lb: char, rb: char, what: &str) -> String {
    let bytes: Vec<char> = src[open..].chars().collect();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == '\\' {
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            '"' => in_str = true,
            '/' if bytes.get(i + 1) == Some(&'/') => {
                while i < bytes.len() && bytes[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            c if c == lb => depth += 1,
            c if c == rb => {
                depth -= 1;
                if depth == 0 {
                    return bytes[1..i].iter().collect();
                }
            }
            _ => {}
        }
        i += 1;
    }
    panic!("{what} 的 `{lb}` 没有配平的 `{rb}` —— 解析器看不懂这个形状,拒绝猜");
}

// ---- 九个提取器:从源码解析出「实际登记了谁」 ----------------------------------------

/// 抓 SQL 里 `FROM <表名>` 的表名(含 `FROM boot.<表名>`);`FROM (` 这种子查询跳过。
fn sql_from_tables(src: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (i, _) in src.match_indices("FROM ") {
        let rest = src[i + 5..].trim_start();
        let tok: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
            .collect();
        // `FROM boot.items` → items;`FROM (SELECT …)` → 空 token,跳过。
        if let Some(t) = tok.rsplit('.').next().filter(|t| !t.is_empty()) {
            out.insert(t.to_string());
        }
    }
    out
}

/// 抓 SQL 里 `INSERT INTO <表名>` 的表名。
fn sql_insert_tables(src: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (i, _) in src.match_indices("INSERT INTO ") {
        let tok: String = src[i + 12..]
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if !tok.is_empty() {
            out.insert(tok);
        }
    }
    out
}

/// 抓全部 Rust 字符串字面量的内容(单行、不含转义引号的那种;这几处都是)。
fn str_literals(src: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '"' {
            let mut j = i + 1;
            let mut buf = String::new();
            while j < chars.len() && chars[j] != '"' {
                if chars[j] == '\\' {
                    j += 2;
                    continue;
                }
                buf.push(chars[j]);
                j += 1;
            }
            out.insert(buf);
            i = j + 1;
            continue;
        }
        i += 1;
    }
    out
}

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
