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
    auth_sig_payload, err_code, is_ulid, register_device_sig_payload, register_first_sig_payload,
    seat_lease_sig_payload, ClientMsg, ServerMsg, BROADCAST, CHALLENGE_LEN, ED25519_PUB_LEN,
    ED25519_SIG_LEN,
};
use tokio::time::timeout;

use crate::hub::{Hub, Tx};
use crate::logln;
use crate::registry::{RegisterError, SeatLeaseError};

/// 连接状态。Fresh 只许 Auth/RegisterFirst/PairJoin/Ping;PairJoined(未鉴权入槽,
/// 限一槽)只许本槽 PairMsg/PairClose/Ping;Authed 是全部业务面。
/// Authed 存本会话验签用的公钥(H-ABA 授权上下文 {account, device, pubkey,
/// conn_id}:吊销后同 device_id 被合法重注册换钥,旧会话不得再以新身份行事)。
enum ConnState {
    Fresh,
    PairJoined { slot: u64 },
    Authed { account: String, device: String, pubkey: [u8; 32] },
}

/// 一条消息的处置结果(状态转移经返回值,绕开对 state 的借用纠纷)。
enum Step {
    Continue,
    /// 致命:已回 err(或无需回),断开。
    Close,
    /// 状态转移(Fresh → Authed / PairJoined)。
    Become(ConnState),
}

pub(crate) async fn handle(hub: Arc<Hub>, ws: WebSocket) {
    let conn_id = hub.next_conn_id();
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ServerMsg>(hub.channel_cap());
    let (kick_tx, mut kick_rx) = tokio::sync::mpsc::channel::<()>(1);
    // 本连接下行队的 Deliver 字节账本(epoch-plan §5.2):hub 入队加、写任务出队减;
    // 连接死 = Client 摘除,计数退出预算派生(账本随 Arc 消亡,无「还 permit」面)。
    let queued = crate::hub::QueuedBytes::default();

    // 写任务:mpsc → sink。通道全端 drop(读循环退出后)即清空余帧、发 WS Close。
    let queued_w = queued.clone();
    let mut writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let cost = crate::hub::deliver_cost(&msg);
            let sent = sink.send(Message::Binary(sync_proto::encode(&msg).into())).await;
            // 出队即退账(写失败也退——帧随连接死,与「断连释放整队」同语义)。
            if let Some(c) = cost {
                queued_w.fetch_sub(c, std::sync::atomic::Ordering::Relaxed);
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
    let mut kicked = false;
    loop {
        let received = tokio::select! {
            biased; // 关断优先于继续读
            _ = kick_rx.recv() => {
                logln(format!("INFO conn={conn_id} 被关断(顶替/慢客户端/吊销)"));
                kicked = true;
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
        match dispatch(&hub, conn_id, &tx, &kick_tx, &queued, &nonce, &state, msg).await {
            Step::Continue => {}
            Step::Close => break,
            Step::Become(next) => state = next,
        }
    }

    let authed = match &state {
        ConnState::Authed { account, device, .. } => Some((account.clone(), device.clone())),
        _ => None,
    };
    hub.detach(conn_id, authed.as_ref());
    if kicked {
        // 关断即断(codex P4-e 轮 H4):被顶替/慢客户端/吊销的连接,队里余帧
        // 一帧都不再出门(吊销后继续冲密文给被吊设备不可接受;TCP 已在途的
        // 字节无法召回,abort 是能收的最紧边界)。帧丢失由水位协议自愈。
        writer.abort();
    } else {
        // 正常断开:drop 本地 tx 即通道全关(detach 后 hub 已无本连接的 clone)
        // → 写任务清空余帧、发 WS Close 干净收场。写任务若卡在对端不收的 TCP
        // 写上,限时后掐断(不让连接任务泄漏)。
        drop(tx);
        if timeout(Duration::from_secs(10), &mut writer).await.is_err() {
            writer.abort();
        }
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
    nonce: &[u8; CHALLENGE_LEN],
    state: &ConnState,
    msg: ClientMsg,
) -> Step {
    match (state, msg) {
        (_, ClientMsg::Ping) => {
            send_msg(tx, ServerMsg::Pong);
            Step::Continue
        }

        (ConnState::Fresh, ClientMsg::Auth { account, device, sig }) => {
            if !is_ulid(&account) || !is_ulid(&device) || sig.len() != ED25519_SIG_LEN {
                err(tx, err_code::BAD_REQUEST, "鉴权字段形态不合法");
                return Step::Close;
            }
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
            if !hub.attach_authenticated(&account, &device, pk, conn_id, tx.clone(), kick_tx.clone(), queued.clone())
            {
                logln(format!("INFO conn={conn_id} 鉴权后上线被拒(已吊销)account={account} device={device}"));
                err(tx, err_code::AUTH_FAILED, "鉴权失败");
                return Step::Close;
            }
            logln(format!("INFO conn={conn_id} authed account={account} device={device}"));
            Step::Become(ConnState::Authed { account, device, pubkey: pk })
        }

        (ConnState::Fresh, ClientMsg::RegisterFirst { account, device, pubkey, sig }) => {
            if !is_ulid(&account)
                || !is_ulid(&device)
                || pubkey.len() != ED25519_PUB_LEN
                || sig.len() != ED25519_SIG_LEN
            {
                err(tx, err_code::BAD_REQUEST, "注册字段形态不合法");
                return Step::Close;
            }
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
                    if !hub.attach_authenticated(
                        &account,
                        &device,
                        pk,
                        conn_id,
                        tx.clone(),
                        kick_tx.clone(),
                        queued.clone(),
                    ) {
                        logln(format!(
                            "INFO conn={conn_id} 首台注册后上线被拒(已吊销)account={account}"
                        ));
                        err(tx, err_code::AUTH_FAILED, "鉴权失败");
                        return Step::Close;
                    }
                    logln(format!("INFO conn={conn_id} 首台注册 account={account} device={device}"));
                    Step::Become(ConnState::Authed { account, device, pubkey: pk })
                }
                Err(RegisterError::Banned | RegisterError::AccountSealed) => {
                    // 封禁 / 账户已封存(#1):同 auth_failed 待遇、断开,不给探测面。
                    logln(format!(
                        "INFO conn={conn_id} 首台注册拒(封禁/账户封存)account={account}"
                    ));
                    err(tx, err_code::AUTH_FAILED, "鉴权失败");
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
            match hub.pair_join(conn_id, tx.clone(), queued.clone(), slot) {
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
                Err(code) if code == err_code::AUTH_FAILED => {
                    // 授权租约已失(吊销/顶替,kick 在途):断开。
                    err(tx, code, "本设备已被吊销");
                    Step::Close
                }
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
            ConnState::Authed { account, device, pubkey: session_pub },
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
            // None = 背书资格已失,断开(kick 反正在途)。
            let Some(result) =
                hub.register_endorsed(account, device, *session_pub, conn_id, &new_device, pk)
            else {
                err(tx, err_code::AUTH_FAILED, "本设备已被吊销");
                return Step::Close;
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
            ConnState::Authed { account, device, pubkey: session_pub },
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
                err(tx, err_code::AUTH_FAILED, "本设备已被吊销");
                return Step::Close;
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

        // 其余全是状态越权(Fresh 发 Send、authed 重复鉴权、PairJoined 发别的槽…):
        // 协议误用,fail-fast 断开。
        (_, other) => {
            logln(format!("INFO conn={conn_id} 越权或乱序消息断开:{}", name_of(&other)));
            err(tx, err_code::BAD_REQUEST, "当前状态不允许此消息");
            Step::Close
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
    }
}
