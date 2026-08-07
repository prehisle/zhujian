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

use std::collections::{BTreeSet, HashSet};

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

/// 一条随迁留言(identity-plan §4.5)。**不带 `born_device`** —— 目标空间落 NULL
/// (作者未知):空间=账户=独立库、device_id 每空间一份,源作者的身份在目标名册里
/// 根本不存在,填执行移动那台 = 把别人写的话署上搬运工的名。
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct CommentPack {
    pub(crate) id: String,
    pub(crate) content: String,
    pub(crate) created_at: String,
}

/// 规范指纹(§2.2 M1):排序后精确比对,**不是**只比 updated_at(图片/标签变更
/// 未必更新它)。counter 区分「无行」与具体值;position 不迁移不比。
#[derive(PartialEq, Debug)]
pub(crate) struct Fingerprint {
    item: (String, String, Option<String>, Option<i64>, String, Option<String>, Option<String>, Option<String>),
    /// 排序后的 (source_topic_id, exact_title)——不能只比去重后的名字。
    topics: Vec<(String, String)>,
    /// 排序后的 (id, seq, mime, byte_len, sha256)。
    images: Vec<(String, i64, String, i64, String)>,
    counter: Option<i64>,
    /// 排序后的 (id, created_at, content_byte_len, sha256(content))(0035)。
    ///
    /// **存摘要不存正文**(设计审一轮 H4):否则 `finalize_source` 那一刻会同时持有
    /// 「包里的全部正文」+「重验时读出的全部正文」= 双份物化。hash 的是 UTF-8 原始
    /// 字节、**不做 Unicode 规范化**,碰撞口径与 image 同级;`content_byte_len` 是二轮
    /// 建议加的第二判据(廉价、诊断更清楚)。
    comments: Vec<(String, String, i64, String)>,
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
    /// 完成时刻(0030):Some = 该条目带完成时间,目标 create 后补 set_field 落同值保号;
    /// None = 未完成过 / 老卡未知,目标生而 NULL(不补)。
    pub(crate) done_at: Option<String>,
    pub(crate) topics: Vec<(String, String)>,
    pub(crate) images: Vec<ImagePack>,
    /// 随迁留言(identity-plan §4.5,用户 2026-08-06 拍板「跟着走」)。
    pub(crate) comments: Vec<CommentPack>,
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

/// 每个子实体在 Rust 侧的**定长**元数据准备金(字节)。
///
/// 一张图 / 一条留言 / 一条标签关联,除去自己的大字符串之外还要在好几个 O(n) 容器里各占
/// 一份定长的东西:结构体 + 摘要里的 id / 时间 / sha 十六进制串 + 铸出的新 ULID + 借用行。
/// 512 是把这些往上取整的**准备金**,不是量出来的精确值 —— 它只负责「**几十万条极短
/// 子实体**」这种大字符串几乎为零、定长元数据却上百 MiB 的形态也撞得上闸。
///
/// ⚠️ **大字符串一律精确计数,不许塞进这个准备金**(codex 实现审二弹二轮 H1):标签标题
/// 单条可到 200 KiB,拿 512 去覆盖它是数量级的错。
pub const MOVE_CHILD_METADATA_BYTES: i64 = 512;

/// 移动这一条要过手的各种量,**一次 SQL 取齐**(codex 实现审二弹三轮 M2)。
///
/// 从前这里是两个各自拼 SQL 的函数(`move_payload_bytes` 与 `move_peak_bytes`),于是
/// 「包体到底含不含标签标题」这件事在两处各说各的 —— 前者忘了标题,而标题恰恰是包里最
/// 可能超大的那一项。现在只有这一份取数,`package_bytes` 与 `peak_bytes` 都从它算。
pub struct MoveFootprint {
    item_bytes: i64,
    img_sum: i64,
    img_max: i64,
    img_n: i64,
    cmt_sum: i64,
    cmt_max: i64,
    cmt_n: i64,
    title_sum: i64,
    link_n: i64,
    /// import 发 create op 那一刻的**瞬时**峰值候选:同一条大字符串会同时以
    /// `serde_json::Value` 与 `payload.to_string()` 两份活着,而后者按 JSON 转义可能
    /// 膨胀(控制字符 → `\uXXXX`)。取「原文字节 + `json_quote` 后字节」在 item 正文 /
    /// 最长留言 / 最长标题三者中的最大值 —— 用真实数据求上界,不拍「最坏 7 倍」。
    json_max: i64,
}

/// 一次取齐(正文与标题一律 `CAST(... AS BLOB)` 再 `length`:SQLite 的 `length()` 对
/// **TEXT 数字符、对 BLOB 才数字节**,首版就在这栽过 —— 中文正文算少三倍)。
pub fn read_move_footprint(conn: &Connection, item_id: &str) -> Result<MoveFootprint, String> {
    conn.query_row(
        "SELECT (SELECT COALESCE(length(CAST(content AS BLOB)), 0) FROM items WHERE id = ?1),                 (SELECT COALESCE(SUM(length(data)), 0) FROM item_image WHERE item_id = ?1),                 (SELECT COALESCE(MAX(length(data)), 0) FROM item_image WHERE item_id = ?1),                 (SELECT COUNT(*) FROM item_image WHERE item_id = ?1),                 (SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) FROM item_comment WHERE item_id = ?1),                 (SELECT COALESCE(MAX(length(CAST(content AS BLOB))), 0) FROM item_comment WHERE item_id = ?1),                 (SELECT COUNT(*) FROM item_comment WHERE item_id = ?1),                 (SELECT COALESCE(SUM(length(CAST(t.title AS BLOB))), 0) FROM item_topic it                    JOIN topics t ON t.id = it.topic_id WHERE it.item_id = ?1),                 (SELECT COUNT(*) FROM item_topic WHERE item_id = ?1),                 MAX(                   (SELECT COALESCE(length(CAST(content AS BLOB))                                  + length(CAST(json_quote(content) AS BLOB)), 0)                      FROM items WHERE id = ?1),                   (SELECT COALESCE(MAX(length(CAST(content AS BLOB))                                      + length(CAST(json_quote(content) AS BLOB))), 0)                      FROM item_comment WHERE item_id = ?1),                   (SELECT COALESCE(MAX(length(CAST(t.title AS BLOB))                                      + length(CAST(json_quote(t.title) AS BLOB))), 0)                      FROM item_topic it JOIN topics t ON t.id = it.topic_id                     WHERE it.item_id = ?1))",
        [item_id],
        |r| {
            Ok(MoveFootprint {
                item_bytes: r.get(0)?,
                img_sum: r.get(1)?,
                img_max: r.get(2)?,
                img_n: r.get(3)?,
                cmt_sum: r.get(4)?,
                cmt_max: r.get(5)?,
                cmt_n: r.get(6)?,
                title_sum: r.get(7)?,
                link_n: r.get(8)?,
                json_max: r.get(9)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn overflowed() -> String {
    "这条的体量算出来溢出了(数据异常)".to_string()
}

fn add(a: i64, b: i64) -> Result<i64, String> {
    a.checked_add(b).ok_or_else(overflowed)
}

impl MoveFootprint {
    /// 包体 P:`MovePackage` 里那份**移动原料**(条目正文 + 全部图字节 + 全部留言正文 +
    /// 全部标签标题)。**标题必须在内**(三轮 M2:旧的 `move_payload_bytes` 漏了它)。
    pub fn package_bytes(&self) -> Result<i64, String> {
        add(add(add(self.item_bytes, self.img_sum)?, self.cmt_sum)?, self.title_sum)
    }

    /// 移动这一条时,Rust 侧**增量**内存的保守估算(三相位取最大)。
    ///
    /// # 三相位内存账
    ///
    /// ```text
    /// P = 移动原料      = item 正文 + Σ图字节 + Σ留言正文 + Σ标签标题
    /// Q = 指纹里的大字段 = item 正文 + Σ标签标题
    /// S = 逐行 scratch  = max(最大单图, 最大单条留言)
    /// J = import 发 op 的瞬时峰值 = max(原文 + json_quote 后) over(item 正文/最长留言/最长标题)
    /// M = 定长准备金    = (图数 + 留言数 + 标签关联数) × MOVE_CHILD_METADATA_BYTES
    ///
    /// export   = P + Q     + S + M     包在手,再算一份指纹
    /// import   = P + Q     + J + M     包(含指纹)在手,逐条发 op
    /// finalize = P + Q + Q + S + M     包(含指纹)在手,**再读一份**指纹重验
    /// 返回 max(export, import, finalize)
    /// ```
    ///
    /// **finalize 固定比 export 多一份 Q**(三轮 H1);但**最高的是哪一幕由数据说了算** ——
    /// 只有正文、没有子实体时 `J` 会让 import 反超(四轮 L1 更正了我这句写过强的话)。
    /// `MovePackage` 自己存着 export 时算的
    /// `fingerprint`,所以进 finalize 时 item 正文与标题已经各有两份;`read_fingerprint`
    /// 重验又读出**第三份**。我上一轮写「finalize = export」是错的 —— 反例:标题共 64 MiB、
    /// 无图无留言,旧式估算 ~128 MiB 放行,而 finalize 光标题就近 192 MiB。
    ///
    /// 三处「没有硬闸的条数」都在账里:留言(本地 500 只是**本地写入软闸**,协议上无界)、
    /// 配图、标签关联。
    ///
    /// # 它**不是**什么
    ///
    /// 「**Rust 侧增量**内存估算」,不是进程峰值硬上界。**未计入**:SQLite 页缓存、应用
    /// 常驻内存。**已计入**:import 发 create op 时那份 `serde_json::Value` + 序列化字符串
    /// (三轮 L1 更正 —— 移动包全程留在 Rust 内部,跨三原语没有 CBOR;Tauri 最后序列化的
    /// 是 `MoveResult` 而不是 `MovePackage`)。
    ///
    /// 真要类型层的保证,得走 receipt 重构(排队项,触发条件:抬高移动上限 / 桌面也接这条
    /// 路 / 要支持明显更低内存的安卓设备 / 真机出现内存压力)。
    pub fn peak_bytes(&self) -> Result<i64, String> {
        let p = self.package_bytes()?;
        let q = add(self.item_bytes, self.title_sum)?;
        let s = self.img_max.max(self.cmt_max);
        let m = (self.img_n.checked_add(self.cmt_n).and_then(|n| n.checked_add(self.link_n)))
            .and_then(|n| n.checked_mul(MOVE_CHILD_METADATA_BYTES))
            .ok_or_else(overflowed)?;
        let base = add(add(p, q)?, m)?;
        let export = add(base, s)?;
        let import = add(base, self.json_max)?;
        let finalize = add(add(base, q)?, s)?;
        Ok(export.max(import).max(finalize))
    }
}

/// 壳层 OOM 闸的唯一入口(手机政策留壳层,桌面不查)。
pub fn move_peak_bytes(conn: &Connection, item_id: &str) -> Result<i64, String> {
    read_move_footprint(conn, item_id)?.peak_bytes()
}

// ---- 原语一:导出(源库,只读) ------------------------------------------------------

/// 导出当前态包 + 两道预检 + 算规范指纹。单事务读取保证自洽快照。
pub fn export(conn: &mut Connection, item_id: &str) -> Result<ExportOutcome, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let row: Option<(String, String, String, Option<String>, Option<i64>, Option<String>, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT content, stage, created_at, due_on, priority, archived_at, sealed_at, done_at \
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
                    r.get(7)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (content, stage, created_at, due_on, priority, archived_at, sealed_at, done_at) =
        row.ok_or_else(|| "条目不存在".to_string())?;
    if archived_at.is_some() || sealed_at.is_some() {
        return Err("回收站/成就归档中的条目不能移动(史实轴,先还原)".to_string());
    }
    // done_at 保号(0030 单版 writer):带完成时间的条目照常移动——包携 done_at,目标 create
    // 后补一次 set_field 落同值(见 import)。done_at 进移动指纹(下方 + finalize 重验守 H1),
    // 导出后并发改完成时刻会被 finalize 拒删。工序1 的「响亮拒绝已带完成时间的条目」已撤。
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
    let comments = read_comments(&tx, item_id)?;
    // 指纹与 `finalize_source` 的重验**出自同一个函数**(设计审 GO 复核面第 8 条:
    // export 与 finalize 的字段 / 排序 / hash 输入必须完全一致)。同一只只读事务的快照
    // 内多读一遍,值必然相同;换来的是**零漂移风险**——两处各拼一次才是漂移的温床。
    let fingerprint = read_fingerprint(&tx, item_id)?;
    // 只读事务,commit 是 no-op;显式收掉别让它一直开着。
    tx.commit().map_err(|e| e.to_string())?;

    Ok(ExportOutcome::Ready(Box::new(MovePackage {
        source_id: item_id.to_string(),
        content,
        stage,
        created_at,
        due_on,
        priority,
        done_at,
        topics,
        images,
        comments,
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

    // 完成时刻保号(0030):create 出生快照生而 NULL(触发器 trg_item_no_insert_done_at
    // 也只拦 INSERT),故带完成时间的条目在 create 之后补一次 UPDATE + set_field——协议只增
    // 不清、值必非空,让目标账户各端回放到同一完成时刻。done_at 与当前 stage 无关(「最近
    // 一次进 done 的时刻」,撤回后也保住),不按 stage 设卡。
    if let Some(done_at) = pkg.done_at.as_deref() {
        let n = tx
            .execute("UPDATE items SET done_at = ?2 WHERE id = ?1", (&new_id, done_at))
            .map_err(|e| format!("目标空间完成时刻落值失败:{e}"))?;
        if n != 1 {
            return Err(format!("目标空间完成时刻落值失败(影响 {n} 行)"));
        }
        oplog::item_set(&tx, clock, &new_id, &["done_at"])?;
    }

    // 标签按名归并(§2.5):源名先去重(BTreeSet 顺带给出确定性遍历序);目标同名
    // 取最小 ULID;缺则新建(不带源颜色——颜色是目标空间自己的元数据)。
    // ⚠ 借用而不是 clone(codex 实现审二弹二轮 H1 的第 4 条):标题单条可到 200 KiB、
    // 单条目挂多少个标签没有硬闸,`BTreeMap<String, ()>`(旧写法) 会在包体之外再攒**整整一份**
    // 标题字符串,而那一相位的峰值可能比 export 算指纹那一幕还高。
    let mut unique_titles: BTreeSet<&str> = BTreeSet::new();
    for (_, title) in &pkg.topics {
        unique_titles.insert(title.as_str());
    }
    for title in &unique_titles {
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
                crate::notes::assign_new_topic_position(&tx, clock, &minted)?; // 0031:落末键 + op
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

    // 留言随迁(identity-plan §4.5):新 ULID、`created_at` 保留原时刻(史实)、
    // `born_device` 落 NULL(作者未知)。行走**可信写入语境**,op 在语境之外发。
    // 只存新铸的 id —— 原先还顺手 clone 了一份 `created_at`,而它从头到尾没人读
    //(codex 实现审二弹 L3:大量短留言时那是每行一次白给的分配)。
    let mut new_ids: Vec<String> = Vec::with_capacity(pkg.comments.len());
    for _ in &pkg.comments {
        new_ids.push(fresh_id(&tx, "item_comment", "comment")?);
    }
    let rows: Vec<MovedComment<'_>> = pkg
        .comments
        .iter()
        .zip(new_ids.iter())
        .map(|(c, fresh)| MovedComment {
            id: fresh.as_str(),
            item_id: new_id.as_str(),
            content: c.content.as_str(),
            created_at: c.created_at.as_str(),
        })
        .collect();
    let tx = insert_moved_comment_rows(tx, &rows)?;
    for fresh in &new_ids {
        oplog::comment_create(&tx, clock, fresh)?; // create 在 item_create 之后(因果前驱)
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_id)
}

/// 一行待落的随迁留言(借用形,不复制正文)。
struct MovedComment<'a> {
    id: &'a str,
    item_id: &'a str,
    content: &'a str,
    created_at: &'a str,
}

// ⚠ 进出可信语境的两条 SQL **刻意不抽常量**(codex 实现审二弹二轮 M1):抽出去的话
// 结构锚只能钉住函数体,而常量定义在函数体之外 —— 把 `FLAG_DELETE` 改成
// `"UPDATE sync_replay_active SET flag = 1"`,函数体一个字不变、锚照绿,而旗根本没清。
// 内联进去,那道整段白名单就把它们一起钉住了。

/// **可信写入语境**里落随迁留言的行(identity-plan §4.2,设计审一轮 H1 + 三轮 M1)。
///
/// `trg_comment_born_device_required` 要求 `born_device` 等于本机 `device_id`,而搬来的
/// 留言要落 NULL(作者未知)——两条判据各自都对,合起来无解,故把跨空间导入正式列为
/// **第三个可信写入语境**(前两个:远端回放、boot 引导导入)。三者同性质:写进去的值
/// 来自另一个权威来源,不是本机此刻现场产生的。
///
/// # 为什么是「事务所有权」而不是「借 `&Transaction`」
///
/// 借用形下这条路是通的,而它把「窄作用域」想消灭的那件事又请了回来:
///
/// ```ignore
/// let _ = insert_moved_comment_rows(&tx, &rows);   // 吞掉 Err
/// tx.commit()?;                                    // flag 还在场,照样提交
/// ```
///
/// **SQLite 单条语句失败不会把整个事务标记成不可提交**,所以「清旗失败必然导致 commit
/// 失败」这个前提是假的。消费所有权、只有两件都成功才交还,四个分支就都成了结构事实:
/// 插旗失败 / 插行失败 / 清旗失败 —— 本地 `tx` 直接 drop 回滚(连同同事务里已插的
/// items、topics、images 一起);只有全成功,调用方才重新拿得到一个可提交的事务。
///
/// # 作用域
///
/// 可信区里**只有三类 SQL**:flag INSERT / `item_comment` INSERT / flag DELETE ——
/// 同事务的 items / topics / item_image 三段都在语境之外,0022 那批守护照旧咬。
/// 由 `move_item_trusted_region_is_narrow` 结构锚守着(它同时禁止在可信区内调用
/// allowlist 之外的 helper —— 否则把 INSERT 挪进一个新 helper 就能从文本锚底下溜走)。
fn insert_moved_comment_rows<'c>(
    tx: rusqlite::Transaction<'c>,
    rows: &[MovedComment<'_>],
) -> Result<rusqlite::Transaction<'c>, String> {
    tx.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", [])
        .map_err(|e| format!("进入可信写入语境失败:{e}"))?;
    let res = (|| -> Result<(), String> {
        for r in rows {
            tx.execute(
                "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
                 VALUES (?1, ?2, ?3, ?4, NULL)",
                (r.id, r.item_id, r.content, r.created_at),
            )
            .map_err(|e| format!("目标空间留言落行失败:{e}"))?;
        }
        Ok(())
    })();
    tx.execute("DELETE FROM sync_replay_active", [])
        .map_err(|e| format!("退出可信写入语境失败:{e}"))?;
    res?;
    Ok(tx)
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

/// 一条留言的随迁读取(带正文——它就是要搬的东西;整包字节由 [`MoveFootprint::package_bytes`]
/// 的总预算把关)。排序与 `list_for_item` 无关,取 id 序,只要与指纹侧同序即可。
fn read_comments(tx: &Connection, item_id: &str) -> Result<Vec<CommentPack>, String> {
    let mut stmt = tx
        .prepare("SELECT id, content, created_at FROM item_comment WHERE item_id = ?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([item_id], |r| {
            Ok(CommentPack { id: r.get(0)?, content: r.get(1)?, created_at: r.get(2)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// 留言摘要:**逐行读、当行 hash、当行释放**(设计审二轮 M4)。
///
/// 禁止先 `read_comments() -> Vec` 再 map —— 那样 `finalize_source` 会同时持有「包里的
/// 全部正文」与「重验时读出的全部正文」,H4 的双份物化原样回来。
fn comment_digests(tx: &Connection, item_id: &str) -> Result<Vec<(String, String, i64, String)>, String> {
    let mut stmt = tx
        .prepare("SELECT id, created_at, content FROM item_comment WHERE item_id = ?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([item_id]).map_err(|e| e.to_string())?;
    let mut out = vec![];
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let created_at: String = row.get(1).map_err(|e| e.to_string())?;
        let content: String = row.get(2).map_err(|e| e.to_string())?;
        let sha: String = Sha256::digest(content.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        out.push((id, created_at, content.len() as i64, sha));
        // content 在此 drop —— 循环里同时活着的至多一条正文。
    }
    Ok(out)
}

/// 配图摘要:同样**逐行读、当行 hash、当行释放**(设计审二轮 M4 的「最好那半」)。
///
/// 原先 `read_fingerprint` 调 `read_images()` 把整组 BLOB 读成 `Vec` 再 map。留言照抄那个
/// 读法就会**双份物化**,故同轮一起改成逐行。
///
/// ⚠️ 这里原先还写着一句「改完 `≤128 MiB` 就从包体预算变成峰值预算」—— **那句话是错的**
/// (codex 实现审二弹 H1):包体本身已经整个在 `MovePackage` 里,逐行 hash 省掉的只是
/// 「再来一整组的副本」。峰值的诚实口径见 [`move_peak_bytes`]。
fn image_digests(tx: &Connection, item_id: &str) -> Result<Vec<(String, i64, String, i64, String)>, String> {
    let mut stmt = tx
        .prepare("SELECT id, seq, mime, data FROM item_image WHERE item_id = ?1 ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([item_id]).map_err(|e| e.to_string())?;
    let mut out = vec![];
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let seq: i64 = row.get(1).map_err(|e| e.to_string())?;
        let mime: String = row.get(2).map_err(|e| e.to_string())?;
        let data: Vec<u8> = row.get(3).map_err(|e| e.to_string())?;
        let sha: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
        out.push((id, seq, mime, data.len() as i64, sha));
        // data 在此 drop —— 循环里同时活着的至多一张图。
    }
    Ok(out)
}

/// 当前源状态的规范指纹(export 与 finalize 重验**共用**;字段清单单一来源)。
fn read_fingerprint(tx: &Connection, item_id: &str) -> Result<Fingerprint, String> {
    let item = tx
        .query_row(
            "SELECT content, stage, due_on, priority, created_at, archived_at, sealed_at, done_at \
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
                    r.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    let topics = read_topics(tx, item_id)?;
    let images = image_digests(tx, item_id)?;
    let counter = read_counter(tx, item_id)?;
    let comments = comment_digests(tx, item_id)?;
    Ok(Fingerprint { item, topics, images, counter, comments })
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
        "item_comment" => {
            "SELECT (SELECT COUNT(*) FROM item_comment WHERE id = ?1) + \
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

    /// 注一条合法远端 done_at set_field(HLC 在 2100 年,LWW 必压过本地写者的完成时刻)
    /// ——模拟「导出后完成时刻被别端并发改动」,验指纹重验守 H1。
    fn inject_done_at(conn: &mut Connection, clock: &mut Clock, id: &str, ts: &str) {
        crate::replay::apply_remote_op(
            conn,
            clock,
            &crate::replay::RemoteOp {
                op_id: ulid::Ulid::new().to_string(),
                hlc: crate::clock::Hlc {
                    wall_ms: 4_102_444_800_000,
                    counter: 0,
                    device_id: "RMTDEV0000000000000000000X".into(),
                }
                .encode(),
                entity: "item".into(),
                entity_id: id.to_string(),
                kind: "set_field".into(),
                payload: serde_json::json!({"field": "done_at", "value": ts}),
                origin_seq: 1,
            },
        )
        .expect("done_at 落值");
    }

    /// done_at 保号(0030 单版 writer):进 done 的卡(writer 已盖 done_at)跨空间移动 →
    /// 移动包携完成时刻、目标 create 后补 set_field 落**同一** done_at、源删。工序1 的
    /// 「响亮拒绝已带完成时间的条目」已撤。
    #[test]
    fn move_preserves_done_at() {
        let (mut src, mut sc) = fresh_db("done-keep");
        let (mut dst, mut dc) = fresh_db("done-keep-dst");
        let id = task::create(&mut src, &mut sc, "干完的活", None, None, None).unwrap();
        task::transition(&mut src, &mut sc, &id, "done").unwrap(); // writer 盖 done_at
        let src_done: String =
            src.query_row("SELECT done_at FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();

        let pkg = export_ready(&mut src, &id);
        assert_eq!(pkg.done_at.as_deref(), Some(src_done.as_str()), "移动包携完成时刻");

        let new_id = import(&mut dst, &mut dc, &pkg).unwrap();
        let dst_done: Option<String> =
            dst.query_row("SELECT done_at FROM items WHERE id=?1", [&new_id], |r| r.get(0)).unwrap();
        assert_eq!(dst_done.as_deref(), Some(src_done.as_str()), "目标保住同一完成时刻");
        // 目标发一条 done_at set_field(值非空,供目标账户各端回放)。
        let done_vals: Vec<serde_json::Value> = ops_for(&dst, "item", &new_id)
            .into_iter()
            .filter(|o| o.kind == "set_field" && o.payload["field"] == "done_at")
            .map(|o| o.payload["value"].clone())
            .collect();
        assert_eq!(done_vals, vec![serde_json::json!(src_done)], "补一条 done_at set_field(非空)");

        assert!(matches!(finalize_source(&mut src, &mut sc, &pkg).unwrap(), FinalizeOutcome::Deleted));
    }

    /// H1(完成时刻版):导出后 done_at 被别端并发改动 → finalize 指纹重验命中差异 →
    /// 拒删返回 Kept,源保留、零 tombstone(不静默丢值)。done_at 在移动指纹里是这道守卫的凭据。
    #[test]
    fn concurrent_done_at_blocks_finalize() {
        let (mut src, mut sc) = fresh_db("done-h1");
        let id = task::create(&mut src, &mut sc, "干完的活", None, None, None).unwrap();
        task::transition(&mut src, &mut sc, &id, "done").unwrap(); // done_at=T1
        let pkg = export_ready(&mut src, &id); // 导出捕获 T1
        inject_done_at(&mut src, &mut sc, &id, "2026-07-20T10:00:00.000Z"); // 并发改成 T2(LWW 胜)
        let before = oplog_rows(&src);
        match finalize_source(&mut src, &mut sc, &pkg).unwrap() {
            FinalizeOutcome::Kept { reason } => assert!(reason.contains("被改动"), "{reason}"),
            _ => panic!("done_at 差异必须拒删"),
        }
        assert_eq!(oplog_rows(&src), before, "拒删不发任何 op");
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

    /// 包体 P:`MovePackage` 里那份移动原料的**四样**(配图 + 条目正文 + 全部留言正文 +
    /// **全部标签标题**)。少数任何一样,手机那道预算闸对它就是不设防。
    ///
    /// ⚠ 标题那一格是 codex 实现审二弹三轮 M2 补的 —— 旧的 `move_payload_bytes` 自称
    /// 「整包」却漏了它,而标题恰恰是包里最可能超大的一项(单条 200 KiB、条数无硬闸)。
    #[test]
    fn package_bytes_sums_images_content_comments_and_titles() {
        let (mut src, mut sc) = fresh_db("bytes");
        let p = |c: &Connection, id: &str| read_move_footprint(c, id).unwrap().package_bytes().unwrap();
        let id = notes::capture(&mut src, &mut sc, "配图").unwrap(); // 正文 6 字节(UTF-8)
        let base = "配图".len() as i64;
        assert_eq!(p(&src, &id), base, "零图零留言零标签 = 正文本身");
        images::attach(&mut src, &mut sc, &id, &[1, 2, 3], "image/png").unwrap();
        images::attach(&mut src, &mut sc, &id, &[9, 9], "image/png").unwrap();
        assert_eq!(p(&src, &id), base + 5, "图 3+2 字节精确求和");
        crate::comments::add(&mut src, &mut sc, &id, "abc").unwrap();
        crate::comments::add(&mut src, &mut sc, &id, "de").unwrap();
        assert_eq!(p(&src, &id), base + 5 + 5, "留言正文一起算(3+2)");
        notes::file_to_topic(&mut src, &mut sc, &id, None, Some("标签甲")).unwrap();
        assert_eq!(
            p(&src, &id),
            base + 5 + 5 + "标签甲".len() as i64,
            "标签标题一起算 —— 少了这一格,一堆大标题的条目会被算成几乎为零"
        );
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

    /// 留言随迁(identity-plan §4.5,用户拍板「跟着走」):新 ULID、`created_at` **保留
    /// 原时刻**、`born_device` **落 NULL**(作者未知);目标端发 comment create op,且
    /// 排在 item_create 之后(因果前驱)。源删除后留言随 CASCADE 走。
    #[test]
    fn comments_ride_along_with_fresh_ids_and_no_author() {
        let (mut src, mut sc) = fresh_db("cmt-src");
        let (mut dst, mut dc) = fresh_db("cmt-dst");
        let id = notes::capture(&mut src, &mut sc, "带留言搬家").unwrap();
        let c1 = crate::comments::add(&mut src, &mut sc, &id, "第一句").unwrap();
        crate::comments::add(&mut src, &mut sc, &id, "第二句").unwrap();
        let src_ts: String = src
            .query_row("SELECT created_at FROM item_comment WHERE id = ?1", [&c1], |r| r.get(0))
            .unwrap();

        let pkg = export_ready(&mut src, &id);
        assert_eq!(pkg.comments.len(), 2, "两条留言进包");

        let new_id = import(&mut dst, &mut dc, &pkg).unwrap();
        let rows: Vec<(String, String, String, Option<String>)> = {
            let mut stmt = dst
                .prepare(
                    "SELECT id, content, created_at, born_device FROM item_comment \
                     WHERE item_id = ?1 ORDER BY content",
                )
                .unwrap();
            let it = stmt
                .query_map([&new_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap();
            it.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1, "第一句");
        assert_eq!(rows[0].2, src_ts, "created_at 保留原时刻(史实)");
        assert_eq!(rows[0].3, None, "搬过空间的留言作者未知——绝不署搬运工的名");
        assert!(pkg.comments.iter().all(|old| rows.iter().all(|(nid, ..)| nid != &old.id)), "留言换新 id");
        // 可信写入语境不许泄漏出那一段。
        let flag: i64 =
            dst.query_row("SELECT COUNT(*) FROM sync_replay_active", [], |r| r.get(0)).unwrap();
        assert_eq!(flag, 0, "可信语境必须在同一事务内清干净");
        // 因果序:comment create 晚于 item create。
        let item_hlc = ops_for(&dst, "item", &new_id)[0].hlc.clone();
        for (cid, ..) in &rows {
            let c_hlc = ops_for(&dst, "comment", cid)[0].hlc.clone();
            assert!(item_hlc < c_hlc, "comment create 必须晚于宿主 create");
        }
        // 目标库自洽:电池过(留言有 op 背书、行与 payload 逐字相等)。
        crate::sync::boot::strict_battery(&dst).expect("目标库电池必须过");

        assert!(matches!(finalize_source(&mut src, &mut sc, &pkg).unwrap(), FinalizeOutcome::Deleted));
        let left: i64 =
            src.query_row("SELECT COUNT(*) FROM item_comment", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "源留言随宿主 CASCADE 消失");
    }

    /// H1 的留言版:导出后源端**新增或删除留言** → 指纹重验命中差异 → 拒删,零 tombstone。
    /// (留言进指纹这件事,正是「全字段精确比对」设计的收益 —— 不必给它单开一道守卫。)
    #[test]
    fn changing_comments_after_export_blocks_finalize() {
        let (mut src, mut sc) = fresh_db("cmt-h1");
        let id = notes::capture(&mut src, &mut sc, "原文").unwrap();
        let c1 = crate::comments::add(&mut src, &mut sc, &id, "原留言").unwrap();

        let pkg = export_ready(&mut src, &id);
        crate::comments::add(&mut src, &mut sc, &id, "导出后新增的").unwrap();
        let before = oplog_rows(&src);
        match finalize_source(&mut src, &mut sc, &pkg).unwrap() {
            FinalizeOutcome::Kept { reason } => assert!(reason.contains("被改动"), "{reason}"),
            _ => panic!("留言新增必须拒删"),
        }
        assert_eq!(oplog_rows(&src), before, "拒删不发任何 op");

        // 删除方向同样命中。
        let pkg2 = export_ready(&mut src, &id);
        crate::comments::remove(&mut src, &mut sc, &c1).unwrap();
        assert!(matches!(
            finalize_source(&mut src, &mut sc, &pkg2).unwrap(),
            FinalizeOutcome::Kept { .. }
        ));
    }

    /// 结构锚(identity-plan §4.2,设计审三轮 M1;判据形由 codex 实现审二弹 M2 改准):
    /// 可信写入语境**窄**这件事不能靠纪律。
    ///
    /// # 为什么是「整段白名单」而不是「黑名单 + 计数」
    ///
    /// 上一版判据是「`execute(` 恰三次 + 必含三个串 + 六个禁用词不出现 + 清旗早于 `res?`」。
    /// codex 当场给出一行**能编译、能扩大可信区、且过全部断言**的写法:
    ///
    /// ```ignore
    /// tx.execute_batch("UPDATE items SET position = NULL WHERE stage = 'todo'")
    ///     .map_err(|e| e.to_string())?;
    /// ```
    ///
    /// `execute_batch(` 不计进 `execute(` 的三次,也不含任何禁用词。一个本地 helper
    /// `widen_scope(&tx)?` 同理。**有限黑名单证不出「只有这三条 SQL」** —— 而这里是安全
    /// 边界,不是风格偏好。所以改成:把整只函数体规范化(剔注释 + 折空白)之后与一份
    /// 逐字白名单比。**格式一动就红是刻意的代价**(memory `text-anchor-cannot-guard-a-type`
    /// 的反面用法:文本锚该守的是接线事实,而这里的接线事实就是「这一段一个字都不许多」)。
    #[test]
    fn move_item_trusted_region_is_narrow() {
        let body = normalize_src(&fn_body(SELF_SRC, "fn insert_moved_comment_rows"));
        const EXPECT: &str = "{ tx.execute(\"INSERT INTO sync_replay_active (flag) VALUES (1)\", []) \
.map_err(|e| format!(\"进入可信写入语境失败:{e}\"))?; let res = (|| -> Result<(), String> { for r in rows { \
tx.execute( \"INSERT INTO item_comment (id, item_id, content, created_at, born_device) \\ \
VALUES (?1, ?2, ?3, ?4, NULL)\", (r.id, r.item_id, r.content, r.created_at), ) \
.map_err(|e| format!(\"目标空间留言落行失败:{e}\"))?; } Ok(()) })(); \
tx.execute(\"DELETE FROM sync_replay_active\", []) \
.map_err(|e| format!(\"退出可信写入语境失败:{e}\"))?; res?; Ok(tx) }";
        assert_eq!(
            body, EXPECT,
            "\n可信区一个字都不许多。真要改这一段,先想清楚它是安全边界,再同步改这份白名单。\n\
             实际:\n{body}\n期待:\n{EXPECT}"
        );

        // 白名单只钉得住**这只函数**。安全边界还有两处在它外面(二轮 M1):
        // ① 进出旗的 SQL 若抽成常量,改常量就能绕 —— 已内联,由上面那份白名单一起钉住;
        // ② **调用点**:另写一只 `insert_moved_comment_rows_wide` 去调,现有白名单照绿。
        // 所以这里钉死:生产段里这个名字**恰好出现两次**(定义 + 唯一调用点),且那次
        // 调用逐字就是这一句。
        // ⚠ 判据按**代码行**看,不做全文 substring(codex 三轮 M1):`production_src` 只剔
        // `//`,块注释里塞一句假的调用照样能把 substring 与计数一起喂饱 ——
        // ```ignore
        // /*
        // let tx = insert_moved_comment_rows(tx, &rows)?;
        // */
        // let tx = trusted_insert_wide(tx, &rows)?;   // 真正跑的是这一句
        // ```
        // 所以:生产段先禁块注释,再取「含这个名字的代码行」,要求恰是定义行 + 那一句调用。
        let prod = production_src();
        assert!(
            !prod.contains("/*"),
            "生产段不许出现块注释 —— 它能把下面这条按行取的判据整段藏起来"
        );
        let hits: Vec<&str> =
            prod.lines().map(str::trim).filter(|l| l.contains("insert_moved_comment_rows")).collect();
        assert_eq!(
            hits,
            // 文件里调用点在前、定义在后(import 那个原语排在 helper 之上)。
            vec![
                "let tx = insert_moved_comment_rows(tx, &rows)?;",
                "fn insert_moved_comment_rows<'c>(",
            ],
            "生产段里这个名字只许出现在两行:唯一调用点(事务所有权在那里交接)+ 定义行"
        );
    }

    /// 本文件的**生产段**(剔掉 `#[cfg(test)] mod tests`,否则测试自己写的字面量会命中)。
    fn production_src() -> String {
        let cut = SELF_SRC.find("#[cfg(test)]").expect("测试段起点");
        strip_line_comments(&SELF_SRC[..cut])
    }

    /// 规范化源码:剔行注释(`fn_body` 已做)+ 把连续空白折成单空格 + 去首尾空白。
    fn normalize_src(s: &str) -> String {
        s.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// 结构锚(设计审二轮 M4 + 三轮 L1):指纹**逐行读、当行 hash、当行释放**。
    ///
    /// 等价回归只能证明「语义没漂」,证不了「逐行释放」——那一格只有源码形状锚守得住
    /// (三轮明确**不建议**拿真实 RSS / 分配峰值当判据:平台噪声大、真机容易飘)。
    #[test]
    fn fingerprint_reads_are_streaming() {
        let fp = fn_body(SELF_SRC, "fn read_fingerprint");
        assert!(!fp.contains("read_images"), "重验指纹不许整批读图:\n{fp}");
        assert!(!fp.contains("read_comments"), "重验指纹不许整批读正文:\n{fp}");
        assert!(fp.contains("image_digests") && fp.contains("comment_digests"), "{fp}");
        for f in ["fn image_digests", "fn comment_digests"] {
            let body = fn_body(SELF_SRC, f);
            assert!(body.contains("while let Some(row)"), "{f} 必须逐行游标:\n{body}");
            // 打的是**整批读**的形状标志:`query_map(..).collect()` 会把每行(含 BLOB /
            // 正文)先攒成 `Vec` 再 map。⚠ 判据别写成「不许出现 `.collect`」——首版就是
            // 这么写的,当场命中了把 hash 转 hex 的那句 `.map(..).collect()`,**挑错了要
            // 打的那一句**(mutation-check 那张表里的同款)。
            assert!(!body.contains("query_map"), "{f} 不许整批读进 Vec:\n{body}");
        }
    }

    /// 本文件源码(结构锚的输入)。
    const SELF_SRC: &str = include_str!("move_item.rs");

    /// 取一个函数的**函数体文本**,并**剔掉行注释**(注释里天然含被禁的词)。
    /// 起点 = 该签名之后第一个 `{`;终点 = 花括号配平处。
    fn fn_body(src: &str, sig: &str) -> String {
        let start = src.find(sig).unwrap_or_else(|| panic!("找不到 {sig}"));
        let open = src[start..].find('{').expect("函数体起点") + start;
        let bytes = src.as_bytes();
        let (mut depth, mut i) = (0i32, open);
        while i < bytes.len() {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        strip_line_comments(&src[open..=i])
    }

    /// 剔掉行注释(注释里天然含被禁 / 被数的词)。
    fn strip_line_comments(src: &str) -> String {
        src.lines()
            .map(|l| match l.find("//") {
                Some(p) => &l[..p],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
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

    // ---- codex 实现审二弹的四条(H1 / M2 两枚行为锚 / M3 等价回归) ------------------

    /// **H1**:三相位峰值账的每一项都独立可判。
    ///
    /// 五格,各自只动一个自变量:①最大单图 ②子实体条数(极短留言)③**最大单条留言**
    /// 也进 scratch ④**标签标题**按真实字节精确计入(二轮抓出的大头:1000 个 200 KiB
    /// 标题挂在无图无留言的条目上,旧公式算出来接近于零)⑤`item_topic` **条数**也进准备金。
    #[test]
    fn move_peak_bytes_accounts_every_phase() {
        let (mut c, mut k) = fresh_db("peak");
        // 三相位账**在测试里重写一遍**(不调生产那份):生产改了而这份没改就当场红。
        // 参数即「这条目的原始事实」,由每个用例自己数出来,不从被测代码取。
        #[allow(clippy::too_many_arguments)]
        fn expect(
            item: i64,
            img_sum: i64,
            img_max: i64,
            img_n: i64,
            cmt_sum: i64,
            cmt_max: i64,
            cmt_n: i64,
            title_sum: i64,
            link_n: i64,
            json_max: i64,
        ) -> i64 {
            let p = item + img_sum + cmt_sum + title_sum;
            let q = item + title_sum;
            let s = img_max.max(cmt_max);
            let m = (img_n + cmt_n + link_n) * MOVE_CHILD_METADATA_BYTES;
            let base = p + q + m;
            (base + s).max(base + json_max).max(base + q + s)
        }
        // `json_quote` 对**无需转义**的串 = 原文 + 两个引号;要转义的另算(见 ⑥)。
        let jq = |n: i64| n + (n + 2);

        // ⓪ 只有正文:三幕里 **import 最高**(item 正文的 Value + 序列化串同时活着)——
        // 这一格顺带证「finalize 恒最高」是错的(四轮 L1)。
        let z = notes::capture(&mut c, &mut k, "甲").unwrap();
        assert_eq!(move_peak_bytes(&c, &z).unwrap(), expect(3, 0, 0, 0, 0, 0, 0, 0, 0, jq(3)));

        // ① 最大单图:同样 40,000 字节的图,一张 vs 两张 —— scratch 与准备金各自动一格。
        let a = notes::capture(&mut c, &mut k, "乙").unwrap();
        images::attach(&mut c, &mut k, &a, &vec![7u8; 40_000], "image/png").unwrap();
        let b = notes::capture(&mut c, &mut k, "丙").unwrap();
        images::attach(&mut c, &mut k, &b, &vec![7u8; 20_000], "image/png").unwrap();
        images::attach(&mut c, &mut k, &b, &vec![7u8; 20_000], "image/png").unwrap();
        assert_eq!(
            move_peak_bytes(&c, &a).unwrap(),
            expect(3, 40_000, 40_000, 1, 0, 0, 0, 0, 0, jq(3))
        );
        assert_eq!(
            move_peak_bytes(&c, &b).unwrap(),
            expect(3, 40_000, 20_000, 2, 0, 0, 0, 0, 0, jq(3))
        );

        // ② 子实体条数:20 条极短留言,包体几乎不长而准备金 +20×512
        //(协议上没有留言条数硬闸,这一项就是那条路的闸)。
        let d = notes::capture(&mut c, &mut k, "丁").unwrap();
        for _ in 0..20 {
            crate::comments::add(&mut c, &mut k, &d, "短").unwrap();
        }
        assert_eq!(
            move_peak_bytes(&c, &d).unwrap(),
            expect(3, 0, 0, 0, 60, 3, 20, 0, 0, jq(3))
        );

        // ③ 最大单条留言进 scratch,也进 import 那一幕的 json 候选。
        crate::comments::add(&mut c, &mut k, &d, &"长".repeat(1_000)).unwrap(); // 3000 字节
        assert_eq!(
            move_peak_bytes(&c, &d).unwrap(),
            expect(3, 0, 0, 0, 3_060, 3_000, 21, 0, 0, jq(3_000))
        );

        // ④⑤ 标签:标题按真实字节精确计(包体一份 + 指纹一份 + finalize 再一份),
        // 关联数进准备金。二轮抓出的大头就是这一格 —— 旧公式对它算出来接近于零。
        // **挂两个标签**(四轮 L2):只挂一个的话「link_n」与「有没有标题」分不开。
        let e = notes::capture(&mut c, &mut k, "戊").unwrap();
        notes::file_to_topic(&mut c, &mut k, &e, None, Some(&"标".repeat(2_000))).unwrap(); // 6000
        notes::file_to_topic(&mut c, &mut k, &e, None, Some(&"签".repeat(1_000))).unwrap(); // 3000
        assert_eq!(
            move_peak_bytes(&c, &e).unwrap(),
            expect(3, 0, 0, 0, 0, 0, 0, 9_000, 2, jq(6_000))
        );

        // ⑥ **要转义的正文**(四轮 L2):`json_quote` 会把每个 `"` 变成两个字节,于是
        // 序列化那一份比原文还长 —— 只用中文正文的话这一支永远不会被走到。
        let f = notes::capture(&mut c, &mut k, "己").unwrap();
        crate::comments::add(&mut c, &mut k, &f, &"\"".repeat(100)).unwrap();
        // 原文 100 字节;json_quote = 两个包裹引号 + 100 个 `\"` = 202。
        assert_eq!(
            move_peak_bytes(&c, &f).unwrap(),
            expect(3, 0, 0, 0, 100, 100, 1, 0, 0, 100 + 202)
        );
    }

    /// **M2 行为锚一**:可信区里第二条留言落行失败 → 整笔无半态。
    ///
    /// 结构锚证的是「这一段代码长什么样」,这一条证的是「它真的这么跑」:目标库里
    /// item / image / topic / comment / oplog **全不留**,`sync_replay_active` 也不留。
    #[test]
    fn a_failed_comment_row_leaves_no_half_state() {
        let (mut src, mut sc) = fresh_db("half-src");
        let (mut dst, mut dc) = fresh_db("half-dst");
        let id = notes::capture(&mut src, &mut sc, "带两条留言").unwrap();
        images::attach(&mut src, &mut sc, &id, &vec![9u8; 16], "image/png").unwrap();
        crate::comments::add(&mut src, &mut sc, &id, "第一条").unwrap();
        crate::comments::add(&mut src, &mut sc, &id, "第二条").unwrap();

        let mut pkg = export_ready(&mut src, &id);
        assert_eq!(pkg.comments.len(), 2);
        // 把第二条的时间弄成非 24 字节 —— 撞列 CHECK,落行在**循环中途**失败。
        pkg.comments[1].created_at = "坏时间".into();

        let before_ops = oplog_rows(&dst);
        let err = import(&mut dst, &mut dc, &pkg).expect_err("第二条落行失败,整笔必须回滚");
        assert!(err.contains("留言落行失败"), "{err}");
        for (label, sql) in [
            ("items", "SELECT COUNT(*) FROM items"),
            ("item_image", "SELECT COUNT(*) FROM item_image"),
            ("item_comment", "SELECT COUNT(*) FROM item_comment"),
            ("可信语境标志", "SELECT COUNT(*) FROM sync_replay_active"),
        ] {
            let n: i64 = dst.query_row(sql, [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{label} 不许留下半态");
        }
        assert_eq!(oplog_rows(&dst), before_ops, "一条 op 都不许留");
    }

    /// **M2 行为锚二**:可信语境**只在那几行里**开着 —— 导入前后各试一条「只有开着旗才
    /// 穿得过」的非法写入,都必须失败。
    #[test]
    fn the_trusted_flag_is_not_open_before_or_after_import() {
        let (mut src, mut sc) = fresh_db("flag-src");
        let (mut dst, mut dc) = fresh_db("flag-dst");
        let id = notes::capture(&mut src, &mut sc, "宿主").unwrap();
        crate::comments::add(&mut src, &mut sc, &id, "一条").unwrap();
        let pkg = export_ready(&mut src, &id);

        // 只有开着旗才插得进去的行:born_device 为 NULL 的条目。
        let illegal = |conn: &Connection, iid: &str| -> String {
            conn.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, position, \
                                    born_stage, born_device) \
                 VALUES (?1, 'x', 'inbox', '2026-08-07T12:00:00.000Z', \
                         '2026-08-07T12:00:00.000Z', 'a0', 'inbox', NULL)",
                [iid],
            )
            .expect_err("非可信语境下 NULL 署名必须 ABORT")
            .to_string()
        };
        assert!(illegal(&dst, "01FLAGBEFORE00000000000000").contains("出生设备"));
        import(&mut dst, &mut dc, &pkg).unwrap();
        assert!(illegal(&dst, "01FLAGAFTER000000000000000").contains("出生设备"));
    }

    /// **M3**:流式摘要与「整批读」的参考实现**逐字段相等**。
    ///
    /// export 与 finalize 共用同一个新实现,那只能证明「两边一起错时仍相等」;要证新实现
    /// 与旧语义相同,得在测试里保留一份 eager 参考算法对拍。覆盖:多张图不同 seq/mime/
    /// 长度、**零字节**图、空集合、以及留言那一路。
    #[test]
    fn digests_match_the_eager_reference() {
        let (mut c, mut k) = fresh_db("digest-eq");
        let id = notes::capture(&mut c, &mut k, "对拍").unwrap();
        // 空集合先对一次。
        assert_eq!(image_digests(&c, &id).unwrap(), eager_image_digests(&c, &id));
        assert_eq!(comment_digests(&c, &id).unwrap(), eager_comment_digests(&c, &id));

        // 「零字节图」造不出来:`images::attach` 自己就拒空字节(有下界闸)。含 NUL 与
        // 0xFF 的二进制由下面那张覆盖 —— 那才是「hash 输入别被当字符串处理」要防的东西。
        images::attach(&mut c, &mut k, &id, &[0u8], "image/png").unwrap();
        images::attach(&mut c, &mut k, &id, &[0u8, 255, 7], "image/jpeg").unwrap();
        images::attach(&mut c, &mut k, &id, &vec![3u8; 5_000], "image/png").unwrap();
        crate::comments::add(&mut c, &mut k, &id, "一").unwrap();
        crate::comments::add(&mut c, &mut k, &id, &"长".repeat(3_000)).unwrap();

        let streamed = image_digests(&c, &id).unwrap();
        assert_eq!(streamed.len(), 3);
        assert_eq!(streamed, eager_image_digests(&c, &id), "图摘要与 eager 参考实现必须逐字段相等");
        let cs = comment_digests(&c, &id).unwrap();
        assert_eq!(cs.len(), 2);
        assert_eq!(cs, eager_comment_digests(&c, &id), "留言摘要同上");
    }

    /// eager 参考实现:整批读进 `Vec` 再 map(**故意**用被生产侧禁掉的写法)。
    fn eager_image_digests(conn: &Connection, item_id: &str) -> Vec<(String, i64, String, i64, String)> {
        let mut stmt = conn
            .prepare("SELECT id, seq, mime, data FROM item_image WHERE item_id = ?1 ORDER BY seq")
            .unwrap();
        let rows: Vec<(String, i64, String, Vec<u8>)> = stmt
            .query_map([item_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        rows.into_iter()
            .map(|(id, seq, mime, data)| {
                let sha = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
                (id, seq, mime, data.len() as i64, sha)
            })
            .collect()
    }

    fn eager_comment_digests(conn: &Connection, item_id: &str) -> Vec<(String, String, i64, String)> {
        let mut stmt = conn
            .prepare("SELECT id, created_at, content FROM item_comment WHERE item_id = ?1 ORDER BY id")
            .unwrap();
        let rows: Vec<(String, String, String)> = stmt
            .query_map([item_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        rows.into_iter()
            .map(|(id, created_at, content)| {
                let sha = Sha256::digest(content.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
                (id, created_at, content.len() as i64, sha)
            })
            .collect()
    }

    /// **M3 的另一半**:导出之后动留言(增 / 删 / 改正文)—— finalize 一律拒删源。
    #[test]
    fn finalize_refuses_when_comments_changed_after_export() {
        for how in ["add", "remove", "edit"] {
            let (mut src, mut sc) = fresh_db(&format!("fin-{how}"));
            let id = notes::capture(&mut src, &mut sc, "宿主").unwrap();
            let cid = crate::comments::add(&mut src, &mut sc, &id, "原文").unwrap();
            let pkg = export_ready(&mut src, &id);
            match how {
                "add" => {
                    crate::comments::add(&mut src, &mut sc, &id, "后加的").unwrap();
                }
                "remove" => crate::comments::remove(&mut src, &mut sc, &cid).unwrap(),
                // 留言不可编辑(触发器挡 UPDATE),故「改正文」只能在可信语境下伪造 ——
                // 这一支验的是指纹字段选得够不够,不是生产可达路径。
                _ => {
                    src.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
                    src.execute("DELETE FROM item_comment WHERE id = ?1", [&cid]).unwrap();
                    src.execute(
                        "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
                         VALUES (?1, ?2, '改过了', '2026-08-07T12:00:00.000Z', NULL)",
                        (&cid, &id),
                    )
                    .unwrap();
                    src.execute("DELETE FROM sync_replay_active", []).unwrap();
                }
            }
            match finalize_source(&mut src, &mut sc, &pkg).unwrap() {
                FinalizeOutcome::Kept { reason } => assert!(reason.contains("被改动"), "{reason}"),
                FinalizeOutcome::Deleted => panic!("{how}:导出后留言变了,竟把源删了"),
                FinalizeOutcome::AlreadyGone => panic!("{how}:源不该已消失"),
            }
        }
    }
}
