//! 无界面对端(746 立):一台「别的设备」,只连**本地** syncd,供真机验收当配对 / 引导的另一头。
//!
//! 用法:`cargo run --example headless-peer -- --server ws://127.0.0.1:8801 --dir <数据目录>`
//!
//! 启动:开(或建)`<dir>/peer.sqlite3` → 未配置就建号(给了 `--join <配对码>` 则改为用码加入
//! 别人的账户,之后 transport 自己走引导)→ 起常驻 transport(应答引导请求)。
//! `--join` 的用处:让它从**某一台真机**那里引导,`list` 读到的就是那台机器库里的原值
//! (手机的 devtools 包读不到 `items.color`,这是从外面核它的一条路)。
//! 之后 stdin 一行一条命令,结果与同步事件都打到 stdout(一行一件,行首是类别):
//!
//! | 命令 | 做什么 |
//! |---|---|
//! | `pair` | 出一枚配对码(要在线;打成 `CODE <码>`) |
//! | `pair-then-offline` | 出码,且配对 `done` 那一刻自动下线(= 对端在对方引导前走掉) |
//! | `new <标题>` | 新建一张任务卡(落看板首列),回显 id |
//! | `color <id> <#RRGGBB>` / `uncolor <id>` | 上色 / 清色 |
//! | `title <id> <新标题>` | 改标题 |
//! | `list` | 列出库里的卡(id / stage / color / content) |
//! | `offline` / `online` | 停 transport(整连接下线)/ 重起 |
//! | `status` | 打一行当前同步状态 |
//! | `quit`(或 stdin EOF) | 停 transport 退出 |
//!
//! 为什么住 core 的 examples:用到的全是 core 的公开 API(`db::open` / `Clock` /
//! `sync::transport::{create_account, run, Control}` / `task::*`),桌面与手机两只壳
//! 都拖着 tauri,放那边就得为一只工装编整只壳;core 自己不依赖任何壳。
//!
//! ⛔ 只许连本地:`--server` 必须是 `ws://127.0.0.1|localhost|[::1]:<端口>`,缺了或不是就拒启。
//! 本文件不写任何线上地址。驱动法:`tail -f cmds.txt | headless-peer … > out.log`,往
//! `cmds.txt` 追加一行就是一条命令。

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tokio::sync::{mpsc, oneshot, watch, Notify};
use tokio::task::JoinHandle;
use zhujian_core::clock::Clock;
use zhujian_core::sync::transport::{self, Control, SyncEvent, SyncStatus, TransportExit};
use zhujian_core::{db, task};

fn die(msg: &str) -> ! {
    eprintln!("FATAL {msg}");
    std::process::exit(2)
}

/// 本地地址闸:`ws://` + 回环主机 + 数字端口,别的一律拒。
fn local_url(url: &str) -> Result<(), String> {
    let rest = url.strip_prefix("ws://").ok_or(format!("只许 ws:// 本地地址:{url}"))?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (host, port) = rest.rsplit_once(':').ok_or(format!("缺端口:{url}"))?;
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return Err(format!("只许回环地址(127.0.0.1 / localhost / [::1]):{url}"));
    }
    port.parse::<u16>().map_err(|_| format!("端口不是数字:{url}"))?;
    Ok(())
}

struct Peer {
    db: Arc<Mutex<Connection>>,
    clock: Arc<Mutex<Clock>>,
    status: Arc<Mutex<SyncStatus>>,
    events: mpsc::UnboundedSender<SyncEvent>,
    wrote: Arc<Notify>,
    dir: PathBuf,
}

struct Running {
    task: JoinHandle<TransportExit>,
    control: mpsc::Sender<Control>,
    shutdown: watch::Sender<bool>,
}

impl Peer {
    fn start(&self) -> Running {
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (sd_tx, sd_rx) = watch::channel(false);
        let task = tokio::spawn(transport::run(transport::Transport {
            db: self.db.clone(),
            clock: self.clock.clone(),
            status: self.status.clone(),
            events: self.events.clone(),
            control: ctl_rx,
            wrote: self.wrote.clone(),
            data_dir: self.dir.clone(),
            blob_policy: transport::BlobPolicy::Full,
            allow_boot_source: true,
            shutdown: sd_rx,
            boot_commit: Arc::new(Mutex::new(None)),
            restart_flag: Arc::new(Mutex::new(None)),
            // 没有壳侧写闸在读这两格(同 staging 传输与单测的装配)。
            engine_present: Arc::new(AtomicBool::new(false)),
            peer_caps: Arc::new(transport::PeerCaps::default()),
            lan: None,
        }));
        Running { task, control: ctl_tx, shutdown: sd_tx }
    }

    fn write<T>(
        &self,
        f: impl FnOnce(&mut Connection, &mut Clock) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut conn = self.db.lock().unwrap();
        let mut clock = self.clock.lock().unwrap();
        f(&mut conn, &mut clock)
    }

    fn list(&self) -> Result<Vec<String>, String> {
        let conn = self.db.lock().unwrap();
        let mut st = conn
            .prepare("SELECT id, stage, COALESCE(color,'-'), content FROM items ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| {
                Ok(format!(
                    "{} {} {} {}",
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }
}

fn status_line(s: &SyncStatus) -> String {
    format!(
        "state={} peers_online={} account={} device={} error={:?} boot_hint={:?} frozen={:?} quarantined={:?}",
        s.state,
        s.peers_online,
        s.account_id.as_deref().unwrap_or("-"),
        s.device_id.as_deref().unwrap_or("-"),
        s.error,
        s.boot_hint,
        s.frozen,
        s.quarantined,
    )
}

async fn stop(run: Running) {
    let _ = run.shutdown.send(true);
    match run.task.await {
        Ok(exit) => println!("OFFLINE exit={exit:?}"),
        Err(e) => println!("OFFLINE join-error={e}"),
    }
}

async fn pair(run: &Running) -> Result<String, String> {
    let (tx, rx) = oneshot::channel();
    run.control
        .send(Control::PairStart { reply: tx })
        .await
        .map_err(|_| "transport 已退出".to_string())?;
    rx.await.map_err(|_| "配对回执丢了".to_string())?
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut server: Option<String> = None;
    let mut dir: Option<PathBuf> = None;
    let mut join: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--server" => server = Some(args.next().unwrap_or_else(|| die("--server 缺参数"))),
            "--dir" => dir = Some(PathBuf::from(args.next().unwrap_or_else(|| die("--dir 缺参数")))),
            "--join" => join = Some(args.next().unwrap_or_else(|| die("--join 缺参数"))),
            other => die(&format!("不认识的参数:{other}")),
        }
    }
    let server = server.unwrap_or_else(|| die("必须给 --server ws://127.0.0.1:<端口>(只许本地)"));
    local_url(&server).unwrap_or_else(|e| die(&e));
    let dir = dir.unwrap_or_else(|| die("必须给 --dir <数据目录>"));
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| die(&format!("建目录失败:{e}")));

    let conn = db::open(&dir.join("peer.sqlite3")).unwrap_or_else(|e| die(&format!("开库失败:{e}")));
    let clock = Clock::load(&conn).unwrap_or_else(|e| die(&e));
    let wrote = Arc::new(Notify::new());
    transport::hook_oplog_writes(&conn, wrote.clone());
    let dbh = Arc::new(Mutex::new(conn));

    let existing = transport::account_id(&dbh.lock().unwrap()).unwrap_or_else(|e| die(&e));
    match existing {
        Some(acct) => {
            if join.is_some() {
                die("--dir 里已有账户,--join 只对空目录有意义");
            }
            println!("ACCOUNT reuse {acct}");
        }
        None if join.is_some() => {
            let code = join.as_deref().unwrap();
            transport::pair_join(&dbh, &server, code, |_| Ok(()))
                .await
                .unwrap_or_else(|e| die(&format!("用码加入失败:{e}")));
            let acct = transport::account_id(&dbh.lock().unwrap()).unwrap_or_else(|e| die(&e));
            println!("ACCOUNT joined {}", acct.as_deref().unwrap_or("?"));
        }
        None => {
            transport::create_account(&dbh, &server).await.unwrap_or_else(|e| die(&format!("建号失败:{e}")));
            let acct = transport::account_id(&dbh.lock().unwrap()).unwrap_or_else(|e| die(&e));
            println!("ACCOUNT created {}", acct.as_deref().unwrap_or("?"));
        }
    }

    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
    let peer = Peer {
        db: dbh,
        clock: Arc::new(Mutex::new(clock)),
        status: Arc::new(Mutex::new(SyncStatus::default())),
        events: ev_tx,
        wrote,
        dir,
    };
    let mut running = Some(peer.start());
    println!("ONLINE starting");

    // stdin 在独立线程里读(阻塞读),一行一条转进 tokio 通道;EOF = quit。
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match std::io::stdin().read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = cmd_tx.send("quit".into());
                    return;
                }
                Ok(_) => {
                    if cmd_tx.send(line.trim().to_string()).is_err() {
                        return;
                    }
                }
            }
        }
    });

    let mut offline_after_pair = false;
    loop {
        tokio::select! {
            Some(ev) = ev_rx.recv() => match ev {
                SyncEvent::Status(s) => println!("EV status {}", status_line(&s)),
                SyncEvent::Changed => println!("EV changed"),
                SyncEvent::SpaceNameChanged => println!("EV space-name-changed"),
                SyncEvent::Toast(t) => println!("EV toast {t}"),
                SyncEvent::Pair { phase, detail } => {
                    println!("EV pair {phase} {detail}");
                    if phase == "done" && offline_after_pair {
                        offline_after_pair = false;
                        if let Some(r) = running.take() {
                            stop(r).await;
                        }
                    }
                }
                SyncEvent::BootProgress { received, total } => println!("EV boot-progress {received}/{total}"),
                SyncEvent::BootFailed { reason, retry_soon } => println!("EV boot-failed retry_soon={retry_soon} {reason}"),
            },
            Some(line) = cmd_rx.recv() => {
                let (cmd, rest) = line.split_once(' ').unwrap_or((line.as_str(), ""));
                let rest = rest.trim();
                println!("CMD {line}");
                match cmd {
                    "" => {}
                    "pair" | "pair-then-offline" => match &running {
                        None => println!("ERR 已下线,先 online"),
                        Some(r) => match pair(r).await {
                            Ok(code) => {
                                offline_after_pair = cmd == "pair-then-offline";
                                println!("CODE {code}");
                            }
                            Err(e) => println!("ERR pair {e}"),
                        },
                    },
                    "new" => match peer.write(|c, k| task::create(c, k, rest, None, None, None)) {
                        Ok(id) => println!("OK new {id}"),
                        Err(e) => println!("ERR new {e}"),
                    },
                    "color" => {
                        let (id, hex) = rest.split_once(' ').unwrap_or((rest, ""));
                        match peer.write(|c, k| task::set_color(c, k, id, Some(hex.trim().to_string()))) {
                            Ok(()) => println!("OK color {id} {}", hex.trim()),
                            Err(e) => println!("ERR color {e}"),
                        }
                    }
                    "uncolor" => match peer.write(|c, k| task::set_color(c, k, rest, None)) {
                        Ok(()) => println!("OK uncolor {rest}"),
                        Err(e) => println!("ERR uncolor {e}"),
                    },
                    "title" => {
                        let (id, t) = rest.split_once(' ').unwrap_or((rest, ""));
                        match peer.write(|c, k| task::rename(c, k, id, t)) {
                            Ok(()) => println!("OK title {id} {}", t.trim()),
                            Err(e) => println!("ERR title {e}"),
                        }
                    }
                    "list" => match peer.list() {
                        Ok(rows) => {
                            for r in rows {
                                println!("ITEM {r}");
                            }
                            println!("OK list");
                        }
                        Err(e) => println!("ERR list {e}"),
                    },
                    "offline" => match running.take() {
                        Some(r) => stop(r).await,
                        None => println!("ERR 已经下线"),
                    },
                    "online" => {
                        if running.is_some() {
                            println!("ERR 已经在线");
                        } else {
                            running = Some(peer.start());
                            println!("ONLINE starting");
                        }
                    }
                    "status" => println!("STATUS {}", status_line(&peer.status.lock().unwrap())),
                    "quit" => {
                        if let Some(r) = running.take() {
                            stop(r).await;
                        }
                        println!("BYE");
                        return;
                    }
                    other => println!("ERR 不认识的命令:{other}"),
                }
            }
        }
    }
}
