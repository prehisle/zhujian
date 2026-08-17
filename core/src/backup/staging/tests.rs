//! 明文清场的测试。⭐ codex 四轮把它排在「第一版最该先复核」的第 2 位 ——
//! 这里守的是**明文完整库副本**,一格漏了就是永久静默残留。

use super::*;

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = crate::test_temp::dir().join(format!("zj-backup-stg-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const ULID_A: &str = "01J0000000000000000000000A";
const ULID_B: &str = "01J0000000000000000000000B";

fn touch(p: &Path) {
    std::fs::write(p, b"pretend-plaintext").unwrap();
}

// ---- 白名单 ----------------------------------------------------------------------

/// ⭐ 三轮那条 H:一轮我只写了三件,**漏了 `-journal`** —— 而剥派生是普通连接跑
/// `DELETE; VACUUM`,死在那个事务里必留它,里面同样是明文页。
#[test]
fn the_whitelist_is_the_full_four_piece_set() {
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let name = format!("{ULID_A}.sqlite3{suffix}");
        assert!(is_snapshot_name(&name), "{name} 该在白名单里(四件套)");
    }
}

#[test]
fn the_whitelist_refuses_everything_else() {
    for name in [
        "notebook.sqlite3",              // 生产主库的名字
        "01J000.sqlite3",                // 不是严格 ULID
        "01J0000000000000000000000A",    // 没有 .sqlite3
        "01J0000000000000000000000A.db", // 别的扩展名
        "01J0000000000000000000000A.sqlite3-bak", // 不认识的 sidecar
        ".backup.json",
        "..",
    ] {
        assert!(!is_snapshot_name(name), "{name} 不该被当成我们的东西");
    }
}

// ---- sweep ------------------------------------------------------------------------

#[test]
fn sweeping_a_missing_or_empty_dir_is_ready() {
    let d = tmp_dir("empty");
    assert_eq!(sweep(&d.join("never-existed")), Cleanliness::Ready);
    assert_eq!(sweep(&d), Cleanliness::Ready);
}

#[test]
fn sweeping_removes_the_whole_four_piece_set_of_every_snapshot() {
    let d = tmp_dir("sweepall");
    for u in [ULID_A, ULID_B] {
        for suffix in ["", "-journal", "-wal", "-shm"] {
            touch(&d.join(format!("{u}.sqlite3{suffix}")));
        }
    }
    assert_eq!(sweep(&d), Cleanliness::Ready);
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0, "八个文件要一个不剩");
}

/// ⛔ 未知项 = **不删 + 封锁**(三轮 H:0700 的应用保留目录里出现未知项 = 实现漂移 /
/// 手工干预 / 损坏,不能假定它安全)。⭐ 两格都要断:**封锁了** 且 **那个文件还在**。
#[test]
fn an_unknown_entry_blocks_and_is_never_deleted() {
    let d = tmp_dir("unknown");
    let mine = d.join(format!("{ULID_A}.sqlite3"));
    let theirs = d.join("someone-elses-file.txt");
    touch(&mine);
    touch(&theirs);

    match sweep(&d) {
        Cleanliness::Blocked { unknown, failed, removed } => {
            assert_eq!(unknown, vec![theirs.clone()]);
            assert!(failed.is_empty());
            // ⭐ 认识的那个照样清掉了 —— 「有未知项」不该让我们连自己的明文都不敢删。
            assert_eq!(removed, 1);
        }
        Cleanliness::Ready => panic!("有未知项还报 Ready"),
    }
    assert!(theirs.exists(), "⛔ 不认识的东西一个字节都不许动");
    assert!(!mine.exists(), "认识的那个该已清掉");
}

/// 子目录也算未知项(我们只产文件,不产目录)。
#[test]
fn a_subdirectory_is_unknown_even_if_its_name_looks_right() {
    let d = tmp_dir("subdir");
    let sneaky = d.join(format!("{ULID_A}.sqlite3"));
    std::fs::create_dir(&sneaky).unwrap();
    match sweep(&d) {
        Cleanliness::Blocked { unknown, .. } => assert_eq!(unknown, vec![sneaky.clone()]),
        Cleanliness::Ready => panic!("名字对但它是目录,该判未知"),
    }
    assert!(sneaky.is_dir(), "不许把目录删了");
}

/// ⛔ symlink 不跟着走 —— 跟着走的话我们的删除会落在别人的目录里。
#[cfg(unix)]
#[test]
fn a_symlinked_staging_dir_is_refused_not_followed() {
    let d = tmp_dir("symlink");
    let real = d.join("real");
    std::fs::create_dir(&real).unwrap();
    let victim = real.join(format!("{ULID_A}.sqlite3"));
    touch(&victim);
    let link = d.join("staging");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    match sweep(&link) {
        Cleanliness::Blocked { failed, removed, .. } => {
            assert_eq!(removed, 0);
            assert_eq!(failed.len(), 1);
        }
        Cleanliness::Ready => panic!("symlink 必须拒,不许跟着走"),
    }
    assert!(victim.exists(), "⛔ 链接指向的目录里一个字节都不许动");
}

/// ⭐ 三轮算法第 4 条:**聚合错误,不许逐项 `?` 早退** —— 早退的话后面的明文**连试都没试过**。
/// 造法:两份快照,第一份用只读目录挡住(unix),看第二份有没有被清掉。
#[cfg(unix)]
#[test]
fn deletion_failures_are_aggregated_so_later_plaintext_still_gets_tried() {
    use std::os::unix::fs::PermissionsExt;
    // 只读目录挡不住 root(容器里常是 root),挡不住就跳过——别把"没挡住"当成通过。
    if unsafe { libc_geteuid() } == 0 {
        eprintln!("跳过:以 root 跑,只读目录挡不住删除");
        return;
    }
    let d = tmp_dir("aggregate");
    let a = d.join(format!("{ULID_A}.sqlite3"));
    let b = d.join(format!("{ULID_B}.sqlite3"));
    touch(&a);
    touch(&b);
    // 让 a 删不掉:把它挪进一个只读子目录是不行的(名字就不在扫描面里了),
    // 改成把**整个** staging 设成只读 —— 那样两个都删不掉,但两个都要**被试过**。
    std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o500)).unwrap();
    let got = sweep(&d);
    std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();

    match got {
        Cleanliness::Blocked { failed, removed, unknown } => {
            assert!(unknown.is_empty());
            assert_eq!(removed, 0);
            // ⭐ 这一格就是「聚合而非早退」的判据:**两个都在 failed 里**,不是只有第一个。
            assert_eq!(failed.len(), 2, "两份都要被试过并登记,实得 {failed:?}");
        }
        Cleanliness::Ready => panic!("删不掉却报 Ready"),
    }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "geteuid"]
    fn libc_geteuid() -> u32;
}

// ---- SnapshotGuard -------------------------------------------------------------------

#[test]
fn the_guard_cleans_up_the_whole_set_explicitly() {
    let d = tmp_dir("guard");
    let mut g = SnapshotGuard::arm(&d).unwrap();
    let p = g.path().to_path_buf();
    for s in ["", "-journal", "-wal", "-shm"] {
        touch(&PathBuf::from(format!("{}{s}", p.display())));
    }
    g.cleanup().expect("显式清场");
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
}

/// `Drop` 是最后一层 best-effort:**没显式 cleanup 也不许把明文留在盘上**。
#[test]
fn dropping_the_guard_still_removes_the_snapshot() {
    let d = tmp_dir("drop");
    let p = {
        let g = SnapshotGuard::arm(&d).unwrap();
        let p = g.path().to_path_buf();
        touch(&p);
        touch(&PathBuf::from(format!("{}-journal", p.display())));
        p
    };
    assert!(!p.exists(), "Drop 之后主文件不许还在");
    assert!(!PathBuf::from(format!("{}-journal", p.display())).exists(), "-journal 同样");
}

/// 幂等:文件本来就不在,清场也算成功(否则「成功路径也调一次 cleanup」会假红)。
#[test]
fn cleanup_is_idempotent() {
    let d = tmp_dir("idem");
    let mut g = SnapshotGuard::arm(&d).unwrap();
    g.cleanup().expect("什么都没有也该成功");
    g.cleanup().expect("再来一次照样成功");
}

/// ⭐ 每次 arm 出来的名字必须不同(否则并发 / 连续两次备份会互相踩)。
#[test]
fn each_arm_picks_a_fresh_name() {
    let d = tmp_dir("fresh");
    let a = SnapshotGuard::arm(&d).unwrap().path().to_path_buf();
    let b = SnapshotGuard::arm(&d).unwrap().path().to_path_buf();
    assert_ne!(a, b);
    // 而且这个名字要落在白名单里 —— 不然 sweep 会把自己产的东西判成"未知项"。
    assert!(is_snapshot_name(a.file_name().unwrap().to_str().unwrap()));
}

/// 暂存目录一出生就是 0700(§5.1:本功能自己新造的明文物件,不许继承宽权限)。
#[cfg(unix)]
#[test]
fn the_staging_dir_is_private_from_birth() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmp_dir("perm").join("staging");
    let _g = SnapshotGuard::arm(&d).unwrap();
    let mode = std::fs::metadata(&d).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700, "实得 {mode:o}");
}

/// ⛔ **取快照那条路也要先证明「这是个真实目录」**(412 实现审 M1)。
/// 清扫那边一直有这道闸,`arm()` 第一版漏了 —— 而「权限是 0700」只证明模式,**证明不了
/// 这是我们的目录**:同名路径若是一条指向别处的 symlink,`create_dir_all` 与
/// `set_permissions` 都会跟着走,明文整库就落到别人的目录里去了。
#[cfg(unix)]
#[test]
fn arm_refuses_a_symlinked_staging_dir_instead_of_following_it() {
    let d = tmp_dir("arm-symlink");
    let real = d.join("someone-elses");
    std::fs::create_dir_all(&real).unwrap();
    let link = d.join("staging-link");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    // ⚠ `SnapshotGuard` 没有 Debug(它是个 RAII 句柄,不该被随手打印),故不用 expect_err。
    let err = match SnapshotGuard::arm(&link) {
        Err(e) => e,
        Ok(_) => panic!("symlink 必须拒,不许跟着走"),
    };
    assert!(err.contains("真实目录"), "话要说清为什么拒:{err}");
    // ⛔ 而且**没往里放任何东西**,也没把别人的目录 chmod 掉。
    assert_eq!(std::fs::read_dir(&real).unwrap().count(), 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&real).unwrap().permissions().mode() & 0o777;
        assert_ne!(mode, 0o700, "别人的目录不该被我们收权限(夹具是默认 0755)");
    }
}
