//! [`JoinBootWatch`](super::JoinBootWatch) 的判据测试。
//!
//! ⭐ **每一格都只由被测那一句决定**(first-draft-checklist 第 13 条):这只表是纯
//! 状态机、没有第二把尺,故样本可以直接喂进 `on_event`,⛔ 不必也不该经端到端路径
//! (那样拒它的会变成别的闸,而 `Keep`/`GiveUp` 这个观测面分不出是谁拒的)。

use super::*;
use crate::sync::transport::SyncStatus;

fn failed(reason: &str) -> SyncEvent {
    SyncEvent::BootFailed { reason: reason.into(), retry_soon: true }
}

fn peers(n: usize) -> SyncEvent {
    SyncEvent::Status(SyncStatus { peers_online: n, ..SyncStatus::default() })
}

/// 失败计数那条轴:前 `MAX-1` 枚接着等,第 `MAX` 枚收场。
///
/// ⭐ **理由取的是最后那枚不是第一枚** —— 轮转会换设备,后一台给的话可能不一样,
/// 而用户该看到的是「最后一次到底为什么」。刀:改成 `Some(first)` 就红在这。
#[test]
fn three_retryable_failures_give_up_with_the_last_reason() {
    let mut w = JoinBootWatch::new();
    assert_eq!(MAX_BOOT_FAILURES, 3, "下面三句是按这个数写死的,改了常量要一起改");

    assert_eq!(w.on_event(&failed("第一台:快照版本不同")), JoinBootVerdict::KeepAndRefresh);
    assert_eq!(w.on_event(&failed("第二台:引导流中断")), JoinBootVerdict::KeepAndRefresh);
    assert_eq!(
        w.on_event(&failed("第三台:快照版本不同(对端库 v37,本机 v35)")),
        JoinBootVerdict::GiveUp("第三台:快照版本不同(对端库 v37,本机 v35)".into()),
        "收场那句必须是**最后**一次的理由"
    );
}

/// `retry_soon: false` 那一档**不进计数**,第一枚就收场。
///
/// 判据不是「它也是个失败」,是**等下去没有意义**:今天唯一那格是磁盘不足,固定等
/// `BOOT_SPACE_RETRY_SECS` = 5 分钟且要用户先清出空间 ⇒ 记进计数 = 让用户对着进度条
/// 干等 15 分钟才拿到一句「请清理存储」。
#[test]
fn a_failure_that_wont_be_retried_soon_gives_up_at_once() {
    let mut w = JoinBootWatch::new();
    let ev = SyncEvent::BootFailed {
        reason: "初始同步空间不足:请清理存储".into(),
        retry_soon: false,
    };
    assert_eq!(w.on_event(&ev), JoinBootVerdict::GiveUp("初始同步空间不足:请清理存储".into()));
}

/// 静默那条轴的正面:字节在动就一直归零 —— **慢引导正是靠这一格活下来的**。
///
/// ⭐ 这只测同时钉住「墙钟死线是错的判据」那条结论:喂多少枚 `BootProgress` 都不该
/// 有任何一枚变成 `GiveUp`。
#[test]
fn boot_progress_never_gives_up_no_matter_how_long_it_takes() {
    let mut w = JoinBootWatch::new();
    for i in 1..=500 {
        let ev = SyncEvent::BootProgress { received: i * 1024, total: 512 * 1024 };
        assert_eq!(
            w.on_event(&ev),
            JoinBootVerdict::KeepAndRefresh,
            "第 {i} 枚进度事件:大快照慢归慢,不许被判失败"
        );
    }
}

/// 同伴在线算证据,**没有同伴不算** —— 两个方向都断,否则这一格会被 `_ => Keep`
/// 那条兜底背书成绿(first-draft-checklist 第 11 条:每个样本要各自独立可判)。
#[test]
fn peers_online_is_evidence_but_zero_peers_is_not() {
    let mut w = JoinBootWatch::new();
    assert_eq!(w.on_event(&peers(1)), JoinBootVerdict::KeepAndRefresh);
    assert_eq!(w.on_event(&peers(9)), JoinBootVerdict::KeepAndRefresh);
    assert_eq!(
        w.on_event(&peers(0)),
        JoinBootVerdict::Keep,
        "一台同伴都没有 ⇒ 不是证据,静默时限该照常走"
    );
}

/// 与引导无关的事件**既不收场也不刷新**,而且**不许推动失败计数**。
///
/// ⚠ 后半句才是这只测的重点:Toast 在这条路上很密(「图N」翻案、冻结…),
/// 若它们能推计数,一次正常的加入会被自己的噪音判死。
#[test]
fn unrelated_events_neither_refresh_nor_count() {
    let mut w = JoinBootWatch::new();
    for _ in 0..50 {
        assert_eq!(w.on_event(&SyncEvent::Toast("图1 已就位".into())), JoinBootVerdict::Keep);
        assert_eq!(w.on_event(&SyncEvent::Changed), JoinBootVerdict::Keep);
        assert_eq!(w.on_event(&SyncEvent::SpaceNameChanged), JoinBootVerdict::Keep);
    }
    // 噪音没进计数 ⇒ 这里仍要走满整整三枚真失败才收场。
    assert_eq!(w.on_event(&failed("一")), JoinBootVerdict::KeepAndRefresh);
    assert_eq!(w.on_event(&failed("二")), JoinBootVerdict::KeepAndRefresh);
    assert_eq!(w.on_event(&failed("三")), JoinBootVerdict::GiveUp("三".into()));
}

/// 静默收场那两句话**必须分得开**:见过失败说「试过、没成、为什么」,
/// 一句没见过说「压根没人应答」并指路。合成一句 = 把「对端在但不合用」讲成
/// 「没有设备在线」,指的修法方向就错了。
#[test]
fn silence_message_depends_on_whether_anything_ever_failed() {
    let fresh = JoinBootWatch::new();
    let quiet = fresh.on_silence();
    assert!(quiet.contains("没有在线设备"), "没见过失败:{quiet}");
    assert!(quiet.contains("再重试加入"), "要指路,不能只报症状:{quiet}");

    let mut tried = JoinBootWatch::new();
    let _ = tried.on_event(&failed("快照版本不同(对端库 v37,本机 v35)"));
    let after = tried.on_silence();
    assert!(
        after.contains("快照版本不同(对端库 v37,本机 v35)"),
        "见过失败:那句人话必须原样带出来,{after}"
    );
    assert!(
        !after.contains("没有在线设备"),
        "见过失败就不该再说「没有在线设备」——对端明明答了话:{after}"
    );
}

/// 静默窗口与失败计数同量纲(3 个轮转窗口),⛔ 别把它改成一个拍脑袋的数。
#[test]
fn silence_window_is_three_boot_steps() {
    assert_eq!(SILENCE_SECS, 3 * BOOT_STEP_SECS);
    assert_eq!(
        JoinBootWatch::silence_window(),
        std::time::Duration::from_secs(90),
        "BOOT_STEP_SECS=30 ⇒ 90 秒;这一句是给改常量的人看的"
    );
}
