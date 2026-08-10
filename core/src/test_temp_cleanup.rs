//! 测试临时目录扫尾。
//!
//! 本项目的每个测试模块(transport/engine/boot/comments/supervisor/thumbs/……)各自在
//! `std::env::temp_dir()` 下建测试库容器 —— **有的是目录**(`ys-nb-boot-<pid>-<n>/`)、
//! **有的是散在 %TEMP% 顶层的单个 `.sqlite3` 文件**(`ys-nb-engine-<pid>-<n>.sqlite3`,
//! 每个 148 KB,因为 `db::open` 会把全部迁移跑完),但没有一处在测试跑完后删它。
//! 逐个补「测完即删」要动 16 个文件、上百处调用点,且部分容器会在断言失败时提前
//! `panic` 离开作用域,RAII 也未必兜得住每条路径。
//!
//! 改用「进程启动时清一次上一轮的」:`#[ctor]` 保证不管 `cargo test` 这次挑了哪个
//! 子集跑,这个函数总会在任何测试执行前跑一次(不依赖某个具体测试把它带出来)。
//! 只删「足够旧」的条目(而不是所有非本进程 pid 的条目),避免误删正在并发跑的
//! 另一个 `cargo test`/`cargo test <filter>` 进程自己的活容器。
//!
//! **2026-08-08 修两处漏扫**(修前 %TEMP% 量出 18 万条目 / 26 GB,是首版修完之后
//! 三天里重新堆起来的):
//! 1. 首版有一句 `if !meta.is_dir() { continue }` —— 而 92% 的垃圾是顶层散文件,
//!    一个没删。**同族教训:清理器的匹配面要照着「实际产出的形状」列,别照着
//!    「当初写它时脑子里那一种形状」列。**
//! 2. 首版只认 `ys-nb-` 一个前缀,而 `zj-sup-*`/`zj-thumb-*`/`zj-coord-*`(core 与
//!    两壳)、`zhujian-syncd-*`(server)整族都在前缀外。故本清理器按**全项目**的
//!    前缀表扫,不只扫 core 自己产的 —— core 的测试跑得最勤,让它当整个项目在
//!    %TEMP% 上的清洁工,比给每个 crate 各配一份 ctor 便宜。
//!
//! 要复验它是否还咬得动:`powershell -NoProfile -ExecutionPolicy Bypass -File
//! scripts/seed-temp-sweep-fixtures.ps1` 造夹具,跑一次 `cargo test`,再看 `%TEMP%`
//! 下 `*sweeptest*` 只剩两道阴性对照。**夹具必须显式写 `CreationTime`** —— 下面判的
//! 是 `created()`,而 Windows 上 `touch` 只动 mtime,拿 `touch -t` 造的「三小时前」
//! 在这里是假的,会让一次没生效的清理看着像生效了。
//!
//! **前缀表由结构锚守着**(见文件末尾 `every_temp_dir_call_site_uses_a_swept_prefix`):
//! 这张表要和横跨四个 crate 的五十多处调用点保持一致,而在锚写出来之前,守着这件事的
//! 只有上面那段注释 —— 那正是它漏掉两族的原因。锚一写出来当场又咬出两族
//! (`zhujian-ws503-` / `zhujian-0035-`),连修漏扫的那一轮都还没补全。

/// 全项目在 `%TEMP%` 下用过的前缀。**新增测试容器沿用其中之一即自动被覆盖**;
/// 非要起新前缀就加进这张表 —— 忘了加会被文件末尾那只结构锚当场咬住,不会再静默漏扫。
/// 326 起每个 crate 的测试容器都收进各自的 per-pid 目录,所以这张表已收敛成
/// **一个 crate 一条**(而不是「一族测试一条」)。
const PREFIXES: &[&str] = &[
    "ys-nb-",         // core 的 per-pid 目录(`core/src/test_temp.rs`)
    "zj-",            // 两壳的 per-pid 目录(`zj-shell-<pid>` / `zj-android-<pid>`)
    "zhujian-syncd-", // server 的 per-pid 目录(`server/src/test_temp.rs`)
    "zhujian-0035-",  // core/examples/migrate-check-0035(example 二进制,见 TEMP_DIR_OWNERS)
];

#[cfg(test)]
#[ctor::ctor]
fn sweep_stale_test_temp_entries() {
    use std::time::{Duration, SystemTime};

    // 留够余量给并发跑的另一个测试进程(mutation-check.mjs 之类会连续起很多轮,
    // 但单轮不至于卡这么久);目的是把累积上限从「无限」压到「一小时」,不是
    // 追求测完立刻删干净。
    const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !PREFIXES.iter().any(|p| name.starts_with(p)) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(created) = meta.created().or_else(|_| meta.modified()) else {
            continue;
        };
        let Ok(age) = now.duration_since(created) else {
            continue;
        };
        if age <= STALE_AFTER {
            continue;
        }
        // 目录与文件两种形状都要收(`.sqlite3` 的 `-wal`/`-shm` 兄弟同前缀,自动跟着走)。
        if meta.is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        } else {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    const NEEDLE: &str = "temp_dir()";

    /// 扫描面:四个 crate 的全部 `.rs`。**目录不存在即红** —— 「路径写错所以什么都没扫到」
    /// 是这类锚最经典的静默变绿方式(312 判例)。
    const ROOTS: &[&str] = &[
        "core/src",
        "core/examples",
        "core/tests",
        "server/src",
        "server/tests",
        "server/examples",
        "src-tauri/src",
        "android/src-tauri/src",
        "sync-proto/src",
    ];

    /// 豁免:清理器自己那一处 `read_dir(std::env::temp_dir())` —— 它是**扫**,不是建容器。
    /// 豁免的是整个文件而非某一行,所以配一条「文件必须存在」的断言:改名了就一起改。
    const EXEMPT: &[&str] = &["core/src/test_temp_cleanup.rs"];

    /// 全仓**唯一**许可直接碰 `std::env::temp_dir()` 的几份:四个 crate 各自 per-pid 容器目录
    /// 的唯一构造点 + 扫尾器自己 + 一个够不着 `cfg(test)` 的 example 二进制。别处一律走本
    /// crate 的 `test_temp::dir()` —— 否则容器又会平铺回 `%TEMP%` 顶层,而**顶层条目数**
    /// (不是字节数)才是拖垮文件系统枚举、把 git-bash 整个卡死的那个量。
    const TEMP_DIR_OWNERS: &[&str] = &[
        "core/src/test_temp.rs",
        "core/src/test_temp_cleanup.rs",
        "server/src/test_temp.rs",
        "src-tauri/src/test_temp.rs",
        "android/src-tauri/src/test_temp.rs",
        // example 是独立二进制,看不见任何 crate 的 `#[cfg(test)]` helper;它只建一个
        // 固定名目录、跑一次就完,量级可忽略,故如实记成例外而不是硬塞进 helper。
        "core/examples/migrate-check-0035.rs",
    ];

    /// 结构锚:全仓每一处 `std::env::temp_dir()` 建的容器,名字前缀都必须在
    /// [`super::PREFIXES`] 里 —— 否则那一族垃圾在 `%TEMP%` 下没有任何人收。
    ///
    /// 为什么非要一只测:这条耦合横跨四个 crate、五十多处调用点,而 2026-08-08 之前守着它
    /// 的只有一条注释。漏一族**不报错、不变红、只是少干活**,于是垃圾堆到 18 万条目 / 30 GB
    /// 才被人从磁盘占用上发现。形照仓里既有的两只:309 `ops_lock_sites_are_allowlisted`、
    /// 312 `every_transport_submodule_is_scanned`。
    ///
    /// 它同时守第二条规则(325 起,326 扩到全仓):**除 [`TEMP_DIR_OWNERS`] 那几份外,
    /// 谁都不许直接调 `temp_dir()`**,一律走本 crate 的 `test_temp::dir()` 那个 per-pid 目录
    /// —— 否则容器又会平铺回 `%TEMP%` 顶层。
    ///
    /// 四道防「静默变绿」:
    /// 1. 扫描面里的目录不存在即红;
    /// 2. 看不懂的调用形状(`temp_dir()` 之后不是 `.join("字面量…")`)一律**红**,不许跳过
    ///    —— 「解析不了就当没有」正是首版那句 `if !meta.is_dir() { continue }` 的同族;
    /// 3. **反向**再断一次「每条前缀都至少有一处调用点在用」。网要是没架上,`used` 是空的,
    ///    第一条前缀就红 —— 这比断一个「至少 N 处」的数字强,那种数字会随代码增删静默腐烂;
    /// 4. 名单(豁免 + core 的两个 owner)里的文件必须真存在 —— 改名了就一起改。
    #[test]
    fn every_temp_dir_call_site_uses_a_swept_prefix() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core/ 的上一级就是仓根")
            .to_path_buf();

        let mut files: Vec<PathBuf> = Vec::new();
        for r in ROOTS {
            let dir = root.join(r);
            assert!(
                dir.is_dir(),
                "扫描面里的目录不存在:{} —— 路径写错 = 什么都没扫到",
                dir.display()
            );
            crate::test_src::rs_files(&dir, &mut files);
        }
        for e in EXEMPT.iter().chain(TEMP_DIR_OWNERS) {
            assert!(
                root.join(e).is_file(),
                "名单里的文件不存在:{e} —— 它改名了,名单也要跟着改"
            );
        }

        let mut used: std::collections::BTreeSet<&str> = Default::default();
        for f in &files {
            let rel = f
                .strip_prefix(&root)
                .expect("扫到的文件必在仓内")
                .to_string_lossy()
                .replace('\\', "/");
            if EXEMPT.contains(&rel.as_str()) {
                continue;
            }
            let src = std::fs::read_to_string(f).unwrap_or_else(|e| panic!("读不动 {rel}:{e}"));
            let mut from = 0usize;
            while let Some(hit) = src[from..].find(NEEDLE) {
                let at = from + hit + NEEDLE.len();
                from = at;
                let line = src[..at].lines().count();

                // 整行注释里提到 temp_dir() 不算调用点(块注释不特判:仓里没有,真出现会响亮红)。
                let line_start = src[..at].rfind('\n').map_or(0, |p| p + 1);
                if src[line_start..].trim_start().starts_with("//") {
                    continue;
                }

                // 闸二:全仓只有 TEMP_DIR_OWNERS 那几份可以直接碰 temp_dir()。
                assert!(
                    TEMP_DIR_OWNERS.contains(&rel.as_str()),
                    "{rel}:{line}:不许直接调 std::env::temp_dir() —— 走本 crate 的 \
                     `test_temp::dir()`(per-pid 目录)。直接调 = 容器又平铺回 %TEMP% 顶层,\
                     而顶层条目数(不是字节数)才是拖垮文件系统枚举的那个量。"
                );

                let args = src[at..].trim_start().strip_prefix(".join(").unwrap_or_else(|| {
                    panic!(
                        "{rel}:{line}:temp_dir() 之后不是 `.join(`,这处容器叫什么名字锚看不出来。\
                         看不懂的形状一律当「没人收」办 —— 要么写成 `.join(\"<前缀>…\")`,\
                         要么连同理由加进 EXEMPT。"
                    )
                });
                // 只在这一条语句内找字面量,免得越过 `;` 抓到下一句里的引号。
                let stmt = &args[..args.find(';').unwrap_or(args.len())];
                let lit = stmt
                    .find('"')
                    .and_then(|a| stmt[a + 1..].find('"').map(|b| &stmt[a + 1..a + 1 + b]))
                    .unwrap_or_else(|| {
                        panic!(
                            "{rel}:{line}:`.join(…)` 里没有字符串字面量,容器名不是常量前缀 —— \
                             那它就不可能被 PREFIXES 收住。"
                        )
                    });
                let head = lit.split('{').next().unwrap_or("");
                let hit_prefix = super::PREFIXES
                    .iter()
                    .find(|p| head.starts_with(**p))
                    .unwrap_or_else(|| {
                        panic!(
                            "{rel}:{line}:临时容器叫 {lit:?},前缀不在 PREFIXES 里 —— \
                             这一族垃圾在 %TEMP% 下没人收(2026-08-08 就是这么堆出 18 万条目 / 30 GB 的)。\
                             要么改名沿用既有前缀,要么把新前缀加进 PREFIXES(见本文件顶部)。"
                        )
                    });
                used.insert(*hit_prefix);
            }
        }

        for p in super::PREFIXES {
            assert!(
                used.contains(p),
                "PREFIXES 里的 {p:?} 今天没有任何调用点在用:要么是打错了字(那它什么都守不住),\
                 要么是那一族测试没了(删掉它)。这一条同时是「网到底架没架上」的探针。"
            );
        }
    }
}
