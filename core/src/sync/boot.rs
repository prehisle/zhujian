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
//! **导入完成后调用方必须装配 `Engine` 并走一次中转会话仪式**(P2-g 接线契约;
//! 256 起 = `EngineSlot::reconcile` + `on_relay_session_up`):
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
    // 派生数据不上路(299 codex 实现审 M1):`VACUUM INTO` 是**整库**复制,会把 0032 的
    // 缩略图派生表一起装进快照。收端 `import_attached` 不导入它,所以「不进表级导入」
    // 是真的——但字节照样被哈希、分块、加密、传输、落到收端临时文件,最后才被丢弃,
    // 还白占 [`MAX_SNAPSHOT_BYTES`] 的额度。image-perf-plan §0 拍板的「不进引导」要的
    // 是这件事本身不发生,故在这里就地剥掉。
    // 顺序:先剥再 hash——`bytes`/`sha256` 必须描述**最终**那个文件。
    if let Err(e) = strip_derived_from_snapshot(&path) {
        let _ = std::fs::remove_file(&path);
        return Err(e);
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

/// 把快照文件里的**纯本地派生数据**剥干净(299 codex 实现审 M1)。
///
/// 只对**刚由 `VACUUM INTO` 产出的临时文件**做,不碰源库:那个文件此刻只有我们一个
/// 持有者,故这里的原地 `VACUUM` 不受 `ops_serve` 那条「在制 work 期间禁止原地 VACUUM」
/// 的约束(它约束的是**活着的空间库**)。
///
/// 删行之后必须再 `VACUUM` 一次:`DELETE` 只把页还给 freelist,那些页照样要被哈希、
/// 传输——不收掉就等于没剥。
///
/// **新增纯本地派生表时,这里要跟着加一行**;漏了不会有任何测试变红,除非你也在
/// `snapshot_carries_no_derived_rows` 里加一格(那只测按表名逐张点名)。
fn strip_derived_from_snapshot(path: &Path) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| format!("打开快照剥派生数据失败:{e}"))?;
    conn.execute_batch("DELETE FROM item_image_thumb; VACUUM;")
        .map_err(|e| format!("剥快照里的派生数据失败:{e}"))
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
    let (orphan_items, orphan_topics, orphan_links, orphan_images, orphan_comments) =
        count_unbacked_rows(conn)?;
    if orphan_items + orphan_topics + orphan_links + orphan_images + orphan_comments > 0 {
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
///   已可信提交,但**禁止在原 Connection 上 `relay_session_up`/继续会话**,调用方必须
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
        None => return Err("快照缺 device_id(不是朱简同步库?)".into()),
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
    // device profile 多实例寄存器同样**双侧独立预审**(identity-plan §2.1):理由与上面
    // 逐字相同——绝不让下方的表级复制顺手把既有损坏搬过来再让 battery 误过。
    audit_device_profile_semantics(&tx, "", "本机")?;
    audit_device_profile_semantics(&tx, "boot.", "快照")?;
    // 留言同样**双侧独立预审**(identity-plan §4.3 第 6 条):理由与上面两只逐字相同。
    audit_comment_semantics(&tx, "", "本机")?;
    audit_comment_semantics(&tx, "boot.", "快照")?;
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
                                due_on, priority, position, sealed_at, born_stage, done_at, \
                                born_device) \
             SELECT id, content, stage, created_at, updated_at, archived_at, \
                    due_on, priority, position, sealed_at, born_stage, done_at, \
                    born_device FROM boot.items",
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
    // 留言(identity-plan §4.3 第 6 条):**排在 items 之后**(FK 父先子)。
    // 它是 **boot 正表**——进表级导入、进 strict_battery 审计、进 spaces::CORE_TABLES;
    // **不得**进 strip_derived_from_snapshot(那是给纯本地派生表 item_image_thumb 的
    // 剥离步,与本表性质相反)。
    // ⚠ 行数**刻意不进 [`ImportReport`]**(identity-plan §4.3 第 17 条,设计审二轮拍明):
    // 引导回执面只报四类主体,加一格就要在两壳 UI 各说一次。**这是刻意省略,不是漏。**
    tx.execute(
        "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
         SELECT id, item_id, content, created_at, born_device FROM boot.item_comment",
        [],
    )
    .map_err(|e| format!("导入 item_comment 失败:{e}"))?;
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
    // device profile **多实例合并**(identity-plan §2.1;codex 301 实现审一轮 M1)。
    //
    // 这里原先走的是表级复制,论证是「两侧同时有某个 device_id 的行 = 前提被破坏,撞
    // PRIMARY KEY 响亮失败」。那个论证**过强**:[`crate::identity::set_device_alias`] 有意
    // **不锁本机**(名册是账户内共享的,给别台设备改名是合法操作),而 fresh 闸只排除
    // **他人 origin** 的 op、本机 op 是许的——于是「新端在引导前给快照里那台设备写过一行」
    // 两侧都合法,表复制当场撞 PK、整个引导失败。今天两端 UI 都只传 this_device 够不着这
    // 条路,但护栏是「调用方自律」而不是结构,且 §2.3 的真名单、§5 的移除设备一做出来就
    // 够得着了。
    //
    // 改成与上面 space_profile 同一手法:从**合并后**的日志按 HLC 赢家 UPSERT。它不依赖
    // 「两侧不相交」这个假设,且与 [`audit_device_profile_semantics`] 的「值不符」判据
    // **逐字同口径**(同样 `ORDER BY hlc DESC LIMIT 1`),天生不会自己跟自己打架;只在快照
    // 有 / 只在本机有 / 两侧都有,三种情形一条 SQL 全覆盖。快照那张表不再被直接复制,但
    // 仍受上方 `"boot."` 侧预审把关(值必须与快照自己的日志一致),验它 + 从日志重建是
    // 双保险,不是重复。
    // (行数不进 ImportReport:那份报告是给用户看的「导入了多少内容」,设备名册是元数据。)
    tx.execute(
        "INSERT INTO device_profile (device_id, alias) \
         SELECT o.entity_id, \
                (SELECT json_extract(w.payload, '$.value') FROM oplog w \
                  WHERE w.entity = 'device' AND w.entity_id = o.entity_id \
                    AND w.kind = 'set_field' \
                  ORDER BY w.hlc DESC LIMIT 1) \
           FROM (SELECT DISTINCT entity_id FROM oplog WHERE entity = 'device') o \
          WHERE true \
             ON CONFLICT(device_id) DO UPDATE SET alias = excluded.alias",
        [],
    )
    .map_err(|e| format!("物化 device_profile 失败:{e}"))?;

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
    // 绝不发布/激活/relay_session_up 一个完整性已失败的库。显式点名 main(unqualified
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
        // 留言的墓碑同样 sticky(0035):删了就是删了,快照里不许还有行。
        (
            "comment",
            "SELECT COUNT(*) FROM item_comment WHERE id IN              (SELECT entity_id FROM oplog WHERE entity = 'comment' AND kind = 'tombstone')",
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
/// born_stage / born_device 是**不可变**列,却照样在这里:这张表实际审的是「表列 ==
/// 日志 LWW 赢家」,而不可变列的 winner 恒 = create 初值(它们的 set_field 被协议禁),
/// 于是这条审计对它们退化成「行上的出生史实 == create op 说的出生史实」——正是该审的。
/// pre-0033 的老行两边都是 NULL,`IS` 比较相等,不误报(identity-plan §3.4 原写「不加」,
/// 理由「不可变列不参与 LWW」与既有 born_stage 的事实不符,按 born_stage 同款加)。
const ITEM_LWW_FIELDS: &[&str] = &[
    "content", "stage", "created_at", "due_on", "priority", "archived_at", "sealed_at",
    "born_stage", "position", "done_at", "born_device",
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
    // ⑦ device profile 多实例寄存器双向不变量(identity-plan §2.1,0033)。
    audit_device_profile_semantics(live, "", "本库")?;
    // ⑧ 条目留言的三向不变量(identity-plan §4.3 第 6 条,0035)。
    audit_comment_semantics(live, "", "本库")?;
    Ok(())
}

/// 条目留言的语义审计(identity-plan §4.3 第 6 条,0035)。三条判据:
///
/// 1. **行有 create op 背书**(无背书的行 = 全网只此一份还自以为同步了);
/// 2. **create op 有行** —— 除非 ①该 comment 自己有 tombstone,**或 ②它的
///    `payload.item_id` 已有 item tombstone**;
/// 3. 行上四列与 create payload **逐字相等**。
///
/// ⚠️ **第 2 条那个 ② 例外是设计审一轮 H2 抓出来的,不是可选的宽松**:留言随 item 的
/// FK CASCADE 一起消失时**不发 comment tombstone**(§4.4,照 topic_tombstone 对 link 的
/// 处置),于是「有 comment create、无行、无 comment tombstone、有 item tombstone」是
/// **健康**终态。少了这个例外,**第一次删掉带留言的条目之后,那个库的 strict_battery
/// 就恒红** —— 供快照 / 引导 / 压实前三条路全挂。晚到的 create 走 `ParentGone` 后是同一终态。
///
/// 没有「LWW 赢家比对」那一条:留言**不可编辑**,没有 `set_field`,行一旦落下就再不变
/// (`trg_comment_immutable` 在存储层兜底)。
///
/// `prefix` 复用于快照侧(`"boot."`)与本库侧(`""`),同 device/space 两只。
fn audit_comment_semantics(conn: &Connection, prefix: &str, who: &str) -> Result<(), String> {
    let one = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    let unbacked = one(&format!(
        "SELECT COUNT(*) FROM {prefix}item_comment c WHERE NOT EXISTS ( \
             SELECT 1 FROM {prefix}oplog o \
             WHERE o.entity = 'comment' AND o.kind = 'create' AND o.entity_id = c.id)"
    ))?;
    if unbacked > 0 {
        return Err(format!(
            "comment 语义审计({who}):{unbacked} 条留言无 create op 背书(行在无 op),整体回滚"
        ));
    }
    let missing = one(&format!(
        "SELECT COUNT(*) FROM ( \
             SELECT DISTINCT o.entity_id AS cid FROM {prefix}oplog o \
             WHERE o.entity = 'comment' AND o.kind = 'create' \
               AND NOT EXISTS (SELECT 1 FROM {prefix}oplog t WHERE t.entity = 'comment' \
                                AND t.entity_id = o.entity_id AND t.kind = 'tombstone') \
               AND NOT EXISTS (SELECT 1 FROM {prefix}oplog it WHERE it.entity = 'item' \
                                AND it.kind = 'tombstone' \
                                AND it.entity_id = json_extract(o.payload, '$.item_id'))) c \
         WHERE NOT EXISTS (SELECT 1 FROM {prefix}item_comment r WHERE r.id = c.cid)"
    ))?;
    if missing > 0 {
        return Err(format!(
            "comment 语义审计({who}):{missing} 条有 create、宿主未死、自身未 tombstone 的留言无行(快照与日志矛盾),整体回滚"
        ));
    }
    // 逐字相等:born_device 用 IS(NULL 安全比较)——json_extract 取到 JSON null 得 SQL NULL,
    // 与列上的 NULL(作者未知,跨空间搬迁而来)必须算相等。
    let mismatch = one(&format!(
        "SELECT COUNT(*) FROM {prefix}item_comment c WHERE NOT EXISTS ( \
             SELECT 1 FROM {prefix}oplog o \
             WHERE o.entity = 'comment' AND o.kind = 'create' AND o.entity_id = c.id \
               AND json_extract(o.payload, '$.item_id') = c.item_id \
               AND json_extract(o.payload, '$.content') = c.content \
               AND json_extract(o.payload, '$.created_at') = c.created_at \
               AND json_extract(o.payload, '$.born_device') IS c.born_device)"
    ))?;
    if mismatch > 0 {
        return Err(format!(
            "comment 语义审计({who}):{mismatch} 条留言的行内容与自身 create op 不符(状态与日志矛盾),整体回滚"
        ));
    }
    Ok(())
}

/// device profile **多实例**寄存器的双向语义审计(identity-plan §2.1,0033)。
///
/// 与 [`audit_space_profile_semantics`] 同构,差别只在「一行」变成「每 device_id 一行」:
/// 某设备**有 op ⇔ 有行**,且 `alias` IS 该设备全部 op 里 HLC 最大那条的 value(**含 null**
/// ——显式清名的规范表示)。行在无 op / op 在行缺 / 值不符 三向都拒。
///
/// `prefix` 复用于快照侧(`"boot."`——attached 库的 CHECK/PK 可被篡改,故不信 schema、
/// 实查词汇与坐标)与本库侧(`""`);`who` 只进话术。
fn audit_device_profile_semantics(
    conn: &Connection,
    prefix: &str,
    who: &str,
) -> Result<(), String> {
    let one = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    // 词汇合规(NULL 语义:json_extract 缺键、篡改 schema 的 attached 库列为 NULL 时
    // `<>` 三值逻辑不计入——全部 COALESCE 后照拒,同 space 的 codex 实现审 L)。
    // **坐标**这里不是固定字面量,而是「必须是规范 device_id」——挡的是非规范 id 白得
    // 一行(**不是行数**,见 replay 那臂:合法 ULID 要多少有多少),快照侧尤其不能只靠
    // 表 CHECK。
    let bad_ops = one(&format!(
        "SELECT COUNT(*) FROM {prefix}oplog WHERE entity = 'device' AND ( \
             COALESCE(kind, '') <> 'set_field' \
             OR COALESCE(json_extract(payload, '$.field'), '') <> 'alias' \
             OR length(COALESCE(entity_id, '')) <> 26 \
             OR COALESCE(entity_id, '') GLOB '*[^0-9A-Z]*')"
    ))?;
    if bad_ops > 0 {
        return Err(format!(
            "device 语义审计({who}):{bad_ops} 条 device op 词汇/坐标非法(寄存器只认 set_field/alias,entity_id 须为规范 device_id),整体回滚"
        ));
    }
    let bad_rows = one(&format!(
        "SELECT COUNT(*) FROM {prefix}device_profile \
         WHERE length(COALESCE(device_id, '')) <> 26 OR COALESCE(device_id, '') GLOB '*[^0-9A-Z]*'"
    ))?;
    if bad_rows > 0 {
        return Err(format!(
            "device 语义审计({who}):{bad_rows} 行 device_profile 的 device_id 非规范形,整体回滚"
        ));
    }
    // 行在无 op:每行必须有至少一条自己的 device op 背书。
    let unbacked = one(&format!(
        "SELECT COUNT(*) FROM {prefix}device_profile p WHERE NOT EXISTS ( \
             SELECT 1 FROM {prefix}oplog o \
             WHERE o.entity = 'device' AND o.entity_id = p.device_id)"
    ))?;
    if unbacked > 0 {
        return Err(format!(
            "device 语义审计({who}):{unbacked} 行 device_profile 无任何 device op 背书(行在无 op),整体回滚"
        ));
    }
    // op 在行缺:有 op 的设备必须有行(alias=NULL 的清名也是「有行」)。
    let missing = one(&format!(
        "SELECT COUNT(*) FROM (SELECT DISTINCT entity_id FROM {prefix}oplog \
             WHERE entity = 'device') o \
         WHERE NOT EXISTS ( \
             SELECT 1 FROM {prefix}device_profile p WHERE p.device_id = o.entity_id)"
    ))?;
    if missing > 0 {
        return Err(format!(
            "device 语义审计({who}):{missing} 台设备有 device op 但 device_profile 无行(op 在行缺),整体回滚"
        ));
    }
    // 值不符:逐行比「表列 IS 该设备日志的 HLC 最大赢家」(含 null)。
    let mismatch = one(&format!(
        "SELECT COUNT(*) FROM {prefix}device_profile p WHERE NOT (p.alias IS ( \
             SELECT json_extract(payload, '$.value') FROM {prefix}oplog \
             WHERE entity = 'device' AND entity_id = p.device_id AND kind = 'set_field' \
             ORDER BY hlc DESC LIMIT 1))"
    ))?;
    if mismatch > 0 {
        return Err(format!(
            "device 语义审计({who}):{mismatch} 行 device_profile.alias 与日志 LWW 赢家不符(状态与日志矛盾),整体回滚"
        ));
    }
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
    let (items, topics, links, images, comments) = count_unbacked_rows(live)?;
    if items + topics + links + images + comments > 0 {
        return Err(format!(
            "导入后语义审计:存在无 op 背书的行(item {items} / topic {topics} / link {links} / image {images} / comment {comments})\
            ——严格纪元下每行必有恰一条 create/link_add/image_add 背书(pre-0020 遗产先在锚点压实),整体回滚"
        ));
    }
    Ok(())
}

/// 无 op 背书的现存行计数(items/topics/item_topic/item_image/item_comment 五表)。
/// 两处消费者、同一判据:`check_fresh_to_account` 的判据 (b)(legacy 只能当首台)与
/// `audit_create_multiplicity` 的「恰一条」下半(§3.2)——判据必须单一来源,否则
/// fresh 闸与导入审计对「什么算无背书」各说各话。
pub(crate) fn count_unbacked_rows(
    conn: &Connection,
) -> Result<(i64, i64, i64, i64, i64), String> {
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
        // 0035:无 create 背书的留言同样要在**请求快照前**就被拦下,不是传完整库之后才失败。
        one(
            "SELECT COUNT(*) FROM item_comment WHERE id NOT IN \
             (SELECT entity_id FROM oplog WHERE entity = 'comment' AND kind = 'create')",
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
    // comment create 的宿主前置(identity-plan §4.3 第 14 条,设计审一轮 H3):与 image_add
    // 逐字同型。少了它能构造出「boot 批量复制过得去、live 顺序回放**永久 DependencyMissing**」
    // 的快照——批量复制不看依赖,而 live 按 origin_seq 逐条应用会在孤儿 comment 上挂住。
    let orphan_comment: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM oplog o WHERE o.entity='comment' AND o.kind='create' \
             AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = json_extract(o.payload,'$.item_id')) \
             AND NOT EXISTS (SELECT 1 FROM oplog x WHERE x.entity='item' \
                              AND x.entity_id = json_extract(o.payload,'$.item_id') \
                              AND (x.kind='create' OR (x.kind='tombstone' AND x.hlc < o.hlc)))",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if orphan_comment > 0 {
        return Err(format!(
            "导入后语义审计:{orphan_comment} 条 comment create 的宿主无行且无更早 tombstone(孤儿,live 挂起),整体回滚"
        ));
    }
    // 因果序:宿主 item 的 create 必须 HLC 早于 comment create(tombstone 不豁免,同上)。
    let bad_comment_order: i64 = live
        .query_row(
            "SELECT COUNT(*) FROM oplog o WHERE o.entity='comment' AND o.kind='create' \
             AND EXISTS (SELECT 1 FROM oplog ci WHERE ci.entity='item' AND ci.entity_id=json_extract(o.payload,'$.item_id') AND ci.kind='create' AND ci.hlc >= o.hlc)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if bad_comment_order > 0 {
        return Err(format!(
            "导入后语义审计:{bad_comment_order} 条 comment create 的宿主 create 晚于它(live 挂起),整体回滚"
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
mod tests;
