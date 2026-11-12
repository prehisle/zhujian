//! 多看板的**角色解析**(multiboard-plan §3)—— 「落点」「完成」两个角色、默认看板、
//! 「这一列 / 这块看板还活着吗」的**唯一一份**实现。⛔ 全仓凡判角色一律经这里,别再写
//! `stage = 'done'` / `"todo"` 这类字面量(plan §1 不变量 3)。
//!
//! ```text
//! board_of(column)  = column.board_id ?? 'tasks'                 -- 仅 kind='task'
//! board_live(b)     = b 存在 ∧ b.tombstoned_at IS NULL
//! live_columns(b)   = board_live(b) 时:未墓碑的 task 列 where board_of = b, ORDER BY (position, id);否则 ∅
//! done(b)           = b.done_column_id    若 ∈ live_columns(b) 否则 ⊥
//! landing(b)        = b.landing_column_id 若 ∈ live_columns(b) ∧ ≠ done(b)
//!                     否则 live_columns(b) 中第一枚 ≠ done(b) 的列 否则 ⊥
//! default_board     = 活看板 ORDER BY (position, id) 第一块(种子不可删 ⇒ 恒存在)
//! ```
//!
//! ⭐ **悬空一律读时降级,不在写时拒**(plan §3):角色指针是 LWW 寄存器,可被并发墓碑弄成
//! 悬空;对同一组最终事实,上面几个结果是确定的(codex 设计审一轮核过)。
//! ⚠ 调用方要**在同一事务里读目的地、写卡**(first-draft-checklist 第 10 条)。

use rusqlite::{Connection, OptionalExtension};

use super::SEED_BOARD;

fn s<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

/// 一枚**任务列**属于哪块看板;灵感列 / 不存在的列 → `None`。⚠ 不看死活。
pub(crate) fn board_of(conn: &Connection, column_id: &str) -> Result<Option<String>, String> {
    s(conn
        .query_row(
            "SELECT COALESCE(board_id, ?2) FROM board_column WHERE id = ?1 AND kind = 'task'",
            [column_id, SEED_BOARD],
            |r| r.get(0),
        )
        .optional())
}

/// 看板存在且未删。
pub(crate) fn board_live(conn: &Connection, board_id: &str) -> Result<bool, String> {
    Ok(s(conn
        .query_row(
            "SELECT tombstoned_at IS NULL FROM board WHERE id = ?1",
            [board_id],
            |r| r.get::<_, bool>(0),
        )
        .optional())?
    .unwrap_or(false))
}

/// 一块看板的活列,按 `(position, id)`。看板已删 ⇒ 空。
pub(crate) fn live_columns(conn: &Connection, board_id: &str) -> Result<Vec<String>, String> {
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

/// 解析后的完成列;⊥ = 这块看板没有完成列(纯分类 / 指针悬空 / 看板已删)。
pub(crate) fn done_of(conn: &Connection, board_id: &str) -> Result<Option<String>, String> {
    let live = live_columns(conn, board_id)?;
    let (_, done) = pointers(conn, board_id)?;
    Ok(done.filter(|d| live.contains(d)))
}

/// 解析后的落点;⊥ = 这块看板放不进卡(只可能来自并发删,或只剩完成列)。
pub(crate) fn landing_of(conn: &Connection, board_id: &str) -> Result<Option<String>, String> {
    let live = live_columns(conn, board_id)?;
    let (landing, done) = pointers(conn, board_id)?;
    let done = done.filter(|d| live.contains(d));
    if let Some(l) = landing.filter(|l| live.contains(l) && Some(l) != done.as_ref()) {
        return Ok(Some(l));
    }
    Ok(live.into_iter().find(|c| Some(c) != done.as_ref()))
}

/// 默认看板 = 活看板里 `(position, id)` 最小的那块(用户拍 ④:侧栏最上面那块)。
pub(crate) fn default_board(conn: &Connection) -> Result<String, String> {
    s(conn.query_row(
        "SELECT id FROM board WHERE tombstoned_at IS NULL ORDER BY position, id LIMIT 1",
        [],
        |r| r.get(0),
    ))
    .map_err(|e| format!("找不到任何活着的看板(种子看板不可删,这是库损坏):{e}"))
}

/// 这一列是不是**它所在看板解析后的完成列**。
pub(crate) fn is_done_column(conn: &Connection, column_id: &str) -> Result<bool, String> {
    match board_of(conn, column_id)? {
        Some(b) => Ok(done_of(conn, &b)?.as_deref() == Some(column_id)),
        None => Ok(false),
    }
}

/// 「进入完成列」这条边(plan §3;codex 二轮 M4):新列是它看板的完成列 ∧ 旧列不是它看板的
/// 完成列。⭐ **调用方在 UPDATE 之前算一次,同一个布尔同时驱动 SQL 的盖章与 oplog 的字段
/// 发射**,⛔ 别各判一次。
pub(crate) fn entered_done(conn: &Connection, from: &str, to: &str) -> Result<bool, String> {
    Ok(from != to && is_done_column(conn, to)? && !is_done_column(conn, from)?)
}

/// 一枚卡能不能**落进**这一列:列是活的任务列 ∧ 它的看板活着(plan §3:「可落」两半)。
pub(crate) fn column_accepts_cards(conn: &Connection, column_id: &str) -> Result<bool, String> {
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
