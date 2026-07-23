//! 纪元切换(epoch-plan,2a):`compact` 纪元压实 + `certify` 干净空间认证。
//!
//! **压实是显式命令,不是自动迁移**(§2.1):只允许在每空间恰一台设备(锚点 = 该
//! 空间的完整副本源)上执行一次——做成迁移则每台设备各自压实,同 origin 同 seq 长出
//! 不同 op = 制造分叉。壳层以显式命令接线(桌面即可;安卓库要么经 certify 认证、
//! 要么清库重配)。
//!
//! **纪元隔离不变量**(§1,全案安全支点;仅适用于发生 compact 的脏空间):切换完成
//! 时旧纪元的全部设备身份(含锚点自己)吊销、K_acc 已轮换,新纪元只含切换后新生的
//! 身份与新钥;服务器零持久 op、账户信箱清空 ⇒ 任何切换前的库副本/备份/漏网设备
//! **鉴权过不了、旧密文解不进新纪元**。分叉冻结与 quarantine 只是纵深,不是第一道墙。
//!
//! **压实分两型**(§2.1,sync_meta 配置契约「四键全空或全有」,不许造半配置态):
//!   * `Configured`(已配置空间,runbook §8 主路):消费已注册的 pending 身份
//!     (两阶段状态机 Prepared→Registered,transport::register_pending_identity),
//!     轮换 device_id / device_key / **k_acc**(恶意服务器存旧密文重放在新钥下解密
//!     即失败,§2.5)、last_pushed := 0;恢复码随 k_acc 作废,**必须重走仪式**。
//!   * `Unconfigured`(legacy 库尚无账户,create_account 认证不过时的无损压实路,
//!     §3.5):只轮换本地 device_id + 重建 oplog + 落 epoch=2,配置四元组保持全空。
//!
//! **基线合成 = 状态 → op**(§2.3):现值快照 create(+archived_at/sealed_at 各补一条
//! set)/ link_add / image_add(sha256 对现存字节现算);墓碑不带入(隔离不变量下无
//! 旧 op 可复活);`born_stage: null` 是协议正式词汇(pre-0018「未知不回填」史实);
//! item_image_counter / item_revisions **原样保留**(§1 第 2/3 条:洞由 counter 表
//! 承载、编辑历史各端本地生长)。取号不复用 `oplog::append`(它固定查写 oplog 本表)
//! ——本模块用 staging writer 顺序发号 1..m,HLC 由重载后的新身份时钟连续取。
//!
//! **自验收**(§2.6,事务内做完才 commit):压实后的库要能通过「新设备引导它的快照
//! 时要过的全部严格审计」——对自己跑 boot::strict_battery(单一来源);另加终态等价
//! (七表逐行相等 + sync_meta 白名单外逐键不变)与 schema 同构三层证明(单一 DDL
//! 常量 + 规范化 sqlite_schema 比对 + 负例功能探针——`table_xinfo` 系 pragma 看不见
//! CHECK 与生成列表达式,必须真比 DDL、真插负例)。

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use ulid::Ulid;

use crate::clock::Clock;
use crate::db;
use crate::sync::boot;
use crate::sync::crypto;

/// oplog 表的**单一 DDL 构造源**(§2.6.7 第一层;与 **0028** 迁移文本**逐字同源,含语句
/// 内注释**——sqlite_schema 保存的是语句原文,任何漂移都会被下方「规范化 sqlite_schema
/// 比对」在压实现场拒绝,不是靠人眼对齐。首跑就抓到过:常量少了迁移里的两段行内注释,
/// 比对当场红——这正是比对该有的灵敏度,修法是把常量对齐迁移原文,不是放松比对)。
const OPLOG_TABLE_DDL: &str = "CREATE TABLE {name} (
    op_id      TEXT NOT NULL PRIMARY KEY,
    hlc        TEXT NOT NULL,
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    -- 源设备发射序号,每 origin 从 1 连续编;远端 op 原样入库(连续性由收端引擎的
    -- 严格连续应用保证,sync-protocol §5.3)。
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 1),
    -- 来源设备,从 hlc 定长编码内嵌处派生(第 24 字符起),虚拟列不落存储。
    origin     TEXT GENERATED ALWAYS AS (substr(hlc, 24)) VIRTUAL,
    CHECK (
        (entity IN ('item', 'topic') AND kind IN ('create', 'set_field', 'tombstone'))
        OR (entity = 'link' AND kind IN ('link_add', 'link_remove'))
        OR (entity = 'image' AND kind IN ('image_add', 'image_tombstone'))
        -- 空间 profile 单例寄存器(space-name-sync-plan §3):无 create、无 tombstone。
        OR (entity = 'space' AND kind = 'set_field')
    )
)";

/// oplog 的索引与触发器 DDL(0024 同源;重建后逐条执行)。
const OPLOG_AUX_DDL: &[&str] = &[
    "CREATE UNIQUE INDEX idx_oplog_hlc ON oplog (hlc)",
    "CREATE INDEX idx_oplog_entity ON oplog (entity, entity_id)",
    "CREATE UNIQUE INDEX idx_oplog_origin_seq ON oplog (origin, origin_seq)",
    "CREATE TRIGGER trg_oplog_immutable
BEFORE UPDATE ON oplog
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'op 是史实,不可改写')\u{3b}
END",
    "CREATE TRIGGER trg_oplog_no_delete
BEFORE DELETE ON oplog
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'op 是史实,不可删除')\u{3b}
END",
];

/// 0019 设备身份冻结触发器(轮换时 drop → UPDATE → 原文重建;`no_delete` 不动)。
const DEVICE_ID_FROZEN_DDL: &str = "CREATE TRIGGER trg_sync_meta_device_id_frozen
BEFORE UPDATE ON sync_meta
FOR EACH ROW
WHEN OLD.key = 'device_id'
BEGIN
    SELECT RAISE(ABORT, '设备身份不可改写')\u{3b}
END";

/// 压实类型(§2.1)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactKind {
    /// 已配置空间:消费 pending 身份、轮换 device_id/device_key/k_acc、last_pushed=0。
    Configured,
    /// 未配置 legacy 库:仅轮换本地 device_id,配置四元组保持全空。
    Unconfigured,
}

/// 压实结果(壳层拿它走新恢复码仪式与时钟/传输重载)。
#[derive(Debug)]
pub struct CompactReport {
    pub kind: CompactKind,
    pub new_device_id: String,
    /// Configured 才有:随新 k_acc 派生的新恢复码——**旧恢复码自此作废,UI 必须
    /// 强制重走展示 + 回输核对仪式**(§2.5)。
    pub recovery_code: Option<String>,
    /// 基线 op 条数(m)。
    pub baseline_ops: usize,
}

/// 干净空间认证(§3.4):对 0024 后新建、天生纪元干净的空间**不跑 compact**(多设备
/// 干净空间重写账本会无谓触发身份轮换/全端重配)——WriterLease 下单事务跑严格电池,
/// 全过零改动零重配、落 `epoch=2`(审计与落标同事务,无 TOCTOU);不过 → 报告哪条脏
/// (该空间才需 compact)。调用方契约:持本空间 WriterLease、transport 已停。
pub fn certify(conn: &mut Connection) -> Result<(), String> {
    ensure_current_schema(conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    boot::strict_battery(&tx)?;
    meta_upsert(&tx, "epoch", "2")?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 本库是否已通过纪元认证(诊断标记;**真相恒是严格电池本身**,§2.3——供货闸
/// [§3.3,工序5] 现场重跑电池,不只看这枚 KV)。
pub fn epoch_certified(conn: &Connection) -> Result<bool, String> {
    Ok(meta_get(conn, "epoch")?.as_deref() == Some("2"))
}

/// 纪元压实(§2)。调用方契约(前置断言不过响亮拒):持本空间 WriterLease、transport
/// 已停(无并发写者/推流);Configured 型另要求 pending 身份处于 Registered 态且旧
/// 锚点身份已在服务器吊销(runbook §8 工序 5,服务器侧事实、本地无从验证)。
/// 成功后调用方**必须**重载 Clock / 重建 Engine(身份已换)。
///
/// 文档化限制(实现审 L2 裁决):Unconfigured 型的新 device_id 只是 `Ulid::new()`,
/// **不过跨空间唯一闸**——core 在这里没有壳上下文。下游机械兜底:桌面壳启动装配的
/// 身份四不变量裁决对撞身份打 Soft veto(停同步、本地照用,fail-closed 不可绕);
/// 撞上了的恢复 = 创号前再执行一次 Unconfigured 压实换新 ID。ULID 随机碰撞概率 +
/// 机械停用兜底,风险降为 L。
pub fn compact(conn: &mut Connection) -> Result<CompactReport, String> {
    compact_inner(conn, None)
}

/// 故障注入点(§3.6 DDL 故障注入测试:任一点失败 → 全量回滚,旧 ID/旧 key/旧触发器/
/// 旧 oplog 完整还原)。
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailPoint {
    AfterTriggerDrop,
    AfterIdentityUpdate,
    BeforeOplogRebuild,
    AfterOplogRebuild,
}

#[cfg(test)]
#[allow(dead_code)] // 工序4 收尾的 DDL 故障注入测试消费(§3.6)
pub(crate) fn compact_with_failpoint(
    conn: &mut Connection,
    fp: FailPoint,
) -> Result<CompactReport, String> {
    compact_inner(conn, Some(fp))
}

#[cfg(not(test))]
type FailPointOpt = Option<std::convert::Infallible>;
#[cfg(test)]
type FailPointOpt = Option<FailPoint>;

#[cfg(test)]
fn hit(fp: &FailPointOpt, at: FailPoint) -> Result<(), String> {
    if *fp == Some(at) {
        return Err(format!("故障注入:{at:?}"));
    }
    Ok(())
}
#[cfg(not(test))]
#[allow(dead_code)] // 注入点只在测试构型下被调用
fn hit(_fp: &FailPointOpt, _at: ()) -> Result<(), String> {
    Ok(())
}

fn compact_inner(conn: &mut Connection, fp: FailPointOpt) -> Result<CompactReport, String> {
    #[cfg(not(test))]
    let _ = &fp;
    // ---- 前置断言(§2.1,事务外的快速响亮) ----
    ensure_current_schema(conn)?;
    let verdict: String = conn
        .pragma_query_value(None, "integrity_check", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if verdict != "ok" {
        return Err(format!("压实前 integrity_check 不过:{verdict},先修库"));
    }
    let missing = crate::sync::transport::pending_blob_count(conn)?;
    if missing > 0 {
        return Err(format!("压实前有 {missing} 张图缺字节:先在线补齐(压实丢弃死 add,缺字节图会永失)"));
    }

    // ---- 分型(§2.1:配置四元组全空或全有;partial = 库不可加载级别的损坏) ----
    let cfg = [
        meta_get(conn, "account_id")?,
        meta_get(conn, "k_acc")?,
        meta_get(conn, "device_key")?,
        meta_get(conn, "server_url")?,
    ];
    let configured = match cfg.iter().filter(|v| v.is_some()).count() {
        4 => true,
        0 => false,
        n => return Err(format!("sync_meta 配置键残缺({n}/4):不是合法库状态,拒绝压实")),
    };
    let pending_id = meta_get(conn, "pending_device_id")?;
    let pending_seed = meta_get(conn, "pending_device_key")?;
    let pending_pub = meta_get(conn, "pending_pubkey")?;
    let pending_state = meta_get(conn, "pending_state")?;
    let (new_device_id, new_seed_hex) = if configured {
        // Configured:消费两阶段 pending 身份(§2.2)。
        if pending_state.as_deref() != Some("registered") {
            return Err(
                "已配置空间的压实必须先完成新身份预注册(Prepared→Registered),再离线压实——\
                 当前 pending 身份不在 Registered 态"
                    .into(),
            );
        }
        let (Some(id), Some(seed_hex), Some(pub_hex)) = (pending_id, pending_seed, pending_pub)
        else {
            return Err("pending 身份材料残缺(有状态无材料),拒绝压实".into());
        };
        // 核验 seed 派生公钥 == 注册时存档的公钥(§2.2:消费 bundle 时的完整性锚)。
        let seed = unhex32(&seed_hex)?;
        let derived = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        if hex(&derived) != pub_hex {
            return Err("pending 种子派生的公钥与注册存档不符(材料损坏),拒绝压实".into());
        }
        if !sync_proto::is_ulid(&id) {
            return Err(format!("pending device_id 不是规范 ULID:{id}"));
        }
        (id, Some(seed_hex))
    } else {
        // Unconfigured:无服务器前置、无 pending 状态机(§2.1)。四键任一残留都拒
        // (M2:孤立的 seed/pubkey 也是状态机被绕过的痕迹,fail-closed 不挑着看)。
        if pending_state.is_some()
            || pending_id.is_some()
            || pending_seed.is_some()
            || pending_pub.is_some()
        {
            return Err("未配置库不该有 pending 身份(状态残留),拒绝压实".into());
        }
        (Ulid::new().to_string(), None)
    };
    let old_device_id =
        meta_get(conn, "device_id")?.ok_or_else(|| "sync_meta 缺 device_id".to_string())?;
    if new_device_id == old_device_id {
        return Err("新 device_id 与旧身份相同(必是 bug),拒绝压实".into());
    }

    // ---- 单事务:轮换身份 → 合成基线 → 重建 oplog → 自验收 → commit ----
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // §2.6.6 终态等价的「前」快照:六表指纹 + sync_meta 全量。
    let pre_tables = table_fingerprints(&tx)?;
    let pre_meta = meta_all(&tx)?;
    // §2.6.7 第二层:oplog 的规范化 schema(表 + 索引 + 触发器),重建前后必须相等。
    let pre_schema = oplog_schema_normalized(&tx)?;

    // 设备身份轮换(§2.2):0019 冻结触发器 drop → UPDATE → 原文重建(no_delete 不动);
    // SQLite DDL 事务性,任一步失败整体回滚。
    tx.execute("DROP TRIGGER trg_sync_meta_device_id_frozen", []).map_err(|e| e.to_string())?;
    #[cfg(test)]
    hit(&fp, FailPoint::AfterTriggerDrop)?;
    tx.execute("UPDATE sync_meta SET value = ?1 WHERE key = 'device_id'", [&new_device_id])
        .map_err(|e| e.to_string())?;
    #[cfg(test)]
    hit(&fp, FailPoint::AfterIdentityUpdate)?;
    tx.execute(DEVICE_ID_FROZEN_DDL, []).map_err(|e| e.to_string())?;

    let mut recovery_code = None;
    let mut new_k_acc_hex = None;
    if configured {
        // K_acc 轮换(§2.5):恶意服务器存过的旧 to:"*" 密文在新钥下解密即失败——
        // 重放承诺以更强形式恢复;恢复码随之作废,壳层必须强制重走仪式。
        let mut k_acc = [0u8; 32];
        use chacha20poly1305::aead::rand_core::RngCore;
        chacha20poly1305::aead::OsRng.fill_bytes(&mut k_acc);
        let k_hex = hex(&k_acc);
        meta_upsert(&tx, "k_acc", &k_hex)?;
        new_k_acc_hex = Some(k_hex);
        meta_upsert(&tx, "device_key", new_seed_hex.as_deref().expect("Configured 必有"))?;
        meta_upsert(&tx, "last_pushed", "0")?;
        for k in ["pending_device_id", "pending_device_key", "pending_pubkey", "pending_state"] {
            tx.execute("DELETE FROM sync_meta WHERE key = ?1", [k]).map_err(|e| e.to_string())?;
        }
        let code = crypto::recovery_code(&k_acc);
        assert_eq!(crypto::parse_recovery_code(&code), Ok(k_acc), "恢复码编解必须互逆");
        recovery_code = Some(code);
    }
    meta_upsert(&tx, "epoch", "2")?;
    // 新纪元不许带着已满的隔离额度/闭合的 breaker 启动(§2.3 白名单)。
    tx.execute("DELETE FROM sync_quarantine", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sync_meta WHERE key = 'poison_breaker'", [])
        .map_err(|e| e.to_string())?;

    // 时钟以新身份重载(事务内局部对象;§2.2:commit 前不覆盖共享 Clock,成功后
    // 调用方强制整体重载)——全部基线 op 的 origin = 新 device_id。
    let mut clock = Clock::load(&tx)?;
    if clock.device_id() != new_device_id {
        return Err("轮换后时钟身份与新 device_id 不符(必是 bug),拒绝提交".into());
    }
    // M4(实现审):基线 HLC 必须严格高于旧账本全部 HLC——`last_hlc` 水位理应恒 ≥
    // MAX(oplog.hlc),但旧账本马上被整表丢弃,落后了事后电池无从发现;删前 observe
    // 旧最大值,把「基线在旧史实之上」从对水位的信任变成机械保证。
    let old_max: Option<String> =
        tx.query_row("SELECT MAX(hlc) FROM oplog", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if let Some(ref h) = old_max {
        clock.observe(&tx, &crate::clock::Hlc::parse(h)?)?;
    }

    // ---- 基线合成(§2.3:状态 → op,发射顺序即因果顺序) ----
    #[cfg(test)]
    hit(&fp, FailPoint::BeforeOplogRebuild)?;
    let baseline = synthesize_baseline(&tx)?;

    // ---- oplog 整表重建(0021/0022/0024 同手法;staging 与正式表同一 DDL 常量) ----
    tx.execute(&OPLOG_TABLE_DDL.replace("{name}", "oplog_new"), [])
        .map_err(|e| format!("建 staging oplog 失败:{e}"))?;
    {
        let mut ins = tx
            .prepare(
                "INSERT INTO oplog_new (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;
        for (i, (entity, entity_id, kind, payload)) in baseline.iter().enumerate() {
            let hlc = clock.tick(&tx)?; // 严格升序;last_hlc 随取号落盘(白名单键)。
            ins.execute(rusqlite::params![
                Ulid::new().to_string(),
                hlc.encode(),
                entity,
                entity_id,
                kind,
                payload.to_string(),
                (i + 1) as i64,
            ])
            .map_err(|e| format!("写基线 op 失败({entity}/{kind} {entity_id}):{e}"))?;
        }
    }
    tx.execute("DROP TABLE oplog", []).map_err(|e| e.to_string())?;
    tx.execute("ALTER TABLE oplog_new RENAME TO oplog", []).map_err(|e| e.to_string())?;
    for ddl in OPLOG_AUX_DDL {
        tx.execute(ddl, []).map_err(|e| format!("重建 oplog 索引/触发器失败:{e}"))?;
    }
    #[cfg(test)]
    hit(&fp, FailPoint::AfterOplogRebuild)?;

    // ---- 自验收(§2.6,全过才 commit) ----
    // 7. schema 同构:规范化 sqlite_schema 比对(第二层)+ 负例功能探针(第三层)。
    let post_schema = oplog_schema_normalized(&tx)?;
    if pre_schema != post_schema {
        return Err(format!(
            "压实自验收:oplog 重建前后 schema 不同构,拒绝提交。\n前:{pre_schema:?}\n后:{post_schema:?}"
        ));
    }
    schema_probes(&tx, &new_device_id)?;
    // 1-5. 严格电池(单一来源,boot 引导审计同一套)。
    boot::strict_battery(&tx)?;
    // 6. 终态等价:七表逐行逐字段与压实前相等;sync_meta 白名单外逐键不变。
    let post_tables = table_fingerprints(&tx)?;
    if pre_tables != post_tables {
        return Err("压实自验收:用户数据七表与压实前不相等(必是 bug),拒绝提交".into());
    }
    let post_meta = meta_all(&tx)?;
    let allowed: &[&str] = if configured {
        &[
            "device_id",
            "device_key",
            "k_acc",
            "last_hlc",
            "last_pushed",
            "pending_device_id",
            "pending_device_key",
            "pending_pubkey",
            "pending_state",
            "epoch",
            "poison_breaker",
        ]
    } else {
        &["device_id", "last_hlc", "epoch", "poison_breaker"]
    };
    for key in pre_meta.keys().chain(post_meta.keys()) {
        if allowed.contains(&key.as_str()) {
            continue;
        }
        if pre_meta.get(key) != post_meta.get(key) {
            return Err(format!(
                "压实自验收:sync_meta 白名单外的键「{key}」被改动(必是 bug),拒绝提交"
            ));
        }
    }
    if !configured {
        for k in ["account_id", "k_acc", "device_key", "server_url"] {
            if post_meta.contains_key(k) {
                return Err(format!(
                    "压实自验收:未配置压实不得出现配置键「{k}」(四元组必须保持全空)"
                ));
            }
        }
    }
    // M3(实现审):白名单**内**的键还要验期望终值——恶意/意外的 sync_meta 触发器
    // (如 RAISE(IGNORE))可把身份/换钥 UPDATE 静默吞掉,「白名单外没变」照样绿,
    // 轮换实际未发生。终值逐键实核(release 也在,不用 debug_assert)。
    let expect = |k: &str, want: &str| -> Result<(), String> {
        match post_meta.get(k) {
            Some(v) if v == want => Ok(()),
            other => Err(format!(
                "压实自验收:sync_meta.{k} 终值 {other:?} ≠ 期望(轮换被静默吞?),拒绝提交"
            )),
        }
    };
    expect("device_id", &new_device_id)?;
    expect("epoch", "2")?;
    if configured {
        expect("device_key", new_seed_hex.as_deref().expect("Configured 必有"))?;
        expect("k_acc", new_k_acc_hex.as_deref().expect("Configured 必轮换"))?;
        expect("last_pushed", "0")?;
        for k in ["pending_device_id", "pending_device_key", "pending_pubkey", "pending_state"] {
            if post_meta.contains_key(k) {
                return Err(format!("压实自验收:pending 键「{k}」未消费删除,拒绝提交"));
            }
        }
    }
    // M2 二轮:breaker/quarantine 的清除也要实核终态(同一威胁模型:恶意触发器可
    // 吞 DELETE 假绿)。
    if post_meta.contains_key("poison_breaker") {
        return Err("压实自验收:poison_breaker 未复位(清除被吞?),拒绝提交".into());
    }
    let q_left: i64 = tx
        .query_row("SELECT COUNT(*) FROM sync_quarantine", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if q_left != 0 {
        return Err(format!("压实自验收:sync_quarantine 仍余 {q_left} 行(清除被吞?),拒绝提交"));
    }
    // 0019 冻结触发器重建后必须真在咬(功能探针,SAVEPOINT 内试改必拒、不留痕)。
    tx.execute("SAVEPOINT epoch_meta_probe", []).map_err(|e| e.to_string())?;
    let frozen_bites =
        tx.execute("UPDATE sync_meta SET value = 'PROBE' WHERE key = 'device_id'", []).is_err();
    tx.execute("ROLLBACK TO epoch_meta_probe", []).map_err(|e| e.to_string())?;
    tx.execute("RELEASE epoch_meta_probe", []).map_err(|e| e.to_string())?;
    if !frozen_bites {
        return Err("压实自验收:device_id 冻结触发器失效(改得动),拒绝提交".into());
    }

    let m = baseline.len();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(CompactReport {
        kind: if configured { CompactKind::Configured } else { CompactKind::Unconfigured },
        new_device_id,
        recovery_code,
        baseline_ops: m,
    })
}

/// 基线合成(§2.3 表格):返回 (entity, entity_id, kind, payload) 有序序列,发射顺序
/// 即因果顺序(topic → item → link → image;create 先于其 set)。
fn synthesize_baseline(tx: &Connection) -> Result<Vec<(String, String, String, Value)>, String> {
    let mut ops: Vec<(String, String, String, Value)> = vec![];
    // space profile(space-name-sync-plan §4.4/§4.5):无 create 的单例寄存器,**行存在
    // 就合成一条 set_field(含 name=NULL 的显式清名)**——「非 NULL 才合成」会把清名
    // 写丢背书,压实后 battery 的「行在无 op」双向审计当场红(codex 二轮 H2)。
    {
        let profile: Option<Option<String>> = tx
            .query_row("SELECT name FROM space_profile WHERE key = 'profile'", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(name) = profile {
            ops.push((
                "space".into(),
                "profile".into(),
                "set_field".into(),
                json!({"field": "name", "value": name}),
            ));
        }
    }
    // topics:create {title, created_at};updated_at ≠ created_at 补 set(回放基线所得
    // 行 == 现值:apply_topic_create 落 updated_at = created_at);color/position/kind 非
    // NULL 各补一条 set(它们无 create 键 → 出生 NULL,现值非 NULL 时补齐,0031)。
    {
        let mut stmt = tx
            .prepare(
                "SELECT id, title, created_at, updated_at, color, position, kind \
                 FROM topics ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        type TopicBaseline =
            (String, String, String, String, Option<String>, Option<String>, Option<String>);
        let rows: Vec<TopicBaseline> = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        for (id, title, created_at, updated_at, color, position, kind) in rows {
            ops.push((
                "topic".into(),
                id.clone(),
                "create".into(),
                json!({"title": title, "created_at": created_at}),
            ));
            if updated_at != created_at {
                ops.push((
                    "topic".into(),
                    id.clone(),
                    "set_field".into(),
                    json!({"field": "updated_at", "value": updated_at}),
                ));
            }
            if let Some(c) = color {
                ops.push((
                    "topic".into(),
                    id.clone(),
                    "set_field".into(),
                    json!({"field": "color", "value": c}),
                ));
            }
            if let Some(p) = position {
                ops.push((
                    "topic".into(),
                    id.clone(),
                    "set_field".into(),
                    json!({"field": "position", "value": p}),
                ));
            }
            if let Some(k) = kind {
                ops.push((
                    "topic".into(),
                    id,
                    "set_field".into(),
                    json!({"field": "kind", "value": k}),
                ));
            }
        }
    }
    // items(含回收站/已归档):create = 现值快照(created_at/born_stage 取史实,
    // born_stage 可 null);archived_at/sealed_at/done_at 生而 NULL,非 NULL 各补一条 set。
    {
        let mut stmt = tx
            .prepare(
                "SELECT id, content, stage, created_at, born_stage, due_on, priority, \
                 position, archived_at, sealed_at, done_at FROM items ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        #[allow(clippy::type_complexity)]
        let rows: Vec<(
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        for (id, content, stage, created_at, born, due_on, priority, position, archived, sealed, done) in
            rows
        {
            ops.push((
                "item".into(),
                id.clone(),
                "create".into(),
                json!({
                    "content": content,
                    "stage": stage,
                    "created_at": created_at,
                    "born_stage": born,
                    "due_on": due_on,
                    "priority": priority,
                    "position": position,
                }),
            ));
            if let Some(a) = archived {
                ops.push((
                    "item".into(),
                    id.clone(),
                    "set_field".into(),
                    json!({"field": "archived_at", "value": a}),
                ));
            }
            if let Some(s) = sealed {
                ops.push((
                    "item".into(),
                    id.clone(),
                    "set_field".into(),
                    json!({"field": "sealed_at", "value": s}),
                ));
            }
            // done_at 同 archived_at/sealed_at:生而 NULL,非 NULL 补一条 set_field。补发的
            // HLC 严格晚于本行 create(基线按此序 push、随后逐条 tick),不被 LWW 反噬。
            if let Some(d) = done {
                ops.push((
                    "item".into(),
                    id,
                    "set_field".into(),
                    json!({"field": "done_at", "value": d}),
                ));
            }
        }
    }
    // links:每条 item_topic 行一条 link_add(OR-set 从空历史重生,合法)。
    {
        let mut stmt = tx
            .prepare("SELECT item_id, topic_id FROM item_topic ORDER BY item_id, topic_id")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        for (item_id, topic_id) in rows {
            ops.push((
                "link".into(),
                format!("{item_id}:{topic_id}"),
                "link_add".into(),
                json!({"item_id": item_id, "topic_id": topic_id}),
            ));
        }
    }
    // images:每张现存图一条 image_add,sha256 对字节现算(0024 前老图无 op 级 sha,
    // 字节在锚点本地,权威;死图的 add 不合成——字节已删,sha 无从重算,§1 第 3 条)。
    {
        let mut stmt = tx
            .prepare("SELECT id, item_id, seq, mime, data FROM item_image ORDER BY item_id, seq")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, i64, String, Vec<u8>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        for (id, item_id, seq, mime, data) in rows {
            use sha2::{Digest, Sha256};
            let sha: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
            ops.push((
                "image".into(),
                id,
                "image_add".into(),
                json!({
                    "item_id": item_id,
                    "seq": seq,
                    "mime": mime,
                    "bytes": data.len() as i64,
                    "sha256": sha,
                }),
            ));
        }
    }
    Ok(ops)
}

/// schema 功能探针(§2.6.7 第三层,负例实测——`sqlite_schema` 文本比对挡不住
/// 「文本同、行为异」的极端形态,真插负例才是行为证明):SAVEPOINT 内实插,
/// 全部断言后回滚,不留痕。
fn schema_probes(tx: &Connection, device_id: &str) -> Result<(), String> {
    tx.execute("SAVEPOINT epoch_probe", []).map_err(|e| e.to_string())?;
    let probe = (|| -> Result<(), String> {
        let assert_rejected = |desc: &str, sql: &str, params: &[&dyn rusqlite::ToSql]| {
            match tx.execute(sql, params) {
                Ok(_) => Err(format!("schema 探针:{desc} 竟被接受(约束丢失),拒绝提交")),
                Err(_) => Ok(()),
            }
        };
        // 非法 JSON payload 拒。
        assert_rejected(
            "非法 JSON payload",
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('01PROBE0000000000000000001', ?1, 'item', 'X', 'tombstone', '{not json', 1000000)",
            &[&probe_hlc(device_id, 1)],
        )?;
        // 词汇表外 entity/kind 拒。
        assert_rejected(
            "非法 entity/kind",
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('01PROBE0000000000000000002', ?1, 'item', 'X', 'made_up_kind', '{}', 1000001)",
            &[&probe_hlc(device_id, 2)],
        )?;
        // space 词汇(0028):set_field 合法,create/tombstone 拒(无 create 的单例寄存器)。
        assert_rejected(
            "space create(寄存器无 create)",
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('01PROBE0000000000000000005', ?1, 'space', 'profile', 'create', '{}', 1000003)",
            &[&probe_hlc(device_id, 5)],
        )?;
        assert_rejected(
            "space tombstone(寄存器无 tombstone)",
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('01PROBE0000000000000000006', ?1, 'space', 'profile', 'tombstone', '{}', 1000004)",
            &[&probe_hlc(device_id, 6)],
        )?;
        tx.execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('01PROBE0000000000000000007', ?1, 'space', 'profile', 'set_field', '{}', 1000005)",
            [&probe_hlc(device_id, 7)],
        )
        .map_err(|e| format!("schema 探针:space set_field 合法插入被拒({e}),拒绝提交"))?;
        // origin_seq = 0 拒。
        assert_rejected(
            "origin_seq = 0",
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('01PROBE0000000000000000003', ?1, 'item', 'X', 'tombstone', '{}', 0)",
            &[&probe_hlc(device_id, 3)],
        )?;
        // 合法插入:生成列 origin == HLC 设备后缀(§2.6.7)。
        tx.execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('01PROBE0000000000000000004', ?1, 'item', 'X', 'tombstone', '{}', 1000002)",
            [&probe_hlc(device_id, 4)],
        )
        .map_err(|e| format!("schema 探针:合法插入被拒({e}),拒绝提交"))?;
        let origin: String = tx
            .query_row(
                "SELECT origin FROM oplog WHERE op_id = '01PROBE0000000000000000004'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if origin != device_id {
            return Err(format!(
                "schema 探针:生成列 origin「{origin}」≠ HLC 设备后缀「{device_id}」,拒绝提交"
            ));
        }
        // append-only 触发器活着:UPDATE / DELETE 都拒。
        assert_rejected(
            "UPDATE oplog",
            "UPDATE oplog SET entity_id = 'Y' WHERE op_id = '01PROBE0000000000000000004'",
            &[],
        )?;
        assert_rejected(
            "DELETE FROM oplog",
            "DELETE FROM oplog WHERE op_id = '01PROBE0000000000000000004'",
            &[],
        )?;
        Ok(())
    })();
    // 探针数据不留痕(成败都回滚)。
    tx.execute("ROLLBACK TO epoch_probe", []).map_err(|e| e.to_string())?;
    tx.execute("RELEASE epoch_probe", []).map_err(|e| e.to_string())?;
    probe
}

/// 探针用 HLC(远未来墙钟 + 探针序号,绝不与基线撞 UNIQUE;随 SAVEPOINT 回滚)。
fn probe_hlc(device_id: &str, n: u32) -> String {
    crate::clock::Hlc { wall_ms: 0x1fff_ffff_ffff, counter: n, device_id: device_id.into() }
        .encode()
}

/// 七张用户数据表的逐行指纹(§2.6.6 终态等价;图字节以 sha256 入指纹;0028 起
/// 含 space_profile——名字也是用户数据,压实前后必须逐字相等)。
fn table_fingerprints(tx: &Connection) -> Result<Vec<Vec<String>>, String> {
    let text_rows = |sql: &str| -> Result<Vec<String>, String> {
        let mut stmt = tx.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
    };
    let mut out = vec![
        // quote():NULL→'NULL'、字符串带引号——合法名字「∅」不与 NULL 同指纹(codex L)。
        text_rows("SELECT key||'|'||quote(name) FROM space_profile ORDER BY key")?,
        text_rows(
            "SELECT id||'|'||content||'|'||stage||'|'||created_at||'|'||updated_at \
             ||'|'||COALESCE(archived_at,'∅')||'|'||COALESCE(due_on,'∅')||'|'||COALESCE(priority,'∅') \
             ||'|'||COALESCE(position,'∅')||'|'||COALESCE(sealed_at,'∅')||'|'||COALESCE(born_stage,'∅') \
             ||'|'||COALESCE(done_at,'∅') \
             FROM items ORDER BY id",
        )?,
        text_rows(
            "SELECT id||'|'||title||'|'||created_at||'|'||updated_at||'|'||COALESCE(color,'∅') \
             ||'|'||COALESCE(position,'∅')||'|'||quote(kind) \
             FROM topics ORDER BY id",
        )?,
        text_rows("SELECT item_id||'|'||topic_id FROM item_topic ORDER BY item_id, topic_id")?,
        text_rows("SELECT item_id||'|'||last_seq FROM item_image_counter ORDER BY item_id")?,
        text_rows(
            "SELECT revision_id||'|'||item_id||'|'||content||'|'||archived_at \
             FROM item_revisions ORDER BY revision_id",
        )?,
    ];
    // item_image:元数据 + 字节 sha256(BLOB 不进字符串拼接)。
    let mut stmt = tx
        .prepare("SELECT id, item_id, seq, mime, created_at, data FROM item_image ORDER BY id")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut imgs = vec![];
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let item: String = row.get(1).map_err(|e| e.to_string())?;
        let seq: i64 = row.get(2).map_err(|e| e.to_string())?;
        let mime: String = row.get(3).map_err(|e| e.to_string())?;
        let created: String = row.get(4).map_err(|e| e.to_string())?;
        let data: Vec<u8> = row.get(5).map_err(|e| e.to_string())?;
        use sha2::{Digest, Sha256};
        let sha: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
        imgs.push(format!("{id}|{item}|{seq}|{mime}|{created}|{sha}"));
    }
    out.push(imgs);
    Ok(out)
}

/// oplog 的规范化 schema(§2.6.7 第二层):sqlite_schema 里 tbl_name='oplog' 的全部
/// 对象(表/索引/触发器)的 (type, name, 规范化 sql),排序后比对。规范化 = 空白折叠
/// (重建产物与迁移原文的缩进/换行差异不算语义差异;CHECK 与生成列表达式都在 sql
/// 文本里,这正是 table_xinfo 系 pragma 看不见的部分)。
fn oplog_schema_normalized(tx: &Connection) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT type, name, sql FROM sqlite_schema \
             WHERE tbl_name = 'oplog' AND sql IS NOT NULL ORDER BY type, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for row in rows {
        let (ty, name, sql) = row.map_err(|e| e.to_string())?;
        let norm = sql.split_whitespace().collect::<Vec<_>>().join(" ").replace('"', "");
        out.push((ty, name, norm));
    }
    Ok(out)
}

fn ensure_current_schema(conn: &Connection) -> Result<(), String> {
    let v: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if v != db::SCHEMA_VERSION {
        return Err(format!(
            "库版本 v{v} ≠ 当前 v{}:压实/认证不与 schema 迁移混流,先升级",
            db::SCHEMA_VERSION
        ));
    }
    Ok(())
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

fn meta_upsert(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn meta_all(conn: &Connection) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut stmt = conn.prepare("SELECT key, value FROM sync_meta").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex32(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("十六进制 32B 形态不对".into());
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let hi = (chunk[0] as char).to_digit(16).expect("已验 hex") as u8;
        let lo = (chunk[1] as char).to_digit(16).expect("已验 hex") as u8;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::{self, RemoteOp};
    use crate::sync::pair;
    use crate::{db, images, notes, task};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    fn temp_dir_for(tag: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("ys-nb-epoch-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    struct P {
        conn: Connection,
        clock: Clock,
        dir: PathBuf,
    }

    fn peer(tag: &str) -> P {
        let dir = temp_dir_for(tag);
        let conn = db::open(&dir.join("db.sqlite3")).expect("open");
        let clock = Clock::load(&conn).expect("clock");
        P { conn, clock, dir }
    }

    /// 回放豁免下手插 pre-0020 无背书行(单机正道插不出;boot.rs 测试同手法)。
    /// inbox 行 position 置 NULL(0022 的 stage↔position 口径),任务态给 frindex 键。
    fn insert_legacy_row(conn: &Connection, id: &str, stage: &str, born: Option<&str>) {
        conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        conn.execute(
            "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage) \
             VALUES (?1, '纪元前遗产', ?2, ?3, ?4, ?5, ?6)",
            (id, stage, "t0", "t0", (stage != "inbox").then_some("a0"), born),
        )
        .unwrap();
        conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    }

    /// 工序1 的 epoch 分支覆盖(codex 复审 §7):done_at 非 NULL 时,压实基线必须补发
    /// done_at set_field(HLC 晚于 create)且值零丢——`if let Some(d) = done` 分支此前
    /// 全走 NULL、未被执行。compact 内含七表指纹自验收(现含 done_at),丢值会当场红。
    #[test]
    fn compact_preserves_done_at_and_emits_baseline_set_field() {
        let mut p = peer("done-at");
        let id = task::create(&mut p.conn, &mut p.clock, "干完的活", None, None, None).unwrap();
        task::transition(&mut p.conn, &mut p.clock, &id, "done").unwrap();
        // 工序1 无本地 writer,用一条合法远端 done_at set_field 注值(RFC3339)。
        let done_ts = "2026-07-20T10:00:00.000Z";
        let op = RemoteOp {
            op_id: ulid::Ulid::new().to_string(),
            hlc: crate::clock::Hlc {
                wall_ms: 4_102_444_800_000,
                counter: 0,
                device_id: "RMTDEV0000000000000000000X".into(),
            }
            .encode(),
            entity: "item".into(),
            entity_id: id.clone(),
            kind: "set_field".into(),
            payload: json!({"field": "done_at", "value": done_ts}),
            origin_seq: 1,
        };
        replay::apply_remote_op(&mut p.conn, &mut p.clock, &op).expect("done_at 落值");
        compact(&mut p.conn).expect("带 done_at 压实必须成功(battery + 七表指纹自验收)");
        let got: Option<String> = p
            .conn
            .query_row("SELECT done_at FROM items WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(got.as_deref(), Some(done_ts), "压实后 done_at 不丢");
        // 基线里该 item 的 done_at set_field 的 HLC 必须晚于它的 create(不被 LWW 反噬)。
        let (create_hlc, done_hlc): (Option<String>, Option<String>) = p
            .conn
            .query_row(
                "SELECT MAX(CASE WHEN kind='create' THEN hlc END), \
                        MAX(CASE WHEN kind='set_field' AND json_extract(payload,'$.field')='done_at' THEN hlc END) \
                 FROM oplog WHERE entity='item' AND entity_id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let create_hlc = create_hlc.expect("基线必有 create");
        let done_hlc = done_hlc.expect("基线必有 done_at set_field");
        assert!(done_hlc > create_hlc, "done_at 基线 set_field 的 HLC 必须晚于 create");
    }

    /// space profile 随压实走(0028,space-name-sync-plan §4.5):行保留(七表指纹)、
    /// 基线恰一条 space op;**null 清名也合成**(行存在就合成,含 value:null——否则
    /// 压实把清名写丢背书,battery 双向审计当场红)。
    #[test]
    fn compact_synthesizes_space_profile_including_null() {
        let mut p = peer("space-name");
        notes::capture(&mut p.conn, &mut p.clock, "有点数据").unwrap();
        crate::spaces::set_space_name(&mut p.conn, &mut p.clock, "家庭").unwrap();
        compact(&mut p.conn).expect("有名压实必须成功(自验收含 battery+七表指纹)");
        assert_eq!(crate::spaces::space_name(&p.conn).unwrap().as_deref(), Some("家庭"));
        let (ops, value): (i64, Option<String>) = p
            .conn
            .query_row(
                "SELECT COUNT(*), MAX(json_extract(payload, '$.value')) FROM oplog \
                 WHERE entity = 'space'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((ops, value.as_deref()), (1, Some("家庭")), "基线恰一条、值随行");

        // 显式清名(协议能力,经 replay 收 null)→ 行在、name NULL → 再压实照样背书。
        let clear = RemoteOp {
            op_id: ulid::Ulid::new().to_string(),
            hlc: crate::clock::Hlc {
                wall_ms: 4_102_444_800_000,
                counter: 0,
                device_id: "RMTDEV0000000000000000000X".into(),
            }
            .encode(),
            entity: "space".into(),
            entity_id: "profile".into(),
            kind: "set_field".into(),
            payload: serde_json::json!({"field": "name", "value": null}),
            origin_seq: 1,
        };
        replay::apply_remote_op(&mut p.conn, &mut p.clock, &clear).unwrap();
        assert_eq!(crate::spaces::space_name(&p.conn).unwrap(), None);
        compact(&mut p.conn).expect("null 清名压实必须成功");
        let (rows, ops): (i64, i64) = p
            .conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM space_profile), \
                        (SELECT COUNT(*) FROM oplog WHERE entity = 'space')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, ops), (1, 1), "清名的规范表示 = 行在 name NULL,基线仍恰一条");
        crate::sync::boot::strict_battery(&p.conn).unwrap();
    }

    /// 五脏俱全的现代库(全部行有 op 背书):编辑历史 / 多标签(删过重加 = OR-set
    /// 历史)/ 回收站 / 成就归档 / 彻底删除(墓碑在日志、行已无)/ 配图两张删最高
    /// 编号(counter 洞,§1 第 3 条)。返回 (灵感, 任务, 标签一, 标签二)。
    fn build_rich(p: &mut P) -> (String, String, String, String) {
        let (c, k) = (&mut p.conn, &mut p.clock);
        let idea = notes::capture(c, k, "灵感甲").unwrap();
        notes::edit(c, k, &idea, "灵感甲(改)").unwrap();
        let t1 = notes::create_topic(c, k, "标签一").unwrap();
        notes::set_topic_color(c, k, &t1, Some("#aa3311".into())).unwrap();
        let t2 = notes::create_topic(c, k, "标签二").unwrap();
        notes::file_to_topic(c, k, &idea, Some(&t1), None).unwrap();
        let task_id =
            task::create(c, k, "任务乙", Some("2026-07-20"), Some(2), Some(&t2)).unwrap();
        task::add_topic(c, k, &task_id, &t1).unwrap();
        task::remove_topic(c, k, &task_id, &t1).unwrap();
        task::add_topic(c, k, &task_id, &t1).unwrap();
        images::attach(c, k, &task_id, &[1, 2, 3, 4], "image/png").unwrap();
        let (img2, _) = images::attach(c, k, &task_id, &[5, 6, 7, 8], "image/png").unwrap();
        images::remove(c, k, &img2).unwrap();
        let dead = notes::capture(c, k, "回收站里的").unwrap();
        notes::archive(c, k, &dead).unwrap();
        let sealed = task::create(c, k, "已入册", None, None, None).unwrap();
        task::transition(c, k, &sealed, "done").unwrap();
        task::seal(c, k, &sealed).unwrap();
        let purged = notes::capture(c, k, "彻底删的").unwrap();
        notes::archive(c, k, &purged).unwrap();
        notes::purge(c, k, &purged).unwrap();
        (idea, task_id, t1, t2)
    }

    /// 用户可见投影(跨库可比):items 排除本地簿记 updated_at、archived_at/sealed_at
    /// 只比有无(本地命令各自盖 now,字节必不同——语义等价看轴,不看墙钟);topics
    /// 排除 updated_at(rename 等本地命令盖 now,同理);image 行以 (item_id, seq,
    /// mime, 字节) 计——image id 是各库自生 ULID。**同库压实前后的严格逐字节等价由
    /// compact 内部 table_fingerprints 自验收钉死,本投影只服务跨库行为等价。**
    fn projection(conn: &Connection) -> Vec<Vec<String>> {
        let rows = |sql: &str| -> Vec<String> {
            let mut stmt = conn.prepare(sql).unwrap();
            let it = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            it.collect::<rusqlite::Result<_>>().unwrap()
        };
        vec![
            rows(
                "SELECT id||'|'||content||'|'||stage||'|'||created_at \
                 ||'|'||(archived_at IS NOT NULL)||'|'||COALESCE(due_on,'∅') \
                 ||'|'||COALESCE(priority,'∅')||'|'||COALESCE(position,'∅') \
                 ||'|'||(sealed_at IS NOT NULL)||'|'||COALESCE(born_stage,'∅') \
                 ||'|'||(done_at IS NOT NULL) \
                 FROM items ORDER BY id",
            ),
            rows(
                "SELECT id||'|'||title||'|'||created_at||'|'||COALESCE(color,'∅') \
                 ||'|'||COALESCE(position,'∅')||'|'||quote(kind) \
                 FROM topics ORDER BY id",
            ),
            rows("SELECT item_id||'|'||topic_id FROM item_topic ORDER BY item_id, topic_id"),
            rows(
                "SELECT item_id||'|'||seq||'|'||mime||'|'||lower(hex(data)) \
                 FROM item_image ORDER BY item_id, seq",
            ),
            rows("SELECT item_id||'|'||last_seq FROM item_image_counter ORDER BY item_id"),
        ]
    }

    fn oplog_rows(conn: &Connection) -> Vec<(String, String, String, i64)> {
        let mut stmt = conn
            .prepare("SELECT op_id, hlc, kind, origin_seq FROM oplog ORDER BY op_id")
            .unwrap();
        let it = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap();
        it.collect::<rusqlite::Result<_>>().unwrap()
    }

    // ---- 两型压实 ----

    #[test]
    fn unconfigured_compact_preserves_state_and_rewrites_ledger() {
        let mut p = peer("uncfg");
        build_rich(&mut p);
        // pre-0020 无背书行:压实前严格电池必拒(阴性对照——证明压实真清了东西)。
        insert_legacy_row(&p.conn, "01EPCHGACY000000000000000A", "inbox", None);
        boot::strict_battery(&p.conn).expect_err("legacy 行在,严格电池必须报脏");
        // 旧纪元的隔离额度与 breaker:压实必须清空复位(§2.3 白名单)。
        p.conn
            .execute(
                "INSERT INTO sync_quarantine (origin, op_id, origin_seq, op_blob, reason, \
                 error_stage, validator_ver, at) VALUES ('01REMDEVAAAAAAAAAAAAAAAAAA', \
                 '01AAAAAAAAAAAAAAAAAAAAAAAA', 1, x'00', '毒', 'shape', 1, 't')",
                [],
            )
            .unwrap();
        meta_upsert(&p.conn, "poison_breaker", "隔离额度到顶").unwrap();

        let old_device = meta_get(&p.conn, "device_id").unwrap().unwrap();
        let before = projection(&p.conn);
        let revisions_before: Vec<String> = {
            let mut stmt = p
                .conn
                .prepare(
                    "SELECT revision_id||'|'||item_id||'|'||content||'|'||archived_at \
                     FROM item_revisions ORDER BY revision_id",
                )
                .unwrap();
            let it = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            it.collect::<rusqlite::Result<_>>().unwrap()
        };

        let report = compact(&mut p.conn).expect("未配置压实必须成功");
        assert_eq!(report.kind, CompactKind::Unconfigured);
        assert!(report.recovery_code.is_none(), "未配置压实无恢复码(无 k_acc 可轮换)");
        assert_ne!(report.new_device_id, old_device);
        assert!(sync_proto::is_ulid(&report.new_device_id));
        assert_eq!(
            meta_get(&p.conn, "device_id").unwrap().unwrap(),
            report.new_device_id,
            "身份已轮换"
        );
        // 配置四元组保持全空(§2.1 Unconfigured 契约)。
        for k in ["account_id", "k_acc", "device_key", "server_url"] {
            assert!(meta_get(&p.conn, k).unwrap().is_none(), "{k} 必须仍缺席");
        }
        assert!(epoch_certified(&p.conn).unwrap());
        // 全部基线 op:origin = 新身份、seq 连续 1..m。
        let (n, foreign, max_seq): (i64, i64, i64) = p
            .conn
            .query_row(
                "SELECT COUNT(*), SUM(origin != ?1), MAX(origin_seq) FROM oplog",
                [&report.new_device_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(n as usize, report.baseline_ops);
        assert_eq!(foreign, 0, "不许有旧 origin 的 op 残留");
        assert_eq!(max_seq, n, "origin_seq 连续 1..m");
        // 用户数据零变;编辑历史原样;隔离与 breaker 已清。
        assert_eq!(projection(&p.conn), before);
        let revisions_after: Vec<String> = {
            let mut stmt = p
                .conn
                .prepare(
                    "SELECT revision_id||'|'||item_id||'|'||content||'|'||archived_at \
                     FROM item_revisions ORDER BY revision_id",
                )
                .unwrap();
            let it = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            it.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(revisions_after, revisions_before, "item_revisions 原样保留");
        let q: i64 =
            p.conn.query_row("SELECT COUNT(*) FROM sync_quarantine", [], |r| r.get(0)).unwrap();
        assert_eq!(q, 0, "隔离表整表清空");
        assert!(meta_get(&p.conn, "poison_breaker").unwrap().is_none(), "breaker 复位");
        // 压实后的库过严格电池(§2.6 的意义所在;compact 内部跑过,这里独立复核)。
        boot::strict_battery(&p.conn).expect("压实后必过严格电池");
    }

    #[test]
    fn configured_compact_rotates_identity_kacc_and_consumes_pending() {
        let mut p = peer("cfg");
        build_rich(&mut p);
        let old_k_acc = hex(&[7u8; 32]);
        for (k, v) in [
            ("account_id", "01AAAAAAAAAAAAAAAAAAAAACCT"),
            ("k_acc", old_k_acc.as_str()),
            ("device_key", &hex(&[8u8; 32])),
            ("server_url", "ws://h:1"),
            ("bootstrapped_at", "t"),
            ("last_pushed", "5"),
        ] {
            meta_upsert(&p.conn, k, v).unwrap();
        }
        // 无 pending → 拒(必须先走两阶段预注册)。
        let err = compact(&mut p.conn).unwrap_err();
        assert!(err.contains("Registered"), "{err}");

        let (seed, pubkey) = pair::gen_device_key();
        let pending_id = Ulid::new().to_string();
        meta_upsert(&p.conn, "pending_device_id", &pending_id).unwrap();
        meta_upsert(&p.conn, "pending_device_key", &hex(&seed)).unwrap();
        meta_upsert(&p.conn, "pending_pubkey", &hex(&pubkey)).unwrap();
        // prepared(未注册)→ 拒。
        meta_upsert(&p.conn, "pending_state", "prepared").unwrap();
        let err = compact(&mut p.conn).unwrap_err();
        assert!(err.contains("Registered"), "{err}");
        // 材料损坏(公钥与种子不符)→ 拒(阴性对照:消费时的完整性锚真在咬)。
        meta_upsert(&p.conn, "pending_state", "registered").unwrap();
        meta_upsert(&p.conn, "pending_pubkey", &hex(&[0u8; 32])).unwrap();
        let err = compact(&mut p.conn).unwrap_err();
        assert!(err.contains("不符"), "{err}");
        meta_upsert(&p.conn, "pending_pubkey", &hex(&pubkey)).unwrap();

        let report = compact(&mut p.conn).expect("Registered pending 在场必须成功");
        assert_eq!(report.kind, CompactKind::Configured);
        assert_eq!(report.new_device_id, pending_id, "消费的就是预注册身份");
        assert_eq!(meta_get(&p.conn, "device_id").unwrap().unwrap(), pending_id);
        assert_eq!(meta_get(&p.conn, "device_key").unwrap().unwrap(), hex(&seed));
        assert_eq!(meta_get(&p.conn, "last_pushed").unwrap().as_deref(), Some("0"));
        for k in ["pending_device_id", "pending_device_key", "pending_pubkey", "pending_state"] {
            assert!(meta_get(&p.conn, k).unwrap().is_none(), "pending 键必须消费删除:{k}");
        }
        // K_acc 已轮换,恢复码 = 新 k_acc 的编码(§2.5:旧恢复码自此作废)。
        let new_k_acc = meta_get(&p.conn, "k_acc").unwrap().unwrap();
        assert_ne!(new_k_acc, old_k_acc, "k_acc 必须轮换");
        let code = report.recovery_code.expect("Configured 压实必须给新恢复码");
        assert_eq!(
            hex(&crate::sync::crypto::parse_recovery_code(&code).unwrap()),
            new_k_acc,
            "恢复码就是新 k_acc 的人眼编码"
        );
        assert!(epoch_certified(&p.conn).unwrap());
        boot::strict_battery(&p.conn).expect("压实后必过严格电池");
    }

    #[test]
    fn compact_preconditions_reject_broken_states() {
        // 配置残缺(只有部分键)= 不是合法库状态。
        let mut p = peer("pre-partial");
        meta_upsert(&p.conn, "account_id", "01AAAAAAAAAAAAAAAAAAAAACCT").unwrap();
        let err = compact(&mut p.conn).unwrap_err();
        assert!(err.contains("残缺"), "{err}");

        // 未配置库带 pending 残留 = 状态机被绕过。
        let mut p = peer("pre-resid");
        meta_upsert(&p.conn, "pending_state", "prepared").unwrap();
        let err = compact(&mut p.conn).unwrap_err();
        assert!(err.contains("残留"), "{err}");

        // 库版本不符:压实不与 schema 迁移混流。
        let mut p = peer("pre-ver");
        p.conn.pragma_update(None, "user_version", 9999).unwrap();
        let err = compact(&mut p.conn).unwrap_err();
        assert!(err.contains("v9999"), "{err}");
        let err = certify(&mut p.conn).unwrap_err();
        assert!(err.contains("v9999"), "certify 同一道版本闸:{err}");
    }

    // ---- §2.2 DDL 故障注入:任一点失败 → 全量回滚 ----

    #[test]
    fn compact_failpoints_roll_back_completely() {
        for fp in [
            FailPoint::AfterTriggerDrop,
            FailPoint::AfterIdentityUpdate,
            FailPoint::BeforeOplogRebuild,
            FailPoint::AfterOplogRebuild,
        ] {
            let mut p = peer("fp");
            build_rich(&mut p);
            let device = meta_get(&p.conn, "device_id").unwrap().unwrap();
            let meta = meta_all(&p.conn).unwrap();
            let ops = oplog_rows(&p.conn);
            let proj = projection(&p.conn);

            let err = compact_with_failpoint(&mut p.conn, fp).unwrap_err();
            assert!(err.contains("故障注入"), "{fp:?}: {err}");

            assert_eq!(meta_get(&p.conn, "device_id").unwrap().unwrap(), device, "{fp:?}");
            assert_eq!(meta_all(&p.conn).unwrap(), meta, "{fp:?}: sync_meta 完整还原");
            assert_eq!(oplog_rows(&p.conn), ops, "{fp:?}: oplog 完整还原");
            assert_eq!(projection(&p.conn), proj, "{fp:?}: 用户数据完整还原");
            // 0019 冻结触发器活着(不是只有名字在——真 UPDATE 真被拒)。
            p.conn
                .execute("UPDATE sync_meta SET value = 'X' WHERE key = 'device_id'", [])
                .expect_err("冻结触发器必须还原并咬人");
        }
    }

    // ---- §3.4 certify:干净空间认证,不重写账本 ----

    #[test]
    fn certify_passes_clean_db_without_rewriting_anything() {
        let mut p = peer("cert-ok");
        build_rich(&mut p);
        let device = meta_get(&p.conn, "device_id").unwrap().unwrap();
        let ops = oplog_rows(&p.conn);
        assert!(!epoch_certified(&p.conn).unwrap());
        certify(&mut p.conn).expect("0024 后新建库天生干净");
        assert!(epoch_certified(&p.conn).unwrap());
        // 零改动:身份不轮换、账本不重写(与 compact 的本质区别)。
        assert_eq!(meta_get(&p.conn, "device_id").unwrap().unwrap(), device);
        assert_eq!(oplog_rows(&p.conn), ops);
    }

    #[test]
    fn certify_rejects_dirty_db_and_writes_nothing() {
        // pre-0020 无背书行。
        let mut p = peer("cert-legacy");
        build_rich(&mut p);
        insert_legacy_row(&p.conn, "01EPCHGACY000000000000000B", "done", Some("todo"));
        certify(&mut p.conn).expect_err("无背书行必须报脏");
        assert!(!epoch_certified(&p.conn).unwrap(), "认证失败不得落标(同事务回滚)");

        // legacy 形态 op(int position 的 set_field):§3.1 carve-out 已删,电池必拒。
        let mut p = peer("cert-shape");
        let (_, task_id, ..) = build_rich(&mut p);
        p.conn
            .execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'item', ?3, 'set_field', ?4, 1)",
                rusqlite::params![
                    Ulid::new().to_string(),
                    // 比现存全部 HLC 都大(因果序不背锅),origin 是合法外来设备形态。
                    format!("{}-{}-01REMDEVAAAAAAAAAAAAAAAAAA", "0ffffffffffff", "00000000"),
                    task_id,
                    r#"{"field":"position","value":5}"#,
                ],
            )
            .unwrap();
        certify(&mut p.conn).expect_err("int position 的 legacy 形态必须报脏");
        assert!(!epoch_certified(&p.conn).unwrap());
    }

    // ---- §3.6 行为等价:同一史实的两个副本,一份压实一份不压,喂同一后缀 ----

    #[test]
    fn behavior_equivalence_pre_and_post_compact() {
        let mut a = peer("beq-a");
        let (idea, task_id, _t1, t2) = build_rich(&mut a);
        const LEGACY: &str = "01EPCHGACY000000000000000C";
        insert_legacy_row(&a.conn, LEGACY, "inbox", None);
        // WAL 合并后整库拷贝出 B(同一史实的两个副本);B 压实、A 不压。
        a.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        let dir_b = temp_dir_for("beq-b");
        std::fs::copy(a.dir.join("db.sqlite3"), dir_b.join("db.sqlite3")).unwrap();
        let mut conn_b = db::open(&dir_b.join("db.sqlite3")).unwrap();
        compact(&mut conn_b).expect("副本压实");
        // 压实后调用方契约:时钟必须重载(身份已换)。
        let mut clock_b = Clock::load(&conn_b).unwrap();

        // ---- 后缀一:本地命令流(两库各自执行同一串命令) ----
        for (c, k) in
            [(&mut a.conn, &mut a.clock), (&mut conn_b, &mut clock_b)] as [(_, _); 2]
        {
            task::rename(c, k, &task_id, "任务乙(后缀改)").unwrap();
            task::transition(c, k, &task_id, "doing").unwrap();
            task::set_due(c, k, &task_id, Some("2026-08-01")).unwrap();
            task::set_priority(c, k, &task_id, Some(3)).unwrap();
            // 删过最高编号图(图2):新图必须续高水位(图3),洞不复用、两库同号。
            let (_, seq) = images::attach(c, k, &task_id, &[9, 9, 9], "image/png").unwrap();
            assert_eq!(seq, 3, "counter 洞不复用:删过图2,新图必是图3");
            // born_stage null 遗产行流转:promote 之后 born 仍 null(不造假史实)。
            notes::promote_to_task(c, k, LEGACY, "遗产转任务").unwrap();
            // 归档/取消归档。
            notes::archive(c, k, &idea).unwrap();
            notes::restore(c, k, &idea).unwrap();
        }
        let born: Option<String> = a
            .conn
            .query_row("SELECT born_stage FROM items WHERE id = ?1", [LEGACY], |r| r.get(0))
            .unwrap();
        assert_eq!(born, None, "流转不回填史实");

        // ---- 后缀二:远端 op 流(同一批 op 喂两库;HLC > 两库各自最大,且只引用
        //      自己带来的 add——新纪元因果,§3.6)----
        let origin = "01REMDEVAAAAAAAAAAAAAAAAAA";
        let mut seq = 0i64;
        let mut rop = |entity: &str, entity_id: &str, kind: &str, payload: Value| {
            seq += 1;
            RemoteOp {
                op_id: Ulid::new().to_string(),
                hlc: format!("0fffffff{seq:05x}-00000000-{origin}"),
                entity: entity.into(),
                entity_id: entity_id.into(),
                kind: kind.into(),
                payload,
                origin_seq: seq,
            }
        };
        let new_item = Ulid::new().to_string();
        let add = rop(
            "link",
            &format!("{idea}:{t2}"),
            "link_add",
            json!({"item_id": idea, "topic_id": t2}),
        );
        let ops = vec![
            rop("item", &new_item, "create", json!({
                "content": "远端新条目", "stage": "inbox",
                "created_at": "2099-01-01T00:00:00Z", "born_stage": "inbox",
                "due_on": null, "priority": null, "position": null,
            })),
            rop("item", &task_id, "set_field", json!({"field": "content", "value": "远端改写标题"})),
            add.clone(),
            rop(
                "link",
                &format!("{idea}:{t2}"),
                "link_remove",
                json!({"item_id": idea, "topic_id": t2, "observed": [add.op_id]}),
            ),
        ];
        for op in &ops {
            replay::apply_remote_op(&mut a.conn, &mut a.clock, op)
                .unwrap_or_else(|e| panic!("A 应用 {}/{} 失败:{e:?}", op.entity, op.kind));
            replay::apply_remote_op(&mut conn_b, &mut clock_b, op)
                .unwrap_or_else(|e| panic!("B 应用 {}/{} 失败:{e:?}", op.entity, op.kind));
        }
        assert_eq!(projection(&a.conn), projection(&conn_b), "压实前后行为等价");
    }

    // ---- 压实后引导端到端:压实库作源,新设备快照引导必过严格审计 ----

    #[test]
    fn boot_import_from_compacted_db_end_to_end() {
        let mut a = peer("boot-src");
        build_rich(&mut a);
        insert_legacy_row(&a.conn, "01EPCHGACY000000000000000D", "inbox", None);
        compact(&mut a.conn).unwrap();
        let snap = boot::make_snapshot(&a.conn, &a.dir).unwrap();

        let mut b = peer("boot-dst");
        boot::import_snapshot(&mut b.conn, &mut b.clock, &snap.path)
            .expect("压实库的快照必须通过全部严格审计");
        assert_eq!(projection(&b.conn), projection(&a.conn), "引导 = 完整副本");
        boot::strict_battery(&b.conn).expect("引导出来的库同样过电池");
        // §3.3 收端:严格审计全过 + 导入事务落 epoch=2 → 立即具备当快照源资格。
        assert!(epoch_certified(&b.conn).unwrap(), "引导出来的设备随导入取得纪元标记");
        boot::make_snapshot(&b.conn, &b.dir).expect("引导出来的设备立即可当引导源(供货闸放行)");
    }
}
