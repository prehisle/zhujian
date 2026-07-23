//! Thin data-access layer. Pure SQL over rusqlite — no business logic, no AI.
//!
//! Single-entity model (migration 0014): one `items` table where 想法 and 待办 are
//! stages of the SAME subject, not two rows.
//!   * `stage` ∈ idea stages (inbox 未归类, filed 已归类) | task stages (todo, doing,
//!     confirming, done);
//!   * `archived_at` is the 回收站 axis — a frozen stage (restore returns to it);
//!   * tags are M:N via `item_topic` (ideas AND tasks alike);
//!   * edit history is `item_revisions` (the 0014 trigger covers EVERY stage).
//! Converting 想法 -> 待办 flips `stage` (zero copy); 撤回 flips it back.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use ulid::Ulid;

use crate::frindex;

/// The four board (task) stages as a SQL list literal — `stage IN (...)`. A fixed
/// constant from this module, never user input.
const TASK_STAGES: &str = "('todo', 'doing', 'confirming', 'done')";
/// The two idea stages as a SQL list literal.
const IDEA_STAGES: &str = "('inbox', 'filed')";

/// 单条正文/标题的字节上限(P2-g,codex 轮 M 级):正文全文进同步 op(set_field
/// payload),服务器帧硬上限 1 MiB——超限的 op 上不了通道,发送端会反复断连、该设备
/// 的出站从此卡死。200 KB(约 6 万字)远离红线且远超正常使用;超了 fail-fast 拒绝,
/// 不静默截断(截断=改写用户的话)。
pub(crate) const MAX_CONTENT_BYTES: usize = 200 * 1024;

/// 编排层入口的正文长度守卫(capture/edit/转待办标题/任务建改名/标签名共用)。
pub(crate) fn ensure_content_fits(text: &str) -> Result<(), String> {
    if text.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "内容太长({} 字节,上限 {} 字节、约 6 万字)——超长文本请拆条或存文件",
            text.len(),
            MAX_CONTENT_BYTES
        ));
    }
    Ok(())
}

/// Current UTC time as an RFC3339 string — the canonical timestamp format.
/// pub(crate):sync/boot.rs 的引导完成标记(bootstrapped_at)用同一格式。
pub(crate) fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC3339 formatting of a valid OffsetDateTime cannot fail")
}

/// A bare item row (id + text + capture time): the Inbox list and topic-tree children.
pub struct ItemRow {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

/// An organized idea (已整理 / 灵感回收站): the text, capture time, and the titles of
/// every tag it carries (quiet chips). The two-entity `has_task` flag is gone — a
/// task is no longer a separate row, so an idea-stage item simply is not a task.
/// `stage` (inbox/filed) rides along because it — not the tag count — is the axis the
/// delete guards enforce: a filed idea whose last tag died is still filed, and the UI
/// must route its 删除 to the soft path, not guess from the (empty) chips.
pub struct OrganizedRow {
    pub id: String,
    pub content: String,
    pub created_at: String,
    pub stage: String,
    /// This idea's tags (each id + title + optional color), for chip display + tint.
    pub topics: Vec<TagRef>,
}

/// A tag reference (id + title + color) carried by a board card — the board needs the
/// id to filter/locate, and the optional color (`#RRGGBB` or None = 无色) to tint the
/// on-card chip for at-a-glance scanning.
pub struct TagRef {
    pub id: String,
    pub title: String,
    pub color: Option<String>,
}

/// 统一时间轴的一行(安卓 v1「记+看+勾」,android-plan §2):任何未进回收站、未入
/// 成就册的条目,不分灵感/任务。刻意不复用 OrganizedRow——那是灵感行的语义;时间轴
/// 行可以处于全部六个 stage,借名会让任务行撒谎(96 增量必改①)。
pub struct TimelineRow {
    pub id: String,
    pub content: String,
    pub created_at: String,
    /// 六个 stage 之一,原样透传——时间轴的 stage 标识与「可勾/已勾」判定都由它派生。
    pub stage: String,
    /// 120 起随行带出(安卓卡片操作面板要显示当前真值——面板另拼一次 list_tasks
    /// 是两次 SELECT 非同一快照;灵感行恒 NULL)。
    pub due_on: Option<String>,
    pub priority: Option<i64>,
    /// 完成时刻(0030 done_at):安卓主卡走 live_timeline,done 行据它显示「完成于」;
    /// 灵感行 / 未完成任务行 = None。只增不清(见 TaskRow.done_at)。
    pub done_at: Option<String>,
    pub topics: Vec<TagRef>,
}

/// 统一回收站的一行(120 安卓:灵感+任务合并一屏)。`stage` 是冻结在入站前的
/// 原 stage(恢复回到哪由它定、类型印由它派生);`archived_at` 是跨两类的排序轴
/// ——壳层拼 idea_trash+archived_tasks 两次 SELECT 既非同一快照、也没有可比的
/// 删除时间(codex 120 设计审 M3),故单查询单快照在此。
pub struct TrashRow {
    pub id: String,
    pub content: String,
    pub created_at: String,
    pub archived_at: String,
    pub stage: String,
    pub topics: Vec<TagRef>,
}

/// A board card: a task-stage item plus its column (`stage`), schedule hints, and its
/// tags (M:N now — a task may carry several). `due_on` is a user-local calendar day
/// (`YYYY-MM-DD`) or None; `priority` is None (未设) or 1/2/3 (低/中/高).
pub struct TaskRow {
    pub id: String,
    pub content: String,
    pub stage: String,
    pub due_on: Option<String>,
    pub priority: Option<i64>,
    /// 成就归档时间(0017 sealed_at 轴):Some = 已入归档册(不在看板上)。活跃看板行与
    /// 回收站行恒 None(两轴互斥)。归档视图按它做时间轴分组。
    pub sealed_at: Option<String>,
    /// 完成时刻(0030 done_at 轴):Some = 最近一次真正进入 done 的时刻,None = 未知
    /// (本功能上线前完成的老卡)。只增不清——离开 done / 归档 / 撤回都保住。看板「已完成」
    /// 卡显示「完成于」,归档册按 COALESCE(done_at, sealed_at) 分组/排序(完成日优先)。
    pub done_at: Option<String>,
    pub topics: Vec<TagRef>,
}

/// A superseded version of an item's text, with when it stopped being current.
pub struct RevisionRow {
    pub content: String,
    pub archived_at: String,
}

/// An existing topic (tag), for the manual "file into a topic" picker. `color` is the
/// optional chip tint (`#RRGGBB` or None = 无色). `position` is the manual-order frindex
/// key (0031; None = 未定序,排序回落 updated_at);`kind` is the optional free-text
/// type label (0031; None = 无类型,可标「人名」等供日后按类型筛选).
pub struct TopicRow {
    pub id: String,
    pub title: String,
    pub color: Option<String>,
    pub position: Option<String>,
    pub kind: Option<String>,
}

/// One topic with the organized (filed) ideas under it — the unit of the 按主题浏览 /
/// 标签管理 views. Task-stage items are NOT included here (they live on the board); the
/// tag drill-down that pulls ideas+tasks together is composed in the frontend.
pub struct TopicTree {
    pub id: String,
    pub title: String,
    /// Optional chip tint (`#RRGGBB` or None = 无色).
    pub color: Option<String>,
    /// 手动排序键(0031 frindex;None = 未定序)。标签视图拖排序据它,列表按它排。
    pub position: Option<String>,
    /// 标签类型自由文本(0031;None = 无类型)。标签视图可设/清,供日后按类型筛选。
    pub kind: Option<String>,
    pub notes: Vec<ItemRow>,
}

/// One search hit: an item whose current text OR any superseded version matched,
/// carrying enough to place it — its view (`status`) and tag titles. `status` maps the
/// underlying stage/archived axis onto the frontend's vocabulary: `inbox` / `processed`
/// (= filed) / `task` (any board stage) / `archived` (回收站, either kind).
pub struct SearchHit {
    pub id: String,
    pub content: String,
    pub created_at: String,
    pub status: String,
    pub topics: Vec<String>,
}

/// Map an item's (stage, archived?, sealed?) onto the frontend search vocabulary.
/// `sealed`(成就归档)先于 stage 读出 —— 已归档的任务不在看板上,不能报成 "task"。
/// 两轴互斥(0017 触发器守),顺序只是形式。
fn view_status(stage: &str, archived: bool, sealed: bool) -> &'static str {
    if sealed {
        "sealed"
    } else if archived {
        "archived"
    } else {
        match stage {
            "inbox" => "inbox",
            "filed" => "processed",
            _ => "task",
        }
    }
}

/// Escape the LIKE metacharacters in a user query so it matches literally.
fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// ---- Capture --------------------------------------------------------------------

/// Capture a raw thought into the Inbox (stage 'inbox'). Returns the new item's ULID.
/// born_stage 如实记 'inbox'(出生态史实,0018 触发器强制且冻结)。
pub fn add_item(conn: &Connection, content: &str) -> rusqlite::Result<String> {
    let id = Ulid::new().to_string();
    let now = now_iso();
    conn.execute(
        "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage) \
         VALUES (?1, ?2, 'inbox', ?3, ?3, 'inbox')",
        (&id, content, &now),
    )?;
    Ok(id)
}

// ---- Idea-side reads ------------------------------------------------------------

/// All items still in the Inbox (未归类灵感), oldest first.
pub fn inbox_items(conn: &Connection) -> rusqlite::Result<Vec<ItemRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, content, created_at FROM items \
         WHERE stage = 'inbox' AND archived_at IS NULL ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ItemRow { id: r.get(0)?, content: r.get(1)?, created_at: r.get(2)? })
    })?;
    rows.collect()
}

/// Items matching `where_sql` (alias `i`), ordered by `order_sql`, each with its tag
/// titles. Built from two small reads (items / item_topic⋈topics) grouped in memory —
/// tag titles are free text that could contain any GROUP_CONCAT separator. The two
/// predicates are fixed literals from this module, never user input.
fn organized_rows(
    conn: &Connection,
    where_sql: &str,
    order_sql: &str,
) -> rusqlite::Result<Vec<OrganizedRow>> {
    let mut topics_by_item: std::collections::HashMap<String, Vec<TagRef>> =
        std::collections::HashMap::new();
    {
        let sql = format!(
            "SELECT it.item_id, t.id, t.title, t.color FROM item_topic it \
             JOIN topics t ON t.id = it.topic_id \
             JOIN items i ON i.id = it.item_id \
             WHERE {where_sql} ORDER BY t.position IS NULL, t.position, t.updated_at, t.id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, TagRef { id: r.get(1)?, title: r.get(2)?, color: r.get(3)? }))
        })?;
        for row in rows {
            let (item_id, tag) = row?;
            topics_by_item.entry(item_id).or_default().push(tag);
        }
    }

    let sql = format!(
        "SELECT i.id, i.content, i.created_at, i.stage FROM items i \
         WHERE {where_sql} ORDER BY {order_sql}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, content, created_at, stage) = row?;
        let topics = topics_by_item.remove(&id).unwrap_or_default();
        out.push(OrganizedRow { id, content, created_at, stage, topics });
    }
    Ok(out)
}

/// Organized ideas for the 已整理 tab (stage 'filed', not archived), newest first.
pub fn filed_items(conn: &Connection) -> rusqlite::Result<Vec<OrganizedRow>> {
    organized_rows(conn, "i.stage = 'filed' AND i.archived_at IS NULL", "i.created_at DESC")
}

/// Every live idea — 未归类 + 已归类 together (idea-stage, not archived), newest first,
/// each with its tag titles. Backs the merged 灵感 list: tags are just metadata, so the
/// view no longer splits inbox vs filed. An untagged idea carries an empty `topics`.
pub fn live_ideas(conn: &Connection) -> rusqlite::Result<Vec<OrganizedRow>> {
    organized_rows(
        conn,
        &format!("i.stage IN {IDEA_STAGES} AND i.archived_at IS NULL"),
        "i.created_at DESC",
    )
}

/// 灵感流转统计的原料(全是派生数,只算不存;见 0018)。
/// 只统计出生态已知的行(born_stage='inbox');0018 之前的老行 NULL=未知,诚实排除。
pub struct IdeaStats {
    /// 本周捕获的灵感数:born_stage='inbox' 且 created_at >= week_start。捕获是出生
    /// 事件、是史实——之后转了待办/进了回收站照算(inbox 硬删的行不在库里,自然不算)。
    pub captured_week: i64,
    /// 生而为灵感的总数(转待办比例的分母)。
    pub born_inbox: i64,
    /// 其中现在处于任务态的条数(分子)——含回收站里冻结在任务态的、已入成就册的:
    /// 「转过待办」是它们共同的经历。
    pub converted: i64,
}

/// `week_start` 是前端按本地周一 00:00 换算的 UTC RFC3339(后端从不算本地时间,同
/// due_on 的哲学);created_at 同为 RFC3339 UTC,字典序比较即时间序。
pub fn idea_stats(conn: &Connection, week_start: &str) -> rusqlite::Result<IdeaStats> {
    conn.query_row(
        &format!(
            "SELECT COUNT(*) FILTER (WHERE created_at >= ?1), \
                    COUNT(*), \
                    COUNT(*) FILTER (WHERE stage IN {TASK_STAGES}) \
             FROM items WHERE born_stage = 'inbox'"
        ),
        [week_start],
        |r| Ok(IdeaStats { captured_week: r.get(0)?, born_inbox: r.get(1)?, converted: r.get(2)? }),
    )
}

/// Archived ideas for the 灵感回收站 (idea-stage items in the 回收站), most-recently
/// trashed first.
pub fn idea_trash(conn: &Connection) -> rusqlite::Result<Vec<OrganizedRow>> {
    organized_rows(
        conn,
        &format!("i.stage IN {IDEA_STAGES} AND i.archived_at IS NOT NULL"),
        "i.archived_at DESC",
    )
}

// ---- Unified timeline(安卓 v1「记+看+勾」)---------------------------------------

/// 统一时间轴:全部活条目(排除回收站与成就归档、全 stage),新→旧;同一 created_at
/// 按 id DESC 打平(确定性 tie-break,ULID 同毫秒不保证时间序、只保证稳定)。单一
/// 查询入口(96 增量必改①):一条 LEFT JOIN 单语句即单快照,标签在 Rust 侧按相邻行
/// 分组——拒在壳层拼 list_ideas+list_tasks(两次 SELECT 非同一快照,TaskRow 也没有
/// created_at)。标签顺序与 organized_rows 同轴(0031 起手动序 t.position,未定序回落
/// t.updated_at;末键 t.id 把同刻/同键的 chip 顺序也钉死)。
pub fn live_timeline(conn: &Connection) -> rusqlite::Result<Vec<TimelineRow>> {
    let mut stmt = conn.prepare(
        "SELECT i.id, i.content, i.created_at, i.stage, i.due_on, i.priority, i.done_at, \
                t.id, t.title, t.color \
         FROM items i \
         LEFT JOIN item_topic it ON it.item_id = i.id \
         LEFT JOIN topics t ON t.id = it.topic_id \
         WHERE i.archived_at IS NULL AND i.sealed_at IS NULL \
         ORDER BY i.created_at DESC, i.id DESC, t.position IS NULL, t.position, t.updated_at, t.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, Option<String>>(9)?,
        ))
    })?;
    let mut out: Vec<TimelineRow> = Vec::new();
    for row in rows {
        let (id, content, created_at, stage, due_on, priority, done_at, tag_id, tag_title, tag_color) =
            row?;
        // 同一条目的标签行必然相邻(前两个排序键完全相同),条目 id 一换就开新行。
        if out.last().map(|last| last.id != id).unwrap_or(true) {
            out.push(TimelineRow {
                id,
                content,
                created_at,
                stage,
                due_on,
                priority,
                done_at,
                topics: Vec::new(),
            });
        }
        if let Some(tag_id) = tag_id {
            let title = tag_title.expect("topics.title NOT NULL,与 t.id 来自同一匹配行");
            let row = out.last_mut().expect("上面刚保证过至少一行");
            row.topics.push(TagRef { id: tag_id, title, color: tag_color });
        }
    }
    Ok(out)
}

/// 统一回收站(120 安卓:灵感+任务合并一屏,最近删除在前)。单一 LEFT JOIN 单快照,
/// 标签相邻分组与 live_timeline 同一手法;`archived_at DESC, id DESC` 全局可比的
/// 删除时间轴(同刻并列按 id 打平)。
pub fn trash_items(conn: &Connection) -> rusqlite::Result<Vec<TrashRow>> {
    let mut stmt = conn.prepare(
        "SELECT i.id, i.content, i.created_at, i.archived_at, i.stage, t.id, t.title, t.color \
         FROM items i \
         LEFT JOIN item_topic it ON it.item_id = i.id \
         LEFT JOIN topics t ON t.id = it.topic_id \
         WHERE i.archived_at IS NOT NULL \
         ORDER BY i.archived_at DESC, i.id DESC, t.position IS NULL, t.position, t.updated_at, t.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
        ))
    })?;
    let mut out: Vec<TrashRow> = Vec::new();
    for row in rows {
        let (id, content, created_at, archived_at, stage, tag_id, tag_title, tag_color) = row?;
        if out.last().map(|last| last.id != id).unwrap_or(true) {
            out.push(TrashRow { id, content, created_at, archived_at, stage, topics: Vec::new() });
        }
        if let Some(tag_id) = tag_id {
            let title = tag_title.expect("topics.title NOT NULL,与 t.id 来自同一匹配行");
            let row = out.last_mut().expect("上面刚保证过至少一行");
            row.topics.push(TagRef { id: tag_id, title, color: tag_color });
        }
    }
    Ok(out)
}

/// 一次删空整个回收站(全 stage,120 统一清空的存储原语)。0004 触发器仍在场守
/// 「只有已归档可硬删」——WHERE 天然满足;返回删除行数供编排层与点名数核对。
pub fn purge_all_trash(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM items WHERE archived_at IS NOT NULL", [])
}

/// Full-text-ish search over EVERY item — current text or any superseded version
/// (history) — across all stages and the 回收站, newest first. A literal
/// case-insensitive substring match via LIKE (right for CJK; a table scan is plenty at
/// single-user scale). A promoted idea is one item now, so searching its original text
/// (kept in history when the title diverged) still finds it. Each hit carries its view
/// `status` + tag titles so the result can be placed.
pub fn search_items(conn: &Connection, query: &str) -> rusqlite::Result<Vec<SearchHit>> {
    let pattern = format!("%{}%", escape_like(query));

    // matched items: current content matches, OR any revision of it matches.
    let matched: Vec<(String, String, String, String, Option<String>, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT i.id, i.content, i.created_at, i.stage, i.archived_at, i.sealed_at FROM items i \
             WHERE i.content LIKE ?1 ESCAPE '\\' \
                OR EXISTS (SELECT 1 FROM item_revisions r \
                           WHERE r.item_id = i.id AND r.content LIKE ?1 ESCAPE '\\') \
             ORDER BY i.created_at DESC",
        )?;
        let rows = stmt.query_map([&pattern], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if matched.is_empty() {
        return Ok(Vec::new());
    }
    let ids: std::collections::HashSet<&str> = matched.iter().map(|m| m.0.as_str()).collect();

    let mut topics_by_item: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT it.item_id, t.title FROM item_topic it \
             JOIN topics t ON t.id = it.topic_id \
             ORDER BY t.position IS NULL, t.position, t.updated_at, t.id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (item_id, title) = row?;
            if ids.contains(item_id.as_str()) {
                topics_by_item.entry(item_id).or_default().push(title);
            }
        }
    }

    Ok(matched
        .into_iter()
        .map(|(id, content, created_at, stage, archived_at, sealed_at)| {
            let status =
                view_status(&stage, archived_at.is_some(), sealed_at.is_some()).to_string();
            let topics = topics_by_item.remove(&id).unwrap_or_default();
            SearchHit { id, content, created_at, status, topics }
        })
        .collect())
}

// ---- Item state / content / history ---------------------------------------------

/// An item's (stage, archived?) — the spine of every orchestration guard. None if the
/// item does not exist.
pub fn item_state(conn: &Connection, id: &str) -> rusqlite::Result<Option<(String, bool)>> {
    conn.query_row(
        "SELECT stage, archived_at FROM items WHERE id = ?1",
        [id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.is_some())),
    )
    .optional()
}

/// An item's current stage (ignores the archived axis), or None if missing. Used by
/// restore to target the frozen column.
pub fn item_stage(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT stage FROM items WHERE id = ?1", [id], |r| r.get(0))
        .optional()
}

/// The current text of one item, or None if it does not exist.
pub fn current_content(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT content FROM items WHERE id = ?1", [id], |r| r.get(0))
        .optional()
}

/// 一条 item 的三根定位轴:stage + 是否在回收站(archived)+ 是否已归档(sealed)。
/// None = 该 id 在本空间不存在。深链接据此在正确的视图里定位并高亮(分类口径与搜索
/// jump 一致,归属判断留给调用方——repo 只如实取列)。
pub fn item_axes(conn: &Connection, id: &str) -> rusqlite::Result<Option<(String, bool, bool)>> {
    conn.query_row(
        "SELECT stage, archived_at IS NOT NULL, sealed_at IS NOT NULL FROM items WHERE id = ?1",
        [id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, bool>(2)?)),
    )
    .optional()
}

/// Overwrite an item's text, bumping updated_at. The 0014 `trg_item_archive_on_edit`
/// trigger snapshots the prior version into `item_revisions` first, so history is kept
/// by the database itself — no caller can bypass it, on any stage. Returns rows updated.
pub fn update_item_content(conn: &Connection, id: &str, content: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE items SET content = ?2, updated_at = ?3 WHERE id = ?1",
        (id, content, now_iso()),
    )
}

/// Rename an active (on-board, non-archived) task — a guarded content edit. The
/// `stage IN task / archived_at IS NULL` guard makes an idea-stage, archived, or missing
/// item a 0-row no-op the caller fails fast on; the history trigger still fires. Returns
/// rows changed.
pub fn rename_task(conn: &Connection, id: &str, content: &str) -> rusqlite::Result<usize> {
    let sql = format!(
        "UPDATE items SET content = ?2, updated_at = ?3 \
         WHERE id = ?1 AND stage IN {TASK_STAGES} AND archived_at IS NULL AND sealed_at IS NULL"
    );
    conn.execute(&sql, (id, content, now_iso()))
}

/// An item's superseded versions, newest-archived first (its edit history). Ordered by
/// the monotonic revision_id so same-millisecond edits still sort correctly.
pub fn item_revisions(conn: &Connection, id: &str) -> rusqlite::Result<Vec<RevisionRow>> {
    let mut stmt = conn.prepare(
        "SELECT content, archived_at FROM item_revisions WHERE item_id = ?1 ORDER BY revision_id DESC",
    )?;
    let rows = stmt.query_map([id], |r| {
        Ok(RevisionRow { content: r.get(0)?, archived_at: r.get(1)? })
    })?;
    rows.collect()
}

// ---- Hard delete (Inbox junk) ---------------------------------------------------

/// Hard-delete an Inbox item (manual cleanup of junk). The `stage = 'inbox'` guard
/// matches the 0014 delete-guard trigger: only an unorganized, unarchived capture can
/// be destroyed outright — anything else must go through the 回收站. A non-inbox or
/// missing id matches 0 rows and the caller fails fast.
pub fn delete_inbox_item(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM items WHERE id = ?1 AND stage = 'inbox' AND archived_at IS NULL",
        [id],
    )
}

// ---- Stage flips: 转待办 / 撤回 / file ---------------------------------------------

/// 转待办: flip an idea (stage inbox/filed) to a 'todo', landing it at the FRONT of the
/// 待办 column (same as the board's 新建任务) — a fractional key before the current first
/// card, one write, no renumbering. The `stage IN idea / archived_at IS NULL` guard
/// rejects an already-task, archived, or missing item as a 0-row no-op. due/priority
/// stay NULL (idea attrs were none). Returns rows changed.
pub fn promote_to_todo(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let key = front_key(conn, "todo", id)?;
    let sql = format!(
        "UPDATE items SET stage = 'todo', updated_at = ?2, position = ?3 \
         WHERE id = ?1 AND stage IN {IDEA_STAGES} AND archived_at IS NULL"
    );
    conn.execute(&sql, (id, now_iso(), key))
}

/// 撤回为灵感: flip a 'todo' back to an idea stage (`to_stage` = 'filed' if it still
/// carries a tag, else 'inbox' — the caller decides). Clears the task-only attributes
/// (position/due/priority) the idea stages forbid (the row CHECKs require them NULL).
/// The `stage = 'todo' / archived_at IS NULL` guard rejects a more-mature or archived
/// task. Returns rows changed.
pub fn revert_to_idea(conn: &Connection, id: &str, to_stage: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE items SET stage = ?2, updated_at = ?3, \
                position = NULL, due_on = NULL, priority = NULL \
         WHERE id = ?1 AND stage = 'todo' AND archived_at IS NULL",
        (id, to_stage, now_iso()),
    )
}

/// Move an Inbox item into 已整理 (stage inbox -> filed) — the 0-tag entry point used
/// when filing it under its first tag. The `stage = 'inbox'` guard makes an
/// already-filed/task/archived/missing item a 0-row no-op. Returns rows changed.
pub fn file_inbox_item(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE items SET stage = 'filed', updated_at = ?2 \
         WHERE id = ?1 AND stage = 'inbox' AND archived_at IS NULL",
        (id, now_iso()),
    )
}

/// Move a 已整理 item back to 未归类 (stage filed -> inbox) — the inverse of
/// `file_inbox_item`, used when its LAST tag is removed. The `stage = 'filed'` guard makes
/// an inbox/task/archived/missing item a 0-row no-op. Returns rows changed.
pub fn unfile_item(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE items SET stage = 'inbox', updated_at = ?2 \
         WHERE id = ?1 AND stage = 'filed' AND archived_at IS NULL",
        (id, now_iso()),
    )
}

// ---- Tags (item_topic, M:N) -----------------------------------------------------

/// Insert a new topic (tag); returns its ULID.
pub fn insert_topic(conn: &Connection, title: &str) -> rusqlite::Result<String> {
    let id = Ulid::new().to_string();
    let now = now_iso();
    conn.execute(
        "INSERT INTO topics (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        (&id, title, &now),
    )?;
    Ok(id)
}

/// Whether a topic id exists.
pub fn topic_exists(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT 1 FROM topics WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
}

/// The id of an existing topic whose (trimmed) title equals `title`, if any. Tag names are
/// unique — callers use this to reject a duplicate (create/rename) or reuse it (tag-apply)
/// instead of minting a second topic with the same name.
pub fn topic_id_by_title(conn: &Connection, title: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT id FROM topics WHERE title = ?1", [title.trim()], |r| r.get(0))
        .optional()
}

/// Tag an item with a topic. Plain INSERT — a duplicate pair is a real error (the
/// caller dedups first for idempotent paths); a non-existent topic id fails the FK.
pub fn link_item_topic(conn: &Connection, item_id: &str, topic_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO item_topic (item_id, topic_id) VALUES (?1, ?2)",
        (item_id, topic_id),
    )?;
    Ok(())
}

/// Remove ONE specific tag from an item (multi-tag). Returns rows removed (0 if the
/// item did not carry that tag — the caller treats that as an idempotent no-op).
pub fn unlink_item_topic(conn: &Connection, item_id: &str, topic_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM item_topic WHERE item_id = ?1 AND topic_id = ?2",
        (item_id, topic_id),
    )
}

/// Whether an item currently carries any tag. After a 撤回, a tagged item lands in 已整理
/// (filed); an untagged one returns to 未归类 (inbox).
pub fn item_has_topic(conn: &Connection, item_id: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT 1 FROM item_topic WHERE item_id = ?1 LIMIT 1", [item_id], |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
}

/// Whether an item already carries one SPECIFIC tag (so an add can be an idempotent
/// no-op without relying on catching the duplicate-key error).
pub fn item_has_tag(conn: &Connection, item_id: &str, topic_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM item_topic WHERE item_id = ?1 AND topic_id = ?2",
        (item_id, topic_id),
        |_| Ok(()),
    )
    .optional()
    .map(|o| o.is_some())
}

/// Every item id currently tagged with `topic_id` (any stage/axis), in stable id order.
/// The merge orchestration reads this BEFORE re-pointing so it can emit one op per moved
/// link — a bulk INSERT-SELECT only reports counts, not identities.
pub fn topic_item_ids(conn: &Connection, topic_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT item_id FROM item_topic WHERE topic_id = ?1 ORDER BY item_id")?;
    let rows = stmt.query_map([topic_id], |r| r.get(0))?;
    rows.collect()
}

/// Re-point every item_topic link from `source` to `target` as a set-union (a single
/// uniform pass now that ideas AND tasks tag through item_topic): an item already under
/// `target` keeps its one link (NOT EXISTS guard), the rest move over, then the source's
/// links are dropped. Returns how many source links were removed.
pub fn repoint_item_topic(conn: &Connection, source: &str, target: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO item_topic (item_id, topic_id) \
         SELECT item_id, ?2 FROM item_topic \
         WHERE topic_id = ?1 \
           AND NOT EXISTS ( \
             SELECT 1 FROM item_topic x WHERE x.item_id = item_topic.item_id AND x.topic_id = ?2 \
           )",
        (source, target),
    )?;
    conn.execute("DELETE FROM item_topic WHERE topic_id = ?1", [source])
}

/// Delete a topic by id; returns rows removed. Its item_topic links cascade away
/// (ON DELETE CASCADE) — every tagged item (idea OR task) simply loses this tag; the
/// items themselves are untouched. In a merge, `repoint_item_topic` runs first so no
/// link still points here.
pub fn delete_topic(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM topics WHERE id = ?1", [id])
}

/// Rename a topic and stamp updated_at. Returns rows hit.
pub fn rename_topic(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE topics SET title = ?2, updated_at = ?3 WHERE id = ?1",
        (id, title, &now_iso()),
    )
}

/// Edit a topic's title, bumping updated_at. Returns rows hit.
pub fn update_topic(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE topics SET title = ?2, updated_at = ?3 WHERE id = ?1",
        (id, title, &now_iso()),
    )
}

/// Bump a topic's updated_at without any other change (a merge into it counts as a
/// change even when the title is untouched). Returns rows hit.
pub fn touch_topic(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute("UPDATE topics SET updated_at = ?2 WHERE id = ?1", (id, &now_iso()))
}

/// Set (or clear, with `None`) a topic's chip color. Deliberately does NOT touch
/// `updated_at`: the color is decoration, not a rename, and `updated_at` drives chip
/// ordering — recoloring must not reshuffle chips. Returns rows hit (0 = no such topic).
pub fn set_topic_color(conn: &Connection, id: &str, color: Option<&str>) -> rusqlite::Result<usize> {
    conn.execute("UPDATE topics SET color = ?2 WHERE id = ?1", (id, color))
}

/// Set (or clear, with `None`) a topic's free-text type label (0031 kind). Like color,
/// deliberately does NOT touch `updated_at` (a type tag is metadata, not a rename).
/// Returns rows hit (0 = no such topic). Canonical form is validated by the command layer.
pub fn set_topic_kind(conn: &Connection, id: &str, kind: Option<&str>) -> rusqlite::Result<usize> {
    conn.execute("UPDATE topics SET kind = ?2 WHERE id = ?1", (id, kind))
}

/// Set a topic's manual-order frindex key (0031 position). Never cleared — reorder only
/// swaps the key. Does NOT touch `updated_at`. Returns rows hit (0 = no such topic).
pub fn set_topic_position(conn: &Connection, id: &str, position: &str) -> rusqlite::Result<usize> {
    conn.execute("UPDATE topics SET position = ?2 WHERE id = ?1", (id, position))
}

/// A topic's current manual-order key, if any (None = 未定序 or no such topic — callers
/// treat a missing neighbour as an open bound in `key_between`).
pub fn topic_position(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT position FROM topics WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .map(|o| o.flatten())
}

/// The largest manual-order key currently in use (None = no positioned topics yet).
/// `create_topic` lands a new tag at the END via `key_between(last, None)`.
pub fn last_topic_position(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT position FROM topics WHERE position IS NOT NULL ORDER BY position DESC LIMIT 1",
        [],
        |r| r.get(0),
    )
    .optional()
    .map(|o| o.flatten())
}

/// All topics in manual order (0031 position; 未定序的排最后、回落 updated_at,id 兜底
/// 打平)—— the filing picker order (was least-recently-updated before 0031).
pub fn all_topics(conn: &Connection) -> rusqlite::Result<Vec<TopicRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, color, position, kind FROM topics \
         ORDER BY position IS NULL, position, updated_at, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TopicRow {
            id: r.get(0)?,
            title: r.get(1)?,
            color: r.get(2)?,
            position: r.get(3)?,
            kind: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Filed ideas grouped under each topic (newest-first within a topic). `include_empty`
/// keeps tag-less topics (management view, in **manual order** — 0031 position, 未定序回落
/// updated_at) vs drops them and orders by latest idea (read-only browse). Task-stage
/// items never appear — only organized ideas (stage 'filed', not archived).
type TopicMeta = (String, String, Option<String>, Option<String>, Option<String>);
fn topic_trees(conn: &Connection, include_empty: bool) -> rusqlite::Result<Vec<TopicTree>> {
    let mut meta: Vec<TopicMeta> = Vec::new();
    {
        // 管理视图按手动序(position,未定序排最后回落 updated_at);只读浏览态由下方按
        // 最新想法重排,这里的顺序不影响它。
        let order = if include_empty {
            " ORDER BY position IS NULL, position, updated_at, id"
        } else {
            ""
        };
        let sql = format!("SELECT id, title, color, position, kind FROM topics{order}");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?;
        for row in rows {
            meta.push(row?);
        }
    }

    let mut notes_by_topic: std::collections::HashMap<String, Vec<ItemRow>> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT it.topic_id, i.id, i.content, i.created_at \
             FROM item_topic it JOIN items i ON i.id = it.item_id \
             WHERE i.stage = 'filed' AND i.archived_at IS NULL ORDER BY i.created_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                ItemRow { id: r.get(1)?, content: r.get(2)?, created_at: r.get(3)? },
            ))
        })?;
        for row in rows {
            let (topic_id, note) = row?;
            notes_by_topic.entry(topic_id).or_default().push(note);
        }
    }

    if include_empty {
        // keep every topic; order is already set by `meta` (manual position order).
        Ok(meta
            .into_iter()
            .map(|(id, title, color, position, kind)| {
                let notes = notes_by_topic.remove(&id).unwrap_or_default();
                TopicTree { id, title, color, position, kind, notes }
            })
            .collect())
    } else {
        // keep only non-empty topics; order by each topic's newest idea (notes[0]).
        let mut out: Vec<TopicTree> = meta
            .into_iter()
            .filter_map(|(id, title, color, position, kind)| {
                notes_by_topic
                    .remove(&id)
                    .map(|notes| TopicTree { id, title, color, position, kind, notes })
            })
            .collect();
        out.sort_by(|a, b| b.notes[0].created_at.cmp(&a.notes[0].created_at));
        Ok(out)
    }
}

/// Every topic that holds at least one filed idea, each carrying those ideas (newest
/// first), for the read-only 按主题浏览. Empty topics are omitted; ordered by newest idea.
pub fn topics_with_notes(conn: &Connection) -> rusqlite::Result<Vec<TopicTree>> {
    topic_trees(conn, false)
}

/// Every topic — including empty ones — each with its filed ideas, for the manual
/// 标签管理 view. Ordered most-recently-changed first.
pub fn all_topics_with_notes(conn: &Connection) -> rusqlite::Result<Vec<TopicTree>> {
    topic_trees(conn, true)
}

// ---- Board: create + read -------------------------------------------------------

/// Insert a user-created task directly as 'todo' with an optional due date/priority set
/// in the SAME statement (so a bad due/priority is atomic — the row CHECKs fail and
/// nothing is inserted). Lands at the 待办 column's END (a fractional key after the
/// current last card; `task::create` then repositions it to the front). Tags, if any,
/// are linked separately within the caller's transaction. Returns its ULID.
pub fn insert_task(
    conn: &Connection,
    content: &str,
    due_on: Option<&str>,
    priority: Option<i64>,
) -> rusqlite::Result<String> {
    let id = Ulid::new().to_string();
    let now = now_iso();
    let key = end_key(conn, "todo", &id)?;
    conn.execute(
        "INSERT INTO items (id, content, stage, created_at, updated_at, due_on, priority, position, born_stage) \
         VALUES (?1, ?2, 'todo', ?3, ?3, ?4, ?5, ?6, 'todo')",
        (&id, content, &now, due_on, priority, &key),
    )?;
    Ok(id)
}

/// 跨空间移动的目标侧落行(cross-space-move §2.6):id 由调用方铸好(新 ULID 已过
/// 目标表 + oplog 历史按 entity 查重),created_at 保留源时刻(史实)、born_stage =
/// 移动时 stage(该行在**本库**的出生态)、任务态落所在列**列首**(同 create/promote
/// 先例:新来的先可见)、灵感态 position=NULL(0022 耦合触发器要求)。
/// updated_at 是本地簿记 = 现在。返回插入行数(恒 1,失败走 Err)。
pub fn insert_moved_item(
    conn: &Connection,
    id: &str,
    content: &str,
    stage: &str,
    created_at: &str,
    due_on: Option<&str>,
    priority: Option<i64>,
) -> rusqlite::Result<usize> {
    let position = match stage {
        "todo" | "doing" | "confirming" | "done" => Some(front_key(conn, stage, id)?),
        _ => None,
    };
    conn.execute(
        "INSERT INTO items (id, content, stage, created_at, updated_at, due_on, priority, position, born_stage) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?3)",
        (id, content, stage, created_at, now_iso(), due_on, priority, position),
    )
}

/// Shared board read: task-stage items matching `where_sql` (alias `i`), ordered by
/// `order_sql`, each with its tags. Two small reads (items / item_topic⋈topics) grouped
/// in memory. The predicates are fixed literals from this module, never user input.
fn task_rows(
    conn: &Connection,
    where_sql: &str,
    order_sql: &str,
) -> rusqlite::Result<Vec<TaskRow>> {
    let mut tags_by_item: std::collections::HashMap<String, Vec<TagRef>> =
        std::collections::HashMap::new();
    {
        let sql = format!(
            "SELECT it.item_id, t.id, t.title, t.color FROM item_topic it \
             JOIN topics t ON t.id = it.topic_id \
             JOIN items i ON i.id = it.item_id \
             WHERE {where_sql} ORDER BY t.position IS NULL, t.position, t.updated_at, t.id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, TagRef { id: r.get(1)?, title: r.get(2)?, color: r.get(3)? }))
        })?;
        for row in rows {
            let (item_id, tag) = row?;
            tags_by_item.entry(item_id).or_default().push(tag);
        }
    }

    let sql = format!(
        "SELECT i.id, i.content, i.stage, i.due_on, i.priority, i.sealed_at, i.done_at FROM items i \
         WHERE {where_sql} ORDER BY {order_sql}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, content, stage, due_on, priority, sealed_at, done_at) = row?;
        let topics = tags_by_item.remove(&id).unwrap_or_default();
        out.push(TaskRow { id, content, stage, due_on, priority, sealed_at, done_at, topics });
    }
    Ok(out)
}

/// Every active board card (task-stage, not archived), in per-column manual order
/// (`position`). The frontend buckets by stage.
pub fn list_tasks(conn: &Connection) -> rusqlite::Result<Vec<TaskRow>> {
    task_rows(
        conn,
        &format!("i.stage IN {TASK_STAGES} AND i.archived_at IS NULL AND i.sealed_at IS NULL"),
        "i.position ASC, i.id ASC",
    )
}

/// Archived board cards for the 任务回收站, most-recently-archived first.
pub fn archived_tasks(conn: &Connection) -> rusqlite::Result<Vec<TaskRow>> {
    task_rows(
        conn,
        &format!("i.stage IN {TASK_STAGES} AND i.archived_at IS NOT NULL"),
        "i.archived_at DESC",
    )
}

// ---- Board: stage transition + reorder primitives -------------------------------

/// The stage of an active (non-archived) board card, or None if missing/archived/an
/// idea. `reorder` guards on this so a stale move of an off-board card fails fast.
pub fn active_task_stage(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    let sql = format!(
        "SELECT stage FROM items \
         WHERE id = ?1 AND archived_at IS NULL AND sealed_at IS NULL AND stage IN {TASK_STAGES}"
    );
    conn.query_row(&sql, [id], |r| r.get(0)).optional()
}

/// Compare-and-swap a board card's stage among the task stages (and bump updated_at),
/// landing it at the target column's END (a fractional key after the current last card).
/// The `from` guard makes this a fail-fast CAS; `archived_at IS NULL` keeps a 回收站
/// card out. Returns rows changed. (A cross-column drag overwrites this end key with the
/// dropped-slot key afterwards in `reorder`.)
///
/// 完成时刻(0030 done_at):**进入 done 的那条边**(旧 stage≠done 且目标=done)盖一次
/// now(与 updated_at 同一时刻);其余流转一律不碰 done_at——离开 done 不清、永不主动
/// 清除,故归档/撤回后完成时刻天然保住(迁移 0030 语义)。CASE 里的 `stage` 是行的
/// **旧值**(SQLite 的 UPDATE...SET 右式一律读未改前的行值),「旧≠done」判据真实成立;
/// 编排层据同一条边把 `"done_at"` 加进 oplog 发射(task.rs)。
pub fn set_task_stage(conn: &Connection, id: &str, from: &str, to: &str) -> rusqlite::Result<usize> {
    let key = end_key(conn, to, id)?;
    conn.execute(
        "UPDATE items SET stage = ?3, updated_at = ?4, position = ?5, \
                done_at = CASE WHEN stage <> 'done' AND ?3 = 'done' THEN ?4 ELSE done_at END \
         WHERE id = ?1 AND stage = ?2 AND archived_at IS NULL AND sealed_at IS NULL",
        (id, from, to, now_iso(), key),
    )
}

/// The active card ids in a column, in board order (`position`).
pub fn column_task_ids(conn: &Connection, stage: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM items \
         WHERE stage = ?1 AND archived_at IS NULL AND sealed_at IS NULL \
         ORDER BY position ASC, id ASC",
    )?;
    let rows = stmt.query_map([stage], |r| r.get(0))?;
    rows.collect()
}

/// One active board card's current sort key, or None if it is not an active task-stage
/// card. The reorder orchestration reads the dragged card's new neighbours through this.
pub fn active_task_position(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    let sql = format!(
        "SELECT position FROM items \
         WHERE id = ?1 AND archived_at IS NULL AND sealed_at IS NULL AND stage IN {TASK_STAGES}"
    );
    conn.query_row(&sql, [id], |r| r.get(0)).optional()
}

/// 列内最后一张活跃卡的排序键(列空 = None)。`excluding` 排除正被移动的卡自己
/// (跨列 CAS 时它还挂着旧列的键,按 stage 过滤本就不含它,排除只是保险)。
fn last_active_position(
    conn: &Connection,
    stage: &str,
    excluding: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT position FROM items \
         WHERE stage = ?1 AND archived_at IS NULL AND sealed_at IS NULL AND id <> ?2 \
         ORDER BY position DESC LIMIT 1",
        (stage, excluding),
        |r| r.get(0),
    )
    .optional()
}

/// 列内第一张活跃卡的排序键(列空 = None)。
fn first_active_position(
    conn: &Connection,
    stage: &str,
    excluding: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT position FROM items \
         WHERE stage = ?1 AND archived_at IS NULL AND sealed_at IS NULL AND id <> ?2 \
         ORDER BY position ASC LIMIT 1",
        (stage, excluding),
        |r| r.get(0),
    )
    .optional()
}

/// 列尾追加的下一枚排序键。库里读出的键不合规是数据完整性事故(库被外部改写),当场
/// panic——与 db.rs 拒 WAL 的 fail-fast 同级,绝不静默编个键继续跑。
fn end_key(conn: &Connection, stage: &str, excluding: &str) -> rusqlite::Result<String> {
    let last = last_active_position(conn, stage, excluding)?;
    Ok(frindex::key_between(last.as_deref(), None)
        .unwrap_or_else(|e| panic!("列内排序键损坏(stage={stage}):{e}")))
}

/// 列首前插的下一枚排序键(新建任务 / 转待办都落列首)。
pub(crate) fn front_key(conn: &Connection, stage: &str, excluding: &str) -> rusqlite::Result<String> {
    let first = first_active_position(conn, stage, excluding)?;
    Ok(frindex::key_between(None, first.as_deref())
        .unwrap_or_else(|e| panic!("列内排序键损坏(stage={stage}):{e}")))
}

/// Set one active card's sort key within a column. The `stage`/`archived_at` guard
/// makes a row no longer an active member of this column a 0-row no-op. Returns rows
/// changed.
pub fn set_task_position(conn: &Connection, id: &str, stage: &str, position: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE items SET position = ?3 \
         WHERE id = ?1 AND stage = ?2 AND archived_at IS NULL AND sealed_at IS NULL",
        (id, stage, position),
    )
}

// ---- Board: field setters (active task only) ------------------------------------

/// Set (or clear, None) a task's due date — a user-local calendar day. The
/// `stage IN task / archived_at IS NULL` guard makes an idea-stage, archived, or missing
/// item a 0-row no-op (an idea has no schedule; the row CHECK also forbids it). A
/// malformed day is rejected by the CHECK. Bumps updated_at. Returns rows changed.
pub fn set_task_due(conn: &Connection, id: &str, due_on: Option<&str>) -> rusqlite::Result<usize> {
    let sql = format!(
        "UPDATE items SET due_on = ?2, updated_at = ?3 \
         WHERE id = ?1 AND stage IN {TASK_STAGES} AND archived_at IS NULL AND sealed_at IS NULL"
    );
    conn.execute(&sql, (id, due_on, now_iso()))
}

/// Set (or clear, None) a task's priority (1/2/3). Same guard as set_task_due; an
/// out-of-range value is rejected by the CHECK. Bumps updated_at. Returns rows changed.
pub fn set_task_priority(conn: &Connection, id: &str, priority: Option<i64>) -> rusqlite::Result<usize> {
    let sql = format!(
        "UPDATE items SET priority = ?2, updated_at = ?3 \
         WHERE id = ?1 AND stage IN {TASK_STAGES} AND archived_at IS NULL AND sealed_at IS NULL"
    );
    conn.execute(&sql, (id, priority, now_iso()))
}

// ---- 回收站: archive / restore / purge (single archived_at axis) -----------------
//
// One mechanism for both kinds, split only by stage so the frontend can show two tabs
// (灵感回收站 / 任务回收站). 73 起删除=进回收站:EVERY idea delete (inbox included) lands
// here first — destruction only happens inside the 回收站. The inbox hard-delete
// primitive (`delete_inbox_item`) stays for the command layer / e2e cleanup only.

/// Soft-archive a live idea (未归类 or 已归类) into the 回收站. The `stage IN idea /
/// archived_at IS NULL` guard makes a task/archived/missing item a 0-row no-op.
/// Returns rows changed.
pub fn archive_idea(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let now = now_iso();
    let sql = format!(
        "UPDATE items SET archived_at = ?2, updated_at = ?2 \
         WHERE id = ?1 AND stage IN {IDEA_STAGES} AND archived_at IS NULL"
    );
    conn.execute(&sql, (id, &now))
}

/// Restore an archived idea from the 回收站 (clear archived_at; the frozen stage stays
/// what it was — inbox or filed — position stays NULL). Returns rows changed.
pub fn restore_idea(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let now = now_iso();
    let sql = format!(
        "UPDATE items SET archived_at = NULL, updated_at = ?2 \
         WHERE id = ?1 AND stage IN {IDEA_STAGES} AND archived_at IS NOT NULL"
    );
    conn.execute(&sql, (id, &now))
}

/// Hard-delete one archived idea (彻底删除). The `stage IN idea / archived_at IS NOT NULL`
/// guard means it must be soft-archived first; item_topic / item_revisions cascade away.
/// Returns rows deleted.
pub fn purge_idea(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let sql = format!(
        "DELETE FROM items WHERE id = ?1 AND stage IN {IDEA_STAGES} AND archived_at IS NOT NULL"
    );
    conn.execute(&sql, [id])
}

/// Empty the 灵感回收站: hard-delete every archived idea. Returns how many were removed.
pub fn purge_archived_ideas(conn: &Connection) -> rusqlite::Result<usize> {
    let sql = format!(
        "DELETE FROM items WHERE stage IN {IDEA_STAGES} AND archived_at IS NOT NULL"
    );
    conn.execute(&sql, [])
}

/// Soft-archive an active board card into the 回收站 (the board's 删除). Any active
/// task-stage card can be archived; the `archived_at IS NULL` guard makes an
/// already-archived/missing one a 0-row no-op. The row keeps its stage (restore returns
/// it to the same column). Returns rows changed.
pub fn archive_task(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let now = now_iso();
    // `sealed_at IS NULL`: 成就归档的任务不进回收站(0017 冻结触发器是后盾,这里 0 行让
    // 调用方 fail-fast 出中文错误而不是触发器英文报错)。
    let sql = format!(
        "UPDATE items SET archived_at = ?2, updated_at = ?2 \
         WHERE id = ?1 AND stage IN {TASK_STAGES} AND archived_at IS NULL AND sealed_at IS NULL"
    );
    conn.execute(&sql, (id, &now))
}

/// Restore an archived board card to its ORIGINAL column (`stage`, read by the caller),
/// landing it at that column's END — its stale pre-archive key could collide with an
/// active card's, so it is re-assigned a fresh end key. The `stage = ?3 / archived_at
/// IS NOT NULL` guard makes a stale call a 0-row no-op. Returns rows changed.
pub fn restore_task(conn: &Connection, id: &str, stage: &str) -> rusqlite::Result<usize> {
    let now = now_iso();
    let key = end_key(conn, stage, id)?;
    conn.execute(
        "UPDATE items SET archived_at = NULL, updated_at = ?2, position = ?4 \
         WHERE id = ?1 AND stage = ?3 AND archived_at IS NOT NULL",
        (id, &now, stage, &key),
    )
}

/// Hard-delete one archived board card. The `stage IN task / archived_at IS NOT NULL`
/// guard means it must be soft-archived first. Returns rows deleted.
pub fn purge_task(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let sql = format!(
        "DELETE FROM items WHERE id = ?1 AND stage IN {TASK_STAGES} AND archived_at IS NOT NULL"
    );
    conn.execute(&sql, [id])
}

/// Empty the 任务回收站: hard-delete every archived board card. Returns how many were removed.
pub fn purge_archived_tasks(conn: &Connection) -> rusqlite::Result<usize> {
    let sql = format!(
        "DELETE FROM items WHERE stage IN {TASK_STAGES} AND archived_at IS NOT NULL"
    );
    conn.execute(&sql, [])
}

// ---- 成就归档: seal / unseal (0017 sealed_at axis) --------------------------------
//
// 与回收站(archived_at)平行且互斥的第二根轴:归档=「干完了、留着看」的史实,可查、
// 不可删(0017 触发器:冻结 + 禁删)。只有活跃的 done 任务可归档;取消归档翻回看板
// 「已完成」列(镜像 restore_task 的 position 重排)。内部命名用 seal(封存)避开已被
// 回收站占用的 archive_*;用户可见中文才叫「归档」。

/// 归档一条「已完成」任务(盖 sealed_at)。position 冻结原值(已退出 partial unique
/// 的约束范围)。guard 使 非 done/回收站中/已归档/不存在 均为 0 行 no-op,调用方 fail-fast。
pub fn seal_task(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let now = now_iso();
    conn.execute(
        "UPDATE items SET sealed_at = ?2, updated_at = ?2 \
         WHERE id = ?1 AND stage = 'done' AND archived_at IS NULL AND sealed_at IS NULL",
        (id, &now),
    )
}

/// 一键归档全部「已完成」:同一时间戳盖满整列(一批一个归档时刻,时间轴上归成一组)。
/// 返回归档条数(0 = 列本来就空,不是错误)。
pub fn seal_all_done(conn: &Connection) -> rusqlite::Result<usize> {
    let now = now_iso();
    conn.execute(
        "UPDATE items SET sealed_at = ?1, updated_at = ?1 \
         WHERE stage = 'done' AND archived_at IS NULL AND sealed_at IS NULL",
        [&now],
    )
}

/// 取消归档:sealed_at 置回 NULL,任务回到看板「已完成」列的末尾(冻结的旧排序键
/// 可能已被活跃卡占用,重发一枚列尾键,同 restore_task)。guard 使 未归档/不存在 为 0 行。
pub fn unseal_task(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let key = end_key(conn, "done", id)?;
    conn.execute(
        "UPDATE items SET sealed_at = NULL, updated_at = ?2, position = ?3 \
         WHERE id = ?1 AND sealed_at IS NOT NULL",
        (id, now_iso(), &key),
    )
}

/// 归档册:全部已归档的任务,**按完成时刻降序**(0030 决定 A:完成日优先、老卡无
/// done_at 时回落归档日 sealed_at)。前端据同一 COALESCE(done_at, sealed_at) 分组成
/// 时间轴,让「什么时候干完的」在册子里成立(批量归档不再把一周的活压成归档那天)。
/// TEXT 降序 == 真实时刻降序的前提:done_at/sealed_at 都是 now_iso() 产的固定宽度 UTC `Z`
/// (全端第一方 writer 恒如此,与 sealed_at 一直以来的排序假设同源;非规范偏移的合法
/// RFC3339 理论上会错序,但无第一方路径产生此值——codex v2 复审 M2 记)。
pub fn sealed_tasks(conn: &Connection) -> rusqlite::Result<Vec<TaskRow>> {
    task_rows(
        conn,
        "i.sealed_at IS NOT NULL",
        "COALESCE(i.done_at, i.sealed_at) DESC, i.id DESC",
    )
}

// ---- Item images ----------------------------------------------------------------
// Images attached to an item (灵感 or 任务) as numbered 「图N」 attachments (migration 0016).
// Bytes live in a BLOB so the whole DB backs up as one file and the 删除主权 cascades cover
// them: a soft-archive (UPDATE archived_at) leaves images in place, a hard-delete/purge
// (real DELETE) cascades them — and their 编号 counter — away. Orchestration (allocate 编号 +
// insert, one transaction) is in images.rs; these are the single-statement primitives.

/// An image attached to an item: its id, 「图N」编号 (`seq`), and MIME — NOT the bytes, so
/// listing a card's images stays light. Fetch bytes on demand with `item_image_data`.
pub struct ImageRef {
    pub id: String,
    pub seq: i64,
    pub mime: String,
}

/// Allocate the next 「图N」编号 for an item from its high-water counter (item_image_counter)
/// and return it. The counter only ever climbs — deleting a trailing image does NOT lower it
/// — so a 编号 is NEVER reused (a 正文「见图N」 reference can never silently re-point at a
/// different picture). Seeds at 1 on the first image. Call inside the caller's transaction,
/// paired with `insert_item_image`.
pub fn next_image_seq(conn: &Connection, item_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO item_image_counter (item_id, last_seq) VALUES (?1, 1) \
         ON CONFLICT(item_id) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq",
        [item_id],
        |r| r.get(0),
    )
}

/// Insert one image row (bytes + MIME) at an already-allocated 编号. A bad MIME / empty blob
/// hits a CHECK and errors (fail-fast); a missing item_id fails the FK. Call inside the
/// caller's transaction, after `next_image_seq`. Returns rows inserted (1).
pub fn insert_item_image(
    conn: &Connection,
    id: &str,
    item_id: &str,
    seq: i64,
    data: &[u8],
    mime: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, item_id, seq, data, mime, now_iso()],
    )
}

/// Every image attached to `item_id`, by 编号 ascending — id + seq + MIME only (no bytes).
/// Deleted 编号 leave gaps (图1、图3), never renumbered.
pub fn list_item_images(conn: &Connection, item_id: &str) -> rusqlite::Result<Vec<ImageRef>> {
    let mut stmt =
        conn.prepare("SELECT id, seq, mime FROM item_image WHERE item_id = ?1 ORDER BY seq")?;
    let rows = stmt.query_map([item_id], |r| {
        Ok(ImageRef { id: r.get(0)?, seq: r.get(1)?, mime: r.get(2)? })
    })?;
    rows.collect()
}

/// 时间轴全量配图元数据,单条 JOIN 按 item_id 分组(id + 编号 + MIME,不带字节)。
/// 与 `live_timeline` 同一活性滤轴(排回收站与成就册),同一把连接锁下两条查询即同
/// 一快照——逐行 `list_item_images` 的 N+1 批量替代;组内仍按 seq 升序,留洞不重排。
pub fn live_timeline_images(
    conn: &Connection,
) -> rusqlite::Result<HashMap<String, Vec<ImageRef>>> {
    let mut stmt = conn.prepare(
        "SELECT im.item_id, im.id, im.seq, im.mime \
         FROM item_image im JOIN items i ON i.id = im.item_id \
         WHERE i.archived_at IS NULL AND i.sealed_at IS NULL \
         ORDER BY im.item_id, im.seq",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            ImageRef { id: r.get(1)?, seq: r.get(2)?, mime: r.get(3)? },
        ))
    })?;
    let mut out: HashMap<String, Vec<ImageRef>> = HashMap::new();
    for row in rows {
        let (item_id, img) = row?;
        out.entry(item_id).or_default().push(img);
    }
    Ok(out)
}

/// The bytes + MIME of one image (for display), or None if the id is unknown.
pub fn item_image_data(
    conn: &Connection,
    image_id: &str,
) -> rusqlite::Result<Option<(Vec<u8>, String)>> {
    conn.query_row(
        "SELECT data, mime FROM item_image WHERE id = ?1",
        [image_id],
        |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
}

/// Hard-delete one image by id (换图 = 删旧加新). The counter is left untouched, so the freed
/// 编号 is never handed out again. Returns rows deleted (0 if the id was already gone).
pub fn delete_item_image(conn: &Connection, image_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM item_image WHERE id = ?1", [image_id])
}

/// Which item an image belongs to, or None if the id is unknown. Read before deleting —
/// the image tombstone op carries its owner, and the row is gone afterwards.
pub fn item_image_owner(conn: &Connection, image_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT item_id FROM item_image WHERE id = ?1", [image_id], |r| r.get(0))
        .optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_path(tag: &str) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-repo-{}-{}-{}.sqlite3", tag, std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        path
    }

    /// A fully-migrated (latest) database in a unique temp file.
    fn fresh_db() -> Connection {
        db::open(&temp_path("fresh")).expect("open migrated db")
    }

    fn stage_of(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT stage FROM items WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn migration_sets_user_version_31_and_enforces_foreign_keys() {
        let conn = fresh_db();
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 31);
        let fk: i64 = conn.pragma_query_value(None, "foreign_keys", |r| r.get(0)).unwrap();
        assert_eq!(fk, 1, "foreign keys must be ON");
    }

    /// 0030:done_at 生而 NULL 是存储级不变量——单机 INSERT 带非空 done_at 被触发器拦;
    /// 回放/引导豁免(sync_replay_active)下放行,让终态行整行导入(已完成卡带 done_at)通过。
    #[test]
    fn done_at_born_null_guarded_single_user_but_replay_exempt() {
        let conn = fresh_db();
        let insert = "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage, done_at) \
             VALUES ('x', 'x', 'done', 't', 't', 'a0', 'done', '2026-07-20T10:00:00.000Z')";
        // 单机路径:新条目不能生而带完成时间。
        let err = conn.execute(insert, []).unwrap_err();
        assert!(err.to_string().contains("完成时间"), "{err}");
        // 回放/引导豁免下放行,done_at 原样落行。
        conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        conn.execute(insert, []).unwrap();
        let got: Option<String> =
            conn.query_row("SELECT done_at FROM items WHERE id = 'x'", [], |r| r.get(0)).unwrap();
        assert_eq!(got.as_deref(), Some("2026-07-20T10:00:00.000Z"));
    }

    // 深链接定位:item_axes 如实报告一条 item 的三根轴(stage / 回收站 / 归档),缺失=None。
    // 分类成前端路由词(task/inbox/sealed/trash-*)是 lib.rs 命令的事,这里只钉住取列正确。
    #[test]
    fn item_axes_reports_stage_and_flags() {
        let conn = fresh_db();
        // stage↔position 耦合 CHECK:灵感态 position 必须 NULL,任务态必须有键。
        let ins = |id: &str, stage: &str, pos: Option<&str>| {
            conn.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage) \
                 VALUES (?1, 'x', ?2, 't', 't', ?3, ?2)",
                rusqlite::params![id, stage, pos],
            )
            .unwrap();
        };
        // 缺失 → None。
        assert_eq!(item_axes(&conn, "nope").unwrap(), None);
        // 活跃灵感 / 活跃任务:两个 flag 都 false。
        ins("i1", "inbox", None);
        assert_eq!(item_axes(&conn, "i1").unwrap(), Some(("inbox".to_string(), false, false)));
        ins("t1", "todo", Some("a1"));
        assert_eq!(item_axes(&conn, "t1").unwrap(), Some(("todo".to_string(), false, false)));
        // 进回收站 → archived=true。
        conn.execute("UPDATE items SET archived_at='t' WHERE id='t1'", []).unwrap();
        assert_eq!(item_axes(&conn, "t1").unwrap(), Some(("todo".to_string(), true, false)));
        // 已完成入成就册 → sealed=true(与回收站互斥)。
        ins("d1", "done", Some("a2"));
        conn.execute("UPDATE items SET sealed_at='t' WHERE id='d1'", []).unwrap();
        assert_eq!(item_axes(&conn, "d1").unwrap(), Some(("done".to_string(), false, true)));
    }

    #[test]
    fn item_history_triggers_present_after_migration() {
        let conn = fresh_db();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' \
                 AND name IN ('trg_item_archive_on_edit', 'trg_item_revision_immutable', \
                              'trg_item_no_delete_live_organized')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 3, "all three 0014 item triggers must exist");
    }

    #[test]
    fn capture_inserts_an_inbox_item_with_ulid_id() {
        let conn = fresh_db();
        let id = add_item(&conn, "测试想法").unwrap();
        assert_eq!(id.len(), 26, "ULID is 26 chars");
        assert_eq!(stage_of(&conn, &id), "inbox");
        assert_eq!(current_content(&conn, &id).unwrap().as_deref(), Some("测试想法"));
    }

    #[test]
    fn delete_inbox_item_removes_only_unorganized_captures() {
        let conn = fresh_db();
        let id = add_item(&conn, "随手垃圾").unwrap();
        assert_eq!(delete_inbox_item(&conn, &id).unwrap(), 1);
        assert_eq!(delete_inbox_item(&conn, &id).unwrap(), 0, "gone -> 0 rows");

        // A filed idea is not inbox — the guard (and the 0014 delete trigger) refuse it.
        let filed = add_item(&conn, "已整理").unwrap();
        file_inbox_item(&conn, &filed).unwrap();
        assert_eq!(delete_inbox_item(&conn, &filed).unwrap(), 0);
        let direct = conn.execute("DELETE FROM items WHERE id = ?1", [&filed]);
        assert!(direct.is_err(), "trigger blocks raw-deleting a live filed item");
    }

    #[test]
    fn edit_archives_history_via_trigger_on_any_stage() {
        let conn = fresh_db();
        // Idea edit keeps history.
        let id = add_item(&conn, "原始").unwrap();
        update_item_content(&conn, &id, "改一次").unwrap();
        update_item_content(&conn, &id, "改两次").unwrap();
        let revs = item_revisions(&conn, &id).unwrap();
        assert_eq!(revs.len(), 2);
        assert_eq!(revs[0].content, "改一次", "newest superseded first");
        assert_eq!(revs[1].content, "原始");

        // A task-title edit ALSO archives history (D5) — even a raw UPDATE cannot bypass.
        let t = insert_task(&conn, "任务原名", None, None).unwrap();
        rename_task(&conn, &t, "任务新名").unwrap();
        assert_eq!(item_revisions(&conn, &t).unwrap()[0].content, "任务原名");

        // History is append-only: the DB refuses to rewrite a revision.
        let rewrite = conn.execute("UPDATE item_revisions SET content='篡改' WHERE item_id=?1", [&id]);
        assert!(rewrite.is_err(), "trigger blocks rewriting history");
    }

    #[test]
    fn promote_and_revert_flip_stage_without_copying() {
        let conn = fresh_db();
        let id = add_item(&conn, "记得交房租").unwrap();

        // 转待办: same row, stage flips to todo, gains a position; still ONE item.
        assert_eq!(promote_to_todo(&conn, &id).unwrap(), 1);
        assert_eq!(stage_of(&conn, &id), "todo");
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1, "no duplicate record — the whole point of the refactor");

        // 撤回 with no tag -> inbox, clears task attrs.
        assert_eq!(revert_to_idea(&conn, &id, "inbox").unwrap(), 1);
        assert_eq!(stage_of(&conn, &id), "inbox");
        let pos: Option<String> = conn.query_row("SELECT position FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert!(pos.is_none(), "idea stage clears position");
    }

    #[test]
    fn idea_stage_check_rejects_task_attrs() {
        let conn = fresh_db();
        let id = add_item(&conn, "灵感").unwrap();
        // The row CHECK forbids a position / due / priority on an idea stage.
        assert!(conn.execute("UPDATE items SET position = 'a0' WHERE id = ?1", [&id]).is_err());
        assert!(conn.execute("UPDATE items SET position = 0 WHERE id = ?1", [&id]).is_err());
        assert!(conn.execute("UPDATE items SET due_on = '2026-06-25' WHERE id = ?1", [&id]).is_err());
        assert!(conn.execute("UPDATE items SET priority = 1 WHERE id = ?1", [&id]).is_err());
    }

    #[test]
    fn task_stage_requires_key_shaped_position_and_ties_break_by_id() {
        let conn = fresh_db();
        let a = insert_task(&conn, "甲", None, None).unwrap();
        let b = insert_task(&conn, "乙", None, None).unwrap();
        let c = insert_task(&conn, "丙", None, None).unwrap();
        let pos = |id: &str| -> String {
            conn.query_row("SELECT position FROM items WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        // 顺序建卡走整数轴的列尾追加:a0 -> a1 -> a2。
        assert_eq!((pos(&a), pos(&b), pos(&c)), ("a0".into(), "a1".into(), "a2".into()));
        // NULL / 整数 / 空串 / 非字母开头 / 表外字符,任务态一律拒绝。
        assert!(conn.execute("UPDATE items SET position=NULL WHERE id=?1", [&a]).is_err());
        assert!(conn.execute("UPDATE items SET position=0 WHERE id=?1", [&a]).is_err());
        assert!(conn.execute("UPDATE items SET position='' WHERE id=?1", [&a]).is_err());
        assert!(conn.execute("UPDATE items SET position='0a' WHERE id=?1", [&a]).is_err());
        assert!(conn.execute("UPDATE items SET position='a-' WHERE id=?1", [&a]).is_err());
        // 同列同键自 0022 起**允许**:frindex 确定性算法下,两端离线往同一空隙插卡必得
        // 同一个键,合并后同键并列是合法结局——UNIQUE 已降普通索引,读序由 id 打平。
        conn.execute("UPDATE items SET position='a1' WHERE id=?1", [&a]).unwrap();
        let order = column_task_ids(&conn, "todo").unwrap();
        let (first, second) = if a < b { (&a, &b) } else { (&b, &a) };
        assert_eq!(
            order,
            vec![first.clone(), second.clone(), c.clone()],
            "同键 a1 的两张卡按 id 打平,列序仍是确定性全序"
        );
    }

    #[test]
    fn list_tasks_carries_multi_tags_and_excludes_ideas_and_trash() {
        let conn = fresh_db();
        let t = insert_task(&conn, "带两个标签的任务", None, None).unwrap();
        let g1 = insert_topic(&conn, "工作").unwrap();
        let g2 = insert_topic(&conn, "紧急").unwrap();
        link_item_topic(&conn, &t, &g1).unwrap();
        link_item_topic(&conn, &t, &g2).unwrap();
        // An idea never shows on the board.
        let _idea = add_item(&conn, "纯灵感").unwrap();

        let rows = list_tasks(&conn).unwrap();
        assert_eq!(rows.len(), 1, "only task-stage, no ideas");
        assert_eq!(rows[0].topics.len(), 2, "M:N tags on a task");
        let titles: Vec<&str> = rows[0].topics.iter().map(|x| x.title.as_str()).collect();
        assert!(titles.contains(&"工作") && titles.contains(&"紧急"));
    }

    #[test]
    fn task_stage_cas_lands_at_column_end() {
        let conn = fresh_db();
        let id = insert_task(&conn, "活", None, None).unwrap();
        assert_eq!(set_task_stage(&conn, &id, "todo", "doing").unwrap(), 1);
        assert_eq!(set_task_stage(&conn, &id, "todo", "done").unwrap(), 0, "wrong from -> 0");
        assert_eq!(stage_of(&conn, &id), "doing");
    }

    #[test]
    fn due_and_priority_setters_guard_stage_and_archive() {
        let conn = fresh_db();
        let t = insert_task(&conn, "活跃任务", None, None).unwrap();
        assert_eq!(set_task_due(&conn, &t, Some("2026-06-25")).unwrap(), 1);
        assert_eq!(set_task_priority(&conn, &t, Some(2)).unwrap(), 1);
        // Bad day / range rejected by CHECK.
        assert!(set_task_due(&conn, &t, Some("2026-02-31")).is_err());
        // An idea can't take a due date (guard no-op, 0 rows).
        let idea = add_item(&conn, "灵感").unwrap();
        assert_eq!(set_task_due(&conn, &idea, Some("2026-06-25")).unwrap(), 0);
        // Archived task is frozen (guard no-op).
        archive_task(&conn, &t).unwrap();
        assert_eq!(set_task_due(&conn, &t, None).unwrap(), 0);
    }

    #[test]
    fn filed_and_idea_trash_reads_with_tags() {
        let conn = fresh_db();
        let a = add_item(&conn, "已整理甲").unwrap();
        let topic = insert_topic(&conn, "分类").unwrap();
        file_inbox_item(&conn, &a).unwrap();
        link_item_topic(&conn, &a, &topic).unwrap();
        let b = add_item(&conn, "将归回收站").unwrap();
        file_inbox_item(&conn, &b).unwrap();
        archive_idea(&conn, &b).unwrap();

        let filed = filed_items(&conn).unwrap();
        assert_eq!(filed.len(), 1);
        assert_eq!(filed[0].id, a);
        assert_eq!(filed[0].topics.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["分类"]);

        let trash = idea_trash(&conn).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, b);
    }

    #[test]
    fn live_ideas_merges_inbox_and_filed_newest_first_excluding_trash() {
        let conn = fresh_db();
        // 未归类 (untagged), then 已归类 (tagged) — created in this order.
        let inbox = add_item(&conn, "未归类的").unwrap();
        let filed = add_item(&conn, "已归类的").unwrap();
        let topic = insert_topic(&conn, "分类").unwrap();
        file_inbox_item(&conn, &filed).unwrap();
        link_item_topic(&conn, &filed, &topic).unwrap();
        // A trashed idea and a board task must NOT appear in the merged 想法 list.
        let trashed = add_item(&conn, "回收站的").unwrap();
        archive_idea(&conn, &trashed).unwrap(); // 73: an inbox idea archives directly too
        let task = insert_task(&conn, "任务", None, None).unwrap();

        let ideas = live_ideas(&conn).unwrap();
        let ids: Vec<&str> = ideas.iter().map(|r| r.id.as_str()).collect();
        // Newest-first: 已归类 was added after 未归类.
        assert_eq!(ids, vec![filed.as_str(), inbox.as_str()]);
        assert!(!ids.contains(&trashed.as_str()), "trash excluded");
        assert!(!ids.contains(&task.as_str()), "board task excluded");
        // Tags ride along; an untagged idea carries an empty topics.
        assert_eq!(ideas[0].topics.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["分类"]);
        assert!(ideas[1].topics.is_empty());
        // Stage rides along too — it is the delete-routing axis, and tags are NOT a
        // proxy for it: after the topic dies, the filed idea is tag-less but STILL
        // filed (hard delete must stay refused; the UI must offer the soft path).
        assert_eq!(ideas[0].stage, "filed");
        assert_eq!(ideas[1].stage, "inbox");
        delete_topic(&conn, &topic).unwrap();
        let ideas = live_ideas(&conn).unwrap();
        assert!(ideas[0].topics.is_empty(), "tag links cascaded away");
        assert_eq!(ideas[0].stage, "filed", "orphan keeps its stage — 曾被整理是史实");
        assert_eq!(delete_inbox_item(&conn, &ideas[0].id).unwrap(), 0, "hard delete refused");
        assert_eq!(archive_idea(&conn, &ideas[0].id).unwrap(), 1, "soft delete is the road");
    }

    #[test]
    fn live_timeline_merges_all_stages_newest_first_excluding_archived_sealed() {
        let conn = fresh_db();
        // 六个活 stage 各一条 + 两种被排除的命运(插入顺序即时间序,created_at 亚秒
        // 精度)。六态点名齐全:将来谁误收窄任务态,这里当场红。
        let idea = add_item(&conn, "一条灵感").unwrap();
        let filed = add_item(&conn, "已归类").unwrap();
        file_inbox_item(&conn, &filed).unwrap();
        let todo = insert_task(&conn, "一件待办", None, None).unwrap();
        let doing = insert_task(&conn, "进行中的", None, None).unwrap();
        set_task_stage(&conn, &doing, "todo", "doing").unwrap();
        let confirming = insert_task(&conn, "等确认的", None, None).unwrap();
        set_task_stage(&conn, &confirming, "todo", "confirming").unwrap();
        let done = insert_task(&conn, "已完成", None, None).unwrap();
        set_task_stage(&conn, &done, "todo", "done").unwrap();
        let trashed = add_item(&conn, "回收站的").unwrap();
        archive_idea(&conn, &trashed).unwrap();
        let sealed = insert_task(&conn, "已入册", None, None).unwrap();
        set_task_stage(&conn, &sealed, "todo", "done").unwrap();
        seal_task(&conn, &sealed).unwrap();

        let rows = live_timeline(&conn).unwrap();
        let got: Vec<(&str, &str)> =
            rows.iter().map(|r| (r.id.as_str(), r.stage.as_str())).collect();
        assert_eq!(
            got,
            vec![
                (done.as_str(), "done"),
                (confirming.as_str(), "confirming"),
                (doing.as_str(), "doing"),
                (todo.as_str(), "todo"),
                (filed.as_str(), "filed"),
                (idea.as_str(), "inbox"),
            ],
            "六个活 stage 合流、新→旧;回收站与成就册排除在外"
        );
    }

    #[test]
    fn live_timeline_tie_breaks_by_id_desc_and_groups_tags() {
        let conn = fresh_db();
        let a = add_item(&conn, "先记的").unwrap();
        let b = add_item(&conn, "后记的").unwrap();
        // 人工制造同一 created_at:确定性全靠第二排序键 id DESC(ULID 同毫秒不保证
        // 时间序,这里只承诺稳定,不承诺谁先谁后)。
        conn.execute("UPDATE items SET created_at = '2026-07-11T08:00:00Z'", []).unwrap();
        let rows = live_timeline(&conn).unwrap();
        let mut want = vec![a.clone(), b.clone()];
        want.sort();
        want.reverse();
        assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), want);

        // 标签按相邻行分组:两枚挂 a、零枚挂 b;顺序与 organized_rows 同轴(t.updated_at)。
        let t1 = insert_topic(&conn, "甲").unwrap();
        let t2 = insert_topic(&conn, "乙").unwrap();
        link_item_topic(&conn, &a, &t2).unwrap();
        link_item_topic(&conn, &a, &t1).unwrap();
        let rows = live_timeline(&conn).unwrap();
        let row_a = rows.iter().find(|r| r.id == a).unwrap();
        let row_b = rows.iter().find(|r| r.id == b).unwrap();
        assert_eq!(
            row_a.topics.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(),
            vec!["甲", "乙"],
            "标签跟 topic 建档序走(t.updated_at),与挂标签的先后无关"
        );
        assert!(row_b.topics.is_empty());
        assert_eq!(rows.len(), 2, "标签分组不复制条目行");
    }

    #[test]
    fn live_timeline_carries_due_and_priority() {
        // 120:卡片操作面板显示当前真值,禁另拼 list_tasks(两次 SELECT 非同一快照)
        // ——due_on/priority 必须随时间轴行带出;灵感行恒 NULL。
        let conn = fresh_db();
        let idea = add_item(&conn, "灵感无档期").unwrap();
        let task = insert_task(&conn, "有截止有优先级", Some("2026-08-01"), Some(3)).unwrap();
        let rows = live_timeline(&conn).unwrap();
        let row_task = rows.iter().find(|r| r.id == task).unwrap();
        let row_idea = rows.iter().find(|r| r.id == idea).unwrap();
        assert_eq!(row_task.due_on.as_deref(), Some("2026-08-01"));
        assert_eq!(row_task.priority, Some(3));
        assert_eq!(row_idea.due_on, None);
        assert_eq!(row_idea.priority, None);
    }

    #[test]
    fn trash_items_merges_ideas_and_tasks_by_archived_at() {
        // 120 统一回收站:灵感+任务一屏、按删除时间(不是创建时间)新→旧;冻结
        // stage 与标签随行(恢复路由与类型印靠它们)。
        let conn = fresh_db();
        let idea = add_item(&conn, "先删的灵感").unwrap();
        let topic = insert_topic(&conn, "标签").unwrap();
        link_item_topic(&conn, &idea, &topic).unwrap();
        let task = insert_task(&conn, "后删的任务", Some("2026-08-01"), None).unwrap();
        let live = add_item(&conn, "活着的不进来").unwrap();
        assert_eq!(archive_idea(&conn, &idea).unwrap(), 1);
        assert_eq!(archive_task(&conn, &task).unwrap(), 1);
        // 人工钉死删除时间:任务删得晚(排序轴 = archived_at,同刻并列才看 id)。
        conn.execute("UPDATE items SET archived_at='2026-07-14T01:00:00Z' WHERE id=?1", [&idea])
            .unwrap();
        conn.execute("UPDATE items SET archived_at='2026-07-14T02:00:00Z' WHERE id=?1", [&task])
            .unwrap();
        let rows = trash_items(&conn).unwrap();
        let got: Vec<(&str, &str)> = rows.iter().map(|r| (r.id.as_str(), r.stage.as_str())).collect();
        assert_eq!(got, vec![(task.as_str(), "todo"), (idea.as_str(), "inbox")]);
        assert!(!rows.iter().any(|r| r.id == live));
        assert_eq!(rows[1].topics.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["标签"]);
        assert_eq!(rows[0].archived_at, "2026-07-14T02:00:00Z");
        // 存储原语一次删空全 stage(0004 触发器守卫下 WHERE 天然合法)。
        assert_eq!(purge_all_trash(&conn).unwrap(), 2);
        assert!(trash_items(&conn).unwrap().is_empty());
    }

    #[test]
    fn archive_restore_purge_idea_lifecycle() {
        let conn = fresh_db();
        let n = add_item(&conn, "要清理的已整理").unwrap();
        file_inbox_item(&conn, &n).unwrap();

        // A live filed idea cannot be hard-deleted directly (trigger) nor purged (guard).
        assert!(conn.execute("DELETE FROM items WHERE id=?1", [&n]).is_err());
        assert_eq!(purge_idea(&conn, &n).unwrap(), 0);

        assert_eq!(archive_idea(&conn, &n).unwrap(), 1);
        assert_eq!(archive_idea(&conn, &n).unwrap(), 0, "no-op second time");
        assert!(filed_items(&conn).unwrap().is_empty());
        assert_eq!(idea_trash(&conn).unwrap().len(), 1);

        assert_eq!(restore_idea(&conn, &n).unwrap(), 1);
        assert_eq!(filed_items(&conn).unwrap().len(), 1);

        archive_idea(&conn, &n).unwrap();
        assert_eq!(purge_idea(&conn, &n).unwrap(), 1);
        let gone: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE id=?1", [&n], |r| r.get(0)).unwrap();
        assert_eq!(gone, 0);
    }

    #[test]
    fn archive_restore_purge_task_lifecycle() {
        let conn = fresh_db();
        let t = insert_task(&conn, "走流程", None, None).unwrap();
        set_task_stage(&conn, &t, "todo", "done").unwrap();

        assert_eq!(purge_task(&conn, &t).unwrap(), 0, "live task not in 回收站");
        assert_eq!(archive_task(&conn, &t).unwrap(), 1);
        assert_eq!(archive_task(&conn, &t).unwrap(), 0, "no-op second time");
        assert!(list_tasks(&conn).unwrap().is_empty());
        let trash = archived_tasks(&conn).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].stage, "done", "stage frozen at done");

        // Restore to the original column at its end.
        assert_eq!(restore_task(&conn, &t, "done").unwrap(), 1);
        assert!(archived_tasks(&conn).unwrap().is_empty());
        assert_eq!(stage_of(&conn, &t), "done");

        archive_task(&conn, &t).unwrap();
        assert_eq!(purge_task(&conn, &t).unwrap(), 1);
        assert!(item_stage(&conn, &t).unwrap().is_none());
    }

    #[test]
    fn restore_task_reassigns_position_to_avoid_collision() {
        let conn = fresh_db();
        let c = insert_task(&conn, "丙", None, None).unwrap();
        set_task_stage(&conn, &c, "todo", "done").unwrap(); // done key a0
        archive_task(&conn, &c).unwrap();
        let d = insert_task(&conn, "丁", None, None).unwrap();
        set_task_stage(&conn, &d, "todo", "done").unwrap(); // done key a0 (c archived, out of the index)
        let pos = |id: &str| -> String {
            conn.query_row("SELECT position FROM items WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(pos(&d), "a0");
        restore_task(&conn, &c, "done").unwrap();
        assert_eq!(pos(&c), "a1", "restored card lands at the column end, no collision");
    }

    #[test]
    fn purge_archived_ideas_and_tasks_empty_their_own_tab() {
        let conn = fresh_db();
        // two archived ideas
        for i in 0..2 {
            let n = add_item(&conn, &format!("idea{i}")).unwrap();
            file_inbox_item(&conn, &n).unwrap();
            archive_idea(&conn, &n).unwrap();
        }
        // two archived tasks
        for i in 0..2 {
            let t = insert_task(&conn, &format!("task{i}"), None, None).unwrap();
            archive_task(&conn, &t).unwrap();
        }
        assert_eq!(purge_archived_ideas(&conn).unwrap(), 2);
        assert_eq!(archived_tasks(&conn).unwrap().len(), 2, "task trash untouched by idea purge");
        assert_eq!(purge_archived_tasks(&conn).unwrap(), 2);
    }

    #[test]
    fn search_spans_stages_and_history_with_status_mapping() {
        let conn = fresh_db();
        let inbox = add_item(&conn, "买牛奶和面包").unwrap();
        let filed = add_item(&conn, "牛奶喝完了").unwrap();
        file_inbox_item(&conn, &filed).unwrap();
        let task = insert_task(&conn, "去超市买牛奶", None, None).unwrap();
        // An item whose CURRENT text lost the word, but a past version had it (history).
        let edited = add_item(&conn, "关于牛奶的旧想法").unwrap();
        update_item_content(&conn, &edited, "已经无关的新文字").unwrap();
        // archived idea that matches
        let arch = add_item(&conn, "牛奶库存笔记").unwrap();
        file_inbox_item(&conn, &arch).unwrap();
        archive_idea(&conn, &arch).unwrap();
        let _other = add_item(&conn, "完全无关").unwrap();

        let hits = search_items(&conn, "牛奶").unwrap();
        let by_id: std::collections::HashMap<&str, &SearchHit> =
            hits.iter().map(|h| (h.id.as_str(), h)).collect();
        assert_eq!(by_id[inbox.as_str()].status, "inbox");
        assert_eq!(by_id[filed.as_str()].status, "processed");
        assert_eq!(by_id[task.as_str()].status, "task");
        assert_eq!(by_id[arch.as_str()].status, "archived");
        assert!(by_id.contains_key(edited.as_str()), "history match still found");

        // '%' is literal, not a wildcard.
        let pct = add_item(&conn, "完成度 80% 了").unwrap();
        let pct_hits = search_items(&conn, "80%").unwrap();
        assert_eq!(pct_hits.len(), 1);
        assert_eq!(pct_hits[0].id, pct);
    }

    #[test]
    fn topic_trees_group_filed_ideas_and_exclude_tasks_and_trash() {
        let conn = fresh_db();
        let a = insert_topic(&conn, "甲主题").unwrap();

        let older = add_item(&conn, "较早").unwrap();
        file_inbox_item(&conn, &older).unwrap();
        link_item_topic(&conn, &older, &a).unwrap();
        conn.execute("UPDATE items SET created_at='2026-01-01T00:00:00Z' WHERE id=?1", [&older]).unwrap();
        let newer = add_item(&conn, "较晚").unwrap();
        file_inbox_item(&conn, &newer).unwrap();
        link_item_topic(&conn, &newer, &a).unwrap();
        conn.execute("UPDATE items SET created_at='2026-02-01T00:00:00Z' WHERE id=?1", [&newer]).unwrap();

        // A TASK tagged with the same topic must NOT appear in the idea tree.
        let task = insert_task(&conn, "同标签的任务", None, None).unwrap();
        link_item_topic(&conn, &task, &a).unwrap();

        // Empty topic excluded from browse, kept in management.
        let _empty = insert_topic(&conn, "空主题").unwrap();

        let browse = topics_with_notes(&conn).unwrap();
        assert_eq!(browse.len(), 1, "empty topic excluded");
        assert_eq!(browse[0].notes.len(), 2, "two filed ideas, task excluded");
        assert_eq!(browse[0].notes[0].content, "较晚", "newest first");

        let full = all_topics_with_notes(&conn).unwrap();
        assert_eq!(full.len(), 2, "empty topic kept in management view");
    }

    #[test]
    fn repoint_item_topic_unions_ideas_and_tasks_uniformly() {
        let conn = fresh_db();
        let target = insert_topic(&conn, "工作").unwrap();
        let src = insert_topic(&conn, "职业").unwrap();

        // an idea and a task both tagged with the source
        let idea = add_item(&conn, "灵感").unwrap();
        file_inbox_item(&conn, &idea).unwrap();
        link_item_topic(&conn, &idea, &src).unwrap();
        let task = insert_task(&conn, "任务", None, None).unwrap();
        link_item_topic(&conn, &task, &src).unwrap();
        // the idea also already under target (union must collapse, not duplicate)
        link_item_topic(&conn, &idea, &target).unwrap();

        repoint_item_topic(&conn, &src, &target).unwrap();
        delete_topic(&conn, &src).unwrap();

        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM item_topic WHERE topic_id=?1", [&target], |r| r.get(0))
            .unwrap();
        assert_eq!(links, 2, "idea (deduped) + task, both under the survivor");
        assert!(!topic_exists(&conn, &src).unwrap());
    }

    #[test]
    fn delete_topic_cascades_tags_off_ideas_and_tasks_but_keeps_items() {
        let conn = fresh_db();
        let topic = insert_topic(&conn, "将删").unwrap();
        let idea = add_item(&conn, "灵感").unwrap();
        file_inbox_item(&conn, &idea).unwrap();
        link_item_topic(&conn, &idea, &topic).unwrap();
        let task = insert_task(&conn, "任务", None, None).unwrap();
        link_item_topic(&conn, &task, &topic).unwrap();

        assert_eq!(delete_topic(&conn, &topic).unwrap(), 1);
        let links: i64 = conn.query_row("SELECT COUNT(*) FROM item_topic", [], |r| r.get(0)).unwrap();
        assert_eq!(links, 0, "tag links cascade away (ideas AND tasks)");
        // Items survive.
        assert_eq!(stage_of(&conn, &idea), "filed");
        assert_eq!(stage_of(&conn, &task), "todo");
    }

    // ---- 0014 data-fold migration (folded from verify-0014.mjs): seed the legacy
    // two-entity schema at v13, drive 0014, assert zero-loss. ---------------------
    #[test]
    fn migration_0014_folds_legacy_rows_without_loss() {
        let path = temp_path("fold");
        // Build the pre-0014 schema and seed legacy notes/tasks.
        {
            let c = db::open_through(&path, 13).expect("open v13");
            let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
            assert_eq!(v, 13, "stopped at the two-entity schema");

            // helper inserts
            let ins_note = |id: &str, content: &str, status: &str| {
                c.execute(
                    "INSERT INTO notes (id, content, status, created_at) VALUES (?1,?2,?3,?4)",
                    (id, content, status, "2026-01-01T00:00:00Z"),
                ).unwrap();
            };
            let ins_task = |id: &str, title: &str, status: &str| {
                c.execute(
                    "INSERT INTO tasks (id, title, status, created_at, updated_at, position) \
                     VALUES (?1,?2,?3,?4,?4,(SELECT COALESCE(MAX(position),-1)+1 FROM tasks WHERE status=?3 AND archived_at IS NULL))",
                    (id, title, status, "2026-01-02T00:00:00Z"),
                ).unwrap();
            };

            // standalone notes across all three statuses
            ins_note("n_inbox", "收件箱想法", "inbox");
            ins_note("n_proc", "已整理想法", "processed");
            ins_note("n_arch", "回收站想法", "archived");

            // a topic + tag on the processed note
            c.execute("INSERT INTO topics (id,title,summary,created_at,updated_at) VALUES ('g1','工作','','t','t')", []).unwrap();
            c.execute("INSERT INTO note_topic (note_id,topic_id) VALUES ('n_proc','g1')", []).unwrap();

            // a linked pair WITH divergence: note text != task title (original goes to history)
            ins_note("n_pair", "原始捕获文字", "processed");
            ins_task("t_pair", "编辑后的待办标题", "todo");
            c.execute("INSERT INTO task_note (task_id,note_id) VALUES ('t_pair','n_pair')", []).unwrap();
            // tag the pair's task too (union with note's tags)
            c.execute("UPDATE tasks SET topic_id='g1' WHERE id='t_pair'", []).unwrap();

            // a standalone manual task
            ins_task("t_solo", "手工任务", "doing");

            // an edit-history row on the standalone processed note
            c.execute(
                "INSERT INTO note_revisions (note_id, content, archived_at) VALUES ('n_proc','更早的版本','2026-01-01T01:00:00Z')",
                [],
            ).unwrap();
        }

        // Drive migrations 0014 (the fold) through latest (0015 drops topics.summary,
        // 0016 adds item_image, 0017 adds sealed_at, 0018 adds born_stage, 0019 adds
        // sync_meta, 0020 adds oplog, 0021 converts position to fractional keys,
        // 0024 rebuilds oplog with origin_seq, 0025 relaxes two INSERT guards under
        // the replay exemption, 0026 adds topics.color, 0027 adds sync_quarantine —
        // 除 0021 转键外均不碰折进来的行;0014 折进来的行 born_stage 保持 NULL=未知)。
        let conn = db::open(&path).expect("apply 0014+");
        let ver: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(ver, db::SCHEMA_VERSION);

        // zero-loss: 3 standalone notes + 1 pair (folded) + 1 solo task = 5 items.
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(items, 5, "3 notes + pair(1) + solo task(1)");

        // stage mapping for standalone notes
        assert_eq!(stage_of(&conn, "n_inbox"), "inbox");
        assert_eq!(stage_of(&conn, "n_proc"), "filed");
        assert_eq!(stage_of(&conn, "n_arch"), "filed");
        let arch_at: Option<String> =
            conn.query_row("SELECT archived_at FROM items WHERE id='n_arch'", [], |r| r.get(0)).unwrap();
        assert!(arch_at.is_some(), "archived note lands in the 回收站");

        // linked pair: id = note.id, content = task.title, stage from task
        assert_eq!(stage_of(&conn, "n_pair"), "todo");
        assert_eq!(current_content(&conn, "n_pair").unwrap().as_deref(), Some("编辑后的待办标题"));
        let pair_gone: i64 =
            conn.query_row("SELECT COUNT(*) FROM items WHERE id='t_pair'", [], |r| r.get(0)).unwrap();
        assert_eq!(pair_gone, 0, "task id folded into the note id, not a second row");

        // divergence: the original capture text is preserved in history.
        let pair_hist: Vec<String> = item_revisions(&conn, "n_pair").unwrap().into_iter().map(|r| r.content).collect();
        assert!(pair_hist.contains(&"原始捕获文字".to_string()), "diverged original kept in history");

        // the standalone processed note's own history carried over.
        let proc_hist: Vec<String> = item_revisions(&conn, "n_proc").unwrap().into_iter().map(|r| r.content).collect();
        assert!(proc_hist.contains(&"更早的版本".to_string()));

        // tag union: n_proc (from note_topic) + n_pair (from both note_topic-less + task.topic_id)
        let tagged: i64 =
            conn.query_row("SELECT COUNT(*) FROM item_topic WHERE topic_id='g1'", [], |r| r.get(0)).unwrap();
        assert_eq!(tagged, 2, "n_proc and the folded pair both tagged 工作");

        // integrity + FK clean.
        assert_eq!(conn.query_row::<String,_,_>("PRAGMA integrity_check", [], |r| r.get(0)).unwrap(), "ok");
        assert_eq!(conn.prepare("PRAGMA foreign_key_check").unwrap().query_map([], |_| Ok(())).unwrap().count(), 0);
    }

    // ---- 0021 position -> fractional key 数据迁移:v20 播种整数位序,驱动 0021,
    // 断言序不变、冻结行一并转键、灵感仍 NULL(同 0014 折法,fresh DB 照不出的迁移
    // 语义折进 cargo)。 -----------------------------------------------------------
    #[test]
    fn migration_0021_converts_integer_positions_to_keys_preserving_order() {
        let path = temp_path("frac");
        {
            let c = db::open_through(&path, 20).expect("open v20");
            let ins = |id: &str, stage: &str, pos: i64| {
                c.execute(
                    "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage) \
                     VALUES (?1, ?1, ?2, 't', 't', ?3, ?2)",
                    (id, stage, pos),
                ).unwrap();
            };
            // todo:稀疏、乱序插入的整数位序(拖动重排 + MAX+1 追加的真实形态)。
            ins("t1", "todo", 0);
            ins("t2", "todo", 5);
            ins("t3", "todo", 2);
            // done:活跃/回收站/归档册三行共享同一个旧号 0(冻结行退出唯一索引)。
            ins("d_arch", "done", 0);
            c.execute("UPDATE items SET archived_at='t' WHERE id='d_arch'", []).unwrap();
            ins("d_seal", "done", 0);
            c.execute("UPDATE items SET sealed_at='t' WHERE id='d_seal'", []).unwrap();
            ins("d_act", "done", 0);
            // 灵感:position 本就 NULL。
            c.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage) \
                 VALUES ('idea', '灵感', 'inbox', 't', 't', 'inbox')",
                [],
            ).unwrap();
        }

        let conn = db::open(&path).expect("apply 0021");
        let pos = |id: &str| -> Option<String> {
            conn.query_row("SELECT position FROM items WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        // todo 列:旧整数序 0 < 2 < 5 => 键序 a0 < a1 < a2,列序丝毫不变。
        assert_eq!(pos("t1").as_deref(), Some("a0"));
        assert_eq!(pos("t3").as_deref(), Some("a1"));
        assert_eq!(pos("t2").as_deref(), Some("a2"));
        assert_eq!(column_task_ids(&conn, "todo").unwrap(), vec!["t1", "t3", "t2"]);
        // done 列:同号并列按 id 打平,活跃/冻结行全部转成合规键。
        assert_eq!(pos("d_act").as_deref(), Some("a0"));
        assert_eq!(pos("d_arch").as_deref(), Some("a1"));
        assert_eq!(pos("d_seal").as_deref(), Some("a2"));
        assert_eq!(pos("idea"), None, "灵感态 position 保持 NULL");
        // 转键后生命周期照常:新建仍落列尾(a2 之后)。
        let new = insert_task(&conn, "转键后新建", None, None).unwrap();
        assert_eq!(pos(&new).as_deref(), Some("a3"));
        assert_eq!(
            conn.query_row::<String, _, _>("PRAGMA integrity_check", [], |r| r.get(0)).unwrap(),
            "ok"
        );
        assert_eq!(
            conn.prepare("PRAGMA foreign_key_check").unwrap().query_map([], |_| Ok(())).unwrap().count(),
            0
        );
    }

    // ---- 0022 回放豁免:v21 播种各形态行,驱动整表重建,断值零变 + 守护完成降级
    // (耦合 CHECK -> 触发器、UNIQUE -> 普通索引)。 -----------------------------------
    #[test]
    fn migration_0022_rebuild_preserves_rows_and_demotes_guards() {
        let path = temp_path("replayx");
        const FP: &str = "SELECT id||'|'||content||'|'||stage||'|'||created_at||'|'||updated_at \
            ||'|'||COALESCE(archived_at,'∅')||'|'||COALESCE(due_on,'∅')||'|'||COALESCE(priority,'∅') \
            ||'|'||COALESCE(position,'∅')||'|'||COALESCE(sealed_at,'∅')||'|'||COALESCE(born_stage,'∅') \
            FROM items ORDER BY id";
        let fp = |c: &Connection| -> Vec<String> {
            let mut stmt = c.prepare(FP).unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        let before: Vec<String>;
        {
            let c = db::open_through(&path, 21).expect("open v21");
            // 各形态行:活跃任务(due/priority/键)、回收站行、归档册行、filed 灵感
            // (带标签+图+编辑历史)、inbox 灵感——0022 整表重建对它们必须零值变化。
            c.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage, due_on, priority) \
                 VALUES ('t1', '活跃任务', 'todo', 'c', 'u', 'a0', 'todo', '2026-07-10', 2)",
                [],
            ).unwrap();
            c.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage) \
                 VALUES ('tr', '回收站的', 'todo', 'c', 'u', 'a1', 'todo')",
                [],
            ).unwrap();
            c.execute("UPDATE items SET stage='done', archived_at='x' WHERE id='tr'", []).unwrap();
            c.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage) \
                 VALUES ('sl', '入册的', 'todo', 'c', 'u', 'a2', 'todo')",
                [],
            ).unwrap();
            c.execute("UPDATE items SET stage='done' WHERE id='sl'", []).unwrap();
            c.execute("UPDATE items SET sealed_at='s' WHERE id='sl'", []).unwrap();
            c.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage) \
                 VALUES ('fi', '已归类灵感', 'inbox', 'c', 'u', 'inbox')",
                [],
            ).unwrap();
            c.execute("UPDATE items SET stage='filed' WHERE id='fi'", []).unwrap();
            c.execute("INSERT INTO topics (id, title, created_at, updated_at) VALUES ('g', '标签', 'c', 'c')", []).unwrap();
            c.execute("INSERT INTO item_topic (item_id, topic_id) VALUES ('fi', 'g')", []).unwrap();
            c.execute("INSERT INTO item_image_counter (item_id, last_seq) VALUES ('fi', 1)", []).unwrap();
            c.execute(
                "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) \
                 VALUES ('img', 'fi', 1, x'01', 'image/png', 'c')",
                [],
            ).unwrap();
            c.execute("UPDATE items SET content='已归类灵感(改)' WHERE id='fi'", []).unwrap(); // 长一条历史
            c.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage) \
                 VALUES ('in', '未归类', 'inbox', 'c', 'u', 'inbox')",
                [],
            ).unwrap();
            before = fp(&c);
        }

        let conn = db::open(&path).expect("apply 0022");
        assert_eq!(fp(&conn), before, "整表重建零值变化(含 updated_at)");
        for (table, want) in [("topics", 1i64), ("item_topic", 1), ("item_image", 1),
                              ("item_image_counter", 1), ("item_revisions", 1)] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, want, "{table} 行数不变(FK 随重命名自动指向新表)");
        }
        // 守护完成换防:耦合从表 CHECK 降为触发器(单机照拦),UNIQUE 降普通(同键允许)。
        assert!(conn.execute("UPDATE items SET position=NULL WHERE id='t1'", []).is_err(),
            "任务态丢排序键仍被拦(耦合触发器接棒)");
        assert!(conn.execute("UPDATE items SET due_on='2026-07-11' WHERE id='fi'", []).is_err(),
            "灵感态带 due 仍被拦");
        conn.execute("INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage) \
                      VALUES ('t2', '同键卡', 'todo', 'c', 'u', 'a0', 'todo')", [])
            .expect("同列同键自 0022 起允许(多写者合并的合法结局)");
        // 回放标志表就位且为空。
        let flags: i64 =
            conn.query_row("SELECT COUNT(*) FROM sync_replay_active", [], |r| r.get(0)).unwrap();
        assert_eq!(flags, 0);
        assert_eq!(
            conn.query_row::<String, _, _>("PRAGMA integrity_check", [], |r| r.get(0)).unwrap(),
            "ok"
        );
        assert_eq!(
            conn.prepare("PRAGMA foreign_key_check").unwrap().query_map([], |_| Ok(())).unwrap().count(),
            0
        );
    }

    #[test]
    fn migration_0023_heals_stale_image_counters_and_narrows_immutable_guard() {
        let path = temp_path("imgseq");
        {
            let c = db::open_through(&path, 22).expect("open v22");
            // 手工造两种损坏态(正常路径不会产生):counter 落后于行上最大编号 / counter
            // 缺行。顺延纯函数的遗产下界依赖「counter ≥ 一切已用编号」,0023 一次性钉死。
            c.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage) \
                 VALUES ('h1', '带图甲', 'inbox', 't', 't', 'inbox'), \
                        ('h2', '带图乙', 'inbox', 't', 't', 'inbox')",
                [],
            ).unwrap();
            c.execute(
                "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) \
                 VALUES ('hi1', 'h1', 5, x'01', 'image/png', 't'), \
                        ('hi2', 'h2', 3, x'01', 'image/png', 't')",
                [],
            ).unwrap();
            c.execute("INSERT INTO item_image_counter (item_id, last_seq) VALUES ('h1', 2)", [])
                .unwrap();
        }
        let conn = db::open(&path).expect("apply 0023");
        let last = |item: &str| -> i64 {
            conn.query_row(
                "SELECT last_seq FROM item_image_counter WHERE item_id = ?1",
                [item],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!((last("h1"), last("h2")), (5, 3), "落后的抬平、缺行的补齐");
        // 守护重建后本地写照拦;回放事务里也只许改 seq(其余列动一下都 ABORT)。
        assert!(conn.execute("UPDATE item_image SET seq = 9 WHERE id = 'hi1'", []).is_err());
        conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        assert!(conn.execute("UPDATE item_image SET mime = 'image/gif' WHERE id = 'hi1'", []).is_err(),
            "回放豁免只放行 seq,别的列照拦");
        conn.execute("UPDATE item_image SET seq = 9 WHERE id = 'hi1'", [])
            .expect("回放事务里的顺延改号放行");
        conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    }

    #[test]
    fn migration_0024_backfills_origin_seq_per_origin_in_hlc_order() {
        let path = temp_path("originseq");
        {
            let c = db::open_through(&path, 23).expect("open v23");
            // 两个 origin 的 op 乱序入库(0020 结构无 origin_seq 列;插入序 ≠ hlc 序,
            // 证明 backfill 按 hlc 补号而不是按 rowid)。
            c.execute_batch(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload) VALUES
                   ('opA3', '0000000000005-00000000-DEVAAAA', 'item', 'i1', 'tombstone', '{}'),
                   ('opB1', '0000000000002-00000000-DEVBBBB', 'item', 'i2', 'create', '{}'),
                   ('opA1', '0000000000001-00000000-DEVAAAA', 'item', 'i1', 'create', '{}'),
                   ('opB2', '0000000000004-00000000-DEVBBBB', 'item', 'i2', 'set_field', '{}'),
                   ('opA2', '0000000000003-00000000-DEVAAAA', 'item', 'i1', 'set_field', '{}');",
            )
            .unwrap();
        }
        let conn = db::open(&path).expect("apply 0024");
        let seq_of = |op: &str| -> (String, i64) {
            conn.query_row(
                "SELECT origin, origin_seq FROM oplog WHERE op_id = ?1",
                [op],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(seq_of("opA1"), ("DEVAAAA".into(), 1));
        assert_eq!(seq_of("opA2"), ("DEVAAAA".into(), 2));
        assert_eq!(seq_of("opA3"), ("DEVAAAA".into(), 3));
        assert_eq!(seq_of("opB1"), ("DEVBBBB".into(), 1));
        assert_eq!(seq_of("opB2"), ("DEVBBBB".into(), 2));
        // append-only 铁律随整表重建原样归位。
        assert!(conn.execute("UPDATE oplog SET origin_seq = 9 WHERE op_id = 'opA1'", []).is_err());
        assert!(conn.execute("DELETE FROM oplog WHERE op_id = 'opA1'", []).is_err());
        assert_eq!(
            conn.query_row::<String, _, _>("PRAGMA integrity_check", [], |r| r.get(0)).unwrap(),
            "ok"
        );
    }

    // ---- 成就归档 (migration 0017 sealed_at) --------------------------------------

    #[test]
    fn seal_only_done_and_not_trashed() {
        let conn = fresh_db();
        // todo 不可归档(guard 0 行;raw UPDATE 也被触发器 ABORT)。
        let todo = insert_task(&conn, "还没做完", None, None).unwrap();
        assert_eq!(seal_task(&conn, &todo).unwrap(), 0);
        assert!(conn
            .execute("UPDATE items SET sealed_at='2026-01-01T00:00:00Z' WHERE id=?1", [&todo])
            .is_err(), "trigger blocks sealing a non-done task");
        // 回收站中的 done 不可归档。
        let trashed = insert_task(&conn, "完成后删了", None, None).unwrap();
        set_task_stage(&conn, &trashed, "todo", "done").unwrap();
        archive_task(&conn, &trashed).unwrap();
        assert_eq!(seal_task(&conn, &trashed).unwrap(), 0);
        // 灵感不可归档。
        let idea = add_item(&conn, "灵感").unwrap();
        assert_eq!(seal_task(&conn, &idea).unwrap(), 0);
        // 活跃 done 可归档;重复归档是 0 行 no-op。
        let done = insert_task(&conn, "干完的活", None, None).unwrap();
        set_task_stage(&conn, &done, "todo", "done").unwrap();
        assert_eq!(seal_task(&conn, &done).unwrap(), 1);
        assert_eq!(seal_task(&conn, &done).unwrap(), 0, "already sealed -> no-op");
        // 条目不能生而归档。(born_stage/position 给足合法值,确保拦下它的是 0017 的
        // 禁生而归档触发器,而不是 0018 出生态必填或 position 形态 CHECK。)
        assert!(conn
            .execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, position, sealed_at, born_stage) \
                 VALUES ('born-sealed', 'x', 'done', 't', 't', 'a5', 't', 'done')",
                [],
            )
            .is_err(), "trigger blocks inserting a pre-sealed row");
    }

    #[test]
    fn sealed_is_frozen_undeletable_and_off_every_active_read() {
        let conn = fresh_db();
        let t = insert_task(&conn, "已归档成就", None, None).unwrap();
        set_task_stage(&conn, &t, "todo", "done").unwrap();
        seal_task(&conn, &t).unwrap();

        // 不在看板、不在回收站,只在归档册。
        assert!(list_tasks(&conn).unwrap().is_empty());
        assert!(archived_tasks(&conn).unwrap().is_empty());
        let sealed = sealed_tasks(&conn).unwrap();
        assert_eq!(sealed.len(), 1);
        assert!(sealed[0].sealed_at.is_some());
        assert!(active_task_stage(&conn, &t).unwrap().is_none(), "off the active board");

        // 冻结:改名/截止/优先级/移列/入回收站 全部 0 行(guard),raw UPDATE 被触发器 ABORT。
        assert_eq!(rename_task(&conn, &t, "改名").unwrap(), 0);
        assert_eq!(set_task_due(&conn, &t, Some("2026-07-06")).unwrap(), 0);
        assert_eq!(set_task_priority(&conn, &t, Some(1)).unwrap(), 0);
        assert_eq!(set_task_stage(&conn, &t, "done", "todo").unwrap(), 0);
        assert_eq!(archive_task(&conn, &t).unwrap(), 0);
        assert!(conn
            .execute("UPDATE items SET content='篡改' WHERE id=?1", [&t])
            .is_err(), "frozen trigger blocks raw edits");

        // 不可删:硬删 ABORT(专属触发器),purge guard 也不放行。
        assert!(conn.execute("DELETE FROM items WHERE id=?1", [&t]).is_err());
        assert_eq!(purge_task(&conn, &t).unwrap(), 0);
    }

    #[test]
    fn unseal_returns_to_done_column_end_without_position_collision() {
        let conn = fresh_db();
        let a = insert_task(&conn, "先归档的", None, None).unwrap();
        set_task_stage(&conn, &a, "todo", "done").unwrap(); // done key a0
        seal_task(&conn, &a).unwrap();
        // a 归档后其冻结的键 a0 退出唯一索引;新完成的 b 拿到 a0 不撞。
        let b = insert_task(&conn, "后完成的", None, None).unwrap();
        set_task_stage(&conn, &b, "todo", "done").unwrap();
        let pos = |id: &str| -> String {
            conn.query_row("SELECT position FROM items WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(pos(&b), "a0", "sealed row's frozen key is out of the unique index");

        // 取消归档:回 done 列尾,不撞 b。
        assert_eq!(unseal_task(&conn, &a).unwrap(), 1);
        assert_eq!(unseal_task(&conn, &a).unwrap(), 0, "not sealed anymore -> no-op");
        assert_eq!(pos(&a), "a1", "unsealed card lands at the column end");
        assert_eq!(list_tasks(&conn).unwrap().len(), 2, "back on the board");
        assert!(sealed_tasks(&conn).unwrap().is_empty());
    }

    #[test]
    fn seal_all_done_sweeps_only_active_done() {
        let conn = fresh_db();
        let d1 = insert_task(&conn, "完成一", None, None).unwrap();
        set_task_stage(&conn, &d1, "todo", "done").unwrap();
        let d2 = insert_task(&conn, "完成二", None, None).unwrap();
        set_task_stage(&conn, &d2, "todo", "done").unwrap();
        let doing = insert_task(&conn, "进行中", None, None).unwrap();
        set_task_stage(&conn, &doing, "todo", "doing").unwrap();
        let trashed = insert_task(&conn, "回收站的完成", None, None).unwrap();
        set_task_stage(&conn, &trashed, "todo", "done").unwrap();
        archive_task(&conn, &trashed).unwrap();

        assert_eq!(seal_all_done(&conn).unwrap(), 2, "only the two active done");
        assert_eq!(seal_all_done(&conn).unwrap(), 0, "second sweep finds nothing");
        assert_eq!(sealed_tasks(&conn).unwrap().len(), 2);
        assert_eq!(list_tasks(&conn).unwrap().len(), 1, "doing stays");
        assert_eq!(archived_tasks(&conn).unwrap().len(), 1, "trash untouched");
    }

    #[test]
    fn search_reports_sealed_status() {
        let conn = fresh_db();
        let t = insert_task(&conn, "归档的牛奶采购", None, None).unwrap();
        set_task_stage(&conn, &t, "todo", "done").unwrap();
        seal_task(&conn, &t).unwrap();
        let hits = search_items(&conn, "牛奶采购").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].status, "sealed");
    }

    // ---- 出生态 (migration 0018 born_stage) ----------------------------------------

    #[test]
    fn born_stage_records_birth_truthfully_and_is_frozen() {
        let conn = fresh_db();
        let idea = add_item(&conn, "生而为灵感").unwrap();
        let task = insert_task(&conn, "生而为任务", None, None).unwrap();
        let born = |id: &str| -> String {
            conn.query_row("SELECT born_stage FROM items WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(born(&idea), "inbox");
        assert_eq!(born(&task), "todo");
        // 转待办翻 stage,出生态不动——这正是统计要的史实。
        assert_eq!(promote_to_todo(&conn, &idea).unwrap(), 1);
        assert_eq!(stage_of(&conn, &idea), "todo");
        assert_eq!(born(&idea), "inbox");
        // 出生态冻结:改写被触发器 ABORT。
        assert!(conn
            .execute("UPDATE items SET born_stage='todo' WHERE id=?1", [&idea])
            .is_err(), "born_stage is frozen");
        // 新行不带出生态、或谎报出生态,一律拒收。
        assert!(conn
            .execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at) \
                 VALUES ('no-born', 'x', 'inbox', 't', 't')",
                [],
            )
            .is_err(), "born_stage is required on insert");
        assert!(conn
            .execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage) \
                 VALUES ('lied', 'x', 'inbox', 't', 't', 'todo')",
                [],
            )
            .is_err(), "born_stage must equal the stage at birth");
    }

    #[test]
    fn idea_stats_counts_births_and_conversions() {
        let conn = fresh_db();
        // 两条生而为灵感(其一转待办)、一条生而为任务(不进灵感统计的分母)。
        let a = add_item(&conn, "灵感甲").unwrap();
        let _b = add_item(&conn, "灵感乙").unwrap();
        insert_task(&conn, "直接建的任务", None, None).unwrap();
        assert_eq!(promote_to_todo(&conn, &a).unwrap(), 1);
        let all = idea_stats(&conn, "0000-01-01T00:00:00Z").unwrap();
        assert_eq!((all.captured_week, all.born_inbox, all.converted), (2, 2, 1));
        // week_start 在未来:本周 0,累计口径(分母/分子)不变。
        let none = idea_stats(&conn, "9999-01-01T00:00:00Z").unwrap();
        assert_eq!((none.captured_week, none.born_inbox, none.converted), (0, 2, 1));
        // 转过待办的灵感进了回收站也仍算「转过」(经历是史实):软删后分子不掉。
        assert_eq!(archive_task(&conn, &a).unwrap(), 1);
        let after = idea_stats(&conn, "0000-01-01T00:00:00Z").unwrap();
        assert_eq!((after.born_inbox, after.converted), (2, 1));
    }

    #[test]
    fn idea_stats_excludes_pre_0018_unknown_births() {
        // 0018 之前的老行 born_stage 是 NULL(未知):统计诚实排除,不猜、也不许事后补猜。
        let path = temp_path("born-legacy");
        {
            let conn = db::open_through(&path, 17).expect("open at v17");
            conn.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at) \
                 VALUES ('legacy', '老灵感', 'inbox', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let conn = db::open(&path).expect("migrate to v18");
        add_item(&conn, "新灵感").unwrap();
        let s = idea_stats(&conn, "0000-01-01T00:00:00Z").unwrap();
        assert_eq!((s.captured_week, s.born_inbox), (1, 1), "legacy NULL row stays out");
        assert!(conn
            .execute("UPDATE items SET born_stage='inbox' WHERE id='legacy'", [])
            .is_err(), "the unknown is frozen too — no back-filling guesses");
        // 老行照常参与其它一切(列表/编辑/删除不受未知出生态影响)。
        assert_eq!(live_ideas(&conn).unwrap().len(), 2);
    }

    // ---- Item images (migration 0016) -------------------------------------------

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47]; // non-empty bytes; content isn't validated

    /// The image tests drive the images.rs orchestration, which now emits ops — it
    /// needs the sync clock alongside the connection.
    fn clock_for(conn: &Connection) -> crate::clock::Clock {
        crate::clock::Clock::load(conn).expect("load clock")
    }

    #[test]
    fn item_images_number_monotonically_and_never_reuse() {
        let mut conn = fresh_db();
        let mut clock = clock_for(&conn);
        let item = add_item(&conn, "配图说明").unwrap();
        let (_i1, s1) = crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        let (_i2, s2) = crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        let (i3, s3) = crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        assert_eq!((s1, s2, s3), (1, 2, 3), "编号 starts at 1 and climbs");

        // Delete the TOP image, then add again: the 编号 must NOT fall back to 3 — otherwise a
        // 正文「见图3」 reference would silently re-point at a new picture.
        assert_eq!(delete_item_image(&conn, &i3).unwrap(), 1);
        let (_i4, s4) = crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        assert_eq!(s4, 4, "deleting the trailing image must not let its 编号 be reused");

        // The remaining list shows the gap (图1、图2、图4), ascending, never renumbered.
        let seqs: Vec<i64> = list_item_images(&conn, &item).unwrap().iter().map(|r| r.seq).collect();
        assert_eq!(seqs, vec![1, 2, 4]);
    }

    #[test]
    fn deleting_a_middle_image_leaves_a_hole() {
        let mut conn = fresh_db();
        let mut clock = clock_for(&conn);
        let item = add_item(&conn, "x").unwrap();
        crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        let (i2, _) = crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        assert_eq!(delete_item_image(&conn, &i2).unwrap(), 1);
        let seqs: Vec<i64> = list_item_images(&conn, &item).unwrap().iter().map(|r| r.seq).collect();
        assert_eq!(seqs, vec![1, 3], "删图留洞、不重排:图2 走了,图1/图3 不动");
    }

    #[test]
    fn live_timeline_images_batch_matches_per_item_and_filters_dead_items() {
        // 安卓 list_timeline 的 N+1 批量替代:批量口径必须与逐条口径逐字段一致,
        // 且滤轴与 live_timeline 同轴——回收站/成就册条目的图不出行。
        let mut conn = fresh_db();
        let mut clock = clock_for(&conn);
        let a = add_item(&conn, "两图").unwrap();
        let b = add_item(&conn, "无图").unwrap();
        let trashed = add_item(&conn, "回收站带图").unwrap();
        let sealed = insert_task(&conn, "入册带图", None, None).unwrap();
        crate::images::attach(&mut conn, &mut clock, &a, PNG, "image/png").unwrap();
        crate::images::attach(&mut conn, &mut clock, &a, PNG, "image/png").unwrap();
        crate::images::attach(&mut conn, &mut clock, &trashed, PNG, "image/png").unwrap();
        crate::images::attach(&mut conn, &mut clock, &sealed, PNG, "image/png").unwrap();
        archive_idea(&conn, &trashed).unwrap();
        set_task_stage(&conn, &sealed, "todo", "done").unwrap();
        seal_task(&conn, &sealed).unwrap();

        let map = live_timeline_images(&conn).unwrap();
        let flat = |v: &[ImageRef]| -> Vec<(String, i64, String)> {
            v.iter().map(|r| (r.id.clone(), r.seq, r.mime.clone())).collect()
        };
        assert_eq!(
            flat(map.get(&a).expect("活条目的图成组带出")),
            flat(&list_item_images(&conn, &a).unwrap()),
            "批量与逐条同值同序(seq 升序)"
        );
        assert!(!map.contains_key(&b), "无图条目不出行(壳侧取空即空列表)");
        assert!(!map.contains_key(&trashed), "回收站条目的图不进时间轴批量");
        assert!(!map.contains_key(&sealed), "成就册条目的图不进时间轴批量");
    }

    #[test]
    fn hard_deleting_item_cascades_its_images_and_counter() {
        let mut conn = fresh_db();
        let mut clock = clock_for(&conn);
        let item = add_item(&conn, "x").unwrap();
        crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        // An inbox/unarchived item is hard-deletable; the FK cascade takes its images + counter.
        assert_eq!(delete_inbox_item(&conn, &item).unwrap(), 1);
        let imgs: i64 = conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        let cnt: i64 = conn.query_row("SELECT COUNT(*) FROM item_image_counter", [], |r| r.get(0)).unwrap();
        assert_eq!((imgs, cnt), (0, 0), "hard delete cascades images + counter away");
    }

    #[test]
    fn item_image_data_round_trips_bytes_and_mime() {
        let mut conn = fresh_db();
        let mut clock = clock_for(&conn);
        let item = add_item(&conn, "x").unwrap();
        let (id, _) = crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        let (bytes, mime) = item_image_data(&conn, &id).unwrap().unwrap();
        assert_eq!(bytes, PNG);
        assert_eq!(mime, "image/png");
        assert!(item_image_data(&conn, "no-such-id").unwrap().is_none());
    }

    #[test]
    fn item_image_rows_are_immutable() {
        let mut conn = fresh_db();
        let mut clock = clock_for(&conn);
        let item = add_item(&conn, "x").unwrap();
        let (id, _) = crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        let err = conn
            .execute("UPDATE item_image SET mime = 'image/jpeg' WHERE id = ?1", [&id])
            .unwrap_err();
        assert!(err.to_string().contains("只追加"), "item_image must reject UPDATE: {err}");
    }

    #[test]
    fn attach_rejects_bad_mime_empty_blob_and_unknown_item() {
        let mut conn = fresh_db();
        let mut clock = clock_for(&conn);
        let item = add_item(&conn, "x").unwrap();
        assert!(crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/svg+xml").is_err(), "bad mime");
        assert!(crate::images::attach(&mut conn, &mut clock, &item, &[], "image/png").is_err(), "empty blob");
        assert!(
            crate::images::attach(&mut conn, &mut clock, "no-such-item", PNG, "image/png").is_err(),
            "unknown item fails the FK"
        );
        // A rejected attach burns no 编号 (counter rolled back) — first good image is still 图1.
        let (_id, seq) = crate::images::attach(&mut conn, &mut clock, &item, PNG, "image/png").unwrap();
        assert_eq!(seq, 1, "rejected attaches leave the 编号 counter untouched");
    }
}
