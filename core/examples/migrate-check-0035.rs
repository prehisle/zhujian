//! 一次性工装(314):在**副本**上跑 v34 → v35 并逐项对账。
//!
//! 用法:`cargo run --example migrate-check-0035 -- <db 路径> [<db 路径> ...]`
//!
//! 为什么必须先在副本上跑:memory `ys-notebook-migration-trap` —— fresh 测试照不出真实库
//! 分叉。0035 里**整表重建了 oplog**(为了给词汇表加 `comment`),真实库那几万条 op 的
//! 逐字节保全只能在真实库上量。
//!
//! 三类判据:
//!   ① **一个字节都没动**:oplog 全列指纹 + items 全列指纹直接留全串在内存里比,不算摘要
//!      (摘要要自己再写一把尺,而这里要的恰恰是逐字相等);另加七张表的行数与图字节总量。
//!   ② **schema 与 fresh 建出来的逐字相同**:临时目录里用同一份代码 `db::open` 出一个空库,
//!      把两边 `sqlite_schema` 里 oplog / item_comment 相关的 name+sql 全串对比。这一条同时
//!      覆盖了「词汇表真加上了 comment」「索引与 append-only 触发器重建齐了」「留言那两只
//!      触发器在位」—— 不必各写一句断言,也不会漏掉我没想到的那一格。
//!   ③ `integrity_check` / `foreign_key_check` / user_version。
//!
//! 副本上的 strict battery 由另一处跑(`strict_battery` 是 pub(crate),examples 够不到):
//!   ZHUJIAN_BATTERY_DB=<副本> cargo test --lib battery_on_a_real_db_copy -- --ignored --nocapture

use std::path::{Path, PathBuf};
use std::time::Instant;

use rusqlite::{Connection, OpenFlags};

fn num(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap_or(-1)
}

fn text(conn: &Connection, sql: &str) -> String {
    conn.query_row(sql, [], |r| r.get(0)).unwrap_or_default()
}

/// oplog **全列**指纹(origin 是生成列,由 hlc 派生,不单列)。
const OPLOG_FP: &str = "SELECT COALESCE(group_concat(f, char(10)), '') FROM ( \
     SELECT op_id || '|' || hlc || '|' || entity || '|' || entity_id || '|' || kind \
            || '|' || payload || '|' || origin_seq AS f FROM oplog ORDER BY op_id)";

/// items 全列指纹(列面照 boot 的显式清单)。
const ITEMS_FP: &str = "SELECT COALESCE(group_concat(f, char(10)), '') FROM ( \
     SELECT id || '|' || content || '|' || stage || '|' || created_at || '|' || \
            COALESCE(due_on, '∅') || '|' || COALESCE(priority, '∅') || '|' || \
            COALESCE(position, '∅') || '|' || COALESCE(archived_at, '∅') || '|' || \
            COALESCE(sealed_at, '∅') || '|' || COALESCE(born_stage, '∅') || '|' || \
            COALESCE(done_at, '∅') || '|' || COALESCE(born_device, '∅') AS f \
       FROM items ORDER BY id)";

/// 与 oplog / item_comment 有关的全部 schema 对象(表 + 索引 + 触发器),name 与 sql 都比。
const SCHEMA_FP: &str = "SELECT COALESCE(group_concat(name || char(1) || COALESCE(sql, ''), char(10)), '') \
     FROM (SELECT name, sql FROM sqlite_schema \
            WHERE name LIKE '%oplog%' OR name LIKE '%item_comment%' OR name LIKE '%comment%' \
            ORDER BY name)";

const COUNTS: &[(&str, &str)] = &[
    ("items", "SELECT COUNT(*) FROM items"),
    ("topics", "SELECT COUNT(*) FROM topics"),
    ("item_topic", "SELECT COUNT(*) FROM item_topic"),
    ("item_image", "SELECT COUNT(*) FROM item_image"),
    ("item_revisions", "SELECT COUNT(*) FROM item_revisions"),
    ("item_image_counter", "SELECT COUNT(*) FROM item_image_counter"),
    ("device_profile", "SELECT COUNT(*) FROM device_profile"),
    ("oplog", "SELECT COUNT(*) FROM oplog"),
    ("图字节", "SELECT COALESCE(SUM(length(data)), 0) FROM item_image"),
    ("oplog 的 origin 数", "SELECT COUNT(DISTINCT origin) FROM oplog"),
];

struct Snap {
    counts: Vec<i64>,
    oplog_fp: String,
    items_fp: String,
}

fn probe(conn: &Connection) -> Snap {
    Snap {
        counts: COUNTS.iter().map(|(_, sql)| num(conn, sql)).collect(),
        oplog_fp: text(conn, OPLOG_FP),
        items_fp: text(conn, ITEMS_FP),
    }
}

/// 临时目录里用同一份代码建一个空库,取它的 schema 指纹当基准。
fn fresh_schema_fp() -> String {
    let dir = std::env::temp_dir().join("zhujian-0035-fresh");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let conn = zhujian_core::db::open(&dir.join("fresh.sqlite3")).expect("fresh 建库");
    text(&conn, SCHEMA_FP)
}

fn check(path: &Path, fresh_fp: &str) -> bool {
    let name = path.file_name().unwrap().to_string_lossy().to_string();

    let (uv_before, before) = {
        let ro = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("只读开库(迁移前)");
        let uv: i64 = ro.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        (uv, probe(&ro))
    };

    let t0 = Instant::now();
    let conn = zhujian_core::db::open(path).expect("迁移失败");
    let elapsed = t0.elapsed();

    let uv_after: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    let after = probe(&conn);
    let integrity = text(&conn, "PRAGMA integrity_check");
    let fk = num(&conn, "SELECT COUNT(*) FROM pragma_foreign_key_check");
    let schema_fp = text(&conn, SCHEMA_FP);
    let comments = num(&conn, "SELECT COUNT(*) FROM item_comment");

    println!("== {name} ==");
    println!("  uv {uv_before} → {uv_after}    开库+迁移耗时 {elapsed:?}");
    println!("  integrity={integrity}   FK 违例={fk}   item_comment 行数={comments}");

    let mut bad = uv_after != 35 || integrity != "ok" || fk != 0 || comments != 0;

    for (i, (label, _)) in COUNTS.iter().enumerate() {
        let (b, a) = (before.counts[i], after.counts[i]);
        if b != a {
            bad = true;
            println!("  {label}: {b} → {a}   ⚠ 变了!");
        } else {
            println!("  {label}: {b}(不变)");
        }
    }

    for (label, b, a) in [
        ("oplog 全列指纹", &before.oplog_fp, &after.oplog_fp),
        ("items 全列指纹", &before.items_fp, &after.items_fp),
    ] {
        if b == a {
            println!("  {label}:一字不差 ✓({} 字节)", b.len());
        } else {
            bad = true;
            println!("  {label}:变了 ⚠");
        }
    }

    if schema_fp == fresh_fp {
        println!("  oplog/comment schema:与 fresh 建出来的逐字相同 ✓({} 字节)", schema_fp.len());
    } else {
        bad = true;
        println!("  oplog/comment schema:与 fresh **不同** ⚠\n--- 迁移出来的 ---\n{schema_fp}\n--- fresh ---\n{fresh_fp}");
    }

    if bad {
        println!("  !! 对账不过");
        return bad;
    }

    // 写探针(`ZHUJIAN_0035_WRITE=1` 开):在**真实库副本**上真写一条留言再删掉。
    //
    // schema 逐字相等只能证「DDL 长得对」;`comment` 这个新词汇到底进没进 oplog 的
    // CHECK、`trg_comment_born_device_required` 面对真实库里那枚真 device_id 认不认,
    // 只有真插一行才说得准 —— 而这两件恰恰是本迁移唯一动到既有对象的地方。
    if std::env::var("ZHUJIAN_0035_WRITE").is_ok() {
        let mut conn = conn;
        let mut clock = zhujian_core::clock::Clock::load(&conn).expect("载入时钟");
        let item: String = conn
            .query_row("SELECT id FROM items ORDER BY id LIMIT 1", [], |r| r.get(0))
            .expect("这枚库里得有条目才试得了");
        let ops_before = num(&conn, "SELECT COUNT(*) FROM oplog");
        let cid = zhujian_core::comments::add(&mut conn, &mut clock, &item, "迁移验收探针")
            .expect("真实库上写留言");
        let (born, ts): (Option<String>, String) = conn
            .query_row(
                "SELECT born_device, created_at FROM item_comment WHERE id = ?1",
                [&cid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let device = text(&conn, "SELECT value FROM sync_meta WHERE key = 'device_id'");
        let create_ops = num(
            &conn,
            "SELECT COUNT(*) FROM oplog WHERE entity = 'comment' AND kind = 'create'",
        );
        zhujian_core::comments::remove(&mut conn, &mut clock, &cid).expect("删留言");
        let left = num(&conn, "SELECT COUNT(*) FROM item_comment");
        let tomb = num(
            &conn,
            "SELECT COUNT(*) FROM oplog WHERE entity = 'comment' AND kind = 'tombstone'",
        );
        let ops_after = num(&conn, "SELECT COUNT(*) FROM oplog");
        println!(
            "  写探针:署名={} (本机 {})  created_at={ts}({} 字节)  create op={create_ops} tombstone op={tomb}  留言剩 {left} 行  oplog {ops_before}→{ops_after}",
            born.as_deref().unwrap_or("∅"),
            device,
            ts.len()
        );
        if born.as_deref() != Some(device.as_str())
            || ts.len() != 24
            || create_ops != 1
            || tomb != 1
            || left != 0
            || ops_after != ops_before + 2
        {
            println!("  !! 写探针对账不过");
            return true;
        }
        println!("  ✓ 写探针通过(留言行已清,两条 op 是史实留在日志里)");
    }

    println!("  ✓ 全部通过");
    bad
}

fn main() {
    let paths: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    if paths.is_empty() {
        eprintln!("用法: migrate-check-0035 <db 路径> [<db 路径> ...]");
        std::process::exit(2);
    }
    let fresh_fp = fresh_schema_fp();
    let mut bad = false;
    for p in &paths {
        bad |= check(p, &fresh_fp);
        println!();
    }
    if bad {
        eprintln!("!! 有库对账不过,别动真库");
        std::process::exit(1);
    }
    println!("全部 {} 枚副本通过", paths.len());
}
