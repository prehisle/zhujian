//! 一次性工装(486,board-columns-plan §15-1/§15-2):在**副本**上跑 v35 → v37 并逐项对账。
//!
//! 用法:`cargo run --example migrate-check-0036-0037 -- <db 路径> [<db 路径> ...]`
//!
//! ⛔⛔ **先读这一条再动手:副本自带同步身份**。`server_url` / `account_id` / `k_acc` /
//! `device_key` / `device_id` 全住在库里的 `sync_meta`,**不在任何 sidecar 文件里** ⇒
//! 拿产品壳去开一枚真实库副本,它会以**同一个 device_id** 连上生产账户(486 实测:当场从
//! 对端拉了 43 条 op、`lan_ad_seq` 也自增了)。本 example **只调 `db::open`,不起任何传输**,
//! 这就是它存在的第一个理由 —— §15-1 那条「三端各用真实库副本前滚」请一律走这条路,
//! ⛔ 别用产品壳去开副本。(真要用壳看 UI:先把 `sync_meta` 里的 `server_url` 改成不可达
//! 并清掉 `lan_peer:*`,或整机断网。)
//!
//! 为什么必须先在副本上跑:memory `ys-notebook-migration-trap` —— fresh 测试照不出真实库
//! 分叉。这一趟**两条迁移都在重建整张表**:0036 重建 `items`(stage 六值枚举 CHECK → 指向
//! `board_column` 的外键),0037 重建 `oplog`(词汇表加 `board_column`)⇒ 真实库里那几千条
//! op 与几百条 item 的逐字保全,只能在真实库上量。
//!
//! 五类判据:
//!   ① **一个字节都没动**:oplog 全列指纹 + items 全列指纹直接留全串在内存里比,不算摘要
//!      (摘要要自己再写一把尺,而这里要的恰恰是逐字相等);另加各表行数与图字节总量。
//!   ② **schema 与 fresh 建出来的逐字相同**:临时目录里用同一份代码 `db::open` 出一个空库,
//!      两边 `sqlite_schema` **整份**(除 `sqlite_%` 自动索引)对比。这一条同时覆盖了
//!      「`board_column` 与授权表建齐了」「`items` 的 FK 与三只索引对」「0036/0037 重建掉的
//!      触发器全还回来了」「`oplog` 词汇表真加上了 `board_column`」—— 不必各写一句断言,
//!      也不会漏掉我没想到的那一格。
//!   ③ `integrity_check` / `foreign_key_check` / `user_version` / 无孤儿 stage。
//!   ④ **六个种子逐字段**(plan §7.1a 那张表的两类:`inbox`/`filed` 是 `system=1` 的真
//!      schema-owned;四个 task 种子是 `system=0` 的 schema-seeded implicit genesis)+
//!      **迁移一枚 `board_column` op 都不许发**(§7.1a 共同点:两类都不发 create)。
//!   ⑤ **五只守护在真实库上真的咬人**(§2.3 ①②③④⑤ 逐只)—— schema 逐字相等只证「DDL 长得
//!      对」,而这五只的 `WHEN` 子句要读**真实数据**(某列上到底有没有活卡、授权表里有没有那
//!      一行、oplog 里有没有那一枚 op 背书)。全部包在一个事务里跑完 **ROLLBACK**,副本不留痕。
//!      ⭐ **486 第一版在这里栽了一跤,值得记住**:裸 SQL 盖墓碑时 ④ **恒先答** —— 它的 `WHEN`
//!      在「没有授权行」时永真,而 SQLite 对同表同事件同时机的多只 BEFORE 触发器**不保证顺序**
//!      ⇒ ①② 结构上够不着,拿「拒了」当绿是**测错了对象**。⇒ 想摸到 ①,先按 `authorize()` 造
//!      一枚合法授权;想摸到 ②/④,还得先把那一列的活卡搬走(否则 ① 与它同时成立,谁答不确定)。
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

/// items 全列指纹(列面照 boot 的显式清单;`stage` 与 `born_stage` 都在里头 ——
/// 0036 重建整张表就是冲着 `stage` 去的,这一格是它的正面字据)。
const ITEMS_FP: &str = "SELECT COALESCE(group_concat(f, char(10)), '') FROM ( \
     SELECT id || '|' || content || '|' || stage || '|' || created_at || '|' || \
            COALESCE(due_on, '∅') || '|' || COALESCE(priority, '∅') || '|' || \
            COALESCE(position, '∅') || '|' || COALESCE(archived_at, '∅') || '|' || \
            COALESCE(sealed_at, '∅') || '|' || COALESCE(born_stage, '∅') || '|' || \
            COALESCE(done_at, '∅') || '|' || COALESCE(born_device, '∅') AS f \
       FROM items ORDER BY id)";

/// **整份** schema(表 / 索引 / 触发器),name 与 sql 都比;`sqlite_%` 是自动索引不算。
const SCHEMA_FP: &str = "SELECT COALESCE(group_concat(name || char(1) || COALESCE(sql, ''), char(10)), '') \
     FROM (SELECT name, sql FROM sqlite_schema \
            WHERE name NOT LIKE 'sqlite_%' ORDER BY name)";

const COUNTS: &[(&str, &str)] = &[
    ("items", "SELECT COUNT(*) FROM items"),
    ("topics", "SELECT COUNT(*) FROM topics"),
    ("item_topic", "SELECT COUNT(*) FROM item_topic"),
    ("item_image", "SELECT COUNT(*) FROM item_image"),
    ("item_revisions", "SELECT COUNT(*) FROM item_revisions"),
    ("item_image_counter", "SELECT COUNT(*) FROM item_image_counter"),
    ("item_comment", "SELECT COUNT(*) FROM item_comment"),
    ("device_profile", "SELECT COUNT(*) FROM device_profile"),
    ("oplog", "SELECT COUNT(*) FROM oplog"),
    ("图字节", "SELECT COALESCE(SUM(length(data)), 0) FROM item_image"),
    ("oplog 的 origin 数", "SELECT COUNT(DISTINCT origin) FROM oplog"),
    // ⚠ 488 改名:486 这一格印的是「活着的任务卡」,而查的是**全部**未归档未入册的条目
    //    (没有任何 stage 过滤)—— 差点让人拿它去反证下面 ① 那格的「四个任务列都空」。
    //    读数一个字没变,只是把名字改成它真正查的东西。
    ("活着的条目(未归档未入册)", "SELECT COUNT(*) FROM items WHERE archived_at IS NULL AND sealed_at IS NULL"),
];

/// plan §7.1a 那张表:`(id, kind, position, system)`,`tombstoned_at` 一律必须是 NULL。
const SEEDS: &[(&str, &str, &str, i64)] = &[
    ("inbox", "idea", "a0", 1),
    ("filed", "idea", "a1", 1),
    ("todo", "task", "a2", 0),
    ("doing", "task", "a3", 0),
    ("confirming", "task", "a4", 0),
    ("done", "task", "a5", 0),
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
    let dir = std::env::temp_dir().join("zhujian-0037-fresh");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let conn = zhujian_core::db::open(&dir.join("fresh.sqlite3")).expect("fresh 建库");
    text(&conn, SCHEMA_FP)
}

/// 一次「这条 SQL 必须被拒,且拒的理由要对」。返回 true = 这一格挂了。
fn must_reject(conn: &Connection, what: &str, sql: &str, want_in_msg: &str) -> bool {
    match conn.execute(sql, []) {
        Ok(n) => {
            println!("    ⚠ {what}:**没被拒**(改了 {n} 行)");
            true
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains(want_in_msg) {
                println!("    ✓ {what}:拒了 —— {msg}");
                false
            } else {
                println!("    ⚠ {what}:拒是拒了,但理由不对 —— {msg}(期望含「{want_in_msg}」)");
                true
            }
        }
    }
}

/// 探针用的合成 HLC:`origin` 是 `substr(hlc, 24)` 的生成列 ⇒ 前 23 字符是 `ts-counter-`,
/// 第 24 字符起是 26 位 device。用一枚现实中不存在的 device 后缀,`(origin, origin_seq)`
/// 唯一索引天然不撞真实设备。
const PROBE_DEV: &str = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";

fn probe_hlc(counter: u32) -> String {
    format!("0000000000001-{counter:08}-{PROBE_DEV}")
}

/// 在事务里造一枚**合法**的 tombstone 授权(oplog 那枚 op + 授权表那一行)。
///
/// ⭐ **没有它就摸不到 ①②**:SQLite 对同表同事件同时机的多只 BEFORE 触发器**不保证顺序**
/// (0036 那份迁移的长注自己写着「①②④ 三只 BEFORE 之间无所谓顺序」),而 ④ 的 `WHEN` 在
/// 「没有授权行」时**恒真** ⇒ 任何裸 SQL 盖墓碑都会被 ④ 抢答,①② 结构上够不着。
fn authorize(tx: &Connection, column: &str, counter: u32) -> String {
    let hlc = probe_hlc(counter);
    let op_id = format!("PROBE{counter:021}");
    tx.execute(
        "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
         VALUES (?1, ?2, 'board_column', ?3, 'tombstone', '{}', ?4)",
        rusqlite::params![&op_id, &hlc, column, counter as i64],
    )
    .expect("造探针 op");
    tx.execute(
        "INSERT INTO sync_board_column_tombstone_apply (column_id, op_id, from_hlc, to_hlc, mode) \
         VALUES (?1, ?2, NULL, ?3, 'apply_min')",
        rusqlite::params![column, &op_id, &hlc],
    )
    .expect("造授权行");
    hlc
}

/// 把某一列上的活卡整批搬到另一列(**只在探针事务里**),好让 ① 那只「非空」谓词失效,
/// ②/④ 才轮得到答话。归档与归档册里的行一律不动(它们各有自己的冻结触发器)。
fn empty_out(tx: &Connection, from: &str, to: &str) -> usize {
    tx.execute(
        "UPDATE items SET stage = ?2 WHERE stage = ?1 AND archived_at IS NULL AND sealed_at IS NULL",
        [from, to],
    )
    .expect("搬空探针列")
}

/// ⑤ 五只守护在真实数据上逐只咬一口;全程在事务里,跑完 ROLLBACK。
fn guards_bite(conn: &mut Connection) -> bool {
    let live = |c: &Connection, id: &str| -> i64 {
        c.query_row(
            "SELECT COUNT(*) FROM items WHERE stage = ?1 AND archived_at IS NULL AND sealed_at IS NULL",
            [id],
            |r| r.get(0),
        )
        .unwrap_or(-1)
    };
    println!(
        "  五只守护(真实数据:todo {} 张活卡 / filed {} / confirming {}):",
        live(conn, "todo"),
        live(conn, "filed"),
        live(conn, "confirming")
    );
    // ⭐ **488 在 Windows 第二枚副本上栽的那一跤,焊在这里**:① 守的是「**非空**列不许删」
    //    (`trg_board_column_no_tombstone_nonempty` 的 `WHEN` 里有 `EXISTS(… 活卡 …)`)⇒
    //    拿一枚**空**列去探它,**放行才是对的**。486 那版把探针列写死成 `todo`,只印一句
    //    ⚠ 就照旧要求「必须被拒」,于是在 `todo` 为空的库上把一次**正确行为**印成了
    //    `!! 守护探针不过 / 别动真库` —— 那是**工装的判据没覆盖这一形**,不是产品缺陷。
    //    ⇒ 探针列改成**现算**:四个 task 种子里第一个有活卡的那个;一个都没有就如实跳过。
    let probe_col = ["todo", "doing", "confirming", "done"]
        .into_iter()
        .find(|id| live(conn, id) > 0);

    let tx = conn.transaction().expect("开事务");
    let mut bad = false;

    // ① 非空列不许删(带豁免,但 sync_replay_active 空 ⇒ 豁免不成立)。授权齐 ⇒ ④ 让路。
    match probe_col {
        Some(col) => {
            let h = authorize(&tx, col, 1);
            bad |= must_reject(
                &tx,
                &format!("① 删非空的 {col}(授权齐,{} 张活卡)", live(&tx, col)),
                &format!("UPDATE board_column SET tombstoned_at = '{h}' WHERE id = '{col}'"),
                "该列还有未归档条目",
            );
        }
        None => println!(
            "    ⊘ ① 跳过:这枚库四个任务列一张活卡都没有 —— ① 的 WHEN 结构上不成立,\
             此时「放行」才是对的。⛔ 别把它算成红(换一枚有活卡的库才验得了这一格)"
        ),
    }

    // ② 系统列不可删(不带豁免)。先把 filed 搬空,否则 ① 与 ② 同时成立、谁答不确定。
    let moved = empty_out(&tx, "filed", "inbox");
    let h = authorize(&tx, "filed", 2);
    bad |= must_reject(
        &tx,
        &format!("② 删系统列 filed(先搬走 {moved} 张卡 ⇒ ① 不成立)"),
        &format!("UPDATE board_column SET tombstoned_at = '{h}' WHERE id = 'filed'"),
        "系统列不可删除",
    );

    // ③ kind/system 是出生字段
    bad |= must_reject(
        &tx,
        "③ 把 todo 的 kind 改成 idea",
        "UPDATE board_column SET kind = 'idea' WHERE id = 'todo'",
        "出生字段",
    );

    // ④ 墓碑只能由登记在案的 writer 改写 —— 同样先搬空,好让 ① 不抢答。
    let moved = empty_out(&tx, "confirming", "todo");
    bad |= must_reject(
        &tx,
        &format!("④ 无授权盖 confirming 的墓碑(先搬走 {moved} 张卡)"),
        &format!(
            "UPDATE board_column SET tombstoned_at = '{}' WHERE id = 'confirming'",
            probe_hlc(9)
        ),
        "只能由登记的 tombstone writer 改写",
    );

    // ⑤ 行永不物理删
    bad |= must_reject(
        &tx,
        "⑤ 物理删 done 行",
        "DELETE FROM board_column WHERE id = 'done'",
        "只可 tombstone 不可删行",
    );

    tx.rollback().expect("回滚探针事务");

    // 回滚真的把探针造的东西都带走了 —— 这一句是它的字据(否则上面五格全是在改副本)。
    let leftover_ops = num(conn, "SELECT COUNT(*) FROM oplog WHERE origin = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ'");
    let leftover_auth = num(conn, "SELECT COUNT(*) FROM sync_board_column_tombstone_apply");
    let still_filed = num(
        conn,
        "SELECT COUNT(*) FROM items WHERE stage = 'filed' AND archived_at IS NULL AND sealed_at IS NULL",
    );
    println!("    回滚后:探针 op {leftover_ops} 条 / 授权表 {leftover_auth} 行 / filed 活卡 {still_filed} 张");
    if leftover_ops != 0 || leftover_auth != 0 {
        println!("    ⚠ 探针没清干净");
        bad = true;
    }
    bad
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
    let orphan_stage = num(
        &conn,
        "SELECT COUNT(*) FROM items i LEFT JOIN board_column b ON b.id = i.stage WHERE b.id IS NULL",
    );
    let col_ops = num(&conn, "SELECT COUNT(*) FROM oplog WHERE entity = 'board_column'");

    println!("== {name} ==");
    println!("  uv {uv_before} → {uv_after}    开库+迁移耗时 {elapsed:?}");
    println!("  integrity={integrity}   FK 违例={fk}   孤儿 stage={orphan_stage}   board_column op={col_ops}");

    let mut bad = uv_after != 37 || integrity != "ok" || fk != 0 || orphan_stage != 0 || col_ops != 0;

    // ④ 六个种子逐字段
    println!("  六个种子(§7.1a 两类):");
    for (id, kind, position, system) in SEEDS {
        let row: Option<(String, String, i64, Option<String>)> = conn
            .query_row(
                "SELECT kind, position, system, tombstoned_at FROM board_column WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        match row {
            Some((k, p, s, t)) if k == *kind && p == *position && s == *system && t.is_none() => {
                println!("    ✓ {id}  kind={k} position={p} system={s} tombstoned_at=∅");
            }
            other => {
                bad = true;
                println!("    ⚠ {id}:期望 ({kind},{position},system={system},∅),实得 {other:?}");
            }
        }
    }
    let seed_total = num(&conn, "SELECT COUNT(*) FROM board_column");
    if seed_total != SEEDS.len() as i64 {
        bad = true;
        println!("    ⚠ board_column 行数 = {seed_total},期望恰 {}", SEEDS.len());
    }

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
        println!("  整份 schema:与 fresh 建出来的逐字相同 ✓({} 字节)", schema_fp.len());
    } else {
        bad = true;
        println!("  整份 schema:与 fresh **不同** ⚠");
        // 只打差的那几行,整份 schema 太长
        let a: Vec<&str> = schema_fp.lines().collect();
        let f: Vec<&str> = fresh_fp.lines().collect();
        for line in a.iter().filter(|l| !f.contains(l)) {
            println!("    只在迁移出来的里有:{}", &line[..line.len().min(160)]);
        }
        for line in f.iter().filter(|l| !a.contains(l)) {
            println!("    只在 fresh 里有:{}", &line[..line.len().min(160)]);
        }
    }

    if bad {
        println!("  !! 对账不过");
        return bad;
    }

    let mut conn = conn;
    bad |= guards_bite(&mut conn);

    if bad {
        println!("  !! 守护探针不过");
        return bad;
    }
    println!("  ✓ 全部通过");
    bad
}

fn main() {
    let paths: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    if paths.is_empty() {
        eprintln!("用法: migrate-check-0036-0037 <db 路径> [<db 路径> ...]");
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
