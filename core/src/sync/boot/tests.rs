use super::*;
use crate::sync::crypto::{self, Domain, FrameAddr};

/// space-entry-plan §3.2(codex 二轮 H1)的词法闸:integrity_check 必须在
/// `import_attached` 的导入事务内、`bootstrapped_at` 落标与 commit **之前**
/// (不过即整体回滚——绝不发布/激活一个完整性已失败的库);commit 之后
/// (`import_snapshot` 事务外)不许再有任何体检。为什么按源码钉:只被
/// integrity_check 捕获的页级损坏无法用安全 API 确定性注入,行为测照不出次序。
#[test]
fn integrity_check_inside_import_tx_before_commit_lexical() {
    let src = include_str!("../boot.rs");
    let start = src.find("fn import_attached").expect("函数在本文件");
    let end = start + src[start..].find("\n}").expect("函数体以行首 } 结束");
    let body = &src[start..end];
    let integrity =
        body.find("integrity_check\"").expect("integrity_check 必须在 import_attached 内");
    let mark = body.find("'bootstrapped_at'").expect("落标在本函数");
    let commit = body.rfind("tx.commit()").expect("函数以 commit 收尾");
    assert!(integrity < mark, "integrity_check 必须先于 bootstrapped_at 落标");
    assert!(integrity < commit, "integrity_check 必须先于 commit");
    // commit 之后的 import_snapshot(事务外)零体检:完成边界 = 只剩 DETACH 分道。
    let snap_start = src.find("pub fn import_snapshot").expect("函数在本文件");
    let snap_end = snap_start + src[snap_start..].find("\n}").expect("函数体以行首 } 结束");
    assert!(
        !src[snap_start..snap_end].contains("integrity_check\""),
        "commit 之后不许再有体检(失败会把已提交的引导洗成 Err 重试)"
    );
}
use crate::sync::engine::{BlobPolicy, Engine, Msg, Output, Route, BROADCAST};
use crate::sync::pair::{
    gen_device_key, gen_secret, AccountGrant, DeviceEnroll, Joiner, Opener, PairOutput,
};
use crate::{db, images, notes, oplog, task};
use rusqlite::Connection;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_dir_for(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("ys-nb-boot-{}-{}-{}", tag, std::process::id(), n));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    dir
}

/// 一个真库实例(独立文件 + 时钟)。
struct Peer {
    conn: Connection,
    clock: Clock,
    device_id: String,
    dir: PathBuf,
}

fn peer(tag: &str) -> Peer {
    let dir = temp_dir_for(tag);
    let conn = db::open(&dir.join("db.sqlite3")).expect("open");
    let clock = Clock::load(&conn).expect("clock");
    let device_id = clock.device_id().to_string();
    Peer { conn, clock, device_id, dir }
}

/// 绕过供货闸的裸快照(对抗测试专用):恶意/坏源不会替我们跑严格电池
/// (epoch-plan §3.3 的闸只拦诚实调用方),引导收端的审计必须独立自卫——
/// 坏快照在测试里也必须绕闸生产,否则测的是闸、不是收端。
fn raw_snapshot(conn: &Connection, dir: &Path) -> Snapshot {
    let path = dir.join(format!("boot-snapshot-{}.sqlite3", Ulid::new()));
    conn.execute("VACUUM INTO ?1", [path.to_str().unwrap()]).unwrap();
    let (bytes, sha256) = hash_file(&path).unwrap();
    Snapshot { path, bytes, sha256 }
}

/// 回放豁免下手插一行(造 0020 之前的 legacy 无背书行;单机正道插不出这种行)。
fn insert_legacy_row(conn: &Connection, id: &str, sealed: bool, born_null: bool) {
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    conn.execute(
        "INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, \
                            due_on, priority, position, sealed_at, born_stage) \
         VALUES (?1, '同步纪元前的遗产', 'done', 't0', 't0', NULL, NULL, NULL, 'a0', \
                 ?2, ?3)",
        (
            id,
            if sealed { Some("t9") } else { None },
            if born_null { None } else { Some("todo") },
        ),
    )
    .unwrap();
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();
}

// ---- 0025:两只 INSERT 守护的豁免形态(迁移折测) ----

#[test]
fn migration_0025_guards_still_bite_outside_replay_but_yield_inside() {
    let p = peer("m25");
    // 非豁免:生而归档 / born_stage NULL / born_stage ≠ stage 全 ABORT(单机铁律不松)。
    for (sealed, born) in [(Some("t9"), Some("done")), (None, None::<&str>), (None, Some("inbox"))] {
        let err = p
            .conn
            .execute(
                // born_device 给对(0033),否则它先 ABORT,本测就验不到 0025 那两只。
                "INSERT INTO items (id, content, stage, created_at, updated_at, position, \
                                    sealed_at, born_stage, born_device) \
                 VALUES ('x', 'x', 'done', 't', 't', 'a0', ?1, ?2, \
                         (SELECT value FROM sync_meta WHERE key = 'device_id'))",
                (sealed, born),
            )
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("归档标记") || msg.contains("出生态"),
            "该被守护触发器拦下,实际:{msg}"
        );
    }
    // 豁免:三种终态行(sealed 非空 / born NULL / born ≠ stage)全放行。
    insert_legacy_row(&p.conn, "L1", true, true);
    insert_legacy_row(&p.conn, "L2", false, true);
    insert_legacy_row(&p.conn, "L3", false, false);
    let n: i64 = p.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 3);
}

// ---- BootMsg 线上格式 ----

/// boot 域内层消息黄金向量(externally tagged;与 Msg/信封/PairWire 同纪律)。
#[test]
fn boot_msg_golden_vectors() {
    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
    let cases: Vec<(BootMsg, &str)> = vec![
        (BootMsg::Req, "63526571"),
        (
            BootMsg::Offer { transfer: "T".into(), bytes: 5, sha256: vec![0xAB] },
            "a1654f66666572a3687472616e736665726154656279746573056673686132353641ab",
        ),
        (
            BootMsg::Chunk { transfer: "T".into(), idx: 0, last: true, data: vec![1, 2] },
            "a1654368756e6ba4687472616e7366657261546369647800646c617374f56464617461420102",
        ),
    ];
    for (msg, want) in cases {
        let mut buf = Vec::new();
        ciborium::into_writer(&msg, &mut buf).unwrap();
        assert_eq!(hex(&buf), want, "{msg:?} 的 CBOR 字节形态漂了");
        let back: BootMsg = ciborium::from_reader(buf.as_slice()).unwrap();
        assert_eq!(back, msg);
    }
}

// ---- fresh-to-account 判据 ----

#[test]
fn fresh_check_passes_on_virgin_and_fully_endorsed_dbs() {
    let mut p = peer("fresh-ok");
    check_fresh_to_account(&p.conn).expect("空库即 fresh");
    // 真命令造数据:每一行都有本机 op 背书。
    let idea = notes::capture(&mut p.conn, &mut p.clock, "有背书的灵感").unwrap();
    let topic = notes::create_topic(&mut p.conn, &mut p.clock, "标签").unwrap();
    notes::file_to_topic(&mut p.conn, &mut p.clock, &idea, Some(&topic), None).unwrap();
    let task_id = task::create(&mut p.conn, &mut p.clock, "任务", None, None, None).unwrap();
    images::attach(&mut p.conn, &mut p.clock, &task_id, &[1, 2, 3], "image/png").unwrap();
    check_fresh_to_account(&p.conn).expect("全背书仍 fresh");
}

#[test]
fn fresh_check_rejects_foreign_ops_bootstrap_mark_and_legacy_rows() {
    // 有他人 origin 的 op:曾同步过,走水位追赶。
    let p = peer("fresh-foreign");
    oplog::append_remote(
        &p.conn,
        "01JZFOREIGNOP000000000000A",
        "0000018f00000000-00000000-01JZFOREIGNDEV00000000000A",
        "topic",
        "01JZFOREIGNTOPIC000000000A",
        "create",
        &serde_json::json!({"title": "t", "created_at": "t", "updated_at": "t"}),
        1,
    )
    .unwrap();
    let err = check_fresh_to_account(&p.conn).unwrap_err();
    assert!(err.contains("水位追赶"), "{err}");

    // 已引导过:标记挡住重复引导。
    let p = peer("fresh-marked");
    p.conn
        .execute("INSERT INTO sync_meta (key, value) VALUES ('bootstrapped_at', 't')", [])
        .unwrap();
    let err = check_fresh_to_account(&p.conn).unwrap_err();
    assert!(err.contains("已完成过引导"), "{err}");

    // legacy 无背书行:只能作为账户首台(评审①-H1 的 (b))。
    let p = peer("fresh-legacy");
    insert_legacy_row(&p.conn, "L1", false, true);
    let err = check_fresh_to_account(&p.conn).unwrap_err();
    assert!(err.contains("账户首台"), "{err}");
}

/// 供货闸(epoch-plan §3.3):快照出手前电池现场重跑——带 legacy 的库拒当引导源
/// (不是看 `epoch` KV,标记可孤立漂移);干净库照常供货(阴性对照)。
#[test]
fn supply_gate_refuses_uncertified_source() {
    let mut a = peer("gate-src");
    notes::capture(&mut a.conn, &mut a.clock, "正常数据").unwrap();
    make_snapshot(&a.conn, &a.dir).expect("干净库照常供货");
    insert_legacy_row(&a.conn, "L1", false, true);
    let err = make_snapshot(&a.conn, &a.dir).unwrap_err();
    assert!(err.contains("纪元认证"), "{err}");
}

/// fresh 第四闸(epoch-plan §3.5):行全有背书、日志全是本机 op——判据 (a)/(b)
/// 都过,唯 op 是旧形态(int position)。只有第四闸能拦;不拦则引导合并后在
/// 导入审计才炸,人话降级成审计报错。
#[test]
fn fresh_check_rejects_legacy_shaped_ops_fourth_gate() {
    let mut a = peer("fresh4");
    let task = task::create(&mut a.conn, &mut a.clock, "行有背书", None, None, None).unwrap();
    check_fresh_to_account(&a.conn).expect("现代形态 = fresh(阴性对照)");
    let hlc = a.clock.tick(&a.conn).unwrap();
    let seq: i64 = a
        .conn
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
            [hlc.device_id.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    a.conn
        .execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, 'item', ?3, 'set_field', \
                     '{\"field\":\"position\",\"value\":7}', ?4)",
            rusqlite::params![ulid::Ulid::new().to_string(), hlc.encode(), task, seq],
        )
        .unwrap();
    let err = check_fresh_to_account(&a.conn).unwrap_err();
    assert!(err.contains("旧形态操作记录"), "{err}");
}

// ---- 快照流 ----

/// 299 codex 实现审 M1:**纯本地派生数据不许搭引导快照的车**。
///
/// `VACUUM INTO` 是整库复制,0032 的缩略图表会被一起装走。收端 `import_attached`
/// 不导入它——但那只让「不进表级导入」成立,字节照样被哈希、分块、加密、传输、
/// 落到收端临时文件才丢掉,还白占 `MAX_SNAPSHOT_BYTES` 的额度。image-perf-plan §0
/// 拍板的「不进引导」要的是这件事**本身不发生**。
///
/// 断言两侧都要:源库里缩略图**还在**(剥的是快照,不是用户的本地缓存),
/// 快照里**一行不剩**;并且快照仍是个好用的快照(能引导、体积没白涨)。
#[test]
fn snapshot_carries_no_derived_rows() {
    let mut a = peer("snap-derived");
    let jpeg = |n: usize| {
        let mut v = vec![0xFFu8, 0xD8, 0xFF, 0xE0];
        v.resize(n, 0x7Bu8);
        v
    };
    // 三条带图的条目,每张图配一枚**明显大**的缩略图(小了看不出体积差)。
    for i in 0..3 {
        let it = notes::capture(&mut a.conn, &mut a.clock, &format!("配图 {i}")).unwrap();
        let (img, _) =
            crate::images::attach(&mut a.conn, &mut a.clock, &it, &jpeg(2048), "image/jpeg")
                .unwrap();
        crate::thumbs::put(&a.conn, &img, &jpeg(100 * 1024)).unwrap();
    }
    let local: i64 = a
        .conn
        .query_row("SELECT COUNT(*) FROM item_image_thumb", [], |r| r.get(0))
        .unwrap();
    assert_eq!(local, 3, "前置:源库确实有缩略图");

    let snap = make_snapshot(&a.conn, &a.dir).unwrap();

    // ① 快照里一行不剩。
    {
        let s = Connection::open(&snap.path).unwrap();
        let in_snap: i64 = s
            .query_row("SELECT COUNT(*) FROM item_image_thumb", [], |r| r.get(0))
            .unwrap();
        assert_eq!(in_snap, 0, "派生行不许搭快照的车");
        // 用户资产照旧全在(别把正表也剥了)。
        let imgs: i64 =
            s.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(imgs, 3, "正表的图必须原样在快照里");
        let ok: String =
            s.pragma_query_value(None, "integrity_check", |r| r.get(0)).unwrap();
        assert_eq!(ok, "ok", "剥完再 VACUUM 过的快照必须仍是好库");
    }
    // ② 源库的本地缓存分毫未动(剥的是快照那份副本)。
    let still: i64 = a
        .conn
        .query_row("SELECT COUNT(*) FROM item_image_thumb", [], |r| r.get(0))
        .unwrap();
    assert_eq!(still, 3, "剥的是快照,不是用户本地的缓存");
    // ③ **DELETE 之后真的又 VACUUM 过**:直接问快照的 freelist——只 DELETE 不 VACUUM
    //    的话页还挂在 freelist 上、照样要被哈希传输。
    //    (原先这一格断的是 `bytes < 300 KiB`,那会随 schema 自然长大而无关误红;
    //    codex 二轮 L 的更稳形。三条 M1 变异在这个判据下照样全红。)
    {
        let s = Connection::open(&snap.path).unwrap();
        let free: i64 =
            s.pragma_query_value(None, "freelist_count", |r| r.get(0)).unwrap();
        assert_eq!(free, 0, "剥完必须再 VACUUM:快照还有 {free} 个空页");
    }
    // ④ 声明的 bytes/sha256 描述的是**剥完之后**那个文件(先剥后 hash)。
    let (real_bytes, real_hash) = hash_file(&snap.path).unwrap();
    assert_eq!(snap.bytes, real_bytes);
    assert_eq!(snap.sha256, real_hash);
    let _ = std::fs::remove_file(&snap.path);
}

#[test]
fn snapshot_stream_round_trips_bytes_exactly() {
    let mut a = peer("snap-a");
    for i in 0..12 {
        notes::capture(&mut a.conn, &mut a.clock, &format!("灵感 {i}")).unwrap();
    }
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    assert!(snap.bytes > 0);
    let mut sender = BootSender::new(&snap).unwrap();
    let Some(BootMsg::Offer { transfer, bytes, sha256 }) = sender.next_msg().unwrap() else {
        panic!("首帧必须是 Offer");
    };
    assert_eq!(bytes, snap.bytes);

    let recv_dir = temp_dir_for("snap-b");
    let mut recv = BootReceiver::start(&recv_dir, "dev-a", &transfer, bytes, &sha256).unwrap();
    let mut outcome = ChunkOutcome::More;
    while let Some(msg) = sender.next_msg().unwrap() {
        let BootMsg::Chunk { transfer, idx, last, data } = msg else {
            panic!("Offer 后只该出 Chunk");
        };
        // 迷路残帧(错源/错 transfer)静默丢,不作废本流。
        assert_eq!(
            recv.on_chunk("dev-x", &transfer, idx, last, &data).unwrap(),
            ChunkOutcome::Ignored
        );
        assert_eq!(
            recv.on_chunk("dev-a", "01JZOTHERTRANSFER00000000A", idx, last, &data).unwrap(),
            ChunkOutcome::Ignored
        );
        outcome = recv.on_chunk("dev-a", &transfer, idx, last, &data).unwrap();
    }
    assert_eq!(outcome, ChunkOutcome::Complete);
    assert_eq!(
        std::fs::read(recv.path()).unwrap(),
        std::fs::read(&snap.path).unwrap(),
        "收到的快照必须与源文件逐字节相等"
    );
}

#[test]
fn receiver_rejects_tamper_disorder_and_oversize() {
    let mut a = peer("recv-guard");
    notes::capture(&mut a.conn, &mut a.clock, "x").unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    let dir = temp_dir_for("recv-guard-b");
    let t = || Ulid::new().to_string();

    // 声明大小不合理。
    assert!(BootReceiver::start(&dir, "a", &t(), 0, &[0; 32]).is_err());
    assert!(BootReceiver::start(&dir, "a", &t(), MAX_SNAPSHOT_BYTES + 1, &[0; 32]).is_err());
    assert!(BootReceiver::start(&dir, "a", &t(), 8, &[0; 31]).is_err());

    // 错序作废。
    let t1 = t();
    let mut recv = BootReceiver::start(&dir, "a", &t1, snap.bytes, &snap.sha256).unwrap();
    assert!(recv.on_chunk("a", &t1, 1, false, &[0]).is_err());
    // 作废后本流一切后续块 Ignored(不 panic 不复活)。
    assert_eq!(recv.on_chunk("a", &t1, 0, false, &[0]).unwrap(), ChunkOutcome::Ignored);

    // 超声明作废。
    let t2 = t();
    let mut recv = BootReceiver::start(&dir, "a", &t2, 4, &[0; 32]).unwrap();
    assert!(recv.on_chunk("a", &t2, 0, false, &[0; 5]).is_err());

    // 篡改:字节数对但内容动过 → sha256 拆穿。
    let t3 = t();
    let mut recv = BootReceiver::start(&dir, "a", &t3, snap.bytes, &snap.sha256).unwrap();
    let mut bad = std::fs::read(&snap.path).unwrap();
    bad[0] ^= 1;
    let err = recv.on_chunk("a", &t3, 0, true, &bad).unwrap_err();
    assert!(err.contains("sha256"), "{err}");

    // 长度短于声明的「终块」。
    let t4 = t();
    let mut recv = BootReceiver::start(&dir, "a", &t4, snap.bytes, &snap.sha256).unwrap();
    let err = recv.on_chunk("a", &t4, 0, true, &[0; 3]).unwrap_err();
    assert!(err.contains("长度不符"), "{err}");
}

#[test]
fn receiver_rejects_traversal_and_duplicate_transfer() {
    let dir = temp_dir_for("recv-path");
    // transfer 拼进本地路径:非 ULID 形态(穿越字节/随意串)一律拒
    // (codex P2-f 轮 H2)。
    for evil in ["../evil", "..\\evil", "a/b", "t", &"0".repeat(26 + 1)] {
        let err = BootReceiver::start(&dir, "a", evil, 8, &[0; 32]).unwrap_err();
        assert!(err.contains("ULID"), "{evil} 该被 ULID 校验拒:{err}");
    }
    // 同 transfer 重复开流:create_new 拒,绝不截断已有文件。
    let t = Ulid::new().to_string();
    let _keep = BootReceiver::start(&dir, "a", &t, 8, &[0; 32]).unwrap();
    let err = BootReceiver::start(&dir, "a", &t, 8, &[0; 32]).unwrap_err();
    assert!(err.contains("重复 transfer"), "{err}");
}

// ---- 导入合并 ----

#[test]
fn import_rejects_snapshot_of_self() {
    let mut a = peer("self-snap");
    notes::capture(&mut a.conn, &mut a.clock, "自己的数据").unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    let err = import_snapshot(&mut a.conn, &mut a.clock, &snap.path).unwrap_err();
    assert!(err.contains("本机自己"), "{err}");
    // 半途而废不留痕:无 bootstrapped 标记、行数不变。
    assert!(meta_get(&a.conn, "bootstrapped_at").unwrap().is_none());
    let n: i64 = a.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}

// ---- space profile 单例合并(0028,space-name-sync-plan §4.4) ----

fn space_profile_of(conn: &Connection) -> (i64, Option<Option<String>>) {
    let rows: i64 =
        conn.query_row("SELECT COUNT(*) FROM space_profile", [], |r| r.get(0)).unwrap();
    let name = conn
        .query_row("SELECT name FROM space_profile WHERE key = 'profile'", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()
        .unwrap();
    (rows, name)
}

/// 四象限矩阵(codex 一轮 H1):固定主键 'profile' 决定了 boot 绝不能表复制——
/// 「本地已命名 + 源也命名」必撞 PK;单例合并 = 合并日志取 HLC 赢家 UPSERT 物化。
#[test]
fn import_merges_space_profile_singleton_all_quadrants() {
    // ① 双方都有名:物化值 == 合并日志 HLC 最大 op 的 value(与语义审计同判据)。
    let mut a = peer("sp-q1-src");
    notes::capture(&mut a.conn, &mut a.clock, "数据").unwrap();
    crate::spaces::set_space_name(&mut a.conn, &mut a.clock, "源名").unwrap();
    let mut b = peer("sp-q1-dst");
    crate::spaces::set_space_name(&mut b.conn, &mut b.clock, "本机名").unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap();
    let (rows, name) = space_profile_of(&b.conn);
    assert_eq!(rows, 1, "恰一行(表复制必撞 PK 的根治形)");
    let winner: Option<String> = b
        .conn
        .query_row(
            "SELECT json_extract(payload, '$.value') FROM oplog \
             WHERE entity = 'space' ORDER BY hlc DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(name, Some(winner.clone()), "物化 == 合并日志赢家");
    assert!(
        matches!(winner.as_deref(), Some("源名") | Some("本机名")),
        "赢家必是两名之一:{winner:?}"
    );
    strict_battery(&b.conn).unwrap();

    // ② 仅源有名:名字随快照到。
    let mut c = peer("sp-q2-dst");
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    import_snapshot(&mut c.conn, &mut c.clock, &snap.path).unwrap();
    assert_eq!(space_profile_of(&c.conn), (1, Some(Some("源名".into()))));

    // ③ 仅本机有名:源零 space op,本机名不被搅动。
    let mut src2 = peer("sp-q3-src");
    notes::capture(&mut src2.conn, &mut src2.clock, "无名源").unwrap();
    let mut d = peer("sp-q3-dst");
    crate::spaces::set_space_name(&mut d.conn, &mut d.clock, "本机名").unwrap();
    let snap = make_snapshot(&src2.conn, &src2.dir).unwrap();
    import_snapshot(&mut d.conn, &mut d.clock, &snap.path).unwrap();
    assert_eq!(space_profile_of(&d.conn), (1, Some(Some("本机名".into()))));

    // ④ 双方无名:零行,无事发生。
    let mut e = peer("sp-q4-dst");
    let snap = make_snapshot(&src2.conn, &src2.dir).unwrap();
    import_snapshot(&mut e.conn, &mut e.clock, &snap.path).unwrap();
    assert_eq!(space_profile_of(&e.conn), (0, None));
    strict_battery(&e.conn).unwrap();

    // ⑤ null 赢家(codex 实现审 M4):源端显式清名(远端 null op,HLC 恒最高)
    // 压过本机名——物化 = 行在、name NULL(H2 规范表示)。
    let mut src3 = peer("sp-q5-src");
    notes::capture(&mut src3.conn, &mut src3.clock, "有数据").unwrap();
    crate::spaces::set_space_name(&mut src3.conn, &mut src3.clock, "先有名").unwrap();
    let clear = crate::replay::RemoteOp {
        op_id: Ulid::new().to_string(),
        hlc: Hlc {
            wall_ms: 4_102_444_800_000, // 2100 年,恒为全网最高
            counter: 0,
            device_id: "RMTDEV0000000000000000000X".into(),
        }
        .encode(),
        entity: "space".into(),
        entity_id: "profile".into(),
        kind: "set_field".into(),
        payload: serde_json::json!({"field": "name", "value": null}),
        origin_seq: 1,
    };
    crate::replay::apply_remote_op(&mut src3.conn, &mut src3.clock, &clear).unwrap();
    let mut f = peer("sp-q5-dst");
    crate::spaces::set_space_name(&mut f.conn, &mut f.clock, "本机名").unwrap();
    let snap = make_snapshot(&src3.conn, &src3.dir).unwrap();
    import_snapshot(&mut f.conn, &mut f.clock, &snap.path).unwrap();
    assert_eq!(space_profile_of(&f.conn), (1, Some(None)), "null 赢家 = 行在、name NULL");
    strict_battery(&f.conn).unwrap();
}

/// device 多实例寄存器的双侧预审(0033,identity-plan §2.1)——与上面 space 那只
/// 逐条同构,差别只在「一行」变成「每 device_id 一行」。三向都拒:行在无 op /
/// op 在行缺 / 值不符。**没有这只测,`audit_device_profile_semantics` 整只是死码**
/// (引导正路上的合法快照永远不会触发它,它防的是被篡改/损坏的源库)。
#[test]
fn import_rejects_device_profile_state_log_mismatch_both_sides() {
    let dev = "01DEVAAAAAAAAAAAAAAAAAAAAA";
    // ① 源侧「行在无 op」:裸快照(绕供货闸)塞一行无背书的 device_profile。
    let mut a = peer("dv-bad-src");
    notes::capture(&mut a.conn, &mut a.clock, "数据").unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    {
        let sc = Connection::open(&snap.path).unwrap();
        sc.execute("INSERT INTO device_profile (device_id, alias) VALUES (?1, '伪名')", [dev])
            .unwrap();
    }
    let mut b = peer("dv-bad-src-dst");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("快照") && err.contains("行在无 op"), "{err}");
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none(), "半途无痕");

    // ② 本机侧「行在无 op」:直插模拟本地损坏(device_profile 无触发器守护)。
    let mut c = peer("dv-bad-local");
    c.conn
        .execute("INSERT INTO device_profile (device_id, alias) VALUES (?1, '幽灵')", [dev])
        .unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    let err = import_snapshot(&mut c.conn, &mut c.clock, &snap.path).unwrap_err();
    assert!(err.contains("本机") && err.contains("行在无 op"), "{err}");

    // ③ 源侧「op 在行缺」:有 op、把行删了(op 是史实删不掉,行不是)。
    let mut d = peer("dv-bad-missing");
    notes::capture(&mut d.conn, &mut d.clock, "数据").unwrap();
    crate::identity::set_device_alias(&mut d.conn, &mut d.clock, dev, Some("甲")).unwrap();
    let snap = raw_snapshot(&d.conn, &d.dir);
    {
        let sc = Connection::open(&snap.path).unwrap();
        sc.execute("DELETE FROM device_profile WHERE device_id = ?1", [dev]).unwrap();
    }
    let mut e = peer("dv-bad-missing-dst");
    let err = import_snapshot(&mut e.conn, &mut e.clock, &snap.path).unwrap_err();
    assert!(err.contains("快照") && err.contains("op 在行缺"), "{err}");

    // ④ 源侧「值不符」:有 op、行也在,但行值 ≠ 日志赢家。
    let mut f = peer("dv-bad-val");
    notes::capture(&mut f.conn, &mut f.clock, "数据").unwrap();
    crate::identity::set_device_alias(&mut f.conn, &mut f.clock, dev, Some("甲")).unwrap();
    let snap = raw_snapshot(&f.conn, &f.dir);
    {
        let sc = Connection::open(&snap.path).unwrap();
        sc.execute("UPDATE device_profile SET alias = '改错' WHERE device_id = ?1", [dev])
            .unwrap();
    }
    let mut g = peer("dv-bad-val-dst");
    let err = import_snapshot(&mut g.conn, &mut g.clock, &snap.path).unwrap_err();
    assert!(err.contains("快照") && err.contains("LWW 赢家不符"), "{err}");
}

/// 验收工装(302):对一枚**真实库副本**跑 strict battery。`strict_battery` 是
/// `pub(crate)`,examples 够不到,所以这道验收只能落在测试里。
///
/// 默认 `#[ignore]`,只在真实库迁移验收时手动跑:
/// ```text
/// ZHUJIAN_BATTERY_DB=<副本路径> cargo test --lib battery_on_a_real_db_copy -- --ignored --nocapture
/// ```
/// **只喂副本**——它虽然只读,但别拿生产库当试验田(`ys-notebook-migration-trap`)。
#[test]
#[ignore = "验收工装:要 ZHUJIAN_BATTERY_DB 指向一枚真实库副本"]
fn battery_on_a_real_db_copy() {
    let path = std::env::var("ZHUJIAN_BATTERY_DB")
        .expect("用法:ZHUJIAN_BATTERY_DB=<副本路径> cargo test ... -- --ignored");
    let conn = Connection::open(&path).expect("开副本");
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    strict_battery(&conn).expect("真实库副本必须过 strict battery");
    println!("✓ {path} 过 strict battery");
}

/// **两侧都已经有同一台设备那一行**时,引导必须合并而不是撞 PRIMARY KEY。
///
/// 原实现走表级复制,论证是「两侧同时有某个 device_id 的行 = 前提被破坏」——过强:
/// `identity::set_device_alias` 有意**不锁本机**(名册账户内共享),而 fresh 闸只排除
/// **他人 origin** 的 op、本机 op 是许的。于是这个局面两侧都合法,旧代码在这里整个
/// 引导失败。codex 301 实现审 M1。
#[test]
fn import_merges_a_device_row_that_both_sides_already_have() {
    let dev = "01DEVAAAAAAAAAAAAAAAAAAAAA";
    let mut a = peer("dv-merge-src");
    notes::capture(&mut a.conn, &mut a.clock, "数据").unwrap();
    crate::identity::set_device_alias(&mut a.conn, &mut a.clock, dev, Some("甲")).unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();

    let mut b = peer("dv-merge-dst");
    crate::identity::set_device_alias(&mut b.conn, &mut b.clock, dev, Some("乙")).unwrap();
    import_snapshot(&mut b.conn, &mut b.clock, &snap.path)
        .expect("两侧都有这一行:必须按日志合并,不是撞 PK 把整个引导打掉");

    // 赢家用**独立观测**算:把合并后的 device op 全读出来、自己按 hlc 排序取最大,
    // 不复用实现那条 SQL——复用就成了同义反复,证不出口径对不对。
    let mut stmt = b
        .conn
        .prepare(
            "SELECT hlc, json_extract(payload, '$.value') FROM oplog \
             WHERE entity = 'device' AND entity_id = ?1 AND kind = 'set_field'",
        )
        .unwrap();
    let mut ops: Vec<(String, Option<String>)> = stmt
        .query_map([dev], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(ops.len(), 2, "两侧各发过一条,合并后都在");
    ops.sort();
    let winner = ops.last().unwrap().1.clone();
    let got: Option<String> = b
        .conn
        .query_row("SELECT alias FROM device_profile WHERE device_id = ?1", [dev], |r| r.get(0))
        .unwrap();
    assert_eq!(got, winner, "表值必须 == 日志的 HLC 赢家");
    assert!(matches!(got.as_deref(), Some("甲") | Some("乙")), "赢家必是两个真名之一");
    strict_battery(&b.conn).expect("合并后状态⟺日志必须自洽");
}

/// 双侧独立预审(codex 二轮 M1):任一侧「状态与日志矛盾」响亮拒,合并绝不代修。
#[test]
fn import_rejects_space_profile_state_log_mismatch_both_sides() {
    // 源侧:裸快照(绕供货闸)塞一行无 op 背书的 profile。
    let mut a = peer("sp-bad-src");
    notes::capture(&mut a.conn, &mut a.clock, "数据").unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    {
        let sc = Connection::open(&snap.path).unwrap();
        sc.execute("INSERT INTO space_profile (key, name) VALUES ('profile', '伪名')", [])
            .unwrap();
    }
    let mut b = peer("sp-bad-src-dst");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("快照") && err.contains("行在无 op"), "{err}");
    // 半途无痕。
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none());

    // 本机侧:本地 profile 行无 op(space_profile 无触发器守护,直插模拟损坏)。
    let mut c = peer("sp-bad-local");
    c.conn
        .execute("INSERT INTO space_profile (key, name) VALUES ('profile', '幽灵')", [])
        .unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    let err = import_snapshot(&mut c.conn, &mut c.clock, &snap.path).unwrap_err();
    assert!(err.contains("本机") && err.contains("行在无 op"), "{err}");

    // 源侧变体(codex 实现审 M4):有 op、行也在,但行值 ≠ 日志赢家——拒。
    let mut d = peer("sp-bad-val-src");
    notes::capture(&mut d.conn, &mut d.clock, "数据").unwrap();
    crate::spaces::set_space_name(&mut d.conn, &mut d.clock, "真名").unwrap();
    let snap = raw_snapshot(&d.conn, &d.dir);
    {
        let sc = Connection::open(&snap.path).unwrap();
        sc.execute("UPDATE space_profile SET name = '改错' WHERE key = 'profile'", []).unwrap();
    }
    let mut e = peer("sp-bad-val-dst");
    let err = import_snapshot(&mut e.conn, &mut e.clock, &snap.path).unwrap_err();
    assert!(err.contains("快照") && err.contains("赢家不符"), "{err}");
}

/// 工序1 的 boot 分支覆盖(codex 复审 §7):非 NULL done_at 随快照整行到新端、逐字保留,
/// 并经引导 strict battery(done_at 已入 ITEM_LWW_FIELDS + create-forced-NULL 审计)。此前
/// boot 只走 done_at=NULL,整行复制与审计的非 NULL 分支未被执行。
#[test]
fn import_preserves_nonnull_done_at() {
    let mut a = peer("done-a");
    let id = task::create(&mut a.conn, &mut a.clock, "干完的活", None, None, None).unwrap();
    task::transition(&mut a.conn, &mut a.clock, &id, "done").unwrap();
    // 工序1 无本地 writer:合法远端 done_at set_field 落值 + 记 op(strict battery 要求行值
    // == oplog LWW 赢家,故经 apply_remote_op 落值,而非裸 UPDATE)。
    let done_ts = "2026-07-20T10:00:00.000Z";
    crate::replay::apply_remote_op(
        &mut a.conn,
        &mut a.clock,
        &crate::replay::RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: crate::clock::Hlc {
                wall_ms: 4_102_444_800_000,
                counter: 0,
                device_id: "RMTDEV0000000000000000000X".into(),
            }
            .encode(),
            entity: "item".into(),
            entity_id: id.clone(),
            kind: "set_field".into(),
            payload: serde_json::json!({"field": "done_at", "value": done_ts}),
            origin_seq: 1,
        },
    )
    .expect("done_at 落值");

    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    let mut b = peer("done-b");
    check_fresh_to_account(&b.conn).expect("新端 fresh");
    import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap().expect_clean_commit();
    let got: Option<String> =
        b.conn.query_row("SELECT done_at FROM items WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(got.as_deref(), Some(done_ts), "引导后 done_at 逐字保留");
}

/// §6.2 全形态导入:老端(归档成就/回收站/图/编辑历史/标签),新端有配对前本地
/// 数据 + 同名标签——并集、零丢失、时钟推进、标记落盘。严格纪元(epoch-plan
/// §3.2)起快照不得携带无背书 legacy 行(负例见
/// `import_rejects_snapshot_with_unbacked_row`),夹具全走命令正道。
#[test]
fn import_merges_all_shapes_and_advances_clock() {
    let mut a = peer("imp-a");
    // 老端全形态数据(命令正道)。
    let idea = notes::capture(&mut a.conn, &mut a.clock, "灵感甲").unwrap();
    let t_work = notes::create_topic(&mut a.conn, &mut a.clock, "撞名标签").unwrap();
    notes::file_to_topic(&mut a.conn, &mut a.clock, &idea, Some(&t_work), None).unwrap();
    notes::set_topic_color(&mut a.conn, &mut a.clock, &t_work, Some("#3f7a99".into())).unwrap(); // 颜色随快照过通道 + 过审计
    notes::edit(&mut a.conn, &mut a.clock, &idea, "灵感甲(改)").unwrap(); // → 1 条历史
    let task_id = task::create(&mut a.conn, &mut a.clock, "任务乙", Some("2026-08-01"), Some(2), None).unwrap();
    images::attach(&mut a.conn, &mut a.clock, &task_id, &[9, 9, 9], "image/png").unwrap();
    let done_id = task::create(&mut a.conn, &mut a.clock, "已完事", None, None, None).unwrap();
    task::transition(&mut a.conn, &mut a.clock, &done_id, "done").unwrap();
    task::seal(&mut a.conn, &mut a.clock, &done_id).unwrap(); // 归档成就(sealed 行)
    let trash_id = notes::capture(&mut a.conn, &mut a.clock, "进回收站").unwrap();
    notes::archive(&mut a.conn, &mut a.clock, &trash_id).unwrap();

    // 新端:配对前本地数据 + 同名标签(全背书,fresh)。
    let mut b = peer("imp-b");
    let b_idea = notes::capture(&mut b.conn, &mut b.clock, "新端自己的灵感").unwrap();
    let b_topic = notes::create_topic(&mut b.conn, &mut b.clock, "撞名标签").unwrap();
    notes::file_to_topic(&mut b.conn, &mut b.clock, &b_idea, Some(&b_topic), None).unwrap();
    images::attach(&mut b.conn, &mut b.clock, &b_idea, &[1], "image/png").unwrap();

    let a_items: i64 = a.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
    let a_max_hlc: String =
        a.conn.query_row("SELECT MAX(hlc) FROM oplog", [], |r| r.get(0)).unwrap();

    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    check_fresh_to_account(&b.conn).expect("新端 fresh");
    let report = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap().expect_clean_commit();
    assert_eq!(report.items as i64, a_items);
    assert_eq!(report.revisions, 1);
    assert_eq!(report.images, 1);

    // 并集:新端原有 2 行(灵感 + 无;b_idea)+ 老端全量。
    let b_items: i64 = b.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
    assert_eq!(b_items, a_items + 1);
    // 同名标签并存为两个 topic(§6.2 步骤 5:不代合并)。
    let dup: i64 = b
        .conn
        .query_row("SELECT COUNT(*) FROM topics WHERE title = '撞名标签'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(dup, 2);
    // 老端标签的颜色随快照过来了(且 op-backed 语义审计对 color 放行——import 已 unwrap);
    // 新端自己那个同名标签仍是无色(两个 topic id 不同、互不影响)。
    let work_color: Option<String> =
        b.conn.query_row("SELECT color FROM topics WHERE id = ?1", [&t_work], |r| r.get(0)).unwrap();
    assert_eq!(work_color.as_deref(), Some("#3f7a99"));
    let b_color: Option<String> =
        b.conn.query_row("SELECT color FROM topics WHERE id = ?1", [&b_topic], |r| r.get(0)).unwrap();
    assert!(b_color.is_none());
    // 两种终态行都进来了:sealed / archived。
    let sealed_in: i64 = b
        .conn
        .query_row("SELECT COUNT(*) FROM items WHERE id = ?1 AND sealed_at IS NOT NULL", [&done_id], |r| r.get(0))
        .unwrap();
    assert_eq!(sealed_in, 1);
    let trashed_in: i64 = b
        .conn
        .query_row("SELECT COUNT(*) FROM items WHERE id = ?1 AND archived_at IS NOT NULL", [&trash_id], |r| r.get(0))
        .unwrap();
    assert_eq!(trashed_in, 1);
    // 图字节随快照直达(引导不走旁路)。
    let img_bytes: Vec<u8> = b
        .conn
        .query_row("SELECT data FROM item_image WHERE item_id = ?1", [&task_id], |r| r.get(0))
        .unwrap();
    assert_eq!(img_bytes, vec![9, 9, 9]);
    // 标记落盘 + 重复引导被拒。
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_some());
    assert!(check_fresh_to_account(&b.conn).is_err());
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("已完成过引导"), "{err}");
    // 时钟已 observe:下一枚本机 HLC 严格高于导入日志的一切(编辑因果成立)。
    let next = b.clock.tick(&b.conn).unwrap();
    assert!(next.encode() > a_max_hlc, "{} !> {a_max_hlc}", next.encode());
    // 快照文件用后由调用方删除(内含老端 sync_meta,别留盘)。
    std::fs::remove_file(&snap.path).unwrap();
}

/// 严格纪元「恰一条 create」(epoch-plan §3.2):快照携带无 op 背书的行(pre-0020
/// 遗产)不再是合法史实——正道是先在锚点跑纪元压实合成背书,再当快照源。零背书
/// 容忍若不删,「作弊伪装成 legacy」是信息论级不可区分的洞(§1)。
#[test]
fn import_rejects_snapshot_with_unbacked_row() {
    let mut a = peer("unbacked-a");
    notes::capture(&mut a.conn, &mut a.clock, "正常数据").unwrap();
    insert_legacy_row(&a.conn, "01JZLEGACY000000000000000A", true, true); // 0020 前遗产
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("unbacked-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("无 op 背书"), "{err}");
    // 整体回滚不留痕。
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none());
    let n: i64 = b.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

/// 注毒快照四连拒(codex P2-f 轮 H1/M2):快照绕过 engine 的入池硬校验,导入
/// 事务必须自己把同一口径补上——坏 op_id / 坏 hlc / 双序矛盾 / tombstone 复活,
/// 全部整体回滚不留痕。毒是往快照文件 INSERT(oplog 只拦 UPDATE/DELETE,INSERT
/// 畅通,正好模拟「坏实现同版本客户端」产出的合法-形态-坏-语义快照)。
#[test]
fn import_rejects_poisoned_snapshot_logs() {
    let mut a = peer("poison-a");
    let idea = notes::capture(&mut a.conn, &mut a.clock, "正常数据").unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    let (a_origin, a_max_seq): (String, i64) = a
        .conn
        .query_row("SELECT origin, MAX(origin_seq) FROM oplog GROUP BY origin", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();

    let mut b = peer("poison-b");
    let poison = |tag: &str, sql: String| -> PathBuf {
        let path = a.dir.join(format!("poisoned-{tag}.sqlite3"));
        std::fs::copy(&snap.path, &path).unwrap();
        let c = Connection::open(&path).unwrap();
        c.execute_batch(&sql).unwrap();
        path
    };

    // ① 坏 op_id(非 ULID)。
    let p1 = poison(
        "opid",
        format!(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('not-a-ulid', 'fffffffffffff-00000000-{a_origin}', 'topic', \
                     '01JZPOISONTOPIC000000000AA', 'create', '{{}}', {})",
            a_max_seq + 1
        ),
    );
    let err = import_snapshot(&mut b.conn, &mut b.clock, &p1).unwrap_err();
    assert!(err.contains("op_id"), "{err}");

    // ② 坏 hlc(解析不过;origin 生成列成空串,连续性也过不了——形态校验先响)。
    let p2 = poison(
        "hlc",
        format!(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('{}', 'garbage-hlc', 'topic', '01JZPOISONTOPIC000000000AB', \
                     'create', '{{}}', 1)",
            Ulid::new()
        ),
    );
    let err = import_snapshot(&mut b.conn, &mut b.clock, &p2).unwrap_err();
    assert!(err.contains("hlc") || err.contains("洞"), "{err}");

    // ③ 双序矛盾:seq 连续(MAX+1)但 hlc 倒挂(全零墙钟必小于既有一切)。
    let p3 = poison(
        "dualorder",
        format!(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('{}', '0000000000000-00000000-{a_origin}', 'topic', \
                     '01JZPOISONTOPIC000000000AC', 'create', '{{}}', {})",
            Ulid::new(),
            a_max_seq + 1
        ),
    );
    let err = import_snapshot(&mut b.conn, &mut b.clock, &p3).unwrap_err();
    assert!(err.contains("双序"), "{err}");

    // ④ tombstone 复活:日志声称该 item 已死,行却还在(墓碑不可逆,65 契约①)。
    let p4 = poison(
        "undead",
        format!(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('{}', 'fffffffffffff-00000000-{a_origin}', 'item', '{idea}', \
                     'tombstone', '{{}}', {})",
            Ulid::new(),
            a_max_seq + 1
        ),
    );
    let err = import_snapshot(&mut b.conn, &mut b.clock, &p4).unwrap_err();
    assert!(err.contains("tombstone"), "{err}");

    // 四连拒全部不留痕:B 仍是 fresh 空库,正常快照照样导得进。
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none());
    let n: i64 = b.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap();
}

/// 语义分叉快照三连拒(codex P2-h 二轮 H2):结构/FK/counter/双序全过,但**终态与
/// 自身日志矛盾**——content/link/图N 与 oplog 重算不符。这是「坏实现同版本客户端」或
/// 恶意已配对 peer 灌的静默分叉,结构校验放行、语义审计必须拦。毒是往快照表里 UPDATE/
/// INSERT/DELETE(不动 oplog),正好造出「日志说 A、表里 B」。
#[test]
fn import_rejects_semantically_divergent_snapshot() {
    let mut a = peer("semdiv-a");
    let idea = notes::capture(&mut a.conn, &mut a.clock, "日志里的真内容").unwrap();
    let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
    notes::file_to_topic(&mut a.conn, &mut a.clock, &idea, Some(&topic), None).unwrap();
    let task = task::create(&mut a.conn, &mut a.clock, "带图", None, None, None).unwrap();
    images::attach(&mut a.conn, &mut a.clock, &task, &[5, 5, 5], "image/png").unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();

    let mut b = peer("semdiv-b");
    let poison = |tag: &str, sql: String| -> PathBuf {
        let path = a.dir.join(format!("semdiv-{tag}.sqlite3"));
        std::fs::copy(&snap.path, &path).unwrap();
        let c = Connection::open(&path).unwrap();
        // 回放豁免下动表(绕过单机守护/归档触发器),纯造终态-日志分叉。
        c.execute_batch("INSERT INTO sync_replay_active (flag) VALUES (1);").unwrap();
        c.execute_batch(&sql).unwrap();
        c.execute_batch("DELETE FROM sync_replay_active;").unwrap();
        path
    };

    // ① content 分叉:表里内容 ≠ 日志 LWW winner。
    let p1 = poison("content", format!("UPDATE items SET content='被篡改' WHERE id='{idea}';"));
    let err = import_snapshot(&mut b.conn, &mut b.clock, &p1).unwrap_err();
    assert!(err.contains("语义审计") && err.contains("content"), "{err}");

    // ② OR-set 分叉:日志说该标签关联存活,表里却删了(或反之)。删掉一条 op-backed link。
    let p2 = poison("link", format!("DELETE FROM item_topic WHERE item_id='{idea}';"));
    let err = import_snapshot(&mut b.conn, &mut b.clock, &p2).unwrap_err();
    assert!(err.contains("语义审计") && err.contains("OR-set"), "{err}");

    // ③ 「图N」分叉:行 seq 与日志 reconcile 值不符。同步抬高 counter(否则先撞
    // 既有的 counter-behind 结构校验),把毒逼到语义审计的图N比对上。
    let p3 = poison(
        "imgseq",
        format!(
            "UPDATE item_image SET seq = 99 WHERE item_id='{task}'; \
             UPDATE item_image_counter SET last_seq = 99 WHERE item_id='{task}';"
        ),
    );
    let err = import_snapshot(&mut b.conn, &mut b.clock, &p3).unwrap_err();
    assert!(err.contains("语义审计") && err.contains("图"), "{err}");

    // ④ topic.updated_at 分叉:它是同步字段(apply_topic_set_field 白名单),表值 ≠ 日志 winner。
    let p4 = poison(
        "topicup",
        format!("UPDATE topics SET updated_at='2099-01-01T00:00:00Z' WHERE id='{topic}';"),
    );
    let err = import_snapshot(&mut b.conn, &mut b.clock, &p4).unwrap_err();
    assert!(err.contains("语义审计") && err.contains("updated_at"), "{err}");

    // 四连拒全部不留痕:B 仍 fresh,正常快照照导(语义审计对合法快照放行)。
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none());
    import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap();
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_some());
}

/// H2 复核 Finding 1:父实体 tombstone 后 link_add 仍在史里、但 item_topic 无行(FK
/// cascade)——这是**合法**快照。OR-set 审计必须与 replay::apply_link(父墓碑 = ParentGone
/// 不物化行)对齐、排除父墓碑 link,否则误拒合法引导。item 墓碑、topic 墓碑两条都测。
#[test]
fn import_accepts_link_with_tombstoned_parent() {
    let mut a = peer("linktomb-a");
    // ① topic 墓碑:idea 挂 topic,删 topic(topic tombstone + cascade 清 link 行)。
    let i1 = notes::capture(&mut a.conn, &mut a.clock, "挂了会被删标签的想法").unwrap();
    let t1 = notes::create_topic(&mut a.conn, &mut a.clock, "会被删的标签").unwrap();
    notes::file_to_topic(&mut a.conn, &mut a.clock, &i1, Some(&t1), None).unwrap();
    notes::delete_topic(&mut a.conn, &mut a.clock, &t1).unwrap();
    // ② item 墓碑:idea2 挂 topic2,软删进回收站 → 彻底删(item tombstone + cascade)。
    let i2 = notes::capture(&mut a.conn, &mut a.clock, "会被彻底删的想法").unwrap();
    let t2 = notes::create_topic(&mut a.conn, &mut a.clock, "留存标签").unwrap();
    notes::file_to_topic(&mut a.conn, &mut a.clock, &i2, Some(&t2), None).unwrap();
    notes::archive(&mut a.conn, &mut a.clock, &i2).unwrap();
    notes::purge(&mut a.conn, &mut a.clock, &i2).unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();

    // 两处父墓碑 link 都不该被审计误拒:合法快照必须导得进。
    let mut b = peer("linktomb-b");
    import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap();
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_some());
    // 存活标签 t2 还在(它没被删),i1 也在(只是没了标签)。
    let n: i64 = b.conn.query_row("SELECT COUNT(*) FROM topics WHERE id = ?1", [&t2], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}

/// 纪元源遗留形态回归(真机验收 2026-07-09 实弹抓到的误拒):70(0022)引入 observed
/// 之前的 link_remove 不带该 key——严格 OR-set 下它覆盖不了任何 add,审计会把早已删掉
/// 的关联算成「日志存活」、误拒合法快照(现场:表 15 条 vs 日志存活 17 条)。修后语义:
/// 遗留 remove 覆盖一切更低 HLC 的同关联 add;比它晚的 add(去了再打回)不受影响。
/// 严格纪元翻转(epoch-plan §3.1,原正例 `import_accepts_legacy_link_remove_without_observed`):
/// 64→70 窗口期不带 observed 的 link_remove 曾是「只随快照到达」的合法史实,压实把
/// 它消灭之后 boot 与 live 同拒——遗留宽语义(覆盖一切更低 HLC 的 add)分支已删,
/// 「作弊伪装成 legacy」的不可区分洞随分类问题一起消灭。
#[test]
fn import_rejects_legacy_link_remove_without_observed() {
    let mut a = peer("legacyrm-a");
    let task = task::create(&mut a.conn, &mut a.clock, "挂过标签的任务", None, None, None).unwrap();
    let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
    task::add_topic(&mut a.conn, &mut a.clock, &task, &topic).unwrap();
    // 手工重演遗留 remove_topic:删行 + 发不带 observed 的 link_remove
    // (payload 形态照真实库遗留 op:只有 item_id/topic_id 两键)。
    a.conn
        .execute("DELETE FROM item_topic WHERE item_id = ?1 AND topic_id = ?2", [&task, &topic])
        .unwrap();
    let hlc = a.clock.tick(&a.conn).unwrap();
    let seq: i64 = a
        .conn
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
            [hlc.device_id.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    a.conn
        .execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, 'link', ?3, 'link_remove', ?4, ?5)",
            rusqlite::params![
                ulid::Ulid::new().to_string(),
                hlc.encode(),
                format!("{task}:{topic}"),
                format!(r#"{{"item_id":"{task}","topic_id":"{topic}"}}"#),
                seq
            ],
        )
        .unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("legacyrm-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("observed 必带且为字符串数组"),
        "遗留无 observed 形态在严格纪元必拒(先压实再当源):{err}");
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none(), "整体回滚不留痕");
}

/// codex 复审修复项①:`{"observed":null}` 不是遗留形态——json_type 区分「缺 key」
/// (遗留)与显式 JSON null(伪造)。显式 null 走严格 OR-set(覆盖不了任何 add),
/// 行又被删了 = 终态与日志不符,恶意快照必须拒。
#[test]
fn import_rejects_json_null_observed_as_legacy() {
    let mut a = peer("nullobs-a");
    let task = task::create(&mut a.conn, &mut a.clock, "挂过标签的任务", None, None, None).unwrap();
    let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
    task::add_topic(&mut a.conn, &mut a.clock, &task, &topic).unwrap();
    a.conn
        .execute("DELETE FROM item_topic WHERE item_id = ?1 AND topic_id = ?2", [&task, &topic])
        .unwrap();
    let hlc = a.clock.tick(&a.conn).unwrap();
    let seq: i64 = a
        .conn
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
            [hlc.device_id.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    a.conn
        .execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, 'link', ?3, 'link_remove', ?4, ?5)",
            rusqlite::params![
                ulid::Ulid::new().to_string(),
                hlc.encode(),
                format!("{task}:{topic}"),
                format!(r#"{{"item_id":"{task}","topic_id":"{topic}","observed":null}}"#),
                seq
            ],
        )
        .unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("nullobs-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    // bedrock-fix §9:shape 审计(audit_op_shapes)先于 OR-set 语义审计拦下——显式 null
    // observed 不是合法形态,与 apply_link 同口径(非字符串 observed 整条拒),引导侧也拒。
    assert!(err.contains("observed 必带且为字符串数组"), "显式 null 不是合法 observed,shape 审计必须拒:{err}");
}

/// codex 复审第四弹:`{"observed":[null]}`——`NOT IN` 遇 NULL 元素按 SQL 三值逻辑
/// 把**所有** add 判死,恶意快照可借此删行过审。存活集已改 NOT EXISTS +
/// `je.value = a.op_id`(NULL 永不相等),[null] 覆盖不了任何 add → add 存活、行
/// 又被删了 = 不符,拒。
#[test]
fn import_rejects_observed_array_with_null() {
    let mut a = peer("nullelem-a");
    let task = task::create(&mut a.conn, &mut a.clock, "挂过标签的任务", None, None, None).unwrap();
    let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
    task::add_topic(&mut a.conn, &mut a.clock, &task, &topic).unwrap();
    a.conn
        .execute("DELETE FROM item_topic WHERE item_id = ?1 AND topic_id = ?2", [&task, &topic])
        .unwrap();
    let hlc = a.clock.tick(&a.conn).unwrap();
    let seq: i64 = a
        .conn
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
            [hlc.device_id.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    a.conn
        .execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, 'link', ?3, 'link_remove', ?4, ?5)",
            rusqlite::params![
                ulid::Ulid::new().to_string(),
                hlc.encode(),
                format!("{task}:{topic}"),
                format!(r#"{{"item_id":"{task}","topic_id":"{topic}","observed":[null]}}"#),
                seq
            ],
        )
        .unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("nullelem-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    // bedrock-fix §9:shape 审计先于 OR-set——[null] 不是合法 observed(与 apply_link
    // 同口径:非字符串元素整条拒),引导侧在语义重算之前就拦下。
    assert!(err.contains("observed 必带且为字符串数组"), "[null] 不是合法 observed,shape 审计必须拒:{err}");
}

// ---- bedrock-fix §9:引导审计对齐 replay 的对抗测试(坏快照必拒;legacy/合法仍收) ----

/// 手插一条原始 op(造单机正道插不出的作弊 op;origin_seq 顺号补齐)。
fn inject_raw_op(conn: &Connection, clock: &mut Clock, entity: &str, entity_id: &str, kind: &str, payload: &str) {
    let hlc = clock.tick(conn).unwrap();
    let seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
            [hlc.device_id.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute(
        "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![ulid::Ulid::new().to_string(), hlc.encode(), entity, entity_id, kind, payload, seq],
    )
    .unwrap();
}

/// 实现审 H1:「无 create、tombstone **晚于**依赖 op」的日志——live 逐条应用在
/// 低 seq 的 set_field 上撞「行缺失且无墓碑」永久挂起(高 seq 的 tombstone 被队尾
/// 堵死),boot 若靠「存在任意 tombstone」豁免就放它进来 = audit⟺replay 差分。
/// 顺带阳性对照:合法 purge 流(create<set<tombstone)在其它测试(certify/引导
/// 全形态)恒放行。
#[test]
fn import_rejects_dependent_op_with_only_later_tombstone() {
    let mut a = peer("latertomb-a");
    notes::capture(&mut a.conn, &mut a.clock, "让快照非空").unwrap();
    let x = ulid::Ulid::new().to_string();
    // 无 create:先 set_field、后 tombstone(终态无行、无背书)。
    inject_raw_op(&a.conn, &mut a.clock, "item", &x, "set_field",
        r#"{"field":"content","value":"幽灵"}"#);
    inject_raw_op(&a.conn, &mut a.clock, "item", &x, "tombstone", "{}");
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("latertomb-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("孤儿"), "tombstone 晚于依赖 op 不算豁免:{err}");
    assert!(meta_get(&b.conn, "bootstrapped_at").unwrap().is_none(), "整体回滚不留痕");
}

/// 实现审 H2:position 自严格纪元起入 LWW 语义审计——「日志 LWW 赢家说 A、表里
/// 是 B」的库必须被拒(修前 position 被显式豁免,静默终态分叉可穿透供货/创号/
/// 导入三闸)。
#[test]
fn import_rejects_position_lww_divergence() {
    let mut a = peer("posdiv-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    // 追加一条更高 HLC 的合法 frindex position set_field,但不改行——LWW 赢家 ≠ 表列。
    inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field",
        r#"{"field":"position","value":"zz"}"#);
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("posdiv-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("position") || err.contains("LWW") || err.contains("不符"),
        "position 语义分叉必须拒:{err}");
}

/// #2:link_add 的 entity_id 与 payload 指向不同配对 —— apply_link 拒、旧审计不管。
#[test]
fn import_rejects_link_entity_id_payload_mismatch() {
    let mut a = peer("linkmis-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    let topic = notes::create_topic(&mut a.conn, &mut a.clock, "标签").unwrap();
    inject_raw_op(
        &a.conn,
        &mut a.clock,
        "link",
        &format!("{task}:{topic}"),
        "link_add",
        &format!(r#"{{"item_id":"{task}","topic_id":"01JZZZZZZZZZZZZZZZZZZZZZZZ"}}"#),
    );
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("linkmis-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("entity_id 与 payload 不一致"), "link entity_id 错配必须拒:{err}");
}

/// #7:伪造 created_at 的 set_field —— 已知词汇但协议禁 set(史实字段),归型
/// InvalidOp 而非「未知字段」的 UnsupportedVocab(typed poison §4:版本偏斜挂起
/// 自愈,毒 op 隔离,两者绝不能混)。
#[test]
fn import_rejects_forbidden_created_at_set_field() {
    let mut a = peer("createdat-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    inject_raw_op(
        &a.conn,
        &mut a.clock,
        "item",
        &task,
        "set_field",
        r#"{"field":"created_at","value":"2000-01-01T00:00:00.000Z"}"#,
    );
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("createdat-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("协议禁 set_field"), "created_at set_field 必须拒:{err}");
}

/// codex Q5:未知字段 set_field —— 审计遍历固定字段看不见,replay 立即 Err。
#[test]
fn import_rejects_unknown_set_field() {
    let mut a = peer("unkfield-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"never_existed","value":1}"#);
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("unkfield-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("不认识的字段"), "未知字段 set_field 必须拒:{err}");
}

/// #6:image_add 元数据 mime 不在白名单 —— apply_image_add 拒、旧审计只比 seq。
#[test]
fn import_rejects_image_add_bad_mime() {
    let mut a = peer("badmime-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    let img = ulid::Ulid::new().to_string();
    inject_raw_op(
        &a.conn,
        &mut a.clock,
        "image",
        &img,
        "image_add",
        &format!(r#"{{"item_id":"{task}","seq":1,"mime":"image/svg+xml","bytes":3,"sha256":"{}"}}"#, "a".repeat(64)),
    );
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("badmime-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("mime 不在白名单"), "image_add 坏 mime 必须拒:{err}");
}

/// #3:同一 item 两条 create —— apply_item_create 撞行即 Err,旧审计取 HLC-max 分叉。
#[test]
fn import_rejects_duplicate_item_create() {
    let mut a = peer("dupcreate-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    inject_raw_op(
        &a.conn,
        &mut a.clock,
        "item",
        &task,
        "create",
        r#"{"content":"重复出生","stage":"todo","created_at":"2000-01-01T00:00:00.000Z","born_stage":"todo"}"#,
    );
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("dupcreate-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("重复 create"), "重复 create 必须拒:{err}");
}

/// codex 二审:image_add.sha256 与实际字节不符 —— bulk copy 从不验货。
#[test]
fn import_rejects_corrupted_image_bytes() {
    let mut a = peer("badbytes-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    images::attach(&mut a.conn, &mut a.clock, &task, &[1, 2, 3], "image/png").unwrap();
    // item_image 不可 UPDATE(只追加/删除),故删行后重插一条 data 不符其 image_add
    // sha256 的行(等价于「字节被篡改」的坏快照)。
    let (img, seq, mime, created): (String, i64, String, String) = a
        .conn
        .query_row("SELECT id, seq, mime, created_at FROM item_image", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    a.conn.execute("DELETE FROM item_image WHERE id = ?1", [&img]).unwrap();
    a.conn
        .execute(
            "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![img, task, seq, vec![9u8, 9, 9], mime, created],
        )
        .unwrap();
    a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("badbytes-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("sha256"), "篡改的图字节必须被 hash 验出:{err}");
}

/// codex 二审:快照携带 origin==导入端 device_id 的 op —— 替新端伪造「本机历史」。
#[test]
fn import_rejects_self_origin_injection() {
    let mut b = peer("selforigin-b");
    let mut a = peer("selforigin-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    // 伪造 hlc:取真 hlc 前缀(时间戳+计数器,前 23 字符)拼上导入端 b 的 device_id 后缀。
    let real = a.clock.tick(&a.conn).unwrap().encode();
    let forged_hlc = format!("{}{}", &real[..23], b.device_id);
    a.conn
        .execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, 'item', ?3, 'set_field', ?4, 1)",
            rusqlite::params![
                ulid::Ulid::new().to_string(),
                forged_hlc,
                task,
                r#"{"field":"content","value":"伪造"}"#
            ],
        )
        .unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("伪造本机历史"), "self-origin 注入必须拒:{err}");
}

/// B(codex 二审):item set_field 值越出列 CHECK 域(priority 99)——boot 只校终态,
/// live 按 seq 逐条应用会在列 CHECK 处 Err;这里先于 LWW 拦下。
#[test]
fn import_rejects_set_field_out_of_domain() {
    let mut a = peer("domain-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"priority","value":99}"#);
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("domain-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    // 值域现由共享 validate_op_shape 在 op-shape 层拦下(先于 LWW,winner/输家一视同仁)。
    assert!(err.contains("priority 期待"), "越域 set_field(shape 层值域)必须拒:{err}");
}

/// C(codex 二审):孤儿 set_field(指向无 create/行/tombstone 的实体)——live 会挂起。
#[test]
fn import_rejects_orphan_set_field() {
    let mut a = peer("orphan-sf-a");
    task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    let phantom = ulid::Ulid::new().to_string();
    inject_raw_op(&a.conn, &mut a.clock, "item", &phantom, "set_field", r#"{"field":"content","value":"孤儿"}"#);
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("orphan-sf-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("无行且无 tombstone"), "孤儿 set_field 必须拒:{err}");
}

/// D(codex 二审):孤儿 link(entity_id 与 payload 一致但父实体不存在)——apply_link 挂起。
#[test]
fn import_rejects_orphan_link() {
    let mut a = peer("orphan-link-a");
    task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    let pi = ulid::Ulid::new().to_string();
    let pt = ulid::Ulid::new().to_string();
    inject_raw_op(
        &a.conn,
        &mut a.clock,
        "link",
        &format!("{pi}:{pt}"),
        "link_add",
        &format!(r#"{{"item_id":"{pi}","topic_id":"{pt}"}}"#),
    );
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("orphan-link-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("无行且无 tombstone"), "孤儿 link 必须拒:{err}");
}

/// E(codex 二审):图字节长度与 image_add.bytes 声明不符(与 hash 独立的验货,先于 hash)。
#[test]
fn import_rejects_image_length_mismatch() {
    let mut a = peer("imglen-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    images::attach(&mut a.conn, &mut a.clock, &task, &[1, 2, 3], "image/png").unwrap();
    let (img, seq, mime, created): (String, i64, String, String) = a
        .conn
        .query_row("SELECT id, seq, mime, created_at FROM item_image", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    a.conn.execute("DELETE FROM item_image WHERE id = ?1", [&img]).unwrap();
    // 长度改成 2(op 声明 bytes=3):E 先于 hash 拦下。
    a.conn
        .execute(
            "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![img, task, seq, vec![1u8, 2], mime, created],
        )
        .unwrap();
    a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("imglen-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("字节长度与"), "图字节长度不符必须拒:{err}");
}

/// A 反例(codex 二审):position 浮点非 legacy int,boot 也拒(与 live opt_str_field 同口径)。
#[test]
fn import_rejects_position_float() {
    let mut a = peer("posfloat-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"position","value":1.5}"#);
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("posfloat-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("position 期待"), "position 浮点必须拒:{err}");
}

/// 严格纪元翻转(epoch-plan §3.1,原正例 `import_accepts_legacy_int_position`):
/// 0021 前的整数 position op 曾是 boot 容忍的合法史实,压实把它消灭之后 boot 与
/// live 同拒(position 必为 frindex 文本键,镜像 0022 单列 CHECK)。
#[test]
fn import_rejects_legacy_int_position() {
    let mut a = peer("posint-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"position","value":5}"#);
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("posint-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("position 期待合法 frindex 键"),
        "整数 position 在严格纪元必拒(先压实再当源):{err}");
}

/// codex 二审 2:同 origin set-before-create(低 seq set_field、高 seq create,终态有行)
/// ——boot 的「存在」审计过,但 live 先应用 set_field 撞「行缺失」挂起、create 被队尾堵死。
/// 因果序审计(create.hlc < dependent.hlc)拦下。
#[test]
fn import_rejects_set_before_create() {
    let mut a = peer("setbefore-a");
    let x = ulid::Ulid::new().to_string();
    // 先 set_field(低 hlc),再 create(高 hlc):create 因果晚于它的 set_field。
    inject_raw_op(&a.conn, &mut a.clock, "item", &x, "set_field", r#"{"field":"content","value":"先改后生"}"#);
    inject_raw_op(
        &a.conn,
        &mut a.clock,
        "item",
        &x,
        "create",
        r#"{"content":"X","stage":"todo","created_at":"2026-01-01T00:00:00.000Z","born_stage":"todo"}"#,
    );
    // 手插 X 的行(让「存在」审计通过,只留因果序拦截)。
    a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    a.conn
        .execute(
            "INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, \
                                due_on, priority, position, sealed_at, born_stage) \
             VALUES (?1, 'X', 'todo', 't0', 't0', NULL, NULL, NULL, 'a0', NULL, 'todo')",
            [&x],
        )
        .unwrap();
    a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("setbefore-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("set-before-create"), "set-before-create 必须拒:{err}");
}

/// codex 二审 3:两张图都声明近上限 seq——撞号顺延越过 MAX_IMAGE_SEQ,effective_seqs 报错;
/// boot 与 live 共用它故同拒(不封则 counter 被抬过上限、下次 attach 的 +1 失败成本地 DoS)。
#[test]
fn import_rejects_image_seq_overflow() {
    let mut a = peer("imgseq-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    let sha = "a".repeat(64);
    let max = images::MAX_IMAGE_SEQ;
    for _ in 0..2 {
        let img = ulid::Ulid::new().to_string();
        inject_raw_op(
            &a.conn,
            &mut a.clock,
            "image",
            &img,
            "image_add",
            &format!(r#"{{"item_id":"{task}","seq":{max},"mime":"image/png","bytes":3,"sha256":"{sha}"}}"#),
        );
    }
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("imgseq-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("超上限"), "撞号越上限必须拒:{err}");
}

/// epoch-plan §1 第 3 条:纪元压实丢弃死图的 add(字节已删,sha 无从重算),编号洞
/// 由原样保留的 counter 表承载——counter 合法**高于**日志派生高水位,审计判据由
/// `==` 放宽为 `>=`(不放宽会拒掉自己压实后的合法库);counter **低于**派生值仍必拒
/// (删图不回摆,低 = 伪造/损坏)。
#[test]
fn import_counter_above_log_watermark_is_legal_below_is_not() {
    let mut a = peer("cntr-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    images::attach(&mut a.conn, &mut a.clock, &task, &[1, 2], "image/png").unwrap();
    // 模拟压实后形态:曾有更高编号的图被彻底删除、其 add 不进新账本,counter 留洞。
    a.conn.execute_batch("INSERT INTO sync_replay_active (flag) VALUES (1);").unwrap();
    a.conn
        .execute("UPDATE item_image_counter SET last_seq = 5 WHERE item_id = ?1", [&task])
        .unwrap();
    a.conn.execute_batch("DELETE FROM sync_replay_active;").unwrap();
    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    let mut b = peer("cntr-b");
    import_snapshot(&mut b.conn, &mut b.clock, &snap.path)
        .expect("counter 高于日志派生高水位是压实后的合法形态");
    // 反向:再挂一图(得号 6)后删除——日志派生高水位 6,把 counter 压回 1 = 伪造,必拒。
    let (img2, _) = images::attach(&mut a.conn, &mut a.clock, &task, &[3, 4], "image/png").unwrap();
    images::remove(&mut a.conn, &mut a.clock, &img2).unwrap();
    a.conn.execute_batch("INSERT INTO sync_replay_active (flag) VALUES (1);").unwrap();
    a.conn
        .execute("UPDATE item_image_counter SET last_seq = 1 WHERE item_id = ?1", [&task])
        .unwrap();
    a.conn.execute_batch("DELETE FROM sync_replay_active;").unwrap();
    let snap2 = raw_snapshot(&a.conn, &a.dir);
    let mut b2 = peer("cntr-b2");
    let err = import_snapshot(&mut b2.conn, &mut b2.clock, &snap2.path).unwrap_err();
    assert!(err.contains("日志高水位"), "counter 低于派生高水位必拒:{err}");
}

/// 严格纪元翻转(epoch-plan §3.1,原正例 `import_accepts_legacy_image_without_sha256`):
/// 0024 前无 sha256 的 image_add 曾是 boot 容忍的合法史实——压实对现存字节现算 sha
/// 合成带 hash 的基线 add,存量无 sha 形态消灭,boot 与 live 同拒(收下没法验货的图
/// 本就是承认的洞)。单机正道产不出无 sha 的 op,故手工造。
#[test]
fn import_rejects_legacy_image_without_sha256() {
    let mut a = peer("nosha-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    let img = ulid::Ulid::new().to_string();
    inject_raw_op(
        &a.conn,
        &mut a.clock,
        "image",
        &img,
        "image_add",
        &format!(r#"{{"item_id":"{task}","seq":1,"mime":"image/png","bytes":3}}"#),
    );
    a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    a.conn
        .execute(
            "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) VALUES (?1,?2,1,?3,'image/png','t0')",
            rusqlite::params![img, task, vec![1u8, 2, 3]],
        )
        .unwrap();
    a.conn
        .execute(
            "INSERT INTO item_image_counter (item_id, last_seq) VALUES (?1, 1) \
             ON CONFLICT(item_id) DO UPDATE SET last_seq = max(last_seq, 1)",
            [&task],
        )
        .unwrap();
    a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("nosha-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("sha256 必带"),
        "无 sha 的 image_add 在严格纪元必拒(先压实再当源):{err}");
}

/// codex 二审:create(position="!")后被合法 position 覆盖、终态合法——共享 shape 层必须拒
/// (position 单列 CHECK 非豁免,live 在 create INSERT 当场撞;boot 不镜像即分歧)。
#[test]
fn import_rejects_bad_create_position() {
    let mut a = peer("badpos-a");
    let x = ulid::Ulid::new().to_string();
    inject_raw_op(
        &a.conn,
        &mut a.clock,
        "item",
        &x,
        "create",
        r#"{"content":"X","stage":"todo","created_at":"2026-01-01T00:00:00.000Z","born_stage":"todo","position":"!"}"#,
    );
    inject_raw_op(&a.conn, &mut a.clock, "item", &x, "set_field", r#"{"field":"position","value":"a1"}"#);
    a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    a.conn
        .execute(
            "INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, \
                                due_on, priority, position, sealed_at, born_stage) \
             VALUES (?1, 'X', 'todo', 't0', 't0', NULL, NULL, NULL, 'a1', NULL, 'todo')",
            [&x],
        )
        .unwrap();
    a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("badpos-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("frindex 键形态"), "非法 create position 必须拒:{err}");
}

/// codex 二审:同 origin set→create→tombstone,终态只剩墓碑——tombstone 不再豁免因果序
/// (live 仍卡在低 seq 的 set 上,create/tombstone 被队尾堵死)。
#[test]
fn import_rejects_set_before_create_even_if_tombstoned() {
    let mut a = peer("sbct-a");
    let x = ulid::Ulid::new().to_string();
    inject_raw_op(&a.conn, &mut a.clock, "item", &x, "set_field", r#"{"field":"content","value":"先改"}"#);
    inject_raw_op(
        &a.conn,
        &mut a.clock,
        "item",
        &x,
        "create",
        r#"{"content":"X","stage":"todo","created_at":"2026-01-01T00:00:00.000Z","born_stage":"todo"}"#,
    );
    inject_raw_op(&a.conn, &mut a.clock, "item", &x, "tombstone", "{}");
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("sbct-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("set-before-create"), "set→create→tombstone 必须拒:{err}");
}

/// codex 二审 3:非法 priority 输家(priority=99 后被更高 HLC 的合法 priority=2 覆盖、终态
/// 匹配合法赢家)——证明共享 shape 层拒输家,不靠 LWW/终态。
#[test]
fn import_rejects_domain_loser() {
    let mut a = peer("loser-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"priority","value":99}"#);
    inject_raw_op(&a.conn, &mut a.clock, "item", &task, "set_field", r#"{"field":"priority","value":2}"#);
    a.conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    a.conn.execute("UPDATE items SET priority = 2 WHERE id = ?1", [&task]).unwrap();
    a.conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut b = peer("loser-b");
    let err = import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap_err();
    assert!(err.contains("priority 期待"), "非法 domain 输家(shape 层)必须拒:{err}");
}

/// codex 二审 4:本地 counter 已达 MAX 时 attach——原子拒(Err),counter 不动、无行、无 op。
#[test]
fn attach_rejects_at_max_seq() {
    let mut a = peer("attachmax-a");
    let task = task::create(&mut a.conn, &mut a.clock, "任务", None, None, None).unwrap();
    let max = images::MAX_IMAGE_SEQ;
    a.conn
        .execute("INSERT INTO item_image_counter (item_id, last_seq) VALUES (?1, ?2)", rusqlite::params![task, max])
        .unwrap();
    let before: i64 = a.conn.query_row("SELECT COUNT(*) FROM oplog WHERE entity='image'", [], |r| r.get(0)).unwrap();
    let err = images::attach(&mut a.conn, &mut a.clock, &task, &[1, 2, 3], "image/png").unwrap_err();
    assert!(err.contains("上限"), "counter 达上限 attach 必须拒:{err}");
    let counter: i64 =
        a.conn.query_row("SELECT last_seq FROM item_image_counter WHERE item_id=?1", [&task], |r| r.get(0)).unwrap();
    assert_eq!(counter, max, "越界 attach 不应改动 counter");
    let rows: i64 =
        a.conn.query_row("SELECT COUNT(*) FROM item_image WHERE item_id=?1", [&task], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "越界 attach 不应留行");
    let after: i64 = a.conn.query_row("SELECT COUNT(*) FROM oplog WHERE entity='image'", [], |r| r.get(0)).unwrap();
    assert_eq!(after, before, "越界 attach 不应发 op");
}

// ---- 压轴:配对 + 引导 + 引导后互通(双实例、两真 SQLite、内存桥) ----

struct SyncPeer {
    p: Peer,
    engine: Engine,
    outbox: VecDeque<Msg>,
}

impl SyncPeer {
    fn collect(&mut self, outs: Vec<Output>) {
        for o in outs {
            match o {
                Output::Send { msg, .. } => self.outbox.push_back(msg),
                // 图字节供流(lan-direct-plan §10 C′):块由传输层逐块取,这只夹具
                // 走的是引导后的水位互补,不该有图在传。
                Output::ServeBlob(s) => panic!("互通阶段不该供图:{s:?}"),
                // 「来取活」的铃:这只夹具没有消费腿,活由 `drain_ops_for_test` 抽走,
                // 故这里丢掉即可(**不能 panic**:它是新形下的正常输出)。
                Output::ServeOps(_) => {}
                Output::Event(e) => panic!("互通阶段不该出事件:{e:?}"),
            }
        }
    }
}

/// 两实例互喂到静默(两端 outbox 皆空)。to 恒是对方(双设备账户,广播即定向)。
fn pump(x: &mut SyncPeer, y: &mut SyncPeer) {
    let mut guard = 0;
    loop {
        guard += 1;
        assert!(guard < 10_000, "pump 不收敛(死循环?)");
        if let Some(msg) = x.outbox.pop_front() {
            let outs = y
                .engine
                .on_msg_v(&mut y.p.conn, &mut y.p.clock, &x.p.device_id, Route::Relay, msg)
                .unwrap();
            y.collect(outs);
            // 第5笔起 Hello/Want 只**登记**对账义务,帧要由消费腿逐帧取:这只夹具
            // 没有传输层,故每喂一枚就自己抽一次(见 drain_ops_for_test)。
            let served = y.engine.drain_ops_for_test(&y.p.conn).unwrap();
            y.collect(served);
            continue;
        }
        if let Some(msg) = y.outbox.pop_front() {
            let outs = x
                .engine
                .on_msg_v(&mut x.p.conn, &mut x.p.clock, &y.p.device_id, Route::Relay, msg)
                .unwrap();
            x.collect(outs);
            let served = x.engine.drain_ops_for_test(&x.p.conn).unwrap();
            x.collect(served);
            continue;
        }
        return;
    }
}

/// convergence.rs 同款指纹(items 刨 updated_at 本地簿记)。
const FINGERPRINTS: &[(&str, &str)] = &[
    (
        "items",
        "SELECT id||'|'||content||'|'||stage||'|'||created_at \
         ||'|'||COALESCE(archived_at,'∅')||'|'||COALESCE(due_on,'∅')||'|'||COALESCE(priority,'∅') \
         ||'|'||COALESCE(position,'∅')||'|'||COALESCE(sealed_at,'∅')||'|'||COALESCE(born_stage,'∅') \
         ||'|'||COALESCE(done_at,'∅')||'|'||COALESCE(born_device,'∅') \
         FROM items ORDER BY id",
    ),
    (
        "topics",
        "SELECT id||'|'||title||'|'||created_at||'|'||updated_at \
         ||'|'||COALESCE(color,'∅')||'|'||COALESCE(position,'∅')||'|'||quote(kind) \
         FROM topics ORDER BY id",
    ),
    ("item_topic", "SELECT item_id||'|'||topic_id FROM item_topic ORDER BY item_id, topic_id"),
    (
        "item_image",
        "SELECT id||'|'||item_id||'|'||seq||'|'||mime||'|'||hex(data) FROM item_image ORDER BY id",
    ),
    ("item_image_counter", "SELECT item_id||'|'||last_seq FROM item_image_counter ORDER BY item_id"),
    ("oplog", "SELECT op_id||'|'||hlc||'|'||origin_seq FROM oplog ORDER BY op_id"),
];

fn fingerprint(conn: &Connection, sql: &str) -> Vec<String> {
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
    rows.collect::<rusqlite::Result<_>>().unwrap()
}

#[test]
fn paired_then_bootstrapped_instances_converge_end_to_end() {
    // ---- 老端 A:既有账户,数据全形态。 ----
    let mut ap = peer("e2e-a");
    let idea = notes::capture(&mut ap.conn, &mut ap.clock, "老端灵感").unwrap();
    let topic = notes::create_topic(&mut ap.conn, &mut ap.clock, "共同话题").unwrap();
    notes::file_to_topic(&mut ap.conn, &mut ap.clock, &idea, Some(&topic), None).unwrap();
    let a_task = task::create(&mut ap.conn, &mut ap.clock, "老端任务", None, Some(1), None).unwrap();
    images::attach(&mut ap.conn, &mut ap.clock, &a_task, &[7, 7], "image/png").unwrap();

    // ---- 新端 B:配对前已有本地数据(引导是并集,不丢)。 ----
    let mut bp = peer("e2e-b");
    let b_idea = notes::capture(&mut bp.conn, &mut bp.clock, "新端本地灵感").unwrap();
    let b_topic = notes::create_topic(&mut bp.conn, &mut bp.clock, "共同话题").unwrap();
    notes::file_to_topic(&mut bp.conn, &mut bp.clock, &b_idea, Some(&b_topic), None).unwrap();

    // ---- §6.1 配对:SPAKE2 对跑(测试即服务器盲桥,逐字节透传)。 ----
    let mut k_acc = [0u8; 32];
    use chacha20poly1305::aead::rand_core::RngCore;
    chacha20poly1305::aead::OsRng.fill_bytes(&mut k_acc);
    let account_id = Ulid::new().to_string();
    let secret = gen_secret();
    let slot = 424_242_424u64;
    let grant_in = AccountGrant {
        account_id: account_id.clone(),
        k_acc: k_acc.to_vec(),
        server_url: "wss://sync.zhujian.app/ws".into(),
    };
    let (_seed, pubkey) = gen_device_key();
    let enroll_in = DeviceEnroll { device_id: bp.device_id.clone(), pubkey: pubkey.to_vec() };
    let mut opener = Opener::new(slot, &secret, grant_in);
    let mut joiner = Joiner::new(slot, &secret, enroll_in);

    let mut to_joiner: VecDeque<Vec<u8>> = VecDeque::new();
    let mut to_opener: VecDeque<Vec<u8>> = VecDeque::new();
    for out in opener.on_joined().unwrap() {
        match out {
            PairOutput::Send(b) => to_joiner.push_back(b),
            other => panic!("{other:?}"),
        }
    }
    let mut registered: Option<(String, [u8; 32])> = None;
    let mut granted: Option<AccountGrant> = None;
    while granted.is_none() {
        if let Some(blob) = to_joiner.pop_front() {
            for out in joiner.on_msg(&blob).unwrap() {
                match out {
                    PairOutput::Send(b) => to_opener.push_back(b),
                    // §4 账户闸停点(Grant→gate→Enroll):本测试即刻放行。
                    PairOutput::GrantPending { .. } => {
                        for a in joiner.approve().unwrap() {
                            match a {
                                PairOutput::Send(b) => to_opener.push_back(b),
                                other => panic!("{other:?}"),
                            }
                        }
                    }
                    PairOutput::Granted(g) => granted = Some(g),
                    other => panic!("{other:?}"),
                }
            }
            continue;
        }
        let blob = to_opener.pop_front().expect("配对停摆");
        for out in opener.on_msg(&blob).unwrap() {
            match out {
                PairOutput::Send(b) => to_joiner.push_back(b),
                PairOutput::Register { device_id, pubkey } => {
                    // 老端拿到设备材料 → 发 register_device;服务器回 Registered。
                    registered = Some((device_id, pubkey));
                    for out in opener.on_registered().unwrap() {
                        match out {
                            PairOutput::Send(b) => to_joiner.push_back(b),
                            PairOutput::Finished => {}
                            other => panic!("{other:?}"),
                        }
                    }
                }
                other => panic!("{other:?}"),
            }
        }
    }
    let (reg_dev, reg_pub) = registered.expect("opener 必须走到 Register");
    assert_eq!(reg_dev, bp.device_id);
    assert_eq!(reg_pub.to_vec(), pubkey.to_vec());
    let grant = granted.unwrap();
    assert_eq!(grant.account_id, account_id);
    assert_eq!(grant.k_acc, k_acc.to_vec());
    // 配对交付的钥就是账户钥:B 用它封的帧,A 用原钥解得开(P2-g 全链的钥源)。
    let addr = FrameAddr {
        account_id: &account_id,
        from_device: &bp.device_id,
        to: BROADCAST,
        domain: Domain::Op,
    };
    let sealed = crypto::seal_msg(
        &grant.k_acc.as_slice().try_into().unwrap(),
        &addr,
        &Msg::Want { origin: "o".into(), from_seq: 1 },
    );
    assert!(crypto::open_msg::<Msg>(&k_acc, &addr, &sealed).is_ok());

    // ---- §6.2 引导:快照流 + 导入。 ----
    check_fresh_to_account(&bp.conn).expect("新端 fresh");
    let snap = make_snapshot(&ap.conn, &ap.dir).unwrap();
    let mut sender = BootSender::new(&snap).unwrap();
    let Some(BootMsg::Offer { transfer, bytes, sha256 }) = sender.next_msg().unwrap() else {
        panic!("首帧必须是 Offer");
    };
    let mut recv = BootReceiver::start(&bp.dir, &ap.device_id, &transfer, bytes, &sha256).unwrap();
    let mut done = ChunkOutcome::More;
    while let Some(BootMsg::Chunk { transfer, idx, last, data }) = sender.next_msg().unwrap() {
        done = recv.on_chunk(&ap.device_id, &transfer, idx, last, &data).unwrap();
    }
    assert_eq!(done, ChunkOutcome::Complete);
    import_snapshot(&mut bp.conn, &mut bp.clock, recv.path()).unwrap();
    std::fs::remove_file(recv.path()).unwrap();
    std::fs::remove_file(&snap.path).unwrap();

    // ---- 引导后互通:重建引擎(boot.rs 模块注释的接线契约)+ hello 互补。 ----
    let a_engine = Engine::new_solo(&ap.conn, BlobPolicy::Full).unwrap();
    let b_engine = Engine::new_solo(&bp.conn, BlobPolicy::Full).unwrap();
    let mut a = SyncPeer { p: ap, engine: a_engine, outbox: VecDeque::new() };
    let mut b = SyncPeer { p: bp, engine: b_engine, outbox: VecDeque::new() };
    // 装配即活 → 中转会话建立 → 服务器在线快照(lan-direct-plan §6 三段;两台
    // 都在线,故互相置对端的 relay 腿 Up——blob 选路只认这张表)。
    let b_id = b.p.device_id.clone();
    let a_id = a.p.device_id.clone();
    a.engine.on_runtime_started(&a.p.conn).unwrap();
    b.engine.on_runtime_started(&b.p.conn).unwrap();
    let outs = a.engine.relay_up(&a.p.conn).unwrap();
    a.collect(outs);
    let outs = b.engine.relay_up(&b.p.conn).unwrap();
    b.collect(outs);
    a.engine.on_relay_peer_up(&b_id);
    b.engine.on_relay_peer_up(&a_id);
    pump(&mut a, &mut b);

    // 引导后 B 再写一笔,实时广播也通(outbound 走 last_pushed 游标)。
    let late = notes::capture(&mut b.p.conn, &mut b.p.clock, "引导后的新灵感").unwrap();
    notes::file_to_topic(&mut b.p.conn, &mut b.p.clock, &late, Some(&b_topic), None).unwrap();
    b.engine.outbound(&b.p.conn, &mut vec![]).unwrap();
    let outs = b.engine.drain_ops_for_test(&b.p.conn).unwrap();
    b.collect(outs);
    pump(&mut a, &mut b);

    // ---- 终局:五表 + oplog 指纹逐行相等、水位相等、同名标签两枚、体检通过。 ----
    for (name, sql) in FINGERPRINTS {
        assert_eq!(
            fingerprint(&a.p.conn, sql),
            fingerprint(&b.p.conn, sql),
            "表 {name} 两端不一致"
        );
    }
    let wm = |c: &Connection| -> Vec<(String, i64)> {
        let mut stmt = c
            .prepare("SELECT origin, MAX(origin_seq) FROM oplog GROUP BY origin ORDER BY origin")
            .unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    };
    assert_eq!(wm(&a.p.conn), wm(&b.p.conn), "per-origin 水位必须相等");
    assert_eq!(wm(&a.p.conn).len(), 2, "两台设备两个 origin");
    let dup: i64 = b
        .p
        .conn
        .query_row("SELECT COUNT(*) FROM topics WHERE title = '共同话题'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(dup, 2, "同名标签并存,由用户手动合并收敛");
    for c in [&a.p.conn, &b.p.conn] {
        let verdict: String = c.pragma_query_value(None, "integrity_check", |r| r.get(0)).unwrap();
        assert_eq!(verdict, "ok");
    }
}

/// 引导往返带留言(identity-plan §4.8 锚 5 / 设计审真机清单「fresh boot」的自动化那半):
/// 老端库里同时有**活留言**、**已删留言**(有 tombstone)、**已删父的留言历史**(有 create
/// 无行、无 comment tombstone —— 那个健康终态),新端引导后**只出现活的那条**,两侧电池都过。
#[test]
fn boot_carries_live_comments_and_drops_the_dead_ones() {
    let mut a = peer("cmt-a");
    let host = notes::capture(&mut a.conn, &mut a.clock, "宿主").unwrap();
    let live = crate::comments::add(&mut a.conn, &mut a.clock, &host, "活着的留言").unwrap();
    let dead = crate::comments::add(&mut a.conn, &mut a.clock, &host, "会被删的留言").unwrap();
    crate::comments::remove(&mut a.conn, &mut a.clock, &dead).unwrap();
    // 另一条:留言在,但宿主被彻底删除 → 行随 CASCADE 走、create op 留下、无 comment tombstone。
    let doomed = notes::capture(&mut a.conn, &mut a.clock, "将被删的宿主").unwrap();
    crate::comments::add(&mut a.conn, &mut a.clock, &doomed, "陪葬留言").unwrap();
    notes::archive(&mut a.conn, &mut a.clock, &doomed).unwrap();
    notes::purge(&mut a.conn, &mut a.clock, &doomed).unwrap();

    strict_battery(&a.conn).expect("源库电池必须过(三种留言形态并存)");

    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    let mut b = peer("cmt-b");
    check_fresh_to_account(&b.conn).expect("新端 fresh");
    import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap().expect_clean_commit();

    let rows: Vec<String> = {
        let mut stmt = b.conn.prepare("SELECT id FROM item_comment ORDER BY id").unwrap();
        let it = stmt.query_map([], |r| r.get(0)).unwrap();
        it.collect::<rusqlite::Result<_>>().unwrap()
    };
    assert_eq!(rows, vec![live.clone()], "只有活留言过来;删掉的与陪葬的都不复活");
    // 两侧指纹相等(留言四列逐字)。
    let fp = |c: &Connection| -> Vec<(String, String, Option<String>)> {
        let mut stmt = c
            .prepare("SELECT id, content, born_device FROM item_comment ORDER BY id")
            .unwrap();
        let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        it.collect::<rusqlite::Result<_>>().unwrap()
    };
    assert_eq!(fp(&a.conn), fp(&b.conn), "两侧留言逐字相等");
    strict_battery(&b.conn).expect("引导后电池必须过");
}

/// **阳性**那一侧:作者未知(`born_device = NULL`,跨空间搬迁而来)的留言必须**过**
/// 双侧审计并原样引导过去。
///
/// 这一格才是区分 `json_extract(...) IS c.born_device` 与 `=` 的地方(二轮 L1):
/// 换成 `=`,payload 的 JSON null 与列上的 NULL 比出 NULL、WHERE 不成立 → 每条搬迁来的
/// 留言都被判「与自身 create op 不符」→ **凡是搬过空间的留言,那个库从此供不出快照**。
#[test]
fn boot_carries_a_moved_comment_with_no_author() {
    let mut a = peer("cmt-moved");
    let host = notes::capture(&mut a.conn, &mut a.clock, "宿主").unwrap();
    let moved = "01CMTMVED00000000000000000";
    force_comment_row(&a.conn, moved, &host, "搬来的", "2026-08-07T12:00:00.000Z");
    crate::oplog::comment_create(&a.conn, &mut a.clock, moved).unwrap();
    strict_battery(&a.conn).expect("作者未知的留言必须判健康");

    let snap = make_snapshot(&a.conn, &a.dir).unwrap();
    let mut b = peer("cmt-moved-dst");
    import_snapshot(&mut b.conn, &mut b.clock, &snap.path).unwrap().expect_clean_commit();
    let born: Option<String> = b
        .conn
        .query_row("SELECT born_device FROM item_comment WHERE id = ?1", [moved], |r| r.get(0))
        .unwrap();
    assert_eq!(born, None, "作者未知引导过去仍是未知,不许被填成任何一台");
    strict_battery(&b.conn).expect("新端电池必须过");
}

/// 在**可信语境**下往一枚库(通常是裸快照)里直插一行留言 —— 触发器要求 `born_device`
/// 等于本机 device_id,而这里造的就是「别人的行」,故走豁免。
fn force_comment_row(conn: &Connection, id: &str, item_id: &str, content: &str, created_at: &str) {
    force_comment_row_signed(conn, id, item_id, content, created_at, None)
}

/// 同上,但显式给署名(⑤ 那格要造出「四列都对、只是不该还在」的行)。
fn force_comment_row_signed(
    conn: &Connection,
    id: &str,
    item_id: &str,
    content: &str,
    created_at: &str,
    born_device: Option<&str>,
) {
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    conn.execute(
        "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        (id, item_id, content, created_at, born_device),
    )
    .unwrap();
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();
}

/// 留言的**坏快照矩阵**(codex 实现审二弹 M1)。
///
/// 0035 新增的六支审计判据全是**新表名、新 payload 路径、新拼出来的 SQL** —— 既有
/// image/device 那几只测证不了这里没抄错列名 / 前缀 / 析取项。每支各造一枚坏快照,
/// 且**六支的报错话术互不相同**,所以「哪一支承重」这件事由报错自证,不靠推理。
///
/// ⚠ 前五支走**真正的 attached `boot.` 路径**(`raw_snapshot` 绕开供货侧电池),
/// 第六支走本机侧 —— 否则 `prefix = ""` 那一半永远没被执行过。
#[test]
fn import_rejects_every_shape_of_broken_comment_snapshot() {
    let ts = "2026-08-07T12:00:00.000Z";

    // ① 快照侧「行在无 create 背书」。
    let mut a = peer("cb-unbacked");
    let host = notes::capture(&mut a.conn, &mut a.clock, "宿主").unwrap();
    let snap = raw_snapshot(&a.conn, &a.dir);
    force_comment_row(&Connection::open(&snap.path).unwrap(), "01CBA00000000000000000000A", &host, "伪造", ts);
    let mut z = peer("cb-unbacked-dst");
    let err = import_snapshot(&mut z.conn, &mut z.clock, &snap.path).unwrap_err();
    assert!(err.contains("快照") && err.contains("行在无 op"), "①{err}");
    assert!(meta_get(&z.conn, "bootstrapped_at").unwrap().is_none(), "半途无痕");

    // ② 快照侧「create 有、行缺、自身无 tombstone、父还活着」。
    let mut b = peer("cb-missing");
    let hb = notes::capture(&mut b.conn, &mut b.clock, "宿主").unwrap();
    let cb = crate::comments::add(&mut b.conn, &mut b.clock, &hb, "会被抹掉的行").unwrap();
    let snap = raw_snapshot(&b.conn, &b.dir);
    Connection::open(&snap.path)
        .unwrap()
        .execute("DELETE FROM item_comment WHERE id = ?1", [&cb])
        .unwrap();
    let mut z = peer("cb-missing-dst");
    let err = import_snapshot(&mut z.conn, &mut z.clock, &snap.path).unwrap_err();
    assert!(err.contains("快照") && err.contains("无行"), "②{err}");

    // ③ 快照侧「四列不符」——正文被改。留言行不可 UPDATE(触发器无豁免),故删了重插。
    let mut c = peer("cb-content");
    let hc = notes::capture(&mut c.conn, &mut c.clock, "宿主").unwrap();
    let cc = crate::comments::add(&mut c.conn, &mut c.clock, &hc, "原文").unwrap();
    let created: String = c
        .conn
        .query_row("SELECT created_at FROM item_comment WHERE id = ?1", [&cc], |r| r.get(0))
        .unwrap();
    let snap = raw_snapshot(&c.conn, &c.dir);
    {
        let sc = Connection::open(&snap.path).unwrap();
        sc.execute("DELETE FROM item_comment WHERE id = ?1", [&cc]).unwrap();
        force_comment_row(&sc, &cc, &hc, "改过了", &created);
    }
    let mut z = peer("cb-content-dst");
    let err = import_snapshot(&mut z.conn, &mut z.clock, &snap.path).unwrap_err();
    assert!(err.contains("快照") && err.contains("与自身 create op 不符"), "③{err}");

    // ④ 同一支的**署名**那一格:payload 里是某台设备,行上却是 NULL(作者未知)。
    //
    // ⚠ **它证的是「`born_device` 这一列真参与了比对」,不是「`IS` 的 NULL 安全性」**
    // (codex 实现审二弹二轮 L1 更正了我上一轮的归因):这一格换成 `=` 的话结果是 NULL、
    // 在 WHERE 里同样不成立,照样报「不符」—— 两种写法在这一格**不可区分**。
    // 真正区分 `IS` 与 `=` 的是**阳性**那一侧(payload NULL ∧ 行 NULL 必须判健康):
    // 见下面 `boot_carries_a_moved_comment_with_no_author` 与 epoch 的压实往返。
    let mut d = peer("cb-author");
    let hd = notes::capture(&mut d.conn, &mut d.clock, "宿主").unwrap();
    let cd = crate::comments::add(&mut d.conn, &mut d.clock, &hd, "本机写的").unwrap();
    let created: String = d
        .conn
        .query_row("SELECT created_at FROM item_comment WHERE id = ?1", [&cd], |r| r.get(0))
        .unwrap();
    let snap = raw_snapshot(&d.conn, &d.dir);
    {
        let sc = Connection::open(&snap.path).unwrap();
        sc.execute("DELETE FROM item_comment WHERE id = ?1", [&cd]).unwrap();
        force_comment_row(&sc, &cd, &hd, "本机写的", &created); // born_device 落 NULL
    }
    let mut z = peer("cb-author-dst");
    let err = import_snapshot(&mut z.conn, &mut z.clock, &snap.path).unwrap_err();
    assert!(err.contains("与自身 create op 不符"), "④{err}");

    // ⑤ 快照侧「墓碑之后行又冒出来」。
    let mut e = peer("cb-undead");
    let he = notes::capture(&mut e.conn, &mut e.clock, "宿主").unwrap();
    let ce = crate::comments::add(&mut e.conn, &mut e.clock, &he, "删掉的").unwrap();
    let (created, signed): (String, String) = e
        .conn
        .query_row("SELECT created_at, born_device FROM item_comment WHERE id = ?1", [&ce], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    crate::comments::remove(&mut e.conn, &mut e.clock, &ce).unwrap();
    let snap = raw_snapshot(&e.conn, &e.dir);
    // 四列必须与 create payload 逐字相符 —— 否则先撞上面 ③ 那支,验的就不是「复活」了。
    force_comment_row_signed(
        &Connection::open(&snap.path).unwrap(),
        &ce,
        &he,
        "删掉的",
        &created,
        Some(&signed),
    );
    let mut z = peer("cb-undead-dst");
    let err = import_snapshot(&mut z.conn, &mut z.clock, &snap.path).unwrap_err();
    assert!(err.contains("墓碑不可逆"), "⑤{err}");

    // 供货侧的一枚干净快照,下面两格共用。
    let mut g = peer("cb-local-src");
    notes::capture(&mut g.conn, &mut g.clock, "数据").unwrap();
    let clean = make_snapshot(&g.conn, &g.dir).unwrap();

    // ⑥ 本机侧「行在无 create 背书」→ 撞的是 **fresh 闸的五元组**(不是语义审计):
    // 这一格顺带证明 `count_unbacked_rows` 真把 item_comment 算进去了 —— 少了那一项,
    // 这台带着幽灵留言的设备会**悄悄加入账户**,而那行全网只此一份还自以为同步了。
    let mut f = peer("cb-local");
    let hf = notes::capture(&mut f.conn, &mut f.clock, "本机宿主").unwrap();
    force_comment_row(&f.conn, "01CBF00000000000000000000F", &hf, "幽灵", ts);
    let err = import_snapshot(&mut f.conn, &mut f.clock, &clean.path).unwrap_err();
    assert!(err.contains("早于同步纪元的历史数据"), "⑥{err}");

    // ⑦ 本机侧的**语义审计**(`prefix = ""` 那一半):行有 op 背书(过得了 fresh 闸)、
    // 但四列被改。少了本机这一侧,一台自己损坏的设备会把损坏带进新账户。
    let mut h = peer("cb-local-sem");
    let hh = notes::capture(&mut h.conn, &mut h.clock, "本机宿主").unwrap();
    let ch = crate::comments::add(&mut h.conn, &mut h.clock, &hh, "本机原文").unwrap();
    let (created, signed): (String, String) = h
        .conn
        .query_row("SELECT created_at, born_device FROM item_comment WHERE id = ?1", [&ch], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    h.conn.execute("DELETE FROM item_comment WHERE id = ?1", [&ch]).unwrap();
    force_comment_row_signed(&h.conn, &ch, &hh, "本机改过了", &created, Some(&signed));
    let err = import_snapshot(&mut h.conn, &mut h.clock, &clean.path).unwrap_err();
    assert!(err.contains("本机") && err.contains("与自身 create op 不符"), "⑦{err}");
}

/// 留言的**依赖前置**两支(设计审一轮 H3):孤儿 / 父 create 晚于它。
///
/// 这两支住在 `audit_op_preconditions`(表复制**之后**跑),报错话术与上面那六支不同,
/// 故与它们分得开。
#[test]
fn import_rejects_orphan_and_out_of_order_comment_ops() {
    let ts = "2026-08-07T12:00:00.000Z";
    let ghost = "01GHZ5TGHZ5TGHZ5TGHZ5TGHZ5"; // 26 位规范 ULID,库里没有这一行
    let payload = |item: &str, content: &str| {
        format!(r#"{{"item_id":"{item}","content":"{content}","created_at":"{ts}","born_device":null}}"#)
    };

    // ① 孤儿:comment create 的宿主既无行、也无任何 create/更早 tombstone。
    //
    // ⚠ 这一格**不能**顺手插一行来让语义审计放行:`item_comment.item_id` 有 FK,宿主不在
    // 就插不进去。改用另一条同样能让语义审计放行的路 —— **给这条留言自己配一枚
    // tombstone**(判据 2 的例外之一「自己已 tombstone 就不要求有行」)。于是三支语义
    // 判据全过,轮到依赖前置那支承重。
    let mut a = peer("cmt-orphan");
    notes::capture(&mut a.conn, &mut a.clock, "让快照非空").unwrap();
    let cid = "01CMTARPHAN0000000000000AA";
    inject_raw_op(&a.conn, &mut a.clock, "comment", cid, "create", &payload(ghost, "孤儿留言"));
    inject_raw_op(&a.conn, &mut a.clock, "comment", cid, "tombstone", "{}");
    let snap = raw_snapshot(&a.conn, &a.dir);
    let mut z = peer("cmt-orphan-dst");
    let err = import_snapshot(&mut z.conn, &mut z.clock, &snap.path).unwrap_err();
    assert!(err.contains("孤儿"), "①{err}");

    // ② 因果倒序:宿主 item 的 create 比 comment create **晚**。
    // 手工造一枚 wall_ms=1 的远端 HLC(`inject_raw_op` 走本机时钟,只会越来越晚)。
    let mut b = peer("cmt-order");
    let host = notes::capture(&mut b.conn, &mut b.clock, "宿主").unwrap();
    let cid = "01CMTARDER00000000000000BB";
    let early = crate::clock::Hlc {
        wall_ms: 1,
        counter: 0,
        device_id: "RMTDEV0000000000000000000X".into(),
    }
    .encode();
    b.conn
        .execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, 'comment', ?3, 'create', ?4, 1)",
            rusqlite::params![ulid::Ulid::new().to_string(), early, cid, payload(&host, "太早了")],
        )
        .unwrap();
    force_comment_row(&b.conn, cid, &host, "太早了", ts);
    let snap = raw_snapshot(&b.conn, &b.dir);
    let mut z = peer("cmt-order-dst");
    let err = import_snapshot(&mut z.conn, &mut z.clock, &snap.path).unwrap_err();
    assert!(err.contains("宿主 create 晚于它"), "②{err}");
}
