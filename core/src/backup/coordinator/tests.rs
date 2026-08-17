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

// ---- 备份列表与验证(§3.3 收口那条义务:UI 要显示验证状态,⛔ 文件名/扩展名不能当判据)----

/// 还没走仪式就问列表 = 「该走仪式了」,**不是**一个空列表 ——
/// 空列表会让 UI 显示成「你有 0 份备份」,而真相是「你还没设置过备份」。
#[test]
fn listing_before_the_ceremony_says_not_configured_not_empty() {
    let r = rig("list-unconfigured");
    assert!(matches!(r.coord.list_backups(), Err(BackupError::NotConfigured)));
    assert!(matches!(r.coord.verify_backup("whatever.zjbak"), Err(BackupError::NotConfigured)));
}

/// 配过但一份还没备 —— 回空,**这不是故障**。两种"空"都要测:
/// ①目录在、里面没东西(⭐ 这是仪式之后的**真实**状态 —— `validated_dir` 会 `prepare_target`
/// 把目录建出来,我第一版把前置写成"目录还不该存在",被测试当场打脸);
/// ②目录被用户删掉了 / 拔了盘 —— `NotFound` 那一支也回空,不是报错。
#[test]
fn listing_with_no_backups_yet_is_empty_not_an_error() {
    let r = rig("list-empty");
    setup(&r);
    assert!(r.paths.default_dir.exists(), "仪式会把落点建出来(prepare_target)");
    assert_eq!(r.coord.list_backups().expect("目录在、是空的"), Vec::new());

    std::fs::remove_dir_all(&r.paths.default_dir).unwrap();
    assert_eq!(r.coord.list_backups().expect("目录没了也回空"), Vec::new());
}

/// 列表只回**盘上事实**,并且新的在前;非 `.zjbak` 一概不列。
#[test]
fn listing_returns_disk_facts_newest_first_and_ignores_foreign_files() {
    let r = rig("list-two");
    setup(&r);
    let first = r.coord.run_backup().expect("第一趟").made[0].path.clone();
    // 让两份的 mtime 拉开(不然同毫秒下顺序由名字兜底,测的就不是时刻那一格了)。
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let second = r.coord.run_backup().expect("第二趟").made[0].path.clone();
    // 丢几件不该被列的进去。
    std::fs::write(r.paths.default_dir.join("笔记.txt"), b"not mine").unwrap();
    std::fs::write(r.paths.default_dir.join(".zjbak"), b"just the extension").unwrap();
    std::fs::create_dir_all(r.paths.default_dir.join("a-directory.zjbak")).unwrap();

    let list = r.coord.list_backups().expect("列表");
    let names: Vec<&str> = list.iter().map(|e| e.file_name.as_str()).collect();
    assert_eq!(list.len(), 2, "只该有两份真产物,实得 {names:?}");
    assert_eq!(list[0].path, second, "新的在前");
    assert_eq!(list[1].path, first);
    for e in &list {
        assert!(e.bytes > 0);
        assert!(e.modified_ms.is_some());
        assert!(e.file_name.ends_with(".zjbak"));
    }
}

/// 验一份真产物:回的每一格都来自 **trailer**,不是从文件名猜的。
#[test]
fn verifying_a_real_artifact_reports_fields_that_come_from_the_trailer() {
    let r = rig("verify-ok");
    setup(&r);
    let made = r.coord.run_backup().expect("备一趟").made[0].clone();
    let v = r.coord.verify_backup(&made.path).expect("该解得开");
    assert_eq!(v.space_id, "main");
    assert_eq!(v.app_version, "0.0.0-test", "app 版本来自 trailer,不是当前进程随口报的");
    assert!(v.plain_bytes > 0);
    assert!(!v.created_at.is_empty());
    // ⭐ 明文比密文大(密文另有头/帧界/trailer,但库本身可压缩性低)——这一格只钉「不是 0/没串行」。
    assert!(v.plain_bytes >= made.bytes / 2);
}

/// ⭐ **本条就是 §3.3 那句义务**:名字长得一模一样、扩展名对、大小也像,
/// 但内容是垃圾 —— **列表照列(它只回盘上事实),验证必须说不行**。
#[test]
fn a_file_named_like_a_backup_is_still_listed_but_never_passes_verification() {
    let r = rig("verify-impostor");
    setup(&r);
    let real = r.coord.run_backup().expect("先备一份真的").made[0].clone();
    // 照着真产物的名字造一个同样大小的冒牌货。
    let fake = r.paths.default_dir.join("zhujian-main-20260817T000000Z-01ZZZZZZZZZZZZZZZZZZZZZZZZZ.zjbak");
    std::fs::write(&fake, vec![0x5au8; real.bytes as usize]).unwrap();

    let list = r.coord.list_backups().expect("列表");
    assert_eq!(list.len(), 2, "冒牌货照样在列表里 —— 列表回的是盘上事实");

    let err = r.coord.verify_backup(&fake.to_string_lossy()).expect_err("绝不许通过");
    let msg = err.to_string();
    assert!(matches!(err, BackupError::VerifyFailed(_)), "实得 {err:?}");
    assert!(msg.contains("结构不对") || msg.contains("不是当前备份码"), "实得「{msg}」");
    // 真的那份照旧过。
    r.coord.verify_backup(&real.path).expect("真产物该过");
}

/// 半截文件(写数据帧中途被杀那一态)—— 验不过,且理由是**结构**不是"钥不对"。
#[test]
fn a_truncated_artifact_fails_the_structure_gate() {
    let r = rig("verify-truncated");
    setup(&r);
    let made = r.coord.run_backup().expect("备一趟").made[0].clone();
    let whole = std::fs::read(&made.path).unwrap();
    std::fs::write(&made.path, &whole[..whole.len() / 2]).unwrap();
    let msg = r.coord.verify_backup(&made.path).expect_err("该拒").to_string();
    assert!(msg.contains("结构不对"), "实得「{msg}」");
}

/// 重做过仪式之后,**旧备份用新码打不开** —— 而且报的是「不是当前备份码对应的」,
/// ⛔ 不是含糊的一句"验证失败"(那会让用户以为文件坏了,跑去删掉它)。
#[test]
fn an_artifact_from_a_previous_ceremony_says_wrong_code_not_corrupt() {
    let r = rig("verify-wrongkey");
    setup(&r);
    let old = r.coord.run_backup().expect("用旧钥备一份").made[0].clone();
    // 重做仪式 = 换一把钥(用户"重新设置了备份")。
    std::fs::remove_file(&r.paths.config_path).unwrap();
    setup(&r);
    let msg = r.coord.verify_backup(&old.path).expect_err("该拒").to_string();
    assert!(msg.contains("不是当前备份码"), "实得「{msg}」");
}

/// ⛔ **只认备份目录里的文件**:不设这道闸,这条命令就等于「拿备份钥去解任意路径的文件」。
#[test]
fn verifying_refuses_paths_outside_the_configured_backup_directory() {
    let r = rig("verify-outside");
    setup(&r);
    let made = r.coord.run_backup().expect("备一趟").made[0].clone();
    // 把那份真产物原样搬到备份目录**之外** —— 内容完全合法,唯一变的是它在哪。
    let outside = r.root.join("elsewhere");
    std::fs::create_dir_all(&outside).unwrap();
    let moved = outside.join("copy.zjbak");
    std::fs::copy(&made.path, &moved).unwrap();

    let err = r.coord.verify_backup(&moved.to_string_lossy()).expect_err("该拒");
    assert!(matches!(err, BackupError::Target(_)), "实得 {err:?}");
    assert!(err.to_string().contains("只能验备份目录"), "实得「{err}」");
    // 阳性对照:同一份内容,放回备份目录里就过 —— 证明拒的是**位置**不是内容。
    let inside = r.paths.default_dir.join("copy.zjbak");
    std::fs::copy(&moved, &inside).unwrap();
    r.coord.verify_backup(&inside.to_string_lossy()).expect("同一份内容,在目录里就该过");
}

/// 备份目录里的非 `.zjbak` 文件也拒 —— 别让「打开所在文件夹」里随便点到的东西被拿去解。
#[test]
fn verifying_refuses_files_that_are_not_zjbak() {
    let r = rig("verify-notzjbak");
    setup(&r);
    r.coord.run_backup().expect("先建出目录");
    let other = r.paths.default_dir.join("随手记.txt");
    std::fs::write(&other, b"hello").unwrap();
    let err = r.coord.verify_backup(&other.to_string_lossy()).expect_err("该拒");
    assert!(err.to_string().contains("不是一个 .zjbak"), "实得「{err}」");
}

// ---- 自动备份(笔①-b,backup-plan §15)------------------------------------------------
//
// ⭐ 这一段守的是**第二个调用方**有没有绕开既有义务,以及那两把尺(墙钟 / 单调钟)。
// 轮转本身的那一堆反例在 `backup/auto/tests.rs`。

use crate::backup::auto;

/// 把自动备份打开(并可改频率 / 份数)。⚠ 走的是真命令面,不是直接写文件。
fn enable_auto(r: &Rig, every_minutes: u32) {
    r.coord.set_auto_enabled(true).expect("开自动备份");
    let mut a = auto::load(&r.paths.auto_path).expect("读回");
    a.every_minutes = every_minutes;
    auto::save(&r.paths.auto_path, &a).expect("写回");
}

/// ⭐ 每次「重启」造一只新 coordinator:**单调尺只活在进程内**,
/// 新实例 = 新进程(跨重启只剩墙钟那把尺)。
fn restart(r: &Rig) -> BackupCoordinator {
    BackupCoordinator::new(r.paths.clone(), "0.0.0-test".into())
}

/// 29:五种「跳过」各自成格 —— ⛔ 它们**都不是故障**,UI 据此决定不弹提示。
#[test]
fn every_kind_of_skip_is_told_apart_and_produces_nothing() {
    let r = rig("auto-skips");

    // ①还没设置过备份(连钥都没有)——⚠ 默认是关的,所以先撞到的是 Disabled。
    assert!(matches!(r.coord.run_auto_if_due(), AutoTick::Skipped(AutoSkip::Disabled)));

    setup(&r);
    // ②没设置过时不许开(先 setup 才开得了;这里 setup 过了,单独验没配过那条)
    let bare = rig("auto-skips-bare");
    assert!(matches!(bare.coord.set_auto_enabled(true), Err(BackupError::NotConfigured)));

    enable_auto(&r, 1440);
    // ③仪式进行中:用户正在设置,不是故障
    let r2 = rig("auto-ceremony");
    setup(&r2);
    enable_auto(&r2, 1440);
    r2.coord.begin_setup(None).unwrap_err(); // 已经设置过 ⇒ 不会真开仪式
    {
        // 直接把 pending 摆上(等价于用户点开了"设置备份"面板)
        r2.coord.lock().pending = Some(Pending {
            key: [0u8; 32],
            dir: r2.paths.default_dir.clone(),
        });
    }
    assert!(matches!(r2.coord.run_auto_if_due(), AutoTick::Skipped(AutoSkip::CeremonyPending)));
    assert!(zjbaks(&r2.paths.default_dir).is_empty(), "跳过的每一种都不许产文件");

    // ④有别的操作在跑 ⇒ **跳过,绝不排队**
    let busy = r.coord.admit(Busy::Cleanup).expect("占住");
    assert!(matches!(
        r.coord.run_auto_if_due(),
        AutoTick::Skipped(AutoSkip::Busy(Busy::Cleanup))
    ));
    drop(busy);

    // ⑤跑过一趟之后没到点
    assert!(matches!(r.coord.run_auto_if_due(), AutoTick::Ran(_)), "第一趟该真跑");
    let after = restart(&r); // 换新实例:排除单调尺,专测墙钟那把
    assert!(matches!(after.run_auto_if_due(), AutoTick::Skipped(AutoSkip::NotDue)));
    assert_eq!(zjbaks(&r.paths.default_dir).len(), 1, "只该有第一趟那一份");
}

/// 26 / 27:设置文件坏了 / 值越界 ⇒ **响亮拒**,零产物零删除;⛔ 而**手动备份照常能跑**。
#[test]
fn a_broken_or_out_of_range_auto_file_refuses_but_never_silently_defaults() {
    let r = rig("auto-bad-file");
    setup(&r);

    // ①越界:keep = 1(⛔ 那等于每趟把该空间历史删光,而新产物可能正是 purge 后的空库)
    std::fs::write(
        &r.paths.auto_path,
        br#"{"enabled":true,"every_minutes":1,"keep":1,"next_seq":0}"#,
    )
    .unwrap();
    match r.coord.run_auto_if_due() {
        AutoTick::Refused(m) => assert!(m.contains("keep"), "话要点名:{m}"),
        other => panic!("越界必须响亮拒,实得 {other:?}"),
    }
    assert!(zjbaks(&r.paths.default_dir).is_empty(), "⛔ 一个文件都没产");
    // ⭐ 状态面也要显红并给出原话(UI 据此显示「重置自动备份设置」那颗按钮)。
    let st = r.coord.auto_status();
    assert!(st.problem.is_some() && !st.enabled, "坏了就是停下,⛔ 不许按默认值跑");

    // ②乱码
    std::fs::write(&r.paths.auto_path, b"{{{").unwrap();
    assert!(matches!(r.coord.run_auto_if_due(), AutoTick::Refused(_)));
    // ⛔ 手动那条路一点都不受影响。
    assert_eq!(r.coord.run_backup().expect("手动照常").made.len(), 1);

    // ③重置:⭐ 这里**允许**给按钮(与 `.backup.json` 那条相反)——里面没有不可再生的东西。
    let st = r.coord.reset_auto().expect("重置");
    assert!(st.problem.is_none() && !st.enabled, "重置回默认(关)");
}

/// 18:⭐ **单调尺记的是「尝试」不是「成功」** —— 否则一个持续失败的目标目录会让它
/// 每 60 秒重跑一次整库。
///
/// ⚠ 造失败用的是「**目标路径是个普通文件** ⇒ `prepare_target` 必失败」这种确定性形,
/// ⛔ 不用权限位(§10 测 6 判过不可靠:root 无视权限、Windows ACL 语义不同)。
#[test]
fn the_monotonic_ruler_counts_attempts_not_successes() {
    let r = rig("auto-attempt");
    setup(&r);
    enable_auto(&r, 1440);

    // 把落点目录换成一个普通文件 ⇒ 这一趟必失败。
    let dir = r.paths.default_dir.clone();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::write(&dir, b"not a directory").unwrap();
    match r.coord.run_auto_if_due() {
        AutoTick::Refused(_) => {}
        other => panic!("目标目录不可用该响亮拒,实得 {other:?}"),
    }

    // 现在修好目录:**同一个进程**里紧接着再叫一次 —— 该被单调尺挡住。
    std::fs::remove_file(&dir).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    assert!(
        matches!(r.coord.run_auto_if_due(), AutoTick::Skipped(AutoSkip::NotDue)),
        "⛔ 失败那一趟也占尺,否则持续失败 = 每 60 秒重跑一次整库"
    );
    assert!(zjbaks(&dir).is_empty());

    // 而「重启」之后(新实例 = 没有单调尺)照旧会再试一次 —— 失败不该让它永远不试。
    assert!(matches!(restart(&r).run_auto_if_due(), AutoTick::Ran(_)), "重启后该再试");
}

/// 32 的整链那半:⭐ 墙钟只认「这一趟至少备成了一个空间」。
#[test]
fn the_wall_clock_only_advances_when_something_was_actually_backed_up() {
    let r = rig("auto-wallclock");
    setup(&r);
    enable_auto(&r, 1440);

    // ①全失败(明文删不掉 ⇒ 整批 fatal,`made` 空)⇒ **不更新**,重启后该再试。
    staging::FAIL_CLEANUP.with(|f| f.set(true));
    let AutoTick::Ran(run) = r.coord.run_auto_if_due() else { panic!("该跑一趟") };
    assert!(run.report.made.is_empty() && run.report.fatal.is_some());
    assert!(
        auto::load(&r.paths.auto_path).unwrap().last_success_at.is_none(),
        "一个都没成 ⇒ 墙钟不许往前走"
    );
    // ⚠ 那一趟把这只 coordinator 弄成封锁态了(封锁是**实例内**状态),先解开。
    r.coord.retry_cleanup().expect("重试清扫");

    // ②真备成了 ⇒ 更新;⭐ 而且 `last_result` 是**持久**的(⛔ 不能只靠那条每进程弹一次的 banner)
    // ⚠ 换新实例是为了绕开单调尺(它只活在进程内),不是为了绕开封锁。
    let AutoTick::Ran(_) = restart(&r).run_auto_if_due() else { panic!("解封后该跑成") };
    let a = auto::load(&r.paths.auto_path).unwrap();
    assert!(a.last_success_at.is_some(), "备成了 ⇒ 墙钟往前走");
    assert!(a.last_result.as_deref().is_some_and(|s| s.contains("备好 1 个空间")), "{a:?}");
    assert_eq!(a.ledger.get("main").map(|v| v.len()), Some(1), "本机产出账记上了这一份");
}

/// 28:⭐ 结论**写不进盘**时,失败不能只写进那个刚写失败的文件(设计审 H5)。
#[test]
fn a_failed_state_write_still_reaches_the_user_through_the_pending_notice() {
    let r = rig("auto-notice");
    setup(&r);
    enable_auto(&r, 1440);
    auto::FAIL_SAVE.with(|c| c.set(true));

    let AutoTick::Ran(run) = r.coord.run_auto_if_due() else { panic!("该跑一趟") };
    assert_eq!(run.report.made.len(), 1, "⭐ 备份本身仍算成功(状态写不进不是 fatal)");

    let st = r.coord.auto_status();
    let notice = st.pending_notice.expect("⛔ 必须留一枚进程内通知给 UI 主动拉");
    assert!(notice.contains("没能记下来"), "话要说清:{notice}");
    // ⭐ **取走即清**:UI 拉过一次就不该反复弹同一句。
    assert!(r.coord.auto_status().pending_notice.is_none());
}

/// 30:⭐ **轮转与备份在同一把准入之内** —— `Admitted` 一放开,用户就能合法 `set_dir()`,
/// 于是「拿 A 目录的成功授权去删 B 目录的文件」(设计审一弹 H1)。
///
/// ⚠ 用 `cfg(test)` 的一次性 barrier 把轮转停在「当前产物已验过、还没删任何东西」那一刻,
/// 另一个线程去撞门。⛔ 这不是产品后门(发版二进制里一个字节都没有)。
#[test]
fn rotation_still_holds_the_admission_so_nobody_can_move_the_target_underneath_it() {
    use std::sync::mpsc;
    let r = rig("auto-admission");
    setup(&r);
    enable_auto(&r, 1440);

    let (reached_tx, reached_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let coord = std::sync::Arc::new(restart(&r));
    let bg = {
        let coord = std::sync::Arc::clone(&coord);
        std::thread::spawn(move || {
            // ⚠ 钩子是 thread_local:必须在**跑轮转的那个线程**里装。
            auto::BEFORE_CURRENT_VERIFY.with(|h| {
                *h.borrow_mut() = Some(Box::new(move || {
                    let _ = reached_tx.send(());
                    let _ = release_rx.recv();
                }))
            });
            let out = coord.run_auto_if_due();
            auto::BEFORE_CURRENT_VERIFY.with(|h| *h.borrow_mut() = None);
            out
        })
    };

    reached_rx.recv_timeout(std::time::Duration::from_secs(60)).expect("轮转该停在那一刻");
    // 就是这一刻:备份产物已经落盘、轮转还没删任何东西。
    let elsewhere = r.root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    match coord.set_dir(elsewhere.to_str().unwrap()) {
        Err(BackupError::BackupBusy(Busy::Backup)) => {}
        other => panic!("⛔ 轮转期间不许改落点,实得 {:?}", other.map(|_| "Ok")),
    }
    match coord.run_backup() {
        Err(BackupError::BackupBusy(Busy::Backup)) => {}
        other => panic!("⛔ 轮转期间不许再起一趟备份,实得 {:?}", other.map(|_| "Ok")),
    }
    release_tx.send(()).unwrap();
    assert!(matches!(bg.join().unwrap(), AutoTick::Ran(_)));
}

/// ⭐ **封锁态对自动这条路同样有效**:盘上躺着明文时,备份被封锁 —— 自动那条路要**响亮拒**
/// (⛔ 不是"跳过":这一种恰恰是最不该静默的,盘上有明文且备份整个停摆)。
#[test]
fn a_blocked_staging_area_refuses_the_automatic_path_too() {
    let r = rig("auto-blocked");
    setup(&r);
    enable_auto(&r, 1440);
    // 造一个启动清扫认不出来的东西 ⇒ 封锁(⛔ 未知项不删)。
    std::fs::create_dir_all(&r.paths.staging).unwrap();
    std::fs::write(r.paths.staging.join("mystery.txt"), b"?").unwrap();
    let fresh = restart(&r);
    assert!(fresh.sweep_on_start().is_some(), "夹具前提:这只实例现在是封锁态");

    match fresh.run_auto_if_due() {
        AutoTick::Refused(m) => assert!(m.contains("暂存区"), "话要说清为什么:{m}"),
        other => panic!("⛔ 封锁态必须响亮拒(不是跳过),实得 {other:?}"),
    }
    assert!(zjbaks(&r.paths.default_dir).is_empty(), "封锁着的时候一个文件都不许产");
}
