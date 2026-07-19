//! 空间协调器(multispace 工序 7/8,multispace-plan §7/§9/§16.2 提案 B):
//! `foreground_space + phase` 的权威持有者——「捕获落哪、命令打哪」只由它裁决,
//! 前端 UI 态只是它的影子。tauri-free(事件桥/进度事件由命令层注入回调),可单测。
//!
//! **phase 三态(§16.2,codex 设计意见:两种忙碌态必须显式区分,不得从 stopping
//! 状态或一把 async mutex 推断)**:
//! - `Ready`:前台空间 runtime 在场,业务读写直通。
//! - `UserSwitching`:切换编排中——业务写**立即响亮拒**(foreground 语义正在改变,
//!   保存意图有歧义;排队执行会把「看着 A 点保存」变成「切完落 B」)。
//! - `ManualSyncing`:手动「全部同步」遍历中(§7 lean-B)——foreground 恒不变、
//!   session 故意错开;业务写**取消遍历 → 等恢复前台 → 执行**(目标无歧义故等待,
//!   不拒);业务读只读直读前台库(数据静止,SELECT 无副作用)。
//!
//! **business 锁 = `fg` 互斥**(工序 8 验收单「lock-before-get」,codex 工序 2-5
//! 审查 H3 裁决):业务命令「查 phase → `sup.get` → 短事务写」整段持 `fg` 锁,与
//! 切换「翻 phase」互斥——绝不拿着旧 Arc 排队等切换完成后写旧库。锁内只做本地
//! SQL(短事务),不跨网络 await。
//!
//! **编排互斥 `orchestrate`**:切换 / 全部同步串行;不变量 = 只有持有者能把 phase
//! 翻离 `Ready`,放锁时恒已翻回 `Ready`。
//!
//! **账户绑定互斥 `lifecycle`** = §4 的全局 account-binding mutex:创号 / 配对(两端)/
//! 改服务器 / 建空间 / 改名整段串行(账户唯一闸的裁决与后续动作之间不留并发窗口);
//! 它**不**阻塞捕获 / 浏览 / 切空间(§4:配对可跨网络等十分钟,只挡「同时配另一个空间」)。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use tokio::sync::mpsc::UnboundedReceiver;
use zhujian_core::clock::Clock;
use zhujian_core::move_item::MoveResult;
use zhujian_core::spaces::{self, JoiningSlot, SpaceCatalog, SpaceDescriptor};
use zhujian_core::sync::supervisor::{ActivateSpec, ActiveRuntime, SpaceSupervisor};
use zhujian_core::sync::transport::{self, BootCommitLatch, SyncEvent};

/// 手机跨空间移动的图字节预算(codex 安卓实现审 #4):export 把整组配图字节读进
/// 内存、import 再落库,单条目图字节无小上限——超预算响亮拒,别把手机搞 OOM。
/// 128 MiB = 单图上限(32 MiB)的 4 倍,真实笔记极难触达;数值是**手机政策**留壳层。
const MOVE_IMAGE_BUDGET_BYTES: i64 = 128 * 1024 * 1024;

/// 前台状态(§16.2):`space` = 业务命令的唯一合法目标;`phase` 见模块注释。
#[derive(Clone, PartialEq, Debug)]
pub enum Phase {
    Ready,
    UserSwitching,
    ManualSyncing,
}

struct Foreground {
    space: String,
    phase: Phase,
}

/// 手动「全部同步」单空间结果(§7 best-effort 枚举;**只在内存**,不持久化——
/// §12:重启后就是「本次启动尚未尝试」)。绝不合并成一个「已同步」布尔。
#[derive(serde::Serialize, Clone, Debug)]
pub struct SyncOutcome {
    pub space: String,
    pub name: Option<String>,
    /// boot_completed | connected | no_boot_peer | timed_out | failed | cancelled
    pub outcome: &'static str,
    /// 本轮确有进展:远端 op 落库/字节到齐(SyncEvent::Changed)**或**本机待发 op
    /// 获得服务器 Ack(last_pushed 前后抬升,§7「本机 Ack 推进」也算进展)。
    pub progressed: bool,
    /// 人话细节(失败原因/超时时的最后错误)。
    pub detail: Option<String>,
}

/// 一次「全部同步」的整体回执:per-space 结果 + 收尾恢复前台是否顺利。恢复失败
/// **不吞掉已积累的结果**(§12 结果诚实)——前台没 runtime 时业务命令会响亮
/// 「未知空间」,重启可救,但用户必须先看到这轮各空间到底跑成了什么样。
#[derive(serde::Serialize, Debug)]
pub struct SyncAllReport {
    pub outcomes: Vec<SyncOutcome>,
    pub restore_error: Option<String>,
}

/// 「全部同步」的时限参数(§7:有界 best-effort)。默认值:每空间 45s(引导快照
/// 从来就含图字节、实测家庭规模 0.3MB 亚秒级;117 起 Full 下行变重的是 live 追赶
/// [want/pull 补历史缺图]——预算对家庭规模仍宽裕,拉不完 = timed_out 如实带图数、
/// 下轮从缺口清单接着补,**半途中断的图整张重拉**[分块缓冲只在内存])、整次全局
/// 240s 封顶、online 后静默 3s **且无缺字节图**才认为这轮追赶到头(117/codex H2:
/// blob 分块不发事件,纯事件静默会误杀拉图中的会话;lean-B 无「信箱已排空」协议
/// 信号,§7 诚实局限)。
/// 测试注入短时限,产品代码用 `default()`。
#[derive(Clone)]
pub struct SweepTimings {
    pub per_space: Duration,
    pub global_cap: Duration,
    pub quiet: Duration,
}

impl Default for SweepTimings {
    fn default() -> SweepTimings {
        SweepTimings {
            per_space: Duration::from_secs(45),
            global_cap: Duration::from_secs(240),
            quiet: Duration::from_secs(3),
        }
    }
}

pub struct Coord {
    pub sup: Arc<SpaceSupervisor>,
    pub data_dir: PathBuf,
    /// 严格 catalog 快照(启动 `SpaceCatalog::load`;创建/配对/改名后重 load 刷新
    /// ——catalog 永远来自 load,不存在手工拼出来的部分快照)。
    catalog: Mutex<SpaceCatalog>,
    /// [`refresh_catalog`] 的重载互斥:覆盖「load + swap」全段(codex 实现审 H1)——
    /// 只锁最终赋值会让先开扫、后拿锁的旧快照把新快照盖回去(陈旧持续到下次显式
    /// 重扫)。串行化后每次 load 都始于上一次 swap 之后,最后一次 swap 恒是最新盘面。
    reload: Mutex<()>,
    fg: Mutex<Foreground>,
    /// ManualSyncing 的等待者(with_write 的 Busy 分支)在此等恢复。
    fg_notify: tokio::sync::Notify,
    orchestrate: tokio::sync::Mutex<()>,
    pub lifecycle: tokio::sync::Mutex<()>,
    /// Some = 全部同步正在跑(取消信号;admission 归 `heavy`)。
    sync_cancel: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    /// sync_all ↔ join_space 的原子 admission(space-entry-plan §3.3,codex 二轮
    /// H2):两个入口在**同一把同步锁**下 `Idle → 自己`,「先查后写」的反向竞态
    /// (sync_all 先进 ManualSyncing、join 随后启动 staging transport 并存)从此
    /// 关死。释放走 RAII [`HeavyOpGuard`](Drop 无条件恢复 Idle)。
    heavy: Arc<Mutex<HeavyOp>>,
    /// Some = 加入正在跑(取消信号;只取消工作,**不碰 HeavyOp 状态**——三轮 M4)。
    join_cancel: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    /// 账户 reservation(§3.5):join 的 GrantPending 裁决起占、Integrated 释放;
    /// publish/清理/集成失败后**保留到进程重启**(fail-closed:防「publish 成功、
    /// rescan 失败,重试二次加入同一账户」)。创号/main 配对的账户闸一并查它。
    account_reservations: Mutex<HashSet<String>>,
    /// Coord 内部(sync_all 恢复前台 / 切换回滚)激活出的 runtime 事件接收端——
    /// Coord 无 AppHandle 接不了桥,存这里由命令层取走桥接;丢弃 = 事件石沉大海。
    pending_bridge: Mutex<Option<(String, u64, UnboundedReceiver<SyncEvent>)>>,
    timings: SweepTimings,
}

/// with_write 的裁决结果:Busy 由调用方(async 命令层)取消遍历后等通知重试。
pub enum WriteAttempt<T> {
    Done(Result<T, String>),
    Busy,
}

/// sync_all ↔ join_space 的重活 admission 状态(space-entry-plan §3.3)。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HeavyOp {
    Idle,
    SyncAll,
    Joining,
}

/// staging transport 任务的共享句柄槽:正常路 `stop_staging` 从槽里取走收口;
/// join future 被整个 drop 时由 [`HeavyOpGuard`] 的 Drop 接管(abort + reaper)。
type StagingTaskSlot = Arc<Mutex<Option<tokio::task::JoinHandle<transport::TransportExit>>>>;

/// staging transport 的收口例程:shutdown → 限时等退出;不退就 abort 强杀并等到
/// 真消亡(丢句柄 = detach,任务还持 DB Arc,槽清不掉而 admission 又已释放)。
/// abort 落在 await 点 = 事务边界,撕不裂 SQLite 事务(supervisor 停机同款论证)。
///
/// **取消安全(codex 三轮 M1)**:句柄取出后本 future 若在 await 中被 drop,
/// `PutBack` 归还守卫把句柄放回槽——外层 admission guard 的 Drop 仍能接管
/// (abort + reaper),绝不 detach;确认消亡后才置 None 不归还(归还已完成句柄
/// 无害:reaper 首次 await 立即 Ready)。
async fn stop_staging(shutdown_tx: &tokio::sync::watch::Sender<bool>, slot: &StagingTaskSlot) {
    struct PutBack<'a> {
        slot: &'a StagingTaskSlot,
        h: Option<tokio::task::JoinHandle<transport::TransportExit>>,
    }
    impl Drop for PutBack<'_> {
        fn drop(&mut self) {
            if let Some(h) = self.h.take() {
                *self.slot.lock().expect("staging slot mutex poisoned") = Some(h);
            }
        }
    }
    let mut ret = PutBack { slot, h: slot.lock().expect("staging slot mutex poisoned").take() };
    let Some(h) = ret.h.as_mut() else { return };
    let _ = shutdown_tx.send(true);
    if tokio::time::timeout(Duration::from_secs(10), &mut *h).await.is_err() {
        h.abort();
        let _ = (&mut *h).await;
    }
    ret.h = None; // 已确认消亡(与上一行之间无 await,不存在取消窗)
}

/// 重活 admission 的 RAII 凭据(三轮 M4):Drop 恢复 Idle——手工 take()/复位模式
/// 会让某个错误分支把 app 永久卡在 Joining 直到重启。取得必须在**任何 await、建槽
/// 之前**;持有到 Integrated/终败。
///
/// **staging 槽联动(codex 二轮 M1)**:tokio abort 是协作式取消——staging 任务
/// 正在同步段(SQLite 导入/integrity)时,abort 要到下个 await 点才生效;若 Drop
/// 立刻翻 Idle,新 join/sync_all 会与垂死的旧 staging transport 并存。故 Drop 时
/// 槽里还有活任务 = 先 abort,再由 reaper 任务 **await 到它真消亡才翻 Idle**;
/// 槽空(正常路已 stop_staging 收口)= 立即 Idle。
pub struct HeavyOpGuard {
    state: Arc<Mutex<HeavyOp>>,
    staging: Option<StagingTaskSlot>,
}

impl HeavyOpGuard {
    /// 同一把同步锁下 `Idle → want`;非 Idle 返回占用者(调用方拼人话)。
    fn acquire(state: &Arc<Mutex<HeavyOp>>, want: HeavyOp) -> Result<HeavyOpGuard, HeavyOp> {
        let mut s = state.lock().expect("heavy mutex poisoned");
        if *s != HeavyOp::Idle {
            return Err(*s);
        }
        *s = want;
        Ok(HeavyOpGuard { state: state.clone(), staging: None })
    }

    /// 登记 staging 任务槽(join 专用;sync_all 不挂,Drop 即时 Idle)。
    fn attach_staging(&mut self, slot: StagingTaskSlot) {
        self.staging = Some(slot);
    }
}

impl Drop for HeavyOpGuard {
    fn drop(&mut self) {
        let pending = self.staging.as_ref().and_then(|s| {
            s.lock().expect("staging slot mutex poisoned").take()
        });
        match pending {
            None => *self.state.lock().expect("heavy mutex poisoned") = HeavyOp::Idle,
            Some(h) => {
                h.abort();
                let state = self.state.clone();
                match tokio::runtime::Handle::try_current() {
                    Ok(rt) => {
                        rt.spawn(async move {
                            let _ = h.await; // 等到任务真消亡(abort 在下个 await 点落地)
                            *state.lock().expect("heavy mutex poisoned") = HeavyOp::Idle;
                        });
                    }
                    // 运行时已收场(进程退出路):无并存风险,直接复位。
                    Err(_) => *state.lock().expect("heavy mutex poisoned") = HeavyOp::Idle,
                }
            }
        }
    }
}

/// 「加入空间」的结果 DTO(space-entry-plan §3.2 三轮 M5:普通 `Result<space_id>`
/// 表达不了「已发布但收尾失败」)。**只有 publish 之前的失败走 Err**;
/// `PublishedNeedsRestart` = 空间已真实存在、账户已注册,绝不谎报失败、绝不按
/// 「失败无痕」删库——本进程对该账户 fail-closed,重启恢复。
#[derive(serde::Serialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JoinOutcome {
    Integrated { space: JoinedSpace, warnings: Vec<String> },
    PublishedNeedsRestart { space_id: String, error: String },
}

/// Integrated 携带的空间概要(与 lib.rs SpaceInfo 同形字段,跨端 DTO 稳定面)。
#[derive(serde::Serialize, Debug)]
pub struct JoinedSpace {
    pub id: String,
    pub name: Option<String>,
    pub configured: bool,
}

/// 创号结果(phone-space-plan §2.1):core 一旦提交,恢复码**必须**交到仪式页;
/// post-commit 阶段(catalog 重扫/poke)的失败只旁路报告,绝不吞码(codex r1 #5)。
#[derive(serde::Serialize, Clone, Debug)]
pub struct CreateAccountOutcome {
    pub recovery_code: String,
    pub post_commit_error: Option<String>,
}

/// 出码结果(实现审 M3):配对码与服务器地址**同一 runtime 原子取**——前端若从
/// 状态缓存拼 server_url,切空间窗口里会给出「新空间的码 + 旧空间的地址」,电脑
/// 连错服务器白烧一次码。
#[derive(serde::Serialize, Clone, Debug)]
pub struct PairStartOutcome {
    pub code: String,
    pub server_url: String,
}

impl Coord {
    pub fn new(sup: Arc<SpaceSupervisor>, data_dir: PathBuf, catalog: SpaceCatalog) -> Coord {
        Coord::with_timings(sup, data_dir, catalog, SweepTimings::default())
    }

    pub fn with_timings(
        sup: Arc<SpaceSupervisor>,
        data_dir: PathBuf,
        catalog: SpaceCatalog,
        timings: SweepTimings,
    ) -> Coord {
        Coord {
            sup,
            data_dir,
            catalog: Mutex::new(catalog),
            reload: Mutex::new(()),
            fg: Mutex::new(Foreground { space: spaces::MAIN_SPACE.into(), phase: Phase::Ready }),
            fg_notify: tokio::sync::Notify::new(),
            orchestrate: tokio::sync::Mutex::new(()),
            lifecycle: tokio::sync::Mutex::new(()),
            sync_cancel: Mutex::new(None),
            heavy: Arc::new(Mutex::new(HeavyOp::Idle)),
            join_cancel: Mutex::new(None),
            account_reservations: Mutex::new(HashSet::new()),
            pending_bridge: Mutex::new(None),
            timings,
        }
    }

    /// 取走 Coord 内部激活时存下的事件接收端(命令层在 switch_to / sync_all 返回后
    /// 调它接桥)。
    pub fn take_pending_bridge(&self) -> Option<(String, u64, UnboundedReceiver<SyncEvent>)> {
        self.pending_bridge.lock().expect("pending_bridge mutex poisoned").take()
    }

    // ---- catalog ----

    /// 目标空间的描述符副本(不存在 = 响亮拒,绝不隐式建)。
    pub fn descriptor(&self, id: &str) -> Result<SpaceDescriptor, String> {
        self.catalog
            .lock()
            .expect("catalog mutex poisoned")
            .spaces()
            .iter()
            .find(|d| d.id == id)
            .cloned()
            .ok_or_else(|| format!("未知空间:{id}"))
    }

    /// 全部空间描述符副本(主库恒第一)。
    pub fn all_descriptors(&self) -> Vec<SpaceDescriptor> {
        self.catalog.lock().expect("catalog mutex poisoned").spaces().to_vec()
    }

    /// 重扫 catalog(创建/配对/改名之后)。严格 fail-closed:重扫失败 = 保留旧快照
    /// 并 Err(下次启动同样会响亮;不许把「刷新失败」静默吞成「没变化」)。
    /// **重载互斥覆盖 load+swap 全段**(codex 实现审 H1):并发调用串行化,杜绝
    /// 「先开扫的旧快照最后拿锁盖回新快照」。
    pub fn refresh_catalog(&self) -> Result<(), String> {
        let _reload = self.reload.lock().expect("reload mutex poisoned");
        let main_db = self.data_dir.join("notebook.sqlite3");
        let fresh = SpaceCatalog::load(&main_db, Some(&self.data_dir), None)?;
        *self.catalog.lock().expect("catalog mutex poisoned") = fresh;
        Ok(())
    }

    // ---- 前台状态 ----

    pub fn foreground(&self) -> (String, Phase) {
        let fg = self.fg.lock().expect("fg mutex poisoned");
        (fg.space.clone(), fg.phase.clone())
    }

    fn set_phase(&self, phase: Phase) {
        let ready = phase == Phase::Ready;
        self.fg.lock().expect("fg mutex poisoned").phase = phase;
        if ready {
            self.fg_notify.notify_waiters();
        }
    }

    fn set_foreground(&self, space: String, phase: Phase) {
        {
            let mut fg = self.fg.lock().expect("fg mutex poisoned");
            fg.space = space;
            fg.phase = phase.clone();
        }
        if phase == Phase::Ready {
            self.fg_notify.notify_waiters();
        }
    }

    // ---- 业务读写(§16.2 提案 B 的兑现) ----

    /// 业务写:「查 phase → get → 短事务」整段持 fg 锁(lock-before-get)。
    /// `space_id` 是前端「点击时看到的空间」——与 foreground 不符 = 响亮拒,
    /// 绝不改写目标、绝不随手读最新前台。
    pub fn with_write<T>(
        &self,
        space_id: &str,
        f: impl FnOnce(&mut Connection, &mut Clock) -> Result<T, String>,
    ) -> WriteAttempt<T> {
        let fg = self.fg.lock().expect("fg mutex poisoned");
        match fg.phase {
            Phase::UserSwitching => WriteAttempt::Done(Err("正在切换空间,稍等再记".into())),
            Phase::ManualSyncing => WriteAttempt::Busy,
            Phase::Ready => {
                if fg.space != space_id {
                    return WriteAttempt::Done(Err(
                        "目标空间已经变化,请在当前空间重试".into()
                    ));
                }
                let rt = match self.sup.get(space_id) {
                    Ok(rt) => rt,
                    Err(e) => return WriteAttempt::Done(Err(e)),
                };
                let (mut conn, mut clock) = rt.write_locks();
                // transport 以 ReopenRequired 收场(引导已提交、连接须重开):旧
                // runtime 不再接受写(space-entry-plan §3.2)。复核在**拿到写锁之后**
                // (codex 二轮 M2):旗与导入共临界区,排队在这把锁上的写拿到锁时
                // 旗必已在——锁前查会漏「查时 None → 阻塞 → 导入提交落旗 → 抢锁写」。
                if let Some(e) = rt.restart_required() {
                    return WriteAttempt::Done(Err(format!(
                        "此空间的同步会话需要重启:{e}——切换空间后切回,或重启应用"
                    )));
                }
                WriteAttempt::Done(f(&mut conn, &mut clock))
            }
        }
    }

    /// 业务写的完整路(async 命令层用):Busy = 请求取消遍历、等恢复前台后执行
    /// (§7「用户写入立即请求恢复前台空间、到安全点后执行」——UI 等待,不误发
    /// 别的空间、也不静默丢)。
    pub async fn write<T>(
        &self,
        space_id: &str,
        mut f: impl FnMut(&mut Connection, &mut Clock) -> Result<T, String>,
    ) -> Result<T, String> {
        loop {
            // 先领号再裁决:notified() 在查 phase 之前立好等待队列,恢复通知
            // 与「查完是 Busy」之间零窗口(先查再等会丢通知)。
            let notified = self.fg_notify.notified();
            match self.with_write(space_id, &mut f) {
                WriteAttempt::Done(r) => return r,
                WriteAttempt::Busy => {
                    self.request_cancel_sync_all();
                    notified.await;
                }
            }
        }
    }

    /// 业务读:Ready 直通 runtime;ManualSyncing 只读直读前台库(session 在别处、
    /// 本地数据静止,SELECT 无副作用——读不该打断遍历,否则 UI 一次自动刷新就把
    /// 「全部同步」取消了);UserSwitching 瞬态响亮拒(前端切换完成后自会重拉)。
    pub fn with_read<T>(
        &self,
        space_id: &str,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let fg = self.fg.lock().expect("fg mutex poisoned");
        if fg.space != space_id {
            return Err("目标空间已经变化".into());
        }
        match fg.phase {
            Phase::UserSwitching => Err("正在切换空间".into()),
            Phase::Ready => {
                let rt = self.sup.get(space_id)?;
                let conn = rt.db.lock().expect("db mutex poisoned");
                f(&conn)
            }
            Phase::ManualSyncing => {
                let desc = self.descriptor(space_id)?;
                let conn = Connection::open_with_flags(
                    &desc.path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )
                .map_err(|e| format!("只读打开空间 {space_id} 失败:{e}"))?;
                conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
                // 只读旁路也过文件身份复核,且**先开后验**(与 open_space 同序,
                // 工序 7/8 L1/二审 L2):开着的连接钉住 inode,再验路径——文件在
                // 开与验之间被换必被抓;只读不迁移不写,危害低于开库正道,但
                // 不变量一个口径,不给「读到别的库」留旁门。
                let key = spaces::native_file_key(&desc.path)?;
                if key != desc.file {
                    return Err(format!("空间 {space_id} 的库文件在扫描后被替换"));
                }
                f(&conn)
            }
        }
    }

    /// 控制命令(配对/改服务器/改名)的前台闸:目标必须 = 前台空间且 Ready。
    /// 切换/遍历中不开账户动作——裁决那一刻的世界观必须稳定。
    pub fn control_runtime(&self, space_id: &str) -> Result<Arc<ActiveRuntime>, String> {
        let fg = self.fg.lock().expect("fg mutex poisoned");
        if fg.phase != Phase::Ready {
            return Err("空间正忙(切换或全部同步进行中),稍后再试".into());
        }
        if fg.space != space_id {
            return Err("目标空间已经变化,请在当前空间重试".into());
        }
        let rt = self.sup.get(space_id)?;
        if let Some(e) = rt.restart_required() {
            return Err(format!(
                "此空间的同步会话需要重启:{e}——切换空间后切回,或重启应用"
            ));
        }
        Ok(rt)
    }

    // ---- 跨空间移动(cross-space-move-plan §2.7 安卓入口) ----

    /// 把**前台空间**的一条活跃条目移进 `target`。关键不对称(安卓):卡片只显前台
    /// → 源恒=前台 live 空间、目标恒=非 live 空间。源走前台 runtime 写锁(与同步
    /// 回放串行),目标开**一次性 RW 连接**(不进 supervisor、不占 live 槽、无
    /// transport;移动产生的 op 待下次激活/全部同步推入目标账户,§4 分布式边界)。
    /// 三原语 export→import→finalize,先建后删(重复优于丢失),裸 Err→unconfirmed
    /// 绝不丢 new_id。
    ///
    /// codex 安卓实现审五必修全折入:先取消 sync_all(免拿着 lifecycle 排 orchestrate
    /// 数分钟堵住配对/创号)→ lifecycle→orchestrate 双锁(挡账户编排 + 前台变更;
    /// 命令层**不得**再重复拿 lifecycle,tokio mutex 不可重入)→ 锁内 refresh_catalog
    /// 拿新鲜「无 veto」证明 → 前台闸(源=fg 且 Ready)→ is_stopped 证目标完全无槽
    /// (Resetting 墓碑也算在场,open_space 绕过它会写坏正被重置的库)→ 图字节预算。
    pub async fn move_between(
        &self,
        source: &str,
        target: &str,
        item_id: &str,
    ) -> Result<MoveResult, String> {
        if source == target {
            return Err("目标空间就是当前空间,无需移动".into());
        }
        let _life = self.lifecycle.lock().await;
        // sync_all 可持 orchestrate 数分钟。竞态(codex 实现审 #1):它先登记
        // sync_cancel 再抢 orchestrate,若在我们第一次 cancel **之后**才登记,单次
        // cancel 落空、移动会拿着 lifecycle 空等整轮 sweep,堵住配对/创号。修:**pin
        // 住同一个 orchestrate.lock() future**(不丢排队位)边等边每 50ms 重发 cancel,
        // 直到拿到锁——sync_all 登记多晚都会被后续的重发追上、秒级收摊。
        let orch_fut = self.orchestrate.lock();
        tokio::pin!(orch_fut);
        let _orch = loop {
            self.request_cancel_sync_all();
            tokio::select! {
                g = &mut orch_fut => break g,
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
        };
        // 锁内重扫 catalog:严格 fail-closed catalog 恒无身份 veto,但那是启动旧快照的
        // 事实;持锁后重扫,让「无 veto」是本命令当下的后端事实(codex #3)。
        self.refresh_catalog()?;
        let target_desc = self.descriptor(target)?;
        // 前台闸:源必须 = 当前前台且 Ready(移动的卡来自前台空间)。
        {
            let fg = self.fg.lock().expect("fg mutex poisoned");
            if fg.phase != Phase::Ready {
                return Err("空间正忙(切换或全部同步进行中),稍后再移".into());
            }
            if fg.space != source {
                return Err("目标空间已经变化,请在当前空间重试".into());
            }
        }
        // 目标必须完全无槽(Stopped):双锁已冻结 live 表(切换/遍历/重置/账户激活全
        // 需这两把锁之一),此刻的 is_stopped 到 open_space 之间目标不会被激活;
        // Resetting 墓碑期显式挡(codex #1)。
        if !self.sup.is_stopped(target) {
            return Err("目标空间正忙(同步或重置进行中),稍后再移".into());
        }
        let src_rt = self.sup.get(source)?;

        // 原语一:导出(持源=前台 runtime 写锁;图字节预算先查后导,防手机 OOM)。
        let pkg = {
            let (mut conn, _clk) = src_rt.write_locks();
            // ReopenRequired 写闸(§3.2,锁内复核——move 的一次性写不许落在已判废
            // 连接上;目标端 open_space 开的是新连接,不受此旗约束)。
            if let Some(e) = src_rt.restart_required() {
                return Err(format!("当前空间需要重启应用完成初始同步装配,暂不能移动:{e}"));
            }
            let bytes = zhujian_core::move_item::item_image_bytes(&conn, item_id)?;
            if bytes > MOVE_IMAGE_BUDGET_BYTES {
                return Err(format!(
                    "这条的配图共 {} MB,超出手机跨空间移动上限({} MB),暂不支持",
                    bytes / (1024 * 1024),
                    MOVE_IMAGE_BUDGET_BYTES / (1024 * 1024)
                ));
            }
            match zhujian_core::move_item::export(&mut conn, item_id)? {
                zhujian_core::move_item::ExportOutcome::Ready(p) => *p,
                zhujian_core::move_item::ExportOutcome::ImagesPending { count } => {
                    return Ok(MoveResult::ImagesPending { count })
                }
                zhujian_core::move_item::ExportOutcome::DanglingRefs { seqs } => {
                    return Ok(MoveResult::DanglingRefs { seqs })
                }
            }
        };
        // 原语二:目标导入(一次性 RW 连接——open_space 复核版本+文件身份+切 WAL,
        // 连接 drop 即结束;失败整体回滚,源分毫未动)。
        let new_id = {
            let mut conn = spaces::open_space(&target_desc)?;
            let mut clock = Clock::load(&conn)?;
            zhujian_core::move_item::import(&mut conn, &mut clock, &pkg)?
        };
        // 原语三:源删除(重取源写锁,重验指纹;裸 Err→unconfirmed,绝不丢 new_id)。
        let fin = {
            let (mut conn, mut clk) = src_rt.write_locks();
            if let Some(e) = src_rt.restart_required() {
                // 目标已建、源删被旗挡:如实走 unconfirmed 家族(绝不丢 new_id)。
                Err(format!("源空间需要重启应用完成初始同步装配,删除未执行:{e}"))
            } else {
                zhujian_core::move_item::finalize_source(&mut conn, &mut clk, &pkg)
            }
        };
        Ok(MoveResult::from_finalize(new_id, fin))
    }

    // ---- 装配(启动 / 切换 / 遍历共用一条正道) ----

    /// 从 catalog 描述符激活一个空间:开库正道(NO_CREATE / 不迁移 / 先验后写)→
    /// 时钟 → supervisor(expected_file 复核)。返回事件接收端,桥/观察由调用方接。
    pub fn activate_from_descriptor(
        &self,
        desc: &SpaceDescriptor,
    ) -> Result<(Arc<ActiveRuntime>, UnboundedReceiver<SyncEvent>), String> {
        // M1(工序 9 二审):先原子预留槽(查重/占 permit)——早于 open_space 开任何
        // 读写连接,让重复/超限在开第二条连接之前就拒(回滚/恢复前台路径原先先开库
        // 后查槽,撞 Stopping 会瞬时开出第二条连接)。reserve→commit 全同步无 await。
        let reservation = self.sup.reserve(&desc.id)?;
        let mut conn = spaces::open_space(desc)?;
        let mut clock = Clock::load(&conn)?;
        // 存量空间名补发自愈步(space-name-sync-plan §5):安卓库版本不等即清库重配,
        // 正常永无遗留 key(恒 no-op 一次 SELECT);与桌面装配点同纪律,防御性统一。
        spaces::heal_legacy_space_name(&mut conn, &mut clock)?;
        let (ev_tx, ev_rx) = tokio::sync::mpsc::unbounded_channel();
        let rt = reservation.commit(
            ActivateSpec {
                id: desc.id.clone(),
                path: desc.path.clone(),
                expected_file: Some(desc.file),
                events: ev_tx,
                boot_dir: self.data_dir.clone(),
                // 117 起手机也全量下行图字节(反转 android-plan §4 M1,用户拍板:
                // 手机可以是唯一主力端,桌面贴的图必须看得到)。既有 MetadataOnly 库
                // 自愈:Full 引擎 on_connected 重新派生缺图清单补拉(engine.rs
                // 「切回 Full 必须重新发现缺图并发 want」测试锚),不用清库。
                blob_policy: transport::BlobPolicy::Full,
                // 可当引导快照源(phone-space-plan §2.3 反转 96 的拒当源政策——
                // 手机创号的空间在 PC 会师前本机就是唯一副本,不当源这条路不通)。
                // 字节有洞时 core 的 boot_serve_snapshot 防线自动拒供(§1.1,端
                // 无关);供流期间 app 需存活在前台(UI 文案约定,不做机械保活)。
                allow_boot_source: true,
                // 严格 catalog 下四不变量有违早已整体 Err,到得了这里恒无 veto。
                sync_veto: None,
            },
            conn,
            clock,
        )?;
        Ok((rt, ev_rx))
    }

    // ---- 创号 / 邀请(phone-space-plan §2,与桌面对称) ----

    /// 创建同步账户(账户首台;open-signup 无感创号:账户 ULID 由 core 自生成,
    /// 无码无预检——自生成与既有空间撞号=违背 ULID 唯一性假设,账户闸只管外来
    /// 账户 ID 的配对/加入)。纪律 = `sync_pair_join` 同款:lifecycle 锁(账户
    /// 绑定互斥)+ `begin_op`(H1:跨 await 持 rt 必登记为长命令,stop 等它收场)
    /// + shutdown 取消(切走空间即放弃;biased 平局归成功路——core §1.2 提交后
    /// 零 await,「已落库却报取消」不存在)。
    ///
    /// 半途态(RegisterFirst 已发、配置未落,取消或崩溃):服务器可能留下孤儿注册
    /// ——恢复=把错误文案里的本机设备号报给运营者按 device 吊销,**原库原样重试,
    /// 不清库**(core 的 DEVICE_ID_TAKEN 文案已按此指路,open-signup §1.5)。
    pub async fn create_account(
        &self,
        space_id: &str,
        server_url: &str,
    ) -> Result<CreateAccountOutcome, String> {
        let _life = self.lifecycle.lock().await;
        let rt = self.control_runtime(space_id)?;
        let _op = rt
            .begin_op()
            .ok_or_else(|| "空间正在停止,无法创建账户(稍后重试)".to_string())?;
        let mut cancel = rt.subscribe_shutdown();
        let create = transport::create_account(&rt.db, server_url);
        let outcome: Result<String, String> = tokio::select! {
            biased;
            r = create => r,
            _ = cancel.wait_for(|v| *v) => {
                Err("创号已取消:切换了空间(切回该空间后重试)".into())
            }
        };
        drop(rt);
        let recovery_code = outcome?;
        // post-commit:恢复码已在手,后续失败只旁路报告——绝不让整条命令变 Err
        // 把码吞掉(codex r1 #5;强制仪式必须拿到码)。
        let post_commit_error = self.finish_account_creation(space_id).await;
        Ok(CreateAccountOutcome { recovery_code, post_commit_error })
        // _op 在此 drop(最后):收尾全程登记在册,stop 等到这里才放行。
    }

    /// 创号 post-commit 收尾:catalog 重扫 + 现任 runtime poke 上线。任何一步失败
    /// 都累积进返回值(实现审 M2:不许 `let _` 静默吞),由调用方随恢复码一起交给
    /// UI——单独成方法,坏 catalog 可注入单测。例外:`sup.get` 拿不到现任 = 用户
    /// 已切走空间,新配置由下次激活读取,**不是错误**(poke 的唯一意义是叫醒现任)。
    pub async fn finish_account_creation(&self, space_id: &str) -> Option<String> {
        let mut errs: Vec<String> = Vec::new();
        if let Err(e) = self.refresh_catalog() {
            errs.push(format!("空间目录刷新失败:{e}"));
        }
        if let Ok(rt) = self.sup.get(space_id) {
            if rt.control.send(transport::Control::Reconfigured).await.is_err() {
                errs.push("同步任务未响应上线通知".into());
            }
        }
        (!errs.is_empty())
            .then(|| format!("账户已创建,但收尾未完成:{}——请重启应用后使用", errs.join(";")))
    }

    /// 发起配对(老设备侧,出配对码)。超时所有权在 core(§1.3:开槽 15s、码 TTL
    /// 600s、receiver 无人接即收口烧槽);壳层 30s 只是「PairOpen 发送在死链路上
    /// 挂死」的兜底,不承担业务语义。返回码 + 服务器地址(同 runtime 原子取,
    /// 实现审 M3;读在开槽**之前**,失败零副作用不烧槽)。
    pub async fn pair_start(&self, space_id: &str) -> Result<PairStartOutcome, String> {
        let _life = self.lifecycle.lock().await;
        let rt = self.control_runtime(space_id)?;
        let _op = rt
            .begin_op()
            .ok_or_else(|| "空间正在停止,无法发起配对(稍后重试)".to_string())?;
        let server_url: String = {
            let conn = rt.db.lock().expect("db mutex poisoned");
            conn.query_row("SELECT value FROM sync_meta WHERE key='server_url'", [], |r| r.get(0))
                .map_err(|e| format!("读本空间服务器地址失败(未配置账户?):{e}"))?
        };
        let mut cancel = rt.subscribe_shutdown();
        let (tx, rx) = tokio::sync::oneshot::channel();
        rt.control
            .send(transport::Control::PairStart { reply: tx })
            .await
            .map_err(|_| "同步任务未运行".to_string())?;
        let out: Result<String, String> = tokio::select! {
            biased;
            r = tokio::time::timeout(Duration::from_secs(30), rx) => match r {
                Ok(Ok(reply)) => reply,
                Ok(Err(_)) => Err("配对请求被放弃(连接中断?)".into()),
                Err(_) => Err("发起配对超时(网络不通?)".into()),
            },
            _ = cancel.wait_for(|v| *v) => Err("配对已取消:切换了空间".into()),
        };
        drop(rt);
        Ok(PairStartOutcome { code: out?, server_url })
    }

    // ---- 加入空间(space-entry-plan §3,JoinManager) ----

    /// 账户唯一性的权威裁决(§3.5):**重扫磁盘正式候选**(不信缓存 catalog/
    /// runtime 表——「publish 成功、rescan 失败」的新正式文件不在缓存里)+ 查
    /// 进程内 reservation。`exclude` = 正在绑定账户的空间自身(创号/main 配对)。
    /// 任一候选读不出 = fail-closed Err(绝不「读不到就当没占用」)。
    pub fn account_free(&self, exclude: Option<&str>, acc: &str) -> Result<(), String> {
        if self
            .account_reservations
            .lock()
            .expect("reservations mutex poisoned")
            .contains(acc)
        {
            return Err(
                "这个账户正在(或刚刚)被「加入空间」使用——空间=账户,一空间一账户;若刚才加入失败,重启应用后再试"
                    .into(),
            );
        }
        let main_db = self.data_dir.join("notebook.sqlite3");
        for (id, path) in spaces::discover(&main_db, Some(&self.data_dir), None)? {
            if Some(id.as_str()) == exclude {
                continue;
            }
            let d = spaces::read_descriptor(&id, &path)?;
            if d.account_id.as_deref() == Some(acc) {
                let label = d.name.clone().unwrap_or_else(|| {
                    if id == spaces::MAIN_SPACE { "默认空间".into() } else { id.clone() }
                });
                return Err(format!(
                    "这个账户已被空间「{label}」使用——空间=账户,一空间一账户"
                ));
            }
        }
        Ok(())
    }

    /// 请求取消进行中的「加入空间」(独立 cancel token,不抢 lifecycle、不碰
    /// HeavyOp——三轮 M4)。只在 BootCommitted 之前生效;提交与取消同时就绪时
    /// 成功优先(join_space 的 select 是 biased、提交臂在前)。
    pub fn request_cancel_join(&self) {
        if let Some(tx) = self.join_cancel.lock().expect("join_cancel mutex poisoned").as_ref() {
            let _ = tx.send(true);
        }
    }

    fn release_reservation(&self, reserved: &Mutex<Option<String>>) {
        if let Some(acc) = reserved.lock().expect("reserved mutex poisoned").take() {
            self.account_reservations
                .lock()
                .expect("reservations mutex poisoned")
                .remove(&acc);
        }
    }

    /// 「加入空间」全程编排(§3.2 状态机 Preparing → Paired → BootCommitted →
    /// Published → Integrated):隐式 `.joining-*` 槽上完成配对 + 完整 `Transport::run`
    /// 引导,close → publish → catalog 重扫,成功才成为用户可见空间。**不收目标
    /// space_id**(一轮 H3:空槽不暴露);main 的配对加入仍走 `sync_pair_join`。
    ///
    /// 并发模型(§3.3):「最多 1 个 catalog runtime + 最多 1 个 joining transport」
    /// ——admission 见 [`HeavyOpGuard`](任何 await/建槽之前取得);lifecycle 从建槽
    /// 持到 Integrated(账户绑定互斥;捕获/浏览/切空间不受阻)。
    ///
    /// `on_progress(phase, received, total)`:preparing/pairing/booting/publishing
    /// /integrating;booting 携引导字节进度。
    pub async fn join_space(
        &self,
        server_url: &str,
        code: &str,
        on_progress: impl Fn(&'static str, i64, i64) + Send + Sync + 'static,
    ) -> Result<JoinOutcome, String> {
        // admission:同步锁下 Idle → Joining(任何 await、建槽之前;三轮 M4)。
        let mut heavy_guard = HeavyOpGuard::acquire(&self.heavy, HeavyOp::Joining).map_err(|by| match by {
            HeavyOp::SyncAll => "「全部同步」正在进行,完成后再加入空间".to_string(),
            _ => "已有一次「加入空间」在进行中".to_string(),
        })?;
        // 取消信号槽(single-flight 已由 heavy 保证;槽由 RAII 清,任何退出路都不残留)。
        let mut cancel_rx = {
            let (tx, rx) = tokio::sync::watch::channel(false);
            *self.join_cancel.lock().expect("join_cancel mutex poisoned") = Some(tx);
            rx
        };
        struct CancelSlot<'a>(&'a Coord);
        impl Drop for CancelSlot<'_> {
            fn drop(&mut self) {
                self.0.join_cancel.lock().expect("join_cancel mutex poisoned").take();
            }
        }
        let _cancel_slot = CancelSlot(self);
        let on_progress = Arc::new(on_progress);
        // 账户绑定互斥:建槽到 Integrated 全程持有(§3.3;幸福路上账户唯一裁决
        // 无需扫 staging——staging 本就不在发现面里)。
        let _life = self.lifecycle.lock().await;

        // ---- Preparing:建槽 + 配对(专用短连接;完成 = 配置四键落槽库) ----
        on_progress("preparing", 0, 0);
        let slot = JoiningSlot::create(&self.data_dir)?;
        let reserved: Mutex<Option<String>> = Mutex::new(None);
        on_progress("pairing", 0, 0);
        let pair_outcome: Result<(), String> = {
            let gate_cancel = cancel_rx.clone();
            let gate = |acc: &str| -> Result<(), String> {
                // 裁决在 WriterLease(app 常驻)+ lifecycle 下,重扫磁盘不信缓存。
                self.account_free(None, acc)?;
                // approve/Enroll 前最后一刻查取消(与 sync_pair_join 同窗口纪律)。
                if *gate_cancel.borrow() {
                    return Err("已取消加入".into());
                }
                self.account_reservations
                    .lock()
                    .expect("reservations mutex poisoned")
                    .insert(acc.to_string());
                *reserved.lock().expect("reserved mutex poisoned") = Some(acc.to_string());
                Ok(())
            };
            let slot_db = slot.db();
            let join = transport::pair_join(&slot_db, server_url, code, gate);
            tokio::select! {
                biased;
                r = join => r,
                _ = cancel_rx.wait_for(|v| *v) => Err("已取消加入空间".into()),
            }
        };
        if let Err(e) = pair_outcome {
            // 配对未成(或取消):槽清干净则本次无痕(reservation 一并释放——本机
            // 无副本,不构成二次加入风险;服务器侧若已注册设备,由回执如实提示)。
            return Err(match slot.abort() {
                Ok(()) => {
                    self.release_reservation(&reserved);
                    e
                }
                Err(c) => format!("{e};且暂存清理失败(重启应用后自动清理):{c}"),
            });
        }

        // ---- Paired → BootCommitted:staging 库上跑完整 Transport::run(§3.2:
        // 不发明「boot 短连接」;装配参数写死——Full / 不当源 / 保留 control sender /
        // 独立 shutdown / 共享 latch)。----
        let status = Arc::new(Mutex::new(transport::SyncStatus::default()));
        let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel();
        // control sender 必须存活整个引导期:drop 会让 run 以 HostGone 退出。
        let (ctl_tx, ctl_rx) = tokio::sync::mpsc::channel(8);
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (notice_tx, notice_rx) = tokio::sync::oneshot::channel();
        let latch: BootCommitLatch = Arc::new(Mutex::new(Some(notice_tx)));
        let wrote = Arc::new(tokio::sync::Notify::new());
        {
            // §3.2 装配清单:oplog hook 照挂(staging 上正常无本地写,挂了才与
            // 正式装配同构;回滚事务的空跑唤醒无害)。
            let db = slot.db();
            let conn = db.lock().expect("db mutex poisoned");
            transport::hook_oplog_writes(&conn, wrote.clone());
        }
        let transport_task = transport::Transport {
            db: slot.db(),
            clock: slot.clock(),
            status: status.clone(),
            events: ev_tx,
            control: ctl_rx,
            wrote,
            data_dir: self.data_dir.clone(),
            blob_policy: transport::BlobPolicy::Full,
            allow_boot_source: false,
            shutdown: shutdown_rx,
            boot_commit: latch,
            restart_flag: Arc::new(Mutex::new(None)),
        };
        // 任务句柄进共享槽并挂上 admission guard(codex 一轮 M1 + 二轮 M1):
        // - 正常路 `stop_staging` 从槽取走、shutdown→限时等→abort 强杀到真消亡;
        // - join future 整个被 drop 时,guard 的 Drop 从槽接管(abort + reaper
        //   await 到消亡才翻 Idle)——绝无 detached staging transport 与下一轮并存。
        // abort 落在 await 点 = 事务边界,撕不裂 SQLite 事务(supervisor 停机同款)。
        let staging_task: StagingTaskSlot = Arc::new(Mutex::new(None));
        heavy_guard.attach_staging(staging_task.clone());
        *staging_task.lock().expect("staging slot mutex poisoned") =
            Some(tokio::spawn(transport::run(transport_task)));
        // 进度转发(独立任务:BootProgress → booting 相位;通道随 transport 退出关闭)。
        let fwd_progress = on_progress.clone();
        let fwd = tokio::spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                if let SyncEvent::BootProgress { received, total } = ev {
                    fwd_progress("booting", received, total);
                }
            }
        });
        on_progress("booting", 0, 0);

        enum Waited {
            Committed(transport::BootCommitNotice),
            Cancelled,
            TransportGone(String),
        }
        // biased 且提交臂在前:BootCommitted 与 cancel 同时就绪只走成功一次(§3.2)。
        // latch 的 sender 只随 transport 任务消亡而 drop(latch Arc 已整个移进
        // Transport):receiver 关闭 = 任务已退,按终败处理(三轮 M1 的接收侧合同)。
        let waited = tokio::select! {
            biased;
            n = notice_rx => match n {
                Ok(notice) => Waited::Committed(notice),
                Err(_) => Waited::TransportGone("同步会话意外退出".into()),
            },
            _ = cancel_rx.wait_for(|v| *v) => Waited::Cancelled,
        };
        let notice = match waited {
            Waited::Committed(n) => n,
            Waited::Cancelled => {
                stop_staging(&shutdown_tx, &staging_task).await;
                fwd.abort();
                return Err(match slot.abort() {
                    Ok(()) => {
                        self.release_reservation(&reserved);
                        // 不过度承诺(§7):Enroll 已发的取消会在账户侧留孤儿设备,
                        // 多次孤儿可能触发设备上限——如实指路,不保证无条件重来成功。
                        "已取消加入空间。若配对已完成,账户侧会留下一台闲置设备注册;重复取消后加不进时,联系运营者吊销闲置设备再试".into()
                    }
                    Err(c) => format!("已取消加入,但暂存清理失败(重启应用后自动清理):{c}"),
                });
            }
            Waited::TransportGone(why) => {
                fwd.abort();
                let err = status
                    .lock()
                    .expect("status mutex poisoned")
                    .error
                    .clone()
                    .unwrap_or(why);
                return Err(match slot.abort() {
                    Ok(()) => {
                        self.release_reservation(&reserved);
                        format!("加入失败:{err}")
                    }
                    Err(c) => format!("加入失败:{err};且暂存清理失败(重启应用后自动清理):{c}"),
                });
            }
        };

        // ---- BootCommitted → Published:shutdown → join 任务 → close → publish ----
        on_progress("publishing", 0, 0);
        stop_staging(&shutdown_tx, &staging_task).await;
        fwd.abort();
        drop(ctl_tx);
        let closed = match slot.close() {
            Ok(c) => c,
            Err(f) => {
                // 既不 publish 也不假装已清(§3.1 fail-closed);reservation 保留到重启。
                return Err(format!("加入未完成(收尾失败,重启应用后重试):{}", f.error));
            }
        };
        let published = match closed.publish() {
            Ok(p) => p,
            Err((closed, e)) => {
                // publish 失败(§3.5:此后本进程对该账户 fail-closed 到重启)。
                return Err(match closed.abort() {
                    Ok(()) => format!("{e}(暂存已清理;重启应用后可重试加入)"),
                    Err(c) => format!("{e};且暂存清理失败(重启应用后自动清理):{c}"),
                });
            }
        };

        // ---- Published → Integrated(二轮 H3):Integrated = 正式文件进入 catalog,
        // **不含前端视图切换**(切换由前端走草稿感知入口)。----
        on_progress("integrating", 0, 0);
        let mut warnings = Vec::new();
        if let Some(w) = published.cleanup_error {
            warnings.push(w);
        }
        if !notice.needs_reopen {
            if let Some(w) = notice.post_commit_error {
                warnings.push(w);
            }
        }
        match self.refresh_catalog() {
            Ok(()) => match self.descriptor(&published.id) {
                Ok(d) => {
                    self.release_reservation(&reserved);
                    Ok(JoinOutcome::Integrated {
                        space: JoinedSpace {
                            id: d.id,
                            name: d.name,
                            configured: d.account_id.is_some(),
                        },
                        warnings,
                    })
                }
                Err(e) => Ok(JoinOutcome::PublishedNeedsRestart {
                    space_id: published.id,
                    error: format!("空间已加入,但未能在目录里找到:{e}——重启应用后空间会出现"),
                }),
            },
            // reservation 保留(fail-closed 到重启):publish 成功、集成失败的重试
            // 会二次加入同一账户,必须拒到重启(§3.5)。
            Err(e) => Ok(JoinOutcome::PublishedNeedsRestart {
                space_id: published.id,
                error: format!("空间已加入,但空间目录刷新失败:{e}——重启应用后空间会出现"),
            }),
        }
    }

    // ---- 切换(工序 8,§9) ----

    /// 切换前台空间。成功点 = 本地 runtime 就绪(**不等网络**,§9);失败回滚旧空间
    /// 并重激活,绝不停在半切换态。返回 (runtime, 事件接收端);已在目标空间 =
    /// Ok(None)(幂等,无事发生)。
    pub async fn switch_to(
        &self,
        space_id: &str,
    ) -> Result<Option<(Arc<ActiveRuntime>, UnboundedReceiver<SyncEvent>)>, String> {
        // 正在遍历就先请求取消(orchestrate 持有者见信号会尽快恢复前台并放锁);
        // 切换与遍历都以 Ready 收尾,拿到锁时 phase 恒 Ready。
        self.request_cancel_sync_all();
        let _orch = self.orchestrate.lock().await;
        let old = {
            let fg = self.fg.lock().expect("fg mutex poisoned");
            debug_assert_eq!(fg.phase, Phase::Ready, "orchestrate 放锁时必回 Ready");
            if fg.space == space_id {
                return Ok(None);
            }
            fg.space.clone()
        };
        let target = self.descriptor(space_id)?; // 未知空间在翻 phase 前就拒
        self.set_phase(Phase::UserSwitching);
        let switched = async {
            self.sup.stop(&old).await?;
            self.activate_from_descriptor(&target)
        }
        .await;
        match switched {
            Ok(pair) => {
                self.set_foreground(space_id.to_string(), Phase::Ready);
                Ok(Some(pair))
            }
            Err(e) => {
                // 回滚(§9):重激活旧空间。stop 超时的空间还占着 Stopping 槽,
                // activate 会拒——那是要暴露的半死任务,不假装切好了。回滚出的
                // 事件接收端存 pending_bridge(命令层取走接桥,事件不许石沉大海)。
                let rollback = self
                    .descriptor(&old)
                    .and_then(|d| self.activate_from_descriptor(&d));
                self.set_foreground(old.clone(), Phase::Ready);
                match rollback {
                    Ok((rt, ev_rx)) => {
                        self.pending_bridge
                            .lock()
                            .expect("pending_bridge mutex poisoned")
                            .replace((rt.id.clone(), rt.generation, ev_rx));
                        Err(format!("切换失败,已回到原空间:{e}"))
                    }
                    Err(e2) => Err(format!("切换失败:{e};回滚原空间也失败:{e2}——请重启应用")),
                }
            }
        }
    }

    /// 重置空间(epoch-plan §7):清除本机该空间副本,之后配对重新加入。UI 义务
    /// (multispace §20 门 4)在前端:二段确认红字(本机数据将删除、须另一台在线
    /// 完整副本、旧 device_id 报运营者吊销)。次序 = 墓碑收场(begin_reset:会话
    /// 停 + 连接 drop 证明)→ 文件步 → finish → catalog 重扫;文件步失败墓碑留下
    /// (fail-closed),重启走 sweep/journal 恢复路径。
    ///
    /// 前台交接:重置的是前台空间时,main 重置后原地重建 fresh 空库并作为新前台
    /// 重新激活;非 main 前台重置后落回 main。返回 Some((rt, ev_rx)) = 前台已换
    /// 新 runtime(命令层接桥),None = 前台未动。coord 不长持 Arc(112 契约),
    /// begin_reset 的强引用归零证明不会被自己人卡住。
    pub async fn reset_space(
        &self,
        space_id: &str,
    ) -> Result<Option<(Arc<ActiveRuntime>, UnboundedReceiver<SyncEvent>)>, String> {
        self.request_cancel_sync_all();
        let _orch = self.orchestrate.lock().await;
        let fg_is_target = {
            let fg = self.fg.lock().expect("fg mutex poisoned");
            debug_assert_eq!(fg.phase, Phase::Ready, "orchestrate 放锁时必回 Ready");
            fg.space == space_id
        };
        let _ = self.descriptor(space_id)?; // 未知空间在翻 phase 前就拒
        self.set_phase(Phase::UserSwitching); // 重置期间业务写响亮拒(与切换同语义)
        let done = async {
            let ticket = self.sup.begin_reset(space_id).await?;
            let files = if space_id == spaces::MAIN_SPACE {
                spaces::reset_main_files(&self.data_dir).map(|_| ())
            } else {
                spaces::reset_space_files(&self.data_dir, space_id)
            };
            if let Err(e) = files {
                // 不 finish:墓碑留下,本进程内该空间封锁(宁封锁不双写)。
                return Err(format!("重置文件步失败(空间已封锁,重启应用后自动恢复):{e}"));
            }
            self.sup.finish_reset(ticket);
            self.refresh_catalog()
        }
        .await;
        if let Err(e) = done {
            self.set_phase(Phase::Ready);
            return Err(e);
        }
        if !fg_is_target {
            self.set_phase(Phase::Ready);
            return Ok(None);
        }
        // 前台被重置:落回 main(main 自己被重置时,catalog 重扫后的 main 描述符
        // 就是刚重建的 fresh 空库——描述符必须取重扫后的,file key 已换)。
        let target = self.descriptor(spaces::MAIN_SPACE)?;
        match self.activate_from_descriptor(&target) {
            Ok(pair) => {
                self.set_foreground(spaces::MAIN_SPACE.to_string(), Phase::Ready);
                Ok(Some(pair))
            }
            Err(e) => {
                self.set_phase(Phase::Ready);
                Err(format!("重置已完成,但激活主空间失败(重启应用即恢复):{e}"))
            }
        }
    }

    // ---- 手动「全部同步」(工序 8,§7 lean-B) ----

    fn request_cancel_sync_all(&self) {
        if let Some(tx) = self.sync_cancel.lock().expect("sync_cancel mutex poisoned").as_ref() {
            let _ = tx.send(true);
        }
    }

    /// 手动全部同步:single-flight + 全局 deadline + 每空间 soft deadline,顺序遍历
    /// **全部已配对空间**(§7「各 configured space」;前台空间常驻实时、不停不
    /// 折腾,结果取其现状快照)各出一份本轮结果;结束(含取消/出错)恒恢复前台
    /// runtime、phase 回 Ready。结果只在内存(§12)。时限的诚实边界:global cap
    /// 钳住每空间观察窗与新目标的开启;收尾「停最后的 session + 恢复前台」不受
    /// 预算约束(必须做),最多另加一次 stop 超时(10s)。
    /// `on_progress(space_id, 已完成数, 总数)` 供命令层发进度事件。
    pub async fn sync_all(
        &self,
        on_progress: impl Fn(&str, usize, usize),
    ) -> Result<SyncAllReport, String> {
        // 原子 admission(space-entry-plan §3.3):与 join_space 同一把锁下
        // Idle → SyncAll——join 正在跑则立即拒(手机不许同时跑前台 transport +
        // staging boot + 轮巡 session);RAII guard 保证任何退出路都恢复 Idle。
        let _heavy = HeavyOpGuard::acquire(&self.heavy, HeavyOp::SyncAll).map_err(|by| match by {
            HeavyOp::Joining => "正在加入空间,完成后再全部同步".to_string(),
            _ => "全部同步已在进行".to_string(),
        })?;
        // 再占取消信号坑(第二个调用已被 admission 拒;槽仍留作取消通道)。
        let mut cancel_rx = {
            let mut slot = self.sync_cancel.lock().expect("sync_cancel mutex poisoned");
            if slot.is_some() {
                return Err("全部同步已在进行".into());
            }
            let (tx, rx) = tokio::sync::watch::channel(false);
            *slot = Some(tx);
            rx
        };
        let _orch = self.orchestrate.lock().await;
        let fg_id = {
            let fg = self.fg.lock().expect("fg mutex poisoned");
            debug_assert_eq!(fg.phase, Phase::Ready);
            fg.space.clone()
        };
        let all = self.all_descriptors();
        // 前台空间的本轮结果 = 常驻 transport 的现状快照(它已经在实时同步,再
        // stop/activate 一遍是折腾;§7 要求它也有本次结果,不许缺席)。
        let fg_outcome = all
            .iter()
            .find(|d| d.id == fg_id && d.account_id.is_some())
            .map(|d| self.foreground_snapshot(d));
        let targets: Vec<SpaceDescriptor> = all
            .into_iter()
            .filter(|d| d.id != fg_id && d.account_id.is_some())
            .collect();
        if targets.is_empty() {
            self.sync_cancel.lock().expect("sync_cancel mutex poisoned").take();
            return Ok(SyncAllReport {
                outcomes: fg_outcome.into_iter().collect(),
                restore_error: None,
            });
        }
        self.set_phase(Phase::ManualSyncing);
        let mut report = self.run_sweep(&fg_id, &targets, &mut cancel_rx, &on_progress).await;
        // 恢复前台:session 不管停在哪个空间,拉回前台(§7「到安全点后执行」的
        // 安全点)。恢复失败不吞结果;phase 仍回 Ready(不许卡死在 ManualSyncing)。
        if let Err(e) = self.restore_foreground(&fg_id).await {
            report.restore_error = Some(match report.restore_error {
                Some(prev) => format!("{prev};恢复前台空间失败:{e}"),
                None => format!("恢复前台空间失败:{e}"),
            });
        }
        self.set_phase(Phase::Ready);
        self.sync_cancel.lock().expect("sync_cancel mutex poisoned").take();
        report.outcomes.splice(0..0, fg_outcome);
        Ok(report)
    }

    /// 前台空间的现状快照 → §7 结果映射(不打扰常驻 transport)。瞬时快照不做
    /// 负面推断(codex 工序 7/8 二审 M2):booting 的零同伴窗口是正常时序(先进
    /// booting、Peer roster 后到),不许据此报 no_boot_peer;`failed` 只承载真 error。
    /// online/booting = 连接已建立 → connected(detail 区分);connecting/offline
    /// 无 error = 瞬态未到位 → timed_out 带状态人话。
    fn foreground_snapshot(&self, desc: &SpaceDescriptor) -> SyncOutcome {
        let (outcome, detail) = match self.sup.get(&desc.id) {
            Err(e) => ("failed", Some(e)),
            Ok(rt) => {
                let st = rt.status.lock().expect("sync status mutex poisoned").clone();
                match (st.state.as_str(), st.error) {
                    (_, Some(e)) => ("failed", Some(e)),
                    ("online", None) => ("connected", Some("当前空间,实时同步中".into())),
                    ("booting", None) => ("connected", Some("当前空间,正在初始同步".into())),
                    ("connecting", None) => ("timed_out", Some("当前空间正在连接".into())),
                    ("offline", None) => ("timed_out", Some("当前空间掉线,重连中".into())),
                    (other, None) => ("timed_out", Some(format!("当前空间连接状态:{other}"))),
                }
            }
        };
        SyncOutcome {
            space: desc.id.clone(),
            name: desc.name.clone(),
            outcome,
            progressed: false,
            detail,
        }
    }

    /// 遍历本体:任何一步失败都只影响该空间的 outcome,不早退(除非取消/全局超时)。
    async fn run_sweep(
        &self,
        fg_id: &str,
        targets: &[SpaceDescriptor],
        cancel: &mut tokio::sync::watch::Receiver<bool>,
        on_progress: &impl Fn(&str, usize, usize),
    ) -> SyncAllReport {
        let total = targets.len();
        let global_deadline = tokio::time::Instant::now()
            + (self.timings.per_space * total as u32).min(self.timings.global_cap);
        let mut outcomes = Vec::with_capacity(total);
        // 第一步先停前台 session(session 与 foreground 从此错开,§9)。
        let mut session: Option<String> = Some(fg_id.to_string());
        for (i, desc) in targets.iter().enumerate() {
            let cancelled = *cancel.borrow();
            let out_of_time = tokio::time::Instant::now() >= global_deadline;
            if cancelled || out_of_time {
                outcomes.push(SyncOutcome {
                    space: desc.id.clone(),
                    name: desc.name.clone(),
                    outcome: if cancelled { "cancelled" } else { "timed_out" },
                    progressed: false,
                    detail: (!cancelled).then(|| "整次全部同步超时".into()),
                });
                on_progress(&desc.id, i + 1, total);
                continue;
            }
            if let Some(prev) = session.take() {
                if let Err(e) = self.sup.stop(&prev).await {
                    // session 停不掉(半死任务占着 max_live=1 的 permit):后续所有
                    // 目标都起不来——统一记 failed 一次性收场,不逐个重复 stop 把
                    // 预算烧在重试上(codex 三轮 M);半死 session 进 restore_error,
                    // 随后的 restore_foreground 也会因 permit 占用而响亮。
                    let msg = format!("上一个同步会话未能停止:{e}");
                    for (j, d) in targets.iter().enumerate().skip(i) {
                        outcomes.push(SyncOutcome {
                            space: d.id.clone(),
                            name: d.name.clone(),
                            outcome: "failed",
                            progressed: false,
                            detail: Some(msg.clone()),
                        });
                        on_progress(&d.id, j + 1, total);
                    }
                    return SyncAllReport { outcomes, restore_error: Some(msg) };
                }
                // stop 可能等了数秒:activate 前重验取消/预算(codex 三轮 M)——
                // 越过 cap 或用户已请求恢复,就不再开启这个目标;session 已停,
                // 后续目标由循环顶的同一判定收掉。
                let cancelled = *cancel.borrow();
                let out_of_time = tokio::time::Instant::now() >= global_deadline;
                if cancelled || out_of_time {
                    outcomes.push(SyncOutcome {
                        space: desc.id.clone(),
                        name: desc.name.clone(),
                        outcome: if cancelled { "cancelled" } else { "timed_out" },
                        progressed: false,
                        detail: (!cancelled).then(|| "整次全部同步超时".into()),
                    });
                    on_progress(&desc.id, i + 1, total);
                    continue;
                }
            }
            match self.activate_from_descriptor(desc) {
                Err(e) => {
                    outcomes.push(SyncOutcome {
                        space: desc.id.clone(),
                        name: desc.name.clone(),
                        outcome: "failed",
                        progressed: false,
                        detail: Some(e),
                    });
                    // session 已停、新的没起来:下一轮不用 stop。
                }
                Ok((rt, ev_rx)) => {
                    session = Some(desc.id.clone());
                    let soft =
                        global_deadline.min(tokio::time::Instant::now() + self.timings.per_space);
                    outcomes
                        .push(observe_catchup(desc, &rt, ev_rx, soft, self.timings.quiet, cancel).await);
                }
            }
            on_progress(&desc.id, i + 1, total);
        }
        // 把最后的 session 停掉,restore_foreground 统一重激活前台。停不掉(半死
        // 任务占着 max_live=1 的 permit)= 恢复必然也失败——记进 restore_error,
        // **不吞掉已积累的 per-space 结果**(codex 工序 7/8 M2)。
        let mut restore_error = None;
        if let Some(prev) = session {
            if prev != fg_id {
                if let Err(e) = self.sup.stop(&prev).await {
                    restore_error = Some(format!("收尾停止空间 {prev} 的同步会话失败:{e}"));
                }
            }
        }
        SyncAllReport { outcomes, restore_error }
    }

    /// 恢复前台 runtime(遍历后 / 遍历半途取消后)。前台还活着(遍历第一步就失败
    /// 之类)则原样;否则从 catalog 重新激活。
    async fn restore_foreground(&self, fg_id: &str) -> Result<(), String> {
        if self.sup.get(fg_id).is_ok() {
            return Ok(());
        }
        let desc = self.descriptor(fg_id)?;
        // 事件接收端交给壳层再桥接:restore 在 Coord 内部拿不到 app——由调用方
        // (命令层)在 sync_all 返回后重新查 runtime 并接桥。这里丢弃 ev_rx 会让
        // 事件石沉大海,所以把它存进 pending_bridge 由命令层取走。
        let (rt, ev_rx) = self.activate_from_descriptor(&desc)?;
        self.pending_bridge
            .lock()
            .expect("pending_bridge mutex poisoned")
            .replace((rt.id.clone(), rt.generation, ev_rx));
        Ok(())
    }
}

/// 观察一个临时 session 的追赶(§7 判定):
/// - 引导从缺到有 → `boot_completed`;
/// - 到过 online 且静默一个窗口 → `connected`(「只表示建过连接+跑了一段」);
/// - soft deadline 前没到 online:booting 且**毫无引导活动证据**(没见过
///   BootProgress、也没见过同伴在线)→ `no_boot_peer`;booting 但确有活动(大
///   快照没拉完)→ `timed_out`(codex 工序 7/8 M3:慢引导不许误报「无引导源」);
///   有错 → `failed`;其余 → `timed_out`。
/// progressed = 远端落库(Changed)**或** last_pushed 抬升(本机 op 获 Ack,M4)。
async fn observe_catchup(
    desc: &SpaceDescriptor,
    rt: &Arc<ActiveRuntime>,
    mut ev_rx: UnboundedReceiver<SyncEvent>,
    soft_deadline: tokio::time::Instant,
    quiet_window: Duration,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> SyncOutcome {
    let (was_booted, pushed_before) = {
        let conn = rt.db.lock().expect("db mutex poisoned");
        (bootstrapped(&conn), last_pushed(&conn))
    };
    let mut progressed = false;
    let mut seen_online = false;
    let mut boot_evidence = false; // 见过 BootProgress 或同伴在线 = 引导路是通的。
    let outcome = loop {
        let quiet = tokio::time::sleep(quiet_window);
        tokio::select! {
            _ = tokio::time::sleep_until(soft_deadline) => {
                let st = rt.status.lock().expect("sync status mutex poisoned").clone();
                let evidence = boot_evidence || st.peers_online > 0;
                break match (st.state.as_str(), st.error) {
                    ("booting", None) if !evidence => ("no_boot_peer", Some("没有在线设备可提供引导快照(需要桌面端在线)".into())),
                    ("booting", None) => ("timed_out", Some("初始同步未在时限内完成(快照较大或网络较慢)".into())),
                    (_, Some(e)) => ("failed", Some(e)),
                    // 117(codex H2):到过 online 但字节还在途 = 这轮没追完,如实报
                    // timed_out 带图数,绝不冒充 connected(半途的图下轮整张重拉)。
                    _ if seen_online => {
                        let pending = {
                            let conn = rt.db.lock().expect("db mutex poisoned");
                            transport::pending_blob_count(&conn)
                        };
                        match pending {
                            Err(e) => ("failed", Some(format!("查缺图清单失败:{e}"))),
                            Ok(n) if n > 0 => (
                                "timed_out",
                                Some(format!("还有 {n} 张图的字节没拉完(下轮接着补)")),
                            ),
                            Ok(_) => ("connected", None),
                        }
                    }
                    _ => ("timed_out", None),
                };
            }
            changed = cancel.changed() => {
                let _ = changed;
                if *cancel.borrow() {
                    break ("cancelled", None);
                }
            }
            ev = ev_rx.recv() => {
                match ev {
                    Some(SyncEvent::Changed) => progressed = true,
                    Some(SyncEvent::BootProgress { .. }) => boot_evidence = true,
                    Some(SyncEvent::Status(s)) => {
                        if s.state == "online" { seen_online = true; }
                        if s.peers_online > 0 { boot_evidence = true; }
                    }
                    Some(_) => {}
                    // transport 死了(panic/退出):status 里有最后的错。
                    None => {
                        let st = rt.status.lock().expect("sync status mutex poisoned").clone();
                        break ("failed", st.error.or(Some("同步会话意外退出".into())));
                    }
                }
            }
            _ = quiet, if seen_online => {
                // online 后静默一个窗口 **且无缺字节图**:这轮追赶尽力到头。事件
                // 静默 ≠ 追赶到头——blob 分块不发事件(整图落行才 Changed),字节
                // 在途就收场 = 拉一半的图被扔、下轮整张重头(codex H2)。在途则
                // 继续等,soft deadline 统一收口(那边如实报 timed_out 带图数)。
                let (now_booted, pending) = {
                    let conn = rt.db.lock().expect("db mutex poisoned");
                    (bootstrapped(&conn), transport::pending_blob_count(&conn))
                };
                match pending {
                    Err(e) => break ("failed", Some(format!("查缺图清单失败:{e}"))),
                    Ok(n) if n > 0 => continue,
                    Ok(_) => {}
                }
                break if !was_booted && now_booted {
                    ("boot_completed", None)
                } else {
                    ("connected", None)
                };
            }
        }
    };
    let pushed_after = {
        let conn = rt.db.lock().expect("db mutex poisoned");
        last_pushed(&conn)
    };
    SyncOutcome {
        space: desc.id.clone(),
        name: desc.name.clone(),
        outcome: outcome.0,
        progressed: progressed || pushed_after > pushed_before,
        detail: outcome.1,
    }
}

fn bootstrapped(conn: &Connection) -> bool {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT value FROM sync_meta WHERE key='bootstrapped_at'", [], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// 已 ack 的出站游标(缺席 = 0)。观察前后比较:抬升 = 本机待发 op 获服务器 Ack,
/// 算进展(§7;transport 收 Ack 只提游标不发 Changed 事件)。
fn last_pushed(conn: &Connection) -> i64 {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key='last_pushed'", [], |r| {
        r.get(0)
    })
    .optional()
    .ok()
    .flatten()
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zhujian_core::{notes, task};

    /// 造一个「fresh 主库 + N 个已建空间」的数据目录,返回启动完成的 Coord
    /// (主空间已激活,与壳装配同构)。
    async fn boot_coord(tag: &str, extra: &[&str], timings: SweepTimings) -> (Coord, PathBuf) {
        let dir = std::env::temp_dir().join(format!("zj-coord-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        spaces::create_main_db(&dir).unwrap();
        for name in extra {
            spaces::create_space(&dir, name).unwrap();
        }
        let main_db = dir.join("notebook.sqlite3");
        let catalog = SpaceCatalog::load(&main_db, Some(&dir), None).unwrap();
        let sup = Arc::new(SpaceSupervisor::new(tokio::runtime::Handle::current(), 1));
        let coord = Coord::with_timings(sup, dir.clone(), catalog, timings);
        let desc = coord.descriptor(spaces::MAIN_SPACE).unwrap();
        let (_rt, _ev) = coord.activate_from_descriptor(&desc).unwrap();
        (coord, dir)
    }

    fn fast() -> SweepTimings {
        SweepTimings {
            per_space: Duration::from_secs(2),
            global_cap: Duration::from_secs(10),
            quiet: Duration::from_millis(200),
        }
    }

    /// 业务写闸(§16.2 提案 B):Ready 且目标=前台 → 直通;目标不符 → 响亮拒
    /// (绝不改写目标);UserSwitching → 立即拒(不排队)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn write_gate_enforces_foreground_and_phase() {
        let (coord, dir) = boot_coord("gate", &["家庭"], fast()).await;
        // Ready + 前台 = main:写直通。
        let id = coord
            .write(spaces::MAIN_SPACE, |c, k| notes::capture(c, k, "落前台"))
            .await
            .unwrap();
        assert!(!id.is_empty());
        // 目标空间已经变化(前端看到的是家庭、前台却是 main)= 拒,不改写目标。
        let fam = coord.all_descriptors()[1].id.clone();
        let err = coord.write(&fam, |c, k| notes::capture(c, k, "误发")).await.unwrap_err();
        assert!(err.contains("目标空间已经变化"), "{err}");
        // UserSwitching:立即拒(手工翻相,模拟切换窗口)。
        coord.set_phase(Phase::UserSwitching);
        let err = match coord.with_write(spaces::MAIN_SPACE, |c, k| notes::capture(c, k, "切换中")) {
            WriteAttempt::Done(r) => r.unwrap_err(),
            WriteAttempt::Busy => panic!("UserSwitching 必须立即拒,不是排队"),
        };
        assert!(err.contains("正在切换空间"), "{err}");
        coord.set_phase(Phase::Ready);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 切换(§9):成功点 = 本地 runtime 就绪;旧 runtime 真停(supervisor 表里
    /// 只剩新空间);切不存在的空间响亮拒且不动现场;幂等切自己 = 无事发生。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn switch_swaps_runtime_and_rejects_unknown() {
        let (coord, dir) = boot_coord("switch", &["家庭"], fast()).await;
        let fam = coord.all_descriptors()[1].id.clone();
        let pair = coord.switch_to(&fam).await.unwrap();
        assert!(pair.is_some());
        assert_eq!(coord.foreground(), (fam.clone(), Phase::Ready));
        assert!(coord.sup.get(&fam).is_ok(), "新前台 runtime 在场");
        assert!(coord.sup.get(spaces::MAIN_SPACE).is_err(), "旧 runtime 已停(max_live=1)");
        // 幂等:再切自己无事发生。
        assert!(coord.switch_to(&fam).await.unwrap().is_none());
        // 未知空间:拒且现场不动。
        let err = coord.switch_to("01JUNKNOWNSPACE0000000000X").await.map(|_| ()).unwrap_err();
        assert!(err.contains("未知空间"), "{err}");
        assert_eq!(coord.foreground(), (fam, Phase::Ready));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 切换失败回滚(§9「绝不停在半切换态」):目标库在 catalog 后被换成新 inode
    /// (open_space 身份复核拒)→ 回滚重激活旧空间,前台仍旧、写照常。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn switch_failure_rolls_back_to_old_space() {
        let (coord, dir) = boot_coord("rollback", &["家庭"], fast()).await;
        let fam_desc = coord.all_descriptors()[1].clone();
        // 同名重建(内容合法的当前版库、但 inode 变了):descriptor.file 复核必拒。
        std::fs::remove_file(&fam_desc.path).unwrap();
        std::fs::copy(coord.data_dir.join("notebook.sqlite3"), &fam_desc.path).unwrap();
        let err = coord.switch_to(&fam_desc.id).await.map(|_| ()).unwrap_err();
        assert!(err.contains("已回到原空间"), "{err}");
        assert_eq!(coord.foreground(), (spaces::MAIN_SPACE.to_string(), Phase::Ready));
        // 回滚出的事件接收端在 pending_bridge 等命令层接走。
        assert!(coord.take_pending_bridge().is_some());
        // 写命令照常落原空间。
        coord
            .write(spaces::MAIN_SPACE, |c, k| notes::capture(c, k, "回滚后照写"))
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 全部同步(§7):无已配对空间 = 空结果不折腾;假 server 的已配对空间 =
    /// 超时/失败类 outcome、绝无「完成」布尔;结束恢复前台 runtime、phase 回
    /// Ready;single-flight 第二个立即拒。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sync_all_bounded_and_restores_foreground() {
        let (coord, dir) = boot_coord("sweep", &["家庭"], fast()).await;
        // 尚无已配对空间:空结果。
        assert!(coord.sync_all(|_, _, _| {}).await.unwrap().outcomes.is_empty());
        // 给家庭空间配上假账户(server 不可达):遍历真跑、outcome 有界返回。
        let fam = coord.all_descriptors()[1].clone();
        {
            let conn = Connection::open(&fam.path).unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','01AAAAAAAAAAAAAAAAAAAAACCT'),
                   ('k_acc','{z}'),('device_key','{z}'),('server_url','ws://127.0.0.1:1');",
                z = "00".repeat(32),
            ))
            .unwrap();
        }
        coord.refresh_catalog().unwrap();
        let progress = Arc::new(Mutex::new(Vec::new()));
        let p2 = progress.clone();
        let report = coord
            .sync_all(move |s, done, total| p2.lock().unwrap().push((s.to_string(), done, total)))
            .await
            .unwrap();
        assert!(report.restore_error.is_none(), "{:?}", report.restore_error);
        let outcomes = report.outcomes;
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].space, fam.id);
        assert!(
            matches!(outcomes[0].outcome, "timed_out" | "failed" | "no_boot_peer"),
            "假 server 只能是超时/失败类:{:?}",
            outcomes[0]
        );
        assert_eq!(progress.lock().unwrap().len(), 1);
        // 前台恢复:phase Ready、main runtime 在场、写直通。
        assert_eq!(coord.foreground(), (spaces::MAIN_SPACE.to_string(), Phase::Ready));
        coord.take_pending_bridge(); // 恢复前台的桥交接。
        assert!(coord.sup.get(spaces::MAIN_SPACE).is_ok());
        coord
            .write(spaces::MAIN_SPACE, |c, k| task::create(c, k, "遍历后照写", None, None, None))
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §7「用户写入立即请求恢复前台、到安全点后执行」:遍历进行中发起写——
    /// 取消遍历、恢复前台、写落前台空间,全程不误发别的空间、不静默丢;
    /// 取消之后的目标空间**从未被激活**(库从未被切 WAL,codex 三轮 M:取消/超时
    /// 在 stop 之后也重验,不再开启新目标)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn write_during_manual_sync_cancels_and_lands_foreground() {
        let slow = SweepTimings {
            per_space: Duration::from_secs(30), // 拉长观察窗,让写命令赶在遍历中到达。
            global_cap: Duration::from_secs(60),
            quiet: Duration::from_millis(200),
        };
        let (coord, dir) = boot_coord("interrupt", &["家庭", "工作"], slow).await;
        let fam = coord.all_descriptors()[1].clone();
        let work = coord.all_descriptors()[2].clone();
        for p in [&fam.path, &work.path] {
            let conn = Connection::open(p).unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','01AAAAAAAAAAAAAAAAAAAAACC{n}'),
                   ('k_acc','{z}'),('device_key','{z}'),('server_url','ws://127.0.0.1:1');",
                n = if std::ptr::eq(p, &fam.path) { "1" } else { "2" },
                z = "00".repeat(32),
            ))
            .unwrap();
        }
        coord.refresh_catalog().unwrap();
        let coord = Arc::new(coord);
        let c2 = coord.clone();
        let sweep = tokio::spawn(async move { c2.sync_all(|_, _, _| {}).await });
        // 等遍历真进 ManualSyncing。
        for _ in 0..100 {
            if coord.foreground().1 == Phase::ManualSyncing {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(coord.foreground().1, Phase::ManualSyncing, "遍历应已开跑");
        // 遍历中写:应取消遍历、等恢复、落前台(30s 观察窗内写返回 = 真被取消)。
        let t0 = std::time::Instant::now();
        let id = tokio::time::timeout(
            Duration::from_secs(10),
            coord.write(spaces::MAIN_SPACE, |c, k| notes::capture(c, k, "遍历中的捕获")),
        )
        .await
        .expect("写命令不该等满观察窗")
        .unwrap();
        assert!(!id.is_empty());
        assert!(t0.elapsed() < Duration::from_secs(10));
        let outcomes = sweep.await.unwrap().unwrap().outcomes;
        assert_eq!(outcomes.len(), 2);
        assert_eq!(outcomes[0].outcome, "cancelled");
        assert_eq!(outcomes[1].outcome, "cancelled");
        // 取消后的第二目标从未被激活:activate 会经 open_space 切 WAL,而
        // create_space 的建库刻意不切——journal_mode 仍是 delete 即为「没碰过」。
        {
            let conn = Connection::open(&work.path).unwrap();
            let mode: String =
                conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
            assert_eq!(mode, "delete", "取消后不许再开启新目标空间");
        }
        assert_eq!(coord.foreground(), (spaces::MAIN_SPACE.to_string(), Phase::Ready));
        // 写真落在前台库。
        let n: i64 = {
            let rt = coord.sup.get(spaces::MAIN_SPACE).unwrap();
            let conn = rt.db.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM items WHERE content='遍历中的捕获'", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 账户闸(open-signup 后只剩配对/加入这些**外来账户 ID** 路径在用;创号已
    /// 不过闸——账户 ULID 自生成):已被别的空间占用 = 响亮拒;某库读不出 =
    /// fail-closed 中止,绝不「读不到就当没占用」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn account_free_rejects_taken_and_fails_closed() {
        let (coord, dir) = boot_coord("acct-gate", &["家庭"], fast()).await;
        let fam = coord.all_descriptors()[1].clone();
        {
            let conn = Connection::open(&fam.path).unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','01AAAAAAAAAAAAAAAAAAAAACCT'),
                   ('k_acc','{z}'),('device_key','{z}'),('server_url','ws://127.0.0.1:1');",
                z = "00".repeat(32),
            ))
            .unwrap();
        }
        coord.refresh_catalog().unwrap();
        // 占用拒。
        let err = coord
            .account_free(Some(spaces::MAIN_SPACE), "01AAAAAAAAAAAAAAAAAAAAACCT")
            .unwrap_err();
        assert!(err.contains("已被空间"), "{err}");
        // fail-closed:家庭库被换成垃圾字节,读不出 = 中止(不是「当没占用」继续)。
        std::fs::write(&fam.path, b"not a sqlite file").unwrap();
        let err = coord
            .account_free(Some(spaces::MAIN_SPACE), "01AAAAAAAAAAAAAAAAAAAAACC2")
            .unwrap_err();
        assert!(!err.contains("已被空间"), "读失败必须是读失败的错:{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 创号取消(§2.1):挂死的「服务器」上创号中,切走空间 → shutdown 秒级取消、
    /// 配置一个键都不落(§4「裁决先于一切可见状态」;stop 等 begin_op 放手,无
    /// 死锁)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn create_account_cancelled_by_switch_leaves_no_config() {
        let (coord, dir) = boot_coord("acct-cancel", &["家庭"], fast()).await;
        // 挂死服务器:accept 后持有连接不回话(drop 会 RST 让拨号立刻失败,故必须存活)。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = listener.accept().await {
                held.push(s);
            }
        });
        let coord = Arc::new(coord);
        let c2 = coord.clone();
        let url = format!("ws://{addr}");
        let create = tokio::spawn(async move {
            c2.create_account(spaces::MAIN_SPACE, &url).await
        });
        tokio::time::sleep(Duration::from_millis(300)).await; // 让创号进到握手挂起。
        let fam = coord.all_descriptors()[1].id.clone();
        coord.switch_to(&fam).await.unwrap();
        let err = create.await.unwrap().unwrap_err();
        assert!(err.contains("已取消"), "{err}");
        // 主库配置零键(现读文件,不信 catalog 快照)。
        let main_path = coord.data_dir.join("notebook.sqlite3");
        let d = spaces::read_descriptor(spaces::MAIN_SPACE, &main_path).unwrap();
        assert!(d.account_id.is_none(), "取消后不许留任何配置");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// post-commit 保码(codex r1 #5):收尾失败=Some(人话)旁路报告——坏 catalog
    /// (垃圾 ULID 库让严格重扫整体 Err)不许把「账户已创建」变成命令 Err 吞掉
    /// 恢复码;好 catalog = None。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn finish_account_creation_reports_side_errors_without_eating() {
        let (coord, dir) = boot_coord("acct-post", &[], fast()).await;
        assert!(coord.finish_account_creation(spaces::MAIN_SPACE).await.is_none());
        // 垃圾字节的 ULID 形态库文件:SpaceCatalog::load fail-closed 整体 Err。
        std::fs::write(dir.join("01BADBADBADBADBADBADBADBAD.sqlite3"), b"junk").unwrap();
        let err = coord
            .finish_account_creation(spaces::MAIN_SPACE)
            .await
            .expect("坏 catalog 必须报告");
        assert!(err.contains("账户已创建"), "报告必须先声明提交已发生:{err}");
        assert!(err.contains("重启"), "指引必须可执行:{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// single-flight:遍历进行中第二个 sync_all 立即拒,不排队。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sync_all_is_single_flight() {
        let slow = SweepTimings {
            per_space: Duration::from_secs(30),
            global_cap: Duration::from_secs(60),
            quiet: Duration::from_millis(200),
        };
        let (coord, dir) = boot_coord("flight", &["家庭"], slow).await;
        let fam = coord.all_descriptors()[1].clone();
        {
            let conn = Connection::open(&fam.path).unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','01AAAAAAAAAAAAAAAAAAAAACCT'),
                   ('k_acc','{z}'),('device_key','{z}'),('server_url','ws://127.0.0.1:1');",
                z = "00".repeat(32),
            ))
            .unwrap();
        }
        coord.refresh_catalog().unwrap();
        let coord = Arc::new(coord);
        let c2 = coord.clone();
        let sweep = tokio::spawn(async move { c2.sync_all(|_, _, _| {}).await });
        for _ in 0..100 {
            if coord.foreground().1 == Phase::ManualSyncing {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let err = coord.sync_all(|_, _, _| {}).await.unwrap_err();
        assert!(err.contains("已在进行"), "{err}");
        // 收尾:切换请求取消遍历并接管(用户点切换不用等遍历跑完)。
        let fam_id = fam.id.clone();
        let switched = coord.switch_to(&fam_id).await.unwrap();
        assert!(switched.is_some());
        let _ = sweep.await.unwrap().unwrap();
        coord.take_pending_bridge();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 加入空间(space-entry-plan §3/§7) ----

    /// 「新建空间」= 立即可写的纯本地本子(§4:删 §9 非 main 禁写闸的回归锚):
    /// 未配置账户的非 main 空间,切过去即可记灵感,零配对前置。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fresh_non_main_space_is_writable_without_pairing() {
        let (coord, dir) = boot_coord("entry-write", &["新本子"], fast()).await;
        let fam = coord.all_descriptors()[1].clone();
        assert!(fam.account_id.is_none(), "未配置账户");
        coord.switch_to(&fam.id).await.unwrap();
        let id = coord
            .write(&fam.id, |c, k| notes::capture(c, k, "新本子第一条"))
            .await
            .expect("新建空间必须立即可写(§9 闸已删)");
        assert!(!id.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 加入端到端(§7 验收):源端(模拟桌面)创号 + 常驻 transport 供引导 →
    /// coord.join_space 走完 Preparing→Paired→BootCommitted→Published→Integrated
    /// ——新空间进 catalog、账户/数据俱全、reservation 已释放、admission 回 Idle。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn join_space_end_to_end_integrates_new_space() {
        let sdir = std::env::temp_dir().join(format!("zj-join-srv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sdir);
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(sdir.join("banlist.txt"), "# 空封禁表\n").unwrap();
        let cfg = zhujian_syncd::Config::new(sdir.join("banlist.txt"), sdir.join("registry.json"));
        let (addr, _handle) =
            zhujian_syncd::serve("127.0.0.1:0".parse().unwrap(), cfg).await.unwrap();
        let url = format!("ws://{addr}");

        // 源端(别的设备):独立目录,一条数据 + 创号 + 常驻 transport(可当引导源)。
        let src_dir = std::env::temp_dir().join(format!("zj-join-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&src_dir);
        std::fs::create_dir_all(&src_dir).unwrap();
        let src_conn = zhujian_core::db::open(&src_dir.join("src.sqlite3")).unwrap();
        let mut src_clock = Clock::load(&src_conn).unwrap();
        let src_db = Arc::new(Mutex::new(src_conn));
        {
            let mut conn = src_db.lock().unwrap();
            notes::capture(&mut conn, &mut src_clock, "源端的灵感").unwrap();
        }
        transport::create_account(&src_db, &url).await.unwrap();
        // open-signup:账户 ULID 源端自生成,从配置读回供后续断言。
        let acct = {
            let conn = src_db.lock().unwrap();
            transport::account_id(&conn).unwrap().expect("源端已配置")
        };
        let src_status = Arc::new(Mutex::new(transport::SyncStatus::default()));
        let (src_ev_tx, _src_ev_rx) = tokio::sync::mpsc::unbounded_channel();
        let (src_ctl_tx, src_ctl_rx) = tokio::sync::mpsc::channel(8);
        let (_src_sd_tx, src_sd_rx) = tokio::sync::watch::channel(false);
        let src_wrote = Arc::new(tokio::sync::Notify::new());
        {
            let conn = src_db.lock().unwrap();
            transport::hook_oplog_writes(&conn, src_wrote.clone());
        }
        let src_task = tokio::spawn(transport::run(transport::Transport {
            db: src_db.clone(),
            clock: Arc::new(Mutex::new(src_clock)),
            status: src_status.clone(),
            events: src_ev_tx,
            control: src_ctl_rx,
            wrote: src_wrote,
            data_dir: src_dir.clone(),
            blob_policy: transport::BlobPolicy::Full,
            allow_boot_source: true,
            shutdown: src_sd_rx,
            boot_commit: Arc::new(Mutex::new(None)),
            restart_flag: Arc::new(Mutex::new(None)),
        }));
        for _ in 0..200 {
            if src_status.lock().unwrap().state == "online" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(src_status.lock().unwrap().state, "online", "源端须上线");
        let (tx, rx) = tokio::sync::oneshot::channel();
        src_ctl_tx.send(transport::Control::PairStart { reply: tx }).await.unwrap();
        let code = tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        // 手机侧:fresh coord,join_space 全程。
        let (coord, dir) = boot_coord("join-e2e", &[], fast()).await;
        let phases: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let p2 = phases.clone();
        let out = coord
            .join_space(&url, &code, move |phase, _r, _t| p2.lock().unwrap().push(phase))
            .await
            .expect("加入应成功");
        let space = match out {
            JoinOutcome::Integrated { space, warnings } => {
                assert!(warnings.is_empty(), "{warnings:?}");
                space
            }
            other => panic!("应 Integrated,得到 {other:?}"),
        };
        assert!(space.configured);
        assert!(spaces::is_ulid_name(&space.id));
        assert_eq!(space.name, None, "槽零名字:源侧无名则显缺省(§3.6)");
        {
            let seen = phases.lock().unwrap();
            for want in ["preparing", "pairing", "publishing", "integrating"] {
                assert!(seen.contains(&want), "缺相位 {want}:{seen:?}");
            }
        }
        // 正式库:进 catalog、账户/数据俱全;目录零 .joining 残留。
        let desc = coord.descriptor(&space.id).expect("新空间已进 catalog");
        assert_eq!(desc.account_id.as_deref(), Some(acct.as_str()));
        {
            let conn = spaces::open_space(&desc).unwrap();
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "引导拿到源端数据");
        }
        let joining_left = std::fs::read_dir(&coord.data_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".joining-"))
            .count();
        assert_eq!(joining_left, 0, "staging 无残留");
        // reservation 已释放(账户占用现在由磁盘上的正式库承担)。
        assert!(coord.account_reservations.lock().unwrap().is_empty());
        let err = coord.account_free(None, &acct).unwrap_err();
        assert!(err.contains("已被空间"), "占用改由正式库承担:{err}");
        // admission 回 Idle:再来一次 join(错码)立即走流程而非「已有加入」。
        let err = coord.join_space(&url, "slot-0000-0000-0000-0000", |_, _, _| {}).await.unwrap_err();
        assert!(!err.contains("已有一次"), "{err}");
        src_task.abort();
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src_dir);
        let _ = std::fs::remove_dir_all(&sdir);
    }

    /// admission 两向(§3.3 二轮 H2)+ 失败路清场:sync_all 在跑 → join 立即拒;
    /// join 失败(连不上服务器)→ 无 .joining 残留、reservation 空、admission 回
    /// Idle(sync_all 随后照跑);手工占 Joining → sync_all 拒「正在加入空间」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn join_admission_excludes_sync_all_and_cleans_up_on_failure() {
        let slow = SweepTimings {
            per_space: Duration::from_secs(30),
            global_cap: Duration::from_secs(60),
            quiet: Duration::from_millis(200),
        };
        let (coord, dir) = boot_coord("join-adm", &["家庭"], slow).await;
        let fam = coord.all_descriptors()[1].clone();
        {
            let conn = Connection::open(&fam.path).unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','01AAAAAAAAAAAAAAAAAAAAACCT'),
                   ('k_acc','{z}'),('device_key','{z}'),('server_url','ws://127.0.0.1:1');",
                z = "00".repeat(32),
            ))
            .unwrap();
        }
        coord.refresh_catalog().unwrap();
        let coord = Arc::new(coord);
        // ① sync_all 在跑 → join 立即拒(不排队、不建槽)。
        let c2 = coord.clone();
        let sweep = tokio::spawn(async move { c2.sync_all(|_, _, _| {}).await });
        for _ in 0..100 {
            if coord.foreground().1 == Phase::ManualSyncing {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let err = coord.join_space("ws://127.0.0.1:1", "slot-0000-0000-0000-0000", |_, _, _| {})
            .await
            .unwrap_err();
        assert!(err.contains("全部同步"), "{err}");
        let joining = std::fs::read_dir(&coord.data_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".joining-"))
            .count();
        assert_eq!(joining, 0, "被拒的 join 不建槽");
        coord.request_cancel_sync_all();
        let _ = sweep.await.unwrap();
        coord.take_pending_bridge();
        // ② join 失败(连不上)→ 槽清干净、reservation 空、admission 回 Idle。
        let err = coord.join_space("ws://127.0.0.1:1", "slot-0000-0000-0000-0000", |_, _, _| {})
            .await
            .unwrap_err();
        assert!(!err.contains("全部同步"), "{err}");
        let joining = std::fs::read_dir(&coord.data_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".joining-"))
            .count();
        assert_eq!(joining, 0, "失败路无 .joining 残留");
        assert!(coord.account_reservations.lock().unwrap().is_empty());
        // ③ 手工占 Joining → sync_all 拒「正在加入空间」;guard drop 恢复 Idle。
        {
            let _g = HeavyOpGuard::acquire(&coord.heavy, HeavyOp::Joining).unwrap();
            let err = coord.sync_all(|_, _, _| {}).await.unwrap_err();
            assert!(err.contains("正在加入空间"), "{err}");
        }
        let report = coord.sync_all(|_, _, _| {}).await.unwrap();
        assert_eq!(report.outcomes.len(), 1, "guard drop 后 admission 恢复 Idle");
        coord.take_pending_bridge();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 直接 drop 在飞的 join future(命令层消亡,codex 一轮 M1):RAII 链(HeavyOp
    /// guard / cancel 槽 / AbortOnDrop transport)全体收场——admission 立即回 Idle、
    /// 取消槽清空、后续 join/sync_all 照常受理,绝无 detached staging transport 与
    /// 新一轮并存。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn dropping_join_future_restores_admission() {
        // 挂死服务器:accept 后不回话,join 停在配对拨号/握手上。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = listener.accept().await {
                held.push(s);
            }
        });
        let (coord, dir) = boot_coord("join-drop", &[], fast()).await;
        let coord = Arc::new(coord);
        let c2 = coord.clone();
        let url = format!("ws://{addr}");
        let join = tokio::spawn(async move {
            c2.join_space(&url, "slot-0000-0000-0000-0000", |_, _, _| {}).await
        });
        tokio::time::sleep(Duration::from_millis(400)).await; // 进到挂起的网络等待
        join.abort(); // = drop join future
        let _ = join.await;
        // admission 恢复:立即能再进一次 join(错地址秒败,但不是「已有一次加入」)。
        let err = coord
            .join_space("ws://127.0.0.1:1", "slot-0000-0000-0000-0000", |_, _, _| {})
            .await
            .unwrap_err();
        assert!(!err.contains("已有一次"), "{err}");
        // 取消槽已清(request_cancel_join 无副作用地 no-op)。
        assert!(coord.join_cancel.lock().unwrap().is_none());
        // sync_all 照常受理(无已配对空间=空结果,但没被 Joining 挡)。
        assert!(coord.sync_all(|_, _, _| {}).await.unwrap().outcomes.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// HeavyOpGuard 的 reaper(codex 二轮 M1):staging 任务停在**同步段**(tokio
    /// abort 是协作式取消,要到下个 await 点才落地)时 drop guard——admission 必须
    /// **保持占用**,任务真消亡后才回 Idle;立即翻 Idle 会让新 join/sync_all 与
    /// 垂死的旧 staging transport 并存。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn heavy_guard_drop_reaps_staging_before_idle() {
        let state = Arc::new(Mutex::new(HeavyOp::Idle));
        let slot: StagingTaskSlot = Arc::new(Mutex::new(None));
        let mut g = HeavyOpGuard::acquire(&state, HeavyOp::Joining).unwrap();
        g.attach_staging(slot.clone());
        // barrier(codex 三轮 L1):证明子任务已被首次 poll、真进了同步段,再 drop
        // ——否则 abort 可能先于首次 poll,任务未跑就取消,断言窗提前翻 Idle。
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        *slot.lock().unwrap() = Some(tokio::spawn(async move {
            started_tx.send(()).unwrap();
            // 模拟 transport 的同步段(整段无 await:abort 只能等它跑完)。
            std::thread::sleep(Duration::from_millis(400));
            transport::TransportExit::Stopped
        }));
        started_rx.recv_timeout(std::time::Duration::from_secs(5)).expect("子任务应已启动");
        drop(g);
        assert_eq!(*state.lock().unwrap(), HeavyOp::Joining, "任务未死不许翻 Idle");
        for _ in 0..100 {
            if *state.lock().unwrap() == HeavyOp::Idle {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(*state.lock().unwrap(), HeavyOp::Idle, "任务消亡后 reaper 复位");
        // 槽空时 drop = 立即 Idle(正常路 stop_staging 已收口)。
        let mut g = HeavyOpGuard::acquire(&state, HeavyOp::Joining).unwrap();
        g.attach_staging(Arc::new(Mutex::new(None)));
        drop(g);
        assert_eq!(*state.lock().unwrap(), HeavyOp::Idle);
    }

    /// PutBack 取消窗的定向回归锚(codex 四轮 L1,三轮 M1 的精确序列):
    /// stop_staging 取柄 → 卡在等待 → 外层 future 被 drop → 句柄**归还槽** →
    /// admission guard 的 Drop 从槽接管(abort + reaper)→ 任务真消亡才 Idle。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stop_staging_cancelled_mid_wait_returns_handle_for_reaper() {
        let slot: StagingTaskSlot = Arc::new(Mutex::new(None));
        let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(false);
        // 顽固任务:无视 shutdown、停在 await 点(只有 abort 能杀)。
        *slot.lock().unwrap() = Some(tokio::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        }));
        let slot2 = slot.clone();
        let stopper =
            tokio::spawn(async move { stop_staging(&shutdown_tx, &slot2).await });
        // 确定性进窗(codex 五轮 L1):等到槽被取空 = stop_staging 已取柄、正卡在
        // 等待——否则 abort 可能先于首次 poll,槽本来就是 Some,断言假绿。
        for _ in 0..500 {
            if slot.lock().unwrap().is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(slot.lock().unwrap().is_none(), "stop_staging 应已取柄进入等待窗");
        stopper.abort(); // = 外层 join future 被 drop
        let _ = stopper.await;
        assert!(
            slot.lock().unwrap().is_some(),
            "取消窗内句柄必须归还槽(否则 detach,guard 无从接管)"
        );
        // 接管:guard drop → abort + reaper → 任务消亡后 Idle、槽清空。
        let state = Arc::new(Mutex::new(HeavyOp::Idle));
        let mut g = HeavyOpGuard::acquire(&state, HeavyOp::Joining).unwrap();
        g.attach_staging(slot.clone());
        drop(g);
        for _ in 0..100 {
            if *state.lock().unwrap() == HeavyOp::Idle {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(*state.lock().unwrap(), HeavyOp::Idle, "reaper 等到任务消亡后复位");
        assert!(slot.lock().unwrap().is_none());
    }

    /// 账户 reservation fail-closed(§3.5):reservation 在场时,join 的账户闸拒且
    /// 指路重启——「publish 成功、集成失败」后的重试不许二次加入同一账户。
    /// (open-signup 后创号不再过闸:账户 ULID 自生成,撞 reservation=违背 ULID
    /// 唯一性假设,与 device_id 同待遇。)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn account_reservation_fails_closed_until_restart() {
        let (coord, dir) = boot_coord("join-resv", &[], fast()).await;
        coord
            .account_reservations
            .lock()
            .unwrap()
            .insert("01AAAAAAAAAAAAAAAAAAAAACCT".into());
        let err = coord.account_free(None, "01AAAAAAAAAAAAAAAAAAAAACCT").unwrap_err();
        assert!(err.contains("重启"), "{err}");
        // 别的账户不受连坐。
        coord.account_free(None, "01AAAAAAAAAAAAAAAAAAAAACC2").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 跨空间移动幸福路:前台=main 的一条灵感移进「家庭」(非 live 目标)→ Moved;
    /// 源库不再有它、目标库(直接开库直查,证一次性写连接确实落库)新生一条同内容。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_between_moves_to_non_live_target() {
        let (coord, dir) = boot_coord("move-ok", &["家庭"], fast()).await;
        let fam = coord.all_descriptors()[1].id.clone();
        let id = coord
            .write(spaces::MAIN_SPACE, |c, k| notes::capture(c, k, "搬我到家庭"))
            .await
            .unwrap();
        let r = coord.move_between(spaces::MAIN_SPACE, &fam, &id).await.unwrap();
        assert!(matches!(r, MoveResult::Moved { source_already_gone: false, .. }), "{r:?}");
        let src_cnt = coord
            .with_read(spaces::MAIN_SPACE, |c| {
                c.query_row("SELECT COUNT(*) FROM items WHERE content=?1", ["搬我到家庭"], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(src_cnt, 0, "源条目已删");
        let fam_desc = coord.descriptor(&fam).unwrap();
        let dst = spaces::open_space(&fam_desc).unwrap();
        let dst_cnt: i64 = dst
            .query_row("SELECT COUNT(*) FROM items WHERE content=?1", ["搬我到家庭"], |r| r.get(0))
            .unwrap();
        assert_eq!(dst_cnt, 1, "目标新生一条");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 后端闸(不信 UI 列表):源≠前台一律拒;源==目标早拒;两拒都不动源。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_between_rejects_non_foreground_source_and_same_space() {
        let (coord, dir) = boot_coord("move-gate", &["家庭"], fast()).await;
        let fam = coord.all_descriptors()[1].id.clone();
        let id = coord
            .write(spaces::MAIN_SPACE, |c, k| notes::capture(c, k, "别乱移"))
            .await
            .unwrap();
        // 源=家庭(非前台)→ 前台闸拒。
        let err = coord.move_between(&fam, spaces::MAIN_SPACE, &id).await.unwrap_err();
        assert!(err.contains("目标空间已经变化"), "{err}");
        // 源==目标 → 早拒。
        let err = coord.move_between(spaces::MAIN_SPACE, spaces::MAIN_SPACE, &id).await.unwrap_err();
        assert!(err.contains("无需移动"), "{err}");
        let cnt = coord
            .with_read(spaces::MAIN_SPACE, |c| {
                c.query_row("SELECT COUNT(*) FROM items WHERE content=?1", ["别乱移"], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(cnt, 1, "被拒的移动分毫不动源");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 目标带 Resetting 墓碑(重置半途)→ is_stopped 闸在 open_space 前拒(codex #1):
    /// 绝不给正被重置的库开一次性写连接。目标库未被写入。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_between_rejects_resetting_target() {
        let (coord, dir) = boot_coord("move-reset", &["家庭"], fast()).await;
        let fam = coord.all_descriptors()[1].clone();
        let id = coord
            .write(spaces::MAIN_SPACE, |c, k| notes::capture(c, k, "别写进重置库"))
            .await
            .unwrap();
        // 非 live 的家庭立 Resetting 墓碑(未激活 id begin_reset 直接立、即时返回)。
        let _ticket = coord.sup.begin_reset(&fam.id).await.unwrap();
        let err = coord.move_between(spaces::MAIN_SPACE, &fam.id, &id).await.unwrap_err();
        assert!(err.contains("正忙"), "{err}");
        // 目标库分毫未碰:用**普通只读连接**查(不用 open_space——它自己会切 WAL,
        // 反而掩盖「move 有没有开过目标」)。新建未激活库恒 journal_mode=delete,move
        // 若开过目标就会切 WAL;仍是 delete = 根本没开(codex 复审增强)。
        let dst = Connection::open_with_flags(&fam.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mode: String = dst.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "delete", "move 被拒 = 从未 open_space 目标、未切 WAL");
        let dst_cnt: i64 =
            dst.query_row("SELECT COUNT(*) FROM items WHERE content=?1", ["别写进重置库"], |r| r.get(0))
                .unwrap();
        assert_eq!(dst_cnt, 0, "重置墓碑期目标绝不被写");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 移动打断运行中的「全部同步」:pin 住 orchestrate future + 每 50ms 重发取消
    /// (codex #1)→ 遍历秒级收摊,移动不会拿着 lifecycle 空等整轮 sweep。断言 =
    /// 遍历运行中发起的移动**秒级返回**(而非 per_space 30s 的 sweep 时长)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_cancels_running_sync_all_promptly() {
        let slow = SweepTimings {
            per_space: Duration::from_secs(30),
            global_cap: Duration::from_secs(60),
            quiet: Duration::from_millis(200),
        };
        let (coord, dir) = boot_coord("move-cancel", &["家庭"], slow).await;
        let fam = coord.all_descriptors()[1].clone();
        // 家庭配假账户,sync_all 才会去扫它(遍历停在观察窗)。
        {
            let conn = Connection::open(&fam.path).unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','01AAAAAAAAAAAAAAAAAAAAACCT'),
                   ('k_acc','{z}'),('device_key','{z}'),('server_url','ws://127.0.0.1:1');",
                z = "00".repeat(32),
            ))
            .unwrap();
        }
        coord.refresh_catalog().unwrap();
        let id = coord
            .write(spaces::MAIN_SPACE, |c, k| notes::capture(c, k, "打断遍历"))
            .await
            .unwrap();
        let coord = Arc::new(coord);
        let c2 = coord.clone();
        let sweep = tokio::spawn(async move { c2.sync_all(|_, _, _| {}).await });
        for _ in 0..100 {
            if coord.foreground().1 == Phase::ManualSyncing {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let started = tokio::time::Instant::now();
        let r = coord.move_between(spaces::MAIN_SPACE, &fam.id, &id).await;
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(15),
            "移动应秒级返回(重发取消收摊遍历)而非空等整轮 sweep,实测 {elapsed:?} / 结果 {r:?}"
        );
        // 取消收摊后 orchestrate 交还、前台回 Ready、家庭已停:移动真正落地(codex
        // 复审增强)。拿到 orchestrate 恒在 sweep 完整交还之后,家庭必已 is_stopped。
        assert!(matches!(r, Ok(MoveResult::Moved { .. })), "{r:?}");
        let _ = sweep.await.unwrap();
        coord.take_pending_bridge();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
