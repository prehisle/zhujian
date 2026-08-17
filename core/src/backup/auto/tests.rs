//! 自动备份:合法域、due 判定、**轮转**(backup-plan §15.7 的 17-23 与 22b-22g)。
//!
//! ⭐ 这一份守的是四轮设计审逐条打出来的那几格 —— **每一只都对应一个真实的误删路径**,
//! 改测之前先读 `auto.rs` 头注那张「当时形 / 反例 / 现行形」的表。
//!
//! ⚠ 纪律照 §10:**断到"失败发生在哪一档"**,别只断 `is_err()`。

use super::*;
use crate::backup::config;
use crate::backup::engine::{backup_all, BackupBatchResult};
use crate::spaces::SpaceDescriptor;
use std::path::PathBuf;

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = crate::test_temp::dir().join(format!("zj-backup-auto-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct Rig {
    root: PathBuf,
    staging: PathBuf,
    target: PathBuf,
    settings: config::BackupSettings,
    space: SpaceDescriptor,
}

/// 一台真机器:真库(跑过迁移、有数据)+ 真钥 + 真目标目录。
fn rig(tag: &str) -> Rig {
    let root = tmp_dir(tag);
    let staging = root.join(".backup-staging");
    let target = root.join("out");
    std::fs::create_dir_all(&target).unwrap();
    let cfg = root.join(".backup.json");
    config::create(&cfg, &target, config::random_key().unwrap()).expect("生成备份钥");
    let settings = config::load(&cfg).expect("读回设置");
    let space = make_space(&root, "notebook.sqlite3", "main");
    Rig { root, staging, target, settings, space }
}

fn make_space(dir: &std::path::Path, file: &str, id: &str) -> SpaceDescriptor {
    let path = dir.join(file);
    {
        let mut conn = crate::db::open(&path).expect("建库");
        let mut clock = crate::clock::Clock::load(&conn).expect("取时钟");
        for i in 0..5 {
            crate::notes::capture(&mut conn, &mut clock, &format!("条目 {i}")).expect("记一条");
        }
    }
    crate::spaces::read_descriptor(id, &path).expect("读描述符")
}

/// 真备一份出来(走的就是手动那条路的引擎),返回那份 `MadeBackup`。
fn back_up(r: &Rig, space: &SpaceDescriptor) -> MadeBackup {
    let out: BackupBatchResult =
        backup_all(std::slice::from_ref(space), &r.settings, &r.staging, "0.0.0-test");
    assert!(out.fatal.is_none(), "夹具前提:这一趟不该有 fatal:{:?}", out.fatal);
    let mut it = out.outcomes.into_iter();
    it.next().expect("有一格").result.expect("该成功")
}

/// 连备 n 份并逐份入账(= 模拟"此前若干趟自动备份")。返回按产出顺序的产物。
fn seed(r: &Rig, file: &mut AutoFile, n: usize) -> Vec<MadeBackup> {
    let mut made = Vec::new();
    for _ in 0..n {
        let m = back_up(r, &r.space);
        let seq = file.next_seq;
        file.next_seq += 1;
        file.ledger.entry(r.space.id.clone()).or_default().push(LedgerEntry {
            file: m.path.file_name().unwrap().to_str().unwrap().to_string(),
            dir: std::fs::canonicalize(&r.target).unwrap().display().to_string(),
            salt: hex_salt(&m.salt),
            seq,
        });
        made.push(m);
        // 文件名里有秒级时间戳 + 随机 ULID,同秒也不会撞;但让 seq 与"真实先后"一致就够了。
    }
    made
}

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

fn ledger_files(file: &AutoFile, space: &str) -> Vec<String> {
    file.ledger.get(space).map(|v| v.iter().map(|e| e.file.clone()).collect()).unwrap_or_default()
}

// ---- 24:「逐个 `made` 单独授权」——⭐ 这一条**由类型守**,不是靠一只行为测 -------------

/// 设计审复核点名过:`run_backup()` 返回 `Ok` **不等于整批全成功**(报告里仍可能带
/// `failed` / `fatal`),所以轮转必须**逐个 `made`** 授权,⛔ 不许按外层结果授权。
///
/// ⭐ 写这条变异的时候发现它**根本造不出来**(与 §10 的 5c 同一族):轮转要一份
/// `&MadeBackup`,而 `MadeBackup` **只有成功的空间才有**(失败那支拿到的是 `SpaceFailure`)。
/// ⇒ 「不管成没成都轮转一遍」这个改法**编译不过**。⛔ 别把签名改成收 `space_id + 目录`
/// 那种形——那一改,这条保证就从编译器手里掉到注释纪律手里了。
#[test]
fn rotation_can_only_be_called_with_a_successful_artifact_by_type() {
    let _: fn(&mut AutoFile, &str, &MadeBackup, &BackupKey) -> RotationReport = rotate_space;
}

// ---- 17:due 判定(纯函数,⛔ 别造定时器)---------------------------------------------

#[test]
fn due_covers_never_just_ran_overdue_and_a_future_stamp() {
    let now = OffsetDateTime::now_utc();
    assert!(due(now, None, 1440), "从没跑过 ⇒ 该跑");
    assert!(!due(now, Some(now - Duration::minutes(10)), 1440), "刚跑过 ⇒ 不跑");
    assert!(due(now, Some(now - Duration::minutes(1441)), 1440), "超时 ⇒ 该跑");
    assert!(due(now, Some(now - Duration::minutes(1440)), 1440), "恰好到点 ⇒ 该跑");
    // ⭐ 时钟被改 / 时区错乱:上次成功落在**未来** ⇒ 判 due(方向选安全那侧:多备一份 ≠ 损失)。
    // ⛔ 频率由**单调尺**压住,那格在 coordinator 的测里。
    assert!(due(now, Some(now + Duration::days(3)), 1440), "上次成功在未来 ⇒ 也该跑");
}

// ---- 26 / 31:合法域(⛔ 可手改文件的每一格都要 fail-closed)---------------------------

fn with_ledger(seq: u64, next_seq: u64, file: &str) -> AutoFile {
    let mut a = AutoFile { next_seq, ..AutoFile::default() };
    a.ledger.insert(
        "main".into(),
        vec![LedgerEntry {
            file: file.into(),
            dir: "/tmp/out".into(),
            salt: "0".repeat(32),
            seq,
        }],
    );
    a
}

const GOOD_NAME: &str = "zhujian-main-20260817T030000Z-01J0000000000000000000000A.zjbak";

#[test]
fn keep_below_two_and_a_zero_interval_are_refused() {
    // ⭐ `keep ≤ 1` = 每趟把该空间历史删光,而新产物**可能正是 purge 之后的空库**。
    for k in [0u32, 1] {
        let a = AutoFile { keep: k, ..AutoFile::default() };
        match a.validate() {
            Err(AutoError::Invalid(m)) => assert!(m.contains("keep"), "话要点名 keep:{m}"),
            other => panic!("keep={k} 必须被拒,实得 {other:?}"),
        }
    }
    let a = AutoFile { every_minutes: 0, ..AutoFile::default() };
    assert!(matches!(a.validate(), Err(AutoError::Invalid(_))), "every_minutes=0 必须被拒");
    // 默认值本身当然合法。
    assert!(AutoFile::default().validate().is_ok());
}

#[test]
fn the_ledger_has_its_own_closed_domain() {
    let ok = with_ledger(0, 1, GOOD_NAME);
    assert!(ok.validate().is_ok(), "夹具前提:这条账本身是合法的");

    // ①⛔ 不许有任何路径成分(否则轮转会去别的目录删东西)
    for bad in ["../x.zjbak", "a/b.zjbak", "a\\b.zjbak", "."] {
        assert!(
            matches!(with_ledger(0, 1, bad).validate(), Err(AutoError::Invalid(_))),
            "{bad} 该被拒"
        );
    }
    // ②不符合本空间的命名形
    for bad in [
        "zhujian-other-20260817T030000Z-01J0000000000000000000000A.zjbak", // 别的空间
        "zhujian-main-not-a-stamp-01J0000000000000000000000A.zjbak",       // 时间戳不成形
        "zhujian-main-20260817T030000Z-notaulid.zjbak",                    // ULID 不成形
        "zhujian-main-20260817T030000Z-01J0000000000000000000000A.txt",    // 扩展名
    ] {
        assert!(
            matches!(with_ledger(0, 1, bad).validate(), Err(AutoError::Invalid(_))),
            "{bad} 该被拒"
        );
    }
    // ③`seq` 不小于 `next_seq` = 序号回退过 ⇒ 「真实产出先后」这条根没了
    assert!(matches!(with_ledger(5, 5, GOOD_NAME).validate(), Err(AutoError::Invalid(_))));
    // ④同一空间里 seq 重复
    let mut dup = with_ledger(0, 2, GOOD_NAME);
    let e = dup.ledger.get("main").unwrap()[0].clone();
    dup.ledger.get_mut("main").unwrap().push(e);
    assert!(matches!(dup.validate(), Err(AutoError::Invalid(_))), "seq 重复该被拒");
    // ⑤salt 不是 16 字节十六进制
    let mut bad_salt = with_ledger(0, 1, GOOD_NAME);
    bad_salt.ledger.get_mut("main").unwrap()[0].salt = "zz".into();
    assert!(matches!(bad_salt.validate(), Err(AutoError::Invalid(_))));
}

// ---- load / save:坏了怎么办 + 半截 temp + 权限 -----------------------------------------

#[test]
fn a_missing_file_means_never_switched_on_not_an_error() {
    let dir = tmp_dir("load-missing");
    let a = load(&dir.join(".backup-auto.json")).expect("文件不在 ≠ 故障");
    assert!(!a.enabled, "默认关:仪式跑完 ≠ 用户同意后台每天往磁盘写东西");
    assert_eq!(a.every_minutes, DEFAULT_EVERY_MINUTES);
    assert_eq!(a.keep, DEFAULT_KEEP);
}

#[test]
fn a_corrupt_or_unknown_field_file_is_refused_loudly_and_never_silently_defaulted() {
    let dir = tmp_dir("load-corrupt");
    let p = dir.join(".backup-auto.json");
    std::fs::write(&p, b"{ not json").unwrap();
    assert!(matches!(load(&p), Err(AutoError::Corrupt(_))));
    // ⛔ 不认识的字段也要拒:「用户设了什么我却按默认跑」是同一个病。
    std::fs::write(&p, br#"{"enabled":true,"whats_this":1}"#).unwrap();
    assert!(matches!(load(&p), Err(AutoError::Corrupt(_))));
}

#[test]
fn saving_is_atomic_private_and_sweeps_half_written_temps() {
    let dir = tmp_dir("save");
    let p = dir.join(".backup-auto.json");
    let stale = dir.join(format!("{TMP_PREFIX}01J000000000000000000000AA"));
    std::fs::write(&stale, b"half").unwrap();

    let a = AutoFile { enabled: true, ..AutoFile::default() };
    save(&p, &a).expect("写得进");
    let back = load(&p).expect("读得回");
    assert_eq!(back, a);
    // ⭐ 半截 temp **直接删**(⛔ 与 `.backup.json` 的 InterruptedWrite fatal 相反:
    // 这里没有钥,没有不可再生的东西;而所有读写都在 coordinator 的临界区内,
    // 看到 temp 就确定是死进程留下的)。
    assert!(!stale.exists(), "半截 temp 该被清掉");
    assert!(!names(&dir).iter().any(|n| n.starts_with(TMP_PREFIX)), "不许留下自己的 temp");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "从创建那一刻就该是 0600");
    }
}

// ---- 19:轮转的正常形 -------------------------------------------------------------------

#[test]
fn rotation_keeps_the_newest_keep_and_deletes_the_rest() {
    let r = rig("rotate");
    let mut a = AutoFile::default(); // keep = 3
    let old = seed(&r, &mut a, 4); // 账里已有 4 份
    let fresh = back_up(&r, &r.space); // 本趟第 5 份

    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    assert_eq!(out.removed.len(), 2, "5 份 keep=3 ⇒ 删最旧 2 份:{out:?}");
    assert!(out.is_quiet(), "不该有摘账 / 重试 / 停滞:{out:?}");

    assert!(fresh.path.exists(), "⛔ 本趟新产物永远不删");
    assert!(!old[0].path.exists() && !old[1].path.exists(), "最旧那两份该没了");
    assert!(old[2].path.exists() && old[3].path.exists(), "较新那两份留着");
    assert_eq!(ledger_files(&a, &r.space.id).len(), 3, "账收敛到 keep");
    assert_eq!(names(&r.target).len(), 3, "盘上也恰好 3 份");
}

// ---- 20 / 21:只碰账里的(⛔ 样本必须制造删除压力,否则"改成扫目录"那条变异会假绿)------

#[test]
fn rotation_touches_only_what_is_in_this_machines_ledger() {
    let r = rig("only-ledger");
    let mut a = AutoFile::default();

    // ⭐ 先种 decoy:它们**产出得最早**(= 若按目录扫描 + 时间排序,它们就是头两个被删的)。
    let manual = back_up(&r, &r.space); // 用户手动备的那份:⛔ 不进账
    let neighbour = back_up(&r, &r.space); // 另一台机器备到同一目录的那份:也不在我的账里
    let renamed = r.target.join("我改过名的备份.zjbak");
    std::fs::copy(&manual.path, &renamed).unwrap();
    let probe = r.target.join(".zjbak-write-probe-01J0000000000000000000000A");
    std::fs::write(&probe, b"x").unwrap();

    let old = seed(&r, &mut a, 4); // 账里 4 份(都比 decoy 新)
    let fresh = back_up(&r, &r.space); // 本趟第 5 份 ⇒ 有 2 份要删

    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    assert_eq!(out.removed.len(), 2, "夹具前提:这一轮真的有删除压力");
    assert!(out.is_quiet(), "decoy 不该产生任何话:{out:?}");

    // ⛔ 四个 decoy 一个都不许少 —— 手动 checkpoint、别的机器的、改过名的、探针残留。
    assert!(manual.path.exists(), "⛔ 手动备份不进自动清理账");
    assert!(neighbour.path.exists(), "⛔ 另一台机器的产物碰都不碰");
    assert!(renamed.exists() && probe.exists(), "⛔ 目录里其它东西一律不碰");
    // 删掉的恰好是账里最旧那两份。
    assert!(!old[0].path.exists() && !old[1].path.exists());
}

// ---- 22 / 23 / 22c:四道各自的失败(⛔ 只断"不删"不够,要断**摘账 + 报**)---------------

#[test]
fn a_truncated_entry_is_neither_deleted_nor_counted_and_leaves_the_ledger() {
    let r = rig("truncated");
    let mut a = AutoFile::default();
    let old = seed(&r, &mut a, 4);
    // 把最旧那份截断 —— ⛔ 它可能是 §3.3 的 CompleteUnverified(完全合法),不许顺手删。
    let f = std::fs::OpenOptions::new().write(true).open(&old[0].path).unwrap();
    f.set_len(64).unwrap();
    drop(f);
    let fresh = back_up(&r, &r.space);

    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    assert!(old[0].path.exists(), "⛔ 验不过的不许删");
    assert_eq!(out.unmanaged.len(), 1, "要报出来:{out:?}");
    assert!(out.unmanaged[0].0.contains(old[0].path.file_name().unwrap().to_str().unwrap()));
    assert!(
        !ledger_files(&a, &r.space.id).contains(&file_name(&old[0].path)),
        "⭐ 还要**摘账** —— 只断'还在'的话,'永久重试同一条'的实现也会绿"
    );
}

#[test]
fn a_legal_file_from_another_space_is_refused_by_the_trailer_not_by_its_name() {
    let r = rig("wrong-space");
    let other = make_space(&r.root, "01J0000000000000000000000B.sqlite3", "01J0000000000000000000000B");
    let mut a = AutoFile::default();
    let old = seed(&r, &mut a, 4);
    // 把另一个空间的合法产物**改成本空间的名字**顶替进去(名字骗得过,trailer 骗不过)。
    let intruder = back_up(&r, &other);
    std::fs::copy(&intruder.path, &old[0].path).unwrap();
    std::fs::remove_file(&intruder.path).unwrap();
    let fresh = back_up(&r, &r.space);

    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    assert!(old[0].path.exists(), "⛔ 不删");
    assert_eq!(out.unmanaged.len(), 1, "摘账 + 报:{out:?}");
    assert!(out.unmanaged[0].1.contains("空间"), "话要说清是空间对不上:{:?}", out.unmanaged[0]);
    assert!(!ledger_files(&a, &r.space.id).contains(&file_name(&old[0].path)));
}

#[test]
fn a_same_key_same_space_file_swapped_under_a_known_name_is_caught_by_the_salt() {
    let r = rig("salt-swap");
    let mut a = AutoFile::default();
    let old = seed(&r, &mut a, 4);
    // ⭐ 这一格是 §4 自己写着的那条:「整份文件被另一份**合法**文件替换,自包含格式识别不了」。
    // 于是同钥同空间的另一份(比如用户的手动 checkpoint)顶替进来时,
    // **`verify_file` 与 `space_id` 两道都会放行** —— 只有 salt 指纹拦得住。
    let manual = back_up(&r, &r.space);
    std::fs::copy(&manual.path, &old[0].path).unwrap();
    let fresh = back_up(&r, &r.space);

    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    assert!(old[0].path.exists(), "⛔ 顶替进来的那份不许删(它很可能正是更要紧的那一份)");
    assert_eq!(out.unmanaged.len(), 1, "摘账 + 报:{out:?}");
    assert!(out.unmanaged[0].1.contains("身份"), "话要说清身份变了:{:?}", out.unmanaged[0]);
}

// ---- 22b:⭐ 坏的**新**项占着 keep 名额(设计审二弹 H1)---------------------------------

#[test]
fn a_broken_newer_entry_never_costs_an_older_valid_one_its_slot() {
    let r = rig("bad-occupies-slot");
    let mut a = AutoFile::default(); // keep = 3
    let seeded = seed(&r, &mut a, 3);
    let (a_old, b_moved, c_broken) = (&seeded[0], &seeded[1], &seeded[2]);

    std::fs::remove_file(&b_moved.path).unwrap(); // B:被用户搬走了
    let f = std::fs::OpenOptions::new().write(true).open(&c_broken.path).unwrap();
    f.set_len(64).unwrap(); // C:截断了
    drop(f);
    let fresh = back_up(&r, &r.space); // D:本趟(设想它是 purge 之后的空库)

    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    // ⭐ 反例的核心:B/C 都不可用 ⇒ 有效份数只有 D 与 A 两份 < keep ⇒ **A 一根汗毛都不许动**。
    assert!(a_old.path.exists(), "⛔ 唯一有效的旧恢复点必须留着:{out:?}");
    assert!(out.removed.is_empty(), "有效份数不足 keep 时,一个有效旧项都不许删");
    assert_eq!(out.unmanaged.len(), 1, "只有 C 要报(B 是静静摘账):{out:?}");
    let left = ledger_files(&a, &r.space.id);
    assert!(left.contains(&file_name(&a_old.path)), "A 留在账里");
    assert!(!left.contains(&file_name(&b_moved.path)), "B 摘账");
    assert!(!left.contains(&file_name(&c_broken.path)), "C 摘账");
}

// ---- 22d:`keep` 调大 / 调小的收敛 ------------------------------------------------------

#[test]
fn shrinking_and_growing_keep_both_converge_on_valid_copies_only() {
    // 调小:5→2 ⇒ 留最新 2 份(含本趟),其余有效项删掉。
    let r = rig("keep-shrink");
    let mut a = AutoFile { keep: 2, ..AutoFile::default() };
    let old = seed(&r, &mut a, 4);
    let fresh = back_up(&r, &r.space);
    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    assert_eq!(out.removed.len(), 3, "5 份 keep=2 ⇒ 删 3 份");
    assert!(fresh.path.exists() && old[3].path.exists(), "留的是最新两份");
    assert!(!old[0].path.exists() && !old[1].path.exists() && !old[2].path.exists());
    assert_eq!(ledger_files(&a, &r.space.id).len(), 2);

    // 调大:2→5 ⇒ 一个都不删。
    let r2 = rig("keep-grow");
    let mut a2 = AutoFile { keep: 5, ..AutoFile::default() };
    let old2 = seed(&r2, &mut a2, 3);
    let fresh2 = back_up(&r2, &r2.space);
    let out2 = rotate_space(&mut a2, &r2.space.id, &fresh2, &r2.settings.key);
    assert!(out2.removed.is_empty(), "4 份 keep=5 ⇒ 一个都不删");
    assert!(old2.iter().all(|m| m.path.exists()));
    assert_eq!(ledger_files(&a2, &r2.space.id).len(), 4);
}

// ---- 22e / 22e-2:当前产物在轮转之前被动过(设计审三弹 H1)------------------------------

#[test]
fn if_the_fresh_artifact_fails_its_recheck_nothing_old_is_deleted() {
    let r = rig("fresh-broken");
    let mut a = AutoFile::default();
    let old = seed(&r, &mut a, 4);
    let fresh = back_up(&r, &r.space);

    // ⭐ 造出「自验之后、轮转之前」那个窗口:自验发生在备份返回**之前**,而那之后文件
    // 已经对外可见(网盘客户端 / 用户 / 别的进程都能动它)。
    let victim = fresh.path.clone();
    BEFORE_CURRENT_VERIFY.with(|h| {
        *h.borrow_mut() = Some(Box::new(move || {
            let f = std::fs::OpenOptions::new().write(true).open(&victim).unwrap();
            f.set_len(64).unwrap();
        }))
    });
    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    BEFORE_CURRENT_VERIFY.with(|h| *h.borrow_mut() = None);

    assert!(out.stalled.is_some(), "当前产物复验没过 ⇒ 本空间零删除:{out:?}");
    assert!(out.removed.is_empty(), "⛔ 一个旧备份都不许清理");
    assert!(old.iter().all(|m| m.path.exists()), "四份旧的全在");
    // ⛔ 而且**连旧账都不扫**(四弹 M2:最容易审计的零删除保证)⇒ 账里那 4 条原样。
    assert_eq!(ledger_files(&a, &r.space.id).len(), 5, "4 条旧的 + 本趟这条");
}

#[test]
fn after_two_stalled_rounds_a_good_round_still_converges_the_ledger() {
    let r = rig("stall-converge");
    let mut a = AutoFile::default(); // keep = 3
    let old = seed(&r, &mut a, 2);

    // 两趟停滞:每趟都产出一份,但当场被截断 ⇒ 零删除。
    let mut stalled_paths = Vec::new();
    for _ in 0..2 {
        let f = back_up(&r, &r.space);
        let victim = f.path.clone();
        BEFORE_CURRENT_VERIFY.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                let g = std::fs::OpenOptions::new().write(true).open(&victim).unwrap();
                g.set_len(64).unwrap();
            }))
        });
        let out = rotate_space(&mut a, &r.space.id, &f, &r.settings.key);
        BEFORE_CURRENT_VERIFY.with(|h| *h.borrow_mut() = None);
        assert!(out.stalled.is_some() && out.removed.is_empty());
        stalled_paths.push(f.path);
    }

    // 第三趟正常 ⇒ ⭐ **必须扫完全部旧账**,让账收敛(⛔ 不许因为停滞过就少扫)。
    let good = back_up(&r, &r.space);
    let out = rotate_space(&mut a, &r.space.id, &good, &r.settings.key);
    assert!(out.stalled.is_none());
    // 两份坏的:摘账(不删);两份好的旧的 + 本趟 = 3 = keep ⇒ 恰好不删任何有效项。
    assert_eq!(out.unmanaged.len(), 2, "两份坏的要报出来:{out:?}");
    assert!(out.removed.is_empty(), "有效份数恰好 keep ⇒ 不删");
    assert!(stalled_paths.iter().all(|p| p.exists()), "⛔ 坏的那两份仍归用户自己管,不删");
    assert_eq!(ledger_files(&a, &r.space.id).len(), 3, "账收敛到 keep");
    assert!(old.iter().all(|m| m.path.exists()));
}

// ---- 22f:verify → delete 那个窗口(设计审二弹 H2 末段)---------------------------------

#[test]
fn a_file_swapped_between_verify_and_delete_is_not_removed() {
    let r = rig("toctou");
    let mut a = AutoFile::default();
    let old = seed(&r, &mut a, 4);
    let fresh = back_up(&r, &r.space);
    let victim = file_name(&old[0].path);
    let stand_in = old[3].path.clone();

    // 验过之后、取第二次文件身份之前:把那个路径换成**另一个物理文件**。
    BEFORE_DELETE.with(|h| {
        *h.borrow_mut() = Some(Box::new(move |p: &Path| {
            // ⚠ 按**文件名**比:轮转走的是 canonical 目录,路径字符串未必与夹具里那份相同。
            if p.file_name().unwrap().to_string_lossy() == victim {
                // ⚠ **别用 remove + copy 造这一格**:ext4/tmpfs 会立刻复用刚释放的 inode,
                // 于是 `(dev,ino)` 可能一模一样,这只测就白测了(第一版真栽在这儿)。
                // 用 hard_link + rename:路径原子地指到**另一个物理文件**上,
                // 而这也正是网盘客户端替换文件的真实形。
                let tmp = p.with_extension("swap");
                std::fs::hard_link(&stand_in, &tmp).unwrap();
                std::fs::rename(&tmp, p).unwrap();
            }
        }))
    });
    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    BEFORE_DELETE.with(|h| *h.borrow_mut() = None);

    assert!(old[0].path.exists(), "⛔ 换掉之后不许按路径删下去");
    assert!(out.retry.iter().any(|(p, m)| p.contains(&file_name(&old[0].path))
        && m.contains("换掉")), "要报出来并留账下轮再试:{out:?}");
    assert!(
        ledger_files(&a, &r.space.id).contains(&file_name(&old[0].path)),
        "⭐ 留账(瞬时那一档),⛔ 不是摘账"
    );
}

// ---- 22g:三档分流(⛔ 断的是**类型**,不是错误文案)-------------------------------------

#[test]
fn the_three_failure_buckets_are_told_apart_by_type_not_by_message() {
    let r = rig("buckets");
    let mut a = AutoFile::default();
    let old = seed(&r, &mut a, 4);

    // ①`NotFound` —— 用户自己删了 ⇒ **静静摘账**,不报。
    std::fs::remove_file(&old[0].path).unwrap();
    // ②**瞬时 IO** —— 用一个目录顶替那个路径:`File::open` 成功、读的时候 EISDIR。
    //   ⚠ 刻意不用权限位造失败(§10 测 6 判过不可靠:root 无视权限、Windows ACL 语义不同)。
    #[cfg(unix)]
    {
        std::fs::remove_file(&old[1].path).unwrap();
        std::fs::create_dir(&old[1].path).unwrap();
    }
    // ③**已证明无效** —— 截断。
    let f = std::fs::OpenOptions::new().write(true).open(&old[2].path).unwrap();
    f.set_len(64).unwrap();
    drop(f);

    let fresh = back_up(&r, &r.space);
    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    let left = ledger_files(&a, &r.space.id);

    assert!(!left.contains(&file_name(&old[0].path)), "①不在了 ⇒ 摘账");
    assert!(
        !out.unmanaged.iter().any(|(p, _)| p.contains(&file_name(&old[0].path))),
        "①⛔ 不报(它不是故障)"
    );
    #[cfg(unix)]
    {
        assert!(
            left.contains(&file_name(&old[1].path)),
            "②瞬时 IO ⇒ **留账**下轮再试(⛔ 别永久放手):{out:?}"
        );
        assert!(out.retry.iter().any(|(p, _)| p.contains(&file_name(&old[1].path))));
        assert!(old[1].path.exists(), "②不删");
    }
    assert!(!left.contains(&file_name(&old[2].path)), "③已证明无效 ⇒ 摘账");
    assert!(out.unmanaged.iter().any(|(p, _)| p.contains(&file_name(&old[2].path))), "③要报");
    assert!(old[2].path.exists(), "③不删");
}

// ---- cohort:落点改过之后 ---------------------------------------------------------------

#[test]
fn entries_from_a_previous_target_directory_are_released_not_deleted() {
    let r = rig("cohort");
    let mut a = AutoFile::default();
    let old = seed(&r, &mut a, 4);

    // 用户把落点改到另一个目录,然后又跑了一趟。
    let second = r.root.join("out2");
    std::fs::create_dir_all(&second).unwrap();
    let mut moved = config::load(&r.root.join(".backup.json")).unwrap();
    moved.dir = second.clone();
    let fresh = {
        let out = backup_all(std::slice::from_ref(&r.space), &moved, &r.staging, "0.0.0-test");
        out.outcomes.into_iter().next().unwrap().result.expect("该成功")
    };

    let out = rotate_space(&mut a, &r.space.id, &fresh, &r.settings.key);
    assert!(out.removed.is_empty(), "⛔ 旧目录里的一份都不许删(我们没有在那个目录里的授权)");
    assert_eq!(out.unmanaged.len(), 4, "四条都要报「从此归你自己管」:{out:?}");
    assert!(out.unmanaged.iter().all(|(_, m)| m.contains("落点改过")));
    assert!(old.iter().all(|m| m.path.exists()), "旧目录里的文件原样都在");
    assert_eq!(ledger_files(&a, &r.space.id), vec![file_name(&fresh.path)], "账里只剩新 cohort");
}

// ---- 32 的那半:墙钟该不该往前走 --------------------------------------------------------

/// ⭐ 判据是「**这一趟至少备成了一个空间**」——⛔ 与有没有 `failed` / `fatal` 无关。
/// (整条链路那半在 `coordinator/tests.rs`。)
#[test]
fn the_wall_clock_advances_on_any_success_including_a_partial_one() {
    assert!(!wall_clock_should_advance(0), "一个都没成 ⇒ 不更新(下次启动该再试一次)");
    assert!(wall_clock_should_advance(1), "部分成功也更新 —— 它是「多久备一次」的尺");
    assert!(wall_clock_should_advance(5));
}

fn file_name(p: &Path) -> String {
    p.file_name().unwrap().to_string_lossy().into_owned()
}
