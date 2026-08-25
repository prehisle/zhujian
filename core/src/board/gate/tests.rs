//! 发送端闸的行为锚(board-columns-plan §5;第 1 段 + **B-e 第 2 段**)。
//!
//! # 这一份验的是 §5.3 那张失败方向表的**哪几行**
//!
//! | §5.3 那一行 | 落在哪 |
//! |---|---|
//! | 错算成 `true` → 新 stage 送到旧端 → `InvalidOp` 隔离(**H**) | ✅ 逐路径压 —— [`the_nine_paths_of_the_solo_verdict`] + [`a_configured_space_is_shut_out_on_every_one_of_the_five_doors`] |
//! | 错算成 `false` → 用户暂时不能建/改列(可接受) | ✅ 闩没立起来之前,已配置空间恒落这一侧 |
//! | 刷新失败仍沿用旧授权(**H**) | ✅ `supervisor/tests.rs` 的 `runtime_facts_synthesize_the_roster_arm_in_four_tiers` ①:`roster = None` = **不知道**,⛔ 不是空集合 |
//! | capability Hello 晚到 / 丢失 | ✅ 同上 ②③:观测缺席 / 观测为否,两态都让这一臂为假 |
//! | 长期离线**设备**(别人) | ✅ 同上 ②(⛔ 没有「离线就忽略」的兜底 —— 那台就是观测缺席) |
//! | ⭐ **本机离线** | ✅ [`the_latch_carries_the_gate_through_an_offline_session`] |
//! | ⭐ **两端从不同时在线** | ✅ 同上(闩把「曾成立过一次」变成永久事实) |
//!
//! # ⭐ 第 2 段的两处「不是漏做」
//!
//! * **§5.6 那张表「顺序」行中间那一步(`清或设 latch`)塌成了空** —— 闩强绑
//!   `account_id`(§5.6 末的二选一,选了后者),于是 `clear_config` / 新账户 `save_config`
//!   把 `account_id` 换掉的那一瞬旧闩就对不上号。⇒ 压这一格的是
//!   [`a_new_account_starts_without_the_old_accounts_latch`],它顺带断言**闩那一行还在库里**
//!   —— 「原子一致」来自绑定,不来自某处记得删。
//! * **闩不会自己在后台立起来** —— 唯一置位路径是 roster 臂第一次成立的**那一趟写**
//!   (§8.5)。[`the_latch_is_armed_by_the_roster_arm_and_never_by_itself`] 把这条边界压成断言。
//!
//! # ⭐ B-f 第 2 段新增的那一格:**只读探针**
//!
//! [`explain`] 是给 UI 的同源答案。它有一条硬约束(2026-08-25 用户拍板②):
//! **⛔ 不许成为闩的第二条置位路径**。压这一格的是
//! [`explaining_the_gate_never_arms_the_latch`] —— 它挑的样本恰恰是「名册臂此刻成立」
//! (换成 `ensure_can_emit` 就会当场立闩的那一格),故这只测**只有被测那一句**决定得了
//! (自检清单 13:别让样本落在别的尺也拒得掉的坐标上)。

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
    RuntimeFacts { config_transition_in_flight, engine_present, roster_fully_capable: false }
}

/// 「本次会话真收到过名册,且名册上每一台都有当前代次的肯定观测」那一臂**已成立**。
///
/// ⚠ 这只夹具直接给合成后的那一格 —— 合成本身(`SyncStatus::roster` × `PeerCaps`)是
/// [`RuntimeFacts::observe`] 的事,由 `supervisor/tests.rs` 那边逐档压。
///
/// `engine_present` 留成参数是**为了造得出一个本不该出现的组合**:零配置 + 名册臂成立
/// (`false`)。生产里那是矛盾的,而正因如此它才验得出「solo 那一臂**先**短路」——
/// 见 [`a_solo_space_never_writes_a_latch`]。已配置的那几只一律传 `true`(真实形)。
fn facts_with_capable_roster(engine_present: bool) -> RuntimeFacts {
    RuntimeFacts { config_transition_in_flight: false, engine_present, roster_fully_capable: true }
}

/// 闩这一刻立着吗(直读库,⛔ 不经 [`ensure_can_emit`] —— 那会把「闩立着」与「这一趟
/// 顺手把它立起来了」两件事搅在一起)。
fn latch_row(conn: &Connection) -> Option<String> {
    crate::sync::transport::meta_get(conn, LATCH_KEY).expect("读闩")
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

// ---- §5.5 单调闩 -----------------------------------------------------------------------

/// ⭐ **闩的唯一置位路径 = roster 臂第一次成立的那一趟写**(§8.5),⛔ 它不会自己立起来。
///
/// 三格,顺序有意:
/// ① 名册臂不成立时,写被拒 **且库里一行闩都没有**(⛔ 别在拒的路上顺手记账);
/// ② 名册臂成立 ⇒ 写过 **且** 闩当场立起来;
/// ③ 立完之后名册臂**塌掉**(会话断、观测清)⇒ 照样过 —— 这才是闩存在的全部理由。
#[test]
fn the_latch_is_armed_by_the_roster_arm_and_never_by_itself() {
    let mut conn = fresh_db("latch-arm");
    let mut clock = Clock::load(&conn).unwrap();
    configure(&conn);

    // ① 名册臂不成立。
    // ⚠ **这一格承重的是事务边界,不是那个 `if` 的位置**(483 变异 ④ 判出来的):把
    //    `arm_latch` 挪到名册臂判定之前,这一格**照样绿** —— 闸跑在调用方自己的事务里,
    //    拒即回滚。⇒ 真正该被守的是「闸在写命令自己的事务内」,由
    //    [`a_rolled_back_write_leaves_no_latch_behind`] + 变异 ⑯ 守着。
    //    ⛔ 别把这句读成「`if` 的位置有测守着」,也别为它硬造第二只测(477 判例)。
    assert!(create_column(&mut conn, &mut clock, "本周", &facts(false, true)).is_err());
    assert_eq!(latch_row(&conn), None, "① 拒的那一趟⛔ 不许留下任何授权痕迹");

    // ② 第一次成立。
    create_column(&mut conn, &mut clock, "本周", &facts_with_capable_roster(true)).expect("② 该放行");
    assert_eq!(
        latch_row(&conn).as_deref(),
        Some(format!("{} 01ACCOUNT00000000000000000", crate::board::CAP_BOARD_COLUMNS_V1).as_str()),
        "② 闩的值 = 「CAP_GEN + 账户」,⛔ 不是一份名册"
    );

    // ③ 名册臂塌掉之后,闩自己扛得住。
    create_column(&mut conn, &mut clock, "下周", &facts(false, true)).expect("③ 闩必须扛得住");
}

/// ⭐ **§5.3 后两行**(「本机离线」M / 「两端从不同时在线」H)—— 闩兑现的就是这两格。
///
/// 「本机离线」在库这一层的形 = `roster_fully_capable = false`(名册随会话结束清成
/// `None`,观测随引擎代次清空)。⇒ 断网之后连**把卡拖进自己早就建好的列**都该做得到。
#[test]
fn the_latch_carries_the_gate_through_an_offline_session() {
    let mut conn = fresh_db("latch-offline");
    let mut clock = Clock::load(&conn).unwrap();
    let card = crate::task::create(&mut conn, &mut clock, "一张卡", None, None, None).expect("建卡");
    configure(&conn);

    // 一次短暂重叠在线:建列成功,闩随之立起。
    let col = create_column(&mut conn, &mut clock, "本周", &facts_with_capable_roster(true)).expect("建列");

    // 此后本机离线 —— 名册不知道、观测清空。
    let offline = facts(false, true);
    crate::task::transition(&mut conn, &mut clock, &card, &col, &offline)
        .expect("⭐ 断网也必须拖得进自己早就建好的列(§5.3「本机离线」那一行)");
    rename_column(&mut conn, &mut clock, &col, "这周", &offline).expect("改名同理");
}

/// ⛔ **闩绝不许在纯本地空间上立起来**:它是**账户级**事实,而一个还没有账户的库
/// 立不出这条事实(值里那半个 `account_id` 根本无从填)。
///
/// ⚠ 这一格不是洁癖:留一行「空账户的闩」在库里,等它日后加入某个账户时就多一个
/// 判错的机会,而判错的方向是朝 `true`(§5.3 判 **H**)。
///
/// ⚠ **如实记账:这一格今天被结构性蕴含** —— `arm_latch` 只在 `load_config` 给出
/// `Some(cfg)` 的那一支里够得着,而 solo ⇒ 四键全无 ⇒ 那一支进不去。⇒ 变异对照里
/// 它是**预期的绿**(造不出「在 solo 上立闩」的等价退化)。**测留着**:它压的是
/// 「solo 那一臂**先**短路」这条顺序,哪天有人把闩挪到 solo 之前,它是唯一会红的东西。
#[test]
fn a_solo_space_never_writes_a_latch() {
    let mut conn = fresh_db("latch-solo");
    let mut clock = Clock::load(&conn).unwrap();
    create_column(&mut conn, &mut clock, "本周", &facts_with_capable_roster(false)).expect("solo 恒放行");
    assert_eq!(latch_row(&conn), None, "solo 那一臂**先**短路,⛔ 一行都不许写");
}

/// ⭐ **§5.5 (β) 身份清场**:换了账户,旧闩天然对不上号 —— 而**没有任何一处去删它**。
///
/// 这只测同时压两件事(⛔ 别拆开读):
/// ① 判词已经翻了(新账户必须重新走名册臂);
/// ② 闩**那一行还原样躺在库里** —— 「原子一致」来自「值里绑着 `account_id`、与配置在
/// 同一次读里比对」,不来自某处记得在 `clear_config` 里多删一个键。
/// ⇒ §5.6 那张表「顺序」行中间那一步(`清或设 latch`)在这一支上**塌成了空**,
/// 不是漏做(plan §8.5 四 + 本模块头注)。
#[test]
fn a_new_account_starts_without_the_old_accounts_latch() {
    let mut conn = fresh_db("latch-rebind");
    let mut clock = Clock::load(&conn).unwrap();
    configure(&conn);
    create_column(&mut conn, &mut clock, "本周", &facts_with_capable_roster(true)).expect("先把闩立起来");
    let armed = latch_row(&conn).expect("前提:闩立着");

    // 走真的那条路:清配置 → 加入另一个账户。⛔ 中间一句「删闩」都没有。
    crate::sync::transport::clear_config(&mut conn).expect("clear_config");
    put(&conn, "account_id", "01OTHERACCOUNT000000000000");
    put(&conn, "k_acc", &"ef".repeat(32));
    put(&conn, "device_key", &"12".repeat(32));
    put(&conn, "server_url", "wss://other.example.test");

    assert_eq!(latch_row(&conn), Some(armed), "② 那一行还在 —— ⛔ 没人删它,也不该有人删");
    let e = create_column(&mut conn, &mut clock, "下周", &facts(false, true)).unwrap_err();
    assert!(e.contains("已加入账户"), "① 新账户必须重新走名册臂,得到:{e}");
}

/// **`CAP_GEN` 一 bump 就自动清闩**(§5.5 (α))—— 值里那半个 token 就是这条的兑现。
///
/// 自检第 13 条(几把尺):样本坐标落在「只有 token 那一半能决定」的那一格 ——
/// `account_id` 逐字相同,只把 token 换成另一枚。
#[test]
fn a_capability_generation_bump_invalidates_the_latch() {
    let mut conn = fresh_db("latch-capgen");
    let mut clock = Clock::load(&conn).unwrap();
    configure(&conn);
    put(&conn, LATCH_KEY, "board_columns_v0 01ACCOUNT00000000000000000");
    let e = create_column(&mut conn, &mut clock, "本周", &facts(false, true)).unwrap_err();
    assert!(e.contains("已加入账户"), "上一代 token 的闩⛔ 不许认,得到:{e}");

    // 反向对照:同一个账户、**当代** token ⇒ 认。
    put(&conn, LATCH_KEY, &latch_value("01ACCOUNT00000000000000000"));
    create_column(&mut conn, &mut clock, "本周", &facts(false, true)).expect("当代 token 必须认");
}

/// ⭐ **闩与它授权的那笔写同生共死**:那笔写失败回滚,闩跟着不立。
///
/// ⛔ 别把它读成多余 —— 闩若能在一笔失败的写里独自留下,「授权」就成了一件与写无关的
/// 副作用,而它是**永久**的(§8.5 给第 2 段定的风险轴:错一次不可撤销)。
#[test]
fn a_rolled_back_write_leaves_no_latch_behind() {
    let mut conn = fresh_db("latch-rollback");
    let mut clock = Clock::load(&conn).unwrap();
    configure(&conn);
    // 闸过得去(名册臂成立),但紧随其后的 `ensure_editable` 在「这一列不存在」上失败。
    let e = rename_column(&mut conn, &mut clock, "01NOSUCHCOLUMN000000000000", "改了", &facts_with_capable_roster(true))
        .unwrap_err();
    assert!(!e.contains("已加入账户"), "前提:拒的理由不是闸,而是闸之后那一步:{e}");
    assert_eq!(latch_row(&conn), None, "写回滚了 ⇒ 闩必须跟着不立");
}

/// ⭐ **顶层否决压得住闩**(§11 自曝 ② 要的那条**真·语义**判据)。
///
/// 第 1 段只能靠**错误文案**分辨「顶层」与「塞进 solo」;闩一落地就有了结构判据 ——
/// 已配置空间 + **闩为真** + 转换在飞 ⇒ 仍拒。把否决塞进 `is_solo_space` 的那种写法在
/// 这一格上会答**放行**(十二轮那条 H 的原形:「lease 已持有 ∧ solo=false ∧ 闩=true
/// ⇒ 整式仍 true」),⛔ 与文案怎么写无关。
#[test]
fn the_veto_outranks_the_latch() {
    let mut conn = fresh_db("veto-latch");
    let mut clock = Clock::load(&conn).unwrap();
    configure(&conn);
    create_column(&mut conn, &mut clock, "本周", &facts_with_capable_roster(true)).expect("先把闩立起来");
    assert!(is_latched(&conn, "01ACCOUNT00000000000000000").unwrap(), "前提:闩确实立着");

    let e = create_column(&mut conn, &mut clock, "下周", &facts(true, true)).unwrap_err();
    assert!(
        e.contains("正在改同步配置"),
        "⛔ 闩为真 + 转换在飞 ⇒ 必须仍拒:否决是**顶层**的,不是析取里的一项。得到:{e}"
    );
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

// ---- B-f 第 2 段:只读探针 --------------------------------------------------------------

/// ⭐ **问一句「现在能不能用」⛔ 不许把闩立起来**(2026-08-25 用户拍板②)。
///
/// # 样本坐标为什么落在「名册臂成立」这一格(自检清单 13:这条路上有几把尺)
///
/// 别的坐标这只测都答不出问题:solo / 已闩 / 顶层否决 / 三臂全不成立那四格,
/// `ensure_can_emit` 本来就不写闩 ⇒ 拿它们当样本,「探针没立闩」是被**别的原因**背书的。
/// **只有名册臂这一格**是「换成 `ensure_can_emit` 就会当场立闩」的 —— 故它是唯一一格由
/// 被测那一句说了算的。
///
/// # 断言分两层,⛔ 别只留第一层
///
/// ① 库里那一行没出现(直接观测);
/// ② **判词真的翻回去了** —— 名册臂塌掉之后写命令必须重新被拒。少了这一层的话,哪天
/// 闩改成存在别处(内存 / 另一张表),第一层会安静地继续绿。
#[test]
fn explaining_the_gate_never_arms_the_latch() {
    let mut conn = fresh_db("explain-no-arm");
    let mut clock = Clock::load(&conn).unwrap();
    configure(&conn);

    // 前提:这一格换成 `ensure_can_emit` 就会立闩(下面 ② 的反向对照证明了这一点)。
    let armed_facts = facts_with_capable_roster(true);
    assert!(matches!(explain(&conn, &armed_facts).unwrap(), GateVerdict::Open), "名册臂成立 ⇒ 判词是「能用」");
    assert_eq!(latch_row(&conn), None, "① 只读探针⛔ 不许留下任何授权痕迹");

    // ② 名册臂塌掉(会话断 / 观测清)⇒ 写必须重新被拒。探针若偷偷立了闩,这里会放行。
    let e = create_column(&mut conn, &mut clock, "本周", &facts(false, true)).unwrap_err();
    assert!(e.contains("已加入账户"), "② 探针立过闩的话这里会放行,得到:{e}");

    // 反向对照:同一格走**写**那条路,闩确实会立起来 —— 证明上面挑的坐标不是个平凡格。
    create_column(&mut conn, &mut clock, "本周", &armed_facts).expect("写那条路该放行");
    assert!(latch_row(&conn).is_some(), "反向对照:写那条路确实立闩");
}

/// 探针与真闸**逐格同源**:同一份事实进去,「放行 / 拒」必须是同一个答案,
/// 而拒的那句人话必须**逐字**相同(⛔ 别让「按钮为什么灰」与「点下去为什么失败」是两套说法)。
///
/// ⚠ 四格覆盖 [`GateVerdict`] 的三个变体 + solo 那条放行路;⛔ 别删成两格 —— 三臂各有
/// 各的短路位置,一格背书不了另一格(清单 14 末那条:笼统的一只会被最容易成立的那格背书)。
#[test]
fn the_probe_and_the_gate_answer_with_one_voice() {
    // ① solo:放行。
    let conn = fresh_db("probe-solo");
    let f = facts(false, false);
    assert!(matches!(explain(&conn, &f).unwrap(), GateVerdict::Open));
    assert!(ensure_can_emit(&conn, &f).is_ok());

    // ② 顶层否决。
    let conn = fresh_db("probe-veto");
    configure(&conn);
    let f = facts(true, true);
    let v = explain(&conn, &f).unwrap();
    assert!(matches!(v, GateVerdict::ShutByConfigTransition));
    assert_eq!(v.reason(), Some(ensure_can_emit(&conn, &f).unwrap_err().as_str()));

    // ③ 三臂全不成立。
    let conn = fresh_db("probe-peers");
    configure(&conn);
    let f = facts(false, true);
    let v = explain(&conn, &f).unwrap();
    assert!(matches!(v, GateVerdict::ShutUntilPeersUpgrade));
    assert_eq!(v.reason(), Some(ensure_can_emit(&conn, &f).unwrap_err().as_str()));

    // ④ 闩已立着:放行(⛔ 别漏这一格 —— 它是 §5.3 后两行在 UI 上的兑现:
    //    本机离线时按钮**不该**是灰的)。
    let mut conn = fresh_db("probe-latched");
    let mut clock = Clock::load(&conn).unwrap();
    configure(&conn);
    create_column(&mut conn, &mut clock, "本周", &facts_with_capable_roster(true)).expect("先把闩立起来");
    let offline = facts(false, true);
    assert!(matches!(explain(&conn, &offline).unwrap(), GateVerdict::Open), "闩立着 ⇒ 断网也该给写入口");
    assert!(ensure_can_emit(&conn, &offline).is_ok());
}

/// **四键残缺 ⇒ 探针照样响亮报错**,⛔ 不许兜底成「能用」或「不能用」。
///
/// ⚠ 它与 [`a_torn_config_is_refused_not_guessed`] 是**同一条 fail-closed 的两端**:
/// 那只压写路径,这只压读路径。少了这只,探针可能给出一个 `ShutUntilPeersUpgrade` 的
/// 「安静的拒」,而库其实是坏的 —— 那两件事对用户是不同的处置(等对端升级 vs 库出事了)。
#[test]
fn a_torn_config_makes_the_probe_shout_too() {
    let conn = fresh_db("probe-torn");
    put(&conn, "account_id", "01ACCOUNT00000000000000000");
    let e = explain(&conn, &facts(false, false)).unwrap_err();
    assert!(e.contains("残缺"), "要的是 load_config 那句响亮的话,得到:{e}");
}
