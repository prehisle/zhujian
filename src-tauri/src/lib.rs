// P4-a(android-plan §1):数据层 + 同步客户端全在共享 crate zhujian-core(../core),
// 本 crate 只剩 tauri 壳——命令面 / 托盘 / 窗口 / setup + SyncEvent→emit 事件桥。
// 97(sync-plan §六):桌面多空间——空间 = 账户 = 独立同步流 = 独立库,命令面显式
// space_id;空间的存在与身份(发现/白名单/四不变量)见 spaces.rs,本文件负责装配
// (逐空间 spawn transport + 事件贴空间标)与命令面。
mod spaces;

use spaces::Spaces;
use zhujian_core::sync::supervisor::{ActivateSpec, ActiveRuntime as SpaceRuntime, SpaceSupervisor};
use zhujian_core::{clock, db, images, notes, repo, sync, task};

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::Connection;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags};

/// 主窗几何要记的维度:尺寸/位置/最大化。刻意不含 VISIBLE——启动仪式保持
/// 「只弹捕获条、主窗被召唤才现身」,重启恢复的是「现身时的样子」而不是
/// 「要不要现身」;无边框固定窗也用不上 DECORATIONS/FULLSCREEN。
const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

/// e2e 开关(YS_DB_PATH 指定临时主库)。设了它同时意味着:禁扫/禁建空间(§六③,
/// 绝不许 e2e 摸到生产空间库)、不装单实例门(开发者常边开着 dev app 边跑 e2e)、
/// window-state 换独立文件(既有行为)。
fn e2e_db_path() -> Option<PathBuf> {
    match std::env::var("YS_DB_PATH") {
        Ok(p) if !p.is_empty() => Some(PathBuf::from(p)),
        _ => None,
    }
}

/// 前台空间(multispace-plan §9/§16.2 工序 8):capture 浮窗的落库目标。壳侧权威
/// 持有——capture 与 notebook 是两个 WebView,前端模块态不跨窗共享;notebook 切
/// 空间时经 `set_foreground_space` 写这里并广播,capture 窗只是它的影子。
/// 桌面 eager 全连、无停机窗口,故只有 space 无 phase(手机的 UserSwitching /
/// ManualSyncing 相位在安卓壳 Coord 里)。
struct ForegroundSpace(Mutex<String>);

/// notebook 切空间后同步前台空间(§9:捕获默认落「当前所在空间」)。广播
/// "space-foreground" 给所有窗——capture 窗据此更新目标空间名显示。
#[tauri::command]
fn set_foreground_space(
    space_id: String,
    app: AppHandle,
    spaces: State<'_, Spaces>,
    fg: State<'_, ForegroundSpace>,
) -> Result<(), String> {
    spaces.get(&space_id)?; // 存在且装载(dead 空间切不进,前端本就不给入口)。
    *fg.0.lock().expect("foreground mutex poisoned") = space_id.clone();
    let _ = app.emit("space-foreground", &space_id);
    Ok(())
}

#[tauri::command]
fn get_foreground_space(fg: State<'_, ForegroundSpace>) -> String {
    fg.0.lock().expect("foreground mutex poisoned").clone()
}

/// 深链接暂存(4b OS 桥):点击的 zhujian:// 链接由 deep-link 插件的 on_open_url 落这里,
/// 前端启动时(冷启动)与收到 "deep-link-open" 事件时(热启动)各来取一次——take 语义,
/// 取走即清,单一入口不会重放旧链接。安卓 take_shared_text 的桌面同构。
struct PendingDeepLink(Mutex<Option<String>>);

/// 取走并清空待处理的深链接 URL(无 = None)。前端 notebook 消费端(deeplink.ts /
/// notebook.ts openDeepLink)的取号口。
#[tauri::command]
fn consume_deep_link(pending: State<'_, PendingDeepLink>) -> Option<String> {
    pending.0.lock().expect("deep-link mutex poisoned").take()
}

/// Capture-first: persist a raw thought into the Inbox, return its id.
/// `space_id` = capture 窗「按下回车那刻看到的」目标空间;在前台状态内复核
/// (§16.2 提案 B):与 foreground 不符 = 目标已变,响亮拒、草稿保留,**绝不
/// 改写目标空间**(绝不「后端收到时随手读最新 foreground」——那正是竞态本身)。
#[tauri::command]
fn capture_note(
    space_id: String,
    content: String,
    spaces: State<'_, Spaces>,
    fg: State<'_, ForegroundSpace>,
) -> Result<String, String> {
    {
        let cur = fg.0.lock().expect("foreground mutex poisoned");
        if *cur != space_id {
            return Err("目标空间已经变化,请确认后重新保存".into());
        }
    }
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::capture(&mut conn, &mut clk, &content)
}

/// One row for the Inbox browse window: the raw thought plus when it was caught.
#[derive(Serialize)]
struct InboxItem {
    id: String,
    content: String,
    created_at: String,
}

/// List every thought still in the Inbox (newest first), for manual review.
#[tauri::command]
fn list_inbox(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<InboxItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let mut notes = repo::inbox_items(&conn).map_err(|e| e.to_string())?;
    notes.reverse(); // repo returns oldest-first; browsing wants newest-first
    Ok(notes
        .into_iter()
        .map(|n| InboxItem {
            id: n.id,
            content: n.content,
            created_at: n.created_at,
        })
        .collect())
}

/// One row for the "已整理" tab: a processed thought and the topics it is filed
/// under. Manageable (edit / re-promote / re-file) but not hard-deletable —
/// processed notes are provenance roots, so cleanup is future soft-archive, not a
/// delete here.
#[derive(Serialize)]
struct ProcessedItem {
    id: String,
    content: String,
    created_at: String,
    /// 'inbox' | 'filed' — the axis the DB's delete sovereignty runs on. The UI routes
    /// 删除 by this (inbox = hard-deletable junk, filed = soft → 回收站), NOT by whether
    /// `topics` is empty: a filed idea whose last tag was deleted stays filed.
    stage: String,
    /// Each tag as `{id, title, color}` — the 灵感 card renders them as chips, tinted by
    /// `color` (null = 无色) just like the board.
    topics: Vec<TopicItem>,
}

/// List every processed thought (newest first), for the "已整理" browse tab. Notes
/// still in the Inbox are excluded — they live on the "待处理" tab.
#[tauri::command]
fn list_processed(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<ProcessedItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::filed_items(&conn).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|n| ProcessedItem {
            id: n.id,
            content: n.content,
            created_at: n.created_at,
            stage: n.stage,
            topics: n.topics.into_iter().map(TopicItem::from).collect(),
        })
        .collect())
}

/// List every live idea — 未归类 and 已归类 together (newest first), for the merged
/// 灵感 list. Tags are just metadata now, so the view no longer splits inbox vs filed;
/// an untagged idea has an empty `topics`. Reuses ProcessedItem (chips render the same).
#[tauri::command]
fn list_ideas(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<ProcessedItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::live_ideas(&conn).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|n| ProcessedItem {
            id: n.id,
            content: n.content,
            created_at: n.created_at,
            stage: n.stage,
            topics: n.topics.into_iter().map(TopicItem::from).collect(),
        })
        .collect())
}

/// 灵感流转统计(纯派生、只算不存):本周捕获数 + 累计转待办比例的分子分母。
/// 只统计出生态已知的行(0018 born_stage);老数据未知、诚实排除——born_inbox 为 0
/// 时前端不显比例。week_start 由前端按本地周一 00:00 换算成 UTC RFC3339 传入
/// (后端从不算本地时间,同 due_on 的哲学)。
#[derive(Serialize)]
struct IdeaStatsItem {
    captured_week: i64,
    born_inbox: i64,
    converted: i64,
}

/// 深链接定位:一条 item 现在住在哪个视图/子视图,供前端 navigate + 高亮。返回值
/// 与搜索 jump 的路由词汇一致——"task"(看板)/ "sealed"(归档册)/ "trash-task"
/// (看板回收站)/ "inbox"(灵感)/ "trash-idea"(灵感回收站);None = 该 id 在本
/// 空间不存在(链接来自本机没有的空间,或已彻底删除)。
#[tauri::command]
fn locate_item(space_id: String, item_id: String, spaces: State<'_, Spaces>) -> Result<Option<String>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let axes = repo::item_axes(&conn, &item_id).map_err(|e| e.to_string())?;
    Ok(axes.map(|(stage, archived, sealed)| {
        let is_idea = stage == "inbox" || stage == "filed";
        if sealed {
            "sealed"
        } else if archived {
            if is_idea {
                "trash-idea"
            } else {
                "trash-task"
            }
        } else if is_idea {
            "inbox"
        } else {
            "task"
        }
        .to_string()
    }))
}

#[tauri::command]
fn idea_stats(space_id: String, week_start: String, spaces: State<'_, Spaces>) -> Result<IdeaStatsItem, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let s = repo::idea_stats(&conn, &week_start).map_err(|e| e.to_string())?;
    Ok(IdeaStatsItem {
        captured_week: s.captured_week,
        born_inbox: s.born_inbox,
        converted: s.converted,
    })
}

/// One topic with the processed notes filed under it, for the 按主题浏览 window.
/// The inverse of the 已整理 tab: a topic is the axis and its notes hang beneath it.
#[derive(Serialize)]
struct TopicTreeItem {
    id: String,
    title: String,
    /// Chip tint (`#RRGGBB`) or null = 无色 —— 标签视图据此画色点。
    color: Option<String>,
    /// 手动排序键(0031 frindex)或 null = 未定序 —— 标签视图据此排序/拖动定位。
    position: Option<String>,
    /// 标签类型自由文本(0031)或 null = 无类型 —— 供日后按类型筛选。
    kind: Option<String>,
    notes: Vec<InboxItem>,
}

/// Browse the knowledge structure by topic: every topic that holds at least one
/// processed note, each carrying those notes (newest first). Read-only — pivots the
/// 已整理 tab's flat note→topics timeline onto the topic axis.
#[tauri::command]
fn list_topic_tree(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<TopicTreeItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::topics_with_notes(&conn).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|t| TopicTreeItem {
            id: t.id,
            title: t.title,
            color: t.color,
            position: t.position,
            kind: t.kind,
            notes: t
                .notes
                .into_iter()
                .map(|n| InboxItem {
                    id: n.id,
                    content: n.content,
                    created_at: n.created_at,
                })
                .collect(),
        })
        .collect())
}

/// Hard-delete one Inbox note. Only notes still in the Inbox can be removed —
/// already-organized notes are immutable provenance. 73 起 UI 不再走这条路(删除统一
/// 先进回收站);保留给命令层与 e2e 清库。
#[tauri::command]
fn delete_note(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::delete_inbox(&mut conn, &mut clk, &id)
}

/// Soft-delete a live idea into the 回收站 (灵感的「删除」— 73 起未归类与已归类同一
/// 归宿). It leaves the 想法 list but is recoverable — provenance and edit history stay
/// intact. A task-stage / already-archived item affects 0 rows and fails fast.
#[tauri::command]
fn archive_note(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::archive(&mut conn, &mut clk, &id)
}

/// Restore an archived note from the 回收站 back to the 想法 list (its frozen stage —
/// inbox or filed — is kept). Only an 'archived' note can be restored.
#[tauri::command]
fn restore_note(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::restore(&mut conn, &mut clk, &id)
}

/// List the 回收站 (archived notes, newest first) — same shape as 已整理 so chips
/// still show. Reuses ProcessedItem.
#[tauri::command]
fn list_archived(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<ProcessedItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::idea_trash(&conn).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|n| ProcessedItem {
            id: n.id,
            content: n.content,
            created_at: n.created_at,
            stage: n.stage,
            topics: n.topics.into_iter().map(TopicItem::from).collect(),
        })
        .collect())
}

/// One search hit: a matched thought plus enough provenance to place it — its
/// process status (which view holds it) and the topics it's filed under. Read-only
/// locate view; manage from the 收件箱 / 已整理 tabs.
#[derive(Serialize)]
struct SearchHitItem {
    id: String,
    content: String,
    created_at: String,
    status: String,
    topics: Vec<String>,
}

/// Search every thought by content (across inbox / processed / archived), newest
/// first. A literal substring match — see repo::search_notes. An empty (or
/// whitespace-only) query fails fast rather than dumping every note; the search
/// window simply shows its idle prompt instead of calling for an empty box.
#[tauri::command]
fn search_notes(space_id: String, query: String, spaces: State<'_, Spaces>) -> Result<Vec<SearchHitItem>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("搜索词不能为空".to_string());
    }
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::search_items(&conn, q).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|h| SearchHitItem {
            id: h.id,
            content: h.content,
            created_at: h.created_at,
            status: h.status,
            topics: h.topics,
        })
        .collect())
}

/// Permanently delete one archived note (彻底删除). Only notes already in the 回收站
/// can be purged — a processed note must be archived first (the 0004 trigger also
/// guards this). One transaction: cascades the note's topic/task links and edit
/// history; tasks survive, only their provenance link to this note goes (see
/// notes::purge).
#[tauri::command]
fn purge_note(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::purge(&mut conn, &mut clk, &id)
}

/// Empty the 回收站 (清空回收站): permanently delete every archived note (and sweep
/// orphaned suggestions). Returns how many notes were removed, for the UI to report.
#[tauri::command]
fn purge_archived(space_id: String, spaces: State<'_, Spaces>) -> Result<usize, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::purge_all_archived(&mut conn, &mut clk)
}

/// One task card for the board: the todo plus its current column, due day,
/// priority, and topic tag.
#[derive(Serialize)]
struct TaskItem {
    id: String,
    title: String,
    status: String,
    /// User-local calendar day `YYYY-MM-DD`, or null. The frontend (which alone
    /// knows local "today") decides 今天到期/逾期 from this.
    due_on: Option<String>,
    /// 1/2/3 = 低/中/高, or null = 未设.
    priority: Option<i64>,
    /// 成就归档时间(RFC3339),null = 不在归档册。只有 `list_sealed_tasks` 的行非 null;
    /// 归档视图按它的本地日分组成时间轴。
    sealed_at: Option<String>,
    /// 完成时刻(RFC3339,0030 done_at),null = 未知(本功能前完成的老卡)。看板「已完成」
    /// 卡据它显示「完成于」;归档册按 COALESCE(done_at, sealed_at) 分组(完成日优先)。只增不清。
    done_at: Option<String>,
    /// Every tag on this card (M:N, `item_topic`), each `{id, title}`. Empty = 无标签.
    /// The board shows them all as chips; the filter bar treats a card as belonging to
    /// each of its tags. Tag order follows the topic's `updated_at` (see repo::task_rows).
    topics: Vec<TopicItem>,
}

impl From<repo::TaskRow> for TaskItem {
    fn from(t: repo::TaskRow) -> Self {
        // Single-entity model: a board card is an item at a task stage. `content` is the
        // title, `stage` is the column. Tags are M:N — expose the full set.
        let topics = t
            .topics
            .into_iter()
            .map(|tag| TopicItem { id: tag.id, title: tag.title, color: tag.color, kind: None })
            .collect();
        TaskItem {
            id: t.id,
            title: t.content,
            status: t.stage,
            due_on: t.due_on,
            priority: t.priority,
            sealed_at: t.sealed_at,
            done_at: t.done_at,
            topics,
        }
    }
}

/// Every *active* task, for the board. The frontend buckets them into status
/// columns; within a column the backend orders by urgency — soonest due first
/// (undated last), then higher priority, with last-touched only as a tie-breaker
/// (see repo::list_tasks). Archived tasks (回收站) come from `list_archived_tasks`.
#[tauri::command]
fn list_tasks(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<TaskItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::list_tasks(&conn).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(TaskItem::from).collect())
}

/// Archived (soft-deleted) tasks for the board's 回收站, most-recently-archived
/// first. Each keeps its pre-archive status (todo/doing/done).
#[tauri::command]
fn list_archived_tasks(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<TaskItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::archived_tasks(&conn).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(TaskItem::from).collect())
}

/// Move a task between board columns (free movement among todo/doing/done in
/// either direction). The legal-transition check and the current state both gate
/// it — see task.rs. An illegal or stale move fails fast, it is not silently dropped.
#[tauri::command]
fn update_task_status(space_id: String, id: String, to: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::transition(&mut conn, &mut clk, &id, &to)
}

/// Reorder a card within (or into) a board column by drag-and-drop. `ordered_ids`
/// is the target column's complete new order, `base_target_ids` its order before
/// the move (a stale-view check). A cross-column drop also changes status, inserted
/// at the dropped position. One transaction, fail-fast on any inconsistency — see
/// task::reorder.
#[tauri::command]
fn reorder_task(space_id: String, 
    id: String,
    from_status: String,
    to_status: String,
    base_target_ids: Vec<String>,
    ordered_ids: Vec<String>,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::reorder(
        &mut conn,
        &mut clk,
        &id,
        &from_status,
        &to_status,
        &base_target_ids,
        &ordered_ids,
    )
}

/// Reorder a card under a topic FILTER, where the frontend only sees a visible subset
/// of each column. `visible_after` is the target column's visible cards in their new
/// order (including the dragged card); `base_visible_ids` is that visible subset before
/// the move (a stale check). The backend reads the full column and merges the visible
/// reorder back in, keeping hidden cards put. Kept separate from `reorder_task` (the
/// unfiltered strong-contract path). See task::reorder_visible.
#[tauri::command]
fn reorder_task_visible(space_id: String, 
    id: String,
    from_status: String,
    to_status: String,
    base_visible_ids: Vec<String>,
    visible_after: Vec<String>,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::reorder_visible(
        &mut conn,
        &mut clk,
        &id,
        &from_status,
        &to_status,
        &base_visible_ids,
        &visible_after,
    )
}

/// Soft-archive (删除) an active task into the 回收站 (recoverable). Any active
/// todo/doing/done task can be archived; an already-archived/missing task fails fast.
#[tauri::command]
fn archive_task(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::archive(&mut conn, &mut clk, &id)
}

/// Restore an archived task from the 回收站 back onto the board (to its original column).
#[tauri::command]
fn restore_task(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::restore(&mut conn, &mut clk, &id)
}

/// Permanently delete one archived task from the 回收站 (explicit user cleanup).
/// Only an archived task can be purged; a live task fails fast.
#[tauri::command]
fn purge_task(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::purge(&mut conn, &mut clk, &id)
}

/// Empty the task 回收站: permanently delete every archived task. Returns how many
/// were removed, for the UI to report.
#[tauri::command]
fn purge_archived_tasks(space_id: String, spaces: State<'_, Spaces>) -> Result<usize, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::purge_all(&mut conn, &mut clk)
}

/// 归档一条「已完成」任务进成就册(成就归档,sealed_at 轴——与回收站分开的正经存档:
/// 可查、不可删)。只有活跃的 done 任务可归档;其余 fail fast — see task::seal.
#[tauri::command]
fn seal_task(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::seal(&mut conn, &mut clk, &id)
}

/// 一键归档看板「已完成」列的全部任务。返回归档条数(0 = 列本来就空,由 UI 决定说什么)。
#[tauri::command]
fn seal_done_tasks(space_id: String, spaces: State<'_, Spaces>) -> Result<usize, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::seal_all(&mut conn, &mut clk)
}

/// 取消归档:任务离开成就册,回到看板「已完成」列的末尾。归档不可删——想删除须先取消
/// 归档回看板,再走正常两段式删除(删除主权仍在,只是多一步防冲动)。
#[tauri::command]
fn unseal_task(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::unseal(&mut conn, &mut clk, &id)
}

/// 归档册:全部已归档的成就,最近归档在前(sealed_at 非 null,前端按归档日分组)。
#[tauri::command]
fn list_sealed_tasks(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<TaskItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::sealed_tasks(&conn).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(TaskItem::from).collect())
}

/// Manually create a standalone todo (no source note) directly on the board, born
/// 'todo' (user state), optionally carrying a due date, priority, and/or topic tag.
/// The task is inserted at the FRONT of the 待办 column (newest on top). The whole
/// create is atomic: title is validated, priority range-checked, then one
/// transaction inserts the row and renumbers the column — an invalid due/priority
/// (CHECK) or non-existent topic_id (FK) fails the row and leaves nothing behind.
/// Returns the new task's id. See task::create.
#[tauri::command]
fn create_task(space_id: String, 
    title: String,
    due_on: Option<String>,
    priority: Option<i64>,
    topic_id: Option<String>,
    spaces: State<'_, Spaces>,
) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::create(&mut conn, &mut clk, &title, due_on.as_deref(), priority, topic_id.as_deref())
}

/// Rename an active task (board/today edit). Title is trimmed and must be non-empty;
/// an archived/missing task fails fast — see task::rename.
#[tauri::command]
fn rename_task(space_id: String, id: String, title: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::rename(&mut conn, &mut clk, &id, &title)
}

/// Set or clear a task's due date (a user-local calendar day `YYYY-MM-DD`, or null
/// to clear). Only an active task can be edited; an archived task or a bad day fails
/// fast — see task::set_due.
#[tauri::command]
fn set_task_due(space_id: String, id: String, due_on: Option<String>, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::set_due(&mut conn, &mut clk, &id, due_on.as_deref())
}

/// Set or clear a task's priority (1/2/3 = 低/中/高, or null = 未设). Range-validated;
/// an archived task fails fast — see task::set_priority.
#[tauri::command]
fn set_task_priority(space_id: String, id: String, priority: Option<i64>, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::set_priority(&mut conn, &mut clk, &id, priority)
}

/// Add one tag to a task (multi-tag, M:N). Idempotent; only an active task can be
/// tagged; an archived/missing task or a non-existent topic id fails fast — see task::add_topic.
#[tauri::command]
fn add_task_topic(space_id: String, id: String, topic_id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::add_topic(&mut conn, &mut clk, &id, &topic_id)
}

/// Remove one tag from a task (multi-tag, M:N). Idempotent; only an active task can be
/// edited; an archived/missing task fails fast — see task::remove_topic.
#[tauri::command]
fn remove_task_topic(space_id: String, id: String, topic_id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    task::remove_topic(&mut conn, &mut clk, &id, &topic_id)
}

// ---- Manual idea-flow spine (no AI) -----------------------------------------

/// Edit a note's text. The superseded version is archived first (append-only
/// history), so nothing is lost — see notes.rs. A no-op or empty edit fails fast.
#[tauri::command]
fn edit_note(space_id: String, id: String, content: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::edit(&mut conn, &mut clk, &id, &content)
}

/// One superseded version of a note, for the history view.
#[derive(Serialize)]
struct RevisionItem {
    content: String,
    archived_at: String,
}

/// A note's edit history (its superseded versions, newest first). The current
/// text lives on the note itself; this is the trail behind it.
#[tauri::command]
fn list_note_history(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<Vec<RevisionItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::item_revisions(&conn, &id).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| RevisionItem {
            content: r.content,
            archived_at: r.archived_at,
        })
        .collect())
}

/// Manually turn a note into a user todo (no AI). The note moves inbox→processed
/// and gains a 'todo' task linked for provenance — see notes.rs.
#[tauri::command]
fn promote_note_to_task(space_id: String, id: String, title: String, spaces: State<'_, Spaces>) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::promote_to_task(&mut conn, &mut clk, &id, &title)
}

/// 撤回为灵感: send a 待办 back to 灵感源 (灵感 = a not-yet-clarified task — the same
/// subject at a less-mature stage). Only a `todo` task can revert; the task is deleted
/// and an idea returns to 灵感源 — restoring its original idea if it was converted from
/// one (kept 已整理 if still filed under a topic, else back to 未归类), or seeding a fresh
/// 未归类 idea from the title if it was manually created. See notes::revert_task_to_inbox.
#[tauri::command]
fn revert_task_to_inbox(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::revert_task_to_inbox(&mut conn, &mut clk, &id)
}

/// One topic for the manual filing picker. `color` = chip tint (`#RRGGBB`) or null = 无色.
/// `kind` = 自由文本类型(0031,默认 null = 无类型),只在 `list_topics` 带真值——供看板按
/// 类型筛选;作为条目卡片的 chip(From<TagRef>)时恒 null(TagRef 不载 kind、chip 也用不到)。
#[derive(Serialize)]
struct TopicItem {
    id: String,
    title: String,
    color: Option<String>,
    kind: Option<String>,
}

impl From<repo::TagRef> for TopicItem {
    fn from(t: repo::TagRef) -> Self {
        TopicItem { id: t.id, title: t.title, color: t.color, kind: None }
    }
}

/// Every topic, for the manual "file into a topic" picker (existing or new).
#[tauri::command]
fn list_topics(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<TopicItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::all_topics(&conn).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|t| TopicItem {
            id: t.id,
            title: t.title,
            color: t.color,
            kind: t.kind,
        })
        .collect())
}

/// Manually file a note into a topic (no AI): an existing one by id, or a new one
/// by title. Exactly one of `topic_id` / `new_title` is given — see notes.rs.
#[tauri::command]
fn file_note_to_topic(space_id: String, 
    id: String,
    topic_id: Option<String>,
    new_title: Option<String>,
    spaces: State<'_, Spaces>,
) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::file_to_topic(&mut conn, &mut clk, &id, topic_id.as_deref(), new_title.as_deref())
}

/// Remove one tag from a 灵感 (multi-tag, M:N). Idempotent; only an active idea
/// (inbox/filed) can be edited; a task/archived/missing item fails fast — see
/// notes::remove_topic. Removing the last tag flips 已整理 -> 未归类.
#[tauri::command]
fn remove_note_topic(space_id: String, id: String, topic_id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(同 remove_task_topic;旗与导入共临界区)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::remove_topic(&mut conn, &mut clk, &id, &topic_id)
}

/// List every topic — including empty ones — each with the processed notes filed under
/// it, for the manual topic-management view. Unlike `list_topic_tree` (read-only browse,
/// hides empties), this keeps empty topics so they can be edited/deleted, ordered
/// most-recently-changed first.
#[tauri::command]
fn list_topics_full(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<TopicTreeItem>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::all_topics_with_notes(&conn).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|t| TopicTreeItem {
            id: t.id,
            title: t.title,
            color: t.color,
            position: t.position,
            kind: t.kind,
            notes: t
                .notes
                .into_iter()
                .map(|n| InboxItem {
                    id: n.id,
                    content: n.content,
                    created_at: n.created_at,
                })
                .collect(),
        })
        .collect())
}

/// Create a topic (tag) by hand (no AI). Fails fast on an empty title. Returns its id.
#[tauri::command]
fn create_topic(space_id: String, title: String, spaces: State<'_, Spaces>) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::create_topic(&mut conn, &mut clk, &title)
}

/// Edit a topic's title. Fails fast on an empty title or a missing id (affected rows != 1).
#[tauri::command]
fn update_topic(space_id: String, id: String, title: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::rename_topic(&mut conn, &mut clk, &id, &title)
}

/// Set or clear a topic's chip color (`color` = `#RRGGBB`, or null to clear). Syncs like
/// a rename (topic set_field + LWW). Fails fast on a bad format or a missing id.
#[tauri::command]
fn set_topic_color(space_id: String, 
    id: String,
    color: Option<String>,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::set_topic_color(&mut conn, &mut clk, &id, color)
}

/// Reorder a topic in the manual list (0031 1c). `prev_id` / `next_id` are the ids of the
/// dragged topic's new neighbours (either null = 列首前 / 列尾后); the backend lands it
/// strictly between them (one frindex key write, one op — multi-writer friendly).
#[tauri::command]
fn reorder_topic(
    space_id: String,
    id: String,
    prev_id: Option<String>,
    next_id: Option<String>,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::reorder_topic(&mut conn, &mut clk, &id, prev_id.as_deref(), next_id.as_deref())
}

/// Set or clear a topic's free-text type label (0031;`kind` = 「人名」等,或 null/空串 = 清
/// 类型)。Syncs like color (topic set_field + LWW). Fails fast on a non-canonical value or a
/// missing id.
#[tauri::command]
fn set_topic_kind(
    space_id: String,
    id: String,
    kind: Option<String>,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::set_topic_kind(&mut conn, &mut clk, &id, kind)
}

/// Delete a topic (manual maintenance). Only the topic projection goes — its
/// note_topic links cascade away, but the notes themselves (the fact source) are
/// untouched and stay in 灵感源. Fails fast if the topic does not exist.
#[tauri::command]
fn delete_topic(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::delete_topic(&mut conn, &mut clk, &id)
}

/// Merge several topics into one survivor (manual recluster, no AI): re-point every
/// source's notes onto the target (set-union), delete the now-empty source topics, and
/// optionally rename the survivor. Rewrites the current topic projection — see notes.rs.
#[tauri::command]
fn merge_topics(space_id: String, 
    source_ids: Vec<String>,
    target_id: String,
    new_title: Option<String>,
    spaces: State<'_, Spaces>,
) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    notes::merge_topics(&mut conn, &mut clk, &source_ids, &target_id, new_title.as_deref())
}

/// An image attachment's metadata (no bytes): its id, 「图N」编号, and MIME.
#[derive(Serialize)]
struct ImageMeta {
    id: String,
    seq: i64,
    mime: String,
}

/// Attach a pasted / imported image to an item as its next numbered 「图N」 attachment. The
/// bytes arrive base64-encoded (compact across the IPC boundary) and are decoded to a real
/// BLOB. Returns the new image's id + 编号 + MIME. See images::attach.
#[tauri::command]
fn add_item_image(space_id: String, 
    item_id: String,
    mime: String,
    data_b64: String,
    spaces: State<'_, Spaces>,
) -> Result<ImageMeta, String> {
    let bytes = STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("图片数据解码失败:{e}"))?;
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    let (id, seq) = images::attach(&mut conn, &mut clk, &item_id, &bytes, &mime)?;
    Ok(ImageMeta { id, seq, mime })
}

/// List an item's images (编号 ascending) — id + 编号 + MIME, no bytes. Deleted 编号 leave gaps
/// (图1、图3); thumbnail bytes load lazily via get_item_image.
#[tauri::command]
fn list_item_images(space_id: String, item_id: String, spaces: State<'_, Spaces>) -> Result<Vec<ImageMeta>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = repo::list_item_images(&conn, &item_id).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| ImageMeta { id: r.id, seq: r.seq, mime: r.mime })
        .collect())
}

/// One image's bytes as a ready-to-render `data:` URL (the frontend sets `img.src` directly),
/// or an error if the id is unknown (fail-fast — no silent placeholder).
#[tauri::command]
fn get_item_image(space_id: String, image_id: String, spaces: State<'_, Spaces>) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let (bytes, mime) = repo::item_image_data(&conn, &image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("图片不存在:{image_id}"))?;
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}

/// Delete one image (换图 / 移除配图). Its 编号 is retired, never reused. A missing id is an
/// error, not a silent no-op. See repo::delete_item_image.
#[tauri::command]
fn delete_item_image(space_id: String, image_id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    images::remove(&mut conn, &mut clk, &image_id)
}

/// 跨空间移动条目(cross-space-move v1,codex 设计审三轮已折入):三原语在全局
/// `lifecycle` 互斥内顺序执行(single-flight,与创号/配对同锁);两空间的锁先后
/// 独立拿放,绝不同时持有。M6+三轮 #1 后端验证(源≠目标/两 runtime 在场/任一端
/// veto 一律拒)在 spaces::move_between 内,不信 UI 列表。结果结构化分道(§4):
/// 只有 Moved 让前端做卡片离场;CopiedButSourceKept 保留源卡片、如实带原因。
#[tauri::command]
async fn move_item_to_space(
    space_id: String,
    target_space_id: String,
    item_id: String,
    spaces: State<'_, Spaces>,
) -> Result<spaces::MoveResult, String> {
    let _life = spaces.lifecycle.lock().await;
    spaces::move_between(spaces.inner(), &space_id, &target_space_id, &item_id)
}

// ---- 同步命令面(sync-protocol §8;每空间一个传输任务在 setup 常驻,这里是开关面) ----

/// 同步状态快照(侧栏状态点/设置面板;变更另有 "sync-status" 事件实时推送,
/// 事件 payload 带 space 标——§六⑥ 事件按空间路由)。
#[tauri::command]
fn sync_status(space_id: String, spaces: State<'_, Spaces>) -> Result<sync::transport::SyncStatus, String> {
    let rt = spaces.get(&space_id)?;
    let s = rt.status.lock().expect("sync status mutex poisoned").clone();
    Ok(s)
}

/// 账户唯一性闸(§六④ 的「配对」时机):`account_id` 已被 focus 之外的空间
/// 占用 = Err。**必须发生在正式配置落库之前**(pair_join 的 gate 回调在 core 里
/// 卡在 save_config 前)——配置一旦可见,并发控制命令就可能让传输任务把材料
/// clone 进会话内存,事后清库拦不住已上线的会话。创号不再过此闸(open-signup:
/// 账户 ULID 在 core 内自生成,与既有空间撞号=违背 ULID 唯一性假设,与 device_id
/// 同待遇);外来账户 ID(配对/加入空间)照旧必过。
/// `others` 由调用方在 lifecycle 锁内快照(排除 focus)。
/// 账户唯一性的权威裁决(space-entry-plan §3.5):join reservation + **磁盘重扫**
/// (不信 runtime 表——「publish 成功、activate 失败」的新正式文件不在表里)。
/// e2e 模式(dir=None,禁扫磁盘)退回 live runtimes 现读。任一候选读不出 =
/// fail-closed Err。`exclude` = 正在绑定账户的空间自身(创号/main 配对)。
fn account_free_desktop(spaces: &Spaces, exclude: Option<&str>, acc: &str) -> Result<(), String> {
    if spaces.reserved_accounts.lock().expect("reserved mutex poisoned").contains(acc) {
        return Err(
            "这个账户正在(或刚刚)被「加入空间」使用——空间=账户,一空间一账户;若刚才加入失败,重启朱笺后再试"
                .into(),
        );
    }
    match &spaces.dir {
        Some(dir) => {
            let main_db = dir.join("notebook.sqlite3");
            for (id, path) in spaces::discover(&main_db, Some(dir), None)? {
                if Some(id.as_str()) == exclude {
                    continue;
                }
                let d = spaces::read_descriptor(&id, &path)?;
                if d.account_id.as_deref() == Some(acc) {
                    let label = d.name.clone().unwrap_or_else(|| {
                        if id == spaces::MAIN_SPACE { "默认空间".into() } else { id.clone() }
                    });
                    return Err(format!(
                        "这个账户已被空间「{label}」使用——空间=账户,一空间一账户"
                    ));
                }
            }
            Ok(())
        }
        None => {
            let others: Vec<_> = spaces
                .all()
                .into_iter()
                .filter(|o| Some(o.id.as_str()) != exclude)
                .collect();
            account_taken_by_other(&others, acc)
        }
    }
}

fn account_taken_by_other(others: &[Arc<SpaceRuntime>], account_id: &str) -> Result<(), String> {
    for other in others {
        let (taken, name) = {
            let conn = other.db.lock().expect("db mutex poisoned");
            match sync::transport::account_id(&conn)? {
                Some(a) if a == account_id => (true, spaces::space_name(&conn)?),
                _ => (false, None),
            }
        };
        if taken {
            let name = name.unwrap_or_else(|| {
                if other.id == spaces::MAIN_SPACE { "默认空间".into() } else { other.id.clone() }
            });
            return Err(format!(
                "这个账户已被空间「{name}」使用——空间=账户,一空间一账户;要同步这个空间就直接创建新账户,要进那个账户就到对应空间里配对"
            ));
        }
    }
    Ok(())
}

/// 现读全部已装载空间的身份(§六④ 运行时校验的输入;逐空间短暂拿锁即放,
/// 不同空间的锁互不嵌套)。
fn live_identities(spaces: &Spaces) -> Result<Vec<spaces::SpaceIdentity>, String> {
    let mut out = Vec::new();
    for rt in spaces.all() {
        let conn = rt.db.lock().expect("db mutex poisoned");
        let clk = rt.clock.lock().expect("clock mutex poisoned");
        out.push(spaces::read_identity(&rt.id, &rt.path, &conn, &clk)?);
    }
    Ok(out)
}

/// 创建同步账户(账户首台;open-signup 无感创号):账户 ULID 由 core 自生成,
/// 无码无预检(自生成与既有空间撞号=违背 ULID 唯一性假设,账户唯一闸只管外来
/// 账户 ID)。成功返回恢复码——UI 必须走强制仪式(展示 + 确认已抄写)后才允许
/// 关闭(§2)。
#[tauri::command]
async fn sync_create_account(
    space_id: String,
    server_url: String,
    spaces: State<'_, Spaces>,
) -> Result<String, String> {
    let rt = spaces.get_writable(&space_id)?;
    if let Some(v) = rt.veto() {
        return Err(v);
    }
    // 生命周期互斥:创号/配对/建空间/其余控制命令串行。
    let _life = spaces.lifecycle.lock().await;
    // ReopenRequired 复核在 lifecycle 取得之后(codex 二轮 M2:等待锁期间旗可能落下)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    let code = sync::transport::create_account(&rt.db, &server_url).await?;
    let _ = rt.control.send(sync::transport::Control::Reconfigured).await;
    Ok(code)
}

/// 发起配对(老设备侧):向服务器开一次性配对槽,返回配对码 `slot-XXXX-XXXX`
/// (10 分钟内有效、只能用一次);后续进度走 "sync-pair" 事件(带 space 标)。
#[tauri::command]
async fn sync_pair_start(space_id: String, spaces: State<'_, Spaces>) -> Result<String, String> {
    let rt = spaces.get_writable(&space_id)?;
    if let Some(v) = rt.veto() {
        return Err(v);
    }
    // 生命周期互斥:PairStart 会唤醒传输任务重读配置——不许它在别的空间创号/配对
    // 写到一半时看见中间态(「配置在裁决前不可见」不变量的旁路封堵)。
    let _life = spaces.lifecycle.lock().await;
    // ReopenRequired 复核在 lifecycle 取得之后(codex 二轮 M2:等待锁期间旗可能落下)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    rt.control
        .send(sync::transport::Control::PairStart { reply: tx })
        .await
        .map_err(|_| "同步任务未运行".to_string())?;
    // 超时所有权在 core(phone-space-plan §1.3:开槽 15s、码 TTL 600s、receiver
    // 无人接即收口烧槽);这里 30s 只是「PairOpen 发送在死链路上挂死」的兜底。
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("配对请求被放弃(连接中断?)".into()),
        Err(_) => Err("发起配对超时(网络不通?)".into()),
    }
}

/// 配对加入的目标闸(space-entry-plan §2,后端不变量、不是 UI 藏按钮):只接受
/// main——非 main 空间的两条来路是「新建=纯本地本子(同步唯一路=创号)」与
/// 「加入空间」(隐式 staging 槽,不收目标 space_id);直接 invoke 非 main 必拒。
/// 刻意收掉的能力:「已有内容的非 main 空间配对入账户(并集合并)」没有入口且
/// 后端拒(§2;机制在 main 保留,真有边缘需求走跨空间移动)。
fn pair_join_target_gate(space_id: &str) -> Result<(), String> {
    if space_id != spaces::MAIN_SPACE {
        return Err(
            "这个空间不走配对加入:想把别处的账户带到这台电脑,请用「空间」里的「加入空间」;本空间要多端同步请在「同步」里创建账户"
                .into(),
        );
    }
    Ok(())
}

/// 加入账户(新设备侧,**仅 main**——见 [`pair_join_target_gate`]):输入老设备展示
/// 的配对码。成功后传输任务自动上线并走引导(快照直通拿全量);本机已有数据保留、
/// 与账户数据并集(§6.2)。
#[tauri::command]
async fn sync_pair_join(
    space_id: String,
    server_url: String,
    code: String,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    pair_join_target_gate(&space_id)?;
    let rt = spaces.get_writable(&space_id)?;
    if let Some(v) = rt.veto() {
        return Err(v);
    }
    // 生命周期互斥 + 账户闸(§六④/multispace-plan §4):gate 回调由 core 卡在
    // 「Grant 解出之后、Enroll 发出之前」——误配进别的空间已用的账户 = PairClose
    // 走人,老端从不注册、配置一个键都不写,本机设备身份不烧(工序 7/8 H1)。
    let _life = spaces.lifecycle.lock().await;
    // ReopenRequired 复核在 lifecycle 取得之后(codex 二轮 M2:等待锁期间旗可能落下)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    let spaces_ref: &Spaces = &spaces;
    let gate_space = space_id.clone();
    sync::transport::pair_join(&rt.db, &server_url, &code, move |acc: &str| {
        account_free_desktop(spaces_ref, Some(&gate_space), acc)
    })
    .await?;
    let _ = rt.control.send(sync::transport::Control::Reconfigured).await;
    Ok(())
}

/// 「加入空间」结果 DTO(space-entry-plan §3.2 三轮 M5)。**只有 publish 之前的
/// 失败走 Err**;PublishedNeedsRestart = 空间已真实存在、账户已注册——前端只提示
/// 「已加入,重启后出现」,绝不谎报失败、绝不按「失败无痕」删库。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum JoinOutcome {
    Integrated { space: SpaceInfo, warnings: Vec<String> },
    PublishedNeedsRestart { space_id: String, error: String },
}

/// 「加入空间」(space-entry-plan §3,桌面):隐式 `.joining-*` staging 槽上完成
/// 配对 + 完整 `Transport::run` 引导 → close → publish → 身份全表裁决 → activate
/// 进 eager runtime 表 + 事件桥,成功才成为用户可见空间。**不收目标 space_id**
/// (一轮 H3)。进度走 "join-progress" 事件(带 attempt_id);视图切换由前端走
/// 正常入口(草稿感知),后端不强切。
#[tauri::command]
async fn join_space(
    server_url: String,
    code: String,
    attempt_id: String,
    app: AppHandle,
    spaces: State<'_, Spaces>,
) -> Result<JoinOutcome, String> {
    let dir = spaces
        .dir
        .as_ref()
        .ok_or_else(|| "测试模式(YS_DB_PATH)不加入空间".to_string())?
        .clone();
    // single-flight(同步登记,先于一切 await;槽兼取消通道)。清槽走 RAII——
    // future 被 drop(命令层消亡)也不许把 Some 永久残留成「加入永远在进行」;
    // 且 staging transport 若还活着(abort 是协作式取消,同步段要到下个 await 才
    // 消亡),**清标必须等它真死**(codex 二轮 M1:否则新 join 与垂死旧 staging
    // transport 并存)——由 JoinFlight 的 Drop 接管:abort + reaper await 后清标。
    let mut cancel_rx = {
        let mut slot = spaces.join_cancel.lock().expect("join_cancel mutex poisoned");
        if slot.is_some() {
            return Err("已有一次「加入空间」在进行中".into());
        }
        let (tx, rx) = tokio::sync::watch::channel(false);
        *slot = Some(tx);
        rx
    };
    let staging_task: StagingTaskSlot = Arc::new(Mutex::new(None));
    struct JoinFlight {
        cancel: Arc<Mutex<Option<tokio::sync::watch::Sender<bool>>>>,
        staging: StagingTaskSlot,
    }
    impl Drop for JoinFlight {
        fn drop(&mut self) {
            let pending = self.staging.lock().expect("staging slot mutex poisoned").take();
            match pending {
                None => {
                    self.cancel.lock().expect("join_cancel mutex poisoned").take();
                }
                Some(h) => {
                    h.abort();
                    let cancel = self.cancel.clone();
                    match tokio::runtime::Handle::try_current() {
                        Ok(rt) => {
                            rt.spawn(async move {
                                let _ = h.await; // 真消亡后才释放 single-flight
                                cancel.lock().expect("join_cancel mutex poisoned").take();
                            });
                        }
                        Err(_) => {
                            cancel.lock().expect("join_cancel mutex poisoned").take();
                        }
                    }
                }
            }
        }
    }
    let _flight = JoinFlight { cancel: spaces.join_cancel.clone(), staging: staging_task.clone() };
    join_space_inner(&app, &spaces, &dir, &server_url, &code, &attempt_id, &mut cancel_rx, &staging_task)
        .await
}

/// staging transport 任务的共享句柄槽(正常路 stop_staging 取走;future drop 时由
/// JoinFlight 接管)。
type StagingTaskSlot = Arc<Mutex<Option<tokio::task::JoinHandle<sync::transport::TransportExit>>>>;

/// 取消进行中的「加入空间」(只在 BootCommitted 前生效;提交与取消同时就绪时
/// 成功优先)。
#[tauri::command]
fn join_space_cancel(spaces: State<'_, Spaces>) {
    if let Some(tx) = spaces.join_cancel.lock().expect("join_cancel mutex poisoned").as_ref() {
        let _ = tx.send(true);
    }
}

fn release_join_reservation(spaces: &Spaces, reserved: &Mutex<Option<String>>) {
    if let Some(acc) = reserved.lock().expect("reserved mutex poisoned").take() {
        spaces.reserved_accounts.lock().expect("reserved mutex poisoned").remove(&acc);
    }
}

/// 加入编排本体(§3.2 状态机 Preparing → Paired → BootCommitted → Published →
/// Integrated;与安卓 coord::join_space 同构,差异只在集成段:桌面 = 身份全表裁决
/// + activate 进 eager 表 + 事件桥)。
async fn join_space_inner(
    app: &AppHandle,
    spaces: &Spaces,
    dir: &std::path::Path,
    server_url: &str,
    code: &str,
    attempt_id: &str,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    staging_task: &StagingTaskSlot,
) -> Result<JoinOutcome, String> {
    let progress = |phase: &str, received: i64, total: i64| {
        let _ = app.emit_to(
            "notebook",
            "join-progress",
            serde_json::json!({
                "attempt_id": attempt_id, "phase": phase, "received": received, "total": total
            }),
        );
    };
    // 账户绑定互斥:建槽到 Integrated 全程持有(与创号/配对/建空间同锁)。
    let _life = spaces.lifecycle.lock().await;
    progress("preparing", 0, 0);
    let slot = spaces::JoiningSlot::create(dir)?;
    let reserved: Mutex<Option<String>> = Mutex::new(None);
    progress("pairing", 0, 0);
    let pair_outcome: Result<(), String> = {
        let gate_cancel = cancel_rx.clone();
        let gate = |acc: &str| -> Result<(), String> {
            // GrantPending 裁决:磁盘重扫 + reservation(§3.5,不信 runtime 表)。
            account_free_desktop(spaces, None, acc)?;
            if *gate_cancel.borrow() {
                return Err("已取消加入".into());
            }
            spaces
                .reserved_accounts
                .lock()
                .expect("reserved mutex poisoned")
                .insert(acc.to_string());
            *reserved.lock().expect("reserved mutex poisoned") = Some(acc.to_string());
            Ok(())
        };
        let slot_db = slot.db();
        let join = sync::transport::pair_join(&slot_db, server_url, code, gate);
        tokio::select! {
            biased;
            r = join => r,
            _ = cancel_rx.wait_for(|v| *v) => Err("已取消加入空间".into()),
        }
    };
    if let Err(e) = pair_outcome {
        // 配对未成(或取消):槽清干净则本次无痕(reservation 一并释放——本机无
        // 副本;服务器侧若已注册设备由回执如实提示)。
        return Err(match slot.abort() {
            Ok(()) => {
                release_join_reservation(spaces, &reserved);
                e
            }
            Err(c) => format!("{e};且暂存清理失败(重启朱笺后自动清理):{c}"),
        });
    }

    // Paired → BootCommitted:staging 库上跑完整 Transport::run(§3.2 装配写死:
    // Full / 不当源 / 保留 control sender / 独立 shutdown / 共享 latch)。
    let status = Arc::new(Mutex::new(sync::transport::SyncStatus::default()));
    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel();
    let (ctl_tx, ctl_rx) = tokio::sync::mpsc::channel(8);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (notice_tx, notice_rx) = tokio::sync::oneshot::channel();
    let latch: sync::transport::BootCommitLatch = Arc::new(Mutex::new(Some(notice_tx)));
    let wrote = Arc::new(tokio::sync::Notify::new());
    {
        // §3.2 装配清单:oplog hook 照挂(staging 上正常无本地写,与正式装配同构)。
        let db = slot.db();
        let conn = db.lock().expect("db mutex poisoned");
        sync::transport::hook_oplog_writes(&conn, wrote.clone());
    }
    let t = sync::transport::Transport {
        db: slot.db(),
        clock: slot.clock(),
        status: status.clone(),
        events: ev_tx,
        control: ctl_rx,
        wrote,
        data_dir: spaces.boot_dir.clone(),
        blob_policy: sync::transport::BlobPolicy::Full,
        allow_boot_source: false,
        shutdown: shutdown_rx,
        boot_commit: latch,
        restart_flag: Arc::new(Mutex::new(None)),
    };
    /// shutdown → 限时等退出;不退就 abort 强杀并等到真消亡(丢句柄 = detach,
    /// 任务还持 DB Arc,槽清不掉而 single-flight 又已释放)。abort 落在 await 点 =
    /// 事务边界,撕不裂 SQLite 事务(supervisor 停机同款安全论证)。
    async fn stop_staging(shutdown_tx: &tokio::sync::watch::Sender<bool>, slot: &StagingTaskSlot) {
        // 取消安全(codex 三轮 M1):句柄取出后本 future 若在 await 中被 drop,归还
        // 守卫把句柄放回槽——JoinFlight 的 Drop 仍能接管(abort + reaper),绝不
        // detach。确认消亡后置 None 不归还(归还已完成句柄无害:reaper 首次 await
        // 立即 Ready)。
        struct PutBack<'a> {
            slot: &'a StagingTaskSlot,
            h: Option<tokio::task::JoinHandle<sync::transport::TransportExit>>,
        }
        impl Drop for PutBack<'_> {
            fn drop(&mut self) {
                if let Some(h) = self.h.take() {
                    *self.slot.lock().expect("staging slot mutex poisoned") = Some(h);
                }
            }
        }
        let mut ret = PutBack { slot, h: slot.lock().expect("staging slot mutex poisoned").take() };
        let Some(h) = ret.h.as_mut() else { return };
        let _ = shutdown_tx.send(true);
        if tokio::time::timeout(std::time::Duration::from_secs(10), &mut *h).await.is_err() {
            h.abort();
            let _ = (&mut *h).await;
        }
        ret.h = None; // 已确认消亡(与上一行之间无 await,不存在取消窗)
    }
    *staging_task.lock().expect("staging slot mutex poisoned") =
        Some(tokio::spawn(sync::transport::run(t)));
    let fwd = tauri::async_runtime::spawn({
        let app = app.clone();
        let aid = attempt_id.to_string();
        async move {
            while let Some(ev) = ev_rx.recv().await {
                if let sync::transport::SyncEvent::BootProgress { received, total } = ev {
                    let _ = app.emit_to(
                        "notebook",
                        "join-progress",
                        serde_json::json!({
                            "attempt_id": aid, "phase": "booting",
                            "received": received, "total": total
                        }),
                    );
                }
            }
        }
    });
    progress("booting", 0, 0);

    enum Waited {
        Committed(sync::transport::BootCommitNotice),
        Cancelled,
        TransportGone(String),
    }
    // biased 且提交臂在前:BootCommitted 与取消同时就绪只走成功一次(§3.2)。
    let waited = tokio::select! {
        biased;
        n = notice_rx => match n {
            Ok(notice) => Waited::Committed(notice),
            Err(_) => Waited::TransportGone("同步会话意外退出".into()),
        },
        _ = cancel_rx.wait_for(|v| *v) => Waited::Cancelled,
    };
    let notice = match waited {
        Waited::Committed(n) => n,
        Waited::Cancelled => {
            stop_staging(&shutdown_tx, staging_task).await;
            fwd.abort();
            return Err(match slot.abort() {
                Ok(()) => {
                    release_join_reservation(spaces, &reserved);
                    // 不过度承诺(§7):Enroll 已发的取消会在账户侧留孤儿设备,
                    // 多次孤儿可能触发设备上限——如实指路,不保证无条件重来成功。
                    "已取消加入空间。若配对已完成,账户侧会留下一台闲置设备注册;重复取消后加不进时,联系运营者吊销闲置设备再试".into()
                }
                Err(c) => format!("已取消加入,但暂存清理失败(重启朱笺后自动清理):{c}"),
            });
        }
        Waited::TransportGone(why) => {
            fwd.abort();
            let err = status.lock().expect("status mutex poisoned").error.clone().unwrap_or(why);
            return Err(match slot.abort() {
                Ok(()) => {
                    release_join_reservation(spaces, &reserved);
                    format!("加入失败:{err}")
                }
                Err(c) => format!("加入失败:{err};且暂存清理失败(重启朱笺后自动清理):{c}"),
            });
        }
    };

    // BootCommitted → Published:shutdown(不退则 abort 强杀)→ close → publish。
    progress("publishing", 0, 0);
    stop_staging(&shutdown_tx, staging_task).await;
    fwd.abort();
    drop(ctl_tx);
    let closed = match slot.close() {
        Ok(c) => c,
        Err(f) => {
            // 既不 publish 也不假装已清(§3.1 fail-closed);reservation 保留到重启。
            return Err(format!("加入未完成(收尾失败,重启朱笺后重试):{}", f.error));
        }
    };
    let published = match closed.publish() {
        Ok(p) => p,
        Err((closed, e)) => {
            // publish 失败(§3.5:本进程对该账户 fail-closed 到重启)。
            return Err(match closed.abort() {
                Ok(()) => format!("{e}(暂存已清理;重启朱笺后可重试加入)"),
                Err(c) => format!("{e};且暂存清理失败(重启朱笺后自动清理):{c}"),
            });
        }
    };

    // Published → Integrated(桌面):身份全表裁决 → activate 进 eager 表 + 事件桥。
    // activation 失败走 PublishedNeedsRestart——空间已真实存在,**不许**照
    // create_space 简单删库报 Err(三轮 L2)。
    progress("integrating", 0, 0);
    let mut warnings = Vec::new();
    if let Some(w) = published.cleanup_error {
        warnings.push(w);
    }
    if !notice.needs_reopen {
        if let Some(w) = notice.post_commit_error {
            warnings.push(w);
        }
    }
    let id = published.id.clone();
    // 集成段到 activate(插表 + 事件桥)为止是可失败区;activate 一成功即 Integrated
    // (codex 一轮 M4:activate 之后再 Err 会把「实已在表」误报成 PublishedNeeds
    // Restart 并错误保留 reservation)。
    let integrate = (|| -> Result<Arc<SpaceRuntime>, String> {
        // 正式打开走 db::open 正道(桌面策略;版本恰当前,迁移为 no-op)。
        let conn = db::open(&published.path).map_err(|e| format!("打开新空间库失败:{e}"))?;
        let clk = clock::Clock::load(&conn).map_err(|e| format!("初始化空间时钟失败:{e}"))?;
        // §六④ 身份全表裁决(新者垫底:真撞上时败的是新空间,不连坐已有空间)。
        let mut idents = live_identities(spaces)?;
        idents.push(spaces::read_identity(&id, &published.path, &conn, &clk)?);
        if let Some(spaces::Veto::Hard(m) | spaces::Veto::Soft(m)) =
            spaces::identity_vetoes(&idents).remove(&id)
        {
            return Err(m);
        }
        activate_space(app, spaces, id.clone(), published.path.clone(), conn, clk, None)
    })();
    match integrate {
        Ok(rt) => {
            release_join_reservation(spaces, &reserved);
            // Integrated 已成事实:此后信息拼装只许 best-effort,不许再翻成失败。
            let name = {
                let conn = rt.db.lock().expect("db mutex poisoned");
                match spaces::space_name(&conn) {
                    Ok(n) => n,
                    Err(e) => {
                        warnings.push(format!("空间名读取失败(列表稍后自会刷新):{e}"));
                        None
                    }
                }
            };
            let status = rt.status.lock().expect("sync status mutex poisoned").clone();
            Ok(JoinOutcome::Integrated {
                space: SpaceInfo { id: rt.id.clone(), name, status, alive: true },
                warnings,
            })
        }
        // reservation 保留(fail-closed 到重启):publish 成功、集成失败的重试会
        // 二次加入同一账户,必须拒到重启(§3.5)。
        Err(e) => Ok(JoinOutcome::PublishedNeedsRestart {
            space_id: id,
            error: format!("空间已加入,但装配失败:{e}——重启朱笺后空间会出现"),
        }),
    }
}

/// 改服务器地址(运营者迁移服务器时用;须已加入账户)。写入即触发重连。
#[tauri::command]
async fn sync_set_server(
    space_id: String,
    server_url: String,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get_writable(&space_id)?;
    if let Some(v) = rt.veto() {
        return Err(v);
    }
    // 生命周期互斥:同 sync_pair_start——Reconfigured 不许打进别人的裁决窗口。
    let _life = spaces.lifecycle.lock().await;
    // ReopenRequired 复核在 lifecycle 取得之后(codex 二轮 M2:等待锁期间旗可能落下)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
    {
        let conn = rt.db.lock().expect("db mutex poisoned");
        // ReopenRequired 复核在 db 锁内(codex 三轮 M2:set_server 是裸 db.lock 写,
        // 不走 write_locks,锁前预检有「查后落旗抢锁」竞态)。
        if let Some(e) = rt.restart_required() {
            return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
        }
        sync::transport::set_server(&conn, &server_url)?;
    }
    rt.control
        .send(sync::transport::Control::Reconfigured)
        .await
        .map_err(|_| "同步任务未运行".to_string())?;
    Ok(())
}

/// 查看恢复码(设置面板二步确认后展示;K_acc 的人眼形态,丢它=全部设备丢失时
/// 数据不可恢复,§2 强制仪式的复读入口)。
#[tauri::command]
fn sync_recovery_code(space_id: String, spaces: State<'_, Spaces>) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    // 密钥材料不出 core(P4-a 窄公开面):k_acc 的读取与转码都在 core 内完成。
    sync::transport::recovery_code(&conn)
}

// ---- 空间命令面(sync-plan §六;空间的存在与身份见 spaces.rs) ----

/// 一个空间的概要(侧栏切换器菜单行)。`name` 缺省 None——主库显示「默认空间」
/// 由前端定,后端绝不主动写名(§六⑦);`status` 带上省一轮 per-space 请求,
/// 切换器行上的状态点/红点直接用。`alive=false` = 启动时被 hard veto 未装载
/// (同一物理库的第二个名字):切换器列出并说明,但不可切入。
#[derive(Serialize)]
struct SpaceInfo {
    id: String,
    name: Option<String>,
    status: sync::transport::SyncStatus,
    alive: bool,
}

fn space_info(rt: &SpaceRuntime) -> Result<SpaceInfo, String> {
    let name = {
        let conn = rt.db.lock().expect("db mutex poisoned");
        spaces::space_name(&conn)?
    };
    Ok(SpaceInfo {
        id: rt.id.clone(),
        name,
        status: rt.status.lock().expect("sync status mutex poisoned").clone(),
        alive: true,
    })
}

/// 全部空间(主库恒排第一,其余按 id = 创建序;启动时未装载的 hard-veto 空间
/// 垫底列出——文件在目录里却「消失」是静默,响亮原则不许)。
#[tauri::command]
fn list_spaces(spaces: State<'_, Spaces>) -> Result<Vec<SpaceInfo>, String> {
    let mut all = spaces.all();
    all.sort_by(|a, b| (a.id != spaces::MAIN_SPACE).cmp(&(b.id != spaces::MAIN_SPACE)).then(a.id.cmp(&b.id)));
    let mut out: Vec<SpaceInfo> = all.iter().map(|rt| space_info(rt)).collect::<Result<_, _>>()?;
    for d in &spaces.dead {
        out.push(SpaceInfo {
            id: d.id.clone(),
            name: None,
            status: sync::transport::SyncStatus {
                state: "off".into(),
                error: Some(d.reason.clone()),
                ..Default::default()
            },
            alive: false,
        });
    }
    Ok(out)
}

/// 新建一个空间:一枚新 ULID 命名的独立库(建库即跑全部迁移、生独立 device_id),
/// 同步不自动配——空间=账户,进哪个账户由用户在该空间里创号/配对决定。
/// 空间数不设上限(109 决定①去了 v1 硬限);名字必填(新空间没有缺省名可显示)。
#[tauri::command]
async fn create_space(
    name: String,
    app: AppHandle,
    spaces: State<'_, Spaces>,
) -> Result<SpaceInfo, String> {
    let dir = spaces
        .dir
        .as_ref()
        .ok_or_else(|| "测试模式(YS_DB_PATH)不建空间".to_string())?
        .clone();
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("给空间起个名字(比如「家庭」)".into());
    }
    // 生命周期互斥:建库 → 装配 → 插表整段原子(创号/配对同锁,建空间期间账户闸的
    // 世界观也稳定)。空间数不设上限(spaces::DESKTOP_MAX_LIVE),不再有创建限额闸。
    let _life = spaces.lifecycle.lock().await;
    // 建库走共享层(multispace-plan §3):`.creating-<ULID>` staging → 全部迁移 +
    // 独立 device_id + 显示名 → rename 归位——一次成功返回的 create_space 真的是
    // 完整库,半成品绝不伪装成正式空间(残留暂存由启动 sweep 清)。
    let (id, path) = spaces::create_space(&dir, &trimmed)?;
    // 正式打开(db::open 切 WAL)+ 时钟恒等加载。此后任何失败只删这枚本次创建的库。
    let assemble = || -> Result<(Connection, clock::Clock), String> {
        let conn = db::open(&path).map_err(|e| format!("打开新空间库失败:{e}"))?;
        let clk = clock::Clock::load(&conn).map_err(|e| format!("初始化空间时钟失败:{e}"))?;
        Ok((conn, clk))
    };
    let (conn, clk) = match assemble() {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    // §六④「建空间时机」的身份校验:新库理论上天然成立(新文件+新 device_id+未配
    // 账户),仍照设计走一遍全表裁决兜底(文件系统怪象/时钟种子异常都在这里响亮)。
    // 新者垫底 = 真撞上时败的是新空间,不连坐已有空间。
    let veto = (|| -> Result<Option<spaces::Veto>, String> {
        let mut idents = live_identities(&spaces)?;
        idents.push(spaces::read_identity(&id, &path, &conn, &clk)?);
        Ok(spaces::identity_vetoes(&idents).remove(&id))
    })();
    match veto {
        Ok(None) => {}
        Ok(Some(spaces::Veto::Hard(m) | spaces::Veto::Soft(m))) | Err(m) => {
            drop(conn);
            let _ = std::fs::remove_file(&path);
            return Err(m);
        }
    }
    let rt = match activate_space(&app, &spaces, id, path.clone(), conn, clk, None) {
        Ok(rt) => rt,
        Err(e) => {
            // activate 失败(重复/超限都是编排 bug 才会到这):同样不留半成品库。
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    // 手工组 SpaceInfo,不走可失败的 space_info():97 的失败语义是「命令 Err 则
    // 空间不存在」,activate(插表)之后不许再有失败点——名字就是刚落库的 trimmed,
    // 状态照抄 runtime,不必再读库。
    let status = rt.status.lock().expect("sync status mutex poisoned").clone();
    Ok(SpaceInfo {
        id: rt.id.clone(),
        name: Some(trimmed),
        status,
        alive: true,
    })
}

/// 改空间显示名(0028 起账户内共享:同事务 UPSERT + 发射 space op,随同步跨端;
/// 主库也可改——「用户真改名才落行」正是 §六⑦ 的另一半)。本地改名不经 transport,
/// 命令成功后自行广播 space-name-changed 两窗(§4.7 三入口之三——捕获窗徽章
/// 否则收不到,codex 二轮 H2)。
#[tauri::command]
fn rename_space(
    space_id: String,
    name: String,
    app: AppHandle,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    {
        let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱笺完成初始同步装配:{e}"));
    }
        spaces::set_space_name(&mut conn, &mut clk, &name)?;
    }
    for win in ["notebook", "capture"] {
        let _ = app.emit_to(win, "space-name-changed", serde_json::json!({ "space": space_id }));
    }
    Ok(())
}

/// 重置空间(epoch-plan §7):清除本机该空间副本,之后走配对重新加入。**UI 义务
/// (multispace §20 门 4)在前端**:二段确认红字(本机该空间数据将删除、须有另一台
/// 在线完整副本、旧 device_id 报运营者吊销)。次序 = supervisor `begin_reset`(会话
/// 收场 + 连接 drop 证明 + 墓碑挡并发)→ 文件步 → `finish_reset`;文件步失败墓碑
/// 留下(fail-closed),重启进程按恢复路径续。main 特例:原地重建未配置空库并重新
/// 装配(main 不可摘除);非 main:空间从本机消失。
#[tauri::command]
async fn reset_space(
    space_id: String,
    app: AppHandle,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let dir = spaces
        .dir
        .as_ref()
        .ok_or_else(|| "测试模式(YS_DB_PATH)不重置空间".to_string())?
        .clone();
    let _life = spaces.lifecycle.lock().await;
    let ticket = spaces.sup.begin_reset(&space_id).await?;
    let files = if space_id == spaces::MAIN_SPACE {
        spaces::reset_main_files(&dir).map(|_| ())
    } else {
        spaces::reset_space_files(&dir, &space_id)
    };
    if let Err(e) = files {
        // 墓碑留下(不 finish):此空间本进程内封锁,重启走 sweep/journal 恢复路径。
        return Err(format!("重置文件步失败(空间已封锁,重启应用后自动恢复):{e}"));
    }
    spaces.sup.finish_reset(ticket);
    if space_id == spaces::MAIN_SPACE {
        // main 重建为 fresh 未配置空库,重新装配回 eager 表(桌面 main 常驻)。
        let path = dir.join("notebook.sqlite3");
        let conn = db::open(&path).map_err(|e| format!("重开新主库失败:{e}"))?;
        let clk = clock::Clock::load(&conn).map_err(|e| format!("新主库时钟失败:{e}"))?;
        activate_space(&app, &spaces, spaces::MAIN_SPACE.into(), path, conn, clk, None)?;
    }
    Ok(())
}

/// notebook 只在首个召唤时补一次「最大化恢复」;之后关窗只是隐藏、几何原样留着,
/// 再召唤直接 show 即可,不必重摆。
static NOTEBOOK_MAXIMIZE_RESTORED: AtomicBool = AtomicBool::new(false);

/// 读 window-state 插件写的状态文件,看 notebook 上次是否记为最大化。插件把它存在
/// app 配置目录(`app_config_dir`)、e2e 换 `.window-state.e2e.json` 文件名。读不到 /
/// 解析失败都当「非最大化」(fail-safe:大不了按记住的尺寸显示,不强行最大化)。
fn saved_notebook_maximized<R: Runtime>(app: &AppHandle<R>) -> bool {
    let name = if e2e_db_path().is_some() {
        ".window-state.e2e.json"
    } else {
        ".window-state.json"
    };
    let Ok(dir) = app.path().app_config_dir() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(dir.join(name)) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("notebook")?.get("maximized")?.as_bool())
        .unwrap_or(false)
}

/// Summon and focus a window by label. Windows always exist (declared in
/// tauri.conf.json), so a missing handle is a programming error, not a runtime
/// condition to recover from.
fn show_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let window = app
        .get_webview_window(label)
        .unwrap_or_else(|| panic!("window '{label}' must exist"));

    // 57 的几何恢复:插件在窗口还隐藏时就把尺寸/位置摆好了——非最大化场景足够。但
    // 「上次是最大化」不行:maximize() 在隐藏窗上不生效、show() 之后才认,若等 show
    // 完再 maximize 会先闪一下小窗。所以在 notebook 首个召唤、且上次记为最大化时,先把
    // 窗口摆成显示器工作区(与最大化后同一块矩形),再 show,最后 maximize 只翻状态位、
    // 几何不动 —— 打开即最大化、全程无闪。只做一次:之后隐藏/召唤都保留几何。
    if label == "notebook"
        && !NOTEBOOK_MAXIMIZE_RESTORED.swap(true, Ordering::Relaxed)
        && saved_notebook_maximized(app)
    {
        if let Ok(Some(mon)) = window.current_monitor() {
            let wa = mon.work_area();
            let _ = window.set_position(wa.position);
            let _ = window.set_size(wa.size);
        }
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        window.show().expect("show window");
        let _ = window.maximize();
        window.set_focus().expect("focus window");
        return;
    }

    // A minimized window won't return to the foreground from show()/set_focus() alone on
    // Windows — restore it first. Non-fatal: a transient minimize-state query failure
    // shouldn't crash the summon.
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    window.show().expect("show window");
    window.set_focus().expect("focus window");
}

/// 唤起笔记本主窗。托盘双击、托盘「打开朱笺」菜单项、以及 Ctrl+Alt+M 全局键
/// 三处入口共用此逻辑,避免散三份将来漂移。
/// 刻意不强制切视图:主窗隐藏不销毁,唤起后天然停在离开时的视图;真重启由前端
/// 视图记忆(zhujian.last-view)恢复——早年写死直达看板,与视图记忆打架,已改。
fn open_notebook<R: Runtime>(app: &AppHandle<R>) {
    show_window(app, "notebook");
}

/// 装配一个空间:activate(core supervisor——库连接 + update_hook 写通知 + HLC
/// 时钟 + transport 常驻,未配置账户时任务睡在控制通道上零打扰)+ 事件桥(给每个
/// 事件贴空间标,§六⑥ 前端按空间路由)。开库策略在调用方(桌面 eager 全开所有
/// 发现的空间,不设上限)。
/// `veto` 非空 = 身份四不变量没过(§六④):supervisor 不 spawn transport(控制
/// 通道成死信箱,sync_* 命令响亮拒),状态固化为「off + 原因」,本地数据照常可用。
fn activate_space(
    app: &AppHandle,
    spaces: &Spaces,
    id: String,
    path: PathBuf,
    conn: Connection,
    clk: clock::Clock,
    veto: Option<String>,
) -> Result<Arc<SpaceRuntime>, String> {
    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel();
    let rt = spaces.sup.activate(
        ActivateSpec {
            id,
            path,
            // 桌面 eager 路径不经 catalog descriptor(身份四不变量在活连接上另行
            // 裁决);手机从 descriptor 激活时必传(multispace-plan §2 复核)。
            expected_file: None,
            events: ev_tx,
            boot_dir: spaces.boot_dir.clone(),
            // 桌面 = 全量端:图字节即缺即拉,且应答别机的引导快照请求(124 起手机
            // 两者同款,phone-space-plan 对称升格;字节有洞时 core 防线自动拒供)。
            blob_policy: sync::transport::BlobPolicy::Full,
            allow_boot_source: true,
            sync_veto: veto,
        },
        conn,
        clk,
    )?;
    // 事件桥:每空间一条,转成 notebook 窗的前端事件并贴空间标。桌面 v1 不停机
    // 故不校验代次;通道随 transport 消亡,桥任务自然退出(veto 空间没有 transport,
    // 发送端已随 ActivateSpec 消费而 drop,桥起来即退)。
    let bridge = app.clone();
    let space = rt.id.clone();
    tauri::async_runtime::spawn(async move {
        use sync::transport::SyncEvent;
        while let Some(ev) = ev_rx.recv().await {
            let _ = match ev {
                SyncEvent::Status(s) => bridge.emit_to(
                    "notebook",
                    "sync-status",
                    serde_json::json!({ "space": space, "status": s }),
                ),
                SyncEvent::Changed => bridge.emit_to(
                    "notebook",
                    "sync-changed",
                    serde_json::json!({ "space": space }),
                ),
                // 空间名变了(live replay / boot 物化;本地改名在 rename_space 命令
                // 里自行广播):发**两窗**、不分当前空间——捕获徽章/空间菜单都要刷
                // (space-name-sync-plan §4.7,codex 一轮 H5)。
                SyncEvent::SpaceNameChanged => {
                    let _ = bridge.emit_to(
                        "capture",
                        "space-name-changed",
                        serde_json::json!({ "space": space }),
                    );
                    bridge.emit_to(
                        "notebook",
                        "space-name-changed",
                        serde_json::json!({ "space": space }),
                    )
                }
                SyncEvent::Toast(m) => bridge.emit_to(
                    "notebook",
                    "sync-toast",
                    serde_json::json!({ "space": space, "msg": m }),
                ),
                SyncEvent::Pair { phase, detail } => bridge.emit_to(
                    "notebook",
                    "sync-pair",
                    serde_json::json!({ "space": space, "phase": phase, "detail": detail }),
                ),
                // 引导进度(P4-d):桌面加入者也会引导(家庭空间第二台桌面),
                // 前端暂未画进度条,事件先桥出去(带空间标),按需接。
                SyncEvent::BootProgress { received, total } => bridge.emit_to(
                    "notebook",
                    "sync-boot",
                    serde_json::json!({ "space": space, "received": received, "total": total }),
                ),
            };
        }
    });
    Ok(rt)
}

// 全局热键的修饰键跨平台分叉:Windows 用 Ctrl+Alt(桌面老惯例、无冲突);macOS
// 用 Cmd+Alt(用户肌肉记忆是 Cmd,即 keyboard-types 的 SUPER)。ACCEL_* 是托盘
// 菜单里的 display-only 提示串(键本身由 global_shortcut 插件持有),跟着一起改。
#[cfg(target_os = "macos")]
const HOTKEY_MODS: Modifiers = Modifiers::SUPER.union(Modifiers::ALT);
#[cfg(not(target_os = "macos"))]
const HOTKEY_MODS: Modifiers = Modifiers::CONTROL.union(Modifiers::ALT);
#[cfg(target_os = "macos")]
const ACCEL_CAPTURE: &str = "Cmd+Alt+N";
#[cfg(target_os = "macos")]
const ACCEL_NOTEBOOK: &str = "Cmd+Alt+M";
#[cfg(not(target_os = "macos"))]
const ACCEL_CAPTURE: &str = "Ctrl+Alt+N";
#[cfg(not(target_os = "macos"))]
const ACCEL_NOTEBOOK: &str = "Ctrl+Alt+M";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 启动期 panic 的原生弹窗钩子:桌面壳的开库/身份/租约全在 Tauri `setup` 闭包里
/// fail-fast panic,窗口尚未建成——默认行为只往 stderr 打一行,双击 exe 的用户什么
/// 都看不到(表现为「没反应」)。这里在崩之前先弹一个原生框把消息给用户看见
/// (最常见:「库版本 vN 比本程序新——请安装新版朱笺」=装了旧包;另有另一实例占
/// writer.lock、空间发现失败等)。仍链到默认钩子,保留 stderr 记录与 backtrace。
///
/// e2e(YS_DB_PATH)刻意不装:测试无人点框,模态框会把用例挂死。
/// (macOS 注记:rfd 的消息框须主线程调;我们关心的启动 panic 都在主线程,后台线程
/// panic 弹框是 macOS 移植时再收的边角,当前 Windows 目标不受影响。)
fn install_panic_dialog_hook() {
    if e2e_db_path().is_some() {
        return;
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 先跑默认钩子:stderr 的 panic 消息 + RUST_BACKTRACE 回溯照旧留着。
        default_hook(info);
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title("朱笺无法启动")
            .set_description(panic_dialog_message(info))
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
    }));
}

/// 从 panic 载荷 + 位置拼出给用户看的消息(载荷可能是 `&str` 或 `String`)。
fn panic_dialog_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    let body = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "未知错误".to_string());
    match info.location() {
        Some(loc) => format!("{body}\n\n(位置:{}:{})", loc.file(), loc.line()),
        None => body,
    }
}

pub fn run() {
    // 启动期 fail-fast panic 不该「窗口没建就静默死」:最先装 panic 弹窗钩子,连下面
    // rustls install 失败都能被用户看见(见 install_panic_dialog_hook 注释)。
    install_panic_dialog_hook();
    // wss:// 的 TLS 提供者(Cargo.toml rustls 依赖注释):启动即装,坏了当场响亮,
    // 不留到用户第一次点「创建账户」才在 async 命令里 panic(promise 永不返回)。
    // 全 app 装一次;严禁每空间/每 transport 再 install_default(§六 codex 核点)。
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("rustls CryptoProvider 已被安装过(依赖漂移?)");
    let mut builder = tauri::Builder::default();
    // app 级单实例门(§六②):必须最先注册、先于一切开库/transport/热键——两个
    // 进程同开多库会争抢同一 origin 的 op 发射序号(oplog 的 UNIQUE 只能响亮崩,
    // 这道门让它不发生;此前仓库无真单实例锁,全局热键注册冲突只是碰巧兜底)。
    // 第二实例被拒时把已运行实例的捕获条召到前台;e2e(YS_DB_PATH)刻意不装——
    // 测试库隔离,且开发者常边开着 dev app 边跑 e2e。
    if e2e_db_path().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 第二实例是被 zhujian:// 链接拉起的:交给 deep-link 插件的 on_open_url 处理
            // (它会唤起主窗+定位条目),这里别再弹捕获条抢焦点。否则(普通再启)照旧弹捕获。
            if argv.iter().any(|a| a.starts_with("zhujian://")) {
                return;
            }
            show_window(app, "capture");
        }));
    }
    builder
        // 深链接(zhujian://open?…):OS 把点击的链接转成 on_open_url(Win/Linux 经上面
        // 带 deep-link 特性的单实例插件转发);接线在 setup。单实例必须先于它注册(已满足)。
        .plugin(tauri_plugin_deep_link::init())
        // 正文链接点击 → 系统默认浏览器(前端 openUrl,只放行 http/https)。
        .plugin(tauri_plugin_opener::init())
        // 客户端自动更新(88):前端 initUpdate 启动静默查更新、提示式装;process 供装后
        // relaunch。updater 端点/公钥在 tauri.conf.json plugins.updater,注册无需额外配置。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 记住主窗几何(57):尺寸/位置/最大化存 app 配置目录的状态文件,重启后
        // 原样回来;首启无状态文件时窗口保持 tauri.conf.json 默认(1040×680 居中)。
        // capture 是每次居中弹出的浮窗,不该被记住位置。e2e(YS_DB_PATH)换单独
        // 文件,免得测试窗口几何与真实布局互相覆盖。
        .plugin({
            let mut ws = tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .with_denylist(&["capture"]);
            if e2e_db_path().is_some() {
                ws = ws.with_filename(".window-state.e2e.json");
            }
            ws.build()
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    // Ctrl+Alt+N(mac: Cmd+Alt+N)→ 弹捕获窗;+M → 唤起笔记本主窗。
                    if shortcut.matches(HOTKEY_MODS, Code::KeyN) {
                        show_window(app, "capture");
                    } else if shortcut.matches(HOTKEY_MODS, Code::KeyM) {
                        open_notebook(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 主库位置:e2e(YS_DB_PATH)显式覆盖并禁扫空间(§六③);生产 = app 数据
            // 目录,主库 notebook.sqlite3 单列保留 + 严格 ULID 白名单发现其余空间。
            // boot 引导临时文件挪 .boot/ 子目录(§六①):不在空间扫描面里,崩溃残留
            // 永不被误认成空间库;与库同卷,快照 VACUUM INTO 免跨盘拷。
            let (main_db, scan_dir) = match e2e_db_path() {
                Some(p) => (p, None),
                None => {
                    let data_dir = app.path().app_data_dir().expect("resolve app data dir");
                    std::fs::create_dir_all(&data_dir).expect("create app data dir");
                    (data_dir.join("notebook.sqlite3"), Some(data_dir))
                }
            };
            // 单写者租约(multispace-plan §5,门 1):先于一切开库/transport。app 层
            // 单实例门只是 UX(e2e 模式还刻意不装),这把 OS 排他锁才是「同目录单
            // 写者」的硬闸——第二进程双写坏的是 HLC 回退 / origin_seq 争号的正确性,
            // 不是本地耐久性。生产锁在数据目录;e2e 按目标库派生独立锁(开着 dev
            // 实例照跑 e2e 互不误伤)。锁文件永不删;句柄 manage 进 app state 持到
            // 进程退出(含被杀,OS 收锁)。
            let lease_path = match &scan_dir {
                Some(dir) => dir.join("writer.lock"),
                None => PathBuf::from(format!("{}.writer.lock", main_db.display())),
            };
            let lease = spaces::WriterLease::acquire(&lease_path).unwrap_or_else(|e| panic!("{e}"));
            app.manage(lease);
            let boot_dir = main_db.parent().expect("库文件必有父目录").join(".boot");
            std::fs::create_dir_all(&boot_dir).expect("create boot dir");
            // #4(codex 二审):清上次进程 kill/crash 残留的明文引导快照;必须在任何空间
            // transport 启动前跑一次(多空间共享 .boot,放进各 transport 的 run() 会互删
            // 别的空间正在传输的快照)。
            sync::transport::sweep_stale_boot_files(&boot_dir);
            // 建库暂存残留(multispace-plan §3):`.creating-*` 从未 rename 归位就
            // 不是空间,启动无条件清(含其 -journal;epoch-plan §7 起并清重置孤儿
            // -wal/-shm)。main 重置续完(§7)必须在发现/装配**之前**——journal 在场
            // = 上次重置未完成,不续完则「main 缺失」会 panic 整个启动。
            if let Some(dir) = &scan_dir {
                // 「加入空间」半途残留的 `.joining-*` 槽严格清扫(space-entry-plan
                // §3.4):槽可能含 K_acc/设备私钥/账户明文,删除失败 = 拒启(不静默)。
                spaces::sweep_stale_joining(dir).unwrap_or_else(|e| panic!("{e}"));
                spaces::sweep_stale_creating(dir);
                match spaces::resume_main_reset(dir) {
                    Ok(false) => {}
                    Ok(true) => eprintln!("INFO 上次 main 空间重置未完成,已续完(fresh 空库)"),
                    Err(e) => panic!("main 空间重置续完失败:{e}"),
                }
            }

            // 发现 → 逐库打开(建库/迁移 + 时钟)→ 四不变量裁决 → 逐空间装配。
            // 任何一步失败都响亮拒启整个 app(fail-fast):库开不了/身份读不出不是
            // 可以静默跳过的状态。四不变量违者不算启动失败——本地照用、只停同步。
            // 桌面主库走 db::open 的迁移正道(升级救活),不吃「exact-match or reset」
            // ——那是手机 catalog 只读扫描的政策(multispace-plan §10)。
            let found = spaces::discover(&main_db, scan_dir.as_deref(), None)
                .unwrap_or_else(|e| panic!("空间发现失败:{e}"));
            let mut opened = Vec::new();
            let mut idents = Vec::new();
            for (id, path) in found {
                let mut conn =
                    db::open(&path).unwrap_or_else(|e| panic!("打开空间 {id} 库失败:{e}"));
                // 同步时钟(sync-plan P1):首启生成永久设备身份 device_id、恢复 HLC
                // 水位;每空间一只(独立库=独立身份),锁序恒为「先库后钟」。
                let mut clk = clock::Clock::load(&conn).expect("init sync clock");
                // 存量空间名补发自愈步(space-name-sync-plan §5):v27 遗留
                // sync_meta['space_name'] → 原子补进 op 流 + 删旧 key;无遗留 = 无事。
                // 时序契约:WriterLease 已持(上方)、transport 未启(下方 activate 才起)。
                spaces::heal_legacy_space_name(&mut conn, &mut clk)
                    .unwrap_or_else(|e| panic!("空间 {id} 存量名补发失败:{e}"));
                // 存量标签排序键自愈(0031):position IS NULL 的标签落末键 + 发 position op
                // (迁移只加 NULL 列、不回填,见 0031 头注)。同上时序契约:WriterLease 下、
                // transport 未启;幂等,无 NULL 行则无事。
                notes::heal_legacy_topic_positions(&mut conn, &mut clk)
                    .unwrap_or_else(|e| panic!("空间 {id} 存量标签排序自愈失败:{e}"));
                idents.push(
                    spaces::read_identity(&id, &path, &conn, &clk)
                        .unwrap_or_else(|e| panic!("读空间 {id} 身份失败:{e}")),
                );
                opened.push((id, path, conn, clk));
            }
            let mut vetoes = spaces::identity_vetoes(&idents);
            // hard(同一物理库的第二个名字)不装载:第二条连接 + 第二只同身份时钟
            // 会破坏「进程内单写者」,连本地写都不能给;切换器仍列出它说明原因。
            // soft(整库复制的同 device / 同账户)装载但停同步,本地照用。
            // core 的 Veto 只给诊断,处置话术在这里拼——「不装载/停同步照用」是桌面
            // 的容忍政策;手机严格 catalog 对同样的诊断说的是「清库重配」(工序 6)。
            let mut dead = Vec::new();
            let mut live = Vec::new();
            for (id, path, conn, clk) in opened {
                match vetoes.remove(&id) {
                    Some(spaces::Veto::Hard(reason)) => {
                        drop(conn);
                        let reason = format!("{reason},此空间未装载;请把该文件移出数据目录");
                        dead.push(spaces::DeadSpace { id, reason });
                    }
                    Some(spaces::Veto::Soft(reason)) => {
                        let reason = format!("{reason};已停用此空间的同步(本地照常可用)");
                        live.push((id, path, conn, clk, Some(reason)));
                    }
                    None => live.push((id, path, conn, clk, None)),
                }
            }
            // supervisor(core):live 会话唯一真相源;桌面 max_live = usize::MAX
            // 即 eager 全连所有发现的空间(不设上限)。transport 任务跑在 tauri
            // 内置的 tokio 上(单变体 enum,解构即拿句柄)。
            let tauri::async_runtime::RuntimeHandle::Tokio(rt_handle) = tauri::async_runtime::handle();
            let table = Spaces::new(
                SpaceSupervisor::new(rt_handle, spaces::DESKTOP_MAX_LIVE),
                scan_dir,
                boot_dir.clone(),
                dead,
            );
            for (id, path, conn, clk, veto) in live {
                activate_space(app.handle(), &table, id, path, conn, clk, veto)
                    .unwrap_or_else(|e| panic!("装配空间 runtime 失败:{e}"));
            }
            app.manage(table);
            // 前台空间(工序 8,§9):启动恒 main;notebook 前端恢复上次空间时会
            // 立即 set_foreground_space 对齐。
            app.manage(ForegroundSpace(Mutex::new(spaces::MAIN_SPACE.to_string())));

            // 深链接(4b OS 桥):暂存位 + scheme 注册 + on_open_url 接线。
            app.manage(PendingDeepLink(Mutex::new(None)));
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Win/Linux 每次启动自注册 zhujian://(指向当前 exe):比「只靠安装器注册」更稳
                // ——移动/复制安装、便携运行都能自愈,scheme 恒指向正在跑的这个。e2e 用独立库、
                // 刻意不注册,免污染机器的 scheme 关联。macOS 由 Info.plist 声明,无需运行期注册。
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                if e2e_db_path().is_none() {
                    let _ = app.deep_link().register_all();
                }
                // 冷启动:被链接拉起时 URL 在启动 argv。运行期注册的 scheme 必须自己查 argv
                // (插件文档明载:get_current 对 runtime-registered scheme 冷启动不可靠,须读
                // Env::args)。前端启动时 consume_deep_link 取走它。
                if let Some(u) = std::env::args().find(|a| a.starts_with("zhujian://")) {
                    *app.state::<PendingDeepLink>().0.lock().expect("deep-link mutex poisoned") =
                        Some(u);
                }
                // 热启动:app 已在跑再点链接 → 暂存 + 唤起主窗 + 通知前端来取。
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    if let Some(u) = event
                        .urls()
                        .into_iter()
                        .map(|u| u.to_string())
                        .find(|s| s.starts_with("zhujian://"))
                    {
                        *handle
                            .state::<PendingDeepLink>()
                            .0
                            .lock()
                            .expect("deep-link mutex poisoned") = Some(u);
                        open_notebook(&handle);
                        let _ = handle.emit("deep-link-open", ());
                    }
                });
            }

            // Global hotkeys: Ctrl+Alt+N summons capture from anywhere; Ctrl+Alt+M
            // summons the notebook on whatever view it was left on. (The tray still
            // opens the notebook too — these just add a from-anywhere shortcut.)
            app.global_shortcut()
                .register(Shortcut::new(Some(HOTKEY_MODS), Code::KeyN))?;
            app.global_shortcut()
                .register(Shortcut::new(Some(HOTKEY_MODS), Code::KeyM))?;

            // The notebook is the single browse/manage window — a panel, not a
            // doc. Closing it should hide it (so the next summon works), not
            // destroy it. (capture has no such handler — it's always re-shown.)
            let notebook = app
                .get_webview_window("notebook")
                .expect("notebook window must exist");
            let notebook_for_close = notebook.clone();
            // 几何防抖落盘:拖动/缩放是高频事件,不能每次写盘。事件送进 channel,一个
            // 长驻后台线程吸收连续事件、静默 600ms 后落一次盘。为什么需要它:插件只在
            // RunEvent::Exit / 关窗两个时机写盘,但重装用 TerminateProcess 硬杀实例,
            // 两个时机都不触发——自上次关窗以来的移动/缩放只躺在插件内存缓存里、随进程
            // 一起丢(症状:重装后窗口回到旧位置或配置默认,而非重装前的现场)。
            let (geom_tx, geom_rx) = std::sync::mpsc::channel::<()>();
            {
                let app_geom = notebook.app_handle().clone();
                std::thread::spawn(move || {
                    while geom_rx.recv().is_ok() {
                        // 收到一个事件后持续吸收后续事件,直到 600ms 无新动静才落盘。
                        while geom_rx
                            .recv_timeout(std::time::Duration::from_millis(600))
                            .is_ok()
                        {}
                        // save_window_state 要读窗口几何(tao 要求主线程),从后台线程直调会
                        // 失败;调度到主线程执行(CloseRequested 那次本就在主线程,故无需)。
                        let app_save = app_geom.clone();
                        let _ = app_geom.run_on_main_thread(move || {
                            let _ = app_save.save_window_state(WINDOW_STATE_FLAGS);
                        });
                    }
                });
            }
            notebook.on_window_event(move |event| match event {
                // 关窗即存一次几何(别赌干净退出:常驻托盘、可能强杀/断电)。存失败不致命。
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = notebook_for_close
                        .app_handle()
                        .save_window_state(WINDOW_STATE_FLAGS);
                    let _ = notebook_for_close.hide();
                }
                // 移动/缩放:防抖落盘(见上)。send 失败(防抖线程已退出)无害。
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    let _ = geom_tx.send(());
                }
                _ => {}
            });

            // Tray: capture is the heartbeat (also Ctrl+Alt+N); the notebook
            // holds everything else (inbox/tasks/topics/search), reached from
            // inside it.
            // The accelerator strings are DISPLAY-ONLY hints in the tray popup — the keys
            // themselves are owned by the global_shortcut plugin above (a tray context menu
            // installs no keyboard handler), so this can't double-register / conflict.
            let show_item =
                MenuItem::with_id(app, "show", "记录灵感", true, Some(ACCEL_CAPTURE))?;
            let notebook_item =
                MenuItem::with_id(app, "notebook", "打开朱笺", true, Some(ACCEL_NOTEBOOK))?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &notebook_item, &quit_item])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("default icon").clone())
                .menu(&menu)
                // 托盘左键行为分平台:Windows 惯例左键不弹菜单(留给下面 DoubleClick 开主窗,
                // 否则双击会先被单击的弹菜单截走);macOS 惯例状态栏图标左键即弹菜单——mac 上
                // DoubleClick 根本不触发(真机冒烟证实),双击/左键开窗那套是死的,靠菜单进主窗。
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app, "capture"),
                    "notebook" => open_notebook(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                // 双击托盘 = 打开主窗(Windows 托盘「默认动作」惯例);右键仍弹上面的菜单。
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        open_notebook(tray.app_handle());
                    }
                })
                .build(app)?;

            // Show capture once on launch so the first run is discoverable.
            show_window(app.handle(), "capture");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_note,
            set_foreground_space,
            get_foreground_space,
            consume_deep_link,
            list_inbox,
            list_processed,
            list_ideas,
            idea_stats,
            locate_item,
            list_archived,
            list_topic_tree,
            search_notes,
            delete_note,
            archive_note,
            restore_note,
            purge_note,
            purge_archived,
            list_tasks,
            list_archived_tasks,
            update_task_status,
            reorder_task,
            reorder_task_visible,
            archive_task,
            restore_task,
            purge_task,
            purge_archived_tasks,
            seal_task,
            seal_done_tasks,
            unseal_task,
            list_sealed_tasks,
            create_task,
            rename_task,
            set_task_due,
            set_task_priority,
            add_task_topic,
            remove_task_topic,
            edit_note,
            list_note_history,
            promote_note_to_task,
            revert_task_to_inbox,
            list_topics,
            list_topics_full,
            create_topic,
            update_topic,
            set_topic_color,
            reorder_topic,
            set_topic_kind,
            delete_topic,
            file_note_to_topic,
            remove_note_topic,
            merge_topics,
            add_item_image,
            list_item_images,
            get_item_image,
            delete_item_image,
            sync_status,
            sync_create_account,
            sync_pair_start,
            sync_pair_join,
            join_space,
            join_space_cancel,
            sync_set_server,
            sync_recovery_code,
            list_spaces,
            create_space,
            reset_space,
            rename_space,
            move_item_to_space
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// space-entry-plan §2 后端不变量:sync_pair_join 只接受 main——直接 invoke
    /// 非 main 必拒(不许只测按钮隐藏);main 照常放行(装机 onboarding 不变)。
    #[test]
    fn pair_join_gate_rejects_non_main() {
        assert!(pair_join_target_gate(spaces::MAIN_SPACE).is_ok());
        let err = pair_join_target_gate("01JT0000000000000000000000").unwrap_err();
        assert!(err.contains("加入空间"), "拒绝话术要指路新入口:{err}");
    }
}
