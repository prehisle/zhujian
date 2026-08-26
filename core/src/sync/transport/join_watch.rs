//! 「加入空间」这条**前台仪式**上,引导那半的收场判据(space-entry-plan §3.2)。
//!
//! # 为什么存在
//!
//! 490 真机逮到:旧端加入一个已升级的账户,`import_attached` 那句人话
//! (「快照版本不同(对端库 vN,本机 vM):请两端升级到同一版本后重新引导」)**是有的**,
//! 但**加入空间那条路没有出口** —— 两只壳的 join 都只等 `BootCommitted` 闩,而
//! `finish_boot` 的 `Err` 臂按设计是「报错 + 轮转 + 30 秒后再来」、`run` 不退出
//! ⇒ 闩永不落,现场是一个**永远转下去的进度条**,用户看不到任何理由。
//!
//! # ⛔ 与 `finish_boot` 的重试策略刻意不同,别顺手统一
//!
//! **已引导**空间靠那条无限轮转自愈 —— 它跑在后台、没人看着,永远重试正是对的。
//! 而**加入**是用户站着看的前台仪式,必须有个数得清的头。两处答案不同不是漏改,
//! 是两个不同的问题(用户面 34 立账时点名的那一问,2026-08-26 用户拍板取「显理由 +
//! 继续轮转 + 有总时限」)。
//!
//! # 两条轴,互不重叠(⭐ 这是查出来的不是设计的)
//!
//! | 轴 | 管哪种失败 | 为什么只能它管 |
//! |---|---|---|
//! | **失败计数** | 对端答话了但引导没成(版本偏斜 / 快照坏 / 流断) | core 每次都发一枚 [`SyncEvent::BootFailed`] |
//! | **静默时限** | 根本没人应答 | `session_loop` 那条 boot deadline 臂是**静默轮转**,一枚事件都不发 |
//!
//! # ⭐ 为什么不是「从零开始算的墙钟死线」
//!
//! 大快照在慢网上本来就要几分钟,墙钟会把**正常的慢引导**砍掉。同一件事
//! `coord.rs::observe_catchup` 的头注里已经被判过一次(codex 工序 7/8 M3:
//! 「慢引导不许误报『无引导源』」)。⇒ 静默那条轴**只在毫无引导活动时才走**,
//! 见到任何证据就归零。

use super::{SyncEvent, BOOT_STEP_SECS};
use std::time::Duration;

/// 连着这么多次「换一台再来」都没成 ⇒ 收场。
///
/// 判据不是拍的:`boot_rotate` 每次把候选队列转一格,而真实账户里的设备是个位数
/// (⚠ 只有一台同伴时 `peers.len() > 1` 不成立、它**根本不转**,于是这个数就是
/// 「同一台连试三次」)。3 次 × [`BOOT_STEP_SECS`] ⇒ 最坏 90 秒给出理由。
pub const MAX_BOOT_FAILURES: u32 = 3;

/// 毫无引导活动证据多久算「没人能给我快照」。
///
/// = 3 × [`BOOT_STEP_SECS`],与 [`MAX_BOOT_FAILURES`] 同一个量纲:那边是「答话了但
/// 三次都没成」,这边是「三个轮转窗口里一声不吭」。
pub const SILENCE_SECS: u64 = 3 * BOOT_STEP_SECS;

/// 看完一枚事件之后,这场加入还要不要等下去。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinBootVerdict {
    /// 接着等(⚠ 含「这枚事件与引导无关」)。
    Keep,
    /// 见到引导活动 ⇒ 接着等,**并且把静默时限归零**。
    KeepAndRefresh,
    /// 收场,这是给用户看的那句话。
    GiveUp(String),
}

/// 见 [模块头注](self)。⛔ **两只壳必须共用这一份** —— 桌面 `src-tauri` 与手机
/// `mobile` 的 join 编排逐格同形,各写一份收场判据 = 保证漂移
/// (first-draft-checklist 第 14 条:同一条规则的第二份描述就是漂移源)。
#[derive(Debug, Default)]
pub struct JoinBootWatch {
    failures: u32,
    last_reason: Option<String>,
}

impl JoinBootWatch {
    pub fn new() -> JoinBootWatch {
        JoinBootWatch::default()
    }

    /// 静默时限:传给调用方那只定时器用。见到 [`JoinBootVerdict::KeepAndRefresh`]
    /// 就该把它重新计时。
    pub fn silence_window() -> Duration {
        Duration::from_secs(SILENCE_SECS)
    }

    /// 喂一枚 transport 事件。
    pub fn on_event(&mut self, ev: &SyncEvent) -> JoinBootVerdict {
        match ev {
            SyncEvent::BootFailed { reason, retry_soon } => {
                self.last_reason = Some(reason.clone());
                if !*retry_soon {
                    // 「换一台」帮不上忙的那一档(今天唯一:磁盘不足,固定等 5 分钟且
                    // 要用户先清出空间)⇒ 不进计数,当场把话给出去。
                    return JoinBootVerdict::GiveUp(reason.clone());
                }
                self.failures += 1;
                if self.failures >= MAX_BOOT_FAILURES {
                    JoinBootVerdict::GiveUp(reason.clone())
                } else {
                    // 还要再试:这也是**引导活动的证据**(对端确实在答话),静默时限归零。
                    JoinBootVerdict::KeepAndRefresh
                }
            }
            // 快照字节在动 = 引导路是通的。⭐ 慢引导正是靠这一格活下来的。
            SyncEvent::BootProgress { .. } => JoinBootVerdict::KeepAndRefresh,
            // 同伴在线同样算证据(照 `observe_catchup` 那格:`peers_online > 0`)——
            // 对端可能正忙着给别人供流,再等一个窗口是对的。
            SyncEvent::Status(s) if s.peers_online > 0 => JoinBootVerdict::KeepAndRefresh,
            _ => JoinBootVerdict::Keep,
        }
    }

    /// 静默时限到了该说什么。
    ///
    /// ⚠ **两句话不能合并**:见过失败(有 `last_reason`)说的是「试过、没成、为什么」;
    /// 一句没见过说的是「压根没人应答」—— 后者要指路到「让另一台开着」,前者不该。
    pub fn on_silence(&self) -> String {
        match &self.last_reason {
            Some(r) => format!("初始同步没能完成:{r}"),
            None => "没有在线设备可提供初始快照:请让另一台已经装好朱简的设备开着并联网,再重试加入".into(),
        }
    }
}

#[cfg(test)]
mod tests;
