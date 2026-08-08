//! 测试容器目录:**每个测试进程一个**,`%TEMP%/zhujian-syncd-<pid>/`。
//!
//! 与 `core/src/test_temp.rs` 同形(progress-log 325/326):测试容器全收进 per-pid 目录,
//! `%TEMP%` 顶层就只留一个条目 —— **顶层条目数**(不是字节数)才是拖垮文件系统枚举、
//! 把 git-bash 整个卡死的那个量。
//!
//! ⚠ **刻意不带 `#[cfg(test)]`**:`tests/integration.rs` 是独立的集成测试二进制,把本 crate
//! 当**普通依赖**链接,看不见 `cfg(test)` 里的东西。要让 `src/` 的单测与集成测共用同一个
//! 目录构造点(而不是各抄一份、各漂各的),它必须是普通的 `pub`。除测试外无人调用。
//!
//! 扫尾归 `core` 的 `test_temp_cleanup`:它按前缀扫**全项目**,而 core 的测试跑得最勤 ——
//! 让它当整个项目在 `%TEMP%` 上的清洁工,比给每个 crate 各配一份 ctor 便宜。
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 本进程的测试容器目录(首次调用时建出来)。**server 的测试一切临时目录都从这里 `join`**
/// —— 直接调 `std::env::temp_dir()` 会被 core 那只结构锚当场咬住。
#[doc(hidden)]
pub fn dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let d = std::env::temp_dir().join(format!("zhujian-syncd-{}", std::process::id()));
        std::fs::create_dir_all(&d)
            .unwrap_or_else(|e| panic!("建不出测试容器目录 {}:{e}", d.display()));
        d
    })
}
