//! 账户内路由 + 内存信箱 + 配对盲桥(sync-protocol §4)。
//!
//! 全部状态纯内存——**重启即失是规格**(信箱只是加速器,真相在设备日志,丢帧由
//! 水位协议自愈,§11)。锁纪律(H1 吊销落地后收紧):`registry` 与 `state` 两把
//! std Mutex **固定顺序 registry → state、可嵌套、绝不跨 await**;attach /
//! route_send / revoke_device 全程持 registry 锁完成 state 侧动作——吊销必须与
//! 「上线 / 投递 / 背书注册」在同一条线性化边界内,否则 revoke 与它们的间隙里
//! 被吊设备能重新上线、重建已清信箱、背书新设备(codex P4-e 轮 H1-H3)。
//!
//! * **每收件设备一条 FIFO 队列(信箱与实时同队)**:每在线连接一条 mpsc,容量 =
//!   `mailbox_max_frames + REALTIME_HEADROOM`——attach 在锁内把信箱搬进 channel
//!   (逐帧「出队成功才算」,满/死时余帧留箱,无丢失窗口),之后实时帧继续排
//!   同一条队,天然保序(§4)。
//! * **关断走专线**:每连接另有一条 cap=1 的 kick 通道,顶替旧连接与慢客户端
//!   摘除都走它——控制信号绝不排在可能满的数据队列后面(codex P2-e 轮 H1/H2)。
//! * **慢客户端**:实时投递 `try_send` 失败(队满 = 收不动)→ 摘下线 + kick 断连 +
//!   向账户内广播 offline,该帧与后续按离线逻辑走(mail 入箱 / direct 丢);已在
//!   队里没写出去的帧随连接死——等价于 TCP 缓冲丢失,ack 语义(§5.2「服务器已
//!   接手」≠ 对端已收)容此。
//! * 时间源用 `tokio::time::Instant`(TTL/槽过期)。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use sync_proto::{
    err_code, DataPlane, DeviceAction, Lane, PairEvent, Restriction, RosterEntry, ServerMsg,
    BROADCAST,
};
use tokio::sync::{mpsc, Notify};
use tokio::time::Instant;

use crate::logln;
use crate::registry::{Entitlement, Registry, RevokeError, RevokeOutcome, SetEntitlementError};
use crate::throttle::{AdmitDecision, PollOutcome, WaitHandle};
use crate::Config;

/// 下行数据队列(协议消息)。
pub type Tx = mpsc::Sender<ServerMsg>;
/// 关断专线(cap=1;收到即断开连接)。
pub type KickTx = mpsc::Sender<()>;
/// 单连接下行队列的**已入队 Deliver 字节数**(epoch-plan §5.2 统一预算的 mpsc 容器
/// 侧账本):hub 入队时加、conn.rs 写任务出队时减、连接死则整个计数随 Client 摘除
/// 而退出派生——预算用量**派生不存**(项目铁律),不存在「还 permit」的泄漏面。
pub type QueuedBytes = Arc<AtomicUsize>;

fn push(tx: &Tx, msg: ServerMsg) -> bool {
    tx.try_send(msg).is_ok()
}

/// **全仓唯一发 [`ServerMsg::Roster`] 的地方**(367)。在途上界见 [`MAX_ROSTER_INFLIGHT`];
/// 计数由 conn.rs 的写任务出队时减,两侧靠「变体」对齐(加的这里只发 Roster,减的那里
/// 只认 Roster)—— 单一发送点是这条对齐的结构前提,别在别处 `push` 一枚 Roster。
///
/// ⛔ **三件事的顺序是这道账的全部正确性**(实现审弹二 M2/L3),别改:
///
/// 1. **先占 mpsc 槽**(`try_reserve`)。它同时买到两件事:发送**不可能再失败**(于是
///    没有「加了额度又要还回去」那条路),以及**通道满时连名册都不构造**。
/// 2. **再原子预占名册额度**(`fetch_update` 把「`< MAX`」与「`+1`」合成一步)。
///    先发后记账会漏出一条**永久幽灵额度**:`try_send` 成功 → 写任务在另一线程出队并
///    `saturating_sub`(此刻账本还是 0,减不动)→ 这边才 `fetch_add` ⇒ 队里没有 Roster
///    而账本多一。攒够 4 次,这条连接**此后一枚名册都发不出去**,且再没有任何真实帧
///    能把幽灵数减回来(推送与周期拉取同走这里 ⇒ 名册面整条哑掉,直到重连)。
///    CAS 顺带把「并发过冲」也一起封了 —— 我原来那句「允许微量过冲」不必要地把闸放松了。
///    ⚠ 顺序不能倒:先占额度再占槽,槽占不到就又要还额度,那条归还路正是幽灵的来源。
/// 3. **两样都占到了才构造**(`build` 惰性):`build_roster` 要克隆整份名单**并推进全局
///    revision**。放在预占之前,一台不读下行的设备就能靠猛发 `RosterReq` 让服务器
///    反复构造、丢弃整份名册(它那道 5s 间隔闸**只在真答了才推进基点**,答不出去就
///    不设防)—— 拒发前的大对象构造是白烧的 CPU 与 allocator 压力。
fn push_roster(tx: &Tx, inflight: &RosterInflight, build: impl FnOnce() -> ServerMsg) -> bool {
    let Ok(permit) = tx.try_reserve() else {
        return false;
    };
    if inflight
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
            (v < MAX_ROSTER_INFLIGHT).then_some(v + 1)
        })
        .is_err()
    {
        return false;
    }
    let msg = build();
    debug_assert!(matches!(msg, ServerMsg::Roster { .. }), "push_roster 只发 Roster");
    permit.send(msg);
    true
}

/// 用户面设备管理的**授权判据**(identity-plan §5.3)。
///
/// ⛔ **全仓只此一份正式子**,别处一律调它、不许复述(§5.3 一轮 H1:规格里散文写对了
/// 而错误表把它写松成「不是管理设备**且** `target != caller` → 拒」,于是非管理设备发
/// `GrantAdmin{target: 自己}` 落在 `target == caller` 上 —— **绕过整条闸直接自我提权**。
/// 规格内部不一致时,实现会照抄松的那份)。
///
/// ```text
/// authorized = caller_is_admin
///           OR (action == Remove AND target == caller)   // 自助退出是唯一的非管理设备许可
/// ```
pub(crate) fn device_admin_authorized(
    caller_is_admin: bool,
    action: DeviceAction,
    target_is_caller: bool,
) -> bool {
    caller_is_admin || (matches!(action, DeviceAction::Remove) && target_is_caller)
}

/// 预算计费口径(§5.2,二弹二轮修):计 [`ServerMsg::Deliver`] 与 [`ServerMsg::PairMsg`]
/// 的 blob 字节——两类带无界内容体的帧都走**连接实际账本**(hub 入队加、conn.rs 写
/// 任务出队减);槽累计值只负责单槽配额,不兼任内存账本(否则烧槽即释放预算、而
/// 帧还躺在接收方 mpsc 里,循环烧槽可绕过硬顶)。控制帧由 channel 帧数上限约束。
pub fn deliver_cost(msg: &ServerMsg) -> Option<usize> {
    match msg {
        ServerMsg::Deliver { blob, .. } | ServerMsg::PairMsg { blob, .. } => Some(blob.len()),
        _ => None,
    }
}

/// 实时帧在「信箱整箱搬入之外」的队深余量。
pub(crate) const REALTIME_HEADROOM: usize = 1024;

/// 本连接下行队里还没写出去的 [`ServerMsg::Roster`] 枚数(367)。侧账本,形同
/// [`QueuedBytes`]:hub 推时加、conn.rs 写任务出队时减,连接死则随 Client 摘除。
pub type RosterInflight = Arc<AtomicUsize>;

/// 每连接在途名册帧上界(367)。
///
/// ⛔ **这道闸是实现期算出来的,设计 §5.13 那张表把这一格记成「过」——按实测不成立。**
/// 既有连接内存包络按 `size_of::<ServerMsg>() × 槽数` 算(216 B × 9216 ≈ 1.9 MiB),
/// **不含每枚 roster 克隆的 `Vec`/`String` 堆内存**。满额 roster 的堆是 1,856 B,槽若
/// 占满就是 **16.3 MiB/连接**;32 条连接合计 **647 MiB**,而包络上限是 448 MiB
/// (`MEMORY_ENVELOPE_BYTES`)⇒ 慢速填队能把进程推过 `MemoryMax=512M`。
///
/// 触及上界时**跳过这一枚推送**,而不是排队等着 —— 名册推送本来就允许丢(服务端
/// `push` 就是 `try_send().is_ok()`),客户端的周期拉取是恒在轴、丢了会自己补回来
/// (§5.4)。故这道闸不引入新的失败语义,只是把「可以丢」这件事提前做掉。
///
/// 4 × 1,856 B ≈ 7.4 KiB/连接,对包络的贡献可忽略。
pub(crate) const MAX_ROSTER_INFLIGHT: usize = 4;

/// 旧客户端受限时 account_throttled 的人话(§6:现有状态面至少一条可见错误;客户端
/// human_err 兜底会显它)。声明 `account_status_v1` 的新客户端改收 AccountStatusV1。
const THROTTLE_MSG: &str = "账户本月高速额度已用尽,同步降速中(升级客户端可见详情)";

/// **主动(无编号)`Err` 推送的唯一构造点**(367)。
///
/// ⛔ 它绝不许使用任何 flow 白名单里的 code:客户端对无编号 `Err` 的归属判据就是
/// `sync_proto::err_code` 里那两张表,复用其中一个就会把**正在等结果的**
/// `DeviceAdmin` / `Pair` flow 提前错误结账(§5.5 三轮 H1 的成因就是这条老推送)。
///
/// ⚠ 五轮 L1 把「白名单对将来任何新增的主动推送都免疫」那句话打掉了 —— 准确条件是
/// 「将来的主动推送必须用一个**不在**表里的 code」。这道 `debug_assert` 就是那条
/// **可执行的维护契约**:写规矩在注释里,这个仓的历史证明它腐烂得很快。
fn advisory_err(code: &str, msg: &str) -> ServerMsg {
    debug_assert!(
        !err_code::PAIR_FLOW_ERRORS.contains(&code)
            && !err_code::DEVICE_ADMIN_FLOW_ERRORS.contains(&code),
        "主动推送用了 flow 白名单里的 code `{code}`——客户端会把它认给正在等结果的命令"
    );
    ServerMsg::Err { code: code.to_owned(), msg: msg.to_owned() }
}

/// (account, device)。
type Addr = (String, String);

/// 用户面设备管理的失败面(367;→ 信封 err code 的映射见 conn.rs 那一臂)。
/// **每一格对应 §5.5 错误表的一行**,顺序即语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceAdminError {
    /// ⓪ 发起方已不在册 / 已换钥 / 这条连接已不是它的当前在线连接(H-ABA)。
    /// → `auth_failed` 且**断连**(同 SeatLease 的「本设备已被吊销」)。
    Unauthorized,
    /// ⓪ 账户被封禁 → `auth_failed` 且**断连**。
    Banned,
    /// ① `admins` 为空(存量未回填)→ `bad_request`,不断连。
    NoAdmins,
    /// ② 授权判据不成立 → `bad_request`,不断连。
    Forbidden,
    /// ③ target 不在本账户 → `unknown_device`,不断连。
    UnknownTarget,
    /// 账户级限频 → `busy`,不断连。
    Busy,
    /// ⑤ 这一步会让 `admins` 变空 → `bad_request`,不断连。
    WouldEmptyAdmins,
    /// ⑥ registry 落盘失败 → `internal`,不断连(未生效,可重试)。
    Persist,
}

impl DeviceAdminError {
    /// 这一格要不要断连。只有 ⓪ 那两格断——业务判定一律回错不断连。
    pub fn is_fatal(self) -> bool {
        matches!(self, DeviceAdminError::Unauthorized | DeviceAdminError::Banned)
    }
}

pub struct Hub {
    pub cfg: Config,
    pub registry: Mutex<Registry>,
    state: Mutex<HubState>,
    /// 达量限速计量 + ticket 调度(169,工序 3;第三把锁)。锁序扩为
    /// **registry → state / registry → meters**;绝不 `state → meters`、`meters → *`、
    /// 跨 `.await`。准入决策(读 grant + 计数 + enqueue)在 registry→meters 内原子完成。
    meters: Mutex<crate::throttle::Meters>,
    /// graceful shutdown 计量准入栅栏(169,codex 实现审 H-3):conn 在 decode 后、
    /// registry 锁前 `admission_enter`;shutdown 关栅 + 等 active 归零(所有 in-flight
    /// 计数完成)再 final flush ⇒ 已进帧计入、未进帧确定拒,栅栏线性化两侧。
    adm_closing: AtomicBool,
    adm_active: AtomicUsize,
    adm_drained: Notify,
    /// checkpoint 阈值事件唤醒(dirty ≥ 阈值即 notify worker,事件驱动非轮询——
    /// codex 实现审 M:高流量下轮询窗口可远超 16MiB)。
    checkpoint_nudge: Notify,
    conn_seq: AtomicU64,
    /// AccountStatusV1 修订号(工序4;单次启动内单调、跨重启复位——§6 取舍,不引
    /// server_instance_id)。每 build 一次 checked 自增,到顶 fail-fast 不回绕。
    status_revision: AtomicU64,
    /// 权威名册修订号(367,§5.4)。**全局单调**(规格只要求单账户单调,这是它的加强
    /// ——客户端只做大小比较,故无副作用,且省一张 per-account 的表)。单次启动内
    /// 有效、跨重启复位:重启必然断连、会话必然重建、客户端名册必然回「不知道」,
    /// 这一格由会话边界自然闭合(故不需要 `server_instance_id`)。
    roster_revision: AtomicU64,
    /// 全局连接 permit(2026-07-31 评审:连接耗尽 DoS 闸,容量 = cfg.max_conns)。
    /// upgrade 前 try_acquire,连接任务 RAII 持有到死;停机关栅时 close(拒新=503)。
    conn_permits: std::sync::Arc<tokio::sync::Semaphore>,
    /// 创号闸拒绝日志聚合(2026-07-31 codex M3:逐条打日志=journal 放大器)。
    /// (上次落线, 上次 ERROR 落线, 窗口内限流数, 窗口内目录满数)——ERROR 有独立
    /// 时间戳:目录满要能**跳过** INFO 窗口立即出线(二轮 M1),但自己也 60s 限一次。
    signup_log: Mutex<(Option<Instant>, Option<Instant>, u64, u64)>,
}

#[derive(Default)]
struct HubState {
    online: HashMap<Addr, Client>,
    /// 已从 online 摘除、writer 仍可能持有队列内存的连接账本(二弹 M:摘线早于
    /// 内存真实释放,预算若立即少算这块,驱逐循环会把仍占内存的 32MiB 队列当已
    /// 释放再收新帧)。strong_count==1 = conn 侧句柄全灭、内存已随通道 drop 释放,
    /// 扫描时顺手剪掉。
    draining: Vec<(String, QueuedBytes)>,
    mailboxes: HashMap<Addr, Mailbox>,
    slots: HashMap<u64, PairSlot>,
}

struct Client {
    conn_id: u64,
    tx: Tx,
    kick: KickTx,
    /// 本连接下行队里未写出的 Deliver 字节(§5.2 账本;见 [`QueuedBytes`])。
    queued: QueuedBytes,
    /// 本连接是否声明了 `account_status_v1` 能力(工序4):决定 push 推
    /// [`ServerMsg::AccountStatusV1`](cap)还是受限时的 `account_throttled`(旧客户端)。
    wants_status: bool,
    /// 本连接是否声明了 `device_roster_v1` 能力(367):名册三条**只发给声明者**
    /// ——未声明者收到未知变体会 DecodeError 断连。
    wants_roster: bool,
    /// 本连接下行队里未写出的 Roster 枚数(见 [`MAX_ROSTER_INFLIGHT`])。
    roster_inflight: RosterInflight,
}

#[derive(Default)]
struct Mailbox {
    frames: VecDeque<MailFrame>,
    bytes: usize,
    /// 溢出 + TTL 丢弃累计(只记计数,永不记内容;sweep 时打日志)。
    dropped: u64,
}

struct MailFrame {
    at: Instant,
    cost: usize,
    msg: ServerMsg,
}

struct PairSlot {
    /// 开槽者账户(二弹 H:配对桥字节计入其账户份额;joiner 未鉴权,同计于此)。
    account: String,
    owner_conn: u64,
    owner_tx: Tx,
    /// (conn_id, 下行 tx, 队列账本, kick 专线)。kick(2026-07-31 codex H1):槽死
    /// = 未鉴权 joiner 的存在理由消失,当场断连归还连接 permit——否则 ping 保活的
    /// 僵尸 joiner 每只可占位「槽 TTL+余量」,循环铸造能打满全局连接闸。
    joiner: Option<(u64, Tx, QueuedBytes, KickTx)>,
    opened: Instant,
    /// 单次使用(§4):join 过即烧,第二个 join 恒拒——服务器 MITM 对 SECRET
    /// 的在线猜测恒只有一次。
    used: bool,
    /// 配对桥累计转发量(epoch-plan §5.2 #5:每槽专用小配额,超即烧槽)。
    /// 累计而非在途——SPAKE2 一次交换只需几帧,配额是量级护栏不是流控;
    /// 累计值同时是该槽在途字节的上界,计入全局预算派生。
    relayed_frames: u64,
    relayed_bytes: usize,
}

impl Hub {
    pub fn new(cfg: Config, mut registry: Registry) -> Self {
        // 免费档 fastlane 从 Config 注入 registry(169;生产 300MiB,测试小值烤限速)。
        registry.set_free_fastlane(cfg.free_fastlane_bytes_per_month);
        // 免费档席位数从 Config 注入(推广期生产 4,测试默认 2)。
        registry.set_free_seat(cfg.free_seat_quota);
        // 创号闸参数从 Config 注入(2026-07-31 评审;测试注小值烤洪泛路径)。
        registry.set_signup_limits(cfg.signup_burst, cfg.signup_refill, cfg.max_accounts);
        let conn_permits = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.max_conns));
        Hub {
            cfg,
            registry: Mutex::new(registry),
            state: Mutex::new(HubState::default()),
            meters: Mutex::new(crate::throttle::Meters::new()),
            adm_closing: AtomicBool::new(false),
            adm_active: AtomicUsize::new(0),
            adm_drained: Notify::new(),
            checkpoint_nudge: Notify::new(),
            conn_seq: AtomicU64::new(1),
            status_revision: AtomicU64::new(1),
            roster_revision: AtomicU64::new(1),
            conn_permits,
            signup_log: Mutex::new((None, None, 0, 0)),
        }
    }

    /// 创号闸拒绝的聚合日志:INFO 与 ERROR **各自** 60s 限频(带窗口内计数;首次
    /// 立即落线,目录满可跳过 INFO 窗口)。
    /// **目录满 0→1 强制冲刷**(codex 二轮 M1:窗口内只累计的话,「唯一那次目录满」
    /// 若后面再无请求就永远发不出来——容量事件一次都不许吞)。落线在锁外(stderr
    /// 阻塞不许变成锁队头拥塞)。
    pub fn log_signup_reject(&self, directory_full: bool) {
        if let Some(line) = self.signup_reject_line(directory_full) {
            logln(line);
        }
    }

    /// 聚合决策(单测入口):返回该落的整行(含级别前缀)或 None=窗口内继续累计。
    /// 目录满可跳过 INFO 窗口立即出 ERROR,但 ERROR 自己也按独立时间戳 60s 限一次
    /// (否则「冲刷清零计数 → 下一次目录满又是首例」会绕回逐条刷屏)。
    fn signup_reject_line(&self, directory_full: bool) -> Option<String> {
        const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
        let mut g = self.signup_log.lock().unwrap();
        let (last_any, last_err, throttled, full) = &mut *g;
        if directory_full {
            *full += 1;
        } else {
            *throttled += 1;
        }
        let err_due = directory_full && !last_err.is_some_and(|t| t.elapsed() < WINDOW);
        let any_due = !last_any.is_some_and(|t| t.elapsed() < WINDOW);
        if !err_due && !any_due {
            return None;
        }
        let now = Instant::now();
        *last_any = Some(now);
        if *full > 0 {
            *last_err = Some(now);
        }
        let line = format!(
            "创号闸拒绝:限流 {throttled} 次、目录满 {full} 次(60s 聚合;目录满=抬 max_accounts 或人工清理,见 deploy §2)"
        );
        let out =
            if *full > 0 { format!("ERROR {line}") } else { format!("INFO {line}") };
        *throttled = 0;
        *full = 0;
        Some(out)
    }

    /// 收一条新连接的许可(全局并发硬上界;2026-07-31 评审)。None = 满,**或停机
    /// 关栅已 close 信号量**(shutdown_admissions;两者对 upgrade 都是 503)。
    pub fn try_admit_conn(&self) -> Option<tokio::sync::OwnedSemaphorePermit> {
        self.conn_permits.clone().try_acquire_owned().ok()
    }

    /// 启动时从 sidecar 恢复计量记录(serve_inner 调用;`now` 给新建 meter 的
    /// committed_until 基点)。有序月份在 admission 时按墙钟再滚。
    pub fn restore_meters(&self, records: Vec<(String, crate::throttle::MeterRecord)>) {
        let now = std::time::Instant::now();
        self.meters.lock().unwrap().load_records(records, now);
    }

    pub fn next_conn_id(&self) -> u64 {
        self.conn_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// 每连接下行队列容量(见模块注释)。
    pub fn channel_cap(&self) -> usize {
        self.cfg.mailbox_max_frames + REALTIME_HEADROOM
    }

    /// 读一次 registry→meters 计量快照(工序4;调用方**须持 registry**,Required-2:
    /// used/quota/over 与 AccountStatusV1 字段同源一份)。返回 (有效 period, used, quota, over)。
    fn read_meter_snapshot(
        &self,
        reg: &Registry,
        account: &str,
        now_wall: time::OffsetDateTime,
    ) -> ((i32, u8), u64, u64, bool) {
        let now_month = crate::registry::month_of(now_wall);
        let (eff_period, used) =
            self.meters.lock().unwrap().account_fastlane_used(account, now_month);
        let quota = reg.effective_grant_quota(account, now_wall);
        (eff_period, used, quota, used > quota)
    }

    /// 组装 AccountStatusV1(工序4;**纯组装、不自锁**——调用方持 registry、快照已读好)。
    /// status_revision checked 自增(codex M5:不回绕,到顶 fail-fast)。
    fn build_account_status(
        &self,
        reg: &Registry,
        account: &str,
        now_wall: time::OffsetDateTime,
        eff_period: (i32, u8),
        used: u64,
        quota: u64,
    ) -> ServerMsg {
        let rev = self
            .status_revision
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| v.checked_add(1))
            .expect("status_revision 取号到顶(u64,不可能达到,fail-fast)");
        let effective = reg.effective_entitlement(account, now_wall);
        let configured = reg.configured_entitlement(account);
        let seat_count = u32::try_from(reg.devices_of(account).len())
            .expect("设备数超过 AccountStatusV1 u32 表示范围(硬帽远小于 u32::MAX,不可能达到)");
        // 生效可执行席位上限 = min(套餐席位, 硬帽)——展示真正能加到几台(codex M2)。
        // device_cap 是 usize;`as u32` 会在 >u32::MAX 时静默截断(实现审 M1),用饱和转换。
        let hard_cap = u32::try_from(self.cfg.device_cap).unwrap_or(u32::MAX);
        let seat_quota = effective.seat_quota.min(hard_cap);
        let over = used > quota;
        let (restriction_reasons, data_plane, effective_rate_bps) = if over {
            (vec![Restriction::FastlaneExhausted], DataPlane::RateLimited, self.cfg.throttle_rate_bps)
        } else {
            (Vec::new(), DataPlane::Open, 0)
        };
        let fmt = |t: time::OffsetDateTime| {
            t.format(&time::format_description::well_known::Rfc3339)
                .expect("UTC 时刻 RFC3339 格式化无失败路径")
        };
        ServerMsg::AccountStatusV1 {
            status_revision: rev,
            server_now: fmt(now_wall),
            configured_tier: configured.map(|e| e.tier.clone()),
            effective_tier: effective.tier,
            expires_at: configured.and_then(|e| e.expires_at).map(fmt),
            seat_count,
            seat_quota,
            fastlane_used: used,
            fastlane_quota: quota,
            restriction_reasons,
            effective_rate_bps,
            period_start: fmt(crate::registry::period_start_utc(eff_period)),
            period_end: fmt(crate::registry::period_end_utc(eff_period)),
            data_plane,
        }
    }

    /// 推送账户当前授权状态给全部在线连接(工序4;**内部,调用方须持 registry**)。
    /// Required-1/2/3:全程持 registry(revision 分配→state 入队序 == revision 序)、
    /// 单次快照(一份 used/quota/over)、registry→state 遍历 try_send。cap 恒推当前
    /// AccountStatusV1;旧客户端**仅当前仍受限**(over)才推 account_throttled——按当前
    /// 快照门控,不拿历史 newly_restricted 当当前态(codex M1:admin 解除后不误发)。
    fn push_status_locked(&self, reg: &Registry, account: &str, now_wall: time::OffsetDateTime) {
        let (eff_period, used, quota, over) = self.read_meter_snapshot(reg, account, now_wall);
        let status = self.build_account_status(reg, account, now_wall, eff_period, used, quota);
        let throttled = advisory_err(err_code::ACCOUNT_THROTTLED, THROTTLE_MSG);
        let st = self.state.lock().unwrap();
        for (_, c) in st.online.iter().filter(|((a, _), _)| a.as_str() == account) {
            if c.wants_status {
                push(&c.tx, status.clone());
            } else if over {
                push(&c.tx, throttled.clone());
            }
        }
    }

    /// 构一枚权威名册(367,§5.4;**调用方须持 registry**)。
    ///
    /// `request`:`Some(n)` = 对 [`ClientMsg::RosterReq`] 的应答;`None` = 主动推送。
    /// 名册**只带 device_id 与管理标记,不带别名** —— 别名是 E2EE 的,服务器不知道。
    ///
    /// `revision` 取全局单调发号器(**我填的形**:规格只要求「单账户单调」,全局单调是
    /// 它的加强,客户端只做大小比较故无副作用;省一张 per-account 的表)。同
    /// `status_revision`,单次服务器启动内有效——跨重启复位由「会话边界」自然闭合。
    fn build_roster(&self, reg: &Registry, account: &str, request: Option<u64>) -> ServerMsg {
        let devices: Vec<RosterEntry> = reg
            .devices_of(account)
            .into_iter()
            .map(|d| {
                let admin = reg.is_admin(account, &d);
                RosterEntry { device: d, admin }
            })
            .collect();
        // §5.13 那道容量闸的第三处同源(另两处 = 配置校验、load 存量校验)。走到这里
        // 超界只可能是那两道被绕开 —— 帧发出去会撞 1 MiB 上限,截断则会**藏掉设备**,
        // 两者都比当场 fail-fast 危险。
        assert!(
            devices.len() <= sync_proto::MAX_ROSTER_DEVICES,
            "账户 {account} 有 {} 台设备,超过 MAX_ROSTER_DEVICES={}(配置校验与 load 校验都该先拦住)",
            devices.len(),
            sync_proto::MAX_ROSTER_DEVICES
        );
        let revision = self
            .roster_revision
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| v.checked_add(1))
            .expect("roster_revision 取号到顶(u64,不可能达到,fail-fast)");
        ServerMsg::Roster { request, revision, devices }
    }

    /// 成员集合变化后向账户内**全部声明了 cap 的在线连接**重推名册(367,§5.4;
    /// **调用方须持 registry**,锁序 registry → state)。
    ///
    /// ⚠ **正确性绝不挂在这枚推送上**:`push` 就是 `try_send().is_ok()`,通道满时帧
    /// 静默消失(first-draft-checklist 第 1 条同族);触及在途上界时我们还会**主动**
    /// 跳过。客户端那边的恒在轴是「每 10 拍心跳拉一枚 `RosterReq`」(§5.4 H2),这枚
    /// 推送只负责**新鲜度**。
    fn push_roster_locked(&self, reg: &Registry, account: &str) {
        let st = self.state.lock().unwrap();
        let mut msg: Option<ServerMsg> = None;
        for (_, c) in st.online.iter().filter(|((a, _), _)| a.as_str() == account) {
            if !c.wants_roster {
                continue;
            }
            // 惰性构造两层:账户里一台声明 cap 的都没有时一枚都不建(取号也不动);
            // 每条连接**预占到额度之后**才克隆(弹二 M2 的第 2 件)。
            push_roster(&c.tx, &c.roster_inflight, || {
                msg.get_or_insert_with(|| self.build_roster(reg, account, None)).clone()
            });
        }
    }

    /// [`ClientMsg::RosterReq`] 的应答(367,conn 侧无锁调用)。自取 registry → state,
    /// 顺带复核「这条连接此刻仍是该设备的当前在线连接」——发的是账户名册,发错连接
    /// 就是发错人。`false` = 没发出去(连接已不算数 / 在途上界 / 通道满),调用方据此
    /// 回 `RosterNack{n, busy}`,让客户端的 deadline 与周期轴接手。
    #[must_use]
    pub fn reply_roster(&self, account: &str, device: &str, conn_id: u64, n: u64) -> bool {
        let reg = self.registry.lock().unwrap();
        let st = self.state.lock().unwrap();
        let Some(c) = st.online.get(&(account.to_owned(), device.to_owned())) else {
            return false;
        };
        if c.conn_id != conn_id || !c.wants_roster {
            return false;
        }
        // ⚠ 构造(含**推进全局 revision**)在闭包里,只有预占到额度才会发生 —— 见
        // `push_roster` 头注第 2 件:否则一台不读下行的设备能靠猛发 `RosterReq` 让服务器
        // 反复构造整份名册再丢掉,而那道 5s 间隔闸恰恰**答不出去就不推进基点**。
        push_roster(&c.tx, &c.roster_inflight, || self.build_roster(&reg, account, Some(n)))
    }

    /// 推送账户当前授权状态(工序4;conn 侧**无锁**调用:ENTER 实时推送)。自取 registry。
    pub fn push_account_status(&self, account: &str) {
        let now_wall = time::OffsetDateTime::now_utc();
        let reg = self.registry.lock().unwrap();
        self.push_status_locked(&reg, account, now_wall);
    }

    /// 鉴权成功,设备上线:踢旧迎新(kick 专线,闪断重连不用等静默判死)→
    /// 搬信箱(TTL 过滤;出队成功才算,余帧留箱)→ 给新人发在线快照、向账户内
    /// 其它在线者广播上线。
    ///
    /// **吊销线性化(H1)**:全程持 registry 锁(锁序 registry → state)——核
    /// 「此刻仍在 registry **且公钥就是本次验签那把**」(只核存在会中 ABA:吊销后
    /// 同 device_id 被幸存设备合法重注册换新钥,旧钥连接不得冒充新设备上线),
    /// Authed 也在锁内推进下行队(客户端以 Authed 为同步态起点,恒在积压 deliver
    /// 之前;由本函数发,调用方别再发)。返回 `None` = 已不在/已换钥,没发 Authed,
    /// 调用方按鉴权失败断开;`Some(session_gen)` = 上线成功,调用方须存入连接态供
    /// 限速准入的会话代际核验(169,codex H:挡同 device 重连 ABA)。
    /// **会话代际在 state 释放后、仍持 registry 时置**(锁序 registry→meters)。
    ///
    /// **封禁复核同锁**(open-signup §1.2):conn 初查 banned 后会放锁,banlist
    /// reload 若插在初查与上线之间,这里不复核就会放进一个刚被封的连接——
    /// `!is_banned` 与公钥在同一把 registry 锁内一起核,窗口闭合。
    #[must_use]
    pub fn attach_authenticated(
        &self,
        account: &str,
        device: &str,
        expected_pubkey: [u8; 32],
        conn_id: u64,
        tx: Tx,
        kick: KickTx,
        queued: QueuedBytes,
        wants_status: bool,
        wants_roster: bool,
        roster_inflight: RosterInflight,
    ) -> Option<u64> {
        let now_wall = time::OffsetDateTime::now_utc();
        let reg = self.registry.lock().unwrap();
        if reg.is_banned(account) {
            return None;
        }
        if reg.pubkey_of(account, device) != Some(expected_pubkey) {
            return None;
        }
        // 工序4:state 锁前、持 registry 时把「Authed 后要发的帧」构好(单次快照,
        // registry→meters→drop)。cap 客户端恒 AccountStatusV1;旧客户端仅受限时
        // account_throttled;均先于 mailbox drain(§6 鉴权顺序 Authed→状态→Deliver)。
        let (eff_period, used, quota, over) = self.read_meter_snapshot(&reg, account, now_wall);
        let extra: Option<ServerMsg> = if wants_status {
            Some(self.build_account_status(&reg, account, now_wall, eff_period, used, quota))
        } else if over {
            Some(advisory_err(err_code::ACCOUNT_THROTTLED, THROTTLE_MSG))
        } else {
            None
        };
        // 367:名册那一枚也在 state 锁前、持 registry 时构好(与 AccountStatusV1 同纪律)。
        let roster: Option<ServerMsg> =
            wants_roster.then(|| self.build_roster(&reg, account, None));
        let addr: Addr = (account.to_owned(), device.to_owned());
        let mut st = self.state.lock().unwrap();
        push(&tx, ServerMsg::Authed);
        if let Some(m) = extra {
            push(&tx, m);
        }
        // §6 鉴权顺序:Authed → 状态 → **名册** → Deliver。名册排在搬信箱之前是
        // 「能力信号」这件事的结构前提(§5.14 末那只顺序/容量测):此刻下行队里只有
        // 前面这两三枚,不可能已被积压 Deliver 填满 ⇒ attach 推送丢失只会退化成
        // 「本会话面板暂不可用」,不会变成「服务器明明支持却看着像不支持」。
        if let Some(m) = roster {
            // 这一枚**刻意在 state 锁前、持 registry 时就构好**(与 AccountStatusV1 同
            // 纪律),故闭包里只是把它交出去 —— `push_roster` 的「占到才构造」在这条路上
            // 不适用:全新连接的在途计数必是 0,预占恒成功。
            push_roster(&tx, &roster_inflight, || m);
        }
        if let Some(old) = st.online.remove(&addr) {
            logln(format!(
                "INFO conn={} account={account} device={device} 被新连接 conn={conn_id} 顶替",
                old.conn_id
            ));
            kick_and_burn(&mut st, account, old);
        }
        if let Some(mb) = st.mailboxes.get_mut(&addr) {
            let now = Instant::now();
            let ttl = self.cfg.mailbox_ttl;
            let (mut delivered, mut expired) = (0u64, 0u64);
            loop {
                let Some(front) = mb.frames.front() else { break };
                if now.duration_since(front.at) > ttl {
                    let f = mb.frames.pop_front().expect("front 已证存在");
                    mb.bytes -= f.cost;
                    expired += 1;
                    continue;
                }
                // 单连接字节闸(§5.2 #4)对搬运同样生效:余帧留箱,写任务清出
                // 空间后下一次上线继续接力(信箱只是加速器,留箱无损)。
                if queued.load(Ordering::Relaxed) + front.cost > self.cfg.conn_max_bytes {
                    logln(format!(
                        "WARN account={account} device={device} 信箱搬运触及单连接字节闸,余帧留箱"
                    ));
                    break;
                }
                let MailFrame { at, cost, msg } = mb.frames.pop_front().expect("front 已证存在");
                mb.bytes -= cost;
                // 帧从信箱容器移入 mpsc 容器:账本跟着帧走(§5.2「搬运不释放预算」
                // ——mailbox 字节减、连接队列字节加,派生的账户/全局用量不变)。
                queued.fetch_add(cost, Ordering::Relaxed);
                match tx.try_send(msg) {
                    Ok(()) => delivered += 1,
                    Err(e) => {
                        // 容量恒够(cap = max_frames + headroom > 信箱上限),走到这
                        // 只能是连接已死——余帧原位留箱,等下一次上线(codex P2-e M1)。
                        queued.fetch_sub(cost, Ordering::Relaxed);
                        let msg = match e {
                            mpsc::error::TrySendError::Full(m)
                            | mpsc::error::TrySendError::Closed(m) => m,
                        };
                        mb.frames.push_front(MailFrame { at, cost, msg });
                        mb.bytes += cost;
                        logln(format!(
                            "WARN account={account} device={device} 信箱搬运中断(连接已死?),余帧留箱"
                        ));
                        break;
                    }
                }
            }
            if delivered + expired > 0 {
                logln(format!(
                    "INFO account={account} device={device} 清信箱:投 {delivered} 帧、TTL 弃 {expired} 帧、此前溢出弃 {} 帧",
                    mb.dropped
                ));
            }
            if mb.frames.is_empty() {
                st.mailboxes.remove(&addr);
            }
        }
        // 在线快照给新人;上线事件给其他人。
        let peers: Vec<(String, Tx)> = st
            .online
            .iter()
            .filter(|((a, _), _)| a.as_str() == account)
            .map(|((_, d), c)| (d.clone(), c.tx.clone()))
            .collect();
        for (peer_device, _) in &peers {
            push(&tx, ServerMsg::Peer { device: peer_device.clone(), online: true });
        }
        for (_, peer_tx) in &peers {
            push(peer_tx, ServerMsg::Peer { device: device.to_owned(), online: true });
        }
        st.online
            .insert(addr, Client { conn_id, tx, kick, queued, wants_status, wants_roster, roster_inflight });
        drop(st);
        // 会话代际(169,codex H):state 已释放、仍持 registry(锁序 registry→meters)。
        // 给本 device 发新单调 session_gen、取消旧代际残留 pending;返回供连接态存储。
        let wall_month = crate::registry::month_of(now_wall);
        let gen = self.meters.lock().unwrap().begin_session(
            account,
            device,
            wall_month,
            std::time::Instant::now(),
        );
        Some(gen)
    }

    /// 数据帧准入(169,工序 3;**只 Authed Send/PairMsg 调**,控制帧不过桶——计数
    /// 口径 §4)。**准入原子临界区**:读 grant + 设备集(registry)→ 计数 + 判超额 +
    /// enqueue(meters),全在 registry→meters 内一次拿下,admin 改 grant 不能插在读与
    /// enqueue 之间(codex D 丢通知竞态)。无论决策如何,wire 字节已计入(帧已达入站
    /// 边界)。返回 Immediate=直接放行 / Kicked=stale 会话须断连 / Wait=须限速等待。
    pub fn throttle_admission(
        &self,
        account: &str,
        device: &str,
        session_gen: u64,
        conn_id: u64,
        bytes: u64,
    ) -> (AdmitDecision, bool) {
        // 单次捕获墙钟(codex 实现审 M:两次 now_utc 恰跨月会让 meter period 与 grant
        // 取自不同月)。month 与 grant 同源。
        let now_instant = std::time::Instant::now();
        let now_wall = time::OffsetDateTime::now_utc();
        let wall_month = crate::registry::month_of(now_wall);
        let reg = self.registry.lock().unwrap();
        let grant = reg.effective_grant_quota(account, now_wall);
        let device_set: std::collections::HashSet<String> =
            reg.devices_of(account).into_iter().collect();
        let device_cap = self.cfg.device_cap;
        let rate = self.cfg.throttle_rate_bps;
        let (decision, newly_restricted, dirty) = {
            let mut meters = self.meters.lock().unwrap();
            let (decision, newly_restricted) = meters.admission(
                account,
                device,
                session_gen,
                conn_id,
                bytes,
                wall_month,
                now_instant,
                grant,
                &device_set,
                device_cap,
                rate,
            );
            (decision, newly_restricted, meters.dirty_bytes())
        };
        // 阈值事件唤醒(codex M:事件驱动非轮询;notify_one 合并、丢一次不退化因 dirty
        // 有状态、worker 每轮读实况)。
        if dirty >= self.cfg.checkpoint_dirty_bytes {
            self.checkpoint_nudge.notify_one();
        }
        (decision, newly_restricted)
    }

    /// 限速 waiter 唤醒后的 poll(conn.rs 临界区外的等待循环调;registry→meters 重读
    /// grant 判「是否仍超额」)。`now_instant`=调用方取的单调钟。
    pub fn throttle_poll(&self, h: &WaitHandle, now_instant: std::time::Instant) -> PollOutcome {
        let reg = self.registry.lock().unwrap();
        let grant = reg.effective_grant_quota(&h.account, time::OffsetDateTime::now_utc());
        let mut meters = self.meters.lock().unwrap();
        meters.poll(h, now_instant, grant)
    }

    /// 连接断开清理:清该会话的 throttle 态(clear_if_current——旧连接退出不清新会话)。
    pub fn throttle_clear(&self, account: &str, device: &str, session_gen: u64) {
        self.meters.lock().unwrap().clear_if_current(
            account,
            device,
            session_gen,
            std::time::Instant::now(),
        );
    }

    /// admin 设 entitlement 的收口编排(169,codex D):registry 内改 entitlement+grant,
    /// **仍持 registry** 锁 meters——升级抬 grant 后若账户已不再超额,清空 pending 放行
    /// 在等帧(release_if_unthrottled)。返回 `now` 时刻的 effective(admin 回显)。
    pub fn admin_set_entitlement(
        &self,
        account: &str,
        ent: Entitlement,
        now_wall: time::OffsetDateTime,
    ) -> Result<Entitlement, SetEntitlementError> {
        let mut reg = self.registry.lock().unwrap();
        reg.set_entitlement(account, ent, now_wall)?;
        let effective = reg.effective_entitlement(account, now_wall);
        let grant = reg.effective_grant_quota(account, now_wall);
        self.meters.lock().unwrap().release_if_unthrottled(
            account,
            std::time::Instant::now(),
            grant,
        );
        // 工序4:entitlement 变化后给在线连接推更新后的状态(仍持 registry——Required-3:
        // 与 ENTER 推送对同账户被 registry 串行化,入队序 == revision 序)。
        self.push_status_locked(&reg, account, now_wall);
        Ok(effective)
    }

    /// 单写者 checkpoint(169,工序 3;**唯一 sidecar 写者**——worker task 串行调,
    /// 无并发覆盖)。锁内拷快照(不清 dirty),落盘在锁外;成功后 `checkpoint_ack`
    /// 扣减快照量,失败保留 dirty 供重试。
    pub fn checkpoint_meters(&self) -> std::io::Result<()> {
        let (records, dirty_at) = { self.meters.lock().unwrap().checkpoint_snapshot() };
        match crate::throttle::save_sidecar(&self.cfg.meters_path, &records) {
            Ok(()) => {
                self.meters.lock().unwrap().checkpoint_ack(dirty_at);
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// 自上次 checkpoint 以来的脏字节量(worker 判 ≥ `checkpoint_dirty_bytes` 触发)。
    pub fn meters_dirty_bytes(&self) -> u64 {
        self.meters.lock().unwrap().dirty_bytes()
    }

    /// 计量准入栅栏 enter(169,codex H-3):conn 在 decode 后、`throttle_admission` 前
    /// 调。返回 false = 停机关栅,帧须拒(不计不路由)。double-check 挡「关栅插在
    /// load 与 incr 之间」。
    pub fn admission_enter(&self) -> bool {
        if self.adm_closing.load(Ordering::Acquire) {
            return false;
        }
        self.adm_active.fetch_add(1, Ordering::AcqRel);
        if self.adm_closing.load(Ordering::Acquire) {
            if self.adm_active.fetch_sub(1, Ordering::AcqRel) == 1 {
                self.adm_drained.notify_waiters();
            }
            return false;
        }
        true
    }

    /// 计量准入栅栏 leave(`throttle_admission` 返回后即调;**只括住计数临界段,不含
    /// 限速等待**——等待在栅栏外,shutdown drain 不被限速拖住)。
    pub fn admission_leave(&self) {
        if self.adm_active.fetch_sub(1, Ordering::AcqRel) == 1
            && self.adm_closing.load(Ordering::Acquire)
        {
            self.adm_drained.notify_waiters();
        }
    }

    /// 关计量准入栅栏 + 等 in-flight 计数全部退栏(SIGTERM 第一步)。**返回是否干净
    /// drain**:`true`=active 归零、之后 final flush 是真最终计量快照;`false`=5s 超时
    /// 未归零(某帧卡在 registry 慢 save 后),调用方须 best-effort checkpoint + **非零
    /// 退出**、不得声称最终快照(codex 实现审 H:超时不能走成功出口)。栅栏后新帧一律拒。
    #[must_use]
    pub async fn shutdown_admissions(&self) -> bool {
        self.adm_closing.store(true, Ordering::Release);
        // 连接 permit 栅同点关闭(2026-07-31 codex L1):close 后 try_acquire 恒 Err,
        // ws_upgrade 的取 permit 分支即 503——「停收新连接」与关栅同一线性化点,
        // 不再依赖 is_shutting_down 的 check-then-act。已发 permit 不受影响。
        self.conn_permits.close();
        loop {
            let notified = self.adm_drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable(); // 先注册 waiter 再查,无丢唤醒
            if self.adm_active.load(Ordering::Acquire) == 0 {
                return true;
            }
            if tokio::time::timeout(self.cfg.shutdown_drain_timeout, notified).await.is_err() {
                logln("WARN 停机 drain 超时(仍有 in-flight 计量准入):final checkpoint 可能非最终,将非零退出".into());
                return false;
            }
        }
    }

    /// checkpoint 阈值事件唤醒源(worker `select!` 它;`throttle_admission` 越阈值即
    /// `notify_one`)。
    pub fn checkpoint_nudge(&self) -> &Notify {
        &self.checkpoint_nudge
    }

    /// 停机中(SIGTERM 已关计量准入栅栏):ws_upgrade 据此拒新 WS 连接。
    pub fn is_shutting_down(&self) -> bool {
        self.adm_closing.load(Ordering::Acquire)
    }

    /// sweeper 月初滚 grant(169;grant.period < 本月的账户按 period_start effective 重建
    /// 并落盘,批量一次 save、失败回滚全部内存 grant)。落盘错只告警(下一 tick 再试)。
    pub fn roll_grants_now(&self) {
        let now = time::OffsetDateTime::now_utc();
        let mut reg = self.registry.lock().unwrap();
        match reg.roll_grants_to_current_month(now) {
            Ok(0) => {}
            Ok(n) => logln(format!("INFO grant 滚月:{n} 个账户建当月 grant")),
            Err(e) => logln(format!("ERROR grant 滚月落盘失败(已回滚内存,下轮重试):{e}")),
        }
    }

    /// 连接断开的全部清理(读循环退出后恒调,幂等):下线广播 + 涉及的配对槽烧毁。
    pub fn detach(&self, conn_id: u64, authed: Option<&(String, String)>) {
        let mut st = self.state.lock().unwrap();
        if let Some(addr) = authed {
            // conn_id 守卫:被顶替的旧连接退出时,别误删新连接的在线条目。
            if st.online.get(addr).is_some_and(|c| c.conn_id == conn_id) {
                let gone = st.online.remove(addr).expect("上一行已证存在");
                if gone.queued.load(Ordering::Relaxed) > 0 {
                    st.draining.push((addr.0.clone(), gone.queued.clone()));
                }
                broadcast_offline(&st, &addr.0, &addr.1);
            }
        }
        burn_slots_of(&mut st, conn_id);
    }

    /// 路由一条 send(§4):返回 Ok=回 Ack,Err(code)=回 Nack。
    /// to 恒是 BROADCAST 或本账户 registry 内设备;信箱只为已注册设备开。
    pub fn route_send(
        &self,
        account: &str,
        from: &str,
        conn_id: u64,
        to: &str,
        lane: Lane,
        blob: Vec<u8>,
    ) -> Result<(), &'static str> {
        // 吊销线性化(H3):全程持 registry 锁(锁序 registry → state)——快照与
        // 投递之间不许 revoke 插队,否则会给刚清掉的信箱再入一箱旧帧(而 device_id
        // 允许合法重注册,72h 内上线就复活了);from 已被吊(kick 在途的尾帧)也在
        // 此拒,不再扩散。
        let reg = self.registry.lock().unwrap();
        let devices = reg.devices_of(account);
        if !devices.iter().any(|d| d == from) {
            return Err(err_code::UNKNOWN_DEVICE);
        }
        let targets: Vec<String> = if to == BROADCAST {
            devices.iter().filter(|d| *d != from).cloned().collect()
        } else {
            if to == from || !devices.iter().any(|d| d == to) {
                return Err(err_code::UNKNOWN_DEVICE);
            }
            vec![to.to_owned()]
        };
        // 广播给空账户(单设备账户)= 服务器接手了、没人收,Ack 照回。
        let mut st = self.state.lock().unwrap();
        // 授权租约(H-ABA):发帧连接必须仍是该设备的**当前在线连接**——吊销把它
        // 从 online 摘除后,哪怕 device_id 被合法重注册(换钥),旧连接已读入的
        // 尾帧也已失权;被顶替的旧连接同理(其尾帧 Nack,新连接按水位重发)。
        let sender: Addr = (account.to_owned(), from.to_owned());
        if !st.online.get(&sender).is_some_and(|c| c.conn_id == conn_id) {
            return Err(err_code::UNKNOWN_DEVICE);
        }
        // 预算 admission(§5.2 #2/#3,原子性):fanout 前按**全部目标**一次性判齐
        // ——判过了才逐一入队,绝不「部分投部分拒」;不够则按次序驱逐(先本账户
        // mailbox 最老,再摘占用最大的在线连接),仍不够整帧拒(发送端按既有重试
        // 语义处理,已收端 op_id 幂等吸收)。持 registry+state 双锁,判与投之间
        // 无人插队。
        self.admit(&mut st, account, from, blob.len() * targets.len())?;
        let now = Instant::now();
        for target in targets {
            let addr: Addr = (account.to_owned(), target);
            let msg = ServerMsg::Deliver { from: from.to_owned(), to: to.to_owned(), blob: blob.clone() };
            let cost = blob.len();
            // 在线投递;队满/超单连字节闸 = 慢客户端:摘下线 + kick 断连 + 广播
            // offline,走离线逻辑(codex P2-e H2;字节闸 §5.2 #4)。
            let mut offline = true;
            if let Some(client) = st.online.get(&addr) {
                let over_bytes =
                    client.queued.load(Ordering::Relaxed) + cost > self.cfg.conn_max_bytes;
                let sent = !over_bytes && {
                    client.queued.fetch_add(cost, Ordering::Relaxed);
                    let ok = push(&client.tx, msg.clone());
                    if !ok {
                        client.queued.fetch_sub(cost, Ordering::Relaxed);
                    }
                    ok
                };
                if sent {
                    offline = false;
                } else {
                    logln(format!(
                        "WARN account={account} device={} 下行队满/超字节闸或已死,摘下线断连",
                        addr.1
                    ));
                    let dead = st.online.remove(&addr).expect("上一行 get 命中且持锁");
                    kick_and_burn(&mut st, account, dead);
                    broadcast_offline(&st, account, &addr.1);
                }
            }
            if offline {
                match lane {
                    Lane::Mail => self.mailbox_push(&mut st, addr, MailFrame { at: now, cost, msg }),
                    Lane::Direct => {
                        if to != BROADCAST {
                            return Err(err_code::NOT_ONLINE);
                        }
                        // 广播 direct:离线者静默跳过,不入箱(§3)。
                    }
                }
            }
        }
        Ok(())
    }

    /// 预算 admission(§5.2 #2):`need` 字节能否进入本账户的容器集合。
    /// 用量**派生不存**(mailbox 字节 + 在线连接队列账本 + 配对桥累计上界,
    /// O(n) 现算;n = 设备与槽数,量级个位数到千,持锁扫描可忽略)——没有
    /// 「取/还 permit」的簿记,也就没有泄漏与双还这一整类 bug。
    /// 驱逐次序显式(codex 二轮:mpsc 队头不可直接驱逐):
    ///   ① 本账户 mailbox 最老帧(跨该账户全部信箱找 at 最小);
    ///   ② 摘本账户占用最大的在线连接(发送者除外——它正在交互,其下行由
    ///     单连字节闸独立约束;断连 = Client 摘除,其队列字节退出派生,内存
    ///     随写任务终止真实释放);
    ///   ③ 仍不够 = 拒新帧 + 日志(宁拒不 OOM)。
    fn admit(
        &self,
        st: &mut HubState,
        account: &str,
        sender: &str,
        need: usize,
    ) -> Result<(), &'static str> {
        prune_draining(st);
        loop {
            let account_used: usize = st
                .mailboxes
                .iter()
                .filter(|((a, _), _)| a == account)
                .map(|(_, mb)| mb.bytes)
                .sum::<usize>()
                + st.online
                    .iter()
                    .filter(|((a, _), _)| a == account)
                    .map(|(_, c)| c.queued.load(Ordering::Relaxed))
                    .sum::<usize>()
                + st.slots
                    .values()
                    .filter(|sl| sl.account == account)
                    .filter_map(|sl| sl.joiner.as_ref().map(|(_, _, q, _)| q.load(Ordering::Relaxed)))
                    .sum::<usize>()
                + st.draining
                    .iter()
                    .filter(|(acc, _)| acc == account)
                    .map(|(_, q)| q.load(Ordering::Relaxed))
                    .sum::<usize>();
            if account_used + need <= self.cfg.budget_account_bytes {
                break;
            }
            // ① 驱逐本账户最老的 mailbox 帧。
            let oldest = st
                .mailboxes
                .iter_mut()
                .filter(|((a, _), mb)| a == account && !mb.frames.is_empty())
                .min_by_key(|(_, mb)| mb.frames.front().expect("已滤空箱").at);
            if let Some((addr, mb)) = oldest {
                let f = mb.frames.pop_front().expect("已滤空箱");
                mb.bytes -= f.cost;
                mb.dropped += 1;
                logln(format!(
                    "WARN 账户预算不足,驱逐 account={} device={} 信箱最老帧({} 字节)",
                    addr.0, addr.1, f.cost
                ));
                continue;
            }
            // ② 摘占用最大的在线连接(发送者除外)。
            let fattest = st
                .online
                .iter()
                .filter(|((a, d), _)| a == account && d != sender)
                .max_by_key(|(_, c)| c.queued.load(Ordering::Relaxed))
                .filter(|(_, c)| c.queued.load(Ordering::Relaxed) > 0)
                .map(|(addr, _)| addr.clone());
            if let Some(addr) = fattest {
                // 二弹二轮 M:摘线 ≠ 内存已释放(账本进 draining 继续顶预算)——
                // 摘完**立即拒本帧**,不再 continue 循环;否则一次超额请求会把
                // 账户内全部非发送者连接批量踢下线,预算照样顶着。writer 真排空
                // 后发送方重试自然放行。
                logln(format!(
                    "WARN 账户预算不足,摘占用最大的在线连接 account={} device={} 并拒本帧",
                    addr.0, addr.1
                ));
                let dead = st.online.remove(&addr).expect("上一行已证存在");
                kick_and_burn(st, &addr.0, dead);
                broadcast_offline(st, &addr.0, &addr.1);
                return Err(err_code::BUSY);
            }
            logln(format!("WARN account={account} 预算不足且无可驱逐,拒新帧({need} 字节)"));
            return Err(err_code::BUSY);
        }
        // 全局预算:各账户份额之和可超全局(超卖),全局线是硬顶。本账户能驱逐
        // 的上面已驱逐过;别家账户的内容不因本账户的新帧被驱逐(公平性),不够
        // 即拒(宁拒不 OOM)。
        let global_used: usize = st.mailboxes.values().map(|mb| mb.bytes).sum::<usize>()
            + st.online.values().map(|c| c.queued.load(Ordering::Relaxed)).sum::<usize>()
            + st.slots
                .values()
                .filter_map(|sl| sl.joiner.as_ref().map(|(_, _, q, _)| q.load(Ordering::Relaxed)))
                .sum::<usize>()
            // 摘线/断开后 writer 仍持有的队列(内存未释放,prune 后的余量)。
            + st.draining.iter().map(|(_, q)| q.load(Ordering::Relaxed)).sum::<usize>();
        if global_used + need > self.cfg.budget_global_bytes {
            logln(format!("WARN 全局预算不足,拒新帧(account={account},{need} 字节)"));
            return Err(err_code::BUSY);
        }
        Ok(())
    }

    /// 入箱 + 驱逐(§4:64 MiB 或 8192 帧先到为准,溢出丢最老;TTL 惰性清队头)。
    fn mailbox_push(&self, st: &mut HubState, addr: Addr, frame: MailFrame) {
        let ttl = self.cfg.mailbox_ttl;
        let (max_bytes, max_frames) = (self.cfg.mailbox_max_bytes, self.cfg.mailbox_max_frames);
        let now = frame.at;
        let mb = st.mailboxes.entry(addr).or_default();
        mb.bytes += frame.cost;
        mb.frames.push_back(frame);
        // 惰性 TTL:趁写入清一把队头过期帧(定期清扫兜底全表)。
        while mb.frames.front().is_some_and(|f| now.duration_since(f.at) > ttl) {
            let f = mb.frames.pop_front().expect("front 已证存在");
            mb.bytes -= f.cost;
            mb.dropped += 1;
        }
        while mb.frames.len() > max_frames || mb.bytes > max_bytes {
            let f = mb.frames.pop_front().expect("超限则队列非空");
            mb.bytes -= f.cost;
            mb.dropped += 1;
        }
    }

    /// 开配对槽(§4:TTL 10 分钟、单次使用)。同连接重复 open = 烧旧开新
    /// (UI「重新生成配对码」);槽号 9 位随机数字(空间 9 亿,TTL 内在线扫不完;
    /// SECRET 的 SPAKE2 才是安全边界,槽号只是寻址),撞号重生成;全局槽数有
    /// 上限(超限 = busy,codex P2-e M2)。授权租约(H-ABA):开槽连接必须仍是
    /// 该设备的当前在线连接——被吊/被顶替连接的尾帧不得在 revoke 烧槽之后再开
    /// 新槽复活配对面。
    ///
    /// **席位前置拒(billing-plan §5 M5,工序 2)**:`seat_count ≥ min(seat_quota,
    /// 硬帽)` 时普通 PairOpen 直接拒(可显示错误「先移除一台设备再添加」),别让
    /// 用户走完 SPAKE2 仪式才在 register_device 撞权威闸;开槽后到期/降档的窗口
    /// 由 register_device 权威闸兜底(此拒只是前置 UX)。全程持 registry 锁再嵌
    /// state 锁(锁序见模块注释),判席与开槽之间 revoke/注册无插队。
    pub fn pair_open(
        &self,
        account: &str,
        device: &str,
        conn_id: u64,
        tx: Tx,
    ) -> Result<u64, &'static str> {
        let reg = self.registry.lock().unwrap();
        let mut st = self.state.lock().unwrap();
        let addr: Addr = (account.to_owned(), device.to_owned());
        if !st.online.get(&addr).is_some_and(|c| c.conn_id == conn_id) {
            return Err(err_code::AUTH_FAILED);
        }
        // 授权(在线租约)先于政策:先证「你是你」,再谈「席位够不够」。
        let seat_count = reg.devices_of(account).len();
        if seat_count >= self.cfg.device_cap {
            return Err(err_code::ACCOUNT_FULL);
        }
        let quota =
            reg.effective_entitlement(account, time::OffsetDateTime::now_utc()).seat_quota as usize;
        if seat_count >= quota {
            return Err(err_code::SEAT_LIMIT);
        }
        drop(reg);
        {
            let HubState { slots, draining, .. } = &mut *st;
            slots.retain(|slot, s| {
                if s.owner_conn != conn_id {
                    return true;
                }
                if let Some((_, joiner_tx, _, _)) = &s.joiner {
                    push(joiner_tx, ServerMsg::PairPeer { event: PairEvent::Closed });
                }
                retire_joiner_ledger(draining, s);
                logln(format!("INFO 配对槽 {slot} 被同连接重开烧毁"));
                false
            });
        }
        if st.slots.len() >= self.cfg.pair_slot_cap {
            return Err(err_code::BUSY);
        }
        let slot = loop {
            let mut b = [0u8; 8];
            getrandom::fill(&mut b).expect("系统熵不可用是环境级故障");
            let n = 100_000_000 + u64::from_le_bytes(b) % 900_000_000;
            if !st.slots.contains_key(&n) {
                break n;
            }
        };
        st.slots.insert(
            slot,
            PairSlot {
                account: account.to_owned(),
                owner_conn: conn_id,
                owner_tx: tx,
                joiner: None,
                opened: Instant::now(),
                used: false,
                relayed_frames: 0,
                relayed_bytes: 0,
            },
        );
        Ok(slot)
    }

    /// 入槽(§4:未鉴权连接的唯一业务入口)。不存在/已用/过期恒同一个错
    /// (bad_slot,不给「槽存在与否」的探测面);成功即占用(单次),通知发起端。
    pub fn pair_join(&self, conn_id: u64, tx: Tx, kick: KickTx, queued: QueuedBytes, slot: u64) -> Result<(), &'static str> {
        let mut st = self.state.lock().unwrap();
        let expired = st
            .slots
            .get(&slot)
            .is_some_and(|s| s.opened.elapsed() > self.cfg.pair_slot_ttl);
        if expired {
            // 过期槽的 joiner 在途账本同样 retire(二弹三轮 H:这里不退账,攻击者可
            // 对已用且积压 PairMsg 的过期槽再 PairJoin,让旧队列内存从派生消失)。
            let dead = st.slots.remove(&slot).expect("上一行已证存在");
            retire_joiner_ledger(&mut st.draining, &dead);
        }
        let Some(s) = st.slots.get_mut(&slot) else {
            return Err(err_code::BAD_SLOT);
        };
        if s.used {
            return Err(err_code::BAD_SLOT);
        }
        s.used = true;
        s.joiner = Some((conn_id, tx, queued, kick));
        push(&s.owner_tx, ServerMsg::PairPeer { event: PairEvent::Joined });
        Ok(())
    }

    /// 盲桥透传(§4:服务器只转发,不看内容):发起端 ↔ 入槽端。
    /// 每槽累计配额(epoch-plan §5.2 #5):帧数/字节任一超即烧槽——SPAKE2 一次
    /// 交换只需几帧,超量只能是滥用;push 失败(对端队满/已死)同样烧槽并回错
    /// (修 hub.rs 旧版忽略 push 返回值:桥断了还让发送端以为在配对)。
    pub fn pair_relay(&self, conn_id: u64, slot: u64, blob: Vec<u8>) -> Result<(), &'static str> {
        let mut st = self.state.lock().unwrap();
        let Some(s) = st.slots.get_mut(&slot) else {
            return Err(err_code::BAD_SLOT);
        };
        let to_owner = if s.owner_conn == conn_id {
            if s.joiner.is_none() {
                return Err(err_code::BAD_SLOT);
            }
            false
        } else if s.joiner.as_ref().is_some_and(|(c, _, _, _)| *c == conn_id) {
            true
        } else {
            return Err(err_code::BAD_SLOT);
        };
        s.relayed_frames += 1;
        s.relayed_bytes += blob.len();
        let over_slot = s.relayed_frames > self.cfg.pair_slot_max_frames
            || s.relayed_bytes > self.cfg.pair_slot_max_bytes;
        let slot_account = s.account.clone();
        if over_slot {
            logln(format!("WARN 配对槽 {slot} 超转发配额,烧毁"));
            burn_slot_notify_both(&mut st, slot);
            return Err(err_code::BAD_SLOT);
        }
        // 二弹 H:配对桥同样过统一预算(单槽配额 × 全局槽数上限 ≠ 全局硬顶——
        // 4096 槽理论可累计 16GiB)。用量已含本帧(上面刚累加),超线即烧槽;
        // 账户份额计到开槽者账户(joiner 未鉴权)。
        prune_draining(&mut st);
        let global_used: usize = st.mailboxes.values().map(|mb| mb.bytes).sum::<usize>()
            + st.online.values().map(|c| c.queued.load(Ordering::Relaxed)).sum::<usize>()
            + st.slots
                .values()
                .filter_map(|sl| sl.joiner.as_ref().map(|(_, _, q, _)| q.load(Ordering::Relaxed)))
                .sum::<usize>()
            + st.draining.iter().map(|(_, q)| q.load(Ordering::Relaxed)).sum::<usize>();
        let account_used: usize = st
            .mailboxes
            .iter()
            .filter(|((a, _), _)| *a == slot_account)
            .map(|(_, mb)| mb.bytes)
            .sum::<usize>()
            + st.online
                .iter()
                .filter(|((a, _), _)| *a == slot_account)
                .map(|(_, c)| c.queued.load(Ordering::Relaxed))
                .sum::<usize>()
            + st.slots
                .values()
                .filter(|sl| sl.account == slot_account)
                .filter_map(|sl| sl.joiner.as_ref().map(|(_, _, q, _)| q.load(Ordering::Relaxed)))
                .sum::<usize>()
            + st.draining
                .iter()
                .filter(|(acc, _)| *acc == slot_account)
                .map(|(_, q)| q.load(Ordering::Relaxed))
                .sum::<usize>();
        if global_used + blob.len() > self.cfg.budget_global_bytes
            || account_used + blob.len() > self.cfg.budget_account_bytes
        {
            logln(format!("WARN 配对槽 {slot} 触及统一预算(宁拒不 OOM),烧毁"));
            burn_slot_notify_both(&mut st, slot);
            return Err(err_code::BAD_SLOT);
        }
        // 二弹二轮 H:PairMsg 记入**目标连接的实际账本**(writer 出队才释放)——
        // 槽累计只管单槽配额;否则烧槽即释放预算而帧还躺在接收方 mpsc 里,循环
        // 「填满→烧槽→重开」可绕过硬顶。owner 账本经 online 现查(不在线 = 已被
        // 摘,槽烧掉);joiner 账本随入槽登记在槽里。
        let cost = blob.len();
        let (to, ledger) = {
            let sl = st.slots.get(&slot).expect("上方 get_mut 已证存在");
            if to_owner {
                let owner = st.online.values().find(|c| c.conn_id == sl.owner_conn);
                match owner {
                    Some(c) => (sl.owner_tx.clone(), c.queued.clone()),
                    None => {
                        logln(format!("WARN 配对槽 {slot} 的开槽者已不在线,烧毁"));
                        burn_slot_notify_both(&mut st, slot);
                        return Err(err_code::BAD_SLOT);
                    }
                }
            } else {
                let (_, t, q, _) = sl.joiner.as_ref().expect("已证有 joiner");
                (t.clone(), q.clone())
            }
        };
        ledger.fetch_add(cost, Ordering::Relaxed);
        if !push(&to, ServerMsg::PairMsg { slot, blob }) {
            ledger.fetch_sub(cost, Ordering::Relaxed);
            logln(format!("WARN 配对槽 {slot} 转发失败(对端队满/已死),烧毁"));
            burn_slot_notify_both(&mut st, slot);
            return Err(err_code::BAD_SLOT);
        }
        Ok(())
    }

    /// 主动关槽(§4:SPAKE2 密钥确认失败 → 烧槽;双方都可发)。
    pub fn pair_close(&self, conn_id: u64, slot: u64) -> Result<(), &'static str> {
        let mut st = self.state.lock().unwrap();
        let member = st.slots.get(&slot).is_some_and(|s| {
            s.owner_conn == conn_id || s.joiner.as_ref().is_some_and(|(c, _, _, _)| *c == conn_id)
        });
        if !member {
            return Err(err_code::BAD_SLOT);
        }
        let s = st.slots.remove(&slot).expect("上一行已证存在");
        retire_joiner_ledger(&mut st.draining, &s);
        let other = if s.owner_conn == conn_id { s.joiner.as_ref().map(|(_, t, _, _)| t.clone()) } else { Some(s.owner_tx.clone()) };
        if let Some(tx) = other {
            push(&tx, ServerMsg::PairPeer { event: PairEvent::Closed });
        }
        logln(format!("INFO 配对槽 {slot} 被 conn={conn_id} 主动关闭"));
        Ok(())
    }

    /// 运营侧单设备吊销(android-plan §8 H1,admin 面唯一写口):
    /// ① registry 删绑定并落盘(此后该设备重连鉴权即拒;失败即整体失败,不碰在线态);
    /// ② 清该设备信箱(密文帧无主即弃,信箱只是加速器);
    /// ③ 在线则 kick 断连 + offline 广播 + 当场烧其配对槽(不等 detach)。
    /// **全程持 registry 锁再嵌 state 锁**(锁序见模块注释):attach / route_send /
    /// 背书注册同样在 registry 锁内动 state 或复核,吊销与它们全序——不存在
    /// 「吊完还能上线 / 再入箱 / 再背书」的间隙。
    ///
    /// `account` 可选(open-signup §1.5:无感创号后孤儿只有 device_id 可报):
    /// None = 同一把 registry 锁内反查属主再吊(原子,不许「先 GET 属主、放锁、
    /// 再按 account+device 吊」——中间可被重注册插队吊错);Some 且与真实属主
    /// 不符 = `OwnerMismatch` 零副作用拒。成功回执带解析出的账户。
    pub fn revoke_device(
        &self,
        account: Option<&str>,
        device: &str,
    ) -> Result<(String, RevokeOutcome), RevokeError> {
        let mut reg = self.registry.lock().unwrap();
        let owner = reg.owner_of_device(device).map_err(|()| RevokeError::Corrupt)?;
        let account = match (owner, account) {
            (None, _) => return Err(RevokeError::NotFound),
            (Some(o), Some(a)) if o != a => return Err(RevokeError::OwnerMismatch),
            (Some(o), _) => o,
        };
        let outcome = self.revoke_locked(&mut reg, &account, device)?;
        Ok((account, outcome))
    }

    /// 吊销的**唯一一条编排**(registry 删绑定 + 清信箱 + kick + 广播 offline;
    /// **调用方须持 registry**,锁序 registry → state)。
    ///
    /// ⛔ 运营者面([`Self::revoke_device`])与用户面(367 的 [`Self::device_admin`]
    /// 的 `Remove`)都走它 —— **不许另写第二条删除路径**(identity-plan §5.6-3;
    /// 同一件事的第二处抄写点就是漂移源)。
    fn revoke_locked(
        &self,
        reg: &mut Registry,
        account: &str,
        device: &str,
    ) -> Result<RevokeOutcome, RevokeError> {
        let outcome = reg.revoke_device(account, device)?;
        let addr: Addr = (account.to_owned(), device.to_owned());
        let mut st = self.state.lock().unwrap();
        st.mailboxes.remove(&addr);
        if let Some(dead) = st.online.remove(&addr) {
            let conn = dead.conn_id;
            kick_and_burn(&mut st, account, dead);
            broadcast_offline(&st, account, device);
            logln(format!(
                "INFO 吊销 account={account} device={device}(在线,已 kick conn={conn})"
            ));
        } else {
            logln(format!("INFO 吊销 account={account} device={device}(离线)"));
        }
        drop(st);
        // 成员集合变了 ⇒ 重推名册(367)。放在**唯一那条删除路径**里,故运营者面与
        // 用户面都免费拿到,不会有人「忘了推」。
        self.push_roster_locked(reg, account);
        Ok(outcome)
    }

    /// 用户面设备管理(367,identity-plan §5.3/§5.5;conn.rs 的 `DeviceAdmin` 臂调)。
    ///
    /// **判定顺序照 §5.3 那一份,这里是它在代码里的唯一落点**——别在别处抄第二份缩略版
    /// (三轮 L2 / 四轮 M3:同一件事的第三个粒度描述,照着写就会在判幂等之前先扣令牌)。
    ///
    /// ```text
    /// ⓪ H-ABA 授权租约 → ⓪ 账户封禁 → ① admins 非空 → ② 授权判据 → ③ target 在册
    /// → ④ 幂等早返 → 账户 limiter → ⑤ 不变量 → ⑥ 执行
    /// ```
    ///
    /// ⛔ **幂等分支绝不许排在授权之前**:否则「已是管理设备就 Ok」这条捷径会让越权
    /// 请求拿到一个成功回执,顺带泄露名单状态。
    ///
    /// ⛔ **账户令牌只有通过授权、且不是幂等的请求才扣**(三轮 M4):否则任一非管理
    /// 设备都能持续发越权请求把账户桶耗干,让真正的管理设备长期收到 busy。
    pub fn device_admin(
        &self,
        account: &str,
        caller: &str,
        caller_pub: [u8; 32],
        conn_id: u64,
        target: &str,
        action: DeviceAction,
    ) -> Result<(), DeviceAdminError> {
        let mut reg = self.registry.lock().unwrap();
        // ⓪ H-ABA 授权租约(照 register_endorsed / grant_seat_lease 逐条同构):验签在
        // 锁外,验完到执行之间发起方可能被吊、甚至被吊后同 device_id 重注册换新钥;
        // 「此刻仍是这把公钥」+「这条连接仍是它的当前在线连接」两件在同一把锁内核。
        if reg.pubkey_of(account, caller) != Some(caller_pub) {
            return Err(DeviceAdminError::Unauthorized);
        }
        {
            let st = self.state.lock().unwrap();
            let addr: Addr = (account.to_owned(), caller.to_owned());
            if !st.online.get(&addr).is_some_and(|c| c.conn_id == conn_id) {
                return Err(DeviceAdminError::Unauthorized);
            }
        }
        // ⓪ 账户封禁(banlist reload 可能插在鉴权与此刻之间,同 attach 的复核)。
        if reg.is_banned(account) {
            return Err(DeviceAdminError::Banned);
        }
        // ① admins 为空(存量未回填)⇒ 用户面整条不可用,**含自助退出**:不变量只说
        // 「不得**变**空」,对**已经**是空的账户约束为零 —— 这时放行自助退出,存量账户
        // 会被逐台退到空、直接撞出账户封存(封存不可自助重开)。全禁才自洽(§5.3-3)。
        if !reg.has_admins(account) {
            return Err(DeviceAdminError::NoAdmins);
        }
        // ② 授权判据(唯一正式子,见 [`device_admin_authorized`])。
        if !device_admin_authorized(reg.is_admin(account, caller), action, target == caller) {
            return Err(DeviceAdminError::Forbidden);
        }
        // ③ target 在册。
        if reg.pubkey_of(account, target).is_none() {
            return Err(DeviceAdminError::UnknownTarget);
        }
        // ④ 幂等早返:**不 save、不升 revision、不 fan-out、不扣账户令牌**(§5.13 M1
        // ——管理设备可以无限交替 Grant/Revoke,每次都触发全量落盘 + 全账户 fan-out)。
        // Remove 没有这一格:target 在册已由 ③ 判过,不在册就是 unknown_device。
        let target_is_admin = reg.is_admin(account, target);
        match action {
            DeviceAction::GrantAdmin if target_is_admin => return Ok(()),
            DeviceAction::RevokeAdmin if !target_is_admin => return Ok(()),
            _ => {}
        }
        // 账户 limiter(落在既有锁序 registry → state 之内:桶住在 registry 里,
        // 不新开锁、更不 state → registry)。
        // ⚠ 本文件的 `Instant` 是 `tokio::time::Instant`(TTL/槽过期用),而令牌桶的
        // 单调钟口径是 `std::time::Instant`(创号闸同源)——这里必须显式写全路径。
        if !reg.device_admin_take(account, std::time::Instant::now()) {
            return Err(DeviceAdminError::Busy);
        }
        // ⑤ 不变量:任何一步只要会让 `admins` 变空就拒。
        // 白送三件事(§5.3):用户面永远踢不空一个账户 ⇒ `RevokeOutcome::AccountSealed`
        // 在用户面**不可达**。⚠ 照 264「不可达的防护 = 死码」,这里**不加**一道「若会
        // seal 则拒」的兜底,改由一只测钉住它不可达。
        let removes_an_admin = match action {
            DeviceAction::Remove => target_is_admin,
            DeviceAction::RevokeAdmin => true, // 幂等已早返 ⇒ 此刻 target 必是管理设备
            DeviceAction::GrantAdmin => false,
        };
        if removes_an_admin && reg.admin_count(account) == 1 {
            return Err(DeviceAdminError::WouldEmptyAdmins);
        }
        // ⑥ 执行。两条臂各自负责推名册:Remove 那条由 `revoke_locked` 内部推(它是
        // 唯一那条删除路径),Grant/Revoke 这条在这里推 —— 都在 registry 写成功之后,
        // 且都不返回 `Result`,已提交的义务不会随 `?` 蒸发(checklist 第 4 条)。
        match action {
            DeviceAction::Remove => {
                self.revoke_locked(&mut reg, account, target).map_err(|e| match e {
                    RevokeError::Persist => DeviceAdminError::Persist,
                    // NotFound 已由 ③ 排除;Corrupt/OwnerMismatch 是 admin 面按 device
                    // 反查那条路才有的形态(这里 account 由已鉴权会话给定)。
                    _ => DeviceAdminError::Persist,
                })?;
            }
            DeviceAction::GrantAdmin | DeviceAction::RevokeAdmin => {
                let on = matches!(action, DeviceAction::GrantAdmin);
                let changed = reg
                    .set_admin(account, target, on)
                    .map_err(|_| DeviceAdminError::Persist)?;
                debug_assert!(changed, "幂等已在 ④ 早返,走到这里必是真变化");
                self.push_roster_locked(&reg, account);
            }
        }
        logln(format!(
            "INFO 设备管理 account={account} caller={caller} target={target} action={action:?}"
        ));
        Ok(())
    }

    /// 运营者面设 / 清管理设备(`POST /admin/set-admin`;367,§5.6-6)。
    ///
    /// ⛔ **刻意不守「admins 不得变空」**:那条不变量只约束用户面。真出现「只设了一台
    /// 管理设备而它丢了」,运营者要能重设一台 —— 这就是逃生口(§5.3)。`Ok(false)` =
    /// 幂等无变化(不落盘、不推名册)。
    pub fn admin_set_admin(
        &self,
        account: &str,
        device: &str,
        on: bool,
    ) -> Result<bool, crate::registry::RegisterError> {
        let mut reg = self.registry.lock().unwrap();
        let changed = reg.set_admin(account, device, on)?;
        if changed {
            self.push_roster_locked(&reg, account);
        }
        Ok(changed)
    }

    /// SIGHUP 封禁表热重载 + **即时失权**(open-signup §1.2):重载封禁集合后,
    /// 持同一把 registry 锁嵌 state 锁,对每台 banned 在线设备先从 `online` 摘除
    /// 授权租约(route_send / pair_open 以它为据)、再 kick_and_burn(kick 专线 +
    /// draining 账本 + 当场烧其配对槽)、按需广播 offline;不等异步 conn detach,
    /// **信箱不删**(数据取回权,billing-plan §0)。本函数返回 = 即时失权的
    /// 线性化点:此后 banned 账户的尾帧投递、开槽、上线、注册全部不可能。
    /// 解析失败 = 保留旧集合上抛(fail-safe,在线态一根手指都不动)。
    pub fn reload_banlist(&self) -> std::io::Result<usize> {
        let mut reg = self.registry.lock().unwrap();
        let n = reg.reload_banlist()?;
        let mut st = self.state.lock().unwrap();
        let dead_addrs: Vec<Addr> =
            st.online.keys().filter(|(a, _)| reg.is_banned(a)).cloned().collect();
        for addr in dead_addrs {
            let dead = st.online.remove(&addr).expect("keys 快照,锁未放过");
            let conn = dead.conn_id;
            kick_and_burn(&mut st, &addr.0, dead);
            broadcast_offline(&st, &addr.0, &addr.1);
            logln(format!(
                "INFO 封禁即时失权 account={} device={}(在线,已 kick conn={conn})",
                addr.0, addr.1
            ));
        }
        Ok(n)
    }

    /// 背书注册的原子收尾(conn.rs RegisterDevice 用):同一 registry 锁内复核
    /// 「背书者此刻仍注册、公钥就是本会话验签那把」,再嵌 state 锁核授权租约
    /// 「本连接仍是背书者的当前在线连接」,而后插入(H1/H-ABA 吊销竞态:验签在
    /// 锁外,验完到插入之间背书者可能被吊、甚至被吊后同 device_id 重注册)。
    /// None = 背书资格已失,调用方按已吊销断开。
    pub fn register_endorsed(
        &self,
        account: &str,
        sponsor: &str,
        sponsor_pub: [u8; 32],
        conn_id: u64,
        new_device: &str,
        pubkey: [u8; 32],
    ) -> Option<Result<(), crate::registry::RegisterError>> {
        let mut reg = self.registry.lock().unwrap();
        if reg.pubkey_of(account, sponsor) != Some(sponsor_pub) {
            return None;
        }
        {
            let st = self.state.lock().unwrap();
            let addr: Addr = (account.to_owned(), sponsor.to_owned());
            if !st.online.get(&addr).is_some_and(|c| c.conn_id == conn_id) {
                return None;
            }
        }
        let out = reg.register_device(
            account,
            new_device,
            pubkey,
            self.cfg.device_cap,
            time::OffsetDateTime::now_utc(),
        );
        // 367:新设备进来也是成员集合变化 ⇒ 重推名册(§5.4 的四个触发点之一)。
        if out.is_ok() {
            self.push_roster_locked(&reg, account);
        }
        Some(out)
    }

    /// 纪元席位租约的原子收尾(conn.rs SeatLease 用;billing-plan §5 工序 2)。
    /// 与 [`Self::register_endorsed`] 同构:registry 锁内复核「sponsor 此刻仍注册、
    /// 公钥就是本会话验签那把」+ state 锁内核授权租约「本连接仍是其当前在线连接」,
    /// 而后开租。None = 资格已失,调用方按已吊销断开。
    pub fn grant_seat_lease(
        &self,
        account: &str,
        sponsor: &str,
        sponsor_pub: [u8; 32],
        conn_id: u64,
        new_device: &str,
        new_pubkey: [u8; 32],
    ) -> Option<Result<(), crate::registry::SeatLeaseError>> {
        let mut reg = self.registry.lock().unwrap();
        if reg.pubkey_of(account, sponsor) != Some(sponsor_pub) {
            return None;
        }
        {
            let st = self.state.lock().unwrap();
            let addr: Addr = (account.to_owned(), sponsor.to_owned());
            if !st.online.get(&addr).is_some_and(|c| c.conn_id == conn_id) {
                return None;
            }
        }
        Some(reg.grant_seat_lease(
            account,
            sponsor,
            new_device,
            new_pubkey,
            self.cfg.device_cap,
            time::OffsetDateTime::now_utc(),
            self.cfg.seat_lease_ttl,
        ))
    }

    /// 定期清扫(§4 信箱 TTL 的兜底 + 槽过期 + 过期席位租约):spawn 在 serve 里,
    /// 间隔 cfg.sweep_interval。
    pub fn sweep(&self) {
        // 过期席位租约回收(消费/匹配处已惰性判死,这里只收内存;独立锁段,
        // 不与 state 侧清扫嵌套)。
        {
            let mut reg = self.registry.lock().unwrap();
            let n = reg.sweep_seat_leases(time::OffsetDateTime::now_utc());
            if n > 0 {
                logln(format!("INFO 清扫过期席位租约 {n} 枚"));
            }
            // 367:回收满桶的设备管理令牌条目(满桶 = 没欠账,删了重建语义相同)
            // ⇒ 那张表的规模有**近期活跃账户数**上界,不随运行时长单调增长。
            // ⚠ 这里的 `Instant` 是 `std` 的单调钟(令牌桶口径,与本文件的
            // `tokio::time::Instant` 不是一个东西),故显式写全路径。
            reg.sweep_admin_buckets(std::time::Instant::now());
        }
        let now = Instant::now();
        let ttl = self.cfg.mailbox_ttl;
        let slot_ttl = self.cfg.pair_slot_ttl;
        let mut st = self.state.lock().unwrap();
        st.mailboxes.retain(|(account, device), mb| {
            while mb.frames.front().is_some_and(|f| now.duration_since(f.at) > ttl) {
                let f = mb.frames.pop_front().expect("front 已证存在");
                mb.bytes -= f.cost;
                mb.dropped += 1;
            }
            if !mb.frames.is_empty() || mb.dropped > 0 {
                logln(format!(
                    "INFO mailbox account={account} device={device} frames={} bytes={} dropped={}",
                    mb.frames.len(),
                    mb.bytes,
                    mb.dropped
                ));
            }
            !mb.frames.is_empty()
        });
        {
            let HubState { slots, draining, .. } = &mut *st;
            slots.retain(|slot, s| {
                if now.duration_since(s.opened) <= slot_ttl {
                    return true;
                }
                push(&s.owner_tx, ServerMsg::PairPeer { event: PairEvent::Closed });
                if let Some((_, joiner_tx, _, _)) = &s.joiner {
                    push(joiner_tx, ServerMsg::PairPeer { event: PairEvent::Closed });
                }
                retire_joiner_ledger(draining, s);
                logln(format!("INFO 配对槽 {slot} 过期烧毁"));
                false
            });
        }
    }
}

/// 摘线两连(顶替 / 慢客户端 / 吊销的共用收尾,codex P4-e 三轮 M):kick 专线 +
/// **当场**烧其配对槽——不等被 kick 连接自己 detach,否则「摘线到 detach」的窗口
/// 里旧槽还能被 PairJoin/PairMsg 使用(吊销场景更找不到它烧)。调用方已把该
/// Client 从 online 移除并持 state 锁;offline 广播各路径自理(顶替不广播)。
fn kick_and_burn(st: &mut HubState, account: &str, dead: Client) {
    let _ = dead.kick.try_send(());
    // 二弹 M:摘线 ≠ 内存已释放(writer abort 前、正常断开还允许排空 10s)——
    // 账本移入 draining 继续计入全局预算,strong_count==1(conn 侧句柄全灭、
    // 通道已 drop)时被 prune_draining 剪掉。
    if dead.queued.load(Ordering::Relaxed) > 0 {
        st.draining.push((account.to_owned(), dead.queued.clone()));
    }
    burn_slots_of(st, dead.conn_id);
}

/// 剪掉已真实释放的 draining 账本(conn 侧句柄全灭 = 通道内存已随 drop 释放,
/// 或已排空到 0)。每次预算扫描顺手跑,列表长度受活跃连接数约束。
fn prune_draining(st: &mut HubState) {
    st.draining.retain(|(_, q)| Arc::strong_count(q) > 1 && q.load(Ordering::Relaxed) > 0);
}

/// 烧掉某连接涉及的全部配对槽并通知另一端(§4;detach 与 kick_and_burn 共用)。
/// 调用方持 state 锁;槽数有上限,全表扫。
fn burn_slots_of(st: &mut HubState, conn_id: u64) {
    let HubState { slots, draining, .. } = st;
    slots.retain(|slot, s| {
        let is_owner = s.owner_conn == conn_id;
        let is_joiner = s.joiner.as_ref().is_some_and(|(c, _, _, _)| *c == conn_id);
        if !is_owner && !is_joiner {
            return true;
        }
        let other = if is_owner { s.joiner.as_ref().map(|(_, t, _, _)| t) } else { Some(&s.owner_tx) };
        if let Some(tx) = other {
            push(tx, ServerMsg::PairPeer { event: PairEvent::Left });
        }
        retire_joiner_ledger(draining, s);
        logln(format!("INFO 配对槽 {slot} 随 conn={conn_id} 断开烧毁"));
        false
    });
}

/// 烧槽并通知**两侧** Closed(配额超限/桥断的收口;与 pair_close 的「通知另一端」
/// 不同——这里发送方也要知道桥没了)。调用方持 state 锁。
fn burn_slot_notify_both(st: &mut HubState, slot: u64) {
    if let Some(s) = st.slots.remove(&slot) {
        push(&s.owner_tx, ServerMsg::PairPeer { event: PairEvent::Closed });
        if let Some((_, joiner_tx, _, _)) = &s.joiner {
            push(joiner_tx, ServerMsg::PairPeer { event: PairEvent::Closed });
        }
        retire_joiner_ledger(&mut st.draining, &s);
    }
}

/// 槽消亡时把 joiner 的在途账本转入 draining(joiner 未鉴权、不在 online——槽是
/// 它的唯一账本挂点;不转则烧槽即从派生消失,内存却还在其 mpsc 里)。owner 侧
/// 账本挂在 online/draining,槽消亡不影响。
fn retire_joiner_ledger(draining: &mut Vec<(String, QueuedBytes)>, s: &PairSlot) {
    if let Some((_, _, q, kick)) = &s.joiner {
        // 槽死即踢 joiner(2026-07-31 codex H1;本函数是全部槽死点的公共汇点):
        // 未鉴权连接只为这只槽活着,槽没了立刻断、归还连接 permit。若槽死正是
        // joiner 自己发起(PairClose/断线),kick 落在已退出的循环后,无害。
        let _ = kick.try_send(());
        if q.load(Ordering::Relaxed) > 0 && Arc::strong_count(q) > 1 {
            draining.push((s.account.clone(), q.clone()));
        }
    }
}

/// 向账户内(除 gone 以外的)在线设备广播某设备下线。调用方持 state 锁。
fn broadcast_offline(st: &HubState, account: &str, gone: &str) {
    for ((a, _), c) in st.online.iter().filter(|((a, d), _)| a.as_str() == account && d != gone) {
        let _ = a; // 只为解构;push 目标是 c
        push(&c.tx, ServerMsg::Peer { device: gone.to_owned(), online: false });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 账户号用合法 ULID 形态(封禁表逐行 is_ulid 校验,reload 测试要能封它);
    /// 设备号 registry/hub 不校验形态,保留可读短名(形态校验在 conn 层)。
    const ACCT: &str = "0ACCTAACCTAACCTAACCTAACCTA";
    const ACCT_B: &str = "0ACCTBACCTBACCTBACCTBACCTB";
    const D1: &str = "DEV_1";
    const D2: &str = "DEV_2";

    /// register_device 的 now 入参(hub 测试不测到期语义,真墙钟即可;到期用
    /// 显式时刻的测试在 registry.rs)。
    fn now() -> time::OffsetDateTime {
        time::OffsetDateTime::now_utc()
    }

    /// 直造 Hub(绕开 WS/验签,专测路由与信箱语义)。
    fn hub(tweak: impl FnOnce(&mut Config)) -> Hub {
        hub_with_banlist(tweak).0
    }

    /// 同上,另返回封禁表路径(reload 测试改文件后热重载用)。
    fn hub_with_banlist(tweak: impl FnOnce(&mut Config)) -> (Hub, PathBuf) {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir: PathBuf = crate::test_temp::dir().join(format!(
            "zhujian-syncd-hubtest-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let banlist = dir.join("banlist.txt");
        std::fs::write(&banlist, "# 空封禁表\n").unwrap();
        let mut reg = Registry::load(&banlist, dir.join("registry.json")).unwrap();
        reg.register_first(ACCT, D1, [1; 32]).unwrap();
        reg.register_device(ACCT, D2, [2; 32], 8, now()).unwrap();
        // 夹具账户提额到 8 席(=旧「只有硬帽」时代的语义):本模块测的是路由/预算/
        // 槽,席位闸的商业层有专测,别让免费档 2 席横插进无关断言。
        let wide = crate::registry::Entitlement {
            seat_quota: 8,
            ..crate::registry::Entitlement::free_default()
        };
        reg.set_entitlement(ACCT, wide, time::OffsetDateTime::now_utc()).unwrap();
        let mut cfg = Config::new(banlist.clone(), dir.join("registry.json"));
        tweak(&mut cfg);
        (Hub::new(cfg, reg), banlist)
    }

    fn chan(cap: usize) -> (Tx, mpsc::Receiver<ServerMsg>, KickTx, mpsc::Receiver<()>) {
        let (tx, rx) = mpsc::channel(cap);
        let (kick, kick_rx) = mpsc::channel(1);
        (tx, rx, kick, kick_rx)
    }

    /// 工序4:build_account_status 的越额边界(used==quota 仍 Open、>quota 才 RateLimited)
    /// + 席位展示取硬帽 min(codex M2/M4⑤⑦)。
    #[test]
    fn build_status_boundary_and_seat_cap() {
        let h = hub(|c| c.device_cap = 8);
        {
            // entitlement seat_quota=16 > 硬帽 8 → 展示应 min=8。
            let mut reg = h.registry.lock().unwrap();
            let ent = crate::registry::Entitlement {
                tier: "large".into(),
                seat_quota: 16,
                ..crate::registry::Entitlement::free_default()
            };
            reg.set_entitlement(ACCT, ent, now()).unwrap();
        }
        let reg = h.registry.lock().unwrap();
        let now_wall = now();
        let period = crate::registry::month_of(now_wall);
        // used == quota:over=false → Open、无受限、rate=0。
        match h.build_account_status(&reg, ACCT, now_wall, period, 1000, 1000) {
            ServerMsg::AccountStatusV1 {
                seat_quota,
                data_plane,
                restriction_reasons,
                effective_rate_bps,
                fastlane_used,
                fastlane_quota,
                ..
            } => {
                assert_eq!(seat_quota, 8, "展示硬帽 min(16,8)=8");
                assert!(matches!(data_plane, DataPlane::Open), "used==quota 仍 Open");
                assert!(restriction_reasons.is_empty());
                assert_eq!(effective_rate_bps, 0);
                assert_eq!((fastlane_used, fastlane_quota), (1000, 1000));
            }
            other => panic!("期待 AccountStatusV1,得到 {other:?}"),
        }
        // used > quota:RateLimited + FastlaneExhausted + rate>0。
        match h.build_account_status(&reg, ACCT, now_wall, period, 1001, 1000) {
            ServerMsg::AccountStatusV1 { data_plane, restriction_reasons, effective_rate_bps, .. } => {
                assert!(matches!(data_plane, DataPlane::RateLimited), "used>quota → RateLimited");
                assert_eq!(restriction_reasons, vec![Restriction::FastlaneExhausted]);
                assert!(effective_rate_bps > 0);
            }
            other => panic!("期待 AccountStatusV1,得到 {other:?}"),
        }
    }

    /// 工序4 命根子 + M1(确定性):push_account_status 对 cap 连接恒推 AccountStatusV1、
    /// 对无 caps 旧连接**仅当前受限**才推 account_throttled(未受限时一帧都不给它——
    /// 旧客户端永不收 AccountStatusV1 新变体)。按当前快照门控 = 堵住「越额后 admin 解除、
    /// 旧端仍误收 throttled」的竞态(revision 乱序无害靠客户端取最大,此处不涉)。
    #[test]
    fn push_status_pushes_cap_and_gates_old_client() {
        let h = hub(|_| {});
        let (tx1, mut rx1, kick1, _k1) = chan(64);
        let (tx2, mut rx2, kick2, _k2) = chan(64);
        // D1=cap(wants_status=true),D2=旧(false)。
        h.attach_authenticated(ACCT, D1, [1; 32], 1, tx1, kick1, QueuedBytes::default(), true, false, RosterInflight::default())
            .unwrap();
        let g2 = h
            .attach_authenticated(ACCT, D2, [2; 32], 2, tx2, kick2, QueuedBytes::default(), false, false, RosterInflight::default())
            .unwrap();
        while rx1.try_recv().is_ok() {} // 排空 attach 期帧(Authed/AccountStatusV1/Peer)
        while rx2.try_recv().is_ok() {}
        // 未越额 push:cap 收 Open,旧连接一帧都不收(命根子阴性 + M1 未受限不误发)。
        h.push_account_status(ACCT);
        assert!(
            matches!(rx1.try_recv(), Ok(ServerMsg::AccountStatusV1 { data_plane: DataPlane::Open, .. })),
            "cap 连接收 AccountStatusV1(Open)"
        );
        assert!(rx1.try_recv().is_err(), "cap 只收一条");
        assert!(rx2.try_recv().is_err(), "无 caps 旧连接未受限时 push 不给它任何帧");
        // D2 发帧越额(读实际 grant 再 +1 跨线——ACCT 有 entitlement,grant 非免费档小值)。
        let grant = h.registry.lock().unwrap().effective_grant_quota(ACCT, now());
        let (_d, nr) = h.throttle_admission(ACCT, D2, g2, 2, grant + 1);
        assert!(nr, "首次越额 newly_restricted");
        while rx1.try_recv().is_ok() {}
        while rx2.try_recv().is_ok() {}
        // 受限 push:cap 收 RateLimited,旧连接收 account_throttled。
        h.push_account_status(ACCT);
        assert!(
            matches!(rx1.try_recv(), Ok(ServerMsg::AccountStatusV1 { data_plane: DataPlane::RateLimited, .. })),
            "cap 连接收 RateLimited"
        );
        assert!(
            matches!(rx2.try_recv(), Ok(ServerMsg::Err { code, .. }) if code == err_code::ACCOUNT_THROTTLED),
            "旧连接当前受限收 account_throttled"
        );
    }

    fn deliver(from: &str, to: &str, blob: &[u8]) -> ServerMsg {
        ServerMsg::Deliver { from: from.into(), to: to.into(), blob: blob.to_vec() }
    }

    /// D1 以 conn_id=cid 上线(fixture 公钥 [1;32]/[2;32],见 hub())。账本按连接
    /// 新造——只想上线不查预算的测试用它;预算测试用 [`attach_with_ledger`]。
    fn attach_dev(h: &Hub, dev: &str, key: [u8; 32], cid: u64, tx: Tx, kick: KickTx) -> bool {
        h.attach_authenticated(ACCT, dev, key, cid, tx, kick, QueuedBytes::default(), false, false, RosterInflight::default()).is_some()
    }

    /// 上线并返回该连接的字节账本(预算测试断言/模拟「写任务未出队」用)。
    fn attach_with_ledger(
        h: &Hub,
        dev: &str,
        key: [u8; 32],
        cid: u64,
        tx: Tx,
        kick: KickTx,
    ) -> QueuedBytes {
        let q = QueuedBytes::default();
        assert!(h.attach_authenticated(ACCT, dev, key, cid, tx, kick, q.clone(), false, false, RosterInflight::default()).is_some());
        q
    }

    /// codex P2-e H2:慢客户端(队满)= 摘下线 + kick 断连 + offline 广播,
    /// 该帧起走离线逻辑(mail 回信箱、direct 判 not_online),重连后信箱接力。
    #[tokio::test]
    async fn slow_client_detached_kicked_and_remailed() {
        let h = hub(|_| {});
        // D2 的下行队容量 3(模拟收不动);D1 正常。
        let (tx2, mut rx2, kick2, mut kick2_rx) = chan(3);
        assert!(attach_dev(&h, D2, [2; 32], 1, tx2, kick2));
        let (tx1, mut rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 2, tx1, kick1));
        // D2 队里已有 Authed + D1 上线事件占 2 格;再投 1 帧满、第 2 帧触发摘除。
        assert_eq!(h.route_send(ACCT, D1, 2, D2, Lane::Mail, b"m1".to_vec()), Ok(()));
        assert_eq!(h.route_send(ACCT, D1, 2, D2, Lane::Mail, b"m2".to_vec()), Ok(()));
        assert_eq!(kick2_rx.try_recv(), Ok(()), "慢客户端该被 kick");
        // D1 先收 Authed 与上线快照(D2 在线),摘除后收 offline 广播。
        assert_eq!(rx1.try_recv(), Ok(ServerMsg::Authed));
        assert_eq!(rx1.try_recv(), Ok(ServerMsg::Peer { device: D2.into(), online: true }));
        assert_eq!(rx1.try_recv(), Ok(ServerMsg::Peer { device: D2.into(), online: false }));
        // 摘除后 direct 指名 = not_online;mail 继续入箱。
        assert_eq!(
            h.route_send(ACCT, D1, 2, D2, Lane::Direct, b"d".to_vec()),
            Err(err_code::NOT_ONLINE)
        );
        assert_eq!(h.route_send(ACCT, D1, 2, D2, Lane::Mail, b"m3".to_vec()), Ok(()));
        // 旧队列里只有 offline 前塞进去的东西(Authed + Peer 上线 + m1)。
        assert_eq!(rx2.try_recv(), Ok(ServerMsg::Authed));
        assert_eq!(rx2.try_recv(), Ok(ServerMsg::Peer { device: D1.into(), online: true }));
        assert_eq!(rx2.try_recv(), Ok(deliver(D1, D2, b"m1")));
        // 重连:m2(触发摘除那帧,已回箱)与 m3 按序接力。
        let (tx2b, mut rx2b, kick2b, _k2b) = chan(64);
        assert!(attach_dev(&h, D2, [2; 32], 3, tx2b, kick2b));
        assert_eq!(rx2b.try_recv(), Ok(ServerMsg::Authed));
        assert_eq!(rx2b.try_recv(), Ok(deliver(D1, D2, b"m2")));
        assert_eq!(rx2b.try_recv(), Ok(deliver(D1, D2, b"m3")));
    }

    /// codex P2-e M1:attach 搬箱时连接已死 → 余帧原位留箱,下次上线不丢。
    #[tokio::test]
    async fn attach_requeues_when_channel_full() {
        let h = hub(|_| {});
        // 发端 D1 先上线(授权租约:route 只认当前在线连接的帧)。
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 7, tx1, kick1));
        // 三帧入箱(D2 离线)。
        for b in [b"a", b"b", b"c"] {
            assert_eq!(h.route_send(ACCT, D1, 7, D2, Lane::Mail, b.to_vec()), Ok(()));
        }
        // 容量 2 的连接来收:Authed 占 1 格、只搬走第一帧,余两帧留箱。
        let (tx, mut rx, kick, _k) = chan(2);
        assert!(attach_dev(&h, D2, [2; 32], 1, tx, kick));
        assert_eq!(rx.try_recv(), Ok(ServerMsg::Authed));
        assert_eq!(rx.try_recv(), Ok(deliver(D1, D2, b"a")));
        // 再上线(容量够):b、c 按序还在。
        let (tx2, mut rx2, kick2, _k2) = chan(64);
        assert!(attach_dev(&h, D2, [2; 32], 2, tx2, kick2));
        assert_eq!(rx2.try_recv(), Ok(ServerMsg::Authed));
        assert_eq!(rx2.try_recv(), Ok(deliver(D1, D2, b"b")));
        assert_eq!(rx2.try_recv(), Ok(deliver(D1, D2, b"c")));
        assert!(matches!(rx2.try_recv(), Ok(ServerMsg::Peer { .. }))); // D1 在线快照殿后
    }

    // ---- 367:用户面设备管理 -------------------------------------------------

    /// 上线一条**声明了名册 cap** 的连接,回下行队(名册三条只发给声明者)。
    fn attach_cap(h: &Hub, dev: &str, key: [u8; 32], cid: u64) -> mpsc::Receiver<ServerMsg> {
        let (tx, rx, kick, _k) = chan(64);
        std::mem::forget(_k); // kick 接收端留着,别让通道当场关掉
        assert!(h
            .attach_authenticated(
                ACCT,
                dev,
                key,
                cid,
                tx,
                kick,
                QueuedBytes::default(),
                false,
                true,
                RosterInflight::default()
            )
            .is_some());
        rx
    }

    /// 从下行队里捞出下一枚 Roster(跳过 Authed / Peer 这些噪音);没有就 None。
    fn next_roster(rx: &mut mpsc::Receiver<ServerMsg>) -> Option<(Option<u64>, u64, Vec<RosterEntry>)> {
        while let Ok(m) = rx.try_recv() {
            if let ServerMsg::Roster { request, revision, devices } = m {
                return Some((request, revision, devices));
            }
        }
        None
    }

    /// 六轮点名那三只里的第三只(前两只住 sync-proto):**服务端的主动状态推送
    /// 拒绝使用任何 flow code**。⚠ 「测一个字符串等于某常量」是同义反复、别写;有牙齿
    /// 的是这条 —— 把契约做成运行期守卫,再拿一刀证明它真会咬人。
    #[test]
    #[should_panic(expected = "flow 白名单里的 code")]
    fn advisory_push_refuses_flow_codes() {
        let _ = advisory_err(err_code::BUSY, "假装这是一枚主动推送");
    }

    /// 与上一只配对的绿:今天真正在用的那个 code 不在任何表里,故推得出去。
    #[test]
    fn advisory_push_accepts_the_throttle_code() {
        let m = advisory_err(err_code::ACCOUNT_THROTTLED, THROTTLE_MSG);
        assert!(matches!(m, ServerMsg::Err { .. }));
    }

    /// 授权判据的四象限(§5.3 唯一正式子)。**直接量那个纯函数**——端到端路径上还有
    /// 好几把尺,拿它记账分不清是谁拒的(first-draft-checklist 第 13 条)。
    #[test]
    fn device_admin_authorized_truth_table() {
        for action in [DeviceAction::Remove, DeviceAction::GrantAdmin, DeviceAction::RevokeAdmin] {
            // 管理设备:三个动作 × 对自己/对别人,一律许。
            assert!(device_admin_authorized(true, action, true), "{action:?}");
            assert!(device_admin_authorized(true, action, false), "{action:?}");
            // 非管理设备:**只有「移除自己」这一格**许(自助退出)。
            assert_eq!(
                device_admin_authorized(false, action, true),
                matches!(action, DeviceAction::Remove),
                "非管理设备对自己 {action:?}"
            );
            assert!(!device_admin_authorized(false, action, false), "非管理设备对别人 {action:?}");
        }
    }

    /// ⭐ **提权四连**(设计审一轮 H1 的直接产物)。一只笼统的「非管理设备被拒」会被
    /// `Remove(self)` 那格**背书成绿**,而漏掉的正是 `GrantAdmin{target: 自己}` ——
    /// 规格的错误表当初写成「不是管理设备**且** target != caller → 拒」,于是它落在
    /// `target == caller` 上**绕过整条闸自我提权**。四格必须分开写。
    ///
    /// ⚠ 每格都自证「拒它的是**授权**那道闸」:`admins` 非空(排除 ①)、target 恒在册
    /// (排除 ③)、且都不是幂等(排除 ④)⇒ `Forbidden` 只可能来自 ②。
    #[test]
    fn non_admin_privilege_escalation_four_ways() {
        let h = hub(|_| {});
        let _rx1 = attach_cap(&h, D1, [1; 32], 1); // D1 = 首台 ⇒ 管理设备
        let _rx2 = attach_cap(&h, D2, [2; 32], 2); // D2 = 背书进来 ⇒ 非管理设备
        assert!(h.registry.lock().unwrap().is_admin(ACCT, D1));
        assert!(!h.registry.lock().unwrap().is_admin(ACCT, D2));
        let d2 = |target: &str, action| h.device_admin(ACCT, D2, [2; 32], 2, target, action);
        // ① 对**自己**提权 —— 就是那条漏掉的路。
        assert_eq!(d2(D2, DeviceAction::GrantAdmin), Err(DeviceAdminError::Forbidden));
        // ② 对自己取消管理位(它本来就不是,但**授权先于幂等**,故仍是 Forbidden ——
        //    幂等排在授权之前的话,这一格会回一个成功回执并顺带泄露名单状态)。
        assert_eq!(d2(D2, DeviceAction::RevokeAdmin), Err(DeviceAdminError::Forbidden));
        // ③ 对别人做任何动作。
        assert_eq!(d2(D1, DeviceAction::Remove), Err(DeviceAdminError::Forbidden));
        assert_eq!(d2(D1, DeviceAction::GrantAdmin), Err(DeviceAdminError::Forbidden));
        assert_eq!(d2(D1, DeviceAction::RevokeAdmin), Err(DeviceAdminError::Forbidden));
        // ④ 唯一许的那格:移除自己(自助退出),且席位真的下降。
        assert_eq!(h.registry.lock().unwrap().devices_of(ACCT).len(), 2);
        assert_eq!(d2(D2, DeviceAction::Remove), Ok(()));
        assert_eq!(h.registry.lock().unwrap().devices_of(ACCT), vec![D1.to_string()]);
    }

    /// `admins` 为空的存量账户 ⇒ 用户面**整条不可用,含自助退出**(§5.3-3,首版自检
    /// 第 6 条挡下的):不变量只说「不得**变**空」,对**已经**是空的账户约束为零 ——
    /// 这时放行自助退出,存量账户能被逐台退到空、直接撞出账户封存(而封存不可自助重开)。
    ///
    /// ⚠ 样本与提权那只**必须落在对方够不着的地方**(§5.14 点名):空集合下每台设备
    /// 都不是管理设备,一只测同时满足 ①② 两个前件。这里 caller 用 **D1** —— 它在
    /// 回填过的账户里本来是管理设备,故拒它的只可能是 ①。
    #[test]
    fn empty_admins_disables_the_whole_user_face_including_self_exit() {
        let h = hub(|_| {});
        let _rx1 = attach_cap(&h, D1, [1; 32], 1);
        // 运营者面清空管理设备(它刻意可以破坏那条不变量 —— 逃生口的另一半)。
        assert_eq!(h.admin_set_admin(ACCT, D1, false), Ok(true));
        assert!(!h.registry.lock().unwrap().has_admins(ACCT));
        let d1 = |target: &str, action| h.device_admin(ACCT, D1, [1; 32], 1, target, action);
        assert_eq!(d1(D1, DeviceAction::Remove), Err(DeviceAdminError::NoAdmins), "自助退出也得拒");
        assert_eq!(d1(D2, DeviceAction::Remove), Err(DeviceAdminError::NoAdmins));
        assert_eq!(d1(D1, DeviceAction::GrantAdmin), Err(DeviceAdminError::NoAdmins));
        // 账户一台都没少。
        assert_eq!(h.registry.lock().unwrap().devices_of(ACCT).len(), 2);
    }

    /// 不变量:**用户面永远踢不空一个账户**(admins ⊆ devices,admins 非空 ⇒ devices
    /// 非空)。⇒ `RevokeOutcome::AccountSealed` 在用户面**不可达**。
    ///
    /// ⚠ 照 264「不可达的防护 = 死码」,代码里**没有**一道「若会 seal 则拒」的兜底;
    /// 这只测就是钉住它不可达的那枚(§5.3 白送三件事之一)。
    #[test]
    fn user_face_can_never_seal_an_account() {
        let h = hub(|_| {});
        let _rx1 = attach_cap(&h, D1, [1; 32], 1);
        let _rx2 = attach_cap(&h, D2, [2; 32], 2);
        let d1 = |target: &str, action| h.device_admin(ACCT, D1, [1; 32], 1, target, action);
        // D1 是唯一的管理设备:移除自己 / 取消自己的管理位,两条都会让 admins 变空。
        assert_eq!(d1(D1, DeviceAction::Remove), Err(DeviceAdminError::WouldEmptyAdmins));
        assert_eq!(d1(D1, DeviceAction::RevokeAdmin), Err(DeviceAdminError::WouldEmptyAdmins));
        // 把 D2 也升成管理设备之后,D1 就退得掉了(admins 仍非空)。
        assert_eq!(d1(D2, DeviceAction::GrantAdmin), Ok(()));
        assert_eq!(d1(D1, DeviceAction::Remove), Ok(()));
        // 现在只剩 D2 一台、且它是唯一管理设备 ⇒ 用户面再也踢不动 ⇒ 账户不可能归零。
        let d2 = |target: &str, action| h.device_admin(ACCT, D2, [2; 32], 2, target, action);
        assert_eq!(d2(D2, DeviceAction::Remove), Err(DeviceAdminError::WouldEmptyAdmins));
        assert!(!h.registry.lock().unwrap().devices_of(ACCT).is_empty(), "账户绝不会被用户面吊空");
    }

    /// 幂等的 Grant/Revoke:**成功回执,但不升 revision、不 fan-out**(§5.13 M1 ——
    /// 管理设备可以无限交替 Grant/Revoke,每次都触发全量落盘 + 全账户 fan-out)。
    ///
    /// 「不升 revision」的判据挑得能证伪:真变化那两枚的 revision **必须恰好差 1**,
    /// 中间那 5 枚幂等若各取了一个号,差值就不是 1 了。
    #[test]
    fn idempotent_admin_changes_neither_bump_revision_nor_fan_out() {
        let h = hub(|_| {});
        let mut rx1 = attach_cap(&h, D1, [1; 32], 1);
        let _rx2 = attach_cap(&h, D2, [2; 32], 2);
        let d1 = |target: &str, action| h.device_admin(ACCT, D1, [1; 32], 1, target, action);
        assert!(next_roster(&mut rx1).is_some(), "上线那一枚名册");
        // 真变化:推一枚。
        assert_eq!(d1(D2, DeviceAction::GrantAdmin), Ok(()));
        let (_, rev_a, devices) = next_roster(&mut rx1).expect("真变化要推名册");
        assert_eq!(devices.len(), 2);
        assert!(devices.iter().all(|e| e.admin), "两台都成了管理设备");
        // 幂等 ×5:回执成功,但一枚名册都不该来。
        for _ in 0..5 {
            assert_eq!(d1(D2, DeviceAction::GrantAdmin), Ok(()));
        }
        assert!(next_roster(&mut rx1).is_none(), "幂等不许 fan-out");
        // 再来一次真变化:revision 恰好 +1 ⇒ 中间那 5 枚一个号都没取。
        assert_eq!(d1(D2, DeviceAction::RevokeAdmin), Ok(()));
        let (_, rev_b, _) = next_roster(&mut rx1).expect("真变化要推名册");
        assert_eq!(rev_b, rev_a + 1, "幂等不许升 revision");
    }

    /// H-ABA 授权租约(§5.3 ⓪):验签在锁外,验完到执行之间发起方可能被吊、或被同
    /// device_id 重注册换钥、或它那条连接已被新连接顶替 —— 三格都必须当场拒且**断连**。
    #[test]
    fn device_admin_checks_the_h_aba_lease() {
        let h = hub(|_| {});
        let _rx1 = attach_cap(&h, D1, [1; 32], 1);
        let _rx2 = attach_cap(&h, D2, [2; 32], 2);
        // ① 公钥对不上(吊后同 id 重注册换钥的 ABA)。
        assert_eq!(
            h.device_admin(ACCT, D1, [9; 32], 1, D2, DeviceAction::Remove),
            Err(DeviceAdminError::Unauthorized)
        );
        // ② 这条连接已不是它的当前在线连接(旧连接被顶替后迟到的命令)。
        let _rx1b = attach_cap(&h, D1, [1; 32], 11);
        assert_eq!(
            h.device_admin(ACCT, D1, [1; 32], 1, D2, DeviceAction::Remove),
            Err(DeviceAdminError::Unauthorized)
        );
        // ③ 发起方已被并发吊销(在飞命令必拒)。
        assert!(h.revoke_device(Some(ACCT), D2).is_ok());
        assert_eq!(
            h.device_admin(ACCT, D2, [2; 32], 2, D1, DeviceAction::Remove),
            Err(DeviceAdminError::Unauthorized)
        );
        // 两格都要断连(业务判定一律不断)。
        assert!(DeviceAdminError::Unauthorized.is_fatal());
        assert!(DeviceAdminError::Banned.is_fatal());
        for e in [
            DeviceAdminError::NoAdmins,
            DeviceAdminError::Forbidden,
            DeviceAdminError::UnknownTarget,
            DeviceAdminError::Busy,
            DeviceAdminError::WouldEmptyAdmins,
            DeviceAdminError::Persist,
        ] {
            assert!(!e.is_fatal(), "{e:?} 是业务判定,不该断连");
        }
    }

    /// 两台管理设备**同时互踢,恰一个成功**(§5.3 白送三件事之二)。registry 锁串行化
    /// 二者,而**后到的那条**在同一把锁内会撞上 H-ABA 复核:它此刻已不在册。
    ///
    /// ⚠ **这只测原先是串行的**(实现审弹二 L2):两条命令一前一后调,证明的只是
    /// 「吊完之后它再来会被拒」,而不是「两枚**同时**争 registry 锁时恰一个赢」——
    /// 而后者才是这只测的名字所声称的东西。现在两条线程在 barrier 上一起放行。
    ///
    /// ⛔ **barrier 只能放在取 registry 锁之前**:放进临界区里,先进去的那条会在
    /// barrier 上等一个永远拿不到锁的同伴 = 死锁。
    ///
    /// 判据**与谁赢无关**(真并发下赢家不确定,钉某一个就是靠调度运气的假验收):
    /// 结果**集合**恰是 `{Ok, Unauthorized}`,且事后恰好剩一台设备。
    #[test]
    fn two_admins_kicking_each_other_exactly_one_wins() {
        let h = std::sync::Arc::new(hub(|_| {}));
        let _rx1 = attach_cap(&h, D1, [1; 32], 1);
        let _rx2 = attach_cap(&h, D2, [2; 32], 2);
        h.device_admin(ACCT, D1, [1; 32], 1, D2, DeviceAction::GrantAdmin).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let hands: Vec<_> = [(D1, [1u8; 32], 1u64, D2), (D2, [2u8; 32], 2u64, D1)]
            .into_iter()
            .map(|(caller, key, conn, target)| {
                let (h, b) = (h.clone(), barrier.clone());
                std::thread::spawn(move || {
                    b.wait();
                    h.device_admin(ACCT, caller, key, conn, target, DeviceAction::Remove)
                })
            })
            .collect();
        let mut out: Vec<_> = hands.into_iter().map(|t| t.join().unwrap()).collect();
        out.sort_by_key(|r| r.is_err());
        assert_eq!(
            out,
            vec![Ok(()), Err(DeviceAdminError::Unauthorized)],
            "恰一个赢,输的那个撞 H-ABA(它此刻已不在册)"
        );
        assert_eq!(h.registry.lock().unwrap().devices_of(ACCT).len(), 1, "恰好剩一台");
    }

    /// target 不在本账户 = `unknown_device`(③)。
    /// ⚠ 样本必须落在 ② 够不着的地方:caller 用 **D1(管理设备)**,故授权那道过得去,
    /// 拒它的只可能是 ③(§5.14 点名的那对陷阱)。
    #[test]
    fn unknown_target_is_rejected_by_the_membership_gate() {
        let h = hub(|_| {});
        let _rx1 = attach_cap(&h, D1, [1; 32], 1);
        assert_eq!(
            h.device_admin(ACCT, D1, [1; 32], 1, "DEV_NOPE", DeviceAction::Remove),
            Err(DeviceAdminError::UnknownTarget)
        );
        assert_eq!(
            h.device_admin(ACCT, D1, [1; 32], 1, "DEV_NOPE", DeviceAction::GrantAdmin),
            Err(DeviceAdminError::UnknownTarget)
        );
    }

    /// 账户令牌:**未授权与幂等都不扣**(三轮 M4 / 四轮 M2)。
    ///
    /// 三轮 M4 的原话:否则任一非管理设备都能持续发越权请求把账户 burst 耗干,让真正的
    /// 管理设备长期收到 busy —— 共享桶被无权者压制。判据就照这句写:先让非管理设备
    /// 猛发越权请求 + 让管理设备猛发幂等请求,**然后**看真正的操作还做不做得动。
    #[test]
    fn account_tokens_are_spent_only_by_authorized_non_idempotent_requests() {
        let h = hub(|_| {});
        let _rx1 = attach_cap(&h, D1, [1; 32], 1);
        let _rx2 = attach_cap(&h, D2, [2; 32], 2);
        // 非管理设备的越权请求 ×40(远超账户 burst 10)。
        for _ in 0..40 {
            assert_eq!(
                h.device_admin(ACCT, D2, [2; 32], 2, D1, DeviceAction::GrantAdmin),
                Err(DeviceAdminError::Forbidden)
            );
        }
        // 管理设备的幂等请求 ×40(D2 本来就不是管理设备,RevokeAdmin 恒无变化)。
        for _ in 0..40 {
            assert_eq!(h.device_admin(ACCT, D1, [1; 32], 1, D2, DeviceAction::RevokeAdmin), Ok(()));
        }
        // 桶要是被上面那 80 枚耗过,这里第一枚就会 Busy。
        assert_eq!(h.device_admin(ACCT, D1, [1; 32], 1, D2, DeviceAction::GrantAdmin), Ok(()));
    }

    /// 非幂等的成功请求**要扣**账户令牌,扣光回 `busy`(而不是无限放行)。
    /// burst=10:第 1 枚上面那格已证会扣,这里连做 10 次真变化,第 11 次必 Busy
    /// (测试跑得远快于 10s 补墨间隔,不会有令牌回来)。
    #[test]
    fn account_token_bucket_runs_dry_and_answers_busy() {
        let h = hub(|_| {});
        let _rx1 = attach_cap(&h, D1, [1; 32], 1);
        let _rx2 = attach_cap(&h, D2, [2; 32], 2);
        // 交替 Grant/Revoke:每一枚都是真变化,各扣一枚令牌。
        for i in 0..crate::registry::DEVICE_ADMIN_BURST_ACCOUNT {
            let action =
                if i % 2 == 0 { DeviceAction::GrantAdmin } else { DeviceAction::RevokeAdmin };
            assert_eq!(h.device_admin(ACCT, D1, [1; 32], 1, D2, action), Ok(()), "第 {i} 枚");
        }
        assert_eq!(
            h.device_admin(ACCT, D1, [1; 32], 1, D2, DeviceAction::GrantAdmin),
            Err(DeviceAdminError::Busy)
        );
    }

    /// 名册面三件:cap 未声明者一枚都收不到 / `RosterReq` 的应答带 `request == Some(n)` /
    /// 主动推送带 `request == None`。
    #[test]
    fn roster_goes_only_to_cap_declaring_connections_and_correlates_requests() {
        let h = hub(|_| {});
        let mut rx_cap = attach_cap(&h, D1, [1; 32], 1);
        // D2 不声明 cap(attach_dev 的 wants_roster = false)。
        let (tx2, mut rx_old, kick2, _k2) = chan(64);
        std::mem::forget(_k2);
        assert!(h
            .attach_authenticated(
                ACCT,
                D2,
                [2; 32],
                2,
                tx2,
                kick2,
                QueuedBytes::default(),
                false,
                false,
                RosterInflight::default()
            )
            .is_some());
        // 上线推送:声明者拿到、未声明者一枚都没有。
        let (req, _, devices) = next_roster(&mut rx_cap).expect("声明 cap 者上线即收一枚");
        assert_eq!(req, None, "主动推送不带请求号");
        assert_eq!(devices.len(), 2);
        assert!(next_roster(&mut rx_old).is_none(), "未声明 cap 者绝不能收到名册");
        // 成员变化的 fan-out 同样只走声明者。
        h.device_admin(ACCT, D1, [1; 32], 1, D2, DeviceAction::GrantAdmin).unwrap();
        assert!(next_roster(&mut rx_cap).is_some());
        assert!(next_roster(&mut rx_old).is_none());
        // 应答带请求号(客户端靠它证明「这枚是我这次拉的」——一轮 H3)。
        assert!(h.reply_roster(ACCT, D1, 1, 4242));
        let (req, _, _) = next_roster(&mut rx_cap).expect("应答");
        assert_eq!(req, Some(4242));
        // 连接号对不上 = 不发(发的是账户名册,发错连接就是发错人)。
        assert!(!h.reply_roster(ACCT, D1, 999, 1));
        assert!(!h.reply_roster(ACCT, D2, 2, 1), "未声明 cap 者也不给应答");
    }

    /// 在途名册帧的上界(`MAX_ROSTER_INFLIGHT`)。
    ///
    /// ⛔ 这道闸是实现期算出来的、设计那张表把这格记成「过」:既有连接内存包络按
    /// `size_of::<ServerMsg>() × 槽数` 算,**不含每枚 roster 克隆的堆内存**,满槽是
    /// 16.3 MiB/连接 × 32 = 647 MiB > 448 MiB 包络。触界即**跳过这一枚**(名册推送
    /// 本来就允许丢,客户端周期拉取会补回来),不排队。
    #[test]
    fn roster_pushes_are_capped_per_connection() {
        let h = hub(|_| {});
        let (tx, mut rx, kick, _k) = chan(64);
        std::mem::forget(_k);
        let inflight = RosterInflight::default();
        assert!(h
            .attach_authenticated(
                ACCT,
                D1,
                [1; 32],
                1,
                tx,
                kick,
                QueuedBytes::default(),
                false,
                true,
                inflight.clone()
            )
            .is_some());
        // attach 已推一枚 ⇒ 在途 1。再连推到触界。
        assert_eq!(inflight.load(Ordering::Relaxed), 1);
        for _ in 0..10 {
            // 返回值刻意不看:这只测的判据是**队里真躺着几枚**(比「它自己说发没发出去」
            // 强一档),故显式丢弃而不是让 `#[must_use]` 在构建里留一条噪音。
            let _ = h.reply_roster(ACCT, D1, 1, 7);
        }
        assert_eq!(
            inflight.load(Ordering::Relaxed),
            MAX_ROSTER_INFLIGHT,
            "在途枚数必须停在上界上,而不是把队填满"
        );
        // ⚠ 只数 Roster:队里还躺着 Authed 那一枚,数「全部消息」会把上界看成 5。
        let mut rosters = 0;
        while let Ok(m) = rx.try_recv() {
            if matches!(m, ServerMsg::Roster { .. }) {
                rosters += 1;
            }
        }
        assert_eq!(rosters, MAX_ROSTER_INFLIGHT, "队里恰好只有上界那么多枚名册");
    }

    /// 在途额度的**记账顺序**(实现审弹二 M2)。两件事各一格:
    ///
    /// ① **占到额度才构造**。`build_roster` 会克隆整份名单**并推进全局 revision** ——
    ///    构造放在预占之前,一台不读下行的设备就能靠猛发 `RosterReq` 让服务器反复
    ///    构造再丢弃(那道 5s 间隔闸「答不出去就不推进基点」,恰恰不设防)。
    ///    ⭐ 判据挑得能证伪:被拒的那 5 枚若各取一个号,前后两枚真名册的 revision 就
    ///    **不会恰好差 1**(同 §5.13 幂等那只测的手法)。
    /// ② **入队失败即归还额度**。先加后发会漏出永久幽灵额度(写任务在另一线程
    ///    `saturating_sub` 到 0 之后这边才 `fetch_add`);而加了不还同样是幽灵。
    #[test]
    fn roster_credit_is_reserved_before_the_frame_is_ever_built() {
        let h = hub(|_| {});
        let (tx, mut rx, kick, _k) = chan(64);
        std::mem::forget(_k);
        let filler = tx.clone(); // 同一条通道:后面拿它把队填满,验「入队失败要还额度」。
        let inflight = RosterInflight::default();
        assert!(h
            .attach_authenticated(
                ACCT, D1, [1; 32], 1, tx, kick,
                QueuedBytes::default(), false, true, inflight.clone()
            )
            .is_some());
        // 填到上界(attach 已占一枚)。
        for n in 0..(MAX_ROSTER_INFLIGHT - 1) {
            assert!(h.reply_roster(ACCT, D1, 1, n as u64));
        }
        assert_eq!(inflight.load(Ordering::Relaxed), MAX_ROSTER_INFLIGHT);
        let last_before = drain_last_roster_revision(&mut rx).expect("到顶前最后那枚");
        // ① 到顶之后再来 5 枚:一枚都不许构造 ⇒ 一个号都不许取。
        for n in 0..5u64 {
            assert!(!h.reply_roster(ACCT, D1, 1, 100 + n), "到顶了就该直接拒");
        }
        assert_eq!(inflight.load(Ordering::Relaxed), MAX_ROSTER_INFLIGHT, "拒发不许再加账");
        // 腾一格(写任务出队即如此),再来一枚:它的 revision 必须**恰好**是上一枚 + 1。
        inflight.fetch_sub(1, Ordering::Relaxed);
        assert!(h.reply_roster(ACCT, D1, 1, 777));
        let next = drain_last_roster_revision(&mut rx).expect("腾出格子之后那枚");
        assert_eq!(next, last_before + 1, "被拒的那 5 枚各取了一个号 = 构造发生在预占之前");
        // ② 通道填满 ⇒ 连额度都不占、连名册都不建(弹二 L3:先占 mpsc 槽,故「发送失败
        //    要还额度」那条路整个不存在 —— 不存在的路比还得对的路强)。
        // (`next` 就是此刻队里最后那枚的号 —— ① 段刚把队排空过。)
        inflight.store(0, Ordering::Relaxed);
        while push(&filler, ServerMsg::Authed) {}
        assert!(!h.reply_roster(ACCT, D1, 1, 888), "队满发不出去");
        assert_eq!(inflight.load(Ordering::Relaxed), 0, "队满那次不许占额度");
        // 腾空队列后发一枚,它的号必须仍是「上一枚 + 1」⇒ 队满那次一个号都没取。
        while rx.try_recv().is_ok() {}
        assert!(h.reply_roster(ACCT, D1, 1, 999));
        let after = drain_last_roster_revision(&mut rx).expect("腾空之后那枚");
        assert_eq!(after, next + 1, "队满那次白建了一份名册(还顺手取了个号)");
    }

    /// 排空队列,回最后一枚 `Roster` 的 revision(`None` = 队里没有名册)。
    fn drain_last_roster_revision(rx: &mut mpsc::Receiver<ServerMsg>) -> Option<u64> {
        let mut last = None;
        while let Ok(m) = rx.try_recv() {
            if let ServerMsg::Roster { revision, .. } = m {
                last = Some(revision);
            }
        }
        last
    }

    /// H1 单设备吊销:在线被 kick + offline 广播 + 信箱清空 + 路由即拒;
    /// 幸存设备照常收发。
    #[tokio::test]
    async fn revoke_device_kicks_clears_and_rejects() {
        let h = hub(|_| {});
        let (tx1, mut rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1, kick1));
        let (tx2, _rx2, kick2, mut kick2_rx) = chan(64);
        assert!(attach_dev(&h, D2, [2; 32], 2, tx2, kick2));
        assert_eq!(h.revoke_device(Some(ACCT), D2), Ok((ACCT.into(), RevokeOutcome::DeviceRevoked)));
        assert_eq!(kick2_rx.try_recv(), Ok(()), "被吊设备该被 kick");
        assert_eq!(rx1.try_recv(), Ok(ServerMsg::Authed));
        assert_eq!(rx1.try_recv(), Ok(ServerMsg::Peer { device: D2.into(), online: true }));
        assert_eq!(rx1.try_recv(), Ok(ServerMsg::Peer { device: D2.into(), online: false }));
        // 吊销后:指名投递 = unknown_device(registry 已无此设备);广播静默跳过。
        assert_eq!(
            h.route_send(ACCT, D1, 1, D2, Lane::Mail, b"x".to_vec()),
            Err(err_code::UNKNOWN_DEVICE)
        );
        assert_eq!(h.route_send(ACCT, D1, 1, BROADCAST, Lane::Mail, b"y".to_vec()), Ok(()));
        // 重复吊 = NotFound 上抛。
        assert!(h.revoke_device(Some(ACCT), D2).is_err());
    }

    /// H1 吊销离线设备:积压信箱被清——重注册同名设备上线也收不到旧帧
    /// (吊销 = 该设备身份终结,密文帧无主即弃)。
    #[tokio::test]
    async fn revoke_offline_device_clears_mailbox() {
        let h = hub(|_| {});
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 5, tx1, kick1));
        // D2 离线,先积两帧信箱。
        for b in [b"a", b"b"] {
            assert_eq!(h.route_send(ACCT, D1, 5, D2, Lane::Mail, b.to_vec()), Ok(()));
        }
        assert_eq!(h.revoke_device(Some(ACCT), D2), Ok((ACCT.into(), RevokeOutcome::DeviceRevoked)));
        // 老设备背书重注册同 device_id(合法重配对):上线信箱应是空的。
        h.registry.lock().unwrap().register_device(ACCT, D2, [7; 32], 8, now()).unwrap();
        let (tx2, mut rx2, kick2, _k2) = chan(64);
        assert!(attach_dev(&h, D2, [7; 32], 9, tx2, kick2));
        assert_eq!(rx2.try_recv(), Ok(ServerMsg::Authed));
        assert!(
            matches!(rx2.try_recv(), Ok(ServerMsg::Peer { .. })),
            "只该有 D1 在线快照,不许旧帧复活"
        );
        assert!(rx2.try_recv().is_err(), "吊销时信箱该已清空,不许旧帧复活");
    }

    /// codex P4-e 轮 H1(确定性形):verify 后、上线前被吊 → attach 拒绝且不发
    /// Authed;吊后同 device_id 换钥重注册(ABA),旧钥 attach 仍拒。H3:被吊
    /// 设备的在途尾帧路由即拒、不扩散,已清信箱也不会被指名投递重建。
    #[tokio::test]
    async fn attach_and_route_rejected_after_revoke() {
        let h = hub(|_| {});
        // D1 在线(后面验证「发给被吊设备」的路径)。
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1, kick1));
        assert_eq!(h.revoke_device(Some(ACCT), D2), Ok((ACCT.into(), RevokeOutcome::DeviceRevoked)));
        // attach(= Auth verify 通过后的上线动作)被拒,零下行帧。
        let (tx2, mut rx2, kick2, _k2) = chan(8);
        assert!(!attach_dev(&h, D2, [2; 32], 2, tx2, kick2), "被吊设备不得上线");
        assert!(rx2.try_recv().is_err(), "拒绝上线不该发任何帧(含 Authed)");
        // 被吊设备残帧(kick 在途窗口)从源头拒。
        assert_eq!(
            h.route_send(ACCT, D2, 2, D1, Lane::Mail, b"tail".to_vec()),
            Err(err_code::UNKNOWN_DEVICE)
        );
        assert_eq!(
            h.route_send(ACCT, D2, 2, BROADCAST, Lane::Mail, b"tail".to_vec()),
            Err(err_code::UNKNOWN_DEVICE)
        );
        // 指名投给被吊设备也拒(信箱不会凭空重建;H3 的另一半)。
        assert_eq!(
            h.route_send(ACCT, D1, 1, D2, Lane::Mail, b"x".to_vec()),
            Err(err_code::UNKNOWN_DEVICE)
        );
        // ABA(codex 二轮 H):幸存设备把 D2 换新钥重注册——旧钥 attach 仍拒,
        // 新钥 attach 通。
        h.registry.lock().unwrap().register_device(ACCT, D2, [9; 32], 8, now()).unwrap();
        let (tx2b, mut rx2b, kick2b, _k2b) = chan(8);
        assert!(!attach_dev(&h, D2, [2; 32], 3, tx2b, kick2b), "旧钥不得冒充重注册的新设备");
        assert!(rx2b.try_recv().is_err());
        let (tx2c, _rx2c, kick2c, _k2c) = chan(8);
        assert!(attach_dev(&h, D2, [9; 32], 4, tx2c, kick2c));
    }

    /// codex P4-e 轮 H2 + 二轮 H(ABA):背书注册的原子收尾——验签(锁外)到
    /// 插入之间背书者被吊/换钥/掉线,register_endorsed 复核即拒;授权租约还要求
    /// 背书连接就是该设备当前在线连接。
    #[tokio::test]
    async fn register_endorsed_rejects_revoked_rekeyed_or_stale_conn() {
        let h = hub(|_| {});
        const D9: &str = "DEV_9";
        // 背书者不在线(无授权租约)= None。
        assert_eq!(h.register_endorsed(ACCT, D1, [1; 32], 1, D9, [3; 32]), None);
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1, kick1));
        // 公钥对不上(换钥/垃圾)= None。
        assert_eq!(h.register_endorsed(ACCT, D1, [9; 32], 1, D9, [3; 32]), None);
        // conn_id 不是当前在线连接(被顶替的旧连接尾帧)= None。
        assert_eq!(h.register_endorsed(ACCT, D1, [1; 32], 99, D9, [3; 32]), None);
        // 正常路径通(D1 的钥是 [1;32]、conn 1 在线,见 hub())。
        assert_eq!(h.register_endorsed(ACCT, D1, [1; 32], 1, D9, [3; 32]), Some(Ok(())));
        // 吊掉背书者后,同一把「验签时还有效」的钥 + 同 conn 也不再算数
        // (revoke 已把它摘下线,ABA 重注册也救不回旧会话)。
        assert_eq!(h.revoke_device(Some(ACCT), D1), Ok((ACCT.into(), RevokeOutcome::DeviceRevoked)));
        assert_eq!(h.register_endorsed(ACCT, D1, [1; 32], 1, "DEV_A", [4; 32]), None);
        h.registry.lock().unwrap().register_device(ACCT, D1, [8; 32], 8, now()).unwrap();
        assert_eq!(h.register_endorsed(ACCT, D1, [1; 32], 1, "DEV_A", [4; 32]), None);
    }

    /// codex P4-e 三轮 M:被顶替连接的配对槽**当场**烧毁——不等旧连接 detach,
    /// 「摘线到 detach」窗口里旧槽不得再被 relay/join。
    #[tokio::test]
    async fn replaced_connection_slots_burned_immediately() {
        let h = hub(|_| {});
        let (tx, _rx, kick, _k) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx.clone(), kick));
        let slot = h.pair_open(ACCT, D1, 1, tx.clone()).unwrap();
        // 同设备新连接顶替(conn 2):旧 conn 1 的槽立即失效,detach 还没跑。
        let (tx2, _rx2, kick2, _k2) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 2, tx2.clone(), kick2));
        assert_eq!(h.pair_relay(1, slot, b"x".to_vec()), Err(err_code::BAD_SLOT));
        assert_eq!(h.pair_join(9, tx2, test_kick(), QueuedBytes::default(), slot), Err(err_code::BAD_SLOT));
    }

    /// 创号闸聚合日志(codex 二轮 M1):目录满 0→1 必须**立即**出 ERROR 行——
    /// 窗口内只累计的话,唯一那次容量事件可能永远发不出来。
    #[test]
    fn signup_reject_log_flushes_first_directory_full() {
        let (h, _bl) = hub_with_banlist(|_| {});
        // 首次限流:立即落 INFO 行。
        let l1 = h.signup_reject_line(false).expect("首次即落线");
        assert!(l1.starts_with("INFO"), "{l1}");
        // 窗口内再限流:累计不落线。
        assert!(h.signup_reject_line(false).is_none());
        // 窗口内第一次目录满:强制冲刷,ERROR 行、带累计的限流数。
        let l2 = h.signup_reject_line(true).expect("目录满 0→1 必须立即落线");
        assert!(l2.starts_with("ERROR"), "{l2}");
        assert!(l2.contains("限流 1 次") && l2.contains("目录满 1 次"), "{l2}");
        // 窗口内第二次目录满:回到累计(不再是 0→1)。
        assert!(h.signup_reject_line(true).is_none());
    }

    /// 停机关栅与连接 permit 同一线性化点(codex 二轮 L2:此前删掉 close 也测不红):
    /// 关栅前可取;关栅后即使旧 permit 归还,也永远取不到新的。
    #[tokio::test]
    async fn conn_permits_close_with_shutdown() {
        let (h, _bl) = hub_with_banlist(|_| {});
        let held = h.try_admit_conn().expect("关栅前可取");
        assert!(h.shutdown_admissions().await);
        assert!(h.try_admit_conn().is_none(), "关栅后拒新");
        drop(held);
        assert!(h.try_admit_conn().is_none(), "旧 permit 归还也不许再取");
    }

    /// 测试用 kick 专线(pair_join 新参)。接收端直接丢:单元测不驱动 conn 循环,
    /// retire_joiner_ledger 的 try_send 对关闭通道 Err 且被忽略,行为无差。
    fn test_kick() -> KickTx {
        mpsc::channel(1).0
    }

    /// open-signup §1.2:封禁表热重载 = **即时失权**——reload 返回即线性化点:
    /// banned 在线设备 kick 已发、授权租约已摘(尾帧 Send 拒、旧槽烧、新槽拒)、
    /// 重新上线拒;未涉账户一根手指不动;信箱不删(解封后身份仍在、可正常回来)。
    #[tokio::test]
    async fn reload_banlist_immediate_loss_of_authority() {
        let (h, banlist) = hub_with_banlist(|_| {});
        let (tx1, _rx1, kick1, mut kick1_rx) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1.clone(), kick1));
        let slot = h.pair_open(ACCT, D1, 1, tx1.clone()).unwrap();
        // 第二账户在线,验证 reload 不误伤。
        h.registry.lock().unwrap().register_first(ACCT_B, "DEV_B", [5; 32]).unwrap();
        let (txb, _rxb, kickb, mut kickb_rx) = chan(64);
        assert!(h.attach_authenticated(ACCT_B, "DEV_B", [5; 32], 7, txb, kickb, QueuedBytes::default(), false, false, RosterInflight::default()).is_some());

        std::fs::write(&banlist, format!("{ACCT}\n")).unwrap();
        assert_eq!(h.reload_banlist().unwrap(), 1);

        // kick 尚未被客户端消费,失权已完成:
        assert_eq!(kick1_rx.try_recv(), Ok(()), "banned 在线设备该被 kick");
        assert_eq!(
            h.route_send(ACCT, D1, 1, BROADCAST, Lane::Mail, b"tail".to_vec()),
            Err(err_code::UNKNOWN_DEVICE),
            "尾帧失权(授权租约已摘)"
        );
        assert_eq!(h.pair_relay(1, slot, b"x".to_vec()), Err(err_code::BAD_SLOT), "旧槽已烧");
        assert_eq!(h.pair_open(ACCT, D1, 1, tx1.clone()), Err(err_code::AUTH_FAILED), "开新槽拒");
        let (tx1b, mut rx1b, kick1b, _k1b) = chan(8);
        assert!(!attach_dev(&h, D1, [1; 32], 3, tx1b, kick1b), "封禁账户不得再上线");
        assert!(rx1b.try_recv().is_err(), "拒绝上线零下行帧");
        // 未涉账户不受影响。
        assert!(kickb_rx.try_recv().is_err(), "未封禁账户不许被误 kick");
        assert_eq!(h.route_send(ACCT_B, "DEV_B", 7, BROADCAST, Lane::Mail, b"ok".to_vec()), Ok(()));
        // 解封 = 身份仍在(封禁≠吊销),直接回来。
        std::fs::write(&banlist, "# 解封\n").unwrap();
        assert_eq!(h.reload_banlist().unwrap(), 0);
        let (tx1c, mut rx1c, kick1c, _k1c) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 4, tx1c, kick1c));
        assert_eq!(rx1c.try_recv(), Ok(ServerMsg::Authed));
        // 坏文件 reload = 保留旧集合、在线态一根手指不动(fail-safe)。
        std::fs::write(&banlist, "not-a-ulid\n").unwrap();
        assert!(h.reload_banlist().is_err());
        assert_eq!(h.route_send(ACCT, D1, 4, BROADCAST, Lane::Mail, b"still".to_vec()), Ok(()));
    }

    /// open-signup §1.5:device-only 吊销(同一把 registry 锁内反查属主)、
    /// account 不符零副作用、未知 device = NotFound、成功回执带解析出的账户。
    #[tokio::test]
    async fn revoke_by_device_reverse_lookup_and_mismatch() {
        let h = hub(|_| {});
        // account 不给:反查属主吊掉。
        assert_eq!(h.revoke_device(None, D2), Ok((ACCT.into(), RevokeOutcome::DeviceRevoked)));
        // 已吊/未知 device = NotFound。
        assert_eq!(h.revoke_device(None, D2), Err(RevokeError::NotFound));
        assert_eq!(h.revoke_device(None, "DEV_X"), Err(RevokeError::NotFound));
        // account 与真实属主不符 = OwnerMismatch,零副作用(D1 绑定仍在)。
        assert_eq!(h.revoke_device(Some(ACCT_B), D1), Err(RevokeError::OwnerMismatch));
        assert_eq!(h.registry.lock().unwrap().pubkey_of(ACCT, D1), Some([1; 32]));
        // 给对 account 照吊(最后一台 → 归零封存)。
        assert_eq!(h.revoke_device(Some(ACCT), D1), Ok((ACCT.into(), RevokeOutcome::AccountSealed)));
    }

    // ---- epoch-plan §5.2:统一字节预算 ----

    /// 驱逐次序(§5.2 #2)与 admission 原子性(#3):
    /// ① 账户超份额先驱逐该账户 mailbox 最老帧;② 仍超摘占用最大的在线连接
    /// (发送者除外);③ 无可驱逐 = 整帧拒,**零部分投递**;全局线独立硬顶。
    #[tokio::test]
    async fn budget_eviction_order_and_atomic_admission() {
        let h = hub(|c| c.budget_account_bytes = 100);
        h.registry.lock().unwrap().register_device(ACCT, "DEV_3", [3; 32], 8, now()).unwrap();
        let (tx1, _rx1, kick1, _k1) = chan(64);
        let q1 = attach_with_ledger(&h, D1, [1; 32], 1, tx1, kick1);

        // ① mailbox 最老先走:两帧 60B 给离线 D2,第二帧触发驱逐第一帧。
        assert_eq!(h.route_send(ACCT, D1, 1, D2, Lane::Mail, vec![b'a'; 60]), Ok(()));
        assert_eq!(h.route_send(ACCT, D1, 1, D2, Lane::Mail, vec![b'b'; 60]), Ok(()));
        let (tx2, mut rx2, kick2, _k2) = chan(64);
        assert!(attach_dev(&h, D2, [2; 32], 2, tx2, kick2));
        assert_eq!(rx2.try_recv(), Ok(ServerMsg::Authed));
        assert_eq!(rx2.try_recv(), Ok(deliver(D1, D2, &[b'b'; 60])), "最老帧 a 该被驱逐");
        assert!(matches!(rx2.try_recv(), Ok(ServerMsg::Peer { .. })));
        assert!(rx2.try_recv().is_err());

        // ②「搬运不释放预算」+ 摘最大连接:D2 在线、队里躺着 60B(上一步已投、
        // 写任务不存在故永不出队)→ 预算视角它仍占 60;再发 60B 给 DEV_3(离线)
        // 超份额、无 mailbox 可驱逐 → D2(非发送者、占用最大)被摘。**摘线 ≠ 腾出**
        // (二弹 M):其 60B 转入 draining 继续顶预算,本帧仍拒;writer 真排空
        // (账本归零)后额度才回来,重发照走。
        let q2 = st_queued(&h, D2).expect("D2 在线必有账本");
        assert_eq!(q2.load(Ordering::Relaxed), 60, "投递已入 D2 队列账本");
        assert_eq!(
            h.route_send(ACCT, D1, 1, "DEV_3", Lane::Mail, vec![b'c'; 60]),
            Err(err_code::BUSY),
            "D2 被摘但内存未释放,本帧仍拒"
        );
        assert!(st_queued(&h, D2).is_none(), "D2 该被摘下线");
        q2.store(0, Ordering::Relaxed); // 模拟 writer 排空
        assert_eq!(h.route_send(ACCT, D1, 1, "DEV_3", Lane::Mail, vec![b'c'; 60]), Ok(()));

        // ③ 发送者自己是唯一大户(不可摘)、无 mailbox → 整帧拒,且**一个目标都
        //    不投**(原子性:广播两目标,失败后两家信箱都必须空)。
        q1.fetch_add(90, Ordering::Relaxed); // 模拟 D1 自己下行积压 90B
        // 清掉上一步留下的 DEV_3 信箱(60B),让「拒」只由发送者积压决定。
        let (tx3, mut _rx3, kick3, _k3) = chan(64);
        assert!(attach_dev(&h, "DEV_3", [3; 32], 3, tx3, kick3));
        assert_eq!(
            h.route_send(ACCT, D1, 1, BROADCAST, Lane::Mail, vec![b'd'; 30]),
            Err(err_code::BUSY),
            "90 + 2×30 > 100 且无可驱逐(发送者除外)= 整帧拒"
        );
        // 原子性:D2(离线)信箱与 DEV_3(在线)队列都不得有 d 帧。
        let (tx2b, mut rx2b, kick2b, _k2b) = chan(64);
        assert!(attach_dev(&h, D2, [2; 32], 4, tx2b, kick2b));
        assert_eq!(rx2b.try_recv(), Ok(ServerMsg::Authed));
        while let Ok(m) = rx2b.try_recv() {
            assert!(!matches!(m, ServerMsg::Deliver { .. }), "拒帧不得部分投递:{m:?}");
        }
    }

    /// 全局预算是独立硬顶(§5.2 #2:账户份额之内也逃不过全局线;宁拒不 OOM)。
    #[tokio::test]
    async fn budget_global_hard_cap() {
        let h = hub(|c| {
            c.budget_account_bytes = 1000;
            c.budget_global_bytes = 100;
        });
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1, kick1));
        assert_eq!(h.route_send(ACCT, D1, 1, D2, Lane::Mail, vec![b'a'; 60]), Ok(()));
        assert_eq!(
            h.route_send(ACCT, D1, 1, D2, Lane::Mail, vec![b'b'; 60]),
            Err(err_code::BUSY),
            "账户份额内(120<1000)但过全局线(120>100)= 拒"
        );
    }

    /// 单连接下行字节闸(§5.2 #4):超闸视同慢客户端摘线,帧走离线逻辑入箱、
    /// 重连接力,不丢。
    #[tokio::test]
    async fn conn_byte_gate_kicks_and_remails() {
        let h = hub(|c| c.conn_max_bytes = 100);
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1, kick1));
        let (tx2, mut rx2, kick2, mut kick2_rx) = chan(64);
        let q2 = attach_with_ledger(&h, D2, [2; 32], 2, tx2, kick2);
        assert_eq!(h.route_send(ACCT, D1, 1, D2, Lane::Mail, vec![b'a'; 60]), Ok(()));
        assert_eq!(q2.load(Ordering::Relaxed), 60);
        // 第二帧 60B:60+60 > 100 超闸 → 摘线 + 入箱。
        assert_eq!(h.route_send(ACCT, D1, 1, D2, Lane::Mail, vec![b'b'; 60]), Ok(()));
        assert_eq!(kick2_rx.try_recv(), Ok(()), "超字节闸该被 kick");
        assert_eq!(rx2.try_recv(), Ok(ServerMsg::Authed));
        assert!(matches!(rx2.try_recv(), Ok(ServerMsg::Peer { .. })), "D1 在线快照");
        assert_eq!(rx2.try_recv(), Ok(deliver(D1, D2, &[b'a'; 60])));
        let (tx2b, mut rx2b, kick2b, _k2b) = chan(64);
        assert!(attach_dev(&h, D2, [2; 32], 3, tx2b, kick2b));
        assert_eq!(rx2b.try_recv(), Ok(ServerMsg::Authed));
        assert_eq!(rx2b.try_recv(), Ok(deliver(D1, D2, &[b'b'; 60])), "触闸帧入箱接力");
    }

    /// 配对桥每槽配额(§5.2 #5):帧数/字节任一超即烧槽、两侧收 Closed;
    /// push 失败(对端队满)同样烧槽回错(修「relay 忽略 push 返回值」)。
    #[tokio::test]
    async fn pair_slot_quota_and_dead_bridge_burn() {
        // 帧数配额:第 3 帧烧槽。
        let h = hub(|c| c.pair_slot_max_frames = 2);
        let (tx1, mut rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1.clone(), kick1));
        let slot = h.pair_open(ACCT, D1, 1, tx1).unwrap();
        let (jtx, mut jrx, _jk, _jkr) = chan(64);
        h.pair_join(9, jtx, test_kick(), QueuedBytes::default(), slot).unwrap();
        assert_eq!(h.pair_relay(1, slot, b"m1".to_vec()), Ok(()));
        assert_eq!(h.pair_relay(9, slot, b"m2".to_vec()), Ok(()));
        assert_eq!(h.pair_relay(1, slot, b"m3".to_vec()), Err(err_code::BAD_SLOT), "超帧数配额");
        // 两侧都收到 Closed;槽已死。
        let mut owner_closed = false;
        while let Ok(m) = rx1.try_recv() {
            if matches!(m, ServerMsg::PairPeer { event: PairEvent::Closed }) {
                owner_closed = true;
            }
        }
        assert!(owner_closed, "发起端该收 Closed");
        let mut joiner_closed = false;
        while let Ok(m) = jrx.try_recv() {
            if matches!(m, ServerMsg::PairPeer { event: PairEvent::Closed }) {
                joiner_closed = true;
            }
        }
        assert!(joiner_closed, "入槽端该收 Closed");
        assert_eq!(h.pair_relay(9, slot, b"m4".to_vec()), Err(err_code::BAD_SLOT));

        // 字节配额:单帧超线即烧。
        let h = hub(|c| c.pair_slot_max_bytes = 10);
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1.clone(), kick1));
        let slot = h.pair_open(ACCT, D1, 1, tx1).unwrap();
        let (jtx, _jrx, _jk, _jkr) = chan(64);
        h.pair_join(9, jtx, test_kick(), QueuedBytes::default(), slot).unwrap();
        assert_eq!(h.pair_relay(1, slot, vec![0u8; 11]), Err(err_code::BAD_SLOT), "超字节配额");

        // 桥断(对端队满,push 失败):烧槽回错,不再装作还在配对。
        let h = hub(|_| {});
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1.clone(), kick1));
        let slot = h.pair_open(ACCT, D1, 1, tx1).unwrap();
        let (jtx, _jrx_kept, _jk, _jkr) = chan(1); // 容量 1:第一帧填满、第二帧必失败
        h.pair_join(9, jtx, test_kick(), QueuedBytes::default(), slot).unwrap();
        assert_eq!(h.pair_relay(1, slot, b"fill".to_vec()), Ok(()));
        assert_eq!(h.pair_relay(1, slot, b"boom".to_vec()), Err(err_code::BAD_SLOT), "桥断即烧");
        assert_eq!(h.pair_relay(1, slot, b"gone".to_vec()), Err(err_code::BAD_SLOT));
    }

    /// 二弹三轮 H:已用过期槽被 pair_join 内联删除时,joiner 在途账本必须 retire
    /// 进 draining——否则「积压 PairMsg → 等槽过期 → 再 PairJoin 触发删槽」让旧队列
    /// 内存从派生消失,反复突破硬顶。
    #[tokio::test]
    async fn expired_slot_join_retires_joiner_ledger() {
        let h = hub(|c| {
            c.budget_global_bytes = 100;
            c.pair_slot_ttl = std::time::Duration::from_millis(50);
        });
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1.clone(), kick1));
        let slot = h.pair_open(ACCT, D1, 1, tx1.clone()).unwrap();
        let (jtx, _jrx_kept, _jk, _jkr) = chan(64);
        let jq = QueuedBytes::default();
        h.pair_join(9, jtx, test_kick(), jq.clone(), slot).unwrap();
        assert_eq!(h.pair_relay(1, slot, vec![0u8; 60]), Ok(()));
        assert_eq!(jq.load(Ordering::Relaxed), 60, "PairMsg 已入 joiner 账本");
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        // 过期后再 join:槽被内联删除——joiner 的 60B 必须转入 draining。
        let (jtx2, _jrx2, _jk2, _jkr2) = chan(64);
        assert_eq!(h.pair_join(10, jtx2, test_kick(), QueuedBytes::default(), slot), Err(err_code::BAD_SLOT));
        // 新开槽再转发 60B:60(draining)+60 > 100 全局线 → 必须被顶住。
        let slot2 = h.pair_open(ACCT, D1, 1, tx1).unwrap();
        let (jtx3, _jrx3, _jk3, _jkr3) = chan(64);
        h.pair_join(11, jtx3, test_kick(), QueuedBytes::default(), slot2).unwrap();
        assert_eq!(
            h.pair_relay(1, slot2, vec![0u8; 60]),
            Err(err_code::BAD_SLOT),
            "过期槽的在途字节仍须顶住全局预算"
        );
    }

    /// 按设备名取当前在线连接的字节账本(测试探针)。
    fn st_queued(h: &Hub, dev: &str) -> Option<QueuedBytes> {
        let st = h.state.lock().unwrap();
        st.online.get(&(ACCT.to_owned(), dev.to_owned())).map(|c| c.queued.clone())
    }

    /// 二弹 H:配对桥同样过统一全局预算——单槽配额没超、全局线到顶照样烧槽
    /// (4096 槽 × 4MiB ≠ 256MiB 硬顶)。
    #[tokio::test]
    async fn pair_relay_respects_global_budget() {
        let h = hub(|c| c.budget_global_bytes = 100);
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1.clone(), kick1));
        let slot = h.pair_open(ACCT, D1, 1, tx1).unwrap();
        let (jtx, _jrx, _jk, _jkr) = chan(64);
        h.pair_join(9, jtx, test_kick(), QueuedBytes::default(), slot).unwrap();
        assert_eq!(h.pair_relay(1, slot, vec![0u8; 60]), Ok(()), "线内放行");
        assert_eq!(
            h.pair_relay(9, slot, vec![0u8; 60]),
            Err(err_code::BAD_SLOT),
            "60+60 > 100 全局线:烧槽拒"
        );
        assert_eq!(h.pair_relay(1, slot, b"gone".to_vec()), Err(err_code::BAD_SLOT), "槽已死");
    }

    /// 二弹 M:摘线 ≠ 内存已释放——被 kick 连接的队列字节转入 draining 账本,
    /// 继续顶住预算(修前:摘线即从派生消失,驱逐循环把仍占内存的队列当已释放
    /// 再收新帧);排空(账本归零)后才腾出额度。
    #[tokio::test]
    async fn evicted_queue_still_counts_until_drained() {
        let h = hub(|c| c.budget_account_bytes = 100);
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1, kick1));
        let (tx2, _rx2_kept, kick2, mut kick2_rx) = chan(64);
        let q2 = attach_with_ledger(&h, D2, [2; 32], 2, tx2, kick2);
        assert_eq!(h.route_send(ACCT, D1, 1, D2, Lane::Mail, vec![b'a'; 90]), Ok(()));
        assert_eq!(q2.load(Ordering::Relaxed), 90);
        // 第二帧 20B:90+20 超份额 → admit 摘 D2 腾预算,但其 90B 仍在 writer 队里
        // (本测不消费 rx2)→ 转入 draining 继续计入 → 仍不够 → 整帧拒。
        assert_eq!(
            h.route_send(ACCT, D1, 1, D2, Lane::Mail, vec![b'b'; 20]),
            Err(err_code::BUSY),
            "被摘连接的队列内存未释放,不得当已腾出"
        );
        assert_eq!(kick2_rx.try_recv(), Ok(()), "D2 被摘线");
        // 模拟 writer 排空(账本归零)→ 额度回来,新帧照走(离线入箱)。
        q2.store(0, Ordering::Relaxed);
        assert_eq!(h.route_send(ACCT, D1, 1, D2, Lane::Mail, vec![b'c'; 20]), Ok(()));
    }

    /// codex P2-e M2:全局槽数上限,超限 busy;开槽要求授权租约(在线 conn)。
    #[tokio::test]
    async fn pair_slot_cap() {
        let h = hub(|c| c.pair_slot_cap = 2);
        // 第三台设备入 registry(cap 测试要三条在线连接)。
        h.registry.lock().unwrap().register_device(ACCT, "DEV_3", [3; 32], 8, now()).unwrap();
        let (tx, _rx, _kick, _k) = chan(64);
        let (k1, k2, k3) = (chan(1).2, chan(1).2, chan(1).2);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx.clone(), k1));
        assert!(attach_dev(&h, D2, [2; 32], 2, tx.clone(), k2));
        assert!(attach_dev(&h, "DEV_3", [3; 32], 3, tx.clone(), k3));
        assert!(h.pair_open(ACCT, D1, 1, tx.clone()).is_ok());
        assert!(h.pair_open(ACCT, D2, 2, tx.clone()).is_ok());
        assert_eq!(h.pair_open(ACCT, "DEV_3", 3, tx.clone()), Err(err_code::BUSY));
        // 同连接重开不占新额度(烧旧开新)。
        assert!(h.pair_open(ACCT, D2, 2, tx.clone()).is_ok());
        // 授权租约:不在线的 conn(被顶替/被吊)开不了槽。
        assert_eq!(h.pair_open(ACCT, D1, 42, tx), Err(err_code::AUTH_FAILED));
    }

    /// 席位前置拒(billing-plan §5 M5,工序 2):满席 PairOpen 拒 seat_limit;
    /// admin 提额即时解封;硬帽处报 account_full(双错误码);授权(在线租约)
    /// 判定先于政策(不在线仍是 AUTH_FAILED,不泄席位态)。
    #[tokio::test]
    async fn pair_open_seat_gate() {
        let h = hub(|_| {});
        // 夹具把 ACCT 提到 8 席——压回免费档 2 席(2 台在编 = 满席)。
        let free = crate::registry::Entitlement::free_default();
        h.registry.lock().unwrap().set_entitlement(ACCT, free, time::OffsetDateTime::now_utc()).unwrap();
        let (tx, _rx, _kick, _k) = chan(64);
        let (k1, k2) = (chan(1).2, chan(1).2);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx.clone(), k1));
        assert!(attach_dev(&h, D2, [2; 32], 2, tx.clone(), k2));
        // 满席:前置拒,错误码是商业层 seat_limit。
        assert_eq!(h.pair_open(ACCT, D1, 1, tx.clone()), Err(err_code::SEAT_LIMIT));
        // 不在线的 conn:仍是授权错先行(政策不越权应答)。
        assert_eq!(h.pair_open(ACCT, D1, 42, tx.clone()), Err(err_code::AUTH_FAILED));
        // admin 提额 → 即时生效,开槽放行。
        let wide = crate::registry::Entitlement {
            seat_quota: 4,
            ..crate::registry::Entitlement::free_default()
        };
        h.registry.lock().unwrap().set_entitlement(ACCT, wide, time::OffsetDateTime::now_utc()).unwrap();
        assert!(h.pair_open(ACCT, D1, 1, tx.clone()).is_ok());
    }

    /// 硬帽层前置拒:quota 再宽,`seat_count ≥ device_cap` 的 PairOpen 报
    /// account_full——提额解不了的事,错误码不许误导。
    #[tokio::test]
    async fn pair_open_hard_cap_reports_account_full() {
        let h = hub(|c| c.device_cap = 2);
        let (tx, _rx, _kick, _k) = chan(64);
        let k1 = chan(1).2;
        assert!(attach_dev(&h, D1, [1; 32], 1, tx.clone(), k1));
        // 夹具 quota=8、硬帽 2、在编 2:容量层先拒。
        assert_eq!(h.pair_open(ACCT, D1, 1, tx), Err(err_code::ACCOUNT_FULL));
    }

    /// 计量准入栅栏(169,codex 实现审 M):干净 drain(active 归零)→ shutdown 返 true、
    /// is_shutting_down 置真、其后 enter 一律拒。
    #[tokio::test]
    async fn admission_guard_drains_clean() {
        let h = hub(|_| {});
        assert!(!h.is_shutting_down());
        assert!(h.admission_enter()); // active=1
        h.admission_leave(); // active=0
        assert!(h.shutdown_admissions().await, "active 已归零应干净 drain=true");
        assert!(h.is_shutting_down());
        assert!(!h.admission_enter(), "关栅后新帧一律拒");
    }

    /// permit 未退时 shutdown 超时返 false(不称最终快照);退出码真值表由 lib 单元测覆盖。
    #[tokio::test]
    async fn admission_guard_drain_times_out_with_held_permit() {
        let h = hub(|c| c.shutdown_drain_timeout = std::time::Duration::from_millis(50));
        assert!(h.admission_enter()); // active=1,故意不 leave(模拟卡在 registry 锁)
        assert!(!h.shutdown_admissions().await, "active>0 超时应返 false");
    }

    /// 并发 drain 唤醒(钉 `notified.enable()` 无丢唤醒):shutdown 注册 waiter 时 active=1,
    /// 另一任务 50ms 后 leave→归零通知,shutdown 应经通知**立即返回 true**(远早于 5s
    /// 默认超时);若丢唤醒会拖到超时才返回。
    #[tokio::test]
    async fn admission_guard_concurrent_drain_wakes_before_timeout() {
        let h = std::sync::Arc::new(hub(|_| {})); // 默认 5s 超时
        assert!(h.admission_enter()); // active=1
        let h2 = h.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            h2.admission_leave(); // active→0 + notify
        });
        let started = tokio::time::Instant::now();
        assert!(h.shutdown_admissions().await, "leave 归零应干净 drain=true");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "应经 notify 唤醒立即返回(实测 {:?}),而非等 5s 超时——丢唤醒才会拖到超时",
            started.elapsed()
        );
    }
}
