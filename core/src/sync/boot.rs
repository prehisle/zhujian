//! P2-f 引导 —— sync-protocol §6.2 的落实(fresh-to-account 设备拿全量:快照直通 +
//! ATTACH 表级导入合并)。
//!
//! 为什么不能靠 op 回放:0020 之前的存量数据没有 create op(sync-plan §3.5「legacy
//! 全量引导走状态通道」);为什么不换库:换库撞 `device_id` 冻结触发器(0019),且丢
//! 新端配对前本地已捕获的数据——引导是**并集**(克隆快照 + 保留本地),不是覆盖。
//!
//! 分工(sans-io,不持 socket;P2-g 的传输层做信封收发与编排):
//!
//!   * 老端:[`make_snapshot`](`VACUUM INTO`,WAL 下取一致性快照)→ [`BootSender`]
//!     逐帧产出 [`BootMsg`](Offer 带总长与 sha256,Chunk 256 KiB 连续块;boot 域
//!     direct 直通,不入信箱不驻留)。
//!   * 新端:[`check_fresh_to_account`](两条判据缺一不可,评审①-H1)→
//!     [`BootReceiver`] 攒块落临时文件(错源/错 transfer 静默丢 [§5.4 blob 同款],
//!     错序/超声明作废,收全验长度 + sha256)→ [`import_snapshot`](ATTACH 只读 +
//!     回放豁免单事务表级导入 + 0023 同款 counter 校验 + per-origin 连续性断言 +
//!     `clock.observe(导入 max HLC)` + 同事务写 `bootstrapped_at` 标记)。
//!
//! 导入必须在**回放豁免**下做:快照行处于 LWW/历史终态(sealed 非空、born_stage 为
//! NULL 的 0018 前遗产、born_stage ≠ stage 的转办行、耦合不变量的合法违反态),单机
//! INSERT 守护会拦——0022 的豁免 + 0025 补的两只 INSERT 豁免在此生效;单机路径照拦。
//!
//! **导入完成后调用方必须重建 `Engine` 并重走 `on_connected`**(P2-g 接线契约):
//! 引擎的 pending 池出队条件是严格 `seq == watermark+1`,导入一次性抬高水位后,池内
//! 低于水位的旧队头永不出队会堵死该 origin;引擎全部状态本就是可丢内存态(engine.rs
//! 模块注释),重建后水位从库重新派生、缺字节图清单从日志重新派生,重发 hello 互补
//! ——规格 §6.2 步骤 6「pending 自然续上」以「重建 + hello 重取」兑现,水位不过缺口,
//! 零丢失。
//!
//! 同账户并发引导两台新端:各自独立拉快照、互不写对方,收敛靠之后的水位互补(§6.2,
//! 不加锁);两边同名标签并存为两个 topic,用户用既有「合并标签」收敛,不代合并。

use rusqlite::{Connection, DatabaseName, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use ulid::Ulid;

use crate::clock::{Clock, Hlc};

/// 快照分块大小(§6.2:256 KiB/块,与图字节旁路同刀法)。
pub const BOOT_CHUNK_BYTES: usize = 256 * 1024;
/// 快照大小 sanity 红线(个人库量级的宽裕上界;对端是已配对的自家设备,这只是
/// 「声明天文数字让收端写穿磁盘」的响亮止损,不是安全边界)。
pub const MAX_SNAPSHOT_BYTES: i64 = 8 * 1024 * 1024 * 1024;

/// boot 域内层消息(direct lane;CBOR externally tagged,黄金向量焊死——与
/// `engine::Msg`(op/ctl/blob 域)是两个独立消息空间,域子钥 + AAD domain 隔死)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BootMsg {
    /// 新端 → 老端:请求快照(fresh 校验已过;向哪台老端发由调用方定,§6.2 步骤 1)。
    Req,
    /// 老端 → 新端:快照流开始。transfer=老端取号 ULID(同一对设备先后两次引导的
    /// 残帧靠它区分);bytes/sha256 覆盖整个快照文件。
    Offer {
        transfer: String,
        bytes: i64,
        #[serde(with = "serde_bytes")]
        sha256: Vec<u8>,
    },
    /// 老端 → 新端:快照块(idx 从 0 连续,last 标终块)。
    Chunk {
        transfer: String,
        idx: u32,
        last: bool,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
}

// ---- 老端:快照与出流 ----------------------------------------------------------

/// 一份待直通的快照(`VACUUM INTO` 产物;用完由调用方删除文件)。
#[derive(Debug)]
pub struct Snapshot {
    pub path: PathBuf,
    pub bytes: i64,
    pub sha256: [u8; 32],
}

/// `VACUUM INTO` 取一致性快照(WAL 下天然含未 checkpoint 的改动;§6.2 步骤 2,
/// 调用方持库锁语境 [write_locks] 下做)。目标文件必须不存在(VACUUM INTO 语义),
/// 文件名带 ULID 免撞。
pub fn make_snapshot(conn: &Connection, dir: &Path) -> Result<Snapshot, String> {
    // 源端供货闸(epoch-plan §3.3):快照出手前对本库跑完整严格电池——**不是**只看
    // `epoch` KV(标记可孤立漂移,真相恒是电池本身)。不过 = 本空间还带着 legacy
    // 形态,响亮拒当引导源;快照本来就要 VACUUM 整库,电池成本可接受。
    strict_battery(conn).map_err(|e| {
        format!("本空间尚未通过纪元认证,不能作为引导源(严格审计:{e})——先在锚点执行压实/认证")
    })?;
    let path = dir.join(format!("boot-snapshot-{}.sqlite3", Ulid::new()));
    let path_str = path
        .to_str()
        .ok_or_else(|| "快照目录路径不是合法 UTF-8".to_string())?;
    if let Err(e) = conn.execute("VACUUM INTO ?1", [path_str]) {
        // VACUUM 失败可能已产部分目标文件(#4,codex 二审):别留在盘上。
        let _ = std::fs::remove_file(&path);
        return Err(format!("VACUUM INTO 快照失败:{e}"));
    }
    let (bytes, sha256) = match hash_file(&path) {
        Ok(v) => v,
        Err(e) => {
            // #4(codex 二审):VACUUM 已产文件、hash 却失败——别把明文整库副本留在盘上。
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    if bytes == 0 {
        let _ = std::fs::remove_file(&path);
        return Err("快照文件为空(SQLite 库至少一页,必是环境故障)".into());
    }
    Ok(Snapshot { path, bytes, sha256 })
}

fn hash_file(path: &Path) -> Result<(i64, [u8; 32]), String> {
    let mut f = File::open(path).map_err(|e| format!("打开快照失败:{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; BOOT_CHUNK_BYTES];
    let mut total: i64 = 0;
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读快照失败:{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as i64;
    }
    Ok((total, hasher.finalize().into()))
}

/// 快照出流:首帧 Offer,之后按序 Chunk,发完返回 None。逐块读文件(内存 O(块)),
/// 每次 [`BootSender::next_msg`] 产一帧——调用方(P2-g)按 direct 节奏外发。
pub struct BootSender {
    file: File,
    transfer: String,
    bytes: i64,
    sha256: [u8; 32],
    sent: i64,
    next_idx: u32,
    offered: bool,
}

impl BootSender {
    pub fn new(snapshot: &Snapshot) -> Result<BootSender, String> {
        let file = File::open(&snapshot.path).map_err(|e| format!("打开快照失败:{e}"))?;
        Ok(BootSender {
            file,
            transfer: Ulid::new().to_string(),
            bytes: snapshot.bytes,
            sha256: snapshot.sha256,
            sent: 0,
            next_idx: 0,
            offered: false,
        })
    }

    pub fn next_msg(&mut self) -> Result<Option<BootMsg>, String> {
        if !self.offered {
            self.offered = true;
            return Ok(Some(BootMsg::Offer {
                transfer: self.transfer.clone(),
                bytes: self.bytes,
                sha256: self.sha256.to_vec(),
            }));
        }
        if self.sent >= self.bytes {
            return Ok(None);
        }
        let want = usize::min(BOOT_CHUNK_BYTES, (self.bytes - self.sent) as usize);
        let mut data = vec![0u8; want];
        self.file
            .read_exact(&mut data)
            .map_err(|e| format!("读快照块失败(文件在发送中被动过?):{e}"))?;
        self.sent += want as i64;
        let msg = BootMsg::Chunk {
            transfer: self.transfer.clone(),
            idx: self.next_idx,
            last: self.sent >= self.bytes,
            data,
        };
        self.next_idx += 1;
        Ok(Some(msg))
    }
}

// ---- 新端:fresh 校验 ----------------------------------------------------------

/// fresh-to-account 校验(§6.2 步骤 1,评审①-H1 的两条判据缺一不可)。
/// Err 文案即 UI 指引;调用方按 Err 分流(曾同步过 → 水位追赶;legacy → 只能当首台)。
pub fn check_fresh_to_account(conn: &Connection) -> Result<(), String> {
    if meta_get(conn, "bootstrapped_at")?.is_some() {
        return Err("本机已完成过引导:同步走水位追赶,不再引导".into());
    }
    let device_id = meta_get(conn, "device_id")?
        .ok_or_else(|| "sync_meta 缺 device_id(库损坏?)".to_string())?;
    // 判据 (a):本地日志无任何他人 origin 的 op。
    let foreign: i64 = conn
        .query_row("SELECT COUNT(*) FROM oplog WHERE origin <> ?1", [&device_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if foreign > 0 {
        return Err("本机已有同步历史(含他人设备的 op):走水位追赶,不再引导".into());
    }
    // 判据 (b):本地现存全部实体都有本机 op 背书。(a) 已保证日志全是本机 op,
    // 这里不再重复 origin 谓词。少了 (b),无背书行永不进水位视野——全网只此一份、
    // 还自以为同步了,是水位协议照不见的静默不收敛(评审①-H1)。
    let legacy_msg = "这台设备有早于同步纪元的历史数据,只能作为账户首台,或清空后加入";
    let (orphan_items, orphan_topics, orphan_links, orphan_images) = count_unbacked_rows(conn)?;
    if orphan_items + orphan_topics + orphan_links + orphan_images > 0 {
        return Err(legacy_msg.into());
    }
    // 判据 (c)(fresh 第四闸,epoch-plan §3.5):本地 oplog 全部 op 过严格 shape。
    // 行全有背书但 op 是 legacy 形态(int position 等)照样是旧纪元历史——引导合并
    // 后本机全量要过 audit_op_shapes,放进来必在导入审计炸,不如入口就人话拒。
    scan_op_shapes(conn).map_err(|e| format!("{legacy_msg}(旧形态操作记录:{e})"))?;
    Ok(())
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

// ---- 新端:收流 ----------------------------------------------------------------

/// 一块的处置。
#[derive(Debug, PartialEq, Eq)]
pub enum ChunkOutcome {
    /// 收下,继续等下一块。
    More,
    /// 错源/错 transfer 的迷路块:静默丢(§5.4 blob 同款),流不受影响。
    Ignored,
    /// 全部到齐且长度 + sha256 双验通过,临时文件可交 [`import_snapshot`]。
    Complete,
}

/// 快照收流器:攒块落临时文件。错序/超声明 = Err(整个传输作废,调用方丢弃本
/// receiver、重新 `Req`);未完成即弃置时临时文件由 Drop 兜底清理。
#[derive(Debug)]
pub struct BootReceiver {
    from: String,
    transfer: String,
    expected: i64,
    sha256: [u8; 32],
    file: Option<File>,
    path: PathBuf,
    hasher: Sha256,
    written: i64,
    next_idx: u32,
    done: bool,
}

impl BootReceiver {
    /// 由 Offer 开启(from = 信封上的发送设备;之后只认同源同 transfer 的块)。
    pub fn start(
        dir: &Path,
        from: &str,
        transfer: &str,
        bytes: i64,
        sha256: &[u8],
    ) -> Result<BootReceiver, String> {
        // transfer 来自线上、要拼进本地路径:钉死 ULID 形态(26 字符 Crockford),
        // 含 `/`、`..` 之类的穿越字节根本进不来(codex P2-f 轮 H2)。
        if Ulid::from_string(transfer).is_err() {
            return Err(format!("快照 transfer 不是合法 ULID,拒收:{transfer}"));
        }
        if bytes <= 0 || bytes > MAX_SNAPSHOT_BYTES {
            return Err(format!("快照声明大小不合理({bytes} 字节),拒收"));
        }
        let sha: [u8; 32] = sha256
            .try_into()
            .map_err(|_| "快照 sha256 长度不是 32B,拒收".to_string())?;
        let path = dir.join(format!("boot-recv-{transfer}.sqlite3"));
        // create_new:同名文件已在(重复 transfer / 上次残留)= 响亮拒,绝不截断覆盖。
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("建快照落地文件失败(重复 transfer?):{e}"))?;
        Ok(BootReceiver {
            from: from.into(),
            transfer: transfer.into(),
            expected: bytes,
            sha256: sha,
            file: Some(file),
            path,
            hasher: Sha256::new(),
            written: 0,
            next_idx: 0,
            done: false,
        })
    }

    /// 收一块。Err = 本次传输作废(文件已删),调用方重新请求。
    pub fn on_chunk(
        &mut self,
        from: &str,
        transfer: &str,
        idx: u32,
        last: bool,
        data: &[u8],
    ) -> Result<ChunkOutcome, String> {
        if self.done {
            return Ok(ChunkOutcome::Ignored);
        }
        if from != self.from || transfer != self.transfer {
            return Ok(ChunkOutcome::Ignored); // 迷路的残帧(§5.4 同款),不作废本流。
        }
        if idx != self.next_idx {
            self.abort();
            return Err(format!("快照块错序(期待 {},到达 {idx}),传输作废", self.next_idx));
        }
        if self.written + data.len() as i64 > self.expected {
            self.abort();
            return Err("快照块超出声明大小,传输作废".into());
        }
        let file = self.file.as_mut().expect("未完成的 receiver 恒持有文件");
        file.write_all(data).map_err(|e| {
            let _ = std::fs::remove_file(&self.path);
            format!("写快照块失败:{e}")
        })?;
        self.hasher.update(data);
        self.written += data.len() as i64;
        self.next_idx += 1;
        if !last {
            return Ok(ChunkOutcome::More);
        }
        // 终块:长度与 sha256 双验(§6.2 步骤 3 的「收全验 hash」)。
        if self.written != self.expected {
            self.abort();
            return Err(format!(
                "快照长度不符(声明 {},实收 {}),传输作废",
                self.expected, self.written
            ));
        }
        let got: [u8; 32] = std::mem::take(&mut self.hasher).finalize().into();
        if got != self.sha256 {
            self.abort();
            return Err("快照 sha256 校验不过,传输作废".into());
        }
        self.file = None; // 落定,关句柄(Windows 下不关无法被 SQLite 打开)。
        self.done = true;
        Ok(ChunkOutcome::Complete)
    }

    /// 收全后的快照文件路径(交 [`import_snapshot`];导入后由调用方删除)。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 收流进度 (已写字节, 声明总字节)——传输层转 UI 进度(android-plan §3)。
    pub fn progress(&self) -> (i64, i64) {
        (self.written, self.expected)
    }

    fn abort(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(&self.path);
        self.done = true; // 作废后一切后续块 Ignored。
    }
}

impl Drop for BootReceiver {
    fn drop(&mut self) {
        if self.file.is_some() {
            self.file = None;
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

// ---- 新端:导入合并 -------------------------------------------------------------

/// 导入报告(计数供 UI/日志;max_hlc 已 observe)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub items: usize,
    pub topics: usize,
    pub links: usize,
    pub images: usize,
    pub revisions: usize,
    pub ops: usize,
}

/// 导入的完成边界(space-entry-plan §3.2,codex 二轮 H1):**只有 commit 之前的
/// 失败走 `Err`**(整体回滚无痕);commit 之后只剩两种事实——
/// - `Committed`:库已可信提交;`post_commit_error` 只承载**不影响库可信度**的
///   收尾噪音(当前恒 None,字段是合同占位);
/// - `CommittedNeedsReopen`:DETACH 最终失败 = 这条连接仍挂着 boot 库——库本体
///   已可信提交,但**禁止在原 Connection 上 `start_engine`/继续会话**,调用方必须
///   以新连接重开(staging 路:close→publish→新连接;正式 runtime 路:stop→重新
///   activate,做不到就封写等重启)。
#[derive(Debug)]
pub enum ImportOutcome {
    Committed { report: ImportReport, post_commit_error: Option<String> },
    CommittedNeedsReopen { report: ImportReport, error: String },
}

#[cfg(test)]
impl ImportOutcome {
    /// 测试便捷:期望干净 Committed(无收尾噪音、无需重开),否则响亮。
    pub(crate) fn expect_clean_commit(self) -> ImportReport {
        match self {
            ImportOutcome::Committed { report, post_commit_error: None } => report,
            other => panic!("期望干净 Committed,得到 {other:?}"),
        }
    }
}

/// 表级导入合并(§6.2 步骤 3~4)。ATTACH 只读 → 回放豁免单事务(导入 + 校验 +
/// **integrity_check(事务内、commit 前)** + `bootstrapped_at` 标记 + observe
/// 同生共死)→ DETACH。快照文件用后由调用方删除。完成边界见 [`ImportOutcome`]。
pub fn import_snapshot(
    conn: &mut Connection,
    clock: &mut Clock,
    snapshot: &Path,
) -> Result<ImportOutcome, String> {
    // 误用防线:引导资格在此重验(调用方应已查过;这里失败 = 编排 bug,响亮)。
    check_fresh_to_account(conn)?;
    let uri = snapshot_uri(snapshot)?;
    conn.execute("ATTACH DATABASE ?1 AS boot", [&uri])
        .map_err(|e| format!("挂载快照失败:{e}"))?;
    let result = import_attached(conn, clock);
    // 成败都要卸载(事务已在 import_attached 内终结,DETACH 不受其影响)。
    let detach = conn.execute("DETACH DATABASE boot", []);
    let report = result?;
    // commit 已发生:此后**绝无 Err**(space-entry-plan §3.2)。DETACH 失败 = 连接
    // 仍挂着 boot 库,库可信但连接不可续用——结构化上报,绝不让「已提交的引导」
    // 被当成失败重试(那会撞 fresh 判据、把成功洗成死循环)。
    match detach {
        Ok(_) => Ok(ImportOutcome::Committed { report, post_commit_error: None }),
        Err(e) => Ok(ImportOutcome::CommittedNeedsReopen {
            report,
            error: format!("卸载快照失败(连接仍挂着引导库,须以新连接重开):{e}"),
        }),
    }
}

fn import_attached(conn: &mut Connection, clock: &mut Clock) -> Result<ImportReport, String> {
    // sanity:快照必须出自**别的设备**的**同版本**库。版本偏斜的快照列面不齐,
    // 表级 SELECT 会以难懂的 SQL 错炸掉——先给一句人话(§5.3 版本偏斜自愈的
    // 引导版:两端升到同版本再来)。
    let mine: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let theirs: i64 = conn
        .pragma_query_value(Some(DatabaseName::Attached("boot")), "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if mine != theirs {
        return Err(format!(
            "快照版本不同(对端库 v{theirs},本机 v{mine}):请两端升级到同一版本后重新引导"
        ));
    }
    let my_device = meta_get(conn, "device_id")?
        .ok_or_else(|| "sync_meta 缺 device_id(库损坏?)".to_string())?;
    let src_device: Option<String> = conn
        .query_row("SELECT value FROM boot.sync_meta WHERE key = 'device_id'", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match src_device {
        None => return Err("快照缺 device_id(不是朱笺同步库?)".into()),
        Some(d) if d == my_device => {
            return Err("快照来自本机自己(引导编排出错),拒导入".into())
        }
        Some(_) => {}
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // fresh 判据在事务内**重验**(codex P2-f 轮 M1):入口那次是提前响亮,这次才是
    // 原子事实——check 与导入之间落进来的他人 op/引导标记在此拆穿。P2-g 接线契约:
    // 从 fresh 校验到 commit 必须持同一把 write_locks(引导与本地命令/engine 应用
    // 互斥),本重验是契约被破坏时的最后防线,不是并发方案。
    check_fresh_to_account(&tx)?;
    // space profile 单例**双侧独立预审**(space-name-sync-plan §4.4 步骤 1,codex
    // 二轮 M1):本地 profile ⟺ 本地 space ops、快照 profile ⟺ 快照 space ops,任一
    // 侧矛盾响亮拒——绝不让下方的合并物化顺手「修复」既有损坏再让 battery 误过。
    audit_space_profile_semantics(&tx, "", "本机")?;
    audit_space_profile_semantics(&tx, "boot.", "快照")?;
    tx.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", [])
        .map_err(|e| e.to_string())?;

    // 表级导入(父先子,FK 每连接强制)。全列显式点名:快照与本机同版本,列面
    // 由 user_version 相等背书;新端 fresh(id 全不相交),撞 PRIMARY KEY/UNIQUE
    // = 前提被破坏,响亮失败整体回滚。
    let topics = tx
        .execute(
            "INSERT INTO topics (id, title, created_at, updated_at, color, position, kind) \
             SELECT id, title, created_at, updated_at, color, position, kind FROM boot.topics",
            [],
        )
        .map_err(|e| format!("导入 topics 失败:{e}"))?;
    let items = tx
        .execute(
            "INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, \
                                due_on, priority, position, sealed_at, born_stage, done_at) \
             SELECT id, content, stage, created_at, updated_at, archived_at, \
                    due_on, priority, position, sealed_at, born_stage, done_at FROM boot.items",
            [],
        )
        .map_err(|e| format!("导入 items 失败:{e}"))?;
    let links = tx
        .execute(
            "INSERT INTO item_topic (item_id, topic_id) \
             SELECT item_id, topic_id FROM boot.item_topic",
            [],
        )
        .map_err(|e| format!("导入 item_topic 失败:{e}"))?;
    let images = tx
        .execute(
            "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) \
             SELECT id, item_id, seq, data, mime, created_at FROM boot.item_image",
            [],
        )
        .map_err(|e| format!("导入 item_image 失败:{e}"))?;
    // counter 按 MAX 合并(§6.2;fresh 下 item_id 本不相交,MAX 是幂等防御形)。
    tx.execute(
        "INSERT INTO item_image_counter (item_id, last_seq) \
         SELECT item_id, last_seq FROM boot.item_image_counter WHERE true \
         ON CONFLICT(item_id) DO UPDATE SET last_seq = max(last_seq, excluded.last_seq)",
        [],
    )
    .map_err(|e| format!("导入 item_image_counter 失败:{e}"))?;
    // 编辑历史是用户资产,带上(§6.2:引导是克隆不是同步);不带自增 id 重编入,
    // 按源 revision_id 保序(同 item 的历史序即行序)。
    let revisions = tx
        .execute(
            "INSERT INTO item_revisions (item_id, content, archived_at) \
             SELECT item_id, content, archived_at FROM boot.item_revisions \
             ORDER BY revision_id",
            [],
        )
        .map_err(|e| format!("导入 item_revisions 失败:{e}"))?;
    // oplog 原样(op_id/hlc/origin_seq 都是史实;origin 是生成列,列表点名避开)。
    let ops = tx
        .execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM boot.oplog",
            [],
        )
        .map_err(|e| format!("导入 oplog 失败:{e}"))?;
    // space profile **单例合并**(space-name-sync-plan §4.4 步骤 3-4,codex 一轮 H1):
    // 刻意**不做**表复制——固定主键 'profile' 在「本地已命名(如非 main 空间创建必
    // 填名)+ 源也有名」时必撞 PRIMARY KEY(业务表不撞靠随机 ULID,该假设对单例
    // 失效)。从**合并后**日志取 HLC 最大赢家(本地与源的 space op 都已在场、双侧
    // 已各自预审),以赢家 UPSERT 物化;全网无 space op 则两侧本就无行,无事发生。
    {
        let winner: Option<Option<String>> = tx
            .query_row(
                "SELECT json_extract(payload, '$.value') FROM oplog \
                 WHERE entity = 'space' AND entity_id = 'profile' AND kind = 'set_field' \
                 ORDER BY hlc DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(name) = winner {
            tx.execute(
                "INSERT INTO space_profile (key, name) VALUES ('profile', ?1) \
                 ON CONFLICT(key) DO UPDATE SET name = excluded.name",
                [&name],
            )
            .map_err(|e| format!("物化 space_profile 失败:{e}"))?;
        }
    }

    // ---- 导入后校验(§6.2 步骤 4;任一不过 = 整体回滚,连豁免标志一起消失) ----
    // 结构校验四件套(双序 / 墓碑复活 / counter 治理 / 连续性+FK)抽成共享审计函数,
    // 与 epoch::compact 自验收、epoch::certify、快照供货闸共用(epoch-plan §2.6 /
    // §3.3 / §3.4:「新设备引导它的快照时要过的全部严格审计」必须单一来源,各写
    // 各的必然漂移)。
    audit_dual_order(&tx)?;
    audit_tombstone_resurrection(&tx)?;
    audit_counter_governance(&tx)?;
    audit_contiguity_and_fk(&tx)?;

    // self-origin 注入(codex 二审):快照不得携带以本机 device_id 为 origin 的 op——否则
    // 恶意源替新端伪造「本机历史」。**读 substr(hlc,24) 而非生成列 origin**:篡改 schema 的
    // 快照可把 origin 伪装成假列,而 hlc 后缀才是 live 导入后重算出的真 origin(codex 二审:
    // 不信 attached DB 声称的 generated column)。
    let self_origin: i64 = tx
        .query_row("SELECT COUNT(*) FROM boot.oplog WHERE substr(hlc, 24) = ?1", [&my_device], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if self_origin > 0 {
        return Err(format!(
            "导入后发现 {self_origin} 条以本机 device_id 为 origin 的 op(快照伪造本机历史),整体回滚"
        ));
    }
    // op-shape 审计(bedrock-fix §9):对快照 oplog 每条跑 replay 的共享 shape 校验,
    // 与 live apply 单一真相源——闭合「审计比 replay 松」的 A 类分叉根因。
    audit_op_shapes(&tx)?;
    // op-backed 语义审计(codex P2-h 二轮 H2):结构合法的快照仍可能「终态与自身日志
    // 矛盾」(content 说 A 表里 B 等),恶意/坏实现 peer 借此静默分叉、续传坏终态。
    // 对有 op 背书的实体按日志重算 LWW/OR-set/图N 与终态比对,不符 = 拒收整体回滚。
    audit_op_backed_semantics(&tx)?;

    // 全库体检挪进导入事务、bootstrapped_at 与 commit **之前**(space-entry-plan
    // §3.2,codex 二轮 H1;共用路径,main onboarding 一起变严):不过即整体回滚——
    // 绝不发布/激活/start_engine 一个完整性已失败的库。显式点名 main(unqualified
    // integrity_check 会连 attached 的 boot 一起查,语义要钉死在「本库」上)。
    let verdict: String = tx
        .pragma_query_value(Some(DatabaseName::Main), "integrity_check", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if verdict != "ok" {
        return Err(format!("导入后 integrity_check 不过(事务内,整体回滚):{verdict}"));
    }

    // 引导完成标记(fresh 判据 (a) 的「既往引导记录」;与导入同事务,半途即无痕)。
    tx.execute(
        "INSERT INTO sync_meta (key, value) VALUES ('bootstrapped_at', ?1)",
        [crate::repo::now_iso()],
    )
    .map_err(|e| e.to_string())?;
    // 纪元标记(epoch-plan §3.3 收端):严格审计全过 + 同一导入事务内落 `epoch=2`
    // ——引导出来的设备立即具备当快照源资格(multispace §19「任一在线完整副本可
    // 恢复」不被破坏)。标记仅是诊断,供货闸(make_snapshot)现场重跑电池。
    tx.execute(
        "INSERT INTO sync_meta (key, value) VALUES ('epoch', '2') \
         ON CONFLICT(key) DO UPDATE SET value = '2'",
        [],
    )
    .map_err(|e| e.to_string())?;

    // observe(导入日志的 max HLC):此后本机新 op 的 HLC 恒高于既有,编辑因果成立
    // (§6.2 步骤 4)。事务内落盘,与导入原子——半途崩溃不会留下「行进了、钟没推」。
    let max_hlc: Option<String> = tx
        .query_row("SELECT MAX(hlc) FROM oplog", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if let Some(ref h) = max_hlc {
        let hlc = Hlc::parse(h)?;
        clock.observe(&tx, &hlc)?;
    }

    tx.execute("DELETE FROM sync_replay_active", []).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ImportReport { items, topics, links, images, revisions, ops })
}

// ---- 严格电池:结构 + 语义审计的单一来源(epoch-plan §2.6/§3.3/§3.4) ------------
//
// 「压实后的库必须能通过新设备引导它的快照时要过的全部严格审计」——同一套电池四个
// 消费者:① 引导导入(import_attached,§6.2 步骤 4)② epoch::compact 自验收(§2.6)
// ③ epoch::certify(干净空间认证,§3.4)④ make_snapshot 供货闸(§3.3,工序5)。

/// 严格电池(§2.6 的 1-5 项 + op-backed 语义):对**本库主表**跑全部结构与语义审计。
/// 不含引导专属检查(fresh 判据 / self-origin 注入 / user_version 比对——那些是
/// 「导入关系」的性质,不是「库自身」的性质)。
pub(crate) fn strict_battery(conn: &Connection) -> Result<(), String> {
    audit_op_shapes(conn)?;            // 1. 全部 op 过严格 shape(无任何 legacy 形态)
    audit_dual_order(conn)?;           // 3. op_id ULID / hlc 可解析 / per-origin 双序
    audit_contiguity_and_fk(conn)?;    // 3. per-origin seq 连续 1..m;FK 干净
    audit_tombstone_resurrection(conn)?; // 5. tombstone 复活三查空转
    audit_counter_governance(conn)?;   // 5. counter 治理(缺行/落后行上最大编号)
    audit_op_backed_semantics(conn)?;  // 2+4+5. 恰一 create / LWW / OR-set / 图N / 图字节验货 / counter 水位
    Ok(())
}

/// op 形态与双序(codex P2-f 轮 H1):op_id 合法 ULID、hlc 可解析(设备后缀 ==
/// origin 由生成列恒真,不必另验)、per-origin 内 seq 序 == HLC 序(§5.1 不变量)。
/// 少了它,坏历史抬高水位后代补给第三端,会被对方帧内校验永久拒帧:带病传播。
fn audit_dual_order(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT op_id, hlc, origin FROM oplog ORDER BY origin, origin_seq")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut prev: Option<(String, String)> = None; // (origin, hlc)
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let op_id: String = row.get(0).map_err(|e| e.to_string())?;
        let hlc: String = row.get(1).map_err(|e| e.to_string())?;
        let origin: String = row.get(2).map_err(|e| e.to_string())?;
        if Ulid::from_string(&op_id).is_err() {
            return Err(format!("日志有非法 op_id「{op_id}」,快照损坏?整体回滚"));
        }
        Hlc::parse(&hlc).map_err(|e| format!("日志有非法 hlc「{hlc}」({e}),整体回滚"))?;
        if let Some((p_origin, p_hlc)) = &prev {
            if *p_origin == origin && hlc.as_str() <= p_hlc.as_str() {
                return Err(format!(
                    "origin {origin} 双序矛盾(seq 升而 hlc {p_hlc} → {hlc} 不升),整体回滚"
                ));
            }
        }
        prev = Some((origin, hlc));
    }
    Ok(())
}

/// tombstone 复活校验(codex P2-f 轮 M2 的窄形):tombstone 是不可逆存在性事实
/// (65 契约①),日志里有墓碑、表上还有行 = 终态与日志矛盾,拒。
fn audit_tombstone_resurrection(conn: &Connection) -> Result<(), String> {
    for (what, sql) in [
        (
            "item",
            "SELECT COUNT(*) FROM items WHERE id IN              (SELECT entity_id FROM oplog WHERE entity = 'item' AND kind = 'tombstone')",
        ),
        (
            "topic",
            "SELECT COUNT(*) FROM topics WHERE id IN              (SELECT entity_id FROM oplog WHERE entity = 'topic' AND kind = 'tombstone')",
        ),
        (
            "image",
            "SELECT COUNT(*) FROM item_image WHERE id IN              (SELECT entity_id FROM oplog WHERE entity = 'image' AND kind = 'image_tombstone')",
        ),
    ] {
        let undead: i64 = conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if undead > 0 {
            return Err(format!(
                "{undead} 个已 tombstone 的 {what} 仍有行(墓碑不可逆),快照损坏?整体回滚"
            ));
        }
    }
    Ok(())
}

/// 0023 同款 counter 治理**校验**(不静默修复:健康库的不变量「counter ≥ 一切已用
/// 编号」必须已成立;不过 = 损坏,拒)。
fn audit_counter_governance(conn: &Connection) -> Result<(), String> {
    let counter_missing: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM item_image WHERE item_id NOT IN              (SELECT item_id FROM item_image_counter)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let counter_behind: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM item_image_counter c WHERE last_seq <              (SELECT MAX(seq) FROM item_image i WHERE i.item_id = c.item_id)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if counter_missing + counter_behind > 0 {
        return Err(format!(
            "「图N」计数器校验不过(缺行 {counter_missing} / 落后 {counter_behind}),快照损坏?整体回滚"
        ));
    }
    Ok(())
}

/// per-origin seq 连续性(§5.1 不变量)+ FK 终审(items/topics ← link/image/revision
/// 的悬挂引用在此响亮)。
fn audit_contiguity_and_fk(conn: &Connection) -> Result<(), String> {
    let holed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM (SELECT origin FROM oplog GROUP BY origin              HAVING COUNT(*) <> MAX(origin_seq) OR MIN(origin_seq) <> 1)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if holed > 0 {
        return Err(format!("{holed} 个 origin 的 seq 有洞,快照损坏?整体回滚"));
    }
    let fk_broken: i64 = {
        let mut stmt = conn.prepare("PRAGMA foreign_key_check").map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut n = 0i64;
        while rows.next().map_err(|e| e.to_string())?.is_some() {
            n += 1;
        }
        n
    };
    if fk_broken > 0 {
        return Err(format!("foreign_key_check 有 {fk_broken} 条违例,整体回滚"));
    }
    Ok(())
}

// ---- P2-h H2:op-backed 语义审计 --------------------------------------------------
//
// 结构校验(op_id/hlc/双序/tombstone 复活/counter/per-origin/FK/integrity)挡不住
// 「日志说 content=X、表里却是 Y」的语义分叉——恶意或坏实现的已配对 peer 可灌这种
// 「约束合法但与自身日志矛盾」的快照,新端导入后收不到修正 op、还能续传坏终态给第三端。
//
// 审计做法:对**有 op 背书的**实体(item 有 create op / topic 有 create op / link 有
// link_add / image 有 image_add),按日志重算 LWW/OR-set/图N 有效编号,与快照终态逐一
// 比对。严格纪元(epoch-plan §3.2)起「无背书行」不再是合法史实——audit_create_multiplicity
// 的「恰一条」下半先行拒掉,后续各项到场时每行必有背书。
//
// **不走「回放整段 oplog 进 scratch 库再比」**:0021 前的整数 position set_field op 是
// 历史、不改写(0021 抬头),现行 `apply_item_set_field` 拒整数 position——回放会在合法
// 快照(源库有 0020~0021 过渡期 op,如账户纪元源)上误报。改用**直接 LWW 比对**:winner
// = 该字段 create 初值 + 全部 set_field 里 HLC 最大的那条的值,与表列 `IS` 比。审计字段
// 全部格式跨迁移稳定;**position 自严格纪元起一并审**(实现审 H2:int 形态的 position op
// 已被严格 shape 审计在先拒掉,「格式漂移」的豁免理由不再成立——留豁免 = 「create 说 A、
// 表里是 B」的库过电池,导入端保 B、live 回放得 A,静默终态分叉,还顺带穿透供货/创号/
// 导入三道闸)。

/// item 的 LWW 审计字段(updated_at 是本机簿记摸 now,不同步不审)。
/// 每个字段:create payload 里键名同字段名(archived_at/sealed_at/done_at 出生态不在 payload →
/// json_extract 得 NULL,winner 落到 set_field 或保持 NULL),set_field 值在 `$.value`。
const ITEM_LWW_FIELDS: &[&str] = &[
    "content", "stage", "created_at", "due_on", "priority", "archived_at", "sealed_at",
    "born_stage", "position", "done_at",
];

/// 某 op 背书实体的某字段:表列是否 == 日志 LWW winner(winner = create 初值 + 该字段
/// 全部 set_field 中 HLC 最大者的值)。返回不符的实体数。`create_key` = create payload
/// 里该字段初值的键——多数字段同字段名;`topic.updated_at` 出生态 = created_at(create
/// 不带 updated_at 键,`apply_topic_create` 落 updated_at = created_at),故传 created_at。
fn count_field_mismatches(
    conn: &Connection,
    table: &str,
    field: &str,
    create_key: Option<&str>,
) -> Result<i64, String> {
    // create 初值:Some(k) 取自 $.<k>;None = 恒 NULL(create-forced-NULL 字段:item 的
    // archived_at/sealed_at/done_at、topic 的 color——apply_*_create 忽略 payload 直写 NULL,审计
    // 必须同口径,否则恶意 create 注入同名键 + 表里设同值即过审,replay 却得 NULL 静默
    // 分叉,codex 二审)。set_field 值恒在 $.value,按 $.field == field 筛。
    let create_value_expr = match create_key {
        Some(k) => format!("json_extract(payload, '$.{k}')"),
        None => "NULL".to_string(),
    };
    let sql = format!(
        "SELECT COUNT(*) FROM {table} t \
         WHERE EXISTS (SELECT 1 FROM oplog WHERE entity = ?1 AND entity_id = t.id AND kind = 'create') \
           AND NOT (t.{field} IS ( \
                SELECT value FROM ( \
                    SELECT hlc, {create_value_expr} AS value FROM oplog \
                      WHERE entity = ?1 AND entity_id = t.id AND kind = 'create' \
                    UNION ALL \
                    SELECT hlc, json_extract(payload, '$.value') AS value FROM oplog \
                      WHERE entity = ?1 AND entity_id = t.id AND kind = 'set_field' \
                        AND json_extract(payload, '$.field') = '{field}') \
                ORDER BY hlc DESC LIMIT 1))"
    );
    let entity = if table == "items" { "item" } else { "topic" };
    conn.query_row(&sql, [entity], |r| r.get(0)).map_err(|e| e.to_string())
}

/// op-backed 语义审计(见 import 调用点上方注释)。任一不符 = 拒收整个引导。
fn audit_op_backed_semantics(live: &Connection) -> Result<(), String> {
    // ⓪ 结构前提:每实体恰一 create / 每图恰一 add(#3;后续 LWW/OR-set 都以此为前提)。
    audit_create_multiplicity(live)?;
    // ⓪′ op 依赖前置:存在 + 因果序(codex 二审 C/D + set-before-create;值域已入 validate_op_shape)。
    audit_op_preconditions(live)?;
    // ① item / topic 字段级 LWW:表列必须 == 日志 winner。
    for &field in ITEM_LWW_FIELDS {
        // archived_at/sealed_at/done_at:apply_item_create 强制 NULL、忽略 payload——create 初值恒
        // NULL(否则恶意 create 注入同名键即过审,codex 二审);其余字段读 payload 初值。
        let create_key = if matches!(field, "archived_at" | "sealed_at" | "done_at") { None } else { Some(field) };
        if count_field_mismatches(live, "items", field, create_key)? > 0 {
            return Err(format!(
                "导入后语义审计:有 item 的 {field} 终态与自身日志的 LWW 结果不符(快照与日志矛盾),整体回滚"
            ));
        }
    }
    // topic 的 title / updated_at / color / position / kind 都是同步字段(apply_topic_set_field
    // 白名单);updated_at 出生初值 = created_at;color/position/kind 无 create 键 → 出生初值
    // NULL(与列默认 NULL 一致,与 item 的 due_on/archived_at 同款)。item.updated_at 是本机
    // 簿记(回放摸 now、非确定性 payload),不审。
    for (field, create_key) in [
        ("title", Some("title")),
        ("updated_at", Some("created_at")),
        ("color", None),
        ("position", None),
        ("kind", None),
    ] {
        if count_field_mismatches(live, "topics", field, create_key)? > 0 {
            return Err(format!(
                "导入后语义审计:有 topic 的 {field} 终态与自身日志的 LWW 结果不符(快照与日志矛盾),整体回滚"
            ));
        }
    }
    // ② op-backed 实体的存在性:有 create、无 tombstone,却无行 = 快照丢了自己日志建的实体。
    for (entity, table) in [("item", "items"), ("topic", "topics")] {
        let missing: i64 = live
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM (SELECT DISTINCT entity_id FROM oplog o \
                       WHERE o.entity = ?1 AND o.kind = 'create' \
                         AND NOT EXISTS (SELECT 1 FROM oplog t WHERE t.entity = ?1 \
                                          AND t.entity_id = o.entity_id AND t.kind = 'tombstone')) c \
                     WHERE NOT EXISTS (SELECT 1 FROM {table} r WHERE r.id = c.entity_id)"
                ),
                [entity],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if missing > 0 {
            return Err(format!(
                "导入后语义审计:{missing} 个有 create op 且未 tombstone 的 {entity} 无行(快照与日志矛盾),整体回滚"
            ));
        }
    }
    // ③ 标签关联 OR-set:op-backed link(有 link_add)的存活集必须 == 表里的 op-backed 行。
    audit_link_or_set(live)?;
    // ④ 「图N」有效编号:有 image_add op 的每张已落行图,行 seq 必须 == reconcile 值。
    audit_image_seqs(live)?;
    // ⑤ image 行关联 + tombstone 一致 + 字节 hash(codex 二审)。
    audit_image_integrity(live)?;
    // ⑥ space profile 单例寄存器双向不变量(space-name-sync-plan §4.4,0028)。
    audit_space_profile_semantics(live, "", "本库")?;
    Ok(())
}

/// space profile 单例寄存器的双向语义审计(space-name-sync-plan §4.4,codex 一轮 H2):
/// 零 op ⇔ 零行;有 op ⇒ 恰一行且 `name` IS 全日志 HLC 最大 op 的 value(**含 null**
/// ——显式清名的规范表示);行在无 op / op 在行缺 都拒。`prefix` 复用于快照侧
/// (`"boot."`,attached 库的 CHECK/PK 可被篡改,不信 schema、实查词汇与坐标)与
/// 本库侧(`""`);`who` 只进话术。
fn audit_space_profile_semantics(conn: &Connection, prefix: &str, who: &str) -> Result<(), String> {
    let one = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    // 词汇与坐标合规(NULL 语义:json_extract 缺键、篡改 schema 的 attached 库列
    // 为 NULL 时 `<>` 三值逻辑不计入——全部 COALESCE 后照拒,codex 实现审 L)。
    let bad_ops = one(&format!(
        "SELECT COUNT(*) FROM {prefix}oplog WHERE entity = 'space' AND ( \
             COALESCE(kind, '') <> 'set_field' OR COALESCE(entity_id, '') <> 'profile' \
             OR COALESCE(json_extract(payload, '$.field'), '') <> 'name')"
    ))?;
    if bad_ops > 0 {
        return Err(format!(
            "space 语义审计({who}):{bad_ops} 条 space op 词汇/坐标非法(单例寄存器只认 set_field/profile/name),整体回滚"
        ));
    }
    let rows = one(&format!("SELECT COUNT(*) FROM {prefix}space_profile"))?;
    let good_rows =
        one(&format!("SELECT COUNT(*) FROM {prefix}space_profile WHERE key = 'profile'"))?;
    if rows > 1 || rows != good_rows {
        return Err(format!(
            "space 语义审计({who}):space_profile 有 {rows} 行(其中规范键 {good_rows})——恰零或一行且 key='profile',整体回滚"
        ));
    }
    let ops = one(&format!("SELECT COUNT(*) FROM {prefix}oplog WHERE entity = 'space'"))?;
    if ops == 0 && rows > 0 {
        return Err(format!(
            "space 语义审计({who}):space_profile 有行但无任何 space op 背书(行在无 op),整体回滚"
        ));
    }
    if ops > 0 {
        if rows != 1 {
            return Err(format!(
                "space 语义审计({who}):有 {ops} 条 space op 但 space_profile 无行(op 在行缺),整体回滚"
            ));
        }
        let mismatch = one(&format!(
            "SELECT COUNT(*) FROM {prefix}space_profile s WHERE NOT (s.name IS ( \
                 SELECT json_extract(payload, '$.value') FROM {prefix}oplog \
                 WHERE entity = 'space' AND entity_id = 'profile' AND kind = 'set_field' \
                 ORDER BY hlc DESC LIMIT 1))"
        ))?;
        if mismatch > 0 {
            return Err(format!(
                "space 语义审计({who}):space_profile.name 与日志 LWW 赢家不符(状态与日志矛盾),整体回滚"
            ));
        }
    }
    Ok(())
}

/// 每实体**恰一条** create / 每图恰一条 image_add(epoch-plan §3.2 严格化:pre-0020
/// 零背书容忍已删——纪元压实给每行合成了 create 背书,「快照携带无背书行」不再是
/// 合法史实)。上半查重复(COUNT>1),下半查零背书(现存行无对应 create/link_add/
/// image_add);apply_*_create 撞行即 Err、apply_image_add 的 add_count!=1 即 Err,
/// 快照 bulk merge 不过 apply_*,审计补两向(#3 + §3.2)。
fn audit_create_multiplicity(live: &Connection) -> Result<(), String> {
    let dup: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM (SELECT entity, entity_id FROM oplog \
             WHERE kind IN ('create', 'image_add') \
             GROUP BY entity, entity_id HAVING COUNT(*) > 1)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if dup > 0 {
        return Err(format!(
            "导入后语义审计:{dup} 个实体有重复 create/image_add(每实体恰一条),整体回滚"
        ));
    }
    let (items, topics, links, images) = count_unbacked_rows(live)?;
    if items + topics + links + images > 0 {
        return Err(format!(
            "导入后语义审计:存在无 op 背书的行(item {items} / topic {topics} / link {links} / image {images})\
            ——严格纪元下每行必有恰一条 create/link_add/image_add 背书(pre-0020 遗产先在锚点压实),整体回滚"
        ));
    }
    Ok(())
}

/// 无 op 背书的现存行计数(items/topics/item_topic/item_image 四表)。
/// 两处消费者、同一判据:`check_fresh_to_account` 的判据 (b)(legacy 只能当首台)与
/// `audit_create_multiplicity` 的「恰一条」下半(§3.2)——判据必须单一来源,否则
/// fresh 闸与导入审计对「什么算无背书」各说各话。
pub(crate) fn count_unbacked_rows(conn: &Connection) -> Result<(i64, i64, i64, i64), String> {
    let one = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    Ok((
        one(
            "SELECT COUNT(*) FROM items WHERE id NOT IN \
             (SELECT entity_id FROM oplog WHERE entity = 'item' AND kind = 'create')",
        )?,
        one(
            "SELECT COUNT(*) FROM topics WHERE id NOT IN \
             (SELECT entity_id FROM oplog WHERE entity = 'topic' AND kind = 'create')",
        )?,
        one(
            "SELECT COUNT(*) FROM item_topic it WHERE NOT EXISTS \
             (SELECT 1 FROM oplog WHERE entity = 'link' AND kind = 'link_add' \
              AND entity_id = it.item_id || ':' || it.topic_id)",
        )?,
        one(
            "SELECT COUNT(*) FROM item_image WHERE id NOT IN \
             (SELECT entity_id FROM oplog WHERE entity = 'image' AND kind = 'image_add')",
        )?,
    ))
}

/// op 依赖前置审计(codex 二审 C/D + set-before-create):mirror live `apply_*` 的**依赖**
/// 前置。boot 只校终态,而 live 按 origin_seq **逐条**应用,会在孤儿 / 依赖倒序 op 上 Err→
/// origin 挂起。值域(stage/priority/due_on/position)已移入共享的 `replay::validate_op_shape`
/// (放共享层 boot/live 才同拒,不生反向分歧——见其注释)。这里查两类**依赖**:
/// - **存在**:set_field 的 entity、link 两端父、image_add 宿主,必须「有行,或有 create
///   背书(次序对错交下方因果序检查精确拒),或有**更早的** tombstone」。实现审 H1:
///   「存在任意 tombstone」的旧口径会放过「无 create、tombstone 晚于依赖 op」的日志——
///   live 逐条应用在低 seq 上撞「行缺失且无墓碑」挂起,高 seq 的 tombstone 被队尾堵死
///   永不到场;更早的 tombstone 对应 live 的 ParentGone/sticky 幂等 no-op 才合法。
///   create 背书分支不看次序:合法 purge 流(create<set<tombstone,行已删)靠它放行,
///   set-before-create 由下方因果序检查以准确话术拒;

/// - **因果序**:有 create 背书的实体,create 必须 HLC 早于其 set_field/link/image_add——否则
///   同 origin set-before-create:live 先应用低 seq 撞「行缺失」挂起、高 seq 的 create 被队尾
///   堵死永不越过。**tombstone 不豁免因果序**(codex 二审改正:set→create→tombstone 终态只剩
///   墓碑,但 live 仍在低 seq set 上卡死);无 create 的 pre-0020 legacy 靠「有行/tombstone」过。
fn audit_op_preconditions(live: &Connection) -> Result<(), String> {
    for (entity, table) in [("item", "items"), ("topic", "topics")] {
        let orphan: i64 = live
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM oplog o WHERE o.entity = ?1 AND o.kind = 'set_field' \
                     AND NOT EXISTS (SELECT 1 FROM {table} r WHERE r.id = o.entity_id) \
                     AND NOT EXISTS (SELECT 1 FROM oplog x WHERE x.entity = ?1 \
                                      AND x.entity_id = o.entity_id \
                                      AND (x.kind = 'create' \
                                           OR (x.kind = 'tombstone' AND x.hlc < o.hlc)))"
                ),
                [entity],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if orphan > 0 {
            return Err(format!(
                "导入后语义审计:{orphan} 条 {entity} set_field 指向无行且无 tombstone 的实体(孤儿,live 挂起),整体回滚"
            ));
        }
        let bad_order: i64 = live
            .query_row(
                "SELECT COUNT(*) FROM oplog o WHERE o.entity = ?1 AND o.kind = 'set_field' \
                 AND EXISTS (SELECT 1 FROM oplog c WHERE c.entity = ?1 AND c.entity_id = o.entity_id \
                              AND c.kind = 'create' AND c.hlc >= o.hlc)",
                [entity],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if bad_order > 0 {
            return Err(format!(
                "导入后语义审计:{bad_order} 条 {entity} set_field 的 create 晚于它(set-before-create,live 挂起),整体回滚"
            ));
        }
    }
    let orphan_link: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM oplog o WHERE o.entity = 'link' AND o.kind IN ('link_add','link_remove') AND ( \
                (NOT EXISTS (SELECT 1 FROM items i WHERE i.id = json_extract(o.payload,'$.item_id')) \
                 AND NOT EXISTS (SELECT 1 FROM oplog xi WHERE xi.entity='item' \
                                  AND xi.entity_id = json_extract(o.payload,'$.item_id') \
                                  AND (xi.kind='create' OR (xi.kind='tombstone' AND xi.hlc < o.hlc)))) \
                OR (NOT EXISTS (SELECT 1 FROM topics t WHERE t.id = json_extract(o.payload,'$.topic_id')) \
                    AND NOT EXISTS (SELECT 1 FROM oplog xt WHERE xt.entity='topic' \
                                     AND xt.entity_id = json_extract(o.payload,'$.topic_id') \
                                     AND (xt.kind='create' OR (xt.kind='tombstone' AND xt.hlc < o.hlc)))))",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if orphan_link > 0 {
        return Err(format!(
            "导入后语义审计:{orphan_link} 条 link op 的 item_id/topic_id 无行且无 tombstone(孤儿,live 挂起),整体回滚"
        ));
    }
    // 因果序:link 的父 create、image_add 的宿主 create 必须 HLC 早于该 op(tombstone 不豁免)。
    let bad_link_order: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM oplog o WHERE o.entity = 'link' AND o.kind IN ('link_add','link_remove') AND ( \
                EXISTS (SELECT 1 FROM oplog ci WHERE ci.entity='item' AND ci.entity_id=json_extract(o.payload,'$.item_id') AND ci.kind='create' AND ci.hlc >= o.hlc) \
                OR EXISTS (SELECT 1 FROM oplog ct WHERE ct.entity='topic' AND ct.entity_id=json_extract(o.payload,'$.topic_id') AND ct.kind='create' AND ct.hlc >= o.hlc))",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let bad_img_order: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM oplog o WHERE o.entity='image' AND o.kind='image_add' \
             AND EXISTS (SELECT 1 FROM oplog ci WHERE ci.entity='item' AND ci.entity_id=json_extract(o.payload,'$.item_id') AND ci.kind='create' AND ci.hlc >= o.hlc)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    // image_add 宿主的**存在**前置(实现审 H1 补全同型缺口):宿主无行且无「更早的」
    // tombstone = live 依赖挂起,同上拒。
    let orphan_img: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM oplog o WHERE o.entity='image' AND o.kind='image_add' \
             AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = json_extract(o.payload,'$.item_id')) \
             AND NOT EXISTS (SELECT 1 FROM oplog x WHERE x.entity='item' \
                              AND x.entity_id = json_extract(o.payload,'$.item_id') \
                              AND (x.kind='create' OR (x.kind='tombstone' AND x.hlc < o.hlc)))",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if orphan_img > 0 {
        return Err(format!(
            "导入后语义审计:{orphan_img} 条 image_add 的宿主无行且无更早 tombstone(孤儿,live 挂起),整体回滚"
        ));
    }
    if bad_link_order + bad_img_order > 0 {
        return Err(format!(
            "导入后语义审计:{} 条 link/image_add 的父 create 晚于它(依赖倒序,live 挂起),整体回滚",
            bad_link_order + bad_img_order
        ));
    }
    Ok(())
}

/// image 完整性审计(codex 二审):① 行关联——item_image 行的 item_id/mime 必与其
/// image_add op 一致(行挂错宿主 / MIME 不符 = 分叉,apply_image_bytes 以 op 为准);
/// ② image_tombstone 的 item_id 必与其 add 一致(apply_image_tombstone:replay.rs);
/// ③ 字节 hash——item_image.data 的 sha256 必与 image_add 声明一致(bulk copy 从不验货;
/// 严格纪元下 add 恒带 sha,无 sha 的 op 在 shape 审计已拒,下方 None 分支是防御性
/// 死路)。只查已落行图(MetadataOnly 轻端「有 add 无行」的图天然跳过)。
fn audit_image_integrity(live: &Connection) -> Result<(), String> {
    let bad_assoc: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM item_image r JOIN oplog o \
               ON o.entity = 'image' AND o.kind = 'image_add' AND o.entity_id = r.id \
             WHERE r.item_id != json_extract(o.payload, '$.item_id') \
                OR r.mime != json_extract(o.payload, '$.mime')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if bad_assoc > 0 {
        return Err(format!(
            "导入后语义审计:{bad_assoc} 张图的行 item_id/mime 与其 image_add op 不符,整体回滚"
        ));
    }
    // E(codex 二审):声明长度——data 字节数必须 == image_add.bytes(apply_image_bytes 的长度
    // 验货;无 sha 的 legacy image_add 无法验 hash,仍必须验长度)。
    let bad_len: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM item_image r JOIN oplog o \
               ON o.entity = 'image' AND o.kind = 'image_add' AND o.entity_id = r.id \
             WHERE length(r.data) != json_extract(o.payload, '$.bytes')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if bad_len > 0 {
        return Err(format!(
            "导入后语义审计:{bad_len} 张图的字节长度与 image_add 声明不符,整体回滚"
        ));
    }
    let bad_ts: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM oplog t JOIN oplog a \
               ON a.entity = 'image' AND a.kind = 'image_add' AND a.entity_id = t.entity_id \
             WHERE t.entity = 'image' AND t.kind = 'image_tombstone' \
               AND json_extract(t.payload, '$.item_id') != json_extract(a.payload, '$.item_id')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if bad_ts > 0 {
        return Err(format!(
            "导入后语义审计:{bad_ts} 条 image_tombstone 的 item_id 与其 image_add 不符,整体回滚"
        ));
    }
    let mut stmt = live
        .prepare(
            "SELECT r.id, r.data, json_extract(o.payload, '$.sha256') FROM item_image r \
             JOIN oplog o ON o.entity = 'image' AND o.kind = 'image_add' AND o.entity_id = r.id",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let sha: Option<String> = row.get(2).map_err(|e| e.to_string())?;
        let Some(expect) = sha else { continue };
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let data: Vec<u8> = row.get(1).map_err(|e| e.to_string())?;
        use sha2::{Digest, Sha256};
        let got: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
        if got != expect {
            return Err(format!(
                "导入后语义审计:图 {id} 的字节 sha256 与 image_add 声明不符,整体回滚"
            ));
        }
    }
    Ok(())
}

/// OR-set 审计:表里每条 op-backed link(有 link_add)必须存活(不被任何 remove 的
/// observed 覆盖);反之每条存活的 op-backed link 必须在表里。用日志重算存活集与表里
/// op-backed 行取对称差,非空 = 分叉。
fn audit_link_or_set(live: &Connection) -> Result<(), String> {
    // 表里 op-backed link(排除 legacy 无 link_add 行):item_id:topic_id。
    let mut stmt = live
        .prepare(
            "SELECT lt.item_id || ':' || lt.topic_id FROM item_topic lt \
             WHERE EXISTS (SELECT 1 FROM oplog o WHERE o.entity = 'link' AND o.kind = 'link_add' \
                            AND o.entity_id = lt.item_id || ':' || lt.topic_id) ORDER BY 1",
        )
        .map_err(|e| e.to_string())?;
    let in_table: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    // 日志重算存活集:某 link 有至少一条 link_add 不被任何 remove 的 observed 覆盖,
    // **且父实体(item/topic)未 tombstone**——与 replay::apply_link 同一口径(父墓碑下
    // apply_link 返回 ParentGone、不物化行,合法快照里这条 link 本就没行;不排除父墓碑会
    // 把「父已删、link_add 仍在史里」的合法快照误判为「该有行却没有」,误拒引导)。
    //
    // 无 observed 的遗留 remove 宽语义分支已随纪元切换删除(epoch-plan §3.1):这种 op
    // 已被严格 shape 审计(audit_op_shapes,本审计之前跑)整份拒掉,重算永远见不到;
    // 存量史实由纪元压实消灭。replay::apply_link 的重算与此同口径,两处必须一起改。
    let mut alive_stmt = live
        .prepare(
            "SELECT DISTINCT a.entity_id FROM oplog a \
             WHERE a.entity = 'link' AND a.kind = 'link_add' \
               AND NOT EXISTS ( \
                   SELECT 1 FROM oplog r, \
                        json_each(COALESCE(json_extract(r.payload, '$.observed'), '[]')) je \
                   WHERE r.entity = 'link' AND r.kind = 'link_remove' AND r.entity_id = a.entity_id \
                     AND je.value = a.op_id) \
               AND NOT EXISTS (SELECT 1 FROM oplog it WHERE it.entity = 'item' AND it.kind = 'tombstone' \
                                AND it.entity_id = json_extract(a.payload, '$.item_id')) \
               AND NOT EXISTS (SELECT 1 FROM oplog tt WHERE tt.entity = 'topic' AND tt.kind = 'tombstone' \
                                AND tt.entity_id = json_extract(a.payload, '$.topic_id')) \
             ORDER BY 1",
        )
        .map_err(|e| e.to_string())?;
    let alive: Vec<String> = alive_stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    if in_table != alive {
        return Err(format!(
            "导入后语义审计:标签关联终态与自身日志的 OR-set 结果不符(表 {} 条 vs 日志存活 {} 条),整体回滚",
            in_table.len(),
            alive.len()
        ));
    }
    Ok(())
}

/// 「图N」审计:每张有 image_add op 且已落行的图,行 seq 必须 == reconcile 的有效编号。
fn audit_image_seqs(live: &Connection) -> Result<(), String> {
    // 全局 counter 上界(codex 二审):防注入超高 last_seq 撑爆下次 attach 的 +1——含无
    // image_add 的伪 legacy item(下方 per-op-backed 循环不会遍历它)。
    let bad_counter: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM item_image_counter WHERE last_seq < 0 OR last_seq > ?1",
            [crate::images::MAX_IMAGE_SEQ],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if bad_counter > 0 {
        return Err(format!(
            "导入后语义审计:{bad_counter} 个「图N」counter 越界(<0 或 > 上限 {}),整体回滚",
            crate::images::MAX_IMAGE_SEQ
        ));
    }
    let mut stmt = live
        .prepare(
            "SELECT DISTINCT json_extract(payload, '$.item_id') FROM oplog \
             WHERE entity = 'image' AND kind = 'image_add'",
        )
        .map_err(|e| e.to_string())?;
    let items: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    for item_id in items {
        let Some((effective, max_seen)) = crate::replay::effective_seqs(live, &item_id)
            .map_err(|e| e.to_string())?
        else {
            continue;
        };
        // counter 水位 **≥** oplog 派生高水位(epoch-plan §1 第 3 条:纪元压实丢弃死图
        // 的 add——字节已删 sha 无从重算,counter 表原样保留承载编号洞,故「删掉最高
        // 编号图」的库 counter 合法高于日志派生值;`==` 会拒掉自己的合法库)。上界
        // ≤ MAX_IMAGE_SEQ 由本函数开头的全局越界检查钉死(防注入超高 last_seq DoS)。
        // item 墓碑会 CASCADE 清掉 counter 行(其 image_add op 仍在),这种 item 跳过不误判。
        let item_dead: bool = live
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM oplog WHERE entity = 'item' AND kind = 'tombstone' AND entity_id = ?1)",
                [&item_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !item_dead {
            let counter: Option<i64> = live
                .query_row("SELECT last_seq FROM item_image_counter WHERE item_id = ?1", [&item_id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            if counter.map_or(true, |c| c < max_seen) {
                return Err(format!(
                    "导入后语义审计:item {item_id} 的「图N」counter {counter:?} < 日志高水位 {max_seen}(快照损坏/伪造),整体回滚"
                ));
            }
        }
        for (image_id, (eff, _hlc)) in effective {
            let row_seq: Option<i64> = live
                .query_row("SELECT seq FROM item_image WHERE id = ?1", [&image_id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(seq) = row_seq {
                if seq != eff {
                    return Err(format!(
                        "导入后语义审计:图 {image_id} 行 seq {seq} != 日志 reconcile 有效编号 {eff}(快照与日志矛盾),整体回滚"
                    ));
                }
            }
        }
    }
    Ok(())
}

/// 引导 op-shape 审计(bedrock-fix §9):对**合并后的本机 oplog 全量**(源快照 + 本地
/// 并集,epoch-plan §3.5——不只扫 boot.oplog,加入端自带的历史一并过审)**每条 op**
/// 跑 replay 的共享 `validate_op_shape`,任一失败拒整份。与 live `apply_remote_op`
/// 单一真相源——闭合「引导审计口径比 replay 松→坏快照过审→诚实设备回放 Err→origin
/// 永久挂起+静默分叉」的 A 类根因。**严格纪元(§3.1)**:validate_op_shape 已删 3 处
/// legacy 容忍(int position / link_remove 缺 observed / image_add 缺 sha256),boot
/// 与 live 无例外同口径。
fn audit_op_shapes(tx: &Connection) -> Result<(), String> {
    scan_op_shapes(tx).map_err(|e| format!("导入后 op-shape 审计不过:{e},整体回滚"))
}

/// 本机 oplog 全量的严格 shape 扫描(中性错误,两个消费者各配话术):电池的
/// [`audit_op_shapes`] 与 fresh 判据 (c)([`check_fresh_to_account`],§3.5 第四闸)。
fn scan_op_shapes(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM oplog")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let payload_txt: String = row.get(5).map_err(|e| e.to_string())?;
        let payload: serde_json::Value = serde_json::from_str(&payload_txt)
            .map_err(|e| format!("oplog payload 非法 JSON:{e}"))?;
        let op = crate::replay::RemoteOp {
            op_id: row.get(0).map_err(|e| e.to_string())?,
            hlc: row.get(1).map_err(|e| e.to_string())?,
            entity: row.get(2).map_err(|e| e.to_string())?,
            entity_id: row.get(3).map_err(|e| e.to_string())?,
            kind: row.get(4).map_err(|e| e.to_string())?,
            payload,
            origin_seq: row.get(6).map_err(|e| e.to_string())?,
        };
        crate::replay::validate_op_shape(&op)
            .map_err(|e| format!("op {} 形态不过严格校验:{e}", op.op_id))?;
    }
    Ok(())
}

/// 快照路径 → 只读 ATTACH 的 SQLite URI(连接以 rusqlite 默认 flags 打开,含
/// SQLITE_OPEN_URI)。'?'/'#' 会截断 URI 语义——快照路径是本模块自己命名的,
/// 出现即环境异常,拒;'%' 转义防误解码。
fn snapshot_uri(path: &Path) -> Result<String, String> {
    let s = path.to_str().ok_or_else(|| "快照路径不是合法 UTF-8".to_string())?;
    if s.contains('?') || s.contains('#') {
        return Err(format!("快照路径含 URI 保留字符,拒挂载:{s}"));
    }
    let mut esc = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '%' => esc.push_str("%25"),
            '\\' => esc.push('/'),
            _ => esc.push(c),
        }
    }
    Ok(format!("file:///{}?mode=ro", esc.trim_start_matches('/')))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::crypto::{self, Domain, FrameAddr};

    /// space-entry-plan §3.2(codex 二轮 H1)的词法闸:integrity_check 必须在
    /// `import_attached` 的导入事务内、`bootstrapped_at` 落标与 commit **之前**
    /// (不过即整体回滚——绝不发布/激活一个完整性已失败的库);commit 之后
    /// (`import_snapshot` 事务外)不许再有任何体检。为什么按源码钉:只被
    /// integrity_check 捕获的页级损坏无法用安全 API 确定性注入,行为测照不出次序。
    #[test]
    fn integrity_check_inside_import_tx_before_commit_lexical() {
        let src = include_str!("boot.rs");
        let start = src.find("fn import_attached").expect("函数在本文件");
        let end = start + src[start..].find("\n}").expect("函数体以行首 } 结束");
        let body = &src[start..end];
        let integrity =
            body.find("integrity_check\"").expect("integrity_check 必须在 import_attached 内");
        let mark = body.find("'bootstrapped_at'").expect("落标在本函数");
        let commit = body.rfind("tx.commit()").expect("函数以 commit 收尾");
        assert!(integrity < mark, "integrity_check 必须先于 bootstrapped_at 落标");
        assert!(integrity < commit, "integrity_check 必须先于 commit");
        // commit 之后的 import_snapshot(事务外)零体检:完成边界 = 只剩 DETACH 分道。
        let snap_start = src.find("pub fn import_snapshot").expect("函数在本文件");
        let snap_end = snap_start + src[snap_start..].find("\n}").expect("函数体以行首 } 结束");
        assert!(
            !src[snap_start..snap_end].contains("integrity_check\""),
            "commit 之后不许再有体检(失败会把已提交的引导洗成 Err 重试)"
        );
    }
    use crate::sync::engine::{BlobPolicy, Engine, Msg, Output, BROADCAST};
    use crate::sync::pair::{
        gen_device_key, gen_secret, AccountGrant, DeviceEnroll, Joiner, Opener, PairOutput,
    };
    use crate::{db, images, notes, oplog, task};
    use rusqlite::Connection;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir_for(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ys-nb-boot-{}-{}-{}", tag, std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    /// 一个真库实例(独立文件 + 时钟)。
    struct Peer {
        conn: Connection,
        clock: Clock,
        device_id: String,
        dir: PathBuf,
    }

    fn peer(tag: &str) -> Peer {
        let dir = temp_dir_for(tag);
        let conn = db::open(&dir.join("db.sqlite3")).expect("open");
        let clock = Clock::load(&conn).expect("clock");
        let device_id = clock.device_id().to_string();
        Peer { conn, clock, device_id, dir }
    }

    /// 绕过供货闸的裸快照(对抗测试专用):恶意/坏源不会替我们跑严格电池
    /// (epoch-plan §3.3 的闸只拦诚实调用方),引导收端的审计必须独立自卫——
    /// 坏快照在测试里也必须绕闸生产,否则测的是闸、不是收端。
    fn raw_snapshot(conn: &Connection, dir: &Path) -> Snapshot {
        let path = dir.join(format!("boot-snapshot-{}.sqlite3", Ulid::new()));
        conn.execute("VACUUM INTO ?1", [path.to_str().unwrap()]).unwrap();
        let (bytes, sha256) = hash_file(&path).unwrap();
        Snapshot { path, bytes, sha256 }
    }

    /// 回放豁免下手插一行(造 0020 之前的 legacy 无背书行;单机正道插不出这种行)。
    fn insert_legacy_row(conn: &Connection, id: &str, sealed: bool, born_null: bool) {
        conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        conn.execute(
            "INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, \
                                due_on, priority, position, sealed_at, born_stage) \
             VALUES (?1, '同步纪元前的遗产', 'done', 't0', 't0', NULL, NULL, NULL, 'a0', \
                     ?2, ?3)",
            (
                id,
                if sealed { Some("t9") } else { None },
                if born_null { None } else { Some("todo") },
            ),
        )
        .unwrap();
        conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    }

    // ---- 0025:两只 INSERT 守护的豁免形态(迁移折测) ----

    #[test]
    fn migration_0025_guards_still_bite_outside_replay_but_yield_inside() {
        let p = peer("m25");
        // 非豁免:生而归档 / born_stage NULL / born_stage ≠ stage 全 ABORT(单机铁律不松)。
        for (sealed, born) in [(Some("t9"), Some("done")), (None, None::<&str>), (None, Some("inbox"))] {
            let err = p
                .conn
                .execute(
                    "INSERT INTO items (id, content, stage, created_at, updated_at, position, \
                                        sealed_at, born_stage) \
                     VALUES ('x', 'x', 'done', 't', 't', 'a0', ?1, ?2)",
                    (sealed, born),
                )
                .unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("归档标记") || msg.contains("出生态"),
                "该被守护触发器拦下,实际:{msg}"
            );
        }
        // 豁免:三种终态行(sealed 非空 / born NULL / born ≠ stage)全放行。
        insert_legacy_row(&p.conn, "L1", true, true);
        insert_legacy_row(&p.conn, "L2", false, true);
        insert_legacy_row(&p.conn, "L3", false, false);
        let n: i64 = p.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
    }

    // ---- BootMsg 线上格式 ----

    /// boot 域内层消息黄金向量(externally tagged;与 Msg/信封/PairWire 同纪律)。
    #[test]
    fn boot_msg_golden_vectors() {
        fn hex(b: &[u8]) -> String {
            b.iter().map(|x| format!("{x:02x}")).collect()
        }
        let cases: Vec<(BootMsg, &str)> = vec![
            (BootMsg::Req, "63526571"),
            (
                BootMsg::Offer { transfer: "T".into(), bytes: 5, sha256: vec![0xAB] },
                "a1654f66666572a3687472616e736665726154656279746573056673686132353641ab",
            ),
            (
                BootMsg::Chunk { transfer: "T".into(), idx: 0, last: true, data: vec![1, 2] },
                "a1654368756e6ba4687472616e7366657261546369647800646c617374f56464617461420102",
            ),
        ];
        for (msg, want) in cases {
            let mut buf = Vec::new();
            ciborium::into_writer(&msg, &mut buf).unwrap();
            assert_eq!(hex(&buf), want, "{msg:?} 的 CBOR 字节形态漂了");
            let back: BootMsg = ciborium::from_reader(buf.as_slice()).unwrap();
            assert_eq!(back, msg);
        }
    }

    // ---- fresh-to-account 判据 ----

    #[test]
    fn fresh_check_passes_on_virgin_and_fully_endorsed_dbs() {
        let mut p = peer("fresh-ok");
        check_fresh_to_account(&p.conn).expect("空库即 fresh");
        // 真命令造数据:每一行都有本机 op 背书。
        let idea = notes::capture(&mut p.conn, &mut p.clock, "有背书的灵感").unwrap();
        let topic = notes::create_topic(&mut p.conn, &mut p.clock, "标签").unwrap();
        notes::file_to_topic(&mut p.conn, &mut p.clock, &idea, Some(&topic), None).unwrap();
        let task_id = task::create(&mut p.conn, &mut p.clock, "任务", None, None, None).unwrap();
        images::attach(&mut p.conn, &mut p.clock, &task_id, &[1, 2, 3], "image/png").unwrap();
        check_fresh_to_account(&p.conn).expect("全背书仍 fresh");
    }

    #[test]
    fn fresh_check_rejects_foreign_ops_bootstrap_mark_and_legacy_rows() {
        // 有他人 origin 的 op:曾同步过,走水位追赶。
        let p = peer("fresh-foreign");
        oplog::append_remote(
            &p.conn,
            "01JZFOREIGNOP000000000000A",
            "0000018f00000000-00000000-01JZFOREIGNDEV00000000000A",
            "topic",
            "01JZFOREIGNTOPIC000000000A",
            "create",
            &serde_json::json!({"title": "t", "created_at": "t", "updated_at": "t"}),
            1,
        )
        .unwrap();
        let err = check_fresh_to_account(&p.conn).unwrap_err();
        assert!(err.contains("水位追赶"), "{err}");

        // 已引导过:标记挡住重复引导。
        let p = peer("fresh-marked");
        p.conn
            .execute("INSERT INTO sync_meta (key, value) VALUES ('bootstrapped_at', 't')", [])
            .unwrap();
        let err = check_fresh_to_account(&p.conn).unwrap_err();
        assert!(err.contains("已完成过引导"), "{err}");

        // legacy 无背书行:只能作为账户首台(评审①-H1 的 (b))。
        let p = peer("fresh-legacy");
        insert_legacy_row(&p.conn, "L1", false, true);
        let err = check_fresh_to_account(&p.conn).unwrap_err();
        assert!(err.contains("账户首台"), "{err}");
    }

    /// 供货闸(epoch-plan §3.3):快照出手前电池现场重跑——带 legacy 的库拒当引导源
    /// (不是看 `epoch` KV,标记可孤立漂移);干净库照常供货(阴性对照)。
    #[test]
    fn supply_gate_refuses_uncertified_source() {
        let mut a = peer("gate-src");
        notes::capture(&mut a.conn, &mut a.clock, "正常数据").unwrap();
        make_snapshot(&a.conn, &a.dir).expect("干净库照常供货");
        insert_legacy_row(&a.conn, "L1", false, true);
        let err = make_snapshot(&a.conn, &a.dir).unwrap_err();
        assert!(err.contains("纪元认证"), "{err}");
    }

    /// fresh 第四闸(epoch-plan §3.5):行全有背书、日志全是本机 op——判据 (a)/(b)
    /// 都过,唯 op 是旧形态(int position)。只有第四闸能拦;不拦则引导合并后在
    /// 导入审计才炸,人话降级成审计报错。
    #[test]
    fn fresh_check_rejects_legacy_shaped_ops_fourth_gate() {
        let mut a = peer("fresh4");
        let task = task::create(&mut a.conn, &mut a.clock, "行有背书", None, None, None).unwrap();
        check_fresh_to_account(&a.conn).expect("现代形态 = fresh(阴性对照)");
        let hlc = a.clock.tick(&a.conn).unwrap();
        let seq: i64 = a
            .conn
            .query_row(
                "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
                [hlc.device_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        a.conn
            .execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'item', ?3, 'set_field', \
                         '{\"field\":\"position\",\"value\":7}', ?4)",
                rusqlite::params![ulid::Ulid::new().to_string(), hlc.encode(), task, seq],
            )
            .unwrap();
        let err = check_fresh_to_account(&a.conn).unwrap_err();
        assert!(err.contains("旧形态操作记录"), "{err}");
    }

    // ---- 快照流 ----

    #[test]
    fn snapshot_stream_round_trips_bytes_exactly() {
        let mut a = peer("snap-a");
        for i in 0..12 {
            notes::capture(&mut a.conn, &mut a.clock, &format!("灵感 {i}")).unwrap();
        }
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        assert!(snap.bytes > 0);
        let mut sender = BootSender::new(&snap).unwrap();
        let Some(BootMsg::Offer { transfer, bytes, sha256 }) = sender.next_msg().unwrap() else {
            panic!("首帧必须是 Offer");
        };
        assert_eq!(bytes, snap.bytes);

        let recv_dir = temp_dir_for("snap-b");
        let mut recv = BootReceiver::start(&recv_dir, "dev-a", &transfer, bytes, &sha256).unwrap();
        let mut outcome = ChunkOutcome::More;
        while let Some(msg) = sender.next_msg().unwrap() {
            let BootMsg::Chunk { transfer, idx, last, data } = msg else {
                panic!("Offer 后只该出 Chunk");
            };
            // 迷路残帧(错源/错 transfer)静默丢,不作废本流。
            assert_eq!(
                recv.on_chunk("dev-x", &transfer, idx, last, &data).unwrap(),
                ChunkOutcome::Ignored
            );
            assert_eq!(
                recv.on_chunk("dev-a", "01JZOTHERTRANSFER00000000A", idx, last, &data).unwrap(),
                ChunkOutcome::Ignored
            );
            outcome = recv.on_chunk("dev-a", &transfer, idx, last, &data).unwrap();
        }
        assert_eq!(outcome, ChunkOutcome::Complete);
        assert_eq!(
            std::fs::read(recv.path()).unwrap(),
            std::fs::read(&snap.path).unwrap(),
            "收到的快照必须与源文件逐字节相等"
        );
    }

    #[test]
    fn receiver_rejects_tamper_disorder_and_oversize() {
        let mut a = peer("recv-guard");
        notes::capture(&mut a.conn, &mut a.clock, "x").unwrap();
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        let dir = temp_dir_for("recv-guard-b");
        let t = || Ulid::new().to_string();

        // 声明大小不合理。
        assert!(BootReceiver::start(&dir, "a", &t(), 0, &[0; 32]).is_err());
        assert!(BootReceiver::start(&dir, "a", &t(), MAX_SNAPSHOT_BYTES + 1, &[0; 32]).is_err());
        assert!(BootReceiver::start(&dir, "a", &t(), 8, &[0; 31]).is_err());

        // 错序作废。
        let t1 = t();
        let mut recv = BootReceiver::start(&dir, "a", &t1, snap.bytes, &snap.sha256).unwrap();
        assert!(recv.on_chunk("a", &t1, 1, false, &[0]).is_err());
        // 作废后本流一切后续块 Ignored(不 panic 不复活)。
        assert_eq!(recv.on_chunk("a", &t1, 0, false, &[0]).unwrap(), ChunkOutcome::Ignored);

        // 超声明作废。
        let t2 = t();
        let mut recv = BootReceiver::start(&dir, "a", &t2, 4, &[0; 32]).unwrap();
        assert!(recv.on_chunk("a", &t2, 0, false, &[0; 5]).is_err());

        // 篡改:字节数对但内容动过 → sha256 拆穿。
        let t3 = t();
        let mut recv = BootReceiver::start(&dir, "a", &t3, snap.bytes, &snap.sha256).unwrap();
        let mut bad = std::fs::read(&snap.path).unwrap();
        bad[0] ^= 1;
        let err = recv.on_chunk("a", &t3, 0, true, &bad).unwrap_err();
        assert!(err.contains("sha256"), "{err}");

        // 长度短于声明的「终块」。
        let t4 = t();
        let mut recv = BootReceiver::start(&dir, "a", &t4, snap.bytes, &snap.sha256).unwrap();
        let err = recv.on_chunk("a", &t4, 0, true, &[0; 3]).unwrap_err();
        assert!(err.contains("长度不符"), "{err}");
    }

    #[test]
    fn receiver_rejects_traversal_and_duplicate_transfer() {
        let dir = temp_dir_for("recv-path");
        // transfer 拼进本地路径:非 ULID 形态(穿越字节/随意串)一律拒
        // (codex P2-f 轮 H2)。
        for evil in ["../evil", "..\\evil", "a/b", "t", &"0".repeat(26 + 1)] {
            let err = BootReceiver::start(&dir, "a", evil, 8, &[0; 32]).unwrap_err();
            assert!(err.contains("ULID"), "{evil} 该被 ULID 校验拒:{err}");
        }
        // 同 transfer 重复开流:create_new 拒,绝不截断已有文件。
        let t = Ulid::new().to_string();
        let _keep = BootReceiver::start(&dir, "a", &t, 8, &[0; 32]).unwrap();
        let err = BootReceiver::start(&dir, "a", &t, 8, &[0; 32]).unwrap_err();
        assert!(err.contains("重复 transfer"), "{err}");
    }

    // ---- 导入合并 ----

    #[test]
    fn import_rejects_snapshot_of_self() {
        let mut a = peer("self-snap");
        notes::capture(&mut a.conn, &mut a.clock, "自己的数据").unwrap();
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        let err = import_snapshot(&mut a.conn, &mut a.clock, &snap.path).unwrap_err();
        assert!(err.contains("本机自己"), "{err}");
        // 半途而废不留痕:无 bootstrapped 标记、行数不变。
        assert!(meta_get(&a.conn, "bootstrapped_at").unwrap().is_none());
        let n: i64 = a.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    // ---- space profile 单例合并(0028,space-name-sync-plan §4.4) ----

    fn space_profile_of(conn: &Connection) -> (i64, Option<Option<String>>) {
        let rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM space_profile", [], |r| r.get(0)).unwrap();
        let name = conn
            .query_row("SELECT name FROM space_profile WHERE key = 'profile'", [], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()
            .unwrap();
        (rows, name)
    }

    /// 四象限矩阵(codex 一轮 H1):固定主键 'profile' 决定了 boot 绝不能表复制——
    /// 「本地已命名 + 源也命名」必撞 PK;单例合并 = 合并日志取 HLC 赢家 UPSERT 物化。
    #[test]
    fn import_merges_space_profile_singleton_all_quadrants() {
        // ① 双方都有名:物化值 == 合并日志 HLC 最大 op 的 value(与语义审计同判据)。
        let mut a = peer("sp-q1-src");
        notes::capture(&mut a.conn, &mut a.clock, "数据").unwrap();
        crate::spaces::set_space_name(&mut a.conn, &mut a.clock, "源名").unwrap();
        let mut b = peer("sp-q1-dst");
        crate::spaces::set_space_name(&mut b.conn, &mut b.clock, "本机名").unwrap();
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap();
        let (rows, name) = space_profile_of(&b.conn);
        assert_eq!(rows, 1, "恰一行(表复制必撞 PK 的根治形)");
        let winner: Option<String> = b
            .conn
            .query_row(
                "SELECT json_extract(payload, '$.value') FROM oplog \
                 WHERE entity = 'space' ORDER BY hlc DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, Some(winner.clone()), "物化 == 合并日志赢家");
        assert!(
            matches!(winner.as_deref(), Some("源名") | Some("本机名")),
            "赢家必是两名之一:{winner:?}"
        );
        strict_battery(&b.conn).unwrap();

        // ② 仅源有名:名字随快照到。
        let mut c = peer("sp-q2-dst");
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        import_snapshot(&mut c.conn, &mut c.clock, &snap.path).unwrap();
        assert_eq!(space_profile_of(&c.conn), (1, Some(Some("源名".into()))));

        // ③ 仅本机有名:源零 space op,本机名不被搅动。
        let mut src2 = peer("sp-q3-src");
        notes::capture(&mut src2.conn, &mut src2.clock, "无名源").unwrap();
        let mut d = peer("sp-q3-dst");
        crate::spaces::set_space_name(&mut d.conn, &mut d.clock, "本机名").unwrap();
        let snap = make_snapshot(&src2.conn, &src2.dir).unwrap();
        import_snapshot(&mut d.conn, &mut d.clock, &snap.path).unwrap();
        assert_eq!(space_profile_of(&d.conn), (1, Some(Some("本机名".into()))));

        // ④ 双方无名:零行,无事发生。
        let mut e = peer("sp-q4-dst");
        let snap = make_snapshot(&src2.conn, &src2.dir).unwrap();
        import_snapshot(&mut e.conn, &mut e.clock, &snap.path).unwrap();
        assert_eq!(space_profile_of(&e.conn), (0, None));
        strict_battery(&e.conn).unwrap();

        // ⑤ null 赢家(codex 实现审 M4):源端显式清名(远端 null op,HLC 恒最高)
        // 压过本机名——物化 = 行在、name NULL(H2 规范表示)。
        let mut src3 = peer("sp-q5-src");
        notes::capture(&mut src3.conn, &mut src3.clock, "有数据").unwrap();
        crate::spaces::set_space_name(&mut src3.conn, &mut src3.clock, "先有名").unwrap();
        let clear = crate::replay::RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: Hlc {
                wall_ms: 4_102_444_800_000, // 2100 年,恒为全网最高
                counter: 0,
                device_id: "RMTDEV0000000000000000000X".into(),
            }
            .encode(),
            entity: "space".into(),
            entity_id: "profile".into(),
            kind: "set_field".into(),
            payload: serde_json::json!({"field": "name", "value": null}),
            origin_seq: 1,
        };
        crate::replay::apply_remote_op(&mut src3.conn, &mut src3.clock, &clear).unwrap();
        let mut f = peer("sp-q5-dst");
        crate::spaces::set_space_name(&mut f.conn, &mut f.clock, "本机名").unwrap();
        let snap = make_snapshot(&src3.conn, &src3.dir).unwrap();
        import_snapshot(&mut f.conn, &mut f.clock, &snap.path).unwrap();
        assert_eq!(space_profile_of(&f.conn), (1, Some(None)), "null 赢家 = 行在、name NULL");
        strict_battery(&f.conn).unwrap();
    }

    /// 双侧独立预审(codex 二轮 M1):任一侧「状态与日志矛盾」响亮拒,合并绝不代修。
    #[test]
    fn import_rejects_space_profile_state_log_mismatch_both_sides() {
        // 源侧:裸快照(绕供货闸)塞一行无 op 背书的 profile。
        let mut a = peer("sp-bad-src");
        notes::capture(&mut a.conn, &mut a.clock, "数据").unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        {
            let sc = Connection::open(&snap.path).unwrap();
            sc.execute("INSERT INTO space_profile (key, name) VALUES ('profile', '伪名')", [])
                .unwrap();
        }
        let mut b = peer("sp-bad-src-dst");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("快照") && err.contains("行在无 op"), "{err}");
        // 半途无痕。
        assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none());

        // 本机侧:本地 profile 行无 op(space_profile 无触发器守护,直插模拟损坏)。
        let mut c = peer("sp-bad-local");
        c.conn
            .execute("INSERT INTO space_profile (key, name) VALUES ('profile', '幽灵')", [])
            .unwrap();
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        let err = import_snapshot(&mut c.conn, &mut c.clock, &snap.path).unwrap_err();
        assert!(err.contains("本机") && err.contains("行在无 op"), "{err}");

        // 源侧变体(codex 实现审 M4):有 op、行也在,但行值 ≠ 日志赢家——拒。
        let mut d = peer("sp-bad-val-src");
        notes::capture(&mut d.conn, &mut d.clock, "数据").unwrap();
        crate::spaces::set_space_name(&mut d.conn, &mut d.clock, "真名").unwrap();
        let snap = raw_snapshot(&d.conn, &d.dir);
        {
            let sc = Connection::open(&snap.path).unwrap();
            sc.execute("UPDATE space_profile SET name = '改错' WHERE key = 'profile'", []).unwrap();
        }
        let mut e = peer("sp-bad-val-dst");
        let err = import_snapshot(&mut e.conn, &mut e.clock, &snap.path).unwrap_err();
        assert!(err.contains("快照") && err.contains("赢家不符"), "{err}");
    }

    /// 工序1 的 boot 分支覆盖(codex 复审 §7):非 NULL done_at 随快照整行到新端、逐字保留,
    /// 并经引导 strict battery(done_at 已入 ITEM_LWW_FIELDS + create-forced-NULL 审计)。此前
    /// boot 只走 done_at=NULL,整行复制与审计的非 NULL 分支未被执行。
    #[test]
    fn import_preserves_nonnull_done_at() {
        let mut a = peer("done-a");
        let id = task::create(&mut a.conn, &mut a.clock, "干完的活", None, None, None).unwrap();
        task::transition(&mut a.conn, &mut a.clock, &id, "done").unwrap();
        // 工序1 无本地 writer:合法远端 done_at set_field 落值 + 记 op(strict battery 要求行值
        // == oplog LWW 赢家,故经 apply_remote_op 落值,而非裸 UPDATE)。
        let done_ts = "2026-07-20T10:00:00.000Z";
        crate::replay::apply_remote_op(
            &mut a.conn,
            &mut a.clock,
            &crate::replay::RemoteOp {
                op_id: Ulid::new().to_string(),
                hlc: crate::clock::Hlc {
                    wall_ms: 4_102_444_800_000,
                    counter: 0,
                    device_id: "RMTDEV0000000000000000000X".into(),
                }
                .encode(),
                entity: "item".into(),
                entity_id: id.clone(),
                kind: "set_field".into(),
                payload: serde_json::json!({"field": "done_at", "value": done_ts}),
                origin_seq: 1,
            },
        )
        .expect("done_at 落值");

        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        let mut b = peer("done-b");
        check_fresh_to_account(&b.conn).expect("新端 fresh");
        import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap().expect_clean_commit();
        let got: Option<String> =
            b.conn.query_row("SELECT done_at FROM items WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(got.as_deref(), Some(done_ts), "引导后 done_at 逐字保留");
    }

    /// §6.2 全形态导入:老端(归档成就/回收站/图/编辑历史/标签),新端有配对前本地
    /// 数据 + 同名标签——并集、零丢失、时钟推进、标记落盘。严格纪元(epoch-plan
    /// §3.2)起快照不得携带无背书 legacy 行(负例见
    /// `import_rejects_snapshot_with_unbacked_row`),夹具全走命令正道。
    #[test]
    fn import_merges_all_shapes_and_advances_clock() {
        let mut a = peer("imp-a");
        // 老端全形态数据(命令正道)。
        let idea = notes::capture(&mut a.conn, &mut a.clock, "灵感甲").unwrap();
        let t_work = notes::create_topic(&mut a.conn, &mut a.clock, "撞名标签").unwrap();
        notes::file_to_topic(&mut a.conn, &mut a.clock, &idea, Some(&t_work), None).unwrap();
        notes::set_topic_color(&mut a.conn, &mut a.clock, &t_work, Some("#3f7a99".into())).unwrap(); // 颜色随快照过通道 + 过审计
        notes::edit(&mut a.conn, &mut a.clock, &idea, "灵感甲(改)").unwrap(); // → 1 条历史
        let task_id = task::create(&mut a.conn, &mut a.clock, "任务乙", Some("2026-08-01"), Some(2), None).unwrap();
        images::attach(&mut a.conn, &mut a.clock, &task_id, &[9, 9, 9], "image/png").unwrap();
        let done_id = task::create(&mut a.conn, &mut a.clock, "已完事", None, None, None).unwrap();
        task::transition(&mut a.conn, &mut a.clock, &done_id, "done").unwrap();
        task::seal(&mut a.conn, &mut a.clock, &done_id).unwrap(); // 归档成就(sealed 行)
        let trash_id = notes::capture(&mut a.conn, &mut a.clock, "进回收站").unwrap();
        notes::archive(&mut a.conn, &mut a.clock, &trash_id).unwrap();

        // 新端:配对前本地数据 + 同名标签(全背书,fresh)。
        let mut b = peer("imp-b");
        let b_idea = notes::capture(&mut b.conn, &mut b.clock, "新端自己的灵感").unwrap();
        let b_topic = notes::create_topic(&mut b.conn, &mut b.clock, "撞名标签").unwrap();
        notes::file_to_topic(&mut b.conn, &mut b.clock, &b_idea, Some(&b_topic), None).unwrap();
        images::attach(&mut b.conn, &mut b.clock, &b_idea, &[1], "image/png").unwrap();

        let a_items: i64 = a.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        let a_max_hlc: String =
            a.conn.query_row("SELECT MAX(hlc) FROM oplog", [], |r| r.get(0)).unwrap();

        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        check_fresh_to_account(&b.conn).expect("新端 fresh");
        let report = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap().expect_clean_commit();
        assert_eq!(report.items as i64, a_items);
        assert_eq!(report.revisions, 1);
        assert_eq!(report.images, 1);

        // 并集:新端原有 2 行(灵感 + 无;b_idea)+ 老端全量。
        let b_items: i64 = b.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(b_items, a_items + 1);
        // 同名标签并存为两个 topic(§6.2 步骤 5:不代合并)。
        let dup: i64 = b
            .conn
            .query_row("SELECT COUNT(*) FROM topics WHERE title = '撞名标签'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dup, 2);
        // 老端标签的颜色随快照过来了(且 op-backed 语义审计对 color 放行——import 已 unwrap);
        // 新端自己那个同名标签仍是无色(两个 topic id 不同、互不影响)。
        let work_color: Option<String> =
            b.conn.query_row("SELECT color FROM topics WHERE id = ?1", [&t_work], |r| r.get(0)).unwrap();
        assert_eq!(work_color.as_deref(), Some("#3f7a99"));
        let b_color: Option<String> =
            b.conn.query_row("SELECT color FROM topics WHERE id = ?1", [&b_topic], |r| r.get(0)).unwrap();
        assert!(b_color.is_none());
        // 两种终态行都进来了:sealed / archived。
        let sealed_in: i64 = b
            .conn
            .query_row("SELECT COUNT(*) FROM items WHERE id = ?1 AND sealed_at IS NOT NULL", [&done_id], |r| r.get(0))
            .unwrap();
        assert_eq!(sealed_in, 1);
        let trashed_in: i64 = b
            .conn
            .query_row("SELECT COUNT(*) FROM items WHERE id = ?1 AND archived_at IS NOT NULL", [&trash_id], |r| r.get(0))
            .unwrap();
        assert_eq!(trashed_in, 1);
        // 图字节随快照直达(引导不走旁路)。
        let img_bytes: Vec<u8> = b
            .conn
            .query_row("SELECT data FROM item_image WHERE item_id = ?1", [&task_id], |r| r.get(0))
            .unwrap();
        assert_eq!(img_bytes, vec![9, 9, 9]);
        // 标记落盘 + 重复引导被拒。
        assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_some());
        assert!(check_fresh_to_account(&b.conn).is_err());
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("已完成过引导"), "{err}");
        // 时钟已 observe:下一枚本机 HLC 严格高于导入日志的一切(编辑因果成立)。
        let next = b.clock.tick(&b.conn).unwrap();
        assert!(next.encode() > a_max_hlc, "{} !> {a_max_hlc}", next.encode());
        // 快照文件用后由调用方删除(内含老端 sync_meta,别留盘)。
        std::fs::remove_file(&snap.path).unwrap();
    }

    /// 严格纪元「恰一条 create」(epoch-plan §3.2):快照携带无 op 背书的行(pre-0020
    /// 遗产)不再是合法史实——正道是先在锚点跑纪元压实合成背书,再当快照源。零背书
    /// 容忍若不删,「作弊伪装成 legacy」是信息论级不可区分的洞(§1)。
    #[test]
    fn import_rejects_snapshot_with_unbacked_row() {
        let mut a = peer("unbacked-a");
        notes::capture(&mut a.conn, &mut a.clock, "正常数据").unwrap();
        insert_legacy_row(&a.conn, "01JZLEGACY000000000000000A", true, true); // 0020 前遗产
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("unbacked-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("无 op 背书"), "{err}");
        // 整体回滚不留痕。
        assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none());
        let n: i64 = b.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    /// 注毒快照四连拒(codex P2-f 轮 H1/M2):快照绕过 engine 的入池硬校验,导入
    /// 事务必须自己把同一口径补上——坏 op_id / 坏 hlc / 双序矛盾 / tombstone 复活,
    /// 全部整体回滚不留痕。毒是往快照文件 INSERT(oplog 只拦 UPDATE/DELETE,INSERT
    /// 畅通,正好模拟「坏实现同版本客户端」产出的合法-形态-坏-语义快照)。
    #[test]
    fn import_rejects_poisoned_snapshot_logs() {
        let mut a = peer("poison-a");
        let idea = notes::capture(&mut a.conn, &mut a.clock, "正常数据").unwrap();
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        let (a_origin, a_max_seq): (String, i64) = a
            .conn
            .query_row("SELECT origin, MAX(origin_seq) FROM oplog GROUP BY origin", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();

        let mut b = peer("poison-b");
        let poison = |tag: &str, sql: String| -> PathBuf {
            let path = a.dir.join(format!("poisoned-{tag}.sqlite3"));
            std::fs::copy(&snap.path, &path).unwrap();
            let c = Connection::open(&path).unwrap();
            c.execute_batch(&sql).unwrap();
            path
        };

        // ① 坏 op_id(非 ULID)。
        let p1 = poison(
            "opid",
            format!(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES ('not-a-ulid', 'fffffffffffff-00000000-{a_origin}', 'topic', \
                         '01JZPOISONTOPIC000000000AA', 'create', '{{}}', {})",
                a_max_seq + 1
            ),
        );
        let err = import_snapshot(&mut b.conn, &mut b.clock, &p1).unwrap_err();
        assert!(err.contains("op_id"), "{err}");

        // ② 坏 hlc(解析不过;origin 生成列成空串,连续性也过不了——形态校验先响)。
        let p2 = poison(
            "hlc",
            format!(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES ('{}', 'garbage-hlc', 'topic', '01JZPOISONTOPIC000000000AB', \
                         'create', '{{}}', 1)",
                Ulid::new()
            ),
        );
        let err = import_snapshot(&mut b.conn, &mut b.clock, &p2).unwrap_err();
        assert!(err.contains("hlc") || err.contains("洞"), "{err}");

        // ③ 双序矛盾:seq 连续(MAX+1)但 hlc 倒挂(全零墙钟必小于既有一切)。
        let p3 = poison(
            "dualorder",
            format!(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES ('{}', '0000000000000-00000000-{a_origin}', 'topic', \
                         '01JZPOISONTOPIC000000000AC', 'create', '{{}}', {})",
                Ulid::new(),
                a_max_seq + 1
            ),
        );
        let err = import_snapshot(&mut b.conn, &mut b.clock, &p3).unwrap_err();
        assert!(err.contains("双序"), "{err}");

        // ④ tombstone 复活:日志声称该 item 已死,行却还在(墓碑不可逆,65 契约①)。
        let p4 = poison(
            "undead",
            format!(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES ('{}', 'fffffffffffff-00000000-{a_origin}', 'item', '{idea}', \
                         'tombstone', '{{}}', {})",
                Ulid::new(),
                a_max_seq + 1
            ),
        );
        let err = import_snapshot(&mut b.conn, &mut b.clock, &p4).unwrap_err();
        assert!(err.contains("tombstone"), "{err}");

        // 四连拒全部不留痕:B 仍是 fresh 空库,正常快照照样导得进。
        assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none());
        let n: i64 = b.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap();
    }

    /// 语义分叉快照三连拒(codex P2-h 二轮 H2):结构/FK/counter/双序全过,但**终态与
    /// 自身日志矛盾**——content/link/图N 与 oplog 重算不符。这是「坏实现同版本客户端」或
    /// 恶意已配对 peer 灌的静默分叉,结构校验放行、语义审计必须拦。毒是往快照表里 UPDATE/
    /// INSERT/DELETE(不动 oplog),正好造出「日志说 A、表里 B」。
    #[test]
    fn import_rejects_semantically_divergent_snapshot() {
        let mut a = peer("semdiv-a");
        let idea = notes::capture(&mut a.conn, &mut a.clock, "日志里的真内容").unwrap();
        let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
        notes::file_to_topic(&mut a.conn, &mut a.clock, &idea, Some(&topic), None).unwrap();
        let task = task::create(&mut a.conn, &mut a.clock, "带图", None, None, None).unwrap();
        images::attach(&mut a.conn, &mut a.clock, &task, &[5, 5, 5], "image/png").unwrap();
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();

        let mut b = peer("semdiv-b");
        let poison = |tag: &str, sql: String| -> PathBuf {
            let path = a.dir.join(format!("semdiv-{tag}.sqlite3"));
            std::fs::copy(&snap.path, &path).unwrap();
            let c = Connection::open(&path).unwrap();
            // 回放豁免下动表(绕过单机守护/归档触发器),纯造终态-日志分叉。
            c.execute_batch("INSERT INTO sync_replay_active (flag) VALUES (1);").unwrap();
            c.execute_batch(&sql).unwrap();
            c.execute_batch("DELETE FROM sync_replay_active;").unwrap();
            path
        };

        // ① content 分叉:表里内容 ≠ 日志 LWW winner。
        let p1 = poison("content", format!("UPDATE items SET content='被篡改' WHERE id='{idea}';"));
        let err = import_snapshot(&mut b.conn, &mut b.clock, &p1).unwrap_err();
        assert!(err.contains("语义审计") && err.contains("content"), "{err}");

        // ② OR-set 分叉:日志说该标签关联存活,表里却删了(或反之)。删掉一条 op-backed link。
        let p2 = poison("link", format!("DELETE FROM item_topic WHERE item_id='{idea}';"));
        let err = import_snapshot(&mut b.conn, &mut b.clock, &p2).unwrap_err();
        assert!(err.contains("语义审计") && err.contains("OR-set"), "{err}");

        // ③ 「图N」分叉:行 seq 与日志 reconcile 值不符。同步抬高 counter(否则先撞
        // 既有的 counter-behind 结构校验),把毒逼到语义审计的图N比对上。
        let p3 = poison(
            "imgseq",
            format!(
                "UPDATE item_image SET seq = 99 WHERE item_id='{task}'; \
                 UPDATE item_image_counter SET last_seq = 99 WHERE item_id='{task}';"
            ),
        );
        let err = import_snapshot(&mut b.conn, &mut b.clock, &p3).unwrap_err();
        assert!(err.contains("语义审计") && err.contains("图"), "{err}");

        // ④ topic.updated_at 分叉:它是同步字段(apply_topic_set_field 白名单),表值 ≠ 日志 winner。
        let p4 = poison(
            "topicup",
            format!("UPDATE topics SET updated_at='2099-01-01T00:00:00Z' WHERE id='{topic}';"),
        );
        let err = import_snapshot(&mut b.conn, &mut b.clock, &p4).unwrap_err();
        assert!(err.contains("语义审计") && err.contains("updated_at"), "{err}");

        // 四连拒全部不留痕:B 仍 fresh,正常快照照导(语义审计对合法快照放行)。
        assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none());
        import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap();
        assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_some());
    }

    /// H2 复核 Finding 1:父实体 tombstone 后 link_add 仍在史里、但 item_topic 无行(FK
    /// cascade)——这是**合法**快照。OR-set 审计必须与 replay::apply_link(父墓碑 = ParentGone
    /// 不物化行)对齐、排除父墓碑 link,否则误拒合法引导。item 墓碑、topic 墓碑两条都测。
    #[test]
    fn import_accepts_link_with_tombstoned_parent() {
        let mut a = peer("linktomb-a");
        // ① topic 墓碑:idea 挂 topic,删 topic(topic tombstone + cascade 清 link 行)。
        let i1 = notes::capture(&mut a.conn, &mut a.clock, "挂了会被删标签的想法").unwrap();
        let t1 = notes::create_topic(&mut a.conn, &mut a.clock, "会被删的标签").unwrap();
        notes::file_to_topic(&mut a.conn, &mut a.clock, &i1, Some(&t1), None).unwrap();
        notes::delete_topic(&mut a.conn, &mut a.clock, &t1).unwrap();
        // ② item 墓碑:idea2 挂 topic2,软删进回收站 → 彻底删(item tombstone + cascade)。
        let i2 = notes::capture(&mut a.conn, &mut a.clock, "会被彻底删的想法").unwrap();
        let t2 = notes::create_topic(&mut a.conn, &mut a.clock, "留存标签").unwrap();
        notes::file_to_topic(&mut a.conn, &mut a.clock, &i2, Some(&t2), None).unwrap();
        notes::archive(&mut a.conn, &mut a.clock, &i2).unwrap();
        notes::purge(&mut a.conn, &mut a.clock, &i2).unwrap();
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();

        // 两处父墓碑 link 都不该被审计误拒:合法快照必须导得进。
        let mut b = peer("linktomb-b");
        import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap();
        assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_some());
        // 存活标签 t2 还在(它没被删),i1 也在(只是没了标签)。
        let n: i64 = b.conn.query_row("SELECT COUNT(*) FROM topics WHERE id = ?1", [&t2], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    /// 纪元源遗留形态回归(真机验收 2026-07-09 实弹抓到的误拒):70(0022)引入 observed
    /// 之前的 link_remove 不带该 key——严格 OR-set 下它覆盖不了任何 add,审计会把早已删掉
    /// 的关联算成「日志存活」、误拒合法快照(现场:表 15 条 vs 日志存活 17 条)。修后语义:
    /// 遗留 remove 覆盖一切更低 HLC 的同关联 add;比它晚的 add(去了再打回)不受影响。
    /// 严格纪元翻转(epoch-plan §3.1,原正例 `import_accepts_legacy_link_remove_without_observed`):
    /// 64→70 窗口期不带 observed 的 link_remove 曾是「只随快照到达」的合法史实,压实把
    /// 它消灭之后 boot 与 live 同拒——遗留宽语义(覆盖一切更低 HLC 的 add)分支已删,
    /// 「作弊伪装成 legacy」的不可区分洞随分类问题一起消灭。
    #[test]
    fn import_rejects_legacy_link_remove_without_observed() {
        let mut a = peer("legacyrm-a");
        let task = task::create(&mut a.conn, &mut a.clock, "挂过标签的任务", None, None, None).unwrap();
        let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
        task::add_topic(&mut a.conn, &mut a.clock, &task, &topic).unwrap();
        // 手工重演遗留 remove_topic:删行 + 发不带 observed 的 link_remove
        // (payload 形态照真实库遗留 op:只有 item_id/topic_id 两键)。
        a.conn
            .execute("DELETE FROM item_topic WHERE item_id = ?1 AND topic_id = ?2", [&task, &topic])
            .unwrap();
        let hlc = a.clock.tick(&a.conn).unwrap();
        let seq: i64 = a
            .conn
            .query_row(
                "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
                [hlc.device_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        a.conn
            .execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'link', ?3, 'link_remove', ?4, ?5)",
                rusqlite::params![
                    ulid::Ulid::new().to_string(),
                    hlc.encode(),
                    format!("{task}:{topic}"),
                    format!(r#"{{"item_id":"{task}","topic_id":"{topic}"}}"#),
                    seq
                ],
            )
            .unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("legacyrm-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("observed 必带且为字符串数组"),
            "遗留无 observed 形态在严格纪元必拒(先压实再当源):{err}");
        assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none(), "整体回滚不留痕");
    }

    /// codex 复审修复项①:`{"observed":null}` 不是遗留形态——json_type 区分「缺 key」
    /// (遗留)与显式 JSON null(伪造)。显式 null 走严格 OR-set(覆盖不了任何 add),
    /// 行又被删了 = 终态与日志不符,恶意快照必须拒。
    #[test]
    fn import_rejects_json_null_observed_as_legacy() {
        let mut a = peer("nullobs-a");
        let task = task::create(&mut a.conn, &mut a.clock, "挂过标签的任务", None, None, None).unwrap();
        let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
        task::add_topic(&mut a.conn, &mut a.clock, &task, &topic).unwrap();
        a.conn
            .execute("DELETE FROM item_topic WHERE item_id = ?1 AND topic_id = ?2", [&task, &topic])
            .unwrap();
        let hlc = a.clock.tick(&a.conn).unwrap();
        let seq: i64 = a
            .conn
            .query_row(
                "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
                [hlc.device_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        a.conn
            .execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'link', ?3, 'link_remove', ?4, ?5)",
                rusqlite::params![
                    ulid::Ulid::new().to_string(),
                    hlc.encode(),
                    format!("{task}:{topic}"),
                    format!(r#"{{"item_id":"{task}","topic_id":"{topic}","observed":null}}"#),
                    seq
                ],
            )
            .unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("nullobs-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        // bedrock-fix §9:shape 审计(audit_op_shapes)先于 OR-set 语义审计拦下——显式 null
        // observed 不是合法形态,与 apply_link 同口径(非字符串 observed 整条拒),引导侧也拒。
        assert!(err.contains("observed 必带且为字符串数组"), "显式 null 不是合法 observed,shape 审计必须拒:{err}");
    }

    /// codex 复审第四弹:`{"observed":[null]}`——`NOT IN` 遇 NULL 元素按 SQL 三值逻辑
    /// 把**所有** add 判死,恶意快照可借此删行过审。存活集已改 NOT EXISTS +
    /// `je.value = a.op_id`(NULL 永不相等),[null] 覆盖不了任何 add → add 存活、行
    /// 又被删了 = 不符,拒。
    #[test]
    fn import_rejects_observed_array_with_null() {
        let mut a = peer("nullelem-a");
        let task = task::create(&mut a.conn, &mut a.clock, "挂过标签的任务", None, None, None).unwrap();
        let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
        task::add_topic(&mut a.conn, &mut a.clock, &task, &topic).unwrap();
        a.conn
            .execute("DELETE FROM item_topic WHERE item_id = ?1 AND topic_id = ?2", [&task, &topic])
            .unwrap();
        let hlc = a.clock.tick(&a.conn).unwrap();
        let seq: i64 = a
            .conn
            .query_row(
                "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
                [hlc.device_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        a.conn
            .execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'link', ?3, 'link_remove', ?4, ?5)",
                rusqlite::params![
                    ulid::Ulid::new().to_string(),
                    hlc.encode(),
                    format!("{task}:{topic}"),
                    format!(r#"{{"item_id":"{task}","topic_id":"{topic}","observed":[null]}}"#),
                    seq
                ],
            )
            .unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("nullelem-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        // bedrock-fix §9:shape 审计先于 OR-set——[null] 不是合法 observed(与 apply_link
        // 同口径:非字符串元素整条拒),引导侧在语义重算之前就拦下。
        assert!(err.contains("observed 必带且为字符串数组"), "[null] 不是合法 observed,shape 审计必须拒:{err}");
    }

    // ---- bedrock-fix §9:引导审计对齐 replay 的对抗测试(坏快照必拒;legacy/合法仍收) ----

    /// 手插一条原始 op(造单机正道插不出的作弊 op;origin_seq 顺号补齐)。
    fn inject_raw_op(conn: &Connection, clock: &mut Clock, entity: &str, entity_id: &str, kind: &str, payload: &str) {
        let hlc = clock.tick(conn).unwrap();
        let seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
                [hlc.device_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![ulid::Ulid::new().to_string(), hlc.encode(), entity, entity_id, kind, payload, seq],
        )
        .unwrap();
    }

    /// 实现审 H1:「无 create、tombstone **晚于**依赖 op」的日志——live 逐条应用在
    /// 低 seq 的 set_field 上撞「行缺失且无墓碑」永久挂起(高 seq 的 tombstone 被队尾
    /// 堵死),boot 若靠「存在任意 tombstone」豁免就放它进来 = audit⟺replay 差分。
    /// 顺带阳性对照:合法 purge 流(create<set<tombstone)在其它测试(certify/引导
    /// 全形态)恒放行。
    #[test]
    fn import_rejects_dependent_op_with_only_later_tombstone() {
        let mut a = peer("latertomb-a");
        notes::capture(&mut a.conn, &mut a.clock, "让快照非空").unwrap();
        let x = ulid::Ulid::new().to_string();
        // 无 create:先 set_field、后 tombstone(终态无行、无背书)。
        inject_raw_op(&a.conn, &mut a.clock, "item", &x, "set_field",
            r#"{"field":"content","value":"幽灵"}"#);
        inject_raw_op(&a.conn, &mut a.clock, "item", &x, "tombstone", "{}");
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("latertomb-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("孤儿"), "tombstone 晚于依赖 op 不算豁免:{err}");
        assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none(), "整体回滚不留痕");
    }

    /// 实现审 H2:position 自严格纪元起入 LWW 语义审计——「日志 LWW 赢家说 A、表里
    /// 是 B」的库必须被拒(修前 position 被显式豁免,静默终态分叉可穿透供货/创号/
    /// 导入三闸)。
    #[test]
    fn import_rejects_position_lww_divergence() {
        let mut a = peer("posdiv-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        // 追加一条更高 HLC 的合法 frindex position set_field,但不改行——LWW 赢家 ≠ 表列。
        inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field",
            r#"{"field":"position","value":"zz"}"#);
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("posdiv-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("position") || err.contains("LWW") || err.contains("不符"),
            "position 语义分叉必须拒:{err}");
    }

    /// #2:link_add 的 entity_id 与 payload 指向不同配对 —— apply_link 拒、旧审计不管。
    #[test]
    fn import_rejects_link_entity_id_payload_mismatch() {
        let mut a = peer("linkmis-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "link",
            &format!("{task}:{topic}"),
            "link_add",
            &format!(r#"{{"item_id":"{task}","topic_id":"01JZZZZZZZZZZZZZZZZZZZZZZZ"}}"#),
        );
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("linkmis-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("entity_id 与 payload 不一致"), "link entity_id 错配必须拒:{err}");
    }

    /// #7:伪造 created_at 的 set_field —— 已知词汇但协议禁 set(史实字段),归型
    /// InvalidOp 而非「未知字段」的 UnsupportedVocab(typed poison §4:版本偏斜挂起
    /// 自愈,毒 op 隔离,两者绝不能混)。
    #[test]
    fn import_rejects_forbidden_created_at_set_field() {
        let mut a = peer("createdat-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "item",
            &task,
            "set_field",
            r#"{"field":"created_at","value":"2000-01-01T00:00:00.000Z"}"#,
        );
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("createdat-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("协议禁 set_field"), "created_at set_field 必须拒:{err}");
    }

    /// codex Q5:未知字段 set_field —— 审计遍历固定字段看不见,replay 立即 Err。
    #[test]
    fn import_rejects_unknown_set_field() {
        let mut a = peer("unkfield-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"never_existed","value":1}"#);
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("unkfield-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("不认识的字段"), "未知字段 set_field 必须拒:{err}");
    }

    /// #6:image_add 元数据 mime 不在白名单 —— apply_image_add 拒、旧审计只比 seq。
    #[test]
    fn import_rejects_image_add_bad_mime() {
        let mut a = peer("badmime-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        let img = ulid::Ulid::new().to_string();
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "image",
            &img,
            "image_add",
            &format!(r#"{{"item_id":"{task}","seq":1,"mime":"image/svg+xml","bytes":3,"sha256":"{}"}}"#, "a".repeat(64)),
        );
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("badmime-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("mime 不在白名单"), "image_add 坏 mime 必须拒:{err}");
    }

    /// #3:同一 item 两条 create —— apply_item_create 撞行即 Err,旧审计取 HLC-max 分叉。
    #[test]
    fn import_rejects_duplicate_item_create() {
        let mut a = peer("dupcreate-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "item",
            &task,
            "create",
            r#"{"content":"重复出生","stage":"todo","created_at":"2000-01-01T00:00:00.000Z","born_stage":"todo"}"#,
        );
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("dupcreate-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("重复 create"), "重复 create 必须拒:{err}");
    }

    /// codex 二审:image_add.sha256 与实际字节不符 —— bulk copy 从不验货。
    #[test]
    fn import_rejects_corrupted_image_bytes() {
        let mut a = peer("badbytes-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        images::attach(&mut a.conn, &mut a.clock, &task, &[1, 2, 3], "image/png").unwrap();
        // item_image 不可 UPDATE(只追加/删除),故删行后重插一条 data 不符其 image_add
        // sha256 的行(等价于「字节被篡改」的坏快照)。
        let (img, seq, mime, created): (String, i64, String, String) = a
            .conn
            .query_row("SELECT id, seq, mime, created_at FROM item_image", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        a.conn.execute("DELETE FROM item_image WHERE id = ?1", [&img]).unwrap();
        a.conn
            .execute(
                "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![img, task, seq, vec![9u8, 9, 9], mime, created],
            )
            .unwrap();
        a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("badbytes-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("sha256"), "篡改的图字节必须被 hash 验出:{err}");
    }

    /// codex 二审:快照携带 origin==导入端 device_id 的 op —— 替新端伪造「本机历史」。
    #[test]
    fn import_rejects_self_origin_injection() {
        let mut b = peer("selforigin-b");
        let mut a = peer("selforigin-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        // 伪造 hlc:取真 hlc 前缀(时间戳+计数器,前 23 字符)拼上导入端 b 的 device_id 后缀。
        let real = a.clock.tick(&a.conn).unwrap().encode();
        let forged_hlc = format!("{}{}", &real[..23], b.device_id);
        a.conn
            .execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'item', ?3, 'set_field', ?4, 1)",
                rusqlite::params![
                    ulid::Ulid::new().to_string(),
                    forged_hlc,
                    task,
                    r#"{"field":"content","value":"伪造"}"#
                ],
            )
            .unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("伪造本机历史"), "self-origin 注入必须拒:{err}");
    }

    /// B(codex 二审):item set_field 值越出列 CHECK 域(priority 99)——boot 只校终态,
    /// live 按 seq 逐条应用会在列 CHECK 处 Err;这里先于 LWW 拦下。
    #[test]
    fn import_rejects_set_field_out_of_domain() {
        let mut a = peer("domain-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"priority","value":99}"#);
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("domain-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        // 值域现由共享 validate_op_shape 在 op-shape 层拦下(先于 LWW,winner/输家一视同仁)。
        assert!(err.contains("priority 期待"), "越域 set_field(shape 层值域)必须拒:{err}");
    }

    /// C(codex 二审):孤儿 set_field(指向无 create/行/tombstone 的实体)——live 会挂起。
    #[test]
    fn import_rejects_orphan_set_field() {
        let mut a = peer("orphan-sf-a");
        task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        let phantom = ulid::Ulid::new().to_string();
        inject_raw_op(&a.conn, &mut a.clock, "item", &phantom, "set_field", r#"{"field":"content","value":"孤儿"}"#);
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("orphan-sf-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("无行且无 tombstone"), "孤儿 set_field 必须拒:{err}");
    }

    /// D(codex 二审):孤儿 link(entity_id 与 payload 一致但父实体不存在)——apply_link 挂起。
    #[test]
    fn import_rejects_orphan_link() {
        let mut a = peer("orphan-link-a");
        task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        let pi = ulid::Ulid::new().to_string();
        let pt = ulid::Ulid::new().to_string();
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "link",
            &format!("{pi}:{pt}"),
            "link_add",
            &format!(r#"{{"item_id":"{pi}","topic_id":"{pt}"}}"#),
        );
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("orphan-link-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("无行且无 tombstone"), "孤儿 link 必须拒:{err}");
    }

    /// E(codex 二审):图字节长度与 image_add.bytes 声明不符(与 hash 独立的验货,先于 hash)。
    #[test]
    fn import_rejects_image_length_mismatch() {
        let mut a = peer("imglen-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        images::attach(&mut a.conn, &mut a.clock, &task, &[1, 2, 3], "image/png").unwrap();
        let (img, seq, mime, created): (String, i64, String, String) = a
            .conn
            .query_row("SELECT id, seq, mime, created_at FROM item_image", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        a.conn.execute("DELETE FROM item_image WHERE id = ?1", [&img]).unwrap();
        // 长度改成 2(op 声明 bytes=3):E 先于 hash 拦下。
        a.conn
            .execute(
                "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![img, task, seq, vec![1u8, 2], mime, created],
            )
            .unwrap();
        a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("imglen-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("字节长度与"), "图字节长度不符必须拒:{err}");
    }

    /// A 反例(codex 二审):position 浮点非 legacy int,boot 也拒(与 live opt_str_field 同口径)。
    #[test]
    fn import_rejects_position_float() {
        let mut a = peer("posfloat-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"position","value":1.5}"#);
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("posfloat-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("position 期待"), "position 浮点必须拒:{err}");
    }

    /// 严格纪元翻转(epoch-plan §3.1,原正例 `import_accepts_legacy_int_position`):
    /// 0021 前的整数 position op 曾是 boot 容忍的合法史实,压实把它消灭之后 boot 与
    /// live 同拒(position 必为 frindex 文本键,镜像 0022 单列 CHECK)。
    #[test]
    fn import_rejects_legacy_int_position() {
        let mut a = peer("posint-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"position","value":5}"#);
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("posint-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("position 期待合法 frindex 键"),
            "整数 position 在严格纪元必拒(先压实再当源):{err}");
    }

    /// codex 二审 2:同 origin set-before-create(低 seq set_field、高 seq create,终态有行)
    /// ——boot 的「存在」审计过,但 live 先应用 set_field 撞「行缺失」挂起、create 被队尾堵死。
    /// 因果序审计(create.hlc < dependent.hlc)拦下。
    #[test]
    fn import_rejects_set_before_create() {
        let mut a = peer("setbefore-a");
        let x = ulid::Ulid::new().to_string();
        // 先 set_field(低 hlc),再 create(高 hlc):create 因果晚于它的 set_field。
        inject_raw_op(&a.conn, &mut a.clock, "item", &x, "set_field", r#"{"field":"content","value":"先改后生"}"#);
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "item",
            &x,
            "create",
            r#"{"content":"X","stage":"todo","created_at":"2026-01-01T00:00:00.000Z","born_stage":"todo"}"#,
        );
        // 手插 X 的行(让「存在」审计通过,只留因果序拦截)。
        a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        a.conn
            .execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, \
                                    due_on, priority, position, sealed_at, born_stage) \
                 VALUES (?1, 'X', 'todo', 't0', 't0', NULL, NULL, NULL, 'a0', NULL, 'todo')",
                [&x],
            )
            .unwrap();
        a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("setbefore-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("set-before-create"), "set-before-create 必须拒:{err}");
    }

    /// codex 二审 3:两张图都声明近上限 seq——撞号顺延越过 MAX_IMAGE_SEQ,effective_seqs 报错;
    /// boot 与 live 共用它故同拒(不封则 counter 被抬过上限、下次 attach 的 +1 失败成本地 DoS)。
    #[test]
    fn import_rejects_image_seq_overflow() {
        let mut a = peer("imgseq-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        let sha = "a".repeat(64);
        let max = images::MAX_IMAGE_SEQ;
        for _ in 0..2 {
            let img = ulid::Ulid::new().to_string();
            inject_raw_op(
                &a.conn,
                &mut a.clock,
                "image",
                &img,
                "image_add",
                &format!(r#"{{"item_id":"{task}","seq":{max},"mime":"image/png","bytes":3,"sha256":"{sha}"}}"#),
            );
        }
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("imgseq-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("超上限"), "撞号越上限必须拒:{err}");
    }

    /// epoch-plan §1 第 3 条:纪元压实丢弃死图的 add(字节已删,sha 无从重算),编号洞
    /// 由原样保留的 counter 表承载——counter 合法**高于**日志派生高水位,审计判据由
    /// `==` 放宽为 `>=`(不放宽会拒掉自己压实后的合法库);counter **低于**派生值仍必拒
    /// (删图不回摆,低 = 伪造/损坏)。
    #[test]
    fn import_counter_above_log_watermark_is_legal_below_is_not() {
        let mut a = peer("cntr-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        images::attach(&mut a.conn, &mut a.clock, &task, &[1, 2], "image/png").unwrap();
        // 模拟压实后形态:曾有更高编号的图被彻底删除、其 add 不进新账本,counter 留洞。
        a.conn.execute_batch("INSERT INTO sync_replay_active (flag) VALUES (1);").unwrap();
        a.conn
            .execute("UPDATE item_image_counter SET last_seq = 5 WHERE item_id = ?1", [&task])
            .unwrap();
        a.conn.execute_batch("DELETE FROM sync_replay_active;").unwrap();
        let snap = make_snapshot(&a.conn, &a.dir).unwrap();
        let mut b = peer("cntr-b");
        import_snapshot(&mut b.conn, &mut b.clock, &snap.path)
            .expect("counter 高于日志派生高水位是压实后的合法形态");
        // 反向:再挂一图(得号 6)后删除——日志派生高水位 6,把 counter 压回 1 = 伪造,必拒。
        let (img2, _) = images::attach(&mut a.conn, &mut a.clock, &task, &[3, 4], "image/png").unwrap();
        images::remove(&mut a.conn, &mut a.clock, &img2).unwrap();
        a.conn.execute_batch("INSERT INTO sync_replay_active (flag) VALUES (1);").unwrap();
        a.conn
            .execute("UPDATE item_image_counter SET last_seq = 1 WHERE item_id = ?1", [&task])
            .unwrap();
        a.conn.execute_batch("DELETE FROM sync_replay_active;").unwrap();
        let snap2 = raw_snapshot(&a.conn, &a.dir);
        let mut b2 = peer("cntr-b2");
        let err = import_snapshot(&mut b2.conn, &mut b2.clock, &snap2.path).unwrap_err();
        assert!(err.contains("日志高水位"), "counter 低于派生高水位必拒:{err}");
    }

    /// 严格纪元翻转(epoch-plan §3.1,原正例 `import_accepts_legacy_image_without_sha256`):
    /// 0024 前无 sha256 的 image_add 曾是 boot 容忍的合法史实——压实对现存字节现算 sha
    /// 合成带 hash 的基线 add,存量无 sha 形态消灭,boot 与 live 同拒(收下没法验货的图
    /// 本就是承认的洞)。单机正道产不出无 sha 的 op,故手工造。
    #[test]
    fn import_rejects_legacy_image_without_sha256() {
        let mut a = peer("nosha-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        let img = ulid::Ulid::new().to_string();
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "image",
            &img,
            "image_add",
            &format!(r#"{{"item_id":"{task}","seq":1,"mime":"image/png","bytes":3}}"#),
        );
        a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        a.conn
            .execute(
                "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) VALUES (?1,?2,1,?3,'image/png','t0')",
                rusqlite::params![img, task, vec![1u8, 2, 3]],
            )
            .unwrap();
        a.conn
            .execute(
                "INSERT INTO item_image_counter (item_id, last_seq) VALUES (?1, 1) \
                 ON CONFLICT(item_id) DO UPDATE SET last_seq = max(last_seq, 1)",
                [&task],
            )
            .unwrap();
        a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("nosha-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("sha256 必带"),
            "无 sha 的 image_add 在严格纪元必拒(先压实再当源):{err}");
    }

    /// codex 二审:create(position="!")后被合法 position 覆盖、终态合法——共享 shape 层必须拒
    /// (position 单列 CHECK 非豁免,live 在 create INSERT 当场撞;boot 不镜像即分歧)。
    #[test]
    fn import_rejects_bad_create_position() {
        let mut a = peer("badpos-a");
        let x = ulid::Ulid::new().to_string();
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "item",
            &x,
            "create",
            r#"{"content":"X","stage":"todo","created_at":"2026-01-01T00:00:00.000Z","born_stage":"todo","position":"!"}"#,
        );
        inject_raw_op(&a.conn, &mut a.clock, "item", &x, "set_field", r#"{"field":"position","value":"a1"}"#);
        a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        a.conn
            .execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, \
                                    due_on, priority, position, sealed_at, born_stage) \
                 VALUES (?1, 'X', 'todo', 't0', 't0', NULL, NULL, NULL, 'a1', NULL, 'todo')",
                [&x],
            )
            .unwrap();
        a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("badpos-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("frindex 键形态"), "非法 create position 必须拒:{err}");
    }

    /// codex 二审:同 origin set→create→tombstone,终态只剩墓碑——tombstone 不再豁免因果序
    /// (live 仍卡在低 seq 的 set 上,create/tombstone 被队尾堵死)。
    #[test]
    fn import_rejects_set_before_create_even_if_tombstoned() {
        let mut a = peer("sbct-a");
        let x = ulid::Ulid::new().to_string();
        inject_raw_op(&a.conn, &mut a.clock, "item", &x, "set_field", r#"{"field":"content","value":"先改"}"#);
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "item",
            &x,
            "create",
            r#"{"content":"X","stage":"todo","created_at":"2026-01-01T00:00:00.000Z","born_stage":"todo"}"#,
        );
        inject_raw_op(&a.conn, &mut a.clock, "item", &x, "tombstone", "{}");
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("sbct-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("set-before-create"), "set→create→tombstone 必须拒:{err}");
    }

    /// codex 二审 3:非法 priority 输家(priority=99 后被更高 HLC 的合法 priority=2 覆盖、终态
    /// 匹配合法赢家)——证明共享 shape 层拒输家,不靠 LWW/终态。
    #[test]
    fn import_rejects_domain_loser() {
        let mut a = peer("loser-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"priority","value":99}"#);
        inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"priority","value":2}"#);
        a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        a.conn.execute("UPDATE items SET priority = 2 WHERE id = ?1", [&task]).unwrap();
        a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
        let snap = raw_snapshot(&a.conn, &a.dir);
        let mut b = peer("loser-b");
        let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
        assert!(err.contains("priority 期待"), "非法 domain 输家(shape 层)必须拒:{err}");
    }

    /// codex 二审 4:本地 counter 已达 MAX 时 attach——原子拒(Err),counter 不动、无行、无 op。
    #[test]
    fn attach_rejects_at_max_seq() {
        let mut a = peer("attachmax-a");
        let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
        let max = images::MAX_IMAGE_SEQ;
        a.conn
            .execute("INSERT INTO item_image_counter (item_id, last_seq) VALUES (?1, ?2)", rusqlite::params![task, max])
            .unwrap();
        let before: i64 = a.conn.query_row("SELECT COUNT(*) FROM oplog WHERE entity='image'", [], |r| r.get(0)).unwrap();
        let err = images::attach(&mut a.conn, &mut a.clock, &task, &[1, 2, 3], "image/png").unwrap_err();
        assert!(err.contains("上限"), "counter 达上限 attach 必须拒:{err}");
        let counter: i64 =
            a.conn.query_row("SELECT last_seq FROM item_image_counter WHERE item_id=?1", [&task], |r| r.get(0)).unwrap();
        assert_eq!(counter, max, "越界 attach 不应改动 counter");
        let rows: i64 =
            a.conn.query_row("SELECT COUNT(*) FROM item_image WHERE item_id=?1", [&task], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "越界 attach 不应留行");
        let after: i64 = a.conn.query_row("SELECT COUNT(*) FROM oplog WHERE entity='image'", [], |r| r.get(0)).unwrap();
        assert_eq!(after, before, "越界 attach 不应发 op");
    }

    // ---- 压轴:配对 + 引导 + 引导后互通(双实例、两真 SQLite、内存桥) ----

    struct SyncPeer {
        p: Peer,
        engine: Engine,
        outbox: VecDeque<Msg>,
    }

    impl SyncPeer {
        fn collect(&mut self, outs: Vec<Output>) {
            for o in outs {
                match o {
                    Output::Send { msg, .. } => self.outbox.push_back(msg),
                    Output::Event(e) => panic!("互通阶段不该出事件:{e:?}"),
                }
            }
        }
    }

    /// 两实例互喂到静默(两端 outbox 皆空)。to 恒是对方(双设备账户,广播即定向)。
    fn pump(x: &mut SyncPeer, y: &mut SyncPeer) {
        let mut guard = 0;
        loop {
            guard += 1;
            assert!(guard < 10_000, "pump 不收敛(死循环?)");
            if let Some(msg) = x.outbox.pop_front() {
                let outs = y
                    .engine
                    .on_msg(&mut y.p.conn, &mut y.p.clock, &x.p.device_id, msg)
                    .unwrap();
                y.collect(outs);
                continue;
            }
            if let Some(msg) = y.outbox.pop_front() {
                let outs = x
                    .engine
                    .on_msg(&mut x.p.conn, &mut x.p.clock, &y.p.device_id, msg)
                    .unwrap();
                x.collect(outs);
                continue;
            }
            return;
        }
    }

    /// convergence.rs 同款指纹(items 刨 updated_at 本地簿记)。
    const FINGERPRINTS: &[(&str, &str)] = &[
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
            "item_image",
            "SELECT id||'|'||item_id||'|'||seq||'|'||mime||'|'||hex(data) FROM item_image ORDER BY id",
        ),
        ("item_image_counter", "SELECT item_id||'|'||last_seq FROM item_image_counter ORDER BY item_id"),
        ("oplog", "SELECT op_id||'|'||hlc||'|'||origin_seq FROM oplog ORDER BY op_id"),
    ];

    fn fingerprint(conn: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = conn.prepare(sql).unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    #[test]
    fn paired_then_bootstrapped_instances_converge_end_to_end() {
        // ---- 老端 A:既有账户,数据全形态。 ----
        let mut ap = peer("e2e-a");
        let idea = notes::capture(&mut ap.conn, &mut ap.clock, "老端灵感").unwrap();
        let topic = notes::create_topic(&mut ap.conn, &mut ap.clock, "共同话题").unwrap();
        notes::file_to_topic(&mut ap.conn, &mut ap.clock, &idea, Some(&topic), None).unwrap();
        let a_task = task::create(&mut ap.conn, &mut ap.clock, "老端任务", None, Some(1), None).unwrap();
        images::attach(&mut ap.conn, &mut ap.clock, &a_task, &[7, 7], "image/png").unwrap();

        // ---- 新端 B:配对前已有本地数据(引导是并集,不丢)。 ----
        let mut bp = peer("e2e-b");
        let b_idea = notes::capture(&mut bp.conn, &mut bp.clock, "新端本地灵感").unwrap();
        let b_topic = notes::create_topic(&mut bp.conn, &mut bp.clock, "共同话题").unwrap();
        notes::file_to_topic(&mut bp.conn, &mut bp.clock, &b_idea, Some(&b_topic), None).unwrap();

        // ---- §6.1 配对:SPAKE2 对跑(测试即服务器盲桥,逐字节透传)。 ----
        let mut k_acc = [0u8; 32];
        use chacha20poly1305::aead::rand_core::RngCore;
        chacha20poly1305::aead::OsRng.fill_bytes(&mut k_acc);
        let account_id = Ulid::new().to_string();
        let secret = gen_secret();
        let slot = 424_242_424u64;
        let grant_in = AccountGrant {
            account_id: account_id.clone(),
            k_acc: k_acc.to_vec(),
            server_url: "wss://sync.zhujian.app/ws".into(),
        };
        let (_seed, pubkey) = gen_device_key();
        let enroll_in = DeviceEnroll { device_id: bp.device_id.clone(), pubkey: pubkey.to_vec() };
        let mut opener = Opener::new(slot, &secret, grant_in);
        let mut joiner = Joiner::new(slot, &secret, enroll_in);

        let mut to_joiner: VecDeque<Vec<u8>> = VecDeque::new();
        let mut to_opener: VecDeque<Vec<u8>> = VecDeque::new();
        for out in opener.on_joined().unwrap() {
            match out {
                PairOutput::Send(b) => to_joiner.push_back(b),
                other => panic!("{other:?}"),
            }
        }
        let mut registered: Option<(String, [u8; 32])> = None;
        let mut granted: Option<AccountGrant> = None;
        while granted.is_none() {
            if let Some(blob) = to_joiner.pop_front() {
                for out in joiner.on_msg(&blob).unwrap() {
                    match out {
                        PairOutput::Send(b) => to_opener.push_back(b),
                        // §4 账户闸停点(Grant→gate→Enroll):本测试即刻放行。
                        PairOutput::GrantPending { .. } => {
                            for a in joiner.approve().unwrap() {
                                match a {
                                    PairOutput::Send(b) => to_opener.push_back(b),
                                    other => panic!("{other:?}"),
                                }
                            }
                        }
                        PairOutput::Granted(g) => granted = Some(g),
                        other => panic!("{other:?}"),
                    }
                }
                continue;
            }
            let blob = to_opener.pop_front().expect("配对停摆");
            for out in opener.on_msg(&blob).unwrap() {
                match out {
                    PairOutput::Send(b) => to_joiner.push_back(b),
                    PairOutput::Register { device_id, pubkey } => {
                        // 老端拿到设备材料 → 发 register_device;服务器回 Registered。
                        registered = Some((device_id, pubkey));
                        for out in opener.on_registered().unwrap() {
                            match out {
                                PairOutput::Send(b) => to_joiner.push_back(b),
                                PairOutput::Finished => {}
                                other => panic!("{other:?}"),
                            }
                        }
                    }
                    other => panic!("{other:?}"),
                }
            }
        }
        let (reg_dev, reg_pub) = registered.expect("opener 必须走到 Register");
        assert_eq!(reg_dev, bp.device_id);
        assert_eq!(reg_pub.to_vec(), pubkey.to_vec());
        let grant = granted.unwrap();
        assert_eq!(grant.account_id, account_id);
        assert_eq!(grant.k_acc, k_acc.to_vec());
        // 配对交付的钥就是账户钥:B 用它封的帧,A 用原钥解得开(P2-g 全链的钥源)。
        let addr = FrameAddr {
            account_id: &account_id,
            from_device: &bp.device_id,
            to: BROADCAST,
            domain: Domain::Op,
        };
        let sealed = crypto::seal_msg(
            &grant.k_acc.as_slice().try_into().unwrap(),
            &addr,
            &Msg::Want { origin: "o".into(), from_seq: 1 },
        );
        assert!(crypto::open_msg::<Msg>(&k_acc, &addr, &sealed).is_ok());

        // ---- §6.2 引导:快照流 + 导入。 ----
        check_fresh_to_account(&bp.conn).expect("新端 fresh");
        let snap = make_snapshot(&ap.conn, &ap.dir).unwrap();
        let mut sender = BootSender::new(&snap).unwrap();
        let Some(BootMsg::Offer { transfer, bytes, sha256 }) = sender.next_msg().unwrap() else {
            panic!("首帧必须是 Offer");
        };
        let mut recv = BootReceiver::start(&bp.dir, &ap.device_id, &transfer, bytes, &sha256).unwrap();
        let mut done = ChunkOutcome::More;
        while let Some(BootMsg::Chunk { transfer, idx, last, data }) = sender.next_msg().unwrap() {
            done = recv.on_chunk(&ap.device_id, &transfer, idx, last, &data).unwrap();
        }
        assert_eq!(done, ChunkOutcome::Complete);
        import_snapshot(&mut bp.conn, &mut bp.clock, recv.path()).unwrap();
        std::fs::remove_file(recv.path()).unwrap();
        std::fs::remove_file(&snap.path).unwrap();

        // ---- 引导后互通:重建引擎(boot.rs 模块注释的接线契约)+ hello 互补。 ----
        let a_engine = Engine::new(&ap.conn, BlobPolicy::Full).unwrap();
        let b_engine = Engine::new(&bp.conn, BlobPolicy::Full).unwrap();
        let mut a = SyncPeer { p: ap, engine: a_engine, outbox: VecDeque::new() };
        let mut b = SyncPeer { p: bp, engine: b_engine, outbox: VecDeque::new() };
        let outs = a.engine.on_connected(&a.p.conn).unwrap();
        a.collect(outs);
        let outs = b.engine.on_connected(&b.p.conn).unwrap();
        b.collect(outs);
        pump(&mut a, &mut b);

        // 引导后 B 再写一笔,实时广播也通(outbound 走 last_pushed 游标)。
        let late = notes::capture(&mut b.p.conn, &mut b.p.clock, "引导后的新灵感").unwrap();
        notes::file_to_topic(&mut b.p.conn, &mut b.p.clock, &late, Some(&b_topic), None).unwrap();
        let outs = b.engine.outbound(&b.p.conn).unwrap();
        b.collect(outs);
        pump(&mut a, &mut b);

        // ---- 终局:五表 + oplog 指纹逐行相等、水位相等、同名标签两枚、体检通过。 ----
        for (name, sql) in FINGERPRINTS {
            assert_eq!(
                fingerprint(&a.p.conn, sql),
                fingerprint(&b.p.conn, sql),
                "表 {name} 两端不一致"
            );
        }
        let wm = |c: &Connection| -> Vec<(String, i64)> {
            let mut stmt = c
                .prepare("SELECT origin, MAX(origin_seq) FROM oplog GROUP BY origin ORDER BY origin")
                .unwrap();
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(wm(&a.p.conn), wm(&b.p.conn), "per-origin 水位必须相等");
        assert_eq!(wm(&a.p.conn).len(), 2, "两台设备两个 origin");
        let dup: i64 = b
            .p
            .conn
            .query_row("SELECT COUNT(*) FROM topics WHERE title = '共同话题'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dup, 2, "同名标签并存,由用户手动合并收敛");
        for c in [&a.p.conn, &b.p.conn] {
            let verdict: String = c.pragma_query_value(None, "integrity_check", |r| r.get(0)).unwrap();
            assert_eq!(verdict, "ok");
        }
    }
}
