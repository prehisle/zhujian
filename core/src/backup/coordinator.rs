//! 备份准入状态机(backup-plan §3.4.1 第 7 维 + §6.4)——**本模块是备份的唯一入口**。
//!
//! # ⛔ 为什么门开在 core 而不是壳里
//!
//! 笔①-b(自动备份)**不会走桌面命令层**:它是个后台定时器,直接调引擎。若把「同一时刻
//! 只许一趟」的门开在壳的命令函数里,那一天它就等于没门(§3.4.1 原话)。⇒ 所有备份与清扫
//! 入口一律经这里,**不许旁路**。
//!
//! # 它要盖住的四对(一轮只写了第三对)
//!
//! | 对 | 结果 |
//! |---|---|
//! | 备份 vs 备份 | `BackupBusy` |
//! | 清扫 vs 清扫 | `CleanupBusy` |
//! | 备份 vs 清扫 | 谁在跑就拒谁的对家(**重试清扫会删掉正在用的那份快照** —— 这一对是本类存在的直接理由) |
//! | panic / 取消之后 | 活动态**必须复位**:准入是 RAII 发的([`Admitted`] 的 `Drop`),unwind 也归位 |
//!
//! # 锁序(与 `WriterLease` 正交,没有锁环)
//!
//! ```text
//! WriterLease 已由 app 持有(lib.rs setup,持到进程退出)
//!    → coordinator 取操作准入
//!    → 跑 backup 或 cleanup
//!    → 释放操作准入
//! ```
//!
//! ⛔ **绝不在 coordinator 内部再去申请 `WriterLease`** —— 那才会造出环。
//!
//! # `Blocked` 只是状态、不持锁(所以没有死锁式 UX)
//!
//! `Blocked` + 备份 = 立即拒;`Blocked` + 重试 + 空闲 = **允许**进 `Cleaning`(这一格就是
//! 「想清扫要先等备份、备份因为 Blocked 又起不来」那种担心的解)。
//! ⛔ 解除 `Blocked` 的**只有** [`BackupCoordinator::retry_cleanup`](完整重扫,三条同时
//! 成立才回 Ready);⛔ 不许给用户一个「忽略」按钮把它点掉,⛔ 备份自己也不许顺手重扫解封。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use super::auto;
use super::config::{self, ConfigError};
use super::engine::{self, Artifact, BatchFatal};
use super::restore::RestoreStage;
use super::staging;
use super::ReadError;
use crate::spaces::SpaceCatalog;

/// 三处路径的域。⛔ **必须与 `WriterLease` 一一对应**(§3.4 那张表)——
/// e2e(`YS_DB_PATH`)下 `main_db.parent()` 是 `/tmp`,多个测试进程会共享同一个
/// `/tmp/.backup-staging` 却各持不同租约,一个进程能删掉另一个正在用的明文快照。
/// ⇒ e2e 三处**全部按库派生**,见 [`BackupPaths::for_db`]。
#[derive(Debug, Clone)]
pub struct BackupPaths {
    /// `.backup.json`(**明文备份钥**住这儿)。
    pub config_path: PathBuf,
    /// `.backup-auto.json`(自动备份的开关 / 频率 / 份数 / 运行痕迹 / **本机产出账**)。
    /// ⛔ **刻意与上面那份分开**(backup-plan §15.4):钥文件一辈子写两次,这份每天写一次;
    /// 而且给 `.backup.json` 加字段会让**旧版朱简把它判成坏配置**(`deny_unknown_fields`
    /// 是双向的),那条路的 UI 是「别重新设置」+ 备份完全不可用。
    pub auto_path: PathBuf,
    /// 明文临时快照的落点(0700)。
    pub staging: PathBuf,
    /// 还没配过时显示 / 首次仪式用的默认落点。
    pub default_dir: PathBuf,
    /// 主库路径(catalog 枚举用)。
    pub main_db: PathBuf,
    /// 空间扫描目录;`None` = e2e 模式(只有主库一个空间)。
    pub scan_dir: Option<PathBuf>,
}

impl BackupPaths {
    /// 生产:`.backup.json` 落 app **配置**目录(与 `.hotkeys.json` 同族),
    /// staging 与默认落点落**数据**目录(与库同卷 —— `VACUUM INTO` 免跨盘拷)。
    ///
    /// ⚠ 默认落点 `<数据目录>/backups` **与主库同盘**:它挡得住同步 purge,
    /// **给不了设备灾难耐久性**(§5.2)。别在文案里把它说成"有备份了"。
    pub fn production(config_dir: &Path, data_dir: &Path, main_db: &Path) -> BackupPaths {
        BackupPaths {
            config_path: config_dir.join(".backup.json"),
            auto_path: config_dir.join(".backup-auto.json"),
            staging: data_dir.join(".backup-staging"),
            default_dir: data_dir.join("backups"),
            main_db: main_db.to_path_buf(),
            scan_dir: Some(data_dir.to_path_buf()),
        }
    }

    /// e2e(`YS_DB_PATH`):三处**全按库派生**,与 `<db>.writer.lock` 那条租约同域。
    /// ⛔ 绝不碰真实用户配置 / 真实 staging(会清掉用户的真残留)。
    pub fn for_db(main_db: &Path) -> BackupPaths {
        let side = |suffix: &str| PathBuf::from(format!("{}{suffix}", main_db.display()));
        BackupPaths {
            config_path: side(".backup.json"),
            auto_path: side(".backup-auto.json"),
            staging: side(".backup-staging"),
            default_dir: side(".backups"),
            main_db: main_db.to_path_buf(),
            scan_dir: None,
        }
    }
}

// ---- 对外的状态与结果(壳只认这几个形)-------------------------------------------

/// 备份目录里的一份**候选**文件 —— 只有盘上事实。
///
/// ⛔ **刻意没有「有效 / 无效」这一格**:§3.3 收口那条义务写死了「文件名 / 扩展名绝不能当
/// 『这是一份有效备份』的判据」。要状态就得调 [`BackupCoordinator::verify_backup`] 真解一遍;
/// 类型里不给这一格 = 「想当然地标成有效」在**编译期**就写不出来。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupEntry {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    /// 文件改动时刻(Unix 毫秒);取不到就是 `None`,⛔ 不编一个。
    pub modified_ms: Option<u64>,
}

/// 一趟恢复的产出(§16)。⭐ **它是「一个未配置的新空间」,不是"你的库回来了、原样在原处"**
/// —— UI 的话术要照 §16.11 那六条诚实边界说,⛔ 别暗示它覆盖了什么或接回了旧账户。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredSpace {
    /// 新空间的 ULID(全新的;⛔ **不是**备份里那个 space_id)。
    pub space_id: String,
    pub path: String,
    /// 备份里那个空间叫什么(trailer)。⚠ v1 刻意**不自动改名** ⇒ 同机恢复后两个空间同名。
    pub source_space_name: Option<String>,
    /// 这份备份是什么时候取的(RFC3339 UTC;本地时间由前端转)。
    pub created_at: String,
    /// 恢复出来的库的新设备身份。
    pub device_id: String,
    /// 已发布,但暂存名没清掉 —— ⛔ **不是失败**(下次启动 sweep 再清一次名字)。
    pub cleanup_error: Option<String>,
}

/// 验过之后才拿得到的那几格(全部来自 trailer,不是从文件名猜的)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedBackup {
    pub space_id: String,
    pub space_name: Option<String>,
    pub created_at: String,
    pub app_version: String,
    pub plain_bytes: u64,
}

/// 正在跑的是哪一件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    Backup,
    Cleanup,
    /// ⭐ **第三个活动态,424 加的**(backup-plan §16.7)。419 写过「⛔ 不给 `Busy` 加第三态
    /// (不为只读列表动评审过的状态机)」—— **那条判据不适用于恢复**:`list_backups` /
    /// `verify_backup` 是只读的,而恢复**写数据目录、造明文整库、与启动清扫抢同一个 staging
    /// 域**。它是第三种**破坏性**入口,不进准入的话 §3.4.1 第 7 维那条(「重试清扫会删掉
    /// 正在用的那份快照」)对恢复原样复发。
    Restore,
}

impl Busy {
    fn label(self) -> &'static str {
        match self {
            Busy::Backup => "备份",
            Busy::Cleanup => "清扫",
            Busy::Restore => "恢复",
        }
    }
}

/// 设置面要显示的当前态。
#[derive(Debug, Clone)]
pub struct BackupStatus {
    /// 走完仪式、钥已落稳。
    pub configured: bool,
    /// 当前落点(没配过时 = 默认落点,给用户看它将会落在哪)。
    pub dir: String,
    /// 暂存区封锁原因(`Some` = 备份被封锁,只有「重试清扫」能解)。
    pub blocked: Option<String>,
    /// 有一趟操作在跑。
    pub busy: Option<Busy>,
    /// 仪式进行中(码已显示、还没回输核对)。
    pub awaiting_ceremony: bool,
    /// 配置坏了 / 上次写盘死在半路 —— ⛔ 这两种**不许**当"没配过"重来一次。
    pub problem: Option<String>,
}

/// 一份产出的备份。
#[derive(Debug, Clone)]
pub struct BackupMade {
    pub space_id: String,
    pub path: String,
    pub bytes: u64,
}

/// 盘上留下的那个文件处于哪一态。⛔ **两种都不得计作一份备份**。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Leftover {
    /// 写完了但**没验过**(流程被更严重的失败打断)。它可能完全可用,
    /// 但「成功」两个字这一趟给不出。
    Unverified(String),
    /// **验不过、又删不掉**。
    Invalid(String),
}

/// 一个空间这一趟的失败。
#[derive(Debug, Clone)]
pub struct BackupFailed {
    pub space_id: String,
    pub message: String,
    pub leftover: Option<Leftover>,
}

/// 一趟备份的结果。⭐ **三件事要同时看得见**:此前的成功、当前这个失败、剩余没跑。
#[derive(Debug, Clone)]
pub struct BackupReport {
    pub made: Vec<BackupMade>,
    pub failed: Vec<BackupFailed>,
    /// 剩余**根本没跑**的空间数(有 fatal 时才可能非零)。UI 必须与"跑了但失败"显著区分。
    pub skipped: usize,
    /// 整批停下的原因。
    pub fatal: Option<String>,
    /// 这一趟之后暂存区是不是被封锁了(明文删不掉)。
    pub blocked: Option<String>,
}

/// 自动备份这一 tick 的结论。⭐ **三态刻意分开**:`Skipped` 不该弹任何提示(它是正常),
/// `Refused` 与「跑了但有失败」才弹(§15.2)。
#[derive(Debug)]
pub enum AutoTick {
    /// 正常地什么都没做。
    Skipped(AutoSkip),
    /// 真跑了一趟。
    Ran(AutoRun),
    /// 这一趟被拒(封锁态 / 配置坏 / 目标目录不可用……)——**要让用户看见**。
    Refused(String),
}

/// 为什么这一 tick 什么都没做。**每一种都不是故障。**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoSkip {
    /// 开关没开。
    Disabled,
    /// 还没到点。
    NotDue,
    /// 还没设置过备份(没有钥就没有可自动的东西)。
    NotConfigured,
    /// 用户正在走备份码仪式。
    CeremonyPending,
    /// 有别的操作在跑 —— ⭐ 自动**绝不排队**,下一 tick 再看。
    Busy(Busy),
}

/// 真跑了一趟的结果。
#[derive(Debug)]
pub struct AutoRun {
    pub report: BackupReport,
    /// 逐空间的轮转结果(⛔ 只收**有话要说**的那些:全静默的空间不进这张表)。
    pub rotations: Vec<SpaceRotation>,
    /// 一句人话结论(与落进 `.backup-auto.json` 的 `last_result` 是同一句)。
    pub summary: String,
}

/// 一个空间的轮转结果。⭐ **四类分开**,⛔ 别在 UI 上收成一句"清理完成"。
#[derive(Debug)]
pub struct SpaceRotation {
    pub space_id: String,
    /// 真删掉的旧备份路径。
    pub removed: Vec<String>,
    /// **摘账**了、从此不再自动管(已证明无效 / 身份变了 / 落点改过)。
    pub unmanaged: Vec<(String, String)>,
    /// 留账下轮再试(瞬时 IO / 删不掉 / 读不到文件身份)。
    pub retry: Vec<(String, String)>,
    /// `Some` = **这个空间这一轮零删除**(当前产物复验没过)。
    pub stalled: Option<String>,
}

/// 自动备份的当前态(设置面那一节)。
#[derive(Debug, Clone)]
pub struct AutoStatus {
    pub enabled: bool,
    pub every_minutes: u32,
    pub keep: u32,
    /// UTC RFC3339;⚠ **本地时间由前端 `Date` 转**(`time` 在多线程进程里取不到本地偏移)。
    pub last_success_at: Option<String>,
    pub last_result: Option<String>,
    /// 设置文件坏了 / 值越界 —— 自动备份已停下(手动不受影响)。
    pub problem: Option<String>,
    /// ⭐ 进程内那枚待读通知,**取走即清**(设计审 H5)。
    pub pending_notice: Option<String>,
    /// **已交还给用户**的产物:`(完整路径, 人话原因)`。⛔ **与 `pending_notice` 相反,
    /// 读了不清** —— 它是一张"待你处置"的清单,不是一次性通知;文件被处置掉(不在盘上了)
    /// 之后它自己会在下一趟轮转时消失。
    /// ⚠ 420 补的真机验收撞出来的:此前这份信息**只有计数进了 `last_result`,路径只到 stderr**,
    /// 用户知道"有 3 份不再自动管",却不知道**是哪三份**。
    pub released: Vec<(String, String)>,
    /// 上一趟「删不掉、下轮再试」的那几份(每趟替换)。
    pub retry: Vec<(String, String)>,
}

/// 把设置文件里那两张清单翻成 `(完整路径, 原因)`。
/// `only_existing` = 只显示还在盘上的那些(交还清单用;`retry` 是上一趟的快照,原样显示)。
fn notes(list: &[auto::Released], only_existing: bool) -> Vec<(String, String)> {
    list.iter()
        .map(|r| (Path::new(&r.dir).join(&r.file), r.why.clone()))
        .filter(|(p, _)| !only_existing || p.exists())
        .map(|(p, why)| (p.display().to_string(), why))
        .collect()
}

/// 一句人话结论。⛔ 别把「轮转停滞」这种事只放进那条每进程弹一次的 banner ——
/// 它要**持久**留在 `last_result` 里(设计审四弹 M2)。
fn summarize(report: &BackupReport, rotations: &[SpaceRotation]) -> String {
    let mut parts = vec![format!("备好 {} 个空间", report.made.len())];
    if !report.failed.is_empty() {
        parts.push(format!("失败 {} 个", report.failed.len()));
    }
    if report.skipped > 0 {
        parts.push(format!("还有 {} 个根本没跑", report.skipped));
    }
    if let Some(f) = &report.fatal {
        parts.push(format!("整批停下:{f}"));
    }
    let removed: usize = rotations.iter().map(|r| r.removed.len()).sum();
    if removed > 0 {
        parts.push(format!("清掉 {removed} 份旧备份"));
    }
    let stalled = rotations.iter().filter(|r| r.stalled.is_some()).count();
    if stalled > 0 {
        parts.push(format!("{stalled} 个空间这轮没清理(刚备好的那份复验没过)"));
    }
    let unmanaged: usize = rotations.iter().map(|r| r.unmanaged.len()).sum();
    if unmanaged > 0 {
        parts.push(format!("{unmanaged} 份旧文件从此不再自动管"));
    }
    let retry: usize = rotations.iter().map(|r| r.retry.len()).sum();
    if retry > 0 {
        parts.push(format!("{retry} 份下次再试"));
    }
    parts.join(" · ")
}

/// 备份入口的失败。**每一种都要能被 UI 分开认领**(fail-fast:别退化成一句"操作失败")。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupError {
    /// 这次**备份**请求被拒:有一趟别的操作在跑。
    BackupBusy(Busy),
    /// 这次**清扫**请求被拒:有一趟别的操作在跑。
    CleanupBusy(Busy),
    /// 这次**恢复**请求被拒:有一趟别的操作在跑(§16.7 那张表的第三行)。
    /// ⛔ UI 必须明确认领这一格,不许退化成"操作失败"。
    RestoreBusy(Busy),
    /// 恢复没跑成。里面那句是 [`restore`](super::restore) 的**分档原话**
    /// (哪一幕 / 哪一格),⛔ 别在上层糊成一句"恢复失败"。
    RestoreFailed(String),
    /// 暂存区里还躺着明文,备份被封锁 —— 只有「重试清扫」能解。
    Blocked(String),
    /// 还没设置备份(该走仪式了)。**这不是故障**。
    NotConfigured,
    /// 仪式显示了码但还没回输核对。
    CeremonyPending,
    /// 没有正在进行的仪式(回输却没先要码)。
    NoCeremony,
    /// 回输的码对不上。
    CeremonyMismatch,
    /// 配置层(坏 / 半截 / 已设置过 / IO)。
    Config(String),
    /// 目标目录不可用。
    Target(String),
    /// catalog 枚举 / 四不变量失败 —— 连"有哪些空间"都不知道,后面全是猜。
    Catalog(String),
    /// 验一份已有备份没过。⚠ 里面那句是 `ReadError` 的原话,**四种读错各自分开**
    /// (结构 / 认证 / 长度哈希 / **不是这把钥**)—— 别在上层糊成一句"验证失败"。
    VerifyFailed(String),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::BackupBusy(b) => {
                write!(f, "现在有一趟{}在跑,等它结束再备份", b.label())
            }
            BackupError::CleanupBusy(b) => {
                write!(f, "现在有一趟{}在跑,等它结束再清扫", b.label())
            }
            BackupError::RestoreBusy(b) => {
                write!(f, "现在有一趟{}在跑,等它结束再恢复", b.label())
            }
            BackupError::RestoreFailed(m) => write!(f, "{m}"),
            BackupError::Blocked(m) => write!(f, "{m}"),
            BackupError::NotConfigured => write!(f, "还没设置备份:先生成并抄下备份码"),
            BackupError::CeremonyPending => {
                write!(f, "备份码还没核对完:把显示的码完整抄一遍输回去,才算设置好")
            }
            BackupError::NoCeremony => write!(f, "没有正在进行的备份码核对"),
            BackupError::CeremonyMismatch => {
                write!(f, "和显示的备份码对不上,请照着一字一字再抄一遍(这一步就是为了确认你真抄下了)")
            }
            BackupError::Config(m) => write!(f, "{m}"),
            BackupError::Target(m) => write!(f, "{m}"),
            BackupError::Catalog(m) => write!(f, "读不出这台机器上有哪些空间,整批没跑:{m}"),
            BackupError::VerifyFailed(m) => write!(f, "{m}"),
        }
    }
}

// ---- 状态机本体 -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Activity {
    Idle,
    Running(Busy),
}

/// 仪式进行中的那把钥。⭐ **只在进程内**:用户中途关掉面板 = 盘上什么都没变。
/// ⛔ 不另存一份"显示过的码"——码由这把钥现算,单一真相源(回输比对走同一支编码)。
struct Pending {
    key: [u8; 32],
    dir: PathBuf,
}

struct Inner {
    activity: Activity,
    /// **单调钟那把尺**(backup-plan §15.2):记的是「上一次**尝试**」不是「上一次成功」——
    /// ⛔ 只在成功时更新的话,一个持续失败的目标目录会让它**每 60 秒重跑一次整库**。
    /// 它兜的是「系统时钟被改 / `last_success_at` 落在未来」那一支,墙钟兜不住。
    last_attempt: Option<std::time::Instant>,
    /// ⭐ **进程内的待读通知**(设计审 H5):自动备份那趟的结论若**连盘都写不进去**,
    /// 它不可能把失败写进那个刚写失败的文件;而 `emit` 在主窗没开时会丢。
    /// ⇒ 留在这儿,由 UI **每次拉状态时主动取走看**。
    pending_notice: Option<String>,
    /// `Some` = 暂存区没清干净,备份封锁中(值 = 给用户看的原因)。
    blocked: Option<String>,
    pending: Option<Pending>,
}

/// 备份与清扫的唯一入口。壳建一只并 `manage`,**实例与一个 staging / lease 域一一绑定**;
/// ⛔ 不用全局静态锁,⛔ 不许对同一个 staging 建出两只。
pub struct BackupCoordinator {
    paths: BackupPaths,
    app_version: String,
    inner: Mutex<Inner>,
}

/// 操作准入。**RAII** —— 正常返回、`?` 早退、panic unwind,活动态都归 `Idle`
/// (那是四对里的第四对:「panic 或取消之后活动态要复位」)。
struct Admitted<'a> {
    coord: &'a BackupCoordinator,
}

impl Drop for Admitted<'_> {
    fn drop(&mut self) {
        self.coord.lock().activity = Activity::Idle;
    }
}

impl BackupCoordinator {
    /// 建一只。**不做任何 IO** —— 启动清扫另有 [`sweep_on_start`](必须在拿到
    /// `WriterLease` 之后才调,那时才排他、才敢删)。
    ///
    /// [`sweep_on_start`]: BackupCoordinator::sweep_on_start
    pub fn new(paths: BackupPaths, app_version: String) -> BackupCoordinator {
        BackupCoordinator {
            paths,
            app_version,
            inner: Mutex::new(Inner {
                activity: Activity::Idle,
                last_attempt: None,
                pending_notice: None,
                blocked: None,
                pending: None,
            }),
        }
    }

    /// ⭐ **中毒了照常用,这一处不 fail-fast**(412 实现审 M2)。判据两条,缺一不可:
    /// ①`Admitted` 的 `Drop` 也要取这把锁,而 `Drop` 跑在 **unwind 途中** —— 那里再 panic
    /// 就是**双重 panic = 整个 app abort**,比"活动态没复位"坏一个量级;
    /// ②[`Inner`] 里**没有跨字段的不变量**(三个各自独立的格),半途 unwind 留下的状态最坏
    /// 也只是「pending 还在 / 活动态没复位」,而那两样下一次调用就能自愈。
    /// ⛔ 别照抄到有不变量的表上 —— 那种地方中毒就该响亮。
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn admit(&self, want: Busy) -> Result<Admitted<'_>, BackupError> {
        let mut inner = self.lock();
        match inner.activity {
            Activity::Idle => {
                inner.activity = Activity::Running(want);
                Ok(Admitted { coord: self })
            }
            // ⭐ 报的是「**这次请求**被拒」,带上现在跑的是哪一件(§3.4.1 那张表)。
            Activity::Running(running) => Err(match want {
                Busy::Backup => BackupError::BackupBusy(running),
                Busy::Cleanup => BackupError::CleanupBusy(running),
                Busy::Restore => BackupError::RestoreBusy(running),
            }),
        }
    }

    /// 启动清扫(§3.4 第三层)。⚠ **调用方必须已持 `WriterLease`**。
    /// 返回 `Some(原因)` = 没清干净(或这一趟没跑成),备份自此封锁(壳把它响亮打到日志)。
    ///
    /// ⭐ **它也要走操作准入**(412 实现审 H2)。壳今天在 `manage` 之前调它,运行期确实撞不上;
    /// 但「唯一门」是本功能的**安全不变量**,不能靠"调用点碰巧安全"支撑 —— 这是个 `pub`
    /// 方法,谁在运行期误调一次,就能**删掉正在备份使用的那份快照**(§3.4.1 第 7 维那一对)。
    pub fn sweep_on_start(&self) -> Option<String> {
        let Ok(_admitted) = self.admit(Busy::Cleanup) else {
            // 启动期到不了这里;真到了说明有人在运行期误调 —— 响亮 + **真的封锁**
            //(暂存区没验过就不许再造明文),别只回一句话把状态留在"干净"。
            let msg = "有一趟备份或清扫正在跑,这次启动清扫没跑成 —— 暂存区状态未知,先封锁备份";
            self.lock().blocked = Some(msg.into());
            return Some(msg.into());
        };
        let clean = staging::sweep(&self.paths.staging);
        let msg = (!clean.is_ready()).then(|| clean.to_string());
        // ⛔ **只抬不放**(412 实现审二轮 M1):第一版写的是 `blocked = msg`,于是**再调一次
        // 且这次扫干净了,它就把封锁解了** —— 那是第二条解封路,与模块头注那条
        // 「解除 `Blocked` 的**只有** `retry_cleanup`」当场打架(而我还写了只测把它钉住)。
        // 启动那一刻 `blocked` 本就是 `None`,所以「只抬不放」在启动路径上一字不差;
        // 差别只在**运行期被误调**时 —— 那时它无权代替用户点那一下。
        if let Some(reason) = &msg {
            self.lock().blocked = Some(reason.clone());
        }
        msg
    }

    /// 设置面要显示的一切。
    pub fn status(&self) -> BackupStatus {
        let (blocked, busy, awaiting_ceremony) = {
            let inner = self.lock();
            let busy = match inner.activity {
                Activity::Idle => None,
                Activity::Running(b) => Some(b),
            };
            (inner.blocked.clone(), busy, inner.pending.is_some())
        };
        let (configured, dir, problem) = match config::load(&self.paths.config_path) {
            Ok(s) => (true, s.dir, None),
            Err(ConfigError::NotConfigured) => (false, self.paths.default_dir.clone(), None),
            // ⛔ 坏配置 / 半截写**不是**"没配过":UI 要显示原话并劝阻"重新设置一次"
            // (那会换一把钥,已有备份从此永远解不开)。
            Err(e) => (false, self.paths.default_dir.clone(), Some(e.to_string())),
        };
        BackupStatus {
            configured,
            dir: dir.display().to_string(),
            blocked,
            busy,
            awaiting_ceremony,
            problem,
        }
    }

    /// 仪式第一步:生成备份钥(**只在内存**)并返回要抄的码。
    ///
    /// ⚠ 目标目录**在这里就校验**(响亮:不存在 / 不是目录 / 写不进),别等到备份跑一半。
    /// ⛔ 已经设置过 / 配置坏了 / 上次写盘死在半路,一律拦在这里,**不许生成新钥**。
    pub fn begin_setup(&self, dir: Option<&str>) -> Result<String, BackupError> {
        // 仪式本身不碰 staging、也不产明文,故不占操作准入;但有操作在跑时不开始
        // (那时用户该等结果,不该被塞一把新钥)。这一格是原子的:整段在锁内。
        let mut inner = self.lock();
        if let Activity::Running(b) = inner.activity {
            return Err(BackupError::BackupBusy(b));
        }
        match config::load(&self.paths.config_path) {
            Ok(_) => {
                return Err(BackupError::Config(
                    "已经设置过备份了。换钥是另一件事(已有备份会解不开),v1 不提供".into(),
                ))
            }
            Err(ConfigError::NotConfigured) => {}
            Err(e) => return Err(BackupError::Config(e.to_string())),
        }
        let dir = match dir {
            Some(raw) => validated_dir(raw)?,
            None => {
                engine::prepare_target(&self.paths.default_dir)
                    .map_err(|f| BackupError::Target(f.to_string()))?;
                self.paths.default_dir.clone()
            }
        };
        let key = config::random_key().map_err(|e| BackupError::Config(e.to_string()))?;
        let code = crate::sync::crypto::crockford_encode32(&key);
        inner.pending = Some(Pending { key, dir });
        Ok(code)
    }

    /// 仪式第二步:回输核对。**对上了才落盘**(§5:⛔ 不许退化成勾「我已抄下」)。
    ///
    /// ⭐ 比对走 [`crockford_decode32`](与显示同一支编码的逆),不是字符串比 ——
    /// 大小写 / `-` / O↔0 / I↔1 这些抄录容错与将来真恢复时**同一口径**。
    /// ⛔ 落盘失败**不清 pending**:钥还没落稳,这时候当"没配过"下次再生成一把新的,
    /// 用户抄的旧码就对不上了(§6.3 那格最阴的 fatal)。
    ///
    /// ⛔ **整个仪式在一个临界区里做完(比对 + 落盘 + 清 pending),别为了"锁里不做 IO"
    /// 把它拆开**(412 实现审 H1):第一版正是「取出钥 → 放锁 → 落盘 → 无条件清 pending」,
    /// 于是有两条合法交错把承诺打穿 ——
    /// ①落盘途中来一发 `cancel_setup`,「取消了盘上就什么都没写」当场不成立;
    /// ②落盘途中来一发 `begin_setup`,用户眼前显示的是**新码 B**、盘上落的却是**旧钥 A**,
    /// 而末尾那句无条件清 pending 又把 B 抹掉 —— 用户抄了一把从不存在的钥。
    /// ⇒ 与 [`begin_setup`](BackupCoordinator::begin_setup) 同一条纪律:仪式类操作**允许**
    /// 在锁内做文件 IO(一次性、短、且没有回调进 coordinator 的路径)。
    pub fn confirm_setup(&self, typed: &str) -> Result<(), BackupError> {
        let mut inner = self.lock();
        let (key, dir) = match &inner.pending {
            None => return Err(BackupError::NoCeremony),
            Some(p) => (p.key, p.dir.clone()),
        };
        let got = crate::sync::crypto::crockford_decode32(typed)
            .map_err(|_| BackupError::CeremonyMismatch)?;
        if got != key {
            return Err(BackupError::CeremonyMismatch);
        }
        config::create(&self.paths.config_path, &dir, key)
            .map_err(|e| BackupError::Config(e.to_string()))?;
        inner.pending = None;
        Ok(())
    }

    /// 放弃仪式(关面板 / 点取消)。盘上什么都没写过,下次是干净的首次使用。
    pub fn cancel_setup(&self) {
        self.lock().pending = None;
    }

    /// 只改落点目录,不动钥。路径当场校验(§5.2)。
    pub fn set_dir(&self, dir: &str) -> Result<(), BackupError> {
        let dir = validated_dir(dir)?;
        {
            let inner = self.lock();
            if let Activity::Running(b) = inner.activity {
                return Err(BackupError::BackupBusy(b));
            }
        }
        config::set_dir(&self.paths.config_path, &dir).map_err(|e| match e {
            ConfigError::NotConfigured => BackupError::NotConfigured,
            other => BackupError::Config(other.to_string()),
        })
    }

    /// 跑一趟备份:**所有空间,逐空间串行**。
    ///
    /// preflight 全在循环之前(§6.4 第 1 条):封锁态 / 仪式 / 配置 / 目标目录 / catalog ——
    /// 任一不过就在这里 Err,一个文件都不产;进了循环之后走
    /// [`engine::backup_all`](**返回类型不是 `Result`**,从类型上消灭中途 `?`)。
    pub fn run_backup(&self) -> Result<BackupReport, BackupError> {
        let admitted = self.admit(Busy::Backup)?;
        let (batch, total, _settings) = self.run_batch(&admitted)?;
        Ok(self.finish_batch(batch, total))
    }

    /// preflight + 逐空间跑完。**手动与自动共用这一段**,⛔ 调用方必须已经持着准入 ——
    /// 那把准入要**一直持到轮转做完**(设计审一弹 H1:`Admitted` 一放开,用户就能合法
    /// `set_dir()`,于是「拿 A 目录的成功授权去删 B 目录的文件」)。
    fn run_batch(
        &self,
        _admitted: &Admitted<'_>,
    ) -> Result<(engine::BackupBatchResult, usize, config::BackupSettings), BackupError> {
        {
            let inner = self.lock();
            // 表第 1 行:Blocked + 备份 = 立即拒(盘上有明文,不许再造下一份)。
            if let Some(reason) = &inner.blocked {
                return Err(BackupError::Blocked(reason.clone()));
            }
            if inner.pending.is_some() {
                return Err(BackupError::CeremonyPending);
            }
        }
        let settings = config::load(&self.paths.config_path).map_err(|e| match e {
            ConfigError::NotConfigured => BackupError::NotConfigured,
            other => BackupError::Config(other.to_string()),
        })?;
        engine::prepare_target(&settings.dir).map_err(|f| BackupError::Target(f.to_string()))?;
        let catalog =
            SpaceCatalog::load(&self.paths.main_db, self.paths.scan_dir.as_deref(), None)
                .map_err(BackupError::Catalog)?;
        let total = catalog.spaces().len();
        let batch = engine::backup_all(
            catalog.spaces(),
            &settings,
            &self.paths.staging,
            &self.app_version,
        );
        Ok((batch, total, settings))
    }

    /// 把逐空间结果翻成给 UI 的报告,并处置「明文删不掉 ⇒ 封锁」。
    fn finish_batch(&self, batch: engine::BackupBatchResult, total: usize) -> BackupReport {
        // ⭐ 明文删不掉 = 已知盘上有明文 ⇒ 封锁,**不在这里顺手重扫解封**:
        // §3.4 钉死「只有 retry_cleanup 能把 Blocked 切回 Ready」。自动重扫会让
        // 「封锁」变成一个用户永远看不见、也验证不了的中间态。
        let blocked = match &batch.fatal {
            Some(f @ BatchFatal::PlaintextStuck(_)) => {
                let reason = f.to_string();
                self.lock().blocked = Some(reason.clone());
                Some(reason)
            }
            _ => None,
        };

        let mut made = Vec::new();
        let mut failed = Vec::new();
        for o in batch.outcomes {
            match o.result {
                Ok(m) => made.push(BackupMade {
                    space_id: o.space_id,
                    path: m.path.display().to_string(),
                    bytes: m.bytes,
                }),
                Err(e) => failed.push(BackupFailed {
                    space_id: o.space_id,
                    message: e.message,
                    leftover: match e.artifact {
                        Artifact::None => None,
                        Artifact::Unverified(p) => {
                            Some(Leftover::Unverified(p.display().to_string()))
                        }
                        Artifact::Invalid(p) => Some(Leftover::Invalid(p.display().to_string())),
                    },
                }),
            }
        }
        let skipped = total.saturating_sub(made.len() + failed.len());
        BackupReport {
            made,
            failed,
            skipped,
            fatal: batch.fatal.map(|f| f.to_string()),
            blocked,
        }
    }

    // ---- 自动备份(笔①-b,backup-plan §15)------------------------------------------
    //
    // ⭐ **这就是 `BackupCoordinator` 当初被放进 core 的那个理由本身**(§3.4.1 第 7 维):
    // 自动备份是备份的**第二个调用方**,它不走桌面命令层 —— 门要是开在壳里,今天就等于没门。

    /// 设置面要显示的自动备份态。⚠ **每次都会把 `pending_notice` 取走**(设计审 H5:
    /// 那条通知只活在进程内,UI 主动拉是它唯一的出路;`emit` 在主窗没开时会丢)。
    pub fn auto_status(&self) -> AutoStatus {
        let pending_notice = self.lock().pending_notice.take();
        match auto::load(&self.paths.auto_path) {
            Ok(a) => AutoStatus {
                enabled: a.enabled,
                every_minutes: a.every_minutes,
                keep: a.keep,
                last_success_at: a.last_success_at,
                last_result: a.last_result,
                problem: None,
                pending_notice,
                // ⚠ 只显示**还在盘上**的:用户处置掉之后不该还留着一条点不动的路径。
                // (真正的剪枝在下一趟轮转时落盘,这里只是显示面的过滤。)
                released: notes(&a.released, true),
                retry: notes(&a.last_retry, false),
            },
            // ⛔ 坏了 / 越界 = **响亮拒绝自动备份**,不许静默按默认值跑(那会把用户
            // 「我关掉了自动备份」的意思悄悄改回"开着")。UI 显示原话 + 给「重置」按钮。
            Err(e) => AutoStatus {
                enabled: false,
                every_minutes: auto::DEFAULT_EVERY_MINUTES,
                keep: auto::DEFAULT_KEEP,
                last_success_at: None,
                last_result: None,
                problem: Some(e.to_string()),
                pending_notice,
                released: Vec::new(),
                retry: Vec::new(),
            },
        }
    }

    /// 开 / 关自动备份。⛔ **要先设置过备份**(没有钥就没有可自动的东西)。
    ///
    /// ⭐ 它与后台那条路**共用同一道串行化门**(准入):设计审二弹 M3 —— 否则 UI 这边的写
    /// 与后台状态保存可能同时进行,扫 temp 的一方会删掉另一方正在写的那个 live temp。
    pub fn set_auto_enabled(&self, enabled: bool) -> Result<AutoStatus, BackupError> {
        let _admitted = self.admit(Busy::Backup)?;
        if !matches!(config::load(&self.paths.config_path), Ok(_)) {
            return Err(BackupError::NotConfigured);
        }
        let mut a = auto::load(&self.paths.auto_path).map_err(|e| BackupError::Config(e.to_string()))?;
        a.enabled = enabled;
        auto::save(&self.paths.auto_path, &a).map_err(|e| BackupError::Config(e.to_string()))?;
        drop(_admitted);
        Ok(self.auto_status())
    }

    /// 把 `.backup-auto.json` 重置成默认(关、每天、3 份、**空账**)。
    ///
    /// ⭐ **这里给按钮是安全的,与 `.backup.json` 那条「⛔ 不给按钮」正好相反**:判据不是
    /// "要不要谨慎",是**里面有没有不可再生的东西** —— 这份文件里一个秘密都没有。
    /// ⚠ 代价照实说:**账清零 = 那些旧备份从此归用户自己管**(轮转再也不碰它们)。
    pub fn reset_auto(&self) -> Result<AutoStatus, BackupError> {
        let _admitted = self.admit(Busy::Backup)?;
        auto::save(&self.paths.auto_path, &auto::AutoFile::default())
            .map_err(|e| BackupError::Config(e.to_string()))?;
        drop(_admitted);
        Ok(self.auto_status())
    }

    /// 后台定时器每 60 秒叫一次。**判定全在这里**,壳不做任何策略。
    ///
    /// ⭐ **跳过 ≠ 失败**:`Skipped` 那几种(没开 / 没到点 / 没配过 / 仪式中 / 有别的操作在跑)
    /// **不该弹任何提示** —— 60 秒一次的节奏下,把"正常"也报出去等于教用户无视提示。
    pub fn run_auto_if_due(&self) -> AutoTick {
        let admitted = match self.admit(Busy::Backup) {
            Ok(a) => a,
            // ⭐ 手动那趟在跑 ⇒ **跳过,绝不排队**(下一个 tick 再看)。
            Err(BackupError::BackupBusy(b)) | Err(BackupError::CleanupBusy(b)) => {
                return AutoTick::Skipped(AutoSkip::Busy(b))
            }
            Err(e) => return AutoTick::Refused(e.to_string()),
        };
        let mut a = match auto::load(&self.paths.auto_path) {
            Ok(a) => a,
            Err(e) => return AutoTick::Refused(e.to_string()),
        };
        if !a.enabled {
            return AutoTick::Skipped(AutoSkip::Disabled);
        }
        if !matches!(config::load(&self.paths.config_path), Ok(_)) {
            return AutoTick::Skipped(AutoSkip::NotConfigured);
        }
        {
            let inner = self.lock();
            if inner.pending.is_some() {
                return AutoTick::Skipped(AutoSkip::CeremonyPending);
            }
        }
        // ---- 两把尺(§15.2)---------------------------------------------------------
        let every = a.every_minutes;
        let wall_due = auto::due(
            time::OffsetDateTime::now_utc(),
            a.last_success_at.as_deref().and_then(auto::parse_stamp),
            every,
        );
        if !wall_due {
            return AutoTick::Skipped(AutoSkip::NotDue);
        }
        {
            // ⭐ 单调尺:系统时钟被改 / `last_success_at` 落在未来时,墙钟那把恒判 due,
            // 只有它挡得住"每 60 秒备一次"。⛔ 记的是**尝试**,不是成功。
            let mut inner = self.lock();
            if let Some(t) = inner.last_attempt {
                if t.elapsed() < std::time::Duration::from_secs(u64::from(every) * 60) {
                    return AutoTick::Skipped(AutoSkip::NotDue);
                }
            }
            inner.last_attempt = Some(std::time::Instant::now());
        }

        let (batch, total, settings) = match self.run_batch(&admitted) {
            Ok(v) => v,
            Err(e) => {
                let msg = e.to_string();
                self.remember(&mut a, Some(&msg), false);
                return AutoTick::Refused(msg);
            }
        };

        // ---- 逐个 `made` 单独授权轮转 ⛔ 不按外层结果授权 -------------------------------
        let mut rotations = Vec::new();
        for o in &batch.outcomes {
            let Ok(m) = &o.result else { continue };
            let r = auto::rotate_space(&mut a, &o.space_id, m, &settings.key);
            if !(r.removed.is_empty() && r.is_quiet()) {
                rotations.push(SpaceRotation {
                    space_id: o.space_id.clone(),
                    removed: r.removed,
                    unmanaged: r.unmanaged,
                    retry: r.retry,
                    stalled: r.stalled,
                });
            }
        }

        let report = self.finish_batch(batch, total);
        let summary = summarize(&report, &rotations);
        // 墙钟只认「这一趟至少备成了一个空间」(§15.2 那张表:它是"多久备一次"的尺,
        // 不是"有没有出错"的尺)。
        self.remember(&mut a, Some(&summary), auto::wall_clock_should_advance(report.made.len()));
        drop(admitted);
        AutoTick::Ran(AutoRun { report, rotations, summary })
    }

    /// 把这一趟的结论落进 `.backup-auto.json`。
    ///
    /// ⛔ **写盘失败不是 fatal**(备份已经成了),但也**不能只指望把它写进那个刚写失败的
    /// 文件** —— 那正是设计审 H5 打的洞。⇒ 同时落一枚**进程内** `pending_notice`,UI 拉状态
    /// 时取走。⚠ 它挡不住"进程被杀 + 用户从不打开主窗",那条边界 v1 照实接受
    /// (配置目录写不进时,app 的别的本机设置也在坏,不是备份独有的病)。
    fn remember(&self, a: &mut auto::AutoFile, result: Option<&str>, success: bool) {
        if success {
            a.last_success_at = Some(auto::stamp_now());
        }
        if let Some(r) = result {
            a.last_result = Some(r.to_string());
        }
        if let Err(e) = auto::save(&self.paths.auto_path, a) {
            self.lock().pending_notice = Some(format!(
                "自动备份跑完了,但结果没能记下来({e})——下次启动可能会多备一份"
            ));
        }
    }

    /// 列出备份目录里的**候选**文件(§3.3 收口那条义务的前一半)。
    ///
    /// ⛔ **返回的每一条都只有"盘上事实"(名字 / 大小 / 改动时刻),没有任何"有效 / 无效"** ——
    /// 那条义务写死了「**文件名 / 扩展名绝不能当『这是一份有效备份』的判据**」,唯一判据是
    /// [`verify_backup`](Self::verify_backup) 把它整个解一遍。⇒ 类型里**根本不给**「valid」这一格,
    /// 让"想当然地标成有效"在编译期就写不出来。
    ///
    /// ⚠ **不走操作准入**:纯读目录,不碰 staging、不碰明文、与正在跑的备份无冲突
    /// (产物是 `create_new` 直落新名、写完永不改写)。⇒ 不给 [`Busy`] 加第三种态,
    /// 那台状态机是评审过的形,不为一个只读列表动它。
    ///
    /// 排序:改动时刻**新的在前**(取不到时刻的排最后,按名字兜底,保证顺序稳定)。
    pub fn list_backups(&self) -> Result<Vec<BackupEntry>, BackupError> {
        let settings = self.settings()?;
        let dir = &settings.dir;
        let rd = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            // 目录还不存在 = 一份都还没备过,不是故障。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(BackupError::Target(format!("读不了备份目录 {}:{e}", dir.display())))
            }
        };
        let mut out = Vec::new();
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !super::looks_like_artifact(&name) {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) if m.is_file() => m,
                // 不是普通文件(目录 / symlink / 读不到)就不列 —— 列出来也没法验。
                _ => continue,
            };
            out.push(BackupEntry {
                path: entry.path().to_string_lossy().into_owned(),
                file_name: name,
                bytes: meta.len(),
                modified_ms: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64),
            });
        }
        out.sort_by(|a, b| {
            b.modified_ms.cmp(&a.modified_ms).then_with(|| a.file_name.cmp(&b.file_name))
        });
        Ok(out)
    }

    /// 验一份备份:**整个读回来解一遍**,与恢复(笔②)走的是同一条路
    /// ([`super::verify_file`] → `read_backup`)。⛔ 不抽验、不看文件名。
    ///
    /// ⚠ **只认备份目录里的文件**:传进来的路径必须**就在**当前配置的备份目录下(逐层比对
    /// 规范化后的父目录),否则拒。理由 = 这条命令的入参来自前端,不设这道闸就等于给了
    /// 「拿备份钥去解任意路径的文件」这个能力面。
    ///
    /// 成功回 trailer 里那几格给人看;失败把**四种读错分开报**(§3.3 那台状态机的读者半):
    /// 尤其 `WrongKey` = 「这份不是当前备份码对应的」,与"文件坏了"是两回事,别糊成一句。
    pub fn verify_backup(&self, path: &str) -> Result<VerifiedBackup, BackupError> {
        let settings = self.settings()?;
        let target = PathBuf::from(path);
        let parent = target.parent().unwrap_or(Path::new(""));
        // 规范化两边再比:用户目录可能带 `..` 或大小写/短名差异,直接比字符串会漏。
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        if canon(parent) != canon(&settings.dir) {
            return Err(BackupError::Target(format!(
                "只能验备份目录({})里的文件",
                settings.dir.display()
            )));
        }
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !super::looks_like_artifact(&name) {
            return Err(BackupError::Target("这不是一个 .zjbak 文件".into()));
        }
        // ⚠ 420 起 `verify_file` 一并交出 header 里那枚 salt(自动备份的轮转拿它当**身份指纹**);
        // 这条路只要 trailer。
        let t = super::verify_file(&target, &settings.key)
            .map_err(|e| BackupError::VerifyFailed(e.to_string()))?
            .trailer;
        Ok(VerifiedBackup {
            space_id: t.space_id,
            space_name: t.space_name,
            created_at: t.created_at,
            app_version: t.app_version,
            plain_bytes: t.plain_bytes,
        })
    }

    // ---- 恢复(笔②,backup-plan §16)-------------------------------------------------

    /// 从一份 `.zjbak` 恢复出**一个未配置(不同步)的新空间**(幕⓪ + ①…⑥)。
    /// ⛔ **绝不覆盖任何现有数据**;幕⑦(集成进 catalog / 装配运行时)在壳里。
    ///
    /// # ⛔ 三条要点(每条都有一个会静默毁掉东西的反面)
    ///
    /// 1. **备份码是用户手输的**,⛔ 不读 `.backup.json`、⛔ 也不要求本机已完成备份仪式 ——
    ///    换了机器 / 重装系统之后那份配置根本不存在,而那正是恢复的主场景。
    /// 2. ⛔ **输进来的钥绝不写回 `.backup.json`**:那会覆盖本机自己的备份钥,此后产出的
    ///    所有备份都用别人那把钥,而用户抄的是自己那张纸 —— 静默、无提示。
    ///    (本方法与它的下游没有任何一条通向 [`config::create`] / [`config::set_dir`] 的路。)
    /// 3. **它是破坏性入口,必须占准入**(§16.7):写数据目录、造明文整库、与启动清扫抢
    ///    同一个 staging 域。`Blocked` 时立即拒 —— staging 里已知有清不掉的明文,不许再造一份。
    ///
    /// ⚠ **没有进度、也不能取消**(§16.9,与 `0a-进度` 同一条已拍的板:用户全部 5 个空间
    /// 今天合计 28.4 MiB,恢复一份 ≈ 秒级)。⛔ 别顺手做进度条。
    pub fn restore_backup(&self, file: &str, code: &str) -> Result<RestoredSpace, BackupError> {
        let _admitted = self.admit(Busy::Restore)?;
        {
            // §16.7 表末行:Blocked + 恢复 = 立即拒。
            let inner = self.lock();
            if let Some(reason) = &inner.blocked {
                return Err(BackupError::Blocked(reason.clone()));
            }
        }
        // 落点 = 空间扫描目录(生产的数据目录)。⚠ e2e(`YS_DB_PATH`)禁扫也禁建空间
        // (§六③),恢复照同一条纪律拒 —— 与壳里「测试模式不加入 / 不建 / 不重置空间」
        // 那三处同形。
        let target_dir = self.paths.scan_dir.clone().ok_or_else(|| {
            BackupError::Target("测试模式(YS_DB_PATH)不恢复空间".into())
        })?;
        let file = file.trim();
        if file.is_empty() {
            return Err(BackupError::Target("要恢复哪一份?先选一个 .zjbak 文件".into()));
        }
        // 备份码 → 一次性的钥。⚠ 走的是与显示 / 回输核对**同一支编码的逆**,
        // 大小写 / `-` / O↔0 / I↔1 这些抄录容错口径一致。
        let key = crate::sync::crypto::crockford_decode32(code.trim()).map_err(|e| {
            BackupError::RestoreFailed(format!("备份码不对(抄漏了一位?):{e}"))
        })?;
        let key = super::BackupKey::from_bytes(key);

        match super::restore::restore(
            Path::new(file),
            &key,
            &self.paths.staging,
            &target_dir,
        ) {
            Ok(r) => Ok(RestoredSpace {
                space_id: r.space_id,
                path: r.path.display().to_string(),
                source_space_name: r.source_space_name,
                created_at: r.created_at,
                device_id: r.device_id,
                cleanup_error: r.cleanup_error,
            }),
            Err(f) => {
                // 明文删不掉 ⇒ **封锁**(与备份同一条规则、同一句话术):已知盘上有明文,
                // 不许再造下一份。⛔ 不在这里顺手重扫解封 —— 只有 `retry_cleanup` 能解。
                if let Some(stuck) = f.plaintext_stuck {
                    let reason = BatchFatal::PlaintextStuck(stuck).to_string();
                    self.lock().blocked = Some(reason);
                }
                Err(BackupError::RestoreFailed(restore_message(f.stage, f.message)))
            }
        }
    }

    /// 读配置,把「还没配过」翻成 [`BackupError::NotConfigured`](那不是故障,是该走仪式)。
    fn settings(&self) -> Result<config::BackupSettings, BackupError> {
        config::load(&self.paths.config_path).map_err(|e| match e {
            ConfigError::NotConfigured => BackupError::NotConfigured,
            other => BackupError::Config(other.to_string()),
        })
    }

    /// 重试清扫:同一 `WriterLease` 下**完整重扫**。三条同时成立(目录安全 + 无未知项 +
    /// 全部候选都消失)才回 `Ready`,否则原样封锁着。
    pub fn retry_cleanup(&self) -> Result<BackupStatus, BackupError> {
        let admitted = self.admit(Busy::Cleanup)?;
        let clean = staging::sweep(&self.paths.staging);
        self.lock().blocked = (!clean.is_ready()).then(|| clean.to_string());
        // 先放准入再取状态,否则回给 UI 的那份 status 恒带着 busy=清扫。
        drop(admitted);
        Ok(self.status())
    }
}

/// 恢复失败的那句话 —— 绝大多数原样带出,**只有 `WrongKey` 那一格要改口**。
///
/// # ⭐ 为什么只有这一格
///
/// [`ReadError::WrongKey`] 的 `Display` 写的是「这份备份不是**当前备份码**对应的」。
/// 那句话是给 [`BackupCoordinator::verify_backup`] 写的,在那条路上**准确**:验证用的
/// 确实是本机 `.backup.json` 里那把钥。
///
/// ⛔ **但恢复用的是用户刚手输的那把**(§16.6:换了机器 / 重装系统之后本机根本没有配置)——
/// 把「当前备份码」原样端给一个刚敲完码的人,他会读成「它没用我输的码」,**恰是 §16.6
/// 要避免的那种误解**。三个端都真机撞见过同一句(Linux 427 / Windows 428 补 / 433 桌面对拍)。
///
/// ⇒ 换的是**恢复这条路的措辞**,话照 §16.6 末那句规格(「这份备份不是**这个**备份码的」),
/// 并点名两个可能的因;⛔ **别去动 `Display` 本身** —— 那会把 verify 那边已经准确的话弄错。
fn restore_message(stage: RestoreStage, message: String) -> String {
    match stage {
        RestoreStage::Read(ReadError::WrongKey) => {
            "这份备份不是你输入的这个备份码的:码抄错了,或者选错了文件".into()
        }
        _ => message,
    }
}

/// 目标目录校验:响亮到能照着修(§5.2)。
///
/// ⛔ **拒相对路径**:那会按进程 CWD 解析,用户根本预期不到落在哪。
fn validated_dir(raw: &str) -> Result<PathBuf, BackupError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BackupError::Target("备份目录不能为空".into()));
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err(BackupError::Target(format!(
            "备份目录要给完整路径(现在是「{trimmed}」)"
        )));
    }
    engine::prepare_target(&p).map_err(|f| BackupError::Target(f.to_string()))?;
    Ok(p)
}

#[cfg(test)]
mod tests;
