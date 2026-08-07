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
use std::sync::{Arc, Mutex, MutexGuard};
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
use crate::sync::probe::p305;

// ---- 子模块(310 第 ② 笔:本文件曾 15,562 行,按「用得着什么借用面」切开)----------
//
// 切法不是按主题凑的,是按**跨模块引用面**量出来的:子模块看得见父模块的私有条目,
// 故搬出去的代价 = 它自己有多少条目要被父模块回头用(那些标 `pub(super)`)。
// 六块的代价分别是 1 / 5 / 3 / 1 / 2 / 2 —— 真正抱成一团的那部分(类型面、运行骨架、
// 会话原语、在飞账本、LAN 链路集、Ctx 的字段)**刻意留在本文件**:切开它们要给 76% 的
// 顶层条目加可见性,换不到封装。
//
// ⚠ 新增子模块必须同时加进 tests.rs 的 `transport_sources()` —— 那张表是全文式结构锚的
// 扫描面,漏进表的文件它们**一个字都看不见**(静默变绿,不报错)。由
// `every_transport_submodule_is_scanned` 强制。
mod account;
mod ad_deck;
mod ctx_impl;
mod deck;
mod lan_pump;
/// M3 网络栈真机闸门诊断(android-plan §9)。两壳的「诊断」入口按 `transport::net_probe` 调,
/// 故这两个名字要在 `transport` 这一层看得见 —— 子模块本身不公开。
mod selftest;
mod session_loop;

pub use account::{create_account, pair_join};
pub use selftest::{net_probe, ProbeStep};
use account::create_account_as;
use ad_deck::{offline_deck, AdDeck};
use deck::{Deck, RelayLeg};
use lan_pump::{lan_read_pump, lan_write_pump};
use session_loop::session;

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
/// **锁序 db → work,而本函数是全仓唯一一处自己动手取两把锁的地方**(第④笔的 relay 泵要提交
/// 游标时应复用本函数这条次序),故不存在反序取锁的对家。引擎那半也有同持两把的路
/// (`Engine::hello_watermarks`),但它的库锁恒是调用方借来的 `&Connection` —— `engine.rs`
/// 结构上取不到库锁,故那几处无从反序。全部上锁点的名单与分类见
/// `ops_lock_sites_are_allowlisted`。
///
/// 取数与空转提交本身在 [`ops_prepare_locked`] 里 —— 那只 helper **只借得到库锁的守卫**,
/// 故它放不掉锁;而守卫在这里被它借着,这一层也放不掉。见那只 helper 的抬头。
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
    // **生产调用也走那枚借用型 fn 指针**(codex 实现审 307 轮二次 M)。一轮改完之后还剩一条
    // 绕法:helper 改成泛型(`conn: impl ConnView`),测试那一侧单态化成借用、生产这一侧传
    // 所有权,于是提交前照样放得掉锁。强制成 fn 指针之后,**这次调用在类型上只可能把守卫
    // 借出去**。经实测那条泛型绕法今天连测试侧都编译不过(fn 指针是高阶 `for<'c,'d>`,而
    // 泛型类型参数早绑定、必须是单一具体类型),故这几行是**冗余的第二道** —— 留着的理由
    // 是不让「放不掉锁」依赖一条这么微妙的推导规则,也不让它随那只测试一起被删掉。
    const PREPARE_LOCKED: fn(
        &ServeCtx,
        &str,
        &MutexGuard<'_, Connection>,
        &mut ops_serve::OpsWorks,
    ) -> OpsTurn = ops_prepare_locked;
    PREPARE_LOCKED(ctx, target, &conn, &mut works)
}

/// 取数 + 空转提交 —— **两件必须落在同一段持锁期里,由类型封死**(305 排队第 1 条)。
///
/// 「读空 → 段退役」([`ops_serve::Advance::RangeDrained`])是唯一能让补洞段出队的
/// advance,而它的**全部安全性**就在于:产出它的那次读与它的提交之间写者插不进来。插得
/// 进来的话,中间新写的 op 会被 `on_want` 合并进这一段(合并对更晚的起点是空操作),再随
/// 段一起退役 = **静默丢**,且没有续做所有者(`outbound` 的内存游标已经推过去了)——那正是
/// 303 量出、305 修掉的「推送唤醒活性缺口」。发帧那一支之所以改成**不**退役,正因为它的
/// 提交要等一个中转往返,这个前提对它不成立。
///
/// 305 首版靠一条读源码文本的结构锚守这件事,而 codex 实现审两轮各给出一段能编译、能过
/// 全部断言的绕法(`let released = conn; drop(released);` / `std::mem::drop::<_>(conn)`)
/// —— 文本挡不住改名后再放。**现在改由借用检查器守**:
///
/// * `conn: &MutexGuard<'_, Connection>` —— helper 拿到的是**借**,不是所有权,故它没有
///   任何写法能提前释放这把锁(改名也好、绕路调 `drop` 也好,放的都不是守卫本身);
/// * 调用方([`ops_prepare`])在这次调用期间把守卫借了出去,故它也放不掉。
///
/// 剩下**仍需按源码钉**的只有「这两件真的都在这只 helper 体内」与「这个形参真的是借」
/// ——见 `the_drained_gap_commit_stays_inside_the_read_critical_section`。
///
/// 有帧那一支返回的 [`OpsTicket`] 照旧**不带连接生命期**(relay 的 Ack 才提交),
/// `prepare_next` 不推进游标的基础契约一格不动。
fn ops_prepare_locked(
    ctx: &ServeCtx,
    target: &str,
    conn: &MutexGuard<'_, Connection>,
    works: &mut ops_serve::OpsWorks,
) -> OpsTurn {
    // 取数次数的可观测面(仅测试):「没活就灭 armed」这条规则在线上字节、状态面、武装
    // 发号器三格全同形,只有「还在不在反复摸库」分得开(实现审 M2)。
    #[cfg(test)]
    works.note_probe();
    let Some(work) = works.work_mut(target) else {
        p305!("prepare target={target} -> Idle(无 work)");
        return OpsTurn::Idle;
    };
    match work.prepare_next(conn) {
        Err(e) => OpsTurn::Failed(e),
        Ok(ops_serve::Prepare::Idle) => {
            p305!("prepare target={target} -> Idle(work empty)");
            OpsTurn::Idle
        }
        Ok(ops_serve::Prepare::Occupied) => {
            p305!("prepare target={target} -> Occupied(在飞)");
            OpsTurn::Occupied
        }
        Ok(ops_serve::Prepare::Ready(p)) => match p.frame {
            // 空转:没字节可写,但游标得往前走,就在这个临界区里办完——凭据不出门,也就
            // 没有「空转的凭据谁来回滚」这种形。
            None => match work.commit(p.token) {
                Ok(()) => {
                    p305!("prepare target={target} -> Spun(空探,0 字节不上线)");
                    OpsTurn::Spun
                }
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

#[cfg(test)]
mod tests;
