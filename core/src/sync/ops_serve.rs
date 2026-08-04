//! op 追赶的惰性供流:计划、节流与公平调度(L-d″ 第①笔,[lan-direct-plan](../../../docs/lan-direct-plan.md) §6.1)。
//!
//! **病**:`on_hello` / `on_want` / `outbound` 三处都汇进 `ops_frames`——SQL 无 `LIMIT`、
//! 整个区间先 `collect` 再切帧、切帧无帧数上限。一枚很小的 Hello 或 `Want{from_seq:1}`
//! 就让一次引擎输入产出任意多枚 `Ops` 帧、同一次 dispatch 全部入队,撞穿每链 256 帧 /
//! 8 MiB → 断链 → 重建再 Hello → 纯局域网可能永久追不齐。与 263(blob 整图)、264
//! (BlobWant 清单)、266(隔离重验)**同族**:单次引擎输入的最大合法产出 > 承载它的上界。
//!
//! **形**(照 264 的 C′):引擎不再产 N 枚帧,只产一枚计划;帧由消费方**逐帧惰性取**,
//! 窗口 = 1 帧。三道上界因此**结构性不可达**——不是「限得更小」,是「不再有能撞的东西」。
//!
//! 本模块管三件:**下一帧该由谁出**(计划、节流、两层公平)、**那一帧读什么**
//! ([`PeerWork::prepare_next`],窗口 1 帧的唯一取数点)、**Hello 带多少水位**
//! ([`bounded_watermarks`],预算内子集 + 轮转)。投递在第②/④笔。
//! **当前整模块 dormant**:生产路径一处都不接,全部由测试驱动。
//!
//! **留给消费方(第②/④笔)的两条义务**,本模块给得出判据、给不出执行:
//! * [`Served::frame`] 为 `None` 时是空转 —— 提交游标、不发帧、**接着取下一枚**;
//!   连续空转每次都有界且游标严格前进,但「一次唤醒最多取几枚」得由泵自己封
//!   (否则一个几千 origin 全已齐的计划会在一次唤醒里跑满整张表)。
//! * [`OpsFrame::bytes`] 越过那条腿的 wire 上限时**当场终局**(响亮 advisory + 取消该
//!   work),**绝不重复读同一条自旋**——单条超大 op 独占一帧时它可以接近 1 MiB(§10 M4)。
//!
//! ## 为什么是节流而不是防倒带水位(设计审五轮反转,epoch 形否决)
//!
//! 防倒带水位一旦成为**拒绝低水位请求**的判据,就得回答「服务器 Ack 只证明接手、不证明
//! 对端已应用」(信箱 72h TTL + 溢出丢最老),而它的下修授权只能挂在 `Peer{online}` 上
//! ——**那是个可丢事件**(服务端 `push` 是 `try_send` 且返回值被丢弃)。节流形里这条
//! 根本不存在:**不拿任何水位做拒绝判据**,冷却到点就自己往前走,信号只决定快慢。
//!
//! ## 所有权 = 三类生命期(设计审六轮 H1/H2)
//!
//! * [`PeerThrottle`](冷却与 bypass)—— 住引擎槽,**跨链路换代、跨中转重连存活**;
//! * [`PeerWork`](计划负载)—— 同住槽里,但**工作全空即可释放大对象**;
//! * 执行态(在飞的那一帧)—— LAN 归具体链路对象、链死即丢;relay 归槽、会话收场回滚。
//!
//! 两者**必须分开**:合在一起的话「空槽回收」会把冷却一并洗掉,下一枚请求又是「首次
//! 立即开」= 冷却形同虚设(六轮 H1,codex 确认是真洞)。

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

use super::engine::{encoded_op_len, BROADCAST, MAX_OPS_FRAME_BYTES, MAX_OPS_PER_FRAME};
use crate::replay::RemoteOp;

/// 补洞(`Want`)那一档的冷却:1 拍心跳 ≈ 30s。
///
/// 比对账档短一半是刻意的:pending 池超限时当场发的那枚 `want{watermark+1}` 是**连续
/// 回放的活性支点**,让它跟全量对账吃同一档冷却,真实缺口就要等「剩余全量计划 + 冷却」
/// (设计审六轮 H2 证伪了我原稿的「最迟一个冷却期」)。
pub(crate) const RANGE_COOLDOWN_TICKS: u64 = 1;

/// 全量对账(`Hello`)那一档的冷却:2 拍 ≈ 60s。
pub(crate) const RECONCILE_COOLDOWN_TICKS: u64 = 2;

/// 每空间的 per-target 状态数硬上界(§10「一处一数」)。
///
/// **它统计全部 per-target 状态**([`PeerThrottle`] + [`PeerWork`]),**禁止另设不计数的
/// overflow 旁表**——设计审七轮判死了「新 target 排队等冷却」那个形:排队本身至少要存
/// target id + 折叠标记 + 冷却资格,不计数就是无界旁表,计数就已经是第 65 个槽。
///
/// 数值依据**不是**照搬 `MAX_LAN_PEER_RECORDS`(那条是历史设备累计后 fail-closed,性质
/// 不同):这里是「支持拓扑内**同时有真实工作**的 target ≤ relay 16 + LAN 16,64 是给
/// 冷却墓碑留的余量」。
pub(crate) const OPS_TARGET_MAX: usize = 64;

/// 每 target 的细粒度补洞段上界;第 17 个 origin 退化成 [`PlanKind::Full`] = 明确的有界降级。
pub(crate) const OPS_RANGES_PER_TARGET: usize = 16;

/// 每 target 的对端水位图编码字节预算(约容得下上千个 26 字符 origin,远高于正常设备规模)。
///
/// **出站 Hello 的水位预算绑的是同一个数**(设计审七轮 M2):不然新版客户端发出的正常
/// Hello 一到收端就被折叠成全量重扫。
pub(crate) const OPS_WATERMARK_BYTES_PER_TARGET: usize = 64 * 1024;

/// 跨全部 target 的水位图聚合预算。正常 16 个 relay 对端恰好各有 64 KiB 完整额度。
pub(crate) const OPS_WATERMARK_BYTES_AGGREGATE: usize = 1024 * 1024;

/// 单 origin 的补洞段(来自 `Want{origin, from_seq}`)。上界由应答方自己的水位定,
/// 故只记起点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Range {
    pub(crate) origin: String,
    /// 下一条该发的 seq(闭区间下界)。
    pub(crate) next_seq: i64,
}

/// 对账计划的粒度。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlanKind {
    /// 带对端水位图:只补「我高你低」的那些段。
    Detailed {
        /// 对端报的水位;**缺席按 0**(它只会让我多给,不会让它误以为已齐)。
        peer: BTreeMap<String, i64>,
        /// 这张图的编码字节数(算进 per-target 与聚合两道预算)。
        bytes: usize,
    },
    /// 折叠态:丢掉细粒度账,该 target 全量重扫(等价于「所有 origin 水位按 0」)。
    /// **常量大小**——这正是它存在的理由:预算超限时降级而不是拒掉 target(七轮 H3)。
    Full,
}

/// 对账计划的游标。**常量大小**;快照在开计划那一刻钉死。
///
/// **没有 `Done` 这一档**(实现审 H5):计划走完 = 计划**没了**(`active` 当场释放)。
/// 留一档「已完成但还占着 `active`」会让 `PeerWork::is_empty` 恒为假 → 墓碑永远回收
/// 不掉 → 64 个 target 之后永久 `Overload`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReconcileCursor {
    /// 还没开始扫(下一步:找字典序最小的 origin)。
    Start,
    /// 正扫着 `origin`,下一条 seq 是 `next_seq`。
    At { origin: String, next_seq: i64 },
    /// `origin` 已扫完,下一步:找它之后的下一个 origin。
    AfterOrigin { origin: String },
}

/// 一份全量对账计划。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReconcilePlan {
    /// **开计划那一刻钉死的插入快照边界**,全程只服务 `rowid <= snapshot_rowid` 的行
    /// (设计审六轮 H1)。只记 `(origin, next_seq)` 游标不够:持续新增的 origin 能让计划
    /// **永远跑不完**,补洞快车道永远排不到。
    ///
    /// **这条边界的安全性靠的不是「oplog 不许 DELETE」**(七轮 M4 纠正:`oplog` 无显式
    /// `INTEGER PRIMARY KEY`,**原地 `VACUUM` 可重排 rowid**,与有没有 DELETE 无关),
    /// 而是:仓里只有 `VACUUM INTO`(写新文件、不动源库)+ 纪元压实换 `EngineKey` 丢 work。
    /// **在制 work 期间禁止对源库做原地 `VACUUM` 或任何 rowid 重写;将来要加须先撤引擎槽。**
    pub(crate) snapshot_rowid: i64,
    pub(crate) kind: PlanKind,
    pub(crate) cursor: ReconcileCursor,
}

impl ReconcilePlan {
    /// 该 origin 的起点 = 对端水位 + 1(折叠态与缺席都按 0 → 从 1 开始)。
    /// **`None` = 这个 origin 没有可欠的后继**,取数直接跳过它。
    ///
    /// 形态闸只要求水位非负,故 `i64::MAX` 是合法输入(实现审 M2/二轮 L1)。裸 `+1` 在
    /// debug 下 panic、release 下绕成负数从表头全量重发;`saturating` 也不准——它会算出
    /// `>= i64::MAX` 这个谓词,库里真有那条 seq 时还会重发一遍。`checked` 才是准的。
    pub(crate) fn start_seq(&self, origin: &str) -> Option<i64> {
        match &self.kind {
            PlanKind::Full => Some(1),
            PlanKind::Detailed { peer, .. } => {
                peer.get(origin).copied().unwrap_or(0).checked_add(1)
            }
        }
    }

    fn watermark_bytes(&self) -> usize {
        match &self.kind {
            PlanKind::Full => 0,
            PlanKind::Detailed { bytes, .. } => *bytes,
        }
    }
}

/// 「下一帧该读什么」——**纯描述,不含任何 op 字节**,且**不含快照**。
///
/// 快照恒从活动计划取(实现审 H7):描述符自己带一份的话,「描述符的快照 + 另一代计划的
/// 水位图」这种配对就成立了,而它不报错、只**静默漏发**。本类型现在是模块私有,
/// 取数与武装都收在 [`PeerWork::prepare_next`] 里,调用方拿不到可自由拼装的两半。
#[derive(Debug, Clone, PartialEq, Eq)]
enum FrameSpec {
    /// 补洞:单 origin 从 `from_seq` 起。**不受对账快照约束**——它是对端当下点名要的
    /// 缺口,拿最新事实答才对。
    Gap { origin: String, from_seq: i64 },
    /// 对账:找 `after` 之后字典序最小的 origin(`None` = 从头)。
    ReconcileSeek { after: Option<String> },
    /// 对账:继续当前 origin。
    ReconcileAt { origin: String, from_seq: i64 },
}

/// 取数之后该把游标推到哪。由取数层算出、随在飞位存着,**提交时才生效**。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Advance {
    /// 补洞段推进到 `next_seq`;`done` = 该段已到应答方水位,出队。
    Range { next_seq: i64, done: bool },
    /// 对账推进到某 origin 的 `next_seq`。
    ReconcileAt { origin: String, next_seq: i64 },
    /// 该 origin 已供完,下一步从它之后继续。
    ReconcileAfter { origin: String },
    /// 快照内再没有可供的 origin,计划完成。
    ReconcileDone,
}

/// 在飞那一笔的提交凭据。**[`PeerWork::prepare_next`] 不推进计划,只有
/// [`PeerWork::commit`] 推进**(设计审十轮钉死的基础 API 契约):LAN 只在 `write_all`
/// 成功后提交、relay 只在 **Ack** 后提交;失败 / 断链 / Nack 一律走
/// [`PeerWork::rollback`],一步都不推进;**过期或重复的凭据提交不了**。
///
/// **两根轴都绑**(实现审 H6 —— 只绑 `seq` 等于没绑:每份 work 的号都从 0 起,
/// A 的凭据能提交 B 的在飞笔):`work_id` **进程内全局单调**(二轮 M1:只在单个
/// [`OpsWorks`] 内唯一还不够,两个空间的第一份 work 又都是 0),target 被驱逐后重建
/// 也换新号;`seq` 每次武装 +1。字段私有 + 无 `Clone`,而 [`PeerWork::commit`] 与
/// [`PeerWork::rollback`] 都**按值吃掉它**,故一枚凭据至多用一次。
#[derive(Debug)]
pub(crate) struct CommitToken {
    work_id: u64,
    seq: u64,
}

/// [`PeerWork::prepare_next`] 的产出:这一次要发的帧(`None` = 空转)+ 提交凭据。
#[derive(Debug)]
pub(crate) struct Prepared {
    /// `None` = 空转:段已到本机水位 / 该 origin 对端已齐 / 计划扫完 / 跳过预算用尽。
    /// 空转**照样要提交**(游标得往前走),只是不发帧。
    pub(crate) frame: Option<OpsFrame>,
    pub(crate) token: CommitToken,
}

/// 一次取数的三种结局。**`Occupied` 与真错误分型是第②笔留给第④笔的义务①**
/// (transport.rs 那条待办注释):同一个 target 的窗口只有一个,而所有权表给了两种执行态
/// (LAN 归链路对象 / relay 归全局数据窗口),**两条腿同时盯一个对端时后到的那条必然撞上
/// 它** —— 那是**正常争用不是故障**。原先它与「凭据发号器耗尽」这类真错误挤在同一个
/// `Err(String)` 里,消费方分不出,于是 LAN 那条腿会为一次正常争用**拆掉健康的直连链**。
#[derive(Debug)]
pub(crate) enum Prepare {
    /// 这份 work 此刻没活干(队列空 ∧ 无活动计划)。
    Idle,
    /// 窗口被**另一条腿**占着。消费方的处置写死在两处:relay 泵**跳到下一个 target**
    /// (§6.2 ⑨-4 ③:不许让整枚全局窗口睡下),LAN 泵灭 armed 睡下等唤醒。
    Occupied,
    /// 有一笔要发(`frame == None` 是空转,照样要提交)。
    Ready(Prepared),
}

#[cfg(test)]
impl Prepare {
    /// 测试便捷:只有 `Ready` 才拿得出东西。
    pub(crate) fn ready(self) -> Option<Prepared> {
        match self {
            Prepare::Ready(p) => Some(p),
            _ => None,
        }
    }
}

/// 在飞的那一笔。
#[derive(Debug)]
struct Inflight {
    seq: u64,
    spec: FrameSpec,
    advance: Advance,
}

/// **节流水位**:住引擎槽、跨链路换代与中转重连存活。
///
/// 与 [`PeerWork`] 分开是硬要求(六轮 H1):合在一起的话「工作全空即回收」会把冷却
/// 一并洗掉,下一枚请求又按「首次立即开」处理 = 冷却形同虚设。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PeerThrottle {
    /// 早于它不许开新的补洞段。
    pub(crate) next_range_tick: u64,
    /// 早于它不许开新的对账计划(**折叠态 `Full` 同样受这一档管**,七轮:否则 Range
    /// 洪水把 target 打进折叠态就能每 30s 诱发一次全库扫描)。
    pub(crate) next_reconcile_tick: u64,
    /// `Peer{online}` 给的一次性加速券:只被**下一枚有效 Hello** 消费。
    ///
    /// 它最迟随 `next_reconcile_tick` 一起失效(见 [`TargetState::tombstone_expired`])
    /// ——不然没人发 Hello 时会留一块**永久墓碑**占着槽。
    pub(crate) bypass_once: bool,
}

impl PeerThrottle {
    /// 首次:两档都立即有资格。**正常新设备首次入场立即服务**,不吃冷却(七轮 H1:
    /// 我原稿把新 target 降级成等 60s,错了)。
    fn fresh(tick: u64) -> Self {
        PeerThrottle { next_range_tick: tick, next_reconcile_tick: tick, bypass_once: false }
    }
}

/// **计划负载**:工作全空即可释放大对象,但**不许连 [`PeerThrottle`] 一起删**。
#[derive(Debug)]
pub(crate) struct PeerWork {
    /// 凭据绑的那根身份轴(实现审 H6)。由 [`OpsWorks`] 单调发号,target 驱逐后重建
    /// 也换新号,故旧凭据永远提交不了新 work。
    id: u64,
    /// 当前全量对账计划。
    active: Option<ReconcilePlan>,
    /// 补洞快车道。**队列内部也逐帧轮转**(六轮 M1):每发一帧就把未跑完的段推到队尾
    /// ——`VecDeque` 本身不构成公平证明,不这么写的话一条 `[1, 一百万]` 的段会整段跑完
    /// 才轮到下一条,**第一枚大 Want 又能饿死别的真实缺口**。
    urgent: VecDeque<Range>,
    /// 冷却期内登记、等着进快车道的补洞段(实现审 H1)。
    ///
    /// **冷却只挡「开始服务」,不挡「登记义务」**:原先冷却内的新 Want 直接丢,而
    /// **对端不周期重发 Want**(`Engine::on_tick` 只续图侧发问),那个缺口就永久没人补了
    /// ——「靠一个信号触发,而信号可能不来」的同族。段数与 [`Self::urgent`] **合并计入**
    /// `OPS_RANGES_PER_TARGET`,故登记不是无界面。
    deferred: VecDeque<Range>,
    /// 待重开的对账(冷却期内、或计划正忙时到达的 Hello 合并在这里)。
    pending: Option<PendingReconcile>,
    /// 两层公平的第一层:上一帧是不是补洞出的。**粒度是单枚帧** —— 每发一枚补洞帧,
    /// 下一枚数据机会就归对账,故 Want 洪水最多拿走 ops 面的 50%,这是**公平保证**。
    last_was_urgent: bool,
    /// 在飞的那一笔(窗口 = 1;在飞时不许再取,见 [`Self::prepare_next`])。
    inflight: Option<Inflight>,
    /// 凭据发号器:单调、不回绕,**过期 token 提交不了**。
    next_token: u64,
}

/// 冷却期内到达、等着开的对账请求。**合并一律取保守下界**(六轮 H2:我原稿写的
/// 「覆盖成最新」是错的——后到的较高 Hello 会抹掉已登记的较低 Want)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingReconcile {
    pub(crate) kind: PlanKind,
}

impl PeerWork {
    fn new(id: u64) -> PeerWork {
        PeerWork {
            id,
            active: None,
            urgent: VecDeque::new(),
            deferred: VecDeque::new(),
            pending: None,
            last_was_urgent: false,
            inflight: None,
            next_token: 0,
        }
    }

    /// 在飞位武装着没有(仅测试)。**第②笔的消费面验收只能从这一侧看**:凭据在写泵那边
    /// 已经随 `Drop` 走了,「回滚到底落没落」的唯一可观测处就是引擎槽里这一位。
    #[cfg(test)]
    pub(crate) fn inflight_armed(&self) -> bool {
        self.inflight.is_some()
    }

    /// 这份 work 一共武装过几笔(仅测试)。**「终局」与「死自旋」两条路的唯一区别就在这
    /// 一格**:两者线上都一个字节不出、advisory 也一模一样,只有发号器会替死自旋作证
    /// ——没有它,「帧封不出之后本链 ops 腿终局」这条规则就没有可证伪的变异。
    #[cfg(test)]
    pub(crate) fn arms_issued(&self) -> u64 {
        self.next_token
    }

    fn is_empty(&self) -> bool {
        self.active.is_none()
            && self.urgent.is_empty()
            && self.deferred.is_empty()
            && self.pending.is_none()
            && self.inflight.is_none()
    }

    fn watermark_bytes(&self) -> usize {
        let a = self.active.as_ref().map_or(0, ReconcilePlan::watermark_bytes);
        let p = self.pending.as_ref().map_or(0, |p| match &p.kind {
            PlanKind::Full => 0,
            PlanKind::Detailed { bytes, .. } => *bytes,
        });
        a + p
    }

    /// 计划空闲 = 可以开新的对账计划。**在飞时不算空闲**(实现审 H2):换掉 `active`
    /// 会让在飞那一笔的 `Advance` 提交到**新计划**的游标上。
    fn plan_idle(&self) -> bool {
        self.active.is_none() && self.inflight.is_none()
    }

    /// 此刻 [`Self::prepare_next`] 拿得出东西吗 —— 即「该有人来取」。
    ///
    /// `deferred` 与 `pending` **不算**:它们还在冷却里,得等 [`OpsWorks::on_tick`] 放行;
    /// 那一刻的「从没活变成有活」正是要通报消费腿的事(第②笔实现审 H2)。
    fn has_runnable(&self) -> bool {
        !self.urgent.is_empty() || self.active.is_some()
    }

    /// 取下一帧:**挑段 → 取数 → 武装三件收在这一处**(实现审 H6/H7)。
    ///
    /// 调用方拿不到可自由拼装的「描述符 + 计划」两半,故「拿 A 计划的水位图配 B 描述符
    /// 的快照」这种静默漏发在类型层就不成立;凭据也在这里绑上本 work 的身份。
    ///
    /// **一步也不推进游标**——推进恒在 [`Self::commit`]。返回 [`Prepare::Idle`] = 这份
    /// work 此刻没活干;`Prepare::Ready(p)` 里 `p.frame` 为 `None` 是**空转**(照样要提交)。
    ///
    /// 在飞时回 [`Prepare::Occupied`]:窗口 1 仍是结构事实(不靠调用方自律),但它是
    /// **正常争用不是故障**,故与真错误分型(见 [`Prepare`])。要重取先 [`Self::rollback`]
    /// ——游标没动,重取拿到的就是同一段。
    pub(crate) fn prepare_next(&mut self, conn: &Connection) -> Result<Prepare, String> {
        if self.inflight.is_some() {
            return Ok(Prepare::Occupied);
        }
        let Some(spec) = self.pick_next() else { return Ok(Prepare::Idle) };
        let served = match &spec {
            FrameSpec::Gap { origin, from_seq } => read_gap(conn, origin, *from_seq)?,
            FrameSpec::ReconcileSeek { .. } | FrameSpec::ReconcileAt { .. } => {
                let plan = self.active.as_ref().expect("对账描述符只可能由活动计划产出");
                read_reconcile(conn, &spec, plan)?
            }
        };
        let seq = self.next_token;
        // 注释承诺「单调不回绕」,那就得**真的**不回绕(三轮 L1):裸 `+= 1` 在 release
        // 下到 MAX 会绕,绕回去就可能与远古凭据撞号。2^64 次到不了,但耗尽即响亮终局。
        self.next_token =
            seq.checked_add(1).ok_or_else(|| "内部错:凭据发号器耗尽".to_string())?;
        self.inflight = Some(Inflight { seq, spec, advance: served.advance });
        Ok(Prepare::Ready(Prepared {
            frame: served.frame,
            token: CommitToken { work_id: self.id, seq },
        }))
    }

    /// 下一帧该读什么。两层公平:第一层在补洞与对账之间**逐帧**交替;第二层在补洞
    /// 队列内部轮转(由 [`Self::commit`] 把未跑完的段推到队尾兑现)。
    fn pick_next(&self) -> Option<FrameSpec> {
        let has_urgent = !self.urgent.is_empty();
        let has_plan = self.active.is_some();
        match (has_urgent, has_plan) {
            (false, false) => None,
            (true, false) => self.spec_urgent(),
            (false, true) => self.spec_plan(),
            // 都在场:上一帧归谁,这一帧就归另一个。
            (true, true) => {
                if self.last_was_urgent {
                    self.spec_plan()
                } else {
                    self.spec_urgent()
                }
            }
        }
    }

    fn spec_urgent(&self) -> Option<FrameSpec> {
        let r = self.urgent.front()?;
        Some(FrameSpec::Gap { origin: r.origin.clone(), from_seq: r.next_seq })
    }

    fn spec_plan(&self) -> Option<FrameSpec> {
        let p = self.active.as_ref()?;
        match &p.cursor {
            ReconcileCursor::Start => Some(FrameSpec::ReconcileSeek { after: None }),
            ReconcileCursor::At { origin, next_seq } => {
                Some(FrameSpec::ReconcileAt { origin: origin.clone(), from_seq: *next_seq })
            }
            ReconcileCursor::AfterOrigin { origin } => {
                Some(FrameSpec::ReconcileSeek { after: Some(origin.clone()) })
            }
        }
    }

    /// 凭据校验:在飞位存在 ∧ 两根轴都对得上。**提交与回滚共用这一处**——少了回滚那半,
    /// 一枚迟到 / 错路由的失败事件就能清掉**另一枚新的**在飞笔(它不推进游标,但会让
    /// 正确的凭据随后提交失败,白白重发一轮,二轮 M1)。
    fn check_token(&self, token: &CommitToken) -> Result<(), String> {
        let inflight_seq = match &self.inflight {
            Some(f) => f.seq,
            None => return Err("内部错:没有在飞的那一笔".into()),
        };
        if token.work_id != self.id || token.seq != inflight_seq {
            return Err(format!(
                "内部错:凭据对不上(凭据 work {}/seq {},在飞 work {}/seq {inflight_seq})",
                token.work_id, token.seq, self.id
            ));
        }
        Ok(())
    }

    /// 提交:游标在这里、且只在这里推进。凭据**按值吃掉**,对不上(过期 / 重复 /
    /// 张冠李戴)一律不提交并响亮 `Err` ——调用方据此收场,不许当成成功。
    pub(crate) fn commit(&mut self, token: CommitToken) -> Result<(), String> {
        self.check_token(&token)?;
        let Some(Inflight { spec, advance, .. }) = self.inflight.take() else {
            unreachable!("check_token 刚判过在飞位非空")
        };
        match advance {
            Advance::Range { next_seq, done } => {
                self.last_was_urgent = true;
                // 队头没了 = 在飞期间这些段被折叠进了全量重扫(`collapse_gaps`),那份
                // 义务已由 Full 覆盖,这里不该也不必再动队列。
                let Some(mut r) = self.urgent.pop_front() else { return Ok(()) };
                // **在飞期间来了一枚更早起点的 Want:不许把游标抬过它**(变异对照 ⑰ 挖出)。
                // 判据 = 在飞那一笔的起点:队里的值比它还低,只可能是 `on_want` 在这一笔
                // 出门之后下修过。照原样提交就会把「低位 → 在飞起点」那段缺口**吞掉**,
                // 对端要等下一轮 Want 才能再要一次。留在低位则至多重发一段,**重复由
                // op_id 幂等吸收**——与本模块「合并一律取保守下界」同一条纪律。
                let served_from = match &spec {
                    FrameSpec::Gap { from_seq, .. } => *from_seq,
                    _ => i64::MIN,
                };
                if r.next_seq < served_from {
                    self.urgent.push_back(r);
                } else if !done {
                    r.next_seq = next_seq;
                    // **未跑完就推到队尾**(六轮 M1):放回队头等于让第一枚大 Want
                    // 整段跑完,别的真实缺口全被饿死。
                    self.urgent.push_back(r);
                }
            }
            Advance::ReconcileAt { origin, next_seq } => {
                self.last_was_urgent = false;
                let p = self.active.as_mut().expect("在飞期间活动计划不可能被换掉");
                p.cursor = ReconcileCursor::At { origin, next_seq };
            }
            Advance::ReconcileAfter { origin } => {
                self.last_was_urgent = false;
                let p = self.active.as_mut().expect("在飞期间活动计划不可能被换掉");
                p.cursor = ReconcileCursor::AfterOrigin { origin };
            }
            Advance::ReconcileDone => {
                self.last_was_urgent = false;
                // **计划走完就当场释放**(实现审 H5):留着「已完成的 active」会让
                // `is_empty` 恒假 → 墓碑永远回收不掉 → 64 个 target 之后永久 Overload。
                self.active = None;
            }
        }
        Ok(())
    }

    /// 投递失败 / 断链 / Nack:**释放在飞位但一步也不推进**。
    ///
    /// 同样吃凭据(二轮 M1):执行态跨 LAN 换代与中转会话,**迟到的失败事件是消费方
    /// 必然要处置的形** —— 无凭据的回滚会让一枚旧事件把新的在飞笔清掉。
    pub(crate) fn rollback(&mut self, token: CommitToken) -> Result<(), String> {
        self.check_token(&token)?;
        self.inflight = None;
        Ok(())
    }

    // ---- 合并入口(只给 `OpsWorks` 用;预算校验恒由 `OpsWorks::enforce_budget` 收口) ----

    /// 该 origin 是不是已经被「已提交游标 ∪ **在飞前沿**」扫过了。
    ///
    /// **在飞那半是实现审 H3**:只看已提交游标的话,`ReconcileSeek` 已武装未提交期间
    /// 到达的低位 Want 会去下修计划水位图,而随后那一笔提交把游标推过该 origin
    /// ——那段缺口**被静默吞掉**。补洞分支早修过同族问题(变异 ⑰),对账分支漏了。
    fn plan_frontier_passed(&self, origin: &str) -> bool {
        let Some(p) = &self.active else { return true };
        let by_cursor = match &p.cursor {
            ReconcileCursor::Start => false,
            ReconcileCursor::At { origin: cur, .. }
            | ReconcileCursor::AfterOrigin { origin: cur } => cur.as_str() >= origin,
        };
        let by_inflight = match self.inflight.as_ref().map(|f| &f.advance) {
            Some(Advance::ReconcileAt { origin: o, .. } | Advance::ReconcileAfter { origin: o }) => {
                o.as_str() >= origin
            }
            Some(Advance::ReconcileDone) => true,
            _ => false,
        };
        by_cursor || by_inflight
    }

    /// 把活动计划里该 origin 的起点下修到 `from_seq`(折叠态本就按 0,无需动)。
    /// 字节数**重算不增量估**(一处一数),随后由调用方过预算。
    fn lower_plan_start(&mut self, origin: &str, from_seq: i64) {
        let Some(p) = &mut self.active else { return };
        if let PlanKind::Detailed { peer, bytes } = &mut p.kind {
            let e = peer.entry(origin.to_string()).or_insert(from_seq - 1);
            *e = (*e).min(from_seq - 1);
            *bytes = watermark_map_bytes(peer);
        }
    }

    /// 已登记的同 origin 段取更早起点(快车道与冷却队列都算)。
    fn lower_existing_gap(&mut self, origin: &str, from_seq: i64) -> bool {
        for q in [&mut self.urgent, &mut self.deferred] {
            if let Some(r) = q.iter_mut().find(|r| r.origin == origin) {
                r.next_seq = r.next_seq.min(from_seq);
                return true;
            }
        }
        false
    }

    fn gaps_len(&self) -> usize {
        self.urgent.len() + self.deferred.len()
    }

    /// 第 17 个 origin:丢细粒度账、该 target 全量重扫 = 明确的有界降级。
    /// **恒受对账那一档冷却**(排进 pending,不产生新的开计划资格)。
    fn collapse_gaps(&mut self) {
        self.urgent.clear();
        self.deferred.clear();
        self.pending = Some(PendingReconcile { kind: PlanKind::Full });
    }

    /// 冷却到点:把登记的义务转进快车道(同 origin 取更早起点)。
    fn promote_deferred(&mut self) {
        while let Some(r) = self.deferred.pop_front() {
            if !self.lower_existing_gap(&r.origin, r.next_seq) {
                self.urgent.push_back(r);
            }
        }
    }

    /// 预算超限时的降级:**保留 snapshot 与游标**,只把细粒度账换成全量重扫。
    /// 已扫过的部分不重来,余下的按「对端水位 0」供——多给是安全侧。
    fn collapse_watermarks(&mut self) {
        if let Some(p) = &mut self.active {
            p.kind = PlanKind::Full;
        }
        if self.pending.is_some() {
            self.pending = Some(PendingReconcile { kind: PlanKind::Full });
        }
    }
}

/// 一个 target 的全部 per-target 状态。**`OPS_TARGET_MAX` 统计的就是它**——
/// 出站 Hello 的轮转游标也住这儿(实现审 M1:§10 明定它必须计数、**禁止旁表**;
/// 放成裸类型的话第⑤笔只能另建一张不受 64 管的 map)。
#[derive(Debug)]
struct TargetState {
    throttle: PeerThrottle,
    work: PeerWork,
    /// 发往该目的地的 Hello 水位子集轮转游标(BROADCAST 也占一格,见 [`OpsWorks::hello_cursor`])。
    hello_cursor: HelloCursor,
    /// 最近一次有请求落到它头上的刻度;驱逐「最旧的纯冷却墓碑」时用。
    last_touch_tick: u64,
    /// **`unknown_device` 跨代探针**(§6.1 八轮 H1;L-d″ 第④笔下半):首次撞 unknown 时
    /// 记下当时的中转 generation,**不取消工作**;下一个鉴权成功的新 generation 允许它
    /// 重试一次;**更晚的 generation 再次 unknown** = 该 target 真的没了 → 取消它的
    /// relay work + 响亮 advisory。
    ///
    /// **住这儿而不是另开一张 map**:§10 明禁 per-target 旁表,而这张表已经受
    /// [`OPS_TARGET_MAX`] 管。代价:target 被驱逐(纯冷却墓碑回收)时标记一并没了,
    /// 而那要求 `work.is_empty()` —— 没有工作也就没有「该不该取消工作」这个问题。
    unknown_since: Option<u64>,
    /// **中转腿刚在这个 target 上撞过 Nack:本拍让位给直连**(codex 实现审二轮 H)。
    ///
    /// 要挡的那条路:relay 发一帧 → 服务器 `busy` → 释放窗口 → 下一次唤醒里
    /// [`Deck::relay_data_pump`] **同步**跑在摇 LAN 铃之前,当场把这枚在飞位重新占回去
    /// ——`notify_one` 不产生调度检查点,LAN 醒来只拿得到 `Occupied`。「relay 会话稳定在、
    /// 数据面持续 `busy`、LAN 稳定可用」时这是**确定性**的,直连永远供不上这份 work。
    ///
    /// 而 `busy` 在服务端是**账户/全局字节预算不足**(`hub.rs`),一台慢对端把信箱顶满
    /// 就能持续几分钟——不是一瞬的抖动。
    ///
    /// 形是**一拍的让位**而不是永久偏好:置位后 relay 的候选枚举
    /// ([`OpsWorks::next_runnable_after`])跳过它,直到下一拍心跳由
    /// [`OpsWorks::clear_relay_yields`](唯一写回点)统一清掉。故
    /// * 有直连腿 → 那一拍里 LAN 是唯一的取件人,它整段追赶跑完都不会被 relay 抢;
    /// * **没有直连腿 → 一点都不慢**:清位排在同一拍那趟 sweep **之前**(见
    ///   `Deck::ops_tick` 的第一句),等价于原来的「busy 保留 work,等心跳重试」。
    ///
    /// **BROADCAST 恒不置位**(§6.2 ①):本机 origin 只许权威完成腿消费,让给 LAN 就是
    /// 「谁抢到谁提交」,别的对端那一帧永远补不上。
    relay_yield: bool,
}

impl TargetState {
    /// 没有任何真实工作 —— **满额时可以被挤掉**的那种。这是压力下的明确降级:代价只是
    /// 那个旧身份的轮转游标从头再来,不丢任何同步义务。
    fn is_evictable(&self) -> bool {
        self.work.is_empty()
    }

    /// **日常心跳**可以整条回收——四件都得满足:工作全空 ∧ **没有未走完的轮转游标**
    /// ∧ 两档冷却均到期 ∧ bypass 已失效。此后下一枚请求按「首次立即开」处理是**合法**
    /// 的,因为旧冷却是**真的**到期了。
    ///
    /// **游标那一件是实现审二轮 H1**(我原先写「丢了只是报得更慢」是错的):水位图超预算
    /// 时游标才非空,而 Hello 之间**必经心跳**——每次心跳都抹掉游标的话,每一枚 Hello 都
    /// 从表头开始,预算外那半区**永远报不出去**。而 origin 数是**历史 oplog 的 origin 总数**,
    /// 不受「当前支持拓扑」限制,所以这不是个够不着的角落。
    fn tombstone_expired(&self, tick: u64) -> bool {
        self.is_evictable()
            && self.hello_cursor.after.is_none()
            && tick >= self.throttle.next_range_tick
            && tick >= self.throttle.next_reconcile_tick
            && !self.throttle.bypass_once
    }
}

/// 每空间一份的 target 表。
#[derive(Debug, Default)]
pub(crate) struct OpsWorks {
    targets: BTreeMap<String, TargetState>,
    /// 消费方摸过这张表几次(仅测试)。**「没活就该停下等唤醒」这条规则的唯一可观测面**
    /// ——它在线上字节、状态面、武装发号器三格全同形,只有「还在不在反复摸库」分得开
    /// (第②笔实现审 M2)。
    #[cfg(test)]
    probes: u64,
}

/// work 身份发号器:**进程内全局**单调、不回绕(二轮 M1:每空间一份的话,两个空间的
/// 第一份 work 又都是 0,A 空间的凭据照样能提交 B 空间的第一笔)。target 被驱逐后重建
/// 拿到的也是新号,故旧凭据提交不了新 work。
static NEXT_WORK_ID: AtomicU64 = AtomicU64::new(0);

/// 取一个 work 身份号(**唯一取号点**,见 [`NEXT_WORK_ID`])。
fn next_work_id() -> u64 {
    NEXT_WORK_ID
        .fetch_update(AtomicOrdering::Relaxed, AtomicOrdering::Relaxed, |n| n.checked_add(1))
        .expect("work 身份发号器耗尽(2^64 次取号)")
}

/// [`OpsWorks::note_unknown`] 的裁决(§6.1 八轮 H1 的跨代探针三步)。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UnknownVerdict {
    /// 记下怀疑、**工作照留**:下一个新 generation 允许它重试一次。
    Probed,
    /// 换了一代仍 unknown:该 target 的 relay work 已被取消(整份 [`PeerWork`] 换新号),
    /// 调用方须**响亮报一次 advisory** —— 这是丢同步工作,不许静默。
    ///
    /// ⚠ 换号的连带后果如实记着:此刻若另一条腿正攥着这份 work 的旧凭据,它的
    /// commit/rollback 会撞「凭据对不上」而响亮(LAN 那条腿即拆链重建)。这正是
    /// §6.1「真把凭据弄丢了,安全的恢复只有销毁整份 `PeerWork`」那一条的兑现。
    Cancelled,
    /// 表里压根没有这个 target 的工作(已被驱逐 / 从未建过):无事可做。
    NoWork,
}

/// 收下一枚请求之后的处置(供调用方记 advisory / 响亮收场用)。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Admit {
    /// 收下了(可能是新开、合并进 pending,或折叠)。
    Ok,
    /// 收下但降级成了全量重扫——**有界降级须报一次 advisory**(七轮 H3 ⑥)。
    Collapsed,
    /// 64 项全都还有真实工作:超出支持拓扑或成员恶意 churn,**响亮 overload,
    /// 绝不创建第 65 项**。这条边界归 §9「不防账户成员以自己身份作恶」——
    /// **不得宣称「任意历史 target 数下同时零拒绝且内存有界」**。
    Overload,
    /// 请求的形态不合:**一个字节都不留**(连 target 条目都不建)。
    ///
    /// 这道闸不是抄 Hello 那条的形式主义:`Want{origin}` 的 origin 在新形里是要**存进
    /// 补洞队列**的,而它整条来自线上、长度只受 wire 帧上限管。不收紧就是
    /// 64 target × 16 段 × 近 1 MiB 的留存面——今天 `on_want` 只校验 `from_seq`
    /// (engine.rs:2280),因为今天那个 origin 查完水位就丢,一个字节都不留。
    ///
    /// `target` 走的是另一把尺(见 [`vet_target`]):它的合法域是
    /// `BROADCAST | 规范设备 id`,不是任意 String(实现审 L2)。
    Malformed,
}

/// 计划表的锁。**中毒即响亮终局**,与 `db mutex poisoned` 同一条纪律(实现审 H3)。
///
/// 我原先在这里写了 `into_inner` 吞中毒,理由是「凭据两轴自证守着不变量」——**那个理由是
/// 错的**:凭据只保护「这枚提交对应哪一笔」,保护不了 `active`/`pending`/`urgent`/冷却/
/// 预算这些账。持锁期间 panic 完全可能停在半次改动上,拿着半张表接着供才是真正危险的一档。
///
/// **住这里而不是 transport**(第⑤笔):引擎侧的三个生产入口与有界 Hello 也要取这把锁,
/// 两处各写一遍就会有两份中毒政策。
pub(crate) fn lock_ops(m: &Mutex<OpsWorks>) -> std::sync::MutexGuard<'_, OpsWorks> {
    m.lock().expect("ops works mutex poisoned")
}

/// 收下一枚请求之后的**完整**回执:处置 + 「这个 target 刚从无活变成有活吗」
/// (§6.2 ④;第②笔实现审 H2 那一族的第八例)。
///
/// **为什么不能只回 [`Admit`]**:冷却期到点由 [`OpsWorks::on_tick`] 交名单,而**请求
/// 到达那一刻**变得可跑的那些,今天一个信号都没有 —— 典型漏法是「`on_want` 在冷却外
/// 进 `urgent` → 没人摇铃 → 消费腿还睡着 → 等下一个偶然事件」。`on_tick` 那条也补不上:
/// 它只报 false→true 的边沿,而此刻 work 已经 runnable 了,下一拍不再是边沿。
///
/// `woke` 与 `on_tick` 用**同一把尺**([`PeerWork::has_runnable`] 调用前后对比),
/// 且**一处算**([`OpsWorks::admitted`])——三个入口各写一遍就是三份会漂移的判据。
#[derive(Debug, PartialEq, Eq)]
#[must_use = "woke=true 的 target 必须当场唤醒消费腿,否则这枚请求带来的工作没人来取"]
pub(crate) struct Admitted {
    pub(crate) admit: Admit,
    /// 本次调用**使**这个 target 从「无可跑工作」变成「有可跑工作」。
    ///
    /// 只报**变化**不报**状态**:本来就 runnable 的 target 再来一枚请求不算摇铃——
    /// 它此刻要么正被消费,要么已经有人被 `Occupied`/`ops_changed` 那条链接住了。
    pub(crate) woke: bool,
}

/// 逻辑目的地的合法域 = `BROADCAST` ∪ 规范设备 id(实现审 L2)。
///
/// 不能直接套设备 id 那把单值尺:本机 origin 的 outbound work 挂在 BROADCAST 上。
/// 但也不该因此就完全不校验——裸 String 会给第⑤笔留下误接与大字符串留存面。
fn vet_target(target: &str) -> bool {
    target == BROADCAST || crate::clock::is_canonical_device_id(target)
}

impl OpsWorks {
    /// 这个 target 此刻有可跑的工作吗(表里没有条目 = 没有)。
    fn runnable_of(&self, target: &str) -> bool {
        self.targets.get(target).is_some_and(|st| st.work.has_runnable())
    }

    /// 三个请求入口的**唯一出口**:把处置与「刚变得可跑吗」封成一枚回执。
    ///
    /// 走单一出口而不是各入口自己拼:`Malformed`/`Overload` 那些提前返回最容易漏掉
    /// `woke` 的计算,而漏掉的方向恰好是**丢**(该摇没摇 = 工作永久没人取),不是多摇。
    fn admitted(&self, target: &str, was_runnable: bool, admit: Admit) -> Admitted {
        Admitted { admit, woke: !was_runnable && self.runnable_of(target) }
    }

    /// 收一枚 Hello:开对账计划,或(冷却未到 / 计划正忙)合并进 pending。
    ///
    /// **不许覆盖仍活动或在飞的计划**(实现审 H2):`eligible` 只看时间与 bypass 的话,
    /// 一枚 Hello 就能把跑到中途的游标重置回 `Start`(Hello 洪水每两拍来一次 = 计划
    /// 永远跑不完),在飞那一笔的 `Advance` 还会提交到新计划上,`pending` 里已定的
    /// `Full` 也会被重新展开——这三条正是 M1 与折叠态第⑤条要挡的。
    pub(crate) fn on_hello(
        &mut self,
        target: &str,
        vetted: VettedWatermarks,
        snapshot_rowid: i64,
        tick: u64,
    ) -> Admitted {
        let was = self.runnable_of(target);
        let admit = self.on_hello_inner(target, vetted, snapshot_rowid, tick);
        self.admitted(target, was, admit)
    }

    fn on_hello_inner(
        &mut self,
        target: &str,
        vetted: VettedWatermarks,
        snapshot_rowid: i64,
        tick: u64,
    ) -> Admit {
        if !vet_target(target) {
            return Admit::Malformed;
        }
        if self.ensure(target, tick) == Admit::Overload {
            return Admit::Overload;
        }
        let VettedWatermarks { peer, bytes } = vetted;
        let st = self.targets.get_mut(target).expect("ensure 刚建过");
        st.last_touch_tick = tick;

        // 已有的 pending 与这枚 Hello 先合并(保守下界,Full 占优),再决定开还是继续等
        // ——不合并的话「先前定下的全量重扫」会被一枚新 Detailed 悄悄降回细粒度。
        let merged = merge_kind(st.work.pending.take(), PlanKind::Detailed { peer, bytes });
        let due = tick >= st.throttle.next_reconcile_tick || st.throttle.bypass_once;
        if st.work.plan_idle() && due {
            // bypass 只被**有效 Hello** 消费一次;`Range` 洪水触发的折叠既不消费也不制造它。
            st.throttle.bypass_once = false;
            st.throttle.next_reconcile_tick = tick + RECONCILE_COOLDOWN_TICKS;
            st.work.active =
                Some(ReconcilePlan { snapshot_rowid, kind: merged, cursor: ReconcileCursor::Start });
        } else {
            st.work.pending = Some(PendingReconcile { kind: merged });
        }
        self.admit_after_budget(target)
    }

    /// 收一枚 Want:进补洞快车道,或(该 origin 还在活动计划的未扫部分)只下修计划里的
    /// 起点,或(补洞那一档冷却内)先**登记**着等心跳放行。
    ///
    /// 形态闸两道:`target` 走 [`vet_target`]、`origin` 必须是规范设备 id;`from_seq`
    /// 照 `Engine::on_want` 同一条(engine.rs:2280)要求 ≥1 —— 少了它 `from_seq - 1`
    /// 会在下修起点时溢出。**不合形连 target 条目都不建**。
    pub(crate) fn on_want(
        &mut self,
        target: &str,
        origin: &str,
        from_seq: i64,
        tick: u64,
    ) -> Admitted {
        let was = self.runnable_of(target);
        let admit = self.on_want_inner(target, origin, from_seq, tick);
        self.admitted(target, was, admit)
    }

    fn on_want_inner(&mut self, target: &str, origin: &str, from_seq: i64, tick: u64) -> Admit {
        if !vet_target(target) || !crate::clock::is_canonical_device_id(origin) || from_seq < 1 {
            return Admit::Malformed;
        }
        if self.ensure(target, tick) == Admit::Overload {
            return Admit::Overload;
        }
        let st = self.targets.get_mut(target).expect("ensure 刚建过");
        st.last_touch_tick = tick;

        // ⓪ 已经进了折叠 pending:新 Want 只能**维持**该标记(折叠态第⑤条),既不重开
        // 细粒度段、也不下修计划水位图 —— 那份义务已由全量重扫整个覆盖。少了这条,
        // Range 洪水把 target 打进折叠态之后**还能接着吃 Range 那一档的快车道**,
        // 「资源超限从 30s 档退化到 60s 档」这条有界降级就成了空话(实现审二轮 H2)。
        // advisory 在折叠那一刻已报过一次,这里回 Ok。
        if matches!(st.work.pending, Some(PendingReconcile { kind: PlanKind::Full })) {
            return Admit::Ok;
        }

        // ① 还在活动计划的未扫部分(含在飞前沿之后)→ 只下修起点,不新开段(六轮 H2)。
        if !st.work.plan_frontier_passed(origin) {
            st.work.lower_plan_start(origin, from_seq);
            // 下修会把新 origin 塞进水位图 → **必须过预算**(实现审 H4:原先这条路
            // 既不更新 bytes 也不校验,单 target 可用无限多个伪造 origin 撑大活动计划)。
            return self.admit_after_budget(target);
        }
        // ② 已登记的同 origin 段:取更早的起点(保守下界)。
        if st.work.lower_existing_gap(origin, from_seq) {
            return Admit::Ok;
        }
        // ③ 新段。两队合计封顶,第 17 个 origin 折叠成全量重扫 = 明确的有界降级。
        if st.work.gaps_len() >= OPS_RANGES_PER_TARGET {
            st.work.collapse_gaps();
            return Admit::Collapsed;
        }
        let gap = Range { origin: origin.to_string(), next_seq: from_seq };
        // ④ **本机 origin 的推送豁免冷却**(第⑤笔实测拍板;用户定的)。
        //
        // 这道冷却挡的是**对端点名要的补洞洪水** —— 那是线上输入驱动的,数量不受本机控制。
        // 而 BROADCAST 这一格的 gap 由**本机写命令**驱动,冷却在这条路上挡不住任何洪水:
        // 一段 gap 的上界由取数那一刻的水位定,故连续写只会被**同一段**吸收;真正「新开
        // 一段」只发生在上一段被抽干之后,而那正意味着对端已经追平了。
        //
        // 不豁免的代价实测过:抽干后再写一条要等下一拍心跳才放行,**本地写到对端可见最坏
        // 多 30s** —— 交互式同步明显变钝,而换不来任何保护。
        //
        // 连 `next_range_tick` 也不动:动了就等于让本机推送去消费对端那一档的额度。
        //
        // ⚠ **两个 `BROADCAST` 判断说的不是同一件事,别当重复**(变异对照挖出来的):
        // 外层 = 「本机的推送不被节流」,内层 = 「本机的推送不去节流别人」。今天外层**恰好**
        // 是内层的推论 —— 内层从不推进 `next_range_tick`,而它起手是 [`PeerThrottle::fresh`]
        // 给的建表刻度,故 `tick >= next_range_tick` 对 BROADCAST 恒真(单拆外层,一条测都
        // 不会红,如实记在 293)。**这是巧合不是设计**:`fresh` 哪天改成 `tick + COOLDOWN`,
        // 外层立刻重新承重。故两条都留,各自守各自那句话。
        if target == BROADCAST || tick >= st.throttle.next_range_tick {
            if target != BROADCAST {
                st.throttle.next_range_tick = tick + RANGE_COOLDOWN_TICKS;
            }
            st.work.urgent.push_back(gap);
        } else {
            // **冷却只挡「开始服务」,不挡「登记义务」**(实现审 H1):丢掉就没有任何
            // 续做所有者——对端不周期重发 Want。心跳到点由 `promote_deferred` 放行。
            st.work.deferred.push_back(gap);
        }
        Admit::Ok
    }

    /// `Peer{online}`:只给一枚一次性加速券。**它是可丢事件**,丢了必须仍由普通
    /// Hello/Want + 冷却期收敛——正确性一步都不许挂在它身上。
    ///
    /// 已经有资格开计划时不发券(实现审 H5):那张券不会加速任何事,却会把条目钉成
    /// **永久墓碑**(`tombstone_expired` 要求 bypass 已失效)。
    ///
    /// **`woke` 在这条路上恒为假**(§6.2 ④「`on_peer_online` 一律不摇铃」),但**照样
    /// 老实算**而不是写死 `false`:券只改冷却资格、不产生工作,这是今天的**结构事实**;
    /// 哪天有人让它顺手开出计划来,老实算的那把尺会当场把铃摇起来,写死的则是静默丢。
    pub(crate) fn on_peer_online(&mut self, target: &str, tick: u64) -> Admitted {
        let was = self.runnable_of(target);
        let admit = self.on_peer_online_inner(target, tick);
        self.admitted(target, was, admit)
    }

    fn on_peer_online_inner(&mut self, target: &str, tick: u64) -> Admit {
        if !vet_target(target) {
            return Admit::Malformed;
        }
        if self.ensure(target, tick) == Admit::Overload {
            return Admit::Overload;
        }
        let st = self.targets.get_mut(target).expect("ensure 刚建过");
        if tick < st.throttle.next_reconcile_tick {
            st.throttle.bypass_once = true;
        }
        st.last_touch_tick = tick;
        Admit::Ok
    }

    /// 心跳:放行登记的补洞义务、让加速券到期、冷却到点把 pending 开成活动计划,顺手
    /// 回收彻底到期的墓碑。(**收回让位不在这里** —— 那件事不许挂在本函数跑不跑得成上,
    /// 见 [`Self::clear_relay_yields`] 与 [`Deck::ops_tick`]。)
    ///
    /// **不再交「刚变得可跑」的名单**(codex 实现审二轮 L1)。第②笔立这条时,冷却到点是
    /// 本模块自己把义务变成可跑工作的那一刻,而消费腿正睡在唤醒铃上,漏摇就是永久停摆;
    /// 二轮 H 之后调用方每一拍无条件扫一遍全表 idle-runnable([`Self::idle_runnable_targets`]),
    /// 那份精确名单**结构上已被更宽的一趟吸收**。留着一个没人消费的 `#[must_use]` 只会制造
    /// 虚假的编译期保障 —— 将来真做增量优化时,连同真实消费者一起恢复。
    pub(crate) fn on_tick(&mut self, tick: u64, snapshot_rowid: i64) {
        for st in self.targets.values_mut() {
            if tick >= st.throttle.next_range_tick && !st.work.deferred.is_empty() {
                st.throttle.next_range_tick = tick + RANGE_COOLDOWN_TICKS;
                st.work.promote_deferred();
            }
            // 加速券最迟随对账冷却一起失效(六轮 H1)。到了这个点它本就加速不了任何事
            // ——留着只会把条目钉成永久墓碑,占着 64 格里的一格。
            if tick >= st.throttle.next_reconcile_tick {
                st.throttle.bypass_once = false;
            }
            let due = tick >= st.throttle.next_reconcile_tick || st.throttle.bypass_once;
            if due && st.work.plan_idle() && st.work.pending.is_some() {
                st.throttle.bypass_once = false;
                st.throttle.next_reconcile_tick = tick + RECONCILE_COOLDOWN_TICKS;
                let p = st.work.pending.take().expect("上一行刚判过非空");
                st.work.active = Some(ReconcilePlan {
                    snapshot_rowid,
                    kind: p.kind,
                    cursor: ReconcileCursor::Start,
                });
            }
        }
        self.targets.retain(|_, st| !st.tombstone_expired(tick));
    }

    pub(crate) fn work_mut(&mut self, target: &str) -> Option<&mut PeerWork> {
        self.targets.get_mut(target).map(|t| &mut t.work)
    }

    /// **中转腿的**下一个轮转候选(§6.2 ⑨-4;L-d″ 第④笔下半):从 `after`(**不含**)起
    /// 按 target 字典序绕一圈,回第一个「**此刻能被中转腿领走**」的 target ——
    /// 有活(`has_runnable`)∧ 在飞位空 ∧ **没在让位给直连**([`TargetState::relay_yield`])。
    ///
    /// **一次只回一个**,不是一张名单:消费方每跑完一回合状态就变了(游标进了 / 窗口占上了
    /// / 那份 work 空了),按老名单接着跑等于拿过期事实做决策。回合上界由消费方的 K 管。
    ///
    /// **为什么要预筛在飞位**:被另一条腿占着的那些,消费方拿到也只会撞 [`Prepare::Occupied`]
    /// 白摸一次库。**预筛不能取代 `Occupied` 的处置**——一放锁就可能过期(另一条腿在这中间
    /// 武装了它),那条竞态由 `Occupied` 收口。
    ///
    /// **让位那一格只在这条路上生效**,不进 [`Self::idle_runnable_targets`]:那条是拿来摇
    /// 直连铃的,而让位的全部意思正是「这一拍改由直连来取」。
    ///
    /// 扫描量的上界是表本身([`OPS_TARGET_MAX`] = 64),不是数据规模;不摸库。
    pub(crate) fn next_runnable_after(&self, after: Option<&str>) -> Option<String> {
        debug_assert!(self.targets.len() <= OPS_TARGET_MAX, "target 表的上界由 ensure 守");
        let tail = self.targets.iter().filter(|(k, _)| after.is_none_or(|a| k.as_str() > a));
        let head = self.targets.iter().filter(|(k, _)| after.is_some_and(|a| k.as_str() <= a));
        tail.chain(head)
            .find(|(_, st)| {
                st.work.has_runnable() && st.work.inflight.is_none() && !st.relay_yield
            })
            .map(|(k, _)| k.clone())
    }

    /// **中转腿在这个 target 上撞了 Nack:本拍让位给直连**(codex 实现审二轮 H;理由与
    /// 边界见 [`TargetState::relay_yield`])。
    ///
    /// 不在表里 = 那份 work 已随撤位/驱逐没了,没有可让的位子。**BROADCAST 由调用方挡在
    /// 门外**(§6.2 ①),这里 `debug_assert` 兜一道,免得日后有人把它接错。
    pub(crate) fn yield_relay(&mut self, target: &str) {
        debug_assert_ne!(target, BROADCAST, "本机 origin 只许权威完成腿消费,不许让位");
        if let Some(st) = self.targets.get_mut(target) {
            st.relay_yield = true;
        }
    }

    /// **让位一律收回**(见 [`TargetState::relay_yield`])。让位那一格的**唯一写回点**,
    /// 两处调用各管一条边界:
    ///
    /// * **每一拍心跳**([`Deck::ops_tick`] 的**第一句**)—— 让位只让一拍。排在最前是硬
    ///   要求:本模块的 [`Self::on_tick`] 前面隔着 `outbound` 的 `?`,挂在那后面的话,
    ///   一次读库失败就能让让位跨过好几拍(「已提交的义务不许随 `?` 蒸发」,268 那条)。
    ///   它也必须早于同一拍那趟 sweep,否则中转要多等一整拍才重试。
    /// * **中转会话收场**(`session_wrapup`,与 [`RelayData::clear`] 同处)—— 让位是
    ///   **这条会话内**的事实:`busy` 说的是那一刻服务端的字节预算,`unknown_device`
    ///   更是明写「下一代允许重试一次」。带过会话边界的话,新会话建起来的第一枚泵会莫名
    ///   跳过它,把跨代探针那条语义推迟一整拍心跳。
    pub(crate) fn clear_relay_yields(&mut self) {
        for st in self.targets.values_mut() {
            st.relay_yield = false;
        }
    }

    /// 中转腿此刻在这个 target 上让着位没有(仅测试)。**「让位在读库失败那一拍照样收回」
    /// 那条规则的唯一观测面**:那一拍 `Deck::ops_tick` 整个返回 `Err`,线上一个字节不出、
    /// 状态面也只多一句错误 —— 外面看不出让位到底清没清。
    #[cfg(test)]
    pub(crate) fn relay_yielding(&self, target: &str) -> bool {
        self.targets.get(target).is_some_and(|st| st.relay_yield)
    }

    /// **此刻能被一个空闲消费者领走的全部 target**(§6.2 ④′-3;`ops_changed` 醒来后扫这一趟)。
    ///
    /// 与 [`Self::next_runnable_after`] 同一把尺(有活 ∧ 在飞位空),差别只在「一个 vs 一批」:
    /// 那条服务的是**一枚窗口**的轮转,这条服务的是「刚空出一个位子,谁该被叫醒」——两条腿
    /// 各有各的窗口,故要一次把全部合格者交出来。
    ///
    /// 扫描量的上界是表本身([`OPS_TARGET_MAX`] = 64),不摸库;**只复制名单**,调用方放锁
    /// 之后才去查路由与摇铃。
    pub(crate) fn idle_runnable_targets(&self) -> Vec<String> {
        debug_assert!(self.targets.len() <= OPS_TARGET_MAX, "target 表的上界由 ensure 守");
        self.targets
            .iter()
            .filter(|(_, st)| st.work.has_runnable() && st.work.inflight.is_none())
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// 某个 target 撞了 `unknown_device`(§6.1 八轮 H1 的跨代探针)。**恒 session-fatal
    /// 由调用方负责**,这里只回答「这份 work 还留不留」。
    pub(crate) fn note_unknown(&mut self, target: &str, generation: u64) -> UnknownVerdict {
        let Some(st) = self.targets.get_mut(target) else { return UnknownVerdict::NoWork };
        match st.unknown_since {
            // 首次:记下代次,**工作照留**。发送者只是被旧连接顶替的话,重连后第二次发送
            // 即 Ack,工作一点没丢。
            None => {
                st.unknown_since = Some(generation);
                UnknownVerdict::Probed
            }
            // 同一代里的又一枚(会话已在收场、尾帧陆续回执):不算第二击。
            Some(g) if g >= generation => UnknownVerdict::Probed,
            // 换了一代仍 unknown = 重试过一次还是不认识它:取消这份 work,否则「结束会话 →
            // 跨会话 work 续做 → 又 unknown」就是永久重连循环。
            Some(_) => {
                st.unknown_since = Some(generation);
                st.work = PeerWork::new(next_work_id());
                UnknownVerdict::Cancelled
            }
        }
    }

    /// 清掉某个 target 的 unknown 怀疑(§6.1 九轮 M1 把清除条件写准了):**只有指向同一
    /// target、且足以证明它仍在 registry 的响应才清** —— Ack,以及同 target 的 `busy` 与
    /// `not_online`(服务端是在验过发送者租约与 target registry **之后**才可能回这两个)。
    /// 无关 peer 或 BROADCAST 的 Ack **一律不清**,否则已被移除的那台永远停在「首次」。
    pub(crate) fn clear_unknown(&mut self, target: &str) {
        if let Some(st) = self.targets.get_mut(target) {
            st.unknown_since = None;
        }
    }

    /// 某 target 此刻记着 unknown 怀疑吗(仅测试:跨代探针的三步在线上字节与状态面上
    /// 只看得到「会话又收场了一次」,标记本身是唯一分得开三步的观测面)。
    #[cfg(test)]
    pub(crate) fn unknown_since(&self, target: &str) -> Option<u64> {
        self.targets.get(target).and_then(|st| st.unknown_since)
    }

    /// 消费方每摸一次这张表记一笔(仅测试;见 [`OpsWorks::probes`])。
    #[cfg(test)]
    pub(crate) fn note_probe(&mut self) {
        self.probes += 1;
    }

    #[cfg(test)]
    pub(crate) fn probes(&self) -> u64 {
        self.probes
    }

    /// 发往该目的地的出站 Hello 轮转游标。**建条目**(故受同一张 64 表管,§10 禁旁表);
    /// 满额时回 `None`,调用方按 overload 响亮记账。
    ///
    /// 每次取用都刷 `last_touch_tick`:游标是**跨 Hello 存活**的东西,不能因为「这个
    /// target 没有 ops 工作」就被当成最旧的墓碑先挤掉(实现审二轮 H1)。
    pub(crate) fn hello_cursor(&mut self, target: &str, tick: u64) -> Option<&mut HelloCursor> {
        if !vet_target(target) || self.ensure(target, tick) == Admit::Overload {
            return None;
        }
        let st = self.targets.get_mut(target)?;
        st.last_touch_tick = tick;
        Some(&mut st.hello_cursor)
    }

    #[cfg(test)]
    pub(crate) fn throttle(&self, target: &str) -> Option<&PeerThrottle> {
        self.targets.get(target).map(|t| &t.throttle)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.targets.len()
    }

    /// **两道水位预算的唯一校验入口**(实现审 H4)。凡是会让某个 target 的水位图长大的
    /// 路径(Hello 合并 / Want 下修活动计划)改完都得立刻过它。
    ///
    /// 两条纠正:①**算的是该 target 保留的全部**(active + pending),原先只把「本次
    /// 那份新 kind」当作它的占用,而冷却内实际两份都留着 → 16 台各多一份 pending 就能
    /// 到约 2 MiB;②超限**只折本次增长的那个 target**(七轮 M1),不折占用最大者——
    /// 原子且可证明:超限前聚合量必 ≤ 上界,本次只动了一个 target,折它必然回到本次
    /// 修改前之下。
    fn enforce_budget(&mut self, target: &str) -> bool {
        let mine = self.targets.get(target).map_or(0, |t| t.work.watermark_bytes());
        let others: usize = self
            .targets
            .iter()
            .filter(|(k, _)| k.as_str() != target)
            .map(|(_, t)| t.work.watermark_bytes())
            .sum();
        if mine <= OPS_WATERMARK_BYTES_PER_TARGET
            && others + mine <= OPS_WATERMARK_BYTES_AGGREGATE
        {
            return false;
        }
        self.targets.get_mut(target).expect("上一行刚读过").work.collapse_watermarks();
        true
    }

    fn admit_after_budget(&mut self, target: &str) -> Admit {
        if self.enforce_budget(target) {
            Admit::Collapsed
        } else {
            Admit::Ok
        }
    }

    /// 建条目(幂等)。满额时先回收彻底到期的墓碑,再驱逐**最旧的纯墓碑**——**即便它
    /// 冷却还没到期**:代价只是那个旧身份短期回来时少节流一轮,**不丢任何同步义务**。
    fn ensure(&mut self, target: &str, tick: u64) -> Admit {
        if self.targets.contains_key(target) {
            return Admit::Ok;
        }
        if self.targets.len() >= OPS_TARGET_MAX {
            self.targets.retain(|_, st| !st.tombstone_expired(tick));
        }
        if self.targets.len() >= OPS_TARGET_MAX {
            let victim = self
                .targets
                .iter()
                .filter(|(_, st)| st.is_evictable())
                .min_by_key(|(k, st)| (st.last_touch_tick, (*k).clone()))
                .map(|(k, _)| k.clone());
            match victim {
                Some(k) => {
                    self.targets.remove(&k);
                }
                // 64 项全都还有真实工作:响亮 overload,绝不建第 65 项。
                None => return Admit::Overload,
            }
        }
        let id = next_work_id();
        self.targets.insert(
            target.to_string(),
            TargetState {
                throttle: PeerThrottle::fresh(tick),
                work: PeerWork::new(id),
                hello_cursor: HelloCursor::default(),
                last_touch_tick: tick,
                unknown_since: None,
                relay_yield: false,
            },
        );
        Admit::Ok
    }
}

/// 两份对账粒度的**保守下界**合并:任一侧是全量重扫,结果就是全量重扫。
fn merge_kind(old: Option<PendingReconcile>, new: PlanKind) -> PlanKind {
    match (old, new) {
        (None, k) => k,
        (Some(PendingReconcile { kind: PlanKind::Full }), _) => PlanKind::Full,
        (Some(_), PlanKind::Full) => PlanKind::Full,
        (
            Some(PendingReconcile { kind: PlanKind::Detailed { peer: a, bytes: _ } }),
            PlanKind::Detailed { peer: b, bytes: _ },
        ) => {
            // 字节数**重算不取两者较大**(一处一数):`merge_low` 只留两边都提到的 key,
            // 合出来的图比哪一边都小,拿 max 记账就是给预算凭空加水。
            let peer = merge_low(a, b);
            let bytes = watermark_map_bytes(&peer);
            PlanKind::Detailed { peer, bytes }
        }
    }
}

/// 两张水位图的**保守下界**合并:同 origin 取较小者,一侧缺席即按 0(= 不进图,起点回 1)。
fn merge_low(a: BTreeMap<String, i64>, b: BTreeMap<String, i64>) -> BTreeMap<String, i64> {
    let mut out = BTreeMap::new();
    for (k, va) in a {
        match b.get(&k) {
            Some(vb) => {
                out.insert(k, va.min(*vb));
            }
            // b 没提这个 origin = b 报 0;保守下界取 0 → 干脆不进图。
            None => {}
        }
    }
    out
}

// ---- 取数:SQL keyset 逐帧惰性取(第①笔后半)-----------------------------------------
//
// 三条 keyset 查询全走 `idx_oplog_origin_seq (origin, origin_seq)`(0024),SQL 文本各只
// 一份 —— `explain_query_plan_anchors_the_three_keyset_queries` 拿的就是这三个常量,
// 免得实现改了 SQL 而查询计划锚还盯着旧文本(设计审 M2 要的那道锚)。

/// 找 `?1` 之后字典序最小的 origin。`rowid <= ?2` 是固定快照边界。
const SQL_SEEK_ORIGIN: &str =
    "SELECT origin FROM oplog WHERE origin > ?1 AND rowid <= ?2 ORDER BY origin LIMIT 1";

/// 单 origin 从 `?2` 起、快照内、按 seq 升序取一段。`LIMIT ?4` 是条数那道尺的兜底,
/// 字节那道尺在游标上逐行判(见 [`read_run`])。
const SQL_READ_RUN: &str = "SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq \
     FROM oplog WHERE origin = ?1 AND origin_seq >= ?2 AND rowid <= ?3 ORDER BY origin_seq LIMIT ?4";

/// 单 origin 水位。索引在位时是 min/max 优化的单点查,不是扫组。
const SQL_WATERMARK_OF: &str = "SELECT MAX(origin_seq) FROM oplog WHERE origin = ?1";

/// 单次取数最多跳过几个「对端已齐」的 origin。
///
/// 为什么必须有:对账计划扫到中段时,余下的 origin 可能整片都已齐(对端水位就是我的
/// 水位),`ReconcileSeek` 一路空转能把整张表的 origin 走一遍——**那又是「单次输入的
/// 工作量由数据规模说了算」**(263/264/266 同一族的判法:最大工作量必须由结构定)。
/// 到限就**不发帧、但把游标推到已看过的位置**;进度严格前进,故计划仍必然走完。
///
/// 64 × 一次索引探针(设计期实测 0.078 ms)≈ 5 ms 持锁,与有界 Hello 那档同量级。
pub(crate) const OPS_SEEK_STEPS_PER_FRAME: usize = 64;

/// 一枚待发的 ops 帧。(`RemoteOp.payload` 是 `serde_json::Value`,故只有 `PartialEq`。)
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OpsFrame {
    pub(crate) origin: String,
    pub(crate) ops: Vec<RemoteOp>,
    /// 帧内 op 的 CBOR 编码字节和 —— **诊断与记账用,不是闸**(第②笔实现审 L1 校准了这条
    /// 注释:原文写「消费方封帧前拿它跟 wire 上限比大小」,而第②笔正确地选了另一条路)。
    ///
    /// 判「这一帧过不过得了这条腿」恒取**真实封帧失败**:封帧那把尺就是那条腿的线上上界,
    /// 前置比大小要么与它重复、要么与它不一致,而不一致就是第二个真相源。单条超大 op 独占
    /// 一帧时这个数可以接近 1 MiB(§10 六轮 M4),消费方据此**记住卡住的段头**、把这一段
    /// 让给别的腿,而不是反复读同一条自旋。
    pub(crate) bytes: usize,
}

/// 一次取数的结果。**两支都带 [`Advance`]**:即便这一次没帧可发,游标也得往前走,
/// 否则下一枚数据机会又从同一处重跑(空转死循环)。
#[derive(Debug, Clone, PartialEq)]
struct Served {
    /// `None` = 空转:段已到本机水位 / 该 origin 对端已齐 / 计划扫完 / 跳过预算用尽。
    frame: Option<OpsFrame>,
    advance: Advance,
}

impl Served {
    fn idle(advance: Advance) -> Served {
        Served { frame: None, advance }
    }
}

/// 补洞取数:单 origin 从 `from_seq` 起,**不受对账快照约束**(对端当下点名要的缺口,
/// 拿最新事实答才对)。
///
/// 读空时 `read_run` 恒回 `exhausted`(第一行不可能被字节尺挡下),故「段已到本机水位
/// → 出队」与「供到尾 → 出队」是同一条规则,不必分两支写。
fn read_gap(conn: &Connection, origin: &str, from_seq: i64) -> Result<Served, String> {
    let run = read_run(conn, origin, from_seq, i64::MAX)?;
    let advance = Advance::Range { next_seq: run.next_seq, done: run.exhausted };
    Ok(Served { frame: run.frame, advance })
}

/// 对账取数。**快照与水位图都从同一份 `plan` 取**(实现审 H7):描述符自己带一份快照的
/// 话,「这一代的快照 + 另一代的水位图」这种配对就成立了,而它不报错、只**静默漏发**
/// (旧计划里偏高的水位把该发的 op 跳过去)。现在两半同源,错配在类型层不成立。
///
/// 一次调用**至多产一枚帧**,故「一次引擎输入 → 任意多枚帧」那条病在这里结构性不存在。
/// 单次工作量的三道上界:条数 [`MAX_OPS_PER_FRAME`] ∧ 字节 [`MAX_OPS_FRAME_BYTES`](先到
/// 为准,与现状 `ops_frames` 同一把尺)∧ 跳过 [`OPS_SEEK_STEPS_PER_FRAME`] 个已齐 origin。
///
/// **不推进任何游标**——只算出「提交时该推到哪」,推进恒由 [`PeerWork::commit`] 做。
fn read_reconcile(
    conn: &Connection,
    spec: &FrameSpec,
    plan: &ReconcilePlan,
) -> Result<Served, String> {
    let snap = plan.snapshot_rowid;
    match spec {
        FrameSpec::ReconcileAt { origin, from_seq } => {
            let run = read_run(conn, origin, *from_seq, snap)?;
            Ok(Served { advance: run.plan_advance(origin), frame: run.frame })
        }
        FrameSpec::ReconcileSeek { after } => {
            let mut at = after.clone();
            for _ in 0..OPS_SEEK_STEPS_PER_FRAME {
                let Some(origin) = seek_origin_after(conn, at.as_deref(), snap)? else {
                    // 快照内再没有可供的 origin —— 计划完成。
                    return Ok(Served::idle(Advance::ReconcileDone));
                };
                if let Some(from) = plan.start_seq(&origin) {
                    let run = read_run(conn, &origin, from, snap)?;
                    if run.frame.is_some() {
                        return Ok(Served { advance: run.plan_advance(&origin), frame: run.frame });
                    }
                }
                at = Some(origin); // 对端在这个 origin 上已齐(或压根没有后继):跳过它。
            }
            // 跳过预算用尽:不发帧,但游标必须落在已看过的位置(否则下一帧原地重跑)。
            let last = at.expect("循环至少跑一轮,且每一轮不是 return 就是写 at");
            Ok(Served::idle(Advance::ReconcileAfter { origin: last }))
        }
        FrameSpec::Gap { .. } => Err("内部错:补洞描述符走错了取数入口".into()),
    }
}

/// 取一段的中间结果。
struct Run {
    frame: Option<OpsFrame>,
    /// 下一条该发的 seq(= 已发最后一条 + 1)。`frame` 为空时无意义。
    next_seq: i64,
    /// 快照内该 origin 已经供完(取数时游标先到头,不是撞上帧的两道尺)。
    exhausted: bool,
}

impl Run {
    /// 对账那两支的 advance:供完就跨过这个 origin,没供完就停在它身上。
    fn plan_advance(&self, origin: &str) -> Advance {
        if self.exhausted {
            Advance::ReconcileAfter { origin: origin.to_string() }
        } else {
            Advance::ReconcileAt { origin: origin.to_string(), next_seq: self.next_seq }
        }
    }
}

/// 读一帧的量:`origin` 从 `from_seq` 起、`rowid <= snapshot_rowid` 内,
/// ≤ [`MAX_OPS_PER_FRAME`] 条 **且** ≤ [`MAX_OPS_FRAME_BYTES`] 编码字节(先到为准,
/// 与 `ops_frames` 逐字同规则——第⑤笔原子切换时两条路产的帧必须一模一样)。
///
/// **字节那道尺在游标上逐行判、判到就 break**:`LIMIT 500` 那道只是条数兜底,真按它
/// 一次 collect 出来,500 条 1 MiB 的 op 就是 500 MiB 物化——那正是本笔要消灭的病。
/// rusqlite 的 `Rows` 是惰性游标,break 之后剩下的行一行都不会读。
fn read_run(
    conn: &Connection,
    origin: &str,
    from_seq: i64,
    snapshot_rowid: i64,
) -> Result<Run, String> {
    let mut stmt = conn.prepare(SQL_READ_RUN).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query((origin, from_seq, snapshot_rowid, MAX_OPS_PER_FRAME as i64))
        .map_err(|e| e.to_string())?;
    let mut ops: Vec<RemoteOp> = vec![];
    let mut bytes = 0usize;
    let mut next_seq = from_seq;
    let mut exhausted = true;
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        let op = RemoteOp {
            op_id: r.get(0).map_err(|e| e.to_string())?,
            hlc: r.get(1).map_err(|e| e.to_string())?,
            entity: r.get(2).map_err(|e| e.to_string())?,
            entity_id: r.get(3).map_err(|e| e.to_string())?,
            kind: r.get(4).map_err(|e| e.to_string())?,
            payload: serde_json::from_str(&r.get::<_, String>(5).map_err(|e| e.to_string())?)
                .expect("oplog payload 必须是合法 JSON(0020 CHECK)"),
            origin_seq: r.get(6).map_err(|e| e.to_string())?,
        };
        let sz = encoded_op_len(&op);
        // 条数那道尺由 SQL 的 `LIMIT` 管(取满即无下一行),故这里只判字节:撞上就把
        // 这一条留给下一帧(它的 seq 就是 `next_seq`,不会丢)。
        if !ops.is_empty() && bytes + sz > MAX_OPS_FRAME_BYTES {
            exhausted = false;
            break;
        }
        bytes += sz;
        // 现实里到不了(本机日志按连续回放建号),但它是**总函数**而不是会绕的加法:
        // 溢出就响亮终局,不静默从表头重来(二轮 L1)。
        next_seq = op
            .origin_seq
            .checked_add(1)
            .ok_or_else(|| format!("内部错:{origin} 的 origin_seq 到了 i64::MAX,无法续号"))?;
        ops.push(op);
    }
    // 取满一整帧(条数)时游标虽已到头也不敢说「供完了」:LIMIT 恰好切在这里,
    // 后面还有没有得下一帧才知道。多一次空探(索引单点)换判据不会说错。
    if ops.len() >= MAX_OPS_PER_FRAME {
        exhausted = false;
    }
    let frame = (!ops.is_empty()).then(|| OpsFrame { origin: origin.to_string(), ops, bytes });
    Ok(Run { frame, next_seq, exhausted })
}

/// **开计划那一刻的插入快照边界**(生产侧唯一取数点;第⑤笔)。
///
/// 空库回 0:此后 `rowid <= 0` 选不中任何行,计划当场走完——比 fail-fast 更贴事实
/// (「库里还没有 op」不是故障)。
pub(crate) fn snapshot_rowid(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COALESCE(MAX(rowid), 0) FROM oplog", [], |r| r.get(0))
        .map_err(|e| format!("取 oplog 快照边界失败:{e}"))
}

/// 快照内 `after` 之后字典序最小的 origin(`None` = 从头找)。
fn seek_origin_after(
    conn: &Connection,
    after: Option<&str>,
    snapshot_rowid: i64,
) -> Result<Option<String>, String> {
    // origin 恒非空(`substr(hlc, 24)` 是 26 字符 device id),故 "" 是安全的下界。
    conn.query_row(SQL_SEEK_ORIGIN, (after.unwrap_or(""), snapshot_rowid), |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

// ---- 有界 Hello 水位图(第①笔后半)---------------------------------------------------

/// CBOR map 头的字节数,按最大情形(≤65535 条 → 3 字节)记。
///
/// 刻意记大不记小:出入站两侧共用 [`watermark_map_bytes`] 这**同一把尺**,尺子略微
/// 高估只会让出站 Hello 少带一两条,而低估会让「一枚正常的满额 Hello 到收端就被折叠成
/// 全量重扫」(七轮 M2 点名要避免的那件事)。
const WATERMARK_MAP_HEADER_BYTES: usize = 3;

/// 出站 Hello 的水位子集游标。**每逻辑目的地一枚**(BROADCAST 一枚 + 每定向 peer
/// 各一枚,六轮 M5);第⑤笔已接线,见 [`bounded_watermarks`] 与 [`OpsWorks::hello_cursor`]。
///
/// 它是**公平/减重,不是最终静默的证明**:某次没带上的 origin,对端下一次仍按 0 处理
/// ——轮转只让各 origin 轮流报出真实水位,**不能让对端永久记住旧 Hello**。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct HelloCursor {
    /// 上一枚 Hello 带出的最后一个 origin。**`None` = 从头**,也是「一次装得下」时的
    /// 恒定状态(轮转不启用,行为与现状全表水位逐字一致)。
    after: Option<String>,
}

/// 预算内的水位子集 + 轮转(§6.1 H4)。
///
/// 现状 `watermarks()` 是 `GROUP BY origin` 全表扫(设计期实测 500 万行 2000 origin 下
/// **157.8 ms,而且是持着库锁在协调者里跑的**),且完整 collect 进 Hello——既是内存无界面,
/// 也是延迟面。这里改成 keyset 枚举 + 单 origin min/max 单点查,取到预算为止。
///
/// **缺席按 0 是安全侧**:没带上的 origin 对端只会**多给**,不会误以为我齐了。
///
/// 起点跨相邻 Hello 轮转:不轮转的话预算外那些 origin 的真实水位**永远报不出去**,
/// 对端每次都把同一批重发一遍。绕满一圈即停,**同一枚 Hello 内绝不重复计一个 origin**。
///
/// 预算为 0/极小时仍保证**至少一条**(等同 `ops_frames` 让单条超大 op 独占一帧的写法):
/// 一条都装不下就等于游标永不前进 —— 那是死循环,不是节流。
pub(crate) fn bounded_watermarks(
    conn: &Connection,
    cursor: &mut HelloCursor,
    budget: usize,
) -> Result<BTreeMap<String, i64>, String> {
    let start = cursor.after.clone();
    let mut at = start.clone();
    let mut map: BTreeMap<String, i64> = BTreeMap::new();
    let mut used = WATERMARK_MAP_HEADER_BYTES;
    let mut wrapped = false;
    let mut budget_hit = false;
    loop {
        let Some(origin) = seek_origin_after(conn, at.as_deref(), i64::MAX)? else {
            if wrapped || start.is_none() {
                break; // 从头找起的那一趟走到底 = 全表都看过了。
            }
            wrapped = true; // 上一枚 Hello 停在中途:绕回表头接着取。
            at = None;
            continue;
        };
        // 绕回来又越过了起点 = 这一枚 Hello 已经走满一圈。
        if wrapped && start.as_deref().is_some_and(|s| origin.as_str() > s) {
            break;
        }
        let seq = watermark_of(conn, &origin)?;
        let cost = encoded_entry_len(&origin, seq);
        if !map.is_empty() && used + cost > budget {
            budget_hit = true;
            break;
        }
        used += cost;
        map.insert(origin.clone(), seq);
        at = Some(origin);
    }
    // 一次装得下 → 游标复位,下一枚 Hello 与这一枚逐字相同(轮转不启用)。
    cursor.after = if budget_hit { at } else { None };
    Ok(map)
}

/// 单 origin 水位。**空结果是内部错**:调用方刚从表里枚举出这个 origin,而 oplog
/// append-only(0024 `trg_oplog_no_delete`),行不可能中途消失。
fn watermark_of(conn: &Connection, origin: &str) -> Result<i64, String> {
    let v: Option<i64> =
        conn.query_row(SQL_WATERMARK_OF, [origin], |r| r.get(0)).map_err(|e| e.to_string())?;
    v.ok_or_else(|| format!("内部错:刚枚举出的 origin {origin} 没有水位"))
}

/// 水位图的编码字节数。**出站预算与入站预算共用这一把尺**(七轮 M2:两边各算各的话,
/// 新版客户端发出的一枚正常满额 Hello 一到收端就会被折叠成全量重扫)。
///
/// 略高于真实 CBOR 长度(map 头按最大情形记),`watermark_map_bytes_never_underreports`
/// 焊着这个方向。
pub(crate) fn watermark_map_bytes(map: &BTreeMap<String, i64>) -> usize {
    WATERMARK_MAP_HEADER_BYTES
        + map.iter().map(|(k, v)| encoded_entry_len(k, *v)).sum::<usize>()
}

/// 单条 `origin: seq` 在 CBOR map 里占的字节。二元组编码减掉数组头那一字节 —— map 的
/// kv 与数组元素是同一套并列编码,只有容器头不同。
fn encoded_entry_len(origin: &str, seq: i64) -> usize {
    let mut buf = Vec::new();
    ciborium::into_writer(&(origin, seq), &mut buf).expect("CBOR 编码进内存 Vec 无失败路径");
    buf.len() - 1
}

/// 过完形态闸的对端水位图 + 它按共用尺算出的编码字节数。
///
/// **字段私有、生产侧唯一造法是 [`vet_watermarks`]**(254 那条教训:凭据只绑一半等于
/// 没封)——[`OpsWorks::on_hello`] 只收这个类型,故第⑤笔接线时「忘了过闸」或「自己
/// 另算一个 bytes」在类型层就不成立。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VettedWatermarks {
    peer: BTreeMap<String, i64>,
    bytes: usize,
}

impl VettedWatermarks {
    #[cfg(test)]
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }

    /// 测试专用:直接钉一个字节数,好把「预算算术」与「形态闸」两条规则分开验
    /// (真按 64 KiB 造图要上千条,测的就不是那条规则了)。
    #[cfg(test)]
    fn forged(peer: BTreeMap<String, i64>, bytes: usize) -> VettedWatermarks {
        VettedWatermarks { peer, bytes }
    }
}

/// 入站 Hello 水位图的形态闸(§10;第⑤笔已接线)。
///
/// **key 必须是规范 26 字符 device id、值不得为负**,任一不合 = 整枚 Hello 响亮拒收
/// (同 `validate_frame` 的处置:帧里有一处不合就整帧不收,不做静默清洗)。今天
/// `Msg::Hello` 是**一个字节都不校验**就直接交给 `on_hello` 的。
///
/// 为什么单靠字节预算不够:预算按**编码字节**计,而一条 1 字节 key 的水位在堆上照样是
/// 一个 BTree 节点 + 一个 String —— 大量极短 key 的堆开销远超编码预算。收紧到规范形
/// 之后,64 KiB 至多约 1800 条,堆开销跟着有界。
///
/// **诚实边界**:这道闸管的是「收下之后留住多少」。解码那一刻的瞬时峰值由 wire 帧上限
/// (LAN 1 MiB / 服务器帧上限)封着,本函数管不着,也不假装管得着。
pub(crate) fn vet_watermarks(
    theirs: BTreeMap<String, i64>,
) -> Result<VettedWatermarks, String> {
    for (origin, seq) in &theirs {
        if !crate::clock::is_canonical_device_id(origin) {
            return Err(format!("Hello 水位图里的 origin 不是规范设备 id:{origin}"));
        }
        if *seq < 0 {
            return Err(format!("Hello 水位图里 {origin} 的水位为负:{seq}"));
        }
    }
    let bytes = watermark_map_bytes(&theirs);
    Ok(VettedWatermarks { peer: theirs, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::Hlc;
    use crate::db;
    use std::sync::atomic::{AtomicU32, Ordering};
    use ulid::Ulid;

    const T: &str = "01TARGETAAAAAAAAAAAAAAAAAA";
    const SNAP: i64 = 1000;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn wm(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
    }

    /// 短标签 → 规范 26 字符 device id(右补 'A',字典序跟着标签走)。
    /// 生产里 origin 恒是这个形状,测试也照这个形状写,不然形态闸一接就全红。
    fn oid(tag: &str) -> String {
        assert!(tag.len() <= 26, "标签太长");
        format!("{tag:A<26}")
    }

    /// 过完形态闸的对端水位图(短标签自动补齐)。
    fn vw(pairs: &[(&str, i64)]) -> VettedWatermarks {
        let m: BTreeMap<String, i64> = pairs.iter().map(|(k, v)| (oid(k), *v)).collect();
        vet_watermarks(m).expect("测试水位图必须是规范形")
    }

    fn fresh_db() -> Connection {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-opsserve-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        db::open(&path).expect("open migrated db")
    }

    /// 第 i 台设备的规范 26 字符 id;字典序跟着 i 走。
    fn dev(i: usize) -> String {
        format!("D{i:025}")
    }

    /// 往 oplog 里塞一条 op。`pad` = 正文填充长度(撑字节尺用)。
    fn put(conn: &Connection, device: &str, seq: i64, pad: usize) {
        let hlc = Hlc { wall_ms: 1_000 + seq as u64, counter: 0, device_id: device.into() }.encode();
        let payload = serde_json::json!({
            "title": "T".repeat(pad.max(1)),
            "created_at": "2026-08-01T00:00:00Z",
        });
        conn.execute(
            "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
             VALUES (?1, ?2, 'topic', ?3, 'create', ?4, ?5)",
            (
                Ulid::new().to_string(),
                hlc,
                format!("01TOPIC{:019}", seq),
                serde_json::to_string(&payload).unwrap(),
                seq,
            ),
        )
        .expect("插 op");
    }

    fn plan_with(kind: PlanKind, cursor: ReconcileCursor, snap: i64) -> ReconcilePlan {
        ReconcilePlan { snapshot_rowid: snap, kind, cursor }
    }

    fn max_rowid(conn: &Connection) -> i64 {
        conn.query_row("SELECT COALESCE(MAX(rowid), 0) FROM oplog", [], |r| r.get(0)).unwrap()
    }

    /// 跑一趟消费方泵:逐帧取 → 记账 → 提交,直到没活干。返回供出去的 (origin, seq)。
    fn drain(conn: &Connection, work: &mut PeerWork) -> Vec<(String, i64)> {
        let mut got = vec![];
        let mut guard = 0;
        while let Some(p) = work.prepare_next(conn).expect("取帧").ready() {
            if let Some(f) = &p.frame {
                got.extend(f.ops.iter().map(|o| (f.origin.clone(), o.origin_seq)));
            }
            work.commit(p.token).expect("提交");
            guard += 1;
            assert!(guard < 10_000, "泵没收敛");
        }
        got
    }

    /// 取一帧并当场提交(不关心内容时用)。
    fn step(conn: &Connection, work: &mut PeerWork) -> Option<OpsFrame> {
        let p = work.prepare_next(conn).expect("取帧").ready()?;
        let frame = p.frame.clone();
        work.commit(p.token).expect("提交");
        frame
    }

    // ---- 节流、计划与公平调度 --------------------------------------------------------

    /// 首次两档都立即有资格(正常新设备入场不吃冷却);第二次分别受各自那一档约束。
    #[test]
    fn first_request_opens_immediately_second_waits_its_own_cooldown() {
        let mut w = OpsWorks::default();
        assert_eq!(w.on_hello(T, vw(&[("A", 3)]), SNAP, 0).admit, Admit::Ok);
        assert!(w.work_mut(T).unwrap().active.is_some(), "首次对账立即开");
        assert_eq!(w.throttle(T).unwrap().next_reconcile_tick, RECONCILE_COOLDOWN_TICKS);

        let before = w.work_mut(T).unwrap().active.clone();
        let _ = w.on_hello(T, vw(&[("A", 1)]), SNAP + 500, 1);
        assert_eq!(w.work_mut(T).unwrap().active, before, "冷却内不许改写活动计划");
        assert!(w.work_mut(T).unwrap().pending.is_some());

        let mut w2 = OpsWorks::default();
        let _ = w2.on_want(T, &oid("A"), 5, 0);
        assert_eq!(w2.work_mut(T).unwrap().urgent.len(), 1);
        assert_eq!(w2.throttle(T).unwrap().next_range_tick, RANGE_COOLDOWN_TICKS);
        assert_eq!(w2.throttle(T).unwrap().next_reconcile_tick, 0, "补洞不该动对账那一档");
    }

    /// **冷却只挡「开始服务」,不挡「登记义务」**(实现审 H1)。
    ///
    /// 原来这只测只断言「冷却内队列仍为 1」——那正是把缺陷写成了绿:第二枚 Want 被
    /// 直接丢弃,而**对端不周期重发 Want**,那个缺口就永久没人补了。
    #[test]
    fn a_gap_registered_during_cooldown_is_kept_and_promoted_by_the_heartbeat() {
        let mut w = OpsWorks::default();
        assert_eq!(w.on_want(T, &oid("A"), 5, 0).admit, Admit::Ok);
        assert_eq!(w.on_want(T, &oid("B"), 7, 0).admit, Admit::Ok, "冷却内照收");
        {
            let work = w.work_mut(T).unwrap();
            assert_eq!(work.urgent.len(), 1, "冷却内不进快车道");
            assert_eq!(work.deferred.len(), 1, "但义务必须留着 —— 丢了就没有任何续做所有者");
        }

        // 同 origin 再来一枚更早的:合并进已登记那条,取保守下界。
        assert_eq!(w.on_want(T, &oid("B"), 2, 0).admit, Admit::Ok);
        assert_eq!(w.work_mut(T).unwrap().deferred[0].next_seq, 2);
        assert_eq!(w.work_mut(T).unwrap().gaps_len(), 2, "不许因此多出一条段");

        let _ = w.on_tick(RANGE_COOLDOWN_TICKS, SNAP);
        let work = w.work_mut(T).unwrap();
        assert!(work.deferred.is_empty());
        assert_eq!(
            work.urgent.iter().map(|r| (r.origin.clone(), r.next_seq)).collect::<Vec<_>>(),
            vec![(oid("A"), 5), (oid("B"), 2)],
            "心跳到点把登记的义务原样放行"
        );
    }

    /// **本机的推送豁免 Range 冷却**(⑤ 的拍板项;上一只测的对照面)。
    ///
    /// Range 冷却是为**对端驱动的 Want 洪水**设的闸;而 `BROADCAST` 那条是本机
    /// `outbound` 自己走的路 —— 用户连着记两条,第二条要是落进 `deferred`,就得干等下一拍
    /// 心跳(最长 30s)才出门。同一个人自己写自己的东西,没有需要被自己节流的道理。
    ///
    /// **两格必须一起断**:只断「BROADCAST 不吃冷却」的话,把闸整个删掉也照样绿 ——
    /// 定向那格恒吃冷却,才说明豁免是**只给 BROADCAST 开的口子**,不是闸没了。
    /// 并且豁免**不许顺手消费 `next_range_tick`**:消费了的话,紧跟着来的定向 Want 会被
    /// 本机自己的写平白推迟一拍。
    #[test]
    fn only_the_local_broadcast_push_is_exempt_from_the_range_cooldown() {
        let mut w = OpsWorks::default();
        // ① BROADCAST:同一刻连来两枚,两枚都进快车道。
        assert_eq!(w.on_want(BROADCAST, &oid("A"), 1, 0).admit, Admit::Ok);
        assert_eq!(w.on_want(BROADCAST, &oid("B"), 1, 0).admit, Admit::Ok);
        assert_eq!(w.work_mut(BROADCAST).unwrap().deferred.len(), 0, "本机的写不吃冷却");
        assert_eq!(w.work_mut(BROADCAST).unwrap().urgent.len(), 2);
        assert_eq!(
            w.throttle(BROADCAST).unwrap().next_range_tick,
            0,
            "豁免不许顺手消费冷却水位 —— 消费了就轮到别人替本机的写背这一拍"
        );

        // ② 定向 target:同一刻的第二枚照吃冷却(闸还在,只是给 BROADCAST 开了口子)。
        assert_eq!(w.on_want(T, &oid("A"), 1, 0).admit, Admit::Ok);
        assert_eq!(w.on_want(T, &oid("B"), 1, 0).admit, Admit::Ok);
        assert_eq!(w.work_mut(T).unwrap().deferred.len(), 1, "对端驱动的那条恒吃冷却");
    }

    /// **Hello 不许覆盖仍活动或在飞的计划**(实现审 H2)。
    #[test]
    fn a_hello_never_clobbers_a_running_or_in_flight_plan() {
        let conn = fresh_db();
        for i in 1..=3usize {
            put(&conn, &dev(i), 1, 1);
        }
        let snap = max_rowid(&conn);
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[]), snap, 0);
        step(&conn, w.work_mut(T).unwrap()).expect("先供一帧,游标离开起点");
        let cursor_before = w.work_mut(T).unwrap().active.as_ref().unwrap().cursor.clone();
        assert_ne!(cursor_before, ReconcileCursor::Start);

        // 冷却早过了(tick 9 ≫ 2),但计划还在跑 —— 这一枚只能进 pending。
        let _ = w.on_hello(T, vw(&[("A", 1)]), snap + 999, 9);
        let work = w.work_mut(T).unwrap();
        assert_eq!(work.active.as_ref().unwrap().cursor, cursor_before, "游标不许被重置回起点");
        assert_eq!(work.active.as_ref().unwrap().snapshot_rowid, snap, "快照不许被换掉");
        assert!(work.pending.is_some());

        // 在飞期间同理:计划刚跑完(active 已释放)也不算空闲,只要还有在飞那一笔。
        let mut w2 = OpsWorks::default();
        let _ = w2.on_hello(T, vw(&[]), snap, 0);
        let p = w2.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("有活");
        let _ = w2.on_hello(T, vw(&[("A", 1)]), snap + 999, 9);
        assert!(w2.work_mut(T).unwrap().pending.is_some(), "在飞时新 Hello 只能进 pending");
        w2.work_mut(T).unwrap().commit(p.token).expect("旧凭据提交到的还是旧计划");
    }

    /// 已定下的全量重扫不许被一枚新的细粒度 Hello 悄悄展开(折叠态第⑤条)。
    #[test]
    fn a_pending_full_rescan_is_never_re_expanded_by_a_later_hello() {
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[("A", 9)]), SNAP, 0); // 开计划,冷却到 2
        w.work_mut(T).unwrap().pending = Some(PendingReconcile { kind: PlanKind::Full });
        let _ = w.on_hello(T, vw(&[("A", 9), ("B", 9)]), SNAP, 1);
        assert_eq!(
            w.work_mut(T).unwrap().pending.as_ref().unwrap().kind,
            PlanKind::Full,
            "Full 占优 —— 合并一律取保守下界"
        );

        // 冷却到点开出来的也必须还是 Full。
        w.work_mut(T).unwrap().active = None;
        let _ = w.on_tick(RECONCILE_COOLDOWN_TICKS, SNAP);
        assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().kind, PlanKind::Full);
    }

    /// 新 pending 不得改写活动计划的快照 / 游标(六轮 M1)。
    #[test]
    fn pending_never_rewrites_active_snapshot_or_cursor() {
        let conn = fresh_db();
        put(&conn, &oid("A"), 1, 1);
        let snap = max_rowid(&conn);
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[]), snap, 0);
        step(&conn, w.work_mut(T).unwrap());
        let before = w.work_mut(T).unwrap().active.clone();

        let _ = w.on_hello(T, vw(&[("A", 0)]), snap + 9999, 1);
        assert_eq!(w.work_mut(T).unwrap().active, before, "快照与游标都钉死,新 Hello 碰不到");
    }

    /// bypass 只被下一枚有效 Hello 消费一次;折叠既不制造也不消费它;
    /// **且它最迟随对账冷却一起失效**(实现审 H5:否则没人发 Hello 时留一块永久墓碑)。
    #[test]
    fn bypass_is_consumed_once_and_expires_with_the_reconcile_cooldown() {
        let conn = fresh_db();
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[]), SNAP, 0); // 空库:一帧都取不出,计划当场走完
        drain(&conn, w.work_mut(T).unwrap());
        assert!(w.work_mut(T).unwrap().active.is_none(), "走完的计划自己释放");
        assert!(!w.throttle(T).unwrap().bypass_once);

        let _ = w.on_peer_online(T, 1);
        assert!(w.throttle(T).unwrap().bypass_once, "冷却没到,券有用");

        let tick = 1;
        assert!(tick < w.throttle(T).unwrap().next_reconcile_tick);
        let _ = w.on_hello(T, vw(&[("A", 1)]), SNAP, tick);
        assert!(!w.throttle(T).unwrap().bypass_once, "有效 Hello 消费掉它");
        assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().cursor, ReconcileCursor::Start);

        // 已经有资格开计划时不发券:那张券加速不了任何事,却会把条目钉成永久墓碑。
        let mut w2 = OpsWorks::default();
        let _ = w2.on_peer_online(T, 0);
        assert!(!w2.throttle(T).unwrap().bypass_once, "首次本就立即有资格,不该发券");

        // 发出去而没人消费的券,到对账冷却那一刻自己作废。
        let mut w3 = OpsWorks::default();
        let _ = w3.on_hello(T, vw(&[]), SNAP, 0);
        drain(&conn, w3.work_mut(T).unwrap());
        let _ = w3.on_peer_online(T, 1);
        assert!(w3.throttle(T).unwrap().bypass_once);
        let _ = w3.on_tick(RECONCILE_COOLDOWN_TICKS, SNAP);
        assert_eq!(w3.len(), 0, "券到期 + 工作全空 → 墓碑整条回收,不占 64 格里的一格");
    }

    /// Range 洪水触发的折叠**既不消费也不制造** bypass(七轮 H3 ④)。
    #[test]
    fn range_flood_collapse_neither_consumes_nor_mints_bypass() {
        let conn = fresh_db(); // 空库:计划开出来空跑一趟就自己释放
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[]), SNAP, 0); // 先占掉对账那一档,好让 peer_online 发得出券
        drain(&conn, w.work_mut(T).unwrap());
        let _ = w.on_want(T, &oid("N00"), 1, 0);
        assert!(!w.throttle(T).unwrap().bypass_once, "补洞不许凭空造出加速券");
        let _ = w.on_peer_online(T, 1);
        assert!(w.throttle(T).unwrap().bypass_once);

        let mut sawcollapse = false;
        for i in 1..=OPS_RANGES_PER_TARGET as i64 {
            let r = w.on_want(T, &oid(&format!("N{i:02}")), 1, i as u64 * RANGE_COOLDOWN_TICKS);
            sawcollapse |= r.admit == Admit::Collapsed;
        }
        assert!(sawcollapse, "第 17 个 origin 必须折叠成全量重扫");
        assert!(w.throttle(T).unwrap().bypass_once, "折叠不许消费 bypass");
        assert_eq!(
            w.work_mut(T).unwrap().pending.as_ref().unwrap().kind,
            PlanKind::Full,
            "折叠态排进 pending,恒受对账那一档冷却"
        );
        assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0, "细粒度账已丢,两队都清空");
    }

    /// 合并取保守下界。改成取 max 必须红。
    #[test]
    fn pending_merge_takes_the_conservative_lower_bound() {
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[("A", 9)]), SNAP, 0);
        let _ = w.on_hello(T, vw(&[("A", 9), ("B", 5)]), SNAP, 1);
        let _ = w.on_hello(T, vw(&[("A", 2), ("B", 8)]), SNAP, 1);
        let PlanKind::Detailed { peer, bytes } =
            &w.work_mut(T).unwrap().pending.as_ref().unwrap().kind
        else {
            panic!("该是细粒度")
        };
        assert_eq!(peer.get(&oid("A")), Some(&2), "同 origin 取较小者");
        assert_eq!(peer.get(&oid("B")), Some(&5), "同 origin 取较小者");
        // 字节数是**合出来那张图的真实大小**,不是两边取大:`merge_low` 只留两边都提到
        // 的 key,合出来比哪边都小,记大了就是给预算凭空加水、让正常对端提前挨降级。
        assert_eq!(*bytes, watermark_map_bytes(peer), "合并后的账必须重算");

        let merged = merge_low(wm(&[("A", 4), ("C", 7)]), wm(&[("A", 6)]));
        assert_eq!(merged.get("A"), Some(&4));
        assert!(!merged.contains_key("C"), "缺席按 0,不许把 7 留下来");
    }

    /// 两层公平:补洞与对账**逐帧**严格交替;补洞队列内部未跑完的推队尾。
    #[test]
    fn two_layer_fairness_alternates_per_frame_and_rotates_within_urgent() {
        let conn = fresh_db();
        // 补洞三条段(第一条大到要两帧,靠条数尺);对账三台,字典序全排在补洞那三条**之后**。
        let gaps = [oid("W1"), oid("W2"), oid("W3")];
        for (n, g) in gaps.iter().enumerate() {
            for seq in 1..=(if n == 0 { MAX_OPS_PER_FRAME as i64 + 1 } else { 1 }) {
                put(&conn, g, seq, 1);
            }
        }
        let plan_origins = [oid("X1"), oid("X2"), oid("X3")];
        for p in &plan_origins {
            put(&conn, p, 1, 1);
        }
        let snap = max_rowid(&conn);
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[]), snap, 0);
        // 把游标推到补洞那三条之后:此后的 want 才是「计划已扫过」,该走快车道。
        // (游标停在起点时 want 折进计划、不新开段——那是 want_before_the_cursor 那只测。)
        w.work_mut(T).unwrap().active.as_mut().unwrap().cursor =
            ReconcileCursor::AfterOrigin { origin: oid("W9") };
        for (n, g) in gaps.iter().enumerate() {
            let _ = w.on_want(T, g, 1, n as u64 * RANGE_COOLDOWN_TICKS);
        }
        let work = w.work_mut(T).unwrap();
        assert_eq!(work.urgent.len(), 3, "三条段都该在快车道上");

        let mut kinds = vec![];
        for _ in 0..6 {
            let f = step(&conn, work).expect("这六帧都该有内容");
            kinds.push(f.origin);
        }
        let urgent_frames: Vec<&String> = kinds.iter().filter(|o| gaps.contains(o)).collect();
        assert_eq!(urgent_frames.len(), 3, "六帧里对账拿到一半 —— 逐帧交替");
        assert_eq!(
            urgent_frames,
            vec![&gaps[0], &gaps[1], &gaps[2]],
            "超长段发一帧就让位,不许整段跑完才轮到别人"
        );
    }

    // ---- 取帧 / 提交的凭据契约 -------------------------------------------------------

    /// `prepare` 不推进;只有 `commit` 推进;回滚后重取拿到同一段;过期凭据提交不了。
    #[test]
    fn only_commit_advances_and_a_stale_token_cannot() {
        let conn = fresh_db();
        let d = oid("A");
        for seq in 1..=(MAX_OPS_PER_FRAME as i64 + 10) {
            put(&conn, &d, seq, 1);
        }
        let mut w = OpsWorks::default();
        let _ = w.on_want(T, &d, 1, 0);
        let work = w.work_mut(T).unwrap();

        let p1 = work.prepare_next(&conn).unwrap().ready().expect("有活");
        assert_eq!(work.urgent.front().unwrap().next_seq, 1, "取帧一步也不推进");
        let first_seq = p1.frame.as_ref().unwrap().ops.first().unwrap().origin_seq;
        // 回滚也得拿凭据:换成 p1 之外的任何一枚都不该生效。
        work.rollback(p1.token).expect("这枚凭据配得上在飞那一笔");
        assert_eq!(work.urgent.front().unwrap().next_seq, 1, "回滚不推进");

        let p2 = work.prepare_next(&conn).unwrap().ready().expect("重取");
        let p3_seq = p2.frame.as_ref().unwrap().ops.first().unwrap().origin_seq;
        assert_eq!(p3_seq, first_seq, "游标没动,重取拿到同一段");
        assert_eq!(work.urgent.front().unwrap().next_seq, 1, "失败的提交一步也没推进");
        work.commit(p2.token).expect("这枚才算数");
        assert_eq!(work.urgent.front().unwrap().next_seq, MAX_OPS_PER_FRAME as i64 + 1);
    }

    /// **凭据必须绑 work 身份**(实现审 H6):只绑 `seq` 等于没绑 —— 每份 work 的号都从
    /// 0 起,A 的第一枚凭据正好能提交 B 的第一笔。
    #[test]
    fn a_token_from_another_work_cannot_commit() {
        let conn = fresh_db();
        let d = oid("A");
        for seq in 1..=4i64 {
            put(&conn, &d, seq, 1);
        }
        let other = dev(7);
        let mut w = OpsWorks::default();
        let _ = w.on_want(T, &d, 1, 0);
        let _ = w.on_want(&other, &d, 3, 0);

        let pa = w.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("A 有活");
        let pb = w.work_mut(&other).unwrap().prepare_next(&conn).unwrap().ready().expect("B 有活");
        let err = w.work_mut(&other).unwrap().commit(pa.token).unwrap_err();
        assert!(err.contains("凭据对不上"), "张冠李戴必须响亮:{err}");
        assert_eq!(w.work_mut(&other).unwrap().urgent.front().unwrap().next_seq, 3, "B 一步没动");
        w.work_mut(&other).unwrap().commit(pb.token).expect("B 自己的凭据照常");
    }

    /// 窗口 1 是**结构事实**:在飞时再取一枚拿不到东西,不靠调用方自律。
    ///
    /// **且它必须与「没活」分得开**(L-d″ 第④笔下半,第②笔留的义务①):两条腿同时盯一个
    /// 对端时后到的那条撞的是**正常争用**,而 `Idle` 是「这份 work 空了」——把两者混成同一
    /// 个答案,消费方要么为争用拆掉健康的链,要么把「有活但被占」当成没活睡死。
    #[test]
    fn preparing_while_one_is_in_flight_is_occupied_not_idle_and_not_an_error() {
        let conn = fresh_db();
        put(&conn, &oid("A"), 1, 1);
        let mut w = OpsWorks::default();
        let _ = w.on_want(T, &oid("A"), 1, 0);
        let work = w.work_mut(T).unwrap();
        let p = work.prepare_next(&conn).unwrap().ready().expect("有活");
        assert!(
            matches!(work.prepare_next(&conn), Ok(Prepare::Occupied)),
            "在飞时再取 = 正常争用,既不是错误也不是没活"
        );
        work.commit(p.token).expect("提交");
        assert!(
            matches!(work.prepare_next(&conn), Ok(Prepare::Idle)),
            "提交完就没活了 —— 与 Occupied 是两个答案"
        );
    }

    /// 轮转候选:**从游标之后绕一圈**,且**预筛掉在飞的那些**(§6.2 ⑨-4)。
    #[test]
    fn the_next_runnable_target_rotates_past_the_cursor_and_skips_in_flight_ones() {
        let conn = fresh_db();
        let d = oid("A");
        put(&conn, &d, 1, 1);
        let (a, b, c) = (dev(1), dev(2), dev(3));
        let mut w = OpsWorks::default();
        for t in [&a, &b, &c] {
            let _ = w.on_want(t, &d, 1, 0);
        }
        assert_eq!(w.next_runnable_after(None).as_ref(), Some(&a), "无游标 = 从头");
        assert_eq!(w.next_runnable_after(Some(&a)).as_ref(), Some(&b), "游标之后的下一个");
        assert_eq!(w.next_runnable_after(Some(&c)).as_ref(), Some(&a), "尾后回头(绕圈)");
        // B 被另一条腿武装了:跳过它(名单过期那条竞态由 `Occupied` 收口)。
        let held = w.work_mut(&b).unwrap().prepare_next(&conn).unwrap().ready().expect("B 有活");
        assert_eq!(w.next_runnable_after(Some(&a)).as_ref(), Some(&c), "在飞的不进候选");
        w.work_mut(&b).unwrap().rollback(held.token).expect("交回");
        assert_eq!(w.next_runnable_after(Some(&a)).as_ref(), Some(&b), "交回就又是候选");
        // 一个可跑的都没有 = `None`(消费方据此把机会让给另一类)。
        let mut empty = OpsWorks::default();
        assert_eq!(empty.next_runnable_after(None), None);
        let _ = empty.on_peer_online(&a, 0);
        assert_eq!(empty.next_runnable_after(None), None, "只发了券、没有活,不算候选");
    }

    /// `unknown_device` 跨代探针的三步(§6.1 八轮 H1):首次留活 → 同代不升级 →
    /// **更晚一代再撞才取消**;而同 target 的正面证据一到就清标。
    #[test]
    fn unknown_device_probe_keeps_work_once_then_cancels_in_a_later_generation() {
        let conn = fresh_db();
        let d = oid("A");
        put(&conn, &d, 1, 1);
        let t = dev(1);
        let mut w = OpsWorks::default();
        let _ = w.on_want(&t, &d, 1, 0);
        assert_eq!(w.note_unknown(&t, 7), UnknownVerdict::Probed, "首次只记怀疑");
        assert_eq!(w.unknown_since(&t), Some(7));
        assert!(w.work_mut(&t).unwrap().has_runnable(), "工作照留 —— 顶替者重连后还要续做");
        assert_eq!(w.note_unknown(&t, 7), UnknownVerdict::Probed, "同一代的尾帧不算第二击");
        assert!(w.work_mut(&t).unwrap().has_runnable());
        assert_eq!(w.note_unknown(&t, 8), UnknownVerdict::Cancelled, "换了一代仍 unknown");
        assert!(!w.work_mut(&t).unwrap().has_runnable(), "取消 = 整份 work 换新号");
        // 正面证据清标:此后再撞 unknown 又从「首次」起算。**刻度要过了补洞冷却**
        // ——`PeerThrottle` 不随 work 取消而复位(六轮 H1 那条:节流与计划分家),
        // 同一刻再登记只会进 `deferred`,`has_runnable` 照样是假。
        let _ = w.on_want(&t, &d, 1, 100);
        w.clear_unknown(&t);
        assert_eq!(w.unknown_since(&t), None);
        assert_eq!(w.note_unknown(&t, 9), UnknownVerdict::Probed, "清过标就重新起算");
        assert!(w.work_mut(&t).unwrap().has_runnable());
        assert_eq!(w.note_unknown("MISSINGDEV0000000000000000", 9), UnknownVerdict::NoWork);
    }

    /// **在飞期间来了更早起点的 Want:提交不许抬过下修值**(变异对照 ⑰ 挖出)。
    #[test]
    fn a_lower_want_arriving_mid_flight_is_not_swallowed_by_commit() {
        let conn = fresh_db();
        let d = oid("A");
        for seq in 1..=80i64 {
            put(&conn, &d, seq, 1);
        }
        let mut w = OpsWorks::default();
        let _ = w.on_want(T, &d, 50, 0);
        let p = w.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("有活");

        // 这一笔正在写出去的途中,对端又要更早的一段。
        let _ = w.on_want(T, &d, 3, 0);
        assert_eq!(w.work_mut(T).unwrap().urgent.front().unwrap().next_seq, 3, "队里的起点被下修");

        w.work_mut(T).unwrap().commit(p.token).expect("提交");
        assert_eq!(
            w.work_mut(T).unwrap().urgent.front().unwrap().next_seq,
            3,
            "提交不许把游标抬过下修值 —— 抬过去那段缺口就被吞掉了"
        );
    }

    /// **对账在飞期间的低位 Want 必须走快车道**(实现审 H3)。
    ///
    /// 只看已提交游标的话:`ReconcileSeek` 已武装未提交时,低位 Want 会去下修计划水位图,
    /// 而随后那一笔提交把游标推过该 origin —— 那段缺口被**静默吞掉**。
    #[test]
    fn a_low_want_during_an_in_flight_seek_goes_to_the_fast_lane() {
        let conn = fresh_db();
        let d = dev(1);
        for seq in 1..=150i64 {
            put(&conn, &d, seq, 1);
        }
        let snap = max_rowid(&conn);
        let mut w = OpsWorks::default();
        // 对端说它有 100 条 → 这一笔从 101 起。
        let _ = w.on_hello(T, vet_watermarks(wm(&[(&d, 100)])).unwrap(), snap, 0);
        let p = w.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("有活");
        assert_eq!(p.frame.as_ref().unwrap().ops.first().unwrap().origin_seq, 101);

        // 帧还没提交,对端说「其实我从 1 就缺」。
        assert_eq!(w.on_want(T, &d, 1, 0).admit, Admit::Ok);
        {
            let work = w.work_mut(T).unwrap();
            assert_eq!(work.urgent.len(), 1, "在飞前沿已经越过它 —— 必须进快车道");
            assert_eq!(work.urgent[0].next_seq, 1);
        }
        w.work_mut(T).unwrap().commit(p.token).expect("提交");

        let got = drain(&conn, w.work_mut(T).unwrap());
        for seq in 1..=100i64 {
            assert!(got.contains(&(d.clone(), seq)), "第 {seq} 条不许被吞掉");
        }
    }

    // ---- 容量、墓碑与预算 ------------------------------------------------------------

    /// 计划走完就**自己释放**,槽位才回收得掉(实现审 H5:原来要测试手工清 active)。
    #[test]
    fn a_finished_plan_releases_itself_so_the_slot_can_be_reclaimed() {
        let conn = fresh_db();
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[]), SNAP, 0);
        drain(&conn, w.work_mut(T).unwrap());
        assert!(w.work_mut(T).unwrap().active.is_none(), "空库:计划一趟走完并当场释放");

        let _ = w.on_tick(1, SNAP);
        assert_eq!(w.len(), 1, "冷却没到,墓碑必须留着");
        let _ = w.on_tick(RECONCILE_COOLDOWN_TICKS, SNAP);
        assert_eq!(w.len(), 0, "两档都到期且无 bypass → 整条回收");
    }

    /// 满额:先回收到期墓碑,再驱逐最旧的纯墓碑;全是真实工作则响亮 overload。
    #[test]
    fn full_table_evicts_tombstones_then_reports_overload() {
        let mut w = OpsWorks::default();
        for i in 0..OPS_TARGET_MAX {
            let _ = w.on_want(&dev(i), &oid("A"), 1, 0);
        }
        assert_eq!(w.len(), OPS_TARGET_MAX);
        let newcomer = dev(OPS_TARGET_MAX + 1);
        assert_eq!(
            w.on_want(&newcomer, &oid("A"), 1, 0).admit,
            Admit::Overload,
            "全是真实工作 → 响亮拒绝"
        );
        assert_eq!(w.len(), OPS_TARGET_MAX, "绝不建第 65 项、也不留旁表状态");
        assert!(w.throttle(&newcomer).is_none());

        let victim = dev(0);
        w.work_mut(&victim).unwrap().urgent.clear();
        assert_eq!(w.on_want(&newcomer, &oid("A"), 1, 0).admit, Admit::Ok);
        assert_eq!(w.len(), OPS_TARGET_MAX);
        assert!(w.throttle(&victim).is_none(), "最旧的纯墓碑被驱逐");
        assert!(w.throttle(&newcomer).is_some());
    }

    /// per-target 与聚合两道水位预算:超限折叠成常量大小,且**只折本次增长的那个**。
    #[test]
    fn watermark_budgets_collapse_the_growing_target_only() {
        // 用钉死字节数的伪造凭据:这只测的是**预算算术**,真去造 64 KiB 的图要上千条。
        let heavy = |bytes: usize| VettedWatermarks::forged(wm(&[(&oid("A"), 1)]), bytes);
        let mut w = OpsWorks::default();
        assert_eq!(
            w.on_hello(T, heavy(OPS_WATERMARK_BYTES_PER_TARGET + 1), SNAP, 0).admit,
            Admit::Collapsed
        );
        assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().kind, PlanKind::Full);

        // 聚合额度恰好 = 16 × per-target。前 16 台各占满额度仍全部 Ok,第 17 台顶破。
        let mut w2 = OpsWorks::default();
        let full = OPS_WATERMARK_BYTES_PER_TARGET;
        let seats = OPS_WATERMARK_BYTES_AGGREGATE / full;
        for i in 0..seats {
            assert_eq!(w2.on_hello(&dev(i), heavy(full), SNAP, 0).admit, Admit::Ok, "第 {i} 台还在额度内");
        }
        let last = dev(seats + 1);
        assert_eq!(
            w2.on_hello(&last, VettedWatermarks::forged(wm(&[(&oid("B"), 1)]), full), SNAP, 0).admit,
            Admit::Collapsed
        );
        assert!(
            matches!(
                w2.work_mut(&dev(0)).unwrap().active.as_ref().unwrap().kind,
                PlanKind::Detailed { .. }
            ),
            "先到的那些是无辜的,不许替本次增长者挨降级"
        );
        assert_eq!(w2.work_mut(&last).unwrap().active.as_ref().unwrap().kind, PlanKind::Full);
    }

    /// **预算算的是该 target 保留的全部**(active + pending;实现审 H4 第二层)。
    /// 原先只把「本次那份新 kind」当它的占用,而冷却内两份都留着。
    #[test]
    fn the_budget_counts_the_pending_plan_the_target_still_holds() {
        let full = OPS_WATERMARK_BYTES_PER_TARGET;
        let heavy = || VettedWatermarks::forged(wm(&[(&oid("A"), 1)]), full);
        let mut w = OpsWorks::default();
        assert_eq!(w.on_hello(T, heavy(), SNAP, 0).admit, Admit::Ok, "一份满额:恰好在额度内");
        assert_eq!(
            w.on_hello(T, heavy(), SNAP, 1).admit,
            Admit::Collapsed,
            "冷却内再来一份满额 = 该 target 留着两份,必须降级"
        );
        assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().kind, PlanKind::Full);
        assert_eq!(w.work_mut(T).unwrap().pending.as_ref().unwrap().kind, PlanKind::Full);
    }

    /// **Want 下修起点也得过预算**(实现审 H4 第一层):原先这条路既不更新 `bytes`
    /// 也不校验,单 target 能用无限多个伪造 origin 把活动计划的水位图撑到无界。
    #[test]
    fn wants_cannot_grow_the_active_watermark_map_past_the_budget() {
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[("A", 5)]), SNAP, 0);
        // 计划游标停在起点,故这些 origin 全落在「未扫部分」→ 走下修那条路。
        let mut collapsed = false;
        for i in 0..4000usize {
            if w.on_want(T, &dev(i), 3, 0).admit == Admit::Collapsed {
                collapsed = true;
                break;
            }
        }
        assert!(collapsed, "撑到预算就必须降级,而不是一直长");
        let work = w.work_mut(T).unwrap();
        assert_eq!(work.active.as_ref().unwrap().kind, PlanKind::Full, "降级成常量大小");
        assert!(work.watermark_bytes() <= OPS_WATERMARK_BYTES_PER_TARGET);
        assert_eq!(
            work.active.as_ref().unwrap().cursor,
            ReconcileCursor::Start,
            "降级保留游标与快照 —— 已扫过的部分不重来"
        );
    }

    /// Want 命中「计划还没扫到的 origin」时只下修起点,不新开段。
    #[test]
    fn want_before_the_cursor_only_lowers_the_plan_start() {
        let conn = fresh_db();
        for seq in 1..=2i64 {
            put(&conn, &oid("M"), seq, 1);
        }
        put(&conn, &oid("Z"), 1, 1);
        let snap = max_rowid(&conn);
        let mut w = OpsWorks::default();
        // M 缺席(按 0)故这一趟先供 M;Z 报 9 高于本机水位,轮到它时无可供。
        let _ = w.on_hello(T, vw(&[("Z", 9)]), snap, 0);
        step(&conn, w.work_mut(T).unwrap()).expect("先供 M");
        assert!(w.work_mut(T).unwrap().plan_frontier_passed(&oid("M")), "M 已被扫过");
        assert!(!w.work_mut(T).unwrap().plan_frontier_passed(&oid("Z")), "Z 还没轮到");

        assert_eq!(w.on_want(T, &oid("Z"), 3, 0).admit, Admit::Ok);
        assert!(w.work_mut(T).unwrap().urgent.is_empty(), "Z 还没扫到 —— 不该新开段");
        assert_eq!(w.work_mut(T).unwrap().active.as_ref().unwrap().start_seq(&oid("Z")), Some(3));

        assert_eq!(w.on_want(T, &oid("M"), 3, 0).admit, Admit::Ok);
        assert_eq!(w.work_mut(T).unwrap().urgent.len(), 1);
        assert_eq!(w.work_mut(T).unwrap().urgent[0].origin, oid("M"));
    }

    /// 折叠态与缺席都按 0 → 起点回 1;**合法的 `i64::MAX` 水位不许溢出**(实现审 M2)。
    #[test]
    fn absent_or_full_means_start_from_one_and_max_never_overflows() {
        let p = plan_with(
            PlanKind::Detailed { peer: wm(&[("A", 4), ("MAXED", i64::MAX)]), bytes: 8 },
            ReconcileCursor::Start,
            SNAP,
        );
        assert_eq!(p.start_seq("A"), Some(5));
        assert_eq!(p.start_seq("NOPE"), Some(1), "缺席按 0");
        assert_eq!(p.start_seq("MAXED"), None, "MAX = 这个 origin 没有可欠的后继,跳过");

        let f = plan_with(PlanKind::Full, ReconcileCursor::Start, SNAP);
        assert_eq!(f.start_seq("A"), Some(1), "折叠态全量重扫");
    }

    /// 出站 Hello 的轮转游标住在**同一张 64 表**里(实现审 M1:§10 禁旁表)。
    #[test]
    fn hello_cursors_live_in_the_same_bounded_table() {
        let mut w = OpsWorks::default();
        assert!(w.hello_cursor(BROADCAST, 0).is_some(), "BROADCAST 也占一格");
        assert_eq!(w.len(), 1);
        w.hello_cursor(&dev(1), 0).unwrap().after = Some(dev(9));
        assert_eq!(w.len(), 2, "每个逻辑目的地一枚,且都由这张表持有");
        assert_eq!(w.hello_cursor(&dev(1), 0).unwrap().after.as_deref(), Some(dev(9).as_str()));

        let mut full = OpsWorks::default();
        for i in 0..OPS_TARGET_MAX {
            let _ = full.on_want(&dev(i), &oid("A"), 1, 0);
        }
        assert!(full.hello_cursor(&dev(999), 0).is_none(), "满额时不许偷偷建第 65 格");
    }

    /// 逻辑目的地的合法域 = `BROADCAST` ∪ 规范设备 id(实现审 L2)。
    #[test]
    fn target_domain_is_broadcast_or_a_canonical_device_id() {
        let mut w = OpsWorks::default();
        assert_eq!(w.on_want("nope", &oid("A"), 1, 0).admit, Admit::Malformed);
        assert_eq!(w.on_hello("nope", vw(&[]), SNAP, 0).admit, Admit::Malformed);
        assert_eq!(w.on_peer_online("nope", 0).admit, Admit::Malformed);
        assert!(w.hello_cursor("nope", 0).is_none());
        assert_eq!(w.len(), 0, "不合形连条目都不建");

        assert_eq!(w.on_hello(BROADCAST, vw(&[]), SNAP, 0).admit, Admit::Ok, "本机 outbound 那份 work");
        assert_eq!(w.on_want(&dev(1), &oid("A"), 1, 0).admit, Admit::Ok);
    }

    /// `Want` 的 origin 与 `from_seq` 也得过形态闸:origin 在新形里是要**存进**补洞队列的
    /// (今天 `on_want` 查完水位就丢,故只校验 `from_seq`)。
    #[test]
    fn a_malformed_want_is_refused_without_leaving_a_trace() {
        let mut w = OpsWorks::default();
        assert_eq!(w.on_want(T, "A", 1, 0).admit, Admit::Malformed);
        assert_eq!(w.on_want(T, &"Z".repeat(4096), 1, 0).admit, Admit::Malformed, "长 origin 是留存面");
        assert_eq!(w.on_want(T, &oid("A"), 0, 0).admit, Admit::Malformed, "from_seq 必须 ≥1");
        assert_eq!(w.on_want(T, &oid("A"), i64::MIN, 0).admit, Admit::Malformed, "否则下修起点会溢出");
        assert_eq!(w.len(), 0, "不合形的请求不许把 target 条目也带出来");

        assert_eq!(w.on_want(T, &oid("A"), 1, 0).admit, Admit::Ok);
        assert_eq!(w.work_mut(T).unwrap().urgent.len(), 1);
    }

    /// **轮转游标必须跨心跳存活**(实现审二轮 H1)。
    ///
    /// Hello 之间**必经心跳**;心跳无条件抹掉游标的话,每一枚 Hello 都从表头开始,
    /// 预算外那半区**永远报不出去**。而 origin 数是历史 oplog 的 origin 总数,不受
    /// 「当前支持拓扑」限制 —— 这不是够不着的角落。
    #[test]
    fn a_rotation_cursor_survives_the_heartbeat_between_two_hellos() {
        let conn = fresh_db();
        let n = 6usize;
        for i in 1..=n {
            put(&conn, &dev(i), 1, 1);
        }
        // 预算只放得下 3 条:每枚 Hello 必留游标。
        let three: BTreeMap<String, i64> = (1..=3usize).map(|i| (dev(i), 1i64)).collect();
        let budget = watermark_map_bytes(&three);

        let mut w = OpsWorks::default();
        let first = {
            let cur = w.hello_cursor(BROADCAST, 0).expect("拿得到游标");
            bounded_watermarks(&conn, cur, budget).unwrap()
        };
        assert_eq!(first.len(), 3);

        // 两枚 Hello 之间跑一趟心跳 —— 冷却早过、也没有任何 ops 工作。
        let _ = w.on_tick(RECONCILE_COOLDOWN_TICKS * 10, SNAP);
        assert_eq!(w.len(), 1, "带着未走完游标的条目不许被日常心跳回收");

        let second = {
            let cur = w.hello_cursor(BROADCAST, RECONCILE_COOLDOWN_TICKS * 10).expect("游标还在");
            bounded_watermarks(&conn, cur, budget).unwrap()
        };
        assert!(
            second.keys().all(|k| !first.contains_key(k)),
            "第二枚必须接着上一枚往下报,而不是又从表头来一遍:{first:?} vs {second:?}"
        );

        // 游标走完一圈自己复位之后,墓碑照旧该回收 —— 不是把条目永久钉住。
        let all: BTreeMap<String, i64> = (1..=n).map(|i| (dev(i), 1i64)).collect();
        let big = watermark_map_bytes(&all);
        let cur = w.hello_cursor(BROADCAST, 0).unwrap();
        bounded_watermarks(&conn, cur, big).unwrap();
        assert!(cur.after.is_none(), "装得下 → 游标复位");
        let _ = w.on_tick(RECONCILE_COOLDOWN_TICKS * 20, SNAP);
        assert_eq!(w.len(), 0, "游标复位之后,纯墓碑照旧回收");
    }

    /// **进折叠态之后,新 Want 只能被全量重扫吸收**(实现审二轮 H2)。
    ///
    /// 少了这条,Range 洪水把 target 打进折叠态之后**还能接着吃 Range 那一档的快车道**,
    /// 「资源超限从 30s 档退化到 60s 档」这条有界降级就成了空话。
    #[test]
    fn once_collapsed_new_wants_are_absorbed_by_the_full_rescan() {
        let mut w = OpsWorks::default();
        for i in 0..=OPS_RANGES_PER_TARGET as i64 {
            let _ = w.on_want(T, &oid(&format!("N{i:02}")), 1, i as u64 * RANGE_COOLDOWN_TICKS);
        }
        assert_eq!(
            w.work_mut(T).unwrap().pending.as_ref().unwrap().kind,
            PlanKind::Full,
            "先得真进折叠态"
        );
        assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0);

        // 折叠之后再来的 Want:一条段都不许重开,计划水位图也不许被下修。
        let tick = OPS_RANGES_PER_TARGET as u64 * RANGE_COOLDOWN_TICKS + 99;
        assert_eq!(w.on_want(T, &oid("ZZ"), 1, tick).admit, Admit::Ok);
        assert_eq!(w.on_want(T, &oid("YY"), 1, tick + 1).admit, Admit::Ok);
        assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0, "折叠态里新 Want 只能维持标记");
        assert_eq!(w.work_mut(T).unwrap().pending.as_ref().unwrap().kind, PlanKind::Full);
    }

    /// **折叠那道闸必须在「下修活动计划」之前**(实现审三轮 L2)。
    ///
    /// 上一只测是在「没有 active、只有 pending Full」的状态下跑的 —— 把闸挪到下修之后
    /// 它照样绿。这一只专测另一半:活动计划还在跑、pending 已是 Full 时,一枚命中
    /// **未扫部分**的 Want(那条「便宜的下修」)也必须被挡住 —— 那份义务已由 Full
    /// 整个覆盖(`pending Full` 启动时会取当时的新快照、从头覆盖全部 origin),
    /// 继续下修只是把细粒度账又攒回来。
    #[test]
    fn the_collapse_gate_also_blocks_the_cheap_lowering_of_a_running_plan() {
        let conn = fresh_db();
        put(&conn, &oid("N5"), 1, 1);
        let snap = max_rowid(&conn);
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[]), snap, 0);
        step(&conn, w.work_mut(T).unwrap()).expect("先供一帧,游标停在 N5 之后");

        // 用「已扫过的那一侧」的 origin 灌满补洞段,把 target 打进折叠态;
        // 活动计划本身不受影响(collapse_gaps 不碰 active)。
        for i in 0..=OPS_RANGES_PER_TARGET as i64 {
            let _ = w.on_want(T, &oid(&format!("A{i:02}")), 1, i as u64 * RANGE_COOLDOWN_TICKS);
        }
        let work = w.work_mut(T).unwrap();
        assert_eq!(work.pending.as_ref().unwrap().kind, PlanKind::Full, "已进折叠态");
        let plan_before = work.active.clone().expect("活动计划还在跑");
        assert!(matches!(plan_before.kind, PlanKind::Detailed { .. }), "而且还是细粒度的");

        // 这枚 Want 命中**未扫部分**(Z9 排在游标之后),照旧走「下修起点」那条便宜路。
        let probe = oid("Z9");
        assert!(!w.work_mut(T).unwrap().plan_frontier_passed(&probe), "确实还没扫到它");
        assert_eq!(w.on_want(T, &probe, 3, 999).admit, Admit::Ok);
        assert_eq!(
            w.work_mut(T).unwrap().active.as_ref().unwrap(),
            &plan_before,
            "折叠态里连便宜的下修都得挡住 —— 水位图 / 字节数 / 游标 / 快照一格都不许动"
        );
        assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0, "更不许重开段");
    }

    /// 心跳把冷却里登记的补洞义务**真提成可跑工作**(第②笔实现审 H2)。
    ///
    /// 判据从「`on_tick` 交出的名单」改成 [`OpsWorks::idle_runnable_targets`](二轮 L1 撤掉
    /// 了那份没人消费的名单):**要守的规则一个字没变** —— 冷却到点是本模块自己把义务变成
    /// 可跑工作的那一刻,而协调者每一拍正是拿这一格去扫「谁该被叫醒」。少了那一步,登记的
    /// 段就一直没人来取。
    #[test]
    fn the_heartbeat_promotes_a_deferred_range_into_runnable_work() {
        let conn = fresh_db();
        let mut w = OpsWorks::default();
        // 第一枚 Want 立即进快车道并起 30s 冷却;第二枚落进冷却期,只登记不开工。
        assert_eq!(w.on_want(T, &oid("A1"), 1, 0).admit, Admit::Ok);
        assert_eq!(w.on_want(T, &oid("A2"), 1, 0).admit, Admit::Ok);

        // 把快车道那一段供空(库里没有这个 origin 的行 → 一次空转就出队)。
        let work = w.work_mut(T).expect("有条目");
        let p = work.prepare_next(&conn).expect("取数").ready().expect("有段");
        assert!(p.frame.is_none(), "库里没这个 origin 的行 → 空转");
        work.commit(p.token).expect("空转照样提交");
        assert!(w.work_mut(T).expect("有条目").prepare_next(&conn).expect("取数").ready().is_none());
        assert!(w.idle_runnable_targets().is_empty(), "登记那一段还压在冷却里,此刻没活可取");

        // 冷却到点:登记的那一段被放行 —— 这一刻它必须变成「有人来取就取得到」。
        w.on_tick(RANGE_COOLDOWN_TICKS, SNAP);
        assert_eq!(w.idle_runnable_targets(), vec![T.to_string()]);
    }

    /// 同一条规则的**另一半**(第②笔实现审二轮 M2):`on_tick` 还会把 pending 开成活动
    /// 计划,那一刻同样是「本来没活、现在有活」。只提 Range、漏了 Reconcile 启动的实现
    /// 照样能让上一只测绿 —— 而漏掉的正是全量追赶那一路。
    #[test]
    fn the_heartbeat_also_starts_a_pending_reconcile() {
        let conn = fresh_db();
        let mut w = OpsWorks::default();
        // 首枚 Hello 立即开计划;库是空的,一回合就扫完(active 当场释放)。
        assert_eq!(w.on_hello(T, vw(&[("A1", 0)]), SNAP, 0).admit, Admit::Ok);
        let work = w.work_mut(T).expect("有条目");
        let p = work.prepare_next(&conn).expect("取数").ready().expect("有计划");
        assert!(p.frame.is_none(), "空库 → 一回合扫完");
        work.commit(p.token).expect("提交");
        assert!(w.work_mut(T).expect("有条目").prepare_next(&conn).expect("取数").ready().is_none());

        // 第二枚 Hello 落在对账冷却里 → 只进 pending,此刻没活。
        assert_eq!(w.on_hello(T, vw(&[("A1", 0)]), SNAP, 0).admit, Admit::Ok);
        w.on_tick(0, SNAP);
        assert!(w.idle_runnable_targets().is_empty(), "还在冷却里,没有新工作可跑");
        // 冷却到点:pending 开成活动计划 —— 这一刻它必须变成可跑。
        w.on_tick(RECONCILE_COOLDOWN_TICKS, SNAP);
        assert_eq!(w.idle_runnable_targets(), vec![T.to_string()]);
    }

    /// 两根发号器都得是**不回绕**的加法(注释是这么承诺的)。2^64 次造不出行为测,
    /// 故按位置钉结构锚:生产段里两处自增都必须走 checked。
    #[test]
    fn both_token_counters_are_checked_not_wrapping() {
        let src = include_str!("ops_serve.rs");
        // 切点认的是**测试模块**,不是「第一处 `#[cfg(test)]`」:生产段里本就允许有
        // `#[cfg(test)]` 的测试探针(第②笔加 `inflight_armed` 时这只锚当场变绿了——切完
        // 只剩前 300 行,两处 checked 一处都不在里面)。锚点会随修法失效,这是第二例
        // (275 记的是变异 plan 的锚)。
        let prod = src.split("\nmod tests {").next().expect("切到测试模块之前");
        assert!(prod.contains("seq.checked_add(1)"), "凭据号必须 checked");
        assert!(prod.contains("|n| n.checked_add(1)"), "work 身份号必须 checked");
        assert!(!prod.contains("self.next_token += 1"), "裸加会绕");
        assert!(!prod.contains("NEXT_WORK_ID.fetch_add"), "裸 fetch_add 会绕");
    }

    /// **凭据跨 `OpsWorks` 也不许通用**(实现审二轮 M1):每空间一份的发号器会让两个
    /// 空间的第一份 work 都拿到 0,A 的第一枚凭据正好提交 B 的第一笔。
    #[test]
    fn a_token_from_another_space_cannot_commit_either() {
        let conn = fresh_db();
        let d = oid("A");
        for seq in 1..=4i64 {
            put(&conn, &d, seq, 1);
        }
        let mut a = OpsWorks::default();
        let mut b = OpsWorks::default();
        let _ = a.on_want(T, &d, 1, 0);
        let _ = b.on_want(T, &d, 3, 0);

        let pa = a.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("A 有活");
        let pb = b.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("B 有活");
        assert!(b.work_mut(T).unwrap().commit(pa.token).is_err(), "跨空间的凭据提交不了");
        assert_eq!(b.work_mut(T).unwrap().urgent.front().unwrap().next_seq, 3, "B 一步没动");
        b.work_mut(T).unwrap().commit(pb.token).expect("B 自己的照常");
    }

    /// **迟到的失败事件不许清掉新的在飞笔**(实现审二轮 M1 的另一半)。
    #[test]
    fn a_stale_rollback_cannot_clear_a_newer_inflight() {
        let conn = fresh_db();
        let d = oid("A");
        for seq in 1..=4i64 {
            put(&conn, &d, seq, 1);
        }
        let mut w = OpsWorks::default();
        let _ = w.on_want(T, &d, 1, 0);
        let work = w.work_mut(T).unwrap();

        let stale = work.prepare_next(&conn).unwrap().ready().expect("第一笔").token;
        work.rollback(stale).expect("它自己回滚得掉");
        let fresh = work.prepare_next(&conn).unwrap().ready().expect("第二笔");
        // 上一笔的失败回执迟到了 —— 它已经被吃掉,构造不出第二枚;拿别人的也不行。
        let alien = w.work_mut("01OTHERTARGETAAAAAAAAAAAAA");
        assert!(alien.is_none(), "没建过的 target 没有 work");
        let other = dev(3);
        let _ = w.on_want(&other, &d, 1, 0);
        let other_tok = w.work_mut(&other).unwrap().prepare_next(&conn).unwrap().ready().unwrap().token;
        assert!(w.work_mut(T).unwrap().rollback(other_tok).is_err(), "别人的凭据回滚不了这笔");
        assert!(w.work_mut(T).unwrap().inflight.is_some(), "在飞那一笔必须还在");
        w.work_mut(T).unwrap().commit(fresh.token).expect("正确凭据照常提交");
    }

    /// 折叠**保留游标**:活动计划从细粒度变全量重扫之后,已扫过的部分不重来
    /// (实现审二轮 L2 —— 原来那只预算测的游标本来就在起点,证伪不了「顺手重置」)。
    #[test]
    fn collapsing_watermarks_keeps_the_cursor_where_it_was() {
        let conn = fresh_db();
        for i in 1..=3usize {
            put(&conn, &dev(i), 1, 1);
        }
        let snap = max_rowid(&conn);
        let mut w = OpsWorks::default();
        let _ = w.on_hello(T, vw(&[]), snap, 0);
        step(&conn, w.work_mut(T).unwrap()).expect("先供一帧,游标离开起点");
        let cursor = w.work_mut(T).unwrap().active.as_ref().unwrap().cursor.clone();
        assert_ne!(cursor, ReconcileCursor::Start);

        // 冷却内再来一枚满额 Hello:该 target 留着两份 → 撞预算 → 折叠。
        let full = OPS_WATERMARK_BYTES_PER_TARGET;
        assert_eq!(
            w.on_hello(T, VettedWatermarks::forged(wm(&[(&oid("A"), 1)]), full * 2), snap, 1).admit,
            Admit::Collapsed
        );
        let p = w.work_mut(T).unwrap().active.as_ref().unwrap();
        assert_eq!(p.kind, PlanKind::Full, "降级成常量大小");
        assert_eq!(p.cursor, cursor, "游标原地不动 —— 已扫过的部分不许重来");
        assert_eq!(p.snapshot_rowid, snap, "快照也不动");
    }

    /// 一直在用的轮转游标**不该第一个被挤掉**(实现审二轮 H1 的另一半)。
    ///
    /// 满额驱逐挑的是「最旧的、没有 ops 工作的」那个,而只握着游标的条目正是这种。
    /// 取用时不刷 `last_touch` 的话,它永远停在建条目那一刻 —— 一枚**天天在用**的
    /// 广播游标会输给一枚**建完就没碰过**的。
    #[test]
    fn an_actively_used_hello_cursor_is_not_the_first_to_be_evicted() {
        let mut w = OpsWorks::default();
        // 两枚都在轮转中途(游标非空,故不是能被日常心跳回收的纯墓碑)。
        w.hello_cursor(&dev(1), 0).unwrap().after = Some(dev(9));
        w.hello_cursor(&dev(2), 0).unwrap().after = Some(dev(9));
        for i in 3..=OPS_TARGET_MAX {
            let _ = w.on_want(&dev(i), &oid("A"), 1, 0);
        }
        assert_eq!(w.len(), OPS_TARGET_MAX, "表满,且只有那两枚没有 ops 工作");

        w.hello_cursor(&dev(1), 5); // 1 号的游标又用了一次
        let _ = w.on_want(&dev(OPS_TARGET_MAX + 5), &oid("A"), 1, 5);
        assert!(w.throttle(&dev(1)).is_some(), "一直在用的那枚不该第一个被挤掉");
        assert!(w.throttle(&dev(2)).is_none(), "最旧的那枚才是");
    }

    /// 在飞的补洞帧撞上折叠:提交时队头已经没了,**什么都不该做**(义务已由 Full 接管)。
    #[test]
    fn a_gap_frame_in_flight_when_the_queue_collapses_commits_into_nothing() {
        let conn = fresh_db();
        let d = oid("N00");
        // **这一段必须发不完**(> 一帧):供完的段本来就不会被塞回队列,那样这只测
        // 分辨不出「队头没了就什么都不做」和「随便造一条塞回去」。
        for seq in 1..=(MAX_OPS_PER_FRAME as i64 + 1) {
            put(&conn, &d, seq, 1);
        }
        let mut w = OpsWorks::default();
        let _ = w.on_want(T, &d, 1, 0);
        let p = w.work_mut(T).unwrap().prepare_next(&conn).unwrap().ready().expect("有活");

        // 这一笔还在飞,补洞段被 Range 洪水折叠掉。
        for i in 1..=OPS_RANGES_PER_TARGET as i64 {
            let _ = w.on_want(T, &oid(&format!("M{i:02}")), 1, i as u64 * RANGE_COOLDOWN_TICKS);
        }
        assert_eq!(w.work_mut(T).unwrap().gaps_len(), 0, "两队都被清空");

        w.work_mut(T).unwrap().commit(p.token).expect("提交照样成功");
        let work = w.work_mut(T).unwrap();
        assert_eq!(work.gaps_len(), 0, "不许把被折叠掉的段又塞回来");
        assert_eq!(work.pending.as_ref().unwrap().kind, PlanKind::Full, "义务归全量重扫");
    }

    // ---- 取数:SQL keyset 逐帧惰性取 ----------------------------------------------

    /// 一次调用**至多一枚帧**,条数尺封住它;剩下的由下一枚游标接着走,不重不漏。
    #[test]
    fn one_call_serves_exactly_one_frame_and_the_count_limit_bounds_it() {
        let conn = fresh_db();
        let d = dev(1);
        let total = MAX_OPS_PER_FRAME as i64 + 100;
        for seq in 1..=total {
            put(&conn, &d, seq, 1);
        }

        let served = read_gap(&conn, &d, 1).unwrap();
        let f = served.frame.expect("有得发");
        assert_eq!(f.ops.len(), MAX_OPS_PER_FRAME, "一帧至多 500 条 —— 不是「有多少发多少」");
        assert_eq!(f.ops.first().unwrap().origin_seq, 1);
        assert_eq!(f.ops.last().unwrap().origin_seq, MAX_OPS_PER_FRAME as i64);
        assert_eq!(
            served.advance,
            Advance::Range { next_seq: MAX_OPS_PER_FRAME as i64 + 1, done: false },
            "取满一整帧不敢说供完了"
        );

        let served2 = read_gap(&conn, &d, MAX_OPS_PER_FRAME as i64 + 1).unwrap();
        assert_eq!(served2.frame.expect("尾巴还在").ops.len(), 100);
        assert_eq!(served2.advance, Advance::Range { next_seq: total + 1, done: true });
    }

    /// 字节尺:大 op 独占一帧,且 `bytes` 报的是**真实天花板**——消费方就靠它跟自己那条
    /// 腿的 wire 上限比大小(§10 六轮 M4:「每帧 ≤256 KiB」的记账不实)。
    #[test]
    fn an_oversized_op_takes_a_frame_alone_and_bytes_reports_the_real_ceiling() {
        let conn = fresh_db();
        let d = dev(1);
        for seq in 1..=3i64 {
            put(&conn, &d, seq, 150_000);
        }
        let served = read_gap(&conn, &d, 1).unwrap();
        let f = served.frame.unwrap();
        assert_eq!(f.ops.len(), 1, "两条同帧就超 256 KiB → 一条一帧");
        assert!(
            f.bytes > MAX_OPS_FRAME_BYTES / 2,
            "bytes 必须报真实体量(实得 {}),不然消费方无从判「这一帧封不封得下」",
            f.bytes
        );
        assert_eq!(served.advance, Advance::Range { next_seq: 2, done: false });
    }

    /// 固定快照:开计划之后新写入的行**这一轮一条都不供**(六轮 H1 —— 不然持续新增的
    /// origin 能让计划永远跑不完)。阴性对照:快照 0 时枚举返回空。
    #[test]
    fn the_snapshot_boundary_excludes_rows_written_after_the_plan_opened() {
        let conn = fresh_db();
        let d = dev(1);
        for seq in 1..=3i64 {
            put(&conn, &d, seq, 1);
        }
        let snap = max_rowid(&conn);
        for seq in 4..=6i64 {
            put(&conn, &d, seq, 1);
        }

        let plan = plan_with(PlanKind::Full, ReconcileCursor::Start, snap);
        let spec = FrameSpec::ReconcileSeek { after: None };
        let f = read_reconcile(&conn, &spec, &plan).unwrap().frame.expect("快照内有得发");
        assert_eq!(
            f.ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "快照之后写入的 4/5/6 不属于这一轮"
        );

        let empty = plan_with(PlanKind::Full, ReconcileCursor::Start, 0);
        let served = read_reconcile(&conn, &spec, &empty).unwrap();
        assert!(served.frame.is_none());
        assert_eq!(served.advance, Advance::ReconcileDone, "快照 0 = 一行都不在范围内");
    }

    /// 对账枚举:跳过对端已齐的 origin、按 `start_seq` 定起点、扫完回 `ReconcileDone`。
    #[test]
    fn reconcile_seek_skips_origins_the_peer_already_has() {
        let conn = fresh_db();
        for i in 1..=3usize {
            for seq in 1..=4i64 {
                put(&conn, &dev(i), seq, 1);
            }
        }
        let snap = max_rowid(&conn);
        // 对端在 1、2 上已齐,在 3 上落后两条。
        let peer = wm(&[(&dev(1), 4), (&dev(2), 4), (&dev(3), 2)]);
        let bytes = watermark_map_bytes(&peer);
        let plan = plan_with(PlanKind::Detailed { peer, bytes }, ReconcileCursor::Start, snap);

        let served = read_reconcile(&conn, &FrameSpec::ReconcileSeek { after: None }, &plan).unwrap();
        let f = served.frame.expect("3 号还欠着");
        assert_eq!(f.origin, dev(3), "1、2 已齐 —— 一枚帧都不该为它们发");
        assert_eq!(
            f.ops.iter().map(|o| o.origin_seq).collect::<Vec<_>>(),
            vec![3, 4],
            "起点 = 对端水位 + 1"
        );
        assert_eq!(served.advance, Advance::ReconcileAfter { origin: dev(3) });

        let after3 = FrameSpec::ReconcileSeek { after: Some(dev(3)) };
        let done = read_reconcile(&conn, &after3, &plan).unwrap();
        assert!(done.frame.is_none());
        assert_eq!(done.advance, Advance::ReconcileDone);
    }

    /// 单次取数的跳过预算:一大片「对端已齐」的 origin 不许一次跑完(那又是「单次输入
    /// 的工作量由数据规模说了算」),但游标**必须**前进,故计划仍必然走完。
    #[test]
    fn the_seek_budget_bounds_one_call_yet_the_cursor_still_advances() {
        let conn = fresh_db();
        let filler = OPS_SEEK_STEPS_PER_FRAME + 5;
        for i in 1..=filler {
            put(&conn, &dev(i), 1, 1);
        }
        let last = dev(filler + 1);
        put(&conn, &last, 1, 1);
        let snap = max_rowid(&conn);
        // 对端在前 filler 台上全齐,只差最后一台。
        let mut peer = BTreeMap::new();
        for i in 1..=filler {
            peer.insert(dev(i), 1i64);
        }
        let bytes = watermark_map_bytes(&peer);
        let plan = plan_with(PlanKind::Detailed { peer, bytes }, ReconcileCursor::Start, snap);

        let served = read_reconcile(&conn, &FrameSpec::ReconcileSeek { after: None }, &plan).unwrap();
        assert!(served.frame.is_none(), "预算内一台都没欠 —— 这一次不该发帧");
        assert_eq!(
            served.advance,
            Advance::ReconcileAfter { origin: dev(OPS_SEEK_STEPS_PER_FRAME) },
            "游标落在第 {OPS_SEEK_STEPS_PER_FRAME} 台上 —— 到限就停,但绝不原地踏步"
        );

        // 下一枚数据机会接着走,把欠的那台供出来。
        let next = FrameSpec::ReconcileSeek { after: Some(dev(OPS_SEEK_STEPS_PER_FRAME)) };
        let f = read_reconcile(&conn, &next, &plan).unwrap().frame.expect("欠的那台");
        assert_eq!(f.origin, last);
    }

    /// 读空的两种收场:补洞段到水位 = 出队(`done`);对账 origin 已齐 = 跨过去。
    #[test]
    fn an_exhausted_gap_pops_and_an_exhausted_origin_is_stepped_over() {
        let conn = fresh_db();
        let d = dev(1);
        put(&conn, &d, 1, 1);
        let snap = max_rowid(&conn);

        let served = read_gap(&conn, &d, 9).unwrap();
        assert!(served.frame.is_none());
        assert_eq!(
            served.advance,
            Advance::Range { next_seq: 9, done: true },
            "要不出东西的段该出队,不许挂着占公平轮次"
        );

        let plan =
            plan_with(PlanKind::Full, ReconcileCursor::At { origin: d.clone(), next_seq: 2 }, snap);
        let at = FrameSpec::ReconcileAt { origin: d.clone(), from_seq: 2 };
        let served = read_reconcile(&conn, &at, &plan).unwrap();
        assert!(served.frame.is_none());
        assert_eq!(served.advance, Advance::ReconcileAfter { origin: d });
    }

    /// **M2 要的那道锚**:三条 keyset 查询必须全走 `idx_oplog_origin_seq`,不许退化成
    /// 全表 `SCAN`、也不许排序落到 `TEMP B-TREE`(那样「每帧取数」就成了「每 origin
    /// 重扫全表」)。设计期是在 node 的内存库上量的,这里钉的是 rusqlite bundled + 真
    /// 文件库上的**当前态**。
    #[test]
    fn explain_query_plan_anchors_the_three_keyset_queries() {
        let conn = fresh_db();
        for i in 1..=20usize {
            for seq in 1..=20i64 {
                put(&conn, &dev(i), seq, 1);
            }
        }
        let details = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Vec<String> {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            stmt.query_map(params, |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        let cases: Vec<(&str, Vec<String>)> = vec![
            (SQL_SEEK_ORIGIN, details(SQL_SEEK_ORIGIN, &[&"", &i64::MAX])),
            (
                SQL_READ_RUN,
                details(SQL_READ_RUN, &[&dev(1), &1i64, &i64::MAX, &(MAX_OPS_PER_FRAME as i64)]),
            ),
            (SQL_WATERMARK_OF, details(SQL_WATERMARK_OF, &[&dev(1)])),
        ];
        for (sql, plan) in cases {
            let joined = plan.join(" | ");
            assert!(
                joined.contains("idx_oplog_origin_seq"),
                "没走 (origin, origin_seq) 索引:{sql}\n{joined}"
            );
            assert!(!joined.contains("SCAN "), "退化成全表扫:{sql}\n{joined}");
            assert!(!joined.contains("TEMP B-TREE"), "排序落到临时表:{sql}\n{joined}");
        }
    }

    /// 端到端:一份带对端水位的计划 + 消费方逐帧泵,把差额**不重不漏**供完,
    /// 且**一条对端已有的 op 都不重发**。
    #[test]
    fn a_full_catch_up_over_many_origins_serves_every_owed_op_exactly_once() {
        let conn = fresh_db();
        let origins = 40usize;
        let per = 12i64;
        for i in 1..=origins {
            for seq in 1..=per {
                put(&conn, &dev(i), seq, 1);
            }
        }
        let snap = max_rowid(&conn);
        // 奇数台已齐、偶数台落后一半。
        let mut peer = BTreeMap::new();
        let mut owed: Vec<(String, i64)> = vec![];
        for i in 1..=origins {
            let have = if i % 2 == 1 { per } else { per / 2 };
            peer.insert(dev(i), have);
            for seq in (have + 1)..=per {
                owed.push((dev(i), seq));
            }
        }
        let mut works = OpsWorks::default();
        assert_eq!(works.on_hello(T, vet_watermarks(peer).unwrap(), snap, 0).admit, Admit::Ok);
        let got = drain(&conn, works.work_mut(T).unwrap());
        assert_eq!(got, owed, "该供的一条不少、不该供的一条不多、顺序还是 origin×seq 升序");
        assert!(works.work_mut(T).unwrap().active.is_none(), "供完即释放");
    }

    // ---- 有界 Hello 水位图 ----------------------------------------------------------

    /// 一次装得下时:与全表水位逐字一致,**游标不启用**(下一枚 Hello 一模一样)。
    #[test]
    fn bounded_watermarks_equals_the_full_table_when_it_fits_and_parks_the_cursor() {
        let conn = fresh_db();
        for i in 1..=5usize {
            for seq in 1..=(i as i64 + 1) {
                put(&conn, &dev(i), seq, 1);
            }
        }
        let expect: BTreeMap<String, i64> = (1..=5usize).map(|i| (dev(i), i as i64 + 1)).collect();

        let mut cur = HelloCursor::default();
        let first = bounded_watermarks(&conn, &mut cur, OPS_WATERMARK_BYTES_PER_TARGET).unwrap();
        assert_eq!(first, expect);
        assert_eq!(cur, HelloCursor::default(), "装得下就不该留轮转游标");
        let again = bounded_watermarks(&conn, &mut cur, OPS_WATERMARK_BYTES_PER_TARGET).unwrap();
        assert_eq!(again, expect, "行为与现状全表水位一致");
    }

    /// 预算紧时轮转:单枚 Hello 只带预算内的一段,相邻几枚**合起来覆盖全部 origin**
    /// ——不轮转的话预算外那些 origin 的真实水位永远报不出去,对端每次重发同一批。
    #[test]
    fn a_tight_budget_rotates_across_hellos_until_every_origin_is_reported() {
        let conn = fresh_db();
        let n = 10usize;
        for i in 1..=n {
            put(&conn, &dev(i), i as i64, 1);
        }
        // 恰好装得下 3 条的预算。
        let three: BTreeMap<String, i64> = (1..=3usize).map(|i| (dev(i), i as i64)).collect();
        let budget = watermark_map_bytes(&three);

        let mut cur = HelloCursor::default();
        let mut union: BTreeMap<String, i64> = BTreeMap::new();
        let mut rounds = 0;
        while union.len() < n {
            let m = bounded_watermarks(&conn, &mut cur, budget).unwrap();
            assert!(!m.is_empty(), "每一枚 Hello 都得带点东西,否则游标不前进");
            assert!(
                watermark_map_bytes(&m) <= budget,
                "一枚 Hello 不许超预算:{} > {budget}",
                watermark_map_bytes(&m)
            );
            assert_eq!(m.len(), 3, "预算容得下 3 条就带满 3 条");
            for (k, v) in m {
                assert_eq!(*union.entry(k.clone()).or_insert(v), v);
            }
            rounds += 1;
            assert!(rounds < 20, "轮转没收敛");
        }
        let expect: BTreeMap<String, i64> = (1..=n).map(|i| (dev(i), i as i64)).collect();
        assert_eq!(union, expect, "几枚 Hello 合起来必须把每台的真实水位都报出去");
    }

    /// 绕满一圈就停:同一枚 Hello 里**绝不重复计**一个 origin(重复计等于预算凭空翻倍)。
    #[test]
    fn one_hello_never_wraps_past_its_own_starting_point() {
        let conn = fresh_db();
        for i in 1..=3usize {
            put(&conn, &dev(i), 1, 1);
        }
        let mut cur = HelloCursor::default();
        // 预算只容 1 条:第一枚带 1 号、游标停在它身上。
        let one: BTreeMap<String, i64> = [(dev(1), 1i64)].into_iter().collect();
        let m1 = bounded_watermarks(&conn, &mut cur, watermark_map_bytes(&one)).unwrap();
        assert_eq!(m1.len(), 1);
        assert_eq!(cur.after.as_deref(), Some(dev(1).as_str()));

        // 预算恰好放到 3 条:这一枚从 2 号起、绕回表头补 1 号,拿满全表就该停下。
        // **预算必须卡这么死**——放宽了的话「绕过头又数一遍」与「到点停」得到的 map
        // 一模一样(BTreeMap 把重复吸收掉了),这只测就成了空测。卡死之后两条路在
        // **游标**那一格分道:到点停 = 装得下 = 复位;绕过头 = 第 4 条撞预算 = 留游标。
        let three: BTreeMap<String, i64> = (1..=3usize).map(|i| (dev(i), 1i64)).collect();
        let m2 = bounded_watermarks(&conn, &mut cur, watermark_map_bytes(&three)).unwrap();
        assert_eq!(m2.len(), 3, "绕一圈恰好覆盖全表 —— 多一条就是重复计了");
        assert_eq!(cur, HelloCursor::default(), "一圈之内装得下 → 游标复位");
    }

    /// 出入站共用的那把尺**只许高报不许低报**:低报会让一枚正常的满额 Hello
    /// 一到收端就被折叠成全量重扫(七轮 M2)。
    #[test]
    fn watermark_map_bytes_never_underreports_the_real_cbor_length() {
        for n in [0usize, 1, 5, 30, 300] {
            let m: BTreeMap<String, i64> =
                (0..n).map(|i| (dev(i), (i as i64 + 1) * 1_000_000)).collect();
            let mut buf = Vec::new();
            ciborium::into_writer(&m, &mut buf).unwrap();
            let claimed = watermark_map_bytes(&m);
            assert!(claimed >= buf.len(), "{n} 条:报 {claimed} < 实 {}", buf.len());
            assert!(claimed - buf.len() <= 2, "{n} 条:高报得离谱({claimed} vs {})", buf.len());
        }
    }

    /// 入站形态闸:非规范 origin / 负水位一律整枚拒收(不做静默清洗),
    /// 且过闸后的字节数就是出站那把尺算出来的数(两边同尺,七轮 M2)。
    #[test]
    fn vet_watermarks_rejects_non_canonical_origins_and_negative_values() {
        let ok = wm(&[(&dev(1), 3), (&dev(2), 0)]);
        assert_eq!(vet_watermarks(ok.clone()).unwrap().bytes(), watermark_map_bytes(&ok));

        assert!(vet_watermarks(wm(&[("A", 1)])).is_err(), "1 字节 key 就是内存 DoS 的入口");
        assert!(vet_watermarks(wm(&[("d0000000000000000000000001", 1)])).is_err(), "小写非规范");
        assert!(
            vet_watermarks(wm(&[("01ILOU00000000000000000000", 1)])).is_err(),
            "I/L/O/U 不在字母表"
        );
        assert!(vet_watermarks(wm(&[(&dev(1), -1)])).is_err(), "负水位");
    }
}
