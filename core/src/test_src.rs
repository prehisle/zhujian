//! 结构锚的源码解析工具箱(整模块 `#[cfg(test)]`,与 `test_temp` 同性质:纯测试侧
//! 共享件,无生产消费者)。
//!
//! # 为什么收拢
//!
//! 「从源码切一段出来再断言」这套件,仓里曾有三份各自演化的抄本:`entity_registry`
//! (327,最硬化——引号感知剔注释、配平跳字符串/转义/行注释、找不到即 panic)、
//! `move_item` 测试段(朴素 `find` 首命中 + 裸字节配平 + 裸 `split("//")` 剔注释)、
//! `transport/tests.rs` 里三处裸剔注释闭包。朴素版的误差不是理论的:裸剔注释会把
//! `"wss://…"` 这类**字符串里带 `//`** 的行剔掉半截,被剔掉的内容从扫描面上消失,
//! 锚对它**静默变绿**(那正是这类锚要防的死法)。故以 327 那份为基底收拢到这里,
//! 各处改用之;判例头注随件走。
//!
//! # 刻意**不**收编的两份(有据分野,不是漏)
//!
//! - `db.rs` 审计锚的 `production()`:它扫**任意**源文件(含它自己),字符字面量里的
//!   `}` 曾把花括号配平数歪(3 数成 10),故按「第 0 列单独闭括号」切测试段边界——
//!   判据与本工具箱的配平法刻意不同,见它头注「三处判据上的坑」。
//! - `sync::production_src`:那不是解析件,是「测试段没被内联搬回主文件」的**断言**,
//!   判据绑定 310 的 `<name>/tests/` 布局;对 `move_item`/`db.rs` 这类刻意内联测试段
//!   的文件不适用,收进来会造出「凡结构锚先过它」的错误暗示。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// 仓内源码的取用口。路径一律相对仓根,读不动即 panic(扫描面写错 = 什么都没扫到,
/// 那正是这类锚要防的静默变绿)。
pub(crate) struct Repo {
    root: PathBuf,
}

impl Repo {
    pub(crate) fn open() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core/ 的上一级就是仓根")
            .to_path_buf();
        Repo { root }
    }

    pub(crate) fn read(&self, rel: &str) -> String {
        let p = self.root.join(rel);
        std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("读不动 {rel}:{e} —— 文件改名了?名单要跟着改"))
    }

    /// 最新那条重建 `oplog` 表的迁移(词汇表 CHECK 住在它里面)。按文件名排序取最后一个,
    /// 故加一条新迁移重建 oplog 时锚自动跟过去,不必改名单。
    pub(crate) fn newest_oplog_migration(&self) -> String {
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

/// 递归收集 `dir` 下全部 `.rs` 文件(结构锚的扫描面)。读不动即 panic ——
/// 「路径写错所以什么都没扫到」是这类锚最经典的静默变绿方式(312 判例)。
pub(crate) fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("读不动目录 {}:{e}", dir.display()));
    for e in entries {
        let p = e.expect("读目录项").path();
        if p.is_dir() {
            rs_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// 剥掉行注释(`//` 到行尾)。**注释里提到某个名字不算登记/调用** —— 不剥的话,一句
/// 「本表刻意不含 device」就能让那一格假绿;反过来,**字符串里的 `//` 不是注释**——
/// 裸 `split("//")` 会把 `"wss://…"` 那一行剔掉半截,被剔掉的内容从扫描面上消失。
///
/// 判据是便宜的:该行 `//` 之前的引号个数为偶数才当注释起点。转义引号(`\"`)不特判
/// —— 被扫的这些源码段没有「转义引号之后还跟 `//`」的形,真出现会让下游的形状解析
/// 对不上而响亮红。块注释同理不特判。
pub(crate) fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|l| match l.find("//") {
            Some(i) if l[..i].matches('"').count() % 2 == 0 => &l[..i],
            _ => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 切出一个函数体(**不含**外层花括号)。跳过字符串字面量与行注释里的花括号,故
/// `format!("… FROM {table} …")` 这类不会把配平算歪。
///
/// 名字按词边界认:`fn {name}` 之后必须紧跟 `(` 或 `<`(泛型/生命周期参数表,如
/// `fn insert_moved_comment_rows<'c>(`)—— 只认 `fn {name}(` 会漏掉带参数表的形,
/// 而 `fn read` 也不许命中 `fn read_fingerprint`。
///
/// 找不到该函数 = panic:名单里的函数改名了就得一起改,不许静默跳过。
pub(crate) fn fn_body(src: &str, name: &str) -> String {
    let needle = format!("fn {name}");
    let at = src
        .match_indices(&needle)
        .map(|(i, _)| i)
        .find(|i| {
            if !matches!(src[i + needle.len()..].chars().next(), Some('(') | Some('<')) {
                return false;
            }
            // 排在注释行里的同名字样不算(文档注释里点名函数很常见)。
            let line_start = src[..*i].rfind('\n').map_or(0, |p| p + 1);
            !src[line_start..*i].trim_start().starts_with("//")
        })
        .unwrap_or_else(|| panic!("源码里找不到 `fn {name}` —— 它改名了?锚的名单要跟着改"));
    let open = src[at..]
        .find('{')
        .unwrap_or_else(|| panic!("`fn {name}` 之后没有函数体"))
        + at;
    balanced(src, open, '{', '}', &format!("fn {name}"))
}

/// 切出一个常量数组体(不含外层方括号)。
///
/// ⚠ 起点必须跨过 `decl` 本身:`const CORE_TABLES: &[&str] = &` 的类型里就带一对
/// `[`,从 decl 开头找第一个 `[` 会切出 `&str` 而不是数组体(327 首版实测,被
/// entity_registry 的反向探针当场抓住)。
pub(crate) fn const_body(src: &str, decl: &str) -> String {
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
pub(crate) fn balanced(src: &str, open: usize, lb: char, rb: char, what: &str) -> String {
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

/// 抓 SQL 里 `FROM <表名>` 的表名(含 `FROM boot.<表名>`);`FROM (` 这种子查询跳过。
pub(crate) fn sql_from_tables(src: &str) -> BTreeSet<String> {
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
pub(crate) fn sql_insert_tables(src: &str) -> BTreeSet<String> {
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

/// 抓全部 Rust 字符串字面量的内容(单行、不含转义引号的那种;用到的几处都是)。
pub(crate) fn str_literals(src: &str) -> BTreeSet<String> {
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
