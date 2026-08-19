//! 恢复(backup-plan §16,笔②)—— **幕①…⑥ 住这里,幕⑦(集成)在壳里**。
//!
//! # 形,一句话
//!
//! **任何成功发布的恢复必产出一个「未配置(不同步)的新空间」,⛔ 绝不覆盖任何现有数据。**
//! 于是「换纪元」那一步不必单独做:恢复出来的库天生不属于任何账户,要联网就走既有的
//! 「创建账户 + 逐台配对」—— 那等价于 §11.1 所需的**密码学隔离与旧身份拒绝效果**
//! (⛔ 不等价于换纪元的**全部**效果:旧账户与它的席位照旧在服务器上,那是运营者另一件事)。
//!
//! ```text
//! ⓪ 准入   coordinator 取 Restoring 准入(只有 Ready 给;Blocked 直接拒)  ← coordinator.rs
//! ① 验钥   用户手输备份码 → 解析 → 读 header → 比 key_check      ★ 零明文产出
//!   ★ guard armed ———— 在②之前
//! ② 解密   逐帧解 → .backup-staging/<新ULID>.sqlite3  ★明文完整库
//!          + 比 plain_bytes / plain_sha256(与 verify_backup 同一条路)
//! ③ 前滚   Connection::open → busy_timeout(5s) → foreign_keys=ON
//!          → db::run_migrations → 断言 journal_mode = delete
//! ④ 预检   integrity_check / foreign_key_check / pending_blob_count == 0
//! ⑤ 清身份 transport::clear_config → epoch::compact ★断言 Unconfigured
//! ⑥ 落定   关连接(断言无 sidecar)→ fsync → publish_no_clobber 到 <data_dir>/<新ULID>.sqlite3
//! ⑦ 集成   壳:共享集成 helper(db::open → identity_vetoes → activate_space)
//! ```
//!
//! # ⛔ 五条别改坏的
//!
//! 1. **恒新空间、恒 no-clobber、从不覆盖也不重建同名文件** —— 这正是
//!    [backlog] 两条休眠账(`NativeFileKey` / 只排斥文件重置的生命周期读租约)的触发门
//!    **不被触发**的唯一理由(§16.2 第 3 条)。哪天真要做「覆盖恢复」,那两条门当场生效。
//! 2. **幕③走 `run_migrations` 而不是 `db::open`**:后者会切 WAL(staging 里当场多出
//!    `-wal`/`-shm`,而幕⑥要挪的应当**只有一个文件**)、还会跑原地 VACUUM(`db.rs` 那道
//!    工作区级审计锚盯死的东西)。⇒ 审计锚四个桶**一个都不动**。
//! 3. **身份清场零新原语**:`transport::clear_config` + `epoch::compact` 两个既有 `pub fn`。
//!    ⛔ 别自写「只清四元组 + 自己轮换 device_id」那份 —— `device_id` 有 0019 冻结触发器,
//!    轮换手法 `epoch.rs` 里已有一份过了五轮审 + DDL 故障注入测的正式子。
//! 4. **提交点 = 幕⑥ publish 成功**。⛔ 此后任何失败都不许把「库已经在盘上」这件事撤销
//!    (集成失败走壳的 `PublishedNeedsRestart`,⛔ 不许删库)。
//! 5. **手输的那把钥绝不写回 `.backup.json`** —— 想当然的"顺手存起来下次方便"会覆盖本机
//!    自己的备份钥,此后产出的所有备份都用别人那把钥,而用户抄的是自己那张纸:静默、
//!    无提示、发现时已经攒了一堆解不开的文件。
//!
//! [backlog]: ../../../docs/backlog.md

use std::path::{Path, PathBuf};

use super::staging::SnapshotGuard;
use super::{read_frames, read_header, BackupKey, ReadError};

/// 恢复失败发生在**哪一格**。⭐ 分档是给测试用的(§10 的通用纪律 / §16.12):
/// 只断 `is_err()` 会被同一条路上更靠后的另一道闸背书成绿,那是假绿不是测试。
/// ⛔ UI 也照这个粒度说话,别糊成一句"恢复失败"。
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RestoreStage {
    /// 幕①② 读文件:六档原样带出(尤其 `WrongKey` = 「这份备份不是这个备份码的」)。
    Read(ReadError),
    /// staging 建不出 / 不是真实目录 / 明文文件建不出。
    Staging,
    /// 幕③ 两把尺不符:trailer 里的 `user_version` 与库自己的 `PRAGMA user_version`
    /// (文件被人拼过)。
    VersionMismatch,
    /// 幕③ 备份来自更新版本的朱简 —— ⛔ 响亮要求升级,绝不劝清库、绝不试着打开。
    TooNew,
    /// 幕③ 前滚失败(旧库迁不动)。
    Migrate,
    /// 幕③ 连接契约的出口复核(`journal_mode` 被切走了)。
    Contract,
    /// 幕④ `integrity_check`。
    Integrity,
    /// 幕④ `foreign_key_check`(⚠ 与幕③开外键**不互相代答**:开外键管的是**此后**的写入,
    /// 这道查的是备份文件里**已有的**行,checklist §13)。
    ForeignKey,
    /// 幕④ 还有图没下全 —— **唯一一个「正常业务态却被拒」的**(§16.3.4)。
    PendingBlob,
    /// 幕⑤ 身份清场 / 压实。
    Identity,
    /// 幕⑥ 关连接 / 出口复核 / 刷盘。
    Close,
    /// 幕⑥ 落位(撞名 / link 失败)。
    Publish,
}

/// 一趟失败。`plaintext_stuck` 是**与备份同档**的那条规则:明文删不掉 ⇒ 调用方**封锁**
/// (§16.8;已知盘上有明文,不许再造下一份)。
#[derive(Debug)]
pub(super) struct RestoreFailure {
    pub stage: RestoreStage,
    pub message: String,
    pub plaintext_stuck: Option<String>,
}

impl RestoreFailure {
    fn at(stage: RestoreStage, message: String) -> RestoreFailure {
        RestoreFailure { stage, message, plaintext_stuck: None }
    }
}

/// 一趟成功。⭐ 到这里为止「库已经在盘上」**不可撤销**。
#[derive(Debug)]
pub(super) struct Restored {
    /// 新空间的 ULID(= 落位后的文件名主干,也 = staging 里那份的名字)。
    pub space_id: String,
    pub path: PathBuf,
    /// 备份里那个空间叫什么(**trailer 里的**,给用户认领这一份是哪个空间)。
    /// ⚠ v1 刻意**不自动改名**:同机恢复后两个空间同名是已知代价(§16.13-3)。
    pub source_space_name: Option<String>,
    /// 备份是什么时候取的(trailer,RFC3339 UTC)。
    pub created_at: String,
    /// 恢复出来的库的新 `device_id`(压实轮换出来的)。
    pub device_id: String,
    /// ⭐ **空间已真实发布**,只是 staging 那个名字没清掉 —— ⛔ 绝不当作失败
    /// (hard_link 发布 = 同一 inode 两个名字,下次启动 sweep 再清一次名字,库本体无损)。
    pub cleanup_error: Option<String>,
}

/// 幕①…⑥。调用方(coordinator)负责准入、备份码解析与封锁处置。
///
/// ⚠ **`file` 是用户手上那份 `.zjbak` 的完整路径**,`key` 是他**手输**的备份码解出来的钥 ——
/// ⛔ 本函数与它的下游**没有任何一条路径**会去写 `.backup.json`(§16.6 那条坑)。
pub(super) fn restore(
    file: &Path,
    key: &BackupKey,
    staging_dir: &Path,
    target_dir: &Path,
) -> Result<Restored, RestoreFailure> {
    // ---- ① 验钥 ---------------------------------------------------------------------
    // ⛔ 到这一步为止**零应用持久化写入副作用**(⚠ 三弹 L2:文件访问时间 / 内存 /
    // coordinator 活动态照样会变,别把这句写成裸的「零副作用」)。
    let mut src = std::fs::File::open(file).map_err(|e| {
        let read = match e.kind() {
            std::io::ErrorKind::NotFound => ReadError::Missing,
            _ => ReadError::Io(format!("打开备份文件失败:{e}")),
        };
        RestoreFailure::at(RestoreStage::Read(read.clone()), read.to_string())
    })?;
    let opened = read_header(&mut src, key)
        .map_err(|e| RestoreFailure::at(RestoreStage::Read(e.clone()), e.to_string()))?;

    // ---- ★ guard armed(在②之前)-----------------------------------------------------
    // 三层清场照 §6.2:①guard 在造明文之前 armed;②可捕获路径走显式 `cleanup()`
    // (它**能**把「删不掉」上报);③`Drop` 只做 best-effort —— 真正的兜底是启动清扫。
    let mut guard = SnapshotGuard::arm(staging_dir)
        .map_err(|e| RestoreFailure::at(RestoreStage::Staging, e))?;

    // ---- ②③④⑤ + 关连接:任一失败**收敛到同一个清场收口**(checklist §6)-------------
    let closed = match prepare(&mut src, key, &opened, guard.path()) {
        Ok(v) => v,
        Err(f) => return Err(cleanup_after(&mut guard, f)),
    };
    let (trailer, device_id) = (closed.trailer.clone(), closed.device_id.clone());

    // ---- ⑥ 落定 ---------------------------------------------------------------------
    let published = match closed.publish(target_dir) {
        Ok(p) => p,
        Err(f) => return Err(cleanup_after(&mut guard, f)),
    };
    // ⭐ **提交点已过**:从这里往下,任何失败都不许把「库已经在盘上」撤销。
    // 剩下要做的只是把 staging 那个**名字**清掉(库本体是 hard_link 的另一个名字,清名字
    // 不动数据);清不掉 = 回执带 `cleanup_error`,⛔ 不是失败、⛔ 也不封锁
    // (盘上没有多出第二份明文:两个名字同一个 inode,而目标本来就是明文库)。
    let cleanup_error = guard.cleanup().err();
    Ok(Restored {
        space_id: published.space_id,
        path: published.path,
        source_space_name: trailer.space_name,
        created_at: trailer.created_at,
        device_id,
        cleanup_error,
    })
}

/// 幕②③④⑤ + 关连接。**成功返回的那个类型 = 「连接已关、无 sidecar、已刷盘」**,
/// 只有它 publish 得了(typestate,见 [`library`])。
fn prepare(
    src: &mut std::fs::File,
    key: &BackupKey,
    opened: &super::OpenedFile,
    dest: &Path,
) -> Result<library::ClosedLibrary, RestoreFailure> {
    // ---- ② 解密 ---------------------------------------------------------------------
    // ⭐ **从创建那一刻就 0600**:与备份那边**刚好相反** —— 那边的明文快照是 SQLite 的
    // `VACUUM INTO` 建的(给不了 `OpenOptions::mode`,只能事后 chmod),这边是**我们自己**
    // 建的文件,所以连那段 umask 窗口都没有。(挡着的仍是 0700 的 staging 目录那道闸。)
    let mut out = super::config::create_private(dest).map_err(|e| {
        RestoreFailure::at(RestoreStage::Staging, format!("建明文临时文件失败 {}:{e}", dest.display()))
    })?;
    let trailer = read_frames(src, &mut out, key, opened)
        .map_err(|e| RestoreFailure::at(RestoreStage::Read(e.clone()), e.to_string()))?;
    // 连接打开之前先把我们这只写句柄关掉(Windows 上开着句柄会挡后续删除)。
    drop(out);

    // ---- ③④⑤ ----------------------------------------------------------------------
    let mut lib = library::OpenLibrary::open(dest)?;
    lib.forward(trailer.user_version)?;
    lib.precheck()?;
    lib.clear_identity()?;
    lib.close(trailer)
}

/// 幕②③④⑤ 的统一清场收口:删明文四件套,**删不掉就把失败升级成"封锁"那一档**
/// (与备份 §6.1 幕⑤那条规则原样,明文整库同档)。
fn cleanup_after(guard: &mut SnapshotGuard, failure: RestoreFailure) -> RestoreFailure {
    match guard.cleanup() {
        Ok(()) => failure,
        Err(e) => RestoreFailure {
            stage: failure.stage,
            message: format!("{};另外:{e}", failure.message),
            plaintext_stuck: Some(e),
        },
    }
}

/// 幕③④⑤⑥ 的 typestate。
///
/// ⛔ **只有「连接已关 + 出口复核无 sidecar + 已刷盘」的那个类型才 publish 得了**
/// (checklist §8 / §16.14-8;照 `JoiningSlot` → `ClosedJoiningSlot` 同形)。
/// 字段私有在这个子模块里 ⇒ **父模块造不出 [`ClosedLibrary`]**,唯一产法是
/// [`OpenLibrary::close`] —— 「记得先关连接」这种纪律在这里由编译器判。
mod library {
    use super::{RestoreFailure, RestoreStage};
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};

    /// staging 里那份**明文完整库**,连接开着。
    pub(super) struct OpenLibrary {
        conn: Connection,
        path: PathBuf,
        /// 幕⑤ 压实轮换出来的新 `device_id`。`None` = 还没清过身份 ——
        /// [`OpenLibrary::close`] 据此拒绝「跳过幕⑤直接落位」(⛔ 那会把**带着原账户身份**
        /// 的库发布出去,恰是本案要防的事)。
        new_device_id: Option<String>,
    }

    /// 连接已关、出口复核过、已刷盘 —— 可以落位了。
    pub(super) struct ClosedLibrary {
        path: PathBuf,
        pub(super) trailer: super::super::Trailer,
        pub(super) device_id: String,
    }

    /// 落位成功。
    pub(super) struct PublishedLibrary {
        pub(super) space_id: String,
        pub(super) path: PathBuf,
    }

    impl OpenLibrary {
        /// 幕③ 的**连接契约四句**,少一句就不算「照抄 `JoiningSlot`」(设计审一弹 M4):
        /// `busy_timeout(5s)` → `foreign_keys = ON` → `run_migrations` → 断言
        /// `journal_mode = delete`。⚠ `run_migrations` **不会**替你打开外键 ——
        /// 仓里两处正式开库形(`db.rs:114`、`spaces.rs:1091`)都是显式设过的。
        pub(super) fn open(path: &Path) -> Result<OpenLibrary, RestoreFailure> {
            let conn = Connection::open(path).map_err(|e| {
                RestoreFailure::at(
                    RestoreStage::Migrate,
                    format!("解出来的库打不开 {}:{e}", path.display()),
                )
            })?;
            conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| {
                RestoreFailure::at(RestoreStage::Migrate, format!("设 busy_timeout 失败:{e}"))
            })?;
            conn.pragma_update(None, "foreign_keys", true).map_err(|e| {
                RestoreFailure::at(RestoreStage::Migrate, format!("打开外键失败:{e}"))
            })?;
            Ok(OpenLibrary { conn, path: path.to_path_buf(), new_device_id: None })
        }

        /// 幕③ 版本前滚。**三分支一条都不许省**(§16.5):太新 = 响亮要求升级;
        /// 相等 = `run_migrations` no-op;更旧 = 前滚(⭐「换台电脑装最新版、恢复三个月前的
        /// 备份」正是这条**真实主用例**,不许用"要求版本相同"把它省掉)。
        ///
        /// ⚠ **两把尺都要读**(checklist §13):`trailer.user_version` 只是给人看的预判,
        /// 真相以库自己的 `PRAGMA user_version` 为准 —— 不符 = 备份文件被人拼过,当场拒。
        pub(super) fn forward(&mut self, trailer_uv: i64) -> Result<(), RestoreFailure> {
            let uv: i64 =
                self.conn.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(|e| {
                    RestoreFailure::at(RestoreStage::Migrate, format!("读 user_version 失败:{e}"))
                })?;
            if uv != trailer_uv {
                return Err(RestoreFailure::at(
                    RestoreStage::VersionMismatch,
                    format!(
                        "这份备份文件自相矛盾:文件头记的库版本是 v{trailer_uv},库里写的是 v{uv} \
                         —— 文件被拼接过?不恢复"
                    ),
                ));
            }
            // ⛔ 必须拦在 `run_migrations` **之前**:它里面那道降级闸是 `assert!`(会 panic),
            // 而这里要的是一句可照做的人话。
            if uv > crate::db::SCHEMA_VERSION {
                return Err(RestoreFailure::at(
                    RestoreStage::TooNew,
                    format!(
                        "这份备份来自更新版本的朱简(库 v{uv},本程序 v{})——请先把朱简升级到\
                         那个版本再恢复",
                        crate::db::SCHEMA_VERSION
                    ),
                ));
            }
            crate::db::run_migrations(&self.conn, i64::MAX).map_err(|e| {
                RestoreFailure::at(
                    RestoreStage::Migrate,
                    format!("把这份备份从 v{uv} 前滚到 v{} 失败:{e}", crate::db::SCHEMA_VERSION),
                )
            })?;
            // 出口复核:幕⑥要挪的**只能有一个文件**,所以这条路上谁都不许切 WAL。
            let mode: String =
                self.conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).map_err(|e| {
                    RestoreFailure::at(RestoreStage::Contract, format!("读 journal_mode 失败:{e}"))
                })?;
            if mode != "delete" {
                return Err(RestoreFailure::at(
                    RestoreStage::Contract,
                    format!("恢复暂存库 journal_mode={mode}(必须 delete,连接契约被破坏)"),
                ));
            }
            Ok(())
        }

        /// 幕④ 三格预检。⛔ **话必须点名是哪一格**,别混成一句"库有问题"。
        pub(super) fn precheck(&self) -> Result<(), RestoreFailure> {
            let verdict: String =
                self.conn.pragma_query_value(None, "integrity_check", |r| r.get(0)).map_err(
                    |e| {
                        RestoreFailure::at(
                            RestoreStage::Integrity,
                            format!("integrity_check 跑不起来:{e}"),
                        )
                    },
                )?;
            if verdict != "ok" {
                return Err(RestoreFailure::at(
                    RestoreStage::Integrity,
                    format!("这份备份解出来的库自身完整性检查没过(integrity_check:{verdict}),不恢复"),
                ));
            }
            let fk_broken: i64 = {
                let mut stmt = self.conn.prepare("PRAGMA foreign_key_check").map_err(|e| {
                    RestoreFailure::at(
                        RestoreStage::ForeignKey,
                        format!("foreign_key_check 跑不起来:{e}"),
                    )
                })?;
                let mut rows = stmt.query([]).map_err(|e| {
                    RestoreFailure::at(
                        RestoreStage::ForeignKey,
                        format!("foreign_key_check 读不出来:{e}"),
                    )
                })?;
                let mut n = 0i64;
                while rows
                    .next()
                    .map_err(|e| {
                        RestoreFailure::at(
                            RestoreStage::ForeignKey,
                            format!("foreign_key_check 读不出来:{e}"),
                        )
                    })?
                    .is_some()
                {
                    n += 1;
                }
                n
            };
            if fk_broken > 0 {
                return Err(RestoreFailure::at(
                    RestoreStage::ForeignKey,
                    format!("这份备份解出来的库有 {fk_broken} 条外键违例,不恢复"),
                ));
            }
            // ⭐ 这一格提到幕④自己查(压实自己的前置里也有一条),是为了**在动任何东西之前
            // 就拒掉**,而不是让用户等到幕⑤才撞。⛔ 代价如实说:「备份时还有图没下载完字节」
            // 的那份备份,今天恢复不了 —— 话术必须点名 N 张与唯一出路。
            let missing = crate::sync::transport::pending_blob_count(&self.conn).map_err(|e| {
                RestoreFailure::at(RestoreStage::PendingBlob, format!("查图片完整性失败:{e}"))
            })?;
            if missing > 0 {
                return Err(RestoreFailure::at(
                    RestoreStage::PendingBlob,
                    format!(
                        "这份备份取的时候还有 {missing} 张图没下载完字节,恢复它会永久丢掉这些图,\
                         所以不恢复。出路只有一条:趁另一台还持有这些图,先让它同步完再重新备份"
                    ),
                ));
            }
            Ok(())
        }

        /// 幕⑤ 身份清场 —— ⭐ **本案最省的一格:两个既有 `pub fn`,零新原语。**
        ///
        /// `clear_config` 清十键(含 `pending_*` 四键,§16.3.1)→ `epoch::compact` 自己按
        /// 配置四元组分型 ⇒ 走 `Unconfigured` 分支:轮换本地 `device_id` + 重建 oplog
        /// (新 origin / HLC)+ 落 `epoch = 2`,且**事务内跑完 §2.6 那套自验收**
        /// (含六表终态等价逐行相等与 schema 三层证明)。
        /// ⭐ **恢复不发明自己的正确性证明,它复用压实那套已被五轮设计审 + 真机工序 8 压过的。**
        pub(super) fn clear_identity(&mut self) -> Result<(), RestoreFailure> {
            crate::sync::transport::clear_config(&mut self.conn).map_err(|e| {
                RestoreFailure::at(RestoreStage::Identity, format!("清除备份里的同步身份失败:{e}"))
            })?;
            let report = crate::epoch::compact(&mut self.conn).map_err(|e| {
                RestoreFailure::at(RestoreStage::Identity, format!("重建这份库的本机身份失败:{e}"))
            })?;
            // ⛔ 断言分型:清完配置还走到 Configured 分支 = 上一句没生效(必是 bug),
            // 那样恢复出来的库会**带着原账户身份**上线 —— 恰是本案要防的事。
            if report.kind != crate::epoch::CompactKind::Unconfigured {
                return Err(RestoreFailure::at(
                    RestoreStage::Identity,
                    format!("身份清场后压实仍分型为 {:?}(必是 bug),不恢复", report.kind),
                ));
            }
            self.new_device_id = Some(report.new_device_id);
            Ok(())
        }

        /// 幕⑥ 前半:关连接 → 出口复核(三件 sidecar 一件都不许有)→ fsync。
        /// ⛔ **只有它造得出 [`ClosedLibrary`]。**
        pub(super) fn close(
            self,
            trailer: super::super::Trailer,
        ) -> Result<ClosedLibrary, RestoreFailure> {
            let OpenLibrary { conn, path, new_device_id } = self;
            let device_id = new_device_id.ok_or_else(|| {
                RestoreFailure::at(RestoreStage::Close, "身份清场没跑过就来关库(必是 bug)".into())
            })?;
            if let Err((_conn, e)) = conn.close() {
                return Err(RestoreFailure::at(
                    RestoreStage::Close,
                    format!("关恢复暂存库失败:{e}"),
                ));
            }
            // 出口复核:DELETE journal 契约 —— 关完之后目录里**只能有一个文件可挪**。
            // ⚠ `-journal` 也查:它若还在,说明有事务没收尾,而 hard_link 只挪主文件
            //(照 `ClosedJoiningSlot` 那条出口复核同形,那边查 `-wal`/`-shm`,这边多查一件)。
            for suffix in ["-journal", "-wal", "-shm"] {
                let mut side = path.as_os_str().to_os_string();
                side.push(suffix);
                if Path::new(&side).exists() {
                    return Err(RestoreFailure::at(
                        RestoreStage::Close,
                        format!(
                            "恢复暂存库关闭后仍有 {} 残留(DELETE journal 契约被破坏),不落位",
                            Path::new(&side).display()
                        ),
                    ));
                }
            }
            // fsync:落位用的是 hard_link(同一 inode 两个名字),所以要刷的就是这一份。
            // ⛔ 句柄**必须带写权限**:Windows 的 `FlushFileBuffers` 对只读句柄直接
            // `ERROR_ACCESS_DENIED (os error 5)`,而 Unix 上对 O_RDONLY 的 fd 做 fsync 合法
            //(425 实测:`File::open` 的形在 Windows 上让恢复的 8 支测试全红在 `Close` 阶段,
            // Linux 那台全绿 —— 平台差异,不是抖动)。
            let f = std::fs::OpenOptions::new().write(true).open(&path).map_err(|e| {
                RestoreFailure::at(RestoreStage::Close, format!("刷盘前打开失败:{e}"))
            })?;
            f.sync_all()
                .map_err(|e| RestoreFailure::at(RestoreStage::Close, format!("刷盘失败:{e}")))?;
            Ok(ClosedLibrary { path, trailer, device_id })
        }
    }

    impl ClosedLibrary {
        /// 幕⑥ 后半:**原子 no-clobber 落位**到 `<target_dir>/<新ULID>.sqlite3`。
        ///
        /// ⚠ 名字就是 staging 里那一份的名字 —— staging 名由 `SnapshotGuard::arm` 现取的
        /// ULID 生成,**新空间的 space_id 就是它**(⛔ 绝不复用 trailer 里的原 space_id:
        /// 「原空间还在」时那会撞 catalog 的 space_id 唯一断言)。
        ///
        /// ⛔ 撞名不是"结构上不可达"(ULID 随机碰撞 / 用户预先放了个同名文件 / 外部进程
        /// 抢先建,三条反例都真实存在)—— 准确说法是:**撞名概率极低,而原子 no-clobber
        /// 保证撞名只会"拒绝",绝不覆盖**。
        pub(super) fn publish(
            self,
            target_dir: &Path,
        ) -> Result<PublishedLibrary, RestoreFailure> {
            let name = self
                .path
                .file_name()
                .ok_or_else(|| {
                    RestoreFailure::at(RestoreStage::Publish, "恢复暂存库没有文件名(必是 bug)".into())
                })?
                .to_owned();
            let space_id = Path::new(&name)
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| {
                    RestoreFailure::at(RestoreStage::Publish, "恢复暂存库文件名不合法(必是 bug)".into())
                })?
                .to_string();
            let target = target_dir.join(&name);
            crate::spaces::publish_no_clobber(&self.path, &target).map_err(|e| {
                let hint = if e.kind() == std::io::ErrorKind::AlreadyExists {
                    format!("{} 已经有文件了,没有覆盖它", target.display())
                } else {
                    format!("恢复出来的库落位失败 {}:{e}", target.display())
                };
                RestoreFailure::at(RestoreStage::Publish, hint)
            })?;
            Ok(PublishedLibrary { space_id, path: target })
        }
    }
}

#[cfg(test)]
mod tests;
