//! 准入状态机的测试。⭐ 这是 codex 四轮点名的「第一版最该先复核」的**第 1 处**:
//! **所有入口是不是真的都经了这道门**,以及 **panic / 取消之后活动态有没有复位**。

use super::*;

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = crate::test_temp::dir().join(format!("zj-backup-coord-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct Rig {
    root: PathBuf,
    paths: BackupPaths,
    coord: BackupCoordinator,
}

/// 一台「e2e 形」的机器:真库(跑过迁移、有数据)+ 三处路径全按库派生。
fn rig(tag: &str) -> Rig {
    let root = tmp_dir(tag);
    let db = root.join("notebook.sqlite3");
    {
        let mut conn = crate::db::open(&db).expect("建库");
        let mut clock = crate::clock::Clock::load(&conn).expect("取时钟");
        for i in 0..12 {
            crate::notes::capture(&mut conn, &mut clock, &format!("条目 {i}")).expect("记一条");
        }
    }
    let paths = BackupPaths::for_db(&db);
    let coord = BackupCoordinator::new(paths.clone(), "0.0.0-test".into());
    Rig { root, paths, coord }
}

/// 走完仪式(生成 → 抄下 → 回输核对)。
fn setup(r: &Rig) {
    let code = r.coord.begin_setup(None).expect("开始仪式");
    r.coord.confirm_setup(&code).expect("回输核对");
}

fn zjbaks(dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".zjbak"))
        .collect()
}

// ---- 路径域(§3.4 那张表)-----------------------------------------------------------

/// ⛔ e2e 下三处**全按库派生** —— 用 `main_db.parent()` 的话多个 `YS_DB_PATH` 会共享
/// 同一个 `/tmp/.backup-staging` 却各持不同租约,一个测试进程能删掉另一个正在用的明文快照。
#[test]
fn e2e_paths_are_derived_per_database_not_per_parent_directory() {
    let dir = tmp_dir("paths");
    let a = BackupPaths::for_db(&dir.join("one.sqlite3"));
    let b = BackupPaths::for_db(&dir.join("two.sqlite3"));
    assert_ne!(a.staging, b.staging, "同目录下两个库的 staging 不许撞");
    assert_ne!(a.config_path, b.config_path, "配置也不许撞(⛔ 更不许碰真实用户配置)");
    assert_ne!(a.default_dir, b.default_dir);
    assert!(a.staging.starts_with(&dir) && a.staging != dir, "仍在库旁边");
    assert!(a.scan_dir.is_none(), "e2e 不扫目录");

    let prod = BackupPaths::production(Path::new("/cfg"), Path::new("/data"), Path::new("/data/notebook.sqlite3"));
    assert_eq!(prod.config_path, Path::new("/cfg/.backup.json"), "钥住配置目录");
    assert_eq!(prod.staging, Path::new("/data/.backup-staging"), "明文住数据目录(与库同卷)");
    assert_eq!(prod.scan_dir.as_deref(), Some(Path::new("/data")));
}

// ---- 四对准入 -----------------------------------------------------------------------

/// 备份 vs 备份 / 清扫 vs 清扫 / 备份 vs 清扫(两个方向都要)。
/// ⭐ 报的是「**这次请求**被拒」+ 现在跑的是哪一件 —— ⛔ 别退化成一句泛泛的"操作失败"。
#[test]
fn the_four_pairs_are_all_covered_by_admission() {
    let r = rig("pairs");
    setup(&r);

    let running = r.coord.admit(Busy::Backup).expect("先占住");
    assert_eq!(r.coord.run_backup().unwrap_err(), BackupError::BackupBusy(Busy::Backup));
    assert_eq!(r.coord.retry_cleanup().unwrap_err(), BackupError::CleanupBusy(Busy::Backup));
    assert_eq!(r.coord.status().busy, Some(Busy::Backup));
    drop(running);

    let running = r.coord.admit(Busy::Cleanup).expect("换清扫占住");
    assert_eq!(r.coord.run_backup().unwrap_err(), BackupError::BackupBusy(Busy::Cleanup));
    assert_eq!(r.coord.retry_cleanup().unwrap_err(), BackupError::CleanupBusy(Busy::Cleanup));
    drop(running);

    assert!(r.coord.status().busy.is_none(), "放开之后要回空闲");
    // 被拒的那几趟一个文件都不许产。
    assert!(zjbaks(&r.paths.default_dir).is_empty());
}

/// ⭐ **启动清扫也要走准入**(412 实现审 H2)。壳今天在 `manage` 之前调它、运行期撞不上,
/// 但「唯一门」是安全不变量,不能靠"调用点碰巧安全"撑着:`sweep_on_start` 是 `pub`,
/// 运行期误调一次就能**删掉正在备份使用的那份快照**。
#[test]
fn the_startup_sweep_goes_through_admission_too() {
    let r = rig("startup-sweep");
    let running = r.coord.admit(Busy::Backup).expect("假装有一趟备份在跑");
    let refused = r.coord.sweep_on_start().expect("必须响亮拒,不许静默跳过");
    assert!(refused.contains("没跑成"), "话要说清这一趟没跑:{refused}");
    // ⭐ 而且**真的封锁**:暂存区没验过就不许再造明文(⛔ 别只回一句话把状态留在"干净")。
    assert_eq!(r.coord.status().blocked.as_deref(), Some(refused.as_str()));
    drop(running);
    // ⛔ **再扫一次也不解封**(412 实现审二轮 M1):启动清扫**只抬不放** —— 解除封锁的
    // **只有**「重试清扫」那一条路,`sweep_on_start` 无权代替用户点那一下。
    assert!(r.coord.sweep_on_start().is_none(), "这一趟暂存区是干净的");
    assert!(r.coord.status().blocked.is_some(), "⛔ 但封锁还在:它不是第二条解封路");
    // 只有 retry_cleanup 解得开。
    assert!(r.coord.retry_cleanup().expect("重试永远进得来").blocked.is_none());
}

/// ⭐ 结构锚(412 实现审 H2 的第二半):**引擎与 staging 不出 `backup` 模块** ——
/// 它们要是 `pub(crate)`,笔①-b 的自动备份就能在 core 里直接调 `engine::backup_all`,
/// **绕开这道门**,而那正是本类存在的全部理由。⛔ 这条靠编译器守,不靠注释纪律。
#[test]
fn the_engine_and_staging_are_unreachable_from_outside_the_backup_module() {
    let src = crate::test_src::Repo::open().read("core/src/backup.rs");
    let src = crate::test_src::strip_line_comments(&src);
    for m in ["config", "coordinator", "engine", "staging"] {
        assert!(
            src.contains(&format!("\nmod {m};")),
            "`mod {m};` 必须是模块私有的(它一旦 pub(crate),crate 内任何地方都能绕过 coordinator)"
        );
        assert!(
            !src.contains(&format!("pub(crate) mod {m};")) && !src.contains(&format!("pub mod {m};")),
            "⛔ `{m}` 不许对 backup 模块之外可见"
        );
    }
    // 公开面恰好是 coordinator 那一组(壳拿得到的名字)。
    assert!(src.contains("pub use coordinator::{"), "对 crate 外的公开面只走这一处 re-export");
}

/// ⭐ 第四对:**panic 之后活动态必须复位**。准入是 RAII 发的,unwind 也归位 ——
/// 少了这一条,一次意外 panic 就把备份功能永久卡在"正忙"上,只能重启 app。
///
/// ⚠ 这只测会**故意 panic 一次**;暂时摘掉 panic hook 免得测试输出里那行栈看着像失败。
#[test]
fn a_panic_inside_an_operation_still_releases_admission() {
    let r = rig("panic");
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _admitted = r.coord.admit(Busy::Backup).expect("占住");
        panic!("(测试)备份跑到一半炸了");
    }));
    std::panic::set_hook(hook);
    assert!(out.is_err(), "夹具前提:这一趟确实 panic 了");
    assert!(r.coord.status().busy.is_none(), "⛔ panic 之后不许把活动态留在'正忙'");
    // 而且下一趟真的能跑起来。
    setup(&r);
    assert_eq!(r.coord.run_backup().expect("该能跑").made.len(), 1);
}

// ---- 封锁(Blocked 只是状态、不持锁)-------------------------------------------------

/// ①启动清扫发现不认识的东西 ⇒ 封锁;②封锁态下备份**立即拒**;③重试清扫**允许**进
/// (这一格就是"死锁式 UX"担心的解);④⛔ 未知项**不删**;⑤人清干净之后重试才回 Ready。
#[test]
fn blocked_refuses_backup_but_always_lets_retry_in() {
    let r = rig("blocked");
    setup(&r);
    std::fs::create_dir_all(&r.paths.staging).unwrap();
    let mystery = r.paths.staging.join("mystery.txt");
    std::fs::write(&mystery, b"?").unwrap();

    assert!(r.coord.sweep_on_start().is_some(), "未知项该封锁");
    match r.coord.run_backup() {
        Err(BackupError::Blocked(_)) => {}
        other => panic!("封锁态下备份必须立即拒,实得 {:?}", other.map(|_| "Ok")),
    }
    assert!(zjbaks(&r.paths.default_dir).is_empty(), "封锁着的时候一个文件都不许产");

    let st = r.coord.retry_cleanup().expect("重试永远进得来(Blocked 不持锁)");
    assert!(st.blocked.is_some(), "未知项还在,仍该封锁");
    assert!(mystery.exists(), "⛔ 不认识的东西不许删(0700 目录里出现它 = 实现漂移/手工干预)");

    std::fs::remove_file(&mystery).unwrap();
    let st = r.coord.retry_cleanup().expect("再试");
    assert!(st.blocked.is_none(), "清干净了该回 Ready");
    assert_eq!(r.coord.run_backup().expect("解封之后该能备").made.len(), 1);
}

/// ⭐ 明文删不掉 ⇒ 整批 fatal **且自此封锁**;⛔ 备份自己**不许**顺手重扫解封 ——
/// 解封只有「重试清扫」一条路(§3.4)。
#[test]
fn stuck_plaintext_blocks_the_next_backup_until_someone_retries_cleanup() {
    let r = rig("stuck");
    setup(&r);
    staging::FAIL_CLEANUP.with(|f| f.set(true));
    let report = r.coord.run_backup().expect("批处理本身不返回 Err");
    assert!(report.fatal.is_some(), "该有整批 fatal");
    assert!(report.blocked.is_some(), "⭐ 这一趟之后必须是封锁态");
    assert_eq!(report.made.len(), 0, "唯一那个空间是 Err(产物没来得及自验)");
    assert_eq!(report.failed.len(), 1);
    // ⭐ 产物按 CompleteUnverified 报出来:⛔ 不许报成「什么都没有」(盘上躺着一份
    // 可能完全可用的备份),也不许报成成功(自验没跑)。
    match &report.failed[0].leftover {
        Some(Leftover::Unverified(p)) => assert!(Path::new(p).exists(), "报了路径就该真在盘上"),
        other => panic!("该报 Unverified,实得 {other:?}"),
    }

    match r.coord.run_backup() {
        Err(BackupError::Blocked(_)) => {}
        other => panic!("下一趟必须被封锁拦下,实得 {:?}", other.map(|_| "Ok")),
    }
    // 重试清扫把那份明文收掉,才回 Ready。
    let st = r.coord.retry_cleanup().expect("重试");
    assert!(st.blocked.is_none(), "明文这回删掉了(注入是一次性的)");
    assert!(r.coord.run_backup().is_ok());
}

// ---- 仪式(§5:⛔ 不许退化成勾「我已抄下」)-------------------------------------------

/// ①没配过时备份 = `NotConfigured` 且**一个文件都不产**;②仪式没走完 = `CeremonyPending`;
/// ③回输错 = 拒**且盘上没有配置**;④对了才落盘;⑤落盘之后 `begin_setup` 拒(不许换钥)。
#[test]
fn the_ceremony_is_what_puts_the_key_on_disk_and_nothing_else_does() {
    let r = rig("ceremony");
    assert_eq!(r.coord.run_backup().unwrap_err(), BackupError::NotConfigured);
    assert!(!r.paths.config_path.exists(), "没走仪式就不许有配置");

    let code = r.coord.begin_setup(None).expect("开始");
    assert!(r.coord.status().awaiting_ceremony, "状态要说清「码还没核对」");
    assert!(!r.paths.config_path.exists(), "⭐ 显示码的这一刻钥只在内存,盘上还什么都没有");
    assert_eq!(r.coord.run_backup().unwrap_err(), BackupError::CeremonyPending);

    // 抄错一个字符。⛔ **改第一个字符,不许改最后一个** —— 末位带 4 个填充 bit,动它会被
    // 解码器的**规范性**闸先拒(`NonCanonical`),于是「比对那一格」缺了照样绿。
    // ⭐ 这不是想出来的:第一版就是改末位,变异「删掉 got != key 那道比对」**真的绿了**
    // (§10 通用纪律那条「谁会代答」的活样本)。⚠ 也别用 O↔0 / I↔1 —— 那是 Crockford
    // 规范自带的抄录容错,本来就该认。
    let mut chars: Vec<char> = code.chars().collect();
    chars[0] = if chars[0] == '0' { '1' } else { '0' };
    let wrong: String = chars.into_iter().collect();
    assert_ne!(wrong, code, "夹具前提:确实改动了一个字符");
    assert_eq!(r.coord.confirm_setup(&wrong).unwrap_err(), BackupError::CeremonyMismatch);
    assert!(!r.paths.config_path.exists(), "⛔ 抄错了绝不许落盘");
    assert!(r.coord.status().awaiting_ceremony, "还能再抄一次");

    // 分组符 / 大小写 / O↔0 这些抄录容错要认(与将来真恢复同一口径)。
    let humanised = code.replace('-', " ").to_lowercase();
    r.coord.confirm_setup(&humanised).expect("抄录容错要认");
    assert!(r.paths.config_path.exists(), "对上了才落盘");
    assert!(r.coord.status().configured);
    assert!(!r.coord.status().awaiting_ceremony);

    match r.coord.begin_setup(None) {
        Err(BackupError::Config(m)) => assert!(m.contains("已经设置过"), "{m}"),
        other => panic!("已配置过必须拒(换钥 = 已有备份解不开),实得 {:?}", other.map(|_| "Ok")),
    }
}

/// 中途关掉面板 = 盘上什么都没变,下次是干净的首次使用(⛔ 反过来「先落盘再让用户抄」
/// 会留下一把**没人抄过**的钥)。
#[test]
fn cancelling_the_ceremony_leaves_no_key_behind() {
    let r = rig("cancel");
    let first = r.coord.begin_setup(None).expect("开始");
    r.coord.cancel_setup();
    assert!(!r.paths.config_path.exists());
    assert_eq!(r.coord.confirm_setup(&first).unwrap_err(), BackupError::NoCeremony);

    // 再来一次给的是**另一把**钥(真 CSPRNG,不是某个常量)。
    let second = r.coord.begin_setup(None).expect("再来");
    assert_ne!(first, second);
    r.coord.confirm_setup(&second).expect("这次抄对");
}

/// ⛔ 坏配置**不许**当"没配过"重来一次 —— 那会换一把钥,已有备份从此永远解不开。
#[test]
fn a_corrupt_config_is_surfaced_and_never_re_keyed() {
    let r = rig("corrupt");
    setup(&r);
    let before = std::fs::read(&r.paths.config_path).unwrap();
    std::fs::write(&r.paths.config_path, "{ 这不是 JSON").unwrap();

    let st = r.coord.status();
    assert!(!st.configured);
    assert!(st.problem.is_some(), "UI 要看得见原话,而不是一句「还没设置」");
    assert!(matches!(r.coord.run_backup(), Err(BackupError::Config(_))));
    assert!(matches!(r.coord.begin_setup(None), Err(BackupError::Config(_))));
    assert_eq!(
        std::fs::read(&r.paths.config_path).unwrap(),
        b"{ \xe8\xbf\x99\xe4\xb8\x8d\xe6\x98\xaf JSON".to_vec(),
        "被拒之后那个文件一个字节都不许变"
    );
    let _ = before;
}

// ---- 落点目录 -------------------------------------------------------------------------

#[test]
fn the_target_directory_is_validated_loudly() {
    let r = rig("dir");
    setup(&r);
    match r.coord.set_dir("相对路径/backups") {
        Err(BackupError::Target(m)) => assert!(m.contains("完整路径"), "{m}"),
        other => panic!("相对路径必须响亮拒(它会按进程 CWD 解析),实得 {:?}", other.is_ok()),
    }
    match r.coord.set_dir("  ") {
        Err(BackupError::Target(_)) => {}
        other => panic!("空目录必须拒,实得 {:?}", other.is_ok()),
    }
    let as_file = r.root.join("not-a-dir");
    std::fs::write(&as_file, b"x").unwrap();
    assert!(matches!(r.coord.set_dir(as_file.to_str().unwrap()), Err(BackupError::Target(_))));

    let good = r.root.join("elsewhere");
    r.coord.set_dir(good.to_str().unwrap()).expect("换得了");
    assert_eq!(r.coord.status().dir, good.display().to_string());
    let report = r.coord.run_backup().expect("备一趟");
    assert_eq!(report.made.len(), 1);
    assert!(report.made[0].path.starts_with(&good.display().to_string()), "要落在新目录里");
}

// ---- 端到端(壳 / e2e 走的就是这条路)-------------------------------------------------

/// 仪式 → 备份 → 产物在列,且**产物是真的解得开**(自验已在幕⑦跑过,这里再证一次)。
#[test]
fn setup_then_backup_produces_a_verifiable_file() {
    let r = rig("e2e");
    setup(&r);
    let report = r.coord.run_backup().expect("该成功");
    assert!(report.fatal.is_none() && report.blocked.is_none());
    assert_eq!(report.skipped, 0);
    assert_eq!(report.failed.len(), 0);
    assert_eq!(report.made.len(), 1, "e2e 形只有主空间一个");
    assert_eq!(report.made[0].space_id, "main");
    assert!(report.made[0].bytes > 0);
    assert_eq!(zjbaks(&r.paths.default_dir).len(), 1);

    let settings = config::load(&r.paths.config_path).expect("读配置");
    crate::backup::verify_file(Path::new(&report.made[0].path), &settings.key).expect("解得开");

    // 再备一趟:名字不撞(ULID),两份都在。
    let again = r.coord.run_backup().expect("再来一趟");
    assert_ne!(again.made[0].path, report.made[0].path);
    assert_eq!(zjbaks(&r.paths.default_dir).len(), 2);
    // 明文暂存区收干净了。
    assert!(r.coord.status().blocked.is_none());
    assert_eq!(std::fs::read_dir(&r.paths.staging).map(|d| d.count()).unwrap_or(0), 0);
}
