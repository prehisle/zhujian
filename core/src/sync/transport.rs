//! P2-g 传输层 —— sync-protocol §8 的落实:sans-io 组件(engine/pair/boot/crypto)
//! 的**唯一 IO 宿主**。一个 tokio 任务:连 WSS(rustls)→ 挑战应答鉴权 → 需要则先
//! 引导(快照直通+导入)→ 装配引擎 → select 循环(收帧解密喂引擎 / 本地写通知即时
//! 推送 / 心跳与静默判死 / 配对编排 / 供快照);断线指数退避 1s→60s 带抖动重连。
//!
//! 分域封装(§2;两端都是本文件,[`msg_domain`] 的映射即协议):`Msg::Ops`→op 域、
//! `Hello/Want`→ctl 域、`Blob*`→blob 域、[`BootMsg`]→boot 域。收端不知帧属哪个域
//! (信封无域字段),逐域试解——AEAD 子钥不同,错域必 `Decrypt`;解过但形不合 =
//! `Codec` = **对端版本较新**(已通过认证,不再试别域),必须转用户可见提示(codex
//! P2-d 轮 M1 纪律);解过但**变体不属于该域** = 协议错误拒收(评审 P2-g 轮 M,
//! 校验与封帧共用 [`msg_domain`] 单一真相源)。
//!
//! 锁序契约(§8):凡碰库恒走「先 db 后 clock」(与 lib.rs `write_locks` 同序);
//! 引擎喂帧分批 ≤ [`OPS_LOCK_BATCH`] 条、批间放锁,追赶不饿死 UI 命令;**引导从
//! fresh 校验到 commit 持同一把锁**(import_snapshot 在一次持锁内完成,事务内重验
//! 是契约被破坏时的最后防线);**导入完成后重建 Engine 再 on_connected**(boot.rs
//! 模块注释的接线契约:池内旧队头会堵死 origin,引擎状态本就可丢)。
//!
//! 出站游标(§5.2):`sync_meta.last_pushed` = 服务器 **ack 确认过**的本机 op 最大
//! seq(ack 语义=服务器已接手[在线转发+入箱],不是对端已收);连接建立时把引擎
//! 游标复位到它,「已发未 ack」断线即重推,重复由对端 op_id 幂等吸收。
//!
//! 引导期间(bootstrapped_at 缺席)**op/ctl/blob 帧整帧丢弃**:半路应用远端 op 会把
//! 本库变「非 fresh」,永久堵死导入(legacy 行从此照不进水位)——丢弃无损,引导完成
//! 后重建引擎 + hello 互补会重取一切(§6.2 步骤 6 的工程形)。
//!
//! 配置(sync_meta,全部设备本地、永不同步):`account_id / k_acc / device_key /
//! server_url / last_pushed`;`bootstrapped_at` 由 boot.rs 导入事务写,创号设备在
//! [`create_account`] 里直接写(创号者即同步纪元源,永不引导)。配置要么全有要么
//! 全无,残缺 = 报错(fail-fast,不猜)。

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::OsRng;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use rusqlite::Connection;
use serde::Serialize;
use sync_proto::{
    auth_sig_payload, err_code, register_device_sig_payload, register_first_sig_payload,
    seat_lease_sig_payload, ClientMsg, Lane as WireLane, PairEvent, ServerMsg, HEARTBEAT_SECS,
    SILENCE_TIMEOUT_SECS,
};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::tungstenite::Message as WsMsg;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::clock::Clock;
use crate::sync::boot::{self, BootMsg, BootReceiver, BootSender, ChunkOutcome};
use crate::sync::crypto::{self, Domain, FrameAddr, OpenError};
use crate::sync::engine::{Engine, Event, Lane, Msg, Output};
use crate::sync::pair::{self, AccountGrant, DeviceEnroll, PairOutput};

/// 图字节旁路策略(M1,定义在 engine、由壳层经 [`Transport`] 注入)——sync 模块
/// 对外只露 transport,策略枚举从这里出 crate(android-plan §1 窄公开面)。
pub use crate::sync::engine::BlobPolicy;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// 追赶分批:每批 ≤100 op 释放一次写锁(§8 锁序,不饿死 UI 命令)。合法 ops 帧的
/// 连续前缀切片仍是合法帧(升序性质保持),硬校验语义不变。
const OPS_LOCK_BATCH: usize = 100;
/// 握手各步超时(连接/挑战/鉴权回执)。
const HANDSHAKE_SECS: u64 = 10;
/// 引导:发出 Req 后等 Offer / 块间活性超时,超了换一台在线设备重试(§6.2 步骤 1;
/// 对方也在引导时不应答,靠这只超时轮转)。
const BOOT_STEP_SECS: u64 = 30;
/// 引导空间不足的重试间隔(codex P4-d 轮 M1/复核 M):**主动断连 + 固定长等待**。
/// 断连是必须的——收端只丢块的话,源端会把整份快照(最大 8GiB)白白发完(复核 M);
/// 断开让服务器对源端的下一块回 Nack,`Sent::BootOut` 路径当场止流并删临时快照。
/// 但不能走普通重连:鉴权成功会把退避清回 1s,磁盘长期不足 = 每秒建连+让源端反复
/// VACUUM 的热循环(M1)。故走专用 [`SessionEnd::SpaceBlocked`]:固定等这么久再连,
/// 等待期间用户清出空间即自愈(Reconfigured 可立即唤醒)。
const BOOT_SPACE_RETRY_SECS: u64 = 300;
/// 配对流程总超时(与服务器槽 TTL 同量级,§4)。**从 PairSlot 到达起算**——
/// 超时所有权在 transport(phone-space-plan §1.3),壳层不再自设短超时。
const PAIR_TIMEOUT_SECS: u64 = 600;
/// 开槽阶段超时(PairOpen 发出 → PairSlot 到达):服务器一跳就该回,15 秒不到
/// = 响亮失败回执壳层;拿到槽后 deadline 重置为码的真实 TTL(PAIR_TIMEOUT_SECS)。
/// 没有这段短 deadline,壳层若自行超时丢弃 receiver,迟到的 PairSlot 会把
/// PairFlow 留活到 600 秒,期间重试恒撞「已有配对在进行中」(codex r2 N1)。
const PAIR_OPEN_SECS: u64 = 15;
/// 重连退避上限(§8:1s→60s 指数带抖动)。
const BACKOFF_MAX_SECS: u64 = 60;

/// 会话必须终结的机械判定(实现审 M1 二轮,不只轮询瞬态 pending):
/// ① pending 键在场(Prepared/Registered/残料)= 封闸;
/// ② **身份换代**(ABA 漏检的闭合):`Prepared→Registered→compact` 若在两次检查
///   之间整段完成,pending 已被消费——但压实必换 device_id/K_acc,现库配置与本会话
///   开始时的 cfg 不再一致,旧 session 持旧 signing/engine 继续跑就是旧身份幽灵。
///   配置读不出(残缺/未配置)同判终结,fail-closed。
fn session_gate_tripped(db: &Arc<Mutex<Connection>>, cfg: &SyncConfig) -> bool {
    let conn = db.lock().expect("db mutex poisoned");
    if !matches!(pending_identity_block(&conn), Ok(None)) {
        return true;
    }
    match load_config(&conn) {
        Ok(Some(now)) => {
            now.device_id != cfg.device_id || now.k_acc != cfg.k_acc || now.device_seed != cfg.device_seed
        }
        _ => true,
    }
}

// ---- 对外类型(lib.rs 命令面与 UI 事件桥用) ----

/// 同步状态快照(`sync_status` 命令返回;每次变更经 [`SyncEvent::Status`] 推给 UI)。
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct SyncStatus {
    /// 是否已加入账户(false = 同步整个面零打扰)。
    pub configured: bool,
    /// "off" 未配置 | "connecting" 连接中 | "booting" 初始同步 | "online" 已连 |
    /// "offline" 掉线重试中。
    pub state: String,
    pub account_id: Option<String>,
    pub device_id: Option<String>,
    pub server_url: Option<String>,
    /// 账户内当前在线的其它设备数。
    pub peers_online: usize,
    /// 最近一次值得人看的错误(人话;连接恢复即清)。
    pub error: Option<String>,
    /// 已冻结的 origin(分叉,§11 手工流程恢复;每会话从引擎内存态重derive)。
    pub frozen: Vec<String>,
    /// 已持久隔离的 origin(毒 op,epoch-plan §4;跨重启,处置=升级重验或吊销重配)。
    pub quarantined: Vec<String>,
    /// poison-breaker 置位原因(§4 fail-closed:拒收一切新 origin;人工处置后复位)。
    pub poison_breaker: Option<String>,
    /// 挂起的 origin 数(依赖未到/对端版本较新,通常瞬态)。
    pub suspended: usize,
    /// 收到过「解得开但读不懂」的帧:对端版本较新,请升级。
    pub skew: bool,
    /// 收到过 HLC 墙钟比本机快 >24h 的远端 op(L1):对端系统时间可能错、LWW 会偏向它。
    pub clock_skew: bool,
}

/// 传输任务 → UI 桥的事件(lib.rs 把它转 tauri emit;测试直接读通道)。
#[derive(Debug)]
pub enum SyncEvent {
    /// 状态快照有变(内容在 [`SyncStatus`] 共享态里,事件携带副本省一次锁)。
    Status(SyncStatus),
    /// 远端 op 落地/图字节到齐:当前视图该刷新(前端去抖)。
    Changed,
    /// 空间名变了(space-name-sync-plan §4.7;来源 = live replay 落地 / boot 物化,
    /// 本地改名由壳层命令自行广播不经 transport)。壳层刷空间名展示——**不分当前/
    /// 非当前空间**,借道 Changed 必漏(其消费者对非当前空间直接丢弃)。
    SpaceNameChanged,
    /// 非模态提示条(「图N」翻案、冻结、引导完成等)。
    Toast(String),
    /// 配对进度:phase ∈ joined/registering/done/failed。
    Pair { phase: &'static str, detail: String },
    /// 引导快照传输进度(android-plan §3 引导 UI 义务):received 按块推进;
    /// received == total 之后是「校验 + 导入」段,完成走 Toast/Status。
    BootProgress { received: i64, total: i64 },
}

/// 引导持久提交的通知(space-entry-plan §3.2:「加入空间」的 JoinManager 靠它知道
/// BootCommitted)。携导入报告 + 收尾噪音;`needs_reopen` = 导入落在
/// [`boot::ImportOutcome::CommittedNeedsReopen`](DETACH 终败),transport 即将以
/// [`TransportExit::ReopenRequired`] 收场。
#[derive(Debug)]
pub struct BootCommitNotice {
    pub report: boot::ImportReport,
    pub post_commit_error: Option<String>,
    pub needs_reopen: bool,
}

/// BootCommitted 信号的共享 latch(space-entry-plan 三轮 M1):**Transport 生命周期**
/// 的所有权位——`Transport::run` 内部不断重连、每次鉴权后的 `Ctx` 断线即销毁,
/// sender 若移进某次 Ctx,第一次断线就关通道、JoinManager 误判失败而 Transport 还在
/// 重试。每个 Ctx 只持 latch clone,持久提交 + 事务内 integrity 成功之后、
/// `start_engine` 之前 `take()+send()`;**receiver 关闭只有在 Transport 任务也已
/// 退出时才算终败**(接收侧合同)。不用 latch 的装配点(supervisor 正式 runtime)
/// 传 `Arc::new(Mutex::new(None))` 即可。
pub type BootCommitLatch = Arc<Mutex<Option<oneshot::Sender<BootCommitNotice>>>>;

/// [`run`] 的结构化退出(space-entry-plan 三轮 M2:不许静默返回 `()`)。
#[derive(Debug, PartialEq)]
pub enum TransportExit {
    /// 正常收场:停机信号 / 宿主(控制通道发送端)消亡。
    Stopped,
    /// 引导已持久提交但 DETACH 终败:本连接不可续用,**已放弃重连**。壳层义务:
    /// staging 路走 close→publish→新连接;正式 runtime 路必须 stop→重新 activate,
    /// 做不到就封锁该 runtime 的业务写并明确要求重启(supervisor 的 restart_required)。
    ReopenRequired { error: String },
}

/// 命令面 → 传输任务的控制信号。停机刻意**不在此**:bounded 控制通道可能被排队
/// 命令占位,停机走独立 [`Transport::shutdown`] watch 信号(multispace-plan §6)。
pub enum Control {
    /// 配置写入/变更:立即(重)连。
    Reconfigured,
    /// 发起配对:回执配对码(slot-XXXX-XXXX);后续进度走 [`SyncEvent::Pair`]。
    PairStart { reply: oneshot::Sender<Result<String, String>> },
}

/// 传输任务的全部依赖(lib.rs setup 装配;测试直接构造)。
pub struct Transport {
    pub db: Arc<Mutex<Connection>>,
    pub clock: Arc<Mutex<Clock>>,
    pub status: Arc<Mutex<SyncStatus>>,
    pub events: mpsc::UnboundedSender<SyncEvent>,
    pub control: mpsc::Receiver<Control>,
    /// 本地写命令发射 op 的通知(见 [`hook_oplog_writes`])。
    pub wrote: Arc<Notify>,
    /// 引导快照的临时文件目录(库文件同目录,同卷免跨盘拷)。
    pub data_dir: PathBuf,
    /// 图字节旁路策略(M1):显式注入,无默认值。桌面恒 Full;安卓 100-116 注
    /// MetadataOnly、**117 起反转为 Full**(时间轴显示配图)——MetadataOnly 仍是
    /// 受支持策略,语义与测试不动。
    pub blob_policy: BlobPolicy,
    /// 是否应答别机的引导请求(BootMsg::Req)。两端壳现均 true(phone-space-plan
    /// 对称升格;false 仍是合法配置,语义由 M1 测试⑤钉住)。true 也要过
    /// [`boot_serve_snapshot`] 的「无缺字节」防线——MetadataOnly 库天生不完整、
    /// Full 端字节未拉完时同样有缺口,字节有洞即静默拒供,请求方超时换人
    /// (§6.2 预期等待语义),绝不把引导悄悄变成部分克隆。
    pub allow_boot_source: bool,
    /// 停机信号(multispace-plan §6,`supervisor::stop` 拉高):在**任何 await 点**
    /// 生效——含拨号/WS 握手/Challenge/引导传输中(session future 被 select drop
    /// 取消;SQLite 写只发生在 await 点之间的同步段,drop 落在 await 点 = 事务边界,
    /// 撕不裂事务;boot 临时文件由 Ctx 的 Drop 清理)。与 Control 分离:bounded
    /// 控制通道可能被排队命令占位,停机不许被拖住。发送端已消亡 = 没有编排者
    /// (安卓 v1 常驻壳),按「永不停机」处理。
    pub shutdown: tokio::sync::watch::Receiver<bool>,
    /// BootCommitted 共享 latch(space-entry-plan §3.2;见 [`BootCommitLatch`])。
    /// 不关心引导提交时刻的装配点传 `Arc::new(Mutex::new(None))`。
    pub boot_commit: BootCommitLatch,
    /// 「连接须重开」旗(space-entry-plan §3.2,codex 一轮 M3):在 **DETACH 终败
    /// 被判定的那一刻**(任何后续 await 之前)置位——supervisor 把 runtime 的
    /// `restart_required` Arc 传进来,壳层写闸即时拒写,不等 `run` 整体返回才落旗
    /// (那之间还有 ws.close 等 await,写可能溜进旧连接)。staging 路/测试传
    /// `Arc::new(Mutex::new(None))` 即可(staging 由 JoinManager 收口,无人写)。
    pub restart_flag: Arc<Mutex<Option<String>>>,
}

/// 在连接上挂 oplog 写通知:写命令同事务发射 op,INSERT 一落传输任务即醒来推送
/// (rusqlite 每连接仅一只 update_hook,这里是唯一注册点)。回滚的事务会产生一次
/// 空跑唤醒,无害——outbound 查不到新 op 就静默。
pub fn hook_oplog_writes(conn: &Connection, wrote: Arc<Notify>) {
    conn.update_hook(Some(
        move |_action, _db: &str, table: &str, _rowid| {
            if table == "oplog" {
                wrote.notify_one();
            }
        },
    ));
}

// ---- sync_meta 配置面 ----

pub(crate) fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

fn meta_put(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    // UPSERT;device_id 行有冻结触发器,本层永不碰它。
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// 同步配置(sync_meta 五键的内存形态)。
pub(crate) struct SyncConfig {
    pub account_id: String,
    pub k_acc: [u8; 32],
    pub device_seed: [u8; 32],
    pub server_url: String,
    pub device_id: String,
}

/// 读配置:四键全无 = 未配置(None);全有 = Some;残缺 = Err(库损坏或写入中断,
/// fail-fast 不猜)。
pub(crate) fn load_config(conn: &Connection) -> Result<Option<SyncConfig>, String> {
    let account = meta_get(conn, "account_id")?;
    let k = meta_get(conn, "k_acc")?;
    let d = meta_get(conn, "device_key")?;
    let url = meta_get(conn, "server_url")?;
    match (account, k, d, url) {
        (None, None, None, None) => Ok(None),
        (Some(account_id), Some(k), Some(d), Some(server_url)) => {
            let device_id = meta_get(conn, "device_id")?
                .ok_or_else(|| "sync_meta 缺 device_id(库损坏?)".to_string())?;
            Ok(Some(SyncConfig {
                account_id,
                k_acc: unhex32(&k)?,
                device_seed: unhex32(&d)?,
                server_url,
                device_id,
            }))
        }
        _ => Err("同步配置残缺(sync_meta 只有部分键):库损坏或写入中断".into()),
    }
}

/// 由种子还原 Ed25519 公钥(配对/创号只在内存持种子,pubkey 每次现算不另存)。
fn pubkey_of(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

/// 写正式配置(单事务,全有或全无)。`epoch_source`=创号设备:直接落
/// `bootstrapped_at`——创号者即同步纪元源,永不引导;加入者不落,传输任务见它缺席即知
/// 要先引导。密钥材料在此之前只存在于配对/创号 attempt 的内存里(multispace-plan §4:
/// 不预生成、不落 pending;中途崩溃 = 本地仍视为未配置,重试可能撞服务器已烧的身份
/// → 人话指引清库重来,不做恢复机械)。
fn save_config(
    conn: &mut Connection,
    account_id: &str,
    k_acc: &[u8; 32],
    device_seed: &[u8; 32],
    server_url: &str,
    epoch_source: bool,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let already: Option<String> = {
        use rusqlite::OptionalExtension;
        tx.query_row("SELECT value FROM sync_meta WHERE key = 'account_id'", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
    };
    if already.is_some() {
        return Err("本机已加入账户".into());
    }
    for (k, v) in [
        ("account_id", account_id.to_string()),
        ("k_acc", hex(k_acc)),
        ("device_key", hex(device_seed)),
        ("server_url", server_url.to_string()),
    ] {
        tx.execute("INSERT INTO sync_meta (key, value) VALUES (?1, ?2)", (k, v))
            .map_err(|e| e.to_string())?;
    }
    if epoch_source {
        tx.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('bootstrapped_at', ?1)",
            [crate::repo::now_iso()],
        )
        .map_err(|e| e.to_string())?;
        // 纪元标记(epoch-plan §3.5):创号前严格电池已过(create_account 关旁路),
        // 随配置同事务落 `epoch=2`。UPSERT——legacy 未配置库走本地轮换压实后再创号,
        // 彼时 epoch 键已在。加入者不落,引导导入事务负责(§3.3 收端)。
        tx.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('epoch', '2') \
             ON CONFLICT(key) DO UPDATE SET value = '2'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 改服务器地址(运营者迁服务器时用;须已配置)。只验形态不试连——写入后由调用方
/// poke `Control::Reconfigured`,连不连得上在状态面里响亮。
pub fn set_server(conn: &Connection, url: &str) -> Result<(), String> {
    ws_endpoint(url)?;
    if meta_get(conn, "account_id")?.is_none() {
        return Err("尚未加入账户(先创建账户或用配对码加入)".into());
    }
    meta_put(conn, "server_url", url.trim().trim_end_matches('/'))
}

/// 恢复码(K_acc 的人眼形态,Crockford base32)——设置面板「查看恢复码」的复读入口。
/// 密钥本体不出 core(P4-a 窄公开面,android-plan §1 M2):k_acc 在这里取、在这里转码,
/// app 壳只见转好的码。未加入账户 = 用户可读错误,不是 None 兜底。
pub fn recovery_code(conn: &Connection) -> Result<String, String> {
    let cfg = load_config(conn)?.ok_or_else(|| "尚未加入账户".to_string())?;
    Ok(crypto::recovery_code(&cfg.k_acc))
}

/// 本库已配置的账户 id(未加入账户 = None)。桌面多空间(sync-plan §六)的跨库身份
/// 校验读口:空间=账户要求一对一,壳层启动 transport 前查各库 account_id 全局互异。
/// 只出账户 id;密钥材料仍不出 crate。
pub fn account_id(conn: &Connection) -> Result<Option<String>, String> {
    meta_get(conn, "account_id")
}

/// 还缺字节的图数(= engine `derive_missing_blobs` 同一判据:有 image_add、无
/// image_tombstone、宿主 item 活着、`item_image` 行未建)。117 安卓 Full 下行后,
/// 壳层「全部同步」的追赶判定用:字节还在途 = 这轮不算「追赶到头」,不许把
/// 拉了一半的图报成 connected(codex H2)。派生不存,读口无副作用。
pub fn pending_blob_count(conn: &Connection) -> Result<i64, String> {
    crate::sync::engine::pending_blob_count(conn)
}

/// BootReq 服务闸的「无缺字节」防线 + 快照生产(phone-space-plan §1.1)。**查与照
/// 必须在同一把 conn 锁内**(调用方持锁调本函数)——「先查、松锁、再照」的窗口里
/// 落进新的 image_add,洞照样进快照。返回三态:`Ok(Some)` = 无洞,快照已产;
/// `Ok(None)` = 本端图字节有洞,静默不供(对方超时轮转到全量端);`Err` = 完整性
/// 查询本机故障,响亮拒供——**绝不把查询失败当 0 供出洞快照**(fail-fast)。
/// 注意 0 只证明「快照那一刻无图字节洞」,不证明本端已拿到全账户最新 op(引导
/// 本就不承诺「最新」,追赶靠 joiner 之后的 want 补洞)。
pub(crate) fn boot_serve_snapshot(
    conn: &Connection,
    data_dir: &Path,
) -> Result<Option<boot::Snapshot>, String> {
    match pending_blob_count(conn) {
        Ok(0) => boot::make_snapshot(conn, data_dir).map(Some),
        Ok(_) => Ok(None),
        Err(e) => Err(format!("图字节完整性检查失败:{e}")),
    }
}

/// 退出账户:清全部同步配置(五键全有或全无的不变量由本层维护,清除也归这里),
/// 库回到「未加入账户」态。桌面多空间的账户唯一性闸用(§六④:配对/创号把一个
/// 已被别的空间占用的账户配了进来 → 本空间当场退回,绝不留下「两库同账户」的
/// 持久状态让下次上线互灌数据)。device_id 行不动(设备身份是史实,有冻结触发器);
/// 服务器端已注册的设备身份由将来的 revoke_device 清理,多一台永不上线的设备无害。
pub fn clear_config(conn: &mut Connection) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for key in
        ["account_id", "k_acc", "device_key", "server_url", "last_pushed", "bootstrapped_at"]
    {
        tx.execute("DELETE FROM sync_meta WHERE key = ?1", [key]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 已 ack 的出站游标(缺席 = 0:从未获过 ack 的真实语义,不是默认值兜底)。
fn read_last_pushed(conn: &Connection) -> Result<i64, String> {
    match meta_get(conn, "last_pushed")? {
        None => Ok(0),
        Some(v) => v.parse().map_err(|_| format!("sync_meta.last_pushed 不是整数:{v}")),
    }
}

/// ack 到手即抬游标(只升不降;乱序 ack 下 MAX 语义)。
fn bump_last_pushed(conn: &Connection, seq: i64) -> Result<(), String> {
    let cur = read_last_pushed(conn)?;
    if seq > cur {
        meta_put(conn, "last_pushed", &seq.to_string())?;
    }
    Ok(())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// (pub(crate):spaces::read_descriptor 用同一口径在 catalog 层验密钥形态,
/// 免得两处 hex 校验各自漂移。)
pub(crate) fn unhex32(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("sync_meta 里的密钥不是 64 位 hex(库损坏?)".into());
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).expect("hex 是 ASCII"), 16)
            .expect("上面已验 hexdigit");
    }
    Ok(out)
}

/// 目录所在卷的可用字节数(引导空间预检用)。None = 平台拿不到统计——只跳过预检,
/// 不影响正确性(写盘失败仍 fail-fast 响亮);unix(安卓/linux/mac)走 statvfs。
#[cfg(unix)]
fn free_space(dir: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

#[cfg(not(unix))]
fn free_space(_dir: &std::path::Path) -> Option<u64> {
    None
}

/// 空间预检的纯判定(可单测):快照 bytes(已过 BootReceiver::start 的 (0, 8GiB]
/// sanity)需要 3× 峰值;不足 = Some(需要的字节数),足够 = None。
fn boot_space_shortfall(free: u64, bytes: i64) -> Option<u64> {
    let need = (bytes as u64).saturating_mul(3);
    if free < need {
        Some(need)
    } else {
        None
    }
}

/// 字节数的人眼形态(引导空间预检的报错文案)。
fn human_bytes(b: u64) -> String {
    if b >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", b as f64 / (1024.0 * 1024.0 * 1024.0))
    } else {
        format!("{:.1} MB", b as f64 / (1024.0 * 1024.0))
    }
}

/// 服务器地址 → WS 端点(路径恒 `/ws`,§4)。只认 ws:// 与 wss://,不做协议猜换。
fn ws_endpoint(server_url: &str) -> Result<String, String> {
    let u = server_url.trim().trim_end_matches('/');
    if !(u.starts_with("ws://") || u.starts_with("wss://")) {
        return Err("服务器地址应以 ws:// 或 wss:// 开头".into());
    }
    Ok(if u.ends_with("/ws") { u.to_string() } else { format!("{u}/ws") })
}

/// 服务器 Err code → 人话(msg 兜底;code 见 sync-proto err_code)。
/// 注意:创号三类错误(NOT_FIRST/AUTH_FAILED/DEVICE_ID_TAKEN)在 create_account
/// 内单独映射(open-signup §2:账户 ULID 自生成后语义全变了),不走这里。
fn human_err(code: &str, msg: &str) -> String {
    match code {
        err_code::AUTH_FAILED => "服务器拒绝(账户被封禁,或本设备未注册/已吊销)".into(),
        err_code::NOT_FIRST => {
            "该账户已有设备:在老设备上「添加设备」出配对码加入".into()
        }
        // 注意:创号路径不走这条(create_account 单独映射「不要清库」)——这里的
        // 清库指引只对「配对中途失败/整库拷贝」正确(phone-space-plan §2.1)。
        err_code::DEVICE_ID_TAKEN => {
            "设备身份已被服务器占用(上次配对中途失败,或这份数据是整库拷贝):请清除本空间数据后重新配对".into()
        }
        err_code::BAD_SLOT => "配对码无效或已过期(每个配对码只能用一次)".into(),
        err_code::ACCOUNT_FULL => {
            "账户设备数已达服务器上限:先在服务端吊销一台不用的设备,再加新设备".into()
        }
        err_code::SEAT_LIMIT => {
            "同步席位已满:请先移除一台不用的设备,再添加新设备".into()
        }
        err_code::BUSY => "服务器繁忙,稍后再试".into(),
        err_code::NOT_ONLINE => "对方设备不在线".into(),
        _ => format!("服务器拒绝:{msg}"),
    }
}

// ---- 专用短连接流程(命令面直调,不经传输任务) ----

/// 创建账户(§8;open-signup 无感创号):账户 ULID 本函数自生成——服务器准入
/// 开放,fresh 账户直接 TOFU,用户全程无码。专用短连接 register_first(§4 原子
/// TOFU 首台),成功即写配置(含纪元标记)并返回恢复码(强制仪式的数据面)。
/// 之后 poke `Control::Reconfigured` 让传输任务上线。
///
/// 碰撞论证(open-signup §1.4):ULID = 48-bit 时间戳 + 80-bit 随机,与 device/
/// item 身份同一假设强度;撞上服务器已有账户也只得 not_first,发生在写本地配置
/// 之前,重试即换新 ID。
///
/// 本包装**只许尾调用**(词法闸钉着):生成与网络全在 `create_account_as` 内、
/// 严格电池之后,包装层不得再加任何暂停点。
pub async fn create_account(
    db: &Arc<Mutex<Connection>>,
    server_url: &str,
) -> Result<String, String> {
    create_account_as(db, server_url, None).await
}

/// 定点账户版(`create_account` 的全部实现;`fixed_account_id` 是 `pub(crate)`
/// 测试注入口,公开面只有 None=自生成——open-signup §2 不留第二公开入口)。
pub(crate) async fn create_account_as(
    db: &Arc<Mutex<Connection>>,
    server_url: &str,
    fixed_account_id: Option<&str>,
) -> Result<String, String> {
    let url = ws_endpoint(server_url)?;
    let device_id = {
        let conn = db.lock().expect("db mutex poisoned");
        if load_config(&conn)?.is_some() {
            return Err("本机已加入账户".into());
        }
        // 创号端严格认证(epoch-plan §3.5,create_account 关旁路):「创号新库天生零
        // legacy」不是事实——main 空间允许先有本地记录。RegisterFirst **之前**就跑
        // 严格电池,不过则网络注册都不发生(legacy 未配置库要无损创号:先走本地身份
        // 轮换压实 epoch::compact,再回来创号)。
        boot::strict_battery(&conn).map_err(|e| {
            format!("本空间历史数据早于同步纪元,不能直接创建账户(严格审计:{e})——先执行压实/认证,或清空本空间")
        })?;
        meta_get(&conn, "device_id")?.ok_or_else(|| "sync_meta 缺 device_id".to_string())?
    };
    // 账户身份在严格电池**之后**才产生(open-signup §2 顺序纪律,审 L5):公开路
    // 自生成,同一值随后用于签名与 save_config;电池不过则连 ID 都不生成。
    let account_id = match fixed_account_id {
        Some(id) => id.to_owned(),
        None => ulid::Ulid::new().to_string(),
    };
    let account_id = account_id.as_str();
    // 密钥材料 attempt 内存生成、Done 才落库(multispace-plan §4:不进 pending)。
    // 注册后、落库前中断(取消/崩溃)= 服务器留下孤儿注册:重试自生成新账户 ULID、
    // 同 device_id 撞 device_id_taken(文案带设备号);恢复=运营者按 device 反查
    // 吊销孤儿后**原库原样重试,不清库**(open-signup §1.5)。不加恢复机械。
    let mut k_acc = [0u8; 32];
    OsRng.fill_bytes(&mut k_acc);
    let (seed, _pub) = pair::gen_device_key();
    let pubkey = pubkey_of(&seed);
    let code = crypto::recovery_code(&k_acc);
    // 把解析器焊在生成路径上:编解不再互逆 = 实现漂移,当场响亮(恢复流程 P2-h 用它)。
    assert_eq!(crypto::parse_recovery_code(&code), Ok(k_acc), "恢复码编解必须互逆");

    let mut ws = dial(&url).await?;
    let nonce = expect_challenge(&mut ws).await?;
    let signing = SigningKey::from_bytes(&seed);
    let sig = signing.sign(&register_first_sig_payload(&nonce, account_id, &device_id, &pubkey));
    send_client(&mut ws, &ClientMsg::RegisterFirst {
        account: account_id.into(),
        device: device_id.clone(),
        pubkey: pubkey.to_vec(),
        sig: sig.to_bytes().to_vec(),
        caps: vec![], // 工序4:本轮客户端不声明能力(编译兼容;声明 cap 与渲染属未来轮)。
    })
    .await?;
    loop {
        match recv_server(&mut ws, HANDSHAKE_SECS).await? {
            ServerMsg::Authed => break,
            ServerMsg::Err { code, msg } => {
                // 创号三类错误单独映射(open-signup §2:账户 ULID 自生成后语义
                // 全变——NOT_FIRST 不再意味着「用户的老账户」,只能是生成 ID 撞上
                // 已有/并发占用;AUTH_FAILED 只能是封禁或服务端异常;DEVICE_ID_TAKEN
                // 才是孤儿恢复正路,文案带本机 device_id 供运营者按设备反查吊销,
                // **不要清库**——main 的本地记录会被白白清掉,吊销后原库原样重试)。
                return Err(match code.as_str() {
                    err_code::DEVICE_ID_TAKEN => format!(
                        "设备身份仍被之前的注册占用(多半是上次创号中断留下的孤儿):不要清库——把本机设备号 {device_id} 报给运营者吊销后,在本空间原样重试"
                    ),
                    err_code::NOT_FIRST => "账户标识冲突(生成的账户号撞上了已有账户,概率极低):重试一次即换新号".to_string(),
                    err_code::AUTH_FAILED => "服务器拒绝创建账户(账户可能被封禁,或服务端版本不符)".to_string(),
                    _ => human_err(&code, &msg),
                });
            }
            _ => continue,
        }
    }
    // 提交边界纪律(phone-space-plan §1.2,对齐 pair_join):`save_config` 是
    // **最后线性化点**,且 Authed 之后到返回**一个 await 都没有**——连 close 都
    // 不发(同步 drop 关 TCP;实现审 M1:礼貌 close 可以无界 Pending,不切空间
    // 就永远「创建中」、切空间就把已注册变孤儿)。服务器对突然断开本就有 detach
    // 处理。壳层用 shutdown select! 包住本 future 时,取消要么落在提交前(什么
    // 都没写),要么根本抢不进提交后——绝不「报已取消、账户实已落库、码丢失」。
    drop(ws);
    {
        let mut conn = db.lock().expect("db mutex poisoned");
        save_config(&mut conn, account_id, &k_acc, &seed, server_url, true)?;
    }
    Ok(code)
}

/// 加入账户(§8 sync_pair_join):专用短连接入配对槽跑 SPAKE2(joiner 侧),拿到
/// 账户材料即写配置(不落纪元标记——引导未做)。之后 poke `Control::Reconfigured`,
/// 传输任务 auth 后见 bootstrapped_at 缺席自动走引导。
///
/// `account_gate`:两阶段账户唯一闸(multispace-plan §4,`Grant → gate → Enroll`)
/// ——joiner 在 [`PairOutput::GrantPending`] 停点交出 account_id,Err = PairClose
/// 走人:**Enroll 从未发出、老端从不注册、配置一个键都不写**,本机设备身份不烧、
/// 重扫别的账户照常(工序 7/8 审查 H1:gate 若卡在 Done 之后,误扫已占用账户会
/// 白白烧掉本机 device_id)。裁决先于一切可见状态:材料从未落库,并发控制命令
/// 看不到任何中间态。
pub async fn pair_join(
    db: &Arc<Mutex<Connection>>,
    server_url: &str,
    code: &str,
    account_gate: impl Fn(&str) -> Result<(), String> + Send,
) -> Result<(), String> {
    let url = ws_endpoint(server_url)?;
    let (slot, secret) = pair::parse_pair_code(code).map_err(|e| e.to_string())?;
    let device_id = {
        let conn = db.lock().expect("db mutex poisoned");
        if load_config(&conn)?.is_some() {
            return Err("本机已加入账户".into());
        }
        // 提前响亮(legacy 数据给人话指引);导入事务内还会重验,这里不是并发方案。
        boot::check_fresh_to_account(&conn)?;
        meta_get(&conn, "device_id")?.ok_or_else(|| "sync_meta 缺 device_id".to_string())?
    };
    // 设备种子 attempt 内存生成、Done 才随配置落库(multispace-plan §4:不进 pending)。
    // enroll 后、落库前崩溃 = 同 device_id 换新 pubkey 重试会撞 device_id_taken
    // → 人话指引清掉该空间重来(§4 拍板:服务器残留一个永不上线的 device_id 可接受)。
    let (seed, _pub) = pair::gen_device_key();
    let pubkey = pubkey_of(&seed);
    let mut joiner =
        pair::Joiner::new(slot, &secret, DeviceEnroll { device_id, pubkey: pubkey.to_vec() });

    let mut ws = dial(&url).await?;
    send_client(&mut ws, &ClientMsg::PairJoin { slot }).await?;
    let grant: AccountGrant = loop {
        match recv_server(&mut ws, PAIR_TIMEOUT_SECS).await? {
            ServerMsg::Challenge { .. } => continue, // 连接即发;配对入口用不上。
            ServerMsg::PairMsg { blob, .. } => {
                let outs = match joiner.on_msg(&blob) {
                    Ok(o) => o,
                    Err(e) => {
                        let _ = send_client(&mut ws, &ClientMsg::PairClose { slot }).await;
                        return Err(e.to_string());
                    }
                };
                let mut got = None;
                for o in outs {
                    match o {
                        PairOutput::Send(b) => {
                            send_client(&mut ws, &ClientMsg::PairMsg { slot, blob: b }).await?;
                        }
                        // §4 两阶段停点(工序 7/8 审查 H1):Grant 解出、Enroll 未发。
                        // gate 拒 = PairClose 走人——老端从未收到 Enroll、register_device
                        // 从未发生,本机设备身份不烧、重扫别的账户照常。
                        PairOutput::GrantPending { account_id } => {
                            if let Err(e) = account_gate(&account_id) {
                                let _ =
                                    send_client(&mut ws, &ClientMsg::PairClose { slot }).await;
                                let _ = ws.close(None).await;
                                return Err(e);
                            }
                            for a in joiner.approve().map_err(|e| e.to_string())? {
                                match a {
                                    PairOutput::Send(b) => {
                                        send_client(&mut ws, &ClientMsg::PairMsg { slot, blob: b })
                                            .await?;
                                    }
                                    other => return Err(format!("approve 不该输出 {other:?}")),
                                }
                            }
                        }
                        PairOutput::Granted(g) => got = Some(g),
                        other => return Err(format!("joiner 不该输出 {other:?}")),
                    }
                }
                if let Some(g) = got {
                    break g;
                }
            }
            ServerMsg::PairPeer { event: PairEvent::Left | PairEvent::Closed } => {
                return Err("配对被对端中止(配对码不对,或对方已关闭)".into());
            }
            ServerMsg::Err { code, msg } => return Err(human_err(&code, &msg)),
            _ => continue,
        }
    };
    let k: [u8; 32] = grant
        .k_acc
        .as_slice()
        .try_into()
        .map_err(|_| "账户材料 K_acc 长度不对".to_string())?;
    // save_config 必须是本 future 最后一个、其后无 await 的线性化点(工序 9 二审 H1):
    // 外层壳把 pair_join 未决 + shutdown 当「取消」——若提交后还有 await(旧顺序里
    // 的 ws.close),shutdown 落在那一刻会把「配置已落盘的成功配对」误报成「已取消」
    // (DB 已配、catalog 却显示未配,重启才自愈)。故先 best-effort 关 socket(此时
    // 尚未提交:落此 await 被取消 = 本地未配置、§19),再提交、立即返回(无 await)。
    let _ = ws.close(None).await;
    {
        let mut conn = db.lock().expect("db mutex poisoned");
        save_config(&mut conn, &grant.account_id, &k, &seed, &grant.server_url, false)?;
    }
    Ok(())
}

// ---- 纪元切换:锚点新身份预注册(epoch-plan §2.2,两阶段状态机) ----

/// pending 身份封闸判定(§2.2):pending 键存在 = 纪元切换进行中,本库**禁普通同步**
/// ——Prepared 态只允许 [`register_pending_identity`] 的专用注册短连接重试;Registered
/// 态起以任何身份都拒,直到 `epoch::compact` 消费 bundle 后闸自动解除。Some(人话) = 封。
pub(crate) fn pending_identity_block(conn: &Connection) -> Result<Option<String>, String> {
    match meta_get(conn, "pending_state")?.as_deref() {
        None => {}
        Some("prepared") => {
            return Ok(Some(
                "纪元切换进行中(新身份已备、注册未确认):普通同步已封闸,请完成新身份注册与离线压实".into(),
            ))
        }
        Some("registered") => {
            return Ok(Some(
                "纪元切换进行中(新身份已注册):普通同步已封闸,完成离线压实后自动恢复".into(),
            ))
        }
        Some(other) => {
            return Ok(Some(format!("pending 身份状态异常:「{other}」(库损坏?),拒绝同步")))
        }
    }
    // 无状态键但材料键残留 = 状态机被绕过/写入撕裂(M2:任一在场即封,不挑着看)。
    for k in ["pending_device_id", "pending_device_key", "pending_pubkey"] {
        if meta_get(conn, k)?.is_some() {
            return Ok(Some(format!("pending 身份材料残留({k} 无状态键):库状态异常,拒绝同步")));
        }
    }
    Ok(None)
}

/// 预注册新锚点身份(epoch-plan §2.2,`epoch::compact` Configured 型的前置)。
/// 专用短连接,两阶段崩溃安全:
///
/// 1. **Prepared**:生成新 device_id/种子并**先落盘**(sync_meta `pending_*` 四键;
///    库是 WAL + synchronous=FULL 默认,commit 即 fsync WAL——掉电不丢),才碰网络;
/// 2. 以**旧身份**鉴权(Challenge→Auth),先发 `seat_lease` 求纪元席位租约
///    (billing-plan §5 工序 2:满席账户「先预注册、后吊旧」需要 +1;绑定本次
///    bundle 的目标身份,同连接内秒级消费),再发 `register_device` 自背书,等
///    Registered;
/// 3. **Registered**:Ack 到手才原子改标(提交后零 await,create_account 同纪律)。
///
/// 崩溃恢复:任一点断掉后重跑本函数——Prepared 残留则**以同一 bundle 原样重试**
/// (整流程重走「求租→注册」:已消费后的重试,求租对已注册同钥目标回 Ok 不开租、
/// 注册走服务器同账户同钥幂等分支,registry「幂等先于配额」注记);已 Registered 则
/// 幂等返回。**绝不静默重生成材料**——重生成会在服务器留下第二个孤儿注册。
///
/// `id_gate`:新 device_id 的本地跨空间唯一闸(spaces 四不变量,壳层递入);裁决先于
/// 落盘,拒了一个键都不写。调用方契约:持本空间 WriterLease、普通 transport 已停
/// (成功后本库被 [`pending_identity_block`] 封闸,直到压实消费)。返回新 device_id。
pub async fn register_pending_identity(
    db: &Arc<Mutex<Connection>>,
    id_gate: impl Fn(&str) -> Result<(), String> + Send,
) -> Result<String, String> {
    // ---- 阶段判读 + Prepared 落盘(同一把锁内做完) ----
    let (cfg, new_id, pubkey) = {
        let conn = db.lock().expect("db mutex poisoned");
        let cfg = load_config(&conn)?.ok_or_else(|| {
            "本空间尚未加入账户:未配置库走本地身份轮换压实(Unconfigured),无需预注册".to_string()
        })?;
        match meta_get(&conn, "pending_state")?.as_deref() {
            Some("registered") => {
                // 幂等:已注册,等压实消费。材料必须齐且自洽(L1:有状态无材料/
                // 种子对不上公钥 = 库损坏,错误的成功返回会误导运维往下走压实)。
                let (Some(id), Some(seed_hex), Some(pub_hex)) = (
                    meta_get(&conn, "pending_device_id")?,
                    meta_get(&conn, "pending_device_key")?,
                    meta_get(&conn, "pending_pubkey")?,
                ) else {
                    return Err("pending 状态为 registered 但材料残缺(库损坏?)".into());
                };
                if hex(&pubkey_of(&unhex32(&seed_hex)?)) != pub_hex {
                    return Err("pending 种子派生的公钥与落盘公钥不符(材料损坏)".into());
                }
                return Ok(id);
            }
            Some("prepared") => {
                // 崩溃恢复:同一 bundle 原样重试。先验材料完整性(种子派生公钥 ==
                // 落盘公钥),损坏就响亮停下要人工——静默重生成会造第二个孤儿注册。
                let (Some(id), Some(seed_hex), Some(pub_hex)) = (
                    meta_get(&conn, "pending_device_id")?,
                    meta_get(&conn, "pending_device_key")?,
                    meta_get(&conn, "pending_pubkey")?,
                ) else {
                    return Err("pending 状态为 prepared 但材料残缺(库损坏?),拒绝重试".into());
                };
                let seed = unhex32(&seed_hex)?;
                if hex(&pubkey_of(&seed)) != pub_hex {
                    return Err("pending 种子派生的公钥与落盘公钥不符(材料损坏),拒绝重试".into());
                }
                (cfg, id, pubkey_of(&seed))
            }
            Some(other) => {
                return Err(format!("pending 身份状态异常:「{other}」(库损坏?)"));
            }
            None => {
                // M2:无状态键但材料键残留 = 上次写入撕裂/被绕过——响亮拒,不静默
                // 覆盖(覆盖会把「异常现场」洗成「正常新预注册」)。
                for k in ["pending_device_id", "pending_device_key", "pending_pubkey"] {
                    if meta_get(&conn, k)?.is_some() {
                        return Err(format!("pending 材料残留({k} 无状态键):库状态异常,先人工核对"));
                    }
                }
                let id = ulid::Ulid::new().to_string();
                if id == cfg.device_id {
                    return Err("新 device_id 与旧身份相同(必是 bug)".into());
                }
                id_gate(&id)?;
                let (seed, _pub) = pair::gen_device_key();
                let pubkey = pubkey_of(&seed);
                // Prepared 落盘先于任何网络动作(§2.2 崩溃窗:先注册后落盘 = 注册
                // 成功但本地失忆,同 device_id 换新钥重试撞 device_id_taken 死路)。
                // 单事务四键同生共死;WAL + synchronous=FULL(db.rs 不改默认)
                // commit 即 fsync。
                conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
                let write = (|| -> Result<(), String> {
                    meta_put(&conn, "pending_device_id", &id)?;
                    meta_put(&conn, "pending_device_key", &hex(&seed))?;
                    meta_put(&conn, "pending_pubkey", &hex(&pubkey))?;
                    meta_put(&conn, "pending_state", "prepared")
                })();
                if let Err(e) = write {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(e);
                }
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                (cfg, id, pubkey)
            }
        }
    };

    // ---- 以旧身份鉴权的专用注册短连接 ----
    let url = ws_endpoint(&cfg.server_url)?;
    let mut ws = dial(&url).await?;
    let nonce = expect_challenge(&mut ws).await?;
    let signing = SigningKey::from_bytes(&cfg.device_seed);
    let sig = signing.sign(&auth_sig_payload(&nonce, &cfg.account_id, &cfg.device_id));
    send_client(&mut ws, &ClientMsg::Auth {
        account: cfg.account_id.clone(),
        device: cfg.device_id.clone(),
        sig: sig.to_bytes().to_vec(),
        caps: vec![], // 工序4:本轮客户端不声明能力(编译兼容;声明 cap 与渲染属未来轮)。
    })
    .await?;
    loop {
        match recv_server(&mut ws, HANDSHAKE_SECS).await? {
            ServerMsg::Authed => break,
            ServerMsg::Err { code, msg } => return Err(human_err(&code, &msg)),
            _ => continue,
        }
    }
    // 席位租约(billing-plan §5 工序 2):满席账户的纪元预注册靠它 +1;未满席时
    // 求租同样无害(注册即消费)。绑定本次 bundle 的 (new_id, pubkey) 不可换目标。
    let lease_sig = signing.sign(&seat_lease_sig_payload(&cfg.account_id, &new_id, &pubkey));
    send_client(&mut ws, &ClientMsg::SeatLease {
        account: cfg.account_id.clone(),
        new_device: new_id.clone(),
        new_pubkey: pubkey.to_vec(),
        sig_by_old: lease_sig.to_bytes().to_vec(),
    })
    .await?;
    loop {
        match recv_server(&mut ws, HANDSHAKE_SECS).await? {
            ServerMsg::SeatLease { device } if device == new_id => break,
            ServerMsg::SeatLease { .. } => continue, // 迟到回执,不是本次的
            ServerMsg::Err { code, msg } => {
                // 与注册路同话术:此路的 DEVICE_ID_TAKEN 同样不许给「清库重配」指引。
                return Err(if code == err_code::DEVICE_ID_TAKEN {
                    "预注册的新设备身份已被占用(异常):不要清库——联系运营者核对后吊销冲突方,再原样重试".to_string()
                } else {
                    human_err(&code, &msg)
                });
            }
            _ => continue,
        }
    }
    let reg_sig = signing.sign(&register_device_sig_payload(&cfg.account_id, &new_id, &pubkey));
    send_client(&mut ws, &ClientMsg::RegisterDevice {
        account: cfg.account_id.clone(),
        new_device: new_id.clone(),
        new_pubkey: pubkey.to_vec(),
        sig_by_old: reg_sig.to_bytes().to_vec(),
    })
    .await?;
    loop {
        match recv_server(&mut ws, HANDSHAKE_SECS).await? {
            ServerMsg::Registered { device } if device == new_id => break,
            ServerMsg::Registered { .. } => continue, // 别台注册的迟到回执,不是本次的
            ServerMsg::Err { code, msg } => {
                // 通用 DEVICE_ID_TAKEN 文案的「清库重配」对锚点是灾难话术;此路
                // 唯一诚实指引 = 人工处置(bundle 在盘上,吊销冲突方后原样重试)。
                return Err(if code == err_code::DEVICE_ID_TAKEN {
                    "预注册的新设备身份已被占用(异常):不要清库——联系运营者核对后吊销冲突方,再原样重试".to_string()
                } else {
                    human_err(&code, &msg)
                });
            }
            _ => continue,
        }
    }
    // Ack 到手 → 原子改标 Registered(提交后零 await;先同步 drop 关 TCP)。
    // Ack 后、改标前崩 = 本地仍 prepared,重跑同 bundle,服务器幂等吸收。
    drop(ws);
    {
        let conn = db.lock().expect("db mutex poisoned");
        meta_put(&conn, "pending_state", "registered")?;
    }
    Ok(new_id)
}

// ---- M3 网络栈真机闸门诊断(android-plan §9) ----

/// [`net_probe`] 的单项结果:`name` 是稳定标识,`detail` 是佐证或失败原因(人话)。
#[derive(Debug, Clone, Serialize)]
pub struct ProbeStep {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

fn probe_step(name: &'static str, r: Result<String, String>) -> ProbeStep {
    match r {
        Ok(detail) => ProbeStep { name, ok: true, detail },
        Err(detail) => ProbeStep { name, ok: false, detail },
    }
}

/// M3 网络栈真机闸门(android-plan §9):逐项真跑同步栈的密码学与网络路径,给安卓
/// 诊断页当验收面——62 的 rusqlite 绿灯不外推到 WSS(ring 含 C/汇编、依赖 NDK clang,
/// 必须真机逐项证)。跑的就是真同步用的那套代码(pair/crypto/dial),不是平行实现;
/// 单测对本地服务全绿 = 诊断逻辑正确,真机再跑只剩平台差异。六项独立跑完不短路:
/// 诊断要全景,红哪项报哪项。
pub async fn net_probe(server_url: &str) -> Vec<ProbeStep> {
    vec![
        probe_step("tls-provider", probe_tls_provider()),
        probe_step("os-rng", probe_os_rng()),
        probe_step("ed25519", probe_ed25519()),
        probe_step("spake2-pair", probe_pair_roundtrip()),
        probe_step("xchacha-hkdf", probe_frame_roundtrip()),
        probe_step("wss-challenge", probe_challenge(server_url).await),
    ]
}

/// ring 提供者已装(app 壳 run() 的 install_default 纪律,android-plan §1 M2)+
/// TLS 客户端配置可构造(84 真机回归锚 `wss_tls_provider_present` 的运行期形态)。
fn probe_tls_provider() -> Result<String, String> {
    let p = rustls::crypto::CryptoProvider::get_default().ok_or_else(|| {
        "CryptoProvider 未安装——app 壳 run() 必须先 install_default".to_string()
    })?;
    let _ = rustls::ClientConfig::builder()
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth();
    Ok(format!("ring 已装({} 套密码组),TLS 配置可构造", p.cipher_suites.len()))
}

/// 系统熵源(密钥/nonce 的唯一来源):两把 32B 各异且非全零。
fn probe_os_rng() -> Result<String, String> {
    let mut a = [0u8; 32];
    let mut b = [0u8; 32];
    OsRng.try_fill_bytes(&mut a).map_err(|e| format!("OsRng 不可用:{e}"))?;
    OsRng.try_fill_bytes(&mut b).map_err(|e| format!("OsRng 不可用:{e}"))?;
    if a == [0u8; 32] || a == b {
        return Err("OsRng 输出可疑(全零或两次相同)".into());
    }
    Ok(format!("32B×2 各异(首 4B {})", hex(&a[..4])))
}

/// Ed25519 生钥/签名/验签(设备鉴权钥同款路径),含篡改必败的反向证。
fn probe_ed25519() -> Result<String, String> {
    let (seed, pubkey) = pair::gen_device_key();
    let signing = SigningKey::from_bytes(&seed);
    let msg = b"zhujian net-probe m3";
    let sig = signing.sign(msg);
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&pubkey)
        .map_err(|e| format!("公钥不是合法曲线点:{e}"))?;
    use ed25519_dalek::Verifier;
    vk.verify(msg, &sig).map_err(|e| format!("验签失败:{e}"))?;
    if vk.verify(b"tampered", &sig).is_ok() {
        return Err("篡改消息竟验签通过".into());
    }
    Ok(format!("签验 OK(pub 首 4B {})", hex(&pubkey[..4])))
}

/// SPAKE2 配对全流程本地对跑(Opener×Joiner 互喂,pair.rs 单测同款盲桥驱动):
/// 双向材料(账户 K_acc / 设备公钥)逐字节对得上——SPAKE2 群运算 + 会话子钥
/// XChaCha 封解在本设备真跑了一遍。
fn probe_pair_roundtrip() -> Result<String, String> {
    let slot: u64 = 0xD1A6;
    let secret = pair::gen_secret();
    let mut k_acc = [0u8; 32];
    OsRng.try_fill_bytes(&mut k_acc).map_err(|e| format!("OsRng 不可用:{e}"))?;
    let account_id = ulid::Ulid::new().to_string();
    let grant = AccountGrant {
        account_id: account_id.clone(),
        k_acc: k_acc.to_vec(),
        server_url: "wss://probe.invalid/ws".into(),
    };
    let (_seed, pubkey) = pair::gen_device_key();
    let device_id = ulid::Ulid::new().to_string();
    let enroll = DeviceEnroll { device_id: device_id.clone(), pubkey: pubkey.to_vec() };

    let mut opener = pair::Opener::new(slot, &secret, grant);
    let mut joiner = pair::Joiner::new(slot, &secret, enroll);
    let mut to_joiner: Vec<Vec<u8>> = vec![];
    for out in opener.on_joined().map_err(|e| e.to_string())? {
        match out {
            PairOutput::Send(b) => to_joiner.push(b),
            other => return Err(format!("on_joined 不该输出 {other:?}")),
        }
    }
    let (reg_device, reg_pubkey) = 'bridge: loop {
        let mut to_opener: Vec<Vec<u8>> = vec![];
        for b in to_joiner.drain(..) {
            for out in joiner.on_msg(&b).map_err(|e| e.to_string())? {
                match out {
                    PairOutput::Send(x) => to_opener.push(x),
                    // §4 账户闸停点:自检即刻放行(闸逻辑不在诊断范围)。
                    PairOutput::GrantPending { .. } => {
                        for a in joiner.approve().map_err(|e| e.to_string())? {
                            match a {
                                PairOutput::Send(x) => to_opener.push(x),
                                other => return Err(format!("approve 不该输出 {other:?}")),
                            }
                        }
                    }
                    other => return Err(format!("Register 前 joiner 不该输出 {other:?}")),
                }
            }
        }
        if to_opener.is_empty() {
            return Err("配对对跑停摆(双方无帧可发也没到 Register)".into());
        }
        for b in to_opener.drain(..) {
            for out in opener.on_msg(&b).map_err(|e| e.to_string())? {
                match out {
                    PairOutput::Send(x) => to_joiner.push(x),
                    PairOutput::Register { device_id, pubkey } => {
                        break 'bridge (device_id, pubkey);
                    }
                    other => return Err(format!("opener 不该输出 {other:?}")),
                }
            }
        }
    };
    if reg_device != device_id || reg_pubkey != pubkey {
        return Err("opener 收到的设备材料与 joiner 发出的不一致".into());
    }
    let outs = opener.on_registered().map_err(|e| e.to_string())?;
    let done = match outs.first() {
        Some(PairOutput::Send(b)) => b.clone(),
        _ => return Err("on_registered 首条输出不是 Done 线报".into()),
    };
    match joiner.on_msg(&done).map_err(|e| e.to_string())?.as_slice() {
        [PairOutput::Granted(g)]
            if g.k_acc.as_slice() == k_acc.as_slice() && g.account_id == account_id => {}
        _ => return Err("joiner 拿到的账户材料与 opener 交付的不一致".into()),
    }
    Ok("SPAKE2 全流程 + 材料 AEAD 封解一致".into())
}

/// op 域封解帧 roundtrip(真同步收发的主路径):HKDF 域子钥 + XChaCha20-Poly1305 +
/// AAD 五元组;附反向证:错域解必败(域隔离在干活)。
fn probe_frame_roundtrip() -> Result<String, String> {
    let mut k_acc = [0u8; 32];
    OsRng.try_fill_bytes(&mut k_acc).map_err(|e| format!("OsRng 不可用:{e}"))?;
    let acct = ulid::Ulid::new().to_string();
    let from = ulid::Ulid::new().to_string();
    let addr = FrameAddr { account_id: &acct, from_device: &from, to: "*", domain: Domain::Op };
    let plain = format!("zhujian net-probe {}", hex(&k_acc[..4]));
    let blob = crypto::seal_msg(&k_acc, &addr, &plain);
    let opened: String = crypto::open_msg(&k_acc, &addr, &blob).map_err(|e| e.to_string())?;
    if opened != plain {
        return Err("解帧内容与封入不一致".into());
    }
    let wrong = FrameAddr { domain: Domain::Ctl, ..addr };
    if crypto::open_msg::<String>(&k_acc, &wrong, &blob) != Err(OpenError::Decrypt) {
        return Err("错域解帧竟通过(域隔离失效)".into());
    }
    Ok(format!("op 域封解 {}B 帧 OK,错域必拒", blob.len()))
}

/// 拨号到收 Challenge:DNS → TCP → (wss 则 rustls 握手,webpki roots 验证书)→
/// WS 升级 → 服务器首帧 Challenge。到这步,传输栈的平台面全部趟过;不注册不鉴权,
/// 对生产服务器零副作用。
async fn probe_challenge(server_url: &str) -> Result<String, String> {
    let url = ws_endpoint(server_url)?;
    let mut ws = dial(&url).await?;
    let nonce = expect_challenge(&mut ws).await?;
    let _ = ws.close(None).await;
    Ok(format!("{url} 已收到 Challenge({}B nonce)", nonce.len()))
}

// ---- 传输任务主循环 ----

/// 传输任务入口(tauri setup 或测试 spawn;随控制通道关闭而退出)。
/// #4(codex 二审):清理上次进程 kill/crash 残留的明文引导快照临时文件(Drop 跑不到的
/// 兜底)。**由 app setup 在任何 transport 启动前调一次**——桌面多空间共享同一 `.boot`
/// 目录,若放进 `run()` 里各 transport 无条件扫,会删掉别的空间正在传输的快照(codex 二审)。
pub fn sweep_stale_boot_files(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("boot-snapshot-") || name.starts_with("boot-recv-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 释放并删除源端引导快照临时文件:**先 drop(bo) 落 BootSender 的 File 句柄再 remove**
/// (Windows 才允许删打开中的文件)。所有 boot_out 退出点统一走这里(#4,codex 二审)。
fn discard_boot_out(bo: BootOut) {
    let path = bo.path.clone();
    drop(bo);
    let _ = std::fs::remove_file(&path);
}

/// 等停机信号变真([`Transport::shutdown`],supervisor::stop 拉高)。发送端已
/// 消亡 = 这个 transport 没有编排者(安卓 v1 常驻壳)——按「永不停机」挂起,
/// 别把 sender 没了误当停机。
async fn wait_shutdown(rx: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

pub async fn run(mut t: Transport) -> TransportExit {
    // 停机信号的局部把手(watch clone):session(&mut t) 独占借 t,同一 select 里
    // 另一分支不能再碰 t.shutdown,故循环外先克隆一份。
    let mut shutdown = t.shutdown.clone();
    let mut backoff: u64 = 1;
    loop {
        if *shutdown.borrow() {
            return TransportExit::Stopped;
        }
        let cfg = {
            let conn = t.db.lock().expect("db mutex poisoned");
            load_config(&conn)
        };
        let cfg = match cfg {
            Ok(Some(cfg)) => cfg,
            Ok(None) => {
                // 未配置:同步整个面零打扰,睡等配置/停机信号。
                set_status(&t.status, &t.events, |s| {
                    *s = SyncStatus { state: "off".into(), ..Default::default() };
                });
                tokio::select! {
                    _ = wait_shutdown(&mut shutdown) => return TransportExit::Stopped,
                    c = t.control.recv() => match c {
                        None => return TransportExit::Stopped,
                        Some(Control::Reconfigured) => continue,
                        Some(Control::PairStart { reply }) => {
                            let _ = reply.send(Err("尚未加入账户".into()));
                            continue;
                        }
                    }
                }
            }
            Err(e) => {
                // 配置残缺:响亮进状态,等人修(Reconfigured 重查)。
                set_status(&t.status, &t.events, |s| {
                    s.state = "off".into();
                    s.error = Some(e);
                });
                tokio::select! {
                    _ = wait_shutdown(&mut shutdown) => return TransportExit::Stopped,
                    c = t.control.recv() => match c {
                        None => return TransportExit::Stopped,
                        Some(Control::Reconfigured) => continue,
                        Some(Control::PairStart { reply }) => {
                            let _ = reply.send(Err("同步配置异常".into()));
                            continue;
                        }
                    }
                }
            }
        };
        // 纪元切换封闸(epoch-plan §2.2):pending 身份存在(Prepared/Registered)=
        // 本库禁普通同步,睡等 Reconfigured(压实消费 pending 后壳层 poke 解闸)。
        // 判定失败(读库错)同样封——fail-closed,不许「查不出来就当没有」。
        let block = {
            let conn = t.db.lock().expect("db mutex poisoned");
            pending_identity_block(&conn).unwrap_or_else(|e| Some(e))
        };
        if let Some(why) = block {
            set_status(&t.status, &t.events, |s| {
                s.configured = true;
                s.state = "off".into();
                s.error = Some(why);
            });
            tokio::select! {
                _ = wait_shutdown(&mut shutdown) => return TransportExit::Stopped,
                c = t.control.recv() => match c {
                    None => return TransportExit::Stopped,
                    Some(Control::Reconfigured) => continue,
                    Some(Control::PairStart { reply }) => {
                        let _ = reply.send(Err("纪元切换进行中,暂不能发起配对".into()));
                        continue;
                    }
                }
            }
        }
        set_status(&t.status, &t.events, |s| {
            s.configured = true;
            s.state = "connecting".into();
            s.account_id = Some(cfg.account_id.clone());
            s.device_id = Some(cfg.device_id.clone());
            s.server_url = Some(cfg.server_url.clone());
            s.peers_online = 0;
            s.frozen.clear();
            s.suspended = 0;
        });
        let end = tokio::select! {
            biased;
            // 停机优先,且覆盖 session 的**全部** await 点(拨号/握手/Challenge/
            // 引导/长发送):drop session future 即断连;同步段(SQLite 事务)天然
            // 跑完才到 await 点,撕不裂;Ctx::Drop 清 boot 临时文件;已发未 ack 的
            // op 未提升 last_pushed,下次连接重发、对端幂等吸收。
            _ = wait_shutdown(&mut shutdown) => return TransportExit::Stopped,
            r = session(&mut t, &cfg, &mut backoff) => r,
        };
        match end {
            Ok(SessionEnd::Reconfigured) => {
                backoff = 1;
                continue;
            }
            Ok(SessionEnd::HostGone) => return TransportExit::Stopped,
            Ok(SessionEnd::ReopenRequired(e)) => {
                // 引导已提交、连接须重开(§3.2 三轮 M2):**不进重连循环**。状态面
                // 落人话(正式 runtime 路的用户可见指引;staging 路由 JoinManager
                // 接管,状态无人看也无害),结构化退出交壳层处置。
                set_status(&t.status, &t.events, |s| {
                    s.state = "off".into();
                    s.error = Some(format!("初始同步已完成,但需要重启同步会话:{e}"));
                });
                return TransportExit::ReopenRequired { error: e };
            }
            Ok(SessionEnd::SpaceBlocked) => {
                // 空间不足:已断连止流,固定长等待后重试(状态面已有人话;
                // Reconfigured 可立即唤醒——用户清完空间不必干等)。PairStart 只
                // 回执拒绝、**不结束暂停**(codex 复核 L:否则一次配对请求就绕过
                // 固定等待,再触发一轮快照尝试)。
                set_status(&t.status, &t.events, |s| s.state = "offline".into());
                let resume = Instant::now() + Duration::from_secs(BOOT_SPACE_RETRY_SECS);
                loop {
                    tokio::select! {
                        _ = wait_shutdown(&mut shutdown) => return TransportExit::Stopped,
                        _ = tokio::time::sleep_until(resume) => break,
                        c = t.control.recv() => match c {
                            None => return TransportExit::Stopped,
                            Some(Control::Reconfigured) => { backoff = 1; break; }
                            Some(Control::PairStart { reply }) => {
                                let _ = reply.send(Err("初始同步因空间不足暂停中".into()));
                            }
                        }
                    }
                }
            }
            Err(e) => {
                set_status(&t.status, &t.events, |s| {
                    s.state = "offline".into();
                    s.error = Some(e);
                });
                let wait = Duration::from_millis(backoff * 1000 + jitter_ms());
                backoff = (backoff * 2).min(BACKOFF_MAX_SECS);
                tokio::select! {
                    _ = wait_shutdown(&mut shutdown) => return TransportExit::Stopped,
                    _ = tokio::time::sleep(wait) => {}
                    c = t.control.recv() => match c {
                        None => return TransportExit::Stopped,
                        Some(Control::Reconfigured) => { backoff = 1; }
                        Some(Control::PairStart { reply }) => {
                            let _ = reply.send(Err("未连接服务器(重连中)".into()));
                        }
                    }
                }
            }
        }
    }
}

enum SessionEnd {
    Reconfigured,
    HostGone,
    /// 引导空间不足:主动断连止住源端供流,外层固定等 [`BOOT_SPACE_RETRY_SECS`]
    /// 再连(不走 1s 起步的普通退避)。
    SpaceBlocked,
    /// 引导已提交但 DETACH 终败(§3.2):run 立即以
    /// [`TransportExit::ReopenRequired`] 整体退出,不重连。
    ReopenRequired(String),
}

fn jitter_ms() -> u64 {
    let mut b = [0u8; 2];
    OsRng.fill_bytes(&mut b);
    u64::from(u16::from_le_bytes(b)) % 500
}

async fn dial(url: &str) -> Result<Ws, String> {
    let (ws, _) = timeout(Duration::from_secs(HANDSHAKE_SECS), connect_async(url))
        .await
        .map_err(|_| format!("连接服务器超时:{url}"))?
        .map_err(|e| format!("连不上服务器:{e}"))?;
    Ok(ws)
}

async fn send_client(ws: &mut Ws, msg: &ClientMsg) -> Result<(), String> {
    ws.send(WsMsg::Binary(sync_proto::encode(msg).into()))
        .await
        .map_err(|e| format!("发送失败:{e}"))
}

async fn recv_server(ws: &mut Ws, secs: u64) -> Result<ServerMsg, String> {
    loop {
        let frame = timeout(Duration::from_secs(secs), ws.next())
            .await
            .map_err(|_| "等服务器响应超时".to_string())?
            .ok_or_else(|| "连接被服务器关闭".to_string())?
            .map_err(|e| format!("连接错误:{e}"))?;
        match frame {
            WsMsg::Binary(b) => {
                return sync_proto::decode(&b)
                    .map_err(|_| "服务器帧无法解码(两端版本不一致?)".to_string());
            }
            WsMsg::Close(_) => return Err("连接被服务器关闭".into()),
            _ => continue,
        }
    }
}

async fn expect_challenge(ws: &mut Ws) -> Result<Vec<u8>, String> {
    loop {
        match recv_server(ws, HANDSHAKE_SECS).await? {
            ServerMsg::Challenge { nonce } => return Ok(nonce),
            ServerMsg::Err { code, msg } => return Err(human_err(&code, &msg)),
            _ => continue,
        }
    }
}

fn set_status(
    status: &Arc<Mutex<SyncStatus>>,
    events: &mpsc::UnboundedSender<SyncEvent>,
    f: impl FnOnce(&mut SyncStatus),
) {
    let snap = {
        let mut s = status.lock().expect("status mutex poisoned");
        let before = s.clone();
        f(&mut s);
        if *s == before {
            return; // 没变不发事件(追赶期高频调用防刷屏)。
        }
        s.clone()
    };
    let _ = events.send(SyncEvent::Status(snap));
}

/// 有截止时刻则睡到它,没有则永睡(select 分支的空转位)。
async fn until(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

/// `Msg` 变体 → 加密域的映射(§2;两端都是本文件,**这个映射即协议**)。发送端封帧、
/// 收端 [`open_deliver`] 的变体-域一致性校验共用此单一真相源。
fn msg_domain(msg: &Msg) -> Domain {
    match msg {
        Msg::Ops { .. } => Domain::Op,
        Msg::Hello { .. } | Msg::Want { .. } => Domain::Ctl,
        _ => Domain::Blob,
    }
}

/// 一枚 Deliver 密文帧的分类结果。
enum Opened {
    /// op/ctl/blob 域的内层消息(变体-域一致性已过)。
    Data(Msg),
    /// boot 域内层消息。
    Boot(BootMsg),
    /// 认证通过但 CBOR 读不懂:对端版本较新(codex P2-d 轮 M1 的用户可见义务)。
    Skew,
    /// 认证通过但变体不属于封它的域(对端实现漂移):协议错误,拒收不算 skew。
    WrongDomain(&'static str),
    /// 四个域都解不开:密钥不一致/搅局帧。
    Undecryptable,
}

/// 逐域试解 + 变体-域一致性校验(评审 P2-g 轮 M:少了校验,坏对端可把 Hello 封进
/// op 域照样被吃下,「域映射即协议」的纪律形同虚设)。AEAD 子钥不同,错域必
/// `Decrypt`;`Codec` 只在认证通过后出现,不再试别域。
fn open_deliver(cfg: &SyncConfig, from: &str, to: &str, blob: &[u8]) -> Opened {
    for domain in [Domain::Op, Domain::Ctl, Domain::Blob] {
        let addr = FrameAddr { account_id: &cfg.account_id, from_device: from, to, domain };
        match crypto::open_msg::<Msg>(&cfg.k_acc, &addr, blob) {
            Ok(msg) => {
                if msg_domain(&msg) != domain {
                    return Opened::WrongDomain(domain.as_str());
                }
                return Opened::Data(msg);
            }
            Err(OpenError::Codec) => return Opened::Skew,
            Err(_) => {}
        }
    }
    let addr = FrameAddr { account_id: &cfg.account_id, from_device: from, to, domain: Domain::Boot };
    match crypto::open_msg::<BootMsg>(&cfg.k_acc, &addr, blob) {
        Ok(bm) => Opened::Boot(bm),
        Err(OpenError::Codec) => Opened::Skew,
        Err(_) => Opened::Undecryptable,
    }
}

/// 一条已发信封的关注点(Ack/Nack 回执驱动;每条 Send 必有恰一枚回执,map 自排水)。
enum Sent {
    /// 本机 origin 的 ops 帧:ack = 服务器接手,落 last_pushed 游标。
    OwnOps { max_seq: i64 },
    /// 引导请求(direct):nack = 对方不在线,换一台。
    BootReq,
    /// 引导快照块(direct):nack = 接收方掉线,作废本次供流。
    BootOut,
    /// 其它 direct 帧:nack = 对端不可达,通知引擎(拉流退回清单)。
    Direct { to: String },
    /// mail 帧,ack 无需动作。
    Other,
}

struct PairFlow {
    secret: String,
    slot: Option<u64>,
    opener: Option<pair::Opener>,
    reply: Option<oneshot::Sender<Result<String, String>>>,
    deadline: Instant,
}

struct BootOut {
    to: String,
    sender: BootSender,
    path: PathBuf,
}

/// 一个已鉴权会话的全部状态(连接断开即弃,可丢内存态)。
struct Ctx<'a> {
    db: Arc<Mutex<Connection>>,
    clock: Arc<Mutex<Clock>>,
    status: Arc<Mutex<SyncStatus>>,
    events: mpsc::UnboundedSender<SyncEvent>,
    data_dir: PathBuf,
    cfg: &'a SyncConfig,
    signing: SigningKey,
    blob_policy: BlobPolicy,
    allow_boot_source: bool,
    /// None = 引导中(op/ctl/blob 帧整帧丢弃,见模块注释)。
    engine: Option<Engine>,
    n: u64,
    tracked: HashMap<u64, Sent>,
    /// 账户内在线同伴(服务器 Peer 事件维护;front = 下一个引导请求对象)。
    peers: VecDeque<String>,
    boot_peer: Option<String>,
    boot_recv: Option<BootReceiver>,
    boot_deadline: Option<Instant>,
    boot_out: Option<BootOut>,
    pair: Option<PairFlow>,
    /// 引导空间不足(复核 M):置位后 session 立即以 [`SessionEnd::SpaceBlocked`]
    /// 收场——断连让源端止流,外层固定长等待。
    space_blocked: bool,
    /// 引导已提交但 DETACH 终败(space-entry-plan §3.2):置位后 session 立即以
    /// [`SessionEnd::ReopenRequired`] 收场,run 整体退出、**不重连**。
    reopen_required: Option<String>,
    /// BootCommitted latch 的本会话把手(Transport 生命周期共享,断线不销毁)。
    boot_commit: BootCommitLatch,
    /// 「连接须重开」旗的把手(判定那一刻置位,见 [`Transport::restart_flag`])。
    restart_flag: Arc<Mutex<Option<String>>>,
    skew_reported: bool,
    clock_skew_reported: bool,
}

impl Drop for Ctx<'_> {
    fn drop(&mut self) {
        // #4(codex 二审):session 任何退出点(Reconfigured/HostGone/断线/错误)都清源端
        // 明文快照。boot_recv 有自己的 Drop;kill/crash 残留由 app setup 的 sweep 兜底。
        if let Some(bo) = self.boot_out.take() {
            discard_boot_out(bo);
        }
    }
}

async fn session(
    t: &mut Transport,
    cfg: &SyncConfig,
    backoff: &mut u64,
) -> Result<SessionEnd, String> {
    let url = ws_endpoint(&cfg.server_url)?;
    let mut ws = dial(&url).await?;

    // 挑战应答鉴权(§4)。
    let nonce = expect_challenge(&mut ws).await?;
    let signing = SigningKey::from_bytes(&cfg.device_seed);
    let sig = signing.sign(&auth_sig_payload(&nonce, &cfg.account_id, &cfg.device_id));
    send_client(&mut ws, &ClientMsg::Auth {
        account: cfg.account_id.clone(),
        device: cfg.device_id.clone(),
        sig: sig.to_bytes().to_vec(),
        caps: vec![], // 工序4:本轮客户端不声明能力(编译兼容;声明 cap 与渲染属未来轮)。
    })
    .await?;
    loop {
        match recv_server(&mut ws, HANDSHAKE_SECS).await? {
            ServerMsg::Authed => break,
            ServerMsg::Err { code, msg } => return Err(human_err(&code, &msg)),
            _ => continue,
        }
    }
    *backoff = 1; // 鉴权成功才算连上,退避归位。

    let mut ctx = Ctx {
        db: t.db.clone(),
        clock: t.clock.clone(),
        status: t.status.clone(),
        events: t.events.clone(),
        data_dir: t.data_dir.clone(),
        cfg,
        signing,
        blob_policy: t.blob_policy,
        allow_boot_source: t.allow_boot_source,
        engine: None,
        n: 0,
        tracked: HashMap::new(),
        peers: VecDeque::new(),
        boot_peer: None,
        boot_recv: None,
        boot_deadline: None,
        boot_out: None,
        pair: None,
        space_blocked: false,
        reopen_required: None,
        boot_commit: t.boot_commit.clone(),
        restart_flag: t.restart_flag.clone(),
        skew_reported: false,
        clock_skew_reported: false,
    };

    // 引导判据:bootstrapped_at 缺席 = fresh-to-account 加入者,先拿快照(§6.2)。
    let boot_needed = {
        let conn = ctx.db.lock().expect("db mutex poisoned");
        meta_get(&conn, "bootstrapped_at")?.is_none()
    };
    if boot_needed {
        ctx.set_status(|s| s.state = "booting".into());
    } else {
        ctx.start_engine(&mut ws).await?;
    }

    let control = &mut t.control;
    let wrote = t.wrote.clone();
    let mut tick = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_rx = Instant::now();

    loop {
        // 封闸/身份换代栅栏(实现审 M1 四轮定形):在 frame/wrote/tick 三臂**做实际
        // 工作之前**各查一次、不节流——节流或只挂循环顶都留「唤醒事件先于下次检查」
        // 的单帧跨闸窗;逐事件几条点查 SELECT 相对帧处理本身的整事务可忽略。
        tokio::select! {
            biased;
            c = control.recv() => match c {
                None => return Ok(SessionEnd::HostGone),
                Some(Control::Reconfigured) => return Ok(SessionEnd::Reconfigured),
                Some(Control::PairStart { reply }) => {
                    if session_gate_tripped(&t.db, cfg) {
                        let _ = reply.send(Err("纪元切换进行中,暂不能发起配对".into()));
                        return Ok(SessionEnd::Reconfigured);
                    }
                    ctx.on_pair_start(&mut ws, reply).await?
                }
            },
            frame = ws.next() => {
                let frame = frame
                    .ok_or_else(|| "连接断开".to_string())?
                    .map_err(|e| format!("连接错误:{e}"))?;
                last_rx = Instant::now();
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                match frame {
                    WsMsg::Binary(b) => {
                        let msg = sync_proto::decode::<ServerMsg>(&b)
                            .map_err(|_| "服务器帧无法解码(两端版本不一致?)".to_string())?;
                        ctx.handle_server(&mut ws, msg).await?;
                        if ctx.space_blocked {
                            // 空间不足:立即收场断连(源端下一块吃 Nack 即止流),
                            // 外层按 SpaceBlocked 固定长等待,不走 1s 退避。
                            let _ = ws.close(None).await;
                            return Ok(SessionEnd::SpaceBlocked);
                        }
                        if let Some(e) = ctx.reopen_required.take() {
                            // 引导已提交但连接须重开(§3.2):断连收场,run 整体
                            // 退出——**绝不进重连循环**,也绝不在原连接 start_engine。
                            let _ = ws.close(None).await;
                            return Ok(SessionEnd::ReopenRequired(e));
                        }
                    }
                    WsMsg::Close(_) => return Err("服务器关闭了连接".into()),
                    _ => {}
                }
            },
            _ = wrote.notified() => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                if ctx.engine.is_some() {
                    let outs = {
                        let conn = ctx.db.lock().expect("db mutex poisoned");
                        ctx.engine.as_mut().expect("上一行已判").outbound(&conn)?
                    };
                    ctx.dispatch(&mut ws, outs).await?;
                }
            },
            _ = tick.tick() => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                if last_rx.elapsed() >= Duration::from_secs(SILENCE_TIMEOUT_SECS) {
                    return Err("服务器长时间无响应,重连".into());
                }
                send_client(&mut ws, &ClientMsg::Ping).await?;
                // 图拉流「无进展」超时(M1):应了 BlobHave 却沉默的来源被作废、换来源。
                if let Some(e) = ctx.engine.as_mut() {
                    let outs = e.on_tick();
                    if !outs.is_empty() {
                        ctx.dispatch(&mut ws, outs).await?;
                    }
                }
            },
            _ = until(ctx.pair.as_ref().map(|p| p.deadline)) => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                // 两段 deadline 两句话:槽还没到 = 开槽超时(15s);到了 = 码过期(§1.3)。
                let why = if ctx.pair.as_ref().is_some_and(|p| p.slot.is_none()) {
                    "等服务器分配配对槽超时".to_string()
                } else {
                    "配对超时(配对码 10 分钟内有效)".to_string()
                };
                ctx.fail_pair(&mut ws, why, true).await;
            },
            _ = until(ctx.boot_deadline) => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                // 等 Offer/块超时:换下一台在线设备重试(对方可能也在引导,§6.2)。
                ctx.boot_rotate();
                ctx.try_boot_request(&mut ws).await?;
            },
            _ = std::future::ready(()), if ctx.boot_out.is_some() => {
                // boot_out 恒就绪,两次 tick 间可推完整快照——供流也必须先过闸
                // (旧纪元库在切换中当引导源,正是隔离不变量要断的路)。
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                ctx.pump_boot_out(&mut ws).await?;
            },
        }
    }
}

impl Ctx<'_> {
    fn set_status(&self, f: impl FnOnce(&mut SyncStatus)) {
        set_status(&self.status, &self.events, f);
    }

    fn toast(&self, msg: String) {
        let _ = self.events.send(SyncEvent::Toast(msg));
    }

    /// 引导中吗(engine 未装配)。
    fn booting(&self) -> bool {
        self.engine.is_none()
    }

    /// 装配引擎并宣告在线:游标复位到已 ack 位 → on_connected(hello+缺图 want)→
    /// 顺手推送离线期间攒下的本地 op。引导完成后**必须**经此重建(boot.rs 接线契约)。
    async fn start_engine(&mut self, ws: &mut Ws) -> Result<(), String> {
        let (hello_outs, push_outs, reverify_outs, poison) = {
            let mut conn = self.db.lock().expect("db mutex poisoned");
            let mut clk = self.clock.lock().expect("clock mutex poisoned");
            let mut engine = Engine::new(&conn, self.blob_policy)?;
            engine.set_outbound_cursor(read_last_pushed(&conn)?);
            let hello = engine.on_connected(&conn)?;
            let push = engine.outbound(&conn)?;
            // 升级重验状态机(§4):校验器升过版就对隔离行重跑——修好的误判自助
            // 恢复(op 归池 + want 追帧),仍非法的抬版本保留。
            let reverify = engine.reverify_quarantined(&mut conn, &mut clk)?;
            let poison = engine.poison_status();
            self.engine = Some(engine);
            (hello, push, reverify, poison)
        };
        self.set_status(|s| {
            s.state = "online".into();
            s.error = None;
            s.quarantined = poison.0;
            s.poison_breaker = poison.1;
        });
        self.dispatch(ws, hello_outs).await?;
        self.dispatch(ws, push_outs).await?;
        self.dispatch(ws, reverify_outs).await?;
        Ok(())
    }

    // ---- 服务器消息分发 ----

    async fn handle_server(&mut self, ws: &mut Ws, msg: ServerMsg) -> Result<(), String> {
        match msg {
            ServerMsg::Deliver { from, to, blob } => self.on_deliver(ws, &from, &to, &blob).await,
            ServerMsg::Ack { n } => {
                if let Some(Sent::OwnOps { max_seq }) = self.tracked.remove(&n) {
                    let conn = self.db.lock().expect("db mutex poisoned");
                    bump_last_pushed(&conn, max_seq)?;
                }
                Ok(())
            }
            ServerMsg::Nack { n, code } => {
                match self.tracked.remove(&n) {
                    Some(Sent::BootReq) => {
                        // 请求对象不在线(刚掉线的竞态):换一台。
                        self.boot_rotate();
                        self.try_boot_request(ws).await?;
                    }
                    Some(Sent::BootOut) => {
                        // 接收方掉线:作废供流,删临时快照(drop 先落 File 句柄再删)。
                        if let Some(bo) = self.boot_out.take() {
                            discard_boot_out(bo);
                        }
                    }
                    Some(Sent::Direct { to }) => {
                        if let Some(e) = self.engine.as_mut() {
                            e.on_peer_unreachable(&to);
                        }
                    }
                    _ => {
                        let _ = code; // mail 帧不会 Nack;其余无需动作。
                    }
                }
                Ok(())
            }
            ServerMsg::Peer { device, online } => {
                if online {
                    if !self.peers.contains(&device) {
                        self.peers.push_back(device);
                    }
                } else {
                    self.peers.retain(|d| d != &device);
                    if let Some(e) = self.engine.as_mut() {
                        e.on_peer_unreachable(&device);
                    }
                    if self.boot_peer.as_deref() == Some(&device) {
                        self.boot_rotate();
                    }
                }
                let n = self.peers.len();
                self.set_status(|s| s.peers_online = n);
                if self.booting() {
                    self.try_boot_request(ws).await?;
                }
                Ok(())
            }
            ServerMsg::PairSlot { slot } => {
                let Some(p) = self.pair.as_mut() else { return Ok(()) };
                if p.slot.is_some() {
                    return Ok(());
                }
                p.slot = Some(slot);
                let grant = AccountGrant {
                    account_id: self.cfg.account_id.clone(),
                    k_acc: self.cfg.k_acc.to_vec(),
                    server_url: self.cfg.server_url.clone(),
                };
                p.opener = Some(pair::Opener::new(slot, &p.secret, grant));
                let code = pair::pair_code(slot, &p.secret);
                // 槽已到:整段配对改按码的真实 TTL 计时(开槽阶段短 deadline 作废)。
                p.deadline = Instant::now() + Duration::from_secs(PAIR_TIMEOUT_SECS);
                let delivered = p.reply.take().map(|r| r.send(Ok(code)).is_ok()).unwrap_or(false);
                if !delivered {
                    // 壳层已放弃等待(receiver drop):没人会展示这个码,留着只会让
                    // 之后每次 PairStart 都撞「已有配对在进行中」直到 TTL——立即
                    // 收口烧槽(§1.3,codex r2 N1)。
                    self.fail_pair(ws, "配对码无人接收(发起方已放弃等待)".into(), true).await;
                }
                Ok(())
            }
            ServerMsg::PairPeer { event } => match event {
                PairEvent::Joined => {
                    let _ = self.events.send(SyncEvent::Pair {
                        phase: "joined",
                        detail: "对方已连上,正在校验配对码".into(),
                    });
                    let step = self.pair.as_mut().and_then(|p| p.opener.as_mut()).map(|o| o.on_joined());
                    self.drive_pair(ws, step).await
                }
                PairEvent::Left | PairEvent::Closed => {
                    if self.pair.is_some() {
                        // 槽已随对端关闭而死:不回发 PairClose——对烧掉的槽再 Close
                        // 会招来一条迟到的 bad_slot Err,若新配对已开新槽,它会被
                        // 误杀(工序 7/8 H1 测试抓出;老路径则是状态面幽灵错误)。
                        self.fail_pair(ws, "对方离开(配对码不对,或对方取消)".into(), false)
                            .await;
                    }
                    Ok(())
                }
            },
            ServerMsg::PairMsg { slot, blob } => {
                let step = match self.pair.as_mut() {
                    Some(p) if p.slot == Some(slot) => {
                        p.opener.as_mut().map(|o| o.on_msg(&blob))
                    }
                    _ => None,
                };
                self.drive_pair(ws, step).await
            }
            ServerMsg::Registered { device } => {
                let _ = self.events.send(SyncEvent::Pair {
                    phase: "registering",
                    detail: format!("设备 {device} 已注册"),
                });
                let step = self.pair.as_mut().and_then(|p| p.opener.as_mut()).map(|o| o.on_registered());
                self.drive_pair(ws, step).await
            }
            ServerMsg::Err { code, msg } => {
                if self.pair.is_some() {
                    // bad_slot = 槽已死:别再回发 PairClose 补刀——对死槽的 Close
                    // 只会招来下一枚无法归属的迟到错误(工序 7/8 二审 M1)。
                    let close = code != err_code::BAD_SLOT;
                    self.fail_pair(ws, human_err(&code, &msg), close).await;
                } else {
                    let text = human_err(&code, &msg);
                    self.set_status(|s| s.error = Some(text));
                }
                Ok(())
            }
            // SeatLease 回执只属于纪元预注册的专用短连接(register_pending_identity);
            // live 连接不求租,迟到/串线的回执与握手噪音同待遇。
            ServerMsg::Challenge { .. }
            | ServerMsg::Authed
            | ServerMsg::Pong
            | ServerMsg::SeatLease { .. } => Ok(()),
            // 工序4:AccountStatusV1 只对声明 account_status_v1 能力者下发;本轮客户端不
            // 声明,故正常永不收到。收到=服务端门控 bug——**忽略**(非断连:良性控制帧,
            // 不改同步数据/密钥/水位;声明 cap 与渲染属未来轮,服务端阴性测负责抓门控)。
            ServerMsg::AccountStatusV1 { .. } => Ok(()),
        }
    }

    // ---- 密文帧:逐域试解 → 引擎/引导 ----

    async fn on_deliver(
        &mut self,
        ws: &mut Ws,
        from: &str,
        to: &str,
        blob: &[u8],
    ) -> Result<(), String> {
        match open_deliver(self.cfg, from, to, blob) {
            Opened::Data(msg) => {
                if self.booting() {
                    return Ok(()); // 引导中整帧丢弃(模块注释;hello 互补会重取)。
                }
                self.feed_engine(ws, from, msg).await
            }
            Opened::Boot(bm) => self.on_boot_msg(ws, from, bm).await,
            Opened::Skew => {
                self.report_skew();
                Ok(())
            }
            Opened::WrongDomain(domain) => {
                // 认证通过但变体不属于该域:协议映射被破坏(对端实现漂移),按协议
                // 错误拒收——不是 skew(skew 会劝人升级,这里升级也没用)。
                let text = format!("拒收 {from} 的帧:变体与加密域 {domain} 不符(对端实现漂移?)");
                self.set_status(|s| s.error = Some(text));
                Ok(())
            }
            Opened::Undecryptable => {
                let text = format!("收到无法解密的帧(来自 {from};密钥不一致?)");
                self.set_status(|s| s.error = Some(text));
                Ok(())
            }
        }
    }

    fn report_skew(&mut self) {
        if !self.skew_reported {
            self.skew_reported = true;
            self.toast("对端版本较新,请升级朱简后继续同步".into());
        }
        self.set_status(|s| s.skew = true);
    }

    async fn feed_engine(&mut self, ws: &mut Ws, from: &str, msg: Msg) -> Result<(), String> {
        // 追赶分批(§8 锁序):大 ops 帧拆 ≤100 条子帧,批间放锁不饿死 UI 命令。
        // 合法帧的连续切片仍是合法帧(升序性质保持),校验语义不变。
        let batches: Vec<Msg> = match msg {
            Msg::Ops { origin, ops } if ops.len() > OPS_LOCK_BATCH => ops
                .chunks(OPS_LOCK_BATCH)
                .map(|c| Msg::Ops { origin: origin.clone(), ops: c.to_vec() })
                .collect(),
            m => vec![m],
        };
        let mut changed = false;
        for m in batches {
            changed |= matches!(&m, Msg::Ops { .. })
                || matches!(&m, Msg::BlobChunk { last: true, .. });
            let outs = {
                let mut conn = self.db.lock().expect("db mutex poisoned");
                let mut clk = self.clock.lock().expect("clock mutex poisoned");
                self.engine
                    .as_mut()
                    .expect("booting 已在 on_deliver 挡掉")
                    .on_msg(&mut conn, &mut clk, from, m)?
            };
            self.dispatch(ws, outs).await?;
        }
        if changed {
            let _ = self.events.send(SyncEvent::Changed);
        }
        // 引擎内存态照进状态快照(挂起数/冻结清单/隔离与 breaker;set_status 内容
        // 不变不发事件)。
        let (suspended, mut frozen, poison) = {
            let e = self.engine.as_ref().expect("上面刚用过");
            (e.suspended_count(), e.frozen.keys().cloned().collect::<Vec<_>>(), e.poison_status())
        };
        frozen.sort();
        self.set_status(|s| {
            s.suspended = suspended;
            s.frozen = frozen;
            s.quarantined = poison.0;
            s.poison_breaker = poison.1;
        });
        Ok(())
    }

    async fn dispatch(&mut self, ws: &mut Ws, outs: Vec<Output>) -> Result<(), String> {
        for o in outs {
            match o {
                Output::Send { to, lane, msg } => self.send_data(ws, &to, lane, &msg).await?,
                Output::Event(ev) => self.on_engine_event(ev),
            }
        }
        Ok(())
    }

    fn on_engine_event(&mut self, ev: Event) {
        match ev {
            Event::SpaceNameChanged => {
                let _ = self.events.send(SyncEvent::SpaceNameChanged);
            }
            Event::ImagesRenumbered { renumbered, content_rewritten } => {
                let list = renumbered
                    .iter()
                    .map(|(_, old, new)| format!("图{old}→图{new}"))
                    .collect::<Vec<_>>()
                    .join("、");
                let mut msg = format!("两台设备同时贴图,本机配图编号顺延:{list}");
                if content_rewritten {
                    msg.push_str("(正文引用已同步修正)");
                }
                self.toast(msg);
                let _ = self.events.send(SyncEvent::Changed);
            }
            Event::OriginFrozen { origin, reason } => {
                self.toast(format!("同步已冻结一台设备的历史(需人工处理):{reason}"));
                self.set_status(|s| {
                    if !s.frozen.contains(&origin) {
                        s.frozen.push(origin);
                        s.frozen.sort();
                    }
                    s.error = Some(reason);
                });
            }
            Event::OriginSuspended { origin, reason } => {
                // 挂起多是瞬态(依赖未到,落地即解);只进状态不弹提示。
                self.set_status(|s| {
                    s.error = Some(format!("部分同步暂挂(来源 {origin}):{reason}"));
                });
            }
            Event::OriginQuarantined { origin, relay_from, reason } => {
                // 持久隔离(毒 op,§4):常驻告警——双坐标都报(origin ≠ 必然的作恶
                // 发送者,吊谁由运营者判断),状态快照在 feed_engine 里随引擎照进。
                self.toast(format!(
                    "已隔离一台设备的非法数据(来源 {origin},经 {relay_from} 投递):{reason}"
                ));
                self.set_status(|s| {
                    if !s.quarantined.contains(&origin) {
                        s.quarantined.push(origin);
                        s.quarantined.sort();
                    }
                    s.error = Some(reason);
                });
            }
            Event::PoisonBreakerTripped { reason } => {
                self.toast(format!(
                    "同步保护闸已闭合(拒收新设备数据,须人工处理后复位):{reason}"
                ));
                self.set_status(|s| s.poison_breaker = Some(reason));
            }
            Event::FrameRejected { from, reason } => {
                self.set_status(|s| s.error = Some(format!("拒收 {from} 的帧:{reason}")));
            }
            Event::ClockSkew { ahead_hours } => {
                if !self.clock_skew_reported {
                    self.clock_skew_reported = true;
                    self.toast(format!(
                        "检测到另一台设备的时间比本机快约 {ahead_hours} 小时,可能让它的编辑总是「胜出」;请检查两台设备的系统时间"
                    ));
                }
                self.set_status(|s| s.clock_skew = true);
            }
        }
    }

    async fn send_data(
        &mut self,
        ws: &mut Ws,
        to: &str,
        lane: Lane,
        msg: &Msg,
    ) -> Result<(), String> {
        let domain = msg_domain(msg);
        let blob = crypto::seal_msg(
            &self.cfg.k_acc,
            &FrameAddr {
                account_id: &self.cfg.account_id,
                from_device: &self.cfg.device_id,
                to,
                domain,
            },
            msg,
        );
        let kind = match msg {
            Msg::Ops { origin, ops } if *origin == self.cfg.device_id => Sent::OwnOps {
                max_seq: ops.last().expect("引擎不出空 ops 帧").origin_seq,
            },
            _ if lane == Lane::Direct => Sent::Direct { to: to.to_string() },
            _ => Sent::Other,
        };
        let wire_lane = match lane {
            Lane::Mail => WireLane::Mail,
            Lane::Direct => WireLane::Direct,
        };
        self.send_envelope(ws, to, wire_lane, blob, kind).await
    }

    async fn send_envelope(
        &mut self,
        ws: &mut Ws,
        to: &str,
        lane: WireLane,
        blob: Vec<u8>,
        kind: Sent,
    ) -> Result<(), String> {
        self.n += 1;
        self.tracked.insert(self.n, kind);
        send_client(ws, &ClientMsg::Send { n: self.n, to: to.into(), lane, blob }).await
    }

    // ---- 引导(新端拉流 / 老端供流) ----

    async fn try_boot_request(&mut self, ws: &mut Ws) -> Result<(), String> {
        if !self.booting() || self.boot_peer.is_some() {
            return Ok(());
        }
        let Some(target) = self.peers.front().cloned() else {
            return Ok(()); // 没同伴在线:保持 booting,等 Peer 事件。
        };
        let blob = crypto::seal_msg(
            &self.cfg.k_acc,
            &FrameAddr {
                account_id: &self.cfg.account_id,
                from_device: &self.cfg.device_id,
                to: &target,
                domain: Domain::Boot,
            },
            &BootMsg::Req,
        );
        self.send_envelope(ws, &target.clone(), WireLane::Direct, blob, Sent::BootReq).await?;
        self.boot_peer = Some(target);
        self.boot_deadline = Some(Instant::now() + Duration::from_secs(BOOT_STEP_SECS));
        Ok(())
    }

    /// 放弃当前引导尝试(超时/对方掉线/坏流),轮转候选,等下一次 try_boot_request。
    fn boot_rotate(&mut self) {
        self.boot_peer = None;
        self.boot_recv = None; // Drop 兜底清临时文件。
        self.boot_deadline = None;
        if self.peers.len() > 1 {
            self.peers.rotate_left(1);
        }
    }

    async fn on_boot_msg(&mut self, ws: &mut Ws, from: &str, bm: BootMsg) -> Result<(), String> {
        match bm {
            BootMsg::Req => {
                // 老端供快照。自己也在引导 = 无从供给,静默(对方超时换人,§6.2
                // 并发引导);已有一流在供,同样静默。缺字节者拒当源(phone-space-
                // plan §1.1,判定在 boot_serve_snapshot):MetadataOnly 库的
                // item_image 天生不完整、Full 端字节未拉完时也有缺口,不许把
                // 「全量引导」悄悄变成部分克隆——同一静默语义,对方超时轮转到
                // 全量端。
                if !self.allow_boot_source || self.booting() || self.boot_out.is_some() {
                    return Ok(());
                }
                let snap = {
                    let conn = self.db.lock().expect("db mutex poisoned");
                    boot_serve_snapshot(&conn, &self.data_dir)
                };
                match snap {
                    Ok(Some(snap)) => match BootSender::new(&snap) {
                        Ok(sender) => {
                            self.boot_out =
                                Some(BootOut { to: from.into(), sender, path: snap.path });
                        }
                        Err(e) => {
                            // BootSender::new 失败:make_snapshot 已产文件,别把明文副本留在盘上(#4)。
                            let _ = std::fs::remove_file(&snap.path);
                            self.set_status(|s| s.error = Some(format!("无法供应引导快照:{e}")));
                        }
                    },
                    // 字节有洞:静默不供,对方超时轮转到全量端(与「已在供流」同形态)。
                    Ok(None) => {}
                    Err(e) => {
                        // 本机故障(完整性查询失败/磁盘满等):响亮进状态(对方会换人)。
                        self.set_status(|s| s.error = Some(format!("无法供应引导快照:{e}")));
                    }
                }
                Ok(())
            }
            BootMsg::Offer { transfer, bytes, sha256 } => {
                if !self.booting() || self.boot_peer.as_deref() != Some(from) {
                    return Ok(()); // 残帧/未请求的 Offer:丢。
                }
                match BootReceiver::start(&self.data_dir, from, &transfer, bytes, &sha256) {
                    Ok(r) => {
                        // 可用空间预检(android-plan §3):导入峰值 ≈「临时快照 +
                        // 正式库 + WAL」三份并存。**必须在 BootReceiver::start 的协议
                        // sanity(bytes ∈ (0, 8GiB]、transfer ULID)之后**——否则坏
                        // 对端伪造的天文/负数 bytes 会被误判成「本机空间不足」,把
                        // 轮转到正常快照源的路堵死(codex P4-d 轮 M2)。空间不够 =
                        // 置 space_blocked,session 立即断连(源端下一块吃 Nack 即
                        // 止流,不白发 8GiB)、外层固定长等待(M1/复核 M,见
                        // BOOT_SPACE_RETRY_SECS 注释);拿不到统计的平台(Windows)
                        // 不拦,写盘 fail-fast 兜底。
                        if let Some(free) = free_space(&self.data_dir) {
                            if let Some(need) = boot_space_shortfall(free, bytes) {
                                drop(r); // Drop 兜底删掉刚建的临时收流文件。
                                let text = format!(
                                    "初始同步空间不足:快照 {},导入峰值约需 {},本机仅剩 {}——请清理存储,{} 分钟后自动重试",
                                    human_bytes(bytes as u64),
                                    human_bytes(need),
                                    human_bytes(free),
                                    BOOT_SPACE_RETRY_SECS / 60
                                );
                                self.toast(text.clone());
                                self.set_status(|s| s.error = Some(text));
                                self.space_blocked = true;
                                return Ok(());
                            }
                        }
                        self.boot_recv = Some(r);
                        self.boot_deadline =
                            Some(Instant::now() + Duration::from_secs(BOOT_STEP_SECS));
                        let _ = self
                            .events
                            .send(SyncEvent::BootProgress { received: 0, total: bytes });
                    }
                    Err(e) => {
                        self.set_status(|s| s.error = Some(format!("引导流开启失败:{e}")));
                        self.boot_rotate();
                        self.try_boot_request(ws).await?;
                    }
                }
                Ok(())
            }
            BootMsg::Chunk { transfer, idx, last, data } => {
                let Some(recv) = self.boot_recv.as_mut() else {
                    return Ok(()); // 没有进行中的收流:残帧,丢。
                };
                match recv.on_chunk(from, &transfer, idx, last, &data) {
                    Ok(ChunkOutcome::More) => {
                        self.boot_deadline =
                            Some(Instant::now() + Duration::from_secs(BOOT_STEP_SECS));
                        let (received, total) = recv.progress();
                        let _ = self.events.send(SyncEvent::BootProgress { received, total });
                        Ok(())
                    }
                    Ok(ChunkOutcome::Ignored) => Ok(()),
                    Ok(ChunkOutcome::Complete) => {
                        let (received, total) = recv.progress();
                        let _ = self.events.send(SyncEvent::BootProgress { received, total });
                        self.finish_boot(ws).await
                    }
                    Err(e) => {
                        self.set_status(|s| s.error = Some(format!("引导流中断:{e}")));
                        self.boot_rotate();
                        self.try_boot_request(ws).await
                    }
                }
            }
        }
    }

    async fn finish_boot(&mut self, ws: &mut Ws) -> Result<(), String> {
        let path = self
            .boot_recv
            .as_ref()
            .expect("Complete 必有收流器")
            .path()
            .to_path_buf();
        // 接线契约:fresh 校验到 commit 持同一把写锁(先 db 后 clock,与 write_locks
        // 同序),引导与本地命令/引擎应用互斥;import_snapshot 事务内还会重验 fresh。
        let import = {
            let mut conn = self.db.lock().expect("db mutex poisoned");
            let mut clk = self.clock.lock().expect("clock mutex poisoned");
            let r = boot::import_snapshot(&mut conn, &mut clk, &path);
            // 「须重开」旗与导入共临界区(codex 二轮 M2):排队在这把 db 锁上的业务
            // 写,拿到锁时旗必已在——「先查旗(None)→ 阻塞在锁上 → 导入提交放锁 →
            // 抢到锁写进已判废连接」的竞态从此关死(壳层写闸配套改成**锁内复核**)。
            if let Ok(boot::ImportOutcome::CommittedNeedsReopen { error, .. }) = &r {
                *self.restart_flag.lock().expect("restart_flag mutex poisoned") =
                    Some(error.clone());
            }
            r
        };
        let _ = std::fs::remove_file(&path);
        self.boot_recv = None;
        self.boot_peer = None;
        self.boot_deadline = None;
        match import {
            Ok(boot::ImportOutcome::Committed { report, post_commit_error }) => {
                // BootCommitted latch(space-entry-plan §3.2 三轮 M1):持久提交 +
                // 事务内 integrity 已过、start_engine **之前** take+send。receiver
                // 已关(JoinManager 放弃)不视为错误——latch 只是通知位。
                if let Some(tx) =
                    self.boot_commit.lock().expect("boot_commit mutex poisoned").take()
                {
                    let _ = tx.send(BootCommitNotice {
                        report: report.clone(),
                        post_commit_error: post_commit_error.clone(),
                        needs_reopen: false,
                    });
                }
                self.toast(format!(
                    "初始同步完成:{} 条内容、{} 张配图已就位",
                    report.items, report.images
                ));
                if let Some(w) = post_commit_error {
                    self.set_status(|s| s.error = Some(w));
                }
                // 库已提交,先通知本地读库再碰网络(codex 实现审 M1):start_engine
                // 里的 hello/push 可失败提前返回,事件排它后面 = 名字落了库、壳却
                // 到重启才知道。事件只驱动本地重读,不依赖网络恢复。
                let _ = self.events.send(SyncEvent::Changed);
                // boot 物化绕过 apply_remote_op(§4.7 三入口之二,codex 二轮 H2):
                // 名字可能随快照刚到,专用事件让壳刷空间名(无名也无害,只是重读)。
                let _ = self.events.send(SyncEvent::SpaceNameChanged);
                // 接线契约:导入抬了水位,必须重建引擎再 on_connected(boot.rs 注释)。
                self.start_engine(ws).await?;
                Ok(())
            }
            Ok(boot::ImportOutcome::CommittedNeedsReopen { report, error }) => {
                // 库已可信提交、连接却还挂着 boot 库(§3.2):「须重开」旗已在上方
                // **导入临界区内**落下(codex 二轮 M2),这里只做状态与 latch;
                // **禁止在原 Connection 上 start_engine**,置位让 session 以
                // ReopenRequired 收场(run 整体退出、不重连)。
                self.set_status(|s| {
                    s.state = "off".into();
                    s.error = Some(format!("初始同步已完成,但需要重启同步会话:{error}"));
                });
                if let Some(tx) =
                    self.boot_commit.lock().expect("boot_commit mutex poisoned").take()
                {
                    let _ = tx.send(BootCommitNotice {
                        report,
                        post_commit_error: Some(error.clone()),
                        needs_reopen: true,
                    });
                }
                let _ = self.events.send(SyncEvent::Changed);
                let _ = self.events.send(SyncEvent::SpaceNameChanged);
                self.reopen_required = Some(error);
                Ok(())
            }
            Err(e) => {
                // 整体回滚无痕:报错并稍后换一台重试(快照损坏/版本不同,文案已是人话)。
                self.toast(format!("初始同步失败:{e}"));
                self.set_status(|s| s.error = Some(e));
                self.boot_rotate();
                self.boot_deadline =
                    Some(Instant::now() + Duration::from_secs(BOOT_STEP_SECS));
                Ok(())
            }
        }
    }

    /// 供流泵:每次 select 空转发一块(与收帧/心跳互相穿插,不独占循环)。
    async fn pump_boot_out(&mut self, ws: &mut Ws) -> Result<(), String> {
        let step = {
            let bo = self.boot_out.as_mut().expect("select 守卫已判");
            match bo.sender.next_msg() {
                Ok(Some(msg)) => Some((bo.to.clone(), msg)),
                Ok(None) => None,
                Err(e) => {
                    self.set_status(|s| s.error = Some(format!("引导供流中断:{e}")));
                    None
                }
            }
        };
        match step {
            Some((to, msg)) => {
                let blob = crypto::seal_msg(
                    &self.cfg.k_acc,
                    &FrameAddr {
                        account_id: &self.cfg.account_id,
                        from_device: &self.cfg.device_id,
                        to: &to,
                        domain: Domain::Boot,
                    },
                    &msg,
                );
                self.send_envelope(ws, &to, WireLane::Direct, blob, Sent::BootOut).await
            }
            None => {
                if let Some(bo) = self.boot_out.take() {
                    discard_boot_out(bo);
                }
                Ok(())
            }
        }
    }

    // ---- 配对(opener 侧;joiner 走 pair_join 专用连接) ----

    async fn on_pair_start(
        &mut self,
        ws: &mut Ws,
        reply: oneshot::Sender<Result<String, String>>,
    ) -> Result<(), String> {
        if self.booting() {
            let _ = reply.send(Err("正在初始同步,完成后再发起配对".into()));
            return Ok(());
        }
        if self.pair.is_some() {
            let _ = reply.send(Err("已有配对在进行中".into()));
            return Ok(());
        }
        send_client(ws, &ClientMsg::PairOpen).await?;
        self.pair = Some(PairFlow {
            secret: pair::gen_secret(),
            slot: None,
            opener: None,
            reply: Some(reply),
            // 先按开槽阶段计短时;PairSlot 到达时重置为码的真实 TTL(§1.3)。
            deadline: Instant::now() + Duration::from_secs(PAIR_OPEN_SECS),
        });
        Ok(())
    }

    /// 驱动 opener 状态机的一步输出(None = 当下没有配对在跑,消息是残帧,丢)。
    async fn drive_pair(
        &mut self,
        ws: &mut Ws,
        step: Option<Result<Vec<PairOutput>, pair::PairError>>,
    ) -> Result<(), String> {
        let Some(step) = step else { return Ok(()) };
        let outs = match step {
            Ok(o) => o,
            Err(e) => {
                self.fail_pair(ws, e.to_string(), true).await;
                return Ok(());
            }
        };
        let slot = self.pair.as_ref().and_then(|p| p.slot).expect("有 opener 必有 slot");
        for o in outs {
            match o {
                PairOutput::Send(blob) => {
                    send_client(ws, &ClientMsg::PairMsg { slot, blob }).await?;
                }
                PairOutput::Register { device_id, pubkey } => {
                    let sig = self.signing.sign(&register_device_sig_payload(
                        &self.cfg.account_id,
                        &device_id,
                        &pubkey,
                    ));
                    send_client(ws, &ClientMsg::RegisterDevice {
                        account: self.cfg.account_id.clone(),
                        new_device: device_id,
                        new_pubkey: pubkey.to_vec(),
                        sig_by_old: sig.to_bytes().to_vec(),
                    })
                    .await?;
                }
                PairOutput::Granted(_) | PairOutput::GrantPending { .. } => {
                    return Err("opener 不该输出 joiner 侧变体(编排 bug)".into());
                }
                PairOutput::Finished => {
                    self.pair = None;
                    let _ = self.events.send(SyncEvent::Pair {
                        phase: "done",
                        detail: "新设备已加入账户,正在初始同步".into(),
                    });
                }
            }
        }
        Ok(())
    }

    /// 配对失败收口:烧槽(PairClose,`close_slot`——对端已关时槽已死,别再关)
    /// + 回执/事件。任何一步失败后配对码即作废(服务器 MITM 恒只有一次在线猜测,§4)。
    async fn fail_pair(&mut self, ws: &mut Ws, why: String, close_slot: bool) {
        let Some(mut p) = self.pair.take() else { return };
        if let Some(r) = p.reply.take() {
            let _ = r.send(Err(why.clone()));
        }
        if close_slot {
            if let Some(slot) = p.slot {
                let _ = send_client(ws, &ClientMsg::PairClose { slot }).await;
            }
        }
        let _ = self.events.send(SyncEvent::Pair { phase: "failed", detail: why });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, images, notes, task};
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::task::JoinHandle;

    // 定点测试账户(合法 ULID 形态;open-signup 起准入开放,无须预签)。
    const ACCT: &str = "01AAAAAAAAAAAAAAAAAAAAACCT";

    static N: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ys-nb-transport-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn test_db(tag: &str) -> (Arc<Mutex<Connection>>, Arc<Mutex<Clock>>, PathBuf) {
        let dir = temp_dir(tag);
        let conn = db::open(&dir.join("db.sqlite3")).expect("open");
        let clock = Clock::load(&conn).expect("clock");
        (Arc::new(Mutex::new(conn)), Arc::new(Mutex::new(clock)), dir)
    }

    async fn start_server() -> SocketAddr {
        let dir = temp_dir("server");
        std::fs::write(dir.join("banlist.txt"), "# 空封禁表\n").unwrap();
        let cfg = zhujian_syncd::Config::new(dir.join("banlist.txt"), dir.join("registry.json"));
        let (addr, _handle) = zhujian_syncd::serve("127.0.0.1:0".parse().unwrap(), cfg)
            .await
            .unwrap();
        addr
    }

    // 半途态恢复测试用的第二个账户(合法 ULID 形态;open-signup 起准入开放,
    // 定点账户直接可用,不再需要预签)。

    /// 带 admin 面(吊销接口)的测试服务器(封禁表为空 = 全放行)。
    async fn start_server_with_admin() -> (SocketAddr, SocketAddr, &'static str) {
        const TOKEN: &str = "test-admin-token-0123456789abcdef0123456789abcdef";
        let dir = temp_dir("server-admin");
        std::fs::write(dir.join("banlist.txt"), "# 空封禁表\n").unwrap();
        let cfg = zhujian_syncd::Config::new(dir.join("banlist.txt"), dir.join("registry.json"));
        let (addr, admin, _handle) = zhujian_syncd::serve_with_admin(
            "127.0.0.1:0".parse().unwrap(),
            "127.0.0.1:0".parse().unwrap(),
            TOKEN.into(),
            cfg,
        )
        .await
        .unwrap();
        (addr, admin, TOKEN)
    }

    /// 极简 admin HTTP 客户端(core 不引 HTTP 依赖;admin 面只在测试与运维用)。
    async fn admin_post(admin: SocketAddr, token: &str, path_qs: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(admin).await.unwrap();
        let req = format!(
            "POST {path_qs} HTTP/1.1\r\nHost: {admin}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = String::new();
        let _ = s.read_to_string(&mut buf).await;
        buf
    }

    /// M3 诊断(android-plan §9):对本地起的真服务六项全绿——诊断逻辑本身正确,
    /// 真机上再跑只剩平台差异(NDK/ring 汇编/系统熵源/TLS)。provider 与 app 壳同
    /// 姿势先装(AlreadyInstalled 无妨:测试进程内谁先装都一样)。
    #[tokio::test]
    async fn net_probe_green_against_local_server() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let addr = start_server().await;
        let steps = net_probe(&format!("ws://{addr}")).await;
        assert_eq!(steps.len(), 6);
        for s in &steps {
            assert!(s.ok, "{} 应过:{}", s.name, s.detail);
        }
    }

    /// 连不上的地址:网络项如实报红,本地密码学五项照绿(诊断不撒谎、不短路)。
    #[tokio::test]
    async fn net_probe_reports_unreachable_server() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let steps = net_probe("ws://127.0.0.1:1").await;
        let bad: Vec<_> = steps.iter().filter(|s| !s.ok).map(|s| s.name).collect();
        assert_eq!(bad, vec!["wss-challenge"]);
    }

    struct Rig {
        control: mpsc::Sender<Control>,
        status: Arc<Mutex<SyncStatus>>,
        wrote: Arc<Notify>,
        task: JoinHandle<TransportExit>,
        /// 事件流(unbounded,不排水也无害):BootProgress 序列断言用。
        events: mpsc::UnboundedReceiver<SyncEvent>,
    }

    fn spawn_transport(
        db: Arc<Mutex<Connection>>,
        clock: Arc<Mutex<Clock>>,
        dir: PathBuf,
    ) -> Rig {
        spawn_transport_with(db, clock, dir, BlobPolicy::Full, true)
    }

    fn spawn_transport_with(
        db: Arc<Mutex<Connection>>,
        clock: Arc<Mutex<Clock>>,
        dir: PathBuf,
        blob_policy: BlobPolicy,
        allow_boot_source: bool,
    ) -> Rig {
        spawn_transport_full(db, clock, dir, blob_policy, allow_boot_source, Arc::new(Mutex::new(None)))
    }

    fn spawn_transport_full(
        db: Arc<Mutex<Connection>>,
        clock: Arc<Mutex<Clock>>,
        dir: PathBuf,
        blob_policy: BlobPolicy,
        allow_boot_source: bool,
        boot_commit: BootCommitLatch,
    ) -> Rig {
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let status = Arc::new(Mutex::new(SyncStatus::default()));
        let wrote = Arc::new(Notify::new());
        {
            let conn = db.lock().unwrap();
            hook_oplog_writes(&conn, wrote.clone());
        }
        // sender 即刻 drop:wait_shutdown 对「无编排者」按永不停机处理(常驻语义)。
        let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let t = Transport {
            db,
            clock,
            status: status.clone(),
            events: ev_tx,
            control: ctl_rx,
            wrote: wrote.clone(),
            data_dir: dir,
            blob_policy,
            allow_boot_source,
            shutdown: shutdown_rx,
            boot_commit,
            restart_flag: Arc::new(Mutex::new(None)),
        };
        let task = tokio::spawn(run(t));
        Rig { control: ctl_tx, status, wrote, task, events: ev_rx }
    }

    async fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..600 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("等待超时:{what}");
    }

    async fn wait_state(status: &Arc<Mutex<SyncStatus>>, want: &str) {
        wait_until(&format!("状态到 {want}"), || {
            status.lock().unwrap().state == want
        })
        .await;
    }

    fn count_items(db: &Arc<Mutex<Connection>>) -> i64 {
        let conn = db.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap()
    }

    fn oplog_fingerprint(db: &Arc<Mutex<Connection>>) -> Vec<String> {
        let conn = db.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT op_id||'|'||hlc||'|'||origin_seq FROM oplog ORDER BY op_id")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    // ---- 纯函数面 ----

    #[test]
    fn ws_endpoint_normalizes_and_rejects() {
        assert_eq!(ws_endpoint("ws://h:1/ws").unwrap(), "ws://h:1/ws");
        assert_eq!(ws_endpoint("ws://h:1").unwrap(), "ws://h:1/ws");
        assert_eq!(ws_endpoint("wss://sync.zhujian.app/").unwrap(), "wss://sync.zhujian.app/ws");
        assert!(ws_endpoint("http://h").is_err());
        assert!(ws_endpoint("h:1").is_err());
    }

    #[test]
    fn hex_roundtrip_and_rejects() {
        let k = [7u8; 32];
        assert_eq!(unhex32(&hex(&k)).unwrap(), k);
        assert!(unhex32("zz").is_err());
        assert!(unhex32(&"0".repeat(63)).is_err());
    }

    /// 引导空间预检的纯判定(codex P4-d 轮 M3 的可测形):3× 峰值线,不足给需求量。
    #[test]
    fn boot_space_shortfall_needs_three_snapshots() {
        assert_eq!(boot_space_shortfall(300, 100), None, "恰好 3× 放行");
        assert_eq!(boot_space_shortfall(299, 100), Some(300), "差 1 字节也拦,并报需求量");
        assert_eq!(boot_space_shortfall(u64::MAX, boot::MAX_SNAPSHOT_BYTES), None, "8GiB 红线内不溢出");
    }

    #[test]
    fn open_deliver_enforces_domain_variant_mapping() {
        let cfg = SyncConfig {
            account_id: ACCT.into(),
            k_acc: [9u8; 32],
            device_seed: [1u8; 32],
            server_url: "ws://h:1".into(),
            device_id: "0DAAAAAAAAAAAAAAAAAAAAAAA1".into(),
        };
        let seal = |domain, msg: &Msg| {
            crypto::seal_msg(
                &cfg.k_acc,
                &FrameAddr { account_id: &cfg.account_id, from_device: "F", to: "*", domain },
                msg,
            )
        };
        let hello = Msg::Hello { watermarks: Default::default() };
        // 正道:Hello 封 ctl 域 → Data;Ops 封 op 域 → Data。
        assert!(matches!(open_deliver(&cfg, "F", "*", &seal(Domain::Ctl, &hello)), Opened::Data(_)));
        let ops = Msg::Ops { origin: "O".into(), ops: vec![] };
        assert!(matches!(open_deliver(&cfg, "F", "*", &seal(Domain::Op, &ops)), Opened::Data(_)));
        // 评审 P2-g 轮 M:Hello 封进 op 域 = 变体-域不符,拒收(不是 skew)。
        assert!(matches!(
            open_deliver(&cfg, "F", "*", &seal(Domain::Op, &hello)),
            Opened::WrongDomain("op")
        ));
        // boot 域装 BootMsg。
        let boot_blob = crypto::seal_msg(
            &cfg.k_acc,
            &FrameAddr { account_id: &cfg.account_id, from_device: "F", to: "*", domain: Domain::Boot },
            &BootMsg::Req,
        );
        assert!(matches!(open_deliver(&cfg, "F", "*", &boot_blob), Opened::Boot(BootMsg::Req)));
        // 认证过但读不懂(op 域里封了个裸字符串)= 对端版本较新。
        let junk = crypto::seal_msg(
            &cfg.k_acc,
            &FrameAddr { account_id: &cfg.account_id, from_device: "F", to: "*", domain: Domain::Op },
            &"将来的新变体",
        );
        assert!(matches!(open_deliver(&cfg, "F", "*", &junk), Opened::Skew));
        // 错钥/垃圾 = 四域全败。
        assert!(matches!(open_deliver(&cfg, "F", "*", b"garbage-bytes-way-too-short-no"), Opened::Undecryptable));
        // 换个 from(AAD 变)= 解不开:服务器改投递标签必露馅。
        assert!(matches!(
            open_deliver(&cfg, "G", "*", &seal(Domain::Ctl, &hello)),
            Opened::Undecryptable
        ));
    }

    #[test]
    fn config_save_load_roundtrip_and_no_overwrite() {
        let (db, _clock, _dir) = test_db("cfg");
        let mut conn = db.lock().unwrap();
        assert!(load_config(&conn).unwrap().is_none(), "空库未配置");
        let k = [1u8; 32];
        let seed = [2u8; 32];
        save_config(&mut conn, ACCT, &k, &seed, "ws://h:1", true).unwrap();
        let cfg = load_config(&conn).unwrap().expect("已配置");
        assert_eq!(cfg.account_id, ACCT);
        assert_eq!(cfg.k_acc, k);
        assert_eq!(cfg.device_seed, seed);
        assert_eq!(cfg.server_url, "ws://h:1");
        assert!(meta_get(&conn, "bootstrapped_at").unwrap().is_some(), "创号者落纪元标记");
        assert_eq!(
            meta_get(&conn, "epoch").unwrap().as_deref(),
            Some("2"),
            "创号随配置落 epoch=2(epoch-plan §3.5;电池已在 create_account 入口过)"
        );
        // 二次写入拒(账户只入一次)。
        assert!(save_config(&mut conn, ACCT, &k, &seed, "ws://h:2", false).is_err());
        // 游标:缺 = 0,只升不降。
        assert_eq!(read_last_pushed(&conn).unwrap(), 0);
        bump_last_pushed(&conn, 5).unwrap();
        bump_last_pushed(&conn, 3).unwrap();
        assert_eq!(read_last_pushed(&conn).unwrap(), 5);
    }

    /// wss:// 回归锚(84):rustls 0.23 无(或多于一个)加密提供者时,`ClientConfig::
    /// builder()` 直接 panic——tokio-tungstenite 首次连 wss:// 就撞上,async 命令死在
    /// panic 里 promise 永不返回(UI 点「创建」无反应)。集成测全走 ws:// 明文照不出,
    /// 这里离线钉死 TLS 配置可构造(Cargo.toml rustls ring 特性被拔掉即红)。
    #[test]
    fn wss_tls_provider_present() {
        let _ = rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
    }

    /// 提交边界(phone-space-plan §1.2)的词法闸:`save_config` 之后到函数尾不得
    /// 出现 `.await`——提交后再有暂停点,壳层 select! 取消就可能变成「报已取消、
    /// 账户实已落库、恢复码丢失」。为什么按源码钉而不用运行期探针:回环网络上
    /// `ws.close()` 单 poll 即完成、永不 Pending,把顺序换错运行期探针照样绿
    /// (阴性对照实测过)——这个窗口在本地 IO 下观测不到。
    #[test]
    fn create_account_no_await_after_commit_lexical() {
        let src = include_str!("transport.rs");
        // 公开包装层只许尾调用(审 L5):体内恰一个 .await 且是 create_account_as
        // 的尾调用——将来有人在尾 await 之后加暂停点,提交边界就被包装层旁路。
        let wstart = src.find("pub async fn create_account(").expect("包装在本文件");
        let wend = wstart + src[wstart..].find("\n}").expect("包装体以行首 } 结束");
        let wbody = &src[wstart..wend];
        assert_eq!(wbody.matches(".await").count(), 1, "包装层只许一个尾 await");
        assert!(
            wbody.contains("create_account_as(db, server_url, None).await"),
            "包装层必须是对 create_account_as 的直接尾调用"
        );
        // 提交边界在 create_account_as(账户 ULID 也在其内、严格电池之后生成)。
        let start =
            src.find("pub(crate) async fn create_account_as").expect("函数在本文件");
        let body_end = start + src[start..].find("\n}").expect("函数体以行首 } 结束");
        let body = &src[start..body_end];
        // 提交点必须唯一可定位:注释/字符串里再写一次 save_config( 会让 rfind 指
        // 错位置、把闸变成静默假绿(实现审 L5)——多于一次就响亮失败,逼人来
        // 更新本测而不是绕过它。
        assert_eq!(
            body.matches("save_config(").count(),
            1,
            "create_account_as 函数体内 save_config( 必须恰出现一次(含注释),否则词法闸无法定位真实提交点"
        );
        let last_save = body.rfind("save_config(").expect("create_account_as 内必有 save_config");
        assert!(
            !body[last_save..].contains(".await"),
            "save_config 之后出现 .await——提交后必须零 await(phone-space-plan §1.2)"
        );
    }

    /// 半途态恢复契约(open-signup §1.5,**公开入口全链**——审二 M2:不许预知
    /// 固定账户,恢复必须走用户真实路径):创号中断留下孤儿注册,恢复=把错误
    /// 文案里的本机 device_id 报给运营者按 device 反查吊销 + **公开入口原库原样
    /// 重试(自生成新账户 ULID)**,全程不清库、不需要知道账户号。「创号中断后
    /// 的原库」用整库拷贝模拟:同 device_id、未配置——正是 RegisterFirst 已发、
    /// save_config 未达的那台设备。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn orphan_register_recovers_via_device_revoke() {
        let (addr, admin, token) = start_server_with_admin().await;
        let url = format!("ws://{addr}");

        // 原库建好(device_id 已冻结)→ checkpoint 合并 WAL → 整库拷贝出「中断态」
        // 副本(同 device_id、未配置);再用**公开入口**创号(自生成账户=孤儿属主),
        // 把 device_id 烧到服务器。
        let (db_a, _clock_a, dir_a) = test_db("orph-a");
        let device_id = {
            let conn = db_a.lock().unwrap();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
            meta_get(&conn, "device_id").unwrap().expect("device_id 必在")
        };
        let dir_b = temp_dir("orph-b");
        std::fs::copy(dir_a.join("db.sqlite3"), dir_b.join("db.sqlite3")).unwrap();
        create_account(&db_a, &url).await.unwrap();
        let orphan_acct = {
            let conn = db_a.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置").account_id
        };

        let conn_b = db::open(&dir_b.join("db.sqlite3")).expect("open copy");
        let db_b = Arc::new(Mutex::new(conn_b));
        {
            let conn = db_b.lock().unwrap();
            assert_eq!(meta_get(&conn, "device_id").unwrap().as_deref(), Some(device_id.as_str()));
            assert!(load_config(&conn).unwrap().is_none(), "中断态=未配置");
        }

        // ① 公开入口重试(自生成新账户 ULID):撞 DEVICE_ID_TAKEN——文案必须带
        // 本机 device_id(孤儿只有设备号可报)、明说不要清库、不得出现清库指引。
        let e = create_account(&db_b, &url).await.unwrap_err();
        assert!(e.contains("不要清库"), "创号路径必须明说不要清库:{e}");
        assert!(e.contains(&device_id), "文案必须带本机设备号供运营者反查吊销:{e}");
        assert!(
            !e.contains("清除本空间数据"),
            "创号撞 DEVICE_ID_TAKEN 不得出现清库指引(r3 必修①):{e}"
        );

        // ② device-only 吊销(不需要知道账户号;回执带反查出的孤儿账户)。
        let resp = admin_post(admin, token, &format!("/admin/revoke?device={device_id}")).await;
        assert!(resp.starts_with("HTTP/1.1 200"), "吊销应 200:{resp}");
        assert!(resp.contains(&orphan_acct), "device-only 吊销回执带反查出的账户:{resp}");

        // ③ 公开入口原库重试成功:同 device_id、新自生成账户,配置读回可验。
        let code = create_account(&db_b, &url).await.expect("吊销后公开入口原库重试必须成功");
        assert_eq!(code.chars().filter(|c| *c != '-').count(), 52);
        {
            let conn = db_b.lock().unwrap();
            let cfg = load_config(&conn).unwrap().expect("已配置");
            assert!(sync_proto::is_ulid(&cfg.account_id), "重试账户是合法自生成 ULID");
            assert_ne!(cfg.account_id, orphan_acct, "重试=新账户,不是复活孤儿账户");
        }
    }

    /// NOT_FIRST 创号新语义文案(定点账户版;open-signup §2 审 M5):自生成 ID
    /// 撞上已有账户=标识冲突指路重试,不再指向配对/运营者。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn create_account_not_first_maps_to_identifier_conflict() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db_a, _c1, _d1) = test_db("nf-a");
        let (db_b, _c2, _d2) = test_db("nf-b");
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let e = create_account_as(&db_b, &url, Some(ACCT)).await.unwrap_err();
        assert!(e.contains("账户标识冲突"), "NOT_FIRST 创号新语义文案:{e}");
        assert!(!e.contains("配对"), "创号 NOT_FIRST 不再指路配对:{e}");
    }

    /// AUTH_FAILED 创号映射(审二 M2 补漏):封禁账户创号 → 创号专用话术
    /// (「拒绝创建账户/封禁」),不是通用鉴权文案「本设备未注册」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn create_account_auth_failed_maps_to_banned_message() {
        const BANNED: &str = "0BANNEDBANNEDBANNEDBANNED0";
        let dir = temp_dir("server-banned");
        std::fs::write(dir.join("banlist.txt"), format!("{BANNED}\n")).unwrap();
        let cfg = zhujian_syncd::Config::new(dir.join("banlist.txt"), dir.join("registry.json"));
        let (addr, _handle) =
            zhujian_syncd::serve("127.0.0.1:0".parse().unwrap(), cfg).await.unwrap();
        let url = format!("ws://{addr}");
        let (db, _c, _d) = test_db("ban-a");
        let e = create_account_as(&db, &url, Some(BANNED)).await.unwrap_err();
        assert!(e.contains("拒绝创建账户"), "AUTH_FAILED 创号专用映射:{e}");
        assert!(!e.contains("本设备未注册"), "不得落进通用鉴权文案:{e}");
    }

    /// open-signup §2:公开创号入口自生成账户 ULID(无码)——注册成功、配置落库,
    /// account_id 是合法 ULID 形态且各库互不相同(生成在严格电池之后、同一值用于
    /// 签名与 save_config)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn create_account_generates_account_ulid() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db_a, _c1, _d1) = test_db("gen-a");
        let (db_b, _c2, _d2) = test_db("gen-b");
        create_account(&db_a, &url).await.unwrap();
        create_account(&db_b, &url).await.unwrap();
        let a = {
            let conn = db_a.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置").account_id
        };
        let b = {
            let conn = db_b.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置").account_id
        };
        assert!(sync_proto::is_ulid(&a), "自生成账户号是合法 ULID:{a}");
        assert!(sync_proto::is_ulid(&b), "自生成账户号是合法 ULID:{b}");
        assert_ne!(a, b, "两库各自生成,互不相同");
    }

    /// 创号端严格认证(epoch-plan §3.5,create_account 关旁路):legacy 库在
    /// RegisterFirst **之前**就被电池拒。服务器地址故意不可达——若闸不先于网络,
    /// 错误会是连接失败而不是纪元话术(顺带就是本测的阴性对照)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn create_account_refuses_legacy_db_before_network() {
        let (db, _clock, _dir) = test_db("ca-gate");
        {
            let conn = db.lock().unwrap();
            conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
            conn.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage) \
                 VALUES ('01CAGATEGACY0000000000000A', '遗产', 'inbox', 't0', 't0', NULL)",
                [],
            )
            .unwrap();
            conn.execute("DELETE FROM sync_replay_active", []).unwrap();
        }
        let err = create_account_as(&db, "ws://127.0.0.1:1", Some(ACCT)).await.unwrap_err();
        assert!(err.contains("同步纪元"), "闸必须先于网络注册:{err}");
        assert!(!err.contains("连不上"), "不该走到拨号:{err}");
    }

    /// 纪元切换两阶段预注册(epoch-plan §2.2)端到端:闸拒零残留 → Prepared 落盘 →
    /// 旧身份自背书注册 → Registered 改标;两个崩溃窗(重入幂等 / Ack 后改标前崩 =
    /// 回拨 prepared 后同 bundle 重试、服务器同钥幂等吸收);材料损坏响亮拒(阴性
    /// 对照:绝不静默重生成——那会造第二个孤儿注册);pending 在场 run() 封普通同步
    /// 与配对;压实消费后 poke 即以**新身份**重新上线(闸解除的阳性对照)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pending_identity_two_phase_registration_gate_and_compact() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db, clock, dir) = test_db("pend");
        create_account_as(&db, &url, Some(ACCT)).await.unwrap();
        let old_id = {
            let conn = db.lock().unwrap();
            meta_get(&conn, "device_id").unwrap().unwrap()
        };

        // 唯一闸拒 = 一个键都不写(裁决先于落盘)。
        let err =
            register_pending_identity(&db, |_| Err("跨空间撞号".into())).await.unwrap_err();
        assert!(err.contains("跨空间撞号"), "{err}");
        {
            let conn = db.lock().unwrap();
            assert!(meta_get(&conn, "pending_state").unwrap().is_none());
            assert!(meta_get(&conn, "pending_device_id").unwrap().is_none());
        }

        // 正道:Prepared → Registered,材料齐且自洽(种子派生公钥 == 落盘公钥)。
        let new_id = register_pending_identity(&db, |_| Ok(())).await.unwrap();
        assert_ne!(new_id, old_id);
        let pub_hex = {
            let conn = db.lock().unwrap();
            assert_eq!(meta_get(&conn, "pending_state").unwrap().as_deref(), Some("registered"));
            assert_eq!(
                meta_get(&conn, "pending_device_id").unwrap().as_deref(),
                Some(new_id.as_str())
            );
            let seed_hex = meta_get(&conn, "pending_device_key").unwrap().unwrap();
            let pub_hex = meta_get(&conn, "pending_pubkey").unwrap().unwrap();
            assert_eq!(hex(&pubkey_of(&unhex32(&seed_hex).unwrap())), pub_hex);
            pub_hex
        };

        // 重入 = 幂等(同 id,不换材料)。
        assert_eq!(register_pending_identity(&db, |_| Ok(())).await.unwrap(), new_id);

        // 「Ack 后、改标前崩」:回拨 prepared → 同 bundle 原样重试,服务器同钥幂等吸收。
        {
            let conn = db.lock().unwrap();
            meta_put(&conn, "pending_state", "prepared").unwrap();
        }
        assert_eq!(register_pending_identity(&db, |_| Ok(())).await.unwrap(), new_id);
        {
            let conn = db.lock().unwrap();
            assert_eq!(meta_get(&conn, "pending_state").unwrap().as_deref(), Some("registered"));
        }

        // 阴性对照:prepared 材料损坏 → 响亮拒,绝不静默重生成。
        {
            let conn = db.lock().unwrap();
            meta_put(&conn, "pending_state", "prepared").unwrap();
            meta_put(&conn, "pending_pubkey", &hex(&[0u8; 32])).unwrap();
        }
        let err = register_pending_identity(&db, |_| Ok(())).await.unwrap_err();
        assert!(err.contains("材料损坏"), "{err}");
        {
            let conn = db.lock().unwrap();
            meta_put(&conn, "pending_pubkey", &pub_hex).unwrap();
            meta_put(&conn, "pending_state", "registered").unwrap();
        }

        // 封闸:pending 在场,run() 拒普通同步(off + 人话),配对拒。
        let rig = spawn_transport(db.clone(), clock.clone(), dir.clone());
        wait_until("封闸状态", || {
            let s = rig.status.lock().unwrap();
            s.state == "off" && s.error.as_deref().is_some_and(|e| e.contains("封闸"))
        })
        .await;
        let (tx, rx) = oneshot::channel();
        rig.control.send(Control::PairStart { reply: tx }).await.unwrap();
        let err = rx.await.unwrap().unwrap_err();
        assert!(err.contains("纪元切换"), "{err}");

        // 压实消费 pending(§2)→ 时钟重载(调用方契约)→ poke → 新身份上线。
        let report = {
            let mut conn = db.lock().unwrap();
            crate::epoch::compact(&mut conn).unwrap()
        };
        assert_eq!(report.new_device_id, new_id, "压实消费的就是预注册身份");
        assert!(report.recovery_code.is_some(), "Configured 压实必须重立恢复码");
        {
            let conn = db.lock().unwrap();
            let reloaded = Clock::load(&conn).unwrap();
            *clock.lock().unwrap() = reloaded;
        }
        rig.control.send(Control::Reconfigured).await.unwrap();
        wait_until("新身份上线", || {
            let s = rig.status.lock().unwrap();
            s.state == "online" && s.device_id.as_deref() == Some(new_id.as_str())
        })
        .await;
        rig.task.abort();
    }

    /// 满席纪元预注册走席位租约(billing-plan §5 工序 2):账户压到 seat_quota=1、
    /// 唯一在编设备就是锚点自己——预注册的 +1 只能靠「求租→注册」同连接完成
    /// (无租约必被 seat_limit 拒,阴性专测在服务器侧);消费即 +1 生效、改标如常。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pending_identity_at_seat_quota_uses_lease() {
        let (addr, admin, token) = start_server_with_admin().await;
        let url = format!("ws://{addr}");
        let (db, _clock, _dir) = test_db("pend-lease");
        create_account_as(&db, &url, Some(ACCT)).await.unwrap();
        let resp = admin_post(
            admin,
            token,
            &format!("/admin/entitlement?account={ACCT}&tier=test&seat_quota=1&fastlane_bytes_per_month=1"),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 200"), "压到 1 席应 200:{resp}");
        let new_id = register_pending_identity(&db, |_| Ok(())).await.unwrap();
        {
            let conn = db.lock().unwrap();
            assert_eq!(meta_get(&conn, "pending_state").unwrap().as_deref(), Some("registered"));
            assert_eq!(
                meta_get(&conn, "pending_device_id").unwrap().as_deref(),
                Some(new_id.as_str())
            );
        }
    }

    /// seat_limit 的 opener 收口(billing-plan §5 工序 2,160 可优化项①专测):
    /// 开槽后配额降档(pair_open 前置拒管不到的竞态窗口),注册撞商业层
    /// seat_limit 时 opener 必须 fail_pair 烧槽——PairClose 发到服务器、joiner
    /// 立刻收到对端中止(而不是挂满 600s 码 TTL)、opener 报「席位已满」人话且
    /// 配对态清场;随后的 PairStart 走 pair_open 前置拒,拿到的同样是席位人话
    /// 而不是「已有配对在进行中」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn seat_limit_mid_pair_opener_burns_slot_with_pair_close() {
        let (addr, admin, token) = start_server_with_admin().await;
        let url = format!("ws://{addr}");
        let (db_a, clock_a, dir_a) = test_db("seat-a");
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let mut rig_a = spawn_transport(db_a, clock_a, dir_a);
        wait_state(&rig_a.status, "online").await;

        // 免费档 2 席、现 1 席:前置闸放行,正常出码。
        let (tx, rx) = oneshot::channel();
        rig_a.control.send(Control::PairStart { reply: tx }).await.unwrap();
        let code = timeout(Duration::from_secs(10), rx).await.unwrap().unwrap().unwrap();

        // joiner 停在 gate 停点;主流程趁机把配额压到 1,再放行——Enroll/注册
        // 必然发生在降档之后,竞态窗口是确定性构造的。
        let (reached_tx, mut reached_rx) = mpsc::unbounded_channel::<()>();
        let (proceed_tx, proceed_rx) = std::sync::mpsc::channel::<()>();
        let (db_b, _clock_b, _dir_b) = test_db("seat-b");
        let join = tokio::spawn({
            let db_b = db_b.clone();
            let url = url.clone();
            async move {
                pair_join(&db_b, &url, &code, move |_| {
                    reached_tx.send(()).expect("主流程先于 gate 消失");
                    // 生产的 account_gate(account_free_desktop)是即返的同步本地检查、从不阻塞;
                    // 这里测试刻意用阻塞 recv_timeout 把 gate 摁住来构造「降档竞态窗口」。gate 回调
                    // 是在 pair_join 的 poll 里同步内联调用(transport.rs:703),直接阻塞会占死这个
                    // tokio worker——在 macOS 的 kqueue 反应堆上会饿死并发的 admin_post(该 I/O 拿不到
                    // worker 推进,直到 gate 30s 超时才解冻→本测原在 mac 上必挂;Win/Linux 侥幸不饿)。
                    // block_in_place 让多线程运行时把本 worker 转为阻塞线程并顶一个替补,反应堆继续服务
                    // admin_post 的 I/O。纯测试机制,pair_join 产品路径零改。
                    tokio::task::block_in_place(|| {
                        proceed_rx.recv_timeout(Duration::from_secs(30))
                    })
                    .map_err(|_| "测试超时:主流程没放行 gate".to_string())
                })
                .await
            }
        });
        timeout(Duration::from_secs(15), reached_rx.recv())
            .await
            .expect("joiner 未到 gate 停点")
            .expect("gate 信道断了");
        let resp = admin_post(
            admin,
            token,
            &format!("/admin/entitlement?account={ACCT}&tier=test&seat_quota=1&fastlane_bytes_per_month=1"),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 200"), "压到 1 席应 200:{resp}");
        proceed_tx.send(()).expect("joiner 已死,gate 无人收");

        // joiner 侧:注册被拒后 opener 烧槽,PairPeer::Closed 秒级到达——若 opener
        // 没发 PairClose,这里会挂到 join 超时(= 红,烧槽契约的行为证明)。
        let err = timeout(Duration::from_secs(30), join)
            .await
            .expect("joiner 未在限时内收到对端中止(opener 没烧槽?)")
            .unwrap()
            .unwrap_err();
        assert!(err.contains("中止"), "joiner 要拿到对端中止人话:{err}");
        {
            let conn = db_b.lock().unwrap();
            assert!(load_config(&conn).unwrap().is_none(), "注册未成,joiner 配置一个键都不写");
        }

        // opener 侧:配对失败事件带席位人话。
        let detail = loop {
            match timeout(Duration::from_secs(15), rig_a.events.recv())
                .await
                .expect("opener 未上报配对失败")
                .expect("事件信道断了")
            {
                SyncEvent::Pair { phase: "failed", detail } => break detail,
                _ => {}
            }
        };
        assert!(detail.contains("席位已满"), "失败事件要给席位人话:{detail}");

        // 配对态已清场:重试不撞「已有配对在进行中」,而是 pair_open 前置拒的
        // 同一句席位人话(quota=1 已满)——两层闸给同一出口。
        for _ in 0..2 {
            let (tx, rx) = oneshot::channel();
            rig_a.control.send(Control::PairStart { reply: tx }).await.unwrap();
            let err = timeout(Duration::from_secs(10), rx).await.unwrap().unwrap().unwrap_err();
            assert!(err.contains("席位已满"), "前置拒也要给席位人话:{err}");
        }
        rig_a.task.abort();
    }

    /// §1.3(codex r2 N1):壳层放弃等待(receiver drop)后,迟到的 PairSlot 不得把
    /// PairFlow 留活到 600 秒 TTL——到达那一刻发现无人接收即收口烧槽,下一次
    /// PairStart 秒级可成功(修前:重试恒撞「已有配对在进行中」,本测 10 秒兜底
    /// 内永远拿不到码 = 红)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pair_start_receiver_drop_frees_flow_for_retry() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db, clock, dir) = test_db("psd");
        create_account_as(&db, &url, Some(ACCT)).await.unwrap();
        let rig = spawn_transport(db.clone(), clock.clone(), dir);
        wait_state(&rig.status, "online").await;

        // 出码但立即丢弃 receiver(壳层超时放弃的形态)。
        let (tx, rx) = oneshot::channel();
        rig.control.send(Control::PairStart { reply: tx }).await.unwrap();
        drop(rx);

        // 收口发生在 PairSlot 到达那一刻;此后重试必须立即成功。轮询给收口留
        // 亚秒窗口,10 秒兜底(远小于 600s TTL,修前必超时)。
        let deadline = Instant::now() + Duration::from_secs(10);
        let code = loop {
            let (tx, rx) = oneshot::channel();
            rig.control.send(Control::PairStart { reply: tx }).await.unwrap();
            match timeout(Duration::from_secs(5), rx).await.unwrap().unwrap() {
                Ok(code) => break code,
                Err(e) => {
                    assert!(
                        e.contains("已有配对在进行中"),
                        "唯一允许的过渡性拒绝是撞上尚未收口的旧流:{e}"
                    );
                    assert!(Instant::now() < deadline, "旧流一直没收口(N1 回归)");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        };
        assert_eq!(code.split('-').count(), 3, "配对码形态 槽号-XXXX-XXXX:{code}");
    }

    /// 提交边界的运行期探针(补充锚,主闸是上面的词法测):内层每逢 Pending 断言
    /// 「配置尚未落库」,顺带验证成功路与恢复码形态。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_account_commit_boundary_no_await_after_save() {
        use std::future::Future;
        use std::pin::Pin;
        use std::task::{Context, Poll};

        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db, _clock, _dir) = test_db("cb");

        struct Probe<'a, F> {
            inner: Pin<Box<F>>,
            db: &'a Arc<Mutex<Connection>>,
        }
        impl<F: Future> Future for Probe<'_, F> {
            type Output = F::Output;
            fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
                let this = self.get_mut();
                match this.inner.as_mut().poll(cx) {
                    Poll::Ready(v) => Poll::Ready(v),
                    Poll::Pending => {
                        let conn = this.db.lock().unwrap();
                        assert!(
                            load_config(&conn).unwrap().is_none(),
                            "提交后仍挂起:save_config 之后不得再有 await"
                        );
                        Poll::Pending
                    }
                }
            }
        }

        let code = Probe { inner: Box::pin(create_account_as(&db, &url, Some(ACCT))), db: &db }
            .await
            .expect("创号成功");
        assert_eq!(code.chars().filter(|c| *c != '-').count(), 52);
        let conn = db.lock().unwrap();
        assert!(load_config(&conn).unwrap().is_some(), "提交确已发生");
    }

    // ---- 压轴:真服务器 + 双库端到端(建账户 → 配对 → 引导 → 双向实时互通) ----

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn end_to_end_pair_boot_and_realtime_converge() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");

        // A:建库、写离线数据、创建账户(register_first + 恢复码仪式的数据面)。
        let (db_a, clock_a, dir_a) = test_db("a");
        {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "甲的第一条灵感").unwrap();
        }
        let recovery = create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        assert_eq!(recovery.chars().filter(|c| *c != '-').count(), 52);
        // 重复创号拒。
        assert!(create_account_as(&db_a, &url, Some(ACCT)).await.is_err());

        let rig_a = spawn_transport(db_a.clone(), clock_a.clone(), dir_a);
        wait_state(&rig_a.status, "online").await;

        // B:发起配对(A 出码)→ pair_join → 传输任务自动引导。
        let (db_b, clock_b, dir_b) = test_db("b");
        let (tx, rx) = oneshot::channel();
        rig_a.control.send(Control::PairStart { reply: tx }).await.unwrap();
        let code = timeout(Duration::from_secs(10), rx).await.unwrap().unwrap().unwrap();
        pair_join(&db_b, &url, &code, |_| Ok(())).await.unwrap();
        {
            let conn = db_b.lock().unwrap();
            let cfg = load_config(&conn).unwrap().expect("配对后已配置");
            assert_eq!(cfg.account_id, ACCT);
            assert_eq!(cfg.server_url, url, "grant 交付的 server_url 落库");
            assert!(meta_get(&conn, "bootstrapped_at").unwrap().is_none(), "引导前无纪元标记");
        }
        // 配对码单次有效:同码再入必败(槽已烧)。
        assert!(pair_join(&test_db("b2").0, &url, &code, |_| Ok(())).await.is_err());

        let rig_b = spawn_transport(db_b.clone(), clock_b.clone(), dir_b);
        wait_state(&rig_b.status, "online").await; // booting → 引导完成 → online
        wait_until("B 引导拿到 A 的数据", || count_items(&db_b) == 1).await;

        // 双向实时:B 写 → A 收;A 写 → B 收(update_hook 通知 → 亚秒推送)。
        {
            let mut conn = db_b.lock().unwrap();
            let mut clk = clock_b.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "乙的新灵感").unwrap();
        }
        wait_until("A 收到 B 的实时写", || count_items(&db_a) == 2).await;
        {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "甲的第二条").unwrap();
        }
        wait_until("B 收到 A 的实时写", || count_items(&db_b) == 3).await;
        wait_until("oplog 两端逐行一致", || {
            oplog_fingerprint(&db_a) == oplog_fingerprint(&db_b)
        })
        .await;

        // ack 驱动的出站游标已落盘(= 各自本机水位)。
        wait_until("A 的 last_pushed 抬到位", || {
            let conn = db_a.lock().unwrap();
            let dev = clock_a.lock().unwrap().device_id().to_string();
            let wm: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(origin_seq),0) FROM oplog WHERE origin = ?1",
                    [&dev],
                    |r| r.get(0),
                )
                .unwrap();
            read_last_pushed(&conn).unwrap() == wm && wm > 0
        })
        .await;

        // 状态面:双方 online、各见对方一台在线。
        assert_eq!(rig_a.status.lock().unwrap().peers_online, 1);
        assert_eq!(rig_b.status.lock().unwrap().peers_online, 1);
        assert!(rig_a.status.lock().unwrap().frozen.is_empty());

        // 恢复码与 A 库里的 K_acc 互逆(强制仪式的数据面)。
        {
            let conn = db_a.lock().unwrap();
            let k = unhex32(&meta_get(&conn, "k_acc").unwrap().unwrap()).unwrap();
            assert_eq!(crypto::parse_recovery_code(&recovery), Ok(k));
        }

        rig_a.task.abort();
        rig_b.task.abort();
        let _ = (rig_a.wrote, rig_b.wrote);
    }

    /// space-entry-plan §3.2:BootCommitted 共享 latch——引导持久提交后、
    /// start_engine 之前恰好一次 ready(needs_reopen=false、report 计数如实、
    /// sender 已被消费);latch 属 Transport 生命周期(不进 Ctx),ready 后引导路
    /// 照常走完(online + 数据到齐),证明 latch 不阻塞正常收尾。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn boot_commit_latch_fires_once_before_engine_start() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db_a, clock_a, dir_a) = test_db("latch-a");
        {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "甲的灵感").unwrap();
        }
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let rig_a = spawn_transport(db_a.clone(), clock_a.clone(), dir_a);
        wait_state(&rig_a.status, "online").await;

        let (db_b, clock_b, dir_b) = join_via(&rig_a, &url, "latch-b").await;
        let (notice_tx, notice_rx) = oneshot::channel();
        let latch: BootCommitLatch = Arc::new(Mutex::new(Some(notice_tx)));
        let rig_b = spawn_transport_full(
            db_b.clone(),
            clock_b.clone(),
            dir_b,
            BlobPolicy::Full,
            true,
            latch.clone(),
        );
        let notice = timeout(Duration::from_secs(30), notice_rx)
            .await
            .expect("引导提交后 latch 必须 ready")
            .expect("sender 不该无声消亡");
        assert!(!notice.needs_reopen, "{notice:?}");
        assert!(notice.post_commit_error.is_none(), "{notice:?}");
        assert_eq!(notice.report.items, 1, "{notice:?}");
        assert!(latch.lock().unwrap().is_none(), "sender 已被消费:latch 恰 ready 一次");
        {
            let conn = db_b.lock().unwrap();
            assert!(
                meta_get(&conn, "bootstrapped_at").unwrap().is_some(),
                "latch ready 时提交必已持久"
            );
        }
        wait_state(&rig_b.status, "online").await;
        wait_until("B 拿到数据", || count_items(&db_b) == 1).await;
        rig_a.task.abort();
        rig_b.task.abort();
    }

    /// latch 跨**已鉴权 session** 存活(三轮 M1 的正面锚,codex 二轮 L1):B 配对后
    /// 无引导源在线 → 第一个已鉴权 session 停在 booting;Control::Reconfigured 强制
    /// 销毁该 session(Ctx 生灭一轮)→ latch 完好;源上线后第二个 session 完成引导,
    /// notice 恰 ready 一次——sender 若被错误下沉进 Ctx,第一次 session 销毁就会关
    /// 通道,本测当场红。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn boot_commit_latch_survives_authenticated_session_teardown() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db_a, clock_a, dir_a) = test_db("latch-x-a");
        {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "甲的灵感").unwrap();
        }
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let rig_a = spawn_transport(db_a.clone(), clock_a.clone(), dir_a.clone());
        wait_state(&rig_a.status, "online").await;
        let (db_b, clock_b, dir_b) = join_via(&rig_a, &url, "latch-x-b").await;
        // 源下线:B 的 session 将鉴权成功后停在 booting(无人供快照)。
        rig_a.task.abort();
        let (notice_tx, notice_rx) = oneshot::channel();
        let latch: BootCommitLatch = Arc::new(Mutex::new(Some(notice_tx)));
        let rig_b = spawn_transport_full(
            db_b.clone(),
            clock_b.clone(),
            dir_b,
            BlobPolicy::Full,
            true,
            latch.clone(),
        );
        wait_state(&rig_b.status, "booting").await;
        // 强制销毁这个已鉴权 session(Reconfigured → SessionEnd::Reconfigured →
        // Ctx 落地销毁 → 新 session)。latch 必须原地完好。
        rig_b.control.send(Control::Reconfigured).await.unwrap();
        wait_state(&rig_b.status, "booting").await;
        assert!(latch.lock().unwrap().is_some(), "sender 不许随已鉴权 session 销毁而消亡");
        // 源重新上线 → 第二个 session 完成引导 → notice 恰 ready 一次。
        let rig_a2 = spawn_transport(db_a.clone(), clock_a.clone(), dir_a);
        let notice = timeout(Duration::from_secs(30), notice_rx)
            .await
            .expect("第二个 session 引导后 latch 必须 ready")
            .expect("sender 不该无声消亡");
        assert!(!notice.needs_reopen);
        assert_eq!(notice.report.items, 1);
        assert!(latch.lock().unwrap().is_none(), "恰 ready 一次");
        wait_until("B 拿到数据", || count_items(&db_b) == 1).await;
        rig_a2.task.abort();
        rig_b.task.abort();
    }

    /// latch 属 Transport 生命周期、不进 Ctx(三轮 M1 的反面锚):对连不上的服务器
    /// 反复退避重连(多个 session 生灭)后,sender 仍在 latch 里、receiver 未被关——
    /// 「第一次断线就关通道、JoinManager 误判失败」的旧模式在此现形。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn boot_commit_latch_survives_reconnect_cycles() {
        let (db, clock, dir) = test_db("latch-live");
        {
            let mut conn = db.lock().unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','{ACCT}'),
                   ('k_acc','{z}'),('device_key','{z}'),('server_url','ws://127.0.0.1:1');",
                z = "00".repeat(32),
            ))
            .unwrap();
            let _ = &mut conn;
        }
        let (notice_tx, mut notice_rx) = oneshot::channel();
        let latch: BootCommitLatch = Arc::new(Mutex::new(Some(notice_tx)));
        let rig = spawn_transport_full(db, clock, dir, BlobPolicy::Full, true, latch.clone());
        wait_state(&rig.status, "offline").await;
        // 至少两轮重连周期(1s→2s 退避)后:latch 完好、receiver 未关。
        tokio::time::sleep(Duration::from_millis(3500)).await;
        assert!(latch.lock().unwrap().is_some(), "sender 不许随 session 生灭而消亡");
        assert!(
            matches!(notice_rx.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
            "receiver 只能是 Empty(未 ready 也未被关)"
        );
        rig.task.abort();
    }

    /// 未配置 = 零打扰:状态 off,配对请求得到人话拒绝,任务持续待命。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unconfigured_transport_stays_off_and_rejects_pairing() {
        let (db, clock, dir) = test_db("off");
        let rig = spawn_transport(db, clock, dir);
        wait_state(&rig.status, "off").await;
        let (tx, rx) = oneshot::channel();
        rig.control.send(Control::PairStart { reply: tx }).await.unwrap();
        let err = timeout(Duration::from_secs(5), rx).await.unwrap().unwrap().unwrap_err();
        assert!(err.contains("尚未加入账户"), "{err}");
        assert!(!rig.status.lock().unwrap().configured);
        rig.task.abort();
    }

    /// 错配对码:SPAKE2 密钥确认拆穿,槽被烧,joiner 得到人话错误。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn wrong_pair_code_burns_slot_with_human_error() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db_a, clock_a, dir_a) = test_db("wp-a");
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let rig_a = spawn_transport(db_a, clock_a, dir_a);
        wait_state(&rig_a.status, "online").await;
        let (tx, rx) = oneshot::channel();
        rig_a.control.send(Control::PairStart { reply: tx }).await.unwrap();
        let code = timeout(Duration::from_secs(10), rx).await.unwrap().unwrap().unwrap();
        // 篡改 SECRET 段(把每个字符换成字母表里的下一个,必与原 SECRET 不同)。
        let (slot_part, secret_part) = code.split_once('-').unwrap();
        let bad_secret: String = secret_part
            .chars()
            .map(|c| {
                if c == '-' {
                    c
                } else {
                    let i = crate::sync::crypto::CROCKFORD
                        .iter()
                        .position(|&b| b as char == c)
                        .unwrap();
                    crate::sync::crypto::CROCKFORD[(i + 1) % 32] as char
                }
            })
            .collect();
        let bad_code = format!("{slot_part}-{bad_secret}");
        let (db_b, _clock_b, _dir_b) = test_db("wp-b");
        let err = pair_join(&db_b, &url, &bad_code, |_| Ok(())).await.unwrap_err();
        assert!(
            err.contains("配对") || err.contains("中止"),
            "错码要给人话错误:{err}"
        );
        rig_a.task.abort();
    }

    /// §4 两阶段账户闸(工序 7/8 审查 H1):gate 拒在 `Grant → Enroll` 停点——
    /// Enroll 从未发出、老端从不 register_device、配置一个键都不写;同一空间
    /// (同 device_id)随后用新配对码照常加入。若停点失效(gate 卡到 Done 之后),
    /// 第一轮已把 device_id 注册进 registry,第二轮换新 pubkey 必撞 device_id_taken
    /// ——本测试的第二轮成功即是「身份没烧」的行为证明。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn account_gate_rejects_before_enroll_and_identity_survives() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db_a, clock_a, dir_a) = test_db("gate-a");
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let rig_a = spawn_transport(db_a, clock_a, dir_a);
        wait_state(&rig_a.status, "online").await;

        // 第一轮:gate 拒(账户被别的空间占用的裁决)。
        let (db_b, _clock_b, _dir_b) = test_db("gate-b");
        let (tx, rx) = oneshot::channel();
        rig_a.control.send(Control::PairStart { reply: tx }).await.unwrap();
        let code = timeout(Duration::from_secs(10), rx).await.unwrap().unwrap().unwrap();
        let err = pair_join(&db_b, &url, &code, |acc: &str| {
            Err(format!("这个账户已被空间「家庭」使用({acc})"))
        })
        .await
        .unwrap_err();
        assert!(err.contains("已被空间"), "gate 的拒绝原话要透传:{err}");
        {
            let conn = db_b.lock().unwrap();
            assert!(load_config(&conn).unwrap().is_none(), "gate 拒后配置一个键都不写");
        }

        // 第二轮:同一空间新码重配、gate 放行——成功即证明第一轮从未注册。
        // (B 的 PairClose 传到 A 清场是异步的,PairStart 撞「已有配对在进行中」就稍等重试。)
        let code = {
            let mut got = None;
            for _ in 0..100 {
                let (tx, rx) = oneshot::channel();
                rig_a.control.send(Control::PairStart { reply: tx }).await.unwrap();
                match timeout(Duration::from_secs(10), rx).await.unwrap().unwrap() {
                    Ok(c) => {
                        got = Some(c);
                        break;
                    }
                    Err(e) if e.contains("已有配对") => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(e) => panic!("第二次发起配对不该败于:{e}"),
                }
            }
            got.expect("A 侧上一轮配对未在限时内清场")
        };
        pair_join(&db_b, &url, &code, |_| Ok(())).await.unwrap();
        {
            let conn = db_b.lock().unwrap();
            assert_eq!(load_config(&conn).unwrap().expect("重配成功").account_id, ACCT);
        }
        rig_a.task.abort();
    }

    /// 配对 A(全量)出码、B 加入,返回 B 的库/钟/目录(B 的传输任务由调用方按策略起)。
    async fn join_via(
        rig_a: &Rig,
        url: &str,
        tag: &str,
    ) -> (Arc<Mutex<Connection>>, Arc<Mutex<Clock>>, PathBuf) {
        let (db, clock, dir) = test_db(tag);
        let (tx, rx) = oneshot::channel();
        rig_a.control.send(Control::PairStart { reply: tx }).await.unwrap();
        let code = timeout(Duration::from_secs(10), rx).await.unwrap().unwrap().unwrap();
        pair_join(&db, url, &code, |_| Ok(())).await.unwrap();
        (db, clock, dir)
    }

    fn count_images(db: &Arc<Mutex<Connection>>) -> i64 {
        let conn = db.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap()
    }

    /// M1 端到端(android-plan §4 测试②③ + 96 验收矩阵⑤的传输层形):轻端引导拿
    /// 全量(含图字节),引导后的新图只记 op 不建行不拉流;任务 op(A 建 B 勾 done、
    /// B 直建 todo)双向照常收敛。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn metadata_only_peer_syncs_ops_and_tasks_without_pulling_blobs() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");

        // A(桌面全量端):离线数据 = 一条带图条目;创号上线。
        let (db_a, clock_a, dir_a) = test_db("mo-a");
        let item_a = {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            let id = notes::capture(&mut conn, &mut clk, "甲的带图条目").unwrap();
            images::attach(&mut conn, &mut clk, &id, &[1u8; 64], "image/png").unwrap();
            id
        };
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let rig_a = spawn_transport(db_a.clone(), clock_a.clone(), dir_a);
        wait_state(&rig_a.status, "online").await;

        // B(MetadataOnly + allow_boot_source=false 的策略端):配对加入 → 引导上线。
        let (db_b, clock_b, dir_b) = join_via(&rig_a, &url, "mo-b").await;
        let mut rig_b = spawn_transport_with(
            db_b.clone(),
            clock_b.clone(),
            dir_b,
            BlobPolicy::MetadataOnly,
            false,
        );
        wait_state(&rig_b.status, "online").await;
        wait_until("B 引导拿到 A 的数据", || count_items(&db_b) == 1).await;
        assert_eq!(count_images(&db_b), 1, "引导 = 全量快照,含图字节(§3 A 拍板)");
        // BootProgress 序列(codex P4-d 轮 M3):至少一枚、received 单调不降、total
        // 恒定、终枚 received == total。
        let mut progress: Vec<(i64, i64)> = vec![];
        while let Ok(ev) = rig_b.events.try_recv() {
            if let SyncEvent::BootProgress { received, total } = ev {
                progress.push((received, total));
            }
        }
        assert!(!progress.is_empty(), "引导必须报进度");
        let total = progress[0].1;
        assert!(total > 0);
        let mut prev = -1i64;
        for (r, t) in &progress {
            assert_eq!(*t, total, "total 恒定");
            assert!(*r >= prev, "received 单调不降");
            prev = *r;
        }
        assert_eq!(progress.last().unwrap().0, total, "终枚 received == total");

        // A 引导后再贴一张图:B 收 op 记账推水位,但不建行、不拉字节(M1)。
        {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            images::attach(&mut conn, &mut clk, &item_a, &[2u8; 128], "image/png").unwrap();
        }
        wait_until("image_add op 已到 B(oplog 逐行一致)", || {
            oplog_fingerprint(&db_a) == oplog_fingerprint(&db_b)
        })
        .await;
        tokio::time::sleep(Duration::from_millis(500)).await; // 给「不该发生的拉流」留窗口
        assert_eq!(count_images(&db_a), 2);
        assert_eq!(count_images(&db_b), 1, "MetadataOnly:引导后的新图永不建行、不拉字节");

        // 任务面(验收矩阵⑤):A 建任务 → B 勾 done;B 直接建 todo → A 收。
        {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            task::create(&mut conn, &mut clk, "甲派的活", None, None, None).unwrap();
        }
        wait_until("B 收到 A 的任务", || {
            let conn = db_b.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM items WHERE stage = 'todo'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
                == 1
        })
        .await;
        let task_id: String = {
            let conn = db_b.lock().unwrap();
            conn.query_row("SELECT id FROM items WHERE stage = 'todo'", [], |r| r.get(0)).unwrap()
        };
        {
            let mut conn = db_b.lock().unwrap();
            let mut clk = clock_b.lock().unwrap();
            task::transition(&mut conn, &mut clk, &task_id, "done").unwrap();
        }
        wait_until("A 看到任务被 B 勾成 done", || {
            let conn = db_a.lock().unwrap();
            conn.query_row("SELECT stage FROM items WHERE id = ?1", [&task_id], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
                == "done"
        })
        .await;
        {
            let mut conn = db_b.lock().unwrap();
            let mut clk = clock_b.lock().unwrap();
            task::create(&mut conn, &mut clk, "乙记的待办", None, None, None).unwrap();
        }
        wait_until("A 收到 B 直接建的 todo", || count_items(&db_a) == 3).await;
        wait_until("oplog 终局逐行一致", || {
            oplog_fingerprint(&db_a) == oplog_fingerprint(&db_b)
        })
        .await;

        rig_a.task.abort();
        rig_b.task.abort();
        let _ = (rig_a.wrote, rig_b.wrote);
    }

    /// M1 测试⑤:`allow_boot_source=false` 的端不供引导快照——账户里只剩这种端
    /// 在线时,新设备引导保持等待(静默不供,§6.2 超时轮转语义),不会拿到
    /// 「部分克隆」。M1(MetadataOnly)语义保留;两端壳现均传 true(phone-space-
    /// plan 对称升格),false 仍是合法配置、语义由本测钉住。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn light_peer_refuses_to_serve_boot_snapshot() {
        // 三设备拓扑:免费档 2 席不够,admin 提额(生产同语义:多设备账户=显式授权)。
        let (addr, admin, token) = start_server_with_admin().await;
        let url = format!("ws://{addr}");
        let (db_a, clock_a, dir_a) = test_db("lb-a");
        {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "账户数据").unwrap();
        }
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let resp = admin_post(
            admin,
            token,
            &format!("/admin/entitlement?account={ACCT}&tier=test&seat_quota=8&fastlane_bytes_per_month=1"),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 200"), "提额应 200:{resp}");
        let rig_a = spawn_transport(db_a.clone(), clock_a.clone(), dir_a);
        wait_state(&rig_a.status, "online").await;

        // B 轻端入账户并完成引导(从 A 拿快照)。
        let (db_b, clock_b, dir_b) = join_via(&rig_a, &url, "lb-b").await;
        let rig_b = spawn_transport_with(
            db_b.clone(),
            clock_b.clone(),
            dir_b,
            BlobPolicy::MetadataOnly,
            false,
        );
        wait_state(&rig_b.status, "online").await;
        wait_until("B 引导完成", || count_items(&db_b) == 1).await;

        // C 也配对入账户(趁 A 在线出码),随后 A 下线——等 B 看到 A 摘除(服务器
        // detach 有竞态,codex 复核 L:不等的话 C 可能还把 Req 发给「名义在线」的 A,
        // 结论就不干净)再起 C:账户里确定只剩轻端 B 在线。
        let (db_c, clock_c, dir_c) = join_via(&rig_a, &url, "lb-c").await;
        rig_a.task.abort();
        wait_until("A 已从在线表摘除", || rig_b.status.lock().unwrap().peers_online == 0).await;
        let rig_c = spawn_transport(db_c.clone(), clock_c.clone(), dir_c);
        wait_state(&rig_c.status, "booting").await;
        // 若轻端供快照,亚秒即完成引导;4 秒后仍 booting 且零数据 = 确实拒供。
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert_eq!(
            rig_c.status.lock().unwrap().state,
            "booting",
            "轻端不供快照,C 保持等待全量端回归"
        );
        assert_eq!(count_items(&db_c), 0, "C 没有从轻端拿到任何快照数据");

        rig_b.task.abort();
        rig_c.task.abort();
        let _ = (rig_a.wrote, rig_b.wrote, rig_c.wrote);
    }

    /// 上一只测试的正对照(codex P4-d 轮 M3):同拓扑、唯一区别是 B 允许供快照
    /// (Full/true)——A 下线后 C 能从 B 完成引导。证明拒供测试里 C 卡住的唯一
    /// 解释就是 allow_boot_source=false,不是拓扑或时序碰巧。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn full_peer_serves_boot_when_it_is_the_only_one_online() {
        // 三设备拓扑,同上一只:admin 提额后再配第三台。
        let (addr, admin, token) = start_server_with_admin().await;
        let url = format!("ws://{addr}");
        let (db_a, clock_a, dir_a) = test_db("fb-a");
        {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "账户数据").unwrap();
        }
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let resp = admin_post(
            admin,
            token,
            &format!("/admin/entitlement?account={ACCT}&tier=test&seat_quota=8&fastlane_bytes_per_month=1"),
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 200"), "提额应 200:{resp}");
        let rig_a = spawn_transport(db_a.clone(), clock_a.clone(), dir_a);
        wait_state(&rig_a.status, "online").await;

        let (db_b, clock_b, dir_b) = join_via(&rig_a, &url, "fb-b").await;
        let rig_b = spawn_transport(db_b.clone(), clock_b.clone(), dir_b);
        wait_state(&rig_b.status, "online").await;
        wait_until("B 引导完成", || count_items(&db_b) == 1).await;

        let (db_c, clock_c, dir_c) = join_via(&rig_a, &url, "fb-c").await;
        rig_a.task.abort();
        // 等 B 看到 A 摘除再起 C(codex 复核 L):否则「C 从 B 引导成功」可能实际
        // 是从名义在线的 A 拿的,正对照就不成立。
        wait_until("A 已从在线表摘除", || rig_b.status.lock().unwrap().peers_online == 0).await;
        let rig_c = spawn_transport(db_c.clone(), clock_c.clone(), dir_c);
        wait_state(&rig_c.status, "online").await;
        wait_until("C 从 B(唯一在线的全量端)完成引导", || count_items(&db_c) == 1).await;

        rig_b.task.abort();
        rig_c.task.abort();
        let _ = (rig_a.wrote, rig_b.wrote, rig_c.wrote);
    }
}
