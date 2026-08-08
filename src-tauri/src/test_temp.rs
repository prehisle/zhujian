//! 测试容器目录:**每个测试进程一个**,`%TEMP%/zj-shell-<pid>/`。
//!
//! 与 `core/src/test_temp.rs` 同形(progress-log 325/326):测试容器全收进 per-pid 目录,
//! `%TEMP%` 顶层就只留一个条目 —— **顶层条目数**(不是字节数)才是拖垮文件系统枚举、
//! 把 git-bash 整个卡死的那个量。扫尾归 `core` 的 `test_temp_cleanup`(它按前缀扫全项目)。
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 本进程的测试容器目录(首次调用时建出来)。直接调 `std::env::temp_dir()` 会被 core 那只
/// 结构锚当场咬住。
pub(crate) fn dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let d = std::env::temp_dir().join(format!("zj-shell-{}", std::process::id()));
        std::fs::create_dir_all(&d)
            .unwrap_or_else(|e| panic!("建不出测试容器目录 {}:{e}", d.display()));
        d
    })
}
