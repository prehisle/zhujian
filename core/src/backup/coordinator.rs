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

use super::config::{self, ConfigError};
use super::engine::{self, Artifact, BatchFatal};
use super::staging;
use crate::spaces::SpaceCatalog;

/// 三处路径的域。⛔ **必须与 `WriterLease` 一一对应**(§3.4 那张表)——
/// e2e(`YS_DB_PATH`)下 `main_db.parent()` 是 `/tmp`,多个测试进程会共享同一个
/// `/tmp/.backup-staging` 却各持不同租约,一个进程能删掉另一个正在用的明文快照。
/// ⇒ e2e 三处**全部按库派生**,见 [`BackupPaths::for_db`]。
#[derive(Debug, Clone)]
pub struct BackupPaths {
    /// `.backup.json`(**明文备份钥**住这儿)。
    pub config_path: PathBuf,
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
            staging: side(".backup-staging"),
            default_dir: side(".backups"),
            main_db: main_db.to_path_buf(),
            scan_dir: None,
        }
    }
}

// ---- 对外的状态与结果(壳只认这几个形)-------------------------------------------

/// 正在跑的是哪一件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    Backup,
    Cleanup,
}

impl Busy {
    fn label(self) -> &'static str {
        match self {
            Busy::Backup => "备份",
            Busy::Cleanup => "清扫",
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

/// 备份入口的失败。**每一种都要能被 UI 分开认领**(fail-fast:别退化成一句"操作失败")。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupError {
    /// 这次**备份**请求被拒:有一趟别的操作在跑。
    BackupBusy(Busy),
    /// 这次**清扫**请求被拒:有一趟别的操作在跑。
    CleanupBusy(Busy),
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
            inner: Mutex::new(Inner { activity: Activity::Idle, blocked: None, pending: None }),
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
        let _admitted = self.admit(Busy::Backup)?;
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
        Ok(BackupReport {
            made,
            failed,
            skipped,
            fatal: batch.fatal.map(|f| f.to_string()),
            blocked,
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
