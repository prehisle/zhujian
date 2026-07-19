//! Task board state machine over the unified `items` table. A board card is an item at
//! a task stage (todo/doing/confirming/done), moving freely among them in either
//! direction — a personal todo wants quick todo↔done, and 'confirming' (待确认) is an
//! OPTIONAL holding place, never a mandatory gate. Nothing here swallows errors — a
//! missing card or an illegal move fails fast.
//!
//! oplog 接线(sync-plan P1):每个写编排在自己的事务里「改数据 + 发射 op」。列内序是
//! fractional index(0021,frindex.rs):拖动只改被拖那张卡的键,一次拖动一条 position
//! op(跨列再加一条 stage)——64 记录的「整列发射」噪音就此收敛;幂等 no-op(标签已在/
//! 已不在、原位落下)不发射。语义见 oplog.rs 模块头。

use rusqlite::Connection;

use crate::clock::Clock;
use crate::{frindex, oplog, repo};

/// The four board stages, in pipeline order. Single source of truth: both `legal` and
/// the drag column-guard read it, so a new stage is added here alone.
pub(crate) const STATES: [&str; 4] = ["todo", "doing", "confirming", "done"];

/// Whether `from → to` is a legal board move (any stage to any other; not a self-move,
/// not an unknown stage).
fn legal(from: &str, to: &str) -> bool {
    from != to && STATES.contains(&from) && STATES.contains(&to)
}

/// Move a card to a new stage, validating against its current one. Fails fast if the
/// card is missing/archived or the move is illegal — no fallback, no silent no-op.
pub fn transition(conn: &mut Connection, clock: &mut Clock, id: &str, to: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let from = repo::active_task_stage(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("任务不存在或已归档: {id}"))?;
    if !legal(&from, to) {
        return Err(format!("非法的状态流转:{from} → {to}"));
    }
    let changed = repo::set_task_stage(&tx, id, &from, to).map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err(format!("流转失败:任务状态已变化(期望 {from}),已忽略本次操作"));
    }
    // set_task_stage 同时把卡落到目标列末尾——stage 与 position 都变了。
    oplog::item_set(&tx, clock, id, &["stage", "position"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reorder a card within (or into) a board column via drag-and-drop. `ordered_ids` is
/// that column's COMPLETE new order; `base_target_ids` its order BEFORE the move (an
/// optimistic-concurrency check). One transaction, fail-fast — a stale board view is
/// rejected rather than silently overwriting newer truth. Fractional keys (0021): only
/// the dragged card is written — its new key lands strictly between its new neighbours;
/// everyone else keeps their key untouched. See the per-step comments.
pub fn reorder(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    from_status: &str,
    to_status: &str,
    base_target_ids: &[String],
    ordered_ids: &[String],
) -> Result<(), String> {
    if !STATES.contains(&to_status) {
        return Err(format!("非法的目标列:{to_status}"));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // ① the dragged card is on the board and still in the column we dragged it from.
    let cur = repo::active_task_stage(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("任务不存在或已归档:{id}"))?;
    if cur != from_status {
        return Err(format!(
            "看板已变化(任务当前在「{cur}」而非「{from_status}」),已忽略本次排序,请重试"
        ));
    }

    // ② the target column is still exactly what the user saw when they dragged.
    let current_target = repo::column_task_ids(&tx, to_status).map_err(|e| e.to_string())?;
    if current_target != base_target_ids {
        return Err("看板已变化(目标列顺序不一致),已忽略本次排序,请重试".to_string());
    }

    // ③ ordered_ids is well-formed AND is a single-card move: apart from the dragged
    //    card, the order must equal the pre-drag order (a drag moves ONE card; a wider
    //    permutation cannot be expressed by one key write and is rejected, not guessed).
    let mut seen = std::collections::HashSet::new();
    for x in ordered_ids {
        if !seen.insert(x.as_str()) {
            return Err("排序列表含重复任务,已忽略".to_string());
        }
    }
    if !seen.contains(id) {
        return Err("排序列表必须包含被移动的任务".to_string());
    }
    let without: Vec<&str> =
        ordered_ids.iter().map(String::as_str).filter(|x| *x != id).collect();
    let base_wo: Vec<&str> =
        base_target_ids.iter().map(String::as_str).filter(|x| *x != id).collect();
    if without != base_wo {
        return Err(if from_status == to_status {
            "一次拖动只移动一张卡:其余任务的顺序不应改变,已忽略".to_string()
        } else {
            "跨列拖动不应改变目标列其它任务的顺序,已忽略".to_string()
        });
    }
    // 原位落下 = 幂等 no-op:不写不发射。
    if from_status == to_status && ordered_ids == base_target_ids {
        return Ok(());
    }

    // ④ cross-column move: validate against the state machine, then CAS the stage
    //    (lands provisionally at the target column's end — a valid unique slot; the
    //    dropped-slot key overwrites it in ⑤).
    if from_status != to_status {
        if !legal(from_status, to_status) {
            return Err(format!("非法的状态流转:{from_status} → {to_status}"));
        }
        let changed =
            repo::set_task_stage(&tx, id, from_status, to_status).map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("流转失败:任务状态已变化,已忽略本次操作".to_string());
        }
    }

    // ⑤ single-key write: strictly between the dragged card's new neighbours.
    let key = dropped_key(&tx, id, ordered_ids)?;
    let n = repo::set_task_position(&tx, id, to_status, &key).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("排序写入失败(任务 {id},影响 {n} 行)"));
    }

    // 发射:只有被拖卡自己——跨列 stage+position 两条,列内一条。
    if from_status != to_status {
        oplog::item_set(&tx, clock, id, &["stage", "position"])?;
    } else {
        oplog::item_set(&tx, clock, id, &["position"])?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 被拖卡在新列序 `ordered` 中两侧邻居之间的落点键。邻居键从行上读(它们的键不因本次
/// 拖动改变);列里只有被拖卡自己时退化为 (None, None) -> 首键。
fn dropped_key(conn: &Connection, id: &str, ordered: &[String]) -> Result<String, String> {
    let i = ordered.iter().position(|x| x == id).expect("调用方已保证 id 在列表内");
    let neighbour_key = |x: &String| -> Result<String, String> {
        repo::active_task_position(conn, x)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("看板已变化(任务 {x} 已不在列内),已忽略本次排序,请重试"))
    };
    let prev = if i > 0 { Some(neighbour_key(&ordered[i - 1])?) } else { None };
    let next = match ordered.get(i + 1) {
        Some(x) => Some(neighbour_key(x)?),
        None => None,
    };
    frindex::key_between(prev.as_deref(), next.as_deref())
}

/// Reorder a card within (or into) a board column while the board is FILTERED by tag —
/// where the frontend can only see a SUBSET of each column. `visible_after` is the target
/// column's visible cards in their new order (including the dragged card); `base_visible_ids`
/// is that visible subset before the move. The backend reads the FULL column, anchors the
/// dragged card against its visible neighbour (right after the visible card it now
/// follows, or right before the one it now precedes), and writes ONLY that card's key —
/// hidden cards AND untouched visible cards keep their exact keys (0021 semantics; the
/// pre-0021 slot-shuffle that re-filed every visible card is gone). One transaction,
/// fail-fast. Kept SEPARATE from `reorder` (the unfiltered strong path).
pub fn reorder_visible(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    from_status: &str,
    to_status: &str,
    base_visible_ids: &[String],
    visible_after: &[String],
) -> Result<(), String> {
    if !STATES.contains(&to_status) {
        return Err(format!("非法的目标列:{to_status}"));
    }

    let mut after_set = std::collections::HashSet::new();
    for x in visible_after {
        if !after_set.insert(x.as_str()) {
            return Err("可见排序列表含重复任务,已忽略".to_string());
        }
    }
    let mut base_set = std::collections::HashSet::new();
    for x in base_visible_ids {
        if !base_set.insert(x.as_str()) {
            return Err("可见基准列表含重复任务,已忽略".to_string());
        }
    }
    if !after_set.contains(id) {
        return Err("可见排序列表必须包含被移动的任务".to_string());
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let cur = repo::active_task_stage(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("任务不存在或已归档:{id}"))?;
    if cur != from_status {
        return Err(format!(
            "看板已变化(任务当前在「{cur}」而非「{from_status}」),已忽略本次排序,请重试"
        ));
    }

    let full_base = repo::column_task_ids(&tx, to_status).map_err(|e| e.to_string())?;
    let full_set: std::collections::HashSet<&str> = full_base.iter().map(String::as_str).collect();

    for x in base_visible_ids {
        if !full_set.contains(x.as_str()) {
            return Err("看板已变化(基准任务已不在该列),已忽略本次排序,请重试".to_string());
        }
    }
    let visible_in_col: Vec<&String> =
        full_base.iter().filter(|x| base_set.contains(x.as_str())).collect();
    let base_ref: Vec<&String> = base_visible_ids.iter().collect();
    if visible_in_col != base_ref {
        return Err("看板已变化(可见任务顺序不一致),已忽略本次排序,请重试".to_string());
    }

    let after_wo: Vec<&str> =
        visible_after.iter().map(String::as_str).filter(|x| *x != id).collect();
    if from_status == to_status {
        if after_set != base_set {
            return Err("可见排序列表与基准可见任务集合不一致,已忽略".to_string());
        }
        // 单卡拖动契约(同 reorder):除被拖卡外,可见顺序不得变。
        let base_wo: Vec<&str> =
            base_visible_ids.iter().map(String::as_str).filter(|x| *x != id).collect();
        if after_wo != base_wo {
            return Err("一次拖动只移动一张卡:其余可见任务的顺序不应改变,已忽略".to_string());
        }
        // 原位落下 = 幂等 no-op。
        if visible_after == base_visible_ids {
            return Ok(());
        }
    } else {
        if base_set.contains(id) {
            return Err("被移动的任务不应出现在目标列的基准集合中,已忽略".to_string());
        }
        if full_set.contains(id) {
            return Err("被移动的任务已在目标列,已忽略".to_string());
        }
        if after_wo != base_visible_ids.iter().map(String::as_str).collect::<Vec<_>>() {
            return Err("跨列拖动不应改变目标列其它可见任务的顺序,已忽略".to_string());
        }
        if !legal(from_status, to_status) {
            return Err(format!("非法的状态流转:{from_status} → {to_status}"));
        }
        let changed =
            repo::set_task_stage(&tx, id, from_status, to_status).map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("流转失败:任务状态已变化,已忽略本次操作".to_string());
        }
    }

    // 锚定:被拖卡落进完整列(去掉自己)的哪个空隙。可见邻居 -> 完整列下标:
    //   * 有可见前邻 -> 紧跟它之后;
    //   * 拖到可见首位 -> 紧贴新的可见后邻之前;
    //   * 可见列表只有被拖卡(跨列拖进只显示空的筛选列)-> 落完整列末尾。
    let full_wo: Vec<&str> =
        full_base.iter().map(String::as_str).filter(|x| *x != id).collect();
    let j = visible_after.iter().position(|x| x == id).expect("guards ensured id is visible");
    let idx = if j > 0 {
        let prev_vis = visible_after[j - 1].as_str();
        full_wo.iter().position(|x| *x == prev_vis).expect("guards ensured visible ⊆ column") + 1
    } else if let Some(next_vis) = visible_after.get(1) {
        full_wo
            .iter()
            .position(|x| *x == next_vis.as_str())
            .expect("guards ensured visible ⊆ column")
    } else {
        full_wo.len()
    };

    let neighbour_key = |x: &str| -> Result<String, String> {
        repo::active_task_position(&tx, x)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("看板已变化(任务 {x} 已不在列内),已忽略本次排序,请重试"))
    };
    let prev = match idx.checked_sub(1).and_then(|k| full_wo.get(k)) {
        Some(x) => Some(neighbour_key(x)?),
        None => None,
    };
    let next = match full_wo.get(idx) {
        Some(x) => Some(neighbour_key(x)?),
        None => None,
    };
    let key = frindex::key_between(prev.as_deref(), next.as_deref())?;
    let n = repo::set_task_position(&tx, id, to_status, &key).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("排序写入失败(任务 {id},影响 {n} 行)"));
    }

    if from_status != to_status {
        oplog::item_set(&tx, clock, id, &["stage", "position"])?;
    } else {
        oplog::item_set(&tx, clock, id, &["position"])?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Create a user task at the FRONT of the 待办 column, optionally carrying a due date,
/// priority, and/or an initial tag. One transaction: insert the row (lands at the column
/// end — a valid unique slot), reposition it to a front key (one write, nobody else
/// moves), link the optional tag (a bad topic id fails the FK and rolls back). The birth
/// snapshot is emitted AFTER the reposition — 读行发声 makes it carry the final front
/// key, so no extra position op is needed. Title trimmed/non-empty; priority
/// range-checked up front (the DB CHECK is the backstop). Returns the new id.
pub fn create(
    conn: &mut Connection,
    clock: &mut Clock,
    title: &str,
    due_on: Option<&str>,
    priority: Option<i64>,
    topic_id: Option<&str>,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("任务标题不能为空".to_string());
    }
    repo::ensure_content_fits(title)?;
    if let Some(p) = priority {
        if !(1..=3).contains(&p) {
            return Err(format!("优先级只能是 1/2/3(低/中/高)或不设,收到 {p}"));
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = repo::insert_task(&tx, title, due_on, priority).map_err(|e| e.to_string())?;
    let key = repo::front_key(&tx, "todo", &id).map_err(|e| e.to_string())?;
    let n = repo::set_task_position(&tx, &id, "todo", &key).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("置顶写入失败(任务 {id},影响 {n} 行)"));
    }
    oplog::item_create(&tx, clock, &id)?;
    if let Some(t) = topic_id {
        repo::link_item_topic(&tx, &id, t).map_err(|e| e.to_string())?;
        oplog::link_add(&tx, clock, &id, t)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Set or clear a task's due date (a user-local calendar day `YYYY-MM-DD`, or None).
/// Only an active task can be edited; an archived/idea/missing item fails fast.
pub fn set_due(conn: &mut Connection, clock: &mut Clock, id: &str, due_on: Option<&str>) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::set_task_due(&tx, id, due_on).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("设置截止日期失败:任务不存在或已归档,影响行数 {n}"));
    }
    oplog::item_set(&tx, clock, id, &["due_on"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Set or clear a task's priority (1/2/3 = 低/中/高, or None). Range-validated up front.
/// Same active-task guard as `set_due`.
pub fn set_priority(conn: &mut Connection, clock: &mut Clock, id: &str, priority: Option<i64>) -> Result<(), String> {
    if let Some(p) = priority {
        if !(1..=3).contains(&p) {
            return Err(format!("优先级只能是 1/2/3(低/中/高)或不设,收到 {p}"));
        }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::set_task_priority(&tx, id, priority).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("设置优先级失败:任务不存在或已归档,影响行数 {n}"));
    }
    oplog::item_set(&tx, clock, id, &["priority"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Rename an active task (a guarded content edit; the history trigger fires). Title
/// trimmed/non-empty; an archived/idea/missing item fails fast.
pub fn rename(conn: &mut Connection, clock: &mut Clock, id: &str, title: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("任务标题不能为空".to_string());
    }
    repo::ensure_content_fits(title)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::rename_task(&tx, id, title).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("重命名失败:任务不存在或已归档,影响行数 {n}"));
    }
    oplog::item_set(&tx, clock, id, &["content"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Add ONE tag to a task (multi-tag, M:N). Idempotent — re-adding a tag the card already
/// carries is a no-op success (pre-checked, so the FK still fails loudly on a non-existent
/// topic id rather than being swallowed) and emits nothing. Only an active task can be
/// tagged; an archived/idea/missing item fails fast. One transaction.
pub fn add_topic(conn: &mut Connection, clock: &mut Clock, id: &str, topic_id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if repo::active_task_stage(&tx, id).map_err(|e| e.to_string())?.is_none() {
        return Err("打标签失败:任务不存在或已归档".to_string());
    }
    if !repo::item_has_tag(&tx, id, topic_id).map_err(|e| e.to_string())? {
        repo::link_item_topic(&tx, id, topic_id).map_err(|e| e.to_string())?;
        oplog::link_add(&tx, clock, id, topic_id)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Add a tag to a task **by title**, atomically (120 安卓标签面板的「新建并挂上」):
/// 事务内验证任务仍活跃 → 同名标签存在则复用、否则新建(发 topic create op)→ 挂链
/// (已挂则幂等 no-op)。返回标签 id。**不许拆成 create_topic + add_topic 两步**
/// ——第一步成、第二步败会留下一枚没人要的空标签,且两调之间目标可能已被远端
/// 归档(codex 120 设计审 M9);语义对齐 notes::file_to_topic 的 New 分支。
pub fn add_topic_by_title(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    title: &str,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    repo::ensure_content_fits(title)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if repo::active_task_stage(&tx, id).map_err(|e| e.to_string())?.is_none() {
        return Err("打标签失败:任务不存在或已归档".to_string());
    }
    let topic_id = match repo::topic_id_by_title(&tx, title).map_err(|e| e.to_string())? {
        Some(existing) => existing,
        None => {
            let minted = repo::insert_topic(&tx, title).map_err(|e| e.to_string())?;
            oplog::topic_create(&tx, clock, &minted)?;
            minted
        }
    };
    if !repo::item_has_tag(&tx, id, &topic_id).map_err(|e| e.to_string())? {
        repo::link_item_topic(&tx, id, &topic_id).map_err(|e| e.to_string())?;
        oplog::link_add(&tx, clock, id, &topic_id)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(topic_id)
}

/// Remove ONE tag from a task (multi-tag, M:N). Idempotent — removing a tag the card does
/// not carry is a no-op success and emits nothing. Only an active task can be edited; an
/// archived/idea/missing item fails fast. One transaction.
pub fn remove_topic(conn: &mut Connection, clock: &mut Clock, id: &str, topic_id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if repo::active_task_stage(&tx, id).map_err(|e| e.to_string())?.is_none() {
        return Err("去标签失败:任务不存在或已归档".to_string());
    }
    let removed = repo::unlink_item_topic(&tx, id, topic_id).map_err(|e| e.to_string())?;
    if removed == 1 {
        oplog::link_remove(&tx, clock, id, topic_id)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Soft-archive (删除) an active task into the 回收站. Any active card can be archived; an
/// already-archived/missing one fails fast.
pub fn archive(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::archive_task(&tx, id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("删除失败:只有活跃任务(未归档)可移入回收站,影响行数 {n}"));
    }
    oplog::item_set(&tx, clock, id, &["archived_at"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Restore an archived task from the 回收站 to its ORIGINAL column, at that column's end.
/// Reads the frozen stage first; a card not in the 回收站 (or vanished) fails fast.
pub fn restore(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let stage = repo::item_stage(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("还原失败:任务不存在:{id}"))?;
    let n = repo::restore_task(&tx, id, &stage).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("还原失败:这条任务不在回收站,影响行数 {n}"));
    }
    // restore 一并把卡落到原列末尾(旧 position 可能已被占),两个字段都变了。
    oplog::item_set(&tx, clock, id, &["archived_at", "position"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Permanently delete one archived task from the 回收站. Only an archived task can be
/// purged — a live task fails fast. Its tag/history links cascade.
pub fn purge(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::purge_task(&tx, id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("彻底删除失败:这条任务不在回收站,影响行数 {n}"));
    }
    oplog::item_tombstone(&tx, clock, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Empty the task 回收站. Returns how many were permanently removed.
pub fn purge_all(conn: &mut Connection, clock: &mut Clock) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // 先点名再清空(tombstone 逐条发,批量 DELETE 只报数)。
    let ids: Vec<String> =
        repo::archived_tasks(&tx).map_err(|e| e.to_string())?.into_iter().map(|t| t.id).collect();
    let removed = repo::purge_archived_tasks(&tx).map_err(|e| e.to_string())?;
    if removed != ids.len() {
        return Err(format!(
            "清空回收站不一致:点名 {} 条、实删 {removed} 条,已回滚",
            ids.len()
        ));
    }
    for id in &ids {
        oplog::item_tombstone(&tx, clock, id)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(removed)
}

// ---- 成就归档 (sealed_at, 0017) ----------------------------------------------------

/// 归档一条「已完成」任务进成就册(可查、不可删)。只有活跃的 done 可归档;其余 fail fast。
pub fn seal(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::seal_task(&tx, id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("归档失败:只有「已完成」的任务可以归档,影响行数 {n}"));
    }
    oplog::item_set(&tx, clock, id, &["sealed_at"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 一键归档全部「已完成」。空列是 0 条的正常结果,不是错误(UI 自己决定说什么)。
pub fn seal_all(conn: &mut Connection, clock: &mut Clock) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ids = repo::column_task_ids(&tx, "done").map_err(|e| e.to_string())?;
    let sealed = repo::seal_all_done(&tx).map_err(|e| e.to_string())?;
    if sealed != ids.len() {
        return Err(format!(
            "一键归档不一致:点名 {} 条、实归 {sealed} 条,已回滚",
            ids.len()
        ));
    }
    for id in &ids {
        oplog::item_set(&tx, clock, id, &["sealed_at"])?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(sealed)
}

/// 取消归档:任务离开成就册,回到看板「已完成」列的末尾。不在归档里的 fail fast。
pub fn unseal(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::unseal_task(&tx, id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("取消归档失败:这条任务不在归档里,影响行数 {n}"));
    }
    oplog::item_set(&tx, clock, id, &["sealed_at", "position"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::oplog::ops_for;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn fresh_db() -> (Connection, Clock) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-task-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open migrated db");
        let clock = Clock::load(&conn).expect("load clock");
        (conn, clock)
    }

    fn mk(conn: &Connection, title: &str) -> String {
        repo::insert_task(conn, title, None, None).unwrap()
    }
    fn stage_of(conn: &Connection, id: &str) -> String {
        repo::item_stage(conn, id).unwrap().unwrap()
    }
    fn title_of(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT content FROM items WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    }
    fn ids(conn: &Connection, status: &str) -> Vec<String> {
        repo::column_task_ids(conn, status).unwrap()
    }
    fn positions(conn: &Connection, status: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT position FROM items WHERE stage = ?1 AND archived_at IS NULL ORDER BY position")
            .unwrap();
        stmt.query_map([status], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
    fn keys(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn three_todos(conn: &Connection) -> (String, String, String) {
        (mk(conn, "A"), mk(conn, "B"), mk(conn, "C"))
    }
    /// 该条目 set_field op 的 (field, value) 序列(发射断言速记)。
    fn field_ops(conn: &Connection, id: &str) -> Vec<(String, serde_json::Value)> {
        ops_for(conn, "item", id)
            .into_iter()
            .filter(|o| o.kind == "set_field")
            .map(|o| (o.payload["field"].as_str().unwrap().to_string(), o.payload["value"].clone()))
            .collect()
    }

    #[test]
    fn full_pipeline_forward_and_back() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "做点事");
        assert_eq!(stage_of(&conn, &id), "todo");
        transition(&mut conn, &mut clock, &id, "doing").unwrap();
        transition(&mut conn, &mut clock, &id, "done").unwrap();
        assert_eq!(stage_of(&conn, &id), "done");
        transition(&mut conn, &mut clock, &id, "doing").unwrap();
        transition(&mut conn, &mut clock, &id, "todo").unwrap();
        assert_eq!(stage_of(&conn, &id), "todo");
        // 每次流转发 stage+position 两条 op;四次流转共 8 条,按 HLC 序可复原全程。
        let stages: Vec<serde_json::Value> = field_ops(&conn, &id)
            .into_iter()
            .filter(|(f, _)| f == "stage")
            .map(|(_, v)| v)
            .collect();
        assert_eq!(stages, vec!["doing", "done", "doing", "todo"].into_iter().map(serde_json::Value::from).collect::<Vec<_>>());
    }

    #[test]
    fn user_state_allows_direct_todo_done_both_ways() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "快事");
        transition(&mut conn, &mut clock, &id, "done").unwrap();
        transition(&mut conn, &mut clock, &id, "todo").unwrap();
        assert_eq!(stage_of(&conn, &id), "todo");
    }

    #[test]
    fn illegal_moves_are_rejected_and_leave_state_intact() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "x");
        assert!(transition(&mut conn, &mut clock, &id, "inbox").is_err()); // idea stage, not a board stage
        assert!(transition(&mut conn, &mut clock, &id, "bogus").is_err());
        assert!(transition(&mut conn, &mut clock, &id, "todo").is_err()); // self-move
        assert_eq!(stage_of(&conn, &id), "todo");
        assert!(ops_for(&conn, "item", &id).is_empty(), "被拒的流转不发射 op");
    }

    #[test]
    fn confirming_is_an_optional_fourth_state() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "等对方确认");
        transition(&mut conn, &mut clock, &id, "doing").unwrap();
        transition(&mut conn, &mut clock, &id, "confirming").unwrap();
        assert_eq!(stage_of(&conn, &id), "confirming");
        transition(&mut conn, &mut clock, &id, "done").unwrap();
        transition(&mut conn, &mut clock, &id, "confirming").unwrap();
        transition(&mut conn, &mut clock, &id, "doing").unwrap();
        transition(&mut conn, &mut clock, &id, "done").unwrap();
        transition(&mut conn, &mut clock, &id, "todo").unwrap();
        transition(&mut conn, &mut clock, &id, "confirming").unwrap();
        assert_eq!(stage_of(&conn, &id), "confirming");
    }

    #[test]
    fn reorder_into_confirming_column_works() {
        let (mut conn, mut clock) = fresh_db();
        let a = mk(&conn, "A");
        transition(&mut conn, &mut clock, &a, "doing").unwrap();
        let c = mk(&conn, "C");
        transition(&mut conn, &mut clock, &c, "confirming").unwrap();
        reorder(&mut conn, &mut clock, &a, "doing", "confirming", &[c.clone()], &[a.clone(), c.clone()]).unwrap();
        assert_eq!(stage_of(&conn, &a), "confirming");
        assert_eq!(ids(&conn, "confirming"), vec![a, c]);
    }

    #[test]
    fn transition_missing_task_fails() {
        let (mut conn, mut clock) = fresh_db();
        assert!(transition(&mut conn, &mut clock, "nope", "todo").is_err());
    }

    #[test]
    fn archive_restore_purge_fail_fast() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "走完整流程");
        assert!(purge(&mut conn, &mut clock, &id).is_err(), "live task is not in the 回收站");
        assert!(restore(&mut conn, &mut clock, &id).is_err(), "nothing to restore");
        transition(&mut conn, &mut clock, &id, "done").unwrap();
        archive(&mut conn, &mut clock, &id).unwrap();
        assert!(archive(&mut conn, &mut clock, &id).is_err());
        assert_eq!(stage_of(&conn, &id), "done", "stage kept while archived");
        restore(&mut conn, &mut clock, &id).unwrap();
        assert!(restore(&mut conn, &mut clock, &id).is_err(), "already restored");
        archive(&mut conn, &mut clock, &id).unwrap();
        purge(&mut conn, &mut clock, &id).unwrap();
        assert!(repo::item_stage(&conn, &id).unwrap().is_none(), "task is gone");
        assert!(purge(&mut conn, &mut clock, &id).is_err(), "re-purge fails fast");
        // 回收站轴的 op 轨迹:软删(值)/还原(NULL)/再软删(值),终点 tombstone。
        let arch: Vec<serde_json::Value> = field_ops(&conn, &id)
            .into_iter()
            .filter(|(f, _)| f == "archived_at")
            .map(|(_, v)| v)
            .collect();
        assert_eq!(arch.len(), 3);
        assert!(!arch[0].is_null() && arch[1].is_null() && !arch[2].is_null());
        assert_eq!(ops_for(&conn, "item", &id).last().unwrap().kind, "tombstone");
    }

    #[test]
    fn archive_any_active_task_and_restore_to_original_column() {
        let (mut conn, mut clock) = fresh_db();
        let todo = mk(&conn, "待办的活");
        let doing = mk(&conn, "进行中的活");
        transition(&mut conn, &mut clock, &doing, "doing").unwrap();
        archive(&mut conn, &mut clock, &todo).unwrap();
        archive(&mut conn, &mut clock, &doing).unwrap();
        assert!(repo::list_tasks(&conn).unwrap().is_empty());
        assert_eq!(repo::archived_tasks(&conn).unwrap().len(), 2);
        assert_eq!(stage_of(&conn, &todo), "todo");
        assert_eq!(stage_of(&conn, &doing), "doing");
        restore(&mut conn, &mut clock, &todo).unwrap();
        restore(&mut conn, &mut clock, &doing).unwrap();
        assert_eq!(ids(&conn, "todo"), vec![todo]);
        assert_eq!(ids(&conn, "doing"), vec![doing]);
    }

    #[test]
    fn archive_from_middle_keeps_survivor_order() {
        let (mut conn, mut clock) = fresh_db();
        let (a, b, c) = three_todos(&conn);
        archive(&mut conn, &mut clock, &b).unwrap();
        assert_eq!(ids(&conn, "todo"), vec![a.clone(), c.clone()]);
        let d = mk(&conn, "D");
        assert_eq!(ids(&conn, "todo"), vec![a, c, d]);
    }

    #[test]
    fn purge_all_empties_only_the_trash() {
        let (mut conn, mut clock) = fresh_db();
        let live = mk(&conn, "活跃");
        transition(&mut conn, &mut clock, &live, "done").unwrap();
        let trashed = mk(&conn, "待清");
        transition(&mut conn, &mut clock, &trashed, "done").unwrap();
        archive(&mut conn, &mut clock, &trashed).unwrap();
        assert_eq!(purge_all(&mut conn, &mut clock).unwrap(), 1);
        assert_eq!(stage_of(&conn, &live), "done");
        assert_eq!(ops_for(&conn, "item", &trashed).last().unwrap().kind, "tombstone");
        assert_ne!(ops_for(&conn, "item", &live).last().unwrap().kind, "tombstone");
    }

    #[test]
    fn seal_unseal_lifecycle_and_guards() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "干完的活");
        // 未完成不可归档。
        assert!(seal(&mut conn, &mut clock, &id).is_err());
        transition(&mut conn, &mut clock, &id, "done").unwrap();
        seal(&mut conn, &mut clock, &id).unwrap();
        assert!(seal(&mut conn, &mut clock, &id).is_err(), "already sealed fails fast");
        // 归档中:看板上没有它,一切活跃操作 fail fast。
        assert!(repo::list_tasks(&conn).unwrap().is_empty());
        assert!(transition(&mut conn, &mut clock, &id, "todo").is_err());
        assert!(rename(&mut conn, &mut clock, &id, "改名").is_err());
        assert!(archive(&mut conn, &mut clock, &id).is_err(), "sealed can't go to the 回收站");
        assert!(purge(&mut conn, &mut clock, &id).is_err(), "sealed can't be purged");
        // 取消归档 → 回到 done 列,一切恢复正常。
        unseal(&mut conn, &mut clock, &id).unwrap();
        assert!(unseal(&mut conn, &mut clock, &id).is_err(), "not sealed anymore");
        assert_eq!(stage_of(&conn, &id), "done");
        assert_eq!(ids(&conn, "done"), vec![id.clone()]);
        // sealed_at 轴的 op:归档(值)→ 取消归档(NULL)。
        let sealed: Vec<serde_json::Value> = field_ops(&conn, &id)
            .into_iter()
            .filter(|(f, _)| f == "sealed_at")
            .map(|(_, v)| v)
            .collect();
        assert_eq!(sealed.len(), 2);
        assert!(!sealed[0].is_null() && sealed[1].is_null());
    }

    #[test]
    fn seal_all_reports_count_and_zero_on_empty() {
        let (mut conn, mut clock) = fresh_db();
        assert_eq!(seal_all(&mut conn, &mut clock).unwrap(), 0, "empty done column is a 0, not an error");
        let a = mk(&conn, "A");
        let b = mk(&conn, "B");
        transition(&mut conn, &mut clock, &a, "done").unwrap();
        transition(&mut conn, &mut clock, &b, "done").unwrap();
        assert_eq!(seal_all(&mut conn, &mut clock).unwrap(), 2);
        assert!(ids(&conn, "done").is_empty());
        for t in [&a, &b] {
            assert!(field_ops(&conn, t).iter().any(|(f, v)| f == "sealed_at" && !v.is_null()));
        }
    }

    #[test]
    fn set_due_and_priority_fail_fast() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "活跃任务");
        set_due(&mut conn, &mut clock, &id, Some("2026-06-25")).unwrap();
        set_priority(&mut conn, &mut clock, &id, Some(2)).unwrap();
        set_due(&mut conn, &mut clock, &id, None).unwrap();
        set_priority(&mut conn, &mut clock, &id, None).unwrap();
        assert!(set_priority(&mut conn, &mut clock, &id, Some(0)).is_err());
        assert!(set_priority(&mut conn, &mut clock, &id, Some(4)).is_err());
        assert!(set_due(&mut conn, &mut clock, &id, Some("2026-02-31")).is_err());
        assert!(set_due(&mut conn, &mut clock, "ghost", Some("2026-06-25")).is_err());
        // 四次成功设置 = 四条 op(设值/清空各二),被拒的不发射。
        assert_eq!(field_ops(&conn, &id).len(), 4);
        let arch = mk(&conn, "待归档");
        transition(&mut conn, &mut clock, &arch, "done").unwrap();
        archive(&mut conn, &mut clock, &arch).unwrap();
        assert!(set_due(&mut conn, &mut clock, &arch, Some("2026-06-25")).is_err());
        assert!(set_priority(&mut conn, &mut clock, &arch, Some(1)).is_err());
    }

    #[test]
    fn rename_trims_and_guards_active_and_keeps_history() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "原标题");
        rename(&mut conn, &mut clock, &id, "  新标题  ").unwrap();
        assert_eq!(title_of(&conn, &id), "新标题");
        // The rename archived the old title (D5: history on all stages).
        assert_eq!(repo::item_revisions(&conn, &id).unwrap()[0].content, "原标题");
        assert!(rename(&mut conn, &mut clock, &id, "   ").is_err());
        assert_eq!(title_of(&conn, &id), "新标题");
        assert!(rename(&mut conn, &mut clock, "ghost", "x").is_err());
        let arch = mk(&conn, "待归档");
        transition(&mut conn, &mut clock, &arch, "done").unwrap();
        archive(&mut conn, &mut clock, &arch).unwrap();
        assert!(rename(&mut conn, &mut clock, &arch, "归档后改名").is_err());
        assert_eq!(title_of(&conn, &arch), "待归档");
    }

    #[test]
    fn add_topic_by_title_atomic_reuse_and_guards() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "要打标签的任务");
        // 新标题:建标签+挂链一步原子(topic create + link_add 两条 op)。
        let t1 = add_topic_by_title(&mut conn, &mut clock, &id, " 新标签 ").unwrap();
        let tops = ops_for(&conn, "topic", &t1);
        assert_eq!(tops.len(), 1);
        assert_eq!(tops[0].kind, "create");
        let lops = ops_for(&conn, "link", &format!("{id}:{t1}"));
        assert_eq!(lops.len(), 1);
        assert_eq!(lops[0].kind, "link_add");
        // 同名复用:不铸重复标签;已挂则连 link op 都不再发(幂等)。
        let t1b = add_topic_by_title(&mut conn, &mut clock, &id, "新标签").unwrap();
        assert_eq!(t1b, t1);
        assert_eq!(ops_for(&conn, "topic", &t1).len(), 1, "复用不再发 topic op");
        assert_eq!(ops_for(&conn, "link", &format!("{id}:{t1}")).len(), 1, "已挂不再发 link op");
        // 空名/超长响亮拒;目标不存在或已归档拒且不留半成品标签。
        assert!(add_topic_by_title(&mut conn, &mut clock, &id, "  ").is_err());
        assert!(add_topic_by_title(&mut conn, &mut clock, "ghost", "孤儿标签").is_err());
        assert!(
            repo::topic_id_by_title(&conn, "孤儿标签").unwrap().is_none(),
            "目标守卫在建标签之前:不留没人要的空标签"
        );
        let arch = mk(&conn, "已删的");
        archive(&mut conn, &mut clock, &arch).unwrap();
        assert!(add_topic_by_title(&mut conn, &mut clock, &arch, "别挂我").is_err());
        assert!(repo::topic_id_by_title(&conn, "别挂我").unwrap().is_none());
    }

    #[test]
    fn add_and_remove_topics_are_multi_and_idempotent_and_guard_active() {
        let (mut conn, mut clock) = fresh_db();
        let g1 = repo::insert_topic(&conn, "甲").unwrap();
        let g2 = repo::insert_topic(&conn, "乙").unwrap();
        let id = mk(&conn, "活跃任务");

        let tags = |c: &Connection, id: &str| -> Vec<String> {
            let row = repo::list_tasks(c).unwrap().into_iter().find(|t| t.id == id).unwrap();
            let mut v: Vec<String> = row.topics.into_iter().map(|t| t.id).collect();
            v.sort();
            v
        };

        // Multi-tag: adding g1 then g2 keeps BOTH (no replace).
        add_topic(&mut conn, &mut clock, &id, &g1).unwrap();
        add_topic(&mut conn, &mut clock, &id, &g2).unwrap();
        let mut both = vec![g1.clone(), g2.clone()];
        both.sort();
        assert_eq!(tags(&conn, &id), both);
        // Adding an already-present tag is an idempotent no-op (no duplicate, no error).
        add_topic(&mut conn, &mut clock, &id, &g1).unwrap();
        assert_eq!(tags(&conn, &id), both);
        // Remove one — the other stays.
        remove_topic(&mut conn, &mut clock, &id, &g1).unwrap();
        assert_eq!(tags(&conn, &id), vec![g2.clone()]);
        // Removing an absent tag is an idempotent no-op.
        remove_topic(&mut conn, &mut clock, &id, &g1).unwrap();
        assert_eq!(tags(&conn, &id), vec![g2.clone()]);
        // 幂等 no-op 不发射:g1 这对链接只有一加一减两条 op。
        let lops = ops_for(&conn, "link", &format!("{id}:{g1}"));
        assert_eq!(lops.len(), 2, "重复加/重复减都不该发 op");
        assert_eq!(lops[0].kind, "link_add");
        assert_eq!(lops[1].kind, "link_remove");
        // Bad topic id rejected (FK), nothing left dangling.
        assert!(add_topic(&mut conn, &mut clock, &id, "no-such").is_err());
        assert_eq!(tags(&conn, &id), vec![g2]);
        // Missing / archived fail fast (both add and remove).
        assert!(add_topic(&mut conn, &mut clock, "ghost", &g1).is_err());
        assert!(remove_topic(&mut conn, &mut clock, "ghost", &g1).is_err());
        let arch = mk(&conn, "待归档");
        transition(&mut conn, &mut clock, &arch, "done").unwrap();
        archive(&mut conn, &mut clock, &arch).unwrap();
        assert!(add_topic(&mut conn, &mut clock, &arch, &g1).is_err());
        assert!(remove_topic(&mut conn, &mut clock, &arch, &g1).is_err());
    }

    #[test]
    fn manual_tasks_are_born_at_column_end() {
        let (conn, _clock) = fresh_db();
        let (a, b, c) = three_todos(&conn);
        assert_eq!(ids(&conn, "todo"), vec![a, b, c]);
        assert_eq!(positions(&conn, "todo"), keys(&["a0", "a1", "a2"]));
    }

    #[test]
    fn reorder_within_column_writes_only_the_dragged_key() {
        let (mut conn, mut clock) = fresh_db();
        let (a, b, c) = three_todos(&conn); // a0 a1 a2
        reorder(&mut conn, &mut clock, &c, "todo", "todo", &[a.clone(), b.clone(), c.clone()], &[c.clone(), a.clone(), b.clone()]).unwrap();
        assert_eq!(ids(&conn, "todo"), vec![c.clone(), a.clone(), b.clone()]);
        // 只有被拖卡换键(列首前插),其余卡的键纹丝不动。
        assert_eq!(positions(&conn, "todo"), keys(&["Zz", "a0", "a1"]));
        assert!(field_ops(&conn, &a).is_empty() && field_ops(&conn, &b).is_empty(),
            "未被拖动的卡不发射任何 op");
        reorder(&mut conn, &mut clock, &a, "todo", "todo", &[c.clone(), a.clone(), b.clone()], &[c.clone(), b.clone(), a.clone()]).unwrap();
        assert_eq!(ids(&conn, "todo"), vec![c.clone(), b.clone(), a.clone()]);
        // 一次拖动 = 被拖卡一条 position op,值是落点键。
        let a_pos: Vec<serde_json::Value> = field_ops(&conn, &a)
            .into_iter()
            .filter(|(f, _)| f == "position")
            .map(|(_, v)| v)
            .collect();
        assert_eq!(a_pos, vec![serde_json::json!("a2")]);
    }

    #[test]
    fn reorder_drop_in_place_is_an_idempotent_no_op() {
        let (mut conn, mut clock) = fresh_db();
        let (a, b, c) = three_todos(&conn);
        reorder(&mut conn, &mut clock, &b, "todo", "todo",
            &[a.clone(), b.clone(), c.clone()], &[a.clone(), b.clone(), c.clone()]).unwrap();
        assert_eq!(positions(&conn, "todo"), keys(&["a0", "a1", "a2"]), "原位落下不写库");
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 0, "原位落下不发射 op");
    }

    #[test]
    fn reorder_across_columns_inserts_at_position_and_changes_status() {
        let (mut conn, mut clock) = fresh_db();
        let (a, b, c) = three_todos(&conn);
        let x = mk(&conn, "X");
        let y = mk(&conn, "Y");
        transition(&mut conn, &mut clock, &x, "doing").unwrap();
        transition(&mut conn, &mut clock, &y, "doing").unwrap();
        reorder(&mut conn, &mut clock, &b, "todo", "doing", &[x.clone(), y.clone()], &[x.clone(), b.clone(), y.clone()]).unwrap();
        assert_eq!(stage_of(&conn, &b), "doing");
        assert_eq!(ids(&conn, "doing"), vec![x, b.clone(), y]);
        // 落点键在两侧邻居之间,邻居的键不动。
        assert_eq!(positions(&conn, "doing"), keys(&["a0", "a0V", "a1"]));
        assert_eq!(ids(&conn, "todo"), vec![a, c]);
        // 跨列拖动:stage op 在 position 之前(先流转后落位)。
        let fields: Vec<String> = field_ops(&conn, &b).into_iter().map(|(f, _)| f).collect();
        let stage_at = fields.iter().position(|f| f == "stage").unwrap();
        let pos_at = fields.iter().rposition(|f| f == "position").unwrap();
        assert!(stage_at < pos_at);
    }

    #[test]
    fn reorder_rejects_stale_or_malformed_input() {
        let (mut conn, mut clock) = fresh_db();
        let (a, b, c) = three_todos(&conn);
        assert!(reorder(&mut conn, &mut clock, &c, "todo", "todo", &[a.clone(), b.clone()], &[c.clone(), a.clone(), b.clone()]).is_err());
        assert!(reorder(&mut conn, &mut clock, &c, "todo", "todo", &[a.clone(), b.clone(), c.clone()], &[a.clone(), a.clone(), b.clone()]).is_err());
        assert!(reorder(&mut conn, &mut clock, &c, "todo", "todo", &[a.clone(), b.clone(), c.clone()], &[a.clone(), b.clone()]).is_err());
        assert!(reorder(&mut conn, &mut clock, &c, "doing", "doing", &[], &[c.clone()]).is_err());
        // 单卡拖动契约:除被拖卡外还动了别的卡(a、b 互换)=> 拒绝,不猜。
        assert!(reorder(&mut conn, &mut clock, &c, "todo", "todo", &[a.clone(), b.clone(), c.clone()], &[b.clone(), a.clone(), c.clone()]).is_err());
        assert_eq!(ids(&conn, "todo"), vec![a, b, c]);
        assert_eq!(positions(&conn, "todo"), keys(&["a0", "a1", "a2"]));
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 0, "被拒的排序不发射 op");
    }

    #[test]
    fn cross_column_drop_must_not_reshuffle_target_column() {
        let (mut conn, mut clock) = fresh_db();
        let b = mk(&conn, "B");
        let x = mk(&conn, "X");
        let y = mk(&conn, "Y");
        transition(&mut conn, &mut clock, &x, "doing").unwrap();
        transition(&mut conn, &mut clock, &y, "doing").unwrap();
        assert!(reorder(&mut conn, &mut clock, &b, "todo", "doing", &[x.clone(), y.clone()], &[y.clone(), b.clone(), x.clone()]).is_err());
        assert_eq!(stage_of(&conn, &b), "todo");
        assert_eq!(ids(&conn, "doing"), vec![x, y]);
        assert!(ops_for(&conn, "item", &b).is_empty(), "被拒的跨列拖动整体回滚、不发射 op");
    }

    #[test]
    fn reorder_of_archived_task_fails_fast() {
        let (mut conn, mut clock) = fresh_db();
        let id = mk(&conn, "完成并归档");
        transition(&mut conn, &mut clock, &id, "done").unwrap();
        archive(&mut conn, &mut clock, &id).unwrap();
        assert!(reorder(&mut conn, &mut clock, &id, "done", "done", &[], &[id.clone()]).is_err());
    }

    #[test]
    fn create_inserts_at_column_front_with_one_birth_op() {
        let (mut conn, mut clock) = fresh_db();
        let (a, b, c) = three_todos(&conn); // a0 a1 a2
        let d = create(&mut conn, &mut clock, "  D  ", None, None, None).unwrap();
        assert_eq!(ids(&conn, "todo"), vec![d.clone(), a.clone(), b.clone(), c.clone()]);
        assert_eq!(title_of(&conn, &d), "D");
        let e = create(&mut conn, &mut clock, "E", None, None, None).unwrap();
        assert_eq!(ids(&conn, "todo"), vec![e.clone(), d.clone(), a, b, c]);
        // 新建 = 一条出生快照,读行发声使其自带列首终键;不再有任何 position op,
        // 后来者(E)的新建也一张别的卡都不动。
        let d_ops = ops_for(&conn, "item", &d);
        assert_eq!(d_ops.len(), 1, "新建只发一条 op");
        assert_eq!(d_ops[0].kind, "create");
        assert_eq!(d_ops[0].payload["born_stage"], "todo");
        assert_eq!(d_ops[0].payload["content"], "D");
        assert_eq!(d_ops[0].payload["position"], serde_json::json!("Zz"), "快照带列首终键");
        let e_ops = ops_for(&conn, "item", &e);
        assert_eq!(e_ops[0].payload["position"], serde_json::json!("Zy"), "E 插在 D 之前");
    }

    #[test]
    fn create_is_atomic_and_validated() {
        let (mut conn, mut clock) = fresh_db();
        let (a, b, c) = three_todos(&conn);
        assert!(create(&mut conn, &mut clock, "   ", None, None, None).is_err());
        assert!(create(&mut conn, &mut clock, "坏优先级", None, Some(9), None).is_err());
        assert!(create(&mut conn, &mut clock, "坏日期", Some("2026-02-31"), None, None).is_err());
        assert!(create(&mut conn, &mut clock, "坏主题", None, None, Some("ghost")).is_err());
        assert_eq!(ids(&conn, "todo"), vec![a, b, c]);
        assert_eq!(positions(&conn, "todo"), keys(&["a0", "a1", "a2"]));
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 0, "被拒的新建整体回滚、不留 op");
    }

    #[test]
    fn create_with_topic_tags_the_card() {
        let (mut conn, mut clock) = fresh_db();
        let topic = repo::insert_topic(&conn, "工作").unwrap();
        let id = create(&mut conn, &mut clock, "带标签", None, None, Some(&topic)).unwrap();
        let row = repo::list_tasks(&conn).unwrap().into_iter().find(|t| t.id == id).unwrap();
        assert_eq!(row.topics.len(), 1);
        assert_eq!(row.topics[0].title, "工作");
        assert_eq!(ops_for(&conn, "link", &format!("{id}:{topic}"))[0].kind, "link_add");
    }

    #[test]
    fn reorder_visible_within_column_keeps_hidden_fixed() {
        let (mut conn, mut clock) = fresh_db();
        let h1 = mk(&conn, "H1");
        let v1 = mk(&conn, "V1");
        let h2 = mk(&conn, "H2");
        let v2 = mk(&conn, "V2");
        let v3 = mk(&conn, "V3"); // 完整列 a0..a4
        reorder_visible(&mut conn, &mut clock, &v3, "todo", "todo",
            &[v1.clone(), v2.clone(), v3.clone()], &[v3.clone(), v1.clone(), v2.clone()]).unwrap();
        // 0021 语义:只有被拖卡(v3)换键——落到新可见后邻 v1 的紧前面;隐藏卡 **和**
        // 未被拖动的可见卡(v1/v2)全部原地不动(0021 前的槽位轮换会把 v1/v2 也搬走)。
        assert_eq!(ids(&conn, "todo"), vec![h1, v3, v1, h2, v2]);
        assert_eq!(positions(&conn, "todo"), keys(&["a0", "a0V", "a1", "a2", "a3"]));
    }

    #[test]
    fn reorder_visible_cross_column_inserts_at_anchor() {
        let (mut conn, mut clock) = fresh_db();
        let x = mk(&conn, "X");
        let h1 = mk(&conn, "H1");
        let v1 = mk(&conn, "V1");
        let h2 = mk(&conn, "H2");
        let v2 = mk(&conn, "V2");
        for t in [&h1, &v1, &h2, &v2] {
            transition(&mut conn, &mut clock, t, "doing").unwrap();
        }
        reorder_visible(&mut conn, &mut clock, &x, "todo", "doing",
            &[v1.clone(), v2.clone()], &[v1.clone(), x.clone(), v2.clone()]).unwrap();
        assert_eq!(stage_of(&conn, &x), "doing");
        assert_eq!(ids(&conn, "doing"), vec![h1, v1, x, h2, v2]);
        assert!(ids(&conn, "todo").is_empty());
    }

    #[test]
    fn reorder_visible_cross_column_no_anchor_appends() {
        let (mut conn, mut clock) = fresh_db();
        let x = mk(&conn, "X");
        let h1 = mk(&conn, "H1");
        let h2 = mk(&conn, "H2");
        transition(&mut conn, &mut clock, &h1, "doing").unwrap();
        transition(&mut conn, &mut clock, &h2, "doing").unwrap();
        reorder_visible(&mut conn, &mut clock, &x, "todo", "doing", &[], &[x.clone()]).unwrap();
        assert_eq!(stage_of(&conn, &x), "doing");
        assert_eq!(ids(&conn, "doing"), vec![h1, h2, x]);
    }

    #[test]
    fn reorder_visible_cross_column_before_first_visible() {
        let (mut conn, mut clock) = fresh_db();
        let x = mk(&conn, "X");
        let h1 = mk(&conn, "H1");
        let v1 = mk(&conn, "V1");
        let h2 = mk(&conn, "H2");
        for t in [&h1, &v1, &h2] {
            transition(&mut conn, &mut clock, t, "doing").unwrap();
        }
        reorder_visible(&mut conn, &mut clock, &x, "todo", "doing", &[v1.clone()], &[x.clone(), v1.clone()]).unwrap();
        assert_eq!(ids(&conn, "doing"), vec![h1, x, v1, h2]);
    }

    #[test]
    fn reorder_visible_rejects_bad_input() {
        let (mut conn, mut clock) = fresh_db();
        let v1 = mk(&conn, "V1");
        let v2 = mk(&conn, "V2");
        let v3 = mk(&conn, "V3");
        assert!(reorder_visible(&mut conn, &mut clock, &v1, "todo", "todo",
            &[v1.clone(), v2.clone(), v3.clone()], &[v1.clone(), v1.clone(), v2.clone()]).is_err());
        assert!(reorder_visible(&mut conn, &mut clock, &v1, "todo", "todo",
            &[v2.clone(), v3.clone()], &[v2.clone(), v3.clone()]).is_err());
        assert!(reorder_visible(&mut conn, &mut clock, &v1, "todo", "todo",
            &[v2.clone(), v1.clone(), v3.clone()], &[v1.clone(), v2.clone(), v3.clone()]).is_err());
        let x = mk(&conn, "X");
        transition(&mut conn, &mut clock, &v1, "doing").unwrap();
        transition(&mut conn, &mut clock, &v2, "doing").unwrap();
        assert!(reorder_visible(&mut conn, &mut clock, &x, "todo", "doing",
            &[v1.clone(), v2.clone()], &[v2.clone(), x.clone(), v1.clone()]).is_err());
        assert_eq!(stage_of(&conn, &x), "todo");
        assert_eq!(ids(&conn, "doing"), vec![v1, v2]);
        assert_eq!(ids(&conn, "todo"), vec![v3, x]);
    }
}
