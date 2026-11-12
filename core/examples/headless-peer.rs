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
//! | `board flow\|one <标题>` | 建一块看板(0043;flow = 待处理 / 进行中 / 已完成三列、完成列 = 已完成;one = 一列纯分类),回显 id |
//! | `boards` / `cols` | 列出看板(id / 落点 / 完成列 / 删没删)/ 列(id / 看板 / 删没删 / 活卡数) |
//! | `newin <看板id> <标题>` | 在那块看板的落点新建一张卡 |
//! | `landing <看板id> <列id>` | 改那块看板的新卡落点 |
//! | `archive <id>` / `restore <id>` | 卡进回收站 / 还原(还原回原列;原列 / 原看板死了 ⇒ 进收容区) |
//! | `delboard <看板id>` | 删看板(先清空,core 前置) |
//! | `col <看板id> <列名>` | 在那块看板上加一列(种子 `tasks` ⇒ 五键 `create`;别的看板 ⇒ `create_in_board`) |
//! | `latch` | 台架:给当前账户立 board_columns 闩(见下)|
//! | `offline` / `online` | 停 transport(整连接下线)/ 重起 |
//! | `status` | 打一行当前同步状态 |
//! | `account` | 只在 `--solo-first` 下用:这才建号并上线 |
//! | `quit`(或 stdin EOF) | 停 transport 退出 |
//!
//! `--solo-first`(0043 第 4 段):先**不**建号,库是纯本地空间 ⇒ 落卡闸的 solo 臂放行,`board` 等写列的命令
//! 才建得出看板(建了号之后 detached 事实没有名册,闸恒拒);种完再 `account` 建号上线,手机来配对时整份引导过去。
//!
//! `latch`(0043 第 5 段混版):已建号的空间里 detached 事实没有名册,建列 / 往自定义列落卡恒被闸拒;
//! 而混版那组要的恰是「一台 v42 旧端在场时新端照常建看板」= 规格 §5.1 说的「已闩的 v42」形
//! (账户里早有人用过自定义列,闩已立)。生产里闩只由名册臂第一次成立时立(gate.rs `arm_latch`),
//! 台架没有 supervisor 造不出名册 ⇒ 这条命令直接把那一格写成 `"board_columns_v1 <account_id>"`,
//! 只替代「闩怎么立起来的」那一步,⛔ 闸本身照常判。⛔ 只在台架库上用。
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
        "state={} peers_online={} account={} device={} error={:?} boot_hint={:?} frozen={:?} quarantined={:?} suspended={} skew={}",
        s.state,
        s.peers_online,
        s.account_id.as_deref().unwrap_or("-"),
        s.device_id.as_deref().unwrap_or("-"),
        s.error,
        s.boot_hint,
        s.frozen,
        s.quarantined,
        s.suspended,
        s.skew,
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
    let mut solo_first = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--server" => server = Some(args.next().unwrap_or_else(|| die("--server 缺参数"))),
            "--dir" => dir = Some(PathBuf::from(args.next().unwrap_or_else(|| die("--dir 缺参数")))),
            "--join" => join = Some(args.next().unwrap_or_else(|| die("--join 缺参数"))),
            "--solo-first" => solo_first = true,
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
    if solo_first && (existing.is_some() || join.is_some()) {
        die("--solo-first 只对空目录、且不带 --join 有意义");
    }
    match existing {
        None if solo_first => println!("SOLO 未建号;种完数据发 `account`"),
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
    let mut running = if solo_first {
        None
    } else {
        println!("ONLINE starting");
        Some(peer.start())
    };
    let server_url = server.clone();

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
                    // 新卡落默认看板的落点(台架库只有种子看板 ⇒ `todo`,种子列不过闸),故 detached 的事实
                    // 不改变行为;它是台架,不是生产写路径(gate.rs `detached` 头注第 1 类)。
                    "new" => match peer.write(|c, k| {
                        task::create(c, k, rest, None, None, None, None, &zhujian_core::board::gate::RuntimeFacts::detached())
                    }) {
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
                    // ---- 0043 多看板(multiboard-plan 第 4 段手机验收要一台能建看板的对端;手机自己不建,用户拍 ⑩)----
                    // 列名写死中文,与桌面「新建看板」两个模板同名;这里是台架,不过 i18n。detached 事实同上(台架,不是生产写路径)。
                    "board" => {
                        let (tpl, title) = rest.split_once(' ').unwrap_or((rest, ""));
                        let (cols, done): (&[&str], Option<usize>) = match tpl {
                            "flow" => (&["待处理", "进行中", "已完成"], Some(2)),
                            "one" => (&["收着"], None),
                            _ => {
                                println!("ERR board 模板只认 flow / one");
                                continue;
                            }
                        };
                        match peer.write(|c, k| {
                            zhujian_core::board::create_board(c, k, title.trim(), cols, done, &zhujian_core::board::gate::RuntimeFacts::detached())
                        }) {
                            Ok(id) => println!("OK board {id}"),
                            Err(e) => println!("ERR board {e}"),
                        }
                    }
                    "boards" => match zhujian_core::board::list_boards(&peer.db.lock().unwrap()) {
                        Ok(rows) => {
                            for b in rows {
                                println!(
                                    "BOARD {} landing={} done={} deleted={} default={} {}",
                                    b.id,
                                    b.landing.as_deref().unwrap_or("-"),
                                    b.done.as_deref().unwrap_or("-"),
                                    b.deleted,
                                    b.is_default,
                                    b.title
                                );
                            }
                            println!("OK boards");
                        }
                        Err(e) => println!("ERR boards {e}"),
                    },
                    "cols" => match zhujian_core::board::list_columns(&peer.db.lock().unwrap()) {
                        Ok(rows) => {
                            for c in rows {
                                println!(
                                    "COL {} board={} kind={} deleted={} board_deleted={} live={} {}",
                                    c.id,
                                    c.board_id.as_deref().unwrap_or("-"),
                                    c.kind,
                                    c.deleted,
                                    c.board_deleted,
                                    c.live_items,
                                    c.title
                                );
                            }
                            println!("OK cols");
                        }
                        Err(e) => println!("ERR cols {e}"),
                    },
                    "newin" => {
                        let (b, t) = rest.split_once(' ').unwrap_or((rest, ""));
                        match peer.write(|c, k| {
                            task::create(c, k, t.trim(), None, None, None, Some(b), &zhujian_core::board::gate::RuntimeFacts::detached())
                        }) {
                            Ok(id) => println!("OK newin {id}"),
                            Err(e) => println!("ERR newin {e}"),
                        }
                    }
                    "landing" => {
                        let (b, col) = rest.split_once(' ').unwrap_or((rest, ""));
                        match peer.write(|c, k| zhujian_core::board::set_board_landing(c, k, b, col.trim())) {
                            Ok(()) => println!("OK landing {b} {}", col.trim()),
                            Err(e) => println!("ERR landing {e}"),
                        }
                    }
                    "archive" => match peer.write(|c, k| task::archive(c, k, rest)) {
                        Ok(()) => println!("OK archive {rest}"),
                        Err(e) => println!("ERR archive {e}"),
                    },
                    "restore" => match peer.write(|c, k| task::restore(c, k, rest)) {
                        Ok(()) => println!("OK restore {rest}"),
                        Err(e) => println!("ERR restore {e}"),
                    },
                    "col" => {
                        let (b, t) = rest.split_once(' ').unwrap_or((rest, ""));
                        match peer.write(|c, k| {
                            zhujian_core::board::create_column(c, k, t.trim(), Some(b), &zhujian_core::board::gate::RuntimeFacts::detached())
                        }) {
                            Ok(id) => println!("OK col {id}"),
                            Err(e) => println!("ERR col {e}"),
                        }
                    }
                    "latch" => {
                        let conn = peer.db.lock().unwrap();
                        match transport::account_id(&conn) {
                            Ok(Some(acct)) => match conn.execute(
                                "INSERT INTO sync_meta (key, value) VALUES ('board_columns_latch', ?1) \
                                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                [format!("board_columns_v1 {acct}")],
                            ) {
                                Ok(_) => println!("OK latch {acct}"),
                                Err(e) => println!("ERR latch {e}"),
                            },
                            Ok(None) => println!("ERR latch 还没建号"),
                            Err(e) => println!("ERR latch {e}"),
                        }
                    }
                    "delboard" => match peer.write(|c, k| zhujian_core::board::delete_board(c, k, rest)) {
                        Ok(()) => println!("OK delboard {rest}"),
                        Err(e) => println!("ERR delboard {e}"),
                    },
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
                    "account" => {
                        if transport::account_id(&peer.db.lock().unwrap()).ok().flatten().is_some() {
                            println!("ERR 已有账户");
                            continue;
                        }
                        match transport::create_account(&peer.db, &server_url).await {
                            Ok(_) => {
                                let acct = transport::account_id(&peer.db.lock().unwrap()).ok().flatten();
                                println!("ACCOUNT created {}", acct.as_deref().unwrap_or("?"));
                                running = Some(peer.start());
                                println!("ONLINE starting");
                            }
                            Err(e) => println!("ERR account {e}"),
                        }
                    }
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
