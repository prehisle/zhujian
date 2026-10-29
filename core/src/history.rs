//! 条目编辑历史的取数口(longform-plan §4「历史取数要换接口」,1b)。
//!
//! 两条读路,**都不整批返回正文**(旧的 `list_note_history` 一次取全部正文,200 版 ×
//! 200 KiB ≈ 39 MiB 原始正文过 IPC 再全建 DOM):
//! - [`catalog`]:目录分页,只给 `{revision_id, archived_at, chars}`,按 `revision_id`
//!   倒序 keyset 游标(`(item_id, revision_id)` 索引早就在);
//! - [`texts`]:按两个版本选择取那两份全文与解析后的版本身份。
//!
//! ⭐ **快照一致只靠「单条 SELECT」**:SQLite 一条语句在一个读快照里执行。⚠「同一个读
//! 闭包」≠「同一个快照」—— 手机协调器在手动同步中每条读命令另开只读连接
//! (`mobile/src/coord.rs` 的 `ManualSyncing` 分支),所以「当前正文 + 上一版」、「目录 +
//! 总数 + 条目还在不在」都必须在同一条语句里取,⛔ 别拆成两次查询再拼。
//!
//! 版本身份只有 `revision_id`(本地库内单调的代理键,各端各长各的、不同步),且查询一律
//! 同时约束 `item_id`;⛔ 不拿数组下标或时间戳当身份(同一毫秒可能有多版,翻页期间也会新增)。
//! 条目已被彻底删除 = 明确报错,⛔ 不自动换成别的版本。

use rusqlite::{Connection, OptionalExtension};

/// 一页目录的条数。固定一档,不开调用方参数(规格的「硬上限 100」由它满足)。
pub const PAGE_ROWS: usize = 50;

/// 目录里的一版:只有元数据,⛔ 永不带正文。两壳命令直接返回它(契约同源,同 `comments::Comment`)。
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct RevisionMeta {
    pub revision_id: i64,
    /// 这一版停止为当前版的时刻。
    pub archived_at: String,
    /// 码点数(SQLite `length()` 对 TEXT 数的是字符,不是 UTF-16 码元)。只作显示。
    pub chars: i64,
}

/// 一页目录。`total` 是该条目的历史总版数(与本页同一快照);`has_more` 由多读一行得出。
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct RevisionCatalog {
    pub entries: Vec<RevisionMeta>,
    pub total: i64,
    pub has_more: bool,
}

// 从 items 出发 LEFT JOIN:没有行 ⇒ 条目不在;一行全 NULL ⇒ 条目在、本页没有版本。
// 总数、本页、存在性三件事同一条语句 ⇒ 同一快照。多读一行只用来得出 has_more。
const CATALOG_SQL: &str = "SELECT r.revision_id, r.archived_at, length(r.content), \
        (SELECT COUNT(*) FROM item_revisions WHERE item_id = ?1) \
     FROM items i \
     LEFT JOIN item_revisions r ON r.item_id = i.id AND (?2 IS NULL OR r.revision_id < ?2) \
     WHERE i.id = ?1 \
     ORDER BY r.revision_id DESC LIMIT ?3";

/// 一页目录,新的在前。`before` = 上一页最后一条的 `revision_id`,None = 第一页。
/// 条目不存在(含已被彻底删除)= Err。
pub fn catalog(conn: &Connection, item_id: &str, before: Option<i64>) -> Result<RevisionCatalog, String> {
    let mut stmt = conn.prepare(CATALOG_SQL).map_err(|e| e.to_string())?;
    let mut q = stmt
        .query(rusqlite::params![item_id, before, PAGE_ROWS as i64 + 1])
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::with_capacity(PAGE_ROWS);
    let mut total = None;
    let mut has_more = false;
    while let Some(r) = q.next().map_err(|e| e.to_string())? {
        total = Some(r.get::<_, i64>(3).map_err(|e| e.to_string())?);
        let Some(revision_id) = r.get::<_, Option<i64>>(0).map_err(|e| e.to_string())? else {
            continue; // 条目在、这一页没有版本(LEFT JOIN 的那一行全 NULL)
        };
        if entries.len() == PAGE_ROWS {
            has_more = true;
            break;
        }
        entries.push(RevisionMeta {
            revision_id,
            archived_at: r.get(1).map_err(|e| e.to_string())?,
            chars: r.get(2).map_err(|e| e.to_string())?,
        });
    }
    let total = total.ok_or_else(|| format!("条目不存在:{item_id}"))?;
    Ok(RevisionCatalog { entries, total, has_more })
}

/// 版本选择。线上形:`"current"` / `"latest"` / `{"rev": 123}`;认不出 = 反序列化失败。
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pick {
    /// 条目现在的正文。
    Current,
    /// 最新一版历史(= 「上一版」)。与 `Current` 同取时在同一快照里解析 ——
    /// ⛔ 别让前端先取目录、再拿目录第一条的 id 来配一份更晚的当前正文。
    Latest,
    /// 指定的一版;必须属于这一条目。
    Rev(i64),
}

/// 取出的一版。`revision_id` / `archived_at` 为 None = 当前正文。
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct VersionText {
    pub revision_id: Option<i64>,
    pub archived_at: Option<String>,
    pub content: String,
}

/// `texts` 的结果:按调用方给的顺序。
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct VersionPair {
    pub a: VersionText,
    pub b: VersionText,
}

/// 取两版全文。条目不存在、选中的版本不存在或不属于该条目、要「上一版」却还没有历史
/// —— 一律 Err,⛔ 不换成别的版本。
pub fn texts(conn: &Connection, item_id: &str, a: Pick, b: Pick) -> Result<VersionPair, String> {
    // 每个槽位给 SQL 两个参数:种类字面量 + 指定的 id。`latest` 在语句内解析成 MAX,
    // 当前正文只在有槽位要它时才取(两版都是历史时不白搬一份 200 KiB)。
    fn bind(p: Pick) -> (&'static str, Option<i64>) {
        match p {
            Pick::Current => ("current", None),
            Pick::Latest => ("latest", None),
            Pick::Rev(id) => ("rev", Some(id)),
        }
    }
    let (ka, ia) = bind(a);
    let (kb, ib) = bind(b);
    let row = conn
        .query_row(
            "SELECT CASE WHEN ?2 = 'current' OR ?4 = 'current' THEN i.content END, \
                    ra.revision_id, ra.archived_at, ra.content, \
                    rb.revision_id, rb.archived_at, rb.content \
             FROM items i \
             LEFT JOIN item_revisions ra ON ra.item_id = i.id AND ra.revision_id = \
                 CASE ?2 WHEN 'latest' THEN (SELECT MAX(revision_id) FROM item_revisions WHERE item_id = ?1) \
                         WHEN 'rev' THEN ?3 END \
             LEFT JOIN item_revisions rb ON rb.item_id = i.id AND rb.revision_id = \
                 CASE ?4 WHEN 'latest' THEN (SELECT MAX(revision_id) FROM item_revisions WHERE item_id = ?1) \
                         WHEN 'rev' THEN ?5 END \
             WHERE i.id = ?1",
            rusqlite::params![item_id, ka, ia, kb, ib],
            |r| {
                let cur: Option<String> = r.get(0)?;
                let slot = |base: usize| -> rusqlite::Result<Option<VersionText>> {
                    Ok(match r.get::<_, Option<i64>>(base)? {
                        Some(id) => Some(VersionText {
                            revision_id: Some(id),
                            archived_at: Some(r.get(base + 1)?),
                            content: r.get(base + 2)?,
                        }),
                        None => None,
                    })
                };
                Ok((cur, slot(1)?, slot(4)?))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("条目不存在:{item_id}"))?;
    let (cur, ra, rb) = row;
    let resolve = |p: Pick, got: Option<VersionText>| -> Result<VersionText, String> {
        match p {
            Pick::Current => Ok(VersionText {
                revision_id: None,
                archived_at: None,
                content: cur.clone().expect("有槽位要 current 时语句必取 i.content(NOT NULL 列)"),
            }),
            Pick::Latest => got.ok_or_else(|| format!("这一条还没有历史版本:{item_id}")),
            Pick::Rev(id) => got.ok_or_else(|| format!("历史版本不存在:{item_id} #{id}")),
        }
    };
    Ok(VersionPair { a: resolve(a, ra)?, b: resolve(b, rb)? })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::Clock;
    use crate::{db, notes};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn fresh_db() -> (Connection, Clock) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = crate::test_temp::dir()
            .join(format!("ys-nb-history-test-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open migrated db");
        let clock = Clock::load(&conn).expect("load clock");
        (conn, clock)
    }

    /// 建一条并改 `edits` 次:v0 → v1 → … ⇒ 历史里依次存 v0..v(edits-1),当前 = v(edits)。
    fn note_with_edits(conn: &mut Connection, clk: &mut Clock, tag: &str, edits: usize) -> String {
        let id = notes::capture(conn, clk, &format!("{tag} v0")).unwrap();
        for k in 1..=edits {
            notes::edit(conn, clk, &id, &format!("{tag} v{k}")).unwrap();
        }
        id
    }

    /// 翻完全部页。⚠ 页数有上界:游标失效时 has_more 恒真,不设上界这只辅助会**挂死**而不是红
    /// (变异①真撞过)。
    fn all_entries(conn: &Connection, id: &str) -> Vec<RevisionMeta> {
        let mut out = Vec::new();
        let mut before = None;
        let max_pages = catalog(conn, id, None).unwrap().total as usize / PAGE_ROWS + 1;
        for _ in 0..max_pages {
            let page = catalog(conn, id, before).unwrap();
            assert!(page.entries.len() <= PAGE_ROWS);
            out.extend(page.entries.iter().cloned());
            if !page.has_more {
                return out;
            }
            before = Some(page.entries.last().unwrap().revision_id);
        }
        panic!("翻了 {max_pages} 页还有下一页:游标没往前走({} 条已取)", out.len());
    }

    #[test]
    fn catalog_pages_newest_first_without_gaps_or_repeats() {
        let (mut conn, mut clk) = fresh_db();
        let id = note_with_edits(&mut conn, &mut clk, "甲", PAGE_ROWS * 2 + 3);
        let _other = note_with_edits(&mut conn, &mut clk, "乙", 5); // 别的条目的历史不许混进来

        let first = catalog(&conn, &id, None).unwrap();
        assert_eq!(first.entries.len(), PAGE_ROWS, "第一页恰满一页");
        assert!(first.has_more);
        assert_eq!(first.total, (PAGE_ROWS * 2 + 3) as i64);

        let all = all_entries(&conn, &id);
        assert_eq!(all.len(), PAGE_ROWS * 2 + 3, "翻完恰好全部,不重不漏");
        assert!(all.windows(2).all(|w| w[0].revision_id > w[1].revision_id), "严格新的在前");
        // 最新一版历史 = 最后一次被替换掉的那一版;码点数对得上
        let newest = texts(&conn, &id, Pick::Rev(all[0].revision_id), Pick::Current).unwrap();
        assert_eq!(newest.a.content, format!("甲 v{}", PAGE_ROWS * 2 + 2));
        assert_eq!(all[0].chars, newest.a.content.chars().count() as i64);
    }

    #[test]
    fn catalog_exact_page_has_no_phantom_more() {
        let (mut conn, mut clk) = fresh_db();
        let id = note_with_edits(&mut conn, &mut clk, "满", PAGE_ROWS);
        let page = catalog(&conn, &id, None).unwrap();
        assert_eq!(page.entries.len(), PAGE_ROWS);
        assert!(!page.has_more, "恰好一页 ⇒ 没有下一页");
    }

    #[test]
    fn catalog_empty_vs_missing() {
        let (mut conn, mut clk) = fresh_db();
        let id = notes::capture(&mut conn, &mut clk, "没改过").unwrap();
        let page = catalog(&conn, &id, None).unwrap();
        assert_eq!(page, RevisionCatalog { entries: vec![], total: 0, has_more: false });
        assert!(catalog(&conn, "01NOPE0000000000000000000", None).is_err(), "条目不在 = 报错,不是空目录");
    }

    #[test]
    fn catalog_new_edits_during_paging_do_not_shift_later_pages() {
        let (mut conn, mut clk) = fresh_db();
        let id = note_with_edits(&mut conn, &mut clk, "翻", PAGE_ROWS + 10);
        let first = catalog(&conn, &id, None).unwrap();
        // 翻页之间又改了三次:新版只会出现在第一页之前,游标之后的那段不动
        for k in 0..3 {
            notes::edit(&mut conn, &mut clk, &id, &format!("翻 插入 {k}")).unwrap();
        }
        let second = catalog(&conn, &id, Some(first.entries.last().unwrap().revision_id)).unwrap();
        assert_eq!(second.entries.len(), 10);
        assert!(!second.has_more);
        let mut seen: Vec<i64> = first.entries.iter().chain(&second.entries).map(|e| e.revision_id).collect();
        let n = seen.len();
        seen.dedup();
        assert_eq!(seen.len(), n, "两页没有重复");
        assert_eq!(second.total, (PAGE_ROWS + 13) as i64, "总数与本页同一快照,含新增");
    }

    #[test]
    fn texts_current_and_latest_resolve_together() {
        let (mut conn, mut clk) = fresh_db();
        let id = note_with_edits(&mut conn, &mut clk, "对", 2);
        let p = texts(&conn, &id, Pick::Latest, Pick::Current).unwrap();
        assert_eq!(p.a.content, "对 v1");
        assert!(p.a.revision_id.is_some() && p.a.archived_at.is_some());
        assert_eq!(p.b, VersionText { revision_id: None, archived_at: None, content: "对 v2".into() });
        // 解析出的身份 = 目录第一条
        assert_eq!(p.a.revision_id, Some(catalog(&conn, &id, None).unwrap().entries[0].revision_id));
    }

    #[test]
    fn texts_exact_old_versions_in_caller_order() {
        let (mut conn, mut clk) = fresh_db();
        let id = note_with_edits(&mut conn, &mut clk, "选", 4);
        let all = all_entries(&conn, &id); // [v3, v2, v1, v0]
        let p = texts(&conn, &id, Pick::Rev(all[3].revision_id), Pick::Rev(all[1].revision_id)).unwrap();
        assert_eq!((p.a.content.as_str(), p.b.content.as_str()), ("选 v0", "选 v2"));
        assert_eq!(p.a.revision_id, Some(all[3].revision_id));
        assert_eq!(p.a.archived_at.as_deref(), Some(all[3].archived_at.as_str()));
    }

    #[test]
    fn texts_refuses_foreign_missing_and_absent_versions() {
        let (mut conn, mut clk) = fresh_db();
        let id = note_with_edits(&mut conn, &mut clk, "本", 1);
        let other = note_with_edits(&mut conn, &mut clk, "别", 1);
        let foreign = catalog(&conn, &other, None).unwrap().entries[0].revision_id;
        assert!(texts(&conn, &id, Pick::Rev(foreign), Pick::Current).is_err(), "别的条目的版本 = 报错");
        assert!(texts(&conn, &id, Pick::Current, Pick::Rev(i64::MAX)).is_err(), "不存在的版本 = 报错");
        let fresh = notes::capture(&mut conn, &mut clk, "新").unwrap();
        assert!(texts(&conn, &fresh, Pick::Latest, Pick::Current).is_err(), "还没有历史时没有「上一版」");
        assert!(texts(&conn, "01NOPE0000000000000000000", Pick::Current, Pick::Current).is_err());
    }

    #[test]
    fn texts_after_purge_is_an_error_not_a_substitute() {
        let (mut conn, mut clk) = fresh_db();
        let id = note_with_edits(&mut conn, &mut clk, "删", 2);
        let rev = catalog(&conn, &id, None).unwrap().entries[0].revision_id;
        notes::archive(&mut conn, &mut clk, &id).unwrap();
        // 回收站里的条目历史照取
        assert_eq!(texts(&conn, &id, Pick::Rev(rev), Pick::Current).unwrap().a.content, "删 v1");
        notes::purge(&mut conn, &mut clk, &id).unwrap();
        assert!(catalog(&conn, &id, None).is_err());
        assert!(texts(&conn, &id, Pick::Rev(rev), Pick::Current).is_err());
    }

    #[test]
    fn texts_two_history_picks() {
        let (mut conn, mut clk) = fresh_db();
        let id = note_with_edits(&mut conn, &mut clk, "省", 3);
        let p = texts(&conn, &id, Pick::Latest, Pick::Latest).unwrap();
        assert_eq!(p.a, p.b);
        assert_eq!(p.a.content, "省 v2");
    }

    #[test]
    fn pick_wire_shape() {
        let p: Pick = serde_json::from_str("\"current\"").unwrap();
        assert_eq!(p, Pick::Current);
        let p: Pick = serde_json::from_str("\"latest\"").unwrap();
        assert_eq!(p, Pick::Latest);
        let p: Pick = serde_json::from_str("{\"rev\":7}").unwrap();
        assert_eq!(p, Pick::Rev(7));
        assert!(serde_json::from_str::<Pick>("\"previous\"").is_err());
        assert!(serde_json::from_str::<Pick>("0").is_err(), "⛔ 不接受数组下标");
    }

    /// 目录走索引倒序、只碰本页那几行 —— 否则 `length(content)` 会对整条历史逐行读正文。
    #[test]
    fn catalog_plan_uses_the_item_revision_index() {
        let (conn, _) = fresh_db();
        let plan: Vec<String> = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {CATALOG_SQL}"))
            .unwrap()
            .query_map(rusqlite::params!["x", None::<i64>, 51], |r| r.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let joined = plan.join(" | ");
        assert!(joined.contains("idx_item_revisions_item_id"), "{joined}");
        assert!(!joined.contains("TEMP B-TREE"), "排序不该落临时 B 树:{joined}");
    }
}
