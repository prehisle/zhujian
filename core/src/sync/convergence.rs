//! 双~三实例收敛 property test(sync-protocol §9,sync-plan 的 P2 止损探针)。
//!
//! 三个引擎实例(各配真 SQLite)+ 内存服务器模型(§4 信箱语义:每收件设备一条 FIFO
//! 队列、离线堆积按容量丢最老、随机衰减模拟 TTL、重启清空、direct 不入信箱)。随机
//! 命令流(覆盖全部 11 种 entity·kind,0028 起含 space set_field)× 随机上下线 ×
//! 乱序交错投递 × 引擎重启;终局全员在线、反复 hello 互补直到静默,断言六张同步表
//! 逐行相等(items 刨去本地簿记 updated_at;item_image 含字节)+ per-origin 水位
//! 相等且连续 + 无冻结无拒帧。
//!
//! 确定性说明:种子只固定**事件序列**(命令选择/分区/投递交错);HLC/ULID 内嵌真实
//! 墙钟与随机位,是环境噪声——断言的是「任意交错下都收敛」,与具体 LWW 胜者无关。
//! 反例种子固化进 SEEDS 数组当回归(§9)。

use rusqlite::Connection;
use std::collections::VecDeque;

use crate::clock::Clock;
use crate::sync::engine::{BlobPolicy, Engine, Event, Lane, Msg, Output, BROADCAST};
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
                let path = std::env::temp_dir()
                    .join(format!("ys-nb-conv-{}-{}.sqlite3", std::process::id(), k));
                let _ = std::fs::remove_file(&path);
                let conn = db::open(&path).expect("open migrated db");
                let clock = Clock::load(&conn).expect("load clock");
                let engine =
                    Engine::new(&conn, policy).expect("engine").with_pending_cap(PENDING_CAP);
                let device_id = clock.device_id().to_string();
                Peer { device_id, conn, clock, engine, policy, online: false, inbox: VecDeque::new(), _path: path }
            })
            .collect();
        Sim { seed, rng: Rng::new(seed), peers, frozen: vec![], rejected: vec![], light_blob_asks: vec![] }
    }

    /// 路由一批引擎输出:Send 进目标队列(离线信箱裁容量;direct 只投在线,离线目标
    /// 通知发送者不可达),事件按类收集(冻结/拒帧在本测试里 = 违约)。
    fn route(&mut self, from_idx: usize, outputs: Vec<Output>) {
        for output in outputs {
            match output {
                Output::Send { to, lane, msg } => {
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
                            let target_id = self.peers[t].device_id.clone();
                            self.peers[from_idx].engine.on_peer_unreachable(&target_id);
                        }
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
    }

    /// 设备上线:重连仪式 = hello 广播 + 缺字节重发 + 推送离线期间攒的本机 op。
    fn set_online(&mut self, i: usize) {
        self.peers[i].online = true;
        let p = &mut self.peers[i];
        let mut outs = p.engine.on_connected(&p.conn).expect("on_connected");
        outs.extend(p.engine.outbound(&p.conn).expect("outbound"));
        self.route(i, outs);
    }

    /// 消费某在线设备队列头的一帧。
    fn pump_one(&mut self, i: usize) -> bool {
        if !self.peers[i].online {
            return false;
        }
        let Some((from, msg)) = self.peers[i].inbox.pop_front() else { return false };
        let p = &mut self.peers[i];
        let outs = p.engine.on_msg(&mut p.conn, &mut p.clock, &from, msg).expect("on_msg");
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
            let outs = p.engine.outbound(&p.conn).expect("outbound");
            self.route(i, outs);
        }
    }

    /// 终局:反复「全员重连互报水位 + pump 到静默」,直到水位齐、缺字节清零(§5.2
    /// 周期性 hello 兜底一切丢帧)。超轮上限 = 不收敛。
    fn settle(&mut self) {
        for round in 0..MAX_SETTLE_ROUNDS {
            for i in 0..self.peers.len() {
                self.set_online(i);
            }
            let mut guard = 0usize;
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
const LIVE_ANY: &str = "SELECT id FROM items WHERE archived_at IS NULL AND sealed_at IS NULL ORDER BY id";

/// 执行一条随机写命令,返回是否真的写了(Err = 前置不满足,跳过——编排自持事务,
/// 失败即回滚不脏库、无 op 发射)。标签名取小池子(t0..t3):同机重名被编排拒,
/// **跨机重名天然发生**——「同名标签并存」正是规格 §6.2 的约定终局。
fn random_command(conn: &mut Connection, clock: &mut Clock, rng: &mut Rng, step: usize) -> bool {
    let roll = rng.below(25);
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
         ||'|'||COALESCE(done_at,'∅') \
         FROM items ORDER BY id",
    ),
    (
        "topics",
        "SELECT id||'|'||title||'|'||created_at||'|'||updated_at \
         ||'|'||COALESCE(color,'∅')||'|'||COALESCE(position,'∅')||'|'||quote(kind) \
         FROM topics ORDER BY id",
    ),
    ("item_topic", "SELECT item_id||'|'||topic_id FROM item_topic ORDER BY item_id, topic_id"),
    (
        "item_image(含字节)",
        "SELECT id||'|'||item_id||'|'||seq||'|'||mime||'|'||hex(data) FROM item_image ORDER BY id",
    ),
    ("item_image_counter", "SELECT item_id||'|'||last_seq FROM item_image_counter ORDER BY item_id"),
    // quote():合法名字「∅」不与 NULL 同指纹(codex L;随机名池撞不上,防御一致性)。
    ("space_profile", "SELECT key||'|'||quote(name) FROM space_profile ORDER BY key"),
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
                    sim.peers[i].online = false;
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
                for p in &mut sim.peers {
                    p.inbox.clear();
                    p.online = false;
                }
            }
            _ => {
                // 引擎重启(app 崩溃/重启):pending/挂起/拉流全丢——§5.3「崩溃即丢
                // 也无害」的实弹;在线设备随即重连(transport 自动)。策略随库沿用。
                let i = sim.rng.below(sim.peers.len());
                let p = &mut sim.peers[i];
                p.engine = Engine::new(&p.conn, p.policy)
                    .expect("engine restart")
                    .with_pending_cap(PENDING_CAP);
                if sim.peers[i].online {
                    sim.peers[i].online = false;
                    sim.set_online(i);
                }
            }
        }
    }
    sim.settle();
    sim.assert_converged();
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
