//! 朱简鸿蒙壳。
//!
//! **OH-c/C3 那轮它是「壳骨架」(四条命令);OH-d/D1 起它是「薄壳」** —— 空间协调器、
//! 94 条命令面、启动装配整段都在共享 crate [`zhujian_mobile`](仓根 `mobile/`),
//! 与安卓壳**同一份源码**。这个文件里只剩**鸿蒙自己那三样**:
//!
//! | 留在这里的 | 为什么它没法共享 |
//! |---|---|
//! | [`ohos_data_dir`] | ⛔ 这一端**不许**用 `app.path().app_data_dir()`,判据见该函数头注 |
//! | `hilog` | 日志通道不是 logcat,是 `OH_LOG_PrintMsg` |
//! | [`ohos_paths`] + C4 harness | 这一端没有控制台、私有区 `hdc` 也够不着,唯一的可观测面 |
//!
//! # 与另外两只壳的关系
//!
//! - **数据层与同步一个字都不重写** —— 全部经 `zhujian_core`,与桌面 / 安卓逐字节同一套。
//! - **启动编排照安卓那条(`prepare_mobile_catalog`),不照桌面** —— 桌面走的是
//!   `db::open` 隐式建库,一次归位原语都不碰;而鸿蒙私有区**拒 `hard_link`**
//!   (461 真机字据,与安卓 SELinux 同形),归位必须走 462/463 开出来的
//!   `renameat2` 那一支。走错编排 = 建空间当场崩在归位那一步。
//!   ⇒ D1 之后这条由共享层的 `setup_shell` 保证,两端**同一段代码**。
//! - **`cfg(mobile)` 在鸿蒙上为真**(`tauri_utils::platform::Target::is_mobile` 含
//!   `OpenHarmony`)⇒ ⛔ 安卓壳那句 `#[cfg(mobile)] .plugin(barcode_scanner::init())`
//!   **不能照抄**:那个 crate 的依赖 gate 写死在 `target_os = android|ios`,
//!   在这一端会编不过。判据与另外两样不带的东西写在 Cargo.toml 里。
//!
//! # 启动时序(与安卓同序,顺序本身是判据)
//!
//! `hilog` → panic 钩子 → rustls provider → 数据目录 → `setup_shell`
//! (**WriterLease** → 备份路径域 → Gate → blocking worker:引导快照清扫 →
//! `prepare_mobile_catalog` → 协调器 → 激活主空间 → 事件桥)。
//! ⛔ 租约必须先于任何开库;清扫必须先于任何 transport 启动。

/// C4 真机验收命令面。⛔ **编译期门控,默认不进包**(判据与诚实边界写在 `c4.rs` 头注)。
#[cfg(feature = "c4-harness")]
mod c4;
mod hilog;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{Manager, State};

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
/// ⭐ **D1 之后这条约束的作用面更大了**:共享层的 `setup_shell` 把数据目录当**入参**收,
/// 一次都不碰 `app.path()` —— 正是为了让这一端不会顺着安卓那条路走下去。
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

// ---- 壳自己的那点状态 ------------------------------------------------------

/// 这一端的诊断面要用到数据目录(C4 harness 亦然)。
///
/// ⚠ **它不再持 catalog** —— D1 起 catalog 住在共享层的 `Coord` 里,由 `setup_shell`
/// 装配。⛔ 别在这儿再存第二份:两份 catalog 会在「加入空间 / 重置」之后**各说各话**,
/// 而且不报错。
pub(crate) struct Shell {
    pub(crate) data_dir: PathBuf,
}

// ---- 诊断命令(这一端唯一的可观测面)---------------------------------------

/// **C3 面④**:各目录到底落在哪。⛔ 这条不是调试摆设 —— 「`app_data_dir` 在鸿蒙上
/// 返回什么」今天没有任何字据,而备份 staging / `writer.lock` / catalog 全挂在它下面。
/// 报的是**实得路径 + 存在性**,不是配置里写的期望值。
#[derive(Serialize)]
pub struct PathReport {
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
    log::info!("run() 进入 —— 朱简鸿蒙壳(OH-d 薄壳)");

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
            app.manage(Shell { data_dir: data_dir.clone() });
            // ⚠ **config_dir 与 data_dir 同一个目录**,这是知情的:安卓那端 tauri 的
            // `getConfigDir` 与 `getDataDir` 本来就返回同一个 `activity.dataDir`
            // (backup-plan §17.3 源码级核过)⇒ 这一端照同一个语义显式给同一个,
            // ⛔ 而不是去问 `app.path()`(那一问会落进桌面那支,见 `ohos_data_dir`)。
            let outbox = zhujian_mobile::setup_shell(app.handle(), data_dir.clone(), data_dir.clone());
            log::info!("BACKUP_OUTBOX {outbox}");
            Ok(())
        });

    // ⛔ **两份清单刻意写全、不折成一份** —— `generate_handler!` 的宏参数上挂不了 `#[cfg]`,
    // 而更要紧的是:**正式包的命令面要一眼看得见就是产品那些条**。折成一份再靠条件拼接,
    // 「验收后门有没有进正式包」这件事就得靠读宏展开去答(同 465 那三个坑的族:
    // 不报错、只给一个别的答案)。
    // ⭐ 94 条产品命令由 `zhujian_mobile::shared_handler!` 出,**两只壳零抄写**。
    #[cfg(not(feature = "c4-harness"))]
    let builder = builder.invoke_handler(zhujian_mobile::shared_handler![ohos_paths]);
    #[cfg(feature = "c4-harness")]
    let builder = builder.invoke_handler(zhujian_mobile::shared_handler![
        ohos_paths,
        c4::c4_schema,
        c4::c4_entries,
        c4::c4_create_space,
        c4::c4_publish_clobber,
        c4::c4_backup_cycle,
        c4::c4_reset_main,
        c4::c4_plant,
        c4::c4_join_space,
    ]);
    #[cfg(feature = "c4-harness")]
    log::warn!("⚠ 本包带 c4-harness 验收命令面 —— 不是正式包");

    builder.run(tauri::generate_context!()).expect("tauri 应用启动失败");
}
