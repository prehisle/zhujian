//! 跨空间移动条目(cross-space-move-plan,codex 设计审三轮已折入)。
//!
//! **移动 = 源空间该条目死亡 + 目标空间带当前态新生**(§1):空间=账户=独立库,
//! oplog/HLC/身份互不相通,没有零副本捷径。三个原语各自独立拿放**一个**空间的
//! 连接与时钟,绝不同时持两把锁(§2.2/三轮 #6);壳层在全局 lifecycle 互斥内按
//! `export → import → finalize_source` 顺序编排,先建后删——中途崩溃 = 两边都有
//! (重复优于丢失),绝不静默丢。
//!
//! 铁三条:
//! - **新 ULID,绝不复用**(§2.1):条目与配图都换新 id(过目标表 + 目标 oplog 历史
//!   按 entity 查重)——复用会被源空间墓碑永久压死(tombstone sticky)。
//! - **源删除前重验规范指纹**(§2.2 H1):导出与删除之间源被并发改成 S1 → 拒删,
//!   返回 Kept(丢的是 S1,「重复优于丢失」兜不住静默覆盖)。
//! - **两道配图预检**(§2.3):活但未物化的图(image_add 到、字节没到)拒导出——
//!   漏搬 = 源 tombstone 后引擎停拉,逻辑上活着的图永久丢;正文悬空「见图N」拒
//!   导出——「编号永不复用」保护的引用在目标端会错指。

use std::collections::{BTreeMap, HashSet};

use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::clock::Clock;
use crate::{oplog, repo, replay};

/// 六个活跃 stage(v1 只移活跃条目:回收站/成就归档是史实轴,不给入口,§4)。
const ACTIVE_STAGES: [&str; 6] = ["inbox", "filed", "todo", "doing", "confirming", "done"];

/// 一张随迁配图(字节全量在内存里过手——本机两库间没有「旁路」概念,§2.3)。
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct ImagePack {
    pub(crate) id: String,
    pub(crate) seq: i64,
    pub(crate) mime: String,
    pub(crate) bytes: Vec<u8>,
    pub(crate) sha256: String,
}

/// 规范指纹(§2.2 M1):排序后精确比对,**不是**只比 updated_at(图片/标签变更
/// 未必更新它)。counter 区分「无行」与具体值;position 不迁移不比。
#[derive(PartialEq, Debug)]
pub(crate) struct Fingerprint {
    item: (String, String, Option<String>, Option<i64>, String, Option<String>, Option<String>),
    /// 排序后的 (source_topic_id, exact_title)——不能只比去重后的名字。
    topics: Vec<(String, String)>,
    /// 排序后的 (id, seq, mime, byte_len, sha256)。
    images: Vec<(String, i64, String, i64, String)>,
    counter: Option<i64>,
}

/// 导出的移动包 = 目标导入的原料 + 源删除的收据(指纹)。delete-only receipt(§2.2
/// M5):重试删源必须拿**同一个包**再喂 finalize_source,不重跑导出、不按 id 盲删。
#[derive(Debug)]
pub struct MovePackage {
    pub source_id: String,
    pub(crate) content: String,
    pub(crate) stage: String,
    pub(crate) created_at: String,
    pub(crate) due_on: Option<String>,
    pub(crate) priority: Option<i64>,
    pub(crate) topics: Vec<(String, String)>,
    pub(crate) images: Vec<ImagePack>,
    pub(crate) fingerprint: Fingerprint,
}

/// 导出裁决(§2.3 两道预检是**业务结果**不是错误——UI 要分道显示)。
#[derive(Debug)]
pub enum ExportOutcome {
    Ready(Box<MovePackage>),
    /// 活但未物化的图(op 到、字节没到):等字节到齐再移(§2.3①)。
    ImagesPending { count: i64 },
    /// 正文引用了不在现存图上的「见图N」(§2.3②):响亮拒,极罕见。
    DanglingRefs { seqs: Vec<i64> },
}

/// 源删除裁决(§2.8/§3)。
pub enum FinalizeOutcome {
    /// 源已删、一条 tombstone 已发。
    Deleted,
    /// 源行已消失且日志里有它的 tombstone(远端并发删除已同步到,或本原语的重试):
    /// 条目在目标已新生、源也确实没了 = 语义上移完;**绝不再发第二条 tombstone**
    /// (三轮 #5)。
    AlreadyGone,
    /// 源被并发改动(指纹不符)或新冒出未物化的图:拒删,源保留——上层如实报
    /// 「已复制到目标,原条目保留」(CopiedButSourceKept)。
    Kept { reason: String },
}

/// 移动的结构化结果(§4/三轮 #4:UI 按 outcome 分道——只有 Moved 做卡片离场;
/// CopiedButSource* 保留源卡并如实展示;两预检拒各有话术)。**两壳共享单一真相源**
/// (codex 安卓实现审 #5:第二个 Rust 壳消费同一套五分道,镜像即漂移;桌面壳
/// re-export 本枚举,前端 TS 各自镜像 JSON 形、由 serde 契约测试钉死字段名)。
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum MoveResult {
    /// 移完(source_already_gone = 删源时发现源已被远端并发删除:条目在目标已新生、
    /// 源也确实没了,语义上就是移完,三轮 #5)。
    Moved { new_id: String, source_already_gone: bool },
    /// 目标已建、源删除被拒(并发改动/新冒缺字节图):两边都有,重复优于丢失。
    CopiedButSourceKept { new_id: String, reason: String },
    /// 目标已建、源删除**出错**(DB 错误等,源状态未知——可能删了也可能没删):
    /// 绝不谎报 kept,也绝不丢 new_id 让用户重跑整个移动(codex 实现审 #1)。
    CopiedButSourceUnconfirmed { new_id: String, error: String },
    /// 源有活但未物化的图(op 到、字节没到),等字节到齐再移(§2.3①)。
    ImagesPending { count: i64 },
    /// 正文引用了已删配图号(§2.3②),响亮拒。
    DanglingRefs { seqs: Vec<i64> },
}

impl MoveResult {
    /// 目标已建成(new_id 在手)后,按 finalize_source 裁决收口成结构化结果。
    /// **目标 commit 之后不许再冒裸 Err**(codex 实现审 #1):finalize 出错时目标条目
    /// 已真实存在,裸 Err 丢掉 new_id 会诱导用户重跑整个移动、制造第二份;源此刻
    /// 删没删未知,如实报 unconfirmed,不谎报 kept。两壳共用这条映射,分道语义不漂移。
    pub fn from_finalize(new_id: String, fin: Result<FinalizeOutcome, String>) -> MoveResult {
        match fin {
            Ok(FinalizeOutcome::Deleted) => MoveResult::Moved { new_id, source_already_gone: false },
            Ok(FinalizeOutcome::AlreadyGone) => {
                MoveResult::Moved { new_id, source_already_gone: true }
            }
            Ok(FinalizeOutcome::Kept { reason }) => {
                MoveResult::CopiedButSourceKept { new_id, reason }
            }
            Err(error) => MoveResult::CopiedButSourceUnconfirmed { new_id, error },
        }
    }
}

/// 条目现存配图字节总和(廉价 SUM,不读 BLOB)。手机壳在 export 前先查它,超出
/// 平台预算就响亮拒——export 会把整组字节读进内存、单条目图字节无小上限,不设界
/// 手机 OOM(codex 安卓实现审 #4;预算数值是**手机政策**,留在壳层,桌面不查)。
pub fn item_image_bytes(conn: &Connection, item_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(SUM(length(data)), 0) FROM item_image WHERE item_id = ?1",
        [item_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

// ---- 原语一:导出(源库,只读) ------------------------------------------------------

/// 导出当前态包 + 两道预检 + 算规范指纹。单事务读取保证自洽快照。
pub fn export(conn: &mut Connection, item_id: &str) -> Result<ExportOutcome, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let row: Option<(String, String, String, Option<String>, Option<i64>, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT content, stage, created_at, due_on, priority, archived_at, sealed_at \
             FROM items WHERE id = ?1",
            [item_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (content, stage, created_at, due_on, priority, archived_at, sealed_at) =
        row.ok_or_else(|| "条目不存在".to_string())?;
    if archived_at.is_some() || sealed_at.is_some() {
        return Err("回收站/成就归档中的条目不能移动(史实轴,先还原)".to_string());
    }
    if !ACTIVE_STAGES.contains(&stage.as_str()) {
        return Err(format!("条目 stage 异常({stage}),拒绝移动"));
    }

    // 预检①(§2.3①):活但未物化的图——判据复用 engine 缺字节清单的同一份 SQL
    // 按 item 过滤(不读引擎内存集合)。
    let pending = crate::sync::engine::missing_blob_count_for_item(&tx, item_id)?;
    if pending > 0 {
        return Ok(ExportOutcome::ImagesPending { count: pending });
    }

    let images = read_images(&tx, item_id)?;

    // 预检②(§2.3②):正文引用的 seq 集合 ⊆ 已物化活图的 seq 集合(解析语义与
    // 回放改写同一份,replay::referenced_image_seqs)。
    let have: HashSet<i64> = images.iter().map(|i| i.seq).collect();
    let mut dangling: Vec<i64> = replay::referenced_image_seqs(&content)
        .into_iter()
        .filter(|s| !have.contains(s))
        .collect();
    if !dangling.is_empty() {
        dangling.sort_unstable();
        return Ok(ExportOutcome::DanglingRefs { seqs: dangling });
    }

    let topics = read_topics(&tx, item_id)?;
    let counter = read_counter(&tx, item_id)?;
    let fingerprint = Fingerprint {
        item: (
            content.clone(),
            stage.clone(),
            due_on.clone(),
            priority,
            created_at.clone(),
            archived_at,
            sealed_at,
        ),
        topics: topics.clone(),
        images: images
            .iter()
            .map(|i| (i.id.clone(), i.seq, i.mime.clone(), i.bytes.len() as i64, i.sha256.clone()))
            .collect(),
        counter,
    };
    // 只读事务,commit 是 no-op;显式收掉别让它一直开着。
    tx.commit().map_err(|e| e.to_string())?;

    Ok(ExportOutcome::Ready(Box::new(MovePackage {
        source_id: item_id.to_string(),
        content,
        stage,
        created_at,
        due_on,
        priority,
        topics,
        images,
        fingerprint,
    })))
}

// ---- 原语二:目标库导入(单事务,失败整体回滚) ---------------------------------------

/// 目标空间带当前态新生。返回新条目 id。因果序(§2.6/三轮 #2):`topic_create` 与
/// `item_create` 都先于 `link_add`;image_add 在 item_create 之后。counter 语义
/// (三轮 #3):目标 counter = 本次保留 seq 的最大值,零图不落行,绝不带源 counter。
pub fn import(conn: &mut Connection, clock: &mut Clock, pkg: &MovePackage) -> Result<String, String> {
    repo::ensure_content_fits(&pkg.content)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 新 item ULID:查目标表 + 目标 oplog 历史(entity='item',§2.1 M4——PK 抓不到
    // 已 tombstone、行已消失的旧 id;「移出去再移回来」全靠这道防墓碑压死)。
    let new_id = fresh_id(&tx, "items", "item")?;
    let n = repo::insert_moved_item(
        &tx,
        &new_id,
        &pkg.content,
        &pkg.stage,
        &pkg.created_at,
        pkg.due_on.as_deref(),
        pkg.priority,
    )
    .map_err(|e| format!("目标空间落行失败:{e}"))?;
    if n != 1 {
        return Err(format!("目标空间落行失败(影响 {n} 行)"));
    }
    // item_create 立即发(因果前驱,payload 含最终 position 出生快照)。
    oplog::item_create(&tx, clock, &new_id)?;

    // 标签按名归并(§2.5):源名先去重(BTreeMap 顺带给出确定性遍历序);目标同名
    // 取最小 ULID;缺则新建(不带源颜色——颜色是目标空间自己的元数据)。
    let mut unique_titles: BTreeMap<String, ()> = BTreeMap::new();
    for (_, title) in &pkg.topics {
        unique_titles.insert(title.clone(), ());
    }
    for title in unique_titles.keys() {
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM topics WHERE title = ?1 ORDER BY id LIMIT 1",
                [title],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let topic_id = match existing {
            Some(id) => id,
            None => {
                let minted = repo::insert_topic(&tx, title).map_err(|e| e.to_string())?;
                oplog::topic_create(&tx, clock, &minted)?; // 父 create 先于 link(三轮 #2)
                minted
            }
        };
        repo::link_item_topic(&tx, &new_id, &topic_id).map_err(|e| e.to_string())?;
        oplog::link_add(&tx, clock, &new_id, &topic_id)?;
    }

    // 配图:新 ULID 保原 seq(单端发射无撞号,reconcile 天然兼容);字节直插;
    // counter 显式落水位 = 保留 seq 的最大值(零图不落行)。行先建齐、counter 跟上、
    // 再逐张发 image_add(op 从行上读 seq,§2.3)。
    // 排序取引用,**不 clone 整组字节**(codex 安卓实现审 #4:pkg.images.clone()
    // 会把 BLOB 再复制一份、单条目图字节无小上限,手机直接 OOM;只需有序遍历,
    // 引用足矣)。
    let mut images: Vec<&ImagePack> = pkg.images.iter().collect();
    images.sort_by_key(|i| i.seq);
    let mut new_image_ids = Vec::with_capacity(images.len());
    for img in &images {
        let new_img = fresh_id(&tx, "item_image", "image")?;
        let n = repo::insert_item_image(&tx, &new_img, &new_id, img.seq, &img.bytes, &img.mime)
            .map_err(|e| format!("目标空间图片落行失败(图{}):{e}", img.seq))?;
        if n != 1 {
            return Err(format!("目标空间图片落行失败(图{},影响 {n} 行)", img.seq));
        }
        new_image_ids.push(new_img);
    }
    if let Some(max_seq) = images.last().map(|i| i.seq) {
        tx.execute(
            "INSERT INTO item_image_counter (item_id, last_seq) VALUES (?1, ?2)",
            (&new_id, max_seq),
        )
        .map_err(|e| format!("目标空间「图N」水位落行失败:{e}"))?;
    }
    for new_img in &new_image_ids {
        oplog::image_add(&tx, clock, new_img)?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_id)
}

// ---- 原语三:源库专用删除事务(§2.8,H3) --------------------------------------------

/// 重验规范指纹未变 + 活图仍全物化 → 同事务临时 `archived_at` 满足删除守护 → DELETE
/// (FK CASCADE 清 revisions/link/image)→ **一条** item tombstone → commit。临时
/// archived_at 不发 set_field(事务内态,外界不可见);oplog 增量恰为 1(有测)。
/// 不借 `sync_replay_active`(那是远端回放/boot 专用豁免)。
pub fn finalize_source(
    conn: &mut Connection,
    clock: &mut Clock,
    pkg: &MovePackage,
) -> Result<FinalizeOutcome, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = pkg.source_id.as_str();

    let exists: i64 = tx
        .query_row("SELECT COUNT(*) FROM items WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        // 行没了:日志里有 tombstone(远端并发删除已同步到 / 本原语重试)= 移动语义
        // 上已完成;没有 tombstone 却没行 = 数据异常,响亮。
        let tombstoned: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM oplog WHERE entity = 'item' AND entity_id = ?1 AND kind = 'tombstone'",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        return if tombstoned > 0 {
            Ok(FinalizeOutcome::AlreadyGone)
        } else {
            Err(format!("源条目 {id} 已消失但日志里没有删除记录(数据异常)"))
        };
    }

    // 活图仍全物化(§2.3①:目标 commit 后源端可能新到了 image_add 而字节未到)。
    let pending = crate::sync::engine::missing_blob_count_for_item(&tx, id)?;
    if pending > 0 {
        return Ok(FinalizeOutcome::Kept {
            reason: format!("源条目有 {pending} 张配图字节尚未到齐(稍后重试删除)"),
        });
    }

    // 规范指纹重验(H1):任一变化拒删——按 id 盲删会把并发改出的 S1 永久丢掉。
    let now = read_fingerprint(&tx, id)?;
    if now != pkg.fingerprint {
        return Ok(FinalizeOutcome::Kept {
            reason: "源条目在移动期间被改动(内容/标签/配图/状态有变),已保留".to_string(),
        });
    }

    // 同事务临时 archived_at 满足删除守护(0022:活跃 filed/任务态禁直接 DELETE);
    // 只 UPDATE archived_at 不触发编辑历史归档(触发器只监听 UPDATE OF content),
    // 也不发 set_field——外界永远看不到这个中间态。
    tx.execute(
        "UPDATE items SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1 AND archived_at IS NULL",
        [id],
    )
    .map_err(|e| format!("删除前置(临时归档)失败:{e}"))?;
    let n = tx
        .execute("DELETE FROM items WHERE id = ?1", [id])
        .map_err(|e| format!("删除源条目失败:{e}"))?;
    if n != 1 {
        return Err(format!("删除源条目失败(影响 {n} 行)"));
    }
    oplog::item_tombstone(&tx, clock, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(FinalizeOutcome::Deleted)
}

// ---- 共用读取(export 与 finalize 的指纹必须出自同一份代码) --------------------------

fn read_images(tx: &Connection, item_id: &str) -> Result<Vec<ImagePack>, String> {
    let mut stmt = tx
        .prepare("SELECT id, seq, mime, data FROM item_image WHERE item_id = ?1 ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([item_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, seq, mime, bytes) = row.map_err(|e| e.to_string())?;
        let sha256: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        out.push(ImagePack { id, seq, mime, bytes, sha256 });
    }
    Ok(out)
}

fn read_topics(tx: &Connection, item_id: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT t.id, t.title FROM item_topic it JOIN topics t ON t.id = it.topic_id \
             WHERE it.item_id = ?1 ORDER BY t.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([item_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

fn read_counter(tx: &Connection, item_id: &str) -> Result<Option<i64>, String> {
    tx.query_row(
        "SELECT last_seq FROM item_image_counter WHERE item_id = ?1",
        [item_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 当前源状态的规范指纹(finalize 重验用;字段清单与 export 一字不差)。
fn read_fingerprint(tx: &Connection, item_id: &str) -> Result<Fingerprint, String> {
    let item = tx
        .query_row(
            "SELECT content, stage, due_on, priority, created_at, archived_at, sealed_at \
             FROM items WHERE id = ?1",
            [item_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    let topics = read_topics(tx, item_id)?;
    let images = read_images(tx, item_id)?
        .into_iter()
        .map(|i| (i.id, i.seq, i.mime, i.bytes.len() as i64, i.sha256))
        .collect();
    let counter = read_counter(tx, item_id)?;
    Ok(Fingerprint { item, topics, images, counter })
}

/// 铸一枚在目标库全新的 ULID:查目标表 PK + 目标 oplog 历史(按 entity 分查,
/// §2.1 M4)。ULID 天生极低碰撞,循环只是响亮兜底。
fn fresh_id(tx: &Connection, table: &str, entity: &str) -> Result<String, String> {
    let sql = match table {
        "items" => {
            "SELECT (SELECT COUNT(*) FROM items WHERE id = ?1) + \
                    (SELECT COUNT(*) FROM oplog WHERE entity = ?2 AND entity_id = ?1)"
        }
        "item_image" => {
            "SELECT (SELECT COUNT(*) FROM item_image WHERE id = ?1) + \
                    (SELECT COUNT(*) FROM oplog WHERE entity = ?2 AND entity_id = ?1)"
        }
        other => panic!("fresh_id 不认识的表(必是 bug):{other}"),
    };
    for _ in 0..8 {
        let id = Ulid::new().to_string();
        let used: i64 =
            tx.query_row(sql, (&id, entity), |r| r.get(0)).map_err(|e| e.to_string())?;
        if used == 0 {
            return Ok(id);
        }
    }
    Err("连续铸出已占用的 ULID(概率上不可能,数据异常)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oplog::ops_for;
    use crate::{db, images, notes, task};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn fresh_db(tag: &str) -> (Connection, Clock) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-move-{tag}-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open migrated db");
        let clock = Clock::load(&conn).expect("load clock");
        (conn, clock)
    }

    fn oplog_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap()
    }

    fn export_ready(conn: &mut Connection, id: &str) -> MovePackage {
        match export(conn, id).unwrap() {
            ExportOutcome::Ready(p) => *p,
            ExportOutcome::ImagesPending { count } => panic!("导出被缺字节图挡下:{count}"),
            ExportOutcome::DanglingRefs { seqs } => panic!("导出被悬空引用挡下:{seqs:?}"),
        }
    }

    /// 幸福路(灵感):正文引用 图1/图3(图2 删过留洞)、一个标签——目标新生保号、
    /// 标签新建、counter=3;源删除后 oplog 增量恰 1(tombstone);目标不受源墓碑影响。
    #[test]
    fn move_idea_with_gapped_images_and_tag_end_to_end() {
        let (mut src, mut sc) = fresh_db("src");
        let (mut dst, mut dc) = fresh_db("dst");
        let id = notes::capture(&mut src, &mut sc, "见图1,后补见图3").unwrap();
        notes::file_to_topic(&mut src, &mut sc, &id, None, Some("工作")).unwrap();
        let (_i1, s1) = images::attach(&mut src, &mut sc, &id, &[1, 1], "image/png").unwrap();
        let (i2, _s2) = images::attach(&mut src, &mut sc, &id, &[2, 2], "image/png").unwrap();
        let (_i3, s3) = images::attach(&mut src, &mut sc, &id, &[3, 3], "image/jpeg").unwrap();
        images::remove(&mut src, &mut sc, &i2).unwrap(); // 图2 退役留洞
        assert_eq!((s1, s3), (1, 3));

        let pkg = export_ready(&mut src, &id);
        assert_eq!(pkg.images.len(), 2, "只搬现存图");

        let new_id = import(&mut dst, &mut dc, &pkg).unwrap();
        assert_ne!(new_id, id, "新生必换新 ULID(§2.1)");
        let (content, stage, born, created_at): (String, String, String, String) = dst
            .query_row(
                "SELECT content, stage, born_stage, created_at FROM items WHERE id = ?1",
                [&new_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(content, "见图1,后补见图3");
        assert_eq!((stage.as_str(), born.as_str()), ("filed", "filed"), "born_stage=移动时 stage");
        assert_eq!(created_at, pkg.created_at, "created_at 保留原时刻(史实)");
        // 图保号(1、3),字节逐位相等,counter=3;新图 id 全换。
        let rows: Vec<(String, i64, Vec<u8>)> = {
            let mut stmt = dst
                .prepare("SELECT id, seq, data FROM item_image WHERE item_id = ?1 ORDER BY seq")
                .unwrap();
            let it = stmt.query_map([&new_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            it.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].1, rows[1].1), (1, 3), "「见图N」引用永不错指:保原号");
        assert_eq!(rows[0].2, vec![1, 1]);
        assert_eq!(rows[1].2, vec![3, 3]);
        assert!(pkg.images.iter().all(|old| rows.iter().all(|(nid, ..)| nid != &old.id)), "图也换新 id");
        let counter: i64 = dst
            .query_row("SELECT last_seq FROM item_image_counter WHERE item_id = ?1", [&new_id], |r| r.get(0))
            .unwrap();
        assert_eq!(counter, 3, "目标 counter = 保留 seq 最大值");
        // 标签在目标新建并挂上。
        let topics: Vec<String> = {
            let mut stmt = dst
                .prepare("SELECT t.title FROM item_topic it JOIN topics t ON t.id=it.topic_id WHERE it.item_id=?1")
                .unwrap();
            let it = stmt.query_map([&new_id], |r| r.get(0)).unwrap();
            it.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(topics, vec!["工作".to_string()]);

        // 因果序(三轮 #2):item_create 与 topic_create 都早于 link_add(HLC 序)。
        let item_create_hlc = ops_for(&dst, "item", &new_id)[0].hlc.clone();
        let topic_id: String =
            dst.query_row("SELECT id FROM topics WHERE title='工作'", [], |r| r.get(0)).unwrap();
        let topic_create_hlc = ops_for(&dst, "topic", &topic_id)[0].hlc.clone();
        let link_hlc = ops_for(&dst, "link", &format!("{new_id}:{topic_id}"))[0].hlc.clone();
        assert!(item_create_hlc < link_hlc && topic_create_hlc < link_hlc, "两父 create 先于 link");

        // 源删除:oplog 增量恰 1(H3 闭合断言),行连带级联全没。
        let before = oplog_rows(&src);
        match finalize_source(&mut src, &mut sc, &pkg).unwrap() {
            FinalizeOutcome::Deleted => {}
            _ => panic!("应删除成功"),
        }
        assert_eq!(oplog_rows(&src), before + 1, "专用删除事务只发一条 tombstone");
        assert_eq!(ops_for(&src, "item", &id).last().unwrap().kind, "tombstone");
        let left: i64 =
            src.query_row("SELECT COUNT(*) FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        // 目标行安然无恙(源墓碑是另一个账户网的事,天然不复活/不压制目标)。
        let alive: i64 =
            dst.query_row("SELECT COUNT(*) FROM items WHERE id=?1", [&new_id], |r| r.get(0)).unwrap();
        assert_eq!(alive, 1);
    }

    /// 幸福路(任务):due/priority 随迁,目标落所在列**列首**。
    #[test]
    fn move_task_lands_front_of_its_column() {
        let (mut src, mut sc) = fresh_db("task-src");
        let (mut dst, mut dc) = fresh_db("task-dst");
        // 目标列先有一张卡,验证「新来的先可见」。
        task::create(&mut dst, &mut dc, "已有卡", None, None, None).unwrap();
        let id = task::create(&mut src, &mut sc, "搬家的任务", Some("2026-08-01"), Some(2), None).unwrap();

        let pkg = export_ready(&mut src, &id);
        let new_id = import(&mut dst, &mut dc, &pkg).unwrap();
        let (due, pri): (Option<String>, Option<i64>) = dst
            .query_row("SELECT due_on, priority FROM items WHERE id=?1", [&new_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(due.as_deref(), Some("2026-08-01"));
        assert_eq!(pri, Some(2));
        assert_eq!(
            repo::column_task_ids(&dst, "todo").unwrap().first(),
            Some(&new_id),
            "移动进来的卡落列首"
        );
        assert!(matches!(finalize_source(&mut src, &mut sc, &pkg).unwrap(), FinalizeOutcome::Deleted));
    }

    /// 往返(§2.1 推论):A→B→A 每次都是新 id;原 id 的墓碑压不死新生。
    #[test]
    fn round_trip_mints_fresh_ids_and_survives_tombstones() {
        let (mut a, mut ac) = fresh_db("rt-a");
        let (mut b, mut bc) = fresh_db("rt-b");
        let id0 = notes::capture(&mut a, &mut ac, "来回搬").unwrap();

        let pkg1 = export_ready(&mut a, &id0);
        let id1 = import(&mut b, &mut bc, &pkg1).unwrap();
        assert!(matches!(finalize_source(&mut a, &mut ac, &pkg1).unwrap(), FinalizeOutcome::Deleted));

        let pkg2 = export_ready(&mut b, &id1);
        let id2 = import(&mut a, &mut ac, &pkg2).unwrap();
        assert!(matches!(finalize_source(&mut b, &mut bc, &pkg2).unwrap(), FinalizeOutcome::Deleted));

        assert!(id2 != id0 && id2 != id1, "每次移动都是全新 ULID");
        // A 库里:老 id 只剩墓碑,新 id 活着——墓碑 sticky 只压自己的 id。
        assert_eq!(ops_for(&a, "item", &id0).last().unwrap().kind, "tombstone");
        let alive: i64 =
            a.query_row("SELECT COUNT(*) FROM items WHERE id=?1", [&id2], |r| r.get(0)).unwrap();
        assert_eq!(alive, 1);
    }

    /// 预检②:正文引用了已删配图号 → DanglingRefs 响亮拒(不建目标、不动源)。
    #[test]
    fn dangling_image_ref_blocks_export() {
        let (mut src, mut sc) = fresh_db("dangle");
        let id = notes::capture(&mut src, &mut sc, "见图2(它已被删)").unwrap();
        let (_i1, _) = images::attach(&mut src, &mut sc, &id, &[1], "image/png").unwrap();
        let (i2, _) = images::attach(&mut src, &mut sc, &id, &[2], "image/png").unwrap();
        images::remove(&mut src, &mut sc, &i2).unwrap();
        match export(&mut src, &id).unwrap() {
            ExportOutcome::DanglingRefs { seqs } => assert_eq!(seqs, vec![2]),
            _ => panic!("应被悬空引用预检挡下"),
        }
    }

    /// 预检①三例(二轮 H1):活图未物化拒导出;字节到齐(建行)后可移;目标 commit
    /// 后源端新冒缺字节图 → finalize 拒删(Kept),源保留。
    #[test]
    fn unmaterialized_live_image_blocks_export_then_finalize() {
        let (mut src, mut sc) = fresh_db("pending");
        let (mut dst, mut dc) = fresh_db("pending-dst");
        let id = notes::capture(&mut src, &mut sc, "有一张图还在路上").unwrap();
        let (img, _) = images::attach(&mut src, &mut sc, &id, &[9, 9], "image/png").unwrap();
        // 造「op 到、字节没到」:行删掉、op 留着(无 tombstone)——与轻端收 op 未收
        // 字节的库形态一致(判据只看 DB,不读引擎内存)。
        src.execute("DELETE FROM item_image WHERE id = ?1", [&img]).unwrap();
        match export(&mut src, &id).unwrap() {
            ExportOutcome::ImagesPending { count } => assert_eq!(count, 1),
            _ => panic!("应被缺字节预检挡下"),
        }
        // 字节到货(回放旁路建行)→ 可移。
        crate::replay::apply_image_bytes(&mut src, &img, &[9, 9]).unwrap();
        let pkg = export_ready(&mut src, &id);
        import(&mut dst, &mut dc, &pkg).unwrap();
        // 目标已建、源端又冒出一张缺字节图 → 拒删源。
        let (img2, _) = images::attach(&mut src, &mut sc, &id, &[7], "image/png").unwrap();
        src.execute("DELETE FROM item_image WHERE id = ?1", [&img2]).unwrap();
        match finalize_source(&mut src, &mut sc, &pkg).unwrap() {
            FinalizeOutcome::Kept { reason } => assert!(reason.contains("字节尚未到齐"), "{reason}"),
            _ => panic!("新冒缺字节图必须拒删源"),
        }
        let alive: i64 =
            src.query_row("SELECT COUNT(*) FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(alive, 1, "源保留");
    }

    /// H1:导出后源被并发改动(内容/标签/图),指纹重验命中差异 → 拒删返回 Kept,
    /// 零 tombstone。
    #[test]
    fn concurrent_source_change_blocks_finalize() {
        let (mut src, mut sc) = fresh_db("h1");
        let id = notes::capture(&mut src, &mut sc, "原文").unwrap();
        let pkg = export_ready(&mut src, &id);
        notes::edit(&mut src, &mut sc, &id, "改过的 S1").unwrap();
        let before = oplog_rows(&src);
        match finalize_source(&mut src, &mut sc, &pkg).unwrap() {
            FinalizeOutcome::Kept { reason } => assert!(reason.contains("被改动"), "{reason}"),
            _ => panic!("指纹差异必须拒删"),
        }
        assert_eq!(oplog_rows(&src), before, "拒删不发任何 op");
        // 标签变化同样命中(指纹含排序后的 (topic_id, title))。
        let pkg2 = export_ready(&mut src, &id);
        notes::file_to_topic(&mut src, &mut sc, &id, None, Some("新标签")).unwrap();
        assert!(matches!(
            finalize_source(&mut src, &mut sc, &pkg2).unwrap(),
            FinalizeOutcome::Kept { .. }
        ));
    }

    /// 三轮 #5:目标已建后、源恰被(远端)tombstone 删除 → AlreadyGone,零新 op,
    /// 绝不发第二条 tombstone。重试 finalize(收据重放)同样 AlreadyGone。
    #[test]
    fn source_already_tombstoned_maps_to_already_gone() {
        let (mut src, mut sc) = fresh_db("gone");
        let id = notes::capture(&mut src, &mut sc, "将被远端删").unwrap();
        let pkg = export_ready(&mut src, &id);
        // 模拟远端删除已同步到:走本地删除正道(软删+彻底删,同样落 tombstone)。
        notes::archive(&mut src, &mut sc, &id).unwrap();
        notes::purge(&mut src, &mut sc, &id).unwrap();
        let before = oplog_rows(&src);
        assert!(matches!(finalize_source(&mut src, &mut sc, &pkg).unwrap(), FinalizeOutcome::AlreadyGone));
        assert_eq!(oplog_rows(&src), before, "AlreadyGone 零新 op");
        // 收据重放(delete-only receipt 的重试语义)。
        assert!(matches!(finalize_source(&mut src, &mut sc, &pkg).unwrap(), FinalizeOutcome::AlreadyGone));
    }

    /// counter 语义(三轮 #3):源 counter=5、现零图 → 导出 Ready(引用为空)、目标
    /// **不落 counter 行**;目标随后第一张新图 = 图1(不背源洞历史)。
    #[test]
    fn zero_live_images_with_nonzero_source_counter_resets_target_numbering() {
        let (mut src, mut sc) = fresh_db("cnt-src");
        let (mut dst, mut dc) = fresh_db("cnt-dst");
        let id = notes::capture(&mut src, &mut sc, "纯文字(图全删了)").unwrap();
        for _ in 0..5 {
            let (img, _) = images::attach(&mut src, &mut sc, &id, &[1], "image/png").unwrap();
            images::remove(&mut src, &mut sc, &img).unwrap();
        }
        let counter: i64 = src
            .query_row("SELECT last_seq FROM item_image_counter WHERE item_id=?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(counter, 5, "源洞历史:counter=5、零图");

        let pkg = export_ready(&mut src, &id);
        let new_id = import(&mut dst, &mut dc, &pkg).unwrap();
        let rows: i64 = dst
            .query_row("SELECT COUNT(*) FROM item_image_counter WHERE item_id=?1", [&new_id], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "零活图不落 counter 行,源 counter 绝不导入");
        let (_img, seq) = images::attach(&mut dst, &mut dc, &new_id, &[8], "image/png").unwrap();
        assert_eq!(seq, 1, "目标首张新图从图1 起(不背源洞)");
        assert!(matches!(finalize_source(&mut src, &mut sc, &pkg).unwrap(), FinalizeOutcome::Deleted));
    }

    /// 标签按名归并(§2.5):目标已有两个同名标签(多端并发合法产物)→ 挂**最小
    /// ULID** 那个,不新建、不发 topic_create。
    #[test]
    fn tag_merge_picks_min_ulid_among_same_name() {
        let (mut src, mut sc) = fresh_db("tag-src");
        let (mut dst, mut dc) = fresh_db("tag-dst");
        let id = notes::capture(&mut src, &mut sc, "带标签").unwrap();
        notes::file_to_topic(&mut src, &mut sc, &id, None, Some("重名")).unwrap();
        // 目标库手工造两个同名 topic(绕过命令层唯一闸,模拟多端并发产物)。
        let t_small = "01AAAAAAAAAAAAAAAAAAAAAAAA";
        let t_big = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
        for t in [t_big, t_small] {
            dst.execute(
                "INSERT INTO topics (id, title, created_at, updated_at) \
                 VALUES (?1, '重名', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                [t],
            )
            .unwrap();
        }
        let pkg = export_ready(&mut src, &id);
        let new_id = import(&mut dst, &mut dc, &pkg).unwrap();
        let linked: Vec<String> = {
            let mut stmt =
                dst.prepare("SELECT topic_id FROM item_topic WHERE item_id=?1").unwrap();
            let it = stmt.query_map([&new_id], |r| r.get(0)).unwrap();
            it.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(linked, vec![t_small.to_string()], "归并选最小 ULID");
        assert!(ops_for(&dst, "topic", t_small).is_empty(), "复用不发 topic_create");
        let total: i64 = dst.query_row("SELECT COUNT(*) FROM topics", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 2, "不新建第三个同名");
    }

    /// 三轮测试单:目标账户的**另一台设备**全量回放移动产生的 op(按 origin_seq 序)
    /// ——新建 topic/link/image_add 全部按因果序可应用,字节到货后行/counter 与目标
    /// 一致、缺字节清单归零。锁死 #2(因果前驱)在回放端真实成立。
    #[test]
    fn target_ops_replay_cleanly_on_second_device() {
        let (mut src, mut sc) = fresh_db("replay-src");
        let (mut dst, mut dc) = fresh_db("replay-dst");
        let (mut peer, mut pc) = fresh_db("replay-peer");
        let id = notes::capture(&mut src, &mut sc, "见图1").unwrap();
        notes::file_to_topic(&mut src, &mut sc, &id, None, Some("回放组")).unwrap();
        images::attach(&mut src, &mut sc, &id, &[5, 5, 5], "image/png").unwrap();
        let pkg = export_ready(&mut src, &id);
        let new_id = import(&mut dst, &mut dc, &pkg).unwrap();

        // 拉出目标库全部 op(单 origin,origin_seq 即因果发射序),逐条喂给同账户
        // 的第二台设备。任何一条挂起/报错 = 因果序破了。
        let ops: Vec<crate::replay::RemoteOp> = {
            let mut stmt = dst
                .prepare(
                    "SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq \
                     FROM oplog ORDER BY origin_seq",
                )
                .unwrap();
            let it = stmt
                .query_map([], |r| {
                    Ok(crate::replay::RemoteOp {
                        op_id: r.get(0)?,
                        hlc: r.get(1)?,
                        entity: r.get(2)?,
                        entity_id: r.get(3)?,
                        kind: r.get(4)?,
                        payload: serde_json::from_str(&r.get::<_, String>(5)?).unwrap(),
                        origin_seq: r.get(6)?,
                    })
                })
                .unwrap();
            it.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert!(!ops.is_empty());
        for op in &ops {
            crate::replay::apply_remote_op(&mut peer, &mut pc, op)
                .unwrap_or_else(|e| panic!("回放 {}/{} 失败:{e}", op.kind, op.entity_id));
        }
        // 元数据收敛;图字节走旁路——到货前缺字节清单=1,到货后行建齐、counter 对齐。
        let (c, s): (String, String) = peer
            .query_row("SELECT content, stage FROM items WHERE id=?1", [&new_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((c.as_str(), s.as_str()), ("见图1", "filed"));
        assert_eq!(crate::sync::transport::pending_blob_count(&peer).unwrap(), 1);
        let img_id: String = dst
            .query_row("SELECT id FROM item_image WHERE item_id=?1", [&new_id], |r| r.get(0))
            .unwrap();
        crate::replay::apply_image_bytes(&mut peer, &img_id, &[5, 5, 5]).unwrap();
        assert_eq!(crate::sync::transport::pending_blob_count(&peer).unwrap(), 0);
        let (seq, counter): (i64, i64) = peer
            .query_row(
                "SELECT (SELECT seq FROM item_image WHERE id=?1), \
                        (SELECT last_seq FROM item_image_counter WHERE item_id=?2)",
                (&img_id, &new_id),
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((seq, counter), (1, 1));
    }

    /// 入口守卫:不存在 / 回收站 / 成就归档一律拒导出。
    #[test]
    fn export_rejects_missing_archived_sealed() {
        let (mut src, mut sc) = fresh_db("guard");
        assert!(export(&mut src, "ghost").is_err());
        let trashed = notes::capture(&mut src, &mut sc, "进回收站").unwrap();
        notes::archive(&mut src, &mut sc, &trashed).unwrap();
        assert!(export(&mut src, &trashed).unwrap_err().contains("回收站"));
        let sealed = task::create(&mut src, &mut sc, "已归档成就", None, None, None).unwrap();
        task::transition(&mut src, &mut sc, &sealed, "done").unwrap();
        task::seal(&mut src, &mut sc, &sealed).unwrap();
        assert!(export(&mut src, &sealed).unwrap_err().contains("成就归档"));
    }

    /// item_image_bytes:零图=0、字节精确求和(手机图字节预算靠它,不读 BLOB)。
    #[test]
    fn item_image_bytes_sums_exactly() {
        let (mut src, mut sc) = fresh_db("bytes");
        let id = notes::capture(&mut src, &mut sc, "配图").unwrap();
        assert_eq!(item_image_bytes(&src, &id).unwrap(), 0);
        images::attach(&mut src, &mut sc, &id, &[1, 2, 3], "image/png").unwrap();
        images::attach(&mut src, &mut sc, &id, &[9, 9], "image/png").unwrap();
        assert_eq!(item_image_bytes(&src, &id).unwrap(), 5, "3+2 字节精确求和");
    }

    /// MoveResult serde 契约(codex 安卓实现审 #5):outcome tag + 字段名钉死,
    /// 两壳前端 TS 镜像的就是这五个 JSON 形,谁改 Rust 变体名此测即红。
    #[test]
    fn move_result_serde_contract() {
        let j = |r: &MoveResult| serde_json::to_value(r).unwrap();
        assert_eq!(
            j(&MoveResult::Moved { new_id: "x".into(), source_already_gone: true }),
            serde_json::json!({"outcome":"moved","new_id":"x","source_already_gone":true})
        );
        assert_eq!(
            j(&MoveResult::CopiedButSourceKept { new_id: "x".into(), reason: "r".into() }),
            serde_json::json!({"outcome":"copied_but_source_kept","new_id":"x","reason":"r"})
        );
        assert_eq!(
            j(&MoveResult::CopiedButSourceUnconfirmed { new_id: "x".into(), error: "e".into() }),
            serde_json::json!({"outcome":"copied_but_source_unconfirmed","new_id":"x","error":"e"})
        );
        assert_eq!(
            j(&MoveResult::ImagesPending { count: 2 }),
            serde_json::json!({"outcome":"images_pending","count":2})
        );
        assert_eq!(
            j(&MoveResult::DanglingRefs { seqs: vec![1, 3] }),
            serde_json::json!({"outcome":"dangling_refs","seqs":[1,3]})
        );
    }

    /// from_finalize 分道映射(两壳共用):Deleted/AlreadyGone→Moved、Kept→kept、
    /// Err→unconfirmed(new_id 恒带,绝不丢)。
    #[test]
    fn from_finalize_maps_all_arms() {
        let nid = || "n1".to_string();
        assert_eq!(
            MoveResult::from_finalize(nid(), Ok(FinalizeOutcome::Deleted)),
            MoveResult::Moved { new_id: nid(), source_already_gone: false }
        );
        assert_eq!(
            MoveResult::from_finalize(nid(), Ok(FinalizeOutcome::AlreadyGone)),
            MoveResult::Moved { new_id: nid(), source_already_gone: true }
        );
        assert_eq!(
            MoveResult::from_finalize(nid(), Ok(FinalizeOutcome::Kept { reason: "r".into() })),
            MoveResult::CopiedButSourceKept { new_id: nid(), reason: "r".into() }
        );
        assert_eq!(
            MoveResult::from_finalize(nid(), Err("boom".into())),
            MoveResult::CopiedButSourceUnconfirmed { new_id: nid(), error: "boom".into() }
        );
    }
}
