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
//! 是契约被破坏时的最后防线);**导入完成后装配 Engine 再走会话仪式**(boot.rs
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

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
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
use crate::sync::engine::{
    OpsServe, OpsServeTo,
    read_blob_chunk, BlobServe, Engine, Event, Lane, Msg, Output, Route, RouteHint, BROADCAST,
};
use crate::sync::lan::{self, Ingress, LanAd};
use crate::sync::lan_net;
use crate::sync::ops_serve;
use crate::sync::pair::{self, AccountGrant, DeviceEnroll, PairOutput};

/// 图字节旁路策略(M1,定义在 engine、由壳层经 [`Transport`] 注入)——sync 模块
/// 对外只露 transport,策略枚举从这里出 crate(android-plan §1 窄公开面)。
pub use crate::sync::engine::BlobPolicy;
/// app 级局域网监听器与准入表(lan-direct-plan §6)。壳层建一枚给 supervisor,
/// 同样从 transport 出 crate(窄公开面:sync 模块对外只露 transport 与 supervisor)。
pub use crate::sync::lan_net::LanAdmission;

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
    !identity_still_current(db, &cfg.account_id, &cfg.device_id, &cfg.k_acc, &cfg.device_seed)
}

/// 上一条的**唯一实现**,拆出来是因为 LAN pre-auth 握手任务手上没有 `SyncConfig`
/// (lan-direct-plan §6 ⑤ 的第五条身份出口,见 [`super::lan_net`])。两处共用一把尺,
/// 「握手那条路的自证比会话循环松一档」在结构上就不成立。
///
/// `true` = 库里此刻的身份仍是调用方手上那一份(且没有 pending 身份封闸)。读不出配置 /
/// 未配置 / 封闸,一律 `false`(fail-closed)。
pub(crate) fn identity_still_current(
    db: &Arc<Mutex<Connection>>,
    account_id: &str,
    device_id: &str,
    k_acc: &[u8; 32],
    device_seed: &[u8; 32],
) -> bool {
    let conn = db.lock().expect("db mutex poisoned");
    identity_still_current_conn(&conn, account_id, device_id, k_acc, device_seed)
}

/// 上一条的**已持锁形**:LAN 供流写泵要把「自证 + 取这一块」放进同一把锁里办完
/// (264 实现审 M1:分两次取锁的话,「查完身份、换代提交、再读块」那个窄窗会漏一块
/// 旧身份的帧过去)。
pub(crate) fn identity_still_current_conn(
    conn: &Connection,
    account_id: &str,
    device_id: &str,
    k_acc: &[u8; 32],
    device_seed: &[u8; 32],
) -> bool {
    if !matches!(pending_identity_block(conn), Ok(None)) {
        return false;
    }
    match load_config(&conn) {
        Ok(Some(now)) => {
            now.account_id == account_id
                && now.device_id == device_id
                && now.k_acc == *k_acc
                && now.device_seed == *device_seed
        }
        _ => false,
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
    /// 已冻结的 origin(分叉,§11 手工流程恢复)。L-c2a 起引擎活到 runtime 生命期,
    /// 故这一项**照引擎的当前事实**、不再每次建连清零重攒(清零会把真在场的冻结抹成
    /// 「没事」,直到下一帧到了才复现)。
    pub frozen: Vec<String>,
    /// 已持久隔离的 origin(毒 op,epoch-plan §4;跨重启,处置=升级重验或吊销重配)。
    pub quarantined: Vec<String>,
    /// poison-breaker 置位原因(§4 fail-closed:拒收新 origin;冻结表满额时升级为拒收
    /// 一切尚未 frozen/quarantine 在册的 origin。人工处置后复位)。
    pub poison_breaker: Option<String>,
    /// 挂起的 origin 数(依赖未到/对端版本较新,通常瞬态)。
    pub suspended: usize,
    /// 收到过「解得开但读不懂」的帧:对端版本较新,请升级。
    pub skew: bool,
    /// 收到过 HLC 墙钟比本机快 >24h 的远端 op(L1):对端系统时间可能错、LWW 会偏向它。
    pub clock_skew: bool,
    /// 局域网**通告面**的诊断(形态不合 / 缓存读不动 / 本机通告停用 / 链路断)。刻意与
    /// [`Self::error`] 分开(codex L-c2b 审 M3):通告是 advisory 面,拿它盖掉冻结、隔离、
    /// 拒帧那些正确性面的人话原因是回归——同步能不能收敛与直连能不能起来是两件事。
    ///
    /// **⚠ 已知缺口(262 真机实测,渲染这一格之前必须先修)**:这一格只在**中转会话仪式**
    /// 那一刻重算,**不随条件解除而清**。实测形:对端进程被杀 → 这里写下「与 X 的局域网
    /// 直连已断」→ 拨号器几秒后重新建上链([`Self::lan_peers`] 回到 1)→ **警告仍挂着**,
    /// 直到下一次中转会话开始。中转可以一挂几小时,故这条陈旧话的可见期很长。现在无害
    /// (两端前端都没读这一格),但界面一旦显它,就会指着一条活着的直连说它断了。
    pub lan_warning: Option<String>,
    /// 已被同 id 异钥**粘滞禁用**直连的对端(§2)。随引擎装配从缓存重检,故这份快照跨
    /// 重启可重建;解除只有换 device_id 或走纪元轮换。
    ///
    /// **诚实边界**(codex 二审 L2 / L-c2c 校准;262 复核仍然成立):这三格目前只是
    /// **后端可查**——两端前端还没声明也没渲染它们(冲突当场有一次 toast,重启后就只在
    /// 快照里)。用户可见的 lan 面是 L 系列尚未排期的一笔(L-e 之后),它开工时先清
    /// [`Self::lan_warning`] 上那条已知缺口;在那之前别把这三格并回 `error` 充数。
    /// 262 的真机验收就是靠裸 invoke 读这三格 + `netstat` + 直接读库拼出来的。
    pub lan_disabled: Vec<String>,
    /// 当前活跃的局域网直连链路数(§6)。无开关、默认启用,故这一格就是「直连有没有起
    /// 来」的唯一 UI 依据。
    pub lan_peers: usize,
    /// op 追赶供流的**有界降级 / 资源拒绝**(lan-direct-plan §6.2 ③)。单槽,只留最后一条。
    ///
    /// 刻意**既不占 [`Self::error`]**(那是正确性面)**也不并进 [`Self::lan_warning`]**
    /// (那是 LAN 专用面,而 ops 追赶两条腿都有)。去重不另建旁表:文本是 `(target, class)`
    /// 的纯函数([`engine::ops_notice`]),而 [`set_status`] 本就「快照没变不发事件」,
    /// 于是「同一条不重报 / 被别的盖过之后允许再报」两条自然成立。
    pub ops_notice: Option<String>,
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
/// `relay_session_up` 之前 `take()+send()`;**receiver 关闭只有在 Transport 任务也已
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
    /// 局域网直连的宿主(lan-direct-plan §6;L-c3a)。`Some` = 本空间参与直连:LanReady
    /// 置位时把准入条目注册进 **app 级监听器**、撤位与收场时摘掉;拿回的监听端口写进
    /// `LanAd.listen` 随 Hello 通告出去(§2)。
    ///
    /// `None` 的三档:手机壳(§6「手机壳不监听、只拨出」,拨号器归 L-c3b)、staging 传输
    /// (「加入空间」的一次性连接,不是一个 live 空间)、以及大部分单测。
    pub lan: Option<LanHost>,
}

/// [`Transport::lan`] 的三件:本空间在准入表里的键、那张 app 级表本身,与本次装配的
/// **注册者号**。
///
/// 注册者号由**建这枚 `LanHost` 的人**给(supervisor 传 runtime generation),不是
/// transport 自己发号(实现审 H1):`stop` 必须能在拉停机信号**之前**就把准入条目摘掉
/// ——那一步只有 supervisor 做得到,而它得先说得出「摘谁的」。号**永不复用**,故旧
/// runtime 收场时那声注销摘不掉新 runtime 刚注册的条目。
#[derive(Clone)]
pub struct LanHost {
    pub space_id: String,
    pub admission: Arc<LanAdmission>,
    pub owner: u64,
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

// ---- 局域网通告面(lan-direct-plan §2:身份与地址通告经 Hello 捎带) ----

/// 对端通告缓存的键名(`lan_peer:<device_id>`)。**设备本地、永不同步、boot 不导入**
/// ——末一条是结构事实不是纪律:引导导入逐表 `INSERT … SELECT`(boot.rs §6.2),压根
/// 不碰 `sync_meta`。
fn lan_peer_key(peer: &str) -> String {
    format!("lan_peer:{peer}")
}

/// 读一条对端通告缓存(值 = CBOR 的 hex——`sync_meta.value` 是 TEXT 列,与
/// `k_acc`/`device_key` 同一记法)。
///
/// **读不动一律 Err,绝不当「没缓存」**:那会把「首见钉住」变成可反复触发的东西——
/// 一枚读不懂的记录就让下一枚 Hello 重新钉一把新钥,同 id 异钥的粘滞禁用从此永不触发。
/// 调用方把这个 Err 收进状态面即止(通告是 advisory 面,§2 明写不许牵动该 Hello 的
/// 水位处理);直连面 fail-closed = 该对端本轮不建链。
///
/// `pub(crate)`:监听侧的 pre-auth 握手任务([`super::lan_net`])要拿钉住的验证钥当
/// §4 步骤 1 的第三道闸——**同一个读口**,故「握手那条路自己另写一份宽松的读法」不存在。
pub(crate) fn read_peer_ad(
    conn: &Connection,
    peer: &str,
) -> Result<Option<lan::LanPeerAd>, String> {
    let Some(raw) = meta_get(conn, &lan_peer_key(peer))? else { return Ok(None) };
    let bytes = unhex(&raw).map_err(|e| format!("{peer} 的局域网通告缓存不是 hex:{e}"))?;
    // 严格「一个值」:CBOR 解出记录后必须**恰好耗尽**字节(同 `lan::decode_wire` 那条,
    // codex L-c2b 审 L2)。不查的话「合法记录 + 尾随垃圾」会被悄悄接受,「读不动一律
    // 响亮」的口径就只覆盖了一半。记录本身有界(`merge_peer_ad` 已限 addrs ≤8 × ≤45B)。
    let mut cursor = std::io::Cursor::new(&bytes[..]);
    let rec: lan::LanPeerAd = ciborium::from_reader(&mut cursor)
        .map_err(|e| format!("{peer} 的局域网通告缓存无法解码:{e}"))?;
    if cursor.position() as usize != bytes.len() {
        return Err(format!("{peer} 的局域网通告缓存有尾随字节"));
    }
    Ok(Some(rec))
}

/// 落库。**唯一出口**——首见钉住 / 序号推进 / 冲突禁用三种起因在 lan.rs 那侧就已合成
/// 一个 [`lan::AdMerge::Store`],所以这里没有「记得给冲突也落一次库」的自律空间。
fn write_peer_ad(conn: &Connection, peer: &str, rec: &lan::LanPeerAd) -> Result<(), String> {
    let mut buf = Vec::new();
    ciborium::into_writer(rec, &mut buf).map_err(|e| e.to_string())?;
    meta_put(conn, &lan_peer_key(peer), &hex(&buf))
}

/// 本机通告序号(`sync_meta.lan_ad_seq`;缺席 = 0「从未发布过」,首发即 1)。canonical
/// 严格解析([`lan::parse_ad_seq`]:前导零 / 负号 / 越界一律拒)——计数器是单调性的唯一
/// 凭据,宽进等于养出非规范形态。
fn read_ad_seq(conn: &Connection) -> Result<u64, String> {
    match meta_get(conn, "lan_ad_seq")? {
        None => Ok(0),
        Some(raw) => lan::parse_ad_seq(&raw),
    }
}

/// 递增并**落库成功才返回给封帧处用**(§2 三轮 L2):先发后落的崩溃窗口会让同一序号
/// 发两次不同 listen,收端只认第一枚、本机从此刷不新地址。到 `u64::MAX` 即 Err(绝不
/// 回绕:回绕后收端「更小序号不收」会把本机永久钉死在旧通告上)。
fn bump_ad_seq(conn: &Connection) -> Result<u64, String> {
    let next = lan::next_ad_seq(read_ad_seq(conn)?)?;
    meta_put(conn, "lan_ad_seq", &next.to_string())?;
    Ok(next)
}

/// `lan_peer:*` 的行数硬上界(codex L-c2b 二审 M2)。**「换代即清」不是上界**:同一
/// (账户, 本机 device_id) 代内可以不断移除旧设备、注册新设备,席位帽只限同时在册数、
/// 不限这一代历史上出现过多少个不同的 `Deliver.from`。
///
/// 64 = 最大席位档(16)的四倍余量:真实家庭账户几辈子也到不了,单条又只有百字节级。
/// 满额的处置是**新对端 fail-closed**(它的直连不可用、中转照常),不是静默 LRU 淘汰
/// ——淘汰会让「每条记录一生只首见一次」和粘滞禁用双双失效。攻击面:行键取自服务器
/// 鉴权过的 `from`,一个成员只能占一行,想灌满得真注册 64 台(每台烧一个席位)。
const MAX_LAN_PEER_RECORDS: usize = 64;

/// 通告面归属的本机身份(`sync_meta.lan_ad_owner` = `<账户>/<device_id>`)。
///
/// 通告缓存与本机序号都只对**某一代本机身份**有意义:纪元压实换了 device_id + K_acc 之后,
/// 缓存里那些对端 id 永不再匹配(它们也换代了),本机序号也与新身份下的对端水位无关。
/// 「该不该丢」由这枚**落库的指纹自证**(codex L-c2b 审 M2),不靠 `epoch::compact` /
/// `clear_config` 记得清——L-c2a 的 `EngineSlot` 同一条教训,且压实期间引擎已撤台、
/// 进程内的换代检测根本看不见那一跳(重启后槽本来就是空的)。
///
/// **清缓存 + 清序号 + 盖章必须同一个事务**(codex 二审 M1):三条独立 autocommit 的话,
/// 「缓存清了、序号没清、章没盖」这一半态会让本轮以**新身份**发布**旧计数器**(比如 51),
/// 下一轮清成功后新身份从 1 重发 → 对端「更小不收」把本机长期钉死;反方向(序号清了、
/// 章没盖)则是同一序号在两轮里配两份内容。失败后本轮由调用方**整个关掉通告面**,
/// 不是「带着半态继续发」。
///
/// 退出账户后**用同一 device_id 重新加入同一账户**时指纹不变,缓存照留——那些对端还是
/// 原来那些对端,记录仍然有效(这正是不无条件清的理由)。
fn reconcile_lan_ad_owner(conn: &mut Connection, cfg: &SyncConfig) -> Result<(), String> {
    let owner = format!("{}/{}", cfg.account_id, cfg.device_id);
    if meta_get(conn, "lan_ad_owner")?.as_deref() == Some(owner.as_str()) {
        return Ok(());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // `_` 是 LIKE 的单字符通配,必须转义——否则 `lan_peer:%` 连 `lanXpeer:…` 一起删。
    tx.execute(r"DELETE FROM sync_meta WHERE key LIKE 'lan\_peer:%' ESCAPE '\'", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sync_meta WHERE key = 'lan_ad_seq'", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO sync_meta (key, value) VALUES ('lan_ad_owner', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&owner],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// 当前缓存的对端条数([`MAX_LAN_PEER_RECORDS`] 的判据)。
fn count_peer_ads(conn: &Connection) -> Result<usize, String> {
    conn.query_row(
        r"SELECT COUNT(*) FROM sync_meta WHERE key LIKE 'lan\_peer:%' ESCAPE '\'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n as usize)
    .map_err(|e| e.to_string())
}

/// 缓存里全部对端通告(按 device_id 序)。**一条读不动就整张响亮失败**(同
/// [`read_peer_ad`] 的「不猜」口径):把损坏的那条悄悄跳过,等于把「这台是不是被禁用
/// 了 / 该不该拨它」答成「没有 / 不拨」——正是 §2 不许猜的那个问题。
///
/// `pub(crate)`:拨号器([`super::lan_net::Dialer`])的候选来源就是它。
pub(crate) fn read_all_peer_ads(conn: &Connection) -> Result<Vec<(String, lan::LanPeerAd)>, String> {
    let mut stmt = conn
        .prepare(r"SELECT key FROM sync_meta WHERE key LIKE 'lan\_peer:%' ESCAPE '\' ORDER BY key")
        .map_err(|e| e.to_string())?;
    let keys: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for key in keys {
        let peer = key.strip_prefix("lan_peer:").expect("上面的 LIKE 已限前缀").to_string();
        // 键在、值读不出来 = 响亮失败;键刚被别人删掉(Ok(None))则跳过。
        if let Some(ad) = read_peer_ad(conn, &peer)? {
            out.push((peer, ad));
        }
    }
    Ok(out)
}

/// 缓存里已被同 id 异钥**粘滞禁用**的对端(§2)。随引擎装配重检 → 进 `SyncStatus`,
/// 故这声告警跨重启仍在(codex L-c2b 审 M3:只在冲突那一刻 toast 一次不叫「常驻」)。
fn disabled_lan_peers(conn: &Connection) -> Result<Vec<String>, String> {
    Ok(read_all_peer_ads(conn)?
        .into_iter()
        .filter(|(_, ad)| ad.is_disabled())
        .map(|(peer, _)| peer)
        .collect())
}

/// §2 收敛触发① 的判据:**首次钉住某对端公钥** → 回一帧定向 Hello(重用当前序号)。
/// 抽成纯函数是为了让收敛模拟测试与生产共用同一处真相——乒乓与自激回声都由这一行的
/// 形状决定。
///
/// 终止性由「`FirstSeen` 是**一次性状态跃迁**」兑现:缓存一落就不再是首见、记录永不删,
/// 故每对端一生至多触发一帧,乒乓在形状上不存在。
///
/// **与规格 §2 的差异(实现自检发现,已回写规格)**:规格给 ① 多挂了一条「∧ 本 relay
/// 会话尚未向该对端发布过自己的 LanAd」。那条与「引导期整帧丢弃」叠起来会留一个不收敛
/// 窗口——新端上线时老端按触发② 先发了一帧(此刻新端正在引导、整帧丢掉),等新端引导完
/// 发来 Hello,老端却因「已发布过」而不回,新端要等到老端下次重连才学得到公钥。故 ① 的
/// 去重只靠一次性跃迁(更强的保证),限频位留给触发②(它没有跃迁可依,见
/// [`Ctx::lan_hello_if_key_missing`])。
fn lan_ad_reply_needed(cause: lan::StoreCause) -> bool {
    cause == lan::StoreCause::FirstSeen
}

/// §2 定向 Hello = **隐式索要**(「我的通告给你,把你的给我」)的应答判据:鉴权路上定向
/// 发给本机的 Hello,每对端每会话应答一次。
///
/// 为什么非有不可(codex L-c2b 审 M1):只按「首见钉住」回帧的话,**非对称缓存永不收敛**
/// ——A 有 B 的钥而 B 没有 A 的(A 那一帧回复丢了 / 对端当时正在引导),B 索要,A 却因
/// 「已缓存、不是首见」而不答,B 只能等 A 重连(A 的会话可以挂好几天)。
///
/// 终止性:每对端每会话至多一答,且应答本身是定向帧、对方也至多回一答 → 双方同时索要
/// 也就两帧。`LanFrame` 来路不算索要(§2 那条腿的 lan 字段整体忽略)。
fn lan_ad_answer_needed(directed: bool, ingress: Ingress, already_answered: bool) -> bool {
    directed && ingress == Ingress::RelayDeliver && !already_answered
}

/// 来路 → 路由的映射,**只此一处**:[`Ingress`] 由 socket 所有者构造(传输层内部事实),
/// [`Route`] 是引擎的路由维度,两者一一对应。抽成函数是为了给它一个可变异的靶子——LAN
/// 那条腿的生产者还在 L-c2c,写反了此刻没有行为测看得见。
fn route_of(ingress: Ingress) -> Route {
    match ingress {
        Ingress::RelayDeliver => Route::Relay,
        Ingress::LanFrame => Route::Lan,
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 变长 hex 解码(定长密钥面走 [`unhex32`];这条给通告缓存的 CBOR 用)。
fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("不是偶数长度的 hex:{} 字符", s.len()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
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

/// `run` 里**跨会话存活**的那几件:引擎槽(连着 lan 链路集)、那一根心跳、链路移交通道、
/// 断网期定向 Hello 的下次时刻。打成一包传,是因为会话循环与离线泵要用同一份——分成散参
/// 迟早出现「离线泵少驱动了一件」。
struct Pumps {
    slot: EngineSlot,
    /// **整个 runtime 一根心跳**(L-c2a 实现审 M1):`Engine::on_tick` 的刻度是路由惩罚
    /// 到期与拉流 stale 判定的时间轴,`PULL_STALE_TICKS` 只有 2——每建一条会话就新起一根
    /// interval(`interval()` 首拍立即就绪)的话,两次快速重连就能把一条正常的 lan 拉流
    /// 判死、shun 并罚腿。故在线/离线共用这一根,相位不因会话来去而重置。lan 的 30s Ping
    /// 与 90s 静默判死也搭它这趟车(§3)。
    tick: tokio::time::Interval,
    /// 监听器/拨号器把**握手已完成**的链路交到这里(§6 准入表的 handoff 那一格)。
    /// L-c3a 起监听侧真有生产者了(拨号侧归 L-c3b);测试另可经 [`run_with_handoff`]
    /// 自持发送端直接注入真 TCP 链路。
    handoff: mpsc::Receiver<AdoptedLink>,
    /// 移交通道发送端的**保命份**:`run` 自己留一枚,那条 select 臂才恒挂着而不是立刻
    /// 返回 `None`(返回 `None` 的臂会被反复轮询,白烧 CPU)。测试注入形由调用方自持,
    /// 这里是 `None`。
    #[allow(dead_code)] // 只为「持有」而存在(读它的是 tokio 的通道计数,不是这里的代码)。
    handoff_keep: Option<mpsc::Sender<AdoptedLink>>,
    /// 本 `run` 在 app 级监听器上的席位(见 [`AdmitSeat`])。
    seat: Option<AdmitSeat>,
    /// 全部 lan 链路的上抬**数据**事件(见 [`LanLinks::inbound_tx`]:读端刻意不住在链路
    /// 集里)。
    lan_inbound: mpsc::Receiver<LanInbound>,
    /// 断链信号(§10 独立通道,见 [`LanFault`])。与数据面分家的意义全在「数据积压时它照样
    /// 走得动」——合成一根的话,死讯得排在 64 枚数据帧后面才轮得到。
    lan_faults: mpsc::Receiver<LanFault>,
    /// 断网期定向 Hello 的下次时刻(§5:每 60s 一轮)。会话**成功建立过又收场**时置成
    /// 「立刻」;拨号连环失败不会把它一路提前(见 `run` 里那行 `is_none()` 判断)。
    lan_hello_due: Option<Instant>,
}

/// 会话收场(任何原因)的那一手:全部对端的 relay 腿置 Absent + 只作废 relay 在飞拉流,
/// **产出的重问帧当场投出去**——中转刚没了,lan 腿若在,补投面正好等于「全部活跃 lan 对端」
/// (§5 同一条规则)。投递失败只记一笔,不该拦住收场处置。
///
/// **投之前先自证**(实现审三轮 H2):栅栏若已落(身份/K_acc 换代、pending 封闸、配置读不
/// 出),这些帧会被**旧 K_acc** 封了发到旧链上去——那是旧身份幽灵的最后一个出口,而且是
/// 唯一一条不经泵、不经会话循环的出口。落闸就不投,交给 `run` 顶:`reconcile`/`retire_all`
/// 会把旧引擎与旧链一起处置掉。纯改 `server_url` 不落闸,收场重问照发不误。
async fn session_wrapup(t: &Transport, cfg: &SyncConfig, pumps: &mut Pumps) {
    // **中转数据窗口的释放义务**(§6.1 六轮 H2;L-d″ 第④笔):`tracked` 随会话死,而窗口
    // 住 [`EngineSlot`] —— 不在这里清,它就永久停在「在飞」,此后再没有任何回执会来解开它。
    // 必须排在下面那两个早返回**之前**:`outs` 为空、或栅栏已落,都不是漏掉窗口的理由。
    pumps.slot.relay_data.clear();
    // **让位也只在这条会话内成立**(codex 实现审二轮 H):`busy` 说的是那一刻服务端的字节
    // 预算,`unknown_device` 更是明写「下一代允许重试一次」。带过会话边界的话,新会话的
    // 第一枚泵会莫名跳过它 —— 跨代探针那条语义就被推迟一整拍心跳。
    lock_ops(&pumps.slot.ops).clear_relay_yields();
    // **中转腿没了 = 消费者集合变了,必须重选腿**(codex 实现审一轮 H)。这一声与 ④′ 那条
    // 「新消费者出现时也要唤醒」是同一条规则的**反方向**,而反方向原先整个漏了:
    //
    // * 窗口里装的是 blob 时,上面那句 `clear()` 释放的是 blob,ops 的铃一声都没有;
    // * `ServeOps` 撞 fatal Nack 走 `rollback_quiet`(刻意不摇)之后会话才收场,收场时窗口
    //   已空,更不会摇。
    //
    // 而那些 work 此刻**仍然 runnable**,故心跳的 `on_tick` 一个都不报(它只报 false→true
    // 的边沿);原描述符绑的又是 `Route::Relay`,LAN 从头到尾没被摇过 —— 于是一条明明可用的
    // 直连腿可以无限等下去。**无条件摇**,且必须排在下面那两个早返回之前。
    pumps.slot.ops_changed.notify_one();
    let outs = pumps.slot.get().map(|e| e.on_relay_session_down()).unwrap_or_default();
    if outs.is_empty() || session_gate_tripped(&t.db, cfg) {
        return;
    }
    if let Err(e) = offline_deck(t, cfg, &mut pumps.slot).dispatch(outs).await {
        set_status(&t.status, &t.events, |s| s.lan_warning = Some(e));
    }
}

/// **LanReady 撤位的唯一形**(§4 撤位清单 / 不变量 6):整台丢弃 → 链路一起拆 → 状态面的
/// 链路数当场归零。三档撤位(未配置 / 配置残缺 / 纪元封闸)都经它,故「UI 上挂着 N 条直连、
/// 其实一条都没有」在结构上不存在(实现审 L1)。
///
/// 刷的是**整份槽事实**而不只链路数(实现审二轮 L1):引擎已经正式退役,冻结 / 隔离 /
/// 挂起数 / breaker 就不再是「当前引擎的事实」,留着等于拿旧代状态冒充当前状态;且只手工
/// 刷一格与 [`EngineSlot::apply_status`] 那句「唯一出口」自相矛盾。身份换代那一路的撤位藏在
/// `slot.reconcile` 里,由紧随其后的主状态块照同一个出口刷。
fn retire_all(t: &Transport, pumps: &mut Pumps) {
    pumps.slot.retire();
    // LanReady 撤位 = 准入表里那一条也得当场摘掉(§6:撤位期不许还有人能把链交进来),
    // 并 abort 该代未移交的 pre-auth 任务。
    lan_deregister(pumps);
    set_status(&t.status, &t.events, |s| pumps.slot.apply_status(s));
}

/// 本 `run` 在 app 级监听器上的席位(§6 准入表的那一行要的三件)。`None` = 本 `run`
/// 不接监听器(手机壳 / staging / 大部分单测)。
#[derive(Clone)]
struct AdmitSeat {
    host: LanHost,
    /// 注册者号(**永不复用**):注销时对得上才摘,故旧 runtime 收场那声注销摘不掉新
    /// runtime 刚注册的条目。
    owner: u64,
    handoff: mpsc::Sender<AdoptedLink>,
}

/// **把准入表对齐到 LanReady 的当前事实**(唯一出口):在场就注册/续注册并回填监听落点,
/// 不在场就摘条目。两个调用点——`run` 顶的引擎装配之后,与**会话里首次引导完成后的重装
/// 之后**(那一跳不经 `run` 顶,漏了它,刚入伙的设备要等到下次重连才收得下直连)。
///
/// 注册幂等:同一注册者、同一身份指纹反复注册**不换代**(每轮重连都换代的话,在飞的
/// 握手会被一次次 abort 掉)。任何一步失败都只**不通告 listen**——通告一个连不上的端口
/// 只会让对端白拨,而中转面一点不受影响(§2 advisory 面的既有分层)。
fn lan_sync_admission(
    seat: Option<&AdmitSeat>,
    slot: &mut EngineSlot,
    db: &Arc<Mutex<Connection>>,
    status: &Arc<Mutex<SyncStatus>>,
    events: &mpsc::UnboundedSender<SyncEvent>,
    cfg: &SyncConfig,
) {
    let Some(seat) = seat else { return };
    if !slot.lan_ready() {
        slot.lan.listen = None;
        seat.host.admission.deregister(&seat.host.space_id, seat.owner);
        return;
    }
    let listen = lan_net::local_subnets().and_then(|subnets| {
        let reg = lan_net::Registration {
            space_id: seat.host.space_id.clone(),
            owner: seat.owner,
            account_id: cfg.account_id.clone(),
            self_device: cfg.device_id.clone(),
            k_acc: cfg.k_acc,
            self_seed: cfg.device_seed,
            db: Arc::clone(db),
            active: slot.lan.active_view(),
            handoff: seat.handoff.clone(),
        };
        seat.host
            .admission
            .register(reg)
            .map(|port| lan::LanListen { port, addrs: lan::advertisable_addrs(&subnets) })
    });
    match listen {
        Ok(listen) => slot.lan.listen = Some(listen),
        Err(e) => {
            slot.lan.listen = None;
            set_status(status, events, |s| s.lan_warning = Some(e));
        }
    }
}

/// **拨号巡查那一刻的两件**(§7;L-c3b codex 一轮 H1):先把**本机通告地址**对齐,再看
/// 要不要拨号。
///
/// 为什么两件必须绑在一起:「网络变化」没有 OS 通知,这一轮的接口枚举**就是**唯一的观测
/// 点。只对齐拨号候选而不对齐本机通告,会留一个直连**永久起不来**的确定场景——中转会话
/// 一直连着(故 `run` 顶与会话仪式那两个既有对齐点都不会再跑)时插上网线:本机枚举得到
/// 新子网,可通告出去的仍是旧地址;若方向规则指定对端拨本机,它照着旧地址永远拨不通,而
/// 本机因 id 更大又不发起。
///
/// 与当前事实对不上就当场广播一枚**权威 Hello**(`Require(Relay)`,§2:带通告的 Hello
/// 只许经中转)——序号由 `AdFace` 按「listen 变了必换号」自动递增,不必在这里碰计数器。
///
/// **判据是「本会话已发布的通告 vs 现在的事实」,不是「这一轮变了没有」**(codex 二轮 M2):
/// 一次性边沿有两个漏口——① `make_hello` 一次瞬态失败就把这次刷新永远吃掉(下一轮
/// `before == after`);② `Some → None`(接口枚举失败,本机不再监听)也是一条**该发的**
/// 通告,对端否则会照着旧地址一直拨。拿 `AdFace::published` 当判据则天然是「没发成就还
/// 欠着」,且会话仪式那枚 Hello 已经发过的内容不会被重发一遍。
///
/// **中转不在(`ad = None`)时不产帧**:那时没有权威路可走,本机 `listen` 先在内存里更新,
/// 下次会话仪式的那枚广播 Hello 自然带上它。**诚实残余**:WAN 断着又还没有任何直连链时,
/// 换网 = 双方缓存里的地址都对不上,直连要等中转回来才恢复(§0/§9 的既有边界,非本笔新增)。
fn lan_dial_tick(
    db: &Arc<Mutex<Connection>>,
    status: &Arc<Mutex<SyncStatus>>,
    events: &mpsc::UnboundedSender<SyncEvent>,
    cfg: &SyncConfig,
    seat: Option<&AdmitSeat>,
    slot: &mut EngineSlot,
    // 本会话的通告面(`None` = 没有中转腿,发不出权威 Hello)。**类型即事实**:离线那条
    // 出口手上根本没有这东西,故「离线时误发一枚权威 Hello」不是靠自律避免的。
    ad: Option<&AdFace>,
) -> Vec<Output> {
    lan_sync_admission(seat, slot, db, status, events, cfg);
    // 通告面关着(归属没对齐 / 序号停用)时不比不发:那时本机压根不发通告,比了永远「欠着」。
    let republish = ad.is_some_and(|f| {
        f.ready && !f.off && f.published.as_ref().map(|(_, l)| l) != Some(&slot.lan.listen)
    });
    // 拨号面的失败只进 advisory 槽(codex 一轮 M1):接口枚举失败 / 一条缓存记录读不动,
    // 都不该盖掉「连不上服务器、冻结、隔离」这些正确性面的人话。
    if let Some(e) = slot.dial_round(db, cfg, seat.is_some()) {
        set_status(status, events, |s| s.lan_warning = Some(e));
    }
    if !republish {
        return vec![];
    }
    let made = {
        let conn = db.lock().expect("db mutex poisoned");
        slot.peek().map(|e| e.make_hello(&conn, BROADCAST, Route::Relay))
    };
    match made {
        Some(Ok(outs)) => outs,
        Some(Err(e)) => {
            set_status(status, events, |s| s.lan_warning = Some(e));
            vec![]
        }
        None => vec![],
    }
}

/// 摘条目(LanReady 撤位那几档共用)。
fn lan_deregister(pumps: &mut Pumps) {
    pumps.slot.lan.listen = None;
    let Some(seat) = &pumps.seat else { return };
    seat.host.admission.deregister(&seat.host.space_id, seat.owner);
}

/// `run` 收场时把准入条目摘干净(**任何返回路径**:停机 / 须重开 / 未配置退出)。
/// 写成 `Drop` 而不是逐个 `return` 前调一次——`run` 有七八处 return,漏一处就留一条
/// 「谁也不在了、条目还在表上」的死条目,而它手里的 handoff 通道恰好还没关。
struct AdmitLease {
    host: Option<LanHost>,
}

impl Drop for AdmitLease {
    fn drop(&mut self) {
        if let Some(h) = &self.host {
            h.admission.deregister(&h.space_id, h.owner);
        }
    }
}

pub async fn run(t: Transport) -> TransportExit {
    // 生产路的链路来路 = app 级监听器(`t.lan` 为 `Some` 时;拨号器归 L-c3b)。发送端
    // 一份留在 `Pumps` 上,故那条 select 臂恒挂着而不是立刻返回 None(返回 None 的臂
    // 会被反复轮询,白烧 CPU),另一份注册给准入表。
    let (handoff_tx, handoff) = mpsc::channel(LAN_HANDOFF_CAP);
    run_inner(t, handoff, Some(handoff_tx), Duration::from_secs(HEARTBEAT_SECS)).await
}

/// 链路移交通道由调用方给(测试直接注入握手已完成的真 TCP 链路,绕开监听器)。
/// `keep` = 拨号器要的那枚发送端;不给 = 这台 rig 不拨号(多数用例只注入链路)。
///
/// **心跳周期也由调用方给**:挂在心跳上的规则(`busy` 之后的重发债、数据窗口的恒在续做)
/// 只有「等下一拍」这一个观测口,而生产那一拍是 30s ——
/// `a_busy_hello_sets_the_debt_and_only_its_ack_clears_it` 要看**四拍**才分得清
/// 「构造/写成功就算清债」与「只有 Ack 才清债」,真等就是两分钟。
///
/// **刻意不用 `tokio::time::pause`**:这条链路上跑的是真 socket,暂停时钟的自动推进只看
/// 定时器、不看 I/O 就绪,推过头会把静默判死、退避、拉流 stale 一起触发 —— 那是给自己
/// 造一个测试专属的世界。
///
/// ⚠ 压周期的用例要自己确认「**按拍计数**的东西」不掺进来(`PULL_STALE_TICKS` = 2 拍的
/// 拉流死线是头一个):周期压到毫秒级之后,那些也跟着按毫秒走。
#[cfg(test)]
pub(crate) async fn run_with_handoff(
    t: Transport,
    handoff: mpsc::Receiver<AdoptedLink>,
    keep: Option<mpsc::Sender<AdoptedLink>>,
    beat: Duration,
) -> TransportExit {
    run_inner(t, handoff, keep, beat).await
}

async fn run_inner(
    mut t: Transport,
    handoff: mpsc::Receiver<AdoptedLink>,
    handoff_keep: Option<mpsc::Sender<AdoptedLink>>,
    beat: Duration,
) -> TransportExit {
    let seat = match (t.lan.clone(), handoff_keep.clone()) {
        (Some(host), Some(handoff)) => Some(AdmitSeat { owner: host.owner, host, handoff }),
        _ => None,
    };
    let _lease = AdmitLease { host: t.lan.clone() };
    // 停机信号的局部把手(watch clone):session(&mut t) 独占借 t,同一 select 里
    // 另一分支不能再碰 t.shutdown,故循环外先克隆一份。
    let mut shutdown = t.shutdown.clone();
    let mut backoff: u64 = 1;
    // 周期由调用方给,**生产入口恒是 `HEARTBEAT_SECS`**(见 `run`;那一句由
    // `exactly_one_heartbeat_interval_in_the_whole_transport` 按源码钉住)。
    let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + beat, beat);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // 引擎与 lan 链路集活到整个 run 的生命期(不变量 6,见 [`EngineSlot`])——会话来去,
    // 它们不动。拨号器同住槽里,拿的是移交通道的另一枚发送端。
    let (slot, lan_inbound, lan_faults) = EngineSlot::new(t.blob_policy, handoff_keep.clone());
    let mut pumps = Pumps {
        slot,
        tick: heartbeat,
        handoff,
        handoff_keep,
        seat,
        lan_inbound,
        lan_faults,
        lan_hello_due: None,
    };
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
                // 未配置:同步整个面零打扰,睡等配置/停机信号(链路一起拆)。
                retire_all(&t, &mut pumps);
                set_status(&t.status, &t.events, |s| {
                    *s = SyncStatus { state: "off".into(), ..Default::default() };
                });
                match offline_wait(&mut t, &mut pumps, &mut shutdown, None, None, "尚未加入账户").await {
                    Idle::Stopped => return TransportExit::Stopped,
                    _ => continue,
                }
            }
            Err(e) => {
                // 配置残缺:响亮进状态,等人修(Reconfigured 重查)。
                retire_all(&t, &mut pumps);
                set_status(&t.status, &t.events, |s| {
                    s.state = "off".into();
                    s.error = Some(e);
                });
                match offline_wait(&mut t, &mut pumps, &mut shutdown, None, None, "同步配置异常").await {
                    Idle::Stopped => return TransportExit::Stopped,
                    _ => continue,
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
            // 纪元切换封闸 = LanReady 撤位档(不变量 6):引擎整台丢弃,别让旧纪元的
            // 引擎在压实窗口里继续活着。
            retire_all(&t, &mut pumps);
            set_status(&t.status, &t.events, |s| {
                s.configured = true;
                s.state = "off".into();
                s.error = Some(why);
            });
            match offline_wait(
                &mut t,
                &mut pumps,
                &mut shutdown,
                None,
                None,
                "纪元切换进行中,暂不能发起配对",
            )
            .await
            {
                Idle::Stopped => return TransportExit::Stopped,
                _ => continue,
            }
        }
        // 引擎装配(不变量 6:**不等任何链路**)。未引导则槽保持空(引导完成后由会话
        // 仪式装配);身份换代即整台丢弃重装。同一处顺带对齐局域网通告面:换代即清缓存
        // 与本机序号(指纹自证)、把粘滞禁用的对端重检进状态面(随引擎装配,不是每会话)。
        let (ensured, lan_hygiene) = {
            let mut conn = t.db.lock().expect("db mutex poisoned");
            let lan = reconcile_lan_ad_owner(&mut conn, &cfg)
                .and_then(|()| disabled_lan_peers(&conn));
            (pumps.slot.reconcile(&conn, &cfg), lan)
        };
        // 通告面出错**不挡同步**(§2 advisory:直连起不来事小,别把中转也拖下水),但
        // **本轮整个关掉通告面**(二审 M1:归属没对齐就发通告 = 序号可能复用或倒退);
        // 禁用清单读不动时**不覆盖**上一次已知的清单——空数组看着像「确定没有禁用」,
        // 而事实是「不知道」(二审 L2)。
        let (lan_disabled, lan_warning, lan_ad_ready) = match lan_hygiene {
            Ok(list) => (Some(list), None, true),
            Err(e) => (None, Some(e), false),
        };
        // 准入表对齐 LanReady 的当前事实(装配成了就注册、没成/未引导就摘条目)。放在
        // `ensured` 分支**之前**:装配失败那一路同样要摘,而它自己 `continue` 出去。
        lan_sync_admission(
            pumps.seat.clone().as_ref(),
            &mut pumps.slot,
            &t.db,
            &t.status,
            &t.events,
            &cfg,
        );
        // 回到 `run` 顶就看一眼拨号面(§7):配置变更 / 重连退避 / 装配重试都经这里。**只是
        // 「看一眼」**——每对端的退避由巡查自己认,故重连风暴不会变成拨号风暴;有它,
        // 「缓存里早有对端、而这一轮谁也没来 kick」那种态不必干等空闲巡查。
        pumps.slot.dial.kick();
        if let Err(e) = ensured {
            // 装配失败(库损坏/完整性查询崩了):响亮进状态,退避后重试——**不拨号**,
            // 没引擎的连接除了收帧丢帧什么也干不了。
            set_status(&t.status, &t.events, |s| {
                s.configured = true;
                s.state = "offline".into();
                s.error = Some(e);
                // 装配失败 = `reconcile` 内部已经撤过位(链路一并拆了),故这一路也得走
                // 槽事实的唯一出口 —— L-c2c 实现审 L1 修的是撤位三档,漏了这第四档:
                // 不刷的话状态面会长期挂着「还有 N 条直连」的幻影,而这条路会一直退避重
                // 试、没有第二处能纠正它。L-c3a 起它还多喂一份准入表看得见的活跃对端视图。
                pumps.slot.apply_status(s);
            });
            let wait = Duration::from_millis(backoff * 1000 + jitter_ms());
            backoff = (backoff * 2).min(BACKOFF_MAX_SECS);
            match offline_wait(
                &mut t,
                &mut pumps,
                &mut shutdown,
                Some(&cfg),
                Some(Instant::now() + wait),
                "同步引擎装配失败(重试中)",
            )
            .await
            {
                Idle::Stopped => return TransportExit::Stopped,
                Idle::Reconfigured => backoff = 1,
                Idle::Elapsed => {}
            }
            continue;
        }
        set_status(&t.status, &t.events, |s| {
            s.configured = true;
            s.state = "connecting".into();
            s.account_id = Some(cfg.account_id.clone());
            s.device_id = Some(cfg.device_id.clone());
            s.server_url = Some(cfg.server_url.clone());
            s.peers_online = 0;
            // 引擎跨会话存活后,冻结/挂起/隔离/活跃链路数是**引擎槽的当前事实**,不是
            // 会话的——建连前一律清零会把真在场的冻结抹成「没事」,下一帧到了才复现。
            pumps.slot.apply_status(s);
            // 局域网通告面同理照当前事实(禁用是落库的粘滞位,不因换条会话而忘)。
            if let Some(list) = lan_disabled {
                s.lan_disabled = list;
            }
            s.lan_warning = lan_warning;
        });
        let end = tokio::select! {
            biased;
            // 停机优先,且覆盖 session 的**全部** await 点(拨号/握手/Challenge/
            // 引导/长发送):drop session future 即断连;同步段(SQLite 事务)天然
            // 跑完才到 await 点,撕不裂;Ctx::Drop 清 boot 临时文件;已发未 ack 的
            // op 未提升 last_pushed,下次连接重发、对端幂等吸收。
            _ = wait_shutdown(&mut shutdown) => return TransportExit::Stopped,
            r = session(&mut t, &cfg, &mut backoff, &mut pumps, lan_ad_ready) => r,
        };
        // 会话收场(任何原因):全部对端的 relay 腿置 Absent + 只作废 relay 在飞拉流
        // (§6 会话级)。引擎活过会话之后**必须**有这一手,否则它会一直以为大家的中转
        // 腿还通着,选路照着发帧。返回的重问帧此刻无腿可走被丢——重连时的会话仪式对
        // 全部 `missing_blobs` 重发 want 兜住(有 lan 腿之后才真送得出去,L-c2b)。
        // 返回的重问帧现在**真送得出去**(L-c2c):中转刚没了,lan 腿若在,补投面正好等于
        // 「全部活跃 lan 对端」(§5 同一条规则)。投递失败只记一笔,不该拦住收场处置。
        session_wrapup(&t, &cfg, &mut pumps).await;
        // 会话**建立过**才让断网期定向 Hello 立刻起一轮(§5「本机中转离线 → 立即发一帧」)。
        // `is_none()` 这一判是防连环拨号失败把它一路提前:发过一轮之后下次恒是 60s 后。
        if pumps.lan_hello_due.is_none() {
            pumps.lan_hello_due = Some(Instant::now());
        }
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
                match offline_wait(
                    &mut t,
                    &mut pumps,
                    &mut shutdown,
                    Some(&cfg),
                    Some(resume),
                    "初始同步因空间不足暂停中",
                )
                .await
                {
                    Idle::Stopped => return TransportExit::Stopped,
                    Idle::Reconfigured => backoff = 1,
                    Idle::Elapsed => {}
                }
            }
            Err(e) => {
                set_status(&t.status, &t.events, |s| {
                    s.state = "offline".into();
                    s.error = Some(e);
                });
                let wait = Duration::from_millis(backoff * 1000 + jitter_ms());
                backoff = (backoff * 2).min(BACKOFF_MAX_SECS);
                match offline_wait(
                    &mut t,
                    &mut pumps,
                    &mut shutdown,
                    Some(&cfg),
                    Some(Instant::now() + wait),
                    "未连接服务器(重连中)",
                )
                .await
                {
                    Idle::Stopped => return TransportExit::Stopped,
                    Idle::Reconfigured => backoff = 1,
                    Idle::Elapsed => {}
                }
            }
        }
    }
}

/// [`offline_wait`] 的结局。
enum Idle {
    /// 睡到点了(只在传了 resume 时出现)。
    Elapsed,
    /// 收到配置变更:立即重来。
    Reconfigured,
    /// 停机信号 / 宿主消亡:整体退出。
    Stopped,
}

/// select 选中的臂(L-c2c:把「处理」挪到 select 之后)。**臂里直接写 `ctx.…().await`
/// 会与别的臂上的可变借用打架**,而两个循环都需要「同一份处理逻辑」——故臂只负责认出
/// 事件,处理统一在下面。
enum Woke {
    /// 已在臂里处理完(控制通道 / 中转帧 / 引导与配对的截止时刻等)。
    Handled,
    /// 心跳一刻:引擎 `on_tick` + lan 的 Ping 与静默判死。
    Tick,
    /// 本地写落地:结算 + 推新 op。
    Wrote,
    /// 一条 lan 链路上抬的事件。
    Lan(LanInbound),
    /// 一条链路的死讯(§10 独立通道):与数据面同样在 select 之外处理。
    LanDown(LanFault),
    /// 一条握手已完成的链路被移交过来(§6)。
    Adopt(AdoptedLink),
    /// 断网期定向 Hello 到点(§5,每 60s)。
    LanHello,
    /// 拨号巡查到点(§7:退避到期 / 被 kick / 空闲巡查)。
    Dial,
    /// 有腿交回了 ops 在飞位(§6.2 ④′):扫一遍谁该被叫醒。
    OpsChanged,
}

/// **离线等待泵**(L-c2a;L-c2c 起 lan 那条腿也在这里跑):没有中转会话的那六档(未配置 /
/// 配置残缺 / 纪元封闸 / 引擎装配失败 / 引导空间不足 / 重连退避)统一走这里,等的同时
/// **照常按心跳驱动引擎、照常收发 lan 链路上的帧**。
///
/// 为什么非驱动不可(不变量 6 明写「心跳必须由 runtime 驱动而非中转会话」):`on_tick`
/// 是路由惩罚到期与拉流 stale 判定的**唯一时间轴**(刻意用心跳刻度不用墙钟,墙钟回拨
/// 会让惩罚超期不失效)。心跳只在中转会话里跳的话,断 WAN 期间惩罚永不到期、lan 半死
/// 链路上的图永远换不了腿。本地写也照常结算与推送——断网时删掉的图不该赖在缺字节清单里
/// 等重连才清,新写的 op 也该当场沿直连腿到对端(§5「本机中转离线:全部 mail 走各 lan
/// 链路」)。心跳与结算产出的帧,L-c2a 那轮**无腿可走只能丢**,本轮有了收件人。
///
/// `cfg = None` 的两档(未配置 / 配置残缺)此刻引擎与链路都已撤台(`retire` 一并拆链),
/// 故这些事件无处可做,一律丢弃。
async fn offline_wait(
    t: &mut Transport,
    pumps: &mut Pumps,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
    cfg: Option<&SyncConfig>,
    resume: Option<Instant>,
    busy: &str,
) -> Idle {
    let wrote = t.wrote.clone();
    loop {
        // 停机在**循环顶**查一次(而不是靠 `biased` 把它排第一):select 一旦 biased,
        // 排在维护臂之前的控制通道只要被 PairStart 连续喂满就能永久饿死心跳与本地
        // 结算(实现审 M2),而这两件正是不变量 6 要求「断 WAN 也不许停」的。去掉
        // biased 让就绪臂随机选,饿死面消失;停机的及时性由这行点查 + 下面的臂共同
        // 保证。
        if *shutdown.borrow() {
            return Idle::Stopped;
        }
        let woke = tokio::select! {
            _ = wait_shutdown(shutdown) => return Idle::Stopped,
            _ = until(resume) => return Idle::Elapsed,
            c = t.control.recv() => match c {
                None => return Idle::Stopped,
                Some(Control::Reconfigured) => return Idle::Reconfigured,
                Some(Control::PairStart { reply }) => {
                    let _ = reply.send(Err(busy.to_string()));
                    Woke::Handled
                }
            },
            w = pump_wait(pumps, &wrote, cfg.is_some()) => w,
        };
        // 栅栏落下 = 这一轮的 `cfg` 过期了:交回 `run` 顶重来(它会重读配置并对齐引擎槽)。
        if matches!(pump_apply(t, pumps, cfg, woke).await, Pumped::GateTripped) {
            return Idle::Reconfigured;
        }
    }
}

/// 泵的**等待半边**:等一件该做的事发生,只认出来、不做事。全部臂都取消安全,故它可以
/// 被外层 select 的别的臂(停机 / 控制面 / 建连完成)随时砍掉重来。
///
/// 与处置半边分家的理由(H1 修法的另一半):处置里全是 await(落库、封帧、投递),放在
/// select 里就会被别的臂半途砍断——「一枚事件与它产出的全部输出一路跑完」是 §6 代次契约
/// 之一(run-to-completion),半截的 dispatch 会留下发了一半的帧。
///
/// `armed` = 断网期定向 Hello 那只计时器要不要挂。未配置 / 配置残缺两档引擎与链路都已撤台,
/// 那枚到点的计时器没人消费——不挂条件的话它会「立刻就绪 → 又就绪」空转烧 CPU。
async fn pump_wait(pumps: &mut Pumps, wrote: &Notify, armed: bool) -> Woke {
    let Pumps { tick, handoff, lan_inbound, lan_faults, lan_hello_due, slot, .. } = pumps;
    let dial_due = slot.dial_due();
    // 把手先克隆出来:`slot` 在这个 select 里另有别的臂借用(`handoff` 等),而这根铃
    // 只是个 `Arc`,克隆比跟借用检查器较劲便宜。
    let ops_changed = Arc::clone(&slot.ops_changed);
    tokio::select! {
        _ = tick.tick() => Woke::Tick,
        _ = wrote.notified() => Woke::Wrote,
        _ = ops_changed.notified() => Woke::OpsChanged,
        _ = until(dial_due), if armed => Woke::Dial,
        ev = lan_inbound.recv() => {
            Woke::Lan(ev.expect("链路集自持一枚 sender,通道不会关"))
        },
        f = lan_faults.recv() => {
            Woke::LanDown(f.expect("链路集自持一枚 sender,通道不会关"))
        },
        Some(adopted) = handoff.recv() => Woke::Adopt(adopted),
        _ = until(*lan_hello_due), if armed => Woke::LanHello,
    }
}

/// 泵的**处置半边**:把等到的那件事做完。**在任何 select 之外跑**,故绝不半途被砍。
/// `cfg` 缺席的两档(未配置 / 配置残缺)引擎与链路都已撤台,这些事无处可做,一律丢弃。
async fn pump_apply(
    t: &Transport,
    pumps: &mut Pumps,
    cfg: Option<&SyncConfig>,
    woke: Woke,
) -> Pumped {
    let Some(cfg) = cfg else { return Pumped::Ran };
    // **做实际工作之前先自证身份/纪元**(实现审二轮 H1;与会话循环那三臂同款、同频):泵会
    // 封解帧、落库、接纳链路,拿一份已经过期的 `cfg` 去做就是「旧身份幽灵」。换代不保证有人
    // poke 控制通道——纪元压实那一路是库自己悄悄换的 device_id/K_acc,只等 `Reconfigured`
    // 就等于把不变量交给壳层自律。落闸即交回外层:重读配置、对齐引擎槽(该撤位就撤位)。
    if session_gate_tripped(&t.db, cfg) {
        return Pumped::GateTripped;
    }
    // 拨号巡查在别的臂之前单独处置:它要同时借 `seat` 与 `slot`(下面那个 deck 独占
    // `slot`),且它的失败**只进 advisory 槽**、不走本函数末尾那个通用收口(codex 一轮
    // M1:接口枚举失败盖掉「连不上服务器」的人话是分层回归)。
    if let Woke::Dial = woke {
        let Pumps { seat, slot, .. } = pumps;
        let outs =
            lan_dial_tick(&t.db, &t.status, &t.events, cfg, seat.clone().as_ref(), slot, None);
        debug_assert!(outs.is_empty(), "中转不在时不产帧");
        return Pumped::Ran;
    }
    let Pumps { slot, lan_hello_due, .. } = pumps;
    let mut deck = offline_deck(t, cfg, slot);
    let done = match woke {
        Woke::Handled => Ok(()),
        Woke::Tick => {
            let outs = deck.slot.get().map(|e| e.on_tick()).unwrap_or_default();
            let core = match deck.dispatch(outs).await {
                Err(e) => Err(e),
                Ok(()) => match deck.lan_beat().await {
                    Err(e) => Err(e),
                    // ops 追赶那一拍(§6.2 ⑥)。**断 WAN 期照跑**:此刻 LAN 腿就是全部
                    // 消费者,冷却到点没人摇铃的话那些义务要等重连才动。
                    Ok(()) => deck.ops_tick().await,
                },
            };
            // 隔离重验的续做**排在最后、且不参与上面那两件的成败**(实现审二轮 H2)。
            let rev = deck.reverify_tick();
            match deck.dispatch(rev).await {
                Err(e) if core.is_ok() => Err(e),
                _ => core,
            }
        }
        Woke::Wrote => {
            let mut outs = vec![];
            let done = {
                let conn = deck.db.lock().expect("db mutex poisoned");
                match deck.slot.get() {
                    // 先结算(删图/删条目让缺字节清单少一项,L-c2a),再推新 op:
                    // 顺序与会话里那一臂同源。
                    Some(e) => e
                        .on_local_ops_settled(&conn)
                        .and_then(|()| e.outbound(&conn, &mut outs)),
                    None => Ok(()),
                }
            };
            // **输出不蒸发**(§6.2 ③″ 第 4 条):`outbound` 一旦把义务登记进计划表,那枚
            // 描述符就已经在 `outs` 里;后半段失败也得先把它投出去,再让错误收场。
            let sent = deck.dispatch(outs).await;
            done.and(sent)
        }
        Woke::OpsChanged => deck.ops_changed_tick().await,
        Woke::Lan(ev) => deck.lan_event(ev).await,
        Woke::LanDown(f) => deck.lan_fault(f).await,
        Woke::Adopt(adopted) => deck.lan_adopt(adopted).await,
        Woke::LanHello => {
            let r = deck.lan_offline_hello().await;
            *lan_hello_due = Some(Instant::now() + lan_hello_period());
            r
        }
        // 拨号巡查(§7)已在上面单独处置(它借的东西与这个 deck 打架)。断 WAN 期照跑
        // ——**直连的冷启动全靠这条腿**,只在中转会话里跳的话「WAN 从启动前就断」时谁也
        // 不会去拨号。
        Woke::Dial => unreachable!("拨号巡查在本函数开头已单独处置"),
    };
    // 失败(读库崩了 / 帧封不出)只进状态面:没有中转腿时本就无处可去,重连的会话仪式会把
    // 该做的再做一遍。db 锁已在各自 scope 里放掉,不与 status 锁嵌套。
    if let Err(e) = done {
        set_status(&t.status, &t.events, |s| s.error = Some(e));
    }
    Pumped::Ran
}

/// 泵处置的收场。
enum Pumped {
    /// 做完了这一件,接着泵。
    Ran,
    /// **身份/纪元栅栏落下**:本轮的 `cfg` 已不是库里的当前事实,外层必须回 `run` 顶重读
    /// 配置、重对齐引擎槽——这一件不做,后面的更不做。
    GateTripped,
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
    /// **对账控制帧**(Hello / ops Want;§6.1 九轮 H1 定的类别)。
    ///
    /// 为什么非得单独成类:这两种帧此前双双落进 [`Sent::Other`],而那条兜底臂对 `busy`
    /// **什么也不做** —— 服务端的 `admit` 在分 lane 之前就能回 `BUSY` 且**保持会话存活**,
    /// 于是一枚会话仪式 Hello / 补洞 Want 被 busy 掉之后:会话不死、服务器没接手、
    /// **而 Hello 根本不周期发送**(`Engine::on_tick` 只续图侧发问)—— 真实缺口一直等到
    /// 偶然重连。「靠一个信号触发,而信号可能不来」的同族第七例。
    ///
    /// 收口刻意做成**一枚有界的位**([`EngineSlot::reconcile_debt`])而不是存整帧:重发的
    /// 内容由下一拍心跳**重新构造**,故不留水位图、也不会把一枚过期的水位图重放上线。
    ///
    /// `discharges` = **这一枚能不能还债,还的是哪一笔**(codex 实现审一轮 H1)。一轮的形是
    /// 无参数变体 + 「任一 `ReconcileCtl` 的 Ack 都清位」,而 Hello 与 Want 全归这一类,
    /// 于是这条**真实可达**的交错会把债静默吞掉:广播 Hello 撞 busy 置债 → 心跳重建之前
    /// 一枚普通 Want 或定向 Hello 被 Ack → 债被它清掉 → 那枚广播 Hello **永不重建**
    /// (Hello 不周期发送,只能等偶然重连)。
    ///
    /// 我当时判「分多了的最坏代价只是多发一枚 Hello」——那只算了**置债**那一侧,漏了
    /// **清债**那一侧:同一个放宽,在置的方向上是多发,在清的方向上是**丢**。
    ///
    /// 现在只有**广播 Hello** 带得动 `Some(token)`(它是唯一能替所有对端重建水位图的形),
    /// 且 token 是**发它那一刻的债号**:置债一律换新号,故「债挂上之前就构造好的那枚」的
    /// 回执清不掉这笔新债(fail-closed,代价至多是下一拍再发一枚)。
    ///
    /// **按语义放行整类,不按调用点列白名单**(实现审二轮 L1:我一度以为广播 Hello 只有
    /// 会话仪式与 `reconcile_tick` 两个构造点,其实 `lan_dial_tick` 重播权威通告时也构造
    /// 一枚)。整类放行照样对 —— 三处产的都是**当前完整水位图**,而债的内容就是「替所有
    /// 对端重建一份水位图」;白名单则会随第四个构造点悄悄失效。
    ReconcileCtl { discharges: Option<ReconcileToken> },
    /// 引导请求(direct):nack = 对方不在线,换一台。
    BootReq,
    /// 引导快照块(direct):nack = 接收方掉线,作废本次供流。
    BootOut,
    /// **中转全局数据窗口里那一枚图字节块**(direct;L-d″ 第④笔)。ack = 窗口腾出、
    /// 该笔供流推进一块。带 `to` 是因为 `not_online` 那一格要 `on_relay_peer_down`;
    /// 带 `ticket` 是因为**光有分类标签不够**(codex 实现审 L1):它得能在运行期证明
    /// 「这枚回执说的就是窗口里那一笔」,否则一枚错标的回执会去释放别人的窗口。
    ///
    /// **刻意不由 [`Deck::send_relay`] 按 `msg` 形状猜**:同样是 `Msg::BlobChunk`/
    /// `Msg::BlobDeny`,窗口泵发出的那一枚要驱动窗口,而引擎在 `on_blob_pull` 里直接产
    /// 的 `BlobDeny`(行不在/形态不合)一个窗口都没占过 —— 猜的话后者的回执会去释放
    /// 别人的窗口。故分类由**发的那一方显式说**([`Deck::send_relay_blob`] 是唯一出口,
    /// 占窗与封发在同一个函数体里),这是 254 那条「凭据要绑真实来源、别少绑一半」的同族。
    ServeBlob { ticket: RelayDataTicket, to: String },
    /// **中转全局数据窗口里那一枚 ops 帧**(mail;L-d″ 第④笔下半)。与
    /// [`Sent::ServeBlob`] 共用同一枚窗口、同一个发号器,故回执必须**同时核类别与号**
    /// (光核号的话,一枚 blob 回执能去释放 ops 那一笔)。
    ///
    /// `target` = 这份 work 的逻辑目的地(`BROADCAST` 或设备 id),`unknown_device` 的
    /// 跨代探针与清标都按它走(§6.1 九轮 M1:**不许做全表清标**)。
    ///
    /// `own_max_seq` = 这一帧若承载**本机 origin**,它的最大 `origin_seq`;Ack 到达时
    /// **必须先持久化 `last_pushed`、成功之后才提交 work 游标**(§6.1;顺序反了就会出现
    /// 「游标说发过了、库说没接手」)。非本机 origin 恒 `None`。
    ServeOps { ticket: RelayDataTicket, target: String, own_max_seq: Option<i64> },
    /// 其它 direct 帧:nack = 对端不可达,通知引擎(拉流退回清单)。
    Direct { to: String },
    /// mail 帧,ack 无需动作。
    Other,
}

/// **中转腿「有活的对端数」上界**(§10「一处一数」;L-d″ 第④笔)。
///
/// 为什么需要这道闸:拆掉整图循环之后,协调者发完一块就回 select,于是**下一枚
/// `BlobPull` 会在上一张图还没传完时就被读进来**——今天那些拉流是被「协调者堵着不读
/// socket」隐式串起来的,一拆就得有地方放。
///
/// 16 的取法:每对端至多一笔逻辑供流,而中转对端数受席位帽管(当前付费档 16,同 §10
/// 那句「relay 16」),故支持拓扑内**一笔都不会被拒**。满额那一档仍留着 fail-closed ——
/// 席位帽是**服务端**事实,客户端结构上封不住它;更要紧的是**它限的是「同时在线数」,
/// 不限「同一条会话期间出现过的对端集」**,故待办里可以攒下已经离线那些对端的条目
/// (它们会在被泵到时撞 `not_online` 而各自作废,一枚帧的代价,自排水)。
///
/// ⚠ **它数的是「有活的对端」不是 `pending.len()`**(codex 实现审 M1):正被服务的那一笔
/// 住在 `inflight` 里、不在 `pending` 里,按 `pending.len()` 判满会把**同对端的替代者**
/// 当成新对端拒掉 —— 而那正是「旧 transfer 最多再发一块」这条结论的全部依据。
const RELAY_SERVE_QUEUE: usize = 16;

/// 中转腿上一笔图字节供流的执行态:描述符 + **下一块**序号。
///
/// 与 LAN 写泵里那个 `active: Option<(BlobServe, u32)>` 同形(transport.rs 的 ③b 臂),
/// 区别只在这一份要跨 `await` 住在槽里,故单独成型而不是裸元组。
struct BlobJob {
    serve: BlobServe,
    next_idx: u32,
}

/// **中转腿的全局数据面**(lan-direct-plan §6.1「relay 侧是全局一枚数据窗口 = 至多一枚
/// 在制数据帧,不随对端数增长」/ §6.2 ① 的归宿形 (C))。
///
/// **为什么住 [`EngineSlot`] 而不是 [`RelaySession`]**(§6.1 六轮 H2):`tracked` 随会话
/// 死,窗口若也随会话死则第⑤笔的 ops work 就没地方挂——它是**跨会话**的。反过来,窗口
/// 住槽里就欠一条义务:**会话收场必须显式释放**,否则窗口永久停在「在飞」而再没有任何
/// 回执会来。那条义务落在 [`session_wrapup`] 的第一句(在它那两个早返回**之前**)与
/// [`EngineSlot::retire`] 两处。
///
/// **下半接进 ops**(第④笔下半):两类数据**共用这一枚窗口**([`Inflight`]),既不并列
/// 两只 `Option`、也不各发各的号 —— 那样就有两枚在制数据帧,而这枚窗口存在的全部意义正是
/// 「同刻至多一枚」。
/// 对账重发债的代次(codex 实现审一轮 H1)。单调发号,把「这一枚广播 Hello」与「它要还的
/// **那一笔**债」绑在一起 —— 与 [`RelayDataTicket`] 同一条道理:光有类别标签,一枚**别的**
/// 控制帧的回执就能去清掉不属于它的债。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct ReconcileToken(u64);


/// 窗口凭据(codex 实现审 L1):单调发号,把「那一枚回执」与「那一枚在制」绑在一起。
///
/// 没有它的话,`Sent::ServeBlob` 只是个任谁都能构造的标签([`Deck::send_relay_as`] 的
/// `kind` 参数),而窗口是另一行代码写的 —— 一枚错标的回执就能去释放**别人的**窗口。
/// 结构锚只挡得住「源码里多出一个构造点」,挡不住运行期错配。
///
/// **两类共用同一个发号器**(第④笔下半):号在两类之间也不重复,故「blob 的回执拿着
/// ops 那一笔的号」在运行期就对不上;`take_inflight` 另外还核**类别**,两道一起才封得住
/// 「同号不同类」这个交错。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct RelayDataTicket(u64);

/// 窗口里那一枚在制数据的两种形。**单一 enum 不是并列两只 `Option`**:后者在类型上允许
/// 「blob 与 ops 同时在飞」,而那正是这枚窗口要禁的事。
enum Inflight {
    Blob { ticket: RelayDataTicket, job: BlobJob },
    Ops { ticket: RelayDataTicket, job: OpsJob },
}

/// 在制那一枚数据的类别(回执核对用:**类别 + 号**两道)。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DataKind {
    Blob,
    Ops,
}

impl Inflight {
    fn ticket(&self) -> RelayDataTicket {
        match self {
            Inflight::Blob { ticket, .. } | Inflight::Ops { ticket, .. } => *ticket,
        }
    }

    fn kind(&self) -> DataKind {
        match self {
            Inflight::Blob { .. } => DataKind::Blob,
            Inflight::Ops { .. } => DataKind::Ops,
        }
    }
}

/// 中转腿上一枚 ops 帧的执行态:**凭据本身**(§6.1「凭据必须回得来」)。
///
/// 与 blob 那半的形不同之处只有一件:blob 的续做靠描述符里的 `next_idx`,ops 的续做靠
/// [`ops_serve::PeerWork`] 里的游标,而游标只由**凭据**推进。故这里攥着的就是
/// [`OpsTicket`] ——窗口被清(会话收场 / 撤位 / 换代)时它随之 `Drop`,**回滚是结构事实
/// 不是「记得调一句」**;少了这条,那份 work 的在飞位会永久占着 = 该 target 的 ops 供给
/// 彻底停摆。
struct OpsJob {
    /// 这一帧承载的本机 origin 最大序号(非本机 origin 恒 `None`)。
    own_max_seq: Option<i64>,
    /// **RAII 凭据**:`commit` 按值吃掉它,别的一切出路由 `Drop` 交回 `rollback`。
    /// 逻辑目的地也在它身上([`OpsTicket::target`]),**不另存一份**——两份迟早漂。
    ticket: OpsTicket,
}

#[derive(Default)]
struct RelayData {
    /// 在制那一枚(`None` = 窗口空)。至多一枚 —— 这就是「全局一枚数据窗口」本身。
    inflight: Option<Inflight>,
    /// blob 待办。**每对端至多一笔**,轮转出队(见 [`RelayData::enqueue`] 与
    /// [`Deck::relay_data_pump`])。
    ///
    /// **ops 那半刻意没有待办队列**:它的「待办」就是 [`EngineSlot::ops`] 里那张计划表
    /// (住槽、跨会话),泵按 target 轮转直接去那儿取 —— 再在这里攒一份就是第二处真相源。
    pending: VecDeque<BlobJob>,
    /// 凭据发号器。**`clear()` 刻意不复位**:复位就会复用号,而「旧会话那枚迟到回执」
    /// 正是要靠号对不上来认出来。
    next_ticket: u64,
    /// **target 轮转游标**(§6.2 ⑨-4 规则⑤):下一轮从**严格大于**它的 target 开始,
    /// 绕表尾回头。一枚常量状态,不是 per-target 旁表。
    ///
    /// 规则的落地形:`Frame` 记住本 target(Ack/Nack 之后从它的下一个开始);
    /// `Spun`/`Occupied`/`Idle` **一律照样前移** —— 不前移的话每轮都从表头偏置,
    /// 排在后面的 peer 永久饥饿。
    ops_rr: Option<String>,
    /// **ops / blob 1:1 的那一位**(§6.1 M3):上一件数据是不是 ops。某一类此刻无活时
    /// **不让另一类空等**(见 [`Deck::relay_data_pump`] 的取件顺序)。
    last_was_ops: bool,
}

impl RelayData {
    /// 收一笔新供流。返回 `false` = 满额拒收(调用方沿同 transfer 回 `BlobDeny`)。
    ///
    /// **同对端后到的替换先到的**:对端自己的收端窗口是 1 笔(engine.rs 的
    /// `MAX_ACTIVE_PULLS`),故它再发一枚 `BlobPull` 只能意味着前一笔已被它放弃(新
    /// transfer)。留着旧的等于往一条它不再认的 transfer 上发几十兆字节 —— 收端
    /// `on_blob_chunk` 按 transfer 静默丢,纯烧带宽。
    ///
    /// **在制那一枚不在这里管**:它正等回执,而回执照样会来。被顶掉的那笔最多再发出
    /// **一块**旧 transfer 的字节,随后在 [`RelayData::requeue`] 那道同名闸上作废 ——
    /// 「每对端至多一笔」由 `enqueue` 与 `requeue` 两处共同守,不需要第三个「已放弃」
    /// 状态位(那就又是一件要维护的事)。
    fn enqueue(&mut self, job: BlobJob) -> bool {
        if let Some(i) = self.pending.iter().position(|p| p.serve.to == job.serve.to) {
            self.pending[i] = job;
            return true;
        }
        // **已经有活的对端一律收下,不受满额影响**(codex 实现审 M1)。它没有让「有活的
        // 对端数」增长,而拒了它就等于让 `requeue` 把旧 transfer 的剩余整图接着跑完 ——
        // 「最多再发一块」那条结论的依据正是这一枚能排进来。
        if !self.serving(&job.serve.to) && self.peers_with_work() >= RELAY_SERVE_QUEUE {
            return false;
        }
        self.pending.push_back(job);
        true
    }

    /// 这个对端此刻正被服务吗(在制那一笔是**它的图字节**)。ops 那一笔不算:它与 blob
    /// 待办是两张表、两条腿的活,「每对端至多一笔」这道闸从来只管图字节那一张。
    fn serving(&self, peer: &str) -> bool {
        matches!(&self.inflight, Some(Inflight::Blob { job, .. }) if job.serve.to == peer)
    }

    /// **有活的对端数**——`pending` 里的对端 ∪ 在制那一笔的对端(同一对端只算一个)。
    ///
    /// 这才是 [`RELAY_SERVE_QUEUE`] 真正封住的量。由此得出的硬上界:**对端 ≤16**,
    /// **描述符 ≤17**(`pending` ≤16 加至多一枚在制;多出来那一枚必是「已被同对端顶替、
    /// 正等最后一枚回执」的旧 job)。`pending` 自己到不了 17:要 17 个对端各占一格才行,
    /// 而那已被这道闸拒掉。
    fn peers_with_work(&self) -> usize {
        let inflight_peer = match &self.inflight {
            Some(Inflight::Blob { job, .. }) => Some(job.serve.to.as_str()),
            _ => None,
        };
        let extra = usize::from(
            inflight_peer.is_some_and(|to| !self.pending.iter().any(|p| p.serve.to == to)),
        );
        self.pending.len() + extra
    }

    /// 占窗口:发号并把这一笔记成在制。**只该由 [`Deck::send_relay_blob`] 与
    /// [`Deck::send_relay_ops`] 调**——占窗与封发同一处,是这枚凭据成立的前提。
    fn arm(
        &mut self,
        make: impl FnOnce(RelayDataTicket) -> Inflight,
    ) -> Result<RelayDataTicket, String> {
        // 窗口已占还来占 = 接线漂移。**响亮**而不是照盖:盖掉的话旧那笔被无声丢掉,
        // 它的回执随后只会撞上「号对不上」——错在这里、报在别处。泵进来之前查过一次,
        // 这道闸守的是「将来多一个调用点」。
        if self.inflight.is_some() {
            return Err("内部错:中转数据窗口已占,不许再占一枚".into());
        }
        let n = self.next_ticket;
        self.next_ticket = n.checked_add(1).ok_or("内部错:中转窗口凭据发号器耗尽")?;
        let ticket = RelayDataTicket(n);
        self.inflight = Some(make(ticket));
        Ok(ticket)
    }

    fn occupy_blob(&mut self, job: BlobJob) -> Result<RelayDataTicket, String> {
        let ticket = self.arm(|ticket| Inflight::Blob { ticket, job })?;
        // 1:1 那一位**只在真占上窗口时翻**(不是「试了一下」时):试而未得的那一类没有
        // 消费掉任何数据机会,翻了的话下一轮又轮到它,另一类被白白多让一次。
        self.last_was_ops = false;
        Ok(ticket)
    }

    fn occupy_ops(&mut self, job: OpsJob) -> Result<RelayDataTicket, String> {
        let ticket = self.arm(|ticket| Inflight::Ops { ticket, job })?;
        self.last_was_ops = true;
        Ok(ticket)
    }

    /// 按**类别 + 号**取回在制那一笔。**任一对不上,或窗口本来就空 = 接线漂移**(回执与
    /// 窗口是同一处写进去的,且同刻至多一枚),响亮收场,绝不猜。对不上时**把窗口放回去**:
    /// 此刻还不知道那一笔该不该作废,而会话随即收场、[`session_wrapup`] 会清。
    ///
    /// 核类别那一道不是形式主义:两类共用发号器**保证不同号**,但「号对上而类别错」仍是
    /// 一枚错标的 `Sent` 能造出的运行期错配 —— 而 ops 那一笔错当 blob 释放的话,凭据会
    /// 随 `Drop` 回滚、游标白退一格,报出来的却是「图字节回执」。
    fn take_inflight(
        &mut self,
        ticket: RelayDataTicket,
        kind: DataKind,
    ) -> Result<Inflight, String> {
        match self.inflight.take() {
            Some(f) if f.ticket() == ticket && f.kind() == kind => Ok(f),
            Some(f) => {
                let (t, k) = (f.ticket(), f.kind());
                self.inflight = Some(f);
                Err(format!(
                    "内部错:数据回执的窗口凭据对不上({kind:?}/{ticket:?} vs {k:?}/{t:?})"
                ))
            }
            None => {
                Err(format!("内部错:收到数据回执({kind:?}/{ticket:?}),但中转数据窗口是空的"))
            }
        }
    }

    /// [`RelayData::take_inflight`] 的 blob 形(取回那一笔图字节供流)。
    fn take_blob(&mut self, ticket: RelayDataTicket) -> Result<BlobJob, String> {
        match self.take_inflight(ticket, DataKind::Blob)? {
            Inflight::Blob { job, .. } => Ok(job),
            Inflight::Ops { .. } => unreachable!("take_inflight 刚核过类别"),
        }
    }

    /// [`RelayData::take_inflight`] 的 ops 形(取回那一笔凭据)。
    fn take_ops(&mut self, ticket: RelayDataTicket) -> Result<OpsJob, String> {
        match self.take_inflight(ticket, DataKind::Ops)? {
            Inflight::Ops { job, .. } => Ok(job),
            Inflight::Blob { .. } => unreachable!("take_inflight 刚核过类别"),
        }
    }

    /// 在制那一枚发完一块之后回队(**队尾**,见 [`Deck::relay_data_pump`] 那条轮转)。
    /// 待办里已有同对端更新的一笔 = 对端在这期间换了 transfer,旧的就此作废。
    ///
    /// 不会撑破上界:这个对端本来就在 `peers_with_work()` 里数着(它正是在制那一笔的
    /// 主人),故推回去之后 `pending` 至多回到它被弹出前的长度。
    fn requeue(&mut self, job: BlobJob) {
        if self.pending.iter().any(|p| p.serve.to == job.serve.to) {
            return;
        }
        self.pending.push_back(job);
    }

    /// 会话收场 / 整台丢弃:窗口与待办一并作废(§6.1「`ServeBlob` 作废,等接收方重新
    /// Pull」)。收端在我方会话断期间会自己 stale 换来源,留着只会往它可能已放弃的
    /// transfer 上发字节。**发号器刻意不复位**(见 `next_ticket`)。
    ///
    /// **两类的收场语义不同,而这里只写得下一句**(§6.1「session 收场」那条):
    /// * `ServeBlob` **作废**,等接收方重新 Pull —— 就是这里的丢弃;
    /// * `ServeOps` **不推进游标、退回 pending** —— 由 [`OpsJob::ticket`] 的 `Drop` 交回
    ///   `rollback` 兑现,work 本身住在引擎槽里、跨会话原样留着。
    ///
    /// 故这一句丢弃对两类都是对的,**ops 那半的正确性挂在 RAII 上而不是挂在这行代码上**
    /// ——它同样覆盖 abort、换代、panic 展开这些没人来得及调 `clear` 的出路。
    ///
    /// 轮转位不清:`ops_rr` 与 `last_was_ops` 是**公平账**不是在飞态,跨会话留着才不会
    /// 每次重连都从表头偏置(同 L-c2a「UI 去重位随会话复位、数据事实跨会话保留」的分法)。
    fn clear(&mut self) {
        self.inflight = None;
        self.pending.clear();
    }
}

/// [`Deck::fan_out_broadcast`] 的回执:收口帧 + **真入队成功的腿数**。
///
/// 为什么非要那个数不可(codex 实现审一轮 M):`back` 为空同时意味着「全成功」「封不出帧」
/// 「全部入队失败」三种情形。权威腿在场时三者处置**相同** —— 那一笔的成败只由 relay 的
/// Ack/Nack 说了算,补投腿的死活一律不回滚(§6.2 ①(C))。**断网期不同**:那时 LAN 就是权威
/// 腿,一条都没投出去还提交游标,那一段就此从内存游标上过去了(持久 `last_pushed` 没动,
/// 要等中转恢复的保守合并才补得回来)。
#[must_use]
struct FanOut {
    back: Vec<Output>,
    /// 真入队成功的腿数。0 = 一个字节都没出门。
    delivered: usize,
}

/// [`Deck::push_lan`] 的回执:收口帧 + **这一笔到底入没入队**。
///
/// `outs` 非空不等于失败(旁链被摘时也产帧),空也不等于成功(封不出时同样是空)——
/// 「成没成」是独立的一格,不许从帧的有无去猜(同 §6.2「不按 `msg` 形状猜 `Sent`」)。
#[must_use]
struct LanPush {
    outs: Vec<Output>,
    ok: bool,
}

/// 一条腿试一回合的结局([`Deck::pump_ops`] / [`Deck::pump_blob`] 共用)。
///
/// 三态而不是 `bool`:`Recast` 那一档要让**整次调用**连已攒的 deny 一起丢(旧 K_acc 封的
/// 帧一枚都不许出门),`bool` 表达不了「成功但什么都别发」。
enum PumpTurn {
    /// 占上窗口了(发出去一枚数据帧):本次收工。
    Armed,
    /// 这一类此刻没活:机会让给另一类。
    NoWork,
    /// 本机身份已换代:一枚都不发。
    Recast,
}

/// 沿同 transfer 回一枚 `BlobDeny`(行中途没了 / 读坏了 / 待办满额)。**钉中转**:同
/// transfer 的块永不跨腿(§5.1),而这枚 deny 是那笔供流的终局帧。
///
/// 它**不占数据窗口**——没有后续块要驱动,故照普通 direct 帧走 [`Sent::Direct`]:
/// `not_online` 时该标 peer down 的语义与别的 direct 帧一模一样。
fn blob_deny_out(serve: &BlobServe) -> Output {
    Output::Send {
        to: serve.to.clone(),
        lane: Lane::Direct,
        route_hint: RouteHint::Require(Route::Relay),
        msg: Msg::BlobDeny {
            image_id: serve.image_id.clone(),
            transfer: serve.transfer.clone(),
        },
    }
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

/// 引擎所依的身份指纹:(账户, 设备, K_acc)。
type EngineKey = (String, String, [u8; 32]);

/// **运行时级引擎槽**(lan-direct-plan 不变量 6,L-c2a):引擎随空间 runtime 装配即活、
/// 跨中转重连存活——中转与 lan 都只是它的路由,没有哪条链路是它活着的前提。这不是
/// 优化:断 WAN 冷启动时一条中转会话都没建过,引擎还是得先装配好,直连才起得来。
///
/// 顺带的既有收益:pending 池、隔离镜像、缺字节清单、在飞拉流不再每次重连从头来过。
///
/// 「什么时候该整台丢弃」由**身份指纹自证**,不靠壳层记得发 `Reconfigured`(L-b/L-c1
/// 两笔实现审同一条教训:把不变量交给调用方自律迟早漏)——账户 / 设备 / K_acc 任一变
/// (创号、加入账户、纪元压实换代)= 旧引擎的水位、隔离镜像、清单全是上一辈子的事,
/// 当场丢弃重装;只换服务器地址(`set_server`)不换身份,引擎照活。
///
/// **lan 链路集也住在这里**(L-c2c):`LanReady`(不变量 6)的五个条件恰好就是「这个槽里
/// 有引擎」——已配置 ∧ `bootstrapped_at` 已落 ∧ 当前 generation 引擎已装配 ∧
/// `on_runtime_started` 成功 ∧ 身份/纪元闸未闭,[`EngineSlot::reconcile`] 与 `run` 的三档
/// 撤位逐条兑现过。链路集放进槽里,「撤位即拆链」就成了**结构事实**而不是一句纪律。
struct EngineSlot {
    /// 指纹与引擎**同生共死**(装在一个 Option 里,不是两个字段):没有「引擎还在、
    /// 指纹丢了」这种半态可写错,`reconcile` 的判据永远有依据。
    engine: Option<(EngineKey, Engine)>,
    blob_policy: BlobPolicy,
    /// 局域网链路集(§3/§6)。非空**必然**意味着槽里有引擎([`EngineSlot::retire`] 一并
    /// 清),故不存在「有链路没引擎」的路由幻影。
    lan: LanLinks,
    /// 拨号器(§7;L-c3b)。住在槽里,故「撤位即取消在飞拨号」与「撤位即拆链」是同一个
    /// 结构事实——不是「记得在撤位那几档各调一句 cancel」的自律。
    dial: lan_net::Dialer,
    /// op 追赶的惰性供流计划(§6.1 所有权表的**前两层**:节流与逻辑计划)。**住槽里**,
    /// 故跨 LAN 换代、跨中转重连存活,随 `EngineKey` 换代整台丢弃([`EngineSlot::retire`])。
    ///
    /// 为什么是 `Arc<Mutex<_>>` 而不是裸字段:两条消费腿都不在协调者的栈上——LAN 那条是
    /// 每链一只独立写任务(它必须能在协调者忙别的事时自己逐帧取数,同 C′ 的理由),relay
    /// 那条(第④笔)则要在 Ack 到达时提交。把手共享,**所有权仍是槽的**:第三层「该腿的
    /// 在飞帧与凭据」归具体那一代执行态(LAN = 写任务里的 [`OpsTicket`]),链死即回滚。
    ///
    /// **293(第⑤笔)起生产路径全接上**:`on_hello`/`on_want`/`outbound` 三个入口都往这张
    /// 表登记义务,帧由两条腿的泵逐帧惰性取。
    ops: Arc<Mutex<ops_serve::OpsWorks>>,
    /// **释放 → 唤醒**的那一声(§6.2 ④′;L-d″ 第⑤笔的开工闸之一)。
    ///
    /// 病:两条腿共享 per-target 的在飞位,一条腿武装着,另一条腿醒来看到 `Occupied` 就
    /// 灭 armed 睡下 —— 此后**没有任何事件**告诉它「位子空出来了」。最短复现:relay 攥票
    /// → LAN 睡下 → relay 会话在 Ack 之前死掉 → RAII 回滚、work 重新 runnable → 断 WAN
    /// 期间没有新会话仪式泵 → work 本来就 runnable 故 `on_tick` 的 false→true 边沿也不再报
    /// → **LAN 永久睡眠**。
    ///
    /// 形:**边沿合并器**。`notify_one()` 在无人等待时留一枚 permit,故多次 release 安全
    /// 折叠成一枚;**协调者是唯一 waiter**。刻意不是有界通道——通道会满,`try_send` 一丢,
    /// 释放就永远没人知道,同一个洞换个入口原样回来。
    ///
    /// **`retire` 不换它**(与 `ops` 相反):它不承载任何跨代事实,只是一根「去看一眼」的
    /// 线;换掉反而要回答「旧代凭据 Drop 时摇的那一声算不算数」。多醒一次的代价 = 协调者
    /// 扫一遍空表。
    ops_changed: Arc<Notify>,
    /// 中转腿的全局数据窗口与待办(§6.1;L-d″ 第④笔)。**住槽里**的理由与欠下的那条
    /// 释放义务,见 [`RelayData`]。
    relay_data: RelayData,
    /// **对账控制帧的重发债**(§6.1 九轮 H1;见 [`Sent::ReconcileCtl`])。`None` = 没债。
    /// 不是队列、也不存帧:`busy` 时置一笔,**下一拍心跳重新构造一枚广播 Hello**,
    /// 只有**那枚广播 Hello 自己**的 Ack 才清(codex 实现审一轮 H1 收窄:一轮是「任一
    /// `ReconcileCtl` 的 Ack 都清」,普通 Want 的 Ack 会把债静默吞掉)。
    ///
    /// **住槽里(跨会话)而不是住 `RelaySession`**:规格明写「会话仪式产生的新 Hello
    /// 可以接管这笔债」,而债要能被接管就得先活过会话边界 —— 住会话里的话,`busy` 恰好
    /// 落在会话末尾那一枚上时债随收场蒸发,新仪式 Hello 的 Ack 也就无债可清。
    ///
    /// 换身份即清([`EngineSlot::retire`]):那是上一辈子的对账义务,新身份的会话仪式
    /// 会发自己的 Hello。
    reconcile_debt: Option<ReconcileToken>,
    /// 债的发号器。**每次置债都换新号**,故一枚「债挂上之前就构造好的」广播 Hello 的
    /// 回执清不掉这笔新债 —— 它携带的是旧号。`retire` 刻意不复位(同 `RelayData` 那只:
    /// 复位就会复用号,而迟到回执正是要靠号对不上来认出来)。
    next_reconcile: u64,
    /// 「每会话弹一次」的两枚提示去重位。**L-c2c 起从 `Ctx` 挪到槽里**:断 WAN 期间也有
    /// lan 帧要报版本偏斜,而那时一个中转会话都没有,位子不能只挂在会话上;复位仍在会话
    /// 仪式([`Ctx::relay_session_up`],L-c2a 那条线:UI 去重位随会话复位)。
    notices: Notices,
}

/// 提示去重位(见 [`EngineSlot::notices`])。
#[derive(Default)]
struct Notices {
    /// 已弹过「对端版本较新」(解得开但读不懂的帧)。
    skew_toasted: bool,
    /// 已弹过「对端时钟远快于本机」。
    clock_skew_toasted: bool,
}

impl AdFace {
    /// 一条中转会话的通告面初态。`ready` = 归属指纹本轮对齐成功(见 [`AdFace::ready`])。
    fn new(ready: bool) -> AdFace {
        AdFace {
            ready,
            off: false,
            published: None,
            asked: HashSet::new(),
            warned: HashSet::new(),
            answered: HashSet::new(),
            conflict_reported: HashSet::new(),
        }
    }
}

impl EngineSlot {
    /// `handoff` = 链路移交通道的发送端(拨号器往里塞握手好的链路)。`None` = 本 `run`
    /// 不拨号——只在不需要拨号面的单测里出现。
    fn new(
        blob_policy: BlobPolicy,
        handoff: Option<mpsc::Sender<AdoptedLink>>,
    ) -> (EngineSlot, mpsc::Receiver<LanInbound>, mpsc::Receiver<LanFault>) {
        let (lan, inbound, faults) = LanLinks::new();
        (
            EngineSlot {
                engine: None,
                blob_policy,
                lan,
                dial: lan_net::Dialer::new(handoff),
                ops: Arc::new(Mutex::new(ops_serve::OpsWorks::default())),
                ops_changed: Arc::new(Notify::new()),
                relay_data: RelayData::default(),
                reconcile_debt: None,
                next_reconcile: 0,
                notices: Notices::default(),
            },
            inbound,
            faults,
        )
    }

    /// `LanReady`(不变量 6):监听器准入与拨号只认它;此处 = 槽里有引擎。
    fn lan_ready(&self) -> bool {
        self.engine.is_some()
    }

    /// 拨号器下次该巡查的时刻(协调者的 select 臂用)。**没引擎就不挂**:LanReady 撤位
    /// 期不拨号(§6 撤位清单)。
    fn dial_due(&self) -> Option<Instant> {
        self.lan_ready().then(|| self.dial.due()).flatten()
    }

    /// 拨号巡查一轮(§7)。`self_listening` 取本机监听落点在不在——方向优先级的两侧事实
    /// 之一(另一件是对端通告里的 listen,由 `dial_candidates` 判)。
    ///
    /// 返回值 = **这一轮要报的诊断**(`None` = 无事)。`host_seat` = 本机有没有监听席位
    /// (它决定「一台对端都没缓存」时巡查的计时器摘不摘,见 [`lan_net::Dialer::round`])。
    fn dial_round(
        &mut self,
        db: &Arc<Mutex<Connection>>,
        cfg: &SyncConfig,
        host_seat: bool,
    ) -> Option<String> {
        if !self.lan_ready() {
            self.dial.retire();
            return None;
        }
        let EngineSlot { lan, dial, .. } = self;
        let self_listening = lan.listen.is_some();
        dial.round(
            &cfg.account_id,
            &cfg.device_id,
            &cfg.k_acc,
            &cfg.device_seed,
            db,
            self_listening,
            host_seat,
            &|peer| lan.has(peer),
        )
    }

    fn get(&mut self) -> Option<&mut Engine> {
        self.engine.as_mut().map(|(_, e)| e)
    }

    fn peek(&self) -> Option<&Engine> {
        self.engine.as_ref().map(|(_, e)| e)
    }

    /// **槽的当前事实照进状态快照**(唯一出口):挂起数 / 冻结清单 / 隔离 / poison
    /// breaker / 活跃直连链路数。引擎跨会话存活后,这几项**不能再在建连前一律清零**
    /// ——它们是引擎的当前事实,不是会话的。
    ///
    /// 链路数也收在这里(实现审 L1):撤位与身份换代都在 [`EngineSlot::retire`] 里拆掉
    /// 全部链路,而拆链没有别的 UI 出口——漏刷一次,状态面上就长期挂着「还有 N 条直连」
    /// 的幻影,且没有第二处能纠正它(状态面是 lan 唯一的可见面)。
    fn apply_status(&self, s: &mut SyncStatus) {
        s.lan_peers = self.lan.count();
        // 顺带把活跃对端照进准入表看得见的那份视图(§4 步骤 1 的第四道闸)——链路集的
        // 每一次增删都经这个出口,故两处不会各说各的。
        self.lan.publish_view();
        match self.peek() {
            None => {
                s.suspended = 0;
                s.frozen = vec![];
                s.quarantined = vec![];
                s.poison_breaker = None;
            }
            Some(e) => {
                let mut frozen: Vec<String> = e.frozen.keys().cloned().collect();
                frozen.sort();
                let (quarantined, breaker) = e.poison_status();
                s.suspended = e.suspended_count();
                s.frozen = frozen;
                s.quarantined = quarantined;
                s.poison_breaker = breaker;
            }
        }
    }

    /// 引导中吗(引擎未装配 = 还没拿到首份快照)。
    fn booting(&self) -> bool {
        self.engine.is_none()
    }

    /// 记一笔对账重发债(**唯一置债点**,见 [`EngineSlot::reconcile_debt`])。
    ///
    /// 每次都换新号 —— 已在飞的那些广播 Hello 都是这笔债之前构造的,不许拿它们的 Ack
    /// 销这一笔账。发号器耗尽响亮(与窗口凭据同一条:静默回绕就等于复用号)。
    fn set_reconcile_debt(&mut self) -> Result<(), String> {
        let n = self.next_reconcile;
        self.next_reconcile = n.checked_add(1).ok_or("内部错:对账重发债的发号器耗尽")?;
        self.reconcile_debt = Some(ReconcileToken(n));
        Ok(())
    }

    /// 装配时用的身份指纹(测试锚:验「换身份即整台丢弃」)。
    #[cfg(test)]
    fn key(&self) -> Option<&EngineKey> {
        self.engine.as_ref().map(|(k, _)| k)
    }

    /// 整台丢弃(未配置 / 配置残缺 / 纪元 pending 封闸——即 LanReady 撤位的那几档)。
    fn retire(&mut self) {
        self.engine = None;
        // 链路一起拆(§4「本机身份换代由 session_gate 拆全部 lan 链路」/ 不变量 6 的撤位
        // 清单):撤位后残留的链路是拿旧 K_acc 建的,封解不了新纪元的任何一帧,留着只会
        // 让选路指向死腿。丢弃 = `LanLink::drop` 里 abort 两只任务、socket 落地。
        self.lan.revoke();
        // **在飞的出站握手一并取消**(§6 ⑤:「stop / 撤位要同时取消入站与出站全部未移交
        // 的握手任务」)。入站那一半由准入表的 `deregister` 摘条目时 abort。
        self.dial.retire();
        // 中转数据窗口一并作废(§6.1「session 收场时必须释放全局数据窗口」的另一半:
        // 整台丢弃时同样不许把「在飞」留给下一代——那一枚的回执随旧会话一起没了)。
        //
        // **排在换表之前**(第④笔下半):窗口里若攥着一枚 ops 凭据,它的 `Drop` 要把在飞位
        // 交回**它自己那份 work**;先换表的话回滚照样落在旧那只(凭据攥的是 `Arc` 把手,
        // 不是字段),只是那时旧表已经是孤儿、谁也看不见它回滚成没成。两种排法都不丢正确性,
        // 排这一边是**为了让回滚落在还看得见的表上**。
        self.relay_data.clear();
        // ops 供流计划**换一整只**(§6.1 所有权表:随 `EngineKey` 换代整台丢弃)。
        // 刻意不是「清空这一只」:将死的写任务手上还攥着凭据,它们的回滚会落在这枚被换下
        // 的孤儿表上——**新一代从此没有任何旧凭据能碰得到**,这是结构事实不是时序自律。
        self.ops = Arc::new(Mutex::new(ops_serve::OpsWorks::default()));
        // 对账重发债随身份一起作废(见 [`EngineSlot::reconcile_debt`])。**发号器不复位**:
        // 旧身份那枚广播 Hello 的迟到 Ack 正是要靠号对不上来认出来。
        self.reconcile_debt = None;
    }

    /// **对齐槽与库的当前事实**(幂等;实现审 M3 把「判过期」与「装配」合成这一个
    /// 入口)。三条分支穷尽:
    /// * `bootstrapped_at` 缺席 → **无条件丢弃**。「引擎在场 ⟺ 已引导」这条等价关系
    ///   是 `booting()` 的全部依据,拆成「先看槽满没、再看标记」的两步就只是句注释:
    ///   标记没了而槽里还有引擎的话,谁也撤不掉它。
    /// * 已装配且身份指纹相同 → 原样保留(**绝不重建**:`on_runtime_started` 重跑会把
    ///   在飞拉流的图塞回缺字节清单,破「清单与在飞互斥」,故它二次调用是响亮报错)。
    /// * 其余(空槽 / 身份换代)→ 丢弃后重新装配。
    ///
    /// 装配 = `Engine::new` + 一次性本地初始化,**不产出任何帧**——此刻可能一条链路
    /// 都没有(断 WAN 冷启动),hello/want 的发起时机归会话仪式与 lan 链路建立。
    fn reconcile(&mut self, conn: &Connection, cfg: &SyncConfig) -> Result<(), String> {
        let out = self.reconcile_inner(conn, cfg);
        // 测试专用:把这个空间的 ops 计划表把手挂出去(见 [`publish_ops_handle`])。
        // **排在最后**:`retire` 会换整只表,挂早了挂出去的是上一代那只。
        #[cfg(test)]
        publish_ops_handle(&cfg.device_id, &self.ops);
        out
    }

    fn reconcile_inner(&mut self, conn: &Connection, cfg: &SyncConfig) -> Result<(), String> {
        if meta_get(conn, "bootstrapped_at")?.is_none() {
            self.retire();
            return Ok(());
        }
        let key: EngineKey = (cfg.account_id.clone(), cfg.device_id.clone(), cfg.k_acc);
        if self.engine.as_ref().is_some_and(|(k, _)| *k == key) {
            return Ok(());
        }
        self.retire();
        // 把手交的是**当时**那只表(§6.2 ⑤(a))。顺序天然正确:上面刚 `retire()` 换过整只,
        // 故新引擎拿到的必然是新那只 —— 不是「记得在换表之后再造引擎」的自律。
        let mut engine = Engine::new(conn, self.blob_policy, Arc::clone(&self.ops))?;
        // 两步都成了才入槽:`on_runtime_started` 崩了就整台丢弃重来,不留「装配到
        // 一半、缺图清单没派生」的半成品在槽里(部分成功登记)。
        engine.on_runtime_started(conn)?;
        self.engine = Some((key, engine));
        // 装配好了就该看一眼要不要拨号:**冷启动全靠这一下**(断 WAN 起步时一枚通告都不会
        // 到,没有它就得干等第一次空闲巡查——而撤位期计时器是摘掉的,压根没有「第一次」)。
        self.dial.kick();
        Ok(())
    }
}

/// 测试专用:每台 runtime 的 ops 计划表把手,按 device_id 挂出来。
///
/// **为什么留着这道后门**:第⑤笔起三个生产入口(`on_hello` / `on_want` / `outbound`)
/// 都真在登记义务了,故它不再是「唯一的生产者」;但要在**一个确定的段上**验消费面
/// (哪条腿先拿到票、封不出时卡的是哪一段、让位收没收回),仍得能直接把一段 work 摆进去
/// ——绕开三个入口各自的冷却与水位派生。「全绿一条没红」在 290 上刚栽过一次(中转腿的
/// 数据面当时零覆盖,查出来才造的 `FakeRelay`)。
///
/// 键是 device_id:每台 rig 一个独立库、独立设备身份,故并行跑的用例互不串台。
/// **生产构建里这张表根本不存在**。
#[cfg(test)]
static OPS_HANDLES: Mutex<std::collections::BTreeMap<String, Arc<Mutex<ops_serve::OpsWorks>>>> =
    Mutex::new(std::collections::BTreeMap::new());

#[cfg(test)]
fn publish_ops_handle(device: &str, ops: &Arc<Mutex<ops_serve::OpsWorks>>) {
    OPS_HANDLES
        .lock()
        .expect("ops handles mutex poisoned")
        .insert(device.to_string(), Arc::clone(ops));
}

// ---- 局域网链路集(lan-direct-plan §3 / §5 / §6;L-c2c) --------------------------------

/// 每空间链路数上界(§10)。满额 = 新链一律拒(fail-closed 只影响直连,中转照常)。
const LAN_LINKS_MAX: usize = 16;
/// 每链发送队列的**双上界**(§10):帧数 ∧ 字节。任一超 = 断该链,**绝不阻塞、也绝不
/// 跳过中转入队**(§5 故障隔离:两路发送无共享阻塞点)。
const LAN_LINK_QUEUE_FRAMES: usize = 256;
const LAN_LINK_QUEUE_BYTES: usize = 8 * 1024 * 1024;
/// 每链**供流描述符**队列(§10 C′)。刻意与上面那两道分开:描述符不含字节(几十字节
/// 一枚),它存在的全部意义正是绕开「整图入队撞 8 MiB 上界」——把它计进字节预算等于
/// 把修好的东西再拧回去。
///
/// 4 笔是给违约留的余量:收端窗口(engine 的 `MAX_ACTIVE_PULLS` = 1)之下,一台对端
/// 同时至多拉一张图,正常态这条队列恒 ≤1。满 = 对端在同时拉四张以上,按 §5「队满即断
/// 该链」处置(自伤,中转照常)。
const LAN_SERVE_QUEUE: usize = 4;
/// 每空间 lan 发送聚合预算(§10)= 全部链路**已入队未写出**的字节之和。
///
/// **它不是本空间 lan 侧内存的全部**(264 实现审 M3 的诚实记账):C′ 之后供流的块不进
/// 队列,故每条链另有至多**一件在制的数据**——写泵一轮只干一件事,故那一件要么是一块
/// 256 KiB 的图字节,要么是一枚 ops 帧;两者都是原始字节 + CBOR 明文 + 密文 + 外层
/// LanWire 编码这几份瞬时副本。ops 帧的上界比块大:切帧字节尺是 256 KiB,但**第一枚 op
/// 恒独占**,故一枚帧至多约 `MAX_OPS_FRAME_BYTES + 单条 op 上界`(本机 op 的正文封顶
/// 200 KiB;更大的只可能来自帧上限更宽的对端,而那种帧在这条腿上封不出来、当场终局)。
/// 峰值因此约 1.5 MiB/链,16 条链约 24 MiB,与这道预算**并列**而不在其中。合起来仍有界
/// (32 + ~24 MiB),但别把本行读成「lan 侧最多 32 MiB」。
const LAN_SPACE_QUEUE_BYTES: usize = 32 * 1024 * 1024;
/// 全部链路的**数据**事件汇入一根通道;满了即读端背压(= TCP 背压),不丢帧。
const LAN_INBOUND_CAP: usize = 64;
/// **断链信号独立通道**(§10)。死讯绝不排在数据面后头:数据通道积压 64 枚时,写端失败的
/// 那声 Down 连入队都做不到(`send().await` 挂在满通道上),摘腿、作废在飞 pull、重问缺字节
/// 全跟着一起卡住——而那正是「链路已经不行了」的时刻,最需要及时。容量按「每条活链最多两只
/// 任务各报一次」给,故实际永不满(真满了也只是给一只将死的任务施背压,信号不丢)。
const LAN_FAULT_CAP: usize = 2 * LAN_LINKS_MAX;
/// 链路移交通道的容量(§6 handoff):协调者一有空就取,握手完成的链路本就稀疏。
const LAN_HANDOFF_CAP: usize = 4;
/// 格式层静默判死(§3:30s 一枚 Ping / 静默 90s 判死)。**Ping 的节奏借 runtime 那根
/// 心跳**——「整个 runtime 一根心跳 interval」是 L-c2a 的既有契约(每条链一根的话相位
/// 随链路来去而散,离线泵里还得逐条驱动),而它恰好就是 30s:
const _: () = assert!(
    HEARTBEAT_SECS == 30,
    "lan 的 Ping 借 runtime 那根心跳发,§3 要求 30s 一枚;心跳周期改了就得给 lan 另起一根"
);
const LAN_SILENCE_SECS: u64 = 90;
/// 断网期定向 Hello 的低频重发间隔(§5 / §10)。**规格数值锚**(实现审三轮 M1):行为测
/// 拿线程局部覆盖位把它压到毫秒级去验「计时器武装着且会重复起」,那条测因此证不了「60」这个
/// 数——数值由这行守着,改它就得同改规格。
const LAN_OFFLINE_HELLO_SECS: u64 = 60;
const _: () = assert!(
    LAN_OFFLINE_HELLO_SECS == 60,
    "§5:断网期定向 Hello 每 60s 一轮;改这个数要同改 lan-direct-plan §5/§10"
);

/// 移交一条**握手已完成**的链路(§6 准入表的 handoff 那一格)。到这一步 §4 的三步双向
/// 证明已过、§7 仲裁的方向层已定(拨号器/监听器归 L-c3);链路集只再做「同对端恒单活跃
/// 写者」的收口(见 [`LanLinks::admit`])。
pub(crate) struct AdoptedLink {
    /// 握手终局:已验签的对端 device_id + 两侧同尺的 `link_id`。
    pub established: lan::LanEstablished,
    pub stream: TcpStream,
}

/// 一条链路上抬给协调者的事件。**代次随事件走**:链路被替换/摘掉之后迟到的事件,靠
/// `(peer, generation)` 当场识别并丢弃——「迟到的旧代断链通报不许打掉新链」这条不变量
/// 守在持有者一侧(§5.1),不靠任务自己收敛。
struct LanInbound {
    peer: String,
    generation: u64,
    event: LanEvent,
}

enum LanEvent {
    /// 数据面帧(地址已按 §3 校验过:`from` == 握手绑定的对端、`to` == 本机或广播)。
    Frame { from: String, to: String, blob: Vec<u8> },
    /// 收到对端心跳:回一枚 Pong。
    Ping,
    /// 收到 Pong:除刷新活性时刻外别无用处(刷新在 [`LanLinks::touch`] 里)。
    Pong,
}

/// 链路收场(读端 EOF / 坏帧 / 地址不符,或写端失败):协调者据此摘腿并通报引擎。
///
/// **刻意不是 [`LanEvent`] 的一个变体**(§10 断链信号独立通道,实现审 M2):它走自己那根
/// 通道,故「数据面积压把死讯压在底下」在类型层就不成立——两根队各排各的,协调者的 select
/// 每一轮都看得见它。代次照样随信号走:迟到的旧代死讯不许打掉新链(§5.1)。
struct LanFault {
    peer: String,
    generation: u64,
    why: String,
}

/// LAN 供流泵要的一切(§10 C′ 第 3/4 条):短查数据库的把手 + 封帧材料 + 一条报警的路。
/// **整只克隆进写任务**——协调者的栈借不出去,而写泵必须能在协调者忙别的事时独立逐块
/// 推进(整图一次性入队才会撞 8 MiB 队列上界,那正是本笔要修的)。
///
/// 写泵因此成了协调者之外**第二个封帧的地方**。这不是新能力面:同 `K_acc`、同域子钥、
/// 同 AAD 五元组,封帧走的是与协调者**同一个** [`seal_lan_frame`](单一真相源);它只是
/// 把「块在什么时候被造出来」从协调者挪到了这条链自己身上。
///
/// **两条腿共用一份形**(L-d″ 第④笔下半起,原名 `LanServeCtx`):中转腿的 ops 取数走的是
/// 与 LAN 写泵**同一个** [`ops_prepare`](自证身份 + 取数 + 武装凭据同一把库锁),两边各写
/// 一遍就会长出第二处真相源与第二条锁序。区别只在谁来构造:LAN 那条是建链时克隆一份带进
/// 写任务,中转那条由协调者按需 [`Deck::serve_ctx`] 现造。
#[derive(Clone)]
struct ServeCtx {
    db: Arc<Mutex<Connection>>,
    status: Arc<Mutex<SyncStatus>>,
    events: mpsc::UnboundedSender<SyncEvent>,
    account_id: String,
    device_id: String,
    k_acc: [u8; 32],
    /// 只为**自证身份**([`identity_still_current`] 的第四件),不参与封帧。
    device_seed: [u8; 32],
    /// op 供流计划表的把手(§6.1;所有权仍在 [`EngineSlot::ops`])。写泵拿它调
    /// [`ops_serve::PeerWork::prepare_next`] —— 与 blob 那半同一条论证:帧由消费方逐帧
    /// 取、逐帧封、逐帧写,协调者一次入队的东西里**不再有能撞穿队列上界的**。
    ops: Arc<Mutex<ops_serve::OpsWorks>>,
    /// 释放 → 唤醒的那一声(见 [`EngineSlot::ops_changed`])。写泵手上那枚
    /// [`OpsTicket`] 交回在飞位时经它通知协调者。
    ops_changed: Arc<Notify>,
}

/// 一条活跃链路的把手(协调者侧;两只任务的所有权在这里)。
struct LanLink {
    generation: u64,
    /// 待发字节的入口(帧已在协调者侧封好)。容量 = [`LAN_LINK_QUEUE_FRAMES`];
    /// **只 `try_send` 绝不 await**(§5 故障隔离)。
    tx: mpsc::Sender<Arc<Vec<u8>>>,
    /// 待供的图字节(§10 C′):**描述符,不是字节**。与 `tx` 分成两根是「控制帧在块
    /// 边界插队」的前提——合成一根 FIFO 的话,一枚排在整图前面的 Ping 要等几十秒。
    serve_tx: mpsc::Sender<BlobServe>,
    /// ops 供流的唤醒铃(§6.1「`Notify` 唤醒」)。**连描述符都不用递**:该发什么由写泵
    /// 自己问 [`EngineSlot::ops`] 里那份计划,这根铃只说「去看一眼」。
    ///
    /// 铃是**带一枚存量的**(`notify_one` 在无人等待时留一枚 permit),故「协调者响铃时
    /// 写泵正巧在取数」不会丢掉这一声。**293(第⑤笔)起真有人摇**:收下 Hello / Want / 本机
    /// 新 op 的那三处产出 `Output::ServeOps`,由 [`Deck::serve_ops`] 与 [`Deck::ops_changed_tick`]
    /// 选腿摇到这里。
    ops_wake: Arc<Notify>,
    /// 已入队未写出的字节数:协调者(唯一生产者)加、写任务(唯一消费者)减。
    queued: Arc<AtomicUsize>,
    /// 最近一次从该链路收到**任何**帧的时刻(§3 静默判死;Ping/Pong 也算)。
    last_rx: Instant,
    /// 握手 transcript 的哈希(§7 的共同尺):同对端并发建链时两侧拿它比出同一条胜者。
    link_id: [u8; 32],
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
}

impl LanLink {
    /// 在位那条赢吗(§7 二级规则:`link_id` 字典序小者胜)。
    fn incumbent_wins(&self, candidate: &[u8; 32]) -> bool {
        self.link_id <= *candidate
    }
}

impl Drop for LanLink {
    /// 链路对象一丢弃就**关掉 socket 并丢掉剩余队列**(§6 代次契约之三「入队即绑具体
    /// 链路对象」的另一半:替换/死亡不把旧队列改投新链)。abort 两只任务 = 两个半边
    /// socket 随即落地。
    fn drop(&mut self) {
        self.reader.abort();
        self.writer.abort();
    }
}

/// 入队失败的两种形(§5 / §6)。
enum LanSendErr {
    /// 该对端没有链路。引擎以为有 = 接线漂移(响亮记一笔);补投面算出来的目标刚好在
    /// 同一刻断了也走这条(无害,重连/重问会自愈)。
    NoLink,
    /// 有链路但送不出(队满 / 写任务已死):链路**已被摘掉**,调用方须通报引擎该代次
    /// 的腿 down(§6「`Require` 送不出必随即通报该路由 down」)。
    Failed { generation: u64, why: String },
}

#[cfg(test)]
thread_local! {
    /// 预算腾挪的**一次性**注入点:采样已出、破坏性摘链还没动手的那一刻。见
    /// [`arm_budget_probe_hook`]。
    static BUDGET_PROBE_HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        const { std::cell::RefCell::new(None) };
}

/// 装一枚**一次性**钩子(仅测试构建):[`LanLinks::enqueue`] 的腾挪循环每采完一次样、
/// 还没摘链之前调一下。
///
/// 为什么是回调而不是别的栅栏形(实现审一轮 M1 的修法要能被证伪):`enqueue` 是同步函数,
/// `SERVE_BARRIER` 那种「停下来 await 到放行」的栅栏根本插不进去;而「采样到动手之间写泵
/// 把候选排空了」这个窄窗,不给注入点就只能靠赌调度。用它,用例把候选的计数器清零这件事
/// 落在**确定的**那一刻。
#[cfg(test)]
fn arm_budget_probe_hook(f: impl Fn() + 'static) {
    BUDGET_PROBE_HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f)));
}

/// 钩子的消费点(装了才调,调一次就卸)。
fn budget_probe_hook() {
    #[cfg(test)]
    if let Some(f) = BUDGET_PROBE_HOOK.with(|h| h.borrow_mut().take()) {
        f();
    }
}

/// 一次入队的完整产出:**本次这一笔的成败 + 顺带被摘掉的旁链**(L-d″ 第③笔)。
///
/// 为什么不是一个光秃秃的 `Result`:空间预算耗尽时被摘的那条**未必是本次收件人**(见
/// [`LanLinks::enqueue`] 的选择规则),而「摘了链就欠引擎一份该代次的腿 down 通报」是不
/// 可省的义务——把它放进返回值里,漏掉是编译期看得见的未用变量,而不是运行期一条永远
/// 有人往里投帧的黑洞路由(L-d‴ H1 那条纪律:已经发生的破坏性动作不许被后面的失败分支
/// 跳过)。
#[must_use = "被摘掉的链各欠一份 down 通报:漏掉的话选路会一直往一条已经不存在的链投帧"]
struct LanEnqueue {
    /// 为腾出空间预算而摘掉的**旁**链(不含本次收件人:它自己的失败恒走 `outcome`)。
    /// 每条都已从链路集里消失,调用方逐条走与 `outcome` 完全相同的那条收口。
    evicted: Vec<(String, LanSendErr)>,
    outcome: Result<(), LanSendErr>,
}

impl LanEnqueue {
    /// 没动过任何旁链的常见形。
    fn only(outcome: Result<(), LanSendErr>) -> LanEnqueue {
        LanEnqueue { evicted: vec![], outcome }
    }
}

/// 链路集:每空间(= 每 runtime)一份,住在 [`EngineSlot`] 里(见那里的结构注释:
/// LanReady 与链路集随引擎装配/撤台同生共死)。
struct LanLinks {
    /// 对端 device_id → 那条活跃链(§7:同对端恒单活跃写者)。
    links: HashMap<String, LanLink>,
    /// 单调代次发号器,**永不复用**——迟到事件与旧代 transfer 全靠它识别。撤位重装也
    /// 不回绕(号在集合上,不在引擎上)。
    next_generation: u64,
    /// 全部链路的上抬事件汇入这一根(单协调者消费)。**读端不在这里,在 [`Pumps`] 里**:
    /// 会话循环的 select 臂不能借 `ctx`(引擎槽正在 `ctx` 手上),把读端摘出去那条臂就只
    /// 借一个本地 receiver。链路集自持发送端,故读端永不返回 `None`。
    inbound_tx: mpsc::Sender<LanInbound>,
    /// 断链信号的发送端(§10 独立通道,见 [`LanFault`])。与 `inbound_tx` 同样自持一枚,
    /// 故读端永不返回 `None`。
    fault_tx: mpsc::Sender<LanFault>,
    /// 本机监听落点(§2 的 `LanAd.listen`;L-c3a 起由准入表注册时回填)。**通告序号绑
    /// 内容**:它一变,本会话已封发过的 `ad_seq` 立即作废重新递增(见 [`AdFace`] 的
    /// `published`)。
    listen: Option<lan::LanListen>,
    /// 「此刻有活跃链的对端」的**对外只读视图**(§4 步骤 1 的第四道闸给监听器用)。
    ///
    /// 为什么要有第二份:那道闸判在 pre-auth 握手任务里,而链路集住在协调者手上、别的
    /// 任务碰不到。**它是 advisory 早退闸,权威仲裁恒是 [`LanLinks::admit`]**(§7 二级
    /// 规则),故偏一拍两边都安全——说有其实没有 = 对端退避后重来;说没有其实有 = 落到
    /// `admit` 按 `link_id` 判。刷新点只有一个:[`EngineSlot::apply_status`](链路集每
    /// 一次增删都从那里过)。
    active: Arc<Mutex<HashSet<String>>>,
}

impl LanLinks {
    /// 建集合,连同**两根读端一起交出去**(给协调者的 select 用,见
    /// [`LanLinks::inbound_tx`] 与 [`LanFault`]):数据一根、死讯一根。
    fn new() -> (LanLinks, mpsc::Receiver<LanInbound>, mpsc::Receiver<LanFault>) {
        let (inbound_tx, inbound_rx) = mpsc::channel(LAN_INBOUND_CAP);
        let (fault_tx, fault_rx) = mpsc::channel(LAN_FAULT_CAP);
        let links = LanLinks {
            links: HashMap::new(),
            next_generation: 0,
            inbound_tx,
            fault_tx,
            listen: None,
            active: Arc::new(Mutex::new(HashSet::new())),
        };
        (links, inbound_rx, fault_rx)
    }

    fn count(&self) -> usize {
        self.links.len()
    }

    /// 这台对端此刻有活跃链吗(拨号器的第一道跳过闸;权威值,不是准入表那份 advisory
    /// 视图——拨号器与链路集同住协调者手上)。
    fn has(&self, peer: &str) -> bool {
        self.links.contains_key(peer)
    }

    /// 摇一条链的 ops 供流铃(§6.2 ②;第⑤笔起有生产者)。
    ///
    /// 链不在(还没建 / 刚断)= **什么都不做**:work 留在计划表里,续做所有者是下一次
    /// [`EngineSlot::ops_changed`] 扫描或新链接入那一下(④′「消费者重新出现时也要唤醒」)。
    /// 铃带一枚存量,故「摇的时候写泵正巧在取数」不会丢这一声。
    fn wake_ops(&self, peer: &str) {
        if let Some(link) = self.links.get(peer) {
            link.ops_wake.notify_one();
        }
    }

    /// 交给准入表的活跃对端视图把手(见 [`LanLinks::active`])。
    fn active_view(&self) -> Arc<Mutex<HashSet<String>>> {
        Arc::clone(&self.active)
    }

    /// 把当前活跃对端照进那份只读视图。**唯一刷新点**在
    /// [`EngineSlot::apply_status`]——链路集的每一次增删(移交 / 断链 / 队满摘链 /
    /// 撤位拆链)都从那里过一次,故这份视图不会有「某条路径忘了刷」的漏法。
    fn publish_view(&self) {
        let mut view = self.active.lock().expect("lan active view mutex poisoned");
        *view = self.links.keys().cloned().collect();
    }

    /// 当前活跃对端(排序:投递顺序可复现)。
    fn peers(&self) -> Vec<String> {
        let mut peers: Vec<String> = self.links.keys().cloned().collect();
        peers.sort();
        peers
    }

    /// 发一个新代次。**用尽即拒**(实现审 L2):回绕会让新链拿到某条旧链用过的号,迟到
    /// 事件与旧代 transfer 从此认错人——那是数据面的错,不是可用性问题,故 fail-closed
    /// (中转照走;重开这台 runtime 即复位。实际到不了 2^64)。
    fn next_generation(&mut self) -> Option<u64> {
        self.next_generation = self.next_generation.checked_add(1)?;
        Some(self.next_generation)
    }

    /// 「同对端恒单活跃写者」与容量的收口(§7 / §10):**在改动任何状态之前**判,故败者
    /// 与超额者直接关掉、引擎压根不知道它们存在。
    ///
    /// 同对端已有 incumbent 时拿**两侧同一把尺**比 `link_id` 字典序,小者胜:A 侧的
    /// incumbent 是 L1、候选是 L2,B 侧恰好相反,而 `min(L1,L2)` 两边算得同值——故不会
    /// 「各关各的」双断(§7 二级规则)。
    ///
    /// §7 的一级规则(方向优先级:谁该拨出)归 L-c3——它要的两侧事实(谁在监听、退避、
    /// 子网候选)全在拨号器手上,而二级规则已足以让 peer-map 收敛到同一条链。
    fn admit(&self, established: &lan::LanEstablished) -> Result<(), String> {
        match self.links.get(&established.peer) {
            Some(incumbent) if incumbent.incumbent_wins(&established.link_id) => {
                Err("同对端已有链路且它的 link_id 更小(按 §7 二级规则保留在位那条)".into())
            }
            Some(_) => Ok(()),
            None if self.links.len() >= LAN_LINKS_MAX => {
                Err(format!("本空间局域网链路已满({LAN_LINKS_MAX} 条):新对端的直连不可用"))
            }
            None => Ok(()),
        }
    }

    /// 把链路装进发送表并起两只任务(读/写各一只:读端因此是纯循环,`read_exact` 的
    /// 取消安全问题不存在)。替换 incumbent = 旧对象当场 `Drop`(abort + 丢队列)。
    ///
    /// **只许 [`Deck::lan_adopt`] 调**——它保证「先通报引擎、后进发送表」那条代次契约。
    fn install(
        &mut self,
        generation: u64,
        self_device: &str,
        adopted: AdoptedLink,
        serve_ctx: ServeCtx,
    ) {
        let peer = adopted.established.peer.clone();
        // 小帧(Hello/Want)不该等 Nagle 的 40ms——直连的卖点正是亚秒互通。
        let _ = adopted.stream.set_nodelay(true);
        let link_id = adopted.established.link_id;
        let (rd, wr) = adopted.stream.into_split();
        let (tx, rx) = mpsc::channel(LAN_LINK_QUEUE_FRAMES);
        let (serve_tx, serve_rx) = mpsc::channel(LAN_SERVE_QUEUE);
        let ops_wake = Arc::new(Notify::new());
        let queued = Arc::new(AtomicUsize::new(0));
        let reader = tokio::spawn(lan_read_pump(
            rd,
            peer.clone(),
            self_device.to_string(),
            generation,
            self.inbound_tx.clone(),
            self.fault_tx.clone(),
        ));
        let writer = tokio::spawn(lan_write_pump(
            wr,
            peer.clone(),
            generation,
            rx,
            serve_rx,
            Arc::clone(&ops_wake),
            Arc::clone(&queued),
            serve_ctx,
            self.fault_tx.clone(),
        ));
        self.links.insert(
            peer,
            LanLink {
                generation,
                tx,
                serve_tx,
                ops_wake,
                queued,
                last_rx: Instant::now(),
                link_id,
                reader,
                writer,
            },
        );
    }

    /// 全部链路**已入队未写出**的字节之和(= §10 那道每空间聚合预算量的是什么)。
    /// **只给用例看**:生产路径的唯一采样入口是 [`LanLinks::budget_probe`],多一个口子就
    /// 又能写出「预算读一次、候选读另一次」那种自相矛盾的组合(实现审一轮 M1)。
    #[cfg(test)]
    fn space_queued(&self) -> usize {
        self.links.values().map(|l| l.queued.load(AtomicOrdering::SeqCst)).sum()
    }

    /// **一次遍历**同时取「预算量」与「该摘谁」,每条链的计数器只读一次(实现审一轮 M1)。
    ///
    /// 分两次读会读出「预算超着 ∧ 候选全空」这种自相矛盾的组合——写泵在并发减账,第二次
    /// 读时它们可能已经排空,于是平手规则会挑中一条**队列早就空了的健康链**,本笔要修的病
    /// 换个入口就回来了。同一份采样里 `space > 0` 必蕴含「有一条 `queued > 0`」,故候选恒
    /// 有意义;每条只读一次也让比较关系是稳定全序(反复 load 同一个原子量,连排序都不作数)。
    ///
    /// 候选只从**真压着字节**的链里选;平手取 peer 字典序小者(与 [`LanLinks::peers`] 同一
    /// 条纪律:处置顺序必须可复现,否则同一场景两次跑摘掉不同的链)。返回的 `queued` 是采样
    /// 时的读数,供破坏性动作之前复核用。
    fn budget_probe(&self) -> (usize, Option<(String, u64, usize)>) {
        let mut space = 0usize;
        let mut best: Option<(String, u64, usize)> = None;
        for (peer, link) in &self.links {
            let queued = link.queued.load(AtomicOrdering::SeqCst);
            space += queued;
            if queued == 0 {
                continue;
            }
            let better = match &best {
                None => true,
                Some((bp, _, bq)) => queued > *bq || (queued == *bq && peer < bp),
            };
            if better {
                best = Some((peer.clone(), link.generation, queued));
            }
        }
        (space, best)
    }

    /// 入队一枚已封好的帧。**先记账再入队**:入队成功后写任务才会去减,故计数永不为负;
    /// 入队失败当场把这一笔销掉。
    ///
    /// **两道字节闸的受害者不是同一条**(L-d″ 第③笔修正):
    /// * 每链上界超了 = 本链自伤,摘本链天经地义;
    /// * **空间预算耗尽 = 摘积压最多的那条**,而不是碰巧此刻要发帧的这条。原先摘的是收
    ///   件人:四条堵死的链就足以把第五条**健康**链拆掉(它自己队列是空的、只想发一枚
    ///   Hello),而堵着的四条纹丝不动——那台健康对端因此永远建不成直连。选「占用最大者」
    ///   是因为这道闸释放的是**真占着的字节**:摘谁就腾出谁的队列,由占得最多的那条承担
    ///   (准确说是「交出那条队列的所有权并启动释放」——[`LanLink::drop`] 里 abort 两只
    ///   任务,内存不在本函数返回前归零);§10 op 追赶面那道**逻辑** admission 闸刻意相反
    ///   (由触发增长者自己降级),两者别互相类比。
    ///
    /// 腾挪循环的终止是结构性的:每一轮要么 break(预算已回到线下)、要么摘掉一条链(链数
    /// 严格减少)、要么因为「采样已过时」重来——而过时只可能源于**减账**(`queued` 在本函数
    /// 之外只减不增,唯一的加法在下面),减账总量以采样时的 `space` 为上界、每笔 ≥1 字节,
    /// 故重来的次数有限。本链是最重者时当场返回,故**本链永不在腾挪中被摘**。
    ///
    /// 按当前常量它至多摘一条(16 条链均摊 32 MiB 时最重那条 ≥2 MiB,而一枚 lan 帧封顶
    /// 1 MiB),写成循环是不让「预算不变量」去依赖 `LAN_FRAME_MAX / LAN_LINKS_MAX /
    /// LAN_SPACE_QUEUE_BYTES` 三者的算术关系——那三个数任意一个改了,循环照样把预算收回来。
    fn enqueue(&mut self, peer: &str, bytes: &Arc<Vec<u8>>) -> LanEnqueue {
        let len = bytes.len();
        let Some(link) = self.links.get(peer) else {
            return LanEnqueue::only(Err(LanSendErr::NoLink));
        };
        let generation = link.generation;
        if link.queued.load(AtomicOrdering::SeqCst) + len > LAN_LINK_QUEUE_BYTES {
            self.links.remove(peer);
            let why =
                format!("链路发送队列超字节上界({} MiB)", LAN_LINK_QUEUE_BYTES / 1024 / 1024);
            return LanEnqueue::only(Err(LanSendErr::Failed { generation, why }));
        }

        let mut evicted = vec![];
        loop {
            let (space, candidate) = self.budget_probe();
            if space + len <= LAN_SPACE_QUEUE_BYTES {
                break;
            }
            let (victim, victim_gen, sampled) = candidate
                .expect("同一份采样里预算超限 ⟹ 必有一条压着字节(len 已被每链闸限住)");
            budget_probe_hook();
            // **破坏性动作之前再采一次样**(实现审二轮 M):写泵一直在并发减账,采样到动手
            // 这一小段里可能已经①预算自己回到线下——那就一条都不该摘(**只查「候选是否归
            // 零」远远不够**:候选少 64 字节就足以让 `space + len` 回到线内,而它照样非零);
            // 或②候选变了——它未必还是最重的那条,按新样本重选才对。
            //
            // `continue` 不会空转:候选与上一份采样不同,必然是因为**有链减了账**(`queued`
            // 在本函数之外只减不增),而减账总量以采样时的 `space` 为上界、每笔 ≥1 字节,故
            // 重采次数有限;每一次 `remove` 又让链数严格减少。
            let (space_now, candidate_now) = self.budget_probe();
            if space_now + len <= LAN_SPACE_QUEUE_BYTES {
                break;
            }
            if candidate_now.map(|(p, _, q)| (p, q)) != Some((victim.clone(), sampled)) {
                continue;
            }
            let why = format!(
                "本空间 lan 发送预算耗尽({} MiB):摘的是积压最多的那条",
                LAN_SPACE_QUEUE_BYTES / 1024 / 1024
            );
            self.links.remove(&victim);
            if victim == peer {
                // 本链就是积压最多的那条:摘它 = 与每链闸同一条纪律,本次告负。
                let outcome = Err(LanSendErr::Failed { generation, why });
                return LanEnqueue { evicted, outcome };
            }
            evicted.push((victim, LanSendErr::Failed { generation: victim_gen, why }));
        }

        let link = self.links.get(peer).expect("腾挪从不摘本链:本链是最重者那支已提前返回");
        link.queued.fetch_add(len, AtomicOrdering::SeqCst);
        match link.tx.try_send(Arc::clone(bytes)) {
            Ok(()) => LanEnqueue { evicted, outcome: Ok(()) },
            Err(e) => {
                link.queued.fetch_sub(len, AtomicOrdering::SeqCst);
                let why = match e {
                    mpsc::error::TrySendError::Full(_) => {
                        format!("链路发送队列已满({LAN_LINK_QUEUE_FRAMES} 帧)")
                    }
                    mpsc::error::TrySendError::Closed(_) => "链路写端已收场".to_string(),
                };
                self.links.remove(peer);
                LanEnqueue { evicted, outcome: Err(LanSendErr::Failed { generation, why }) }
            }
        }
    }

    /// 交一笔图字节供流给某条链的写泵(§10 C′ 第 2 条,**非阻塞**:协调者绝不等 lan 腿)。
    ///
    /// 与 [`LanLinks::enqueue`] 的关键区别:描述符**不含字节**,故不动那两道字节预算——
    /// 它存在的全部意义就是让一张 32 MiB 的图不再以 128 枚 256 KiB 帧的形态一次性压进
    /// 8 MiB 的队列。字节由该链写泵一块一块地取、一块一块地写,峰值 = 一块。
    ///
    /// 供流一经交出就**绑死这个链路对象**(§6 代次契约之三):链路被替换/死亡时
    /// [`LanLink::drop`] 连 `serve_tx` 一起丢、写任务被 abort,在飞供流随之消失,绝不会
    /// 按对端重找「当前链」接着发。
    fn enqueue_serve(&mut self, peer: &str, serve: BlobServe) -> Result<(), LanSendErr> {
        let Some(link) = self.links.get(peer) else { return Err(LanSendErr::NoLink) };
        let generation = link.generation;
        match link.serve_tx.try_send(serve) {
            Ok(()) => Ok(()),
            Err(e) => {
                let why = match e {
                    mpsc::error::TrySendError::Full(_) => {
                        format!("图字节供流队列已满({LAN_SERVE_QUEUE} 笔)")
                    }
                    mpsc::error::TrySendError::Closed(_) => "链路写端已收场".to_string(),
                };
                self.links.remove(peer);
                Err(LanSendErr::Failed { generation, why })
            }
        }
    }

    /// 这枚事件属于当前那条链吗——是则顺带刷新活性时刻(§3)。迟到的旧代事件在此识别。
    fn touch(&mut self, peer: &str, generation: u64) -> bool {
        match self.links.get_mut(peer) {
            Some(link) if link.generation == generation => {
                link.last_rx = Instant::now();
                true
            }
            _ => false,
        }
    }

    /// 这条链此刻正是那一代吗(**不刷活性时刻**——死讯不是活着的证据,故它不走
    /// [`LanLinks::touch`])。
    fn holds(&self, peer: &str, generation: u64) -> bool {
        self.links.get(peer).is_some_and(|l| l.generation == generation)
    }

    /// 摘掉一条链(代次相符才摘;返回是否真摘到)。
    fn close(&mut self, peer: &str, generation: u64) -> bool {
        match self.links.get(peer) {
            Some(link) if link.generation == generation => {
                self.links.remove(peer);
                true
            }
            _ => false,
        }
    }

    /// 心跳一刻的两份名单(§3):静默超时该判死的 + 该发 Ping 的。
    fn beats(&self) -> (Vec<(String, u64)>, Vec<String>) {
        let silence = Duration::from_secs(LAN_SILENCE_SECS);
        let mut dead = vec![];
        let mut alive = vec![];
        for peer in self.peers() {
            let link = &self.links[&peer];
            if link.last_rx.elapsed() >= silence {
                dead.push((peer, link.generation));
            } else {
                alive.push(peer);
            }
        }
        (dead, alive)
    }

    /// LanReady 撤位:拆全部链路(§4 / 不变量 6)。代次号不回绕,故通道里可能残留的旧代
    /// 事件此后一律不匹配、[`LanLinks::touch`] 当场丢弃——不必清空通道。
    fn revoke(&mut self) {
        self.links.clear();
    }
}

/// 一枚 [`lan::LanWire`] 的上线字节(长度前缀 ‖ CBOR)。`Err` = 本机 bug:引擎的帧上界是
/// 256 KiB,远低于 lan 的 1 MiB([`lan::LAN_FRAME_MAX`]),故正常路径到不了这里。
fn lan_wire_bytes(wire: &lan::LanWire) -> Result<Arc<Vec<u8>>, String> {
    lan::frame_bytes(wire).map(Arc::new).map_err(|e| e.to_string())
}

/// 读端:**纯循环不进 select**(故 `read_exact` 不会被取消到半截)。逐帧:长度前缀
/// **分配前**过闸 → 读帧体 → 解码 → §3 地址校验 → 上抬。
async fn lan_read_pump(
    mut rd: tokio::net::tcp::OwnedReadHalf,
    peer: String,
    self_device: String,
    generation: u64,
    inbound: mpsc::Sender<LanInbound>,
    faults: mpsc::Sender<LanFault>,
) {
    let why = loop {
        let event = match read_lan_frame(&mut rd).await {
            Err(e) => break e,
            Ok(lan::LanWire::Frame { from, to, blob }) => {
                // `from` 由握手钉死、`to` 只许本机或广播(§3)。不符 = 这条链的对端不是
                // 当初验过签的那台,或实现漂移——**拒帧并断链**(比 §3 字面的「整帧拒收」
                // 严一档:链路的身份前提已经不成立,留着它没有意义)。
                if let Err(e) = lan::check_frame_addr(&peer, &self_device, &from, &to) {
                    break format!("帧地址不符:{e}");
                }
                LanEvent::Frame { from, to, blob }
            }
            Ok(lan::LanWire::Ping {}) => LanEvent::Ping,
            Ok(lan::LanWire::Pong {}) => LanEvent::Pong,
            // 建链后又来握手帧:协议错误。别给「先塞一枚坏帧、再补合法帧」留窗口
            // (同 L-b 审 M2 那条纪律,只是换到了数据面)。
            Ok(_) => break "建链后又收到握手帧".to_string(),
        };
        if inbound.send(LanInbound { peer: peer.clone(), generation, event }).await.is_err() {
            return; // 协调者已走(runtime 收场):没人可通报
        }
    };
    let _ = faults.send(LanFault { peer, generation, why }).await;
}

/// 一帧:`u32 BE 长度 ‖ CBOR`。长度前缀先过 [`lan::checked_body_len`] 再分配(L-b 审 M4:
/// u32 能声明 4 GiB,等读满再查上限已经晚了)。
async fn read_lan_frame(rd: &mut tokio::net::tcp::OwnedReadHalf) -> Result<lan::LanWire, String> {
    use tokio::io::AsyncReadExt;
    let mut prefix = [0u8; 4];
    rd.read_exact(&mut prefix).await.map_err(|e| format!("读长度前缀:{e}"))?;
    let n = lan::checked_body_len(prefix, lan::FramePhase::Established).map_err(|e| e.to_string())?;
    let mut body = vec![0u8; n];
    rd.read_exact(&mut body).await.map_err(|e| format!("读帧体:{e}"))?;
    lan::decode_wire(&body, lan::FramePhase::Established).map_err(|e| e.to_string())
}

/// 写端:协调者封好的帧 + **自己逐块驱动的图字节供流**(§10 C′ 第 3 条)+ **自己逐帧
/// 驱动的 op 追赶供流**(§6.1 消费面第一条腿,L-d″ 第②笔)。链路对象被丢弃 = 两根队列的
/// 发送端都没了 = 静默收场(那是协调者主动摘链/撤位,无需通报)。
///
/// 一轮的次序就是流控本身:
///   ① **控制/数据帧优先**——它们在**块边界**插队。一张 32 MiB 的图在千兆网上也要写好
///      几秒,Ping / Hello / ops 不该跟在它后面排队;一块 256 KiB ≈ 23ms,插队延迟就是
///      这个量级。
///   ② **新的供流描述符先接进来**(第②笔补的一手):blob 原先只从 ③ 的 select 里取,而
///      ops 腿一旦持续有活就永远走不到 ③——描述符会在通道里干等到 ops 追完。加了第二条
///      数据腿之后,「新图什么时候被看见」必须与「ops 忙不忙」无关。
///   ③ **两条数据腿按帧边界 1:1 轮转**(§6.1):blob 发下一块 / ops 发下一帧,一轮至多
///      一件。**发送窗口都 = 1**(取数 → 封帧 → `write_all` → 丢缓冲):峰值内存是一块
///      /一帧而不是整图/整段;`write_all` 的背压就是 TCP 的背压,协调者不参与。
///   ④ 都没活才睡在 select 上(控制帧 / 新供流 / ops 唤醒铃三根)。
///
/// 轮转粒度是**回合**不是帧:ops 的一次取数可能是空转(该 origin 对端已齐),它没往线上
/// 放一个字节,但**摸了一次库**——按帧记的话,一段长空转会让 blob 一块都发不出去。
///
/// 饿死面(诚实记账):控制帧持续不断时两条数据腿都会被一直推后。真实里控制帧稀疏(心跳
/// 30s / 事件驱动),且那种情形下链路本就在忙;换成「轮流各发一枚」会让控制面延迟随图长度
/// 抖动,不划算。
///
/// **连着几回 ops 就得让出一次**(276 记的那条消费方义务;实现审两轮各纠了我一次)。
/// 一轮 M1 推翻了我「LAN 侧不需要」的阴性结论:摸库这件事没有任何背压,而 `std::sync` 的
/// 锁不保证公平,16 条链一起扫足以把 UI 的写按住。二轮 M1 又推翻了我的第一版修法——
/// **只数空转不够**(loopback / 快接收方 / 大接收窗口下 `write_all` 可以立即 Ready,
/// `spawn_blocking(...).await` 也没有「必先 Pending 一次」的契约),而「灭 armed + 自己
/// 摇铃」根本不产生调度让出(`Notified` 已 ready 时 select 直接过)。
/// 故:**凡摸库的回合都计数**,到 [`OPS_TURNS_PER_CHECKPOINT`] 就 `yield_now` 真让出一次。
async fn lan_write_pump(
    mut wr: tokio::net::tcp::OwnedWriteHalf,
    peer: String,
    generation: u64,
    mut out: mpsc::Receiver<Arc<Vec<u8>>>,
    mut serves: mpsc::Receiver<BlobServe>,
    ops_wake: Arc<Notify>,
    queued: Arc<AtomicUsize>,
    serve_ctx: ServeCtx,
    faults: mpsc::Sender<LanFault>,
) {
    use tokio::io::AsyncWriteExt;
    /// 一枚已封好的帧写出去(队列记账只对协调者入队的那根做——供流的块从没进过队列)。
    macro_rules! write_frame {
        ($bytes:expr, $accounted:expr) => {{
            let bytes: Arc<Vec<u8>> = $bytes;
            match wr.write_all(&bytes).await {
                Ok(()) => {
                    if $accounted {
                        queued.fetch_sub(bytes.len(), AtomicOrdering::SeqCst);
                    }
                }
                Err(e) => break format!("写链路:{e}"),
            }
        }};
    }
    let mut active: Option<(BlobServe, u32)> = None;
    // ops 腿的四个位:**有没有活**(唤醒铃驱动;起手先看一眼,建链那一刻可能就有)、
    // **卡在哪一帧上**(封不出的那一段的段头;见 `ops_stuck`)、**这次唤醒已经连空转几回**
    // (见 `OPS_IDLE_SPINS_PER_WAKE`)、**上一回合归谁**(1:1 轮转)。
    let mut ops_armed = true;
    // `ops_stuck` = 封不出的那一帧的**段头**(origin + 首枚 origin_seq)。
    // **刻意不是一枚「这条腿死了」的永久位**(实现审 H1):卡住的是**那一段**,不是这条
    // 链——中转腿把同一段发出去并提交之后,计划的头就往前走了,这条健康的直连链没有任何
    // 理由跟着陪葬。故记段头:再取到**同一段**就退回去接着睡(不重复报、不自旋),取到
    // **别的段**说明头动过了,当场清位照发。
    let mut ops_stuck: Option<(String, i64)> = None;
    let mut ops_turns = 0usize;
    let mut last_turn_ops = false;
    let why = loop {
        // ① 控制/数据帧优先(块边界插队)。
        match out.try_recv() {
            Ok(bytes) => {
                write_frame!(bytes, true);
                continue;
            }
            // 链路对象已被丢弃(摘链/撤位/替换):这只任务马上会被 abort,先自行收场。
            Err(mpsc::error::TryRecvError::Disconnected) => return,
            Err(mpsc::error::TryRecvError::Empty) => {}
        }
        // ② 新的供流描述符先接进来(见上:不能只靠 ③ 的 select 取)。
        if active.is_none() {
            match serves.try_recv() {
                Ok(serve) => active = Some((serve, 0)),
                Err(mpsc::error::TryRecvError::Disconnected) => return,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
        }
        // ③ 两条数据腿 1:1:这一回合归谁。两边都有活时按上一回合翻面。
        let ops_ready = ops_armed;
        let turn = match (ops_ready, active.is_some()) {
            (false, false) => None,
            (true, false) => Some(true),
            (false, true) => Some(false),
            (true, true) => Some(!last_turn_ops),
        };
        if turn == Some(true) {
            last_turn_ops = true;
            ops_turns += 1;
            // **逐帧取数 + 逐帧自证身份,同一把锁里办完**(§6 ⑤ 的第七条出口,与 C′ 逐块
            // 自证同一把尺)。整段丢进 `spawn_blocking` 的理由同 C′:`Mutex<Connection>`
            // 是同步锁,16 条链的写泵一起堵在 tokio worker 上会把 runtime 占成阻塞等待者。
            let ctx = serve_ctx.clone();
            // **这条腿只服务定向 work,一个字都不碰 BROADCAST**(§6.2 ①)。本机 origin 的
            // 追赶恒由协调者消费:中转在场时是 relay 泵(权威完成腿),不在场时是
            // [`Deck::offline_broadcast_pump`] —— 两条都在发帧的同一处 fan-out 给全部合格
            // 直连腿。让每条链各自去抢 BROADCAST 的话,一枚窗口只有一个赢家,**别的对端
            // 那一帧就永远补不上**(游标已被赢家推过去了)。
            let target = peer.clone();
            // 测试栅栏:见 [`arm_ops_handoff_barrier`]。它**必须停在闭包里**——两把锁已放掉、
            // 产出还没交回等待方,那正是「凭据造出来了但没人来领」的那个窗口。
            #[cfg(test)]
            let gate = ops_handoff_gate();
            let turn = tokio::task::spawn_blocking(move || {
                let turn = ops_prepare(&ctx, &target);
                #[cfg(test)]
                ops_handoff_hold(gate);
                turn
            })
            .await;
            match turn {
                // 阻塞池那只任务垮了(锁中毒 / 池已关):走正常的死讯出口,别跟着 panic。
                Err(e) => break format!("ops 供流取数任务异常:{e}"),
                Ok(OpsTurn::Recast) => break "本机身份已换代:ops 供流中止并拆链".to_string(),
                // 没活:等下一次唤醒(铃带存量,故「响铃时我正在取数」不会丢)。
                Ok(OpsTurn::Idle) => ops_armed = false,
                // 空转:游标已在同一临界区里提交过了,这一回合没有字节要写。
                Ok(OpsTurn::Spun) => {}
                // **窗口被中转那条腿占着**(第④笔下半兑现的义务①):正常争用,睡下等唤醒
                // ——**绝不拆链**。这里与 `Idle` 处置相同而分成两条臂,是因为**唤醒的所有者
                // 不同**:`Idle` 等的是「这个对端有新活了」(三个生产入口摇铃),
                // `Occupied` 等的是「那一笔在飞的交回了窗口」。
                //
                // **293(第⑤笔)起两条都真有主**:后者由 §6.2 ④′ 的 `ops_changed` 接手
                // ——每槽一枚 `Arc<Notify>`,占用→空闲那一次转移由释放方摇,协调者扫出
                // 「有活 ∧ 在飞位空」的 target 再逐个选腿。**唯一刻意不摇的**是中转腿 Nack
                // 那条(摇了就是当场重发 = 热循环),它的续做所有者是心跳那一拍。
                Ok(OpsTurn::Occupied) => ops_armed = false,
                // 取数或提交真出错:**响亮收场拆链**(实现审 H2)。
                //
                // 原先这里是「报一次 advisory 然后灭 armed」,那等于把一个本机故障伪装成
                // 「此刻没活」,接着干等一枚未必再来的铃——真错误绝不能靠偶然信号续做。
                // 拆链是可恢复的:摘腿、重拨、重建,而库真的坏了的话中转腿照样会响亮。
                Ok(OpsTurn::Failed(why)) => break format!("ops 供流取数失败:{why}"),
                Ok(OpsTurn::Frame(frame, ticket)) => {
                    // 这一段的**段头**:封不出时拿它记「卡在哪」,取到别的段就说明头动过了。
                    // 空帧走的是 `frame: None` 那一支,故这里恒非空(实现审二轮 L1:原来写
                    // 的是 `map_or(0, …)`,那是给一个不可能的情形悄悄编一个 seq)。
                    let first = frame.ops.first().expect("取数产出的帧恒非空").origin_seq;
                    let head = (frame.origin.clone(), first);
                    if ops_stuck.as_ref() == Some(&head) {
                        // 还是那一段(没人推进过它):退回去接着睡,**不重复报也不自旋**。
                        drop(ticket);
                        ops_armed = false;
                        continue;
                    }
                    ops_stuck = None;
                    let msg = Msg::Ops { origin: frame.origin, ops: frame.ops };
                    match seal_lan_frame(
                        &serve_ctx.k_acc,
                        &serve_ctx.account_id,
                        &serve_ctx.device_id,
                        &peer,
                        &msg,
                    ) {
                        // 封不出 = 这一帧越过了 lan 腿的线上上限([`lan::LAN_FRAME_MAX`])。
                        // 单条超大 op 独占一帧时它真能到 1 MiB(§10 六轮 M4),而回滚**不推进
                        // 游标** —— 下一回合取到的还是同一段,照发就是死自旋。
                        //
                        // 记**段头**而不是判这条链死(实现审 H1):这一段过不去,不代表这条
                        // 链过不去——中转腿把它发出去并提交之后,头一动这里就自动接着供。
                        Err(e) => {
                            serve_ctx.warn(format!(
                                "局域网 ops 帧封不出({e});这一段改由中转腿供,本链跳过它"
                            ));
                            ops_stuck = Some(head);
                            ops_armed = false;
                        }
                        Ok(bytes) => {
                            // 测试栅栏:见 [`arm_ops_barrier`]。生产构建里这两行根本不存在。
                            #[cfg(test)]
                            ops_barrier().await;
                            write_frame!(bytes, false);
                            // **写成了才提交**(§6.1 十轮契约):失败 / 断链 / 换代一律走
                            // `rollback`,而那是 [`OpsTicket`] 的 `Drop` 兜底的事。
                            //
                            // 提交不上 = 在飞位已经不是这一笔了 = 所有权不变量破了(合法的
                            // 「work 整只没了」在 `settle` 里回的是 `Ok`)。**响亮收场**,不
                            // 降级成一枚静默的位:帧已经出门,而游标没动。
                            if let Err(e) = ticket.commit() {
                                break format!("ops 供流凭据交不回:{e}");
                            }
                        }
                    }
                }
            }
            // **每 N 回合真让出一次**(实现审二轮 M1)。上一版是「灭 armed + 给自己摇铃」,
            // 而 `Notified` 已 ready 时 select 根本不保证让出——那只是把计数分了段,调度上
            // 什么也没发生。`yield_now` 才有契约:它必先回一次 `Pending`,协调者与别的任务
            // 因此拿得到真实的检查点,那把 `Mutex<Connection>` 也才有机会易手。
            if ops_turns >= OPS_TURNS_PER_CHECKPOINT {
                ops_turns = 0;
                tokio::task::yield_now().await;
            }
            continue;
        }
        // ③b 供流的下一块。
        if let Some((serve, idx)) = active.take() {
            last_turn_ops = false;
            // **逐块自证身份 + 取数,同一把锁里办完**(§6 ⑤ 那条纪律的第六条出口;实现
            // 审 M1)。C′ 之后块是写泵**自己封**的,而 `k_acc` 是建链那一刻的快照——一张
            // 32 MiB 的图要写好几秒,纪元压实恰在其间完成的话,后续每一块都是拿旧身份封
            // 的帧;换代不保证有人 poke 控制通道(压实是库自己悄悄换的),故这一问必须真
            // 读库,且与会话循环、离线泵、pre-auth 握手同一把尺([`identity_still_current`])。
            // 两次分开取锁的话,「查完身份、换代提交、再读块」这个窄窗会漏一块过去。
            //
            // **整段丢进 `spawn_blocking`**(实现审 M2):`Mutex<Connection>` 是同步锁,16
            // 条链的写泵一起堵在 tokio worker 上,遇到 UI 长写 / VACUUM / 压实就能把 runtime
            // 的 worker 占成阻塞等待者,连心跳和死讯消费都跟着卡。搬到阻塞池里,worker 只
            // 等一个 join;每块一次任务跳转,相对 256 KiB 的 I/O 可忽略。
            //
            // 取数**当场放锁**:绝不跨 socket await 持 DB 锁,也不为慢链持跨整图的 read
            // transaction(那会长期钉住 WAL)。行中途被删 → 沿同 transfer 回 BlobDeny,让
            // 收端立刻回清单另寻来源,而不是干等 60s stale。
            //
            // **残余(诚实记账)**:放锁之后到 `write_all` 之前仍有一个 **≤1 帧**的窗口
            // ——要消掉它就得跨 socket 写持库锁,那是 §10 明令禁止的。协调者入队的帧本来
            // 也有同一个残余(封帧早于换代提交),故这不是新增面。
            let ctx = serve_ctx.clone();
            let bound = serve.clone();
            let read = tokio::task::spawn_blocking(move || {
                let conn = ctx.db.lock().expect("db mutex poisoned");
                if !identity_still_current_conn(
                    &conn,
                    &ctx.account_id,
                    &ctx.device_id,
                    &ctx.k_acc,
                    &ctx.device_seed,
                ) {
                    return Err(None); // 换代:调用方拆链
                }
                read_blob_chunk(&conn, &bound, idx).map_err(Some)
            })
            .await;
            let read = match read {
                // 阻塞池那只任务垮了(锁中毒 / 池已关):**走正常的死讯出口**而不是跟着
                // panic(实现审二轮 L2)——writer 一 panic 就跳过 `LanFault`,摘腿与诊断
                // 得等下一次 Ping 或入队失败才发现,晚一拍。
                Err(e) => break format!("供流取数任务异常:{e}"),
                Ok(Err(None)) => break "本机身份已换代:供流中止并拆链".to_string(),
                Ok(Err(Some(e))) => Err(e),
                Ok(Ok(v)) => Ok(v),
            };
            let msg = match read {
                Ok(Some(data)) => Msg::BlobChunk {
                    image_id: serve.image_id.clone(),
                    transfer: serve.transfer.clone(),
                    idx,
                    last: serve.is_last(idx),
                    data,
                },
                Ok(None) => Msg::BlobDeny {
                    image_id: serve.image_id.clone(),
                    transfer: serve.transfer.clone(),
                },
                Err(e) => {
                    serve_ctx.warn(format!("读 {} 的第 {idx} 块失败:{e}", serve.image_id));
                    Msg::BlobDeny {
                        image_id: serve.image_id.clone(),
                        transfer: serve.transfer.clone(),
                    }
                }
            };
            let more = matches!(msg, Msg::BlobChunk { last: false, .. });
            match seal_lan_frame(
                &serve_ctx.k_acc,
                &serve_ctx.account_id,
                &serve_ctx.device_id,
                &serve.to,
                &msg,
            ) {
                // 封不出 = 本机 bug(块恒 ≤256 KiB,远低于 lan 的 1 MiB 帧上界):这一笔
                // 就此作废,收端等 stale 换来源;链路本身没毛病,不断。
                Err(e) => serve_ctx.warn(format!("局域网供流帧封不出({e})")),
                Ok(bytes) => {
                    write_frame!(bytes, false);
                    // 测试栅栏:见 [`arm_serve_barrier`]。生产构建里这两行根本不存在。
                    #[cfg(test)]
                    serve_barrier(idx).await;
                    if more {
                        active = Some((serve, idx + 1));
                    }
                }
            }
            continue;
        }
        // ④ 都空:睡着等。三根都是取消安全的,select 丢掉的那些不丢消息——`Notified` 被
        //    丢弃时若已收下那一声,tokio 会把它交回铃上(故不是「唤醒丢在 select 里」)。
        //    取到的帧**出了 select 块再写**:select 的分支 future 在处置块跑完前一直借着
        //    `out`,把 `write_all` 塞进臂里等于给借用检查器添无谓的难题。
        let mut pending: Option<Arc<Vec<u8>>> = None;
        tokio::select! {
            frame = out.recv() => match frame {
                Some(bytes) => pending = Some(bytes),
                None => return,
            },
            serve = serves.recv() => match serve {
                Some(serve) => active = Some((serve, 0)),
                None => return,
            },
            // 铃只说「去看一眼」:该发什么、发到哪一段,恒由引擎槽里那份计划说了算。
            // 终局之后照收这一声(`ops_dead` 那道闸在 ③ 的 `ops_ready` 上,一处一判):
            // 在这里再加一道 `if !ops_dead` 只是把同一个判据抄第二遍,而它**没有任何变异
            // 能证伪**——摘掉它,醒来的那一轮照样被 `ops_ready` 挡回 select。
            () = ops_wake.notified() => ops_armed = true,
        }
        if let Some(bytes) = pending {
            write_frame!(bytes, true);
        }
    };
    // 死讯走**独立通道**(§10):数据面此刻可能正满着,而这声正是最不能等的一声。
    let _ = faults.send(LanFault { peer, generation, why }).await;
}

impl ServeCtx {
    /// 供流泵的诊断出口:只写 advisory 面的 `lan_warning`,**绝不占正确性面的 `error`
    /// 槽**(L-c2b 实现审 M3 的既有纪律)。
    fn warn(&self, text: String) {
        set_status(&self.status, &self.events, |s| s.lan_warning = Some(text));
    }
}

// ---- op 追赶供流的消费面:LAN 那条腿(lan-direct-plan §6.1;L-d″ 第②笔) ----------------

/// 连着几回 ops 之后必须**协作让出一次**(见 [`lan_write_pump`] 抬头)。
///
/// **计的是回合不是帧**(实现审二轮 M1):我上一版只数空转,理由是「出帧那一路有
/// `write_all` 的 TCP 背压」——**最坏情形下不成立**:loopback、快接收方、大接收窗口下
/// `write_all` 可以立即 Ready。同理 `spawn_blocking(...).await` 也没有「必先 Pending 一次」
/// 的契约。凡是摸库的回合都得计数,让出才覆盖得住那把库锁。
///
/// 8 回 × 每回至多 64 次索引探针 ≈ 一次 40 ms 的库占用,与有界 Hello 那档同量级。它是
/// **两个公平检查点之间**的工作量上界,不是「一份计划最多扫多少」(后者由固定快照 +
/// 游标前进管)。
const OPS_TURNS_PER_CHECKPOINT: usize = 8;

/// 计划表的锁。**唯一定义在 [`ops_serve::lock_ops`]**——第⑤笔起引擎侧也要取这把锁
/// (§6.2 ⑤(a)),中毒政策只许有一份。
use super::ops_serve::lock_ops;

/// 一回合 ops 供流的产出。
enum OpsTurn {
    /// 这份 work 此刻没活(或压根不在表里):灭 armed,等下一次唤醒。
    Idle,
    /// 空转 —— 段已到本机水位 / 该 origin 对端已齐 / 跳过预算用尽。游标**已在同一个临界
    /// 区里提交过**(空转照样要推进,否则下一回合又从同一处重跑)。
    Spun,
    /// 有帧要发;凭据由 [`OpsTicket`] 攥着。
    Frame(ops_serve::OpsFrame, OpsTicket),
    /// **这份 work 的窗口被另一条腿占着**(L-d″ 第④笔下半兑现的第②笔义务①)。同一个
    /// target 的 `PeerWork` 只有一个窗口,而所有权表给了两种执行态,故两条腿同时盯一个
    /// 对端时后到的那条必然撞它 —— **正常争用不是故障**。
    ///
    /// 两条腿的处置不同:relay 泵**跳到下一个 target**(§6.2 ⑨-4 ③),LAN 泵灭 armed
    /// 睡下(它只服务这一个对端,没有「下一个」可跳)。
    Occupied,
    /// 本机身份已换代(§6 ⑤ 第七条出口):拆链。
    Recast,
    /// 取数出错(本机问题):**响亮收场拆链**(实现审 H2)。把它降级成一枚 advisory + 一次
    /// 干等,等于让本机故障去指望一枚未必再来的铃。
    Failed(String),
}

/// 在飞那一笔的凭据把手 —— **RAII**(§6.1「凭据必须回得来」,第①笔实现审三轮 ③)。
///
/// 我原先以为「LAN 链死即丢执行态」意味着这条路不需要回滚,判错了:**只有整只 `EngineSlot`
/// / `PeerWork` 一起 retire 时才不需要**。普通链死时逻辑 work 还住在引擎槽里,凭据随写任务
/// 一起裸丢的话在飞位就**永久占着**,该对端的 ops 供给彻底停摆。
///
/// 故凭据从不裸走:构造在 [`ops_prepare`] 的**阻塞闭包内部**(写泵被 abort 时 tokio 会把
/// 阻塞任务的产出丢掉,`Drop` 照样跑),`write_all` 成功交 [`OpsTicket::commit`],其余一切
/// 出路——封不出 / 写失败 / 断链 / 换代 / 撤位 abort——都由 `Drop` 交回 `rollback`。
struct OpsTicket {
    ctx: ServeCtx,
    target: String,
    /// `None` 只出现在 `commit` 之后:**一枚凭据至多交回一次**。
    token: Option<ops_serve::CommitToken>,
}

impl OpsTicket {
    /// 这枚凭据服务的逻辑目的地(`BROADCAST` 或设备 id)。
    fn target(&self) -> &str {
        &self.target
    }

    fn commit(mut self) -> Result<(), String> {
        let token = self.token.take().expect("凭据在 commit 之前不可能已交回");
        Self::settle(&self.ctx, &self.target, token, true)
    }

    /// **回滚,但不摇铃**(中转腿 Nack 专用;见 [`Ctx::on_nack`] 里那段理由)。
    ///
    /// 语义与 `Drop` 走的那条完全一样(游标一步不动、work 原样留着),差别只有「不通知
    /// 协调者」这一件 —— 因为这条路的续做所有者是**心跳**,当场重泵就是热循环。
    ///
    /// 消费掉 token 之后随后的 `Drop` 自然早返回,故**不会再补摇一次**。
    fn rollback_quiet(mut self) -> Result<(), String> {
        let token = self.token.take().expect("凭据在回滚之前不可能已交回");
        let mut w = lock_ops(&self.ctx.ops);
        // 与 [`Self::settle`] 同一条:整只 work 已随撤位/换代消失 = 无需交也无处交。
        let Some(work) = w.work_mut(&self.target) else { return Ok(()) };
        work.rollback(token)
    }

    /// 交回凭据。**work 已经不在表里 = 无需交也无处交**(整只 retire / 驱逐后重建的那一
    /// 档,所有权表里唯一不需要回滚的情形),不当成错。
    ///
    /// **只有真发生 `occupied → free` 那一次状态转移才摇铃**(§6.2 ④′「通知时机」):
    /// * work 已不在表里 → 没有位子被空出来,也没有消费者能领它 → **不摇**;
    /// * `commit`/`rollback` 返回 `Err`(在飞位其实没释放)→ **更不许谎报**;
    /// * 正常路径消费掉 token 之后 `self.token` 已是 `None`,故随后的 `Drop`
    ///   直接早返回,**不会报第二次**——这是结构事实,不是「记得别重复调」。
    ///
    /// 摇铃**放在锁外**(④′-4:守住「持 work 时不得再做别的」)。
    fn settle(
        ctx: &ServeCtx,
        target: &str,
        token: ops_serve::CommitToken,
        commit: bool,
    ) -> Result<(), String> {
        {
            let mut w = lock_ops(&ctx.ops);
            let Some(work) = w.work_mut(target) else { return Ok(()) };
            if commit {
                work.commit(token)?
            } else {
                work.rollback(token)?
            }
        }
        ctx.ops_changed.notify_one();
        Ok(())
    }
}

impl Drop for OpsTicket {
    fn drop(&mut self) {
        let Some(token) = self.token.take() else { return };
        // **失败必须出声**(实现审 H3 同族):合法的那一档——整只 work 已随撤位/换代消失
        // ——在 [`OpsTicket::settle`] 里回的是 `Ok`,故走到这里的 `Err` 只剩一种解释:在飞位
        // 已经不是这一笔了,即所有权不变量破了。`Drop` 里没有响亮收场的出路(panic 会在
        // 取消展开时直接 abort 进程),故退而求其次:占 advisory 面报出来,别静默咽下。
        if let Err(e) = Self::settle(&self.ctx, &self.target, token, false) {
            self.ctx.warn(format!("ops 供流凭据回滚失败(在飞位已不是这一笔):{e}"));
        }
    }
}

/// 取一回合 ops 供流:**自证身份 → 取数 → 武装凭据,同一把库锁里办完**。
///
/// 身份那一问必须真读库(§6 ⑤ 第七条出口,与 C′ 逐块自证同一把尺 [`identity_still_current_conn`]):
/// `k_acc` 是建链那一刻的快照,而纪元压实是库自己悄悄换的、**没人 poke 控制通道**,一段长
/// 追赶跨过换代之后,后面每一帧都是拿旧身份封的。分两次取锁的话,「查完身份、换代提交、
/// 再取数」这个窄窗会漏一帧过去。
///
/// **锁序 db → work 是全仓唯一一处同时持两把锁的地方**(第④笔的 relay 泵要提交游标时应复用
/// 本函数这条次序),故不存在反序取锁的对家。
fn ops_prepare(ctx: &ServeCtx, target: &str) -> OpsTurn {
    let conn = ctx.db.lock().expect("db mutex poisoned");
    if !identity_still_current_conn(
        &conn,
        &ctx.account_id,
        &ctx.device_id,
        &ctx.k_acc,
        &ctx.device_seed,
    ) {
        return OpsTurn::Recast;
    }
    let mut works = lock_ops(&ctx.ops);
    // 取数次数的可观测面(仅测试):「没活就灭 armed」这条规则在线上字节、状态面、武装
    // 发号器三格全同形,只有「还在不在反复摸库」分得开(实现审 M2)。
    #[cfg(test)]
    works.note_probe();
    let Some(work) = works.work_mut(target) else { return OpsTurn::Idle };
    match work.prepare_next(&conn) {
        Err(e) => OpsTurn::Failed(e),
        Ok(ops_serve::Prepare::Idle) => OpsTurn::Idle,
        Ok(ops_serve::Prepare::Occupied) => OpsTurn::Occupied,
        Ok(ops_serve::Prepare::Ready(p)) => match p.frame {
            // 空转:没字节可写,但游标得往前走,就在这个临界区里办完——凭据不出门,也就
            // 没有「空转的凭据谁来回滚」这种形。
            None => match work.commit(p.token) {
                Ok(()) => OpsTurn::Spun,
                Err(e) => OpsTurn::Failed(e),
            },
            Some(frame) => OpsTurn::Frame(
                frame,
                OpsTicket { ctx: ctx.clone(), target: target.to_string(), token: Some(p.token) },
            ),
        },
    }
}

/// 封一枚要走 lan 腿的帧:**同一套密文帧,只换运输管子**(§0)——同 `K_acc`、同域子钥、
/// 同 AAD 五元组,外面只多一层 [`lan::LanWire::Frame`] 供收端重构 AAD。故广播帧封一次
/// 就能投给每条链(AAD 的 `to` 恒是信封上那个)。
///
/// 协调者([`Deck::seal_for_lan`])与 LAN 供流泵共用这一处:C′ 之后块是写泵自己造的,
/// 两边各写一遍封帧就会长出第二处真相源。
fn seal_lan_frame(
    k_acc: &[u8; 32],
    account_id: &str,
    self_device: &str,
    to: &str,
    msg: &Msg,
) -> Result<Arc<Vec<u8>>, String> {
    let blob = crypto::seal_msg(
        k_acc,
        &FrameAddr { account_id, from_device: self_device, to, domain: msg_domain(msg) },
        msg,
    );
    lan_wire_bytes(&lan::LanWire::Frame {
        from: self_device.to_string(),
        to: to.to_string(),
        blob,
    })
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
    allow_boot_source: bool,
    /// 运行时级引擎槽的借用(L-c2a:引擎**不随会话生灭**,见 [`EngineSlot`])。
    /// 槽空 = 引导中(op/ctl/blob 帧整帧丢弃,见模块注释)。
    engine: &'a mut EngineSlot,
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
    /// 中转腿的会话态(信封序号 / 在飞回执 / 通告面的每会话位):借给 [`Deck`] 用。
    sess: RelaySession,
    /// 本 `run` 在 app 级监听器上的席位(见 [`AdmitSeat`])。会话只在**引导刚完成、
    /// 引擎首次装配**那一跳用它对齐准入表,别处不碰。
    seat: Option<AdmitSeat>,
}

/// 一条已鉴权 WSS 会话独有的状态(**断线即弃**)。刻意与 [`Ctx`] 的引导/配对编排分开:
/// 它是 [`RelayLeg::Up`] 的载荷,故「中转腿在场」与「这些位子存在」是同一件事。
struct RelaySession {
    /// 信封序号(`ClientMsg::Send.n`)与在飞回执的归属表。
    n: u64,
    tracked: HashMap<u64, Tracked>,
    ad: AdFace,
}

/// 一枚在飞信封的归属(`tracked` 的值)。
///
/// **`target` 由 [`Deck::send_envelope`] 一处存,不靠各 `Sent` 变体碰巧带没带 `to`**
/// (codex 实现审二轮 M1)。我上一轮写的 `receipt_target(&Sent)` 就漏了**定向 Hello /
/// Want** —— 它们记成不带 target 的 `ReconcileCtl`,而它们的 Ack/`busy` 同样证明服务端
/// 已经过了那台的 registry 检查。按变体去认 target,每加一个变体就多一次「这次记得带上」;
/// 按**发送入口**去认,`Other` 之类的定向帧也一并覆盖到,漏不了。
struct Tracked {
    sent: Sent,
    /// 这一枚投给谁。`BROADCAST` 记 `None` —— 一枚广播帧的回执证明不了任何**具体**一台
    /// 在不在册。
    target: Option<String>,
}

/// 通告面(§2)的每会话位。**全是「每会话一次」的防刷屏/防回声位,不是数据事实**
/// (数据事实在 `sync_meta` 的 `lan_peer:*` 与 `lan_ad_seq` 里,跨会话保留——L-c2a 那条线)。
struct AdFace {
    /// 归属(`lan_ad_owner`)本轮对齐成功了吗。false = **整个通告面关掉**:不注入本机
    /// 通告、不吸收对端通告(二审 M1:归属半态下发通告会让序号复用或倒退,而缓存里可能
    /// 还留着上一代身份的记录);中转的水位同步一切照常。
    ready: bool,
    /// 本机通告已停用(序号到 `u64::MAX`,或计数器落库失败):此后 Hello 恒不带 `lan`,
    /// **中转同步照常**——水位互补是正确性面,通告只是直连的加速面,不许互相拖累。
    off: bool,
    /// 本会话已封发的 `(通告序号, 那一枚号所配的 listen)`;`None` = 本会话还没发过 Hello。
    ///
    /// **序号绑内容**(§2 的三时机;L-c2b 二审留给 L-c2c 的必守项):首次封发即递增并
    /// 落库,其后**只在 listen 未变时**重用——监听端口一变(L-c3 绑口/重绑)就必须换号,
    /// 否则「同一个序号配两份内容」,而收端「更小不收」会把新落点长期挡在门外。收到对端
    /// Hello 绝不递增(那会让「按 peer + 序号去重」永远拦不住自激回声)。
    published: Option<(u64, Option<lan::LanListen>)>,
    /// 本会话已按**触发②**(对端在线而本机缺它公钥)向哪些对端问过一帧(§2 限频)。
    /// 只服务触发②——它没有「一次性跃迁」可依,不限频就会每来一次 `Peer{online}` 发一帧;
    /// 触发① 的去重靠首见跃迁本身([`lan_ad_reply_needed`])。
    asked: HashSet<String>,
    /// 本会话已报过**通告面诊断**(形态不合 / 缓存读不动)的对端:每对端一次,恶意对端
    /// 灌畸形通告刷不动状态面。
    warned: HashSet<String>,
    /// 本会话已就**定向 Hello**(§2 的隐式索要)应答过的对端:每对端至多一帧。
    /// 非对称缓存靠它收敛,又靠它终止(双方同时索要也只各答一次)。
    answered: HashSet<String>,
    /// 本会话已报过**同 id 异钥**的对端。刻意与 [`Self::warned`] 分开:合用一个集合的话,
    /// 对端先发一枚畸形通告(记下诊断)、再发冲突钥,那声**安全告警**就被自己先前的诊断
    /// 吞掉了。
    conflict_reported: HashSet<String>,
}

#[cfg(test)]
thread_local! {
    /// 一次性栅栏的两枚哨子(到位 / 放行),见 [`arm_dispatch_barrier`]。
    static DISPATCH_BARRIER: std::cell::RefCell<Option<(Arc<Notify>, Arc<Notify>)>> =
        const { std::cell::RefCell::new(None) };
}

/// 装一枚**一次性栅栏**(仅测试构建):装上之后,下一次 [`Deck::dispatch`] 会在**入队之前**
/// 停住。用来在「引擎已产出待发帧、还没入队」这一刻把换链事件经**正式 handoff 通道**送达,
/// 验的正是「换链事件已经就绪却插不进去」——协调者 run-to-completion(§6 代次契约之一,
/// 实现审 M1 点名不许拿「单协调者造不出交错」当降级理由)。
///
/// 线程局部而不是全局静态:`#[tokio::test]` 是单线程 runtime,协调者任务与用例同在一根线程
/// 上,故线程局部天然按用例隔离——全局静态会被并跑的别的用例顺手吞掉。
#[cfg(test)]
fn arm_dispatch_barrier() -> (Arc<Notify>, Arc<Notify>) {
    let reached = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    DISPATCH_BARRIER.with(|b| *b.borrow_mut() = Some((reached.clone(), release.clone())));
    (reached, release)
}

#[cfg(test)]
thread_local! {
    /// 断网期定向 Hello 的间隔覆盖位,见 [`lan_hello_period`]。
    static LAN_HELLO_PERIOD: std::cell::Cell<Option<Duration>> =
        const { std::cell::Cell::new(None) };
}

/// 断网期定向 Hello 的间隔(§5 = [`LAN_OFFLINE_HELLO_SECS`])。**测试可压短**:要验的性质是
/// 「这只计时器在从没连上过的那一路也武装着」,拿真 60 秒去验等于不验。同栅栏,用线程局部而
/// 非全局静态(单线程 runtime 下协调者与用例同线程,全局静态会串进并跑的别的用例)。
fn lan_hello_period() -> Duration {
    #[cfg(test)]
    if let Some(d) = LAN_HELLO_PERIOD.with(|p| p.get()) {
        return d;
    }
    Duration::from_secs(LAN_OFFLINE_HELLO_SECS)
}

/// 覆盖位的 RAII 把手(实现审三轮 M1):测试线程会**顺序跑多个用例**,线程局部不复位就把
/// 300ms 传染给后面落到同一根线程上的 lan 用例——那正是首轮抓到过的「额外 Hello 帮收敛测试
/// 背书」型假绿的来路。改回原值这件事不能靠用例末尾记得写(panic 就漏),故绑在 `Drop` 上。
#[cfg(test)]
struct HelloPeriodGuard(Option<Duration>);

#[cfg(test)]
impl HelloPeriodGuard {
    fn set(d: Duration) -> HelloPeriodGuard {
        HelloPeriodGuard(LAN_HELLO_PERIOD.with(|p| p.replace(Some(d))))
    }
}

#[cfg(test)]
impl Drop for HelloPeriodGuard {
    fn drop(&mut self) {
        let prev = self.0;
        LAN_HELLO_PERIOD.with(|p| p.set(prev));
    }
}

#[cfg(test)]
thread_local! {
    /// 供流泵的一次性栅栏:`(停在第几块之后, 到位, 放行)`。见 [`arm_serve_barrier`]。
    static SERVE_BARRIER: std::cell::RefCell<Option<(u32, Arc<Notify>, Arc<Notify>)>> =
        const { std::cell::RefCell::new(None) };
}

/// 装一枚**一次性栅栏**(仅测试构建):LAN 写泵**写完第 `after_chunk` 块之后**停住,直到
/// 放行。
///
/// 为什么要有它(264 实现审 L2):「行中途消失 / 身份换代 / 控制帧插队」三只用例都要在
/// **供流跑到一半**时动手,而首版靠的是「loopback 的 socket 缓冲装不下整图」——不同系统
/// 的缓冲自动调优能力不同,本机实测就吞得下 2 MiB,于是那几只用例在别的机器上会变成
/// 「整图早写完了」的机器相关失败。有了栅栏,停在哪一块是确定的,图也不必再堆到 9 MiB。
///
/// 线程局部而非全局静态,理由同 [`arm_dispatch_barrier`](`#[tokio::test]` 是单线程
/// runtime,写泵任务与用例同在一根线程上;取数虽走阻塞池,但栅栏在写泵这一侧)。
#[cfg(test)]
fn arm_serve_barrier(after_chunk: u32) -> (Arc<Notify>, Arc<Notify>) {
    let reached = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    SERVE_BARRIER
        .with(|b| *b.borrow_mut() = Some((after_chunk, reached.clone(), release.clone())));
    (reached, release)
}

#[cfg(test)]
thread_local! {
    /// ops 供流泵的一次性栅栏:`(到位, 放行)`。见 [`arm_ops_barrier`]。
    static OPS_BARRIER: std::cell::RefCell<Option<(Arc<Notify>, Arc<Notify>)>> =
        const { std::cell::RefCell::new(None) };
}

/// 装一枚**一次性栅栏**(仅测试构建):LAN 写泵封好下一枚 ops 帧、**还没写出去**时停住。
///
/// 停在这一刻是刻意的:第②笔要验的核心契约是「凭据必须回得来」,而它唯一可证伪的时刻就是
/// **已武装、未落地**——此时把链路摘掉(写任务被 abort),在飞位必须由 [`OpsTicket`] 的
/// `Drop` 交回去。停在写之后就只剩「已提交」一种终局,那条契约根本观测不到。
///
/// 线程局部而非全局静态,理由同 [`arm_serve_barrier`]。
#[cfg(test)]
fn arm_ops_barrier() -> (Arc<Notify>, Arc<Notify>) {
    let reached = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    OPS_BARRIER.with(|b| *b.borrow_mut() = Some((reached.clone(), release.clone())));
    (reached, release)
}

/// 「凭据已造出、还没人来领」那个窗口的一次性栅栏(实现审 M2)。
///
/// 与 [`arm_ops_barrier`] 停的不是同一处:那一枚停在写泵手上(产出已交回),只证得了
/// **已交付的**凭据会被 `Drop` 收走;把凭据构造挪到 `await` 之后它照样绿。真正要证的是
/// **阻塞闭包已经造出凭据、而等待方在拿到它之前就被 abort** —— 此时产出由 tokio 丢弃,
/// `OpsTicket::drop` 是唯一的回滚出路。
///
/// 故这一枚是**同步**的、且住在闭包里:栅栏对象由写泵在自己线程上取出(线程局部,同
/// [`arm_serve_barrier`] 的理由)再 move 进闭包 —— 阻塞池那根线程读不到线程局部。
/// 停的位置在 [`ops_prepare`] 返回**之后**:两把锁必须先放掉,否则用例连断言都做不了。
#[cfg(test)]
struct OpsHandoffGate {
    reached: std::sync::mpsc::SyncSender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
thread_local! {
    static OPS_HANDOFF_BARRIER: std::cell::RefCell<Option<OpsHandoffGate>> =
        const { std::cell::RefCell::new(None) };
}

/// 装栅栏,返回 `(到位, 放行)` 两端给用例。
#[cfg(test)]
fn arm_ops_handoff_barrier() -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::SyncSender<()>) {
    let (reached_tx, reached_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    OPS_HANDOFF_BARRIER.with(|b| {
        *b.borrow_mut() = Some(OpsHandoffGate { reached: reached_tx, release: release_rx })
    });
    (reached_rx, release_tx)
}

/// 写泵自己线程上取栅栏(取走即卸,故只停一次)。
#[cfg(test)]
fn ops_handoff_gate() -> Option<OpsHandoffGate> {
    OPS_HANDOFF_BARRIER.with(|b| b.borrow_mut().take())
}

/// 闭包里停一次(阻塞池线程上,故用同步通道)。
#[cfg(test)]
fn ops_handoff_hold(gate: Option<OpsHandoffGate>) {
    if let Some(g) = gate {
        let _ = g.reached.send(());
        let _ = g.release.recv();
    }
}

/// ops 栅栏的消费点(装了才停,停一次就卸)。
#[cfg(test)]
async fn ops_barrier() {
    let gate = OPS_BARRIER.with(|b| b.borrow_mut().take());
    if let Some((reached, release)) = gate {
        reached.notify_one();
        release.notified().await;
    }
}

/// 供流栅栏的消费点(块序号对上才停,停一次就卸)。
#[cfg(test)]
async fn serve_barrier(idx: u32) {
    let gate = SERVE_BARRIER.with(|b| {
        let hit = b.borrow().as_ref().is_some_and(|(k, _, _)| *k == idx);
        if hit { b.borrow_mut().take() } else { None }
    });
    if let Some((_, reached, release)) = gate {
        reached.notify_one();
        release.notified().await;
    }
}

/// 栅栏的消费点(装了才停,停一次就卸)。
#[cfg(test)]
async fn dispatch_barrier() {
    let gate = DISPATCH_BARRIER.with(|b| b.borrow_mut().take());
    if let Some((reached, release)) = gate {
        reached.notify_one();
        release.notified().await;
    }
}

/// 建连 + 挑战应答鉴权(§4),**期间照泵 lan 那条腿**(实现审 H1)。
///
/// 为什么不能像原先那样一口气 await 完:三步各自只有 [`HANDSHAKE_SECS`] 的超时兜底,而
/// 「等 Challenge」与「等 Authed」都是**收到别的帧就接着等**的循环——一台接受了连接却不发
/// Challenge、或每隔九秒喂一枚无关帧的中转,能把这一段拉成任意长。那段时间里泵要是停着,
/// lan 的收发、心跳、静默判死、链路移交全冻住:**一台坏中转就能把局域网直连整个摁死**,
/// 而不变量 6 说的正是「引擎与直连的生命期不归中转会话管」。
///
/// 泵与离线等待泵**共用同一对函数**([`pump_wait`] / [`pump_apply`]),故不会长出「建连期
/// 少驱动了一件」的漂移。建连那半边是 pin 住反复 poll 的**同一个** future,泵转多少轮它都
/// 不会被重启;反过来处置半边在 select 之外跑,建连完成也砍不断它。
async fn connect_and_auth(
    t: &mut Transport,
    cfg: &SyncConfig,
    pumps: &mut Pumps,
    url: &str,
) -> Result<Connected, String> {
    let wrote = t.wrote.clone();
    // **首次连接就被卡死的那一路也得有断网期 Hello**(实现审二轮 M1):这只计时器出生是空的,
    // 而「会话收场后置成立刻」在从没连上过时根本轮不到,`until(None)` 又永不就绪——于是坏中转
    // 卡住第一次握手时,§5 要的 60s 定向 Hello 一枚都不会发。进建连即武装;**只有鉴权成功才
    // 清**(拨号失败也清的话,退避 1s 起步时就成了每秒一枚的 Hello 洪流)。
    if pumps.lan_hello_due.is_none() {
        pumps.lan_hello_due = Some(Instant::now());
    }
    let mut connecting = std::pin::pin!(async {
        let mut ws = dial(url).await?;
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
                ServerMsg::Authed => return Ok(ws),
                ServerMsg::Err { code, msg } => return Err(human_err(&code, &msg)),
                _ => continue,
            }
        }
    });
    loop {
        let woke = tokio::select! {
            r = &mut connecting => return r.map(Connected::Ready),
            // 建连期**照收控制面**(实现审二轮 H1):这一段现在会做真活,把 `Reconfigured`
            // 一直积在通道里等于「配置改了却要等坏中转先超时」——纯换 server_url 那种连身份
            // 指纹都察觉不到,能被卡到天荒地老。
            c = t.control.recv() => match c {
                None => return Ok(Connected::HostGone),
                Some(Control::Reconfigured) => return Ok(Connected::Reconfigured),
                Some(Control::PairStart { reply }) => {
                    let _ = reply.send(Err("正在连接服务器,请稍后再试".into()));
                    Woke::Handled
                }
            },
            w = pump_wait(pumps, &wrote, true) => w,
        };
        if matches!(pump_apply(t, pumps, Some(cfg), woke).await, Pumped::GateTripped) {
            return Ok(Connected::Reconfigured);
        }
    }
}

/// [`connect_and_auth`] 的三种收场。
enum Connected {
    Ready(Ws),
    /// 建连期间配置/身份变了(收到 `Reconfigured`,或栅栏自证落下):回 `run` 顶重来。
    Reconfigured,
    /// 控制通道的发送端没了 = 壳层走了(同会话循环那一路)。
    HostGone,
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
    pumps: &mut Pumps,
    // 通告面归属已对齐吗(false = 本轮整个关掉通告面,见 reconcile_lan_ad_owner)。
    lan_ad_ready: bool,
) -> Result<SessionEnd, String> {
    let url = ws_endpoint(&cfg.server_url)?;
    // 建连与挑战应答鉴权(§4):**这一段泵照转**(实现审 H1,见 [`connect_and_auth`])。
    let mut ws = match connect_and_auth(t, cfg, pumps, &url).await? {
        // **鉴权成功到会话仪式之间再自证一次**(实现审四轮 H1):建连期最后一次栅栏检查与
        // 服务器回 `Authed` 之间是一段谁也没查的窗口,而紧随其后的会话仪式(`reconcile` +
        // `on_relay_session_up` + Hello/Want/离线 op)全是拿 `cfg` 干的活——身份恰在这一窗
        // 换代,那一整轮就会被**旧 K_acc** 封了发出去。连接状态机切进会话状态机的这一步,
        // 是「拿当前身份干活」的第四条出口(前三条 = 会话循环各臂 / 泵 / 收场重问)。
        Connected::Ready(ws) => {
            if session_gate_tripped(&t.db, cfg) {
                return Ok(SessionEnd::Reconfigured);
            }
            ws
        }
        Connected::Reconfigured => return Ok(SessionEnd::Reconfigured),
        Connected::HostGone => return Ok(SessionEnd::HostGone),
    };
    *backoff = 1; // 鉴权成功才算连上,退避归位。
    // 拆开借:引擎槽要交给 `ctx`,别的几件留在本地给 select 臂用(读端与移交通道刻意不
    // 住在链路集里,否则那条臂会与 `ctx` 的可变借用打架,见 [`LanLinks::inbound_tx`])。
    let Pumps { slot, tick, handoff, lan_inbound, lan_faults, lan_hello_due, seat, .. } = pumps;
    let signing = SigningKey::from_bytes(&cfg.device_seed);
    // 中转会话**真建立了**才清断网期 Hello 的计时(§5 只在断线期间重发)。放在拨号之前
    // 清是个陷阱:拨号失败每轮都清一次,`run` 那句 `is_none()` 就永远成立,退避 1s 起步时
    // 等于每秒往每条链发一枚 Hello——一枚 advisory 的保活帧变成洪流。
    *lan_hello_due = None;

    let mut ctx = Ctx {
        db: t.db.clone(),
        clock: t.clock.clone(),
        status: t.status.clone(),
        events: t.events.clone(),
        data_dir: t.data_dir.clone(),
        cfg,
        signing,
        allow_boot_source: t.allow_boot_source,
        engine: slot,
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
        sess: RelaySession { n: 0, tracked: HashMap::new(), ad: AdFace::new(lan_ad_ready) },
        seat: seat.clone(),
    };

    // 引导判据 = 运行时有没有把引擎交给我(`EngineSlot::reconcile` 内已判
    // bootstrapped_at):槽空 = fresh-to-account 加入者,先拿快照(§6.2)。
    if ctx.engine.booting() {
        ctx.set_status(|s| s.state = "booting".into());
    } else {
        ctx.relay_session_up(&mut ws).await?;
    }

    let control = &mut t.control;
    let wrote = t.wrote.clone();
    // 释放 → 唤醒那根线(§6.2 ④′)。**克隆把手挂在循环外**:`ctx.engine` 在 select 的
    // 别的臂里被可变借用,而铃只是个 `Arc`。它住引擎槽、跨会话存活,故上一条会话没消费
    // 掉的那枚 permit 会被新会话第一轮 select 直接领走 —— 不丢。
    let ops_changed = Arc::clone(&ctx.engine.ops_changed);
    let mut last_rx = Instant::now();

    loop {
        // 封闸/身份换代栅栏(实现审 M1 四轮定形):在 frame/wrote/tick 三臂**做实际
        // 工作之前**各查一次、不节流——节流或只挂循环顶都留「唤醒事件先于下次检查」
        // 的单帧跨闸窗;逐事件几条点查 SELECT 相对帧处理本身的整事务可忽略。
        //
        // **刻意不再 `biased`**(L-c2c):多了 lan 那两条臂之后,固定臂序就是「谁饿死谁」
        // ——中转帧的追赶洪流会把 lan 臂连同心跳一起饿死(链路 90s 静默即被误判死、图的
        // 惩罚永不到期),反过来 lan 洪流也能饿死中转臂。随机选臂两条腿都不会被对方拖死
        // (同 L-c2a 实现审 M2 从离线泵里删 `biased` 的理由);控制通道的及时性由「每轮
        // 都被轮询」保证,停机另有 `run` 外层那只 select 兜底。
        let woke = tokio::select! {
            c = control.recv() => match c {
                None => return Ok(SessionEnd::HostGone),
                Some(Control::Reconfigured) => return Ok(SessionEnd::Reconfigured),
                Some(Control::PairStart { reply }) => {
                    if session_gate_tripped(&t.db, cfg) {
                        let _ = reply.send(Err("纪元切换进行中,暂不能发起配对".into()));
                        return Ok(SessionEnd::Reconfigured);
                    }
                    ctx.on_pair_start(&mut ws, reply).await?;
                    Woke::Handled
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
                            // 退出——**绝不进重连循环**,也绝不在原连接 relay_session_up。
                            let _ = ws.close(None).await;
                            return Ok(SessionEnd::ReopenRequired(e));
                        }
                    }
                    WsMsg::Close(_) => return Err("服务器关闭了连接".into()),
                    _ => {}
                }
                Woke::Handled
            },
            _ = wrote.notified() => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                let mut outs = vec![];
                let done = {
                    let conn = ctx.db.lock().expect("db mutex poisoned");
                    match ctx.engine.get() {
                        // 本地写落地:先结算(删图/删条目让缺字节清单少一项,L-c2a),
                        // 再推新 op。
                        Some(e) => e
                            .on_local_ops_settled(&conn)
                            .and_then(|()| e.outbound(&conn, &mut outs)),
                        None => Ok(()),
                    }
                };
                // 输出不蒸发(§6.2 ③″ 第 4 条):先投已累计的,再让错误收场。
                ctx.dispatch(&mut ws, outs).await?;
                done?;
                Woke::Handled
            },
            // **有腿交回了在飞位**(§6.2 ④′)。铃是边沿合并器、带一枚存量,故「摇的时候
            // 协调者正忙」不会丢。臂里只做「扫名单 + 摇铃」,一枚数据帧的准备仍在泵里。
            _ = ops_changed.notified() => Woke::OpsChanged,
            _ = tick.tick() => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                if last_rx.elapsed() >= Duration::from_secs(SILENCE_TIMEOUT_SECS) {
                    return Err("服务器长时间无响应,重连".into());
                }
                send_client(&mut ws, &ClientMsg::Ping).await?;
                // 图拉流「无进展」超时(M1):应了 BlobHave 却沉默的来源被作废、换来源。
                if let Some(e) = ctx.engine.get() {
                    let outs = e.on_tick();
                    if !outs.is_empty() {
                        ctx.dispatch(&mut ws, outs).await?;
                    }
                }
                // 同一刻的链路面(§3):Ping 与 90s 静默判死跟着这根心跳走。
                ctx.deck(&mut ws).lan_beat().await?;
                // ops 追赶那一拍(§6.2 ⑥;L-d″ 第⑤笔):本机 origin 重新派生 + 冷却到点
                // 放行 + 收回上一拍给直连的让位,随后那一趟 sweep 摇直连的铃并跑**一次**
                // 全局数据泵。
                //
                // **中转数据窗口的恒在续做轴就在这一句里**(L-d″ 第④笔;二轮 M 合并):
                // `busy` 那一格释放窗口后保留 work、刻意不当场重发,靠这一拍重泵 —— 不然
                // 那笔供流只能干等下一次偶然的新 pull(「靠一个信号触发,而信号可能不来」
                // 的同族)。原先这里另有一句独立的 `relay_data_pump()`,那等于给同一拍**再**
                // 发一整个 K 的额度;合并之后一拍恰好一次,K 那条公平上界才真成立。
                ctx.deck(&mut ws).ops_tick().await?;
                // 对账控制帧的重发债(§6.1 九轮 H1;L-d″ 第④笔下半):`busy` 掉的那枚
                // Hello / ops Want 没有别的重发轴,同样挂这根恒在心跳。**排在数据泵之后**
                // ——一枚 mail 控制帧不该跟数据窗口抢这一拍的先手,而它自己不占窗口。
                let ctl = ctx.deck(&mut ws).reconcile_tick()?;
                if !ctl.is_empty() {
                    ctx.dispatch(&mut ws, ctl).await?;
                }
                // 隔离重验的续做(L-d‴):跟着这根恒在心跳走,每拍至多一批。**必须排在
                // `lan_beat` 之后**,与离线泵那条同序(实现审三轮 M1:一度写反了——
                // 注释说在后、代码在前;重验输出的 dispatch 一失败,这一拍的 `lan_beat`
                // 就被 `?` 跳过了)。重验自身的错误只进 advisory 槽,不掐心跳。
                let rev = ctx.deck(&mut ws).reverify_tick();
                if !rev.is_empty() {
                    ctx.dispatch(&mut ws, rev).await?;
                }
                Woke::Handled
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
                Woke::Handled
            },
            _ = until(ctx.boot_deadline) => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                // 等 Offer/块超时:换下一台在线设备重试(对方可能也在引导,§6.2)。
                ctx.boot_rotate();
                ctx.try_boot_request(&mut ws).await?;
                Woke::Handled
            },
            _ = std::future::ready(()), if ctx.boot_out.is_some() => {
                // boot_out 恒就绪,两次 tick 间可推完整快照——供流也必须先过闸
                // (旧纪元库在切换中当引导源,正是隔离不变量要断的路)。
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                ctx.pump_boot_out(&mut ws).await?;
                Woke::Handled
            },
            ev = lan_inbound.recv() => {
                Woke::Lan(ev.expect("链路集自持一枚 sender,通道不会关"))
            },
            f = lan_faults.recv() => {
                Woke::LanDown(f.expect("链路集自持一枚 sender,通道不会关"))
            },
            Some(adopted) = handoff.recv() => Woke::Adopt(adopted),
            // 拨号巡查(§7):中转在线时照拨——直连是加速层,与中转在不在无关。
            _ = until(ctx.engine.dial_due()) => Woke::Dial,
        };
        // lan 那两件在 select 之外处理:臂里直接 `ctx.…()` 会与臂上的借用打架。**这也正是
        // 「run-to-completion」的形**(§6 代次契约之一)——一枚事件与它产出的全部输出在
        // 这里一路跑完,期间不会回到 select 去处理别的链路事件。
        match woke {
            Woke::Handled => {}
            // **lan 那三件也得过闸**(实现审三轮 H1):它们与 frame/wrote/tick 一样会拿当前
            // 身份封解帧、落库、接纳新链——漏掉就正是拍板禁止的「单帧跨闸窗」:身份换代后,
            // 只要一枚 lan 帧或一次链路移交先于中转帧被选中,就会用旧 K_acc 解封应用、或以
            // 旧身份认下一条新链。
            Woke::Lan(_) | Woke::LanDown(_) | Woke::Adopt(_) | Woke::Dial | Woke::OpsChanged
                if session_gate_tripped(&t.db, cfg) =>
            {
                return Ok(SessionEnd::Reconfigured);
            }
            Woke::OpsChanged => ctx.deck(&mut ws).ops_changed_tick().await?,
            Woke::Lan(ev) => ctx.deck(&mut ws).lan_event(ev).await?,
            Woke::LanDown(f) => ctx.deck(&mut ws).lan_fault(f).await?,
            Woke::Adopt(adopted) => ctx.deck(&mut ws).lan_adopt(adopted).await?,
            // 拨号巡查 + 本机通告地址对齐(§7;见 [`lan_dial_tick`])。失败只进 advisory
            // 面,绝不拖累中转会话;地址真变了那枚广播 Hello 走中转发出去。
            Woke::Dial => {
                let outs = lan_dial_tick(
                    &ctx.db,
                    &ctx.status,
                    &ctx.events,
                    cfg,
                    ctx.seat.clone().as_ref(),
                    ctx.engine,
                    Some(&ctx.sess.ad),
                );
                ctx.dispatch(&mut ws, outs).await?;
            }
            // 会话在的时候这三件归上面那些臂 / 归离线泵。
            Woke::Tick | Woke::Wrote | Woke::LanHello => {}
        }
    }
}

/// **投递面**(L-c2c):引擎输出的唯一出口 + 入帧的唯一入口,**两条腿、在线离线共用**。
///
/// 为什么非要有这么一层:直连的收发必须在**没有中转会话**时也照跑(不变量 6 / §5「本机
/// 中转离线:全部 mail 走各 lan 链路」),而 [`Ctx`] 是「一条已鉴权 WSS 会话」的东西。把
/// `dispatch`/`feed` 收进这里,离线泵与会话循环用的就是同一份选路与同一份收帧管道——
/// 复制一份「离线专用的收帧路径」才是真风险(L-b/L-c1/L-c2a 三笔实现审同一条教训)。
///
/// 中转腿在不在由 [`RelayLeg`] 说,**不是一个可忘的 bool**:`Up` 才带得出 socket 与信封
/// 序号,故「离线时误往中转发一帧」在类型层不存在。
struct Deck<'a> {
    db: &'a Arc<Mutex<Connection>>,
    clock: &'a Arc<Mutex<Clock>>,
    status: &'a Arc<Mutex<SyncStatus>>,
    events: &'a mpsc::UnboundedSender<SyncEvent>,
    cfg: &'a SyncConfig,
    slot: &'a mut EngineSlot,
    relay: RelayLeg<'a>,
}

/// 中转腿的在场形。
enum RelayLeg<'a> {
    /// 本机中转会话不在(断 WAN 冷启动 / 退避重连 / 空间不足等待):§5「全部 mail 走各
    /// lan 链路」——收件面由 [`Engine::lan_backfill_peers`] 给出,与「中转在线时对端离线
    /// 才补投」**是同一条规则**(那时全部对端的 relay 腿都是 Absent),故没有第二套分支。
    Down,
    Up { ws: &'a mut Ws, sess: &'a mut RelaySession },
}

impl Deck<'_> {
    fn set_status(&self, f: impl FnOnce(&mut SyncStatus)) {
        set_status(self.status, self.events, f);
    }

    fn toast(&self, msg: String) {
        let _ = self.events.send(SyncEvent::Toast(msg));
    }

    /// 引导中吗(引擎槽空 = 还没拿到首份快照)。
    fn booting(&self) -> bool {
        self.slot.booting()
    }

    fn relay_up(&self) -> bool {
        matches!(self.relay, RelayLeg::Up { .. })
    }

    /// 通告面(§2)。`None` = 中转腿不在——通告面**在 lan 那条腿上根本不存在**(单一权威
    /// 路:只有经 deliver 到达的帧算数,往 lan 帧里塞通告是白费字节),不是「忘了处理」。
    fn ad(&mut self) -> Option<AdDeck<'_>> {
        let RelayLeg::Up { sess, .. } = &mut self.relay else { return None };
        Some(AdDeck {
            db: self.db,
            status: self.status,
            events: self.events,
            cfg: self.cfg,
            slot: self.slot,
            ad: &mut sess.ad,
        })
    }

    /// 链路集变了之后刷一次槽的事实(链路数进状态面 + 活跃对端进准入表的视图)。
    /// **走 [`EngineSlot::apply_status`] 那个唯一出口**:L-c3a 起链路集除了链路数还要
    /// 对外发布活跃对端(§4 步骤 1 的第四道闸),再手写一格就是第二处真相源。
    fn refresh_lan_status(&self) {
        self.set_status(|s| self.slot.apply_status(s));
    }

    /// 交给新链写泵的供流上下文(§10 C′)。**每条链一份克隆**:写泵得能在协调者忙着别的
    /// 事时独立取数、封帧、写 socket。
    fn serve_ctx(&self) -> ServeCtx {
        ServeCtx {
            db: Arc::clone(self.db),
            status: Arc::clone(self.status),
            events: self.events.clone(),
            account_id: self.cfg.account_id.clone(),
            device_id: self.cfg.device_id.clone(),
            k_acc: self.cfg.k_acc,
            device_seed: self.cfg.device_seed,
            ops: Arc::clone(&self.slot.ops),
            ops_changed: Arc::clone(&self.slot.ops_changed),
        }
    }

    // ---- 入帧:解封 → 引擎 ------------------------------------------------------------

    /// 一枚密文帧的解封与分流(**两条腿共用**):逐域试解 → 引导中整帧丢弃 → 数据帧入
    /// [`Deck::feed`]。引导帧不在此处理,**原样交回调用方**——引导编排(源端/收端状态机、
    /// 临时快照、latch)是会话的活,而 boot 帧 v1 恒走中转(§5),lan 那边收到即拒。
    async fn on_wire(
        &mut self,
        ingress: Ingress,
        from: &str,
        to: &str,
        blob: &[u8],
    ) -> Result<Option<BootMsg>, String> {
        match open_deliver(self.cfg, from, to, blob) {
            Opened::Data(msg) => {
                // 引导中整帧丢弃(模块注释;hello 互补会重取)。**通告也一起丢**:此刻库
                // 正处在「fresh 待导入」的窗口里,不许往 sync_meta 添任何行;LanReady 本就
                // 要求引擎在场(不变量 6),引导期学不学公钥毫无区别。
                if self.booting() {
                    return Ok(None);
                }
                self.feed(ingress, from, to, msg).await?;
                Ok(None)
            }
            Opened::Boot(bm) => Ok(Some(bm)),
            Opened::Skew => {
                self.report_skew();
                Ok(None)
            }
            Opened::WrongDomain(domain) => {
                // 认证通过但变体不属于该域:协议映射被破坏(对端实现漂移),按协议
                // 错误拒收——不是 skew(skew 会劝人升级,这里升级也没用)。
                let text = format!("拒收 {from} 的帧:变体与加密域 {domain} 不符(对端实现漂移?)");
                self.set_status(|s| s.error = Some(text));
                Ok(None)
            }
            Opened::Undecryptable => {
                let text = format!("收到无法解密的帧(来自 {from};密钥不一致?)");
                self.set_status(|s| s.error = Some(text));
                Ok(None)
            }
        }
    }

    fn report_skew(&mut self) {
        if !self.slot.notices.skew_toasted {
            self.slot.notices.skew_toasted = true;
            self.toast("对端版本较新,请升级朱简后继续同步".into());
        }
        self.set_status(|s| s.skew = true);
    }

    /// 一帧内层消息入引擎的**唯一入口**(两条腿共用):来路 → [`Route`] 的映射只此一处
    /// (§2/§5「来路是传输层内部事实,绝不取自对端字段」),通告吸收也收在这里。
    ///
    /// `to` = 信封上的收件人(本机 device_id 或广播),只用来判「这是不是定向发给本机的
    /// Hello」= §2 的隐式索要。它同样是传输层事实(服务器回显的信封 / LanWire 的地址闸,
    /// 两者都在解密前后各有一道 AAD 保险)。
    async fn feed(
        &mut self,
        ingress: Ingress,
        from: &str,
        to: &str,
        msg: Msg,
    ) -> Result<(), String> {
        let route = route_of(ingress);
        // 吸收要在引擎处理这枚 Hello **之前**(它得先读到旧缓存),但回帧**之后**才发:
        // advisory 面的一个发送失败点不许挡住这枚 Hello 的水位进引擎(codex 审 M4)。
        // 中转腿不在时压根没有通告面可言(§2 单一权威路:只有经 deliver 到达的才算),
        // 故 `Down` 形直接没有这段——不是忘了,是那条路上没有这件事。
        let directed = to == self.cfg.device_id;
        let ad_outs = match &msg {
            Msg::Hello { lan: Some(ad), .. } => {
                let ad = ad.clone();
                match self.ad() {
                    None => vec![],
                    Some(mut face) => face.absorb_lan_ad(from, &ad, ingress, directed),
                }
            }
            _ => vec![],
        };
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
        // 出错也要走完出口那几件(实现审三轮 H1 + 四轮 M1),故把第一枚 Err 扣到最后:
        // 前面几批可能已经落地了,`Changed` 与状态快照是它们唯一的通知,被 `?` 跳过就
        // 得等下一次偶然的刷新。
        let mut fault: Result<(), String> = Ok(());
        for m in batches {
            changed |= matches!(&m, Msg::Ops { .. })
                || matches!(&m, Msg::BlobChunk { last: true, .. });
            // 输出交由**调用方**持有(实现审三轮 H1):这枚子批处理到一半的本地故障,
            // 不该带走它此前已经**做成**的那些事的通知(隔离行已落表、槽已驱逐、翻案已
            // 落库)。故先投出去,再让那枚 Err 收场。
            let mut outs = vec![];
            let done = {
                let mut conn = self.db.lock().expect("db mutex poisoned");
                let mut clk = self.clock.lock().expect("clock mutex poisoned");
                self.slot
                    .get()
                    .expect("booting 已在 on_wire 挡掉")
                    .on_msg(&mut conn, &mut clk, from, route, m, &mut outs)
            };
            let sent = self.dispatch(outs).await;
            // 引擎的本地故障优先报(投递失败常只是它的后果),与改前同序。
            if let Err(e) = done.and(sent) {
                fault = Err(e);
                break;
            }
        }
        // 这枚 Hello 的水位已进引擎,通告回帧现在才上线(顺序即上一段那条契约)。
        let ad_sent = self.dispatch(ad_outs).await;
        if changed {
            let _ = self.events.send(SyncEvent::Changed);
        }
        // 引擎内存态照进状态快照(挂起数/冻结清单/隔离与 breaker;set_status 内容
        // 不变不发事件)。
        let (suspended, mut frozen, poison) = {
            let e = self.slot.peek().expect("上面刚用过");
            (e.suspended_count(), e.frozen.keys().cloned().collect::<Vec<_>>(), e.poison_status())
        };
        frozen.sort();
        self.set_status(|s| {
            s.suspended = suspended;
            s.frozen = frozen;
            s.quarantined = poison.0;
            s.poison_breaker = poison.1;
        });
        fault?;
        ad_sent?;
        Ok(())
    }

    // ---- 出帧:§5 选路 ----------------------------------------------------------------

    /// 引擎输出的**唯一投递口**。
    ///
    /// 用工作队列而不是递归:入队失败要当场断链并通报引擎,而通报本身又产出帧(「回清单
    /// 必配重问」,§6)。终止性 = 每次投递失败都**单调地少掉一条 lan 腿**——要么摘掉一条
    /// 链路对象(`Failed`,链路数有硬上界 [`LAN_LINKS_MAX`]),要么从路由表抹掉那条腿
    /// (`NoLink`,H2);两者本轮都不会被加回(建链只经 [`Deck::lan_adopt`]),故队列必空。
    /// 供流([`Output::ServeBlob`])走同一条论证:它只在 lan 腿失败时产出帧,而那正是
    /// 「少掉一条腿」的那一步。
    /// 隔离重验的**续做一拍**(L-d‴ 实现审 H1/H2):有余量才动库,每拍至多放一批。
    ///
    /// 为什么挂心跳而不是 `on_msg` 出口:① 心跳是**恒在**的时间轴(不变量 6:断 WAN 也
    /// 照跳),而 `on_msg` 要有人发帧才来——一批全是 `InvalidOp` 时连 want 都不产,链路
    /// 稳定就再没有下一枚帧;② `Deck::feed` 会把 >`OPS_LOCK_BATCH` 的 ops 帧切成子批
    /// **逐批**喂进 `on_msg`,挂那儿等于「每枚线帧最多五批」,预算白封;③ 续做的 `?`
    /// 会连坐吞掉那枚帧自己已经处理成功的输出。
    ///
    /// 锁序照 §8 契约(先 db 后 clock),与 [`Deck::feed`] 同款;取完即放,不跨 await。
    fn reverify_tick(&mut self) -> Vec<Output> {
        // 门槛问的是「还有活吗」:除了 SQL 侧的余量,还含「行已放出表、drain 却欠着」
        // 那笔债(实现审三轮 H2)——两者为何一位就够,论证在 `needs_reverify_tick`。
        if !self.slot.get().is_some_and(|e| e.needs_reverify_tick()) {
            return vec![];
        }
        let mut out = vec![];
        let done = {
            let mut conn = self.db.lock().expect("db mutex poisoned");
            let mut clk = self.clock.lock().expect("clock mutex poisoned");
            self.slot
                .get()
                .expect("上面刚查过在场")
                .reverify_quarantined(&mut conn, &mut clk, &mut out)
        };
        // **失败只进 advisory 槽,绝不左右心跳的主职责**(实现审二轮 H2):一个可复现的
        // 重验错误若能把这一拍的返回值染成 Err,`on_tick` 已产出的重问帧会被丢掉、
        // `lan_beat` 更是永远轮不到 —— LAN 的 Ping 与 90s 静默判死一起停摆,而那是
        // 不变量 6 明说「断 WAN 也不许停」的东西。隔离表的维护失败不配掐心跳。
        // 已提交的义务(驱逐 want / 恢复 want / 已放行行的追帧 want)由 `out` 带出去:
        // 引擎那侧改成写调用方的缓冲,故 Err 也不丢它们(同轮 H1)。
        if let Err(e) = done {
            self.set_status(|s| s.error = Some(format!("隔离重验失败(下一拍重试):{e}")));
        }
        out
    }

    /// **对账控制帧重发债的续做一拍**(§6.1 九轮 H1 的第三件;L-d″ 第④笔下半)。
    ///
    /// 债的三件必须同一提交上齐(§6.1 十轮),这是消费的那一件:`busy` 掉的那枚 Hello /
    /// ops Want **没有任何别的重发轴** —— Hello 不周期发送,`Engine::on_tick` 里只有图侧
    /// 的续问。故把它挂到**恒在的心跳**上,与 `reverify_tick` 同一条论证。
    ///
    /// **重发的是一枚广播 Hello,不是把原帧存下来重放**:①水位图现构造才是最新的(存下来
    /// 的那份一旦过期,重放反而把对端的水位往回带);②ops Want **可折叠进这枚 Hello** ——
    /// 缺席按 0 就足以让持有高水位的对端重新建立 Range/Reconcile,不必单独重发 Want。
    ///
    /// ⚠ **构造走 [`Engine::make_hello`] 这个既有的唯一出口**,本笔**不新增任何
    /// `watermarks()` 调用点**(§6.2 ⑨-5「④ 不能自己另造一条全表 Hello」)。第⑤笔把
    /// 那个出口换成有界形之后,这一拍**自动**跟着变有界——两笔在这里交界的方式就是
    /// 「复用同一处」,而不是各造一份再想办法对齐。
    ///
    /// **债不在这里清**:只有它的 Ack 才清(§6.1 九轮 H1)。故服务器持续 busy 时,这一拍
    /// 每次心跳重发一枚,频率由心跳定 —— 有界,且不是热循环。
    fn reconcile_tick(&mut self) -> Result<Vec<Output>, String> {
        if self.slot.reconcile_debt.is_none() || !self.relay_up() {
            return Ok(vec![]);
        }
        let Some(engine) = self.slot.peek() else { return Ok(vec![]) };
        let conn = self.db.lock().expect("db mutex poisoned");
        engine.make_hello(&conn, BROADCAST, Route::Relay)
    }

    async fn dispatch(&mut self, outs: Vec<Output>) -> Result<(), String> {
        // 测试栅栏:见 [`arm_dispatch_barrier`]。生产构建里这两行根本不存在。
        #[cfg(test)]
        dispatch_barrier().await;
        let mut queue: VecDeque<Output> = outs.into();
        while let Some(o) = queue.pop_front() {
            match o {
                Output::Event(ev) => self.on_engine_event(ev),
                Output::Send { to, lane, route_hint, msg } => {
                    let more = self.send_out(&to, lane, route_hint, &msg).await?;
                    queue.extend(more);
                }
                Output::ServeBlob(serve) => {
                    let more = self.serve_blob(serve).await?;
                    queue.extend(more);
                }
                Output::ServeOps(serve) => {
                    let more = self.serve_ops(serve).await?;
                    queue.extend(more);
                }
            }
        }
        Ok(())
    }

    /// 一声 op 追赶的唤醒落到哪条腿上(§6.2 ② 的四分路由)。
    ///
    /// **描述符里一个游标、一枚 op 都没有**(见 [`OpsServe`]):该发什么由消费腿自己去问
    /// [`EngineSlot::ops`] 里那份计划。故这里只做一件事——把铃摇对地方。
    ///
    /// 定向那两支**绑产出那一刻的来路腿**(来路亲和,同 `BlobServe.route`):不查「此刻
    /// 还有哪些腿」,那是 [`Deck::ops_changed_tick`] 那条名单路的事。
    async fn serve_ops(&mut self, serve: OpsServe) -> Result<Vec<Output>, String> {
        match serve.to {
            OpsServeTo::Peer { device, route: Route::Lan } => {
                self.slot.lan.wake_ops(&device);
                Ok(vec![])
            }
            OpsServeTo::Peer { route: Route::Relay, .. } => self.relay_data_pump().await,
            OpsServeTo::Broadcast => self.broadcast_ops_pump().await,
        }
    }

    /// **本机 origin 那一格只摇当时的权威完成腿**(§6.2 ①):relay 会话在场 → 中转泵;
    /// 不在 → 离线泵乐观消费。
    ///
    /// **绝不同时摇两类**:补投是权威腿发帧时顺手 fan-out 的([`Deck::fan_out_broadcast`]),
    /// 不是第二个消费者。抢先提交的补投腿会让 BROADCAST 游标越过 relay,而稳定长会话里
    /// 没有任何事件会把它带回来。
    ///
    /// (定向 target 是另一套:两条腿各去争同一枚 per-target 在飞位,谁先武装谁做,输的那条
    /// 撞 `Occupied` 跳过 —— 见 [`Deck::ops_changed_tick`] 与 [`ops_serve::OpsWorks::yield_relay`]。)
    async fn broadcast_ops_pump(&mut self) -> Result<Vec<Output>, String> {
        if self.relay_up() {
            return self.relay_data_pump().await;
        }
        self.offline_broadcast_pump().await
    }

    /// **断网期本机 origin 的追赶**(§6.2 ①「relay 不在场时可乐观消费与提交」)。
    ///
    /// 为什么由协调者消费而不是让各条 LAN 写泵去抢:BROADCAST 的在飞位只有一枚,谁抢到谁
    /// 提交、游标随即前进 —— **别的对端那一帧就永远补不上了**(没有 per-leg frontier,
    /// §6.2 ① 的备选形正是因为要 per-leg 状态才被否掉)。放在协调者里,一枚帧封一次、
    /// 投给全部合格腿,与 [`Deck::fan_out_broadcast`]、`send_out` 的 `Auto` 臂逐字同形,
    /// 「谁算合格」仍只有 [`Engine::lan_backfill_peers`] 一个判据出口。
    ///
    /// **乐观提交**:LAN 没有回执,写成即提交(与 L-c2c 那条「断网期内存游标乐观推进」
    /// 同一条)。丢了的由中转恢复时的保守合并补回 —— 持久 `last_pushed` 一个字节都不动。
    ///
    /// 一次调用**至多一枚帧**:与两条泵同一条纪律,回合的检查点归调用它的那一处。
    async fn offline_broadcast_pump(&mut self) -> Result<Vec<Output>, String> {
        if self.relay_up() {
            return Ok(vec![]); // 权威腿在场:这条路不该被走到(两个调用点都已分流)。
        }
        // **一条合格腿都没有就一个字节都别取**:取了也没人收,而 `commit` 会照样推进游标,
        // 一趟自唤醒就能把整份计划空转掉。丢的不是数据(持久 `last_pushed` 没动,中转恢复
        // 时的保守合并会把 `[acked+1, max]` 整个加回来),但那是白扫一遍库。
        // 续做所有者 = 新链接入那一下(`lan_adopt` 摇 `ops_changed`)。
        if self.slot.peek().is_none_or(|e| e.lan_backfill_peers().is_empty()) {
            return Ok(vec![]);
        }
        let ctx = self.serve_ctx();
        let (frame, ticket) = match ops_prepare(&ctx, BROADCAST) {
            // 换代 / 没活 / 别人占着 / 空转:都不出帧。空转的游标已在临界区里提交过。
            OpsTurn::Recast | OpsTurn::Idle | OpsTurn::Occupied | OpsTurn::Spun => {
                return Ok(vec![])
            }
            OpsTurn::Failed(why) => return Err(format!("ops 供流取数失败:{why}")),
            OpsTurn::Frame(frame, ticket) => (frame, ticket),
        };
        let msg = Msg::Ops { origin: frame.origin, ops: frame.ops };
        let FanOut { mut back, delivered } = self.fan_out_broadcast(&msg);
        if delivered == 0 {
            // **一条腿都没投出去:游标一步不许进**(codex 实现审一轮 M)。断网期这条腿自己
            // 就是权威,没有别人在等 Ack —— 照 relay 那套「旁腿失败不回滚」搬过来,那一段
            // 就从内存游标上过去了。三种成因(封不出帧 / 合格腿刚好全断 / 全部入队失败)
            // 处置相同:work 原样留着,等新链接入或下一拍心跳。
            //
            // **静默交回**(不摇铃):摇了就是「取帧 → 投不出 → 交回 → 摇铃 → 再取同一段」
            // 的热循环,与中转腿 Nack 那条同族。
            ticket.rollback_quiet()?;
            self.set_status(|s| {
                s.lan_warning =
                    Some("断网期的本机新增内容一条直连腿都没投出去(已保留,等新链)".into())
            });
            back.shrink_to_fit();
            return Ok(back);
        }
        // **投完才提交**(同两条泵):投不出去时凭据不推进游标,下一次唤醒取到的还是同一段。
        //
        // 续做那一声**就在这句里**:`commit` 走 [`OpsTicket::settle`],占→空当场摇 —— 断网期
        // 没有回执来驱动下一枚,全靠它接力。这里**刻意不再补一句** `notify_one()`:铃是边沿
        // 合并器只留一枚存量,补的那句一个字节的差别都做不出来,而它会伪装成一道独立的防护
        // (变异对照里正是这么露的馅:拆掉它 13 条里没有一条变红)。
        ticket.commit()?;
        back.shrink_to_fit();
        Ok(back)
    }

    /// 心跳的 ops 面(§6.2 ⑥)。照 [`Deck::reverify_tick`] 的成例挂**现有**心跳的两个调用点
    /// (会话内那一臂 + 离线泵),**不新增 select 臂**(§6.1 实现期硬约束 2)。
    ///
    /// 两件:①本机 origin 的追赶每拍从持久事实重新派生(撞过 `Overload` 的那次登记只有这里
    /// 补得回来);②冷却到点把义务提成可跑工作、收回上一拍给直连的让位,随后由
    /// [`Deck::ops_changed_tick`] 那一趟统一选腿。
    ///
    /// **`on_tick` 不再交精确名单**(codex 实现审二轮 L1):`busy` 释放窗口之后仍 runnable
    /// 的、中转腿刚断而描述符当初绑的是 relay 的,那份名单**一个都不报**(它只报 false→true
    /// 的边沿),而它们的续做所有者只剩这一拍;`idle_runnable_targets()` 是它的超集,差集只有
    /// 「在飞位占着」那一档 —— 摇了也只拿得到 `Occupied`。故不是两趟,是一趟更宽的。
    ///
    /// **输出不蒸发**(§6.2 ③″ 第 4 条):引擎那半即使返回 `Err`,已经写进缓冲的描述符与
    /// advisory 也先发出去,再让错误收场。
    async fn ops_tick(&mut self) -> Result<(), String> {
        // **收回上一拍给直连的让位:排在最前,不许挂在下面任何一件的成败上**(二轮 H)。
        // 引擎那半前面隔着 `outbound` 的 `?`,搭在它后面的话一次读库失败就能让让位跨过
        // 好几拍(「已提交的义务不许随 `?` 蒸发」,268 那条);也必须早于下面那趟 sweep,
        // 否则没有直连腿时中转要多等一整拍才重试。
        lock_ops(&self.slot.ops).clear_relay_yields();
        let mut outs = vec![];
        let ticked = {
            let conn = self.db.lock().expect("db mutex poisoned");
            match self.slot.get() {
                None => Ok(()),
                Some(e) => e.ops_tick(&conn, &mut outs),
            }
        };
        let sent = self.dispatch(outs).await;
        ticked.and(sent)?;
        self.ops_changed_tick().await
    }

    /// **有腿交回了在飞位**(§6.2 ④′):扫出此刻「有活 ∧ 在飞位空」的 target,摇直连的铃,
    /// 再跑**一次**全局数据泵。
    ///
    /// **一趟至多一次全局泵**(codex 实现审二轮 M)。上一版是「逐 target 调一个
    /// 已撤掉的 `wake_ops_target`」,而它在中转在场时每次都进一趟全局
    /// [`Deck::relay_data_pump`] —— 64 个 target × 每趟跑满 K=8 回合 = 一拍最坏约 512 次
    /// 取数,`pump_ops` 在 K 处留的那枚 permit 拦不住**当前这趟 sweep 继续调下一轮泵**。
    /// 不会重复占窗、也不会多翻 ops/blob 的 1:1(窗口一占,后续全早返回),但 K 那条
    /// 「跑 8 次就交回协调者」的延迟与公平上界被整个打掉了。
    ///
    /// 拆法:**逐 target 的那一半只摇 LAN 铃**(不摸库、不 await),**全局泵这一半整趟只跑
    /// 一次**。中转腿本就按自己的 round-robin 选 target,逐个摇它没有任何额外信息。
    ///
    /// 三条纪律照旧:
    /// * **在 work 锁内最多扫 [`ops_serve::OPS_TARGET_MAX`] 项、只复制名单**;
    /// * **放掉 work 锁之后**才查路由、摇 relay / LAN 铃(守住「持 work 时不得再取
    ///   db/clock/status/lan」);
    /// * **不自旋**:这里不做「扫完还有活就再 notify」。窗口占用期间那样做会热循环——
    ///   真正能解除条件的那枚 Ack 反倒要跟热循环抢协调者。续做所有者按情形各有其人
    ///   (relay 窗口 = Ack/Nack/session-down;per-target 在飞位 = 那枚凭据的交回;
    ///   K 到限 = [`Deck::pump_ops`] 自己留的那枚 permit)。
    ///
    /// **中转在场时无条件泵一次**(哪怕名单是空的):心跳那根「`busy` 释放窗口后保留 work、
    /// 等下一拍重泵」的恒在续做轴就是靠这一句 —— 二轮 M 把它与本趟合并成唯一一次之后,
    /// 有条件跑就会把图字节那半的续做一起漏掉(ops 名单空 ≠ blob 待办空)。
    async fn ops_changed_tick(&mut self) -> Result<(), String> {
        let targets = lock_ops(&self.slot.ops).idle_runnable_targets();
        // ① 定向 target:摇它那条直连腿。**BROADCAST 不摇**(§6.2 ①:本机 origin 只许权威
        //    完成腿消费,补投是权威腿发帧时顺手 fan-out 的,不是第二个消费者)。
        let mut broadcast = false;
        for target in &targets {
            if target == BROADCAST {
                broadcast = true;
                continue;
            }
            self.slot.lan.wake_ops(target);
        }
        // ② 全局数据泵:整趟一次。中转在场 = 权威完成腿是它;不在场时本机 origin 那一格
        //    改由离线泵乐观消费(定向的那些上面已经摇过直连了,这里没有第二件事可做)。
        let outs = if self.relay_up() {
            self.relay_data_pump().await?
        } else if broadcast {
            self.offline_broadcast_pump().await?
        } else {
            vec![]
        };
        self.dispatch(outs).await
    }

    /// 一笔图字节供流落到哪条腿上(§10 C′)。**两条腿两种形,但都不物化整图**:
    ///
    /// * `Lan` —— 非阻塞把描述符交给**创建时那条具体链路**,块由该链写泵自己逐块产出,
    ///   协调者当场返回。这正是 263 那个 bug 的修法:整图 128 枚帧一次性入队才会撞每链
    ///   8 MiB 上界、断链、然后重拨重死循环。
    /// * `Relay` —— 协调者内逐块取数直发。中转腿的 `send_relay().await` 本就占着协调者
    ///   (§5「两路发送无共享阻塞点」的正确读法 = **可选的 LAN 腿**不许拖住中转,中转
    ///   主路自身的 await 照旧),故这里同步走完与改动前同形;变的只是「一块一读」取代
    ///   「整图物化 + 128 枚 Output」,峰值内存从 ~64 MiB 降到 256 KiB(顺带把 §10
    ///   记的「中转路供流分批」同轮对齐了)。
    async fn serve_blob(&mut self, serve: BlobServe) -> Result<Vec<Output>, String> {
        match serve.route {
            Route::Lan => {
                let to = serve.to.clone();
                Ok(match self.slot.lan.enqueue_serve(&to, serve) {
                    Ok(()) => vec![],
                    Err(e) => self.on_lan_send_failed(&to, e),
                })
            }
            Route::Relay => self.serve_blob_relay(serve).await,
        }
    }

    /// 中转腿上的供流**入队**(L-d″ 第④笔;这里原本是一个跑完整图的 `for` 循环)。
    ///
    /// **为什么拆掉那个循环**(§6.1 五轮 Q5,263 真机字据):一张 32 MiB 的图 = 128 枚
    /// `send_relay().await` 全在协调者栈上跑完,其间 Ack/Nack 处理不了、runtime 心跳跑
    /// 不了、LAN 链路的 `last_rx` 也刷不了 —— 下一次 `lan_beat` 就按 90s 把**健康的**
    /// 直连链整批判死。一次调用的产出量由图的大小说了算,正是「工作量由数据规模说了算
    /// = 缺一道常量闸」。
    ///
    /// 现在:入队 → 泵一块 → 立刻回协调者,后续块由回执驱动
    /// (见 [`Deck::relay_data_pump`])。
    async fn serve_blob_relay(&mut self, serve: BlobServe) -> Result<Vec<Output>, String> {
        if !self.relay_up() {
            // 同「`Require(Relay)` 送不出」那条:引擎此刻已知道会话断了,丢的由重连时的
            // 会话仪式补齐(收端那边会 stale 换来源)。
            let text = format!("发往 {} 的图字节供流钉了中转,但会话不在(已丢弃)", serve.to);
            self.set_status(|s| s.lan_warning = Some(text));
            return Ok(vec![]);
        }
        let to = serve.to.clone();
        let (image_id, transfer) = (serve.image_id.clone(), serve.transfer.clone());
        if !self.slot.relay_data.enqueue(BlobJob { serve, next_idx: 0 }) {
            // 满额 fail-closed:沿同 transfer 回一枚 deny,收端据此回清单另寻来源——不
            // 静默丢(那会让它干等到 stale)。**这枚 deny 不占数据窗口**:它没有后续块,
            // 走普通 direct 路,故它的回执也不该去释放别人的窗口。
            self.set_status(|s| {
                s.lan_warning = Some(format!(
                    "中转待发供流已满({RELAY_SERVE_QUEUE} 笔),拒了 {to} 的取图"
                ))
            });
            return Ok(vec![Output::Send {
                to,
                lane: Lane::Direct,
                route_hint: RouteHint::Require(Route::Relay),
                msg: Msg::BlobDeny { image_id, transfer },
            }]);
        }
        self.relay_data_pump().await
    }

    /// **中转全局数据窗口的泵**(§6.2 ① 的归宿形 (C)):窗口空 ∧ 待办非空 → 备**一枚**
    /// 数据帧发出去、占住窗口,**随即返回协调者**——不在一次调用里循环。
    ///
    /// 三个调用点共一条恒在轴:①新描述符入队后;②回执释放窗口后;③**心跳**。第三个
    /// 不是冗余:`busy` 那一格明写「释放窗口、保留 work、等心跳重试」,少了它,那笔 work
    /// 就只能等下一次偶然的新 pull——「靠一个信号触发,而信号可能不来」的同族。
    ///
    /// **轮转出队**(队首取、发完回队尾,见 [`RelayData::requeue`])**不是为了公平好看,
    /// 是活性必需**:收端那笔 `Pull` 有 `PULL_STALE_TICKS` = 2 拍(60s)的无进展死线,
    /// 若让一张 128 块的图独占窗口跑到底,排在它后面那台对端的拉流会**先被对端自己判死**,
    /// 然后回清单重问——白跑一整轮。**队首优先在快链上也照样让队尾饿死**,轮转不会。
    ///
    /// ⚠ **但它不是无条件成立的结构证明**(codex 实现审 M2 纠了我把算式当证明):这里是
    /// 全局 stop-and-wait,N 笔并发时每笔约每 **N 个中转往返**才拿到一块,故要人人守住
    /// 「每 60s 至少一块」就得有
    ///
    /// > 有效吞吐 > `N × 256 KiB / 60s`  —— N=16 时 ≈ **68 KiB/s(0.56 Mbit/s)**,
    /// > N=3 时 ≈ 13 KiB/s,N=2 时 ≈ 8.5 KiB/s。
    ///
    /// **低于该值时轮转反而更差**:16 笔各约 67s 才得一块 → 全体 stale、一笔都完不成,
    /// 而串行至少能一笔一笔做完。**这是明示的承载假设,不是被证明的性质**。
    ///
    /// 准确的一句话(codex 实现审二轮 L1 纠了我上一版的自相矛盾 —— 我一边写「低速零完成」
    /// 一边写「没造出新失败模式」):**轮转改善的是承载假设成立时的多 peer 活性;低于承载线
    /// 会引入已知的「零完成」过载退化,本版明确接受,过载调度另排**(§12.1)。
    ///
    /// 接受它的理由:①每台设备的收端窗口是 1 笔(engine 的 `MAX_ACTIVE_PULLS`),故 N ≤
    /// 席位数,而真实拓扑是 2-3 台同时取图 → 门槛降到 0.07–0.11 Mbit/s;②那条 60s 线本就是
    /// 收端「这个来源太慢,换一个」的设计动作(`fail_pull` → shun → rewant),故退化区里
    /// 系统仍在做它设计好的事,只是没人能从**本机**取成。**过载调度(维持不住全体最低进度
    /// 时收敛到少数几笔)是新机制、要动设计,不在本笔切。**
    ///
    /// 一次调用的产出有常量上界:待办 ≤ [`RELAY_SERVE_QUEUE`] 笔(见
    /// [`RelayData::peers_with_work`]),循环至多把它们各弹一次,故**至多 16 枚帧**——
    /// 要么全是 deny(行没了那一路不占窗口,可以接着取下一笔),要么若干枚 deny 加末尾
    /// 那 **1** 枚数据帧。加上 ops 那条腿之后**这个数不变**:它至多 [`OPS_TURNS_PER_CHECKPOINT`]
    /// 个回合、至多产 1 枚数据帧(且那一枚一出来两条腿都收工),故一次调用仍是
    /// 「≤16 枚 deny + ≤1 枚数据帧」,只是摸库次数多了 ≤8 次(每次 ≤64 个索引探针)。
    ///
    /// **两类数据按 1:1 轮转**(第④笔下半;§6.1 M3):上一件归谁,这一件就先问另一类;
    /// **那一类此刻没活就当场让给另一类,绝不空等**(`busy` 掉的那一类同理——它的 work
    /// 留着等心跳,不阻塞另一类)。一次调用仍**至多占上一枚窗口**。
    async fn relay_data_pump(&mut self) -> Result<Vec<Output>, String> {
        if !self.relay_up() || self.slot.relay_data.inflight.is_some() {
            return Ok(vec![]);
        }
        let mut back = vec![];
        // 1:1 的落地形:先问上一件的**另一类**。两个 `?` 里任一 `Armed` 都直接收工——
        // 窗口只有一枚。
        let ops_first = !self.slot.relay_data.last_was_ops;
        let first = if ops_first {
            self.pump_ops(&mut back).await?
        } else {
            self.pump_blob(&mut back).await?
        };
        let turn = match first {
            PumpTurn::Armed | PumpTurn::Recast => first,
            // 这一类没活:当场把机会让给另一类(**不空等**)。
            PumpTurn::NoWork => {
                if ops_first {
                    self.pump_blob(&mut back).await?
                } else {
                    self.pump_ops(&mut back).await?
                }
            }
        };
        if matches!(turn, PumpTurn::Recast) {
            // 换代了就一枚都不发,**连已攒的 deny 也丢**——它们会被旧 K_acc 封上线,与
            // [`session_wrapup`] 那条「落闸就不投」同一条纪律。
            return Ok(vec![]);
        }
        Ok(back)
    }

    /// ops 那条腿的一回合:**按 target 轮转**取一枚帧(§6.2 ⑨-4 的六条规则 + 规则⑦ 的
    /// K 检查点)。
    ///
    /// 规则落地处一一对应:
    /// * ①**帧/回合边界 round-robin**、②**BROADCAST 与定向同级**——候选名单由
    ///   [`ops_serve::OpsWorks::runnable_after`] 按 target 字典序绕圈给出,BROADCAST 只是
    ///   其中一个键,没有特权;
    /// * ③遇 `Occupied` **跳到下一个 target**,不让整枚窗口睡下;
    /// * ④单次扫描 ≤ [`ops_serve::OPS_TARGET_MAX`](表本身的上界)且取回 ≤ K 项;
    /// * ⑤各种结果下游标**一律前移**到最后检查过的那一项(不前移就每轮从表头偏置);
    /// * ⑥Ack/Nack 释放窗口后从**下一个** target 继续(游标停在刚发过那个,`runnable_after`
    ///   是「严格大于」);
    /// * ⑦**K = [`OPS_TURNS_PER_CHECKPOINT`]**:**每次真正进入 `prepare_next` 都计一次**
    ///   (`Frame`/`Spun`/`Occupied`/`Idle` 一律计),连续不出帧到 K 就停、回协调者形成
    ///   真实的公平检查点 —— **续做所有者是心跳那一拍**(第⑤笔上线 `ops_changed` 之后
    ///   改由释放方摇铃,§6.2 ④′)。
    ///
    /// **`Spun` 照样消耗一个回合**:它没往线上放一个字节,却实实在在摸了一次库(单次
    /// 至多跳 64 个已齐 origin ≈ 5 ms 持锁)。按帧记的话,一串长空转能把协调者钉住。
    ///
    /// **候选逐回合现取,不是先抓一张名单**:每跑完一回合状态就变了(游标进了 / 那份 work
    /// 空了 / 别的腿武装了它),照老名单接着跑就是拿过期事实做决策;而只有一个 runnable
    /// target 时,「名单长度」还会把 K 悄悄压成 1 —— 一份长计划就要每拍才走一格。
    async fn pump_ops(&mut self, back: &mut Vec<Output>) -> Result<PumpTurn, String> {
        let ctx = self.serve_ctx();
        for _ in 0..OPS_TURNS_PER_CHECKPOINT {
            let after = self.slot.relay_data.ops_rr.clone();
            let next = lock_ops(&self.slot.ops).next_runnable_after(after.as_deref());
            let Some(target) = next else { return Ok(PumpTurn::NoWork) };
            // 游标**先于取数**前移:无论这一回合的结果是什么,下一回合都得从它的下一个起
            // (规则⑤)。放在结果分支里写的话,`Frame` 那条早返回会把前移漏掉。
            self.slot.relay_data.ops_rr = Some(target.clone());
            match ops_prepare(&ctx, &target) {
                // 换代:一枚都不发(与 blob 那半同一条纪律)。
                OpsTurn::Recast => return Ok(PumpTurn::Recast),
                // 名单一放锁就可能过期(另一条腿在这中间武装了它 / 它的活被别人做完了):
                // 跳到下一个 target,**不让整枚窗口睡下**。
                OpsTurn::Idle | OpsTurn::Occupied => continue,
                // 空转:游标已在同一临界区里提交过,这一回合没有字节要写。
                OpsTurn::Spun => continue,
                // 取数或提交真出错 = 本机故障:**响亮收场**(与 LAN 那条腿同一条纪律,
                // 只是这边的「收场」是断本条中转会话)。
                OpsTurn::Failed(why) => return Err(format!("ops 供流取数失败:{why}")),
                OpsTurn::Frame(frame, ticket) => {
                    // 本机 origin 的那一帧要驱动持久 `last_pushed`(§6.2 ⑨-1),故序号在
                    // 发之前就绑进 `Sent`;非本机 origin 恒 `None`。
                    let own_max_seq = (frame.origin == self.cfg.device_id).then(|| {
                        frame.ops.last().expect("取数产出的帧恒非空").origin_seq
                    });
                    let msg = Msg::Ops { origin: frame.origin, ops: frame.ops };
                    self.send_relay_ops(OpsJob { own_max_seq, ticket }, &msg).await?;
                    // **BROADCAST 的 LAN 补投就在这一处**(§6.2 ① 的 (C)):权威腿发完
                    // 顺手 fan-out,与 `send_out` 的 `Auto` 臂逐字同形。定向 target 不补投
                    // ——它此刻走中转正是因为那条腿在,补投面只服务「relay 腿不在」的对端。
                    if target == BROADCAST {
                        // `delivered` 在这条腿上**明确不看**(§6.2 ①(C)):权威帧已经在
                        // 窗口里等 relay 的 Ack,补投腿一条都没成也不许回滚那枚 ticket。
                        back.extend(self.fan_out_broadcast(&msg).back);
                    }
                    return Ok(PumpTurn::Armed);
                }
            }
        }
        // **K 到限:自留一枚续做 permit**(§6.2 ④′「三件」之二)。跑到这里 = 连着 K 个回合
        // 都没出帧,但表里可能还有可尝试项 —— 回协调者形成真实的公平检查点之后,得有人把
        // 我们叫回来。第④笔那版的续做所有者是心跳那一拍(30s 量级的**兜底**,不是唤醒
        // 机制),第⑤笔起由这枚 permit 接手。
        //
        // 这不是 ④′-6 禁的那种「扫完还有活就自唤醒」热循环:那条禁的是**窗口占用期间**为
        // 领不到的 work 反复摇铃;这里窗口恰恰是空的(一枚都没武装成),permit 醒来后的
        // 那一趟扫描要么真领到活、要么扫出空名单就此打住,不会自己再摇。
        self.slot.ops_changed.notify_one();
        Ok(PumpTurn::NoWork)
    }

    /// 权威 relay 帧发出之后的 LAN 补投(§6.2 ① 的 (C) 与二轮 M5 的失败语义)。
    ///
    /// **失败绝不回滚权威 ticket**:补投腿入队失败 = 摘该腿 + 更新路由 + advisory(走
    /// [`Deck::push_lan`] 那条与本链失败**完全相同**的收口),而那一枚 relay 帧的成败
    /// 只由它自己的 Ack/Nack 说了算。结构上也保证得了:凭据此刻已经在窗口里,这个函数
    /// 根本碰不到它。
    fn fan_out_broadcast(&mut self, msg: &Msg) -> FanOut {
        let targets = self.slot.peek().map(Engine::lan_backfill_peers).unwrap_or_default();
        if targets.is_empty() {
            return FanOut { back: vec![], delivered: 0 };
        }
        // 封不出来 = 本机的问题(身份/编码),**一条腿都没投出去**。调用方据 delivered=0
        // 决定去留,这里不静默当成「投完了」。
        let Some(bytes) = self.seal_for_lan(BROADCAST, msg) else {
            return FanOut { back: vec![], delivered: 0 };
        };
        let (mut back, mut delivered) = (Vec::new(), 0usize);
        for peer in targets {
            // 两格各取各的:收口帧照旧攒进 `back`(旁链被摘也在里面),成败单记一格。
            let LanPush { outs, ok } = self.push_lan(&peer, &bytes);
            back.extend(outs);
            delivered += usize::from(ok);
        }
        FanOut { back, delivered }
    }

    /// blob 那条腿的一回合(第④笔上半的原泵体,拆成两类之后独立成函数)。
    async fn pump_blob(&mut self, back: &mut Vec<Output>) -> Result<PumpTurn, String> {
        while let Some(job) = self.slot.relay_data.pending.pop_front() {
            let idx = job.next_idx;
            // **自证身份 + 取数,同一把锁里办完**,与 LAN 写泵同口径(§6 ⑤;C′ 实现审
            // 二轮 M)。拆了循环之后单次持锁只剩一块,但这道闸照留:两次取锁之间仍有
            // 「查完身份、换代提交、再读块」那个窄窗,而块是拿 `self.cfg` 封的。
            let read = {
                let conn = self.db.lock().expect("db mutex poisoned");
                if !identity_still_current_conn(
                    &conn,
                    &self.cfg.account_id,
                    &self.cfg.device_id,
                    &self.cfg.k_acc,
                    &self.cfg.device_seed,
                ) {
                    // 换代了就一枚都不发,连已攒的 deny 也丢(由调用方统一丢弃)——它们会被
                    // **旧 K_acc** 封上线,与 [`session_wrapup`] 那条「落闸就不投」同一条
                    // 纪律。收端等 stale 换来源,而会话本身随即被外层栅栏收掉。
                    return Ok(PumpTurn::Recast);
                }
                read_blob_chunk(&conn, &job.serve, idx)
            };
            let data = match read {
                Ok(Some(data)) => data,
                Ok(None) => {
                    back.push(blob_deny_out(&job.serve));
                    continue;
                }
                Err(e) => {
                    let image_id = job.serve.image_id.clone();
                    self.set_status(|s| {
                        s.error = Some(format!("读 {image_id} 的第 {idx} 块失败:{e}"))
                    });
                    back.push(blob_deny_out(&job.serve));
                    continue;
                }
            };
            let msg = Msg::BlobChunk {
                image_id: job.serve.image_id.clone(),
                transfer: job.serve.transfer.clone(),
                idx,
                last: job.serve.is_last(idx),
                data,
            };
            self.send_relay_blob(job, &msg).await?;
            return Ok(PumpTurn::Armed);
        }
        Ok(PumpTurn::NoWork)
    }

    /// **占窗口 + 封发,同一个函数体**(codex 实现审 L1)。
    ///
    /// 「发一枚标 `ServeBlob` 的帧」与「占住窗口」必须同生共死:分开写的话,类型上谁都
    /// 能只做其中一件,而回执到达时两边就对不上了。凭据在这里发号并同时进 `Sent`,故
    /// [`Ctx::relay_blob_acked`] / [`Ctx::on_nack`] 拿回执核号就是运行期的那道闸。
    ///
    /// **先占窗口再发帧**(同 268 那条「先置 breaker 再落行」):反过来排的话,「已发出但
    /// 窗口还没占」那一瞬里任何一个泵的调用点都会再备一枚,同刻两枚数据帧在飞 —— 那正是
    /// 这枚窗口存在的意义。发失败 = 会话必收场(`send_envelope` 的写失败一路穿透到
    /// `session`),窗口由 [`session_wrapup`] 清。
    async fn send_relay_blob(&mut self, job: BlobJob, msg: &Msg) -> Result<(), String> {
        let to = job.serve.to.clone();
        let ticket = self.slot.relay_data.occupy_blob(job)?;
        self.send_relay_as(&to, Lane::Direct, msg, Some(Sent::ServeBlob { ticket, to: to.clone() }))
            .await
    }

    /// [`Deck::send_relay_blob`] 的 ops 形:**占窗口 + 封发同一个函数体**,理由逐字相同。
    ///
    /// 多出来的一件:`job` 里攥着 RAII 凭据,而 `occupy_ops` **把它移进窗口**——从此
    /// 「窗口被清」与「凭据被交回」是同一件事,不存在「窗口空了而在飞位还占着」的半态。
    /// 发失败 = 会话必收场,窗口由 [`session_wrapup`] 清,凭据随之 `Drop` 回滚。
    async fn send_relay_ops(&mut self, job: OpsJob, msg: &Msg) -> Result<(), String> {
        let target = job.ticket.target().to_string();
        let own_max_seq = job.own_max_seq;
        let ticket = self.slot.relay_data.occupy_ops(job)?;
        let kind = Sent::ServeOps { ticket, target: target.clone(), own_max_seq };
        self.send_relay_as(&target, Lane::Mail, msg, Some(kind)).await
    }

    /// 一枚待发帧落到哪条腿上(§5,一处一义)。返回值 = 投递失败的收口帧(断链通报产出的
    /// 重问),由 [`Deck::dispatch`] 接着走。
    async fn send_out(
        &mut self,
        to: &str,
        lane: Lane,
        route_hint: RouteHint,
        msg: &Msg,
    ) -> Result<Vec<Output>, String> {
        match route_hint {
            // 钉死中转:带 lan 通告的权威 Hello 只许走鉴权路(§2 单一权威路)。
            RouteHint::Require(Route::Relay) => {
                if self.relay_up() {
                    self.send_relay(to, lane, msg).await?;
                } else {
                    // 中转不在 = 丢帧。引擎此刻已知道会话断了(`on_relay_session_down` 是
                    // 会话收场的第一手),不必再通报;丢的由重连时的会话仪式补齐。
                    let text = format!("发往 {to} 的帧钉了中转,但会话不在(已丢弃)");
                    self.set_status(|s| s.lan_warning = Some(text));
                }
                Ok(vec![])
            }
            // 来路亲和的应答 / blob transfer 绑定的那条腿(§5.1:绝不静默改路)。
            RouteHint::Require(Route::Lan) => {
                if to == BROADCAST {
                    // 引擎的出口改写跳过广播帧,故这形只可能是接线漂移。
                    self.set_status(|s| {
                        s.error = Some("内部错:广播帧要求走局域网直连(已丢弃)".into())
                    });
                    return Ok(vec![]);
                }
                let Some(bytes) = self.seal_for_lan(to, msg) else { return Ok(vec![]) };
                Ok(self.push_lan(to, &bytes).outs)
            }
            RouteHint::Auto => {
                // 主路:中转在线就走中转(不变量 1「默认只走中转,唯一副本路」)。
                if self.relay_up() {
                    self.send_relay(to, lane, msg).await?;
                }
                // 补投面(§5 例外③;本机中转离线时同一条规则自然涵盖「全部 mail 走 lan」)。
                // **只 mail**:direct 的帧恒钉路由(§6),Auto+direct 只可能是接线漂移。
                if lane != Lane::Mail {
                    if !self.relay_up() {
                        self.set_status(|s| {
                            s.error = Some(format!("内部错:发往 {to} 的 direct 帧没钉路由,而中转不在(已丢弃)"))
                        });
                    }
                    return Ok(vec![]);
                }
                let targets = match self.slot.peek() {
                    None => vec![],
                    Some(engine) if to == BROADCAST => engine.lan_backfill_peers(),
                    Some(engine) if engine.lan_backfill(to) => vec![to.to_string()],
                    Some(_) => vec![],
                };
                if targets.is_empty() {
                    return Ok(vec![]);
                }
                let Some(bytes) = self.seal_for_lan(to, msg) else { return Ok(vec![]) };
                let mut back = vec![];
                for peer in targets {
                    back.extend(self.push_lan(&peer, &bytes).outs);
                }
                Ok(back)
            }
        }
    }

    /// 封一枚要走 lan 腿的帧:**同一套密文帧,只换运输管子**(§0)——同 K_acc、同域子钥、
    /// 同 AAD 五元组,外面只多一层 [`lan::LanWire::Frame`] 供收端重构 AAD。故广播帧封一次
    /// 就能投给每条链(AAD 的 `to` 恒是信封上那个)。
    ///
    /// **绝不注入 lan 通告**(§2 单一权威路):收端只认经中转 deliver 到达的通告,往 lan
    /// 帧里塞是白费字节。`None` = 封不出(帧超 1 MiB;引擎的帧上界 256 KiB 使这只可能是
    /// 本机 bug)——响亮记一笔并丢,绝不发半帧。
    fn seal_for_lan(&self, to: &str, msg: &Msg) -> Option<Arc<Vec<u8>>> {
        match seal_lan_frame(
            &self.cfg.k_acc,
            &self.cfg.account_id,
            &self.cfg.device_id,
            to,
            msg,
        ) {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                self.set_status(|s| s.error = Some(format!("内部错:局域网帧封不出({e})")));
                None
            }
        }
    }

    /// 往一条链路入队一枚已封好的帧。失败 = **断该链并通报引擎**(§5 故障隔离 +
    /// §6「`Require` 送不出必随即通报该路由 down」);返回的输出由调用方接着 dispatch
    /// (回清单的图当场重问)。
    fn push_lan(&mut self, peer: &str, bytes: &Arc<Vec<u8>>) -> LanPush {
        let LanEnqueue { evicted, outcome } = self.slot.lan.enqueue(peer, bytes);
        let ok = outcome.is_ok();
        // 顺序刻意如此:**先把已经发生的破坏性动作交代掉**,再谈本次这一笔的成败。旁链
        // 走的是与本链失败**完全相同**的那条收口(路由 down + 状态面 + 重问),受害者不是
        // 收件人而已——分两处写迟早漂(与 `on_lan_send_failed` 合并帧/供流的道理相同)。
        let mut outs = vec![];
        for (victim, err) in evicted {
            outs.extend(self.on_lan_send_failed(&victim, err));
        }
        if let Err(e) = outcome {
            outs.extend(self.on_lan_send_failed(peer, e));
        }
        LanPush { outs, ok }
    }

    /// 投不出去的收口(帧与图字节供流**共用**:两者的失败面一模一样,分两处写迟早漂)。
    fn on_lan_send_failed(&mut self, peer: &str, err: LanSendErr) -> Vec<Output> {
        match err {
            LanSendErr::NoLink => {
                // 引擎以为有这条腿而链路集里没有 = **死腿**(移交半途失败 / 断链通报丢了 /
                // 补投目标刚好同刻断了)。**当场把它从路由表抹掉并重问**(实现审 H2):
                // 只记一句告警等于把这条腿留成永久黑洞——mail 没有 stale 定时器兜底,选路
                // 会一直往这条不存在的链路投。仍不静默改走中转(§5.1 禁「凭空走」),丢的
                // 那帧由重问/hello 互补自愈。
                let outs = self
                    .slot
                    .get()
                    .map(|e| e.on_lan_leg_missing(peer))
                    .unwrap_or_default();
                self.refresh_lan_status();
                let text = format!("发往 {peer} 的帧要求局域网直连,但本机没有该链路");
                self.set_status(|s| s.lan_warning = Some(text));
                outs
            }
            LanSendErr::Failed { generation, why } => {
                // 链路已由链路集摘掉(集合是它的),引擎跟着换态。
                let outs = self
                    .slot
                    .get()
                    .map(|e| e.on_lan_link_down(peer, generation))
                    .unwrap_or_default();
                self.refresh_lan_status();
                let text = format!("与 {peer} 的局域网直连已断:{why}");
                self.set_status(|s| s.lan_warning = Some(text));
                outs
            }
        }
    }

    fn on_engine_event(&mut self, ev: Event) {
        match ev {
            // 单槽覆盖即可:去重由 [`set_status`] 的「快照没变不发事件」给出(见
            // [`SyncStatus::ops_notice`])。**不弹 toast** —— 这两档是资源面的 advisory,
            // 不是要用户当场做点什么的事。
            Event::OpsNotice { text } => self.set_status(|s| s.ops_notice = Some(text)),
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
                // 发送者,吊谁由运营者判断),状态快照在 `Deck::feed` 里随引擎照进。
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
                if !self.slot.notices.clock_skew_toasted {
                    self.slot.notices.clock_skew_toasted = true;
                    self.toast(format!(
                        "检测到另一台设备的时间比本机快约 {ahead_hours} 小时,可能让它的编辑总是「胜出」;请检查两台设备的系统时间"
                    ));
                }
                self.set_status(|s| s.clock_skew = true);
            }
        }
    }

    /// 中转腿的封帧与发送。**通告注入点就在这里**(§2「注入点在传输层封帧前」):单点,
    /// 故「哪些 Hello 带通告」不必在各调用点重复判断——会话仪式的广播 Hello、收敛的定向回
    /// Hello、将来的补发,一律经此。
    async fn send_relay(&mut self, to: &str, lane: Lane, msg: &Msg) -> Result<(), String> {
        self.send_relay_as(to, lane, msg, None).await
    }

    /// [`Deck::send_relay`] 的**显式分类**形(L-d″ 第④笔)。`kind = Some(..)` 时不按
    /// `msg` 的形状猜属于哪一类已发信封——理由见 [`Sent::ServeBlob`]:同样是
    /// `Msg::BlobChunk`/`Msg::BlobDeny`,窗口泵发出的那一枚要驱动窗口,而引擎在
    /// `on_blob_pull` 里直接产的那枚一个窗口都没占过。
    async fn send_relay_as(
        &mut self,
        to: &str,
        lane: Lane,
        msg: &Msg,
        kind: Option<Sent>,
    ) -> Result<(), String> {
        let injected = match msg {
            Msg::Hello { watermarks, lan: None } => {
                let ad = self.ad().and_then(|mut face| face.local_lan_ad());
                Some(Msg::Hello { watermarks: watermarks.clone(), lan: ad })
            }
            // 引擎产出的 Hello 恒 `None`(engine.rs 单测锚着)。真带了 = 接线漂移:原样
            // 发出去会把一枚**没落库**的序号封上线(收端从此只认更大的),响亮记一笔、
            // 把通告摘掉再发——水位该到的照到。
            Msg::Hello { watermarks, lan: Some(_) } => {
                self.set_status(|s| {
                    s.error = Some("内部错:引擎产出的 Hello 带了局域网通告(已摘除)".into());
                });
                Some(Msg::Hello { watermarks: watermarks.clone(), lan: None })
            }
            _ => None,
        };
        let msg = injected.as_ref().unwrap_or(msg);
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
        let kind = match kind {
            Some(k) => k,
            None => match msg {
                // **对账控制帧按形状认**(L-d″ 第④笔下半)。这与「`Sent` 的分类不许按
                // `msg` 形状猜」不矛盾:上半那条针对的是**同一形状两种窗口语义**(窗口泵发
                // 的 `BlobChunk` 要驱动窗口,引擎直接产的那枚一个窗口都没占过)。中转腿上的
                // Hello/Want 只有一种语义 —— 对账控制帧,`busy` 必须重试 —— 没有第二个
                // 语义相反的生产者。
                //
                // **但「谁能还债」不按形状放宽**(codex 实现审一轮 H1):只有**广播 Hello**
                // 还得动,因为债的内容就是「替所有对端重建一份水位图」,定向 Hello 只覆盖
                // 一台、Want 更不是。带的号是**发它这一刻**的债号,故一枚债挂上之前就构造好
                // 的 Hello 清不掉这笔新债。
                Msg::Hello { .. } if to == BROADCAST => {
                    Sent::ReconcileCtl { discharges: self.slot.reconcile_debt }
                }
                Msg::Hello { .. } | Msg::Want { .. } => Sent::ReconcileCtl { discharges: None },
                _ if lane == Lane::Direct => Sent::Direct { to: to.to_string() },
                _ => Sent::Other,
            },
        };
        let wire_lane = match lane {
            Lane::Mail => WireLane::Mail,
            Lane::Direct => WireLane::Direct,
        };
        self.send_envelope(to, wire_lane, blob, kind).await
    }

    async fn send_envelope(
        &mut self,
        to: &str,
        lane: WireLane,
        blob: Vec<u8>,
        kind: Sent,
    ) -> Result<(), String> {
        let RelayLeg::Up { ws, sess } = &mut self.relay else {
            return Err("内部错:中转腿不在,发不出信封".into());
        };
        sess.n += 1;
        // **收件人在这里一处记下**(见 [`Tracked`]):回执要拿它去清 unknown 怀疑标,
        // 而「这一枚投给谁」是**发送入口**的事实,不是各 `Sent` 变体的可选装饰。
        let target = (to != BROADCAST).then(|| to.to_string());
        sess.tracked.insert(sess.n, Tracked { sent: kind, target });
        let n = sess.n;
        send_client(ws, &ClientMsg::Send { n, to: to.into(), lane, blob }).await
    }

    // ---- 局域网链路的四件事:移交 / 事件 / 心跳 / 断网期定向 Hello ---------------------

    /// 移交一条握手已完成的链路(§6 三条代次契约的落地点,**唯一入口**——四步的顺序在
    /// 这个函数里,没有「调用方记得先通报再入表」的空间):
    ///   ① 仲裁与容量在**改动任何状态之前**判(败者/超额者直接关掉,引擎压根不知道);
    ///   ② `on_lan_link_up` **先**通报引擎(它据此换代、作废旧代在飞 transfer);
    ///   ③ 新链**才**进发送表(此后入队即绑这个对象);
    ///   ④ 通报产出的帧(定向 Hello / 重问 want)最后入队。
    ///
    /// 这四步在同一个协调者事件里跑完、期间不处理任何别的链路事件(**run-to-completion**:
    /// select 只在循环顶点重新选臂),故没有「新链的块被当成旧代 transfer 收下」的窗口。
    async fn lan_adopt(&mut self, adopted: AdoptedLink) -> Result<(), String> {
        // LanReady 撤位期(未配置 / 配置残缺 / 纪元封闸 / 引导中):fail-closed,直接关。
        if !self.slot.lan_ready() {
            return Ok(());
        }
        if let Err(why) = self.slot.lan.admit(&adopted.established) {
            self.set_status(|s| s.lan_warning = Some(why));
            return Ok(());
        }
        let peer = adopted.established.peer.clone();
        let Some(generation) = self.slot.lan.next_generation() else {
            self.set_status(|s| {
                s.lan_warning = Some("局域网链路代次号已用尽,本机不再接受新的直连".into())
            });
            return Ok(());
        };
        let outs = {
            let conn = self.db.lock().expect("db mutex poisoned");
            let engine = self.slot.get().expect("lan_ready 已查引擎在场");
            engine.on_lan_link_up(&conn, &peer, generation)?
        };
        let serve_ctx = self.serve_ctx();
        self.slot.lan.install(generation, &self.cfg.device_id, adopted, serve_ctx);
        // 拨号退避复位(§7):这条链**两个方向**都算——对端拨进来的链一样说明它在场,
        // 没道理还按上一轮攒起来的退避去拨它。
        self.slot.dial.on_link_up(&peer);
        self.refresh_lan_status();
        // **新消费者出现了**(§6.2 ④′ 那一段的另一半):计划表跨链路生灭活着,这条链刚接上
        // 时里面可能早就躺着它有资格消费的 work —— 而摇铃的三条来路(请求到达 / 冷却到点 /
        // 别人交回在飞位)此刻一条都不会发生。少了这一下,那些 work 要等下一拍心跳(≤30s),
        // 断 WAN 冷启动时甚至更久。摇的是**槽那根线**而不是这条链的 `ops_wake`:该唤醒谁由
        // 协调者按 [`Deck::ops_changed_tick`] 那把统一的尺子算,不在这里另判一遍。
        self.slot.ops_changed.notify_one();
        self.dispatch(outs).await
    }

    /// 一条链路上抬的事件(**唯一消费点**):先认代次——迟到的旧代事件在此丢弃,绝不让它
    /// 打掉新链、也绝不喂进引擎(§5.1 / §6 代次契约)。
    async fn lan_event(&mut self, ev: LanInbound) -> Result<(), String> {
        let LanInbound { peer, generation, event } = ev;
        let current = self.slot.lan.touch(&peer, generation);
        match event {
            _ if !current => Ok(()),
            LanEvent::Pong => Ok(()),
            LanEvent::Ping => {
                let Some(bytes) = lan_wire_bytes(&lan::LanWire::Pong {}).ok() else {
                    return Ok(());
                };
                let outs = self.push_lan(&peer, &bytes).outs;
                self.dispatch(outs).await
            }
            LanEvent::Frame { from, to, blob } => {
                match self.on_wire(Ingress::LanFrame, &from, &to, &blob).await? {
                    None => Ok(()),
                    Some(_) => {
                        // 引导帧恒走中转(§5):lan 上收到 = 对端实现漂移,拒。
                        self.set_status(|s| {
                            s.lan_warning = Some(format!("拒收 {from} 经局域网发来的引导帧"))
                        });
                        Ok(())
                    }
                }
            }
        }
    }

    /// 一条链路的死讯(**独立通道的唯一消费点**,§10):代次不符 = 早已被替换/摘掉的那条
    /// 链,引擎那边也早换代了,不必再通报。
    async fn lan_fault(&mut self, f: LanFault) -> Result<(), String> {
        if !self.slot.lan.holds(&f.peer, f.generation) {
            return Ok(());
        }
        self.lan_down(&f.peer, f.generation, &f.why).await
    }

    /// 一条链路收场:摘链 + 通报引擎(只作废该代次的在飞拉流,并当场重问)。
    async fn lan_down(&mut self, peer: &str, generation: u64, why: &str) -> Result<(), String> {
        self.slot.lan.close(peer, generation);
        let outs = self
            .slot
            .get()
            .map(|e| e.on_lan_link_down(peer, generation))
            .unwrap_or_default();
        self.refresh_lan_status();
        let text = format!("与 {peer} 的局域网直连已断:{why}");
        self.set_status(|s| s.lan_warning = Some(text));
        self.dispatch(outs).await
    }

    /// 心跳一刻的链路面(§3):静默 ≥90s 判死 + 给活着的各发一枚 Ping。**跟着 runtime
    /// 那根心跳跑**(在线离线共用),故断 WAN 期间链路照样保活、照样判死。
    async fn lan_beat(&mut self) -> Result<(), String> {
        let (dead, alive) = self.slot.lan.beats();
        for (peer, generation) in dead {
            self.lan_down(&peer, generation, "链路静默超时(90 秒无帧)").await?;
        }
        if alive.is_empty() {
            return Ok(());
        }
        let Ok(bytes) = lan_wire_bytes(&lan::LanWire::Ping {}) else { return Ok(()) };
        let mut outs = vec![];
        for peer in alive {
            outs.extend(self.push_lan(&peer, &bytes).outs);
        }
        self.dispatch(outs).await
    }

    /// 断网期的定向 Hello(§5:「本机中转离线 → 立即对全部活跃 lan 对端发一帧定向
    /// Hello、断线期间每 60s 重发」)。不对称断网时两端的水位互换**不能依赖对端事件的
    /// 新鲜度**(二轮 M5):本机主动问,来路亲和保证对端的应答沿同一条链回来。
    async fn lan_offline_hello(&mut self) -> Result<(), String> {
        let peers = self.slot.lan.peers();
        if peers.is_empty() {
            return Ok(());
        }
        let outs = {
            let conn = self.db.lock().expect("db mutex poisoned");
            let Some(engine) = self.slot.peek() else { return Ok(()) };
            let mut outs = vec![];
            for peer in &peers {
                outs.extend(engine.make_hello(&conn, peer, Route::Lan)?);
            }
            outs
        };
        self.dispatch(outs).await
    }
}

/// **通告面**(§2:唯一权威路 = 经中转 deliver 到达的 Hello)。刻意与 [`Deck`] 分开成一
/// 个更小的借用面:它要的只是「库 + 引擎(读水位)+ 状态面 + 本会话的几枚去重位」,**不要
/// socket**——通告是 advisory 面,拿不到中转腿时它整个不存在(见 [`Deck::ad`])。
struct AdDeck<'a> {
    db: &'a Arc<Mutex<Connection>>,
    status: &'a Arc<Mutex<SyncStatus>>,
    events: &'a mpsc::UnboundedSender<SyncEvent>,
    cfg: &'a SyncConfig,
    slot: &'a mut EngineSlot,
    ad: &'a mut AdFace,
}

impl AdDeck<'_> {
    fn set_status(&self, f: impl FnOnce(&mut SyncStatus)) {
        set_status(self.status, self.events, f);
    }

    fn toast(&self, msg: String) {
        let _ = self.events.send(SyncEvent::Toast(msg));
    }

    /// 吸收对端 Hello 捎带的通告。**唯一调用点在 [`Deck::feed`]**(词法锚
    /// `lan_ad_absorbed_only_from_the_single_feed_entry` 钉着):和入引擎收在同一个入口,
    /// 才不会有「lan 那条腿忘了不写缓存」的漏法——来路是 [`Ingress`],由 socket 所有者
    /// 代入,`merge_peer_ad` 对 `LanFrame` 整体忽略。
    ///
    /// 返回待发的收敛回帧(§2 触发① / 定向 Hello 的应答)。通告面的任何失败**只进
    /// [`SyncStatus::lan_warning`]**:advisory 字段绝不牵动这枚 Hello 的水位处理(§2),
    /// 也绝不占用正确性面的 `error` 槽(codex 审 M3)。
    ///
    /// `directed` = 这枚 Hello 是**定向发给本机**的(信封 `to` == 本机 device_id,不是
    /// 广播)。§2 的定向 Hello 就是一次隐式索要:「我把我的通告给你,请把你的给我」——
    /// 故即便对端早已在缓存里(不是首见、无从跃迁),也按 peer/会话应答一次。少了它,
    /// **非对称缓存永不收敛**(codex 审 M1:A 有 B 的钥、B 没有 A 的,B 索要而 A 判
    /// 「已缓存」不答,B 只能等 A 重连)。
    fn absorb_lan_ad(
        &mut self,
        from: &str,
        ad: &LanAd,
        ingress: Ingress,
        directed: bool,
    ) -> Vec<Output> {
        // 两道总闸(都只忽略通告,这枚 Hello 的水位照常处理):
        // ① 归属没对齐 = 通告面整个关掉(二审 M1:半态下发通告会让序号复用或倒退,而
        //    缓存里可能还留着上一代身份的记录);
        // ② 本机自己的通告被原样反射回来——恶意中转把本机发的 `to="*"` 密文回灌即可,
        //    AAD 合法、不需要 K_acc。**显式拒**,不赖「正常服务器不回灌发送者」这条外部
        //    行为(审 L1):写进去会污染授权缓存、诱出无意义回帧,还给日后的拨号留个自连
        //    候选。
        if !self.ad.ready || from == self.cfg.device_id {
            return vec![];
        }
        let now_ms = crate::clock::wall_now_ms();
        let mut outs: Vec<Output> = vec![];
        let solicited = lan_ad_answer_needed(directed, ingress, self.ad.answered.contains(from));
        let merged = {
            let conn = self.db.lock().expect("db mutex poisoned");
            let engine = self.slot.peek().expect("feed 已过 booting 闸");
            let mut go = || -> Result<Option<lan::StoreCause>, String> {
                let cached = read_peer_ad(&conn, from)?;
                match lan::merge_peer_ad(cached.as_ref(), ad, ingress, now_ms) {
                    lan::AdMerge::Ignore(_) => {
                        // 已在缓存里(序号不新 / 已禁用):唯一还要出帧的情形 = 对端定向
                        // 索要。禁用的对端也答——本机通告没什么可保密的,且不答会让对端
                        // 每会话白问一次。
                        if solicited {
                            outs.extend(engine.make_hello(&conn, from, Route::Relay)?);
                        }
                        Ok(None)
                    }
                    lan::AdMerge::Malformed(why) => Err(format!("局域网通告不合法:{why}")),
                    lan::AdMerge::Store { record, cause } => {
                        // 硬容量闸只挡**新记录**(二审 M2):已在册的序号推进与冲突禁用
                        // 照写——满额绕掉粘滞禁用才是真事故。
                        if cause == lan::StoreCause::FirstSeen
                            && count_peer_ads(&conn)? >= MAX_LAN_PEER_RECORDS
                        {
                            return Err(format!(
                                "局域网通告缓存已满({MAX_LAN_PEER_RECORDS} 条):新对端的直连不可用,中转同步照常"
                            ));
                        }
                        // **先备好回帧、再落库**(codex 审 M4):`FirstSeen` 是收敛的唯一
                        // 一次性跃迁,落库成功而回帧生成失败 = 跃迁被吃掉、此后只剩
                        // Advanced,那台对端再也等不到本机通告(除非本机重连)。这一颠倒
                        // 让「跃迁已消费而回帧不存在」在任何失败点都造不出来。
                        let reply: Vec<Output> = if lan_ad_reply_needed(cause) || solicited {
                            // 定向回 Hello 走**鉴权路**(§2:带通告的权威 Hello 只许经
                            // 中转,LAN 到达的 lan 字段收端整体忽略,发过去等于没发)。
                            engine.make_hello(&conn, from, Route::Relay)?
                        } else {
                            vec![]
                        };
                        write_peer_ad(&conn, from, &record)?;
                        outs.extend(reply);
                        Ok(Some(cause))
                    }
                }
            };
            go()
        };
        // 锁已放:下面才碰状态面(status 锁不与 db 锁嵌套)。
        // 限频位只记「应答过索要」这件事,**不记触发① 的回帧**:① 每对端一生一次,拿它
        // 顺手把索要额度也花掉的话,那一帧万一丢了(对端正引导 / 中转丢帧),对端此后
        // 索要就再也没人答——非对称缓存又卡住了(codex 审 M1 要修的正是这个)。
        if solicited && !outs.is_empty() {
            self.ad.answered.insert(from.to_string());
        }
        match merged {
            // 首见钉住 / 序号推进 / 不新的重复投递:正常路径,不打扰用户。
            Ok(None) => {}
            Ok(Some(lan::StoreCause::FirstSeen)) | Ok(Some(lan::StoreCause::Advanced)) => {
                // **新通告 = 退避复位**(§7 明写的三条复位信号之一;codex 二轮 M1:只
                // `kick()` 把计时器拨到现在没用——巡查照样被这台对端自己的退避挡住,
                // 「新 IP 不必等 300s」就成了空话)。首见给了公钥、推进给了新落点,两种
                // 都是「它此刻大概在场」的强信号。
                self.slot.dial.kick_peer(from);
            }
            Ok(Some(lan::StoreCause::KeyConflict)) => {
                // 同 id 异钥只能是攻击或克隆(正常换钥必换 device_id 或走纪元轮换):
                // 该对端直连已**粘滞禁用**并落库。提示每会话一次,清单进状态面常驻
                // (装配时从缓存重检,故跨重启仍在)。
                if self.ad.conflict_reported.insert(from.to_string()) {
                    self.toast(format!(
                        "设备 {from} 的局域网身份钥与首次记下的不一致,已停用与它的直连(需人工核查)"
                    ));
                }
                let peer = from.to_string();
                self.set_status(|s| {
                    if !s.lan_disabled.contains(&peer) {
                        s.lan_disabled.push(peer);
                        s.lan_disabled.sort();
                    }
                });
            }
            Err(e) => {
                if self.ad.warned.insert(from.to_string()) {
                    self.set_status(|s| s.lan_warning = Some(format!("{from}:{e}")));
                }
            }
        }
        outs
    }

    /// §2 收敛触发②:服务器说某对端在线、而本机**没有**它的验证钥 → 定向 Hello 把本机
    /// 通告送过去(按 peer / 会话限频一次)。双盲(两端都缺对端公钥)时这是加速解锁点
    /// ——对方收到即钉住,并按触发① 回一帧;两侧的 ② 对称。
    ///
    /// 它只是**加速**:对端正在引导时这一帧被整帧丢弃(模块注释),收敛的保证归触发①
    /// ——对端引导完的会话仪式必广播一枚带通告的 Hello,本机首见钉住即回一帧。
    ///
    /// 缓存**在册但被冲突禁用**的对端不发:粘滞禁用只有换 device_id 或纪元轮换才解,
    /// 再问也无用。
    fn lan_hello_if_key_missing(&mut self, peer: &str) -> Vec<Output> {
        if !self.ad.ready || self.ad.asked.contains(peer) || self.slot.peek().is_none() {
            return vec![];
        }
        let made = {
            let conn = self.db.lock().expect("db mutex poisoned");
            match read_peer_ad(&conn, peer) {
                Err(e) => Err(e),
                Ok(Some(_)) => Ok(None),
                Ok(None) => self
                    .slot
                    .peek()
                    .expect("上一行已查在场")
                    .make_hello(&conn, peer, Route::Relay)
                    .map(Some),
            }
        };
        match made {
            Ok(None) => vec![],
            Ok(Some(outs)) => {
                self.ad.asked.insert(peer.to_string());
                outs
            }
            Err(e) => {
                if self.ad.warned.insert(peer.to_string()) {
                    self.set_status(|s| s.lan_warning = Some(format!("{peer}:{e}")));
                }
                vec![]
            }
        }
    }

    /// 本机这一枚 [`LanAd`](§2)。序号在**本会话首次封发 Hello** 时递增并落库;其后同一
    /// 会话内**只要 listen 没变就重用**(定向回 Hello 也重用)。listen 一变即换号——
    /// 「序号绑内容」的理由见 [`AdFace::published`]。
    fn local_lan_ad(&mut self) -> Option<LanAd> {
        if self.ad.off || !self.ad.ready {
            return None;
        }
        let listen = self.slot.lan.listen.clone();
        let reuse = match &self.ad.published {
            Some((seq, published)) if *published == listen => Some(*seq),
            _ => None,
        };
        let seq = match reuse {
            Some(seq) => seq,
            None => {
                let bumped = {
                    let conn = self.db.lock().expect("db mutex poisoned");
                    bump_ad_seq(&conn)
                };
                match bumped {
                    Ok(seq) => {
                        self.ad.published = Some((seq, listen.clone()));
                        seq
                    }
                    Err(e) => {
                        // 到 u64::MAX(绝不回绕)或落库失败:本设备通告停用,Hello 照发。
                        self.ad.off = true;
                        self.set_status(|s| s.lan_warning = Some(e));
                        return None;
                    }
                }
            }
        };
        Some(LanAd { pubkey: pubkey_of(&self.cfg.device_seed).to_vec(), ad_seq: seq, listen })
    }
}

/// 离线期的投递面(没有中转腿):`run` 与 [`offline_wait`] 用它 dispatch 心跳、本地结算、
/// 链路事件产出的帧——L-c2a 那轮这些帧「无腿可走被丢」,有了 lan 腿它们才真送得出去。
fn offline_deck<'a>(
    t: &'a Transport,
    cfg: &'a SyncConfig,
    slot: &'a mut EngineSlot,
) -> Deck<'a> {
    Deck {
        db: &t.db,
        clock: &t.clock,
        status: &t.status,
        events: &t.events,
        cfg,
        slot,
        relay: RelayLeg::Down,
    }
}

impl Ctx<'_> {
    /// 借出投递面(会话内恒是 `Up` 形:socket 与信封序号都在手)。
    fn deck<'a>(&'a mut self, ws: &'a mut Ws) -> Deck<'a> {
        Deck {
            db: &self.db,
            clock: &self.clock,
            status: &self.status,
            events: &self.events,
            cfg: self.cfg,
            slot: &mut *self.engine,
            relay: RelayLeg::Up { ws, sess: &mut self.sess },
        }
    }

    async fn dispatch(&mut self, ws: &mut Ws, outs: Vec<Output>) -> Result<(), String> {
        self.deck(ws).dispatch(outs).await
    }

    fn set_status(&self, f: impl FnOnce(&mut SyncStatus)) {
        set_status(&self.status, &self.events, f);
    }

    fn toast(&self, msg: String) {
        let _ = self.events.send(SyncEvent::Toast(msg));
    }

    /// 引导中吗(引擎槽空 = 还没拿到首份快照)。
    fn booting(&self) -> bool {
        self.engine.booting()
    }

    /// **中转会话仪式**并宣告在线(§6):装配引擎(引导刚完成的路;正常路早在
    /// `run` 里装配好了)→ 结算本地 op → 游标复位到已 ack 位 + 只重置 relay 维度 +
    /// 广播 hello 与缺图 want(一次原子仪式,实现审 H1)→ 补喂引导期攒的在线快照 →
    /// 推送离线期间攒下的本地 op → 隔离行升级重验。引导完成后**必须**经此(boot.rs
    /// 接线契约)。
    async fn relay_session_up(&mut self, ws: &mut Ws) -> Result<(), String> {
        let known_peers: Vec<String> = self.peers.iter().cloned().collect();
        let (hello_outs, push_outs, pushed, reverify_outs, reverified, poison) = {
            let mut conn = self.db.lock().expect("db mutex poisoned");
            let mut clk = self.clock.lock().expect("clock mutex poisoned");
            self.engine.reconcile(&conn, self.cfg)?;
            // 「每会话弹一次」的提示位随会话复位(L-c2a 那条线;位子住在槽里是因为断网期
            // 也要有个地方记,见 [`EngineSlot::notices`])。
            self.engine.notices = Notices::default();
            let engine = self.engine.get().ok_or("引导已提交但引擎未装配(bootstrapped_at 缺席?)")?;
            // 出站游标复位与本地删除结算都收在这一个会话仪式入口里(§6 / 实现审 H1):
            // acked = sync_meta 里服务器已确认过的位置,「已发未 ack」的 op 由此在重连
            // 后重推。
            let mut hello = engine.on_relay_session_up(&conn, read_last_pushed(&conn)?)?;
            // 引导期间收到过的在线快照/上线事件补进路由表(§5.1:(X,Relay)=Up 须
            // 「会话在 ∧ X 在线」两层成立,故**必在 session_up 之后**)——漏了它,引导
            // 完成后这些对端的 blob 选路会以为无路可走,图字节要等下一次 Peer 事件才拉。
            for peer in &known_peers {
                hello.extend(engine.on_relay_peer_up(peer));
            }
            let mut push = vec![];
            let pushed = engine.outbound(&conn, &mut push);
            // 升级重验状态机(§4):校验器升过版就对隔离行重跑——修好的误判自助
            // 恢复(op 归池 + want 追帧),仍非法的抬版本保留。
            // 输出交由调用方持有(同轮 H1):Err 也不丢已提交的义务——这里的 `?` 会把
            // 整个会话仪式收场,而 `reverify` 里已累计的那些 want 就是靠它带出去的。
            let mut reverify = vec![];
            let reverified = engine.reverify_quarantined(&mut conn, &mut clk, &mut reverify);
            let poison = engine.poison_status();
            (hello, push, pushed, reverify, reverified, poison)
        };
        // **引导刚完成那一跳的 LanReady 置位**(§6):引擎是上面这一行才装配起来的,而
        // `run` 顶的准入表对齐早在引导之前跑过、当时槽还空着。漏了这一次,刚入伙的设备
        // 要等到下一次中转重连才收得下直连——那个窗口可以是几小时。已注册的空间在这里
        // 是幂等续注册(同注册者同指纹不换代),故正常路每会话跑一次也不扰动在飞握手。
        lan_sync_admission(
            self.seat.clone().as_ref(),
            self.engine,
            &self.db,
            &self.status,
            &self.events,
            self.cfg,
        );
        // 中转重连 = 拨号退避**全部复位**(§7)。中转回来了通常意味着网络刚变过(换了
        // wifi / 路由器重启),攒到 300s 的退避此刻已无意义;新落点随之而来的通告也会
        // 各自 kick 一次,两条触发不互斥。
        self.engine.dial.kick_all();
        self.set_status(|s| {
            s.state = "online".into();
            s.error = None;
            s.quarantined = poison.0;
            s.poison_breaker = poison.1;
        });
        self.dispatch(ws, hello_outs).await?;
        self.dispatch(ws, push_outs).await?;
        // 同重验那条(H1):**先投再判** —— `outbound` 已经登记进计划表的义务,不许被它
        // 自己那半的错误连带吞掉。
        pushed?;
        // 先把已累计的义务投出去,再看重验本身成没成(同轮 H1):顺序反了的话,
        // 一次本地故障会连带丢掉这一批里已经放行那几行的追帧 want。
        self.dispatch(ws, reverify_outs).await?;
        reverified?;
        // **新会话建立后唤醒跨会话保留的活**(§6.2 ⑨-8 第三条;L-d″ 第④笔下半):窗口与
        // 待办都住在槽里、跨会话存活,而上一条会话收场时窗口是被**清空**的 —— 没有这一下,
        // 那些 work 只能等下一拍心跳(≤30s)或下一枚偶然的新 pull。ops 那半同理:计划表
        // 在槽里原样留着,新会话一起来就该接着供。
        let resume = self.deck(ws).relay_data_pump().await?;
        self.dispatch(ws, resume).await?;
        // ops 那半走同一条唤醒线(§6.2 ④′「消费者重新出现时也要唤醒」):**不只 BROADCAST**
        // ——断 WAN 期间攒下的定向 work 也在表里躺着,而中转刚回来正是它们最该被服务的时候。
        // `relay_data_pump` 只顾得上一枚窗口,这一声才把「还有谁能被叫醒」问全。
        self.engine.ops_changed.notify_one();
        Ok(())
    }

    /// 窗口里那一枚块被服务器接手:该笔供流推进一块、回待办**队尾**,随即泵下一枚
    /// (L-d″ 第④笔)。
    async fn relay_blob_acked(
        &mut self,
        ws: &mut Ws,
        ticket: RelayDataTicket,
    ) -> Result<(), String> {
        // 凭据对不上 / 窗口是空的 = 接线漂移,响亮(见 [`RelayData::take_inflight`])。
        let mut job = self.engine.relay_data.take_blob(ticket)?;
        let last = job.serve.is_last(job.next_idx);
        job.next_idx += 1;
        if !last {
            self.engine.relay_data.requeue(job);
        }
        let outs = self.deck(ws).relay_data_pump().await?;
        self.dispatch(ws, outs).await
    }

    /// 窗口里那一枚 ops 帧被服务器接手(L-d″ 第④笔下半)。
    ///
    /// **顺序是本函数的全部内容**(§6.1「`ServeOps` 承载本机 origin 时的顺序」+ §6.2 ⑨-1):
    /// ①取回窗口 → ②**先把 `last_pushed` 落库** → ③成功之后**才**提交 work 游标 →
    /// ④再泵下一枚。(unknown 清标已经在 [`Ctx::on_ack`] 那一处对**所有**带 target 的回执
    /// 统一做掉了,codex 实现审一轮 M1;这里不再各做一份。)
    ///
    /// 反过来排(先提交游标后落库)就会出现「游标说发过了、库说没接手」:下次会话仪式
    /// 从持久 `last_pushed` 重载,那段 op 再没有人发。而落库失败时凭据还在 `job` 手上,
    /// 随着这一路 `Err` 返回被 `Drop` **交回 rollback**——游标一步没动,会话收场重发。
    async fn relay_ops_acked(
        &mut self,
        ws: &mut Ws,
        ticket: RelayDataTicket,
        own_max_seq: Option<i64>,
    ) -> Result<(), String> {
        let job = self.engine.relay_data.take_ops(ticket)?;
        if let Some(max_seq) = own_max_seq {
            let conn = self.db.lock().expect("db mutex poisoned");
            bump_last_pushed(&conn, max_seq)?;
        }
        job.ticket.commit()?;
        let outs = self.deck(ws).relay_data_pump().await?;
        self.dispatch(ws, outs).await
    }

    /// `unknown_device` 的**跨代探针**(§6.1 八轮 H1 + 九轮 M1;只对定向 `ServeOps`)。
    ///
    /// 三步:①首次只记下当时的中转 generation,**工作照留**——发送者被旧连接顶替那一档
    /// 里,重连后第二次发送即 Ack,一点工作都不该丢;②同一代的尾帧不算第二击;③**更晚
    /// 一代仍 unknown** = 那台真的不在 registry 了,取消该 target 的 relay work 并**响亮
    /// 报一次**(丢同步工作不许静默)。少了第三步,「结束会话 → 跨会话 work 续做 → 又
    /// unknown」就是永久重连循环。
    ///
    /// 会话不在(引擎没装配 / 刚断)时不探:那时既没有 generation 可记,也没有「下一代
    /// 重试一次」的语义;标记留着不动,下一个真会话里再判。
    fn probe_unknown_target(&mut self, target: &str) {
        let Some(generation) = self.engine.peek().and_then(Engine::relay_session_generation) else {
            return;
        };
        let verdict = lock_ops(&self.engine.ops).note_unknown(target, generation);
        if verdict == ops_serve::UnknownVerdict::Cancelled {
            self.set_status(|s| {
                s.lan_warning = Some(format!(
                    "换了一条会话仍不认识 {target}:已取消它的 op 追赶供流"
                ))
            });
        }
    }

    /// Nack 的处置:**先按 `code` 分发,再按 `Sent` 细分**(§6.1 八轮 M1)。
    ///
    /// 原来的形是反的 —— 顶层 match 的是 `Sent`,`code` 全程只有一处 `let _ = code;`。
    /// 于是**任何** Nack 落在 `Sent::Direct` 上都被读成「该对端此刻不在线」,连 `busy`
    /// 也会错误打掉一条对端的中转路由。第④笔建统一的数据窗口时必须一并改:留着旧解释,
    /// 同一个 code 就会在相邻两个分支里拥有相反语义。
    ///
    /// **`unknown_device` 恒 session-fatal**(§6.1 八轮定形):服务端拿同一个 code 表达
    /// 三件事,其中两件(`from` 不在 registry / 本连接已不是该设备的当前在线连接)是
    /// **发送者自己**的问题,而线上那个 code 一个字节都不带来源。fail-closed = 释放窗口、
    /// 游标不提交、响亮收场。
    ///
    /// **`ServeOps` 与 `ReconcileCtl` 两行在第④笔下半接齐**,第⑤笔起两条都在生产路径上
    /// 跑:前者由 `on_hello` / `on_want` / `outbound` 登记的义务喂出来,后者是 Hello 与
    /// ops Want 本身。
    async fn on_nack(&mut self, ws: &mut Ws, sent: Option<Sent>, code: &str) -> Result<(), String> {
        // ① 「每条 Send 必有恰一枚回执」是 `tracked` 自排水的全部依据,破了就别猜。
        //    **排在最前**(codex 实现审 8):原先它排在 `unknown_device` 之后,于是一枚
        //    「n 不在册」会被先诊断成身份失权 —— 收场动作虽同,报出来的原因是错的。
        let Some(sent) = sent else {
            return Err(format!("内部错:收到 n 不在册的 Nack({code})"));
        };
        // ② 窗口先释放,且在任何别的 `?` 之前:一枚送不出去的收口帧不该把窗口永久留在
        //    「在飞」(§6.1 六轮 H2 的同一条)。`busy` 保留 work 等心跳重试,其余作废本笔。
        //    **凭据对不上 / 窗口本来就空 = 响亮**,与 Ack 那一路对称(codex 实现审 L1:
        //    原先这里 `inflight` 为空时静默成功,等于无声丢掉一笔 work)。
        match &sent {
            Sent::ServeBlob { ticket, .. } => {
                let job = self.engine.relay_data.take_blob(*ticket)?;
                if code == err_code::BUSY {
                    self.engine.relay_data.requeue(job);
                }
            }
            Sent::ServeOps { ticket, target, .. } => {
                // 取回即**回滚**:Nack 一律不推进游标,那份 work 原样留在计划表里 ——
                // 「busy 保留 work」因此是结构事实,不需要像 blob 那样再 requeue 一次
                // (blob 的续做态在描述符里,ops 的在游标里)。
                //
                // **静默交回**(不摇 `ops_changed`):裸 `Drop` 会摇铃,而铃响 = 协调者当场
                // 扫一遍 idle-runnable 再泵 —— 这一枚刚被 Nack 的 work 立刻又合格,于是
                // 「发→Nack→发」就是热循环,正撞第④笔钉死的那条(§6.1 `ServeOps` 行:
                // busy **释放窗口 / 不推进游标 / 保留 work / 不许当场重发**)。
                //
                // ⚠ 与 §6.2 ④′「每一次 occupied→free 都 notify」有出入,是**刻意的收窄**:
                // 那条的目的是「别让 `Occupied` 变成永久停摆」,而这条路的续做所有者写得死
                // ——心跳那一拍的 `relay_data_pump`(与 blob 腿 busy 后的做法逐字相同),
                // 停摆有界。反过来照摇的话换来的是无界重发,两害相权。
                //
                // **对所有 code 都静默**,不只 `busy`:`not_online`(对端此刻不在线)与
                // `unknown_device`(收场重连)当场重发同样只会再撞一次同样的 Nack。
                self.engine.relay_data.take_ops(*ticket)?.ticket.rollback_quiet()?;
                // **本拍让位给直连,并当场摇它的铃**(codex 实现审二轮 H)。
                //
                // 光「不摇 `ops_changed`」不够:下一次唤醒(心跳 sweep / 别处摇的铃)里
                // `relay_data_pump` 是**同步**跑在摇 LAN 铃之前的,当场就把这枚在飞位重新
                // 占回去了 —— `notify_one` 不产生调度检查点(第②笔那条「自己摇铃不算让出」
                // 的老坑,**第三次**)。于是「中转会话稳定在、数据面持续 busy、直连稳定
                // 可用」时,LAN 确定性地永远只拿得到 `Occupied`。
                //
                // 两件缺一不可:`yield_relay` 把它从**中转腿的**候选枚举里摘一拍(结构上
                // 让位,不指望赢竞速),`wake_ops` 把这一拍的机会真交到直连腿手上(不然要
                // 白等到下一拍心跳)。让位由下一拍 `Deck::ops_tick` 的第一句收回,故没有直连腿时退化成
                // 原来的「保留 work,等心跳 relay 重试」,一拍不多。
                //
                // **BROADCAST 不让位**(§6.2 ①):本机 origin 只许权威完成腿消费。
                if target != BROADCAST {
                    lock_ops(&self.engine.ops).yield_relay(target);
                    self.engine.lan.wake_ops(target);
                }
            }
            _ => {}
        }
        // 同 target 的阳性证据清 unknown 怀疑(§6.1 九轮 M1 ②)**不在这里**:它与 Ack
        // 那条路合并到了 [`Ctx::handle_server`] 的一处(codex 实现审二轮 M1),判据取
        // `Tracked::target` 而不是「这枚 `Sent` 变体碰巧带没带 to」。
        // ③ unknown_device 对**所有** `Sent` 变体一律结束会话(含引导两格)。
        if code == err_code::UNKNOWN_DEVICE {
            // 跨会话存活的**定向** `ServeOps` 另配一枚有限探针(§6.1 八轮 H1):不然
            // 「结束会话 → work 跨会话续做 → 又 unknown」就是永久重连循环。BROADCAST 与
            // 本机 outbound **不探**——它们没有「目标被移除」这种解释,未 Ack 段照留。
            if let Sent::ServeOps { target, .. } = &sent {
                if target != BROADCAST {
                    self.probe_unknown_target(target);
                }
            }
            self.engine.relay_data.clear();
            return Err(format!("服务器回 {code}:本连接的设备身份此刻不被承认,收场重连"));
        }
        match sent {
            // ④ not_online 是**唯一**允许标 peer down 的 code(§6.1 八轮 M1)。
            Sent::BootReq if code == err_code::NOT_ONLINE => {
                // 请求对象不在线(刚掉线的竞态):换一台。
                self.boot_rotate();
                self.try_boot_request(ws).await?;
            }
            Sent::BootOut if code == err_code::NOT_ONLINE => {
                // 接收方掉线:作废供流,删临时快照(drop 先落 File 句柄再删)。
                if let Some(bo) = self.boot_out.take() {
                    discard_boot_out(bo);
                }
            }
            Sent::Direct { to } | Sent::ServeBlob { to, .. } if code == err_code::NOT_ONLINE => {
                // 服务器投不到 = 该对端此刻不在线:只是它的**中转腿**不可达(§6 对端级),
                // lan 腿与惩罚都不该被连带;作废的在飞拉流由入口自带的 want 另寻来源。
                // 该对端**待办里那一笔**(若有)不在这里清:它下次被泵到时会再撞一枚
                // `not_online` 而各自作废,故队列自排水、不需要第二处清理。**代价写准**
                // (codex 二轮 L1):不止「一枚帧」——还可能要等下一拍心跳才重泵,且满额
                // 期间会有短暂的 deny→rewant churn。有界,且不会再让旧整图续跑,故接受;
                // `Peer{online:false}` 的主动清理留到下一笔连同 ops 那条腿一起决定。
                let outs =
                    self.engine.get().map(|e| e.on_relay_peer_down(&to)).unwrap_or_default();
                self.dispatch(ws, outs).await?;
            }
            // ④ ReconcileCtl 撞 busy:**只置一枚位**(§6.1 九轮 H1)。不保存整帧、不保存
            //    水位图 —— 重发的内容由下一拍心跳([`Deck::reconcile_tick`])重新构造,
            //    故不会把一枚过期的水位图重放上线;再次 busy 仍保留该位,**Ack 后才清**。
            //    **刻意不在这里立即重发**:那就是热循环(与 `ServeBlob` 同一条纪律)。
            Sent::ReconcileCtl { .. } if code == err_code::BUSY => {
                // **换新号**(codex 实现审一轮 H1):此刻已在飞的那些广播 Hello 都是这笔债
                // 挂上**之前**构造的,它们的 Ack 一律不算还这一笔。代价至多是下一拍再发
                // 一枚,而反过来(复用旧号)就是把「服务器没接手」这件事静默销账。
                self.engine.set_reconcile_debt()?;
            }
            // ④ busy:**一格都不标 peer down**。引导两格由既有的 30s 步超时 + 换源兜住;
            //    `Direct`(BlobPull/BlobDeny)与 `Other`(BlobWant/BlobHave)由既有的
            //    stale / 重问轴自愈;`ServeBlob`/`ServeOps` 的 work 上面已保留,续做挂心跳
            //    —— **刻意不在同一个 Nack 事件里立即重泵**,那就是热循环。
            //    **busy 的那一类不阻塞另一类**:窗口已在 ② 里释放,下一拍心跳的泵按 1:1
            //    先问另一类,故一条 ops 的 busy 不会挡住图字节,反之亦然。
            _ if code == err_code::BUSY => {}
            // ⑤ mail lane 收到 not_online = 协议漂移(服务端只对 direct 指名帧回它),
            //    未知 code = 将来的服务器漂移。两者都响亮收场,不静默。
            _ => return Err(format!("服务器回了处置不了的 Nack code:{code}")),
        }
        Ok(())
    }

    /// 这一枚回执的收件人还在册的**阳性证据**:清掉它的 `unknown_device` 怀疑标。
    /// 广播帧([`Tracked::target`] 为 `None`)与不在册的回执一律不清。
    fn clear_unknown_for(&mut self, tracked: &Option<Tracked>) {
        if let Some(t) = tracked.as_ref().and_then(|t| t.target.as_deref()) {
            lock_ops(&self.engine.ops).clear_unknown(t);
        }
    }

    /// 回执的处置(`unknown` 清标已由调用方一处做完,见 [`Ctx::clear_unknown_for`])。
    async fn on_ack(&mut self, ws: &mut Ws, sent: Option<Sent>) -> Result<(), String> {
        match sent {
            Some(Sent::ServeBlob { ticket, .. }) => self.relay_blob_acked(ws, ticket).await,
            Some(Sent::ServeOps { ticket, own_max_seq, .. }) => {
                self.relay_ops_acked(ws, ticket, own_max_seq).await
            }
            // 对账控制帧被服务器接手 = 那笔债还清了(§6.1 九轮 H1:**只有它的 Ack 才清**,
            // 构造成功 / 入队成功 / `send_client` 返回成功都不算;而「它」到底是哪一枚,
            // 由 `discharges` 带的债号说了算,见 [`Sent::ReconcileCtl`])。
            Some(Sent::ReconcileCtl { discharges }) => {
                // 号对上才清:`None`(普通 Want / 定向 Hello)与旧号(债挂上之前构造的
                // 那枚)都不算还债。**不响亮**——这不是接线漂移,是本来就允许的交错(与
                // 数据窗口那两只 `take_*` 的响亮不同:那边同刻至多一枚,对不上就只可能是
                // 接错线)。
                if discharges.is_some() && discharges == self.engine.reconcile_debt {
                    self.engine.reconcile_debt = None;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    // ---- 服务器消息分发 ----

    async fn handle_server(&mut self, ws: &mut Ws, msg: ServerMsg) -> Result<(), String> {
        match msg {
            ServerMsg::Deliver { from, to, blob } => self.on_deliver(ws, &from, &to, &blob).await,
            // **同 target 的阳性证据两条路一处清**(codex 实现审一、二轮 M1)。Ack 恒是
            // 阳性:服务端验过那台的 registry 并接手了这一枚。`busy`/`not_online` 同理
            // ——服务端也是验过之后才回得出它们;`unknown_device` 当然不在其列,它正是
            // 那条负面证据。判据取 [`Tracked::target`],与这一枚是什么 `Sent` 无关。
            ServerMsg::Ack { n } => {
                let t = self.sess.tracked.remove(&n);
                self.clear_unknown_for(&t);
                self.on_ack(ws, t.map(|t| t.sent)).await
            }
            ServerMsg::Nack { n, code } => {
                let t = self.sess.tracked.remove(&n);
                if code == err_code::BUSY || code == err_code::NOT_ONLINE {
                    self.clear_unknown_for(&t);
                }
                self.on_nack(ws, t.map(|t| t.sent), &code).await
            }
            ServerMsg::Peer { device, online } => {
                if online {
                    // 对端级 relay 连接态的**唯一**置位路径(§6 三轮 M1):不许拿
                    // 「收到过它的帧」当在线证据——mail 可能来自信箱,发送者早已离线。
                    let outs =
                        self.engine.get().map(|e| e.on_relay_peer_up(&device)).unwrap_or_default();
                    self.dispatch(ws, outs).await?;
                    // §6.2 ⑦ 的第四件:给它的追赶计划发一枚一次性加速券。**只发券、不摇铃**
                    // ——券不改变可跑性,效果兑现在下一枚 Hello 或下一拍心跳上。形态不合
                    // (`ServerMsg::Peer.device` 在线协议里仍是裸 `String`)= 服务端协议漂移,
                    // 响亮结束当前 session。
                    let mut ops = vec![];
                    let admitted = match self.engine.get() {
                        None => Ok(()),
                        Some(e) => e.on_peer_online_ops(&device, &mut ops),
                    };
                    self.dispatch(ws, ops).await?;
                    admitted?;
                    // §2 收敛触发②:它在线而本机缺它的验证钥 → 定向回一帧本机通告。
                    let outs = self
                        .deck(ws)
                        .ad()
                        .map(|mut face| face.lan_hello_if_key_missing(&device))
                        .unwrap_or_default();
                    self.dispatch(ws, outs).await?;
                    // §7 拨号时机之三:服务器说它上线了 = 它刚起来的强信号,该复位它那份
                    // 退避当场再拨一次(它上一轮可能正好在重启,把本机的退避拖到了 300s)。
                    self.engine.dial.kick_peer(&device);
                    if !self.peers.contains(&device) {
                        self.peers.push_back(device);
                    }
                } else {
                    self.peers.retain(|d| d != &device);
                    let outs =
                        self.engine.get().map(|e| e.on_relay_peer_down(&device)).unwrap_or_default();
                    self.dispatch(ws, outs).await?;
                    // §5/二轮 M5:对端的中转腿刚没了,而 lan 腿可能正通着——当场沿 lan
                    // 定向问一枚 Hello 互换水位,不等对端事件的新鲜度(它已经不新鲜了)。
                    if self.engine.peek().is_some() && self.engine.lan.count() > 0 {
                        let outs = {
                            let conn = self.db.lock().expect("db mutex poisoned");
                            let engine = self.engine.peek().expect("上一行已查");
                            match engine.lan_backfill(&device) {
                                true => engine.make_hello(&conn, &device, Route::Lan)?,
                                false => vec![],
                            }
                        };
                        self.dispatch(ws, outs).await?;
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

    /// 中转腿到达的一枚密文帧。**来路由本 socket 的所有者在此代入**(§2/§5:来路是传输层
    /// 内部事实,绝不取自对端字段)——服务器已鉴权 `from` + AAD 双保险,这一条正是「唯一
    /// 权威路」的字面。引导帧由投递面交回,在这里进引导编排。
    async fn on_deliver(
        &mut self,
        ws: &mut Ws,
        from: &str,
        to: &str,
        blob: &[u8],
    ) -> Result<(), String> {
        match self.deck(ws).on_wire(Ingress::RelayDeliver, from, to, blob).await? {
            None => Ok(()),
            Some(bm) => self.on_boot_msg(ws, from, bm).await,
        }
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
        self.deck(ws).send_envelope(&target.clone(), WireLane::Direct, blob, Sent::BootReq).await?;
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
                // 事务内 integrity 已过、relay_session_up **之前** take+send。receiver
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
                // 库已提交,先通知本地读库再碰网络(codex 实现审 M1):relay_session_up
                // 里的 hello/push 可失败提前返回,事件排它后面 = 名字落了库、壳却
                // 到重启才知道。事件只驱动本地重读,不依赖网络恢复。
                let _ = self.events.send(SyncEvent::Changed);
                // boot 物化绕过 apply_remote_op(§4.7 三入口之二,codex 二轮 H2):
                // 名字可能随快照刚到,专用事件让壳刷空间名(无名也无害,只是重读)。
                let _ = self.events.send(SyncEvent::SpaceNameChanged);
                // 接线契约:导入抬了水位,必须装配引擎再走会话仪式(boot.rs 注释)。
                self.relay_session_up(ws).await?;
                Ok(())
            }
            Ok(boot::ImportOutcome::CommittedNeedsReopen { report, error }) => {
                // 库已可信提交、连接却还挂着 boot 库(§3.2):「须重开」旗已在上方
                // **导入临界区内**落下(codex 二轮 M2),这里只做状态与 latch;
                // **禁止在原 Connection 上 relay_session_up**,置位让 session 以
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
                self.deck(ws).send_envelope(&to, WireLane::Direct, blob, Sent::BootOut).await
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
    use std::sync::atomic::AtomicU32;
    // 拨号侧的用例自己当 §4 的监听方,故要一只真监听口(L-c3b)。
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    // 定点测试账户(合法 ULID 形态;open-signup 起准入开放,无须预签)。
    const ACCT: &str = "01AAAAAAAAAAAAAAAAAAAAACCT";

    static N: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ys-nb-transport-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, AtomicOrdering::Relaxed)
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

    // ---- 引擎活到 runtime 生命期(lan-direct-plan 不变量 6,L-c2a) --------------------

    /// 测试用的 [`Pumps`]:心跳周期压到毫秒级(生产是 `HEARTBEAT_SECS`),链路移交通道
    /// 的发送端交回测试——注入真 TCP 链路走它(生产路上换成 L-c3 的监听器/拨号器)。
    fn test_pumps(
        slot: EngineSlot,
        lan_inbound: mpsc::Receiver<LanInbound>,
        lan_faults: mpsc::Receiver<LanFault>,
        period: Duration,
    ) -> (Pumps, mpsc::Sender<AdoptedLink>) {
        let (handoff_tx, handoff) = mpsc::channel(LAN_HANDOFF_CAP);
        let mut tick = tokio::time::interval_at(Instant::now() + period, period);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        (
            Pumps {
                slot,
                tick,
                handoff,
                handoff_keep: None,
                seat: None,
                lan_inbound,
                lan_faults,
                lan_hello_due: None,
            },
            handoff_tx,
        )
    }

    fn slot_cfg(device: &str, k: u8) -> SyncConfig {
        SyncConfig {
            account_id: ACCT.into(),
            k_acc: [k; 32],
            device_seed: [7u8; 32],
            server_url: "ws://127.0.0.1:1".into(),
            device_id: device.into(),
        }
    }

    /// **真写进库**的一份配置(直接调 `offline_wait` 的接线测用)。泵在做实际工作之前会自证
    /// 身份(`session_gate_tripped` 拿 cfg 与库现况对账,实现审二轮 H1),故拿一份库里根本
    /// 没有的假 cfg 去泵,栅栏当场就落——那是夹具不实,不是被测行为。
    fn saved_cfg(db: &Arc<Mutex<Connection>>) -> SyncConfig {
        let mut conn = db.lock().unwrap();
        // epoch_source = true → 连 bootstrapped_at 一起落(引擎装配的前提)。
        save_config(&mut conn, ACCT, &[5u8; 32], &[7u8; 32], "ws://127.0.0.1:1", true).unwrap();
        load_config(&conn).unwrap().expect("已配置")
    }

    /// 不 spawn 的 Transport(只给直接调 `offline_wait` 的接线测用)。控制通道的
    /// 发送端必须由调用方持住——一 drop,`recv()` 立刻 None、离线泵当场收场。
    fn bare_transport(
        db: Arc<Mutex<Connection>>,
        clock: Arc<Mutex<Clock>>,
        dir: PathBuf,
    ) -> (Transport, mpsc::Sender<Control>) {
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, _ev_rx) = mpsc::unbounded_channel();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let t = Transport {
            db,
            clock,
            status: Arc::new(Mutex::new(SyncStatus::default())),
            events: ev_tx,
            control: ctl_rx,
            wrote: Arc::new(Notify::new()),
            data_dir: dir,
            blob_policy: BlobPolicy::Full,
            allow_boot_source: true,
            shutdown: shutdown_rx,
            boot_commit: Arc::new(Mutex::new(None)),
            restart_flag: Arc::new(Mutex::new(None)),
            lan: None,
        };
        (t, ctl_tx)
    }

    /// 引擎在场 ⟺ 已引导;装配幂等,绝不重建。
    ///
    /// 重建不是「多花点时间」——`on_runtime_started` 会重新派生缺字节清单,把正在拉的
    /// 图塞回清单,破掉「清单与在飞互斥」(所以它二次调用是响亮报错)。
    #[test]
    fn engine_slot_tracks_bootstrap_marker_and_assembles_exactly_once() {
        let (db, _clock, _dir) = test_db("slot-boot");
        let conn = db.lock().unwrap();
        let cfg = slot_cfg("01DEVAAAAAAAAAAAAAAAAAAAAA", 1);
        let (mut slot, _lan_rx, _lan_faults) = EngineSlot::new(BlobPolicy::Full, None);
        slot.reconcile(&conn, &cfg).unwrap();
        assert!(slot.booting(), "bootstrapped_at 没落标就不装配(引擎在场 ⟺ 已引导)");
        meta_put(&conn, "bootstrapped_at", "t").unwrap();
        slot.reconcile(&conn, &cfg).unwrap();
        assert!(!slot.booting(), "落标后装配");
        // 探针:重建会把它擦掉。
        slot.get().unwrap().missing_blobs.insert("PROBE".into());
        slot.reconcile(&conn, &cfg).unwrap();
        assert!(
            slot.get().unwrap().missing_blobs.contains("PROBE"),
            "reconcile 幂等:同身份 + 标记在,绝不重建"
        );
        // 标记没了(清配置 / 重引导):**无条件撤台**——等价关系自证,不是句注释。
        conn.execute("DELETE FROM sync_meta WHERE key = 'bootstrapped_at'", []).unwrap();
        slot.reconcile(&conn, &cfg).unwrap();
        assert!(slot.booting(), "引导标记消失必须整台丢弃");
    }

    /// 该丢弃的判据是**身份**,不是「壳层记不记得发 Reconfigured」:换账户/设备/K_acc
    /// 整台丢弃(纪元压实换代正是这一形),只换服务器地址不丢。
    #[test]
    fn engine_slot_retires_on_identity_change_not_on_address_change() {
        let (db, _clock, _dir) = test_db("slot-stale");
        let conn = db.lock().unwrap();
        meta_put(&conn, "bootstrapped_at", "t").unwrap();
        let (mut slot, _lan_rx, _lan_faults) = EngineSlot::new(BlobPolicy::Full, None);
        fn probe(slot: &mut EngineSlot) {
            slot.get().unwrap().missing_blobs.insert("PROBE".into());
        }
        fn survived(slot: &mut EngineSlot) -> bool {
            slot.get().unwrap().missing_blobs.contains("PROBE")
        }
        slot.reconcile(&conn, &slot_cfg("01DEVAAAAAAAAAAAAAAAAAAAAA", 1)).unwrap();
        assert_eq!(slot.key().unwrap().1, "01DEVAAAAAAAAAAAAAAAAAAAAA");
        probe(&mut slot);

        let mut moved = slot_cfg("01DEVAAAAAAAAAAAAAAAAAAAAA", 1);
        moved.server_url = "ws://elsewhere.example".into();
        slot.reconcile(&conn, &moved).unwrap();
        assert!(survived(&mut slot), "换服务器地址不换身份:引擎照活");

        // 三根轴各换一次:每次都必须整台丢弃重装(探针没了即证)。
        let mut other_account = slot_cfg("01DEVAAAAAAAAAAAAAAAAAAAAA", 1);
        other_account.account_id = "01BBBBBBBBBBBBBBBBBBBBACCT".into();
        for recast in [
            slot_cfg("01DEVBBBBBBBBBBBBBBBBBBBBB", 1),
            slot_cfg("01DEVAAAAAAAAAAAAAAAAAAAAA", 9),
            other_account,
        ] {
            probe(&mut slot);
            slot.reconcile(&conn, &recast).unwrap();
            assert!(!survived(&mut slot), "换身份必须整台丢弃重装");
        }
    }

    /// 不变量 6 的接线:**没有中转会话时心跳照跳**。`on_tick` 是路由惩罚到期与拉流
    /// stale 判定的唯一时间轴(刻意用心跳刻度不用墙钟),只在会话里跳的话,断 WAN
    /// 期间惩罚永不到期、lan 半死链路上的图永远换不了腿。
    #[tokio::test]
    async fn offline_wait_keeps_the_engine_heartbeat_ticking() {
        let (db, clock, dir) = test_db("offline-tick");
        let cfg = saved_cfg(&db);
        let (mut slot, _lan_rx, _lan_faults) = EngineSlot::new(BlobPolicy::Full, None);
        {
            let conn = db.lock().unwrap();
            slot.reconcile(&conn, &cfg).unwrap();
        }
        assert_eq!(slot.get().unwrap().tick_count(), 0);
        let (mut t, _ctl) = bare_transport(db, clock, dir);
        let mut shutdown = t.shutdown.clone();
        // 心跳周期在测试里压到毫秒级(生产是 HEARTBEAT_SECS;本测钉的是「离线也
        // 驱动」这条接线,不是周期取值)。
        let period = Duration::from_millis(20);
        let (mut pumps, _handoff) = test_pumps(slot, _lan_rx, _lan_faults, period);
        // 窗口给足 25 拍去要 3 拍(291 收尾放宽了这一族的**零余量**时限):判据是「离线期间
        // 心跳照跳」,不是「一拍不许掉」。同批跑的用例一多,这台 Windows 上 20ms 周期的
        // 定时器真会在 110ms 里只轮到一次 —— 那是宿主调度,不是被测行为。
        let resume = Instant::now() + period * 25;
        let end =
            offline_wait(&mut t, &mut pumps, &mut shutdown, Some(&cfg), Some(resume), "测试").await;
        assert!(matches!(end, Idle::Elapsed), "睡到点才该出来");
        assert!(
            pumps.slot.get().unwrap().tick_count() >= 3,
            "离线等待期间心跳必须照跳,实得 {}",
            pumps.slot.get().unwrap().tick_count()
        );
    }

    /// **隔离重验的续做挂在恒在心跳上**(L-d‴ 实现审 H1)。
    ///
    /// 一轮把它钩在 `on_msg` 出口上,三条都不成立(见 `Deck::reverify_tick` 的注释);
    /// 最要命的是**没有下一枚帧就永远做不完**——一批全是 `InvalidOp` 时连 want 都不产,
    /// 链路稳定就再没有触发器。本测用的正是那个反例形:
    /// * 隔离行的 `op_blob` 是**读不懂的字节**(走「材料坏了 → 抬版本保留」那条,**一枚
    ///   帧都不产**),故「它被做过了」只能由 `validator_ver` 从 0 抬到当前来作证;
    /// * 全程**没有中转会话、也没有任何入站帧**(`offline_wait` 就是断网那六档),故驱动
    ///   它的只可能是心跳;
    /// * 引擎是新装的、**没跑过会话仪式**,故这条同时钉住「装配即置位」那一格。
    #[tokio::test]
    async fn heartbeat_drains_quarantine_reverify_backlog() {
        let (db, clock, dir) = test_db("reverify-tick");
        let cfg = saved_cfg(&db);
        let (mut slot, _lan_rx, _lan_faults) = EngineSlot::new(BlobPolicy::Full, None);
        {
            let conn = db.lock().unwrap();
            // **N > 一批**(实现审二轮 M3):一拍清不完,故这条同时证明「跨多拍自动清空」,
            // 而不只是「首拍会跑一次」。
            for i in 0..20 {
                conn.execute(
                    "INSERT INTO sync_quarantine (origin, op_id, origin_seq, op_blob, reason, \
                     error_stage, validator_ver, at) VALUES (?1, ?2, 1, ?3, '毒', 'shape', 0, '2026-07-31')",
                    rusqlite::params![
                        format!("QTNTICKDEV{i:016}"),
                        format!("01QTNTICKOP{i:015}"),
                        b"not-json".to_vec(),
                    ],
                )
                .unwrap();
            }
            slot.reconcile(&conn, &cfg).unwrap();
        }
        let stale = |db: &Arc<Mutex<Connection>>| -> i64 {
            db.lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM sync_quarantine WHERE validator_ver < ?1",
                    [crate::replay::VALIDATOR_VER],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(stale(&db), 20, "夹具:开跑前 20 行都是旧校验器版本");

        let (mut t, _ctl) = bare_transport(db.clone(), clock, dir);
        let mut shutdown = t.shutdown.clone();
        let period = Duration::from_millis(20);
        let (mut pumps, _handoff) = test_pumps(slot, _lan_rx, _lan_faults, period);
        // 同上放宽:20 行 / 每批 [`QUARANTINE_REVERIFY_BATCH`] = 16 → **要 2 拍**,原来的
        // `period * 5 + 10ms` 看着有 3 拍余量,实测在满载并行下那 110ms 里只跳了一拍
        // (16 行做完、剩 4 行)。291 收尾把那只 65s 的心跳测压短之后并行密度上来了,
        // 这条零余量时限当场被顶出来 —— 记在这里是因为它是**我这轮改动的真实副作用**。
        let resume = Instant::now() + period * 25;
        offline_wait(&mut t, &mut pumps, &mut shutdown, Some(&cfg), Some(resume), "测试").await;

        assert_eq!(
            stale(&db),
            0,
            "断网、无会话、无入站帧——只剩心跳能驱动重验,它必须跨多拍把 20 行全做掉"
        );
        assert!(
            !pumps.slot.get().unwrap().has_reverify_backlog(),
            "做完必须落位,否则每一拍都要空跑一条 SELECT"
        );
    }

    /// 配对请求不许挡住维护泵(实现审 M2):`offline_wait` 的 select 若是 `biased` 且
    /// 控制通道排在心跳/结算之前,`PairStart` 连续来就能让心跳永远轮不上——而「断 WAN
    /// 也不许停的心跳」正是不变量 6 的要求。
    ///
    /// **诚实边界**:真正的饿死要「控制通道一刻不空」,单线程测试运行时里做不到
    /// (泵取走一枚后发送侧才被调度,通道必然瞬空、维护臂就轮得上)。故本测只证
    /// 「洪流下泵照常推进心跳」这一半;另一半由末尾的结构锚守着——`biased` 一旦回来,
    /// 排序保证就没了,而那正是变异对照唯一抓得住的形。
    #[tokio::test]
    async fn offline_pump_keeps_ticking_while_pair_requests_flood_in() {
        let (db, clock, dir) = test_db("offline-flood");
        let cfg = saved_cfg(&db);
        let (mut slot, _lan_rx, _lan_faults) = EngineSlot::new(BlobPolicy::Full, None);
        {
            let conn = db.lock().unwrap();
            slot.reconcile(&conn, &cfg).unwrap();
        }
        let (mut t, ctl) = bare_transport(db, clock, dir);
        // 一刻不停地灌配对请求(bounded 通道,send 满了会等 → 通道恒非空)。
        let flood = tokio::spawn(async move {
            loop {
                let (tx, rx) = oneshot::channel();
                if ctl.send(Control::PairStart { reply: tx }).await.is_err() {
                    return;
                }
                drop(rx); // 回执没人要,泵照样得能把它打发掉。
            }
        });
        let mut shutdown = t.shutdown.clone();
        let period = Duration::from_millis(20);
        let (mut pumps, _handoff) = test_pumps(slot, _lan_rx, _lan_faults, period);
        // 同族的零余量时限,一并放宽(见上一只的理由)。
        let resume = Instant::now() + period * 25;
        let end =
            offline_wait(&mut t, &mut pumps, &mut shutdown, Some(&cfg), Some(resume), "测试").await;
        flood.abort();
        assert!(matches!(end, Idle::Elapsed), "睡到点才该出来");
        assert!(
            pumps.slot.get().unwrap().tick_count() >= 2,
            "配对洪流下心跳仍须推进,实得 {}",
            pumps.slot.get().unwrap().tick_count()
        );
        // 结构锚:泵的 select **不许** biased(见上「诚实边界」)。停机的及时性靠
        // 循环顶那行点查,不靠把 shutdown 排第一。
        let src = include_str!("transport.rs");
        let start = src.find("async fn offline_wait").expect("本文件有离线泵");
        let body = &src[start..start + src[start..].find("\nenum SessionEnd").unwrap_or(2000)];
        // 找 `biased;` 这个 select 语法 token,不是散文里的「biased」二字。
        assert!(!body.contains("biased;"), "离线泵的 select 不许 biased(否则控制通道能饿死维护臂)");
        assert!(body.contains("if *shutdown.borrow()"), "停机及时性靠循环顶点查");
    }

    /// 接线锚(实现审 M1):**整个 runtime 只有一根心跳**。`Engine::on_tick` 的刻度是
    /// 路由惩罚到期与拉流 stale 判定的时间轴,而 `PULL_STALE_TICKS` 只有 2——每建一条
    /// 会话就新起一根 `tokio::time::interval`(首拍立即就绪)的话,两次快速 WSS 重连
    /// 就能把一条正常的 lan 拉流判死、shun 并罚腿。`session` 因此只收 `&mut Interval`,
    /// 本测钉的是「本文件里再没有第二处造心跳」。
    #[test]
    fn exactly_one_heartbeat_interval_in_the_whole_transport() {
        let src = include_str!("transport.rs");
        // 只看产品代码(测试自己也造 interval,那是压到毫秒级的测具)。
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        let made: Vec<&str> = prod
            .match_indices("tokio::time::interval")
            .map(|(i, _)| prod[i..].lines().next().unwrap_or(""))
            .collect();
        assert_eq!(made.len(), 1, "runtime 只许有一根心跳,实见:{made:?}");
        assert!(made[0].contains("interval_at"), "首拍必须延后一个周期,不许立即就绪");
        // 周期改成参数之后多出来的那道闸:**生产入口传的必须是 `HEARTBEAT_SECS`**。
        // 压到毫秒级的那个入口是 `#[cfg(test)]` 的 `run_with_beat`,别的调用点一个都不许有。
        assert!(
            prod.contains("run_inner(t, handoff, Some(handoff_tx), Duration::from_secs(HEARTBEAT_SECS))"),
            "生产入口 `run` 必须按 HEARTBEAT_SECS 起心跳"
        );
    }

    /// **一趟 sweep 至多泵一次全局数据窗口**(codex 实现审二轮 M)。
    ///
    /// 原先 `ops_changed_tick` 逐 target 调 `wake_ops_target`,而它在中转在场时每次都进一趟
    /// 全局 `relay_data_pump` —— 64 个 target × 每趟跑满 K=8 回合 = 一拍最坏约 512 次取数,
    /// `pump_ops` 在 K 处留的那枚 permit 拦不住**当前这趟 sweep 继续调下一轮泵**。不会重复
    /// 占窗、也不会多翻 ops/blob 的 1:1(窗口一占后续全早返回),但 K 那条「跑 8 次就交回
    /// 协调者」的延迟与公平上界被整个打掉了。
    ///
    /// **行为面由 [`one_sweep_spends_a_single_k_budget`] 守**,本测只补它够不着的那半。
    ///
    /// ⚠ 上一版这里写的是「除非新增一个只为测试存在的 sweep 边界标记,否则没有行为观测
    /// 面」—— **那句话过强,codex 三轮 L2 纠了**:`ops_changed_tick()` 这个方法的**返回**
    /// 本身就是 sweep 边界,缺的只是一条中转在场的投递面夹具。教训与 284 那条同族:
    /// **判「造不出行为测」之前,先把「我手上已经有的边界」也数一遍**,别只数生产代码里
    /// 有没有现成的信号。
    ///
    /// 那只行为测钉的是「一趟花几个 K」,钉不到的是**位置**:心跳那一臂若又加回一句独立的
    /// 全局泵,它跑的是另一次调用、另一个 K,行为测看不见(它只调 `ops_changed_tick`)。
    /// 故本测留着,声称三件:**逐 target 的那一半不碰泵,全局泵整趟各一次,心跳不另开第二次。**
    #[test]
    fn the_ops_sweep_pumps_the_global_window_at_most_once_per_pass() {
        /// **只留代码,注释一律剔掉**:这几段的注释里本来就在讲「原先这里另有一句独立的
        /// `relay_data_pump()`」,不剔的话锚点会命中自己的散文 —— 首版正是这么红的。
        fn code_only(s: &str) -> String {
            s.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
        }
        let src = include_str!("transport.rs");
        // 先切掉测试模块(291/292 那两只自指空测的教训):本测自己也写这些字面量。
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        let at = prod.find("async fn ops_changed_tick(").expect("扫描那一趟在本文件");
        let body = code_only(&prod[at..at + prod[at..].find("\n    }").expect("方法体以四空格 }")]);

        // ① 逐 target 的那一半:只许摇铃(便宜、不摸库、不 await),一次泵都不许有。
        let loop_at = body.find("for target in &targets {").expect("逐 target 那一圈");
        let loop_body = &body[loop_at
            ..loop_at + body[loop_at..].find("\n        }").expect("循环体以八空格 } 结束")];
        assert!(
            !loop_body.contains("pump("),
            "逐 target 的那一半不许调泵(64 target × K=8 = 一拍最坏 512 次取数),实见:{loop_body}"
        );
        // ② 两条腿的全局泵各恰一次。
        assert_eq!(body.matches("relay_data_pump()").count(), 1, "中转泵整趟至多一次");
        assert_eq!(body.matches("offline_broadcast_pump()").count(), 1, "离线泵整趟至多一次");

        // ③ 心跳那一臂**不许再独立泵一次**(二轮 M 的另一半:与 sweep 合并成唯一一次)。
        //    留着的话同一拍就是两个 K 的额度,①② 白钉。
        let beat_at = prod.find("_ = tick.tick() => {").expect("会话内那根心跳");
        let beat = code_only(
            &prod[beat_at
                ..beat_at + prod[beat_at..].find("\n            },").expect("心跳臂以十二空格 },")],
        );
        assert!(
            beat.contains("ops_tick().await?"),
            "ops 那一拍(它里面带着唯一那次全局泵)必须挂在心跳上"
        );
        assert!(
            !beat.contains("relay_data_pump()"),
            "心跳不许在 `ops_tick` 之外另开一次全局泵,实见:{beat}"
        );
    }

    /// 接线锚(L-c2a):`session` 一**返回**就必须通报引擎「中转会话没了」——断线、
    /// Reconfigured、HostGone、ReopenRequired 四条返回路径全过得到这一行。漏了它,
    /// 活过会话的引擎会一直以为大家的中转腿还通着、选路照它发帧。
    ///
    /// **停机臂例外且不需要通报**(实现审 L1):`wait_shutdown` 分支直接
    /// `return TransportExit::Stopped`,整个 `EngineSlot` 随 `run` 的栈一起销毁,
    /// 没有「活着却以为中转还在」的引擎可言。故本测钉的是「返回后、处置 end 前」这
    /// 一段,不声称覆盖停机路径。为什么按源码钉:引擎在 `run` 的栈上,`SyncStatus`
    /// 里照不出路由表,行为测看不见这一步。
    #[test]
    fn session_return_paths_report_relay_session_down_lexically() {
        let src = include_str!("transport.rs");
        // **先切掉测试模块**(291 收尾自查):上一版直接在整份源码上 `find`,而它的锚点
        // `pub async fn run(mut t: Transport)` 早在 `run` 拆成 `run`/`run_inner` 那轮就没了
        // (`mut t` 跟着搬进了后者)。于是唯一命中的是**本测自己那一行**,随后三个位置也
        // 全是本测源码里的字面量 —— `call < down < handled` 恒成立,这只锚变成了自指的
        // 空测,任凭生产段怎么改都绿。锚点会随修法失效,这是第三例(275 变异 plan 的锚 /
        // `ops_serve` 那只切点)。
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        let body = &prod[prod.find("async fn run_inner(").expect("重连循环在 run_inner 里")..];
        let call = body.find("r = session(&mut t").expect("run_inner 里必有 session 调用");
        let wrapup = body.find("session_wrapup(&t, &cfg,").expect("必须走会话收场那一手");
        let handled = body.find("match end {").expect("run_inner 里必有 match end");
        assert!(call < wrapup, "收场必须在 session 返回之后");
        assert!(wrapup < handled, "收场必须在处置 end 之前(session 的每条返回路径都过得到)");
        // 通报本身在收场那一手里 —— 与数据窗口的释放同一处,故两件不会各走各的。
        let at = prod.find("async fn session_wrapup(").expect("收场函数在本文件");
        let wrap = &prod[at..at + prod[at..].find("\n}").expect("函数体以行首 } 结束")];
        assert!(wrap.contains("on_relay_session_down()"), "收场必须通报中转会话结束");
    }

    // ---- 局域网通告面(lan-direct-plan §2,L-c2b) ------------------------------------

    const PEER: &str = "01PEERBBBBBBBBBBBBBBBBBBBB";
    const NOW_MS: u64 = 1_800_000_000_000;

    /// 只给「不碰 socket 的 Ctx 方法」用的装配台:通告面全在这类方法里(吸收 / 注入 /
    /// 收敛判定),不必起 WSS。
    struct AdRig {
        db: Arc<Mutex<Connection>>,
        clock: Arc<Mutex<Clock>>,
        status: Arc<Mutex<SyncStatus>>,
        /// 持住接收端,`toast`/事件才不会因通道关闭而静默(断言用)。
        events: mpsc::UnboundedReceiver<SyncEvent>,
        ev_tx: mpsc::UnboundedSender<SyncEvent>,
        slot: EngineSlot,
        /// 本「会话」的通告面(每次 [`ad_ctx`] 换一份新的 = 换一条会话)。
        ad: AdFace,
        cfg: SyncConfig,
        dir: PathBuf,
    }

    fn ad_rig(tag: &str) -> AdRig {
        let (db, clock, dir) = test_db(tag);
        let cfg = slot_cfg("01DEVSELFAAAAAAAAAAAAAAAAA", 1);
        let (mut slot, _lan_rx, _lan_faults) = EngineSlot::new(BlobPolicy::Full, None);
        {
            let conn = db.lock().unwrap();
            meta_put(&conn, "bootstrapped_at", "t").unwrap();
            slot.reconcile(&conn, &cfg).unwrap();
        }
        let (ev_tx, events) = mpsc::unbounded_channel();
        AdRig {
            db,
            clock,
            status: Arc::new(Mutex::new(SyncStatus::default())),
            events,
            ev_tx,
            slot,
            ad: AdFace::new(true),
            cfg,
            dir,
        }
    }

    /// 一「会话」= 一份新的通告面(通告序号与限频位都是会话态)。刻意不经 `Ctx`:
    /// 通告面要的四件里没有 socket(见 [`AdDeck`]),测试也就不必造一条 WSS。
    fn ad_ctx(r: &mut AdRig) -> AdDeck<'_> {
        r.ad = AdFace::new(true);
        AdDeck {
            db: &r.db,
            status: &r.status,
            events: &r.ev_tx,
            cfg: &r.cfg,
            slot: &mut r.slot,
            ad: &mut r.ad,
        }
    }

    fn ad_of(pubkey: &[u8; 32], ad_seq: u64) -> LanAd {
        LanAd { pubkey: pubkey.to_vec(), ad_seq, listen: None }
    }

    /// 缓存记录的读写往返;**读不动一律 Err,绝不当「没缓存」**——当成 None 就等于让
    /// 「首见钉住」可反复触发,一枚坏记录就能把同 id 异钥的禁用绕过去。
    #[test]
    fn lan_peer_ad_cache_roundtrip_and_refuses_to_guess() {
        let (db, _clock, _dir) = test_db("ad-io");
        let conn = db.lock().unwrap();
        assert!(read_peer_ad(&conn, PEER).unwrap().is_none(), "没写过 = Ok(None)");
        let key = pubkey_of(&[3u8; 32]);
        let lan::AdMerge::Store { record, .. } =
            lan::merge_peer_ad(None, &ad_of(&key, 7), Ingress::RelayDeliver, NOW_MS)
        else {
            panic!("首见必落库");
        };
        write_peer_ad(&conn, PEER, &record).unwrap();
        let back = read_peer_ad(&conn, PEER).unwrap().expect("读回");
        assert_eq!(back, record);
        assert_eq!(back.usable_pubkey(), Some(key));
        assert_eq!(back.ad_seq, 7);
        // 值被外力弄坏(hex 不成对 / CBOR 读不懂 / 合法记录后跟垃圾):响亮 Err,不是 None。
        let good = meta_get(&conn, &lan_peer_key(PEER)).unwrap().unwrap();
        for garbage in ["zz", "abc", "00ff", &format!("{good}00")] {
            meta_put(&conn, &lan_peer_key(PEER), garbage).unwrap();
            assert!(read_peer_ad(&conn, PEER).is_err(), "{garbage} 该响亮失败");
        }
    }

    /// 通告序号:canonical 严格解析、单调、**落库成功才给封帧处用**。
    #[test]
    fn lan_ad_seq_is_canonical_monotonic_and_persisted_first() {
        let (db, _clock, _dir) = test_db("ad-seq-io");
        let conn = db.lock().unwrap();
        assert_eq!(read_ad_seq(&conn).unwrap(), 0, "缺席 = 从未发布过");
        for want in 1..=3u64 {
            assert_eq!(bump_ad_seq(&conn).unwrap(), want);
            assert_eq!(
                meta_get(&conn, "lan_ad_seq").unwrap().unwrap(),
                want.to_string(),
                "递增必须先落库(先发后落 = 同一序号发两次不同 listen)"
            );
        }
        for bad in ["01", "+1", "-1", " 1", "1x", "18446744073709551616"] {
            meta_put(&conn, "lan_ad_seq", bad).unwrap();
            assert!(read_ad_seq(&conn).is_err(), "{bad} 是非规范形,该拒");
        }
        // 到顶:Err 且库里一字未改(绝不回绕——回绕后收端「更小不收」会把本机钉死)。
        meta_put(&conn, "lan_ad_seq", &u64::MAX.to_string()).unwrap();
        assert!(bump_ad_seq(&conn).is_err());
        assert_eq!(meta_get(&conn, "lan_ad_seq").unwrap().unwrap(), u64::MAX.to_string());
    }

    /// 注入:**本会话首次封发才递增**、其后重用;换会话再递增。同会话内递增的话,
    /// 「按 peer + 序号去重」永远拦不住自激回声(三轮 M2)。
    #[test]
    fn local_ad_bumps_once_per_session_and_reuses_within() {
        let mut r = ad_rig("ad-session");
        let want_key = pubkey_of(&r.cfg.device_seed).to_vec();
        {
            let mut ctx = ad_ctx(&mut r);
            let first = ctx.local_lan_ad().expect("首枚通告");
            let again = ctx.local_lan_ad().expect("同会话重用");
            assert_eq!((first.ad_seq, again.ad_seq), (1, 1));
            assert_eq!(first.pubkey, want_key, "通告的公钥 = 本设备既有鉴权钥的验证钥");
            assert!(first.listen.is_none(), "本笔无监听器:只发布身份、不发布落点");
        }
        {
            let mut ctx = ad_ctx(&mut r);
            assert_eq!(ctx.local_lan_ad().expect("新会话").ad_seq, 2);
        }
        let conn = r.db.lock().unwrap();
        assert_eq!(meta_get(&conn, "lan_ad_seq").unwrap().unwrap(), "2");
    }

    /// 序号到顶 = 停用本机通告,但 **Hello 照发**:水位互补是同步的正确性面,通告只是
    /// 直连的加速面,不许互相拖累。
    #[test]
    fn local_ad_at_max_disables_advert_but_not_the_hello() {
        let mut r = ad_rig("ad-max");
        {
            let conn = r.db.lock().unwrap();
            meta_put(&conn, "lan_ad_seq", &u64::MAX.to_string()).unwrap();
        }
        let mut ctx = ad_ctx(&mut r);
        assert!(ctx.local_lan_ad().is_none(), "到 MAX 即停用");
        assert!(ctx.ad.off, "停用本会话粘滞");
        assert!(ctx.local_lan_ad().is_none());
        drop(ctx);
        let conn = r.db.lock().unwrap();
        assert_eq!(
            meta_get(&conn, "lan_ad_seq").unwrap().unwrap(),
            u64::MAX.to_string(),
            "绝不回绕"
        );
        assert!(r.status.lock().unwrap().lan_warning.is_some(), "停用进通告面诊断,不占正确性 error 槽");
    }

    /// 首见钉住 → 回一帧定向 Hello(走**鉴权路**);同 id 异钥 = 粘滞禁用,写回的是
    /// **原**钉住的钥 + 禁用位,重启(= 重新读库)仍禁用,连原钥的新通告也不解封。
    #[test]
    fn peer_ad_first_seen_pins_then_key_conflict_sticks() {
        let mut r = ad_rig("ad-pin");
        let key_a = pubkey_of(&[3u8; 32]);
        let key_b = pubkey_of(&[4u8; 32]);
        {
            let mut ctx = ad_ctx(&mut r);
            let outs = ctx.absorb_lan_ad(PEER, &ad_of(&key_a, 1), Ingress::RelayDeliver, false);
            assert_eq!(outs.len(), 1, "首见钉住 ∧ 本会话未向它发布过 → 回一帧定向 Hello");
            match &outs[0] {
                Output::Send { to, lane, route_hint, msg } => {
                    assert_eq!(to, PEER);
                    assert_eq!(*lane, Lane::Mail);
                    assert_eq!(
                        *route_hint,
                        RouteHint::Require(Route::Relay),
                        "带通告的权威 Hello 只许走鉴权路(§2 缓存规则只认 deliver)"
                    );
                    assert!(matches!(msg, Msg::Hello { .. }));
                }
                other => panic!("该是一帧定向 Hello:{other:?}"),
            }
            // 同一枚再来:序号不新 → 不动缓存、不回帧。
            assert!(ctx.absorb_lan_ad(PEER, &ad_of(&key_a, 1), Ingress::RelayDeliver, false).is_empty());

            // 异钥:禁用,且**原钥留着**(不覆盖写)。
            assert!(ctx.absorb_lan_ad(PEER, &ad_of(&key_b, 99), Ingress::RelayDeliver, false).is_empty());
            let conn = ctx.db.lock().unwrap();
            let disabled = read_peer_ad(&conn, PEER).unwrap().expect("记录在册");
            assert!(disabled.is_disabled(), "同 id 异钥 = 粘滞禁用");
            assert_eq!(disabled.usable_pubkey(), None, "禁用后验证钥归零");
            assert_eq!(disabled.ad_seq, 1, "冲突不推进序号、不收新钥的 listen");
        }
        // 冲突要转常驻告警(只报一次,恶意对端刷不动状态面)。
        let toasts = std::iter::from_fn(|| r.events.try_recv().ok())
            .filter(|e| matches!(e, SyncEvent::Toast(_)))
            .count();
        assert_eq!(toasts, 1, "冲突每对端每会话恰一次提示");
        assert_eq!(r.status.lock().unwrap().lan_disabled, vec![PEER.to_string()], "禁用清单进状态面常驻");

        // 换会话(= 重新读库):禁用仍在,连原钥的新通告也不解封。
        let mut ctx = ad_ctx(&mut r);
        assert!(ctx.absorb_lan_ad(PEER, &ad_of(&key_a, 500), Ingress::RelayDeliver, false).is_empty());
        let conn = ctx.db.lock().unwrap();
        let still = read_peer_ad(&conn, PEER).unwrap().expect("记录在册");
        assert!(still.is_disabled(), "解封只有换 device_id 或纪元轮换");
        assert_eq!(still.ad_seq, 1);
    }

    /// 同一枚通告分经两类来路:**Relay 落库、Lan 一个字节都不写**(§2 单一权威路;
    /// 来路是 socket 所有者构造的传输层事实,不取自对端字段)。
    #[test]
    fn lan_ingress_never_writes_the_ad_cache() {
        let mut r = ad_rig("ad-ingress");
        let key = pubkey_of(&[5u8; 32]);
        let mut ctx = ad_ctx(&mut r);
        let ad = ad_of(&key, 3);

        assert!(ctx.absorb_lan_ad(PEER, &ad, Ingress::LanFrame, false).is_empty());
        {
            let conn = ctx.db.lock().unwrap();
            assert!(read_peer_ad(&conn, PEER).unwrap().is_none(), "LAN 来路整体忽略");
        }
        assert_eq!(ctx.absorb_lan_ad(PEER, &ad, Ingress::RelayDeliver, false).len(), 1);
        let conn = ctx.db.lock().unwrap();
        assert_eq!(
            read_peer_ad(&conn, PEER).unwrap().expect("Relay 来路落库").usable_pubkey(),
            Some(key)
        );
    }

    /// 触发②:对端在线而本机缺它的验证钥 → 定向回一帧本机通告,**每对端每会话一次**;
    /// 缓存已在册(含粘滞禁用)则不发——禁用只有换 id 或纪元才解,再问也无用。
    #[test]
    fn peer_online_without_key_asks_once_per_session() {
        let mut r = ad_rig("ad-online");
        let mut ctx = ad_ctx(&mut r);
        assert_eq!(ctx.lan_hello_if_key_missing(PEER).len(), 1, "缺公钥就问一次");
        assert!(ctx.lan_hello_if_key_missing(PEER).is_empty(), "本会话不重复问");

        let other = "01PEERCCCCCCCCCCCCCCCCCCCC";
        {
            let conn = ctx.db.lock().unwrap();
            let lan::AdMerge::Store { record, .. } = lan::merge_peer_ad(
                None,
                &ad_of(&pubkey_of(&[6u8; 32]), 1),
                Ingress::RelayDeliver,
                NOW_MS,
            ) else {
                panic!("首见必落库");
            };
            write_peer_ad(&conn, other, &record).unwrap();
        }
        assert!(ctx.lan_hello_if_key_missing(other).is_empty(), "已有公钥不必问");
    }

    /// 来路 → 路由一一对应(§2/§5:来路是传输层内部事实)。LAN 那条腿的生产者在 L-c2c,
    /// 此刻只有这一处映射看得见对错,故直接钉映射本身。
    #[test]
    fn ingress_maps_to_route_one_to_one() {
        assert_eq!(route_of(Ingress::RelayDeliver), Route::Relay);
        assert_eq!(route_of(Ingress::LanFrame), Route::Lan);
    }

    /// 形态不合的通告:忽略 + 一次诊断,**一个字节都不落库**;同对端不重报(恶意对端
    /// 灌畸形通告刷不动状态面)。通告是 advisory 面,这枚 Hello 的水位处理照旧。
    #[test]
    fn malformed_ad_is_ignored_once_and_never_written() {
        let mut r = ad_rig("ad-bad");
        let mut ctx = ad_ctx(&mut r);
        let bad = LanAd { pubkey: vec![1, 2, 3], ad_seq: 1, listen: None };
        assert!(ctx.absorb_lan_ad(PEER, &bad, Ingress::RelayDeliver, false).is_empty());
        {
            let conn = ctx.db.lock().unwrap();
            assert!(read_peer_ad(&conn, PEER).unwrap().is_none(), "形态不合不落库");
        }
        assert!(ctx.status.lock().unwrap().lan_warning.is_some(), "第一次要报");
        ctx.status.lock().unwrap().lan_warning = None;
        assert!(ctx.absorb_lan_ad(PEER, &bad, Ingress::RelayDeliver, false).is_empty());
        assert!(ctx.status.lock().unwrap().lan_warning.is_none(), "同对端不重报");
    }

    /// 安全告警不许被通告面诊断吞掉:对端先发一枚畸形通告(记下诊断)、再发冲突钥,
    /// 那声「已停用与它的直连」仍须发出——两个去重集刻意分开(首版自检抓到)。
    #[test]
    fn key_conflict_alarm_survives_an_earlier_malformed_report() {
        let mut r = ad_rig("ad-alarm");
        {
            let mut ctx = ad_ctx(&mut r);
            ctx.absorb_lan_ad(PEER, &ad_of(&pubkey_of(&[9u8; 32]), 1), Ingress::RelayDeliver, false);
            let bad = LanAd { pubkey: vec![1, 2, 3], ad_seq: 2, listen: None };
            ctx.absorb_lan_ad(PEER, &bad, Ingress::RelayDeliver, false);
            ctx.absorb_lan_ad(PEER, &ad_of(&pubkey_of(&[10u8; 32]), 3), Ingress::RelayDeliver, false);
        }
        let toasts = std::iter::from_fn(|| r.events.try_recv().ok())
            .filter(|e| matches!(e, SyncEvent::Toast(_)))
            .count();
        assert_eq!(toasts, 1, "冲突告警必须发出,不被先前的畸形诊断吞掉");
    }

    /// 触发② 那一帧可能被对端的**引导期整帧丢弃**吃掉(模块注释),所以触发① 不许因为
    /// 「本会话已经问过它」而不回——否则新端要等老端下次重连才学得到公钥。这是首版自检
    /// 抓到的不收敛窗口(规格 §2 已随本轮回写),锚在这里防复发。
    #[test]
    fn asking_first_does_not_swallow_the_first_seen_reply() {
        let mut r = ad_rig("ad-hole");
        let mut ctx = ad_ctx(&mut r);
        assert_eq!(ctx.lan_hello_if_key_missing(PEER).len(), 1, "先按② 问一帧");
        // 对端引导完、发来它的第一枚通告:必须回一帧,它才学得到本机公钥。
        let outs =
            ctx.absorb_lan_ad(PEER, &ad_of(&pubkey_of(&[8u8; 32]), 1), Ingress::RelayDeliver, false);
        assert_eq!(outs.len(), 1, "首见钉住恒回一帧(② 问过不算「已发布过」)");
    }

    /// §2 公钥收敛:两端各按「首见钉住 → 回一帧定向 Hello」跑,**带消息计数上限**证明
    /// 有限步静默(三轮 M2 点名的自激回声防线)。初始态取最难的一档:双方都无缓存、
    /// 两侧 ad_seq 还不同。判据与生产同一处真相([`lan_ad_reply_needed`])。
    #[test]
    fn lan_ad_convergence_is_finite_and_never_ping_pongs() {
        struct Side {
            seq: u64,
            cache: Option<lan::LanPeerAd>,
            key: [u8; 32],
        }
        let mut sides = [
            Side { seq: 5, cache: None, key: pubkey_of(&[1u8; 32]) },
            Side { seq: 1, cache: None, key: pubkey_of(&[2u8; 32]) },
        ];
        // 会话起各发一枚广播 Hello 的通告(0→1、1→0);其后只有收敛回帧。
        let mut queue: Vec<(usize, LanAd)> =
            vec![(1, ad_of(&sides[0].key, sides[0].seq)), (0, ad_of(&sides[1].key, sides[1].seq))];
        let mut sent = queue.len();
        while let Some((to, ad)) = queue.pop() {
            let me = &mut sides[to];
            let merged = lan::merge_peer_ad(me.cache.as_ref(), &ad, Ingress::RelayDeliver, NOW_MS);
            if let lan::AdMerge::Store { record, cause } = merged {
                me.cache = Some(record);
                if lan_ad_reply_needed(cause) {
                    // **回帧的序号刻意每次都更大**:模拟三轮 M2 点名的那种实现(「每次
                    // 发布都递增」),对端可以是任何实现、不由本机担保。序号总更大 =
                    // `merge_peer_ad` 恒判 Advanced,故「首见才回」是唯一的终止依据——
                    // 换成「凡落库就回」当场无限乒乓。
                    me.seq += 1;
                    let reply = ad_of(&me.key, me.seq);
                    queue.push((1 - to, reply));
                    sent += 1;
                }
            }
            assert!(sent <= 4, "收敛必须有限步静默,实发 {sent} 帧");
        }
        for (i, s) in sides.iter().enumerate() {
            let peer_key = sides[1 - i].key;
            assert_eq!(
                s.cache.as_ref().and_then(|c| c.usable_pubkey()),
                Some(peer_key),
                "第 {i} 端必须钉住对端公钥"
            );
        }
    }

    /// §2 公钥收敛的真接线(真服务器 + 两实例,含新端引导):Hello 捎带通告 → 经**中转
    /// deliver** 到达 → 落 `lan_peer:<device>`。这是拨号与握手验签的前置(LAN 不 TOFU),
    /// 故钉的是「两端各自钉住了对端的验证钥」这一事实,不是某一帧的时序。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn lan_pubkey_converges_over_the_relay_authorized_path() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db_a, clock_a, dir_a) = test_db("lanad-a");
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let rig_a = spawn_transport(db_a.clone(), clock_a.clone(), dir_a);
        wait_state(&rig_a.status, "online").await;

        // B 加入 → 引导 → 上线(引导期的帧整帧丢弃,收敛得靠引导后的会话仪式)。
        let (db_b, clock_b, dir_b) = test_db("lanad-b");
        let (tx, rx) = oneshot::channel();
        rig_a.control.send(Control::PairStart { reply: tx }).await.unwrap();
        let code = timeout(Duration::from_secs(10), rx).await.unwrap().unwrap().unwrap();
        pair_join(&db_b, &url, &code, |_| Ok(())).await.unwrap();
        let rig_b = spawn_transport(db_b.clone(), clock_b.clone(), dir_b);
        wait_state(&rig_b.status, "online").await;

        let ident = |db: &Arc<Mutex<Connection>>| {
            let conn = db.lock().unwrap();
            let cfg = load_config(&conn).unwrap().expect("已配置");
            (cfg.device_id, pubkey_of(&cfg.device_seed))
        };
        let (dev_a, key_a) = ident(&db_a);
        let (dev_b, key_b) = ident(&db_b);
        let pinned = |db: &Arc<Mutex<Connection>>, peer: &str| {
            let conn = db.lock().unwrap();
            read_peer_ad(&conn, peer).unwrap().and_then(|r| r.usable_pubkey())
        };
        wait_until("A 钉住 B 的验证钥", || pinned(&db_a, &dev_b) == Some(key_b)).await;
        wait_until("B 钉住 A 的验证钥", || pinned(&db_b, &dev_a) == Some(key_a)).await;
        for (db, dev) in [(&db_a, &dev_a), (&db_b, &dev_b)] {
            let conn = db.lock().unwrap();
            assert!(read_ad_seq(&conn).unwrap() >= 1, "封发前先落库,故序号已在库里");
            let keys: Vec<String> = conn
                .prepare("SELECT key FROM sync_meta WHERE key LIKE 'lan_peer:%' ORDER BY key")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert_eq!(keys.len(), 1, "只缓存对端一条,实见 {keys:?}");
            assert!(!keys[0].ends_with(dev.as_str()), "绝不缓存自己:{keys:?}");
            // listen 面本笔还没有(无监听器):只发布身份。
            let peer = keys[0].strip_prefix("lan_peer:").unwrap().to_string();
            assert!(read_peer_ad(&conn, &peer).unwrap().unwrap().listen.is_none());
        }
        rig_a.task.abort();
        rig_b.task.abort();
        let _ = (rig_a.wrote, rig_b.wrote, rig_a.events, rig_b.events);
    }

    /// **非对称缓存也要收敛**(codex 审 M1):A 已有 B 的钥、B 没有 A 的,B 发一枚**定向**
    /// Hello 索要——A 这边不是首见、无跃迁可依,但定向 Hello 就是隐式索要,必须应答一次。
    /// 少了这一条,B 只能等 A 重连(A 的会话可以挂好几天)。终止:每对端每会话至多一答。
    #[test]
    fn a_directed_hello_is_answered_even_when_the_peer_is_already_cached() {
        let mut r = ad_rig("ad-solicit");
        let peer_key = pubkey_of(&[11u8; 32]);
        {
            let mut ctx = ad_ctx(&mut r);
            // A 先从广播里钉住 B(首见回一帧)。
            let outs = ctx.absorb_lan_ad(PEER, &ad_of(&peer_key, 1), Ingress::RelayDeliver, false);
            assert_eq!(outs.len(), 1);
            // B 后来定向索要(同一把钥、序号更大):不是首见,但必须答。
            let outs = ctx.absorb_lan_ad(PEER, &ad_of(&peer_key, 2), Ingress::RelayDeliver, true);
            assert_eq!(outs.len(), 1, "定向 Hello = 隐式索要,已缓存也要答一次");
            // 再索要:本会话不再答(否则两端同时索要就来回不停)。
            assert!(ctx
                .absorb_lan_ad(PEER, &ad_of(&peer_key, 3), Ingress::RelayDeliver, true)
                .is_empty());
        }
        // LAN 来路的「定向」不算索要(§2:那条腿的 lan 字段整体忽略)。新会话开局,
        // 限频位是干净的,所以拦住它的只能是来路本身。
        let mut ctx = ad_ctx(&mut r);
        assert!(ctx
            .absorb_lan_ad(PEER, &ad_of(&peer_key, 9), Ingress::LanFrame, true)
            .is_empty());
    }

    /// 反射攻击面(codex 审 L1):恶意中转把本机发出的 `to="*"` Hello 密文原样回灌——AAD
    /// 合法、不需要 K_acc。**绝不缓存自己**,否则授权缓存被污染、还诱出无意义回帧。
    #[test]
    fn a_reflected_own_advert_is_never_cached() {
        let mut r = ad_rig("ad-reflect");
        let self_dev = r.cfg.device_id.clone();
        let mut ctx = ad_ctx(&mut r);
        let mine = ctx.local_lan_ad().expect("本机通告");
        assert!(ctx.absorb_lan_ad(&self_dev, &mine, Ingress::RelayDeliver, false).is_empty());
        let conn = ctx.db.lock().unwrap();
        assert!(read_peer_ad(&conn, &self_dev).unwrap().is_none(), "自己绝不进授权缓存");
    }

    /// advisory 面不许挤掉正确性面(codex 审 M3):先有一条同步的真错误(冻结原因那类),
    /// 再来一枚畸形通告,`error` 必须还在——同步能不能收敛与直连能不能起来是两件事。
    #[test]
    fn advisory_lan_diagnostics_never_clobber_the_sync_error() {
        let mut r = ad_rig("ad-noclobber");
        let mut ctx = ad_ctx(&mut r);
        ctx.set_status(|s| s.error = Some("同步已冻结一台设备的历史".into()));
        let bad = LanAd { pubkey: vec![7, 7], ad_seq: 1, listen: None };
        ctx.absorb_lan_ad(PEER, &bad, Ingress::RelayDeliver, false);
        let st = ctx.status.lock().unwrap();
        assert_eq!(st.error.as_deref(), Some("同步已冻结一台设备的历史"));
        assert!(st.lan_warning.is_some(), "通告面的诊断另有一格");
    }

    /// 回帧**先备好再落库**(codex 审 M4):`FirstSeen` 是收敛的唯一一次性跃迁,「记录已落、
    /// 回帧没生成」= 那台对端再也等不到本机通告。这里把 Hello 的生成掐断(引擎撤台),
    /// 断言跃迁没被消费——缓存里一个字节都不该有,下一枚同样的通告仍是首见。
    #[test]
    fn a_failed_reply_leaves_the_first_seen_transition_retryable() {
        let mut r = ad_rig("ad-atomic");
        let key = pubkey_of(&[12u8; 32]);
        {
            // 把 watermarks 查询弄坏:删掉 oplog 表,`make_hello` 必 Err。
            let conn = r.db.lock().unwrap();
            conn.execute("DROP TABLE oplog", []).unwrap();
        }
        {
            let mut ctx = ad_ctx(&mut r);
            assert!(ctx.absorb_lan_ad(PEER, &ad_of(&key, 1), Ingress::RelayDeliver, false).is_empty());
            let conn = ctx.db.lock().unwrap();
            assert!(
                read_peer_ad(&conn, PEER).unwrap().is_none(),
                "回帧生成失败就不许落库(否则跃迁被吃掉、收敛永远等不到)"
            );
        }
        assert!(r.status.lock().unwrap().lan_warning.is_some(), "失败要如实报");
    }

    /// 通告面归属本机身份(codex 审 M2):`lan_ad_owner` 一变(纪元压实换 device_id、换
    /// 账户)就清缓存与本机序号——**指纹自证**,不靠 `epoch::compact`/`clear_config` 记得清
    /// (压实期间引擎已撤台,进程内的换代检测看不见那一跳)。同身份不动。
    #[test]
    fn lan_ad_cache_is_stamped_with_the_local_identity() {
        let (db, _clock, _dir) = test_db("ad-owner");
        let mut conn = db.lock().unwrap();
        let cfg = slot_cfg("01DEVAAAAAAAAAAAAAAAAAAAAA", 1);
        reconcile_lan_ad_owner(&mut conn, &cfg).unwrap();
        let lan::AdMerge::Store { record, .. } = lan::merge_peer_ad(
            None,
            &ad_of(&pubkey_of(&[13u8; 32]), 4),
            Ingress::RelayDeliver,
            NOW_MS,
        ) else {
            panic!("首见必落库");
        };
        write_peer_ad(&conn, PEER, &record).unwrap();
        assert_eq!(bump_ad_seq(&conn).unwrap(), 1);

        // 同身份再对齐:一个字节都不动。
        reconcile_lan_ad_owner(&mut conn, &cfg).unwrap();
        assert!(read_peer_ad(&conn, PEER).unwrap().is_some());
        assert_eq!(read_ad_seq(&conn).unwrap(), 1);
        // 「刚好长得像」的键不许被 LIKE 的 `_` 通配误伤。
        meta_put(&conn, "lanXpeer:BYSTANDER", "keep-me").unwrap();

        // 换代(纪元压实换 device_id):缓存与序号一起清,章盖成新身份。
        reconcile_lan_ad_owner(&mut conn, &slot_cfg("01DEVBBBBBBBBBBBBBBBBBBBBB", 9)).unwrap();
        assert!(read_peer_ad(&conn, PEER).unwrap().is_none(), "上一代身份的对端记录清掉");
        assert_eq!(read_ad_seq(&conn).unwrap(), 0, "序号回到「从未发布过」");
        assert_eq!(meta_get(&conn, "lanXpeer:BYSTANDER").unwrap().unwrap(), "keep-me");
    }

    /// 归属对齐是**一个事务**(codex 二审 M1):清缓存 / 清序号 / 盖章三条散着走的话,
    /// 「缓存清了、序号还在、章没盖」会让本轮以新身份发布旧计数器,下轮清成功后新身份
    /// 从 1 重发 → 对端「更小不收」把本机长期钉死。这里让盖章那一步失败,断言前两步回滚。
    #[test]
    fn owner_realignment_is_all_or_nothing() {
        let (db, _clock, _dir) = test_db("ad-owner-tx");
        let mut conn = db.lock().unwrap();
        reconcile_lan_ad_owner(&mut conn, &slot_cfg("01DEVAAAAAAAAAAAAAAAAAAAAA", 1)).unwrap();
        let lan::AdMerge::Store { record, .. } = lan::merge_peer_ad(
            None,
            &ad_of(&pubkey_of(&[18u8; 32]), 3),
            Ingress::RelayDeliver,
            NOW_MS,
        ) else {
            panic!("首见必落库");
        };
        write_peer_ad(&conn, PEER, &record).unwrap();
        assert_eq!(bump_ad_seq(&conn).unwrap(), 1);
        // 让「盖章」这一步 ABORT(模拟三条 SQL 里最后一条失败)。
        conn.execute(
            "CREATE TRIGGER t_block_owner BEFORE INSERT ON sync_meta \
             WHEN NEW.key = 'lan_ad_owner' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
            [],
        )
        .unwrap();
        assert!(reconcile_lan_ad_owner(&mut conn, &slot_cfg("01DEVBBBBBBBBBBBBBBBBBBBBB", 9)).is_err());
        assert!(read_peer_ad(&conn, PEER).unwrap().is_some(), "整笔回滚:缓存还在");
        assert_eq!(read_ad_seq(&conn).unwrap(), 1, "整笔回滚:序号还在");
    }

    /// 归属没对齐 → **通告面整个关掉**(二审 M1):不注入本机通告、不吸收对端通告、
    /// 触发② 也不发;中转的水位同步一切照常(本测只钉通告面)。
    #[test]
    fn an_unaligned_owner_shuts_the_whole_advert_face() {
        let mut r = ad_rig("ad-notready");
        let mut ctx = ad_ctx(&mut r);
        ctx.ad.ready = false;
        assert!(ctx.local_lan_ad().is_none(), "不注入本机通告");
        let ad = ad_of(&pubkey_of(&[19u8; 32]), 1);
        assert!(ctx.absorb_lan_ad(PEER, &ad, Ingress::RelayDeliver, true).is_empty());
        assert!(ctx.lan_hello_if_key_missing(PEER).is_empty(), "触发② 也不发");
        let conn = ctx.db.lock().unwrap();
        assert!(read_peer_ad(&conn, PEER).unwrap().is_none(), "一个字节都不写");
        assert_eq!(read_ad_seq(&conn).unwrap(), 0, "序号也不碰");
    }

    /// 记录数硬上界(二审 M2):同一代身份内不断有新设备来去,`lan_peer` 不能无限长。
    /// 满额后**新对端** fail-closed(直连不可用、中转照常),但**已在册**对端的序号推进
    /// 与冲突禁用照写——满额绕掉粘滞禁用才是真事故。
    #[test]
    fn peer_records_have_a_hard_cap_that_never_blocks_conflicts() {
        let mut r = ad_rig("ad-cap");
        let old_peer = "01PEEROLDAAAAAAAAAAAAAAAAA";
        let old_key = pubkey_of(&[20u8; 32]);
        {
            let mut ctx = ad_ctx(&mut r);
            ctx.absorb_lan_ad(old_peer, &ad_of(&old_key, 1), Ingress::RelayDeliver, false);
            let conn = ctx.db.lock().unwrap();
            // 灌到满额(其余条目直接写库,不必走吸收)。
            for i in 0..(MAX_LAN_PEER_RECORDS - 1) {
                let peer = format!("01PEERFILLER{i:014}");
                let lan::AdMerge::Store { record, .. } = lan::merge_peer_ad(
                    None,
                    &ad_of(&pubkey_of(&[21u8; 32]), 1),
                    Ingress::RelayDeliver,
                    NOW_MS,
                ) else {
                    panic!("首见必落库");
                };
                write_peer_ad(&conn, &peer, &record).unwrap();
            }
            assert_eq!(count_peer_ads(&conn).unwrap(), MAX_LAN_PEER_RECORDS);
        }
        let mut ctx = ad_ctx(&mut r);
        // 新对端:拒(响亮进通告面诊断,不写库)。
        assert!(ctx.absorb_lan_ad(PEER, &ad_of(&pubkey_of(&[22u8; 32]), 1), Ingress::RelayDeliver, false).is_empty());
        {
            let conn = ctx.db.lock().unwrap();
            assert!(read_peer_ad(&conn, PEER).unwrap().is_none(), "满额不收新对端");
            assert_eq!(count_peer_ads(&conn).unwrap(), MAX_LAN_PEER_RECORDS);
        }
        assert!(ctx.status.lock().unwrap().lan_warning.is_some());
        // 已在册对端换钥:照样禁用落库(满额不许把这一刀绕过去)。
        ctx.absorb_lan_ad(old_peer, &ad_of(&pubkey_of(&[23u8; 32]), 2), Ingress::RelayDeliver, false);
        let conn = ctx.db.lock().unwrap();
        assert!(read_peer_ad(&conn, old_peer).unwrap().unwrap().is_disabled(), "冲突禁用不受满额影响");
    }

    /// 缓存里被粘滞禁用的对端**随装配重检进状态面**(codex 审 M3:只在冲突那一刻 toast
    /// 一次不叫「常驻」——重启后 `merge_peer_ad` 一律 Ignore,再也不会提)。
    #[test]
    fn disabled_peers_are_rebuilt_from_the_cache() {
        let (db, _clock, _dir) = test_db("ad-disabled");
        let conn = db.lock().unwrap();
        let key_a = pubkey_of(&[14u8; 32]);
        let lan::AdMerge::Store { record, .. } =
            lan::merge_peer_ad(None, &ad_of(&key_a, 1), Ingress::RelayDeliver, NOW_MS)
        else {
            panic!("首见必落库");
        };
        write_peer_ad(&conn, PEER, &record).unwrap();
        assert!(disabled_lan_peers(&conn).unwrap().is_empty());
        let lan::AdMerge::Store { record, cause } = lan::merge_peer_ad(
            Some(&record),
            &ad_of(&pubkey_of(&[15u8; 32]), 2),
            Ingress::RelayDeliver,
            NOW_MS,
        ) else {
            panic!("异钥必落库");
        };
        assert_eq!(cause, lan::StoreCause::KeyConflict);
        write_peer_ad(&conn, PEER, &record).unwrap();
        assert_eq!(disabled_lan_peers(&conn).unwrap(), vec![PEER.to_string()]);
        // 一条读不动 = 整张清单响亮失败(不许把「不知道」答成「没有」)。
        meta_put(&conn, &lan_peer_key(PEER), "zz").unwrap();
        assert!(disabled_lan_peers(&conn).is_err());
    }

    /// 丢一帧回复 → 非对称缓存 → 靠**定向索要**收回来(codex 审 M1 要的队列形):
    /// ① A 广播通告、B 首见钉住并回一帧;② **那一帧丢了**(对端正引导 / 中转丢帧);
    /// ③ A 缺 B 的钥,按触发② 定向索要;④ B 虽已缓存 A 仍应答一次 → A 钉住 B;
    /// ⑤ A 的回帧到 B 已无事可做 → 静默。判据与生产同一处真相。
    #[test]
    fn asymmetric_cache_converges_via_the_directed_solicitation() {
        struct Side {
            key: [u8; 32],
            seq: u64,
            cache: Option<lan::LanPeerAd>,
            answered: bool,
        }
        /// 投一枚通告,返回「收端要不要回一帧」。
        fn deliver(sides: &mut [Side; 2], to: usize, ad: &LanAd, directed: bool) -> bool {
            let solicited =
                lan_ad_answer_needed(directed, Ingress::RelayDeliver, sides[to].answered);
            let mut reply = solicited;
            if let lan::AdMerge::Store { record, cause } = lan::merge_peer_ad(
                sides[to].cache.as_ref(),
                ad,
                Ingress::RelayDeliver,
                NOW_MS,
            ) {
                sides[to].cache = Some(record);
                reply |= lan_ad_reply_needed(cause);
            }
            if solicited && reply {
                sides[to].answered = true;
            }
            reply
        }
        let mut sides = [
            Side { key: pubkey_of(&[16u8; 32]), seq: 5, cache: None, answered: false },
            Side { key: pubkey_of(&[17u8; 32]), seq: 1, cache: None, answered: false },
        ];
        let (ad_a, ad_b) = (ad_of(&sides[0].key, sides[0].seq), ad_of(&sides[1].key, sides[1].seq));
        let mut frames = 0;

        frames += 1; // ① A 的广播 Hello
        assert!(deliver(&mut sides, 1, &ad_a, false), "B 首见钉住 → 回一帧");
        frames += 1; // ② B 的回帧……丢了(刻意不投)
        assert!(sides[0].cache.is_none(), "A 仍然没有 B 的钥(非对称态)");

        frames += 1; // ③ A 按触发② 定向索要
        assert!(deliver(&mut sides, 1, &ad_a, true), "已缓存 A 也必须应答索要");
        frames += 1; // ④ B 的应答
        assert!(deliver(&mut sides, 0, &ad_b, true), "A 首见钉住 → 回一帧");
        frames += 1; // ⑤ A 的回帧
        assert!(!deliver(&mut sides, 1, &ad_a, true), "到此静默:非首见 + 索要额度已用");

        assert!(frames <= 6, "收敛帧数须有界,实发 {frames}");
        for (i, s) in sides.iter().enumerate() {
            assert_eq!(
                s.cache.as_ref().and_then(|c| c.usable_pubkey()),
                Some(sides[1 - i].key),
                "第 {i} 端终局必须钉住对端公钥"
            );
        }
    }

    /// 结构锚(264 实现审二轮 M):**两条腿的逐块自证都必须与取数在同一把库锁里**。
    ///
    /// 为什么按源码钉而不是行为测:LAN 那一侧的阴性半由
    /// [`a_recast_identity_stops_the_serve_pump_midstream`] 真跑;中转那一侧要造的是
    /// 「真服务器会话跑着、库里 K_acc 恰在两次取锁之间被换掉」——换了之后整条会话本来
    /// 就要垮,**这个窄窗在集成测里造不出可控的可观测差**(变异对照实测:把那道闸整个
    /// 短路掉,端到端用例照样绿)。按纪律诚实降级:行为测守它守得住的那一半,这条结构锚
    /// 守「检查没跑到锁外面去」。
    #[test]
    fn both_legs_check_identity_inside_the_same_db_lock_as_the_chunk_read() {
        let src = include_str!("transport.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        // 每一处 `read_blob_chunk(` 调用之前、同一个 `db.lock()` 临界区之内,必须先有一次
        // `identity_still_current_conn(`。取「最近一次 lock」到该调用之间那一段来看。
        let calls: Vec<usize> = prod.match_indices("read_blob_chunk(&conn,").map(|(i, _)| i).collect();
        assert_eq!(calls.len(), 2, "恰两处取数(LAN 写泵 + 中转腿),实见 {}", calls.len());
        for at in calls {
            let head = &prod[..at];
            let lock = head.rfind(".lock().expect(\"db mutex poisoned\")").expect("取数必在锁内");
            assert!(
                prod[lock..at].contains("identity_still_current_conn("),
                "取数之前、同一把锁之内必须先自证身份(§6 ⑤ 的第六条出口)"
            );
        }
    }

    /// 结构锚(L-d″ 第④笔):**「标 `ServeBlob` 的回执」与「占住窗口」必须由同一处产出**。
    ///
    /// [`Ctx::relay_blob_acked`] 见到这一类回执就会按凭据 `take` 窗口并推进那笔供流的游标。
    /// 「发了一枚标 `ServeBlob` 的帧、却没占窗口」会让它去动**别人的**窗口。
    ///
    /// 运行期那道闸是 [`RelayDataTicket`](codex 实现审 L1 补的);这条锚守的是它的前提
    /// ——**发号(`occupy_*`)与封发(`Sent::Serve*`)必须在同一个函数体里**,分开写的话
    /// 类型上谁都能只做其中一件。[`Deck::send_relay_as`] 的 `kind` 参数任谁都能传,这一点
    /// 类型封不住,故按源码钉。
    ///
    /// **两类各钉一遍**(第④笔下半):ops 那半多一层类型保护(`OpsJob` 里那枚
    /// [`OpsTicket`] 只在 [`ops_prepare`] 里造得出来),但「占窗与封发同处」这条对它一样是
    /// 前提 —— 少了它,一枚没占窗口的 `Sent::ServeOps` 回执会去 `take` 别人的窗口。
    #[test]
    fn minting_a_serve_receipt_and_taking_the_window_happen_in_one_place() {
        let src = include_str!("transport.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        for (out_fn, call, pump_fn, class, mint, occupy) in [
            (
                "    async fn send_relay_blob(",
                "self.send_relay_blob(",
                "    async fn pump_blob(",
                "图字节",
                "Sent::ServeBlob { ticket, to:",
                "relay_data.occupy_blob(",
            ),
            (
                "    async fn send_relay_ops(",
                "self.send_relay_ops(",
                "    async fn pump_ops(",
                "ops 帧",
                "Sent::ServeOps { ticket, target:",
                "relay_data.occupy_ops(",
            ),
        ] {
            let at = prod.find(out_fn).expect("必有唯一出口");
            let end = at + prod[at..].find("\n    }").expect("函数总有结尾");
            for (what, needle) in [("回执分类", mint), ("占窗口发号", occupy)] {
                let hits: Vec<usize> = prod.match_indices(needle).map(|(i, _)| i).collect();
                assert_eq!(hits.len(), 1, "{class}的{what}写入点必须恰一处,实见 {}", hits.len());
                assert!(
                    (at..end).contains(&hits[0]),
                    "{class}的{what}那一处必须在 {out_fn} 体内(与另一件同生共死)"
                );
            }
            // **上界证明还依赖「传进来的 job 必然刚从待办/计划里取出」**(codex 实现审二轮
            // L2):出口自己不过 admission,日后多一个直接调用点就能绕开那道 16 的闸、
            // 造出第 17 个对端(ops 那半则是绕开 K 与轮转)。故连唯一调用者一起钉。
            let calls: Vec<usize> = prod.match_indices(call).map(|(i, _)| i).collect();
            assert_eq!(calls.len(), 1, "{class}的唯一调用者必须只有那条腿的泵,实见 {}", calls.len());
            let pump = prod.find(pump_fn).expect("必有那条腿的泵");
            let pump_end = pump + prod[pump..].find("\n    }").expect("函数总有结尾");
            assert!(
                (pump..pump_end).contains(&calls[0]),
                "{class}那一处调用必须在 {pump_fn} 体内"
            );
        }
    }

    /// **feed 的出口那几件在失败路径上也要跑**(实现审四轮 M1)。
    ///
    /// 一枚线帧会被切成好几个子批逐批喂进引擎,前面几批可能**已经落地**了——`Changed`
    /// 与状态快照(挂起数 / 冻结清单 / 隔离与 breaker)是它们唯一的通知,被中途那个 `?`
    /// 跳过就得等下一次偶然的刷新。故第一枚 Err 扣到最后再报。行为测要注入「第 k 批失败」
    /// 成本远高于按源码钉,故照 `lan_ad` 那只的同款做法。
    #[test]
    fn feed_defers_its_error_until_after_the_status_snapshot() {
        let src = include_str!("transport.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        let at = prod.find("    async fn feed(").expect("必有 feed");
        let body = &prod[at..at + prod[at..].find("\n    // ---- 出帧").expect("feed 之后是出帧段")];
        let changed = body.find("SyncEvent::Changed").expect("必发 Changed");
        let status = body.find("self.set_status(").expect("必刷状态快照");
        let report = body.find("fault?;").expect("第一枚 Err 必须扣到最后再报");
        assert!(changed < report, "Changed 要排在报错之前");
        assert!(status < report, "状态快照要排在报错之前");
    }

    /// 接线锚:通告吸收**只有一个调用点**,且在 [`Ctx::feed`] 里(§2 唯一权威路的结构
    /// 兑现)。多一处就意味着有人在别处凭手上的 `Ingress` 自证权威路——而「来路只能由
    /// socket 所有者代入」正是二轮 L1 要堵的。按源码钉:两条腿的接线差异在状态面照不出。
    ///
    /// 同时钉**顺序**(codex 审 M4 后半):通告回帧的 dispatch 必须排在引擎处理这枚 Hello
    /// **之后**——advisory 面的一个发送失败点不许把这枚 Hello 的水位挡在引擎门外。
    #[test]
    fn lan_ad_absorbed_only_from_the_single_feed_entry() {
        let src = include_str!("transport.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        let calls: Vec<usize> = prod.match_indices(".absorb_lan_ad(").map(|(i, _)| i).collect();
        assert_eq!(calls.len(), 1, "只许一个调用点,实见 {} 处", calls.len());
        let head = &prod[..calls[0]];
        let last_fn = head
            .rfind("\n    fn ")
            .unwrap_or(0)
            .max(head.rfind("\n    async fn ").unwrap_or(0));
        assert!(
            prod[last_fn..].starts_with("\n    async fn feed("),
            "调用点必须落在 fn feed 里(过了 booting 闸之后的唯一入口)"
        );
        // 顺序:吸收 → 引擎(`on_msg`)→ 才发通告回帧。发送失败点排在水位处理之前的话,
        // 这枚 Hello 的水位就白丢了(行为测要注入 ws 发送失败,成本远高于按源码钉)。
        let body = &prod[last_fn..];
        let to_engine = body.find(".on_msg(").expect("feed 里必有 on_msg");
        let send_reply = body.find("self.dispatch(ad_outs)").expect("必须发通告回帧");
        assert!(calls[0] - last_fn < to_engine, "吸收要在引擎之前(它得先读到旧缓存)");
        assert!(to_engine < send_reply, "通告回帧必须排在引擎处理这枚 Hello 之后");
    }


    // ---- 链路集与两条腿的投递面(L-c2c) --------------------------------------------

    /// 一对 localhost TCP:一端交给传输层(经 handoff 移交),一端留给测试当「对端」。
    async fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let dialing = tokio::spawn(async move { TcpStream::connect(addr).await.expect("connect") });
        let (server, _) = listener.accept().await.expect("accept");
        (dialing.await.expect("join"), server)
    }

    /// 握手已完成的链路(§4 的三步在 lan.rs 里,L-c3 才接线;链路集的入口就收这个)。
    /// 只为把 [`LanLinks::install`] 的形参填满:链路集这一族用例根本不供图,给它一枚
    /// 内存库即可(真供流的验收在 `lan_serve_pump_*` 那几只里,那边用的是真库)。
    fn stub_serve_ctx() -> ServeCtx {
        let (ev_tx, _ev_rx) = mpsc::unbounded_channel();
        ServeCtx {
            db: Arc::new(Mutex::new(Connection::open_in_memory().expect("内存库"))),
            status: Arc::new(Mutex::new(SyncStatus::default())),
            events: ev_tx,
            ops_changed: Arc::new(Notify::new()),
            account_id: "01ACCTAAAAAAAAAAAAAAAAAAAA".into(),
            device_id: "01SELFAAAAAAAAAAAAAAAAAAAA".into(),
            k_acc: [7u8; 32],
            device_seed: [8u8; 32],
            ops: Arc::new(Mutex::new(ops_serve::OpsWorks::default())),
        }
    }

    fn adopted(peer: &str, link_id: u8, stream: TcpStream) -> AdoptedLink {
        AdoptedLink {
            established: lan::LanEstablished { peer: peer.into(), link_id: [link_id; 32] },
            stream,
        }
    }

    /// 测试这一端的假对端:自己读帧、自己封帧,用来看「传输层到底往链路上写了什么」。
    struct FakeLink {
        stream: TcpStream,
    }

    impl FakeLink {
        /// 读一枚 [`lan::LanWire`];超时(或对端关闭)返回 `None`。
        async fn next(&mut self, ms: u64) -> Option<lan::LanWire> {
            use tokio::io::AsyncReadExt;
            let mut prefix = [0u8; 4];
            timeout(Duration::from_millis(ms), self.stream.read_exact(&mut prefix))
                .await
                .ok()?
                .ok()?;
            let n = lan::checked_body_len(prefix, lan::FramePhase::Established).expect("长度前缀");
            let mut body = vec![0u8; n];
            self.stream.read_exact(&mut body).await.expect("帧体");
            Some(lan::decode_wire(&body, lan::FramePhase::Established).expect("解帧"))
        }

        /// 一直读到一枚 `Frame`(跳过 Ping/Pong),解出内层消息;超时返回 `None`。
        async fn next_msg(&mut self, cfg: &SyncConfig, ms: u64) -> Option<(String, String, Msg)> {
            loop {
                match self.next(ms).await? {
                    lan::LanWire::Frame { from, to, blob } => {
                        let Opened::Data(msg) = open_deliver(cfg, &from, &to, &blob) else {
                            panic!("链路上的帧解不开");
                        };
                        return Some((from, to, msg));
                    }
                    _ => continue,
                }
            }
        }

        /// socket 真的关了吗(EOF / 被重置),而不只是「这会儿没帧」——两者在
        /// [`FakeLink::next`] 里都是 `None`,拿它断言「链路已关」是**假绿**。
        async fn closed(&mut self, ms: u64) -> bool {
            use tokio::io::AsyncReadExt;
            let mut b = [0u8; 1];
            matches!(
                timeout(Duration::from_millis(ms), self.stream.read(&mut b)).await,
                Ok(Ok(0)) | Ok(Err(_))
            )
        }

        async fn send(&mut self, wire: &lan::LanWire) {
            use tokio::io::AsyncWriteExt;
            let bytes = lan::frame_bytes(wire).expect("封帧");
            self.stream.write_all(&bytes).await.expect("写链路");
        }

        /// 以对端身份封一枚数据帧发过来(同一套 K_acc / 域子钥 / AAD,只换管子)。
        async fn send_msg(&mut self, cfg: &SyncConfig, from: &str, to: &str, msg: &Msg) {
            let blob = crypto::seal_msg(
                &cfg.k_acc,
                &FrameAddr {
                    account_id: &cfg.account_id,
                    from_device: from,
                    to,
                    domain: msg_domain(msg),
                },
                msg,
            );
            self.send(&lan::LanWire::Frame { from: from.into(), to: to.into(), blob }).await;
        }
    }

    /// 一台只有 lan 腿的传输任务的把手(见 [`lan_rig`])。
    struct LanRig {
        db: Arc<Mutex<Connection>>,
        clock: Arc<Mutex<Clock>>,
        status: Arc<Mutex<SyncStatus>>,
        device: String,
        handoff: mpsc::Sender<AdoptedLink>,
        task: tokio::task::JoinHandle<TransportExit>,
        ctl: mpsc::Sender<Control>,
        _dir: PathBuf,
    }

    /// 起一台**只有 lan 腿**的传输任务:服务器地址指向必然连不上的端口,故它一路停在
    /// 离线泵里——正是 §11 要的「WAN 从启动前就断」的冷启动形(一条 WSS Challenge 都没
    /// 见过,LanReady 照样置位:不变量 6)。
    fn lan_rig(tag: &str, seed: u8) -> LanRig {
        // 必然连不上的端口:拨号当场失败,一路停在离线泵里。
        lan_rig_at(tag, seed, "ws://127.0.0.1:1")
    }

    /// 同上,但中转地址由调用方给(H1 的用例要一台「接受连接后一言不发」的假中转)。
    fn lan_rig_at(tag: &str, seed: u8, url: &str) -> LanRig {
        lan_rig_at_beat(tag, seed, url, Duration::from_secs(HEARTBEAT_SECS))
    }

    /// 同上,但心跳周期也由调用方给(见 [`run_with_beat`]:挂在心跳上的规则要看好几拍)。
    fn lan_rig_at_beat(tag: &str, seed: u8, url: &str, beat: Duration) -> LanRig {
        let (db, clock, dir) = test_db(tag);
        {
            let mut conn = db.lock().unwrap();
            // epoch_source = true → 连 bootstrapped_at 一起落:本机即纪元源,永不引导。
            save_config(&mut conn, ACCT, &[5u8; 32], &[seed; 32], url, true).unwrap();
        }
        rig_over_beat(db, clock, dir, beat)
    }

    /// 真在服务器上创号、随后起 runtime——**会真走到 `Authed`** 的那一路(已鉴权会话里的
    /// lan 三臂要过闸,验它得有一条真会话)。
    async fn authed_lan_rig(tag: &str, url: &str) -> LanRig {
        let (db, clock, dir) = test_db(tag);
        create_account(&db, url).await.expect("创号");
        rig_over(db, clock, dir)
    }

    /// 已配置好的库上起一台传输 runtime(账户怎么来的由调用方定)。
    fn rig_over(db: Arc<Mutex<Connection>>, clock: Arc<Mutex<Clock>>, dir: PathBuf) -> LanRig {
        rig_over_beat(db, clock, dir, Duration::from_secs(HEARTBEAT_SECS))
    }

    /// 同上,心跳周期由调用方给。
    fn rig_over_beat(
        db: Arc<Mutex<Connection>>,
        clock: Arc<Mutex<Clock>>,
        dir: PathBuf,
        beat: Duration,
    ) -> LanRig {
        let device = {
            let conn = db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置").device_id
        };
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, _ev_rx) = mpsc::unbounded_channel();
        let status = Arc::new(Mutex::new(SyncStatus::default()));
        let wrote = Arc::new(Notify::new());
        {
            let conn = db.lock().unwrap();
            hook_oplog_writes(&conn, wrote.clone());
        }
        let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let t = Transport {
            db: db.clone(),
            clock: clock.clone(),
            status: status.clone(),
            events: ev_tx,
            control: ctl_rx,
            wrote,
            data_dir: dir.clone(),
            blob_policy: BlobPolicy::Full,
            allow_boot_source: true,
            shutdown: shutdown_rx,
            boot_commit: Arc::new(Mutex::new(None)),
            restart_flag: Arc::new(Mutex::new(None)),
            lan: None,
        };
        let (handoff, handoff_rx) = mpsc::channel(LAN_HANDOFF_CAP);
        // 拨号器也拿一枚发送端:这台 rig 不监听(`lan: None` = 手机形),故方向规则下它
        // 恒是合法拨出方——缓存里有带 listen 的对端时它真会拨出去。
        let task = tokio::spawn(run_with_handoff(t, handoff_rx, Some(handoff.clone()), beat));
        LanRig { db, clock, status, device, handoff, task, ctl: ctl_tx, _dir: dir }
    }

    /// 直接造一台离线投递面(没有中转腿)+ 一条假链路,给不需要整个 `run` 的用例。
    struct DeckRig {
        db: Arc<Mutex<Connection>>,
        clock: Arc<Mutex<Clock>>,
        status: Arc<Mutex<SyncStatus>>,
        ev_tx: mpsc::UnboundedSender<SyncEvent>,
        _events: mpsc::UnboundedReceiver<SyncEvent>,
        slot: EngineSlot,
        lan_rx: mpsc::Receiver<LanInbound>,
        _lan_faults: mpsc::Receiver<LanFault>,
        cfg: SyncConfig,
        _dir: PathBuf,
    }

    /// 离线投递面测试共用的那一份配置(测试要自己封帧,故得拿到同一份材料)。
    ///
    /// **从库里读回**,不是凭空造:LAN 供流写泵每块都要自证身份(§6 ⑤ 的第六条出口),
    /// 拿一份库里根本没有的假 cfg 去跑,栅栏当场就落——那是夹具不实,不是被测行为
    /// (同 [`saved_cfg`] 那条注释的道理)。写库这一手在 [`deck_rig`] 里。
    fn deck_cfg(db: &Arc<Mutex<Connection>>) -> SyncConfig {
        let conn = db.lock().unwrap();
        load_config(&conn).unwrap().expect("deck_rig 已把配置写进库")
    }

    fn deck_rig(tag: &str) -> DeckRig {
        let (db, clock, dir) = test_db(tag);
        let cfg = saved_cfg(&db); // 连 bootstrapped_at 一起落(引擎装配的前提)
        let (mut slot, lan_rx, fault_rx) = EngineSlot::new(BlobPolicy::Full, None);
        {
            let conn = db.lock().unwrap();
            slot.reconcile(&conn, &cfg).unwrap();
        }
        let (ev_tx, events) = mpsc::unbounded_channel();
        DeckRig {
            db,
            clock,
            status: Arc::new(Mutex::new(SyncStatus::default())),
            ev_tx,
            _events: events,
            slot,
            lan_rx,
            _lan_faults: fault_rx,
            cfg,
            _dir: dir,
        }
    }

    fn offline_face(r: &mut DeckRig) -> Deck<'_> {
        Deck {
            db: &r.db,
            clock: &r.clock,
            status: &r.status,
            events: &r.ev_tx,
            cfg: &r.cfg,
            slot: &mut r.slot,
            relay: RelayLeg::Down,
        }
    }

    // 对端 device id 必须是**规范 26 字符 Crockford**(`is_canonical_device_id`):原来的
    // `…PEERONE…` 里那个 `O` 压根不在 ULID 字母表里,生产里造不出这种设备 id,而
    // `ops_serve` 的形态闸一接就把整族用例判成 `Malformed`(276 给第①笔那批夹具改过同一处)。
    const PEER_ONE: &str = "01PEER1AAAAAAAAAAAAAAAAAAA";
    const PEER_TWO: &str = "01PEER2AAAAAAAAAAAAAAAAAAA";
    /// 第三台:验 target 轮转要有两个**逻辑目的地**同时有活(L-d″ 第④笔下半)。
    const PEER_THREE: &str = "01PEER3BBBBBBBBBBBBBBBBBBB";

    /// §5 的补投判据(一处一义):中转腿通着的对端**不补投**(不变量 1「唯一副本路」),
    /// 中转腿不可达而 lan 腿在的才补;本机会话一断,全部对端的 relay 腿都是 Absent,同一
    /// 条规则自然就成了「全部 mail 走各 lan 链路」——传输层因此不需要第二套离线分支。
    #[test]
    fn lan_backfill_follows_the_route_table_only() {
        let (db, _clock, _dir) = test_db("lan-backfill");
        let conn = db.lock().unwrap();
        let mut e = Engine::new_solo(&conn, BlobPolicy::Full).unwrap();
        e.on_runtime_started(&conn).unwrap();
        e.on_lan_link_up(&conn, PEER_ONE, 1).unwrap();
        assert!(e.lan_backfill(PEER_ONE), "中转腿不在:定向 mail 要沿 lan 补投");
        assert_eq!(e.lan_backfill_peers(), vec![PEER_ONE.to_string()]);

        e.on_relay_session_up(&conn, 0).unwrap();
        e.on_relay_peer_up(PEER_ONE);
        assert!(!e.lan_backfill(PEER_ONE), "中转腿通着就只走中转(不变量 1)");
        assert!(e.lan_backfill_peers().is_empty());

        e.on_relay_peer_down(PEER_ONE);
        assert!(e.lan_backfill(PEER_ONE), "对端中转离线 → 例外③ 补投");

        e.on_relay_peer_up(PEER_ONE);
        e.on_lan_link_up(&conn, PEER_TWO, 2).unwrap();
        e.on_relay_session_down();
        let mut all = e.lan_backfill_peers();
        all.sort();
        assert_eq!(all, vec![PEER_ONE.to_string(), PEER_TWO.to_string()], "会话断 = 全员补投");
    }

    /// §10 的两道队列闸:任一超界 = **断该链**(不阻塞、不改走中转),并把代次交回调用方
    /// 去通报引擎。集合是链路集自己的,故失败的那一刻链路就已经不在表里了。
    #[tokio::test]
    async fn lan_queue_bounds_break_the_link_and_hand_back_the_generation() {
        let (mut links, _rx, _faults) = LanLinks::new();
        let (mine, theirs) = tcp_pair().await;
        // 对端只连不读:写任务把 socket 缓冲写满之后,队列就再也不排空了。
        let _theirs = theirs;
        let gen = links.next_generation().expect("号没用尽");
        links.install(gen, "01SELFAAAAAAAAAAAAAAAAAAAA", adopted(PEER_ONE, 1, mine), stub_serve_ctx());

        // 单帧就超字节上界 → 当场断链(帧本身合法,是队列这一侧的闸)。
        let huge = Arc::new(vec![0u8; LAN_LINK_QUEUE_BYTES + 1]);
        let out = links.enqueue(PEER_ONE, &huge);
        assert!(out.evicted.is_empty(), "每链闸的受害者恒是本链,不许顺手摘别人");
        match out.outcome {
            Err(LanSendErr::Failed { generation, why }) => {
                assert_eq!(generation, gen, "代次要交回去,调用方据此通报引擎该腿 down");
                assert!(why.contains("字节上界"), "实见 {why}");
            }
            _ => panic!("超字节上界必须断链"),
        }
        assert_eq!(links.count(), 0, "断链 = 当场从表里摘掉");
        assert!(matches!(links.enqueue(PEER_ONE, &huge).outcome, Err(LanSendErr::NoLink)));
    }

    /// 一批链路装进链路集,`queued` 直接落账到指定值。**不真写字节**:两道预算闸判的就是
    /// 这个计数器,真压 32 MiB 进 socket 只是让用例慢上几十倍、还得跟内核缓冲的尺寸赌。
    /// 对端 socket 由返回值持有(丢了链路当场就死,表也就堵不起来了)。
    async fn blocked_links(links: &mut LanLinks, load: &[(String, usize)]) -> (Vec<TcpStream>, Vec<u64>) {
        let mut keep = vec![];
        let mut gens = vec![];
        for (i, (peer, bytes)) in load.iter().enumerate() {
            let (mine, theirs) = tcp_pair().await;
            keep.push(theirs);
            let g = links.next_generation().expect("号没用尽");
            links.install(
                g,
                "01SELFAAAAAAAAAAAAAAAAAAAA",
                adopted(peer, i as u8 + 1, mine),
                stub_serve_ctx(),
            );
            links.links[peer.as_str()].queued.store(*bytes, AtomicOrdering::SeqCst);
            gens.push(g);
        }
        assert!(
            links.space_queued() <= LAN_SPACE_QUEUE_BYTES,
            "夹具本身得是个合法初态:预算不变量在入队前恒成立"
        );
        (keep, gens)
    }

    /// L-d″ 第③笔:**空间预算耗尽时摘的是积压最多的那条,不是碰巧此刻要发帧的那条**。
    ///
    /// 改动前:几条堵死的链把 32 MiB 预算吃光,第五条**队列全空**的健康链一发帧就被摘掉
    /// ——而堵着的那几条纹丝不动,重拨重建之后下一枚帧照样撞同一堵墙。那台健康对端因此
    /// 永远建不成直连,中转还得替它扛全部流量。
    ///
    /// 这里用**五条堵塞链 + 第六条健康链**(规格记的是「四条 + 第五条」):积压给成不等
    /// 值,「最重那条」才唯一可辨——四条并列的话,摘对了也只是撞上了平手的字典序。
    /// 在离线投递面上建 n 条链,读掉各自的建链 Hello,**并等那几枚 Hello 的字节从队列账上
    /// 销掉**——否则迟到的那记 `fetch_sub` 会从用例摆好的堵塞账里挖掉几百字节,而这道闸正是
    /// 按字节比大小的。
    async fn deck_links(r: &mut DeckRig, cfg: &SyncConfig, n: usize) -> (Vec<String>, Vec<FakeLink>) {
        let peers: Vec<String> = (1..=n).map(|i| format!("01PEER{i:020}")).collect();
        let mut fakes = vec![];
        for (i, id) in peers.iter().enumerate() {
            let (mine, theirs) = tcp_pair().await;
            let mut fake = FakeLink { stream: theirs };
            offline_face(r).lan_adopt(adopted(id, i as u8 + 1, mine)).await.unwrap();
            fake.next_msg(cfg, 1000).await.expect("建链的定向 Hello");
            fakes.push(fake);
        }
        for id in &peers {
            let q = Arc::clone(&r.slot.lan.links[id.as_str()].queued);
            let deadline = Instant::now() + Duration::from_secs(5);
            while q.load(AtomicOrdering::SeqCst) != 0 {
                assert!(Instant::now() < deadline, "Hello 的字节始终没从队列账上销掉");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        (peers, fakes)
    }

    #[tokio::test]
    async fn the_space_budget_evicts_the_heaviest_link_not_the_sender() {
        const MIB: usize = 1024 * 1024;
        let mut r = deck_rig("lan-budget-victim");
        let cfg = deck_cfg(&r.db);
        let (peers, mut fakes) = deck_links(&mut r, &cfg, 6).await;
        // 五条堵塞链合计恰好顶满预算(8+7+7+6+4),第六条空着。
        let load = [8 * MIB, 7 * MIB, 7 * MIB, 6 * MIB, 4 * MIB, 0];
        for (id, bytes) in peers.iter().zip(load) {
            r.slot.lan.links[id.as_str()].queued.store(bytes, AtomicOrdering::SeqCst);
        }
        assert_eq!(r.slot.lan.space_queued(), LAN_SPACE_QUEUE_BYTES, "预算已顶满");

        // 健康链只想发一枚很小的补洞请求。
        let healthy = peers[5].clone();
        let _outs = {
            let mut deck = offline_face(&mut r);
            let msg = Msg::Want { origin: peers[0].clone(), from_seq: 1 };
            let bytes = deck.seal_for_lan(&healthy, &msg).expect("封得出");
            deck.push_lan(&healthy, &bytes).outs
        };

        // ① 无辜的健康链活着,而且这一笔**真发出去了**(对端读得到才算)。
        assert!(r.slot.lan.links.contains_key(&healthy), "健康链不许替堵塞链挨摘");
        let (_, _, msg) = fakes[5].next_msg(&cfg, 1000).await.expect("健康链上的帧要真到对端");
        assert!(matches!(msg, Msg::Want { .. }), "实见 {msg:?}");
        // ② 摘的是积压最多那条,别的堵塞链一条都没牵连(腾一条就够了)。
        assert!(!r.slot.lan.links.contains_key(&peers[0]), "8 MiB 那条才是该摘的");
        for id in &peers[1..5] {
            assert!(r.slot.lan.links.contains_key(id), "{id} 不该受牵连");
        }
        assert_eq!(r.slot.lan.count(), 5);
        // ③ 通报义务真的落到了引擎:被摘那条的 lan 腿已 down,否则选路会一直往它投。
        let e = r.slot.peek().expect("引擎在场");
        assert!(!e.lan_backfill(&peers[0]), "被摘的链必须在引擎侧也 down");
        assert!(e.lan_backfill(&healthy), "健康链在引擎侧照旧可投");
        // ④ 状态面说的是**被摘那条**,不是收件人(受害者报错人 = 用户看不出谁掉了)。
        let s = r.status.lock().unwrap();
        assert_eq!(s.lan_peers, 5);
        let warn = s.lan_warning.clone().expect("摘链要有告警");
        assert!(warn.contains(&peers[0]) && warn.contains("预算"), "实见 {warn}");
        assert!(!warn.contains(&healthy), "收件人是无辜的,别把它写成断了的那条");
    }

    /// 实现审一轮 M1:**采样到动手之间写泵把候选排空了 → 不摘它**。
    ///
    /// 写泵是并发减账的,「预算超着」与「谁最重」若来自两次独立的读,就会读出自相矛盾的组合
    /// (预算按旧数超着、候选按新数全空),于是平手规则挑中一条**队列早就空了的健康链**——
    /// 本笔要修的病换个入口就回来了。修法两半:一次遍历同时取两者(候选恒来自压着字节的链),
    /// 外加破坏性动作之前再复核一次。这里用 [`arm_budget_probe_hook`] 把「排空」钉在确定的
    /// 那一刻(同步函数插不进 await 型栅栏)。
    #[tokio::test]
    async fn a_candidate_that_drained_between_sampling_and_eviction_is_spared() {
        const MIB: usize = 1024 * 1024;
        let (mut links, _rx, _faults) = LanLinks::new();
        let peers: Vec<String> = (1..=5).map(|i| format!("01PEER{i:020}")).collect();
        let load: Vec<(String, usize)> = peers
            .iter()
            .cloned()
            .zip([8 * MIB, 8 * MIB, 8 * MIB, 8 * MIB, 0])
            .collect();
        let (_keep, _gens) = blocked_links(&mut links, &load).await;
        assert_eq!(links.space_queued(), LAN_SPACE_QUEUE_BYTES, "预算已顶满");

        // 采样选中的必是 peers[0](8 MiB 平手取字典序小者);就在那一刻它被写完排空。
        let drained = Arc::clone(&links.links[peers[0].as_str()].queued);
        arm_budget_probe_hook(move || drained.store(0, AtomicOrdering::SeqCst));

        let out = links.enqueue(&peers[4], &Arc::new(vec![0u8; 64]));
        assert!(out.outcome.is_ok(), "预算已被写泵自己腾出来了,这一笔该发得出去");
        assert!(out.evicted.is_empty(), "已经排空的链不是负载源:一条都不该摘");
        assert_eq!(links.count(), 5, "五条链一条不少");
    }

    /// 实现审二轮 M:**预算在采样之后自己回到了线下 → 一条都不该摘**。
    ///
    /// 一轮那版复核只问「候选归零了吗」,而候选**少 64 字节**就足以让 `space + len` 回到线
    /// 内——它照样非零,于是照摘不误。这只用例正是那个反例:四条各 8 MiB 顶满、本次 64 字节,
    /// 候选在采样后只减掉这 64 字节。
    #[tokio::test]
    async fn a_budget_that_recovered_between_sampling_and_eviction_evicts_nobody() {
        const MIB: usize = 1024 * 1024;
        let (mut links, _rx, _faults) = LanLinks::new();
        let peers: Vec<String> = (1..=5).map(|i| format!("01PEER{i:020}")).collect();
        let load: Vec<(String, usize)> = peers
            .iter()
            .cloned()
            .zip([8 * MIB, 8 * MIB, 8 * MIB, 8 * MIB, 0])
            .collect();
        let (_keep, _gens) = blocked_links(&mut links, &load).await;

        let shrunk = Arc::clone(&links.links[peers[0].as_str()].queued);
        arm_budget_probe_hook(move || {
            shrunk.fetch_sub(64, AtomicOrdering::SeqCst);
        });

        let out = links.enqueue(&peers[4], &Arc::new(vec![0u8; 64]));
        assert!(out.outcome.is_ok(), "预算已经回到线下了,这一笔当然发得出去");
        assert!(out.evicted.is_empty(), "没人超预算的时候不许摘任何链");
        assert_eq!(links.count(), 5, "五条链一条不少");
    }

    /// 实现审二轮 M 的另一半:**候选在采样之后降级了 → 按新样本重选**,而不是照着过时的
    /// 那份采样动手。
    ///
    /// 四条各 8 MiB 顶满、本次 2 MiB(超出量 2 MiB):候选 `peers[0]` 在采样后只掉 1 MiB,
    /// 预算**仍超**(31+2 > 32)但它已经不是最重的了 —— 该摘的是 `peers[1]`。
    #[tokio::test]
    async fn a_stale_candidate_is_reselected_from_the_fresh_sample() {
        const MIB: usize = 1024 * 1024;
        let (mut links, _rx, _faults) = LanLinks::new();
        let peers: Vec<String> = (1..=5).map(|i| format!("01PEER{i:020}")).collect();
        let load: Vec<(String, usize)> = peers
            .iter()
            .cloned()
            .zip([8 * MIB, 8 * MIB, 8 * MIB, 8 * MIB, 0])
            .collect();
        let (_keep, gens) = blocked_links(&mut links, &load).await;

        let demoted = Arc::clone(&links.links[peers[0].as_str()].queued);
        arm_budget_probe_hook(move || {
            demoted.fetch_sub(MIB, AtomicOrdering::SeqCst);
        });

        let out = links.enqueue(&peers[4], &Arc::new(vec![0u8; 2 * MIB]));
        assert!(out.outcome.is_ok());
        let victims: Vec<String> = out.evicted.iter().map(|(p, _)| p.clone()).collect();
        assert_eq!(victims, vec![peers[1].clone()], "该摘的是新样本里最重的那条");
        match &out.evicted[0].1 {
            LanSendErr::Failed { generation, .. } => assert_eq!(*generation, gens[1]),
            _ => panic!("被摘的链一律是 Failed"),
        }
        assert!(links.links.contains_key(&peers[0]), "降级了的那条不该按过时采样挨摘");
    }

    /// 实现审一轮 L1:**多条旁链被摘 + 本链自己也失败**时,每一条都得拿到自己那份 down
    /// 通报。漏法有两种——只通报第一条旁链;或者「旁链通报了,本链的 down 蒸发了」。
    ///
    /// 直接喂一枚 8 MiB 字节块(生产里帧封顶 1 MiB,故这条组合面在真封帧下不可达)——验的是
    /// [`Deck::push_lan`] 那三行的通报契约,而「循环不依赖常量」既然是明确契约,通报面就得
    /// 跟着覆盖多条。本链的失败用**写端已收场**造(abort 写任务),不赌 socket 缓冲尺寸。
    #[tokio::test]
    async fn every_victim_and_the_sender_all_get_their_own_down_report() {
        const MIB: usize = 1024 * 1024;
        let mut r = deck_rig("lan-budget-reports");
        let cfg = deck_cfg(&r.db);
        let (peers, _fakes) = deck_links(&mut r, &cfg, 9).await;
        // 八条各 4 MiB 顶满 32 MiB,第九条空着当收件人:8 MiB 的一笔要摘两条才装得下。
        for id in &peers[..8] {
            r.slot.lan.links[id.as_str()].queued.store(4 * MIB, AtomicOrdering::SeqCst);
        }
        let sender = peers[8].clone();
        // 收件人的写端先收场 → 腾挪之后那记 `try_send` 必失败,于是本链自己也要挨一刀。
        r.slot.lan.links[sender.as_str()].writer.abort();
        while !r.slot.lan.links[sender.as_str()].writer.is_finished() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let _outs = {
            let mut deck = offline_face(&mut r);
            deck.push_lan(&sender, &Arc::new(vec![0u8; 8 * MIB])).outs
        };

        assert_eq!(r.slot.lan.count(), 6, "两条旁链 + 收件人自己,三条都该走了");
        let e = r.slot.peek().expect("引擎在场");
        for id in &peers[..2] {
            assert!(!e.lan_backfill(id), "{id} 是被摘的旁链,引擎侧必须也 down");
        }
        assert!(!e.lan_backfill(&sender), "本链的 down 不许被旁链的通报挤掉");
        for id in &peers[2..8] {
            assert!(e.lan_backfill(id), "{id} 没被摘,路由不该动");
        }
        assert_eq!(r.status.lock().unwrap().lan_peers, 6);
    }

    /// 反面:**积压最多的那条恰好就是本次收件人** → 摘它、本次告负,一条旁链都不牵连。
    /// 修法不能矫枉过正成「收件人永不被摘」——那样最堵的那条反倒免疫,预算再也收不回来。
    #[tokio::test]
    async fn a_sender_that_is_itself_the_heaviest_pays_for_its_own_backlog() {
        const MIB: usize = 1024 * 1024;
        let (mut links, _rx, _faults) = LanLinks::new();
        let peers: Vec<String> = (1..=5).map(|i| format!("01PEER{i:020}")).collect();
        // 收件人 7 MiB 是唯一最重的,其余 6.5/6.5/6.5/5.5 —— 合计恰好顶满 32 MiB。
        let load: Vec<(String, usize)> = peers
            .iter()
            .cloned()
            .zip([13 * MIB / 2, 13 * MIB / 2, 13 * MIB / 2, 11 * MIB / 2, 7 * MIB])
            .collect();
        let (_keep, gens) = blocked_links(&mut links, &load).await;
        assert_eq!(links.space_queued(), LAN_SPACE_QUEUE_BYTES, "预算已顶满");

        let sender = peers[4].clone();
        let out = links.enqueue(&sender, &Arc::new(vec![0u8; 64]));
        assert!(out.evicted.is_empty(), "最重的就是自己:没有别人替它挨摘");
        match out.outcome {
            Err(LanSendErr::Failed { generation, why }) => {
                assert_eq!(generation, gens[4], "交回的是本链的代次");
                assert!(why.contains("预算"), "实见 {why}");
            }
            _ => panic!("本链最重时必须摘本链"),
        }
        assert!(!links.links.contains_key(&sender), "本链已摘");
        assert_eq!(links.count(), 4, "别的链一条都不许动");
    }

    /// 腾挪要**腾到够为止**:一条不够就接着摘下一条最重的,直到这一笔真装得下。
    ///
    /// 生产里一枚 lan 帧封顶 1 MiB,故按当前常量它至多摘一条(16 条链均摊 32 MiB 时最重那
    /// 条 ≥2 MiB);这里绕开封帧、直接喂一枚 8 MiB 的字节块,验的是**循环本身收敛**——那
    /// 是「预算不变量不依赖 `LAN_FRAME_MAX`/`LAN_LINKS_MAX`/`LAN_SPACE_QUEUE_BYTES` 三者
    /// 算术关系」的唯一凭据,三个数里任意一个被改,靠的都是它。
    #[tokio::test]
    async fn budget_eviction_keeps_going_until_the_frame_fits() {
        const MIB: usize = 1024 * 1024;
        let (mut links, _rx, _faults) = LanLinks::new();
        let peers: Vec<String> = (1..=LAN_LINKS_MAX).map(|i| format!("01PEER{i:020}")).collect();
        // 15 条各 2 MiB(共 30 MiB)+ 本链空:8 MiB 的一笔要摘掉三条才装得下。
        let load: Vec<(String, usize)> = peers
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, p)| (p, if i + 1 == LAN_LINKS_MAX { 0 } else { 2 * MIB }))
            .collect();
        let (_keep, gens) = blocked_links(&mut links, &load).await;

        let sender = peers[LAN_LINKS_MAX - 1].clone();
        let out = links.enqueue(&sender, &Arc::new(vec![0u8; 8 * MIB]));
        assert!(out.outcome.is_ok(), "腾够了就该发得出去");
        let victims: Vec<String> = out.evicted.iter().map(|(p, _)| p.clone()).collect();
        assert_eq!(victims, peers[..3].to_vec(), "摘的是最重的三条(全平手则字典序在前的先摘)");
        for (i, (_, err)) in out.evicted.iter().enumerate() {
            match err {
                LanSendErr::Failed { generation, why } => {
                    assert_eq!(*generation, gens[i], "每条被摘的链都得把自己的代次交回去");
                    assert!(why.contains("预算"), "实见 {why}");
                }
                _ => panic!("被摘的链一律是 Failed"),
            }
        }
        assert_eq!(links.count(), LAN_LINKS_MAX - 3);
        assert!(
            links.space_queued() <= LAN_SPACE_QUEUE_BYTES,
            "入队之后预算不变量必须重新成立(这才是腾挪的目的)"
        );
    }

    /// §10 的**断链信号独立通道**(实现审 M2):数据面积压满(64 枚没人取)时,写端失败的
    /// 那声死讯照样立刻走得动。合成一根的话,它连入队都做不到——`send().await` 挂在满通道
    /// 上,摘腿、作废在飞 pull、重问缺字节全得等协调者把那 64 枚啃完,而那正是「链路已经不行
    /// 了」的时刻,最不该等的就是它。
    #[tokio::test]
    async fn a_full_data_channel_cannot_delay_a_link_down() {
        let (mut links, _rx, mut faults) = LanLinks::new();
        let (mine, theirs) = tcp_pair().await;
        let gen = links.next_generation().expect("号没用尽");
        links.install(gen, "01SELFAAAAAAAAAAAAAAAAAAAA", adopted(PEER_ONE, 1, mine), stub_serve_ctx());

        // 数据通道灌满:协调者这会儿正忙着别的,一枚都没取。
        let data = links.inbound_tx.clone();
        let pong = || LanInbound {
            peer: PEER_ONE.into(),
            generation: gen,
            event: LanEvent::Pong,
        };
        for _ in 0..LAN_INBOUND_CAP {
            data.try_send(pong()).expect("灌到满为止");
        }
        assert!(data.try_send(pong()).is_err(), "数据通道确实满了(不满就什么也证不了)");

        // 对端设 linger(0) 再丢弃 = 立刻 RST(不是 FIN),本机接着写必失败。
        theirs.set_linger(Some(Duration::ZERO)).expect("set_linger");
        drop(theirs);

        // 要的是**写端**那一声:读端此刻也会因 RST 而死,拿「收到任意一枚死讯」当判据是
        // 假绿(阴性对照当场证过——只把写端的死讯搬回数据通道,那样的测照样绿)。RST 落地
        // 的时刻由内核定,故边推边收,推到写失败为止。
        let frame = Arc::new(vec![0u8; 64]);
        let deadline = Instant::now() + Duration::from_millis(3000);
        let mut writer_down = None;
        while Instant::now() < deadline && writer_down.is_none() {
            let _ = links.enqueue(PEER_ONE, &frame);
            if let Ok(Some(f)) = timeout(Duration::from_millis(50), faults.recv()).await {
                assert_eq!(f.peer, PEER_ONE);
                assert_eq!(f.generation, gen, "代次随死讯走(迟到的旧代打不掉新链)");
                if f.why.contains("写链路") {
                    writer_down = Some(f);
                }
            }
        }
        assert!(writer_down.is_some(), "写端的死讯没能在数据面满着时送达");
    }

    /// §7 二级规则:同对端并发建链,两侧拿同一把尺(`link_id` 字典序)比,小者胜——故不会
    /// 「各关各的」双断。容量满额则 fail-closed(只影响直连)。
    #[tokio::test]
    async fn lan_admit_keeps_the_smaller_link_id_and_caps_the_set() {
        let (mut links, _rx, _faults) = LanLinks::new();
        let (mine, _theirs) = tcp_pair().await;
        let gen = links.next_generation().expect("号没用尽");
        links.install(gen, "01SELFAAAAAAAAAAAAAAAAAAAA", adopted(PEER_ONE, 5, mine), stub_serve_ctx());

        let bigger = lan::LanEstablished { peer: PEER_ONE.into(), link_id: [9u8; 32] };
        assert!(links.admit(&bigger).is_err(), "在位那条的 link_id 更小:候选者出局");
        let smaller = lan::LanEstablished { peer: PEER_ONE.into(), link_id: [1u8; 32] };
        assert!(links.admit(&smaller).is_ok(), "候选者更小:它该替换在位那条");

        let mut keep = vec![];
        for i in 1..LAN_LINKS_MAX {
            let (m, t) = tcp_pair().await;
            keep.push(t); // 对端 socket 得活着,否则链路立刻死掉、表就满不了
            let g = links.next_generation().expect("号没用尽");
            links.install(g, "01SELFAAAAAAAAAAAAAAAAAAAA", adopted(&format!("01PEER{i:020}"), 3, m), stub_serve_ctx());
        }
        assert_eq!(links.count(), LAN_LINKS_MAX);
        let fresh = lan::LanEstablished { peer: "01NEWPEERAAAAAAAAAAAAAAAAA".into(), link_id: [0u8; 32] };
        assert!(links.admit(&fresh).is_err(), "满额 = 新对端 fail-closed");
    }

    /// 链路替换之后,**旧代的迟到事件一律丢弃**(§5.1 同一条纪律):否则一枚迟到的断链
    /// 通报就能把刚建好的新链打掉。
    #[tokio::test]
    async fn late_events_from_a_replaced_link_are_ignored() {
        let (mut links, _rx, _faults) = LanLinks::new();
        let (m1, _t1) = tcp_pair().await;
        let (m2, _t2) = tcp_pair().await;
        let g1 = links.next_generation().expect("号没用尽");
        links.install(g1, "01SELFAAAAAAAAAAAAAAAAAAAA", adopted(PEER_ONE, 5, m1), stub_serve_ctx());
        let g2 = links.next_generation().expect("号没用尽");
        links.install(g2, "01SELFAAAAAAAAAAAAAAAAAAAA", adopted(PEER_ONE, 1, m2), stub_serve_ctx());
        assert!(g2 > g1, "代次单调,永不复用");
        assert!(!links.touch(PEER_ONE, g1), "旧代的帧不算数");
        assert!(links.touch(PEER_ONE, g2));
        assert!(!links.close(PEER_ONE, g1), "旧代的断链通报打不掉新链");
        assert_eq!(links.count(), 1);
        assert!(links.close(PEER_ONE, g2));
        assert_eq!(links.count(), 0);
    }

    /// 在这条链上贴一张图,并让对端沿链发一枚 `BlobPull`(协调者跑一轮把它喂进去)。
    /// 返回图 id 与原始字节。
    async fn pull_a_fresh_image(
        r: &mut DeckRig,
        peer: &mut FakeLink,
        cfg: &SyncConfig,
        size: usize,
        transfer: &str,
    ) -> (String, Vec<u8>) {
        // 夹具自检:transfer 不合 ULID 形态会被供方**响亮拒帧**(263 顺带封的放大面),
        // 于是一枚块都不发——那会让下面的用例以「没收到块」的形式假装失败/假装通过。
        ulid::Ulid::from_string(transfer).expect("夹具的 transfer 得是合法 ULID");
        let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let img = {
            let mut conn = r.db.lock().unwrap();
            let mut clk = r.clock.lock().unwrap();
            let item = notes::capture(&mut conn, &mut clk, "带图").unwrap();
            images::attach(&mut conn, &mut clk, &item, &bytes, "image/png").unwrap().0
        };
        peer.send_msg(
            cfg,
            PEER_ONE,
            &cfg.device_id,
            &Msg::BlobPull { image_id: img.clone(), transfer: transfer.into() },
        )
        .await;
        let ev = r.lan_rx.recv().await.expect("拉流帧上抬");
        offline_face(r).lan_event(ev).await.unwrap();
        (img, bytes)
    }

    /// 263 真机 bug 的防回归锚(lan-direct-plan §10「blob 供流 transport 分段驱动(不整图
    /// 物化)」= C′):**比每链 8 MiB 队列上界还大的图,必须能整张走完直连**。
    ///
    /// 改动前:`on_blob_pull` 整图物化 + 一次性吐 N 枚 256 KiB 块,协调者逐枚入队,第 33
    /// 枚就撞 [`LAN_LINK_QUEUE_BYTES`] → 断链;而队满断链**不设 blob penalty**,链一重建
    /// 仍 LAN 优先 → 重拨重死循环。真机把阈值夹到一个块以内(7.83 MiB 过 / 8.16 MiB 挂)。
    ///
    /// 夹具刻意用**真字节数**跨过那道上界(9 MiB > 8 MiB),不拿常量算术糊弄——「最大合法
    /// 单笔负载 vs 承载它的队列上界」这类比对就得真比一次(§10 本轮新立的纪律)。
    #[tokio::test]
    async fn an_image_bigger_than_the_link_queue_still_streams_whole() {
        let mut r = deck_rig("lan-serve-oversize");
        let cfg = deck_cfg(&r.db);
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
        peer.next_msg(&cfg, 1000).await.expect("建链的定向 Hello");

        const SIZE: usize = 9 * 1024 * 1024;
        assert!(SIZE > LAN_LINK_QUEUE_BYTES, "夹具必须真的越过每链字节上界");
        let (img, bytes) =
            pull_a_fresh_image(&mut r, &mut peer, &cfg, SIZE, "01TRANSFER0000000000000BG7").await;

        let mut got: Vec<u8> = vec![];
        let mut frames = 0usize;
        loop {
            match peer.next_msg(&cfg, 5000).await {
                Some((_, _, Msg::BlobChunk { image_id, idx, last, data, .. })) => {
                    assert_eq!(image_id, img);
                    assert_eq!(idx as usize, frames, "块序号必须从 0 连续");
                    frames += 1;
                    got.extend_from_slice(&data);
                    if last {
                        break;
                    }
                }
                other => panic!("只该收到块,实见 {other:?}"),
            }
        }
        assert_eq!(got.len(), SIZE, "字节数对不上");
        assert_eq!(got, bytes, "字节逐位相等");
        assert_eq!(r.slot.lan.count(), 1, "链路必须还活着(改动前这里已经断了)");
        assert_eq!(
            r.slot.lan.links[PEER_ONE].queued.load(AtomicOrdering::SeqCst),
            0,
            "供流的字节从不进发送队列(它正是绕开 8 MiB 上界的那一手)"
        );
    }

    /// C′ 第 4 条:供流中途行被删 → **沿同 transfer 回一枚 `BlobDeny`**,让收端立刻回清单
    /// 另寻来源,而不是干等 60s stale。
    ///
    /// 「中途」这两个字由 [`arm_serve_barrier`] 钉死:写泵写完第 0 块就停,删行必然落在
    /// 整图发完之前。首版靠「loopback 缓冲装不下整图」赌,本机实测吞得下 2 MiB——那种
    /// 夹具在别的机器上就是机器相关的假绿/假红(264 实现审 L2)。
    #[tokio::test]
    async fn serving_denies_when_the_row_vanishes_midway() {
        let mut r = deck_rig("lan-serve-vanish");
        let cfg = deck_cfg(&r.db);
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
        peer.next_msg(&cfg, 1000).await.expect("建链的定向 Hello");

        const SIZE: usize = 3 * 256 * 1024; // 3 块
        let (reached, release) = arm_serve_barrier(0);
        let (img, _) =
            pull_a_fresh_image(&mut r, &mut peer, &cfg, SIZE, "01TRANSFER0000000000000VN5").await;
        timeout(Duration::from_secs(3), reached.notified()).await.expect("写泵停在第 0 块之后");
        {
            let mut conn = r.db.lock().unwrap();
            let mut clk = r.clock.lock().unwrap();
            images::remove(&mut conn, &mut clk, &img).unwrap();
        }
        release.notify_one();

        match peer.next_msg(&cfg, 2000).await {
            Some((_, _, Msg::BlobChunk { idx: 0, last: false, .. })) => {}
            other => panic!("先该收到第 0 块,实见 {other:?}"),
        }
        match peer.next_msg(&cfg, 2000).await {
            Some((_, _, Msg::BlobDeny { image_id, transfer })) => {
                assert_eq!(image_id, img);
                assert_eq!(transfer, "01TRANSFER0000000000000VN5", "deny 必须回显同一 transfer");
            }
            other => panic!("行没了,第 0 块之后紧接着就该是 deny,实见 {other:?}"),
        }
        assert_eq!(r.slot.lan.count(), 1, "这不是链路的错,不许断链");
    }

    /// §6 ⑤ 那条纪律的**第六条出口**:C′ 之后块由写泵自己封,而 `k_acc` 是建链那一刻的
    /// 快照——一张大图要写好几秒,纪元压实恰在其间完成的话,后续每一块都是拿旧身份封的
    /// 帧。压实是库自己悄悄换的、**没人 poke 控制通道**,故写泵必须逐块真读库自证。
    ///
    /// 阳性一半(身份没变时整图照发)由
    /// [`an_image_bigger_than_the_link_queue_still_streams_whole`] 守着,这只管阴性一半。
    #[tokio::test]
    async fn a_recast_identity_stops_the_serve_pump_midstream() {
        let mut r = deck_rig("lan-serve-recast");
        let cfg = deck_cfg(&r.db);
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
        peer.next_msg(&cfg, 1000).await.expect("建链的定向 Hello");

        const CHUNKS: usize = 3;
        let (reached, release) = arm_serve_barrier(0);
        let (_img, _) = pull_a_fresh_image(
            &mut r,
            &mut peer,
            &cfg,
            CHUNKS * 256 * 1024,
            "01TRANSFER0000000000000RC4",
        )
        .await;
        timeout(Duration::from_secs(3), reached.notified()).await.expect("写泵停在第 0 块之后");
        // 换 K_acc,**不**碰控制通道。
        {
            let conn = r.db.lock().unwrap();
            meta_put(&conn, "k_acc", &hex(&[9u8; 32])).unwrap();
        }
        release.notify_one();

        // 只该再收到已经写出的那第 0 块,然后就是 EOF——第 1 块必须被自证挡下。
        assert!(matches!(peer.next(3000).await, Some(lan::LanWire::Frame { .. })), "第 0 块");
        assert!(
            matches!(peer.next(3000).await, None),
            "换代之后不许再拿旧身份封一块出来"
        );
        assert!(peer.closed(2000).await, "自证失败 = 断链(socket 真关,不是「碰巧没帧」)");
    }

    /// C′ 第 3 条:**控制帧在块边界插队**。一张图在链上要写好几秒,Ping / Hello / ops 不该
    /// 跟在它后面排队几十秒。
    ///
    /// 改动前两者共用一根 FIFO,Ping 必然排在整图**之后**;现在写泵每写完一块就先看控制
    /// 队列,故它至多晚一块。
    ///
    /// 心跳刻意**等写完第 0 块之后**才发([`arm_serve_barrier`] 把这一刻钉死):紧跟着
    /// pull 发的话,写泵一次都还没跑过,Ping 与供流是同时到它手上的——那只验出了「控制
    /// 队列排在供流前面」,验不出「插队」。栅栏还让线上顺序**完全确定**:块0 → Ping →
    /// 块1 → 块2,故断言可以钉「紧接着的下一枚就是 Ping」,而不是弱化成「在末块之前」。
    #[tokio::test]
    async fn control_frames_cut_in_at_chunk_boundaries() {
        let mut r = deck_rig("lan-serve-interleave");
        let cfg = deck_cfg(&r.db);
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
        peer.next_msg(&cfg, 1000).await.expect("建链的定向 Hello");

        const CHUNKS: usize = 3;
        let (reached, release) = arm_serve_barrier(0);
        let (_img, _) = pull_a_fresh_image(
            &mut r,
            &mut peer,
            &cfg,
            CHUNKS * 256 * 1024,
            "01TRANSFER0000000000000CT9",
        )
        .await;
        timeout(Duration::from_secs(3), reached.notified()).await.expect("写泵停在第 0 块之后");
        // 写泵此刻正停在块边界上。心跳这一刻插进来:
        offline_face(&mut r).lan_beat().await.unwrap();
        release.notify_one();

        assert!(matches!(peer.next(3000).await, Some(lan::LanWire::Frame { .. })), "块 0");
        assert!(
            matches!(peer.next(3000).await, Some(lan::LanWire::Ping {})),
            "块边界上排在最前的必须是控制帧(插队没生效 = Ping 排到整图后面去了)"
        );
        // 另一半:整图照样发完(不然「供流被控制帧饿死」也能让上面那条成立)。
        for i in 1..CHUNKS {
            assert!(
                matches!(peer.next(3000).await, Some(lan::LanWire::Frame { .. })),
                "插队之后供流要接着走完:块 {i}"
            );
        }
    }

    // ---- op 追赶供流的 LAN 那条腿(§6.1;L-d″ 第②笔) --------------------------------
    //
    // 整族用例都**自己往引擎槽里注入 work**:第⑤笔起 `on_hello`/`on_want`/`outbound`
    // 真在生产路径上登记义务了,但要在**一个确定的段上**验这条腿的消费行为,仍得绕开
    // 三个入口各自的冷却与水位派生,直接把段摆进计划表。

    /// 建一条链并把建链那枚定向 Hello 收掉,返回可用的假对端。
    async fn ops_rig(tag: &str) -> (DeckRig, SyncConfig, FakeLink) {
        let mut r = deck_rig(tag);
        let cfg = deck_cfg(&r.db);
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
        peer.next_msg(&cfg, 1000).await.expect("建链的定向 Hello");
        (r, cfg, peer)
    }

    /// 塞 n 枚**各自撑满切帧字节尺**的本机 op(正文 190 KiB > `MAX_OPS_FRAME_BYTES` 的一半,
    /// 故切帧必然一枚一帧)。「一回合至多一帧」这条要可观测,帧边界就得由数据自己划出来
    /// ——拿一堆小 op 去验,一帧全装下了,窗口 1 和「取满 500 条」两条路终局同形。
    fn seed_big_local_ops(r: &DeckRig, n: usize) -> String {
        let body = "T".repeat(190 * 1024);
        for _ in 0..n {
            let mut conn = r.db.lock().unwrap();
            let mut clk = r.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, &body).unwrap();
        }
        let conn = r.db.lock().unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |x| x.get(0)).unwrap();
        assert_eq!(rows as usize, n, "一次 capture 恰一枚 op —— 下面的帧数断言全靠这条");
        conn.query_row("SELECT origin FROM oplog LIMIT 1", [], |x| x.get(0)).unwrap()
    }

    /// 给这条链的 ops 腿派一段补洞工作并摇铃(生产上由收 Want 的那一处做,这里直投)。
    fn inject_ops_want(r: &mut DeckRig, target: &str, origin: &str, from_seq: i64) {
        let admitted = r.slot.ops.lock().unwrap().on_want(target, origin, from_seq, 0);
        assert_eq!(admitted.admit, ops_serve::Admit::Ok, "夹具的 target/origin 得先过形态闸");
        r.slot.lan.links[target].ops_wake.notify_one();
    }

    /// 在飞位武装着没有 —— **凭据回没回来的唯一可观测处**(写泵那边已经随 `Drop` 走了)。
    fn ops_inflight(r: &DeckRig, target: &str) -> bool {
        r.slot.ops.lock().unwrap().work_mut(target).is_some_and(|w| w.inflight_armed())
    }

    /// **§6.2 ④′「活性论证」那两条,一格一格断**(⑤ 的开工闸点名要的那只行为测)。
    ///
    /// ① **持票者中途死亡,凭据必须由 `Drop` 交回**:写泵被 abort / 链断 / panic 展开都
    ///    没人来得及调一句 `rollback`。少了它,在飞位永久占着 —— 该 target 的 ops 供给
    ///    不是变慢,是**死**。
    /// ② **每一次 occupied→free 都摇铃,且铃留存量**:摇的那一刻协调者多半正忙,
    ///    `notify_waiters()` 会把那一声丢掉,于是位子空了也没人来领。存量那半单独断一格
    ///    ——「摇的时候没人在等」正是常态,不是边角。
    ///
    /// 判据刻意取**外部可观测的四件**,不去读内部字段:窗口占着时第二个消费者只拿得到
    /// `Occupied`(窗口真的是 1)/ 释放之前铃是哑的(不许谎报 release)/ 持票者一死铃就响
    /// 且**没人在等也留着**/ 下一个来取的人拿到的是**同一段**(游标一步没进)。
    ///
    /// ⚠ **target 刻意挑一台没有链路的**:`ops_rig` 那条链自带一只写泵,它是这个对端的
    /// 真消费者 —— 拿 `PEER_ONE` 当靶子的话,「谁先取到这一帧」变成本测与那只泵的竞速
    /// (首版就这么写的,单跑绿、全套并行下红)。本测要断的是**凭据的所有权**,与哪条腿
    /// 无关;路由那一格另有专测。
    #[tokio::test]
    async fn a_dead_ticket_holder_returns_the_window_and_rings_for_the_next_consumer() {
        const LONER: &str = "01TGT0AAAAAAAAAAAAAAAAAAAA";
        let (mut r, _cfg, _peer) = ops_rig("lan-ops-holder-dies").await;
        let origin = seed_big_local_ops(&r, 2);
        assert_eq!(
            r.slot.ops.lock().unwrap().on_want(LONER, &origin, 1, 0).admit,
            ops_serve::Admit::Ok
        );
        let ctx = offline_face(&mut r).serve_ctx();
        // 建链那一下本身就该摇一次(§6.2 ④′「新消费者出现时也要唤醒」)。先把这枚存量
        // 收掉,否则下面「释放之前铃是哑的」验的是它、不是本测造的那次释放。
        assert!(
            timeout(Duration::from_millis(200), ctx.ops_changed.notified()).await.is_ok(),
            "接进一条新链 = 新消费者出现,该摇一次"
        );

        // 冒充「某条腿刚取到帧」——走的是生产的唯一发票口 [`ops_prepare`]。
        let OpsTurn::Frame(frame, ticket) = ops_prepare(&ctx, LONER) else {
            panic!("该取得出一枚帧")
        };
        let held =
            (frame.origin.clone(), frame.ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>());
        assert!(ops_inflight(&r, LONER), "取到帧 = 在飞位武装着");
        assert!(matches!(ops_prepare(&ctx, LONER), OpsTurn::Occupied), "窗口是 1(结构事实)");
        assert!(
            timeout(Duration::from_millis(100), ctx.ops_changed.notified()).await.is_err(),
            "还没释放就摇铃 = 谎报 release"
        );

        drop(ticket); // ← 持票者中途死亡(写泵被 abort / 链断 / panic 展开,一律走这条)
        assert!(!ops_inflight(&r, LONER), "凭据必须由 Drop 交回(不是「记得调一句」)");
        assert!(
            timeout(Duration::from_millis(200), ctx.ops_changed.notified()).await.is_ok(),
            "占→空必摇铃,且没人等的时候摇的那一声也得留着"
        );

        // 下一个来取的人:拿到的必须还是**同一段**。
        let OpsTurn::Frame(again, _t2) = ops_prepare(&ctx, LONER) else {
            panic!("交回之后必须重新取得出")
        };
        assert_eq!(
            (again.origin.clone(), again.ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>()),
            held,
            "游标一步都不许进"
        );
    }

    /// 一条**中转在场**的投递面(仅测试)。`RelayLeg::Up` 要一条真 `Ws`,而
    /// [`fake_relay`] 那台服务器正好给得出;握手刻意不走完 —— 用它的那只用例全程空转、
    /// 一个字节都不往 socket 上写,要的只是「这条腿在场」这个事实。
    async fn raw_relay_leg(relay: &FakeRelay) -> (Ws, RelaySession) {
        let (ws, _) = connect_async(relay.url()).await.expect("连上假中转");
        (ws, RelaySession { n: 0, tracked: HashMap::new(), ad: AdFace::new(false) })
    }

    fn relay_face<'a>(r: &'a mut DeckRig, ws: &'a mut Ws, sess: &'a mut RelaySession) -> Deck<'a> {
        Deck {
            db: &r.db,
            clock: &r.clock,
            status: &r.status,
            events: &r.ev_tx,
            cfg: &r.cfg,
            slot: &mut r.slot,
            relay: RelayLeg::Up { ws, sess },
        }
    }

    /// **一趟 sweep 只花一个 K 的额度**(codex 实现审二轮 M 的行为面)。
    ///
    /// 三轮 L2 纠了我上一版那句过强的话:我写「除非新增一个只为测试存在的 sweep 边界标记,
    /// 否则没有行为观测面」—— 而 `ops_changed_tick()` 这个方法的**返回**本身就是边界,
    /// 缺的只是一条中转在场的投递面夹具([`raw_relay_leg`]),不需要动生产代码一个字节。
    ///
    /// 造法同 [`only_the_fairness_checkpoint_exit_leaves_a_permit_behind`]:K+1 个 target
    /// 各塞一段**指向没有任何行的 origin** 的补洞 work,每个恰好消耗一个「空转」回合。
    /// 一趟 sweep 之后:
    /// * 现在这一形(全局泵整趟一次)→ 恰好 K 个被花掉,**剩 1 个**还挂着,等那枚 permit
    ///   把协调者叫回来;
    /// * 旧形(逐 target 各泵一次)→ K+1 个在**同一次调用里**全被花掉,K 那条「跑 8 次就
    ///   交回协调者」的公平检查点形同虚设。
    ///
    /// 判据取「还剩几个 runnable」而不是 `probes()`:探针数会把别处的摸库一起算进来。
    #[tokio::test]
    async fn one_sweep_spends_a_single_k_budget() {
        // 没有任何 oplog 行的 origin(形态合规即可:取数取不到行 → 空转)。
        const EMPTY: &str = "01NRWSAAAAAAAAAAAAAAAAAAAA";
        let mut r = deck_rig("lan-ops-sweep-k");
        let relay = fake_relay().await;
        let (mut ws, mut sess) = raw_relay_leg(&relay).await;
        let n = OPS_TURNS_PER_CHECKPOINT + 1;
        for i in 0..n {
            let t = format!("01TGT{i}AAAAAAAAAAAAAAAAAAAA");
            assert_eq!(
                lock_ops(&r.slot.ops).on_want(&t, EMPTY, 1, 0).admit,
                ops_serve::Admit::Ok,
                "夹具塞的 work 得先过形态闸"
            );
        }
        assert_eq!(lock_ops(&r.slot.ops).idle_runnable_targets().len(), n, "起手 K+1 个都有活");

        relay_face(&mut r, &mut ws, &mut sess).ops_changed_tick().await.unwrap();

        assert_eq!(
            lock_ops(&r.slot.ops).idle_runnable_targets().len(),
            1,
            "一趟 sweep 只许花一个 K 的额度(K={OPS_TURNS_PER_CHECKPOINT});剩 0 = 逐 target 各泵了一次"
        );
        relay.task.abort();
    }

    /// **K 到限那条出口要自留一枚续做 permit,而「活干完了」那条出口不许摇**
    /// (§6.2 ④′「三件」之二)。
    ///
    /// 少了 permit:连吃 K 个回合没出帧就回协调者睡下,再没有人来推它 —— 续做只能等 30s
    /// 心跳(第④笔时代的兜底),正是「靠一个信号触发,而信号可能不来」的同族。
    /// 摇多了也不行:活干完了还摇,协调者被叫醒去扫一张空名单,白跑一趟。
    ///
    /// 造法:给 N 个 target 各塞一段**指向没有任何行的 origin** 的补洞 work —— 取数取不到
    /// 东西,每个 target 恰好消耗一个「空转」回合。N < K 走 `NoWork` 那条出口,N ≥ K 走 K
    /// 那条。**两条出口线上都一个字节不出、返回值也一模一样,只有铃分得开**。
    #[tokio::test]
    async fn only_the_fairness_checkpoint_exit_leaves_a_permit_behind() {
        // 没有任何 oplog 行的 origin(形态合规即可:取数取不到行 → 空转)。
        const EMPTY: &str = "01NRWSAAAAAAAAAAAAAAAAAAAA";
        for (targets, want_permit) in
            [(OPS_TURNS_PER_CHECKPOINT - 1, false), (OPS_TURNS_PER_CHECKPOINT + 1, true)]
        {
            let (mut r, _cfg, _peer) = ops_rig(&format!("lan-ops-k-{targets}")).await;
            let ctx = offline_face(&mut r).serve_ctx();
            // 建链那一下摇过一次(「新消费者出现」):先吃掉,否则验的是它。
            assert!(
                timeout(Duration::from_millis(200), ctx.ops_changed.notified()).await.is_ok(),
                "接进一条新链该摇一次"
            );
            for i in 0..targets {
                let t = format!("01TGT{i}AAAAAAAAAAAAAAAAAAAA");
                assert_eq!(
                    r.slot.ops.lock().unwrap().on_want(&t, EMPTY, 1, 0).admit,
                    ops_serve::Admit::Ok,
                    "夹具塞的 work 得先过形态闸"
                );
            }
            let mut back = vec![];
            let turn = offline_face(&mut r).pump_ops(&mut back).await.unwrap();
            assert!(matches!(turn, PumpTurn::NoWork), "全是空转,一帧都不该出");
            assert!(back.is_empty(), "空转不产补投帧");
            let rang = timeout(Duration::from_millis(150), ctx.ops_changed.notified()).await.is_ok();
            assert_eq!(
                rang, want_permit,
                "{targets} 个 target(K={OPS_TURNS_PER_CHECKPOINT})时的续做 permit"
            );
        }
    }

    /// **读库失败的那一拍,让位照样收回**(送三轮前自审那一遍抓到的;268 那条「已提交的
    /// 义务不许随 `?` 蒸发」的同族)。
    ///
    /// 让位那一格上一版落在 `OpsWorks::on_tick` 的循环里,而它前面隔着 `Engine::ops_tick`
    /// 里 `outbound` 的 `?` —— `watermark` 那句 `SELECT` 撞上 `SQLITE_BUSY`(另一个写者
    /// 压着锁)就整拍早返回,让位于是跨过好几拍;而「让位至多一拍」正是「没有直连腿时不比
    /// 原来慢」的全部依据。
    ///
    /// 造可控失败点走 rusqlite 的 authorizer(memory `test-negative-control`:说造不出
    /// 行为测之前先把手上的工装过一遍),拒掉对 `oplog` 的读 —— 真实成因不是「表没了」而是
    /// 锁竞争,但两者在 `watermark` 的返回值上同形,而本测断的是**返回 `Err` 那一拍的义务
    /// 归属**,与错因无关。
    #[tokio::test]
    async fn the_yield_is_still_reclaimed_on_a_tick_that_fails_to_read_the_db() {
        let mut r = deck_rig("lan-ops-yield-dberr");
        // 先有条目才让得了位(`yield_relay` 对不在表里的 target 是 no-op:那份 work 已随
        // 撤位/驱逐没了,没有可让的位子)。
        assert_eq!(
            lock_ops(&r.slot.ops).on_want(PEER_ONE, PEER_TWO, 1, 0).admit,
            ops_serve::Admit::Ok,
            "夹具塞的 work 得先过形态闸"
        );
        lock_ops(&r.slot.ops).yield_relay(PEER_ONE);
        assert!(lock_ops(&r.slot.ops).relay_yielding(PEER_ONE), "夹具先把让位摆上");

        // 拒掉对 `oplog` 的读:`outbound` 里那句 `SELECT MAX(origin_seq) FROM oplog` 起不来。
        r.db.lock().unwrap().authorizer(Some(|ctx: rusqlite::hooks::AuthContext<'_>| {
            match ctx.action {
                rusqlite::hooks::AuthAction::Read { table_name: "oplog", .. } => {
                    rusqlite::hooks::Authorization::Deny
                }
                _ => rusqlite::hooks::Authorization::Allow,
            }
        }));
        let err = offline_face(&mut r).ops_tick().await.expect_err("读不了 oplog 就该响亮");
        // 关掉授权器,免得后面的清理路径也跟着被拒。
        r.db.lock().unwrap().authorizer(None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>);

        assert!(err.contains("prohibited"), "错因得是「读 oplog 被拒」而不是别的:{err}");
        assert!(
            !lock_ops(&r.slot.ops).relay_yielding(PEER_ONE),
            "这一拍整个失败了,但收回让位这件事不许跟着 `?` 一起蒸发"
        );
    }

    /// 阳性一半:一回合一帧、按 `origin_seq` 升序、供完即止,**且游标真的推进了**
    /// (不推进的话第二回合还是第 1 枚,收到的三帧就会是 1/1/1)。
    #[tokio::test]
    async fn the_ops_leg_serves_one_frame_per_turn_until_the_gap_is_closed() {
        let (mut r, cfg, mut peer) = ops_rig("lan-ops-serve").await;
        let origin = seed_big_local_ops(&r, 3);
        inject_ops_want(&mut r, PEER_ONE, &origin, 1);

        let mut seqs: Vec<i64> = vec![];
        for i in 0..3 {
            match peer.next_msg(&cfg, 3000).await {
                Some((_, to, Msg::Ops { origin: o, ops })) => {
                    assert_eq!(to, PEER_ONE, "定向供流的收件人是这条链的对端");
                    assert_eq!(o, origin);
                    assert_eq!(ops.len(), 1, "190 KiB 一枚 → 字节尺把它们切成一帧一枚");
                    seqs.extend(ops.iter().map(|op| op.origin_seq));
                }
                other => panic!("第 {i} 帧只该是 ops,实见 {other:?}"),
            }
        }
        assert_eq!(seqs, vec![1, 2, 3], "三帧按 origin_seq 升序,游标每回合真推进一格");
        assert!(peer.next_msg(&cfg, 300).await.is_none(), "供完即止,不重发");
        assert!(!ops_inflight(&r, PEER_ONE), "供完之后在飞位是空的");
        assert_eq!(r.slot.lan.count(), 1, "链路照活");
    }

    /// §6.1「**凭据必须回得来**」(第①笔实现审三轮 ③;我原先判错的那条)。
    ///
    /// 链死时逻辑 work **仍住在引擎槽里**——凭据要是随写任务一起裸丢,在飞位就永久占着,
    /// 此后每次 `prepare_next` 都报「上一笔还在飞」= 该对端的 ops 供给彻底停摆。栅栏把
    /// 「已武装、未落地」这一刻钉死:那是这条契约唯一可证伪的时刻。
    #[tokio::test]
    async fn a_dying_link_hands_the_ops_credential_back_instead_of_stranding_it() {
        let (mut r, _cfg, _peer) = ops_rig("lan-ops-credential").await;
        let origin = seed_big_local_ops(&r, 2);
        let (reached, _release) = arm_ops_barrier();
        inject_ops_want(&mut r, PEER_ONE, &origin, 1);
        timeout(Duration::from_secs(3), reached.notified())
            .await
            .expect("写泵停在「已封好、还没写出去」");
        assert!(ops_inflight(&r, PEER_ONE), "此刻必须武装着,否则下面那条断言无从证伪");

        let generation = r.slot.lan.links[PEER_ONE].generation;
        assert!(r.slot.lan.close(PEER_ONE, generation), "摘链 = 写任务被 abort");
        for _ in 0..200 {
            if !ops_inflight(&r, PEER_ONE) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!ops_inflight(&r, PEER_ONE), "链死之后凭据必须交回,否则供给永久停摆");

        // 另一半:回滚**一步也不推进**,故下一条链接着从同一段供(锁序恒 db → work)。
        let conn = r.db.lock().unwrap();
        let mut works = r.slot.ops.lock().unwrap();
        let work = works.work_mut(PEER_ONE).expect("逻辑 work 住引擎槽,不随链路死");
        let again = work.prepare_next(&conn).expect("窗口是空的").ready().expect("同一段还在");
        assert_eq!(
            again.frame.expect("有帧").ops[0].origin_seq,
            1,
            "回滚只释放在飞位、不推进游标:重取拿到的还是第 1 枚"
        );
    }

    /// 凭据的另一半、也是更难的那一半(实现审 M2):**阻塞闭包已经造出凭据,而等待方在拿到
    /// 它之前就被 abort**。此时产出由 tokio 丢弃(已启动的 `spawn_blocking` 停不下来),
    /// `OpsTicket::drop` 是唯一的回滚出路 —— 凭据要是构造在 `await` 之后,这一路就压根没有
    /// 凭据存在,在飞位从此永久占着。
    ///
    /// 上一只(`a_dying_link_...`)的栅栏停在产出**已经交回写泵**之后,证不了这一形。
    #[tokio::test]
    async fn a_credential_born_in_the_blocking_task_survives_losing_its_waiter() {
        let (mut r, _cfg, _peer) = ops_rig("lan-ops-orphan").await;
        let origin = seed_big_local_ops(&r, 2);
        // 先等建链那一次「空表探一眼」跑完,否则栅栏会被它领走(它一枚凭据都不造)。
        for _ in 0..200 {
            if r.slot.ops.lock().unwrap().probes() >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let (reached, release) = arm_ops_handoff_barrier();
        inject_ops_want(&mut r, PEER_ONE, &origin, 1);
        // 闭包停在「两把锁已放掉、产出还没交回」那一刻。**轮询式等**:`#[tokio::test]` 是
        // 单线程 runtime,拿阻塞的 `recv_timeout` 等会把 runtime 一起冻住,写泵连
        // `spawn_blocking` 都走不到(首版就这么超时的)。
        let mut stopped = false;
        for _ in 0..600 {
            if reached.try_recv().is_ok() {
                stopped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(stopped, "闭包该停在移交前");
        assert!(ops_inflight(&r, PEER_ONE), "凭据已经造出来了(否则下面无从证伪)");

        // 先摘链,再让闭包返回:等待方此刻已经不在,产出只能被 tokio 丢掉。
        let generation = r.slot.lan.links[PEER_ONE].generation;
        assert!(r.slot.lan.close(PEER_ONE, generation), "摘链");
        tokio::task::yield_now().await;
        release.send(()).expect("放行");

        for _ in 0..200 {
            if !ops_inflight(&r, PEER_ONE) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!ops_inflight(&r, PEER_ONE), "没人来领的凭据也必须把在飞位交回去");
    }

    /// §6 ⑤ 那条纪律的**第七条出口**:ops 帧由写泵自己封,而 `k_acc` 是建链那一刻的快照
    /// ——一段长追赶跨过纪元压实之后,后面每一帧都是拿旧身份封的。压实是库自己悄悄换的、
    /// **没人 poke 控制通道**,故写泵必须逐帧真读库自证。
    ///
    /// 阳性一半(身份没变时整段照发)由
    /// [`the_ops_leg_serves_one_frame_per_turn_until_the_gap_is_closed`] 守着。
    #[tokio::test]
    async fn a_recast_identity_stops_the_ops_pump_between_frames() {
        let (mut r, _cfg, mut peer) = ops_rig("lan-ops-recast").await;
        let origin = seed_big_local_ops(&r, 2);
        let (reached, release) = arm_ops_barrier();
        inject_ops_want(&mut r, PEER_ONE, &origin, 1);
        timeout(Duration::from_secs(3), reached.notified()).await.expect("停在第一帧写出之前");
        // 换 K_acc,**不**碰控制通道。
        {
            let conn = r.db.lock().unwrap();
            meta_put(&conn, "k_acc", &hex(&[9u8; 32])).unwrap();
        }
        release.notify_one();

        assert!(
            matches!(peer.next(3000).await, Some(lan::LanWire::Frame { .. })),
            "第一帧照发:它在换代之前就封好了"
        );
        assert!(peer.next(3000).await.is_none(), "换代之后不许再拿旧身份封一帧出来");
        assert!(peer.closed(2000).await, "自证失败 = 断链(socket 真关,不是碰巧没帧)");
    }

    /// 两条数据腿**按回合 1:1**,且新供流描述符不许排在整段 ops 追赶之后。
    ///
    /// 后半条是第②笔补的一手:blob 原先只从 select 里取描述符,而加了第二条数据腿之后,
    /// ops 一旦持续有活就永远走不到 select——一张刚被拉的图要等对端追完几百帧才动一下。
    #[tokio::test]
    async fn ops_and_blob_take_turns_and_a_new_image_is_not_queued_behind_the_catch_up() {
        let (mut r, cfg, mut peer) = ops_rig("lan-ops-turns").await;
        let origin = seed_big_local_ops(&r, 6);
        inject_ops_want(&mut r, PEER_ONE, &origin, 1);
        // 先等一枚 ops 帧出门:这样「描述符是在 ops 腿正忙时到的」是确定的事实,不是赌。
        match peer.next_msg(&cfg, 3000).await {
            Some((_, _, Msg::Ops { .. })) => {}
            other => panic!("先该出 ops 帧,实见 {other:?}"),
        }
        const CHUNKS: usize = 3;
        pull_a_fresh_image(&mut r, &mut peer, &cfg, CHUNKS * 256 * 1024, "01TRANSFER0000000000000TN3")
            .await;

        // 收到第 3 块为止:这段窗口里两条腿**都还有活**,故交替与否在这里可判。
        let mut kinds: Vec<char> = vec![];
        let mut chunks = 0usize;
        while chunks < CHUNKS {
            match peer.next_msg(&cfg, 5000).await {
                Some((_, _, Msg::BlobChunk { .. })) => {
                    chunks += 1;
                    kinds.push('C');
                }
                Some((_, _, Msg::Ops { .. })) => kinds.push('O'),
                other => panic!("这条链上只该有 ops 帧与块,实见 {other:?}"),
            }
            assert!(kinds.len() <= 12, "十二帧还凑不齐三块 = 有一条腿被饿死了:{kinds:?}");
        }
        let first_chunk = kinds.iter().position(|k| *k == 'C').expect("上面的循环保证有块");
        // 阈值给到 3:`pull_a_fresh_image` 自己要写库、要跑一轮协调者,那期间写泵照转,
        // 故「描述符什么时候真正落进通道」有一两个回合的浮动。而描述符**只能从 select 取**
        // 的那个形(② 段不 try_recv)下,剩余 5 枚大 op + 图那两枚小 op 全发完才轮得到块
        // ——第一块会落在第 6 位往后,故这条闸仍然分得开两条路。
        assert!(first_chunk <= 3, "新图不许排在整段 ops 追赶之后(实见 {kinds:?})");
        let ops_between = kinds[first_chunk..].iter().filter(|k| **k == 'O').count();
        assert!(ops_between >= 2, "块与块之间必须让出 ops 的回合(实见 {kinds:?})");
    }

    /// 空转(该 origin 对端已齐)**照样要提交**:游标不往前走的话,在飞位一直武装着,
    /// 下一枚真缺口就再也取不出来了(`prepare_next` 会响亮报「上一笔还在飞」)。
    #[tokio::test]
    async fn an_idle_turn_commits_and_leaves_the_window_free() {
        let (mut r, cfg, mut peer) = ops_rig("lan-ops-idle").await;
        let origin = seed_big_local_ops(&r, 2);
        let snapshot: i64 = {
            let conn = r.db.lock().unwrap();
            conn.query_row("SELECT MAX(rowid) FROM oplog", [], |x| x.get(0)).unwrap()
        };
        // 对端水位说它已经齐了 → 计划扫一圈,一个字节都不该发。
        let vetted =
            ops_serve::vet_watermarks(std::collections::BTreeMap::from([(origin.clone(), 2)]))
                .expect("形态");
        assert_eq!(
            r.slot.ops.lock().unwrap().on_hello(PEER_ONE, vetted, snapshot, 0).admit,
            ops_serve::Admit::Ok
        );
        r.slot.lan.links[PEER_ONE].ops_wake.notify_one();
        assert!(peer.next_msg(&cfg, 500).await.is_none(), "对端已齐:一帧都不该发");

        inject_ops_want(&mut r, PEER_ONE, &origin, 1);
        match peer.next_msg(&cfg, 3000).await {
            Some((_, _, Msg::Ops { ops, .. })) => assert_eq!(ops[0].origin_seq, 1),
            other => panic!("空转提交过了,窗口该是空的,实见 {other:?}"),
        }
        assert!(r.status.lock().unwrap().lan_warning.is_none(), "这条路不该报任何 advisory");
    }

    /// 塞一枚**本机 `capture` 造不出**的超大远端 op(正文封顶 200 KiB)。它的真实来路是
    /// 帧上限更宽的对端(§10 六轮 M4:单条超大 op 独占一帧时可接近 1 MiB),故按 oplog 的
    /// 形直接落。`device` 决定 origin,`seq` 是该 origin 的发射序号。
    fn seed_oversized_remote_op(r: &DeckRig, device: &str, seq: i64) {
        let conn = r.db.lock().unwrap();
        let hlc = crate::clock::Hlc {
            wall_ms: 1_000 + seq as u64,
            counter: 0,
            device_id: device.into(),
        }
        .encode();
        let payload = serde_json::json!({
            "content": "T".repeat(lan::LAN_FRAME_MAX + 64 * 1024),
            "created_at": "2026-08-01T00:00:00Z",
        });
        conn.execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, 'item', ?3, 'create', ?4, ?5)",
            (
                ulid::Ulid::new().to_string(),
                hlc,
                format!("01ITEMBIG{seq:017}"),
                serde_json::to_string(&payload).unwrap(),
                seq,
            ),
        )
        .expect("塞一枚超大远端 op");
    }

    /// 一枚**越过 lan 线上上限**的 ops 帧:响亮 advisory,这一段跳过,**不自旋**。
    ///
    /// 回滚一步也不推进游标,故不记住卡在哪的话,下一回合取到的还是同一帧 —— 那就是死循环。
    #[tokio::test]
    async fn an_ops_frame_too_big_for_the_wire_is_skipped_instead_of_spun_on() {
        let (mut r, cfg, mut peer) = ops_rig("lan-ops-oversize").await;
        seed_oversized_remote_op(&r, PEER_TWO, 1);
        inject_ops_want(&mut r, PEER_ONE, PEER_TWO, 1);
        assert!(peer.next_msg(&cfg, 1000).await.is_none(), "封不出的帧当然发不出去");

        // **判据是发号器**:线上一个字节都不出这一格,「跳过」与「死自旋」完全同形——
        // 只有「还在不在反复武装同一段」分得开两条路。
        //
        // ⚠ **先等它真武装过一次再取基线**(292 收尾修的一处零余量假设):上面那 1000ms
        // 只证明「线上没出帧」,证不出写泵已经把这一声铃处理完 —— 满载并行下它可能一次都
        // 还没武装,基线取成 0,随后两次武装就成了「+2 = 死自旋」的假红。
        wait_until("写泵至少武装过一次", || {
            r.slot.ops.lock().unwrap().work_mut(PEER_ONE).is_some_and(|w| w.arms_issued() >= 1)
        })
        .await;
        let armed_before = r.slot.ops.lock().unwrap().work_mut(PEER_ONE).unwrap().arms_issued();
        r.slot.lan.links[PEER_ONE].ops_wake.notify_one();
        assert!(peer.next_msg(&cfg, 500).await.is_none(), "卡住的那一段不许反复重取");
        assert!(
            r.slot.ops.lock().unwrap().work_mut(PEER_ONE).unwrap().arms_issued() <= armed_before + 1,
            "至多再探一次确认段头没动;还在涨就是死自旋"
        );
        let warn = r.status.lock().unwrap().lan_warning.clone();
        assert!(
            warn.as_deref().is_some_and(|w| w.contains("本链跳过它")),
            "有界降级要响亮报一次,实见 {warn:?}"
        );
        assert_eq!(r.slot.lan.count(), 1, "这不是链路的错,不许断链");
        assert!(!ops_inflight(&r, PEER_ONE), "跳过那一路凭据照样交回");
    }

    /// **卡住的是那一段,不是这条链**(实现审 H1)。中转腿把过不去的那一段发出去并提交
    /// 之后,计划的头往前走,这条健康的直连链必须自动接着供 —— 原先那枚「本链 ops 腿永久
    /// 终局」的位会让它跟着陪葬,而中转随后一断,能走的路就一条都不剩了。
    ///
    /// 「中转腿供掉了那一段」由用例**直接在计划上提交一笔**来模拟(第④笔才有真 relay 腿)。
    #[tokio::test]
    async fn a_head_moved_by_the_other_leg_revives_the_stuck_lan_leg() {
        let (mut r, cfg, mut peer) = ops_rig("lan-ops-revive").await;
        seed_oversized_remote_op(&r, PEER_TWO, 1);
        {
            // 卡住那一枚**后面**跟一枚正常大小的 op:头一动它就该出门。
            let conn = r.db.lock().unwrap();
            let hlc =
                crate::clock::Hlc { wall_ms: 2_000, counter: 0, device_id: PEER_TWO.into() }
                    .encode();
            conn.execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'item', '01ITEMSMALL00000000000000', 'create', ?3, 2)",
                (
                    ulid::Ulid::new().to_string(),
                    hlc,
                    r#"{"content":"小的","created_at":"2026-08-01T00:00:00Z"}"#,
                ),
            )
            .expect("塞一枚正常 op");
        }
        inject_ops_want(&mut r, PEER_ONE, PEER_TWO, 1);
        assert!(peer.next_msg(&cfg, 1000).await.is_none(), "第一段封不出,卡住");

        // 模拟中转腿把卡住那一段供掉并提交(锁序恒 db → work)。
        {
            let conn = r.db.lock().unwrap();
            let mut works = r.slot.ops.lock().unwrap();
            let work = works.work_mut(PEER_ONE).expect("逻辑 work 还在");
            let p = work.prepare_next(&conn).expect("窗口空着").ready().expect("卡住那一段还在");
            assert_eq!(p.frame.expect("有帧").ops[0].origin_seq, 1, "拿到的正是卡住那一段");
            work.commit(p.token).expect("另一条腿发成了,推进游标");
        }
        r.slot.lan.links[PEER_ONE].ops_wake.notify_one();
        match peer.next_msg(&cfg, 3000).await {
            Some((_, _, Msg::Ops { ops, .. })) => {
                assert_eq!(ops[0].origin_seq, 2, "头动了,这条健康的链必须接着供下一段")
            }
            other => panic!("卡住的只该是那一段,不是这条链,实见 {other:?}"),
        }
    }

    /// 段头必须**连 origin 一起认**(实现审二轮 M2)。上一只用例里下一段是同 origin 的
    /// seq=2,故它只证得了 `seq` 参与;这一只把下一段换成**另一个 origin 的 seq=1** ——
    /// 段头要是只比 seq,它就会被误认成「还是卡住那一段」而永远发不出去。
    #[tokio::test]
    async fn the_stuck_head_is_keyed_by_origin_too_not_just_the_sequence() {
        let (r, cfg, mut peer) = ops_rig("lan-ops-head-origin").await;
        const OTHER: &str = "01PEER3AAAAAAAAAAAAAAAAAAA";
        seed_oversized_remote_op(&r, PEER_TWO, 1);
        {
            let conn = r.db.lock().unwrap();
            let hlc =
                crate::clock::Hlc { wall_ms: 3_000, counter: 0, device_id: OTHER.into() }.encode();
            conn.execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'item', '01ITEMOTHER00000000000000', 'create', ?3, 1)",
                (
                    ulid::Ulid::new().to_string(),
                    hlc,
                    r#"{"content":"另一台设备的第一枚","created_at":"2026-08-01T00:00:00Z"}"#,
                ),
            )
            .expect("塞一枚别的 origin 的 op");
        }
        // 两段都进快车道(第二枚给个过了冷却的刻度,否则它只会被登记进 deferred)。
        assert_eq!(
            r.slot.ops.lock().unwrap().on_want(PEER_ONE, PEER_TWO, 1, 0).admit,
            ops_serve::Admit::Ok
        );
        assert_eq!(
            r.slot.ops.lock().unwrap().on_want(PEER_ONE, OTHER, 1, 8).admit,
            ops_serve::Admit::Ok
        );
        r.slot.lan.links[PEER_ONE].ops_wake.notify_one();
        assert!(peer.next_msg(&cfg, 1000).await.is_none(), "队头那段封不出,卡住");

        // 模拟中转腿把卡住那一段供掉:队头换成**另一个 origin 的 seq=1**。
        // ⚠ **先等在飞位真交回**(292 收尾修的一处零余量假设):上面那 1000ms 只证明
        // 「线上没出帧」,满载并行下写泵可能还攥着那枚凭据,此刻 `prepare_next` 会回
        // `Occupied`、`ready()` 是 `None` —— 那是宿主调度,不是被测行为。
        wait_until("写泵把卡住那一段的凭据交回", || !ops_inflight(&r, PEER_ONE)).await;
        {
            let conn = r.db.lock().unwrap();
            let mut works = r.slot.ops.lock().unwrap();
            let work = works.work_mut(PEER_ONE).expect("逻辑 work 还在");
            let p = work.prepare_next(&conn).expect("窗口空着").ready().expect("卡住那一段还在");
            let f = p.frame.expect("有帧");
            assert_eq!((f.origin.as_str(), f.ops[0].origin_seq), (PEER_TWO, 1), "正是卡住那段");
            work.commit(p.token).expect("另一条腿发成了");
        }
        r.slot.lan.links[PEER_ONE].ops_wake.notify_one();
        match peer.next_msg(&cfg, 3000).await {
            Some((_, _, Msg::Ops { origin, ops })) => {
                assert_eq!((origin.as_str(), ops[0].origin_seq), (OTHER, 1), "换了 origin 就该发");
            }
            other => panic!("段头只比 seq 的话这一枚就发不出去,实见 {other:?}"),
        }
    }

    /// **没活就得真的停下**(实现审 M2 的另一半):不灭 armed 就是空计划表上的热循环——
    /// 线上字节、状态面、武装发号器三格全同形,只有「还在不在反复摸库」分得开。
    #[tokio::test]
    async fn an_empty_plan_table_puts_the_ops_leg_to_sleep_instead_of_spinning() {
        let (r, _cfg, _peer) = ops_rig("lan-ops-sleep").await;
        // 建链那一刻写泵会先探一眼(表是空的 → 没活 → 该睡)。给它 200ms 证明它真睡着了。
        tokio::time::sleep(Duration::from_millis(200)).await;
        let probes = r.slot.ops.lock().unwrap().probes();
        assert!(probes <= 2, "空表上最多探一两次就该睡下,实见 {probes} 次 = 热循环");
    }

    /// 取数真出错必须**响亮收场拆链**,不许伪装成「此刻没活」去等一枚未必再来的铃
    /// (实现审 H2)。故障点由 rusqlite 的授权器造:读 `oplog` 一律拒。
    #[tokio::test]
    async fn a_real_read_failure_tears_the_link_down_instead_of_waiting_for_a_bell() {
        let (mut r, _cfg, _peer) = ops_rig("lan-ops-readfail").await;
        let origin = seed_big_local_ops(&r, 1);
        {
            let conn = r.db.lock().unwrap();
            conn.authorizer(Some(|ctx: rusqlite::hooks::AuthContext<'_>| {
                match ctx.action {
                    rusqlite::hooks::AuthAction::Read { table_name: "oplog", .. } => {
                        rusqlite::hooks::Authorization::Deny
                    }
                    _ => rusqlite::hooks::Authorization::Allow,
                }
            }));
        }
        inject_ops_want(&mut r, PEER_ONE, &origin, 1);

        // 死讯走独立通道:协调者据此摘腿。等它到,就证明这条路不是「静默睡下」。
        let fault = timeout(Duration::from_secs(3), r._lan_faults.recv())
            .await
            .expect("取数失败必须响亮收场")
            .expect("死讯通道自持发送端");
        assert!(fault.why.contains("ops 供流取数失败"), "死因要点到 ops 取数,实见 {}", fault.why);
    }

    /// 连着摸库若干回合就得**真让出一次**(实现审两轮 M1)。
    ///
    /// **诚实边界:这条只有结构锚,没有行为测**。让出的效果落在「协调者 / UI 拿不拿得到
    /// 那把库锁」上,而那一格没有确定性判据(线上字节、`probes`、blob 交错三格与不让出
    /// 完全同形)。但被锚住的机制这次是**兑现得了判据**的:`yield_now` 有「必先回一次
    /// `Pending`」的契约,不像上一版那枚「灭 armed + 自己摇铃」——`Notified` 已 ready 时
    /// select 直接过,调度上什么也没发生(二轮 M1 点名的正是这一点)。
    ///
    /// 量级如实记着:一份计划的空转 ≤ 快照 origin 数 ÷ 64、每回合 ≤5 ms,故 2000 个 origin
    /// 的极端库也就一次约 160 ms 且受 60s 冷却管。上界留着是因为它把这段占用变成**由常量
    /// 定**而不是由数据规模定(263/264/266 同族的判法),不是因为它测得出来。
    #[test]
    fn the_ops_turn_burst_yields_on_a_constant_boundary() {
        let src = include_str!("transport.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        let at = prod.find("if ops_turns >= OPS_TURNS_PER_CHECKPOINT {").expect("写泵有回合上界");
        let arm = &prod[at..at + 160];
        assert!(arm.contains("yield_now"), "到限必须真让出(自己摇铃不算让出):\n{arm}");
        assert!(arm.contains("ops_turns = 0"), "让出之后要复位计数");
        // 出帧那一路也得计数:`write_all` 在 loopback / 大接收窗口下可以立即 Ready,拿它
        // 当背压证明在最坏情形下不成立(二轮 M1)。计数点因此只许有一处、且在进臂那一刻。
        assert_eq!(prod.matches("ops_turns += 1;").count(), 1, "计数点只许一处");
        let bump = prod.find("ops_turns += 1;").expect("有计数点");
        let head = prod[..bump].rfind("if turn == Some(true) {").expect("计数点在 ops 那一臂里");
        assert!(!prod[head..bump].contains("match turn"), "必须在分派结果之前计,不许只数空转");
    }

    /// 中毒即响亮、回滚失败必出声、提交不上必拆链(实现审 H3 与它的同族)。
    ///
    /// 三条都是「**静默**地把坏状态咽下去」这一族,而它们的行为测都造不出可控故障点
    /// (要让 `Mutex` 中毒得先制造一次持锁 panic;要让 `commit` 对不上得先破坏所有权
    /// 不变量)。故按位置钉:退回静默那一形,这只锚就红。
    #[test]
    fn nothing_swallows_a_broken_ops_invariant_silently() {
        let src = include_str!("transport.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        // 中文注释里随便一刀就可能切在多字节字符中间(切了是 panic 不是断言失败),
        // 取样一律退到最近的字符边界 —— 同 `lan_select_arms_only_name_the_event`。
        let peek = |at: usize, n: usize| -> &str {
            let mut end = (at + n).min(prod.len());
            while !prod.is_char_boundary(end) {
                end -= 1;
            }
            &prod[at..end]
        };
        // `lock_ops` **第5笔搬去了 ops_serve**(引擎侧也要取这把锁,中毒政策只许有一份),
        // 故锚点跟着搬 —— 留在本文件里 `find` 会永远落空,而落空的 `expect` 只会红成
        // 「有 lock_ops」,读起来像接线漂移,其实是锚点自己过期了(292 记的第三例)。
        let ops_src = include_str!("ops_serve.rs");
        let ops_prod = &ops_src[..ops_src.find("mod tests {").expect("ops_serve 有测试模块")];
        let lock_at = ops_prod.find("pub(crate) fn lock_ops(").expect("有 lock_ops");
        let mut lock_end = (lock_at + 200).min(ops_prod.len());
        while !ops_prod.is_char_boundary(lock_end) {
            lock_end -= 1;
        }
        let body = &ops_prod[lock_at..lock_end];
        assert!(body.contains(".expect("), "计划表的锁中毒即响亮终局,与 db mutex 同一条纪律");
        assert!(!body.contains("into_inner"), "不许拿 into_inner 吞中毒接着用半张表");
        assert!(!prod.contains("fn lock_ops("), "锁只许有一处定义(两处 = 两份中毒政策)");

        let drop_body = peek(prod.find("impl Drop for OpsTicket").expect("凭据有 Drop"), 700);
        assert!(drop_body.contains("warn("), "回滚失败要出声(合法的那一档在 settle 里回 Ok)");
        assert!(!drop_body.contains("let _ = Self::settle"), "不许静默咽下回滚失败");

        let commit = peek(prod.find("if let Err(e) = ticket.commit() {").expect("有提交点"), 160);
        assert!(
            commit.contains("break format!"),
            "提交不上 = 在飞位已不是这一笔 = 所有权不变量破了,必须响亮收场"
        );
    }

    /// 撤位 / 身份换代 = ops 计划**整只丢弃**(§6.1 所有权表:随 `EngineKey` 换代)。
    /// 留着旧计划的话,新一代会接着按上一代的水位图与游标供 —— 而那些账是拿旧 `K_acc`
    /// 的对端事实算出来的。
    #[test]
    fn retiring_the_slot_throws_the_whole_ops_plan_away() {
        let mut r = deck_rig("lan-ops-retire");
        let origin = seed_big_local_ops(&r, 1);
        assert_eq!(r.slot.ops.lock().unwrap().on_want(PEER_ONE, &origin, 1, 0).admit, ops_serve::Admit::Ok);
        assert_eq!(r.slot.ops.lock().unwrap().len(), 1, "先得真有一份计划");
        r.slot.retire();
        assert_eq!(r.slot.ops.lock().unwrap().len(), 0, "撤位之后一份都不许留");
    }

    // ---- 中转全局数据窗口(§6.1 / §6.2 ① 的 (C);L-d″ 第④笔上半)--------------------

    fn relay_job(to: &str, transfer: &str, total: i64, next_idx: u32) -> BlobJob {
        BlobJob {
            serve: BlobServe {
                to: to.into(),
                route: Route::Relay,
                image_id: "01IMAGE0000000000000000AA".into(),
                transfer: transfer.into(),
                rowid: 1,
                total,
            },
            next_idx,
        }
    }

    /// 待办面的两条形:**每对端至多一笔**(后到的替换先到的)与**满额 fail-closed**。
    ///
    /// 替换那一条是活性不是省内存:对端自己的收端窗口是一笔(engine 的
    /// `MAX_ACTIVE_PULLS`),它再发一枚 `BlobPull` 只能意味着前一笔已被放弃(新
    /// transfer)——照旧的发就是往一条它不认的 transfer 上烧几十兆字节。
    #[test]
    fn the_relay_serve_queue_keeps_one_job_per_peer_and_is_bounded() {
        let mut d = RelayData::default();
        assert!(d.enqueue(relay_job(PEER_ONE, "T1", 1, 0)));
        assert!(d.enqueue(relay_job(PEER_ONE, "T2", 1, 0)));
        assert_eq!(d.pending.len(), 1, "同对端只留一笔");
        assert_eq!(d.pending[0].serve.transfer, "T2", "留的必须是**后到**的那笔");

        // 灌满(PEER_ONE 已占一格)。
        for i in 1..RELAY_SERVE_QUEUE {
            let peer = format!("01FILLER{i:018}");
            assert!(d.enqueue(relay_job(&peer, "T", 1, 0)), "第 {i} 个还没满,应收下");
        }
        assert_eq!(d.pending.len(), RELAY_SERVE_QUEUE);
        assert!(
            !d.enqueue(relay_job("01OVERFLOW00000000000000A", "T", 1, 0)),
            "满额必须**拒**(调用方据此沿同 transfer 回 deny),不许悄悄涨过上界"
        );
        // 满额挡的是「新对端」,不该连带挡住已在册对端的替换——那一笔不增加占用。
        assert!(d.enqueue(relay_job(PEER_ONE, "T3", 1, 0)), "已在册对端的替换不受满额影响");
        assert_eq!(d.pending.len(), RELAY_SERVE_QUEUE, "替换不许让表长大");
        assert_eq!(d.pending[0].serve.transfer, "T3");
    }

    /// 发完一块回队时,若这期间对端已换了 transfer,旧的那笔就此作废;没被顶掉的则回
    /// **队尾**。「每对端至多一笔」由 `enqueue` 与 `requeue` 两处共同守,不靠第三个
    /// 「已放弃」状态位(那就又是一件要维护的事)。
    #[test]
    fn requeue_drops_a_superseded_job_and_otherwise_goes_to_the_back() {
        let mut d = RelayData::default();
        assert!(d.enqueue(relay_job(PEER_ONE, "T2", 1, 0)), "在飞期间对端换了 transfer");
        d.requeue(relay_job(PEER_ONE, "T1", 1, 3));
        assert_eq!(d.pending.len(), 1, "被顶掉的旧笔不许回来");
        assert_eq!(d.pending[0].serve.transfer, "T2");
        assert_eq!(d.pending[0].next_idx, 0, "回来的不许是旧笔的进度");

        let mut d2 = RelayData::default();
        assert!(d2.enqueue(relay_job(PEER_TWO, "TB", 1, 0)));
        d2.requeue(relay_job(PEER_ONE, "TA", 1, 1));
        assert_eq!(d2.pending.len(), 2);
        assert_eq!(
            d2.pending[1].serve.to, PEER_ONE,
            "回的是队**尾**——回队首就等于让一张图独占窗口跑到底,后面那台对端会先被它自己 stale 判死"
        );
    }

    /// **满额那道闸数的是「有活的对端」,不是 `pending.len()`**(codex 实现审 M1)。
    ///
    /// 反例交错:A 的旧 transfer 正在飞 → 待办被别的对端占满 → A 换 transfer 重发 pull
    /// → 按 `pending.len()` 判满就会把**它的替代者**当新对端拒掉 → 旧块 Ack 后旧 A 回队,
    /// 接着把**整张旧图**跑完。「被顶掉的那笔最多再发一块」这条结论的全部依据,就是这一枚
    /// 排得进来。而待办被占满在诚实服务器上真会发生:席位帽限的是「同时在线数」,不限
    /// 「同一条会话期间出现过的对端集」。
    #[test]
    fn a_replacement_for_the_peer_being_served_is_never_rejected_when_full() {
        let mut d = RelayData::default();
        d.occupy_blob(relay_job(PEER_ONE, "T1", 4, 2)).expect("发号");
        let mut accepted = 0;
        for i in 0..RELAY_SERVE_QUEUE + 2 {
            if d.enqueue(relay_job(&format!("01FILLER{i:018}"), "T", 1, 0)) {
                accepted += 1;
            }
        }
        assert_eq!(
            accepted,
            RELAY_SERVE_QUEUE - 1,
            "在制那台已占一格,别的对端只剩 {} 格(按 pending.len() 判会多收一个)",
            RELAY_SERVE_QUEUE - 1
        );
        assert!(d.enqueue(relay_job(PEER_ONE, "T2", 1, 0)), "同对端的替代者不许被满额挡掉");
        assert!(d.pending.len() <= RELAY_SERVE_QUEUE, "pending 仍不越上界,实见 {}", d.pending.len());

        // 旧的那笔发完当前这块回队时就此作废,不许接着跑完整张旧图。
        let Some(Inflight::Blob { job: old, .. }) = d.inflight.take() else {
            panic!("在制那笔还在,且它是图字节那一类")
        };
        d.requeue(old);
        let mine: Vec<&BlobJob> = d.pending.iter().filter(|p| p.serve.to == PEER_ONE).collect();
        assert_eq!(mine.len(), 1, "同对端仍只一笔");
        assert_eq!(mine[0].serve.transfer, "T2", "留下的必须是新 transfer");
    }

    /// **凭据是运行期那道闸**(codex 实现审 L1):号对不上 / 窗口本来就空一律响亮,且
    /// 对不上时**窗口要放回去** —— 此刻还不知道那一笔该不该作废,而会话随即收场、
    /// `session_wrapup` 会清。少了它,一枚错标的回执就能去释放别人的窗口(源码结构锚
    /// 只挡得住「多出一个构造点」,挡不住运行期错配)。
    #[test]
    fn a_mismatched_window_ticket_is_loud_and_keeps_the_window() {
        let mut d = RelayData::default();
        let t = d.occupy_blob(relay_job(PEER_ONE, "T1", 2, 0)).expect("发号");
        assert!(
            d.occupy_blob(relay_job(PEER_TWO, "T2", 2, 0)).is_err(),
            "窗口已占还来占必须响亮 —— 照盖的话旧那笔被无声丢掉,错在这里、报在别处"
        );
        assert!(d.take_blob(RelayDataTicket(t.0 + 1)).is_err(), "号对不上必须响亮");
        assert!(d.inflight.is_some(), "对不上时窗口要放回去,不许顺手丢掉");
        // **类别也得核**(第④笔下半):两类共用发号器故号不会撞,但一枚**错标**的
        // `Sent` 照样能拿对的号来取错的类 —— 那会让 ops 的凭据被当成图字节释放掉
        // (游标白退一格,报出来的却是「图字节回执」)。
        assert!(d.take_ops(t).is_err(), "号对上而类别不对必须响亮");
        assert!(d.inflight.is_some(), "类别对不上时同样要把窗口放回去");
        assert!(d.take_blob(t).is_ok(), "对得上才交出去");
        assert!(d.take_blob(t).is_err(), "窗口空了再来一枚回执同样响亮(与 Ack 那路对称)");
    }

    /// 撤位 / 身份换代 = 窗口与待办**一并**作废:那一枚在飞块的回执随旧会话一起没了,
    /// 留着窗口就永久停在「在飞」,新一代的泵此后一枚都发不出去。
    #[test]
    fn retiring_the_slot_clears_the_relay_data_window() {
        let mut r = deck_rig("relay-window-retire");
        r.slot.relay_data.occupy_blob(relay_job(PEER_ONE, "T1", 1, 0)).expect("发号");
        assert!(r.slot.relay_data.enqueue(relay_job(PEER_TWO, "T2", 1, 0)));
        r.slot.retire();
        assert!(r.slot.relay_data.inflight.is_none(), "撤位之后窗口必须是空的");
        assert!(r.slot.relay_data.pending.is_empty(), "待办也一并作废");
    }

    /// §3 的格式层心跳搭 runtime 那根心跳:活着的发 Ping,静默 ≥90s 的判死。
    #[tokio::test]
    async fn lan_beat_pings_the_living_and_reaps_the_silent() {
        let mut r = deck_rig("lan-beat");
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        {
            let mut deck = offline_face(&mut r);
            deck.lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
            assert!(matches!(peer.next(500).await, Some(lan::LanWire::Frame { .. })), "建链先发定向 Hello");
            deck.lan_beat().await.unwrap();
        }
        assert!(matches!(peer.next(500).await, Some(lan::LanWire::Ping {})), "心跳一刻发 Ping");

        // 把活性时刻推回 91 秒前:下一拍必须判死。
        r.slot.lan.links.get_mut(PEER_ONE).unwrap().last_rx =
            Instant::now() - Duration::from_secs(LAN_SILENCE_SECS + 1);
        offline_face(&mut r).lan_beat().await.unwrap();
        assert_eq!(r.slot.lan.count(), 0, "静默超时即判死");
        assert_eq!(r.status.lock().unwrap().lan_peers, 0, "状态面跟着落");
        assert!(peer.closed(500).await, "判死 = socket 当场关掉(不是「碰巧没帧」)");
    }

    /// §5「本机中转离线:全部 mail 走各 lan 链路」+ 收端的来路亲和应答。这里同时钉住
    /// **中转在线的对端不补投**:补投面只认引擎的路由表(不变量 1 的「唯一副本路」)。
    #[tokio::test]
    async fn offline_mail_goes_out_every_lan_leg_but_not_to_relay_reachable_peers() {
        let mut r = deck_rig("lan-mail");
        let (m1, t1) = tcp_pair().await;
        let (m2, t2) = tcp_pair().await;
        let mut one = FakeLink { stream: t1 };
        let mut two = FakeLink { stream: t2 };
        let cfg = deck_cfg(&r.db);
        {
            let mut deck = offline_face(&mut r);
            deck.lan_adopt(adopted(PEER_ONE, 1, m1)).await.unwrap();
            deck.lan_adopt(adopted(PEER_TWO, 2, m2)).await.unwrap();
        }
        assert!(one.next_msg(&cfg, 500).await.is_some(), "建链的定向 Hello");
        assert!(two.next_msg(&cfg, 500).await.is_some());
        assert_eq!(r.status.lock().unwrap().lan_peers, 2);

        // 本机写一条 → 广播 mail(Auto):两条腿都该收到。
        //
        // **第5笔改了这一路的走法,契约没变**:`outbound` 只把义务登记进 BROADCAST work
        // 并产一枚 `ServeOps{Broadcast}`;dispatch 那一枚时,中转不在场 → 协调者自己取一枚
        // 帧、**在发帧的同一处 fan-out 给全部合格直连腿**(§6.2 ①)。刻意**不让各条 LAN
        // 写泵去抢 BROADCAST**:在飞位只有一枚,谁抢到谁提交、游标随即前进,别的对端那一
        // 帧就永远补不上了 —— 下面这句 for 循环正是钉住这条的判据。
        {
            let mut conn = r.db.lock().unwrap();
            let mut clk = r.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "断网期写的一条").unwrap();
        }
        let mut outs = vec![];
        {
            let conn = r.db.lock().unwrap();
            r.slot.get().unwrap().outbound(&conn, &mut outs).unwrap();
        }
        assert!(!outs.is_empty(), "断网期也照推本机新 op(§5)");
        offline_face(&mut r).dispatch(outs).await.unwrap();
        for peer in [&mut one, &mut two] {
            let (from, to, msg) = peer.next_msg(&cfg, 500).await.expect("两条腿都收到");
            assert_eq!(from, cfg.device_id);
            assert_eq!(to, BROADCAST, "广播帧的 AAD 收件人恒是广播(封一次投多条)");
            assert!(matches!(msg, Msg::Ops { .. }));
        }

        // 让引擎认定 PEER_ONE 的中转腿通着 → 它就退出补投面,只剩 PEER_TWO。
        //
        // ⚠ **仪式那批输出得真投出去**(第⑤笔):保守合并会把本机 origin 按对端确认过的
        // 水位重新登记一遍(§6.2 ⑦),丢掉它 = BROADCAST 的活一直挂在计划表里没人来取,
        // 而随后那次 `outbound` 会**老实**回 `woke=false`(「该来取活的人早该在路上了」),
        // 于是后面那一枚永远发不出去。生产里这一环靠 `ops_changed` 接力,夹具里得自己投。
        let ceremony = {
            let conn = r.db.lock().unwrap();
            let e = r.slot.get().unwrap();
            let outs = e.on_relay_session_up(&conn, 0).unwrap();
            // 排在仪式之后:此刻起 PEER_ONE 退出补投面,故仪式重推的那一枚也不该给它。
            e.on_relay_peer_up(PEER_ONE);
            outs
        };
        offline_face(&mut r).dispatch(ceremony).await.unwrap();
        assert!(two.next_msg(&cfg, 500).await.is_some(), "仪式重推那一枚,照样只落 PEER_TWO");
        {
            let mut conn = r.db.lock().unwrap();
            let mut clk = r.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "第二条").unwrap();
        }
        let mut outs = vec![];
        {
            let conn = r.db.lock().unwrap();
            r.slot.get().unwrap().outbound(&conn, &mut outs).unwrap();
        }
        offline_face(&mut r).dispatch(outs).await.unwrap();
        assert!(two.next_msg(&cfg, 500).await.is_some(), "中转腿不可达的对端照补投");
        assert!(one.next_msg(&cfg, 300).await.is_none(), "中转腿通着的对端不平行投一份");
    }

    /// **断网期一条腿都没投出去:游标一步不许进,也不许当场自唤**(codex 实现审一轮 M 的
    /// 行为面,二轮点名要补)。断网期 LAN 就是权威腿,没有别人在等 Ack —— 照 relay 那套
    /// 「旁腿失败不回滚」搬过来的话,这一段就从内存游标上过去了。
    ///
    /// 四格一起断,少一格就漏掉一种坏法:
    /// * **响亮** —— 丢同步工作不许静默;
    /// * **铃是哑的** —— 摇了就是「取帧 → 投不出 → 静默交回 → 摇铃 → 再取同一段」的热循环
    ///   (与中转腿 Nack 那条同族);
    /// * **计划表里那份 work 原样在** —— 游标动了的话它就空了;
    /// * **新链接入之后发出去的是同一段** —— 续做所有者写在注释里,得真有人接得住。
    #[tokio::test]
    async fn an_offline_broadcast_that_reached_nobody_keeps_the_segment_and_stays_quiet() {
        let mut r = deck_rig("lan-mail-nobody");
        let cfg = deck_cfg(&r.db);
        let (m1, t1) = tcp_pair().await;
        let mut one = FakeLink { stream: t1 };
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, m1)).await.unwrap();
        assert!(one.next_msg(&cfg, 500).await.is_some(), "建链的定向 Hello");

        // 本机写两条 → `outbound` 把 `[1,2]` 登记进 BROADCAST work 并产一枚描述符。
        {
            let mut conn = r.db.lock().unwrap();
            let mut clk = r.clock.lock().unwrap();
            for i in 1..=2 {
                notes::capture(&mut conn, &mut clk, &format!("断网期第 {i} 条")).unwrap();
            }
        }
        let mut outs = vec![];
        {
            let conn = r.db.lock().unwrap();
            r.slot.get().unwrap().outbound(&conn, &mut outs).unwrap();
        }
        assert!(!outs.is_empty(), "断网期照登记本机新 op");

        // **把链从链路集里摘掉,但不动引擎的路由表**:补投面照旧报 PEER_ONE(那是引擎的
        // 事实,§5 判据出口只此一个),而 `push_lan` 回 `NoLink` —— 正是 `delivered == 0`
        // 的三种成因里「合格腿刚好全断」那一种。
        r.slot.lan.links.remove(PEER_ONE);
        // 建链那一下摇过铃,先把存量吃掉,免得下面把它读成「这一趟摇的」。
        let _ = timeout(Duration::from_millis(100), r.slot.ops_changed.notified()).await;

        offline_face(&mut r).dispatch(outs).await.unwrap();
        assert!(
            timeout(Duration::from_millis(200), r.slot.ops_changed.notified()).await.is_err(),
            "零投递不许摇铃 —— 摇了就是当场再取同一段的热循环"
        );
        assert!(
            r.status
                .lock()
                .unwrap()
                .lan_warning
                .as_deref()
                .is_some_and(|w| w.contains("一条直连腿都没投出去")),
            "得报出来,不许静默;实见 {:?}",
            r.status.lock().unwrap().lan_warning
        );
        assert_eq!(
            r.slot.ops.lock().unwrap().idle_runnable_targets(),
            vec![BROADCAST.to_string()],
            "游标一步都不许进:那一段原样留在计划表里"
        );

        // 续做所有者 = 新链接入那一下(它摇铃,协调者扫一趟)。**发出去的必须是同一段**。
        let (m2, t2) = tcp_pair().await;
        let mut again = FakeLink { stream: t2 };
        {
            let mut deck = offline_face(&mut r);
            deck.lan_adopt(adopted(PEER_ONE, 2, m2)).await.unwrap();
            deck.ops_changed_tick().await.unwrap();
        }
        assert!(again.next_msg(&cfg, 500).await.is_some(), "新链的定向 Hello");
        let (_, to, msg) = again.next_msg(&cfg, 500).await.expect("同一段必须还在");
        assert_eq!(to, BROADCAST, "广播帧的 AAD 收件人恒是广播");
        let Msg::Ops { origin, ops } = msg else { panic!("该是 ops 帧,实见 {msg:?}") };
        assert_eq!(origin, cfg.device_id);
        assert_eq!(
            ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>(),
            vec![1, 2],
            "两枚都得在:少一枚就是零投递那趟偷偷把游标推过去了"
        );
    }

    /// §5 **例外③**(定向 mail 的补投):`to=X` 的 Auto 帧,只在「X 的中转腿不可达 ∧ X 的
    /// lan 腿在」时才多沿直连投一份;X 的中转腿通着就只走中转(不变量 1「唯一副本路」)。
    /// 这条与广播那条各有各的判据,故各有各的测(补投面判错方向 = 要么平行双投、要么
    /// 对端离线时谁也收不到)。
    #[tokio::test]
    async fn directed_mail_is_backfilled_only_when_the_relay_leg_is_down() {
        let mut r = deck_rig("lan-directed");
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        let cfg = deck_cfg(&r.db);
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
        assert!(peer.next_msg(&cfg, 500).await.is_some(), "建链的定向 Hello");

        // 引擎眼里 PEER_ONE 的中转腿通着 → 定向帧只走中转,不往 lan 平行投。
        {
            let conn = r.db.lock().unwrap();
            let e = r.slot.get().unwrap();
            e.on_relay_session_up(&conn, 0).unwrap();
            e.on_relay_peer_up(PEER_ONE);
        }
        let directed = |id: &str| Output::Send {
            to: PEER_ONE.into(),
            lane: Lane::Mail,
            route_hint: RouteHint::Auto,
            msg: Msg::BlobWant { image_id: id.into() },
        };
        offline_face(&mut r).dispatch(vec![directed("IMG-A")]).await.unwrap();
        assert!(peer.next_msg(&cfg, 300).await.is_none(), "中转腿通着:不补投");

        // 对端掉线(只是它的中转腿)→ 例外③ 生效。
        r.slot.get().unwrap().on_relay_peer_down(PEER_ONE);
        offline_face(&mut r).dispatch(vec![directed("IMG-B")]).await.unwrap();
        let (_, to, msg) = peer.next_msg(&cfg, 500).await.expect("对端中转离线:补投一份");
        assert_eq!(to, PEER_ONE, "定向帧的 AAD 收件人就是它");
        assert!(matches!(msg, Msg::BlobWant { image_id } if image_id == "IMG-B"));
    }

    /// §5 断网期的定向 Hello:对每条活跃链各问一枚(不依赖对端事件的新鲜度,二轮 M5)。
    #[tokio::test]
    async fn offline_hello_asks_every_lan_peer_directly() {
        let mut r = deck_rig("lan-offline-hello");
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        let cfg = deck_cfg(&r.db);
        {
            let mut deck = offline_face(&mut r);
            deck.lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
            assert!(peer.next_msg(&cfg, 500).await.is_some(), "建链那一帧");
            deck.lan_offline_hello().await.unwrap();
        }
        let (from, to, msg) = peer.next_msg(&cfg, 500).await.expect("断网期定向 Hello");
        assert_eq!(from, cfg.device_id);
        assert_eq!(to, PEER_ONE, "定向发给该对端,不是广播");
        match msg {
            Msg::Hello { lan, .. } => assert!(lan.is_none(), "lan 腿上不注入通告(§2 单一权威路)"),
            other => panic!("该是 Hello,实见 {other:?}"),
        }
    }

    /// 同对端换链(§7 仲裁选定新链之后):旧链当场关闭、剩余队列丢弃,新链先被通报给引擎
    /// 再进发送表(定向 Hello 因此落在新链上);旧代的迟到断链通报打不掉它。
    #[tokio::test]
    async fn replacing_a_link_closes_the_old_one_and_binds_new_output_to_the_new_object() {
        let mut r = deck_rig("lan-swap");
        let (m1, t1) = tcp_pair().await;
        let (m2, t2) = tcp_pair().await;
        let mut old = FakeLink { stream: t1 };
        let mut new = FakeLink { stream: t2 };
        let cfg = deck_cfg(&r.db);
        {
            let mut deck = offline_face(&mut r);
            deck.lan_adopt(adopted(PEER_ONE, 5, m1)).await.unwrap();
            assert!(old.next_msg(&cfg, 500).await.is_some(), "旧链的定向 Hello");
            // link_id 更小者胜(§7 二级规则)→ 替换。
            deck.lan_adopt(adopted(PEER_ONE, 1, m2)).await.unwrap();
        }
        assert_eq!(r.slot.lan.count(), 1, "同对端恒单活跃写者");
        assert!(new.next_msg(&cfg, 500).await.is_some(), "新链拿到自己的定向 Hello");
        assert!(old.closed(500).await, "旧链已关(剩余队列随对象丢弃)");
        // **结构锚**(行为测只证得了一半,诚实记账):写半边 `Drop` 自带 shutdown,故对端
        // 看得见 EOF 与两只 abort 在不在无关;但**读任务**没人 abort 就一直挂着——每换一
        // 条链漏一只任务,那是长寿命 runtime 上的真泄漏。故这两行一个都不能少。
        let src = include_str!("transport.rs");
        let at = src.find("impl Drop for LanLink").expect("链路对象有 Drop");
        let body = &src[at..at + 500];
        assert!(body.contains("self.reader.abort();"), "读任务必须 abort");
        assert!(body.contains("self.writer.abort();"), "写任务必须 abort");

        // 旧链的死讯迟到:引擎与链路集都不该被它打掉。
        let gen_old = 1;
        offline_face(&mut r)
            .lan_fault(LanFault {
                peer: PEER_ONE.into(),
                generation: gen_old,
                why: "迟到".into(),
            })
            .await
            .unwrap();
        assert_eq!(r.slot.lan.count(), 1, "迟到的旧代断链打不掉新链");
        assert!(r.slot.get().unwrap().lan_backfill(PEER_ONE), "引擎那边的 lan 腿也还在");
    }

    /// 移交半途失败**不许留死腿**(实现审 H2):`on_lan_link_up` 里读水位读崩 → 整笔 Err、
    /// 链路压根不进发送表,引擎的路由表里也必须干干净净。反过来(先置位再读库)留下的是
    /// 一条谁也断不掉的腿——mail 没有 stale 定时器兜底,选路此后一直往它投。
    #[tokio::test]
    async fn a_failed_adopt_leaves_no_dead_leg() {
        let mut r = deck_rig("lan-adopt-fail");
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        // 读库当场崩:换上一只空库(没有 oplog 表),`watermarks` 必然 Err。
        *r.db.lock().unwrap() = Connection::open_in_memory().unwrap();

        let err = offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap_err();
        assert!(err.contains("oplog"), "该是读水位读崩了,实见 {err}");
        assert_eq!(r.slot.lan.count(), 0, "链路没进发送表");
        assert!(!r.slot.get().unwrap().lan_backfill(PEER_ONE), "引擎的路由表里也不许留这条腿");
        assert!(peer.closed(500).await, "socket 随移交对象一起落地");
    }

    /// 同上,但失败的是**替换**那一路:候选没能通报成功,在位那条链与**它的代次**都得原样
    /// 留着。代次要是被候选顶掉,在位链此后收到的一切都对不上号(它自己的断链通报也打不掉
    /// 自己),等于活着的链变哑巴。
    #[tokio::test]
    async fn a_failed_replacement_keeps_the_incumbent_generation() {
        let mut r = deck_rig("lan-adopt-fail-swap");
        let (m1, t1) = tcp_pair().await;
        let (m2, t2) = tcp_pair().await;
        let mut old = FakeLink { stream: t1 };
        let mut new = FakeLink { stream: t2 };
        let cfg = deck_cfg(&r.db);
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 5, m1)).await.unwrap();
        assert!(old.next_msg(&cfg, 500).await.is_some(), "在位链的定向 Hello");

        // link_id 更小者本该胜(§7 二级规则),但它的通报读库崩了。
        *r.db.lock().unwrap() = Connection::open_in_memory().unwrap();
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, m2)).await.unwrap_err();
        assert_eq!(r.slot.lan.count(), 1, "在位链还在发送表里");
        assert!(new.closed(500).await, "败下来的候选当场落地");

        // 探针:按**在位那一代**(首次移交拿的 1 号)报断链——引擎若已被失败的候选顶成 2 代,
        // 这一报就打不掉腿,`lan_backfill` 会仍然为真。
        r.slot.get().unwrap().on_lan_link_down(PEER_ONE, 1);
        assert!(!r.slot.get().unwrap().lan_backfill(PEER_ONE), "引擎认的当前代仍是在位那条");
    }

    /// 死腿的兜底口(实现审 H2 的另一半):引擎以为腿在、链路集里却没有(移交半途失败 /
    /// 断链通报丢了 / 撤位与建链交错)——**第一枚送不出去的帧就该把这条腿抹掉**,而不是
    /// 每次记一句告警、继续往黑洞里投。
    #[tokio::test]
    async fn a_missing_link_drops_the_leg_instead_of_warning_forever() {
        let mut r = deck_rig("lan-dead-leg");
        // 不经 `lan_adopt` 直接通报引擎 = 造出「引擎有、链路集没有」的死腿。
        {
            let conn = r.db.lock().unwrap();
            r.slot.get().unwrap().on_lan_link_up(&conn, PEER_ONE, 7).unwrap();
        }
        assert!(r.slot.get().unwrap().lan_backfill(PEER_ONE), "先造出死腿");

        let mail = || {
            vec![Output::Send {
                to: BROADCAST.into(),
                lane: Lane::Mail,
                route_hint: RouteHint::Auto,
                msg: Msg::Hello { watermarks: Default::default(), lan: None },
            }]
        };
        offline_face(&mut r).dispatch(mail()).await.unwrap();
        assert!(r.status.lock().unwrap().lan_warning.is_some(), "响亮记一笔");
        assert!(!r.slot.get().unwrap().lan_backfill(PEER_ONE), "这条腿当场抹掉,不留黑洞");

        // 再发一轮:补投面已经不认识它了,连告警都不该再有。
        r.status.lock().unwrap().lan_warning = None;
        offline_face(&mut r).dispatch(mail()).await.unwrap();
        assert!(r.status.lock().unwrap().lan_warning.is_none(), "不再往不存在的链路投");
    }

    /// **本笔的核心验收**(§11:「WAN 自启动前即断」的冷启动 + 纯直连收敛):两台设备一条
    /// WSS 都没连过(服务器地址指向必然连不上的端口),仅靠一条真 TCP 链路——
    /// ① 建链即互发定向 Hello,存量 op 靠水位互补拉齐(验收项② 明示接受的形);
    /// ② 此后本地写实时推过去(离线泵里的 `outbound`)。
    #[tokio::test]
    async fn two_offline_devices_converge_over_a_real_tcp_link() {
        let a = lan_rig("lan-conv-a", 11);
        let b = lan_rig("lan-conv-b", 22);
        // A 有一条存量灵感(建链前就写下,故只能靠 hello/want 互补过去)。
        {
            let mut conn = a.db.lock().unwrap();
            let mut clk = a.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "建链前写的").unwrap();
        }
        let (sock_a, sock_b) = tcp_pair().await;
        a.handoff.send(adopted(&b.device, 1, sock_a)).await.unwrap();
        b.handoff.send(adopted(&a.device, 1, sock_b)).await.unwrap();

        wait_until("两端都认下这条直连", || {
            a.status.lock().unwrap().lan_peers == 1 && b.status.lock().unwrap().lan_peers == 1
        })
        .await;
        wait_until("存量 op 经双向 hello 互补拉齐", || count_items(&b.db) == 1).await;

        // 建链之后的本地写:离线泵里的 outbound 当场沿直连腿推过去。
        {
            let mut conn = b.db.lock().unwrap();
            let mut clk = b.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "断网期 B 写的").unwrap();
        }
        wait_until("A 收到 B 的实时写", || count_items(&a.db) == 2).await;
        wait_until("两端 oplog 逐行一致", || {
            oplog_fingerprint(&a.db) == oplog_fingerprint(&b.db)
        })
        .await;
        // 不变量 2:lan 投递**永不**推进「服务器已接手」那根游标。
        for rig in [&a, &b] {
            let conn = rig.db.lock().unwrap();
            assert_eq!(read_last_pushed(&conn).unwrap(), 0, "last_pushed 只由服务器 ack 抬");
        }
        a.task.abort();
        b.task.abort();
    }

    /// 撤位 = **状态面的链路数当场归零**(实现审 L1)。撤位那三档(未配置 / 配置残缺 /
    /// 纪元封闸)把全部链路都拆了,而状态面是 lan 唯一的可见面——漏刷一次,UI 上就长期
    /// 挂着「还有 N 条直连」的幻影,且没有第二处能纠正它。
    #[tokio::test]
    async fn retiring_the_slot_zeroes_the_link_count_on_the_status_face() {
        let a = lan_rig("lan-retire-status", 33);
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        a.handoff.send(adopted(PEER_ONE, 1, mine)).await.unwrap();
        wait_until("直连认下了", || a.status.lock().unwrap().lan_peers == 1).await;

        // 撤位刷的是**整份槽事实**(实现审二轮 L1):引擎正式退役后,冻结/隔离/挂起不再是
        // 「当前引擎的事实」,留着等于拿旧代状态冒充当前状态。先塞一条假冻结当探针。
        a.status.lock().unwrap().frozen = vec!["01GHOSTAAAAAAAAAAAAAAAAAAA".into()];

        // 配置残缺(删掉一把键)= 撤位三档之一;poke 一下让循环立刻重查,不必干等退避。
        {
            let conn = a.db.lock().unwrap();
            conn.execute("DELETE FROM sync_meta WHERE key='server_url'", []).unwrap();
        }
        a.ctl.send(Control::Reconfigured).await.unwrap();

        wait_until("状态面的链路数跟着归零", || a.status.lock().unwrap().lan_peers == 0).await;
        // 拆链前已排在流上的帧(建链的定向 Hello / 断网期那一轮)先读干净:`closed()` 读的
        // 是同一条流,见到字节就当「还活着」——这几行不是装饰。读空之后仍分得清「关了」与
        // 「这会儿没帧」:后者的 `closed()` 会超时,照样为假。
        while peer.next(200).await.is_some() {}
        assert!(peer.closed(500).await, "链路是真拆了,不只是数字变了");
        assert!(a.status.lock().unwrap().frozen.is_empty(), "撤位后旧引擎的冻结清单不许留着");
        a.task.abort();
    }

    /// 撤位的另一条路(同 L1):身份换代那一次藏在 `slot.reconcile` 里,没有 `retire_all`
    /// 经手——由紧随其后的主状态块([`EngineSlot::apply_status`])照同一份事实刷。两条撤位
    /// 路都得有出口,少一条就是一处只在换纪元时才现形的幻影。
    #[tokio::test]
    async fn recasting_the_identity_also_zeroes_the_link_count() {
        let a = lan_rig("lan-recast-status", 44);
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        a.handoff.send(adopted(PEER_ONE, 1, mine)).await.unwrap();
        wait_until("直连认下了", || a.status.lock().unwrap().lan_peers == 1).await;

        // 换 K_acc = 引擎身份指纹换代(纪元切换落地后的形):整台丢弃重装,链路一起拆。
        {
            let conn = a.db.lock().unwrap();
            meta_put(&conn, "k_acc", &hex(&[9u8; 32])).unwrap();
        }
        a.ctl.send(Control::Reconfigured).await.unwrap();

        wait_until("状态面的链路数跟着归零", || a.status.lock().unwrap().lan_peers == 0).await;
        while peer.next(200).await.is_some() {}
        assert!(peer.closed(500).await, "链路是真拆了,不只是数字变了");
        a.task.abort();
    }

    /// 代次号用尽 = **拒绝建链**,绝不回绕(实现审 L2):回绕会让新链拿到某条旧链用过的号,
    /// 迟到事件与旧代 transfer 从此认错人——那是数据面的错,不是可用性问题。
    #[tokio::test]
    async fn generation_exhaustion_refuses_new_links() {
        let mut r = deck_rig("lan-gen-max");
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        r.slot.lan.next_generation = u64::MAX;

        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
        assert_eq!(r.slot.lan.count(), 0, "号用尽即不建链");
        assert!(r.status.lock().unwrap().lan_warning.is_some(), "响亮记一笔");
        assert!(!r.slot.get().unwrap().lan_backfill(PEER_ONE), "引擎也不该知道它来过");
        assert!(peer.closed(500).await, "socket 当场落地");
    }

    /// **可控竞态**(实现审 M1 点名要的那条):在「引擎已产出待发帧、还没入队」这一刻,把
    /// 换链事件经**正式 handoff 通道**送达——协调者是 run-to-completion 的,故那枚事件虽已
    /// 就绪却插不进去(栅栏挂着时链路数纹丝不动即为凭据),那枚帧因此绝不会落到新代链上。
    ///
    /// 只硬断言「新链收不到它」:放行之后旧链是先被写出去、还是随替换一起丢队列,由调度器
    /// 定——两者都合契约(§6 代次契约之三「入队即绑具体链路对象」,替换不把旧队列改投新链)。
    /// 那枚帧**确实产出过**由另一条不换代的链作证(否则栅栏拦下的可能只是一次空 dispatch,
    /// 这条用例就什么也没验)。
    #[tokio::test]
    async fn a_frame_born_under_gen1_never_lands_on_gen2() {
        let a = lan_rig("lan-gen-race", 66);
        let (m1, t1) = tcp_pair().await;
        let (m2, t2) = tcp_pair().await;
        let (mw, tw) = tcp_pair().await;
        let mut old = FakeLink { stream: t1 };
        let mut new = FakeLink { stream: t2 };
        let mut witness = FakeLink { stream: tw };
        let cfg = {
            let conn = a.db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        a.handoff.send(adopted(PEER_ONE, 9, m1)).await.expect("移交首链");
        a.handoff.send(adopted(PEER_TWO, 3, mw)).await.expect("移交作证链");
        wait_until("两条链都认下", || a.status.lock().unwrap().lan_peers == 2).await;
        assert!(old.next_msg(&cfg, 1000).await.is_some(), "首链的定向 Hello");
        assert!(witness.next_msg(&cfg, 1000).await.is_some(), "作证链的定向 Hello");

        // 栅栏装上,再写一条:协调者产出 outbound 之后、入队之前停住。
        let (reached, release) = arm_dispatch_barrier();
        {
            let mut conn = a.db.lock().unwrap();
            let mut clk = a.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "栅栏那一刻写的").unwrap();
        }
        // (写命令落 oplog 即触发 update hook,协调者的 `wrote` 那条臂自会醒。)
        timeout(Duration::from_secs(3), reached.notified()).await.expect("协调者该停在栅栏上");

        // 换链事件此刻送达(link_id 更小者胜,§7 二级规则)。协调者正卡在栅栏上,故它
        // **就绪而不可消费**——新链此刻拿不到自己的定向 Hello,就是「插不进去」的凭据。
        a.handoff.send(adopted(PEER_ONE, 1, m2)).await.expect("移交换代链");
        assert!(new.next(300).await.is_none(), "换链事件插不进正在跑的那一件");

        release.notify_one();

        // 那一刻产出的确实是一枚真帧:不换代的那条链照收不误。
        let (_, _, seen) = witness.next_msg(&cfg, 2000).await.expect("作证链收到那枚 mail");
        assert!(matches!(seen, Msg::Ops { .. }), "该是本地写推出去的 op,实见 {seen:?}");

        // 而新代链只该收到它自己的定向 Hello,绝不会收到上面那一枚。
        let mut saw_hello = false;
        for _ in 0..6 {
            match new.next_msg(&cfg, 500).await {
                None => break,
                Some((_, _, Msg::Hello { .. })) => saw_hello = true,
                Some((_, _, other)) => panic!("gen1 那一刻产出的帧落到了新代链上:{other:?}"),
            }
        }
        assert!(saw_hello, "换链确实发生了(否则这条用例什么也没验)");
        a.task.abort();
    }

    /// **一台坏中转摁不死直连**(实现审 H1):中转端接受了连接却不发 Challenge。原先建连与
    /// 鉴权是一口气 await 完的,lan 的收发、心跳、链路移交在那几十秒里全冻住——而不变量 6
    /// 说的正是「引擎与直连的生命期不归中转会话管」。现在建连与泵并行跑,故这枚移交与它带出
    /// 的定向 Hello 必须在**远短于一次握手超时**(HANDSHAKE_SECS=10s)的期限内落地。
    #[tokio::test]
    async fn a_stalled_relay_handshake_cannot_freeze_the_lan_leg() {
        let (stall, addr) = stalled_relay().await;
        let a = lan_rig_at("lan-stalled-relay", 55, &format!("ws://{addr}"));
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        a.handoff.send(adopted(PEER_ONE, 1, mine)).await.expect("移交");

        // 三秒是刻意取的:拨号自己的超时是十秒,「等它超时再说」的实现到不了这里。
        let got = timeout(Duration::from_secs(3), peer.next(2500)).await.expect("三秒内该有帧");
        assert!(matches!(got, Some(lan::LanWire::Frame { .. })), "建链的定向 Hello 必须照发");
        assert_eq!(a.status.lock().unwrap().lan_peers, 1, "链路当场认下,不等中转握手");

        a.task.abort();
        stall.abort();
    }

    /// 只 accept、此后一言不发的假中转(连 WebSocket 升级都不应答,也不关连接)——比「端口
    /// 直接拒绝」狠一档的形态:拨号那 10 秒里协调者原本整个停摆。
    async fn stalled_relay() -> (tokio::task::JoinHandle<()>, std::net::SocketAddr) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let task = tokio::spawn(async move {
            let mut held = vec![];
            while let Ok((sock, _)) = listener.accept().await {
                held.push(sock); // 攥着不放
            }
        });
        (task, addr)
    }

    /// 按脚本走的假中转:完成 WS 升级 → 发 Challenge → 收下 Auth(**并告诉测试收到了**)
    /// → **停在这里**,直到测试放行才回 `Authed`。要验「鉴权成功与会话仪式之间那一窗」就得
    /// 拿捏这个时刻,真服务器上抢这个时序是碰运气。
    async fn scripted_relay() -> (
        tokio::task::JoinHandle<()>,
        std::net::SocketAddr,
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (saw_auth_tx, saw_auth_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            let mut ws = tokio_tungstenite::accept_async(sock).await.expect("ws 升级");
            let challenge = ServerMsg::Challenge { nonce: vec![7u8; 32] };
            ws.send(WsMsg::Binary(sync_proto::encode(&challenge).into())).await.expect("发 Challenge");
            let _ = ws.next().await; // 客户端的 Auth
            let _ = saw_auth_tx.send(());
            let _ = release_rx.await;
            ws.send(WsMsg::Binary(sync_proto::encode(&ServerMsg::Authed).into()))
                .await
                .expect("发 Authed");
            // 此后不再说话,但得攥着连接(一关客户端就当断线重连了)。
            std::future::pending::<()>().await
        });
        (task, addr, saw_auth_rx, release_tx)
    }

    // ---- 可控假中转:中转腿数据窗口的行为测工装(L-d″ 第④笔)-------------------------

    /// 完成 WS 升级 → `Challenge` → 吞掉 `Auth` → `Authed`,此后**把每一枚
    /// `ClientMsg::Send` 交给测试**、回执由测试说了算(`Ping` 自动回 `Pong`,免得 90s
    /// 静默判死掺进用例)。连接**循环 accept**:会话收场后客户端会重连,那正是
    /// 「`unknown_device` 恒 session-fatal」的判据。
    ///
    /// **为什么非造它不可**(诚实记账):中转腿的数据窗口、Ack 驱动下一块、Nack 三档处置
    /// 一条都验不了 —— 真服务器恒即刻 Ack,拿不到「窗口占着时又来一枚 pull」「busy 之后
    /// 不当场重发」这些时序;而在此之前测试段**没有任何构造 [`RelayLeg::Up`] 的路径**
    /// (`offline_face` 把 relay 钉死在 `Down`,`Rig` 又不暴露 [`EngineSlot`])。第④笔
    /// 下半的 `Sent`×code 全矩阵同样要靠它。
    struct FakeRelay {
        addr: std::net::SocketAddr,
        task: tokio::task::JoinHandle<()>,
        /// 每一枚 `ClientMsg::Send`,按线上顺序:`(n, to, blob)`。
        sent: mpsc::UnboundedReceiver<(u64, String, Vec<u8>)>,
        /// 每条**新连接**鉴权完成时报一声 = 「上一条会话收场了」的判据。
        conns: mpsc::UnboundedReceiver<()>,
        /// 测试主动下发的回执 / 投递。
        reply: mpsc::UnboundedSender<ServerMsg>,
        /// 把当前连接当场丢掉 = 客户端侧一次「会话因故收场」,**且不经任何客户端自己的
        /// 收口分支**(`unknown_device` 那条路自己就清窗口,验不出 [`session_wrapup`])。
        closer: mpsc::UnboundedSender<()>,
    }

    impl FakeRelay {
        fn url(&self) -> String {
            format!("ws://{}", self.addr)
        }

        /// 下一枚解得开的出站帧(会话仪式的 Hello / want / ops 也走这条,调用方自己筛)。
        async fn next_out(&mut self, cfg: &SyncConfig, ms: u64) -> Option<(u64, String, Msg)> {
            let (n, to, blob) = timeout(Duration::from_millis(ms), self.sent.recv()).await.ok()??;
            let Opened::Data(msg) = open_deliver(cfg, &cfg.device_id, &to, &blob) else {
                panic!("中转腿上的帧解不开(夹具与生产的封帧口径漂了)");
            };
            Some((n, to, msg))
        }

        /// 下一枚**图字节**帧(把别的帧滤掉,**并逐枚 Ack**)。
        ///
        /// ⚠ **Ack 那一句是第⑤笔加的,不加就是一整批假红**:两类数据从此共用一枚窗口且
        /// 按回合 1:1,而这些夹具都要先写一张图(= 先写了本机 op),故 ops 那条腿必然抢在
        /// 图前面拿到第一个回合。**只滤不 Ack** 的话窗口一直占着,图那一枚永远轮不到 ——
        /// 用例会以「等不到第 0 块」的形式红,而生产其实是对的。
        ///
        /// Ack 掉它们也正是真服务器会做的事(顺带驱动 `last_pushed` 与 ops 游标),故这不是
        /// 把问题掩盖过去,是把夹具补成一个**会应答**的对家。
        async fn next_blob(&mut self, cfg: &SyncConfig, ms: u64) -> Option<(u64, String, Msg)> {
            loop {
                let (n, to, msg) = self.next_out(cfg, ms).await?;
                if matches!(msg, Msg::BlobChunk { .. } | Msg::BlobDeny { .. }) {
                    return Some((n, to, msg));
                }
                self.ack(n);
            }
        }

        fn ack(&self, n: u64) {
            self.reply.send(ServerMsg::Ack { n }).expect("假中转还活着");
        }

        fn nack(&self, n: u64, code: &str) {
            self.reply.send(ServerMsg::Nack { n, code: code.into() }).expect("假中转还活着");
        }

        fn close(&self) {
            self.closer.send(()).expect("假中转还活着");
        }

        /// 冒充某台对端投一枚帧进来(与 [`FakeLink::send_msg`] 同一套封帧口径)。
        fn deliver(&self, cfg: &SyncConfig, from: &str, msg: &Msg) {
            let blob = crypto::seal_msg(
                &cfg.k_acc,
                &FrameAddr {
                    account_id: &cfg.account_id,
                    from_device: from,
                    to: &cfg.device_id,
                    domain: msg_domain(msg),
                },
                msg,
            );
            self.reply
                .send(ServerMsg::Deliver { from: from.into(), to: cfg.device_id.clone(), blob })
                .expect("假中转还活着");
        }
    }

    async fn fake_relay() -> FakeRelay {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (sent_tx, sent) = mpsc::unbounded_channel();
        let (conn_tx, conns) = mpsc::unbounded_channel();
        let (reply, mut reply_rx) = mpsc::unbounded_channel::<ServerMsg>();
        let (closer, mut closer_rx) = mpsc::unbounded_channel::<()>();
        let task = tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let Ok(mut ws) = tokio_tungstenite::accept_async(sock).await else { continue };
                let ch = ServerMsg::Challenge { nonce: vec![7u8; 32] };
                if ws.send(WsMsg::Binary(sync_proto::encode(&ch).into())).await.is_err() {
                    continue;
                }
                let _ = ws.next().await; // 客户端的 Auth(不验签:这里要的是时序不是鉴权)
                let authed = sync_proto::encode(&ServerMsg::Authed);
                if ws.send(WsMsg::Binary(authed.into())).await.is_err() {
                    continue;
                }
                if conn_tx.send(()).is_err() {
                    return;
                }
                loop {
                    tokio::select! {
                        hup = closer_rx.recv() => {
                            if hup.is_none() { return }
                            break; // ws 出作用域即断连
                        }
                        out = reply_rx.recv() => {
                            let Some(m) = out else { return };
                            if ws.send(WsMsg::Binary(sync_proto::encode(&m).into())).await.is_err() {
                                break;
                            }
                        }
                        frame = ws.next() => {
                            let Some(Ok(WsMsg::Binary(b))) = frame else { break };
                            match sync_proto::decode::<ClientMsg>(&b) {
                                Ok(ClientMsg::Send { n, to, blob, .. }) => {
                                    if sent_tx.send((n, to, blob)).is_err() { return }
                                }
                                Ok(ClientMsg::Ping) => {
                                    let pong = sync_proto::encode(&ServerMsg::Pong);
                                    if ws.send(WsMsg::Binary(pong.into())).await.is_err() { break }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        });
        FakeRelay { addr, task, sent, conns, reply, closer }
    }

    const XFER_ONE: &str = "01TRANSFER0000000000000001";
    const XFER_TWO: &str = "01TRANSFER0000000000000002";

    /// 图字节帧的简写。直接 `{msg:?}` 会把 256 KiB 的块**整个**打进失败输出(实测一次
    /// 1.1 MB),失败信息反而没法看。
    fn blob_brief(msg: &Msg) -> String {
        match msg {
            Msg::BlobChunk { idx, last, data, .. } => {
                format!("块#{idx}{}({} 字节)", if *last { " 末块" } else { "" }, data.len())
            }
            Msg::BlobDeny { transfer, .. } => format!("deny({transfer})"),
            other => format!("{other:?}"),
        }
    }

    /// 一台假中转 + 一台连上去的真 runtime,停在「已鉴权、会话仪式已开跑」。
    async fn relay_rig(tag: &str, seed: u8) -> (FakeRelay, LanRig, SyncConfig) {
        relay_rig_beat(tag, seed, Duration::from_secs(HEARTBEAT_SECS)).await
    }

    /// 同上,心跳周期由调用方给(见 [`run_with_handoff`] 那段 ⚠)。
    async fn relay_rig_beat(tag: &str, seed: u8, beat: Duration) -> (FakeRelay, LanRig, SyncConfig) {
        let mut relay = fake_relay().await;
        let rig = lan_rig_at_beat(tag, seed, &relay.url(), beat);
        let cfg = {
            let conn = rig.db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        timeout(Duration::from_secs(5), relay.conns.recv())
            .await
            .expect("客户端该连上来")
            .expect("通道活着");
        (relay, rig, cfg)
    }

    /// 本机贴一张 `chunks` 块的图,并冒充 `peer` 发一枚 `BlobPull` 进来。
    fn attach_and_pull(
        rig: &LanRig,
        relay: &FakeRelay,
        cfg: &SyncConfig,
        peer: &str,
        transfer: &str,
        chunks: usize,
    ) -> String {
        // 夹具自检:transfer 不合 ULID 形态会被响亮拒帧(263 顺带封的放大面),于是一枚
        // 块都不发 —— 那会让下面的用例以「没收到块」的形式假装通过。
        ulid::Ulid::from_string(transfer).expect("夹具的 transfer 得是合法 ULID");
        let bytes: Vec<u8> = (0..(chunks * 256 * 1024)).map(|i| (i % 251) as u8).collect();
        let img = {
            let mut conn = rig.db.lock().unwrap();
            let mut clk = rig.clock.lock().unwrap();
            let item = notes::capture(&mut conn, &mut clk, "带图").unwrap();
            images::attach(&mut conn, &mut clk, &item, &bytes, "image/png").unwrap().0
        };
        relay.deliver(cfg, peer, &Msg::BlobPull { image_id: img.clone(), transfer: transfer.into() });
        img
    }

    /// **拆循环的本体**:一次只发一枚数据帧,下一块由 Ack 驱动。
    ///
    /// 旧代码在这一刻会把整张图一口气推上线(32 MiB = 128 枚),期间协调者一步都走不动
    /// —— Ack/Nack 处理不了、心跳跑不了、LAN 的 `last_rx` 不刷,下一次 `lan_beat` 就按
    /// 90s 把健康的直连链误判死。**上下界同断**:不许一次多发(窗口),也不许少发(下界
    /// 三块都要到)—— 只断上界的话「整个功能坏掉」照样绿。
    #[tokio::test]
    async fn the_relay_window_sends_one_chunk_per_ack_not_the_whole_image() {
        let (mut relay, rig, cfg) = relay_rig("relay-one-per-ack", 71).await;
        attach_and_pull(&rig, &relay, &cfg, PEER_ONE, XFER_ONE, 3);

        let mut seen = vec![];
        for want in 0..3u32 {
            let (n, to, msg) = relay
                .next_blob(&cfg, 4000)
                .await
                .unwrap_or_else(|| panic!("该有第 {want} 块"));
            let Msg::BlobChunk { idx, last, .. } = msg else { panic!("该是块,实见 {}", blob_brief(&msg)) };
            assert_eq!(to, PEER_ONE);
            assert_eq!(idx, want, "块必须按序来");
            assert_eq!(last, want == 2, "末块标记");
            assert!(
                relay.next_blob(&cfg, 300).await.is_none(),
                "窗口占着时不许再发第二枚数据帧(第 {want} 块的回执还没回)"
            );
            relay.ack(n);
            seen.push(idx);
        }
        assert_eq!(seen, vec![0, 1, 2], "三块都得发出来(下界)");
        rig.task.abort();
        relay.task.abort();
    }

    /// **轮转出队是活性必需不是公平好看**:两台对端同时取图时块必须交替。让先来的那张
    /// 独占窗口跑到底的话,排在后面那台对端的 `Pull` 有 60s 无进展死线,会先被它自己判死
    /// 然后回清单重问 —— 白跑一整轮。
    #[tokio::test]
    async fn two_peers_pulling_at_once_get_their_chunks_interleaved() {
        let (mut relay, rig, cfg) = relay_rig("relay-round-robin", 72).await;
        attach_and_pull(&rig, &relay, &cfg, PEER_ONE, XFER_ONE, 2);
        attach_and_pull(&rig, &relay, &cfg, PEER_TWO, XFER_TWO, 2);

        let mut order = vec![];
        for _ in 0..4 {
            let (n, to, msg) = relay.next_blob(&cfg, 4000).await.expect("四枚块");
            let Msg::BlobChunk { idx, .. } = msg else { panic!("该是块,实见 {}", blob_brief(&msg)) };
            order.push((to, idx));
            relay.ack(n);
        }
        assert_eq!(
            order,
            vec![
                (PEER_ONE.to_string(), 0),
                (PEER_TWO.to_string(), 0),
                (PEER_ONE.to_string(), 1),
                (PEER_TWO.to_string(), 1),
            ],
            "块必须在两台对端之间交替(实见 {order:?})"
        );
        rig.task.abort();
        relay.task.abort();
    }

    /// **窗口占着的时候又来一枚 `BlobPull`:只入队,不备帧**([`Deck::relay_data_pump`]
    /// 开头那道 `inflight.is_some()` 早返回)。
    ///
    /// 291 的变异对照里这道闸**报了假绿**:拆掉它,`relay_ops_frames_...` 照样全绿 ——
    /// 因为帧发出到 Ack 之间那些用例里根本没有第二个泵调用点,闸没有触发器。真实后果也
    /// 不是「多发一枚帧」:第二枚 pull 走 `serve_blob_relay` → `enqueue` → 泵,拆了闸就
    /// 一路撞上 `arm` 那句响亮错(窗口已占),`?` 穿透到会话循环 = **白断一条会话**。
    ///
    /// 三条判据缺一不可:①在飞那笔不受扰(静默窗口里一枚数据帧都不许多出来)、②**会话
    /// 不重连**(那才是拆闸后的真实症状)、③Ack 之后第二张图**才**被服务(下界——不许
    /// 把它整个丢了,那也是「一枚都没多发」)。
    #[tokio::test]
    async fn a_second_pull_while_the_window_is_armed_is_only_queued() {
        let (mut relay, rig, cfg) = relay_rig("relay-second-pull", 77).await;
        attach_and_pull(&rig, &relay, &cfg, PEER_ONE, XFER_ONE, 2);
        let (n0, to, msg) = relay.next_blob(&cfg, 4000).await.expect("第 0 块");
        assert_eq!(to, PEER_ONE);
        assert!(matches!(msg, Msg::BlobChunk { idx: 0, .. }), "实见 {}", blob_brief(&msg));

        // 窗口正占着(第 0 块的回执还没回)时,第二台对端来取另一张图。
        attach_and_pull(&rig, &relay, &cfg, PEER_TWO, XFER_TWO, 1);
        assert!(
            relay.next_blob(&cfg, 2500).await.is_none(),
            "①窗口占着 = 只入队不备帧(在飞那笔不受扰)"
        );
        // 静默窗口刻意取 2.5s > 重连退避的第一档(1s):拆了闸的话会话此刻已经断了并重连
        // 上来,那是它区别于「正确实现」的唯一即时信号。
        assert!(
            relay.conns.try_recv().is_err(),
            "②会话不许重连 —— 撞上「窗口已占」那句响亮错就会断一条好端端的会话"
        );

        relay.ack(n0);
        let (_, to, msg) =
            relay.next_blob(&cfg, 8000).await.expect("③Ack 之后排队那张图必须被服务");
        assert_eq!(to, PEER_TWO, "轮转出队:回执一到就轮到排队那台");
        assert!(matches!(msg, Msg::BlobChunk { idx: 0, .. }), "实见 {}", blob_brief(&msg));
        rig.task.abort();
        relay.task.abort();
    }

    /// `busy`(§6.1 那张表):**释放窗口 / 不推进游标 / 保留 work / 不许当场重发**。
    ///
    /// 当场重发就是热循环——服务器正忙,同一事件里再推一枚只会再被 busy 掉;续做挂心跳。
    /// 刻意先 Ack 掉第 0 块再让第 1 块撞 busy:这样「下一次泵发出的是第 1 块」能同时排除
    /// 四种坏法——work 丢了(会发给 PEER_TWO)/ 游标错误推进(第 2 块)/ 游标被复位
    /// (第 0 块)/ 当场重发(上面那条 600ms 的静默断言)。**第 0 块撞 busy 验不出这些**,
    /// 那时「重来」与「保留」同形。
    #[tokio::test]
    async fn a_busy_nack_keeps_the_work_and_never_resends_on_the_spot() {
        let (mut relay, rig, cfg) = relay_rig("relay-busy", 73).await;
        attach_and_pull(&rig, &relay, &cfg, PEER_ONE, XFER_ONE, 3);
        let (n0, _, msg) = relay.next_blob(&cfg, 4000).await.expect("第 0 块");
        assert!(matches!(msg, Msg::BlobChunk { idx: 0, .. }), "实见 {}", blob_brief(&msg));
        relay.ack(n0);

        let (n1, _, msg) = relay.next_blob(&cfg, 4000).await.expect("第 1 块");
        assert!(matches!(msg, Msg::BlobChunk { idx: 1, .. }), "实见 {}", blob_brief(&msg));
        relay.nack(n1, err_code::BUSY);
        assert!(
            relay.next_blob(&cfg, 600).await.is_none(),
            "busy 之后不许在同一个 Nack 事件里立即重发(热循环)"
        );

        // 拿另一台对端的取图当「下一次泵」的触发器,看被退回那笔还在不在、停在哪。
        attach_and_pull(&rig, &relay, &cfg, PEER_TWO, XFER_TWO, 1);
        let (_, to, msg) = relay.next_blob(&cfg, 4000).await.expect("下一次泵该动");
        assert_eq!(to, PEER_ONE, "队首仍是被 busy 退回的那笔(work 保留)");
        assert!(
            matches!(msg, Msg::BlobChunk { idx: 1, .. }),
            "游标不许推进:服务器没接手,重发的还得是同一块。实见 {}",
            blob_brief(&msg)
        );
        rig.task.abort();
        relay.task.abort();
    }

    /// `not_online`(§6.1 那张表):取消该笔供流。与 `busy` 的**区分性**断言 —— 同样是
    /// 释放窗口,这一档不许把 work 退回队列,不然「所有 code 一个待遇」也能骗过 busy 那只。
    #[tokio::test]
    async fn a_not_online_nack_cancels_that_serve_instead_of_keeping_it() {
        let (mut relay, rig, cfg) = relay_rig("relay-not-online", 74).await;
        attach_and_pull(&rig, &relay, &cfg, PEER_ONE, XFER_ONE, 3);
        let (n0, _, msg) = relay.next_blob(&cfg, 4000).await.expect("第 0 块");
        assert!(matches!(msg, Msg::BlobChunk { idx: 0, .. }), "实见 {}", blob_brief(&msg));

        relay.nack(n0, err_code::NOT_ONLINE);
        attach_and_pull(&rig, &relay, &cfg, PEER_TWO, XFER_TWO, 1);
        let (_, to, msg) = relay.next_blob(&cfg, 4000).await.expect("下一次泵该动");
        assert_eq!(to, PEER_TWO, "被取消那笔不许回队列(实见发给了 {to})");
        assert!(matches!(msg, Msg::BlobChunk { idx: 0, .. }), "实见 {}", blob_brief(&msg));
        rig.task.abort();
        relay.task.abort();
    }

    /// **会话收场必须释放数据窗口**(§6.1 六轮 H2 —— 这一族里最贵的那条)。
    ///
    /// `tracked` 随会话死,而窗口住 [`EngineSlot`] 跨会话活着:不清的话它永久停在
    /// 「在飞」,重连之后**一枚块都再也发不出去**,而没有任何回执会来解开它。
    ///
    /// 断连刻意用假中转**直接丢连接**而不是 `unknown_device`:后者在 [`Ctx::on_nack`] 里
    /// 自己就清了窗口,验不到 [`session_wrapup`] 那一句 —— 而那一句还欠着「必须排在两个
    /// 早返回之前」的义务(`outs` 为空、栅栏已落都不是漏掉窗口的理由)。判据取「新会话里
    /// 还供得动」:那是窗口真被释放的唯一可观测后果。
    #[tokio::test]
    async fn a_dead_session_releases_the_data_window_for_the_next_one() {
        let (mut relay, rig, cfg) = relay_rig("relay-wrapup-window", 76).await;
        attach_and_pull(&rig, &relay, &cfg, PEER_ONE, XFER_ONE, 3);
        let (_, _, msg) = relay.next_blob(&cfg, 4000).await.expect("第 0 块");
        assert!(matches!(msg, Msg::BlobChunk { idx: 0, .. }), "实见 {}", blob_brief(&msg));

        // 窗口正占着的时候把连接丢掉,回执永远不会来了。
        relay.close();
        timeout(Duration::from_secs(15), relay.conns.recv())
            .await
            .expect("客户端该重连上来")
            .expect("通道活着");

        attach_and_pull(&rig, &relay, &cfg, PEER_TWO, XFER_TWO, 1);
        let (_, to, msg) = relay
            .next_blob(&cfg, 8000)
            .await
            .expect("新会话必须还供得动 —— 等不到块 = 上一条会话把窗口漏在「在飞」了");
        assert_eq!(to, PEER_TWO);
        assert!(matches!(msg, Msg::BlobChunk { idx: 0, .. }), "实见 {}", blob_brief(&msg));
        rig.task.abort();
        relay.task.abort();
    }

    /// `unknown_device` **恒 session-fatal**(§6.1 八轮定形):服务端拿同一个 code 表达
    /// 三件事,其中两件是**发送者自己**的问题,而线上那个 code 一个字节都不带来源 ——
    /// fail-closed。判据取「客户端重新连上来」:会话没收场就不会有第二条连接。
    #[tokio::test]
    async fn an_unknown_device_nack_ends_the_whole_session() {
        let (mut relay, rig, cfg) = relay_rig("relay-unknown-device", 75).await;
        attach_and_pull(&rig, &relay, &cfg, PEER_ONE, XFER_ONE, 3);
        let (n0, _, msg) = relay.next_blob(&cfg, 4000).await.expect("第 0 块");
        assert!(matches!(msg, Msg::BlobChunk { idx: 0, .. }), "实见 {}", blob_brief(&msg));

        relay.nack(n0, err_code::UNKNOWN_DEVICE);
        timeout(Duration::from_secs(10), relay.conns.recv())
            .await
            .expect("会话必须收场并重连(不许只把对端标 down 就接着用同一条会话)")
            .expect("通道活着");
        rig.task.abort();
        relay.task.abort();
    }

    // ---- 中转腿的 ops 那一半(L-d″ 第④笔下半;段由把手夹具直投,理由同 LAN 那族) ----

    /// 拿这台 rig 的 ops 计划表把手(见 [`publish_ops_handle`])。
    fn ops_handle(device: &str) -> Arc<Mutex<ops_serve::OpsWorks>> {
        OPS_HANDLES.lock().unwrap().get(device).cloned().expect("会话仪式跑过就该挂上了")
    }

    /// 往某个 target 的计划里塞一段补洞 work(= 生产上那三个入口做的事)。
    fn seed_ops_work(device: &str, target: &str, origin: &str, from_seq: i64) {
        let h = ops_handle(device);
        let mut w = h.lock().unwrap();
        // 刻度给足:同一个 target 连塞两段时第二段会撞补洞冷却,那不是本组要验的事。
        let tick = 1_000 + w.len() as u64 * 100;
        assert_eq!(
            w.on_want(target, origin, from_seq, tick).admit,
            ops_serve::Admit::Ok,
            "夹具塞的 work 必须被收下"
        );
    }

    /// 塞几枚**别的 origin** 的 op 进 oplog(本机 origin 那半另有专测)。
    ///
    /// `pad` = 正文填充字节:撑到切帧字节尺([`MAX_OPS_FRAME_BYTES`] 256 KiB)之上,
    /// 一段就切得出**多枚帧** —— 轮转要验「同一个 target 还有活时也得让位」,一枚帧一个
    /// target 是验不出来的(那时不轮转也照样交替)。
    fn seed_remote_ops(rig: &LanRig, origin: &str, count: i64, pad: usize) {
        let conn = rig.db.lock().unwrap();
        for seq in 1..=count {
            let hlc = crate::clock::Hlc {
                wall_ms: 5_000 + seq as u64,
                counter: 0,
                device_id: origin.into(),
            }
            .encode();
            conn.execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'item', ?3, 'create', ?4, ?5)",
                (
                    ulid::Ulid::new().to_string(),
                    hlc,
                    format!("01ITEM{seq:020}"),
                    format!(
                        r#"{{"content":"第 {seq} 枚{}","created_at":"2026-08-01T00:00:00Z"}}"#,
                        "填".repeat(pad / 3)
                    ),
                    seq,
                ),
            )
            .expect("塞 op");
        }
    }

    /// 下一枚 **ops** 帧(把仪式帧、want、图字节滤掉)。
    async fn next_ops(
        relay: &mut FakeRelay,
        cfg: &SyncConfig,
        ms: u64,
    ) -> Option<(u64, String, String, Vec<i64>)> {
        loop {
            let (n, to, msg) = relay.next_out(cfg, ms).await?;
            if let Msg::Ops { origin, ops } = msg {
                return Some((n, to, origin, ops.iter().map(|o| o.origin_seq).collect()));
            }
        }
    }

    /// 断一次连,等客户端重连上来(新会话仪式会把跨会话保留的活重新泵起来)。
    async fn recycle_session(relay: &mut FakeRelay) {
        relay.close();
        timeout(Duration::from_secs(15), relay.conns.recv())
            .await
            .expect("客户端该重连上来")
            .expect("通道活着");
    }

    /// **ops 也进那一枚全局窗口:一次一枚、Ack 驱动下一枚,且 target 之间轮转**
    /// (§6.2 ⑨-4 的规则①②⑤⑥)。
    ///
    /// 上下界同断:窗口占着时不许再出第二枚(上界);三个 target 的六枚都得发出来
    /// (下界)—— 只断上界的话「ops 腿整个不工作」照样绿。
    ///
    /// ⚠ **每个 target 刻意留两枚帧的活**(padded op 撑过切帧字节尺):一枚一个 target 时
    /// 「轮转」是撞出来的 —— 服完就没活了,不轮转也照样换人。有第二枚在手,`A A B B` 与
    /// `A B A B` 才分得开,轮转游标才成为可证伪的规则。**BROADCAST 也当一个普通 target**
    /// 排在里面(规则②:它与定向同级、没有特权;字典序 `*` 最小故它打头)。
    #[tokio::test]
    async fn relay_ops_frames_go_one_per_ack_and_rotate_between_targets() {
        let (mut relay, rig, cfg) = relay_rig("relay-ops-rr", 81).await;
        seed_remote_ops(&rig, PEER_TWO, 2, 150_000);
        for t in [BROADCAST, PEER_ONE, PEER_THREE] {
            seed_ops_work(&rig.device, t, PEER_TWO, 1);
        }
        // 触发:换一条会话 —— 新仪式会把跨会话保留的 work 重新泵起来(§6.2 ⑨-8 第三条)。
        recycle_session(&mut relay).await;

        let mut order = vec![];
        for i in 0..6 {
            let (n, to, origin, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("该有 ops 帧");
            assert_eq!(origin, PEER_TWO, "供的是那台 origin 的 op");
            assert_eq!(seqs.len(), 1, "撑过字节尺 = 一帧一枚 op(第 {i} 枚实见 {seqs:?})");
            assert!(
                next_ops(&mut relay, &cfg, 400).await.is_none(),
                "窗口占着时不许再发第二枚数据帧(第 {i} 枚的回执还没回)"
            );
            relay.ack(n);
            order.push((to, seqs[0]));
        }
        // 判据写成**轮转的形状**而不是一串固定的名字:起点由上一条会话留下的游标定
        // (它跨会话存活,而收场那一枚被回滚重发),那是活的 runtime 的正常事实、不是被测
        // 行为。真正要钉死的是两件——**第一圈里三个 target 各恰一枚**(有人连拿两枚 =
        // 游标没前移,排在后面那台就被饿着),**第二圈照同一个顺序**。
        let round: Vec<String> = order[..3].iter().map(|(t, _)| t.clone()).collect();
        let mut uniq = round.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), 3, "第一圈里三个 target 各一枚,实见 {order:?}");
        assert!(order[..3].iter().all(|(_, s)| *s == 1), "第一圈全是第 1 枚,实见 {order:?}");
        assert!(order[3..].iter().all(|(_, s)| *s == 2), "第二圈全是第 2 枚,实见 {order:?}");
        assert_eq!(
            order[3..].iter().map(|(t, _)| t.clone()).collect::<Vec<_>>(),
            round,
            "第二圈必须照同一个顺序绕(实见 {order:?})"
        );
        rig.task.abort();
        relay.task.abort();
    }

    /// **ops 与 blob 按 1:1 轮转**(§6.1 M3):上一件归谁,下一件就归另一类。
    ///
    /// 判据取「四枚**窗口**帧的类别恰好交替」。少了这条,一张 128 块的大图能把 op 追赶
    /// 饿死整轮,反过来一份长追赶计划也能让图字节一块都发不出去。
    ///
    /// ⚠ **只认 origin 是那台远端的 ops 帧**(首版在这里假绿了一次):`attach_and_pull`
    /// 自己要写本机条目与图,于是会话仪式的 `outbound` 也会推一枚 `Msg::Ops{origin:本机}`
    /// —— 那一枚走的是旧的 `Sent::OwnOps` 路、**一个窗口都没占过**,把它算进来的话
    /// 「交替」是撞出来的,不是窗口轮转出来的。两个 target 各一枚,才保证窗口真出两枚。
    #[tokio::test]
    async fn relay_data_window_alternates_between_ops_and_blob() {
        let (mut relay, rig, cfg) = relay_rig("relay-ops-blob-1to1", 82).await;
        seed_remote_ops(&rig, PEER_TWO, 6, 0);
        seed_ops_work(&rig.device, PEER_ONE, PEER_TWO, 1);
        seed_ops_work(&rig.device, PEER_THREE, PEER_TWO, 1);
        attach_and_pull(&rig, &relay, &cfg, PEER_ONE, XFER_ONE, 2);

        let mut kinds = vec![];
        for _ in 0..12 {
            let Some((n, _, msg)) = relay.next_out(&cfg, 8000).await else { break };
            match &msg {
                Msg::Ops { origin, .. } if origin == PEER_TWO => kinds.push("ops"),
                Msg::BlobChunk { .. } => kinds.push("blob"),
                // 仪式帧 / 本机 origin 的 outbound:不占窗口,照 Ack 但不计数。
                _ => {}
            }
            relay.ack(n);
            if kinds.len() == 4 {
                break;
            }
        }
        assert!(
            kinds == ["ops", "blob", "ops", "blob"] || kinds == ["blob", "ops", "blob", "ops"],
            "两类必须严格交替,实见 {kinds:?}"
        );
        rig.task.abort();
        relay.task.abort();
    }

    /// `busy`(§6.1 那张表的 `ServeOps` 行):**释放窗口 / 不推进游标 / 保留 work /
    /// 不许当场重发**。
    ///
    /// 判据取「下一次泵发出的还是同一段」:游标错误推进(第二段)、work 丢了(什么都不发)、
    /// 当场重发(那 400ms 的静默断言)三种坏法一次排除。
    #[tokio::test]
    async fn a_busy_nack_on_ops_keeps_the_work_and_never_advances_the_cursor() {
        let (mut relay, rig, cfg) = relay_rig("relay-ops-busy", 83).await;
        seed_remote_ops(&rig, PEER_TWO, 2, 0);
        seed_ops_work(&rig.device, PEER_ONE, PEER_TWO, 1);
        recycle_session(&mut relay).await;

        let (n, to, _, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("第一枚 ops 帧");
        assert_eq!((to.as_str(), &seqs[..]), (PEER_ONE, &[1, 2][..]));
        relay.nack(n, err_code::BUSY);
        assert!(
            next_ops(&mut relay, &cfg, 400).await.is_none(),
            "同一个 Nack 事件里立即重发就是热循环"
        );
        // 续做挂心跳(30s)太慢,这里用「新会话把保留下来的 work 重新泵起来」当观测口。
        //
        // ⚠ 这一句同时是**「让位只在本会话内成立」的判据**(二轮 H):`busy` 之后本 target
        // 从中转腿的候选枚举里摘掉一拍,若那一格带过会话边界,新会话的第一枚泵就会莫名
        // 跳过它 —— 这里会直接超时。
        recycle_session(&mut relay).await;
        let (_, to, _, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("work 必须还在");
        assert_eq!((to.as_str(), &seqs[..]), (PEER_ONE, &[1, 2][..]), "游标一步都不许进");
        rig.task.abort();
        relay.task.abort();
    }

    /// **`busy` 之后直连真能接手,而中转不许把票抢回去**(codex 实现审二轮 H)。
    ///
    /// 要断的那条路:`busy` 释放窗口之后,下一次唤醒里 `relay_data_pump` 是**同步**跑在摇
    /// LAN 铃之前的,当场就把这枚在飞位重新占回去 —— `notify_one` 不产生调度检查点。于是
    /// 「中转会话稳定在、数据面持续 busy、直连稳定可用」时,LAN 确定性地永远只拿得到
    /// `Occupied`。而 `busy` 在服务端是**账户/全局字节预算不足**,一台慢对端把信箱顶满就
    /// 能持续几分钟,不是一瞬的抖动。
    ///
    /// 判据三格,**第三格才是「让位」本身**:
    /// * 直连接上时中转已攥着票,故它只拿得到 `Occupied`(在飞位只有一枚);
    /// * `busy` 之后直连收到**同一段**(游标没动,票真交出去了);
    /// * **后两段也全走直连,中转一枚都不许再出** —— 少了让位,直连每提交一枚就摇一次铃,
    ///   协调者那趟 sweep 会让中转把下一段抢回去,于是要么线上多出一枚中转 ops 帧、要么
    ///   直连在第二段上拿到 `Occupied` 干等。
    ///
    /// 三段而不是一段:一段的话直连拿完就没活了,「中转没再发」与「压根没得发」同形。
    ///
    /// **「谁先拿到票」刻意做成结构事实而不是竞速**:先在**没有直连腿**的时候让中转拿走
    /// 第一段,再把链接上去。反过来写(先建链再触发)就是在断一个由调度决定的结果 ——
    /// 而设计上那本来就是「谁先武装谁做」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_busy_relay_yields_the_directed_work_to_the_lan_leg() {
        let (mut relay, rig, cfg) = relay_rig("relay-ops-busy-lan", 89).await;
        // 三枚撑过切帧字节尺的 op = 三段,一段一枚帧。
        seed_remote_ops(&rig, PEER_TWO, 3, 150_000);
        seed_ops_work(&rig.device, PEER_ONE, PEER_TWO, 1);
        recycle_session(&mut relay).await;

        // ① 此刻还没有直连腿,中转必然拿到票。
        let (n, to, _, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("中转先发一枚");
        assert_eq!((to.as_str(), &seqs[..]), (PEER_ONE, &[1][..]));

        // 票攥在中转手上时把直连接进来:它醒来只拿得到 `Occupied`,一枚 ops 都发不出。
        let (mine, theirs) = tcp_pair().await;
        let mut lan = FakeLink { stream: theirs };
        rig.handoff.send(adopted(PEER_ONE, 1, mine)).await.expect("移交");
        wait_until("直连认下", || rig.status.lock().unwrap().lan_peers == 1).await;
        let (_, _, hello) = lan.next_msg(&cfg, 4000).await.expect("建链的定向 Hello");
        assert!(matches!(hello, Msg::Hello { .. }), "建链先发 Hello,实见 {hello:?}");
        assert!(lan.next_msg(&cfg, 300).await.is_none(), "在飞位只有一枚,直连此刻拿不到");

        // ② `busy` → 让位 + 摇直连的铃:同一段当场落到直连上。
        relay.nack(n, err_code::BUSY);
        for want in 1..=3i64 {
            let (_, to, msg) = lan
                .next_msg(&cfg, 8000)
                .await
                .unwrap_or_else(|| panic!("第 {want} 段该走直连"));
            assert_eq!(to, PEER_ONE);
            let Msg::Ops { origin, ops } = msg else { panic!("该是 ops 帧,实见 {msg:?}") };
            assert_eq!(origin, PEER_TWO);
            assert_eq!(
                ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>(),
                vec![want],
                "游标一步不许进:被 Nack 那一段得原样交给直连"
            );
        }

        // ③ 整段追赶跑完,中转一枚 ops 都不该再出(心跳还有 30s,让位没到期)。
        assert!(
            next_ops(&mut relay, &cfg, 600).await.is_none(),
            "让位期间中转不许把票抢回去"
        );
        rig.task.abort();
        relay.task.abort();
    }

    /// **让位只让一拍:没有直连腿时,下一拍心跳照旧由中转重试**(二轮 H 的另一半)。
    ///
    /// 让位是「本拍改由直连取」,不是永久偏好。清位排在同一拍 `on_tick` 里、**早于**那趟
    /// sweep,故这条路退化成原来的「busy 保留 work,等心跳 relay 重试」——一拍都不多。
    /// 少了那一句清位,一台没有直连腿的设备撞一次 `busy` 就永久停摆(会话不断的话谁也
    /// 收不回那一格)。
    ///
    /// 心跳压到 250ms(见 [`run_with_handoff`]):真等 30s 两拍就是一分钟。
    #[tokio::test]
    async fn the_yield_lasts_one_beat_so_a_lanless_peer_is_not_slowed_down() {
        let (mut relay, rig, cfg) =
            relay_rig_beat("relay-ops-busy-nolan", 90, Duration::from_millis(250)).await;
        seed_remote_ops(&rig, PEER_TWO, 2, 0);
        seed_ops_work(&rig.device, PEER_ONE, PEER_TWO, 1);
        recycle_session(&mut relay).await;

        let (n, to, _, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("第一枚 ops 帧");
        assert_eq!((to.as_str(), &seqs[..]), (PEER_ONE, &[1, 2][..]));
        relay.nack(n, err_code::BUSY);

        // 没有直连腿:让位这一拍谁也接不走,下一拍心跳收回让位,中转必须自己重试同一段。
        let (_, to, _, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("下一拍心跳必须重试");
        assert_eq!((to.as_str(), &seqs[..]), (PEER_ONE, &[1, 2][..]), "游标一步都不许进");
        rig.task.abort();
        relay.task.abort();
    }

    /// **本机 origin 那一帧:Ack 到达必须先把 `last_pushed` 落库、成功之后才提交 work
    /// 游标**(§6.1 + §6.2 ⑨-1)。
    ///
    /// 顺序反了就会出现「游标说发过了、库说没接手」:下次会话仪式从持久 `last_pushed`
    /// 重载,那段 op 再没有人发。判据取库里那一行 —— 它是这条顺序唯一的持久证据。
    ///
    /// **第⑤笔起本机 origin 只剩这一条路**:旧的 `Sent::OwnOps`(会话仪式当场物化本机帧)
    /// 已删,本机 origin 与别的 target 一样进那枚全局窗口 —— 故第④笔那套「两条路都在,
    /// 得刻意不 Ack 仪式那一枚才分得开」的绕法作废了(留着反而验不到东西:窗口只有一枚,
    /// 不 Ack 第一枚就永远等不到第二枚)。
    ///
    /// **仍然要断的那一格是「没 Ack 就不许动水位」**:少了它,「登记即落库」这种坏法照样
    /// 绿 —— 而它正是这条顺序反过来的样子。
    #[tokio::test]
    async fn acking_an_own_origin_ops_frame_persists_the_pushed_watermark() {
        let (mut relay, rig, cfg) = relay_rig("relay-ops-own-origin", 84).await;
        // 本机真写四条,origin 就是本机 device_id。
        {
            let mut conn = rig.db.lock().unwrap();
            let mut clk = rig.clock.lock().unwrap();
            for i in 1..=4 {
                notes::capture(&mut conn, &mut clk, &format!("本机第 {i} 条")).unwrap();
            }
        }
        // 持久水位钉在 2:会话仪式的保守合并(§6.2 ⑦)据此把 3-4 重新登记进 BROADCAST。
        {
            let conn = rig.db.lock().unwrap();
            meta_put(&conn, "last_pushed", "2").unwrap();
        }
        recycle_session(&mut relay).await;

        let (n, to, origin, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("本机那一枚");
        assert_eq!((to.as_str(), origin.as_str()), (BROADCAST, cfg.device_id.as_str()));
        // **段头刻意不断死**:这一枚可能是 `[3,4]`(仪式按持久水位 2 重推),也可能是
        // `[1,2,3,4]` —— 起库那会儿写通知先到,`outbound` 已按当时的 0 登记过一段
        // `[1..]`,保守合并只会把段头**往低了取**。两种都合规,而本测要断的是水位落库的
        // **顺序**,与段头无关;断死段头等于让判据挂在一个与被测那件事无关的竞态上。
        assert_eq!(seqs.last(), Some(&4), "这一枚承载到 4,故它的 Ack 该把水位推到 4:{seqs:?}");
        assert!(seqs.contains(&3), "未 ack 的 3 必须在里面(不然验不到重推):{seqs:?}");
        {
            let conn = rig.db.lock().unwrap();
            assert_eq!(read_last_pushed(&conn).unwrap(), 2, "没 Ack 就不许动水位");
        }
        relay.ack(n);
        // Ack 之后水位必须落到库里(落库发生在协调者那一侧,轮询等它)。
        let mut seen = -1;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            seen = {
                let conn = rig.db.lock().unwrap();
                read_last_pushed(&conn).unwrap()
            };
            if seen >= 4 {
                break;
            }
        }
        assert_eq!(seen, 4, "Ack 之后 last_pushed 必须落到 4(实见 {seen})");
        rig.task.abort();
        relay.task.abort();
    }

    /// **`unknown_device` 的跨代探针**(§6.1 八轮 H1):首次不取消工作、只记代次并收场;
    /// 下一代允许重试一次;**同一 target 在更晚一代再次 unknown → 取消该份 work**。
    ///
    /// 少了第三步就是永久重连循环(work 跨会话存活 → 重连续做 → 又 unknown);少了第一步
    /// 则「被旧连接顶替」这种最常见的一档会白丢一份同步工作。
    #[tokio::test]
    async fn unknown_device_on_ops_probes_once_across_generations_then_cancels() {
        let (mut relay, rig, cfg) = relay_rig("relay-ops-unknown", 85).await;
        seed_remote_ops(&rig, PEER_TWO, 2, 0);
        seed_ops_work(&rig.device, PEER_ONE, PEER_TWO, 1);
        recycle_session(&mut relay).await;

        // 第一代:撞 unknown → 会话收场,**work 照留**。
        let (n, to, _, _) = next_ops(&mut relay, &cfg, 8000).await.expect("第一代那一枚");
        assert_eq!(to, PEER_ONE);
        relay.nack(n, err_code::UNKNOWN_DEVICE);
        timeout(Duration::from_secs(10), relay.conns.recv())
            .await
            .expect("unknown 恒 session-fatal")
            .expect("通道活着");

        // 第二代:同一份 work 重试一次(**这就是「不取消」的可观测后果**)。
        let (n, to, _, _) =
            next_ops(&mut relay, &cfg, 8000).await.expect("首次 unknown 不许取消工作");
        assert_eq!(to, PEER_ONE);
        relay.nack(n, err_code::UNKNOWN_DEVICE);
        timeout(Duration::from_secs(10), relay.conns.recv())
            .await
            .expect("第二次同样收场")
            .expect("通道活着");

        // 第三代:这份 work 必须已被取消 —— 再有 ops 帧发给它就是永久重连循环。
        assert!(
            next_ops(&mut relay, &cfg, 3000).await.is_none(),
            "更晚一代仍 unknown 之后必须取消该 target 的 work"
        );
        assert_eq!(
            ops_handle(&rig.device).lock().unwrap().unknown_since(PEER_ONE).is_some(),
            true,
            "怀疑标记留着(下一枚正面证据才清)"
        );

        // **正面证据不止 `ServeOps` 一种**(codex 实现审一轮 M1)。这一段原本只写在注释里
        // 「下一枚正面证据才清」,而实现只接了 `ServeOps` 那一支 —— 于是一台**明明还在册**
        // 的对端(它的图字节请求正被正常服务着)会一直背着旧怀疑,下一次 sender-side 的
        // `unknown_device` 就被误算成第二击,把追赶 work 白白取消掉。
        //
        // 这里刻意用**图字节**那条路:此刻 PEER_ONE 的 ops work 已被上一步取消,ops 腿
        // 一枚都产不出来,故拿到窗口的必然是 `Sent::ServeBlob{to: PEER_ONE}` —— 判据不会
        // 被「其实是 ops 那支清的」污染。
        attach_and_pull(&rig, &relay, &cfg, PEER_ONE, XFER_ONE, 1);
        let (n, to, msg) = relay.next_blob(&cfg, 8000).await.expect("图字节那一枚");
        assert_eq!(to, PEER_ONE);
        assert!(matches!(msg, Msg::BlobChunk { idx: 0, .. }), "实见 {}", blob_brief(&msg));
        relay.ack(n);
        let mut cleared = false;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cleared = ops_handle(&rig.device).lock().unwrap().unknown_since(PEER_ONE).is_none();
            if cleared {
                break;
            }
        }
        assert!(cleared, "同 target 的图字节 Ack 一样证明它在册,怀疑标必须清");
        rig.task.abort();
        relay.task.abort();
    }

    /// **定向控制帧的回执一样是阳性证据**(codex 实现审二轮 M1)。
    ///
    /// 一轮我按 `Sent` 变体认 target,而定向 Hello / Want 记成**不带 target** 的
    /// `ReconcileCtl` —— 于是「在线缺钥索要」那枚定向 Hello 被服务器接手之后,那台明明
    /// 在册,怀疑标却还挂着,下一次 sender-side 的 `unknown_device` 就被误算成第二击。
    /// 现在 target 由 `send_envelope` **一处**存,与它是什么 `Sent` 无关。
    ///
    /// 那枚定向 Hello 走的是生产正路:服务器说 PEER_ONE 上线、而本机没有它的通告缓存 →
    /// `lan_hello_if_key_missing` 定向回一枚(§2 收敛触发②)。怀疑标则由夹具直接挂上
    /// ——本测要证的是**清**那一侧,挂的那一侧另有 `unknown_device_on_ops_...` 专测。
    #[tokio::test]
    async fn a_directed_control_frame_ack_also_clears_the_unknown_mark() {
        let (mut relay, rig, cfg) = relay_rig("relay-unknown-clear-ctl", 89).await;
        seed_ops_work(&rig.device, PEER_ONE, PEER_TWO, 1);
        assert_eq!(
            ops_handle(&rig.device).lock().unwrap().note_unknown(PEER_ONE, 1),
            ops_serve::UnknownVerdict::Probed,
            "夹具:先挂上首次怀疑"
        );

        relay
            .reply
            .send(ServerMsg::Peer { device: PEER_ONE.into(), online: true })
            .expect("假中转还活着");
        let hello = loop {
            let (n, to, m) = relay.next_out(&cfg, 8000).await.expect("该有一枚定向 Hello");
            if to == PEER_ONE && matches!(m, Msg::Hello { .. }) {
                break n;
            }
        };
        relay.ack(hello);

        let mut cleared = false;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cleared = ops_handle(&rig.device).lock().unwrap().unknown_since(PEER_ONE).is_none();
            if cleared {
                break;
            }
        }
        assert!(cleared, "定向控制帧的 Ack 一样证明它在册,怀疑标必须清");
        rig.task.abort();
        relay.task.abort();
    }

    /// **会话收场:ops 那一笔要 rollback 而不是提交**(§6.1「未 Ack 的 `ServeOps` 不推进
    /// 游标、退回 pending」)。
    ///
    /// 与 blob 那半刻意不同形:blob 是**作废**等重新 Pull,ops 是**留着重发** —— 它的
    /// 续做态在游标里,而游标只由凭据推进。判据取「新会话里发的还是同一段」。
    #[tokio::test]
    async fn a_dead_session_rolls_back_the_ops_ticket_instead_of_committing_it() {
        let (mut relay, rig, cfg) = relay_rig("relay-ops-wrapup", 86).await;
        seed_remote_ops(&rig, PEER_TWO, 2, 0);
        seed_ops_work(&rig.device, PEER_ONE, PEER_TWO, 1);
        recycle_session(&mut relay).await;

        let (_, _, _, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("第一枚");
        assert_eq!(seqs, vec![1, 2]);
        // 窗口正占着时把连接丢掉:回执永远不会来了。
        recycle_session(&mut relay).await;
        let (_, to, _, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("新会话必须还供得动");
        assert_eq!((to.as_str(), &seqs[..]), (PEER_ONE, &[1, 2][..]), "同一段重发,游标没进");
        rig.task.abort();
        relay.task.abort();
    }

    /// 下一枚**广播 Hello** 的回执号(别的帧一概滤掉)。等不到就回 `None`。
    async fn next_broadcast_hello(relay: &mut FakeRelay, cfg: &SyncConfig, ms: u64) -> Option<u64> {
        loop {
            let (n, to, msg) = relay.next_out(cfg, ms).await?;
            if matches!(msg, Msg::Hello { .. }) && to == BROADCAST {
                return Some(n);
            }
        }
    }

    /// **`ReconcileCtl` 三件同提交**的头两件:Hello 归它这一类,`busy` 只置一枚位,
    /// **只有它的 Ack 才清债**(§6.1 九轮 H1)。
    ///
    /// **看四拍**才把三种坏法一次分开(291 收尾加严,上一版只看两拍):
    /// * 债根本没记 → 第一拍就没有重建;
    /// * **「构造成功 / `send_client` 返回成功」就算还债** → 第二拍不再重建;
    /// * 位形同虚设、每拍无条件重发 → Ack 之后还在发。
    ///
    /// ⚠ 上一版在中间那格是**假绿**:它一拿到重建的那枚就 Ack,而「发出去即清债」的坏法
    /// 在那条时间线上与正确实现逐帧同形 —— 债的存活期从没被观测过。加的这一格就是
    /// 「**不给回执**,看它还认不认这笔债」。
    ///
    /// 心跳周期由 [`relay_rig_beat`] 压到毫秒级(生产 30s,四拍真等就是两分钟)。压周期
    /// 安全的理由要自己核:本用例一枚 `BlobPull` 都没有,故按拍计数的拉流死线掺不进来;
    /// 静默判死看的是真实耗时,不受影响。
    #[tokio::test]
    async fn a_busy_hello_sets_the_debt_and_only_its_ack_clears_it() {
        let (mut relay, rig, cfg) =
            relay_rig_beat("relay-ctl-debt", 87, Duration::from_millis(250)).await;
        // 会话仪式那枚广播 Hello:撞 busy。
        let (n, to, msg) = relay.next_out(&cfg, 8000).await.expect("仪式 Hello");
        assert!(matches!(msg, Msg::Hello { .. }), "仪式第一枚是 Hello,实见 {msg:?}");
        assert_eq!(to, BROADCAST);
        relay.nack(n, err_code::BUSY);

        // 第一拍:债挂着 → 必须重新构造一枚广播 Hello。旧代码里它落进 `Sent::Other` 被
        // 兜底吞掉,而 Hello 不周期发送,那枚水位图就永远出不去。
        let first = next_broadcast_hello(&mut relay, &cfg, 8000)
            .await
            .expect("债挂着时心跳必须重发一枚广播 Hello");
        // 第二拍:**刻意不 Ack**。构造成功了、写成功了、服务器一个字没接 —— 债照旧挂着,
        // 必须再来一枚。
        let second = next_broadcast_hello(&mut relay, &cfg, 8000)
            .await
            .expect("没拿到 Ack 就不算还债:下一拍必须再重建一枚");
        assert_ne!(first, second, "两拍该是两枚不同的帧");
        relay.ack(second);

        // 其后若干拍:债已清,不该再无端重发(**只有它的 Ack 才清**这条的另一半)。
        // 静默窗口取 2s = 8 拍,远宽于「每拍必发」那种坏法露头所需。
        assert!(
            next_broadcast_hello(&mut relay, &cfg, 2000).await.is_none(),
            "Ack 之后债就清了,不该再重发"
        );
        rig.task.abort();
        relay.task.abort();
    }

    /// **只有广播 Hello 还得动这笔债**(codex 实现审一轮 H1)。
    ///
    /// 一轮的形是无参数的 `Sent::ReconcileCtl` + 「任一该类别的 Ack 都清位」,而 Hello 与
    /// Want **全归这一类** —— 于是这条真实可达的交错把债静默吞掉:广播 Hello 撞 busy 置债
    /// → 心跳重建之前一枚普通 Want 被 Ack → 债被它清掉 → 那枚水位图**永不重建**
    /// (Hello 不周期发送,只能等偶然重连)。我当时判「分多了最坏也就多发一枚 Hello」,
    /// 那只算了**置债**那一侧;同一个放宽在**清债**那一侧是**丢**。
    ///
    /// 时序刻意排成「先把两枚帧都拿到手,再 Nack 置债、随即 Ack 那枚 Want」:置债之前
    /// 心跳一枚 Hello 都不产(`reconcile_tick` 头一句就是没债即返回),故置债之后再冒出来的
    /// 广播 Hello 只可能是重建的那枚。**要看到两枚**——万一有一枚恰好挤在置债与 Ack 之间
    /// 那几微秒里产出,它也解释不了第二枚。
    #[tokio::test]
    async fn only_a_broadcast_hello_can_clear_the_reconcile_debt() {
        let (mut relay, rig, cfg) =
            relay_rig_beat("relay-ctl-debt-scope", 88, Duration::from_millis(250)).await;
        let (ritual, to, msg) = relay.next_out(&cfg, 8000).await.expect("仪式 Hello");
        assert!(matches!(msg, Msg::Hello { .. }), "仪式第一枚是 Hello,实见 {msg:?}");
        assert_eq!(to, BROADCAST);

        // 造一枚 Want 出来走的是**引擎的正路**:喂一段带洞的 op(我方水位 0、来的是第 5 枚),
        // 重排缓冲认出缺口就会发 `Msg::Want`。夹具不硬塞帧 —— 塞的话验的是夹具不是接线。
        relay.deliver(
            &cfg,
            PEER_ONE,
            &Msg::Ops {
                origin: PEER_TWO.into(),
                ops: vec![crate::replay::RemoteOp {
                    op_id: ulid::Ulid::new().to_string(),
                    hlc: crate::clock::Hlc {
                        wall_ms: 9_000,
                        counter: 0,
                        device_id: PEER_TWO.into(),
                    }
                    .encode(),
                    entity: "item".into(),
                    entity_id: "01ITEMGAP0000000000000001".into(),
                    kind: "create".into(),
                    payload: serde_json::json!({
                        "content": "带洞的那一枚",
                        "created_at": "2026-08-01T00:00:00Z"
                    }),
                    origin_seq: 5,
                }],
            },
        );
        let want = loop {
            let (n, _, m) = relay.next_out(&cfg, 8000).await.expect("缺口必须逼出一枚 Want");
            if matches!(m, Msg::Want { .. }) {
                break n;
            }
        };

        relay.nack(ritual, err_code::BUSY); // 置债
        relay.ack(want); // 普通 Want 的 Ack —— **不许**算还债

        for i in 0..2 {
            assert!(
                next_broadcast_hello(&mut relay, &cfg, 8000).await.is_some(),
                "Want 的 Ack 还不了这笔债:心跳必须照样重建广播 Hello(第 {i} 枚没等到)"
            );
        }
        rig.task.abort();
        relay.task.abort();
    }

    /// **鉴权成功与会话仪式之间那一窗也得自证**(实现审四轮 H1):建连期最后一次栅栏检查
    /// 已过、服务器还没回 `Authed` 时换掉身份,紧随其后的会话仪式(游标复位 + Hello + 缺图
    /// Want + 把本机 op 全量重推)就会整轮被**旧 K_acc** 封了发出去——其中「重推本机 op」
    /// 是 `Auto` 路由,补投面正好把它送上 lan 链,故旧身份幽灵在直连上直接可见。
    #[tokio::test]
    async fn a_recast_between_authed_and_the_session_ritual_is_caught() {
        let (relay, addr, saw_auth, release) = scripted_relay().await;
        let a = lan_rig_at("lan-authed-window", 66, &format!("ws://{addr}"));
        let cfg = {
            let conn = a.db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        // 存量本机 op:会话仪式会把游标复位到「服务器已 ack 位」= 0,故它必被重推一遍。
        {
            let mut conn = a.db.lock().unwrap();
            let mut clk = a.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "仪式会重推的那条").unwrap();
        }
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        a.handoff.send(adopted(PEER_ONE, 1, mine)).await.expect("移交");
        wait_until("直连认下", || a.status.lock().unwrap().lan_peers == 1).await;
        // 建链 Hello 与断网期那一轮先收干净,免得下面的判据把它们当成仪式的产出。
        while peer.next(400).await.is_some() {}

        // 客户端的 Auth 已经发出、`Authed` 还没回来——正是那一窗。此刻换身份,不发 Control。
        timeout(Duration::from_secs(5), saw_auth).await.expect("等到客户端发出 Auth").expect("通道活着");
        {
            let conn = a.db.lock().unwrap();
            meta_put(&conn, "k_acc", &hex(&[9u8; 32])).unwrap();
        }
        let _ = release.send(()); // 放行 Authed

        // 判据同上一条:退役的身份不许再封出任何一帧(仪式若照跑,重推的那条 op 会以旧
        // K_acc 落到这条链上)。
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let Some(wire) = peer.next(500).await else { break };
            if let lan::LanWire::Frame { from, to, blob } = wire {
                assert!(
                    !matches!(open_deliver(&cfg, &from, &to, &blob), Opened::Data(_)),
                    "会话仪式拿旧身份封了帧发出来(旧身份幽灵)"
                );
            }
        }
        assert!(peer.closed(3000).await, "换代之后旧代链必须拆掉");

        a.task.abort();
        relay.abort();
    }

    /// **已鉴权会话里的 lan 三臂也得过闸**(实现审三轮 H1):身份换代之后,只要一枚 lan 帧
    /// 或一次链路移交先于中转帧/心跳/本地写被选中,原先就会用旧 K_acc 解封应用、或以旧身份
    /// 认下一条新链——正是拍板禁止的「单帧跨闸窗」。这里拿「移交」那一路验,因为它最响:新链
    /// 要么拿到定向 Hello,要么当场被关掉,没有中间态。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn recasting_the_identity_blocks_the_lan_arms_of_a_live_session() {
        let addr = start_server().await;
        let a = authed_lan_rig("lan-authed-gate", &format!("ws://{addr}")).await;
        wait_state(&a.status, "online").await;
        let cfg = {
            let conn = a.db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };

        let (m1, t1) = tcp_pair().await;
        let mut first = FakeLink { stream: t1 };
        a.handoff.send(adopted(PEER_ONE, 5, m1)).await.expect("移交首链");
        wait_until("首链认下", || a.status.lock().unwrap().lan_peers == 1).await;
        assert!(first.next_msg(&cfg, 2000).await.is_some(), "建链的定向 Hello");

        // 换 K_acc,**不**碰控制通道;随后只送一次链路移交——会话在着,这一件只可能走 lan
        // 那条臂(中转此刻无帧可来、心跳还有 30 秒)。
        {
            let conn = a.db.lock().unwrap();
            meta_put(&conn, "k_acc", &hex(&[9u8; 32])).unwrap();
        }
        let (m2, t2) = tcp_pair().await;
        let mut late = FakeLink { stream: t2 };
        a.handoff.send(adopted(PEER_TWO, 3, m2)).await.expect("移交换代后那条");

        // 判据取「**旧身份封的帧一枚都不许再出现**」而不是「新链必须被关掉」:后者押的是
        // 「这一件先被 lan 臂选中」这个时序,而中转侧随便来点什么(服务器主动帧 / 心跳)都能
        // 让旧会话先从别的臂落闸、这条移交改由**新**身份的会话认下——那时新链拿到 Hello 是
        // 对的。要守的性质与谁先谁后无关:退役的身份不许再封出任何一帧。
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let Some(wire) = late.next(500).await else { break };
            if let lan::LanWire::Frame { from, to, blob } = wire {
                assert!(
                    !matches!(open_deliver(&cfg, &from, &to, &blob), Opened::Data(_)),
                    "换代之后还有帧是旧 K_acc 封的(旧身份幽灵)"
                );
            }
        }
        // 旧链被拆掉是单调事实(两种时序下都成立):引擎一换代,链路集随撤位一起清。
        assert!(first.closed(3000).await, "换代之后旧代链必须拆掉");

        a.task.abort();
    }

    /// 会话收场那一手也得先自证(实现审三轮 H2):`on_relay_session_down` 产出的重问帧是
    /// **唯一一条不经泵、也不经会话循环**的出口——身份换代之后再投,就是拿旧 K_acc 把帧封了
    /// 发到旧链上。阳性一半(栅栏没落时照发)与阴性一半(落了就不发)必须同测,否则「什么都
    /// 不发」也能骗过阴性那一半。
    #[tokio::test]
    async fn the_session_wrapup_rewants_only_while_the_identity_still_holds() {
        for recast in [false, true] {
            let (db, clock, dir) = test_db(if recast { "wrapup-recast" } else { "wrapup-plain" });
            let cfg = saved_cfg(&db);
            let (mut slot, lan_rx, lan_faults) = EngineSlot::new(BlobPolicy::Full, None);
            {
                let conn = db.lock().unwrap();
                slot.reconcile(&conn, &cfg).unwrap();
                // 中转会话在、且它那条腿上有一笔在飞拉流:收场时它被作废并当场重问。
                let e = slot.get().unwrap();
                e.on_relay_session_up(&conn, 0).unwrap();
                e.plant_pull_for_test(PEER_ONE, "01IMGAAAAAAAAAAAAAAAAAAAAA", Route::Relay);
            }
            let (t, _ctl) = bare_transport(db.clone(), clock, dir);
            let (mut pumps, _handoff) =
                test_pumps(slot, lan_rx, lan_faults, Duration::from_secs(30));
            let (mine, theirs) = tcp_pair().await;
            let mut peer = FakeLink { stream: theirs };
            offline_deck(&t, &cfg, &mut pumps.slot).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
            assert!(peer.next_msg(&cfg, 1000).await.is_some(), "建链的定向 Hello");

            if recast {
                // 换 K_acc:**不**碰控制通道,就看收场那一手自己认不认。
                let conn = db.lock().unwrap();
                meta_put(&conn, "k_acc", &hex(&[9u8; 32])).unwrap();
            }
            session_wrapup(&t, &cfg, &mut pumps).await;

            match peer.next_msg(&cfg, 800).await {
                Some((_, _, Msg::BlobWant { .. })) => {
                    assert!(!recast, "换代之后不许再拿旧身份把重问帧发出去")
                }
                None => assert!(recast, "身份没变时收场重问必须照发(不然阴性那一半是白的)"),
                Some((_, _, other)) => panic!("收场该发重问,实见 {other:?}"),
            }
        }
    }

    /// 建连期也得**自证身份**(实现审二轮 H1):坏中转卡在握手上,期间本库换了 K_acc——纪元
    /// 压实那一路是库自己悄悄换的,**没人 poke 控制通道**。泵这时若还拿旧 `cfg` 干活,就是拿
    /// 旧身份封帧、落库、接纳旧代链的「旧身份幽灵」。判据是**快**:没有栅栏就得等坏中转那 10
    /// 秒拨号超时才轮得到重读配置。
    #[tokio::test]
    async fn a_recast_identity_during_a_stalled_handshake_stops_the_pump() {
        let (stall, addr) = stalled_relay().await;
        let a = lan_rig_at("lan-gate-connecting", 77, &format!("ws://{addr}"));
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        a.handoff.send(adopted(PEER_ONE, 1, mine)).await.expect("移交");
        wait_until("直连认下", || a.status.lock().unwrap().lan_peers == 1).await;
        assert!(matches!(peer.next(2000).await, Some(lan::LanWire::Frame { .. })), "建链的定向 Hello");

        // 换 K_acc,**不**碰控制通道;再给泵一件该做的事(本地写)。
        {
            let conn = a.db.lock().unwrap();
            meta_put(&conn, "k_acc", &hex(&[9u8; 32])).unwrap();
        }
        {
            let mut conn = a.db.lock().unwrap();
            let mut clk = a.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "换代之后写的").unwrap();
        }

        timeout(Duration::from_secs(3), async {
            while a.status.lock().unwrap().lan_peers != 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("栅栏该当场落下 → 回 run 顶重读配置 → 撤位拆链");
        assert!(peer.next(300).await.is_none(), "换代之后旧代链上不许再出现任何帧");

        a.task.abort();
        stall.abort();
    }

    /// 建连期**照收控制面**(实现审二轮 H1 的另一半):坏中转卡在握手上时,`Reconfigured`
    /// 一直积在通道里就等于「配置改了却要等坏中转先超时」。这里刻意只改 `server_url`——身份
    /// 指纹察觉不到它,故本用例验的纯是控制面那条臂。
    #[tokio::test]
    async fn a_reconfigure_during_a_stalled_handshake_is_not_queued_behind_it() {
        let (stall, addr) = stalled_relay().await;
        let a = lan_rig_at("lan-reconf-connecting", 99, &format!("ws://{addr}"));
        wait_until("停在建连上", || a.status.lock().unwrap().state == "connecting").await;

        // 换成必然拒绝连接的地址,再 poke。
        {
            let conn = a.db.lock().unwrap();
            meta_put(&conn, "server_url", "ws://127.0.0.1:1").unwrap();
        }
        a.ctl.send(Control::Reconfigured).await.expect("poke");

        timeout(Duration::from_secs(3), async {
            while a.status.lock().unwrap().state != "offline" {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("三秒内就该重来一轮并落到 offline(等坏中转那 10 秒超时就晚了)");

        a.task.abort();
        stall.abort();
    }

    /// 首次连接就被坏中转卡死时,§5 的断网期定向 Hello 也得照起(实现审二轮 M1):那只计时器
    /// 出生是空的,而「会话收场后置成立刻」在从没连上过的那一路根本轮不到,`until(None)` 又
    /// 永不就绪——于是一枚都不会发。间隔在本用例里压到 300ms(见 [`lan_hello_period`])。
    #[tokio::test]
    async fn the_offline_hello_timer_is_armed_even_before_the_first_session() {
        let _period = HelloPeriodGuard::set(Duration::from_millis(300));
        let (stall, addr) = stalled_relay().await;
        let a = lan_rig_at("lan-hello-armed", 88, &format!("ws://{addr}"));
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        let cfg = {
            let conn = a.db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        a.handoff.send(adopted(PEER_ONE, 1, mine)).await.expect("移交");

        // ①建链那一枚定向 Hello;②断网期那一轮(没修时永不到来)。两枚的先后由调度定。
        for i in 1..=2 {
            let (_, to, msg) = peer
                .next_msg(&cfg, 2000)
                .await
                .unwrap_or_else(|| panic!("第 {i} 枚定向 Hello 没等到"));
            assert_eq!(to, PEER_ONE, "定向发给该对端");
            assert!(matches!(msg, Msg::Hello { .. }), "该是 Hello,实见 {msg:?}");
        }

        a.task.abort();
        stall.abort();
    }

    /// LanReady 撤位 = **拆全部链路**(§4 / 不变量 6 的撤位清单)。撤位后残留的链路是拿
    /// 旧 K_acc 建的,封解不了新纪元的任何一帧,留着只会让选路指向死腿——故它是结构事实
    /// (链路集住在引擎槽里),不是一句「记得也清一下」。
    #[tokio::test]
    async fn revoking_lan_ready_tears_down_every_link() {
        let mut r = deck_rig("lan-revoke");
        let (mine, theirs) = tcp_pair().await;
        let mut peer = FakeLink { stream: theirs };
        let cfg = deck_cfg(&r.db);
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, mine)).await.unwrap();
        assert!(peer.next_msg(&cfg, 500).await.is_some(), "建链的定向 Hello");
        assert_eq!(r.slot.lan.count(), 1);

        // 未配置 / 配置残缺 / 纪元封闸 / 身份换代四档都经它。
        r.slot.retire();
        assert!(r.slot.booting(), "引擎撤台");
        assert_eq!(r.slot.lan.count(), 0, "链路必须一起拆");
        assert!(peer.closed(500).await, "socket 当场关掉");

        // 撤位期再移交一条:fail-closed,引擎都不知道它来过。
        let (m2, t2) = tcp_pair().await;
        let mut late = FakeLink { stream: t2 };
        offline_face(&mut r).lan_adopt(adopted(PEER_ONE, 1, m2)).await.unwrap();
        assert_eq!(r.slot.lan.count(), 0, "LanReady 撤位期不许建链");
        assert!(late.closed(500).await, "撤位期移交来的链路当场关掉");
    }

    /// 通告序号**绑内容**(§2 三时机;L-c2b 二审留给本笔的必守项):同一会话内 listen 没变
    /// 就重用,一变即换号——否则「同一个序号配两份内容」,而收端「更小不收」会把新落点长期
    /// 挡在门外。
    #[test]
    fn the_ad_seq_is_bound_to_the_listen_it_published() {
        let mut r = ad_rig("ad-seq-listen");
        let first = ad_ctx(&mut r).local_lan_ad().expect("首枚通告");
        assert_eq!(first.ad_seq, 1);
        assert!(first.listen.is_none());
        // 同一会话:序号与 listen 都不动。
        let mut face = AdDeck {
            db: &r.db,
            status: &r.status,
            events: &r.ev_tx,
            cfg: &r.cfg,
            slot: &mut r.slot,
            ad: &mut r.ad,
        };
        assert_eq!(face.local_lan_ad().expect("重用").ad_seq, 1);
        // 监听器绑了口(L-c3 会这么置):同一会话内也必须换号。
        face.slot.lan.listen =
            Some(lan::LanListen { port: lan::DEFAULT_LAN_PORT, addrs: vec!["192.168.1.7".into()] });
        let bound = face.local_lan_ad().expect("换号");
        assert_eq!(bound.ad_seq, 2, "listen 变了必须递增");
        assert_eq!(bound.listen.as_ref().unwrap().port, lan::DEFAULT_LAN_PORT);
        assert_eq!(face.local_lan_ad().expect("再取").ad_seq, 2, "内容没变就不再换号");
    }

    /// 结构锚(§6 代次契约之一 **run-to-completion**):两个循环的 lan 臂**只许认出事件**,
    /// 处理一律挪到 select 之外。臂里直接 await 会让「一枚事件与它产出的全部输出」中间插进
    /// 别的链路 up/down——那正是「新链的块被当成旧代 transfer 收下」的窗口。
    #[test]
    fn lan_select_arms_only_name_the_event() {
        let src = include_str!("transport.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        // 中文注释里随便一刀就可能切在多字节字符中间(切了就 panic,不是断言失败):
        // 取样一律退到最近的字符边界。
        let peek = |at: usize, n: usize| -> &str {
            let mut end = (at + n).min(prod.len());
            while !prod.is_char_boundary(end) {
                end -= 1;
            }
            &prod[at..end]
        };
        for (chan, woke) in [("lan_inbound.recv()", "Woke::Lan("), ("lan_faults.recv()", "Woke::LanDown(")] {
            let arms: Vec<usize> = prod.match_indices(chan).map(|(i, _)| i).collect();
            assert_eq!(arms.len(), 2, "{chan}:会话循环与离线泵各一条臂,实见 {}", arms.len());
            for at in arms {
                let tail = peek(at, 160);
                let end = tail.find("},").unwrap_or(tail.len());
                assert!(!tail[..end].contains("await"), "lan 臂里不许 await:\n{}", &tail[..end]);
                assert!(tail[..end].contains(woke), "臂只该认出事件");
            }
        }
        let adopts: Vec<usize> = prod.match_indices("handoff.recv()").map(|(i, _)| i).collect();
        assert_eq!(adopts.len(), 2);
        for at in adopts {
            let tail = peek(at, 80);
            let end = tail.find(",\n").unwrap_or(tail.len());
            assert!(!tail[..end].contains("await"), "移交臂里同样不许 await");
        }
        // 拨号臂同理(L-c3b):它认出的那件事(巡查一轮)是同步的,但臂里一旦 await 起来,
        // 「一枚事件跑完再看下一件」就破了——结构锚把它钉在「只认出事件」上。
        let dials: Vec<usize> = prod.match_indices("=> Woke::Dial").map(|(i, _)| i).collect();
        assert_eq!(dials.len(), 2, "会话循环与离线泵各一条拨号臂");
        for at in dials {
            let head = peek(at.saturating_sub(80), 80);
            assert!(!head.contains("await"), "拨号臂里不许 await:\n{head}");
        }
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
            lan: None,
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
        let hello = Msg::Hello { watermarks: Default::default(), lan: None };
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
        // lan 域(lan-direct-plan §4)刻意不在逐域试解表里:局域网握手密文经中转投递
        // 恒 Undecryptable。**这条是回归锚**——将来谁把 Domain::Lan 塞进上面那个数组,
        // 局域网握手就多出一条走服务器的路,与「lan 帧永不过中转」的不变量相悖。
        let lan_blob = crypto::seal_msg(
            &cfg.k_acc,
            &FrameAddr { account_id: &cfg.account_id, from_device: "F", to: "*", domain: Domain::Lan },
            &crate::sync::lan::LanMsg::Confirm { nonce_l: vec![0; 32], sig_d: vec![0; 64] },
        );
        assert!(matches!(open_deliver(&cfg, "F", "*", &lan_blob), Opened::Undecryptable));
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

    /// **中转腿上的分段供流**(§10 C′ 同轮对齐的那一半):图字节走 want → have → pull →
    /// 逐块 chunk 的旁路,真服务器 + 双库端到端跑一遍。
    ///
    /// 为什么非要端到端:C′ 之前引擎整图物化、一次性吐 N 枚块,之后改成协调者**逐块惰性
    /// 取数**,两种形状的可观测终局一模一样(B 那边字节逐位相等),差别全在中途——只有
    /// 真跑一遍才证得了「换了取数方式之后这条路还通」。图刻意跨多块(1.5 MiB = 6 块),
    /// 单块装得下就验不到切块;也刻意在 **B 引导完成之后**才贴,不然它随快照整个过去了,
    /// 旁路根本不启用。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn end_to_end_image_bytes_stream_over_the_relay_in_chunks() {
        let addr = start_server().await;
        let url = format!("ws://{addr}");
        let (db_a, clock_a, dir_a) = test_db("blob-relay-a");
        create_account_as(&db_a, &url, Some(ACCT)).await.unwrap();
        let rig_a = spawn_transport(db_a.clone(), clock_a.clone(), dir_a);
        wait_state(&rig_a.status, "online").await;

        let (db_b, clock_b, dir_b) = join_via(&rig_a, &url, "blob-relay-b").await;
        let rig_b = spawn_transport(db_b.clone(), clock_b.clone(), dir_b);
        wait_state(&rig_b.status, "online").await;

        // 引导完成之后 A 才贴图:这样字节只能走旁路(op 先到、行不建、B 发 want)。
        let bytes: Vec<u8> = (0..(6 * 256 * 1024)).map(|i| (i % 251) as u8).collect();
        let img = {
            let mut conn = db_a.lock().unwrap();
            let mut clk = clock_a.lock().unwrap();
            let item = notes::capture(&mut conn, &mut clk, "带大图的一条").unwrap();
            images::attach(&mut conn, &mut clk, &item, &bytes, "image/png").unwrap().0
        };
        wait_until("B 收齐图字节", || {
            let conn = db_b.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM item_image WHERE id = ?1", [&img], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
                == 1
        })
        .await;
        let got: Vec<u8> = {
            let conn = db_b.lock().unwrap();
            conn.query_row("SELECT data FROM item_image WHERE id = ?1", [&img], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(got.len(), bytes.len(), "字节数对不上");
        assert_eq!(got, bytes, "逐块拼回来必须与原图逐位相等");

        rig_a.task.abort();
        rig_b.task.abort();
        let _ = (rig_a.wrote, rig_b.wrote);
    }

    /// space-entry-plan §3.2:BootCommitted 共享 latch——引导持久提交后、
    /// relay_session_up 之前恰好一次 ready(needs_reopen=false、report 计数如实、
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
    // ---- 监听器准入表与 pre-auth 握手(lan-direct-plan §4 / §6 / §10;L-c3a) ----------

    /// 测试里当拨入方(D)的那台设备。
    const DIALER: &str = "01PEERDDDDDDDDDDDDDDDDDDDD";
    const DIALER_SEED: [u8; 32] = [9u8; 32];

    /// 一台**接了 app 级监听器**的传输 runtime 的把手。
    struct ListenRig {
        db: Arc<Mutex<Connection>>,
        clock: Arc<Mutex<Clock>>,
        status: Arc<Mutex<SyncStatus>>,
        cfg: SyncConfig,
        adm: Arc<LanAdmission>,
        port: u16,
        shutdown: tokio::sync::watch::Sender<bool>,
        task: tokio::task::JoinHandle<TransportExit>,
        ctl: mpsc::Sender<Control>,
        _dir: PathBuf,
    }

    impl ListenRig {
        /// 让 `run` 顶立刻重来一轮(壳层改配置那条既有通道)。拨号用例拿它当「别干等」
        /// 的加速器——缓存是用例直接写进库的,没经过会 kick 拨号器的那条吸收路。
        fn poke(&self) {
            self.ctl.try_send(Control::Reconfigured).expect("控制通道");
        }

        fn lan_peers(&self) -> usize {
            self.status.lock().unwrap().lan_peers
        }
    }

    /// 起一台接了监听器的 runtime,**中转地址指向必然连不上的端口**——故它一路停在离线
    /// 泵里,正是「WAN 从启动前就断」的冷启动形:一条 WSS Challenge 都没见过,LanReady
    /// 照样置位、监听口照样绑上(不变量 6)。
    async fn listen_rig(tag: &str, seed: u8) -> ListenRig {
        let (db, clock, dir) = test_db(tag);
        {
            let mut conn = db.lock().unwrap();
            save_config(&mut conn, ACCT, &[5u8; 32], &[seed; 32], "ws://127.0.0.1:1", true).unwrap();
        }
        let cfg = {
            let conn = db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, _ev_rx) = mpsc::unbounded_channel();
        let status = Arc::new(Mutex::new(SyncStatus::default()));
        let wrote = Arc::new(Notify::new());
        {
            let conn = db.lock().unwrap();
            hook_oplog_writes(&conn, wrote.clone());
        }
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let adm = LanAdmission::ephemeral();
        let t = Transport {
            db: db.clone(),
            clock: clock.clone(),
            status: status.clone(),
            events: ev_tx,
            control: ctl_rx,
            wrote,
            data_dir: dir.clone(),
            blob_policy: BlobPolicy::Full,
            allow_boot_source: true,
            shutdown: shutdown_rx,
            boot_commit: Arc::new(Mutex::new(None)),
            restart_flag: Arc::new(Mutex::new(None)),
            lan: Some(LanHost { space_id: tag.into(), admission: Arc::clone(&adm), owner: 1 }),
        };
        let task = tokio::spawn(run(t));
        let mut port = None;
        for _ in 0..400 {
            port = adm.listen_port();
            if port.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let port = port.expect("监听器该在 4 秒内惰性绑上(首个已配置空间注册时)");
        ListenRig {
            db,
            clock,
            status,
            cfg,
            adm,
            port,
            shutdown: shutdown_tx,
            task,
            ctl: ctl_tx,
            _dir: dir,
        }
    }

    /// 把一把验证钥钉进 `lan_peer:<peer>`(模拟「经中转鉴权路学得并首见钉住」,§2)。
    /// **必须在监听口绑上之后调**:`reconcile_lan_ad_owner` 在 `run` 顶盖章时会清掉不属
    /// 于本代身份的缓存,先写会被它扫掉。
    fn pin_peer_key(db: &Arc<Mutex<Connection>>, peer: &str, pubkey: &[u8; 32]) {
        let conn = db.lock().unwrap();
        let lan::AdMerge::Store { record, .. } =
            lan::merge_peer_ad(None, &ad_of(pubkey, 1), Ingress::RelayDeliver, NOW_MS)
        else {
            panic!("首见该落库")
        };
        write_peer_ad(&conn, peer, &record).unwrap();
    }

    /// **只有准入表、没有 transport** 的装配台:握手任务拒掉一条链时,没有第二个机制能
    /// 替它背这个书(协调者的逐事件栅栏在这里根本不存在)。
    struct SoloRig {
        db: Arc<Mutex<Connection>>,
        cfg: SyncConfig,
        port: u16,
        adopted: mpsc::Receiver<AdoptedLink>,
        _adm: Arc<LanAdmission>,
        _dir: PathBuf,
    }

    fn solo_rig(tag: &str, seed: u8) -> SoloRig {
        let (db, _clock, dir) = test_db(tag);
        {
            let mut conn = db.lock().unwrap();
            save_config(&mut conn, ACCT, &[5u8; 32], &[seed; 32], "ws://127.0.0.1:1", true).unwrap();
        }
        let cfg = {
            let conn = db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        pin_peer_key(&db, DIALER, &pubkey_of(&DIALER_SEED));
        let adm = LanAdmission::ephemeral();
        let (handoff, adopted) = mpsc::channel(LAN_HANDOFF_CAP);
        let port = adm
            .register(lan_net::Registration {
                space_id: "solo".into(),
                owner: 1,
                account_id: cfg.account_id.clone(),
                self_device: cfg.device_id.clone(),
                k_acc: cfg.k_acc,
                self_seed: cfg.device_seed,
                db: Arc::clone(&db),
                active: Arc::new(Mutex::new(HashSet::new())),
                handoff,
            })
            .expect("注册该绑上监听口");
        SoloRig { db, cfg, port, adopted, _adm: adm, _dir: dir }
    }

    /// 库自己悄悄换 K_acc = 纪元压实换代的最小形(进程内没有任何人被通知,故这正是
    /// 「只等 `Reconfigured` 就等于把不变量交给壳层自律」的那一路)。
    fn recast_k_acc(db: &Arc<Mutex<Connection>>) {
        let conn = db.lock().unwrap();
        meta_put(&conn, "k_acc", &hex(&[0x77u8; 32])).unwrap();
    }

    /// 以 D 的身份走完 §4 的三步握手。`Err` = 监听方在某一步关了(静默拒的观测形)。
    async fn dial_lan(
        port: u16,
        cfg: &SyncConfig,
        k_acc: &[u8; 32],
    ) -> Result<(FakeLink, lan::LanEstablished), String> {
        let (mut sock, mut dialer, accept) = half_dial(port, cfg, k_acc).await?;
        let (confirm, est) = dialer.on_accept(&accept).map_err(|e| e.to_string())?;
        lan_net::write_wire(&mut sock, &confirm).await?;
        Ok((FakeLink { stream: sock }, est))
    }

    /// 只走到「收下 Accept」为止(Confirm 留在手上):用来把握手停在中间那一刻。
    async fn half_dial(
        port: u16,
        cfg: &SyncConfig,
        k_acc: &[u8; 32],
    ) -> Result<(TcpStream, lan::LanDialer, lan::LanWire), String> {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
        let (dialer, intro) = lan::LanDialer::start(&lan::DialParams {
            account_id: &cfg.account_id,
            k_acc,
            self_seed: &DIALER_SEED,
            self_device: DIALER,
            peer_device: &cfg.device_id,
            peer_pubkey: &pubkey_of(&cfg.device_seed),
        });
        lan_net::write_wire(&mut s, &intro).await?;
        let accept = timeout(
            Duration::from_millis(2000),
            lan_net::read_wire(&mut s, lan::FramePhase::PreAuth),
        )
        .await
        .map_err(|_| "等 Accept 超时".to_string())??;
        Ok((s, dialer, accept))
    }

    /// 正路:合法拨入 → 三步握手过 → 链路交到协调者手上 → 引擎当场回一帧定向 Hello,
    /// 状态面的链路数也随之变 1。**中转一次都没连上过**(冷启动形)。
    #[tokio::test]
    async fn the_listener_adopts_a_signed_dial_and_hands_the_link_to_the_coordinator() {
        let r = listen_rig("lan-listen-ok", 21).await;
        pin_peer_key(&r.db, DIALER, &pubkey_of(&DIALER_SEED));
        let (mut link, est) = dial_lan(r.port, &r.cfg, &r.cfg.k_acc).await.expect("握手该成");
        assert_eq!(est.peer, r.cfg.device_id, "拨入方认下的对端 = 监听方");
        let (from, to, msg) = link.next_msg(&r.cfg, 2000).await.expect("建链那一帧定向 Hello");
        assert_eq!(from, r.cfg.device_id);
        assert_eq!(to, DIALER, "定向发给刚建链的对端");
        assert!(matches!(msg, Msg::Hello { .. }), "该是 Hello,实见 {msg:?}");
        wait_until("状态面记上这条直连", || r.status.lock().unwrap().lan_peers == 1).await;
        let _ = r.shutdown.send(true);
        let _ = r.task.await;
    }

    /// §4 步骤 1 第四闸:该对端已有活跃链 = 静默关。这道闸判在握手任务里,而链路集住在
    /// 协调者手上,故它读的是协调者发布的那份**只读视图**([`LanLinks::active`])——本测
    /// 同时是那份视图的接线锚:不发布(或发布点漏了移交这一路),第二次拨入就会被放行。
    #[tokio::test]
    async fn a_second_dial_while_a_link_is_live_is_refused() {
        let r = listen_rig("lan-listen-dup", 27).await;
        pin_peer_key(&r.db, DIALER, &pubkey_of(&DIALER_SEED));
        let (_link, _) = dial_lan(r.port, &r.cfg, &r.cfg.k_acc).await.expect("首次该成");
        wait_until("首条链已在册", || r.status.lock().unwrap().lan_peers == 1).await;
        let Err(err) = dial_lan(r.port, &r.cfg, &r.cfg.k_acc).await else {
            panic!("同对端已有活跃链,第二次拨入该被静默关")
        };
        assert!(err.contains("Accept") || err.contains("长度前缀"), "实见:{err}");
        assert_eq!(r.status.lock().unwrap().lan_peers, 1, "还是那一条");
        let _ = r.shutdown.send(true);
        let _ = r.task.await;
    }

    /// §4 步骤 1 第三闸:对端公钥**只经服务器鉴权路学得**——没钉住过就不建链、不 TOFU。
    /// 阴性对照就是上一条(同样的拨入,只多了一次 `pin_peer_key`)。
    #[tokio::test]
    async fn a_dialer_whose_key_was_never_learned_over_the_relay_gets_no_accept() {
        let r = listen_rig("lan-listen-nokey", 22).await;
        let Err(err) = dial_lan(r.port, &r.cfg, &r.cfg.k_acc).await else { panic!("无缓存公钥该拒") };
        assert!(err.contains("Accept") || err.contains("长度前缀"), "实见:{err}");
        assert_eq!(r.status.lock().unwrap().lan_peers, 0, "一条链都不该有");
        let _ = r.shutdown.send(true);
        let _ = r.task.await;
    }

    /// §4 步骤 1 首闸:MAC 绑 (账户, D, L, nonce)——手里没有 K_acc 的人算不出它,全表
    /// 零命中,静默关。
    #[tokio::test]
    async fn a_dial_with_the_wrong_account_key_matches_no_space() {
        let r = listen_rig("lan-listen-badmac", 23).await;
        pin_peer_key(&r.db, DIALER, &pubkey_of(&DIALER_SEED));
        let Err(err) = dial_lan(r.port, &r.cfg, &[0xEEu8; 32]).await else { panic!("MAC 不符该拒") };
        assert!(err.contains("Accept") || err.contains("长度前缀"), "实见:{err}");
        assert_eq!(r.status.lock().unwrap().lan_peers, 0);
        let _ = r.shutdown.send(true);
        let _ = r.task.await;
    }

    /// §6 ⑤ 的核心:**交 handoff 之前重新自证身份**。把握手停在「Accept 已收、Confirm
    /// 还没发」那一刻,期间由库自己悄悄换掉 K_acc(纪元压实那一路——没人 poke 控制通道),
    /// 再补上 Confirm:密码学上这一步是对的(用的是握手当时那份材料),但身份已经不是本机
    /// 此刻的身份了,故这条链**不许**被认下。
    #[tokio::test]
    async fn recasting_the_identity_mid_handshake_blocks_the_handoff() {
        let r = listen_rig("lan-listen-recast", 24).await;
        pin_peer_key(&r.db, DIALER, &pubkey_of(&DIALER_SEED));
        let (mut sock, mut dialer, accept) =
            half_dial(r.port, &r.cfg, &r.cfg.k_acc).await.expect("前两步该过");
        recast_k_acc(&r.db);
        let (confirm, _) = dialer.on_accept(&accept).expect("Accept 本身是合法的");
        lan_net::write_wire(&mut sock, &confirm).await.expect("写 Confirm");
        let mut link = FakeLink { stream: sock };
        assert!(link.closed(2000).await, "换代后这条链不许被认下,socket 该当场关");
        assert_eq!(r.status.lock().unwrap().lan_peers, 0, "引擎压根不该知道它存在");
        let _ = r.shutdown.send(true);
        let _ = r.task.await;
    }

    /// 上一条的**隔离形**——准入表独立于任何 transport 起(没有协调者、没有引擎),故
    /// 「链没被认下」只可能是握手任务自己拒的。为什么非要这一条:上一条里协调者的逐事件
    /// 栅栏会顺手把换代后的移交挡掉(`pump_apply` 的第一件事就是查栅栏),故**去掉握手
    /// 任务自己那道自证,上一条照样绿**——那是「被别的机制背书」型假绿(memory
    /// `test-negative-control`;本轮变异对照当场抓到)。
    ///
    /// 阳性阴性两半同测(实现审三轮 H2 的教训):没有前半截,「什么都不移交」也能骗过
    /// 后半截。
    #[tokio::test]
    async fn the_handshake_task_itself_refuses_to_hand_off_after_a_recast() {
        let mut r = solo_rig("lan-preauth-recast", 31);
        // 阳性半:身份没动,这台装配台**认得下**链。
        let (_ok_link, _) = dial_lan(r.port, &r.cfg, &r.cfg.k_acc).await.expect("正路该成");
        assert!(r.adopted.recv().await.is_some(), "身份没换时链路该被移交");

        // 阴性半:握手停在「Accept 已收、Confirm 还没发」,期间库自己换掉 K_acc。
        let (mut sock, mut dialer, accept) =
            half_dial(r.port, &r.cfg, &r.cfg.k_acc).await.expect("前两步该过");
        recast_k_acc(&r.db);
        let (confirm, _) = dialer.on_accept(&accept).expect("Accept 本身是合法的");
        lan_net::write_wire(&mut sock, &confirm).await.expect("写 Confirm");
        let mut link = FakeLink { stream: sock };
        assert!(link.closed(2000).await, "换代后握手任务该当场关掉 socket");
        assert!(r.adopted.try_recv().is_err(), "换代后这条链绝不许被移交出去");
    }

    /// §10 令牌桶的**接线**(实现审 M1):预占在放行那一刻扣,合法建链**退款**,故一枚
    /// 令牌的桶里连着两次成功握手也走得通;而对端给的东西不对时那一枚就真花掉了。
    /// 单测只证得了 `admit_conn`/`refund` 两个零件,这条盯的是 `serve_conn` 有没有按结局
    /// 分类去退——不退的话,一枚令牌的桶第二次拨入就进不来。
    #[tokio::test]
    async fn a_legitimate_handshake_refunds_its_token() {
        let mut r = solo_rig("lan-token-wiring", 34);
        r._adm.set_tokens_for_test(1.0);
        let (_a, _) = dial_lan(r.port, &r.cfg, &r.cfg.k_acc).await.expect("第一条该成");
        assert!(r.adopted.recv().await.is_some(), "第一条被移交");
        let (_b, _) = dial_lan(r.port, &r.cfg, &r.cfg.k_acc).await.expect("退了款,第二条也该成");
        assert!(r.adopted.recv().await.is_some(), "第二条也被移交");
    }

    /// 撤位 abort 掉一只在飞的握手时,它预占的那一枚令牌**要退回来**(实现审二轮 M1):
    /// abort 把任务连同它后面的分类记账一起丢掉,故「花掉」必须做成需要显式置位的例外,
    /// 由 `Drop` 兜默认退款。不退的话,一次 stop / 纪元换代最多白烧 8 枚全局令牌,连累
    /// **同一 app 里别的空间**的直连准入。
    #[tokio::test]
    async fn cancelling_a_handshake_gives_its_token_back() {
        let r = solo_rig("lan-token-abort", 35);
        // 先让一只握手停在等 Confirm 那一步(令牌已预占)。
        let (_sock, _d, _a) = half_dial(r.port, &r.cfg, &r.cfg.k_acc).await.expect("前两步该过");
        assert_eq!(r._adm.inflight(), 1, "此刻恰有一只在飞");
        // 把桶按到 0 再撤位:这样「后面还连得进来」只可能是那一枚退回来的
        // (计时器同时归零,几十毫秒的自然补充不足一枚)。
        r._adm.set_tokens_for_test(0.0);
        r._adm.deregister("solo", 1);
        wait_until("在飞任务已被取消", || r._adm.inflight() == 0).await;
        let mut next = FakeLink {
            stream: TcpStream::connect(("127.0.0.1", r.port)).await.expect("连得上"),
        };
        assert!(!next.closed(500).await, "退回来的那一枚该让下一条连接进得来");
    }

    /// 摘了准入条目之后,新的拨入连 Accept 都拿不到(§6:撤位期 fail-closed)。这条盯的
    /// 是 supervisor `stop` **先摘条目再拉停机信号**那一改的下半截——条目一摘,该空间就
    /// 不再认任何新链,不必等 transport 自己退出。
    #[tokio::test]
    async fn a_dial_after_the_seat_is_dropped_gets_nothing() {
        let mut r = solo_rig("lan-preauth-dropped", 33);
        // 阳性半:条目在时认得下。
        let (_ok, _) = dial_lan(r.port, &r.cfg, &r.cfg.k_acc).await.expect("正路该成");
        assert!(r.adopted.recv().await.is_some(), "条目在时该被移交");
        r._adm.deregister("solo", 1);
        let Err(err) = half_dial(r.port, &r.cfg, &r.cfg.k_acc).await else {
            panic!("条目已摘,该在 Accept 之前就关")
        };
        assert!(err.contains("Accept") || err.contains("长度前缀"), "实见:{err}");
        assert!(r.adopted.try_recv().is_err(), "什么都不该被移交");
    }

    /// §6 ⑤ 的另一半:**认下空间之后、发 Accept 之前**也得自证。这一路的换代发生在拨入
    /// 之前(纪元压实已经改了库,而 transport 还没醒来重注册),故准入表里那份材料是过期
    /// 的——MAC 照样对得上(表里的 K_acc 就是旧的),必须靠库侧那一问拦住,否则本机会拿
    /// 旧身份签一枚 Accept 发出去、还白烧一个重复抑制槽。
    #[tokio::test]
    async fn a_dial_arriving_after_a_recast_gets_no_accept_at_all() {
        let mut r = solo_rig("lan-preauth-stale", 32);
        recast_k_acc(&r.db);
        let Err(err) = half_dial(r.port, &r.cfg, &r.cfg.k_acc).await else {
            panic!("该在 Accept 之前就关")
        };
        assert!(err.contains("Accept") || err.contains("长度前缀"), "实见:{err}");
        assert!(r.adopted.try_recv().is_err(), "什么都不该被移交");
    }

    /// §6「supervisor stop 先摘准入条目 + 取消该代未移交的 pre-auth 任务」:把一只握手
    /// 停在等 Confirm 那一步,然后停机——条目随 `run` 收场被摘掉,那只任务当场被 abort
    /// (不是等它自己 2 秒超时),socket 随之落地。
    #[tokio::test]
    async fn stopping_the_runtime_cancels_a_handshake_that_is_still_waiting_for_confirm() {
        let r = listen_rig("lan-listen-stop", 25).await;
        pin_peer_key(&r.db, DIALER, &pubkey_of(&DIALER_SEED));
        let (sock, _dialer, _accept) =
            half_dial(r.port, &r.cfg, &r.cfg.k_acc).await.expect("前两步该过");
        assert_eq!(r.adm.inflight(), 1, "此刻恰有一只在飞的 pre-auth 任务");
        let _ = r.shutdown.send(true);
        let _ = r.task.await;
        let mut link = FakeLink { stream: sock };
        assert!(link.closed(1000).await, "停机该当场取消未移交的握手");
        wait_until("在飞任务的额度也交还了", || r.adm.inflight() == 0).await;
    }

    /// §10 每源 IP ≤2:第三条连接**静默丢**(accept 之后当场关),前两条照常等它们的
    /// 首帧超时。`closed` 认的是真 EOF 不是「这会儿没帧」,故这条不是假绿。
    #[tokio::test]
    async fn a_third_concurrent_dial_from_the_same_ip_is_dropped() {
        let r = listen_rig("lan-listen-perip", 26).await;
        let mut socks = vec![];
        for _ in 0..3 {
            socks.push(FakeLink {
                stream: TcpStream::connect(("127.0.0.1", r.port)).await.expect("连得上"),
            });
        }
        assert!(socks[2].closed(1000).await, "超每源 IP 上界的那条该被当场丢掉");
        assert!(!socks[0].closed(300).await, "前两条还在等自己的首帧(2 秒超时)");
        let _ = r.shutdown.send(true);
        let _ = r.task.await;
    }

    /// 准入表的注册语义:同注册者、同身份指纹反复注册 = **不换代**(否则每轮重连都把在飞
    /// 的握手 abort 一遍);身份一换就换代(旧代任务据此自证失败)。
    #[tokio::test]
    async fn re_registering_the_same_identity_keeps_the_epoch_but_recasting_bumps_it() {
        let adm = LanAdmission::ephemeral();
        let (db, _clock, _dir) = test_db("lan-admit-epoch");
        let (handoff, _rx) = mpsc::channel(LAN_HANDOFF_CAP);
        let active = Arc::new(Mutex::new(HashSet::new()));
        let reg = |k_acc: [u8; 32]| lan_net::Registration {
            space_id: "s1".into(),
            owner: 7,
            account_id: ACCT.into(),
            self_device: "01SELFAAAAAAAAAAAAAAAAAAAA".into(),
            k_acc,
            self_seed: [1u8; 32],
            db: Arc::clone(&db),
            active: Arc::clone(&active),
            handoff: handoff.clone(),
        };
        let p1 = adm.register(reg([5u8; 32])).expect("首次注册该绑上");
        let e1 = adm.epoch_of("s1").expect("条目在");
        let p2 = adm.register(reg([5u8; 32])).expect("续注册");
        assert_eq!((p1, e1), (p2, adm.epoch_of("s1").unwrap()), "同身份续注册不换端口也不换代");
        adm.register(reg([6u8; 32])).expect("换身份重注册");
        assert!(adm.epoch_of("s1").unwrap() > e1, "身份一换就换代");
        adm.deregister("s1", 6);
        assert!(adm.epoch_of("s1").is_some(), "注册者号对不上的注销摘不掉条目");
        adm.deregister("s1", 7);
        assert!(adm.epoch_of("s1").is_none(), "本人注销才摘");
    }

    // ---- 拨号器(lan-direct-plan §7;L-c3b) ------------------------------------------

    /// 合成局域网(见 `lan_net::TestNet`):对端通告的地址与本机那张网卡。**候选过滤跑的
    /// 是真规则**(私网 ∧ 在直连子网内 ∧ 非自身 ∧ 非网络/广播地址),只有最后真去连的那
    /// 一步改写到环回——同一台机器上的两实例在结构上过不了 §7 的过滤(对端通告的地址就是
    /// 本机自己的地址)。
    const LAN_PEER_ADDR: &str = "192.168.77.1";
    const LAN_SELF_ADDR: &str = "192.168.77.9";

    /// 往缓存里钉一台**带监听落点**的对端(= 经中转鉴权路学得的那份通告,§2)。
    fn pin_peer_listen(db: &Arc<Mutex<Connection>>, peer: &str, pubkey: &[u8; 32], port: u16) {
        pin_peer_ad(db, peer, pubkey, Some(lan::LanListen { port, addrs: vec![LAN_PEER_ADDR.into()] }));
    }

    fn pin_peer_ad(
        db: &Arc<Mutex<Connection>>,
        peer: &str,
        pubkey: &[u8; 32],
        listen: Option<lan::LanListen>,
    ) {
        let conn = db.lock().unwrap();
        let ad = LanAd { pubkey: pubkey.to_vec(), ad_seq: 1, listen };
        let lan::AdMerge::Store { record, .. } =
            lan::merge_peer_ad(None, &ad, Ingress::RelayDeliver, NOW_MS)
        else {
            panic!("首见该落库")
        };
        write_peer_ad(&conn, peer, &record).unwrap();
    }

    /// **本笔的核心验收**(§11:真 TCP 双实例 + WAN 自启动前即断的冷启动 + 纯直连收敛):
    /// 两台桌面各自绑着监听口、一条 WSS 都没连过,**链路由拨号器自己拨出来**(L-c2c 那条
    /// 同名用例是把握手好的链路直接塞进移交通道的),然后靠它把存量与实时写都拉齐。
    #[tokio::test]
    async fn the_dialer_brings_up_a_link_and_two_cold_started_desktops_converge() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let a = listen_rig("lan-dial-conv-a", 41).await;
        let b = listen_rig("lan-dial-conv-b", 42).await;
        // A 有一条建链前写下的存量灵感:只能靠建链后的双向定向 Hello 互补过去。
        {
            let mut conn = a.db.lock().unwrap();
            let mut clk = a.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "拨号建链前写的").unwrap();
        }
        // 互相钉住对端的验证钥与监听落点(§2:只经中转鉴权路学得,这里直接摆进缓存)。
        pin_peer_listen(&a.db, &b.cfg.device_id, &pubkey_of(&b.cfg.device_seed), b.port);
        pin_peer_listen(&b.db, &a.cfg.device_id, &pubkey_of(&a.cfg.device_seed), a.port);
        a.poke();
        b.poke();

        wait_until("两端都认下这条直连", || a.lan_peers() == 1 && b.lan_peers() == 1).await;
        wait_until("存量 op 经双向 hello 互补拉齐", || count_items(&b.db) == 1).await;
        {
            let mut conn = b.db.lock().unwrap();
            let mut clk = b.clock.lock().unwrap();
            notes::capture(&mut conn, &mut clk, "断网期 B 写的").unwrap();
        }
        wait_until("A 收到 B 的实时写", || count_items(&a.db) == 2).await;
        // 不变量 2:lan 投递永不推进「服务器已接手」那根游标。
        for rig in [&a, &b] {
            let conn = rig.db.lock().unwrap();
            assert_eq!(read_last_pushed(&conn).unwrap(), 0, "last_pushed 只由服务器 ack 抬");
        }
        let _ = a.shutdown.send(true);
        let _ = b.shutdown.send(true);
        let _ = a.task.await;
        let _ = b.task.await;
    }

    /// §7 一级规则(方向优先级)的**接线**:双方皆可监听时,只有小 device_id 那端拨。
    /// 观测面是**对端监听口上的到达计数**——阴性那半(「大 id 那端一枚 Intro 都没发」)只
    /// 有在小 id 那端的监听口上才看得见。纯判定的三形在 `lan.rs` 单测里(id 由用例定)。
    #[tokio::test]
    async fn only_the_smaller_device_id_dials_when_both_ends_listen() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let a = listen_rig("lan-dial-dir-a", 43).await;
        let b = listen_rig("lan-dial-dir-b", 44).await;
        pin_peer_listen(&a.db, &b.cfg.device_id, &pubkey_of(&b.cfg.device_seed), b.port);
        pin_peer_listen(&b.db, &a.cfg.device_id, &pubkey_of(&a.cfg.device_seed), a.port);
        a.poke();
        b.poke();
        wait_until("链路建上了", || a.lan_peers() == 1 && b.lan_peers() == 1).await;
        // device_id 是建库时生成的 ULID,谁大谁小由运行时决定——照规则分派,不预设。
        let (caller, callee) =
            if a.cfg.device_id < b.cfg.device_id { (&a, &b) } else { (&b, &a) };
        assert!(callee.adm.arrivals() >= 1, "小 id 那端拨,大 id 那端的监听口才有来客");
        assert_eq!(caller.adm.arrivals(), 0, "大 id 那端一枚 Intro 都不该发(阴性对照)");
        let _ = a.shutdown.send(true);
        let _ = b.shutdown.send(true);
        let _ = a.task.await;
        let _ = b.task.await;
    }

    /// **只有拨号器、没有协调者**的装配台(同 [`solo_rig`] 之于监听侧):拨号任务拒掉一条
    /// 链时,没有第二个机制能替它背书——协调者的逐事件栅栏在这里根本不存在。
    struct DialRig {
        db: Arc<Mutex<Connection>>,
        cfg: SyncConfig,
        dial: lan_net::Dialer,
        adopted: mpsc::Receiver<AdoptedLink>,
        /// 假对端的监听口(用例自己当 §4 的 L 侧)。`None` = 已丢弃,故拨过去必被拒。
        listener: Option<TcpListener>,
        _dir: PathBuf,
    }

    impl DialRig {
        /// 巡查一轮。`self_listening = false`(手机形)故方向规则恒放行——方向规则本身由
        /// 上面那条双实例用例与 `lan.rs` 单测各自钉着。
        fn round(&mut self) {
            self.round_as(false)
        }

        fn round_as(&mut self, self_listening: bool) {
            // 这台装配台不管链路集,故默认「一条活跃链都没有」。
            self.round_with(self_listening, false)
        }

        fn round_with(&mut self, self_listening: bool, all_linked: bool) {
            let DialRig { db, cfg, dial, .. } = self;
            let warned = dial.round(
                &cfg.account_id,
                &cfg.device_id,
                &cfg.k_acc,
                &cfg.device_seed,
                db,
                self_listening,
                // 这台装配台不接监听器(手机形)。
                false,
                &|_| all_linked,
            );
            assert_eq!(warned, None, "巡查不该报诊断");
        }

        /// 巡查之后,下次时刻**永远在将来**——留在过去 = 计时器立刻又就绪 = 空转烧 CPU。
        fn assert_timer_not_in_the_past(&self) {
            let due = self.dial.due().expect("缓存里有对端就该挂着计时器");
            assert!(due > tokio::time::Instant::now(), "下次巡查时刻不许留在过去(空转)");
        }
    }

    const DIAL_PEER: &str = "01PEERLLLLLLLLLLLLLLLLLLLL";
    const DIAL_PEER_SEED: [u8; 32] = [17u8; 32];

    /// `alive = false` 时假对端的端口**没人听**(连接当场被拒),用来验退避那一路。
    async fn dial_rig(tag: &str, seed: u8, alive: bool) -> DialRig {
        let (db, _clock, dir) = test_db(tag);
        {
            let mut conn = db.lock().unwrap();
            save_config(&mut conn, ACCT, &[5u8; 32], &[seed; 32], "ws://127.0.0.1:1", true).unwrap();
        }
        let cfg = {
            let conn = db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("假对端监听口");
        let port = listener.local_addr().unwrap().port();
        pin_peer_listen(&db, DIAL_PEER, &pubkey_of(&DIAL_PEER_SEED), port);
        let (handoff, adopted) = mpsc::channel(LAN_HANDOFF_CAP);
        DialRig {
            db,
            cfg,
            dial: lan_net::Dialer::new(Some(handoff)),
            adopted,
            listener: alive.then_some(listener),
            _dir: dir,
        }
    }

    /// 用例当 §4 的**监听方**(与 `dial_lan` 那个拨入方对称):收 Intro → 备好 Accept。
    /// 刻意把 Accept 留在手上不发,故用例能在「发 Accept 之前」插事(换代)。
    async fn take_intro(
        l: &TcpListener,
        dialer_cfg: &SyncConfig,
    ) -> (TcpStream, lan::LanListener, lan::LanWire) {
        let (mut sock, _) = timeout(Duration::from_secs(2), l.accept())
            .await
            .expect("该有人拨进来")
            .expect("accept");
        let wire =
            timeout(Duration::from_secs(2), lan_net::read_wire(&mut sock, lan::FramePhase::PreAuth))
                .await
                .expect("等 Intro 超时")
                .expect("Intro 该读得出来");
        let intro = lan::Intro::parse(&wire).expect("形态合法");
        let entries = [lan::LanAdmit {
            space_id: "fake",
            account_id: &dialer_cfg.account_id,
            k_acc: &dialer_cfg.k_acc,
            self_seed: &DIAL_PEER_SEED,
            self_device: DIAL_PEER,
        }];
        let resolved = lan::resolve_intro(&entries, &intro).expect("MAC 该命中假对端");
        let dialer_pubkey = pubkey_of(&dialer_cfg.device_seed);
        let gate = lan::IntroGate { peer_pubkey: Some(&dialer_pubkey), peer_link_active: false };
        let mut dup = lan::DupCache::new();
        let (listener, accept) =
            lan::LanListener::accept(&resolved, &gate, &mut dup, 0).expect("该出 Accept");
        (sock, listener, accept)
    }

    /// §6 ⑤ 的**拨号侧对称**:每次跨 `.await` 之后、发 Confirm 或交 handoff 之前重新自证。
    /// 阳性阴性两半同测(实现审三轮 H2 的教训:没有前半截,「什么都不移交」也能骗过后半
    /// 截)。**隔离**同 `the_handshake_task_itself_refuses_to_hand_off_after_a_recast`:
    /// 这里连协调者都没有,故「链没交出来」只可能是拨号任务自己拒的。
    #[tokio::test]
    async fn the_dial_task_itself_refuses_to_hand_off_after_a_recast() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let mut r = dial_rig("lan-dial-recast", 45, true).await;
        let l = r.listener.take().expect("假对端在听");

        // 阳性半:身份没动,这条链交得出来。
        r.round();
        let (mut sock, mut listener, accept) = take_intro(&l, &r.cfg).await;
        lan_net::write_wire(&mut sock, &accept).await.expect("发 Accept");
        let confirm =
            timeout(Duration::from_secs(2), lan_net::read_wire(&mut sock, lan::FramePhase::PreAuth))
                .await
                .expect("等 Confirm 超时")
                .expect("Confirm 该读得出来");
        listener.on_confirm(&confirm).expect("Confirm 该验得过");
        assert!(r.adopted.recv().await.is_some(), "身份没换时该把链交给协调者");

        // 阴性半:握手停在「Intro 已收、Accept 还没发」,期间库自己换掉 K_acc(纪元压实
        // 那一路——没人 poke 控制通道)。
        r.dial.kick_peer(DIAL_PEER);
        r.round();
        let (mut sock2, _l2, accept2) = take_intro(&l, &r.cfg).await;
        recast_k_acc(&r.db);
        lan_net::write_wire(&mut sock2, &accept2).await.expect("发 Accept");
        let mut link = FakeLink { stream: sock2 };
        assert!(link.closed(2000).await, "换代后拨号任务该当场关掉 socket、不发 Confirm");
        assert!(r.adopted.try_recv().is_err(), "换代后这条链绝不许被移交出去");

        // 阴性半之二:换代发生在**任务开跑之前**(spawn 了但还没轮到它),那连 Intro 都
        // 不该发出去——`round` 与这只任务之间隔着一次调度,那正是「发 Intro 之前先自证」
        // 守的窗口。TCP 连接照样会建上(连接在自证之前),故观测形 = 接得到、但读到 EOF。
        r.dial.kick_peer(DIAL_PEER);
        r.round();
        recast_k_acc(&r.db);
        let (sock3, _) = timeout(Duration::from_secs(2), l.accept())
            .await
            .expect("TCP 连接照样建得上")
            .expect("accept");
        let mut link3 = FakeLink { stream: sock3 };
        assert!(link3.closed(2000).await, "换代后一枚 Intro 都不该发,socket 当场落地");
    }

    /// §7 退避:拨不通就等,**不是每次巡查都重拨**;复位信号(这里用 `peer{online}` 那条
    /// 触发)才让它立刻再来一枚。同时钉住「计时器不留在过去」——那是空转的来路。
    #[tokio::test]
    async fn a_failed_dial_backs_off_until_something_resets_it() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        // 假对端的端口没人听:连接当场被拒,任务很快收场(不占在飞名额)。
        let mut r = dial_rig("lan-dial-backoff", 46, false).await;
        r.round();
        assert_eq!(r.dial.attempts(), 1, "头一次该拨");
        wait_until("那一枚拨号已收场", || r.dial.inflight() == 0).await;
        r.assert_timer_not_in_the_past();

        r.round();
        assert_eq!(r.dial.attempts(), 1, "退避没到,不该再拨(阴性对照)");
        r.assert_timer_not_in_the_past();

        // §7 拨号时机之三:服务器说它上线了 = 复位它那份退避。
        r.dial.kick_peer(DIAL_PEER);
        r.round();
        assert_eq!(r.dial.attempts(), 2, "复位之后该再拨一枚");
    }

    /// 结构上不该拨的对端:一枚都不发,**且不留退避条目**(留了的话它那个早已过期的时刻
    /// 会把巡查钉在过去,空转)。三形:方向规则挡的 / 没有监听落点的(手机)/ 同 id 异钥
    /// 被粘滞禁用的。
    #[tokio::test]
    async fn the_round_skips_peers_it_must_not_dial() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let mut r = dial_rig("lan-dial-skip", 47, false).await;
        // 先把正路那台摘掉,免得它把计数顶上去。
        forget_peer_ad(&r.db, DIAL_PEER);

        // ① 本机在监听 ∧ 本机 id 更大(对端 id 以 "00" 起,恒排在 ULID 之前)→ 不拨。
        let smaller = "00PEERAAAAAAAAAAAAAAAAAAAA";
        pin_peer_listen(&r.db, smaller, &pubkey_of(&[19u8; 32]), 1);
        r.round_as(true);
        assert_eq!(r.dial.attempts(), 0, "方向规则:大 id 那端不发起(阴性对照)");
        r.assert_timer_not_in_the_past();
        // 同一台对端,本机不监听 = 手机形 → 立刻就该拨(阳性对照,证明挡住它的只是方向)。
        r.round_as(false);
        assert_eq!(r.dial.attempts(), 1, "不监听的那端恒是合法方向");

        // ①' 已有活跃链的对端不再拨(否则每轮空闲巡查都要往在场的链上再拨一次)。
        // **两件先清干净**:上一枚拨号要真收场(不然挡住它的是在飞闸)、退避要复位(不然
        // 挡住它的是「刚拨过」)——首轮变异对照抓到的假绿正是这两条顶了包。
        wait_until("上一枚拨号已收场", || r.dial.inflight() == 0).await;
        r.dial.kick_peer(smaller);
        let before = r.dial.attempts();
        r.round_with(false, true);
        assert_eq!(r.dial.attempts(), before, "链已在场就不必再拨(阴性对照)");
        // 阳性对照:同一时刻改说「没有链」,它立刻就拨——证明挡住它的只是那道闸。
        r.round_with(false, false);
        assert_eq!(r.dial.attempts(), before + 1, "没有链就该拨(阳性对照)");

        // ② 没有监听落点(手机侧通告)= 没有可拨的地址。
        let mut r2 = dial_rig("lan-dial-skip2", 48, false).await;
        forget_peer_ad(&r2.db, DIAL_PEER);
        pin_peer_ad(&r2.db, "01PEERPHONEAAAAAAAAAAAAAAA", &pubkey_of(&[21u8; 32]), None);
        r2.round();
        assert_eq!(r2.dial.attempts(), 0, "没有 listen 的对端拨不了");
        r2.assert_timer_not_in_the_past();

        // ③ 同 id 异钥被粘滞禁用(§2)→ 验证钥与拨号候选**同时**归零。
        let mut r3 = dial_rig("lan-dial-skip3", 49, false).await;
        {
            let conn = r3.db.lock().unwrap();
            let cached = read_peer_ad(&conn, DIAL_PEER).unwrap().expect("刚钉的");
            let other = ad_of(&pubkey_of(&[23u8; 32]), 2);
            let lan::AdMerge::Store { record, cause } =
                lan::merge_peer_ad(Some(&cached), &other, Ingress::RelayDeliver, NOW_MS)
            else {
                panic!("异钥该落库")
            };
            assert_eq!(cause, lan::StoreCause::KeyConflict);
            write_peer_ad(&conn, DIAL_PEER, &record).unwrap();
        }
        r3.round();
        assert_eq!(r3.dial.attempts(), 0, "粘滞禁用的对端一个候选都不给");
        r3.assert_timer_not_in_the_past();
    }

    /// 把一台对端从缓存里抹掉(用例摆场用;生产没有这条路——记录永不删,§2)。
    fn forget_peer_ad(db: &Arc<Mutex<Connection>>, peer: &str) {
        let conn = db.lock().unwrap();
        conn.execute("DELETE FROM sync_meta WHERE key = ?1", [&lan_peer_key(peer)]).unwrap();
    }

    /// **撤位即取消在飞拨号**是结构事实(不是「记得在三档撤位各调一句 cancel」的自律):
    /// 拨号器住在引擎槽里,[`EngineSlot::retire`] 一并把它退掉。
    ///
    /// 判据**必须是那只在飞的握手真被取消**:光看 `dial_due()` 归没归零是**假绿**——撤位
    /// 之后 `lan_ready()` 已经是假,那格无论如何都返回 `None`,拨号器那句 `retire()` 删掉
    /// 也照样绿(首轮变异对照当场抓到)。
    #[tokio::test]
    async fn retiring_the_engine_slot_also_retires_the_dialer() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let (db, _clock, _dir) = test_db("lan-dial-slot-retire");
        {
            let mut conn = db.lock().unwrap();
            save_config(&mut conn, ACCT, &[5u8; 32], &[61u8; 32], "ws://127.0.0.1:1", true).unwrap();
        }
        let cfg = {
            let conn = db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        // 假对端**接了连接就不吭声**:出站握手于是停在「等 Accept」的 2 秒里。
        let l = TcpListener::bind(("127.0.0.1", 0)).await.expect("假对端监听口");
        pin_peer_listen(&db, DIAL_PEER, &pubkey_of(&DIAL_PEER_SEED), l.local_addr().unwrap().port());
        let (handoff, _rx) = mpsc::channel(LAN_HANDOFF_CAP);
        let (mut slot, _lan_rx, _faults) = EngineSlot::new(BlobPolicy::Full, Some(handoff));
        {
            let conn = db.lock().unwrap();
            slot.reconcile(&conn, &cfg).unwrap();
        }
        assert!(slot.dial_due().is_some(), "引擎装配好就该看一眼拨号面(冷启动全靠这一下)");
        assert_eq!(slot.dial_round(&db, &cfg, false), None, "巡查不该报诊断");
        let (sock, _) =
            timeout(Duration::from_secs(2), l.accept()).await.expect("该有人拨进来").expect("accept");
        assert_eq!(slot.dial.inflight(), 1, "此刻恰有一只在飞的出站握手");

        slot.retire();
        assert_eq!(slot.dial.inflight(), 0, "撤位把在飞的出站握手一并取消(§6 ⑤)");
        assert!(slot.dial_due().is_none(), "撤位期不拨号(§6 撤位清单)");
        let mut link = FakeLink { stream: sock };
        assert!(link.closed(1000).await, "取消掉的握手把 socket 一起带走");
        // 装不回引擎时(`bootstrapped_at` 缺席 = 引导中)照样不拨。
        {
            let conn = db.lock().unwrap();
            conn.execute("DELETE FROM sync_meta WHERE key = 'bootstrapped_at'", []).unwrap();
            slot.reconcile(&conn, &cfg).unwrap();
        }
        assert!(slot.dial_due().is_none(), "引导中不拨号");
    }

    /// **巡查那一刻也要把本机通告地址对齐**(codex L-c3b 一轮 H1):「网络变化」没有 OS
    /// 通知,这一轮的接口枚举就是唯一观测点。中转会话一直连着时插网线——`run` 顶与会话仪式
    /// 那两个既有对齐点都不会再跑,漏了这一下就是**直连永久起不来**的确定场景(对端照着
    /// 旧地址拨不通,本机因方向规则又不发起)。四段:首次落地要广播 / 没变不重发 / 换网跟着
    /// 换并重新广播 / 中转不在时只更新不产帧。
    #[tokio::test]
    async fn a_network_change_refreshes_the_local_ad_and_republishes_it() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let (db, _clock, _dir) = test_db("lan-dial-netchange");
        {
            let mut conn = db.lock().unwrap();
            save_config(&mut conn, ACCT, &[5u8; 32], &[62u8; 32], "ws://127.0.0.1:1", true).unwrap();
        }
        let cfg = {
            let conn = db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        let status = Arc::new(Mutex::new(SyncStatus::default()));
        let (ev_tx, _ev_rx) = mpsc::unbounded_channel();
        let adm = LanAdmission::ephemeral();
        let (handoff, _rx) = mpsc::channel(LAN_HANDOFF_CAP);
        let seat = AdmitSeat {
            host: LanHost { space_id: "s1".into(), admission: Arc::clone(&adm), owner: 1 },
            owner: 1,
            handoff,
        };
        let (dial_handoff, _dial_rx) = mpsc::channel(LAN_HANDOFF_CAP);
        let (mut slot, _lan_rx, _faults) = EngineSlot::new(BlobPolicy::Full, Some(dial_handoff));
        {
            let conn = db.lock().unwrap();
            slot.reconcile(&conn, &cfg).unwrap();
        }
        let addrs = |slot: &EngineSlot| slot.lan.listen.as_ref().map(|l| l.addrs.clone());
        // 本会话的通告面。`published` 记的是「这条会话上已经发出去的那份 listen」——判据
        // 就是拿它跟当前事实比(codex 二轮 M2:一次性边沿会把失败那次永远吃掉)。
        let mut face = AdFace::new(true);
        let tick = |slot: &mut EngineSlot, face: Option<&AdFace>| {
            lan_dial_tick(&db, &status, &ev_tx, &cfg, Some(&seat), slot, face)
        };
        // 一枚 Hello 真被封发出去时,封帧那一步会把「发的是这份 listen」记进通告面。
        let sealed = |face: &mut AdFace, slot: &EngineSlot| {
            let seq = face.published.as_ref().map_or(1, |(n, _)| n + 1);
            face.published = Some((seq, slot.lan.listen.clone()));
        };
        let is_authoritative_hello = |o: &Output| {
            matches!(o, Output::Send { to, route_hint, msg: Msg::Hello { .. }, .. }
                if to == BROADCAST && *route_hint == RouteHint::Require(Route::Relay))
        };

        // ① 本会话还没发过通告 → 该广播一枚(**权威 Hello 恒走中转**,§2)。
        let outs = tick(&mut slot, Some(&face));
        assert_eq!(addrs(&slot), Some(vec![LAN_SELF_ADDR.to_string()]));
        assert_eq!(outs.len(), 1, "还没发布过就该发");
        assert!(is_authoritative_hello(&outs[0]), "该是广播 + 钉中转腿的 Hello,实见 {:?}", outs[0]);
        sealed(&mut face, &slot);
        // ② 发过了、又什么都没变:不重发(否则每 15s 一枚广播 Hello)。
        assert!(tick(&mut slot, Some(&face)).is_empty(), "已发布的内容不该重发");

        // ③ 换网(合成网卡换一张)= 通告地址跟着走,并重新广播。
        let _net2 = lan_net::TestNetGuard::install("10.9.0.5", 24);
        let outs = tick(&mut slot, Some(&face));
        assert_eq!(addrs(&slot), Some(vec!["10.9.0.5".to_string()]), "通告地址跟着换网走");
        assert_eq!(outs.len(), 1, "地址变了要重新广播");

        // ④ **那一枚没发成就还欠着**(codex 二轮 M2 漏口①):不更新通告面(= 封发失败),
        //    下一轮照样得发——判据不是「这一轮变了没有」。
        let outs = tick(&mut slot, Some(&face));
        assert_eq!(outs.len(), 1, "上一枚没发成,这一轮还欠着");
        sealed(&mut face, &slot);
        assert!(tick(&mut slot, Some(&face)).is_empty(), "发成了才算消费掉");

        // ⑤ **`Some → None` 也是一条该发的通告**(漏口②):接口枚举失败 → 本机不再监听,
        //    不把这条撤回发出去的话,对端会照着旧地址一直拨。
        let _net3 = lan_net::TestNetGuard::fail();
        let outs = tick(&mut slot, Some(&face));
        assert_eq!(addrs(&slot), None, "枚举失败 = 不通告 listen(§7 失败响亮不兜底)");
        assert_eq!(outs.len(), 1, "撤回也要发");
        sealed(&mut face, &slot);

        // ⑥ 中转不在:没有权威路可走故不产帧,但本机 listen 照样更新——下次会话仪式那枚
        //    广播 Hello 自然带上它。
        let _net4 = lan_net::TestNetGuard::install("172.16.3.4", 16);
        let outs = tick(&mut slot, None);
        assert!(outs.is_empty(), "中转不在就没有权威路,不产帧");
        assert_eq!(addrs(&slot), Some(vec!["172.16.3.4".to_string()]), "listen 照样更新");
    }

    /// §7 三条退避复位信号之一:**新通告**(codex 二轮 M1)。只把计时器拨到现在不算复位
    /// ——巡查照样被这台对端自己的退避挡住,「对端换了 IP 不必等 300s」就成了空话。
    #[test]
    fn a_fresh_advertisement_resets_that_peers_backoff() {
        let mut r = ad_rig("lan-dial-adkick");
        let (_s, pubkey) = crate::sync::pair::gen_device_key();
        r.slot.dial.backoff_for_test(PEER, 300);
        assert!(r.slot.dial.has_backoff(PEER), "先摆一份还没到期的退避");
        let outs = ad_ctx(&mut r).absorb_lan_ad(PEER, &ad_of(&pubkey, 1), Ingress::RelayDeliver, false);
        assert_eq!(outs.len(), 1, "首见钉住该回一帧定向 Hello(既有行为,顺带确认这一路真跑到了)");
        assert!(!r.slot.dial.has_backoff(PEER), "新通告 = 那台对端的退避复位,不是只唤醒计时器");
    }

    /// §7 三条退避复位信号之二:**网络变化**。它没有 OS 通知,判据是每轮接口枚举的
    /// **规范形**快照变没变(codex 二轮 M1:拿「本机 listen 变没变」当判据只有桌面管用,
    /// 手机压根没有 listen;二轮 L1:枚举顺序抖动不算变化,故先排序去重)。
    #[tokio::test]
    async fn a_local_network_change_resets_every_backoff() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let mut r = dial_rig("lan-dial-netreset", 53, false).await;
        r.round();
        assert_eq!(r.dial.attempts(), 1, "头一枚");
        wait_until("那一枚已收场", || r.dial.inflight() == 0).await;
        r.round();
        assert_eq!(r.dial.attempts(), 1, "退避没到,不该再拨(阴性对照)");

        // 换网:同号段换一张网卡(对端那个候选照样过得了过滤,故变的只有「网络」这件事)。
        let _net2 = lan_net::TestNetGuard::install("192.168.77.8", 24);
        r.round();
        assert_eq!(r.dial.attempts(), 2, "网络变了 = 全部退避复位,当场再拨");
    }

    /// codex 四轮 H1:**最终撤席之后,旧 runtime 的巡查不许把条目复活**。stop/reset 的
    /// 顺序是「先摘条目 → 再拉停机信号 → 最后等 transport 真退出」;而那个 transport 观察到
    /// 停机之前,它每 15s 一轮的拨号巡查还拿着**仍然存在的** `AdmitSeat`,一次幂等续注册就
    /// 能把条目插回去——「Stopping 之后不再认新链」那道闸就此重新打开。三半同测:正路在册、
    /// 旧代拒、新代放。
    #[tokio::test]
    async fn a_revoked_seat_is_not_resurrected_by_the_dial_tick() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let (db, _clock, _dir) = test_db("lan-dial-revoked");
        {
            let mut conn = db.lock().unwrap();
            save_config(&mut conn, ACCT, &[5u8; 32], &[64u8; 32], "ws://127.0.0.1:1", true).unwrap();
        }
        let cfg = {
            let conn = db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        let status = Arc::new(Mutex::new(SyncStatus::default()));
        let (ev_tx, _ev_rx) = mpsc::unbounded_channel();
        let adm = LanAdmission::ephemeral();
        let (handoff, _rx) = mpsc::channel(LAN_HANDOFF_CAP);
        let seat = |owner: u64| AdmitSeat {
            host: LanHost { space_id: "s1".into(), admission: Arc::clone(&adm), owner },
            owner,
            handoff: handoff.clone(),
        };
        let (dial_handoff, _dial_rx) = mpsc::channel(LAN_HANDOFF_CAP);
        let (mut slot, _lan_rx, _faults) = EngineSlot::new(BlobPolicy::Full, Some(dial_handoff));
        {
            let conn = db.lock().unwrap();
            slot.reconcile(&conn, &cfg).unwrap();
        }
        // 这一代 runtime 正常在册(巡查那一手就把条目注册上了)。
        lan_dial_tick(&db, &status, &ev_tx, &cfg, Some(&seat(7)), &mut slot, None);
        assert!(adm.epoch_of("s1").is_some(), "正路:巡查会幂等续注册");

        // supervisor 形的最终撤席(stop / begin_reset 走的正是这条)。
        adm.revoke("s1", 7);
        assert!(adm.epoch_of("s1").is_none(), "撤席即摘条目");

        // 旧 runtime 还没观察到停机,巡查又来了一轮:**不许复活**。
        lan_dial_tick(&db, &status, &ev_tx, &cfg, Some(&seat(7)), &mut slot, None);
        assert!(adm.epoch_of("s1").is_none(), "已撤销的代次不许把条目插回去");
        assert!(slot.lan.listen.is_none(), "注册被拒 = 不通告监听落点");
        assert!(status.lock().unwrap().lan_warning.is_some(), "拒绝该有人话");

        // 新 runtime(更高代次)照常:撤席不是「这个空间从此不能直连」。
        lan_dial_tick(&db, &status, &ev_tx, &cfg, Some(&seat(8)), &mut slot, None);
        assert!(adm.epoch_of("s1").is_some(), "新 runtime 该注册得上");
        assert!(slot.lan.listen.is_some(), "监听落点回填了");
    }

    /// codex 三轮 H1:**缓存里一台对端都没有时,桌面的巡查计时器不许摘**。本机通告地址的
    /// 刷新与准入注册的重试现在只由这条巡查驱动,摘了就没有「下一轮」——非对称缓存(§2
    /// 明确认可并专门设计了补钥流程的那个态)下换网,本机的新地址永远发不出去,而按方向
    /// 规则本该拨过来的对端正拿着旧地址。手机壳没有这半件事,那时才可以整个摘掉。
    #[tokio::test]
    async fn an_empty_peer_cache_still_keeps_the_local_ad_poll_armed() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let mut r = dial_rig("lan-dial-emptycache", 55, false).await;
        forget_peer_ad(&r.db, DIAL_PEER); // 缓存清空 = 一台对端都不认识
        // 桌面形(有监听席位):拨号没得做,但巡查照挂。
        {
            let DialRig { db, cfg, dial, .. } = &mut r;
            let warned = dial.round(
                &cfg.account_id, &cfg.device_id, &cfg.k_acc, &cfg.device_seed, db, true, true,
                &|_| false,
            );
            assert_eq!(warned, None);
        }
        assert!(r.dial.due().is_some(), "有监听席位就得留着计时器(通告刷新只靠它)");
        // 手机形(无席位):那半件事不存在,整个摘掉等 kick。
        {
            let DialRig { db, cfg, dial, .. } = &mut r;
            dial.round(
                &cfg.account_id, &cfg.device_id, &cfg.k_acc, &cfg.device_seed, db, false, false,
                &|_| false,
            );
        }
        assert!(r.dial.due().is_none(), "手机形没有通告面要巡查,摘掉不空转");
    }

    /// 上一条的**编排形**(codex 三轮点名:补测必须走真实 `dial_due → select → Woke::Dial`,
    /// 不能直接连着调 helper)。观测面 = 准入表的注册次数:每轮巡查都会幂等续注册一次,而
    /// 这台 rig 的中转退避此刻已经涨到几秒一次,故短窗口里的增长只可能来自巡查。
    #[tokio::test]
    async fn the_dial_tick_keeps_firing_from_the_real_timer_with_an_empty_cache() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let _poll = lan_net::IdlePollGuard::install(50);
        let r = listen_rig("lan-dial-timer", 56).await;
        // 缓存空着(这台 rig 从没 pin 过对端),等中转退避涨起来再取样。
        wait_until("已退到离线等待", || r.status.lock().unwrap().state == "offline").await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let before = r.adm.registrations();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let grew = r.adm.registrations() - before;
        assert!(grew >= 4, "500ms 里该有 ~10 轮巡查,实见 {grew} 次续注册(计时器被摘了?)");
        let _ = r.shutdown.send(true);
        let _ = r.task.await;
    }

    /// codex 二轮 L1:**同一组网卡换个枚举顺序不算网络变化**。OS 的枚举顺序不保证稳定,
    /// 不规范化的话顺序一抖就误判换网——白发一枚权威 Hello、白烧一个通告序号、还把全部
    /// 退避清了。阳性对照在同一条里:真换掉一张网卡就该复位。
    #[tokio::test]
    async fn reordering_the_interface_list_is_not_a_network_change() {
        let _net = lan_net::TestNetGuard::install_many(&[(LAN_SELF_ADDR, 24), ("10.9.0.5", 24)]);
        let mut r = dial_rig("lan-dial-reorder", 54, false).await;
        r.round();
        assert_eq!(r.dial.attempts(), 1, "头一枚");
        wait_until("那一枚已收场", || r.dial.inflight() == 0).await;

        // 同一组网卡,只把枚举顺序颠倒:不算变化,退避照压着。
        let _net2 = lan_net::TestNetGuard::install_many(&[("10.9.0.5", 24), (LAN_SELF_ADDR, 24)]);
        r.round();
        assert_eq!(r.dial.attempts(), 1, "顺序抖动不是网络变化(阴性对照)");

        // 真换一张网卡:该复位。
        let _net3 = lan_net::TestNetGuard::install_many(&[("192.168.77.8", 24), ("10.9.0.5", 24)]);
        r.round();
        assert_eq!(r.dial.attempts(), 2, "网卡真变了才算(阳性对照)");
    }

    /// codex L-c3b 一轮 M1:拨号面的失败**只进 advisory 槽**——接口枚举失败 / 一条读不动
    /// 的缓存记录,都不该盖掉「连不上服务器、冻结、隔离」这些正确性面的人话。会话循环与
    /// 离线泵两条出口共用 `lan_dial_tick` 这一个沉淀点,故这条盯住的就是那个点。
    /// 顺带钉住诊断去重:同一条持续态不许每 15s 重刷一次状态面。
    #[tokio::test]
    async fn a_dial_failure_only_lands_in_the_advisory_slot() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let (db, _clock, _dir) = test_db("lan-dial-advisory");
        {
            let mut conn = db.lock().unwrap();
            save_config(&mut conn, ACCT, &[5u8; 32], &[63u8; 32], "ws://127.0.0.1:1", true).unwrap();
            // 一条读不动的缓存记录(§2:读不动一律响亮,绝不当「没缓存」)。
            meta_put(&conn, &lan_peer_key(DIAL_PEER), "这不是 hex").unwrap();
        }
        let cfg = {
            let conn = db.lock().unwrap();
            load_config(&conn).unwrap().expect("已配置")
        };
        // 正确性面先摆一句人话当探针。
        let status = Arc::new(Mutex::new(SyncStatus {
            error: Some("连不上服务器(探针)".into()),
            ..Default::default()
        }));
        let (ev_tx, _ev_rx) = mpsc::unbounded_channel();
        let (dial_handoff, _dial_rx) = mpsc::channel(LAN_HANDOFF_CAP);
        let (mut slot, _lan_rx, _faults) = EngineSlot::new(BlobPolicy::Full, Some(dial_handoff));
        {
            let conn = db.lock().unwrap();
            slot.reconcile(&conn, &cfg).unwrap();
        }
        // 没有席位 = 手机形(不监听),故这一轮只做拨号那半件。
        lan_dial_tick(&db, &status, &ev_tx, &cfg, None, &mut slot, None);
        {
            let s = status.lock().unwrap();
            assert_eq!(s.error.as_deref(), Some("连不上服务器(探针)"), "正确性槽一个字都不许动");
            assert!(s.lan_warning.is_some(), "诊断该落在 advisory 槽里");
        }
        // **仍在持续的故障要回得来**(codex 二轮 M3):`lan_warning` 是多个生产者共享的
        // 单槽,拨号器若自己记「这条报过了」,别的诊断一覆盖,这条仍在阻断全部拨号的故障
        // 就再也显不出来。刷屏由 `set_status` 的「快照没变不发事件」兜着,不必自己去重。
        status.lock().unwrap().lan_warning = Some("别的诊断盖了一下".into());
        lan_dial_tick(&db, &status, &ev_tx, &cfg, None, &mut slot, None);
        assert!(
            status.lock().unwrap().lan_warning.as_deref() != Some("别的诊断盖了一下"),
            "被盖掉之后,仍在持续的故障要重新报出来"
        );
    }

    /// **每对端至多一只在飞握手不是冗余闸**(codex L-c3b 一轮 L1 判掉了我方「退避 15s >
    /// 全握手 10s,故拆了也没事」的说法):`peer{online}` 与中转重连都会在握手**途中**清
    /// 退避,那一刻若没有这道闸,下一轮巡查就会对同一台对端再开一只任务。
    /// 阳性对照在同一条里:那只握手真收场之后,同样的复位就该拨得动。
    #[tokio::test]
    async fn a_backoff_reset_mid_handshake_does_not_start_a_second_dial() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let mut r = dial_rig("lan-dial-inflight", 51, true).await;
        let l = r.listener.take().expect("假对端在听");
        r.round();
        // 接了连接但一言不发:那只握手停在「等 Accept」的 2 秒里。
        let (sock, _) =
            timeout(Duration::from_secs(2), l.accept()).await.expect("该有人拨进来").expect("accept");
        assert_eq!(r.dial.inflight(), 1);

        // 中转重连:全部退避复位——**握手还在飞,不许再开一只**。
        r.dial.kick_all();
        r.round();
        assert_eq!(r.dial.attempts(), 1, "在飞闸挡住第二只(阴性对照)");
        assert_eq!(r.dial.inflight(), 1, "还是那一只");

        // 阳性对照:让那只收场(对端关掉 socket → 读 Accept 当场失败),复位就拨得动。
        drop(sock);
        wait_until("那一只已收场", || r.dial.inflight() == 0).await;
        r.dial.kick_all();
        r.round();
        assert_eq!(r.dial.attempts(), 2, "收场之后同样的复位该拨得动");
    }

    /// §6 ⑤「stop / 撤位要同时取消**入站与出站**全部未移交的握手任务」的出站那一半。
    /// 把一枚出站握手停在等 Accept 那一步,撤位 → 任务当场没,socket 随之落地。
    #[tokio::test]
    async fn retiring_the_slot_cancels_an_in_flight_dial() {
        let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
        let mut r = dial_rig("lan-dial-retire", 50, true).await;
        let l = r.listener.take().expect("假对端在听");
        r.round();
        // 接下它的连接但一言不发:拨号任务就停在「等 Accept」的 2 秒里。
        let (sock, _) =
            timeout(Duration::from_secs(2), l.accept()).await.expect("该有人拨进来").expect("accept");
        assert_eq!(r.dial.inflight(), 1, "此刻恰有一只在飞的出站握手");
        r.dial.retire();
        assert_eq!(r.dial.inflight(), 0, "撤位当场取消,不等它自己超时");
        assert!(r.dial.due().is_none(), "撤位期不挂巡查计时器");
        let mut link = FakeLink { stream: sock };
        assert!(link.closed(1000).await, "取消掉的握手该把 socket 一起带走");
    }
}
