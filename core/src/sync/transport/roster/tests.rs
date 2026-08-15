//! [`RosterSched`] 的行为测(identity-plan §5.14-3c/3d/3f/3g)。
//!
//! **这台机器刻意做成纯的**,就是为了这批测试:生产周期是 5 分钟、UI deadline 8 秒,
//! 靠真等验不动;而「恰在 deadline 边界」这种格子靠调度运气去撞,就是本案明令禁止的
//! 「靠手速的验收」。这里 `now` 是入参,边界是**算出来的等号**,不是等出来的。

use super::*;

/// 测试用的周期长度。**故意不取生产值**:这台机器的性质由「deadline 与拉取周期的关系」
/// 决定,不由具体秒数决定;取一个短的,反而能让 `REFRESH_DEADLINE`(8s)与它的大小
/// 关系两边都造得出来。
const PULL: Duration = Duration::from_secs(300);

fn sched() -> RosterSched {
    RosterSched::new(PULL)
}

fn entry(d: &str, admin: bool) -> RosterEntry {
    RosterEntry { device: d.into(), admin }
}

/// 一枚 UI 回执通道:发送端交给机器,接收端留给断言。
fn reply() -> (RosterReply, oneshot::Receiver<Result<(), String>>) {
    oneshot::channel()
}

/// `on_roster` 的测试外壳:把「状态面被写了几次、写进去的是什么」记下来。
///
/// ⚠ 这只壳存在的理由不是省字:状态面的写入是**入参回调**,而「它恒在结账之前发生」
/// 正是弹三 M2 那条修法的全部内容 —— 记录下来才断言得动(见
/// `状态面先写完再结账` 那只测)。
fn recv_roster(
    s: &mut RosterSched,
    request: Option<u64>,
    revision: u64,
    devices: Vec<RosterEntry>,
) -> Vec<Option<Vec<RosterEntry>>> {
    let mut wrote = Vec::new();
    s.on_roster(request, revision, devices, |snap| wrote.push(snap));
    wrote
}

/// 让机器进入「服务器已确认支持」态:attach 那枚推送(无请求号)。
fn cap_on(s: &mut RosterSched, now_devices: Vec<RosterEntry>) {
    let _ = recv_roster(s, None, 1, now_devices);
    assert!(s.cap_seen(), "一枚 Roster 就是全部的能力信号");
}

/// 打满 [`ROSTER_PULL_TICKS`] 拍,拿到那枚周期请求的号与**发帧时刻**。
///
/// ⚠ 前 9 拍逐拍断言「不发」:少了这一句,把周期写成「每拍都发」也照样过 —— 判据要
/// 覆盖的是「恰好第 10 拍」,不是「第 10 拍有」。
fn beat_to_request(s: &mut RosterSched, from: Instant) -> (u64, Instant) {
    for i in 1..ROSTER_PULL_TICKS {
        let at = from + Duration::from_secs(i.into());
        assert_eq!(s.on_tick(at), None, "第 {i} 拍不该发帧");
    }
    let at = from + Duration::from_secs(ROSTER_PULL_TICKS.into());
    (s.on_tick(at).expect("第 10 拍恰好一枚"), at)
}

// ---- 能力闸与恒在轴的起点 ----

/// 没收到过 `Roster` ⇒ 恒在轴**整个不开张**,连拍数都不走。
///
/// 拍数也不许走的理由:若它一路数到 10,服务器刚确认支持的那一拍就会立刻甩出一枚
/// `RosterReq`,而不是从零起数 —— 那与「每 10 拍一枚」不是同一件事。
#[test]
fn 能力未确认时恒在轴不发帧也不数拍() {
    let mut s = sched();
    let t0 = Instant::now();
    for i in 0..(ROSTER_PULL_TICKS * 3) {
        assert_eq!(s.on_tick(t0 + Duration::from_secs(i.into())), None, "第 {i} 拍不该发帧");
    }
    assert_eq!(s.ticks, 0, "拍数不许在能力确认前偷跑");
    cap_on(&mut s, vec![entry("D1", true)]);
    // 确认之后才从零起数:第 9 拍仍无、第 10 拍恰一枚。
    for i in 1..ROSTER_PULL_TICKS {
        assert_eq!(s.on_tick(t0 + Duration::from_secs(i.into())), None, "第 {i} 拍不该发帧");
    }
    assert_eq!(s.on_tick(t0 + Duration::from_secs(ROSTER_PULL_TICKS.into())), Some(0));
}

/// §5.14-3g②:请求**快速成功**之后,随后 9 拍零请求、第 10 拍恰好一枚。
///
/// ⭐ 这是六轮 M1 后半那条「拍数复位」的对症测:少了 `start_request` 里那句 `ticks = 0`,
/// 应答很快回来清掉 pending 而 `ticks` 还停在 10 ⇒ **下一拍就再发一枚**,实际周期从
/// 约 5 分钟退化成约 30 秒。
#[test]
fn 快速成功之后拍数复位周期不退化() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (n, t10) = beat_to_request(&mut s, t0);
    // 应答当场就回来了(快速成功)。
    let _ = recv_roster(&mut s, Some(n), 2, vec![entry("D1", true)]);
    assert!(s.periodic.is_none(), "匹配号的应答清掉那唯一的 pending");
    for i in 1..ROSTER_PULL_TICKS {
        assert_eq!(
            s.on_tick(t10 + Duration::from_secs(i.into())),
            None,
            "成功之后的第 {i} 拍不该发帧(拍数从发帧那一刻起算)"
        );
    }
    assert_eq!(
        s.on_tick(t10 + Duration::from_secs(ROSTER_PULL_TICKS.into())),
        Some(n + 1),
        "再满 10 拍才发下一枚"
    );
}

/// §5.14-3c①:第一枚应答**丢了**,deadline 之后确实重发并恢复。
///
/// 这条是恒在轴存在的全部理由(§5.4 一轮 H2):服务端的 `push()` 就是
/// `try_send().is_ok()`,通道满时那枚帧静默消失,而名册的正确性绝不能挂在推送上。
#[test]
fn 应答丢了到期重发并恢复() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (n, sent_at) = beat_to_request(&mut s, t0);
    // 应答**从未到达**。deadline 之前一拍都不该重发(一笔在飞就是一笔)。
    assert_eq!(s.on_tick(sent_at + PULL - Duration::from_secs(1)), None, "未到期不重发");
    // 到点:作废旧 n、发新的 —— 而且**一次心跳只发一枚**。
    let n2 = s.on_tick(sent_at + PULL).expect("到期重发");
    assert_eq!(n2, n + 1, "换的是新号,旧号作废");
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n2), "新号占住那唯一的 pending");
    // 新的这一枚回来了,恢复。
    let wrote = recv_roster(&mut s, Some(n2), 5, vec![entry("D1", true), entry("D2", false)]);
    assert_eq!(wrote.len(), 1, "更新的一份要写进状态面");
    assert!(s.periodic.is_none());
    assert_eq!(s.snapshot().expect("有名册").len(), 2);
}

/// §5.14-3d④:`PULL_DEADLINE == 拉取周期` 的边界。判据写死为 `now >= deadline`
/// (三轮裁决),**恰在边界那一拍只发一枚**。
#[test]
fn 到期判据恰在边界发且只发一枚() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (n, sent_at) = beat_to_request(&mut s, t0);
    // 差一纳秒:不算过期。
    assert_eq!(s.on_tick(sent_at + PULL - Duration::from_nanos(1)), None);
    // 恰相等:算过期,发一枚。
    assert_eq!(s.on_tick(sent_at + PULL), Some(n + 1));
    // 同一刻再来一拍不该又发(pending 已换新、deadline 已推远)。
    assert_eq!(s.on_tick(sent_at + PULL), None, "一次到期只换一枚,不许补第二枚");
}

// ---- UI 搭车(§5.4「UI 请求刷新」三格) ----

/// §5.14-3f 后半 + 3d②:`remaining > REFRESH_DEADLINE` ⇒ **订阅旧请求、不发第二帧**。
#[test]
fn ui搭车不发第二帧() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (n, sent_at) = beat_to_request(&mut s, t0);
    let (tx, _rx) = reply();
    // 旧请求还剩 PULL - 1s,远多于 8s。
    assert_eq!(s.on_ui_request(sent_at + Duration::from_secs(1), tx), None, "搭车,不发帧");
    assert_eq!(s.waiter.as_ref().map(|w| w.n), Some(n), "waiter 挂在现有 n 上");
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n), "pending 仍是那一枚,没被换掉");
    assert_eq!(s.next_n, n + 1, "没有出第二个号 = 没有第二笔归属含糊的请求");
}

/// §5.14-3f 前半:`remaining == REFRESH_DEADLINE` 那一刻**走换新**,且新请求不会撞
/// 服务端的 `ROSTER_REQ_MIN_GAP`。
///
/// ⭐ 五轮 M1 我算错的正是这一格:闸要挡的是「**换新那一刻旧请求的年龄**」
/// = `PULL_DEADLINE − REFRESH_DEADLINE`,不是「超时长度」。这里把那个年龄真算出来比。
#[test]
fn 剩余恰等于ui期限时换新且不撞限频() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (n, sent_at) = beat_to_request(&mut s, t0);
    // remaining 恰等于 REFRESH_DEADLINE(判据是 `>`,故这一刻不满足「剩得多」)。
    let at = sent_at + PULL - REFRESH_DEADLINE;
    let (tx, _rx) = reply();
    let n2 = s.on_ui_request(at, tx).expect("换新,要发帧");
    assert_eq!(n2, n + 1);
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n2), "旧 n 作废,新 n 占住 pending");
    assert_eq!(s.waiter.as_ref().map(|w| w.n), Some(n2), "waiter 也挂新 n");
    // 旧请求此刻的年龄 = PULL − REFRESH_DEADLINE,必须 ≥ 服务端最短应答间隔。
    let age = at.duration_since(sent_at);
    assert_eq!(age, PULL - REFRESH_DEADLINE);
    assert!(
        age >= Duration::from_secs(ROSTER_REQ_MIN_GAP_SECS),
        "换新那一刻旧请求年龄 {age:?} < {ROSTER_REQ_MIN_GAP_SECS}s ⇒ 新请求当场撞 busy"
    );
}

/// §5.14-3g①:UI 那枚先在飞,**下一拍 periodic 不产生第二帧**,同一枚 `n` 成为共同 pending。
///
/// 六轮 M1 前半的对症测:我五轮只写了「UI 遇到 periodic 在飞就订阅」,反方向没定义 ——
/// UI 在第 9 拍发了自己那枚(此时 periodic 无 pending),下一拍 periodic 看见自己没
/// pending 就又发一枚 ⇒ 同连接两笔在飞,而且第二枚离第一枚不足 5s、多半当场撞 `busy`。
#[test]
fn ui先发之后周期那一拍不补第二帧() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    // 走到第 9 拍(还没轮到周期发)。
    for i in 1..ROSTER_PULL_TICKS {
        assert_eq!(s.on_tick(t0 + Duration::from_secs(i.into())), None);
    }
    let at9 = t0 + Duration::from_secs((ROSTER_PULL_TICKS - 1).into());
    let (tx, _rx) = reply();
    let n = s.on_ui_request(at9, tx).expect("periodic 无 pending ⇒ UI 自己发一枚");
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n), "UI 发的那枚也占住 periodic");
    // 第 10 拍到:拍数已被复位,且 pending 未到期 ⇒ 不发。
    assert_eq!(
        s.on_tick(t0 + Duration::from_secs(ROSTER_PULL_TICKS.into())),
        None,
        "同一枚 n 是共同 pending,周期这一拍不许再出一枚"
    );
    assert_eq!(s.next_n, n + 1, "全程只出过一个号");
}

// ---- 结账:两条匹配判据各判一次 ----

/// §5.14-3e:一枚**共享 `n`** 的 `Roster` 一次结清 pending 与 waiter 两者。
///
/// ⛔ 四轮 M2 的对症测:写成 `if / else if` 必红 —— UI 搭车之后同一枚 `n` 既是 pending
/// 的号、也是 waiter 的号,只清一个就会把 UI 晾到超时(或把恒在轴的 pending 留成幽灵)。
#[test]
fn 共享号的应答一次结清两者() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (tx, rx) = reply();
    let n = s.on_ui_request(t0, tx).expect("无 pending ⇒ 发新的,两者同号");
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n));
    assert_eq!(s.waiter.as_ref().map(|w| w.n), Some(n));
    let _ = recv_roster(&mut s, Some(n), 7, vec![entry("D1", true), entry("D2", true)]);
    assert!(s.periodic.is_none(), "pending 没被清 = 恒在轴被自己的幽灵挡住");
    assert!(s.waiter.is_none(), "waiter 没被清 = UI 干等到超时");
    rx.blocking_recv().expect("回执必到").expect("成功");
}

/// 同一格的 `RosterNack` 面(三轮 M2 那张表的「匹配 periodic」∧「匹配 UI」两行同时成立)。
#[test]
fn 共享号的nack一次结清两者且不清名册() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (tx, rx) = reply();
    let n = s.on_ui_request(t0, tx).expect("发新的");
    s.on_nack(n, "服务器忙".into());
    assert!(s.periodic.is_none() && s.waiter.is_none(), "两者一次结清");
    assert!(rx.blocking_recv().expect("回执必到").is_err(), "UI 拿到失败");
    // ⛔ busy 只是「这次刷新失败」,不是「否定上一份权威名单」。清成 None 会连带把
    // 第②笔的直连闸翻成 fail-open。
    assert!(s.snapshot().is_some(), "已有的名册绝不许被一枚 Nack 清掉");
}

/// §5.14-3d③ 的第三格:号对不上的 `RosterNack` —— 不结 pending 也不结 waiter、不动名册。
#[test]
fn 号对不上的nack谁也不结() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (tx, mut rx) = reply();
    let n = s.on_ui_request(t0, tx).expect("发新的");
    s.on_nack(n + 99, "服务器忙".into());
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n), "pending 原样在飞");
    assert_eq!(s.waiter.as_ref().map(|w| w.n), Some(n), "waiter 原样在飞");
    assert!(rx.try_recv().is_err(), "UI 不该被一枚不相干的 Nack 结账");
    assert!(s.snapshot().is_some());
}

/// §5.14-3d③ 的另两格:`RosterNack` 只匹配 periodic(周期那枚撞限频)⇒ 清 pending、
/// **保留当前 roster**、UI 那枚不受影响;只匹配 UI ⇒ 只结 waiter。
#[test]
fn nack分别只匹配周期或只匹配ui() {
    // 只匹配 periodic:UI 那枚是另一个号(先让 UI 换新,旧 n 留在服务器那边)。
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (n_old, sent_at) = beat_to_request(&mut s, t0);
    let (tx, mut rx) = reply();
    // 剩余恰等于 8s ⇒ 换新;旧 n_old 已作废,新 n 是共同 pending。
    let n_new = s.on_ui_request(sent_at + PULL - REFRESH_DEADLINE, tx).expect("换新");
    // 旧号的 Nack 迟到:谁也不该结。
    s.on_nack(n_old, "服务器忙".into());
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n_new));
    assert!(rx.try_recv().is_err());

    // 只匹配 UI:waiter 在 n 上,而 periodic 已被别的路清掉。
    let mut s2 = sched();
    cap_on(&mut s2, vec![entry("D1", true)]);
    let (tx2, rx2) = reply();
    let n2 = s2.on_ui_request(t0, tx2).expect("发新的");
    s2.periodic = None; // 模拟「pending 已由别的路结清,waiter 还挂着」
    s2.on_nack(n2, "服务器忙".into());
    assert!(s2.waiter.is_none(), "只结 waiter");
    assert!(rx2.blocking_recv().expect("回执必到").is_err());
}

/// §5.14-3c③ / 二轮 M1:**匹配请求号但 revision 更小 → 结账、不倒灌**。
///
/// 反例:我的应答带 revision 10,而一枚并发成员变更的推送带 revision 11 先到;若按
/// 「revision 更小就早返丢弃」处理,那枚匹配我请求号的应答会被整个丢掉 ⇒ UI 刷新
/// 错误地超时。
#[test]
fn 匹配号但revision更旧结账而不倒灌() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (tx, rx) = reply();
    let n = s.on_ui_request(t0, tx).expect("发新的");
    // 并发的成员变更推送先到,revision 更大。
    let w1 = recv_roster(&mut s, None, 11, vec![entry("D1", true), entry("D9", false)]);
    assert_eq!(w1.len(), 1);
    // 我那枚应答随后到达,revision 更小。
    let w2 = recv_roster(&mut s, Some(n), 10, vec![entry("D1", true)]);
    assert!(w2.is_empty(), "更旧的 payload 不许倒灌进状态面");
    assert!(s.periodic.is_none() && s.waiter.is_none(), "但账必须结掉");
    rx.blocking_recv().expect("回执必到").expect("成功");
    assert_eq!(s.snapshot().expect("有名册").len(), 2);
}

/// §5.14-3d⑤:旧 `n` 的迟到 `Roster` —— **不结新 flow,但 revision 更新时仍应用 payload**。
///
/// 号只管「结不结账」,revision 只管「用不用这份数据」,两条不冲突(三轮裁决)。
#[test]
fn 旧号迟到的名册不结新flow但照样应用() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (n_old, sent_at) = beat_to_request(&mut s, t0);
    let (tx, mut rx) = reply();
    let n_new = s.on_ui_request(sent_at + PULL - REFRESH_DEADLINE, tx).expect("换新");
    assert_ne!(n_old, n_new);
    // 旧号的应答迟到了,内容却是更新的。
    let wrote = recv_roster(&mut s, Some(n_old), 12, vec![entry("D1", true), entry("D2", true)]);
    assert_eq!(wrote.len(), 1, "它仍是权威名册,照样进状态面");
    assert_eq!(s.snapshot().expect("有名册").len(), 2);
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n_new), "不许结掉新 flow");
    assert!(rx.try_recv().is_err(), "UI 还在等它自己那一枚");
}

/// 主动推送(`request == None`)不结任何账,但 revision 更新时照样应用。
#[test]
fn 主动推送不结账但应用() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (tx, mut rx) = reply();
    let n = s.on_ui_request(t0, tx).expect("发新的");
    let wrote = recv_roster(&mut s, None, 20, vec![entry("D1", true), entry("D2", false)]);
    assert_eq!(wrote.len(), 1);
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n), "推送不是我这枚的应答");
    assert!(rx.try_recv().is_err(), "UI 必须等到带号的那一枚才算刷新成功");
}

// ---- 三个超时职责分开 ----

/// §5.4:UI 超时**只摘 ui_waiter**,共同 pending 留给 periodic。
///
/// 用户那一声「算了」不该把恒在轴一起掐掉 —— 恒在轴是名册正确性的唯一依靠。
#[test]
fn ui超时只摘自己pending留给周期() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (tx, rx) = reply();
    let n = s.on_ui_request(t0, tx).expect("发新的");
    assert_eq!(s.ui_deadline(), Some(t0 + REFRESH_DEADLINE), "UI 走自己的短 deadline");
    s.on_ui_deadline();
    assert!(rx.blocking_recv().expect("回执必到").is_err());
    assert!(s.waiter.is_none());
    assert_eq!(s.periodic.as_ref().map(|p| p.n), Some(n), "共同 pending 留给 periodic");
    assert_eq!(s.ui_deadline(), None, "没有 waiter 就不该再挂那条 select 臂");
    // 那枚 pending 的应答随后到达:照样清得掉(它的所有者一直是 periodic)。
    let _ = recv_roster(&mut s, Some(n), 3, vec![entry("D1", true)]);
    assert!(s.periodic.is_none());
}

/// 会话收场:清 pending / waiter / 拍数 / 能力位 / 发号器 / 名册,并把在等的 UI 结掉。
///
/// 「客户端不缓存、不落库,会话断开即清成**不知道**」是本案坑①的结构性答案。
#[test]
fn 收场清空全部会话态并结清等待者() {
    let mut s = sched();
    let t0 = Instant::now();
    cap_on(&mut s, vec![entry("D1", true)]);
    let (tx, rx) = reply();
    let _ = s.on_ui_request(t0, tx).expect("发新的");
    s.end_session();
    assert!(rx.blocking_recv().expect("回执必到").is_err(), "在等的 UI 必须被结掉");
    assert!(!s.cap_seen(), "能力位是会话内事实");
    assert!(s.snapshot().is_none(), "名册清成「不知道」,不是清成空名单");
    assert!(s.periodic.is_none() && s.waiter.is_none());
    assert_eq!((s.ticks, s.next_n, s.revision), (0, 0, None));
    // ⭐ 收场之后再结一次账**不许再报第二次失败**(§5.5 五轮:take() 只在 settle 里做)。
    s.end_session();
}

/// `revision` 相等时照样应用:服务器的 revision 是**单账户单调**的,同一份内容重推
/// (fan-out 与应答撞在一起)不该被判成过期而丢掉。
#[test]
fn revision相等照样应用() {
    let mut s = sched();
    cap_on(&mut s, vec![entry("D1", true)]);
    let wrote = recv_roster(&mut s, None, 1, vec![entry("D1", true), entry("D2", false)]);
    assert_eq!(wrote.len(), 1);
    assert_eq!(s.snapshot().expect("有名册").len(), 2);
}

/// ⭐ **状态面先写完,才结账**(实现审弹三 M2)。
///
/// 我原先的形是「回执自带名单」,想封掉「UI 拿到 `Ok(())` 之后去读状态面,而状态面还
/// 没被本轮更新」那道跨线程窗口。**那个修法是错的**:它把一道窗口换成了**两个无法排序
/// 的数据出口** —— 回执带 revision 10 的名单,而一枚 revision 11 的主动推送可能先被
/// 状态面的消费者看见,随后那枚 promise 再把 10 的名单倒灌回界面;两个出口都不带
/// revision,UI 无从判断谁新。
///
/// 正解是**把顺序摆对**而不是改类型。这只测就钉那个顺序:回调在结账**之前**被调用,
/// 于是 oneshot 的 happens-before 保证「醒来时读到的状态面必定已含本轮」。
///
/// ⚠ 判据不能只看「回调被调了」与「账结了」两件事各自发生 —— 那对调个个儿照样成立。
/// 这里让回调**自己去看 oneshot 有没有响**:响了就说明结账跑到前面去了。
#[test]
fn 状态面先写完再结账() {
    let mut s = sched();
    cap_on(&mut s, vec![entry("D1", true)]);
    let t0 = Instant::now();
    let (tx, mut rx) = reply();
    let n = s.on_ui_request(t0, tx).expect("发新的");
    let mut order = Vec::new();
    s.on_roster(Some(n), 9, vec![entry("D1", true), entry("D2", false)], |snap| {
        // 回调跑的这一刻,回执**必须还没发出去**。
        order.push(("写状态面", rx.try_recv().is_ok()));
        assert_eq!(snap.expect("写进去的是本轮那一份").len(), 2);
    });
    assert_eq!(order, vec![("写状态面", false)], "结账跑到了状态面写入前面");
    rx.blocking_recv().expect("回执随后必到").expect("成功");
}
