//! Rust 侧 `log::` → 鸿蒙 hilog 的直连通道(安卓壳那句「log::info 直达 logcat」在这一端的对位)。
//!
//! **为什么不用 `tauri-plugin-log`**:那份的移动端后端是 logcat / oslog,鸿蒙不在它的面里。
//! 这里就是 `OH_LOG_PrintMsg` 那一个 NDK 符号,~50 行,不值得为它引一个插件。
//!
//! 读法(真机):`hdc shell "hilog -x | grep ZHUJIAN"`。
//!
//! ⛔ **本文件不带 `cfg` 兜底**:`hilog_ndk.z` 只在 OHOS sysroot 里,把这个 crate 编到别的
//! 平台会在**链接期**拿到「找不到符号」——那是对的,这只壳本来就只发鸿蒙。⛔ 别加一支
//! 「非鸿蒙就写 stderr」的降级:它会让「编错了目标」这件事变得安静(同 design-rules 的
//! fail-fast:产品代码不写静默默认值)。

use std::ffi::CString;

#[link(name = "hilog_ndk.z")]
extern "C" {
    /// `hilog/log.h`。返回值是写进去的字节数,负数 = 失败(本通道是诊断面,失败不升级)。
    fn OH_LOG_PrintMsg(
        type_: u32,
        level: u32,
        domain: u32,
        tag: *const std::os::raw::c_char,
        message: *const std::os::raw::c_char,
    ) -> i32;
}

/// `LogType::LOG_APP`。
const LOG_APP: u32 = 0;
/// `LogLevel`:DEBUG=3 / INFO=4 / WARN=5 / ERROR=6 / FATAL=7。
const LEVEL_DEBUG: u32 = 3;
const LEVEL_INFO: u32 = 4;
const LEVEL_WARN: u32 = 5;
const LEVEL_ERROR: u32 = 6;

/// 应用自定义 domain(0x0000..0xFFFF);与 tag 一起构成 `hilog` 的过滤面。
const DOMAIN: u32 = 0x0301;
const TAG: &str = "ZHUJIAN";

/// hilog 单条有长度上限,**按字符边界**切段 —— ⚠ 按字节切会把一个汉字劈成两半,
/// 之后 `CString` 拿到的是坏 UTF-8,真机上表现为整行不见(不是乱码,是没有)。
const CHUNK_CHARS: usize = 240;

struct HiLogger;

impl log::Log for HiLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        let level = match record.level() {
            log::Level::Error => LEVEL_ERROR,
            log::Level::Warn => LEVEL_WARN,
            log::Level::Info => LEVEL_INFO,
            log::Level::Debug | log::Level::Trace => LEVEL_DEBUG,
        };
        print(level, &format!("[{}] {}", record.target(), record.args()));
    }

    fn flush(&self) {}
}

fn print(level: u32, message: &str) {
    let tag = match CString::new(TAG) {
        Ok(t) => t,
        Err(_) => return,
    };
    let chars: Vec<char> = message.chars().collect();
    for chunk in chars.chunks(CHUNK_CHARS) {
        // ⚠ 消息里的 NUL 会让 CString::new 失败(日志内容来自 errno / 文件名,不是可信输入)
        // ⇒ 换成可见记号而不是丢掉整行。
        let s: String = chunk.iter().map(|c| if *c == '\0' { '␀' } else { *c }).collect();
        if let Ok(c) = CString::new(s) {
            unsafe { OH_LOG_PrintMsg(LOG_APP, level, DOMAIN, tag.as_ptr(), c.as_ptr()) };
        }
    }
}

/// 装上全局 logger。**在 `run()` 的第一行调用** —— 它之后的每一条 `log::` 才有去处,
/// 而启动路径上最值得看的几条(租约、catalog、清扫)全在那之后。
///
/// ⚠ 装不上只可能是「装过两次」,不是环境问题 ⇒ 直接 panic,别静默吞:
/// 吞掉的后果是真机上一条日志都没有,而那时你正需要日志。
pub fn init() {
    // ⚠ 用 `set_logger(&静态)` 而不是 `set_boxed_logger` —— 后者关在 log 的 `alloc`
    // 特性后面,而本壳(以及 core)拉进来的 log 没开那一格,写了会报
    // 「cannot find function `set_boxed_logger` in crate `log`」。静态这条本来也更省。
    static LOGGER: HiLogger = HiLogger;
    log::set_logger(&LOGGER).expect("hilog logger 已被安装过");
    log::set_max_level(log::LevelFilter::Debug);
}

/// 不经 `log` 门面的直发口 —— 给「logger 还没装上」与「panic 钩子里」用。
pub fn raw(message: &str) {
    print(LEVEL_INFO, message);
}
