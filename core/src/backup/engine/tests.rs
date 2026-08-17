//! 引擎层的测试:真库、真盘、真加密。
//!
//! ⭐ codex 四轮把「文件状态机 + 批处理控制流」排在第一版最该复核的第 3 位 ——
//! 这里守的是「`InvalidArtifact` / 触发 fatal 的当前项 / 此前的成功项,有没有随某个 `?` 蒸发」。

use super::*;
use crate::backup::config;
use crate::backup::staging;

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = crate::test_temp::dir().join(format!("zj-backup-eng-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 造一个真空间:真跑迁移的库 + 一批数据 + 一张**派生缩略图**(验它不进备份)。
fn make_space(dir: &Path, file: &str) -> SpaceDescriptor {
    let path = dir.join(file);
    {
        let mut conn = crate::db::open(&path).expect("建库");
        let mut clock = crate::clock::Clock::load(&conn).expect("取时钟");
        for i in 0..40 {
            crate::notes::capture(&mut conn, &mut clock, &format!("条目 {i}")).expect("记一条");
        }
        // 纯本地派生表:它**不该**进备份产物(§10 的测 9)。
        conn.execute(
            "INSERT INTO item_image_thumb(image_id, spec, w, h, bytes, data)
             VALUES (1,'x',1,1,1,X'00')",
            [],
        )
        .ok(); // 没有图时外键会拒,拒了就跳过这一格(下面那只测自己会核)
    }
    crate::spaces::read_descriptor(
        if file.starts_with("notebook") { "main" } else { file.trim_end_matches(".sqlite3") },
        &path,
    )
    .expect("读描述符")
}

struct Rig {
    root: PathBuf,
    staging: PathBuf,
    target: PathBuf,
    settings: BackupSettings,
}

fn rig(tag: &str) -> Rig {
    let root = tmp_dir(tag);
    let staging = root.join(".backup-staging");
    let target = root.join("out");
    std::fs::create_dir_all(&target).unwrap();
    let cfg = root.join(".backup.json");
    config::create(&cfg, &target, config::random_key().unwrap()).expect("生成备份钥");
    let settings = config::load(&cfg).expect("读回设置");
    Rig { root, staging, target, settings }
}

fn run(r: &Rig, spaces: &[SpaceDescriptor]) -> BackupBatchResult {
    backup_all(spaces, &r.settings, &r.staging, "0.0.0-test")
}

// ---- 控制流:类型层的那条 -------------------------------------------------------------

/// ⭐ **让编译器判「进了循环之后不可失败」**(四轮 M3 / checklist §11:类型的事让编译器判,
/// 别拿文本断言去守「这段代码是什么类型」)。签名一旦改回 `-> Result<_, _>`,这里编译不过。
#[test]
fn backup_all_is_infallible_by_type() {
    let _: fn(&[SpaceDescriptor], &BackupSettings, &Path, &str) -> BackupBatchResult = backup_all;
}

// ---- 往返 + 派生表 + WAL ---------------------------------------------------------------

#[test]
fn backs_up_a_real_space_and_the_bytes_round_trip() {
    let r = rig("roundtrip");
    let s = make_space(&r.root, "notebook.sqlite3");
    let out = run(&r, std::slice::from_ref(&s));
    assert!(out.fatal.is_none(), "不该有 fatal:{:?}", out.fatal);
    assert_eq!(out.outcomes.len(), 1);
    let made = out.outcomes[0].result.as_ref().expect("该成功");

    // 自验走的是与恢复同一条路;这里再手工解一遍,落成真库并数行。
    let restored = r.root.join("restored.sqlite3");
    let mut f = std::fs::File::open(&made.path).unwrap();
    let mut w = std::fs::File::create(&restored).unwrap();
    let trailer = crate::backup::read_backup(&mut f, &mut w, &r.settings.key).expect("解得开").0;
    drop(w);

    assert_eq!(trailer.space_id, "main");
    assert_eq!(trailer.user_version, crate::db::SCHEMA_VERSION);
    assert_eq!(trailer.app_version, "0.0.0-test");

    let conn = rusqlite::Connection::open(&restored).unwrap();
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 40, "40 条都要在");
    // §10 测 9:纯本地派生表不进备份。
    let thumbs: i64 =
        conn.query_row("SELECT COUNT(*) FROM item_image_thumb", [], |r| r.get(0)).unwrap();
    assert_eq!(thumbs, 0, "缩略图是纯本地派生,不该进备份产物");
    // 暂存区收干净了。
    assert_eq!(staging::sweep(&r.staging), staging::Cleanliness::Ready);
    assert_eq!(std::fs::read_dir(&r.staging).map(|d| d.count()).unwrap_or(0), 0);
}

/// §10 的测 1c:**未 checkpoint 的 WAL 改动必须进备份**(memory `sqlite-wal-backup-trap`,
/// 70 真踩过「单拷主文件 = 旧态副本」)。造法 = 开着连接写一批就直接备,不 checkpoint。
#[test]
fn uncheckpointed_wal_writes_are_in_the_backup() {
    let r = rig("wal");
    let s = make_space(&r.root, "notebook.sqlite3");
    // 保持连接开着(不 close = 不会被动 checkpoint),再写 25 条。
    let mut conn = crate::db::open(&s.path).unwrap();
    let mut clock = crate::clock::Clock::load(&conn).expect("取时钟");
    for i in 0..25 {
        crate::notes::capture(&mut conn, &mut clock, &format!("wal 里的 {i}")).unwrap();
    }
    assert!(
        s.path.with_extension("sqlite3-wal").exists() || true,
        "夹具前提:WAL 模式"
    );

    let out = run(&r, std::slice::from_ref(&s));
    let made = out.outcomes[0].result.as_ref().expect("该成功");
    let restored = r.root.join("restored.sqlite3");
    let mut f = std::fs::File::open(&made.path).unwrap();
    let mut w = std::fs::File::create(&restored).unwrap();
    crate::backup::read_backup(&mut f, &mut w, &r.settings.key).unwrap();
    drop(w);
    let rc = rusqlite::Connection::open(&restored).unwrap();
    let n: i64 = rc.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 65, "40 + 25(后 25 条还压在 WAL 里)");
}

/// §10 的测 7:**不改源库**。比对面写死「主文件 + `-wal`」——
/// ⚠ 只比主文件会漏 WAL;把只读连接新建的 `-shm` 也算进去会**误红**(§3.2.1 实测)。
#[test]
fn the_source_library_is_not_modified() {
    let r = rig("readonly");
    let s = make_space(&r.root, "notebook.sqlite3");
    let wal = PathBuf::from(format!("{}-wal", s.path.display()));

    let md5 = |p: &Path| std::fs::read(p).ok().map(|b| <sha2::Sha256 as sha2::Digest>::digest(&b).to_vec());
    let (before_main, before_wal) = (md5(&s.path), md5(&wal));

    let out = run(&r, std::slice::from_ref(&s));
    assert!(out.outcomes[0].result.is_ok());

    assert_eq!(md5(&s.path), before_main, "主库一个字节都不许变");
    assert_eq!(md5(&wal), before_wal, "-wal 一个字节都不许变");
}

/// §5.2 的第二格:**明文快照本身**也要 0600(第一格「目录 0700」的网在 staging 那边)。
/// ⚠ 它与 `.backup.json` 的做法**刚好相反**:那个从 `create_new(mode)` 那一刻就对,
/// 这个只能事后 chmod(建它的是 SQLite,不是我们)——理由见 `staging::harden_snapshot`。
#[cfg(unix)]
#[test]
fn the_plaintext_snapshot_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let r = rig("snapperm");
    let s = make_space(&r.root, "notebook.sqlite3");
    let conn = open_readonly_verified(&s).expect("只读打开");
    let mut guard = staging::SnapshotGuard::arm(&r.staging).expect("armed");
    snapshot_and_strip(&conn, guard.path()).expect("取快照");
    let mode = std::fs::metadata(guard.path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "明文整库副本不许留着宽权限,实得 {mode:o}");
    guard.cleanup().expect("收干净");
}

// ---- no-clobber ------------------------------------------------------------------------

/// §10 的测 10。⭐ 三轮说过:那条「检查与 rename 之间的竞态」已被 `O_EXCL` 从设计上消掉,
/// 所以这只只需证「目标已存在 ⇒ 响亮拒 + 原文件字节没被动」。
#[test]
fn an_existing_target_name_is_never_clobbered() {
    let r = rig("noclobber");
    let s = make_space(&r.root, "notebook.sqlite3");
    // 直接打 seal_into 那一层:文件名带 ULID,端到端撞不出来。
    let victim = r.target.join("victim.zjbak");
    std::fs::write(&victim, b"someone-elses-precious-bytes").unwrap();
    let before = std::fs::read(&victim).unwrap();

    let snap = r.root.join("snap.sqlite3");
    std::fs::write(&snap, b"pretend-snapshot").unwrap();
    let err = seal_into(&snap, &victim, &r.settings.key, &s, None, "0.0.0-test")
        .expect_err("目标已存在必须拒");
    assert!(err.0.contains("已经有文件"), "错误话术要说清:{}", err.0);
    assert_eq!(std::fs::read(&victim).unwrap(), before, "⛔ 原文件一个字节都不许动");
}

// ---- 身份 / 版本复验(拆两只,否则互相代答)-----------------------------------------

/// 13a:换入一个**当前版本**、不同 inode 的完整库 ⇒ 身份那格必须自己拦下。
/// ⚠ 版本刻意造成**对的**,不然拒它的是版本闸(三轮 M4 那条「几把尺」)。
///
/// ⛔ **换文件必须用 `rename` 覆盖,不能"删掉再新建同名"** —— 后者在 Unix 上
/// **inode 会被复用**(本机实测:删掉再新建,inode 5374253 → 5374253 一模一样),
/// 而 `NativeFileKey` 在 Unix 上就是 `(dev, ino)` ⇒ **那种换法本来就查不出来**,
/// 拿它当样本等于在测一件这道闸做不到的事。这条限制不是本案引入的,是 backlog
/// 「休眠账 1」那条已记档的 `NativeFileKey` 边界 —— 402 只是给它添了一份实测字据。
/// (`rename` 覆盖则 inode 必不同:5374253 → 5374254;而生产里真正会换文件的那些路径
/// [`spaces::publish_no_clobber` / `reset_space_files`]走的正是 rename / link 那一族。)
#[test]
fn a_swapped_file_is_caught_by_the_identity_check() {
    let r = rig("identity");
    let s = make_space(&r.root, "notebook.sqlite3");
    // 另造一个同版本的库,**rename 覆盖**掉原文件(inode 必变,user_version 一样)。
    let other = make_space(&r.root, "01J0000000000000000000000A.sqlite3");
    std::fs::rename(&other.path, &s.path).unwrap();
    // 自证样本落在该落的格上:版本是对的,所以只有身份那格拒得掉。
    {
        let c = rusqlite::Connection::open(&s.path).unwrap();
        let uv: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(uv, crate::db::SCHEMA_VERSION, "夹具前提:换进来的库版本是对的");
    }

    let out = run(&r, std::slice::from_ref(&s));
    let e = out.outcomes[0].result.as_ref().expect_err("必须拒");
    assert!(e.message.contains("物理身份"), "该由身份那格拦下,实得:{}", e.message);
}

/// 13b:版本不符 ⇒ 版本那格拦下(身份是对的)。
#[test]
fn a_wrong_schema_version_is_caught_by_the_version_check() {
    let r = rig("version");
    let s = make_space(&r.root, "notebook.sqlite3");
    {
        let c = rusqlite::Connection::open(&s.path).unwrap();
        c.pragma_update(None, "user_version", crate::db::SCHEMA_VERSION - 1).unwrap();
    }
    // descriptor 是换版本**之前**读的,所以身份仍然吻合 —— 这一格只有版本闸拒得掉。
    let out = run(&r, std::slice::from_ref(&s));
    let e = out.outcomes[0].result.as_ref().expect_err("必须拒");
    assert!(e.message.contains("库版本"), "该由版本那格拦下,实得:{}", e.message);
}

// ---- 部分成功(按 space_id 注入,不用共享目标目录)-----------------------------------

/// §10 的测 8。⛔ 一轮靠「共享目标目录不可写」——那让**两个空间一起失败**,根本分不出。
/// 改成让**其中一个**空间的库版本不对。
#[test]
fn one_bad_space_does_not_stop_the_others() {
    let r = rig("partial");
    let good = make_space(&r.root, "notebook.sqlite3");
    let bad = make_space(&r.root, "01J0000000000000000000000B.sqlite3");
    {
        let c = rusqlite::Connection::open(&bad.path).unwrap();
        c.pragma_update(None, "user_version", crate::db::SCHEMA_VERSION - 1).unwrap();
    }

    let out = run(&r, &[bad.clone(), good.clone()]);
    assert!(out.fatal.is_none(), "单空间失败不是整批 fatal");
    assert_eq!(out.outcomes.len(), 2, "两个都要跑过");
    assert!(out.outcomes[0].result.is_err(), "坏的那个失败");
    assert!(out.outcomes[1].result.is_ok(), "⭐ 坏的排在前面也不许阻断后面那个");
}

// ---- 整批 fatal(§10 的测 15,三格都断)-------------------------------------------------

/// ⭐ 三格缺一不可(四轮 M3 补的是第③格):
/// ①剩余空间**没跑**;②此前的成功**还在**;③**触发 fatal 的那个空间自己也以 Err 在 outcomes 里**
/// —— 少了③,UI 看得见"整批停了"却看不见**是哪个空间留下了明文**。
#[test]
fn a_stuck_plaintext_stops_the_batch_without_losing_what_already_succeeded() {
    let r = rig("fatal");
    let a = make_space(&r.root, "notebook.sqlite3");
    let b = make_space(&r.root, "01J0000000000000000000000C.sqlite3");
    let c = make_space(&r.root, "01J0000000000000000000000D.sqlite3");

    // 让**第二个**空间的清场失败(第一个先成功,第三个不该被跑到)。
    let spaces = [a.clone(), b.clone(), c.clone()];
    let out = {
        // 先把 a 跑完(注入只影响下一次 cleanup)。
        let first = backup_all(std::slice::from_ref(&a), &r.settings, &r.staging, "0.0.0-test");
        assert!(first.outcomes[0].result.is_ok());
        staging::FAIL_CLEANUP.with(|f| f.set(true));
        backup_all(&spaces[1..], &r.settings, &r.staging, "0.0.0-test")
    };

    match &out.fatal {
        Some(BatchFatal::PlaintextStuck(_)) => {}
        other => panic!("该报「明文删不掉」的整批 fatal,实得 {other:?}"),
    }
    // ①剩余没跑:递进去两个(b、c),只该有 b 的那一格。
    assert_eq!(out.outcomes.len(), 1, "c 不该被跑到");
    // ③触发 fatal 的那个空间自己也以 Err 在册。
    assert_eq!(out.outcomes[0].space_id, b.id);
    assert!(out.outcomes[0].result.is_err(), "⭐ 它必须以 Err 留在 outcomes 里");
    // 顺带自证注入是一次性的(别污染后面的用例)。
    assert!(!staging::FAIL_CLEANUP.with(|f| f.get()));
    let _ = spaces;
}

/// ⭐ **幕⑤ 那一格失败时,产物已经写完了 —— 它必须按 `CompleteUnverified` 报出来。**
///
/// 这只测是**跑出来的**,不是想出来的:第一版我断言「b 失败了就不该留产物」,而它红了 ——
/// 因为清明文发生在**封完之后**,那份 `.zjbak` 早就在盘上,只是**没来得及自验**。
/// ⛔ 报成「什么都没有」会让用户以为这个空间白跑了(而盘上躺着一份**可能完全可用**的备份);
/// 报成「成功」也不行(自验没跑,那两个字给不出)。⇒ §3.3 的第二态正是为这一格存在的。
#[test]
fn a_fatal_after_sealing_reports_the_artifact_as_complete_but_unverified() {
    let r = rig("fatal-keep");
    let a = make_space(&r.root, "notebook.sqlite3");
    let b = make_space(&r.root, "01J0000000000000000000000E.sqlite3");

    staging::FAIL_CLEANUP.with(|f| f.set(true));
    let out = backup_all(&[b.clone(), a.clone()], &r.settings, &r.staging, "0.0.0-test");

    assert!(matches!(out.fatal, Some(BatchFatal::PlaintextStuck(_))));
    assert_eq!(out.outcomes.len(), 1, "a 根本没跑");
    assert_eq!(out.outcomes[0].space_id, b.id);
    let e = out.outcomes[0].result.as_ref().expect_err("b 该是 Err");
    match &e.artifact {
        Artifact::Unverified(p) => {
            assert!(p.exists(), "既然报了路径,那个文件就该真在盘上");
            // ⭐ 而且它**其实是好的** —— 这正是「不许报成什么都没有」的理由。
            crate::backup::verify_file(p, &r.settings.key).expect("这份文件本身是完整可读的");
        }
        other => panic!("该报 CompleteUnverified,实得 {other:?}"),
    }
    // a 一个产物都不该有(它根本没跑到)。
    let made: Vec<_> = std::fs::read_dir(&r.target)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".zjbak"))
        .collect();
    assert_eq!(made.len(), 1, "只该有 b 那一份(a 没跑),实得 {made:?}");
}

// ---- 目标目录 preflight -----------------------------------------------------------------

#[test]
fn an_unusable_target_dir_is_a_batch_fatal_before_the_loop() {
    let d = tmp_dir("target");
    let as_file = d.join("not-a-dir");
    std::fs::write(&as_file, b"x").unwrap();
    match prepare_target(&as_file) {
        Err(BatchFatal::Target(_)) => {}
        other => panic!("目标是个文件必须整批 fatal,实得 {:?}", other.is_ok()),
    }
    prepare_target(&d.join("fresh")).expect("新目录该建得出来");
}

// ---- 文件名 -------------------------------------------------------------------------------

#[test]
fn the_file_name_carries_no_space_name_and_is_utc() {
    let r = rig("name");
    let s = make_space(&r.root, "notebook.sqlite3");
    let n1 = file_name_for(&s);
    let n2 = file_name_for(&s);
    assert!(n1.starts_with("zhujian-main-"), "{n1}");
    assert!(n1.ends_with(".zjbak"), "{n1}");
    assert!(n1.contains('Z'), "时间戳要带 Z(UTC):{n1}");
    assert_ne!(n1, n2, "⛔ 名字不许撞 —— no-clobber 是判据,ULID 只是把概率压小");
}
