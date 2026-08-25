/// 夹具用的对端设备 id。**必须是规范 ULID**:第5笔起 `from` 要过
/// [`ops_serve::vet_target`] 那把尺,随手起的 "PEERX" 会被整帧拒收。
const PEER_ULID: &str = "01PEERXAAAAAAAAAAAAAAAAAAA";

use super::*;
use crate::sync::production_src;
use crate::{db, images, notes};
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn fresh() -> (Connection, Clock, Engine) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let path = crate::test_temp::dir()
        .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
    let _ = std::fs::remove_file(&path);
    let conn = db::open(&path).expect("open migrated db");
    let clock = Clock::load(&conn).expect("load clock");
    let engine = Engine::new_solo(&conn, BlobPolicy::Full).expect("engine");
    (conn, clock, engine)
}

/// 手搓一枚异设备 op(engine 测试只关心编排机械,payload 用最简的 topic create)。
fn topic_op(device: &str, wall_ms: u64, seq: i64, topic_id: &str) -> RemoteOp {
    RemoteOp {
        op_id: Ulid::new().to_string(),
        hlc: Hlc { wall_ms, counter: 0, device_id: device.into() }.encode(),
        entity: "topic".into(),
        entity_id: topic_id.into(),
        kind: "create".into(),
        payload: json!({"title": format!("t-{seq}"), "created_at": "2026-07-08T00:00:00Z"}),
        origin_seq: seq,
    }
}

fn sends(outs: &[Output]) -> Vec<&Msg> {
    outs.iter()
        .filter_map(|o| match o {
            Output::Send { msg, .. } => Some(msg),
            _ => None,
        })
        .collect()
}

/// 一批引擎输出**真上线的那串消息**:`Send` 原样,`ServeBlob` 就地跑成块
/// ([`serve_chunks`],走生产取数原语)。C′ 之后引擎不再产块,拿 `Output::Send`
/// 过滤 chunk 的老写法会静默滤成空——那正是 263 那类「测试与实现漏在同一个假设里」
/// 的形状,故所有「把应答喂给对端」的用例统一经此。
fn wire_out(eng: &mut Engine, conn: &Connection, outs: Vec<Output>) -> Vec<Msg> {
    let mut v = vec![];
    for o in outs {
        match o {
            Output::Send { msg, .. } => v.push(msg),
            Output::ServeBlob(s) => v.extend(serve_chunks(conn, &s)),
            // 「来取活」的铃:第5笔起 ops 帧不再由引擎当场物化,而由消费腿逐帧取。
            // 这只夹具没有传输层,故就地抽干 —— 少了这一句,凡是靠 Hello/Want 补给
            // 的用例都会「照样绿,但绿得没有意义」(帧一枚都不会出现)。
            Output::ServeOps(_) => {}
            Output::Event(_) => {}
        }
    }
    for o in eng.drain_ops_for_test(conn).expect("drain ops") {
        if let Output::Send { msg, .. } = o {
            v.push(msg);
        }
    }
    v
}

fn frame_rejected(outs: &[Output]) -> bool {
    outs.iter().any(|o| matches!(o, Output::Event(Event::FrameRejected { .. })))
}

const DEV: &str = "PEERDEV0000000000000000001";

#[test]
fn hard_validation_rejects_whole_frame_before_pooling() {
    let (mut conn, mut clock, mut eng) = fresh();
    // hlc 设备后缀 ≠ 帧 origin:整帧拒收,pending 不长(评审①-H2)。
    let op = topic_op("OTHERDEV", 1_000, 1, "01TOPICAAAAAAAAAAAAAAAAAA1");
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
        .unwrap();
    assert!(frame_rejected(&outs));
    assert!(eng.slots.is_empty());
    // 帧内 seq 非严格升序:同拒。
    let ops = vec![
        topic_op(DEV, 1_000, 2, "01TOPICAAAAAAAAAAAAAAAAAA1"),
        topic_op(DEV, 1_001, 2, "01TOPICAAAAAAAAAAAAAAAAAA2"),
    ];
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
        .unwrap();
    assert!(frame_rejected(&outs));
    assert!(eng.slots.is_empty());
    // 帧内 HLC 非严格升序(seq 升 hlc 不升):违反 §5.1「seq 序 == HLC 序」,同拒
    // ——放进来会在记账时撞 hlc UNIQUE 沦为永久挂起,分叉被误装成依赖问题。
    let ops = vec![
        topic_op(DEV, 2_000, 1, "01TOPICAAAAAAAAAAAAAAAAAA3"),
        topic_op(DEV, 2_000, 2, "01TOPICAAAAAAAAAAAAAAAAAA4"), // 同 wall_ms 同 counter=同 hlc
    ];
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
        .unwrap();
    assert!(frame_rejected(&outs));
    assert!(eng.slots.is_empty());
    // 好帧照常入池应用(整帧拒收不留后遗症)。
    let op = topic_op(DEV, 1_000, 1, "01TOPICAAAAAAAAAAAAAAAAAA1");
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
        .unwrap();
    assert!(!frame_rejected(&outs));
    assert_eq!(watermark(&conn, DEV).unwrap(), 1);
}

#[test]
fn gap_holds_the_queue_emits_want_and_heals_on_backfill() {
    let (mut conn, mut clock, mut eng) = fresh();
    let op1 = topic_op(DEV, 1_001, 1, "01TOPICBBBBBBBBBBBBBBBBBB1");
    let op2 = topic_op(DEV, 1_002, 2, "01TOPICBBBBBBBBBBBBBBBBBB2");
    let outs = eng
        .on_relay_msg(
            &mut conn,
            &mut clock,
            DEV,
            Msg::Ops { origin: DEV.into(), ops: vec![op2.clone()] },
        )
        .unwrap();
    // 洞在 1:不应用、广播 want{from_seq:1}。
    assert_eq!(watermark(&conn, DEV).unwrap(), 0, "水位不过缺口");
    let want = sends(&outs)
        .into_iter()
        .find_map(|m| match m {
            Msg::Want { origin, from_seq } => Some((origin.clone(), *from_seq)),
            _ => None,
        })
        .expect("必须发 want 补洞");
    assert_eq!(want, (DEV.to_string(), 1));
    // 同一枚 op 重复到达(多端同答 hello 的已知噪音):丢弃,同缺口 want 不重发。
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
        .unwrap();
    assert!(!frame_rejected(&outs) && sends(&outs).is_empty(), "{outs:?}");
    // 缺口补上:连带 pending 里的 2 一起落地。
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op1] })
        .unwrap();
    assert!(!frame_rejected(&outs));
    assert_eq!(watermark(&conn, DEV).unwrap(), 2, "补洞后连续应用到队尾");
    assert!(eng.slots.get(DEV).is_none_or(|s| s.queue.is_empty()));
}

#[test]
fn origin_forks_freeze_and_silence_the_origin() {
    let (mut conn, mut clock, mut eng) = fresh();
    let op1 = topic_op(DEV, 1_000, 1, "01TOPICCCCCCCCCCCCCCCCCC01");
    eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op1] })
        .unwrap();
    // 同 (origin, seq=1) 另一枚 op_id:分叉,冻结。
    let fork = topic_op(DEV, 9_999, 1, "01TOPICCCCCCCCCCCCCCCCCC02");
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![fork] })
        .unwrap();
    assert!(outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))));
    // 冻结后:该 origin 的合法新帧也静默丢弃。
    let op2 = topic_op(DEV, 1_002, 2, "01TOPICCCCCCCCCCCCCCCCCC03");
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
        .unwrap();
    assert!(outs.is_empty());
    assert_eq!(watermark(&conn, DEV).unwrap(), 1);
}

#[test]
fn echo_of_unknown_self_ops_freezes_self_origin() {
    let (mut conn, mut clock, mut eng) = fresh();
    let me = clock.device_id().to_string();
    // 别人手里有「我」的 op 而我不记得 = 本机曾被回滚/克隆(§11)。
    let ghost = topic_op(&me, 9_999, 1, "01TOPICDDDDDDDDDDDDDDDDDD1");
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, "OTHER", Msg::Ops { origin: me.clone(), ops: vec![ghost] })
        .unwrap();
    assert!(outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))));
}

#[test]
fn echo_of_conflicting_self_op_at_spent_seq_freezes_too() {
    // 克隆库分叉的另一半脸(codex 二轮 #1):双方各自花掉了同一段序号——对端持有
    // 的「我的 seq 1」是另一枚 op。只查「seq > 水位」会静默丢掉它,永不报警。
    let (mut conn, mut clock, mut eng) = fresh();
    notes::capture(&mut conn, &mut clock, "本机真实写过一条").unwrap();
    let me = clock.device_id().to_string();
    assert!(watermark(&conn, &me).unwrap() >= 1);
    let imposter = RemoteOp {
        op_id: Ulid::new().to_string(), // ≠ 本机 seq 1 的真 op_id
        hlc: Hlc { wall_ms: 9_999, counter: 0, device_id: me.clone() }.encode(),
        entity: "topic".into(),
        entity_id: "01TOPICFFFFFFFFFFFFFFFFFF1".into(),
        kind: "create".into(),
        payload: json!({"title": "冒名", "created_at": "2026-07-08T00:00:00Z"}),
        origin_seq: 1,
    };
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, "OTHER", Msg::Ops { origin: me.clone(), ops: vec![imposter] })
        .unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
        "已花序号上的异 op_id 同样是本机分叉,必须冻结:{outs:?}"
    );
}

#[test]
fn same_op_id_with_different_content_freezes_not_swallowed() {
    // codex 四轮:重传判定必须比完整 op。同 op_id 同坐标但 payload 不同 = 两个
    // 「身份相同」的不同事实——当幂等吞掉的话两端水位都齐、永不再修,静默分叉。
    let (mut conn, mut clock, mut eng) = fresh();
    let real = topic_op(DEV, 1_000, 1, "01TOPICI000000000000000001");
    eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![real.clone()] })
        .unwrap();
    assert_eq!(watermark(&conn, DEV).unwrap(), 1);
    let mut tampered = real.clone();
    tampered.payload = json!({"title": "换了内容", "created_at": "2026-07-08T00:00:00Z"});
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![tampered] })
        .unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
        "同 op_id 异内容 = 分叉,不许当重传吞:{outs:?}"
    );
    // 真正的重传(逐字段全同)照旧静默吸收。
    let (mut c2, mut k2, mut e2) = fresh();
    e2.on_relay_msg(&mut c2, &mut k2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![real.clone()] })
        .unwrap();
    let outs = e2
        .on_relay_msg(&mut c2, &mut k2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![real] })
        .unwrap();
    assert!(
        !outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
        "全同重传不误报分叉:{outs:?}"
    );
}

#[test]
fn cross_frame_seq_hlc_order_breach_freezes() {
    // codex 三轮 High:帧内校验挡不住跨帧交错。seq2(hlc 小)先入池,seq1(hlc 大)
    // 后到——若照单应用,本地日志双序矛盾(seq 序 ≠ hlc 序),将来代补给第三端被
    // 对方帧内校验永久拒帧。入池时按前驱/后继 hlc 开区间拦下,冻结该 origin。
    let (mut conn, mut clock, mut eng) = fresh();
    let op2 = topic_op(DEV, 2_000, 2, "01TOPICG000000000000000002");
    eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
        .unwrap();
    let op1_late_hlc = topic_op(DEV, 9_000, 1, "01TOPICG000000000000000001"); // hlc > seq2 的
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op1_late_hlc] })
        .unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
        "跨帧双序矛盾必须冻结:{outs:?}"
    );
    assert_eq!(watermark(&conn, DEV).unwrap(), 0, "矛盾 op 一条都不落地");
    // 对照组:与已应用日志衔接的下界。正常应用 seq1 后,伪造「seq2 但 hlc 早于
    // seq1」的帧 → 前驱(日志 MAX hlc)拦下。
    let (mut conn2, mut clock2, mut eng2) = fresh();
    let a1 = topic_op(DEV, 5_000, 1, "01TOPICH000000000000000001");
    eng2.on_relay_msg(&mut conn2, &mut clock2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![a1] })
        .unwrap();
    let a2_early_hlc = topic_op(DEV, 1_000, 2, "01TOPICH000000000000000002");
    let outs = eng2
        .on_relay_msg(&mut conn2, &mut clock2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![a2_early_hlc] })
        .unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
        "与已应用日志的双序矛盾同样冻结:{outs:?}"
    );
    assert_eq!(watermark(&conn2, DEV).unwrap(), 1);
}

#[test]
fn suspended_head_retries_after_any_progress() {
    let (mut conn, mut clock, mut eng) = fresh();
    // origin B 的 link_add 依赖 origin A 的 item+topic(跨 origin 因果):B 先到
    // 挂起,A 到齐后 drain 不动点把 B 解开。
    let (mut remote, mut rclock) = {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = crate::test_temp::dir()
            .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open");
        let clock = Clock::load(&conn).expect("clock");
        (conn, clock)
    };
    let idea = notes::capture(&mut remote, &mut rclock, "被引用的条目").unwrap();
    let topic = notes::create_topic(&mut remote, &mut rclock, "被引用的标签").unwrap();
    notes::file_to_topic(&mut remote, &mut rclock, &idea, Some(&topic), None).unwrap();
    let a = rclock.device_id().to_string();
    let a_ops: Vec<RemoteOp> = {
        let mut stmt = remote
            .prepare(
                "SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq \
                 FROM oplog ORDER BY origin_seq",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok(RemoteOp {
                    op_id: r.get(0)?,
                    hlc: r.get(1)?,
                    entity: r.get(2)?,
                    entity_id: r.get(3)?,
                    kind: r.get(4)?,
                    payload: serde_json::from_str(&r.get::<_, String>(5)?).unwrap(),
                    origin_seq: r.get(6)?,
                })
            })
            .unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    };
    // B(第三设备)转述 A 的 link op:把它包装成 B 自己的?不行——op 的 hlc 内嵌 A。
    // 真正的跨 origin 场景:B 的 op 引用 A 的实体。手搓 B 的 link_add 指向 A 的条目。
    let b_link = RemoteOp {
        op_id: Ulid::new().to_string(),
        hlc: Hlc { wall_ms: 9_999_999, counter: 0, device_id: "BDEV0000000000000000000002".into() }.encode(),
        entity: "link".into(),
        entity_id: format!("{idea}:{topic}"),
        kind: "link_add".into(),
        payload: json!({"item_id": idea, "topic_id": topic}),
        origin_seq: 1,
    };
    let outs = eng
        .on_relay_msg(
            &mut conn,
            &mut clock,
            "BDEVICE",
            Msg::Ops { origin: "BDEV0000000000000000000002".into(), ops: vec![b_link] },
        )
        .unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Event(Event::OriginSuspended { .. }))),
        "依赖未到:B 队头挂起"
    );
    assert_eq!(watermark(&conn, "BDEV0000000000000000000002").unwrap(), 0, "挂起不记账不推水位");
    // A 的历史到齐:drain 不动点连带把 B 的挂起头解开。
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, "ADEV", Msg::Ops { origin: a.clone(), ops: a_ops })
        .unwrap();
    assert!(!frame_rejected(&outs));
    assert_eq!(watermark(&conn, "BDEV0000000000000000000002").unwrap(), 1, "挂起头重试落地");
    assert!(eng.slots.is_empty(), "终局槽必空(队列/挂起随槽释放)");
    let linked: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM item_topic WHERE item_id = ?1 AND topic_id = ?2",
            (&idea, &topic),
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(linked, 1, "link 行按 OR-set 落地");
}

#[test]
fn pending_overflow_drops_pool_but_not_watermark() {
    let (mut conn, mut clock, mut eng) = fresh();
    eng.pending_cap = 3;
    // 洞在 1,seq 2..=6 一帧到达攒池超限 → 该 origin pending 全弃,水位纹丝不动;
    // 丢弃当场必须发 want(pending 没了,长连接下没有别的重取信号,codex 二轮 #3)。
    let ops: Vec<RemoteOp> = (2..=6)
        .map(|seq| topic_op(DEV, 1_000 + seq as u64, seq, &format!("01TOPICE{seq:018}")))
        .collect();
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
        .unwrap();
    assert!(eng.slots.get(DEV).is_none(), "超限丢弃整个 origin 的槽");
    assert!(
        sends(&outs)
            .iter()
            .any(|m| matches!(m, Msg::Want { origin, from_seq: 1 } if origin == DEV)),
        "丢弃即刻发 want{{from_seq:1}}:{outs:?}"
    );
    assert_eq!(watermark(&conn, DEV).unwrap(), 0, "水位不动 = 没丢数据");
    // 按序重取(hello/want 的效果):1..=6 全部落地。
    let ops: Vec<RemoteOp> = (1..=6)
        .map(|seq| topic_op(DEV, 1_000 + seq as u64, seq, &format!("01TOPICE{seq:018}")))
        .collect();
    eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
        .unwrap();
    assert_eq!(watermark(&conn, DEV).unwrap(), 6);
}

#[test]
fn pending_overflow_by_bytes_drops_pool_too() {
    // 评审 P2-g 轮 M:条数上限拦不住大 payload——字节维度同一套「丢弃+want、
    // 水位不动」处置。洞在 1,两条 ~1KB 的 op 滞留即超 1KB 上限。
    let (mut conn, mut clock, mut eng) = fresh();
    eng.pending_bytes_cap = 1024;
    let fat = |seq: i64| {
        let mut op = topic_op(DEV, 1_000 + seq as u64, seq, &format!("01TOPICJ{seq:018}"));
        op.payload = json!({"title": "大".repeat(400), "created_at": "2026-07-09T00:00:00Z"});
        op
    };
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![fat(2), fat(3)] })
        .unwrap();
    assert!(eng.slots.get(DEV).is_none(), "超字节上限丢弃整个 origin 的槽");
    assert!(
        sends(&outs)
            .iter()
            .any(|m| matches!(m, Msg::Want { origin, from_seq: 1 } if origin == DEV)),
        "丢弃即刻发 want:{outs:?}"
    );
    assert_eq!(watermark(&conn, DEV).unwrap(), 0, "水位不动 = 没丢数据");
}

#[test]
fn hello_answers_with_ops_the_peer_lacks() {
    let (mut conn, mut clock, mut eng) = fresh();
    let idea = notes::capture(&mut conn, &mut clock, "本机的历史").unwrap();
    notes::edit(&mut conn, &mut clock, &idea, "改一笔").unwrap();
    // 对端 hello:水位空 → 「我高你低」,回我全量(单帧)。
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, PEER_ULID, Msg::Hello { watermarks: BTreeMap::new(), lan: None })
        .unwrap();
    let me = clock.device_id();
    // 第5笔:Hello 不再当场物化补给帧,只登记一份对账计划并产一枚「来取活」的描述符;
    // 帧由消费腿逐帧取。判据因此分两层——**描述符必须出现**(否则没人会来取),
    // **抽出来的帧要和从前一样**。
    assert!(
        outs.iter().any(|o| matches!(o, Output::ServeOps(_))),
        "收下 Hello 必须产一枚描述符,否则这份对账计划没人来取:{outs:?}"
    );
    let served = eng.drain_ops_for_test(&conn).unwrap();
    let ops_frame = sends(&served)
        .into_iter()
        .find_map(|m| match m {
            Msg::Ops { origin, ops } if origin == me => Some(ops.len()),
            _ => None,
        })
        .expect("hello 必须换来补给帧");
    assert_eq!(ops_frame as i64, watermark(&conn, me).unwrap());
    // 对端已齐平:不再回帧。
    let mut theirs = BTreeMap::new();
    theirs.insert(me.to_string(), watermark(&conn, me).unwrap());
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, PEER_ULID, Msg::Hello { watermarks: theirs, lan: None })
        .unwrap();
    assert!(sends(&outs).iter().all(|m| !matches!(m, Msg::Ops { .. })));
}

/// 一批输出里那些补洞请求问的是哪些 origin(顺序即产出序,轮转用例要看它)。
fn asked_origins(outs: &[Output]) -> Vec<String> {
    outs.iter()
        .filter_map(|o| match o {
            Output::Send { msg: Msg::Want { origin, .. }, .. } => Some(origin.clone()),
            _ => None,
        })
        .collect()
}

/// 322:**收 Hello 发现自己落后,当场回一枚定向 `Want`**。
///
/// 少了这一步,321 那条「本机 ops 撞 busy → 置债 → 每拍一枚广播 Hello」是死巷:Hello
/// 只让对端**把对端的新东西推给我**,没有任何人来要**我**的积压(真机实测 8 分钟零到达,
/// progress-log 322)。
#[test]
fn a_hello_from_a_peer_that_is_ahead_asks_it_for_the_gap() {
    let (mut conn, mut clock, mut eng) = fresh();
    let theirs = BTreeMap::from([(PEER_ULID.to_string(), 7)]);
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, PEER_ULID, Msg::Hello { watermarks: theirs, lan: None })
        .unwrap();
    let asked: Vec<(&str, &str, i64)> = outs
        .iter()
        .filter_map(|o| match o {
            Output::Send { to, msg: Msg::Want { origin, from_seq }, .. } => {
                Some((to.as_str(), origin.as_str(), *from_seq))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        asked,
        vec![(PEER_ULID, PEER_ULID, 1)],
        "本机水位 0 → 从 1 问起;且**定向**发给自报有货的那台,不广播:{outs:?}"
    );
}

/// 反面那一半:对端没比我高,一枚都不问(否则每收一枚 Hello 就白问一轮)。
#[test]
fn a_hello_from_a_peer_that_is_not_ahead_asks_for_nothing() {
    let (mut conn, mut clock, mut eng) = fresh();
    let idea = notes::capture(&mut conn, &mut clock, "本机的东西").unwrap();
    notes::edit(&mut conn, &mut clock, &idea, "再改一笔").unwrap();
    let me = clock.device_id().to_string();
    let mine = watermark(&conn, &me).unwrap();
    let theirs = BTreeMap::from([
        (me.clone(), mine - 1),           // 我高你低:该我推给它,不是我问它
        (PEER_ULID.to_string(), 0),       // 齐平(两边都是 0)
    ]);
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, PEER_ULID, Msg::Hello { watermarks: theirs, lan: None })
        .unwrap();
    assert!(asked_origins(&outs).is_empty(), "没落后就别问:{outs:?}");
}

/// 有界 + 轮转:一枚 Hello 的水位图只按字节封顶(64 KiB ≈ 上千个 origin),逐个回问
/// 就是「一枚小帧换上千枚帧」。而恒取最小的话,前 16 个长期要不到的会把后面永久挡住。
#[test]
fn the_gap_wants_from_one_hello_are_capped_and_rotate() {
    let (mut conn, mut clock, mut eng) = fresh();
    let ids: Vec<String> = (1..=(HELLO_GAP_WANT_BATCH + 4)).map(|i| format!("{i:026}")).collect();
    let theirs: BTreeMap<String, i64> = ids.iter().map(|o| (o.clone(), 3)).collect();
    let hello = || Msg::Hello { watermarks: theirs.clone(), lan: None };
    let first =
        asked_origins(&eng.on_relay_msg(&mut conn, &mut clock, PEER_ULID, hello()).unwrap());
    assert_eq!(first.len(), HELLO_GAP_WANT_BATCH, "一枚 Hello 至多换回这么多枚:{first:?}");
    let second =
        asked_origins(&eng.on_relay_msg(&mut conn, &mut clock, PEER_ULID, hello()).unwrap());
    assert_eq!(second.len(), HELLO_GAP_WANT_BATCH);
    assert!(
        second.iter().any(|o| !first.contains(o)),
        "第二枚 Hello 必须问到第一枚没问的那几个(轮转);first={first:?} second={second:?}"
    );
}

/// 冻结与隔离在册的 origin 跳过:那两档要来的帧到岸即冻/即丢,问了纯属白问,而
/// Hello 每来一枚就会再问一次。
#[test]
fn gap_wants_skip_frozen_and_quarantined_origins() {
    let (mut conn, mut clock, mut eng) = fresh();
    let (froze, quar, ok) = (format!("{:026}", 1), format!("{:026}", 2), format!("{:026}", 3));
    eng.frozen.insert(froze.clone(), "分叉".into());
    eng.quarantined.insert(quar.clone());
    let theirs = BTreeMap::from([(froze, 9), (quar, 9), (ok.clone(), 9)]);
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, PEER_ULID, Msg::Hello { watermarks: theirs, lan: None })
        .unwrap();
    assert_eq!(asked_origins(&outs), vec![ok], "只问那一个还能收的:{outs:?}");
}

/// 游标**攒到最后一次性提交**:循环里读本机水位带 `?`,中途炸掉时整批 `Want` 随 `?`
/// 一起丢。边走边推进游标的话就是「状态留下了、义务丢了」——§6.2 ③″ 那条纪律的镜像:
/// 被游标跳过的那几个 origin 这一轮没问成,却要等轮转绕完一圈才轮得回来。
///
/// 可控失败点用 rusqlite authorizer(`db.rs` 里已有的同一把):放行第一枚 origin 的
/// 水位读、拒掉第二枚,于是「已问出一枚、第二枚炸了」这一格真被走到。
#[test]
fn a_mid_loop_read_failure_leaves_the_rotation_cursor_untouched() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let (conn, _clock, mut eng) = fresh();
    let theirs = BTreeMap::from([(format!("{:026}", 1), 5), (format!("{:026}", 2), 5)]);
    let vetted = ops_serve::vet_watermarks(theirs).expect("两枚都是规范 id");
    let selects = std::cell::Cell::new(0usize);
    conn.authorizer(Some(move |ctx: AuthContext| match ctx.action {
        AuthAction::Select => {
            selects.set(selects.get() + 1);
            if selects.get() >= 2 { Authorization::Deny } else { Authorization::Allow }
        }
        _ => Authorization::Allow,
    }));
    let err = eng
        .hello_gap_wants(&conn, PEER_ULID, &vetted)
        .expect_err("第二枚 origin 的水位读被拒,整批必须响亮失败");
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    assert!(
        eng.hello_want_cursor.is_empty(),
        "这一批一枚都没交出去(`?` 把 out 丢了),游标就一格都不许动;实见 err={err}"
    );
}

/// **322 实现审 M1 的反例**:两个发送方交替,谁也不许拨动对方那只游标。
///
/// 全局一只游标时:A 报 20 个缺口 → 我问 `01..16`、游标到 `16`;紧接着 C 的 Hello 只报
/// 一个更小的 `00` → 我问它一枚就把游标**拨回** `00`;A、C 一交替,`17..20` 永远问不到。
/// 那是合法输入下的活性错误(它们全都取不到 = 持续 busy,这正是 322 要治的那一幕)。
#[test]
fn two_senders_do_not_drag_each_others_rotation_cursor() {
    let (mut conn, mut clock, mut eng) = fresh();
    let a = PEER_ULID;
    let c = "01PEERXCCCCCCCCCCCCCCCCCCC";
    // A 报 20 个缺口(`00000…01` … `00000…20`),C 只报一个**排在最前**的 `00000…00`。
    let a_map: BTreeMap<String, i64> =
        (1..=20).map(|i| (format!("{i:026}"), 3)).collect();
    let c_map = BTreeMap::from([(format!("{:026}", 0), 3)]);
    let hello = |m: &BTreeMap<String, i64>| Msg::Hello { watermarks: m.clone(), lan: None };

    let first =
        asked_origins(&eng.on_relay_msg(&mut conn, &mut clock, a, hello(&a_map)).unwrap());
    assert_eq!(first.len(), HELLO_GAP_WANT_BATCH, "前置:第一枚 Hello 该问满 16 枚");
    // C 插一脚:它那枚 origin 排在所有 A 的前面,全局游标形态下会被拨回去。
    let from_c =
        asked_origins(&eng.on_relay_msg(&mut conn, &mut clock, c, hello(&c_map)).unwrap());
    assert_eq!(from_c, vec![format!("{:026}", 0)], "C 那枚也该问出来");
    let second =
        asked_origins(&eng.on_relay_msg(&mut conn, &mut clock, a, hello(&a_map)).unwrap());

    for i in 17..=20 {
        let tail = format!("{i:026}");
        assert!(
            second.contains(&tail),
            "A 的第 {i} 个缺口必须在第二枚 Hello 里问到 —— 它被 C 拨回去的游标挡住了。\
             first={first:?} from_c={from_c:?} second={second:?}"
        );
    }
}

/// **322 实现审 M2**:一枚 Hello 的**查库次数**由常量定,不由水位图有多大定。
///
/// 水位全齐时一枚 Want 都不产,故 `HELLO_GAP_WANT_BATCH` 那道闸一次都不拦;少了检查
/// 预算,这一枚 Hello 就会把整张图走一遍、每项查一次本机水位。用 authorizer 数 `SELECT`。
#[test]
fn one_hello_costs_a_bounded_number_of_watermark_reads() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let (conn, _clock, mut eng) = fresh();
    // 200 项,全部「我齐你齐」(两边都是 0)→ 一枚 Want 都不该产。
    let theirs: BTreeMap<String, i64> = (1..=200).map(|i| (format!("{i:026}"), 0)).collect();
    let vetted = ops_serve::vet_watermarks(theirs).expect("全是规范 id");
    let selects = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = selects.clone();
    conn.authorizer(Some(move |ctx: AuthContext| {
        if matches!(ctx.action, AuthAction::Select) {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        Authorization::Allow
    }));
    let outs = eng.hello_gap_wants(&conn, PEER_ULID, &vetted).unwrap();
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);

    let n = selects.load(std::sync::atomic::Ordering::SeqCst);
    assert!(outs.is_empty(), "水位全齐,一枚都不该问:{outs:?}");
    assert!(
        n <= HELLO_GAP_SCAN_STEPS,
        "一枚 Hello 的查库次数必须由 HELLO_GAP_SCAN_STEPS({HELLO_GAP_SCAN_STEPS})定,\
         不由图有多大定;实见 {n} 次"
    );
    // 下界同样要断:游标必须**推过已看过的那些**,否则每枚 Hello 都从头重扫、
    // 排在后面的 origin 永远轮不到(那是「有闸但不前进」的假绿)。
    assert_eq!(
        eng.hello_want_cursor.values().map(|s| s.cursor.as_str()).collect::<Vec<_>>(),
        vec![format!("{HELLO_GAP_SCAN_STEPS:026}").as_str()],
        "游标该停在第 {HELLO_GAP_SCAN_STEPS} 项上"
    );
}

/// **322 实现审三轮 M1 的反例**:两份**最小 key 相同**的合法水位图必须各记各的进度。
///
/// 头一版拿「这枚 Hello 最小的那个 key」当窗口身份 —— 而 `{00,01..20}` 与 `{00,21..40}`
/// 都合形、都远小于 64 KiB、最小 key 都是 `00`,撞同一格就等于没分开:交替发来时
/// `01..20` 的尾巴与 `21..40` 的尾巴各自永久漏问。
#[test]
fn two_windows_sharing_a_smallest_origin_keep_separate_progress() {
    let (mut conn, mut clock, mut eng) = fresh();
    let shared = format!("{:026}", 0);
    let mk = |range: std::ops::RangeInclusive<u32>| -> BTreeMap<String, i64> {
        std::iter::once((shared.clone(), 3))
            .chain(range.map(|i| (format!("{i:026}"), 3)))
            .collect()
    };
    let (w1, w2) = (mk(1..=20), mk(21..=40));
    assert_eq!(w1.keys().next(), w2.keys().next(), "前置:两份图的最小 key 必须相同");

    let mut asked: std::collections::HashSet<String> = std::collections::HashSet::new();
    for _ in 0..8 {
        for w in [&w1, &w2] {
            let outs = eng
                .on_relay_msg(
                    &mut conn,
                    &mut clock,
                    PEER_ULID,
                    Msg::Hello { watermarks: w.clone(), lan: None },
                )
                .unwrap();
            asked.extend(asked_origins(&outs));
        }
    }
    let never: Vec<String> = (1..=40)
        .map(|i| format!("{i:026}"))
        .filter(|o| !asked.contains(o))
        .collect();
    assert!(never.is_empty(), "这些 origin 一次都没被问到(两份图撞了同一格游标):{never:?}");
}

/// 造 `n` 个各 20 项的互不相交窗口(每个都比一枚 Hello 的产出上界大)。
fn cursor_test_windows(n: usize) -> Vec<BTreeMap<String, i64>> {
    (0..n)
        .map(|w| (0..20).map(|i| (format!("{w:013}{i:013}"), 3)).collect::<BTreeMap<_, _>>())
        .collect()
}

/// **322 实现审三轮 M2 的反例**:窗口数超过游标表的格数时,不许「整只清空」。
///
/// 键带上窗口之后,**一台**对端循环发 65 个不同窗口就能把 64 格撑满。头一版满额时整只
/// 清空 —— 于是每个窗口在下次露面前进度都已被抹掉,永远只问自己的前 16 个。改成「扫完
/// 即还」之后,格子由**已登记的窗口自己走完一圈**来腾,登记者优先续完、完了让位。
#[test]
fn more_windows_than_cursor_slots_still_sweep_to_the_end() {
    let (mut conn, mut clock, mut eng) = fresh();
    let windows = cursor_test_windows(HELLO_CURSOR_SLOTS + 1);
    assert!(
        windows.iter().all(|w| w.len() > HELLO_GAP_WANT_BATCH),
        "前置:每个窗口都要比产出上界大,否则一枚 Hello 就问完了"
    );

    let mut asked: std::collections::HashSet<String> = std::collections::HashSet::new();
    for _ in 0..12 {
        for w in &windows {
            let outs = eng
                .on_relay_msg(
                    &mut conn,
                    &mut clock,
                    PEER_ULID,
                    Msg::Hello { watermarks: w.clone(), lan: None },
                )
                .unwrap();
            asked.extend(asked_origins(&outs));
            eng.on_tick();
        }
    }
    let never: Vec<String> = windows
        .iter()
        .flat_map(|w| w.keys().cloned())
        .filter(|o| !asked.contains(o))
        .collect();
    assert!(
        never.is_empty(),
        "{} 个 origin 一次都没被问到(满额把没扫完的进度整只抹了):{:?}",
        never.len(),
        &never[..never.len().min(8)]
    );
    assert!(
        eng.hello_want_cursor.len() <= HELLO_CURSOR_SLOTS,
        "游标表越界:{}",
        eng.hello_want_cursor.len()
    );
}

/// **322 实现审四轮 M1 的反例**:64 个**只来一次**的窗口占满格之后,后来那个稳定窗口
/// 照样要能扫到尾。
///
/// 「扫完即还」回收不了一次性窗口 —— 它们等不到下一次露面。而一次性窗口是**正常演进**
/// 就会造出来的(origin 集长大让窗口重新分块 / 水位跨过 CBOR 整数编码边界 / 发送端重建 /
/// 老设备离开),故被饿死的会是后来那些诚实窗口,不是什么恶意成员。回收轴 = 按**绝对
/// 年龄**清废格;⚠ 不能换成 LRU,那会在 65>64 那只测里当场抖动。
#[test]
fn stale_cursor_slots_do_not_poison_a_later_steady_window() {
    let (mut conn, mut clock, mut eng) = fresh();
    let mut feed = |eng: &mut Engine, conn: &mut Connection, clock: &mut Clock, w: &BTreeMap<String, i64>| {
        let outs = eng
            .on_relay_msg(conn, clock, PEER_ULID, Msg::Hello { watermarks: w.clone(), lan: None })
            .unwrap();
        eng.on_tick();
        asked_origins(&outs)
    };

    // ① 64 个窗口各来一次就再不出现 —— 每个都留下一格没扫完的进度,表就此满了。
    let one_shots = cursor_test_windows(HELLO_CURSOR_SLOTS);
    for w in &one_shots {
        feed(&mut eng, &mut conn, &mut clock, w);
    }
    assert_eq!(
        eng.hello_want_cursor.len(),
        HELLO_CURSOR_SLOTS,
        "前置:64 个一次性窗口该把格占满"
    );

    // ② 此后只有这一个窗口稳定周期来。它的尾巴(第 17..20 个)必须最终被问到。
    let steady: BTreeMap<String, i64> =
        (0..20).map(|i| (format!("{:013}{i:013}", 9999), 3)).collect();
    let mut asked: std::collections::HashSet<String> = std::collections::HashSet::new();
    for _ in 0..(HELLO_CURSOR_STALE_TICKS + 4) {
        asked.extend(feed(&mut eng, &mut conn, &mut clock, &steady));
    }
    let never: Vec<&String> = steady.keys().filter(|o| !asked.contains(*o)).collect();
    assert!(
        never.is_empty(),
        "废格把后来这个稳定窗口毒死了,它永远只问得到自己的前 {HELLO_GAP_WANT_BATCH} 个:{never:?}"
    );
    assert!(
        eng.hello_want_cursor.len() <= HELLO_CURSOR_SLOTS,
        "游标表越界:{}",
        eng.hello_want_cursor.len()
    );
}

/// 指纹只吃 key、不吃水位:同一个窗口的水位每拍都在涨,吃了值就等于每枚 Hello 都是新
/// 窗口 —— 那等于把这套记忆整个废掉(而且不会有任何测试红,故单钉一只)。
#[test]
fn the_same_origins_with_moved_watermarks_stay_in_one_slot() {
    let (mut conn, mut clock, mut eng) = fresh();
    let at = |seq: i64| -> BTreeMap<String, i64> {
        (1..=20).map(|i| (format!("{i:026}"), seq)).collect()
    };
    for seq in [3, 4, 5] {
        eng.on_relay_msg(
            &mut conn,
            &mut clock,
            PEER_ULID,
            Msg::Hello { watermarks: at(seq), lan: None },
        )
        .unwrap();
    }
    assert_eq!(
        eng.hello_want_cursor.len(),
        1,
        "同一份 origin 集、水位涨了三轮,只该占一格:{:?}",
        eng.hello_want_cursor
    );
}

/// **322 实现审二轮 M1 的反例**:发送侧**自己也在轮转**时,每个窗口都要被扫透。
///
/// 全部水位装不进预算时,生产的 `bounted_watermarks` 按**互不相交**的窗口 `W1,W2,…`
/// 循环发。收端若只记一枚绝对游标:问完 `W1` 前 16 个游标落在 `W1` 里 → `W2` 来了把游标
/// 推进 `W2` → `W1` 再来时游标已大于它全部 key,绕回头**又从第一个问起**。于是每个窗口
/// 永远只被问到前 16 个,后面的即便对端拿得出也永远没人要。
///
/// 这只测**走生产的窗口切法**(不是手搓两张 map),故发送侧哪天改了切法它会跟着说话。
#[test]
fn a_rotating_sender_still_gets_every_window_swept() {
    use crate::sync::ops_serve::{bounded_watermarks, HelloCursor};
    // ① 造一台「有很多 origin」的对端:40 个各写过一枚 op。
    let (mut a_conn, mut a_clock, mut a_eng) = fresh();
    let origins: Vec<String> = (1..=40).map(|i| format!("{i:026}")).collect();
    for (n, o) in origins.iter().enumerate() {
        a_eng
            .on_relay_msg(
                &mut a_conn,
                &mut a_clock,
                o,
                Msg::Ops {
                    origin: o.clone(),
                    ops: vec![topic_op(o, 1_000 + n as u64, 1, &format!("T{n:025}"))],
                },
            )
            .unwrap();
    }

    // ② 拿生产切法把它切成窗口。
    //
    // ⚠ **预算这个数是判据的一部分,不是随手挑的**(变异对照抓到过一次假绿):窗口是
    // 按 key 空间**循环**取的,窗口尺不整除 origin 数时边界每圈都在漂 —— 而漂移本身就
    // 把覆盖面带出来了,那一格连坏代码都能过。要复现二轮 M1 说的那一幕,必须让窗口
    // **恰好平铺**:40 个 origin、每枚 Hello 恰 20 条 → 两块互不相交的定长砖来回换。
    // 每条 26 字符 id + 小整数 ≈ 29 字节,故预算取 600(3 + 29×20 = 583 装得下、
    // 再加一条 612 装不下)。
    let mut send_cursor = HelloCursor::default();
    let mut windows = vec![];
    for _ in 0..6 {
        let w = bounded_watermarks(&a_conn, &mut send_cursor, 600).unwrap();
        assert!(!w.is_empty(), "窗口不该空");
        windows.push(w);
    }
    // 前置逐条钉死,别让这只测哪天悄悄退化回「漂移窗口」那种谁都能过的形。
    let shapes: Vec<Vec<&String>> = windows.iter().map(|w| w.keys().collect()).collect();
    let distinct: std::collections::BTreeSet<&Vec<&String>> = shapes.iter().collect();
    assert_eq!(distinct.len(), 2, "前置:该切成恰两块来回换;实见 {} 种", distinct.len());
    let (w0, w1) = (&shapes[0], &shapes[1]);
    assert!(
        w0.iter().all(|k| !w1.contains(k)),
        "前置:两块必须互不相交(重叠的话覆盖靠重叠就有了,测不到轮转)"
    );
    assert!(
        windows.iter().all(|w| w.len() > HELLO_GAP_WANT_BATCH),
        "前置:窗口要比一枚 Hello 的产出上界大,否则一枚就问完了;实见 {:?}",
        windows.iter().map(|w| w.len()).collect::<Vec<_>>()
    );

    // ③ 收端 B 一条都没有 → 每个 origin 都是缺口。把窗口按生产那个次序循环喂进去。
    let (mut b_conn, mut b_clock, mut b_eng) = fresh();
    let a_id = a_clock.device_id().to_string();
    let mut asked: std::collections::HashSet<String> = std::collections::HashSet::new();
    for _ in 0..8 {
        for w in &windows {
            let outs = b_eng
                .on_relay_msg(
                    &mut b_conn,
                    &mut b_clock,
                    &a_id,
                    Msg::Hello { watermarks: w.clone(), lan: None },
                )
                .unwrap();
            asked.extend(asked_origins(&outs));
        }
    }
    let never: Vec<&String> = origins.iter().filter(|o| !asked.contains(*o)).collect();
    assert!(
        never.is_empty(),
        "发送方轮转时,这些 origin 一次都没被问到(每个窗口只被扫了个头):{never:?}"
    );
}

/// **整条链**(321+322)在 sans-io 层跑一遍,拓扑照真机上停摆的那个摆:A 写了东西、
/// B 落后,而**只有 A 发 Hello**(那是 321 的债轴唯一产得出的东西,B 这边没有任何
/// 事件让它发自己的 Hello)。322 之前这一串到第二步就断了。
#[test]
fn only_the_writers_hello_is_enough_for_the_peer_to_catch_up() {
    let (mut a_conn, mut a_clock, mut a_eng) = fresh();
    let (mut b_conn, mut b_clock, mut b_eng) = fresh();
    let a_id = a_clock.device_id().to_string();
    let b_id = b_clock.device_id().to_string();
    notes::capture(&mut a_conn, &mut a_clock, "只写在 A 上的东西").unwrap();
    let a_max = watermark(&a_conn, &a_id).unwrap();
    assert!(a_max > 0);

    // ① A 那枚广播 Hello(走 `make_hello` 这个唯一构造点,与心跳那一拍同一份)。
    let hello = a_eng
        .make_hello(&a_conn, BROADCAST, Route::Relay)
        .unwrap()
        .into_iter()
        .find_map(|o| match o {
            Output::Send { msg: msg @ Msg::Hello { .. }, .. } => Some(msg),
            _ => None,
        })
        .expect("make_hello 必产一枚 Hello");

    // ② B 收下它 —— 322 之前这里只登记「服务 A」的计划,一个字节都不问。
    let b_out = b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, hello).unwrap();
    let want = b_out
        .into_iter()
        .find(|o| matches!(o, Output::Send { msg: Msg::Want { .. }, .. }))
        .expect("B 落后,必须回一枚 Want");
    let Output::Send { to, msg: want_msg, .. } = want else { unreachable!() };
    assert_eq!(to, a_id, "定向问自报有货的那台");

    // ③ A 收下这枚 Want → 登记**定向** work(真机上正是它撞 busy 后让位给直连的)。
    //
    // **钉死描述符去哪台、走哪条路**(实现审 L1):只断「存在某个 `ServeOps`」的话,
    // 摇给 BROADCAST、或来路绑错腿,这只测照样绿——而那两样恰恰是 322 要区分的东西
    // (定向 work 才会让位给直连,BROADCAST 恒不让位)。
    let a_out = a_eng.on_relay_msg(&mut a_conn, &mut a_clock, &b_id, want_msg).unwrap();
    let serve = a_out
        .iter()
        .find_map(|o| match o {
            Output::ServeOps(s) => Some(s.clone()),
            _ => None,
        })
        .expect("Want 必须换来一枚「来取活」的描述符");
    assert_eq!(
        serve.to,
        OpsServeTo::Peer { device: b_id.clone(), route: Route::Relay },
        "定向答复要绑发问那台 + 产出那一刻的来路(来路亲和):{a_out:?}"
    );

    // ④ 把 A 供出来的帧喂给 B,B 追平。**帧的收件人也要断**——寄错人时这一步会静默
    // 变成「B 什么也没收到」,而水位断言只在**一枚都没到**时才红(下界),寄给第三台
    // 却仍喂给 B 的写法看不出来。
    let mut fed = 0usize;
    for f in a_eng.drain_ops_for_test(&a_conn).unwrap() {
        if let Output::Send { to, msg, .. } = f {
            assert_eq!(to, b_id, "取出来的帧必须寄给发问那台");
            b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
            fed += 1;
        }
    }
    assert!(fed > 0, "一枚帧都没取出来:那这只测什么也没证");
    assert_eq!(watermark(&b_conn, &a_id).unwrap(), a_max, "B 该追平 A 的水位");
}

#[test]
fn blob_sidechannel_pulls_bytes_and_builds_the_row() {
    // A 端真 attach 一张图;B 端收 op(行不建)→ want → A have → B pull → A chunk
    // → B 验货建行,字节逐位相等(§5.4 全链路,72 契约建行)。
    let (mut a_conn, mut a_clock, mut a_eng) = fresh();
    let (mut b_conn, mut b_clock, mut b_eng) = fresh();
    let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
    let bytes: Vec<u8> = (0u8..200).collect();
    let (img, _seq) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
    let a_id = a_clock.device_id().to_string();
    let b_id = b_clock.device_id().to_string();
    // 中转会话 + 服务器在线快照:A 的中转腿 Up——blob 选路只认路由表
    // (lan-direct-plan §5.1),且「会话在 ∧ 对端在线」两层缺一不可(实现审 M2),
    // 没这两句 B 收到 have 也不会拉(「不凭空走中转」)。
    b_eng.relay_up(&b_conn).unwrap();
    b_eng.on_relay_peer_up(&a_id);

    // B 收 A 全量 op(借 hello 机制拿帧,顺带测追赶)。
    // 第5笔:Hello 只登记计划,帧要抽;且 `from` 从此过规范设备 id 那把尺,故这里
    // 用真身份(原先的 "A"/"B" 会被整帧拒收 —— 那正是新形该有的样子)。
    let mut frames = a_eng
        .on_relay_msg(&mut a_conn, &mut a_clock, &b_id, Msg::Hello { watermarks: BTreeMap::new(), lan: None })
        .unwrap();
    frames.extend(a_eng.drain_ops_for_test(&a_conn).unwrap());
    let mut b_out = vec![];
    for f in frames {
        if let Output::Send { msg, .. } = f {
            b_out.extend(b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap());
        }
    }
    let row_at_b: i64 =
        b_conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
    assert_eq!(row_at_b, 0, "image_add 只推水位不建行(字节未到)");
    let want = b_out
        .iter()
        .find_map(|o| match o {
            Output::Send { msg: Msg::BlobWant { image_id }, .. } => Some(image_id.clone()),
            _ => None,
        })
        .expect("B 必须广播 blob_want");
    assert_eq!(want, img);

    // A 应答 have → B 发起 pull → A 切块 → B 攒块建行。
    let haves = a_eng.on_relay_msg(&mut a_conn, &mut a_clock, &b_clock.device_id().to_string(), Msg::BlobWant { image_id: img.clone() }).unwrap();
    let have_msg = match &haves[0] {
        Output::Send { msg, .. } => msg.clone(),
        other => panic!("期待 have,得到 {other:?}"),
    };
    let pulls = b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have_msg).unwrap();
    let pull_msg = match &pulls[0] {
        Output::Send { msg, lane, .. } => {
            assert_eq!(*lane, Lane::Direct, "拉流走 direct");
            msg.clone()
        }
        other => panic!("期待 pull,得到 {other:?}"),
    };
    let served = a_eng.on_relay_msg(&mut a_conn, &mut a_clock, &b_clock.device_id().to_string(), pull_msg).unwrap();
    for msg in wire_out(&mut a_eng, &a_conn, served) {
        let outs = b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
        assert!(!frame_rejected(&outs), "字节验货必须过(长度+sha256)");
    }
    let (got, seq): (Vec<u8>, i64) = b_conn
        .query_row("SELECT data, seq FROM item_image WHERE id = ?1", [&img], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(got, bytes, "字节逐位相等");
    assert_eq!(seq, 1, "行 seq 取 reconcile 重算值");
    assert!(b_eng.missing_blobs.is_empty());

    // deny 路:行删掉后再被 pull,应答 deny(回显 transfer);拉方回 missing 清单。
    images::remove(&mut a_conn, &mut a_clock, &img).unwrap();
    let denies = a_eng
        .on_relay_msg(
            &mut a_conn,
            &mut a_clock,
            "B",
            Msg::BlobPull { image_id: img.clone(), transfer: "01TRANSFER000000000000000X".into() },
        )
        .unwrap();
    assert!(matches!(
        &denies[0],
        Output::Send { msg: Msg::BlobDeny { .. }, lane: Lane::Direct, .. }
    ));
}

#[test]
fn blob_chunks_reject_stale_transfer_and_cap_overrun() {
    // codex 二轮 #4:上一次拉流的残帧靠 transfer 区分;攒块超过 add 声明的字节数
    // 立即作废(对端无尽 last=false 块撑不爆内存)。
    let (mut a_conn, mut a_clock, _a_eng) = fresh();
    let (mut b_conn, mut b_clock, mut b_eng) = fresh();
    let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
    let bytes = [7u8; 10];
    let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
    let a_id = a_clock.device_id().to_string();
    b_eng.relay_up(&b_conn).unwrap(); // 会话在
    b_eng.on_relay_peer_up(&a_id); // A 的中转腿 Up(选路前提,§5.1)
    // B 拿到 A 的 op(借帧构造),进入缺字节态,再收 have 进入拉流。
    let frames = ops_frames(&a_conn, &a_id, 1, watermark(&a_conn, &a_id).unwrap(), "B").unwrap();
    for f in frames {
        if let Output::Send { msg, .. } = f {
            b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
        }
    }
    b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
    let live_transfer = b_eng.pulling[&img].transfer.clone();
    // 残帧(错 transfer):静默丢,进行中的拉流不受伤。
    let outs = b_eng
        .on_relay_msg(
            &mut b_conn,
            &mut b_clock,
            &a_id,
            Msg::BlobChunk {
                image_id: img.clone(),
                transfer: "01STALETRANSFER0000000000X".into(),
                idx: 0,
                last: false,
                data: vec![1, 2, 3],
            },
        )
        .unwrap();
    assert!(outs.is_empty() && b_eng.pulling.contains_key(&img), "残帧不打断进行中的拉流");
    // 超量块(> add 声明的 10 字节):拉流作废回清单,**并按坏块收口**——shun 这条
    // 腿 + 罚它 + 当场重问(实现审二轮 M2:只作废就再没有触发器;先 shun 才不会
    // 重问一圈又撞回同一个作恶者)。
    let outs = b_eng
        .on_relay_msg(
            &mut b_conn,
            &mut b_clock,
            &a_id,
            Msg::BlobChunk {
                image_id: img.clone(),
                transfer: live_transfer,
                idx: 0,
                last: false,
                data: vec![0u8; 11],
            },
        )
        .unwrap();
    assert!(!b_eng.pulling.contains_key(&img) && b_eng.missing_blobs.contains(&img),
        "超量攒块 = 作废回清单");
    assert!(
        outs.iter().any(|o| matches!(o, Output::Send { to, lane: Lane::Mail, route_hint: RouteHint::Auto, msg: Msg::BlobWant { image_id } }
            if to == BROADCAST && image_id == &img)),
        "坏块作废后必须当场重问:{outs:?}"
    );
    assert!(b_eng.blob_penalized(&a_id, Route::Relay), "坏块 = 罚这条腿");
    // 重问引来的下一枚 have 还是它:被 shun 挡住,不会立刻再撞同一个作恶者。
    let outs = b_eng
        .on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() })
        .unwrap();
    assert!(outs.is_empty() && b_eng.pulling.is_empty(), "坏块来源已被 shun:{outs:?}");
}

#[test]
fn failed_verification_shuns_the_source_and_asks_again() {
    // 实现审二轮 M2:终局验货不过(坏字节)与坏块同一收口——不 shun 就会立刻从同一
    // 来源再拉同一份坏字节,不重问就永远停在清单里。
    let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
    eng.on_relay_peer_up(&a_id);
    eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
    let transfer = eng.pulling[&img].transfer.clone();
    // 长度对得上(夹具 12 字节)但内容不是原图 → sha256 验货必挂。
    let outs = eng
        .on_relay_msg(
            &mut conn,
            &mut clock,
            &a_id,
            Msg::BlobChunk { image_id: img.clone(), transfer, idx: 0, last: true, data: vec![9u8; 12] },
        )
        .unwrap();
    assert!(frame_rejected(&outs), "坏字节要响亮报一次:{outs:?}");
    assert!(
        outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::BlobWant { image_id }, .. } if image_id == &img)),
        "验货失败后当场重问:{outs:?}"
    );
    assert!(eng.blob_penalized(&a_id, Route::Relay), "验货失败 = 罚这条腿");
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "坏字节不落地");
}

#[test]
fn stale_pull_expires_reshuns_and_rerequests() {
    // M1:对端应了 BlobHave 却不发块(恶意或 bug)——连续心跳后作废本次拉流、回缺
    // 字节清单重发 want,并避开这个沉默来源,让别的设备应答。
    let (mut a_conn, mut a_clock, _a) = fresh();
    let (mut b_conn, mut b_clock, mut b) = fresh();
    let item = notes::capture(&mut a_conn, &mut a_clock, "带图").unwrap();
    let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &[9u8; 10], "image/png").unwrap();
    let a_id = a_clock.device_id().to_string();
    const OTHER: &str = "OTHERPEERDEVICE00000000000";
    b.relay_up(&b_conn).unwrap(); // 会话在(两层缺一不可,实现审 M2)
    b.on_relay_peer_up(&a_id); // 两台的中转腿都 Up(选路前提,§5.1)
    b.on_relay_peer_up(OTHER);
    // B 拿到 A 的 op → 进缺字节态;A(沉默源)应 have → B 拉流。
    let frames = ops_frames(&a_conn, &a_id, 1, watermark(&a_conn, &a_id).unwrap(), "B").unwrap();
    for f in frames {
        if let Output::Send { msg, .. } = f {
            b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
        }
    }
    b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
    assert!(b.pulling.contains_key(&img), "have 后进入拉流");
    // 沉默:连续心跳到阈值,作废回清单 + 重发 want。
    let mut wants = vec![];
    for _ in 0..PULL_STALE_TICKS {
        wants = b.on_tick();
    }
    assert!(!b.pulling.contains_key(&img) && b.missing_blobs.contains(&img), "超时作废回清单");
    // 恰一枚:`fail_pull` 自带的重问与 `on_tick` 出口那一批会撞车(实现审二轮 L1——
    // `on_tick` 原先直接 extend,漏了去重)。
    assert_eq!(
        wants.iter().filter(|o| want_image_of(o) == Some(img.as_str())).count(),
        1,
        "作废时当场重发 want,且同图只发一枚:{wants:?}"
    );
    // 同一沉默来源(A)再应 have:这条腿被避开,不再拉它。
    let outs = b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
    assert!(outs.is_empty() && !b.pulling.contains_key(&img), "避开刚超时的来源");
    // 别的来源(C)应 have:正常拉流(shun 是 per (image, device, route),不是全局)。
    let _ = b.on_relay_msg(&mut b_conn, &mut b_clock, OTHER, Msg::BlobHave { image_id: img.clone() }).unwrap();
    assert!(b.pulling.contains_key(&img), "换来源可拉");
    // 中转重连是新会话:relay 维度的避开名单与惩罚清零(人人这条腿再给一次机会)。
    b.relay_up(&b_conn).unwrap();
    assert!(b.blob_shunned.is_empty(), "relay 会话重连清 relay 维度的避开名单");
    assert!(!b.blob_penalized(&a_id, Route::Relay), "同时清 relay 惩罚");
}

#[test]
fn space_op_applied_emits_space_name_changed_and_stale_does_not() {
    // space-name-sync-plan §4.7 三入口之 live replay:Applied 才发专用事件;
    // LwwStale(名字没变)不惊扰壳。
    let (mut conn, mut clock, mut eng) = fresh();
    let mk_space = |dev: &str, wall: u64, seq: i64, value: serde_json::Value| RemoteOp {
        op_id: Ulid::new().to_string(),
        hlc: Hlc { wall_ms: wall, counter: 0, device_id: dev.into() }.encode(),
        entity: "space".into(),
        entity_id: "profile".into(),
        kind: "set_field".into(),
        payload: json!({"field": "name", "value": value}),
        origin_seq: seq,
    };
    let op = mk_space(DEV, 2_000, 1, json!("新名"));
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
        .unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Event(Event::SpaceNameChanged))),
        "space op 落地必须发专用事件:{outs:?}"
    );
    // 另一 origin 的更低 HLC 迟到写:LwwStale 只记账,不发事件。
    let other = "BREMTE00000000000000000001";
    let stale = mk_space(other, 1_000, 1, json!("旧名"));
    let outs2 = eng
        .on_relay_msg(&mut conn, &mut clock, other, Msg::Ops { origin: other.into(), ops: vec![stale] })
        .unwrap();
    assert!(
        !outs2.iter().any(|o| matches!(o, Output::Event(Event::SpaceNameChanged))),
        "LwwStale 名字没变,不该惊扰壳:{outs2:?}"
    );
    let name: Option<String> = conn
        .query_row("SELECT name FROM space_profile WHERE key = 'profile'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(name.as_deref(), Some("新名"));
}

#[test]
fn clock_skew_warns_once_per_session() {
    // L1:远端 op 的 HLC 墙钟比本机快 >24h,报一次时钟偏斜(不拒帧)。
    let (mut conn, mut clock, mut eng) = fresh();
    let future = crate::clock::wall_now_ms() + 48 * 60 * 60 * 1000; // 快 48h
    let op = topic_op(DEV, future, 1, "01SKEWTOPICAAAAAAAAAAAAAAA");
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
        .unwrap();
    let ahead = outs
        .iter()
        .find_map(|o| match o {
            Output::Event(Event::ClockSkew { ahead_hours }) => Some(*ahead_hours),
            _ => None,
        })
        .expect("远端时钟快 48h 必须报偏斜");
    assert!((46..=49).contains(&ahead), "偏斜小时数约 48,得 {ahead}");
    assert!(!frame_rejected(&outs), "偏斜只提示不拒帧");
    // 第二帧(仍是未来时钟)不再重报——每会话一次。
    let op2 = topic_op(DEV, future + 1000, 2, "01SKEWTOPICBBBBBBBBBBBBBBB");
    let outs2 = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
        .unwrap();
    assert!(
        !outs2.iter().any(|o| matches!(o, Output::Event(Event::ClockSkew { .. }))),
        "时钟偏斜每会话只报一次"
    );
}

#[test]
fn local_correction_op_from_replay_is_pushed_immediately() {
    // codex 二轮 #6:「图N」翻案的正文修正走真 set_field 发射(replay.rs)——它是
    // 本机新 op,必须随本次 on_msg 立即广播,不许等下一条本地命令或重连。
    let (mut conn, mut clock, mut eng) = fresh();
    let item = notes::capture(&mut conn, &mut clock, "初稿").unwrap();
    images::attach(&mut conn, &mut clock, &item, &[0xA], "image/png").unwrap();
    notes::edit(&mut conn, &mut clock, &item, "定稿:见图1").unwrap(); // content 胜者=本机,晚于贴图
    let me = clock.device_id().to_string();
    // 远端更早(hlc 更小)的并发图1 到达:本机图顺延成图2,正文修正为「见图2」。
    let add = RemoteOp {
        op_id: Ulid::new().to_string(),
        hlc: Hlc { wall_ms: 1_000, counter: 0, device_id: "AREMTE00000000000000000001".into() }.encode(),
        entity: "image".into(),
        entity_id: "01REMOTEIMGENG00000000000X".into(),
        kind: "image_add".into(),
        payload: json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8,
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000"}),
        origin_seq: 1,
    };
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, "AREMOTE", Msg::Ops { origin: "AREMTE00000000000000000001".into(), ops: vec![add] })
        .unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Event(Event::ImagesRenumbered { content_rewritten: true, .. }))),
        "翻案 + 正文修正:{outs:?}"
    );
    // 第5笔:「当场广播」= 当场**登记**并摇铃(描述符),帧由消费腿取。两层都验:
    // 只验描述符会漏掉「登记的区间不对」,只验帧会漏掉「没人来取」。
    assert!(
        outs.iter().any(|o| matches!(o, Output::ServeOps(s) if s.to == OpsServeTo::Broadcast)),
        "回放中发射的修正 op 必须当场摇铃:{outs:?}"
    );
    let served = eng.drain_ops_for_test(&conn).unwrap();
    let pushed_own_op = sends(&served).iter().any(|m| matches!(m, Msg::Ops { origin, .. } if origin == &me));
    assert!(pushed_own_op, "而且抽得出那一枚本机 op:{served:?}");
    let content: String =
        conn.query_row("SELECT content FROM items WHERE id = ?1", [&item], |r| r.get(0)).unwrap();
    assert_eq!(content, "定稿:见图2");
}

/// **`ops_notice` 的正文必须是 `(target, class)` 的纯函数**——§6.2 ③ 要的三条去重
/// 语义(同一条不重报 / 新的盖旧的 / 被盖掉之后允许再报)整个挂在这一条上,换来的是
/// **零新状态**:`set_status` 本就「整只快照没变就不发事件」。
///
/// 日后往正文里掺进任何随请求变的量(seq / 计数 / 时刻),去重就**静默失效**——每一枚
/// 都成了「新快照」,状态面开始刷屏,而没有任何测试会红。故这条得有人守。
#[test]
fn an_ops_notice_is_a_pure_function_of_target_and_class() {
    const OTHER: &str = "01PEER9AAAAAAAAAAAAAAAAAAA";
    let text = |t: &str, c: OpsNoticeClass| match ops_notice(t, c) {
        Output::Event(Event::OpsNotice { text }) => text,
        other => panic!("ops_notice 必须产一枚 advisory 事件:{other:?}"),
    };
    let base = text(DEV, OpsNoticeClass::Overload);
    assert_eq!(base, text(DEV, OpsNoticeClass::Overload), "同 target 同类 → 必须逐字相同");
    assert_ne!(base, text(DEV, OpsNoticeClass::Collapsed), "换一类必须换话(不然盖不掉)");
    assert_ne!(base, text(OTHER, OpsNoticeClass::Overload), "换一台必须换话");
    assert_ne!(
        base,
        text(BROADCAST, OpsNoticeClass::Overload),
        "广播那一格说的是「本机新增内容」,与定向对账不是一回事"
    );
}

/// **有界 Hello 与它替下的全表扫必须给出同一份事实**(§6.2 ⑧ 留 [`watermarks`] 当
/// 对拍基准的全部理由;少了这只测,那个基准就只是块没人看的化石)。
///
/// 旧 [`watermarks`] 是 `GROUP BY origin` 全表扫(设计期实测 500 万行 / 2000 origin
/// 下 157.8 ms,且是**持着库锁在协调者里**跑的);新路按预算取子集 + 跨 Hello 轮转。
/// **换算法不许换答案**。
///
/// 两格分开断,少哪一格都能让假实现绿:
/// * 预算够 → 一枚就等于全表,**且游标复位**(轮转不启用,与旧路逐字同形);
/// * 预算极小 → 单枚必须是**真子集**(不然「有界」是假的),而绕满一圈的并集仍等于
///   全表(不然轮转在饿死某些 origin —— 表现出来就是「对端永远收不到我这一格的真实
///   水位」,而那种坏法在单枚上看着完全正常)。
#[test]
fn the_bounded_hello_watermarks_agree_with_the_full_table_scan_they_replaced() {
    let (conn, _clock, _eng) = fresh();
    // 五个 origin,水位刻意各不相同:全都一样的话「取错了行」也照样对得上。
    for (i, n) in [3i64, 1, 7, 2, 5].into_iter().enumerate() {
        let origin = format!("01RGN{i}AAAAAAAAAAAAAAAAAAAA");
        assert_eq!(origin.len(), 26, "origin 必须是 26 字符(oplog 的 origin 由 hlc 尾段生成)");
        for seq in 1..=n {
            conn.execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'topic', '01TOPICWMARK000000000000X', 'create', ?3, ?4)",
                (
                    Ulid::new().to_string(),
                    Hlc { wall_ms: 1_000 + seq as u64, counter: 0, device_id: origin.clone() }
                        .encode(),
                    serde_json::to_string(&json!({"title": "t"})).unwrap(),
                    seq,
                ),
            )
            .unwrap();
        }
    }
    let full = watermarks(&conn).unwrap();
    assert_eq!(full.len(), 5, "五个 origin 都得在");

    // ① 预算够:一枚 = 全表,游标复位。
    let mut cursor = ops_serve::HelloCursor::default();
    let one = ops_serve::bounded_watermarks(&conn, &mut cursor, 64 * 1024).unwrap();
    assert_eq!(one, full, "装得下就必须与旧路逐字相同");
    assert_eq!(cursor, ops_serve::HelloCursor::default(), "装得下 → 游标复位,轮转不启用");

    // ② 预算极小:单枚是真子集,绕满一圈的并集仍是全表。
    let mut cursor = ops_serve::HelloCursor::default();
    let mut union: BTreeMap<String, i64> = BTreeMap::new();
    for round in 1..=20 {
        let part = ops_serve::bounded_watermarks(&conn, &mut cursor, 1).unwrap();
        assert!(!part.is_empty(), "预算再小也得至少带一条(带不动 = 游标不前进 = 死循环)");
        assert!(part.len() < full.len(), "1 字节预算还能带全 = 有界是假的");
        union.extend(part);
        if union == full {
            break;
        }
        assert!(round < 20, "轮转该在几枚之内绕完,实跑 {round} 枚仍缺:{union:?}");
    }
    assert_eq!(union, full, "轮转拼出来的并集必须与全表逐字相同");
}

#[test]
fn ops_frames_split_by_encoded_bytes_and_keep_order() {
    // §5「≤500 条或 256 KiB 先到为准」的字节半(P2-g 补齐):三条 ~150 KiB 的
    // set_field op 两两同帧必超预算 → 一条一帧;小 op 照旧并帧。顺序与完整性不变。
    let (conn, _clock, _eng) = fresh();
    let big = "长".repeat(50_000); // ~150 KB UTF-8
    for seq in 1..=3i64 {
        conn.execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, 'item', '01ITEMBYTES00000000000000X', 'set_field', ?3, ?4)",
            (
                Ulid::new().to_string(),
                Hlc { wall_ms: 1_000 + seq as u64, counter: 0, device_id: DEV.into() }.encode(),
                serde_json::to_string(&json!({"field": "content", "value": big})).unwrap(),
                seq,
            ),
        )
        .unwrap();
    }
    let frames = ops_frames(&conn, DEV, 1, 3, "X").unwrap();
    assert_eq!(frames.len(), 3, "大 op 按编码字节独立成帧");
    let mut seen = vec![];
    for f in &frames {
        let Output::Send { msg: Msg::Ops { ops, .. }, .. } = f else { panic!("必须是 ops 帧") };
        assert!(ops.iter().map(encoded_op_len).sum::<usize>() <= MAX_OPS_FRAME_BYTES);
        seen.extend(ops.iter().map(|o| o.origin_seq));
    }
    assert_eq!(seen, vec![1, 2, 3], "切帧不重排不丢条");
    // 对照:小 op 不触字节线,仍按条数并帧。
    let (mut conn2, mut clock2, _e2) = fresh();
    notes::capture(&mut conn2, &mut clock2, "小条目甲").unwrap();
    notes::capture(&mut conn2, &mut clock2, "小条目乙").unwrap();
    let me = clock2.device_id().to_string();
    let max = watermark(&conn2, &me).unwrap();
    let frames = ops_frames(&conn2, &me, 1, max, "X").unwrap();
    assert_eq!(frames.len(), 1, "小 op 仍并成单帧");
}

/// 把 A 库的全量 op 借帧喂给引擎(测试小工具:hello 机制的手动形)。
fn feed_all_ops(
    src: &Connection,
    src_dev: &str,
    conn: &mut Connection,
    clock: &mut Clock,
    eng: &mut Engine,
) -> Vec<Output> {
    let frames = ops_frames(src, src_dev, 1, watermark(src, src_dev).unwrap(), "X").unwrap();
    let mut outs = vec![];
    for f in frames {
        if let Output::Send { msg, .. } = f {
            outs.extend(eng.on_relay_msg(conn, clock, src_dev, msg).unwrap());
        }
    }
    outs
}

fn any_blob_want(outs: &[Output]) -> bool {
    outs.iter().any(|o| {
        matches!(o, Output::Send { msg: Msg::BlobWant { .. } | Msg::BlobPull { .. }, .. })
    })
}

#[test]
fn metadata_only_never_wants_blobs_but_ops_and_counter_converge() {
    // M1 测试③:连续收 image_add / hello / 重连,都不发 BlobWant;op 记账、水位、
    // counter 治理照旧;行不建;serve 能力保留(on_blob_want 有行照答——本测试
    // 轻端无行,静默);天上掉的 have/chunk 防御性忽略。
    let (mut a_conn, mut a_clock, _a_eng) = fresh();
    let (mut b_conn, mut b_clock) = {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = crate::test_temp::dir()
            .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open");
        let clock = Clock::load(&conn).expect("clock");
        (conn, clock)
    };
    let mut b_eng = Engine::new_solo(&b_conn, BlobPolicy::MetadataOnly).expect("light engine");
    let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
    let bytes: Vec<u8> = (0u8..64).collect();
    let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
    let a_id = a_clock.device_id().to_string();

    // 收 image_add:不发 want、不进清单、行不建;水位与 counter 照推。
    let outs = feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_eng);
    assert!(!any_blob_want(&outs), "MetadataOnly 收 image_add 不发 want:{outs:?}");
    assert!(b_eng.missing_blobs.is_empty() && b_eng.pulling.is_empty());
    assert_eq!(watermark(&b_conn, &a_id).unwrap(), watermark(&a_conn, &a_id).unwrap());
    let rows: i64 =
        b_conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "轻端不建图行");
    let counter: i64 = b_conn
        .query_row("SELECT last_seq FROM item_image_counter WHERE item_id = ?1", [&item], |r| r.get(0))
        .unwrap();
    assert_eq!(counter, 1, "「图N」counter 治理照跑(replay 层,不依赖字节)");

    // 连续第二枚 image_add(单帧多 op 之外的续帧路径,codex P4-d 轮 M3):照旧
    // 零 want,counter 推到 2,行仍不建。
    images::attach(&mut a_conn, &mut a_clock, &item, &[0xEE; 32], "image/png").unwrap();
    let outs = feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_eng);
    assert!(!any_blob_want(&outs), "连续收 image_add 仍不发 want:{outs:?}");
    let counter: i64 = b_conn
        .query_row("SELECT last_seq FROM item_image_counter WHERE item_id = ?1", [&item], |r| r.get(0))
        .unwrap();
    assert_eq!(counter, 2, "第二枚 image_add 的 counter 治理照跑");
    let rows: i64 =
        b_conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "仍不建行");

    // 收 hello:补给帧照回,blob want 一枚不发。
    let outs = b_eng
        .on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::Hello { watermarks: BTreeMap::new(), lan: None })
        .unwrap();
    assert!(!any_blob_want(&outs), "hello 不重发 want:{outs:?}");

    // 重连:hello 照发,want 零。
    let outs = b_eng.relay_up(&b_conn).unwrap();
    assert!(outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::Hello { .. }, .. })));
    assert!(!any_blob_want(&outs), "重连不派生缺图清单:{outs:?}");

    // 防御:天上掉的 have / chunk(非本策略发起)一律忽略,不建行不崩(A 的中转腿
    // 特意置 Up——挡住它的必须是轻端策略,不是「没路可走」)。
    b_eng.on_relay_peer_up(&a_id);
    let outs =
        b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
    assert!(outs.is_empty() && b_eng.pulling.is_empty());
    let outs = b_eng
        .on_relay_msg(
            &mut b_conn,
            &mut b_clock,
            &a_id,
            Msg::BlobChunk {
                image_id: img.clone(),
                transfer: "01UNSOLICITEDTRANSFER00000".into(),
                idx: 0,
                last: true,
                data: bytes.clone(),
            },
        )
        .unwrap();
    assert!(outs.is_empty());
    let rows: i64 =
        b_conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "未经拉流的字节不落地");
}

#[test]
fn switching_back_to_full_rediscovers_and_backfills() {
    // M1 测试④:轻端库换回 Full 策略重建引擎,on_runtime_started 的 derive_missing_blobs
    // 重新发现全部缺口 → want → have → pull → chunk → 行建齐,字节逐位相等。
    let (mut a_conn, mut a_clock, mut a_eng) = fresh();
    let (mut b_conn, mut b_clock) = {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = crate::test_temp::dir()
            .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open");
        let clock = Clock::load(&conn).expect("clock");
        (conn, clock)
    };
    let mut b_light = Engine::new_solo(&b_conn, BlobPolicy::MetadataOnly).expect("light");
    let item = notes::capture(&mut a_conn, &mut a_clock, "轻端期间的图").unwrap();
    let bytes: Vec<u8> = (100u8..200).collect();
    let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
    let a_id = a_clock.device_id().to_string();
    let b_id = b_clock.device_id().to_string();
    let outs = feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_light);
    assert!(!any_blob_want(&outs));
    drop(b_light);

    // 同一库、Full 策略重建(引擎状态本就可丢):装配即发现缺口(on_runtime_started
    // 派生清单),会话建立时把 want 发出去。
    let mut b_full = Engine::new_solo(&b_conn, BlobPolicy::Full).expect("full");
    b_full.on_runtime_started(&b_conn).unwrap();
    let outs = b_full.relay_up(&b_conn).unwrap();
    b_full.on_relay_peer_up(&a_id); // 在线快照恒在会话建立之后(先后颠倒即被清掉)
    let want = outs
        .iter()
        .find_map(|o| match o {
            Output::Send { msg: Msg::BlobWant { image_id }, .. } => Some(image_id.clone()),
            _ => None,
        })
        .expect("切回 Full 必须重新发现缺图并发 want");
    assert_eq!(want, img);
    // 走完 have → pull → chunk,行建齐。
    let haves = a_eng.on_relay_msg(&mut a_conn, &mut a_clock, &b_id, Msg::BlobWant { image_id: img.clone() }).unwrap();
    let have = match &haves[0] {
        Output::Send { msg, .. } => msg.clone(),
        other => panic!("期待 have,得到 {other:?}"),
    };
    let pulls = b_full.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have).unwrap();
    let pull = match &pulls[0] {
        Output::Send { msg, .. } => msg.clone(),
        other => panic!("期待 pull,得到 {other:?}"),
    };
    let served = a_eng.on_relay_msg(&mut a_conn, &mut a_clock, &b_id, pull).unwrap();
    for msg in wire_out(&mut a_eng, &a_conn, served) {
        b_full.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
    }
    let got: Vec<u8> = b_conn
        .query_row("SELECT data FROM item_image WHERE id = ?1", [&img], |r| r.get(0))
        .unwrap();
    assert_eq!(got, bytes, "补齐后字节逐位相等");
    assert!(b_full.missing_blobs.is_empty());
}

/// 117(codex H2):`pending_blob_count` = `derive_missing_blobs` 的计数投影——
/// 壳层「全部同步」用它判「字节还在途」。全程与 derive 同步演变:源端(行在)
/// 恒 0;轻端收 op 未收字节 = 1;字节补齐落行 = 0。
#[test]
fn pending_blob_count_mirrors_missing_set() {
    let (mut a_conn, mut a_clock, _a_eng) = fresh();
    let (mut b_conn, mut b_clock) = {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = crate::test_temp::dir()
            .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open");
        let clock = Clock::load(&conn).expect("clock");
        (conn, clock)
    };
    let mut b_light = Engine::new_solo(&b_conn, BlobPolicy::MetadataOnly).expect("light");
    assert_eq!(crate::sync::transport::pending_blob_count(&b_conn).unwrap(), 0);

    let item = notes::capture(&mut a_conn, &mut a_clock, "计数条目").unwrap();
    let bytes: Vec<u8> = (7u8..77).collect();
    let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
    let a_id = a_clock.device_id().to_string();
    assert_eq!(
        crate::sync::transport::pending_blob_count(&a_conn).unwrap(),
        0,
        "源端行在,不缺字节"
    );

    // 轻端收 op 未收字节:计数 = 1,且与 derive 集合一致。
    feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_light);
    assert_eq!(crate::sync::transport::pending_blob_count(&b_conn).unwrap(), 1);
    assert_eq!(
        derive_missing_blobs(&b_conn).unwrap(),
        HashSet::from([img.clone()]),
        "计数与集合同一判据"
    );

    // 字节补齐(replay 旁路建行):计数归 0。
    crate::replay::apply_image_bytes(&mut b_conn, &img, &bytes).unwrap();
    assert_eq!(crate::sync::transport::pending_blob_count(&b_conn).unwrap(), 0);
}

/// phone-space-plan §1.1:引导源「无缺字节」防线——字节有洞的端对 BootReq 不产
/// 快照(静默拒供,Ok(None)),补齐后恢复供给;查与照在同一把锁内由调用方保证,
/// 这里钉判定函数三态里的前两态(Err 态见下一测)。
#[test]
fn boot_source_refuses_snapshot_with_pending_blobs() {
    use crate::sync::transport::boot_serve_snapshot;
    let (mut a_conn, mut a_clock, _a_eng) = fresh();
    let (mut b_conn, mut b_clock) = {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = crate::test_temp::dir()
            .join(format!("ys-nb-engine-boot-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open");
        let clock = Clock::load(&conn).expect("clock");
        (conn, clock)
    };
    let mut b_light = Engine::new_solo(&b_conn, BlobPolicy::MetadataOnly).expect("light");
    let dir = crate::test_temp::dir().join(format!(
        "ys-nb-engine-boot-snap-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();

    let item = notes::capture(&mut a_conn, &mut a_clock, "洞快照防线").unwrap();
    let bytes: Vec<u8> = (1u8..99).collect();
    let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
    let a_id = a_clock.device_id().to_string();

    // 源端(字节齐):供。
    let snap = boot_serve_snapshot(&a_conn, &dir).unwrap().expect("无洞端必须供快照");
    std::fs::remove_file(&snap.path).unwrap();

    // 收 op 未收字节(洞):静默拒供——不产快照、不留文件。
    feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_light);
    assert_eq!(crate::sync::transport::pending_blob_count(&b_conn).unwrap(), 1);
    assert!(
        boot_serve_snapshot(&b_conn, &dir).unwrap().is_none(),
        "字节有洞的端不许当引导源"
    );

    // 字节补齐:恢复供给。
    crate::replay::apply_image_bytes(&mut b_conn, &img, &bytes).unwrap();
    let snap = boot_serve_snapshot(&b_conn, &dir).unwrap().expect("补齐后恢复供给");
    std::fs::remove_file(&snap.path).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

/// phone-space-plan §1.1 第三态:完整性查询本机故障 = 响亮拒供(Err),绝不把
/// 查询失败当 0 供出洞快照(fail-fast 铁律)。
#[test]
fn boot_source_refuses_on_pending_query_error() {
    use crate::sync::transport::boot_serve_snapshot;
    let (conn, _clock, _eng) = fresh();
    let dir = crate::test_temp::dir().join(format!(
        "ys-nb-engine-boot-err-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    // 弄坏完整性查询的依赖面(item_image 表没了 = derive_missing_blobs 必 Err)。
    conn.execute_batch("DROP TABLE item_image").unwrap();
    let err = boot_serve_snapshot(&conn, &dir).unwrap_err();
    assert!(err.contains("图字节完整性检查失败"), "错误必须响亮可辨:{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- OriginSlot 单槽池:LRU 驱逐 + 公平性(epoch-plan §5.1,2a 工序3) ----

/// 槽池满额时新 origin 入座驱逐 LRU 槽:整槽释放(队列/挂起/want 节流一体)、
/// 水位不动、对被逐 origin 发一次**无状态** want——复用「丢弃+want」自愈路径。
#[test]
fn slot_pool_evicts_lru_with_stateless_want_when_full() {
    let (mut conn, mut clock, eng) = fresh();
    let mut eng = eng.with_slot_cap(2);
    let dev = |i: usize| format!("EVCTDEV{i:03}0000000000000000");
    // 两个 origin 各留缺口(只送 seq2)占满槽池。
    for i in 0..2 {
        let op = topic_op(&dev(i), 1_000 + i as u64, 2, &format!("01TOPICEVICT{i:014}"));
        eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(i), ops: vec![op] })
            .unwrap();
    }
    assert_eq!(eng.slots.len(), 2);
    // 第三个 origin 到来:驱逐最旧(dev0),为它发无状态 want(from_seq = 水位+1 = 1)。
    let op = topic_op(&dev(2), 3_000, 2, "01TOPICEVICT00000000000002");
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(2), ops: vec![op] })
        .unwrap();
    assert_eq!(eng.slots.len(), 2, "槽数恒有界");
    assert!(!eng.slots.contains_key(&dev(0)), "LRU(最早触碰)被逐");
    assert!(eng.slots.contains_key(&dev(2)), "新 origin 入座");
    assert!(
        sends(&outs).iter().any(|m| matches!(m, Msg::Want { origin, from_seq: 1 } if *origin == dev(0))),
        "驱逐必须携带对被逐 origin 的无状态 want:{outs:?}"
    );
    // 被逐 origin 的数据没丢(水位没动):seq1+seq2 重投即补齐,槽用完即释放。
    let ops = vec![
        topic_op(&dev(0), 1_000, 1, "01TOPICEVICTA0000000000001"),
        topic_op(&dev(0), 1_001, 2, "01TOPICEVICTA0000000000002"),
    ];
    eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(0), ops }).unwrap();
    assert_eq!(watermark(&conn, &dev(0)).unwrap(), 2, "被逐 origin 重投后收敛");
    assert!(!eng.slots.contains_key(&dev(0)), "补齐后整槽释放");
}

/// 公平性对抗(§5.1):超槽数的合法未决 origin 持续乱序下 round-robin 不活锁、
/// 不反复驱逐同一组——每个 origin 的帧到场即按水位连续应用,槽只在「有缺口」时
/// 占用,重投轮转后全员收敛。
#[test]
fn slot_pool_stays_fair_with_more_origins_than_slots() {
    let (mut conn, mut clock, eng) = fresh();
    let mut eng = eng.with_slot_cap(8);
    let n = 12usize;
    let dev = |i: usize| format!("FA1RDEV{i:03}0000000000000000");
    // 预造全部 op(重投必须是**同一枚** op——换 op_id 重造是分叉,不是重传)。
    let history: Vec<[RemoteOp; 2]> = (0..n)
        .map(|i| {
            [
                topic_op(&dev(i), 1_000 + i as u64 * 10, 1, &format!("01TOPICFAIR1{i:014}")),
                topic_op(&dev(i), 1_001 + i as u64 * 10, 2, &format!("01TOPICFAIR2{i:014}")),
            ]
        })
        .collect();
    // 第一轮:全员只送 seq2(人人留缺口)——超出 8 槽的部分触发 LRU 驱逐。
    for i in 0..n {
        let op = history[i][1].clone();
        eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(i), ops: vec![op] })
            .unwrap();
    }
    assert!(eng.slots.len() <= 8, "槽数恒有界:{}", eng.slots.len());
    // 第二轮:round-robin 重投完整段 [seq1, seq2](模拟 want 的应答):无论槽还
    // 在不在,帧到即连续应用(在槽的 seq2 判重传丢弃)——一轮内全员必须收敛,
    // 无活锁、无永久饥饿。
    for i in 0..n {
        let ops = vec![history[i][0].clone(), history[i][1].clone()];
        eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(i), ops }).unwrap();
    }
    for i in 0..n {
        assert_eq!(watermark(&conn, &dev(i)).unwrap(), 2, "origin {i} 必须收敛");
    }
    assert!(eng.slots.is_empty(), "全员收敛后槽池全空");
}

// ---- typed poison:持久 quarantine / breaker / frozen 上界(epoch-plan §4,2a 工序2) ----

/// 手搓一枚 shape 非法 op(topic create 缺 title——已知词汇下的字段缺失 = InvalidOp)。
fn poison_op(device: &str, wall_ms: u64, seq: i64) -> RemoteOp {
    RemoteOp {
        op_id: Ulid::new().to_string(),
        hlc: Hlc { wall_ms, counter: 0, device_id: device.into() }.encode(),
        entity: "topic".into(),
        entity_id: format!("01POISON{:018}", seq),
        kind: "create".into(),
        payload: json!({"created_at": "2026-07-15T00:00:00Z"}), // 缺 title
        origin_seq: seq,
    }
}

fn quarantine_row(
    conn: &Connection,
    origin: &str,
) -> Option<(String, Option<Vec<u8>>, Option<String>, String, Option<String>, Option<String>, i64)>
{
    conn.query_row(
        "SELECT op_id, op_blob, op_sha256, error_stage, relay_from_first, relay_from_last, \
         validator_ver FROM sync_quarantine WHERE origin = ?1",
        [origin],
        |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        },
    )
    .optional()
    .unwrap()
}

#[test]
fn invalid_op_quarantines_origin_persists_and_drops_later_frames() {
    let (mut conn, mut clock, mut eng) = fresh();
    let bad = poison_op(DEV, 1_000, 1);
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, "RELAY-A", Msg::Ops { origin: DEV.into(), ops: vec![bad.clone()] })
        .unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Event(Event::OriginQuarantined { origin, relay_from, .. })
            if origin == DEV && relay_from == "RELAY-A")),
        "毒 op 必须报 OriginQuarantined 双坐标:{outs:?}"
    );
    let (op_id, blob, sha, stage, first, last, ver) =
        quarantine_row(&conn, DEV).expect("隔离行必须落盘");
    assert_eq!(op_id, bad.op_id);
    assert_eq!(stage, "shape");
    assert!(blob.is_some() && sha.is_none(), "常规尺寸 op 存完整材料");
    assert_eq!((first.as_deref(), last.as_deref()), (Some("RELAY-A"), Some("RELAY-A")));
    assert_eq!(ver, crate::replay::VALIDATOR_VER);
    assert_eq!(watermark(&conn, DEV).unwrap(), 0, "毒 op 不记账不推水位");
    // 后续帧(哪怕合法)帧到即丢,只更新 relay_from_last。
    let good = topic_op(DEV, 2_000, 1, "01TOPICQQQQQQQQQQQQQQQQQ1");
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, "RELAY-B", Msg::Ops { origin: DEV.into(), ops: vec![good.clone()] })
        .unwrap();
    assert!(outs.is_empty(), "隔离后帧到即丢:{outs:?}");
    let (.., last2, _) = {
        let r = quarantine_row(&conn, DEV).unwrap();
        (r.0, r.4, r.5, r.6)
    };
    assert_eq!(last2.as_deref(), Some("RELAY-B"), "relay_from_last 必须跟进最近投递者");
    // 重启(新引擎实例):隔离态从表装载,依旧丢帧——「重启即忘」正是要关的洞。
    let mut eng2 = Engine::new_solo(&conn, BlobPolicy::Full).unwrap();
    let outs = eng2
        .on_relay_msg(&mut conn, &mut clock, "RELAY-C", Msg::Ops { origin: DEV.into(), ops: vec![good] })
        .unwrap();
    assert!(outs.is_empty(), "重启后隔离仍生效:{outs:?}");
    assert_eq!(watermark(&conn, DEV).unwrap(), 0);
}

#[test]
fn dependency_missing_and_unknown_vocab_suspend_not_quarantine() {
    let (mut conn, mut clock, mut eng) = fresh();
    // 未知 kind = 版本偏斜:挂起等升级,不隔离。
    let mut vocab = topic_op(DEV, 1_000, 1, "01TOPICVVVVVVVVVVVVVVVVV1");
    vocab.kind = "kind_from_the_future".into();
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![vocab] })
        .unwrap();
    assert!(outs.iter().any(|o| matches!(o, Output::Event(Event::OriginSuspended { .. }))));
    assert!(quarantine_row(&conn, DEV).is_none(), "版本偏斜绝不隔离");
    assert!(eng.is_suspended(DEV));
    // 依赖未到(set_field 先于 create,行缺失无墓碑):挂起自愈,不隔离。
    let orphan = RemoteOp {
        op_id: Ulid::new().to_string(),
        hlc: Hlc { wall_ms: 1_000, counter: 0, device_id: "DEPDEV0000000000000000001X".into() }.encode(),
        entity: "item".into(),
        entity_id: "01NOSUCHITEM0000000000000X".into(),
        kind: "set_field".into(),
        payload: json!({"field": "content", "value": "无主"}),
        origin_seq: 1,
    };
    eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: "DEPDEV0000000000000000001X".into(), ops: vec![orphan] })
        .unwrap();
    assert!(quarantine_row(&conn, "DEPDEV0000000000000000001X").is_none());
    assert!(eng.is_suspended("DEPDEV0000000000000000001X"));
}

#[test]
fn stateful_invalid_at_apply_quarantines_with_apply_stage() {
    let (mut conn, mut clock, mut eng) = fresh();
    // seq1 合法 create 落地;seq2 对同一 entity_id 再来一条 shape 合法的 create
    // = 状态型非法(重复 create,apply 层拒)→ 隔离,error_stage = 'apply'。
    let c1 = topic_op(DEV, 1_000, 1, "01TOPICAPPLYSTAGE00000001");
    eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c1] })
        .unwrap();
    let c2 = topic_op(DEV, 2_000, 2, "01TOPICAPPLYSTAGE00000001");
    let outs = eng
        .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c2] })
        .unwrap();
    assert!(outs.iter().any(|o| matches!(o, Output::Event(Event::OriginQuarantined { .. }))));
    let (_, _, _, stage, ..) = quarantine_row(&conn, DEV).expect("隔离行必须落盘");
    assert_eq!(stage, "apply", "shape 过而 apply 拒 = 状态型,归 'apply'");
    assert_eq!(watermark(&conn, DEV).unwrap(), 1, "已落地的 seq1 不受影响");
}

#[test]
fn oversized_poison_op_stores_fingerprint_only() {
    let (mut conn, mut clock, mut eng) = fresh();
    let mut bad = poison_op(DEV, 1_000, 1);
    bad.payload = json!({"created_at": "x".repeat(300 * 1024)}); // 仍缺 title,且超 256 KiB
    eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![bad] })
        .unwrap();
    let (_, blob, sha, ..) = quarantine_row(&conn, DEV).expect("超限 op 也要留档");
    assert!(blob.is_none(), "超限不存完整材料(内存/磁盘上界)");
    assert_eq!(sha.map(|s| s.len()), Some(64), "存 sha256 指纹供人工比对");
}

#[test]
fn frozen_over_cap_trips_persistent_breaker() {
    let (conn, _clock, mut eng) = fresh();
    // 直接驱动 freeze(分叉路径已有测试):FROZEN_CAP+1 个 origin 后 breaker 置位。
    for i in 0..=FROZEN_CAP {
        let outs = eng.freeze_v(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "伪造分叉".into()).unwrap();
        if i < FROZEN_CAP {
            assert!(
                !outs.iter().any(|o| matches!(o, Output::Event(Event::PoisonBreakerTripped { .. }))),
                "上限内不触发 breaker(第 {i} 个)"
            );
        } else {
            assert!(
                outs.iter().any(|o| matches!(o, Output::Event(Event::PoisonBreakerTripped { .. }))),
                "超上限必须触发 breaker"
            );
        }
    }
    assert!(eng.breaker.is_some());
    let kv: String = conn
        .query_row("SELECT value FROM sync_meta WHERE key = 'poison_breaker'", [], |r| r.get(0))
        .unwrap();
    assert!(kv.contains("冻结"), "置位原因落盘:{kv}");
    // 上界是**结构事实**(实现审 H1):到顶之后再来多少个分叉,表都不许再涨——
    // 旧写法「先插后判」下 breaker 只挡「新 origin」,已在册 origin 逐个来一遍
    // 就能把表撑到全部历史 origin 数(引擎活到 runtime 生命期后即真内存增长面)。
    for i in 100..110 {
        let outs = eng
            .freeze_v(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "又一个分叉".into())
            .unwrap();
        assert!(
            !outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
            "到顶后不再往表里加,也不再报 OriginFrozen(否则每帧刷屏)"
        );
    }
    assert_eq!(eng.frozen.len(), FROZEN_CAP, "冻结表恒不超上限");
}

#[test]
fn breaker_survives_restart_and_only_blocks_new_origins() {
    let (mut conn, mut clock, mut eng) = fresh();
    // 先让 DEV 在册(水位 1),再触发 breaker。
    let c1 = topic_op(DEV, 1_000, 1, "01TOPICBRKKNOWN0000000001");
    eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c1] })
        .unwrap();
    for i in 0..=FROZEN_CAP {
        eng.freeze_v(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "伪造分叉".into()).unwrap();
    }
    assert!(eng.breaker.is_some());
    // 重启:breaker 从 sync_meta 装载,fail-closed 不忘。
    let mut eng2 = Engine::new_solo(&conn, BlobPolicy::Full).unwrap();
    assert!(eng2.breaker.is_some(), "breaker 必须跨重启");
    // 新 origin 拒收(报一次 FrameRejected,再来静默)。
    let newcomer = topic_op("BRANDNEWDEV000000000000001", 1_000, 1, "01TOPICBRKNEW000000000001");
    let outs = eng2
        .on_relay_msg(&mut conn, &mut clock, "X", Msg::Ops { origin: "BRANDNEWDEV000000000000001".into(), ops: vec![newcomer.clone()] })
        .unwrap();
    assert!(frame_rejected(&outs), "新 origin 必须被拒:{outs:?}");
    assert_eq!(watermark(&conn, "BRANDNEWDEV000000000000001").unwrap(), 0);
    let outs = eng2
        .on_relay_msg(&mut conn, &mut clock, "X", Msg::Ops { origin: "BRANDNEWDEV000000000000001".into(), ops: vec![newcomer] })
        .unwrap();
    assert!(outs.is_empty(), "同 origin 每会话只报一次");
    // 已在册 origin(DEV,水位 1)照常同步。
    let c2 = topic_op(DEV, 2_000, 2, "01TOPICBRKKNOWN0000000002");
    eng2.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c2] })
        .unwrap();
    assert_eq!(watermark(&conn, DEV).unwrap(), 2, "已在册 origin 不受 breaker 影响");
    // 显式复位:清 KV + 内存镜像,新 origin 恢复接收。
    eng2.reset_breaker(&conn).unwrap();
    assert!(eng2.breaker.is_none());
    let again = topic_op("BRANDNEWDEV000000000000001", 3_000, 1, "01TOPICBRKNEW000000000002");
    eng2.on_relay_msg(&mut conn, &mut clock, "X", Msg::Ops { origin: "BRANDNEWDEV000000000000001".into(), ops: vec![again] })
        .unwrap();
    assert_eq!(watermark(&conn, "BRANDNEWDEV000000000000001").unwrap(), 1, "复位后恢复接收");
}

#[test]
fn quarantine_row_cap_trips_breaker() {
    let (mut conn, mut clock, mut eng) = fresh();
    let mut tripped_at = None;
    for i in 0..QUARANTINE_MAX_ROWS {
        let dev = format!("PSNDEV{i:03}00000000000000000");
        let bad = poison_op(&dev, 1_000 + i as u64, 1);
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev, ops: vec![bad] })
            .unwrap();
        if outs.iter().any(|o| matches!(o, Output::Event(Event::PoisonBreakerTripped { .. }))) {
            tripped_at = Some(i);
            break;
        }
    }
    assert_eq!(tripped_at, Some(QUARANTINE_MAX_ROWS - 1), "行数到顶必须触发 breaker");
    assert!(eng.breaker.is_some());
}

#[test]
fn reverify_keeps_still_invalid_releases_fixed_and_vocab_shifts() {
    let (mut conn, mut clock, mut eng) = fresh();
    // 三个 origin 各隔离一条毒 op。
    for (i, dev) in ["RVRFYDEV000A00000000000000", "RVRFYDEV000B00000000000000", "RVRFYDEV000C00000000000000"].iter().enumerate() {
        let bad = poison_op(dev, 1_000 + i as u64, 1);
        eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev.to_string(), ops: vec![bad] })
            .unwrap();
    }
    // 把三行都标成旧校验器版本;B 的材料替换成「新校验器接受」的合法 op,
    // C 的替换成「未知词汇」(版本挂起)。
    conn.execute("UPDATE sync_quarantine SET validator_ver = 0", []).unwrap();
    let fixed = topic_op("RVRFYDEV000B00000000000000", 2_000, 1, "01TOPICREVERIFYB000000001");
    conn.execute(
        "UPDATE sync_quarantine SET op_blob = ?2 WHERE origin = ?1",
        rusqlite::params!["RVRFYDEV000B00000000000000", serde_json::to_vec(&fixed).unwrap()],
    )
    .unwrap();
    let mut vocab = topic_op("RVRFYDEV000C00000000000000", 2_000, 1, "01TOPICREVERIFYC000000001");
    vocab.kind = "kind_from_the_future".into();
    conn.execute(
        "UPDATE sync_quarantine SET op_blob = ?2 WHERE origin = ?1",
        rusqlite::params!["RVRFYDEV000C00000000000000", serde_json::to_vec(&vocab).unwrap()],
    )
    .unwrap();
    let outs = reverify_ok(&mut eng, &mut conn, &mut clock);
    // A:仍非法 → 保留、版本抬到当前(下次不再重跑)。
    let (.., ver_a) = quarantine_row(&conn, "RVRFYDEV000A00000000000000").expect("仍非法必须保留");
    assert_eq!(ver_a, crate::replay::VALIDATOR_VER);
    assert!(eng.quarantined.contains("RVRFYDEV000A00000000000000"));
    // B:新校验器接受 → 清隔离、op 归池并已应用(drain)、发 want 追回丢弃段。
    assert!(quarantine_row(&conn, "RVRFYDEV000B00000000000000").is_none(), "修好的必须放出来");
    assert!(!eng.quarantined.contains("RVRFYDEV000B00000000000000"));
    assert_eq!(watermark(&conn, "RVRFYDEV000B00000000000000").unwrap(), 1, "归池后经 drain 落地");
    assert!(
        sends(&outs).iter().any(|m| matches!(m, Msg::Want { origin, from_seq: 1 } if origin == "RVRFYDEV000B00000000000000"))
            || watermark(&conn, "RVRFYDEV000B00000000000000").unwrap() == 1,
        "追帧 want 必须发出:{outs:?}"
    );
    // C:未知词汇 → 清隔离、转普通版本挂起(drain 里挂住,不再是隔离)。
    assert!(quarantine_row(&conn, "RVRFYDEV000C00000000000000").is_none());
    assert!(!eng.quarantined.contains("RVRFYDEV000C00000000000000"));
    assert!(eng.is_suspended("RVRFYDEV000C00000000000000"), "版本偏斜转挂起");
}

/// 测试小助手:本测不该有本地故障时,把输出取出来。
fn reverify_ok(eng: &mut Engine, conn: &mut Connection, clock: &mut Clock) -> Vec<Output> {
    let mut out = vec![];
    eng.reverify_quarantined(conn, clock, &mut out).expect("本测不该有本地故障");
    out
}

fn quarantine_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM sync_quarantine", [], |r| r.get(0)).unwrap()
}

/// 造 N 行「新校验器会接受」的待重验隔离行(故每行被放出来时都会发一枚 want)。
fn seed_reverifiable(conn: &mut Connection, clock: &mut Clock, eng: &mut Engine, n: usize) {
    for i in 0..n {
        let dev = reverify_dev(i);
        let bad = poison_op(&dev, 1_000 + i as u64, 1);
        eng.on_relay_msg(conn, clock, "R", Msg::Ops { origin: dev, ops: vec![bad] }).unwrap();
    }
    conn.execute("UPDATE sync_quarantine SET validator_ver = 0", []).unwrap();
    for i in 0..n {
        let fixed =
            topic_op(&reverify_dev(i), 2_000 + i as u64, 1, &format!("01TPCRVB{:018}", i));
        conn.execute(
            "UPDATE sync_quarantine SET op_blob = ?2 WHERE origin = ?1",
            rusqlite::params![reverify_dev(i), serde_json::to_vec(&fixed).unwrap()],
        )
        .unwrap();
    }
}

fn reverify_dev(i: usize) -> String {
    format!("RVBATCHDEV{i:016}")
}

/// 把槽池塞满,返回「下一个会被 LRU 驱逐的那个 origin」。
///
/// 每个槽的队头都是 seq 2(水位 0,有洞),故 `drain` 一律走「等 want 补」那条 break
/// ——槽稳稳占着,不会被顺手清空。
fn fill_slots(conn: &Connection, eng: &mut Engine) -> String {
    for i in 0..eng.slot_cap {
        let origin = format!("EVICTDEV{i:018}");
        let op = topic_op(&origin, 3_000 + i as u64, 2, &format!("01TPCEVCT{i:017}"));
        eng.slot_insert(conn, &origin, PendingOp { op, relay_from: "R".into() }, &mut vec![])
            .expect("塞槽本身不该失败");
    }
    assert_eq!(eng.slots.len(), eng.slot_cap, "槽池必须真的满了,否则驱逐根本不发生");
    eng.slots.iter().min_by_key(|(_, s)| s.touched).map(|(o, _)| o.clone()).expect("满额必非空")
}

/// 一枚合法的「新 origin 单条 op」帧,连 origin 一起给出。
fn newcomer_frame(tag: u64) -> (String, Msg) {
    let origin = format!("NEWC0MERDEV{tag:015}");
    let op = topic_op(&origin, 9_000 + tag, 1, &format!("01TPCNEWCOMER{tag:013}"));
    (origin.clone(), Msg::Ops { origin, ops: vec![op] })
}

/// **L-d‴ 的心脏:隔离重验必须有界批**(同族第五例)。
///
/// 每恢复一行发一枚广播 `Want`,而每链发送队列只有 256 帧;表的真实天花板是本地
/// origin 总数(`QUARANTINE_MAX_ROWS` 只是 breaker 跳闸点,不是行上界),故不封批
/// 就是「一次输入吐几百枚帧」。这里用 N=20 > BATCH=16 把「有界」与「一口气全放」
/// 区分开——**不封批的话 released 会是 20**。
#[test]
fn reverify_releases_at_most_one_batch_per_call() {
    let (mut conn, mut clock, mut eng) = fresh();
    const N: usize = 20;
    assert!(N > QUARANTINE_REVERIFY_BATCH, "夹具必须真的越过批上限");
    seed_reverifiable(&mut conn, &mut clock, &mut eng, N);
    assert_eq!(quarantine_count(&conn), N as i64);

    let outs = reverify_ok(&mut eng, &mut conn, &mut clock);

    let released = N as i64 - quarantine_count(&conn);
    assert_eq!(
        released, QUARANTINE_REVERIFY_BATCH as i64,
        "一次调用至多放一批(不封批会是 {N})"
    );
    let wants = sends(&outs).iter().filter(|m| matches!(m, Msg::Want { .. })).count();
    assert_eq!(
        wants, QUARANTINE_REVERIFY_BATCH,
        "帧数必须跟着批走(每放一行一枚 want):{outs:?}"
    );
    assert!(eng.reverify_backlog, "还有余量,续做位必须置起来");
}

/// **有界批的另一半:余量必须收敛,且做完要落位**(不许静默截断、也不许永远空转)。
///
/// 续做的**触发器**在传输层(挂恒在心跳),见 `transport` 的
/// `heartbeat_drains_quarantine_reverify_backlog`;这只测钉的是引擎侧的可收敛性。
#[test]
fn reverify_batches_converge_and_backlog_clears_when_done() {
    let (mut conn, mut clock, mut eng) = fresh();
    const N: usize = 20;
    seed_reverifiable(&mut conn, &mut clock, &mut eng, N);

    reverify_ok(&mut eng, &mut conn, &mut clock);
    assert_eq!(quarantine_count(&conn), (N - QUARANTINE_REVERIFY_BATCH) as i64);
    assert!(eng.has_reverify_backlog(), "还有余量,续做位必须置起来");

    let second = reverify_ok(&mut eng, &mut conn, &mut clock);
    assert_eq!(quarantine_count(&conn), 0, "第二拍把余量做完");
    assert_eq!(
        sends(&second).iter().filter(|m| matches!(m, Msg::Want { .. })).count(),
        N - QUARANTINE_REVERIFY_BATCH,
        "续做那一批也各发一枚追帧 want:{second:?}"
    );
    assert!(!eng.has_reverify_backlog(), "做完必须落位,否则每拍空跑一次 SELECT");

    let third = reverify_ok(&mut eng, &mut conn, &mut clock);
    assert!(third.is_empty(), "工作集已空,不该再产任何输出:{third:?}");
}

/// **装配即置位**:表里可能攒着上个版本留下的待重验行,而 `reverify_quarantined` 的
/// 另一个调用点是会话仪式——纯 LAN 冷启动**根本没有中转会话**,不置位就永远没人做。
/// 端到端那一半(心跳真把它做掉)在 `transport` 侧那只测里。
#[test]
fn freshly_assembled_engine_starts_with_backlog_set() {
    let (conn, _clock, _eng) = fresh();
    let restarted = Engine::new_solo(&conn, BlobPolicy::Full).expect("engine");
    assert!(
        restarted.has_reverify_backlog(),
        "新装引擎必须假定「可能有待重验行」——它拿不到也不该拿会话仪式当唯一触发器"
    );
}

/// **重验尾部必须 outbound**(实现审 H4)。`drain` 可以产出**本机**修正 op——回放
/// 「图 N」撞号翻案会真写一枚 `set_field`;`on_ops` 尾部本来就跟着一次 `outbound`,
/// 而重验这条路原先 drain 完直接返回,会话仪式那边又是**先 outbound 后 reverify**,
/// 两头都兜不到,稳定的纯 LAN 会话里那枚修正 op 可以无限期不发。
///
/// 这里拿一枚**普通本机 op** 当探针:它同样只可能被尾部那次 `outbound` 带出去。
#[test]
fn reverify_pushes_local_ops_after_drain() {
    let (mut conn, mut clock, mut eng) = fresh();
    seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
    // 本机写一笔:进了 oplog,但出站游标还没推过它。
    crate::notes::capture(&mut conn, &mut clock, "重验尾部该把我推出去").unwrap();

    let outs = reverify_ok(&mut eng, &mut conn, &mut clock);

    assert!(
        outs.iter().any(|o| matches!(o, Output::ServeOps(s) if s.to == OpsServeTo::Broadcast)),
        "恢复一行之后必须顺带把本机待推 op 登记并摇铃:{outs:?}"
    );
    let served = eng.drain_ops_for_test(&conn).unwrap();
    assert!(
        sends(&served).iter().any(|m| matches!(m, Msg::Ops { .. })),
        "而且抽得出那一枚:{served:?}"
    );
}

/// **已提交的义务必须随输出交出去,哪怕整笔 Err**(实现审二轮 H1)。
///
/// 批内前面几行可能已经 DELETE、已经进 pending,它们的追帧 want 与 `slot_insert` 的
/// 驱逐 want 都只在输出里;这些输出若随 `Err` 一起蒸发,`reverify_backlog` 也救不回来
/// ——它只能重扫**仍在表里**的行,重建不了已删行的义务。故引擎写的是**调用方持有**的
/// 缓冲。这里让**尾部**失败(丢掉 `topics` 表,前面的 watermark/slot_insert/DELETE 全
/// 走完,`drain` 落地那枚 topic op 时才炸),断言 Err 之下那枚 want **还在**。
#[test]
fn reverify_keeps_already_committed_outputs_even_on_error() {
    let (mut conn, mut clock, mut eng) = fresh();
    seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
    conn.execute("DROP TABLE topics", []).unwrap();

    let mut out = vec![];
    let r = eng.reverify_quarantined(&mut conn, &mut clock, &mut out);

    assert!(r.is_err(), "尾部 drain 必须响亮失败,不然这只测什么也没证:{r:?}");
    assert!(
        sends(&out).iter().any(|m| matches!(m, Msg::Want { .. })),
        "已放行那行的追帧 want 必须随输出交出去,不许跟着 Err 蒸发:{out:?}"
    );
}

/// **失败安全:先把会失败的事做完,再动那份唯一材料**(实现审 H3)。
///
/// 恢复分支原先 `DELETE` 打头,其后的 watermark 查询 / `slot_insert` 一旦本地故障,
/// 这枚 op **既没进 oplog、隔离表里那份唯一完整材料也已经没了**。这里把 `oplog` 表
/// 弄坏(drop 掉)制造真实的本地故障,断言两件事:①隔离行**还在**(材料没丢);
/// ②续做位**仍是 true**(纯 LAN 下还有人来重试)。
#[test]
fn reverify_local_fault_keeps_material_and_retry_flag() {
    let (mut conn, mut clock, mut eng) = fresh();
    seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
    assert_eq!(quarantine_count(&conn), 1);

    // watermark 查询要读 oplog:删表 = 恢复分支走到一半必 Err。
    conn.execute("DROP TABLE oplog", []).unwrap();
    let mut out = vec![];
    let err = eng.reverify_quarantined(&mut conn, &mut clock, &mut out);
    assert!(err.is_err(), "本地故障必须响亮报出,不许吞:{err:?}");

    assert_eq!(quarantine_count(&conn), 1, "失败了就不许把唯一那份材料删掉");
    assert!(eng.has_reverify_backlog(), "失败必须留着续做位,否则纯 LAN 下再没人重试");
}

/// **H1 的最内层:破坏性提交之前,先把会失败的事做完**(实现审三轮)。
///
/// 槽池满额时 `slot_insert` 要 LRU 驱逐一个槽,并为它发一枚**无状态** want —— 那是
/// 被丢掉的那段缺口此后**唯一**的自愈信号。原先的排法是「先删槽、再查水位」:查询
/// 一失败,槽已经没了,而 want 连构造都构造不出来,缺口从此没人认领也没人知道。
#[test]
fn slot_eviction_asks_before_it_drops() {
    let (conn, _clock, mut eng) = fresh();
    let victim = fill_slots(&conn, &mut eng);

    // 驱逐要先查被驱逐者的水位(读 oplog):删表 = 那一步必真失败。
    conn.execute("DROP TABLE oplog", []).unwrap();
    let mut out = vec![];
    let origin = format!("NEWC0MERDEV{:015}", 1);
    let op = topic_op(&origin, 9_001, 1, &format!("01TPCNEWCOMER{:013}", 1));
    let r = eng.slot_insert(&conn, &origin, PendingOp { op, relay_from: "R".into() }, &mut out);

    assert!(r.is_err(), "水位查不到就该响亮失败,不然这只测什么也没证:{r:?}");
    assert!(
        eng.slots.contains_key(&victim),
        "查询失败时被驱逐者必须还在槽里——删了它就等于把那段缺口丢进黑洞"
    );
    assert!(out.is_empty(), "没真发出去的 want 不许假装发过:{out:?}");
}

/// **H1 的另一半:最内层产出的义务也要活过外层的 `?`**(实现审三轮)。
///
/// 二轮只把「输出交给调用方持有」改到了最外层,`slot_insert` 那枚驱逐 want 仍先落进
/// helper 的私有 `Vec`。而驱逐**已经提交**(槽真删了),恢复分支后面任何一步失败都把
/// 它带走 —— 这里让尾部 `drain` 炸,断言那枚 want 还在。
#[test]
fn reverify_keeps_the_eviction_want_from_the_innermost_helper() {
    let (mut conn, mut clock, mut eng) = fresh();
    seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
    let victim = fill_slots(&conn, &mut eng);
    // 恢复分支的 watermark/slot_insert/DELETE 全走完,`drain` 落地那枚 topic op 时才炸。
    conn.execute("DROP TABLE topics", []).unwrap();

    let mut out = vec![];
    let r = eng.reverify_quarantined(&mut conn, &mut clock, &mut out);

    assert!(r.is_err(), "尾部 drain 必须响亮失败,不然这只测什么也没证:{r:?}");
    assert!(
        sends(&out)
            .iter()
            .any(|m| matches!(m, Msg::Want { origin, .. } if *origin == victim)),
        "被驱逐那个槽的无状态 want 必须活过这枚 Err(它是那段缺口唯一的信号):{out:?}"
    );
}

/// **同一条纪律在 `on_msg` 那一跳**(实现审三轮 H1 的最外层):一枚帧处理到一半炸了,
/// 它此前**已经做成**的事(这里是驱逐一个槽)的通知不许跟着 Err 蒸发。
#[test]
fn a_frame_that_blows_up_midway_still_hands_back_what_it_already_did() {
    let (mut conn, mut clock, mut eng) = fresh();
    let victim = fill_slots(&conn, &mut eng);
    conn.execute("DROP TABLE topics", []).unwrap(); // 入池后 drain 落地时才炸。

    let mut out = vec![];
    let (_, frame) = newcomer_frame(2);
    let r = eng.on_msg(&mut conn, &mut clock, "R", Route::Relay, frame, &mut out);

    assert!(r.is_err(), "drain 必须响亮失败,不然这只测什么也没证:{r:?}");
    assert!(
        sends(&out)
            .iter()
            .any(|m| matches!(m, Msg::Want { origin, .. } if *origin == victim)),
        "槽已经被这枚帧驱逐掉了,它的 want 不许随 Err 一起没:{out:?}"
    );
}

/// 只让 `sync_meta` 的 **poison_breaker 那一条**写不进去(别的键照写,不然时钟自己
/// 先炸)。触发器体在执行时才解析名字,故这是 `SQLITE_ERROR` 类的真实本地故障。
fn break_breaker_writes(conn: &Connection) {
    conn.execute(
        "CREATE TRIGGER tmp_breaker_boom BEFORE INSERT ON sync_meta \
         WHEN NEW.key = 'poison_breaker' BEGIN SELECT 1 FROM no_such_table_boom; END",
        [],
    )
    .unwrap();
}

/// **到顶那一枚:先置 breaker,再落隔离行**(实现审四轮 H1)。
///
/// 反着排的话,`trip_breaker` 一失败 breaker 仍是 None,而这个 origin 已经进了
/// `quarantined` —— 它后续的帧从此走早退分支,**再没有人回来试第二次**;攻击者接着
/// 拿别的已在册 origin 重演一遍,表照涨,这道资源上界被打回原形。
#[test]
fn quarantine_at_cap_trips_the_breaker_before_it_writes_the_row() {
    let (mut conn, mut clock, mut eng) = fresh();
    // 隔离表填到「再来一行就到顶」。
    for i in 0..(QUARANTINE_MAX_ROWS - 1) {
        conn.execute(
            "INSERT INTO sync_quarantine (origin, op_id, origin_seq, op_sha256, reason, \
             error_stage, validator_ver, at) \
             VALUES (?1, ?2, 1, ?3, '毒', 'shape', 1, '2026-08-01')",
            rusqlite::params![
                format!("CAPDEV{i:020}"),
                format!("01CAPOP{i:019}"),
                "0".repeat(64), // 指纹档(op_blob NULL)照样占一行,这里只要行数。
            ],
        )
        .unwrap();
    }
    break_breaker_writes(&conn);

    let bad = poison_op(DEV, 1_000, 1);
    let mut out = vec![];
    let r = eng.on_msg(
        &mut conn,
        &mut clock,
        "R",
        Route::Relay,
        Msg::Ops { origin: DEV.into(), ops: vec![bad] },
        &mut out,
    );

    assert!(r.is_err(), "breaker 写不进去就该响亮失败,不然这只测什么也没证:{r:?}");
    assert!(eng.breaker.is_none(), "夹具:breaker 确实没置上");
    assert_eq!(
        quarantine_count(&conn),
        QUARANTINE_MAX_ROWS - 1,
        "闸没落成就不许把这一行记进去——记了它,这个 origin 此后走早退分支,没人再试第二次"
    );
    assert!(
        !eng.quarantined.contains(DEV),
        "同理:入了册就等于把「再试一次」的路堵死了"
    );
}

/// **冻结到顶那一支同款**(实现审四轮 H3):先置 breaker,再拆槽。
#[test]
fn freeze_at_cap_keeps_the_slot_when_the_breaker_write_fails() {
    let (conn, _clock, mut eng) = fresh();
    let victim = fill_slots(&conn, &mut eng);
    for i in 0..FROZEN_CAP {
        eng.frozen.insert(format!("FRZNDEV{i:019}"), "夹具".into());
    }
    break_breaker_writes(&conn);

    let r = eng.freeze_v(&conn, &victim, "分叉".into());

    assert!(r.is_err(), "breaker 写不进去就该响亮失败:{r:?}");
    assert!(
        eng.slots.contains_key(&victim),
        "闸没落成就不许先把槽拆了——这一枚分叉既没记下也没闸住"
    );
}

/// **收尾要用的库事实必须在 apply 之前取**(实现审四轮 H2)。
///
/// 排在 apply 之后的话,那两下查询就成了「op 已写进 oplog、水位已推进、它自己也已经
/// 离开队列」之后的失败点 —— 缺字节登记 / 死图清理从此**没有人重来**(`settle_pending`
/// 只记得「还欠一次 drain」,重放不了「哪一枚 op 还欠 settle」)。
///
/// 「收尾不会失败」这件事本身由**类型**钉死:`settle_outcome` 不返回 `Result`,想在
/// 里面查库都编译不过。剩下要钉的只有「预查排在 apply 之前」—— 行为测在这里造不出
/// 可控差别(两条路碰的是同两张表:`reconcile_item_images` 也读写 `item_image`、
/// apply 必写 oplog,弄坏任一张都让两条路同时失败、终局同形),故**诚实降级成按源码
/// 钉**顺序。
#[test]
fn settle_facts_are_read_before_the_op_is_applied() {
    let src = include_str!("../engine.rs");
    let prod = production_src(src, "engine.rs");
    let at = prod.find("    fn drain(").expect("必有 drain");
    let body =
        &prod[at..at + prod[at..].find("fn settle_outcome(").expect("其后即 settle_outcome")];
    let pre = body.find("settle_precheck(").expect("必先取收尾要用的库事实");
    let take = body.find(".remove(&head_seq)").expect("必从队列取走队头");
    let apply = body.find("replay::apply_remote_op(").expect("必 apply");
    assert!(pre < take && take < apply, "顺序必须是 预查 → 取队头 → apply");
}

/// **「先把会失败的事做完,再动破坏性提交」三处的顺序**(实现审四轮 H1/H3)。
///
/// `on_ops` 的 pending 超限那一支造不出可控的行为测(它前面已经查过好几次 oplog,
/// 弄坏 oplog 会先炸在别处),故**诚实降级成按源码钉**;另两处各自有行为测,这里
/// 一并钉住顺序,免得日后有人「顺手」把某一处调回去。
#[test]
fn destructive_commits_come_after_the_fallible_work() {
    let src = include_str!("../engine.rs");
    let prod = production_src(src, "engine.rs");
    let seg = |from: &str, to: &str| -> String {
        let a = prod.find(from).unwrap_or_else(|| panic!("锚点不见了:{from}"));
        let b = prod[a..].find(to).unwrap_or_else(|| panic!("锚点不见了:{to}"));
        prod[a..a + b].to_string()
    };
    // ① `slot_insert` 的 LRU 驱逐:查水位 → 拆槽。
    let evict = seg("fn slot_insert(", "self.touch_seq += 1;");
    assert!(
        evict.find("watermark(conn, &evict)").expect("驱逐必查水位")
            < evict.find("self.slots.remove(&evict)").expect("驱逐必拆槽"),
        "驱逐:水位要在拆槽之前查"
    );
    // ② `on_ops` 的 pending 超限:查水位 → 拆槽。
    let over = seg("if over_cap {", "self.emit_wants(");
    assert!(
        over.find("watermark(conn, &origin)").expect("超限必查水位")
            < over.find("self.slots.remove(&origin)").expect("超限必拆槽"),
        "pending 超限:水位要在拆槽之前查(那枚 want 是此刻唯一的重取信号)"
    );
    // ③ `quarantine_origin` 的到顶:置 breaker → 落行。
    let quar = seg("fn quarantine_origin(", "self.quarantined.insert(");
    assert!(
        quar.find("self.trip_breaker(").expect("到顶必置 breaker")
            < quar.find("INSERT INTO sync_quarantine").expect("必落隔离行"),
        "隔离到顶:breaker 要在落行之前置"
    );
}

/// **失败路径上,出口那两件照跑**(实现审三轮 H1 的连带项)。
///
/// 来路改写与发问边沿都是**只此一次**的:下一枚帧的 `missing_before` 已是新值,这一
/// 跳错过就得等下一次偶然的「满转空 / 又贴了新图」。行为测造不出可控场景(要让
/// `drain` 恰好炸在 image_add 已落地、别的 op 还没轮到的那一刻),故**按源码钉**:
/// `dispatch_msg` 的结果必须先扣住,两件跑完了才把那枚 Err 交出去。
#[test]
fn on_msg_defers_the_frame_error_until_after_its_exit_work() {
    let src = include_str!("../engine.rs");
    let prod = production_src(src, "engine.rs");
    let head = prod.find("    pub fn on_msg(").expect("必有 on_msg");
    let body = &prod[head..prod.find("    fn dispatch_msg(").expect("其后即 dispatch_msg")];
    let call = body
        .find("let done = self.dispatch_msg(")
        .expect("结果必须先扣住(当场 `?` 就把出口两件跳过去了)");
    let rewrite =
        body.find("*route_hint = RouteHint::Require(route);").expect("必有来路改写");
    let ask = body.find("self.append_want_batch(out);").expect("必有发问边沿");
    assert!(call < rewrite && rewrite < ask, "顺序必须是 扣住结果 → 来路改写 → 发问边沿");
    assert!(
        body[ask..].contains("\n        done\n"),
        "那枚 Err 必须留到出口两件之后才交出去"
    );
}

/// **H2:行已放出隔离表,`drain` 却失败了——这笔债只有 `settle_pending` 记得**。
///
/// `DELETE` 一成功,那些行就**永远不会再被 `WHERE` 选中**。原先的续做位只表示「SQL
/// 里还可能有行」,下一拍 `rows` 空就把它清成 false:既不会再 drain 也不会 outbound,
/// 留下「已归池却没结算的 op」和「翻案产出却没推出去的本机修正 op」两类无主义务。
#[test]
fn reverify_still_owes_a_drain_after_the_row_is_gone() {
    let (mut conn, mut clock, mut eng) = fresh();
    seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
    // **可逆**的本地故障:触发器体在执行时才解析名字,故这是 SQLITE_ERROR(→
    // LocalFault),不是约束违例(那会被判成 InvalidOp 重新隔离,跑的就不是这条路了)。
    conn.execute(
        "CREATE TRIGGER tmp_boom BEFORE INSERT ON topics \
         BEGIN SELECT 1 FROM no_such_table_boom; END",
        [],
    )
    .unwrap();

    let mut out = vec![];
    let r = eng.reverify_quarantined(&mut conn, &mut clock, &mut out);
    assert!(r.is_err(), "drain 必须真失败:{r:?}");
    assert_eq!(quarantine_count(&conn), 0, "行确实已经放出表了——不然跑的不是这条路");
    assert!(eng.needs_reverify_tick(), "债还欠着,门槛必须还是 true");

    // 故障消失,下一拍:`WHERE` 已经一行都选不到,只有那一位记得还欠着 drain。
    conn.execute("DROP TRIGGER tmp_boom", []).unwrap();
    let mut out2 = vec![];
    eng.reverify_quarantined(&mut conn, &mut clock, &mut out2).expect("这一拍该成");

    assert_eq!(
        watermark(&conn, &reverify_dev(0)).unwrap(),
        1,
        "那枚 op 必须在这一拍真落地,而不是躺在池里等一枚偶然的 Ops 帧"
    );
    assert!(!eng.needs_reverify_tick(), "两件都做成了才许落位");
}

/// 冻结表到顶后,breaker 闸口升级为「拒收一切尚未 frozen/quarantine 在册的 origin」
/// (实现审 H1 的另一半)——**连已在册的也拒**,本测的夹具正是一个已在册 origin。
///
/// 光靠 `freeze` 那边不插表还不够:旧闸只拦「新 origin」(本地日志无其 op 的),
/// 已在册 origin 照样一路走到分叉检测。到顶意味着**已无处安全记录新的分叉**,
/// 此时再放行就是让分叉再也拦不住——这一刀才让 `FROZEN_CAP` 成为真上界。
#[test]
fn breaker_at_frozen_cap_rejects_even_registered_origins() {
    let (mut conn, mut clock, mut eng) = fresh();
    // 一个**已在册**的正常 origin(本地日志有它的 op,故老闸放行)。
    const KNOWN: &str = "KN0WNDEV000000000000000001";
    let ops = |seq: i64| Msg::Ops {
        origin: KNOWN.into(),
        ops: vec![topic_op(KNOWN, 1_000 + seq as u64, seq, &format!("01TOPICKN0WN{seq:013}"))],
    };
    eng.on_relay_msg(&mut conn, &mut clock, KNOWN, ops(1)).unwrap();
    assert_eq!(watermark(&conn, KNOWN).unwrap(), 1, "夹具前提:它已在册");
    // 分叉风暴把冻结表塞满并撑到 breaker。
    for i in 0..=FROZEN_CAP {
        eng.freeze_v(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "伪造分叉".into())
            .unwrap();
    }
    assert!(eng.breaker.is_some() && eng.frozen.len() == FROZEN_CAP);
    // 已在册也不再放行:整帧拒收,水位纹丝不动。
    let outs = eng.on_relay_msg(&mut conn, &mut clock, KNOWN, ops(2)).unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Event(Event::FrameRejected { .. }))),
        "冻结表到顶后必须拒收未在册 origin 的帧:{outs:?}"
    );
    assert_eq!(watermark(&conn, KNOWN).unwrap(), 1, "拒收 = 不落地");
}

// ---- 引擎活到 runtime 生命期(lan-direct-plan 不变量 6,L-c2a) --------------------

/// 本地删掉宿主条目 → 名下缺字节的图当场出清单、在飞拉流一并作废。
///
/// 引擎随会话生灭时这条靠「下次装配重新 derive」兜着;活到 runtime 生命期之后
/// 兜底没了,不清就是每次会话仪式都对死图广播一遍谁也答不了的 want。
#[test]
fn local_tombstone_evicts_dead_images_from_the_missing_list() {
    let (mut a_conn, mut a_clock, _a) = fresh();
    let (mut b_conn, mut b_clock, mut b) = fresh();
    let a_id = a_clock.device_id().to_string();
    let kept = notes::capture(&mut a_conn, &mut a_clock, "留着的条目").unwrap();
    let (img_kept, _) =
        images::attach(&mut a_conn, &mut a_clock, &kept, &[1u8; 9], "image/png").unwrap();
    let doomed = notes::capture(&mut a_conn, &mut a_clock, "待删的条目").unwrap();
    let (img_doomed, _) =
        images::attach(&mut a_conn, &mut a_clock, &doomed, &[2u8; 9], "image/png").unwrap();
    let doomed2 = notes::capture(&mut a_conn, &mut a_clock, "也要删的条目").unwrap();
    let (img_doomed2, _) =
        images::attach(&mut a_conn, &mut a_clock, &doomed2, &[4u8; 9], "image/png").unwrap();
    b.on_runtime_started(&b_conn).unwrap();
    b.relay_up(&b_conn).unwrap();
    feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
    assert!(
        [&img_kept, &img_doomed, &img_doomed2].iter().all(|i| b.missing_blobs.contains(*i)),
        "夹具前提:三张图的字节都还没到"
    );
    // 待删那张已经在拉了(证明作废的是「清单 ∪ 在飞」两处,不是只清单)。
    b.on_relay_peer_up(&a_id);
    let outs = b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have(&img_doomed)).unwrap();
    assert!(pull_of(&outs).is_some() && b.pulling.contains_key(&img_doomed), "夹具前提:在飞");

    // 用户在 B 上把那条连图一起删了(回收站 → 彻底删)。
    notes::archive(&mut b_conn, &mut b_clock, &doomed).unwrap();
    notes::purge(&mut b_conn, &mut b_clock, &doomed).unwrap();
    b.on_local_ops_settled(&b_conn).unwrap();
    assert!(!b.pulling.contains_key(&img_doomed), "死图的在飞拉流必须作废");
    assert!(!b.missing_blobs.contains(&img_doomed), "死图必须出缺字节清单");
    assert!(b.missing_blobs.contains(&img_kept), "没被删的那张一动不能动");
    // 再删一条,这次**不手动结算**:会话仪式必须自己先结算再按清单发 want
    // (结算收在 `on_relay_session_up` 第一步的那条契约,靠这只测守着)。
    notes::archive(&mut b_conn, &mut b_clock, &doomed2).unwrap();
    notes::purge(&mut b_conn, &mut b_clock, &doomed2).unwrap();
    let outs = b.relay_up(&b_conn).unwrap();
    let asked: Vec<String> = sends(&outs)
        .iter()
        .filter_map(|m| match m {
            Msg::BlobWant { image_id } => Some(image_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(asked, vec![img_kept], "会话仪式只该问活着的那张:{asked:?}");
}

/// 结算游标单调只进:扫过的窗口不重扫。
///
/// 不然「删过又因别的缘由回了清单」的同一枚 id 会被旧窗口里的 tombstone 反复
/// 摘掉——而缺字节清单是可丢内存态,回清单的路子不止一条(路由失效、坏块、
/// deny 都会把图退回来)。
#[test]
fn local_settled_cursor_never_rescans() {
    let (mut a_conn, mut a_clock, _a) = fresh();
    let (mut b_conn, mut b_clock, mut b) = fresh();
    let a_id = a_clock.device_id().to_string();
    let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
    let (img, _) =
        images::attach(&mut a_conn, &mut a_clock, &item, &[3u8; 12], "image/png").unwrap();
    b.on_runtime_started(&b_conn).unwrap();
    feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
    notes::archive(&mut b_conn, &mut b_clock, &item).unwrap();
    notes::purge(&mut b_conn, &mut b_clock, &item).unwrap();
    b.on_local_ops_settled(&b_conn).unwrap();
    assert!(!b.missing_blobs.contains(&img));
    // 图因别的缘由回了清单(路由失效 / 坏块 / deny 都会把图退回来)。
    b.missing_blobs.insert(img.clone());
    // 再记一笔本地写,把水位推到游标之上——**逼结算真去扫一段**。少了这一步,
    // 「max <= 游标」的早返回会替扫描下界背书,下界写成 0 也测不出来。
    notes::capture(&mut b_conn, &mut b_clock, "本地又记一条").unwrap();
    b.on_local_ops_settled(&b_conn).unwrap();
    assert!(b.missing_blobs.contains(&img), "结算过的窗口不许重扫");
}

/// 会话仪式复位的是 **UI 去重位**,不是引擎的数据事实。
///
/// 引擎跨会话存活后这条线必须钉死:去重位(挂起原因 / 偏斜提示 / breaker 拒帧)
/// 不复位就变成「每引擎报一次」——重连清空了状态面的 error,用户此后再也看不到
/// 仍在挂起的那条;而冻结、隔离、缺字节清单是引擎的当前事实,换条中转会话不构成
/// 忘掉它们的理由。
#[test]
fn session_up_resets_ui_dedup_but_keeps_engine_facts() {
    let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
    let _ = a_id;
    eng.frozen.insert("FRZNDEV0000000000000000002".into(), "分叉".into());
    // 未知词汇 = 版本偏斜挂起。挂起的 origin 要等**别的 origin 落地**才解锁重试
    // (drain 的既有语义),故重试触发器统一用另一台设备的合法 op。
    const SPND: &str = "SPNDDEV0000000000000000001";
    const OTHER: &str = "0THERDEV000000000000000003";
    let suspend_spnd = |eng: &mut Engine, conn: &mut Connection, clock: &mut Clock| {
        let mut op = topic_op(SPND, 5_000, 1, "01TOPICSUSPEND00000000001");
        op.kind = "kind_from_the_future".into();
        let outs = eng
            .on_relay_msg(conn, clock, SPND, Msg::Ops { origin: SPND.into(), ops: vec![op] })
            .unwrap();
        outs.iter().any(|o| matches!(o, Output::Event(Event::OriginSuspended { .. })))
    };
    let retry_spnd = |eng: &mut Engine, conn: &mut Connection, clock: &mut Clock, seq: i64| {
        let op = topic_op(OTHER, 6_000 + seq as u64, seq, &format!("01TOPIC0THER{seq:013}"));
        let outs = eng
            .on_relay_msg(conn, clock, OTHER, Msg::Ops { origin: OTHER.into(), ops: vec![op] })
            .unwrap();
        outs.iter().any(|o| matches!(o, Output::Event(Event::OriginSuspended { .. })))
    };
    assert!(suspend_spnd(&mut eng, &mut conn, &mut clock), "首次挂起必报");
    assert!(!retry_spnd(&mut eng, &mut conn, &mut clock, 1), "同因不重报");

    // 换一条中转会话。
    eng.relay_up(&conn).unwrap();
    assert!(eng.frozen.contains_key("FRZNDEV0000000000000000002"), "冻结是数据事实,不随会话忘");
    assert!(eng.missing_blobs.contains(&img), "缺字节清单同理");
    assert!(
        retry_spnd(&mut eng, &mut conn, &mut clock, 2),
        "新会话必须重新报一次仍在挂起的那条"
    );
}

// ---- 路由维度(lan-direct-plan §5.1/§5/§6) ----------------------------------------

/// 一台缺一张图的引擎:A 端真 attach 一张图,B 端收完 op(行不建)→ 进缺字节清单。
/// B 已「装配 + 中转会话建立」但**无任何对端在线**(路由表空),故默认无健康腿:
/// 各测试自己按需 `on_relay_peer_up` / `on_lan_link_up`。
/// 返回 (B 的库, B 的钟, B 的引擎, 图 id, A 的 device_id)。
fn peer_missing_one_image() -> (Connection, Clock, Engine, String, String) {
    let (mut a_conn, mut a_clock, _a) = fresh();
    let (mut b_conn, mut b_clock, mut b) = fresh();
    let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
    let (img, _) =
        images::attach(&mut a_conn, &mut a_clock, &item, &[3u8; 12], "image/png").unwrap();
    let a_id = a_clock.device_id().to_string();
    // 真接线顺序:装配即活 → 中转会话建立(→ 各测试自己置对端在线/链路)。
    b.on_runtime_started(&b_conn).unwrap();
    b.relay_up(&b_conn).unwrap();
    feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
    assert!(b.missing_blobs.contains(&img), "夹具前提:B 缺这张图的字节");
    (b_conn, b_clock, b, img, a_id)
}

fn have(img: &str) -> Msg {
    Msg::BlobHave { image_id: img.into() }
}

/// C′ 的取数原语:块边界算对、末块标志对、**行没了/换了行一律 `None`**(调用方据此
/// 回 deny)。这是分段供流唯一的取数点,切块这件事只有它一处实现。
#[test]
fn read_blob_chunk_walks_the_boundaries_and_notices_a_vanished_row() {
    let (mut conn, mut clock, _e) = fresh();
    let item = notes::capture(&mut conn, &mut clock, "带图").unwrap();
    // 刻意不整除:末块必须是短的那一段。
    let size = BLOB_CHUNK_BYTES * 2 + 7;
    let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    let (img, _) = images::attach(&mut conn, &mut clock, &item, &bytes, "image/png").unwrap();
    let (rowid, total): (i64, i64) = conn
        .query_row("SELECT rowid, length(data) FROM item_image WHERE id = ?1", [&img], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    let serve = BlobServe {
        to: "01PEERAAAAAAAAAAAAAAAAAAAA".into(),
        route: Route::Lan,
        image_id: img.clone(),
        transfer: "01TRANSFER0000000000000042".into(),
        rowid,
        total,
    };
    assert_eq!(serve.chunks(), 3, "两整块 + 一小截");
    assert!(!serve.is_last(1) && serve.is_last(2));
    let mut got = vec![];
    for idx in 0..serve.chunks() {
        let chunk = read_blob_chunk(&conn, &serve, idx).unwrap().expect("行还在");
        let want = if idx == 2 { 7 } else { BLOB_CHUNK_BYTES };
        assert_eq!(chunk.len(), want, "第 {idx} 块长度");
        got.extend_from_slice(&chunk);
    }
    assert_eq!(got, bytes, "逐块拼回来必须与原图逐位相等");
    assert!(read_blob_chunk(&conn, &serve, 3).is_err(), "越界取块 = 本机 bug,响亮报");

    images::remove(&mut conn, &mut clock, &img).unwrap();
    assert!(
        read_blob_chunk(&conn, &serve, 0).unwrap().is_none(),
        "行没了必须 None(调用方据此回 deny,不让收端干等 stale)"
    );
    // rowid 被别的图复用:光看 rowid 会把别人的字节当成这张图发出去。
    let other = notes::capture(&mut conn, &mut clock, "另一条").unwrap();
    let (_img2, _) =
        images::attach(&mut conn, &mut clock, &other, &bytes, "image/png").unwrap();
    let reused: i64 =
        conn.query_row("SELECT rowid FROM item_image", [], |r| r.get(0)).unwrap();
    assert_eq!(reused, rowid, "夹具前提:删空后新插入必然拿回同一个 rowid");
    assert!(
        read_blob_chunk(&conn, &serve, 0).unwrap().is_none(),
        "rowid 被复用时必须靠 id 复核认出来(光看 rowid 会把别人的字节当成这张图发出去)"
    );
}

/// 放大面(263 codex 顺带点名):`BlobPull` 的 `image_id`/`transfer` 是已鉴权对端可控的
/// 任意字符串,而供流要把它们**逐块抄进每一枚 BlobChunk**——不复核形态,一枚长串就能
/// 被放大 128 倍写上线。不合 ULID = 响亮拒帧,且**不回 deny**(回 deny 等于把同一份长
/// 串再抄一遍出去)。
#[test]
fn blob_pull_with_a_malformed_id_is_rejected_without_echoing_it() {
    let (mut conn, mut clock, mut eng) = fresh();
    let item = notes::capture(&mut conn, &mut clock, "带图").unwrap();
    let (img, _) =
        images::attach(&mut conn, &mut clock, &item, &[7u8; 40], "image/png").unwrap();
    let long = "X".repeat(4096);
    for (image_id, transfer) in
        [(img.clone(), long.clone()), (long.clone(), "01TRANSFER0000000000000042".into())]
    {
        let outs = eng
            .on_relay_msg(
                &mut conn,
                &mut clock,
                "01PEERAAAAAAAAAAAAAAAAAAAA",
                Msg::BlobPull { image_id, transfer },
            )
            .unwrap();
        assert!(frame_rejected(&outs), "形态不合必须响亮拒:{outs:?}");
        assert!(
            !outs.iter().any(|o| matches!(
                o,
                Output::ServeBlob(_)
                    | Output::Send { msg: Msg::BlobDeny { .. } | Msg::BlobChunk { .. }, .. }
            )),
            "拒帧那一路一个字节都不许回给它:{outs:?}"
        );
    }
    // 合法形态照常供流(阴性对照:上面那两条不是「什么都不答」蒙的)。
    let ok = eng
        .on_relay_msg(
            &mut conn,
            &mut clock,
            "01PEERAAAAAAAAAAAAAAAAAAAA",
            Msg::BlobPull { image_id: img, transfer: "01TRANSFER0000000000000042".into() },
        )
        .unwrap();
    assert!(matches!(&ok[..], [Output::ServeBlob(_)]), "合法拉流必须产出供流:{ok:?}");
}

/// §10 C′ 的收端窗口:全局同时只许一笔在飞拉流(不然 N 张缺图就是 N 份最大 32 MiB 的
/// 攒块缓冲),**且槽一腾出来必须补问下一张**——封了窗口又不补问就是把清单锁死。
#[test]
fn the_receive_window_is_one_and_refills_when_it_frees() {
    let (mut a_conn, mut a_clock, _a) = fresh();
    let (mut b_conn, mut b_clock, mut b) = fresh();
    let a_id = a_clock.device_id().to_string();
    let item = notes::capture(&mut a_conn, &mut a_clock, "两张图").unwrap();
    let (one, _) =
        images::attach(&mut a_conn, &mut a_clock, &item, &[1u8; 20], "image/png").unwrap();
    let (two, _) =
        images::attach(&mut a_conn, &mut a_clock, &item, &[2u8; 24], "image/png").unwrap();
    b.on_runtime_started(&b_conn).unwrap();
    b.relay_up(&b_conn).unwrap();
    b.on_relay_peer_up(&a_id);
    feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
    assert_eq!(b.missing_blobs.len(), 2, "夹具前提:B 缺两张");

    // 两枚 have 一起到:只许起一笔。
    b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have(&one)).unwrap();
    let outs = b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have(&two)).unwrap();
    assert_eq!(b.pulling.len(), 1, "收端窗口 = 1");
    assert!(pull_of(&outs).is_none(), "窗口满时不许再起一笔:{outs:?}");
    assert!(b.missing_blobs.contains(&two), "第二张留在清单里,不是被丢了");

    // 第一笔走完 → 槽腾出 → 当场补问(不必等心跳)。
    let pulled = b.pulling.keys().next().unwrap().clone();
    let transfer = b.pulling[&pulled].transfer.clone();
    let src = if pulled == one { &[1u8; 20][..] } else { &[2u8; 24][..] };
    let outs = b
        .on_relay_msg(
            &mut b_conn,
            &mut b_clock,
            &a_id,
            Msg::BlobChunk {
                image_id: pulled.clone(),
                transfer,
                idx: 0,
                last: true,
                data: src.to_vec(),
            },
        )
        .unwrap();
    assert!(b.pulling.is_empty(), "终块到齐 = 槽腾出");
    assert!(
        outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::BlobWant { image_id }, .. }
            if image_id != &pulled)),
        "槽腾出必须补问下一张:{outs:?}"
    );
}

/// 264 实现审 H1:**块形必须与声明字节数严格对上**。原先只查「序号连号 ∧ 不超声明
/// 字节」,于是一串空块全部合法通过、每一枚又把 idle 计时清零——`buf` 永不增长、
/// transfer 永不结束、也永不判死;收端窗口封到一笔之后,这不再只是劫持一张图,而是
/// **整条图字节通道停摆**(别的图的 have 全被窗口挡在门外)。
///
/// 四种坏形状各来一次,每次都必须走 [`Engine::fail_pull`] 的收口(窗口腾出 + 图回
/// 清单 + 当场重问),而不是被静默收下。
#[test]
fn malformed_chunk_shapes_cannot_hold_the_receive_window() {
    // 声明 300 KiB = 两块(256 KiB + 51,200 B)。
    const SIZE: usize = 300 * 1024;
    let tail = SIZE - BLOB_CHUNK_BYTES;
    let bad: Vec<(&str, u32, bool, usize)> = vec![
        ("空块", 0, false, 0),
        ("短的非末块", 0, false, BLOB_CHUNK_BYTES - 1),
        ("非末块却标了 last", 0, true, BLOB_CHUNK_BYTES),
        ("末块长度不对", 1, true, tail - 1),
    ];
    for (what, idx, last, len) in bad {
        let (mut a_conn, mut a_clock, _a) = fresh();
        let (mut b_conn, mut b_clock, mut b) = fresh();
        let a_id = a_clock.device_id().to_string();
        let item = notes::capture(&mut a_conn, &mut a_clock, "带图").unwrap();
        let (img, _) = images::attach(
            &mut a_conn,
            &mut a_clock,
            &item,
            &vec![7u8; SIZE],
            "image/png",
        )
        .unwrap();
        b.on_runtime_started(&b_conn).unwrap();
        b.relay_up(&b_conn).unwrap();
        b.on_relay_peer_up(&a_id);
        feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
        b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have(&img)).unwrap();
        let transfer = b.pulling[&img].transfer.clone();
        // 坏形状之前先合法推进一块(末块那一形要 idx=1 才够得着)。
        if idx == 1 {
            b.on_relay_msg(
                &mut b_conn,
                &mut b_clock,
                &a_id,
                Msg::BlobChunk {
                    image_id: img.clone(),
                    transfer: transfer.clone(),
                    idx: 0,
                    last: false,
                    data: vec![7u8; BLOB_CHUNK_BYTES],
                },
            )
            .unwrap();
        }
        let outs = b
            .on_relay_msg(
                &mut b_conn,
                &mut b_clock,
                &a_id,
                Msg::BlobChunk {
                    image_id: img.clone(),
                    transfer,
                    idx,
                    last,
                    data: vec![7u8; len],
                },
            )
            .unwrap();
        assert!(b.pulling.is_empty(), "{what}:窗口必须当场腾出");
        assert!(b.missing_blobs.contains(&img), "{what}:图回清单");
        // 恰一枚:回清单必配重问,而**同一张图一轮只问一次**(实现审 L1——fail_pull
        // 自带的 rewant 与出口那批会撞车)。
        assert_eq!(
            outs.iter().filter(|o| want_image_of(o) == Some(img.as_str())).count(),
            1,
            "{what}:该图恰问一枚:{outs:?}"
        );
        // **必须拒在块形闸上**,不许被收下、攒进 buf、一路跑到终局验货才失败:那会
        // 白攒一整笔、把「形态不合」报成「坏字节」,而「非末块却标了 last」这一形正是
        // 靠这条才与「验货失败」区分得开(否则两条路的可观测终局一模一样)。
        assert!(!frame_rejected(&outs), "{what}:形态不合该在块形闸上拒,不该跑到验货:{outs:?}");
        assert!(b.blob_penalized(&a_id, Route::Relay), "{what}:坏块 = 罚这条腿");
    }
}

/// 264 实现审 H2:**一次引擎输入产出的 `BlobWant` 有硬上界**。原先 hello / 会话仪式 /
/// 新 image_add 各自遍历全量缺字节清单——一枚合法 `Ops` 帧最多 500 条 op,全是
/// `image_add` 就是 500 枚帧,而每链发送队列只有 256 帧:一次 dispatch 撞穿、断链、
/// 重建后再换一轮 hello 又来一遍,与 263 那个 bug 同族(负载从「单图 128 块」换成了
/// 「清单 N 枚 want」)。
#[test]
fn one_input_never_produces_more_wants_than_the_link_queue_can_take() {
    let (mut a_conn, mut a_clock, _a) = fresh();
    let (mut b_conn, mut b_clock, mut b) = fresh();
    let a_id = a_clock.device_id().to_string();
    let item = notes::capture(&mut a_conn, &mut a_clock, "一堆图").unwrap();
    const N: usize = 120; // > BLOB_WANT_BATCH,且够多到能看出「不是全量」
    for i in 0..N {
        images::attach(&mut a_conn, &mut a_clock, &item, &[(i % 251) as u8; 16], "image/png")
            .unwrap();
    }
    b.on_runtime_started(&b_conn).unwrap();
    b.relay_up(&b_conn).unwrap();

    // ① 一帧塞满 image_add 的 ops:登记进清单,但产出的 want 不许超批。
    let frames =
        ops_frames(&a_conn, &a_id, 1, watermark(&a_conn, &a_id).unwrap(), "B").unwrap();
    let mut most = 0usize;
    for f in frames {
        let Output::Send { msg, .. } = f else { continue };
        let outs = b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
        most = most.max(outs.iter().filter(|o| want_image_of(o).is_some()).count());
    }
    assert_eq!(b.missing_blobs.len(), N, "清单该登记的一张不少");
    assert!(most <= BLOB_WANT_BATCH, "一帧最多问 {BLOB_WANT_BATCH} 张,实见 {most}");
    assert!(most > 0, "也不能一张都不问(那就没人推进了)");

    // ② hello 换来的缺图 want 同样有界。
    let outs = b
        .on_relay_msg(
            &mut b_conn,
            &mut b_clock,
            &a_id,
            Msg::Hello { watermarks: BTreeMap::new(), lan: None },
        )
        .unwrap();
    let wants = outs.iter().filter(|o| want_image_of(o).is_some()).count();
    assert!(wants <= BLOB_WANT_BATCH, "hello 最多问 {BLOB_WANT_BATCH} 张,实见 {wants}");
    assert!(wants > 0, "也不能一张都不问(实现审二轮 L3:只断上界的话,改成『不发问』照样绿)");

    // ③ 会话仪式同样有界(原先它也遍历全量清单)。
    let outs = b.relay_up(&b_conn).unwrap();
    let wants = outs.iter().filter(|o| want_image_of(o).is_some()).count();
    assert!(wants <= BLOB_WANT_BATCH, "会话仪式最多问 {BLOB_WANT_BATCH} 张,实见 {wants}");
    assert!(wants > 0, "会话仪式也得真问(同上)");

    // ④ 心跳这一路同样有界,且**同图不重复**(二轮 L1:`fail_pull` 的重问与这一批
    //    会撞车,`on_tick` 原先漏了去重)。
    let outs = b.on_tick();
    let wants: Vec<&str> = outs.iter().filter_map(want_image_of).collect();
    assert!(wants.len() <= BLOB_WANT_BATCH, "心跳最多问 {BLOB_WANT_BATCH} 张,实见 {}", wants.len());
    let uniq: HashSet<&&str> = wants.iter().collect();
    assert_eq!(uniq.len(), wants.len(), "一轮里同一张图不许问两枚:{wants:?}");
}

/// 补问的**轮转**:清单里那张排最前的图若根本没人有,恒取最小就会把后面的永久挡住。
/// 心跳每拍推一格游标,故清单里每张都在 N 拍内被问到。
#[test]
fn the_refill_cursor_rotates_so_no_missing_image_is_starved() {
    let (mut a_conn, mut a_clock, _a) = fresh();
    let (mut b_conn, mut b_clock, mut b) = fresh();
    let a_id = a_clock.device_id().to_string();
    let item = notes::capture(&mut a_conn, &mut a_clock, "三张图").unwrap();
    let mut imgs = vec![];
    for i in 0..3u8 {
        let (id, _) =
            images::attach(&mut a_conn, &mut a_clock, &item, &[i + 1; 16], "image/png").unwrap();
        imgs.push(id);
    }
    b.on_runtime_started(&b_conn).unwrap();
    b.relay_up(&b_conn).unwrap();
    feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
    assert_eq!(b.missing_blobs.len(), 3);

    // 谁也不应答:光靠心跳,三拍之内三张都得被问到一次。
    let mut asked: HashSet<String> = HashSet::new();
    for _ in 0..3 {
        for o in b.on_tick() {
            if let Output::Send { msg: Msg::BlobWant { image_id }, .. } = o {
                asked.insert(image_id);
            }
        }
    }
    assert_eq!(asked.len(), 3, "三拍内三张全被问过:{asked:?}");
}

/// 取出唯一一枚 BlobPull 的 (路由意向, transfer)。
fn pull_of(outs: &[Output]) -> Option<(RouteHint, String)> {
    outs.iter().find_map(|o| match o {
        Output::Send { route_hint, msg: Msg::BlobPull { transfer, .. }, .. } => {
            Some((*route_hint, transfer.clone()))
        }
        _ => None,
    })
}

#[test]
fn blob_route_picks_lan_first_and_never_conjures_a_route() {
    // §5.1:选路只看路由健康表——两条腿都不 Up 就**不拉**(图留在清单),
    // 绝不「先试服务器再靠 Nack 学状态」;两条都 Up 时 LAN 优先。
    let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
    // ① 无腿:have 到了也不拉,图仍在缺字节清单。
    let outs = eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
    assert!(pull_of(&outs).is_none(), "无健康腿不许发 pull:{outs:?}");
    assert!(eng.pulling.is_empty() && eng.missing_blobs.contains(&img), "图留在清单等重来");
    // ② 只有中转腿:走中转。
    eng.on_relay_peer_up(&a_id);
    let outs = eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
    let (hint, _) = pull_of(&outs).expect("有中转腿必拉");
    assert_eq!(hint, RouteHint::Require(Route::Relay));
    assert_eq!(eng.pulling[&img].route, Route::Relay);
    // ③ 两条腿都在:LAN 优先(重来一遍:先把这笔拉流作废)。
    eng.on_relay_peer_down(&a_id);
    eng.on_relay_peer_up(&a_id);
    eng.on_lan_link_up(&conn, &a_id, 7).unwrap();
    let outs = eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
    let (hint, _) = pull_of(&outs).expect("两条腿都在也得拉");
    assert_eq!(hint, RouteHint::Require(Route::Lan), "LAN 优先");
    assert_eq!(eng.pulling[&img].generation, 7, "transfer 绑住链路代次");
}

/// 打 `times` 拍心跳(§6.2 ⑥):推进引擎 tick,并让 [`OpsWorks::on_tick`] 把冷却里
/// 停着的对账/补洞义务放行。
///
/// sans-io 夹具没有协调者,这一拍**得自己打**。少了它,「同一对端的第二枚 Hello」
/// 恒停在 `pending`,于是任何跟在它后面的判据验的其实都是冷却 —— 那正是 292 栽过的
/// 「判据看的那一格压根不由被测那件事决定」。
fn beat_ops(eng: &mut Engine, conn: &Connection, times: u64) {
    for _ in 0..times {
        eng.on_tick();
        // 这一拍产出的帧本测不关心(要的只是「冷却到点」这个副作用)。
        let _ = eng.ops_tick(conn, &mut vec![]).expect("ops tick");
    }
}

#[test]
fn arrival_leg_affinity_pins_directed_answers_only() {
    // §5/§6:定向应答沿来路(LAN 到达 → Require(Lan));广播帧不改写(补洞 want /
    // 缺图 want 该问所有人);direct lane 恒钉来路(同一 transfer 不跨路)。
    let (mut conn, mut clock, mut eng, _img, a_id) = peer_missing_one_image();
    // LAN 到达的 hello:定向 BlobWant 钉 Require(Lan)。
    let outs = eng
        .on_msg_v(
            &mut conn,
            &mut clock,
            &a_id,
            Route::Lan,
            Msg::Hello { watermarks: BTreeMap::new(), lan: None },
        )
        .unwrap();
    // 第5笔:**来路亲和搬到了描述符上**。补给帧不再由引擎当场产出,故「沿来路答」
    // 这件事此后钉在 `OpsServeTo::Peer{route}` 里 —— 由它决定摇哪条腿的铃(投递面
    // 照 `BlobServe.route` 的成例分路)。判据跟着搬,语义一个字没变。
    let supply = outs
        .iter()
        .find_map(|o| match o {
            Output::ServeOps(OpsServe { to: OpsServeTo::Peer { device, route } }) => {
                Some((device.clone(), *route))
            }
            _ => None,
        })
        .expect("hello 换来定向补给的描述符");
    assert_eq!(supply.0, a_id, "定向补给它");
    assert_eq!(supply.1, Route::Lan, "沿来路答");
    assert!(
        !eng.drain_ops_for_test(&conn).unwrap().is_empty(),
        "而且真抽得出补给帧(描述符不该指向一份空计划)"
    );
    // 同一枚 hello 换来的**缺图 want 是广播**:§5「广播帧一律不改写——补洞 want /
    // 缺图 want 是该让所有人知道的,不因某帧来路窄化收件面」。264 起 hello 的缺图
    // 发问统一走有界轮转批([`Engine::want_batch`]),不再按对端定向问全量清单。
    let want = outs
        .iter()
        .find(|o| matches!(o, Output::Send { msg: Msg::BlobWant { .. }, .. }))
        .expect("hello 换来缺图 want");
    let Output::Send { to, route_hint, .. } = want else { unreachable!() };
    assert_eq!(to, BROADCAST, "缺图 want 该问所有人");
    assert_eq!(*route_hint, RouteHint::Auto, "广播不因来路窄化收件面");
    // 同一枚 hello 经中转到达:定向补给照 Auto(留着「对端中转离线补投 lan」那条腿)。
    //
    // ⚠ 先打够心跳:第⑤笔起**同一对端的第二枚 Hello 受对账冷却管**
    // (`RECONCILE_COOLDOWN_TICKS`),不放行的话下面那句 expect 验的是冷却、不是来路亲和。
    beat_ops(&mut eng, &conn, ops_serve::RECONCILE_COOLDOWN_TICKS);
    let outs = eng
        .on_relay_msg(
            &mut conn,
            &mut clock,
            &a_id,
            Msg::Hello { watermarks: BTreeMap::new(), lan: None },
        )
        .unwrap();
    // 同前:来路亲和钉在描述符上。中转到达 → 描述符绑 `Route::Relay`。
    let supply = outs
        .iter()
        .find_map(|o| match o {
            Output::ServeOps(OpsServe { to: OpsServeTo::Peer { device, route } }) => {
                Some((device.clone(), *route))
            }
            _ => None,
        })
        .expect("hello 换来定向补给的描述符");
    assert_eq!(supply.0, a_id);
    assert_eq!(supply.1, Route::Relay, "中转到达就绑中转腿");
    // 广播帧不改写:LAN 到达的 ops 帧留下缺口 → 广播 want 仍是 Auto。
    let op2 = topic_op(DEV, 1_002, 2, "01TOPICROUTE0000000000001");
    let outs = eng
        .on_msg_v(
            &mut conn,
            &mut clock,
            DEV,
            Route::Lan,
            Msg::Ops { origin: DEV.into(), ops: vec![op2] },
        )
        .unwrap();
    let bcast = outs
        .iter()
        .find(|o| matches!(o, Output::Send { msg: Msg::Want { .. }, .. }))
        .expect("洞在 1,必广播 want");
    let Output::Send { to, route_hint, .. } = bcast else { unreachable!() };
    assert_eq!(to, BROADCAST);
    assert_eq!(*route_hint, RouteHint::Auto, "广播不因来路窄化收件面");
    // direct lane:经中转到达的 pull,块也钉 Require(Relay)(不许中途改道)。
    let mut serving = fresh();
    let item = notes::capture(&mut serving.0, &mut serving.1, "供块方").unwrap();
    let (simg, _) =
        images::attach(&mut serving.0, &mut serving.1, &item, &[5u8; 8], "image/png").unwrap();
    let served = serving
        .2
        .on_relay_msg(
            &mut serving.0,
            &mut serving.1,
            "PULLERDEV00000000000000001",
            Msg::BlobPull { image_id: simg, transfer: "01TRANSFER0000000000000042".into() },
        )
        .unwrap();
    // C′ 之后「块沿来路发」这条不变量由**描述符绑的那条腿**承载(§10):引擎不再产
    // 块,故也不再有一串 `Require(Relay)` 的 Send 可看。
    assert!(
        matches!(&served[..], [Output::ServeBlob(s)] if s.route == Route::Relay),
        "供流描述符必须绑来路那条腿:{served:?}"
    );
}

#[test]
fn chunks_from_another_leg_are_dropped() {
    // §5.1 收端闸:同一 transfer 的块永不跨路——供块方若改道发来,持有者丢弃,
    // 不变量不指望发送端自律。
    let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
    eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
    let outs = eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
    let (_, transfer) = pull_of(&outs).expect("LAN 腿拉流");
    let chunk = Msg::BlobChunk {
        image_id: img.clone(),
        transfer: transfer.clone(),
        idx: 0,
        last: true,
        data: vec![3u8; 12],
    };
    // 经中转送来同一 transfer 的块:丢(不建行、拉流不动)。
    eng.on_relay_msg(&mut conn, &mut clock, &a_id, chunk.clone()).unwrap();
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "换腿来的块不落地");
    assert!(eng.pulling.contains_key(&img), "拉流不受伤");
    // 沿本腿送来:照常建行。
    eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, chunk).unwrap();
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "沿本腿的块照常建行");
}

#[test]
fn relay_session_up_resets_only_the_relay_dimension() {
    // 二轮 H1:中转重连**不许**误伤 lan 维度——lan 在飞拉流、lan 惩罚、lan shun 全留;
    // relay 维度则整体重置(在飞作废、惩罚与 shun 清零)。
    let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
    const OTHER: &str = "OTHERPEERROUTE000000000001";
    // lan 腿上起一笔拉流,另给 relay 腿人为记一笔惩罚 + shun。
    eng.on_lan_link_up(&conn, &a_id, 3).unwrap();
    eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
    assert_eq!(eng.pulling[&img].route, Route::Lan);
    eng.penalize_blob(&a_id, Route::Relay);
    eng.penalize_blob(OTHER, Route::Lan);
    eng.blob_shunned
        .entry(img.clone())
        .or_default()
        .extend([(a_id.clone(), Route::Relay), (OTHER.to_string(), Route::Lan)]);
    eng.relay_up(&conn).unwrap();
    assert_eq!(eng.pulling[&img].route, Route::Lan, "lan 在飞拉流不受中转重连影响");
    assert!(!eng.blob_penalized(&a_id, Route::Relay), "relay 惩罚清零");
    assert!(eng.blob_penalized(OTHER, Route::Lan), "lan 惩罚照留");
    let shunned = eng.blob_shunned.get(&img).expect("lan 的 shun 条目还在");
    assert!(!shunned.contains(&(a_id.clone(), Route::Relay)), "relay 的 shun 清零");
    assert!(shunned.contains(&(OTHER.to_string(), Route::Lan)), "lan 的 shun 照留");
    assert_eq!(eng.route_up_generation(&a_id, Route::Lan), Some(3), "lan 连接态与代次不动");
}

#[test]
fn relay_down_and_lan_link_down_stay_in_their_own_lane() {
    // §5.1/§6:会话级 relay 断只丢 relay 连接态、惩罚照留;对端级 down 只动那一台;
    // lan link_down 只作废**该代次**——glare 换链后迟到的旧代断链通报打不掉新链。
    let (conn, _clock, mut eng, _img, a_id) = peer_missing_one_image();
    eng.on_relay_peer_up(&a_id);
    eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
    eng.penalize_blob(&a_id, Route::Relay);
    eng.on_relay_session_down();
    assert_eq!(eng.route_up_generation(&a_id, Route::Relay), None, "relay 腿断");
    assert!(eng.blob_penalized(&a_id, Route::Relay), "惩罚独立于 socket 代次,不清");
    assert_eq!(eng.route_up_generation(&a_id, Route::Lan), Some(1), "lan 腿不受牵连");
    // glare:新链(代次 2)顶上,旧代 1 的断链通报迟到 → 新链必须活着。
    eng.on_lan_link_up(&conn, &a_id, 2).unwrap();
    eng.on_lan_link_down(&a_id, 1);
    assert_eq!(eng.route_up_generation(&a_id, Route::Lan), Some(2), "旧代断链不许打掉新链");
    // lan 腿的惩罚同样独立于 socket 代次:断链、重建都不清。
    eng.penalize_blob(&a_id, Route::Lan);
    eng.on_lan_link_down(&a_id, 2);
    assert_eq!(eng.route_up_generation(&a_id, Route::Lan), None, "本代断链才置 Absent");
    assert!(eng.blob_penalized(&a_id, Route::Lan), "断链不清 lan 惩罚");
    eng.on_lan_link_up(&conn, &a_id, 3).unwrap();
    assert!(eng.blob_penalized(&a_id, Route::Lan), "重建链路也不清 lan 惩罚");
}

#[test]
fn hello_routes_are_pinned_by_their_purpose() {
    // §2/§6:带 lan 通告的**权威** Hello 只许走鉴权路(`Require(Relay)`,否则被 §2
    // 的缓存规则整枚忽略);传输层触发的定向 Hello 按用途钉腿(公钥收敛走中转、
    // 断网期水位互换走 lan),绝不因「中转在线」而改道。
    let (conn, _clock, mut eng, _img, a_id) = peer_missing_one_image();
    let outs = eng.relay_up(&conn).unwrap();
    let Output::Send { to, route_hint, .. } = outs
        .iter()
        .find(|o| matches!(o, Output::Send { msg: Msg::Hello { .. }, .. }))
        .expect("会话仪式必发 hello")
    else {
        unreachable!()
    };
    assert_eq!(to, BROADCAST);
    assert_eq!(*route_hint, RouteHint::Require(Route::Relay), "权威 Hello 钉中转");
    for route in [Route::Relay, Route::Lan] {
        let made = eng.make_hello(&conn, &a_id, route).unwrap();
        assert_eq!(made.len(), 1, "水位游标没满额时不该带 advisory:{made:?}");
        let Output::Send { to, lane, route_hint, msg } = made.into_iter().next().unwrap()
        else {
            unreachable!()
        };
        assert_eq!(to, a_id);
        assert_eq!(lane, Lane::Mail);
        assert_eq!(route_hint, RouteHint::Require(route), "定向 Hello 钉调用方点的腿");
        assert!(matches!(msg, Msg::Hello { lan: None, .. }), "引擎产出的 Hello 恒不带通告");
    }
}

#[test]
fn runtime_started_twice_is_a_loud_error() {
    // 实现审 L2:重复派生会把在飞的图塞回缺字节清单,破掉「清单与在飞互斥」——
    // 不静默容忍(那会让下一枚 have 顶掉正在走的 transfer),响亮报错。
    let (conn, _clock, mut eng, _img, _a_id) = peer_missing_one_image();
    let err = eng.on_runtime_started(&conn).expect_err("第二次装配初始化必须报错");
    assert!(err.contains("只许一次"), "{err}");
}

#[test]
fn lan_link_down_only_invalidates_its_own_generation_transfers() {
    // §5.1:link_down 只作废该代次上的在飞 transfer。
    let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
    eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
    eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
    assert_eq!(eng.pulling[&img].generation, 1);
    eng.on_lan_link_down(&a_id, 99); // 别代的断链通报:不动这笔
    assert!(eng.pulling.contains_key(&img), "别代断链不作废本代 transfer");
    eng.on_lan_link_down(&a_id, 1);
    assert!(
        !eng.pulling.contains_key(&img) && eng.missing_blobs.contains(&img),
        "本代断链 = 整笔作废回清单"
    );
}

#[test]
fn stale_lan_pull_penalizes_that_leg_then_falls_back_to_relay() {
    // §5.1 完整一圈:LAN 半死链路(Ping 活着、块黑洞)→ stale 作废 + 罚 LAN 腿 +
    // shun (图, 对端, LAN) → 重发 want → 下一枚 have 按表改走中转(不是原地重试);
    // 惩罚只挡 blob,mail/Hello 照走;到期后 shun 与惩罚一并清,不永久。
    let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
    eng.on_relay_peer_up(&a_id);
    eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
    eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
    assert_eq!(eng.pulling[&img].route, Route::Lan);
    let mut wants = vec![];
    for _ in 0..PULL_STALE_TICKS {
        wants = eng.on_tick();
    }
    assert!(
        wants.iter().any(|o| matches!(o, Output::Send { msg: Msg::BlobWant { image_id }, .. } if image_id == &img)),
        "作废时当场重发 want:{wants:?}"
    );
    assert!(eng.blob_penalized(&a_id, Route::Lan), "罚的是那条腿");
    assert!(!eng.blob_penalized(&a_id, Route::Relay), "另一条腿无辜");
    // 惩罚不挡 mail:LAN 到达的 hello 照答(penalty 只挡 blob 选路)。
    let outs = eng
        .on_msg_v(
            &mut conn,
            &mut clock,
            &a_id,
            Route::Lan,
            Msg::Hello { watermarks: BTreeMap::new(), lan: None },
        )
        .unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::BlobWant { .. }, .. })),
        "惩罚只挡 blob 选路,hello 应答照走"
    );
    // 下一枚 have:LAN 被罚 → 改走中转(新 transfer)。
    let outs = eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
    let (hint, _) = pull_of(&outs).expect("换腿重拉");
    assert_eq!(hint, RouteHint::Require(Route::Relay), "重选其它健康腿 = 改走中转");
    assert_eq!(eng.pulling[&img].route, Route::Relay);
    // 惩罚到期:清惩罚 + 清该腿的 per-image shun(不永久 shun)。这段 tick 里中转腿
    // 也会因黑洞被罚一次(没人喂块),故只断言 LAN 腿这一条——「表里终究不留惩罚」
    // 由 property test 的第 ④ 条兜。
    for _ in 0..BLOB_PENALTY_TICKS {
        eng.on_tick();
    }
    assert!(!eng.blob_penalized(&a_id, Route::Lan), "惩罚到期");
    assert!(
        eng.blob_shunned.get(&img).is_none_or(|s| !s.contains(&(a_id.clone(), Route::Lan))),
        "到期一并清该腿的 shun:{:?}",
        eng.blob_shunned
    );
}

#[test]
fn relay_peer_up_needs_the_current_session() {
    // 三轮 M1 + 实现审 M2:(X,Relay)=Up 须「会话在 ∧ X 在线」两层同时成立——
    // ① 无会话时 peer_up 是 no-op(fail-closed,不许造出指向不存在中转的路由);
    // ② 新会话把旧会话的在线事实整体清空,故接线顺序恒是「会话建立 → 在线快照」。
    let (conn, _clock, mut eng, _img, a_id) = peer_missing_one_image();
    eng.on_relay_session_down();
    eng.on_relay_peer_up(&a_id);
    assert_eq!(eng.route_up_generation(&a_id, Route::Relay), None, "无会话不许置 Up");
    eng.relay_up(&conn).unwrap();
    eng.on_relay_peer_up(&a_id);
    assert!(eng.route_up_generation(&a_id, Route::Relay).is_some(), "会话内置位有效");
    // 重连:新会话清掉旧会话的在线事实,得重新等在线快照。
    eng.relay_up(&conn).unwrap();
    assert_eq!(eng.route_up_generation(&a_id, Route::Relay), None, "旧会话的在线事实作废");
}

#[test]
fn relay_session_up_resets_the_unacked_outbound_cursor() {
    // 实现审 H1:游标复位是**会话仪式的一部分**——已发未 ack 的本机 op 必须在重连后
    // 重推(引擎跨会话存活后,这是唯一的重推触发器);重复由对端 op_id 幂等吸收。
    //
    // 第5笔改的是**这件事怎么做**:`outbound` 不再当场物化帧,而是把
    // 「`[last_pushed+1, …)` 还欠着」登记进 BROADCAST work;会话仪式**保守合并**
    // `[acked+1, current_max]`(§6.2 ⑦ 一轮 H4:不是复位工作游标 —— 此刻可能仍有
    // LAN ticket 在飞)。故判据从「回了几枚帧」改成「**抽得出几枚帧**」:抽的是真
    // 取数路,登记没做对就一枚也抽不出来。
    let (mut conn, mut clock, mut eng) = fresh();
    eng.relay_up(&conn).unwrap();
    notes::capture(&mut conn, &mut clock, "还没被服务器接手的一笔").unwrap();
    let mut outs = vec![];
    eng.outbound(&conn, &mut outs).unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::ServeOps(s) if s.to == OpsServeTo::Broadcast)),
        "本机新 op 让 BROADCAST 从没活变有活,必须产一枚描述符:{outs:?}"
    );
    let first = eng.drain_ops_for_test(&conn).unwrap();
    assert_eq!(first.len(), 1, "抽得出那一帧:{first:?}");
    let mut again = vec![];
    eng.outbound(&conn, &mut again).unwrap();
    assert!(again.is_empty(), "登记位已推进,不重复登记");
    assert!(eng.drain_ops_for_test(&conn).unwrap().is_empty(), "也没有第二枚帧可抽");
    // 断线重连,服务器一个 ack 也没落(acked = 0)→ 同一帧必须重推。
    eng.on_relay_session_down();
    let outs = eng.on_relay_session_up(&conn, 0).unwrap();
    assert!(
        outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::Hello { .. }, .. })),
        "会话仪式照发 hello"
    );
    let redo = eng.drain_ops_for_test(&conn).unwrap();
    assert_eq!(redo.len(), 1, "未 ack 的 op 重连后由保守合并加回、重新抽得出:{redo:?}");
}

#[test]
fn invalidated_pulls_ask_again_at_once() {
    // 实现审 H2:路由失效 / 换代 / deny 让图退回缺字节清单后**没有任何定时器看着它**
    // (on_tick 只管在飞拉流),故每个「回清单」出口都必须当场再问一轮——否则另一条
    // 腿明明健康,也要等下一次偶然的 hello 才换腿。
    let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
    // 重问的形状也钉死:广播 + mail lane + Auto——发成 direct 或钉在刚失效的腿上,
    // 等于没问(§5.1/§6)。
    let asks = |outs: &[Output]| {
        outs.iter().any(|o| matches!(o, Output::Send { to, lane, route_hint, msg: Msg::BlobWant { image_id } }
            if to == BROADCAST && *lane == Lane::Mail && *route_hint == RouteHint::Auto && image_id == &img))
    };
    // ① 中转腿在飞 → 会话断:回清单 + 当场重问。
    eng.on_relay_peer_up(&a_id);
    eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
    assert_eq!(eng.pulling[&img].route, Route::Relay);
    let outs = eng.on_relay_session_down();
    assert!(asks(&outs), "会话断:作废的图当场重问:{outs:?}");
    // ② 会话重连也算「回清单」的一种:在飞的 relay 拉流作废,且本次仪式的 want 里
    //    必须含它(否则重连反而把在拉的图丢没了)。
    eng.relay_up(&conn).unwrap();
    eng.on_relay_peer_up(&a_id);
    eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
    assert!(eng.pulling.contains_key(&img));
    let outs = eng.relay_up(&conn).unwrap();
    assert!(!eng.pulling.contains_key(&img), "重连作废旧会话的在飞拉流");
    assert!(asks(&outs), "会话仪式的 want 里必须含刚作废的图:{outs:?}");
    // ③ 对端级 down 同理。
    eng.on_relay_peer_up(&a_id);
    eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
    let outs = eng.on_relay_peer_down(&a_id);
    assert!(asks(&outs), "对端离线:作废的图当场重问:{outs:?}");
    // ④ lan 链路断 + glare 换代同理。
    eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
    eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
    let outs = eng.on_lan_link_down(&a_id, 1);
    assert!(asks(&outs), "链路断:作废的图当场重问:{outs:?}");
    eng.on_lan_link_up(&conn, &a_id, 2).unwrap();
    eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
    let outs = eng.on_lan_link_up(&conn, &a_id, 3).unwrap();
    assert!(asks(&outs), "glare 换代:旧代作废的图当场重问:{outs:?}");
    // ⑤ deny(拒者已无行,这一问不与谁成环)。换代已作废上一笔,先重建一笔。
    eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
    let transfer = eng.pulling[&img].transfer.clone();
    let outs = eng
        .on_msg_v(
            &mut conn,
            &mut clock,
            &a_id,
            Route::Lan,
            Msg::BlobDeny { image_id: img.clone(), transfer: transfer.clone() },
        )
        .unwrap();
    assert!(asks(&outs), "deny:回清单当场另寻来源:{outs:?}");
    // 换腿来的 deny 不作数(来路复核):先重建一笔拉流,再从中转腿送同一枚 deny。
    eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
    let transfer = eng.pulling[&img].transfer.clone();
    let outs = eng
        .on_relay_msg(
            &mut conn,
            &mut clock,
            &a_id,
            Msg::BlobDeny { image_id: img.clone(), transfer },
        )
        .unwrap();
    assert!(outs.is_empty() && eng.pulling.contains_key(&img), "换腿的 deny 不动拉流");
}

/// 路由状态表 property test(§11 的表驱动一项;**是 24 种子 × 120 步随机事件流,
/// 不是全排列**——全排列的口径归 L-c3 的集成测):随机事件流 × 三台对端,每步
/// 复核四条不变量——① 在飞 transfer 的腿必是「当前 Up 且代次相符」;② 发出的
/// `Require(r)` 必落在当时 Up 的腿上;③ 一张图同时最多一笔 transfer(清单与在飞
/// 互斥、并集恒含该图);④ 惩罚与 shun 必然到期(静默足够多心跳后表里不留惩罚、
/// shun 清空)——不震荡、不永久 shun。
#[test]
fn route_state_table_property_holds_under_random_event_streams() {
    const PEERS: [&str; 3] = [
        "ROUTEPROPDEV00000000000001",
        "ROUTEPROPDEV00000000000002",
        "ROUTEPROPDEV00000000000003",
    ];
    for seed in 1u64..=24 {
        let (mut conn, mut clock, mut eng, img, _a_id) = peer_missing_one_image();
        let mut rng = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut next = || {
            rng ^= rng >> 12;
            rng ^= rng << 25;
            rng ^= rng >> 27;
            rng = rng.wrapping_mul(0x2545_F491_4F6C_DD1D);
            rng
        };
        let mut lan_gen = 0u64;
        for step in 0..120 {
            let peer = PEERS[(next() % 3) as usize];
            let outs = match next() % 9 {
                0 => eng.relay_up(&conn).unwrap(),
                1 => eng.on_relay_session_down(),
                2 => eng.on_relay_peer_up(peer),
                3 => eng.on_relay_peer_down(peer),
                4 => {
                    lan_gen += 1;
                    eng.on_lan_link_up(&conn, peer, lan_gen).unwrap()
                }
                5 => {
                    // 一半用当前代次、一半用陈旧代次(迟到通报)。
                    let g = if next() % 2 == 0 { lan_gen } else { lan_gen.saturating_sub(1) };
                    eng.on_lan_link_down(peer, g)
                }
                6 => eng.on_tick(),
                7 => {
                    let route = if next() % 2 == 0 { Route::Lan } else { Route::Relay };
                    eng.on_msg_v(&mut conn, &mut clock, peer, route, have(&img)).unwrap()
                }
                _ => {
                    // 半块:让 transfer 有进展但不完成(stale 计时清零)。
                    let (transfer, route) = match eng.pulling.get(&img) {
                        Some(p) => (p.transfer.clone(), p.route),
                        None => continue,
                    };
                    eng.on_msg_v(
                        &mut conn,
                        &mut clock,
                        peer,
                        route,
                        Msg::BlobChunk {
                            image_id: img.clone(),
                            transfer,
                            idx: 0,
                            last: false,
                            data: vec![1u8],
                        },
                    )
                    .unwrap()
                }
            };
            let where_ = format!("种子 {seed} 第 {step} 步");
            // ① 在飞 transfer 的腿必须还活着且代次相符。
            for (image_id, pull) in &eng.pulling {
                assert_eq!(
                    eng.route_up_generation(&pull.from, pull.route),
                    Some(pull.generation),
                    "{where_}:{image_id} 的 transfer 挂在已死/换代的腿上"
                );
            }
            // ② 钉了 `Require(Lan)` 就必须真有那条链路(帧无处可投 = 白丢)。
            //    `Require(Relay)` **刻意不查 Up**:mail 走中转不要求对端在线(进信箱
            //    就是投达),direct 的对端离线由服务器 Nack 收口——那不是不变量。
            //    但**拉流的 BlobPull** 是选路算出来的,它的腿必须当场 Up。
            for o in &outs {
                let Output::Send { to, route_hint: RouteHint::Require(r), msg, .. } = o else {
                    continue;
                };
                if *r == Route::Lan || matches!(msg, Msg::BlobPull { .. }) {
                    assert!(
                        eng.route_up_generation(to, *r).is_some(),
                        "{where_}:钉了 Require({r:?}) 却没有那条腿({msg:?})"
                    );
                }
            }
            // ③ 一张图同时最多一笔 transfer,且它恒在「清单 ∪ 在飞」里(不丢图)。
            assert!(
                eng.missing_blobs.contains(&img) ^ eng.pulling.contains_key(&img),
                "{where_}:图既不在清单也不在拉流(或两处都在)"
            );
        }
        // ④ 静默到底:惩罚与 shun 必然到期(不永久),且表不留垃圾条目
        //    (Absent 且无惩罚的条目必须被删,否则表随事件流单调涨)。
        for _ in 0..(BLOB_PENALTY_TICKS + PULL_STALE_TICKS as u64 + 2) {
            eng.on_tick();
        }
        assert!(
            eng.routes.values().all(|st| st.blob_penalty_until.is_none()),
            "种子 {seed}:惩罚必然到期"
        );
        assert!(eng.blob_shunned.is_empty(), "种子 {seed}:shun 不许永久");
        assert!(
            eng.routes.values().all(|st| st.connectivity != Connectivity::Absent),
            "种子 {seed}:路由表不许留「Absent 且无惩罚」的垃圾条目:{:?}",
            eng.routes
        );
    }
}

/// ⭐ **§4.4 那枚 `VALIDATOR_VER` bump 的自助恢复路**(B-c 第 2 段)。
///
/// 场景是真的混版:一台跑着 **v7 校验器**的库收到一枚 `stage` 为 ULID 的 op,按当时的规则
/// 归 `InvalidOp` = **per-origin 持久隔离**(此后该 origin 的帧到即丢);升级到带 §4 改判的
/// 这一版之后,`reverify_quarantined` 必须把它放出来。⚠ 版本号写的是**字面量 7**,不是
/// `VALIDATOR_VER - 1`:后者恒成立、证不了任何事,而写死 7 之后**一旦有人把 bump 撤回去,
/// `WHERE validator_ver < 7` 当场不命中,这只测就红** —— 那正是它要守的东西。
///
/// 两半都要:改判**认得的**放出来并真落地,改判**仍不认**的留在隔离里、只把版本抬到当前。
#[test]
fn a_ulid_stage_op_quarantined_by_the_old_ruler_is_released_by_the_bump() {
    const OLD_VALIDATOR_VER: i64 = 7; // 478(B-c 第 1 段)发出去的那一版
    const FIXED: &str = "RVSTAGEDEV0000000000000FX1";
    const STILL: &str = "RVSTAGEDEV0000000000000BD2";
    let (mut conn, mut clock, mut eng) = fresh();
    // 那一列本机已有(靠另一台的 create op 落的)—— 于是放出来之后 drain 能真把 op 应用掉,
    // 观测面是「行落没落」而不只是「隔离表空没空」。
    let col = Ulid::new().to_string();
    crate::replay::apply_remote_op(
        &mut conn,
        &mut clock,
        &RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: Hlc { wall_ms: 500, counter: 0, device_id: "RVSTAGEDEV0000000000000C03".into() }
                .encode(),
            entity: "board_column".into(),
            entity_id: col.clone(),
            kind: "create".into(),
            payload: json!({"title":"对端建的列","kind":"task","system":false,"position":"a6",
                            "created_at":"2026-08-25T00:00:00.000Z"}),
            origin_seq: 1,
        },
    )
    .expect("列先到");

    // 两个 origin 各隔离一条(材料随后换成「v7 会拒、v8 该怎么判」的真 op)。
    for (i, dev) in [FIXED, STILL].iter().enumerate() {
        let bad = poison_op(dev, 1_000 + i as u64, 1);
        eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev.to_string(), ops: vec![bad] })
            .unwrap();
    }
    conn.execute("UPDATE sync_quarantine SET validator_ver = ?1", [OLD_VALIDATOR_VER]).unwrap();
    let item = Ulid::new().to_string();
    let swap = |conn: &Connection, origin: &str, stage: &str| {
        let op = RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: Hlc { wall_ms: 2_000, counter: 0, device_id: origin.into() }.encode(),
            entity: "item".into(),
            entity_id: item.clone(),
            kind: "create".into(),
            payload: json!({"content":"对端的卡","stage":stage,"created_at":"2026-08-25T00:00:00Z",
                            "born_stage":stage,"due_on":null,"priority":null,"position":"a0"}),
            origin_seq: 1,
        };
        conn.execute(
            "UPDATE sync_quarantine SET op_blob = ?2 WHERE origin = ?1",
            rusqlite::params![origin, serde_json::to_vec(&op).unwrap()],
        )
        .unwrap();
    };
    swap(&conn, FIXED, &col); // v7 判 InvalidOp、v8 判合法
    swap(&conn, STILL, "既不是种子也不是 ULID"); // 两版都判 InvalidOp

    let _ = reverify_ok(&mut eng, &mut conn, &mut clock);

    // 改判认得的:清隔离、归池、经 drain 真落地。
    assert!(quarantine_row(&conn, FIXED).is_none(), "新规则接受了它,必须放出来");
    assert!(!eng.quarantined.contains(FIXED));
    assert_eq!(watermark(&conn, FIXED).unwrap(), 1, "归池后由 drain 应用");
    let stage: String =
        conn.query_row("SELECT stage FROM items WHERE id = ?1", [&item], |r| r.get(0)).unwrap();
    assert_eq!(stage, col, "卡真的落在那列自定义列上");
    // 改判仍不认的:留在隔离里,只把版本抬到当前(下次升级前不再重跑)。
    let (.., ver) = quarantine_row(&conn, STILL).expect("仍非法必须保留");
    assert_eq!(ver, crate::replay::VALIDATOR_VER);
    assert!(eng.quarantined.contains(STILL));
}
