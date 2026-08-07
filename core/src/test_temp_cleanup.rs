//! 测试临时目录扫尾。
//!
//! `core` 的每个测试模块(transport/engine/boot/comments/……)各自在
//! `std::env::temp_dir()` 下建一份 `ys-nb-<tag>-<pid>-<n>` 目录当测试库/文件容器,
//! 但没有一处在测试跑完后删它(用户在 %TEMP% 下量出 5 万+ 个残留,拖到连
//! git-bash 起进程都卡死)。逐个补「测完即删」要动 16 个文件、上百处调用点,
//! 且部分目录会在断言失败时提前 `panic` 离开作用域,RAII 也未必兜得住每条路径。
//!
//! 改用「进程启动时清一次上一轮的」:`#[ctor]` 保证不管 `cargo test` 这次挑了哪个
//! 子集跑,这个函数总会在任何测试执行前跑一次(不依赖某个具体测试把它带出来)。
//! 只删「足够旧」的目录(而不是所有非本进程 pid 的目录),避免误删正在并发跑的
//! 另一个 `cargo test`/`cargo test <filter>` 进程自己的活目录。
#[cfg(test)]
#[ctor::ctor]
fn sweep_stale_test_temp_dirs() {
    use std::time::{Duration, SystemTime};

    // 留够余量给并发跑的另一个 core 测试进程(mutation-check.mjs 之类会连续起
    // 很多轮,但单轮不至于卡这么久);目的是把累积上限从「无限」压到「一小时」,
    // 不是追求测完立刻删干净。
    const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("ys-nb-") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let Ok(created) = meta.created().or_else(|_| meta.modified()) else {
            continue;
        };
        let Ok(age) = now.duration_since(created) else {
            continue;
        };
        if age > STALE_AFTER {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
