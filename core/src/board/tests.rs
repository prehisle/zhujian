//! 迁移 0036 的行为锚(board-columns-plan §14 那张「B-b 必查表」里落在第 1 段的格子)。
//!
//! 分四组:
//! 1. **六个种子行与 [`SEED_COLUMNS`] 完全相等**(§14 第三行)+ 表级 CHECK 的方向;
//! 2. **五只守护 + 一只消费者**逐只的行为;
//! 3. **两只耦合触发器**:单机路径照拦、回放语境放行中间态;
//! 4. **旧六 stage 的存量数据全链路**(§8 那条「硬验收」与 §14 第八行)。
//!
//! # ⚠ 诚实边界,别当成漏测
//!
//! **(一)④ 的肯定半边 0037 起补齐了**(B-c 第 1 段):476 那版的 oplog 词汇表还不认识
//! `board_column` ⇒ 库里造不出那种 op ⇒ ④ 里那句 `EXISTS (... FROM oplog ...)` 恒假 ⇒
//! 每一条 marker 改写都会被拒,于是首次盖 / 并发取 min / `epoch_rebase` / 等值 no-op
//! 那四格当时**测不了**(plan §14 第六行把它们挪给了 B-c)。现在它们住在
//! [`the_marker_takes_the_smaller_hlc_and_epoch_rebase_is_the_only_way_up`],
//! 而 [`tombstone_marker_needs_a_registered_writer`] 的 (c)/(c′) 两句正是那句
//! `EXISTS` 承重的字据 —— 前后只差一枚 op,同一条 UPDATE 从拒变成过。
//! ⚠ 本节的夹具**刻意绕开 `replay::apply_remote_op` 直接种 op**:验的是触发器自己的真值表,
//! 把 apply 层夹在中间就分不清是谁拒的(清单 13)。apply 层的行为在 `replay::tests`。
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

/// 一枚合法 ULID 形态的 op_id(④ 要求授权绑到**具体那一枚日志事实**上)。
const TOMB_OP_ID: &str = "01TESTBOARDTOMBSTONE000001";

/// 直接往 oplog 里种一枚 `board_column/tombstone`(0037 起词汇表认它)。
///
/// ⚠ 这是**存储层**的夹具,刻意绕开 `replay::apply_remote_op` —— 本节验的是 ④ 那只触发器
/// 自己的真值表,把 apply 层夹在中间就分不清「是谁拒的」(清单 13:先数这条路上有几把尺)。
/// apply 层的行为另在 `replay::tests` 里验。
fn plant_tombstone_op(conn: &Connection, op_id: &str, column_id: &str, hlc: &str) {
    // `origin` 是从 hlc 第 24 字符起派生的生成列,`(origin, origin_seq)` 有 UNIQUE ——
    // 夹具按调用序发号即可(连续性是收端引擎的喂入契约,不是本节要验的东西)。
    static SEQ: AtomicU32 = AtomicU32::new(1);
    conn.execute(
        "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
         VALUES (?1, ?2, 'board_column', ?3, 'tombstone', '{}', ?4)",
        (op_id, hlc, column_id, SEQ.fetch_add(1, Ordering::SeqCst)),
    )
    .expect("0037 起 board_column 已在 oplog 词汇表内");
}

fn authorize(
    conn: &Connection,
    column_id: &str,
    op_id: &str,
    from: Option<&str>,
    to: &str,
    mode: &str,
) {
    conn.execute(
        "INSERT INTO sync_board_column_tombstone_apply \
             (column_id, op_id, from_hlc, to_hlc, mode) VALUES (?1, ?2, ?3, ?4, ?5)",
        (column_id, op_id, from, to, mode),
    )
    .expect("登记授权行");
}

fn marker_of(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT tombstoned_at FROM board_column WHERE id = ?1", [id], |r| r.get(0))
        .expect("列在")
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
         VALUES ('todo', ?1, NULL, ?2, 'apply_min')",
        [TOMB_OP_ID, REMOTE_HLC],
    )
    .unwrap();
    assert!(
        err_of(&conn, &set_marker("todo", &format!("'{REMOTE_HLC}'")))
            .contains("登记的 tombstone writer"),
        "没有 op 背书的授权不算授权"
    );

    // (c′) ⭐ **那句 `EXISTS (… FROM oplog …)` 是承重的**:上一句与下一句之间**只多了
    //      一枚 op**,同一条 UPDATE 就从「拒」变成「过」。
    //      ⚠ 476 那版这里断的是反面(「B-b 不接新词汇 ⇒ 这枚 op 进不了 oplog」),那是当时
    //      「④ 的肯定半边结构上不可达」这句话的字据;0037 接上词汇之后,那一格自然翻面 ——
    //      **这只测的红正是 B-c 生效的证明**,不是回归。
    plant_tombstone_op(&conn, TOMB_OP_ID, "todo", REMOTE_HLC);
    conn.execute(&set_marker("todo", &format!("'{REMOTE_HLC}'")), []).expect("有 op 背书就该过");
    assert_eq!(marker_of(&conn, "todo").as_deref(), Some(REMOTE_HLC));

    // (d) ⑥ 是 **AFTER 触发器**,行真的改了就当场把授权行消费掉 ⇒ 空表审计恒绿。
    //     ⛔ 它不是「防止第二枚正常 op 重复授权」的机制(八轮把定位改准了),那件事由
    //     ⑥ 做掉;这道审计只负责发现实现 bug、报告残留状态、在电池上 fail-closed。
    audit_tombstone_apply_empty(&conn).expect("⑥ 应已当场消费授权行");
}

/// ④ 的**肯定半边**(§14 第六行,476 从 B-b 挪来 —— 那一版的库里造不出 board_column op)。
///
/// 四格:**首次盖墓碑**已在上一只测里;这里是**并发取 min**、**等值 no-op**、
/// **`epoch_rebase` 向上改写**,外加**错 mode / 错 op_id** 两条阴面。
#[test]
fn the_marker_takes_the_smaller_hlc_and_epoch_rebase_is_the_only_way_up() {
    let conn = fresh_db("tomb-min");
    // 造三枚 HLC,字典序 早 < 中 < 晚(HLC 编码的字典序就是逻辑序)。
    let early = "0000018e00000-00000000-RMTDEV0000000000000000000A";
    let mid = REMOTE_HLC;
    let late = "0000018f00000-00000000-RMTDEV0000000000000000000Z";

    // 首次盖:NULL → mid。
    plant_tombstone_op(&conn, "01TESTBOARDTOMB0000000MID", "todo", mid);
    authorize(&conn, "todo", "01TESTBOARDTOMB0000000MID", None, mid, "apply_min");
    conn.execute(&set_marker("todo", &format!("'{mid}'")), []).expect("首次盖墓碑");

    // 并发取 min:更小的那枚赢(**HLC 全序的小,不是网络先到**)。
    plant_tombstone_op(&conn, "01TESTBOARDTOMB000000EARLY", "todo", early);
    authorize(&conn, "todo", "01TESTBOARDTOMB000000EARLY", Some(mid), early, "apply_min");
    conn.execute(&set_marker("todo", &format!("'{early}'")), []).expect("min 收敛");
    assert_eq!(marker_of(&conn, "todo").as_deref(), Some(early));

    // ⛔ `apply_min` 不许向上改写(方向那一格由 mode 定,不由 from/to 的值自己说了算)。
    plant_tombstone_op(&conn, "01TESTBOARDTOMB0000000LATE", "todo", late);
    authorize(&conn, "todo", "01TESTBOARDTOMB0000000LATE", Some(early), late, "apply_min");
    assert!(
        err_of(&conn, &set_marker("todo", &format!("'{late}'")))
            .contains("登记的 tombstone writer"),
        "apply_min 只许 NULL→X 或向小改写"
    );
    conn.execute("DELETE FROM sync_board_column_tombstone_apply", []).unwrap();

    // ⭐ **`epoch_rebase` 是唯一能向上改写的契约**(压实给基线 tombstone 重新取了 HLC,
    //    §7.1c 定形 (a):marker 是可重写的派生元数据)。
    authorize(&conn, "todo", "01TESTBOARDTOMB0000000LATE", Some(early), late, "epoch_rebase");
    conn.execute(&set_marker("todo", &format!("'{late}'")), []).expect("epoch_rebase 向上");
    assert_eq!(marker_of(&conn, "todo").as_deref(), Some(late));

    // 等值 = **no-op 放行**,不 ABORT(七轮 M:「本地只做 NULL→HLC」是规格推论不是实现
    // 事实,幂等重试会被误伤)。⚠ 此刻授权表是空的 —— 等值那一臂根本不查它。
    audit_tombstone_apply_empty(&conn).expect("上一句的授权行已被 ⑥ 消费");
    conn.execute(&set_marker("todo", &format!("'{late}'")), []).expect("等值 = no-op");

    // 阴面:mode 与 op_id 各错一格,其余全对 —— 都得拒。
    // ⚠ 每枚 op 各用一枚**独有**的 HLC:`idx_oplog_hlc` 是 UNIQUE,复用会撞在夹具上、
    //   让这几格红得不是它该红的理由(清单 13)。
    let d1 = "0000018e00001-00000000-RMTDEV0000000000000000000A";
    let d2 = "0000018e00002-00000000-RMTDEV0000000000000000000A";
    plant_tombstone_op(&conn, "01TESTBOARDTOMB00000WRONG1", "doing", d1);
    authorize(&conn, "doing", "01TESTBOARDTOMB00000WRONG1", None, d1, "epoch_rebase");
    assert!(
        err_of(&conn, &set_marker("doing", &format!("'{d1}'")))
            .contains("登记的 tombstone writer"),
        "epoch_rebase 要求 to > from,首次盖(from=NULL)不属于它"
    );
    conn.execute("DELETE FROM sync_board_column_tombstone_apply", []).unwrap();
    // op_id 指向一枚**存在但不是这一列**的 op:四格全对也不算授权。
    plant_tombstone_op(&conn, "01TESTBOARDTOMB00000WRONG2", "confirming", d2);
    authorize(&conn, "doing", "01TESTBOARDTOMB00000WRONG2", None, d2, "apply_min");
    assert!(
        err_of(&conn, &set_marker("doing", &format!("'{d2}'")))
            .contains("登记的 tombstone writer"),
        "op_id 必须绑到**这一列**的那一枚日志事实上"
    );
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
    crate::task::transition(&mut conn, &mut clock, &id, "doing", &crate::board::gate::DETACHED).expect("todo → doing");
    crate::task::transition(&mut conn, &mut clock, &id, "done", &crate::board::gate::DETACHED).expect("doing → done");
    crate::task::seal(&mut conn, &mut clock, &id).expect("入成就册");
    crate::task::unseal(&mut conn, &mut clock, &id).expect("取消归档");
    crate::task::transition(&mut conn, &mut clock, &id, "todo", &crate::board::gate::DETACHED).expect("done → todo");
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

// ---- 5) read model 与「什么是任务态」的唯一判据(B-b 第 2 段) -------------------------

/// 在库里直接种一个用户建的任务列。
///
/// ⚠ **直插是本版唯一的造法**:建列命令要发 `board_column/create` op,而 oplog 的词汇表
/// 归 B-c(plan §11 的排序问题按出路 ① 定)⇒ 此刻造不出那枚 op。故这些行是**无 create
/// 背书**的 —— B-c 的 `count_unbacked_rows` 会认得它们,本段的读模型与耦合判据不看背书。
fn plant_user_column(conn: &Connection, id: &str, title: &str, position: &str) {
    conn.execute(
        "INSERT INTO board_column (id, title, kind, system, position, created_at) \
         VALUES (?1, ?2, 'task', 0, ?3, '2026-08-24T00:00:00.000Z')",
        [id, title, position],
    )
    .expect("用户建的 task 列");
}

/// 给一列盖上墓碑。**绕开 ④** —— 本版盖不上(见模块头注(一));而「远端一枚合法
/// tombstone 到了」是 §4.3 明确要支持的形,读模型与目标列判据都得答得出。
///
/// ⚠ 同时开着回放语境:① 非空列不许删**带豁免**,正是为这条路留的
/// (本地拦、合法的远端事实放行,§2.3)。
fn plant_tombstone(conn: &Connection, id: &str) {
    conn.execute_batch("DROP TRIGGER IF EXISTS trg_board_column_tombstone_reject").unwrap();
    conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
    conn.execute(&set_marker(id, &format!("'{REMOTE_HLC}'")), []).expect("远端墓碑落地");
    conn.execute("DELETE FROM sync_replay_active", []).unwrap();
}

/// read model 的三格:读序 `(position, id)`、**含已删列**、`live_items` 只数活的。
#[test]
fn read_model_lists_every_column_in_key_order_with_live_counts() {
    let mut conn = fresh_db("read-model");
    let ids = |conn: &Connection| -> Vec<String> {
        list_columns(conn).unwrap().into_iter().map(|c| c.id).collect()
    };
    assert_eq!(
        ids(&conn),
        ["inbox", "filed", "todo", "doing", "confirming", "done"],
        "读序 = position 升序(a0..a5),⛔ 别按 id 或插入序"
    );
    for c in list_columns(&conn).unwrap() {
        assert_eq!(c.live_items, 0, "新库每列都是空的");
        assert!(!c.deleted);
        assert_eq!(c.system, c.kind == "idea", "今天恰是灵感两列 = 系统列");
    }

    // 新列按 position 插进序列中间(b00 在 a5 之后;a15 在 a1 与 a2 之间)。
    plant_user_column(&conn, "u_tail", "验收中", "b00");
    plant_user_column(&conn, "u_mid", "插队", "a15");
    assert_eq!(
        ids(&conn),
        ["inbox", "filed", "u_mid", "todo", "doing", "confirming", "done", "u_tail"]
    );

    // live_items:回收站与成就归档里的都不算(那两根轴上的卡不在看板上)。
    let mut clock = crate::clock::Clock::load(&conn).unwrap();
    let idea = crate::notes::capture(&mut conn, &mut clock, "一条灵感").unwrap();
    let t1 = crate::task::create(&mut conn, &mut clock, "活的", None, None, None).unwrap();
    let t2 = crate::task::create(&mut conn, &mut clock, "要进回收站的", None, None, None).unwrap();
    let t3 = crate::task::create(&mut conn, &mut clock, "要进成就册的", None, None, None).unwrap();
    crate::task::archive(&mut conn, &mut clock, &t2).unwrap();
    crate::task::transition(&mut conn, &mut clock, &t3, "done", &crate::board::gate::DETACHED).unwrap();
    crate::task::seal(&mut conn, &mut clock, &t3).unwrap();
    let by_id: std::collections::HashMap<String, i64> =
        list_columns(&conn).unwrap().into_iter().map(|c| (c.id, c.live_items)).collect();
    assert_eq!(by_id["inbox"], 1, "{idea} 在未归类");
    assert_eq!(by_id["todo"], 1, "{t1} 活着;{t2} 进了回收站、{t3} 进了成就册,都不算");
    assert_eq!(by_id["done"], 0);
}

/// §7.1d:`is_title_overridden` 是**终态判据**,不是「查 oplog 有没有改过名」。
///
/// ⭐ 判据选型的要害就在**改回默认名**那一格:历史判据(有没有 `set_field{title}` 背书)
/// 会答「改过」,而压实还会 DROP 掉旧 oplog 让它连历史都读不到(§7.1d,同 `born_device`
/// 那条判例)。终态判据两边都答得准。
#[test]
fn title_override_is_a_terminal_judgement_so_renaming_back_clears_it() {
    let conn = fresh_db("title-override");
    let overridden = |conn: &Connection, id: &str| -> bool {
        list_columns(conn).unwrap().into_iter().find(|c| c.id == id).unwrap().is_title_overridden
    };
    for seed in SEED_COLUMNS {
        assert!(!overridden(&conn, seed.id), "{} 出厂就是 canonical 名", seed.id);
    }

    let rename = |title: &str| {
        conn.execute("UPDATE board_column SET title = ?1 WHERE id = 'todo'", [title]).unwrap();
    };
    rename("我的待办");
    assert!(overridden(&conn, "todo"), "改过名 ⇒ 显示同步来的那份");
    rename("待办");
    assert!(
        !overridden(&conn, "todo"),
        "改回 canonical ⇒ 回到「按 id 查本端字典」——⛔ 别改成查历史"
    );

    plant_user_column(&conn, "u1", "待办", "b00");
    assert!(
        overridden(&conn, "u1"),
        "用户建的列没有 canonical 可比,哪怕名字与某个种子撞了也只能照显"
    );
}

/// 不变量 3:「这一行是不是任务」只由列的 `kind` 说了算 —— 一个**自定义** task 列上的卡,
/// 全部任务面(看板 / CAS / 归档 / 统计轴)都要认得它,灵感面都不许收它。
///
/// ⚠ 这只测的样本坐标**只有 kind 判据答得出**(首版自检清单 13):`u_task` 是个 ULID 形的
/// 新 id,六值字面量那版会把它当灵感 ⇒ 一旦有人把 `TASK_STAGES` 改回字面量,这里必红。
#[test]
fn taskness_is_read_from_the_column_kind_not_a_literal_list() {
    let mut conn = fresh_db("taskness");
    plant_user_column(&conn, "01USERCOLUMN00000000000001", "验收中", "a45");
    let col = "01USERCOLUMN00000000000001";
    assert!(is_live_task_column(&conn, col).unwrap());
    assert!(!is_live_task_column(&conn, "inbox").unwrap(), "灵感列不是拖拽落点");
    assert!(!is_live_task_column(&conn, "01NOSUCHCOLUMN0000000001").unwrap(), "没有的列不是落点");

    let mut clock = crate::clock::Clock::load(&conn).unwrap();
    let id = crate::task::create(&mut conn, &mut clock, "拖进自定义列", None, None, None).unwrap();
    crate::task::transition(&mut conn, &mut clock, &id, col, &crate::board::gate::DETACHED).expect("todo → 自定义列");

    assert_eq!(crate::repo::active_task_stage(&conn, &id).unwrap().as_deref(), Some(col));
    assert_eq!(crate::repo::column_task_ids(&conn, col).unwrap(), vec![id.clone()]);
    let board = crate::repo::list_tasks(&conn).unwrap();
    assert_eq!(board.len(), 1, "看板读得到它");
    assert_eq!(board[0].stage, col);
    assert!(crate::repo::live_ideas(&conn).unwrap().is_empty(), "⛔ 不许漏进灵感视图");
    let position: Option<String> = conn
        .query_row("SELECT position FROM items WHERE id = ?1", [&id], |r| r.get(0))
        .unwrap();
    assert!(position.is_some(), "任务列必须有排序键(不变量 3,耦合触发器守)");

    // 回收站也走同一条轴:任务的回收站与灵感的回收站是两个面。
    crate::task::archive(&mut conn, &mut clock, &id).unwrap();
    assert_eq!(crate::repo::archived_tasks(&conn).unwrap().len(), 1);
    assert!(crate::repo::idea_trash(&conn).unwrap().is_empty());
}

/// §4.3 已删的列 = **只读收容区**:卡还在、还算任务,但只出不进。
///
/// ⚠ 三条断言各由**不同**的一句话决定(清单 13):`deleted` 由读模型算、
/// 「进不去」由 `is_live_task_column` 那句 `!deleted` 决定、「还算任务」由
/// `TASK_COLUMN_IDS` **不带** `tombstoned_at` 条件决定 —— 后者要是被人「顺手补严」,
/// 卡会当场从看板与回收站里一起消失。
#[test]
fn a_deleted_column_is_a_read_only_containment_area() {
    let mut conn = fresh_db("deleted-col");
    let col = "01USERCOLUMN00000000000002";
    plant_user_column(&conn, col, "要被删的列", "a45");
    let mut clock = crate::clock::Clock::load(&conn).unwrap();
    let inside = crate::task::create(&mut conn, &mut clock, "留在收容区的卡", None, None, None)
        .unwrap();
    crate::task::transition(&mut conn, &mut clock, &inside, col, &crate::board::gate::DETACHED).unwrap();
    plant_tombstone(&conn, col);

    let row = list_columns(&conn).unwrap().into_iter().find(|c| c.id == col).unwrap();
    assert!(row.deleted, "读模型要报出「已删」");
    assert_eq!(row.live_items, 1, "「已删除的列(N)」的那个 N");
    assert!(!is_live_task_column(&conn, col).unwrap(), "已删的列不再是合法落点");

    // 还算任务:看板读得到、CAS 认得它的当前列。
    assert_eq!(crate::repo::list_tasks(&conn).unwrap().len(), 1);
    assert_eq!(crate::repo::active_task_stage(&conn, &inside).unwrap().as_deref(), Some(col));

    // 只出不进。⚠ 排序那条路的样本**只有 ⓪ 那道闸拒得掉**(清单 13):基准列表给的是
    // 收容区此刻的真实顺序、新序也是一次合法的单卡拖动 ⇒ 后面「看板已变化」「一次只移一张」
    // 那几把尺全都放行,唯一拦得住它的就是「目标列不是活的任务列」。
    let outside = crate::task::create(&mut conn, &mut clock, "外面的卡", None, None, None).unwrap();
    let err = crate::task::transition(&mut conn, &mut clock, &outside, col, &crate::board::gate::DETACHED).unwrap_err();
    assert!(err.contains("非法的状态流转"), "拖不进去:{err}");
    let err = crate::task::reorder(
        &mut conn,
        &mut clock,
        &outside,
        "todo",
        col,
        &[inside.clone()],
        &[inside.clone(), outside.clone()],
        &crate::board::gate::DETACHED,
    )
    .unwrap_err();
    assert!(err.contains("非法的目标列"), "拖不进去(排序那条路):{err}");
    crate::task::transition(&mut conn, &mut clock, &inside, "todo", &crate::board::gate::DETACHED).expect("卡拖得出来");
    assert_eq!(list_columns(&conn).unwrap().into_iter().find(|c| c.id == col).unwrap().live_items, 0);
}

// ============ 写命令面(B-c 第 3 段,480)==============================================
//
// ⚠ 上面那几组验的是**存储层**(触发器的真值表),这一组验的是**命令层**:
// 谁拒、拒的理由、发了几枚什么形状的 op。两层刻意不互相代答(清单 13)。

/// 一把可写的库:命令面要 `&mut Connection` + `&mut Clock`。
fn fresh_rw(tag: &str) -> (Connection, crate::clock::Clock) {
    let conn = db::open(&temp_path(tag)).expect("open migrated db");
    let clock = crate::clock::Clock::load(&conn).expect("init device identity");
    (conn, clock)
}

fn ops_of(conn: &Connection, id: &str) -> Vec<crate::oplog::Op> {
    crate::oplog::ops_for(conn, "board_column", id)
}

fn row_of(conn: &Connection, id: &str) -> BoardColumnRow {
    list_columns(conn)
        .expect("list_columns")
        .into_iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("列 {id} 不在读模型里"))
}

/// 把本地刚发的那一枚 op 送去过**收端**那把 shape 尺。
///
/// ⭐ 这是本组最要紧的一句:本地命令发出去的 op 若过不了 shape,红的地方在**对端**
/// (`InvalidOp` = per-origin 持久隔离,plan §4.0),本机一切正常 —— 那种缺陷本地测
/// 一辈子也照不出来。⇒ 每条写命令都要在这儿把自己的产物过一遍。
fn wire_shape_ok(op: &crate::oplog::Op, id: &str) {
    crate::replay::validate_op_shape(&crate::replay::RemoteOp {
        op_id: op.op_id.clone(),
        hlc: op.hlc.clone(),
        entity: "board_column".to_string(),
        entity_id: id.to_string(),
        kind: op.kind.clone(),
        payload: op.payload.clone(),
        origin_seq: 1,
    })
    .unwrap_or_else(|e| panic!("本地发的 {} op 过不了收端 shape:{e:?}", op.kind));
}

#[test]
fn a_new_column_lands_at_the_end_and_its_op_is_something_the_far_end_can_take() {
    let (mut conn, mut clock) = fresh_rw("create-col");
    let before: Vec<String> = list_columns(&conn).unwrap().into_iter().map(|c| c.position).collect();
    let id = create_column(&mut conn, &mut clock, "  下周  ", &crate::board::gate::DETACHED).expect("建列");

    // id 过的是**收端那把严尺**(首字符 ≤ '7'),不是 clock 那把松的。
    assert!(crate::replay::is_new_column_id(&id), "列 id 必须是 26 位严格 ULID:{id}");
    let row = row_of(&conn, &id);
    assert_eq!((row.title.as_str(), row.kind.as_str(), row.system), ("下周", "task", false), "标题 trim 过、恒是可删的 task 列");
    assert!(row.deletable && !row.deleted && row.live_items == 0);
    assert!(row.is_title_overridden, "用户建的列没有 canonical 可比,恒照显");
    assert!(before.iter().all(|p| *p < row.position), "新列落在全部既有列的末键之后:{:?} vs {}", before, row.position);
    // 读序:新列排最后。
    assert_eq!(list_columns(&conn).unwrap().last().unwrap().id, id);

    let ops = ops_of(&conn, &id);
    assert_eq!(ops.len(), 1, "建列恰发一枚 op");
    assert_eq!(ops[0].kind, "create");
    assert_eq!(
        ops[0].payload,
        serde_json::json!({
            "title": "下周", "kind": "task", "system": false,
            "position": row.position, "created_at": ops[0].payload["created_at"],
        }),
        "payload 恰五键、读行发声;⚠ system 是 JSON **布尔**不是 0/1(库里那列是 INTEGER)"
    );
    wire_shape_ok(&ops[0], &id);

    // 空标题拒(trim 之后)。
    assert!(create_column(&mut conn, &mut clock, "   ", &crate::board::gate::DETACHED).unwrap_err().contains("不能为空"));
}

#[test]
fn renaming_and_reordering_emit_one_lww_set_field_each_and_refuse_the_idea_columns() {
    let (mut conn, mut clock) = fresh_rw("rename-col");
    let id = create_column(&mut conn, &mut clock, "甲", &crate::board::gate::DETACHED).unwrap();

    rename_column(&mut conn, &mut clock, &id, " 乙 ", &crate::board::gate::DETACHED).expect("改名");
    assert_eq!(row_of(&conn, &id).title, "乙");
    // 拖到 `todo` 之前(prev=None,next=todo)。
    reorder_column(&mut conn, &mut clock, &id, None, Some("todo"), &crate::board::gate::DETACHED).expect("排序");
    let key = row_of(&conn, &id).position;
    assert!(key < row_of(&conn, "todo").position, "落在 todo 之前:{key}");

    let ops = ops_of(&conn, &id);
    assert_eq!(ops.len(), 3, "create + title + position,一次改动一枚");
    assert_eq!(ops[1].payload, serde_json::json!({"field": "title", "value": "乙"}));
    assert_eq!(ops[2].payload, serde_json::json!({"field": "position", "value": key}));
    for op in &ops {
        wire_shape_ok(op, &id);
    }

    // 系统列(灵感两列):改名与排序**一起**禁(不变量 2),⛔ 与「不可删」是两根轴。
    for sys in ["inbox", "filed"] {
        assert!(rename_column(&mut conn, &mut clock, sys, "别的名", &crate::board::gate::DETACHED).unwrap_err().contains("系统列"));
        assert!(reorder_column(&mut conn, &mut clock, sys, None, Some("todo"), &crate::board::gate::DETACHED).unwrap_err().contains("系统列"));
        assert!(ops_of(&conn, sys).is_empty(), "系统列身上一枚 op 都不许有");
    }
    // 指名的邻居必须有行 —— ⛔ 别把它当开边界(那会静默错排到列端)。
    let err = reorder_column(&mut conn, &mut clock, &id, None, Some("没这一列"), &crate::board::gate::DETACHED).unwrap_err();
    assert!(err.contains("已不存在"), "{err}");
}

#[test]
fn deleting_a_column_keeps_the_row_consumes_its_grant_and_refuses_a_second_go() {
    let (mut conn, mut clock) = fresh_rw("delete-col");
    let id = create_column(&mut conn, &mut clock, "临时", &crate::board::gate::DETACHED).unwrap();
    delete_column(&mut conn, &mut clock, &id, &crate::board::gate::DETACHED).expect("空列删得掉");

    let row = row_of(&conn, &id);
    assert!(row.deleted, "行还在,只是盖了墓碑(不变量 5)");
    let ops = ops_of(&conn, &id);
    assert_eq!(ops.last().unwrap().kind, "tombstone");
    assert_eq!(ops.last().unwrap().payload, serde_json::json!({}), "payload 恰零键");
    wire_shape_ok(ops.last().unwrap(), &id);
    // marker == 那一枚 op 的 HLC 原文(§3:不许在接收端读本地时钟)。
    assert_eq!(
        conn.query_row("SELECT tombstoned_at FROM board_column WHERE id = ?1", [&id], |r| r
            .get::<_, Option<String>>(0))
            .unwrap()
            .as_deref(),
        Some(ops.last().unwrap().hlc.as_str())
    );
    // ⑥(AFTER)当场消费掉授权行 —— 空表审计是兜底,不是清理工。
    audit_tombstone_apply_empty(&conn).expect("授权表必须已空");
    audit_board_column_semantics(&conn, "", "本地").expect("marker == 自身日志的 MIN(hlc)");

    // 已删的列:再删拒,命令层的改名 / 排序也拒(⚠ **回放那边照收** —— 判据见
    // `apply_board_column_set_field` 头注,「只读」是命令层的事)。
    assert!(delete_column(&mut conn, &mut clock, &id, &crate::board::gate::DETACHED).unwrap_err().contains("已经删除"));
    assert!(rename_column(&mut conn, &mut clock, &id, "还想改", &crate::board::gate::DETACHED).unwrap_err().contains("已删除"));
    assert!(reorder_column(&mut conn, &mut clock, &id, None, Some("todo"), &crate::board::gate::DETACHED).unwrap_err().contains("已删除"));
    assert!(delete_column(&mut conn, &mut clock, "根本没这列", &crate::board::gate::DETACHED).unwrap_err().contains("列不存在"));
}

#[test]
fn a_column_with_live_cards_refuses_to_go_and_says_how_many() {
    let (mut conn, mut clock) = fresh_rw("delete-nonempty");
    let id = create_column(&mut conn, &mut clock, "在用", &crate::board::gate::DETACHED).unwrap();
    let card = crate::task::create(&mut conn, &mut clock, "一件事", None, None, None).unwrap();
    crate::task::transition(&mut conn, &mut clock, &card, &id, &crate::board::gate::DETACHED).expect("拖进新列");
    assert_eq!(row_of(&conn, &id).live_items, 1);

    let err = delete_column(&mut conn, &mut clock, &id, &crate::board::gate::DETACHED).unwrap_err();
    // ⚠ 断言必须是**命令层那句的原文**。头一版写的是 `err.contains('1')`,变异对照当场判它
    // 假绿:摘掉命令层这道之后触发器 ① 照样 ABORT,而那条错误里带着列的 ULID ——
    // **ULID 里就有数字 '1'**,断言被一个毫不相干的东西满足了。
    // ⇒ 判例:断言「输出里有没有某个字符」时,先想清楚那个字符**还能从哪儿来**。
    assert!(
        err.contains("该列还有 1 个未归档条目"),
        "要给出**条数**(触发器 ① 给不出,它只会说「还有未归档条目」):{err}"
    );
    assert!(ops_of(&conn, &id).len() == 1, "拒了就不许留下墓碑 op(只剩建列那枚)");

    // 回收站与成就归档里的条目**不算** live —— 那两根轴上的卡只出不进,不挡删列。
    crate::task::archive(&mut conn, &mut clock, &card).unwrap();
    assert_eq!(row_of(&conn, &id).live_items, 0);
    delete_column(&mut conn, &mut clock, &id, &crate::board::gate::DETACHED).expect("清空后删得掉");
    // 卡还指着这一列 = §4.3 的只读收容区。
    assert_eq!(
        conn.query_row("SELECT stage FROM items WHERE id = ?1", [&card], |r| r.get::<_, String>(0))
            .unwrap(),
        id
    );
}

/// ⭐ **477 那笔账的守卫**(480 用户拍板:按「有没有产品语义挂着」分)。
///
/// ⚠ 判据**刻意不写成「`todo`/`done` 不可删」** —— 那样只是把常量抄第二遍,把 `LANDING_COLUMN`
/// 换成别的值它照样绿。这里问的是反过来的那句:**产品主线实际落在哪一列,那一列就必须
/// 不可删** —— 落点由生产代码算出来,禁删名单由 [`ROLE_COLUMNS`] 说了算,两边任一处漂了就红。
#[test]
fn whatever_column_a_product_line_pins_itself_to_must_be_undeletable() {
    let (mut conn, mut clock) = fresh_rw("role-cols");
    let stage_of = |c: &Connection, id: &str| {
        c.query_row("SELECT stage FROM items WHERE id = ?1", [id], |r| r.get::<_, String>(0)).unwrap()
    };
    let must_be_safe = |conn: &Connection, col: &str, who: &str| {
        let system = conn
            .query_row("SELECT system FROM board_column WHERE id = ?1", [col], |r| r.get::<_, i64>(0))
            .unwrap();
        assert!(
            undeletable_reason(col, system == 1).is_some(),
            "{who}落在「{col}」上,而那一列是可删的 —— 删掉之后这条主线会**安静地**\
             把卡塞进只读收容区(或干脆再也走不到),不是响亮拒"
        );
    };

    // ① 新建任务 / ② 转待办:落点必须受保护。
    let a = crate::task::create(&mut conn, &mut clock, "新任务", None, None, None).unwrap();
    must_be_safe(&conn, &stage_of(&conn, &a), "新建任务");
    let idea = crate::notes::capture(&mut conn, &mut clock, "灵感").unwrap();
    let b = crate::notes::promote_to_task(&mut conn, &mut clock, &idea, "转来的").unwrap();
    must_be_safe(&conn, &stage_of(&conn, &b), "转待办");
    // ③ 撤回为灵感:只有落点那一列的卡退得回去 ⇒ 它同样承重。
    crate::notes::revert_task_to_inbox(&mut conn, &mut clock, &b).expect("落点上的卡退得回灵感");

    // ④ 「完成」那个角色:遍历全部活着的任务列,凡是**进去会盖 done_at** 的那一列都必须受保护。
    //    ⛔ 这一段不许写死 "done" —— 那就成了把常量抄第二遍。
    let live_cols: Vec<String> = list_columns(&conn)
        .unwrap()
        .into_iter()
        .filter(|c| c.kind == "task" && !c.deleted)
        .map(|c| c.id)
        .collect();
    let mut stamping = 0;
    for col in &live_cols {
        let card = crate::task::create(&mut conn, &mut clock, "探针", None, None, None).unwrap();
        if stage_of(&conn, &card) == *col {
            continue; // 已经在那儿了,transition 会判 from == to
        }
        crate::task::transition(&mut conn, &mut clock, &card, col, &crate::board::gate::DETACHED).unwrap();
        let stamped: Option<String> = conn
            .query_row("SELECT done_at FROM items WHERE id = ?1", [&card], |r| r.get(0))
            .unwrap();
        if stamped.is_some() {
            stamping += 1;
            must_be_safe(&conn, col, "「完成」的盖章");
            crate::task::seal(&mut conn, &mut clock, &card).expect("盖了章的那一列也正是成就归档收的那一列");
        } else {
            assert!(crate::task::seal(&mut conn, &mut clock, &card).is_err(), "只有完成列收得进归档册");
        }
    }
    assert_eq!(stamping, 1, "恰有一列承载「完成」——多一列或零列都说明产品语义漂了");

    // ⑤ 反面那半:**没有**语义挂着的内置任务列照样删得掉(⛔ 否则这条规则就退化成
    //    「内置的都不许删」,而那是用户明确没选的那个选项)。
    let free: Vec<&String> = live_cols.iter().filter(|c| undeletable_reason(c, false).is_none()).collect();
    assert!(!free.is_empty(), "内置任务列里必须还有可删的那几个");
    for col in free {
        // 先把探针卡清走,再删。
        let cards: Vec<String> = crate::repo::column_task_ids(&conn, col).unwrap();
        for c in cards {
            crate::task::archive(&mut conn, &mut clock, &c).unwrap();
        }
        delete_column(&mut conn, &mut clock, col, &crate::board::gate::DETACHED).unwrap_or_else(|e| panic!("「{col}」本该删得掉:{e}"));
    }
    // ⑥ 而两列角色列即使空着也删不掉,且**改名与排序照旧**(只禁删这一件事)。
    for col in ["todo", "done"] {
        let cards: Vec<String> = crate::repo::column_task_ids(&conn, col).unwrap();
        for c in cards {
            crate::task::archive(&mut conn, &mut clock, &c).unwrap();
        }
        assert_eq!(row_of(&conn, col).live_items, 0);
        assert!(!row_of(&conn, col).deletable, "读模型也要照实说(B-f 靠它决定按钮灰不灰)");
        assert!(delete_column(&mut conn, &mut clock, col, &crate::board::gate::DETACHED).unwrap_err().contains("不可删除"));
        rename_column(&mut conn, &mut clock, col, "换个说法", &crate::board::gate::DETACHED).expect("角色列可改名");
        reorder_column(&mut conn, &mut clock, col, None, Some("filed"), &crate::board::gate::DETACHED).expect("角色列可排序");
    }
}

/// 登记表一致性:[`ROLE_COLUMNS`] 里的每一格都得是**真实存在的、非系统的任务种子**。
///
/// ⚠ 与上面那只分工:那只问「产品落在哪儿」,这只问「名单本身合不合法」。
/// 反方向(名单里多了一格却没在 [`undeletable_reason`] 里给理由)由那个函数里的
/// `debug_assert` 兜。
#[test]
fn the_role_columns_are_real_non_system_task_seeds() {
    let conn = fresh_db("role-registry");
    for id in ROLE_COLUMNS {
        assert!(is_seed_column(id), "角色列必须是迁移种下的六个之一:{id}");
        assert!(!is_system_seed_column(id), "角色列不是系统列 —— 它可改名可排序,只是不可删:{id}");
        let k = column_kind(&conn, id).unwrap().unwrap_or_else(|| panic!("{id} 没有行"));
        assert_eq!(k.kind, "task", "角色列必须是任务列:{id}");
        assert!(undeletable_reason(id, false).is_some(), "名单里的每一格都要给得出理由:{id}");
    }
    // 其余四个种子照 480 的定案分两边:系统那两个连改名一起禁,doing/confirming 全放。
    assert!(undeletable_reason("inbox", true).is_some() && undeletable_reason("filed", true).is_some());
    assert!(undeletable_reason("doing", false).is_none() && undeletable_reason("confirming", false).is_none());
}
