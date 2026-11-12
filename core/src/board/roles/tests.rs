//! 读路径去 N+1 的**等价性**锚(多看板优化 K1)与 K3 / K4 / K5 的单测。
//!
//! ⭐ 等价性的判据 = **改前那份实现**:[`legacy`] 里是 K1 之前的按 id 逐句查库的角色函数、
//! `column_delete_refusal`、`list_columns` / `list_boards` 的逐行算法、删看板的计数 SQL,
//! **原样**从改前的树里搬来(只改了路径)。新实现([`super::resolve`] 那一份纯函数 +
//! 一次读的 [`super::Facts`])必须在同一组事实上与它逐项相同。
//! ⚠ 它是**测试里的参照物**,不是第二份产品规则:⛔ 别从产品代码引用它;§3 改规则那天它要跟着
//! 改(或者干脆删掉这只等价测,只留下面那几只按场景断言的)。
//!
//! 状态用直写 SQL 造(本文件的库**摘掉了全部触发器**):要覆盖的恰是命令层造不出、只有并发 /
//! 远端事实造得出的那些悬空形(plan §3 列全的六种来源)。读侧不依赖任何触发器。

use std::collections::HashMap;

use rusqlite::Connection;

use crate::board::{boards, roles, *};
use crate::db;

/// 改前(K1 之前)的实现,原样保留作参照。
mod legacy {
    use crate::board::{live_item_count, title_is_overridden, undeletable_reason, SEED_BOARD};
    use rusqlite::{Connection, OptionalExtension};

    fn s<T>(r: rusqlite::Result<T>) -> Result<T, String> {
        r.map_err(|e| e.to_string())
    }

    pub fn board_of(conn: &Connection, column_id: &str) -> Result<Option<String>, String> {
        s(conn
            .query_row(
                "SELECT COALESCE(board_id, ?2) FROM board_column WHERE id = ?1 AND kind = 'task'",
                [column_id, SEED_BOARD],
                |r| r.get(0),
            )
            .optional())
    }

    pub fn board_live(conn: &Connection, board_id: &str) -> Result<bool, String> {
        Ok(s(conn
            .query_row(
                "SELECT tombstoned_at IS NULL FROM board WHERE id = ?1",
                [board_id],
                |r| r.get::<_, bool>(0),
            )
            .optional())?
        .unwrap_or(false))
    }

    pub fn live_columns(conn: &Connection, board_id: &str) -> Result<Vec<String>, String> {
        if !board_live(conn, board_id)? {
            return Ok(vec![]);
        }
        let mut stmt = s(conn.prepare(
            "SELECT id FROM board_column \
              WHERE kind = 'task' AND tombstoned_at IS NULL AND COALESCE(board_id, ?2) = ?1 \
              ORDER BY position, id",
        ))?;
        let rows = s(stmt.query_map([board_id, SEED_BOARD], |r| r.get(0)))?;
        s(rows.collect())
    }

    fn pointers(conn: &Connection, board_id: &str) -> Result<(Option<String>, Option<String>), String> {
        Ok(s(conn
            .query_row(
                "SELECT landing_column_id, done_column_id FROM board WHERE id = ?1",
                [board_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional())?
        .unwrap_or((None, None)))
    }

    pub fn done_of(conn: &Connection, board_id: &str) -> Result<Option<String>, String> {
        let live = live_columns(conn, board_id)?;
        let (_, done) = pointers(conn, board_id)?;
        Ok(done.filter(|d| live.contains(d)))
    }

    pub fn landing_of(conn: &Connection, board_id: &str) -> Result<Option<String>, String> {
        let live = live_columns(conn, board_id)?;
        let (landing, done) = pointers(conn, board_id)?;
        let done = done.filter(|d| live.contains(d));
        if let Some(l) = landing.filter(|l| live.contains(l) && Some(l) != done.as_ref()) {
            return Ok(Some(l));
        }
        Ok(live.into_iter().find(|c| Some(c) != done.as_ref()))
    }

    pub fn is_done_column(conn: &Connection, column_id: &str) -> Result<bool, String> {
        match board_of(conn, column_id)? {
            Some(b) => Ok(done_of(conn, &b)?.as_deref() == Some(column_id)),
            None => Ok(false),
        }
    }

    pub fn entered_done(conn: &Connection, from: &str, to: &str) -> Result<bool, String> {
        Ok(from != to && is_done_column(conn, to)? && !is_done_column(conn, from)?)
    }

    pub fn column_accepts_cards(conn: &Connection, column_id: &str) -> Result<bool, String> {
        let live_col: bool = s(conn
            .query_row(
                "SELECT kind = 'task' AND tombstoned_at IS NULL FROM board_column WHERE id = ?1",
                [column_id],
                |r| r.get(0),
            )
            .optional())?
        .unwrap_or(false);
        if !live_col {
            return Ok(false);
        }
        match board_of(conn, column_id)? {
            Some(b) => board_live(conn, &b),
            None => Ok(false),
        }
    }

    pub fn column_delete_refusal(conn: &Connection, id: &str, system: bool) -> Result<Option<String>, String> {
        if let Some(why) = undeletable_reason(id, system) {
            return Ok(Some(why));
        }
        let Some(b) = board_of(conn, id)? else { return Ok(None) };
        if !board_live(conn, &b)? {
            return Ok(Some("这一列所在的看板已删除,列是只读的".to_string()));
        }
        let done = done_of(conn, &b)?;
        if done.as_deref() == Some(id) {
            return Ok(Some("这一列是这块看板的完成列,请先取消完成列再删".to_string()));
        }
        let others = live_columns(conn, &b)?
            .into_iter()
            .filter(|c| c != id && Some(c) != done.as_ref())
            .count();
        if others == 0 {
            return Ok(Some("这是这块看板上最后一枚能放新卡的列,不能删".to_string()));
        }
        Ok(None)
    }

    /// 改前 `list_columns` 的十一格(新加的 `accepts_cards` / `held` 不在内)。
    pub type ColRow = (String, String, String, bool, String, bool, bool, i64, bool, Option<String>, bool);

    pub fn list_columns(conn: &Connection) -> rusqlite::Result<Vec<ColRow>> {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.title, c.kind, c.system, c.position, c.tombstoned_at IS NOT NULL, \
                    CASE WHEN c.kind = 'task' THEN COALESCE(c.board_id, ?1) END, \
                    COALESCE(b.tombstoned_at IS NOT NULL, 0) \
               FROM board_column c \
               LEFT JOIN board b ON c.kind = 'task' AND b.id = COALESCE(c.board_id, ?1) \
              ORDER BY c.position, c.id",
        )?;
        type Row = (String, String, String, bool, String, bool, Option<String>, bool);
        let rows: Vec<Row> = stmt
            .query_map([SEED_BOARD], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get::<_, i64>(3)? == 1,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        rows.into_iter()
            .map(|(id, title, kind, system, position, deleted, board_id, board_deleted)| {
                let is_title_overridden = title_is_overridden(&id, &title);
                let deletable = column_delete_refusal(conn, &id, system)
                    .map_err(rusqlite::Error::InvalidParameterName)?
                    .is_none();
                let live_items = live_item_count(conn, &id)?;
                Ok((id, title, kind, system, position, is_title_overridden, deleted, live_items, deletable, board_id, board_deleted))
            })
            .collect()
    }

    /// 改前 `list_boards` 的那几格:(id, title, position, landing, done, deleted, is_default)。
    pub type BoardRow = (String, String, String, Option<String>, Option<String>, bool, bool);

    pub fn list_boards(conn: &Connection) -> Result<Vec<BoardRow>, String> {
        let default: String = s(conn.query_row(
            "SELECT id FROM board WHERE tombstoned_at IS NULL ORDER BY position, id LIMIT 1",
            [],
            |r| r.get(0),
        ))?;
        let mut stmt = s(conn.prepare(
            "SELECT id, title, position, tombstoned_at IS NOT NULL FROM board ORDER BY position, id",
        ))?;
        let rows: Vec<(String, String, String, bool)> = s(s(stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))))?
        .collect())?;
        rows.into_iter()
            .map(|(id, title, position, deleted)| {
                Ok((
                    id.clone(),
                    title,
                    position,
                    landing_of(conn, &id)?,
                    done_of(conn, &id)?,
                    deleted,
                    id == default,
                ))
            })
            .collect()
    }

    /// 改前 `delete_board` 的「先清空」计数(所有权集合)。
    pub fn delete_board_count(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM items i JOIN board_column c ON c.id = i.stage \
              WHERE c.kind = 'task' AND COALESCE(c.board_id, ?2) = ?1 \
                AND i.archived_at IS NULL AND i.sealed_at IS NULL",
            [id, SEED_BOARD],
            |r| r.get(0),
        )
        .unwrap()
    }
}

// ---- 台架 ------------------------------------------------------------------------------

/// 49 位的墓碑 HLC 原文(0036 的 length CHECK)。
const TOMB: &str = "0000018e00000-00000000-RMTDEV0000000000000000000X";

fn temp_db_at(tag: &str) -> (Connection, std::path::PathBuf) {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let p = crate::test_temp::dir().join(format!(
        "ys-nb-roles-eq-{tag}-{}-{}.sqlite3",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let conn = db::open(&p).expect("open migrated db");
    crate::clock::Clock::load(&conn).expect("init device identity");
    (conn, p)
}

fn temp_db(tag: &str) -> Connection {
    temp_db_at(tag).0
}

/// 一张**摘掉全部触发器**的库:状态直写,读侧只看表。
fn bare_db_at(tag: &str) -> (Connection, std::path::PathBuf) {
    let (conn, p) = temp_db_at(tag);
    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for n in names {
        conn.execute_batch(&format!("DROP TRIGGER \"{n}\"")).unwrap();
    }
    (conn, p)
}

fn bare_db(tag: &str) -> Connection {
    bare_db_at(tag).0
}

#[derive(Clone, Debug)]
struct B {
    id: &'static str,
    pos: &'static str,
    tomb: bool,
    landing: Option<&'static str>,
    done: Option<&'static str>,
}

#[derive(Clone, Debug)]
struct C {
    id: &'static str,
    /// `None` = 种子看板(`board_id IS NULL`)。
    board: Option<&'static str>,
    pos: &'static str,
    tomb: bool,
}

#[derive(Clone, Debug)]
struct I {
    stage: &'static str,
    archived: bool,
    sealed: bool,
}

/// 把一组事实写进库:清空任务列 / 看板 / 条目后照写(灵感两列留着)。
fn plant(conn: &Connection, boards: &[B], cols: &[C], items: &[I]) {
    conn.execute_batch(
        "DELETE FROM items; DELETE FROM board_column WHERE kind = 'task'; DELETE FROM board;",
    )
    .unwrap();
    for b in boards {
        conn.execute(
            "INSERT INTO board (id, title, position, landing_column_id, done_column_id, created_at, tombstoned_at) \
             VALUES (?1, ?1, ?2, ?3, ?4, 't', ?5)",
            (b.id, b.pos, b.landing, b.done, b.tomb.then_some(TOMB)),
        )
        .unwrap();
    }
    for c in cols {
        conn.execute(
            "INSERT INTO board_column (id, title, kind, system, position, created_at, tombstoned_at, board_id) \
             VALUES (?1, ?1, 'task', 0, ?2, 't', ?3, ?4)",
            (c.id, c.pos, c.tomb.then_some(TOMB), c.board),
        )
        .unwrap();
    }
    let dev: String =
        conn.query_row("SELECT value FROM sync_meta WHERE key='device_id'", [], |r| r.get(0)).unwrap();
    for (n, it) in items.iter().enumerate() {
        let idea = it.stage == "inbox";
        conn.execute(
            "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage, born_device, archived_at, sealed_at) \
             VALUES (?1, 'x', ?2, 't', 't', ?3, ?2, ?4, ?5, ?6)",
            (
                format!("I{n:04}"),
                it.stage,
                (!idea).then_some("a0"),
                &dev,
                it.archived.then_some("2026-01-01T00:00:00.000Z"),
                it.sealed.then_some("2026-01-01T00:00:00.000Z"),
            ),
        )
        .unwrap();
    }
}

/// 逐项比:新快照解析 ≡ 逐 id 改前函数;`list_columns` / `list_boards` ≡ 改前输出;K3 / K4 / K5
/// 的新格 ≡ 由改前函数推出的值。`probe_boards` / `probe_cols` 额外带上不存在的 id。
fn assert_equivalent(conn: &Connection, ctx: &str) {
    let facts = roles::Facts::load(conn).unwrap();
    // 探针:表里的看板 + 列上写着的看板(可能根本不存在)+ 一个凭空的 id。
    let mut board_ids: Vec<String> = facts.boards.iter().map(|b| b.id.clone()).collect();
    board_ids.extend(facts.columns.iter().map(|c| c.board.clone()));
    board_ids.push("GHOSTB".to_string());
    board_ids.sort();
    board_ids.dedup();
    let col_ids: Vec<String> = facts
        .columns
        .iter()
        .map(|c| c.id.clone())
        .chain(["inbox", "filed", "GHOSTC"].map(String::from))
        .collect();

    for b in &board_ids {
        let r = facts.roles(b);
        assert_eq!(r.live_columns, legacy::live_columns(conn, b).unwrap(), "{ctx}: live_columns({b})");
        assert_eq!(r.done, legacy::done_of(conn, b).unwrap(), "{ctx}: done({b})");
        assert_eq!(r.landing, legacy::landing_of(conn, b).unwrap(), "{ctx}: landing({b})");
        assert_eq!(facts.board_live(b), legacy::board_live(conn, b).unwrap(), "{ctx}: board_live({b})");
        // 按 id 的那几只(写命令用的)也走同一份解析。
        assert_eq!(roles::live_columns(conn, b).unwrap(), r.live_columns, "{ctx}");
        assert_eq!(roles::done_of(conn, b).unwrap(), r.done, "{ctx}");
        assert_eq!(roles::landing_of(conn, b).unwrap(), r.landing, "{ctx}");
        assert_eq!(roles::board_live(conn, b).unwrap(), facts.board_live(b), "{ctx}");
    }
    for c in &col_ids {
        let want_board = legacy::board_of(conn, c).unwrap();
        assert_eq!(facts.board_of(c).map(str::to_string), want_board, "{ctx}: board_of({c})");
        assert_eq!(roles::board_of(conn, c).unwrap(), want_board, "{ctx}");
        let accepts = legacy::column_accepts_cards(conn, c).unwrap();
        assert_eq!(facts.column_accepts_cards(c), accepts, "{ctx}: accepts({c})");
        assert_eq!(roles::column_accepts_cards(conn, c).unwrap(), accepts, "{ctx}");
        assert_eq!(facts.is_done_column(c), legacy::is_done_column(conn, c).unwrap(), "{ctx}: is_done({c})");
        for d in &col_ids {
            assert_eq!(
                roles::entered_done(conn, c, d).unwrap(),
                legacy::entered_done(conn, c, d).unwrap(),
                "{ctx}: entered_done({c} → {d})"
            );
        }
    }

    // list_columns:改前十一格逐行同;新两格按定义由改前的格子推出。
    let new_cols = list_columns(conn).unwrap();
    let old_cols = legacy::list_columns(conn).unwrap();
    let new_old_shape: Vec<legacy::ColRow> = new_cols
        .iter()
        .map(|r| {
            (
                r.id.clone(),
                r.title.clone(),
                r.kind.clone(),
                r.system,
                r.position.clone(),
                r.is_title_overridden,
                r.deleted,
                r.live_items,
                r.deletable,
                r.board_id.clone(),
                r.board_deleted,
            )
        })
        .collect();
    assert_eq!(new_old_shape, old_cols, "{ctx}: list_columns 改前那十一格");
    for r in &new_cols {
        assert_eq!(r.accepts_cards, legacy::column_accepts_cards(conn, &r.id).unwrap(), "{ctx}: accepts_cards {}", r.id);
        assert_eq!(r.held, r.kind == "task" && (r.deleted || r.board_deleted), "{ctx}: held {}", r.id);
    }

    // list_boards:改前那几格逐行同;K4 两格由改前的角色 + 逐列计数推出。
    let new_boards = list_boards(conn).unwrap();
    let old_boards = legacy::list_boards(conn).unwrap();
    let shape: Vec<legacy::BoardRow> = new_boards
        .iter()
        .map(|b| (b.id.clone(), b.title.clone(), b.position.clone(), b.landing.clone(), b.done.clone(), b.deleted, b.is_default))
        .collect();
    assert_eq!(shape, old_boards, "{ctx}: list_boards");
    for b in &new_boards {
        let live = legacy::live_columns(conn, &b.id).unwrap();
        let done = legacy::done_of(conn, &b.id).unwrap();
        let n = |c: &str| live_item_count(conn, c).unwrap();
        let want_live: i64 = live.iter().map(|c| n(c)).sum();
        let want_open: i64 = live.iter().filter(|c| Some(*c) != done.as_ref()).map(|c| n(c)).sum();
        assert_eq!((b.live_items, b.open_items), (want_live, want_open), "{ctx}: K4 计数 {}", b.id);
        let per_stage = live_item_counts_by_stage(conn).unwrap();
        assert_eq!(
            boards::board_card_counts(&facts, &per_stage, &b.id).owned,
            legacy::delete_board_count(conn, &b.id),
            "{ctx}: 删看板前置的计数 {}",
            b.id
        );
    }
}

// ---- K1:等价性 --------------------------------------------------------------------------

/// plan §3 列全的悬空来源,一种一块看板,逐项与改前实现比,并钉住几处具体结果。
#[test]
fn snapshot_resolution_matches_the_per_id_functions_on_every_dangling_source() {
    let conn = bare_db("named");
    let boards = [
        // 种子看板:落点 / 完成指针都指着真列。
        B { id: "tasks", pos: "a0", tomb: false, landing: Some("todo"), done: Some("done") },
        // ① 指针先到、列未到:完成指针指着一枚还没有的列。
        B { id: "B1", pos: "a1", tomb: false, landing: None, done: Some("LATE") },
        // ② 指向已墓碑列。
        B { id: "B2", pos: "a2", tomb: false, landing: Some("B2x"), done: Some("B2y") },
        // ③ 指向别的看板的列。
        B { id: "B3", pos: "a3", tomb: false, landing: Some("todo"), done: Some("done") },
        // ④ 落点 = 完成。
        B { id: "B4", pos: "a4", tomb: false, landing: Some("B4d"), done: Some("B4d") },
        // ⑤ 无非完成活列(只剩完成列)。
        B { id: "B5", pos: "a5", tomb: false, landing: None, done: Some("B5d") },
        // ⑥ 看板本身已墓碑(列都没墓碑,含一枚「迟到出生」的活列)。
        B { id: "B6", pos: "a6", tomb: true, landing: Some("B6a"), done: Some("B6b") },
        // 同 position 并列:默认看板与列序都按 (position, id) 打平。
        B { id: "B0", pos: "a0", tomb: false, landing: None, done: None },
    ];
    let cols = [
        C { id: "todo", board: None, pos: "a2", tomb: false },
        C { id: "doing", board: None, pos: "a3", tomb: false },
        C { id: "confirming", board: None, pos: "a4", tomb: true },
        C { id: "done", board: None, pos: "a5", tomb: false },
        C { id: "B1a", board: Some("B1"), pos: "a1", tomb: false },
        C { id: "B2x", board: Some("B2"), pos: "a1", tomb: true },
        C { id: "B2y", board: Some("B2"), pos: "a2", tomb: true },
        C { id: "B2z", board: Some("B2"), pos: "a3", tomb: false },
        C { id: "B3a", board: Some("B3"), pos: "a1", tomb: false },
        C { id: "B4c", board: Some("B4"), pos: "a1", tomb: false },
        C { id: "B4d", board: Some("B4"), pos: "a0", tomb: false },
        C { id: "B5d", board: Some("B5"), pos: "a1", tomb: false },
        C { id: "B5x", board: Some("B5"), pos: "a0", tomb: true },
        C { id: "B6a", board: Some("B6"), pos: "a1", tomb: false },
        C { id: "B6b", board: Some("B6"), pos: "a2", tomb: false },
        C { id: "B0z", board: Some("B0"), pos: "a1", tomb: false },
        C { id: "B0y", board: Some("B0"), pos: "a1", tomb: false },
    ];
    let items = [
        I { stage: "todo", archived: false, sealed: false },
        I { stage: "done", archived: false, sealed: false },
        I { stage: "done", archived: false, sealed: true },
        I { stage: "confirming", archived: false, sealed: false },
        I { stage: "B2x", archived: false, sealed: false },
        I { stage: "B2z", archived: true, sealed: false },
        I { stage: "B4d", archived: false, sealed: false },
        I { stage: "B4c", archived: false, sealed: false },
        I { stage: "B5d", archived: false, sealed: false },
        I { stage: "B6a", archived: false, sealed: false },
        I { stage: "B6b", archived: false, sealed: true },
        I { stage: "inbox", archived: false, sealed: false },
    ];
    plant(&conn, &boards, &cols, &items);
    assert_equivalent(&conn, "named");

    let f = roles::Facts::load(&conn).unwrap();
    let r = |b: &str| f.roles(b);
    assert_eq!(r("B1").done, None, "① 指针先到列未到 ⇒ ⊥");
    assert_eq!(r("B2").landing.as_deref(), Some("B2z"), "② 指向墓碑列 ⇒ 退最左活列");
    assert_eq!(r("B2").done, None);
    assert_eq!((r("B3").landing.as_deref(), r("B3").done.as_deref()), (Some("B3a"), None), "③ 跨看板指针悬空");
    assert_eq!((r("B4").landing.as_deref(), r("B4").done.as_deref()), (Some("B4c"), Some("B4d")), "④ 落点 = 完成");
    assert_eq!((r("B5").landing, r("B5").done.as_deref()), (None, Some("B5d")), "⑤ 无非完成活列");
    assert_eq!(r("B6"), roles::Roles::default(), "⑥ 看板已删 ⇒ 全 ⊥");
    assert_eq!(r("B0").live_columns, ["B0y", "B0z"], "同 position 按 id");
    assert_eq!(roles::default_board(&conn).unwrap(), "B0", "默认看板同 position 按 id");

    // ① 的后半:列到了 ⇒ 同一指针解析成它(读时降级,不在写时拒)。
    conn.execute(
        "INSERT INTO board_column (id, title, kind, system, position, created_at, board_id) \
         VALUES ('LATE', 'LATE', 'task', 0, 'a2', 't', 'B1')",
        [],
    )
    .unwrap();
    assert_eq!(roles::done_of(&conn, "B1").unwrap().as_deref(), Some("LATE"));
    assert_equivalent(&conn, "named+late");
}

/// 随机事实集:与改前实现逐项同(确定性种子,失败可复现)。
#[test]
fn snapshot_resolution_matches_the_per_id_functions_on_random_states() {
    let conn = bare_db("fuzz");
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = |n: u64| -> u64 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n
    };
    const BOARD_IDS: [&str; 4] = ["tasks", "B1", "B2", "B3"];
    const COL_IDS: [&str; 10] = ["todo", "doing", "done", "C1", "C2", "C3", "C4", "C5", "C6", "C7"];
    const POS: [&str; 3] = ["a0", "a1", "b"];
    let mut seen = [0usize; 5];
    for round in 0..120 {
        let ptr = |r: &mut dyn FnMut(u64) -> u64| -> Option<&'static str> {
            match r(12) {
                0..=2 => None,
                3 => Some("GHOST"),
                k => Some(COL_IDS[(k as usize * 7 + r(10) as usize) % COL_IDS.len()]),
            }
        };
        let nb = 1 + rnd(4) as usize;
        let mut boards: Vec<B> = vec![];
        for (i, id) in BOARD_IDS[..nb].iter().enumerate() {
            let pos = POS[rnd(3) as usize];
            // 种子看板恒活(默认看板恒存在);别的随机死。
            let tomb = i > 0 && rnd(3) == 0;
            let landing = ptr(&mut rnd);
            let done = ptr(&mut rnd);
            boards.push(B { id, pos, tomb, landing, done });
        }
        let mut cols: Vec<C> = vec![];
        for id in COL_IDS {
            if rnd(5) == 0 {
                continue;
            }
            let b = rnd(nb as u64) as usize;
            let pos = POS[rnd(3) as usize];
            let tomb = rnd(4) == 0;
            cols.push(C { id, board: (b > 0).then_some(BOARD_IDS[b]), pos, tomb });
        }
        let stages: Vec<&'static str> = cols.iter().map(|c| c.id).chain(["inbox"]).collect();
        let mut items: Vec<I> = vec![];
        for _ in 0..rnd(25) {
            let stage = stages[rnd(stages.len() as u64) as usize];
            let archived = rnd(4) == 0;
            let sealed = rnd(4) == 0;
            items.push(I { stage, archived, sealed });
        }
        plant(&conn, &boards, &cols, &items);
        assert_equivalent(&conn, &format!("round {round}: {boards:?} {cols:?}"));
        // 覆盖计数:随机流真的走到了几种要紧的形(否则「全等」可能只是一堆空看板全等)。
        let f = roles::Facts::load(&conn).unwrap();
        for b in &boards {
            let r = f.roles(b.id);
            let live = f.board_live(b.id);
            seen[0] += usize::from(r.done.is_some());
            seen[1] += usize::from(live && b.done.is_some() && r.done.is_none());
            seen[2] += usize::from(live && r.landing.is_some() && r.landing.as_deref() != b.landing);
            seen[3] += usize::from(live && r.landing.is_none());
            seen[4] += usize::from(!live);
        }
    }
    assert!(seen.iter().all(|&n| n > 0), "随机流没覆盖到某种形:{seen:?}(完成列 / 完成悬空 / 落点降级 / 落点 ⊥ / 死看板)");
}

// ---- K3:accepts_cards / held -------------------------------------------------------------

#[test]
fn column_rows_say_whether_cards_may_land_and_whether_they_are_held() {
    let conn = bare_db("k3");
    plant(
        &conn,
        &[
            B { id: "tasks", pos: "a0", tomb: false, landing: None, done: Some("done") },
            B { id: "DEAD", pos: "a1", tomb: true, landing: None, done: None },
        ],
        &[
            C { id: "todo", board: None, pos: "a1", tomb: false },
            C { id: "done", board: None, pos: "a2", tomb: false },
            C { id: "gone", board: None, pos: "a3", tomb: true },
            C { id: "late", board: Some("DEAD"), pos: "a1", tomb: false },
            C { id: "both", board: Some("DEAD"), pos: "a2", tomb: true },
        ],
        &[],
    );
    let got: HashMap<String, (bool, bool)> =
        list_columns(&conn).unwrap().into_iter().map(|r| (r.id, (r.accepts_cards, r.held))).collect();
    assert_eq!(got["todo"], (true, false), "活看板的活列:收卡、不在收容区");
    assert_eq!(got["done"], (true, false), "完成列也收卡(拖进去 = 完成)");
    assert_eq!(got["gone"], (false, true), "列已墓碑 ⇒ 收容区");
    assert_eq!(got["late"], (false, true), "看板已墓碑、列自身没有 ⇒ 仍是收容区");
    assert_eq!(got["both"], (false, true));
    assert_eq!(got["inbox"], (false, false), "灵感列两格都假(这两格只答卡片)");
    assert_eq!(got["filed"], (false, false));
}

// ---- K4:每块看板的卡数 -------------------------------------------------------------------

#[test]
fn board_rows_count_live_and_open_cards_with_the_same_counter_as_delete_board() {
    let conn = bare_db("k4");
    plant(
        &conn,
        &[
            B { id: "tasks", pos: "a0", tomb: false, landing: None, done: Some("done") },
            B { id: "PLAIN", pos: "a1", tomb: false, landing: None, done: None },
            B { id: "DEAD", pos: "a2", tomb: true, landing: None, done: None },
        ],
        &[
            C { id: "todo", board: None, pos: "a1", tomb: false },
            C { id: "done", board: None, pos: "a2", tomb: false },
            C { id: "gone", board: None, pos: "a3", tomb: true },
            C { id: "p1", board: Some("PLAIN"), pos: "a1", tomb: false },
            C { id: "p2", board: Some("PLAIN"), pos: "a2", tomb: true },
            C { id: "d1", board: Some("DEAD"), pos: "a1", tomb: false },
        ],
        &[
            I { stage: "todo", archived: false, sealed: false },
            I { stage: "todo", archived: false, sealed: false },
            I { stage: "todo", archived: true, sealed: false },
            I { stage: "done", archived: false, sealed: false },
            I { stage: "done", archived: false, sealed: true },
            I { stage: "gone", archived: false, sealed: false },
            I { stage: "p1", archived: false, sealed: false },
            I { stage: "p2", archived: false, sealed: false },
            I { stage: "p2", archived: false, sealed: false },
            I { stage: "d1", archived: false, sealed: false },
        ],
    );
    let rows: HashMap<String, (i64, i64)> =
        list_boards(&conn).unwrap().into_iter().map(|b| (b.id, (b.live_items, b.open_items))).collect();
    assert_eq!(rows["tasks"], (3, 2), "活列上 3 张(回收站 / 成就册 / 收容区不算);完成列那张不算 open");
    assert_eq!(rows["PLAIN"], (1, 1), "没有完成列 ⇒ open = 全部活卡;墓碑列上的两张在收容区,不算");
    assert_eq!(rows["DEAD"], (0, 0), "已删看板没有活列");
    let f = roles::Facts::load(&conn).unwrap();
    let per = live_item_counts_by_stage(&conn).unwrap();
    assert_eq!(boards::board_card_counts(&f, &per, "PLAIN").owned, 3, "删看板看所有权集合:含收容区那两张");
    assert_eq!(boards::board_card_counts(&f, &per, "tasks").owned, 4);
}

#[test]
fn delete_board_still_refuses_while_its_deleted_columns_hold_cards() {
    let (mut conn, mut clock) = {
        let c = temp_db("k4-del");
        let k = crate::clock::Clock::load(&c).unwrap();
        (c, k)
    };
    let d = &crate::board::gate::DETACHED;
    let b = create_board(&mut conn, &mut clock, "工作", &["待处理", "进行中", "已完成"], Some(2), d).unwrap();
    let cols = live_columns(&conn, &b).unwrap();
    let t = crate::task::create(&mut conn, &mut clock, "卡", None, None, None, Some(&b), d).unwrap();
    crate::task::transition(&mut conn, &mut clock, &t, &cols[1], d).unwrap();
    let row = list_boards(&conn).unwrap().into_iter().find(|r| r.id == b).unwrap();
    assert_eq!((row.live_items, row.open_items), (1, 1));
    crate::task::transition(&mut conn, &mut clock, &t, &cols[2], d).unwrap();
    let row = list_boards(&conn).unwrap().into_iter().find(|r| r.id == b).unwrap();
    assert_eq!((row.live_items, row.open_items), (1, 0), "进了完成列 ⇒ 不算 open");
    let err = delete_board(&mut conn, &mut clock, &b).unwrap_err();
    assert!(err.contains("还有 1 张卡"), "{err}");
}

// ---- K5:回收站 / 成就册计数 ----------------------------------------------------------------

#[test]
fn trash_and_sealed_counts_match_the_lists_they_stand_for() {
    let conn = bare_db("k5");
    plant(
        &conn,
        &[
            B { id: "tasks", pos: "a0", tomb: false, landing: None, done: Some("done") },
            B { id: "B1", pos: "a1", tomb: false, landing: None, done: Some("b1d") },
            B { id: "DEAD", pos: "a2", tomb: true, landing: None, done: Some("xd") },
        ],
        &[
            C { id: "todo", board: None, pos: "a1", tomb: false },
            C { id: "done", board: None, pos: "a2", tomb: false },
            C { id: "b1d", board: Some("B1"), pos: "a1", tomb: false },
            C { id: "xd", board: Some("DEAD"), pos: "a1", tomb: false },
        ],
        &[
            I { stage: "done", archived: false, sealed: true },
            I { stage: "done", archived: false, sealed: true },
            I { stage: "b1d", archived: false, sealed: true },
            I { stage: "xd", archived: false, sealed: true },
            // 双轴行:归成就册、不进回收站。
            I { stage: "xd", archived: true, sealed: true },
            I { stage: "todo", archived: true, sealed: false },
            I { stage: "inbox", archived: true, sealed: false },
            I { stage: "inbox", archived: true, sealed: false },
            I { stage: "inbox", archived: false, sealed: false },
        ],
    );
    let sealed: Vec<(Option<String>, i64)> =
        sealed_counts_by_board(&conn).unwrap().into_iter().map(|c| (c.board_id, c.n)).collect();
    assert_eq!(
        sealed,
        vec![(Some("B1".to_string()), 1), (Some("DEAD".to_string()), 2), (Some("tasks".to_string()), 2)],
        "按 board_of(stage) 分组,含已删看板与双轴行"
    );
    let total: i64 = sealed.iter().map(|(_, n)| n).sum();
    assert_eq!(total as usize, crate::repo::sealed_tasks(&conn).unwrap().len(), "各组之和 = 归档册条数");

    let tc = crate::repo::trash_counts(&conn).unwrap();
    assert_eq!(tc.tasks as usize, crate::repo::archived_tasks(&conn).unwrap().len());
    assert_eq!(tc.ideas as usize, crate::repo::idea_trash(&conn).unwrap().len());
    assert_eq!((tc.ideas, tc.tasks), (2, 1), "双轴行不进回收站");
    assert_eq!((tc.idea_images, tc.task_images), (0, 0));
    assert_eq!(
        (tc.ideas + tc.tasks) as usize,
        crate::repo::trash_items(&conn).unwrap().len(),
        "统一回收站 = 两类之和"
    );
}

/// 封存行落在非任务列上(第一方造不出,远端 / 旧库可能):如实分出 `None` 一组,不丢、不并。
#[test]
fn a_sealed_row_off_any_board_is_counted_in_its_own_group() {
    let conn = bare_db("k5-orphan");
    plant(
        &conn,
        &[B { id: "tasks", pos: "a0", tomb: false, landing: None, done: Some("done") }],
        &[C { id: "done", board: None, pos: "a1", tomb: false }],
        &[I { stage: "done", archived: false, sealed: true }, I { stage: "inbox", archived: false, sealed: true }],
    );
    assert_eq!(
        sealed_counts_by_board(&conn).unwrap(),
        vec![SealedCount { board_id: None, n: 1 }, SealedCount { board_id: Some("tasks".to_string()), n: 1 }]
    );
}

// ---- codex mbopt 一轮补的两种关联状态(等价测原先没覆盖) ----------------------------------

/// 任务列的 `board_id` 指向一块**不存在**的看板(FK 关着时写进来的;正常库造不出)。
/// 新旧同答:归属照报那个 id,角色全空、不收卡、不在收容区(看板不存在 ≠ 看板已删)。
#[test]
fn a_column_owned_by_a_missing_board_resolves_the_same_as_before() {
    let conn = bare_db("missing-board");
    plant(
        &conn,
        &[B { id: "tasks", pos: "a0", tomb: false, landing: Some("ORPH"), done: Some("done") }],
        &[C { id: "todo", board: None, pos: "a1", tomb: false }, C { id: "done", board: None, pos: "a2", tomb: false }],
        &[I { stage: "todo", archived: false, sealed: false }],
    );
    conn.execute_batch(
        "PRAGMA foreign_keys = OFF;
         INSERT INTO board_column (id, title, kind, system, position, created_at, board_id)
              VALUES ('ORPH', 'ORPH', 'task', 0, 'a3', 't', 'NOBOARD');
         PRAGMA foreign_keys = ON;",
    )
    .unwrap();
    let dev: String =
        conn.query_row("SELECT value FROM sync_meta WHERE key='device_id'", [], |r| r.get(0)).unwrap();
    conn.execute(
        "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage, born_device) \
         VALUES ('IORPH', 'x', 'ORPH', 't', 't', 'a0', 'ORPH', ?1)",
        [&dev],
    )
    .unwrap();
    assert_equivalent(&conn, "missing board");
    let row = list_columns(&conn).unwrap().into_iter().find(|r| r.id == "ORPH").unwrap();
    assert_eq!(row.board_id.as_deref(), Some("NOBOARD"));
    assert_eq!((row.accepts_cards, row.held, row.board_deleted), (false, false, false));
    assert_eq!(roles::Facts::load(&conn).unwrap().roles("NOBOARD"), roles::Roles::default());
    // 种子看板的落点指针指着它 ⇒ 不在种子的活列里 ⇒ 降级到最左。
    assert_eq!(roles::landing_of(&conn, "tasks").unwrap().as_deref(), Some("todo"));
}

/// 种子看板那一行缺失,而种子列 `board_id IS NULL`(归属 = 'tasks')。新旧同答:`board_of` 报
/// 'tasks',但它们不收卡、角色全空;默认看板落到另一块活看板。
#[test]
fn seed_columns_without_a_seed_board_row_resolve_the_same_as_before() {
    let conn = bare_db("missing-seed");
    plant(
        &conn,
        &[B { id: "B1", pos: "a1", tomb: false, landing: None, done: Some("b1d") }],
        &[
            C { id: "todo", board: None, pos: "a1", tomb: false },
            C { id: "done", board: None, pos: "a2", tomb: false },
            C { id: "b1a", board: Some("B1"), pos: "a1", tomb: false },
            C { id: "b1d", board: Some("B1"), pos: "a2", tomb: false },
        ],
        &[I { stage: "todo", archived: false, sealed: false }, I { stage: "done", archived: false, sealed: true }],
    );
    assert_equivalent(&conn, "missing seed board");
    let f = roles::Facts::load(&conn).unwrap();
    assert_eq!(f.board_of("todo"), Some("tasks"));
    assert!(!f.column_accepts_cards("todo") && !f.column_held("todo"));
    assert_eq!(f.roles("tasks"), roles::Roles::default());
    assert_eq!(roles::default_board(&conn).unwrap(), "B1");
}

// ---- codex mbopt 一轮 M1:读模型的几句共用一个读快照 ------------------------------------------

/// 从**另一连接**提交一笔写(读模型在「事实与计数已读、行还没读」那一刻经 `read_seam` 触发)。
fn commit_from_another_connection(path: std::path::PathBuf, sql: String) {
    crate::board::read_seam::arm(move || {
        let other = Connection::open(&path).unwrap();
        other.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
        other.execute_batch(&format!("BEGIN IMMEDIATE; {sql} COMMIT;")).unwrap();
    });
}

fn snapshot_rig(tag: &str) -> (Connection, std::path::PathBuf) {
    let (conn, p) = bare_db_at(tag);
    plant(
        &conn,
        &[B { id: "tasks", pos: "a0", tomb: false, landing: None, done: Some("done") }],
        &[C { id: "todo", board: None, pos: "a1", tomb: false }, C { id: "done", board: None, pos: "a2", tomb: false }],
        &[],
    );
    (conn, p)
}

/// 交错:事实读完后另一连接提交新任务列 C。快照一致 ⇒ C 要么不出现,要么归属正确 ——
/// ⛔ 绝不能是「`kind=task` 却 `board_id=None` / 不收卡」(改前一句 JOIN 造不出的组合)。
#[test]
fn list_columns_never_shows_a_task_column_without_its_board_under_a_concurrent_commit() {
    let (conn, p) = snapshot_rig("snap-cols");
    commit_from_another_connection(
        p,
        "INSERT INTO board_column (id, title, kind, system, position, created_at) \
              VALUES ('NEWC', 'NEWC', 'task', 0, 'a3', 't');"
            .to_string(),
    );
    let rows = list_columns(&conn).unwrap();
    if let Some(c) = rows.iter().find(|r| r.id == "NEWC") {
        assert_eq!((c.board_id.as_deref(), c.accepts_cards), (Some("tasks"), true), "新列出现了就得归属完整:{c:?}");
    }
    assert!(conn.is_autocommit(), "读完收掉自己开的读事务");
    // 下一次读看得到它,归属完整(证明那笔提交真的落了,上面不是因为钩子没跑而空过)。
    let c = list_columns(&conn).unwrap().into_iter().find(|r| r.id == "NEWC").expect("提交后可见");
    assert_eq!((c.board_id.as_deref(), c.accepts_cards), (Some("tasks"), true));
}

/// 交错:另一连接原子建出一块看板连同它的列。快照一致 ⇒ 看板要么不出现,要么带着落点。
#[test]
fn list_boards_never_shows_a_new_board_without_its_landing_under_a_concurrent_commit() {
    let (conn, p) = snapshot_rig("snap-boards");
    commit_from_another_connection(
        p,
        "INSERT INTO board (id, title, position, created_at) VALUES ('NEWB', 'NEWB', 'b', 't'); \
         INSERT INTO board_column (id, title, kind, system, position, created_at, board_id) \
              VALUES ('NEWBC', 'NEWBC', 'task', 0, 'a1', 't', 'NEWB');"
            .to_string(),
    );
    let rows = list_boards(&conn).unwrap();
    if let Some(b) = rows.iter().find(|r| r.id == "NEWB") {
        assert_eq!(b.landing.as_deref(), Some("NEWBC"), "新看板出现了就得带着落点:{b:?}");
    }
    assert!(conn.is_autocommit());
    let b = list_boards(&conn).unwrap().into_iter().find(|r| r.id == "NEWB").expect("提交后可见");
    assert_eq!(b.landing.as_deref(), Some("NEWBC"));
}

/// 交错:另一连接提交新任务列与其上一张封存卡。快照一致 ⇒ 不会凭空多出 `None` 那一组。
#[test]
fn sealed_counts_never_misfile_a_card_under_a_concurrent_commit() {
    let (conn, p) = snapshot_rig("snap-sealed");
    let dev: String =
        conn.query_row("SELECT value FROM sync_meta WHERE key='device_id'", [], |r| r.get(0)).unwrap();
    commit_from_another_connection(
        p,
        format!(
            "INSERT INTO board_column (id, title, kind, system, position, created_at) \
                  VALUES ('NEWS', 'NEWS', 'task', 0, 'a3', 't'); \
             INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage, born_device, sealed_at) \
                  VALUES ('ISEAL', 'x', 'NEWS', 't', 't', 'a0', 'NEWS', '{dev}', '2026-01-01T00:00:00.000Z');"
        ),
    );
    let got = sealed_counts_by_board(&conn).unwrap();
    assert!(got.iter().all(|c| c.board_id.is_some()), "新卡被误分到「不在任何看板」:{got:?}");
    assert!(conn.is_autocommit());
    assert_eq!(
        sealed_counts_by_board(&conn).unwrap(),
        vec![SealedCount { board_id: Some("tasks".to_string()), n: 1 }],
        "提交后可见"
    );
}

/// 调用方已在事务里 ⇒ 不再开事务(SQLite 不支持嵌套 BEGIN),直接用那个事务的快照。
#[test]
fn a_caller_inside_a_transaction_reads_through_its_own_snapshot() {
    let (mut conn, _p) = snapshot_rig("snap-in-tx");
    let tx = conn.transaction().unwrap();
    assert!(list_columns(&tx).unwrap().iter().any(|r| r.id == "todo"));
    assert!(list_boards(&tx).is_ok() && sealed_counts_by_board(&tx).is_ok());
    assert!(!tx.is_autocommit(), "没有替调用方提交或回滚");
    tx.commit().unwrap();
}
