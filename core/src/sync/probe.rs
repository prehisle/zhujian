//! **台架专用埋点**(305 真机复验;feature `probe305`,默认关)。
//!
//! 为什么要它:305 清单第 2/5 条要的是**引擎内部三个时刻**——`prepare(op1)` /
//! `commit(op2)` / `Ack-commit(op1)`——以及补洞段的 `RangeAt → RangeAt →
//! RangeDrained → work empty` 收尾链。这三格 `sync_status` 一个都透不出来
//! (294/295 那两轮的观测面本来就在外部:netstat / 服务端日志 / 两端库),
//! 故只能在链路上就地记。
//!
//! 为什么是 cargo feature 而不是常驻代码:照 `android/src-tauri` 的 `devtools`
//! 与 `server/examples/busy-syncd.rs` 同一套纪律——**验收通道不进生产二进制**。
//! feature 关着时下面这个宏展开成 `()`,`log` 依赖都不拉进来,一个字节不编。
//!
//! 时刻口径:`log` 那一行自带**墙钟**(供与服务端日志对时),宏另在正文头上打一个
//! **单调**微秒数(进程内 `Instant` 起点),供同一台机上三个时刻的**排序** ——
//! 墙钟会跳,而第 2 条问的恰恰是「谁先谁后」。

/// 两个时刻各有各的活,**都要**:
/// * `t` = 进程内单调微秒 —— 第 2 条问的「谁先谁后」只能拿它答(墙钟会跳);
/// * `w` = UTC 纪元毫秒 —— 与服务端日志(RFC3339 UTC)对时用。桌面壳的日志前缀
///   只到**秒**,安卓那边压根没有前缀(logcat 自己带),故墙钟得自己打进正文。
#[cfg(feature = "probe305")]
pub(crate) fn stamps() -> (u128, u128) {
    use std::sync::OnceLock;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};
    static T0: OnceLock<Instant> = OnceLock::new();
    let mono = T0.get_or_init(Instant::now).elapsed().as_micros();
    let wall = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    (mono, wall)
}

/// 打一条埋点。feature 关 = 展开成 `()`,参数一律不求值。
#[cfg(feature = "probe305")]
macro_rules! p305 {
    ($($arg:tt)*) => {{
        let (mono, wall) = $crate::sync::probe::stamps();
        log::info!(target: "P305", "P305 t={mono} w={wall} {}", format_args!($($arg)*))
    }};
}

#[cfg(not(feature = "probe305"))]
macro_rules! p305 {
    ($($arg:tt)*) => {
        ()
    };
}

pub(crate) use p305;
