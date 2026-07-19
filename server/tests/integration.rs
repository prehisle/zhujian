//! zhujian-syncd 集成测(sync-protocol §9 服务端行):起真服务(随机端口)+
//! tokio-tungstenite 真 WS 客户端,逐条钉死 §4 语义。
//!
//! 时间敏感用例(TTL/静默判死)用真时间短配置 + 2 倍余量,别与重负载并行跑。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use sync_proto::{
    auth_sig_payload, err_code, register_device_sig_payload, register_first_sig_payload,
    seat_lease_sig_payload, ClientMsg, Lane, PairEvent, ServerMsg, BROADCAST,
};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use zhujian_syncd::{serve, Config};

// 合法 ULID 形态的测试身份(26 字符大写 Crockford,首字符 ≤ 7)。
const ACCT: &str = "01AAAAAAAAAAAAAAAAAAAAACCT";
const ACCT2: &str = "02AAAAAAAAAAAAAAAAAAAAACCT";
const EVIL: &str = "07AAAAAAAAAAAAAAAAAAAAEV11";
const D1: &str = "0DAAAAAAAAAAAAAAAAAAAAAAA1";
const D2: &str = "0DAAAAAAAAAAAAAAAAAAAAAAA2";
const D3: &str = "0DAAAAAAAAAAAAAAAAAAAAAAA3";
const DX: &str = "0DAAAAAAAAAAAAAAAAAAAAAAAX";

fn key() -> SigningKey {
    SigningKey::generate(&mut rand::rngs::OsRng)
}

/// 起测试服务:唯一 tmpdir + 封禁表(open-signup:准入开放,空表=零封禁)+
/// 可调配置,返回实际地址。服务任务随本测试的 runtime 结束而消亡。
async fn start(banned: &[&str], tweak: impl FnOnce(&mut Config)) -> SocketAddr {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "zhujian-syncd-it-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("banlist.txt"), format!("# 封禁表\n{}\n", banned.join("\n"))).unwrap();
    let mut cfg = Config::new(dir.join("banlist.txt"), dir.join("registry.json"));
    tweak(&mut cfg);
    let (addr, _handle) = serve("127.0.0.1:0".parse().unwrap(), cfg).await.unwrap();
    addr
}

struct Conn {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    nonce: Vec<u8>,
}

async fn connect(addr: SocketAddr) -> Conn {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("连接失败");
    let first = raw_recv(&mut ws).await.expect("challenge 前连接被关");
    let ServerMsg::Challenge { nonce } = first else {
        panic!("首条不是 challenge:{first:?}");
    };
    assert_eq!(nonce.len(), sync_proto::CHALLENGE_LEN);
    Conn { ws, nonce }
}

/// 读下一条协议消息;None = 连接关闭(Close 帧 / 传输断)。5s 上限。
async fn raw_recv(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Option<ServerMsg> {
    loop {
        let m = timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("5s 没等到消息")?;
        match m {
            Ok(WsMsg::Binary(b)) => {
                return Some(sync_proto::decode::<ServerMsg>(&b).expect("服务器发了不可解帧"))
            }
            Ok(WsMsg::Close(_)) | Err(_) => return None,
            Ok(_) => continue, // WS 层 ping/pong
        }
    }
}

impl Conn {
    async fn send(&mut self, m: &ClientMsg) {
        self.ws
            .send(WsMsg::Binary(sync_proto::encode(m).into()))
            .await
            .expect("发送失败");
    }

    async fn recv(&mut self) -> ServerMsg {
        raw_recv(&mut self.ws).await.expect("连接意外关闭")
    }

    /// 跳过在线状态噪音(Peer)读下一条业务消息。
    async fn recv_skip_peer(&mut self) -> ServerMsg {
        loop {
            match self.recv().await {
                ServerMsg::Peer { .. } => continue,
                other => return other,
            }
        }
    }

    /// 断言连接被服务器关闭(容忍关闭前塞来的 err/其它帧)。
    async fn expect_close(&mut self) {
        for _ in 0..8 {
            if raw_recv(&mut self.ws).await.is_none() {
                return;
            }
        }
        panic!("连接迟迟不关");
    }

    async fn register_first(&mut self, account: &str, device: &str, sk: &SigningKey) {
        let pubkey = sk.verifying_key().to_bytes().to_vec();
        let sig = sk
            .sign(&register_first_sig_payload(&self.nonce, account, device, &pubkey))
            .to_bytes()
            .to_vec();
        self.send(&ClientMsg::RegisterFirst {
            account: account.into(),
            device: device.into(),
            pubkey,
            sig,
        })
        .await;
    }

    async fn auth(&mut self, account: &str, device: &str, sk: &SigningKey) {
        let sig = sk
            .sign(&auth_sig_payload(&self.nonce, account, device))
            .to_bytes()
            .to_vec();
        self.send(&ClientMsg::Auth { account: account.into(), device: device.into(), sig })
            .await;
    }
}

/// 首台注册直通 Authed。
async fn first_authed(addr: SocketAddr, account: &str, device: &str, sk: &SigningKey) -> Conn {
    let mut c = connect(addr).await;
    c.register_first(account, device, sk).await;
    assert_eq!(c.recv().await, ServerMsg::Authed);
    c
}

/// 挑战应答直通 Authed。
async fn authed(addr: SocketAddr, account: &str, device: &str, sk: &SigningKey) -> Conn {
    let mut c = connect(addr).await;
    c.auth(account, device, sk).await;
    assert_eq!(c.recv().await, ServerMsg::Authed, "auth 未过");
    c
}

fn expect_err(m: ServerMsg, code: &str) {
    match m {
        ServerMsg::Err { code: c, .. } => assert_eq!(c, code),
        other => panic!("期待 err {code},得到 {other:?}"),
    }
}

// ---- 鉴权与注册 ----

#[tokio::test]
async fn healthz() {
    let addr = start(&[], |_| {}).await;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).await.unwrap();
    assert!(buf.starts_with("HTTP/1.1 200"), "{buf}");
    assert!(buf.ends_with("ok"), "{buf}");
}

#[tokio::test]
async fn auth_rejections() {
    // EVIL 进封禁表(open-signup:准入开放,拒的只有封禁命中)。
    let addr = start(&[EVIL], |_| {}).await;
    // 封禁账户 register_first:与坏签名同错(不给探测面),断开。
    let mut c = connect(addr).await;
    c.register_first(EVIL, D1, &key()).await;
    expect_err(c.recv().await, err_code::AUTH_FAILED);
    c.expect_close().await;
    // 封禁账户 auth 同拒(设备从未注册过也一样,不给探测面)。
    let mut c = connect(addr).await;
    c.auth(EVIL, D1, &key()).await;
    expect_err(c.recv().await, err_code::AUTH_FAILED);
    c.expect_close().await;
    // 未注册设备 auth。
    let mut c = connect(addr).await;
    c.auth(ACCT, D1, &key()).await;
    expect_err(c.recv().await, err_code::AUTH_FAILED);
    c.expect_close().await;
    // 注册后,坏签名(别人的钥签)auth。
    let sk = key();
    first_authed(addr, ACCT, D1, &sk).await;
    let mut c = connect(addr).await;
    c.auth(ACCT, D1, &key()).await;
    expect_err(c.recv().await, err_code::AUTH_FAILED);
    c.expect_close().await;
    // 正钥正签仍通(上面的拒没伤 registry)。
    authed(addr, ACCT, D1, &sk).await;
}

#[tokio::test]
async fn auth_challenge_is_per_connection() {
    // 对旧连接 challenge 的签名在新连接上重放必败(§4 防离线重放)。
    let addr = start(&[], |_| {}).await;
    let sk = key();
    first_authed(addr, ACCT, D1, &sk).await;
    let old = connect(addr).await;
    let replay_sig = sk.sign(&auth_sig_payload(&old.nonce, ACCT, D1)).to_bytes().to_vec();
    let mut fresh = connect(addr).await;
    fresh
        .send(&ClientMsg::Auth { account: ACCT.into(), device: D1.into(), sig: replay_sig })
        .await;
    expect_err(fresh.recv().await, err_code::AUTH_FAILED);
    fresh.expect_close().await;
}

#[tokio::test]
async fn tofu_first_then_idempotent_retry_and_second_device_rejected() {
    let addr = start(&[], |_| {}).await;
    let sk = key();
    first_authed(addr, ACCT, D1, &sk).await;
    // H1:同账户同设备同钥重注册 = 幂等 Authed(前次首台注册已落盘、客户端在提升本地
    // 配置前崩溃、带同一份 pending 密钥重来;放行让它落配置,否则永卡 not_first)。
    let mut c = connect(addr).await;
    c.register_first(ACCT, D1, &sk).await;
    assert_eq!(c.recv().await, ServerMsg::Authed);
    // 同设备**异钥**抢首台 = not_first(不放行冒名者顶替真身)。
    let mut c1b = connect(addr).await;
    c1b.register_first(ACCT, D1, &key()).await;
    expect_err(c1b.recv().await, err_code::NOT_FIRST);
    // 真第二台设备(异 device_id)抢首台也 not_first(走配对加入)。
    let mut c2 = connect(addr).await;
    c2.register_first(ACCT, D2, &key()).await;
    expect_err(c2.recv().await, err_code::NOT_FIRST);
}

#[tokio::test]
async fn tofu_concurrent_exactly_one_winner() {
    // §4 评审①-M4:并发双首台恰一胜,败者响亮收错。
    let addr = start(&[], |_| {}).await;
    let race = |device: &'static str| async move {
        let sk = key();
        let mut c = connect(addr).await;
        c.register_first(ACCT, device, &sk).await;
        c.recv().await
    };
    let (a, b) = tokio::join!(race(D1), race(D2));
    let authed_count = [&a, &b].iter().filter(|m| ***m == ServerMsg::Authed).count();
    assert_eq!(authed_count, 1, "恰一胜:{a:?} / {b:?}");
    let loser = if a == ServerMsg::Authed { b } else { a };
    expect_err(loser, err_code::NOT_FIRST);
}

#[tokio::test]
async fn device_id_globally_unique() {
    // §4 全局唯一守护:device_id 已在任何账户 → 拒(整库拷贝复用身份),
    // register_first 与 register_device 两条注册路都拦。
    let addr = start(&[], |_| {}).await;
    first_authed(addr, ACCT, D1, &key()).await;
    let mut c = connect(addr).await;
    c.register_first(ACCT2, D1, &key()).await;
    expect_err(c.recv().await, err_code::DEVICE_ID_TAKEN);
    // ACCT2 的首台想背书注册已属 ACCT 的 D1 → 拒。
    let sk_x = key();
    let mut old2 = first_authed(addr, ACCT2, DX, &sk_x).await;
    let pk = key().verifying_key().to_bytes().to_vec();
    let sig = sk_x.sign(&register_device_sig_payload(ACCT2, D1, &pk)).to_bytes().to_vec();
    old2.send(&ClientMsg::RegisterDevice {
        account: ACCT2.into(),
        new_device: D1.into(),
        new_pubkey: pk,
        sig_by_old: sig,
    })
    .await;
    expect_err(old2.recv().await, err_code::DEVICE_ID_TAKEN);
}

#[tokio::test]
async fn register_device_rejects_invalid_curve_point() {
    // codex P2-e M3:垃圾 32B 不入库(否则该 device_id 被永久烧掉)。
    let addr = start(&[], |_| {}).await;
    let sk1 = key();
    let mut old = first_authed(addr, ACCT, D1, &sk1).await;
    // 找一个确实不可解压的 32B(约半数 y 坐标不在曲线上)。
    let junk: Vec<u8> = (0u8..=255)
        .map(|b| vec![b; 32])
        .find(|v| {
            let arr: [u8; 32] = v.as_slice().try_into().unwrap();
            ed25519_dalek::VerifyingKey::from_bytes(&arr).is_err()
        })
        .expect("256 个候选里总有非法点");
    let sig = sk1.sign(&register_device_sig_payload(ACCT, D2, &junk)).to_bytes().to_vec();
    old.send(&ClientMsg::RegisterDevice {
        account: ACCT.into(),
        new_device: D2.into(),
        new_pubkey: junk,
        sig_by_old: sig,
    })
    .await;
    expect_err(old.recv().await, err_code::BAD_REQUEST);
    // device_id 没被烧:换合法公钥立刻能注册。
    let sk2 = key();
    let pk2 = sk2.verifying_key().to_bytes().to_vec();
    let sig2 = sk1.sign(&register_device_sig_payload(ACCT, D2, &pk2)).to_bytes().to_vec();
    old.send(&ClientMsg::RegisterDevice {
        account: ACCT.into(),
        new_device: D2.into(),
        new_pubkey: pk2,
        sig_by_old: sig2,
    })
    .await;
    assert_eq!(old.recv().await, ServerMsg::Registered { device: D2.into() });
}

#[tokio::test]
async fn register_device_endorsement() {
    let addr = start(&[], |_| {}).await;
    let sk1 = key();
    let mut old = first_authed(addr, ACCT, D1, &sk1).await;
    let sk2 = key();
    let pub2 = sk2.verifying_key().to_bytes().to_vec();
    // 坏背书(新钥自签,不是老设备签)→ auth_failed,连接留着。
    let bad = sk2.sign(&register_device_sig_payload(ACCT, D2, &pub2)).to_bytes().to_vec();
    old.send(&ClientMsg::RegisterDevice {
        account: ACCT.into(),
        new_device: D2.into(),
        new_pubkey: pub2.clone(),
        sig_by_old: bad,
    })
    .await;
    expect_err(old.recv().await, err_code::AUTH_FAILED);
    // 新设备此刻仍不能 auth。
    let mut probe = connect(addr).await;
    probe.auth(ACCT, D2, &sk2).await;
    expect_err(probe.recv().await, err_code::AUTH_FAILED);
    // 正确背书 → Registered;新设备 auth 通;幂等重发仍 Registered。
    let good = sk1.sign(&register_device_sig_payload(ACCT, D2, &pub2)).to_bytes().to_vec();
    let reg = ClientMsg::RegisterDevice {
        account: ACCT.into(),
        new_device: D2.into(),
        new_pubkey: pub2.clone(),
        sig_by_old: good,
    };
    old.send(&reg).await;
    assert_eq!(old.recv().await, ServerMsg::Registered { device: D2.into() });
    authed(addr, ACCT, D2, &sk2).await;
    old.send(&reg).await;
    assert_eq!(old.recv_skip_peer().await, ServerMsg::Registered { device: D2.into() });
    // 老设备给别的账户背书 → bad_request 断开(account 与鉴权身份不符)。
    let mut old2 = authed(addr, ACCT, D1, &sk1).await;
    old2.send(&ClientMsg::RegisterDevice {
        account: ACCT2.into(),
        new_device: D3.into(),
        new_pubkey: pub2.clone(),
        sig_by_old: sk1.sign(&register_device_sig_payload(ACCT2, D3, &pub2)).to_bytes().to_vec(),
    })
    .await;
    expect_err(old2.recv_skip_peer().await, err_code::BAD_REQUEST);
    old2.expect_close().await;
}

// ---- 路由与信箱 ----

/// 起一个三设备账户(D1/D2/D3 已注册),返回各自密钥。免费档只有 2 席(工序 2
/// 席位闸),先经 admin 给 ACCT 提额——与生产 runbook 同语义(多设备账户=显式
/// 授权),本组测试的对象是路由/信箱,不是席位闸(闸有专测)。
async fn three_devices(addr: SocketAddr, admin: SocketAddr) -> (SigningKey, SigningKey, SigningKey) {
    let (sk1, sk2, sk3) = (key(), key(), key());
    let mut c1 = first_authed(addr, ACCT, D1, &sk1).await;
    let (code, body) = http(
        admin,
        "POST",
        &format!("/admin/entitlement?account={ACCT}&tier=test&seat_quota=8&fastlane_bytes_per_month=1000000000"),
        Some(TOKEN),
    )
    .await;
    assert_eq!(code, 200, "提额失败:{body}");
    for (dev, sk) in [(D2, &sk2), (D3, &sk3)] {
        let pubkey = sk.verifying_key().to_bytes().to_vec();
        let sig = sk1.sign(&register_device_sig_payload(ACCT, dev, &pubkey)).to_bytes().to_vec();
        c1.send(&ClientMsg::RegisterDevice {
            account: ACCT.into(),
            new_device: dev.into(),
            new_pubkey: pubkey,
            sig_by_old: sig,
        })
        .await;
        assert_eq!(c1.recv().await, ServerMsg::Registered { device: dev.into() });
    }
    (sk1, sk2, sk3)
}

fn send(n: u64, to: &str, lane: Lane, blob: &[u8]) -> ClientMsg {
    ClientMsg::Send { n, to: to.into(), lane, blob: blob.to_vec() }
}

fn deliver(from: &str, to: &str, blob: &[u8]) -> ServerMsg {
    ServerMsg::Deliver { from: from.into(), to: to.into(), blob: blob.to_vec() }
}

#[tokio::test]
async fn fanout_broadcast_and_named() {
    let (addr, admin) = start_with_admin(&[]).await;
    let (sk1, sk2, sk3) = three_devices(addr, admin).await;
    let mut c1 = authed(addr, ACCT, D1, &sk1).await;
    let mut c2 = authed(addr, ACCT, D2, &sk2).await;
    let mut c3 = authed(addr, ACCT, D3, &sk3).await;
    // 广播:除自己外全部;deliver 回显 from 与原 to(收端重构 AAD,§2)。
    c1.send(&send(1, BROADCAST, Lane::Mail, b"all")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 1 });
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, BROADCAST, b"all"));
    assert_eq!(c3.recv_skip_peer().await, deliver(D1, BROADCAST, b"all"));
    // 指名单投:D2 收 to=D2;D3 不收(下一帧广播先到即证)。
    c1.send(&send(2, D2, Lane::Mail, b"only2")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 2 });
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"only2"));
    c1.send(&send(3, BROADCAST, Lane::Mail, b"again")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 3 });
    assert_eq!(c3.recv_skip_peer().await, deliver(D1, BROADCAST, b"again"), "指名帧漏给了 D3");
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, BROADCAST, b"again"));
}

#[tokio::test]
async fn nack_unknown_device_and_self() {
    let addr = start(&[], |_| {}).await;
    let sk1 = key();
    let mut c1 = first_authed(addr, ACCT, D1, &sk1).await;
    // 未注册收件人(合法 ULID)/ 自己 / 非法形态 → Nack{unknown_device},不断开。
    c1.send(&send(1, DX, Lane::Mail, b"x")).await;
    assert_eq!(c1.recv().await, ServerMsg::Nack { n: 1, code: err_code::UNKNOWN_DEVICE.into() });
    c1.send(&send(2, D1, Lane::Mail, b"x")).await;
    assert_eq!(c1.recv().await, ServerMsg::Nack { n: 2, code: err_code::UNKNOWN_DEVICE.into() });
    c1.send(&send(3, "not-a-ulid", Lane::Mail, b"x")).await;
    assert_eq!(c1.recv().await, ServerMsg::Nack { n: 3, code: err_code::UNKNOWN_DEVICE.into() });
    // 单设备账户广播 = 服务器接手、没人收,Ack 照回。
    c1.send(&send(4, BROADCAST, Lane::Mail, b"void")).await;
    assert_eq!(c1.recv().await, ServerMsg::Ack { n: 4 });
}

#[tokio::test]
async fn mailbox_offline_drain_ordered_then_realtime() {
    let (addr, admin) = start_with_admin(&[]).await;
    let (sk1, sk2, _) = three_devices(addr, admin).await;
    let mut c1 = authed(addr, ACCT, D1, &sk1).await;
    // D2 从未上线,mail 入箱;按序收割;之后实时接力(信箱与实时同队,§4)。
    for (n, blob) in [(1u64, b"a"), (2, b"b"), (3, b"c")] {
        c1.send(&send(n, D2, Lane::Mail, blob)).await;
        assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n });
    }
    let mut c2 = authed(addr, ACCT, D2, &sk2).await;
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"a"));
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"b"));
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"c"));
    c1.send(&send(4, D2, Lane::Mail, b"live")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 4 });
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"live"));
}

#[tokio::test]
async fn mailbox_overflow_drops_oldest_by_frames() {
    let (addr, admin) = start_with_admin_cfg(&[], |c| c.mailbox_max_frames = 3).await;
    let (sk1, sk2, _) = three_devices(addr, admin).await;
    let mut c1 = authed(addr, ACCT, D1, &sk1).await;
    for n in 1u64..=5 {
        c1.send(&send(n, D2, Lane::Mail, format!("m{n}").as_bytes())).await;
        assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n });
    }
    // 溢出丢最老:只剩 3、4、5。
    let mut c2 = authed(addr, ACCT, D2, &sk2).await;
    for n in 3u64..=5 {
        assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, format!("m{n}").as_bytes()));
    }
    // 紧跟哨兵证明前面没有残帧。
    c1.send(&send(9, D2, Lane::Mail, b"fence")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 9 });
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"fence"));
}

#[tokio::test]
async fn mailbox_overflow_drops_oldest_by_bytes() {
    let (addr, admin) = start_with_admin_cfg(&[], |c| c.mailbox_max_bytes = 100).await;
    let (sk1, sk2, _) = three_devices(addr, admin).await;
    let mut c1 = authed(addr, ACCT, D1, &sk1).await;
    // 三帧各 60B:每次超 100B 丢最老,只剩最后一帧。
    for n in 1u64..=3 {
        let blob = vec![n as u8; 60];
        c1.send(&send(n, D2, Lane::Mail, &blob)).await;
        assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n });
    }
    let mut c2 = authed(addr, ACCT, D2, &sk2).await;
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, &[3u8; 60]));
    c1.send(&send(9, D2, Lane::Mail, b"fence")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 9 });
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"fence"));
}

#[tokio::test]
async fn mailbox_ttl_expires() {
    let (addr, admin) = start_with_admin_cfg(&[], |c| {
        c.mailbox_ttl = Duration::from_millis(200);
        // 清扫间隔放大,专测惰性路径(attach 收割时过滤)。
        c.sweep_interval = Duration::from_secs(3600);
    })
    .await;
    let (sk1, sk2, _) = three_devices(addr, admin).await;
    let mut c1 = authed(addr, ACCT, D1, &sk1).await;
    c1.send(&send(1, D2, Lane::Mail, b"stale")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 1 });
    tokio::time::sleep(Duration::from_millis(450)).await;
    // 过期帧不投;哨兵是上线后第一帧。
    c1.send(&send(2, D2, Lane::Mail, b"fresh")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 2 });
    let mut c2 = authed(addr, ACCT, D2, &sk2).await;
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"fresh"));
}

#[tokio::test]
async fn direct_only_online() {
    let (addr, admin) = start_with_admin(&[]).await;
    let (sk1, sk2, sk3) = three_devices(addr, admin).await;
    let mut c1 = authed(addr, ACCT, D1, &sk1).await;
    // 指名离线 → Nack{not_online}。
    c1.send(&send(1, D2, Lane::Direct, b"x")).await;
    assert_eq!(c1.recv().await, ServerMsg::Nack { n: 1, code: err_code::NOT_ONLINE.into() });
    // 广播 direct:在线的收,离线的静默跳过、不入箱。
    let mut c3 = authed(addr, ACCT, D3, &sk3).await;
    c1.send(&send(2, BROADCAST, Lane::Direct, b"boot")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 2 });
    assert_eq!(c3.recv_skip_peer().await, deliver(D1, BROADCAST, b"boot"));
    // D2 上线:第一帧是 mail 哨兵,direct 没入箱。
    c1.send(&send(3, D2, Lane::Mail, b"fence")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 3 });
    let mut c2 = authed(addr, ACCT, D2, &sk2).await;
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"fence"));
    // 在线后指名 direct 通。
    c1.send(&send(4, D2, Lane::Direct, b"pull")).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Ack { n: 4 });
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"pull"));
}

#[tokio::test]
async fn peer_presence_snapshot_and_events() {
    let (addr, admin) = start_with_admin(&[]).await;
    let (sk1, sk2, _) = three_devices(addr, admin).await;
    let mut c1 = authed(addr, ACCT, D1, &sk1).await;
    let mut c2 = authed(addr, ACCT, D2, &sk2).await;
    // 后上线者收在线快照;先上线者收上线事件。
    assert_eq!(c2.recv().await, ServerMsg::Peer { device: D1.into(), online: true });
    assert_eq!(c1.recv().await, ServerMsg::Peer { device: D2.into(), online: true });
    // 断开 → 下线事件。
    drop(c2);
    assert_eq!(c1.recv().await, ServerMsg::Peer { device: D2.into(), online: false });
}

#[tokio::test]
async fn kick_old_connection_on_reconnect() {
    let addr = start(&[], |_| {}).await;
    let sk1 = key();
    let mut old = first_authed(addr, ACCT, D1, &sk1).await;
    let mut new = authed(addr, ACCT, D1, &sk1).await;
    // 旧连接被顶替关闭;新连接正常收发。
    old.expect_close().await;
    new.send(&ClientMsg::Ping).await;
    assert_eq!(new.recv().await, ServerMsg::Pong);
}

// ---- 配对盲桥 ----

#[tokio::test]
async fn pairing_bridge_relay_and_single_use() {
    let addr = start(&[], |_| {}).await;
    let sk1 = key();
    let mut owner = first_authed(addr, ACCT, D1, &sk1).await;
    owner.send(&ClientMsg::PairOpen).await;
    let ServerMsg::PairSlot { slot } = owner.recv().await else { panic!("没拿到槽") };
    // 未鉴权连接入槽;双向盲传。
    let mut joiner = connect(addr).await;
    joiner.send(&ClientMsg::PairJoin { slot }).await;
    assert_eq!(owner.recv().await, ServerMsg::PairPeer { event: PairEvent::Joined });
    joiner.send(&ClientMsg::PairMsg { slot, blob: b"spake2-a".to_vec() }).await;
    assert_eq!(owner.recv().await, ServerMsg::PairMsg { slot, blob: b"spake2-a".to_vec() });
    owner.send(&ClientMsg::PairMsg { slot, blob: b"spake2-b".to_vec() }).await;
    assert_eq!(joiner.recv().await, ServerMsg::PairMsg { slot, blob: b"spake2-b".to_vec() });
    // 单次使用:第二个 join 恒拒并断开(在线猜测恒只有一次)。
    let mut second = connect(addr).await;
    second.send(&ClientMsg::PairJoin { slot }).await;
    expect_err(second.recv().await, err_code::BAD_SLOT);
    second.expect_close().await;
    // 发起端主动关槽(密钥确认失败路径):对端收 Closed,槽烧毁。
    owner.send(&ClientMsg::PairClose { slot }).await;
    assert_eq!(joiner.recv().await, ServerMsg::PairPeer { event: PairEvent::Closed });
    let mut third = connect(addr).await;
    third.send(&ClientMsg::PairJoin { slot }).await;
    expect_err(third.recv().await, err_code::BAD_SLOT);
    // joiner 在烧毁的槽上再发 = 断开。
    joiner.send(&ClientMsg::PairMsg { slot, blob: b"late".to_vec() }).await;
    expect_err(joiner.recv().await, err_code::BAD_SLOT);
    joiner.expect_close().await;
}

#[tokio::test]
async fn pairing_owner_disconnect_burns_slot() {
    let addr = start(&[], |_| {}).await;
    let sk1 = key();
    let mut owner = first_authed(addr, ACCT, D1, &sk1).await;
    owner.send(&ClientMsg::PairOpen).await;
    let ServerMsg::PairSlot { slot } = owner.recv().await else { panic!() };
    let mut joiner = connect(addr).await;
    joiner.send(&ClientMsg::PairJoin { slot }).await;
    // 等发起端确认 join 落地再断开(否则和 join 赛跑,槽在 join 前就烧了)。
    assert_eq!(owner.recv().await, ServerMsg::PairPeer { event: PairEvent::Joined });
    drop(owner);
    assert_eq!(joiner.recv().await, ServerMsg::PairPeer { event: PairEvent::Left });
}

#[tokio::test]
async fn pairing_slot_ttl() {
    let addr = start(&[], |c| {
        c.pair_slot_ttl = Duration::from_millis(200);
        c.sweep_interval = Duration::from_secs(3600); // 专测 join 时的惰性过期
    })
    .await;
    let sk1 = key();
    let mut owner = first_authed(addr, ACCT, D1, &sk1).await;
    owner.send(&ClientMsg::PairOpen).await;
    let ServerMsg::PairSlot { slot } = owner.recv().await else { panic!() };
    tokio::time::sleep(Duration::from_millis(450)).await;
    let mut late = connect(addr).await;
    late.send(&ClientMsg::PairJoin { slot }).await;
    expect_err(late.recv().await, err_code::BAD_SLOT);
}

/// Authed 面对已死槽的 PairClose 幂等静默(多空间工序 7/8 二审 M1):PairClose 是
/// 「确保槽不在」的意图,槽已死 = 达成,不回 bad_slot——那枚无 slot 归属的迟到错误
/// 会被客户端误归给刚开的新配对、无辜烧掉新槽。断言:无 Err 回复、连接照常活着、
/// 紧接着开新槽照常成功。
#[tokio::test]
async fn pair_close_on_dead_slot_is_idempotent_silence() {
    let addr = start(&[], |_| {}).await;
    let sk1 = key();
    let mut owner = first_authed(addr, ACCT, D1, &sk1).await;
    owner.send(&ClientMsg::PairClose { slot: 424_242 }).await; // 从未存在的槽
    owner.send(&ClientMsg::Ping).await;
    assert_eq!(owner.recv().await, ServerMsg::Pong, "PairClose 死槽必须静默,不回错");
    owner.send(&ClientMsg::PairOpen).await;
    let ServerMsg::PairSlot { slot } = owner.recv().await else { panic!("新槽照常开") };
    // 真开过的槽关两次:第二次同样静默。
    owner.send(&ClientMsg::PairClose { slot }).await;
    owner.send(&ClientMsg::PairClose { slot }).await;
    owner.send(&ClientMsg::Ping).await;
    assert_eq!(owner.recv().await, ServerMsg::Pong);
}

#[tokio::test]
async fn pair_reopen_burns_previous_slot() {
    let addr = start(&[], |_| {}).await;
    let sk1 = key();
    let mut owner = first_authed(addr, ACCT, D1, &sk1).await;
    owner.send(&ClientMsg::PairOpen).await;
    let ServerMsg::PairSlot { slot: s1 } = owner.recv().await else { panic!() };
    owner.send(&ClientMsg::PairOpen).await;
    let ServerMsg::PairSlot { slot: s2 } = owner.recv().await else { panic!() };
    assert_ne!(s1, s2);
    let mut j = connect(addr).await;
    j.send(&ClientMsg::PairJoin { slot: s1 }).await;
    expect_err(j.recv().await, err_code::BAD_SLOT);
    let mut j2 = connect(addr).await;
    j2.send(&ClientMsg::PairJoin { slot: s2 }).await;
    assert_eq!(owner.recv().await, ServerMsg::PairPeer { event: PairEvent::Joined });
}

// ---- 连接卫生 ----

#[tokio::test]
async fn frame_too_large_disconnects() {
    let addr = start(&[], |_| {}).await;
    let sk1 = key();
    let mut c = first_authed(addr, ACCT, D1, &sk1).await;
    let huge = vec![0u8; sync_proto::MAX_FRAME_BYTES + 1024];
    let _ = c.ws.send(WsMsg::Binary(huge.into())).await;
    c.expect_close().await;
}

#[tokio::test]
async fn text_frame_rejected() {
    let addr = start(&[], |_| {}).await;
    let mut c = connect(addr).await;
    c.ws.send(WsMsg::Text("hello".into())).await.unwrap();
    expect_err(c.recv().await, err_code::BAD_REQUEST);
    c.expect_close().await;
}

#[tokio::test]
async fn undecodable_envelope_rejected() {
    let addr = start(&[], |_| {}).await;
    let mut c = connect(addr).await;
    c.ws.send(WsMsg::Binary(b"garbage".to_vec().into())).await.unwrap();
    expect_err(c.recv().await, err_code::BAD_REQUEST);
    c.expect_close().await;
}

#[tokio::test]
async fn unauth_business_rejected() {
    let addr = start(&[], |_| {}).await;
    // Fresh 发 Send = 越权断开。
    let mut c = connect(addr).await;
    c.send(&send(1, BROADCAST, Lane::Mail, b"x")).await;
    expect_err(c.recv().await, err_code::BAD_REQUEST);
    c.expect_close().await;
    // Fresh 发 PairOpen 同样。
    let mut c = connect(addr).await;
    c.send(&ClientMsg::PairOpen).await;
    expect_err(c.recv().await, err_code::BAD_REQUEST);
    c.expect_close().await;
    // authed 后重复鉴权 = 越权断开。
    let sk = key();
    let mut c = first_authed(addr, ACCT, D1, &sk).await;
    c.auth(ACCT, D1, &sk).await;
    expect_err(c.recv().await, err_code::BAD_REQUEST);
    c.expect_close().await;
}

#[tokio::test]
async fn silence_timeout_kills_and_ping_keeps_alive() {
    let addr = start(&[], |c| c.silence_timeout = Duration::from_millis(300)).await;
    let sk = key();
    // 静默连接被判死。
    let mut idle = first_authed(addr, ACCT, D1, &sk).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    idle.expect_close().await;
    // 协议 Ping 保活:间隔 150ms × 4 次仍活着。
    let mut live = authed(addr, ACCT, D1, &sk).await;
    for _ in 0..4 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        live.send(&ClientMsg::Ping).await;
        assert_eq!(live.recv().await, ServerMsg::Pong);
    }
}

// ---- registry 持久化贯通 ----

#[tokio::test]
async fn registry_survives_restart_mailbox_does_not() {
    // §4:registry 落盘、信箱重启即失。
    static DIR: AtomicU32 = AtomicU32::new(0);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "zhujian-syncd-it-restart-{}-{}",
        std::process::id(),
        DIR.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("banlist.txt"), "# 空封禁表
").unwrap();
    let cfg = Config::new(dir.join("banlist.txt"), dir.join("registry.json"));

    let (addr, admin, handle) = zhujian_syncd::serve_with_admin(
        "127.0.0.1:0".parse().unwrap(),
        "127.0.0.1:0".parse().unwrap(),
        TOKEN.into(),
        cfg.clone(),
    )
    .await
    .unwrap();
    let (sk1, sk2, _) = three_devices(addr, admin).await;
    let mut c1 = authed(addr, ACCT, D1, &sk1).await;
    c1.send(&send(1, D2, Lane::Mail, b"lost-on-restart")).await;
    assert_eq!(c1.recv().await, ServerMsg::Ack { n: 1 });
    drop(c1);
    handle.abort();
    let _ = handle.await;

    // 重启(同 registry 文件、新端口):设备还在(免注册直接 auth,entitlement
    // 同文件持久、三设备账户重启后照常),信箱空了。
    let (addr2, _h2) = serve("127.0.0.1:0".parse().unwrap(), cfg).await.unwrap();
    let mut c1 = authed(addr2, ACCT, D1, &sk1).await;
    c1.send(&send(2, D2, Lane::Mail, b"after-restart")).await;
    assert_eq!(c1.recv().await, ServerMsg::Ack { n: 2 });
    let mut c2 = authed(addr2, ACCT, D2, &sk2).await;
    assert_eq!(c2.recv_skip_peer().await, deliver(D1, D2, b"after-restart"));
}

// ---- H1 admin 面:单设备吊销(android-plan §8) ----

/// admin bearer token(≥32 字符门槛;生产用 openssl rand -hex 32)。
const TOKEN: &str = "test-admin-token-0123456789abcdef0123456789abcdef";

/// 起带 admin 面的测试服务(两个监听都随机端口),返回 (同步地址, admin 地址)。
async fn start_with_admin(banned: &[&str]) -> (SocketAddr, SocketAddr) {
    start_with_admin_cfg(banned, |_| {}).await
}

/// 同上,可调配置(路由/信箱组测试要 three_devices 提额,必须有 admin 面)。
async fn start_with_admin_cfg(
    banned: &[&str],
    tweak: impl FnOnce(&mut Config),
) -> (SocketAddr, SocketAddr) {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "zhujian-syncd-it-admin-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("banlist.txt"), format!("# 封禁表
{}
", banned.join("
"))).unwrap();
    let mut cfg = Config::new(dir.join("banlist.txt"), dir.join("registry.json"));
    tweak(&mut cfg);
    let (addr, admin, _handle) = zhujian_syncd::serve_with_admin(
        "127.0.0.1:0".parse().unwrap(),
        "127.0.0.1:0".parse().unwrap(),
        TOKEN.into(),
        cfg,
    )
    .await
    .unwrap();
    (addr, admin)
}

/// 裸 HTTP/1.1 单发(admin 面测试用,免引 HTTP 客户端依赖)。token=None 模拟漏带。
async fn http(
    addr: SocketAddr,
    method: &str,
    path_q: &str,
    token: Option<&str>,
) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = TcpStream::connect(addr).await.unwrap();
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    s.write_all(
        format!("{method} {path_q} HTTP/1.1\r\nHost: {addr}\r\n{auth}Content-Length: 0\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .await
    .unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).await.unwrap();
    let status: u16 = buf.split_whitespace().nth(1).expect("状态行").parse().expect("状态码");
    let body = buf.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}

/// H1 端到端:两台在线 → HTTP 吊销手机 → 被 kick 断连 → 重连鉴权即拒;
/// 幸存桌面不断线照常收发;admin 各错误码;devices 列表前后一致。
#[tokio::test]
async fn admin_revoke_device_end_to_end() {
    let (addr, admin) = start_with_admin(&[]).await;
    let sk1 = key();
    let mut c1 = first_authed(addr, ACCT, D1, &sk1).await;
    // 背书注册 D2(「手机」)并上线。
    let sk2 = key();
    let pub2 = sk2.verifying_key().to_bytes().to_vec();
    let good = sk1.sign(&register_device_sig_payload(ACCT, D2, &pub2)).to_bytes().to_vec();
    c1.send(&ClientMsg::RegisterDevice {
        account: ACCT.into(),
        new_device: D2.into(),
        new_pubkey: pub2,
        sig_by_old: good,
    })
    .await;
    assert_eq!(c1.recv().await, ServerMsg::Registered { device: D2.into() });
    let mut c2 = authed(addr, ACCT, D2, &sk2).await;
    // 吊销前:devices 列两台。
    let (code, body) = http(admin, "GET", &format!("/admin/devices?account={ACCT}"), Some(TOKEN)).await;
    assert_eq!(code, 200);
    assert!(body.contains(D1) && body.contains(D2), "{body}");
    // 吊销 D2:200;在线连接被 kick;幸存的 D1 收到 offline 广播。
    let (code, body) = http(admin, "POST", &format!("/admin/revoke?account={ACCT}&device={D2}"), Some(TOKEN)).await;
    assert_eq!(code, 200, "{body}");
    c2.expect_close().await;
    assert_eq!(c1.recv().await, ServerMsg::Peer { device: D2.into(), online: true });
    assert_eq!(c1.recv().await, ServerMsg::Peer { device: D2.into(), online: false });
    // 被吊设备重连鉴权即拒(私钥仍在手也没用:registry 绑定已删)。
    let mut back = connect(addr).await;
    back.auth(ACCT, D2, &sk2).await;
    expect_err(back.recv().await, err_code::AUTH_FAILED);
    back.expect_close().await;
    // 吊销后:devices 只剩 D1;幸存设备照常收发(未被牵连)。
    let (code, body) = http(admin, "GET", &format!("/admin/devices?account={ACCT}"), Some(TOKEN)).await;
    assert_eq!(code, 200);
    assert!(body.contains(D1) && !body.contains(D2), "{body}");
    c1.send(&send(1, BROADCAST, Lane::Mail, b"still-alive")).await;
    assert_eq!(c1.recv().await, ServerMsg::Ack { n: 1 });
    // 错误码:重复吊(device 已不在)= 404,account 与属主不符 = 409 零副作用,
    // 缺 device = 400。
    let (code, _) = http(admin, "POST", &format!("/admin/revoke?account={ACCT}&device={D2}"), Some(TOKEN)).await;
    assert_eq!(code, 404);
    let (code, _) = http(admin, "POST", &format!("/admin/revoke?account={ACCT2}&device={D1}"), Some(TOKEN)).await;
    assert_eq!(code, 409, "device 在、account 不符 = OwnerMismatch,不许静默吊错账户");
    let (code, _) = http(admin, "POST", &format!("/admin/revoke?account={ACCT}"), Some(TOKEN)).await;
    assert_eq!(code, 400);
    // 鉴权:漏带/带错 token 一律 401,且不产生任何吊销副作用(D1 仍在)。
    let (code, _) = http(admin, "POST", &format!("/admin/revoke?account={ACCT}&device={D1}"), None).await;
    assert_eq!(code, 401);
    let (code, _) =
        http(admin, "POST", &format!("/admin/revoke?account={ACCT}&device={D1}"), Some("wrong-token-wrong-token-wrong-token")).await;
    assert_eq!(code, 401);
    let (code, _) = http(admin, "GET", &format!("/admin/devices?account={ACCT}"), None).await;
    assert_eq!(code, 401);
    let (code, body) = http(admin, "GET", &format!("/admin/devices?account={ACCT}"), Some(TOKEN)).await;
    assert_eq!(code, 200);
    assert!(body.contains(D1), "401 的请求不许有副作用:{body}");
}

/// #1 硬化端到端:吊光账户唯一设备 → admin 回执带「封存」字样(200)→ 账户变空墓碑,
/// 同设备(私钥仍在手)重连 RegisterFirst 与 Auth 双双 auth_failed 断开、连全新
/// device_id 也进不来(空墓碑非「从未初始化」)。堵死「被吊单设备自助重 TOFU 满血回」。
#[tokio::test]
async fn admin_revoke_last_device_seals_account() {
    let (addr, admin) = start_with_admin(&[]).await;
    let sk1 = key();
    // 单设备账户:D1 在线(确定性证明「最后一台 + 在线 + 封存 + kick」四项同场)。
    let mut d1 = first_authed(addr, ACCT, D1, &sk1).await;
    // 吊 D1(账户唯一设备)→ 200,回执含「封存」(AccountSealed 分支的如实告知)。
    let (code, body) =
        http(admin, "POST", &format!("/admin/revoke?account={ACCT}&device={D1}"), Some(TOKEN)).await;
    assert_eq!(code, 200, "{body}");
    assert!(body.contains("封存"), "最后一台吊销应回归零封存提示:{body}");
    // 在线的最后一台被 kick 断连(不变量 12 的在线回归锚)。
    d1.expect_close().await;
    // devices 现为空。
    let (code, body) = http(admin, "GET", &format!("/admin/devices?account={ACCT}"), Some(TOKEN)).await;
    assert_eq!(code, 200);
    assert!(!body.contains(D1), "{body}");
    // #1 红线:同设备(私钥仍在手)RegisterFirst 重来 = auth_failed 断开(空墓碑封存)。
    let mut back = connect(addr).await;
    back.register_first(ACCT, D1, &sk1).await;
    expect_err(back.recv().await, err_code::AUTH_FAILED);
    back.expect_close().await;
    // Auth 同样拒(registry 绑定已删)。
    let mut back2 = connect(addr).await;
    back2.auth(ACCT, D1, &sk1).await;
    expect_err(back2.recv().await, err_code::AUTH_FAILED);
    back2.expect_close().await;
    // 连全新 device_id 也不行:账户已封存 ≠ 从未初始化的 fresh,不许自助重开。
    let mut fresh_dev = connect(addr).await;
    fresh_dev.register_first(ACCT, D2, &key()).await;
    expect_err(fresh_dev.recv().await, err_code::AUTH_FAILED);
    fresh_dev.expect_close().await;
}

/// open-signup §1.5 端到端:无感创号后孤儿只有 device_id 可报——device-only
/// 吊销(服务器同锁反查属主、回执带解析出的账户)、account 不符 409 零副作用、
/// 未知 device 404。这是「创号半途崩溃 → 报 device_id → 运营者吊销 → 原库重试」
/// 恢复链路的服务器半边。
#[tokio::test]
async fn admin_revoke_by_device_only() {
    let (addr, admin) = start_with_admin(&[]).await;
    let sk1 = key();
    let _d1 = first_authed(addr, ACCT, D1, &sk1).await;
    // account 与属主不符:409,零副作用(D1 仍在)。
    let (code, _) =
        http(admin, "POST", &format!("/admin/revoke?account={ACCT2}&device={D1}"), Some(TOKEN)).await;
    assert_eq!(code, 409);
    let (code, body) = http(admin, "GET", &format!("/admin/devices?account={ACCT}"), Some(TOKEN)).await;
    assert_eq!(code, 200);
    assert!(body.contains(D1), "409 不许有副作用:{body}");
    // 未知 device:404。
    let (code, _) = http(admin, "POST", &format!("/admin/revoke?device={DX}"), Some(TOKEN)).await;
    assert_eq!(code, 404);
    // device-only:反查属主吊掉,回执带解析出的账户(孤儿恢复正路);
    // 这是账户唯一设备 → 封存如实告知。
    let (code, body) = http(admin, "POST", &format!("/admin/revoke?device={D1}"), Some(TOKEN)).await;
    assert_eq!(code, 200, "{body}");
    assert!(body.contains(ACCT), "回执带解析出的账户:{body}");
    assert!(body.contains("封存"), "最后一台 → 归零封存:{body}");
}

/// billing-plan §3 工序 1 端到端:授权参数纯元数据存取——未设置=免费档默认
/// (fail-closed)、POST 设置即时可查、错误码 400/404/401 各就位且失败零副作用。
/// 执行闸(席位/限速)是工序 2/3,此处刻意只验存取面。
#[tokio::test]
async fn admin_entitlement_set_and_query_end_to_end() {
    let (addr, admin) = start_with_admin(&[]).await;
    let sk1 = key();
    let _d1 = first_authed(addr, ACCT, D1, &sk1).await;
    // 未设置:configured=null,effective=免费档 2 席(fail-closed 默认)。
    let (code, body) =
        http(admin, "GET", &format!("/admin/entitlement?account={ACCT}"), Some(TOKEN)).await;
    assert_eq!(code, 200, "{body}");
    assert!(body.contains(r#""configured":null"#), "{body}");
    assert!(body.contains(r#""tier":"free""#) && body.contains(r#""seat_quota":2"#), "{body}");
    // 设置 personal 4 席 + 到期日:200 回显 effective。
    let (code, body) = http(
        admin,
        "POST",
        &format!("/admin/entitlement?account={ACCT}&tier=personal&seat_quota=4&fastlane_bytes_per_month=2147483648&expires_at=2027-07-19T00:00:00Z"),
        Some(TOKEN),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert!(body.contains(r#""tier":"personal""#), "{body}");
    assert!(body.contains("server_now"), "effective 须可对应时间快照:{body}");
    // 即时可查:configured 与 effective 都是新参数(不依赖 SIGHUP/重启)。
    let (code, body) =
        http(admin, "GET", &format!("/admin/entitlement?account={ACCT}"), Some(TOKEN)).await;
    assert_eq!(code, 200);
    assert!(
        body.contains(r#""seat_quota":4"#)
            && body.contains("2027-07-19T00:00:00Z")
            && !body.contains(r#""configured":null"#),
        "{body}"
    );
    // 未知账户 = 404(typo 防线:entitlement 只对已存在账户设)。
    let (code, _) = http(
        admin,
        "POST",
        &format!("/admin/entitlement?account={ACCT2}&tier=free&seat_quota=2&fastlane_bytes_per_month=1"),
        Some(TOKEN),
    )
    .await;
    assert_eq!(code, 404);
    // GET 未知账户 = 404(admin 已鉴权不需防探测;200+免费档会掩盖账号 typo)。
    let (code, _) =
        http(admin, "GET", &format!("/admin/entitlement?account={ACCT2}"), Some(TOKEN)).await;
    assert_eq!(code, 404);
    // 鉴权先于参数解析(admin Router 层 middleware,GET/POST 一体):无 token +
    // 坏数字 / 重复参数 = 401(不是 extractor 的 400)。
    let (code, _) = http(
        admin,
        "POST",
        &format!("/admin/entitlement?account={ACCT}&tier=free&seat_quota=abc&fastlane_bytes_per_month=1"),
        None,
    )
    .await;
    assert_eq!(code, 401, "解析必须在鉴权之后");
    let (code, _) = http(
        admin,
        "GET",
        &format!("/admin/entitlement?account={ACCT}&account={ACCT2}"),
        None,
    )
    .await;
    assert_eq!(code, 401, "GET 同样先鉴权再解析");
    // 坏 expires_at / 零席位 = 400;漏 token = 401;全部零副作用。
    let (code, _) = http(
        admin,
        "POST",
        &format!("/admin/entitlement?account={ACCT}&tier=free&seat_quota=2&fastlane_bytes_per_month=1&expires_at=not-a-date"),
        Some(TOKEN),
    )
    .await;
    assert_eq!(code, 400);
    let (code, _) = http(
        admin,
        "POST",
        &format!("/admin/entitlement?account={ACCT}&tier=free&seat_quota=0&fastlane_bytes_per_month=1"),
        Some(TOKEN),
    )
    .await;
    assert_eq!(code, 400);
    let (code, _) = http(
        admin,
        "POST",
        &format!("/admin/entitlement?account={ACCT}&tier=free&seat_quota=2&fastlane_bytes_per_month=1"),
        None,
    )
    .await;
    assert_eq!(code, 401);
    let (code, body) =
        http(admin, "GET", &format!("/admin/entitlement?account={ACCT}"), Some(TOKEN)).await;
    assert_eq!(code, 200);
    assert!(body.contains(r#""seat_quota":4"#), "失败路径不许有副作用:{body}");
}

/// admin 面的两道启动闸:非回环绑定拒(公网域名整站进反代,同端口挂 admin 即
/// 公开;经反代源地址恒 localhost,来源过滤形同虚设——物理分端口 + 拒非回环)、
/// 短 token 拒(≥32 字符,没钥匙不开门)。
#[tokio::test]
async fn admin_listen_rejects_non_loopback_and_short_token() {
    let dir = std::env::temp_dir().join(format!("zhujian-syncd-it-admin-guard-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("banlist.txt"), "# 空封禁表
").unwrap();
    let cfg = Config::new(dir.join("banlist.txt"), dir.join("registry.json"));
    let err = zhujian_syncd::serve_with_admin(
        "127.0.0.1:0".parse().unwrap(),
        "0.0.0.0:0".parse().unwrap(),
        TOKEN.into(),
        cfg.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    let err = zhujian_syncd::serve_with_admin(
        "127.0.0.1:0".parse().unwrap(),
        "127.0.0.1:0".parse().unwrap(),
        "short".into(),
        cfg,
    )
    .await
    .unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
}

// ---- 工序 2:两层席位闸 + 纪元席位租约(billing-plan §5) ----

/// 免费档 2 席端到端:第三台背书注册拒 seat_limit(连接留着);PairOpen 前置拒
/// 同码不断连;SeatLease 求租 → 同目标注册放行 → 消费即失(第四台仍拒);
/// 消费后同钥重放幂等 Registered(kick 丢回执的重试路);admin 提额即时生效。
#[tokio::test]
async fn seat_gate_and_lease_end_to_end() {
    let (addr, admin) = start_with_admin(&[]).await;
    let sk1 = key();
    let mut c1 = first_authed(addr, ACCT, D1, &sk1).await;
    // 背书注册 D2 → 免费档 2/2 满席。
    let sk2 = key();
    let pub2 = sk2.verifying_key().to_bytes().to_vec();
    let sig2 = sk1.sign(&register_device_sig_payload(ACCT, D2, &pub2)).to_bytes().to_vec();
    c1.send(&ClientMsg::RegisterDevice {
        account: ACCT.into(),
        new_device: D2.into(),
        new_pubkey: pub2,
        sig_by_old: sig2,
    })
    .await;
    assert_eq!(c1.recv().await, ServerMsg::Registered { device: D2.into() });
    // 第三台:商业层拒 seat_limit,连接不断。
    let sk3 = key();
    let pub3 = sk3.verifying_key().to_bytes().to_vec();
    let sig3 = sk1.sign(&register_device_sig_payload(ACCT, D3, &pub3)).to_bytes().to_vec();
    let reg3 = ClientMsg::RegisterDevice {
        account: ACCT.into(),
        new_device: D3.into(),
        new_pubkey: pub3.clone(),
        sig_by_old: sig3,
    };
    c1.send(&reg3).await;
    expect_err(c1.recv().await, err_code::SEAT_LIMIT);
    // PairOpen 前置拒:同码,业务错不断连。
    c1.send(&ClientMsg::PairOpen).await;
    expect_err(c1.recv().await, err_code::SEAT_LIMIT);
    // 求租(绑定 D3/pub3)→ 回执 → 同目标注册放行 → 新设备真能 auth。
    let lease_sig = sk1.sign(&seat_lease_sig_payload(ACCT, D3, &pub3)).to_bytes().to_vec();
    c1.send(&ClientMsg::SeatLease {
        account: ACCT.into(),
        new_device: D3.into(),
        new_pubkey: pub3.clone(),
        sig_by_old: lease_sig,
    })
    .await;
    assert_eq!(c1.recv().await, ServerMsg::SeatLease { device: D3.into() });
    c1.send(&reg3).await;
    assert_eq!(c1.recv().await, ServerMsg::Registered { device: D3.into() });
    authed(addr, ACCT, D3, &sk3).await;
    // 消费即失:第四台仍拒(3/2 超编,租约不可复用不可叠加)。
    let sk4 = key();
    let pub4 = sk4.verifying_key().to_bytes().to_vec();
    let sig4 = sk1.sign(&register_device_sig_payload(ACCT, DX, &pub4)).to_bytes().to_vec();
    let reg4 = ClientMsg::RegisterDevice {
        account: ACCT.into(),
        new_device: DX.into(),
        new_pubkey: pub4,
        sig_by_old: sig4,
    };
    c1.send(&reg4).await;
    expect_err(c1.recv_skip_peer().await, err_code::SEAT_LIMIT);
    // 幂等先于配额:超编态下 D3 同钥重注册仍 Registered(重试不被配额卡死)。
    c1.send(&reg3).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Registered { device: D3.into() });
    // admin 提额 4 席 → 第四台即时放行;4/4 又满,PairOpen 再拒(前置闸口径=当下)。
    let (code, body) = http(
        admin,
        "POST",
        &format!("/admin/entitlement?account={ACCT}&tier=personal&seat_quota=4&fastlane_bytes_per_month=1"),
        Some(TOKEN),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    c1.send(&reg4).await;
    assert_eq!(c1.recv_skip_peer().await, ServerMsg::Registered { device: DX.into() });
    c1.send(&ClientMsg::PairOpen).await;
    expect_err(c1.recv_skip_peer().await, err_code::SEAT_LIMIT);
}

/// 租约的边界与校验:硬帽处求租拒 account_full(绝不越硬帽);错签名 auth_failed
/// 不断开;Fresh 连接发 SeatLease = 越权断开;account 与鉴权身份不符 = 断开。
#[tokio::test]
async fn seat_lease_validation_and_hard_cap() {
    let (addr, _admin) = start_with_admin_cfg(&[], |c| c.device_cap = 2).await;
    let sk1 = key();
    let mut c1 = first_authed(addr, ACCT, D1, &sk1).await;
    let sk2 = key();
    let pub2 = sk2.verifying_key().to_bytes().to_vec();
    let sig2 = sk1.sign(&register_device_sig_payload(ACCT, D2, &pub2)).to_bytes().to_vec();
    c1.send(&ClientMsg::RegisterDevice {
        account: ACCT.into(),
        new_device: D2.into(),
        new_pubkey: pub2,
        sig_by_old: sig2,
    })
    .await;
    assert_eq!(c1.recv().await, ServerMsg::Registered { device: D2.into() });
    // 触硬帽(2/2)求租:account_full,连接留着。
    let sk3 = key();
    let pub3 = sk3.verifying_key().to_bytes().to_vec();
    let good_sig = sk1.sign(&seat_lease_sig_payload(ACCT, D3, &pub3)).to_bytes().to_vec();
    c1.send(&ClientMsg::SeatLease {
        account: ACCT.into(),
        new_device: D3.into(),
        new_pubkey: pub3.clone(),
        sig_by_old: good_sig,
    })
    .await;
    expect_err(c1.recv().await, err_code::ACCOUNT_FULL);
    // 错签名(新钥自签,不是 sponsor 签):auth_failed,连接留着。
    let bad_sig = sk3.sign(&seat_lease_sig_payload(ACCT, D3, &pub3)).to_bytes().to_vec();
    c1.send(&ClientMsg::SeatLease {
        account: ACCT.into(),
        new_device: D3.into(),
        new_pubkey: pub3.clone(),
        sig_by_old: bad_sig,
    })
    .await;
    expect_err(c1.recv().await, err_code::AUTH_FAILED);
    // account 与鉴权身份不符:bad_request 断开(与 RegisterDevice 同纪律)。
    let mis_sig = sk1.sign(&seat_lease_sig_payload(ACCT2, D3, &pub3)).to_bytes().to_vec();
    c1.send(&ClientMsg::SeatLease {
        account: ACCT2.into(),
        new_device: D3.into(),
        new_pubkey: pub3.clone(),
        sig_by_old: mis_sig,
    })
    .await;
    expect_err(c1.recv().await, err_code::BAD_REQUEST);
    c1.expect_close().await;
    // Fresh(未鉴权)连接发 SeatLease:越权断开。
    let mut f = connect(addr).await;
    let orphan_sig = sk1.sign(&seat_lease_sig_payload(ACCT, D3, &pub3)).to_bytes().to_vec();
    f.send(&ClientMsg::SeatLease {
        account: ACCT.into(),
        new_device: D3.into(),
        new_pubkey: pub3,
        sig_by_old: orphan_sig,
    })
    .await;
    expect_err(f.recv().await, err_code::BAD_REQUEST);
    f.expect_close().await;
}

/// 席位闸配置不变量启动断言(codex 160 L6):device_cap=0 / 租约 TTL=0 拒启。
#[tokio::test]
async fn serve_rejects_zero_device_cap_and_zero_lease_ttl() {
    let dir = std::env::temp_dir().join(format!("zhujian-syncd-it-cfg-guard-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("banlist.txt"), "# 空封禁表
").unwrap();
    let mut cfg = Config::new(dir.join("banlist.txt"), dir.join("registry.json"));
    cfg.device_cap = 0;
    let err = serve("127.0.0.1:0".parse().unwrap(), cfg.clone()).await.unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    cfg.device_cap = 8;
    cfg.seat_lease_ttl = Duration::ZERO;
    let err = serve("127.0.0.1:0".parse().unwrap(), cfg).await.unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
}
