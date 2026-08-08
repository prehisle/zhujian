use super::*;
use crate::clock::Hlc;
use crate::db;
use std::sync::atomic::{AtomicU32, Ordering};
use ulid::Ulid;

const T: &str = "01TARGETAAAAAAAAAAAAAAAAAA";
const SNAP: i64 = 1000;

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn wm(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
}

/// 短标签 → 规范 26 字符 device id(右补 'A',字典序跟着标签走)。
/// 生产里 origin 恒是这个形状,测试也照这个形状写,不然形态闸一接就全红。
fn oid(tag: &str) -> String {
    assert!(tag.len() <= 26, "标签太长");
    format!("{tag:A<26}")
}

/// 过完形态闸的对端水位图(短标签自动补齐)。
fn vw(pairs: &[(&str, i64)]) -> VettedWatermarks {
    let m: BTreeMap<String, i64> = pairs.iter().map(|(k, v)| (oid(k), *v)).collect();
    vet_watermarks(m).expect("测试水位图必须是规范形")
}

fn fresh_db() -> Connection {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let path = crate::test_temp::dir()
        .join(format!("ys-nb-opsserve-{}-{}.sqlite3", std::process::id(), n));
    let _ = std::fs::remove_file(&path);
    db::open(&path).expect("open migrated db")
}

/// 第 i 台设备的规范 26 字符 id;字典序跟着 i 走。
fn dev(i: usize) -> String {
    format!("D{i:025}")
}

/// 往 oplog 里塞一条 op。`pad` = 正文填充长度(撑字节尺用)。
fn put(conn: &Connection, device: &str, seq: i64, pad: usize) {
    let hlc = Hlc { wall_ms: 1_000 + seq as u64, counter: 0, device_id: device.into() }.encode();
    let payload = serde_json::json!({
        "title": "T".repeat(pad.max(1)),
        "created_at": "2026-08-01T00:00:00Z",
    });
    conn.execute(
        "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
         VALUES (?1, ?2, 'topic', ?3, 'create', ?4, ?5)",
        (
            Ulid::new().to_string(),
            hlc,
            format!("01TOPIC{:019}", seq),
            serde_json::to_string(&payload).unwrap(),
            seq,
        ),
    )
    .expect("插 op");
}

fn plan_with(kind: PlanKind, cursor: ReconcileCursor, snap: i64) -> ReconcilePlan {
    ReconcilePlan { snapshot_rowid: snap, kind, cursor }
}

fn max_rowid(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(rowid), 0) FROM oplog", [], |r| r.get(0)).unwrap()
}

/// 跑一趟消费方泵:逐帧取 → 记账 → 提交,直到没活干。返回供出去的 (origin, seq)。
fn drain(conn: &Connection, work: &mut PeerWork) -> Vec<(String, i64)> {
    let mut got = vec![];
    let mut guard = 0;
    while let Some(p) = work.prepare_next(conn).expect("取帧").ready() {
        if let Some(f) = &p.frame {
            got.extend(f.ops.iter().map(|o| (f.origin.clone(), o.origin_seq)));
        }
        work.commit(p.token).expect("提交");
        guard += 1;
        assert!(guard < 10_000, "泵没收敛");
    }
    got
}

/// 取一帧并当场提交(不关心内容时用)。
fn step(conn: &Connection, work: &mut PeerWork) -> Option<OpsFrame> {
    let p = work.prepare_next(conn).expect("取帧").ready()?;
    let frame = p.frame.clone();
    work.commit(p.token).expect("提交");
    frame
}

// ---- 节流、计划与公平调度 --------------------------------------------------------

/// 首次两档都立即有资格(正常新设备入场不吃冷却);第二次分别受各自那一档约束。
#[test]
fn first_request_opens_immediately_second_waits_its_own_cooldown() {
    let mut w = OpsWorks::default();
    assert_eq!(w.on_hello(T, vw(&[("A", 3)]), SNAP, 0).admit, Admit::Ok);
    assert!(w.work_mut(T).unwrap().active.is_some(), "首次对账立即开");
    assert_eq!(w.throttle(T).unwrap().next_reconcile_tick, RECONCILE_COOLDOWN_TICKS);

    let before = w.work_mut(T).unwrap().active.clone();
    let _ = w.on_hello(T, vw(&[("A", 1)]), SNAP + 500, 1);
    assert_eq!(w.work_mut(T).unwrap().active, before, "冷却内不许改写活动计划");
    assert!(w.work_mut(T).unwrap().pending.is_some());

    let mut w2 = OpsWorks::default();
    let _ = w2.on_want(T, &oid("A"), 5, 0);
    assert_eq!(w2.work_mut(T).unwrap().urgent.len(), 1);
    assert_eq!(w2.throttle(T).unwrap().next_range_tick, RANGE_COOLDOWN_TICKS);
    assert_eq!(w2.throttle(T).unwrap().next_reconcile_tick, 0, "补洞不该动对账那一档");
}

/// **冷却只挡「开始服务」,不挡「登记义务」**(实现审 H1)。
///
/// 原来这只测只断言「冷却内队列仍为 1」——那正是把缺陷写成了绿:第二枚 Want 被
/// 直接丢弃,而**对端不周期重发 Want**,那个缺口就永久没人补了。
#[test]
fn a_gap_registered_during_cooldown_is_kept_and_promoted_by_the_heartbeat() {
    let mut w = OpsWorks::default();
    assert_eq!(w.on_want(T, &oid("A"), 5, 0).admit, Admit::Ok);
    assert_eq!(w.on_want(T, &oid("B"), 7, 0).admit, Admit::Ok, "冷却内照收");
    {
        let work = w.work_mut(T).unwrap();
        assert_eq!(work.urgent.len(), 1, "冷却内不进快车道");
        assert_eq!(work.deferred.len(), 1, "但义务必须留着 —— 丢了就没有任何续做所有者");
    }

    // 同 origin 再来一枚更早的:合并进已登记那条,取保守下界。
    assert_eq!(w.on_want(T, &oid("B"), 2, 0).admit, Admit::Ok);
    assert_eq!(w.work_mut(T).unwrap().deferred[0].next_seq, 2);
    assert_eq!(w.work_mut(T).unwrap().gaps_len(), 2, "不许因此多出一条段");

    let _ = w.on_tick(RANGE_COOLDOWN_TICKS, SNAP);
    let work = w.work_mut(T).unwrap();
    assert!(work.deferred.is_empty());
    assert_eq!(
        work.urgent.iter().map(|r| (r.origin.clone(), r.next_seq)).collect::<Vec<_>>(),
        vec![(oid("A"), 5), (oid("B"), 2)],
        "心跳到点把登记的义务原样放行"
    );
}

/// **本机的推送豁免 Range 冷却**(⑤ 的拍板项;上一只测的对照面)。
///
/// Range 冷却是为**对端驱动的 Want 洪水**设的闸;而 `BROADCAST` 那条是本机
/// `outbound` 自己走的路 —— 用户连着记两条,第二条要是落进 `deferred`,就得干等下一拍
/// 心跳(最长 30s)才出门。同一个人自己写自己的东西,没有需要被自己节流的道理。
///
/// **两格必须一起断**:只断「BROADCAST 不吃冷却」的话,把闸整个删掉也照样绿 ——
/// 定向那格恒吃冷却,才说明豁免是**只给 BROADCAST 开的口子**,不是闸没了。
/// 并且豁免**不许顺手消费 `next_range_tick`**:消费了的话,紧跟着来的定向 Want 会被
/// 本机自己的写平白推迟一拍。
#[test]
fn only_the_local_broadcast_push_is_exempt_from_the_range_cooldown() {
    let mut w = OpsWorks::default();
    // ① BROADCAST:同一刻连来两枚,两枚都进快车道。
    assert_eq!(w.on_want(BROADCAST, &oid("A"), 1, 0).admit, Admit::Ok);
    assert_eq!(w.on_want(BROADCAST, &oid("B"), 1, 0).admit, Admit::Ok);
    assert_eq!(w.work_mut(BROADCAST).unwrap().deferred.len(), 0, "本机的写不吃冷却");
    assert_eq!(w.work_mut(BROADCAST).unwrap().urgent.len(), 2);
    assert_eq!(
        w.throttle(BROADCAST).unwrap().next_range_tick,
        0,
        "豁免不许顺手消费冷却水位 —— 消费了就轮到别人替本机的写背这一拍"
    );

    // ② 定向 target:同一刻的第二枚照吃冷却(闸还在,只是给 BROADCAST 开了口子)。
    assert_eq!(w.on_want(T, &oid("A"), 1, 0).admit, Admit::Ok);
    assert_eq!(w.on_want(T, &oid("B"), 1, 0).admit, Admit::Ok);
    assert_eq!(w.work_mut(T).unwrap().deferred.len(), 1, "对端驱动的那条恒吃冷却");
}

/// **Hello 不许覆盖仍活动或在飞的计划**(实现审 H2)。
#[test]
fn a_hello_never_clobbers_a_running_or_in_flight_plan() {
    let conn = fresh_db();
    for i in 1..=3usize {
        put(&conn, &dev(i), 1, 1);
    }
    let snap = max_rowid(&conn);
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[]), snap, 0);
    step(&conn, w.work_mut(T).unwrap()).expect("先供一帧,游标离开起点");
    let cursor_before = w.work_mut(T).unwrap().active.as_ref().unwrap().cursor.clone();
    assert_ne!(cursor_before, ReconcileCursor::Start);

    // 冷却早过了(tick 9 ≫ 2),但计划还在跑 —— 这一枚只能进 pending。
    let _ = w.on_hello(T, vw(&[("A", 1)]), snap + 999, 9);
    let work = w.work_mut(T).unwrap();
    assert_eq!(work.active.as_ref().unwrap().cursor, cursor_before, "游标不许被重置回起点");
    assert_eq!(work.active.as_ref().unwrap().snapshot_rowid, snap, "快照不许被换掉");
    assert!(work.pending.is_some());

    // 在飞期间同理:计划刚跑完(active 已释放)也不算空闲,只要还有在飞那一笔。
    let mut w2 = OpsWorks::default();
    let _ = w2.on_hello(T, vw(&[]), snap, 0);
    let p = w2.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("有活");
    let _ = w2.on_hello(T, vw(&[("A", 1)]), snap + 999, 9);
    assert!(w2.work_mut(T).unwrap().pending.is_some(), "在飞时新 Hello 只能进 pending");
    w2.work_mut(T).unwrap().commit(p.token).expect("旧凭据提交到的还是旧计划");
}

/// 已定下的全量重扫不许被一枚新的细粒度 Hello 悄悄展开(折叠态第⑤条)。
#[test]
fn a_pending_full_rescan_is_never_re_expanded_by_a_later_hello() {
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[("A", 9)]), SNAP, 0); // 开计划,冷却到 2
    w.work_mut(T).unwrap().pending = Some(PendingReconcile { kind: PlanKind::Full });
    let _ = w.on_hello(T, vw(&[("A", 9), ("B", 9)]), SNAP, 1);
    assert_eq!(
        w.work_mut(T).unwrap().pending.as_ref().unwrap().kind,
        PlanKind::Full,
        "Full 占优 —— 合并一律取保守下界"
    );

    // 冷却到点开出来的也必须还是 Full。
    w.work_mut(T).unwrap().active = None;
    let _ = w.on_tick(RECONCILE_COOLDOWN_TICKS, SNAP);
    assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().kind, PlanKind::Full);
}

/// 新 pending 不得改写活动计划的快照 / 游标(六轮 M1)。
#[test]
fn pending_never_rewrites_active_snapshot_or_cursor() {
    let conn = fresh_db();
    put(&conn, &oid("A"), 1, 1);
    let snap = max_rowid(&conn);
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[]), snap, 0);
    step(&conn, w.work_mut(T).unwrap());
    let before = w.work_mut(T).unwrap().active.clone();

    let _ = w.on_hello(T, vw(&[("A", 0)]), snap + 9999, 1);
    assert_eq!(w.work_mut(T).unwrap().active, before, "快照与游标都钉死,新 Hello 碰不到");
}

/// bypass 只被下一枚有效 Hello 消费一次;折叠既不制造也不消费它;
/// **且它最迟随对账冷却一起失效**(实现审 H5:否则没人发 Hello 时留一块永久墓碑)。
#[test]
fn bypass_is_consumed_once_and_expires_with_the_reconcile_cooldown() {
    let conn = fresh_db();
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[]), SNAP, 0); // 空库:一帧都取不出,计划当场走完
    drain(&conn, w.work_mut(T).unwrap());
    assert!(w.work_mut(T).unwrap().active.is_none(), "走完的计划自己释放");
    assert!(!w.throttle(T).unwrap().bypass_once);

    let _ = w.on_peer_online(T, 1);
    assert!(w.throttle(T).unwrap().bypass_once, "冷却没到,券有用");

    let tick = 1;
    assert!(tick < w.throttle(T).unwrap().next_reconcile_tick);
    let _ = w.on_hello(T, vw(&[("A", 1)]), SNAP, tick);
    assert!(!w.throttle(T).unwrap().bypass_once, "有效 Hello 消费掉它");
    assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().cursor, ReconcileCursor::Start);

    // 已经有资格开计划时不发券:那张券加速不了任何事,却会把条目钉成永久墓碑。
    let mut w2 = OpsWorks::default();
    let _ = w2.on_peer_online(T, 0);
    assert!(!w2.throttle(T).unwrap().bypass_once, "首次本就立即有资格,不该发券");

    // 发出去而没人消费的券,到对账冷却那一刻自己作废。
    let mut w3 = OpsWorks::default();
    let _ = w3.on_hello(T, vw(&[]), SNAP, 0);
    drain(&conn, w3.work_mut(T).unwrap());
    let _ = w3.on_peer_online(T, 1);
    assert!(w3.throttle(T).unwrap().bypass_once);
    let _ = w3.on_tick(RECONCILE_COOLDOWN_TICKS, SNAP);
    assert_eq!(w3.len(), 0, "券到期 + 工作全空 → 墓碑整条回收,不占 64 格里的一格");
}

/// Range 洪水触发的折叠**既不消费也不制造** bypass(七轮 H3 ④)。
#[test]
fn range_flood_collapse_neither_consumes_nor_mints_bypass() {
    let conn = fresh_db(); // 空库:计划开出来空跑一趟就自己释放
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[]), SNAP, 0); // 先占掉对账那一档,好让 peer_online 发得出券
    drain(&conn, w.work_mut(T).unwrap());
    let _ = w.on_want(T, &oid("N00"), 1, 0);
    assert!(!w.throttle(T).unwrap().bypass_once, "补洞不许凭空造出加速券");
    let _ = w.on_peer_online(T, 1);
    assert!(w.throttle(T).unwrap().bypass_once);

    let mut sawcollapse = false;
    for i in 1..=OPS_RANGES_PER_TARGET as i64 {
        let r = w.on_want(T, &oid(&format!("N{i:02}")), 1, i as u64 * RANGE_COOLDOWN_TICKS);
        sawcollapse |= r.admit == Admit::Collapsed;
    }
    assert!(sawcollapse, "第 17 个 origin 必须折叠成全量重扫");
    assert!(w.throttle(T).unwrap().bypass_once, "折叠不许消费 bypass");
    assert_eq!(
        w.work_mut(T).unwrap().pending.as_ref().unwrap().kind,
        PlanKind::Full,
        "折叠态排进 pending,恒受对账那一档冷却"
    );
    assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0, "细粒度账已丢,两队都清空");
}

/// 合并取保守下界。改成取 max 必须红。
#[test]
fn pending_merge_takes_the_conservative_lower_bound() {
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[("A", 9)]), SNAP, 0);
    let _ = w.on_hello(T, vw(&[("A", 9), ("B", 5)]), SNAP, 1);
    let _ = w.on_hello(T, vw(&[("A", 2), ("B", 8)]), SNAP, 1);
    let PlanKind::Detailed { peer, bytes } =
        &w.work_mut(T).unwrap().pending.as_ref().unwrap().kind
    else {
        panic!("该是细粒度")
    };
    assert_eq!(peer.get(&oid("A")), Some(&2), "同 origin 取较小者");
    assert_eq!(peer.get(&oid("B")), Some(&5), "同 origin 取较小者");
    // 字节数是**合出来那张图的真实大小**,不是两边取大:`merge_low` 只留两边都提到
    // 的 key,合出来比哪边都小,记大了就是给预算凭空加水、让正常对端提前挨降级。
    assert_eq!(*bytes, watermark_map_bytes(peer), "合并后的账必须重算");

    let merged = merge_low(wm(&[("A", 4), ("C", 7)]), wm(&[("A", 6)]));
    assert_eq!(merged.get("A"), Some(&4));
    assert!(!merged.contains_key("C"), "缺席按 0,不许把 7 留下来");
}

/// 两层公平:补洞与对账**逐帧**严格交替;补洞队列内部未跑完的推队尾。
#[test]
fn two_layer_fairness_alternates_per_frame_and_rotates_within_urgent() {
    let conn = fresh_db();
    // 补洞三条段(第一条大到要两帧,靠条数尺);对账三台,字典序全排在补洞那三条**之后**。
    let gaps = [oid("W1"), oid("W2"), oid("W3")];
    for (n, g) in gaps.iter().enumerate() {
        for seq in 1..=(if n == 0 { MAX_OPS_PER_FRAME as i64 + 1 } else { 1 }) {
            put(&conn, g, seq, 1);
        }
    }
    let plan_origins = [oid("X1"), oid("X2"), oid("X3")];
    for p in &plan_origins {
        put(&conn, p, 1, 1);
    }
    let snap = max_rowid(&conn);
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[]), snap, 0);
    // 把游标推到补洞那三条之后:此后的 want 才是「计划已扫过」,该走快车道。
    // (游标停在起点时 want 折进计划、不新开段——那是 want_before_the_cursor 那只测。)
    w.work_mut(T).unwrap().active.as_mut().unwrap().cursor =
        ReconcileCursor::AfterOrigin { origin: oid("W9") };
    for (n, g) in gaps.iter().enumerate() {
        let _ = w.on_want(T, g, 1, n as u64 * RANGE_COOLDOWN_TICKS);
    }
    let work = w.work_mut(T).unwrap();
    assert_eq!(work.urgent.len(), 3, "三条段都该在快车道上");

    let mut kinds = vec![];
    for _ in 0..6 {
        let f = step(&conn, work).expect("这六帧都该有内容");
        kinds.push(f.origin);
    }
    let urgent_frames: Vec<&String> = kinds.iter().filter(|o| gaps.contains(o)).collect();
    assert_eq!(urgent_frames.len(), 3, "六帧里对账拿到一半 —— 逐帧交替");
    assert_eq!(
        urgent_frames,
        vec![&gaps[0], &gaps[1], &gaps[2]],
        "超长段发一帧就让位,不许整段跑完才轮到别人"
    );
}

// ---- 取帧 / 提交的凭据契约 -------------------------------------------------------

/// `prepare` 不推进;只有 `commit` 推进;回滚后重取拿到同一段;过期凭据提交不了。
#[test]
fn only_commit_advances_and_a_stale_token_cannot() {
    let conn = fresh_db();
    let d = oid("A");
    for seq in 1..=(MAX_OPS_PER_FRAME as i64 + 10) {
        put(&conn, &d, seq, 1);
    }
    let mut w = OpsWorks::default();
    let _ = w.on_want(T, &d, 1, 0);
    let work = w.work_mut(T).unwrap();

    let p1 = work.prepare_next(&conn).unwrap().ready().expect("有活");
    assert_eq!(work.urgent.front().unwrap().next_seq, 1, "取帧一步也不推进");
    let first_seq = p1.frame.as_ref().unwrap().ops.first().unwrap().origin_seq;
    // 回滚也得拿凭据:换成 p1 之外的任何一枚都不该生效。
    work.rollback(p1.token).expect("这枚凭据配得上在飞那一笔");
    assert_eq!(work.urgent.front().unwrap().next_seq, 1, "回滚不推进");

    let p2 = work.prepare_next(&conn).unwrap().ready().expect("重取");
    let p3_seq = p2.frame.as_ref().unwrap().ops.first().unwrap().origin_seq;
    assert_eq!(p3_seq, first_seq, "游标没动,重取拿到同一段");
    assert_eq!(work.urgent.front().unwrap().next_seq, 1, "失败的提交一步也没推进");
    work.commit(p2.token).expect("这枚才算数");
    assert_eq!(work.urgent.front().unwrap().next_seq, MAX_OPS_PER_FRAME as i64 + 1);
}

/// **凭据必须绑 work 身份**(实现审 H6):只绑 `seq` 等于没绑 —— 每份 work 的号都从
/// 0 起,A 的第一枚凭据正好能提交 B 的第一笔。
#[test]
fn a_token_from_another_work_cannot_commit() {
    let conn = fresh_db();
    let d = oid("A");
    for seq in 1..=4i64 {
        put(&conn, &d, seq, 1);
    }
    let other = dev(7);
    let mut w = OpsWorks::default();
    let _ = w.on_want(T, &d, 1, 0);
    let _ = w.on_want(&other, &d, 3, 0);

    let pa = w.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("A 有活");
    let pb = w.work_mut(&other).unwrap().prepare_next(&conn).unwrap().ready().expect("B 有活");
    let err = w.work_mut(&other).unwrap().commit(pa.token).unwrap_err();
    assert!(err.contains("凭据对不上"), "张冠李戴必须响亮:{err}");
    assert_eq!(w.work_mut(&other).unwrap().urgent.front().unwrap().next_seq, 3, "B 一步没动");
    w.work_mut(&other).unwrap().commit(pb.token).expect("B 自己的凭据照常");
}

/// 窗口 1 是**结构事实**:在飞时再取一枚拿不到东西,不靠调用方自律。
///
/// **且它必须与「没活」分得开**(L-d″ 第④笔下半,第②笔留的义务①):两条腿同时盯一个
/// 对端时后到的那条撞的是**正常争用**,而 `Idle` 是「这份 work 空了」——把两者混成同一
/// 个答案,消费方要么为争用拆掉健康的链,要么把「有活但被占」当成没活睡死。
#[test]
fn preparing_while_one_is_in_flight_is_occupied_not_idle_and_not_an_error() {
    let conn = fresh_db();
    put(&conn, &oid("A"), 1, 1);
    let mut w = OpsWorks::default();
    let _ = w.on_want(T, &oid("A"), 1, 0);
    let work = w.work_mut(T).unwrap();
    let p = work.prepare_next(&conn).unwrap().ready().expect("有活");
    assert!(
        matches!(work.prepare_next(&conn), Ok(Prepare::Occupied)),
        "在飞时再取 = 正常争用,既不是错误也不是没活"
    );
    work.commit(p.token).expect("提交");
    // **退役要多走一趟空探**(305):那一帧的「已读到尾」是取数那一刻的事实,而提交
    // 在一个中转往返之后;段得留到**读空**才出队,而读空那一趟的判据与提交同处一把
    // 库锁,写者插不进来。
    let spun = work.prepare_next(&conn).unwrap().ready().expect("段还在:先空转一趟");
    assert!(spun.frame.is_none(), "空探不放一个字节上线");
    work.commit(spun.token).expect("空转照样要提交");
    assert!(
        matches!(work.prepare_next(&conn), Ok(Prepare::Idle)),
        "读空之后才算没活 —— 与 Occupied 是两个答案"
    );
}

/// 轮转候选:**从游标之后绕一圈**,且**预筛掉在飞的那些**(§6.2 ⑨-4)。
#[test]
fn the_next_runnable_target_rotates_past_the_cursor_and_skips_in_flight_ones() {
    let conn = fresh_db();
    let d = oid("A");
    put(&conn, &d, 1, 1);
    let (a, b, c) = (dev(1), dev(2), dev(3));
    let mut w = OpsWorks::default();
    for t in [&a, &b, &c] {
        let _ = w.on_want(t, &d, 1, 0);
    }
    assert_eq!(w.next_runnable_after(None).as_ref(), Some(&a), "无游标 = 从头");
    assert_eq!(w.next_runnable_after(Some(&a)).as_ref(), Some(&b), "游标之后的下一个");
    assert_eq!(w.next_runnable_after(Some(&c)).as_ref(), Some(&a), "尾后回头(绕圈)");
    // B 被另一条腿武装了:跳过它(名单过期那条竞态由 `Occupied` 收口)。
    let held = w.work_mut(&b).unwrap().prepare_next(&conn).unwrap().ready().expect("B 有活");
    assert_eq!(w.next_runnable_after(Some(&a)).as_ref(), Some(&c), "在飞的不进候选");
    w.work_mut(&b).unwrap().rollback(held.token).expect("交回");
    assert_eq!(w.next_runnable_after(Some(&a)).as_ref(), Some(&b), "交回就又是候选");
    // 一个可跑的都没有 = `None`(消费方据此把机会让给另一类)。
    let mut empty = OpsWorks::default();
    assert_eq!(empty.next_runnable_after(None), None);
    let _ = empty.on_peer_online(&a, 0);
    assert_eq!(empty.next_runnable_after(None), None, "只发了券、没有活,不算候选");
}

/// `unknown_device` 跨代探针的三步(§6.1 八轮 H1):首次留活 → 同代不升级 →
/// **更晚一代再撞才取消**;而同 target 的正面证据一到就清标。
#[test]
fn unknown_device_probe_keeps_work_once_then_cancels_in_a_later_generation() {
    let conn = fresh_db();
    let d = oid("A");
    put(&conn, &d, 1, 1);
    let t = dev(1);
    let mut w = OpsWorks::default();
    let _ = w.on_want(&t, &d, 1, 0);
    assert_eq!(w.note_unknown(&t, 7), UnknownVerdict::Probed, "首次只记怀疑");
    assert_eq!(w.unknown_since(&t), Some(7));
    assert!(w.work_mut(&t).unwrap().has_runnable(), "工作照留 —— 顶替者重连后还要续做");
    assert_eq!(w.note_unknown(&t, 7), UnknownVerdict::Probed, "同一代的尾帧不算第二击");
    assert!(w.work_mut(&t).unwrap().has_runnable());
    assert_eq!(w.note_unknown(&t, 8), UnknownVerdict::Cancelled, "换了一代仍 unknown");
    assert!(!w.work_mut(&t).unwrap().has_runnable(), "取消 = 整份 work 换新号");
    // 正面证据清标:此后再撞 unknown 又从「首次」起算。**刻度要过了补洞冷却**
    // ——`PeerThrottle` 不随 work 取消而复位(六轮 H1 那条:节流与计划分家),
    // 同一刻再登记只会进 `deferred`,`has_runnable` 照样是假。
    let _ = w.on_want(&t, &d, 1, 100);
    w.clear_unknown(&t);
    assert_eq!(w.unknown_since(&t), None);
    assert_eq!(w.note_unknown(&t, 9), UnknownVerdict::Probed, "清过标就重新起算");
    assert!(w.work_mut(&t).unwrap().has_runnable());
    assert_eq!(w.note_unknown("MISSINGDEV0000000000000000", 9), UnknownVerdict::NoWork);
}

/// **在飞期间来了更早起点的 Want:提交不许抬过下修值**(变异对照 ⑰ 挖出)。
#[test]
fn a_lower_want_arriving_mid_flight_is_not_swallowed_by_commit() {
    let conn = fresh_db();
    let d = oid("A");
    for seq in 1..=80i64 {
        put(&conn, &d, seq, 1);
    }
    let mut w = OpsWorks::default();
    let _ = w.on_want(T, &d, 50, 0);
    let p = w.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("有活");

    // 这一笔正在写出去的途中,对端又要更早的一段。
    let _ = w.on_want(T, &d, 3, 0);
    assert_eq!(w.work_mut(T).unwrap().urgent.front().unwrap().next_seq, 3, "队里的起点被下修");

    w.work_mut(T).unwrap().commit(p.token).expect("提交");
    assert_eq!(
        w.work_mut(T).unwrap().urgent.front().unwrap().next_seq,
        3,
        "提交不许把游标抬过下修值 —— 抬过去那段缺口就被吞掉了"
    );
}

/// **在飞期间本机新写的 op 不许被提交静默丢掉**(303 量出的「推送唤醒活性缺口」)。
///
/// 上一只测的镜像面:那条是「更早的起点」,这条是「更晚的后继」。`Engine::outbound`
/// 靠「段只记起点、上界由取数那一刻的水位说了算」推出「后续新写自动含在同一段里」,
/// 而那句话对**已经取过数、正在等 Ack** 的段不成立 —— 它的 `done` 是拿旧水位算的。
#[test]
fn ops_appended_while_a_gap_is_in_flight_are_not_swallowed_by_commit() {
    let conn = fresh_db();
    let me = dev(1);
    let mut w = OpsWorks::default();

    // ① 本地写了第 1 条:`outbound` 登记义务(from_seq = last_pushed + 1 = 1)。
    put(&conn, &me, 1, 8);
    assert!(w.on_want(BROADCAST, &me, 1, 0).woke, "首次登记要摇铃");

    // ② 权威完成腿取走这一帧(读到当下水位 = 1),发出去等 relay 的 Ack。
    let p = w.work_mut(BROADCAST).unwrap().prepare_next(&conn).unwrap().ready().expect("有帧");
    assert_eq!(p.frame.as_ref().unwrap().ops.len(), 1);

    // ③ Ack 还没回来,本地又写了第 2 条 —— `outbound` 拿它去登记,随后把内存游标
    //    `last_pushed` 推到 2(「已经登记过了」)。
    put(&conn, &me, 2, 8);
    let a = w.on_want(BROADCAST, &me, 2, 0);
    assert_eq!(a.admit, Admit::Ok);

    // ④ Ack 到:提交第 1 帧。
    w.work_mut(BROADCAST).unwrap().commit(p.token).expect("提交");

    // ⑤ 第 2 条的义务还在不在。
    assert!(
        !w.idle_runnable_targets().is_empty(),
        "在飞期间登记的后继被提交丢掉了 —— 没有任何续做所有者会回来取它"
    );
    assert_eq!(
        drain(&conn, w.work_mut(BROADCAST).unwrap()),
        vec![(me.clone(), 2)],
        "第 2 条应当仍会被供出去"
    );
    // 下界也要断(不然「段永不退役」这种改法也照样绿):抽干之后 work 必须真空掉,
    // 否则 64 格里的墓碑回收不掉、`has_runnable` 恒真 = 每拍白摸一次库。
    assert!(w.idle_runnable_targets().is_empty(), "供完之后段必须退役");
}

/// **对账在飞期间的低位 Want 必须走快车道**(实现审 H3)。
///
/// 只看已提交游标的话:`ReconcileSeek` 已武装未提交时,低位 Want 会去下修计划水位图,
/// 而随后那一笔提交把游标推过该 origin —— 那段缺口被**静默吞掉**。
#[test]
fn a_low_want_during_an_in_flight_seek_goes_to_the_fast_lane() {
    let conn = fresh_db();
    let d = dev(1);
    for seq in 1..=150i64 {
        put(&conn, &d, seq, 1);
    }
    let snap = max_rowid(&conn);
    let mut w = OpsWorks::default();
    // 对端说它有 100 条 → 这一笔从 101 起。
    let _ = w.on_hello(T, vet_watermarks(wm(&[(&d, 100)])).unwrap(), snap, 0);
    let p = w.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("有活");
    assert_eq!(p.frame.as_ref().unwrap().ops.first().unwrap().origin_seq, 101);

    // 帧还没提交,对端说「其实我从 1 就缺」。
    assert_eq!(w.on_want(T, &d, 1, 0).admit, Admit::Ok);
    {
        let work = w.work_mut(T).unwrap();
        assert_eq!(work.urgent.len(), 1, "在飞前沿已经越过它 —— 必须进快车道");
        assert_eq!(work.urgent[0].next_seq, 1);
    }
    w.work_mut(T).unwrap().commit(p.token).expect("提交");

    let got = drain(&conn, w.work_mut(T).unwrap());
    for seq in 1..=100i64 {
        assert!(got.contains(&(d.clone(), seq)), "第 {seq} 条不许被吞掉");
    }
}

// ---- 容量、墓碑与预算 ------------------------------------------------------------

/// 计划走完就**自己释放**,槽位才回收得掉(实现审 H5:原来要测试手工清 active)。
#[test]
fn a_finished_plan_releases_itself_so_the_slot_can_be_reclaimed() {
    let conn = fresh_db();
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[]), SNAP, 0);
    drain(&conn, w.work_mut(T).unwrap());
    assert!(w.work_mut(T).unwrap().active.is_none(), "空库:计划一趟走完并当场释放");

    let _ = w.on_tick(1, SNAP);
    assert_eq!(w.len(), 1, "冷却没到,墓碑必须留着");
    let _ = w.on_tick(RECONCILE_COOLDOWN_TICKS, SNAP);
    assert_eq!(w.len(), 0, "两档都到期且无 bypass → 整条回收");
}

/// 满额:先回收到期墓碑,再驱逐最旧的纯墓碑;全是真实工作则响亮 overload。
#[test]
fn full_table_evicts_tombstones_then_reports_overload() {
    let mut w = OpsWorks::default();
    for i in 0..OPS_TARGET_MAX {
        let _ = w.on_want(&dev(i), &oid("A"), 1, 0);
    }
    assert_eq!(w.len(), OPS_TARGET_MAX);
    let newcomer = dev(OPS_TARGET_MAX + 1);
    assert_eq!(
        w.on_want(&newcomer, &oid("A"), 1, 0).admit,
        Admit::Overload,
        "全是真实工作 → 响亮拒绝"
    );
    assert_eq!(w.len(), OPS_TARGET_MAX, "绝不建第 65 项、也不留旁表状态");
    assert!(w.throttle(&newcomer).is_none());

    let victim = dev(0);
    w.work_mut(&victim).unwrap().urgent.clear();
    assert_eq!(w.on_want(&newcomer, &oid("A"), 1, 0).admit, Admit::Ok);
    assert_eq!(w.len(), OPS_TARGET_MAX);
    assert!(w.throttle(&victim).is_none(), "最旧的纯墓碑被驱逐");
    assert!(w.throttle(&newcomer).is_some());
}

/// per-target 与聚合两道水位预算:超限折叠成常量大小,且**只折本次增长的那个**。
#[test]
fn watermark_budgets_collapse_the_growing_target_only() {
    // 用钉死字节数的伪造凭据:这只测的是**预算算术**,真去造 64 KiB 的图要上千条。
    let heavy = |bytes: usize| VettedWatermarks::forged(wm(&[(&oid("A"), 1)]), bytes);
    let mut w = OpsWorks::default();
    assert_eq!(
        w.on_hello(T, heavy(OPS_WATERMARK_BYTES_PER_TARGET + 1), SNAP, 0).admit,
        Admit::Collapsed
    );
    assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().kind, PlanKind::Full);

    // 聚合额度恰好 = 16 × per-target。前 16 台各占满额度仍全部 Ok,第 17 台顶破。
    let mut w2 = OpsWorks::default();
    let full = OPS_WATERMARK_BYTES_PER_TARGET;
    let seats = OPS_WATERMARK_BYTES_AGGREGATE / full;
    for i in 0..seats {
        assert_eq!(w2.on_hello(&dev(i), heavy(full), SNAP, 0).admit, Admit::Ok, "第 {i} 台还在额度内");
    }
    let last = dev(seats + 1);
    assert_eq!(
        w2.on_hello(&last, VettedWatermarks::forged(wm(&[(&oid("B"), 1)]), full), SNAP, 0).admit,
        Admit::Collapsed
    );
    assert!(
        matches!(
            w2.work_mut(&dev(0)).unwrap().active.as_ref().unwrap().kind,
            PlanKind::Detailed { .. }
        ),
        "先到的那些是无辜的,不许替本次增长者挨降级"
    );
    assert_eq!(w2.work_mut(&last).unwrap().active.as_ref().unwrap().kind, PlanKind::Full);
}

/// **预算算的是该 target 保留的全部**(active + pending;实现审 H4 第二层)。
/// 原先只把「本次那份新 kind」当它的占用,而冷却内两份都留着。
#[test]
fn the_budget_counts_the_pending_plan_the_target_still_holds() {
    let full = OPS_WATERMARK_BYTES_PER_TARGET;
    let heavy = || VettedWatermarks::forged(wm(&[(&oid("A"), 1)]), full);
    let mut w = OpsWorks::default();
    assert_eq!(w.on_hello(T, heavy(), SNAP, 0).admit, Admit::Ok, "一份满额:恰好在额度内");
    assert_eq!(
        w.on_hello(T, heavy(), SNAP, 1).admit,
        Admit::Collapsed,
        "冷却内再来一份满额 = 该 target 留着两份,必须降级"
    );
    assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().kind, PlanKind::Full);
    assert_eq!(w.work_mut(T).unwrap().pending.as_ref().unwrap().kind, PlanKind::Full);
}

/// **Want 下修起点也得过预算**(实现审 H4 第一层):原先这条路既不更新 `bytes`
/// 也不校验,单 target 能用无限多个伪造 origin 把活动计划的水位图撑到无界。
#[test]
fn wants_cannot_grow_the_active_watermark_map_past_the_budget() {
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[("A", 5)]), SNAP, 0);
    // 计划游标停在起点,故这些 origin 全落在「未扫部分」→ 走下修那条路。
    let mut collapsed = false;
    for i in 0..4000usize {
        if w.on_want(T, &dev(i), 3, 0).admit == Admit::Collapsed {
            collapsed = true;
            break;
        }
    }
    assert!(collapsed, "撑到预算就必须降级,而不是一直长");
    let work = w.work_mut(T).unwrap();
    assert_eq!(work.active.as_ref().unwrap().kind, PlanKind::Full, "降级成常量大小");
    assert!(work.watermark_bytes() <= OPS_WATERMARK_BYTES_PER_TARGET);
    assert_eq!(
        work.active.as_ref().unwrap().cursor,
        ReconcileCursor::Start,
        "降级保留游标与快照 —— 已扫过的部分不重来"
    );
}

/// Want 命中「计划还没扫到的 origin」时只下修起点,不新开段。
#[test]
fn want_before_the_cursor_only_lowers_the_plan_start() {
    let conn = fresh_db();
    for seq in 1..=2i64 {
        put(&conn, &oid("M"), seq, 1);
    }
    put(&conn, &oid("Z"), 1, 1);
    let snap = max_rowid(&conn);
    let mut w = OpsWorks::default();
    // M 缺席(按 0)故这一趟先供 M;Z 报 9 高于本机水位,轮到它时无可供。
    let _ = w.on_hello(T, vw(&[("Z", 9)]), snap, 0);
    step(&conn, w.work_mut(T).unwrap()).expect("先供 M");
    assert!(w.work_mut(T).unwrap().plan_frontier_passed(&oid("M")), "M 已被扫过");
    assert!(!w.work_mut(T).unwrap().plan_frontier_passed(&oid("Z")), "Z 还没轮到");

    assert_eq!(w.on_want(T, &oid("Z"), 3, 0).admit, Admit::Ok);
    assert!(w.work_mut(T).unwrap().urgent.is_empty(), "Z 还没扫到 —— 不该新开段");
    assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().start_seq(&oid("Z")), Some(3));

    assert_eq!(w.on_want(T, &oid("M"), 3, 0).admit, Admit::Ok);
    assert_eq!(w.work_mut(T).unwrap().urgent.len(), 1);
    assert_eq!(w.work_mut(T).unwrap().urgent[0].origin, oid("M"));
}

/// 折叠态与缺席都按 0 → 起点回 1;**合法的 `i64::MAX` 水位不许溢出**(实现审 M2)。
#[test]
fn absent_or_full_means_start_from_one_and_max_never_overflows() {
    let p = plan_with(
        PlanKind::Detailed { peer: wm(&[("A", 4), ("MAXED", i64::MAX)]), bytes: 8 },
        ReconcileCursor::Start,
        SNAP,
    );
    assert_eq!(p.start_seq("A"), Some(5));
    assert_eq!(p.start_seq("NOPE"), Some(1), "缺席按 0");
    assert_eq!(p.start_seq("MAXED"), None, "MAX = 这个 origin 没有可欠的后继,跳过");

    let f = plan_with(PlanKind::Full, ReconcileCursor::Start, SNAP);
    assert_eq!(f.start_seq("A"), Some(1), "折叠态全量重扫");
}

/// 出站 Hello 的轮转游标住在**同一张 64 表**里(实现审 M1:§10 禁旁表)。
#[test]
fn hello_cursors_live_in_the_same_bounded_table() {
    let mut w = OpsWorks::default();
    assert!(w.hello_cursor(BROADCAST, 0).is_some(), "BROADCAST 也占一格");
    assert_eq!(w.len(), 1);
    w.hello_cursor(&dev(1), 0).unwrap().after = Some(dev(9));
    assert_eq!(w.len(), 2, "每个逻辑目的地一枚,且都由这张表持有");
    assert_eq!(w.hello_cursor(&dev(1), 0).unwrap().after.as_deref(), Some(dev(9).as_str()));

    let mut full = OpsWorks::default();
    for i in 0..OPS_TARGET_MAX {
        let _ = full.on_want(&dev(i), &oid("A"), 1, 0);
    }
    assert!(full.hello_cursor(&dev(999), 0).is_none(), "满额时不许偷偷建第 65 格");
}

/// 逻辑目的地的合法域 = `BROADCAST` ∪ 规范设备 id(实现审 L2)。
#[test]
fn target_domain_is_broadcast_or_a_canonical_device_id() {
    let mut w = OpsWorks::default();
    assert_eq!(w.on_want("nope", &oid("A"), 1, 0).admit, Admit::Malformed);
    assert_eq!(w.on_hello("nope", vw(&[]), SNAP, 0).admit, Admit::Malformed);
    assert_eq!(w.on_peer_online("nope", 0).admit, Admit::Malformed);
    assert!(w.hello_cursor("nope", 0).is_none());
    assert_eq!(w.len(), 0, "不合形连条目都不建");

    assert_eq!(w.on_hello(BROADCAST, vw(&[]), SNAP, 0).admit, Admit::Ok, "本机 outbound 那份 work");
    assert_eq!(w.on_want(&dev(1), &oid("A"), 1, 0).admit, Admit::Ok);
}

/// `Want` 的 origin 与 `from_seq` 也得过形态闸:origin 在新形里是要**存进**补洞队列的
/// (今天 `on_want` 查完水位就丢,故只校验 `from_seq`)。
#[test]
fn a_malformed_want_is_refused_without_leaving_a_trace() {
    let mut w = OpsWorks::default();
    assert_eq!(w.on_want(T, "A", 1, 0).admit, Admit::Malformed);
    assert_eq!(w.on_want(T, &"Z".repeat(4096), 1, 0).admit, Admit::Malformed, "长 origin 是留存面");
    assert_eq!(w.on_want(T, &oid("A"), 0, 0).admit, Admit::Malformed, "from_seq 必须 ≥1");
    assert_eq!(w.on_want(T, &oid("A"), i64::MIN, 0).admit, Admit::Malformed, "否则下修起点会溢出");
    assert_eq!(w.len(), 0, "不合形的请求不许把 target 条目也带出来");

    assert_eq!(w.on_want(T, &oid("A"), 1, 0).admit, Admit::Ok);
    assert_eq!(w.work_mut(T).unwrap().urgent.len(), 1);
}

/// **轮转游标必须跨心跳存活**(实现审二轮 H1)。
///
/// Hello 之间**必经心跳**;心跳无条件抹掉游标的话,每一枚 Hello 都从表头开始,
/// 预算外那半区**永远报不出去**。而 origin 数是历史 oplog 的 origin 总数,不受
/// 「当前支持拓扑」限制 —— 这不是够不着的角落。
#[test]
fn a_rotation_cursor_survives_the_heartbeat_between_two_hellos() {
    let conn = fresh_db();
    let n = 6usize;
    for i in 1..=n {
        put(&conn, &dev(i), 1, 1);
    }
    // 预算只放得下 3 条:每枚 Hello 必留游标。
    let three: BTreeMap<String, i64> = (1..=3usize).map(|i| (dev(i), 1i64)).collect();
    let budget = watermark_map_bytes(&three);

    let mut w = OpsWorks::default();
    let first = {
        let cur = w.hello_cursor(BROADCAST, 0).expect("拿得到游标");
        bounded_watermarks(&conn, cur, budget).unwrap()
    };
    assert_eq!(first.len(), 3);

    // 两枚 Hello 之间跑一趟心跳 —— 冷却早过、也没有任何 ops 工作。
    let _ = w.on_tick(RECONCILE_COOLDOWN_TICKS * 10, SNAP);
    assert_eq!(w.len(), 1, "带着未走完游标的条目不许被日常心跳回收");

    let second = {
        let cur = w.hello_cursor(BROADCAST, RECONCILE_COOLDOWN_TICKS * 10).expect("游标还在");
        bounded_watermarks(&conn, cur, budget).unwrap()
    };
    assert!(
        second.keys().all(|k| !first.contains_key(k)),
        "第二枚必须接着上一枚往下报,而不是又从表头来一遍:{first:?} vs {second:?}"
    );

    // 游标走完一圈自己复位之后,墓碑照旧该回收 —— 不是把条目永久钉住。
    let all: BTreeMap<String, i64> = (1..=n).map(|i| (dev(i), 1i64)).collect();
    let big = watermark_map_bytes(&all);
    let cur = w.hello_cursor(BROADCAST, 0).unwrap();
    bounded_watermarks(&conn, cur, big).unwrap();
    assert!(cur.after.is_none(), "装得下 → 游标复位");
    let _ = w.on_tick(RECONCILE_COOLDOWN_TICKS * 20, SNAP);
    assert_eq!(w.len(), 0, "游标复位之后,纯墓碑照旧回收");
}

/// **进折叠态之后,新 Want 只能被全量重扫吸收**(实现审二轮 H2)。
///
/// 少了这条,Range 洪水把 target 打进折叠态之后**还能接着吃 Range 那一档的快车道**,
/// 「资源超限从 30s 档退化到 60s 档」这条有界降级就成了空话。
#[test]
fn once_collapsed_new_wants_are_absorbed_by_the_full_rescan() {
    let mut w = OpsWorks::default();
    for i in 0..=OPS_RANGES_PER_TARGET as i64 {
        let _ = w.on_want(T, &oid(&format!("N{i:02}")), 1, i as u64 * RANGE_COOLDOWN_TICKS);
    }
    assert_eq!(
        w.work_mut(T).unwrap().pending.as_ref().unwrap().kind,
        PlanKind::Full,
        "先得真进折叠态"
    );
    assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0);

    // 折叠之后再来的 Want:一条段都不许重开,计划水位图也不许被下修。
    let tick = OPS_RANGES_PER_TARGET as u64 * RANGE_COOLDOWN_TICKS + 99;
    assert_eq!(w.on_want(T, &oid("ZZ"), 1, tick).admit, Admit::Ok);
    assert_eq!(w.on_want(T, &oid("YY"), 1, tick + 1).admit, Admit::Ok);
    assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0, "折叠态里新 Want 只能维持标记");
    assert_eq!(w.work_mut(T).unwrap().pending.as_ref().unwrap().kind, PlanKind::Full);
}

/// **折叠那道闸必须在「下修活动计划」之前**(实现审三轮 L2)。
///
/// 上一只测是在「没有 active、只有 pending Full」的状态下跑的 —— 把闸挪到下修之后
/// 它照样绿。这一只专测另一半:活动计划还在跑、pending 已是 Full 时,一枚命中
/// **未扫部分**的 Want(那条「便宜的下修」)也必须被挡住 —— 那份义务已由 Full
/// 整个覆盖(`pending Full` 启动时会取当时的新快照、从头覆盖全部 origin),
/// 继续下修只是把细粒度账又攒回来。
#[test]
fn the_collapse_gate_also_blocks_the_cheap_lowering_of_a_running_plan() {
    let conn = fresh_db();
    put(&conn, &oid("N5"), 1, 1);
    let snap = max_rowid(&conn);
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[]), snap, 0);
    step(&conn, w.work_mut(T).unwrap()).expect("先供一帧,游标停在 N5 之后");

    // 用「已扫过的那一侧」的 origin 灌满补洞段,把 target 打进折叠态;
    // 活动计划本身不受影响(collapse_gaps 不碰 active)。
    for i in 0..=OPS_RANGES_PER_TARGET as i64 {
        let _ = w.on_want(T, &oid(&format!("A{i:02}")), 1, i as u64 * RANGE_COOLDOWN_TICKS);
    }
    let work = w.work_mut(T).unwrap();
    assert_eq!(work.pending.as_ref().unwrap().kind, PlanKind::Full, "已进折叠态");
    let plan_before = work.active.clone().expect("活动计划还在跑");
    assert!(matches!(plan_before.kind, PlanKind::Detailed { .. }), "而且还是细粒度的");

    // 这枚 Want 命中**未扫部分**(Z9 排在游标之后),照旧走「下修起点」那条便宜路。
    let probe = oid("Z9");
    assert!(!w.work_mut(T).unwrap().plan_frontier_passed(&probe), "确实还没扫到它");
    assert_eq!(w.on_want(T, &probe, 3, 999).admit, Admit::Ok);
    assert_eq!(
        w.work_mut(T).unwrap().active.as_ref().unwrap(),
        &plan_before,
        "折叠态里连便宜的下修都得挡住 —— 水位图 / 字节数 / 游标 / 快照一格都不许动"
    );
    assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0, "更不许重开段");
}

/// 心跳把冷却里登记的补洞义务**真提成可跑工作**(第②笔实现审 H2)。
///
/// 判据从「`on_tick` 交出的名单」改成 [`OpsWorks::idle_runnable_targets`](二轮 L1 撤掉
/// 了那份没人消费的名单):**要守的规则一个字没变** —— 冷却到点是本模块自己把义务变成
/// 可跑工作的那一刻,而协调者每一拍正是拿这一格去扫「谁该被叫醒」。少了那一步,登记的
/// 段就一直没人来取。
#[test]
fn the_heartbeat_promotes_a_deferred_range_into_runnable_work() {
    let conn = fresh_db();
    let mut w = OpsWorks::default();
    // 第一枚 Want 立即进快车道并起 30s 冷却;第二枚落进冷却期,只登记不开工。
    assert_eq!(w.on_want(T, &oid("A1"), 1, 0).admit, Admit::Ok);
    assert_eq!(w.on_want(T, &oid("A2"), 1, 0).admit, Admit::Ok);

    // 把快车道那一段供空(库里没有这个 origin 的行 → 一次空转就出队)。
    let work = w.work_mut(T).expect("有条目");
    let p = work.prepare_next(&conn).expect("取数").ready().expect("有段");
    assert!(p.frame.is_none(), "库里没这个 origin 的行 → 空转");
    work.commit(p.token).expect("空转照样提交");
    assert!(w.work_mut(T).expect("有条目").prepare_next(&conn).expect("取数").ready().is_none());
    assert!(w.idle_runnable_targets().is_empty(), "登记那一段还压在冷却里,此刻没活可取");

    // 冷却到点:登记的那一段被放行 —— 这一刻它必须变成「有人来取就取得到」。
    w.on_tick(RANGE_COOLDOWN_TICKS, SNAP);
    assert_eq!(w.idle_runnable_targets(), vec![T.to_string()]);
}

/// 同一条规则的**另一半**(第②笔实现审二轮 M2):`on_tick` 还会把 pending 开成活动
/// 计划,那一刻同样是「本来没活、现在有活」。只提 Range、漏了 Reconcile 启动的实现
/// 照样能让上一只测绿 —— 而漏掉的正是全量追赶那一路。
#[test]
fn the_heartbeat_also_starts_a_pending_reconcile() {
    let conn = fresh_db();
    let mut w = OpsWorks::default();
    // 首枚 Hello 立即开计划;库是空的,一回合就扫完(active 当场释放)。
    assert_eq!(w.on_hello(T, vw(&[("A1", 0)]), SNAP, 0).admit, Admit::Ok);
    let work = w.work_mut(T).expect("有条目");
    let p = work.prepare_next(&conn).expect("取数").ready().expect("有计划");
    assert!(p.frame.is_none(), "空库 → 一回合扫完");
    work.commit(p.token).expect("提交");
    assert!(w.work_mut(T).expect("有条目").prepare_next(&conn).expect("取数").ready().is_none());

    // 第二枚 Hello 落在对账冷却里 → 只进 pending,此刻没活。
    assert_eq!(w.on_hello(T, vw(&[("A1", 0)]), SNAP, 0).admit, Admit::Ok);
    w.on_tick(0, SNAP);
    assert!(w.idle_runnable_targets().is_empty(), "还在冷却里,没有新工作可跑");
    // 冷却到点:pending 开成活动计划 —— 这一刻它必须变成可跑。
    w.on_tick(RECONCILE_COOLDOWN_TICKS, SNAP);
    assert_eq!(w.idle_runnable_targets(), vec![T.to_string()]);
}

/// 两根发号器都得是**不回绕**的加法(注释是这么承诺的)。2^64 次造不出行为测,
/// 故按位置钉结构锚:生产段里两处自增都必须走 checked。
#[test]
fn both_token_counters_are_checked_not_wrapping() {
    let src = include_str!("../ops_serve.rs");
    // 切点认的是**测试模块**,不是「第一处 `#[cfg(test)]`」:生产段里本就允许有
    // `#[cfg(test)]` 的测试探针(第②笔加 `inflight_armed` 时这只锚当场变绿了——切完
    // 只剩前 300 行,两处 checked 一处都不在里面)。锚点会随修法失效,这是第二例
    // (275 记的是变异 plan 的锚)。
    let prod = src.split("\nmod tests {").next().expect("切到测试模块之前");
    assert!(prod.contains("seq.checked_add(1)"), "凭据号必须 checked");
    assert!(prod.contains("|n| n.checked_add(1)"), "work 身份号必须 checked");
    assert!(!prod.contains("self.next_token += 1"), "裸加会绕");
    assert!(!prod.contains("NEXT_WORK_ID.fetch_add"), "裸 fetch_add 会绕");
}

/// **凭据跨 `OpsWorks` 也不许通用**(实现审二轮 M1):每空间一份的发号器会让两个
/// 空间的第一份 work 都拿到 0,A 的第一枚凭据正好提交 B 的第一笔。
#[test]
fn a_token_from_another_space_cannot_commit_either() {
    let conn = fresh_db();
    let d = oid("A");
    for seq in 1..=4i64 {
        put(&conn, &d, seq, 1);
    }
    let mut a = OpsWorks::default();
    let mut b = OpsWorks::default();
    let _ = a.on_want(T, &d, 1, 0);
    let _ = b.on_want(T, &d, 3, 0);

    let pa = a.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("A 有活");
    let pb = b.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("B 有活");
    assert!(b.work_mut(T).unwrap().commit(pa.token).is_err(), "跨空间的凭据提交不了");
    assert_eq!(b.work_mut(T).unwrap().urgent.front().unwrap().next_seq, 3, "B 一步没动");
    b.work_mut(T).unwrap().commit(pb.token).expect("B 自己的照常");
}

/// **迟到的失败事件不许清掉新的在飞笔**(实现审二轮 M1 的另一半)。
#[test]
fn a_stale_rollback_cannot_clear_a_newer_inflight() {
    let conn = fresh_db();
    let d = oid("A");
    for seq in 1..=4i64 {
        put(&conn, &d, seq, 1);
    }
    let mut w = OpsWorks::default();
    let _ = w.on_want(T, &d, 1, 0);
    let work = w.work_mut(T).unwrap();

    let stale = work.prepare_next(&conn).unwrap().ready().expect("第一笔").token;
    work.rollback(stale).expect("它自己回滚得掉");
    let fresh = work.prepare_next(&conn).unwrap().ready().expect("第二笔");
    // 上一笔的失败回执迟到了 —— 它已经被吃掉,构造不出第二枚;拿别人的也不行。
    let alien = w.work_mut("01OTHERTARGETAAAAAAAAAAAAA");
    assert!(alien.is_none(), "没建过的 target 没有 work");
    let other = dev(3);
    let _ = w.on_want(&other, &d, 1, 0);
    let other_tok = w.work_mut(&other).unwrap().prepare_next(&conn).unwrap().ready().unwrap().token;
    assert!(w.work_mut(T).unwrap().rollback(other_tok).is_err(), "别人的凭据回滚不了这笔");
    assert!(w.work_mut(T).unwrap().inflight.is_some(), "在飞那一笔必须还在");
    w.work_mut(T).unwrap().commit(fresh.token).expect("正确凭据照常提交");
}

/// 折叠**保留游标**:活动计划从细粒度变全量重扫之后,已扫过的部分不重来
/// (实现审二轮 L2 —— 原来那只预算测的游标本来就在起点,证伪不了「顺手重置」)。
#[test]
fn collapsing_watermarks_keeps_the_cursor_where_it_was() {
    let conn = fresh_db();
    for i in 1..=3usize {
        put(&conn, &dev(i), 1, 1);
    }
    let snap = max_rowid(&conn);
    let mut w = OpsWorks::default();
    let _ = w.on_hello(T, vw(&[]), snap, 0);
    step(&conn, w.work_mut(T).unwrap()).expect("先供一帧,游标离开起点");
    let cursor = w.work_mut(T).unwrap().active.as_ref().unwrap().cursor.clone();
    assert_ne!(cursor, ReconcileCursor::Start);

    // 冷却内再来一枚满额 Hello:该 target 留着两份 → 撞预算 → 折叠。
    let full = OPS_WATERMARK_BYTES_PER_TARGET;
    assert_eq!(
        w.on_hello(T, VettedWatermarks::forged(wm(&[(&oid("A"), 1)]), full * 2), snap, 1).admit,
        Admit::Collapsed
    );
    let p = w.work_mut(T).unwrap().active.as_ref().unwrap();
    assert_eq!(p.kind, PlanKind::Full, "降级成常量大小");
    assert_eq!(p.cursor, cursor, "游标原地不动 —— 已扫过的部分不许重来");
    assert_eq!(p.snapshot_rowid, snap, "快照也不动");
}

/// 一直在用的轮转游标**不该第一个被挤掉**(实现审二轮 H1 的另一半)。
///
/// 满额驱逐挑的是「最旧的、没有 ops 工作的」那个,而只握着游标的条目正是这种。
/// 取用时不刷 `last_touch` 的话,它永远停在建条目那一刻 —— 一枚**天天在用**的
/// 广播游标会输给一枚**建完就没碰过**的。
#[test]
fn an_actively_used_hello_cursor_is_not_the_first_to_be_evicted() {
    let mut w = OpsWorks::default();
    // 两枚都在轮转中途(游标非空,故不是能被日常心跳回收的纯墓碑)。
    w.hello_cursor(&dev(1), 0).unwrap().after = Some(dev(9));
    w.hello_cursor(&dev(2), 0).unwrap().after = Some(dev(9));
    for i in 3..=OPS_TARGET_MAX {
        let _ = w.on_want(&dev(i), &oid("A"), 1, 0);
    }
    assert_eq!(w.len(), OPS_TARGET_MAX, "表满,且只有那两枚没有 ops 工作");

    w.hello_cursor(&dev(1), 5); // 1 号的游标又用了一次
    let _ = w.on_want(&dev(OPS_TARGET_MAX + 5), &oid("A"), 1, 5);
    assert!(w.throttle(&dev(1)).is_some(), "一直在用的那枚不该第一个被挤掉");
    assert!(w.throttle(&dev(2)).is_none(), "最旧的那枚才是");
}

/// 在飞的补洞帧撞上折叠:提交时队头已经没了,**什么都不该做**(义务已由 Full 接管)。
#[test]
fn a_gap_frame_in_flight_when_the_queue_collapses_commits_into_nothing() {
    let conn = fresh_db();
    let d = oid("N00");
    // **这一段必须发不完**(> 一帧):供完的段本来就不会被塞回队列,那样这只测
    // 分辨不出「队头没了就什么都不做」和「随便造一条塞回去」。
    for seq in 1..=(MAX_OPS_PER_FRAME as i64 + 1) {
        put(&conn, &d, seq, 1);
    }
    let mut w = OpsWorks::default();
    let _ = w.on_want(T, &d, 1, 0);
    let p = w.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("有活");

    // 这一笔还在飞,补洞段被 Range 洪水折叠掉。
    for i in 1..=OPS_RANGES_PER_TARGET as i64 {
        let _ = w.on_want(T, &oid(&format!("M{i:02}")), 1, i as u64 * RANGE_COOLDOWN_TICKS);
    }
    assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0, "两队都被清空");

    w.work_mut(T).unwrap().commit(p.token).expect("提交照样成功");
    let work = w.work_mut(T).unwrap();
    assert_eq!(work.gaps_len(), 0, "不许把被折叠掉的段又塞回来");
    assert_eq!(work.pending.as_ref().unwrap().kind, PlanKind::Full, "义务归全量重扫");
}

// ---- 取数:SQL keyset 逐帧惰性取 ----------------------------------------------

/// 一次调用**至多一枚帧**,条数尺封住它;剩下的由下一枚游标接着走,不重不漏。
#[test]
fn one_call_serves_exactly_one_frame_and_the_count_limit_bounds_it() {
    let conn = fresh_db();
    let d = dev(1);
    let total = MAX_OPS_PER_FRAME as i64 + 100;
    for seq in 1..=total {
        put(&conn, &d, seq, 1);
    }

    let served = read_gap(&conn, &d, 1).unwrap();
    let f = served.frame.expect("有得发");
    assert_eq!(f.ops.len(), MAX_OPS_PER_FRAME, "一帧至多 500 条 —— 不是「有多少发多少」");
    assert_eq!(f.ops.first().unwrap().origin_seq, 1);
    assert_eq!(f.ops.last().unwrap().origin_seq, MAX_OPS_PER_FRAME as i64);
    assert_eq!(
        served.advance,
        Advance::RangeAt { next_seq: MAX_OPS_PER_FRAME as i64 + 1 },
        "取满一整帧不敢说供完了"
    );

    let served2 = read_gap(&conn, &d, MAX_OPS_PER_FRAME as i64 + 1).unwrap();
    assert_eq!(served2.frame.expect("尾巴还在").ops.len(), 100);
    assert_eq!(
        served2.advance,
        Advance::RangeAt { next_seq: total + 1 },
        "读到尾也只推进、不退役(305):这一帧要过一个中转往返才提交,\
         那期间新写的 op 会被合并进这一段"
    );
}

/// 字节尺:大 op 独占一帧,且 `bytes` 报的是**真实天花板**——消费方就靠它跟自己那条
/// 腿的 wire 上限比大小(§10 六轮 M4:「每帧 ≤256 KiB」的记账不实)。
#[test]
fn an_oversized_op_takes_a_frame_alone_and_bytes_reports_the_real_ceiling() {
    let conn = fresh_db();
    let d = dev(1);
    for seq in 1..=3i64 {
        put(&conn, &d, seq, 150_000);
    }
    let served = read_gap(&conn, &d, 1).unwrap();
    let f = served.frame.unwrap();
    assert_eq!(f.ops.len(), 1, "两条同帧就超 256 KiB → 一条一帧");
    assert!(
        f.bytes > MAX_OPS_FRAME_BYTES / 2,
        "bytes 必须报真实体量(实得 {}),不然消费方无从判「这一帧封不封得下」",
        f.bytes
    );
    assert_eq!(served.advance, Advance::RangeAt { next_seq: 2 });
}

/// 固定快照:开计划之后新写入的行**这一轮一条都不供**(六轮 H1 —— 不然持续新增的
/// origin 能让计划永远跑不完)。阴性对照:快照 0 时枚举返回空。
#[test]
fn the_snapshot_boundary_excludes_rows_written_after_the_plan_opened() {
    let conn = fresh_db();
    let d = dev(1);
    for seq in 1..=3i64 {
        put(&conn, &d, seq, 1);
    }
    let snap = max_rowid(&conn);
    for seq in 4..=6i64 {
        put(&conn, &d, seq, 1);
    }

    let plan = plan_with(PlanKind::Full, ReconcileCursor::Start, snap);
    let spec = FrameSpec::ReconcileSeek { after: None };
    let f = read_reconcile(&conn, &spec, &plan).unwrap().frame.expect("快照内有得发");
    assert_eq!(
        f.ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "快照之后写入的 4/5/6 不属于这一轮"
    );

    let empty = plan_with(PlanKind::Full, ReconcileCursor::Start, 0);
    let served = read_reconcile(&conn, &spec, &empty).unwrap();
    assert!(served.frame.is_none());
    assert_eq!(served.advance, Advance::ReconcileDone, "快照 0 = 一行都不在范围内");
}

/// 对账枚举:跳过对端已齐的 origin、按 `start_seq` 定起点、扫完回 `ReconcileDone`。
#[test]
fn reconcile_seek_skips_origins_the_peer_already_has() {
    let conn = fresh_db();
    for i in 1..=3usize {
        for seq in 1..=4i64 {
            put(&conn, &dev(i), seq, 1);
        }
    }
    let snap = max_rowid(&conn);
    // 对端在 1、2 上已齐,在 3 上落后两条。
    let peer = wm(&[(&dev(1), 4), (&dev(2), 4), (&dev(3), 2)]);
    let bytes = watermark_map_bytes(&peer);
    let plan = plan_with(PlanKind::Detailed { peer, bytes }, ReconcileCursor::Start, snap);

    let served = read_reconcile(&conn, &FrameSpec::ReconcileSeek { after: None }, &plan).unwrap();
    let f = served.frame.expect("3 号还欠着");
    assert_eq!(f.origin, dev(3), "1、2 已齐 —— 一枚帧都不该为它们发");
    assert_eq!(
        f.ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>(),
        vec![3, 4],
        "起点 = 对端水位 + 1"
    );
    assert_eq!(served.advance, Advance::ReconcileAfter { origin: dev(3) });

    let after3 = FrameSpec::ReconcileSeek { after: Some(dev(3)) };
    let done = read_reconcile(&conn, &after3, &plan).unwrap();
    assert!(done.frame.is_none());
    assert_eq!(done.advance, Advance::ReconcileDone);
}

/// 单次取数的跳过预算:一大片「对端已齐」的 origin 不许一次跑完(那又是「单次输入
/// 的工作量由数据规模说了算」),但游标**必须**前进,故计划仍必然走完。
#[test]
fn the_seek_budget_bounds_one_call_yet_the_cursor_still_advances() {
    let conn = fresh_db();
    let filler = OPS_SEEK_STEPS_PER_FRAME + 5;
    for i in 1..=filler {
        put(&conn, &dev(i), 1, 1);
    }
    let last = dev(filler + 1);
    put(&conn, &last, 1, 1);
    let snap = max_rowid(&conn);
    // 对端在前 filler 台上全齐,只差最后一台。
    let mut peer = BTreeMap::new();
    for i in 1..=filler {
        peer.insert(dev(i), 1i64);
    }
    let bytes = watermark_map_bytes(&peer);
    let plan = plan_with(PlanKind::Detailed { peer, bytes }, ReconcileCursor::Start, snap);

    let served = read_reconcile(&conn, &FrameSpec::ReconcileSeek { after: None }, &plan).unwrap();
    assert!(served.frame.is_none(), "预算内一台都没欠 —— 这一次不该发帧");
    assert_eq!(
        served.advance,
        Advance::ReconcileAfter { origin: dev(OPS_SEEK_STEPS_PER_FRAME) },
        "游标落在第 {OPS_SEEK_STEPS_PER_FRAME} 台上 —— 到限就停,但绝不原地踏步"
    );

    // 下一枚数据机会接着走,把欠的那台供出来。
    let next = FrameSpec::ReconcileSeek { after: Some(dev(OPS_SEEK_STEPS_PER_FRAME)) };
    let f = read_reconcile(&conn, &next, &plan).unwrap().frame.expect("欠的那台");
    assert_eq!(f.origin, last);
}

/// 读空的两种收场:补洞段**读空**才出队;对账 origin 已齐 = 跨过去。
#[test]
fn an_exhausted_gap_pops_and_an_exhausted_origin_is_stepped_over() {
    let conn = fresh_db();
    let d = dev(1);
    put(&conn, &d, 1, 1);
    let snap = max_rowid(&conn);

    let served = read_gap(&conn, &d, 9).unwrap();
    assert!(served.frame.is_none());
    assert_eq!(
        served.advance,
        Advance::RangeDrained,
        "要不出东西的段该出队,不许挂着占公平轮次"
    );

    let plan =
        plan_with(PlanKind::Full, ReconcileCursor::At { origin: d.clone(), next_seq: 2 }, snap);
    let at = FrameSpec::ReconcileAt { origin: d.clone(), from_seq: 2 };
    let served = read_reconcile(&conn, &at, &plan).unwrap();
    assert!(served.frame.is_none());
    assert_eq!(served.advance, Advance::ReconcileAfter { origin: d });
}

/// **M2 要的那道锚**:三条 keyset 查询必须全走 `idx_oplog_origin_seq`,不许退化成
/// 全表 `SCAN`、也不许排序落到 `TEMP B-TREE`(那样「每帧取数」就成了「每 origin
/// 重扫全表」)。设计期是在 node 的内存库上量的,这里钉的是 rusqlite bundled + 真
/// 文件库上的**当前态**。
#[test]
fn explain_query_plan_anchors_the_three_keyset_queries() {
    let conn = fresh_db();
    for i in 1..=20usize {
        for seq in 1..=20i64 {
            put(&conn, &dev(i), seq, 1);
        }
    }
    let details = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Vec<String> {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        stmt.query_map(params, |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let cases: Vec<(&str, Vec<String>)> = vec![
        (SQL_SEEK_ORIGIN, details(SQL_SEEK_ORIGIN, &[&"", &i64::MAX])),
        (
            SQL_READ_RUN,
            details(SQL_READ_RUN, &[&dev(1), &1i64, &i64::MAX, &(MAX_OPS_PER_FRAME as i64)]),
        ),
        (SQL_WATERMARK_OF, details(SQL_WATERMARK_OF, &[&dev(1)])),
    ];
    for (sql, plan) in cases {
        let joined = plan.join(" | ");
        assert!(
            joined.contains("idx_oplog_origin_seq"),
            "没走 (origin, origin_seq) 索引:{sql}\n{joined}"
        );
        assert!(!joined.contains("SCAN "), "退化成全表扫:{sql}\n{joined}");
        assert!(!joined.contains("TEMP B-TREE"), "排序落到临时表:{sql}\n{joined}");
    }
}

/// 端到端:一份带对端水位的计划 + 消费方逐帧泵,把差额**不重不漏**供完,
/// 且**一条对端已有的 op 都不重发**。
#[test]
fn a_full_catch_up_over_many_origins_serves_every_owed_op_exactly_once() {
    let conn = fresh_db();
    let origins = 40usize;
    let per = 12i64;
    for i in 1..=origins {
        for seq in 1..=per {
            put(&conn, &dev(i), seq, 1);
        }
    }
    let snap = max_rowid(&conn);
    // 奇数台已齐、偶数台落后一半。
    let mut peer = BTreeMap::new();
    let mut owed: Vec<(String, i64)> = vec![];
    for i in 1..=origins {
        let have = if i % 2 == 1 { per } else { per / 2 };
        peer.insert(dev(i), have);
        for seq in (have + 1)..=per {
            owed.push((dev(i), seq));
        }
    }
    let mut works = OpsWorks::default();
    assert_eq!(works.on_hello(T, vet_watermarks(peer).unwrap(), snap, 0).admit, Admit::Ok);
    let got = drain(&conn, works.work_mut(T).unwrap());
    assert_eq!(got, owed, "该供的一条不少、不该供的一条不多、顺序还是 origin×seq 升序");
    assert!(works.work_mut(T).unwrap().active.is_none(), "供完即释放");
}

// ---- 有界 Hello 水位图 ----------------------------------------------------------

/// 一次装得下时:与全表水位逐字一致,**游标不启用**(下一枚 Hello 一模一样)。
#[test]
fn bounded_watermarks_equals_the_full_table_when_it_fits_and_parks_the_cursor() {
    let conn = fresh_db();
    for i in 1..=5usize {
        for seq in 1..=(i as i64 + 1) {
            put(&conn, &dev(i), seq, 1);
        }
    }
    let expect: BTreeMap<String, i64> = (1..=5usize).map(|i| (dev(i), i as i64 + 1)).collect();

    let mut cur = HelloCursor::default();
    let first = bounded_watermarks(&conn, &mut cur, OPS_WATERMARK_BYTES_PER_TARGET).unwrap();
    assert_eq!(first, expect);
    assert_eq!(cur, HelloCursor::default(), "装得下就不该留轮转游标");
    let again = bounded_watermarks(&conn, &mut cur, OPS_WATERMARK_BYTES_PER_TARGET).unwrap();
    assert_eq!(again, expect, "行为与现状全表水位一致");
}

/// 预算紧时轮转:单枚 Hello 只带预算内的一段,相邻几枚**合起来覆盖全部 origin**
/// ——不轮转的话预算外那些 origin 的真实水位永远报不出去,对端每次重发同一批。
#[test]
fn a_tight_budget_rotates_across_hellos_until_every_origin_is_reported() {
    let conn = fresh_db();
    let n = 10usize;
    for i in 1..=n {
        put(&conn, &dev(i), i as i64, 1);
    }
    // 恰好装得下 3 条的预算。
    let three: BTreeMap<String, i64> = (1..=3usize).map(|i| (dev(i), i as i64)).collect();
    let budget = watermark_map_bytes(&three);

    let mut cur = HelloCursor::default();
    let mut union: BTreeMap<String, i64> = BTreeMap::new();
    let mut rounds = 0;
    while union.len() < n {
        let m = bounded_watermarks(&conn, &mut cur, budget).unwrap();
        assert!(!m.is_empty(), "每一枚 Hello 都得带点东西,否则游标不前进");
        assert!(
            watermark_map_bytes(&m) <= budget,
            "一枚 Hello 不许超预算:{} > {budget}",
            watermark_map_bytes(&m)
        );
        assert_eq!(m.len(), 3, "预算容得下 3 条就带满 3 条");
        for (k, v) in m {
            assert_eq!(*union.entry(k.clone()).or_insert(v), v);
        }
        rounds += 1;
        assert!(rounds < 20, "轮转没收敛");
    }
    let expect: BTreeMap<String, i64> = (1..=n).map(|i| (dev(i), i as i64)).collect();
    assert_eq!(union, expect, "几枚 Hello 合起来必须把每台的真实水位都报出去");
}

/// 绕满一圈就停:同一枚 Hello 里**绝不重复计**一个 origin(重复计等于预算凭空翻倍)。
#[test]
fn one_hello_never_wraps_past_its_own_starting_point() {
    let conn = fresh_db();
    for i in 1..=3usize {
        put(&conn, &dev(i), 1, 1);
    }
    let mut cur = HelloCursor::default();
    // 预算只容 1 条:第一枚带 1 号、游标停在它身上。
    let one: BTreeMap<String, i64> = [(dev(1), 1i64)].into_iter().collect();
    let m1 = bounded_watermarks(&conn, &mut cur, watermark_map_bytes(&one)).unwrap();
    assert_eq!(m1.len(), 1);
    assert_eq!(cur.after.as_deref(), Some(dev(1).as_str()));

    // 预算恰好放到 3 条:这一枚从 2 号起、绕回表头补 1 号,拿满全表就该停下。
    // **预算必须卡这么死**——放宽了的话「绕过头又数一遍」与「到点停」得到的 map
    // 一模一样(BTreeMap 把重复吸收掉了),这只测就成了空测。卡死之后两条路在
    // **游标**那一格分道:到点停 = 装得下 = 复位;绕过头 = 第 4 条撞预算 = 留游标。
    let three: BTreeMap<String, i64> = (1..=3usize).map(|i| (dev(i), 1i64)).collect();
    let m2 = bounded_watermarks(&conn, &mut cur, watermark_map_bytes(&three)).unwrap();
    assert_eq!(m2.len(), 3, "绕一圈恰好覆盖全表 —— 多一条就是重复计了");
    assert_eq!(cur, HelloCursor::default(), "一圈之内装得下 → 游标复位");
}

/// 出入站共用的那把尺**只许高报不许低报**:低报会让一枚正常的满额 Hello
/// 一到收端就被折叠成全量重扫(七轮 M2)。
#[test]
fn watermark_map_bytes_never_underreports_the_real_cbor_length() {
    for n in [0usize, 1, 5, 30, 300] {
        let m: BTreeMap<String, i64> =
            (0..n).map(|i| (dev(i), (i as i64 + 1) * 1_000_000)).collect();
        let mut buf = Vec::new();
        ciborium::into_writer(&m, &mut buf).unwrap();
        let claimed = watermark_map_bytes(&m);
        assert!(claimed >= buf.len(), "{n} 条:报 {claimed} < 实 {}", buf.len());
        assert!(claimed - buf.len() <= 2, "{n} 条:高报得离谱({claimed} vs {})", buf.len());
    }
}

/// 入站形态闸:非规范 origin / 负水位一律整枚拒收(不做静默清洗),
/// 且过闸后的字节数就是出站那把尺算出来的数(两边同尺,七轮 M2)。
#[test]
fn vet_watermarks_rejects_non_canonical_origins_and_negative_values() {
    let ok = wm(&[(&dev(1), 3), (&dev(2), 0)]);
    assert_eq!(vet_watermarks(ok.clone()).unwrap().bytes(), watermark_map_bytes(&ok));

    assert!(vet_watermarks(wm(&[("A", 1)])).is_err(), "1 字节 key 就是内存 DoS 的入口");
    assert!(vet_watermarks(wm(&[("d0000000000000000000000001", 1)])).is_err(), "小写非规范");
    assert!(
        vet_watermarks(wm(&[("01ILOU00000000000000000000", 1)])).is_err(),
        "I/L/O/U 不在字母表"
    );
    assert!(vet_watermarks(wm(&[(&dev(1), -1)])).is_err(), "负水位");
}
