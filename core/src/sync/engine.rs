//! sans-io 收端同步引擎 —— sync-protocol §5.3 的落实(P2-c)。
//!
//! 纯逻辑,不持 socket:输入 = 解密后的内层消息 + 本地日志句柄,输出 = 待发内层消息
//! 与 UI 事件;CBOR 编码与加密是 P2-d(crypto.rs),tokio 连接与重连是 P2-g
//! (transport.rs)。收敛 property test 直接驱动多个引擎实例 + 内存服务器模型(§9)。
//!
//! 正确性支点(§5.3):**不记账 + 水位不过缺口 = 自愈**。
//!   * 水位向量 = {origin → 本机日志该 origin 的 MAX(origin_seq)},**派生不存**(项目
//!     铁律);收端严格连续应用(仅队头 seq == watermark+1 出队),故日志 per-origin
//!     恒 1..max 无洞,MAX 即水位。
//!   * pending 池、挂起标记、拉流缓冲全是内存态,崩溃即丢也无害:水位没有越过它们,
//!     重连后任何持有者按 hello 互补重喂。缺字节图清单同理,从日志派生(on_connected)。
//!   * 入池前硬校验(评审①-H2):op 与 origin 的绑定不可破——一帧标错 origin 就能把
//!     水位推过不存在的号,此后真 op 到达被当已见丢弃,不可自愈。整帧拒收。
//!   * 分叉检测(§5.3/§11):同 (origin, origin_seq) 或同 hlc 撞不同 op_id = 该 origin
//!     的身份被旧备份回滚/整库克隆复活过,冻结该 origin 的同步 + 报错,不静默取舍;
//!     收到「本机 origin 的未知 op」= 本机自己就是被回滚的那端,同样冻结。
//!   * Err(依赖未到/版本偏斜的未知 field)→ 该 origin 队头挂起,其它 origin 照常;
//!     每有 op 落地对全部挂起头重试到不动点(活性论证见 replay.rs 模块注释)。
//!   * 池按 origin 设上限(评审①-M5):超限丢弃该 origin 全部 pending——水位不动,
//!     下一轮 hello/want 重取,只费流量不丢数据。
//!
//! 出站(§5.2):last_pushed 游标是内存态、乐观推进;P2-g 起传输层在连接建立时用
//! [`Engine::set_outbound_cursor`] 把它复位到 sync_meta 里 **ack 确认过**的位置——
//! 「已发未 ack」的 op 断线重连即重推,重复由对端 op_id 幂等吸收。帧丢失/游标丢失
//! 仍由双向 hello 水位互补兜底,游标只是流量优化。
//!
//! 图字节旁路(§5.4):image_add 应用后行不建,图进缺字节清单 → `blob_want` 广播
//! (mail,谁有谁答)→ 首个 `blob_have` 应答者处 `blob_pull` 拉流(direct)→
//! `blob_chunk` 攒块 → 验长度+sha256 → replay::apply_image_bytes 按 72 契约建行。
//! 对端行已不在回 `blob_deny`(pull/deny 是 §5.4 消息族的实现细化);拉流失败/对端
//! 下线由传输层通知 on_peer_unreachable,图退回清单等下次 hello 重试。

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use ulid::Ulid;

use crate::clock::{Clock, Hlc};
use crate::replay::{self, BytesOutcome, Outcome, RemoteOp};

/// 广播收件人(信封 `to` 的约定值,§3)。
pub const BROADCAST: &str = "*";
/// ops 帧条数上限(§5:≤500 条或 256 KiB,先到为准)。
const MAX_OPS_PER_FRAME: usize = 500;
/// ops 帧字节上限(§5;P2-g 补齐)。按帧内各 op 的 CBOR 编码字节累计度量——帧头
/// (变体名/origin/数组头)约几十字节、信封与 AEAD 另有 ~100B 级开销,服务器 1 MiB
/// 帧上限余量充足,预算不必逐字节精确。单条 op 超预算时独占一帧(op 不可拆;正文
/// set_field 走到数百 KiB 说明内容本身就这么大,服务器 1 MiB 帧上限是最后红线,
/// 超了 WS 层断连、响亮报错,不静默丢)。
const MAX_OPS_FRAME_BYTES: usize = 256 * 1024;
/// 图字节分块大小(§5.4)。
const BLOB_CHUNK_BYTES: usize = 256 * 1024;
/// pending 池每 origin 条数上限(§5.3,评审①-M5)。
const DEFAULT_PENDING_CAP: usize = 10_000;
/// pending 池每 origin **字节**上限(评审 P2-g 轮 M:条数上限拦不住大 payload op,
/// 坏的已配对对端可用 10000 条数百 KB 的 op 撑爆内存;取信箱同量级)。求和只对
/// 「drain 后仍滞留」的队列做——正常连续应用时队列即空,编码成本只花在有洞的
/// 异常路径上。
const DEFAULT_PENDING_BYTES: usize = 64 * 1024 * 1024;
/// 未决 origin 单槽池的全局上限(epoch-plan §5.1):满额 LRU 驱逐最旧槽(水位不动 +
/// 驱逐时发一次无状态 want,复用「池超限丢弃+want」自愈路径)——合法大历史乱序追赶
/// 只慢不死,伪造 origin 撑不出无界内存。
const ORIGIN_SLOT_CAP: usize = 64;
/// 冻结 origin 数上限(epoch-plan §4:现 frozen 是无界内存 HashMap——伪造 origin
/// 制造分叉可无限撑)。超限 → 进持久 poison-breaker。冻结本身仍是内存态、重连重检
/// (既有语义),上界与 breaker 是新增的资源边界。
const FROZEN_CAP: usize = 16;
/// quarantine 行数上限(§4;计入 §5.1 的 origin 总额度)。
const QUARANTINE_MAX_ROWS: i64 = 64;
/// quarantine 总字节上限(§4)。
const QUARANTINE_MAX_BYTES: i64 = 16 * 1024 * 1024;
/// 单 op 隔离材料上限(沿用 ops 帧上限;超限只存指纹,标「不可自动重验」)。
const QUARANTINE_MAX_OP_BYTES: usize = 256 * 1024;
/// 隔离原因文本上限(§4)。
const QUARANTINE_REASON_MAX: usize = 512;
/// 时钟偏斜提示阈值(§11 SHOULD,评审 P2-h 轮 L1):远端 op 的 HLC 墙钟比本机快过
/// 24h = LWW 长期偏向它,一次性提示查系统时间(不拒帧——对端时间可能真错,拒了反而
/// 卡住同步)。
const CLOCK_SKEW_THRESHOLD_MS: u64 = 24 * 60 * 60 * 1000;
/// 图字节拉流「无进展」阈值(on_tick 心跳次数):对端应了 BlobHave 却不发块(恶意或
/// bug),连累这么多次心跳后作废本次拉流、回缺图清单换来源(评审 P2-h 轮 M1)。心跳
/// 30s → 2 次 ≈ 60s idle 才判死,正常传输不误伤。
const PULL_STALE_TICKS: u32 = 2;

/// 图字节旁路策略(android-plan §4 M1,P4-d):由 `Engine::new` / Transport 显式注入,
/// 不做默认值,由调用端按端上需求选(桌面恒 Full;安卓 100-116 注 MetadataOnly、
/// **117 起反转为 Full** 时间轴显图)。`MetadataOnly`——`image_add` op 照记账、照推
/// 水位、照跑 `reconcile_item_images`(counter 推平 / 撞号翻案 / 正文修正),但**不登记
/// 缺字节清单、不发 BlobWant、不拉流**;`missing_blobs`/`pulling` 本就是可丢内存态、
/// 不参与 origin 连续性与分叉判定,故不阻塞水位、不触发分叉冻结。`on_blob_want` 两种
/// 策略下都照答(serve 是独立能力位:拿首次快照带来的旧图给别机补洞无一致性风险);
/// tombstone 清理逻辑保留(无害,利于切回 Full——切回后 on_connected 的
/// `derive_missing_blobs` 会重新发现全部缺口并补齐,117 的存量手机库正走这条自愈路)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobPolicy {
    /// 全量端:缺字节即 want/pull,终局图字节必齐(桌面;117 起安卓亦是)。
    Full,
    /// 轻端:图 op 只记元数据,字节永不主动拉取(v1b,android-plan §4;117 起
    /// 无现役使用者,语义与测试保留)。
    MetadataOnly,
}

/// 内层协议消息(密文内层,服务器不可见;§5)。P2-d 起是 CBOR 线上格式:serde
/// 默认表示(externally tagged——变体名作单键 map),变体名/字段名都是协议的一部分,
/// 改名 = 协议破坏(crypto.rs 的黄金向量测试把它焊死)。
///
/// 兼容纪律(codex P2-d 轮 M1):旧端解到未知顶层变体只能整帧 `Codec` 拒收(帧里
/// 谁的 op 都取不出,挂不了 origin)——所以 op/ctl 语义的将来扩展**优先走
/// `RemoteOp.kind`/payload**(0020 词汇表 CHECK 拒之 → replay Err → 挂起该 origin,
/// §5.3 版本偏斜自愈生效);确需新增顶层变体 = 协议破坏,必须升 `crypto::PROTO_VER`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Msg {
    /// op 帧:**单帧单 origin、按 origin_seq 严格升序**,≤ MAX_OPS_PER_FRAME 条。
    /// 帧 origin 允许 ≠ 发送者(任何持有者代补,§5.2),op 与 origin 的绑定由收端硬校验。
    Ops { origin: String, ops: Vec<RemoteOp> },
    /// 水位向量广播(连接后向各端发;mail lane,可入信箱)。
    Hello { watermarks: BTreeMap<String, i64> },
    /// 定向补洞:请把 origin 从 from_seq 起的 op 给我(谁有谁答,没有则静默)。
    Want { origin: String, from_seq: i64 },
    /// 图字节旁路(§5.4):缺字节方广播「谁有」。
    BlobWant { image_id: String },
    /// 持有方应答(定向)。
    BlobHave { image_id: String },
    /// 缺字节方向首个应答者发起拉流(direct)。transfer 由拉方生成(ULID),chunk/deny
    /// 回显——同一张图先后两次拉流的残帧靠它区分,不靠 idx 撞运气(§5.4 的 transfer)。
    BlobPull { image_id: String, transfer: String },
    /// 持有方行已不在(拉流窗口里被删):拒,对方回清单另寻来源。
    BlobDeny { image_id: String, transfer: String },
    /// 拉流数据块(direct;idx 从 0 连续,last 标终块)。data 按 CBOR bytes 编码
    /// (serde 默认会把 Vec<u8> 编成逐元素数组,256 KiB 块膨胀近一倍)。
    BlobChunk {
        image_id: String,
        transfer: String,
        idx: u32,
        last: bool,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
}

/// 投递通道(§3):mail 离线入信箱,direct 仅在线(boot/blob 大流量不驻留)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Mail,
    Direct,
}

/// 引擎输出:待发帧,或需上抛的事件(P2-g 转 UI)。
#[derive(Debug)]
pub enum Output {
    Send { to: String, lane: Lane, msg: Msg },
    Event(Event),
}

/// 引擎事件。
#[derive(Debug)]
pub enum Event {
    /// 「图N」并发撞号翻案(72 的提示义务)——P2-g 必须转成用户可见提示。
    ImagesRenumbered { renumbered: Vec<(String, i64, i64)>, content_rewritten: bool },
    /// 远端 space op 落地 = 空间名变了(space-name-sync-plan §4.7):壳层刷空间名
    /// 展示(空间菜单/捕获徽章/chip)。与通用 Changed 分开——名字挂 catalog/菜单层,
    /// 通用 Changed 的消费者对非当前空间直接丢弃,借道必漏(codex 一轮 H5)。
    SpaceNameChanged,
    /// origin 分叉,该 origin 同步已冻结(恢复走 §11 手工流程)。
    OriginFrozen { origin: String, reason: String },
    /// origin 队头挂起(依赖未到/对端版本较新)。解开不另发事件;同因不重报。
    OriginSuspended { origin: String, reason: String },
    /// origin 被持久隔离(毒 op,OpError::InvalidOp;epoch-plan §4):此后其帧到即丢,
    /// 跨重启生效。relay_from 是投递该 op 的设备——**不得断言 origin 设备 = 作恶发送
    /// 者**,吊谁由运营者依双坐标判断;UI 必须转常驻告警。
    OriginQuarantined { origin: String, relay_from: String, reason: String },
    /// poison-breaker 置位(§4 fail-closed):隔离/冻结额度到顶,引擎此后拒收一切
    /// **新** origin 的帧(已在册照常),落盘跨重启,解除须人工处置后显式复位。
    PoisonBreakerTripped { reason: String },
    /// 整帧拒收(入池前硬校验不过):协议错误,记日志用。
    FrameRejected { from: String, reason: String },
    /// 收到 HLC 墙钟比本机快 >24h 的远端 op(§11 SHOULD,L1)——对端系统时间可能错,
    /// LWW 会长期偏向它;每会话提示一次(P2-g 转用户可见),不拒帧。
    ClockSkew { ahead_hours: u64 },
}

/// 一次进行中的图字节拉流(direct)。expected 取自该图 image_add op 声明的字节数,
/// 攒块超过它立即作废——对端(bug 或恶意)发无尽 `last=false` 块撑不爆内存
/// (codex 二轮 #4)。
pub(crate) struct Pull {
    from: String,
    transfer: String,
    buf: Vec<u8>,
    next_idx: u32,
    expected: i64,
    /// 连续无进展的心跳次数(on_tick 加、收到块清零);到 [`PULL_STALE_TICKS`] 作废
    /// 本次拉流回清单换来源(M1)。
    stale_ticks: u32,
}

/// pending 池里的一枚 op:随 op 记下投递者(relay-from)——隔离时要落「origin +
/// relay-from 双坐标」(epoch-plan §4),池里不记则隔离时刻无从追溯是谁递的毒。
pub(crate) struct PendingOp {
    pub(crate) op: RemoteOp,
    relay_from: String,
}

/// 一个「未决 origin」的单槽(epoch-plan §5.1 core #5):pending 队列 + 挂起态 +
/// want 节流状态**同槽存放**,全局槽数有界、LRU 驱逐——不再有「pending 驱逐了、
/// want 状态还占坑」的半释放。槽的生命期 = 队列非空(缺口补齐/隔离/冻结 → 整槽
/// 删除即释放);挂起必伴随队头 op 在队里,故不会有「空队列挂起槽」。
pub(crate) struct OriginSlot {
    /// seq → op:BTreeMap 队头即最小 seq。
    pub(crate) queue: BTreeMap<i64, PendingOp>,
    /// 挂起原因(队头 apply Err;有 op 落地即全体解锁重试)。
    suspended: Option<String>,
    /// 已报过的挂起原因(事件去重:同因不重报,换因/恢复后再挂重报)。
    suspend_reported: Option<String>,
    /// 已发 want 的缺口位(节流:同一缺口在收到新 hello/ops 前不重复广播)。
    wanted: Option<i64>,
    /// LRU 轴:最近一次被帧触碰的单调序号(Engine::touch 发号)。
    touched: u64,
}

impl OriginSlot {
    fn new(touched: u64) -> OriginSlot {
        OriginSlot {
            queue: BTreeMap::new(),
            suspended: None,
            suspend_reported: None,
            wanted: None,
            touched,
        }
    }
}

/// sans-io 收端引擎。除 quarantined/breaker(镜像持久层,装配时装载)外,字段都是
/// 可丢弃的内存态(见模块注释),pub(crate) 供收敛测试直接检视终局(slots 必空、
/// 无冻结)。
pub struct Engine {
    device_id: String,
    /// 图字节旁路策略(M1):构造时显式注入,会话内不变。
    blob_policy: BlobPolicy,
    pending_cap: usize,
    pending_bytes_cap: usize,
    slot_cap: usize,
    /// 未决 origin 的单槽池(§5.1):全局 [`ORIGIN_SLOT_CAP`] 个,满额 LRU 驱逐
    /// (水位不动 + 无状态 want,自愈只慢不死)。
    pub(crate) slots: HashMap<String, OriginSlot>,
    /// LRU 单调计数器(touched 发号)。
    touch_seq: u64,
    /// origin → 冻结原因(分叉)。冻结即丢其 pending、不再收其帧。
    pub(crate) frozen: HashMap<String, String>,
    /// 已持久隔离的 origin(sync_quarantine 表的内存镜像,装配时装载;§4):
    /// 帧到即丢(只更新 relay_from_last 坐标)。
    pub(crate) quarantined: HashSet<String>,
    /// poison-breaker(§4 fail-closed):Some(置位原因)= 拒收一切新 origin 的帧。
    /// sync_meta『poison_breaker』的内存镜像,置位落盘、重启装载即恢复;解除须人工
    /// 处置后显式 [`Engine::reset_breaker`]。
    pub(crate) breaker: Option<String>,
    /// 本会话已因 breaker 被拒过的 origin(事件去刷屏,不持久)。
    breaker_reported: HashSet<String>,
    /// 缺字节的图(image_add 已应用、行未建、图活着)。与 pulling 互斥。
    pub(crate) missing_blobs: HashSet<String>,
    /// 拉流中(image_id → 进行中的传输)。
    pub(crate) pulling: HashMap<String, Pull>,
    /// 本会话内对某图超时过的来源(M1):重发 want 后别再选它(让别的设备应答),
    /// 否则同一个沉默对端会反复抢答、每次卡满 idle 阈值。on_connected 清零(重连是
    /// 新会话,人人再给一次机会)。
    blob_shunned: HashMap<String, HashSet<String>>,
    /// 出站游标:本机 op 已广播到哪(乐观推进,见模块注释)。
    last_pushed: i64,
    /// 本会话是否已提示过时钟偏斜(L1;一次即可,别刷屏)。
    skew_warned: bool,
}

impl Engine {
    /// 从库装配:device_id 取自 sync_meta(时钟先行,必在;缺失 = 库损坏,fail-fast)。
    /// 出站游标起点 = 本机当前水位——重启后不盲目全量重推,增量靠双向 hello 互补。
    /// `blob_policy` 显式注入(M1),不做默认值——桌面 Full、手机轻端 MetadataOnly。
    pub fn new(conn: &Connection, blob_policy: BlobPolicy) -> Result<Engine, String> {
        let device_id: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key = 'device_id'", [], |r| r.get(0))
            .map_err(|e| format!("引擎装配失败:sync_meta 缺 device_id({e})"))?;
        let last_pushed = watermark(conn, &device_id)?;
        // 持久隔离态装载(§4):quarantined origin 帧到即丢、breaker 置位即 fail-closed,
        // 都必须跨重启生效——「重启即忘、继续吸收」正是本表要关的洞。
        let quarantined: HashSet<String> = {
            let mut stmt = conn
                .prepare("SELECT origin FROM sync_quarantine")
                .map_err(|e| format!("引擎装配失败:读 sync_quarantine({e})"))?;
            let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
        };
        let breaker: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key = 'poison_breaker'", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(Engine {
            device_id,
            blob_policy,
            pending_cap: DEFAULT_PENDING_CAP,
            pending_bytes_cap: DEFAULT_PENDING_BYTES,
            slot_cap: ORIGIN_SLOT_CAP,
            slots: HashMap::new(),
            touch_seq: 0,
            frozen: HashMap::new(),
            quarantined,
            breaker,
            breaker_reported: HashSet::new(),
            missing_blobs: HashSet::new(),
            pulling: HashMap::new(),
            blob_shunned: HashMap::new(),
            last_pushed,
            skew_warned: false,
        })
    }

    /// 挂起中的 origin 数(transport 照进状态快照;收敛测试检视终局)。
    pub fn suspended_count(&self) -> usize {
        self.slots.values().filter(|s| s.suspended.is_some()).count()
    }

    /// 是否有 origin 处于挂起态且原因为 f 所述(测试用)。
    #[cfg(test)]
    pub(crate) fn is_suspended(&self, origin: &str) -> bool {
        self.slots.get(origin).is_some_and(|s| s.suspended.is_some())
    }

    /// 隔离与 breaker 的状态快照(UI 常驻告警用;transport 照进 SyncStatus)。
    pub fn poison_status(&self) -> (Vec<String>, Option<String>) {
        let mut q: Vec<String> = self.quarantined.iter().cloned().collect();
        q.sort();
        (q, self.breaker.clone())
    }

    /// 人工处置后的显式复位(§4:清隔离行/吊销之后才许解除;调用方负责先做处置)。
    /// 同时清 sync_meta 键与内存镜像;隔离行由调用方按 origin 清(revoke 后成死档)。
    /// 壳层命令面接线在 2a 工序7(处置 UI 随重置/隔离面一起做);在此之前只有测试消费。
    #[allow(dead_code)]
    pub fn reset_breaker(&mut self, conn: &Connection) -> Result<(), String> {
        conn.execute("DELETE FROM sync_meta WHERE key = 'poison_breaker'", [])
            .map_err(|e| e.to_string())?;
        self.breaker = None;
        self.breaker_reported.clear();
        Ok(())
    }

    /// 收敛测试用:压小 pending 池上限,促发「超限丢弃、hello/want 重取」路径。
    #[cfg(test)]
    pub(crate) fn with_pending_cap(mut self, cap: usize) -> Engine {
        self.pending_cap = cap;
        self
    }

    /// 公平性对抗测试用:压小全局槽数上限,促发 LRU 驱逐路径。
    #[cfg(test)]
    pub(crate) fn with_slot_cap(mut self, cap: usize) -> Engine {
        self.slot_cap = cap;
        self
    }

    /// 连接建立(含重连):广播 hello(全量水位向量)+ 对缺字节图重发 blob_want。
    /// want 去重游标与残余拉流作废(断线期间的都不可信);缺字节清单从日志派生——
    /// 「有 image_add、无 image_tombstone、宿主无 tombstone、行未建」,派生不存。
    /// MetadataOnly(M1):不派生清单、不发 want——切回 Full 的引擎在这里重新发现
    /// 全部缺口,轻端期间的「洞」自愈。
    pub fn on_connected(&mut self, conn: &Connection) -> Result<Vec<Output>, String> {
        for slot in self.slots.values_mut() {
            slot.wanted = None;
        }
        self.pulling.clear();
        self.blob_shunned.clear();
        self.missing_blobs = match self.blob_policy {
            BlobPolicy::Full => derive_missing_blobs(conn)?,
            BlobPolicy::MetadataOnly => HashSet::new(),
        };
        let mut out = vec![Output::Send {
            to: BROADCAST.into(),
            lane: Lane::Mail,
            msg: Msg::Hello { watermarks: watermarks(conn)? },
        }];
        for image_id in &self.missing_blobs {
            out.push(Output::Send {
                to: BROADCAST.into(),
                lane: Lane::Mail,
                msg: Msg::BlobWant { image_id: image_id.clone() },
            });
        }
        Ok(out)
    }

    /// 传输层心跳时调用(M1):给进行中的图拉流累计「无进展心跳」,连续
    /// [`PULL_STALE_TICKS`] 次仍无块 = 对端应了 BlobHave 却沉默(恶意或 bug),作废本次
    /// 拉流、图退回缺字节清单并当场重发 want 换来源——否则连接一直在(对端拿 pong
    /// 续命、不触发重连清 pulling)时该图永远拉不到,还挡住向别的设备请求。
    pub fn on_tick(&mut self) -> Vec<Output> {
        let mut expired: Vec<(String, String)> = vec![]; // (image_id, 超时来源)
        for (image_id, pull) in self.pulling.iter_mut() {
            pull.stale_ticks += 1;
            if pull.stale_ticks >= PULL_STALE_TICKS {
                expired.push((image_id.clone(), pull.from.clone()));
            }
        }
        let mut out = vec![];
        for (image_id, source) in expired {
            self.pulling.remove(&image_id);
            self.blob_shunned.entry(image_id.clone()).or_default().insert(source);
            self.missing_blobs.insert(image_id.clone());
            out.push(Output::Send {
                to: BROADCAST.into(),
                lane: Lane::Mail,
                msg: Msg::BlobWant { image_id },
            });
        }
        out
    }

    /// 连接建立时由传输层调用:把出站游标复位到 sync_meta 里 **ack 确认过**的位置
    /// (绝不往前拨——本连接内乐观推进的游标只会 ≥ 它)。「已发未 ack」的 op 由此在
    /// 重连后重推,重复帧由对端 op_id 幂等吸收;游标只是流量优化,正确性恒靠双向
    /// hello 水位互补(§5.2)。
    pub fn set_outbound_cursor(&mut self, acked: i64) {
        self.last_pushed = acked;
    }

    /// 本地写命令提交后调用:把 last_pushed 之后的本机新 op 广播出去(§5.2 实时推送)。
    pub fn outbound(&mut self, conn: &Connection) -> Result<Vec<Output>, String> {
        let max = watermark(conn, &self.device_id)?;
        if max <= self.last_pushed {
            return Ok(vec![]);
        }
        let frames = ops_frames(conn, &self.device_id, self.last_pushed + 1, max, BROADCAST)?;
        self.last_pushed = max;
        Ok(frames)
    }

    /// 传输层通知:对端不可达(direct 投递失败 / 断线)。作废来自它的拉流,图退回
    /// 缺字节清单(重发等下一次 on_connected / 收到 hello)。
    pub fn on_peer_unreachable(&mut self, device: &str) {
        let back: Vec<String> = self
            .pulling
            .iter()
            .filter(|(_, pull)| pull.from == device)
            .map(|(img, _)| img.clone())
            .collect();
        for img in back {
            self.pulling.remove(&img);
            self.missing_blobs.insert(img);
        }
    }

    /// 收到一帧内层消息(from = 信封上的发送设备;AAD 校验在 P2-d 解密层)。
    /// Err 只用于本地故障(SQLite 等);对端的坏帧走 Event::FrameRejected,不使引擎崩溃。
    pub fn on_msg(
        &mut self,
        conn: &mut Connection,
        clock: &mut Clock,
        from: &str,
        msg: Msg,
    ) -> Result<Vec<Output>, String> {
        match msg {
            Msg::Ops { origin, ops } => self.on_ops(conn, clock, from, origin, ops),
            Msg::Hello { watermarks } => self.on_hello(conn, from, &watermarks),
            Msg::Want { origin, from_seq } => on_want(conn, from, &origin, from_seq),
            Msg::BlobWant { image_id } => on_blob_want(conn, from, &image_id),
            Msg::BlobHave { image_id } => self.on_blob_have(conn, from, &image_id),
            Msg::BlobPull { image_id, transfer } => on_blob_pull(conn, from, &image_id, &transfer),
            Msg::BlobDeny { image_id, transfer } => {
                self.on_blob_deny(from, &image_id, &transfer);
                Ok(vec![])
            }
            Msg::BlobChunk { image_id, transfer, idx, last, data } => {
                self.on_blob_chunk(conn, from, &image_id, &transfer, idx, last, data)
            }
        }
    }

    // ---- ops 帧:硬校验 → 分叉检测 → 入池 → 连续喂入 → 补洞 -------------------------

    fn on_ops(
        &mut self,
        conn: &mut Connection,
        clock: &mut Clock,
        from: &str,
        origin: String,
        ops: Vec<RemoteOp>,
    ) -> Result<Vec<Output>, String> {
        // 冻结的 origin 静默丢(冻结时刻已报过一次,不刷屏)。
        if self.frozen.contains_key(&origin) {
            return Ok(vec![]);
        }
        // 持久隔离的 origin 帧到即丢(§4);只把 relay_from_last 坐标记下——「最近
        // 一次还有谁在递它」是运营者双坐标裁断的另一半。
        if self.quarantined.contains(&origin) {
            conn.execute(
                "UPDATE sync_quarantine SET relay_from_last = ?2 WHERE origin = ?1",
                (&origin, from),
            )
            .map_err(|e| e.to_string())?;
            return Ok(vec![]);
        }
        // poison-breaker(§4 fail-closed):置位后拒收一切**新** origin 的帧(已在册
        // = 本地日志已有其 op 的 origin 照常)。同 origin 每会话只报一次。
        if let Some(breaker_reason) = self.breaker.clone() {
            if watermark(conn, &origin)? == 0 {
                if self.breaker_reported.insert(origin.clone()) {
                    return Ok(vec![Output::Event(Event::FrameRejected {
                        from: from.into(),
                        reason: format!(
                            "poison-breaker 已置位({breaker_reason}):拒收新 origin {origin} 的帧"
                        ),
                    })]);
                }
                return Ok(vec![]);
            }
        }
        // 入池前硬校验(§5.3,评审①-H2):任一不合 → 整帧拒收,不进 pending。
        if let Err(reason) = validate_frame(&origin, &ops) {
            return Ok(vec![Output::Event(Event::FrameRejected { from: from.into(), reason })]);
        }
        // 本机 origin 的回声:逐条与本机日志**完整**对账——未知 seq、同 seq 异 op、
        // 同 op_id 异内容,都 = 本机身份曾被整库回滚/克隆(§11;克隆库双方各自花掉了
        // 同一批序号,只查「seq > 水位」会静默漏掉已花段的分叉,codex 二轮 #1;只比
        // op_id 会漏掉同 id 异内容,codex 四轮),冻结报错;逐条全同才是正常兜圈,丢。
        if origin == self.device_id {
            let my = watermark(conn, &self.device_id)?;
            for op in &ops {
                if op.origin_seq > my {
                    let reason = format!(
                        "收到本机 origin 的未知 op(seq {} > 水位 {my}):本机身份曾被回滚或克隆",
                        op.origin_seq
                    );
                    return self.freeze(conn, &origin, reason);
                }
                if replay::logged_op_matches(conn, op)? != Some(true) {
                    let reason = format!(
                        "本机 origin 分叉:对端持有的 op {}(seq {})与本机日志不符(本机身份曾被回滚或克隆)",
                        op.op_id, op.origin_seq
                    );
                    return self.freeze(conn, &origin, reason);
                }
            }
            return Ok(vec![]);
        }

        // 时钟偏斜提示(§11 SHOULD,L1):远端 op 的 HLC 墙钟比本机快 >24h,每会话报一次。
        // 只看跨 origin 帧(本机回声上面已返回);validate_frame 已保证 hlc 可解析。
        let mut pre: Vec<Output> = vec![];
        if !self.skew_warned {
            let now = crate::clock::wall_now_ms();
            let ahead = ops
                .iter()
                .filter_map(|op| Hlc::parse(&op.hlc).ok().map(|h| h.wall_ms))
                .max()
                .filter(|&w| w > now.saturating_add(CLOCK_SKEW_THRESHOLD_MS))
                .map(|w| (w - now) / (60 * 60 * 1000));
            if let Some(ahead_hours) = ahead {
                self.skew_warned = true;
                pre.push(Output::Event(Event::ClockSkew { ahead_hours }));
            }
        }

        let wm = watermark(conn, &origin)?;
        // 该 origin 已应用日志的 hlc 上界(日志无洞且双序一致,MAX 即最后一条;本帧
        // 处理期间不 drain,循环外查一次即可)——池中无前驱时的双序下界。
        let applied_max_hlc: Option<String> = conn
            .query_row("SELECT MAX(hlc) FROM oplog WHERE origin = ?1", [&origin], |r| {
                r.get::<_, Option<String>>(0)
            })
            .map_err(|e| e.to_string())?;
        for op in ops {
            if op.origin_seq <= wm {
                // 该格子已有已应用的 op:与它**完整**核对——同 op_id 异内容/异 op_id
                // 都是分叉(只比 op_id 会把「同 id 异内容」当重传吞掉,两端水位齐、
                // hello/want 永不再修,静默分叉;codex 四轮)。全同 = 重传,丢。
                if replay::logged_op_matches(conn, &op)? == Some(true) {
                    continue;
                }
                let reason = format!(
                    "origin 分叉:seq {} ≤ 水位 {wm},但 op {} 与日志已应用者不符(旧备份回滚复活了该设备身份?)",
                    op.origin_seq, op.op_id
                );
                return self.freeze(conn, &origin, reason);
            }
            // seq > 水位却撞上日志(同 op_id 或同 hlc):已应用者的坐标必 ≤ 水位,
            // 同一身份/同一时刻声称两个坐标 = 分叉。
            if replay::logged_op_matches(conn, &op)?.is_some() {
                let reason = format!(
                    "origin 分叉:op {} 已在日志(坐标必 ≤ 水位),又以 seq {} 到达",
                    op.op_id, op.origin_seq
                );
                return self.freeze(conn, &origin, reason);
            }
            let hlc_owner: Option<String> = conn
                .query_row("SELECT op_id FROM oplog WHERE hlc = ?1", [&op.hlc], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(k) = hlc_owner {
                let reason =
                    format!("origin 分叉:hlc {} 已记 op {k},又收到 {}", op.hlc, op.op_id);
                return self.freeze(conn, &origin, reason);
            }
            enum Pool {
                Insert,
                Duplicate,
                Fork(String),
            }
            let verdict = {
                let empty = BTreeMap::new();
                let queue = self.slots.get(&origin).map(|s| &s.queue).unwrap_or(&empty);
                match queue.get(&op.origin_seq) {
                    Some(prev) if !same_op(&prev.op, &op) => Pool::Fork(format!(
                        "origin 分叉:pending 里 seq {} 已有 op {},又收到不同的 {}",
                        op.origin_seq, prev.op.op_id, op.op_id
                    )),
                    Some(_) => Pool::Duplicate, // 重复到达(多端同答 hello 的已知噪音,§5.2)。
                    None => {
                        // §5.1/§7 双序不变量「seq 序 == HLC 序」的**跨帧**维护(codex
                        // 三轮 High):帧内校验挡不住跨帧交错——seq2/hlc100 先入池、
                        // seq1/hlc200 后到,应用后本地日志双序矛盾,将来代补给第三端
                        // 会被对方的帧内校验永久拒帧:坏日志带病传播、终局不收敛。
                        // op 的 hlc 必须严格落在池中前驱与后继的开区间(无前驱时下界
                        // = 已应用日志的 MAX hlc);矛盾 = 该 origin 历史自相矛盾,冻结。
                        let lower = queue
                            .range(..op.origin_seq)
                            .next_back()
                            .map(|(_, o)| o.op.hlc.as_str())
                            .or(applied_max_hlc.as_deref());
                        let upper =
                            queue.range(op.origin_seq + 1..).next().map(|(_, o)| o.op.hlc.as_str());
                        if lower.map_or(false, |lo| op.hlc.as_str() <= lo) {
                            Pool::Fork(format!(
                                "origin 双序矛盾:seq {} 的 hlc {} 不大于其前驱的 {}",
                                op.origin_seq,
                                op.hlc,
                                lower.expect("刚判过 Some")
                            ))
                        } else if upper.map_or(false, |hi| op.hlc.as_str() >= hi) {
                            Pool::Fork(format!(
                                "origin 双序矛盾:seq {} 的 hlc {} 不小于其后继的 {}",
                                op.origin_seq,
                                op.hlc,
                                upper.expect("刚判过 Some")
                            ))
                        } else {
                            Pool::Insert
                        }
                    }
                }
            };
            match verdict {
                Pool::Fork(reason) => return self.freeze(conn, &origin, reason),
                Pool::Duplicate => continue,
                Pool::Insert => {
                    pre.extend(self.slot_insert(
                        conn,
                        &origin,
                        PendingOp { op, relay_from: from.into() },
                    )?);
                }
            }
        }
        let mut out = pre;
        out.extend(self.drain(conn, clock)?);
        // 池上限(评审①-M5)在 drain **之后**查:连续可应用的大帧(hello 一次补几百
        // 条)drain 完池自然空,永不误杀;drain 后仍滞留的才是「洞/挂起后面的堆积」
        // ——这正是上限要防的内存增长。超限丢该 origin 全部 pending(整槽释放,§5.1
        // 单槽模型:不再有半释放):水位不动 = 没丢数据,只费流量。丢弃的同时**必须
        // 当场发 want**——槽没了,emit_wants 看不见这个缺口,而长连接下「下次重连的
        // hello」可能永不发生,want 是此刻唯一的重取信号(codex 二轮 #3)。
        let over_cap = match self.slots.get(&origin) {
            None => false,
            Some(s) => {
                s.queue.len() > self.pending_cap
                    || s.queue.values().map(|p| encoded_op_len(&p.op)).sum::<usize>()
                        > self.pending_bytes_cap
            }
        };
        if over_cap {
            self.slots.remove(&origin);
            let need = watermark(conn, &origin)? + 1;
            out.push(Output::Send {
                to: BROADCAST.into(),
                lane: Lane::Mail,
                msg: Msg::Want { origin: origin.clone(), from_seq: need },
            });
        }
        out.extend(self.emit_wants(conn)?);
        // 回放可能发射了本机新 op(「图N」翻案的正文修正走真 set_field,replay.rs):
        // 当场广播,别等下一次本地命令或重连——对端在线却收不到修正 op,内容要一直
        // 分叉到下个偶然事件为止(codex 二轮 #6)。
        out.extend(self.outbound(conn)?);
        Ok(out)
    }

    /// 入槽(§5.1 单槽模型):新 origin 且槽池满额 → LRU 驱逐最旧槽(整槽释放、水位
    /// 不动,发一次**无状态** want 复用「丢弃+want」自愈路径——合法大历史乱序追赶
    /// 只慢不死);每次触碰刷新 LRU 轴。
    fn slot_insert(
        &mut self,
        conn: &Connection,
        origin: &str,
        p: PendingOp,
    ) -> Result<Vec<Output>, String> {
        let mut out = vec![];
        if !self.slots.contains_key(origin) && self.slots.len() >= self.slot_cap {
            let evict = self
                .slots
                .iter()
                .min_by_key(|(_, s)| s.touched)
                .map(|(o, _)| o.clone())
                .expect("满额必非空");
            self.slots.remove(&evict);
            let need = watermark(conn, &evict)? + 1;
            out.push(Output::Send {
                to: BROADCAST.into(),
                lane: Lane::Mail,
                msg: Msg::Want { origin: evict, from_seq: need },
            });
        }
        self.touch_seq += 1;
        let touched = self.touch_seq;
        let seq = p.op.origin_seq;
        let slot =
            self.slots.entry(origin.to_string()).or_insert_with(|| OriginSlot::new(touched));
        slot.touched = touched;
        slot.queue.insert(seq, p);
        Ok(out)
    }

    /// 连续喂入到不动点:每个 origin 只要队头 seq == watermark+1 就出队喂
    /// apply_remote_op;任何 op 落地 → 全部挂起头解锁重试(§5.3)。队列喂空 =
    /// 缺口补齐 → 整槽删除即释放(§5.1:不留半释放状态)。
    fn drain(&mut self, conn: &mut Connection, clock: &mut Clock) -> Result<Vec<Output>, String> {
        let mut out = vec![];
        loop {
            let mut progressed = false;
            let origins: Vec<String> = self.slots.keys().cloned().collect();
            for origin in origins {
                if self.slots.get(&origin).map_or(true, |s| s.suspended.is_some()) {
                    continue; // 本轮别再试,等别的 origin 落地解锁。
                }
                loop {
                    let Some(slot) = self.slots.get_mut(&origin) else { break };
                    let Some((&head_seq, _)) = slot.queue.first_key_value() else {
                        self.slots.remove(&origin); // 缺口补齐:整槽释放。
                        break;
                    };
                    if head_seq != watermark(conn, &origin)? + 1 {
                        break; // 有洞,等 want/hello 补。
                    }
                    let p = slot.queue.remove(&head_seq).expect("队头刚看过,必在");
                    match replay::apply_remote_op(conn, clock, &p.op) {
                        Ok(outcome) => {
                            progressed = true;
                            if let Some(s) = self.slots.get_mut(&origin) {
                                s.suspend_reported = None;
                            }
                            out.extend(self.settle_outcome(conn, &p.op, outcome)?);
                        }
                        // 本地 IO/SQL 故障(typed poison §4):与 op 内容无关,原样
                        // 冒泡给会话层(断线重连重喂),不挂起不隔离——挂起会把本地
                        // 故障伪装成「对端的问题」。op 放回队头,内存态反正随会话丢弃。
                        Err(replay::OpError::LocalFault(e)) => {
                            self.slots
                                .get_mut(&origin)
                                .expect("刚取过")
                                .queue
                                .insert(head_seq, p);
                            return Err(e);
                        }
                        // 毒 op(已知词汇下的非法,§4)→ 持久隔离该 origin:完整 op
                        // 存进隔离行(此后帧到即丢、源可能永不重发,不存则升级重验
                        // 无材料),不放回池。
                        Err(replay::OpError::InvalidOp(reason)) => {
                            out.extend(self.quarantine_origin(conn, &origin, &p, &reason)?);
                            break;
                        }
                        // UnsupportedVocab(版本偏斜)/ DependencyMissing(因果未到)
                        // → 队头挂起:op 放回,换别的 origin;同因不重报(既有自愈
                        // 语义,§5.3 支点不动)。
                        Err(e) => {
                            let reason = e.to_string();
                            let slot = self.slots.get_mut(&origin).expect("刚取过");
                            slot.queue.insert(head_seq, p);
                            if slot.suspend_reported.as_deref() != Some(reason.as_str()) {
                                slot.suspend_reported = Some(reason.clone());
                                out.push(Output::Event(Event::OriginSuspended {
                                    origin: origin.clone(),
                                    reason: reason.clone(),
                                }));
                            }
                            slot.suspended = Some(reason);
                            break;
                        }
                    }
                }
            }
            if !progressed {
                return Ok(out);
            }
            // 有 op 落地:全部挂起头下一轮重试(挂起态清除;去重记忆保留到成功)。
            for slot in self.slots.values_mut() {
                slot.suspended = None;
            }
        }
    }

    /// 一条 op 落地后的引擎侧收尾:翻案事件上抛 + 图字节旁路联动(§5.4)。
    fn settle_outcome(
        &mut self,
        conn: &Connection,
        op: &RemoteOp,
        outcome: Outcome,
    ) -> Result<Vec<Output>, String> {
        let mut out = vec![];
        // 图活着才拉字节:Suppressed/ParentGone 是死图;Renumbered 的图自身可能已有
        // 乱序先到的 tombstone(apply 层翻案照做、不查),这里补一刀。
        let image_alive = matches!(
            outcome,
            Outcome::Applied | Outcome::RenumberedLocalImages { .. }
        );
        // 远端改名真落地(Applied;LwwStale 只记账名没变,不惊扰壳)→ 专用事件
        // (space-name-sync-plan §4.7 三入口之 live replay)。
        if op.entity == "space" && matches!(outcome, Outcome::Applied) {
            out.push(Output::Event(Event::SpaceNameChanged));
        }
        if let Outcome::RenumberedLocalImages { renumbered, content_rewritten } = outcome {
            out.push(Output::Event(Event::ImagesRenumbered { renumbered, content_rewritten }));
        }
        match (op.entity.as_str(), op.kind.as_str()) {
            // MetadataOnly(M1):outcome/counter/翻案已在 replay 层完整处理,这里
            // 只是「登记缺字节 + 发 want」的旁路入口——轻端整臂跳过。不能只掏空
            // derive_missing_blobs:新 image_add 落地会在此处重新插入 missing。
            ("image", "image_add")
                if image_alive && self.blob_policy == BlobPolicy::Full =>
            {
                let row_in: bool = conn
                    .query_row("SELECT 1 FROM item_image WHERE id = ?1", [&op.entity_id], |_| Ok(()))
                    .optional()
                    .map_err(|e| e.to_string())?
                    .is_some();
                let dead: bool = conn
                    .query_row(
                        "SELECT 1 FROM oplog WHERE entity = 'image' AND entity_id = ?1 \
                         AND kind = 'image_tombstone' LIMIT 1",
                        [&op.entity_id],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?
                    .is_some();
                if !row_in && !dead && !self.pulling.contains_key(&op.entity_id) {
                    self.missing_blobs.insert(op.entity_id.clone());
                    out.push(Output::Send {
                        to: BROADCAST.into(),
                        lane: Lane::Mail,
                        msg: Msg::BlobWant { image_id: op.entity_id.clone() },
                    });
                }
            }
            ("image", "image_tombstone") => {
                self.missing_blobs.remove(&op.entity_id);
                self.pulling.remove(&op.entity_id);
            }
            ("item", "tombstone") => {
                // 宿主死了:名下缺字节的图不再拉(行已随 CASCADE 消失/永不再建)。
                let mut stmt = conn
                    .prepare(
                        "SELECT entity_id FROM oplog WHERE entity = 'image' AND kind = 'image_add' \
                         AND json_extract(payload, '$.item_id') = ?1",
                    )
                    .map_err(|e| e.to_string())?;
                let imgs: Vec<String> = stmt
                    .query_map([&op.entity_id], |r| r.get(0))
                    .map_err(|e| e.to_string())?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(|e| e.to_string())?;
                for img in imgs {
                    self.missing_blobs.remove(&img);
                    self.pulling.remove(&img);
                }
            }
            _ => {}
        }
        Ok(out)
    }

    /// 洞检测 → want(§5.2):某 origin 有 pending 但队头 > watermark+1(中间帧丢在
    /// 信箱 TTL/溢出里)→ 广播补洞请求。同一缺口只发一次;水位推进后缺口位变化自然
    /// 重发;want 本身丢了由下一次 hello 兜底(want 是加速器,hello 是兜底)。
    fn emit_wants(&mut self, conn: &Connection) -> Result<Vec<Output>, String> {
        let mut asks: Vec<(String, i64)> = vec![];
        for (origin, slot) in &self.slots {
            let Some((&head, _)) = slot.queue.first_key_value() else { continue };
            let need = watermark(conn, origin)? + 1;
            if head > need && slot.wanted != Some(need) {
                asks.push((origin.clone(), need));
            }
        }
        let mut out = vec![];
        for (origin, need) in asks {
            if let Some(slot) = self.slots.get_mut(&origin) {
                slot.wanted = Some(need);
            }
            out.push(Output::Send {
                to: BROADCAST.into(),
                lane: Lane::Mail,
                msg: Msg::Want { origin, from_seq: need },
            });
        }
        Ok(out)
    }

    /// 收到水位向量:对每个「我高你低」的 origin(含对方没听说过的)回 ops 补给
    /// (§5.2)。「我低你高」不动作——对方也会收到我的 hello,对称补齐。顺带把
    /// hello 当「对端可达」信号,向它重发缺字节图的 want(§5.4 的重试时机;
    /// MetadataOnly 下清单恒空,天然不发——M1「on_hello 不重发 blob want」)。
    fn on_hello(
        &mut self,
        conn: &Connection,
        from: &str,
        theirs: &BTreeMap<String, i64>,
    ) -> Result<Vec<Output>, String> {
        let mut out = vec![];
        for (origin, my_max) in watermarks(conn)? {
            let their = theirs.get(&origin).copied().unwrap_or(0);
            if my_max > their {
                out.extend(ops_frames(conn, &origin, their + 1, my_max, from)?);
            }
        }
        for image_id in &self.missing_blobs {
            out.push(Output::Send {
                to: from.into(),
                lane: Lane::Mail,
                msg: Msg::BlobWant { image_id: image_id.clone() },
            });
        }
        Ok(out)
    }

    // ---- 图字节旁路(§5.4) ----------------------------------------------------------

    /// 有人应答「我有字节」:还缺 → 向首个应答者拉流(direct,transfer 由本端取号);
    /// 已在拉/已到手 → 忽略。expected 字节数取自该图 add op 的声明,攒块上限的依据。
    fn on_blob_have(
        &mut self,
        conn: &Connection,
        from: &str,
        image_id: &str,
    ) -> Result<Vec<Output>, String> {
        if self.blob_policy == BlobPolicy::MetadataOnly {
            return Ok(vec![]); // 防御(M1):本策略不发 want,天上掉的 have 不接。
        }
        if !self.missing_blobs.contains(image_id) {
            return Ok(vec![]); // 不缺(拉流中/已建行/图已死),首个应答者之后的都忽略。
        }
        if self.blob_shunned.get(image_id).is_some_and(|s| s.contains(from)) {
            return Ok(vec![]); // 本会话对该图超时过的来源:让别的设备应答(M1)。
        }
        let expected: Option<i64> = conn
            .query_row(
                "SELECT CAST(json_extract(payload, '$.bytes') AS INTEGER) FROM oplog \
                 WHERE entity = 'image' AND entity_id = ?1 AND kind = 'image_add'",
                [image_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(expected) = expected else {
            return Ok(vec![]); // 清单里却无 add op:防御,不拉(清单本就派生自 add)。
        };
        self.missing_blobs.remove(image_id);
        let transfer = Ulid::new().to_string();
        self.pulling.insert(
            image_id.into(),
            Pull {
                from: from.into(),
                transfer: transfer.clone(),
                buf: vec![],
                next_idx: 0,
                expected,
                stale_ticks: 0,
            },
        );
        Ok(vec![Output::Send {
            to: from.into(),
            lane: Lane::Direct,
            msg: Msg::BlobPull { image_id: image_id.into(), transfer },
        }])
    }

    /// 供块方拒了(行在应答后被删):回清单另寻来源(或等它的 tombstone op 到)。
    fn on_blob_deny(&mut self, from: &str, image_id: &str, transfer: &str) {
        if let Some(pull) = self.pulling.get(image_id) {
            if pull.from == from && pull.transfer == transfer {
                self.pulling.remove(image_id);
                self.missing_blobs.insert(image_id.into());
            }
        }
    }

    /// 攒块;终块到齐 → 验货建行(replay::apply_image_bytes,72 契约)。错源/错
    /// transfer(上一次拉流的残帧)= 静默丢;错序或攒块超过 add 声明的字节数 =
    /// 作废本次拉流回清单(超量防对端无尽 last=false 块撑内存,codex 二轮 #4);
    /// 验货不过(坏字节)同样回清单换来源重试。
    fn on_blob_chunk(
        &mut self,
        conn: &mut Connection,
        from: &str,
        image_id: &str,
        transfer: &str,
        idx: u32,
        last: bool,
        data: Vec<u8>,
    ) -> Result<Vec<Output>, String> {
        if self.blob_policy == BlobPolicy::MetadataOnly {
            return Ok(vec![]); // 防御(M1):本策略永不拉流,任何块都是非本策略发起的。
        }
        let Some(pull) = self.pulling.get_mut(image_id) else {
            return Ok(vec![]); // 过期流(拉流已作废/图已死),丢。
        };
        if pull.from != from || pull.transfer != transfer {
            return Ok(vec![]); // 别的来源/上一次 transfer 的残帧:丢,不动进行中的拉流。
        }
        if idx != pull.next_idx || pull.buf.len() + data.len() > pull.expected as usize {
            self.pulling.remove(image_id);
            self.missing_blobs.insert(image_id.into());
            return Ok(vec![]);
        }
        pull.buf.extend_from_slice(&data);
        pull.next_idx += 1;
        pull.stale_ticks = 0; // 有进展:偏斜计时清零(M1)。
        if !last {
            return Ok(vec![]);
        }
        let pull = self.pulling.remove(image_id).expect("刚取过");
        match replay::apply_image_bytes(conn, image_id, &pull.buf) {
            Ok(BytesOutcome::Applied { .. } | BytesOutcome::AlreadyPresent | BytesOutcome::Dropped) => {
                Ok(vec![])
            }
            Err(reason) => {
                self.missing_blobs.insert(image_id.into());
                Ok(vec![Output::Event(Event::FrameRejected { from: from.into(), reason })])
            }
        }
    }

    /// 冻结一个 origin(分叉):丢其 pending 与游标、报一次事件,此后其帧静默丢弃。
    /// 冻结本身仍是内存态(重连重检,既有语义);数量上界是新增的资源边界(§4):
    /// 超过 [`FROZEN_CAP`] → 进持久 poison-breaker(伪造 origin 制造分叉不再能无限撑)。
    fn freeze(
        &mut self,
        conn: &Connection,
        origin: &str,
        reason: String,
    ) -> Result<Vec<Output>, String> {
        self.slots.remove(origin); // 整槽释放(队列/挂起/want 节流一体,§5.1)。
        self.frozen.insert(origin.into(), reason.clone());
        let mut out = vec![Output::Event(Event::OriginFrozen { origin: origin.into(), reason })];
        if self.frozen.len() > FROZEN_CAP {
            out.extend(self.trip_breaker(
                conn,
                format!("冻结 origin 数超上限 {FROZEN_CAP}(分叉风暴/伪造 origin)"),
            )?);
        }
        Ok(out)
    }

    /// 持久隔离一个 origin(毒 op,§4):完整规范化 RemoteOp 落 sync_quarantine
    /// (单 op 超限只存 sha256 指纹,标「不可自动重验」),内存镜像同步;资源上界
    /// 到顶 → poison-breaker。error_stage 由重跑 shape 校验判定(shape 失败 =
    /// 'shape',shape 过而 apply 拒 = 'apply' 状态型),不解析错误字符串。
    fn quarantine_origin(
        &mut self,
        conn: &Connection,
        origin: &str,
        p: &PendingOp,
        reason: &str,
    ) -> Result<Vec<Output>, String> {
        let mut out = vec![];
        let stage = if replay::validate_op_shape(&p.op).is_err() { "shape" } else { "apply" };
        let reason_capped = truncate_utf8(reason, QUARANTINE_REASON_MAX);
        let blob = serde_json::to_vec(&p.op).map_err(|e| e.to_string())?;
        let (op_blob, op_sha): (Option<&[u8]>, Option<String>) =
            if blob.len() > QUARANTINE_MAX_OP_BYTES {
                use sha2::{Digest, Sha256};
                let sha: String =
                    Sha256::digest(&blob).iter().map(|b| format!("{b:02x}")).collect();
                (None, Some(sha)) // 超限:只存指纹 + 坐标,不可自动重验,要人工。
            } else {
                (Some(&blob), None)
            };
        // 资源上界(§4):行数 / 总字节任一到顶 → 本行照落(记录不该因满而丢),
        // breaker 置位 fail-closed——此后新 origin 一律拒,增长被闸死。
        let (rows, bytes): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(COALESCE(length(op_blob), 0) + length(reason)), 0) \
                 FROM sync_quarantine",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO sync_quarantine (origin, op_id, origin_seq, op_blob, op_sha256, \
             reason, error_stage, relay_from_first, relay_from_last, validator_ver, at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10) \
             ON CONFLICT(origin) DO UPDATE SET op_id = excluded.op_id, \
             origin_seq = excluded.origin_seq, op_blob = excluded.op_blob, \
             op_sha256 = excluded.op_sha256, reason = excluded.reason, \
             error_stage = excluded.error_stage, relay_from_last = excluded.relay_from_last, \
             validator_ver = excluded.validator_ver, at = excluded.at",
            rusqlite::params![
                origin,
                p.op.op_id,
                p.op.origin_seq,
                op_blob,
                op_sha,
                reason_capped,
                stage,
                p.relay_from,
                replay::VALIDATOR_VER,
                crate::repo::now_iso(),
            ],
        )
        .map_err(|e| e.to_string())?;
        self.quarantined.insert(origin.into());
        self.slots.remove(origin); // 整槽释放(§5.1)。
        out.push(Output::Event(Event::OriginQuarantined {
            origin: origin.into(),
            relay_from: p.relay_from.clone(),
            reason: reason_capped,
        }));
        if rows + 1 >= QUARANTINE_MAX_ROWS || bytes + blob.len() as i64 >= QUARANTINE_MAX_BYTES {
            out.extend(self.trip_breaker(conn, "隔离额度到顶(行数或总字节)".into())?);
        }
        Ok(out)
    }

    /// poison-breaker 置位(§4):落盘(sync_meta『poison_breaker』)+ 内存镜像 +
    /// 事件。幂等——已置位不重报。
    fn trip_breaker(&mut self, conn: &Connection, reason: String) -> Result<Vec<Output>, String> {
        if self.breaker.is_some() {
            return Ok(vec![]);
        }
        conn.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('poison_breaker', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&reason],
        )
        .map_err(|e| e.to_string())?;
        self.breaker = Some(reason.clone());
        Ok(vec![Output::Event(Event::PoisonBreakerTripped { reason })])
    }

    /// 升级重验状态机(§4):对 `validator_ver < 当前版本` 且有完整材料(op_blob)的
    /// 隔离行,以新校验器重跑——
    ///   * 仍 InvalidOp → 保留,只把 validator_ver 抬到当前(下次升级前不再重跑);
    ///   * 变 UnsupportedVocab → 清隔离、op 放回 pending(drain 会按型转普通版本挂起);
    ///   * shape 已接受 → 清隔离、op 放回 pending、发 want{watermark+1} 追回被丢弃的
    ///     后续帧;到 apply 位置仍状态型 Invalid → drain 里以新 validator_ver 重新隔离。
    /// op_blob 为 NULL 的行(超限指纹档)不可自动重验,原样保留等人工。
    /// 传输层在连接建立、on_connected 之后调用(要 &mut conn 走 drain)。
    pub fn reverify_quarantined(
        &mut self,
        conn: &mut Connection,
        clock: &mut Clock,
    ) -> Result<Vec<Output>, String> {
        let rows: Vec<(String, Vec<u8>)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT origin, op_blob FROM sync_quarantine \
                     WHERE validator_ver < ?1 AND op_blob IS NOT NULL",
                )
                .map_err(|e| e.to_string())?;
            let it = stmt
                .query_map([replay::VALIDATOR_VER], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?;
            it.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
        };
        let mut out = vec![];
        let mut restored = false;
        for (origin, blob) in rows {
            let Ok(op) = serde_json::from_slice::<RemoteOp>(&blob) else {
                // 材料本身坏了(不该发生):当「仍 Invalid」处置,抬版本保留。
                conn.execute(
                    "UPDATE sync_quarantine SET validator_ver = ?2 WHERE origin = ?1",
                    rusqlite::params![origin, replay::VALIDATOR_VER],
                )
                .map_err(|e| e.to_string())?;
                continue;
            };
            let relay_last: Option<String> = conn
                .query_row(
                    "SELECT relay_from_last FROM sync_quarantine WHERE origin = ?1",
                    [&origin],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            match replay::validate_op_shape(&op) {
                Err(replay::OpError::InvalidOp(_)) => {
                    conn.execute(
                        "UPDATE sync_quarantine SET validator_ver = ?2 WHERE origin = ?1",
                        rusqlite::params![origin, replay::VALIDATOR_VER],
                    )
                    .map_err(|e| e.to_string())?;
                }
                // shape 过(Ok)或转版本挂起(UnsupportedVocab):清隔离、op 归池——
                // 后续由 drain 按型处置(apply 层状态型仍可能重新隔离,带新版本号)。
                _ => {
                    conn.execute("DELETE FROM sync_quarantine WHERE origin = ?1", [&origin])
                        .map_err(|e| e.to_string())?;
                    self.quarantined.remove(&origin);
                    let need = watermark(conn, &origin)? + 1;
                    out.extend(self.slot_insert(
                        conn,
                        &origin,
                        PendingOp {
                            op,
                            relay_from: relay_last.unwrap_or_else(|| "unknown".into()),
                        },
                    )?);
                    restored = true;
                    // 追回隔离期间帧到即丢的后续 op(§4):谁有谁答;节流状态在槽内。
                    if let Some(slot) = self.slots.get_mut(&origin) {
                        slot.wanted = Some(need);
                    }
                    out.push(Output::Send {
                        to: BROADCAST.into(),
                        lane: Lane::Mail,
                        msg: Msg::Want { origin: origin.clone(), from_seq: need },
                    });
                }
            }
        }
        if restored {
            out.extend(self.drain(conn, clock)?);
        }
        Ok(out)
    }
}

// ---- 无状态的应答(读日志即答,不碰引擎内存态) --------------------------------------

/// 收到补洞请求:我有(≥ from_seq)就按序分块回给它;我也没有则静默(谁有谁答)。
fn on_want(
    conn: &Connection,
    from: &str,
    origin: &str,
    from_seq: i64,
) -> Result<Vec<Output>, String> {
    if from_seq < 1 {
        return Ok(vec![Output::Event(Event::FrameRejected {
            from: from.into(),
            reason: format!("want 的 from_seq 必须 ≥1,收到 {from_seq}"),
        })]);
    }
    let my = watermark(conn, origin)?;
    if my >= from_seq {
        ops_frames(conn, origin, from_seq, my, from)
    } else {
        Ok(vec![])
    }
}

/// 收到「谁有这张图」:行在 = 字节在(BLOB 入库),应答;没有则静默。
fn on_blob_want(conn: &Connection, from: &str, image_id: &str) -> Result<Vec<Output>, String> {
    let have: bool = conn
        .query_row("SELECT 1 FROM item_image WHERE id = ?1", [image_id], |_| Ok(()))
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    Ok(if have {
        vec![Output::Send {
            to: from.into(),
            lane: Lane::Mail,
            msg: Msg::BlobHave { image_id: image_id.into() },
        }]
    } else {
        vec![]
    })
}

/// 收到拉流请求:读字节切块直发(direct,回显对方的 transfer);行已不在(应答后
/// 被删的窗口)回 deny。一次性物化整串 chunk 帧(粘贴截图量级,MB 内)——真正的
/// 流控是 P2-g 传输层的活,sans-io 层不装。
fn on_blob_pull(
    conn: &Connection,
    from: &str,
    image_id: &str,
    transfer: &str,
) -> Result<Vec<Output>, String> {
    let data: Option<Vec<u8>> = conn
        .query_row("SELECT data FROM item_image WHERE id = ?1", [image_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(data) = data else {
        return Ok(vec![Output::Send {
            to: from.into(),
            lane: Lane::Direct,
            msg: Msg::BlobDeny { image_id: image_id.into(), transfer: transfer.into() },
        }]);
    };
    let chunks: Vec<&[u8]> = data.chunks(BLOB_CHUNK_BYTES).collect();
    let total = chunks.len(); // data 非空(0016 CHECK length>0),至少一块。
    Ok(chunks
        .into_iter()
        .enumerate()
        .map(|(i, chunk)| Output::Send {
            to: from.into(),
            lane: Lane::Direct,
            msg: Msg::BlobChunk {
                image_id: image_id.into(),
                transfer: transfer.into(),
                idx: i as u32,
                last: i + 1 == total,
                data: chunk.to_vec(),
            },
        })
        .collect())
}

// ---- 帧构造与校验 -------------------------------------------------------------------

/// 按 UTF-8 字符边界截断到 ≤ max 字节(隔离原因文本上限,§4)。
fn truncate_utf8(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.into();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].into()
}

/// 两枚 op 是否同一(六字段逐一比;payload 按 Value 语义)。「重复」的判定标准——
/// 只比 op_id 会把同 id 异内容当重传吞掉(codex 四轮)。
fn same_op(a: &RemoteOp, b: &RemoteOp) -> bool {
    a.op_id == b.op_id
        && a.hlc == b.hlc
        && a.entity == b.entity
        && a.entity_id == b.entity_id
        && a.kind == b.kind
        && a.origin_seq == b.origin_seq
        && a.payload == b.payload
}

/// 入池前硬校验(§5.3,评审①-H2):帧内全部 op 的 hlc 合法且设备后缀 == 帧 origin、
/// op_id 是合法 ULID 且帧内不重复、origin_seq ≥1 且严格升序、HLC 严格升序。帧 origin
/// 允许 ≠ 发送者(代补是设计),但 op 与 origin 的绑定不可破。任一不合 → Err(调用方
/// 整帧拒收)。
fn validate_frame(origin: &str, ops: &[RemoteOp]) -> Result<(), String> {
    if origin.is_empty() {
        return Err("ops 帧的 origin 为空".into());
    }
    if ops.is_empty() {
        return Err("ops 帧不含任何 op".into());
    }
    if ops.len() > MAX_OPS_PER_FRAME {
        return Err(format!("ops 帧超长:{} 条 > 上限 {MAX_OPS_PER_FRAME}", ops.len()));
    }
    let mut prev = 0i64;
    let mut prev_hlc = "";
    let mut seen_ids: HashSet<&str> = HashSet::new();
    for op in ops {
        let hlc = Hlc::parse(&op.hlc)?;
        if hlc.device_id != origin {
            return Err(format!(
                "op {} 的 hlc 设备后缀 {} != 帧 origin {origin}(op 与 origin 的绑定不可破)",
                op.op_id, hlc.device_id
            ));
        }
        if Ulid::from_string(&op.op_id).is_err() {
            return Err(format!("op_id 不是合法 ULID:{}", op.op_id));
        }
        if !seen_ids.insert(&op.op_id) {
            return Err(format!("op_id 帧内重复:{}", op.op_id));
        }
        if op.origin_seq <= prev {
            return Err(format!(
                "帧内 origin_seq 未严格升序:{} 之后是 {}",
                prev, op.origin_seq
            ));
        }
        // §5.1 不变量「per-origin 内 seq 序 == HLC 序」帧内即验(编码字典序 == 逻辑
        // 序)。少了它,同帧同 hlc 两 op 会在 append_remote 撞 UNIQUE 沦为永久挂起,
        // 分叉被误装成依赖问题(codex 二轮 #5)。
        if op.hlc.as_str() <= prev_hlc {
            return Err(format!("帧内 HLC 未严格升序:{prev_hlc} 之后是 {}", op.hlc));
        }
        prev = op.origin_seq;
        prev_hlc = &op.hlc;
    }
    Ok(())
}

/// 读日志构 ops 帧:origin 的 [from_seq, to_seq] 闭区间按 seq 升序,每帧
/// ≤ [`MAX_OPS_PER_FRAME`] 条 **且** ≤ [`MAX_OPS_FRAME_BYTES`] 编码字节(先到为准)。
fn ops_frames(
    conn: &Connection,
    origin: &str,
    from_seq: i64,
    to_seq: i64,
    to_device: &str,
) -> Result<Vec<Output>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq FROM oplog \
             WHERE origin = ?1 AND origin_seq BETWEEN ?2 AND ?3 ORDER BY origin_seq",
        )
        .map_err(|e| e.to_string())?;
    let ops: Vec<RemoteOp> = stmt
        .query_map((origin, from_seq, to_seq), |r| {
            Ok(RemoteOp {
                op_id: r.get(0)?,
                hlc: r.get(1)?,
                entity: r.get(2)?,
                entity_id: r.get(3)?,
                kind: r.get(4)?,
                payload: serde_json::from_str(&r.get::<_, String>(5)?)
                    .expect("oplog payload 必须是合法 JSON(0020 CHECK)"),
                origin_seq: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut frames: Vec<Output> = vec![];
    let mut cur: Vec<RemoteOp> = vec![];
    let mut cur_bytes = 0usize;
    let flush = |cur: &mut Vec<RemoteOp>, cur_bytes: &mut usize, frames: &mut Vec<Output>| {
        if !cur.is_empty() {
            frames.push(Output::Send {
                to: to_device.into(),
                lane: Lane::Mail,
                msg: Msg::Ops { origin: origin.into(), ops: std::mem::take(cur) },
            });
            *cur_bytes = 0;
        }
    };
    for op in ops {
        let sz = encoded_op_len(&op);
        if !cur.is_empty()
            && (cur.len() >= MAX_OPS_PER_FRAME || cur_bytes + sz > MAX_OPS_FRAME_BYTES)
        {
            flush(&mut cur, &mut cur_bytes, &mut frames);
        }
        cur_bytes += sz;
        cur.push(op);
    }
    flush(&mut cur, &mut cur_bytes, &mut frames);
    Ok(frames)
}

/// 单条 op 的 CBOR 编码字节数(切帧预算用;帧级固定开销见 MAX_OPS_FRAME_BYTES 注释)。
fn encoded_op_len(op: &RemoteOp) -> usize {
    let mut buf = Vec::new();
    ciborium::into_writer(op, &mut buf).expect("CBOR 编码进内存 Vec 无失败路径");
    buf.len()
}

// ---- 日志派生(水位与缺字节清单都不落存储,项目铁律「派生不存」) ---------------------

/// 单 origin 水位 = 本机日志该 origin 的 MAX(origin_seq)(严格连续应用保证无洞)。
fn watermark(conn: &Connection, origin: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(origin_seq), 0) FROM oplog WHERE origin = ?1",
        [origin],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// 全量水位向量(hello 的 payload)。BTreeMap 保证遍历序确定。
fn watermarks(conn: &Connection) -> Result<BTreeMap<String, i64>, String> {
    let mut stmt = conn
        .prepare("SELECT origin, MAX(origin_seq) FROM oplog GROUP BY origin")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// 缺字节的图 = 有 image_add op、无 image_tombstone、宿主 item 无 tombstone、行未建。
/// (add 曾被 ParentGone/Suppressed 记账的死图被两个 NOT EXISTS 排除;0020 前的遗产图
/// 无 add op,不进清单——旧图只经引导快照到达,§5.4。)
fn derive_missing_blobs(conn: &Connection) -> Result<HashSet<String>, String> {
    missing_blobs_where(conn, None)
}

/// 缺字节判据的唯一 SQL(全库 / 单条目两个投影共用,绝不另写一份口径——
/// cross-space-move M3 的「三套正则漂移」教训同款纪律)。
fn missing_blobs_where(conn: &Connection, item: Option<&str>) -> Result<HashSet<String>, String> {
    let base = "SELECT a.entity_id FROM oplog a \
         WHERE a.entity = 'image' AND a.kind = 'image_add' \
           AND NOT EXISTS (SELECT 1 FROM oplog t WHERE t.entity = 'image' \
                AND t.entity_id = a.entity_id AND t.kind = 'image_tombstone') \
           AND NOT EXISTS (SELECT 1 FROM oplog p WHERE p.entity = 'item' \
                AND p.entity_id = json_extract(a.payload, '$.item_id') AND p.kind = 'tombstone') \
           AND NOT EXISTS (SELECT 1 FROM item_image r WHERE r.id = a.entity_id)";
    let rows: rusqlite::Result<HashSet<String>> = match item {
        None => {
            let mut stmt = conn.prepare(base).map_err(|e| e.to_string())?;
            let it = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            it.collect()
        }
        Some(item_id) => {
            let sql = format!("{base} AND json_extract(a.payload, '$.item_id') = ?1");
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let it =
                stmt.query_map([item_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            it.collect()
        }
    };
    rows.map_err(|e| e.to_string())
}

/// 还缺字节的图数——`derive_missing_blobs` 的计数投影。
/// 供 transport 转公开给壳层(117:安卓「全部同步」的追赶判定,codex H2)。
pub(crate) fn pending_blob_count(conn: &Connection) -> Result<i64, String> {
    derive_missing_blobs(conn).map(|s| s.len() as i64)
}

/// 单条目还缺字节的图数(同一份判据 SQL 按 item 过滤)。跨空间移动的「活图全物化」
/// 预检用(cross-space-move §2.3①:有 image_add、无 tombstone、宿主活着、行未建
/// = 活但未物化,导出前 / 删源前都要查——漏搬即永久删)。
pub(crate) fn missing_blob_count_for_item(conn: &Connection, item_id: &str) -> Result<i64, String> {
    missing_blobs_where(conn, Some(item_id)).map(|s| s.len() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, images, notes};
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn fresh() -> (Connection, Clock, Engine) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open migrated db");
        let clock = Clock::load(&conn).expect("load clock");
        let engine = Engine::new(&conn, BlobPolicy::Full).expect("engine");
        (conn, clock, engine)
    }

    /// 手搓一枚异设备 op(engine 测试只关心编排机械,payload 用最简的 topic create)。
    fn topic_op(device: &str, wall_ms: u64, seq: i64, topic_id: &str) -> RemoteOp {
        RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: Hlc { wall_ms, counter: 0, device_id: device.into() }.encode(),
            entity: "topic".into(),
            entity_id: topic_id.into(),
            kind: "create".into(),
            payload: json!({"title": format!("t-{seq}"), "created_at": "2026-07-08T00:00:00Z"}),
            origin_seq: seq,
        }
    }

    fn sends(outs: &[Output]) -> Vec<&Msg> {
        outs.iter()
            .filter_map(|o| match o {
                Output::Send { msg, .. } => Some(msg),
                _ => None,
            })
            .collect()
    }

    fn frame_rejected(outs: &[Output]) -> bool {
        outs.iter().any(|o| matches!(o, Output::Event(Event::FrameRejected { .. })))
    }

    const DEV: &str = "PEERDEV0000000000000000001";

    #[test]
    fn hard_validation_rejects_whole_frame_before_pooling() {
        let (mut conn, mut clock, mut eng) = fresh();
        // hlc 设备后缀 ≠ 帧 origin:整帧拒收,pending 不长(评审①-H2)。
        let op = topic_op("OTHERDEV", 1_000, 1, "01TOPICAAAAAAAAAAAAAAAAAA1");
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
            .unwrap();
        assert!(frame_rejected(&outs));
        assert!(eng.slots.is_empty());
        // 帧内 seq 非严格升序:同拒。
        let ops = vec![
            topic_op(DEV, 1_000, 2, "01TOPICAAAAAAAAAAAAAAAAAA1"),
            topic_op(DEV, 1_001, 2, "01TOPICAAAAAAAAAAAAAAAAAA2"),
        ];
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
            .unwrap();
        assert!(frame_rejected(&outs));
        assert!(eng.slots.is_empty());
        // 帧内 HLC 非严格升序(seq 升 hlc 不升):违反 §5.1「seq 序 == HLC 序」,同拒
        // ——放进来会在记账时撞 hlc UNIQUE 沦为永久挂起,分叉被误装成依赖问题。
        let ops = vec![
            topic_op(DEV, 2_000, 1, "01TOPICAAAAAAAAAAAAAAAAAA3"),
            topic_op(DEV, 2_000, 2, "01TOPICAAAAAAAAAAAAAAAAAA4"), // 同 wall_ms 同 counter=同 hlc
        ];
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
            .unwrap();
        assert!(frame_rejected(&outs));
        assert!(eng.slots.is_empty());
        // 好帧照常入池应用(整帧拒收不留后遗症)。
        let op = topic_op(DEV, 1_000, 1, "01TOPICAAAAAAAAAAAAAAAAAA1");
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
            .unwrap();
        assert!(!frame_rejected(&outs));
        assert_eq!(watermark(&conn, DEV).unwrap(), 1);
    }

    #[test]
    fn gap_holds_the_queue_emits_want_and_heals_on_backfill() {
        let (mut conn, mut clock, mut eng) = fresh();
        let op1 = topic_op(DEV, 1_001, 1, "01TOPICBBBBBBBBBBBBBBBBBB1");
        let op2 = topic_op(DEV, 1_002, 2, "01TOPICBBBBBBBBBBBBBBBBBB2");
        let outs = eng
            .on_msg(
                &mut conn,
                &mut clock,
                DEV,
                Msg::Ops { origin: DEV.into(), ops: vec![op2.clone()] },
            )
            .unwrap();
        // 洞在 1:不应用、广播 want{from_seq:1}。
        assert_eq!(watermark(&conn, DEV).unwrap(), 0, "水位不过缺口");
        let want = sends(&outs)
            .into_iter()
            .find_map(|m| match m {
                Msg::Want { origin, from_seq } => Some((origin.clone(), *from_seq)),
                _ => None,
            })
            .expect("必须发 want 补洞");
        assert_eq!(want, (DEV.to_string(), 1));
        // 同一枚 op 重复到达(多端同答 hello 的已知噪音):丢弃,同缺口 want 不重发。
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
            .unwrap();
        assert!(!frame_rejected(&outs) && sends(&outs).is_empty(), "{outs:?}");
        // 缺口补上:连带 pending 里的 2 一起落地。
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op1] })
            .unwrap();
        assert!(!frame_rejected(&outs));
        assert_eq!(watermark(&conn, DEV).unwrap(), 2, "补洞后连续应用到队尾");
        assert!(eng.slots.get(DEV).is_none_or(|s| s.queue.is_empty()));
    }

    #[test]
    fn origin_forks_freeze_and_silence_the_origin() {
        let (mut conn, mut clock, mut eng) = fresh();
        let op1 = topic_op(DEV, 1_000, 1, "01TOPICCCCCCCCCCCCCCCCCC01");
        eng.on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op1] })
            .unwrap();
        // 同 (origin, seq=1) 另一枚 op_id:分叉,冻结。
        let fork = topic_op(DEV, 9_999, 1, "01TOPICCCCCCCCCCCCCCCCCC02");
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![fork] })
            .unwrap();
        assert!(outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))));
        // 冻结后:该 origin 的合法新帧也静默丢弃。
        let op2 = topic_op(DEV, 1_002, 2, "01TOPICCCCCCCCCCCCCCCCCC03");
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
            .unwrap();
        assert!(outs.is_empty());
        assert_eq!(watermark(&conn, DEV).unwrap(), 1);
    }

    #[test]
    fn echo_of_unknown_self_ops_freezes_self_origin() {
        let (mut conn, mut clock, mut eng) = fresh();
        let me = clock.device_id().to_string();
        // 别人手里有「我」的 op 而我不记得 = 本机曾被回滚/克隆(§11)。
        let ghost = topic_op(&me, 9_999, 1, "01TOPICDDDDDDDDDDDDDDDDDD1");
        let outs = eng
            .on_msg(&mut conn, &mut clock, "OTHER", Msg::Ops { origin: me.clone(), ops: vec![ghost] })
            .unwrap();
        assert!(outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))));
    }

    #[test]
    fn echo_of_conflicting_self_op_at_spent_seq_freezes_too() {
        // 克隆库分叉的另一半脸(codex 二轮 #1):双方各自花掉了同一段序号——对端持有
        // 的「我的 seq 1」是另一枚 op。只查「seq > 水位」会静默丢掉它,永不报警。
        let (mut conn, mut clock, mut eng) = fresh();
        notes::capture(&mut conn, &mut clock, "本机真实写过一条").unwrap();
        let me = clock.device_id().to_string();
        assert!(watermark(&conn, &me).unwrap() >= 1);
        let imposter = RemoteOp {
            op_id: Ulid::new().to_string(), // ≠ 本机 seq 1 的真 op_id
            hlc: Hlc { wall_ms: 9_999, counter: 0, device_id: me.clone() }.encode(),
            entity: "topic".into(),
            entity_id: "01TOPICFFFFFFFFFFFFFFFFFF1".into(),
            kind: "create".into(),
            payload: json!({"title": "冒名", "created_at": "2026-07-08T00:00:00Z"}),
            origin_seq: 1,
        };
        let outs = eng
            .on_msg(&mut conn, &mut clock, "OTHER", Msg::Ops { origin: me.clone(), ops: vec![imposter] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
            "已花序号上的异 op_id 同样是本机分叉,必须冻结:{outs:?}"
        );
    }

    #[test]
    fn same_op_id_with_different_content_freezes_not_swallowed() {
        // codex 四轮:重传判定必须比完整 op。同 op_id 同坐标但 payload 不同 = 两个
        // 「身份相同」的不同事实——当幂等吞掉的话两端水位都齐、永不再修,静默分叉。
        let (mut conn, mut clock, mut eng) = fresh();
        let real = topic_op(DEV, 1_000, 1, "01TOPICI000000000000000001");
        eng.on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![real.clone()] })
            .unwrap();
        assert_eq!(watermark(&conn, DEV).unwrap(), 1);
        let mut tampered = real.clone();
        tampered.payload = json!({"title": "换了内容", "created_at": "2026-07-08T00:00:00Z"});
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![tampered] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
            "同 op_id 异内容 = 分叉,不许当重传吞:{outs:?}"
        );
        // 真正的重传(逐字段全同)照旧静默吸收。
        let (mut c2, mut k2, mut e2) = fresh();
        e2.on_msg(&mut c2, &mut k2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![real.clone()] })
            .unwrap();
        let outs = e2
            .on_msg(&mut c2, &mut k2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![real] })
            .unwrap();
        assert!(
            !outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
            "全同重传不误报分叉:{outs:?}"
        );
    }

    #[test]
    fn cross_frame_seq_hlc_order_breach_freezes() {
        // codex 三轮 High:帧内校验挡不住跨帧交错。seq2(hlc 小)先入池,seq1(hlc 大)
        // 后到——若照单应用,本地日志双序矛盾(seq 序 ≠ hlc 序),将来代补给第三端被
        // 对方帧内校验永久拒帧。入池时按前驱/后继 hlc 开区间拦下,冻结该 origin。
        let (mut conn, mut clock, mut eng) = fresh();
        let op2 = topic_op(DEV, 2_000, 2, "01TOPICG000000000000000002");
        eng.on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
            .unwrap();
        let op1_late_hlc = topic_op(DEV, 9_000, 1, "01TOPICG000000000000000001"); // hlc > seq2 的
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op1_late_hlc] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
            "跨帧双序矛盾必须冻结:{outs:?}"
        );
        assert_eq!(watermark(&conn, DEV).unwrap(), 0, "矛盾 op 一条都不落地");
        // 对照组:与已应用日志衔接的下界。正常应用 seq1 后,伪造「seq2 但 hlc 早于
        // seq1」的帧 → 前驱(日志 MAX hlc)拦下。
        let (mut conn2, mut clock2, mut eng2) = fresh();
        let a1 = topic_op(DEV, 5_000, 1, "01TOPICH000000000000000001");
        eng2.on_msg(&mut conn2, &mut clock2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![a1] })
            .unwrap();
        let a2_early_hlc = topic_op(DEV, 1_000, 2, "01TOPICH000000000000000002");
        let outs = eng2
            .on_msg(&mut conn2, &mut clock2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![a2_early_hlc] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
            "与已应用日志的双序矛盾同样冻结:{outs:?}"
        );
        assert_eq!(watermark(&conn2, DEV).unwrap(), 1);
    }

    #[test]
    fn suspended_head_retries_after_any_progress() {
        let (mut conn, mut clock, mut eng) = fresh();
        // origin B 的 link_add 依赖 origin A 的 item+topic(跨 origin 因果):B 先到
        // 挂起,A 到齐后 drain 不动点把 B 解开。
        let (mut remote, mut rclock) = {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir()
                .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
            let _ = std::fs::remove_file(&path);
            let conn = db::open(&path).expect("open");
            let clock = Clock::load(&conn).expect("clock");
            (conn, clock)
        };
        let idea = notes::capture(&mut remote, &mut rclock, "被引用的条目").unwrap();
        let topic = notes::create_topic(&mut remote, &mut rclock, "被引用的标签").unwrap();
        notes::file_to_topic(&mut remote, &mut rclock, &idea, Some(&topic), None).unwrap();
        let a = rclock.device_id().to_string();
        let a_ops: Vec<RemoteOp> = {
            let mut stmt = remote
                .prepare(
                    "SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq \
                     FROM oplog ORDER BY origin_seq",
                )
                .unwrap();
            let rows = stmt
                .query_map([], |r| {
                    Ok(RemoteOp {
                        op_id: r.get(0)?,
                        hlc: r.get(1)?,
                        entity: r.get(2)?,
                        entity_id: r.get(3)?,
                        kind: r.get(4)?,
                        payload: serde_json::from_str(&r.get::<_, String>(5)?).unwrap(),
                        origin_seq: r.get(6)?,
                    })
                })
                .unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        // B(第三设备)转述 A 的 link op:把它包装成 B 自己的?不行——op 的 hlc 内嵌 A。
        // 真正的跨 origin 场景:B 的 op 引用 A 的实体。手搓 B 的 link_add 指向 A 的条目。
        let b_link = RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: Hlc { wall_ms: 9_999_999, counter: 0, device_id: "BDEV0000000000000000000002".into() }.encode(),
            entity: "link".into(),
            entity_id: format!("{idea}:{topic}"),
            kind: "link_add".into(),
            payload: json!({"item_id": idea, "topic_id": topic}),
            origin_seq: 1,
        };
        let outs = eng
            .on_msg(
                &mut conn,
                &mut clock,
                "BDEVICE",
                Msg::Ops { origin: "BDEV0000000000000000000002".into(), ops: vec![b_link] },
            )
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::OriginSuspended { .. }))),
            "依赖未到:B 队头挂起"
        );
        assert_eq!(watermark(&conn, "BDEV0000000000000000000002").unwrap(), 0, "挂起不记账不推水位");
        // A 的历史到齐:drain 不动点连带把 B 的挂起头解开。
        let outs = eng
            .on_msg(&mut conn, &mut clock, "ADEV", Msg::Ops { origin: a.clone(), ops: a_ops })
            .unwrap();
        assert!(!frame_rejected(&outs));
        assert_eq!(watermark(&conn, "BDEV0000000000000000000002").unwrap(), 1, "挂起头重试落地");
        assert!(eng.slots.is_empty(), "终局槽必空(队列/挂起随槽释放)");
        let linked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM item_topic WHERE item_id = ?1 AND topic_id = ?2",
                (&idea, &topic),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(linked, 1, "link 行按 OR-set 落地");
    }

    #[test]
    fn pending_overflow_drops_pool_but_not_watermark() {
        let (mut conn, mut clock, mut eng) = fresh();
        eng.pending_cap = 3;
        // 洞在 1,seq 2..=6 一帧到达攒池超限 → 该 origin pending 全弃,水位纹丝不动;
        // 丢弃当场必须发 want(pending 没了,长连接下没有别的重取信号,codex 二轮 #3)。
        let ops: Vec<RemoteOp> = (2..=6)
            .map(|seq| topic_op(DEV, 1_000 + seq as u64, seq, &format!("01TOPICE{seq:018}")))
            .collect();
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
            .unwrap();
        assert!(eng.slots.get(DEV).is_none(), "超限丢弃整个 origin 的槽");
        assert!(
            sends(&outs)
                .iter()
                .any(|m| matches!(m, Msg::Want { origin, from_seq: 1 } if origin == DEV)),
            "丢弃即刻发 want{{from_seq:1}}:{outs:?}"
        );
        assert_eq!(watermark(&conn, DEV).unwrap(), 0, "水位不动 = 没丢数据");
        // 按序重取(hello/want 的效果):1..=6 全部落地。
        let ops: Vec<RemoteOp> = (1..=6)
            .map(|seq| topic_op(DEV, 1_000 + seq as u64, seq, &format!("01TOPICE{seq:018}")))
            .collect();
        eng.on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
            .unwrap();
        assert_eq!(watermark(&conn, DEV).unwrap(), 6);
    }

    #[test]
    fn pending_overflow_by_bytes_drops_pool_too() {
        // 评审 P2-g 轮 M:条数上限拦不住大 payload——字节维度同一套「丢弃+want、
        // 水位不动」处置。洞在 1,两条 ~1KB 的 op 滞留即超 1KB 上限。
        let (mut conn, mut clock, mut eng) = fresh();
        eng.pending_bytes_cap = 1024;
        let fat = |seq: i64| {
            let mut op = topic_op(DEV, 1_000 + seq as u64, seq, &format!("01TOPICJ{seq:018}"));
            op.payload = json!({"title": "大".repeat(400), "created_at": "2026-07-09T00:00:00Z"});
            op
        };
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![fat(2), fat(3)] })
            .unwrap();
        assert!(eng.slots.get(DEV).is_none(), "超字节上限丢弃整个 origin 的槽");
        assert!(
            sends(&outs)
                .iter()
                .any(|m| matches!(m, Msg::Want { origin, from_seq: 1 } if origin == DEV)),
            "丢弃即刻发 want:{outs:?}"
        );
        assert_eq!(watermark(&conn, DEV).unwrap(), 0, "水位不动 = 没丢数据");
    }

    #[test]
    fn hello_answers_with_ops_the_peer_lacks() {
        let (mut conn, mut clock, mut eng) = fresh();
        let idea = notes::capture(&mut conn, &mut clock, "本机的历史").unwrap();
        notes::edit(&mut conn, &mut clock, &idea, "改一笔").unwrap();
        // 对端 hello:水位空 → 「我高你低」,回我全量(单帧)。
        let outs = eng
            .on_msg(&mut conn, &mut clock, "PEERX", Msg::Hello { watermarks: BTreeMap::new() })
            .unwrap();
        let me = clock.device_id();
        let ops_frame = sends(&outs)
            .into_iter()
            .find_map(|m| match m {
                Msg::Ops { origin, ops } if origin == me => Some(ops.len()),
                _ => None,
            })
            .expect("hello 必须换来补给帧");
        assert_eq!(ops_frame as i64, watermark(&conn, me).unwrap());
        // 对端已齐平:不再回帧。
        let mut theirs = BTreeMap::new();
        theirs.insert(me.to_string(), watermark(&conn, me).unwrap());
        let outs = eng
            .on_msg(&mut conn, &mut clock, "PEERX", Msg::Hello { watermarks: theirs })
            .unwrap();
        assert!(sends(&outs).iter().all(|m| !matches!(m, Msg::Ops { .. })));
    }

    #[test]
    fn blob_sidechannel_pulls_bytes_and_builds_the_row() {
        // A 端真 attach 一张图;B 端收 op(行不建)→ want → A have → B pull → A chunk
        // → B 验货建行,字节逐位相等(§5.4 全链路,72 契约建行)。
        let (mut a_conn, mut a_clock, mut a_eng) = fresh();
        let (mut b_conn, mut b_clock, mut b_eng) = fresh();
        let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
        let bytes: Vec<u8> = (0u8..200).collect();
        let (img, _seq) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
        let a_id = a_clock.device_id().to_string();

        // B 收 A 全量 op(借 hello 机制拿帧,顺带测追赶)。
        let frames = a_eng
            .on_msg(&mut a_conn, &mut a_clock, "B", Msg::Hello { watermarks: BTreeMap::new() })
            .unwrap();
        let mut b_out = vec![];
        for f in frames {
            if let Output::Send { msg, .. } = f {
                b_out.extend(b_eng.on_msg(&mut b_conn, &mut b_clock, "A", msg).unwrap());
            }
        }
        let row_at_b: i64 =
            b_conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(row_at_b, 0, "image_add 只推水位不建行(字节未到)");
        let want = b_out
            .iter()
            .find_map(|o| match o {
                Output::Send { msg: Msg::BlobWant { image_id }, .. } => Some(image_id.clone()),
                _ => None,
            })
            .expect("B 必须广播 blob_want");
        assert_eq!(want, img);

        // A 应答 have → B 发起 pull → A 切块 → B 攒块建行。
        let haves = a_eng.on_msg(&mut a_conn, &mut a_clock, &b_clock.device_id().to_string(), Msg::BlobWant { image_id: img.clone() }).unwrap();
        let have_msg = match &haves[0] {
            Output::Send { msg, .. } => msg.clone(),
            other => panic!("期待 have,得到 {other:?}"),
        };
        let pulls = b_eng.on_msg(&mut b_conn, &mut b_clock, &a_id, have_msg).unwrap();
        let pull_msg = match &pulls[0] {
            Output::Send { msg, lane, .. } => {
                assert_eq!(*lane, Lane::Direct, "拉流走 direct");
                msg.clone()
            }
            other => panic!("期待 pull,得到 {other:?}"),
        };
        let chunks = a_eng.on_msg(&mut a_conn, &mut a_clock, &b_clock.device_id().to_string(), pull_msg).unwrap();
        for c in chunks {
            if let Output::Send { msg, .. } = c {
                let outs = b_eng.on_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
                assert!(!frame_rejected(&outs), "字节验货必须过(长度+sha256)");
            }
        }
        let (got, seq): (Vec<u8>, i64) = b_conn
            .query_row("SELECT data, seq FROM item_image WHERE id = ?1", [&img], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(got, bytes, "字节逐位相等");
        assert_eq!(seq, 1, "行 seq 取 reconcile 重算值");
        assert!(b_eng.missing_blobs.is_empty());

        // deny 路:行删掉后再被 pull,应答 deny(回显 transfer);拉方回 missing 清单。
        images::remove(&mut a_conn, &mut a_clock, &img).unwrap();
        let denies = a_eng
            .on_msg(
                &mut a_conn,
                &mut a_clock,
                "B",
                Msg::BlobPull { image_id: img.clone(), transfer: "01TRANSFER000000000000000X".into() },
            )
            .unwrap();
        assert!(matches!(
            &denies[0],
            Output::Send { msg: Msg::BlobDeny { .. }, lane: Lane::Direct, .. }
        ));
    }

    #[test]
    fn blob_chunks_reject_stale_transfer_and_cap_overrun() {
        // codex 二轮 #4:上一次拉流的残帧靠 transfer 区分;攒块超过 add 声明的字节数
        // 立即作废(对端无尽 last=false 块撑不爆内存)。
        let (mut a_conn, mut a_clock, _a_eng) = fresh();
        let (mut b_conn, mut b_clock, mut b_eng) = fresh();
        let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
        let bytes = [7u8; 10];
        let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
        let a_id = a_clock.device_id().to_string();
        // B 拿到 A 的 op(借帧构造),进入缺字节态,再收 have 进入拉流。
        let frames = ops_frames(&a_conn, &a_id, 1, watermark(&a_conn, &a_id).unwrap(), "B").unwrap();
        for f in frames {
            if let Output::Send { msg, .. } = f {
                b_eng.on_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
            }
        }
        b_eng.on_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
        let live_transfer = b_eng.pulling[&img].transfer.clone();
        // 残帧(错 transfer):静默丢,进行中的拉流不受伤。
        let outs = b_eng
            .on_msg(
                &mut b_conn,
                &mut b_clock,
                &a_id,
                Msg::BlobChunk {
                    image_id: img.clone(),
                    transfer: "01STALETRANSFER0000000000X".into(),
                    idx: 0,
                    last: false,
                    data: vec![1, 2, 3],
                },
            )
            .unwrap();
        assert!(outs.is_empty() && b_eng.pulling.contains_key(&img), "残帧不打断进行中的拉流");
        // 超量块(> add 声明的 10 字节):拉流作废,图退回缺字节清单。
        b_eng
            .on_msg(
                &mut b_conn,
                &mut b_clock,
                &a_id,
                Msg::BlobChunk {
                    image_id: img.clone(),
                    transfer: live_transfer,
                    idx: 0,
                    last: false,
                    data: vec![0u8; 11],
                },
            )
            .unwrap();
        assert!(!b_eng.pulling.contains_key(&img) && b_eng.missing_blobs.contains(&img),
            "超量攒块 = 作废回清单");
    }

    #[test]
    fn stale_pull_expires_reshuns_and_rerequests() {
        // M1:对端应了 BlobHave 却不发块(恶意或 bug)——连续心跳后作废本次拉流、回缺
        // 字节清单重发 want,并避开这个沉默来源,让别的设备应答。
        let (mut a_conn, mut a_clock, _a) = fresh();
        let (mut b_conn, mut b_clock, mut b) = fresh();
        let item = notes::capture(&mut a_conn, &mut a_clock, "带图").unwrap();
        let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &[9u8; 10], "image/png").unwrap();
        let a_id = a_clock.device_id().to_string();
        // B 拿到 A 的 op → 进缺字节态;A(沉默源)应 have → B 拉流。
        let frames = ops_frames(&a_conn, &a_id, 1, watermark(&a_conn, &a_id).unwrap(), "B").unwrap();
        for f in frames {
            if let Output::Send { msg, .. } = f {
                b.on_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
            }
        }
        b.on_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
        assert!(b.pulling.contains_key(&img), "have 后进入拉流");
        // 沉默:连续心跳到阈值,作废回清单 + 重发 want。
        let mut wants = vec![];
        for _ in 0..PULL_STALE_TICKS {
            wants = b.on_tick();
        }
        assert!(!b.pulling.contains_key(&img) && b.missing_blobs.contains(&img), "超时作废回清单");
        assert!(
            wants.iter().any(|o| matches!(o, Output::Send { msg: Msg::BlobWant { image_id }, .. } if image_id == &img)),
            "作废时当场重发 want"
        );
        // 同一沉默来源(A)再应 have:被避开,不再拉它。
        let outs = b.on_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
        assert!(outs.is_empty() && !b.pulling.contains_key(&img), "避开刚超时的来源");
        // 别的来源(C)应 have:正常拉流。
        let _ = b.on_msg(&mut b_conn, &mut b_clock, "OTHERPEERDEVICE00000000000", Msg::BlobHave { image_id: img.clone() }).unwrap();
        assert!(b.pulling.contains_key(&img), "换来源可拉");
        // 重连是新会话:避开名单清零(人人再给一次机会)。
        b.on_connected(&b_conn).unwrap();
        assert!(b.blob_shunned.is_empty(), "on_connected 清避开名单");
    }

    #[test]
    fn space_op_applied_emits_space_name_changed_and_stale_does_not() {
        // space-name-sync-plan §4.7 三入口之 live replay:Applied 才发专用事件;
        // LwwStale(名字没变)不惊扰壳。
        let (mut conn, mut clock, mut eng) = fresh();
        let mk_space = |dev: &str, wall: u64, seq: i64, value: serde_json::Value| RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: Hlc { wall_ms: wall, counter: 0, device_id: dev.into() }.encode(),
            entity: "space".into(),
            entity_id: "profile".into(),
            kind: "set_field".into(),
            payload: json!({"field": "name", "value": value}),
            origin_seq: seq,
        };
        let op = mk_space(DEV, 2_000, 1, json!("新名"));
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::SpaceNameChanged))),
            "space op 落地必须发专用事件:{outs:?}"
        );
        // 另一 origin 的更低 HLC 迟到写:LwwStale 只记账,不发事件。
        let other = "BREMTE00000000000000000001";
        let stale = mk_space(other, 1_000, 1, json!("旧名"));
        let outs2 = eng
            .on_msg(&mut conn, &mut clock, other, Msg::Ops { origin: other.into(), ops: vec![stale] })
            .unwrap();
        assert!(
            !outs2.iter().any(|o| matches!(o, Output::Event(Event::SpaceNameChanged))),
            "LwwStale 名字没变,不该惊扰壳:{outs2:?}"
        );
        let name: Option<String> = conn
            .query_row("SELECT name FROM space_profile WHERE key = 'profile'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name.as_deref(), Some("新名"));
    }

    #[test]
    fn clock_skew_warns_once_per_session() {
        // L1:远端 op 的 HLC 墙钟比本机快 >24h,报一次时钟偏斜(不拒帧)。
        let (mut conn, mut clock, mut eng) = fresh();
        let future = crate::clock::wall_now_ms() + 48 * 60 * 60 * 1000; // 快 48h
        let op = topic_op(DEV, future, 1, "01SKEWTOPICAAAAAAAAAAAAAAA");
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
            .unwrap();
        let ahead = outs
            .iter()
            .find_map(|o| match o {
                Output::Event(Event::ClockSkew { ahead_hours }) => Some(*ahead_hours),
                _ => None,
            })
            .expect("远端时钟快 48h 必须报偏斜");
        assert!((46..=49).contains(&ahead), "偏斜小时数约 48,得 {ahead}");
        assert!(!frame_rejected(&outs), "偏斜只提示不拒帧");
        // 第二帧(仍是未来时钟)不再重报——每会话一次。
        let op2 = topic_op(DEV, future + 1000, 2, "01SKEWTOPICBBBBBBBBBBBBBBB");
        let outs2 = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
            .unwrap();
        assert!(
            !outs2.iter().any(|o| matches!(o, Output::Event(Event::ClockSkew { .. }))),
            "时钟偏斜每会话只报一次"
        );
    }

    #[test]
    fn local_correction_op_from_replay_is_pushed_immediately() {
        // codex 二轮 #6:「图N」翻案的正文修正走真 set_field 发射(replay.rs)——它是
        // 本机新 op,必须随本次 on_msg 立即广播,不许等下一条本地命令或重连。
        let (mut conn, mut clock, mut eng) = fresh();
        let item = notes::capture(&mut conn, &mut clock, "初稿").unwrap();
        images::attach(&mut conn, &mut clock, &item, &[0xA], "image/png").unwrap();
        notes::edit(&mut conn, &mut clock, &item, "定稿:见图1").unwrap(); // content 胜者=本机,晚于贴图
        let me = clock.device_id().to_string();
        // 远端更早(hlc 更小)的并发图1 到达:本机图顺延成图2,正文修正为「见图2」。
        let add = RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: Hlc { wall_ms: 1_000, counter: 0, device_id: "AREMTE00000000000000000001".into() }.encode(),
            entity: "image".into(),
            entity_id: "01REMOTEIMGENG00000000000X".into(),
            kind: "image_add".into(),
            payload: json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8,
                "sha256": "0000000000000000000000000000000000000000000000000000000000000000"}),
            origin_seq: 1,
        };
        let outs = eng
            .on_msg(&mut conn, &mut clock, "AREMOTE", Msg::Ops { origin: "AREMTE00000000000000000001".into(), ops: vec![add] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::ImagesRenumbered { content_rewritten: true, .. }))),
            "翻案 + 正文修正:{outs:?}"
        );
        let pushed_own_op = sends(&outs).iter().any(|m| matches!(m, Msg::Ops { origin, .. } if origin == &me));
        assert!(pushed_own_op, "回放中发射的修正 op 必须当场广播:{outs:?}");
        let content: String =
            conn.query_row("SELECT content FROM items WHERE id = ?1", [&item], |r| r.get(0)).unwrap();
        assert_eq!(content, "定稿:见图2");
    }

    #[test]
    fn ops_frames_split_by_encoded_bytes_and_keep_order() {
        // §5「≤500 条或 256 KiB 先到为准」的字节半(P2-g 补齐):三条 ~150 KiB 的
        // set_field op 两两同帧必超预算 → 一条一帧;小 op 照旧并帧。顺序与完整性不变。
        let (conn, _clock, _eng) = fresh();
        let big = "长".repeat(50_000); // ~150 KB UTF-8
        for seq in 1..=3i64 {
            conn.execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES (?1, ?2, 'item', '01ITEMBYTES00000000000000X', 'set_field', ?3, ?4)",
                (
                    Ulid::new().to_string(),
                    Hlc { wall_ms: 1_000 + seq as u64, counter: 0, device_id: DEV.into() }.encode(),
                    serde_json::to_string(&json!({"field": "content", "value": big})).unwrap(),
                    seq,
                ),
            )
            .unwrap();
        }
        let frames = ops_frames(&conn, DEV, 1, 3, "X").unwrap();
        assert_eq!(frames.len(), 3, "大 op 按编码字节独立成帧");
        let mut seen = vec![];
        for f in &frames {
            let Output::Send { msg: Msg::Ops { ops, .. }, .. } = f else { panic!("必须是 ops 帧") };
            assert!(ops.iter().map(encoded_op_len).sum::<usize>() <= MAX_OPS_FRAME_BYTES);
            seen.extend(ops.iter().map(|o| o.origin_seq));
        }
        assert_eq!(seen, vec![1, 2, 3], "切帧不重排不丢条");
        // 对照:小 op 不触字节线,仍按条数并帧。
        let (mut conn2, mut clock2, _e2) = fresh();
        notes::capture(&mut conn2, &mut clock2, "小条目甲").unwrap();
        notes::capture(&mut conn2, &mut clock2, "小条目乙").unwrap();
        let me = clock2.device_id().to_string();
        let max = watermark(&conn2, &me).unwrap();
        let frames = ops_frames(&conn2, &me, 1, max, "X").unwrap();
        assert_eq!(frames.len(), 1, "小 op 仍并成单帧");
    }

    /// 把 A 库的全量 op 借帧喂给引擎(测试小工具:hello 机制的手动形)。
    fn feed_all_ops(
        src: &Connection,
        src_dev: &str,
        conn: &mut Connection,
        clock: &mut Clock,
        eng: &mut Engine,
    ) -> Vec<Output> {
        let frames = ops_frames(src, src_dev, 1, watermark(src, src_dev).unwrap(), "X").unwrap();
        let mut outs = vec![];
        for f in frames {
            if let Output::Send { msg, .. } = f {
                outs.extend(eng.on_msg(conn, clock, src_dev, msg).unwrap());
            }
        }
        outs
    }

    fn any_blob_want(outs: &[Output]) -> bool {
        outs.iter().any(|o| {
            matches!(o, Output::Send { msg: Msg::BlobWant { .. } | Msg::BlobPull { .. }, .. })
        })
    }

    #[test]
    fn metadata_only_never_wants_blobs_but_ops_and_counter_converge() {
        // M1 测试③:连续收 image_add / hello / 重连,都不发 BlobWant;op 记账、水位、
        // counter 治理照旧;行不建;serve 能力保留(on_blob_want 有行照答——本测试
        // 轻端无行,静默);天上掉的 have/chunk 防御性忽略。
        let (mut a_conn, mut a_clock, _a_eng) = fresh();
        let (mut b_conn, mut b_clock) = {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir()
                .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
            let _ = std::fs::remove_file(&path);
            let conn = db::open(&path).expect("open");
            let clock = Clock::load(&conn).expect("clock");
            (conn, clock)
        };
        let mut b_eng = Engine::new(&b_conn, BlobPolicy::MetadataOnly).expect("light engine");
        let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
        let bytes: Vec<u8> = (0u8..64).collect();
        let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
        let a_id = a_clock.device_id().to_string();

        // 收 image_add:不发 want、不进清单、行不建;水位与 counter 照推。
        let outs = feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_eng);
        assert!(!any_blob_want(&outs), "MetadataOnly 收 image_add 不发 want:{outs:?}");
        assert!(b_eng.missing_blobs.is_empty() && b_eng.pulling.is_empty());
        assert_eq!(watermark(&b_conn, &a_id).unwrap(), watermark(&a_conn, &a_id).unwrap());
        let rows: i64 =
            b_conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "轻端不建图行");
        let counter: i64 = b_conn
            .query_row("SELECT last_seq FROM item_image_counter WHERE item_id = ?1", [&item], |r| r.get(0))
            .unwrap();
        assert_eq!(counter, 1, "「图N」counter 治理照跑(replay 层,不依赖字节)");

        // 连续第二枚 image_add(单帧多 op 之外的续帧路径,codex P4-d 轮 M3):照旧
        // 零 want,counter 推到 2,行仍不建。
        images::attach(&mut a_conn, &mut a_clock, &item, &[0xEE; 32], "image/png").unwrap();
        let outs = feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_eng);
        assert!(!any_blob_want(&outs), "连续收 image_add 仍不发 want:{outs:?}");
        let counter: i64 = b_conn
            .query_row("SELECT last_seq FROM item_image_counter WHERE item_id = ?1", [&item], |r| r.get(0))
            .unwrap();
        assert_eq!(counter, 2, "第二枚 image_add 的 counter 治理照跑");
        let rows: i64 =
            b_conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "仍不建行");

        // 收 hello:补给帧照回,blob want 一枚不发。
        let outs = b_eng
            .on_msg(&mut b_conn, &mut b_clock, &a_id, Msg::Hello { watermarks: BTreeMap::new() })
            .unwrap();
        assert!(!any_blob_want(&outs), "hello 不重发 want:{outs:?}");

        // 重连:hello 照发,want 零。
        let outs = b_eng.on_connected(&b_conn).unwrap();
        assert!(outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::Hello { .. }, .. })));
        assert!(!any_blob_want(&outs), "重连不派生缺图清单:{outs:?}");

        // 防御:天上掉的 have / chunk(非本策略发起)一律忽略,不建行不崩。
        let outs =
            b_eng.on_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
        assert!(outs.is_empty() && b_eng.pulling.is_empty());
        let outs = b_eng
            .on_msg(
                &mut b_conn,
                &mut b_clock,
                &a_id,
                Msg::BlobChunk {
                    image_id: img.clone(),
                    transfer: "01UNSOLICITEDTRANSFER00000".into(),
                    idx: 0,
                    last: true,
                    data: bytes.clone(),
                },
            )
            .unwrap();
        assert!(outs.is_empty());
        let rows: i64 =
            b_conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "未经拉流的字节不落地");
    }

    #[test]
    fn switching_back_to_full_rediscovers_and_backfills() {
        // M1 测试④:轻端库换回 Full 策略重建引擎,on_connected 的 derive_missing_blobs
        // 重新发现全部缺口 → want → have → pull → chunk → 行建齐,字节逐位相等。
        let (mut a_conn, mut a_clock, mut a_eng) = fresh();
        let (mut b_conn, mut b_clock) = {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir()
                .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
            let _ = std::fs::remove_file(&path);
            let conn = db::open(&path).expect("open");
            let clock = Clock::load(&conn).expect("clock");
            (conn, clock)
        };
        let mut b_light = Engine::new(&b_conn, BlobPolicy::MetadataOnly).expect("light");
        let item = notes::capture(&mut a_conn, &mut a_clock, "轻端期间的图").unwrap();
        let bytes: Vec<u8> = (100u8..200).collect();
        let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
        let a_id = a_clock.device_id().to_string();
        let b_id = b_clock.device_id().to_string();
        let outs = feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_light);
        assert!(!any_blob_want(&outs));
        drop(b_light);

        // 同一库、Full 策略重建(引擎状态本就可丢):重连即发现缺口。
        let mut b_full = Engine::new(&b_conn, BlobPolicy::Full).expect("full");
        let outs = b_full.on_connected(&b_conn).unwrap();
        let want = outs
            .iter()
            .find_map(|o| match o {
                Output::Send { msg: Msg::BlobWant { image_id }, .. } => Some(image_id.clone()),
                _ => None,
            })
            .expect("切回 Full 必须重新发现缺图并发 want");
        assert_eq!(want, img);
        // 走完 have → pull → chunk,行建齐。
        let haves = a_eng.on_msg(&mut a_conn, &mut a_clock, &b_id, Msg::BlobWant { image_id: img.clone() }).unwrap();
        let have = match &haves[0] {
            Output::Send { msg, .. } => msg.clone(),
            other => panic!("期待 have,得到 {other:?}"),
        };
        let pulls = b_full.on_msg(&mut b_conn, &mut b_clock, &a_id, have).unwrap();
        let pull = match &pulls[0] {
            Output::Send { msg, .. } => msg.clone(),
            other => panic!("期待 pull,得到 {other:?}"),
        };
        let chunks = a_eng.on_msg(&mut a_conn, &mut a_clock, &b_id, pull).unwrap();
        for c in chunks {
            if let Output::Send { msg, .. } = c {
                b_full.on_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
            }
        }
        let got: Vec<u8> = b_conn
            .query_row("SELECT data FROM item_image WHERE id = ?1", [&img], |r| r.get(0))
            .unwrap();
        assert_eq!(got, bytes, "补齐后字节逐位相等");
        assert!(b_full.missing_blobs.is_empty());
    }

    /// 117(codex H2):`pending_blob_count` = `derive_missing_blobs` 的计数投影——
    /// 壳层「全部同步」用它判「字节还在途」。全程与 derive 同步演变:源端(行在)
    /// 恒 0;轻端收 op 未收字节 = 1;字节补齐落行 = 0。
    #[test]
    fn pending_blob_count_mirrors_missing_set() {
        let (mut a_conn, mut a_clock, _a_eng) = fresh();
        let (mut b_conn, mut b_clock) = {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir()
                .join(format!("ys-nb-engine-{}-{}.sqlite3", std::process::id(), n));
            let _ = std::fs::remove_file(&path);
            let conn = db::open(&path).expect("open");
            let clock = Clock::load(&conn).expect("clock");
            (conn, clock)
        };
        let mut b_light = Engine::new(&b_conn, BlobPolicy::MetadataOnly).expect("light");
        assert_eq!(crate::sync::transport::pending_blob_count(&b_conn).unwrap(), 0);

        let item = notes::capture(&mut a_conn, &mut a_clock, "计数条目").unwrap();
        let bytes: Vec<u8> = (7u8..77).collect();
        let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
        let a_id = a_clock.device_id().to_string();
        assert_eq!(
            crate::sync::transport::pending_blob_count(&a_conn).unwrap(),
            0,
            "源端行在,不缺字节"
        );

        // 轻端收 op 未收字节:计数 = 1,且与 derive 集合一致。
        feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_light);
        assert_eq!(crate::sync::transport::pending_blob_count(&b_conn).unwrap(), 1);
        assert_eq!(
            derive_missing_blobs(&b_conn).unwrap(),
            HashSet::from([img.clone()]),
            "计数与集合同一判据"
        );

        // 字节补齐(replay 旁路建行):计数归 0。
        crate::replay::apply_image_bytes(&mut b_conn, &img, &bytes).unwrap();
        assert_eq!(crate::sync::transport::pending_blob_count(&b_conn).unwrap(), 0);
    }

    /// phone-space-plan §1.1:引导源「无缺字节」防线——字节有洞的端对 BootReq 不产
    /// 快照(静默拒供,Ok(None)),补齐后恢复供给;查与照在同一把锁内由调用方保证,
    /// 这里钉判定函数三态里的前两态(Err 态见下一测)。
    #[test]
    fn boot_source_refuses_snapshot_with_pending_blobs() {
        use crate::sync::transport::boot_serve_snapshot;
        let (mut a_conn, mut a_clock, _a_eng) = fresh();
        let (mut b_conn, mut b_clock) = {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir()
                .join(format!("ys-nb-engine-boot-{}-{}.sqlite3", std::process::id(), n));
            let _ = std::fs::remove_file(&path);
            let conn = db::open(&path).expect("open");
            let clock = Clock::load(&conn).expect("clock");
            (conn, clock)
        };
        let mut b_light = Engine::new(&b_conn, BlobPolicy::MetadataOnly).expect("light");
        let dir = std::env::temp_dir().join(format!(
            "ys-nb-engine-boot-snap-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let item = notes::capture(&mut a_conn, &mut a_clock, "洞快照防线").unwrap();
        let bytes: Vec<u8> = (1u8..99).collect();
        let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
        let a_id = a_clock.device_id().to_string();

        // 源端(字节齐):供。
        let snap = boot_serve_snapshot(&a_conn, &dir).unwrap().expect("无洞端必须供快照");
        std::fs::remove_file(&snap.path).unwrap();

        // 收 op 未收字节(洞):静默拒供——不产快照、不留文件。
        feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_light);
        assert_eq!(crate::sync::transport::pending_blob_count(&b_conn).unwrap(), 1);
        assert!(
            boot_serve_snapshot(&b_conn, &dir).unwrap().is_none(),
            "字节有洞的端不许当引导源"
        );

        // 字节补齐:恢复供给。
        crate::replay::apply_image_bytes(&mut b_conn, &img, &bytes).unwrap();
        let snap = boot_serve_snapshot(&b_conn, &dir).unwrap().expect("补齐后恢复供给");
        std::fs::remove_file(&snap.path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// phone-space-plan §1.1 第三态:完整性查询本机故障 = 响亮拒供(Err),绝不把
    /// 查询失败当 0 供出洞快照(fail-fast 铁律)。
    #[test]
    fn boot_source_refuses_on_pending_query_error() {
        use crate::sync::transport::boot_serve_snapshot;
        let (conn, _clock, _eng) = fresh();
        let dir = std::env::temp_dir().join(format!(
            "ys-nb-engine-boot-err-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // 弄坏完整性查询的依赖面(item_image 表没了 = derive_missing_blobs 必 Err)。
        conn.execute_batch("DROP TABLE item_image").unwrap();
        let err = boot_serve_snapshot(&conn, &dir).unwrap_err();
        assert!(err.contains("图字节完整性检查失败"), "错误必须响亮可辨:{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- OriginSlot 单槽池:LRU 驱逐 + 公平性(epoch-plan §5.1,2a 工序3) ----

    /// 槽池满额时新 origin 入座驱逐 LRU 槽:整槽释放(队列/挂起/want 节流一体)、
    /// 水位不动、对被逐 origin 发一次**无状态** want——复用「丢弃+want」自愈路径。
    #[test]
    fn slot_pool_evicts_lru_with_stateless_want_when_full() {
        let (mut conn, mut clock, eng) = fresh();
        let mut eng = eng.with_slot_cap(2);
        let dev = |i: usize| format!("EVCTDEV{i:03}0000000000000000");
        // 两个 origin 各留缺口(只送 seq2)占满槽池。
        for i in 0..2 {
            let op = topic_op(&dev(i), 1_000 + i as u64, 2, &format!("01TOPICEVICT{i:014}"));
            eng.on_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(i), ops: vec![op] })
                .unwrap();
        }
        assert_eq!(eng.slots.len(), 2);
        // 第三个 origin 到来:驱逐最旧(dev0),为它发无状态 want(from_seq = 水位+1 = 1)。
        let op = topic_op(&dev(2), 3_000, 2, "01TOPICEVICT00000000000002");
        let outs = eng
            .on_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(2), ops: vec![op] })
            .unwrap();
        assert_eq!(eng.slots.len(), 2, "槽数恒有界");
        assert!(!eng.slots.contains_key(&dev(0)), "LRU(最早触碰)被逐");
        assert!(eng.slots.contains_key(&dev(2)), "新 origin 入座");
        assert!(
            sends(&outs).iter().any(|m| matches!(m, Msg::Want { origin, from_seq: 1 } if *origin == dev(0))),
            "驱逐必须携带对被逐 origin 的无状态 want:{outs:?}"
        );
        // 被逐 origin 的数据没丢(水位没动):seq1+seq2 重投即补齐,槽用完即释放。
        let ops = vec![
            topic_op(&dev(0), 1_000, 1, "01TOPICEVICTA0000000000001"),
            topic_op(&dev(0), 1_001, 2, "01TOPICEVICTA0000000000002"),
        ];
        eng.on_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(0), ops }).unwrap();
        assert_eq!(watermark(&conn, &dev(0)).unwrap(), 2, "被逐 origin 重投后收敛");
        assert!(!eng.slots.contains_key(&dev(0)), "补齐后整槽释放");
    }

    /// 公平性对抗(§5.1):超槽数的合法未决 origin 持续乱序下 round-robin 不活锁、
    /// 不反复驱逐同一组——每个 origin 的帧到场即按水位连续应用,槽只在「有缺口」时
    /// 占用,重投轮转后全员收敛。
    #[test]
    fn slot_pool_stays_fair_with_more_origins_than_slots() {
        let (mut conn, mut clock, eng) = fresh();
        let mut eng = eng.with_slot_cap(8);
        let n = 12usize;
        let dev = |i: usize| format!("FA1RDEV{i:03}0000000000000000");
        // 预造全部 op(重投必须是**同一枚** op——换 op_id 重造是分叉,不是重传)。
        let history: Vec<[RemoteOp; 2]> = (0..n)
            .map(|i| {
                [
                    topic_op(&dev(i), 1_000 + i as u64 * 10, 1, &format!("01TOPICFAIR1{i:014}")),
                    topic_op(&dev(i), 1_001 + i as u64 * 10, 2, &format!("01TOPICFAIR2{i:014}")),
                ]
            })
            .collect();
        // 第一轮:全员只送 seq2(人人留缺口)——超出 8 槽的部分触发 LRU 驱逐。
        for i in 0..n {
            let op = history[i][1].clone();
            eng.on_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(i), ops: vec![op] })
                .unwrap();
        }
        assert!(eng.slots.len() <= 8, "槽数恒有界:{}", eng.slots.len());
        // 第二轮:round-robin 重投完整段 [seq1, seq2](模拟 want 的应答):无论槽还
        // 在不在,帧到即连续应用(在槽的 seq2 判重传丢弃)——一轮内全员必须收敛,
        // 无活锁、无永久饥饿。
        for i in 0..n {
            let ops = vec![history[i][0].clone(), history[i][1].clone()];
            eng.on_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(i), ops }).unwrap();
        }
        for i in 0..n {
            assert_eq!(watermark(&conn, &dev(i)).unwrap(), 2, "origin {i} 必须收敛");
        }
        assert!(eng.slots.is_empty(), "全员收敛后槽池全空");
    }

    // ---- typed poison:持久 quarantine / breaker / frozen 上界(epoch-plan §4,2a 工序2) ----

    /// 手搓一枚 shape 非法 op(topic create 缺 title——已知词汇下的字段缺失 = InvalidOp)。
    fn poison_op(device: &str, wall_ms: u64, seq: i64) -> RemoteOp {
        RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: Hlc { wall_ms, counter: 0, device_id: device.into() }.encode(),
            entity: "topic".into(),
            entity_id: format!("01POISON{:018}", seq),
            kind: "create".into(),
            payload: json!({"created_at": "2026-07-15T00:00:00Z"}), // 缺 title
            origin_seq: seq,
        }
    }

    fn quarantine_row(
        conn: &Connection,
        origin: &str,
    ) -> Option<(String, Option<Vec<u8>>, Option<String>, String, Option<String>, Option<String>, i64)>
    {
        conn.query_row(
            "SELECT op_id, op_blob, op_sha256, error_stage, relay_from_first, relay_from_last, \
             validator_ver FROM sync_quarantine WHERE origin = ?1",
            [origin],
            |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            },
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn invalid_op_quarantines_origin_persists_and_drops_later_frames() {
        let (mut conn, mut clock, mut eng) = fresh();
        let bad = poison_op(DEV, 1_000, 1);
        let outs = eng
            .on_msg(&mut conn, &mut clock, "RELAY-A", Msg::Ops { origin: DEV.into(), ops: vec![bad.clone()] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::OriginQuarantined { origin, relay_from, .. })
                if origin == DEV && relay_from == "RELAY-A")),
            "毒 op 必须报 OriginQuarantined 双坐标:{outs:?}"
        );
        let (op_id, blob, sha, stage, first, last, ver) =
            quarantine_row(&conn, DEV).expect("隔离行必须落盘");
        assert_eq!(op_id, bad.op_id);
        assert_eq!(stage, "shape");
        assert!(blob.is_some() && sha.is_none(), "常规尺寸 op 存完整材料");
        assert_eq!((first.as_deref(), last.as_deref()), (Some("RELAY-A"), Some("RELAY-A")));
        assert_eq!(ver, crate::replay::VALIDATOR_VER);
        assert_eq!(watermark(&conn, DEV).unwrap(), 0, "毒 op 不记账不推水位");
        // 后续帧(哪怕合法)帧到即丢,只更新 relay_from_last。
        let good = topic_op(DEV, 2_000, 1, "01TOPICQQQQQQQQQQQQQQQQQ1");
        let outs = eng
            .on_msg(&mut conn, &mut clock, "RELAY-B", Msg::Ops { origin: DEV.into(), ops: vec![good.clone()] })
            .unwrap();
        assert!(outs.is_empty(), "隔离后帧到即丢:{outs:?}");
        let (.., last2, _) = {
            let r = quarantine_row(&conn, DEV).unwrap();
            (r.0, r.4, r.5, r.6)
        };
        assert_eq!(last2.as_deref(), Some("RELAY-B"), "relay_from_last 必须跟进最近投递者");
        // 重启(新引擎实例):隔离态从表装载,依旧丢帧——「重启即忘」正是要关的洞。
        let mut eng2 = Engine::new(&conn, BlobPolicy::Full).unwrap();
        let outs = eng2
            .on_msg(&mut conn, &mut clock, "RELAY-C", Msg::Ops { origin: DEV.into(), ops: vec![good] })
            .unwrap();
        assert!(outs.is_empty(), "重启后隔离仍生效:{outs:?}");
        assert_eq!(watermark(&conn, DEV).unwrap(), 0);
    }

    #[test]
    fn dependency_missing_and_unknown_vocab_suspend_not_quarantine() {
        let (mut conn, mut clock, mut eng) = fresh();
        // 未知 kind = 版本偏斜:挂起等升级,不隔离。
        let mut vocab = topic_op(DEV, 1_000, 1, "01TOPICVVVVVVVVVVVVVVVVV1");
        vocab.kind = "kind_from_the_future".into();
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![vocab] })
            .unwrap();
        assert!(outs.iter().any(|o| matches!(o, Output::Event(Event::OriginSuspended { .. }))));
        assert!(quarantine_row(&conn, DEV).is_none(), "版本偏斜绝不隔离");
        assert!(eng.is_suspended(DEV));
        // 依赖未到(set_field 先于 create,行缺失无墓碑):挂起自愈,不隔离。
        let orphan = RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: Hlc { wall_ms: 1_000, counter: 0, device_id: "DEPDEV0000000000000000001X".into() }.encode(),
            entity: "item".into(),
            entity_id: "01NOSUCHITEM0000000000000X".into(),
            kind: "set_field".into(),
            payload: json!({"field": "content", "value": "无主"}),
            origin_seq: 1,
        };
        eng.on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: "DEPDEV0000000000000000001X".into(), ops: vec![orphan] })
            .unwrap();
        assert!(quarantine_row(&conn, "DEPDEV0000000000000000001X").is_none());
        assert!(eng.is_suspended("DEPDEV0000000000000000001X"));
    }

    #[test]
    fn stateful_invalid_at_apply_quarantines_with_apply_stage() {
        let (mut conn, mut clock, mut eng) = fresh();
        // seq1 合法 create 落地;seq2 对同一 entity_id 再来一条 shape 合法的 create
        // = 状态型非法(重复 create,apply 层拒)→ 隔离,error_stage = 'apply'。
        let c1 = topic_op(DEV, 1_000, 1, "01TOPICAPPLYSTAGE00000001");
        eng.on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c1] })
            .unwrap();
        let c2 = topic_op(DEV, 2_000, 2, "01TOPICAPPLYSTAGE00000001");
        let outs = eng
            .on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c2] })
            .unwrap();
        assert!(outs.iter().any(|o| matches!(o, Output::Event(Event::OriginQuarantined { .. }))));
        let (_, _, _, stage, ..) = quarantine_row(&conn, DEV).expect("隔离行必须落盘");
        assert_eq!(stage, "apply", "shape 过而 apply 拒 = 状态型,归 'apply'");
        assert_eq!(watermark(&conn, DEV).unwrap(), 1, "已落地的 seq1 不受影响");
    }

    #[test]
    fn oversized_poison_op_stores_fingerprint_only() {
        let (mut conn, mut clock, mut eng) = fresh();
        let mut bad = poison_op(DEV, 1_000, 1);
        bad.payload = json!({"created_at": "x".repeat(300 * 1024)}); // 仍缺 title,且超 256 KiB
        eng.on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![bad] })
            .unwrap();
        let (_, blob, sha, ..) = quarantine_row(&conn, DEV).expect("超限 op 也要留档");
        assert!(blob.is_none(), "超限不存完整材料(内存/磁盘上界)");
        assert_eq!(sha.map(|s| s.len()), Some(64), "存 sha256 指纹供人工比对");
    }

    #[test]
    fn frozen_over_cap_trips_persistent_breaker() {
        let (conn, _clock, mut eng) = fresh();
        // 直接驱动 freeze(分叉路径已有测试):FROZEN_CAP+1 个 origin 后 breaker 置位。
        for i in 0..=FROZEN_CAP {
            let outs = eng.freeze(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "伪造分叉".into()).unwrap();
            if i < FROZEN_CAP {
                assert!(
                    !outs.iter().any(|o| matches!(o, Output::Event(Event::PoisonBreakerTripped { .. }))),
                    "上限内不触发 breaker(第 {i} 个)"
                );
            } else {
                assert!(
                    outs.iter().any(|o| matches!(o, Output::Event(Event::PoisonBreakerTripped { .. }))),
                    "超上限必须触发 breaker"
                );
            }
        }
        assert!(eng.breaker.is_some());
        let kv: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key = 'poison_breaker'", [], |r| r.get(0))
            .unwrap();
        assert!(kv.contains("冻结"), "置位原因落盘:{kv}");
    }

    #[test]
    fn breaker_survives_restart_and_only_blocks_new_origins() {
        let (mut conn, mut clock, mut eng) = fresh();
        // 先让 DEV 在册(水位 1),再触发 breaker。
        let c1 = topic_op(DEV, 1_000, 1, "01TOPICBRKKNOWN0000000001");
        eng.on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c1] })
            .unwrap();
        for i in 0..=FROZEN_CAP {
            eng.freeze(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "伪造分叉".into()).unwrap();
        }
        assert!(eng.breaker.is_some());
        // 重启:breaker 从 sync_meta 装载,fail-closed 不忘。
        let mut eng2 = Engine::new(&conn, BlobPolicy::Full).unwrap();
        assert!(eng2.breaker.is_some(), "breaker 必须跨重启");
        // 新 origin 拒收(报一次 FrameRejected,再来静默)。
        let newcomer = topic_op("BRANDNEWDEV000000000000001", 1_000, 1, "01TOPICBRKNEW000000000001");
        let outs = eng2
            .on_msg(&mut conn, &mut clock, "X", Msg::Ops { origin: "BRANDNEWDEV000000000000001".into(), ops: vec![newcomer.clone()] })
            .unwrap();
        assert!(frame_rejected(&outs), "新 origin 必须被拒:{outs:?}");
        assert_eq!(watermark(&conn, "BRANDNEWDEV000000000000001").unwrap(), 0);
        let outs = eng2
            .on_msg(&mut conn, &mut clock, "X", Msg::Ops { origin: "BRANDNEWDEV000000000000001".into(), ops: vec![newcomer] })
            .unwrap();
        assert!(outs.is_empty(), "同 origin 每会话只报一次");
        // 已在册 origin(DEV,水位 1)照常同步。
        let c2 = topic_op(DEV, 2_000, 2, "01TOPICBRKKNOWN0000000002");
        eng2.on_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c2] })
            .unwrap();
        assert_eq!(watermark(&conn, DEV).unwrap(), 2, "已在册 origin 不受 breaker 影响");
        // 显式复位:清 KV + 内存镜像,新 origin 恢复接收。
        eng2.reset_breaker(&conn).unwrap();
        assert!(eng2.breaker.is_none());
        let again = topic_op("BRANDNEWDEV000000000000001", 3_000, 1, "01TOPICBRKNEW000000000002");
        eng2.on_msg(&mut conn, &mut clock, "X", Msg::Ops { origin: "BRANDNEWDEV000000000000001".into(), ops: vec![again] })
            .unwrap();
        assert_eq!(watermark(&conn, "BRANDNEWDEV000000000000001").unwrap(), 1, "复位后恢复接收");
    }

    #[test]
    fn quarantine_row_cap_trips_breaker() {
        let (mut conn, mut clock, mut eng) = fresh();
        let mut tripped_at = None;
        for i in 0..QUARANTINE_MAX_ROWS {
            let dev = format!("PSNDEV{i:03}00000000000000000");
            let bad = poison_op(&dev, 1_000 + i as u64, 1);
            let outs = eng
                .on_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev, ops: vec![bad] })
                .unwrap();
            if outs.iter().any(|o| matches!(o, Output::Event(Event::PoisonBreakerTripped { .. }))) {
                tripped_at = Some(i);
                break;
            }
        }
        assert_eq!(tripped_at, Some(QUARANTINE_MAX_ROWS - 1), "行数到顶必须触发 breaker");
        assert!(eng.breaker.is_some());
    }

    #[test]
    fn reverify_keeps_still_invalid_releases_fixed_and_vocab_shifts() {
        let (mut conn, mut clock, mut eng) = fresh();
        // 三个 origin 各隔离一条毒 op。
        for (i, dev) in ["RVRFYDEV000A00000000000000", "RVRFYDEV000B00000000000000", "RVRFYDEV000C00000000000000"].iter().enumerate() {
            let bad = poison_op(dev, 1_000 + i as u64, 1);
            eng.on_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev.to_string(), ops: vec![bad] })
                .unwrap();
        }
        // 把三行都标成旧校验器版本;B 的材料替换成「新校验器接受」的合法 op,
        // C 的替换成「未知词汇」(版本挂起)。
        conn.execute("UPDATE sync_quarantine SET validator_ver = 0", []).unwrap();
        let fixed = topic_op("RVRFYDEV000B00000000000000", 2_000, 1, "01TOPICREVERIFYB000000001");
        conn.execute(
            "UPDATE sync_quarantine SET op_blob = ?2 WHERE origin = ?1",
            rusqlite::params!["RVRFYDEV000B00000000000000", serde_json::to_vec(&fixed).unwrap()],
        )
        .unwrap();
        let mut vocab = topic_op("RVRFYDEV000C00000000000000", 2_000, 1, "01TOPICREVERIFYC000000001");
        vocab.kind = "kind_from_the_future".into();
        conn.execute(
            "UPDATE sync_quarantine SET op_blob = ?2 WHERE origin = ?1",
            rusqlite::params!["RVRFYDEV000C00000000000000", serde_json::to_vec(&vocab).unwrap()],
        )
        .unwrap();
        let outs = eng.reverify_quarantined(&mut conn, &mut clock).unwrap();
        // A:仍非法 → 保留、版本抬到当前(下次不再重跑)。
        let (.., ver_a) = quarantine_row(&conn, "RVRFYDEV000A00000000000000").expect("仍非法必须保留");
        assert_eq!(ver_a, crate::replay::VALIDATOR_VER);
        assert!(eng.quarantined.contains("RVRFYDEV000A00000000000000"));
        // B:新校验器接受 → 清隔离、op 归池并已应用(drain)、发 want 追回丢弃段。
        assert!(quarantine_row(&conn, "RVRFYDEV000B00000000000000").is_none(), "修好的必须放出来");
        assert!(!eng.quarantined.contains("RVRFYDEV000B00000000000000"));
        assert_eq!(watermark(&conn, "RVRFYDEV000B00000000000000").unwrap(), 1, "归池后经 drain 落地");
        assert!(
            sends(&outs).iter().any(|m| matches!(m, Msg::Want { origin, from_seq: 1 } if origin == "RVRFYDEV000B00000000000000"))
                || watermark(&conn, "RVRFYDEV000B00000000000000").unwrap() == 1,
            "追帧 want 必须发出:{outs:?}"
        );
        // C:未知词汇 → 清隔离、转普通版本挂起(drain 里挂住,不再是隔离)。
        assert!(quarantine_row(&conn, "RVRFYDEV000C00000000000000").is_none());
        assert!(!eng.quarantined.contains("RVRFYDEV000C00000000000000"));
        assert!(eng.is_suspended("RVRFYDEV000C00000000000000"), "版本偏斜转挂起");
    }
}
