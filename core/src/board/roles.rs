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
//!
//! # 形:一次读事实([`Facts::load`]),一个纯函数解析([`resolve`])
//!
//! 上面那段规则**只在 [`resolve`] 里写一遍**(`board_of` / `board_live` 两格是 [`Facts`]
//! 上的查表)。读模型(`list_columns` / `list_boards`)一次读出 `board` 表与全部任务列,在内存
//! 里对每块看板调它;按 id 的那几只(`landing_of` / `done_of` / `entered_done` …,写命令在
//! 事务里用的)也是「先 [`Facts::load`] 再问同一份 [`Facts`]」—— ⛔ 别再写回一句按 id 拼
//! 角色的 SQL,那就是第二份解析规则。两张表都是个位到几十行的量级,整表读两句比逐 id 读三五句
//! 便宜。

use rusqlite::Connection;

use super::SEED_BOARD;

fn s<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

/// 一块看板的**原始事实**(`board` 表一行,未解析)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BoardFacts {
    pub(crate) id: String,
    pub(crate) tombstoned: bool,
    /// `landing_column_id` 寄存器原值(可能悬空)。
    pub(crate) landing_ptr: Option<String>,
    /// `done_column_id` 寄存器原值(可能悬空)。
    pub(crate) done_ptr: Option<String>,
}

/// 一枚**任务列**的原始事实(`board_column` 里 `kind='task'` 的一行,含已墓碑的)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ColumnFacts {
    pub(crate) id: String,
    /// `board_of` = `COALESCE(board_id, 'tasks')`。
    pub(crate) board: String,
    pub(crate) position: String,
    pub(crate) tombstoned: bool,
}

/// 一块看板解析后的三个结果(plan §3)。看板不存在 / 已删 ⇒ 全空。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Roles {
    /// 活列,按 `(position, id)`。
    pub(crate) live_columns: Vec<String>,
    /// ⊥ = 没有完成列。
    pub(crate) done: Option<String>,
    /// ⊥ = 放不进卡。
    pub(crate) landing: Option<String>,
}

/// ⭐ **§3 的唯一实现**(纯函数,不碰库)。`columns` 可以是全部任务列(别的看板的按归属
/// 滤掉),顺序无所谓 —— 这里自己按 `(position, id)` 排。
///
/// ⚠ 排序用 Rust 的 `str` 序 = 按字节字典序,与 SQLite 对 TEXT 的默认 `BINARY` 排序逐字同
/// (两边都是 memcmp、短者在前);`position` 另有 0036 的 CHECK 钉成 base62 ASCII。
pub(crate) fn resolve(board: Option<&BoardFacts>, columns: &[ColumnFacts]) -> Roles {
    let Some(b) = board.filter(|b| !b.tombstoned) else { return Roles::default() };
    let mut live: Vec<&ColumnFacts> =
        columns.iter().filter(|c| c.board == b.id && !c.tombstoned).collect();
    live.sort_by(|x, y| (x.position.as_str(), x.id.as_str()).cmp(&(y.position.as_str(), y.id.as_str())));
    let live: Vec<String> = live.into_iter().map(|c| c.id.clone()).collect();
    let done = b.done_ptr.clone().filter(|d| live.contains(d));
    let landing = b
        .landing_ptr
        .clone()
        .filter(|l| live.contains(l) && Some(l) != done.as_ref())
        .or_else(|| live.iter().find(|c| Some(*c) != done.as_ref()).cloned());
    Roles { live_columns: live, done, landing }
}

/// 一次读出的角色事实:全部看板 + 全部任务列(含墓碑的)。**两句 SQL**,与看板 / 列的数目无关。
#[derive(Debug, Clone)]
pub(crate) struct Facts {
    pub(crate) boards: Vec<BoardFacts>,
    pub(crate) columns: Vec<ColumnFacts>,
}

impl Facts {
    pub(crate) fn load(conn: &Connection) -> Result<Self, String> {
        let mut stmt = s(conn.prepare_cached(
            "SELECT id, tombstoned_at IS NOT NULL, landing_column_id, done_column_id FROM board",
        ))?;
        let boards = s(s(stmt.query_map([], |r| {
            Ok(BoardFacts {
                id: r.get(0)?,
                tombstoned: r.get(1)?,
                landing_ptr: r.get(2)?,
                done_ptr: r.get(3)?,
            })
        }))?
        .collect::<rusqlite::Result<Vec<_>>>())?;
        let mut stmt = s(conn.prepare_cached(
            "SELECT id, COALESCE(board_id, ?1), position, tombstoned_at IS NOT NULL \
               FROM board_column WHERE kind = 'task'",
        ))?;
        let columns = s(s(stmt.query_map([SEED_BOARD], |r| {
            Ok(ColumnFacts { id: r.get(0)?, board: r.get(1)?, position: r.get(2)?, tombstoned: r.get(3)? })
        }))?
        .collect::<rusqlite::Result<Vec<_>>>())?;
        Ok(Facts { boards, columns })
    }

    fn board(&self, board_id: &str) -> Option<&BoardFacts> {
        self.boards.iter().find(|b| b.id == board_id)
    }

    fn column(&self, column_id: &str) -> Option<&ColumnFacts> {
        self.columns.iter().find(|c| c.id == column_id)
    }

    /// 一枚**任务列**属于哪块看板;灵感列 / 不存在的列 → `None`。⚠ 不看死活。
    pub(crate) fn board_of(&self, column_id: &str) -> Option<&str> {
        self.column(column_id).map(|c| c.board.as_str())
    }

    /// 看板存在且未删。
    pub(crate) fn board_live(&self, board_id: &str) -> bool {
        self.board(board_id).is_some_and(|b| !b.tombstoned)
    }

    /// 看板存在且已删(收容区那一半)。⚠ 与 [`Self::board_live`] 不互补:不存在的看板两者
    /// 都假(`board_column.board_id` 有 FK,任务列上读不到这种看板)。
    pub(crate) fn board_tombstoned(&self, board_id: &str) -> bool {
        self.board(board_id).is_some_and(|b| b.tombstoned)
    }

    /// 这块看板的 §3 三个结果 —— 经 [`resolve`],⛔ 别在这儿另写一遍。
    pub(crate) fn roles(&self, board_id: &str) -> Roles {
        resolve(self.board(board_id), &self.columns)
    }

    /// 这一列是不是**它所在看板解析后的完成列**。
    pub(crate) fn is_done_column(&self, column_id: &str) -> bool {
        match self.board_of(column_id) {
            Some(b) => self.roles(b).done.as_deref() == Some(column_id),
            None => false,
        }
    }

    /// 一枚卡能不能**落进**这一列:列是活的任务列 ∧ 它的看板活着(plan §3:「可落」两半)。
    pub(crate) fn column_accepts_cards(&self, column_id: &str) -> bool {
        self.column(column_id).is_some_and(|c| !c.tombstoned && self.board_live(&c.board))
    }

    /// 这一列上的活卡属不属**收容区**(plan §3a):任务列 ∧ (列已墓碑 ∨ 看板已墓碑)。
    /// ⚠ 判的是列,不看它此刻有没有卡;灵感列恒 `false`。
    pub(crate) fn column_held(&self, column_id: &str) -> bool {
        self.column(column_id).is_some_and(|c| c.tombstoned || self.board_tombstoned(&c.board))
    }
}

/// 一枚**任务列**属于哪块看板;灵感列 / 不存在的列 → `None`。⚠ 不看死活。
pub(crate) fn board_of(conn: &Connection, column_id: &str) -> Result<Option<String>, String> {
    Ok(Facts::load(conn)?.board_of(column_id).map(str::to_string))
}

/// 看板存在且未删。
pub(crate) fn board_live(conn: &Connection, board_id: &str) -> Result<bool, String> {
    Ok(Facts::load(conn)?.board_live(board_id))
}

/// 一块看板的活列,按 `(position, id)`。看板已删 ⇒ 空。
pub(crate) fn live_columns(conn: &Connection, board_id: &str) -> Result<Vec<String>, String> {
    Ok(Facts::load(conn)?.roles(board_id).live_columns)
}

/// 解析后的完成列;⊥ = 这块看板没有完成列(纯分类 / 指针悬空 / 看板已删)。
pub(crate) fn done_of(conn: &Connection, board_id: &str) -> Result<Option<String>, String> {
    Ok(Facts::load(conn)?.roles(board_id).done)
}

/// 解析后的落点;⊥ = 这块看板放不进卡(只可能来自并发删,或只剩完成列)。
pub(crate) fn landing_of(conn: &Connection, board_id: &str) -> Result<Option<String>, String> {
    Ok(Facts::load(conn)?.roles(board_id).landing)
}

/// 默认看板 = 活看板里 `(position, id)` 最小的那块(用户拍 ④:侧栏最上面那块)。
pub(crate) fn default_board(conn: &Connection) -> Result<String, String> {
    s(conn
        .prepare_cached("SELECT id FROM board WHERE tombstoned_at IS NULL ORDER BY position, id LIMIT 1")
        .and_then(|mut st| st.query_row([], |r| r.get(0))))
    .map_err(|e| format!("找不到任何活着的看板(种子看板不可删,这是库损坏):{e}"))
}

/// 「进入完成列」这条边(plan §3;codex 二轮 M4):新列是它看板的完成列 ∧ 旧列不是它看板的
/// 完成列。⭐ **调用方在 UPDATE 之前算一次,同一个布尔同时驱动 SQL 的盖章与 oplog 的字段
/// 发射**,⛔ 别各判一次。两头问的是**同一份** [`Facts`](同一事务里读一次)。
pub(crate) fn entered_done(conn: &Connection, from: &str, to: &str) -> Result<bool, String> {
    if from == to {
        return Ok(false);
    }
    let f = Facts::load(conn)?;
    Ok(f.is_done_column(to) && !f.is_done_column(from))
}

/// 一枚卡能不能**落进**这一列:列是活的任务列 ∧ 它的看板活着(plan §3:「可落」两半)。
pub(crate) fn column_accepts_cards(conn: &Connection, column_id: &str) -> Result<bool, String> {
    Ok(Facts::load(conn)?.column_accepts_cards(column_id))
}

#[cfg(test)]
mod tests;
