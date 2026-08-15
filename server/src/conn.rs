//! 每 WS 连接的状态机(sync-protocol §4):连接即发 challenge → 挑战应答鉴权 /
//! 首台 TOFU / 配对入槽 → 已鉴权面(send 路由 / 开槽 / 背书注册)。
//!
//! * **下行单点**:全部下行走本连接的 mpsc(写任务独占 sink),FIFO 天然保序;
//!   信箱搬运也进同一条队(hub::attach)。**下行绝不 `.await` 等队**(codex P2-e
//!   轮 H1:不读 socket 的对端能把队填满,把连接任务卡死在回 Pong 上)——回复
//!   一律 `try_send`,收帧先查队满(满 = 对端不读 = 断开)。
//! * **关断走专线**:被顶替 / 慢客户端摘除由 hub 发 kick(cap=1 独立通道),
//!   读循环 select 即断——控制信号不排在可能满的数据队列后面(H2)。
//! * **静默判死**(§3):读循环包 `timeout(silence_timeout)`,任何帧(含 WS 层
//!   ping/pong)都算活动;超时断开。
//! * **err 分级**:鉴权失败/越权/解码错 = err 后断开(fail-fast,爆破变重连
//!   成本);业务信号(Nack、注册竞态败、authed 的错槽/坏注册参数)= 回错不断开。
//! * 验签用 `verify_strict`(拒 malleable/小阶点签名——新协议无历史包袱,取严的)。

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use ed25519_dalek::{Signature, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use sync_proto::{
    auth_sig_payload, device_admin_sig_payload, err_code, is_ulid, register_device_sig_payload,
    register_first_sig_payload, seat_lease_sig_payload, ClientMsg, DeviceAction, ServerMsg,
    BROADCAST, CHALLENGE_LEN, ED25519_PUB_LEN, ED25519_SIG_LEN,
};
use tokio::time::timeout;

use crate::hub::{DeviceAdminError, Hub, Tx};
use crate::logln;
use crate::registry::{RegisterError, SeatLeaseError};
use crate::throttle::{AdmitDecision, PollOutcome, WaitHandle, DISP_ADMITTED, DISP_CANCELLED, DISP_RELEASED};
use std::sync::atomic::Ordering;

/// 连接状态。Fresh 只许 Auth/RegisterFirst/PairJoin/Ping;PairJoined(未鉴权入槽,
/// 限一槽)只许本槽 PairMsg/PairClose/Ping;Authed 是全部业务面。
/// Authed 存本会话验签用的公钥(H-ABA 授权上下文 {account, device, pubkey,
/// conn_id}:吊销后同 device_id 被合法重注册换钥,旧会话不得再以新身份行事)。
enum ConnState {
    Fresh,
    PairJoined { slot: u64 },
    /// `session_gen`(169,工序 3):attach 线性化点发的会话代际,限速准入按它核验
    /// 同 device 重连 ABA——旧连接后到、gen 不匹配即 kicked,不淘汰新会话 ticket。
    Authed {
        account: String,
        device: String,
        pubkey: [u8; 32],
        session_gen: u64,
        /// 本连接声明了 `device_roster_v1` 吗(367)。名册三条只发给声明者,故两条
        /// 新命令也只对声明者开——没声明就收不到回执,放行等于让它干等。
        wants_roster: bool,
    },
}

/// 连接级限频状态(367,identity-plan §5.13)。
///
/// **住在连接任务的栈上**:连接死即随之消失,是**结构事实**而不是要记得做的回收
/// (first-draft-checklist 第 7 条)。账户级那一份住 registry(§5.13:必须落在既有
/// 锁序 registry → state 之内)。
struct ConnLimits {
    /// `DeviceAdmin`:burst 5 / 每 10s 补 1。
    admin: crate::registry::TokenBucket,
    /// `RosterReq`:两次**应答**之间的最短间隔(§5.13:`ROSTER_REQ_MIN_GAP`)。
    /// 只在真答了才推进——超频那次不推进,否则刷得越快越答不上。
    last_roster_reply: Option<std::time::Instant>,
}

/// `DeviceAdmin` 的连接级桶深(账户级那一份在 registry)。
const DEVICE_ADMIN_BURST_CONN: u32 = 5;
/// `RosterReq` 两次应答的最短间隔(§5.13)。**值住 `sync-proto`**——客户端那台调度机
/// 的常量约束(`PULL_DEADLINE >= REFRESH_DEADLINE + 本值`)要读同一份,抄两遍必漂。
const ROSTER_REQ_MIN_GAP: Duration = Duration::from_secs(sync_proto::ROSTER_REQ_MIN_GAP_SECS);

/// 一条消息的处置结果(状态转移经返回值,绕开对 state 的借用纠纷)。
enum Step {
    Continue,
    /// **吊销式收场**:与被 kick 同待遇 —— 队里余帧**一帧都不许出门**(P4-e 二审 H4
    /// 那条红线:「吊销后继续冲密文给被吊设备不可接受」)。
    ///
    /// ⛔ **收场原因必须显式编码,不许靠「kick 反正在途」**(实现审弹二 H1):
    /// `Step::Close` 只是 `break`,`kicked` 保持 false ⇒ 走的是**排空**那条路。
    /// 而 H-ABA 失败的意思正是「你已经被别人吊了、kick 已经发出来了」——
    /// 那条 kick 因为我们当场 break 而**永远没人取**,于是被吊设备照样排空最多 10 秒的
    /// 旧队列。这四处(`PairOpen` / `RegisterDevice` / `SeatLease` / `DeviceAdmin` 的
    /// 「本设备已被吊销」)从此走本变体。
    ///
    /// ⚠ 与 [`Step::Close`] 的分界:**自助退出走 `Close`**(自助退出 ≠ 被吊销,
    /// 且撤离 `online` 之后 hub 手里已无本连接的 tx,排出去的严格是它吊销前就有权收的
    /// 那些 + 自己那枚回执)。
    Abort,
    /// 致命:已回 err(或无需回),断开。
    Close,
    /// 状态转移(Fresh → Authed / PairJoined)。
    Become(ConnState),
}

/// PairJoined 态的未鉴权截止余量(槽 TTL 之外再宽一点:sweep 周期与收尾帧的量级
/// 余地;一处一数)。
const PAIR_JOINED_GRACE: Duration = Duration::from_secs(30);

pub(crate) async fn handle(
    hub: Arc<Hub>,
    ws: WebSocket,
    conn_permit: tokio::sync::OwnedSemaphorePermit,
) {
    // 全局连接闸的 permit(2026-07-31 评审):绑读任务(连接准入的主体)生命期,
    // 一切出口含 panic 展开 Drop 即还。写任务是独立 spawn、可能短暂多活一拍
    // (排空/关帧),但它不收新帧、随通道关闭收尾,不占准入名额。
    let _conn_permit = conn_permit;
    let conn_id = hub.next_conn_id();
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ServerMsg>(hub.channel_cap());
    let (kick_tx, mut kick_rx) = tokio::sync::mpsc::channel::<()>(1);
    // 本连接下行队的 Deliver 字节账本(epoch-plan §5.2):hub 入队加、写任务出队减;
    // 连接死 = Client 摘除,计数退出预算派生(账本随 Arc 消亡,无「还 permit」面)。
    let queued = crate::hub::QueuedBytes::default();
    // 本连接下行队里未写出的 Roster 枚数(367):hub 推时加、写任务出队减,与
    // `queued` 同形。它挡的是「名册帧的堆内存不在既有内存包络里」那一格
    // (见 `hub::MAX_ROSTER_INFLIGHT` 的头注:满槽 16.3 MiB/连接 × 32 = 647 MiB)。
    let roster_inflight = crate::hub::RosterInflight::default();

    // 写任务:mpsc → sink。通道全端 drop(读循环退出后)即清空余帧、发 WS Close。
    let queued_w = queued.clone();
    let roster_w = roster_inflight.clone();
    let mut writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let cost = crate::hub::deliver_cost(&msg);
            // 出队一枚 Roster 就还一枚在途额度(加的那一侧是 hub::push_roster 单点)。
            // saturating:并发过冲下计数可能已被别处减到 0,绝不回绕成天文数字。
            let was_roster = matches!(msg, ServerMsg::Roster { .. });
            let sent = sink.send(Message::Binary(sync_proto::encode(&msg).into())).await;
            // 出队即退账(写失败也退——帧随连接死,与「断连释放整队」同语义)。
            if let Some(c) = cost {
                queued_w.fetch_sub(c, std::sync::atomic::Ordering::Relaxed);
            }
            if was_roster {
                let _ = roster_w.fetch_update(
                    std::sync::atomic::Ordering::Relaxed,
                    std::sync::atomic::Ordering::Relaxed,
                    |v| Some(v.saturating_sub(1)),
                );
            }
            if sent.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // 连接即发 challenge(§4):32B 系统熵,一连接一个,断开即失。
    // try_send:队此刻恒空(容量数千),失败只可能是环境级故障。
    let mut nonce = [0u8; CHALLENGE_LEN];
    getrandom::fill(&mut nonce).expect("系统熵不可用是环境级故障");
    send_msg(&tx, ServerMsg::Challenge { nonce: nonce.to_vec() });

    let mut state = ConnState::Fresh;
    // 367:两条新命令的连接级限频(随本任务的栈消亡,无回收面)。
    let mut limits = ConnLimits {
        admin: crate::registry::TokenBucket::new(
            DEVICE_ADMIN_BURST_CONN,
            Duration::from_secs(crate::registry::DEVICE_ADMIN_REFILL_SECS),
        ),
        last_roster_reply: None,
    };
    let mut kicked = false;
    // 未鉴权截止(2026-07-31 评审):Fresh 态是**绝对钟**——静默判死把任何帧(含
    // WS ping)都算活动,一条只 ping 不鉴权的空连接能永久占位;这道钟不被活动续命。
    // PairJoined 放宽到槽 TTL + 余量(joiner 等 opener 是合法慢路径),Authed 解除。
    let mut preauth_deadline =
        Some(tokio::time::Instant::now() + hub.cfg.handshake_timeout);
    loop {
        let received = tokio::select! {
            biased; // 关断优先于继续读
            _ = kick_rx.recv() => {
                logln(format!("INFO conn={conn_id} 被关断(顶替/慢客户端/吊销)"));
                kicked = true;
                break;
            }
            _ = preauth_expire(preauth_deadline) => {
                logln(format!("INFO conn={conn_id} 未鉴权超时断开"));
                break;
            }
            r = timeout(hub.cfg.silence_timeout, stream.next()) => match r {
                Err(_) => {
                    logln(format!("INFO conn={conn_id} 静默超时断开"));
                    break;
                }
                Ok(None) => break,
                Ok(Some(Err(e))) => {
                    // 含超帧(> MAX_FRAME_BYTES,WS 层拒)与传输错误。
                    logln(format!("INFO conn={conn_id} 连接错误断开:{e}"));
                    break;
                }
                Ok(Some(Ok(m))) => m,
            },
        };
        // 下行队满 = 对端只发不读(正常客户端的队恒接近空):断开(codex H1)。
        if tx.capacity() == 0 {
            logln(format!("INFO conn={conn_id} 下行队满(对端不读)断开"));
            break;
        }
        let bytes = match received {
            Message::Binary(b) => b,
            Message::Close(_) => break,
            // WS 层 ping/pong 由库应答,算活动、不进协议层。
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Text(_) => {
                err(&tx, err_code::BAD_REQUEST, "本协议只走二进制帧");
                break;
            }
        };
        let Ok(msg) = sync_proto::decode::<ClientMsg>(&bytes) else {
            err(&tx, err_code::BAD_REQUEST, "信封无法解码");
            break;
        };
        // 达量限速准入(169,工序 3;§4 计数口径:只 Authed 面 Send/PairMsg 过桶,按
        // 收到的 WS 帧字节计一次;控制帧与未鉴权 joiner 的 PairMsg 不计)。等待在主循环、
        // 临界区外,可被 kick 取消——放 dispatch 前(route_send/pair_relay 之前)。
        if let Some((account, device, session_gen)) = throttle_target(&state, &msg) {
            let frame_bytes = bytes.len() as u64;
            // 计量准入栅栏(169,codex H-3):enter 在 registry 锁前;失败=停机关栅,
            // 帧拒(不计不路由)、断开(客户端重连到重启后服务、按水位重发,无丢失)。
            if !hub.admission_enter() {
                logln(format!("INFO conn={conn_id} 停机计量栅栏:拒帧、断开"));
                break;
            }
            // leave 紧跟 admission(只括住计数临界段;限速等待在栅栏外,不拖 drain)。
            let (decision, newly_restricted) =
                hub.throttle_admission(&account, &device, session_gen, conn_id, frame_bytes);
            hub.admission_leave();
            // 工序4:FastlaneExhausted 首穿越 → ENTER 实时推送(锁外、**处理 decision 之前**;
            // codex 检查点①:Kicked 那帧也可能正是首次跨线,不能漏。push 内按当前快照门控,
            // cap 推 AccountStatusV1、旧客户端仅当前仍受限才推 account_throttled)。
            if newly_restricted {
                hub.push_account_status(&account);
            }
            match decision {
                AdmitDecision::Immediate => {}
                AdmitDecision::Kicked => {
                    // 会话已被更新会话顶替(stale gen):帧已计 wire 字节,连接按 kicked
                    // 收尾(kick 在途;不淘汰新会话 ticket)。
                    logln(format!("INFO conn={conn_id} 限速准入:会话已被顶替(stale),断开"));
                    kicked = true;
                    break;
                }
                AdmitDecision::Wait(handle) => match throttle_wait(&hub, handle, &mut kick_rx).await {
                    WaitOutcome::Proceed => {}
                    WaitOutcome::Kicked => {
                        kicked = true;
                        break;
                    }
                },
            }
        }
        match dispatch(
            &hub,
            conn_id,
            &tx,
            &kick_tx,
            &queued,
            &roster_inflight,
            &nonce,
            &state,
            &mut limits,
            msg,
        )
        .await
        {
            Step::Continue => {}
            Step::Close => break,
            // 吊销式收场:与被 kick 同待遇(队里余帧一帧都不许出门)。
            Step::Abort => {
                kicked = true;
                break;
            }
            Step::Become(next) => {
                preauth_deadline = match &next {
                    ConnState::Authed { .. } => None,
                    ConnState::PairJoined { .. } => Some(
                        tokio::time::Instant::now() + hub.cfg.pair_slot_ttl + PAIR_JOINED_GRACE,
                    ),
                    // 无转回 Fresh 的路径;真出现也只是保留原钟,不放宽。
                    ConnState::Fresh => preauth_deadline,
                };
                state = next;
            }
        }
    }

    let authed = match &state {
        ConnState::Authed { account, device, session_gen, .. } => {
            Some((account.clone(), device.clone(), *session_gen))
        }
        _ => None,
    };
    // 限速会话清理(169):clear_if_current——旧连接退出不清已顶替的新会话。
    if let Some((account, device, session_gen)) = &authed {
        hub.throttle_clear(account, device, *session_gen);
    }
    let addr = authed.as_ref().map(|(a, d, _)| (a.clone(), d.clone()));
    hub.detach(conn_id, addr.as_ref());
    if kicked && authed.is_some() {
        // 关断即断(codex P4-e 轮 H4):被顶替/慢客户端/吊销的连接,队里余帧
        // 一帧都不再出门(吊销后继续冲密文给被吊设备不可接受;TCP 已在途的
        // 字节无法召回,abort 是能收的最紧边界)。帧丢失由水位协议自愈。
        writer.abort();
    } else {
        // 正常断开,**以及未鉴权连接的关断**(洪泛闸「槽死即踢 joiner」走这里):
        // 未鉴权队里只有配对事件(PairPeer::Closed/Left),按序送完再发 WS Close
        // ——joiner 客户端靠那帧把「对端中止配对」显成人话(core transport 集成测
        // 钉着这个契约),abort 会把它吞成裸连接重置。资源面不回退:对端不收时
        // 下方 10s 限时兜底,permit 至多多占一次排空的工夫。
        // 正常断开:drop 本地 tx 即通道全关(detach 后 hub 已无本连接的 clone)
        // → 写任务清空余帧、发 WS Close 干净收场。写任务若卡在对端不收的 TCP
        // 写上,限时后掐断(不让连接任务泄漏)。
        drop(tx);
        if timeout(Duration::from_secs(10), &mut writer).await.is_err() {
            writer.abort();
        }
    }
}

/// 未鉴权截止钟(None = 已鉴权,永不醒)。select 分支用;绝对钟,不被帧活动续命。
async fn preauth_expire(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

/// 下行回复(try_send,绝不等队):满 = 对端不读,丢弃即可——主循环在下一帧
/// 到达时按「队满断开」收场,不会静默僵住。
fn send_msg(tx: &Tx, msg: ServerMsg) {
    let _ = tx.try_send(msg);
}

fn err(tx: &Tx, code: &str, msg: &str) {
    send_msg(tx, ServerMsg::Err { code: code.into(), msg: msg.into() });
}

/// 「本设备已被吊销」的**唯一收场点**(实现审弹二 H1)。
///
/// ⛔ 收场方式只有这一处说了算。原先 `PairOpen` / `RegisterDevice` / `SeatLease`
/// 三处各写一遍,而三处**都写成了排空式的 `Step::Close`** —— 注释还写着「kick 反正
/// 在途」,可我们当场 break,那枚 kick 永远没人取,于是被别人吊销的设备照样排空最多
/// 10 秒的旧队列(正是 P4-e 二审 H4 那条红线禁止的形)。同一件事的第二个抄写点就是
/// 漂移源,所以这里只留一处。
///
/// ⚠ `DeviceAdmin` 那条**不走本函数**:它的回执要用预留的 permit 发,断不断连由
/// `DeviceAdminError::is_fatal()` 一处说了算(那也是单点)。
fn revoked(tx: &Tx) -> Step {
    err(tx, err_code::AUTH_FAILED, "本设备已被吊销");
    Step::Abort
}

fn verify(pubkey: &[u8], payload: &[u8], sig: &[u8]) -> bool {
    let Ok(pk) = <[u8; 32]>::try_from(pubkey) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return false };
    let Ok(sig) = Signature::from_slice(sig) else { return false };
    vk.verify_strict(payload, &sig).is_ok()
}

async fn dispatch(
    hub: &Arc<Hub>,
    conn_id: u64,
    tx: &Tx,
    kick_tx: &crate::hub::KickTx,
    queued: &crate::hub::QueuedBytes,
    roster_inflight: &crate::hub::RosterInflight,
    nonce: &[u8; CHALLENGE_LEN],
    state: &ConnState,
    limits: &mut ConnLimits,
    msg: ClientMsg,
) -> Step {
    match (state, msg) {
        (_, ClientMsg::Ping) => {
            send_msg(tx, ServerMsg::Pong);
            Step::Continue
        }

        (ConnState::Fresh, ClientMsg::Auth { account, device, sig, caps }) => {
            if !is_ulid(&account) || !is_ulid(&device) || sig.len() != ED25519_SIG_LEN {
                err(tx, err_code::BAD_REQUEST, "鉴权字段形态不合法");
                return Step::Close;
            }
            // 工序4:能力协商——声明 account_status_v1 者上线后收 AccountStatusV1。
            let wants_status = sync_proto::has_capability(&caps, sync_proto::CAP_ACCOUNT_STATUS_V1);
            // 367:名册三条只发给声明者(未知变体会让旧客户端 DecodeError 断连)。
            let wants_roster =
                sync_proto::has_capability(&caps, sync_proto::CAP_DEVICE_ROSTER_V1);
            // 封禁 / 未注册 / 坏签名对外同一个错,不给探测面(§4;open-signup 起
            // 准入开放,拒的只有封禁表命中——attach 会在同锁内复核,堵 reload 竞态)。
            let pubkey = {
                let reg = hub.registry.lock().unwrap();
                if reg.is_banned(&account) { None } else { reg.pubkey_of(&account, &device) }
            };
            let ok = pubkey
                .is_some_and(|pk| verify(&pk, &auth_sig_payload(nonce, &account, &device), &sig));
            let (Some(pk), true) = (pubkey, ok) else {
                logln(format!("INFO conn={conn_id} 鉴权拒 account={account} device={device}"));
                err(tx, err_code::AUTH_FAILED, "鉴权失败");
                return Step::Close;
            };
            // Authed 由 attach 在锁内发(恒在积压 deliver 之前);attach 顺带复核
            // 「此刻仍是这把公钥」——verify 与上线之间被 revoke_device 插队(含
            // 吊后重注册换钥的 ABA)= false,按鉴权失败断开(codex P4-e 轮 H1)。
            let Some(session_gen) = hub.attach_authenticated(&account, &device, pk, conn_id, tx.clone(), kick_tx.clone(), queued.clone(), wants_status, wants_roster, roster_inflight.clone())
            else {
                logln(format!("INFO conn={conn_id} 鉴权后上线被拒(已吊销)account={account} device={device}"));
                err(tx, err_code::AUTH_FAILED, "鉴权失败");
                return Step::Close;
            };
            logln(format!("INFO conn={conn_id} authed account={account} device={device}"));
            Step::Become(ConnState::Authed { account, device, pubkey: pk, session_gen, wants_roster })
        }

        (ConnState::Fresh, ClientMsg::RegisterFirst { account, device, pubkey, sig, caps }) => {
            if !is_ulid(&account)
                || !is_ulid(&device)
                || pubkey.len() != ED25519_PUB_LEN
                || sig.len() != ED25519_SIG_LEN
            {
                err(tx, err_code::BAD_REQUEST, "注册字段形态不合法");
                return Step::Close;
            }
            // 工序4:能力协商(同 Auth;首台注册者也可声明,上线即收 AccountStatusV1)。
            let wants_status = sync_proto::has_capability(&caps, sync_proto::CAP_ACCOUNT_STATUS_V1);
            // 367:同上——首台注册者上线即收一枚名册(那也是它的能力信号)。
            let wants_roster =
                sync_proto::has_capability(&caps, sync_proto::CAP_DEVICE_ROSTER_V1);
            // 签名覆盖本连接 challenge,用消息自带公钥验——自证私钥持有且防离线
            // 重放(§4);顺带证明 pubkey 是可用的 Ed25519 公钥。验签在 registry 锁外。
            if !verify(&pubkey, &register_first_sig_payload(nonce, &account, &device, &pubkey), &sig)
            {
                err(tx, err_code::AUTH_FAILED, "鉴权失败");
                return Step::Close;
            }
            let pk: [u8; 32] = pubkey.as_slice().try_into().expect("长度已校验");
            // 「检查零设备 + 插入首台 + 落盘」在 registry 锁内原子完成——并发双首台
            // 恰一胜(§4,评审①-M4)。
            let result = hub.registry.lock().unwrap().register_first(&account, &device, pk);
            match result {
                Ok(()) => {
                    // attach 内联发 Authed + 复核「仍是这把公钥」(注册成功到上线
                    // 之间被 revoke 插队的窗口,同 Auth 分支)。
                    let Some(session_gen) = hub.attach_authenticated(
                        &account,
                        &device,
                        pk,
                        conn_id,
                        tx.clone(),
                        kick_tx.clone(),
                        queued.clone(),
                        wants_status,
                        wants_roster,
                        roster_inflight.clone(),
                    ) else {
                        logln(format!(
                            "INFO conn={conn_id} 首台注册后上线被拒(已吊销)account={account}"
                        ));
                        err(tx, err_code::AUTH_FAILED, "鉴权失败");
                        return Step::Close;
                    };
                    logln(format!("INFO conn={conn_id} 首台注册 account={account} device={device}"));
                    Step::Become(ConnState::Authed { account, device, pubkey: pk, session_gen, wants_roster })
                }
                Err(RegisterError::Banned | RegisterError::AccountSealed) => {
                    // 封禁 / 账户已封存(#1):同 auth_failed 待遇、断开,不给探测面。
                    logln(format!(
                        "INFO conn={conn_id} 首台注册拒(封禁/账户封存)account={account}"
                    ));
                    err(tx, err_code::AUTH_FAILED, "鉴权失败");
                    Step::Close
                }
                // 创号洪泛闸(2026-07-31 评审):两错对外同一个 busy(拒新建不解释
                // 内情),断开——失败的创号不配占着连接重试,重连即成本。
                Err(RegisterError::SignupThrottled) => {
                    // 聚合日志(codex M3:洪泛期逐条打=journal 放大器)。
                    hub.log_signup_reject(false);
                    err(tx, err_code::BUSY, "服务器繁忙,请稍后再试");
                    Step::Close
                }
                Err(RegisterError::DirectoryFull) => {
                    // 目录满=要人处置的容量事件,聚合行升 ERROR(同 60s 窗口)。
                    hub.log_signup_reject(true);
                    err(tx, err_code::BUSY, "服务器繁忙,请稍后再试");
                    Step::Close
                }
                Err(e) => {
                    let (code, human): (&str, &str) = match e {
                        RegisterError::NotFirst => {
                            (err_code::NOT_FIRST, "账户已有设备:请在老设备上发起配对加入")
                        }
                        RegisterError::DeviceIdTaken => {
                            (err_code::DEVICE_ID_TAKEN, "设备身份已被占用(整库拷贝?)")
                        }
                        RegisterError::Persist => (err_code::INTERNAL, "服务器存储故障,请稍后重试"),
                        RegisterError::Banned
                        | RegisterError::AccountSealed
                        | RegisterError::SignupThrottled
                        | RegisterError::DirectoryFull
                        | RegisterError::AccountNotInitialized
                        | RegisterError::AccountFull
                        | RegisterError::SeatLimit => {
                            unreachable!("上一分支已拦 / register_first 不产此错")
                        }
                    };
                    logln(format!(
                        "INFO conn={conn_id} 首台注册拒 account={account} device={device} code={code}"
                    ));
                    err(tx, code, human);
                    // 竞态败者可转 auth(若它就是已注册的那台)——连接留着。
                    Step::Continue
                }
            }
        }

        (ConnState::Fresh, ClientMsg::PairJoin { slot }) => {
            match hub.pair_join(conn_id, tx.clone(), kick_tx.clone(), queued.clone(), slot) {
                Ok(()) => {
                    logln(format!("INFO conn={conn_id} 入配对槽 {slot}"));
                    Step::Become(ConnState::PairJoined { slot })
                }
                Err(code) => {
                    // 猜槽变重连成本:失败即断。
                    err(tx, code, "配对码无效或已失效");
                    Step::Close
                }
            }
        }

        (ConnState::PairJoined { slot }, ClientMsg::PairMsg { slot: s, blob }) if s == *slot => {
            if let Err(code) = hub.pair_relay(conn_id, s, blob) {
                err(tx, code, "配对通道已失效");
                return Step::Close;
            }
            Step::Continue
        }
        (ConnState::PairJoined { slot }, ClientMsg::PairClose { slot: s }) if s == *slot => {
            let _ = hub.pair_close(conn_id, s);
            Step::Close
        }

        (ConnState::Authed { account, device, .. }, ClientMsg::Send { n, to, lane, blob }) => {
            if to != BROADCAST && !is_ulid(&to) {
                send_msg(tx, ServerMsg::Nack { n, code: err_code::UNKNOWN_DEVICE.into() });
                return Step::Continue;
            }
            // conn_id 一起下去:route 在 state 锁内核「本连接仍是该设备的当前在线
            // 连接」(H-ABA 授权租约)。
            let reply = match hub.route_send(account, device, conn_id, &to, lane, blob) {
                Ok(()) => ServerMsg::Ack { n },
                Err(code) => ServerMsg::Nack { n, code: code.into() },
            };
            send_msg(tx, reply);
            Step::Continue
        }

        (ConnState::Authed { account, device, .. }, ClientMsg::PairOpen) => {
            match hub.pair_open(account, device, conn_id, tx.clone()) {
                Ok(slot) => {
                    logln(format!("INFO conn={conn_id} 开配对槽 {slot}"));
                    send_msg(tx, ServerMsg::PairSlot { slot });
                    Step::Continue
                }
                // 授权租约已失(吊销/顶替):吊销式收场,见 [`revoked`]。
                Err(code) if code == err_code::AUTH_FAILED => revoked(tx),
                Err(code) => {
                    // 席位前置拒 / 硬帽 / 全局槽满:业务信号,不断开(billing-plan
                    // §5 M5:满席要给可显示的「先移除再添加」,不是断连)。
                    let human = match code {
                        err_code::SEAT_LIMIT => "同步席位已满:请先移除一台设备再添加",
                        err_code::ACCOUNT_FULL => "账户设备数已达服务器上限:先吊销一台不用的设备再加",
                        _ => "配对槽已满,请稍后再试",
                    };
                    err(tx, code, human);
                    Step::Continue
                }
            }
        }
        (ConnState::Authed { .. }, ClientMsg::PairMsg { slot, blob }) => {
            if let Err(code) = hub.pair_relay(conn_id, slot, blob) {
                // 发起端错槽/对端未就绪:回错不断开(authed 面是长连主通道)。
                err(tx, code, "配对通道未就绪或已失效");
            }
            Step::Continue
        }
        (ConnState::Authed { .. }, ClientMsg::PairClose { slot }) => {
            // 幂等静默:PairClose 是「确保槽不在」的意图,槽已死(TTL/对端已烧)
            // = 意图已达成。回 bad_slot 会变成一枚迟到错误——客户端若已开新配对
            // 槽,无 slot 归属的旧错误会被误归给新配对、无辜烧掉新槽(多空间
            // 工序 7/8 二审 M1;客户端侧同轮配套:收 bad_slot 不再回发 PairClose)。
            let _ = hub.pair_close(conn_id, slot);
            Step::Continue
        }

        (
            ConnState::Authed { account, device, pubkey: session_pub, .. },
            ClientMsg::RegisterDevice { account: acct, new_device, new_pubkey, sig_by_old },
        ) => {
            if acct != *account {
                err(tx, err_code::BAD_REQUEST, "account 与鉴权身份不符");
                return Step::Close;
            }
            // 参数问题回错不断开:这是 authed 主通道,坏参数多半来自配对里
            // 新设备递来的数据,别断老设备的长连。曲线点校验防「垃圾 32B 入库
            // 永久烧掉 device_id」(codex P2-e M3)。
            let pk: Option<[u8; 32]> = new_pubkey.as_slice().try_into().ok();
            let pk = pk.filter(|p| VerifyingKey::from_bytes(p).is_ok());
            let Some(pk) = pk.filter(|_| is_ulid(&new_device) && sig_by_old.len() == ED25519_SIG_LEN)
            else {
                err(tx, err_code::BAD_REQUEST, "注册字段形态不合法");
                return Step::Continue;
            };
            // 背书签名用**本会话验签那把公钥**验(§4 + H-ABA:不重读 registry——
            // 吊销后同 device_id 重注册换钥的话,registry 里已是别人的钥,拿它验
            // 本会话的背书就是身份混淆)。
            if !verify(
                session_pub,
                &register_device_sig_payload(account, &new_device, &new_pubkey),
                &sig_by_old,
            ) {
                err(tx, err_code::AUTH_FAILED, "背书签名无效");
                return Step::Continue;
            }
            // 原子收尾(codex P4-e 轮 H2/H-ABA):verify(锁外)与插入之间背书者
            // 可能被吊/被重注册——register_endorsed 在 registry 锁内复核「当前公钥
            // 仍是本会话那把」+ state 锁内核「本连接仍是其当前在线连接」再注册;
            // None = 背书资格已失:吊销式收场,见 [`revoked`]。⚠ 原注释写「kick 反正
            // 在途」—— 靠不住(弹二 H1):我们当场收摊,那枚 kick 永远没人取。
            let Some(result) =
                hub.register_endorsed(account, device, *session_pub, conn_id, &new_device, pk)
            else {
                return revoked(tx);
            };
            match result {
                Ok(()) => {
                    logln(format!(
                        "INFO conn={conn_id} 背书注册 account={account} new_device={new_device}"
                    ));
                    send_msg(tx, ServerMsg::Registered { device: new_device });
                }
                // 账户在鉴权后被封禁(banlist reload 插队;open-signup §1.2):
                // 显式 AUTH_FAILED 并断开——不许落进通配 BAD_REQUEST 装普通拒。
                Err(RegisterError::Banned) => {
                    logln(format!("INFO conn={conn_id} 背书注册拒(封禁)account={account}"));
                    err(tx, err_code::AUTH_FAILED, "鉴权失败");
                    return Step::Close;
                }
                Err(e) => {
                    let (code, human): (&str, &str) = match e {
                        RegisterError::DeviceIdTaken => {
                            (err_code::DEVICE_ID_TAKEN, "设备身份已被占用")
                        }
                        RegisterError::AccountFull => (
                            err_code::ACCOUNT_FULL,
                            "账户设备数已达服务器上限:先吊销一台不用的设备再加",
                        ),
                        // 两层席位闸的商业层(billing-plan §5,工序 2):权威执行点。
                        // PairOpen 前置拒后仍到这 = 开槽与注册之间到期/降档;客户端
                        // opener 编排收错即 fail_pair(PairClose 烧槽),槽不悬空。
                        RegisterError::SeatLimit => (
                            err_code::SEAT_LIMIT,
                            "同步席位已满:请先移除一台设备再添加",
                        ),
                        RegisterError::Persist => (err_code::INTERNAL, "服务器存储故障,请稍后重试"),
                        // NotFirst 不属于此路径;封存/未初始化走通配拒。
                        _ => (err_code::BAD_REQUEST, "注册被拒"),
                    };
                    err(tx, code, human);
                }
            }
            Step::Continue
        }

        (
            ConnState::Authed { account, device, pubkey: session_pub, .. },
            ClientMsg::SeatLease { account: acct, new_device, new_pubkey, sig_by_old },
        ) => {
            if acct != *account {
                err(tx, err_code::BAD_REQUEST, "account 与鉴权身份不符");
                return Step::Close;
            }
            // 校验纪律与 RegisterDevice 逐条同构(坏参数回错不断开;曲线点校验
            // 防垃圾 32B 租下目标)。
            let pk: Option<[u8; 32]> = new_pubkey.as_slice().try_into().ok();
            let pk = pk.filter(|p| VerifyingKey::from_bytes(p).is_ok());
            let Some(pk) = pk.filter(|_| is_ulid(&new_device) && sig_by_old.len() == ED25519_SIG_LEN)
            else {
                err(tx, err_code::BAD_REQUEST, "租约字段形态不合法");
                return Step::Continue;
            };
            // sponsor 签名用本会话验签那把公钥验(H-ABA,同 RegisterDevice)。
            if !verify(
                session_pub,
                &seat_lease_sig_payload(account, &new_device, &new_pubkey),
                &sig_by_old,
            ) {
                err(tx, err_code::AUTH_FAILED, "租约签名无效");
                return Step::Continue;
            }
            let Some(result) =
                hub.grant_seat_lease(account, device, *session_pub, conn_id, &new_device, pk)
            else {
                return revoked(tx); // 同上(弹二 H1)。
            };
            match result {
                Ok(()) => {
                    logln(format!(
                        "INFO conn={conn_id} 席位租约 account={account} sponsor={device} new_device={new_device}"
                    ));
                    send_msg(tx, ServerMsg::SeatLease { device: new_device });
                }
                Err(SeatLeaseError::Banned) => {
                    logln(format!("INFO conn={conn_id} 席位租约拒(封禁)account={account}"));
                    err(tx, err_code::AUTH_FAILED, "鉴权失败");
                    return Step::Close;
                }
                Err(SeatLeaseError::DeviceIdTaken) => {
                    err(tx, err_code::DEVICE_ID_TAKEN, "设备身份已被占用");
                }
                Err(SeatLeaseError::AccountFull) => {
                    err(
                        tx,
                        err_code::ACCOUNT_FULL,
                        "账户设备数已达服务器上限:先吊销一台不用的设备再加",
                    );
                }
            }
            Step::Continue
        }

        // 367:用户面设备管理。逐条与 SeatLease 那臂同构(account 不符即断;形态闸
        // 先于验签;H-ABA 复核在 hub 的同一把 registry 锁内)。
        (
            ConnState::Authed { account, device, pubkey: session_pub, wants_roster, .. },
            ClientMsg::DeviceAdmin { account: acct, target, action, sig },
        ) => {
            if acct != *account {
                err(tx, err_code::BAD_REQUEST, "account 与鉴权身份不符");
                return Step::Close;
            }
            // 未声明 cap 者发它 = 它收不到 DeviceAdminOk / Roster(未知变体会让它
            // DecodeError 断连),放行等于让它干等。**回错不静默吞、不断开。**
            if !*wants_roster {
                err(tx, err_code::BAD_REQUEST, "本连接未声明 device_roster_v1 能力");
                return Step::Continue;
            }
            // 形态闸**先于验签**(§5.5):定长形态是签名 payload 拼接无歧义的前提。
            if !is_ulid(&target) || sig.len() != ED25519_SIG_LEN {
                err(tx, err_code::BAD_REQUEST, "设备管理字段形态不合法");
                return Step::Continue;
            }
            // 连接级限频排在验签**之前**:验签是 CPU 成本,别让越频请求白吃。
            if !limits.admin.take(std::time::Instant::now()) {
                err(tx, err_code::BUSY, "设备管理操作过于频繁,请稍后再试");
                return Step::Continue;
            }
            // 签名用**本会话验签那把公钥**验;payload 绑 nonce(移除不是幂等无害的,
            // 一枚签名在别的连接上重放可能命中同 id 被重新注册的设备)。
            if !verify(
                session_pub,
                &device_admin_sig_payload(nonce, account, device, &target, action),
                &sig,
            ) {
                err(tx, err_code::AUTH_FAILED, "设备管理签名无效");
                return Step::Continue;
            }
            // ⛔ **动手之前先占住一个下行槽**(实现审弹二 M1)。`device_admin` 内部会
            // fan-out 一枚名册**给本连接自己**,而名册是可丢的、这条命令的回执不是:
            // 队里只剩一格时,可丢的那枚会把回执挤掉,而操作已经落盘 ⇒ 客户端只看得到
            // 超时。占不到槽 = 对端根本不读下行,此时**一个非幂等操作都不许开始**。
            //
            // ⚠ **准确的保证是「预留入队资格」,不是「必达」**(弹二 L2):这一枚仍排在
            // 既有积压之后,而正常收场只给写任务 10 秒排空窗口。
            //
            // ⛔ **成功与失败两条臂都用这枚 permit 发回执**:占的本来就是「这条命令的
            // 回执」那一格。第一版只让成功臂用它、失败臂另走 `err()`,于是在同一个边界上
            // 把**失败**回执丢掉了(permit 还攥着最后一格,`err` 的 try_send 必失败)——
            // 修法自己带进来的新问题(弹二 M2)。
            let Ok(permit) = tx.try_reserve() else {
                err(tx, err_code::BUSY, "下行通道拥塞,请稍后再试");
                return Step::Continue;
            };
            match hub.device_admin(account, device, *session_pub, conn_id, &target, action) {
                Ok(()) => {
                    // 自助退出:`revoke_locked` 已经朝**本连接**发过 kick 了。
                    // ⛔ **必须连 action 一起判**(弹二 M1):只看 `target == device` 会把
                    // 管理设备对自己的 `GrantAdmin`(幂等成功)与 `RevokeAdmin`(多管理设备
                    // 账户里的合法降级)也当成自助退出,**把同步连接一起关掉**。
                    let self_exit = matches!(action, DeviceAction::Remove) && target == *device;
                    permit.send(ServerMsg::DeviceAdminOk { target, action });
                    if self_exit {
                        // ⛔ **必须当场收场,不许再转一圈 select**(弹二 M1 路径②):
                        // 那条 select 是 `biased` 且 kick 已经躺在通道里 ⇒ 下一拍必取到
                        // kick → `writer.abort()` → 刚排进去的 Ok **必然**被丢掉(这不是
                        // 竞态,是确定的)。走 `Close` 则 `kicked` 保持 false,收场那条路
                        // 排空队列再发 WS Close,回执出得去。
                        //
                        // ⚠ 「被吊销的连接队里余帧一帧都不许出门」那条(P4-e H4)在这里
                        // **不适用**:自助退出 ≠ 被吊销 —— 队里那些帧是它自己片刻之前
                        // 就有权收的、且用它自己手上的 K_acc 加密的。运营者吊销与
                        // 「管理设备踢别人」两条路照旧走 kick+abort。
                        logln(format!(
                            "INFO conn={conn_id} 自助退出 account={account} device={device},回执后收场"
                        ));
                        return Step::Close;
                    }
                    Step::Continue
                }
                Err(e) => {
                    // 每一格对应 §5.5 错误表的一行;断不断连由 `is_fatal` 一处说了算。
                    let (code, human) = match e {
                        DeviceAdminError::Unauthorized => (err_code::AUTH_FAILED, "本设备已被吊销"),
                        DeviceAdminError::Banned => (err_code::AUTH_FAILED, "鉴权失败"),
                        DeviceAdminError::NoAdmins => (
                            err_code::BAD_REQUEST,
                            "本空间还没有设置管理设备,暂时无法在这里管理设备",
                        ),
                        DeviceAdminError::Forbidden => {
                            (err_code::BAD_REQUEST, "只有管理设备能做这件事")
                        }
                        DeviceAdminError::UnknownTarget => {
                            (err_code::UNKNOWN_DEVICE, "这台设备不在本空间")
                        }
                        DeviceAdminError::Busy => {
                            (err_code::BUSY, "设备管理操作过于频繁,请稍后再试")
                        }
                        DeviceAdminError::WouldEmptyAdmins => {
                            (err_code::BAD_REQUEST, "账户至少要保留一台管理设备")
                        }
                        DeviceAdminError::Persist => {
                            (err_code::INTERNAL, "服务器存储故障,操作未生效,请稍后重试")
                        }
                    };
                    // 失败回执走**同一枚 permit**(见上面那段:第一版让它另走 `err()`,
                    // 于是 permit 攥着最后一格把失败回执挤没了)。
                    permit.send(ServerMsg::Err { code: code.into(), msg: human.into() });
                    if e.is_fatal() {
                        logln(format!(
                            "INFO conn={conn_id} 设备管理拒(致命)account={account} device={device} err={e:?}"
                        ));
                        // 「本设备已被吊销」= 别人刚把它吊了 ⇒ **吊销式**收场(弹二 H1)。
                        return Step::Abort;
                    }
                    Step::Continue
                }
            }
        }

        // 367:拉一枚当前名册。**不签名**——连接已鉴权,且名册只含自己账户的
        // device_id(发起方本来就有权知道)。失败面是**有编号**的 RosterNack,
        // 故一枚无编号的 Err 永远不该被客户端认给它。
        (ConnState::Authed { account, device, wants_roster, .. }, ClientMsg::RosterReq { n }) => {
            if !*wants_roster {
                err(tx, err_code::BAD_REQUEST, "本连接未声明 device_roster_v1 能力");
                return Step::Continue;
            }
            let now = std::time::Instant::now();
            if limits.last_roster_reply.is_some_and(|t| now.duration_since(t) < ROSTER_REQ_MIN_GAP) {
                send_msg(tx, ServerMsg::RosterNack { n, code: err_code::BUSY.into() });
                return Step::Continue;
            }
            // 只在**真答了**才推进间隔基点:超频那次不推进,否则刷得越快越答不上。
            if hub.reply_roster(account, device, conn_id, n) {
                limits.last_roster_reply = Some(now);
            } else {
                // 没发出去(在途上界 / 通道满 / 这条连接已不算数):回一枚**带号**的
                // Nack,让客户端的 deadline 与周期轴接手,别让它干等到超时。
                send_msg(tx, ServerMsg::RosterNack { n, code: err_code::BUSY.into() });
            }
            Step::Continue
        }

        // 其余全是状态越权(Fresh 发 Send、authed 重复鉴权、PairJoined 发别的槽…):
        // 协议误用,fail-fast 断开。
        (_, other) => {
            logln(format!("INFO conn={conn_id} 越权或乱序消息断开:{}", name_of(&other)));
            err(tx, err_code::BAD_REQUEST, "当前状态不允许此消息");
            Step::Close
        }
    }
}

/// 该帧是否过数据桶(169,工序 3):只 Authed 面的 Send/PairMsg 计量;控制帧、未鉴权
/// `PairJoined` 的 PairMsg(无账户归属)一律不计。返回 (account, device, session_gen)。
fn throttle_target(state: &ConnState, msg: &ClientMsg) -> Option<(String, String, u64)> {
    match (state, msg) {
        (
            ConnState::Authed { account, device, session_gen, .. },
            ClientMsg::Send { .. } | ClientMsg::PairMsg { .. },
        ) => Some((account.clone(), device.clone(), *session_gen)),
        _ => None,
    }
}

enum WaitOutcome {
    Proceed,
    Kicked,
}

/// 限速等待循环(169,临界区外):poll 得处置 → 睡到点 / 等 generation 变化 / kicked。
/// disp 锁外先读(终态直接归类);watch sender 关闭(Hub 析构=进程停机)按 kicked 退出
/// (codex 断言④)。kick 走 biased 优先,取消即断——回主循环走 `kicked=true` 收尾。
async fn throttle_wait(
    hub: &Arc<Hub>,
    mut handle: WaitHandle,
    kick_rx: &mut tokio::sync::mpsc::Receiver<()>,
) -> WaitOutcome {
    loop {
        match handle.disp.load(Ordering::SeqCst) {
            DISP_ADMITTED | DISP_RELEASED => return WaitOutcome::Proceed,
            DISP_CANCELLED => return WaitOutcome::Kicked,
            _ => {}
        }
        let now = std::time::Instant::now();
        match hub.throttle_poll(&handle, now) {
            PollOutcome::Proceed => return WaitOutcome::Proceed,
            PollOutcome::Kicked => return WaitOutcome::Kicked,
            PollOutcome::SleepUntil(deadline) => {
                let dl = tokio::time::Instant::from_std(deadline);
                tokio::select! {
                    biased;
                    _ = kick_rx.recv() => return WaitOutcome::Kicked,
                    r = handle.gen_rx.changed() => {
                        if r.is_err() { return WaitOutcome::Kicked; }
                    }
                    _ = tokio::time::sleep_until(dl) => {}
                }
            }
            PollOutcome::WaitGen => {
                tokio::select! {
                    biased;
                    _ = kick_rx.recv() => return WaitOutcome::Kicked,
                    r = handle.gen_rx.changed() => {
                        if r.is_err() { return WaitOutcome::Kicked; }
                    }
                }
            }
        }
    }
}

/// 日志用变体名(只打名字——blob 是密文,也不进日志,§4)。
fn name_of(msg: &ClientMsg) -> &'static str {
    match msg {
        ClientMsg::RegisterFirst { .. } => "RegisterFirst",
        ClientMsg::Auth { .. } => "Auth",
        ClientMsg::Send { .. } => "Send",
        ClientMsg::RegisterDevice { .. } => "RegisterDevice",
        ClientMsg::SeatLease { .. } => "SeatLease",
        ClientMsg::PairOpen => "PairOpen",
        ClientMsg::PairJoin { .. } => "PairJoin",
        ClientMsg::PairMsg { .. } => "PairMsg",
        ClientMsg::PairClose { .. } => "PairClose",
        ClientMsg::Ping => "Ping",
        ClientMsg::DeviceAdmin { .. } => "DeviceAdmin",
        ClientMsg::RosterReq { .. } => "RosterReq",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::Arc;

    const ACCT: &str = "0AAAAAAAAAAAAAAAAAAAAAAAAA";
    const D1: &str = "0DAAAAAAAAAAAAAAAAAAAAAAA1";
    const D2: &str = "0DAAAAAAAAAAAAAAAAAAAAAAA2";

    fn key(b: u8) -> SigningKey {
        SigningKey::from_bytes(&[b; 32])
    }

    /// **失败回执也要挤得进那最后一格**(实现审弹二 M2)。
    ///
    /// 病:`try_reserve` 那枚 permit 是为「这条命令的回执」占的,而第一版只有成功臂用它,
    /// 失败臂另走 `err()` = 普通 `try_send`。队里恰剩一格时,permit 正攥着那一格 ⇒
    /// **失败回执必然发不出去**。修法保住了成功回执,却在同一个边界上把失败回执弄丢了。
    ///
    /// ⭐ 判据要落在**恰剩一格**上:队深由 `channel_cap()` 决定(生产 ≥1024),
    /// 生产里靠不住地凑不出来 —— 但 `dispatch` 是个普通函数,直接给它一条 cap=1 的通道
    /// 就是确定性的(codex 原话:「一个 cap=1 的 conn 层单元测就能确定性覆盖」)。
    #[tokio::test]
    async fn a_rejected_device_admin_still_gets_its_receipt_on_a_one_slot_queue() {
        let dir = crate::test_temp::dir()
            .join(format!("zhujian-syncd-conntest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let banlist = dir.join("banlist.txt");
        std::fs::write(&banlist, "# 空封禁表\n").unwrap();
        let (sk1, sk2) = (key(1), key(2));
        let mut reg =
            crate::registry::Registry::load(&banlist, dir.join("registry.json")).unwrap();
        reg.register_first(ACCT, D1, sk1.verifying_key().to_bytes()).unwrap();
        reg.register_device(ACCT, D2, sk2.verifying_key().to_bytes(), 8, time::OffsetDateTime::now_utc())
            .unwrap();
        let cfg = crate::Config::new(banlist, dir.join("registry.json"));
        let hub = Arc::new(Hub::new(cfg, reg));

        // ⭐ **cap = 1**:这一格生产里凑不出来,单元测里是确定的。
        let (tx, mut rx) = tokio::sync::mpsc::channel::<ServerMsg>(1);
        let (kick_tx, _kick_rx) = tokio::sync::mpsc::channel::<()>(1);
        let roster_inflight = crate::hub::RosterInflight::default();
        let session_gen = hub
            .attach_authenticated(
                ACCT,
                D2,
                sk2.verifying_key().to_bytes(),
                7,
                tx.clone(),
                kick_tx.clone(),
                crate::hub::QueuedBytes::default(),
                false,
                true,
                roster_inflight.clone(),
            )
            .expect("上线");
        // 排空 attach 排进来的那枚,让队里**恰好剩一格**。
        while rx.try_recv().is_ok() {}
        assert_eq!(tx.capacity(), 1, "前置:恰剩一格 —— 判据全靠这一格");

        // D2 不是管理设备 ⇒ GrantAdmin 必被授权那道闸拒(Forbidden,非致命)。
        let nonce = [9u8; CHALLENGE_LEN];
        let sig = sk2
            .sign(&device_admin_sig_payload(&nonce, ACCT, D2, D1, DeviceAction::GrantAdmin))
            .to_bytes()
            .to_vec();
        let state = ConnState::Authed {
            account: ACCT.into(),
            device: D2.into(),
            pubkey: sk2.verifying_key().to_bytes(),
            session_gen,
            wants_roster: true,
        };
        let mut limits = ConnLimits {
            admin: crate::registry::TokenBucket::new(
                DEVICE_ADMIN_BURST_CONN,
                Duration::from_secs(crate::registry::DEVICE_ADMIN_REFILL_SECS),
            ),
            last_roster_reply: None,
        };
        let step = dispatch(
            &hub,
            7,
            &tx,
            &kick_tx,
            &crate::hub::QueuedBytes::default(),
            &roster_inflight,
            &nonce,
            &state,
            &mut limits,
            ClientMsg::DeviceAdmin {
                account: ACCT.into(),
                target: D1.into(),
                action: DeviceAction::GrantAdmin,
                sig,
            },
        )
        .await;
        assert!(matches!(step, Step::Continue), "业务判定不断连");
        match rx.try_recv() {
            Ok(ServerMsg::Err { code, .. }) => assert_eq!(code, err_code::BAD_REQUEST),
            other => panic!("失败回执被那枚 permit 挤掉了:{other:?}"),
        }

        // ---- 同一套夹具接着钉 H1:**被别人吊销 ⇒ 吊销式收场,不许排空** ----
        //
        // 造法不靠竞态:H-ABA 的第二半是「这条连接仍是它的当前在线连接吗」,给一个不
        // 匹配的 `conn_id` 就是确定的失效(生产里它对应的正是「别人刚把我吊了/顶替了」)。
        // 判据是 `Step::Abort` 而不是 `Close` —— 后者走的是排空那条路,会把吊销前积压的
        // 密文继续冲给一台刚被吊的设备(P4-e 二审 H4 那条红线)。
        while rx.try_recv().is_ok() {}
        let sig = sk2
            .sign(&device_admin_sig_payload(&nonce, ACCT, D2, D2, DeviceAction::Remove))
            .to_bytes()
            .to_vec();
        let step = dispatch(
            &hub,
            999, // ← 不是它的当前在线连接
            &tx,
            &kick_tx,
            &crate::hub::QueuedBytes::default(),
            &roster_inflight,
            &nonce,
            &state,
            &mut limits,
            ClientMsg::DeviceAdmin {
                account: ACCT.into(),
                target: D2.into(),
                action: DeviceAction::Remove,
                sig,
            },
        )
        .await;
        assert!(
            matches!(step, Step::Abort),
            "被别人吊销要走吊销式收场;Close 会排空旧队列(P4-e H4 红线)"
        );
    }
}
