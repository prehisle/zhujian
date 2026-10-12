//! 图片编排 (item images): attach an image to an item as a numbered 「图N」 attachment.
//! Thin orchestration over repo primitives, mirroring notes.rs (灵感编排) / task.rs (看板编排).
//! The multi-statement ops — allocate the next 编号 from the high-water counter + insert the
//! bytes + emit the op, or mark / restore / destroy + emit — each run in a single transaction
//! so a 编号 is never burned without an image, nor a change made without its op. Listing /
//! fetching are single repo calls and go straight from the command layer.
//!
//! 0041 起删图进回收站(`remove` 只打标记),销毁只在回收站里(`purge` / `purge_removed_in`),
//! 全案 docs/image-trash-plan.md。

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
    let n = repo::insert_item_image(&tx, &id, item_id, seq, data, mime, None).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("图片写入失败,影响 {n} 行"));
    }
    oplog::image_add(&tx, clock, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((id, seq))
}

// ---- 回收站(0041,image-trash-plan §4)------------------------------------------------
//
// 删图 = 打删除标记(行、字节、编号、缩略图全留),在回收站里可还原到原编号;真销毁只在
// 回收站里发生(「彻底删除」一张 / 「清空」),仍发既有的 `image_tombstone`。三个入口都要求
// 宿主**在用**(没进回收站、没进成就册):那两处的条目冻结不可编辑(design-rules),而回收站
// 只列宿主在用的已删图(`repo::removed_image_groups`)—— 列出来的每一张都还原得了、删得掉。

/// 编排前置:图在、宿主在用。返回宿主 id 与「已删没有」。
fn require_live_owner(tx: &Connection, image_id: &str, verb: &str) -> Result<(String, bool), String> {
    let st = repo::image_state(tx, image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{verb}失败:图片不存在或已彻底删除"))?;
    if !st.owner_live {
        return Err(format!("{verb}失败:这张图所在的条目在回收站或成就归档里,先把条目还原"));
    }
    Ok((st.item_id, st.removed))
}

/// Delete one image = move it to the 回收站 (换图 / 移除配图). Its 编号 stays taken (the row
/// stays), so a 正文「见图N」 reads as a hole until it is restored. A missing id / an image
/// already in the trash is an error, not a silent no-op. One transaction: mark, emit.
pub fn remove(conn: &mut Connection, clock: &mut Clock, image_id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (_, removed) = require_live_owner(&tx, image_id, "删除")?;
    if removed {
        return Err("删除失败:这张图已经在回收站里".to_string());
    }
    let n = repo::mark_image_removed(&tx, image_id, &repo::now_iso()).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("删除失败:影响 {n} 行"));
    }
    oplog::image_set_removed(&tx, clock, image_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 从回收站还原一张图,回到原编号(编号从没让出去过)。一事务:清标记、发 op。
pub fn restore(conn: &mut Connection, clock: &mut Clock, image_id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (_, removed) = require_live_owner(&tx, image_id, "还原")?;
    if !removed {
        return Err("还原失败:这张图不在回收站里".to_string());
    }
    let n = repo::unmark_image_removed(&tx, image_id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("还原失败:影响 {n} 行"));
    }
    oplog::image_set_removed(&tx, clock, image_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 回收站里「彻底删除」一张图:删行(字节、缩略图随之而去)+ 发 `image_tombstone`。只收已删的图
/// —— 在用的图要先删(进回收站)才能销毁。编号照旧不复用(counter 不动)。
pub fn purge(conn: &mut Connection, clock: &mut Clock, image_id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (item_id, removed) = require_live_owner(&tx, image_id, "彻底删除")?;
    if !removed {
        return Err("彻底删除失败:只有回收站里的图才能彻底删除".to_string());
    }
    let n = repo::delete_item_image(&tx, image_id).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("彻底删除失败:影响 {n} 行"));
    }
    oplog::image_tombstone(&tx, clock, image_id, &item_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 「清空回收站」里的配图那一半:在**调用方的事务里**销毁范围内全部已删配图(宿主在用、本机
/// 有行;范围谓词与回收站列表同一份),逐张删行 + 发 `image_tombstone`。返回销毁张数。
/// 只动本机有行的:字节还没到的已删图本机看不见,清空也不碰它(规格 §4)。
pub(crate) fn purge_removed_in(
    tx: &Connection,
    clock: &mut Clock,
    scope: repo::TrashScope,
) -> Result<usize, String> {
    let ids = repo::removed_image_ids(tx, scope).map_err(|e| e.to_string())?;
    for (image_id, item_id) in &ids {
        let n = repo::delete_item_image(tx, image_id).map_err(|e| e.to_string())?;
        if n != 1 {
            return Err(format!("清空回收站不一致:配图 {image_id} 实删 {n} 行,已回滚"));
        }
        oplog::image_tombstone(tx, clock, image_id, item_id)?;
    }
    Ok(ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oplog::ops_for;
    use crate::{db, notes, task};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn fresh_db() -> (Connection, Clock) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = crate::test_temp::dir()
            .join(format!("ys-nb-images-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open migrated db");
        let clock = Clock::load(&conn).expect("load clock");
        (conn, clock)
    }

    fn seqs(conn: &Connection, item: &str) -> Vec<i64> {
        repo::list_item_images(conn, item).unwrap().into_iter().map(|i| i.seq).collect()
    }

    fn removed_at(conn: &Connection, img: &str) -> Option<String> {
        conn.query_row("SELECT removed_at FROM item_image WHERE id = ?1", [img], |r| r.get(0))
            .unwrap()
    }

    fn row_count(conn: &Connection, img: &str) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM item_image WHERE id = ?1", [img], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn remove_moves_to_trash_and_restore_returns_the_same_number() {
        let (mut c, mut k) = fresh_db();
        let item = notes::capture(&mut c, &mut k, "三张图").unwrap();
        let ids: Vec<String> = (0..3u8)
            .map(|i| attach(&mut c, &mut k, &item, &[i + 1], "image/png").unwrap().0)
            .collect();
        remove(&mut c, &mut k, &ids[1]).unwrap();
        assert_eq!(seqs(&c, &item), vec![1, 3], "已删的图不进图条(编号洞照留)");
        // 另两处列表(手机时间轴 / 导出 Markdown)同一口径。
        let tl: Vec<i64> = repo::live_timeline_images(&c).unwrap()[&item].iter().map(|i| i.seq).collect();
        assert_eq!(tl, vec![1, 3], "手机时间轴也不列已删的图");
        let ex: Vec<i64> = repo::all_item_images(&c).unwrap()[&item].iter().map(|i| i.seq).collect();
        assert_eq!(ex, vec![1, 3], "导出也不带已删的图");
        assert_eq!(row_count(&c, &ids[1]), 1, "行与字节都还在");
        let at = removed_at(&c, &ids[1]).expect("盖上了删除时刻");
        let ops = ops_for(&c, "image", &ids[1]);
        assert_eq!(ops.last().unwrap().kind, "set_field");
        assert_eq!(ops.last().unwrap().payload, serde_json::json!({"field": "removed_at", "value": at}));
        restore(&mut c, &mut k, &ids[1]).unwrap();
        assert_eq!(seqs(&c, &item), vec![1, 2, 3], "还原回原编号");
        let ops = ops_for(&c, "image", &ids[1]);
        assert_eq!(ops.last().unwrap().payload, serde_json::json!({"field": "removed_at", "value": null}));
    }

    #[test]
    fn each_entry_refuses_the_wrong_state_and_writes_nothing() {
        let (mut c, mut k) = fresh_db();
        let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
        let (img, _) = attach(&mut c, &mut k, &item, &[1], "image/png").unwrap();
        let n0 = ops_for(&c, "image", &img).len();
        assert!(restore(&mut c, &mut k, &img).is_err(), "在用的图不能还原");
        assert!(purge(&mut c, &mut k, &img).is_err(), "在用的图不能彻底删除(销毁只在回收站里)");
        assert_eq!(row_count(&c, &img), 1);
        remove(&mut c, &mut k, &img).unwrap();
        assert!(remove(&mut c, &mut k, &img).is_err(), "已删的再删 = 报错,不静默");
        assert_eq!(ops_for(&c, "image", &img).len(), n0 + 1, "拒掉的入口一条 op 都不发");
        assert!(remove(&mut c, &mut k, "01NOSUCHIMAGE000000000000X").is_err());
        // 存储原语本身也只销毁已删的图(判据写在 DELETE 里)。
        let (live, _) = attach(&mut c, &mut k, &item, &[2], "image/png").unwrap();
        assert_eq!(repo::delete_item_image(&c, &live).unwrap(), 0);
        assert_eq!(row_count(&c, &live), 1);
    }

    #[test]
    fn purge_destroys_the_row_emits_tombstone_and_never_reuses_the_number() {
        let (mut c, mut k) = fresh_db();
        let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
        let (a, _) = attach(&mut c, &mut k, &item, &[1], "image/png").unwrap();
        let (b, _) = attach(&mut c, &mut k, &item, &[2], "image/png").unwrap();
        remove(&mut c, &mut k, &b).unwrap();
        purge(&mut c, &mut k, &b).unwrap();
        assert_eq!(row_count(&c, &b), 0);
        let ops = ops_for(&c, "image", &b);
        assert_eq!(ops.last().unwrap().kind, "image_tombstone");
        assert_eq!(ops.last().unwrap().payload["item_id"], serde_json::json!(item));
        let (_, next) = attach(&mut c, &mut k, &item, &[3], "image/png").unwrap();
        assert_eq!(next, 3, "图2 销毁后编号不复用");
        assert_eq!(seqs(&c, &item), vec![1, 3]);
        assert_eq!(row_count(&c, &a), 1);
    }

    #[test]
    fn frozen_owner_refuses_all_three_entries() {
        // 宿主进了回收站 = 冻结不可编辑:三个入口都拒(回收站也不列它的已删图)。
        let (mut c, mut k) = fresh_db();
        let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
        let (live, _) = attach(&mut c, &mut k, &item, &[1], "image/png").unwrap();
        let (gone, _) = attach(&mut c, &mut k, &item, &[2], "image/png").unwrap();
        remove(&mut c, &mut k, &gone).unwrap();
        notes::archive(&mut c, &mut k, &item).unwrap();
        assert!(remove(&mut c, &mut k, &live).is_err());
        assert!(restore(&mut c, &mut k, &gone).is_err());
        assert!(purge(&mut c, &mut k, &gone).is_err());
        assert!(repo::removed_image_groups(&c, repo::TrashScope::All).unwrap().is_empty());
        assert_eq!(repo::removed_image_count(&c, repo::TrashScope::All).unwrap(), 0);
        notes::restore(&mut c, &mut k, &item).unwrap();
        assert_eq!(
            repo::removed_image_count(&c, repo::TrashScope::All).unwrap(),
            1,
            "宿主回来,它的已删图回到回收站"
        );
        restore(&mut c, &mut k, &gone).unwrap();
    }

    #[test]
    fn trash_lists_by_owner_and_each_clear_only_touches_its_own_page() {
        let (mut c, mut k) = fresh_db();
        let idea = notes::capture(&mut c, &mut k, "灵感宿主\n第二行").unwrap();
        let todo = task::create(&mut c, &mut k, "任务宿主", None, None, None).unwrap();
        let (idea_keep, _) = attach(&mut c, &mut k, &idea, &[1], "image/png").unwrap();
        let (idea_gone, _) = attach(&mut c, &mut k, &idea, &[2], "image/png").unwrap();
        let (todo_gone, _) = attach(&mut c, &mut k, &todo, &[3], "image/png").unwrap();
        remove(&mut c, &mut k, &idea_gone).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5)); // 删除时刻可分先后
        remove(&mut c, &mut k, &todo_gone).unwrap();
        let ideas = repo::removed_image_groups(&c, repo::TrashScope::Ideas).unwrap();
        assert_eq!(ideas.len(), 1);
        assert_eq!(ideas[0].item_id, idea);
        assert_eq!(ideas[0].content, "灵感宿主\n第二行");
        assert_eq!(ideas[0].images.iter().map(|i| i.seq).collect::<Vec<_>>(), vec![2]);
        let tasks = repo::removed_image_groups(&c, repo::TrashScope::Tasks).unwrap();
        assert_eq!(tasks.iter().map(|g| g.item_id.as_str()).collect::<Vec<_>>(), vec![todo.as_str()]);
        let all = repo::removed_image_groups(&c, repo::TrashScope::All).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].item_id, todo, "组按最新删除时刻倒序(任务那张后删)");

        // 任务页清空:只销毁任务那张;灵感页的已删图与在用图都不碰。
        task::purge_all(&mut c, &mut k).unwrap();
        assert_eq!(row_count(&c, &todo_gone), 0);
        assert_eq!(ops_for(&c, "image", &todo_gone).last().unwrap().kind, "image_tombstone");
        assert_eq!(row_count(&c, &idea_gone), 1);
        // 灵感页清空:销毁灵感那张,在用的图不碰。
        notes::purge_all_archived(&mut c, &mut k).unwrap();
        assert_eq!(row_count(&c, &idea_gone), 0);
        assert_eq!(row_count(&c, &idea_keep), 1);
        // 统一回收站(手机)清空:全 stage。
        let (g1, _) = attach(&mut c, &mut k, &idea, &[4], "image/png").unwrap();
        let (g2, _) = attach(&mut c, &mut k, &todo, &[5], "image/png").unwrap();
        remove(&mut c, &mut k, &g1).unwrap();
        remove(&mut c, &mut k, &g2).unwrap();
        notes::purge_all_trash(&mut c, &mut k).unwrap();
        assert_eq!((row_count(&c, &g1), row_count(&c, &g2)), (0, 0));
        assert_eq!(row_count(&c, &idea_keep), 1);
    }

    #[test]
    fn trigger_lets_removed_at_change_but_nothing_else() {
        // 0041 触发器:removed_at 随时可改;seq 只许在回放事务内改;其余列永不可改。
        let (mut c, mut k) = fresh_db();
        let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
        let (img, _) = attach(&mut c, &mut k, &item, &[1], "image/png").unwrap();
        c.execute("UPDATE item_image SET removed_at = '2026-10-12T08:00:00Z' WHERE id = ?1", [&img])
            .expect("removed_at 可改");
        assert!(c.execute("UPDATE item_image SET seq = 9 WHERE id = ?1", [&img]).is_err(), "回放外改 seq = 拒");
        assert!(c.execute("UPDATE item_image SET mime = 'image/gif' WHERE id = ?1", [&img]).is_err());
        assert!(
            c.execute("UPDATE item_image SET removed_at = NULL, data = x'02' WHERE id = ?1", [&img]).is_err(),
            "带着 removed_at 一起改字节也拒"
        );
    }
}
