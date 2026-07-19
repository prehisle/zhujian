//! 图片编排 (item images): attach an image to an item as a numbered 「图N」 attachment.
//! Thin orchestration over repo primitives, mirroring notes.rs (灵感编排) / task.rs (看板编排).
//! The multi-statement ops — allocate the next 编号 from the high-water counter + insert the
//! bytes + emit the op, or delete + emit — each run in a single transaction so a 编号 is never
//! burned without an image, nor a change made without its op. Listing / fetching are single
//! repo calls and go straight from the command layer.

use rusqlite::Connection;

use crate::clock::Clock;
use crate::{oplog, repo};

/// The image MIME types we accept (clipboard paste / file import). Checked up front for a
/// clear error; the DB CHECK in migration 0016 is the backstop — same belt-and-suspenders as
/// task::create range-checking priority.
const ALLOWED_MIME: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// 单张配图字节上限(协议级,本地与同步同一条线):粘贴截图/参考图量级 32 MiB 绰绰
/// 有余。同步侧靠它给 image_add 声明的 bytes 封顶——没有它,异常对端可声明天文数字
/// 让收端「合法」攒块到无界内存(replay::apply_image_add / sync 引擎共用此常量)。
pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// 单条目「图N」编号的协议级上限(codex 二审):远超任何人手动配图数,但挡住恶意
/// image_add 塞 i64::MAX 的 seq——否则并发撞号顺延的 `max_seen + 1` 会溢出、counter 被抬到
/// 天上使下次 attach 的 `last_seq + 1` 失败(本地 DoS)。boot 审计另查全局 counter ≤ 此上限。
pub const MAX_IMAGE_SEQ: i64 = 1_000_000;

/// Attach `data` (raw image bytes, type `mime`) to item `item_id` as its next 「图N」 attachment.
/// One transaction: bump the item's high-water 编号 counter, then insert the row — a bad MIME /
/// empty blob (CHECK) or unknown item (FK) fails the insert and rolls the counter bump back, so
/// a rejected image leaves no gap. The freed 编号 of a previously-deleted image is never reused.
/// The image_add op carries metadata only (编号/MIME/字节数) — bytes will travel the sidechannel
/// (sync-plan §3.4), never the op stream. Returns the new image's (id, seq).
pub fn attach(
    conn: &mut Connection,
    clock: &mut Clock,
    item_id: &str,
    data: &[u8],
    mime: &str,
) -> Result<(String, i64), String> {
    if data.is_empty() {
        return Err("图片为空,无法保存".to_string());
    }
    if data.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大({} MB,上限 {} MB)",
            data.len() / (1024 * 1024),
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    if !ALLOWED_MIME.contains(&mime) {
        return Err(format!("不支持的图片类型 {mime}(仅支持 png / jpeg / webp / gif)"));
    }

    let id = ulid::Ulid::new().to_string();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let seq = repo::next_image_seq(&tx, item_id).map_err(|e| e.to_string())?;
    if seq > MAX_IMAGE_SEQ {
        // 本地也守协议上限(codex 二审):否则本机能产生 > 上限的编号,所有远端与 boot 都拒。
        return Err(format!("该条目配图数已达上限({MAX_IMAGE_SEQ}),无法再添加"));
    }
    let n = repo::insert_item_image(&tx, &id, item_id, seq, data, mime).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("图片写入失败,影响 {n} 行"));
    }
    oplog::image_add(&tx, clock, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((id, seq))
}

/// Delete one image (换图 / 移除配图). Its 编号 is retired, never reused. A missing id is an
/// error, not a silent no-op. One transaction: read the owner (the tombstone op needs it —
/// the row is gone afterwards), delete, emit.
pub fn remove(conn: &mut Connection, clock: &mut Clock, image_id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let item_id = repo::item_image_owner(&tx, image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "删除失败:图片不存在或已删除(影响 0 行)".to_string())?;
    let n = repo::delete_item_image(&tx, image_id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("删除失败:图片不存在或已删除(影响 {n} 行)"));
    }
    oplog::image_tombstone(&tx, clock, image_id, &item_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
