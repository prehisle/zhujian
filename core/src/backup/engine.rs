//! 备份引擎(backup-plan §3 的七幕 + §6 的失败路径 + §6.3/§6.4 的批处理)。
//!
//! # 七幕
//!
//! ```text
//! ① 枚举    调用方给 &[SpaceDescriptor](严格 catalog 的产物)
//!   ★ guard armed ———— 在②之前
//! ② 快照    往 staging 里出一份明文完整库
//! ③ 剥派生  复用 boot 那一支,不另写
//! ④ 加密    读②→ 分块封 → create_new 直落最终名
//! ⑤ 清明文  ★ 显式 cleanup(),提到 fsync 与自验之前 —— 自验只读密文,明文没必要多活一轮
//! ⑥ 落定    fsync(文件) + fsync(目录)
//! ⑦ 自验    整份读回、逐帧解、比 plain_bytes 与 plain_sha256 两格
//! ```
//!
//! # ⛔ 三条别改坏的
//!
//! 1. **只读连接 + 两格复验**:⛔ 不走 `db::open`(它跑回收 = 原地 VACUUM)、⛔ 不走
//!    `spaces::open_space`(读写连接、切 WAL)。但那两支顺手做的**物理身份**与 `user_version`
//!    复验不能一起丢 —— 少了它,与 `reset_space_files` 并发会把**换进来的新文件**按
//!    **旧 descriptor 的身份**备走(设计审二轮 M2)。
//! 2. **落最终名用 `create_new`(`O_EXCL`)**,⛔ 不用 `rename`、⛔ 也不照抄
//!    `spaces::publish_no_clobber` —— 它的 hard_link 在 exFAT/FAT32 的 U 盘上不支持,而备份
//!    目标恰恰是用户选的可移动介质(二轮 H2 + 三轮判定:U 盘是**现实主路径不是边缘例**)。
//! 3. **进了逐空间循环之后,最外层函数不再返回 `Result`** —— 用类型钉死「从这里往后不可失败」,
//!    让「已提交的成功项」没有任何 `?` 能把它蒸发(四轮 M3 / checklist §4)。

use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::config::BackupSettings;
use super::staging::SnapshotGuard;
use super::{write_backup, BackupKey, TrailerMeta, CHUNK_DEFAULT};
use crate::spaces::SpaceDescriptor;

/// 一个空间这一趟的结果。
#[derive(Debug)]
pub(crate) struct SpaceBackupOutcome {
    pub space_id: String,
    pub result: Result<MadeBackup, SpaceFailure>,
}

#[derive(Debug)]
pub(crate) struct MadeBackup {
    pub path: PathBuf,
    pub bytes: u64,
    /// 幕⑦自验时从 header 里读回来的 salt。⭐ **它是这份文件的身份指纹**(backup-plan §15.3):
    /// 自动备份把它连同文件名一起记进本机产出账,轮转删任何东西之前都要比一次 ——
    /// ⛔ 少了它,「同名文件被换成另一份**同钥同空间的手动 checkpoint**」会两道全过而被删掉。
    /// ⚠ 取的是**自验读回来的那一枚**(盘上的实况),不是写的时候那一枚。
    pub salt: [u8; super::SALT_LEN],
}

/// 失败时盘上那个 `.zjbak` 处于什么状态 —— 就是 backup-plan §3.3 的那台状态机
/// (`Writing` 在这里不出现:它只发生在进程被杀时,不是可返回的失败)。
///
/// ⛔ **`Unverified` 与 `Invalid` 是两件事**,UI 别混:前者可能完全合法(只是这一趟没验完),
/// 后者是**验过了、没过、又删不掉**。两者都**不得计作一份成功的备份**。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Artifact {
    /// 盘上没留东西。
    None,
    /// **写完了但没验过**(流程被更严重的失败打断)。§3.3 的 `CompleteUnverified` ——
    /// ⭐ 重启后**无从知道上次自验跑没跑过**,只能重新完整验一遍;验过也只能说
    /// 「当前完整可读」,**不许追认「上次那条备份命令成功」**。
    Unverified(PathBuf),
    /// **验不过、且删不掉**。§3.3 的 `InvalidArtifact`。
    Invalid(PathBuf),
}

/// 单空间失败。⭐ `artifact` 那格是三轮 / 四轮两轮堆出来的义务:直落最终名之后,
/// 盘上那个文件**处于哪一态**必须一起报出来,⛔ UI 不得把它计作一份备份。
#[derive(Debug)]
pub(crate) struct SpaceFailure {
    pub message: String,
    pub artifact: Artifact,
}

impl SpaceFailure {
    fn plain(message: String) -> SpaceFailure {
        SpaceFailure { message, artifact: Artifact::None }
    }
}

/// 整批 fatal:剩余空间**没跑**。封闭清单见 backup-plan §6.3 —— ⛔ 别往里加"顺手觉得严重的",
/// 每一条都要能说出「为什么继续跑会更坏」。
///
/// ⭐ **§6.3 清单里「配置 / 钥 / 仪式」那一行不在这个 enum 里,不是漏了**:那几格全部发生在
/// **循环之前**的 preflight,由 `BackupCoordinator` 直接 `Err` 掉 —— 那时一个空间都还没跑,
/// 不存在「已提交的成功项被蒸发」的问题,而 §6.4 允许的两种表达里这是更清楚的那种
/// (UI 拿到的是一句可照做的话,不是一份 0 成功 0 失败的报告)。
/// ⛔ 谁要把它加回来,先答:**它是在逐空间循环之内发生的吗?**
#[derive(Debug)]
pub(crate) enum BatchFatal {
    /// staging 建不出 / 安全检查不过 / 启动清扫发现残留且清不掉。
    Staging(String),
    /// ⭐ **明文快照删不掉** —— 已知盘上有明文,继续 = 再造更多明文副本。
    PlaintextStuck(String),
    /// 目标目录本身不可用(建不出 / 不是目录)。
    Target(String),
}

impl std::fmt::Display for BatchFatal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BatchFatal::Staging(m) => write!(f, "备份暂存区有问题,整批停下:{m}"),
            BatchFatal::PlaintextStuck(m) => write!(
                f,
                "明文临时文件删不掉,整批停下(不再产生新的明文副本):{m}"
            ),
            BatchFatal::Target(m) => write!(f, "备份目录不可用,整批停下:{m}"),
        }
    }
}

/// 一趟备份的结果。⭐ **三件事要同时看得见**:此前的成功、当前这个失败、剩余没跑。
#[derive(Debug)]
pub(crate) struct BackupBatchResult {
    pub outcomes: Vec<SpaceBackupOutcome>,
    pub fatal: Option<BatchFatal>,
}

/// 单空间三态。`Fatal` 那支**同时**带着当前空间的 Outcome —— 少了它,UI 看得见"整批停了",
/// 却**看不见是哪个空间留下了明文**(四轮 M3)。
enum SpaceStep {
    Ok(MadeBackup),
    PerSpaceErr(SpaceFailure),
    Fatal(SpaceFailure, BatchFatal),
}

/// 逐空间跑完。
///
/// ⭐ **返回类型不是 `Result`,这是有意的**(四轮 M3 / checklist §4「把失败点搬走」):
/// 进了这个函数就说明 preflight 全过了,从这里往后**不可失败** —— 于是没有任何一个 `?`
/// 能把已经攒下的 `outcomes` 蒸发掉。`backup_all_is_infallible` 那只测用 fn 指针把这条
/// 钉给编译器判,别改签名。
pub(crate) fn backup_all(
    spaces: &[SpaceDescriptor],
    settings: &BackupSettings,
    staging: &Path,
    app_version: &str,
) -> BackupBatchResult {
    let mut outcomes = Vec::with_capacity(spaces.len());
    for desc in spaces {
        match backup_one(desc, &settings.key, &settings.dir, staging, app_version) {
            SpaceStep::Ok(made) => {
                outcomes.push(SpaceBackupOutcome { space_id: desc.id.clone(), result: Ok(made) })
            }
            SpaceStep::PerSpaceErr(e) => {
                outcomes.push(SpaceBackupOutcome { space_id: desc.id.clone(), result: Err(e) })
            }
            SpaceStep::Fatal(e, fatal) => {
                // ⛔ 只做**不可失败**的内存提交:push 当前空间的 Err → set fatal → break。
                outcomes.push(SpaceBackupOutcome { space_id: desc.id.clone(), result: Err(e) });
                return BackupBatchResult { outcomes, fatal: Some(fatal) };
            }
        }
    }
    BackupBatchResult { outcomes, fatal: None }
}

fn backup_one(
    desc: &SpaceDescriptor,
    key: &BackupKey,
    target_dir: &Path,
    staging: &Path,
    app_version: &str,
) -> SpaceStep {
    // ---- ① 只读连接 + 两格复验 ------------------------------------------------
    let conn = match open_readonly_verified(desc) {
        Ok(c) => c,
        Err(e) => return SpaceStep::PerSpaceErr(SpaceFailure::plain(e)),
    };
    let space_name = crate::spaces::space_name(&conn).ok().flatten();

    // ---- ★ guard armed(在②之前)----------------------------------------------
    let mut guard = match SnapshotGuard::arm(staging) {
        Ok(g) => g,
        Err(e) => {
            return SpaceStep::Fatal(
                SpaceFailure::plain(e.clone()),
                BatchFatal::Staging(e),
            )
        }
    };

    // ---- ② 取快照 ③ 剥派生 -------------------------------------------------------
    if let Err(e) = snapshot_and_strip(&conn, guard.path()) {
        return finish_with_cleanup(&mut guard, SpaceFailure::plain(e));
    }
    drop(conn); // 源库这边到此为止(别在写目标的整段时间里白占一个读事务)

    // ---- ④ 加密直落最终名 ---------------------------------------------------------
    let name = file_name_for(desc);
    let path = target_dir.join(&name);
    let made = match seal_into(guard.path(), &path, key, desc, space_name, app_version) {
        Ok(m) => m,
        Err((msg, artifact)) => {
            return finish_with_cleanup(&mut guard, SpaceFailure { message: msg, artifact })
        }
    };

    // ---- ⑤ 清明文(提到 fsync 与自验之前)-----------------------------------------
    if let Err(e) = guard.cleanup() {
        // ⛔ 明文删不掉 = 整批 fatal:已知盘上有明文,不许再造下一份。
        // ⭐ 但产物已经写完了(只是**还没自验**)—— 必须按 `CompleteUnverified` 报出来,
        //   ⛔ 别报成「什么都没有」(那会让用户以为这个空间白跑了,而盘上其实躺着一份
        //   可能完全可用的备份),也别报成成功(自验没跑,「成功」两个字给不出)。
        return SpaceStep::Fatal(
            SpaceFailure {
                message: format!(
                    "{e}。⚠ 这个空间的备份文件已经写出来了,但**没来得及自验**:{}",
                    made.path.display()
                ),
                artifact: Artifact::Unverified(made.path.clone()),
            },
            BatchFatal::PlaintextStuck(e),
        );
    }

    // ---- ⑥ 落定 ⑦ 自验 -------------------------------------------------------------
    if let Err(e) = fsync_dir(target_dir) {
        return SpaceStep::PerSpaceErr(discard(&path, e));
    }
    let salt = match super::verify_file(&path, key) {
        Ok(v) => v.salt,
        Err(e) => return SpaceStep::PerSpaceErr(discard(&path, format!("自验没过:{e}"))),
    };
    SpaceStep::Ok(MadeBackup { salt, ..made })
}

/// 幕④之后的失败要**先清明文再回**;明文清不掉的话失败等级当场升成整批 fatal。
fn finish_with_cleanup(guard: &mut SnapshotGuard, failure: SpaceFailure) -> SpaceStep {
    match guard.cleanup() {
        Ok(()) => SpaceStep::PerSpaceErr(failure),
        Err(e) => SpaceStep::Fatal(
            SpaceFailure {
                message: format!("{};另外:{e}", failure.message),
                artifact: failure.artifact,
            },
            BatchFatal::PlaintextStuck(e),
        ),
    }
}

/// 扔掉一个验不过的产物。删不掉就带着**残留路径**报回去(`InvalidArtifact`,三轮新义务)。
fn discard(path: &Path, message: String) -> SpaceFailure {
    match std::fs::remove_file(path) {
        Ok(()) => SpaceFailure::plain(message),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SpaceFailure::plain(message),
        Err(e) => SpaceFailure {
            message: format!("{message};而且这个坏文件也删不掉({e})——它不是一份可用的备份"),
            artifact: Artifact::Invalid(path.to_path_buf()),
        },
    }
}

/// 只读打开 + 复验物理身份与 `user_version`。
///
/// ⛔ 这两格是**手抄** `spaces::open_space` 的纪律,不是可省的礼节:裸只读打开什么都不验,
/// 与 `reset_space_files` 并发时会把换进来的新文件按旧 descriptor 的身份备走(二轮 M2)。
fn open_readonly_verified(desc: &SpaceDescriptor) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        &desc.path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("空间 {} 的库打不开 {}:{e}", desc.id, desc.path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;

    let now = crate::spaces::native_file_key(&desc.path)
        .map_err(|e| format!("空间 {} 取文件身份失败:{e}", desc.id))?;
    if now != desc.file {
        return Err(format!(
            "空间 {} 的库文件在这中间被换过了(物理身份对不上)——这一份不备,免得把别人的库\
             按这个空间的身份存下来",
            desc.id
        ));
    }
    let uv: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| format!("空间 {} 读 user_version 失败:{e}", desc.id))?;
    if uv != crate::db::SCHEMA_VERSION {
        return Err(format!(
            "空间 {} 的库版本是 v{uv},本程序是 v{}——版本对不上的库不备",
            desc.id,
            crate::db::SCHEMA_VERSION
        ));
    }
    Ok(conn)
}

/// ②+③。⚠ 这里那句 SQL 的错误话术**刻意不复述被审计的那四个字**(§7.1:`db.rs` 那道
/// 工作区级锚按**词法出现数**计,复述一次就多一格)。
fn snapshot_and_strip(conn: &Connection, dest: &Path) -> Result<(), String> {
    let dest_str = dest.to_str().ok_or("暂存路径不是合法 UTF-8")?;
    if let Err(e) = conn.execute("VACUUM INTO ?1", [dest_str]) {
        return Err(format!("取快照失败:{e}"));
    }
    // 明文整库落地了 —— 先把权限收到 0600 再动它(§5.2;目录早在 arm() 就是 0700,
    // 所以这中间没有真实暴露窗口,见 `harden_snapshot` 头注)。
    super::staging::harden_snapshot(dest)?;
    crate::sync::boot::strip_derived_from_snapshot(dest)
}

/// ④:把明文快照流式封进最终名。**`create_new` 抢名**,失败即 Err。
fn seal_into(
    snapshot: &Path,
    target: &Path,
    key: &BackupKey,
    desc: &SpaceDescriptor,
    space_name: Option<String>,
    app_version: &str,
) -> Result<MadeBackup, (String, Artifact)> {
    let mut src = std::fs::File::open(snapshot)
        .map_err(|e| (format!("读临时快照失败:{e}"), Artifact::None))?;
    let uv: i64 = crate::db::SCHEMA_VERSION;

    let mut salt = [0u8; 16];
    {
        use chacha20poly1305::aead::rand_core::RngCore;
        chacha20poly1305::aead::OsRng
            .try_fill_bytes(&mut salt)
            .map_err(|e| (format!("取随机数失败(拒绝用任何替代来源):{e}"), Artifact::None))?;
    }

    // ⛔ O_EXCL:原子 no-clobber,**没有第二个时刻**可以被抢(二轮 H2)。
    let mut out = match std::fs::OpenOptions::new().write(true).create_new(true).open(target) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err((format!("这个名字已经有文件了,没有覆盖它:{}", target.display()), Artifact::None))
        }
        Err(e) => return Err((format!("建备份文件失败 {}:{e}", target.display()), Artifact::None)),
    };

    let meta = TrailerMeta {
        space_id: desc.id.clone(),
        space_name,
        created_at: OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default(),
        app_version: app_version.to_string(),
        user_version: uv,
    };

    let sealed = write_backup(&mut src, &mut out, key, salt, CHUNK_DEFAULT, &meta)
        .and_then(|t| out.sync_all().map(|_| t).map_err(|e| format!("刷写备份文件失败:{e}")));

    match sealed {
        // ⚠ salt 这里先填写入时那一枚;幕⑦自验之后会用**读回来的那一枚**覆盖它
        //(盘上的实况才是入账凭据)。
        Ok(t) => Ok(MadeBackup { path: target.to_path_buf(), bytes: t.plain_bytes, salt }),
        Err(msg) => {
            drop(out);
            Err(match std::fs::remove_file(target) {
                Ok(()) => (msg, Artifact::None),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (msg, Artifact::None),
                Err(e) => (
                    format!("{msg};而且这个半截文件也删不掉({e})"),
                    Artifact::Invalid(target.to_path_buf()),
                ),
            })
        }
    }
}

/// 目录也要 fsync —— 不然「文件已落盘但目录项还没」在断电后就是文件不见了。
/// ⚠ Windows 上开不了目录句柄,这一步跳过(平台差异,记档不假装做到)。
fn fsync_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let f = std::fs::File::open(dir).map_err(|e| format!("打开备份目录失败:{e}"))?;
        f.sync_all().map_err(|e| format!("刷写备份目录失败:{e}"))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// 文件名:`zhujian-<spaceId 前 8>-<UTC>-<26 位 ULID>.zjbak`。
///
/// ⚠ 时间戳是 **UTC 且带 `Z`**:`time` 在多线程进程里取本地偏移会 Err,而「一个可能错 8 小时
/// 的本地时间」比「一个明确标 Z 的 UTC」更坏。UI 侧显示本地时间。
/// ⚠ 名字里**没有空间名** —— 那是用户数据,而文件名会出现在网盘目录树里。
fn file_name_for(desc: &SpaceDescriptor) -> String {
    let now = OffsetDateTime::now_utc();
    let stamp = format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    );
    let short: String = desc.id.chars().take(8).collect();
    format!("zhujian-{short}-{stamp}-{}.zjbak", ulid::Ulid::new())
}

/// 目标目录的 preflight:建得出、是目录、写得进。⛔ 不可用 = 整批 fatal(在循环之前)。
pub(crate) fn prepare_target(dir: &Path) -> Result<(), BatchFatal> {
    std::fs::create_dir_all(dir)
        .map_err(|e| BatchFatal::Target(format!("建不出 {}:{e}", dir.display())))?;
    let probe = dir.join(format!(".zjbak-write-probe-{}", ulid::Ulid::new()));
    let mut f = std::fs::File::create(&probe)
        .map_err(|e| BatchFatal::Target(format!("写不进 {}:{e}", dir.display())))?;
    let wrote = f.write_all(b"x").and_then(|_| f.sync_all());
    drop(f);
    let _ = std::fs::remove_file(&probe);
    wrote.map_err(|e| BatchFatal::Target(format!("写不进 {}:{e}", dir.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests;
