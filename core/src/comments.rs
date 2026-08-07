//! 条目留言的编排层(identity-plan §4)。
//!
//! 留言是 `items` 的附属实体:**只增与删,不可编辑**(§4.1)——改错了删掉重写。写路径
//! 与其它编排层同形:同事务「行 + op + HLC 落盘」,锁序 db → clock,幂等 no-op 不发射。
//!
//! 三条本模块特有的约束:
//! - **署名 fail-closed**:`born_device` 由 SQL 子查询从 `sync_meta` 取(与
//!   `trg_comment_born_device_required` 同源),取不到就撞触发器 ABORT,绝不静默落 NULL。
//!   NULL 是合法值,但它**只有一个来源** —— 跨空间搬迁(§4.5)。
//! - **软闸在事务内数**:并发两笔不能「各自查完都说没满」然后一起越界。
//! - **列表分页**:`list_for_item` 是 keyset 分页,不是 `-> Vec` 全量(§4.6.2:全量在
//!   软闸下也能一次拉约 98 MiB 过 IPC/DOM)。

use std::collections::HashMap;

use rusqlite::Connection;
use ulid::Ulid;

use crate::clock::Clock;
use crate::{oplog, repo};

/// 每条目留言数的**本地写入软闸**(identity-plan §4.6.3)。
///
/// ⚠ 它**只是本地写入闸**:远端 create 不设协议硬闸(与 `image_add` 完全同族——威胁模型
/// 是持 K_acc 的已鉴权成员,单给 comment 加硬闸不成安全边界,改用 image 即绕过)。
/// **绝不能拿它给 epoch / 跨空间移动 / UI 列表提供总量上界**(设计审一轮 H4 打的就是这句)
/// ——那三处各有自己的闸:压实的债记在 progress-log 314,移动走 `move_item::move_peak_bytes`,
/// 列表走本模块的分页。
pub const MAX_COMMENTS_PER_ITEM: i64 = 500;

/// 一页的条数上界。
pub const PAGE_ROWS: usize = 50;

/// 一页的字节预算:**量的是本页各行 `content` 的 UTF-8 原始字节和**,不是 JSON 编码后的
/// 字节(设计审二轮 M3)。量 JSON 的话,一条 200 KiB 正文里的引号 / 反斜杠 / 控制字符经
/// 转义可能胀过预算,**一条合法留言反而一页都装不下**;量原始字节则「单行上限 200 KiB <
/// 256 KiB ⇒ 至少能返回一行」是结构保证。定宽元数据(id / 时间 / 设备 id)另计小常数。
pub const PAGE_CONTENT_BYTES: usize = 256 * 1024;

/// 一条留言(读出面)。`born_device` 为 None = 作者未知(跨空间搬迁而来)。
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Comment {
    pub id: String,
    pub content: String,
    pub created_at: String,
    pub born_device: Option<String>,
}

/// 一页留言。`next_cursor` = 最后一个**被纳入**的行的 `(created_at, id)`。
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct CommentPage {
    pub rows: Vec<Comment>,
    pub next_cursor: Option<(String, String)>,
    /// ⚠ **不是**「本页够 50」猜出来的(设计审 GO 复核面第 9 条):它由「还多读到一行」
    /// 或「字节预算截断」两条**事实**得出。
    pub has_more: bool,
}

/// 写一条留言,返回新 id。
///
/// 事务内做完四件校验(正文长度 / 非空 / 宿主在 / 软闸),再落行发 op —— 全在同一个事务里,
/// 「查完到写入之间被别人插一条」挤不进来。
pub fn add(
    conn: &mut Connection,
    clock: &mut Clock,
    item_id: &str,
    content: &str,
) -> Result<String, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("留言不能为空".into());
    }
    repo::ensure_content_fits(content)?;
    // 宿主 id 的**协议值域**闸(codex 实现审一轮 M1)。「行在不在」不等于「这个 id 发得
    // 出去」:`items.id` 存储层没有 ULID CHECK,item op 的 `entity_id` 在 `validate_op_shape`
    // 里也没有形态闸 —— 于是库里**可能合法存在**一个非规范 id 的条目(某个已鉴权成员发来
    // 的)。对它留言会本地落行成功,而发出去的 comment create 撞别端 comment shape 闸的
    // `item_id` 必须是规范 ULID → `InvalidOp` → **把老老实实发消息的自己那条 origin 持久
    // 隔离**(§3.5 那条教训的同族:自己发的东西让别人拒到无法自愈)。这里当场拒,代价是
    // 那条脏条目留不了言 —— 比整台设备停止同步便宜得多。
    if !crate::clock::is_canonical_ulid(item_id) {
        return Err("这条条目的 id 不是规范形,不能给它写留言(它的 id 发不出去)".into());
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let host: i64 = tx
        .query_row("SELECT COUNT(*) FROM items WHERE id = ?1", [item_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if host == 0 {
        return Err("条目不存在(可能已被删除)".into());
    }
    let used: i64 = tx
        .query_row("SELECT COUNT(*) FROM item_comment WHERE item_id = ?1", [item_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if used >= MAX_COMMENTS_PER_ITEM {
        return Err(format!("这条已经有 {used} 条留言(上限 {MAX_COMMENTS_PER_ITEM}),删掉几条再写"));
    }

    let id = Ulid::new().to_string();
    // born_device 走子查询,与触发器同源:sync_meta 没有 device_id 行时
    // 子查询得 NULL → 触发器 ABORT(fail-closed,绝不静默落一个永不可改的错署名)。
    tx.execute(
        "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
         VALUES (?1, ?2, ?3, ?4, (SELECT value FROM sync_meta WHERE key = 'device_id'))",
        (&id, item_id, content, repo::now_iso_millis()),
    )
    .map_err(|e| format!("写留言失败:{e}"))?;
    oplog::comment_create(&tx, clock, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// 销毁一条留言(**直接销毁,不进回收站** —— 用户 2026-08-06 拍板;UI 两拍确认兜)。
///
/// 行不在 = 幂等 no-op,**不发 op、不报错**:另一端删了并同步过来是正常并发,不是错误。
pub fn remove(conn: &mut Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = tx
        .execute("DELETE FROM item_comment WHERE id = ?1", [id])
        .map_err(|e| format!("删除留言失败:{e}"))?;
    if n == 0 {
        return Ok(());
    }
    oplog::comment_tombstone(&tx, clock, id)?;
    tx.commit().map_err(|e| e.to_string())
}

/// 一页留言,最近优先。`cursor` = 上一页的 `next_cursor`(None = 第一页)。
///
/// 排序与游标谓词用**同一个 TEXT 全序**(同列序、同方向、默认 BINARY collation),故
/// 无论 `created_at` 的文本序是否等于真实时间序,都不跳行不重复(设计审四轮 F)。
pub fn list_for_item(
    conn: &Connection,
    item_id: &str,
    cursor: Option<(&str, &str)>,
) -> Result<CommentPage, String> {
    // 多读一行:has_more 要由事实得出,不许拿「本页够 50」猜。
    let limit = PAGE_ROWS as i64 + 1;
    let mut rows: Vec<Comment> = Vec::with_capacity(PAGE_ROWS);
    let mut bytes = 0usize;
    let mut has_more = false;
    {
        // 两分支的 ORDER BY 一字不差 —— 游标谓词与排序必须是同一个 TEXT 全序。
        let mut stmt = conn
            .prepare(match cursor {
                Some(_) => {
                    "SELECT id, content, created_at, born_device FROM item_comment \
                     WHERE item_id = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id < ?3)) \
                     ORDER BY created_at DESC, id DESC LIMIT ?4"
                }
                None => {
                    "SELECT id, content, created_at, born_device FROM item_comment \
                     WHERE item_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2"
                }
            })
            .map_err(|e| e.to_string())?;
        let mut q = match cursor {
            Some((ca, id)) => stmt.query(rusqlite::params![item_id, ca, id, limit]),
            None => stmt.query(rusqlite::params![item_id, limit]),
        }
        .map_err(|e| e.to_string())?;

        // **逐行消费,不先攒一整批**(codex 实现审一轮 M2):`LIMIT 51` 那 51 行各自可以
        // 到 200 KiB,先 collect 再裁的话本地峰值 ≈ 10 MiB —— 出口有 256 KiB 闸,入口没有。
        // 分页本来就是为了别在手机上整批物化附属正文,这一格原先只做了一半。
        // 现在的峰值 = 已纳入的一页(**合法库状态下** ≤ 256 KiB)+ 手上这一枚候选。
        // 「合法库状态下」这半句不是客套:下面那一支「第一行无条件纳入」是**损坏态的
        // 前进保证**,它一旦被走到(一行独自越预算),这一页本身就超了预算。
        // (SQLite 侧仍会为当前行准备值,省的是 Rust 侧的整批 String。)
        while let Some(r) = q.next().map_err(|e| e.to_string())? {
            // 条数上界:多读到的那一行只用来**得出 has_more 这个事实**,不纳入。
            if rows.len() == PAGE_ROWS {
                has_more = true;
                break;
            }
            let content: String = r.get(1).map_err(|e| e.to_string())?;
            // 字节预算:**先量候选行,再决定纳不纳入**;越预算的那行不纳入、也不消费它的
            // cursor(消费了的话下一页从它之后开始,那一行被永久跳过 —— 设计审二轮 M3)。
            // 第一行无条件纳入 —— 这一支是**前进保证**:没有它,一行都装不下时这一页会
            // 永远返回空、而 cursor 停在原地。合法数据今天走不到它(正文上限 200 KiB <
            // 256 KiB 预算),行为锚靠可信语境直灌一条 300 KiB 的行来证。
            if !rows.is_empty() && bytes + content.len() > PAGE_CONTENT_BYTES {
                has_more = true;
                break;
            }
            bytes += content.len();
            rows.push(Comment {
                id: r.get(0).map_err(|e| e.to_string())?,
                content,
                created_at: r.get(2).map_err(|e| e.to_string())?,
                born_device: r.get(3).map_err(|e| e.to_string())?,
            });
        }
    }

    let next_cursor = rows.last().map(|c| (c.created_at.clone(), c.id.clone()));
    Ok(CommentPage { rows, next_cursor, has_more })
}

/// 每条目的留言数(徽章用):**一次 GROUP BY 聚合读,不 N+1**。
/// 零留言的条目不在返回里(前端按 0 处理 —— N=0 不显示徽章)。
pub fn counts_all(conn: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut stmt = conn
        .prepare("SELECT item_id, COUNT(*) FROM item_comment GROUP BY item_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, n) = row.map_err(|e| e.to_string())?;
        out.insert(id, n);
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
