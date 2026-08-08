use super::*;
// 建号的带参形只有测试用得着(生产走 `create_account` 那层尾调用包装),故这句 use 住在
// 这里而不是主文件 —— 放主文件的话生产构建会响一句 unused import(312 拆子模块的遗留)。
use super::account::create_account_as;
use crate::sync::production_src;
use crate::{db, images, notes, task};
use std::net::SocketAddr;
use std::sync::atomic::AtomicU32;
// 拨号侧的用例自己当 §4 的监听方,故要一只真监听口(L-c3b)。
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// `transport` 模块的**全部**生产源码(主文件 + 每个子模块),给做**全文**扫描的
/// 结构锚用。
///
/// 为什么非有这张表不可:锚分两类 —— 以 `.find(锚点).expect(…)` 开路的那些,主体一搬走
/// 就响亮红,自己会喊;而做「某模式**不出现**」或「恰出现 N 次」这类**全文断言**的,
/// 只扫主文件的话,代码搬进子模块后它们**静默变绿** —— 规则还写在文档里,守它的测试
/// 却已经什么都不看了。那正是本仓栽过多次的「假绿」形(291/292/299/307)。
///
/// **新增子模块必须同时加进这张表**,由 `every_transport_submodule_is_scanned` 强制:
/// 那只测从主文件里读 `mod X;` 声明,与本表逐个对账,漏一个当场红。
fn transport_sources() -> Vec<(&'static str, &'static str)> {
    vec![
        ("transport.rs", include_str!("../transport.rs")),
        ("account.rs", include_str!("account.rs")),
        ("ad_deck.rs", include_str!("ad_deck.rs")),
        ("ctx_impl.rs", include_str!("ctx_impl.rs")),
        ("deck.rs", include_str!("deck.rs")),
        ("lan_pump.rs", include_str!("lan_pump.rs")),
        ("selftest.rs", include_str!("selftest.rs")),
        ("session_loop.rs", include_str!("session_loop.rs")),
    ]
}

/// 找出 transport 模块里含某个锚点的**那一份**生产源码,给区间型结构锚用
/// (它们的形是「`find(锚点).expect(…)` 再切一段来断言」)。
///
/// 为什么不写死主文件:310 第 ② 笔把六块搬进子模块时,写死主文件的区间型锚**全部当场
/// 红了** —— 那是好事(它们喊了),但每搬一次都要人去挨个改文件名。改成按锚点找,
/// 代码搬到哪一份里都跟得上;而「恰好命中一份」这条断言反过来挡住锚点变得不唯一。
fn transport_prod_with(needle: &str) -> &'static str {
    let hits: Vec<(&'static str, &'static str)> = transport_sources()
        .into_iter()
        .filter(|(f, s)| production_src(s, f).contains(needle))
        .collect();
    assert_eq!(
        hits.len(),
        1,
        "锚点 {needle:?} 在 transport 模块里命中 {} 份源码({:?})—— 要恰好一份",
        hits.len(),
        hits.iter().map(|(f, _)| *f).collect::<Vec<_>>()
    );
    production_src(hits[0].1, hits[0].0)
}

/// 本表的完整性:主文件声明了几个子模块,表里就得有几份(`tests` 自己除外 ——
/// 它是测试,不是被扫的生产段)。**两侧各自会变,故拿它们互证,不写死一个数**
/// (同 `db.rs` 那只审计锚里 `skipped == declared` 的手法)。
#[test]
fn every_transport_submodule_is_scanned() {
    let main = include_str!("../transport.rs");
    let mut declared: Vec<String> = main
        .lines()
        .map(|l| l.split("//").next().unwrap_or("").trim_end())
        .filter_map(|l| l.strip_suffix(';').map(str::to_owned))
        .filter_map(|l| {
            ["mod ", "pub mod ", "pub(crate) mod ", "pub(super) mod "]
                .iter()
                .find_map(|p| l.strip_prefix(p).map(|m| format!("{m}.rs")))
        })
        .filter(|m| m != "tests.rs")
        .collect();
    let mut scanned: Vec<String> = transport_sources()
        .iter()
        .map(|(f, _)| (*f).to_owned())
        .filter(|f| f != "transport.rs")
        .collect();
    declared.sort();
    scanned.sort();
    assert_eq!(
        scanned, declared,
        "transport 的子模块与 `transport_sources()` 对不上 —— 漏进表的那个文件,\
         全文式结构锚一个字都看不见(它们会静默变绿,不会报错)"
    );
    // 主文件本身永远在表里,否则整张网是空的。
    assert!(
        transport_sources().iter().any(|(f, _)| *f == "transport.rs"),
        "主文件不在扫描表里"
    );
}

// 定点测试账户(合法 ULID 形态;open-signup 起准入开放,无须预签)。
const ACCT: &str = "01AAAAAAAAAAAAAAAAAAAAACCT";

static N: AtomicU32 = AtomicU32::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let dir = crate::test_temp::dir().join(format!(
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
    let src = include_str!("../transport.rs");
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
    let src = include_str!("../transport.rs");
    // 只看产品代码(测试自己也造 interval,那是压到毫秒级的测具)。
    let prod = production_src(src, "transport.rs");
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
    // 先切掉测试模块(291/292 那两只自指空测的教训):本测自己也写这些字面量。
    let prod = transport_prod_with("async fn ops_changed_tick(");
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
    //    ⚠ 这一臂与上面那个 sweep **不在同一份源码里**(310 第 ② 笔:sweep 随 `Deck`
    //    去了 `deck.rs`,会话循环去了 `session_loop.rs`),故各自按锚点找。
    let loop_prod = transport_prod_with("_ = tick.tick() => {");
    let beat_at = loop_prod.find("_ = tick.tick() => {").expect("会话内那根心跳");
    let beat = code_only(
        &loop_prod[beat_at
            ..beat_at
                + loop_prod[beat_at..].find("\n            },").expect("心跳臂以十二空格 },")],
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
    // **先切掉测试模块**(291 收尾自查):上一版直接在整份源码上 `find`,而它的锚点
    // `pub async fn run(mut t: Transport)` 早在 `run` 拆成 `run`/`run_inner` 那轮就没了
    // (`mut t` 跟着搬进了后者)。于是唯一命中的是**本测自己那一行**,随后三个位置也
    // 全是本测源码里的字面量 —— `call < down < handled` 恒成立,这只锚变成了自指的
    // 空测,任凭生产段怎么改都绿。锚点会随修法失效,这是第三例(275 变异 plan 的锚 /
    // `ops_serve` 那只切点)。
    let prod = transport_prod_with("async fn run_inner(");
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
    // 每一处 `read_blob_chunk(` 调用之前、同一个 `db.lock()` 临界区之内,必须先有一次
    // `identity_still_current_conn(`。取「最近一次 lock」到该调用之间那一段来看。
    //
    // **逐份源码扫,不许把几份拼起来再扫**(310 第 ② 笔两条腿分了家:LAN 那处在
    // `lan_pump.rs`、中转那处在 `ctx_impl.rs`)。拼起来的话 `rfind` 会越过文件边界,
    // 在上一份源码里找到一把毫不相干的锁 —— 那是假绿。
    let mut calls = 0usize;
    for (file, src) in transport_sources() {
        let prod = production_src(src, file);
        for (at, _) in prod.match_indices("read_blob_chunk(&conn,") {
            calls += 1;
            let head = &prod[..at];
            let lock = head
                .rfind(".lock().expect(\"db mutex poisoned\")")
                .unwrap_or_else(|| panic!("{file}:取数必在锁内"));
            assert!(
                prod[lock..at].contains("identity_still_current_conn("),
                "{file}:取数之前、同一把锁之内必须先自证身份(§6 ⑤ 的第六条出口)"
            );
        }
    }
    assert_eq!(calls, 2, "恰两处取数(LAN 写泵 + 中转腿),实见 {calls}");
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
    let prod = transport_prod_with("fn send_relay_blob(");
    for (out_fn, call, pump_fn, class, mint, occupy) in [
        (
            "fn send_relay_blob(",
            "self.send_relay_blob(",
            "fn pump_blob(",
            "图字节",
            "Sent::ServeBlob { ticket, to:",
            "relay_data.occupy_blob(",
        ),
        (
            "fn send_relay_ops(",
            "self.send_relay_ops(",
            "fn pump_ops(",
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

/// 结构锚(305;307 按 codex 二轮给的设计收口):**「读空 → 段退役」那一支的提交,
/// 必须与产出它的那次取数同处一把库锁**。为什么非守不可,见 [`ops_prepare_locked`]
/// 的抬头(那里写着 303 量出的那个静默丢是怎么发生的)。
///
/// **「放不掉锁」这一格已经不归本锚管了** —— 305 首版拿源码文本守它,而 codex 实现审
/// 一~二轮各给出一段能编译、能过全部断言的绕法(内层求值块 / 第二次取锁 /
/// `let released = conn; drop(released);` / `std::mem::drop::<_>(conn)`)。文本挡得住
/// 前两种,挡不住后两种,而当时那句「一网打尽三种写法」本身就是假话。307 把取数与空转
/// 提交收进只借得到 `&MutexGuard` 的 [`ops_prepare_locked`],于是**借用检查器**接手:
/// helper 手里没有所有权,任何写法都放不掉它借来的守卫;调用方在这次调用期间把守卫借
/// 了出去,同样放不掉。
///
/// 剩下三件里,**只有前两件按源码钉**(接线事实,类型封不住):
/// 1. **取数唯一入口**:`prepare_next(` 恰一处,且在 helper 体内(多一处 = 有人在别的
///    持锁期外另开了一条取数路);
/// 2. **空转提交也在 helper 体内**(挪回调用方就重新有了「放锁之后再提交」的可能)。
///
/// 第 3 件「那个形参真的是**借**」**不许按源码钉**(codex 实现审 307 轮 M):文本断言
/// 挡不住把签名改成按值、再在体内塞一句
/// `let _signature_decoy = "conn: &MutexGuard<'_, Connection>,";` —— 三条文本断言全过、
/// 代码却在空转提交前放掉了锁(`work.commit({ drop(conn); p.token })`)。故改成
/// **编译期类型断言**:把函数项强制成一枚 fn 指针,签名对不上**根本编译不过**。
/// 这一格因此没有「红」的变异 —— 变异④(退回按值)撞的是编译器,见 progress-log 307。
///
/// **同一件事在生产侧另有一道**([`ops_prepare`] 里的 `const PREPARE_LOCKED`):codex
/// 二轮提出「helper 改泛型 `impl ConnView`,测试侧单态化成借用、生产侧传所有权」这条
/// 绕法,我实测它**连测试这一侧都编译不过**(fn 指针是高阶 `for<'c,'d>`,而泛型类型参数
/// 早绑定、必须是单一具体类型 → `one type is more general than the other`)。生产那道
/// 因此是冗余的第二道,留着的理由是不让这件事依赖一条这么微妙的推导规则、也不让它
/// 随本测一起被删掉 —— 实测把本测这行断言删掉之后,那条绕法**在 `cargo build --lib`
/// 上就被 `PREPARE_LOCKED` 挡住**(不必等到测试构建)。
#[test]
fn the_drained_gap_commit_stays_inside_the_read_critical_section() {
    // ③ 形参必须是**借来的**守卫:按值收走 = 拿回了放锁的权力,①② 白钉。
    // 这一行由借用检查器验,不由字符串验。
    let _: fn(&ServeCtx, &str, &MutexGuard<'_, Connection>, &mut ops_serve::OpsWorks) -> OpsTurn =
        ops_prepare_locked;

    let prod = transport_prod_with("fn ops_prepare_locked(");
    let hits = prod.matches("prepare_next(").count();
    assert_eq!(hits, 1, "取数唯一入口 = ops_prepare_locked,实见 {hits} 处");
    let at = prod.find("fn ops_prepare_locked(").expect("必有取数入口");
    let body = &prod[at..at + prod[at..].find("\n}").expect("函数总有结尾")];
    // ①② 两件都在这只 helper 体内,且取数在前、空转提交在后。
    let read = body.find("prepare_next(").expect("取数必须在 helper 体内");
    let spun = body.find("None => match work.commit(").expect("空转提交必须在 helper 体内");
    assert!(read < spun, "取数 → 空转提交,必须是这个次序");
}

/// **feed 的出口那几件在失败路径上也要跑**(实现审四轮 M1)。
///
/// 一枚线帧会被切成好几个子批逐批喂进引擎,前面几批可能**已经落地**了——`Changed`
/// 与状态快照(挂起数 / 冻结清单 / 隔离与 breaker)是它们唯一的通知,被中途那个 `?`
/// 跳过就得等下一次偶然的刷新。故第一枚 Err 扣到最后再报。行为测要注入「第 k 批失败」
/// 成本远高于按源码钉,故照 `lan_ad` 那只的同款做法。
#[test]
fn feed_defers_its_error_until_after_the_status_snapshot() {
    let prod = transport_prod_with("fn feed(");
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
    let prod = transport_prod_with("fn feed(");
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

/// 从链路上读一次的**三种**结局。
///
/// [`FakeLink::next`] 把它们压成同一个 `None` —— 对「这会儿有没有帧」够用,对「链路该关
/// 掉了」就不够:「关了」是被测行为,「到点还没动静」是链路仍开着(那是失败),两者过去
/// 分不出来。299 那只 flaky 正栽在这一格(它拿 `next() == None` 同时表达「没帧」和
/// 「关了」),故 312 把三种结局分开报。
#[derive(Debug)]
enum LinkRead {
    Frame(lan::LanWire),
    /// 对端关了 socket(EOF 或重置)。
    Eof,
    /// 到点还没读到东西 —— 链路仍开着。
    Timeout,
}

impl FakeLink {
    /// 读一枚 [`lan::LanWire`],三种结局分开报(见 [`LinkRead`])。
    async fn read(&mut self, ms: u64) -> LinkRead {
        use tokio::io::AsyncReadExt;
        let mut prefix = [0u8; 4];
        match timeout(Duration::from_millis(ms), self.stream.read_exact(&mut prefix)).await {
            Err(_) => return LinkRead::Timeout,
            Ok(Err(_)) => return LinkRead::Eof,
            Ok(Ok(_)) => {}
        }
        let n = lan::checked_body_len(prefix, lan::FramePhase::Established).expect("长度前缀");
        let mut body = vec![0u8; n];
        self.stream.read_exact(&mut body).await.expect("帧体");
        LinkRead::Frame(lan::decode_wire(&body, lan::FramePhase::Established).expect("解帧"))
    }

    /// 读一枚 [`lan::LanWire`];超时(或对端关闭)返回 `None`。
    async fn next(&mut self, ms: u64) -> Option<lan::LanWire> {
        match self.read(ms).await {
            LinkRead::Frame(w) => Some(w),
            LinkRead::Eof | LinkRead::Timeout => None,
        }
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

    /// 在**总预算**内读一枚数据帧:Ping 顺手回 Pong(像真对端那样),Pong 跳过。
    ///
    /// 与 [`FakeLink::next_msg`] 的差别只有一处 —— **预算是总的,不是每次读的**,而这一处
    /// 在把心跳压到毫秒级的台架上是生死线:lan 的 Ping 借 runtime 那根心跳发(§3),故
    /// 心跳 250ms 的用例里对端**每 250ms 就有一枚 Ping**,per-read 预算的那只于是永远
    /// 「读得到东西」→ 既不返回也不让出。首版就卡在这儿 90 秒,期间一个字节都没往回写,
    /// 链路反被**自己的沉默**判死(90 秒无帧),而断言报出来的是「内容没到」。
    ///
    /// 回 Pong 不是为了绕开判死,是**把对端演像**:真对端收 Ping 必回,链路因此不静默。
    ///
    /// **预算由 `timeout_at` 一处兜住整只循环**,不是「每一跳各自算剩余」(codex 实现审 L2):
    /// 后者只给 4 字节前缀那次读加了闸,**帧体的 `read_exact` 与回 Pong 的 `write_all` 都能
    /// 越过 deadline** —— 在受控 localhost 上不构成假绿,但注释承诺的是「总预算」,那就得
    /// 真的是总的。**注释说了什么,就让它守得住什么。**
    async fn next_msg_within(
        &mut self,
        cfg: &SyncConfig,
        ms: u64,
    ) -> Option<(String, String, Msg)> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
        tokio::time::timeout_at(deadline, async {
            loop {
                // 内层这个 `ms` 只是「别永久堵在一次 read 上」的粗闸,真正的截止由外层
                // `timeout_at` 说了算(它连帧体与回 Pong 一起罩住)。
                match self.read(ms).await {
                    LinkRead::Frame(lan::LanWire::Frame { from, to, blob }) => {
                        let Opened::Data(msg) = open_deliver(cfg, &from, &to, &blob) else {
                            panic!("链路上的帧解不开");
                        };
                        return Some((from, to, msg));
                    }
                    LinkRead::Frame(lan::LanWire::Ping {}) => {
                        self.try_send(&lan::LanWire::Pong {}).await;
                    }
                    LinkRead::Frame(_) => {}
                    LinkRead::Eof | LinkRead::Timeout => return None,
                }
            }
        })
        .await
        .unwrap_or(None)
    }

    /// socket 真的关了吗(EOF / 被重置),而不只是「这会儿没帧」——两者在
    /// [`FakeLink::next`] 里都是 `None`,拿它断言「链路已关」是**假绿**。
    ///
    /// **先把已经在路上的字节读干净**:「关了」与「一个字节都没发过」是两件事,而 TCP
    /// 里前者读得到的是「剩余数据…然后 EOF」。只读一次就下结论,等于把「发过东西再被关掉」
    /// 判成「还开着」——320 那只随机红正栽在这里:被验的出站握手稳态是**Intro 已写出、
    /// 正等 Accept**,于是「取消得够不够快」变成了「用例抢没抢在 Intro 前面」的调度赌局
    /// (加长超时反而更红:等得越久,数据越是已经到了)。这与 299 栽在 `next()` 上的是
    /// 同一族——判据必须能把三种结局分开,`Timeout` 才是「还开着」。
    async fn closed(&mut self, ms: u64) -> bool {
        use tokio::io::AsyncReadExt;
        let mut b = [0u8; 4096];
        timeout(Duration::from_millis(ms), async {
            // 读到 EOF / 重置为止;中途读到的都是收场前对端已经写出去的字节,丢掉。
            while let Ok(n) = self.stream.read(&mut b).await {
                if n == 0 {
                    break;
                }
            }
        })
        .await
        .is_ok()
    }

    async fn send(&mut self, wire: &lan::LanWire) {
        use tokio::io::AsyncWriteExt;
        let bytes = lan::frame_bytes(wire).expect("封帧");
        self.stream.write_all(&bytes).await.expect("写链路");
    }

    /// 同上,但**链路已关就如实回 `false`**。给「链路在不在」本身是观察对象的用例用:
    /// 那种用例里写失败是一条要记下来的事实,`expect` 会把它变成一句掩盖现场的 panic。
    async fn try_send(&mut self, wire: &lan::LanWire) -> bool {
        use tokio::io::AsyncWriteExt;
        let bytes = lan::frame_bytes(wire).expect("封帧");
        self.stream.write_all(&bytes).await.is_ok()
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

/// 从**另一条腿的视角**把 ops 在飞位领下来(锁序恒 db → work)。
///
/// 为什么不能就地 `prepare_next(…).ready().expect(…)`:窗口只有一个,LAN 写泵此刻可能
/// 正攥着它 —— [`ops_serve::Prepare::Occupied`] 是**正常争用不是故障**(§6.2)。用例前
/// 一句「N 毫秒线上没出帧」只证明这一段封不出去,**证不出凭据已经交回**,于是满载并行下
/// 随机红(304 记债、312 改测)。撞上就退一步重来;真没活干(`Idle`)才是被测行为出了
/// 问题,当场响亮。
///
/// 也不写成「先 `wait_until(!ops_inflight)` 再取」:那两步之间写泵还能再武装一次,窗口
/// 仍是抢的。这里的「查 + 取」同在一次持锁内完成,不留缝。
async fn take_ops_window(r: &DeckRig, target: &str) -> ops_serve::Prepared {
    for _ in 0..600 {
        let taken = {
            let conn = r.db.lock().unwrap();
            let mut works = r.slot.ops.lock().unwrap();
            let work = works.work_mut(target).expect("逻辑 work 还在");
            match work.prepare_next(&conn).expect("取数不该出错") {
                ops_serve::Prepare::Ready(p) => Ok(Some(p)),
                ops_serve::Prepare::Occupied => Ok(None),
                ops_serve::Prepare::Idle => Err("该有一段等着发,实见 Idle"),
            }
        };
        // **出了锁再炸**:攥着 ops 锁 panic 会把它毒掉,后台写泵接着刷一屏
        // `ops works mutex poisoned` 的次生 panic + backtrace,把真因顶到几十行之外
        // (中毒即响亮是 `lock_ops` 定的政策,那是对的 —— 该改的是用例别死在锁里)。
        let taken = match taken {
            Ok(v) => v,
            Err(why) => panic!("{why}"),
        };
        if let Some(p) = taken {
            return p;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("等 ops 在飞位空出来超时:写泵一直攥着凭据不放");
}

/// 等 LAN 写泵**静下来**,回它此刻的武装次数(= 后面「有没有死自旋」的基线)。
///
/// 判据是「连着半秒一次都没再动」,不是 292 那版的「武装过至少一次」:后者只说明它开始
/// 干活了,队列里压着的别的铃照样会在取完基线之后接着涨 —— 于是那道 `+1` 的闸变成随机红
/// (312 在全量并行下真踩到)。而这**不是**在赔调度余量:死自旋每几微秒就武装一次,再怎么
/// 饿死也静不下来,这一步会自己超时。两种行为之间隔的是「从不增长」与「一直增长」,不是
/// 一个毫秒数。
async fn wait_ops_arms_quiet(r: &DeckRig, target: &str) -> u64 {
    let arms = || {
        r.slot.ops.lock().unwrap().work_mut(target).expect("逻辑 work 还在").arms_issued()
    };
    let (mut last, mut still) = (arms(), 0);
    for _ in 0..600 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let now = arms();
        if now == last && last >= 1 {
            still += 1;
            if still == 10 {
                return last;
            }
        } else {
            (last, still) = (now, 0);
        }
    }
    panic!("写泵一直在武装,静不下来 = 死自旋");
}

/// 领下来那一笔由**另一条腿**提交掉(它发成了,游标该往前走)。
fn commit_ops_window(r: &DeckRig, target: &str, token: ops_serve::CommitToken) {
    r.slot
        .ops
        .lock()
        .unwrap()
        .work_mut(target)
        .expect("逻辑 work 还在")
        .commit(token)
        .expect("另一条腿发成了,推进游标");
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
    // 取完就放锁,断言在锁外做——死在锁里会毒掉它,见 [`take_ops_window`]。
    let again = {
        let conn = r.db.lock().unwrap();
        let mut works = r.slot.ops.lock().unwrap();
        let work = works.work_mut(PEER_ONE).expect("逻辑 work 住引擎槽,不随链路死");
        work.prepare_next(&conn).expect("窗口是空的").ready().expect("同一段还在")
    };
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
    // ⚠ **先等它静下来再取基线**(292 只等到「武装过一次」,还不够 —— 队列里压着的别的
    // 铃会在取完基线之后接着涨,于是下面那道 `+1` 成了随机红,312 在全量并行下真踩到)。
    let armed_before = wait_ops_arms_quiet(&r, PEER_ONE).await;
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

    // 模拟中转腿把卡住那一段供掉并提交(锁序恒 db → work;撞上写泵还攥着凭据要重试,
    // 理由见 [`take_ops_window`])。
    let p = take_ops_window(&r, PEER_ONE).await;
    assert_eq!(p.frame.expect("有帧").ops[0].origin_seq, 1, "拿到的正是卡住那一段");
    commit_ops_window(&r, PEER_ONE, p.token);
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
    // ⚠ **在飞位可能还没交回**(292 收尾修的一处零余量假设):上面那 1000ms 只证明
    // 「线上没出帧」,满载并行下写泵可能还攥着那枚凭据。292 的修法是「先 `wait_until`
    // 再取」,312 换成查取同锁的 [`take_ops_window`] —— 那两步之间还留着一道缝。
    let p = take_ops_window(&r, PEER_ONE).await;
    let f = p.frame.expect("有帧");
    assert_eq!((f.origin.as_str(), f.ops[0].origin_seq), (PEER_TWO, 1), "正是卡住那段");
    commit_ops_window(&r, PEER_ONE, p.token);
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
    let prod = transport_prod_with("if ops_turns >= OPS_TURNS_PER_CHECKPOINT {");
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
    let prod = transport_prod_with("impl Drop for OpsTicket");
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
    let ops_src = include_str!("../ops_serve.rs");
    let ops_prod = production_src(ops_src, "ops_serve.rs");
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

    // 提交点在 LAN 写泵里(310 第 ② 笔起住 `lan_pump.rs`),与凭据的 Drop 分了家,
    // 故各自按锚点找。
    let pump = transport_prod_with("if let Err(e) = ticket.commit() {");
    let at = pump.find("if let Err(e) = ticket.commit() {").expect("有提交点");
    let mut end = (at + 160).min(pump.len());
    while !pump.is_char_boundary(end) {
        end -= 1;
    }
    assert!(
        pump[at..end].contains("break format!"),
        "提交不上 = 在飞位已不是这一笔 = 所有权不变量破了,必须响亮收场"
    );
}

/// 结构锚(L-d″ 第⑤笔;lan-direct-plan §6.2 三轮 S6 点名要的那一只):**ops 计划表的
/// 每一处上锁点都在名单上,并按「同持库锁」与「只持 work」分两类各自钉住**。
///
/// [`Engine::ops`] 的字段注释早就许诺了它,而它**一直不存在**(progress-log 308 排队
/// 第一条;「文档凭空许诺一只不存在的专测」同族第二例,293 判过一次)。
///
/// 守的是 `ops` 那把锁的三条纪律:
/// 1. **锁序恒 db → work**:反序取锁的对家一出现就是 ABBA 死锁。今天全仓只有
///    [`ops_prepare`] 自己动手取两把;引擎那半的库锁恒由调用方借来
///    (`conn: &Connection`),而 `engine.rs` **结构上取不到库锁**(整个文件一次 db 上锁
///    都没有),故它无从反序 —— 这条是引擎那七处的全部安全性依据,单独钉一道。
/// 2. **guard 不许跨 `.await`**;
/// 3. **持 work 时不得再取 db/clock/status/lan**。
///
/// 临界区的范围不靠人读,由**上锁点的形状**算出来:
/// * `lock_ops(…).方法(…);` —— 守卫是临时量,活到本语句末 → 临界区 = 这一句;
/// * `let w = lock_ops(…);` —— 守卫被接住,活到作用域末 → 临界区**保守地**取到函数末
///   (取不到更紧的那一档:大括号匹配得先分清字符串与注释里的括号,不值)。
///
/// 牙齿就在这一格:把 [`Deck::ops_tick`] 那句临时量改成 `let` 接住,临界区立刻盖到函数
/// 末的 `self.db.lock()` 与几个 `.await` 上 —— 那是一条 **work → db 的反序**,而它今天
/// 只由「碰巧写成了临时量」这个一眼看不见的细节挡着。
///
/// **诚实边界**:名单的完整性靠「生产段不许出现 `.ops.lock(`」这一句文本挡着。它挡得住
/// 顺手写成 `self.ops.lock().unwrap()` 的漂移,挡不住先把 `Mutex` 别名进局部变量再上锁
/// ——要彻底封死得把 `Mutex<OpsWorks>` 裹成只有 `lock_ops` 开得了的新类型(307 那条
/// 「类型的事让编译器判」的同一味药),记 progress-log 可优化项,不在本笔。
#[test]
fn ops_lock_sites_are_allowlisted() {
    /// 这一处上锁时,临界区里碰不碰库。
    #[derive(PartialEq)]
    enum Hold {
        /// 同持库锁与 work,**且库锁在先**。
        DbThenWork,
        /// 只持 work:临界区内不许碰库、不许再取别的锁、不许 `.await`。
        WorkOnly,
    }
    use Hold::*;
    // (文件, 函数, 类别)。每一条必须**恰好**命中一次:多一处上锁点、少一处、或类别与
    // 源码对不上,都在这里响亮红掉 —— 加新上锁点的人被迫先回答「它属哪一类」。
    //
    // 文件那一列写 **`"transport"` 表示「transport 模块族的任一份源码」**(主文件或它的
    // 任何子模块)。310 第 ② 笔把 `Deck` / `Ctx` 等搬进子模块时,写死 `"transport.rs"`
    // 的十条全部对不上了 —— 而族内搬家不改变任何一条锁纪律,名单不该跟着churn。
    // `engine.rs` / `ops_serve.rs` 仍按文件精确写:`ops_tick` 在引擎和 transport 里
    // **各有一个**,那一格的消歧是真需要的。
    let allow: &[(&str, &str, Hold)] = &[
        // ---- engine.rs:库锁恒由调用方借来,引擎自己取不到(见下面那道全局断言)----
        ("engine.rs", "drain_ops_for_test", DbThenWork), // cfg(test) 夹具,如实列
        ("engine.rs", "hello_watermarks", DbThenWork),
        ("engine.rs", "outbound", WorkOnly),
        ("engine.rs", "ops_tick", WorkOnly),
        ("engine.rs", "on_peer_online_ops", WorkOnly),
        ("engine.rs", "on_hello", WorkOnly),
        ("engine.rs", "on_want", WorkOnly),
        // ---- transport 族(主文件 + 子模块;族内搬家不改这里)----
        ("transport", "session_wrapup", WorkOnly),
        ("transport", "rollback_quiet", WorkOnly),
        ("transport", "settle", WorkOnly),
        ("transport", "ops_prepare", DbThenWork), // 全仓唯一自己动手取两把的
        ("transport", "ops_tick", WorkOnly),
        ("transport", "ops_changed_tick", WorkOnly),
        ("transport", "pump_ops", WorkOnly),
        ("transport", "probe_unknown_target", WorkOnly),
        ("transport", "on_nack", WorkOnly),
        ("transport", "clear_unknown_for", WorkOnly),
    ];
    const DB_LOCK: &str = ".lock().expect(\"db mutex poisoned\")";
    // 找 token 之前一律先剔注释(293 那条:同一段的散文里常常正在讲「原先这里还有一句
    // X」,不剔就会命中自己的注释 —— 本锚就有现成的一处,`ops_prepare` 的行内注释里写着
    // `conn: impl ConnView`)。代价:`//` 也可能出现在字符串里(`wss://`),那一行会被多
    // 剔一截;本锚要找的几个 token 都不出现在带 URL 的行上。
    let code = |s: &str| -> String {
        s.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
    };

    // 引擎那半**取不到库锁**:这不是习惯,是结构事实,且是上面七条「无从反序」的全部
    // 依据。它跟着名单一起过期的话,反序就重新变成一句无人复核的声称。
    let engine_src = include_str!("../engine.rs");
    let engine_prod = production_src(engine_src, "engine.rs");
    assert!(
        !code(engine_prod).contains(DB_LOCK),
        "engine.rs 生产段开始自己取库锁了 —— 它那几处 work 上锁的锁序从此不再是结构事实"
    );

    // 顺带给「文档点名一只不存在的测试」那条陈账打疫苗:engine.rs 点名的锚,得真有一只
    // 同名的 `fn` 住在它点名的那个文件里。**文件与名字都从注释里读出来**,不写死 ——
    // 写死就只证明了它自己(309 的变异⑤专证这一格)。
    //
    // `include_str!` 要编译期字面量,故读出来的路径与下面那个字面量对一次账:310 把测试段
    // 搬进 `transport/tests.rs` 时,正是这一格当场红的,那次它干的就是本职工作。
    let marker = "结构锚见 ";
    let m = engine_prod.find(marker).expect("engine.rs 的 `ops` 字段还写着那句锁序纪律");
    let tail = &engine_prod[m + marker.len()..];
    let named_in = tail.split_whitespace().next().expect("点名要先写文件名");
    assert_eq!(
        named_in, "transport/tests.rs",
        "engine.rs 点名的锚换文件了({named_in}),本处 include_str! 的字面量要跟着改"
    );
    let a = tail.find('`').expect("点名的锚要用反引号括起来") + 1;
    let b = a + tail[a..].find('`').expect("反引号要成对");
    let named = &tail[a..b];
    assert!(
        include_str!("tests.rs").contains(&format!("fn {named}(")),
        "engine.rs 点名的结构锚 `{named}` 在 {named_in} 里不存在"
    );

    let mut seen = vec![0usize; allow.len()];
    // transport 那一份**走 `transport_sources()`**,不是写死主文件:名单要完整,
    // 而代码搬进子模块后只扫主文件的话,下面那条「不许绕开 `lock_ops` 直接上锁」
    // 会**静默变绿**(新文件里写 `.ops.lock(` 它一个字都看不见)。
    let scan: Vec<(&str, &str)> = std::iter::once(("engine.rs", engine_src))
        .chain(std::iter::once(("ops_serve.rs", include_str!("../ops_serve.rs"))))
        .chain(transport_sources())
        .collect();
    for (file, src) in scan {
        let prod = production_src(src, file);
        // 名单要完整,前提是生产段一律走 `lock_ops` 这一处入口(诚实边界见抬头)。
        assert!(
            !code(prod).contains(".ops.lock("),
            "{file} 生产段绕开 lock_ops 直接上锁 —— 绕开的那一处不在本名单上"
        );
        for (at, _) in prod.match_indices("lock_ops(") {
            if prod[..at].ends_with("fn ") {
                continue; // ops_serve.rs 里那唯一一处定义
            }
            let line = prod[..at].rfind('\n').map_or(0, |n| n + 1);
            if prod[line..at].contains("//") {
                continue; // 注释里提到它,不是上锁点
            }
            // ① 上锁参数必须是朴素路径:里面再套调用,下面按括号切形状就会读错。
            let open = at + "lock_ops(".len();
            let close = open + prod[open..].find(')').expect("上锁参数总有右括号");
            assert!(
                !prod[open..close].contains('('),
                "{file}:lock_ops 的参数里别再套调用(本锚按括号切形状)"
            );
            // ② 落在哪个函数里(行首除了 pub/async/unsafe 就是 `fn` 的那一行)。
            let head = &prod[..at];
            let mut found = None;
            for (i, _) in head.match_indices("fn ") {
                let ls = head[..i].rfind('\n').map_or(0, |n| n + 1);
                let mut pre = head[ls..i].trim_start();
                for kw in ["pub(crate) ", "pub(super) ", "pub ", "async ", "unsafe "] {
                    pre = pre.strip_prefix(kw).unwrap_or(pre);
                }
                if pre.is_empty() {
                    found = Some((ls, i));
                }
            }
            let (fn_ls, fn_at) = found.expect("上锁点总落在某个函数里");
            let indent = head[fn_ls..].len() - head[fn_ls..].trim_start().len();
            let from = fn_at + "fn ".len();
            let name_len = prod[from..]
                .find(|c: char| !(c.is_alphanumeric() || c == '_'))
                .expect("函数名后面总有东西");
            let name = &prod[from..from + name_len];
            // ③ 形状 → 临界区范围(见抬头)。
            let rest = prod[close + 1..].trim_start();
            let end = if rest.starts_with('.') {
                at + prod[at..].find(';').expect("语句总有分号") + 1
            } else if rest.starts_with(';') {
                let tail = format!("\n{}}}", " ".repeat(indent));
                at + prod[at..].find(&tail).expect("函数总有结尾")
            } else {
                panic!("{file} fn {name}:认不出的上锁形状,先扩充本锚再改代码");
            };
            let body = code(&prod[at..end]);

            let in_family = transport_sources().iter().any(|(f, _)| *f == file);
            let idx = allow
                .iter()
                .position(|(f, n, _)| (*f == file || (*f == "transport" && in_family)) && *n == name)
                .unwrap_or_else(|| {
                    panic!(
                        "{file} fn {name} 取了 ops 那把锁却不在名单上 —— 先判它是 db+work \
                         还是 work-only(判据见本锚抬头),再把它加进来"
                    )
                });
            seen[idx] += 1;

            // 两类共有的两条纪律。
            assert!(!body.contains(".await"), "{file} fn {name}:work 的 guard 不许跨 `.await`");
            assert!(!body.contains(".lock("), "{file} fn {name}:持 work 时不得再取别的锁");
            assert!(
                !body.contains("set_status("),
                "{file} fn {name}:持 work 时不得再取状态锁(它就藏在 set_status 后面)"
            );
            match allow[idx].2 {
                // 库连接在这个 crate 里恒叫 `conn`(`Connection` 大写,不会误命中)。
                WorkOnly => assert!(
                    !body.contains("conn"),
                    "{file} fn {name}:名单上写着只持 work,临界区里却在碰库 —— 要么把它挪\
                     出锁外,要么改判 DbThenWork 并当场证明库锁在先"
                ),
                DbThenWork => {
                    assert!(
                        body.contains("conn"),
                        "{file} fn {name}:名单上写着同持库锁,临界区里却一次都没碰库 —— \
                         该降级成 WorkOnly(类别是给人看锁序用的,不是装饰)"
                    );
                    // 库锁在先的两种证法:自己先取了,或者压根取不到(只收得到 `&Connection`,
                    // 而这个文件整体没有一次 db 上锁 —— 引擎那半走的就是后一条)。
                    if !code(&prod[fn_ls..at]).contains(DB_LOCK) {
                        let sig = code(&prod[fn_ls..fn_ls + prod[fn_ls..].find('{').expect("函数总有体")]);
                        assert!(
                            sig.contains("conn: &Connection"),
                            "{file} fn {name}:既没先取库锁,签名也没收 `&Connection` —— 锁序无从谈起"
                        );
                        assert!(
                            !code(prod).contains(DB_LOCK),
                            "{file} fn {name}:靠「库锁由调用方持着」立论,而本文件自己也会取库锁 \
                             —— 那就不是结构事实,只是一句约定"
                        );
                    }
                }
            }
        }
    }
    for (i, (file, name, _)) in allow.iter().enumerate() {
        assert_eq!(
            seen[i], 1,
            "{file} fn {name}:名单上有它,源码里命中 {} 次(0 = 这条该删;>1 = 同一个函数里\
             多出了上锁点,得逐个判)",
            seen[i]
        );
    }
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

/// 两只入口闸测共用的探针 op:一枚**合法**的远端 `Ops`(payload 取最简的 topic create,
/// 照 engine 测试的 `topic_op`)。origin 与信封上的 `from`/`to` 无关,故它能不能落地
/// **只**取决于这枚帧进没进引擎 —— 这正是两只测要的那个「只由入口闸决定」的观测面。
///
/// **每个样本各用一个自己的 origin**(codex 实现审 307 轮 L):共用 origin 的话,闸一旦
/// 破了,第一枚落地会把该 origin 的水位推到 1,后面几枚同样是 `origin_seq: 1` 就成了
/// 「已见过」而被幂等吞掉 —— 那几格的绿会变成**回放状态背书的**,不再由入口闸决定。
/// 各用各的 origin,则每一枚都是那个 origin 的第 1 枚,恒可应用。
fn wire_probe_op(n: u8) -> Msg {
    // 26 位规范 Crockford(S/R/C/A 都在表内;别用 I/L/O/U)。
    // **序号定宽 + 夹具自证**:`{n}` 不定宽,`n = 100` 时 origin 会长到 28 位、当场
    // 变成非法设备 id,而症状是「阳性对照的 op 没落地」—— 看着像被测那道闸拦错了。
    // 别手数长度,让夹具自己过一遍生产那把尺(identity.rs 的夹具连踩三次同一件事)。
    let origin = format!("01SRC{n:03}{}", "A".repeat(18));
    assert!(
        crate::clock::is_canonical_device_id(&origin),
        "夹具自证:探针 origin 必须是规范设备 id,实见 {origin:?}"
    );
    Msg::Ops {
        origin: origin.clone(),
        ops: vec![crate::replay::RemoteOp {
            op_id: ulid::Ulid::new().to_string(),
            hlc: crate::clock::Hlc { wall_ms: 9_000 + n as u64, counter: 0, device_id: origin }
                .encode(),
            entity: "topic".into(),
            entity_id: ulid::Ulid::new().to_string(),
            kind: "create".into(),
            payload: serde_json::json!({
                "title": format!("入口闸样本 {n}"),
                "created_at": "2026-08-06T00:00:00Z"
            }),
            origin_seq: 1,
        }],
    }
}

fn count_topics(db: &Arc<Mutex<Connection>>) -> i64 {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT COUNT(*) FROM topics", [], |r| r.get(0)).unwrap()
}

/// **网络入口只收发给本机或广播的帧**(308;codex 307 轮那条 L,判据由它收紧过)。
///
/// 与 `from` 那只是同一条纪律的另一半,但**判据刻意不同**:`from` 问的是「是不是规范
/// 设备 id」(形态),`to` 问的是「**是不是发给我的**」(归属)。只要求语法规范的话,
/// 一枚发给**第三台设备**的合法帧照样进得来 —— 那正是 `PEER_TWO` 那个样本,它过得了
/// `is_canonical_device_id` 却过不了这道闸。LAN 那条腿从 L-c2c 起就是这么要求的
/// (`lan::check_frame_addr`),本笔把中转腿对齐。
///
/// 观测面与 `from` 那只同源(**这一帧到底进没进引擎**),理由也同源:入口闸是这一格
/// 唯一的决定者。**两个阳性对照都要有** —— 本机 id 与 `BROADCAST` 各一,少了后者的话
/// 「只放行本机 id」这个过严的写法会全绿,而它会把所有广播帧(Hello / 本机 op 推送 /
/// 补洞 want)整片挡在门外。
#[tokio::test]
async fn the_wire_only_admits_frames_addressed_to_this_device_or_broadcast() {
    let mut r = deck_rig("wire-to");
    let cfg = deck_cfg(&r.db);
    let seal = |to: &str, msg: &Msg| {
        crypto::seal_msg(
            &cfg.k_acc,
            &FrameAddr {
                account_id: &cfg.account_id,
                from_device: PEER_ONE,
                to,
                domain: msg_domain(msg),
            },
            msg,
        )
    };
    let before = count_topics(&r.db);
    // 三类各一:形态不合 / **规范但是别人的**(这条只有归属闸挡得住)/ 空串。
    for (n, bogus) in ["01PEER1", PEER_TWO, ""].into_iter().enumerate() {
        let msg = wire_probe_op(n as u8);
        let blob = seal(bogus, &msg);
        r.status.lock().unwrap().error = None;
        let got = offline_face(&mut r)
            .on_wire(Ingress::RelayDeliver, PEER_ONE, bogus, &blob)
            .await
            .expect("拒一枚地址不对的帧不许拆掉整条会话");
        assert!(got.is_none(), "拒掉的帧不该交出引导消息:{bogus:?}");
        assert!(
            r.status.lock().unwrap().error.is_some(),
            "拒收要出声(advisory 面),不许静默咽下:{bogus:?}"
        );
        assert_eq!(
            count_topics(&r.db),
            before,
            "收件人不是本机也不是广播的帧,压根不许进引擎:{bogus:?}"
        );
    }
    // 阳性对照两件:本机 id 与广播都要真放行(少了广播那件,「只放行本机 id」也能全绿)。
    for (n, good) in [cfg.device_id.as_str(), BROADCAST].into_iter().enumerate() {
        let msg = wire_probe_op(100 + n as u8);
        let blob = seal(good, &msg);
        offline_face(&mut r)
            .on_wire(Ingress::RelayDeliver, PEER_ONE, good, &blob)
            .await
            .expect("地址合法的帧照收");
        assert_eq!(
            count_topics(&r.db),
            before + n as i64 + 1,
            "发给 {good:?} 的 op 必须真落地(否则上半的绿是恒 false 挣来的)"
        );
    }
}

/// **网络入口只收完整的规范设备 id**(307;305 那轮 codex 纠正后排队的第 2 条)。
///
/// 守的是 [`Deck::on_wire`] 抬头那条:`from` 会被 `on_hello` / `on_want` 当成 ops 计划
/// 表的 target 用出去,而那把尺放行 `BROADCAST`(本机 origin 的 outbound work 就挂在
/// 它上面)。于是一枚 `from = "*"` 的 Hello 能给 BROADCAST 开出 active 计划,让
/// 「只下修固定快照计划的水位图」那条臂对广播可达 = 同一个静默丢。
///
/// **判据挑得对不对,第一版栽过一次,记在这里**(变异 ⑥ 抓到的假绿):我原先只断
/// 「畸形 from 不许建出 target」,而那一格**只有 `"*"` 这一个样本由入口闸决定** ——
/// 别的畸形值到了 `ops_serve` 照样撞 `vet_target` 那把尺,`Admit::Malformed` 在
/// `ensure` 之前就返回了,target 一样建不出来。于是把闸改成「只特判 `"*"`」跑起来
/// 全绿,正是 codex 点名不许写的那个形。
///
/// 故主判据换成**这一帧到底进没进引擎**:喂一枚合法的远端 `Ops`,看那条 op 落没落库。
/// 入口闸是这一格**唯一**的决定者 —— 放行就一定落地,拦下就一定不落。
/// 「BROADCAST 不得拥有 active 计划」那条阴性结论另用一枚 `Hello` 单钉(它是
/// `vet_target` 唯一放行、因而只能由入口闸挡的那个值)。
///
/// 四个畸形样本各代表一类:字面广播 / 长度不对 / 空串 / **长度对但字母表不对**
/// (`O` 不在 Crockford 表里,它专证这道闸不是只在数长度)。阴性对照必配:规范 id
/// 的同一枚帧要真落地,否则一把恒 false 的尺也能让上半全绿。
#[tokio::test]
async fn the_wire_only_admits_a_full_canonical_device_id_as_from() {
    let mut r = deck_rig("wire-from");
    let cfg = deck_cfg(&r.db);
    let op = wire_probe_op;
    let seal = |from: &str, msg: &Msg| {
        crypto::seal_msg(
            &cfg.k_acc,
            &FrameAddr {
                account_id: &cfg.account_id,
                from_device: from,
                to: &cfg.device_id,
                domain: msg_domain(msg),
            },
            msg,
        )
    };
    let before = count_topics(&r.db);
    for (n, bogus) in [BROADCAST, "01PEER1", "", "01PEEROAAAAAAAAAAAAAAAAAAA"]
        .into_iter()
        .enumerate()
    {
        let msg = op(n as u8);
        let blob = seal(bogus, &msg);
        r.status.lock().unwrap().error = None;
        let got = offline_face(&mut r)
            .on_wire(Ingress::RelayDeliver, bogus, &cfg.device_id, &blob)
            .await
            .expect("拒一枚畸形帧不许拆掉整条会话");
        assert!(got.is_none(), "拒掉的帧不该交出引导消息:{bogus:?}");
        assert!(
            r.status.lock().unwrap().error.is_some(),
            "拒收要出声(advisory 面),不许静默咽下:{bogus:?}"
        );
        assert_eq!(
            count_topics(&r.db),
            before,
            "畸形 from 的帧压根不许进引擎 —— 这一格只有入口闸决定得了:{bogus:?}"
        );
    }
    // 「BROADCAST 不得拥有 active 计划」:`vet_target` 放行 `"*"`,故挡它的只能是入口闸。
    let hello = Msg::Hello { watermarks: Default::default(), lan: None };
    offline_face(&mut r)
        .on_wire(Ingress::RelayDeliver, BROADCAST, &cfg.device_id, &seal(BROADCAST, &hello))
        .await
        .expect("拒一枚畸形帧不许拆掉整条会话");
    assert_eq!(lock_ops(&r.slot.ops).len(), 0, "不许给 BROADCAST 开出 active 计划");

    // 阴性对照两件:同一条入口换成规范设备 id,op 要真落地、Hello 要真进计划表。
    let msg = op(9);
    offline_face(&mut r)
        .on_wire(Ingress::RelayDeliver, PEER_ONE, &cfg.device_id, &seal(PEER_ONE, &msg))
        .await
        .expect("规范 id 的帧照收");
    assert_eq!(count_topics(&r.db), before + 1, "规范 from 的 op 必须真落地(否则上半的绿是恒 false 挣来的)");
    offline_face(&mut r)
        .on_wire(Ingress::RelayDeliver, PEER_ONE, &cfg.device_id, &seal(PEER_ONE, &hello))
        .await
        .expect("规范 id 的 Hello 照收");
    // 读完就放锁,断言在锁外做(死在锁里会毒掉它,见 [`take_ops_window`])。
    let runnable = lock_ops(&r.slot.ops).idle_runnable_targets();
    assert_eq!(runnable, vec![PEER_ONE.to_string()], "规范 id 的 Hello 必须真开出活");
}

/// 「空探不许放一个字节上线」的**顺序屏障**(307;替掉原先那两处
/// `next_msg(200ms).is_none()`)。
///
/// 超时式的「等 200ms 没等到」只证明**这 200ms 里**没有帧,它只会假绿不会假红:出帧
/// 慢一点就溜过去了。这里改成**在同一根 FIFO 上追加一枚已知会到的帧**:
///
/// * 协调者那一趟(`ops_changed_tick`)返回时,它这一拍要投的帧**已经同步入了各链路的
///   `out` 队列**(`dispatch` 不异步);
/// * 随后这一手 `lan_beat` 把 Ping 追加进**同一根**队列;
/// * 写泵按队列次序写,TCP 又是 FIFO —— 故「空探错误地出了一枚帧」时,读到的第一枚
///   **必然**是那枚帧而不是 Ping,`matches!` 当场红。
///
/// 于是判据从「时间够不够」变成「次序对不对」,与快慢无关。
///
/// ⚠ **它建在上面那两条前提上,而前提变了会静默变成假绿**(codex 实现审 307 轮 L,
/// 刻意不加源码锚 —— 静态钉住 `dispatch` 的实现太脆)。改了下面任一条就得同轮改这里:
/// * `Deck::dispatch` 不再同步入队(改成交给别的任务去投);
/// * Ping 不再走 `push_lan` 那根 `out` 队列(如改由写泵自己周期产出),或控制帧与数据帧
///   拆成两根队列 —— 那时屏障要换成「经**数据帧同一条路**入队的一枚显式尾帧」。
async fn no_frame_before_the_ping<const N: usize>(r: &mut DeckRig, links: [&mut FakeLink; N]) {
    offline_face(r).lan_beat().await.unwrap();
    for link in links {
        assert!(
            matches!(link.next(1000).await, Some(lan::LanWire::Ping {})),
            "空探不许放一个字节上线 —— 同一根队列上 Ping 排在它后面,先读到别的就是它出帧了"
        );
    }
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
    // **接力还有一环**(305):发出去那一帧的「已读到尾」是取数那一刻的事实,故段留到
    // 下一趟**读空**才退役。生产里这一趟由 `commit` 摇的 `ops_changed` 驱动(离线泵那条
    // 臂),夹具里同样得自己投——不投的话下面仪式那次登记会撞上「段还在 = 已经有人在做」
    // 而老实回 `woke=false`,那一枚就没有输出可 dispatch。
    //
    // **投完当场断两腿都没有新帧**(codex 实现审 L2):空探不许放一个字节上线,否则那枚
    // 多出来的旧帧会在下面冒充「仪式重推那一枚」/「第二条」,把最终断言整段架空。
    offline_face(&mut r).ops_changed_tick().await.unwrap();
    no_frame_before_the_ping(&mut r, [&mut one, &mut two]).await;

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
    // 同上那一环(连同「空探不上线」那道断言):这一帧提交之后也得让读空那一趟跑掉,
    // 段才退役(305)。
    offline_face(&mut r).ops_changed_tick().await.unwrap();
    no_frame_before_the_ping(&mut r, [&mut one, &mut two]).await;
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
    // **解帧核 `origin_seq`**(codex 实现审 L2):只断「收到了点什么」的话,一枚滞留的
    // 旧帧就能冒充「第二条」把这条测整段架空。
    let (_, _, msg) = two.next_msg(&cfg, 500).await.expect("中转腿不可达的对端照补投");
    let Msg::Ops { ops, .. } = msg else { panic!("补投的该是 ops 帧,实见 {msg:?}") };
    assert_eq!(
        ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>(),
        vec![2],
        "补投的必须是**第二条**本身,不是滞留的第一条"
    );
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
    let src = include_str!("../transport.rs");
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

/// **本机 origin 那枚 ops 撞 `busy`,必须顺手置一笔对账重发债**(lan-direct-plan §12.1)。
///
/// 缺口是 295 真机量出的(6.5 拍 193s 零到达、期间一枚定向帧都没产生),三条叠加:
/// ①本机 op 挂 BROADCAST,而它那条 LAN 补投面([`Deck::fan_out_broadcast`])的名单出口
/// [`Engine::lan_backfill_peers`] 只收「lan 腿 Up **∧ relay 腿不 Up**」的对端 —— 295 那一幕
/// 两端都在中转上在线,故补投集恒空。(判据在**对端**那一维;§12.1 原文写成「`relay_up()`
/// 时不 fan-out」是按本机会话说的,已同轮更正 —— 权威 relay 帧其实**无条件**进 fan-out。)
/// ②**BROADCAST 恒不让位**(§6.2 ①,理由正当:让给 LAN 就是「谁抢到谁提交」,别的对端
/// 那一帧永远补不上);③唯一能把它变成「会让位的定向 work」的对端 Hello **不周期发送**
/// —— `reconcile_tick` 只在债在场时重建,而债此前只有**自己的 Hello 被 Nack** 才置。
/// 于是「中转会话稳定在、数据面持续 busy、直连稳定可用」时,本机新写的内容无限期停摆,
/// 而直连就在旁边闲着。
///
/// 判据落在**修法那一格**(置债),往后的链条(对端回 Want → 登记定向 work → 撞 busy →
/// 让位 → 直连接走)全是既有路径、各有专测,整条链另有
/// [`a_busy_relay_still_lets_local_writes_reach_a_lan_peer`]。
///
/// **看两拍**才排除得掉「碰巧有别的轴发了一枚」:仪式那枚已经 Ack 过,而 Hello 不周期
/// 发送(同族的 [`a_busy_hello_sets_the_debt_and_only_its_ack_clears_it`] 末段那 8 拍
/// 静默窗口就是这条背景事实的现成证据),故 `busy` 之后冒出来的广播 Hello 只可能是债
/// 驱动的;第一枚**刻意不给回执**,第二枚才证明它认的是债,而不是「发出去就算完」。
#[tokio::test]
async fn a_busy_own_ops_frame_sets_the_reconcile_debt() {
    let (mut relay, rig, cfg) =
        relay_rig_beat("relay-own-ops-debt", 91, Duration::from_millis(250)).await;
    {
        let mut conn = rig.db.lock().unwrap();
        let mut clk = rig.clock.lock().unwrap();
        notes::capture(&mut conn, &mut clk, "撞 busy 的那一条").unwrap();
    }
    // 仪式那枚广播 Hello **Ack 掉**:债只能来自下面那记 ops 的 `busy`,不能来自它。
    let (ritual, to, msg) = relay.next_out(&cfg, 8000).await.expect("仪式 Hello");
    assert!(matches!(msg, Msg::Hello { .. }), "仪式第一枚是 Hello,实见 {msg:?}");
    assert_eq!(to, BROADCAST);
    relay.ack(ritual);

    let (n, to, origin, _) = next_ops(&mut relay, &cfg, 8000).await.expect("本机那一枚 ops");
    assert_eq!(
        (to.as_str(), origin.as_str()),
        (BROADCAST, cfg.device_id.as_str()),
        "本机新写的内容挂 BROADCAST、origin 是本机"
    );
    relay.nack(n, err_code::BUSY);

    let first = next_broadcast_hello(&mut relay, &cfg, 8000)
        .await
        .expect("本机 ops 撞 busy 之后,心跳必须重建一枚广播 Hello(§12.1)");
    let second = next_broadcast_hello(&mut relay, &cfg, 8000)
        .await
        .expect("没拿到 Ack 就不算还债:下一拍必须再来一枚");
    assert_ne!(first, second, "两拍该是两枚不同的帧");
    rig.task.abort();
    relay.task.abort();
}

/// **只有 BROADCAST 那一格才置债**:定向 work 撞 `busy` 一律不置。
///
/// 收窄的理由不是省流量,是**别把一件已经有出路的事再挂一笔债**:定向 work 撞 busy 时
/// 走的是既有的「让位 + 摇直连的铃」(见
/// [`a_busy_relay_yields_the_directed_work_to_the_lan_leg`]),而债的存在只为解开
/// BROADCAST 那条**恒不让位**的死结。放宽到全部 `ServeOps` 的话,一台对端多、中转持续
/// busy 的设备每拍都在替一堆本来就在动的 work 重发水位图。
///
/// 判据取「2s = 8 拍内一枚广播 Hello 都不许有」:仪式那枚已 Ack、Hello 不周期发送,
/// 故只要冒出来就只可能是这笔不该记的债。
#[tokio::test]
async fn a_busy_directed_ops_frame_does_not_set_the_reconcile_debt() {
    let (mut relay, rig, cfg) =
        relay_rig_beat("relay-directed-ops-nodebt", 92, Duration::from_millis(250)).await;
    seed_remote_ops(&rig, PEER_TWO, 2, 0);
    seed_ops_work(&rig.device, PEER_ONE, PEER_TWO, 1);
    recycle_session(&mut relay).await;

    let (ritual, to, msg) = relay.next_out(&cfg, 8000).await.expect("仪式 Hello");
    assert!(matches!(msg, Msg::Hello { .. }), "仪式第一枚是 Hello,实见 {msg:?}");
    assert_eq!(to, BROADCAST);
    relay.ack(ritual);

    let (n, to, _, seqs) = next_ops(&mut relay, &cfg, 8000).await.expect("定向那一枚 ops");
    assert_eq!((to.as_str(), &seqs[..]), (PEER_ONE, &[1, 2][..]));
    relay.nack(n, err_code::BUSY);

    assert!(
        next_broadcast_hello(&mut relay, &cfg, 2000).await.is_none(),
        "定向 work 撞 busy 有让位这条既有出路,不该记债"
    );
    rig.task.abort();
    relay.task.abort();
}

/// **整条链**:中转会话稳定在、数据面持续 `busy`、直连健康时,本机新写的内容必须到得了
/// 对端(lan-direct-plan §12.1 那条活性缺口的行为测)。
///
/// 链条五步,每一步都是既有路径,**只有第一步是本笔新加的**:
/// 1. 本机 ops 撞 busy → 置债;
/// 2. 心跳按债重建一枚广播 Hello —— 小帧在数据面 busy 期照样通(295 实测:那期间债「当场
///    就被 Ack 清掉」,正说明控制面是通的);
/// 3. 对端收到那份水位图,发现自己落后 → 回一枚 `Want`(**真实对端的动作,这里由夹具代
///    演** —— 但代演的时刻绑死在「广播 Hello 真出现之后」,故修法不在,这一步永远不会发生);
/// 4. 本机把它登记成**定向** work → 泵到中转腿 → 又撞 busy;
/// 5. 定向那一格**会让位** → 直连当场接走。
///
/// 缺口本身也断了一格(第 4 行那个 for):直连接上之后、债那枚 Hello 之前,本机那一段
/// **不该**出现在直连上 —— BROADCAST 恒不让位是设计,不是本笔要改的东西。
///
/// ⚠ **对端必须「中转在线」这一格是拓扑要件,不是摆设**(首版漏了它,测试当场把我打红):
/// BROADCAST 那枚帧其实**有**一条补投面 —— 权威中转腿发帧那一处顺手 fan-out
/// ([`Deck::fan_out_broadcast`],§6.2 ①(C))。但它的名单出口
/// [`Engine::lan_backfill_peers`] 只收「lan 腿 Up **且 relay 腿不 Up**」的对端:中转在线的
/// 对端由信箱负责,不平行投第二份。295 真机那一幕正是**两端都在中转上在线、只有数据面
/// busy**,故补投集恒空 —— 这才是缺口成立的那一格。(§12.1 原文把 ① 写成「`relay_up()`
/// 时不 fan-out」,那是按本机会话说的,读着像整条补投面都关着;真实判据在**对端**那一维。)
///
/// 中转腿全程一律回 `busy`(模拟服务端预算持续不足),控制面照旧 Ack。
/// 一枚帧的一行摘要(只给 §12.1 那条链的现场记录用):`Debug` 会把 op 正文与水位图整个
/// 摊开,几十行淹掉真正要看的那一格 —— **谁、什么类、哪些 seq**。
fn brief(msg: &Msg) -> String {
    match msg {
        Msg::Ops { origin, ops } => format!(
            "Ops(origin={}, seq={:?})",
            &origin[origin.len() - 4..],
            ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>()
        ),
        Msg::Hello { watermarks, .. } => format!("Hello(水位 {} 项)", watermarks.len()),
        Msg::Want { origin, from_seq } => {
            format!("Want(origin={}, from={from_seq})", &origin[origin.len() - 4..])
        }
        other => format!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_busy_relay_still_lets_local_writes_reach_a_lan_peer() {
    let (mut relay, rig, cfg) =
        relay_rig_beat("relay-own-ops-busy-lan", 93, Duration::from_millis(250)).await;
    {
        let mut conn = rig.db.lock().unwrap();
        let mut clk = rig.clock.lock().unwrap();
        notes::capture(&mut conn, &mut clk, "持续 busy 期写的那一条").unwrap();
    }
    let (ritual, to, msg) = relay.next_out(&cfg, 8000).await.expect("仪式 Hello");
    assert!(matches!(msg, Msg::Hello { .. }), "仪式第一枚是 Hello,实见 {msg:?}");
    assert_eq!(to, BROADCAST);
    relay.ack(ritual);

    let (n, to, origin, _) = next_ops(&mut relay, &cfg, 8000).await.expect("本机那一枚 ops");
    assert_eq!((to.as_str(), origin.as_str()), (BROADCAST, cfg.device_id.as_str()));
    relay.nack(n, err_code::BUSY);

    // 摆出 295 那一幕的拓扑:对端在中转上**在线**(故广播补投面不覆盖它)。等到那枚
    // 「在线缺钥索要」的定向 Hello 出现为止 —— 它是这条事件真被引擎处置过的地面证据,
    // 光 send 完就往下走会与移交抢跑。
    relay
        .reply
        .send(ServerMsg::Peer { device: PEER_ONE.into(), online: true })
        .expect("假中转还活着");
    let mut peer_up = false;
    for _ in 0..40 {
        let Some((n, to, msg)) = relay.next_out(&cfg, 400).await else { continue };
        match &msg {
            Msg::Ops { .. } => relay.nack(n, err_code::BUSY),
            _ => relay.ack(n),
        }
        if to == PEER_ONE && matches!(msg, Msg::Hello { .. }) {
            peer_up = true;
            break;
        }
    }
    assert!(peer_up, "夹具:对端上线那条事件该产出一枚定向 Hello(§2 收敛触发②)");

    // 直连接进来:健康、闲着。
    let (mine, theirs) = tcp_pair().await;
    let mut lan = FakeLink { stream: theirs };
    rig.handoff.send(adopted(PEER_ONE, 1, mine)).await.expect("移交");
    wait_until("直连认下", || rig.status.lock().unwrap().lan_peers == 1).await;
    let (_, _, hello) = lan.next_msg_within(&cfg, 4000).await.expect("建链的定向 Hello");
    assert!(matches!(hello, Msg::Hello { .. }), "建链先发 Hello,实见 {hello:?}");

    // 缺口本身:BROADCAST 不让位,本机那一段此刻到不了直连(断的是「不该有」,故要容忍
    // 链路上本来就有的别的帧 —— 光断「一片安静」会被 Ping/Hello 打成假红)。
    for _ in 0..3 {
        if let Some((_, _, m)) = lan.next_msg_within(&cfg, 300).await {
            assert!(
                !matches!(&m, Msg::Ops { origin, .. } if origin == &cfg.device_id),
                "BROADCAST 恒不让位(§6.2 ①):本机那一段此刻不该走直连,实见 {m:?}"
            );
        }
    }

    // 两条腿交替轮询到 op 落地为止。中转腿:ops 一律 busy,别的照 Ack;广播 Hello 一到
    // 就代演对端那枚 Want(只演一次)。
    let mut asked = false;
    let mut arrived = false;
    // 两条腿上看见的每一枚都记一行:断言红了要能一眼看出链条断在第几步,而不是只知道
    // 「没到」(首版就是只有结论、没有现场,白跑了两轮)。
    let mut trace: Vec<String> = Vec::new();
    let t0 = std::time::Instant::now();
    for _ in 0..60 {
        if let Some((n, to, msg)) = relay.next_out(&cfg, 200).await {
            trace.push(format!("[{:?}] relay→{to}: {}", t0.elapsed(), brief(&msg)));
            match &msg {
                Msg::Ops { .. } => relay.nack(n, err_code::BUSY),
                Msg::Hello { .. } => {
                    relay.ack(n);
                    if to == BROADCAST && !asked {
                        asked = true;
                        trace.push("夹具:代演对端那枚 Want".into());
                        relay.deliver(
                            &cfg,
                            PEER_ONE,
                            &Msg::Want { origin: cfg.device_id.clone(), from_seq: 1 },
                        );
                    }
                }
                _ => relay.ack(n),
            }
        }
        if let Some((_, to, msg)) = lan.next_msg_within(&cfg, 200).await {
            trace.push(format!("[{:?}] lan→{to}: {}", t0.elapsed(), brief(&msg)));
            if let Msg::Ops { origin, ops } = &msg {
                if origin == &cfg.device_id {
                    assert!(
                        ops.iter().any(|o| o.origin_seq == 1),
                        "本机第一枚 op 该在这一帧里:{:?}",
                        ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>()
                    );
                    arrived = true;
                    break;
                }
            }
        }
    }
    // 红了要能一眼分清「链没了」与「链在、内容没走」——这两种失败的下一步完全不同。
    let seen = {
        let s = rig.status.lock().unwrap();
        format!(
            "{}\n  [直连] lan_peers={} warning={:?}",
            trace.join("\n  "),
            s.lan_peers,
            s.lan_warning
        )
    };
    assert!(asked, "债那枚广播 Hello 一直没出来,对端无从知道自己落后(§12.1 第 2 步)\n  {seen}");
    assert!(arrived, "中转持续 busy、直连健康时,本机新写的内容必须经直连到达(§12.1)\n  {seen}");
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
    // 旧代的配置得在换代**之前**取:收尾那一段要拿它去解旧代链上剩下的帧。
    let old_cfg = {
        let conn = a.db.lock().unwrap();
        load_config(&conn).unwrap().expect("已配置")
    };
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
    let ghost = {
        let mut conn = a.db.lock().unwrap();
        let mut clk = a.clock.lock().unwrap();
        notes::capture(&mut conn, &mut clk, "换代之后写的").unwrap()
    };

    timeout(Duration::from_secs(3), async {
        while a.status.lock().unwrap().lan_peers != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("栅栏该当场落下 → 回 run 顶重读配置 → 撤位拆链");

    // 旧代链**读到 EOF**,允许缓冲里的旧帧。
    //
    // ⚠ 原先这里断的是「换代之后旧代链上不许再出现任何帧」—— 那**比实现契约更强**,故
    // 约十次全量红一次(299 记债、codex 判根因):换代**之前**就已封好、进了 writer /
    // TCP 缓冲的那枚 Hello,关 socket 撤不回已排队的字节。因果链里强的是「提交新 K_acc →
    // 本地写唤醒 → `pump_apply` 先查栅栏」,没保证的是缓冲里的旧帧凭空消失。
    //
    // 真正不许发生的是**拿旧身份把换代之后写的东西发出去**,故只钉这一件;而「链路确实
    // 被关掉了」由 `Eof` 单独钉(过去它与「超时」同为 `None`,分不出来)。
    for _ in 0..64 {
        match peer.read(2000).await {
            LinkRead::Eof => {
                a.task.abort();
                stall.abort();
                return;
            }
            LinkRead::Timeout => panic!("撤位该把旧代链关掉,它却一直开着"),
            LinkRead::Frame(lan::LanWire::Frame { from, to, blob }) => {
                let Opened::Data(msg) = open_deliver(&old_cfg, &from, &to, &blob) else {
                    panic!("旧代链上出现了旧 K_acc 解不开的帧 = 拿新身份封的");
                };
                if let Msg::Ops { ops, .. } = &msg {
                    assert!(
                        !ops.iter().any(|o| o.entity_id == ghost),
                        "换代之后写的 op 不许拿旧身份发到旧代链上"
                    );
                }
            }
            LinkRead::Frame(_) => {}
        }
    }
    panic!("旧代链上的帧没完没了,它就没被关过");
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
    // 中文注释里随便一刀就可能切在多字节字符中间(切了就 panic,不是断言失败):
    // 取样一律退到最近的字符边界。
    let peek = |prod: &'static str, at: usize, n: usize| -> &'static str {
        let mut end = (at + n).min(prod.len());
        while !prod.is_char_boundary(end) {
            end -= 1;
        }
        &prod[at..end]
    };
    // **两条臂分了家**(310 第 ② 笔):会话循环在 `session_loop.rs`、离线泵还在主文件。
    // 故逐份源码扫再合计,不能只看一份 —— 只看一份的话「实见 1」会红成接线漂移,
    // 而真正危险的反面(有人在第三个文件里再开一条臂)只有扫全了才看得见。
    for (chan, woke) in [("lan_inbound.recv()", "Woke::Lan("), ("lan_faults.recv()", "Woke::LanDown(")] {
        let mut arms = 0usize;
        for (file, src) in transport_sources() {
            let prod = production_src(src, file);
            for (at, _) in prod.match_indices(chan) {
                arms += 1;
                let tail = peek(prod, at, 160);
                let end = tail.find("},").unwrap_or(tail.len());
                assert!(!tail[..end].contains("await"), "{file}:lan 臂里不许 await:\n{}", &tail[..end]);
                assert!(tail[..end].contains(woke), "{file}:臂只该认出事件");
            }
        }
        assert_eq!(arms, 2, "{chan}:会话循环与离线泵各一条臂,实见 {arms}");
    }
    // 移交臂与拨号臂同样各两条、同样分了家,同法逐份扫。
    let mut adopts = 0usize;
    let mut dials = 0usize;
    for (file, src) in transport_sources() {
        let prod = production_src(src, file);
        for (at, _) in prod.match_indices("handoff.recv()") {
            adopts += 1;
            let tail = peek(prod, at, 80);
            let end = tail.find(",\n").unwrap_or(tail.len());
            assert!(!tail[..end].contains("await"), "{file}:移交臂里同样不许 await");
        }
        // 拨号臂(L-c3b):它认出的那件事(巡查一轮)是同步的,但臂里一旦 await 起来,
        // 「一枚事件跑完再看下一件」就破了——结构锚把它钉在「只认出事件」上。
        for (at, _) in prod.match_indices("=> Woke::Dial") {
            dials += 1;
            let head = peek(prod, at.saturating_sub(80), 80);
            assert!(!head.contains("await"), "{file}:拨号臂里不许 await:\n{head}");
        }
    }
    assert_eq!(adopts, 2, "会话循环与离线泵各一条移交臂,实见 {adopts}");
    assert_eq!(dials, 2, "会话循环与离线泵各一条拨号臂,实见 {dials}");
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
    // 310 第 ② 笔起这两个函数住 `account.rs`;按锚点找,别写死文件名。
    let src = transport_prod_with("pub async fn create_account(");
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
///
/// 而「真被取消」与「它自己的计时到点了」之间的余量,由 [`lan_net::DialBudgetGuard`]
/// 从 2s 拉到分钟级 —— 靠生产那 2s 去分辨,在满载并行下就是随机红(302)。
#[tokio::test]
async fn retiring_the_engine_slot_also_retires_the_dialer() {
    let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
    let _budget = lan_net::DialBudgetGuard::install(600);
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
        timeout(Duration::from_secs(10), l.accept()).await.expect("该有人拨进来").expect("accept");
    assert_eq!(slot.dial.inflight(), 1, "此刻恰有一只在飞的出站握手");

    slot.retire();
    // 这一格只说「在飞表清空了」——`retire` 是 drain 掉整张表,故它**结构上恒为 0**,
    // 证不了任何取消行为(把 `h.abort()` 删掉它照样绿)。真判据是下面那条 socket。
    assert_eq!(slot.dial.inflight(), 0, "撤位后在飞表清空");
    assert!(slot.dial_due().is_none(), "撤位期不拨号(§6 撤位清单)");
    let mut link = FakeLink { stream: sock };
    // 5s 是**余量**不是期望值(实测亚毫秒):没被取消的话这只任务还得活 600s,故这一格
    // 分辨的仍是「取消了没」,而不是「快不快」。
    assert!(link.closed(5000).await, "取消掉的握手把 socket 一起带走");
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
        timeout(Duration::from_secs(10), l.accept()).await.expect("该有人拨进来").expect("accept");
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
///
/// 余量同上一只:由 [`lan_net::DialBudgetGuard`] 拉开,别拿生产那 2s 去分辨(310)。
#[tokio::test]
async fn retiring_the_slot_cancels_an_in_flight_dial() {
    let _net = lan_net::TestNetGuard::install(LAN_SELF_ADDR, 24);
    let _budget = lan_net::DialBudgetGuard::install(600);
    let mut r = dial_rig("lan-dial-retire", 50, true).await;
    let l = r.listener.take().expect("假对端在听");
    r.round();
    // 接下它的连接但一言不发:拨号任务就停在「等 Accept」上(上面那枚计时覆盖位把它
    // 从 2s 拉到了 600s)。10s 是给宿主调度的余量:连接由内核当场完成,正常是亚毫秒。
    let (sock, _) =
        timeout(Duration::from_secs(10), l.accept()).await.expect("该有人拨进来").expect("accept");
    assert_eq!(r.dial.inflight(), 1, "此刻恰有一只在飞的出站握手");
    r.dial.retire();
    assert_eq!(r.dial.inflight(), 0, "撤位当场取消,不等它自己超时");
    assert!(r.dial.due().is_none(), "撤位期不挂巡查计时器");
    let mut link = FakeLink { stream: sock };
    assert!(link.closed(5000).await, "取消掉的握手该把 socket 一起带走");
}
