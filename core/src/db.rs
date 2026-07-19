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
pub const SCHEMA_VERSION: i64 = 29;

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
    Ok(conn)
}

/// 降级闸(桌面 fail-fast 政策;安卓迁移预处理在调 runner 前自行分域出 typed Err,
/// 这个 assert 在手机上不可达)。
fn assert_downgrade_gate(current: i64) {
    assert!(
        current <= SCHEMA_VERSION,
        "库版本 v{current} 比本程序(v{SCHEMA_VERSION})新——请安装新版朱笺,不支持降级打开"
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
            crate::notes::capture(&mut conn, &mut clock, "升级前的数据").unwrap();
            let t = crate::notes::create_topic(&mut conn, &mut clock, "老标签").unwrap();
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

    /// 金丝雀 0029(M6):v28 库经正常 open 前滚到 29,业务数据与 oplog 原样。
    #[test]
    fn canary_0029_forward_migrates_v28() {
        let path = std::env::temp_dir()
            .join(format!("ys-nb-db-canary-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let before = {
            let mut conn = open_through(&path, 28).unwrap();
            let mut clock = crate::clock::Clock::load(&conn).unwrap();
            crate::notes::capture(&mut conn, &mut clock, "升级前的数据").unwrap();
            conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get::<_, i64>(0)).unwrap()
        };
        let conn = open(&path).expect("v28 库前滚 open 必须成功");
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
