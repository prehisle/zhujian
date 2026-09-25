//! 薄壳:参数解析 + 起服务(库面见 lib.rs;部署形态见 sync-protocol §4——
//! 监听 localhost 明文 WS,TLS 由 Caddy 反代终结,P2-i)。

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

#[tokio::main]
async fn main() {
    let mut listen: SocketAddr = "127.0.0.1:8787".parse().expect("字面量恒合法");
    let mut admin_listen: Option<SocketAddr> = None;
    let mut admin_token: Option<String> = None;
    let mut data_dir = PathBuf::from("./data");
    let mut free_seat_quota: Option<u32> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--listen" => {
                let v = args.next().unwrap_or_else(|| die("--listen 缺参数"));
                listen = v.parse().unwrap_or_else(|_| die(&format!("--listen 不是合法地址:{v}")));
            }
            "--admin-listen" => {
                let v = args.next().unwrap_or_else(|| die("--admin-listen 缺参数"));
                admin_listen = Some(
                    v.parse()
                        .unwrap_or_else(|_| die(&format!("--admin-listen 不是合法地址:{v}"))),
                );
            }
            "--admin-token-file" => {
                let v = args.next().unwrap_or_else(|| die("--admin-token-file 缺参数"));
                let raw = std::fs::read_to_string(&v)
                    .unwrap_or_else(|e| die(&format!("读 admin token 文件 {v} 失败:{e}")));
                admin_token = Some(raw.trim().to_owned());
            }
            "--data-dir" => {
                data_dir = PathBuf::from(args.next().unwrap_or_else(|| die("--data-dir 缺参数")));
            }
            // 免费档席位数(推广期生产设 4;收费期改回默认 2 即可、不重编)。默认
            // 走 Config::new(=常量 2)。**拒 0**:0 席=免费账户全瘫,且 free_entitlement
            // 不过 Entitlement::validate(seat_quota≥1);此处是唯一注入口,fail-fast 挡死。
            "--free-seat-quota" => {
                let v = args.next().unwrap_or_else(|| die("--free-seat-quota 缺参数"));
                let q: u32 = v
                    .parse()
                    .unwrap_or_else(|_| die(&format!("--free-seat-quota 不是合法整数:{v}")));
                if q == 0 {
                    die("--free-seat-quota 须 ≥1(0 席=免费账户全瘫)");
                }
                free_seat_quota = Some(q);
            }
            // 封禁表离线校验(open-signup §1.6 运维纪律:先校验、原子替换、再 reload
            // ——直写活文件留坏内容会让下次重启 fail-fast 拒启)。与运行期同一解析器,
            // 过=打印封禁数退 0,不过=打印带行号的错误退 1。
            "--validate-banlist" => {
                let v = args.next().unwrap_or_else(|| die("--validate-banlist 缺参数(封禁表文件路径)"));
                match zhujian_syncd::registry::validate_banlist(std::path::Path::new(&v)) {
                    Ok(n) => {
                        println!("ok:封禁表合法,当前封禁 {n} 个账户");
                        std::process::exit(0);
                    }
                    Err(e) => die(&format!("封禁表不合法:{e}")),
                }
            }
            // registry 离线校验(367,identity-plan §5.16.5-1:**升级前必跑**)。367 给
            // load 加了两道新拒启判据(单账户设备数上限、admins 不变量),现网是历史
            // 数据——拿副本先跑一遍,别等升上去才发现拒启。顺带印出「还没回填管理
            // 设备的账户」清单,那正是回填工序要的那张表。与运行期同一条 load。
            "--validate-registry" => {
                let v = args
                    .next()
                    .unwrap_or_else(|| die("--validate-registry 缺参数(registry.json 路径)"));
                let bl = args.next().unwrap_or_else(|| die(
                    "--validate-registry 还需第二个参数(banlist.txt 路径;load 两份一起校验)",
                ));
                match zhujian_syncd::registry::validate_registry(
                    std::path::Path::new(&bl),
                    PathBuf::from(&v),
                ) {
                    Ok(report) => {
                        println!("{report}");
                        std::process::exit(0);
                    }
                    Err(e) => die(&format!("registry 不合法:{e}")),
                }
            }
            other => die(&format!(
                "未知参数 {other}\n用法:zhujian-syncd [--listen 127.0.0.1:8787] [--admin-listen 127.0.0.1:8788 --admin-token-file ./data/admin-token] [--data-dir ./data] [--free-seat-quota 4] | zhujian-syncd --validate-banlist <file> | zhujian-syncd --validate-registry <registry.json> <banlist.txt>\n  data-dir 下须有 banlist.txt(封禁表:一行一个被封禁的 account_id,须为合法 26 位 ULID,# 整行注释;空文件=零封禁;准入开放,fresh 账户直接 TOFU;改动先 --validate-banlist 校验再原子替换)\n  admin 面(运营侧设备吊销)只许回环地址、别进反代;token 文件 openssl rand -hex 32 生成、chmod 600,两参数必须同给\n  free-seat-quota 免费档席位数(默认 2;推广期设 4,收费期改回不重编;≥1)"
            )),
        }
    }
    // 单实例锁(backlog 108):同一 data-dir 只许一个进程。registry.json(账务数据)与
    // meters.json 都是单写者、tmp 写 + rename 落盘 —— 两个进程连 `.tmp` 都会互相踩;而境内
    // k8s 的 `replicas: 1` 只是纪律(RWO 限节点不限 Pod,694 勘误)。⛔ 须在写任何数据、load
    // 任何数据之前拿到(下面 serve 里才 load);锁前只有只读的 `--admin-token-file` 与两枚
    // `--validate-*` 旗标碰 data-dir(codex 审 L1 列过表)。放锁只归内核、只在进程退出时,见 lock_data_dir。
    lock_data_dir(&data_dir);
    let mut cfg = zhujian_syncd::Config::new(
        data_dir.join("banlist.txt"),
        data_dir.join("registry.json"),
    );
    if let Some(q) = free_seat_quota {
        cfg.free_seat_quota = q;
    }
    let handle = match (admin_listen, admin_token) {
        (Some(admin), Some(token)) => {
            match zhujian_syncd::serve_with_admin(listen, admin, token, cfg).await {
                Ok((_, _, handle)) => handle,
                Err(e) => die(&format!("启动失败:{e}")),
            }
        }
        (None, None) => match zhujian_syncd::serve(listen, cfg).await {
            Ok((_, handle)) => handle,
            Err(e) => die(&format!("启动失败:{e}")),
        },
        _ => die("--admin-listen 与 --admin-token-file 必须同给(admin 面无 token 不开)"),
    };
    let _ = handle.await;
}

/// 锁对象:unix 上是 **data-dir 目录本身**(对目录 fd 加 flock)。不另立锁文件的理由
/// (backlog 108 评审 M1):flock 挂在 inode 上,独立锁文件一旦被删掉或被 tar 解包换掉 inode
/// (GNU tar 1.34 实测会),活着的持有者攥着旧 inode、新实例在新 inode 上照样锁得到 = 机制
/// 静默失效 —— 而运维看到「被占用」时顺手 `rm *.lock` 正是 pidfile 的习惯动作。目录的 inode
/// 不随删文件 / 往里解包而变,且没有文件可删、也不会被备份 tgz 带走。
/// Windows 锁不了目录(`LockFileEx` 只认文件)⇒ 退回 data-dir 下的空锁文件;那一端只有开发用。
#[cfg(unix)]
fn open_lock_target(data_dir: &Path) -> (std::fs::File, PathBuf) {
    let path = data_dir.to_path_buf();
    let f = std::fs::File::open(&path)
        .unwrap_or_else(|e| die(&format!("打开 data-dir {} 失败:{e}", path.display())));
    (f, path)
}

#[cfg(not(unix))]
fn open_lock_target(data_dir: &Path) -> (std::fs::File, PathBuf) {
    let path = data_dir.join("zhujian-syncd.lock");
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .unwrap_or_else(|e| die(&format!("打开 data-dir 锁文件 {} 失败:{e}", path.display())));
    (f, path)
}

/// 对 data-dir 抢排他锁(unix = 目录 fd 上 `flock(LOCK_EX|LOCK_NB)`,Windows = 锁文件上
/// `LockFileEx`)。锁态只在内核里、随 fd 释放 ⇒ 进程怎么死(SIGKILL / OOM)都自动放,没有
/// 残留锁要清。**拿不到 = fail-fast 退 1**:不重试、不等待、不降级成无锁运行 —— 再来一次是
/// k8s / systemd 重启策略的事(见 ops/sealos/syncd.yaml 头注)。不锁 registry.json 本身:
/// 它每次落盘都被 rename 换掉 inode。
///
/// 拿到之后 **`mem::forget` 掉 fd**,不交给任何作用域:放锁只能由内核在进程退出时做。
/// ⚠ 这是**对将来的防御,今天不可达**(codex 审 L2):axum 0.8 的 `serve` 永不完成、停机走
/// `process::exit`,main 栈帧今天不会被 drop ⇒ 「随栈帧 drop」的旧形在现有路径上与它等价,
/// 行为测造不出来(要先有可控的 graceful-shutdown 入口)。将来若加了让 main 正常返回的退出路,
/// 随栈帧 drop 会让锁先于 runtime 拆除被放掉,而未取消的连接任务、刚 abort 还没停到 await 点的
/// sweeper / checkpointer 仍可能在写 registry.json / meters.json(首版自检判据 7)。
fn lock_data_dir(data_dir: &Path) {
    let (file, what) = open_lock_target(data_dir);
    match file.try_lock() {
        Ok(()) => std::mem::forget(file),
        Err(std::fs::TryLockError::WouldBlock) => die(&format!(
            "data-dir {} 已被另一个 zhujian-syncd 进程占用(排他锁拿不到:{}),拒启。\n  同一 data-dir 只许一个实例:两个进程同写 registry.json 会把账务数据写坏。\n  先查清占着它的那个进程(k8s 下多半是旧 Pod 还没退完,等它退出、由重启策略再拉起即可);本进程不重试、不等待。",
            data_dir.display(),
            what.display()
        )),
        Err(std::fs::TryLockError::Error(e)) => die(&format!(
            "给 data-dir 加排他锁失败({}):{e}\n  该文件系统可能不支持 flock(网络卷须先核实跨客户端锁语义);拒启,不在无锁状态下运行。",
            what.display()
        )),
    }
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}
