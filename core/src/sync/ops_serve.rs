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
use super::probe::p305;
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
    /// 而是:**原地 `VACUUM` 只在两个「文件上没有活引擎」的时刻发生** —— 299 起有两处,
    /// 都由 `db::reclaim_free_pages` 的调用点证据表与 `vacuum_and_reclaim_call_sites_are_the_audited_ones`
    /// 那只工作区级审计锚看着(299 之前这句写的是「仓里只有 VACUUM INTO」,现在不成立了):
    /// ① `db::open` / `spaces::open_space` 开库时回收空页 —— 连接刚造出来、引擎槽还没装;
    /// ② `boot::make_snapshot` 剥快照副本里的派生数据 —— 那是刚产出的临时文件,没有任何游标绑在它上面。
    /// 另加纪元压实换 `EngineKey` 丢 work。
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
    /// 补洞段供出了一帧,推进到 `next_seq`。**段照留,哪怕这一帧已经读到本机水位**。
    ///
    /// 「已到头」是**取数那一刻**的事实,而提交要等一个中转往返之后(§6.2 ①(C):本机
    /// origin 只由 relay 的 Ack 提交)。这中间本地新写的 op 会被 `on_want` 合并进这一段
    /// ——而 [`PeerWork::lower_existing_gap`] 对**更晚**的起点是空操作,于是那笔义务一个
    /// 字节都没记下,却让 `woke` 为假(段还在队里 = 看着有人在做)、让
    /// [`Engine::outbound`](engine.rs) 把内存游标推过去。段随后连着退役 = **静默丢**,
    /// 且没有任何续做所有者:心跳那一拍的 `outbound` 撞 `max <= last_pushed` 早返回。
    /// 这就是 303 量出的「推送唤醒活性缺口」。
    RangeAt { next_seq: i64 },
    /// 补洞段**读空**:出队。
    ///
    /// **只有 `frame == None` 那一支产得出它**(见 [`read_gap`]),而那一支的取数与提交
    /// 同处 `ops_prepare`(transport.rs)的一把库锁 —— 写者插不进来,故「这一段确实供完了」
    /// 在提交那一刻仍然成立。退役资格与它的判据因此绑死在同一个临界区里。
    RangeDrained,
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
            a @ (Advance::RangeAt { .. } | Advance::RangeDrained) => {
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
                    p305!(
                        "commit gap served_from={served_from} queued_next={} -> requeue(下修保护)",
                        r.next_seq
                    );
                    self.urgent.push_back(r);
                } else if let Advance::RangeAt { next_seq } = a {
                    p305!("commit gap served_from={served_from} -> requeue(next={next_seq})");
                    r.next_seq = next_seq;
                    // **未跑完就推到队尾**(六轮 M1):放回队头等于让第一枚大 Want
                    // 整段跑完,别的真实缺口全被饿死。
                    self.urgent.push_back(r);
                } else {
                    p305!(
                        "commit gap served_from={served_from} -> RETIRE(读空);urgent 余 {}",
                        self.urgent.len()
                    );
                }
                // 剩下那一格 = `RangeDrained` ∧ 没被下修过:出队,义务到此为止。
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
/// **退役资格只认「读空」,不认 `exhausted`**(305;原先这两句被当成同一条规则合写了)。
/// 差别只在**这一帧读到了尾**那一格:`exhausted` 说的是取数那一刻的水位,而提交在一个
/// 中转往返之后 —— 那中间新写的 op 会被合并进这一段,再随它一起退役(见
/// [`Advance::RangeAt`])。读空那一支没有这个窗口:它的取数与提交同处 `ops_prepare`
/// 的一把库锁。代价 = 每段抽干后多一次空探(索引单点),换回「退役判据与提交同刻成立」。
///
/// (对账那两支不受此病:它们的上界是**开计划那一刻钉死的** `snapshot_rowid`,而
/// `rowid <= snapshot` 的那批行 append-only 不会变,故「快照内已供完」提交时照样成立。)
fn read_gap(conn: &Connection, origin: &str, from_seq: i64) -> Result<Served, String> {
    let run = read_run(conn, origin, from_seq, i64::MAX)?;
    let advance = match &run.frame {
        Some(_) => Advance::RangeAt { next_seq: run.next_seq },
        None => Advance::RangeDrained,
    };
    p305!(
        "read_gap origin={} from={} -> {} seqs={}",
        &origin[origin.len().saturating_sub(6)..],
        from_seq,
        match &advance {
            Advance::RangeAt { next_seq } => format!("RangeAt(next={next_seq})"),
            _ => "RangeDrained".to_string(),
        },
        probe_seqs(&run.frame)
    );
    Ok(Served { frame: run.frame, advance })
}

/// 埋点用:帧里 `origin_seq` 的区间(空帧 = `-`)。见 [`crate::sync::probe`]。
#[cfg(feature = "probe305")]
fn probe_seqs(frame: &Option<OpsFrame>) -> String {
    match frame {
        None => "-".to_string(),
        Some(f) => match (f.ops.first(), f.ops.last()) {
            (Some(a), Some(b)) => format!("{}..{}({})", a.origin_seq, b.origin_seq, f.ops.len()),
            _ => "empty!".to_string(),
        },
    }
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
    /// 过完形态闸的那份图本体(生产读者只有 [`crate::sync::engine::Engine::hello_gap_wants`],
    /// 322)。**读得到的前提就是它已经过闸** —— key 恒是规范 26 字符 device id、值恒非负,
    /// 故那边照着它发出去的 `Want.origin` 天然合形,不必再自己验一遍。
    ///
    /// 闸在**构造**那一侧(字段私有 + 唯一造法 [`vet_watermarks`]),不在这一侧:把图取
    /// 出来读没有风险,拿一份没过闸的图冒充才有。
    pub(crate) fn peer(&self) -> &BTreeMap<String, i64> {
        &self.peer
    }

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
mod tests;
