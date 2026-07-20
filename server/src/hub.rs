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

use sync_proto::{err_code, Lane, PairEvent, ServerMsg, BROADCAST};
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
const REALTIME_HEADROOM: usize = 1024;

/// (account, device)。
type Addr = (String, String);

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
    joiner: Option<(u64, Tx, QueuedBytes)>,
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
        }
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
    ) -> Option<u64> {
        let reg = self.registry.lock().unwrap();
        if reg.is_banned(account) {
            return None;
        }
        if reg.pubkey_of(account, device) != Some(expected_pubkey) {
            return None;
        }
        let addr: Addr = (account.to_owned(), device.to_owned());
        let mut st = self.state.lock().unwrap();
        push(&tx, ServerMsg::Authed);
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
        st.online.insert(addr, Client { conn_id, tx, kick, queued });
        drop(st);
        // 会话代际(169,codex H):state 已释放、仍持 registry(锁序 registry→meters)。
        // 给本 device 发新单调 session_gen、取消旧代际残留 pending;返回供连接态存储。
        let wall_month = crate::registry::month_of(time::OffsetDateTime::now_utc());
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
    ) -> AdmitDecision {
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
        let (decision, dirty) = {
            let mut meters = self.meters.lock().unwrap();
            let decision = meters.admission(
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
            (decision, meters.dirty_bytes())
        };
        // 阈值事件唤醒(codex M:事件驱动非轮询;notify_one 合并、丢一次不退化因 dirty
        // 有状态、worker 每轮读实况)。
        if dirty >= self.cfg.checkpoint_dirty_bytes {
            self.checkpoint_nudge.notify_one();
        }
        decision
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
                    .filter_map(|sl| sl.joiner.as_ref().map(|(_, _, q)| q.load(Ordering::Relaxed)))
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
                .filter_map(|sl| sl.joiner.as_ref().map(|(_, _, q)| q.load(Ordering::Relaxed)))
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
                if let Some((_, joiner_tx, _)) = &s.joiner {
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
    pub fn pair_join(&self, conn_id: u64, tx: Tx, queued: QueuedBytes, slot: u64) -> Result<(), &'static str> {
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
        s.joiner = Some((conn_id, tx, queued));
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
        } else if s.joiner.as_ref().is_some_and(|(c, _, _)| *c == conn_id) {
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
                .filter_map(|sl| sl.joiner.as_ref().map(|(_, _, q)| q.load(Ordering::Relaxed)))
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
                .filter_map(|sl| sl.joiner.as_ref().map(|(_, _, q)| q.load(Ordering::Relaxed)))
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
                let (_, t, q) = sl.joiner.as_ref().expect("已证有 joiner");
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
            s.owner_conn == conn_id || s.joiner.as_ref().is_some_and(|(c, _, _)| *c == conn_id)
        });
        if !member {
            return Err(err_code::BAD_SLOT);
        }
        let s = st.slots.remove(&slot).expect("上一行已证存在");
        retire_joiner_ledger(&mut st.draining, &s);
        let other = if s.owner_conn == conn_id { s.joiner.as_ref().map(|(_, t, _)| t.clone()) } else { Some(s.owner_tx.clone()) };
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
        let outcome = reg.revoke_device(&account, device)?;
        let addr: Addr = (account.clone(), device.to_owned());
        let mut st = self.state.lock().unwrap();
        st.mailboxes.remove(&addr);
        if let Some(dead) = st.online.remove(&addr) {
            let conn = dead.conn_id;
            kick_and_burn(&mut st, &account, dead);
            broadcast_offline(&st, &account, device);
            logln(format!(
                "INFO 吊销 account={account} device={device}(在线,已 kick conn={conn})"
            ));
        } else {
            logln(format!("INFO 吊销 account={account} device={device}(离线)"));
        }
        Ok((account, outcome))
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
        Some(reg.register_device(
            account,
            new_device,
            pubkey,
            self.cfg.device_cap,
            time::OffsetDateTime::now_utc(),
        ))
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
                if let Some((_, joiner_tx, _)) = &s.joiner {
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
        let is_joiner = s.joiner.as_ref().is_some_and(|(c, _, _)| *c == conn_id);
        if !is_owner && !is_joiner {
            return true;
        }
        let other = if is_owner { s.joiner.as_ref().map(|(_, t, _)| t) } else { Some(&s.owner_tx) };
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
        if let Some((_, joiner_tx, _)) = &s.joiner {
            push(joiner_tx, ServerMsg::PairPeer { event: PairEvent::Closed });
        }
        retire_joiner_ledger(&mut st.draining, &s);
    }
}

/// 槽消亡时把 joiner 的在途账本转入 draining(joiner 未鉴权、不在 online——槽是
/// 它的唯一账本挂点;不转则烧槽即从派生消失,内存却还在其 mpsc 里)。owner 侧
/// 账本挂在 online/draining,槽消亡不影响。
fn retire_joiner_ledger(draining: &mut Vec<(String, QueuedBytes)>, s: &PairSlot) {
    if let Some((_, _, q)) = &s.joiner {
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
        let dir: PathBuf = std::env::temp_dir().join(format!(
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

    fn deliver(from: &str, to: &str, blob: &[u8]) -> ServerMsg {
        ServerMsg::Deliver { from: from.into(), to: to.into(), blob: blob.to_vec() }
    }

    /// D1 以 conn_id=cid 上线(fixture 公钥 [1;32]/[2;32],见 hub())。账本按连接
    /// 新造——只想上线不查预算的测试用它;预算测试用 [`attach_with_ledger`]。
    fn attach_dev(h: &Hub, dev: &str, key: [u8; 32], cid: u64, tx: Tx, kick: KickTx) -> bool {
        h.attach_authenticated(ACCT, dev, key, cid, tx, kick, QueuedBytes::default()).is_some()
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
        assert!(h.attach_authenticated(ACCT, dev, key, cid, tx, kick, q.clone()).is_some());
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
        assert_eq!(h.pair_join(9, tx2, QueuedBytes::default(), slot), Err(err_code::BAD_SLOT));
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
        assert!(h.attach_authenticated(ACCT_B, "DEV_B", [5; 32], 7, txb, kickb, QueuedBytes::default()).is_some());

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
        h.pair_join(9, jtx, QueuedBytes::default(), slot).unwrap();
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
        h.pair_join(9, jtx, QueuedBytes::default(), slot).unwrap();
        assert_eq!(h.pair_relay(1, slot, vec![0u8; 11]), Err(err_code::BAD_SLOT), "超字节配额");

        // 桥断(对端队满,push 失败):烧槽回错,不再装作还在配对。
        let h = hub(|_| {});
        let (tx1, _rx1, kick1, _k1) = chan(64);
        assert!(attach_dev(&h, D1, [1; 32], 1, tx1.clone(), kick1));
        let slot = h.pair_open(ACCT, D1, 1, tx1).unwrap();
        let (jtx, _jrx_kept, _jk, _jkr) = chan(1); // 容量 1:第一帧填满、第二帧必失败
        h.pair_join(9, jtx, QueuedBytes::default(), slot).unwrap();
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
        h.pair_join(9, jtx, jq.clone(), slot).unwrap();
        assert_eq!(h.pair_relay(1, slot, vec![0u8; 60]), Ok(()));
        assert_eq!(jq.load(Ordering::Relaxed), 60, "PairMsg 已入 joiner 账本");
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        // 过期后再 join:槽被内联删除——joiner 的 60B 必须转入 draining。
        let (jtx2, _jrx2, _jk2, _jkr2) = chan(64);
        assert_eq!(h.pair_join(10, jtx2, QueuedBytes::default(), slot), Err(err_code::BAD_SLOT));
        // 新开槽再转发 60B:60(draining)+60 > 100 全局线 → 必须被顶住。
        let slot2 = h.pair_open(ACCT, D1, 1, tx1).unwrap();
        let (jtx3, _jrx3, _jk3, _jkr3) = chan(64);
        h.pair_join(11, jtx3, QueuedBytes::default(), slot2).unwrap();
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
        h.pair_join(9, jtx, QueuedBytes::default(), slot).unwrap();
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
