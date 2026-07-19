//! Manual idea-flow orchestration — the spine of a fully manual tool, no AI.
//!
//! Single-entity model: 想法 and 待办 are stages of ONE item. The three idea moves —
//! edit (keeping full history), 转待办 (promote), 归类 (file under a tag) — are now
//! stage flips / tag links on that single row, never a copy. 撤回为灵感 is the inverse
//! flip. Each op is one transaction over repo primitives, fail-fast at every step.
//!
//! oplog 接线(sync-plan P1):每个写编排在**自己的事务里**完成「改数据 + 发射 op +
//! HLC 水位落盘」——op 与数据同生共死,崩溃不留「改了却没记」的静默分叉窗口。幂等
//! no-op(没写行)不发射。发射语义见 oplog.rs 模块头。

use rusqlite::Connection;

use crate::clock::Clock;
use crate::{oplog, repo};

/// Capture a raw thought into the Inbox. Returns the new item's id. Content is stored
/// as-is (a pure-image capture may carry an empty body — see 53); the birth op carries
/// the full snapshot.
pub fn capture(conn: &mut Connection, clock: &mut Clock, content: &str) -> Result<String, String> {
    repo::ensure_content_fits(content)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = repo::add_item(&tx, content).map_err(|e| e.to_string())?;
    oplog::item_create(&tx, clock, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Edit an item's text. The prior version is archived by the database itself (the 0014
/// auto-archive trigger), so history is append-only and unbypassable on every stage.
/// Editable while live (any non-archived stage — the user owns their words); a 回收站
/// item is frozen. Fails fast on an empty body, a missing/archived item, or a no-op edit.
pub fn edit(conn: &mut Connection, clock: &mut Clock, id: &str, new_content: &str) -> Result<(), String> {
    if new_content.trim().is_empty() {
        return Err("灵感内容不能为空".to_string());
    }
    repo::ensure_content_fits(new_content)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (_stage, archived) = repo::item_state(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "灵感不存在".to_string())?;
    if archived {
        return Err("回收站中的条目不可编辑".to_string());
    }
    let current = repo::current_content(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "灵感不存在".to_string())?;
    if current == new_content {
        return Err("内容未改变,无需保存".to_string());
    }
    let updated = repo::update_item_content(&tx, id, new_content).map_err(|e| e.to_string())?;
    if updated != 1 {
        return Err(format!("写入新内容失败(影响 {updated} 行)"));
    }
    oplog::item_set(&tx, clock, id, &["content"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Hard-delete one Inbox note. Only notes still in the Inbox can be removed —
/// already-organized notes are immutable provenance, so a deleted-row count other than 1
/// is a real error and surfaces, not swallowed.
///
/// 73 起 UI 不再走这条路(删除统一先进回收站,销毁只在回收站的「彻底删除」——tombstone
/// 在同步语义里是全网抹掉、不可复活,不该是删除键的默认归宿);保留给命令层与 e2e 清库。
pub fn delete_inbox(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let deleted = repo::delete_inbox_item(&tx, id).map_err(|e| e.to_string())?;
    if deleted != 1 {
        return Err(format!(
            "删除失败:这条灵感已不在收件箱(可能已被整理或已删除),删除行数 {deleted}"
        ));
    }
    oplog::item_tombstone(&tx, clock, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Soft-delete a live idea (未归类 or 已归类) into the 回收站. It leaves the 灵感 list but
/// is recoverable — provenance and edit history stay intact. 73: 删除=进回收站 for every
/// idea; only a task-stage / already-archived / missing item affects 0 rows and fails fast.
pub fn archive(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::archive_idea(&tx, id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("移入回收站失败:这条灵感不存在或已在回收站,影响行数 {n}"));
    }
    oplog::item_set(&tx, clock, id, &["archived_at"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Restore an archived idea from the 回收站 (back to its frozen idea stage).
pub fn restore(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::restore_idea(&tx, id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("还原失败:这条灵感不在回收站,影响行数 {n}"));
    }
    oplog::item_set(&tx, clock, id, &["archived_at"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 转待办: flip an idea (未归类/已归类) into a 'todo', landing it at the FRONT of 待办
/// (same as the board's 新建任务). The subject is ONE row — converting copies nothing;
/// `title` is the desired wording, applied as an edit (kept in history) only if it
/// differs, so a no-change promote is a pure stage flip. Fails fast on an empty title,
/// a missing/archived item, or an item that is not an idea (already a task). Returns the
/// item's id (unchanged — there is no separate task id anymore).
pub fn promote_to_task(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    title: &str,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("待办标题不能为空".to_string());
    }
    repo::ensure_content_fits(title)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (stage, archived) = repo::item_state(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "灵感不存在".to_string())?;
    if archived {
        return Err("回收站中的条目不能转为待办".to_string());
    }
    if stage != "inbox" && stage != "filed" {
        return Err("只有灵感(未归类/已归类)可以转为待办".to_string());
    }

    // Apply the wording as an edit ONLY if it changed — no copy, history keeps the
    // original. An unchanged title is a pure stage flip.
    let current = repo::current_content(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "灵感不存在".to_string())?;
    if current != title {
        let n = repo::update_item_content(&tx, id, title).map_err(|e| e.to_string())?;
        if n != 1 {
            return Err(format!("更新待办标题失败(影响 {n} 行),已回滚"));
        }
        oplog::item_set(&tx, clock, id, &["content"])?;
    }

    let n = repo::promote_to_todo(&tx, id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("转为待办失败(影响 {n} 行),已回滚"));
    }
    // promote_to_todo 直接落「待办」列首(fractional key 单写,0021),stage 与
    // position 一并发射;别的卡一张不动、不再整列重排。
    oplog::item_set(&tx, clock, id, &["stage", "position"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id.to_string())
}

/// 撤回为灵感 — send a 待办 back to 灵感. A 灵感 is just a not-yet-clarified task: the same
/// subject at a less-mature stage, so the board's least-mature column (待办) may always
/// retreat into it. **Only a `todo`** can revert — a 进行中/已完成 is already clarified,
/// and an archived (回收站) task is restored, not reverted. The single row flips stage
/// back to 已整理 (if it still carries a tag — the filing is durable knowledge) or 未归类
/// (if it has none), clearing the task-only attributes. No more "restore vs seed" fork —
/// there was never a second record. One transaction, fail-fast.
pub fn revert_task_to_inbox(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let stage = repo::active_task_stage(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在或在回收站,无法撤回".to_string())?;
    if stage != "todo" {
        return Err("只有「待办」中的任务可以撤回为灵感".to_string());
    }
    let to = if repo::item_has_topic(&tx, id).map_err(|e| e.to_string())? {
        "filed"
    } else {
        "inbox"
    };
    let n = repo::revert_to_idea(&tx, id, to).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("撤回失败(影响 {n} 行),已回滚"));
    }
    // revert_to_idea 一并清掉任务态属性,四个字段各发一条(值从行上读回:position/
    // due_on/priority 皆归 NULL)。
    oplog::item_set(&tx, clock, id, &["stage", "position", "due_on", "priority"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// File an idea under a tag (manual organize): an existing topic by id, or a brand-new
/// one by title. Links the item and moves it 未归类 -> 已整理 (an already-filed idea just
/// gains another tag). Exactly one of `topic_id` / `new_title` must be given. Fails fast
/// on a missing/archived/non-idea item, an unknown topic id, or a duplicate tag link.
/// Returns the topic id.
pub fn file_to_topic(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    topic_id: Option<&str>,
    new_title: Option<&str>,
) -> Result<String, String> {
    let target = match (topic_id, new_title.map(str::trim)) {
        (Some(t), None) => Target::Existing(t),
        (None, Some(t)) if !t.is_empty() => Target::New(t),
        (None, Some(_)) => return Err("新主题标题不能为空".to_string()),
        _ => return Err("必须且只能指定一个主题(已有 id 或新标题)".to_string()),
    };
    if let Target::New(t) = target {
        repo::ensure_content_fits(t)?; // 归类顺手建标签也是标签名入口(codex 复核抓漏)
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (stage, archived) = repo::item_state(&tx, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "灵感不存在".to_string())?;
    if archived {
        return Err("回收站中的条目不能归类".to_string());
    }
    match stage.as_str() {
        "inbox" => {
            let n = repo::file_inbox_item(&tx, id).map_err(|e| e.to_string())?;
            if n != 1 {
                return Err(format!("移动灵感到已整理失败(影响 {n} 行),已回滚"));
            }
            oplog::item_set(&tx, clock, id, &["stage"])?;
        }
        "filed" => {}
        _ => return Err("只有灵感可以归类到标签".to_string()),
    }
    let topic_id = match target {
        Target::Existing(t) => {
            if !repo::topic_exists(&tx, t).map_err(|e| e.to_string())? {
                return Err(format!("主题 {t} 不存在,已回滚"));
            }
            t.to_string()
        }
        // Tag names are unique: if one already exists with this name, reuse it (tagging is
        // idempotent) instead of minting a duplicate; otherwise create it.
        Target::New(title) => match repo::topic_id_by_title(&tx, title).map_err(|e| e.to_string())? {
            Some(existing) => existing,
            None => {
                let minted = repo::insert_topic(&tx, title).map_err(|e| e.to_string())?;
                oplog::topic_create(&tx, clock, &minted)?;
                minted
            }
        },
    };
    repo::link_item_topic(&tx, id, &topic_id).map_err(|e| e.to_string())?;
    oplog::link_add(&tx, clock, id, &topic_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(topic_id)
}

enum Target<'a> {
    Existing(&'a str),
    New(&'a str),
}

// ---- Topics (tag CRUD — 标签视图的新建/重命名/删除) ---------------------------------

/// Create a topic (tag) by hand. Fails fast on an empty title or a same-name duplicate.
/// Returns its id.
pub fn create_topic(conn: &mut Connection, clock: &mut Clock, title: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("主题标题不能为空".to_string());
    }
    repo::ensure_content_fits(title)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if repo::topic_id_by_title(&tx, title).map_err(|e| e.to_string())?.is_some() {
        return Err(format!("标签「{title}」已存在"));
    }
    let id = repo::insert_topic(&tx, title).map_err(|e| e.to_string())?;
    oplog::topic_create(&tx, clock, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Edit a topic's title. Fails fast on an empty title, a collision with another topic,
/// or a missing id (affected rows != 1).
pub fn rename_topic(conn: &mut Connection, clock: &mut Clock, id: &str, title: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("主题标题不能为空".to_string());
    }
    repo::ensure_content_fits(title)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // Reject a rename that collides with another topic (a same-id no-op rename is fine).
    if let Some(other) = repo::topic_id_by_title(&tx, title).map_err(|e| e.to_string())? {
        if other != id {
            return Err(format!("标签「{title}」已存在"));
        }
    }
    let n = repo::update_topic(&tx, id, title).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("更新主题失败:主题不存在,影响行数 {n}"));
    }
    oplog::topic_set(&tx, clock, id, &["title", "updated_at"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Set or clear a topic's chip color (P2 同步字段:走 topic `set_field` + 字段级 LWW 回放,
/// 跨设备一致;`None` = 无色)。`color` = `#RRGGBB`(大小写皆可)。fail-fast 拒非法格式或
/// 不存在的 id。**刻意不摸 updated_at**——重着色是装饰,不该像改名那样重排 chip 顺序。
pub fn set_topic_color(
    conn: &mut Connection,
    clock: &mut Clock,
    id: &str,
    color: Option<String>,
) -> Result<(), String> {
    if let Some(c) = &color {
        if !is_hex_color(c) {
            return Err(format!("颜色格式非法(应为 #RRGGBB):{c}"));
        }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::set_topic_color(&tx, id, color.as_deref()).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("设置标签颜色失败:主题不存在,影响行数 {n}"));
    }
    oplog::topic_set(&tx, clock, id, &["color"])?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// `#RRGGBB`:`#` + 恰 6 位十六进制。命令层唯一入口刻意只认这一种形式(前端调色板给的就是
/// 6 位 hex),不接受命名色 / rgb() / 带 alpha —— 越窄越好核验、越省得回放端猜。
fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// Delete a topic (manual maintenance). Only the topic projection goes — its item_topic
/// links cascade away, but the items themselves (the fact source) are untouched. The op
/// is a single topic tombstone: the links' death rides the FK cascade, which replays
/// identically on every device. Fails fast if the topic does not exist.
pub fn delete_topic(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = repo::delete_topic(&tx, id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("删除主题失败:主题不存在,影响行数 {n}"));
    }
    oplog::topic_tombstone(&tx, clock, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Merge several source topics into one survivor (manual recluster — no AI): re-point
/// every source's tag links onto `target` as a set-union — a SINGLE uniform pass now,
/// since ideas AND tasks both tag through item_topic (no separate task pointer). Delete
/// the now-empty source topics, optionally rename the target, and always bump its
/// updated_at. Fails fast on an empty/duplicate source list, target ∈ sources, or any
/// unknown id; the whole merge is one transaction. Returns the surviving target id.
///
/// op 形态:每个被移走的 link 一对 link_remove(源)/link_add(目标)(目标下已有的只
/// remove 不 add——与 repoint 的 NOT EXISTS 集合并语义一致),每个源标签一条 tombstone,
/// 最后目标的 title/updated_at 变更各一条 set_field。
pub fn merge_topics(
    conn: &mut Connection,
    clock: &mut Clock,
    source_ids: &[String],
    target_id: &str,
    new_title: Option<&str>,
) -> Result<String, String> {
    if source_ids.is_empty() {
        return Err("没有要合并的源主题".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for s in source_ids {
        if s == target_id {
            return Err("存续主题不能同时是被合并的源主题".to_string());
        }
        if !seen.insert(s.as_str()) {
            return Err("源主题列表有重复".to_string());
        }
    }
    let new_title = match new_title.map(str::trim) {
        Some(t) if t.is_empty() => return Err("主题标题不能为空".to_string()),
        other => other,
    };
    if let Some(t) = new_title {
        repo::ensure_content_fits(t)?;
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if !repo::topic_exists(&tx, target_id).map_err(|e| e.to_string())? {
        return Err(format!("存续主题 {target_id} 不存在,已回滚"));
    }
    // 目标名下已有的条目集合,随合并逐源累积——决定「移过来的 link 要不要发 link_add」。
    let mut target_items: std::collections::HashSet<String> =
        repo::topic_item_ids(&tx, target_id).map_err(|e| e.to_string())?.into_iter().collect();
    for source in source_ids {
        if !repo::topic_exists(&tx, source).map_err(|e| e.to_string())? {
            return Err(format!("源主题 {source} 不存在,已回滚"));
        }
        let src_items = repo::topic_item_ids(&tx, source).map_err(|e| e.to_string())?;
        repo::repoint_item_topic(&tx, source, target_id).map_err(|e| e.to_string())?;
        let removed = repo::delete_topic(&tx, source).map_err(|e| e.to_string())?;
        if removed != 1 {
            return Err(format!("删除源主题失败(影响 {removed} 行),已回滚"));
        }
        for item in src_items {
            oplog::link_remove(&tx, clock, &item, source)?;
            if target_items.insert(item.clone()) {
                oplog::link_add(&tx, clock, &item, target_id)?;
            }
        }
        oplog::topic_tombstone(&tx, clock, source)?;
    }
    // Sources are gone now, so any remaining same-name topic is an unrelated collision.
    if let Some(title) = new_title {
        if let Some(other) = repo::topic_id_by_title(&tx, title).map_err(|e| e.to_string())? {
            if other != target_id {
                return Err(format!("标签「{title}」已存在,已回滚"));
            }
        }
    }
    let touched = match new_title {
        Some(title) => repo::rename_topic(&tx, target_id, title).map_err(|e| e.to_string())?,
        None => repo::touch_topic(&tx, target_id).map_err(|e| e.to_string())?,
    };
    if touched != 1 {
        return Err(format!("更新存续主题失败(影响 {touched} 行),已回滚"));
    }
    match new_title {
        Some(_) => oplog::topic_set(&tx, clock, target_id, &["title", "updated_at"])?,
        None => oplog::topic_set(&tx, clock, target_id, &["updated_at"])?,
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(target_id.to_string())
}

/// Permanently delete one archived idea (彻底删除): remove the item (cascading its tag
/// links and edit history). Only an archived idea-stage item can be purged (the guard +
/// the 0014 delete trigger keep a live filed idea from being hard-deleted directly).
pub fn purge(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let deleted = repo::purge_idea(&tx, id).map_err(|e| e.to_string())?;
    if deleted != 1 {
        return Err(format!("彻底删除失败:这条灵感不在回收站,删除行数 {deleted}"));
    }
    oplog::item_tombstone(&tx, clock, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Empty the 灵感回收站 (清空回收站) in one transaction. Returns how many were removed.
pub fn purge_all_archived(conn: &mut Connection, clock: &mut Clock) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // 先点名再清空:tombstone 要逐条发,批量 DELETE 只报数不报 id。
    let ids: Vec<String> =
        repo::idea_trash(&tx).map_err(|e| e.to_string())?.into_iter().map(|r| r.id).collect();
    let removed = repo::purge_archived_ideas(&tx).map_err(|e| e.to_string())?;
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

/// 一次清空**统一回收站**(灵感+任务全 stage,120 安卓一屏回收站的「清空」)。
/// 单事务:点名→整删→数量核对→逐条 tombstone——绝不拆成 purge_all_archived +
/// task::purge_all 两条不可回滚的销毁命令(前半成功后半失败=半空;两调之间切了
/// 空间还可能清到两个库,codex 120 设计审 H2)。返回删除条数。
pub fn purge_all_trash(conn: &mut Connection, clock: &mut Clock) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ids: Vec<String> =
        repo::trash_items(&tx).map_err(|e| e.to_string())?.into_iter().map(|r| r.id).collect();
    let removed = repo::purge_all_trash(&tx).map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::oplog::ops_for;

    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn fresh_db() -> (rusqlite::Connection, Clock) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-notes-test-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open migrated db");
        let clock = Clock::load(&conn).expect("load clock");
        (conn, clock)
    }

    fn stage(conn: &rusqlite::Connection, id: &str) -> String {
        repo::item_stage(conn, id).unwrap().unwrap()
    }
    fn content(conn: &rusqlite::Connection, id: &str) -> String {
        repo::current_content(conn, id).unwrap().unwrap()
    }
    /// 该条目的 (kind, field) 序列——发射断言的速记(set_field 之外 field 记 "-")。
    fn op_shapes(conn: &rusqlite::Connection, id: &str) -> Vec<(String, String)> {
        ops_for(conn, "item", id)
            .into_iter()
            .map(|o| {
                let field = o.payload["field"].as_str().unwrap_or("-").to_string();
                (o.kind, field)
            })
            .collect()
    }

    #[test]
    fn purge_all_trash_empties_ideas_and_tasks_in_one_tx() {
        // 120 统一清空:灵感+任务一把删、单事务、逐条 tombstone;活条目不受波及。
        let (mut conn, mut clock) = fresh_db();
        let idea = capture(&mut conn, &mut clock, "灵感进回收站").unwrap();
        archive(&mut conn, &mut clock, &idea).unwrap();
        let task_id =
            crate::task::create(&mut conn, &mut clock, "任务进回收站", None, None, None).unwrap();
        crate::task::archive(&mut conn, &mut clock, &task_id).unwrap();
        let survivor = capture(&mut conn, &mut clock, "活着的").unwrap();

        assert_eq!(purge_all_trash(&mut conn, &mut clock).unwrap(), 2);
        assert!(repo::trash_items(&conn).unwrap().is_empty());
        assert_eq!(stage(&conn, &survivor), "inbox");
        for id in [&idea, &task_id] {
            let shapes = op_shapes(&conn, id);
            assert_eq!(shapes.last().unwrap().0, "tombstone", "{id} 缺墓碑");
        }
        // 空回收站再清 = 0,幂等无副作用。
        assert_eq!(purge_all_trash(&mut conn, &mut clock).unwrap(), 0);
    }

    #[test]
    fn content_length_guard_rejects_oversize_at_every_entry() {
        // 评审 P2-g 轮 M:正文全文进同步 op,服务器帧硬上限 1 MiB——超限 op 上不了
        // 通道会卡死该设备出站。200 KB 红线在全部正文/标题入口 fail-fast。
        let (mut conn, mut clock) = fresh_db();
        let too_long = "长".repeat(repo::MAX_CONTENT_BYTES / 3 + 1);
        let err = capture(&mut conn, &mut clock, &too_long).unwrap_err();
        assert!(err.contains("太长"), "{err}");
        let id = capture(&mut conn, &mut clock, "正常条目").unwrap();
        assert!(edit(&mut conn, &mut clock, &id, &too_long).unwrap_err().contains("太长"));
        assert!(promote_to_task(&mut conn, &mut clock, &id, &too_long).unwrap_err().contains("太长"));
        assert!(create_topic(&mut conn, &mut clock, &too_long).unwrap_err().contains("太长"));
        assert!(file_to_topic(&mut conn, &mut clock, &id, None, Some(&too_long))
            .unwrap_err()
            .contains("太长"));
        // 红线以内照常(边界不挡正常使用)。
        let ok_len = "长".repeat(1000);
        edit(&mut conn, &mut clock, &id, &ok_len).unwrap();
    }

    #[test]
    fn file_to_topic_reuses_same_name_topic_instead_of_duplicating() {
        let (mut conn, mut clock) = fresh_db();
        let a = repo::add_item(&conn, "想法甲").unwrap();
        let b = repo::add_item(&conn, "想法乙").unwrap();

        // First tag mints "探索"; tagging another idea with the same name must reuse it.
        let t1 = file_to_topic(&mut conn, &mut clock, &a, None, Some("探索")).unwrap();
        let t2 = file_to_topic(&mut conn, &mut clock, &b, None, Some("探索")).unwrap();
        assert_eq!(t1, t2, "same-name tag is the same topic, not a duplicate");
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM topics", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1, "no duplicate topic created");
        // 复用已有标签不再发第二条 topic create。
        let tops = ops_for(&conn, "topic", &t1);
        assert_eq!(tops.len(), 1);
        assert_eq!(tops[0].kind, "create");
        // Whitespace around the name still resolves to the same topic.
        let c = repo::add_item(&conn, "丙").unwrap();
        let t3 = file_to_topic(&mut conn, &mut clock, &c, None, Some("  探索  ")).unwrap();
        assert_eq!(t3, t1);
    }

    #[test]
    fn capture_emits_a_birth_snapshot_op() {
        let (mut conn, mut clock) = fresh_db();
        let id = capture(&mut conn, &mut clock, "记一笔").unwrap();
        assert_eq!(stage(&conn, &id), "inbox");
        let ops = ops_for(&conn, "item", &id);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].kind, "create");
        assert_eq!(ops[0].payload["content"], "记一笔");
        assert_eq!(ops[0].payload["born_stage"], "inbox");
    }

    #[test]
    fn edit_archives_history_and_rejects_noop_empty_missing_archived() {
        let (mut conn, mut clock) = fresh_db();
        let id = repo::add_item(&conn, "原始想法").unwrap();

        edit(&mut conn, &mut clock, &id, "修改后").unwrap();
        assert_eq!(content(&conn, &id), "修改后");
        assert_eq!(repo::item_revisions(&conn, &id).unwrap()[0].content, "原始想法");
        // 一次编辑 = 一条 content set_field,值是新文字。
        let ops = ops_for(&conn, "item", &id);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].payload["value"], "修改后");

        assert!(edit(&mut conn, &mut clock, &id, "修改后").is_err(), "no-op rejected");
        assert!(edit(&mut conn, &mut clock, &id, "   ").is_err(), "empty rejected");
        assert!(edit(&mut conn, &mut clock, "ghost", "x").is_err(), "missing rejected");
        assert_eq!(ops_for(&conn, "item", &id).len(), 1, "被拒的编辑不发射 op");

        // Archived item is frozen.
        repo::file_inbox_item(&conn, &id).unwrap();
        repo::archive_idea(&conn, &id).unwrap();
        assert!(edit(&mut conn, &mut clock, &id, "想改归档的").is_err());
    }

    #[test]
    fn promote_flips_stage_with_no_duplicate_record() {
        let (mut conn, mut clock) = fresh_db();
        let n = repo::add_item(&conn, "记得交房租").unwrap();

        // Promote with the SAME wording: pure flip, content unchanged, still one row.
        let id = promote_to_task(&mut conn, &mut clock, &n, "记得交房租").unwrap();
        assert_eq!(id, n, "the item id is the task id — same subject");
        assert_eq!(stage(&conn, &n), "todo");
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1, "no copy: 转待办 only changed the stage");
        // It landed on the board.
        assert_eq!(repo::list_tasks(&conn).unwrap().len(), 1);
        // 纯翻转:无 content op,有 stage 翻转 + 置顶后的 position。
        let shapes = op_shapes(&conn, &n);
        assert!(!shapes.contains(&("set_field".into(), "content".into())), "{shapes:?}");
        assert!(shapes.contains(&("set_field".into(), "stage".into())), "{shapes:?}");
        assert!(shapes.contains(&("set_field".into(), "position".into())), "{shapes:?}");

        // It is no longer an idea — re-promoting fails fast.
        assert!(promote_to_task(&mut conn, &mut clock, &n, "再来一次").is_err());
    }

    #[test]
    fn promote_with_changed_wording_keeps_original_in_history() {
        let (mut conn, mut clock) = fresh_db();
        let n = repo::add_item(&conn, "买菜").unwrap();
        promote_to_task(&mut conn, &mut clock, &n, "去超市买菜").unwrap();
        assert_eq!(content(&conn, &n), "去超市买菜");
        // The original capture is preserved as history (no data loss, no copy).
        let hist: Vec<String> = repo::item_revisions(&conn, &n).unwrap().into_iter().map(|r| r.content).collect();
        assert_eq!(hist, vec!["买菜".to_string()]);
        // 改了措辞的转待办多一条 content op。
        assert!(op_shapes(&conn, &n).contains(&("set_field".into(), "content".into())));
    }

    #[test]
    fn promote_empty_title_and_front_landing() {
        let (mut conn, mut clock) = fresh_db();
        let first = repo::add_item(&conn, "甲").unwrap();
        let second = repo::add_item(&conn, "乙").unwrap();
        assert!(promote_to_task(&mut conn, &mut clock, &first, "   ").is_err(), "empty title rejected");
        promote_to_task(&mut conn, &mut clock, &first, "甲").unwrap();
        promote_to_task(&mut conn, &mut clock, &second, "乙").unwrap();
        // Newest promoted is on top of 待办.
        assert_eq!(repo::column_task_ids(&conn, "todo").unwrap(), vec![second, first]);
    }

    #[test]
    fn revert_untagged_to_inbox_and_tagged_to_filed() {
        let (mut conn, mut clock) = fresh_db();

        // Untagged todo -> 未归类.
        let a = repo::add_item(&conn, "误转的").unwrap();
        promote_to_task(&mut conn, &mut clock, &a, "误转的").unwrap();
        revert_task_to_inbox(&mut conn, &mut clock, &a).unwrap();
        assert_eq!(stage(&conn, &a), "inbox");
        // 撤回清空任务态属性,四个字段各一条 op,stage 的值是 inbox、position 归 NULL。
        let ops = ops_for(&conn, "item", &a);
        let last4: Vec<(&str, &serde_json::Value)> = ops[ops.len() - 4..]
            .iter()
            .map(|o| (o.payload["field"].as_str().unwrap(), &o.payload["value"]))
            .collect();
        assert_eq!(last4[0], ("stage", &serde_json::json!("inbox")));
        assert_eq!(last4[1], ("position", &serde_json::Value::Null));

        // Tagged todo -> 已整理 (the tag filing is durable).
        let b = repo::add_item(&conn, "既有标签又转待办").unwrap();
        let topic = file_to_topic(&mut conn, &mut clock, &b, None, Some("某标签")).unwrap();
        promote_to_task(&mut conn, &mut clock, &b, "既有标签又转待办").unwrap();
        revert_task_to_inbox(&mut conn, &mut clock, &b).unwrap();
        assert_eq!(stage(&conn, &b), "filed", "kept filed because it still has a tag");
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM item_topic WHERE item_id=?1 AND topic_id=?2", (&b, &topic), |r| r.get(0))
            .unwrap();
        assert_eq!(links, 1, "tag kept");
    }

    #[test]
    fn revert_rejects_non_todo_archived_and_missing() {
        let (mut conn, mut clock) = fresh_db();

        // doing / done cannot revert.
        let doing = repo::insert_task(&conn, "在做", None, None).unwrap();
        repo::set_task_stage(&conn, &doing, "todo", "doing").unwrap();
        assert!(revert_task_to_inbox(&mut conn, &mut clock, &doing).is_err());
        let done = repo::insert_task(&conn, "做完", None, None).unwrap();
        repo::set_task_stage(&conn, &done, "todo", "done").unwrap();
        assert!(revert_task_to_inbox(&mut conn, &mut clock, &done).is_err());

        // missing.
        assert!(revert_task_to_inbox(&mut conn, &mut clock, "ghost").is_err());

        // archived todo: restored, not reverted.
        let t = repo::insert_task(&conn, "活", None, None).unwrap();
        repo::archive_task(&conn, &t).unwrap();
        assert!(revert_task_to_inbox(&mut conn, &mut clock, &t).is_err());
    }

    #[test]
    fn file_to_topic_new_then_existing_files_idea() {
        let (mut conn, mut clock) = fresh_db();
        let n1 = repo::add_item(&conn, "番茄钟").unwrap();
        let n2 = repo::add_item(&conn, "再一条").unwrap();

        let topic = file_to_topic(&mut conn, &mut clock, &n1, None, Some("效率")).unwrap();
        assert_eq!(stage(&conn, &n1), "filed");
        let same = file_to_topic(&mut conn, &mut clock, &n2, Some(&topic), None).unwrap();
        assert_eq!(same, topic);
        assert_eq!(repo::all_topics(&conn).unwrap().len(), 1, "no duplicate topic");
        // 首次归类的 op 三件套:stage 翻 filed + 标签出生 + link_add。
        assert_eq!(
            op_shapes(&conn, &n1),
            vec![("set_field".to_string(), "stage".to_string())]
        );
        assert_eq!(ops_for(&conn, "topic", &topic)[0].kind, "create");
        let lops = ops_for(&conn, "link", &format!("{n1}:{topic}"));
        assert_eq!(lops.len(), 1);
        assert_eq!(lops[0].kind, "link_add");

        // Re-filing the same item into the same topic is a duplicate link -> error.
        assert!(file_to_topic(&mut conn, &mut clock, &n1, Some(&topic), None).is_err());
        // Bad targets.
        assert!(file_to_topic(&mut conn, &mut clock, &n2, None, None).is_err());
        assert!(file_to_topic(&mut conn, &mut clock, &n2, Some("nope"), None).is_err());
    }

    #[test]
    fn merge_topics_unions_links_across_ideas_and_tasks() {
        let (mut conn, mut clock) = fresh_db();
        let links = |c: &rusqlite::Connection, topic: &str| -> i64 {
            c.query_row("SELECT COUNT(*) FROM item_topic WHERE topic_id=?1", [topic], |r| r.get(0)).unwrap()
        };

        let target = repo::insert_topic(&conn, "工作").unwrap();
        let src = repo::insert_topic(&conn, "职业").unwrap();

        // an idea and a task under src; the idea also under target (union collapses).
        let idea = repo::add_item(&conn, "灵感").unwrap();
        repo::file_inbox_item(&conn, &idea).unwrap();
        repo::link_item_topic(&conn, &idea, &src).unwrap();
        repo::link_item_topic(&conn, &idea, &target).unwrap();
        let task = repo::insert_task(&conn, "任务", None, None).unwrap();
        repo::link_item_topic(&conn, &task, &src).unwrap();

        merge_topics(&mut conn, &mut clock, &[src.clone()], &target, Some("  事业  ")).unwrap();
        assert!(!repo::topic_exists(&conn, &src).unwrap());
        assert_eq!(links(&conn, &target), 2, "idea (deduped) + task");
        let row = repo::all_topics(&conn).unwrap().pop().unwrap();
        assert_eq!(row.title, "事业", "renamed + trimmed");

        // op 形态:两条 link_remove(idea/task 离开 src)、一条 link_add(task 挂上
        // target;idea 本就在 target 下,不重发)、src 一条 tombstone、target 改名两条。
        assert_eq!(ops_for(&conn, "link", &format!("{idea}:{src}"))[0].kind, "link_remove");
        assert_eq!(ops_for(&conn, "link", &format!("{task}:{src}"))[0].kind, "link_remove");
        assert_eq!(ops_for(&conn, "link", &format!("{task}:{target}"))[0].kind, "link_add");
        assert!(ops_for(&conn, "link", &format!("{idea}:{target}")).is_empty(), "已在目标下的不重发 add");
        assert_eq!(ops_for(&conn, "topic", &src).last().unwrap().kind, "tombstone");
        let tset: Vec<String> = ops_for(&conn, "topic", &target)
            .iter()
            .map(|o| o.payload["field"].as_str().unwrap_or("-").to_string())
            .collect();
        assert_eq!(tset, vec!["title", "updated_at"]);
    }

    #[test]
    fn merge_topics_fails_fast_and_rolls_back() {
        let (mut conn, mut clock) = fresh_db();
        let target = repo::insert_topic(&conn, "工作").unwrap();
        let src = repo::insert_topic(&conn, "职业").unwrap();

        assert!(merge_topics(&mut conn, &mut clock, &[], &target, None).is_err());
        assert!(merge_topics(&mut conn, &mut clock, &[target.clone()], &target, None).is_err());
        assert!(merge_topics(&mut conn, &mut clock, &[src.clone(), src.clone()], &target, None).is_err());
        assert!(merge_topics(&mut conn, &mut clock, &[src.clone()], "ghost", None).is_err());
        assert!(merge_topics(&mut conn, &mut clock, &["ghost".to_string()], &target, None).is_err());
        assert!(merge_topics(&mut conn, &mut clock, &[src.clone()], &target, Some("   ")).is_err());
        assert_eq!(repo::all_topics(&conn).unwrap().len(), 2, "nothing changed");
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 0, "被拒的合并连一条 op 也不留");
    }

    #[test]
    fn topic_crud_emits_birth_rename_tombstone() {
        let (mut conn, mut clock) = fresh_db();
        assert!(create_topic(&mut conn, &mut clock, "   ").is_err());
        let id = create_topic(&mut conn, &mut clock, " 工作 ").unwrap();
        assert!(create_topic(&mut conn, &mut clock, "工作").is_err(), "duplicate rejected");
        rename_topic(&mut conn, &mut clock, &id, "事业").unwrap();
        assert!(rename_topic(&mut conn, &mut clock, "ghost", "无主").is_err());
        delete_topic(&mut conn, &mut clock, &id).unwrap();
        assert!(delete_topic(&mut conn, &mut clock, &id).is_err(), "already gone");

        let kinds: Vec<String> = ops_for(&conn, "topic", &id).into_iter().map(|o| o.kind).collect();
        assert_eq!(kinds, vec!["create", "set_field", "set_field", "tombstone"]);
    }

    #[test]
    fn set_topic_color_sets_clears_validates_and_leaves_order_untouched() {
        let (mut conn, mut clock) = fresh_db();
        let id = create_topic(&mut conn, &mut clock, "工作").unwrap();
        let updated0: String =
            conn.query_row("SELECT updated_at FROM topics WHERE id=?1", [&id], |r| r.get(0)).unwrap();

        // 非法格式 fail-fast、不存在的 id fail-fast。
        assert!(set_topic_color(&mut conn, &mut clock, &id, Some("blue".into())).is_err());
        assert!(set_topic_color(&mut conn, &mut clock, &id, Some("#12345".into())).is_err());
        assert!(set_topic_color(&mut conn, &mut clock, "ghost", Some("#abcdef".into())).is_err());

        // 设色 → 落列、发一条 color set_field、updated_at 不动(重着色不重排 chip)。
        set_topic_color(&mut conn, &mut clock, &id, Some("#3F7A99".into())).unwrap();
        let (color, updated1): (Option<String>, String) = conn
            .query_row("SELECT color, updated_at FROM topics WHERE id=?1", [&id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(color.as_deref(), Some("#3F7A99"));
        assert_eq!(updated1, updated0, "重着色不该动 updated_at");

        // 清色 → NULL、再发一条 color set_field(payload value = null)。
        set_topic_color(&mut conn, &mut clock, &id, None).unwrap();
        let color: Option<String> =
            conn.query_row("SELECT color FROM topics WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert!(color.is_none());

        let color_ops: Vec<_> = ops_for(&conn, "topic", &id)
            .into_iter()
            .filter(|o| o.kind == "set_field" && o.payload["field"] == "color")
            .collect();
        assert_eq!(color_ops.len(), 2, "设色 + 清色各一条 color op");
        assert_eq!(color_ops[0].payload["value"], "#3F7A99");
        assert!(color_ops[1].payload["value"].is_null(), "清色 op 的 value 是 null");
    }

    #[test]
    fn inbox_idea_soft_deletes_into_trash_and_restores_as_inbox() {
        // 73(反转 65 拍板的 UI 半句;墓碑契约不变):删除=进回收站,inbox 也不例外。
        // 软删是可逆字段(archived_at),真销毁只在回收站的彻底删除(那里才发 tombstone)。
        let (mut conn, mut clock) = fresh_db();
        let id = capture(&mut conn, &mut clock, "随手记错的").unwrap();

        archive(&mut conn, &mut clock, &id).unwrap();
        assert_eq!(stage(&conn, &id), "inbox", "frozen stage stays inbox");
        let trash = repo::idea_trash(&conn).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, id);

        // 还原回想法列表,仍是未归类。
        restore(&mut conn, &mut clock, &id).unwrap();
        assert_eq!(stage(&conn, &id), "inbox");
        assert!(repo::live_ideas(&conn).unwrap().iter().any(|r| r.id == id));

        // 再删 → 彻底删除:行真没了,op 尾是 tombstone。
        archive(&mut conn, &mut clock, &id).unwrap();
        purge(&mut conn, &mut clock, &id).unwrap();
        assert!(repo::item_stage(&conn, &id).unwrap().is_none());
        let shapes = op_shapes(&conn, &id);
        let arch: Vec<_> = shapes.iter().filter(|(_, f)| f == "archived_at").collect();
        assert_eq!(arch.len(), 3, "软删/还原/再软删各一条:{shapes:?}");
        assert_eq!(shapes.last().unwrap().0, "tombstone");
    }

    #[test]
    fn idea_trash_lifecycle_emits_archive_axis_and_tombstones() {
        let (mut conn, mut clock) = fresh_db();
        // inbox 硬删(命令级原语,UI 73 起不走):一条 tombstone。
        let junk = capture(&mut conn, &mut clock, "垃圾").unwrap();
        delete_inbox(&mut conn, &mut clock, &junk).unwrap();
        assert_eq!(op_shapes(&conn, &junk), vec![
            ("create".to_string(), "-".to_string()),
            ("tombstone".to_string(), "-".to_string()),
        ]);
        assert!(delete_inbox(&mut conn, &mut clock, &junk).is_err(), "gone -> fail fast");

        // filed 软删 → 还原 → 再软删 → 彻底删除:archived_at 值/NULL 交替,最后 tombstone。
        let a = capture(&mut conn, &mut clock, "甲").unwrap();
        file_to_topic(&mut conn, &mut clock, &a, None, Some("组")).unwrap();
        archive(&mut conn, &mut clock, &a).unwrap();
        assert!(archive(&mut conn, &mut clock, &a).is_err(), "already archived");
        restore(&mut conn, &mut clock, &a).unwrap();
        archive(&mut conn, &mut clock, &a).unwrap();
        purge(&mut conn, &mut clock, &a).unwrap();
        let shapes = op_shapes(&conn, &a);
        let arch_ops: Vec<&(String, String)> =
            shapes.iter().filter(|(_, f)| f == "archived_at").collect();
        assert_eq!(arch_ops.len(), 3, "软删/还原/再软删各一条:{shapes:?}");
        assert_eq!(shapes.last().unwrap().0, "tombstone");
    }

    #[test]
    fn purge_lifecycle_for_ideas() {
        let (mut conn, mut clock) = fresh_db();
        let a = repo::add_item(&conn, "甲").unwrap();
        repo::file_inbox_item(&conn, &a).unwrap();

        // Must archive before purge.
        assert!(purge(&mut conn, &mut clock, &a).is_err());
        repo::archive_idea(&conn, &a).unwrap();
        purge(&mut conn, &mut clock, &a).unwrap();
        assert!(repo::item_stage(&conn, &a).unwrap().is_none());

        // 清空: two more archived ideas.
        let mut cleared = Vec::new();
        for i in 0..2 {
            let n = repo::add_item(&conn, &format!("待清{i}")).unwrap();
            repo::file_inbox_item(&conn, &n).unwrap();
            repo::archive_idea(&conn, &n).unwrap();
            cleared.push(n);
        }
        assert_eq!(purge_all_archived(&mut conn, &mut clock).unwrap(), 2);
        for n in &cleared {
            assert_eq!(ops_for(&conn, "item", n).last().unwrap().kind, "tombstone");
        }
    }

    #[test]
    fn hard_deleting_an_item_with_images_emits_one_tombstone_and_no_image_op() {
        // 钉住 64 的级联设计(删除墓碑 A 案):删一条带配图的条目,图靠 FK 级联清,只发
        // 一条 item tombstone,不额外发 image_tombstone——回放端收到 item 删账、删主行时
        // 自己 CASCADE。别把级联子物的死亡也改成发独立 op(那会与「父 tombstone 支配子物」
        // 的回放契约打架,见 sync-plan §3.5)。
        let (mut conn, mut clock) = fresh_db();
        let id = capture(&mut conn, &mut clock, "带图灵感").unwrap();
        let (img_a, _) =
            crate::images::attach(&mut conn, &mut clock, &id, &[1, 2, 3], "image/png").unwrap();
        let (img_b, _) =
            crate::images::attach(&mut conn, &mut clock, &id, &[4, 5, 6], "image/jpeg").unwrap();

        delete_inbox(&mut conn, &mut clock, &id).unwrap();

        // 条目侧:出生快照 + 一条删账,别无其它。
        assert_eq!(op_shapes(&conn, &id), vec![
            ("create".to_string(), "-".to_string()),
            ("tombstone".to_string(), "-".to_string()),
        ]);
        // 图侧:各只有配图那一条 image_add,级联删除不发 image_tombstone。
        for img in [&img_a, &img_b] {
            let kinds: Vec<String> =
                ops_for(&conn, "image", img).into_iter().map(|o| o.kind).collect();
            assert_eq!(kinds, vec!["image_add".to_string()], "级联删图不该发独立 op:{kinds:?}");
        }
        // 图确实随条目级联删了(不是漏删)。
        assert!(repo::list_item_images(&conn, &id).unwrap().is_empty());
        assert!(repo::item_image_owner(&conn, &img_a).unwrap().is_none());
    }
}
