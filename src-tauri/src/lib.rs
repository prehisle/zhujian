// P4-a(android-plan §1):数据层 + 同步客户端全在共享 crate zhujian-core(../core),
// 本 crate 只剩 tauri 壳——命令面 / 托盘 / 窗口 / setup + SyncEvent→emit 事件桥。
// 97(sync-plan §六):桌面多空间——空间 = 账户 = 独立同步流 = 独立库,命令面显式
// space_id;空间的存在与身份(发现/白名单/四不变量)见 spaces.rs,本文件负责装配
// (逐空间 spawn transport + 事件贴空间标)与命令面。
mod spaces;
// 测试容器目录(per-pid,progress-log 326);测试之外无人调用。
#[cfg(test)]
mod test_temp;
// macOS Dock 右键菜单(macos-port-plan §2):往 tao 的 NSApplicationDelegate 补
// applicationDockMenu:,整块 objc 关在这个平台专属模块里。
#[cfg(target_os = "macos")]
mod dock_menu;

use spaces::Spaces;
use zhujian_core::sync::supervisor::{ActivateSpec, ActiveRuntime as SpaceRuntime, SpaceSupervisor};
use zhujian_core::{clock, comments, db, identity, images, notes, repo, sync, task, thumbs};

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::Connection;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags};

/// 主窗几何要记的维度:尺寸/位置/最大化。刻意不含 VISIBLE——启动仪式默认
/// 「只弹捕获条、主窗被召唤才现身」,重启恢复的是「现身时的样子」而不是
/// 「要不要现身」;无边框固定窗也用不上 DECORATIONS/FULLSCREEN。
/// (411/D1 起「要不要现身」多了一条**按数据显形**的例外:空库首用时主窗也显一次,
/// 见 `setup` 尾部——判据是当下库里有没有条目,同样不落盘、不进这份几何状态。)
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
    /// 出生设备(0033 born_device),null = 未知(0033 前的存量行)。前端经 `device_identity`
    /// 的名册翻成别名显一枚署名 chip;**只在「不是本机」且「那台起过别名」时显**,其余
    /// 一律不显(identity-plan §3.7 + 2026-08-05 用户拍板:未命名设备不显 id 片段)。
    /// 回收站视图拿到同一份数据但不渲染它(署名在「已处理完」的语境里价值低噪音高)。
    born_device: Option<String>,
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
            born_device: n.born_device,
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
            born_device: n.born_device,
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
            born_device: n.born_device,
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
    /// 创建时刻(RFC3339,461)。看板「时间」筛选轴据它分桶——同 due_on 的哲学,
    /// 后端只搬运时刻字符串,「近1天/近7天/7天前」的本地日历日换算全在前端。
    created_at: String,
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
    /// 出生设备(0033 born_device),显示规则同 [`ProcessedItem::born_device`]。
    born_device: Option<String>,
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
            created_at: t.created_at,
            due_on: t.due_on,
            priority: t.priority,
            sealed_at: t.sealed_at,
            done_at: t.done_at,
            born_device: t.born_device,
            topics,
        }
    }
}

/// 一列看板列的当前态(board-columns-plan §2.1 的 read model 原样透传)。
///
/// ⛔ **前端别再自己拼一份「有哪几列」** —— 不变量 3(「灵感态 vs 任务态由列的 `kind`
/// 说了算」)的唯一正式子在 core(`board::list_columns`),这里只是搬运。
#[derive(Serialize)]
struct BoardColumn {
    id: String,
    /// 同步来的原文。⚠ **`title_overridden == false` 时它不是要显示的字符串** ——
    /// 那时按 `id` 查本端字典(§7.1d:canonical 串只活在迁移 SQL 与 `SEED_COLUMNS` 两处)。
    title: String,
    /// `idea` | `task`。灵感视图取前者,看板取后者。
    kind: String,
    /// 系统列(灵感那两列):不可改名、不可删(不变量 2)。
    system: bool,
    /// §7.1d 的终态判据。`false` ⇒ 前端按 `id` 查字典。
    title_overridden: bool,
    /// 已删 = 只读收容区(§4.3):卡只出不进,列身仍要画出来,否则卡就「不见了」。
    deleted: bool,
    /// 该列上未归档未封存的条目数(删列前的「先清空」提示与「已删除的列(N)」都用它)。
    live_items: i64,
    /// 这一列**允许**被删吗(480 定案)。⚠ 不是「现在能不能删」——非空还要先清空。
    deletable: bool,
}

impl From<zhujian_core::board::BoardColumnRow> for BoardColumn {
    fn from(c: zhujian_core::board::BoardColumnRow) -> Self {
        // `position` 刻意不出壳:读序已由 core 按 `(position, id)` 排好,给了前端只会诱使
        // 它再排一次(0022:同键并列是合法结局)。
        BoardColumn {
            id: c.id,
            title: c.title,
            kind: c.kind,
            system: c.system,
            title_overridden: c.is_title_overridden,
            deleted: c.deleted,
            live_items: c.live_items,
            deletable: c.deletable,
        }
    }
}

/// 全部看板列(**含已删的**),已按 `(position, id)` 排好。
///
/// ⚠ 一次全量返回、不分「活的 / 删的」两趟:分趟只会给 UI 造出第二份口径,
/// 要哪一族由前端按 `kind` / `deleted` 分(`board::list_columns` 头注)。
#[tauri::command]
fn list_board_columns(space_id: String, spaces: State<'_, Spaces>) -> Result<Vec<BoardColumn>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let rows = zhujian_core::board::list_columns(&conn).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(BoardColumn::from).collect())
}

// ---- 列管理面(B-f 第 2 段,**纯桌面**:安卓只做读侧,2026-08-25 用户拍板) ------------
//
// ⭐ 四条写命令一条不少地照 `notes::*_topic` 那五条的形:取写锁 → 锁内复核 ReopenRequired →
// **锁内现采** `RuntimeFacts` → 调 core。⛔ 三件事一件都不许省:
//
// * `RuntimeFacts` 是 core 那道发送端闸的必填参数(board-columns-plan §5.6a-4),生产唯一
//   产法是 `observe` —— ⛔ 壳里不许用 `detached()`(那等于把闸关掉);
// * 「在写锁内采」的理由与 `update_task_status` 那句 ReopenRequired 复核同源(codex 二轮 M2:
//   锁前查有「查后置位抢锁」竞态)。诚实边界照旧:`config_transition_in_flight` 由 `lifecycle`
//   那条路置位,与本空间的写锁不互斥 ⇒ 「刚采完、转换才开始」那个窗口仍在(plan §5.6a 末);
// * 每道拒绝的人话一律由 core 出(`String(e)` 原样透传给前端)。⛔ 壳不加工、不翻译、
//   不补第二套说法 —— 「按钮为什么灰」与「点下去为什么失败」必须是同一句(gate.rs 那两枚 const)。

/// 新建一个任务列(落在最右)。返回新列 id。
#[tauri::command]
fn create_board_column(space_id: String, title: String, spaces: State<'_, Spaces>) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    let facts = zhujian_core::board::gate::RuntimeFacts::observe(&spaces.sup, &space_id);
    zhujian_core::board::create_column(&mut conn, &mut clk, &title, &facts)
}

/// 给一列改名。系统列(灵感那两列)与已删的列由 core 拒。
#[tauri::command]
fn rename_board_column(space_id: String, id: String, title: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    let facts = zhujian_core::board::gate::RuntimeFacts::observe(&spaces.sup, &space_id);
    zhujian_core::board::rename_column(&mut conn, &mut clk, &id, &title, &facts)
}

/// 把一列拖到两个邻居之间(`prev_id`/`next_id`,None = 真·列端边界)。形同 `reorder_topic`。
#[tauri::command]
fn reorder_board_column(
    space_id: String,
    id: String,
    prev_id: Option<String>,
    next_id: Option<String>,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    let facts = zhujian_core::board::gate::RuntimeFacts::observe(&spaces.sup, &space_id);
    zhujian_core::board::reorder_column(&mut conn, &mut clk, &id, prev_id.as_deref(), next_id.as_deref(), &facts)
}

/// 删一列 = 盖墓碑(行永不物理删除)。系统列 / 角色列 / 非空列由 core 逐条响亮拒。
#[tauri::command]
fn delete_board_column(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    let facts = zhujian_core::board::gate::RuntimeFacts::observe(&spaces.sup, &space_id);
    zhujian_core::board::delete_column(&mut conn, &mut clk, &id, &facts)
}

/// 发送端闸此刻放不放行(列管理面据它决定给不给写入口、灰的理由是哪一句)。
#[derive(Serialize)]
struct BoardColumnGate {
    can_manage: bool,
    /// 拒的那句人话,**core 出的原文**;放行时 null。
    reason: Option<String>,
    /// 机器可读的拒因。⭐ 前端**只**据它决定要不要在 `reason` 后面再接一句补充说明,
    /// ⛔ 别去 match 中文文案(482 自曝 ②:靠错误文案当判据比结构断言脆)。
    blocked_by: Option<&'static str>,
}

/// 「现在能不能管理列」——**只读**探针(board-columns-plan §8 那行)。
///
/// ⛔ **它绝不会立闩**:走的是 core 那条无副作用的 `gate::explain`,而不是把
/// `ensure_can_emit` 包一层(那会让「打开一次列管理面」变成闩的第二条置位路径,
/// 与 2026-08-25 用户拍板② 直接打架)。理由全文在 `core/src/board/gate.rs` 的 `explain` 头注。
///
/// ⚠ **答的是问的那一刻**:真正的授权永远是四条写命令自己事务里的那道闸。
#[tauri::command]
fn board_column_gate(space_id: String, spaces: State<'_, Spaces>) -> Result<BoardColumnGate, String> {
    use zhujian_core::board::gate::GateVerdict;
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let facts = zhujian_core::board::gate::RuntimeFacts::observe(&spaces.sup, &space_id);
    let verdict = zhujian_core::board::gate::explain(&conn, &facts)?;
    Ok(BoardColumnGate {
        can_manage: matches!(verdict, GateVerdict::Open),
        reason: verdict.reason().map(str::to_string),
        blocked_by: match verdict {
            GateVerdict::Open => None,
            GateVerdict::ShutByConfigTransition => Some("config_transition"),
            GateVerdict::ShutUntilPeersUpgrade => Some("peers"),
        },
    })
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    // 发送端闸的运行期事实(board-columns-plan §5;B-e 第 1 段)。**在写锁内现采**,
    // 与上面那句 ReopenRequired 复核同一个理由(codex 二轮 M2:锁前查有「查后置位抢锁」
    // 竞态)。⚠ 诚实边界:`config_transition_in_flight` 由 `lifecycle` 锁那条路置位,
    // 与本空间的写锁不互斥 ⇒ 「刚采完、转换才开始」这个窗口仍在。§5.6 的顺序(**先置位、
    // 再 retire**)与 supervisor 那条既有裁决(「切换/停机与业务写的互斥由壳编排」)一起
    // 承重,⛔ 别为它新造第三把锁。
    let facts = zhujian_core::board::gate::RuntimeFacts::observe(&spaces.sup, &space_id);
    task::transition(&mut conn, &mut clk, &id, &to, &facts)
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    // 发送端闸的运行期事实(board-columns-plan §5;B-e 第 1 段)。**在写锁内现采**,
    // 与上面那句 ReopenRequired 复核同一个理由(codex 二轮 M2:锁前查有「查后置位抢锁」
    // 竞态)。⚠ 诚实边界:`config_transition_in_flight` 由 `lifecycle` 锁那条路置位,
    // 与本空间的写锁不互斥 ⇒ 「刚采完、转换才开始」这个窗口仍在。§5.6 的顺序(**先置位、
    // 再 retire**)与 supervisor 那条既有裁决(「切换/停机与业务写的互斥由壳编排」)一起
    // 承重,⛔ 别为它新造第三把锁。
    let facts = zhujian_core::board::gate::RuntimeFacts::observe(&spaces.sup, &space_id);
    task::reorder(
        &mut conn,
        &mut clk,
        &id,
        &from_status,
        &to_status,
        &base_target_ids,
        &ordered_ids,
        &facts,
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    // 发送端闸的运行期事实(board-columns-plan §5;B-e 第 1 段)。**在写锁内现采**,
    // 与上面那句 ReopenRequired 复核同一个理由(codex 二轮 M2:锁前查有「查后置位抢锁」
    // 竞态)。⚠ 诚实边界:`config_transition_in_flight` 由 `lifecycle` 锁那条路置位,
    // 与本空间的写锁不互斥 ⇒ 「刚采完、转换才开始」这个窗口仍在。§5.6 的顺序(**先置位、
    // 再 retire**)与 supervisor 那条既有裁决(「切换/停机与业务写的互斥由壳编排」)一起
    // 承重,⛔ 别为它新造第三把锁。
    let facts = zhujian_core::board::gate::RuntimeFacts::observe(&spaces.sup, &space_id);
    task::reorder_visible(
        &mut conn,
        &mut clk,
        &id,
        &from_status,
        &to_status,
        &base_visible_ids,
        &visible_after,
        &facts,
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
    fg: State<'_, ForegroundSpace>,
) -> Result<String, String> {
    // 与 capture_note 对齐(捕获浮窗 /task 可建任务):落库目标必须仍是前台空间——
    // 保存往返期间 notebook / 捕获窗切走空间的话响亮拒,绝不把任务建进别的空间。
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    task::add_topic(&mut conn, &mut clk, &id, &topic_id)
}

/// 给任务按标题挂标签(同名复用、缺则新建,core 单事务原子;codex 120 设计审 M9:
/// 禁 create_topic+add_task_topic 两步——半途失败留空标签)。返回标签 id。
/// 与安卓 `add_task_topic_by_title` 同名同义(386 可优化项第③条:同一个判据原先只在安卓那端执行)。
#[tauri::command]
fn add_task_topic_by_title(
    space_id: String,
    id: String,
    title: String,
    spaces: State<'_, Spaces>,
) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2:旗与导入共
    // 临界区,排队在锁上的写拿到锁时旗必已在;锁前查有「查后落旗抢锁」竞态)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    task::add_topic_by_title(&mut conn, &mut clk, &id, &title)
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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

/// 缩略图响应(image-perf-plan §3.2):`thumb=false` 表示未命中、`url` 是全尺寸,
/// 前端该自己缩一次再回存(规格 token 不出 core,见 `get_item_thumb`)。
#[derive(serde::Serialize)]
struct ThumbData {
    url: String,
    thumb: bool,
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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

/// 一张图的**缩略图**(image-perf-plan §3.2)。命中本地派生表就只吐几 KB;未命中吐全尺寸
/// (维持今天的行为,首次不比现在慢),前端算完再走 `put_item_thumb` 回存。
///
/// 规格 token 不出 core(299 codex 实现审):让前端往返搬运它并不能证明前端那边的
/// 144/q0.8 与它一致,是伪契约。命中判定归 `thumbs::get`,回存打标归 `thumbs::put`。
#[tauri::command]
fn get_item_thumb(space_id: String, image_id: String, spaces: State<'_, Spaces>) -> Result<ThumbData, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    if let Some(bytes) = thumbs::get(&conn, &image_id).map_err(|e| e.to_string())? {
        return Ok(ThumbData {
            url: format!("data:{};base64,{}", thumbs::THUMB_MIME, STANDARD.encode(&bytes)),
            thumb: true,
        });
    }
    let (bytes, mime) = repo::item_image_data(&conn, &image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("图片不存在:{image_id}"))?;
    Ok(ThumbData {
        url: format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)),
        thumb: false,
    })
}

/// 回存一张算好的缩略图(惰性填充)。纯本地派生:不发 op、不动时钟,故只取库锁。
/// 失败对前端无害(下次再算),但后端一律响亮 —— 别把「存不进去」和「存进了脏字节」搞混。
#[tauri::command]
fn put_item_thumb(
    space_id: String,
    image_id: String,
    data_b64: String,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    // 先按**编码长度**拒,再解码(299 codex 实现审 L3):否则「128 KiB 上界」是在
    // 解完整串之后才生效的,中间那一份无界内存已经吃下去了。
    if data_b64.len() > thumbs::MAX_THUMB_B64_CHARS {
        return Err(format!(
            "缩略图数据过长({} 字符,上限 {}),拒绝回存",
            data_b64.len(),
            thumbs::MAX_THUMB_B64_CHARS
        ));
    }
    let bytes = STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("缩略图数据解码失败:{e}"))?;
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    // 与其余写命令同纪律:ReopenRequired 复核在锁内(space-entry-plan §3.2)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    thumbs::put(&conn, &image_id, &bytes)
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    images::remove(&mut conn, &mut clk, &image_id)
}

// ---- 条目留言(identity-plan §4;第②笔命令面)-------------------------------
//
// **DTO 直接用 core 的 `comments::Comment` / `CommentPage`,壳里刻意不再抄一份**:
// §4.14.2 第 1 条要求两壳命令契约同源,而「同源」若靠两个壳各写一份结构体去维持,
// 就是纪律不是事实。这里让两壳返回同一个类型,漂移在编译期就不可能发生。
// (壳自定义 DTO 的既有先例——ImageMeta / DeviceEntryItem——都是要挑列或改口径;
// 留言这四个命令一个字段都不改口径。)

/// 写一条留言(identity-plan §4.3 第 8 条)。正文长度 / 非空 / 宿主在 / 500 软闸
/// 四道校验全在 `comments::add` 的同一个事务里,壳不复述也不预判——预判会造出
/// 「壳说行、库说不行」的两套判据。
#[tauri::command]
fn add_item_comment(
    space_id: String,
    item_id: String,
    content: String,
    spaces: State<'_, Spaces>,
) -> Result<String, String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    comments::add(&mut conn, &mut clk, &item_id, &content)
}

/// 销毁一条留言(**不进回收站** —— 用户 2026-08-06 拍板;UI 两拍确认兜)。
/// 行不在 = 幂等 no-op(另一端删了并同步过来是正常并发,不是错误)。
#[tauri::command]
fn delete_item_comment(space_id: String, id: String, spaces: State<'_, Spaces>) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    comments::remove(&mut conn, &mut clk, &id)
}

/// 一页留言(最近优先)。`cursor` = 上一页的 `next_cursor`,null = 第一页。
/// **分页是后端契约的一部分,壳不许改成「一次拉全部」**(§4.6.2:软闸下也能一次
/// 拉约 98 MiB 过 IPC/DOM)。
#[tauri::command]
fn list_item_comments(
    space_id: String,
    item_id: String,
    cursor: Option<(String, String)>,
    spaces: State<'_, Spaces>,
) -> Result<comments::CommentPage, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let cur = cursor.as_ref().map(|(ca, id)| (ca.as_str(), id.as_str()));
    comments::list_for_item(&conn, &item_id, cur)
}

/// 每条目徽章聚合(留言数 + 未读,0038):一次 `GROUP BY` 聚合读,**不 N+1**;零留言
/// 的条目不在返回里(前端按 0 处理 —— N=0 不显示徽章)。徽章与列表是两个真相源
/// (§4.14.2 第 4 条):这里只回聚合,别为了「对齐」去全量拉留言正文。
#[tauri::command]
fn item_comment_counts(
    space_id: String,
    spaces: State<'_, Spaces>,
) -> Result<std::collections::HashMap<String, comments::CommentBadge>, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    comments::counts_all(&conn)
}

/// 推进一条条目的留言已读水位(0038):留言面第一页渲染成功后带上页首那条的 id。
/// 纯本地簿记:不发 op、不动时钟,故只取库锁(同 put_item_thumb 的形)。
#[tauri::command]
fn mark_item_comments_seen(
    space_id: String,
    item_id: String,
    seen_id: String,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    // 与其余写命令同纪律:ReopenRequired 复核在锁内(space-entry-plan §3.2)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    comments::mark_seen(&conn, &item_id, &seen_id)
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
            "这个账户正在(或刚刚)被「加入空间」使用——空间=账户,一空间一账户;若刚才加入失败,重启朱简后再试"
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
    // ⭐ **配置转换 veto**(board-columns-plan §5.6):这段时间里**全部空间**都不许发
    // 自定义 stage / `board_column` op。⛔ 不新造锁 —— 互斥仍由上面那把既有的
    // `lifecycle`(multispace-plan §4 的 account-binding mutex)提供,这一句只是把
    // 「那把锁此刻被持着」投影进 core,好让 core 侧的写闸看得见。释放走 RAII,
    // 成功 / 失败 / panic 三条路一视同仁(⛔ 不许靠谁记得清)。
    let _config_transition = spaces.sup.begin_config_transition();
    // ReopenRequired 复核在 lifecycle 取得之后(codex 二轮 M2:等待锁期间旗可能落下)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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

/// 设备管理(identity-plan §5.3 三句话:移除别人要管理位、任何设备都能移除自己、
/// 设/取消管理位要管理位)。判定与执行全在服务器上 —— 本命令只是把一枚签好名的
/// `DeviceAdmin` 送出去并等回执,**本地一个字节都不写**(§5.2)。
///
/// `action` 的 DTO **直接用 core 那个枚举**,不在这儿再写一张字符串映射表:多一份
/// 映射就多一处会漂的抄写点,而它与线上 CBOR 变体名同源是编译期事实。前端传
/// `"Remove"` / `"GrantAdmin"` / `"RevokeAdmin"`,认不出由 serde 当场拒。
#[tauri::command]
async fn sync_device_admin(
    space_id: String,
    device_id: String,
    action: sync::transport::DeviceAction,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get_writable(&space_id)?;
    if let Some(v) = rt.veto() {
        return Err(v);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    rt.control
        .send(sync::transport::Control::DeviceAdmin { target: device_id, action, reply: tx })
        .await
        .map_err(|_| "同步任务未运行".to_string())?;
    // 超时所有权在 core(§5.7:`DEVICE_ADMIN_DEADLINE` 一次服务器往返);这里 30s 只兜
    // 「发送在死链路上挂死」。⚠ 断连那句必须如实 —— 命令**可能已经在服务器上执行了**,
    // UI 的义务是重连后以新名册为准,不是重试(§5.7-5)。
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("连接断开,未能确认是否已生效".into()),
        Err(_) => Err("服务器未在预期时间内回执,请稍后重试".into()),
    }
}

/// 拉一枚当前设备名册(§5.4)。**回执只说成功与否,名单从 `sync_status.roster` 读**
/// —— core 那一侧保证「回执到手时状态面已含本轮」(状态面先写、再结账;实现审弹三 M2
/// 打掉了我原来那个「回执自带名单」的形:它把一道窗口换成了两个无法排序的数据出口)。
#[tauri::command]
async fn sync_roster_refresh(
    space_id: String,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get_writable(&space_id)?;
    if let Some(v) = rt.veto() {
        return Err(v);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    rt.control
        .send(sync::transport::Control::RosterRefresh { reply: tx })
        .await
        .map_err(|_| "同步任务未运行".to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("连接断开,未能取得设备名单".into()),
        Err(_) => Err("获取设备名单超时,请重试".into()),
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
    // ⭐ **配置转换 veto**(board-columns-plan §5.6):这段时间里**全部空间**都不许发
    // 自定义 stage / `board_column` op。⛔ 不新造锁 —— 互斥仍由上面那把既有的
    // `lifecycle`(multispace-plan §4 的 account-binding mutex)提供,这一句只是把
    // 「那把锁此刻被持着」投影进 core,好让 core 侧的写闸看得见。释放走 RAII,
    // 成功 / 失败 / panic 三条路一视同仁(⛔ 不许靠谁记得清)。
    let _config_transition = spaces.sup.begin_config_transition();
    // ReopenRequired 复核在 lifecycle 取得之后(codex 二轮 M2:等待锁期间旗可能落下)。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
    // ⚠ **必须是凭证形而不是裸取**(§16.3.2):集成段要把同一枚 permit 一路带到共享
    // helper;保留裸 guard、到 helper 前再取一次凭证 = **自锁**。
    let permit = spaces.lock_lifecycle().await;
    // ⭐ **配置转换 veto**(board-columns-plan §5.6):这段时间里**全部空间**都不许发
    // 自定义 stage / `board_column` op。⛔ 不新造锁 —— 互斥仍由上面那把既有的
    // `lifecycle`(multispace-plan §4 的 account-binding mutex)提供,这一句只是把
    // 「那把锁此刻被持着」投影进 core,好让 core 侧的写闸看得见。释放走 RAII,
    // 成功 / 失败 / panic 三条路一视同仁(⛔ 不许靠谁记得清)。
    let _config_transition = spaces.sup.begin_config_transition();
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
            Err(c) => format!("{e};且暂存清理失败(重启朱简后自动清理):{c}"),
        });
    }

    // Paired → BootCommitted:staging 库上跑完整 Transport::run(§3.2 装配写死:
    // Full / 不当源 / 保留 control sender / 独立 shutdown / 共享 latch)。
    let status = Arc::new(Mutex::new(sync::transport::SyncStatus::default()));
    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel();
    let (ctl_tx, ctl_rx) = tokio::sync::mpsc::channel(8);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (notice_tx, mut notice_rx) = tokio::sync::oneshot::channel();
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
        // staging 不在 supervisor 的表里,没有壳侧写闸在读这两格(board-columns-plan
        // §5.4:那条一次性连接天然属 detached)⇒ 给一枚没人订阅的位、一张没人读的表。
        engine_present: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        peer_caps: Arc::new(sync::transport::PeerCaps::default()),
        // staging(「加入空间」的一次性连接)不是一个 live 空间,不进准入表。
        lan: None,
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
    progress("booting", 0, 0);

    enum Waited {
        Committed(sync::transport::BootCommitNotice),
        Cancelled,
        TransportGone(String),
        GaveUp(String),
    }
    // ⭐ **事件在本地循环里看,不再另起转发任务**(用户面 34;⛔ 与 `mobile` 那只
    // `coord.rs::join_space` **同一个形、同一份判据** —— 两只壳的 join 编排逐格同形,
    // 各写一份收场判据 = 保证漂移,故判据住在 `transport::JoinBootWatch`)。
    let mut watch = sync::transport::JoinBootWatch::new();
    let silence = tokio::time::sleep(sync::transport::JoinBootWatch::silence_window());
    tokio::pin!(silence);
    let waited = loop {
        // biased 且提交臂恒在最前:BootCommitted 与取消 / 收场同时就绪时只走成功那一次
        // (§3.2;first-draft-checklist 第 10 条)。
        tokio::select! {
            biased;
            n = &mut notice_rx => break match n {
                Ok(notice) => Waited::Committed(notice),
                Err(_) => Waited::TransportGone("同步会话意外退出".into()),
            },
            _ = cancel_rx.wait_for(|v| *v) => break Waited::Cancelled,
            ev = ev_rx.recv() => {
                // 通道关 = transport 已退。⚠ 必须收场不许 continue:关掉的通道恒就绪
                // 回 None,`continue` 会把这个 loop 变成忙等。
                let Some(ev) = ev else {
                    break Waited::TransportGone("同步会话意外退出".into());
                };
                if let sync::transport::SyncEvent::BootProgress { received, total } = &ev {
                    progress("booting", *received, *total);
                }
                match watch.on_event(&ev) {
                    sync::transport::JoinBootVerdict::Keep => {}
                    sync::transport::JoinBootVerdict::KeepAndRefresh => {
                        let next = tokio::time::Instant::now()
                            + sync::transport::JoinBootWatch::silence_window();
                        silence.as_mut().reset(next);
                    }
                    sync::transport::JoinBootVerdict::GiveUp(why) => break Waited::GaveUp(why),
                }
            }
            _ = &mut silence => break Waited::GaveUp(watch.on_silence()),
        }
    };
    let notice = match waited {
        Waited::Committed(n) => n,
        Waited::Cancelled => {
            stop_staging(&shutdown_tx, staging_task).await;
            return Err(match slot.abort() {
                Ok(()) => {
                    release_join_reservation(spaces, &reserved);
                    // 不过度承诺(§7):Enroll 已发的取消会在账户侧留孤儿设备,
                    // 多次孤儿可能触发设备上限——如实指路,不保证无条件重来成功。
                    "已取消加入空间。若配对已完成,账户侧会留下一台闲置设备注册;重复取消后加不进时,联系运营者吊销闲置设备再试".into()
                }
                Err(c) => format!("已取消加入,但暂存清理失败(重启朱简后自动清理):{c}"),
            });
        }
        // 引导那半收场(用户面 34)。⛔ **清理走取消那条已经验过的路** —— transport
        // 此刻**还活着且还在轮转重试**,不 `stop_staging` 就会留下一个 detached 会话。
        Waited::GaveUp(why) => {
            stop_staging(&shutdown_tx, staging_task).await;
            return Err(match slot.abort() {
                Ok(()) => {
                    release_join_reservation(spaces, &reserved);
                    format!("{why}(已停止本次加入,暂存已清理;可以重试)")
                }
                Err(c) => format!("{why};且暂存清理失败(重启朱简后自动清理):{c}"),
            });
        }
        Waited::TransportGone(why) => {
            let err = status.lock().expect("status mutex poisoned").error.clone().unwrap_or(why);
            return Err(match slot.abort() {
                Ok(()) => {
                    release_join_reservation(spaces, &reserved);
                    format!("加入失败:{err}")
                }
                Err(c) => format!("加入失败:{err};且暂存清理失败(重启朱简后自动清理):{c}"),
            });
        }
    };

    // BootCommitted → Published:shutdown(不退则 abort 强杀)→ close → publish。
    progress("publishing", 0, 0);
    stop_staging(&shutdown_tx, staging_task).await;
    drop(ctl_tx);
    let closed = match slot.close() {
        Ok(c) => c,
        Err(f) => {
            // 既不 publish 也不假装已清(§3.1 fail-closed);reservation 保留到重启。
            return Err(format!("加入未完成(收尾失败,重启朱简后重试):{}", f.error));
        }
    };
    let published = match closed.publish() {
        Ok(p) => p,
        Err((closed, e)) => {
            // publish 失败(§3.5:本进程对该账户 fail-closed 到重启)。
            return Err(match closed.abort() {
                Ok(()) => format!("{e}(暂存已清理;重启朱简后可重试加入)"),
                Err(c) => format!("{e};且暂存清理失败(重启朱简后自动清理):{c}"),
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
    // ⭐ 这五步自 426 起住共享 helper(§16.3.2):恢复的幕⑦ 调的是同一处 —— 全仓
    // `desktop/lib.rs` 里那道锚要求的「唯一集成入口」就是它。
    let integrate = integrate_space(&permit, app, &id, &published.path);
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
        // ⚠ join 这半的话术**一字未改**(两支合成同一句):加入的失败面里撞身份是
        // 天方夜谭(新库刚从别人那儿引导下来、device_id 是本机新生成的),而恢复那半
        // 分得开两支,见 `restore_integrate_hint`。
        Err(e) => Ok(JoinOutcome::PublishedNeedsRestart {
            space_id: id,
            error: format!("空间已加入,但装配失败:{}——重启朱简后空间会出现", e.text()),
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    {
        let conn = rt.db.lock().expect("db mutex poisoned");
        // ReopenRequired 复核在 db 锁内(codex 三轮 M2:set_server 是裸 db.lock 写,
        // 不走 write_locks,锁前预检有「查后落旗抢锁」竞态)。
        if let Some(e) = rt.restart_required() {
            return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
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
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
        spaces::set_space_name(&mut conn, &mut clk, &name)?;
    }
    for win in ["notebook", "capture"] {
        let _ = app.emit_to(win, "space-name-changed", serde_json::json!({ "space": space_id }));
    }
    Ok(())
}

/// 设备身份面(identity-plan §2.3):本机是哪台 + 这个账户里见过哪些设备。
/// 一次取齐,因为前端两处都要用它——设置面的「本机别名」输入框,与卡片署名 chip 的
/// 「device_id → 别名」翻译表。
#[derive(Serialize)]
struct DeviceIdentity {
    /// 本机在**这个空间**里的 device_id(设备身份是「设备 × 空间」粒度:同一台机器
    /// 在两个空间里是两个不同的 id)。
    this_device: String,
    /// 全量名册,按 device_id 排序。⚠ 口径是**「见过的设备」**,不是「当前在册的设备」
    /// ——被服务端吊销的设备,它的别名行照样在(op 早已收敛进每台设备的库)。要一份
    /// 权威在册名单得等 §5「移除设备」补服务端下发,别拿这个当那个用。
    devices: Vec<DeviceEntryItem>,
}

#[derive(Serialize)]
struct DeviceEntryItem {
    device_id: String,
    /// null = 从未命名或显式清名。**后端绝不编造缺省名**(design-rules:绝不回退兜底);
    /// 人话缺省(设置面显 id 前 6 位 + 灰「未命名」)归前端。
    alias: Option<String>,
}

#[tauri::command]
fn device_identity(space_id: String, spaces: State<'_, Spaces>) -> Result<DeviceIdentity, String> {
    let rt = spaces.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let this_device = clock::Clock::load(&conn)?.device_id().to_string();
    let devices = identity::device_roster(&conn)?
        .into_iter()
        .map(|d| DeviceEntryItem { device_id: d.device_id, alias: d.alias })
        .collect();
    Ok(DeviceIdentity { this_device, devices })
}

/// 给一台设备起/改/清别名(identity-plan §2)。`alias` 传 null 或空白 = 清名。
/// 别名**进同步**(和空间名同族);字号 / 明暗 / 热键那三样是环境属性刻意不同步,别搞混。
///
/// `device_id` 由前端传,不锁本机:名册是账户内共享的,给别的设备改名合法(冲突走
/// 字段级 LWW)。当前 UI 只用它改本机那台。
#[tauri::command]
fn set_device_alias(
    space_id: String,
    device_id: String,
    alias: Option<String>,
    spaces: State<'_, Spaces>,
) -> Result<(), String> {
    let rt = spaces.get(&space_id)?;
    let (mut conn, mut clk) = rt.write_locks();
    // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2),同 rename_space。
    if let Some(e) = rt.restart_required() {
        return Err(format!("此空间需要重启朱简完成初始同步装配:{e}"));
    }
    identity::set_device_alias(&mut conn, &mut clk, &device_id, alias.as_deref())
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

/// 桌面合成器在不在。setup 里在**主线程**量一次(GDK 不是线程安全的)存这儿,命令只读它;
/// 默认 true = 今天的样子(有合成器),量不到就不动外观。
static WM_COMPOSITED: AtomicBool = AtomicBool::new(true);

/// 桌面上有没有合成器(compositor)把窗口的 alpha 混到桌面上。
///
/// 捕获窗是 `transparent:true` 的无边框浮窗:纸片之外那一圈(index.html 里给自绘投影留的
/// padding)是透明的。**透明要靠合成器**——没有合成器时 alpha 无人处理,那一圈在屏幕上
/// 就是一块黑,用户看到的是「一张纸片嵌在一个大黑框里」。而 X11 上「没有合成器」是完全
/// 合法的常见状态:XFCE 把合成关掉、i3/openbox 没挂 picom、软件 GL 的远程桌面里 xfwm4
/// 直接以 `Unsupported GL renderer` 拒绝启合成器。前端据此把捕获窗底色由透明换成不透明的
/// `--paper`(见 index.html)——窗仍是方的、纸片圆角投影都不动,但不再是一块黑。
///
/// Win/mac 恒有合成(DWM / Quartz),恒 true;Wayland 恒合成,`gdk_screen_is_composited`
/// 在那儿也恒 true,故不必另判会话类型。
/// ⚠ 只在启动时量一次:装上 picom 之后要重启 app 才认(合成器来去是罕见事件,为它挂一条
/// `composited-changed` 信号桥不值)。
#[tauri::command]
fn wm_composited() -> bool {
    WM_COMPOSITED.load(Ordering::Relaxed)
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

/// 把召唤出来的窗口抬到最前并给键盘焦点。分平台:Windows/macOS 的 set_focus() 够用;
/// GNOME/X11 下 tao 的 Focus 走 gtk `present_with_time(GDK_CURRENT_TIME=0)`——0 时间戳
/// 被 mutter 的焦点偷窃防护当成「后台程序抢焦点」拒掉,于是 notebook(非 alwaysOnTop)
/// 映射到活动窗背后=用户以为「没打开」,capture 虽 alwaysOnTop 可见却拿不到焦点=
/// `onFocusChanged(true)` 不触发、`input.focus()` 不跑=光标不进输入框。修法:用
/// `gdkx11::x11_get_server_time` 取一个真·近期时间戳再 `present_with_time`(等价
/// wmctrl -a 发 _NET_ACTIVE_WINDOW,真机验过 mutter 放行)。必须在 GTK 主线程跑,故走
/// `run_on_main_thread`;取时间戳失败退回 0(不比现状差)。`#[cfg]` 让 Win/mac 逐字节不变。
fn raise_and_focus<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window.set_focus();
    }
    #[cfg(target_os = "linux")]
    {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            use gtk::glib::Cast;
            use gtk::prelude::{GtkWindowExt, WidgetExt};
            if let Ok(gtk_win) = w.gtk_window() {
                let ts = gtk_win
                    .window()
                    .and_then(|gdk_win| gdk_win.downcast::<gdkx11::X11Window>().ok())
                    .map(|x11| gdkx11::functions::x11_get_server_time(&x11))
                    .unwrap_or(0);
                gtk_win.present_with_time(ts);
            }
        });
    }
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
        raise_and_focus(&window);
        return;
    }

    // A minimized window won't return to the foreground from show()/set_focus() alone on
    // Windows — restore it first. Non-fatal: a transient minimize-state query failure
    // shouldn't crash the summon.
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    window.show().expect("show window");
    raise_and_focus(&window);
}

/// 唤起笔记本主窗。托盘双击、托盘「打开朱简」菜单项、以及 Ctrl+Alt+M 全局键
/// 三处入口共用此逻辑,避免散三份将来漂移。
/// 刻意不强制切视图:主窗隐藏不销毁,唤起后天然停在离开时的视图;真重启由前端
/// 视图记忆(zhujian.last-view)恢复——早年写死直达看板,与视图记忆打架,已改。
fn open_notebook<R: Runtime>(app: &AppHandle<R>) {
    show_window(app, "notebook");
}

/// 这个空间里有没有任何一条记录 —— `items` 一张表就是全部(㉜ 单实体:随记与任务同表,
/// 回收站 `archived_at` / 归档册 `sealed_at` 也只是那张表上的两根轴),故一句 EXISTS 到底。
/// D1(411)的判据;裸 SQL 留在壳里不下 core —— core 是两端共用面,为一句「库空不空」
/// 给另一台叠一笔复跑债不值(与安卓 `pane_counts` 同一取舍,410)。
fn space_has_item(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM items)", [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n != 0)
}

// ── 共享集成 helper(backup-plan §16.3.2,一弹 M3)───────────────────────────────
//
// 「把一个**盘上已经存在、本进程还没装配**的空间接进来」这件事,今天有两个调用方:
// 「加入空间」的 Published → Integrated 那一段,与恢复的幕⑦。⛔ **两处不许各写一份** ——
// 判据不是"重复代码不好看",是 `db.rs` 那道工作区级审计锚把 `db::open` 的调用点数
// 钉死成 `desktop/lib.rs` 恰 4 处:另写一处会把 4 顶成 5、当场红。**那是对的**,
// 它守的正是「唯一集成入口」。
//
// ⛔ **必须留在调用方、不许进 helper**(§16.3.2 写死的边界;抽太大会把 join 的账户
// 提交语义污染进恢复):`progress("integrating")` / `cleanup_error` 与 `needs_reopen` /
// `post_commit_error` / **`release_join_reservation`** / warnings 与 `SpaceInfo` 拼装 /
// 各自的失败话术。⭐ 判据是 reservation:**只有集成成功才释放,失败要保留到重启** ——
// 那是 join 的账户提交语义,恢复根本没有 reservation 这回事。

/// 集成失败的两支。⛔ **分开不是为了好看,是因为两支的「接下来怎么办」不一样**:
/// 撞身份重启也没用(下次启动照样撞),而另一支**重启值得先试**(启动时会重新装配一遍)。
/// 糊成一句 = 对着撞号的用户说「重启就行」,而他重启一百次也还是那样。
/// ⚠ **`Failed` 只是"值得先试",不是"重启就好"**(复核轮 L3/L2):它还盖着开库 / 时钟 /
/// 读别的空间身份失败,权限错、文件身份错那几种重启修不好 —— 话术里如实说了,别改回去。
#[derive(Debug)]
enum IntegrateError {
    /// 身份全表裁决把它判下来了(§六④ 新者垫底:败的是新来的,不连坐已有空间)。
    Veto(String),
    /// 开库 / 时钟 / activate 失败 —— 与身份无关的那一族。
    Failed(String),
}

impl IntegrateError {
    fn text(&self) -> &str {
        match self {
            IntegrateError::Veto(m) | IntegrateError::Failed(m) => m,
        }
    }
}

/// 集成一个盘上已存在的空间:**恰五步**(开库 → 时钟 → 身份全表裁决 → activate)。
///
/// ⛔ **只收 `&LifecyclePermit`**(§16.3.2 三弹 M1):那把锁不许只靠调用纪律 ——
/// 「新调用方漏拿锁照样编译得过」是真实反例(两个集成同时快照 identity、各自都看不见
/// 对方、随后都 activate,全表裁决的原子性当场破掉)。`Spaces` 也从凭证里取,
/// ⛔ 不另收一个可错配的引用。
fn integrate_space(
    permit: &spaces::LifecyclePermit<'_>,
    app: &AppHandle,
    id: &str,
    path: &std::path::Path,
) -> Result<Arc<SpaceRuntime>, IntegrateError> {
    // ⭐ **开库 + 时钟 + 身份裁决是一件事,不是三件**(见 [`integrate`] 的头注):
    // 拿得到这对 `(conn, clk)` 就等于裁决过了,⛔ 摘掉裁决不是变异、是编译错误。
    let (conn, clk) = integrate::open_and_adjudicate(permit, id, path)?.into_parts();
    activate_space(
        app,
        permit.spaces(),
        id.to_string(),
        path.to_path_buf(),
        conn,
        clk,
        None,
    )
    .map_err(IntegrateError::Failed)
}

/// helper 的前三步(开库 → 时钟 → **身份全表裁决**),封在一个私有子模块里。
///
/// ⭐ **为什么是子模块而不是三行内联**(codex 实现审 426 的 L1):测 7b 得能直接调裁决
/// 那一支(它不碰 `AppHandle`,否则整条撞号路径一格测都写不成),而那样一来
/// **「把裁决从 helper 里摘掉」那条变异就抓不到** —— 测照样绿。⇒ 把裁决的产出做成
/// **[`integrate_space`] 里唯一拿得到 `conn`/`clk` 的来路**:父模块造不出
/// [`integrate::Adjudicated`],摘掉这一步就没有句柄可传给 `activate_space`,
/// **编译期当场红**(照 `core/src/backup/restore.rs` 的 `ClosedLibrary` 同形,checklist §8)。
///
/// ⚠ **诚实边界,别把它读强了**(codex 实现审 426 复核轮 L3):
/// - `activate_space` 收的**仍是裸 `Connection` + `Clock`**,而且另有两处合法调用点
///   (建空间 / 启动装配)—— 这个类型**没有**让「裸调 activate」从此不可写;
/// - 它挡的只是**这条集成路径**上「跳过裁决」;谁另开一条 `rusqlite::Connection::open`
///   照样绕得过去(那条既不碰 `db::open` 锚也不碰 `open_space` 锚)。
///   ⇒ **那个残留缺口是被接受的**(codex 复核轮的判据):绕过者必须显式新增一条**违反桌面
///   正式开库契约**的路线,而本文件今天零处这种调用,`activate_space` 又是文件内私有 fn、
///   调用点肉眼可数。⛔ 别拿「两道审计锚兜着」当它的论证 —— 那两道锚数的是另外两个符号。
mod integrate {
    use super::{clock, db, live_identities, spaces, IntegrateError};
    use std::path::Path;

    /// 「这个库开好了、时钟加载了、**而且身份全表裁决过了**」——字段私有在本模块,
    /// 唯一产法是 [`open_and_adjudicate`]。
    pub(super) struct Adjudicated {
        conn: rusqlite::Connection,
        clk: clock::Clock,
    }

    impl Adjudicated {
        pub(super) fn into_parts(self) -> (rusqlite::Connection, clock::Clock) {
            (self.conn, self.clk)
        }
    }

    /// ⚠ 那条撞号路径**必须**有网:`epoch::compact` 生出来的新 `device_id` 只是
    /// `Ulid::new()`、**不过跨空间唯一闸** ⇒「恢复后恒无 veto」是概率结论,
    /// ⛔ 不是结构保证(backup-plan §16.12 测 7b)。
    pub(super) fn open_and_adjudicate(
        permit: &spaces::LifecyclePermit<'_>,
        id: &str,
        path: &Path,
    ) -> Result<Adjudicated, IntegrateError> {
        // 正式打开走 db::open 正道(桌面策略;版本恰当前,迁移为 no-op)。
        let conn =
            db::open(path).map_err(|e| IntegrateError::Failed(format!("打开新空间库失败:{e}")))?;
        let clk = clock::Clock::load(&conn)
            .map_err(|e| IntegrateError::Failed(format!("初始化空间时钟失败:{e}")))?;
        // §六④ 身份全表裁决(**新者垫底**——真撞上时败的是新空间,不连坐已有空间)。
        let mut idents = live_identities(permit.spaces()).map_err(IntegrateError::Failed)?;
        idents
            .push(spaces::read_identity(id, path, &conn, &clk).map_err(IntegrateError::Failed)?);
        if let Some(spaces::Veto::Hard(m) | spaces::Veto::Soft(m)) =
            spaces::identity_vetoes(&idents).remove(id)
        {
            return Err(IntegrateError::Veto(m));
        }
        Ok(Adjudicated { conn, clk })
    }
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
                // ⛔ **这一格刻意不转发,不是漏了**:`BootFailed` 是给「加入空间」那条
                // 前台仪式当收场判据用的(用户面 34),而**已引导**空间的报错面一个字
                // 没变 —— 同一次失败照旧走上面那条 Toast 与 `status.error`,转发它等于
                // 把同一句话对用户说两遍。⚠ 真要在这一端另做处置,先读
                // `transport::JoinBootWatch` 的头注:那两条路刻意不同。
                SyncEvent::BootFailed { .. } => continue,
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

// 全局热键的平台默认分叉:Windows/Linux 用 Ctrl+Alt(桌面老惯例);macOS 用 Cmd+Alt
// (用户肌肉记忆是 Cmd)。这两个串是「首装 / 无配置」时的默认,232 起用户可在设置里改;
// 也是托盘菜单里显示的加速键提示。加速键串由 global_hotkey 的 FromStr 解析成真正的键。
#[cfg(target_os = "macos")]
const ACCEL_CAPTURE: &str = "Cmd+Alt+N";
#[cfg(target_os = "macos")]
const ACCEL_NOTEBOOK: &str = "Cmd+Alt+M";
#[cfg(not(target_os = "macos"))]
const ACCEL_CAPTURE: &str = "Ctrl+Alt+N";
#[cfg(not(target_os = "macos"))]
const ACCEL_NOTEBOOK: &str = "Ctrl+Alt+M";

// ── 可改全局热键(232)────────────────────────────────────────────────
// 键存 app 配置目录 `.hotkeys.json`,纯设备本地——不进 DB、不同步(热键是每台机器
// 自己的事)。值是加速键串(如 "Ctrl+Alt+N"),两端同格式:前端录制器把 KeyboardEvent
// 转成串,后端 global_hotkey FromStr 解析回键。读不到 / 解析不了 → 退回平台默认键
// (fail-safe:坏配置绝不让热键失效或崩启动)。

/// `.hotkeys.json` 的内容:两枚加速键串。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct HotkeyConfig {
    capture: String,
    notebook: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            capture: ACCEL_CAPTURE.to_string(),
            notebook: ACCEL_NOTEBOOK.to_string(),
        }
    }
}

/// 当前生效的热键(解析后的 Shortcut + 原始串)。热键回调按此分派 capture / notebook;
/// setup 装配,`set_hotkey` 改写。放 managed state 里,命令与回调共享。
struct HotkeyState(Mutex<HotkeyRuntime>);
struct HotkeyRuntime {
    capture: Shortcut,
    capture_accel: String,
    notebook: Shortcut,
    notebook_accel: String,
}

/// 启动时注册失败(被别的程序占用)的全局热键加速键串——供捕获窗内提示条查询后
/// 显示「点此改键」。`set_hotkey` 两枚都重注册成功时清空(冲突已解,提示条随之消失)。
struct HotkeyConflicts(Mutex<Vec<String>>);

/// 捕获窗「点此改键」待处理旗:主窗惰性导航,未加载时 emit 的事件会丢(同 deep-link),
/// `open_settings` 置旗,notebook 冷启动 + 收到事件各取一次(take 语义,谁先到谁处理)。
struct PendingOpenSettings(AtomicBool);

/// 托盘两枚菜单项句柄,供改键时同步刷新显示的键名。
struct TrayHotkeyItems {
    show: MenuItem<tauri::Wry>,
    notebook: MenuItem<tauri::Wry>,
}

fn hotkeys_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(".hotkeys.json"))
}

fn load_hotkey_config(app: &AppHandle) -> HotkeyConfig {
    let Some(p) = hotkeys_path(app) else {
        return HotkeyConfig::default();
    };
    match std::fs::read_to_string(&p) {
        Ok(txt) => serde_json::from_str(&txt).unwrap_or_default(),
        Err(_) => HotkeyConfig::default(),
    }
}

fn save_hotkey_config(app: &AppHandle, cfg: &HotkeyConfig) -> std::io::Result<()> {
    let Some(p) = hotkeys_path(app) else {
        return Ok(());
    };
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&p, serde_json::to_string_pretty(cfg).expect("HotkeyConfig 可序列化"))
}

/// 加速键串 → Shortcut;坏串退回给定默认。返回真正生效的 (Shortcut, 规范串)。
fn parse_hotkey_or(accel: &str, default: &str) -> (Shortcut, String) {
    match accel.parse::<Shortcut>() {
        Ok(sc) => (sc, accel.to_string()),
        Err(_) => (
            default.parse::<Shortcut>().expect("平台默认加速键必可解析"),
            default.to_string(),
        ),
    }
}

/// 刷新托盘两枚项显示的键名。Linux:appindicator 不显原生加速键,焊进标签文本;
/// Win/mac:走原生第 5 参,标签保持纯中文。托盘未装配(理论上不会)则静默跳过。
fn refresh_tray_hotkey_labels(app: &AppHandle, capture_accel: &str, notebook_accel: &str) {
    let Some(items) = app.try_state::<TrayHotkeyItems>() else {
        return;
    };
    #[cfg(target_os = "linux")]
    {
        let _ = items.show.set_text(format!("记一笔  ({capture_accel})"));
        let _ = items
            .notebook
            .set_text(format!("打开朱简  ({notebook_accel})"));
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = items.show.set_accelerator(Some(capture_accel));
        let _ = items.notebook.set_accelerator(Some(notebook_accel));
    }
}

#[derive(Serialize)]
struct HotkeysDto {
    capture: String,
    notebook: String,
}

/// 当前两枚热键的加速键串(设置面板初显)。
#[tauri::command]
fn get_hotkeys(app: AppHandle) -> HotkeysDto {
    let st = app.state::<HotkeyState>();
    let rt = st.0.lock().expect("hotkey state");
    HotkeysDto {
        capture: rt.capture_accel.clone(),
        notebook: rt.notebook_accel.clone(),
    }
}

/// 改一枚热键(`which` = "capture" | "notebook",`accel` = 新加速键串)。
/// 注销旧两枚→注册新两枚;新键被占用则回滚回旧键并报错(fail-safe:绝不留半注册态)。
/// 成功即存盘 + 刷新托盘显示。返回改后两枚串给前端回显。
#[tauri::command]
fn set_hotkey(app: AppHandle, which: String, accel: String) -> Result<HotkeysDto, String> {
    // 至少一个修饰键:裸键(如「N」)注册成全局热键会到处劫持该键。加速键串靠 '+' 连修饰键。
    if !accel.contains('+') {
        return Err("请至少带一个修饰键(如 Ctrl、Alt)".into());
    }
    let new_sc: Shortcut = accel
        .parse()
        .map_err(|_| "没认出这个快捷键,换一个试试".to_string())?;
    if new_sc.mods.is_empty() {
        return Err("请至少带一个修饰键(如 Ctrl、Alt)".into());
    }

    let st = app.state::<HotkeyState>();
    let mut rt = st.0.lock().expect("hotkey state");

    let (new_capture, cap_accel, new_notebook, nb_accel) = match which.as_str() {
        "capture" => (new_sc, accel.clone(), rt.notebook, rt.notebook_accel.clone()),
        "notebook" => (rt.capture, rt.capture_accel.clone(), new_sc, accel.clone()),
        _ => return Err("未知的热键项".into()),
    };
    if new_capture == new_notebook {
        return Err("两个快捷键不能设成一样的".into());
    }

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let reg = gs
        .register(new_capture)
        .and_then(|_| gs.register(new_notebook));
    if let Err(e) = reg {
        // 回滚:清掉可能已注册的一半,把旧键装回去。
        let _ = gs.unregister_all();
        let _ = gs.register(rt.capture);
        let _ = gs.register(rt.notebook);
        log::error!("改热键失败,已回滚:{e}");
        return Err("这个快捷键可能被别的程序占用了,没换成——换一个再试".into());
    }

    rt.capture = new_capture;
    rt.capture_accel = cap_accel.clone();
    rt.notebook = new_notebook;
    rt.notebook_accel = nb_accel.clone();
    drop(rt);

    let cfg = HotkeyConfig {
        capture: cap_accel.clone(),
        notebook: nb_accel.clone(),
    };
    if let Err(e) = save_hotkey_config(&app, &cfg) {
        log::error!("热键配置存盘失败(改动已生效,重启后可能丢):{e}");
    }
    refresh_tray_hotkey_labels(&app, &cfg.capture, &cfg.notebook);
    // 走到这里两枚键都重注册成功 = 已无占用冲突,清掉启动期记下的那份
    // (下次捕获窗查询即空,提示条不再出现)。
    app.state::<HotkeyConflicts>()
        .0
        .lock()
        .expect("hotkey conflicts")
        .clear();
    Ok(HotkeysDto {
        capture: cfg.capture,
        notebook: cfg.notebook,
    })
}

/// 启动时被别的程序占用、当前失效的全局热键(加速键串)。捕获窗据此显示提示条。
#[tauri::command]
fn hotkey_conflicts(app: AppHandle) -> Vec<String> {
    app.state::<HotkeyConflicts>()
        .0
        .lock()
        .expect("hotkey conflicts")
        .clone()
}

/// 从捕获窗跳到主窗设置面板(热键冲突提示条「点此改键」):置待处理旗 → 唤起主窗 →
/// emit 事件。冷启动(主窗还是 about:blank)时事件会丢,靠 notebook 启动时取旗兜底;
/// 热路(主窗已加载)靠 emit 即时弹面板。旗是 take 语义,两条路谁先到谁处理、不重放。
#[tauri::command]
fn open_settings(app: AppHandle) {
    app.state::<PendingOpenSettings>()
        .0
        .store(true, Ordering::SeqCst);
    open_notebook(&app);
    if let Some(nb) = app.get_webview_window("notebook") {
        let _ = nb.emit("open-settings", ());
    }
}

/// 取走「打开设置面板」待处理旗(读并清)。notebook 冷启动 + 收到 open-settings 事件各取一次。
#[tauri::command]
fn take_open_settings(app: AppHandle) -> bool {
    app.state::<PendingOpenSettings>().0.swap(false, Ordering::SeqCst)
}

// ── 加密备份(backup-plan 笔①-a,402 core / 412 壳与 UI)──────────────────────
//
// ⛔ **壳这一层不做任何策略**:准入(同一时刻只许一趟)、封锁态、仪式、清扫全在
// core 的 `BackupCoordinator` 里 —— 门开在这儿的话,笔①-b 的自动备份(后台定时器,
// 不走命令层)就绕过去了(backup-plan §3.4.1 第 7 维)。本节只做三件事:
// ①把 core 的类型翻成前端 DTO;②把长活儿挪出 UI 线程;③「打开所在文件夹」。
//
// ⚠ 备份钥不出 core:这里能拿到的只有「备份码字符串」「文件路径」「人话状态」。

#[derive(Serialize)]
struct BackupStatusDto {
    configured: bool,
    dir: String,
    blocked: Option<String>,
    /// "backup" | "cleanup" | null —— UI 据此把两个按钮置灰。
    busy: Option<&'static str>,
    awaiting_ceremony: bool,
    problem: Option<String>,
}

#[derive(Serialize)]
struct BackupMadeDto {
    space_id: String,
    path: String,
    bytes: u64,
}

#[derive(Serialize)]
struct BackupFailedDto {
    space_id: String,
    message: String,
    /// 盘上留下的那个文件:"unverified"(写完没验过)| "invalid"(验不过又删不掉)。
    /// ⛔ 两种都**不得**计作一份备份。
    leftover_kind: Option<&'static str>,
    leftover_path: Option<String>,
}

#[derive(Serialize)]
struct BackupReportDto {
    made: Vec<BackupMadeDto>,
    failed: Vec<BackupFailedDto>,
    /// 剩余**根本没跑**的空间数;UI 必须与「跑了但失败」显著区分(§6.3)。
    skipped: usize,
    fatal: Option<String>,
    blocked: Option<String>,
}

fn backup_status_dto(s: zhujian_core::backup::BackupStatus) -> BackupStatusDto {
    use zhujian_core::backup::Busy;
    BackupStatusDto {
        configured: s.configured,
        dir: s.dir,
        blocked: s.blocked,
        busy: s.busy.map(|b| match b {
            Busy::Backup => "backup",
            Busy::Cleanup => "cleanup",
            // 424:第三个活动态(恢复)。⚠ 前端今天不读这一格,但类型面要如实
            //(`src/backup.ts` 那个联合同轮加了 "restore")。
            Busy::Restore => "restore",
        }),
        awaiting_ceremony: s.awaiting_ceremony,
        problem: s.problem,
    }
}

#[tauri::command]
fn backup_status(app: AppHandle) -> BackupStatusDto {
    backup_status_dto(app.state::<zhujian_core::backup::BackupCoordinator>().status())
}

/// 仪式第一步:生成备份钥(**只在内存**)并返回要抄的码。`dir` 为空 = 用默认落点。
#[tauri::command]
fn backup_begin_setup(app: AppHandle, dir: Option<String>) -> Result<String, String> {
    let dir = dir.filter(|d| !d.trim().is_empty());
    app.state::<zhujian_core::backup::BackupCoordinator>()
        .begin_setup(dir.as_deref())
        .map_err(|e| e.to_string())
}

/// 仪式第二步:回输核对。**对上了才落盘**(⛔ 不许退化成勾「我已抄下」)。
#[tauri::command]
fn backup_confirm_setup(app: AppHandle, code: String) -> Result<(), String> {
    app.state::<zhujian_core::backup::BackupCoordinator>()
        .confirm_setup(&code)
        .map_err(|e| e.to_string())
}

/// 放弃仪式(关面板 / 点取消):进程内那把钥当场丢掉,盘上什么都没写过。
#[tauri::command]
fn backup_cancel_setup(app: AppHandle) {
    app.state::<zhujian_core::backup::BackupCoordinator>().cancel_setup();
}

#[tauri::command]
fn backup_set_dir(app: AppHandle, dir: String) -> Result<BackupStatusDto, String> {
    let c = app.state::<zhujian_core::backup::BackupCoordinator>();
    c.set_dir(&dir).map_err(|e| e.to_string())?;
    Ok(backup_status_dto(c.status()))
}

/// 跑一趟备份(所有空间,逐空间串行)。
///
/// ⭐ **`spawn_blocking` 不是可省的礼节**:一趟备份 = 整库 `VACUUM INTO` + 全量加密 +
/// **全量自验**,大库要跑好几秒。同步命令跑在 UI 线程上,那几秒会把主窗冻住
/// (Linux/WebKitGTK 上还会被系统判成「无响应」)。
#[tauri::command]
async fn backup_run(app: AppHandle) -> Result<BackupReportDto, String> {
    use zhujian_core::backup::Leftover;
    tauri::async_runtime::spawn_blocking(move || {
        let report = app
            .state::<zhujian_core::backup::BackupCoordinator>()
            .run_backup()
            .map_err(|e| e.to_string())?;
        Ok(BackupReportDto {
            made: report
                .made
                .into_iter()
                .map(|m| BackupMadeDto { space_id: m.space_id, path: m.path, bytes: m.bytes })
                .collect(),
            failed: report
                .failed
                .into_iter()
                .map(|f| {
                    let (kind, path) = match f.leftover {
                        None => (None, None),
                        Some(Leftover::Unverified(p)) => (Some("unverified"), Some(p)),
                        Some(Leftover::Invalid(p)) => (Some("invalid"), Some(p)),
                    };
                    BackupFailedDto {
                        space_id: f.space_id,
                        message: f.message,
                        leftover_kind: kind,
                        leftover_path: path,
                    }
                })
                .collect(),
            skipped: report.skipped,
            fatal: report.fatal,
            blocked: report.blocked,
        })
    })
    .await
    .map_err(|e| format!("备份任务没跑起来:{e}"))?
}

/// 重试清扫暂存区(封锁态的**唯一**出路;⛔ 没有「忽略」按钮)。
#[tauri::command]
async fn backup_retry_cleanup(app: AppHandle) -> Result<BackupStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<zhujian_core::backup::BackupCoordinator>()
            .retry_cleanup()
            .map(backup_status_dto)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("清扫任务没跑起来:{e}"))?
}

#[derive(Serialize)]
struct BackupEntryDto {
    path: String,
    file_name: String,
    bytes: u64,
    modified_ms: Option<u64>,
}

#[derive(Serialize)]
struct VerifiedBackupDto {
    space_id: String,
    space_name: Option<String>,
    created_at: String,
    app_version: String,
    plain_bytes: u64,
}

/// 列出备份目录里的候选文件。⛔ **回的只有盘上事实,没有「有效」这一格**
/// (backup-plan §3.3:文件名 / 扩展名绝不能当「这是一份有效备份」的判据)。
#[tauri::command]
fn backup_list(app: AppHandle) -> Result<Vec<BackupEntryDto>, String> {
    app.state::<zhujian_core::backup::BackupCoordinator>()
        .list_backups()
        .map(|v| {
            v.into_iter()
                .map(|e| BackupEntryDto {
                    path: e.path,
                    file_name: e.file_name,
                    bytes: e.bytes,
                    modified_ms: e.modified_ms,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

/// 验一份备份:**整个读回来解一遍**(与恢复同一条路)。
///
/// ⭐ **`spawn_blocking` 与 `backup_run` 同理**:全量解一份大库要好几秒,同步命令会把主窗冻住。
#[tauri::command]
async fn backup_verify(app: AppHandle, path: String) -> Result<VerifiedBackupDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<zhujian_core::backup::BackupCoordinator>()
            .verify_backup(&path)
            .map(|v| VerifiedBackupDto {
                space_id: v.space_id,
                space_name: v.space_name,
                created_at: v.created_at,
                app_version: v.app_version,
                plain_bytes: v.plain_bytes,
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("验证任务没跑起来:{e}"))?
}

// ── 恢复(笔②,backup-plan §16;426 = 壳这半)────────────────────────────────────
//
// 形一句话:**任何成功发布的恢复必产出一个「未配置(不同步)的新空间」,⛔ 绝不覆盖
// 任何现有数据。** 幕①…⑥ 在 core(coordinator 取 `Restoring` 准入 → 验钥 → 解密 →
// 前滚 → 预检 → 清身份 → no-clobber 落位),这里只做幕⑦:**同一个共享集成 helper**。
//
// ⛔ 三条别改坏的:
// 1. **提交点 = 幕⑥ publish 成功**。此后任何失败都不许把「库已经在盘上」这件事撤销 ——
//    集成失败照 `pair_join` 的 `PublishedNeedsRestart` 那条裁决:**不许删库**。
//    ⇒ 本命令的失败回执里,「库还在不在盘上」必须一眼看得出来。
// 2. **备份码是用户手输的**,⛔ 不读 `.backup.json`、也⛔ 不要求本机已完成备份仪式 ——
//    换了机器 / 重装系统之后那份配置根本不存在,而那正是恢复的主场景。
// 3. **生命周期凭证在整趟里全程持有**:落位是往空间扫描目录里放文件,而「谁占着哪个
//    账户 / 表里有哪些空间」的判断必须与它原子 —— 与 join 同锁同形。

#[derive(Serialize)]
struct RestoredSpaceDto {
    /// 新空间的 ULID(全新的;⛔ **不是**备份里那个 space_id)。
    space_id: String,
    path: String,
    /// 备份里那个空间叫什么。⚠ v1 刻意**不自动改名** ⇒ 同机恢复后两个空间同名。
    source_space_name: Option<String>,
    /// 备份是什么时候取的(RFC3339 UTC;本地时间由前端转)。
    created_at: String,
    /// 已装配进空间表 = 现在就能切过去;`false` = 库在盘上但这一趟没接进来。
    integrated: bool,
    /// ⭐ **原样摊开**:暂存名没清掉 / 集成失败的指路 —— ⛔ 不许收成一句「恢复失败」。
    warnings: Vec<String>,
}

/// 幕⑦ 失败时给用户的**可执行指路**(§16.12 测 7b 那条「真撞上了也不许静默」的另一半)。
///
/// ⭐ **两支分开是判据不是修辞**:撞身份**重启也没用**(下次启动照样撞),唯一出路是
/// 删掉那份库再恢复一次(每一趟恢复都由压实重新生成一枚设备身份);而另一支**重启值得先试**
/// (启动时会重新装配一遍)。⛔ 糊成一句 = 对着撞号的用户说「重启就行」,他重启一百次也一样。
/// ⚠ **但另一支也只是"值得先试",不是保证**(复核轮 L3):它还盖着开库 / 时钟 / 读别的空间
/// 身份失败,权限错、文件身份错那几种**重启修不好** —— 话术里那半句如实说了,别改回去。
fn restore_integrate_hint(err: &IntegrateError, path: &str) -> String {
    match err {
        IntegrateError::Veto(m) => format!(
            "⚠ 恢复出来的库已经落在盘上({path}),⛔ 没有覆盖任何东西 —— 但它的身份与\
             已有空间撞上了,这一趟没装配进来:{m}。出路:先删掉那个文件,再恢复一次\
             (每一趟恢复都会重新生成一枚设备身份)"
        ),
        // ⚠ **别把这句写成保证**(codex 实现审 426 的 L3):这一支不只是"瞬时的 activate
        // 出错",它还盖着开库失败 / 时钟加载失败 / 读别的空间身份失败 —— 权限错、文件身份
        // 错这类是**重启修不好的**。⇒ 先给最省事的那一步,再如实说它可能不够。
        IntegrateError::Failed(m) => format!(
            "⚠ 恢复出来的库已经落在盘上({path}),⛔ 没有覆盖任何东西 —— 但这一趟没装配\
             进来:{m}。先重启一次朱简(启动时会重新装配一遍);若它仍然没出现在空间列表里,\
             那就不是重启能修的,按上面那句原因处理那个文件"
        ),
    }
}

/// 从一份 `.zjbak` 恢复出**一个未配置(不同步)的新空间**。
///
/// ⚠ **没有进度、也不能取消**(§16.9,与 `0a-进度` 同一条已拍的板);大库要等,
/// 故 `spawn_blocking`(同步命令会把主窗冻住)。
#[tauri::command]
async fn backup_restore(
    app: AppHandle,
    spaces: State<'_, Spaces>,
    file: String,
    code: String,
) -> Result<RestoredSpaceDto, String> {
    // ⚠ **凭证在 core 那半开跑之前就取**:落位那一刻起,盘上多了一个空间文件 ——
    // 「谁占着哪个账户 / 表里有哪些空间」的判断(account_free_desktop 的磁盘重扫、
    // 建空间、加入)不许在这中间打进来看见半个世界。
    let permit = spaces.lock_lifecycle().await;
    // ⭐ **配置转换 veto**(board-columns-plan §5.6):恢复里含 `clear_config` 与
    // `epoch::compact` 两件 —— §5.6 那张表点名的四件里的两件。⛔ 不新造锁,理由同创号/
    // 配对那两处;释放走 RAII,故下面那条「提交点已过、任何失败都不许翻成 Err」的分叉
    // 不会漏掉它。
    let _config_transition = spaces.sup.begin_config_transition();
    let core = app.clone();
    let restored = tauri::async_runtime::spawn_blocking(move || {
        core.state::<zhujian_core::backup::BackupCoordinator>()
            .restore_backup(&file, &code)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("恢复任务没跑起来:{e}"))??;

    // ⭐ **提交点已过**:从这里往下,任何失败都不许翻成 `Err` —— 那会让用户以为
    // 什么都没发生,而库真的已经在盘上了(照 `pair_join` 的 `PublishedNeedsRestart`
    // 那条既有裁决,⛔ 也不许删库)。
    let mut warnings = Vec::new();
    if let Some(w) = restored.cleanup_error {
        warnings.push(format!(
            "⚠ 空间已经恢复好了,只是暂存目录里那个名字没清掉:{w}(库本体无损,下次启动会再清一次)"
        ));
    }
    let integrated = match integrate_space(
        &permit,
        &app,
        &restored.space_id,
        std::path::Path::new(&restored.path),
    ) {
        Ok(_) => {
            // ⭐ 空间**表**变了,不只是设置面里多了一句话:侧栏那枚空间徽章按空间数显隐
            // (411/D2 —— 单空间时它整个藏着),不通知的话「恢复好了,切过去看」这句话
            // 在只有一个空间的机器上是**指向一个看不见的入口**。两窗都发,与改名那条同形。
            for win in ["notebook", "capture"] {
                let _ = app.emit_to(
                    win,
                    "space-name-changed",
                    serde_json::json!({ "space": restored.space_id }),
                );
            }
            true
        }
        Err(e) => {
            warnings.push(restore_integrate_hint(&e, &restored.path));
            false
        }
    };
    Ok(RestoredSpaceDto {
        space_id: restored.space_id,
        path: restored.path,
        source_space_name: restored.source_space_name,
        created_at: restored.created_at,
        integrated,
        warnings,
    })
}

#[derive(Serialize)]
struct BackupAutoStatusDto {
    enabled: bool,
    every_minutes: u32,
    keep: u32,
    /// UTC RFC3339 —— ⚠ **本地时间由前端 `Date` 转**(`time` 在多线程进程里取不到本地偏移)。
    last_success_at: Option<String>,
    last_result: Option<String>,
    problem: Option<String>,
    /// ⭐ 进程内那枚待读通知(设计审 H5):**每拉一次就取走** ——
    /// 它是「结论连盘都写不进去」时唯一还能到达用户的路,而 `emit` 在主窗没开时会丢。
    pending_notice: Option<String>,
    /// **已交还给用户**的产物(⛔ 与上面那枚相反:读了**不清**,它是"待你处置"的清单)。
    /// ⚠ 420 补的验收撞出来的缺口:此前只有**计数**到得了用户眼前,**路径只进了 stderr**。
    released: Vec<BackupNoteDto>,
    /// 上一趟「删不掉、下轮再试」的那几份。
    retry: Vec<BackupNoteDto>,
}

#[derive(Serialize)]
struct BackupNoteDto {
    path: String,
    why: String,
}

fn backup_auto_dto(s: zhujian_core::backup::AutoStatus) -> BackupAutoStatusDto {
    BackupAutoStatusDto {
        enabled: s.enabled,
        every_minutes: s.every_minutes,
        keep: s.keep,
        last_success_at: s.last_success_at,
        last_result: s.last_result,
        problem: s.problem,
        pending_notice: s.pending_notice,
        released: s.released.into_iter().map(|(path, why)| BackupNoteDto { path, why }).collect(),
        retry: s.retry.into_iter().map(|(path, why)| BackupNoteDto { path, why }).collect(),
    }
}

#[tauri::command]
fn backup_auto_status(app: AppHandle) -> BackupAutoStatusDto {
    backup_auto_dto(app.state::<zhujian_core::backup::BackupCoordinator>().auto_status())
}

/// 开 / 关自动备份。⛔ 策略一律不在这儿判 —— core 会拒绝「还没设置过备份就开」。
#[tauri::command]
fn backup_set_auto(app: AppHandle, enabled: bool) -> Result<BackupAutoStatusDto, String> {
    app.state::<zhujian_core::backup::BackupCoordinator>()
        .set_auto_enabled(enabled)
        .map(backup_auto_dto)
        .map_err(|e| e.to_string())
}

/// 把自动备份设置重置成默认(关 / 每天 / 3 份 / **空账**)。
///
/// ⭐ 这颗按钮**只在这一份文件上安全**:里面没有备份钥、没有任何不可再生的东西
/// (⛔ `.backup.json` 那边刻意**没有**对应按钮 —— 重设那份 = 已有备份永远打不开)。
/// ⚠ 代价照实说给用户:账清零 = 那些旧备份从此不再被自动清理。
#[tauri::command]
fn backup_reset_auto(app: AppHandle) -> Result<BackupAutoStatusDto, String> {
    app.state::<zhujian_core::backup::BackupCoordinator>()
        .reset_auto()
        .map(backup_auto_dto)
        .map_err(|e| e.to_string())
}

/// 自动备份那趟要不要打扰用户。⭐ **`Skipped` 一律不打扰**(没开 / 没到点 / 有别的操作在跑
/// 都是正常);⛔ 但失败、封锁、轮转出岔子必须看得见 —— fail-fast 铁律在无人值守这条路上
/// 只有这一个出口。
#[derive(Serialize, Clone)]
struct AutoBackupEvent {
    /// 去抖用的**原因键**:同一个原因每进程只弹一次(60 秒一 tick,不去抖就是每分钟一张脸)。
    reason: String,
    text: String,
}

fn auto_event(tick: &zhujian_core::backup::AutoTick) -> Option<AutoBackupEvent> {
    use zhujian_core::backup::AutoTick;
    match tick {
        AutoTick::Skipped(_) => None,
        AutoTick::Refused(m) => Some(AutoBackupEvent { reason: format!("refused:{m}"), text: m.clone() }),
        AutoTick::Ran(run) => {
            let bad = !run.report.failed.is_empty()
                || run.report.fatal.is_some()
                || run.report.blocked.is_some()
                || run.report.made.is_empty()
                || run.rotations.iter().any(|r| r.stalled.is_some() || !r.unmanaged.is_empty());
            // ⛔ 成功不弹:天天弹 = 用户学会无视它,那就等于没有提示。
            bad.then(|| AutoBackupEvent {
                reason: format!("ran:{}", run.summary),
                text: run.summary.clone(),
            })
        }
    }
}

/// 那根 60 秒的线程。**壳只管叫**:该不该跑、跑完删哪些旧的,全在 core
/// (⛔ 门开在这儿就等于没门 —— 这条路本来就不走命令层)。
///
/// ⚠ 首次判定延后到启动后 60 秒(避开启动尖峰);⛔ e2e(`YS_DB_PATH`)下**根本不起它**:
/// 测试要确定性,不要背景写盘。
fn spawn_auto_backup_timer(app: &AppHandle) {
    if e2e_db_path().is_some() {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let tick = handle.state::<zhujian_core::backup::BackupCoordinator>().run_auto_if_due();
        if let Some(ev) = auto_event(&tick) {
            eprintln!("WARN 自动备份:{}", ev.text);
            // ⚠ emit 只是"及时",不是"可靠"(主窗没开就收不到)——所以同一句话
            // 也留在 `.backup-auto.json` 的 last_result 与进程内 pending_notice 里。
            let _ = handle.emit("backup://auto", ev);
        }
    });
}

/// 「打开所在文件夹」——复用**已有的** opener 插件(§5.2:v1 不引原生目录选择器)。
/// 目录不存在时先建出来:用户点它就是想去看看,弹一句「没有这个目录」帮不上忙。
#[tauri::command]
fn backup_open_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.state::<zhujian_core::backup::BackupCoordinator>().status().dir;
    std::fs::create_dir_all(&dir).map_err(|e| format!("打不开 {dir}:{e}"))?;
    app.opener().open_path(dir.clone(), None::<&str>).map_err(|e| format!("打不开 {dir}:{e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 启动期 panic 的原生弹窗钩子:桌面壳的开库/身份/租约全在 Tauri `setup` 闭包里
/// fail-fast panic,窗口尚未建成——默认行为只往 stderr 打一行,双击 exe 的用户什么
/// 都看不到(表现为「没反应」)。这里在崩之前先弹一个原生框把消息给用户看见
/// (最常见:「库版本 vN 比本程序新——请安装新版朱简」=装了旧包;另有另一实例占
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
            .set_title("朱简无法启动")
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

// Xlib 的多线程开关(Linux 专属,为什么要它见 `run()` 开头那段注释)。gdk/gtk 那条链
// 只是**间接**用到 libX11(链接行里没有 -lX11、`--as-needed` 也不会留),故这里显式
// `#[link]` 把它要过来 —— 构建期需要 libx11-dev,它是 libgtk-3-dev / libxdo-dev 的依赖,
// 本机与三条 CI workflow 的 Linux job 都已装(release/nightly/preflight 同一份依赖行)。
#[cfg(target_os = "linux")]
#[link(name = "X11")]
extern "C" {
    fn XInitThreads() -> std::os::raw::c_int;
}

// 桌面合成器在不在(Linux 专属,为什么要它见 `wm_composited` 那段注释)。与上面的 X11
// 同理是**间接**依赖(链接行里没有 -lgdk-3),故显式 `#[link]` 把它要过来 —— 构建期需要
// libgtk-3-dev(它直接提供 libgdk-3.so),本机与三条 CI workflow 的 Linux job 都已装
// (release/nightly/preflight 同一份依赖行,那行本就是为 tauri 装的)。
// ⛔ 两个函数都必须在主线程调(GDK 不是线程安全的,394 那次 abort 是同一课)。
#[cfg(target_os = "linux")]
#[link(name = "gdk-3")]
extern "C" {
    fn gdk_screen_get_default() -> *mut std::ffi::c_void;
    fn gdk_screen_is_composited(screen: *mut std::ffi::c_void) -> std::os::raw::c_int;
}

pub fn run() {
    // Linux 真机冒烟(progress-log 394):Tauri 的命令跑在异步运行时线程上,而 tao 的
    // `current_monitor()` 是**直接 GDK/Xlib 调用、不经事件循环转发**(同文件里 `set_size` /
    // `set_position` / `maximize` 都走 tao 的 window_requests_tx 转给主线程,`is_minimized`
    // 只读原子,所以只有显示器查询这一类踩到)。于是三条真路都会在非主线程上碰 Xlib:
    // 「点开大图撑窗」(item-images.ts::planGrowMainWindow)、「捕获窗看图预览撑窗」
    // (main.ts::growWindow)、「上次最大化的主窗第一次被召唤」(show_window)。没有
    // XInitThreads 的多线程 X 客户端会把协议流搅乱,现场是 `xcb_xlib_threads_sequence_lost`
    // 断言 **abort(整个 app 当场没,不是一次失败的查询)** —— 本机三条路各复现过一次。
    // XInitThreads 让 Xlib 自己上锁,三条路当场恢复(winit 的 X11 后端同样开局就调它)。
    // 必须在任何 Xlib 调用之前,故与下面那条 env 一起放在进程最早点。仅 Linux。
    // 返回值(非零 = Xlib 支持多线程)**刻意不判**:真返回 0 时也只是回到本轮之前的状态
    // (那三条路照旧会崩),没有比「照常启动」更好的处置 —— 不是静默兜底,是无分支可走。
    #[cfg(target_os = "linux")]
    unsafe {
        XInitThreads();
    }
    // Linux 真机冒烟(progress-log 215):透明浮窗(capture,transparent:true)在
    // GNOME/X11 + WebKitGTK 的 DMABUF 加速合成路径下整窗渲染为空——卡片一个像素不画、
    // 用户召唤捕获看到的是「透过窗口的桌面」(不透明的 notebook 窗不走该路径,故不受影响)。
    // 关掉 DMABUF renderer(社区对 Tauri-on-Linux 空白/透明失效的标准解;比整体禁合成
    // WEBKIT_DISABLE_COMPOSITING_MODE 更轻、保留 GPU 合成)即恢复。必须在任何 GTK/WebKit
    // 初始化之前设(此处是进程最早点);尊重用户既有覆盖(已设则不动)。仅 Linux。
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
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
        // 剪贴板读(桌面深链接补路):前端回窗时读一次,合规 zhujian:// 链接才提示打开。
        .plugin(tauri_plugin_clipboard_manager::init())
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
                    // 按当前生效的键分派(用户可改,见 HotkeyState):捕获键 → 弹捕获窗;
                    // 主窗键 → 唤起笔记本主窗。状态未装配(启动早期,理论上热键还没注册)则跳过。
                    let Some(st) = app.try_state::<HotkeyState>() else {
                        return;
                    };
                    let (capture, notebook) = {
                        let rt = st.0.lock().expect("hotkey state");
                        (rt.capture, rt.notebook)
                    };
                    if *shortcut == capture {
                        show_window(app, "capture");
                    } else if *shortcut == notebook {
                        open_notebook(app);
                    }
                })
                .build(),
        )
        // 这两枚 state 必须在 builder 链上(`.setup` 之前)manage,不能放进 setup 闭包:
        // 捕获窗 webview 在**窗口创建期**就同步 invoke `hotkey_conflicts`(backtrace:
        // Webview::on_message→prepare_webview→with_webview→tauri::app::setup,早于 .setup
        // 闭包体运行),放 setup 里 manage 必被这记同步 invoke 抢先 → `state() called before
        // manage()` panic 崩启动(get_foreground_space 因 main.ts 里排在 `await listen` 之后
        // 才 dispatch、赶上了 setup 的 manage,才没中招——同类竞速只是它侥幸)。空值起手,
        // 真实冲突名单在 setup 注册热键后回填(见下 `*state().lock() = failed`)。
        .manage(HotkeyConflicts(Mutex::new(Vec::new())))
        .manage(PendingOpenSettings(AtomicBool::new(false)))
        .setup(|app| {
            // `probe305` 是台架 feature(305 真机复验,验完即撤):release 壳本来没有
            // 日志出口,core 那边的埋点就落不到盘上,故这里连带恒装。
            if cfg!(debug_assertions) || cfg!(feature = "probe305") {
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
            // 加密备份(backup-plan §3.4):路径域**必须与上面那把租约一一对应** ——
            // 生产落数据目录 / 配置目录,e2e(YS_DB_PATH)三处全按库派生(⛔ 绝不许用
            // `main_db.parent()`:那是 /tmp,多个测试进程会共享同一个 .backup-staging
            // 却各持不同租约,一个进程能删掉另一个正在用的明文快照;也绝不许碰真实用户配置)。
            // 启动清扫必须在**取到租约之后**跑(那时才排他、才敢删),就插在既有三个清扫旁边。
            {
                let paths = match &scan_dir {
                    Some(dir) => zhujian_core::backup::BackupPaths::production(
                        &app.path().app_config_dir().expect("resolve app config dir"),
                        dir,
                        &main_db,
                    ),
                    None => zhujian_core::backup::BackupPaths::for_db(&main_db),
                };
                let coordinator = zhujian_core::backup::BackupCoordinator::new(
                    paths,
                    app.package_info().version.to_string(),
                );
                // 清不掉 = **封锁备份**(不拒启:用户还得能用 app 看自己的数据;比引导
                // 快照那档强、比 joining 槽那档弱,理由 = 只有备份这条路会继续制造明文)。
                if let Some(reason) = coordinator.sweep_on_start() {
                    eprintln!("WARN {reason}");
                }
                app.manage(coordinator);
                // 笔①-b:自动备份那根 60 秒的线程(必须在 manage 之后)。
                spawn_auto_backup_timer(app.handle());
            }
            let boot_dir = main_db.parent().expect("库文件必有父目录").join(".boot");
            std::fs::create_dir_all(&boot_dir).expect("create boot dir");
            // #4(codex 二审):清上次进程 kill/crash 残留的明文引导快照;必须在任何空间
            // transport 启动前跑一次(多空间共享 .boot,放进各 transport 的 run() 会互删
            // 别的空间正在传输的快照)。
            // 升档:清不掉 = **响亮**(它们是明文完整库副本)。⛔ 不拒启、也不封锁引导 ——
            // 判据与触发门写在 `sweep_stale_boot_files` 头注里,别在这里另写一份。
            let boot_sweep = sync::transport::sweep_stale_boot_files(&boot_dir);
            if !boot_sweep.is_clean() {
                eprintln!("WARN {boot_sweep}");
            }
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
            // 局域网直连的 app 级监听器(lan-direct-plan §6):**整个 app 一枚**,各空间
            // 的 transport 往它的准入表里注册自己。惰性绑定——首个已配置空间注册时才真绑
            // 24618(被占退临时端口),没加账户的机器一个端口都不开。手机壳不建(只拨出)。
            let lan = Some(sync::transport::LanAdmission::new());
            let table = Spaces::new(
                SpaceSupervisor::new(rt_handle, spaces::DESKTOP_MAX_LIVE, lan),
                scan_dir,
                boot_dir.clone(),
                dead,
            );
            // D1 的判据在这儿取(411,408 走查):`activate_space` 会把 conn 移走,故
            // 必须在装配之前问。「空库」= **所有已装配空间的 `items` 一行都没有**
            // ——不是只看 main:加入空间的用户 main 恒空(147-150 的「加入」新建独立
            // 空间),只看 main 会让他每次启动都被弹一次主窗。
            let mut empty_library = true;
            for (id, path, conn, clk, veto) in live {
                if empty_library
                    && space_has_item(&conn)
                        .unwrap_or_else(|e| panic!("查空间 {id} 有无条目失败:{e}"))
                {
                    empty_library = false;
                }
                activate_space(app.handle(), &table, id, path, conn, clk, veto)
                    .unwrap_or_else(|e| panic!("装配空间 runtime 失败:{e}"));
            }
            app.manage(table);
            // 前台空间(工序 8,§9):启动恒 main;notebook 前端恢复上次空间时会
            // 立即 set_foreground_space 对齐。
            app.manage(ForegroundSpace(Mutex::new(spaces::MAIN_SPACE.to_string())));
            // 注:HotkeyConflicts / PendingOpenSettings 已在 builder 链上提前 manage(见那里
            // 长注释——捕获窗创建期就同步 invoke,setup 里 manage 太晚)。此处不再 manage。

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
            //
            // 键从 `.hotkeys.json` 读(读不到 / 坏串=平台默认),解析后装进 HotkeyState 供回调
            // 分派,再注册。改键走 set_hotkey 命令(注销重注册 + 存盘 + 刷托盘)。
            let cfg = load_hotkey_config(app.handle());
            let (capture_sc, capture_accel) = parse_hotkey_or(&cfg.capture, ACCEL_CAPTURE);
            let (notebook_sc, notebook_accel) = parse_hotkey_or(&cfg.notebook, ACCEL_NOTEBOOK);
            app.manage(HotkeyState(Mutex::new(HotkeyRuntime {
                capture: capture_sc,
                capture_accel: capture_accel.clone(),
                notebook: notebook_sc,
                notebook_accel: notebook_accel.clone(),
            })));

            // 注册失败一律不拖垮启动。热键只是「从任何地方唤起」的便利,托盘「打开朱简」和
            // 窗口内入口都在;撞键(会议/输入法类软件常年占用 Ctrl+Alt+M/N)不该让整个 app
            // 进不去。此前 Win/mac 用 `?` fail-fast——撞键即弹「朱简无法启动」、连托盘都摸不到,
            // 是最坏结局;现对齐 Linux(progress-log 215)只记一笔、留退路(232 起并可去设置改键)。
            let mut failed: Vec<String> = Vec::new();
            for (sc, name) in [(capture_sc, &capture_accel), (notebook_sc, &notebook_accel)] {
                if let Err(e) = app.global_shortcut().register(sc) {
                    log::error!(
                        "全局热键 {name} 注册失败(可能被其它程序占用,退回托盘/窗口入口):{e}"
                    );
                    failed.push(name.clone());
                }
            }
            // Win/mac:撞键=真实键位冲突(第三方软件占用该键),把失效的键交给捕获窗内那条
            // 非模态提示条(启动时唯一可见的窗就是捕获窗)——「点此改键」一下直达设置面板,
            // 比原生模态框既不突兀又能顺手修好;只在真占用时现,正常启动不打扰。
            // Linux:注册失败多是 Wayland 平台限制(XGrabKey 抓不到、非用户可改的键位冲突),
            // 改键也没用、每次启动都提示会烦 → 不 surface,只留上面日志。
            if cfg!(target_os = "linux") {
                failed.clear();
            }
            // 填进上面已提前 manage 的名单(不能再 manage 第二次 = 会 panic「already managed」)。
            *app.state::<HotkeyConflicts>()
                .0
                .lock()
                .expect("hotkey conflicts") = failed;

            // 合成器探测(Linux,见 `wm_composited`):setup 跑在主线程、且窗口都已建好
            // (GDK 必然初始化过),是唯一能安全问 GDK 的地方——命令跑在异步运行时线程上,
            // 在那儿碰 GDK 就是 394 那次 abort。量到的结论存进静态,前端用命令来取。
            // screen 为 NULL = GDK 没初始化,理论上到不了这;真到了也没有比「按今天的样子
            // 继续」更好的处置(改外观要有把握,没有把握就别改),故只响亮记一行。
            #[cfg(target_os = "linux")]
            {
                let composited = unsafe {
                    let screen = gdk_screen_get_default();
                    if screen.is_null() {
                        log::error!(
                            "gdk_screen_get_default() 返回 NULL —— 合成器探测跳过,按「有合成器」处理"
                        );
                        true
                    } else {
                        gdk_screen_is_composited(screen) != 0
                    }
                };
                WM_COMPOSITED.store(composited, Ordering::Relaxed);
                if !composited {
                    log::warn!(
                        "桌面没有合成器:捕获浮窗的透明底会被前端换成不透明纸色(否则那一圈是黑的)"
                    );
                }
            }

            // The notebook is the single browse/manage window — a panel, not a
            // doc. Closing it should hide it (so the next summon works), not
            // destroy it. (capture has no such handler — it's always re-shown.)
            let notebook = app
                .get_webview_window("notebook")
                .expect("notebook window must exist");
            // 窗口装饰分平台:config 里 notebook 开了 decorations + titleBarStyle Overlay,
            // 让 macOS 显示系统原生红绿灯(左上角);Windows/Linux 无红绿灯、用前端自绘按钮,
            // 运行时把原生边框关掉回到无边框态。窗口启动即隐藏(visible:false),此刻关无闪烁。
            #[cfg(not(target_os = "macos"))]
            let _ = notebook.set_decorations(false);
            // mac 原生窗口阴影:config 的 shadow:false 是为 Windows/Linux 无边框态保留,
            // 这里只在 mac 运行时开启——原生阴影 + 系统窗口边,是「与同色背景区分」的地道办法
            // (mac 上前端自绘的方形外框线 body::after 已隐,见 notebook.html)。
            #[cfg(target_os = "macos")]
            let _ = notebook.set_shadow(true);
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
            // Linux:appindicator 菜单经 DBusMenu 序列化,muda 传给 MenuItem 的 accelerator
            // 是挂到 GTK 窗口 accel_group(菜单栏用)、不进 DBusMenu,故 GNOME 托盘菜单不显示
            // 快捷键——把快捷键文本焊进标签补上(Win/mac 由第 5 参原生渲染,标签不含,免重复)。
            // 键名跟着当前生效的热键走(232 可改),故用上面从配置解析出的 accel 串、不再用常量。
            #[cfg(target_os = "linux")]
            let (show_label, notebook_label) = (
                format!("记一笔  ({capture_accel})"),
                format!("打开朱简  ({notebook_accel})"),
            );
            #[cfg(not(target_os = "linux"))]
            let (show_label, notebook_label) = ("记一笔".to_string(), "打开朱简".to_string());
            let show_item =
                MenuItem::with_id(app, "show", &show_label, true, Some(capture_accel.as_str()))?;
            let notebook_item = MenuItem::with_id(
                app,
                "notebook",
                &notebook_label,
                true,
                Some(notebook_accel.as_str()),
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &notebook_item, &quit_item])?;
            // 句柄留一份给 set_hotkey 改键后刷新显示的键名。
            app.manage(TrayHotkeyItems {
                show: show_item.clone(),
                notebook: notebook_item.clone(),
            });
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

            // macOS Dock 右键菜单(§2 的 b):与托盘菜单同两项、同用词,路由回同一对
            // show_window/open_notebook。Windows/Linux 无 Dock,整段 cfg 掉。
            #[cfg(target_os = "macos")]
            dock_menu::install(app.handle());

            // D1(411,408 走查「首用极简」桌面半):首用者只看得见捕获条,主窗存在感
            // 为零——记完第一条,东西去哪了全靠猜(主窗入口只有托盘双击 / Ctrl+Alt+M,
            // 两个都零指引)。空库时把主窗也显一次:用户一眼看见「记下的东西住在哪」,
            // 且**不加任何常驻 UI**——与安卓 A1「回收站/归档册空则不渲染那枚钮」(410)
            // 同一手法(按数据显形)。有任何一条记录在场就不再弹,主窗照旧只由托盘/热键唤起。
            // ⭐ 顺序即焦点:先主窗后捕获条,焦点最终落在捕获条上(它还 alwaysOnTop),
            // 主窗安静地待在它身后——「记一笔」仍是启动后第一个能打字的地方,没被抢走。
            // ⚠ 不记「是不是第一次启动」的旗:清空库后再指一次路无害,而多一份要落盘、
            // 要跨设备想清楚语义的状态不值(设计铁律:不加中间态)。
            if empty_library {
                open_notebook(app.handle());
            }
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
            list_board_columns,
            create_board_column,
            rename_board_column,
            reorder_board_column,
            delete_board_column,
            board_column_gate,
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
            add_task_topic_by_title,
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
            get_item_thumb,
            put_item_thumb,
            delete_item_image,
            add_item_comment,
            delete_item_comment,
            list_item_comments,
            item_comment_counts,
            mark_item_comments_seen,
            sync_status,
            sync_create_account,
            sync_pair_start,
            sync_device_admin,
            sync_roster_refresh,
            sync_pair_join,
            join_space,
            join_space_cancel,
            sync_set_server,
            sync_recovery_code,
            list_spaces,
            create_space,
            reset_space,
            rename_space,
            device_identity,
            set_device_alias,
            move_item_to_space,
            get_hotkeys,
            set_hotkey,
            hotkey_conflicts,
            wm_composited,
            open_settings,
            take_open_settings,
            backup_status,
            backup_begin_setup,
            backup_confirm_setup,
            backup_cancel_setup,
            backup_set_dir,
            backup_run,
            backup_retry_cleanup,
            backup_open_dir,
            backup_list,
            backup_verify,
            backup_restore,
            backup_auto_status,
            backup_set_auto,
            backup_reset_auto
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // macOS:点 Dock 图标(app 已在跑)= 打开主窗。RunEvent::Reopen 是 macOS 专属
            // (Windows/Linux 无 Dock);不处理时主窗被关(隐藏)后点 Dock 没反应。
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                open_notebook(_app_handle);
            }
        });
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

    // ── 可改热键(232/233)────────────────────────────────────────────

    #[test]
    fn default_hotkey_accels_parse() {
        // parse_hotkey_or 对平台默认串 expect() 解析成功;若日后改 ACCEL_* 常量打错字,
        // 启动会 panic 在 setup——用测试提前抓,别等发版后用户崩在启动。
        let cap: Shortcut = ACCEL_CAPTURE.parse().expect("ACCEL_CAPTURE 必可解析");
        let nb: Shortcut = ACCEL_NOTEBOOK.parse().expect("ACCEL_NOTEBOOK 必可解析");
        assert_ne!(cap, nb, "捕获/主窗默认键必须不同");
    }

    #[test]
    fn parse_hotkey_or_keeps_valid_accel() {
        let (sc, accel) = parse_hotkey_or("Ctrl+Alt+K", ACCEL_CAPTURE);
        assert_eq!(accel, "Ctrl+Alt+K");
        assert_eq!(sc, "Ctrl+Alt+K".parse::<Shortcut>().unwrap());
    }

    #[test]
    fn parse_hotkey_or_falls_back_on_garbage() {
        // 坏的存量串(手改坏了 .hotkeys.json / 老格式)不该让热键失效,静默退回默认键。
        let (sc, accel) = parse_hotkey_or("Ctrl+Alt+ZZZ", ACCEL_NOTEBOOK);
        assert_eq!(accel, ACCEL_NOTEBOOK);
        assert_eq!(sc, ACCEL_NOTEBOOK.parse::<Shortcut>().unwrap());
    }
}
