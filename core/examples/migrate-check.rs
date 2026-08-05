//! 一次性工装(302):在**副本**上跑 v33 → v34 并按 codex 三轮给的验收清单逐项对账。
//!
//! 用法:`cargo run --example migrate-check -- <db 路径>`
//!
//! 为什么必须先在副本上跑:memory `ys-notebook-migration-trap` —— fresh 测试照不出真实库
//! 分叉。0034 的恢复步只在「行 NULL ∧ 自己的 create op 带**规范** born_device」时才动行,
//! 真实库里那个候选数应当恒为 0(302 已取证),这里把它量出来当字据,而不是假设。
//!
//! 全列指纹**不算校验和、直接留全串在内存里比**:245 行的量级完全吃得下,而任何摘要都得
//! 自己再写一把尺 —— 这里要的恰恰是「一个字节都没动」。
//!
//! 副本上的 strict battery 由另一处跑(`strict_battery` 是 pub(crate),examples 够不到):
//!   ZHUJIAN_BATTERY_DB=<副本> cargo test --lib battery_on_a_real_db_copy -- --ignored --nocapture

use std::path::PathBuf;
use std::time::Instant;

use rusqlite::{Connection, OpenFlags};

fn num(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap_or(-1)
}

fn text(conn: &Connection, sql: &str) -> String {
    conn.query_row(sql, [], |r| r.get(0)).unwrap_or_default()
}

/// items 全列指纹(含 born_device)。列面照 boot 的显式清单。
const ITEMS_FP: &str = "SELECT COALESCE(group_concat(f, char(10)), '') FROM ( \
     SELECT id || '|' || content || '|' || stage || '|' || created_at || '|' || \
            COALESCE(due_on, '∅') || '|' || COALESCE(priority, '∅') || '|' || \
            COALESCE(position, '∅') || '|' || COALESCE(archived_at, '∅') || '|' || \
            COALESCE(sealed_at, '∅') || '|' || COALESCE(born_stage, '∅') || '|' || \
            COALESCE(done_at, '∅') || '|' || COALESCE(born_device, '∅') AS f \
       FROM items ORDER BY id)";

/// oplog 的身份三轴 —— op_id / hlc / origin_seq 必须原样。
const OPLOG_FP: &str = "SELECT COALESCE(group_concat(f, char(10)), '') FROM ( \
     SELECT op_id || '|' || hlc || '|' || origin_seq AS f FROM oplog ORDER BY op_id)";

struct Snap {
    counts: Vec<(&'static str, i64)>,
    items_fp: String,
    oplog_fp: String,
}

fn probe(conn: &Connection) -> Snap {
    Snap {
        counts: vec![
            ("items", num(conn, "SELECT COUNT(*) FROM items")),
            ("oplog", num(conn, "SELECT COUNT(*) FROM oplog")),
            ("图字节", num(conn, "SELECT COALESCE(SUM(length(data)), 0) FROM item_image")),
            ("署名非空", num(conn, "SELECT COUNT(*) FROM items WHERE born_device IS NOT NULL")),
            ("名册", num(conn, "SELECT COUNT(*) FROM device_profile")),
        ],
        items_fp: text(conn, ITEMS_FP),
        oplog_fp: text(conn, OPLOG_FP),
    }
}

fn main() {
    let path = PathBuf::from(std::env::args().nth(1).expect("用法: migrate-check <db 路径>"));
    let name = path.file_name().unwrap().to_string_lossy().to_string();

    let (uv_before, before, candidates) = {
        let ro = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("只读开库(迁移前)");
        let uv: i64 = ro.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        // 0034 的恢复候选,判据与迁移里那句**逐字同源**。
        let candidates = num(
            &ro,
            "SELECT COUNT(*) FROM items WHERE born_device IS NULL AND EXISTS ( \
                 SELECT 1 FROM ( \
                     SELECT json_extract(payload, '$.born_device') AS v, \
                            json_type(payload, '$.born_device') AS t \
                       FROM oplog \
                      WHERE entity = 'item' AND entity_id = items.id AND kind = 'create' \
                      ORDER BY hlc DESC LIMIT 1) \
                  WHERE t = 'text' AND length(v) = 26 \
                    AND v NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')",
        );
        (uv, probe(&ro), candidates)
    };

    let t0 = Instant::now();
    let conn = zhujian_core::db::open(&path).expect("迁移失败");
    let elapsed = t0.elapsed();

    let uv_after: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    let after = probe(&conn);
    let integrity = text(&conn, "PRAGMA integrity_check");
    let fk = num(&conn, "SELECT COUNT(*) FROM pragma_foreign_key_check");
    // 冻结触发器必须在位,且是 0034 重建的那一份(WHEN 用 IS NOT 的 NULL 安全比较)。
    let trg = text(
        &conn,
        "SELECT COALESCE(sql, '') FROM sqlite_schema WHERE name = 'trg_item_born_device_frozen'",
    );

    println!("== {name} ==");
    println!("  uv {uv_before} → {uv_after}    开库+迁移耗时 {elapsed:?}");
    println!("  integrity={integrity}   FK 违例={fk}   0034 恢复候选={candidates}");
    println!(
        "  冻结触发器:{}",
        if trg.contains("OLD.born_device IS NOT NEW.born_device") { "在位 ✓" } else { "缺失/变形 ⚠" }
    );

    let mut bad = uv_after != 34
        || integrity != "ok"
        || fk != 0
        || !trg.contains("OLD.born_device IS NOT NEW.born_device");
    for (i, (label, b)) in before.counts.iter().enumerate() {
        let a = after.counts[i].1;
        if *b != a {
            bad = true;
            println!("  {label}: {b} → {a}   ⚠ 变了!");
        } else {
            println!("  {label}: {b}(不变)");
        }
    }
    // 候选为 0 时,连指纹都必须逐字节相等(含 born_device 列)。
    for (label, b, a) in [
        ("items 全列指纹", &before.items_fp, &after.items_fp),
        ("oplog 身份三轴", &before.oplog_fp, &after.oplog_fp),
    ] {
        if b == a {
            println!("  {label}:一字不差 ✓({} 字节)", b.len());
        } else if label.starts_with("items") && candidates > 0 {
            println!("  {label}:变了 —— 但本库有 {candidates} 个恢复候选,预期之内");
        } else {
            bad = true;
            println!("  {label}:变了 ⚠(候选={candidates},不该变)");
        }
    }

    if bad {
        eprintln!("!! 对账不过,别动真库");
        std::process::exit(1);
    }
    println!("  ✓ 全部通过");
}
