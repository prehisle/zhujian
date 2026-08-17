//! `.backup.json` 的测试。⭐ 这是 codex 四轮点名的「第一版最该先复核」的第 2 处 ——
//! **权限要从创建那一瞬间就对**,**坏了绝不许自愈**。

use super::*;

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = crate::test_temp::dir().join(format!("zj-backup-cfg-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn cfg_path(dir: &Path) -> PathBuf {
    dir.join(".backup.json")
}

#[test]
fn create_then_load_round_trips_and_leaves_no_temp() {
    let d = tmp_dir("roundtrip");
    let p = cfg_path(&d);
    let target = d.join("backups");

    assert!(matches!(load(&p), Err(ConfigError::NotConfigured)), "一开始该是「还没配」");

    let made = create(&p, &target, random_key().unwrap()).expect("首次生成");
    let got = load(&p).expect("读回来");
    assert_eq!(got.dir, target);
    // 钥要一样(比不了字节 —— 它不出 crate;比派生出来的凭据,那就够了)。
    assert_eq!(made.key_check(&[1u8; 16]), got.key.key_check(&[1u8; 16]));

    // 原子写不留半成品。
    assert!(stale_temps(&p).unwrap().is_empty(), "临时文件必须已经不在了");
}

/// ⭐ §10 的测 12。⛔ **只断「报了错」不够** —— 「报错之后又悄悄写了把新钥」照样能绿。
#[test]
fn a_corrupt_config_is_never_silently_healed() {
    let d = tmp_dir("corrupt");
    let p = cfg_path(&d);
    std::fs::write(&p, "{ 这不是 JSON").unwrap();
    let before = std::fs::read(&p).unwrap();

    match load(&p) {
        Err(ConfigError::Corrupt(_)) => {}
        other => panic!("坏配置必须响亮拒,实得 {:?}", other.map(|_| "Ok").err()),
    }
    // ⭐ 三格都要断:①文件字节没被动;②没生成新钥;③连 create 也拒(不许"重来一次")。
    assert_eq!(std::fs::read(&p).unwrap(), before, "读一次配置不许改写它");
    assert!(stale_temps(&p).unwrap().is_empty(), "不许留下新写的半成品");
    match create(&p, &d, random_key().unwrap()) {
        Err(ConfigError::Corrupt(_)) => {}
        other => panic!("配置坏着的时候 create 必须拒(否则就是换了把钥),实得 {:?}", other.is_ok()),
    }
    assert_eq!(std::fs::read(&p).unwrap(), before, "被拒之后照样不许动那个文件");
}

/// ⭐ 四轮 M2 那一格:`final` 不在、`temp` 在 = 上次写盘死在半路。
/// ⛔ **绝不许当首次使用重新生成钥** —— 用户抄在纸上的旧码会对不上,而他不会知道。
#[test]
fn an_interrupted_write_is_not_mistaken_for_first_use() {
    let d = tmp_dir("interrupted");
    let p = cfg_path(&d);
    let half = d.join(format!("{TMP_PREFIX}01J000000000000000000000AB"));
    std::fs::write(&half, "{}").unwrap();

    match load(&p) {
        Err(ConfigError::InterruptedWrite(ps)) => assert_eq!(ps, vec![half.clone()]),
        other => panic!("半成品在场必须报 InterruptedWrite,实得 {:?}", other.map(|_| "Ok").err()),
    }
    // ⛔ 关键那一格:此时 create 必须被拦下,不许生成新钥。
    assert!(matches!(create(&p, &d, random_key().unwrap()), Err(ConfigError::InterruptedWrite(_))));
    assert!(!p.exists(), "被拦下之后不许留下一份新配置");
}

#[test]
fn create_twice_is_refused_so_the_key_never_silently_rotates() {
    let d = tmp_dir("twice");
    let p = cfg_path(&d);
    create(&p, &d, random_key().unwrap()).unwrap();
    let before = std::fs::read(&p).unwrap();
    assert!(create(&p, &d, random_key().unwrap()).is_err(), "第二次 create 必须拒");
    assert_eq!(std::fs::read(&p).unwrap(), before, "被拒之后配置一个字节都不许变");
}

#[test]
fn set_dir_keeps_the_key() {
    let d = tmp_dir("setdir");
    let p = cfg_path(&d);
    let k0 = create(&p, &d.join("a"), random_key().unwrap()).unwrap();
    set_dir(&p, &d.join("b")).unwrap();
    let got = load(&p).unwrap();
    assert_eq!(got.dir, d.join("b"));
    assert_eq!(k0.key_check(&[2u8; 16]), got.key.key_check(&[2u8; 16]), "换目录不许换钥");
}

/// ⭐ 权限要**从创建那一刻**就对(四轮 M2):写完再 chmod 的话,中间那一瞬明文钥就躺在
/// 一个宽权限文件里。这只测顺带把 temp 也一起断了。
#[cfg(unix)]
#[test]
fn the_config_and_its_temp_are_private_from_birth() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmp_dir("perm");
    let p = cfg_path(&d);

    // temp:直接调建文件那一支,趁它还在的时候看权限。
    let tmp = d.join(format!("{TMP_PREFIX}01J000000000000000000000CD"));
    let f = create_private(&tmp).unwrap();
    let mode = std::fs::metadata(&tmp).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "临时配置从创建瞬间就该是 0600,实得 {mode:o}");
    drop(f);
    std::fs::remove_file(&tmp).unwrap();

    // 正式文件:rename 保留 temp 的权限位。
    create(&p, &d, random_key().unwrap()).unwrap();
    let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "落定的配置也该是 0600,实得 {mode:o}");
}

/// 两次生成的钥不许相同(CSPRNG 真的在起作用,不是某个常量)。
#[test]
fn generated_keys_differ() {
    let d = tmp_dir("rand");
    let k1 = create(&cfg_path(&d.join("one")), &d, random_key().unwrap()).unwrap();
    let k2 = create(&cfg_path(&d.join("two")), &d, random_key().unwrap()).unwrap();
    assert_ne!(k1.key_check(&[3u8; 16]), k2.key_check(&[3u8; 16]));
}

#[test]
fn unhex32_is_strict() {
    assert!(unhex32(&"ab".repeat(32)).is_some());
    assert!(unhex32(&"ab".repeat(31)).is_none(), "短了要拒");
    assert!(unhex32(&format!("{}0", "ab".repeat(32))).is_none(), "长了要拒");
    assert!(unhex32(&format!("zz{}", "ab".repeat(31))).is_none(), "非十六进制要拒");
}

/// 未知键要拒 —— 与 §4 的头同一条纪律:配置也是「格式」,别让它悄悄长出字段。
#[test]
fn unknown_config_keys_are_rejected() {
    let d = tmp_dir("unknown");
    let p = cfg_path(&d);
    create(&p, &d, random_key().unwrap()).unwrap();
    let txt = std::fs::read_to_string(&p).unwrap();
    let doctored = txt.replace('{', "{ \"extra\": 1,");
    std::fs::write(&p, doctored).unwrap();
    assert!(matches!(load(&p), Err(ConfigError::Corrupt(_))));
}
