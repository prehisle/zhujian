//! 发送端闸(board-columns-plan §5;**B-e 第 1 段**)。
//!
//! # 它守什么
//!
//! 混版是本案的硬约束:一枚带**自定义列 id** 的 `item/set_field{stage}` 到了旧端归
//! `InvalidOp` = **per-origin 持久隔离 + 后续帧到即丢**;一枚 `board_column/*` op 到了
//! 旧端归 `UnsupportedVocab` = 整条 origin 挂起。两者都不是「对端少显示一列」这种小事。
//! ⇒ 闸放**发送端**(§5.0,codex 三轮撤回了二轮那个「服务端拒绝旧端会话」的裁决):
//! 与传输无关 ⇒ 中转 / LAN / 以后任何管子都覆盖。
//!
//! ⛔ **闸必须在 core,不能只锁 UI**(§5.1;仓里先例 = identity-plan §5.10-2 M4 那道
//! 「能力闸在 core 拦住直接调用」):只靠 UI 不显示按钮挡不住直接 IPC 调用与将来的接线漂移。
//! 落地形 = 凡是会发出这两种 op 的写命令,签名上**必须**收一枚 [`RuntimeFacts`],而
//! `RuntimeFacts` 的生产唯一产法是 [`RuntimeFacts::observe`]。⇒ 「壳记得判一下」这条自律
//! 被换成了编译期义务(照 475/B-b0 给 `MIGRATIONS` 加 `ForeignKeys` 声明位那一手:
//! **给每个站点加一格必填声明,而不是加一条带默认值的旁路**)。
//!
//! # 今天到哪儿了:**五合取里只落了三格**
//!
//! §5.1 的完整谓词是
//!
//! ```text
//! can_emit_custom_stage =
//!       local_schema_supports_board_columns
//!     ∧ NOT config_transition_in_flight          // §5.6 顶层否决
//!     ∧ ( is_solo_space                          // §5.4
//!       ∨ capability_latched                     // §5.5 单调闩      ← 第 2 段
//!       ∨ ( fresh_roster_is_known                //                  ← 第 2 段
//!         ∧ every_registered_device_is_capable ) //                  ← 第 2 段
//!       ) )
//! ```
//!
//! **第 1 段落的是** `local_schema… ∧ NOT config_transition_in_flight ∧ is_solo_space`,
//! 那条析取的后两臂**还没有**。⇒ 今天的闸是最终式的**真子集**:已配置空间恒拒。
//! 错算方向落在 §5.3 那张表的「错算成 `false` = 用户暂时不能建/改列 = 可接受,合 fail-closed」
//! 那一格,⛔ 不落「错算成 `true`」那一格(那是 H)。
//!
//! ⚠ **别把第 1 段的绿读成「闸已验完」**:§5.3 失败方向表里第 3/4/5 行(刷新失败仍沿用旧
//! 授权 / capability Hello 晚到 / 本机离线 / 两端从不同时在线)整片都在第 2 段的验收面上,
//! 而 §5.6 那张表的「顺序」行(`取 lease → … → **清或设 latch** → reconcile → 释放 lease`)
//! **中间那一步在第 2 段才存在** ⇒ 顺序那一格的测整格归第 2 段,本段只测「lease 持有 ⇒ 闸拒」
//! 与「三条释放路径都放锁」。切段的理由与这张账见 plan §8.5。
//!
//! # ⛔ §5 里那四处翻过案的地方(别照着被推翻的那半办)
//!
//! | 处 | X(已被推翻) | Y(本模块照办的) |
//! |---|---|---|
//! | §5.0 | 二轮:服务端拒绝旧端会话 | 三轮:闸放**发送端** |
//! | §5.4 末 | 十轮第一版:「尚未 `save_config`」判**暂时 true** | 改判 **false**,判据整个搬去 §5.6 |
//! | §5.5 | 九轮:选 B、**不做 latch** | 十轮:**A 单调闩可采用**(第 2 段落) |
//! | §5.6 | B-a 十一轮:lease 写成 `is_solo_space` 的一个合取项 | 十二轮:**顶层否决**,见 [`ensure_can_emit`] |

use rusqlite::Connection;

use crate::sync::supervisor::SpaceSupervisor;

/// 壳采下来的**运行期事实** —— 闸的那一半判据在库里问不到。
///
/// # 为什么是「壳采、按值传」而不是「闸自己去问」
///
/// 谁有资格回答这两格,只有 live 会话的编排者说得清([`SpaceSupervisor`] 是 core 里那个
/// 唯一真相源,两只壳各持一枚)。而写命令拿到的只有一条 `Connection` ——
/// 库里问不出「此刻有没有一台引擎装配着」,更问不出「另一个命令是不是正在改配置」。
///
/// ⚠ **它刻意只带「库里问不到」的那半**:四个配置键 / `bootstrapped_at` / `pending_*`
/// 一律由 [`ensure_can_emit`] 在**写命令自己的事务里**现读,⛔ 不预先采进本结构 ——
/// 「先查、松手、再拿旧事实动手」正是首版自检清单 10 那条(`task::reorder` 的 ⓪ 那句
/// 注释刚为同一条理由把目标列合法性挪进事务)。
#[derive(Debug, Clone, Copy)]
pub struct RuntimeFacts {
    /// §5.6:**全局** writer veto —— Pair / Create / clear / compact 正在进行。
    ///
    /// ⛔ 它是 §5.1 的**顶层**合取,不是 [`is_solo_space`] 的判据之一(十二轮那条 H 就是
    /// 这么造出来的:已配置空间在闩为真时进入 clear/restore/compact,会走成
    /// 「lease 已持有 ∧ solo=false ∧ 闩=true ⇒ 整式仍 true」= **闩把 lease 整个绕过去**)。
    config_transition_in_flight: bool,
    /// §5.4 第四合取:这个空间**此刻有一台装配着的引擎**吗。
    ///
    /// ⚠ **它不是「`bootstrapped_at` 在不在」的第二份描述**(清单 14):`reconcile_inner`
    /// 那条「标记缺席即无条件撤台」只在**它跑过之后**成立,而 `clear_config` 删掉标记到
    /// 下一次 `reconcile` 之间有真实窗口 —— 这一格守的正是那个窗口。
    ///
    /// ⚠ **也不是 `SpaceSupervisor::is_stopped` 的同义词**:桌面壳 eager 装配**全部**已发现
    /// 的空间(含从没配过账户的),故一个纯本地空间在表里恒有槽 —— 拿 `is_stopped` 当判据
    /// 会把「没有旧端可言」的纯本地用户整个关在门外,正是 §5.4 抬头点名要防的那个灾难。
    engine_present: bool,
}

impl RuntimeFacts {
    /// **生产唯一产法**:从 live 会话编排者身上现采。
    ///
    /// # 三档 fail-closed 的取法(⛔ 别简化成一句 `unwrap_or`)
    ///
    /// | 槽的状态 | `engine_present` | 为什么 |
    /// |---|---|---|
    /// | 表里完全没有这个 id | `false` | [`SpaceSupervisor::is_stopped`] 的语义就是「无槽」⇒ 没有任何 transport 在跑,**确定**没有引擎 |
    /// | `Running` | 读那枚投影 | 引擎在场与否由 `EngineSlot` 自己在装配 / 撤台两处写,见 [`crate::sync::supervisor::ActiveRuntime::engine_present`] |
    /// | `Stopping` / `Starting` / `Resetting` | `true` | 瞬态,说不准 ⇒ **当作有**,让 solo 算成 `false`(朝 `false` 错算是可接受那一格) |
    ///
    /// # ⚠ 锁序:本函数在**写锁之内**被调用,那是 `db → live`
    ///
    /// 两只壳都是先拿到空间的写锁(桌面 `rt.write_locks()` / 手机 `Coord::with_write`),
    /// 再调本函数;而本函数内部会取 `SpaceSupervisor` 的 `live` 读锁。⇒ 顺序是 **db → live**。
    ///
    /// **不会死锁,依据是 supervisor 自己那条既有纪律**:「命令面唯一入口:读锁查表 → clone
    /// Arc → 放锁,**绝不持表锁做 SQL / 网络 / 等控制通道**」(`supervisor.rs` `get` 的头注)
    /// ⇒ 仓里**没有** `live → db` 那个方向。⛔ 哪天有人在持 `live` 时去拿某个空间的 db 锁,
    /// 这条就断了 —— 回来读这一段。
    ///
    /// ⚠ 反过来,**「在写锁内采」不等于「与写同一个临界区」**:`config_transition_in_flight`
    /// 由壳的 `lifecycle` 那条路置位,与本空间的写锁并不互斥。那道诚实边界见 plan §5.6a 末。
    pub fn observe(sup: &SpaceSupervisor, space_id: &str) -> RuntimeFacts {
        RuntimeFacts {
            config_transition_in_flight: sup.config_transition_in_flight(),
            engine_present: if sup.is_stopped(space_id) {
                false
            } else {
                // `get` 只在 Running 那一档给 Arc;其余三档(Stopping/Starting/Resetting)
                // 是切换瞬态 ⇒ 落进 `true` 的 fail-closed 侧。
                sup.get(space_id).map(|rt| rt.engine_present()).unwrap_or(true)
            },
        }
    }

    /// **本进程 / 本连接根本没有同步机械**:没有 supervisor、没有 transport、没有引擎,
    /// 也没有任何配置转换在飞。
    ///
    /// ⚠ 用它的地方要能自己答出「凭什么」,今天有三类,逐类点名(⛔ 别再加第四类而不写理由):
    ///
    /// 1. **收敛跑手**(`sync::convergence`)与各模块单测 —— 库是裸开的,一台 transport 都
    ///    没起过;
    /// 2. 跨空间移动给**非 live 目标**开的那条一次性写连接 —— ⚠ 它今天用不上本闸
    ///    (§8.3 定形:跨空间移动**恒落 seed 列**,整条路径不进闸),列在这里只为说明
    ///    「一次性连接」这一类天然属 detached;
    /// 3. 两只壳的集成测里那些不装 transport 的夹具。
    ///
    /// ⛔ **生产写路径不许用它**:那等于把闸关掉。生产走 [`RuntimeFacts::observe`]。
    pub const fn detached() -> RuntimeFacts {
        RuntimeFacts { config_transition_in_flight: false, engine_present: false }
    }
}

/// 两格的读口,**只给测试**。
///
/// ⛔ 字段本身刻意保持私有:公开它们就等于公开了「凭空构造一枚 `RuntimeFacts`」的能力,
/// 而 [`RuntimeFacts::observe`] 是生产唯一产法这件事,全靠这道可见性。⇒ 读得到、造不出。
#[cfg(test)]
impl RuntimeFacts {
    pub(crate) fn engine_present(&self) -> bool {
        self.engine_present
    }

    pub(crate) fn config_transition_in_flight(&self) -> bool {
        self.config_transition_in_flight
    }
}

/// [`RuntimeFacts::detached`] 的写法糖,给 core 自己那几百处测试调用点用。
///
/// ⛔ **不是第二份描述**:它就是那个 `const fn` 的一次求值,值从函数来。
///
/// ⚠ `#[cfg(test)]` 是**故意**的:生产写路径一处都不该用 detached 的事实(用了 = 把闸关掉),
/// 故它连编进生产构建都不必 —— 少一条能走的路。
#[cfg(test)]
pub(crate) const DETACHED: RuntimeFacts = RuntimeFacts::detached();

/// §5.1 那条合取的**今天这一半**;过不了就给一句人话(⛔ 不静默 no-op)。
///
/// 调用点必须在**写命令自己的事务里**(`tx`),理由见 [`RuntimeFacts`] 头注。
///
/// # 三格的顺序刻意是这个
///
/// 1. `local_schema_supports_board_columns` —— 本机 schema + validator 就绪。⭐ 今天它
///    **恒为真**:`board_column` 表由迁移 0036 建、词汇由 0037 落,而 `db::open` 是
///    「迁移不到位就开不了库」的 fail-fast,再往下 `assert_downgrade_gate` 连「库比程序新」
///    都拒(`db.rs:279-282`)⇒ **拿得到 `Connection` 就已经蕴含它**。⛔ 因此这里**不写**
///    一句「查一下 `user_version`」的平凡检查(477 判例:别为结构性蕴含造平凡绿的测);
///    承重的是那两道既有 fail-closed,这段注释就是它的记账。
/// 2. `NOT config_transition_in_flight` —— **顶层否决**,排在 solo 之前。§5.6。
/// 3. 那条析取 —— 今天只有 [`is_solo_space`] 一臂。
pub(crate) fn ensure_can_emit(tx: &Connection, facts: &RuntimeFacts) -> Result<(), String> {
    // ② 顶层否决(§5.6)。⛔ 别把它挪进 `is_solo_space` —— 十二轮那条 H。
    if facts.config_transition_in_flight {
        return Err("正在改同步配置(创号 / 加入账户 / 恢复备份),这一步稍后再试".to_string());
    }
    // ③ 析取:今天只有 solo 那一臂(闩与 roster 归第 2 段)。
    if is_solo_space(tx, facts.engine_present)? {
        return Ok(());
    }
    Err("这个空间已加入账户,自定义看板列要等账户里全部设备都升到支持它的版本才能用".to_string())
}

/// §5.2 那张清单的最后一格:**把卡移进新列**之前。
///
/// # ⭐ 为什么这一条带条件,而四条 board 命令不带
///
/// 判据不是同一个:
///
/// * 四条 board 命令发的是 `board_column/*` —— 旧端**认不得这个 entity**(词汇表 CHECK)
///   ⇒ 一律要闸,给 `todo` 改名也一样。
/// * 拖卡发的是 `item/set_field{stage}` —— 那是旧端**早就认识**的 op,只有 payload 里
///   那个值可能是它没见过的列 id。⇒ **落 seed 列时一枚旧端不认识的字节都没有**,
///   闸在这条路上无事可做;落自定义列才要。
///
/// ⛔ 这一格**不许**收紧成「一律要闸」:那会让已配置空间连「把卡从待办拖到完成」都做不了,
/// 而那条路 0036 之前就存在、与本案毫无关系。⚠ 反过来也**不许**放宽成「反正 UI 不给入口」
/// —— 命令面是 IPC 可直接调的(identity-plan §5.10-2 M4 的原话:只靠 UI 不显示按钮挡不住
/// 直接 IPC 调用与将来的接线漂移)。
///
/// ⚠ **判 seed 用 `is_seed_column`,不是「id 长得像不像 ULID」**:两处不同源就会造出
/// 「列建得出来、卡拖不进去」的死态(479 为 `stage` 与 `board_column` 的 entity_id 共用
/// 同一个形态判据时踩的就是这条)。
pub(crate) fn ensure_card_may_land(
    tx: &Connection,
    to: &str,
    facts: &RuntimeFacts,
) -> Result<(), String> {
    if super::is_seed_column(to) {
        return Ok(());
    }
    ensure_can_emit(tx, facts)
}

/// §5.4 的**五合取**;少一格就有洞。
///
/// ```text
/// is_solo_space =
///       四个配置键全无(account_id / k_acc / device_key / server_url)
///     ∧ bootstrapped_at 全无
///     ∧ pending_* 全无
///     ∧ 当前空间的 engine 已撤台
/// ```
///
/// # ⛔ 两个被否掉的候选,别再挑回来(§5.4)
///
/// * **只看 `bootstrapped_at` 空**:`save_config` 在**配对那一刻**就原子写入四键
///   (`transport.rs:487-495`),而 `bootstrapped_at` 对**加入方**要等 boot 导入事务提交
///   (`boot.rs`)⇒ 真实存在「四键齐、标记空、而这个空间已经属于一个可能含旧端的账户」
///   的窗口。这正是「判错成 `true` = 没有闸」。
/// * **只看 registry 里只有本机一台**:那是已配置空间,`every_registered_device_is_capable`
///   本来就覆盖(roster 只有自己 ⇒ 谓词平凡为真),再加一项只多一个判错的机会。
///
/// # ⭐ 「四键全无」是必要条件不是充分条件
///
/// 九轮判死这一条(推翻了 B-a 原本的形)。而**让它安全的其实不是闸本身,是两道既有
/// fail-closed**:引导前置「快照 `user_version` **等于**本机」(`boot.rs:475-482`)+ 降级闸
/// `assert_downgrade_gate`(`db.rs:279-282`)。⛔ **动那两条之前回来读这一段。**
///
/// # 逐路径结论表里那一行「零键但残留 `bootstrapped_at` / `pending_*`」
///
/// 规格给的处置是「⛔ 拒绝,不判 solo」。⭐ 它被前三格**结构性蕴含**:残留 `bootstrapped_at`
/// ⇒ 第二格假;残留 `pending_*` ⇒ 第三格假。⇒ **不另写一条分支**(477 判例),
/// 承重的是这三格本身,那只针对非法中间态的测直接压这条蕴含。
fn is_solo_space(tx: &Connection, engine_present: bool) -> Result<bool, String> {
    // ① 四个配置键。⛔ 别在这里另抄一份键名清单 —— `load_config` 已经是「全有 / 全无 /
    //    残缺响亮报错」这三态的唯一描述源(`transport.rs:437`),残缺那档它给 `Err`,
    //    正好落在 fail-closed 侧(问不清楚就不放行)。
    if crate::sync::transport::load_config(tx)?.is_some() {
        return Ok(false);
    }
    // ② 引导标记。
    if crate::sync::transport::meta_get(tx, "bootstrapped_at")?.is_some() {
        return Ok(false);
    }
    // ③ 纪元切换的两阶段预注册材料。⛔ 同 ①:清单只有 `clear_config` 那一份是权威,
    //    这里问的是「那四键里还剩没剩」,用同一份键名。
    if crate::sync::transport::has_pending_identity_material(tx)? {
        return Ok(false);
    }
    // ④ 引擎已撤台。见 [`RuntimeFacts::engine_present`]:它不是 ② 的第二份描述,
    //    守的是「标记刚被删、`reconcile` 还没跑」那个窗口。
    Ok(!engine_present)
}

#[cfg(test)]
mod tests;
