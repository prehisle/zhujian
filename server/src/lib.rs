//! zhujian-syncd —— 朱简同步专用服务(sync-protocol §4)。
//!
//! 单 Rust 二进制:设备鉴权(Ed25519 挑战应答;准入开放,封禁表拒名单——
//! open-signup)+ 账户内密文帧路由 + 内存信箱 + 配对盲桥。**对一切用户内容
//! 零知识**:信封(sync-proto)是唯一可读面,`blob` 恒是域子钥下的密文;落盘
//! 只有 registry(账户/设备/公钥)与封禁表,日志只记元数据与计量(§11 落盘清单)。
//!
//! 库面暴露 [`serve`] 供集成测在随机端口起真服务;`main.rs` 是薄壳。

mod conn;
pub mod hub;
pub mod registry;
pub mod throttle;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use tokio::task::JoinHandle;

use hub::Hub;
use registry::{Entitlement, Registry, RevokeError, RevokeOutcome, SetEntitlementError};

/// 服务配置。容量/超时是规格常量的可注入形态(sync-protocol §3/§4)——`main`
/// 恒用规格默认([`Config::new`]),集成测注入小值/短时把「溢出丢最老 / TTL /
/// 静默判死」测进秒级(显式参数化,不是回退兜底)。
#[derive(Clone)]
pub struct Config {
    pub banlist_path: PathBuf,
    pub registry_path: PathBuf,
    pub mailbox_max_bytes: usize,
    pub mailbox_max_frames: usize,
    pub mailbox_ttl: Duration,
    pub pair_slot_ttl: Duration,
    /// 全局同时开着的配对槽数上限(超限 = busy;codex P2-e 轮 M2 的资源面)。
    pub pair_slot_cap: usize,
    pub silence_timeout: Duration,
    pub sweep_interval: Duration,
    /// 每账户设备数**服务器安全硬帽**(epoch-plan §5.2 #2 / billing-plan §5 两层判据
    /// 的容量层;商业层 seat_quota 走 entitlement,两层取 min、双错误码)。
    pub device_cap: usize,
    /// 纪元席位租约 TTL(billing-plan §5:未消费到点即失效;正常流程同一条短连接
    /// 内秒级消费,长 TTL 只是仪式重试余量)。
    pub seat_lease_ttl: Duration,
    /// 全局统一内存预算(§5.2 #2:信箱 + 在线下行队 + 配对桥一个体系;
    /// 对 systemd `MemoryMax=512M` 留半)。用量派生不存(hub 现算),宁拒不 OOM。
    pub budget_global_bytes: usize,
    /// 每账户预算份额(超则先驱逐该账户 mailbox 最老,再摘占用最大的在线连接)。
    pub budget_account_bytes: usize,
    /// 单连接下行字节闸(§5.2 #4;帧数闸 = channel 容量既有,双闸齐拦慢客户端)。
    pub conn_max_bytes: usize,
    /// 配对桥每槽累计配额(§5.2 #5:帧数 / 字节,超即烧槽)。
    pub pair_slot_max_frames: u64,
    pub pair_slot_max_bytes: usize,
    /// 达量速率(169,工序 3;字节/秒)。超月度 grant 后普通会话按此速率排队。宽松
    /// 默认 1 MiB/s=现网无感;启动校验 `device_cap·MAX_FRAME/rate ≤ silence/3`(见
    /// [`serve_inner`]),注入的小 rate 也过此校验、不许贴界。
    pub throttle_rate_bps: u64,
    /// meters sidecar 路径(粗 checkpoint 落 fastlane_used+period;grant 在 registry)。
    pub meters_path: PathBuf,
    /// checkpoint 时间触发(默认 60s;与脏字节阈值谁先到谁触发)。
    pub checkpoint_interval: Duration,
    /// checkpoint 脏字节阈值(默认 16 MiB;有状态、丢一次 tick 不退化)。
    pub checkpoint_dirty_bytes: u64,
    /// 免费档月度 fastlane 额度(169;默认 = `registry::FREE_FASTLANE_BYTES_PER_MONTH`
    /// 300 MiB,是「草值、开闸前按真实观测定」)。生产用默认;**测试注入小值烤限速
    /// 路径**(fresh 账户 grant floor 即取此值,无需 admin 也能触发越额)。
    pub free_fastlane_bytes_per_month: u64,
    /// 免费档席位数(默认 = `registry::FREE_SEAT_QUOTA` 2)。推广期生产走 CLI
    /// `--free-seat-quota 4` 注入=夫妻各手机+电脑够用、比逐个 admin 提额简单;收费期
    /// 改回默认即可、不重编。**测试恒用默认 2**(registry/hub 单元测有 free=2 假设,
    /// 别改常量)。硬帽 `device_cap` 是另一层、两层取 min,故此值 ≤ device_cap 才有意义。
    pub free_seat_quota: u32,
    /// 停机 drain 超时(169;默认 5s)。SIGTERM 关栅后等 in-flight 计数归零的上限;
    /// 超时 = best-effort checkpoint + 非零退出(不称最终快照)。测试注入短值烤超时路径。
    pub shutdown_drain_timeout: Duration,
}

impl Config {
    /// 规格默认(§3/§4:信箱 64 MiB·8192 帧·TTL 72h,槽 TTL 10 分钟,静默 90s)。
    pub fn new(banlist_path: PathBuf, registry_path: PathBuf) -> Self {
        let meters_path = registry_path.with_file_name("meters.json");
        Config {
            banlist_path,
            registry_path,
            mailbox_max_bytes: sync_proto::MAILBOX_MAX_BYTES,
            mailbox_max_frames: sync_proto::MAILBOX_MAX_FRAMES,
            mailbox_ttl: Duration::from_secs(sync_proto::MAILBOX_TTL_SECS),
            pair_slot_ttl: Duration::from_secs(sync_proto::PAIR_SLOT_TTL_SECS),
            pair_slot_cap: 4096,
            silence_timeout: Duration::from_secs(sync_proto::SILENCE_TIMEOUT_SECS),
            sweep_interval: Duration::from_secs(60),
            device_cap: 8,
            seat_lease_ttl: Duration::from_secs(sync_proto::SEAT_LEASE_TTL_SECS),
            budget_global_bytes: 256 * 1024 * 1024,
            budget_account_bytes: 96 * 1024 * 1024,
            conn_max_bytes: 32 * 1024 * 1024,
            pair_slot_max_frames: 256,
            pair_slot_max_bytes: 4 * 1024 * 1024,
            throttle_rate_bps: 1024 * 1024, // 1 MiB/s(宽松:上界 8·1MiB/1MiBps=8s ≤ 90/3)
            meters_path,
            checkpoint_interval: Duration::from_secs(60),
            checkpoint_dirty_bytes: 16 * 1024 * 1024,
            free_fastlane_bytes_per_month: registry::FREE_FASTLANE_BYTES_PER_MONTH,
            free_seat_quota: registry::FREE_SEAT_QUOTA,
            shutdown_drain_timeout: Duration::from_secs(5),
        }
    }
}

/// 停机退出码真值表(169,codex 实现审 M:提成无副作用小函数便于测,避免测里
/// `process::exit`)。**唯一成功出口 = 干净 drain + 落盘成功**;其余非零(超时/落盘失败/
/// worker 无 ack 都不得声称最终快照)。SIGTERM 编排是 `#[cfg(unix)]`,非 unix 只测里用。
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn shutdown_exit_code(drained: bool, flush_ok: bool) -> i32 {
    if drained && flush_ok {
        0
    } else {
        1
    }
}

/// 极简日志:stderr 一行一事,UTC 时间戳。**永不落帧内容与密钥**(§4)。
pub(crate) fn logln(line: String) {
    let ts = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "-".into());
    eprintln!("[{ts}] {line}");
}

/// 绑定并启动(`/ws` 同步面 + `/healthz` 探针 + 定期清扫)。
/// 返回实际监听地址(`:0` 时拿随机端口,集成测用)与服务任务柄。
pub async fn serve(
    listen: SocketAddr,
    cfg: Config,
) -> std::io::Result<(SocketAddr, JoinHandle<()>)> {
    let (addr, _admin, handle) = serve_inner(listen, None, cfg).await?;
    Ok((addr, handle))
}

/// 同 [`serve`],另起 **admin 面**(H1 运营侧吊销,deploy §2):
/// * **只许回环地址**(fail-fast 拒绝其它绑定)——生产 Caddy 把公网域名整站反代
///   到同步端口,admin 若同端口挂路由就等于公开;且经反代的请求源地址恒是
///   localhost,来源过滤形同虚设。物理分端口 + 不进反代,才是网络边界。
/// * **必须带 admin token**(≥ 32 字符;请求头 `Authorization: Bearer <token>`)
///   ——回环只隔离网络,不隔离共机的其它进程(本机还跑着 Docker/napcat 等,
///   SSRF/容器逃逸都够得着 127.0.0.1),吊销是破坏性接口,再加一道钥匙。
/// 返回 (同步地址, admin 地址, 服务柄)。
pub async fn serve_with_admin(
    listen: SocketAddr,
    admin_listen: SocketAddr,
    admin_token: String,
    cfg: Config,
) -> std::io::Result<(SocketAddr, SocketAddr, JoinHandle<()>)> {
    if !admin_listen.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("--admin-listen 只许回环地址(127.0.0.1/::1),拒绝 {admin_listen}"),
        ));
    }
    let admin_token = admin_token.trim().to_owned();
    if admin_token.len() < 32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "admin token 太短(≥ 32 字符;openssl rand -hex 32 生成)",
        ));
    }
    let (addr, admin, handle) = serve_inner(listen, Some((admin_listen, admin_token)), cfg).await?;
    Ok((addr, admin.expect("admin_listen 已给必有"), handle))
}

async fn serve_inner(
    listen: SocketAddr,
    admin_listen: Option<(SocketAddr, String)>,
    cfg: Config,
) -> std::io::Result<(SocketAddr, Option<SocketAddr>, JoinHandle<()>)> {
    // 席位闸配置不变量(codex 160 L6):register_first 的「席位闸空成立」论证依赖
    // 硬帽 ≥1;0 帽=谁也注册不上、0 TTL=租约生成即死,都是配置错误,fail-fast。
    if cfg.device_cap == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "device_cap 须 ≥1(0=任何设备都注册不上,配置错误)",
        ));
    }
    if cfg.seat_lease_ttl.is_zero() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "seat_lease_ttl 须 >0(0=租约生成即死,满席纪元切换被堵死)",
        ));
    }
    // 达量限速上界校验(169,工序 3;codex C/G,§4 不变量②③):单帧最大限速等待
    // = device_cap·MAX_FRAME/rate ≤ silence/3(留 2/3 给路由/调度/心跳)。注入的 rate
    // 也过此校验、不许贴界配死限速(测试用小 quota 烤限速路径,不动这条上界)。
    if cfg.throttle_rate_bps == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "throttle_rate_bps 须 >0(0=限速即死锁,§4 不变量①)",
        ));
    }
    // 毫秒口径避免 as_secs 把亚秒 silence(测试用)截成 0:
    //   device_cap·MAX_FRAME·3 ≤ rate·silence_s  ⇔  device_cap·MAX_FRAME·3·1000 ≤ rate·silence_ms
    let max_wait_num = (cfg.device_cap as u128) * (sync_proto::MAX_FRAME_BYTES as u128) * 3 * 1000;
    let bound = (cfg.throttle_rate_bps as u128) * cfg.silence_timeout.as_millis();
    if max_wait_num > bound {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "throttle 上界超 silence/3:device_cap({})·MAX_FRAME·3 > rate({} B/s)·silence({}ms)——提高 throttle_rate_bps 或降 device_cap",
                cfg.device_cap,
                cfg.throttle_rate_bps,
                cfg.silence_timeout.as_millis()
            ),
        ));
    }
    let registry = Registry::load(&cfg.banlist_path, cfg.registry_path.clone())?;
    let sweep_interval = cfg.sweep_interval;
    let meters_path = cfg.meters_path.clone();
    let checkpoint_interval = cfg.checkpoint_interval;
    let checkpoint_dirty = cfg.checkpoint_dirty_bytes;
    let hub = Arc::new(Hub::new(cfg, registry));
    // 启动从 sidecar 恢复计量(fastlane_used+period;损坏=从零+告警,grant 在 registry)。
    hub.restore_meters(throttle::load_sidecar(&meters_path));
    let app = Router::new()
        .route("/ws", get(ws_upgrade))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(hub.clone());
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let addr = listener.local_addr()?;
    // admin 面先绑后起(端口占用当场爆,不留「同步在跑、admin 没起」的静默残废);
    // 任务柄交给主服务任务,主服务退出时一并收掉(不留无主 detached 任务)。
    let mut admin_task: Option<JoinHandle<()>> = None;
    let admin_addr = match admin_listen {
        None => None,
        Some((al, token)) => {
            // 鉴权做成 Router 层 middleware(159 codex M3):handler 的 extractor
            // (Query 数字解析等)在 middleware **之后**才跑——无 token 的请求连参数
            // 都不被看一眼,恒 401 而非 extractor 的 400;单一真相源,后加路由不会漏。
            let st = AdminState { hub: hub.clone(), token: Arc::new(token) };
            let admin_app = Router::new()
                .route("/admin/devices", get(admin_devices))
                .route("/admin/revoke", post(admin_revoke))
                .route("/admin/entitlement", get(admin_entitlement_get).post(admin_entitlement_set))
                .route_layer(axum::middleware::from_fn_with_state(st.clone(), admin_auth_mw))
                .with_state(st);
            let admin_listener = tokio::net::TcpListener::bind(al).await?;
            let bound = admin_listener.local_addr()?;
            admin_task = Some(tokio::spawn(async move {
                if let Err(e) = axum::serve(admin_listener, admin_app).await {
                    logln(format!("ERROR admin 面退出:{e}"));
                }
            }));
            logln(format!("INFO admin 面监听 http://{bound}/admin(仅回环 + bearer token)"));
            Some(bound)
        }
    };
    let sweep_hub = hub.clone();
    let ckpt_hub = hub.clone();
    // meters checkpoint 的**唯一写者**是下方 worker(codex 实现审 H-2:worker 与
    // SIGTERM 都直调会并发写同一 tmp、旧快照覆盖新)。SIGTERM 的 final flush 不直接
    // 落盘,而是经此命令通道请 worker 落一次、等 oneshot ack。
    let (flush_tx, flush_rx) =
        tokio::sync::mpsc::channel::<tokio::sync::oneshot::Sender<std::io::Result<()>>>(4);
    // 停机信号(SIGTERM/SIGINT):关计量准入栅栏 + 等 in-flight 计数退栏 → 请 worker
    // final flush、等 ack → 退出(169,codex H-3;仅 unix,生产 linux)。drain 后无新
    // 计数,worker 的 flush 是真最终计量快照。
    #[cfg(unix)]
    {
        let term_hub = hub.clone();
        let flush_tx = flush_tx.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(e) => {
                    logln(format!("WARN 监听 SIGTERM 失败,停机 checkpoint 不可用:{e}"));
                    return;
                }
            };
            let mut intr = signal(SignalKind::interrupt()).ok();
            tokio::select! {
                _ = term.recv() => {}
                _ = async { match intr.as_mut() { Some(i) => { i.recv().await; }, None => std::future::pending::<()>().await } } => {}
            }
            logln("INFO 收到停机信号:关计量准入栅栏 → drain → 请 worker 最终 checkpoint → 退出".into());
            // 干净 drain(active 归零)才有资格声称最终快照 + 退 0;超时=best-effort、退非零。
            let drained = term_hub.shutdown_admissions().await;
            let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
            if flush_tx.send(ack_tx).await.is_err() {
                logln("ERROR checkpoint worker 已停,无法 final flush——退出 1".into());
                std::process::exit(1);
            }
            // 保留具体错误(codex L:别只留 bool)——drain 与 flush 各自失败分别高优记录。
            let flush_result = ack_rx.await;
            let flush_ok = matches!(flush_result, Ok(Ok(())));
            if !drained {
                logln("ERROR 停机 drain 超时:best-effort checkpoint 已发但非最终快照(计量窗丢失,grant 在 registry 不受影响)".into());
            }
            match &flush_result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => logln(format!("ERROR 最终 meters checkpoint 落盘失败:{e}(计量窗丢失,grant 在 registry 不受影响)")),
                Err(_) => logln("ERROR checkpoint worker 未回 ack(已停),final flush 未确认".into()),
            }
            let code = shutdown_exit_code(drained, flush_ok);
            if code == 0 {
                logln("INFO 计量已 drain + 最终 meters checkpoint 完成,退出 0".into());
            } else {
                logln(format!("WARN 停机非干净收尾(drain={drained} flush_ok={flush_ok}),退出 {code}"));
            }
            std::process::exit(code);
        });
    }
    // SIGHUP 热重载封禁表(`systemctl reload`):经 hub::reload_banlist 编排——
    // 换集合 + banned 在线设备当场摘租约/kick/烧槽(即时失权,open-signup §1.2);
    // 未涉账户连接不断、信箱不丢。仅 unix(生产 linux);Windows 本机测试无此面,
    // 改动仍可重启生效。
    #[cfg(unix)]
    {
        let sig_hub = hub.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let mut hup = match signal(SignalKind::hangup()) {
                Ok(s) => s,
                Err(e) => {
                    logln(format!("WARN 监听 SIGHUP 失败,封禁表热重载不可用(仍可重启生效):{e}"));
                    return;
                }
            };
            // 锁不跨 await:reload 同步完成、锁在语句内即释放,下一次 await 是 recv。
            while hup.recv().await.is_some() {
                match sig_hub.reload_banlist() {
                    Ok(n) => logln(format!("INFO SIGHUP 封禁表已重载,当前封禁 {n} 个账户")),
                    Err(e) => logln(format!("ERROR SIGHUP 封禁表重载失败,保留旧集合:{e}")),
                }
            }
        });
    }
    // flush_tx keepalive:移进 handle 任务,让命令通道随服务存活(否则非 unix 无
    // SIGTERM 持有者时 flush_rx 立即见 all-senders-dropped)。
    let handle = tokio::spawn(async move {
        let _flush_tx_keepalive = flush_tx;
        let sweeper = tokio::spawn(async move {
            let mut tick = tokio::time::interval(sweep_interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                sweep_hub.sweep();
                sweep_hub.roll_grants_now(); // 月初建当月 grant(169;非月初为 no-op)
            }
        });
        // meters checkpoint worker(169,工序 3;**唯一 sidecar 写者**——H-2):
        // interval / dirty 阈值事件(checkpoint_nudge)/ SIGTERM final flush 命令三触发,
        // 串行处理。有状态判据(dirty_bytes 累计),丢一次唤醒不退化;落盘失败保留 dirty。
        let checkpointer = tokio::spawn(async move {
            let poll = checkpoint_interval.min(Duration::from_secs(10)).max(Duration::from_millis(200));
            let mut tick = tokio::time::interval(poll);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last = tokio::time::Instant::now();
            let mut flush_rx = flush_rx;
            loop {
                tokio::select! {
                    _ = tick.tick() => {}
                    _ = ckpt_hub.checkpoint_nudge().notified() => {}
                    cmd = flush_rx.recv() => match cmd {
                        // SIGTERM final flush:无条件落一次、回 ack(唯一写者串行,无并发覆盖)。
                        Some(ack) => {
                            let _ = ack.send(ckpt_hub.checkpoint_meters());
                            continue;
                        }
                        None => break, // 命令通道全关(服务停机):worker 退出
                    },
                }
                let dirty = ckpt_hub.meters_dirty_bytes();
                if dirty > 0 && (dirty >= checkpoint_dirty || last.elapsed() >= checkpoint_interval) {
                    match ckpt_hub.checkpoint_meters() {
                        Ok(()) => last = tokio::time::Instant::now(),
                        Err(e) => logln(format!(
                            "ERROR meters checkpoint 落盘失败(dirty 保留,下轮重试):{e}"
                        )),
                    }
                }
            }
        });
        // admin 面是真被监督的:任一监听退出,另一侧一并收掉、整个服务任务结束
        // (fail-fast,生产交 systemd Restart=always 拉起;不留「同步在跑、admin
        // 悄悄死了」的静默残废)。
        match admin_task {
            None => {
                if let Err(e) = axum::serve(listener, app).await {
                    logln(format!("ERROR 服务退出:{e}"));
                }
            }
            Some(mut admin) => {
                tokio::select! {
                    r = axum::serve(listener, app) => {
                        if let Err(e) = r {
                            logln(format!("ERROR 服务退出:{e}"));
                        }
                        admin.abort();
                    }
                    _ = &mut admin => {
                        logln("ERROR admin 面退出,同步服务一并退出(fail-fast,交 systemd 拉起)".into());
                    }
                }
            }
        }
        sweeper.abort();
        checkpointer.abort();
    });
    logln(format!("INFO zhujian-syncd 监听 ws://{addr}/ws"));
    Ok((addr, admin_addr, handle))
}

/// admin 面状态:hub + bearer token(回环之外的第二道钥匙,见 serve_with_admin)。
#[derive(Clone)]
struct AdminState {
    hub: Arc<Hub>,
    token: Arc<String>,
}

/// admin 参数(两个接口同形)。open-signup §1.5 起 account 可选:devices 查询仍
/// 必填;revoke 缺 account 时按 device 反查属主(同一把 registry 锁内原子完成)。
#[derive(serde::Deserialize)]
struct AdminQuery {
    account: Option<String>,
    device: Option<String>,
}

/// admin 面统一鉴权 middleware(159 codex M3):**先于一切 handler 与 extractor**
/// ——无 token/错 token 恒 401,请求参数看都不看(不给未鉴权请求任何解析面)。
async fn admin_auth_mw(
    State(st): State<AdminState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if !admin_authorized(req.headers(), &st.token) {
        return (StatusCode::UNAUTHORIZED, "缺/错 Authorization: Bearer <admin-token>\n")
            .into_response();
    }
    next.run(req).await
}

/// `Authorization: Bearer <token>` 核验。token 是 64 位随机 hex;虽然 admin 面只绑
/// 127.0.0.1,仍用常量时间比较——不给同机进程(Docker/SSRF 打到环回)留逐字节短路的
/// 计时侧信道(codex 二审)。
fn admin_authorized(headers: &axum::http::HeaderMap, token: &str) -> bool {
    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match provided {
        Some(p) => constant_time_eq(p.as_bytes(), token.as_bytes()),
        None => false,
    }
}

/// 定长常量时间比较(长度不等直接 false——token 长度非机密)。避免逐字节短路的计时泄漏。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// GET /admin/devices?account=… → 该账户已注册设备号 JSON 数组(吊销前先核对;
/// 未知账户 = 空数组,与「有账户零设备」不作区分——admin 面不需要探测语义)。
async fn admin_devices(
    State(st): State<AdminState>,
    Query(q): Query<AdminQuery>,
) -> (StatusCode, String) {
    let Some(account) = q.account.as_deref() else {
        return (StatusCode::BAD_REQUEST, "缺 account 参数\n".into());
    };
    let devices = st.hub.registry.lock().unwrap().devices_of(account);
    (
        StatusCode::OK,
        serde_json::to_string(&devices).expect("Vec<String> 序列化无失败路径"),
    )
}

/// POST /admin/revoke?device=…[&account=…] → 单设备吊销(H1):registry 删绑定 +
/// 清信箱 + kick 在线连接,原子编排在 hub。account 可省(open-signup §1.5:
/// 无感创号后孤儿只有 device_id 可报,hub 在同一把 registry 锁内反查属主);
/// 给了 account 但与真实属主不符 = 409 零副作用。200=已吊(回执带解析出的
/// 账户),404=没这设备,500=落盘失败(未生效,修好磁盘再来)/ registry 唯一性
/// 被破坏(绝不任选其一吊)。
async fn admin_revoke(
    State(st): State<AdminState>,
    Query(q): Query<AdminQuery>,
) -> (StatusCode, String) {
    let Some(device) = q.device.as_deref() else {
        return (StatusCode::BAD_REQUEST, "缺 device 参数".into());
    };
    match st.hub.revoke_device(q.account.as_deref(), device) {
        Ok((account, RevokeOutcome::DeviceRevoked)) => {
            (StatusCode::OK, format!("已吊销 {account}/{device}\n"))
        }
        // #1 硬化:吊的是账户最后一台设备 → 账户归零封存,如实告知(不再是原来那句
        // 会误导「已彻底切断」的「已吊销」——同 device_id 已不能自助重注册)。
        Ok((account, RevokeOutcome::AccountSealed)) => (
            StatusCode::OK,
            format!(
                "已吊销 {account}/{device};这是账户最后一台设备,账户已归零封存——任何 device_id 都不能再自助 RegisterFirst 重开,重新启用需运营者显式操作(见 deploy runbook)\n"
            ),
        ),
        Err(RevokeError::NotFound) => (
            StatusCode::NOT_FOUND,
            "设备不在 registry(先 GET /admin/devices 核对,或直接按 device 反查)\n".into(),
        ),
        Err(RevokeError::OwnerMismatch) => (
            StatusCode::CONFLICT,
            "account 与该 device 的真实属主不符,未吊销(去掉 account 参数按 device 反查,或核对后重试)\n".into(),
        ),
        Err(RevokeError::Corrupt) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "registry 内 device 归属出现歧义(全局唯一被破坏),拒绝吊销——人工检查 registry.json\n".into(),
        ),
        Err(RevokeError::Persist) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "registry 落盘失败,吊销未生效(查磁盘后重试)\n".into(),
        ),
    }
}

/// entitlement JSON 形态(admin 面回显;expires_at 回 RFC3339 文本)。
fn entitlement_json(e: &Entitlement) -> serde_json::Value {
    serde_json::json!({
        "tier": e.tier,
        "expires_at": e.expires_at.map(|t| {
            t.format(&time::format_description::well_known::Rfc3339)
                .expect("registry 只存解析成功的时刻,回显无失败路径")
        }),
        "seat_quota": e.seat_quota,
        "fastlane_bytes_per_month": e.fastlane_bytes_per_month,
    })
}

/// GET /admin/entitlement?account=… → `{account, server_now, configured, effective}`
/// (billing-plan §3 工序 1)。configured=显式设置过的记录(null=从未设置),
/// effective=**server_now 时刻**的执行口径(显式记录未到期原样;到期/无记录=免费档
/// 默认,fail-closed——与工序 2/3 执行闸同一原语)。未知/封存账户 = 404(admin 已
/// 鉴权,不需要防探测;200+免费档会掩盖账号 typo,159 codex L1)。
async fn admin_entitlement_get(
    State(st): State<AdminState>,
    Query(q): Query<AdminQuery>,
) -> (StatusCode, String) {
    let Some(account) = q.account.as_deref() else {
        return (StatusCode::BAD_REQUEST, "缺 account 参数\n".into());
    };
    let now = time::OffsetDateTime::now_utc();
    let reg = st.hub.registry.lock().unwrap();
    if !reg.account_exists(account) {
        return (
            StatusCode::NOT_FOUND,
            "账户不在 registry 或已封存(先 GET /admin/devices 核对)\n".into(),
        );
    }
    let body = serde_json::json!({
        "account": account,
        "server_now": now
            .format(&time::format_description::well_known::Rfc3339)
            .expect("UTC 时刻 RFC3339 格式化无失败路径"),
        "configured": reg.configured_entitlement(account).map(entitlement_json),
        "effective": entitlement_json(&reg.effective_entitlement(account, now)),
    });
    (StatusCode::OK, body.to_string())
}

/// POST /admin/entitlement 的参数(billing-plan §3:admin 可对任意账户设任意参数;
/// expires_at 可省=不过期)。数字参数 serde 严格解析,坏形态 400——解析恒在鉴权
/// 之后(admin_auth_mw 是 Router 层 middleware,extractor 在它之后才跑)。
#[derive(serde::Deserialize)]
struct EntitlementSetQuery {
    account: String,
    tier: String,
    seat_quota: u32,
    fastlane_bytes_per_month: u64,
    expires_at: Option<String>,
}

/// POST /admin/entitlement?account=…&tier=…&seat_quota=…&fastlane_bytes_per_month=…
/// [&expires_at=RFC3339] → 设置并即时生效(工序 1:纯元数据,执行闸在工序 2/3)。
/// 200=已设置(回显 server_now 时刻的 effective);400=参数不过尺;404=账户不在
/// registry(typo 防线,先 GET /admin/devices 核对);409=账户已封存(重开后再设);
/// 500=落盘失败(内存已回滚,未生效)。
async fn admin_entitlement_set(
    State(st): State<AdminState>,
    Query(q): Query<EntitlementSetQuery>,
) -> (StatusCode, String) {
    let expires_at = match q.expires_at.as_deref() {
        None => None,
        Some(s) => match registry::parse_expires(s) {
            Ok(t) => Some(t),
            Err(msg) => return (StatusCode::BAD_REQUEST, format!("{msg}\n")),
        },
    };
    let ent = Entitlement {
        tier: q.tier,
        expires_at,
        seat_quota: q.seat_quota,
        fastlane_bytes_per_month: q.fastlane_bytes_per_month,
    };
    let now = time::OffsetDateTime::now_utc();
    // 收口经 hub 编排(169,codex D):set_entitlement 同事务改 grant,升级抬 grant 后
    // 若账户不再超额则清空 pending 放行在等帧(release_if_unthrottled)。
    let outcome = st.hub.admin_set_entitlement(&q.account, ent.clone(), now);
    match outcome {
        Ok(effective) => {
            // 审计线(§11 纪律:只记元数据与参数,无用户内容可记)。
            logln(format!(
                "INFO entitlement 设置 account={} tier={} seats={} fastlane={} expires={}",
                q.account,
                ent.tier,
                ent.seat_quota,
                ent.fastlane_bytes_per_month,
                q.expires_at.as_deref().unwrap_or("-")
            ));
            (
                StatusCode::OK,
                serde_json::json!({
                    "account": q.account,
                    "server_now": now
                        .format(&time::format_description::well_known::Rfc3339)
                        .expect("UTC 时刻 RFC3339 格式化无失败路径"),
                    "configured": entitlement_json(&ent),
                    "effective": entitlement_json(&effective),
                })
                .to_string(),
            )
        }
        Err(SetEntitlementError::Invalid(msg)) => (StatusCode::BAD_REQUEST, format!("{msg}\n")),
        Err(SetEntitlementError::UnknownAccount) => (
            StatusCode::NOT_FOUND,
            "账户不在 registry(entitlement 只对已存在账户设;先 GET /admin/devices 核对)\n".into(),
        ),
        Err(SetEntitlementError::SealedAccount) => (
            StatusCode::CONFLICT,
            "账户已归零封存,拒绝设置授权(重开流程见 deploy §2;重开后再设)\n".into(),
        ),
        Err(SetEntitlementError::Persist) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "registry 落盘失败,设置未生效(查磁盘后重试)\n".into(),
        ),
    }
}

async fn ws_upgrade(State(hub): State<Arc<Hub>>, ws: WebSocketUpgrade) -> Response {
    // 停机中拒新 WS upgrade(169,codex 实现审 M:graceful 序列「停收新连接」)——
    // 计量准入栅栏已关,新连接进来也只会在发数据时被拒,提前在握手层挡掉更干净。
    if hub.is_shutting_down() {
        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, "服务停机中").into_response();
    }
    // 帧上限在 WS 消息层强制(§3:服务器拒超;超限 = 连接错误断开)。
    ws.max_message_size(sync_proto::MAX_FRAME_BYTES)
        .max_frame_size(sync_proto::MAX_FRAME_BYTES)
        .on_upgrade(move |socket| conn::handle(hub, socket))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 停机退出码真值表(169,codex 实现审 M):唯一成功出口 = 干净 drain + 落盘成功。
    #[test]
    fn shutdown_exit_code_truth_table() {
        assert_eq!(shutdown_exit_code(true, true), 0, "干净 drain + 落盘成功 = 退 0");
        assert_eq!(shutdown_exit_code(true, false), 1, "落盘失败 = 非零");
        assert_eq!(shutdown_exit_code(false, true), 1, "drain 超时 = 非零(不称最终快照)");
        assert_eq!(shutdown_exit_code(false, false), 1, "两者皆失败 = 非零");
    }

    /// ws_upgrade 停机中拒新连接的**决策谓词** `is_shutting_down` 直测(169,codex L)。
    /// 503 分支是 `if hub.is_shutting_down() { 503 }` 的平凡早返;`WebSocketUpgrade`
    /// 提取器需真实 hyper 升级上下文、无法在单元测合成,故此处钉死谓词转换:干净
    /// drain 后 `is_shutting_down()` 为真 ⇒ ws_upgrade 走 503 分支。
    #[tokio::test]
    async fn ws_upgrade_shutdown_predicate_flips_after_drain() {
        let dir = std::env::temp_dir().join(format!("zhujian-ws503-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("banlist.txt"), "# 空\n").unwrap();
        let cfg = Config::new(dir.join("banlist.txt"), dir.join("registry.json"));
        let reg = Registry::load(&cfg.banlist_path, cfg.registry_path.clone()).unwrap();
        let hub = Hub::new(cfg, reg);
        assert!(!hub.is_shutting_down(), "起始非停机 → ws 正常升级");
        assert!(hub.shutdown_admissions().await); // active=0 → true,置 adm_closing
        assert!(hub.is_shutting_down(), "干净 drain 后停机 → ws_upgrade 走 503 分支");
    }
}
