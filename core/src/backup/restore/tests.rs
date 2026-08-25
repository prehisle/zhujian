//! 恢复的测试(backup-plan §16.12 里落在 core 上的那些)。
//!
//! ⭐ **通用纪律**(§10 / §16.12 每一行的「谁会代答」那一栏):每只测都要断到
//! **哪一幕、哪一格**失败 —— 只断 `is_err()` 会被同一条路上更靠后的另一道闸背书成绿。
//! 故本文件几乎每一处都断 [`RestoreStage`],而不是 `unwrap_err()` 完事。
//!
//! ⚠ **这里刻意不走备份引擎造样本**:引擎只肯备份「版本恰为当前版、物理身份对得上」的库,
//! 而本节要造的正是 v34 / 版本太新 / 两把尺不符 / 带 `pending_*` / 缺 `device_id` 这些
//! **故意只脏一格**的样本。⇒ 样本用格式层的 [`write_backup`](super::super::write_backup)
//! 直接封 —— 那是**同一份写侧实现**,不是第二份。

use super::*;
use crate::backup::{write_backup, BackupKey, TrailerMeta, CHUNK_MIN, SALT_LEN};
use crate::clock::Clock;
use rusqlite::Connection;

const KEY_A: [u8; 32] = [7u8; 32];
const KEY_B: [u8; 32] = [9u8; 32];
const SALT: [u8; SALT_LEN] = [3u8; SALT_LEN];
/// 小块:让一枚几十 KiB 的库也切成**多帧**(单帧的话"改中间一帧"根本无从测起)。
const CHUNK: u32 = CHUNK_MIN;

// ---- 台子 ---------------------------------------------------------------------------

struct Rig {
    root: PathBuf,
    /// 明文暂存区(= 生产的 `.backup-staging`)。
    staging: PathBuf,
    /// 空间落点(= 生产的数据目录)。
    spaces: PathBuf,
}

fn rig(tag: &str) -> Rig {
    let root = crate::test_temp::dir().join(format!("zj-restore-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let staging = root.join(".backup-staging");
    let spaces = root.join("spaces");
    std::fs::create_dir_all(&spaces).unwrap();
    Rig { root, staging, spaces }
}

impl Rig {
    /// 造一枚库(**DELETE journal、自包含单文件** —— 刻意不走 `db::open`,那会切 WAL、
    /// 留下 `-wal`/`-shm`,封进备份的就不是一个完整库了)。
    fn build_db(&self, name: &str, seed: impl FnOnce(&mut Connection, &mut Clock)) -> PathBuf {
        let path = self.root.join(name);
        let mut conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        crate::db::run_migrations(&conn, i64::MAX).unwrap();
        let mut clock = Clock::load(&conn).unwrap();
        seed(&mut conn, &mut clock);
        conn.close().unwrap();
        path
    }

    /// 把一枚库文件封成 `.zjbak`。`trailer_uv` 单独给 —— 「两把尺」那两只测要让它与库里
    /// 的 `user_version` **故意不等**。
    fn seal(&self, db: &Path, out_name: &str, key: &BackupKey, trailer_uv: i64) -> PathBuf {
        let out_path = self.root.join(out_name);
        let mut src = std::fs::File::open(db).unwrap();
        let mut out = std::fs::File::create(&out_path).unwrap();
        write_backup(
            &mut src,
            &mut out,
            key,
            SALT,
            CHUNK,
            &TrailerMeta {
                space_id: "01SOURCESPACEIDSOURCESPA".into(),
                space_name: Some("书房".into()),
                created_at: "2026-08-17T00:00:00Z".into(),
                app_version: "0.2.34-test".into(),
                user_version: trailer_uv,
            },
        )
        .unwrap();
        out_path
    }

    /// 一份「正常的、当前版的、内容丰富的」备份 —— 大多数测的起点。
    fn rich_backup(&self, key: &BackupKey) -> (PathBuf, PathBuf) {
        let db = self.build_db("source.sqlite3", |c, k| seed_rich(c, k));
        let file = self.seal(&db, "rich.zjbak", key, crate::db::SCHEMA_VERSION);
        (db, file)
    }

    fn restore(&self, file: &Path, key: &BackupKey) -> Result<Restored, RestoreFailure> {
        restore(file, key, &self.staging, &self.spaces)
    }

    /// 暂存区里还剩什么(**零残留**是绝大多数失败路径的必断项)。
    fn staging_left(&self) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(&self.staging) else { return Vec::new() };
        let mut v: Vec<String> =
            rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn published(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(&self.spaces)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }
}

/// 内容丰富的一枚库:灵感 / 编辑历史 / 标签(含加了又删又加)/ 任务 / 配图(含删图留洞)/
/// 回收站 / 成就归档 / 彻底删过的一条 / 留言。⭐ 往返那只测要的就是「每一类都在」。
fn seed_rich(c: &mut Connection, k: &mut Clock) {
    use crate::{comments, images, notes, task};
    let idea = notes::capture(c, k, "灵感甲").unwrap();
    notes::edit(c, k, &idea, "灵感甲(改)").unwrap();
    let t1 = notes::create_topic(c, k, "标签一").unwrap();
    let t2 = notes::create_topic(c, k, "标签二").unwrap();
    notes::file_to_topic(c, k, &idea, Some(&t1), None).unwrap();
    let task_id = task::create(c, k, "任务乙", Some("2026-07-20"), Some(2), Some(&t2)).unwrap();
    task::add_topic(c, k, &task_id, &t1).unwrap();
    images::attach(c, k, &task_id, &[1, 2, 3, 4], "image/png").unwrap();
    let (img2, _) = images::attach(c, k, &task_id, &[5, 6, 7, 8], "image/png").unwrap();
    images::remove(c, k, &img2).unwrap();
    comments::add(c, k, &task_id, "留一句").unwrap();
    let dead = notes::capture(c, k, "回收站里的").unwrap();
    notes::archive(c, k, &dead).unwrap();
    let sealed = task::create(c, k, "已入册", None, None, None).unwrap();
    task::transition(c, k, &sealed, "done", &crate::board::gate::DETACHED).unwrap();
    task::seal(c, k, &sealed).unwrap();
}

/// 一套**合法的生产配置**(四元组 + 游标 + 引导标记)。
fn seed_config(c: &Connection) {
    for (key, value) in [
        ("account_id", "01AAAAAAAAAAAAAAAAAAAAACCT"),
        ("k_acc", &"7".repeat(64) as &str),
        ("device_key", &"8".repeat(64)),
        ("server_url", "wss://sync.example/ws"),
        ("last_pushed", "42"),
        ("bootstrapped_at", "2026-08-01T00:00:00Z"),
    ] {
        meta_put(c, key, value);
    }
}

fn meta_put(conn: &Connection, key: &str, value: &str) {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .unwrap();
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0)).ok()
}

fn meta_all(conn: &Connection) -> std::collections::BTreeMap<String, String> {
    let mut stmt = conn.prepare("SELECT key, value FROM sync_meta").unwrap();
    let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    it.map(|r| r.unwrap()).collect()
}

/// 打开一枚**已恢复出来的**库看里面(只读,不迁移、不切 WAL)。
fn peek(path: &Path) -> Connection {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    conn
}

// ---- 1 往返 -------------------------------------------------------------------------

/// **用户数据一行不差**。⭐ 判据复用 `epoch::table_fingerprints`(⛔ 别另写一份指纹 ——
/// 那就是同一条规则的第二份描述);⛔ 也别在断言里**数张数**(`epoch.rs` 那句警告的由来)。
#[test]
fn round_trip_keeps_every_user_row() {
    let r = rig("roundtrip");
    let key = BackupKey::from_bytes(KEY_A);
    let (src_db, file) = r.rich_backup(&key);
    let before = {
        let conn = peek(&src_db);
        crate::epoch::table_fingerprints(&conn).unwrap()
    };

    let out = r.restore(&file, &key).expect("正常备份必须恢复得出来");

    // ⭐ 新空间:ULID 是新取的,**不是** trailer 里那个 space_id(复用会撞 catalog 的唯一断言)。
    assert!(crate::spaces::is_ulid_name(&out.space_id), "空间 id 要是规范 ULID:{}", out.space_id);
    assert_ne!(out.space_id, "01SOURCESPACEIDSOURCESPA");
    assert_eq!(out.path, r.spaces.join(format!("{}.sqlite3", out.space_id)));
    assert_eq!(out.source_space_name.as_deref(), Some("书房"), "trailer 里那个名字要带出来给人看");
    assert_eq!(out.cleanup_error, None);

    let conn = peek(&out.path);
    assert_eq!(crate::epoch::table_fingerprints(&conn).unwrap(), before, "用户数据指纹必须逐行相等");
    let uv: i64 = conn.pragma_query_value(None, "user_version", |x| x.get(0)).unwrap();
    assert_eq!(uv, crate::db::SCHEMA_VERSION);

    // ⭐ 测 15:staging 里**什么都不剩** —— 顺带钉住「幕③不走 `db::open`」
    //(它会切 WAL,`close()` 的出口复核当场拒,这只测根本走不到这里)。
    assert!(r.staging_left().is_empty(), "暂存区必须清空:{:?}", r.staging_left());
    // ⛔ 恒不覆盖:原库还在,落点里多出来的恰是新的那一份。
    assert!(src_db.exists(), "原库一个字节都不许动");
    assert_eq!(r.published(), vec![format!("{}.sqlite3", out.space_id)]);
}

// ---- 1b / 1c 带 pending 身份的合法备份(§16.3.1 那条 M1 的守门人)-----------------------

/// ⭐ **两只都要**:一只笼统的「带 pending 也能恢复」会被其中最容易成立的那格背书。
#[test]
fn a_backup_taken_while_an_epoch_switch_was_pending_still_restores() {
    for state in ["prepared", "registered"] {
        let r = rig(&format!("pending-{state}"));
        let key = BackupKey::from_bytes(KEY_A);
        let db = r.build_db("source.sqlite3", |c, k| {
            seed_rich(c, k);
            seed_config(c);
            // 一份**完全合法**的生产备份可以带着纪元预注册状态:catalog 只核配置四元组、
            // 不看 pending(`spaces.rs:318`)。
            meta_put(c, "pending_device_id", "01BBBBBBBBBBBBBBBBBBBBBBBB");
            meta_put(c, "pending_device_key", &"1".repeat(64));
            meta_put(c, "pending_pubkey", &"2".repeat(64));
            meta_put(c, "pending_state", state);
        });
        let file = r.seal(&db, "p.zjbak", &key, crate::db::SCHEMA_VERSION);

        let out = r.restore(&file, &key).unwrap_or_else(|e| {
            panic!("{state} 状态下取的合法备份必须恢复得出来:{}", e.message)
        });
        let conn = peek(&out.path);
        for k in ["pending_device_id", "pending_device_key", "pending_pubkey", "pending_state"] {
            assert_eq!(meta_get(&conn, k), None, "{state}:{k} 必须已清");
        }
    }
}

// ---- 2 错钥 -------------------------------------------------------------------------

#[test]
fn a_wrong_backup_code_says_so_and_leaves_nothing_behind() {
    let r = rig("wrongkey");
    let (_db, file) = r.rich_backup(&BackupKey::from_bytes(KEY_A));
    let e = r.restore(&file, &BackupKey::from_bytes(KEY_B)).unwrap_err();
    // ⛔ 不是含糊的"解密失败":这一格要说得出「这份备份不是这个备份码的」。
    assert_eq!(e.stage, RestoreStage::Read(ReadError::WrongKey), "{}", e.message);
    assert!(e.message.contains("备份码"), "{}", e.message);
    assert_eq!(e.plaintext_stuck, None);
    // 幕①连 staging 都还没 arm ⇒ 目录都不该出现。
    assert!(r.staging_left().is_empty());
    assert!(r.published().is_empty(), "一个空间都不许发布");
}

// ---- 3 篡改(分档 + 零残留)------------------------------------------------------------

#[test]
fn tampering_is_caught_and_told_apart_from_a_truncated_file() {
    let r = rig("tamper");
    let key = BackupKey::from_bytes(KEY_A);
    let (_db, file) = r.rich_backup(&key);
    let good = std::fs::read(&file).unwrap();

    // ① 改一个密文字节 → AEAD 认证失败。
    let mut bad = good.clone();
    let mid = bad.len() / 2;
    bad[mid] ^= 0xff;
    let p = r.root.join("tampered.zjbak");
    std::fs::write(&p, &bad).unwrap();
    let e = r.restore(&p, &key).unwrap_err();
    assert_eq!(e.stage, RestoreStage::Read(ReadError::Auth), "{}", e.message);
    assert!(r.staging_left().is_empty(), "残留:{:?}", r.staging_left());

    // ② 截断 → 结构闸(⛔ 与①分档不同:一个是"被改过",一个是"没写完")。
    let p2 = r.root.join("truncated.zjbak");
    std::fs::write(&p2, &good[..good.len() - 4096]).unwrap();
    let e2 = r.restore(&p2, &key).unwrap_err();
    assert!(
        matches!(e2.stage, RestoreStage::Read(ReadError::Parse(_))),
        "截断该判成结构闸,实际 {:?}",
        e2.stage
    );
    assert!(r.staging_left().is_empty(), "残留:{:?}", r.staging_left());
    assert!(r.published().is_empty());
}

// ---- 4 前滚(⭐ 没有它,「换新电脑恢复三个月前的备份」这条主用例零覆盖)----------------

#[test]
fn an_older_backup_is_rolled_forward_to_the_current_schema() {
    let r = rig("forward");
    let key = BackupKey::from_bytes(KEY_A);
    let old = crate::db::SCHEMA_VERSION - 1;
    let db = r.root.join("old.sqlite3");
    {
        let mut conn = crate::db::open_through(&db, old).unwrap();
        let mut clock = Clock::load(&conn).unwrap();
        crate::notes::capture(&mut conn, &mut clock, "旧版库里的一条").unwrap();
        conn.close().unwrap();
    }
    let file = r.seal(&db, "old.zjbak", &key, old);

    let out = r.restore(&file, &key).expect("历史备份必须能前滚");
    let conn = peek(&out.path);
    let uv: i64 = conn.pragma_query_value(None, "user_version", |x| x.get(0)).unwrap();
    assert_eq!(uv, crate::db::SCHEMA_VERSION, "要前滚到当前版");
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items WHERE content = '旧版库里的一条'", [], |x| x.get(0))
        .unwrap();
    assert_eq!(n, 1, "数据要在");
}

// ---- 5 / 5b 两把尺 --------------------------------------------------------------------

/// ⛔ 样本必须是**两把尺同为 `current + 1`** —— 只改 trailer 会被 5b 那道闸代答
/// (checklist §13:别让两把尺互相代答)。
#[test]
fn a_backup_from_a_newer_zhujian_asks_you_to_upgrade_not_to_wipe() {
    let r = rig("toonew");
    let key = BackupKey::from_bytes(KEY_A);
    let newer = crate::db::SCHEMA_VERSION + 1;
    let db = r.build_db("newer.sqlite3", |c, _k| {
        c.pragma_update(None, "user_version", newer).unwrap();
    });
    let file = r.seal(&db, "newer.zjbak", &key, newer);

    let e = r.restore(&file, &key).unwrap_err();
    assert_eq!(e.stage, RestoreStage::TooNew, "{}", e.message);
    assert!(e.message.contains("升级"), "话要能照做:{}", e.message);
    assert!(!e.message.contains("清库"), "⛔ 绝不劝清库:{}", e.message);
    assert!(r.staging_left().is_empty());
    assert!(r.published().is_empty());
}

/// 5b:两把尺**都不太新、但彼此不等**(文件被人拼过)—— 只有这道闸拒得掉。
#[test]
fn a_spliced_file_whose_two_rulers_disagree_is_refused() {
    let r = rig("splice");
    let key = BackupKey::from_bytes(KEY_A);
    let db = r.build_db("cur.sqlite3", |c, k| {
        seed_rich(c, k);
    });
    let file = r.seal(&db, "spliced.zjbak", &key, crate::db::SCHEMA_VERSION - 1);

    let e = r.restore(&file, &key).unwrap_err();
    assert_eq!(e.stage, RestoreStage::VersionMismatch, "{}", e.message);
    assert!(r.staging_left().is_empty());
}

// ---- 6 身份清场(四格分开断,⛔ 别并成一只:会互相代答)---------------------------------

#[test]
fn the_restored_library_carries_no_account_and_no_old_device_identity() {
    let r = rig("identity");
    let key = BackupKey::from_bytes(KEY_A);
    let db = r.build_db("configured.sqlite3", |c, k| {
        seed_rich(c, k);
        seed_config(c);
    });
    let source_device = {
        let conn = peek(&db);
        meta_get(&conn, "device_id").unwrap()
    };
    let file = r.seal(&db, "configured.zjbak", &key, crate::db::SCHEMA_VERSION);

    let out = r.restore(&file, &key).expect("恢复");
    let conn = peek(&out.path);
    // ① 不属于任何账户(四元组全空)。
    assert!(crate::sync::transport::load_config(&conn).unwrap().is_none(), "恢复出来的库不许带账户");
    // ② 设备身份换过了。
    let now_device = meta_get(&conn, "device_id").unwrap();
    assert_ne!(now_device, source_device, "device_id 必须轮换");
    assert_eq!(now_device, out.device_id, "回执里那枚就是库里那枚");
    // ③ 压实认证落到位(= 走的是 Unconfigured 分支那条路)。
    assert!(crate::epoch::epoch_certified(&conn).unwrap(), "epoch 标记要落成 2");
    // ④ ⛔ 出站游标不许留:遗留的旧 Ack 游标会被新账户首连直接传给引擎,
    //    ⇒ **新压实基线被当成"已经推过",静默不推**。
    assert_eq!(meta_get(&conn, "last_pushed"), None);
    assert_eq!(meta_get(&conn, "bootstrapped_at"), None);
}

// ---- 7 原空间还在也不撞 veto -----------------------------------------------------------

/// ⛔ **前提是「原空间还在」** —— 原空间不在的话这只测恒绿 = 假绿。
#[test]
fn restoring_while_the_original_space_is_still_there_produces_no_veto() {
    let r = rig("veto");
    let key = BackupKey::from_bytes(KEY_A);
    // 原空间就住在落点目录里(像一个真的空间那样按 ULID 命名),恢复之后两库并存。
    let original_id = ulid::Ulid::new().to_string();
    let src_name = format!("{original_id}.sqlite3");
    let db = r.build_db(&src_name, |c, k| {
        seed_rich(c, k);
        seed_config(c);
    });
    let live = r.spaces.join(&src_name);
    std::fs::copy(&db, &live).unwrap();
    let file = r.seal(&db, "v.zjbak", &key, crate::db::SCHEMA_VERSION);

    let out = r.restore(&file, &key).expect("恢复");
    assert!(live.exists(), "⛔ 原空间必须原样在那儿");

    let idents: Vec<crate::spaces::SpaceIdentity> = [(original_id.as_str(), &live), (out.space_id.as_str(), &out.path)]
        .iter()
        .map(|(id, path)| {
            let conn = peek(path);
            let clock = Clock::load(&conn).unwrap();
            crate::spaces::read_identity(id, path, &conn, &clock).unwrap()
        })
        .collect();
    let vetoes = crate::spaces::identity_vetoes(&idents);
    assert!(vetoes.is_empty(), "恢复出来的空间不该被裁掉:{:?}", vetoes.keys().collect::<Vec<_>>());
}

// ---- 8 还有图没下全(⭐ 唯一一个「正常业务态却被拒」的)----------------------------------

#[test]
fn a_backup_taken_before_the_images_finished_downloading_is_refused_loudly() {
    let r = rig("blob");
    let key = BackupKey::from_bytes(KEY_A);
    // ⚠ 样本只脏这一格:integrity 干净、版本对、身份干净 —— 否则别的闸会代答。
    let db = r.build_db("blob.sqlite3", |c, k| {
        let item = crate::task::create(c, k, "带图的任务", None, None, None).unwrap();
        let (img, _) = crate::images::attach(c, k, &item, &[9, 9, 9], "image/png").unwrap();
        // 「有 image_add、无 tombstone、宿主活着、字节行未建」= 还在途中的那一格。
        c.execute("DELETE FROM item_image WHERE id = ?1", [&img]).unwrap();
    });
    let file = r.seal(&db, "blob.zjbak", &key, crate::db::SCHEMA_VERSION);

    let e = r.restore(&file, &key).unwrap_err();
    assert_eq!(e.stage, RestoreStage::PendingBlob, "{}", e.message);
    assert!(e.message.contains('1'), "话要点名是几张:{}", e.message);
    assert!(e.message.contains("同步完"), "话要给唯一那条出路:{}", e.message);
    assert!(r.staging_left().is_empty(), "残留:{:?}", r.staging_left());
    assert!(r.published().is_empty());
}

// ---- 9 库自身坏了 ---------------------------------------------------------------------

#[test]
fn a_corrupt_library_inside_a_perfectly_valid_backup_is_refused() {
    let r = rig("corrupt");
    let key = BackupKey::from_bytes(KEY_A);
    let db = r.build_db("corrupt.sqlite3", |c, k| {
        seed_rich(c, k);
    });
    // 注入:把一整页数据页涂掉(⚠ 不动第 1 页的文件头与 schema —— 那样会在幕③就打不开,
    // 这只测要断的是**幕④**那道闸)。
    {
        let mut bytes = std::fs::read(&db).unwrap();
        let page = 4096usize;
        assert!(bytes.len() > page * 4, "样本库太小,涂不到数据页");
        for b in bytes[page * 3..page * 4].iter_mut() {
            *b = 0x5a;
        }
        std::fs::write(&db, &bytes).unwrap();
    }
    let file = r.seal(&db, "corrupt.zjbak", &key, crate::db::SCHEMA_VERSION);

    let e = r.restore(&file, &key).unwrap_err();
    // ⛔ **断到恰好这一格**(codex 实现审 L1 打的就是这里:我一稿写的是
    // `Integrity | Migrate`,那等于允许**幕③代答幕④** —— 与本案一直坚持的
    // 「别让前一道闸背书」当场打架)。样本刻意只涂数据页、不碰第 1 页的文件头与 schema,
    // 所以幕③(当前版 ⇒ `run_migrations` 是 no-op)一定走得过去。
    assert_eq!(e.stage, RestoreStage::Integrity, "该在幕④ integrity 那一格拒:{}", e.message);
    assert!(e.message.contains("integrity_check"), "话要点名是哪一格:{}", e.message);
    assert!(r.staging_left().is_empty(), "残留:{:?}", r.staging_left());
    assert!(r.published().is_empty());
}

/// 幕④ 的**第二格**要有只有它拒得掉的样本(codex 实现审 L1 的另一半:
/// `ForeignKey` 此前有实现、有分档,却没有任何样本钉住它)。
///
/// ⚠ 样本只脏这一格:`integrity_check` 对外键违例**说 ok**(那不是结构损坏),
/// 版本对、身份干净 ⇒ 只有 `foreign_key_check` 拒得掉。
/// ⭐ 它同时钉住 §16.3 那句「幕③开外键与幕④ 的 `foreign_key_check` **不互相代答**」:
/// 开外键管的是**此后**的写入,这道查的是备份文件里**已有的**行。
#[test]
fn a_library_with_dangling_foreign_keys_is_refused_in_its_own_slot() {
    let r = rig("fk");
    let key = BackupKey::from_bytes(KEY_A);
    let db = r.build_db("fk.sqlite3", |c, k| {
        crate::notes::capture(c, k, "有条目").unwrap();
        // ⚠ 临时关掉外键(**连接级、不落盘**)才插得进这一行 —— 它指向一个不存在的条目。
        // 这正是「备份文件里已有的坏行」那一类:写它的那台机器当时可能就没开外键。
        // (`born_device` 必须等于本机 device_id,否则 0035 那只触发器当场 ABORT。)
        c.pragma_update(None, "foreign_keys", false).unwrap();
        let device: String = meta_get(c, "device_id").unwrap();
        c.execute(
            "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
             VALUES ('01ZZZZZZZZZZZZZZZZZZZZZZZZ', '01NOSUCHITEMNOSUCHITEMXXXX', '孤儿留言', \
                     '2026-08-17T00:00:00.000Z', ?1)",
            [&device],
        )
        .unwrap();
    });
    let file = r.seal(&db, "fk.zjbak", &key, crate::db::SCHEMA_VERSION);

    let e = r.restore(&file, &key).unwrap_err();
    assert_eq!(e.stage, RestoreStage::ForeignKey, "该在幕④ 外键那一格拒:{}", e.message);
    assert!(e.message.contains("外键"), "话要点名是哪一格:{}", e.message);
    assert!(r.staging_left().is_empty(), "残留:{:?}", r.staging_left());
    assert!(r.published().is_empty());
}

// ---- 10 no-clobber --------------------------------------------------------------------

/// ⛔ 撞名**不是**"结构上不可达"(ULID 碰撞 / 用户预放同名 / 外部进程抢先):
/// 准确说法 = **撞名概率极低,而原子 no-clobber 保证撞名只会"拒绝",绝不覆盖**。
/// ⚠ 目标名是 arm() 现取的随机 ULID,测试预先造不出来 ⇒ 用 `cfg(test)` 的显式注入钉死它。
#[test]
fn a_name_clash_at_the_landing_spot_refuses_instead_of_overwriting() {
    let r = rig("clobber");
    let key = BackupKey::from_bytes(KEY_A);
    let (_db, file) = r.rich_backup(&key);

    let forced = format!("{}.sqlite3", ulid::Ulid::new());
    let squatter = r.spaces.join(&forced);
    std::fs::write(&squatter, "我先来的").unwrap();
    crate::backup::staging::FORCE_SNAPSHOT_NAME.with(|c| *c.borrow_mut() = Some(forced.clone()));

    let e = r.restore(&file, &key).unwrap_err();
    assert_eq!(e.stage, RestoreStage::Publish, "{}", e.message);
    assert!(e.message.contains(&forced), "话要点名是哪条路径:{}", e.message);
    assert_eq!(std::fs::read_to_string(&squatter).unwrap(), "我先来的", "⛔ 原文件一个字节都不许动");
    assert!(r.staging_left().is_empty(), "拒了也要清场:{:?}", r.staging_left());
}

// ---- 13 清场矩阵 ----------------------------------------------------------------------

/// 幕②③④⑤ 各注入一次失败 → staging **零残留**;
/// ⛔ 不用"只读目录"造失败(root 无视权限位、Windows ACL 语义不同),用显式故障注入 / 脏样本。
#[test]
fn every_failed_act_leaves_no_plaintext_behind() {
    let r = rig("cleanup-matrix");
    let key = BackupKey::from_bytes(KEY_A);

    // 幕②:密文改过 → 解到一半失败。
    let (_db, good) = r.rich_backup(&key);
    let mut bytes = std::fs::read(&good).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xff;
    let broken = r.root.join("act2.zjbak");
    std::fs::write(&broken, &bytes).unwrap();
    let e = r.restore(&broken, &key).unwrap_err();
    assert_eq!(e.stage, RestoreStage::Read(ReadError::Auth));
    assert!(r.staging_left().is_empty(), "幕②残留:{:?}", r.staging_left());

    // 幕③:两把尺不符。
    let db3 = r.build_db("act3.sqlite3", |c, k| {
        crate::notes::capture(c, k, "三").unwrap();
    });
    let f3 = r.seal(&db3, "act3.zjbak", &key, crate::db::SCHEMA_VERSION - 1);
    assert_eq!(r.restore(&f3, &key).unwrap_err().stage, RestoreStage::VersionMismatch);
    assert!(r.staging_left().is_empty(), "幕③残留:{:?}", r.staging_left());

    // 幕④:图字节没下全。
    let db4 = r.build_db("act4.sqlite3", |c, k| {
        let item = crate::task::create(c, k, "四", None, None, None).unwrap();
        let (img, _) = crate::images::attach(c, k, &item, &[1], "image/png").unwrap();
        c.execute("DELETE FROM item_image WHERE id = ?1", [&img]).unwrap();
    });
    let f4 = r.seal(&db4, "act4.zjbak", &key, crate::db::SCHEMA_VERSION);
    assert_eq!(r.restore(&f4, &key).unwrap_err().stage, RestoreStage::PendingBlob);
    assert!(r.staging_left().is_empty(), "幕④残留:{:?}", r.staging_left());

    // 幕⑤:库里没有 device_id ⇒ 压实拒(⚠ 这一格前面四道闸全过,只有幕⑤拒得掉)。
    let db5 = r.root.join("act5.sqlite3");
    {
        let conn = Connection::open(&db5).unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        crate::db::run_migrations(&conn, i64::MAX).unwrap();
        conn.close().unwrap();
    }
    let f5 = r.seal(&db5, "act5.zjbak", &key, crate::db::SCHEMA_VERSION);
    let e5 = r.restore(&f5, &key).unwrap_err();
    assert_eq!(e5.stage, RestoreStage::Identity, "{}", e5.message);
    assert!(r.staging_left().is_empty(), "幕⑤残留:{:?}", r.staging_left());
    assert!(r.published().is_empty(), "四趟失败一个空间都不许发布");
}

/// **明文删不掉 ⇒ 必须报上来**(调用方据此封锁备份,与备份 §6.1 幕⑤那条规则同档)。
#[test]
fn plaintext_that_cannot_be_deleted_is_reported_so_the_caller_can_block() {
    let r = rig("stuck");
    let key = BackupKey::from_bytes(KEY_A);
    let db = r.build_db("s.sqlite3", |c, k| {
        crate::notes::capture(c, k, "一").unwrap();
    });
    let f = r.seal(&db, "s.zjbak", &key, crate::db::SCHEMA_VERSION - 1); // 幕③ 必失败
    crate::backup::staging::FAIL_CLEANUP.with(|c| c.set(true));
    let e = r.restore(&f, &key).unwrap_err();
    assert_eq!(e.stage, RestoreStage::VersionMismatch, "分档不许被清场失败盖掉:{}", e.message);
    assert!(e.plaintext_stuck.is_some(), "删不掉必须报上来:{}", e.message);
    assert!(e.message.contains("明文"), "话要说清盘上留的是什么:{}", e.message);
    // ⚠ **这里刻意不断"文件还在"**:注入只让显式 `cleanup()` 报错、不真的挡住删除,而
    // `Drop` 那层 best-effort 随后仍会把它删掉(三层清场的第③层,那是对的)。
    // 这只测要钉的是**上报**这件事 —— 调用方据此封锁;真正"删不掉"的现场由启动清扫兜。
}

// ---- 17 `clear_config` 的精确差分 -------------------------------------------------------

/// ⭐ **唯一判据一句话**:`expected = clear 之前整张 sync_meta 的 key→value map`,
/// 从 expected **精确删掉那十键**,断 `after == expected`。
/// 它同时封住四个方向:十键一个不少地删 / 其余键连**值**一起一个不动 / 没有新增键 /
/// 「除了 `device_id` 全删」必红(靠那枚**未知哨兵键**)。
/// ⛔ 别改成「列出保留全集」——那会让将来任何一个新增的 `sync_meta` 键**无理由红**。
#[test]
fn clear_config_removes_exactly_ten_keys_and_touches_nothing_else() {
    let r = rig("clearcfg");
    let path = r.build_db("cfg.sqlite3", |c, k| {
        seed_rich(c, k);
        seed_config(c);
        meta_put(c, "pending_device_id", "01BBBBBBBBBBBBBBBBBBBBBBBB");
        meta_put(c, "pending_device_key", &"1".repeat(64));
        meta_put(c, "pending_pubkey", &"2".repeat(64));
        meta_put(c, "pending_state", "registered");
        // ⭐ 哨兵:一枚本函数**不认识**的键。「为了省事写成『除了 device_id 全删』」
        // 只有它抓得住。
        meta_put(c, "zz_sentinel_unknown_key", "别动我");
        // 顺带把真实业务里会在场的那几类也放进去(LAN 缓存 / 隔离闸)。
        meta_put(c, "poison_breaker", "1");
        meta_put(c, "lan_ad_seq", "7");
    });
    let mut conn = Connection::open(&path).unwrap();
    let before = meta_all(&conn);
    let mut expected = before.clone();
    // ⚠ 这十个名字**故意手写第二遍**:与被测那份共用一个常量的话,
    // 「漏删 last_pushed」这类变异会把测试一起改掉 = 假绿。
    for k in [
        "account_id",
        "k_acc",
        "device_key",
        "server_url",
        "last_pushed",
        "bootstrapped_at",
        "pending_device_id",
        "pending_device_key",
        "pending_pubkey",
        "pending_state",
    ] {
        assert!(expected.remove(k).is_some(), "样本里得先有 {k},否则这只测什么都没证明");
    }

    crate::sync::transport::clear_config(&mut conn).unwrap();

    assert_eq!(meta_all(&conn), expected, "整张 map 必须恰好少掉那十键、其余连值都不动");
}
