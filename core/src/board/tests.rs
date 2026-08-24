//! 迁移 0036 的行为锚(board-columns-plan §14 那张「B-b 必查表」里落在第 1 段的格子)。
//!
//! 分四组:
//! 1. **六个种子行与 [`SEED_COLUMNS`] 完全相等**(§14 第三行)+ 表级 CHECK 的方向;
//! 2. **五只守护 + 一只消费者**逐只的行为;
//! 3. **两只耦合触发器**:单机路径照拦、回放语境放行中间态;
//! 4. **旧六 stage 的存量数据全链路**(§8 那条「硬验收」与 §14 第八行)。
//!
//! # ⚠ 两处诚实边界,别当成漏测
//!
//! **(一)④ 的肯定半边在本版测不了**:oplog 的词汇表 CHECK 要到 B-c 才认识 `board_column`
//! ⇒ 此刻库里造不出任何一枚 `board_column/tombstone` op ⇒ ④ 里那句
//! `EXISTS (... FROM oplog ...)` 恒假 ⇒ **每一条 marker 改写都会被拒**。首次盖墓碑 /
//! 并发取 min / `epoch_rebase` / 等值 no-op 那四格是 **B-c 的验收项**(plan §14 第六行)。
//! ⛔ 若那时发现 0036 里的 ④ 写错了,只能新增一条迁移 DROP + CREATE 修(0034 判例)。
//!
//! **(二)①②④ 三只同时挂在 `BEFORE UPDATE OF tombstoned_at` 上,SQLite 不保证它们的触发
//! 顺序**(文档原文:the order of firing is undefined)⇒ 三只都在场时「报的是哪一句话」
//! 不可断言。故 ①② 的**单只行为**由 [`guard_one_is_replay_exempt_and_guard_two_is_not`]
//! 在一份**摘掉 ④** 的临时库上验(⑤⑥ 挂在别的事件/时机上,不受这条影响)。

use super::*;
use crate::db;
use rusqlite::Connection;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// 远端设备的一枚规范 HLC 原文(定长 49 = 13 位 hex 毫秒 + `-` + 8 位 hex 计数器 + `-` +
/// 26 位 device_id)。形态由 [`column_value_domains_catch_obvious_garbage`] 里那句
/// `Hlc::parse` 钉住,别手改成看起来差不多的样子。
const REMOTE_HLC: &str = "0000018e00000-00000000-RMTDEV0000000000000000000X";

fn temp_path(tag: &str) -> std::path::PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let p = crate::test_temp::dir()
        .join(format!("ys-nb-board-{tag}-{}-{}.sqlite3", std::process::id(), n));
    cleanup(&p);
    p
}

fn cleanup(p: &std::path::Path) {
    for f in [p.to_path_buf(), p.with_extension("sqlite3-wal"), p.with_extension("sqlite3-shm")] {
        let _ = std::fs::remove_file(&f);
    }
}

fn fresh_db(tag: &str) -> Connection {
    let conn = db::open(&temp_path(tag)).expect("open migrated db");
    crate::clock::Clock::load(&conn).expect("init device identity");
    conn
}

fn err_of(conn: &Connection, sql: &str) -> String {
    conn.execute(sql, []).expect_err("这句本该被拒").to_string()
}

fn trigger_sql(conn: &Connection, name: &str) -> String {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1",
        [name],
        |r| r.get(0),
    )
    .unwrap_or_else(|e| panic!("触发器 {name} 不在:{e}"))
}

fn set_marker(id: &str, value: &str) -> String {
    format!("UPDATE board_column SET tombstoned_at = {value} WHERE id = '{id}'")
}

// ---- 1) 六个种子 ---------------------------------------------------------------------

/// §14:六个 seed 行与 `SEED_COLUMNS` **完全相等**;固定 title/position/created_at。
///
/// ⭐ 这只测同时是「迁移 SQL 那份字面量」与「core 生产代码那份描述源」之间的**对拍**
/// (plan §7.1e):两份必须逐字段相等,漂一处就是六个消费面里的一个安静的洞。
#[test]
fn migration_seeds_exactly_the_six_canonical_columns() {
    let conn = fresh_db("seeds");
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM board_column", [], |r| r.get(0)).unwrap();
    assert_eq!(total, SEED_COLUMNS.len() as i64, "迁移只种这六行,不多不少");
    for seed in SEED_COLUMNS {
        let (title, kind, system, position, created_at, tomb) = conn
            .query_row(
                "SELECT title, kind, system, position, created_at, tombstoned_at \
                 FROM board_column WHERE id = ?1",
                [seed.id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .unwrap_or_else(|e| panic!("种子列 {} 不在:{e}", seed.id));
        assert_eq!(title, seed.canonical_title, "{} 的 title", seed.id);
        assert_eq!(kind, seed.kind, "{} 的 kind", seed.id);
        assert_eq!(system, i64::from(seed.system), "{} 的 system", seed.id);
        assert_eq!(position, seed.position, "{} 的 position", seed.id);
        assert_eq!(created_at, seed.created_at, "{} 的 created_at", seed.id);
        assert_eq!(tomb, None, "{} 生而无墓碑", seed.id);
        crate::frindex::validate(&position)
            .unwrap_or_else(|e| panic!("种子 {} 的 position 不是规范 frindex 键:{e}", seed.id));
    }
    // 读序 = (position, id):灵感两列在前、任务四列按流水线序在后。
    let order: Vec<String> = conn
        .prepare("SELECT id FROM board_column ORDER BY position, id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(order, SEED_COLUMNS.iter().map(|s| s.id).collect::<Vec<_>>());
    audit_seed_columns(&conn).expect("刚迁移完的库必须过种子审计");
    audit_tombstone_apply_empty(&conn).expect("授权表生而空");
}

/// 种子审计只咬**出生字段**与**系统列的全字段**,⛔ 四个 task 种子的 title/position/墓碑
/// 是用户数据,不与默认值盲比(plan §7.1a,codex 五轮推翻了「六个一律是 schema 常量」)。
#[test]
fn seed_audit_guards_birth_fields_but_leaves_task_seeds_to_the_user() {
    let conn = fresh_db("seed-audit");
    // 四个 task 种子改名 / 挪位置 = 合法用户操作,审计不该管。
    conn.execute("UPDATE board_column SET title='在做', position='b00' WHERE id='doing'", [])
        .unwrap();
    audit_seed_columns(&conn).expect("task 种子改过名/挪过位置仍然要过");
    // 系统列改名 = 库被改过(不变量 2:它永不接受任何 op)。
    conn.execute("UPDATE board_column SET title='收件箱' WHERE id='inbox'", []).unwrap();
    let err = audit_seed_columns(&conn).unwrap_err();
    assert!(err.contains("系统列") && err.contains("inbox"), "{err}");
    conn.execute("UPDATE board_column SET title='未归类' WHERE id='inbox'", []).unwrap();
    // created_at 是迁移里写死的 canonical 字面量,漂了 = 两端会分叉。
    conn.execute("UPDATE board_column SET created_at='2026-08-25T00:00:00.000Z' WHERE id='todo'", [])
        .unwrap();
    let err = audit_seed_columns(&conn).unwrap_err();
    assert!(err.contains("created_at") && err.contains("todo"), "{err}");
    conn.execute("UPDATE board_column SET created_at='2026-08-24T00:00:00.000Z' WHERE id='todo'", [])
        .unwrap();
    // 行整个不在 = 结构残缺,响亮拒(⑤ 挡着 DELETE,只能靠摘掉它造这个态)。
    conn.execute_batch("DROP TRIGGER trg_board_column_no_delete; DELETE FROM board_column WHERE id='confirming';")
        .unwrap();
    let err = audit_seed_columns(&conn).unwrap_err();
    assert!(err.contains("confirming") && err.contains("读不到"), "{err}");
}

/// 表级 CHECK 的**方向**(plan §2.3,codex 六轮 H 纠正了五轮写反的那个方向):
/// `CHECK (system = 1 OR kind = 'task')` 表达的是 **system=0 ⇒ kind='task'**,守的是
/// 「用户只能建 task 列」;它同时把 `system=1, kind='task'`(将来的「不可删的任务列」)
/// 留在门内。⛔ 写反成 `system = 0 OR kind = 'idea'` 的话,下面第一句会通过。
#[test]
fn user_columns_can_only_be_task_columns() {
    let conn = fresh_db("check-dir");
    let ins = |id: &str, kind: &str, system: i64| {
        format!(
            "INSERT INTO board_column (id, title, kind, system, position, created_at) \
             VALUES ('{id}', 'x', '{kind}', {system}, 'b00', '2026-08-24T00:00:00.000Z')"
        )
    };
    assert!(err_of(&conn, &ins("u1", "idea", 0)).contains("CHECK"), "用户列只能是 task 列");
    conn.execute(&ins("u2", "task", 0), []).expect("用户建 task 列合法");
    conn.execute(&ins("s1", "idea", 1), []).expect("system=1 + idea 合法");
    conn.execute(&ins("s2", "task", 1), []).expect("system=1 + task 合法(留给将来)");
}

/// `position` 的行内值域是**第二道**(第一道在 `frindex::validate`):只兜住明显的垃圾。
/// `tombstoned_at` 存的是 **HLC 原文**(定长 49)不是 RFC3339 —— 长度这道同样是第二道。
#[test]
fn column_value_domains_catch_obvious_garbage() {
    let conn = fresh_db("domains");
    let ins = |id: &str, pos: &str, tomb: &str| {
        format!(
            "INSERT INTO board_column (id, title, kind, system, position, created_at, tombstoned_at) \
             VALUES ('{id}', 'x', 'task', 0, '{pos}', '2026-08-24T00:00:00.000Z', {tomb})"
        )
    };
    assert!(err_of(&conn, &ins("u1", "0a", "NULL")).contains("CHECK"), "排序键头字符必须是字母");
    assert!(err_of(&conn, &ins("u2", "a-", "NULL")).contains("CHECK"), "base62 之外的字符");
    assert!(
        err_of(&conn, &ins("u3", "b00", "'2026-08-24T00:00:00.000Z'")).contains("CHECK"),
        "墓碑 marker 存 HLC 原文,RFC3339 的长度对不上"
    );
    assert_eq!(REMOTE_HLC.len(), 49);
    crate::clock::Hlc::parse(REMOTE_HLC).expect("测试常量本身得是规范 HLC");
    conn.execute(&ins("u4", "b01", &format!("'{REMOTE_HLC}'")), []).expect("合规值放行");
}

// ---- 2) 五只守护 + 一只消费者 --------------------------------------------------------

/// ⑤ 行永不物理删除(不变量 5,⛔ 不带豁免 —— 回放语境下也拒)。
///
/// ⚠ 它同时是「`board_column/tombstone` 不许复用通用的 `apply_entity_tombstone`」这条规格
/// (codex 四轮 H2)在存储层的背板:那只通用 apply 是 `DELETE FROM {table} WHERE id = ?`。
#[test]
fn column_rows_are_never_physically_deleted() {
    let conn = fresh_db("no-delete");
    assert!(err_of(&conn, "DELETE FROM board_column WHERE id='todo'").contains("只可 tombstone"));
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    assert!(
        err_of(&conn, "DELETE FROM board_column WHERE id='todo'").contains("只可 tombstone"),
        "⑤ 不带豁免:回放语境同样拒"
    );
}

/// ③ `kind`/`system` 是出生字段,永不改写(⛔ 不带豁免)。
///
/// ⚠ B-a 原文把这只写成监听 `tombstoned_at`(codex 四轮 H4:**监听错了字段 = 等于没冻结**)
/// —— 下面头两句正是那个错法会静默放过去的两句。
#[test]
fn column_birth_fields_are_frozen() {
    let conn = fresh_db("birth");
    assert!(
        err_of(&conn, "UPDATE board_column SET kind='task' WHERE id='inbox'").contains("出生字段")
    );
    assert!(
        err_of(&conn, "UPDATE board_column SET system=0 WHERE id='inbox'").contains("出生字段")
    );
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    assert!(
        err_of(&conn, "UPDATE board_column SET system=0 WHERE id='inbox'").contains("出生字段"),
        "③ 不带豁免"
    );
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    // 等值写不触发(WHEN 用 IS NOT):幂等重试不该被误伤。
    conn.execute("UPDATE board_column SET kind='idea', system=1 WHERE id='inbox'", [])
        .expect("等值 = no-op");
}

/// ④ 墓碑只能由**登记在案的那一枚 tombstone writer** 改写(八轮定形)—— **否定半边**。
///
/// ⚠ 肯定半边为什么在本版测不了,见模块头注(一)。下面 (c) 就是那句话的**字据**:
/// 一行**四格全对**的授权登记,仍然因为没有 op 背书而被拒 ⇒ 那句
/// `EXISTS (... FROM oplog ...)` 是承重的,不是装饰。
#[test]
fn tombstone_marker_needs_a_registered_writer() {
    let conn = fresh_db("tomb-auth");

    // (a) 无授权行 = 拒。
    assert!(err_of(&conn, &set_marker("todo", &format!("'{REMOTE_HLC}'")))
        .contains("登记的 tombstone writer"));

    // (b) **永不复活**:写 NULL 恒拒(任何语境;含 NULL→NULL 这种无意义写 —— 没有任何
    //     合法路径会写它,fail-fast)。且 ⛔ `sync_replay_active` **不参与** ④ 的豁免
    //     (六轮 H:那个标志不只是 board tombstone 的语境,replay / boot / epoch 都设它)。
    assert!(err_of(&conn, &set_marker("todo", "NULL")).contains("登记的 tombstone writer"));
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    assert!(
        err_of(&conn, &set_marker("todo", "NULL")).contains("登记的 tombstone writer"),
        "④ 不看回放标志"
    );
    assert!(
        err_of(&conn, &set_marker("todo", &format!("'{REMOTE_HLC}'")))
            .contains("登记的 tombstone writer"),
        "④ 不看回放标志"
    );
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();

    // (c) 授权行四格全对、方向也对,**但 oplog 里没有那枚 op** = 仍拒。
    conn.execute(
        "INSERT INTO sync_board_column_tombstone_apply (column_id, op_id, from_hlc, to_hlc, mode) \
         VALUES ('todo', '01TESTBOARDTOMBSTONE000001', NULL, ?1, 'apply_min')",
        [REMOTE_HLC],
    )
    .unwrap();
    assert!(
        err_of(&conn, &set_marker("todo", &format!("'{REMOTE_HLC}'")))
            .contains("登记的 tombstone writer"),
        "没有 op 背书的授权不算授权"
    );
    // 顺带钉住上一句的前提:B-b 的 oplog 词汇表**确实**还不认识 board_column。
    let vocab = conn.execute(
        "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
         VALUES ('01TESTBOARDTOMBSTONE000001', ?1, 'board_column', 'todo', 'tombstone', '{}', 1)",
        [REMOTE_HLC],
    );
    assert!(vocab.is_err(), "B-b 不接新词汇:board_column op 进不了 oplog(那是 B-c 的面)");

    // (d) 残留的授权行会被空表审计逮到(它的定位 = 报告残留状态,不是清理工)。
    let err = audit_tombstone_apply_empty(&conn).unwrap_err();
    assert!(err.contains("残留 1 行"), "{err}");
    conn.execute("DELETE FROM sync_board_column_tombstone_apply", []).unwrap();
    audit_tombstone_apply_empty(&conn).unwrap();
}

/// 今天这棵树上的**总账**:任何语境、任何列,marker 一个字也改不动(④ 挡着全部)。
/// 这不是缺陷,是 B-b 的定义 —— 它本就不该有能盖墓碑的路径。
#[test]
fn no_path_in_this_version_can_tombstone_a_column() {
    let conn = fresh_db("tomb-none");
    for id in SEED_COLUMNS.iter().map(|s| s.id) {
        for replaying in [false, true] {
            if replaying {
                conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
            }
            assert!(
                conn.execute(&set_marker(id, &format!("'{REMOTE_HLC}'")), []).is_err(),
                "{id}(replay={replaying})的墓碑本该盖不上"
            );
            if replaying {
                conn.execute("DELETE FROM sync_replay_active", []).unwrap();
            }
        }
    }
}

/// ① 带豁免、② 不带 —— **哪只带豁免、哪只不带是 §2.3 的全部要害**(codex 四轮 H1)。
///
/// ⚠ 这只测跑在一份**摘掉 ④** 的临时库上,理由见模块头注(二):三只 BEFORE 同时在场时
/// SQLite 不保证顺序,「报的是哪一句」不可断言,于是 ①② 的单只行为无从观测。摘掉的是
/// **测试库**里的那一只,①② 的定义仍是迁移里那两份原文。
#[test]
fn guard_one_is_replay_exempt_and_guard_two_is_not() {
    let conn = fresh_db("guards-12");
    // 结构面先钉住(摘 ④ 之前):① 的 WHEN 里有豁免,②③⑤ 没有。
    assert!(
        trigger_sql(&conn, "trg_board_column_no_tombstone_nonempty").contains("sync_replay_active"),
        "① 必须带回放豁免:不带的话远端一枚合法 tombstone 会归 InvalidOp、整条流被隔离"
    );
    for name in [
        "trg_board_column_system_no_tombstone",
        "trg_board_column_birth_immutable",
        "trg_board_column_no_delete",
    ] {
        assert!(!trigger_sql(&conn, name).contains("sync_replay_active"), "{name} ⛔ 不带豁免");
    }
    conn.execute_batch("DROP TRIGGER trg_board_column_tombstone_reject").unwrap();

    // ② 系统列不可删:两个语境都拒(不变量 2 是全局的,远端也不许违反)。
    assert!(err_of(&conn, &set_marker("inbox", &format!("'{REMOTE_HLC}'"))).contains("系统列"));
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    assert!(
        err_of(&conn, &set_marker("inbox", &format!("'{REMOTE_HLC}'"))).contains("系统列"),
        "② 不带豁免"
    );
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();

    // ① 非空列:本地拦。
    let id = crate::repo::add_item(&conn, "占位的活卡").unwrap();
    conn.execute("UPDATE items SET stage='todo', position='a0' WHERE id=?1", [&id]).unwrap();
    assert!(err_of(&conn, &set_marker("todo", &format!("'{REMOTE_HLC}'"))).contains("未归档条目"));

    // ① 回放放行 —— 合法的远端事实必须落得下去(孤儿卡的落点由 plan §4.3 定,不靠这只守护)。
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    conn.execute(&set_marker("todo", &format!("'{REMOTE_HLC}'")), []).expect("① 带豁免");
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    let marker: Option<String> = conn
        .query_row("SELECT tombstoned_at FROM board_column WHERE id='todo'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(marker.as_deref(), Some(REMOTE_HLC));
    // ⑥ 跟着这次真改写跑过一遍(AFTER):授权表本就空,消费一个不存在的行不该出错。
    audit_tombstone_apply_empty(&conn).unwrap();

    // ① 的谓词只看 live:回收站 / 归档册里的卡不算数。
    conn.execute("UPDATE board_column SET tombstoned_at=NULL WHERE id='doing'", []).unwrap();
    let id2 = crate::repo::add_item(&conn, "待回收的卡").unwrap();
    conn.execute("UPDATE items SET stage='doing', position='a0' WHERE id=?1", [&id2]).unwrap();
    assert!(err_of(&conn, &set_marker("doing", &format!("'{REMOTE_HLC}'"))).contains("未归档条目"));
    conn.execute("UPDATE items SET archived_at='2026-08-24T00:00:00Z' WHERE id=?1", [&id2]).unwrap();
    conn.execute(&set_marker("doing", &format!("'{REMOTE_HLC}'")), [])
        .expect("回收站里的卡不挡删列");
}

/// ⑥ 消费者是 **AFTER**,不是 BEFORE —— 本条对 plan §2.3 那段 SQL 的一处实现层订正。
///
/// SQLite 对同表同事件同时机的多只触发器不保证触发顺序;④ 与 ⑥ 若都是 BEFORE,⑥ 先跑
/// 就会把 ④ 要读的授权行删掉 ⇒ ④ 当场判「无授权」ABORT,**整个墓碑路径靠触发器创建顺序
/// 碰运气**。改成 AFTER 之后顺序由 SQLite 的语义定死(全部 BEFORE → 改行 → 全部 AFTER),
/// 且语义更准:**行真的改了才消费**。
///
/// ⚠ 「⑥ 真的消费了那一行」要等 B-c 的肯定半边;这里守住的是**它挂在哪个时机**这一格。
#[test]
fn consume_trigger_fires_after_not_before() {
    let conn = fresh_db("consume-after");
    assert!(
        trigger_sql(&conn, "trg_board_column_tombstone_consume")
            .contains("AFTER UPDATE OF tombstoned_at"),
        "⑥ 必须是 AFTER"
    );
    assert!(
        trigger_sql(&conn, "trg_board_column_tombstone_reject")
            .contains("BEFORE UPDATE OF tombstoned_at"),
        "④ 必须是 BEFORE —— 两只的时机分开,才是顺序确定的来源"
    );
}

// ---- 3) 两只耦合触发器 ---------------------------------------------------------------

/// 耦合谓词从 `board_column.kind` 取,不再按 stage 字面量列表判(不变量 3)。
///
/// ⭐ 承重的那一句是**用户自建的 task 列**:按旧的字面量列表判,`u1` 落不进
/// `('todo','doing','confirming','done')` ⇒ 会被当成灵感态、反过来要求 position 为 NULL。
#[test]
fn stage_kind_coupling_reads_the_column_not_a_literal_list() {
    let conn = fresh_db("coupling");
    conn.execute(
        "INSERT INTO board_column (id, title, kind, system, position, created_at) \
         VALUES ('u1', '复盘中', 'task', 0, 'b00', '2026-08-24T00:00:00.000Z')",
        [],
    )
    .unwrap();
    let dev: String =
        conn.query_row("SELECT value FROM sync_meta WHERE key='device_id'", [], |r| r.get(0))
            .unwrap();
    let ins = |id: &str, stage: &str, position: &str| {
        format!(
            "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage, born_device) \
             VALUES ('{id}', 'x', '{stage}', 't', 't', {position}, '{stage}', '{dev}')"
        )
    };
    // 自定义 task 列:必须带排序键。
    assert!(err_of(&conn, &ins("i1", "u1", "NULL")).contains("耦合"));
    conn.execute(&ins("i2", "u1", "'a0'"), []).expect("自定义 task 列 + 排序键 = 合法");
    // 灵感列:不许带排序键 / 截止 / 优先级。
    assert!(err_of(&conn, &ins("i3", "inbox", "'a0'")).contains("耦合"));
    conn.execute(&ins("i4", "inbox", "NULL"), []).unwrap();
    assert!(err_of(&conn, "UPDATE items SET due_on='2026-09-01' WHERE id='i4'").contains("耦合"));
    assert!(err_of(&conn, "UPDATE items SET priority=1 WHERE id='i4'").contains("耦合"));
    // 转待办到自定义列:stage 与 position 一起写才合法(单机路径)。
    assert!(err_of(&conn, "UPDATE items SET stage='u1' WHERE id='i4'").contains("耦合"));
    conn.execute("UPDATE items SET stage='u1', position='a1' WHERE id='i4'", []).unwrap();
}

/// 耦合触发器**必须带回放豁免**(codex 四轮纠正了 B-a 读反的那条):远端「转待办」是
/// stage 与 position **两条独立 op**,分开到达时第一条会让行短暂处于中间态。
#[test]
fn stage_kind_coupling_is_replay_exempt() {
    let conn = fresh_db("coupling-replay");
    let id = crate::repo::add_item(&conn, "灵感一条").unwrap();
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    conn.execute("UPDATE items SET stage='todo' WHERE id=?1", [&id])
        .expect("回放:stage 那条先到,position 还是 NULL —— 必须放行");
    conn.execute("UPDATE items SET position='a0' WHERE id=?1", [&id]).expect("position 随后到");
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    // 豁免只在回放语境内:标志清掉之后单机路径照拦。
    assert!(err_of(&conn, &format!("UPDATE items SET position=NULL WHERE id='{id}'"))
        .contains("耦合"));
}

/// FK:`items.stage` 指不到 `board_column` 的行一律拒(六值枚举 CHECK 的替身)。
/// ⚠ 回放豁免**不豁免外键** —— 「列还没到」那个形归 B-c 的 `DependencyMissing` 前置。
#[test]
fn item_stage_is_a_foreign_key_now() {
    let conn = fresh_db("fk");
    let dev: String =
        conn.query_row("SELECT value FROM sync_meta WHERE key='device_id'", [], |r| r.get(0))
            .unwrap();
    let sql = format!(
        "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage, born_device) \
         VALUES ('i1', 'x', 'nope', 't', 't', 'a0', 'nope', '{dev}')"
    );
    assert!(conn.execute(&sql, []).is_err(), "指不到列的 stage 必须被拒");
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    let err = conn.execute(&sql, []).unwrap_err().to_string();
    assert!(err.to_lowercase().contains("foreign key"), "回放豁免不豁免外键:{err}");
}

// ---- 4) 旧六 stage 的存量数据全链路 --------------------------------------------------

/// §8 那条**硬验收**:六旧列的存量行与历史 op 在新 schema 上原样通过。
///
/// ⚠ codex 自标这条判断是「代码路径推论,不是仓里已有的 V1 实现事实」⇒ **必须实测**。
/// 做法 = 造一个真 **v35** 库(六个 stage 各一条 + 回收站/归档册/完成时刻三根轴 + 四张
/// 子表各挂一条),记下 items 十三列的逐行指纹,前滚 v36 之后逐字对拍,再在新 schema 上
/// 把手动主线跑一遍,最后验子表 FK 的 CASCADE 仍跟着重建后的 items 走。
#[test]
fn legacy_six_stages_survive_the_rebuild_and_still_work() {
    let path = temp_path("legacy");
    let fingerprint = |conn: &Connection| -> Vec<String> {
        conn.prepare(
            "SELECT id || '|' || content || '|' || stage || '|' || created_at || '|' \
                 || updated_at || '|' || COALESCE(archived_at,'~') || '|' \
                 || COALESCE(due_on,'~') || '|' || COALESCE(priority,-1) || '|' \
                 || COALESCE(position,'~') || '|' || COALESCE(sealed_at,'~') || '|' \
                 || COALESCE(born_stage,'~') || '|' || COALESCE(done_at,'~') || '|' \
                 || COALESCE(born_device,'~') FROM items ORDER BY id",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<String>>>()
        .unwrap()
    };
    let sub_counts = |conn: &Connection| -> Vec<i64> {
        ["item_topic", "item_revisions", "item_image", "item_image_counter", "item_comment"]
            .iter()
            .map(|t| conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap())
            .collect()
    };

    let (before, ops_before, subs_before, victim) = {
        let conn = db::open_through(&path, 35).expect("造一个真 v35 库");
        let mut clock = crate::clock::Clock::load(&conn).unwrap();
        let dev = clock.device_id().to_string();
        let mut n = 0;
        let mut mk = |stage: &str, position: Option<&str>| {
            n += 1;
            let id = format!("01LEGACY0000000000000000{n:02}");
            conn.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, position, born_stage, born_device) \
                 VALUES (?1, ?2, ?3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?4, ?3, ?5)",
                rusqlite::params![id, format!("旧卡{n}"), stage, position, dev],
            )
            .unwrap();
            id
        };
        mk("inbox", None);
        let filed = mk("filed", None);
        let todo = mk("todo", Some("a0"));
        mk("doing", Some("a0"));
        mk("confirming", Some("a0"));
        let done = mk("done", Some("a0"));
        // 三根轴各占一格(都是 v35 上的合法终态)。
        conn.execute("UPDATE items SET archived_at='2026-02-01T00:00:00Z' WHERE id=?1", [&filed])
            .unwrap();
        conn.execute("UPDATE items SET done_at='2026-02-02T00:00:00Z' WHERE id=?1", [&done])
            .unwrap();
        conn.execute("UPDATE items SET sealed_at='2026-02-03T00:00:00Z' WHERE id=?1", [&done])
            .unwrap();
        // 四张子表各挂一条(FK 都指着 items,重建后必须还指得到)。
        let topic = crate::repo::insert_topic(&conn, "旧标签").unwrap();
        crate::oplog::topic_create(&conn, &mut clock, &topic).unwrap();
        conn.execute("INSERT INTO item_topic (item_id, topic_id) VALUES (?1, ?2)", [&todo, &topic])
            .unwrap();
        conn.execute("UPDATE items SET content='旧卡3改' WHERE id=?1", [&todo]).unwrap();
        conn.execute(
            "INSERT INTO item_image (id, item_id, seq, data, mime, created_at) \
             VALUES ('01LEGACYIMAGE000000000001', ?1, 1, x'0102', 'image/png', '2026-02-04T00:00:00Z')",
            [&todo],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO item_image_counter (item_id, last_seq) VALUES (?1, 1)",
            [&todo],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO item_comment (id, item_id, content, created_at, born_device) \
             VALUES ('01LEGACYCOMMENT00000000001', ?1, '旧留言', '2026-02-04T00:00:00.000Z', ?2)",
            [&todo, &dev],
        )
        .unwrap();
        let ops: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        (fingerprint(&conn), ops, sub_counts(&conn), todo)
    };

    // ---- 前滚 v35 → v36 ----
    let mut conn = db::open(&path).expect("v35 库必须能前滚到当前版");
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(),
        db::SCHEMA_VERSION
    );
    assert_eq!(fingerprint(&conn), before, "items 十三列逐行原样(⛔ 别照 0021 抄列清单)");
    let ops: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
    assert_eq!(ops, ops_before, "oplog 是史实,重建 items 不许动它");
    assert_eq!(sub_counts(&conn), subs_before, "五张子表一条不少(DROP TABLE 时外键是关着的)");
    let ok: String = conn.pragma_query_value(None, "integrity_check", |r| r.get(0)).unwrap();
    assert_eq!(ok, "ok");
    let fk: Option<String> = {
        use rusqlite::OptionalExtension;
        conn.query_row("PRAGMA foreign_key_check", [], |r| r.get(0)).optional().unwrap()
    };
    assert_eq!(fk, None, "重建后无外键违例");
    audit_seed_columns(&conn).expect("前滚出来的库同样要过种子审计");
    // 索引与触发器都还回来了(名字点到为止:行为由本文件其余各只与既有回归网守)。
    let triggers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='items'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(triggers, 13, "0022 的 12 只 + 0030 的 1 只 + born_device 两只 - 合并掉的 2 只");

    // ---- 新 schema 上把手动主线跑一遍 ----
    let mut clock = crate::clock::Clock::load(&conn).unwrap();
    let id = crate::notes::capture(&mut conn, &mut clock, "迁移后的新卡").expect("捕获");
    crate::notes::promote_to_task(&mut conn, &mut clock, &id, "迁移后的新卡").expect("转待办");
    crate::task::transition(&mut conn, &mut clock, &id, "doing").expect("todo → doing");
    crate::task::transition(&mut conn, &mut clock, &id, "done").expect("doing → done");
    crate::task::seal(&mut conn, &mut clock, &id).expect("入成就册");
    crate::task::unseal(&mut conn, &mut clock, &id).expect("取消归档");
    crate::task::transition(&mut conn, &mut clock, &id, "todo").expect("done → todo");
    crate::notes::revert_task_to_inbox(&mut conn, &mut clock, &id).expect("撤回为灵感");
    crate::notes::archive(&mut conn, &mut clock, &id).expect("进回收站");
    crate::notes::restore(&mut conn, &mut clock, &id).expect("从回收站还原");

    // ---- 子表 FK 仍然是 CASCADE(RENAME 之后按名指向新表) ----
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    conn.execute("DELETE FROM items WHERE id=?1", [&victim]).unwrap();
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();
    for t in ["item_topic", "item_revisions", "item_image", "item_image_counter", "item_comment"] {
        let left: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {t} WHERE item_id = ?1"), [&victim], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(left, 0, "{t} 的 FK CASCADE 必须跟着重建后的 items 走");
    }
    drop(conn);
    cleanup(&path);
}

/// ⭐ **整表重建的还原清单:逐条逐字节对拍 v35 与 v36**(§7.2「要还回的东西比 B-a 列的
/// 多得多」那张表的**可执行形**)。
///
/// 判例(本轮真栽的):plan §7.2 那张清单数了 0022 / 0030 / 0033 / 0034,**漏了 0025**
/// —— 而 0025 正是把 `trg_item_no_insert_sealed` 与 `trg_item_born_stage_required`
/// DROP 后重建、给它们补上引导豁免的那条。首版照清单抄,boot 那一族当场 8 只红:
/// 「导入 items 失败:新条目必须如实记录出生态」。
///
/// ⇒ **整表重建的还原清单不能照计划书数,只能照真库 `sqlite_master` 抄。** 这只测把那次
/// 对拍固化下来:除了「这一笔本来就要改的那几处」,`tbl_name='items'` 的每一个 schema
/// 对象都必须**逐字节相同**。将来任何一条再重建 items 的迁移,把它的期望差异填进
/// `EXPECTED_GONE` / `EXPECTED_NEW` 即可,别放宽比对。
#[test]
fn items_schema_survives_the_rebuild_byte_for_byte() {
    /// 本笔**故意**去掉的:0022 那 4 只按 stage 字面量列表判的耦合触发器,合并成 2 只。
    const EXPECTED_GONE: &[&str] = &[
        "trg_item_stage_position_coupled_insert",
        "trg_item_stage_position_coupled_update",
        "trg_item_idea_no_task_attrs_insert",
        "trg_item_idea_no_task_attrs_update",
    ];
    /// 本笔**故意**新增的:改按 `board_column.kind` 判的那 2 只。
    const EXPECTED_NEW: &[&str] =
        &["trg_item_stage_kind_coupling_insert", "trg_item_stage_kind_coupling_update"];

    let objects = |conn: &Connection| -> std::collections::BTreeMap<String, (String, String)> {
        conn.prepare(
            "SELECT name, type, COALESCE(sql, '') FROM sqlite_master WHERE tbl_name = 'items'",
        )
        .unwrap()
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, (r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    };

    let path = temp_path("schema-parity");
    let before = {
        let conn = db::open_through(&path, 35).expect("停在 v35");
        objects(&conn)
    };
    let conn = db::open(&path).expect("前滚到当前版");
    let after = objects(&conn);

    // ① 名字集合:恰好是「旧的 − 故意删的 + 故意加的」。
    let mut expect_names: std::collections::BTreeSet<&str> =
        before.keys().map(String::as_str).collect();
    for n in EXPECTED_GONE {
        assert!(expect_names.remove(n), "{n} 在 v35 上就不存在?清单写错了");
    }
    for n in EXPECTED_NEW {
        assert!(expect_names.insert(n), "{n} 在 v35 上已存在?清单写错了");
    }
    let got_names: std::collections::BTreeSet<&str> = after.keys().map(String::as_str).collect();
    assert_eq!(got_names, expect_names, "items 上的 schema 对象只许有清单里那几处差异");

    // ② 留下来的每一只:**逐字节**相同(表本身除外,它正是这一笔要改的那个)。
    for (name, (kind, sql)) in &before {
        if EXPECTED_GONE.contains(&name.as_str()) || kind == "table" {
            continue;
        }
        assert_eq!(
            &after[name].1, sql,
            "{name}({kind})重建后与 v35 不逐字相同 —— 照真库抄,别照计划书数"
        );
    }

    // ③ 表本身:只许差在 stage 那一格。
    let (old_ddl, new_ddl) = (&before["items"].1, &after["items"].1);
    assert!(old_ddl.contains("CHECK (stage IN ("), "v35 上 stage 本该是六值枚举");
    assert!(!new_ddl.contains("stage IN ("), "六值枚举 CHECK 必须整个消失");
    assert!(new_ddl.contains("REFERENCES board_column(id)"), "stage 必须成为外键");
    // 其余每一列与每一条行内 CHECK 原样(逐条点名,别只数列数)。
    for keep in [
        "id          TEXT PRIMARY KEY",
        "content     TEXT NOT NULL",
        "created_at  TEXT NOT NULL",
        "updated_at  TEXT NOT NULL",
        "archived_at TEXT",
        "due_on      TEXT CHECK (due_on IS NULL OR (date(due_on) IS NOT NULL AND date(due_on) = due_on))",
        "priority    INTEGER CHECK (priority IS NULL OR priority IN (1, 2, 3))",
        "position    TEXT CHECK (position IS NULL OR (position GLOB '[A-Za-z]*' AND NOT (position GLOB '*[^0-9A-Za-z]*')))",
        "sealed_at   TEXT",
        "born_stage  TEXT",
        "done_at",
        "born_device",
    ] {
        assert!(new_ddl.contains(keep), "重建丢了「{keep}」—— 0030 的 done_at 与 0033 的 born_device 正是照 0021 抄会丢的那两列");
    }
    drop(conn);
    cleanup(&path);
}
