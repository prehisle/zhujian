//! Database open + migration runner.
//!
//! Migrations are plain SQL files applied in order, gated on SQLite's
//! `user_version` pragma. No framework: each entry is `(version, sql)` and the
//! file is embedded at compile time. To add a migration, drop a new
//! `migrations/000N_*.sql` and append one line to `MIGRATIONS` — and bump the
//! expected version in repo.rs's `migration_sets_user_version_*` test (it
//! asserts the latest `user_version`, so a new migration turns it red until
//! updated).
//!
//! # 迁移作者规则(0029 起,收回「安卓不跑迁移」时定形;codex 设计审 H2)
//!
//! **0029 起迁移 SQL 文件只写「事务体」**:禁止顶层 `BEGIN`/`COMMIT`/`ROLLBACK` 与
//! `PRAGMA user_version` —— 事务与版本号归 runner 所有(`BEGIN IMMEDIATE → 事务体 →
//! foreign_key_check → user_version → COMMIT`,SQLite authorizer 在执行事务体期间
//! 拒绝事务控制与 user_version,骗不过去)。手机断电/系统 kill 于事务中 = 整笔回滚
//! 重启重跑;COMMIT 后 = schema 与 uv 已原子落盘、重启跳过。触发器体的 `BEGIN…END`
//! 不是事务控制,不受影响。1-28 的老迁移保持原样执行(不回改历史;它们**绝不原地
//! 用于安卓既有正式库**——下限 [`MOBILE_MIGRATION_FLOOR`] 挡着;fresh/staging 建库
//! 从 1 全跑属建库事务,半成品整库弃置,不吃崩溃窗)。
//!
//! **每条新迁移的头注释必须声明跨版本同步政策**(codex 设计审 M7,E2EE 服务器不懂
//! 业务 schema):三选一——「纯本地 schema,新旧客户端混跑安全」/「协议或 oplog 词汇
//! 变化,先发兼容 reader、下一版才开 writer」/「必须版本门控同步」。
//!
//! **除本文件的 [`SCHEMA_VERSION`] 外,还有两处写死了版本号**(300 判例):
//! 1. `core/src/repo.rs` 的 `migration_sets_user_version_NN_and_enforces_foreign_keys`
//!    —— **函数名与断言值都写死**,加迁移时会红,得连名字一起改;
//! 2. `scripts/cdp-acceptance-db-migrate.js` 的 `EXPECT_UV` —— **在仓外、编译器管不着**,
//!    它在 0031 上生产后**整整两版没人动**,一直拿 30 去对 32 的库,直到 300 真跑才红。
//!
//! 下方 `schema_version_matches_migration_chain` 那只是**派生**断言(拿迁移链
//! 末位比),自维护、加迁移不用动它 —— 别把它跟上面两处搞混。加迁移的当轮把上面两处
//! 一起改掉,别指望事后想起来。
//!
//! **已声明的债(codex 实现审 M4)**:新 runner 下事务体里 `PRAGMA foreign_keys=OFF`
//! 是事务内 no-op——将来第一条需要重建被 FK 引用表的真实迁移,必须先把 MIGRATIONS
//! 元组升级出 `foreign_keys: Enforced | DisabledDuringBody` 声明位(runner 在 BEGIN
//! 前关、所有返回路径恢复,事务内仍跑 foreign_key_check),不许让 SQL 自己控 FK。

use std::path::Path;

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::Connection;

/// 当前 schema 版本 = 迁移链末位。spaces 的只读 exact-match 检查(multispace-plan §10)
/// 与 staging 建库都以它为锚;加新迁移时此常量跟着 MIGRATIONS 一起动
/// (migration_sets_user_version 测试与下方一致性测试双守)。
pub const SCHEMA_VERSION: i64 = 35;

/// 安卓前滚迁移下限(codex 设计审 H1):手机端只对 `user_version >= 28` 的既有
/// 正式库做原地前滚(现网手机全部诞生于 v28 干净装)。1-27 的老迁移不自带崩溃窗
/// 防护(uv 由 runner 外层单独写),**绝不对安卓既有正式库原地运行**——低于下限
/// 一律拒且零写(fresh/staging 建库从 1 全跑不在此限:建库事务、半成品整库弃置)。
/// 「现网没有旧库」不能代替代码闸:恢复/拷贝/手改 uv 都可能造出低版本文件。
pub const MOBILE_MIGRATION_FLOOR: i64 = 28;

/// 0029 起 runner 拥有迁移事务与 user_version(见文件头「迁移作者规则」)。
const RUNNER_OWNS_TXN_FROM: i64 = 29;

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/0001_init.sql")),
    (2, include_str!("../migrations/0002_task_guards.sql")),
    (3, include_str!("../migrations/0003_note_history.sql")),
    (4, include_str!("../migrations/0004_note_archive_guard.sql")),
    (5, include_str!("../migrations/0005_task_archive.sql")),
    (6, include_str!("../migrations/0006_task_time.sql")),
    (7, include_str!("../migrations/0007_task_topic.sql")),
    (8, include_str!("../migrations/0008_task_order.sql")),
    (9, include_str!("../migrations/0009_task_archive_any_active.sql")),
    (10, include_str!("../migrations/0010_drop_ai_suggested.sql")),
    (11, include_str!("../migrations/0011_heal_note_history_triggers.sql")),
    (12, include_str!("../migrations/0012_task_note_one_to_one.sql")),
    (13, include_str!("../migrations/0013_task_confirming.sql")),
    (14, include_str!("../migrations/0014_unify_items.sql")),
    (15, include_str!("../migrations/0015_drop_topic_summary.sql")),
    (16, include_str!("../migrations/0016_add_item_image.sql")),
    (17, include_str!("../migrations/0017_add_item_sealed.sql")),
    (18, include_str!("../migrations/0018_add_item_born_stage.sql")),
    (19, include_str!("../migrations/0019_sync_meta.sql")),
    (20, include_str!("../migrations/0020_oplog.sql")),
    (21, include_str!("../migrations/0021_position_fractional.sql")),
    (22, include_str!("../migrations/0022_replay_exemption.sql")),
    (23, include_str!("../migrations/0023_image_seq_replay.sql")),
    (24, include_str!("../migrations/0024_oplog_origin_seq.sql")),
    (25, include_str!("../migrations/0025_boot_import_exemption.sql")),
    (26, include_str!("../migrations/0026_topic_color.sql")),
    (27, include_str!("../migrations/0027_sync_quarantine.sql")),
    (28, include_str!("../migrations/0028_space_profile.sql")),
    (29, include_str!("../migrations/0029_migrator_canary.sql")),
    (30, include_str!("../migrations/0030_add_item_done_at.sql")),
    (31, include_str!("../migrations/0031_topic_position_and_kind.sql")),
    (32, include_str!("../migrations/0032_item_image_thumb.sql")),
    (33, include_str!("../migrations/0033_device_profile_and_born_device.sql")),
    (34, include_str!("../migrations/0034_recover_born_device_from_log.sql")),
    (35, include_str!("../migrations/0035_item_comment.sql")),
];

/// Open the database at `path`, enforce foreign keys, and apply migrations.
///
/// Also switches the file into WAL mode and arms a busy timeout: WAL is a
/// persistent property of the database file, but we set-and-verify on every
/// open (fail-fast — some filesystems refuse WAL and SQLite silently stays on
/// the rollback journal, which `pragma_update` alone would not surface).
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    // 降级闸先于任何写(codex 设计审 M3 尾注):打开「比本程序新」的库要在切 WAL
    // 之前就 fail-fast——否则会先改掉 journal mode 才 panic,白改一笔。
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    assert_downgrade_gate(current);
    let mode: String = conn.pragma_update_and_check(None, "journal_mode", "wal", |row| row.get(0))?;
    assert_eq!(mode, "wal", "SQLite refused WAL mode (journal_mode={mode})");
    conn.pragma_update(None, "foreign_keys", true)?;
    run_migrations(&conn, i64::MAX)?;
    Ok(reclaim_free_pages(conn))
}

// ---- 开库回收空页(image-perf-plan §4)------------------------------------------

/// VACUUM 的绝对值闸:空页少于这么多就不值得为它重排整个库。
///
/// 规格 §4.3 写的是 16 MiB,同一节又说「另一个空间库也满足(11.2 MiB / 41%)」—— 11.2
/// 不大于 16,自相矛盾。真机复验坐实了矛盾(那个库被绝对值闸挡下),用户 2026-08-05 拍板
/// **按意图取 8 MiB**:11 MiB 空页占 40% 的库,花约一秒换回 11 MiB 是划算的。
const RECLAIM_MIN_BYTES: i64 = 8 * 1024 * 1024;
/// VACUUM 的占比闸(百分数):库里空页不到这个比例就不算「虚胖」。
const RECLAIM_MIN_PCT: i64 = 30;

/// §4.3 的双判据,单拎成纯函数**只为它能被单独证伪**:两道闸各自负责的那个方向,
/// 在端到端那只测里分不开(它造的库两条闸同时满足,拆掉任一条它照样绿)。
/// 返回 `(该不该 VACUUM, 空页字节, 空页占比%)`。
fn should_vacuum(page_size: i64, page_count: i64, freelist: i64) -> (bool, i64, i64) {
    let freelist_bytes = freelist.saturating_mul(page_size);
    // 占比**用交叉相乘裁决,不用那个百分数**(299 codex 实现审 L1):`freelist*100/page_count`
    // 是整除,30.1%…30.999% 全被截成 30 而跳过——闸名义上是 >30%,实际是 >=31%。
    // 百分数只留给日志与 `Skipped` 的自述。
    let over_pct = freelist.saturating_mul(100) > page_count.saturating_mul(RECLAIM_MIN_PCT);
    let pct = if page_count > 0 { freelist * 100 / page_count } else { 0 };
    (freelist_bytes > RECLAIM_MIN_BYTES && over_pct, freelist_bytes, pct)
}

/// 一次回收的结果(只为日志与测试;调用方拿到的永远是那条连接本身)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reclaim {
    /// 谓词不满足:没 VACUUM(WAL checkpoint 照做)。
    Skipped { freelist_bytes: i64, pct: i64 },
    /// 真回收了。
    Vacuumed { before: i64, after: i64 },
    /// 纯优化失败(磁盘紧、库忙……):**响亮记日志、不挡开库**(§4.3)。
    Failed(String),
}

/// 开库时回收 freelist 空页 + 收 WAL(image-perf-plan §4)。
///
/// # ⛔ 调用前必须自证:这个**数据库文件**上没有活引擎
///
/// `ops_serve.rs` 钉死过一条禁令:**在制 work 期间禁止对源库做原地 `VACUUM` 或任何 rowid
/// 重写**(`oplog` 没有显式 `INTEGER PRIMARY KEY`,取帧游标拿的是 rowid)。
///
/// **按值收走 `Connection` 再按值还回这个签名,证不到这一步**(299 codex 实现审 M2,与我
/// 自审同结论):它只证明「传进来的不是 runtime 持有的那个 `Connection` 对象」——挡的是
/// 「顺手 `rt.db.lock()` 拿把 `&mut` 就 VACUUM」这类最可能的手滑。**任何人都能对同一个
/// 文件另开一条连接**,那条连接照样能重排活引擎正在数的 rowid。所以这条不变量是
/// **协调器调用图的性质,不是类型的性质**,加新调用点的人必须自己证。
///
/// 当前四个生产调用点各自的证据(`reclaim_call_sites_are_the_audited_two` 钉住这张表不被
/// 悄悄加行;新增调用点会让那只测红,逼你回来读这段):
///
/// | 调用点 | 凭什么说没有活引擎 |
/// |---|---|
/// | [`open`] ← 桌面启动逐库 | supervisor / transport 尚未创建 |
/// | [`open`] ← 桌面建/加入空间、main 重置后重开 | 新文件或刚重建;旧 runtime 已证 drop |
/// | `spaces::open_space` ← 两壳装配 | `sup.reserve(id)` **先于**开库占槽,重复激活当场 Err |
/// | `spaces::open_space` ← 安卓跨空间移动的目标 | 持 `lifecycle + orchestrate` 双锁,目标经 `is_stopped` 证明**完全无槽**(Resetting 墓碑也算在场) |
///
/// (顺带记实:今天 `oplog` 由 `trg_oplog_no_delete` 守成 append-only、rowid 本无空洞,
/// 原地 VACUUM 事实上不会重排它;禁令仍按原则守 —— 靠「碰巧没有空洞」活着的东西,
/// 哪天多一条删除路径就会静默失效。)
///
/// 失败一律吞成日志:这不是「回退到错误状态的兜底」,是纯优化失败 —— 库照样能用。但必须响。
///
/// ⚠ **可用性代价,不是正确性问题**(codex L 附注):桌面启动装配跑在 blocking worker 上,
/// 但 `spaces::open_space` 那两条(切空间 / 跨空间移动)会**占着 tokio worker 并持协调锁**
/// 跑完整轮 VACUUM——大库上用户命令会有可感的一段无响应。中途被系统杀掉由 SQLite 原子
/// 回滚,不伤数据。
#[must_use = "回收后的连接就是原来那条,别丢"]
pub(crate) fn reclaim_free_pages(conn: Connection) -> Connection {
    match reclaim_inner(&conn) {
        Reclaim::Vacuumed { before, after } => eprintln!(
            "INFO 开库回收空页:{} MiB → {} MiB(省下 {} MiB)",
            before >> 20,
            after >> 20,
            (before - after) >> 20
        ),
        // 自审第三问「有没有算出来却没人用的值」:`Skipped` 那两格原先谁也不读。它们
        // 恰好是「我的库为什么还这么胖」唯一能回答的东西 —— 只在**擦边没过**时说一句
        // (小库天天开库都在 Skipped,无条件打就成噪音了)。
        Reclaim::Skipped { freelist_bytes, pct } if freelist_bytes > RECLAIM_MIN_BYTES => {
            eprintln!(
                "INFO 库里有 {} MiB 空页(占 {pct}%),未达回收占比闸({RECLAIM_MIN_PCT}%),这次不回收",
                freelist_bytes >> 20
            )
        }
        Reclaim::Skipped { .. } => {}
        Reclaim::Failed(e) => eprintln!("WARN 开库回收空页失败(不影响使用):{e}"),
    }
    conn
}

/// [`reclaim_free_pages`] 的可测内核。**模块私有**——不给第二个调用点。
///
/// 判据(§4.3 双闸):空页字节 > [`RECLAIM_MIN_BYTES`] **且** 占比 > [`RECLAIM_MIN_PCT`]%
/// 才 VACUUM;既不为小库白等,也不让大库一直虚胖。无论 VACUUM 与否,收尾一律
/// `wal_checkpoint(TRUNCATE)` —— VACUUM 自己在 WAL 模式下会把整库写进 WAL,不收就是白忙。
///
/// **刻意不设 auto_vacuum**:它对已存在的库改不了(得先设 pragma 再 VACUUM 一次,等于还是
/// 要 VACUUM),而且给每页加 pointer map 的写放大是常驻成本。
///
/// ⚠ 已知且接受的一处「工作量由数据规模说了算」(首版自检 #3):VACUUM 的耗时必然正比于库
/// 大小,这里给不出有意义的常量闸 —— 给了就等于大库永远不回收,正是本件要修的那件事。触发
/// 条件本身很窄(库 ≥ 约 27 MiB 且 >30% 是空页 —— 8 MiB / 30% 反推),做完这一次就没了;
/// 故 Vacuumed 分支响亮记日志,让「今天启动怎么慢」有据可查。
fn reclaim_inner(conn: &Connection) -> Reclaim {
    // 收 WAL 是**无条件义务**,不许被上半段的任何失败带走(首版自检 #4;299 codex 实现审
    // L2:第一版把量库的三条 pragma 直接 `?` 了出去,读失败就跳过了 checkpoint)。
    // 修法取清单里的第一条——**把失败点搬走**:`?` 全关进 `measure_and_vacuum`,它的 Err
    // 降成 `Failed`,本函数**从此不返回 Result**,于是「收尾一定跑」是结构事实。
    let outcome = match measure_and_vacuum(conn) {
        Ok(o) => o,
        Err(e) => Reclaim::Failed(e),
    };
    // 收 WAL:`busy != 0` = 有别的读者拽着,这次没收干净;下次开库再收,不是错误。
    match conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0)) {
        Ok(0) => outcome,
        Ok(_) => {
            eprintln!("INFO 收 WAL 时库正忙,本次未截断(下次开库再收)");
            outcome
        }
        // 两件事各自的失败都要露面:VACUUM 已经失败过一次的话,别让 WAL 这条把它盖掉。
        Err(e) => match outcome {
            Reclaim::Failed(prev) => Reclaim::Failed(format!("{prev};收 WAL 失败:{e}")),
            _ => Reclaim::Failed(format!("收 WAL 失败:{e}")),
        },
    }
}

/// 量库 + 按判据决定要不要 VACUUM。**这里可以随便 `?`** —— 调用方把 Err 降成
/// `Failed` 之后照样会去收 WAL(见 [`reclaim_inner`])。
fn measure_and_vacuum(conn: &Connection) -> Result<Reclaim, String> {
    let pragma = |name: &str| -> Result<i64, String> {
        conn.pragma_query_value(None, name, |r| r.get(0))
            .map_err(|e| format!("读 {name} 失败:{e}"))
    };
    let page_size = pragma("page_size")?;
    let page_count = pragma("page_count")?;
    let freelist = pragma("freelist_count")?;
    // 局部名刻意不叫 vacuum:审计锚按词边界数「VACUUM 这个 SQL 关键词」,一个裸的
    // 同名标识符就是假阳(见 vacuum_and_reclaim_call_sites_are_the_audited_ones)。
    let (should_run, freelist_bytes, pct) = should_vacuum(page_size, page_count, freelist);
    Ok(if should_run {
        let before = page_count.saturating_mul(page_size);
        match conn.execute_batch("VACUUM").map_err(|e| format!("VACUUM 失败:{e}")) {
            // 磁盘紧最常见:VACUUM 要约等于库大小的临时空间。
            Err(e) => Reclaim::Failed(e),
            Ok(()) => match pragma("page_count") {
                Ok(after) => Reclaim::Vacuumed { before, after: after.saturating_mul(page_size) },
                // 回收成功了、只是量不出结果:如实说,别谎报省了多少。
                Err(e) => Reclaim::Failed(format!("VACUUM 已完成但量不出结果:{e}")),
            },
        }
    } else {
        Reclaim::Skipped { freelist_bytes, pct }
    })
}

/// 降级闸(桌面 fail-fast 政策;安卓迁移预处理在调 runner 前自行分域出 typed Err,
/// 这个 assert 在手机上不可达)。
fn assert_downgrade_gate(current: i64) {
    assert!(
        current <= SCHEMA_VERSION,
        "库版本 v{current} 比本程序(v{SCHEMA_VERSION})新——请安装新版朱简,不支持降级打开"
    );
}

/// Open and migrate only THROUGH `max_version` (inclusive) — used by tests that need
/// the pre-0014 two-entity schema in place so they can seed legacy rows and then drive
/// the 0014 data-fold migration explicitly. Never used in production.
#[cfg(test)]
pub fn open_through(path: &Path, max_version: i64) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    run_migrations(&conn, max_version)?;
    Ok(conn)
}

/// 往一枚**任意版本**的库里播一条真实数据(一行 items + 一条 item create op),
/// 列面按那枚库真实拥有的列走。
///
/// 为什么不能直接用 `notes::capture`:生产路径恒按**当前** schema 的列面写(今天含 0033
/// 的 `born_device`),拿它去喂 v27/v28 库会直接撞「table items has no column named
/// born_device」。而调用方(`spaces::build_old_db`)同一个函数既造 v28 也造当前版,
/// 所以这里必须真的分叉,不能二选一写死——「造旧版库」这类测试的固有代价。
///
/// 分叉判据取库自己的 `pragma_table_info`,不取 `SCHEMA_VERSION`:后者是「本程序最新是
/// 几」,而这里要问的是「**手上这枚库**有没有这列」,两者在本函数的调用现场恰好不同。
#[cfg(test)]
pub(crate) fn seed_legacy_item(
    conn: &Connection,
    clock: &mut crate::clock::Clock,
    content: &str,
) -> String {
    let id = ulid::Ulid::new().to_string();
    let now = "2026-01-01T00:00:00Z";
    let has_born_device: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('items') WHERE name = 'born_device'",
            [],
            |r| r.get(0),
        )
        .expect("查 items 列面");
    if has_born_device > 0 {
        // v33+:born_device 由触发器钉死成「恰等于本机 device_id」,同生产路径取数式。
        conn.execute(
            "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage, born_device) \
             VALUES (?1, ?2, 'inbox', ?3, ?3, 'inbox', \
                     (SELECT value FROM sync_meta WHERE key = 'device_id'))",
            (&id, content, now),
        )
        .expect("播 items 行");
    } else {
        conn.execute(
            "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage) \
             VALUES (?1, ?2, 'inbox', ?3, ?3, 'inbox')",
            (&id, content, now),
        )
        .expect("播旧版 items 行");
    }
    let hlc = clock.tick(conn).expect("取号");
    let origin_seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
            [hlc.device_id.as_str()],
            |r| r.get(0),
        )
        .expect("取 origin_seq");
    // create payload 跟着列面走:v33+ 八键(带 born_device),更早七键。**必须跟**——
    // boot 的状态⟺日志审计逐字段比「表列 == create 初值」,行上有值而 payload 无键
    // 就是一枚人造的矛盾。
    let mut payload = serde_json::json!({
        "content": content,
        "stage": "inbox",
        "created_at": now,
        "born_stage": "inbox",
        "due_on": null,
        "priority": null,
        "position": null,
    });
    if has_born_device > 0 {
        payload["born_device"] = serde_json::Value::String(hlc.device_id.clone());
    }
    crate::oplog::append_remote(
        conn,
        &ulid::Ulid::new().to_string(),
        &hlc.encode(),
        "item",
        &id,
        "create",
        &payload,
        origin_seq,
    )
    .expect("播 create op");
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_version_matches_migration_chain() {
        assert_eq!(
            MIGRATIONS.last().expect("migrations non-empty").0,
            SCHEMA_VERSION,
            "SCHEMA_VERSION 必须与迁移链末位同步"
        );
    }

    /// 0028(space-name-sync-plan §4.1):oplog 重建的**逻辑值等价**(全 tuple 原样,
    /// 不重编号)+ **runner 崩溃窗闭合**——迁移 SQL 在自身事务内 `PRAGMA user_version=28`,
    /// 「execute_batch COMMIT 成功、runner 外层 pragma 前崩溃」的重启不再重跑非幂等
    /// 0028(failpoint `AfterMigrationSqlCommitBeforeOuterUserVersion` 的落地形:直接
    /// 只跑 SQL、绝不跑 runner 的 pragma,再走正常 open)。
    #[test]
    fn migration_0028_is_crash_window_safe_and_preserves_oplog() {
        let path = std::env::temp_dir()
            .join(format!("ys-nb-db-0028-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        // v27 库 + 真实 op(词汇表旧 CHECK 下的正道数据)。
        let tuples = |conn: &Connection| -> Vec<(String, String, String, String, String, String, i64)> {
            let mut stmt = conn
                .prepare(
                    "SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq \
                     FROM oplog ORDER BY op_id",
                )
                .unwrap();
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
                })
                .unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        let before = {
            let mut conn = open_through(&path, 27).unwrap();
            let mut clock = crate::clock::Clock::load(&conn).unwrap();
            seed_legacy_item(&conn, &mut clock, "升级前的数据");
            // v27 库(0031 前)没有 topics.position:不能用高层 create_topic(它读/写 position)。
            // 用建档原语 + oplog 助手直接播三条 topic op(create + color set_field),口径与旧
            // create_topic 一致——本测只验 0028 崩溃窗对既有 oplog 的原样保全,不涉 0031。
            let t = crate::repo::insert_topic(&conn, "老标签").unwrap();
            crate::oplog::topic_create(&conn, &mut clock, &t).unwrap();
            crate::notes::set_topic_color(&mut conn, &mut clock, &t, Some("#aa3311".into()))
                .unwrap();
            tuples(&conn)
        };
        assert!(before.len() >= 3);
        // 崩溃窗模拟:只跑 0028 的 SQL(runner 的外层 pragma 永不执行)。
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(include_str!("../migrations/0028_space_profile.sql")).unwrap();
            let uv: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
            assert_eq!(uv, 28, "user_version 随迁移事务原子落盘(不靠 runner)");
        }
        // 重启走正常 open:runner 见 28 跳过 0028(重跑会 CREATE 撞表直接 Err)。
        let conn = open(&path).expect("崩溃窗后的重开必须成功(不重跑非幂等 0028)");
        assert_eq!(tuples(&conn), before, "oplog 全 tuple 逐字原样(op_id/hlc/origin_seq 不动)");
        let ok: String =
            conn.pragma_query_value(None, "integrity_check", |r| r.get(0)).unwrap();
        assert_eq!(ok, "ok");
        // 新词汇进得来、旧守护还在咬。
        let hlc = crate::clock::Hlc {
            wall_ms: 4_102_444_800_000,
            counter: 9,
            device_id: "RMTDEV0000000000000000000X".into(),
        }
        .encode();
        conn.execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES ('01TESTSPACEVOCAB0000000001', ?1, 'space', 'profile', 'set_field', \
                     '{\"field\":\"name\",\"value\":\"迁移后\"}', 1)",
            [&hlc],
        )
        .expect("space set_field 必须过新 CHECK");
        assert!(
            conn.execute("UPDATE oplog SET entity_id = 'x' WHERE op_id = '01TESTSPACEVOCAB0000000001'", [])
                .is_err(),
            "append-only 触发器随重建原样在咬"
        );
        assert!(
            conn.execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES ('01TESTSPACEVOCAB0000000002', 'h', 'space', 'profile', 'create', '{}', 2)",
                [],
            )
            .is_err(),
            "space create 被 CHECK 拒(寄存器无 create)"
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// 0029 起 runner 自有事务形(H2):失败原子回滚 / 事务控制与 user_version 被
    /// authorizer 拒 / 触发器体 BEGIN…END 不受伤 / FK 自验收咬人 / 幸福路 uv 随事务落。
    #[test]
    fn runner_owned_migration_shape() {
        let path = std::env::temp_dir()
            .join(format!("ys-nb-db-owned-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = open_through(&path, 28).unwrap();
        let uv = |conn: &Connection| -> i64 {
            conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap()
        };
        let has_table = |conn: &Connection, t: &str| -> bool {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [t],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
                == 1
        };
        assert_eq!(uv(&conn), 28);
        // ① 半路失败 = 整笔回滚:前半 CREATE 也不留、uv 不动。
        let err = apply_runner_owned(&conn, 99, "CREATE TABLE half(x); INSERT INTO nope VALUES(1);")
            .unwrap_err();
        assert!(err.to_string().contains("nope"), "{err}");
        assert!(!has_table(&conn, "half"), "失败迁移的前半不许留下");
        assert_eq!(uv(&conn), 28);
        // ② 事务体里写事务控制 = SQLITE_AUTH 响亮拒(结构闸,文本骗不过)。
        //    SAVEPOINT 是独立 authorizer variant、ATTACH 逃证明范围,一并负例
        //    (codex 实现审 M2)。
        assert!(apply_runner_owned(&conn, 99, "COMMIT; CREATE TABLE t(x);").is_err());
        assert!(apply_runner_owned(&conn, 99, "CREATE TABLE t(x); BEGIN;").is_err());
        assert!(
            apply_runner_owned(&conn, 99, "SAVEPOINT x; CREATE TABLE t(x); RELEASE x;").is_err(),
            "SAVEPOINT 必须被拒(局部回滚可骗过『body 全有效』)"
        );
        assert!(
            apply_runner_owned(&conn, 99, "ATTACH DATABASE ':memory:' AS side;").is_err(),
            "ATTACH 必须被拒(写扩散逃出 main+uv 同事务证明)"
        );
        assert!(!has_table(&conn, "t"));
        // 负例连发之后 authorizer 必须已摘干净:普通事务照常可用(钉「Err 路先摘
        // 后滚」语义)。
        conn.execute_batch("BEGIN; ROLLBACK;").expect("authorizer 不许泄漏到迁移之外");
        // ③ 事务体里自设 user_version = 拒。
        assert!(apply_runner_owned(&conn, 99, "PRAGMA user_version = 99;").is_err());
        assert_eq!(uv(&conn), 28);
        // ④ FK 自验收:留下外键违例的迁移整笔回滚。临时关 FK 模拟「事务内没被
        //    逐行拦」(表重建型迁移的真实形态),此时提交前的 foreign_key_check
        //    是唯一防线。
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        let err = apply_runner_owned(
            &conn,
            99,
            "CREATE TABLE p(id INTEGER PRIMARY KEY); \
             CREATE TABLE c(pid REFERENCES p(id)); \
             INSERT INTO c VALUES (999);",
        )
        .unwrap_err();
        assert!(err.to_string().contains("外键违例"), "{err}");
        assert!(!has_table(&conn, "p"), "FK 违例迁移整笔回滚");
        assert_eq!(uv(&conn), 28);
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        // ⑤ 幸福路:触发器体的 BEGIN…END 正常过 authorizer;uv 随事务原子前进。
        apply_runner_owned(
            &conn,
            30,
            "CREATE TABLE ok_t(x); \
             CREATE TRIGGER trg_ok AFTER INSERT ON ok_t BEGIN SELECT 1; END;",
        )
        .unwrap();
        assert!(has_table(&conn, "ok_t"));
        assert_eq!(uv(&conn), 30);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// 金丝雀 0029(M6):v28 库前滚到 29,业务数据与 oplog 原样。用 `open_through(29)`
    /// 隔离这一步(open() 现会继续前滚到最新迁移;full-open 覆盖在别处),专验 0029 空迁移。
    #[test]
    fn canary_0029_forward_migrates_v28() {
        let path = std::env::temp_dir()
            .join(format!("ys-nb-db-canary-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let before = {
            let conn = open_through(&path, 28).unwrap();
            let mut clock = crate::clock::Clock::load(&conn).unwrap();
            seed_legacy_item(&conn, &mut clock, "升级前的数据");
            conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get::<_, i64>(0)).unwrap()
        };
        let conn = open_through(&path, 29).expect("v28 库前滚到 29 必须成功");
        let uv: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(uv, 29);
        let after: i64 =
            conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        assert_eq!(after, before, "金丝雀零 schema 改动、零数据触碰");
        let ok: String =
            conn.pragma_query_value(None, "integrity_check", |r| r.get(0)).unwrap();
        assert_eq!(ok, "ok");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// §7-3 的落实(299 codex 实现审 M2 / 二轮 M / 三轮 M):**「调用前必须自证这个文件上
    /// 没有活引擎」是调用图的性质,不是类型的性质**,所以得有东西盯着调用图别长出新枝。
    ///
    /// **扫描面 = 整个工作区的 Rust 生产代码**(`core/src` + `src-tauri/src` +
    /// `android/src-tauri/src`)。只扫 core 不够:真正会触发回收的两个公开入口
    /// `db::open` 与 `spaces::open_space` 的调用点**都在壳里**,壳还能直接对 runtime
    /// 连接裸跑 VACUUM —— 那些 core 内部一个计数都不会变(codex 三轮 M)。
    ///
    /// 盯四件事:
    /// 1. `reclaim_free_pages` 只许 `core/db.rs::open` 与 `core/spaces.rs::open_space` 各一;
    /// 2. **原地 VACUUM** 只许 `core/db.rs`(开库回收)与 `core/sync/boot.rs`(剥快照);
    /// 3. `VACUUM INTO`(写新文件、不动源库)单独归类,只许 `boot.rs`;
    /// 4. 两个公开入口的调用点数目钉死 —— 壳里新增一处就红;并且**只许限定名直接调用**
    ///    (`use ...db::open` / `open_space as X` / `let f = db::open` 一律拒)——
    ///    那些都是普通 Rust 演进,数固定拼写的锚对它们全是假绿(codex 四轮 M)。
    ///
    /// # 三处判据上的坑,都是真栽出来的
    ///
    /// * **不能靠花括号配平找 `mod tests` 边界**:这段源码会扫到它自己所在的文件,一个
    ///   闭括号字符字面量就把配平算歪(db.rs 那次数出 10 而不是 3);换到 boot.rs 又被
    ///   测试段里不配平的花括号提前收尾。现按**第 0 列的单独闭括号**判 —— ⚠ 这是**本仓
    ///   rustfmt + 顶层测试模块的约定,不是 Rust 语法保证**(模块内部不要求缩进,raw
    ///   string 里也可能出现顶格闭括号)。所以下面另有两道自证。
    /// * **不能先整体 uppercase 再匹配**(codex 三轮建议的形):`should_vacuum` /
    ///   `measure_and_vacuum` 大写之后统统含 "VACUUM"。现按**大小写不敏感 + 词边界**
    ///   (前后都不许是字母数字下划线)数,于是 `_vacuum` 后缀天然不算;并且**生产代码里
    ///   刻意不留裸的 `vacuum` 标识符**(`reclaim_inner` 那个局部量因此叫 `should_run`)。
    /// * **数字里含错误消息中提到 VACUUM 的那几句**,不只真正执行的。刻意保守:多写一句
    ///   提及也让人回来看一眼,比漏掉一次真调用便宜(codex 二轮已认这个取舍)。
    ///
    /// **它不证明现有调用点是对的**(证据在 [`reclaim_free_pages`] 的文档表里,逐条人工
    /// 核过),它只保证「悄悄加一条」做不到。迁移 SQL 不在扫描面:迁移跑在 runner 的
    /// `BEGIN IMMEDIATE` 里,VACUUM 在事务中会被 SQLite 当场拒,不是静默风险。
    #[test]
    fn vacuum_and_reclaim_call_sites_are_the_audited_ones() {
        fn rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("读 {} 失败:{e}", dir.display()))
            {
                let p = e.expect("目录项").path();
                if p.is_dir() {
                    rs_files(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        // 生产段 = 剔 `//` 之后的正文,再摘掉 `mod tests` 整块(见上「三处坑」第一条)。
        // 花括号一律用码点造,源码里不留字面量。
        fn production(src: &str) -> String {
            let cb = 0x7Du8 as char;
            let mut out = String::new();
            let mut in_tests = false;
            for line in src.lines() {
                let code = line.split("//").next().unwrap_or("");
                // 只有**内联模块体**(`mod tests {`)才开始跳;`mod tests;` 是一句声明,
                // 后面跟的仍是生产码 —— 按老写法它会把声明之后的整个文件吞掉(310 起
                // 六个大文件都有这句声明,当场量出来的)。
                if !in_tests && code.starts_with("mod tests") && code.contains('{') {
                    in_tests = true;
                    continue;
                }
                if in_tests {
                    if code.trim_end().len() == 1 && code.starts_with(cb) {
                        in_tests = false;
                    }
                    continue;
                }
                if code.contains("fn reclaim_free_pages") || code.contains("fn open_space") {
                    continue; // 定义那一行长得也像一次调用
                }
                out.push_str(code);
                out.push('\n');
            }
            out
        }
        /// 三条「敏感入口只许限定名直接调用」规则的**纯谓词形**(抽出来才能自证,见下面
        /// 那张表)。返回 Some(理由) = 违规。
        ///
        /// 两把尺子,刻意不同宽:
        /// * `open_space` / `reclaim_free_pages` 按**完整标识符**判 —— `open_space_metadata`
        ///   是另一个符号,不该被误杀(codex 五轮 L);
        /// * `db` **刻意从严**:任何成员导入都拒,连 `db::open_through` 也拒(codex 六轮 L
        ///   的收简形)。理由是只要 db 的成员能被 use 进来,「调用处必须显出 `db::open`」
        ///   这条就不再可靠;而全仓生产代码本来就零处 db 成员导入,从严不花钱。
        fn use_item_violation(item: &str) -> Option<String> {
            let toks = idents(item);
            for sym in ["open_space", "reclaim_free_pages"] {
                if toks.iter().any(|t| t == sym) {
                    return Some(format!("不许 use 进敏感入口「{sym}」,只许限定名直接调用"));
                }
            }
            // **db 模块只许整体导入**:item 里出现 `db::` 就拒。一条顶掉三种绕法
            // (`db::open` / `db::{open}` / `db::{self as storage}`),而且比「db 与 open
            // 在同一条 item 里共现」准 —— 后者会误杀 `use crate::{db, dialog::open};`
            // 这种 open 根本不来自 db 的正当写法(codex 六轮 L)。
            //
            // ⚠ 必须带**前置标识符边界**:裸 `contains("db::")` 会把 `local_db::helper` /
            // `adb::client` 这类无关模块一起拒掉(codex 七轮 L1)。后缀那侧有 `::` 兜着,
            // 只需验前一个字符不是 [A-Za-z0-9_]。
            let bytes = item.as_bytes();
            if item.match_indices("db::").any(|(i, _)| {
                i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_')
            }) {
                return Some("db 模块只许整体导入(use …::db;),不许 db::任何成员 —— \
                             调用处必须显出 db::open(…)".into());
            }
            for w in toks.windows(2) {
                if (w[0] == "db" || w[0] == "spaces") && w[1] == "as" {
                    return Some("不许给 db / spaces 模块起别名,会让调用点审计锚失明".into());
                }
            }
            None
        }

        /// 把生产段里的每条 `use` / `pub use` item 整条取出(收到分号为止,故多行分组
        /// 写法也是完整一条)。
        fn use_items(prod: &str) -> Vec<String> {
            let mut out = Vec::new();
            for (i, _) in prod.match_indices("use ") {
                // 必须是 item 开头:行首(允许缩进)或紧跟 `pub `。
                let before = &prod[..i];
                let head = before.rsplit('\n').next().unwrap_or("").trim();
                // 起点 = 行首,或前缀是 pub / pub(crate) / pub(super) / pub(in …)
                // (codex 六轮 M:原先只认恰好 "pub",`pub(crate) use` 整条被漏掉)。
                if !(head.is_empty() || head.starts_with("pub")) {
                    continue;
                }
                let tail = &prod[i..];
                let end = tail.find(';').map_or(tail.len(), |e| e + 1);
                out.push(tail[..end].split_whitespace().collect::<Vec<_>>().join(" "));
            }
            out
        }

        /// 拆成标识符 token(非 `[A-Za-z0-9_]` 一律当分隔符)。
        fn idents(s: &str) -> Vec<String> {
            s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect()
        }

        /// 大小写不敏感 + 词边界地数 VACUUM,顺带分出 `VACUUM INTO`。
        fn count_vacuum(prod: &str) -> (usize, usize) {
            let lower = prod.to_ascii_lowercase();
            let bytes = lower.as_bytes();
            let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
            let (mut inplace, mut into) = (0usize, 0usize);
            for (i, _) in lower.match_indices("vacuum") {
                if i > 0 && ident(bytes[i - 1]) {
                    continue;
                }
                if bytes.get(i + 6).is_some_and(|c| ident(*c)) {
                    continue;
                }
                if lower[i + 6..].trim_start().starts_with("into") {
                    into += 1;
                } else {
                    inplace += 1;
                }
            }
            (inplace, into)
        }

        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core 的上级 = 仓根");
        let roots = [
            ("core", repo.join("core/src")),
            ("desktop", repo.join("src-tauri/src")),
            ("android", repo.join("android/src-tauri/src")),
        ];

        // ---- 自证一:每个参与裁决的文件都给一对哨兵(留生产符号 / 摘测试符号)。
        // 没有它,扫描器算歪了也只会安静地给出一个看着合理的错答案 —— 前两版都是这样。
        for (path, keep, drop) in [
            ("core/src/db.rs", "pub fn open", "reclaim_predicate_needs_both_gates"),
            ("core/src/spaces.rs", "pub fn create_space", "fn heal_legacy_space_name_migrates_once"),
            ("core/src/sync/boot.rs", "pub fn make_snapshot", "fn raw_snapshot"),
            ("src-tauri/src/lib.rs", "fn get_item_thumb", "mod tests"),
            ("android/src-tauri/src/coord.rs", "pub async fn move_between", "mod tests"),
        ] {
            let src = std::fs::read_to_string(repo.join(path)).expect("读源文件");
            let prod = production(&src);
            assert!(prod.contains(keep), "{path}:扫描面丢了生产符号「{keep}」");
            assert!(!prod.contains(drop), "{path}:mod tests 没摘干净,漏进了「{drop}」");
        }

        // ---- 自证四:三条 use 规则**两侧都验**(阳性拒得对、阴性别误杀)。
        // 阴性那半是历轮 L 的判例:`open_space_metadata` 是另一个标识符、
        // `use crate::{db, dialog::open}` 的 open 不来自 db、`local_db::` 更与 db 无关 ——
        // 一个都不许误杀。(`db::open_through` 是**故意**放在阳性那边的,见谓词文档。)
        for (item, want_block) in [
            // 阳性:三种绕法都得拒
            ("use zhujian_core::db::open;", true),
            ("use zhujian_core::db::{open};", true),
            ("pub(crate) use zhujian_core::db::{open};", true),
            ("use zhujian_core::db::{self as storage};", true),
            ("use zhujian_core::{ db as storage, };", true),
            ("use zhujian_core::spaces::open_space as open_target;", true),
            ("use crate::db::reclaim_free_pages;", true),
            // db 只许整体导入,故连 open_through 这种无关成员也一并拒 —— 刻意从严:
            // db 模块的任何成员导入都会让「调用处显出 db::open」这条不再可靠。
            ("use crate::db::open_through;", true),
            // 阴性:正当写法一个都不许误杀
            ("use crate::db;", false),
            // open 不来自 db,只是同处一条 item —— 旧的「共现」判据会误杀它(六轮 L)。
            ("use crate::{db, dialog::open};", false),
            ("use crate::spaces::open_space_metadata;", false),
            // 无关模块名里恰好含 db:裸 contains("db::") 会误杀它们(七轮 L1)。
            ("use crate::local_db::helper;", false),
            ("use crate::adb::client;", false),
            ("use zhujian_core::spaces::{self, JoiningSlot, SpaceCatalog, SpaceDescriptor};", false),
            ("use zhujian_core::{clock, db, images, notes, repo, sync, task, thumbs};", false),
        ] {
            let got = use_item_violation(item).is_some();
            assert_eq!(got, want_block, "use 规则对「{item}」判错了(该拒={want_block})");
        }

        let mut reclaim: Vec<(String, usize)> = Vec::new();
        let mut inplace: Vec<(String, usize)> = Vec::new();
        let mut into: Vec<(String, usize)> = Vec::new();
        let mut db_open: Vec<(String, usize)> = Vec::new();
        let mut open_space: Vec<(String, usize)> = Vec::new();
        // 310 起大文件的测试段住 `<name>/tests.rs`(整个文件都是测试)。下面那个
        // `production()` 只会切**内联**的 `mod tests`,对这种文件它会原样返回、
        // 把夹具当生产码扫 —— 落地当天就红在 boot 的两处剥快照 VACUUM 上。故整文件跳过。
        let (mut skipped, mut declared) = (0usize, 0usize);
        for (tag, root) in &roots {
            let mut files = Vec::new();
            rs_files(root, &mut files);
            assert!(!files.is_empty(), "{tag} 扫描面为空,路径不对?");
            for f in &files {
                let rel = format!(
                    "{tag}/{}",
                    f.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")
                );
                if rel.ends_with("/tests.rs") || rel.contains("/tests/") {
                    skipped += 1;
                    continue;
                }
                let src = std::fs::read_to_string(f).expect("读源文件");
                // ---- 自证二:测试模块声明必须顶格,排布反常直接红(边界判据的前提)。
                for line in src.lines() {
                    let code = line.split("//").next().unwrap_or("");
                    if code.trim_start().starts_with("mod tests") {
                        assert!(
                            code.starts_with("mod tests"),
                            "{rel}:`mod tests` 不在第 0 列,测试块边界判据失效"
                        );
                    }
                }
                let prod = production(&src);
                if prod.lines().any(|l| l.trim_end() == "mod tests;") {
                    declared += 1;
                }
                // ---- 自证三:敏感入口**只许限定名直接调用**(codex 四轮 M)。
                // `use ...db::open; open(p)` / `open_space as open_target` / `let f = db::open`
                // 都是**普通 Rust 演进**,不是刻意规避 —— 靠数固定拼写的锚对它们全是假绿。
                // 故:①含敏感符号的 use 一律拒;②给 db 模块起别名一律拒;
                //     ③每一处引用后面第一个非空白字符必须是左括号(不许当值传递)。
                // 按**整条 use item**(收到分号为止)拆成标识符 token 再判 —— 不是逐物理行、
                // 也不是子串匹配。两者都被绕过过(codex 五轮):
                //   use zhujian_core::db::{open};        // 没有连续的 "db::open"
                //   use zhujian_core::{\n    db as storage,\n};  // 别名那行不以 use 开头
                // token 化顺带修好子串误杀(codex 五轮 L):`spaces::open_space_metadata`
                // 是**另一个标识符**,不该被拒。db 那把尺子则刻意更严(见谓词文档)。
                for item in use_items(&prod) {
                    if let Some(why) = use_item_violation(&item) {
                        panic!("{rel}:{why}({item})");
                    }
                }
                let n = |sym: &str| -> usize {
                    let bytes = prod.as_bytes();
                    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
                    let mut count = 0usize;
                    for (i, _) in prod.match_indices(sym) {
                        if i > 0 && ident(bytes[i - 1]) {
                            continue;
                        }
                        let tail = &prod[i + sym.len()..];
                        if tail.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
                            continue; // db::open_through 之类
                        }
                        assert!(
                            tail.trim_start().starts_with('('),
                            "{rel}:「{sym}」只许直接调用,不许当函数值传递/取别名 —— \
                             那会让调用点审计锚数不到它"
                        );
                        count += 1;
                    }
                    count
                };
                for (bucket, c) in [
                    (&mut reclaim, n("reclaim_free_pages")),
                    (&mut db_open, n("db::open")),
                    (&mut open_space, n("open_space")),
                ] {
                    if c > 0 {
                        bucket.push((rel.clone(), c));
                    }
                }
                let (ip, it) = count_vacuum(&prod);
                if ip > 0 {
                    inplace.push((rel.clone(), ip));
                }
                if it > 0 {
                    into.push((rel.clone(), it));
                }
            }
        }
        // 跳过的测试文件数,必须与生产段里 `mod tests;` 的声明数相等 —— 否则要么有
        // 测试文件没被跳过(夹具会被当生产码扫,本锚变假绿),要么跳过的路径判据认错了
        // 文件(把真生产码扫漏了)。两侧各自会变,故拿它们互证,而不是写死一个数。
        assert_eq!(
            skipped, declared,
            "跳过的 tests.rs 有 {skipped} 个,而生产段里声明了 {declared} 处 `mod tests;` —— \
             对不上就说明路径判据(`/tests.rs` 结尾或 `/tests/` 下)与实际布局脱节了"
        );
        for v in [&mut reclaim, &mut inplace, &mut into, &mut db_open, &mut open_space] {
            v.sort();
        }
        let want = |xs: &[(&str, usize)]| -> Vec<(String, usize)> {
            let mut v: Vec<_> = xs.iter().map(|(a, b)| (a.to_string(), *b)).collect();
            v.sort();
            v
        };

        assert_eq!(
            reclaim,
            want(&[("core/db.rs", 1), ("core/spaces.rs", 1)]),
            "回收的调用点只许是 db.rs::open 与 spaces.rs::open_space —— 新增一处就先读 \
             reclaim_free_pages 的文档表,证明那个文件上没有活引擎,再回来改这只测"
        );
        assert_eq!(
            inplace,
            want(&[("core/db.rs", 3), ("core/sync/boot.rs", 1)]),
            "原地 VACUUM 会重排 rowid(ops_serve 的取帧游标就是 rowid),只许出现在 \
             db.rs 的开库回收与 boot.rs 的剥快照"
        );
        assert_eq!(
            into,
            want(&[("core/sync/boot.rs", 2)]),
            "VACUUM INTO(写新文件、不动源库)只许在 boot.rs 出快照"
        );
        assert_eq!(
            db_open,
            want(&[("core/sync/convergence.rs", 1), ("desktop/lib.rs", 4)]),
            "db::open 会跑回收,调用点数目钉死;convergence.rs 那处是 `#[cfg(test)] mod \
             convergence` 整模块门控的 property test(文件里没有 mod tests,扫不掉)"
        );
        assert_eq!(
            open_space,
            want(&[("android/coord.rs", 2)]),
            "open_space 会跑回收:安卓装配一处 + 跨空间移动的目标一处。新增一处必须先证明 \
             那个空间此刻完全无槽(现有两处靠 sup.reserve 与 lifecycle+orchestrate 双锁)"
        );
    }

    /// §4.3 双判据:**两道闸各自都得是必要条件**。端到端那只测造的库两条同时满足,
    /// 拆掉任一条它照样绿——所以这四个象限必须在这里单独钉。
    #[test]
    fn reclaim_predicate_needs_both_gates() {
        let ps = 4096;
        let mib = |n: i64| n * 1024 * 1024 / ps; // n MiB 换成页数
        let hit = |pc: i64, fl: i64| should_vacuum(ps, pc, fl).0;
        // ① 两条都过 → VACUUM(真实主库那一格:30 MiB / 71%;绝对值闸 8 MiB)。
        assert!(hit(mib(42), mib(30)));
        // ② 占比够高但**绝对值太小** → 不做(别为小库白等):2 MiB 空页占 66%。
        assert!(!hit(mib(3), mib(2)), "小库白等闸失守");
        // ③ 绝对值够大但**占比太低** → 不做:10 MiB 空页在 100 MiB 库里只占 10%。
        assert!(!hit(mib(100), mib(10)), "占比闸失守");
        // ④ 恰在两条闸线上 = 不做(闸是 > 不是 >=,两侧各验一格)。
        assert!(!hit(mib(100), RECLAIM_MIN_BYTES / ps), "绝对值恰等于上界不该做");
        assert!(!hit(100, 30), "占比恰等于 30% 不该做");
        assert!(hit(mib(100), mib(31)), "31% 且远超绝对值闸:该做");
        // ⑥ **30% 与 31% 之间那一段**(299 codex 实现审 L1 的判例):整除会把
        //    30.1%…30.999% 全截成 30 而跳过,闸就从「>30%」偷偷变成「>=31%」。
        //    8000 页 × 4096 = 31.25 MiB 库,2479 空页 ≈ 9.68 MiB、30.99% —— 规格说该做。
        assert!(hit(8000, 2479), "30.99% 必须命中(整除截断会把它错判成 30%)");
        assert!(!hit(8000, 2400), "恰 30.0% 仍不该做(闸是 > 不是 >=)");
        assert!(hit(8000, 2401), "刚过 30% 的第一格就该做");
        // ⑤ 空库不除零。
        assert!(!hit(0, 0));
    }

    /// 收 WAL 是**独立于 VACUUM 的一件事**:谓词不满足也要收(§4.3「无论是否 VACUUM」)。
    /// 没有这只测,把 checkpoint 挪进 VACUUM 分支不会有任何测试变红。
    #[test]
    fn reclaim_checkpoints_wal_even_when_it_skips_vacuum() {
        let path = std::env::temp_dir()
            .join(format!("ys-nb-db-ckpt-{}.sqlite3", std::process::id()));
        let wal_path = path.with_file_name(format!(
            "{}-wal",
            path.file_name().unwrap().to_string_lossy()
        ));
        for f in [&path, &wal_path] {
            let _ = std::fs::remove_file(f);
        }
        // 小库 + 胖 WAL:写一批图字节但**不删**,故 freelist ≈ 0、谓词必不满足。
        {
            let mut conn = open(&path).unwrap();
            let mut clock = crate::clock::Clock::load(&conn).unwrap();
            let big = vec![0x33u8; 2 * 1024 * 1024];
            for i in 0..3 {
                let it = crate::notes::capture(&mut conn, &mut clock, &format!("{i}")).unwrap();
                crate::images::attach(&mut conn, &mut clock, &it, &big, "image/png").unwrap();
            }
            let fat = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
            assert!(fat > 1024 * 1024, "前置没成立:WAL 才 {fat} 字节,收不收都看不出来");
            // 刻意不 drop 连接就地取样——drop 会自己走一次被动 checkpoint,
            // 那样「WAL 变小」就不是本函数干的了(判据得只由被测那一步决定)。
            let r = reclaim_inner(&conn);
            assert!(matches!(r, Reclaim::Skipped { .. }), "不该 VACUUM,得到 {r:?}");
            let slim = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
            assert_eq!(slim, 0, "没 VACUUM 也必须把 WAL 收干净(还剩 {slim} 字节)");
            // 数据还在(收 WAL 是搬运不是丢弃)。
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 3);
        }
        for f in [&path, &wal_path] {
            let _ = std::fs::remove_file(f);
        }
    }

    /// 收 WAL 的**另一半**:量库那一步就失败时,收尾照样要跑(299 codex 实现审 L2 的修法
    /// = 把 `?` 全关进 `measure_and_vacuum`,让 `reclaim_inner` 不再返回 `Result`)。
    ///
    /// ⚠ 这只测是补的:变异对照头一遍把 L2 的修法判成**假绿** —— 上面那只
    /// `..._even_when_it_skips_vacuum` 里量库是成功的,Err 那一支根本没人走,
    /// 把 `Err(e) => Reclaim::Failed(e)` 换回 `return` 它照样绿。
    ///
    /// 造可控失败点用的是本文件已有的工装:rusqlite authorizer(`apply_runner_owned`
    /// 拿它拒 `user_version` 的同一把)。拒掉量库要读的 `page_size`,放行别的 —— 尤其
    /// **必须放行 `wal_checkpoint`**,否则测的就成了「两件事一起被拒」。
    #[test]
    fn reclaim_checkpoints_wal_even_when_measuring_fails() {
        let path = std::env::temp_dir()
            .join(format!("ys-nb-db-authfail-{}.sqlite3", std::process::id()));
        let wal_path = path.with_file_name(format!(
            "{}-wal",
            path.file_name().unwrap().to_string_lossy()
        ));
        for f in [&path, &wal_path] {
            let _ = std::fs::remove_file(f);
        }
        let mut conn = open(&path).unwrap();
        let mut clock = crate::clock::Clock::load(&conn).unwrap();
        let big = vec![0x77u8; 2 * 1024 * 1024];
        for i in 0..2 {
            let it = crate::notes::capture(&mut conn, &mut clock, &format!("{i}")).unwrap();
            crate::images::attach(&mut conn, &mut clock, &it, &big, "image/png").unwrap();
        }
        let fat = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        assert!(fat > 1024 * 1024, "前置没成立:WAL 才 {fat} 字节");

        conn.authorizer(Some(|ctx: AuthContext| match ctx.action {
            AuthAction::Pragma { pragma_name, .. } if pragma_name.eq_ignore_ascii_case("page_size") => {
                Authorization::Deny
            }
            _ => Authorization::Allow,
        }));
        let r = reclaim_inner(&conn);
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);

        match &r {
            Reclaim::Failed(e) => assert!(e.contains("page_size"), "失败该指名道姓:{e}"),
            other => panic!("量库被拒时应如实报 Failed,得到 {other:?}"),
        }
        let slim = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        assert_eq!(slim, 0, "量库失败也必须把 WAL 收干净(还剩 {slim} 字节)");
        // 数据没事(量不出来 ≠ 库坏了)。
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        drop(conn);
        for f in [&path, &wal_path] {
            let _ = std::fs::remove_file(f);
        }
    }

    /// §4 回收空页 —— 谓词两侧各一只(§7 验收 2)。
    ///
    /// 造超阈值的库:塞图字节把库撑到 ~60 MiB,删掉大部分 → freelist 既过 16 MiB 绝对值
    /// 闸、又过 30% 占比闸。**验的是文件真变小且数据一字不差**,不是只看返回值。
    #[test]
    fn reclaim_vacuums_only_over_both_thresholds_and_preserves_data() {
        let path = std::env::temp_dir()
            .join(format!("ys-nb-db-reclaim-{}.sqlite3", std::process::id()));
        for f in [path.clone(), path.with_extension("sqlite3-wal"), path.with_extension("sqlite3-shm")] {
            let _ = std::fs::remove_file(&f);
        }
        // ① 小库:谓词不满足,一个字节都不许 VACUUM(别为小库白等)。
        {
            let conn = open(&path).unwrap();
            let r = reclaim_inner(&conn);
            assert!(
                matches!(r, Reclaim::Skipped { .. }),
                "空库不该 VACUUM,得到 {r:?}"
            );
        }
        // ② 撑大再删空:图字节是本仓唯一能快速堆出几十 MiB 的东西(与真实成因一致)。
        let (kept_item, kept_bytes) = {
            let mut conn = open(&path).unwrap();
            let mut clock = crate::clock::Clock::load(&conn).unwrap();
            let big = vec![0x5Au8; 2 * 1024 * 1024]; // 2 MiB × 30 = 60 MiB
            let keep = crate::notes::capture(&mut conn, &mut clock, "留下的").unwrap();
            crate::images::attach(&mut conn, &mut clock, &keep, &big, "image/png").unwrap();
            let mut doomed = Vec::new();
            for i in 0..29 {
                let it = crate::notes::capture(&mut conn, &mut clock, &format!("要删的{i}")).unwrap();
                crate::images::attach(&mut conn, &mut clock, &it, &big, "image/png").unwrap();
                doomed.push(it);
            }
            // 走正道硬删(发墓碑 op),不是 `DELETE FROM items` —— 后者留下「有 create op
            // 却没有行」的矛盾,严格电池会当场报脏,那是夹具的错不是回收的错。
            for it in doomed {
                crate::notes::delete_inbox(&mut conn, &mut clock, &it).unwrap();
            }
            (keep, big)
        };
        let size = |p: &std::path::Path| -> u64 { std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) };
        let before_file = size(&path);
        let (freelist_bytes, uv_before, ops_before) = {
            let conn = open(&path).unwrap();
            // open 自己已经跑过一次 reclaim —— 用它当被测路径:文件此刻应已瘦下来。
            let fl: i64 = conn.pragma_query_value(None, "freelist_count", |r| r.get(0)).unwrap();
            let uv: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
            let ops: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
            (fl, uv, ops)
        };
        let after_file = size(&path);
        assert!(
            after_file < before_file / 2,
            "超阈值的库开一次就该瘦下来:{before_file} → {after_file}"
        );
        assert!(freelist_bytes < 4096, "VACUUM 后 freelist 应基本归零,还有 {freelist_bytes} 页");
        // ③ 数据一字不差 + 结构性质原样(uv 若被 VACUUM 重置,下次开库会重跑迁移直接炸)。
        {
            let conn = open(&path).unwrap();
            assert_eq!(uv_before, SCHEMA_VERSION, "VACUUM 必须保住 user_version");
            let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
            assert_eq!(mode, "wal", "VACUUM 必须保住 WAL");
            let ok: String = conn.pragma_query_value(None, "integrity_check", |r| r.get(0)).unwrap();
            assert_eq!(ok, "ok");
            let imgs = crate::repo::list_item_images(&conn, &kept_item).unwrap();
            assert_eq!(imgs.len(), 1);
            let (bytes, _mime) = crate::repo::item_image_data(&conn, &imgs[0].id).unwrap().unwrap();
            assert_eq!(bytes, kept_bytes, "留下那张图的字节必须一字不差");
            let ops: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
            assert_eq!(ops, ops_before, "oplog 是史实,回收不许动它");
            crate::sync::boot::strict_battery(&conn).expect("回收后必须仍过严格电池");
            // ④ 已经瘦过的库再开:谓词不再满足,不白跑第二次。
            let r = reclaim_inner(&conn);
            assert!(matches!(r, Reclaim::Skipped { .. }), "瘦过的库不该再 VACUUM,得到 {r:?}");
        }
        for f in [path.clone(), path.with_extension("sqlite3-wal"), path.with_extension("sqlite3-shm")] {
            let _ = std::fs::remove_file(&f);
        }
    }

    #[test]
    fn open_enables_wal_and_busy_timeout() {
        let path = std::env::temp_dir().join(format!("ys-nb-db-wal-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = open(&path).expect("open database");
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .expect("query journal_mode");
        assert_eq!(mode, "wal");
        let timeout_ms: i64 = conn
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .expect("query busy_timeout");
        assert_eq!(timeout_ms, 5000);
    }
}

/// crate 内共用的迁移执行器:`open` 的读写路径与 `spaces::create_space` 的 staging
/// 建库(刻意不切 WAL)都走它。
pub(crate) fn run_migrations(conn: &Connection, max_version: i64) -> rusqlite::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    // 降级闸(codex 实现审 L):比本程序新的库拒开——旧代码不认识新表/新词汇,
    // 照跑会走已退役的路径(如 0028 前的 sync_meta.space_name)静默分叉。fail-fast
    // 与本文件 WAL 断言同款;更新分发不提供降级,触发即人为装旧包,人话提示升级。
    assert_downgrade_gate(current);
    for (version, sql) in MIGRATIONS {
        if *version > current && *version <= max_version {
            if *version >= RUNNER_OWNS_TXN_FROM {
                apply_runner_owned(conn, *version, sql)?;
            } else {
                // 1-28 老形原样(不回改历史):SQL 文件自带事务(0028 起连 uv 也自设,
                // 外层 pragma 是幂等重写)。安卓**既有正式库**绝不原地跑 1-27(下限
                // 28 挡在门外);fresh/staging 建库从 1 全跑属建库事务,半成品整库
                // 弃置重来,不吃崩溃窗(codex 实现审 L 措辞钉正)。
                conn.execute_batch(sql)?;
                conn.pragma_update(None, "user_version", version)?;
            }
        }
    }
    Ok(())
}

/// 0029 起的迁移执行形(codex 设计审 H2:结构原子,不靠文本 lint):
/// `BEGIN IMMEDIATE → 事务体 → foreign_key_check → user_version → COMMIT`,
/// 事务体执行期间挂 SQLite authorizer 拒事务控制与 `PRAGMA user_version`——
/// 迁移文件写了顶层 BEGIN/COMMIT 或自设 uv 会在预备语句时就响亮失败(SQLITE_AUTH),
/// 整笔回滚。断电/系统 kill 于任一点:事务中=回滚重跑;COMMIT 后=uv 已随事务
/// 原子落盘、重启跳过(user_version 存 db header、参与事务)。
fn apply_runner_owned(conn: &Connection, version: i64, sql: &str) -> rusqlite::Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    conn.authorizer(Some(|ctx: AuthContext| match ctx.action {
        // 事务控制三族全拒(codex 实现审 M2):BEGIN/COMMIT/ROLLBACK 之外,SAVEPOINT
        // 是独立 variant——放行的话事务体能局部回滚骗过「body 全有效」;ATTACH/DETACH
        // 会把写扩散到旁库,逃出「main schema+uv 同事务」的证明范围。
        AuthAction::Transaction { .. }
        | AuthAction::Savepoint { .. }
        | AuthAction::Attach { .. }
        | AuthAction::Detach { .. } => Authorization::Deny,
        AuthAction::Pragma { pragma_name, .. }
            if pragma_name.eq_ignore_ascii_case("user_version") =>
        {
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }));
    let body = conn.execute_batch(sql);
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    let rollback = |e: rusqlite::Error| -> rusqlite::Error {
        let _ = conn.execute_batch("ROLLBACK");
        e
    };
    body.map_err(rollback)?;
    // 提交前自验收(codex 设计审 M5 采纳项):外键一致性。每个中间版本必须是独立
    // 有效的检查点——系统可能停在任意两条迁移之间。
    let fk_violation: Option<String> = {
        use rusqlite::OptionalExtension;
        conn.query_row("PRAGMA foreign_key_check", [], |r| r.get(0))
            .optional()
            .map_err(rollback)?
    };
    if let Some(table) = fk_violation {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY),
            Some(format!("迁移 {version:04} 留下外键违例(表 {table}),已回滚")),
        ));
    }
    conn.pragma_update(None, "user_version", version).map_err(rollback)?;
    // COMMIT 失败(如 BUSY)时事务可能仍 active:确认后显式回滚,兑现「任何失败
    // 不留悬挂事务」(codex 实现审 M3;is_autocommit 避免对已终结事务盲回滚)。
    if let Err(e) = conn.execute_batch("COMMIT") {
        if !conn.is_autocommit() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        return Err(e);
    }
    Ok(())
}
