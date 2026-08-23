//! C4 真机验收命令面(OH-c/C4)。
//!
//! ⛔⛔ **这不是产品代码,而且它编译期就不该进正式包** —— 整个模块挂在
//! `feature = "c4-harness"` 上,`scripts/build-ohos.mjs` 默认**不带**它。判据照 433 在安卓
//! 那边立的先例(`SafFault.kt` + 编译期门控的故障注入):**验收要的后门做成运行期开关,
//! 迟早有人把它忘在生产包里**;做成 feature 则「忘了关」在产物里根本不存在。
//! ⚠ 随之而来的诚实边界要一直挂着:**C4 验的是带这个 feature 的包**。它只**新增命令**,
//! 不改启动路径、不改任何一处 core 调用 —— 这一条破了(比如为了验收去动 `run()` 的时序),
//! 「验的包 ≈ 发的包」就不再成立,得回来重新论证。
//!
//! # 为什么要有这一层(⛔ 别读成「图省事」)
//!
//! C4 那八格里有六格,今天在手机上**没有任何地方可以点**:真正的界面是 OH-d 的事,而
//! 「新建空间 / 备份恢复 / main 重置 / 重置续跑 / 冷启清扫」既没 UI 也没命令。
//! ⇒ 眼下不是「去验一验」,是**先得有东西可按**。
//!
//! # 读数从哪儿取:**实时 hilog,不是屏幕**
//!
//! 每条命令把结论同时 `log::info!("C4 …")` 一份 ⇒ PC 侧脚本挂着 `hdc shell "hilog"` 收就行,
//! 不必去认屏幕上的字(那条路要么 OCR 要么按坐标截图,两样都脆)。
//! ⛔ **别改用 `hilog -x` 事后捞**:2026-08-23 实测那份里我们的行**一条都没有**(同一趟冷启,
//! 实时流里 `run() 进入 / 私有目录 / WriterLease 已持 / catalog 就绪` 一条不少)——
//! 那是这一端「不报错、只给一个别的答案」的又一形。
//!
//! # 两条纪律
//!
//! - ⭐ **预置盘上状态 → 调恢复函数**(C4 清单点名的确定形):`c4_plant` 把半态摆好,
//!   恢复那半由**真正的启动路径**去跑(`prepare_mobile_catalog` 里本来就有
//!   `sweep_stale_joining` → `sweep_stale_creating` → `resume_main_reset` 三步)。
//!   ⛔ 不靠随机抢杀去命中窗口。
//! - ⛔ **harness 不自己实现任何数据层动作** —— 每条命令都只是「调 core 的那个 pub fn +
//!   把读数摊开」。它要是自己写了一份归位 / 清扫 / 迁移,验的就是 harness 不是产品。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use zhujian_core::backup::{BackupCoordinator, BackupPaths};
use zhujian_core::spaces;

use crate::Shell;

// ---- 公共读数件 ------------------------------------------------------------

/// 数据目录里的一项。⭐ **带大小与目录标记** —— 「无残留」这句话要能被一眼证伪:
/// 只报名字的话,一个 0 字节的半截 staging 和一份正经库长得一样。
#[derive(Serialize, Clone)]
pub struct Entry {
    name: String,
    bytes: u64,
    is_dir: bool,
}

/// 只列直接项,**不递归**(与 `ohos_paths` 同口径)。读不出的项**响亮**成一条
/// `<读不出:…>` 记录,⛔ 不静默跳过 —— 那正可能是要找的那份残留(同 438 的判据)。
fn list_dir(dir: &Path) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            out.push(Entry { name: format!("<读目录失败:{e}>"), bytes: 0, is_dir: false });
            return out;
        }
    };
    for entry in rd {
        match entry {
            Ok(e) => {
                let (bytes, is_dir) = match e.metadata() {
                    Ok(m) => (m.len(), m.is_dir()),
                    Err(err) => {
                        out.push(Entry {
                            name: format!("<读不出 {}:{err}>", e.file_name().to_string_lossy()),
                            bytes: 0,
                            is_dir: false,
                        });
                        continue;
                    }
                };
                out.push(Entry { name: e.file_name().to_string_lossy().into_owned(), bytes, is_dir });
            }
            Err(e) => out.push(Entry { name: format!("<读不出目录项:{e}>"), bytes: 0, is_dir: false }),
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 一行人话的目录快照,专给 hilog 用(JSON 太长,hilog 单条会被切块)。
fn brief(entries: &[Entry]) -> String {
    entries
        .iter()
        .map(|e| if e.is_dir { format!("{}/", e.name) } else { format!("{}({})", e.name, e.bytes) })
        .collect::<Vec<_>>()
        .join(" ")
}

fn main_db(shell: &Shell) -> PathBuf {
    shell.data_dir.join("notebook.sqlite3")
}

/// 预置用的固定 ULID。⭐ **刻意不引 `ulid` crate**(壳里今天没有这个依赖,为 harness
/// 添一条依赖 = 给第六份 `Cargo.lock` 添一个会漂移的条目,而 `check-lock-drift` 正盯着它)。
/// ⚠ 这个串必须过 `spaces::is_ulid_name` 的严格白名单:恰 26 字符、首字符 ≤ '7'、
/// 全部落在 Crockford base32(**去掉 I/L/O/U** —— 所以拼不出 "PLANT",只能是 "PANT")。
const PLANT_ULID: &str = "01M0C4PANT0000000000000000";

// ---- ① schema:建库到底建对了没有 -----------------------------------------

/// **C4 面① 缺的那一格**:`startup_gate` 只答「装配成功了」,答不了「schema 是第几版、
/// 表齐不齐」。这里**直接只读开库读 pragma**,⛔ 刻意不走 `open_space`:
/// 那条路带「先验后写」的身份裁决,而这一格要问的是**盘上那份库本身**是什么样。
#[derive(Serialize)]
pub struct SchemaReport {
    path: String,
    user_version: i64,
    /// 本程序自带的目标版本 —— ⭐ 与上面那格**分开报**,判据是「两者相等」而不是
    /// 「等于 35」(把期望值写死进验收脚本 = 数字腐烂,memory `stale-number-in-docs-and-fixtures`)。
    schema_version_expected: i64,
    table_count: usize,
    tables: Vec<String>,
    device_id: Option<String>,
}

#[tauri::command]
pub fn c4_schema(shell: State<'_, Shell>) -> Result<SchemaReport, String> {
    read_schema(&main_db(&shell))
}

/// ⚠ 抽成普通函数是有原因的:`c4_reset_main` 要在删库**之前**先读一次身份,
/// 而 `State` 不能就这么再传一次(命令函数不是给内部复用的)。
fn read_schema(path: &Path) -> Result<SchemaReport, String> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("只读开库失败 {}:{e}", path.display()))?;
    let user_version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| format!("读 user_version 失败:{e}"))?;
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|e| format!("列表失败:{e}"))?;
    let tables: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| format!("列表失败:{e}"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("列表失败:{e}"))?;
    // device_id 缺了不是 harness 的错,是被验的东西错了 ⇒ 报 None,⛔ 别 `?` 掉整条命令。
    let device_id: Option<String> = conn
        .query_row("SELECT value FROM sync_meta WHERE key = 'device_id'", [], |r| r.get(0))
        .ok();
    let out = SchemaReport {
        path: path.display().to_string(),
        user_version,
        schema_version_expected: zhujian_core::db::SCHEMA_VERSION,
        table_count: tables.len(),
        tables,
        device_id,
    };
    log::info!(
        "C4 schema user_version={} 期望={} 表={} device_id={}",
        out.user_version,
        out.schema_version_expected,
        out.table_count,
        out.device_id.as_deref().unwrap_or("<没有>")
    );
    Ok(out)
}

// ---- 目录清单 --------------------------------------------------------------

#[tauri::command]
pub fn c4_entries(shell: State<'_, Shell>) -> Result<Vec<Entry>, String> {
    let entries = list_dir(&shell.data_dir);
    log::info!("C4 entries {}", brief(&entries));
    Ok(entries)
}

// ---- ② 新建空间 -----------------------------------------------------------

#[derive(Serialize)]
pub struct CreateOut {
    space_id: String,
    path: String,
    entries_after: Vec<Entry>,
}

/// **C4 面②**。走的正是 462/463 开出来的鸿蒙归位支(`renameat2` + `RENAME_NOREPLACE`)——
/// 461 只在**平台层**复现过 `link()` 被拒,这一条是 **core 的真路径**。
#[tauri::command]
pub fn c4_create_space(shell: State<'_, Shell>, name: String) -> Result<CreateOut, String> {
    let (space_id, path) = spaces::create_space(&shell.data_dir, &name)?;
    let entries_after = list_dir(&shell.data_dir);
    log::info!("C4 create_space id={space_id} path={} 之后 {}", path.display(), brief(&entries_after));
    Ok(CreateOut { space_id, path: path.display().to_string(), entries_after })
}

// ---- ④ 归位撞名:publish 必须响亮 EEXIST,⛔ 不许盖 ------------------------

#[derive(Serialize)]
pub struct ClobberOut {
    target: String,
    /// 撞名那一下的原话(**必须是失败**;成功 = 数据被盖了 = 这一格当场红)。
    publish_error: Option<String>,
    /// 撞名之后目标文件的字节数与内容首行 —— 判据是「一个字节没变」。
    target_bytes_before: u64,
    target_bytes_after: u64,
    target_head_before: String,
    target_head_after: String,
    entries_after: Vec<Entry>,
}

/// **C4 面④(不需要服务器的那一半)**:C4 清单原话是「加入空间撞名 ⇒ publish 返 EEXIST、
/// 目标字节不变、staging 可 abort」。整条「加入空间」要一台够得着的同步服务器(那是③,
/// 另一批),⛔ **但撞名这一格不需要** —— 它问的是**归位原语**在鸿蒙上撞到已存在目标时
/// 的行为,而那正是 462/463 改的东西。
///
/// 做法:`JoiningSlot::create` 造一个真 staging 槽 → 在它要归位的目标路径上**预先**放一份
/// 认得出的文件 → `close()` → `publish()` ⇒ 必须失败且目标一字未动。
/// ⭐ 这是「预置磁盘状态 → 调那个函数」的确定形,不抢窗口。
#[tauri::command]
pub fn c4_publish_clobber(shell: State<'_, Shell>) -> Result<ClobberOut, String> {
    let dir = &shell.data_dir;
    let slot = spaces::JoiningSlot::create(dir)?;
    let target = dir.join(format!("{}.sqlite3", slot.id()));
    // 预置:目标位置先放一份**不是库**的文件(内容认得出,好判「有没有被盖」)。
    let marker = format!("C4-EEXIST-{}\n", slot.id());
    std::fs::write(&target, &marker).map_err(|e| format!("预置目标失败 {}:{e}", target.display()))?;
    let bytes_before = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    let head_before = std::fs::read_to_string(&target).unwrap_or_default().trim().to_string();

    let closed = slot.close().map_err(|f| format!("close 失败:{}", f.error))?;
    let publish_error = match closed.publish() {
        // ⛔ 成功 = 归位把预置那份盖掉了。别把它翻译成一句和缓的话,原样报上去。
        Ok(_) => None,
        Err((back, e)) => {
            // staging 还在手上 ⇒ 照 C4 清单要求验一格「可 abort」。
            let abort = back.abort().err();
            Some(match abort {
                None => e,
                Some(a) => format!("{e}(⚠ 随后 abort 也失败:{a})"),
            })
        }
    };
    let bytes_after = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    let head_after = std::fs::read_to_string(&target).unwrap_or_default().trim().to_string();
    // 收场:把预置那份删掉,别给后续格子留一个假空间库。
    let _ = std::fs::remove_file(&target);
    let entries_after = list_dir(dir);
    log::info!(
        "C4 publish_clobber 目标={} 撞名结果={} 字节 {}→{} 首行同={} 之后 {}",
        target.display(),
        publish_error.as_deref().unwrap_or("<⛔ 竟然成功了>"),
        bytes_before,
        bytes_after,
        head_before == head_after,
        brief(&entries_after)
    );
    Ok(ClobberOut {
        target: target.display().to_string(),
        publish_error,
        target_bytes_before: bytes_before,
        target_bytes_after: bytes_after,
        target_head_before: head_before,
        target_head_after: head_after,
        entries_after,
    })
}

// ---- ⑤ 备份 → 恢复一条龙 --------------------------------------------------

#[derive(Serialize)]
pub struct BackupOut {
    /// ⚠ 明文回报备份码 —— 这是**验收包**才有的东西(整个模块挂在 feature 上),
    /// 而恢复那一步要用它。⛔ 产品里绝不能有这一格。
    code: String,
    made: usize,
    made_paths: Vec<String>,
    failed: Vec<String>,
    skipped: usize,
    fatal: Option<String>,
    listed: usize,
    verified_space_name: Option<String>,
    verified_plain_bytes: u64,
    restored_space_id: String,
    restored_path: String,
    restored_source_name: Option<String>,
    restored_device_id: String,
    restored_cleanup_error: Option<String>,
    entries_after: Vec<Entry>,
}

/// **C4 面⑤**:仪式 → 备份 → 列表 → 验证 → 恢复,一条龙。
///
/// ⚠⚠ **一处夹具代演,必须如实记**(memory `fixture-played-step-is-untested-assumption`):
/// 仪式里「把 52 位备份码抄到纸上再输回去」那一步,真机上是**用户动作**,这里由 harness
/// 直接把 `begin_setup` 回来的码喂给 `confirm_setup`。⇒ 这一格证明的是**核对逻辑通**,
/// **不证明**「手机上那个仪式界面能用」—— 那是 OH-d 的活,得另外一格。
///
/// ⭐ 恢复产出的是「**未配置的新空间**」,⛔ 不是「你的库回来了」(§16.11)。
#[tauri::command]
pub fn c4_backup_cycle(shell: State<'_, Shell>) -> Result<BackupOut, String> {
    let dir = shell.data_dir.clone();
    // 鸿蒙上配置目录与数据目录是同一个(ability 的 filesDir)—— 与安卓同形。
    let paths = BackupPaths::production(&dir, &dir, &main_db(&shell));
    let coord = BackupCoordinator::new(paths, env!("CARGO_PKG_VERSION").to_string());

    let code = coord.begin_setup(None).map_err(|e| format!("仪式起头失败:{e}"))?;
    coord.confirm_setup(&code).map_err(|e| format!("备份码回输核对失败:{e}"))?;
    log::info!("C4 backup 仪式过了,备份码={code}");

    let report = coord.run_backup().map_err(|e| format!("备份失败:{e}"))?;
    let made_paths: Vec<String> = report.made.iter().map(|m| m.path.clone()).collect();
    let failed: Vec<String> =
        report.failed.iter().map(|f| format!("{}:{}", f.space_id, f.message)).collect();
    log::info!(
        "C4 backup 做好 {} 份 失败 {} 没跑 {} fatal={}",
        report.made.len(),
        failed.len(),
        report.skipped,
        report.fatal.as_deref().unwrap_or("<无>")
    );

    let listed = coord.list_backups().map_err(|e| format!("列表失败:{e}"))?;
    let first = listed
        .first()
        .ok_or("备份做好了,但列表里一份都没有 —— 这本身就是缺陷,别当环境问题")?;
    let verified = coord.verify_backup(&first.path).map_err(|e| format!("验证失败:{e}"))?;
    log::info!(
        "C4 backup 列表 {} 份;验第一份 {} 空间名={} 原库={}B",
        listed.len(),
        first.file_name,
        verified.space_name.as_deref().unwrap_or("<没有名字>"),
        verified.plain_bytes
    );

    let restored = coord
        .restore_backup(&first.path, &code)
        .map_err(|e| format!("恢复失败:{e}"))?;
    let entries_after = list_dir(&dir);
    log::info!(
        "C4 restore 新空间={} 来自={} 新 device_id={} 收尾={} 之后 {}",
        restored.space_id,
        restored.source_space_name.as_deref().unwrap_or("<没有名字>"),
        restored.device_id,
        restored.cleanup_error.as_deref().unwrap_or("干净"),
        brief(&entries_after)
    );

    Ok(BackupOut {
        code,
        made: report.made.len(),
        made_paths,
        failed,
        skipped: report.skipped,
        fatal: report.fatal,
        listed: listed.len(),
        verified_space_name: verified.space_name,
        verified_plain_bytes: verified.plain_bytes,
        restored_space_id: restored.space_id,
        restored_path: restored.path,
        restored_source_name: restored.source_space_name,
        restored_device_id: restored.device_id,
        restored_cleanup_error: restored.cleanup_error,
        entries_after,
    })
}

// ---- ⑥ main 重置正路 ------------------------------------------------------

#[derive(Serialize)]
pub struct ResetOut {
    path: String,
    device_id_before: Option<String>,
    entries_after: Vec<Entry>,
}

/// **C4 面⑥**。⚠ **破坏性**:主库三件套被删掉、原地换成当前 schema 的空库。
/// ⛔ 跑完这条之后 `catalog` 里缓存的描述符就是陈的(它记着旧库的身份)——
/// **必须重启 app 才能继续用别的命令**,这不是缺陷,是 `reset_main_files` 的调用契约
/// (真产品里它由重置流程带着走完整的收场)。验收脚本负责在这一格之后重启。
#[tauri::command]
pub fn c4_reset_main(shell: State<'_, Shell>) -> Result<ResetOut, String> {
    // 读不到不算失败(库可能本来就是刚重置过的空库)⇒ `.ok()`,⛔ 别把它 `?` 成整条命令的错。
    let before = read_schema(&main_db(&shell)).ok().and_then(|s| s.device_id);
    let path = spaces::reset_main_files(&shell.data_dir)?;
    let entries_after = list_dir(&shell.data_dir);
    log::info!(
        "C4 reset_main 重建={} 旧 device_id={} 之后 {}",
        path.display(),
        before.as_deref().unwrap_or("<读不到>"),
        brief(&entries_after)
    );
    Ok(ResetOut { path: path.display().to_string(), device_id_before: before, entries_after })
}

// ---- ⑦⑧ 预置盘上状态 -----------------------------------------------------

#[derive(Serialize)]
pub struct PlantOut {
    kind: String,
    planted: Vec<String>,
    removed: Vec<String>,
    entries_after: Vec<Entry>,
}

/// **⑦⑧ 的前半**:把半态摆到盘上,恢复那半交给**真正的启动路径**去跑
/// (`prepare_mobile_catalog` 里本来就串着 `sweep_stale_joining` → `sweep_stale_creating`
/// → `resume_main_reset`;`sweep_stale_boot_files` 在壳的 worker 里更靠前)。
/// ⇒ 验收脚本的形恒是:**plant → force-stop → start → 收启动那几行日志**。
///
/// ⛔ **别把恢复也塞进 harness 里调一遍** —— 那验的就成了「core 那个函数能跑」,
/// 而 C4 要证的是「**这一端的启动路径真的会去跑它**」。
///
/// 六种 kind:
/// - `creating`     建库中途死掉的 staging(`.creating-main` + `.creating-<ULID>`)
/// - `joining`      加入空间中途死掉的槽(`.joining-<ULID>`)——⚠ 它可能含密钥明文,
///                  清扫失败按设计要**封锁启动**,不静默
/// - `orphan-side`  主库不在的孤儿 `-wal`/`-shm`
/// - `boot-residue` 引导快照残留(`boot-snapshot-*` / `boot-recv-*`)
/// - `reset-a`      重置半态①:只写了 journal(旧库完整)
/// - `reset-b`      重置半态②:journal + 旧三件套已删(库不在)
/// - `reset-c`      重置半态③:journal + 库不在 + 留着一份 `.creating-main` staging
#[tauri::command]
pub fn c4_plant(shell: State<'_, Shell>, kind: String) -> Result<PlantOut, String> {
    let dir = &shell.data_dir;
    let mut planted: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();

    // 一律写**认得出的非空内容**:0 字节的残留与「清扫其实没跑但文件本来就没有」
    // 在读数上分不开(memory `verification-independence` 那条的同族)。
    let put = |name: &str, planted: &mut Vec<String>| -> Result<(), String> {
        let p = dir.join(name);
        std::fs::write(&p, format!("C4-PLANT-{name}\n"))
            .map_err(|e| format!("预置失败 {}:{e}", p.display()))?;
        planted.push(name.to_string());
        Ok(())
    };
    let drop_main = |removed: &mut Vec<String>| {
        for n in ["notebook.sqlite3", "notebook.sqlite3-wal", "notebook.sqlite3-shm"] {
            if std::fs::remove_file(dir.join(n)).is_ok() {
                removed.push(n.to_string());
            }
        }
    };
    let fake_ulid = PLANT_ULID;

    match kind.as_str() {
        "creating" => {
            put(".creating-main.sqlite3", &mut planted)?;
            put(&format!(".creating-{fake_ulid}.sqlite3"), &mut planted)?;
        }
        "joining" => {
            put(&format!(".joining-{fake_ulid}.sqlite3"), &mut planted)?;
        }
        "orphan-side" => {
            put(&format!("{fake_ulid}.sqlite3-wal"), &mut planted)?;
            put(&format!("{fake_ulid}.sqlite3-shm"), &mut planted)?;
        }
        "boot-residue" => {
            put(&format!("boot-snapshot-{fake_ulid}"), &mut planted)?;
            put(&format!("boot-recv-{fake_ulid}"), &mut planted)?;
        }
        "reset-a" => {
            put(".reset-main.journal", &mut planted)?;
        }
        "reset-b" => {
            put(".reset-main.journal", &mut planted)?;
            drop_main(&mut removed);
        }
        "reset-c" => {
            put(".reset-main.journal", &mut planted)?;
            drop_main(&mut removed);
            put(".creating-main.sqlite3", &mut planted)?;
        }
        other => return Err(format!("不认得的预置态:{other}(⛔ 别猜,看 c4.rs 里那六种)")),
    }

    let entries_after = list_dir(dir);
    log::info!(
        "C4 plant kind={kind} 放下=[{}] 删掉=[{}] 之后 {}",
        planted.join(" "),
        removed.join(" "),
        brief(&entries_after)
    );
    Ok(PlantOut { kind, planted, removed, entries_after })
}
