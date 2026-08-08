//! 测试容器目录:**每个测试进程一个**,`%TEMP%/ys-nb-<pid>/`。
//!
//! 为什么不再往 `%TEMP%` 顶层平铺:真正拖垮文件系统枚举(以及整个 git-bash)的是**顶层
//! 条目数**,不是字节数 —— 2026-08-08 量出的 18 万条目里,core 一轮 `cargo test` 就摊
//! **932 个**。全落进本目录之后,一轮只在顶层留**一个**条目,与用例数无关;扫尾器那边
//! 也从「删 932 次」变成一次 `remove_dir_all`(实测清盘从 3.5 分钟降到秒级)。
//!
//! **本轮只换基座、不改名**:各测试模块原有的容器名(含 pid,现在冗余但无害)一个字不动
//! —— 几十处同时改名容易引入命名撞车,而顶层条目数这件事跟名字无关。
//!
//! 目录本身由 [`super::test_temp_cleanup`] 的扫尾器按 `ys-nb-` 前缀收走。⚠ 它判的是
//! `created()`,而本目录的创建时刻 = **进程启动时刻**(不再是各容器各自的创建时刻),所以
//! 「跑了超过一小时的测试进程,其活目录可能被另一个新起的进程判为陈旧」这条窗口从
//! 「最后一个容器建好之后一小时」收紧成了「进程启动后一小时」。core 全套跑 92s,余量 39 倍。
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 本进程的测试容器目录(首次调用时建出来)。**core 里一切临时库/目录都从这里 `join`**
/// —— 直接调 `std::env::temp_dir()` 会被 `test_temp_cleanup` 里那只结构锚当场咬住。
pub(crate) fn dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let d = std::env::temp_dir().join(format!("ys-nb-{}", std::process::id()));
        std::fs::create_dir_all(&d)
            .unwrap_or_else(|e| panic!("建不出测试容器目录 {}:{e}", d.display()));
        d
    })
}
