//! 发送端闸的行为锚(board-columns-plan §5;**B-e 第 1 段**)。
//!
//! # 这一份验的是 §5.3 那张失败方向表的**哪几行**
//!
//! | §5.3 那一行 | 本段 |
//! |---|---|
//! | 错算成 `true` → 新 stage 送到旧端 → `InvalidOp` 隔离(**H**) | ✅ 逐路径压 —— [`the_nine_paths_of_the_solo_verdict`] + [`a_configured_space_is_shut_out_on_every_one_of_the_five_doors`] |
//! | 错算成 `false` → 用户暂时不能建/改列(可接受) | ✅ 本段今天**恒**落在这一侧(闩与 roster 两臂未落)⇒ 已配置空间必拒 |
//! | 刷新失败仍沿用旧授权(**H**) | ⛔ **第 2 段**(`fresh_roster_is_known` 那一臂还不存在) |
//! | capability Hello 晚到 / 丢失 | ⛔ **第 2 段** |
//! | 长期离线**设备**(别人) | ⛔ **第 2 段** |
//! | ⭐ **本机离线** | ⛔ **第 2 段**(由 §5.5 的闩兑现) |
//! | ⭐ **两端从不同时在线** | ⛔ **第 2 段**(同上) |
//!
//! ⛔ **别把本段的绿读成「闸已验完」**:§5.6 那张表的「顺序」行
//! (`取 lease → … → 清或设 latch → reconcile → 释放 lease`)**中间那一步在第 2 段才存在**
//! ⇒ 顺序那一格整格归第 2 段;本段只压「lease 持有 ⇒ 闸拒」与「三条释放路径都放锁」
//! ([`the_veto_is_released_on_success_failure_and_panic`])。切段的账见 plan §8.5。

use super::*;
use crate::board::{create_column, delete_column, rename_column, reorder_column};
use crate::clock::Clock;
use crate::db;
use rusqlite::Connection;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn fresh_db(tag: &str) -> Connection {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let p = crate::test_temp::dir()
        .join(format!("ys-nb-gate-{tag}-{}-{}.sqlite3", std::process::id(), n));
    for f in [p.to_path_buf(), p.with_extension("sqlite3-wal"), p.with_extension("sqlite3-shm")] {
        let _ = std::fs::remove_file(&f);
    }
    let conn = db::open(&p).expect("open migrated db");
    Clock::load(&conn).expect("init device identity");
    conn
}

fn put(conn: &Connection, key: &str, value: &str) {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    .expect("写 sync_meta");
}

/// 一份**合法的**已配置四元组(`load_config` 认得的形:k_acc/device_key 是 64 位 hex)。
///
/// ⚠ 值必须过得了 `load_config` 的解析 —— 拿一串随手写的字符串来,`load_config` 会走
/// 「残缺/损坏」那档给 `Err`,于是测出来的「拒」是**拒错了理由**(清单 13:别让夹具把
/// 被测的那条路绕开)。
fn configure(conn: &Connection) {
    put(conn, "account_id", "01ACCOUNT00000000000000000");
    put(conn, "k_acc", &"ab".repeat(32));
    put(conn, "device_key", &"cd".repeat(32));
    put(conn, "server_url", "wss://sync.example.test");
}

fn facts(config_transition_in_flight: bool, engine_present: bool) -> RuntimeFacts {
    RuntimeFacts { config_transition_in_flight, engine_present }
}

// ---- §5.4 那张逐路径结论表 -------------------------------------------------------------

/// §5.4 「逐路径结论表」**逐行**(十轮索取的可枚举形)。
///
/// ⭐ 第 9 行「零键但残留 `bootstrapped_at` / `pending_*`」规格给的处置是「⛔ 拒绝,不判
/// solo」—— 它被前三格**结构性蕴含**(477 判例:别为结构蕴含另造一条分支),故这里压的是
/// **那条蕴含本身**:残留任一格,判词就必须是 `false`。
#[test]
fn the_nine_paths_of_the_solo_verdict() {
    // ① 新建纯本地空间:四键全无。
    let conn = fresh_db("solo-fresh");
    assert!(is_solo_space(&conn, false).unwrap(), "① 纯本地空间必须判 solo");

    // ② 备份恢复 / ⑦ reset space / ④ 未配置空间 compact —— 三条路的**终态**是同一个:
    //    零配置的库。⚠ 恢复 / compact **进行期间**整式为 false 靠 §5.6 的顶层否决,
    //    ⛔ 不靠这一列(见 [`the_veto_outranks_the_solo_verdict`])。
    let conn = fresh_db("solo-cleared");
    configure(&conn);
    put(&conn, "bootstrapped_at", "2026-08-25T00:00:00Z");
    {
        let mut c = conn;
        crate::sync::transport::clear_config(&mut c).expect("clear_config");
        assert!(is_solo_space(&c, false).unwrap(), "②④⑦ 清干净之后必须判 solo");
    }

    // ③ 已配置空间的 Configured epoch compact:四键**保留**。
    let conn = fresh_db("solo-configured");
    configure(&conn);
    assert!(!is_solo_space(&conn, false).unwrap(), "③ 已配置空间不是 solo");

    // ⑤ revoke / remove 设备:本地配置与 k_acc **不清**,服务器只撤权限。
    //   ⑥ 只换 server_url:账户身份仍在。
    //   两者在库上的形与 ③ 相同 —— ⭐ 这正是本闸「只认库里那四键」的形:它不需要知道
    //   服务器那边发生了什么(§5.4 那张表把这两行单列,是为了说明**不许**为它们开例外)。
    let conn = fresh_db("solo-revoked");
    configure(&conn);
    put(&conn, "server_url", "wss://other.example.test");
    assert!(!is_solo_space(&conn, false).unwrap(), "⑤⑥ 换地址 / 撤设备都不改账户身份");

    // ⑧ Pair / Create 尚未提交:四键暂时全无 ⇒ **本列算出 `true`**。
    //   ⛔ 整式为 false 靠 §5.6,别指望这一列挡住它(十二轮那条 H 就是这么造出来的)。
    let conn = fresh_db("solo-pairing");
    assert!(is_solo_space(&conn, false).unwrap(), "⑧ 本列确实算 true —— 这是规格写死的");
    assert!(
        ensure_can_emit(&conn, &facts(true, false)).is_err(),
        "⑧ 而整式必须是 false —— 顶层否决兜住它"
    );

    // ⑨ 零键但残留 `bootstrapped_at` / `pending_*` = 非法中间态 ⇒ 拒。逐格。
    for key in ["bootstrapped_at", "pending_state", "pending_device_id", "pending_device_key", "pending_pubkey"] {
        let conn = fresh_db("solo-leftover");
        put(&conn, key, "leftover");
        assert!(
            !is_solo_space(&conn, false).unwrap(),
            "⑨ 残留 {key} 是非法中间态,⛔ 不许判 solo"
        );
    }
}

/// ⭐ **「只看 `bootstrapped_at` 空」单用是错的且危险**(§5.4 那两个被否掉的候选之一)。
///
/// `save_config` 在**配对那一刻**就原子写四键,而 `bootstrapped_at` 对**加入方**要等 boot
/// 导入事务提交 ⇒ 存在真实窗口:四键齐、标记空、而这个空间已经属于一个可能含旧端的账户。
/// 这正是「判错成 `true` = 没有闸」的形。
#[test]
fn the_joiner_window_is_not_solo() {
    let conn = fresh_db("joiner");
    configure(&conn); // 四键已落
    assert!(
        crate::sync::transport::meta_get(&conn, "bootstrapped_at").unwrap().is_none(),
        "前提:加入方此刻还没引导过"
    );
    assert!(!is_solo_space(&conn, false).unwrap(), "四键齐 = 已属于某个账户,⛔ 不是 solo");
}

/// ⭐ **第四合取不是第二合取的第二份描述**:零键 + 引擎仍在场 ⇒ 拒。
///
/// 守的是 `clear_config` 删掉 `bootstrapped_at` 到下一次 `reconcile` 真跑之间那个窗口。
#[test]
fn an_assembled_engine_keeps_the_gate_shut_even_with_zero_config() {
    let conn = fresh_db("engine-present");
    assert!(is_solo_space(&conn, false).unwrap(), "前提:库这一半已经是 solo 的形");
    assert!(!is_solo_space(&conn, true).unwrap(), "引擎还在场 ⇒ ⛔ 不判 solo");
    assert!(ensure_can_emit(&conn, &facts(false, true)).is_err());
}

/// 四键**残缺**(库损坏 / 写入中断)⇒ `load_config` 响亮报错 ⇒ 闸 fail-closed。
///
/// ⛔ 别把它「兜底」成「不全就当没配置」—— 那是朝 `true` 错算(§5.3 判 H)。
#[test]
fn a_torn_config_is_refused_not_guessed() {
    let conn = fresh_db("torn");
    put(&conn, "account_id", "01ACCOUNT00000000000000000");
    let e = ensure_can_emit(&conn, &facts(false, false)).unwrap_err();
    assert!(e.contains("残缺"), "要的是 load_config 那句响亮的话,得到:{e}");
}

// ---- §5.6 顶层否决 ---------------------------------------------------------------------

/// ⭐ **`NOT config_transition_in_flight` 是顶层否决,不是 `is_solo_space` 的一个合取项**
/// (十二轮那条 H;⛔ 别照被推翻的那半办)。
///
/// # 这只测怎么分辨这两种写法
///
/// 两种写法在「solo 空间 + 转换在飞」上给的都是拒,分辨不出。**分辨点在已配置空间**:
///
/// * 顶层(正确):先撞否决 ⇒ 报的是「正在改同步配置」;
/// * 塞进 solo(错):`load_config` 一句就短路成 `false` ⇒ 报的是「已加入账户」,
///   而那意味着**这一格根本没被求值** —— 第 2 段的闩一落地,它就会被闩绕过去。
#[test]
fn the_veto_outranks_the_solo_verdict() {
    let conn = fresh_db("veto-solo");
    let e = ensure_can_emit(&conn, &facts(true, false)).unwrap_err();
    assert!(e.contains("正在改同步配置"), "solo 空间 + 转换在飞 ⇒ 拒,得到:{e}");

    let conn = fresh_db("veto-configured");
    configure(&conn);
    let e = ensure_can_emit(&conn, &facts(true, false)).unwrap_err();
    assert!(
        e.contains("正在改同步配置"),
        "⛔ 已配置空间也必须先撞顶层否决 —— 报「已加入账户」= 这一格被写进 solo 里了,\
         第 2 段的闩会把它整个绕过去。得到:{e}"
    );
}

/// §5.6:成功 / 失败 / panic 三条路都由 RAII guard 放行,⛔ 不靠调用方记得清。
#[test]
fn the_veto_is_released_on_success_failure_and_panic() {
    let sup = crate::sync::supervisor::SpaceSupervisor::new(
        tokio::runtime::Builder::new_current_thread().build().unwrap().handle().clone(),
        1,
        None,
    );
    assert!(!sup.config_transition_in_flight(), "出厂态:没有转换在飞");

    // ① 成功路:作用域结束即放。
    {
        let _t = sup.begin_config_transition();
        assert!(sup.config_transition_in_flight());
    }
    assert!(!sup.config_transition_in_flight(), "① 正常收场必须放行");

    // ② 失败路:`?` 提前返回也是作用域结束。
    fn fails(sup: &crate::sync::supervisor::SpaceSupervisor) -> Result<(), String> {
        let _t = sup.begin_config_transition();
        Err("配置事务失败".into())
    }
    assert!(fails(&sup).is_err());
    assert!(!sup.config_transition_in_flight(), "② 失败路必须放行");

    // ③ panic 路:unwind 照样跑 Drop。
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _t = sup.begin_config_transition();
        panic!("配置事务里炸了");
    }));
    assert!(r.is_err());
    assert!(!sup.config_transition_in_flight(), "③ panic 路必须放行");
}

// ---- 接线:五道门 ----------------------------------------------------------------------

/// 已配置空间上,**会往外发新词汇 / 新值的那五道门**一道不漏地拒。
///
/// ⚠ 「五道」= 四条 board 命令 + 拖卡。⛔ 少接一道 = 一个朝 `true` 的洞,而 §5.3 判它 H。
#[test]
fn a_configured_space_is_shut_out_on_every_one_of_the_five_doors() {
    let mut conn = fresh_db("five-doors");
    let mut clock = Clock::load(&conn).unwrap();

    // 先在还是 solo 的时候把料备齐:一个自定义列 + 一张卡。
    let col = create_column(&mut conn, &mut clock, "本周", &DETACHED).expect("建列");
    let card = crate::task::create(&mut conn, &mut clock, "一张卡", None, None, None).expect("建卡");

    configure(&conn);
    let f = facts(false, false);

    // ① 建列 ② 改名 ③ 排序 ④ 删列
    assert!(create_column(&mut conn, &mut clock, "下周", &f).is_err(), "① 建列必拒");
    assert!(rename_column(&mut conn, &mut clock, &col, "改了", &f).is_err(), "② 改名必拒");
    assert!(
        reorder_column(&mut conn, &mut clock, &col, None, Some(super::super::LANDING_COLUMN), &f).is_err(),
        "③ 排序必拒"
    );
    assert!(delete_column(&mut conn, &mut clock, &col, &f).is_err(), "④ 删列必拒");

    // ⑤ 拖卡进自定义列 —— 三条路(transition / reorder / reorder_visible)都要拒。
    assert!(crate::task::transition(&mut conn, &mut clock, &card, &col, &f).is_err(), "⑤ transition 必拒");
    assert!(
        crate::task::reorder(&mut conn, &mut clock, &card, super::super::LANDING_COLUMN, &col, &[], &[card.clone()], &f)
            .is_err(),
        "⑤ reorder 必拒"
    );
    assert!(
        crate::task::reorder_visible(
            &mut conn,
            &mut clock,
            &card,
            super::super::LANDING_COLUMN,
            &col,
            &[],
            &[card.clone()],
            &f
        )
        .is_err(),
        "⑤ reorder_visible 必拒"
    );
}

/// ⭐ **拖进 seed 列一律放行**,哪怕空间已配置、闸整个是关的。
///
/// ⛔ 这一格不许被「一律要闸」收紧:那会让已配置空间连「把卡从待办拖到完成」都做不了,
/// 而那条路 0036 之前就存在、与本案毫无关系(判据见 [`ensure_card_may_land`])。
#[test]
fn seed_columns_still_take_cards_while_the_gate_is_shut() {
    let mut conn = fresh_db("seed-lands");
    let mut clock = Clock::load(&conn).unwrap();
    let card = crate::task::create(&mut conn, &mut clock, "一张卡", None, None, None).expect("建卡");
    configure(&conn);
    let f = facts(false, false);
    assert!(ensure_can_emit(&conn, &f).is_err(), "前提:闸此刻是关的");

    for to in ["doing", super::super::DONE_COLUMN, super::super::LANDING_COLUMN] {
        crate::task::transition(&mut conn, &mut clock, &card, to, &f)
            .unwrap_or_else(|e| panic!("拖进 seed 列 {to} 不该被闸挡:{e}"));
    }
}

/// 纯本地空间上五道门全开(闸的另一半:⛔ 别把 fail-closed 做成「谁也别想用」)。
#[test]
fn a_pure_local_space_may_use_all_five_doors() {
    let mut conn = fresh_db("all-doors-open");
    let mut clock = Clock::load(&conn).unwrap();
    let f = facts(false, false);
    let a = create_column(&mut conn, &mut clock, "甲", &f).expect("① 建列");
    let b = create_column(&mut conn, &mut clock, "乙", &f).expect("① 建列");
    rename_column(&mut conn, &mut clock, &a, "甲甲", &f).expect("② 改名");
    reorder_column(&mut conn, &mut clock, &a, None, Some(&b), &f).expect("③ 排序");
    let card = crate::task::create(&mut conn, &mut clock, "一张卡", None, None, None).expect("建卡");
    crate::task::transition(&mut conn, &mut clock, &card, &a, &f).expect("⑤ 拖进自定义列");
    crate::task::transition(&mut conn, &mut clock, &card, super::super::LANDING_COLUMN, &f).expect("⑤ 拖回来");
    delete_column(&mut conn, &mut clock, &a, &f).expect("④ 删列");
}
