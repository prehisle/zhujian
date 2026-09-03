//! 朱简安卓壳(P4-c 捕获+时间轴+勾完成、P4-d 接同步,android-plan §0/§2/§4)。
//!
//! 定位:**119 起手机 = 全功能主力端**(用户拍板「手机须能独立作唯一端」)。
//!
//! ⭐ **OH-d/D1 起,这只壳只剩「安卓自己那一层」** —— 空间协调器(`coord`)、97 条命令面里的
//! 94 条、启动装配整段,都搬进了共享 crate [`zhujian_mobile`](仓根 `mobile/`),与鸿蒙壳
//! 逐字节同一套(形照 `zhujian-core`)。搬走的东西**一个字都没改**,判据与两只壳各自留下
//! 什么的对照表在 `mobile/src/shell.rs` 的头注。
//!
//! # 这只壳自己那四条命令(⛔ 别往共享 crate 搬)
//!
//! | 命令 | 为什么只在这一端 |
//! |---|---|
//! | `take_shared_text` / `take_deep_link` | 取的是 MainActivity 那条 Intent 薄桥落在数据根的文件 |
//! | `check_update`(见 `update.rs`) | 分发通道是 `android.json` 比 versionCode;鸿蒙没有对应的东西 |
//! | `backup_outbox_dir` | **给 Kotlin 的 SAF 桥比对用的期望值**(backup-plan §17.5 那道运行时相等闸) |
//!
//! 另有三样也只在这一端:`tauri-plugin-log`(logcat 后端)、107 的 barcode-scanner 扫码插件
//! (那个 crate 的依赖 gate 写死 `target_os = android|ios`,鸿蒙上编不过),以及
//! `tauri-plugin-notification`(用户面 39① 截止提醒;鸿蒙的对位物是 `@ohos.notificationManager`,
//! 要另写一条 ArkTS 桥,⇒ 那一端前端由 `HAS_NOTIFICATION=false` 把整节摘掉)。

mod update;

use tauri::{AppHandle, Manager};

/// 系统分享薄桥的取走端(M4,android-plan §7):MainActivity 把 ACTION_SEND 的
/// 文本原子暂存在 app 数据根。取走协议(codex P4-e 轮 M2):先把 pending
/// **rename 成 consuming 接手**,读与删都对 consuming 做。分享文本只是**预填草稿**
/// (§16.2 提案 B:草稿不带目标,保存那刻才结算落库空间)。
#[tauri::command]
fn take_shared_text(app: AppHandle) -> Result<Option<String>, String> {
    take_bridged_file(&app, "shared_text")
}

/// 深链接薄桥的取走端(4c):MainActivity 把 ACTION_VIEW 的 zhujian:// URI 原子暂存在
/// app 数据根。取走协议同分享——先 rename 成 consuming 接手,读与删都对 consuming 做
/// (取走端读不到半截、并发取走幂等)。返回 URI 字符串,前端解析后定位条目。
#[tauri::command]
fn take_deep_link(app: AppHandle) -> Result<Option<String>, String> {
    take_bridged_file(&app, "deep_link")
}

/// 上面两条**逐字相同**的取走协议(D1 顺车合的;⛔ 合的只是这一处重复,协议一个字没改)。
fn take_bridged_file(app: &AppHandle, stem: &str) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let pending = dir.join(format!("{stem}.pending"));
    let consuming = dir.join(format!("{stem}.consuming"));
    if !consuming.exists() {
        match std::fs::rename(&pending, &consuming) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        }
    }
    let text = std::fs::read_to_string(&consuming).map_err(|e| e.to_string())?;
    std::fs::remove_file(&consuming).map_err(|e| e.to_string())?;
    Ok(Some(text))
}

/// 半自动更新(106):拉 android.json 比 versionCode,更新才回条目、已最新回 null。
#[tauri::command]
async fn check_update() -> Result<Option<update::AndroidUpdate>, String> {
    let r = tauri::async_runtime::spawn_blocking(update::check)
        .await
        .map_err(|e| e.to_string())?;
    match &r {
        Ok(Some(u)) => log::info!("UPDATE_CHECK newer version={} code={}", u.version, u.version_code),
        Ok(None) => log::info!("UPDATE_CHECK up-to-date"),
        Err(e) => log::warn!("UPDATE_CHECK fail {e}"),
    }
    r
}

/// ⭐ **给 Kotlin 比对用的期望值**(backup-plan §17.5 那道运行时相等闸):壳自己算的
/// `context.dataDir/backups` 与这个不相等 ⇒ **一趟 transfer 都不许起**。
/// 理由 = 这是**漂移**类风险(tauri 改了 `getDataDir` / 我们换了 identifier),
/// 而漂移的表现会是「备份说成功了、文件搬不过去」—— 最不能静默的一类。
#[tauri::command]
fn backup_outbox_dir(app: AppHandle) -> String {
    app.state::<zhujian_mobile::BackupOutbox>().0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // wss:// 的 TLS 提供者(android-plan §1 M2,与桌面壳同纪律):启动即装,坏了当场
    // 响亮,不留到第一次连接才在 async 命令里 panic(84 真机踩过)。
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("rustls CryptoProvider 已被安装过(依赖漂移?)");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        // 106「下载」跳系统浏览器(android 忽略 openWith 参数);capability 用
        // opener:default——㊾ 踩过 allow-open-url 配空 scope 拒所有 URL 的坑。
        .plugin(tauri_plugin_opener::init())
        // 截止提醒(用户面 39①):前端 `reminder.ts` 到点调一条 sendNotification。
        // 安卓 13+ 的 POST_NOTIFICATIONS 由插件自己的清单声明 + 运行期 requestPermission
        // 那条路走,壳里不另写桥。capability 用 notification:default(同桌面壳)。
        .plugin(tauri_plugin_notification::init());
    // 107 扫码配对:官方扫码插件是移动端专属 crate(桌面 dev 构型里没有它)。
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .setup(|app| {
            // 库进 app 私有数据目录(安卓 /data/data/<pkg>/…);schema 权威与桌面
            // 共享,不可裁(android-plan §2)。
            // ⚠ **这两行是这只壳的职责,不是共享层的** —— 鸿蒙那端 `app_data_dir()`
            // 会静默给出一条别的路径(判据在 ohos 壳的 `ohos_data_dir` 头注)。
            let data_dir = app.path().app_data_dir().expect("resolve app data dir");
            let config_dir = app.path().app_config_dir().expect("resolve app config dir");
            // 租约 → 备份路径域 → Gate → blocking worker 装配,整段在共享层(顺序承重)。
            let outbox = zhujian_mobile::setup_shell(app.handle(), data_dir, config_dir);
            log::info!("BACKUP_OUTBOX {outbox}");
            Ok(())
        })
        .invoke_handler(zhujian_mobile::shared_handler![
            // ⬇ 只有这四条是安卓自己的(判据见本文件头注那张表);其余 94 条在共享清单里
            take_shared_text,
            take_deep_link,
            check_update,
            backup_outbox_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
