//! 双~三实例收敛 property test(sync-protocol §9,sync-plan 的 P2 止损探针)。
//!
//! 三个引擎实例(各配真 SQLite)+ 内存服务器模型(§4 信箱语义:每收件设备一条 FIFO
//! 队列、离线堆积按容量丢最老、随机衰减模拟 TTL、重启清空、direct 不入信箱)。随机
//! 命令流(覆盖词汇表**全部** entity·kind(计数别写死在这里——0028 space、0033 device、0035 comment 三次都是它先腐;以 random_command 的臂为准))× 随机上下线 ×
//! 乱序交错投递 × 引擎重启;终局全员在线、反复 hello 互补直到静默,断言六张同步表
//! 逐行相等(items 刨去本地簿记 updated_at;item_image 含字节)+ per-origin 水位
//! 相等且连续 + 无冻结无拒帧。
//!
//! 确定性说明:种子只固定**事件序列**(命令选择/分区/投递交错);HLC/ULID 内嵌真实
//! 墙钟与随机位,是环境噪声——断言的是「任意交错下都收敛」,与具体 LWW 胜者无关。
//! 反例种子固化进 SEEDS 数组当回归(§9)。

use rusqlite::Connection;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::clock::Clock;
use crate::sync::engine::{
    serve_chunks, BlobPolicy, Engine, Event, Lane, Msg, Output, Route, RouteHint, BROADCAST,
};
use crate::{db, images, notes, task};

// ---- 确定性随机(xorshift64*,无外部依赖) -------------------------------------------

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        assert!(n > 0);
        (self.next() % n as u64) as usize
    }
    fn pick<'a>(&mut self, xs: &'a [String]) -> Option<&'a String> {
        if xs.is_empty() {
            None
        } else {
            Some(&xs[self.below(xs.len())])
        }
    }
}

// ---- 内存服务器模型 + 参与设备 -------------------------------------------------------

/// 离线信箱容量(帧;故意压小促发「丢最老 → 水位缺口 → hello/want 自愈」)。
/// 在线队列 = 网络在途,不设容量(§4:容量语义只属于信箱堆积)。
const MAILBOX_CAP: usize = 24;
/// pending 池上限压小,促发「超限丢弃、重取」路径(§5.3 评审①-M5)。
const PENDING_CAP: usize = 8;
/// 每种子的随机事件数。
const STEPS: usize = 150;
/// settle 的 hello 轮上限:每轮 = 全员重连互报水位 + pump 到静默(§5.2「总会发生在
/// 下次连接」的模拟)。超限仍不齐 = 不收敛,报种子。
const MAX_SETTLE_ROUNDS: usize = 12;
/// 每轮 settle 在「帧跑干了」之后最多补几拍心跳(见 [`Sim::heartbeat`])。
/// 取值要大于最长的那档冷却(`RECONCILE_COOLDOWN_TICKS` = 2),留一倍余量。
const BEATS_PER_ROUND: usize = 4;

struct Peer {
    device_id: String,
    conn: Connection,
    clock: Clock,
    engine: Engine,
    /// 图字节旁路策略(M1):Full=桌面全量端,MetadataOnly=手机轻端;引擎重启沿用。
    policy: BlobPolicy,
    online: bool,
    /// 服务器端该设备的 FIFO 队列(信箱与在途同队,§4):(发送设备, 内层消息)。
    inbox: VecDeque<(String, Msg)>,
    _path: std::path::PathBuf,
}

struct Sim {
    seed: u64,
    rng: Rng,
    peers: Vec<Peer>,
    frozen: Vec<String>,
    rejected: Vec<String>,
    /// 轻端违约记录(M1):MetadataOnly 端发出的任何 BlobWant/BlobPull。
    light_blob_asks: Vec<String>,
}

impl Sim {
    fn new(seed: u64, policies: &[BlobPolicy]) -> Sim {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let peers = policies
            .iter()
            .map(|&policy| {
                let k = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let path = crate::test_temp::dir()
                    .join(format!("ys-nb-conv-{}-{}.sqlite3", std::process::id(), k));
                let _ = std::fs::remove_file(&path);
                let conn = db::open(&path).expect("open migrated db");
                let clock = Clock::load(&conn).expect("load clock");
                let mut engine =
                    Engine::new_solo(&conn, policy).expect("engine").with_pending_cap(PENDING_CAP);
                // 运行时装配即活(lan-direct-plan §6):一次性本地初始化与「连上服务器」
                // 无关,故在此、不在 set_online 里(每次重连再跑一遍就不叫一次性了)。
                engine.on_runtime_started(&conn).expect("runtime started");
                let device_id = clock.device_id().to_string();
                Peer { device_id, conn, clock, engine, policy, online: false, inbox: VecDeque::new(), _path: path }
            })
            .collect();
        Sim { seed, rng: Rng::new(seed), peers, frozen: vec![], rejected: vec![], light_blob_asks: vec![] }
    }

    /// 路由一批引擎输出:Send 进目标队列(离线信箱裁容量;direct 只投在线,离线目标
    /// 通知发送者不可达),事件按类收集(冻结/拒帧在本测试里 = 违约)。
    fn route(&mut self, from_idx: usize, outputs: Vec<Output>) {
        // 「direct 投不到离线设备」会让引擎作废在飞拉流并**当场重问**(lan-direct-plan
        // §6 实现审 H2):那批输出必须真的投出去,否则模拟不到「路由失效后立刻换来源」
        // 的端到端活性(实现审二轮 L1)。收在这里、循环外再投,避免嵌套借用。
        let mut cascaded: Vec<(usize, Vec<Output>)> = vec![];
        for output in outputs {
            match output {
                // 「来取活」的铃:本模拟没有消费腿,活由 drain_ops_for_test 抽走。
                Output::ServeOps(_) => continue,
                Output::Send { to, lane, route_hint, msg } => {
                    // 本模拟只有中转一条腿:任何 `Require(Lan)` = 引擎在没有 lan 链路时
                    // 钉了直连(路由表置位路径漏了),响亮失败——lan 帧在这里无处可投,
                    // 静默吞掉会伪装成收敛。
                    assert_ne!(
                        route_hint,
                        RouteHint::Require(Route::Lan),
                        "无 lan 链路却要求直连(种子 {}):{msg:?}",
                        self.seed
                    );
                    // M1 违约稽查:轻端只许答(BlobHave/BlobChunk serve),不许要
                    // (want/pull)。收集不 panic,终局断言给全景。
                    if self.peers[from_idx].policy == BlobPolicy::MetadataOnly
                        && matches!(msg, Msg::BlobWant { .. } | Msg::BlobPull { .. })
                    {
                        self.light_blob_asks.push(format!("{from_idx}:{msg:?}"));
                    }
                    let from_id = self.peers[from_idx].device_id.clone();
                    let targets: Vec<usize> = self
                        .peers
                        .iter()
                        .enumerate()
                        .filter(|(i, p)| {
                            *i != from_idx && (to == BROADCAST || p.device_id == to)
                        })
                        .map(|(i, _)| i)
                        .collect();
                    for t in targets {
                        if self.peers[t].online {
                            self.peers[t].inbox.push_back((from_id.clone(), msg.clone()));
                        } else if lane == Lane::Mail {
                            self.peers[t].inbox.push_back((from_id.clone(), msg.clone()));
                            while self.peers[t].inbox.len() > MAILBOX_CAP {
                                self.peers[t].inbox.pop_front(); // 信箱溢出丢最老(§4)
                            }
                        } else {
                            // direct 且离线:不入信箱,通知发送者(§3 err{not_online})。
                            // 本模拟只有中转一条腿(服务器 + 信箱模型),故通报的是
                            // 该对端的 **relay** 腿不可达(lan-direct-plan §6 对端级)。
                            let target_id = self.peers[t].device_id.clone();
                            let outs = self.peers[from_idx].engine.on_relay_peer_down(&target_id);
                            cascaded.push((from_idx, outs));
                        }
                    }
                }
                // 图字节供流(lan-direct-plan §10 C′):引擎只给描述符,块由传输层逐块
                // 取。本模拟就地把**生产取数原语**跑一遍再投(见 [`serve_chunks`]),故
                // 「切块 / 末块标志 / 行中途没了回 deny」这三条在收敛 property test 里也
                // 是真跑的。direct lane 语义照旧:对端离线不入信箱,通报 relay 腿不可达。
                Output::ServeBlob(serve) => {
                    assert_eq!(
                        serve.route,
                        Route::Relay,
                        "本模拟只有中转一条腿(种子 {})",
                        self.seed
                    );
                    let Some(t) = self.peers.iter().position(|p| p.device_id == serve.to) else {
                        continue;
                    };
                    if self.peers[t].online {
                        let from_id = self.peers[from_idx].device_id.clone();
                        let msgs = serve_chunks(&self.peers[from_idx].conn, &serve);
                        for m in msgs {
                            self.peers[t].inbox.push_back((from_id.clone(), m));
                        }
                    } else {
                        let target_id = self.peers[t].device_id.clone();
                        let outs = self.peers[from_idx].engine.on_relay_peer_down(&target_id);
                        cascaded.push((from_idx, outs));
                    }
                }
                Output::Event(Event::OriginFrozen { origin, reason }) => {
                    self.frozen.push(format!("{origin}:{reason}"));
                }
                Output::Event(Event::FrameRejected { from, reason }) => {
                    self.rejected.push(format!("{from}:{reason}"));
                }
                Output::Event(_) => {} // Renumbered / Suspended 是合法过程事件。
            }
        }
        // 级联只有一层:上面产出的都是 mail 广播 want(入队即止),不会再触发引擎。
        for (idx, outs) in cascaded {
            self.route(idx, outs);
        }
    }

    /// 设备上线:重连仪式 = hello 广播 + 缺字节重发 + 推送离线期间攒的本机 op;并模拟
    /// 服务器的在线快照/上线广播——**(X, Relay)=Up 须「本机会话在 ∧ X 在线」两层同时
    /// 成立**(lan-direct-plan §5.1/§6),blob 选路只认这张表,漏了广播就没人能拉图。
    fn set_online(&mut self, i: usize) {
        self.peers[i].online = true;
        let p = &mut self.peers[i];
        let mut outs = p.engine.relay_up(&p.conn).expect("relay session up");
        p.engine.outbound(&p.conn, &mut outs).expect("outbound");
        outs.extend(p.engine.drain_ops_for_test(&p.conn).expect("drain ops"));
        let ids: Vec<String> = self.peers.iter().map(|p| p.device_id.clone()).collect();
        let mut cascaded: Vec<(usize, Vec<Output>)> = vec![];
        for j in 0..self.peers.len() {
            if j == i || !self.peers[j].online {
                continue;
            }
            // 换代作废旧代 transfer 时会带回重问输出(此刻两端 relay 都刚重置,通常空)。
            let a = self.peers[i].engine.on_relay_peer_up(&ids[j]); // 在线快照给新人
            let b = self.peers[j].engine.on_relay_peer_up(&ids[i]); // 上线事件给其他人
            outs.extend(a);
            cascaded.push((j, b));
        }
        self.route(i, outs);
        for (j, o) in cascaded {
            self.route(j, o);
        }
    }

    /// 设备掉线:本机会话断(只丢 relay 维度的连接态与在飞拉流)+ 服务器把离线事件
    /// 广播给其余在线设备(它们的 (i, Relay) 置 Absent)。
    fn set_offline(&mut self, i: usize) {
        self.peers[i].online = false;
        // 掉线者自己的重问投不出去(它离线了),但其余在线端的重问必须真的投出去
        // (实现审二轮 L1)。
        let _ = self.peers[i].engine.on_relay_session_down();
        let ids: Vec<String> = self.peers.iter().map(|p| p.device_id.clone()).collect();
        let mut cascaded: Vec<(usize, Vec<Output>)> = vec![];
        for j in 0..self.peers.len() {
            if j == i || !self.peers[j].online {
                continue;
            }
            cascaded.push((j, self.peers[j].engine.on_relay_peer_down(&ids[i])));
        }
        for (j, outs) in cascaded {
            self.route(j, outs);
        }
    }

    /// 消费某在线设备队列头的一帧。
    fn pump_one(&mut self, i: usize) -> bool {
        if !self.peers[i].online {
            return false;
        }
        let Some((from, msg)) = self.peers[i].inbox.pop_front() else { return false };
        let p = &mut self.peers[i];
        // 本模拟只有中转一条腿:来路恒 Relay(lan 投递路径的模拟归 L-c3 集成测)。
        let mut outs = p
            .engine
            .on_msg_v(&mut p.conn, &mut p.clock, &from, Route::Relay, msg)
            .expect("on_msg");
        // 第5笔起 Hello/Want 只**登记**对账义务,帧由消费腿逐帧取:本模拟没有传输层,
        // 故每喂一枚就自己抽一次(复用真取数路,见 drain_ops_for_test)。
        outs.extend(p.engine.drain_ops_for_test(&p.conn).expect("drain ops"));
        self.route(i, outs);
        true
    }

    /// 随机设备执行一条随机本地写命令(离线也照写——离线写是核心场景);在线才推送。
    fn local_command(&mut self, step: usize) {
        let i = self.rng.below(self.peers.len());
        let did_write = {
            let p = &mut self.peers[i];
            random_command(&mut p.conn, &mut p.clock, &mut self.rng, step)
        };
        if did_write && self.peers[i].online {
            let p = &mut self.peers[i];
            let mut outs = vec![];
            p.engine.outbound(&p.conn, &mut outs).expect("outbound");
            outs.extend(p.engine.drain_ops_for_test(&p.conn).expect("drain ops"));
            self.route(i, outs);
        }
    }

    /// 打一拍心跳(§6.2 ⑥):推进 tick(放行冷却里停着的对账/补洞义务)+ 本机 origin
    /// 重新派生,再把因此变得可跑的活抽出来。
    ///
    /// **第⑤笔起 settle 非有它不可**:Hello 此后只**登记**义务,同一对端连着来两枚时
    /// 第二枚落进冷却(`RECONCILE_COOLDOWN_TICKS`),没人打这一拍它就永远停在 `pending`
    /// ——表现出来正是「水位追不齐」。生产里这一拍由协调者心跳打。
    fn heartbeat(&mut self, i: usize) {
        if !self.peers[i].online {
            return;
        }
        let p = &mut self.peers[i];
        let mut outs = p.engine.on_tick();
        let _ = p.engine.ops_tick(&p.conn, &mut outs).expect("ops tick");
        outs.extend(p.engine.drain_ops_for_test(&p.conn).expect("drain ops"));
        self.route(i, outs);
    }

    /// 终局:反复「全员重连互报水位 + pump 到静默」,直到水位齐、缺字节清零(§5.2
    /// 周期性 hello 兜底一切丢帧)。超轮上限 = 不收敛。
    fn settle(&mut self) {
        for round in 0..MAX_SETTLE_ROUNDS {
            for i in 0..self.peers.len() {
                self.set_online(i);
            }
            let mut guard = 0usize;
            let mut beats = 0usize;
            loop {
                let mut any = false;
                for i in 0..self.peers.len() {
                    while self.pump_one(i) {
                        any = true;
                        guard += 1;
                        assert!(
                            guard < 200_000,
                            "pump 不静默(种子 {}, settle 第 {round} 轮)",
                            self.seed
                        );
                    }
                }
                // 帧跑干了不等于活干完了:冷却里还停着的义务要靠心跳放行。**有界**地补
                // 几拍(超过两档冷却即可),补完仍静默才算这一轮真到头。
                if !any && beats < BEATS_PER_ROUND {
                    beats += 1;
                    for i in 0..self.peers.len() {
                        self.heartbeat(i);
                    }
                    any = true;
                }
                if !any {
                    break;
                }
            }
            if self.quiesced() {
                return;
            }
        }
        for (i, p) in self.peers.iter().enumerate() {
            eprintln!(
                "peer{i}({}) 水位={:?} pending={:?} suspended={:?} missing={:?}",
                p.device_id,
                watermark_vector(&p.conn),
                p.engine.slots.iter().map(|(o, sl)| (o.clone(), sl.queue.len())).collect::<Vec<_>>(),
                p.engine.suspended_count(),
                p.engine.missing_blobs,
            );
        }
        eprintln!("frozen={:?} rejected={:?}", self.frozen, self.rejected);
        panic!("settle {MAX_SETTLE_ROUNDS} 轮仍未收敛(种子 {})", self.seed);
    }

    /// 轻量收敛检查:水位向量全员一致 + pending/缺字节/拉流全空。
    fn quiesced(&self) -> bool {
        let base = watermark_vector(&self.peers[0].conn);
        self.peers.iter().all(|p| {
            watermark_vector(&p.conn) == base
                && p.engine.slots.is_empty()
                && p.engine.missing_blobs.is_empty()
                && p.engine.pulling.is_empty()
                && p.inbox.is_empty()
        })
    }

    /// 全量收敛断言(§9):五表逐行相等 + 水位相等且 per-origin 连续 + 无冻结无拒帧。
    /// MetadataOnly 端(M1):`item_image` 明确允许不完整——但它有的每一行必须与
    /// 全量端逐字节相等(子集一致,不许有全量端没有的行、不许字节走样);其余
    /// 五张指纹 + 水位与全量端完全相等;全程零 BlobWant/BlobPull。
    fn assert_converged(&self) {
        assert!(self.frozen.is_empty(), "不该有 origin 冻结(种子 {}):{:?}", self.seed, self.frozen);
        assert!(self.rejected.is_empty(), "不该有整帧拒收(种子 {}):{:?}", self.seed, self.rejected);
        assert!(
            self.light_blob_asks.is_empty(),
            "MetadataOnly 端不许发 BlobWant/BlobPull(种子 {}):{:?}",
            self.seed,
            self.light_blob_asks
        );
        let base = self
            .peers
            .iter()
            .find(|p| p.policy == BlobPolicy::Full)
            .expect("至少一台全量端做基准");
        for p in &self.peers {
            assert!(p.engine.slots.is_empty(), "终局槽必空(种子 {})", self.seed);
            assert_eq!(p.engine.suspended_count(), 0, "终局无挂起(种子 {})", self.seed);
            assert!(p.engine.missing_blobs.is_empty(), "终局图字节必齐(种子 {})", self.seed);
            assert!(p.engine.pulling.is_empty(), "终局无悬空拉流(种子 {})", self.seed);
            assert_per_origin_contiguous(&p.conn, self.seed);
            for (label, sql) in FINGERPRINTS {
                let base_fp = fingerprint(&base.conn, sql);
                let mine = fingerprint(&p.conn, sql);
                if *label == "item_image(含字节)" && p.policy == BlobPolicy::MetadataOnly {
                    for row in &mine {
                        assert!(
                            base_fp.contains(row),
                            "轻端 {label} 行必须是全量端子集且逐字节相等(种子 {}):{row}",
                            self.seed
                        );
                    }
                    continue;
                }
                assert_eq!(base_fp, mine, "{label} 必须逐行相等(种子 {})", self.seed);
            }
            assert_eq!(
                watermark_vector(&base.conn),
                watermark_vector(&p.conn),
                "per-origin 水位向量相等(种子 {})",
                self.seed
            );
        }
    }
}

// ---- 随机命令流(覆盖全部 op 词汇:item/topic 的 create·set_field·tombstone、
//      link 的 add·remove、image 的 add·tombstone) ------------------------------------

fn ids(conn: &Connection, sql: &str) -> Vec<String> {
    let mut stmt = conn.prepare(sql).expect("prepare pick");
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).expect("query pick");
    rows.collect::<rusqlite::Result<_>>().expect("collect pick")
}

const LIVE_IDEAS: &str =
    "SELECT id FROM items WHERE stage IN ('inbox','filed') AND archived_at IS NULL ORDER BY id";
const LIVE_TASKS: &str = "SELECT id FROM items WHERE stage IN ('todo','doing','confirming','done') \
     AND archived_at IS NULL AND sealed_at IS NULL ORDER BY id";
const TRASH_IDEAS: &str =
    "SELECT id FROM items WHERE stage IN ('inbox','filed') AND archived_at IS NOT NULL ORDER BY id";
const TRASH_TASKS: &str = "SELECT id FROM items WHERE stage IN ('todo','doing','confirming','done') \
     AND archived_at IS NOT NULL ORDER BY id";
const SEALED: &str = "SELECT id FROM items WHERE sealed_at IS NOT NULL ORDER BY id";
const DONE_TASKS: &str = "SELECT id FROM items WHERE stage = 'done' \
     AND archived_at IS NULL AND sealed_at IS NULL ORDER BY id";
const TOPICS: &str = "SELECT id FROM topics ORDER BY id";
const IMAGES: &str = "SELECT id FROM item_image ORDER BY id";
/// 0035:全部现存留言(随机命令流的删除面)。
const COMMENTS: &str = "SELECT id FROM item_comment ORDER BY id";

/// 留言两支的**覆盖计数**(codex 实现审二弹 M4)。
///
/// 「随机流里加了两支命令」证不了它们真被执行过 —— 把两支都改成 no-op,`item_comment`
/// 全程为空,全表指纹照样处处相等、测试照样全绿(**零覆盖的空绿**,与 P4-d 轮 M3 抓到的
/// 「轻端零 want」同款)。所以数一下真跑成了几次,并在测试末尾断言两支都 > 0。
static COMMENT_ADDS: AtomicUsize = AtomicUsize::new(0);
static COMMENT_REMOVES: AtomicUsize = AtomicUsize::new(0);

/// 0033 设备名册的**命名对象池** = 本库见过的全部设备(oplog 的 origin 集合,
/// `origin` 是 `substr(hlc, 24)` 的虚拟生成列 = 完整 26 位 device_id)。
///
/// ⚠ **刻意不只命名自己**(328 补这一支时定的形):`set_device_alias` 的 `device_id`
/// 是参数、不锁本机(名册是账户内共享的,给别的设备改名是合法操作)。若随机流只命名
/// 自己,三端各写各的 entity_id,**字段级 LWW 撞写那一格就永远验不到**。从 origin 池里
/// 挑,随同步推进三端会互相见到对方,「两端同时给同一台设备改名」自然发生。
const SEEN_DEVICES: &str = "SELECT DISTINCT origin FROM oplog ORDER BY 1";

/// 设备别名两支的**覆盖计数**,理由同上面留言那两支。
///
/// ⚠ 与留言那两支不同的是:`identity::set_device_alias` **有幂等 no-op**(行在且值同就
/// 直接 `Ok(())`,一条 op 都不发)。只在 `Ok` 上计数会把「值没变」也记成一次覆盖 ——
/// 那正好是这两个计数要防的「看着有覆盖、其实没写」。故按 **device op 条数真的长了**
/// 来计(见 `device_op_count`)。
static DEVICE_ALIAS_SETS: AtomicUsize = AtomicUsize::new(0);
static DEVICE_ALIAS_CLEARS: AtomicUsize = AtomicUsize::new(0);

/// 本库里 device set_field op 的条数 —— 判「这一笔到底发没发 op」的唯一诚实判据。
fn device_op_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM oplog WHERE entity = 'device'", [], |r| r.get(0))
        .expect("count device ops")
}

/// 累计「同一台设备被**两台以上不同机器**命名过」的台数 = 字段级 LWW 真的撞过写。
///
/// ⚠ 这是 [`SEEN_DEVICES`] 那个设计意图的**唯一守卫**,而且缺了它谁都发现不了:把命名
/// 对象退化成「只命名自己」之后,三端各写各的 `entity_id`,`device_profile` 照样三份逐字
/// 相等 —— 全部指纹断言一条都不会红,可「验到了 LWW 收敛」是假的(每台设备上只有一个
/// 写者,根本没有赢家可选)。上面那两个 SETS/CLEARS 计数也照样 > 0,同样兜不住。
static DEVICE_LWW_COLLISIONS: AtomicUsize = AtomicUsize::new(0);

fn device_lww_collisions(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM (SELECT entity_id FROM oplog WHERE entity = 'device' \
         GROUP BY entity_id HAVING COUNT(DISTINCT origin) > 1)",
        [],
        |r| r.get(0),
    )
    .expect("count device lww collisions")
}
const LIVE_ANY: &str = "SELECT id FROM items WHERE archived_at IS NULL AND sealed_at IS NULL ORDER BY id";

/// 执行一条随机写命令,返回是否真的写了(Err = 前置不满足,跳过——编排自持事务,
/// 失败即回滚不脏库、无 op 发射)。标签名取小池子(t0..t3):同机重名被编排拒,
/// **跨机重名天然发生**——「同名标签并存」正是规格 §6.2 的约定终局。
fn random_command(conn: &mut Connection, clock: &mut Clock, rng: &mut Rng, step: usize) -> bool {
    // ⚠ 改这个上限会**重排全部种子的命令序列**(328 从 27 加到 28 时如此)。这只 property
    // test 靠广度不靠特定路径,故可接受;但「种子 1 当年抓到活锁」那条战绩指的是旧序列,
    // 别拿它当今天还在复现的回归锚。
    let roll = rng.below(28);
    let done: Result<(), String> = match roll {
        0..=3 => notes::capture(conn, clock, &format!("灵感 {step}-{}", rng.below(1000))).map(|_| ()),
        4 => match rng.pick(&ids(conn, LIVE_IDEAS)).cloned() {
            Some(id) => notes::edit(conn, clock, &id, &format!("改稿 {step}")),
            None => Ok(()),
        },
        5 => match rng.pick(&ids(conn, LIVE_IDEAS)).cloned() {
            Some(id) => notes::promote_to_task(conn, clock, &id, &format!("转办 {step}")).map(|_| ()),
            None => Ok(()),
        },
        6 => task::create(
            conn,
            clock,
            &format!("任务 {step}"),
            [None, Some("2026-07-20"), Some("2026-08-01")][rng.below(3)],
            [None, Some(1), Some(2), Some(3)][rng.below(4)],
            None,
        )
        .map(|_| ()),
        7 => match rng.pick(&ids(conn, LIVE_TASKS)).cloned() {
            Some(id) => {
                let to = ["todo", "doing", "confirming", "done"][rng.below(4)];
                task::transition(conn, clock, &id, to)
            }
            None => Ok(()),
        },
        8 => match rng.pick(&ids(conn, LIVE_TASKS)).cloned() {
            Some(id) => task::set_due(conn, clock, &id, [None, Some("2026-09-01")][rng.below(2)]),
            None => Ok(()),
        },
        9 => match rng.pick(&ids(conn, LIVE_TASKS)).cloned() {
            Some(id) => task::set_priority(conn, clock, &id, [None, Some(1), Some(2)][rng.below(3)]),
            None => Ok(()),
        },
        10 => match rng.pick(&ids(conn, LIVE_TASKS)).cloned() {
            Some(id) => task::rename(conn, clock, &id, &format!("改名 {step}")),
            None => Ok(()),
        },
        11 => notes::create_topic(conn, clock, &format!("t{}", rng.below(4))).map(|_| ()),
        12 => match rng.pick(&ids(conn, TOPICS)).cloned() {
            Some(id) => notes::rename_topic(conn, clock, &id, &format!("t{}改", rng.below(4))),
            None => Ok(()),
        },
        13 => match rng.pick(&ids(conn, TOPICS)).cloned() {
            Some(id) => notes::delete_topic(conn, clock, &id),
            None => Ok(()),
        },
        14 => match (
            rng.pick(&ids(conn, LIVE_IDEAS)).cloned(),
            rng.pick(&ids(conn, TOPICS)).cloned(),
        ) {
            (Some(idea), Some(topic)) => {
                notes::file_to_topic(conn, clock, &idea, Some(&topic), None).map(|_| ())
            }
            _ => Ok(()),
        },
        15 => match (
            rng.pick(&ids(conn, LIVE_TASKS)).cloned(),
            rng.pick(&ids(conn, TOPICS)).cloned(),
        ) {
            (Some(task_id), Some(topic)) => task::add_topic(conn, clock, &task_id, &topic),
            _ => Ok(()),
        },
        16 => match rng.pick(&ids(conn, LIVE_TASKS)).cloned() {
            Some(task_id) => match rng
                .pick(&ids(conn, &format!(
                    "SELECT topic_id FROM item_topic WHERE item_id = '{task_id}' ORDER BY topic_id"
                )))
                .cloned()
            {
                Some(topic) => task::remove_topic(conn, clock, &task_id, &topic),
                None => Ok(()),
            },
            None => Ok(()),
        },
        17 => {
            // 软删进回收站(灵感或任务)。
            if rng.below(2) == 0 {
                match rng.pick(&ids(conn, LIVE_IDEAS)).cloned() {
                    Some(id) => notes::archive(conn, clock, &id),
                    None => Ok(()),
                }
            } else {
                match rng.pick(&ids(conn, LIVE_TASKS)).cloned() {
                    Some(id) => task::archive(conn, clock, &id),
                    None => Ok(()),
                }
            }
        }
        18 => {
            // 回收站:还原或彻底删除(item tombstone)。
            match (rng.below(2), rng.below(2)) {
                (0, 0) => match rng.pick(&ids(conn, TRASH_IDEAS)).cloned() {
                    Some(id) => notes::restore(conn, clock, &id),
                    None => Ok(()),
                },
                (0, 1) => match rng.pick(&ids(conn, TRASH_TASKS)).cloned() {
                    Some(id) => task::restore(conn, clock, &id),
                    None => Ok(()),
                },
                (1, 0) => match rng.pick(&ids(conn, TRASH_IDEAS)).cloned() {
                    Some(id) => notes::purge(conn, clock, &id),
                    None => Ok(()),
                },
                _ => match rng.pick(&ids(conn, TRASH_TASKS)).cloned() {
                    Some(id) => task::purge(conn, clock, &id),
                    None => Ok(()),
                },
            }
        }
        19 => {
            // 成就归档往返(sealed_at 两个方向的 set_field)。
            if rng.below(2) == 0 {
                match rng.pick(&ids(conn, DONE_TASKS)).cloned() {
                    Some(id) => task::seal(conn, clock, &id),
                    None => Ok(()),
                }
            } else {
                match rng.pick(&ids(conn, SEALED)).cloned() {
                    Some(id) => task::unseal(conn, clock, &id),
                    None => Ok(()),
                }
            }
        }
        20 => match rng.pick(&ids(conn, LIVE_ANY)).cloned() {
            Some(id) => {
                let n = 2 + rng.below(5);
                let bytes: Vec<u8> = (0..n).map(|_| rng.next() as u8).collect();
                images::attach(conn, clock, &id, &bytes, "image/png").map(|_| ())
            }
            None => Ok(()),
        },
        21 => match rng.pick(&ids(conn, IMAGES)).cloned() {
            Some(id) => images::remove(conn, clock, &id),
            None => Ok(()),
        },
        // 标签手动排序(0031 position set_field):把一枚标签拖到另一枚之前(prev=None,
        // next=目标)。目标未定序(transient)→ reorder_topic 内部 fail-fast、合法跳过。
        22 => {
            let topics = ids(conn, TOPICS);
            match (rng.pick(&topics).cloned(), rng.pick(&topics).cloned()) {
                (Some(t), Some(n)) if t != n => notes::reorder_topic(conn, clock, &t, None, Some(&n)),
                _ => Ok(()),
            }
        }
        // 标签类型(0031 kind set_field):设/清自由文本类型,小池子跨机并发撞写走 LWW。
        23 => match rng.pick(&ids(conn, TOPICS)).cloned() {
            Some(id) => {
                let k: Option<String> =
                    [None, Some("人名".to_string()), Some("项目".to_string())][rng.below(3)].clone();
                notes::set_topic_kind(conn, clock, &id, k)
            }
            None => Ok(()),
        },
        // 0035 条目留言:写一条(宿主取活条目)。并发下两端各写各的,OR 语义天然收敛;
        // 与 item 删除撞车时靠 FK CASCADE + ParentGone 收口。
        24 => match rng.pick(&ids(conn, LIVE_ANY)).cloned() {
            Some(id) => crate::comments::add(conn, clock, &id, &format!("留言 {step}-{}", rng.below(1000)))
                .map(|_| COMMENT_ADDS.fetch_add(1, Ordering::Relaxed))
                .map(|_| ()),
            None => Ok(()),
        },
        // 0035:删一条留言(tombstone sticky —— 迟到的 create 不许复活它)。
        25 => match rng.pick(&ids(conn, COMMENTS)).cloned() {
            Some(id) => crate::comments::remove(conn, clock, &id).inspect(|_| {
                COMMENT_REMOVES.fetch_add(1, Ordering::Relaxed);
            }),
            None => Ok(()),
        },
        // 0033 设备别名(device 多实例 LWW 寄存器):命名对象从**本库见过的设备**里挑
        // (见 SEEN_DEVICES 的头注:只命名自己就验不到撞写),值取小池子 + **清名**
        // (`None` 是「显式清名」的规范表示,与「没有这一行」不同——epoch 合成基线与
        // boot 双侧预审都特判过它,指纹里的 quote() 也是为它)。
        26 => match rng.pick(&ids(conn, SEEN_DEVICES)).cloned() {
            Some(target) => {
                let alias = [None, Some("设备甲"), Some("设备乙"), Some("设备丙")][rng.below(4)];
                let before = device_op_count(conn);
                let r = crate::identity::set_device_alias(conn, clock, &target, alias);
                // 幂等 no-op 不计:只有 op 真长了才算一次覆盖(见计数器头注)。
                if r.is_ok() && device_op_count(conn) > before {
                    let bag = if alias.is_some() { &DEVICE_ALIAS_SETS } else { &DEVICE_ALIAS_CLEARS };
                    bag.fetch_add(1, Ordering::Relaxed);
                }
                r
            }
            None => Ok(()),
        },
        // 空间改名(0028 space 单例寄存器):小池子名跨机并发撞写,LWW 收敛由
        // space_profile 指纹断言(space-name-sync-plan §7)。
        _ => crate::spaces::set_space_name(conn, clock, &format!("空间名{}", rng.below(4))),
    };
    done.is_ok() // Err = 前置不满足(合法跳过);写没写成看 oplog 是否长了——
                 // 调用方 outbound 自己按水位判断,这里返回值只是「别白跑一趟」的提示。
}

// ---- 指纹与不变量 -------------------------------------------------------------------

const FINGERPRINTS: &[(&str, &str)] = &[
    // items 刨去 updated_at(本地簿记,两端刻意不同,同 replay.rs 镜像测试的约定)。
    (
        "items",
        "SELECT id||'|'||content||'|'||stage||'|'||created_at \
         ||'|'||COALESCE(archived_at,'∅')||'|'||COALESCE(due_on,'∅')||'|'||COALESCE(priority,'∅') \
         ||'|'||COALESCE(position,'∅')||'|'||COALESCE(sealed_at,'∅')||'|'||COALESCE(born_stage,'∅') \
         ||'|'||COALESCE(done_at,'∅')||'|'||COALESCE(born_device,'∅') \
         FROM items ORDER BY id",
    ),
    (
        "topics",
        "SELECT id||'|'||title||'|'||created_at||'|'||updated_at \
         ||'|'||COALESCE(color,'∅')||'|'||COALESCE(position,'∅')||'|'||quote(kind) \
         FROM topics ORDER BY id",
    ),
    ("item_topic", "SELECT item_id||'|'||topic_id FROM item_topic ORDER BY item_id, topic_id"),
    // 0035 留言:四列全进(quote() 让 born_device 的 NULL 与字面「∅」不同指纹)。
    (
        "item_comment",
        "SELECT id||'|'||item_id||'|'||content||'|'||created_at||'|'||quote(born_device) \
         FROM item_comment ORDER BY id",
    ),
    (
        "item_image(含字节)",
        "SELECT id||'|'||item_id||'|'||seq||'|'||mime||'|'||hex(data) FROM item_image ORDER BY id",
    ),
    ("item_image_counter", "SELECT item_id||'|'||last_seq FROM item_image_counter ORDER BY item_id"),
    // quote():合法名字「∅」不与 NULL 同指纹(codex L;随机名池撞不上,防御一致性)。
    ("space_profile", "SELECT key||'|'||quote(name) FROM space_profile ORDER BY key"),
    // 0033 设备名册(device 多实例 LWW 寄存器,328 补)。quote() 同上:**显式清名**的
    // NULL 不与某个恰好叫「∅」的别名同指纹。三端收敛后每个 device_id 上的赢家由
    // (entity, entity_id, field) 的字段级 LWW 定,本机写与回放走的是**逐字同一句 UPSERT**。
    ("device_profile", "SELECT device_id||'|'||quote(alias) FROM device_profile ORDER BY device_id"),
    ("oplog", "SELECT op_id||'|'||hlc||'|'||origin_seq FROM oplog ORDER BY op_id"),
];

fn fingerprint(conn: &Connection, sql: &str) -> Vec<String> {
    let mut stmt = conn.prepare(sql).expect("prepare fp");
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).expect("query fp");
    rows.collect::<rusqlite::Result<_>>().expect("collect fp")
}

fn watermark_vector(conn: &Connection) -> Vec<(String, i64)> {
    let mut stmt = conn
        .prepare("SELECT origin, MAX(origin_seq) FROM oplog GROUP BY origin ORDER BY origin")
        .expect("prepare wm");
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("query wm");
    rows.collect::<rusqlite::Result<_>>().expect("collect wm")
}

fn assert_per_origin_contiguous(conn: &Connection, seed: u64) {
    let holes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM (SELECT COUNT(*) AS c, MIN(origin_seq) AS mn, \
             MAX(origin_seq) AS mx FROM oplog GROUP BY origin) WHERE mn != 1 OR mx != c",
            [],
            |r| r.get(0),
        )
        .expect("holes");
    assert_eq!(holes, 0, "per-origin seq 必须连续 1..max 无洞(种子 {seed})");
}

// ---- 入口 ---------------------------------------------------------------------------

/// 一个种子跑一整场:随机事件流 → settle → 全量断言。返回轻端收到的**远端**
/// image_add op 总数(覆盖计数,codex P4-d 轮 M3:单种子可能为 0,聚合断言在
/// 测试里做,防「随机流零覆盖仍通过」)。
fn run(seed: u64, policies: &[BlobPolicy]) -> usize {
    let mut sim = Sim::new(seed, policies);
    // 起步全员在线(各自 hello 一轮,水位皆空无补给)。
    for i in 0..sim.peers.len() {
        sim.set_online(i);
    }
    for step in 0..STEPS {
        match sim.rng.below(100) {
            0..=44 => sim.local_command(step),
            45..=79 => {
                let i = sim.rng.below(sim.peers.len());
                sim.pump_one(i);
            }
            80..=87 => {
                let i = sim.rng.below(sim.peers.len());
                if sim.peers[i].online {
                    sim.set_offline(i);
                } else {
                    sim.set_online(i);
                }
            }
            88..=91 => {
                // 信箱衰减(TTL 的惰性驱逐):只打离线设备的堆积。
                let i = sim.rng.below(sim.peers.len());
                if !sim.peers[i].online {
                    for _ in 0..=sim.rng.below(3) {
                        sim.peers[i].inbox.pop_front();
                    }
                }
            }
            92..=95 => {
                // 服务器重启:信箱与在途全失(§4「重启即失、永不写盘」),全员断连。
                for i in 0..sim.peers.len() {
                    sim.peers[i].inbox.clear();
                    sim.set_offline(i);
                }
            }
            _ => {
                // 引擎重启(app 崩溃/重启):pending/挂起/拉流全丢——§5.3「崩溃即丢
                // 也无害」的实弹;在线设备随即重连(transport 自动)。策略随库沿用。
                let i = sim.rng.below(sim.peers.len());
                let p = &mut sim.peers[i];
                p.engine = Engine::new_solo(&p.conn, p.policy).expect("engine restart")
                    .with_pending_cap(PENDING_CAP);
                p.engine.on_runtime_started(&p.conn).expect("runtime started");
                if sim.peers[i].online {
                    sim.set_offline(i);
                    sim.set_online(i);
                }
            }
        }
    }
    sim.settle();
    sim.assert_converged();
    // 328:收敛后三份 oplog 相同,取任一台数一次「同一设备被多机命名」——见
    // DEVICE_LWW_COLLISIONS 头注(它守的退化形是全部指纹断言都兜不住的那种)。
    DEVICE_LWW_COLLISIONS
        .fetch_add(device_lww_collisions(&sim.peers[0].conn) as usize, Ordering::Relaxed);
    sim.peers
        .iter()
        .filter(|p| p.policy == BlobPolicy::MetadataOnly)
        .map(|p| {
            p.conn
                .query_row(
                    "SELECT COUNT(*) FROM oplog WHERE entity = 'image' \
                     AND kind = 'image_add' AND origin != ?1",
                    [&p.device_id],
                    |r| r.get::<_, i64>(0),
                )
                .expect("count remote image_add") as usize
        })
        .sum()
}

/// 常规种子批 + 固化的反例种子(出过反例就钉在这,永久回归)。
/// 战绩:种子 1 首跑即抓到「池上限在 drain 前误杀连续补给帧 → 活锁」的真 bug。
#[test]
fn three_peers_converge_under_partitions_reorder_and_loss() {
    for seed in 1..=20u64 {
        run(seed, &[BlobPolicy::Full; 3]);
    }
    // 覆盖断言(codex 实现审二弹 M4):留言那两支必须真被跑过 —— 否则「加了两支命令」
    // 只是加了两行代码,`item_comment` 全程为空而指纹处处相等,这测什么都没测。
    assert!(COMMENT_ADDS.load(Ordering::Relaxed) > 0, "随机流里一条留言都没写成");
    assert!(COMMENT_REMOVES.load(Ordering::Relaxed) > 0, "随机流里一条留言都没删成");
    // 设备别名同理(328)。两支分开断言:**清名走的是 NULL 那条路**,与设一个名字在
    // 存储层、指纹层(quote())、压实基线合成三处都不同形,合并成一条会让它假绿。
    assert!(DEVICE_ALIAS_SETS.load(Ordering::Relaxed) > 0, "随机流里一个设备别名都没设成");
    assert!(DEVICE_ALIAS_CLEARS.load(Ordering::Relaxed) > 0, "随机流里一次设备清名都没发生");
    assert!(
        DEVICE_LWW_COLLISIONS.load(Ordering::Relaxed) > 0,
        "没有任何一台设备被两台以上机器命名过 —— 那 device 的字段级 LWW 一次都没被验到\
         (每台设备只有一个写者时根本没有赢家可选),而全部指纹断言都不会因此变红",
    );
}

/// 留言的**确定性**三端场景(codex 实现审二弹 M4;随机流管广度,这只管「本案那条路」)。
///
/// 四幕:①两端离线各给**同一条** item 写留言 → ②汇合,两条都在(OR 语义,不是 LWW);
/// ③一端删掉其中一条、另一端同时再写一条新的 → ④再汇合,终态三方逐字相等且「删了的
/// 不复活、新写的都在」。
#[test]
fn comments_converge_across_offline_writes_and_a_concurrent_delete() {
    let mut sim = Sim::new(9001, &[BlobPolicy::Full; 3]);
    for i in 0..3 {
        sim.set_online(i);
    }
    // 幕 0:0 号建宿主,全网同步。
    let host = { let p = &mut sim.peers[0]; notes::capture(&mut p.conn, &mut p.clock, "共同话题").unwrap() };
    sim.settle();

    // 幕 1:0 与 1 都离线,各写一条。
    sim.set_offline(0);
    sim.set_offline(1);
    let a = { let p = &mut sim.peers[0]; crate::comments::add(&mut p.conn, &mut p.clock, &host, "甲说").unwrap() };
    let b = { let p = &mut sim.peers[1]; crate::comments::add(&mut p.conn, &mut p.clock, &host, "乙说").unwrap() };

    // 幕 2:汇合 —— 两条都要在(留言是 OR 集,不是「谁后写谁赢」)。
    sim.settle();
    for i in 0..3 {
        let ids = ids(&sim.peers[i].conn, COMMENTS);
        assert_eq!(ids.len(), 2, "第 {i} 台:离线各写的两条都该在");
        assert!(ids.contains(&a) && ids.contains(&b), "第 {i} 台:{ids:?}");
    }

    // 幕 3:2 号删掉甲那条,同时 1 号(离线)再写一条。
    sim.set_offline(1);
    { let p = &mut sim.peers[2]; crate::comments::remove(&mut p.conn, &mut p.clock, &a).unwrap(); }
    let c = { let p = &mut sim.peers[1]; crate::comments::add(&mut p.conn, &mut p.clock, &host, "乙又说").unwrap() };

    // 幕 4:再汇合 —— 删了的不复活,新写的都在,三方逐字相等(由 assert_converged 兜全表)。
    sim.settle();
    for i in 0..3 {
        let ids = ids(&sim.peers[i].conn, COMMENTS);
        assert!(!ids.contains(&a), "第 {i} 台:删掉的留言不许复活");
        assert!(ids.contains(&b) && ids.contains(&c), "第 {i} 台:{ids:?}");
        assert_eq!(ids.len(), 2);
    }
    sim.assert_converged();
}

/// M1 测试②(android-plan §4):三实例其一 MetadataOnly(手机轻端)——同一随机
/// 事件流(含全部任务 op:create/transition,验收矩阵⑤)下,oplog/水位/items/
/// topics/link/counter 全员收敛;`item_image` 轻端允许不完整(子集且逐字节一致);
/// 轻端全程零 BlobWant/BlobPull(路由层稽查)。原 Full 收敛测一字不弱(上面那只)。
/// 聚合覆盖断言:20 个种子里轻端至少真收到过远端 image_add(否则「零 want」是
/// 零覆盖的空话,codex P4-d 轮 M3)。
#[test]
fn light_peer_converges_metadata_only_without_asking_for_blobs() {
    let mut remote_image_adds_at_light = 0usize;
    for seed in 1..=20u64 {
        remote_image_adds_at_light +=
            run(seed, &[BlobPolicy::Full, BlobPolicy::Full, BlobPolicy::MetadataOnly]);
    }
    assert!(
        remote_image_adds_at_light > 0,
        "20 个种子里轻端必须真收到过远端 image_add,否则本测试没测到东西"
    );
}
