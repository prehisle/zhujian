//! 多看板的**写命令与读模型**(multiboard-plan §3 / §3a / §6)。角色判定一律经 [`super::roles`]。
//!
//! 发送端闸(plan §5.1,codex 设计审一轮判):`board/*` **不过** `board_columns_v1` 那道闸 ——
//! 它证明不了 `board` 词汇的兼容性,只会挡住未闩空间;旧端走挂起直发(用户拍 ⑪)。⚠ 但建看板会
//! 顺带建列,列 op 照旧过闸 ⇒ [`create_board`] 在写任何东西之前先问闸。
//!
//! ⛔ 列名 / 看板名这类可见文案由前端按语言传进来,core 不造界面文案。

use rusqlite::{Connection, OptionalExtension};
use ulid::Ulid;

use super::{gate, live_item_count, roles, SEED_BOARD, SEED_BOARD_ROW};
use crate::clock::Clock;
use crate::{frindex, oplog, repo};

fn s<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

/// 一块看板的读模型(两端 UI 的唯一读法)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardRow {
    pub id: String,
    pub title: String,
    /// 种子看板的标题还是 canonical(没被改过)⇒ `false`,前端按本端字典显示(同种子列
    /// 的 §7.1d 终态判据);用户看板恒 `true`。
    pub is_title_overridden: bool,
    pub position: String,
    /// 解析后的落点;`None` = 放不进卡。
    pub landing: Option<String>,
    /// 解析后的完成列;`None` = 纯分类看板。
    pub done: Option<String>,
    /// 已删(还装着卡的话住收容区,plan §3a)。
    pub deleted: bool,
    /// 默认看板(随记「转待办」落这里):活看板里排最前那块。
    pub is_default: bool,
    /// 种子看板不可删。
    pub deletable: bool,
}

/// 全部看板,按 `(position, id)`;含已删的(收容区要靠它解释来处)。
pub fn list_boards(conn: &Connection) -> Result<Vec<BoardRow>, String> {
    let default = roles::default_board(conn)?;
    let mut stmt = s(conn.prepare(
        "SELECT id, title, position, tombstoned_at IS NOT NULL FROM board ORDER BY position, id",
    ))?;
    let rows: Vec<(String, String, String, bool)> = s(s(stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))))?
    .collect())?;
    rows.into_iter()
        .map(|(id, title, position, deleted)| {
            let seed = id == SEED_BOARD;
            Ok(BoardRow {
                is_title_overridden: !(seed && title == SEED_BOARD_ROW.canonical_title),
                landing: roles::landing_of(conn, &id)?,
                done: roles::done_of(conn, &id)?,
                is_default: id == default,
                deletable: !seed,
                id,
                title,
                position,
                deleted,
            })
        })
        .collect()
}

fn ensure_live_board(conn: &Connection, id: &str) -> Result<(), String> {
    let row: Option<bool> = s(conn
        .query_row("SELECT tombstoned_at IS NULL FROM board WHERE id = ?1", [id], |r| r.get(0))
        .optional())?;
    match row {
        None => Err(format!("看板不存在:{id}")),
        Some(false) => Err("这块看板已删除,不可修改".to_string()),
        Some(true) => Ok(()),
    }
}

fn clean_title(title: &str, what: &str) -> Result<String, String> {
    let t = title.trim();
    if t.is_empty() {
        return Err(format!("{what}不能为空"));
    }
    repo::ensure_content_fits(t)?;
    Ok(t.to_string())
}

/// 建一块看板,连同它的初始列(`columns` 由前端按模板与语言给,至少一列)。`done_index` =
/// 哪一列是完成列(`None` = 纯分类看板)。落点不设(NULL = 最左那枚非完成列)。
/// 一个事务:看板 → 列(`create_in_board`)→ 完成指针;任何一步失败整体回滚、不留 op。
pub fn create_board(
    conn: &mut Connection,
    clock: &mut Clock,
    title: &str,
    columns: &[&str],
    done_index: Option<usize>,
    facts: &gate::RuntimeFacts,
) -> Result<String, String> {
    let title = clean_title(title, "看板名")?;
    if columns.is_empty() {
        return Err("新看板至少要有一列".to_string());
    }
    let cols: Vec<String> =
        columns.iter().map(|c| clean_title(c, "列名")).collect::<Result<_, _>>()?;
    if let Some(i) = done_index {
        if i >= cols.len() {
            return Err(format!("完成列序号越界:{i}"));
        }
        if cols.len() < 2 {
            return Err("只有一列的看板不能把它设成完成列(那样就没有地方放新卡)".to_string());
        }
    }
    let id = Ulid::new().to_string();
    let created_at = repo::now_iso_millis();

    let tx = s(conn.transaction())?;
    // 列 op 要过闸(§5.1);在写任何东西之前问,同一快照(首版自检清单 10)。
    gate::ensure_can_emit(&tx, facts)?;
    let last: Option<String> = s(tx
        .query_row("SELECT position FROM board ORDER BY position DESC LIMIT 1", [], |r| r.get(0))
        .optional())?;
    let position = frindex::key_between(last.as_deref(), None)?;
    tx.execute(
        "INSERT INTO board (id, title, position, created_at) VALUES (?1, ?2, ?3, ?4)",
        (&id, &title, &position, &created_at),
    )
    .map_err(|e| format!("建看板失败({id}):{e}"))?;
    oplog::board_create(&tx, clock, &id)?;

    let mut col_ids = vec![];
    for name in &cols {
        col_ids.push(super::insert_column_row(&tx, name, Some(&id), &created_at)?);
        oplog::board_column_create(&tx, clock, col_ids.last().expect("刚推进去"))?;
    }
    if let Some(i) = done_index {
        tx.execute("UPDATE board SET done_column_id = ?2 WHERE id = ?1", (&id, &col_ids[i]))
            .map_err(|e| format!("设完成列失败:{e}"))?;
        oplog::board_set(&tx, clock, &id, &["done_column_id"])?;
    }
    s(tx.commit())?;
    Ok(id)
}

pub fn rename_board(conn: &mut Connection, clock: &mut Clock, id: &str, title: &str) -> Result<(), String> {
    let title = clean_title(title, "看板名")?;
    let tx = s(conn.transaction())?;
    ensure_live_board(&tx, id)?;
    tx.execute("UPDATE board SET title = ?2 WHERE id = ?1", (id, &title))
        .map_err(|e| format!("改名失败:{e}"))?;
    oplog::board_set(&tx, clock, id, &["title"])?;
    s(tx.commit())
}

/// 排序:落到 `prev_id` 与 `next_id` 之间(同列排序的形)。排最前 = 默认看板(用户拍 ④)。
pub fn reorder_board(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    prev_id: Option<&str>,
    next_id: Option<&str>,
) -> Result<(), String> {
    let tx = s(conn.transaction())?;
    ensure_live_board(&tx, id)?;
    let key_of = |who: &str, nb: Option<&str>| -> Result<Option<String>, String> {
        let Some(nid) = nb else { return Ok(None) };
        let k: Option<String> = s(tx
            .query_row("SELECT position FROM board WHERE id = ?1", [nid], |r| r.get(0))
            .optional())?;
        k.map(Some).ok_or_else(|| format!("{who}的看板已不存在,已忽略本次排序,请重试"))
    };
    let prev = key_of("前一个", prev_id)?;
    let next = key_of("后一个", next_id)?;
    let key = frindex::key_between(prev.as_deref(), next.as_deref())?;
    tx.execute("UPDATE board SET position = ?2 WHERE id = ?1", (id, &key))
        .map_err(|e| format!("看板排序写入失败:{e}"))?;
    oplog::board_set(&tx, clock, id, &["position"])?;
    s(tx.commit())
}

/// 指定落点列:必须是这块看板的活列、且不是它的完成列。**不设清空前置**(codex 设计审一轮:
/// 落点变不改变任何卡的完成状态)。
pub fn set_board_landing(conn: &mut Connection, clock: &mut Clock, id: &str, column: &str) -> Result<(), String> {
    let tx = s(conn.transaction())?;
    ensure_live_board(&tx, id)?;
    if !roles::live_columns(&tx, id)?.iter().any(|c| c == column) {
        return Err("落点只能设成这块看板上还在的列".to_string());
    }
    if roles::done_of(&tx, id)?.as_deref() == Some(column) {
        return Err("完成列不能同时当新卡落点,请先换一列".to_string());
    }
    tx.execute("UPDATE board SET landing_column_id = ?2 WHERE id = ?1", (id, column))
        .map_err(|e| format!("设落点失败:{e}"))?;
    oplog::board_set(&tx, clock, id, &["landing_column_id"])?;
    s(tx.commit())
}

/// 指定 / 取消完成列(`None` = 取消,看板变纯分类)。前置(plan §3):**新旧两列都没有活卡**
/// —— 只防单机意外,不承担一致性(两种 done_at 不一致都是合法终态);新完成列不能是当前落点。
pub fn set_board_done(conn: &mut Connection, clock: &mut Clock, id: &str, column: Option<&str>) -> Result<(), String> {
    let tx = s(conn.transaction())?;
    ensure_live_board(&tx, id)?;
    let old = roles::done_of(&tx, id)?;
    // 幂等比的是**原始寄存器值**,不是解析后的 done(codex 实现审 2b 一轮 M2:指针悬空时解析为
    // ⊥,「取消」会被误当成同值 no-op,不清指针、不发 op,迟到的那列一到完成角色就复活)。
    let raw: Option<String> = s(tx.query_row("SELECT done_column_id FROM board WHERE id = ?1", [id], |r| r.get(0)))?;
    if raw.as_deref() == column {
        return Ok(());
    }
    if let Some(c) = column {
        let live = roles::live_columns(&tx, id)?;
        if !live.iter().any(|x| x == c) {
            return Err("完成列只能设成这块看板上还在的列".to_string());
        }
        if live.len() < 2 {
            return Err("只有一列的看板不能设完成列(那样就没有地方放新卡)".to_string());
        }
        if roles::landing_of(&tx, id)?.as_deref() == Some(c) {
            return Err("这一列是新卡落点,请先把落点换到别的列".to_string());
        }
    }
    for c in old.iter().map(String::as_str).chain(column) {
        let n = s(live_item_count(&tx, c))?;
        if n > 0 {
            return Err(format!("改完成列前,请先把相关列里的 {n} 张卡挪走"));
        }
    }
    tx.execute("UPDATE board SET done_column_id = ?2 WHERE id = ?1", (id, column))
        .map_err(|e| format!("设完成列失败:{e}"))?;
    oplog::board_set(&tx, clock, id, &["done_column_id"])?;
    s(tx.commit())
}

/// 删看板(plan §3a):种子看板不可删;**它的全部列**(含已墓碑的,即收容区里那些)上没有
/// 活卡才能删 —— 回收站 / 成就册里的卡不算,它们以后还原就进收容区。⛔ 别拿目的地集合
/// `live_columns` 代替所有权集合(codex 实现审 2b 一轮 M3)。**只发看板墓碑**,不逐列发。
/// 墓碑走 0043 授权表(先发 op、再登记、再改行)。
pub fn delete_board(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    if id == SEED_BOARD {
        return Err("「任务」这块看板不可删除".to_string());
    }
    let tx = s(conn.transaction())?;
    ensure_live_board(&tx, id)?;
    let live: i64 = s(tx.query_row(
        "SELECT COUNT(*) FROM items i JOIN board_column c ON c.id = i.stage \
          WHERE c.kind = 'task' AND COALESCE(c.board_id, ?2) = ?1 \
            AND i.archived_at IS NULL AND i.sealed_at IS NULL",
        [id, SEED_BOARD],
        |r| r.get(0),
    ))?;
    if live > 0 {
        return Err(format!("这块看板上还有 {live} 张卡,请先挪走再删除"));
    }
    let (op_id, hlc) = oplog::board_tombstone(&tx, clock, id)?;
    tx.execute(
        "INSERT INTO sync_board_tombstone_apply (board_id, op_id, from_hlc, to_hlc, mode) \
         VALUES (?1, ?2, NULL, ?3, 'apply_min')",
        (id, &op_id, &hlc),
    )
    .map_err(|e| format!("登记看板墓碑授权失败:{e}"))?;
    tx.execute("UPDATE board SET tombstoned_at = ?2 WHERE id = ?1", (id, &hlc))
        .map_err(|e| format!("删看板失败:{e}"))?;
    s(tx.commit())
}
