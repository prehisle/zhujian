//! 明文临时快照的落点与清场(backup-plan §3.1 / §3.4 / §6.2)。
//!
//! # 这里躺的是**明文完整库**,所以纪律照 `.joining-*` 那一档,不照 `.boot` 那一档
//!
//! 壳里已有三个同形的启动清扫,失败处置**各不相同**:
//!
//! | 既有 | 清的是 | 删不掉怎么办 |
//! |---|---|---|
//! | `sweep_stale_boot_files` | 明文引导快照 | ⚠ 纯 best-effort(`let _`,连 `read_dir` 失败都静默) |
//! | `sweep_stale_joining` | 槽(含完整明文数据 / K_acc / 设备私钥) | ⛔ 任一删除失败 = **拒启** |
//!
//! 本模块清的东西与 joining 槽**同一内容类**(明文整库),⇒ 照严格那一档;但**不拒启**
//! (用户还得能用 app 看自己的数据),改为**封锁备份功能** —— 比 boot 强、比 joining 弱,
//! 理由 = **只有备份这条路会继续制造更多明文**。
//!
//! # ⭐ 为什么 `Drop` 不够(设计审二轮 H1)
//!
//! `Drop` **返回不了错误**;`panic = abort`、双重 panic、SIGKILL、断电**根本不执行它**。
//! ⇒ 三层:①guard 在取快照**之前** armed;②可捕获路径走显式 [`SnapshotGuard::cleanup`]
//! (它**能**把「删不掉」上报,§6.3 那条整批 fatal 就挂在它的返回值上);③`Drop` 只做
//! 最后一层 best-effort,**并且假定它可能没跑** —— 那就是 [`sweep`] 存在的理由。

use std::path::{Path, PathBuf};

/// 清场状态。⭐ **`Blocked` 只是状态,不持锁**(四轮 M3)—— 所以不会有「想清扫要先等备份、
/// 备份因为 Blocked 又起不来」那种死锁式 UX。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Cleanliness {
    Ready,
    Blocked {
        /// 不认识的东西:⛔ **不删**(0700 的应用保留目录里出现未知项 = 实现漂移 / 手工干预 /
        /// 损坏,**不能假定它安全**),但**封锁备份**。
        unknown: Vec<PathBuf>,
        /// 认识、该删、但删不掉的。
        failed: Vec<(PathBuf, String)>,
        /// 这一趟真删掉了几个(部分成功也要记数,§3.4 算法第 5 条)。
        removed: usize,
    },
}

impl Cleanliness {
    pub(crate) fn is_ready(&self) -> bool {
        matches!(self, Cleanliness::Ready)
    }
}

impl std::fmt::Display for Cleanliness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Cleanliness::Ready => write!(f, "备份暂存区干净"),
            Cleanliness::Blocked { unknown, failed, removed } => write!(
                f,
                "备份暂存区没清干净(已清 {removed} 个):{} 个删不掉、{} 个不认识。\
                 ⛔ 这些是**明文**数据库副本,清干净之前不再产生新备份。{}{}",
                failed.len(),
                unknown.len(),
                failed
                    .iter()
                    .map(|(p, e)| format!("\n  删不掉:{} —— {e}", p.display()))
                    .collect::<String>(),
                unknown
                    .iter()
                    .map(|p| format!("\n  不认识:{}", p.display()))
                    .collect::<String>(),
            ),
        }
    }
}

/// 一枚快照的全套可能残留:**四件套**。
///
/// ⭐ `-journal` 那件是设计审三轮抓的,而且**实测坐实**:`VACUUM INTO` 的产物是 **`delete`**
/// journal 模式(源库是 WAL **也不继承**),剥派生那次 `DELETE; VACUUM` 的写事务进行中,
/// 盘上真的多出 `<名>-journal`,提交后消失 ⇒ **死在那个事务里必留它,里面同样是明文页**。
/// `-wal` / `-shm` 正常不出现,留在名单里**纯粹是防实现漂移** —— 与 `spaces::joining_sidecars`
/// 的注释一字不差是同一个理由。
fn sidecars(main: &Path) -> [PathBuf; 4] {
    let base = main.as_os_str().to_os_string();
    let with = |suffix: &str| {
        let mut s = base.clone();
        s.push(suffix);
        PathBuf::from(s)
    };
    [main.to_path_buf(), with("-journal"), with("-wal"), with("-shm")]
}

// 显式故障注入:让**下一次** `cleanup()` 报「删不掉」(用完即自动复位)。
//
// ⭐ 为什么要有它:设计审三轮 M4 明确判**「只读目录造失败」不可靠**(root 无视权限位、
// Windows ACL 语义不同),要求改**显式故障注入**;而「明文删不掉 ⇒ 整批 fatal」这条控制流
// 没有别的办法造。⛔ **`cfg(test)` 门控**:发版二进制里一个字节都没有。
#[cfg(test)]
thread_local! {
    pub(crate) static FAIL_CLEANUP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 一份在制的明文快照。**建它 = armed**;⛔ 必须在取快照**之前**建。
pub(crate) struct SnapshotGuard {
    path: PathBuf,
    /// 显式 cleanup 成功之后置位,`Drop` 就不再多此一举。
    done: bool,
}

impl SnapshotGuard {
    /// armed。返回的 `path` **此刻还不存在**(`VACUUM INTO` 要求目标不存在)。
    pub(crate) fn arm(staging: &Path) -> Result<SnapshotGuard, String> {
        std::fs::create_dir_all(staging)
            .map_err(|e| format!("建备份暂存目录失败 {}:{e}", staging.display()))?;
        // ⭐ **先证明它是个真实目录,再往里放明文**(412 实现审 M1)。清扫那边一直有这道闸
        // ([`sweep`] 的第 ① 条),取快照这边第一版漏了 —— 而「权限是 0700」只证明模式,
        // **证明不了这是我们的目录**:同名路径若是一条指向别处的 symlink,`create_dir_all` 与
        // `set_permissions` 都会**跟着走**,明文整库就落到别人的目录里去了。
        ensure_real_dir(staging)?;
        harden_dir(staging)?;
        Ok(SnapshotGuard {
            path: staging.join(format!("{}.sqlite3", ulid::Ulid::new())),
            done: false,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// 显式清场:删四件套,**聚合所有错误**(⛔ 不许逐项 `?` 早退 —— 那会让后面的明文
    /// **连试都没试过**)。不存在的文件视为成功(幂等)。
    pub(crate) fn cleanup(&mut self) -> Result<(), String> {
        #[cfg(test)]
        if FAIL_CLEANUP.with(|c| c.replace(false)) {
            return Err("(测试注入)明文临时快照删不掉".into());
        }
        let mut errs = Vec::new();
        for p in sidecars(&self.path) {
            match std::fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => errs.push(format!("{} —— {e}", p.display())),
            }
        }
        if errs.is_empty() {
            self.done = true;
            return Ok(());
        }
        Err(format!(
            "明文临时快照删不掉({} 处),盘上留着**明文数据库副本**:{}",
            errs.len(),
            errs.join(";")
        ))
    }
}

impl Drop for SnapshotGuard {
    /// 最后一层 best-effort。⚠ **它可能根本不会跑**(SIGKILL / 断电 / `panic = abort`),
    /// 所以真正的兜底是 [`sweep`],不是这里。
    fn drop(&mut self) {
        if self.done {
            return;
        }
        for p in sidecars(&self.path) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// 明文快照本身收到 0600(§5.2 那两格里的第二格)。
///
/// ⭐ **只能事后 chmod,不能"从创建那一刻就对"** —— 这个文件是 SQLite 的 `VACUUM INTO`
/// 建的,建它的不是我们,给不了 `OpenOptions::mode`(⛔ 与 `.backup.json` 那条**刚好相反**,
/// 别把两处的写法抄来抄去)。
///
/// ⛔ **别把那段 umask 窗口读成"一瞬"**(413 真机验收实测,原注释就是这么写的、是错的):
/// 它 = **整个 `VACUUM INTO` 的时长**,与库大小成正比 —— 240 MiB 库上 **1.3~2.8 秒**;而进程
/// 若在这段里被杀,那份 **0644 的明文整库**会一直躺到**下次启动清扫**才消失。⇒ 结论(没有真实
/// 暴露窗口)不变,但**承重的只有一条**:它落在 [`SnapshotGuard::arm`] **已经**收到 0700 的目录里,
/// 别人连进都进不去。⛔ 所以那道目录闸不许降级 —— 挡住这件事的是它,不是"窗口太短来不及"。
/// ⚠ 相对地,剥派生那次原地 VACUUM 的 `-journal` **是 0600**(实测):SQLite 建 journal 时照主库
/// 文件的权限走,而那时主库已经被本函数收过了。
/// ⚠ Windows 侧继承目录 ACL,做不到等价的一行,记档。
pub(crate) fn harden_snapshot(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("收紧明文快照权限失败 {}:{e}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// 「这是不是一个真实目录」——⛔ symlink / junction / reparse **不跟着走**。
/// [`sweep`] 与 [`SnapshotGuard::arm`] 共用这一份(⛔ 别各写各的:一处严一处松,
/// 松的那处就是全部)。
fn ensure_real_dir(dir: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(dir)
        .map_err(|e| format!("看不到备份暂存目录 {}:{e}", dir.display()))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!(
            "{} 不是一个真实目录(symlink / 别的东西?)——不跟着走,这里要放的是明文整库副本",
            dir.display()
        ));
    }
    Ok(())
}

/// 目录权限收到 0700(§5.1:本功能自己新造出来的明文物件,不该一出生就继承宽权限)。
/// ⚠ Windows 侧继承 app 目录 ACL,做不到等价的一行,记档。
fn harden_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("收紧备份暂存目录权限失败 {}:{e}", dir.display()))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// 启动清扫(§3.4)。⚠ **调用方必须已持 `WriterLease`** —— 那时才排他,才敢删。
///
/// 算法逐条按规格:①确认是真实目录不是 symlink;②只扫当前层不递归;
/// ③文件名判定复用 [`crate::spaces::is_ulid_name`];④对**全部**候选尝试删除、**聚合错误**;
/// ⑤部分成功记数;⑥**未知项 = 不删 + 封锁**。
pub(crate) fn sweep(staging: &Path) -> Cleanliness {
    // 目录还不存在 = 从没备份过,干净。
    if let Err(e) = std::fs::symlink_metadata(staging) {
        if e.kind() == std::io::ErrorKind::NotFound {
            return Cleanliness::Ready;
        }
    }
    // ⛔ symlink / junction / reparse 跳转:**不跟着走**。跟着走 = 我们的删除动作会落在
    // 别人的目录里,而那正是「未知项不删」想防的事。
    // ⭐ 判据与 [`SnapshotGuard::arm`] **共用一份** `ensure_real_dir`(412 实现审 M1:
    // 一处严一处松的话,松的那处就是全部)。
    if let Err(m) = ensure_real_dir(staging) {
        return Cleanliness::Blocked {
            unknown: Vec::new(),
            failed: vec![(staging.to_path_buf(), m)],
            removed: 0,
        };
    }

    let entries = match std::fs::read_dir(staging) {
        Ok(e) => e,
        Err(e) => {
            return Cleanliness::Blocked {
                unknown: Vec::new(),
                failed: vec![(staging.to_path_buf(), format!("读目录失败:{e}"))],
                removed: 0,
            }
        }
    };

    let (mut unknown, mut failed, mut removed) = (Vec::new(), Vec::new(), 0usize);
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                failed.push((staging.to_path_buf(), format!("读目录项失败:{e}")));
                continue;
            }
        };
        let path = entry.path();
        let name = entry.file_name();
        let known = name.to_str().is_some_and(is_snapshot_name)
            && entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !known {
            unknown.push(path);
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => failed.push((path, e.to_string())),
        }
    }

    if unknown.is_empty() && failed.is_empty() {
        Cleanliness::Ready
    } else {
        Cleanliness::Blocked { unknown, failed, removed }
    }
}

/// 白名单:`<严格 ULID>.sqlite3` 及其三件 sidecar。
fn is_snapshot_name(name: &str) -> bool {
    let stem = ["-journal", "-wal", "-shm"]
        .iter()
        .find_map(|s| name.strip_suffix(s))
        .unwrap_or(name);
    stem.strip_suffix(".sqlite3").is_some_and(crate::spaces::is_ulid_name)
}

#[cfg(test)]
mod tests;
