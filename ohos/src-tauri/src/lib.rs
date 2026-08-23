//! 朱简鸿蒙壳(OH-c/C3 骨架)。
//!
//! **这一笔是「壳骨架」不是「全功能端」**:范围 = 让 `zhujian-core` 在鸿蒙上真正跑起来,
//! 并把 backlog 条 18 里 C3 那六条复核面各自落到一个可观测的读数上。⛔ 完整命令面
//! (灵感 / 看板 / 标签 / 搜索 / 同步 / 备份)是 OH-d 的事,别在这里长出第二份 coord.rs。
//!
//! # 与另外两只壳的关系
//!
//! - **数据层与同步一个字都不重写** —— 全部经 `zhujian_core`,与桌面 / 安卓逐字节同一套。
//! - **启动编排照安卓那条(`prepare_mobile_catalog`),不照桌面** —— 桌面走的是
//!   `db::open` 隐式建库,一次归位原语都不碰;而鸿蒙私有区**拒 `hard_link`**
//!   (461 真机字据,与安卓 SELinux 同形),归位必须走 462/463 开出来的
//!   `renameat2` 那一支。走错编排 = 建空间当场崩在归位那一步。
//! - **`cfg(mobile)` 在鸿蒙上为真**(`tauri_utils::platform::Target::is_mobile` 含
//!   `OpenHarmony`)⇒ ⛔ 安卓壳那句 `#[cfg(mobile)] .plugin(barcode_scanner::init())`
//!   **不能照抄**:那个 crate 的依赖 gate 写死在 `target_os = android|ios`,
//!   在这一端会编不过。判据与另外两样不带的东西写在 Cargo.toml 里。
//!
//! # 启动时序(与安卓同序,顺序本身是判据)
//!
//! `hilog` → panic 钩子 → rustls provider → 数据目录 → **WriterLease** →
//! (blocking worker)引导快照清扫 → `prepare_mobile_catalog` → Gate 落 Ready。
//! ⛔ 租约必须先于任何开库;清扫必须先于任何 transport 启动。

/// C4 真机验收命令面。⛔ **编译期门控,默认不进包**(判据与诚实边界写在 `c4.rs` 头注)。
#[cfg(feature = "c4-harness")]
mod c4;
mod hilog;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State};
use zhujian_core::spaces;
use zhujian_core::sync::transport;

// ---- 应用私有目录 ----------------------------------------------------------

/// 鸿蒙上的应用私有目录 = ability context 的 `filesDir`。
///
/// ⛔⛔ **绝不能用 `app.path().app_data_dir()`** —— 这是 C3 在真机上栽出来的:
/// fork 的 `crates/tauri/src/path/mod.rs` 只按 `target_os = "android"` 分了一支,
/// 而鸿蒙是 `target_os = "linux"` ⇒ 它落进**桌面那支**,拿 `dirs` crate 去解
/// `$XDG_DATA_HOME` / `$HOME/.local/share`。在应用沙箱里那条路径**建不出来**:
///
/// ```text
/// ZHUJIAN: PANIC panicked at src\lib.rs:190:48:
/// ZHUJIAN: 建不出 app 数据目录: Os { code: 1, kind: PermissionDenied, … }
/// ```
///
/// ⚠ **它不报错、只是给一条别的路径** —— 如果哪天那条路径碰巧建得出来(比如沙箱里
/// `HOME` 指到某个可写处),库就会静默落在错的地方,而不是崩。⇒ 这一处必须显式绕开,
/// **不许"先试 app_data_dir、失败再退回"**(那正是 fail-fast 铁律禁止的静默默认值)。
///
/// 正道:`@ohos-rs/ability` 的 `NativeAbility` 在 `onCreate` 里把
/// `AbilityInitContext { basePath: context.filesDir, … }` 交给 Rust 侧,
/// `OpenHarmonyApp::base_path()` 就是它。
///
/// ⛔⛔ **必须在 `Builder::run()` 之前调,不能在 `setup()` 里调** —— 第二格真机字据:
/// `tauri::ohos::APP` 是**一次性**的,`crates/tauri/src/app.rs` 建运行时那一步就
/// `.take()` 走了(`app: crate::ohos::APP.lock().unwrap().take().expect(…)`),
/// 等 `setup()` 跑到时它恒是 `None`:
///
/// ```text
/// ZHUJIAN: PANIC panicked at src\lib.rs:58:30:
/// ZHUJIAN: ohos ability 还没交给 Rust 侧(APP 是空的)
/// ```
///
/// ⇒ 入口处读一次、`move` 进 `setup` 闭包。⚠ 将来任何还想从 `APP` 拿东西的代码
/// (窗口 / 资源管理器 / 语言)都受同一条约束:**在入口处一次取全**。
fn ohos_data_dir() -> PathBuf {
    let guard = tauri::ohos::APP.lock().expect("ohos APP mutex poisoned");
    let app = guard.as_ref().expect("ohos ability 还没交给 Rust 侧(APP 是空的)");
    let base = app.base_path().expect("ability context 没给 filesDir");
    PathBuf::from(base)
}

// ---- 启动闸 ---------------------------------------------------------------

fn gate_kind_str(kind: spaces::StartupBlockKind) -> &'static str {
    match kind {
        spaces::StartupBlockKind::UpgradeRequired => "upgrade-required",
        spaces::StartupBlockKind::Retryable => "retryable",
        spaces::StartupBlockKind::RepairRequired => "repair-required",
        spaces::StartupBlockKind::ResetRequired => "reset-required",
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum GateStatus {
    /// 启动装配还在跑。前端显示「正在准备」并轮询。
    Pending,
    /// 装配整段成功才落这一态(⛔ 不许「闸已放行、装配死在半路」)。
    Ready { spaces: Vec<SpaceBrief> },
    /// 按 kind 分流处置(升级 / 重试 / 修复 / 清库),话术由前端拼。
    Blocked { kind: &'static str, message: String },
}

#[derive(Clone, Serialize)]
struct SpaceBrief {
    id: String,
    name: Option<String>,
    device_id: String,
    configured: bool,
}

/// 壳的全部运行期状态。骨架轮**刻意不缓存连接**:每条命令现开现关
/// (`spaces::open_space` 自带「先验后写」三条铁律),要证的是「这条路通」,
/// 不是连接池的形。
pub(crate) struct Shell {
    pub(crate) data_dir: PathBuf,
    gate: Mutex<GateStatus>,
    catalog: Mutex<Option<spaces::SpaceCatalog>>,
}

/// 数据目录的一行速写(名字 + 字节数),**只给日志用**。
///
/// ⭐ **为什么它是产品代码而不是 harness 的一部分**:这一端没有控制台、没有 `adb logcat`
/// 的等价物、私有区 `hdc` 也够不着 —— 「冷启之后目录里还剩什么」除了应用自己说,
/// **没有第二个人能回答**。而这正是引导清扫 / 重置续跑 / 归位残留三条路唯一的可观测面。
/// ⚠ 代价是一次 `read_dir`(几项),放在启动的 blocking worker 里,不占启动线程。
/// ⛔ 读不出的项要**留痕**,别 `.flatten()` 吃掉 —— 那可能正是要找的那份残留(438 的判据)。
fn dir_brief(dir: &Path) -> String {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => return format!("<读目录失败:{e}>"),
    };
    let mut items: Vec<String> = rd
        .map(|entry| match entry {
            Ok(e) => match e.metadata() {
                Ok(m) if m.is_dir() => format!("{}/", e.file_name().to_string_lossy()),
                Ok(m) => format!("{}({})", e.file_name().to_string_lossy(), m.len()),
                Err(err) => format!("<读不出 {}:{err}>", e.file_name().to_string_lossy()),
            },
            Err(e) => format!("<读不出目录项:{e}>"),
        })
        .collect();
    items.sort();
    if items.is_empty() {
        return "<空>".into();
    }
    items.join(" ")
}

// ---- 命令面(骨架四条,每条对着 C3 的一格复核面)---------------------------

/// 前端轮询启动闸。
#[tauri::command]
fn startup_gate(shell: State<'_, Shell>) -> GateStatus {
    shell.gate.lock().expect("gate mutex poisoned").clone()
}

/// **C3 面④**:各目录到底落在哪。⛔ 这条不是调试摆设 —— 「`app_data_dir` 在鸿蒙上
/// 返回什么」今天没有任何字据,而备份 staging / `writer.lock` / catalog 全挂在它下面。
/// 报的是**实得路径 + 存在性**,不是配置里写的期望值。
#[derive(Serialize)]
struct PathReport {
    /// 真正在用的那个(= ability context 的 `filesDir`)。
    data_dir: String,
    /// ⚠ **对照项,不是在用的** —— tauri 的 path 解析器在这一端给的是什么。
    /// 留着它是为了让「别用 app_data_dir」这条从注释变成**每次都能复现的读数**
    /// (⛔ 一条只写在注释里的禁令,下一个人不会相信它)。
    tauri_app_data_dir_claims: String,
    tauri_app_config_dir_claims: String,
    main_db: String,
    main_db_exists: bool,
    writer_lock: String,
    writer_lock_exists: bool,
    backup_staging: String,
    /// 数据目录里的直接项(只报名字,不递归)——冷启后残留物一眼可见。
    data_dir_entries: Vec<String>,
}

#[tauri::command]
fn ohos_paths(app: tauri::AppHandle, shell: State<'_, Shell>) -> Result<PathReport, String> {
    let data_dir = shell.data_dir.clone();
    let claims = |r: tauri::Result<PathBuf>| match r {
        Ok(p) => p.display().to_string(),
        Err(e) => format!("<拿不到:{e}>"),
    };
    let config_dir = claims(app.path().app_config_dir());
    let cache_dir = claims(app.path().app_data_dir());
    let main_db = data_dir.join("notebook.sqlite3");
    let writer_lock = data_dir.join("writer.lock");
    let mut entries: Vec<String> = std::fs::read_dir(&data_dir)
        .map_err(|e| format!("读数据目录失败:{e}"))?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    entries.sort();
    Ok(PathReport {
        data_dir: data_dir.display().to_string(),
        tauri_app_data_dir_claims: cache_dir,
        tauri_app_config_dir_claims: config_dir,
        main_db_exists: main_db.exists(),
        main_db: main_db.display().to_string(),
        writer_lock_exists: writer_lock.exists(),
        writer_lock: writer_lock.display().to_string(),
        backup_staging: data_dir.join(".backup-staging").display().to_string(),
        data_dir_entries: entries,
    })
}

/// **C3 面⑥ 的写半**:从 WebView 一路打到 core 的**真写入**(items + oplog + HLC),
/// 不是空壳页面启动。⛔ 别把它换成「只读一下版本号」——读路径不碰 `renameat2`、
/// 不碰触发器、不碰 WAL 写,证不到这条链。
#[tauri::command]
fn smoke_capture(shell: State<'_, Shell>, content: String) -> Result<String, String> {
    with_main_space(&shell, |conn| {
        let mut clock = zhujian_core::clock::Clock::load(conn)?;
        zhujian_core::notes::capture(conn, &mut clock, &content)
    })
}

/// **C3 面⑥ 的读半**:把刚写进去的读回来(走 core 的真投影,不自己拼 SQL)。
#[derive(Serialize)]
struct InboxBrief {
    count: usize,
    latest: Option<String>,
}

#[tauri::command]
fn smoke_inbox(shell: State<'_, Shell>) -> Result<InboxBrief, String> {
    with_main_space(&shell, |conn| {
        let rows = zhujian_core::repo::inbox_items(conn).map_err(|e| e.to_string())?;
        Ok(InboxBrief {
            count: rows.len(),
            latest: rows.first().map(|r| r.content.clone()),
        })
    })
}

/// 主空间开库 → 干活 → 关。**catalog 未就绪时响亮拒**(⛔ 不隐式重建 catalog:
/// 那会把「启动装配失败」伪装成「命令偶发失败」)。
fn with_main_space<T>(
    shell: &Shell,
    f: impl FnOnce(&mut rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let guard = shell.catalog.lock().expect("catalog mutex poisoned");
    let catalog = guard.as_ref().ok_or("启动装配还没完成(或已封锁),这条命令还不能用")?;
    let mut conn = spaces::open_space(catalog.main())?;
    f(&mut conn)
}

// ---- 入口 -----------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ⭐ 顺序承重:日志与 panic 钩子必须在**任何可能失败的东西**之前 —— 这一端没有
    // 控制台、没有 adb logcat 的等价物可以事后补,启动期崩了就只剩一个白屏。
    hilog::init();
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        hilog::raw(&format!("PANIC {info}"));
        default_hook(info);
    }));
    log::info!("run() 进入 —— 朱简鸿蒙壳(C3 骨架)");

    // wss:// 的 TLS 提供者(与另外两只壳同纪律):启动即装,坏了当场响亮,
    // 不留到第一次连接才在 async 命令里 panic(84 真机踩过)。
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("rustls CryptoProvider 已被安装过(依赖漂移?)");

    // ⛔ **必须在 `Builder::run()` 之前** —— `tauri::ohos::APP` 会被建运行时那一步
    // `.take()` 走,`setup()` 里拿不到了(见 `ohos_data_dir` 头注第二格字据)。
    let data_dir = ohos_data_dir();
    log::info!("私有目录(ability filesDir)= {}", data_dir.display());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // ⛔ 见 `ohos_data_dir` 的头注:这一端**不走** `app.path().app_data_dir()`。
            std::fs::create_dir_all(&data_dir).expect("建不出 app 数据目录");
            log::info!("数据目录 = {}", data_dir.display());

            // 单写者租约(multispace-plan §5 门 1):先于开库取目录级 OS 排他锁。
            // 锁文件永不删,句柄 manage 持到进程退出。
            // ⚠ 461 已在真机上量过 `try_lock` 在鸿蒙(musl)上三问全过 —— 没有 bionic
            // 那个「恒 Unsupported」的桩;但那是平台层复现,这里才是 core 的真路径。
            let lease = spaces::WriterLease::acquire(&data_dir.join("writer.lock"))
                .unwrap_or_else(|e| panic!("{e}"));
            app.manage(lease);
            log::info!("WriterLease 已持");

            app.manage(Shell {
                data_dir: data_dir.clone(),
                gate: Mutex::new(GateStatus::Pending),
                catalog: Mutex::new(None),
            });

            // 启动装配挪 blocking worker(照安卓 codex 设计审 H4):前滚迁移是潜在
            // O(库大小) 的同步工作,不占启动线程。JoinHandle 必须被消费——worker 内
            // 任意 panic 若只是被丢弃,Gate 永远停在 Pending、前端无限「正在准备」。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let dir = data_dir.clone();
                let joined = tauri::async_runtime::spawn_blocking(move || {
                    // ⭐ **装配之前先把目录原样报一遍**:重置续跑 / 引导清扫 / 归位残留
                    // 三条恢复路都发生在下面这几行里,而它们**做完之后现场就没了**。
                    // 一前一后两条日志 = 这一端唯一的「恢复真跑了」字据。
                    log::info!("DIR_BEFORE {}", dir_brief(&dir));
                    // 清上次进程被系统 kill 留下的**明文**引导快照;必须在任何
                    // transport 启动前。清不掉 = 响亮(明文完整库副本)。
                    let sweep = transport::sweep_stale_boot_files(&dir);
                    if !sweep.is_clean() {
                        log::error!("BOOT_SWEEP {sweep}");
                    }
                    // ⚠ 它内部串着 sweep_stale_joining → sweep_stale_creating →
                    // resume_main_reset → fresh 裁决 → 建库 → 前滚迁移 → 严格 catalog。
                    let catalog = spaces::prepare_mobile_catalog(&dir);
                    log::info!("DIR_AFTER {}", dir_brief(&dir));
                    catalog
                })
                .await;
                let shell = handle.state::<Shell>();
                let done = match joined {
                    Ok(Ok(catalog)) => {
                        let brief = catalog
                            .spaces()
                            .iter()
                            .map(|d| SpaceBrief {
                                id: d.id.clone(),
                                name: d.name.clone(),
                                device_id: d.device_id.clone(),
                                configured: d.account_id.is_some(),
                            })
                            .collect();
                        log::info!("catalog 就绪,{} 个空间", catalog.spaces().len());
                        *shell.catalog.lock().expect("catalog mutex poisoned") = Some(catalog);
                        GateStatus::Ready { spaces: brief }
                    }
                    Ok(Err(e)) => {
                        log::error!("SPACE_GATE blocked [{}]: {}", gate_kind_str(e.kind), e.message);
                        GateStatus::Blocked { kind: gate_kind_str(e.kind), message: e.message }
                    }
                    Err(join_err) => {
                        log::error!("SPACE_GATE worker died: {join_err}");
                        GateStatus::Blocked {
                            kind: "retryable",
                            message: format!("启动任务异常中断:{join_err}"),
                        }
                    }
                };
                *shell.gate.lock().expect("gate mutex poisoned") = done;
            });
            Ok(())
        });

    // ⛔ **两份清单刻意写全、不折成一份** —— `generate_handler!` 的宏参数上挂不了 `#[cfg]`,
    // 而更要紧的是:**正式包的命令面要一眼看得见就是骨架那四条**。折成一份再靠条件拼接,
    // 「验收后门有没有进正式包」这件事就得靠读宏展开去答(同 465 那三个坑的族:
    // 不报错、只给一个别的答案)。
    #[cfg(not(feature = "c4-harness"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        startup_gate,
        ohos_paths,
        smoke_capture,
        smoke_inbox,
    ]);
    #[cfg(feature = "c4-harness")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        startup_gate,
        ohos_paths,
        smoke_capture,
        smoke_inbox,
        c4::c4_schema,
        c4::c4_entries,
        c4::c4_create_space,
        c4::c4_publish_clobber,
        c4::c4_backup_cycle,
        c4::c4_reset_main,
        c4::c4_plant,
    ]);
    #[cfg(feature = "c4-harness")]
    log::warn!("⚠ 本包带 c4-harness 验收命令面 —— 不是正式包");

    builder.run(tauri::generate_context!()).expect("tauri 应用启动失败");
}
