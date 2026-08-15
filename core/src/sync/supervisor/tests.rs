use super::*;
use crate::sync::production_src;
use crate::db;
use std::path::Path;

fn test_db(tag: &str) -> (PathBuf, Connection, Clock) {
    let dir = crate::test_temp::dir().join(format!("zj-sup-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("notebook.sqlite3");
    let conn = db::open(&path).unwrap();
    let clock = Clock::load(&conn).unwrap();
    (path, conn, clock)
}

fn spec(id: &str, path: &Path, veto: Option<String>) -> (ActivateSpec, mpsc::UnboundedReceiver<SyncEvent>) {
    let (ev_tx, ev_rx) = mpsc::unbounded_channel();
    (
        ActivateSpec {
            id: id.into(),
            path: path.to_path_buf(),
            expected_file: None,
            events: ev_tx,
            boot_dir: path.parent().unwrap().to_path_buf(),
            blob_policy: BlobPolicy::Full,
            allow_boot_source: true,
            sync_veto: veto,
        },
        ev_rx,
    )
}

async fn wait_state(status: &Arc<Mutex<SyncStatus>>, want: &str) {
    for _ in 0..200 {
        if status.lock().unwrap().state == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("状态未达 {want}(现为 {})", status.lock().unwrap().state);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn activate_runs_transport_and_stop_joins_it() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None);
    let (path, conn, clock) = test_db("run");
    let (s, _ev) = spec("main", &path, None);
    let rt = sup.activate(s, conn, clock).unwrap();
    assert_eq!(rt.generation, 1);
    assert_eq!(sup.count(), 1);
    // 未配置账户:任务上线即 off,睡在控制通道上。
    wait_state(&rt.status, "off").await;
    // stop 唤它退出并等到真退出;表随之空;同 id 可再激活(代次递增)。
    sup.stop("main").await.unwrap();
    assert_eq!(sup.count(), 0);
    assert!(sup.get("main").is_err());
    let (path2, conn2, clock2) = test_db("run2");
    let (s2, _ev2) = spec("main", &path2, None);
    let rt2 = sup.activate(s2, conn2, clock2).unwrap();
    assert!(rt2.generation > rt.generation, "代次单调递增");
    sup.stop("main").await.unwrap();
}

/// **停机先摘局域网准入条目**(lan-direct-plan §6 / L-c3a 实现审 H1)。行为半:
/// `stop` 之后条目必须不在了(注册者号 = 本次激活的代次,故 supervisor 说得出摘谁的)。
/// 顺序半靠下面那条词法锚——「在 transport 退出之前就摘掉了」这件事,行为测只有把
/// 停机卡住才看得见,而那要么改产品代码要么造不出确定时刻。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_drops_the_lan_admission_seat() {
    let lan = transport::LanAdmission::ephemeral();
    let sup = SpaceSupervisor::new(
        tokio::runtime::Handle::current(),
        2,
        Some(Arc::clone(&lan)),
    );
    let (path, conn, clock) = test_db("lan-seat");
    // **刻意用 veto 空间**:它压根不 spawn transport,故没有 `AdmitLease` 会在 `run`
    // 收场时替 `stop` 把条目摘掉——这条测因此真的只证 `stop` 自己那一句。用正常空间
    // 的话,把 `drop_lan_seat` 整句删掉本测照样绿(lease 顺手背了书),那就是假绿
    // (变异对照当场抓到过)。
    let (s, _ev) = spec("main", &path, Some("测试:此空间同步停用".into()));
    let rt = sup.activate(s, conn, clock).unwrap();
    assert!(rt.veto().is_some(), "veto 空间不起 transport");
    // 手工放一条同号条目当探针(veto 空间自然不会自己注册)。
    let (handoff, _rx) = mpsc::channel(4);
    lan.register(crate::sync::lan_net::Registration {
        space_id: "main".into(),
        owner: rt.generation,
        account_id: "01ACCTAAAAAAAAAAAAAAAAAAAA".into(),
        self_device: "01SELFAAAAAAAAAAAAAAAAAAAA".into(),
        k_acc: [5u8; 32],
        self_seed: [6u8; 32],
        db: rt.db.clone(),
        active: Arc::new(Mutex::new(std::collections::HashSet::new())),
        handoff,
    })
    .expect("探针条目该放得进去");
    assert!(lan.epoch_of("main").is_some(), "条目在");
    sup.stop("main").await.unwrap();
    assert!(lan.epoch_of("main").is_none(), "stop 必须把准入条目摘掉");

    // **而且是最终撤席,不是临时撤位**(L-c3b 四轮 H1):那个 runtime 的 transport 可能
    // 还没观察到停机信号,它每 15s 一轮的拨号巡查会拿着仍然存在的席位再注册一次——摘了
    // 又被插回去,「Stopping 之后不再认新链」就白设了。同代重注册必须被拒。
    let probe = |owner: u64| crate::sync::lan_net::Registration {
        space_id: "main".into(),
        owner,
        account_id: "01ACCTAAAAAAAAAAAAAAAAAAAA".into(),
        self_device: "01SELFAAAAAAAAAAAAAAAAAAAA".into(),
        k_acc: [5u8; 32],
        self_seed: [6u8; 32],
        db: rt.db.clone(),
        active: Arc::new(Mutex::new(std::collections::HashSet::new())),
        handoff: mpsc::channel(4).0,
    };
    assert!(lan.register(probe(rt.generation)).is_err(), "已撤销的代次不许把条目插回去");
    assert!(lan.epoch_of("main").is_none(), "条目没被复活");
    // 新 runtime(更高代次)照常:撤席不是「这个空间从此不能直连」。
    assert!(lan.register(probe(rt.generation + 1)).is_ok(), "新 runtime 该注册得上");
}

/// 顺序锚:`stop` 与 `begin_reset` 里,摘准入条目必须排在拉停机信号**之前**。
#[test]
fn the_lan_seat_is_dropped_before_the_shutdown_signal() {
    let src = include_str!("../supervisor.rs");
    let prod = production_src(src, "supervisor.rs");
    let drops: Vec<usize> = prod.match_indices("self.drop_lan_seat(id,").map(|(i, _)| i).collect();
    let signals: Vec<usize> =
        prod.match_indices("rt.shutdown.send(true)").map(|(i, _)| i).collect();
    assert_eq!(drops.len(), 2, "两条收场路径(stop / begin_reset)各一次");
    assert_eq!(signals.len(), 2, "停机信号也恰两处");
    for (d, s) in drops.iter().zip(signals.iter()) {
        assert!(d < s, "摘条目必须排在拉停机信号之前");
    }
}

/// is_stopped(跨空间移动的目标槽位闸,codex 安卓实现审 #1):Running 空间 false;
/// 从未激活的 id 与停机后都是 true(表里无槽 = 可安全开一次性写连接)。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn is_stopped_reflects_slot_presence() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None);
    let (path, conn, clock) = test_db("stopq");
    let (s, _ev) = spec("main", &path, None);
    sup.activate(s, conn, clock).unwrap();
    assert!(!sup.is_stopped("main"), "Running 空间在场");
    assert!(sup.is_stopped("never"), "从未激活的 id 无槽");
    sup.stop("main").await.unwrap();
    assert!(sup.is_stopped("main"), "停机后表里无槽");
    // Resetting 墓碑(重置半途)也算「在场」——否则跨空间移动会绕过墓碑写坏正被
    // 重置的库(codex 安卓实现审 #1)。未激活的 id begin_reset 直接立墓碑。
    let _ticket = sup.begin_reset("resetme").await.unwrap();
    assert!(!sup.is_stopped("resetme"), "Resetting 墓碑在场");
}

/// restart_required(space-entry-plan §3.2):旗与 transport 的 restart_flag 是
/// 同一枚 Arc(判定那一刻置位即读得到),壳层写闸据 accessor 拒写。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_required_flag_is_shared_and_readable() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None);
    let (path, conn, clock) = test_db("restart");
    let (s, _ev) = spec("main", &path, None);
    let rt = sup.activate(s, conn, clock).unwrap();
    assert!(rt.restart_required().is_none());
    *rt.restart_required.lock().unwrap() = Some("须重开".into());
    assert_eq!(rt.restart_required().as_deref(), Some("须重开"));
    sup.stop("main").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn activate_rejects_duplicate_and_over_limit() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 1, None);
    let (path_a, conn_a, clock_a) = test_db("cap-a");
    let (s, _ev) = spec("a", &path_a, None);
    sup.activate(s, conn_a, clock_a).unwrap();
    // 重复激活 = 编排 bug,响亮拒。
    let (path_a2, conn_a2, clock_a2) = test_db("cap-a2");
    let (s, _ev2) = spec("a", &path_a2, None);
    assert!(sup.activate(s, conn_a2, clock_a2).map(|_| ()).unwrap_err().contains("已激活"));
    // 超 max_live(手机=1)拒:切空间必须先 stop 再 activate。
    let (path_b, conn_b, clock_b) = test_db("cap-b");
    let (s, _ev3) = spec("b", &path_b, None);
    assert!(sup.activate(s, conn_b, clock_b).map(|_| ()).unwrap_err().contains("上限"));
    sup.stop("a").await.unwrap();
    // permit 交还后可起新空间。
    let (path_b2, conn_b2, clock_b2) = test_db("cap-b2");
    let (s, _ev4) = spec("b", &path_b2, None);
    sup.activate(s, conn_b2, clock_b2).unwrap();
    sup.stop("b").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vetoed_space_has_no_task_and_stop_is_still_clean() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None);
    let (path, conn, clock) = test_db("veto");
    let (s, _ev) = spec("v", &path, Some("身份撞了".into()));
    let rt = sup.activate(s, conn, clock).unwrap();
    // 不 spawn transport:状态固化 off + 原因;控制通道是死信箱。
    {
        let st = rt.status.lock().unwrap();
        assert_eq!(st.state, "off");
        assert_eq!(st.error.as_deref(), Some("身份撞了"));
    }
    assert_eq!(rt.veto().as_deref(), Some("身份撞了"));
    assert!(rt.control.try_send(Control::Reconfigured).is_err(), "veto 空间的控制通道必须是死信箱");
    // 本地数据照常可用(写锁面就绪)。
    drop(rt.write_locks());
    sup.stop("v").await.unwrap();
    assert_eq!(sup.count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn activate_rejects_swapped_file_against_descriptor_key() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None);
    let (path, conn, clock) = test_db("swap");
    // descriptor 记录的是「另一个文件」的身份 → 激活时现算不符,拒。
    let other = path.parent().unwrap().join("other.bin");
    std::fs::write(&other, b"x").unwrap();
    let (mut s, _ev) = spec("s", &path, None);
    s.expected_file = Some(crate::spaces::native_file_key(&other).unwrap());
    let err = sup.activate(s, conn, clock).map(|_| ()).unwrap_err();
    assert!(err.contains("不符"), "{err}");
    assert_eq!(sup.count(), 0, "复核失败不占坑");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn activate_rejects_conn_not_backed_by_expected_file() {
    // path/expected 指 A、传入的 conn 却开着 B(装配错位):UI 会显示 A、
    // transport 实际写 B——必须拒(codex 二轮 M2 的 conn↔path 绑定)。
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None);
    let (path_a, conn_a, _clock_a) = test_db("bind-a");
    drop(conn_a);
    let (_path_b, conn_b, clock_b) = test_db("bind-b");
    let (mut s, _ev) = spec("bind", &path_a, None);
    s.expected_file = Some(crate::spaces::native_file_key(&path_a).unwrap());
    let err = sup.activate(s, conn_b, clock_b).map(|_| ()).unwrap_err();
    assert!(err.contains("不是同一个文件"), "{err}");
    assert_eq!(sup.count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_cancels_transport_stuck_in_handshake() {
    // 停机必须在拨号/WS 握手中也生效(multispace-plan §6;codex H2):连上一个
    // 永不应答 WS 升级的端口,session 挂在握手窗口里,stop 仍须秒级返回。
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    // 刻意不 accept:TCP 在 backlog 里已完成握手,WS 升级请求永无响应。
    let (path, conn, clock) = test_db("stuck");
    conn.execute_batch(&format!(
        "INSERT INTO sync_meta(key,value) VALUES
           ('account_id','01AAAAAAAAAAAAAAAAAAAAACCT'),
           ('k_acc','{z}'),('device_key','{z}'),('server_url','{url}');",
        z = "00".repeat(32),
    ))
    .unwrap();
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 1, None);
    let (s, _ev) = spec("stuck", &path, None);
    let rt = sup.activate(s, conn, clock).unwrap();
    wait_state(&rt.status, "connecting").await;
    let t0 = std::time::Instant::now();
    sup.stop("stuck").await.unwrap();
    assert!(
        t0.elapsed() < Duration::from_secs(5),
        "握手挂死不许拖住停机:{:?}",
        t0.elapsed()
    );
    assert_eq!(sup.count(), 0);
    drop(listener);
}

/// M1(工序 9 二审):reserve 原子占坑 + 占 permit,但对命令面不可见(Starting);
/// 满员再 reserve 拒;Drop 交还 permit——「开第二条连接前先占坑」的地基。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reserve_holds_permit_invisible_and_releases_on_drop() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 1, None);
    let r = sup.reserve("a").unwrap();
    assert_eq!(sup.count(), 1, "Starting 计入 permit");
    assert!(sup.get("a").map(|_| ()).unwrap_err().contains("正在启动"), "Starting 对 get 不可见");
    assert!(sup.all().is_empty(), "Starting 不算在场");
    // permit 已满:第二个 reserve 拒,不占第二坑。
    assert!(sup.reserve("b").map(|_| ()).unwrap_err().contains("上限"));
    // 放手预留 → permit 交还、坑清空;可再预留。
    drop(r);
    assert_eq!(sup.count(), 0);
    assert!(sup.reserve("b").is_ok(), "permit 交还后可再预留");
}

/// H1(工序 9 二审):stop 必须等在飞长命令(配对)放手 runtime 后才收场,且置
/// closing 挡新长命令——这才让「切走当前正在配对的空间」不会与「切回后重激活」
/// 撞出第二条写连接。guard 未放 = stop 卡在 op-wait;begin_op 见 closing 即拒;
/// guard 一放 stop 迅速收场。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_waits_for_in_flight_op_and_blocks_new_ones() {
    let sup = Arc::new(SpaceSupervisor::new(tokio::runtime::Handle::current(), 1, None));
    let (path, conn, clock) = test_db("op");
    let (s, _ev) = spec("a", &path, None);
    let rt = sup.activate(s, conn, clock).unwrap();
    wait_state(&rt.status, "off").await;
    // 模拟配对在飞:取一个长命令 guard(active_ops=1)。
    let guard = rt.begin_op().expect("Ready 空间可开长命令");
    // stop 在别的任务里跑:guard 未放,应卡在 op-wait,不完成。
    let sup2 = sup.clone();
    let stopping = tokio::spawn(async move { sup2.stop("a").await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!stopping.is_finished(), "guard 未放,stop 不该完成");
    // closing 已置:新长命令被拒(切换收场期不再开配对)。
    assert!(rt.begin_op().is_none(), "stop 已置 closing,新 begin_op 必拒");
    // 放手 guard → stop 迅速收场成功、表清空。
    drop(guard);
    let r = tokio::time::timeout(Duration::from_secs(5), stopping)
        .await
        .expect("guard 放后 stop 应迅速完成")
        .unwrap();
    r.unwrap();
    assert_eq!(sup.count(), 0);
}

/// epoch-plan §7:begin_reset 原子换墓碑(get/activate/stop/reserve 全拒)→
/// 会话收场 + **强引用归零证明**(调用方还攥着 Arc 时等它放手才继续)→ 文件
/// 操作窗口 → finish_reset 按 token 删墓碑;**不 finish = 墓碑留下**(fail-closed
/// 阴性对照:文件步失败绝不放行重新激活)。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn begin_reset_tombstones_waits_for_refs_and_finish_releases() {
    let sup = Arc::new(SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None));
    let (path, conn, clock) = test_db("reset");
    let (s, _ev) = spec("a", &path, None);
    let rt = sup.activate(s, conn, clock).unwrap();
    wait_state(&rt.status, "off").await;
    // 调用方(壳)还攥着一个 Arc:begin_reset 必须等它放手(强引用归零证明)。
    let holder = rt.clone();
    drop(rt);
    let sup2 = sup.clone();
    let resetting = tokio::spawn(async move { sup2.begin_reset("a").await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!resetting.is_finished(), "Arc 未放手,begin_reset 不得完成");
    // 墓碑已立:命令面/激活/停止全拒。
    assert!(sup.get("a").map(|_| ()).unwrap_err().contains("重置"));
    assert!(sup.reserve("a").map(|_| ()).unwrap_err().contains("已激活或"));
    assert!(sup.stop("a").await.unwrap_err().contains("重置"));
    drop(holder);
    let ticket = tokio::time::timeout(Duration::from_secs(5), resetting)
        .await
        .expect("Arc 放手后 begin_reset 应完成")
        .unwrap()
        .unwrap();
    assert_eq!(ticket.space_id(), "a");
    // 文件操作窗口:墓碑仍挡着(fail-closed——此刻若不 finish,空间永封)。
    assert!(sup.get("a").map(|_| ()).unwrap_err().contains("重置"));
    assert_eq!(sup.count(), 1, "墓碑计入表");
    sup.finish_reset(ticket);
    assert!(sup.get("a").map(|_| ()).unwrap_err().contains("未知空间"));
    assert_eq!(sup.count(), 0);
    // 重置完成后同 id 可再激活(重配对回来的新库)。
    let (path2, conn2, clock2) = test_db("reset2");
    let (s2, _ev2) = spec("a", &path2, None);
    sup.activate(s2, conn2, clock2).unwrap();
    sup.stop("a").await.unwrap();
}

/// **373 真机量出的那条重置患**:有局域网直连链路时「重置空间」必败,且空间被墓碑封死
/// (`lan_peers=1` 败 2/2、`lan=0` 过 3/3;重启 app 不是解——链路几秒就回来)。
///
/// 病不在链路上,在「**强引用归零是异步才发生的事**」:transport 退出时 `abort()` 掉的
/// 那几族任务(每链的 LAN 读/写泵、准入表里未移交的 pre-auth 握手、在飞的拨号)各攥着一
/// 份 db 克隆,而 db 那道证明原先是**单发**的——判死到 runtime 收尸之间那一瞬,它必然还
/// 没归零,于是报「必是 bug」。那句断言本身是错的:不需要任何 bug 就走得到。
///
/// 夹具取**最狠的那一档**模型:一只已派出的 `spawn_blocking` 闭包攥着克隆(句柄当场丢掉
/// = 分离,而阻塞任务本就不可取消,连 abort 都停不下来)。它比真实那几族更难吸收,故过了
/// 这一关的修法对真实收尾路径恒成立。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn begin_reset_absorbs_a_late_db_arc_release() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None);
    let (path, conn, clock) = test_db("resetlate");
    let (s, _ev) = spec("a", &path, None);
    let rt = sup.activate(s, conn, clock).unwrap();
    wait_state(&rt.status, "off").await;
    // 克隆在 spawn 那一刻就被闭包捕获了,故「计数已经是 2」与闭包排到没排到无关
    // ——这条红是确定的,不靠调度赛跑。
    let late = Arc::clone(&rt.db);
    drop(tokio::task::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(400));
        drop(late);
    }));
    drop(rt);
    let ticket = tokio::time::timeout(Duration::from_secs(9), sup.begin_reset("a"))
        .await
        .expect("begin_reset 不得挂到超时")
        .expect("迟到的 db 克隆必须被有界重试吸收掉");
    assert_eq!(ticket.space_id(), "a");
    // 吸收 ≠ 放宽判据:重置照常走完(墓碑仍在),finish 之后空间才真正离表。
    assert!(sup.get("a").map(|_| ()).unwrap_err().contains("重置"));
    sup.finish_reset(ticket);
    assert!(sup.get("a").map(|_| ()).unwrap_err().contains("未知空间"));
}

/// 上一条的**另一半**:有界重试吸收的只是「刚判死还没收尸」那个必然窗口,**它不放宽
/// 判据**。真有人永不放手时必须 fail-closed —— `Err` + 墓碑留下,文件步一个字节都不许动。
///
/// 这一格此前**无人守**(374 变异③:把 db 那道强引用归零证明整格拆掉,两只 begin_reset
/// 的测一只都不红)。它守的是数据安全红线:Unix/Android 上 unlink 一个还开着的库,旧连接
/// 会接着写那个匿名 inode,同路径再建新库 = 真双写分叉。
///
/// 走**虚拟时钟**(`start_paused`:全部任务空闲时 tokio 自动把时间跳到下一个定时器),
/// 故那 10s 死线在挂钟上一瞬即过,不给测试套加十秒。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn begin_reset_fails_closed_when_a_db_ref_never_lets_go() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None);
    let (path, conn, clock) = test_db("resetstuck");
    let (s, _ev) = spec("a", &path, None);
    let rt = sup.activate(s, conn, clock).unwrap();
    wait_state(&rt.status, "off").await;
    // 攥着不放的一份 db 克隆(模型:一只永远收不了尸的收尾任务)。
    let stuck = Arc::clone(&rt.db);
    drop(rt);
    let err = sup.begin_reset("a").await.map(|_| ()).unwrap_err();
    assert!(err.contains("库连接仍被引用"), "{err}");
    // 宁封锁不双写:墓碑留下(调用方据此**不做**文件步),空间此后不可用也不可激活。
    assert!(sup.get("a").map(|_| ()).unwrap_err().contains("重置"));
    assert_eq!(sup.count(), 1, "墓碑计入表");
    drop(stuck);
}

/// 未激活空间(手机后台空间/桌面未开)重置:直插墓碑挡并发激活,finish 即除。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn begin_reset_on_inactive_space_inserts_tombstone() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 2, None);
    let ticket = sup.begin_reset("ghost").await.unwrap();
    assert!(sup.get("ghost").map(|_| ()).unwrap_err().contains("重置"));
    // 文件操作期间不许把它激活出来。
    let (path, conn, clock) = test_db("ghost");
    let (s, _ev) = spec("ghost", &path, None);
    assert!(sup.activate(s, conn, clock).map(|_| ()).unwrap_err().contains("已激活或"));
    // 重复 begin_reset 拒(已在重置中)。
    assert!(sup.begin_reset("ghost").await.unwrap_err().contains("已在重置中"));
    sup.finish_reset(ticket);
    assert!(sup.get("ghost").map(|_| ()).unwrap_err().contains("未知空间"));
}

/// M2(工序 9 二审):commit 的 spec.id 与预留 id 不符(编排 bug)→ 运行期 Err、
/// **未 spawn 任何 transport**,预留由带 token 的 Drop 回收(count 归 0、permit
/// 不泄漏)。修前 debug_assert 在 release 下空转 + 失效分支置 active=false 会泄漏。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reservation_commit_wrong_id_releases_and_spawns_nothing() {
    let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), 1, None);
    let r = sup.reserve("a").unwrap();
    assert_eq!(sup.count(), 1, "预留占 permit");
    // 错传 spec.id=b:commit 早退 Err(id 不符,未进 commit_reservation、未 spawn),
    // Drop 回收 a 的 Starting。
    let (path, conn, clock) = test_db("wrongid");
    let (s, _ev) = spec("b", &path, None);
    let err = r.commit(s, conn, clock).map(|_| ()).unwrap_err();
    assert!(err.contains("不符"), "{err}");
    assert_eq!(sup.count(), 0, "错 id 的 commit 后预留必被回收、permit 不泄漏");
    // permit 已还:a 可重新走完整激活(不被幽灵预留占着上限)。
    let (path2, conn2, clock2) = test_db("wrongid2");
    let (s2, _ev2) = spec("a", &path2, None);
    sup.activate(s2, conn2, clock2).unwrap();
    assert_eq!(sup.count(), 1);
    sup.stop("a").await.unwrap();
}
