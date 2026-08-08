//! 条目留言的行为锚(identity-plan §4.8;设计审 GO 那轮给的十条清单里,①③④⑤ 与本地
//! 写原子性、回放状态机两组落在这里,移动那几条在 `move_item.rs`)。

use super::*;
use crate::clock::Hlc;
use crate::replay::{apply_remote_op, OpError, Outcome, RemoteOp};
use crate::{db, notes};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn fresh_db(tag: &str) -> (Connection, Clock) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let path =
        crate::test_temp::dir().join(format!("ys-nb-cmt-{tag}-{}-{}.sqlite3", std::process::id(), n));
    let _ = std::fs::remove_file(&path);
    let conn = db::open(&path).expect("open migrated db");
    let clock = Clock::load(&conn).expect("load clock");
    (conn, clock)
}

/// 一条来自别机的 comment op(HLC 在 2100 年,压得过任何本地写)。
fn remote(kind: &str, id: &str, seq: i64, payload: serde_json::Value) -> RemoteOp {
    RemoteOp {
        op_id: ulid::Ulid::new().to_string(),
        hlc: Hlc {
            wall_ms: 4_102_444_800_000 + seq as u64,
            counter: 0,
            device_id: "RMTDEV0000000000000000000X".into(),
        }
        .encode(),
        entity: "comment".into(),
        entity_id: id.to_string(),
        kind: kind.into(),
        payload,
        origin_seq: seq,
    }
}

fn create_payload(item_id: &str, content: &str) -> serde_json::Value {
    serde_json::json!({
        "item_id": item_id,
        "content": content,
        "created_at": "2026-08-07T12:00:00.000Z",
        "born_device": serde_json::Value::Null,
    })
}

fn ops_of(conn: &Connection, kind: &str) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM oplog WHERE entity='comment' AND kind=?1", [kind], |r| {
        r.get(0)
    })
    .unwrap()
}

const INSERT_NULL_SIGNED: &str =
    "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
     VALUES (?1, ?2, 'x', '2026-08-07T12:00:00.000Z', NULL)";

/// 幸福路:写→读→删,行与 op 一一对应;时间是定宽 24 字节的规范串。
#[test]
fn add_list_remove_round_trip() {
    let (mut c, mut k) = fresh_db("happy");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    let a = add(&mut c, &mut k, &item, "第一句").unwrap();
    let b = add(&mut c, &mut k, &item, "第二句").unwrap();
    let page = list_for_item(&c, &item, None).unwrap();
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.rows[0].id, b, "最近优先");
    assert_eq!(page.rows[0].created_at.len(), 24, "created_at 是定宽规范串");
    assert!(!page.has_more);
    assert_eq!(page.rows[0].born_device.as_deref(), Some(k.device_id()), "本机写的必带署名");
    assert_eq!(counts_all(&c).unwrap().get(&item).copied(), Some(2));
    assert_eq!(ops_of(&c, "create"), 2);

    remove(&mut c, &mut k, &a).unwrap();
    assert_eq!(list_for_item(&c, &item, None).unwrap().rows.len(), 1);
    assert_eq!(ops_of(&c, "tombstone"), 1);
    // 幂等:行已不在 = 不报错、也不再发第二条 op(另一端删了同步过来是正常并发)。
    remove(&mut c, &mut k, &a).unwrap();
    assert_eq!(ops_of(&c, "tombstone"), 1, "幂等 no-op 不发射");
}

/// 空正文 / 超长正文 / 孤儿宿主,三条入口守卫都响亮拒。
#[test]
fn add_rejects_empty_oversized_and_orphan() {
    let (mut c, mut k) = fresh_db("guard");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    assert!(add(&mut c, &mut k, &item, "   ").unwrap_err().contains("不能为空"));
    let huge = "x".repeat(200 * 1024 + 1);
    assert!(add(&mut c, &mut k, &item, &huge).unwrap_err().contains("内容太长"));
    assert!(add(&mut c, &mut k, "01BADBADBADBADBADBADBADBAD", "孤儿")
        .unwrap_err()
        .contains("条目不存在"));
}

/// 署名 **fail-closed**(§4.8 锚 1):非可信语境下 NULL 署名必须 ABORT,绝不静默落一个
/// 永不可改的空署名;可信语境下同一条 INSERT 必须放行(跨空间搬迁走的就是这条路)。
#[test]
fn born_device_is_fail_closed_outside_trusted_context() {
    let (mut c, mut k) = fresh_db("failclosed");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    let err = c
        .execute(INSERT_NULL_SIGNED, ("01CMTAAAAAAAAAAAAAAAAAAAAA", &item))
        .expect_err("非可信语境下 NULL 署名必须 ABORT");
    assert!(err.to_string().contains("出生设备"), "{err}");
    c.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    c.execute(INSERT_NULL_SIGNED, ("01CMTAAAAAAAAAAAAAAAAAAAAA", &item))
        .expect("可信语境下 NULL 合法");
    c.execute("DELETE FROM sync_replay_active", []).unwrap();
}

/// 留言行**永不改写**:UPDATE 一律 ABORT,**连可信语境也不豁免**(没有任何合法路径要改它;
/// 这是「留言不可编辑」这条产品决定在存储层的背板)。
#[test]
fn comment_rows_are_immutable_even_in_trusted_context() {
    let (mut c, mut k) = fresh_db("immutable");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    let id = add(&mut c, &mut k, &item, "原文").unwrap();
    for trusted in [false, true] {
        if trusted {
            c.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        }
        let err = c
            .execute("UPDATE item_comment SET content = '改过' WHERE id = ?1", [&id])
            .expect_err("留言不可编辑");
        assert!(err.to_string().contains("不可编辑"), "{err}(trusted={trusted})");
        if trusted {
            c.execute("DELETE FROM sync_replay_active", []).unwrap();
        }
    }
}

/// 本地软闸:到 500 就响亮拒(在事务内数,§4.8 本地写原子性那组)。
#[test]
fn local_soft_cap_rejects_loudly() {
    let (mut c, mut k) = fresh_db("cap");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    // 直接灌行(走编排层要 500 次事务、太慢);背书与否与本闸无关。
    let tx = c.transaction().unwrap();
    tx.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    for i in 0..MAX_COMMENTS_PER_ITEM {
        tx.execute(INSERT_NULL_SIGNED, (format!("01CAP{i:021}"), &item)).unwrap();
    }
    tx.execute("DELETE FROM sync_replay_active", []).unwrap();
    tx.commit().unwrap();
    let err = add(&mut c, &mut k, &item, "第 501 条").unwrap_err();
    assert!(err.contains("上限"), "{err}");
}

/// 回放四道判断的**顺序**(§4.3 第 4 条,设计审二轮 M1):墓碑在场时第二条 create 必须
/// `InvalidOp` 拒收、**且不留在日志里**。
///
/// 顺序若反过来(先判墓碑),这条 create 会被 `SuppressedByTombstone` 早返回,而它
/// **已经落进日志了** —— 随后 boot 的 `audit_create_multiplicity` 以「重复 create」拒库。
#[test]
fn duplicate_create_is_rejected_before_the_tombstone_shortcut() {
    let (mut c, mut k) = fresh_db("order");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    let cid = "01CMTBBBBBBBBBBBBBBBBBBBBB";
    apply_remote_op(&mut c, &mut k, &remote("create", cid, 1, create_payload(&item, "一"))).unwrap();
    apply_remote_op(&mut c, &mut k, &remote("tombstone", cid, 2, serde_json::json!({}))).unwrap();
    let before = ops_of(&c, "create");
    let err = apply_remote_op(&mut c, &mut k, &remote("create", cid, 3, create_payload(&item, "二")))
        .expect_err("墓碑之后的第二条 create 必须拒收");
    assert!(matches!(err, OpError::InvalidOp(_)), "{err:?}");
    assert_eq!(ops_of(&c, "create"), before, "拒收的 create 不许留在日志里");
}

/// 三种到达顺序的终态,以及父的两种处置(§4.8 锚 3/4)。
#[test]
fn tombstone_sticky_parent_gone_and_dependency_missing() {
    let (mut c, mut k) = fresh_db("arrive");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();

    // ① 墓碑先到、create 后到 → 压制,终态无行。
    let a = "01CMTCCCCCCCCCCCCCCCCCCCCC";
    apply_remote_op(&mut c, &mut k, &remote("tombstone", a, 1, serde_json::json!({}))).unwrap();
    let out =
        apply_remote_op(&mut c, &mut k, &remote("create", a, 2, create_payload(&item, "迟到")))
            .unwrap();
    assert!(matches!(out, Outcome::SuppressedByTombstone));
    assert_eq!(list_for_item(&c, &item, None).unwrap().rows.len(), 0);

    // ② 宿主不存在且无墓碑 → DependencyMissing(挂起重试)。
    let b = "01CMTDDDDDDDDDDDDDDDDDDDDD";
    // ⚠ 26 位 Crockford:字母表**去掉 I/L/O/U**,所以「GHOST」这种好记的串不合法
    // (夹具里已经踩过三次,见 memory `zhujian-identity-plan-301`)。
    let ghost = "01GHZ5TGHZ5TGHZ5TGHZ5TGHZ5";
    let err = apply_remote_op(&mut c, &mut k, &remote("create", b, 3, create_payload(ghost, "孤儿")))
        .expect_err("宿主未到必须挂起");
    assert!(matches!(err, OpError::DependencyMissing(_)), "{err:?}");

    // ③ 宿主已 tombstone → ParentGone(只记账,不建行)。
    let victim = notes::capture(&mut c, &mut k, "将被删").unwrap();
    notes::archive(&mut c, &mut k, &victim).unwrap();
    notes::purge(&mut c, &mut k, &victim).unwrap();
    let d = "01CMTEEEEEEEEEEEEEEEEEEEEE";
    let out =
        apply_remote_op(&mut c, &mut k, &remote("create", d, 4, create_payload(&victim, "父已死")))
            .unwrap();
    assert!(matches!(out, Outcome::ParentGone));
    let rows: i64 =
        c.query_row("SELECT COUNT(*) FROM item_comment WHERE id = ?1", [d], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "父已死不建子行");
}

/// **§4.8 锚 2 的正面锚**:删条目 → 留言随 FK CASCADE 走、**零 comment tombstone op**,
/// 而这个终态(有 create / 无行 / 无 comment tombstone / 有 item tombstone)之后
/// `strict_battery` **必须仍然通过**。
///
/// 设计审一轮 H2 打的就是这里:原判据会把它判坏 —— **第一次删掉带留言的条目之后,那个库
/// 就再也过不了电池**(供快照 / 引导 / 压实前三条路全挂)。
#[test]
fn deleting_the_item_cascades_comments_and_the_battery_still_passes() {
    let (mut c, mut k) = fresh_db("cascade");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    add(&mut c, &mut k, &item, "一").unwrap();
    add(&mut c, &mut k, &item, "二").unwrap();
    notes::archive(&mut c, &mut k, &item).unwrap();
    notes::purge(&mut c, &mut k, &item).unwrap();
    let left: i64 = c.query_row("SELECT COUNT(*) FROM item_comment", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "留言随宿主 CASCADE 消失");
    assert_eq!(ops_of(&c, "tombstone"), 0, "不逐条发 comment tombstone(最小日志形)");
    assert_eq!(ops_of(&c, "create"), 2, "create 是史实,留在日志里");
    crate::sync::boot::strict_battery(&c).expect("CASCADE 之后电池必须仍通过");
}

/// 分页三件(§4.8 锚 9 + 设计审二轮 M3):条数上界 / 字节预算截断 / **越预算的行不消费
/// 它的 cursor**(消费了就永久跳行);外加「单条超预算也必须能单独成页」。
#[test]
fn paging_respects_both_bounds_and_never_skips_a_row() {
    let (mut c, mut k) = fresh_db("page");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    // 60 条小留言 → 第一页恰 50 条、has_more,由「多读到一行」这个事实得出。
    for i in 0..60 {
        add(&mut c, &mut k, &item, &format!("第{i}条")).unwrap();
    }
    let p1 = list_for_item(&c, &item, None).unwrap();
    assert_eq!(p1.rows.len(), PAGE_ROWS);
    assert!(p1.has_more);
    let cur = p1.next_cursor.clone().unwrap();
    let p2 = list_for_item(&c, &item, Some((&cur.0, &cur.1))).unwrap();
    assert_eq!(p2.rows.len(), 10);
    assert!(!p2.has_more, "最后一页 has_more=false");
    // 两页无重无漏。
    let mut all: Vec<&str> = p1.rows.iter().chain(p2.rows.iter()).map(|r| r.id.as_str()).collect();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), 60, "两页合起来无重无漏");

    // 恰 50 条、全部适配 → 不许误报 has_more(codex 二轮 L2)。上面 60 条那一段证的是
    // 「读到第 51 条时停」,**没有**证「没有第 51 条时不误报」—— 两件事。
    let (mut c50, mut k50) = fresh_db("page-exact");
    let item50 = notes::capture(&mut c50, &mut k50, "宿主").unwrap();
    for i in 0..PAGE_ROWS {
        add(&mut c50, &mut k50, &item50, &format!("恰{i}")).unwrap();
    }
    let e = list_for_item(&c50, &item50, None).unwrap();
    assert_eq!(e.rows.len(), PAGE_ROWS);
    assert!(!e.has_more, "恰 50 条且全部适配时不许说还有下一页");

    // 字节预算:三条各 100 KiB(> 256 KiB 预算)→ 第一页只装两条,第三条留到下一页。
    let (mut c2, mut k2) = fresh_db("page-bytes");
    let item2 = notes::capture(&mut c2, &mut k2, "宿主").unwrap();
    let big = "x".repeat(100 * 1024);
    for _ in 0..3 {
        add(&mut c2, &mut k2, &item2, &big).unwrap();
    }
    let q1 = list_for_item(&c2, &item2, None).unwrap();
    assert_eq!(q1.rows.len(), 2, "第三条会越 256 KiB 预算,不纳入");
    assert!(q1.has_more, "被字节预算截断也算 has_more");
    let qc = q1.next_cursor.clone().unwrap();
    let q2 = list_for_item(&c2, &item2, Some((&qc.0, &qc.1))).unwrap();
    assert_eq!(q2.rows.len(), 1, "越预算那条必须出现在下一页(cursor 没被它消费掉)");
    assert_ne!(q2.rows[0].id, q1.rows[1].id);

    // **合法最大行**(200 KiB,正文上限)必须能返回。
    // ⚠ 这里原先写的是「单条 200 KiB(> 预算)仍要能单独成页」—— **那句话是错的**:
    // 200 KiB < 256 KiB 预算,合法行永远越不了预算,所以这一段从来没走到「第一行无条件
    // 纳入」那一支(codex 实现审一轮 M2)。那一支的行为锚另立一只
    // `a_single_over_budget_row_still_forms_a_page_by_itself`,靠直灌 300 KiB 才走得到。
    let (mut c3, mut k3) = fresh_db("page-huge");
    let item3 = notes::capture(&mut c3, &mut k3, "宿主").unwrap();
    let huge = "y".repeat(200 * 1024);
    add(&mut c3, &mut k3, &item3, &huge).unwrap();
    let r = list_for_item(&c3, &item3, None).unwrap();
    assert_eq!(r.rows.len(), 1, "合法最大行能返回");
    assert!(!r.has_more);
}

/// `created_at` 的**定宽**判据(设计审三轮 M2):不是「能 parse 成 RFC3339」而是
/// 「parse → 用同一个 formatter 重格式化 → 逐字相等」。非定宽 / 带 offset / 超毫秒精度
/// 三类都必须拒;拒的形态是 `InvalidOp`(已知词汇下的坐标非法),不是版本偏斜。
///
/// ⚠ **判据必须落在 validator 上,不能落在存储层那道 `length(created_at) = 24` 的 CHECK
/// 上** —— 变异对照 ④ 抓到的假绿:本测首版那四个坏样本长度是 20 / 22 / 27 / 29,**一个
/// 都不是 24**,于是把 validator 退化成 `parse && ends_with('Z')` 之后它们照样被 CHECK
/// 拒成 `InvalidOp`,测试全绿。0035 的注释本就写着「存储层这道 CHECK 是**第二道**」,
/// 而我拿第二道的战果给第一道记了账。
///
/// 修法 = 加一类**恰 24 字节、能 parse、却不规范**的样本(只有 validator 拒得掉),并让
/// 每个样本用**各自的 comment id**(共用一个 id 时,第一个被放行就会把后面几个推给
/// multiplicity 那道闸,判据又跑到别处去了)。
#[test]
fn created_at_must_be_the_fixed_width_canonical_form() {
    let (mut c, mut k) = fresh_db("time");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    // 各样本一个 id(26 位 Crockford,去 I/L/O/U)。
    let ids = [
        "01CMTF00000000000000000000",
        "01CMTF00000000000000000001",
        "01CMTF00000000000000000002",
        "01CMTF00000000000000000003",
        "01CMTF00000000000000000004",
        "01CMTF00000000000000000005",
    ];
    let bad = [
        "2026-08-07T12:00:00Z",          // 无小数秒 —— TEXT 序里会排到 .1Z 前面
        "2026-08-07T12:00:00.1Z",        // 一位小数
        "2026-08-07T12:00:00.123456Z",   // 超毫秒精度
        "2026-08-07T20:00:00.000+08:00", // 带 offset
        // ↓ 恰 24 字节:CHECK 放行,只有定宽 validator 拒得掉(RFC3339 §5.6 允许小写)
        "2026-08-07t12:00:00.123Z",
        "2026-08-07T12:00:00.123z",
    ];
    for (i, ts) in bad.iter().enumerate() {
        let mut op = remote("create", ids[i], 10 + i as i64, create_payload(&item, "x"));
        op.payload["created_at"] = serde_json::json!(ts);
        let err = apply_remote_op(&mut c, &mut k, &op).expect_err("非规范时间必须拒");
        assert!(matches!(err, OpError::InvalidOp(_)), "{ts}{err:?}");
    }
    // 后两个不只是「被拒」,还要**自证是被定宽那一支拒的**:直接量 validator,并核对
    // 报错落在「必须是定宽规范串」而不是「非合法 RFC3339」—— 后者说明它压根没 parse
    // 成功,那就没验到定宽这一格。
    for ts in ["2026-08-07t12:00:00.123Z", "2026-08-07T12:00:00.123z"] {
        assert_eq!(ts.len(), 24, "样本必须恰 24 字节,否则又是 CHECK 在替它办事");
        let e = crate::replay::validate_comment_created_at_for_test(ts)
            .expect_err("24 字节的非规范形必须由 validator 拒掉");
        assert!(e.contains("必须是定宽规范串"), "拒它的不是定宽那一支:{e}");
    }
    // 本地产出的值必须过同一个 validator(产出与校验单一来源)。
    let id = add(&mut c, &mut k, &item, "本机").unwrap();
    let ts: String =
        c.query_row("SELECT created_at FROM item_comment WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
    crate::replay::validate_comment_created_at_for_test(&ts).expect("本地产出必须自洽");
}

/// payload 值域:恰四键、两个 ULID、tombstone 恰零键。多一个键就是 `InvalidOp`
/// (代价已记 §4.12 第 1 条:日后连非语义元数据也不能直接追加)。
#[test]
fn payload_shape_is_exact() {
    let (mut c, mut k) = fresh_db("shape");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    let cid = "01CMTGGGGGGGGGGGGGGGGGGGGG";

    let mut extra = remote("create", cid, 1, create_payload(&item, "x"));
    extra.payload["额外"] = serde_json::json!("键");
    assert!(matches!(
        apply_remote_op(&mut c, &mut k, &extra).expect_err("多一个键必拒"),
        OpError::InvalidOp(_)
    ));

    let mut bad_host = remote("create", cid, 2, create_payload("不是ULID", "x"));
    bad_host.payload["item_id"] = serde_json::json!("短");
    assert!(matches!(
        apply_remote_op(&mut c, &mut k, &bad_host).expect_err("item_id 非规范 ULID 必拒"),
        OpError::InvalidOp(_)
    ));

    let mut bad_ts = remote("tombstone", cid, 3, serde_json::json!({"why": "x"}));
    bad_ts.kind = "tombstone".into();
    assert!(matches!(
        apply_remote_op(&mut c, &mut k, &bad_ts).expect_err("tombstone 必须零键"),
        OpError::InvalidOp(_)
    ));
}

// ---- codex 实现审一轮的五条(M1 / M2 行为面 / M3 两半 / L1) -------------------------

/// 在**可信语境**下直灌一行 item(绕过 `born_device` 与 0022 那批守护),用来造那些
/// 「生产路径造不出、但库里可能合法存在」的宿主。
fn insert_raw_item(conn: &Connection, id: &str) {
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    conn.execute(
        "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage) \
         VALUES (?1, '脏条目', 'inbox', '2026-08-07T12:00:00.000Z', \
                 '2026-08-07T12:00:00.000Z', 'a0', 'inbox')",
        [id],
    )
    .unwrap();
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();
}

/// **M1**:宿主行在,不等于它的 id 发得出去。
///
/// `items.id` 存储层没有 ULID CHECK、item op 的 `entity_id` 在 `validate_op_shape` 里也没有
/// 形态闸 —— 所以库里可能合法存在一个非规范 id 的条目。对它留言若放行,发出去的 comment
/// create 会撞别端「`item_id` 必须是规范 ULID」那道闸 → `InvalidOp` → **把老实发消息的
/// 自己那条 origin 持久隔离**。本地当场拒才对。
#[test]
fn add_rejects_a_host_whose_id_is_not_a_canonical_ulid() {
    let (mut c, mut k) = fresh_db("badhost");
    // 26 位、全大写字母数字(过得了 items 那边的一切),但含 Crockford 禁用的 I/L/O/U。
    let dirty = "01ILOU00000000000000000000";
    assert!(!crate::clock::is_canonical_ulid(dirty));
    insert_raw_item(&c, dirty);

    let err = add(&mut c, &mut k, dirty, "给脏条目留言").unwrap_err();
    assert!(err.contains("不是规范形"), "{err}");
    // 既不许落行,也不许留下一条别端会拒的 op。
    let rows: i64 = c.query_row("SELECT COUNT(*) FROM item_comment", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
    assert_eq!(ops_of(&c, "create"), 0);

    // 阳性对照:同一把闸不许误伤正常宿主。
    let good = notes::capture(&mut c, &mut k, "干净宿主").unwrap();
    add(&mut c, &mut k, &good, "正常留言").unwrap();
}

/// **M2 的行为面**:一行独自越预算时,它仍要能单独成页(前进保证)。
///
/// ⚠ 这条**不能**用合法数据证 —— 正文上限 200 KiB < 256 KiB 预算,合法行永远越不了。
/// (本测的前身把「单条 200 KiB」写成「> 256 KiB 预算」,那句话是错的,于是「第一行无条件
/// 纳入」那一支从来没被走到过 —— codex 实现审一轮 M2 抓出。)这里靠可信语境直灌一行
/// 300 KiB 来真走那一支。
#[test]
fn a_single_over_budget_row_still_forms_a_page_by_itself() {
    let (mut c, mut k) = fresh_db("overbudget");
    let item = notes::capture(&mut c, &mut k, "宿主").unwrap();
    let huge = "z".repeat(300 * 1024);
    assert!(huge.len() > PAGE_CONTENT_BYTES);
    c.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    c.execute(
        "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
         VALUES ('01CMTOVERBUDGET00000000000', ?1, ?2, '2026-08-07T12:00:00.000Z', NULL)",
        (&item, &huge),
    )
    .unwrap();
    c.execute("DELETE FROM sync_replay_active", []).unwrap();

    let p = list_for_item(&c, &item, None).unwrap();
    assert_eq!(p.rows.len(), 1, "越预算的第一行也必须能单独成页,否则这一页永远返回空");
    assert_eq!(p.rows[0].content.len(), huge.len());
    assert!(!p.has_more, "就这一行,没有下一页");
}

/// **M3 上半**:shape 闸直接量,不经 `apply_remote_op`。
///
/// 经 apply 的话好几格其实是被**同一条链路上更靠后的另一把尺**代答的(表 CHECK / FK /
/// 父缺失判断 / apply 内第二次取值),而 `InvalidOp` 这个形态分不出是谁拒的。这里逐个
/// 样本只喂 `validate_op_shape`,并各带一枚阳性对照(合法 create / 合法 tombstone)。
#[test]
fn comment_shape_gate_is_measured_directly() {
    let ok_item = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    let ok_cid = "01HYYYYYYYYYYYYYYYYYYYYYYY";
    let vet = crate::replay::validate_op_shape;

    // 阳性:合法 create 与合法 tombstone 必须过 —— 没有它,下面每一条「拒」都可能只是
    // 因为夹具本身就不合法。
    vet(&remote("create", ok_cid, 1, create_payload(ok_item, "正常"))).expect("合法 create");
    vet(&remote("tombstone", ok_cid, 2, serde_json::json!({}))).expect("合法 tombstone");

    let cases: Vec<(&str, RemoteOp)> = vec![
        (
            "entity_id 26 位但含 I/L/O/U",
            remote("create", "01ILOU00000000000000000000", 3, create_payload(ok_item, "x")),
        ),
        (
            "tombstone 的 entity_id 同样要过闸",
            remote("tombstone", "01ILOU00000000000000000000", 4, serde_json::json!({})),
        ),
        (
            "item_id 26 位但含 I/L/O/U",
            remote("create", ok_cid, 5, create_payload("01ILOU00000000000000000000", "x")),
        ),
        (
            "content 超 200 KiB(表上没有长度 CHECK,只有这道闸)",
            remote("create", ok_cid, 6, create_payload(ok_item, &"x".repeat(200 * 1024 + 1))),
        ),
        ("born_device 26 位但含 I/L/O/U", {
            let mut op = remote("create", ok_cid, 7, create_payload(ok_item, "x"));
            op.payload["born_device"] = serde_json::json!("01ILOU00000000000000000000");
            op
        }),
        ("缺 born_device 键(apply 会把它当 NULL 收下,只有恰四键这道闸拦得住)", {
            let mut op = remote("create", ok_cid, 8, create_payload(ok_item, "x"));
            op.payload.as_object_mut().unwrap().remove("born_device");
            op
        }),
        ("content 不是字符串", {
            let mut op = remote("create", ok_cid, 9, create_payload(ok_item, "x"));
            op.payload["content"] = serde_json::json!(42);
            op
        }),
        ("tombstone 带键", remote("tombstone", ok_cid, 10, serde_json::json!({"why": "x"}))),
    ];
    for (label, op) in cases {
        let err = vet(&op).expect_err(label);
        assert!(matches!(err, OpError::InvalidOp(_)), "{label}:期待 InvalidOp,得到 {err:?}");
    }
}

/// **M3 下半**:`trg_comment_born_device_required` 里那道 `NOT EXISTS (sync_meta)` 分支。
///
/// 守卫是三项析取(`born_device IS NULL` **或** 没有 device_id 行 **或** 与本机不等),而
/// 既有那只测只走了第一项 —— 中间那项**删掉也不会红**(memory `test-negative-control`:
/// 多析取项的守卫,每一项都要有一只只有它能守的测)。这里让另外两项都取假:库里**没有**
/// device_id 行(0019 刻意不预插,只有 `Clock::load` 才写),而 `born_device` 给一个规范形的
/// 非 NULL 值。少了那道 NOT EXISTS,`NEW.x <> (SELECT ...)` 求值为 NULL、WHEN 不触发 →
/// **静默落一个永不可改的错署名**。
#[test]
fn born_device_trigger_closes_the_missing_device_id_row_branch() {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let path =
        crate::test_temp::dir().join(format!("ys-nb-cmt-nometa-{}-{}.sqlite3", std::process::id(), n));
    let _ = std::fs::remove_file(&path);
    // **刻意不调 Clock::load** —— 那一步才会写 sync_meta 的 device_id 行。
    let conn = db::open(&path).expect("open migrated db");
    let missing: i64 =
        conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE key='device_id'", [], |r| r.get(0))
            .unwrap();
    assert_eq!(missing, 0, "前提:这枚库还没有设备身份");

    let item = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    insert_raw_item(&conn, item);
    let err = conn
        .execute(
            "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
             VALUES ('01CMTNOMETA000000000000000', ?1, 'x', '2026-08-07T12:00:00.000Z', \
                     '01HXXXXXXXXXXXXXXXXXXXXXXX')",
            [item],
        )
        .expect_err("没有 device_id 行时,非 NULL 的规范署名同样必须 ABORT");
    assert!(err.to_string().contains("出生设备"), "{err}");
}

/// **L1**:软闸那条「事务内数」所依赖的 SQLite 假设锚 —— 两条连接都读到 499 时,一方
/// 成功、另一方**响亮失败**(WAL 下旧快照升级写事务得 BUSY),终态恰 500,不会静默 501。
///
/// 生产上每空间是单写者租约,这个并发本就不该出现;这只测钉的是**那条推理依赖的 SQLite
/// 行为**,不是生产形(codex 认可不必改成 IMMEDIATE)。
#[test]
fn two_deferred_readers_cannot_both_pass_the_soft_cap() {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let path =
        crate::test_temp::dir().join(format!("ys-nb-cmt-race-{}-{}.sqlite3", std::process::id(), n));
    let _ = std::fs::remove_file(&path);
    let mut c1 = db::open(&path).expect("open db");
    let mut k1 = Clock::load(&c1).expect("clock");
    let item = notes::capture(&mut c1, &mut k1, "宿主").unwrap();
    {
        let tx = c1.transaction().unwrap();
        tx.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
        for i in 0..(MAX_COMMENTS_PER_ITEM - 1) {
            tx.execute(INSERT_NULL_SIGNED, (format!("01RACE{i:020}"), &item)).unwrap();
        }
        tx.execute("DELETE FROM sync_replay_active", []).unwrap();
        tx.commit().unwrap();
    }
    let mut c2 = db::open(&path).expect("second connection");
    // 别让 busy_timeout 把「响亮失败」拖成 5 秒;WAL 下过期快照升级本就即刻返回 BUSY。
    c2.busy_timeout(std::time::Duration::from_millis(0)).unwrap();

    let count = |tx: &rusqlite::Transaction<'_>| -> i64 {
        tx.query_row("SELECT COUNT(*) FROM item_comment WHERE item_id = ?1", [&item], |r| r.get(0))
            .unwrap()
    };
    let insert = "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
                  VALUES (?1, ?2, 'x', '2026-08-07T12:00:00.000Z', \
                          (SELECT value FROM sync_meta WHERE key = 'device_id'))";

    let tx1 = c1.transaction().unwrap();
    let tx2 = c2.transaction().unwrap();
    assert_eq!(count(&tx1), MAX_COMMENTS_PER_ITEM - 1, "两边都读到 499");
    assert_eq!(count(&tx2), MAX_COMMENTS_PER_ITEM - 1);

    tx1.execute(insert, ("01RACEWINNER00000000000000", &item)).unwrap();
    tx1.commit().unwrap();

    let err = tx2
        .execute(insert, ("01RACELOSER000000000000000", &item))
        .expect_err("过期快照升级写事务必须响亮失败,而不是静默写成第 501 条");
    // 错误**类型**也要钉(codex 二轮 L1):只断「有错」的话,日后夹具漂移(id 撞 PK、
    // 触发器改口径)造出的约束错误就能冒充「并发闸还在工作」。这只测钉的是 SQLite 假设,
    // 那就得指名道姓 —— 517 = `SQLITE_BUSY_SNAPSHOT`(WAL 下过期快照升级写事务)。
    match &err {
        rusqlite::Error::SqliteFailure(e, _) => {
            assert_eq!(e.code, rusqlite::ErrorCode::DatabaseBusy, "{err}");
            assert_eq!(e.extended_code, 517, "期待 SQLITE_BUSY_SNAPSHOT:{err}");
        }
        other => panic!("期待 SqliteFailure(BUSY_SNAPSHOT),得到:{other}"),
    }
    drop(tx2);
    let total: i64 = c1
        .query_row("SELECT COUNT(*) FROM item_comment WHERE item_id = ?1", [&item], |r| r.get(0))
        .unwrap();
    assert_eq!(total, MAX_COMMENTS_PER_ITEM, "终态恰 500:{err}");
}
