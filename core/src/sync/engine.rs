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
//!     重连后任何持有者按 hello 互补重喂。缺字节图清单同理,从日志派生(`on_runtime_started`,每引擎一次)。
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
//! 出站(§5.2):last_pushed 游标是内存态、乐观推进;**中转会话仪式
//! [`Engine::on_relay_session_up`] 内**把它复位到 sync_meta 里 **ack 确认过**的位置
//! (255:复位收进会话入口,不留单独 setter——分成两步就会有「只调后半段」的漏法)——
//! 「已发未 ack」的 op 断线重连即重推,重复由对端 op_id 幂等吸收。帧丢失/游标丢失
//! 仍由双向 hello 水位互补兜底,游标只是流量优化。
//!
//! 图字节旁路(§5.4):image_add 应用后行不建,图进缺字节清单 → `blob_want` 广播
//! (mail,谁有谁答)→ 首个 `blob_have` 应答者处 `blob_pull` 拉流(direct)→
//! `blob_chunk` 攒块 → 验长度+sha256 → replay::apply_image_bytes 按 72 契约建行。
//! 对端行已不在回 `blob_deny`(pull/deny 是 §5.4 消息族的实现细化);拉流失败/对端
//! 下线由传输层通知 [`Engine::on_relay_peer_down`] 等路由维度入口(255:「投不到」永远
//! 是**某一条腿**的事实,没有「全路不可达」的真实调用点),图退回清单并当场重问。

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use ulid::Ulid;

use super::ops_serve::{self, Admit, Admitted, OpsWorks};
use crate::clock::{Clock, Hlc};
use crate::replay::{self, BytesOutcome, Outcome, RemoteOp};

/// 广播收件人(信封 `to` 的约定值,§3)。
pub const BROADCAST: &str = "*";
/// ops 帧条数上限(§5:≤500 条或 256 KiB,先到为准)。
pub(crate) const MAX_OPS_PER_FRAME: usize = 500;
/// ops 帧字节上限(§5;P2-g 补齐)。按帧内各 op 的 CBOR 编码字节累计度量——帧头
/// (变体名/origin/数组头)约几十字节、信封与 AEAD 另有 ~100B 级开销,服务器 1 MiB
/// 帧上限余量充足,预算不必逐字节精确。单条 op 超预算时独占一帧(op 不可拆;正文
/// set_field 走到数百 KiB 说明内容本身就这么大,服务器 1 MiB 帧上限是最后红线,
/// 超了 WS 层断连、响亮报错,不静默丢)。
pub(crate) const MAX_OPS_FRAME_BYTES: usize = 256 * 1024;
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
/// 制造分叉可无限撑)。超限 → 进持久 poison-breaker。冻结本身仍是内存态,**随引擎
/// 装配重检**——L-c2a 起引擎活到 runtime 生命期,故不再是「每次中转重连重检」:分叉
/// 是数据里的事实,换一条中转会话不构成重新相信它的理由(重检也只会当场再冻一次,
/// 白发一遍提示)。上界与 breaker 是新增的资源边界。
const FROZEN_CAP: usize = 16;
/// quarantine 行数上限(§4;计入 §5.1 的 origin 总额度)。
const QUARANTINE_MAX_ROWS: i64 = 64;
/// quarantine 总字节上限(§4)。
const QUARANTINE_MAX_BYTES: i64 = 16 * 1024 * 1024;
/// 单 op 隔离材料上限(沿用 ops 帧上限;超限只存指纹,标「不可自动重验」)。
const QUARANTINE_MAX_OP_BYTES: usize = 256 * 1024;
/// 隔离原因文本上限(§4)。
const QUARANTINE_REASON_MAX: usize = 512;
/// **一次 [`Engine::reverify_quarantined`] 最多重验几行**(lan-direct-plan L-d‴)。
///
/// 为什么非有界不可:每恢复一行最多产 2 枚帧([`Engine::slot_insert`] 的 LRU 驱逐 want
/// [槽池满时] + 每行必有的那枚显式 `Want`),广播 `Auto` 发出,而每链发送队列只有
/// [`crate::sync::transport`] 的 **256 帧**。**[`QUARANTINE_MAX_ROWS`] 挡不住这个数**
/// ——它是 breaker 的**跳闸点、不是表的行上界**:`quarantine_origin` 的 INSERT 无条件
/// 先落(「记录不该因满而丢」),且 breaker 置位后那道闸对 `watermark > 0` 的**已在册**
/// origin 照旧放行,故表的真实天花板 = 本地 oplog 里的 origin 总数。128 行即 256 帧。
/// 与 263(整图 128 块)、264(清单 N 枚 want / op 追赶)**同族**:单次输入的最大合法
/// 产出 > 承载它的队列上界。只在 `VALIDATOR_VER` 升版后才跑,故一直没被撞见。
///
/// **不需要轮转游标**(与 [`BLOB_WANT_BATCH`] 的关键差别):被处理过的行要么 `DELETE`、
/// 要么 `validator_ver` 抬到当前,两条路都让它**离开 `WHERE` 的工作集**,故工作集严格
/// 单调收缩、不存在「排最前那几行永远挡着后面」的饿死面,顺序取谁都行。
///
/// **这个数封的只是「隔离恢复直接新增的 want」**(实现审 M1/二轮 M2),别读大:
/// * `drain` 跑到不动点,顺带解锁的既存 pending 可产出**远多于 16** 的 `Event`(与 CPU),
///   它自身不产 `Send`;
/// * 尾部那次 `outbound`(二轮 H4 补的)**293(L-d″ 第⑤笔)起至多产一枚描述符** ——
///   它此后只登记义务,帧由消费腿逐帧惰性取,不再由本常量之外的任何东西封住帧数。
/// 故准确口径 = 「恢复 N 行 → 至多 2N ≤ 32 枚 want,外加至多一枚 `ServeOps`」。
const QUARANTINE_REVERIFY_BATCH: usize = 16;
/// 时钟偏斜提示阈值(§11 SHOULD,评审 P2-h 轮 L1):远端 op 的 HLC 墙钟比本机快过
/// 24h = LWW 长期偏向它,一次性提示查系统时间(不拒帧——对端时间可能真错,拒了反而
/// 卡住同步)。
const CLOCK_SKEW_THRESHOLD_MS: u64 = 24 * 60 * 60 * 1000;
/// **收端同时在飞的拉流笔数上界**(lan-direct-plan §10 C′)。一笔 `Pull` 的 `buf` 本就
/// 可以涨到 [`crate::images::MAX_IMAGE_BYTES`](32 MiB),不封窗口的话「缺几张图就同时
/// 攒几份 32 MiB」——那是收端的无界内存面。窗口 1 把 blob 收端缓冲严格封顶在一张图:
/// 单条有序 socket 上同时拉多图不增吞吐(带宽就那么多),只增内存与乱序状态。
///
/// 代价:清单里的图改为**逐张过**,故槽一腾出来必须补问(见 [`Engine::blob_refill`])。
const MAX_ACTIVE_PULLS: usize = 1;
/// **一次引擎输入最多产出几枚 `BlobWant`**(264 实现审 H2)。原先 hello / 会话仪式 /
/// 新 image_add 各自遍历全量缺字节清单发 want:一枚合法的 `Ops` 帧最多带 500 条 op,
/// 全是 `image_add` 就是 500 枚 want;缺 N 张图时收到一枚 hello 就是 N 枚——而每链
/// 发送队列只有 [`crate::sync::transport`] 的 256 帧,一次 dispatch 就撞穿、断链、
/// 重建后再换一轮 hello 又来一遍,**与 263 那个 bug 同族**(负载从「单图 128 块」换
/// 成了「清单 N 枚 want」)。
///
/// 32 的取法:比收端窗口([`MAX_ACTIVE_PULLS`])大得多,故「问的那张恰好没人有」不会
/// 让一轮白问;又只有 256 帧上界的 1/8,留足并发其它帧的余量。问不完的由轮转游标在
/// 后续事件/心跳里接着问(见 [`Engine::want_batch`])。
const BLOB_WANT_BATCH: usize = 32;
/// 图字节拉流「无进展」阈值(on_tick 心跳次数):对端应了 BlobHave 却不发块(恶意或
/// bug),连累这么多次心跳后作废本次拉流、回缺图清单换来源(评审 P2-h 轮 M1)。心跳
/// 30s → 2 次 ≈ 60s idle 才判死,正常传输不误伤。
const PULL_STALE_TICKS: u32 = 2;
/// 一条 (对端, 路由) 拉流超时后的 blob 惩罚时长(lan-direct-plan §5.1,以 on_tick 心跳
/// 计:30s × 10 = 5 分钟)。**刻意用心跳刻度不用墙钟**——墙钟回拨会让惩罚超期不失效
/// (lan.rs 的重复抑制缓存同一条纪律);惩罚只挡该路由的 blob 选路,mail/Hello 照走。
const BLOB_PENALTY_TICKS: u64 = 10;

/// 图字节旁路策略(android-plan §4 M1,P4-d):由 `Engine::new` / Transport 显式注入,
/// 不做默认值,由调用端按端上需求选(桌面恒 Full;安卓 100-116 注 MetadataOnly、
/// **117 起反转为 Full** 时间轴显图)。`MetadataOnly`——`image_add` op 照记账、照推
/// 水位、照跑 `reconcile_item_images`(counter 推平 / 撞号翻案 / 正文修正),但**不登记
/// 缺字节清单、不发 BlobWant、不拉流**;`missing_blobs`/`pulling` 本就是可丢内存态、
/// 不参与 origin 连续性与分叉判定,故不阻塞水位、不触发分叉冻结。`on_blob_want` 两种
/// 策略下都照答(serve 是独立能力位:拿首次快照带来的旧图给别机补洞无一致性风险);
/// tombstone 清理逻辑保留(无害,利于切回 Full——切回后 `on_runtime_started` 的
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
    ///
    /// `lan` = 局域网直连的身份与地址通告(lan-direct-plan §2)。**刻意不加顶层 ctl
    /// 变体**:新顶层变体须升 `crypto::PROTO_VER`(在 AAD 首位)= 混版一切帧互相
    /// 解密失败;可选字段两个代价都不付(`skip_serializing_if` 让 `None` 的字节形态
    /// 与现网**逐字节一致**,旧端 serde 派生忽略未知字段、水位照读)→ 零版本偏斜。
    /// 这是「新增字段必升版本」纪律的**窄例外**,仅限「丢了不影响收敛正确性的
    /// advisory 字段」;`LegacyMsgV1` 冻结对拍测试守着这条兼容性。
    ///
    /// 注入点在**传输层封帧前**——引擎产出的 Hello 恒 `None`(§2)。
    Hello {
        watermarks: BTreeMap<String, i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lan: Option<super::lan::LanAd>,
    },
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

/// 投递路由(lan-direct-plan §5.1):同一枚密文帧的两条运输腿。**中转恒为主路**
/// (不变量 1),局域网直连只是加速层;两路帧汇入同一台引擎,重复由 op_id 幂等吸收。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Route {
    /// 经服务器中转(WSS 信封路)。**per-peer 路由**(三轮 M1):本机会话在线 ≠ 对端
    /// 可达,还须服务器在线表说该对端在线。
    Relay,
    /// 局域网直连链路(lan.rs 握手过的对等 TCP)。
    Lan,
}

/// 路由意向(lan-direct-plan §6,三轮 M4):**类型化输出契约**——「这帧该走哪条腿」
/// 由产出它的引擎逻辑说清,不靠传输层在调用栈里猜。
///
/// 只有两个变体:`Auto` 走 §5 默认策略(中转在线只走中转 + 对端中转离线时补投 lan),
/// `Require(r)` 钉死路由、送不出就**失败回引擎重算**(绝不静默改路)。规格 §6 还列过
/// `Prefer(Route)`,v1 落地时无任何生产者(blob transfer 恒 `Require` 绑创建时选定的
/// 路由、来路亲和恒 `Require(Lan)`、其余皆 `Auto`),故不造——将来真有「优先但可退」
/// 的语义再加(§6 已随本轮记实)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteHint {
    Auto,
    Require(Route),
}

/// 引擎输出:待发帧、**一笔图字节供流**,或需上抛的事件(P2-g 转 UI)。
#[derive(Debug)]
pub enum Output {
    Send { to: String, lane: Lane, route_hint: RouteHint, msg: Msg },
    /// 图字节供流描述符(lan-direct-plan §10「blob 供流 transport 分段驱动(不整图
    /// 物化)」的落地形,263 真机挖出该条从未实现后的 C′ 修法)。
    ///
    /// 引擎**不再产 N 枚块**:它只查存在性与 `(rowid, 字节数)`,块由传输层在**自己的
    /// 写任务里**逐块取数、封帧、写 socket。原先「整图物化 + 一次性吐最多 128 枚
    /// 256 KiB 块」撞每链 8 MiB 队列上界即断链——≥8 MiB 的图纯局域网永远传不成,且
    /// 链一重建仍 LAN 优先 → 重拨重死循环(真机字据:7.83 MiB 过 / 8.16 MiB 挂)。
    ServeBlob(BlobServe),
    /// op 追赶供流描述符(lan-direct-plan §6.2 ①;L-d″ 第⑤笔)。
    ///
    /// **它不是工作句柄,只是一声「这个 target 刚有活,来取」**——与 [`BlobServe`] 的
    /// 心智模型相反(那个描述符**自带** rowid/total,是取数把手)。ops 的工作住在
    /// [`OpsWorks`] 里,描述符里**一个游标、一枚 op 都没有**。照 blob 的形推理会以为
    /// 它可以脱离 `OpsWorks` 使用。
    ServeOps(OpsServe),
    Event(Event),
}

/// 一声 op 追赶的唤醒(见 [`Output::ServeOps`])。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpsServe {
    pub to: OpsServeTo,
}

/// 这声铃摇给谁。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpsServeTo {
    /// 定向答复:**来路亲和**,绑产出那一刻的来路腿(照 [`BlobServe::route`])。
    Peer { device: String, route: Route },
    /// 本机 origin 追赶:**没有来路**(本机产的,压根不存在),由投递面按权威完成腿
    /// 与补投面决定摇哪条腿(§6.2 ①)。
    ///
    /// 为什么不塞一枚 `Option<Route>`:那样每个消费点都得回答「`None` 到底是『没来路』
    /// 还是『忘填了』」。把这件事钉进类型是 254 那条教训(「凭据只绑一半等于没封」)。
    Broadcast,
}

/// 一笔图字节供流(§5.4 的供方侧)。**刻意不含字节**——字节由
/// [`read_blob_chunk`] 按块惰性取,故这枚描述符进队列只占几十字节,永远撞不到
/// [`Msg`] 帧那套字节上界。
///
/// 描述符**绑创建时选定的那条腿**(`route` = 拉流请求的来路,§5 来路亲和):传输层交
/// 给的是那一刻的**具体链路对象**,链路被替换/死亡即随之销毁,绝不按对端重找「当前
/// 链」(§6 代次契约之三)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobServe {
    /// 拉方(块与 deny 回它)。
    pub to: String,
    /// 绑定的腿。同一 transfer 的块永不跨链/跨路(§5.1)。
    pub route: Route,
    pub image_id: String,
    /// 回显拉方给的 transfer(先后两次拉流的残帧靠它区分)。
    pub transfer: String,
    /// 应答那一刻这张图所在的行。**只是取数把手,不是身份**:SQLite 会复用 rowid,故
    /// [`read_blob_chunk`] 每块都拿它反查 `id` 与总字节复核。
    pub rowid: i64,
    /// 字节总数(应答那一刻)。`item_image` 有 immutable 触发器,行只可能整行消失,
    /// 故对上 `(rowid, id)` 之后这个数就不会中途变。
    pub total: i64,
}

impl BlobServe {
    /// 总块数。`length(data) > 0` 由 0016 的 CHECK 保证,故至少一块。
    pub(crate) fn chunks(&self) -> u32 {
        let total = self.total.max(1) as u64;
        total.div_ceil(BLOB_CHUNK_BYTES as u64) as u32
    }

    pub(crate) fn is_last(&self, idx: u32) -> bool {
        idx + 1 >= self.chunks()
    }
}

/// 供流的**唯一取数点**(生产代码;C′ 第 4 条:短查询、不跨 socket await 持锁、不为
/// 慢链持跨整图的 read transaction)。传输层的 LAN 写泵与中转腿的逐块循环共用它——
/// 「块怎么切、边界在哪、行没了怎么办」只有这一处实现,测试驱的也是它。
///
/// 每块都复核「`rowid` 反查出来的还是同一张图、总字节没变」:`item_image` 只增删不改
/// (`trg_item_image_immutable`),故行只可能**整行消失**,而 rowid 会被 SQLite 复用,
/// 光有 rowid 不够。不符 = `Ok(None)`,调用方沿同 transfer 发 `BlobDeny`(收端据此
/// 回清单另寻来源,不必干等 stale)。
///
/// 走增量 BLOB 句柄而不是 `substr(data,…)`:后者每块都要 SQLite 把整张图读进内存,
/// 32 MiB 的图分 128 块就是 4 GiB 无谓读——那等于把「不整图物化」这条又违一遍。
pub(crate) fn read_blob_chunk(
    conn: &Connection,
    serve: &BlobServe,
    idx: u32,
) -> Result<Option<Vec<u8>>, String> {
    use std::io::{Read, Seek, SeekFrom};
    if idx >= serve.chunks() {
        return Err(format!("内部错:块序号 {idx} 越过 {} 的总块数", serve.image_id));
    }
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT id, length(data) FROM item_image WHERE rowid = ?1",
            [serve.rowid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((id, total)) = row else { return Ok(None) };
    if id != serve.image_id || total != serve.total {
        return Ok(None); // 行已换人(删后 rowid 被复用)。
    }
    let offset = idx as usize * BLOB_CHUNK_BYTES;
    let len = BLOB_CHUNK_BYTES.min(total as usize - offset);
    let mut blob = conn
        .blob_open(rusqlite::DatabaseName::Main, "item_image", "data", serve.rowid, true)
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len];
    blob.seek(SeekFrom::Start(offset as u64)).map_err(|e| e.to_string())?;
    blob.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(Some(buf))
}

/// 一条 (对端, 路由) 的连接态(lan-direct-plan §5.1)。`generation` = 该腿的**代次**:
/// relay 取引擎内部的会话代号(每次 `on_relay_session_up` +1),lan 取传输层给的链路
/// 代号;transfer 记下创建时的代次,故「旧代链路断开」的通报作废不了新代链路上的
/// 在飞传输(glare 替换后正是这一形)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Connectivity {
    Absent,
    Up { generation: u64 },
}

/// 路由健康态 = **连接态 × 惩罚态正交乘积**(§5.1,三轮 M1:三态枚举表达不了
/// 「Absent+penalty」「Up+penalty」两种组合)。两轴完全正交——链断/链建**不清**
/// penalty(惩罚独立于 socket 代次),penalty 只挡 blob 选路、不挡 mail/Hello。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RouteState {
    connectivity: Connectivity,
    /// 惩罚到期的心跳刻度(`Engine::tick` 达到它即失效);None = 无惩罚。
    blob_penalty_until: Option<u64>,
}

impl RouteState {
    fn absent() -> RouteState {
        RouteState { connectivity: Connectivity::Absent, blob_penalty_until: None }
    }
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
    /// origin 分叉,该 origin 同步已冻结(恢复走 §11 手工流程)。冻结是内存态、
    /// **随引擎装配重检**(L-c2a:引擎活到 runtime 生命期,不再是每次重连重检)。
    OriginFrozen { origin: String, reason: String },
    /// origin 队头挂起(依赖未到/对端版本较新)。解开不另发事件;同因不重报。
    OriginSuspended { origin: String, reason: String },
    /// origin 被持久隔离(毒 op,OpError::InvalidOp;epoch-plan §4):此后其帧到即丢,
    /// 跨重启生效。relay_from 是投递该 op 的设备——**不得断言 origin 设备 = 作恶发送
    /// 者**,吊谁由运营者依双坐标判断;UI 必须转常驻告警。
    OriginQuarantined { origin: String, relay_from: String, reason: String },
    /// poison-breaker 置位(§4 fail-closed):置位后引擎拒收**新** origin 的帧(本地日志
    /// 尚无其 op 的);**冻结表满额时升级为拒收一切尚未 frozen/quarantine 在册的 origin**
    /// (L-c2a 实现审 H1:此刻已无处安全记录新分叉)。落盘跨重启,解除须人工处置后显式复位。
    PoisonBreakerTripped { reason: String },
    /// 整帧拒收(入池前硬校验不过):协议错误,记日志用。
    FrameRejected { from: String, reason: String },
    /// 收到 HLC 墙钟比本机快 >24h 的远端 op(§11 SHOULD,L1)——对端系统时间可能错,
    /// LWW 会长期偏向它;每会话提示一次(P2-g 转用户可见),不拒帧。
    ClockSkew { ahead_hours: u64 },
    /// op 追赶供流的**有界降级 / 资源拒绝**(lan-direct-plan §6.2 ③)。走状态面
    /// [`super::transport::SyncStatus::ops_notice`] 那一格,**刻意不占 `error`**
    /// ——那是正确性面,而这两档是「收下了但降级」与「这枚逻辑请求被丢弃了」。
    OpsNotice { text: String },
}

/// [`Event::OpsNotice`] 的两档(§6.2 ③)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpsNoticeClass {
    /// 收下了,但降级成全量重扫(有界降级须可见)。
    Collapsed,
    /// 64 项全都还有真实工作:**这枚逻辑请求被丢弃了**,不是「收下了只是慢」。
    Overload,
}

/// 一条 ops 追赶 advisory 的文本。**它是 `(target, class)` 的纯函数**——这一点是
/// §6.2 ③「单槽结构化去重」的落地依据:状态面那一格只存这枚文本,而
/// [`super::transport::set_status`] 本就「快照没变不发事件」,于是
///
/// * **覆盖**:下一条盖上一条;
/// * **去重**:同 `(target, class)` 再来一次 = 同一枚文本 = 快照没变 = 不重报;
/// * **允许再报**:被别的 notice 覆盖之后再次出现 = 快照真变了 = 照报。
///
/// 三件语义全由「文本是纯函数」+ 既有的快照去重给出,**不为去重另建 target 旁表**
/// (§10)。反过来说:**日后往文本里塞任何随请求变化的量(计数、时刻、seq)都会当场
/// 破掉去重**,那时得改成结构化槽,而不是在这里拼字符串。
fn ops_notice(target: &str, class: OpsNoticeClass) -> Output {
    let who = if target == BROADCAST { "本机新增内容".to_string() } else { format!("与 {target} 的对账") };
    Output::Event(Event::OpsNotice {
        text: match class {
            OpsNoticeClass::Collapsed => format!("{who}的补齐已降级为全量重扫(细粒度账超限)"),
            OpsNoticeClass::Overload => format!("{who}的补齐请求被拒(同时对账的对端已达上限)"),
        },
    })
}

/// 一枚 ops 追赶描述符:定向答复,**绑产出那一刻的来路腿**(§6.2 ①)。
fn serve_ops_peer(device: &str, route: Route) -> Output {
    Output::ServeOps(OpsServe { to: OpsServeTo::Peer { device: device.into(), route } })
}

/// 一次进行中的图字节拉流(direct)。expected 取自该图 image_add op 声明的字节数,
/// 攒块超过它立即作废——对端(bug 或恶意)发无尽 `last=false` 块撑不爆内存
/// (codex 二轮 #4)。
pub(crate) struct Pull {
    from: String,
    /// 本次拉流绑定的路由与代次(lan-direct-plan §5.1):**同一 transfer 的块永不跨
    /// 链/跨路**——路由失效即整笔作废重新选路,不迁移在飞传输。
    route: Route,
    generation: u64,
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
    /// poison-breaker(§4 fail-closed):Some(置位原因)= 拒收新 origin 的帧;
    /// **冻结表满额时升级为拒收一切尚未 frozen/quarantine 在册的 origin**(实现审 H1)。
    /// sync_meta『poison_breaker』的内存镜像,置位落盘、重启装载即恢复;解除须人工
    /// 处置后显式 [`Engine::reset_breaker`]。
    pub(crate) breaker: Option<String>,
    /// 本会话已因 breaker 被拒过的 origin(事件去刷屏,不持久)。
    breaker_reported: HashSet<String>,
    /// 缺字节的图(image_add 已应用、行未建、图活着)。与 pulling 互斥。
    pub(crate) missing_blobs: HashSet<String>,
    /// 拉流中(image_id → 进行中的传输)。
    pub(crate) pulling: HashMap<String, Pull>,
    /// 对某图超时过的 **(来源, 路由)**(M1;lan-direct-plan §5.1 扩维):重发 want 后
    /// 别再从这条腿选它(让别的设备或别的腿应答),否则同一个沉默对端会反复抢答、
    /// 每次卡满 idle 阈值。形状 = image → set<(device, route)>,**不是**全局设备封禁:
    /// 局域网黑洞不该连带禁掉同一台设备的中转腿。清除时机 = 该 (对端, 路由) 的惩罚
    /// 到期(§5.1)或该维度重置(relay 会话重连只清 relay 维度)。
    blob_shunned: HashMap<String, HashSet<(String, Route)>>,
    /// 补问的**轮转游标**(§10 C′;见 [`Engine::blob_refill`])。收端窗口封到
    /// [`MAX_ACTIVE_PULLS`] 之后,「下一张问谁」若恒取最小 id,一张谁也没有的图就能把
    /// 后面的图永久挡住;轮转让清单里每张都轮得到。
    want_cursor: u64,
    /// 路由健康表(§5.1):(对端, 路由) → 连接态 × 惩罚态。表里没有的 = Absent 无惩罚。
    routes: HashMap<(String, Route), RouteState>,
    /// 心跳刻度(on_tick 单调加):惩罚到期判定的时间轴,**不用墙钟**(回拨即失效不了)。
    tick: u64,
    /// 装配初始化已跑过吗([`Engine::on_runtime_started`] 每引擎只许一次)。
    runtime_started: bool,
    /// 当前中转会话的代号:`Some(代次)` = 会话在,`None` = 不在。**「(X,Relay)=Up 须
    /// 会话在 ∧ X 在线」两层由这个字段封住**(实现审 M2:光靠「调用方按顺序调」的
    /// 约定,无会话时的 `on_relay_peer_up` 会造出指向不存在中转的路由)。
    relay_session: Option<u64>,
    /// relay 会话代号发号器(每次会话建立 +1):relay 腿的 generation 轴,
    /// 「旧会话的 peer down」作废不了新会话上的在飞拉流。
    relay_generation: u64,
    /// 出站游标:本机 op 已广播到哪(乐观推进,见模块注释)。
    last_pushed: i64,
    /// 「本地 op 已结算」游标(lan-direct-plan §6,L-c1 实现审 L1):本机 op 扫到哪了。
    /// **与 `last_pushed` 是两根轴,永不复位**——那根随中转会话回退重推,这根只管
    /// 「本地删图让缺字节清单多出死项」的清理,回退会白扫一遍(无害但无意义)。
    local_settled: i64,
    /// 本会话是否已提示过时钟偏斜(L1;一次即可,别刷屏)。
    skew_warned: bool,
    /// **隔离表里可能还有待重验的行**(L-d‴):上一批取满了 [`QUARANTINE_REVERIFY_BATCH`],
    /// 工作集里可能还有。这是「有界批**不静默截断**」的那一半——余量必须有个明确的续做
    /// 触发器,否则剩下的行要等下一次偶然的重连(会话仪式曾是唯一调用点,长连接下可以隔
    /// 好几天)。续做由**心跳**驱动,判据口见 [`Engine::needs_reverify_tick`]。
    /// **保守取值**:批取满即置位,下一批可能空跑一次——空跑只是一条 `SELECT … LIMIT`。
    reverify_backlog: bool,
    /// **行已放出隔离表,但 drain/outbound 还欠着**(实现审三轮 H2)。
    ///
    /// 与上面那一位是两件事,**不能合并**:上面问的是「SQL 里还可能有行吗」,而恢复分支
    /// 一旦 `DELETE` 成功,那些行就**永远不会再被 `WHERE` 选中**——此后 drain 若失败,
    /// 光靠上面那位是认领不回来的(下一拍 `rows` 空 → `full=false` → 位子被清成 false,
    /// 既不会再 drain 也不会 outbound,留下「已归池却没结算的 op」和「翻案产出却没推出去
    /// 的本机修正 op」两类无主义务)。故另设这一位:`slot_insert` 一成功就置起来
    /// (op 从那一刻起就在内存池里躺着),drain **与** outbound 两件都做成才清。
    settle_pending: bool,
    /// op 追赶供流的计划表(§6.2 ⑤(a);L-d″ 第⑤笔)。**`Arc` 是把手不是所有权**——
    /// 所有权仍在 `EngineSlot.ops`,那里 `retire` 时换整只,故新一代引擎必然拿到新那只
    /// (`reconcile` 先 `retire()` 再 `Engine::new`,顺序天然正确)。
    ///
    /// 为什么引擎要够得着它:三个生产入口(`outbound` / `on_hello` / `on_want`)与出站
    /// Hello 的有界水位游标(`hello_cursor`)都在 `Engine` 内部,而工作与游标住在
    /// `OpsWorks`。把 `OpsWorks` 整个搬进 `Engine` 不成立——写泵必须能在协调者忙别的事时
    /// 独立推进,而 `Engine` 被协调者独占借用。
    ///
    /// **锁序恒 db → work**:凡同时持 DB 与它,一律先 DB;两把 guard 均不得跨 `.await`;
    /// 持 work 时不得再取 db/clock/status/lan。结构锚见 transport.rs 的
    /// `ops_lock_sites_are_allowlisted`。
    ops: Arc<Mutex<OpsWorks>>,
}

impl Engine {
    /// 从库装配:device_id 取自 sync_meta(时钟先行,必在;缺失 = 库损坏,fail-fast)。
    /// 出站游标起点 = 本机当前水位——重启后不盲目全量重推,增量靠双向 hello 互补。
    /// `blob_policy` 显式注入(M1),不做默认值——桌面 Full、手机轻端 MetadataOnly。
    /// `ops` 是**当时那只**供流计划表的把手(§6.2 ⑤(a)):做成必填参数而不是事后
    /// `set_ops`,免得存在「引擎在槽里、把手还没接上」这种半态。
    pub fn new(
        conn: &Connection,
        blob_policy: BlobPolicy,
        ops: Arc<Mutex<OpsWorks>>,
    ) -> Result<Engine, String> {
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
            want_cursor: 0,
            routes: HashMap::new(),
            tick: 0,
            runtime_started: false,
            relay_session: None,
            relay_generation: 0,
            last_pushed,
            // 装配那一刻库里的本机 op 全算「已结算」:缺字节清单由
            // `on_runtime_started` 的 derive 一次性派生,它本就把死图排除在外。
            local_settled: last_pushed,
            skew_warned: false,
            // 装配即置位:表里可能本来就攒着上个版本留下的待重验行,而会话仪式那一枚
            // 调用未必先到(纯 LAN 冷启动根本没有中转会话)。首拍心跳空跑一条
            // `SELECT … LIMIT 16` 即自清,代价可忽略。
            reverify_backlog: true,
            // 新引擎的内存池是空的,没有欠着的结算:上一代引擎放出来又没 drain 完的 op
            // 随它一起丢弃,靠水位不动 + 那枚已发出的 want 从对端重新拿(见字段注释)。
            settle_pending: false,
            ops,
        })
    }

    /// 测试夹具:**把计划表里此刻能供的帧全抽出来**,当作那条不存在的消费腿。
    ///
    /// 第⑤笔之后引擎不再当场物化帧,故 sans-io 的收敛 / 引导互通那几套夹具(它们没有
    /// 传输层)必须自己扮演消费者。这里刻意**复用真正的取数与提交路**
    /// ([`ops_serve::PeerWork::prepare_next`] + `commit`),不另写一份取数逻辑——
    /// 夹具一旦自己造帧,那些用例就会「照样绿,但绿得没有意义」。
    ///
    /// 与生产消费腿的**两处已知差异**,如实记着:①这里取到帧就当场 `commit`,而生产是
    /// 「写成了才提交」(失败走 `Drop` 回滚);②这里一口气抽干,而生产窗口是 1 帧、
    /// 由回执或铃驱动。两条都是「把并发与失败面拿掉」,不改变**产的是哪些帧**。
    #[cfg(test)]
    pub(crate) fn drain_ops_for_test(&mut self, conn: &Connection) -> Result<Vec<Output>, String> {
        let mut out = vec![];
        let mut works = ops_serve::lock_ops(&self.ops);
        for target in works.idle_runnable_targets() {
            loop {
                let Some(work) = works.work_mut(&target) else { break };
                match work.prepare_next(conn)? {
                    ops_serve::Prepare::Idle | ops_serve::Prepare::Occupied => break,
                    ops_serve::Prepare::Ready(p) => {
                        let frame = p.frame;
                        work.commit(p.token)?;
                        let Some(frame) = frame else { continue }; // 空转:提交了但没字节
                        out.push(Output::Send {
                            to: target.clone(),
                            lane: Lane::Mail,
                            route_hint: RouteHint::Auto,
                            msg: Msg::Ops { origin: frame.origin, ops: frame.ops },
                        });
                    }
                }
            }
        }
        Ok(out)
    }

    /// 测试用装配:**自带一张谁也不共享的计划表**。
    ///
    /// 名字里的 solo 是诚实的:生产里那只把手来自 [`EngineSlot`],换代时整只换掉;
    /// 这里造的是私有的一只,故拿它**验不了**「引擎与槽同一只表」那条。
    ///
    /// 那条由 transport 那半的行为测断:夹具经 `publish_ops_handle` 挂出来的把手往表里
    /// 塞 work(`seed_ops_work`),而帧是**引擎那一侧**取出来发的 —— 两侧不是同一只表
    /// 的话一帧也出不来。
    #[cfg(test)]
    pub(crate) fn new_solo(conn: &Connection, blob_policy: BlobPolicy) -> Result<Engine, String> {
        Engine::new(conn, blob_policy, Arc::new(Mutex::new(OpsWorks::default())))
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

    /// 心跳刻度(测试用):transport 的「离线期也照跳」接线锚要看它真的在涨。
    #[cfg(test)]
    pub(crate) fn tick_count(&self) -> u64 {
        self.tick
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

    /// 测试用:凭空种一笔在飞拉流。真造一笔要「image_add op 落库 → 喂 BlobHave → 出
    /// BlobPull」两轮喂帧,而拿它当夹具的用例(传输层那边验「会话收场的重问帧走不走得
    /// 出去」)与 transfer 怎么来的无关——夹具成本压在这里,断言才留得住焦点。
    #[cfg(test)]
    pub(crate) fn plant_pull_for_test(&mut self, from: &str, image_id: &str, route: Route) {
        self.pulling.insert(
            image_id.into(),
            Pull {
                from: from.into(),
                route,
                generation: 1,
                transfer: Ulid::new().to_string(),
                buf: vec![],
                next_idx: 0,
                expected: 1,
                stale_ticks: 0,
            },
        );
    }

    /// **运行时装配即活**(lan-direct-plan 不变量 6 / §6,二轮 H1):每个引擎实例
    /// 一次性的本地初始化,**不要求任何链路存在**——引擎生命周期独立于中转与 lan,
    /// 两者都只是它的路由。缺字节清单从日志派生:「有 image_add、无 image_tombstone、
    /// 宿主无 tombstone、行未建」,派生不存。MetadataOnly(M1):不派生清单、不发
    /// want——切回 Full 的引擎在这里重新发现全部缺口,轻端期间的「洞」自愈。
    ///
    /// 无输出:此刻可能一条链路都没有(断 WAN 冷启动),hello/want 的发起时机归
    /// [`Engine::on_relay_session_up`] 与 [`Engine::on_lan_link_up`]。
    ///
    /// **每引擎只许一次,再调即响亮报错**(实现审 L2):重复派生会把正在拉流的图重新
    /// 塞回缺字节清单,破掉「清单与在飞互斥」这条不变量(下一枚 have 会另起一笔
    /// transfer 把在飞那笔顶掉)。装配一次即活,不是可反复调的「刷新」。
    pub fn on_runtime_started(&mut self, conn: &Connection) -> Result<(), String> {
        if self.runtime_started {
            return Err("引擎装配初始化只许一次(重复派生会破坏缺图清单与在飞拉流的互斥)".into());
        }
        self.runtime_started = true;
        self.missing_blobs = match self.blob_policy {
            BlobPolicy::Full => derive_missing_blobs(conn)?,
            BlobPolicy::MetadataOnly => HashSet::new(),
        };
        Ok(())
    }

    /// 本机中转会话建立(含重连,§6):**出站游标复位到 `acked`**(sync_meta 里服务器
    /// 已确认过的位置,由传输层代入——「已发未 ack」的 op 由此在重连后重推,重复由对端
    /// op_id 幂等吸收;游标只是流量优化,正确性恒靠双向 hello 水位互补)+ 广播 hello
    /// (全量水位向量,**Require(Relay)**——带 lan 通告的权威 Hello 只许走鉴权路,§2 的
    /// 缓存规则只认经 deliver 到达的帧)+ 对缺字节图重发 blob_want(Auto:广播不因来路
    /// 窄化收件面)。
    ///
    /// 游标复位收在本入口内而不是另一个 setter(实现审 H1):引擎跨会话存活后,「复位
    /// 游标 + 重置 relay 维度 + 发 Hello/Want」必须是**一次原子的会话仪式**,分成两个
    /// 调用就会有「只调了后半段」的漏法——未 ack 的本机 op 从此再不主动推送。
    ///
    /// **只重置 relay 维度**(二轮 H1:旧 `on_connected` 的全量重置会误伤正在走的 lan
    /// 拉流)——relay 腿的连接态清空(谁在线等服务器在线快照说,§6 对端级事件)、relay
    /// 在飞拉流作废、relay 惩罚与 shun 清零(重连是新会话,人人这条腿再给一次机会);
    /// lan 的连接态/代次/惩罚/shun/在飞拉流一律不动。
    pub fn on_relay_session_up(
        &mut self,
        conn: &Connection,
        acked: i64,
    ) -> Result<Vec<Output>, String> {
        // 结算本地删除**收在仪式第一步**(同游标复位那条,实现审 H1):放到调用方去
        // 「记得先结算再 session_up」,迟早写反,那一轮就对刚被用户删掉的图广播一遍
        // 谁也答不了的 want。
        self.on_local_ops_settled(conn)?;
        self.relay_generation += 1;
        self.relay_session = Some(self.relay_generation);
        self.last_pushed = acked;
        // 引擎跨会话存活后的一条线(L-c2a):**UI 去重位随会话复位,数据事实跨会话
        // 保留**。去重位(时钟偏斜提示 / breaker 拒帧提示 / 挂起原因)本就是「每会话
        // 报一次」的防刷屏计数,不复位就变成「每引擎一次」——重连清了状态面的 error,
        // 用户此后再也看不到仍在挂起的那条;而冻结、隔离、缺字节清单是引擎的当前事实,
        // 一律不因为换了条中转会话就忘掉。
        self.skew_warned = false;
        self.breaker_reported.clear();
        for slot in self.slots.values_mut() {
            slot.wanted = None;
            slot.suspend_reported = None;
        }
        // 作废的图已回缺字节清单,下面的 want 循环连它们一起问,无需另发。
        let _ = self.invalidate_pulls(|p| p.route == Route::Relay);
        self.reset_route_dimension(Route::Relay);
        // **广播 Hello 走 [`Engine::make_hello`] 这个唯一构造点**(第⑤笔):原先这里另有
        // 一份逐字相同的内联构造,于是「广播 Hello 是什么」有两处真相源——292 的 L1 正是
        // 在数这些构造点(当时是三条路)。收敛之后「有界水位」这件事只需要在一处成立。
        let mut out = self.make_hello(conn, BROADCAST, Route::Relay)?;
        // **本机 origin 的追赶义务:保守合并 `[acked+1, current_max]`,不是复位工作游标**
        // (§6.2 ⑦ 一轮 H4)。此刻可能仍有 LAN ticket 在飞,原地换计划会让旧 token 对不上、
        // 或让旧 ticket 提交时把刚回退的缺口又跨过去一遍。
        //
        // 落地形就是**把内存登记位退回 `acked` 再走一次既有的登记入口**:`OpsWorks::on_want`
        // 的 `lower_existing_gap` 本就取更早的起点(保守下界),`PeerWork` 不换、在飞位不动。
        // 三种交错都安全:commit 先发生 → 随后下修把 `[acked+1,…]` 重新加回;merge 先发生
        // → `commit` 检出 `next_seq < served_from` 后保留低起点;rollback → 游标不进、债还在。
        self.outbound(conn, &mut out)?;
        // 缺字节清单走**唯一发问点**(264 实现审 H2):原先在这里遍历全量清单,缺 N 张
        // 就是 N 枚帧,一次 dispatch 撞穿每链 256 帧的队列。
        out.extend(self.want_batch());
        Ok(out)
    }

    /// 本机中转会话断开(§6 会话级):全部对端的 relay 连接态置 Absent + 只作废 relay
    /// 在飞拉流,**并当场为作废的图重发 want**(实现审 H2:路由失效后没有别的触发器
    /// ——`on_tick` 只管在飞拉流,回了清单的图不再被它看见;别的腿此刻可能正健康,
    /// 等下一次偶然的 hello 才换腿是真丢时效)。**惩罚不清**(§5.1 两轴正交:penalty
    /// 独立于 socket 代次),lan 侧一概不动——普通中转断线连 LanReady 都不撤(不变量 6)。
    ///
    /// 真调用点(L-c2a)= `run` 里每次 `session` 收场之后。此刻本机一条腿都没有,
    /// 返回的重问帧发不出去被丢——**这不是漏洞**:重连时 `on_relay_session_up` 会把
    /// 全部 `missing_blobs` 重新广播 want,清单里的图不会失去触发器(有 lan 腿之后
    /// 它们才真送得出去,L-c2b)。
    pub fn on_relay_session_down(&mut self) -> Vec<Output> {
        self.relay_session = None;
        let back = self.invalidate_pulls(|p| p.route == Route::Relay);
        self.drop_connectivity(Route::Relay);
        rewant(back)
    }

    /// 服务器说某对端上线(§6 对端级,三轮 M1):`(X, Relay) = Up` 需要「本机会话在 ∧
    /// X 在线」两层同时成立——**无活跃会话时这条是 no-op**(实现审 M2:否则「先补喂
    /// 在线表、后建会话」的接线会造出指向不存在中转的路由,选路照它发帧)。连接态只由
    /// 这条事件置位,**不许拿「收到过它的帧」当在线证据**(mail 可能来自信箱,发送者
    /// 早已离线)。
    pub fn on_relay_peer_up(&mut self, peer: &str) -> Vec<Output> {
        let Some(generation) = self.relay_session else { return vec![] };
        let back = self.mark_route_up(peer, Route::Relay, generation);
        rewant(back)
    }

    /// 服务器说某对端离线 / 定向 direct 帧被 Nack(§6 对端级):**仅**该对端的 relay
    /// 置 Absent + 仅作废它的 relay 在飞拉流(作废的图当场重发 want,同 H2);它的 lan
    /// 腿与两条腿的惩罚都不动。
    pub fn on_relay_peer_down(&mut self, peer: &str) -> Vec<Output> {
        let back = self.invalidate_pulls(|p| p.from == peer && p.route == Route::Relay);
        self.route_down(peer, Route::Relay);
        rewant(back)
    }

    /// 局域网链路建立(§6):置位该腿的连接态与代次,**不清任何既有态**;输出一帧
    /// 定向 Hello 走该链路(`Require(Lan)`)——两端水位互换不依赖中转在不在;若这是
    /// glare 换代,旧代在飞拉流作废并当场重发 want(H2)。
    ///
    /// 调用点 = L-c2c 的 lan 链路集(握手成功、§7 仲裁选定活链之后);**先通报引擎、
    /// 后让新链进发送表**(§6 三条代次契约之二)。
    ///
    /// **可能失败的那一半先算**(实现审 H2):`make_hello` 要读库,读崩就整笔 `Err` ——
    /// 调用方此路会放弃这条链(它压根没进发送表)。若先动了路由表,引擎就留下一条
    /// 「以为在、其实没有」的死腿:mail 没有 stale 定时器兜底,选路此后一直往它投,
    /// 直到偶然的断链通报或撤台才解。与 L-c2b「先备好回帧再落库」同一条纪律——**改
    /// 状态之前先把会失败的事做完**。
    pub fn on_lan_link_up(
        &mut self,
        conn: &Connection,
        peer: &str,
        generation: u64,
    ) -> Result<Vec<Output>, String> {
        let hello = self.make_hello(conn, peer, Route::Lan)?;
        let back = self.mark_route_up(peer, Route::Lan, generation);
        let mut out = rewant(back);
        out.extend(hello);
        Ok(out)
    }

    /// 局域网链路断开(§6):只作废**该代次**上的 lan 在飞拉流(作废的图当场重发
    /// want,同 H2),连接态仅在当前代次正是它时才置 Absent——glare 替换后旧代链路的
    /// 迟到断链通报不许打掉新链(§7);惩罚保留(干净断链只服从拨号退避)。
    /// 调用点同 [`Engine::on_lan_link_up`](并含「入队失败即断链」那一路,§5 故障隔离)。
    pub fn on_lan_link_down(&mut self, peer: &str, generation: u64) -> Vec<Output> {
        let back = self.invalidate_pulls(|p| {
            p.from == peer && p.route == Route::Lan && p.generation == generation
        });
        if self.route_up_generation(peer, Route::Lan) == Some(generation) {
            self.route_down(peer, Route::Lan);
        }
        rewant(back)
    }

    /// 传输层发现**引擎以为在、链路集里却没有**那条 lan 腿(§6「`Require` 送不出必随即
    /// 通报该路由 down」的兜底口)。与 [`Engine::on_lan_link_down`] 的差别只有一处:
    /// **不问代次**——调用方手上根本没有代次可报(它连链路对象都没找到)。
    ///
    /// 存在意义(实现审 H2):死腿的成因不止一种(移交半途失败、断链通报丢了、撤位与
    /// 建链交错),而 mail 没有 stale 定时器兜底;要是这里也按代次匹配,那条谁也报不出
    /// 代次的死腿就永远清不掉。宁可多断一次(下一枚握手重建即可),不留黑洞。
    pub fn on_lan_leg_missing(&mut self, peer: &str) -> Vec<Output> {
        let back = self.invalidate_pulls(|p| p.from == peer && p.route == Route::Lan);
        self.route_down(peer, Route::Lan);
        rewant(back)
    }

    /// 当前中转会话的代次(`None` = 本机会话不在)。
    ///
    /// **唯一用途是 `unknown_device` 的跨代探针**(lan-direct-plan §6.1 八轮 H1):
    /// 「首次记下代次不取消工作、更晚一代再撞才取消」要一个两侧都认的代次轴,而引擎的
    /// `relay_generation` 恰是「第几条已鉴权会话」的单一真相源(会话仪式 +1)。
    pub fn relay_session_generation(&self) -> Option<u64> {
        self.relay_session
    }

    /// 传输层触发的定向 Hello(§2 公钥收敛 / §5 断网期水位互换 / lan 链路建立):
    /// 路由钉死,绝不因「中转在线」而改道——权威通告与 lan 互换是两件不同的事。
    /// 调用点:公钥收敛的定向回 Hello(L-c2b,`Route::Relay`)/ 断网期 60s 低频重发与
    /// lan 链路建立(L-c2c,`Route::Lan`)。
    ///
    /// **广播与定向 Hello 的唯一构造点**(第⑤笔把会话仪式那份内联构造并了进来)。返回
    /// `Vec` 而不是单枚:水位游标满额时要顺带带出一条 advisory(见下)。
    pub fn make_hello(
        &self,
        conn: &Connection,
        to: &str,
        route: Route,
    ) -> Result<Vec<Output>, String> {
        let (watermarks, notice) = self.hello_watermarks(conn, to)?;
        let mut out: Vec<Output> = notice.into_iter().collect();
        out.push(Output::Send {
            to: to.into(),
            lane: Lane::Mail,
            route_hint: RouteHint::Require(route),
            msg: Msg::Hello { watermarks, lan: None },
        });
        Ok(out)
    }

    /// 出站 Hello 的水位图:**预算内子集 + 轮转**(§6.2 ⑤;第①笔后半的
    /// [`ops_serve::bounded_watermarks`] 到这里才第一次有生产调用者)。
    ///
    /// 换掉的是 `GROUP BY origin` 全表扫(设计期实测 500 万行 2000 origin 下 157.8 ms,
    /// **而且是持着库锁在协调者里跑的**)+ 完整 collect 进 Hello —— 既是内存无界面也是
    /// 延迟面。缺席按 0 是安全侧:没带上的 origin 对端只会**多给**,不会误以为我齐了。
    ///
    /// **游标满额取不到时发一枚安全的空 map 并报一次 overload**(§6.2 ⑥ 的三选一取第三
    /// 种):空 map 仍严格有界;另两种——session-fatal 会让会话仪式陷入重连循环,拒发本枚
    /// Hello 则是静默停摆。
    ///
    /// 锁序:调用方手里本就有 `&Connection`(db 已持),这里再取 work = **db → work**。
    /// 持 work 期间只读那把已在手的连接,不新取任何锁,也没有 `.await`。
    fn hello_watermarks(
        &self,
        conn: &Connection,
        to: &str,
    ) -> Result<(BTreeMap<String, i64>, Option<Output>), String> {
        let tick = self.tick;
        let mut works = ops_serve::lock_ops(&self.ops);
        let Some(cursor) = works.hello_cursor(to, tick) else {
            drop(works);
            return Ok((BTreeMap::new(), Some(ops_notice(to, OpsNoticeClass::Overload))));
        };
        let map = ops_serve::bounded_watermarks(
            conn,
            cursor,
            ops_serve::OPS_WATERMARK_BYTES_PER_TARGET,
        )?;
        Ok((map, None))
    }

    // ---- 路由健康表(§5.1;表里没有的条目 = Absent 且无惩罚) --------------------------

    /// 取(或建)一条 (对端, 路由) 的状态。**只在置位路径上调**——置 Absent 的路径走
    /// [`Engine::route_down`],它不为陌生对端建条目:表的规模因此恒 = 「当前 Up 的腿
    /// + 惩罚未到期的腿」,惩罚 5 分钟自然到期即清,无增长面。
    fn route_mut(&mut self, peer: &str, route: Route) -> &mut RouteState {
        self.routes.entry((peer.to_string(), route)).or_insert_with(RouteState::absent)
    }

    /// 置位一条腿(Up + 代次)。**换代即作废该腿上旧代的在飞 transfer**——glare 替换
    /// (§7「替换 incumbent 前先作废旧代全部在飞 transfer」)与「断链通报丢了、直接收到
    /// 新链」两路都在这里收口:transfer 只认自己的代次,腿一换就整笔重来,绝不让块跨
    /// 两代链路拼接。不变量守在持有者(引擎)这一侧,不靠调用方按顺序补 link_down。
    fn mark_route_up(&mut self, peer: &str, route: Route, generation: u64) -> Vec<String> {
        let back =
            self.invalidate_pulls(|p| p.from == peer && p.route == route && p.generation != generation);
        self.route_mut(peer, route).connectivity = Connectivity::Up { generation };
        back
    }

    /// 置 Absent(条目不在就不建;落到「Absent 且无惩罚」即整条删,表不留垃圾)。
    fn route_down(&mut self, peer: &str, route: Route) {
        let key = (peer.to_string(), route);
        if let Some(st) = self.routes.get_mut(&key) {
            st.connectivity = Connectivity::Absent;
            if *st == RouteState::absent() {
                self.routes.remove(&key);
            }
        }
    }

    /// 该腿现在 Up 吗——是则给出代次(transfer 绑定用)。
    fn route_up_generation(&self, peer: &str, route: Route) -> Option<u64> {
        match self.routes.get(&(peer.to_string(), route))?.connectivity {
            Connectivity::Up { generation } => Some(generation),
            Connectivity::Absent => None,
        }
    }

    /// §5 例外③的判据:**该对端的中转腿此刻不可达,而它的 lan 腿在** = 定向 mail 要沿
    /// 那条链路补投一份(中转那份照发不误——mail 进信箱是唯一副本路,不变量 1)。
    ///
    /// 判据出口只此一个(与 [`Engine::lan_backfill_peers`] 同源):路由健康表是**引擎的
    /// 事实**,传输层不许自存一份「谁的中转腿通着」的视图——两份必漂,而漂的后果是
    /// 「中转在线时也往 lan 平行投一份」或「对端离线时谁也不补投」。
    pub fn lan_backfill(&self, peer: &str) -> bool {
        self.route_up_generation(peer, Route::Lan).is_some()
            && self.route_up_generation(peer, Route::Relay).is_none()
    }

    /// 广播 mail 的补投集合(§5:「对每个 `(对端,Relay)=Absent ∧ (对端,Lan)=Up` 的对端
    /// 补投」)。本机中转会话不在时全部对端的 relay 腿都是 Absent
    /// ([`Engine::on_relay_session_down`]),故**同一条规则**顺带覆盖了「本机中转离线:
    /// 全部 mail 走各 lan 链路」——传输层不需要第二套离线分支(一处一义)。
    ///
    /// 排序输出:调用方的投递顺序因此可复现(测试断言用)。
    pub fn lan_backfill_peers(&self) -> Vec<String> {
        let mut peers: Vec<String> = self
            .routes
            .iter()
            .filter(|((_, r), st)| {
                *r == Route::Lan && matches!(st.connectivity, Connectivity::Up { .. })
            })
            .map(|((peer, _), _)| peer.clone())
            .filter(|peer| self.route_up_generation(peer, Route::Relay).is_none())
            .collect();
        peers.sort();
        peers
    }

    /// 该腿的 blob 惩罚还在吗(§5.1:只挡 blob 选路,mail/Hello 照走)。
    fn blob_penalized(&self, peer: &str, route: Route) -> bool {
        self.routes
            .get(&(peer.to_string(), route))
            .and_then(|st| st.blob_penalty_until)
            .is_some_and(|until| until > self.tick)
    }

    /// 罚一条腿的 blob 选路 [`BLOB_PENALTY_TICKS`] 个心跳(§5.1)。
    fn penalize_blob(&mut self, peer: &str, route: Route) {
        let until = self.tick + BLOB_PENALTY_TICKS;
        self.route_mut(peer, route).blob_penalty_until = Some(until);
    }

    /// 某一维度整体重置(relay 会话重连):连接态清空 + 惩罚清空 + 该维度的 per-image
    /// shun 清空。**只清点名的那条腿**。
    fn reset_route_dimension(&mut self, route: Route) {
        self.routes.retain(|(_, r), _| *r != route);
        for shunned in self.blob_shunned.values_mut() {
            shunned.retain(|(_, r)| *r != route);
        }
        self.blob_shunned.retain(|_, s| !s.is_empty());
    }

    /// 某一维度只丢连接态(中转会话断):惩罚照留(两轴正交)。
    fn drop_connectivity(&mut self, route: Route) {
        let peers: Vec<String> = self
            .routes
            .iter()
            .filter(|((_, r), _)| *r == route)
            .map(|((p, _), _)| p.clone())
            .collect();
        for peer in peers {
            self.route_down(&peer, route);
        }
    }

    /// 作废在飞拉流:选中的整笔丢弃、图退回缺字节清单。**同一 transfer 的块永不跨
    /// 链/跨路**(§5.1),故路由失效只能整笔重来、不迁移。返回退回清单的图——调用方
    /// **必须**为它们发新一轮 want([`rewant`]):清单里的图没有任何定时器看着
    /// (`on_tick` 只管在飞拉流),不当场问就只能等下一次偶然的 hello(实现审 H2)。
    #[must_use]
    fn invalidate_pulls(&mut self, pred: impl Fn(&Pull) -> bool) -> Vec<String> {
        let back: Vec<String> = self
            .pulling
            .iter()
            .filter(|(_, p)| pred(p))
            .map(|(image_id, _)| image_id.clone())
            .collect();
        for image_id in &back {
            self.pulling.remove(image_id);
            self.missing_blobs.insert(image_id.clone());
        }
        back
    }

    /// 一笔拉流失败的统一收口(§5.1;实现审二轮 M2):作废 + shun (图, 对端, 腿) + 罚
    /// 该腿的 blob 选路 + 图回缺字节清单 + **当场重问**。三个来源共用——心跳判死的沉默
    /// 来源、坏块(错序/超量)、终局验货不过。
    ///
    /// **先 shun 再重问**是防即时循环的关键:重问引来的下一枚 have 若还是它、还是这条
    /// 腿,选路会跳过它(§5.1),故不会立刻再撞上同一个作恶者;而「只作废不重问」会让
    /// 图无限期停在清单里(`on_tick` 只看在飞拉流),健康的另一台/另一条腿也接不上。
    ///
    /// 验货 Err 的诚实边界:`replay::apply_image_bytes` 的 Err 既含坏字节也含本地故障
    /// (未分型),故本地故障会误罚一次——后果是「该图在该腿上 5 分钟内不选」且自动
    /// 到期,可接受;错误分型是 replay 层的另一件事。
    fn fail_pull(&mut self, image_id: &str, peer: &str, route: Route) -> Vec<Output> {
        self.pulling.remove(image_id);
        self.blob_shunned
            .entry(image_id.to_string())
            .or_default()
            .insert((peer.to_string(), route));
        self.penalize_blob(peer, route);
        self.missing_blobs.insert(image_id.to_string());
        rewant(vec![image_id.to_string()])
    }

    /// 缺字节清单的**唯一发问点**(§10 C′;264 实现审 H1/H2 后收成一处):从轮转游标起
    /// 取至多 [`BLOB_WANT_BATCH`] 张缺图,各广播一枚 `BlobWant`。
    ///
    /// 它同时办两件事:
    /// * **补给**——收端窗口封到 [`MAX_ACTIVE_PULLS`] 之后,「清单里还剩几张」不再靠
    ///   「每张各起一笔」自然推进,得有人推下一张(「回清单必配一次重新选路」那条纪律
    ///   的延长线:清单里的图**没有任何定时器看着**)。窗口没空位就一枚都不问——问了
    ///   引来的 have 也只会被窗口挡掉。
    /// * **封住突发**——原先 hello / 会话仪式 / 新 image_add 各自遍历全量清单,一次能产
    ///   出几百枚帧,撞穿每链 256 帧的队列(实现审 H2)。这里一次最多 32 枚。
    ///
    /// **轮转游标**而不是恒取最小:某张图在所有腿上都被 shun / 都没人有的时候,恒取最小
    /// 会把后面的永久挡住;轮转让清单里每张都在 ⌈N/32⌉ 轮内问到。
    ///
    /// 四处钩子,都在既有出口上(**不新增生命周期入口**,§6 七入口不变):
    /// [`Engine::on_hello`] / [`Engine::on_relay_session_up`] / [`Engine::on_msg`] 出口
    /// (槽由满转空,或本轮清单里多了新图)/ [`Engine::on_tick`] 出口(活性网——快路问
    /// 的那张若根本没人有,就再没有下一枚帧来触发快路了)。
    /// [`Engine::want_batch`] 追加进一批已有输出,并**按图 id 去重**(实现审 L1):deny /
    /// 坏块 / 路由失效那几条出口自带「回清单必配重问」,与这一批重叠时会对同一张图连发
    /// 两枚。凡是「已有输出 + 补一批」的出口一律走这里,别再各写各的——二轮 L1 抓到的
    /// 正是 `on_tick` 那处漏了去重。
    fn append_want_batch(&mut self, out: &mut Vec<Output>) {
        let batch = self.want_batch();
        let already: HashSet<String> =
            out.iter().filter_map(want_image_of).map(str::to_string).collect();
        let fresh: Vec<Output> = batch
            .into_iter()
            .filter(|o| !want_image_of(o).is_some_and(|i| already.contains(i)))
            .collect();
        out.extend(fresh);
    }

    #[must_use]
    fn want_batch(&mut self) -> Vec<Output> {
        if self.pulling.len() >= MAX_ACTIVE_PULLS || self.missing_blobs.is_empty() {
            return vec![];
        }
        let mut ids: Vec<&String> = self.missing_blobs.iter().collect();
        ids.sort();
        let start = (self.want_cursor % ids.len() as u64) as usize;
        let picked: Vec<String> = (0..BLOB_WANT_BATCH.min(ids.len()))
            .map(|k| ids[(start + k) % ids.len()].clone())
            .collect();
        self.want_cursor = self.want_cursor.wrapping_add(picked.len() as u64);
        rewant(picked)
    }

    /// blob 选路(§5.1 表驱动):**LAN 优先**,取第一条「连接态 Up ∧ 无 blob 惩罚 ∧
    /// 该图未 shun 这条腿」的腿。一条都没有 = 不拉(图留在缺字节清单等下次
    /// want/hello),**绝不「先试服务器再靠 Nack 学状态」**、绝不凭空走中转。
    fn pick_blob_route(&self, peer: &str, image_id: &str) -> Option<(Route, u64)> {
        for route in [Route::Lan, Route::Relay] {
            let Some(generation) = self.route_up_generation(peer, route) else { continue };
            if self.blob_penalized(peer, route) {
                continue;
            }
            let shunned = self
                .blob_shunned
                .get(image_id)
                .is_some_and(|s| s.contains(&(peer.to_string(), route)));
            if shunned {
                continue;
            }
            return Some((route, generation));
        }
        None
    }

    /// 传输层心跳时调用(M1;§5.1 扩两件事):
    /// ① **惩罚到期**:清 penalty + 清该 (对端, 路由) 的 per-image shun——只影响未来
    ///    transfer,不迁移正在正常进行的;
    /// ② **拉流无进展**:连续 [`PULL_STALE_TICKS`] 次仍无块 = 对端应了 BlobHave 却沉默
    ///    (恶意或 bug / lan 半死链路),作废本次拉流 + shun 这条 (对端, 路由) + 罚该腿
    ///    的 blob 选路,图退回清单并当场重发 want——下一枚 BlobHave 到时按表重选别的
    ///    健康腿(§5.1「重选其它健康 (device, route)」;没有健康腿就留在清单等,不凭空走)。
    ///
    /// **心跳必须由运行时驱动而非中转会话**(不变量 6):否则断 WAN 期间惩罚永不到期、
    /// lan 半死链路的图永远换不了腿(L-c2 接线契约)。
    pub fn on_tick(&mut self) -> Vec<Output> {
        self.tick += 1;
        // ① 先清到期惩罚:本 tick 新罚的 until = tick + N,不会当场被自己清掉。
        let expired: Vec<(String, Route)> = self
            .routes
            .iter()
            .filter(|(_, st)| st.blob_penalty_until.is_some_and(|until| until <= self.tick))
            .map(|(key, _)| key.clone())
            .collect();
        for (peer, route) in expired {
            let key = (peer.clone(), route);
            if let Some(st) = self.routes.get_mut(&key) {
                st.blob_penalty_until = None;
                if *st == RouteState::absent() {
                    self.routes.remove(&key);
                }
            }
            for shunned in self.blob_shunned.values_mut() {
                shunned.remove(&(peer.clone(), route));
            }
            self.blob_shunned.retain(|_, s| !s.is_empty());
        }
        // ② 无进展拉流。**「无进展」在 264 之后才是真有牙的**:块形严格校验之后,每一枚
        //    被收下的块都必然推进整整一块(末块除外,而末块即终局),故这道 idle 闸同时就
        //    是「最低有效进度」规则 —— 每 [`PULL_STALE_TICKS`] 拍至少一块 = 至少 256 KiB / 60s;
        //    整笔因此封顶在 O(块数) 拍,与图的大小成正比。刻意**不再另设一条整笔死线**:
        //    它在这条规则之下不可达(不可达 = 无法用变异对照证伪的死码),而设成可达的又会
        //    把慢链上的大图掐死、掐了从头重来 = 慢链上永不完成。**残余诚实记账**:一台坏
        //    实现确实能以这个最低速率把收端那唯一一个窗口占满整笔时长;那要求它真的在传
        //    字节,且是账户内成员才做得到的事(§9 明说不防成员以自己身份作恶),传完即放。
        let mut stale: Vec<(String, String, Route)> = vec![]; // (image_id, 来源, 路由)
        for (image_id, pull) in self.pulling.iter_mut() {
            pull.stale_ticks += 1;
            if pull.stale_ticks >= PULL_STALE_TICKS {
                stale.push((image_id.clone(), pull.from.clone(), pull.route));
            }
        }
        let mut out = vec![];
        for (image_id, source, route) in stale {
            out.extend(self.fail_pull(&image_id, &source, route));
        }
        // ③ 缺字节清单的发问(§10 C′):空槽 + 清单非空 = 推一格游标再问一批。这是发问
        //    的**活性网**——快路(`on_msg`)问的那批若根本没人有,就再没有下一枚帧来触发
        //    它了。走 `append_want_batch` 而不是直接 extend:上面 `fail_pull` 刚为超时那张
        //    发过一枚重问,同图不许再来一枚(实现审二轮 L1)。
        self.append_want_batch(&mut out);
        out
    }

    /// 本地写命令提交后调用:把本机新 op 里「让图死掉」的两种(删图 / 删宿主条目)
    /// 从缺字节清单与在飞拉流里摘掉(lan-direct-plan §6,L-c1 实现审 L1)。
    ///
    /// **为什么非有不可**:远端来的 tombstone 走 `on_msg` 顺手就清了,本地删除**不经
    /// 引擎**——引擎随会话生灭时靠「下次装配重新 derive」兜住,引擎活到 runtime 生命期
    /// 之后这条兜底没了,死图会永远赖在清单里,每次会话仪式都对它广播一遍谁也答不了的
    /// want(不丢数据,但是噪音 + 每次重连都白问一轮)。**刻意不靠恢复「每次重连全库
    /// 重新 derive」**(那会把在飞拉流的图塞回清单,破「清单与在飞互斥」,
    /// `on_runtime_started` 二次调用因此响亮报错)。
    ///
    /// 游标 [`Engine::local_settled`] 单调只进,扫描窗口一律 `(local_settled, max]`
    /// ——两端同一把 `conn`,窗口内不会有新 op 挤进来。
    pub fn on_local_ops_settled(&mut self, conn: &Connection) -> Result<(), String> {
        let max = watermark(conn, &self.device_id)?;
        if max <= self.local_settled {
            return Ok(());
        }
        let mut stmt = conn
            .prepare(
                "SELECT kind, entity_id FROM oplog \
                 WHERE origin = ?1 AND origin_seq > ?2 AND origin_seq <= ?3 \
                   AND ((entity = 'image' AND kind = 'image_tombstone') \
                     OR (entity = 'item' AND kind = 'tombstone')) \
                 ORDER BY origin_seq",
            )
            .map_err(|e| e.to_string())?;
        let dead: Vec<(String, String)> = stmt
            .query_map(rusqlite::params![&self.device_id, self.local_settled, max], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        for (kind, entity_id) in dead {
            if kind == "image_tombstone" {
                self.forget_image(&entity_id);
            } else {
                for img in images_of_item(conn, &entity_id)? {
                    self.forget_image(&img);
                }
            }
        }
        self.local_settled = max;
        Ok(())
    }

    /// 一张图彻底出局(死了或已到齐):缺字节清单、在飞拉流、per-image shun 三处
    /// 同时清干净。**唯一出口**——本地删除(`on_local_ops_settled`)与远端 tombstone
    /// (`on_msg`)共用,免得两边各清各的、漏掉某一处(shun 表就是这么在长寿命引擎里
    /// 攒垃圾的)。
    fn forget_image(&mut self, image_id: &str) {
        self.missing_blobs.remove(image_id);
        self.pulling.remove(image_id);
        self.blob_shunned.remove(image_id);
    }

    /// 本地写命令提交后调用:把 last_pushed 之后的本机新 op 广播出去(§5.2 实时推送)。
    /// 游标的复位口只有 [`Engine::on_relay_session_up`](会话仪式的一部分,实现审 H1)。
    ///
    /// **断中转期间也照调**(L-c2c 对验收项② 的收口):此刻这些帧走 lan 腿(§5「本机中转
    /// 离线:全部 mail 走各 lan 链路」)。刻意**不给 lan 另立一根游标**——
    /// * 不变量 2 说的是 `sync_meta.last_pushed` 那个**持久**游标(「服务器已接手」),它
    ///   只由服务器 Ack 落库,lan 投递碰不到它;
    /// * 内存游标每次 `on_relay_session_up` 都复位回**已 ack 位**,故断网期间乐观推进过的
    ///   op 在中转恢复后照样重推一遍,一条也不会因为「已经走过 lan」而从中转路上漏掉;
    /// * 乐观推进(无 ack 可依)丢帧的兜底与 relay 路同一条论证:正确性恒靠双向 hello
    ///   水位互补,游标只是流量优化。
    ///
    /// 至于**冷启动设备的存量 op**:`Engine::new` 把游标置成本机水位,故纯 lan 腿上不会
    /// 主动推存量——那部分靠链路建立时的双向定向 Hello 互换水位、对端 Want 拉齐(慢一拍
    /// 但正确;L-c2c 明示接受这个形)。
    ///
    /// **第⑤笔起不再当场物化帧**(§6.2 ③):这里只把「本机 origin 从 `last_pushed+1` 起
    /// 还欠着」这条义务登记进 BROADCAST work,帧由投递面逐帧惰性取。原先那一句
    /// `ops_frames(…, BROADCAST)` 没有帧数与字节上界——一次本地批量写就能吐出任意多枚
    /// `Ops` 帧、同一次 dispatch 全部入队,撞穿每链 256 帧 / 8 MiB。
    ///
    /// 上界不必在这里给:Range 只记**起点**,上界由取数那一刻自己的水位说了算,故后续
    /// 新写的 op 自动含在同一段里(这也是「`Overload` 之后下一拍自己回来」成立的原因)。
    pub fn outbound(&mut self, conn: &Connection, out: &mut Vec<Output>) -> Result<(), String> {
        let max = watermark(conn, &self.device_id)?;
        if max <= self.last_pushed {
            return Ok(());
        }
        let (from_seq, tick, me) = (self.last_pushed + 1, self.tick, self.device_id.clone());
        let admitted = ops_serve::lock_ops(&self.ops).on_want(BROADCAST, &me, from_seq, tick);
        match admitted.admit {
            Admit::Ok => {
                // **登记成了才推进**「已登记到哪」这根内存游标(§6.2 ⑥-1):`Overload` 那一
                // 档一步都不动,故下一拍 `ops_tick` 拿本机水位重新一比,这笔义务自己回来
                // ——不存重试队列、不记债(⑥-2「每拍从持久事实重新派生」)。
                self.last_pushed = max;
                if admitted.woke {
                    out.push(Output::ServeOps(OpsServe { to: OpsServeTo::Broadcast }));
                }
                Ok(())
            }
            Admit::Overload => {
                out.push(ops_notice(BROADCAST, OpsNoticeClass::Overload));
                Ok(())
            }
            // §6.2 ③′ 那张表里 `outbound` 的两格不可达,**写成响亮断言而不是业务处置**:
            // `Collapsed` 要凑够第 17 个 gap,而这里只有一个规范的本机 origin、同 origin
            // 的 Range 只会取更早的下界;`Malformed` 三项(target=BROADCAST 常量、origin=
            // 库里的本机设备 id、`from_seq = last_pushed + 1 ≥ 1`)全不由线上输入决定。
            a => Err(format!("内部错:本机 outbound 的追赶登记回了 {a:?}")),
        }
    }

    /// 定向入口(`on_hello` / `on_want`)收下一枚请求之后的统一处置(§6.2 ③ 的四档表)。
    ///
    /// **刻意不返回 `Result`**:③″ 要求 admission 之后不得再有能绕过输出缓冲的 `?`,
    /// 而「这个函数里没有 `?` 可写」比「记得别在这里写 `?`」强一档 —— 前者是结构,
    /// 后者是自律。
    fn settle_ops_admission(
        &mut self,
        from: &str,
        route: Route,
        admitted: Admitted,
        malformed: impl FnOnce() -> String,
        out: &mut Vec<Output>,
    ) {
        match admitted.admit {
            Admit::Ok => {}
            Admit::Collapsed => out.push(ops_notice(from, OpsNoticeClass::Collapsed)),
            // **准确说法**(§6.2 ③ 二轮 M4):这枚逻辑请求被**丢弃**了,不是「收下了只是
            // 慢」。远端 overload 是 §10 已接受的资源拒绝边界——日后可能由重连、下一枚
            // Hello/Want 或别的对账事件恢复,但**没有短时或必然重发的保证**(稳定 relay
            // 会话里 Hello 不周期发送,发送者也看不出应用层丢了请求:外层 Ack 只证明服务器
            // 投递成功)。真正有恒在 owner 的只有本机 BROADCAST,由 `ops_tick` 每拍重试。
            Admit::Overload => out.push(ops_notice(from, OpsNoticeClass::Overload)),
            // **整枚帧拒收,一个字节都不留**(连 target 条目都不建),故没有铃要摇。
            // 这一格不是形式主义:`from` 与 `origin` 整条来自线上,而 `ServerMsg` 里它们
            // 仍是裸 `String`(sync-proto/src/lib.rs)。仓里「不可达的防护 = 死码」那条
            // 只适用于**类型或上游结构已证明不可能**的格,裸网络 `String` 不满足前提。
            Admit::Malformed => {
                out.push(Output::Event(Event::FrameRejected {
                    from: from.into(),
                    reason: malformed(),
                }));
                return;
            }
        }
        if admitted.woke {
            out.push(serve_ops_peer(from, route));
        }
    }

    /// 心跳那一拍的 ops 面(§6.2 ⑥)。两件事,顺序要紧:
    ///
    /// 1. **本机 origin 的追赶重新派生一次**——`Overload` 撞掉的那次登记只有这里补得回来
    ///    (`outbound` 那一档游标没动,故这一拍拿水位一比就自己回来了);
    /// 2. 冷却到点把 `deferred`/`pending` 提成可跑工作。(**收回让位不在这里** —— 那件事
///    排在 [`Deck::ops_tick`] 的第一句,不许挂在本函数跑不跑得成上。)
    ///
    /// **不再交名单**(codex 实现审二轮 L1):调用方每拍无条件扫一遍全表 idle-runnable,
    /// 精确名单已无人消费,理由记在 [`ops_serve::OpsWorks::on_tick`]。
    ///
    /// 快照 rowid **在这里取而不是由调用方传**(设计稿写的是传参):`conn` 本就在手上,
    /// 取数点只留一处(`ops_serve::snapshot_rowid`)就没有「调用方传了个陈旧值」这条路。
    ///
    /// **输出不蒸发**(③″ 第 4 条):`out` 是调用方的缓冲,故即使这里返回 `Err`,已经
    /// 写进去的描述符/advisory 仍在调用方手上,由它先 dispatch 再让错误收场。
    pub fn ops_tick(&mut self, conn: &Connection, out: &mut Vec<Output>) -> Result<(), String> {
        self.outbound(conn, out)?;
        let snapshot = ops_serve::snapshot_rowid(conn)?;
        let tick = self.tick;
        ops_serve::lock_ops(&self.ops).on_tick(tick, snapshot);
        Ok(())
    }

    /// 服务器报某台对端上线(§6.2 ⑦ 的第四件):只给 [`OpsWorks`] 发一枚一次性加速券。
    ///
    /// 规格写的是「**一律不摇铃**」(§6.2 ④):券不改变可跑性,效果在下一枚 Hello 或
    /// 下一拍心跳上兑现。**我落成「`woke` 为真才摇」,自曝这处与规格的字面差异**——
    /// 今天两者行为**逐字相同**(`on_peer_online` 只动 `bypass_once`,`has_runnable()`
    /// 一格不变,故 `woke` 结构上恒假),差别只在那个不可达的情形里:按 `woke` 走是**失效
    /// 于安全侧**(最坏多一次探库),写死不摇则是**丢**(工作永久没人取)。三个入口共用
    /// 同一条判据,也比「两个按 woke、一个例外」少一处会漂的特例。
    pub fn on_peer_online_ops(
        &mut self,
        device: &str,
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
        let tick = self.tick;
        let admitted = ops_serve::lock_ops(&self.ops).on_peer_online(device, tick);
        match admitted.admit {
            Admit::Ok => {}
            Admit::Overload => out.push(ops_notice(device, OpsNoticeClass::Overload)),
            // ⚠ 这一格 codex 给了明确处置(§6.2 ③′ S7):**保留统一 `vet_target`,别删也
            // 别写 `unreachable!()`** —— `ServerMsg::Peer.device` 在线协议类型里仍是裸
            // `String`,故畸形值在服务端漂移、错误实现或恶意服务端下真实可达。
            // 不建 target、不发券,**当作服务端协议漂移响亮结束当前 session**。
            Admit::Malformed => {
                return Err(format!("服务端报的上线设备 id 形态不合规范:{device}"))
            }
            // 券这条路只改冷却资格,不碰计划/水位图,故折叠不可达(§6.2 ③′)。
            Admit::Collapsed => return Err("内部错:发加速券回了 Collapsed".into()),
        }
        if admitted.woke {
            // peer-online 只从中转会话来,故来路恒是中转腿。
            out.push(serve_ops_peer(device, Route::Relay));
        }
        Ok(())
    }

    /// 收到一帧内层消息(from = 信封上的发送设备;AAD 校验在 P2-d 解密层;`route` =
    /// **来路**,由 socket 所有者构造的传输层内部事实,绝不取自对端字段)。
    /// Err 只用于本地故障(SQLite 等);对端的坏帧走 Event::FrameRejected,不使引擎崩溃。
    ///
    /// **来路亲和**(lan-direct-plan §5,二轮 M5 / 三轮 M4):**定向应答沿来路答**
    /// ——不查本地 peer online 缓存(它只是加速信号,不是正确性触发器)。落地为出口处
    /// 的统一改写,两条纪律各有边界:
    ///   * `direct` lane(blob 块 / deny)恒钉 `Require(来路)`——同一 transfer 的块永不
    ///     跨链跨路;路由中途失效即整笔作废重来(收端另有来路复核兜底)。
    ///   * `mail` lane 只有 **LAN 到达**才钉 `Require(Lan)`;中转到达的照 `Auto`——留着
    ///     §5 例外③「对端中转离线时补投 lan 链路」这条腿。
    ///   * **广播帧一律不改写**:补洞 want / 缺图 want / 本机新 op 是「该让所有人知道」,
    ///     不因某一帧的来路而窄化收件面。
    pub fn on_msg(
        &mut self,
        conn: &mut Connection,
        clock: &mut Clock,
        from: &str,
        route: Route,
        msg: Msg,
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
        // 缺字节清单的发问只在两个**边沿**上发(见 [`Engine::want_batch`]):槽由满转空
        // (在飞那笔结束了,该问下一张)、或本轮清单里多了新图(新贴的图该当场问)。不看
        // 边沿的话,「清单非空」期间每收一帧都要广播一批 want。
        let was_full = self.pulling.len() >= MAX_ACTIVE_PULLS;
        let missing_before = self.missing_blobs.len();
        // **缓冲是调用方的**(实现审三轮 H1):这枚帧处理到一半的本地故障,不该带走它
        // 此前已经**做成**的那些事的通知(隔离行已落表、槽已驱逐、翻案已落库)。故
        // `?` 换成把结果扣到最后——出口这两件(来路改写、发问边沿)照跑,再原样返回。
        let base = out.len(); // 改写只许作用在**本帧产出的那一段**上,别碰调用方原有的。
        let done = self.dispatch_msg(conn, clock, from, route, msg, out);
        for o in out.iter_mut().skip(base) {
            let Output::Send { to, lane, route_hint, .. } = o else { continue };
            if to == BROADCAST || *route_hint != RouteHint::Auto {
                continue;
            }
            if *lane == Lane::Direct || route == Route::Lan {
                *route_hint = RouteHint::Require(route);
            }
        }
        // 发问收在**改写之后**(§10 C′):want 恒是广播 `Auto`,不该被这枚帧的来路窄化
        // (广播本就跳过改写,顺序只是把这件事写明白)。
        //
        // 失败路径上也照跑:这两个边沿**只此一次**(下一枚帧的 `missing_before` 已是新
        // 值),错过就得等下一次偶然的满转空或新图。
        if was_full || self.missing_blobs.len() > missing_before {
            self.append_want_batch(out);
        }
        done
    }

    /// 隔离重验还有余量吗(L-d‴ 实现审 H1/H2)——**续做由心跳驱动**,这是它的判据口。
    ///
    /// 一轮曾把续做钩在 `on_msg` 出口上,三条都不成立:
    /// * **`on_msg` 不是恒在时间轴**:一批全是 `InvalidOp` 时只抬版本、不产 want,链路
    ///   稳定又没有新业务帧的话,此后再没有 `on_msg`,余量永久躺住;
    /// * **一枚线帧会进 `on_msg` 好几次**:`Deck::feed` 把 >100 条的 ops 帧按
    ///   `OPS_LOCK_BATCH` 切成子批逐批喂,故「每次调用 16 行」≠「每枚线帧 16 行」,
    ///   500 条的合法帧能触发五批、叠上各自的 `BLOB_WANT_BATCH`,撞 256 帧上界;
    /// * **错误会连坐**:续做的 `?` 会把这枚帧自己**已经处理成功**的输出一起吞掉。
    ///
    /// 挂心跳三条同时消解:恒在、每拍至多一批、与帧处理不相干。**不新增生命周期入口**
    /// ——`reverify_quarantined` 本就是 transport 在调的公开方法,只是多一个调用点。
    ///
    /// **为什么不必并上 [`Engine::settle_pending`]**(想过,不写死码):`settle_pending`
    /// 只可能在 `reverify_quarantined` 里被置起来,而那个函数**开头就无条件**把
    /// `reverify_backlog` 置成 true,末尾那句准确赋值又只在「结算块整个跑完(位子已清)」
    /// 时才到得了。故 `settle_pending == true ⟹ reverify_backlog == true`,或上去的那一
    /// 位**恒不可达**——264 判过同一条:不可达的防护就是死码。
    ///
    /// 代价是这个门槛的正确性依赖远处那句保守置位,故由
    /// `reverify_still_owes_a_drain_after_the_row_is_gone` 直接钉住「drain 失败之后这里
    /// 必须还是 true」——**不变量靠测试钉,不靠冗余代码兜**。
    pub fn needs_reverify_tick(&self) -> bool {
        self.reverify_backlog
    }

    /// 上一批**在 SQL 侧**取满了吗(测试用的窄查询;生产的门槛口是
    /// [`Engine::needs_reverify_tick`]——cfg(test) 是刻意的,免得两个同义方法各被用一半)。
    #[cfg(test)]
    pub(crate) fn has_reverify_backlog(&self) -> bool {
        self.reverify_backlog
    }

    fn dispatch_msg(
        &mut self,
        conn: &mut Connection,
        clock: &mut Clock,
        from: &str,
        route: Route,
        msg: Msg,
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
        match msg {
            Msg::Ops { origin, ops } => self.on_ops(conn, clock, from, origin, ops, out),
            // `lan` 在此刻意不看:通告缓存的写入权归传输层(lan-direct-plan §2——只有
            // 经中转 deliver 到达的帧才算权威路,而「来路」是 socket 所有者的事实,
            // 引擎不该拿它当缓存依据)。水位处理与它无关,照常走。
            Msg::Hello { watermarks, lan: _ } => self.on_hello(conn, from, route, &watermarks, out),
            Msg::Want { origin, from_seq } => {
                self.on_want(from, route, &origin, from_seq, out);
                Ok(())
            }
            Msg::BlobWant { image_id } => spill(out, on_blob_want(conn, from, &image_id)),
            Msg::BlobHave { image_id } => spill(out, self.on_blob_have(conn, from, &image_id)),
            Msg::BlobPull { image_id, transfer } => {
                spill(out, on_blob_pull(conn, from, route, &image_id, &transfer))
            }
            Msg::BlobDeny { image_id, transfer } => {
                out.extend(self.on_blob_deny(from, route, &image_id, &transfer));
                Ok(())
            }
            Msg::BlobChunk { image_id, transfer, idx, last, data } => spill(
                out,
                self.on_blob_chunk(conn, from, route, &image_id, &transfer, idx, last, data),
            ),
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
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
        // 冻结的 origin 静默丢(冻结时刻已报过一次,不刷屏)。
        if self.frozen.contains_key(&origin) {
            return Ok(());
        }
        // 持久隔离的 origin 帧到即丢(§4);只把 relay_from_last 坐标记下——「最近
        // 一次还有谁在递它」是运营者双坐标裁断的另一半。
        if self.quarantined.contains(&origin) {
            conn.execute(
                "UPDATE sync_quarantine SET relay_from_last = ?2 WHERE origin = ?1",
                (&origin, from),
            )
            .map_err(|e| e.to_string())?;
            return Ok(());
        }
        // poison-breaker(§4 fail-closed):置位后拒收一切**新** origin 的帧(已在册
        // = 本地日志已有其 op 的 origin 照常)。同 origin 每会话只报一次。
        //
        // **冻结表到顶时闸口升级**(L-c2a 实现审 H1):此刻已无处安全记录新的分叉,
        // 故连「已在册」也不再放行——走到这一行说明该 origin 既不在冻结表也不在隔离
        // 表,放它进去只会让分叉再也拦不住。这一刀让 [`FROZEN_CAP`] 成为真上界。
        if let Some(breaker_reason) = self.breaker.clone() {
            if watermark(conn, &origin)? == 0 || self.frozen.len() >= FROZEN_CAP {
                if self.breaker_reported.insert(origin.clone()) {
                    out.push(Output::Event(Event::FrameRejected {
                        from: from.into(),
                        reason: format!(
                            "poison-breaker 已置位({breaker_reason}):拒收 origin {origin} 的帧"
                        ),
                    }));
                }
                return Ok(());
            }
        }
        // 入池前硬校验(§5.3,评审①-H2):任一不合 → 整帧拒收,不进 pending。
        if let Err(reason) = validate_frame(&origin, &ops) {
            out.push(Output::Event(Event::FrameRejected { from: from.into(), reason }));
            return Ok(());
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
                    return self.freeze(conn, &origin, reason, out);
                }
                if replay::logged_op_matches(conn, op)? != Some(true) {
                    let reason = format!(
                        "本机 origin 分叉:对端持有的 op {}(seq {})与本机日志不符(本机身份曾被回滚或克隆)",
                        op.op_id, op.origin_seq
                    );
                    return self.freeze(conn, &origin, reason, out);
                }
            }
            return Ok(());
        }

        // 时钟偏斜提示(§11 SHOULD,L1):远端 op 的 HLC 墙钟比本机快 >24h,每会话报一次。
        // 只看跨 origin 帧(本机回声上面已返回);validate_frame 已保证 hlc 可解析。
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
                out.push(Output::Event(Event::ClockSkew { ahead_hours }));
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
                return self.freeze(conn, &origin, reason, out);
            }
            // seq > 水位却撞上日志(同 op_id 或同 hlc):已应用者的坐标必 ≤ 水位,
            // 同一身份/同一时刻声称两个坐标 = 分叉。
            if replay::logged_op_matches(conn, &op)?.is_some() {
                let reason = format!(
                    "origin 分叉:op {} 已在日志(坐标必 ≤ 水位),又以 seq {} 到达",
                    op.op_id, op.origin_seq
                );
                return self.freeze(conn, &origin, reason, out);
            }
            let hlc_owner: Option<String> = conn
                .query_row("SELECT op_id FROM oplog WHERE hlc = ?1", [&op.hlc], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(k) = hlc_owner {
                let reason =
                    format!("origin 分叉:hlc {} 已记 op {k},又收到 {}", op.hlc, op.op_id);
                return self.freeze(conn, &origin, reason, out);
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
                Pool::Fork(reason) => return self.freeze(conn, &origin, reason, out),
                Pool::Duplicate => continue,
                Pool::Insert => {
                    self.slot_insert(
                        conn,
                        &origin,
                        PendingOp { op, relay_from: from.into() },
                        out,
                    )?;
                }
            }
        }
        self.drain(conn, clock, out)?;
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
            // 与 `slot_insert` 的驱逐同一条(实现审四轮 H3):**先查水位、再拆槽**。
            // 反过来排的话,查询一失败槽已经没了,而这枚 want 是此刻唯一的重取信号
            // ——上一行注释自己写着「槽没了,emit_wants 看不见这个缺口」。
            let need = watermark(conn, &origin)? + 1;
            self.slots.remove(&origin);
            out.push(Output::Send {
                to: BROADCAST.into(),
                lane: Lane::Mail,
                route_hint: RouteHint::Auto,
                msg: Msg::Want { origin: origin.clone(), from_seq: need },
            });
        }
        self.emit_wants(conn, out)?;
        // 回放可能发射了本机新 op(「图N」翻案的正文修正走真 set_field,replay.rs):
        // 当场广播,别等下一次本地命令或重连——对端在线却收不到修正 op,内容要一直
        // 分叉到下个偶然事件为止(codex 二轮 #6)。
        self.outbound(conn, out)?;
        Ok(())
    }

    /// 入槽(§5.1 单槽模型):新 origin 且槽池满额 → LRU 驱逐最旧槽(整槽释放、水位
    /// 不动,发一次**无状态** want 复用「丢弃+want」自愈路径——合法大历史乱序追赶
    /// 只慢不死);每次触碰刷新 LRU 轴。
    fn slot_insert(
        &mut self,
        conn: &Connection,
        origin: &str,
        p: PendingOp,
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
        if !self.slots.contains_key(origin) && self.slots.len() >= self.slot_cap {
            let evict = self
                .slots
                .iter()
                .min_by_key(|(_, s)| s.touched)
                .map(|(o, _)| o.clone())
                .expect("满额必非空");
            // **先查水位、再拆槽**(实现审三轮 H1 的最内层)：反过来排的话，槽已经删掉
            // 而 `watermark` 一失败，那枚补洞 want 连构造都构造不出来——缺口既没人认领
            // 也没人知道。查询在前，失败时槽还在，Err 就是个干净的回滚点；拆槽与 push
            // 之间再无失败点，且 want 落进**调用方**的缓冲，故其后任一步的 `?` 都带不走它。
            let need = watermark(conn, &evict)? + 1;
            self.slots.remove(&evict);
            out.push(Output::Send {
                to: BROADCAST.into(),
                lane: Lane::Mail,
                route_hint: RouteHint::Auto,
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
        Ok(())
    }

    /// 连续喂入到不动点:每个 origin 只要队头 seq == watermark+1 就出队喂
    /// apply_remote_op;任何 op 落地 → 全部挂起头解锁重试(§5.3)。队列喂空 =
    /// 缺口补齐 → 整槽删除即释放(§5.1:不留半释放状态)。
    ///
    /// 输出写**调用方**的缓冲（实现审三轮 H1）：这个循环里遍布已提交的事实——隔离行已
    /// INSERT、槽已释放、翻案已落库——而任何一条 op 的本地故障都会 `?` 出去。私有 `Vec`
    /// 的话，那些事实的通知就随 Err 一起没了，而它们**已经发生**，没人会再报一次。
    fn drain(
        &mut self,
        conn: &mut Connection,
        clock: &mut Clock,
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
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
                    // 收尾要用的库事实**在动队列之前**取(见 [`SettlePre`]):失败就是
                    // 个干净的回滚点,而 apply 之后再查那两下就成了「op 已落地、已离开
                    // 队列」之后的失败点,没人能重来(实现审四轮 H2)。
                    let pre = {
                        let head = self.slots[&origin].queue.get(&head_seq).expect("刚看过");
                        settle_precheck(conn, &head.op, self.blob_policy)?
                    };
                    let p = self
                        .slots
                        .get_mut(&origin)
                        .expect("刚看过")
                        .queue
                        .remove(&head_seq)
                        .expect("队头刚看过,必在");
                    match replay::apply_remote_op(conn, clock, &p.op) {
                        Ok(outcome) => {
                            progressed = true;
                            if let Some(s) = self.slots.get_mut(&origin) {
                                s.suspend_reported = None;
                            }
                            self.settle_outcome(&p.op, outcome, &pre, out);
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
                            self.quarantine_origin(conn, &origin, &p, &reason, out)?;
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
                return Ok(());
            }
            // 有 op 落地:全部挂起头下一轮重试(挂起态清除;去重记忆保留到成功)。
            for slot in self.slots.values_mut() {
                slot.suspended = None;
            }
        }
    }

    /// 一条 op 落地后的引擎侧收尾:翻案事件上抛 + 图字节旁路联动(§5.4)。
    ///
    /// **纯内存、不可失败**(实现审四轮 H2)——库事实由 [`settle_precheck`] 在 apply
    /// **之前**取好。原先这里自己查库,而那时 op 已经写进 oplog、水位已经推进、它自己
    /// 也已经离开队列:查询一失败,这枚 op 的收尾(缺字节登记 / 死图清理)就**再没有人
    /// 重来**——`settle_pending` 只记得「还欠一次 drain」,重放不了「哪一枚 op 还欠
    /// settle」。与其加一份可重入的 settlement 记录,不如**把失败点搬走**。
    fn settle_outcome(
        &mut self,
        op: &RemoteOp,
        outcome: Outcome,
        pre: &SettlePre,
        out: &mut Vec<Output>,
    ) {
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
                if !pre.row_in && !pre.dead && !self.pulling.contains_key(&op.entity_id) {
                    // **只登记不当场发 want**(264 实现审 H2):一枚合法 `Ops` 帧最多带
                    // 500 条 op,全是 `image_add` 就是 500 枚帧,撞穿每链 256 帧的队列。
                    // 发问统一收在 [`Engine::on_msg`] 出口的 [`Engine::want_batch`]——
                    // 「本轮清单里多了新图」正是它的触发条件之一,故新图照样当场被问到。
                    self.missing_blobs.insert(op.entity_id.clone());
                }
            }
            ("image", "image_tombstone") => self.forget_image(&op.entity_id),
            ("item", "tombstone") => {
                // 宿主死了:名下缺字节的图不再拉(行已随 CASCADE 消失/永不再建)。
                for img in &pre.item_images {
                    self.forget_image(img);
                }
            }
            _ => {}
        }
    }

    /// 洞检测 → want(§5.2):某 origin 有 pending 但队头 > watermark+1(中间帧丢在
    /// 信箱 TTL/溢出里)→ 广播补洞请求。同一缺口只发一次;水位推进后缺口位变化自然
    /// 重发;want 本身丢了由下一次 hello 兜底(want 是加速器,hello 是兜底)。
    fn emit_wants(&mut self, conn: &Connection, out: &mut Vec<Output>) -> Result<(), String> {
        let mut asks: Vec<(String, i64)> = vec![];
        for (origin, slot) in &self.slots {
            let Some((&head, _)) = slot.queue.first_key_value() else { continue };
            let need = watermark(conn, origin)? + 1;
            if head > need && slot.wanted != Some(need) {
                asks.push((origin.clone(), need));
            }
        }
        for (origin, need) in asks {
            if let Some(slot) = self.slots.get_mut(&origin) {
                slot.wanted = Some(need);
            }
            out.push(Output::Send {
                to: BROADCAST.into(),
                lane: Lane::Mail,
                route_hint: RouteHint::Auto,
                msg: Msg::Want { origin, from_seq: need },
            });
        }
        Ok(())
    }

    /// 收到水位向量:对每个「我高你低」的 origin(含对方没听说过的)回 ops 补给
    /// (§5.2)。「我低你高」不动作——对方也会收到我的 hello,对称补齐。顺带把
    /// hello 当「对端可达」信号,向它重发缺字节图的 want(§5.4 的重试时机;
    /// MetadataOnly 下清单恒空,天然不发——M1「on_hello 不重发 blob want」)。
    ///
    /// **第⑤笔起不再当场逐 origin 物化帧**(§6.2 ③):原先这里是 `for origin in
    /// watermarks(conn)` 里逐 origin 调 `ops_frames` —— **双重无界**(origin 数无界 ×
    /// 每 origin 的帧数无界),一枚很小的 Hello 就能撞穿队列上界。现在只登记一份对账
    /// 计划,帧由投递面逐帧惰性取。
    ///
    /// **顺序守 ③″**:vet 与快照这两件可能失败的事全在 admission 之前做完;admission
    /// 之后到函数结束**没有 `?`**,故「已登记的义务随 `?` 蒸发」在这里不成立。
    fn on_hello(
        &mut self,
        conn: &Connection,
        from: &str,
        route: Route,
        theirs: &BTreeMap<String, i64>,
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
        let snapshot = ops_serve::snapshot_rowid(conn)?;
        match ops_serve::vet_watermarks(theirs.clone()) {
            // 水位图本身不合形:**整枚帧拒收**,admission 一步都不走(§6.2 ③′ 那格注明
            // 「水位图的 vet 失败发生在 admission 之前」)。
            Err(reason) => {
                out.push(Output::Event(Event::FrameRejected { from: from.into(), reason }))
            }
            Ok(vetted) => {
                let tick = self.tick;
                let admitted =
                    ops_serve::lock_ops(&self.ops).on_hello(from, vetted, snapshot, tick);
                self.settle_ops_admission(
                    from,
                    route,
                    admitted,
                    || "hello 的发送方 id 形态不合规范设备 id".into(),
                    out,
                );
            }
        }
        // 同会话仪式那条(264 实现审 H2):缺字节清单走唯一发问点,一次至多
        // [`BLOB_WANT_BATCH`] 枚——原先按对端定向问全量清单,缺 N 张就是 N 枚帧。
        // 改成广播不损功能:want 本就是「谁有谁答」,发问人不该挑收件人。
        out.extend(self.want_batch());
        Ok(())
    }

    /// 收到补洞请求:登记进该 target 的补洞快车道(§6.2 ③)。
    ///
    /// 原先是个自由函数(「读日志即答,不碰引擎内存态」),第⑤笔起它要往 [`OpsWorks`]
    /// 里记义务,故收进 `impl Engine`。形态闸从「只校验 `from_seq ≥ 1`」升成三道
    /// (target / origin / from_seq)——今天那个 origin 查完水位就丢,新形里它要**存进
    /// 补洞队列**,不收紧就是 64 target × 16 段 × 近 1 MiB 的留存面。
    ///
    /// **不再需要 `conn`**:补洞段刻意**不受对账快照约束**(`FrameSpec::Gap`)——它是
    /// 对端当下点名要的缺口,拿最新事实答才对;上界由取数那一刻自己的水位说了算。
    fn on_want(
        &mut self,
        from: &str,
        route: Route,
        origin: &str,
        from_seq: i64,
        out: &mut Vec<Output>,
    ) {
        let tick = self.tick;
        let admitted = ops_serve::lock_ops(&self.ops).on_want(from, origin, from_seq, tick);
        self.settle_ops_admission(
            from,
            route,
            admitted,
            || {
                format!(
                    "want 的形态不合:target/origin 须是规范设备 id、from_seq 须 ≥1(收到 origin={origin}, from_seq={from_seq})"
                )
            },
            out,
        );
    }

    // ---- 图字节旁路(§5.4) ----------------------------------------------------------

    /// 有人应答「我有字节」:还缺 ∧ 它有健康的腿 → 向首个这样的应答者拉流(direct,
    /// transfer 由本端取号、**绑定选中的路由与代次**);已在拉/已到手 → 忽略。
    /// expected 字节数取自该图 add op 的声明,攒块上限的依据。
    ///
    /// 选路失败(两条腿都不 Up、或都被惩罚/shun)= **不拉**:图留在缺字节清单,等下一
    /// 枚 have / 下一次 hello 重来——绝不凭空发帧到不可达的腿上试运气(§5.1)。
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
        if self.pulling.len() >= MAX_ACTIVE_PULLS {
            // 收端窗口满(§10 C′):图留在清单,等在飞那笔结束后由 [`Engine::blob_refill`]
            // 补问——**不是丢弃**,补问是这条路的活性保证。
            return Ok(vec![]);
        }
        let Some((route, generation)) = self.pick_blob_route(from, image_id) else {
            return Ok(vec![]); // 无健康腿(含被惩罚/shun 的超时来源):让别的设备应答。
        };
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
        // 声明字节数必须在协议允许区间内(replay 入库时已校验过同一区间;这里是**块形
        // 校验的地基**——`expected` 荒唐的话「共几块、每块多长」就算不出来)。
        if !(1..=crate::images::MAX_IMAGE_BYTES as i64).contains(&expected) {
            return Ok(vec![]);
        }
        self.missing_blobs.remove(image_id);
        let transfer = Ulid::new().to_string();
        self.pulling.insert(
            image_id.into(),
            Pull {
                from: from.into(),
                route,
                generation,
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
            // 钉死选中的腿(§5.1):送不出 = 该发送失败回引擎重算,绝不静默改路复用
            // transfer(传输层的契约:Require 送不出必随即通报该路由 down)。
            route_hint: RouteHint::Require(route),
            msg: Msg::BlobPull { image_id: image_id.into(), transfer },
        }])
    }

    /// 供块方拒了(行在应答后被删):回清单**并当场再问一轮**另寻来源(H2 同理;拒者
    /// 已无行,不会再抢答,故这一问不与谁组成循环)。来路须与本笔 transfer 绑定的腿
    /// 一致——换腿来的 deny 是残帧/别路噪音,不作数。
    fn on_blob_deny(&mut self, from: &str, route: Route, image_id: &str, transfer: &str) -> Vec<Output> {
        let mine = self.pulling.get(image_id).is_some_and(|pull| {
            pull.from == from && pull.route == route && pull.transfer == transfer
        });
        if !mine {
            return vec![];
        }
        self.pulling.remove(image_id);
        self.missing_blobs.insert(image_id.into());
        rewant(vec![image_id.to_string()])
    }

    /// 攒块;终块到齐 → 验货建行(replay::apply_image_bytes,72 契约)。错源/错
    /// transfer(上一次拉流的残帧)= 静默丢;错序或攒块超过 add 声明的字节数 =
    /// 作废本次拉流回清单(超量防对端无尽 last=false 块撑内存,codex 二轮 #4);
    /// 验货不过(坏字节)同样回清单换来源重试。
    fn on_blob_chunk(
        &mut self,
        conn: &mut Connection,
        from: &str,
        route: Route,
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
        // 来路必须是本笔 transfer 绑定的那条腿(§5.1「同一 transfer 的块永不跨链跨路」
        // 的**收端**闸):供块方若因路由变化改道发来,这里丢——不变量守在持有者手上,
        // 不指望发送端自律;丢完靠 stale 计时换腿重来。
        if pull.from != from || pull.route != route || pull.transfer != transfer {
            return Ok(vec![]); // 别的来源/别的腿/上一次 transfer 的残帧:丢,不动拉流。
        }
        // **块形必须与声明字节数严格对上**(264 实现审 H1)。原先只查「序号连号 ∧ 不超
        // 声明字节」,于是一串 `data: []`、`last: false` 的**空块**全部合法通过,而每一枚
        // 又把 `stale_ticks` 清零——`buf` 永不增长、transfer 永不结束、也永不判死。收端
        // 窗口封到一笔([`MAX_ACTIVE_PULLS`])之后,这不再只是劫持一张图,而是**整条图
        // 字节通道停摆**:别的图的 have 全被窗口挡在门外。
        //
        // 块大小是协议的一部分(sync-protocol §5.4:256 KiB/块),故由 `expected` 能唯一
        // 算出「共几块、每块多长、哪一块是末块」——三者任一不符 = 对端 mid-transfer 作恶
        // 或实现漂移,按 [`Engine::fail_pull`] 收口(shun 这条腿 + 罚 + 重问),**不是**
        // 只作废了事:只作废就再没有触发器(实现审二轮 M2),先 shun 又不会与它组成即时
        // 循环。
        let total = (pull.expected.max(1) as u64).div_ceil(BLOB_CHUNK_BYTES as u64);
        let want_len = if (idx as u64) + 1 == total {
            pull.expected as usize - idx as usize * BLOB_CHUNK_BYTES
        } else {
            BLOB_CHUNK_BYTES
        };
        let shape_ok = idx == pull.next_idx
            && (idx as u64) < total
            && data.len() == want_len
            && last == ((idx as u64) + 1 == total);
        if !shape_ok {
            return Ok(self.fail_pull(image_id, from, route));
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
            // 终局验货不过(坏字节)走同一收口:不 shun 就会立刻从同一来源再拉同一份
            // 坏字节,不重问就永远停在清单里。
            Err(reason) => {
                let mut out = self.fail_pull(image_id, from, route);
                out.push(Output::Event(Event::FrameRejected { from: from.into(), reason }));
                Ok(out)
            }
        }
    }

    /// 冻结一个 origin(分叉):丢其 pending 与游标、报一次事件,此后其帧静默丢弃。
    /// 冻结本身仍是内存态,**随引擎装配重检**(L-c2a 起引擎活到 runtime 生命期)。
    ///
    /// **上界是结构事实,不是「插完再报警」**(L-c2a 实现审 H1):到 [`FROZEN_CAP`]
    /// 就**不再往表里加**,只置 poison-breaker。旧写法先插后判,而 breaker 只挡「新
    /// origin」(本地日志尚无其 op 的)——已在册 origin 逐个来一遍伪造分叉就能把表撑到
    /// 全部历史 origin 数;引擎随会话生灭时靠重建隐式释放,活到 runtime 生命期后这就是
    /// 真的内存增长面。到顶那一枚**不插表也不发 OriginFrozen**:它的后续帧由升级后的
    /// breaker 闸(见 [`Engine::on_ops`])在到达分叉检测**之前**拒掉,不会每帧刷屏。
    fn freeze(
        &mut self,
        conn: &Connection,
        origin: &str,
        reason: String,
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
        // 到顶那一支:**先把会失败的事(置 breaker)做完,再拆槽**(实现审四轮 H3)。
        // 反过来排的话,`trip_breaker` 一失败槽已经释放,而 breaker 没置位——这一枚
        // 分叉既没记下也没闸住。
        if self.frozen.len() >= FROZEN_CAP && !self.frozen.contains_key(origin) {
            self.trip_breaker(
                conn,
                format!(
                    "冻结 origin 数达上限 {FROZEN_CAP}(分叉风暴/伪造 origin):此后拒收一切尚未冻结/隔离在册的 origin 的帧"
                ),
                out,
            )?;
            self.slots.remove(origin);
            return Ok(());
        }
        self.slots.remove(origin); // 整槽释放(队列/挂起/want 节流一体,§5.1)。
        self.frozen.insert(origin.into(), reason.clone());
        out.push(Output::Event(Event::OriginFrozen { origin: origin.into(), reason }));
        Ok(())
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
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
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
        // 资源上界(§4):行数 / 总字节任一到顶 → breaker 置位 fail-closed,此后新
        // origin 一律拒,增长被闸死。
        //
        // **先置 breaker、再落行**(实现审四轮 H1):原先反着排,而 `trip_breaker` 一
        // 失败,breaker 仍是 None、这个 origin 却已经进了 `quarantined` —— 它后续的帧
        // 从此走早退分支,**再没有人回来试第二次**;攻击者接着拿别的已在册 origin 重演
        // 一遍,表照涨,这道上界被打回原形。反过来排:trip 失败则这一行不落、origin 不
        // 入册,水位没动,对端的 hello/want 会把同一枚 op 再送来一遍,下次重试。
        // (trip 成功而 INSERT 失败是安全的那一侧:breaker 只会更严。)
        let (rows, bytes): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(COALESCE(length(op_blob), 0) + length(reason)), 0) \
                 FROM sync_quarantine",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        if rows + 1 >= QUARANTINE_MAX_ROWS || bytes + blob.len() as i64 >= QUARANTINE_MAX_BYTES {
            self.trip_breaker(conn, "隔离额度到顶(行数或总字节)".into(), out)?;
        }
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
        Ok(())
    }

    /// poison-breaker 置位(§4):落盘(sync_meta『poison_breaker』)+ 内存镜像 +
    /// 事件。幂等——已置位不重报。
    fn trip_breaker(
        &mut self,
        conn: &Connection,
        reason: String,
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
        if self.breaker.is_some() {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('poison_breaker', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&reason],
        )
        .map_err(|e| e.to_string())?;
        self.breaker = Some(reason.clone());
        out.push(Output::Event(Event::PoisonBreakerTripped { reason }));
        Ok(())
    }

    /// 升级重验状态机(§4):对 `validator_ver < 当前版本` 且有完整材料(op_blob)的
    /// 隔离行,以新校验器重跑——
    ///   * 仍 InvalidOp → 保留,只把 validator_ver 抬到当前(下次升级前不再重跑);
    ///   * 变 UnsupportedVocab → 清隔离、op 放回 pending(drain 会按型转普通版本挂起);
    ///   * shape 已接受 → 清隔离、op 放回 pending、发 want{watermark+1} 追回被丢弃的
    ///     后续帧;到 apply 位置仍状态型 Invalid → drain 里以新 validator_ver 重新隔离。
    /// op_blob 为 NULL 的行(超限指纹档)不可自动重验,原样保留等人工。
    /// 传输层在会话仪式 `on_relay_session_up` 之后调用(要 &mut conn 走 drain)。
    pub fn reverify_quarantined(
        &mut self,
        conn: &mut Connection,
        clock: &mut Clock,
        out: &mut Vec<Output>,
    ) -> Result<(), String> {
        // **有界批 + LIMIT 落在 SQL 里**(L-d‴):不是先 collect 全表再切——那样输出封住了、
        // 第一份物化照样无界(264 实现审对 `ops_frames` 判的同一条)。
        let rows: Vec<(String, Vec<u8>)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT origin, op_blob FROM sync_quarantine \
                     WHERE validator_ver < ?1 AND op_blob IS NOT NULL LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let it = stmt
                .query_map(
                    rusqlite::params![replay::VALIDATOR_VER, QUARANTINE_REVERIFY_BATCH as i64],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|e| e.to_string())?;
            it.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
        };
        // **先保守置位,末尾才落准确值**(实现审 H3):下面每一步本地故障都会 `?` 提前
        // 返回,而续做位若已按「这批没取满」落成 false,纯 LAN 下就再没有触发器来重试。
        // 置 true 的代价只是下一拍多跑一条 `SELECT … LIMIT`,置错成 false 的代价是余量
        // 永久躺住——两边不对称,取保守的那边。
        let full = rows.len() == QUARANTINE_REVERIFY_BATCH;
        self.reverify_backlog = true;
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
                    // **先把会失败的事做完,再动那份唯一材料**(实现审 H3)。原先 DELETE
                    // 打头,其后的 watermark 查询 / `slot_insert` 一旦本地故障,这枚 op
                    // **既没进 oplog、隔离表里那份唯一完整材料也已经没了** = 真丢数据。
                    // 反过来排:失败只让这一行留在表里下轮重做(op_id 幂等,重做无害)。
                    // 与 `on_lan_link_up` 同一条纪律——**改状态之前先把会失败的事做完**。
                    let need = watermark(conn, &origin)? + 1;
                    self.slot_insert(
                        conn,
                        &origin,
                        PendingOp {
                            op,
                            relay_from: relay_last.unwrap_or_else(|| "unknown".into()),
                        },
                        out,
                    )?;
                    // 入池成功那一刻起就欠一次结算(实现审三轮 H2):op 已在内存池里躺着,
                    // 而这一行马上就要离开 `WHERE` 的工作集——`reverify_backlog` 认领不了
                    // 它,得由这一位来。置位在 `DELETE` **之前**是刻意的:DELETE 失败时
                    // 下一拍照样能选到这行重做一遍(op_id 幂等),多空转一次 drain 无害,
                    // 而漏置一次就是永久无人认领。
                    self.settle_pending = true;
                    conn.execute("DELETE FROM sync_quarantine WHERE origin = ?1", [&origin])
                        .map_err(|e| e.to_string())?;
                    self.quarantined.remove(&origin);
                    // 追回隔离期间帧到即丢的后续 op(§4):谁有谁答;节流状态在槽内。
                    if let Some(slot) = self.slots.get_mut(&origin) {
                        slot.wanted = Some(need);
                    }
                    out.push(Output::Send {
                        to: BROADCAST.into(),
                        lane: Lane::Mail,
                        route_hint: RouteHint::Auto,
                        msg: Msg::Want { origin: origin.clone(), from_seq: need },
                    });
                }
            }
        }
        // 判据是**这一位**,不是「本批恢复了谁」(实现审三轮 H2):上一拍放出来却没 drain
        // 成的行,此刻在 SQL 里已经一行都选不到,只有它记得那笔债。
        if self.settle_pending {
            self.drain(conn, clock, out)?;
            // **drain 之后必须 outbound**(实现审 H4),与 `on_ops` 尾部同款:回放「图 N」
            // 撞号翻案会真写一枚本机 `set_field` op(`replay.rs`),不当场推的话,稳定的
            // 纯 LAN 会话里它可以无限期不发——会话仪式那条路是先 outbound 后 reverify,
            // 兜不到这一枚。
            self.outbound(conn, out)?;
            // 两件都做成才销账;中间任一步 `?` 出去,位子留着下一拍重来。
            self.settle_pending = false;
        }
        // 全程无本地故障才落准确值(见开头那段)。
        self.reverify_backlog = full;
        Ok(())
    }
}

/// [`Engine::settle_outcome`] 要用的库事实 —— **必须在 apply 之前取**(实现审四轮 H2)。
///
/// 取好之后收尾就是纯内存的,「apply 成功 ⇒ 收尾必成功」;失败则发生在**动队列之前**,
/// 是个干净的回滚点。
///
/// **前置不改语义**(三条都核过):`apply_image_add` 明示只记账、**不建 `item_image` 行**
/// (字节走 P2 旁路,replay.rs),故 `row_in` 前后同值;它也不写 image_tombstone,故
/// `dead` 前后同值;`images_of_item` 查的是 **oplog** 不是 `item_image`,故 item
/// tombstone 那一刀的级联删也碰不到它。
#[derive(Default)]
struct SettlePre {
    /// 这张图的行已经在了(字节到过手)。
    row_in: bool,
    /// 这张图已有 tombstone(死图,别登记进缺字节清单)。
    dead: bool,
    /// 宿主名下的全部图(item tombstone 支用)。
    item_images: Vec<String>,
}

/// 按 op 的种类只取它那一支要用的事实(别的支恒空,不白跑查询)。
fn settle_precheck(
    conn: &Connection,
    op: &RemoteOp,
    policy: BlobPolicy,
) -> Result<SettlePre, String> {
    match (op.entity.as_str(), op.kind.as_str()) {
        ("image", "image_add") if policy == BlobPolicy::Full => Ok(SettlePre {
            row_in: conn
                .query_row("SELECT 1 FROM item_image WHERE id = ?1", [&op.entity_id], |_| Ok(()))
                .optional()
                .map_err(|e| e.to_string())?
                .is_some(),
            dead: conn
                .query_row(
                    "SELECT 1 FROM oplog WHERE entity = 'image' AND entity_id = ?1 \
                     AND kind = 'image_tombstone' LIMIT 1",
                    [&op.entity_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .is_some(),
            item_images: vec![],
        }),
        ("item", "tombstone") => {
            Ok(SettlePre { item_images: images_of_item(conn, &op.entity_id)?, ..Default::default() })
        }
        _ => Ok(SettlePre::default()),
    }
}

/// 「产出即返回值」的那几支收口进调用方的缓冲。
///
/// 为什么这几支不必像 [`Engine::drain`] 那样改签名(实现审三轮 H1 的边界):它们的破坏性
/// 提交之后**再没有可失败的步骤**——`on_want`/`on_blob_want`/`on_blob_pull` 纯读不提交;
/// `on_blob_have`/`on_blob_chunk` 的最后一步是构造返回值,构造不会 `?`。故 Err 时手里本
/// 就没有已提交的义务,`r?` 丢掉的是空的。判据只此一条:**提交之后还有 `?` 吗**。
fn spill(out: &mut Vec<Output>, r: Result<Vec<Output>, String>) -> Result<(), String> {
    out.extend(r?);
    Ok(())
}

/// 为「刚退回缺字节清单」的图各发一枚广播 want(`Auto`:该问所有人,不因某条腿失效
/// 而只问一处)。路由失效 / 换代 / deny 三类出口共用——**回清单必配一次重新选路**
/// (实现审 H2),否则那张图要等下一次偶然的 hello。
/// 这枚输出是「问某张图的字节」吗——是则给出图 id(发问去重用)。
fn want_image_of(o: &Output) -> Option<&str> {
    match o {
        Output::Send { msg: Msg::BlobWant { image_id }, .. } => Some(image_id.as_str()),
        _ => None,
    }
}

fn rewant(images: Vec<String>) -> Vec<Output> {
    images
        .into_iter()
        .map(|image_id| Output::Send {
            to: BROADCAST.into(),
            lane: Lane::Mail,
            route_hint: RouteHint::Auto,
            msg: Msg::BlobWant { image_id },
        })
        .collect()
}

// ---- 无状态的应答(读日志即答,不碰引擎内存态) --------------------------------------

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
            route_hint: RouteHint::Auto,
            msg: Msg::BlobHave { image_id: image_id.into() },
        }]
    } else {
        vec![]
    })
}

/// 收到拉流请求:**只查存在性与 `(rowid, 字节数)`,产一枚供流描述符**(§10 C′)——
/// 字节由传输层逐块惰性取,引擎这一层一个图字节都不物化。行已不在(应答后被删的
/// 窗口)回 deny。
///
/// `route` = 来路:描述符在这里就绑死那条腿(§5 来路亲和 + §5.1「同一 transfer 的块
/// 永不跨链/跨路」),不走 [`Engine::on_msg`] 出口那道 `Auto → Require` 改写——那道
/// 改写只认 [`Output::Send`]。
fn on_blob_pull(
    conn: &Connection,
    from: &str,
    route: Route,
    image_id: &str,
    transfer: &str,
) -> Result<Vec<Output>, String> {
    // 放大面(263 codex 顺带点名):这两个字段是**已鉴权对端可控的任意字符串**,而供流
    // 要把它们逐块抄进每一枚 BlobChunk——不复核形态,一枚几百 KB 的长串就能被放大 128
    // 倍写上线。ULID 定长 26 字符,不合形 = 协议错误,**响亮拒帧且不回 deny**(回 deny
    // 等于把同一份长串再抄一遍出去)。
    if Ulid::from_string(image_id).is_err() || Ulid::from_string(transfer).is_err() {
        return Ok(vec![Output::Event(Event::FrameRejected {
            from: from.into(),
            reason: "BlobPull 的 image_id / transfer 不是合法 ULID".into(),
        })]);
    }
    let row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT rowid, length(data) FROM item_image WHERE id = ?1",
            [image_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((rowid, total)) = row else {
        return Ok(vec![Output::Send {
            to: from.into(),
            lane: Lane::Direct,
            route_hint: RouteHint::Auto,
            msg: Msg::BlobDeny { image_id: image_id.into(), transfer: transfer.into() },
        }]);
    };
    Ok(vec![Output::ServeBlob(BlobServe {
        to: from.into(),
        route,
        image_id: image_id.into(),
        transfer: transfer.into(),
        rowid,
        total,
    })])
}

/// 把一枚供流描述符跑成线上那串块(**测试夹具**:生产里这活分别由 LAN 写泵与中转腿的
/// 逐块循环干)。
///
/// 刻意**走生产取数原语** [`read_blob_chunk`],不另写一份切块逻辑——263 的教训正是
/// 「测试与实现漏在同一个假设里」,夹具自己造块的话,块边界/末块标志/行中途消失这三条
/// 就又没人验了。
#[cfg(test)]
pub(crate) fn serve_chunks(conn: &Connection, serve: &BlobServe) -> Vec<Msg> {
    let mut out = vec![];
    for idx in 0..serve.chunks() {
        match read_blob_chunk(conn, serve, idx).expect("读块") {
            Some(data) => out.push(Msg::BlobChunk {
                image_id: serve.image_id.clone(),
                transfer: serve.transfer.clone(),
                idx,
                last: serve.is_last(idx),
                data,
            }),
            None => {
                out.push(Msg::BlobDeny {
                    image_id: serve.image_id.clone(),
                    transfer: serve.transfer.clone(),
                });
                break;
            }
        }
    }
    out
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
///
/// **生产命中在第⑤笔已清零,留作 `cfg(test)` 对拍基准**(§6.2 ⑧)。留着它不是舍不得删:
/// [`super::ops_serve`] 的取帧路明写「与 `ops_frames` **逐字同规则**」,而那条断言只有
/// 拿它当基准才做得成 —— 本笔最该有的一只测就是「新旧两条路产的帧一模一样」。
#[cfg(test)]
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
                route_hint: RouteHint::Auto,
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
/// **切帧的字节尺只有这一把**:惰性取帧([`super::ops_serve::PeerWork::prepare_next`])
/// 与现状的 `ops_frames` 共用它,免得两条路对「一帧多大」各算各的。
pub(crate) fn encoded_op_len(op: &RemoteOp) -> usize {
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
///
/// **生产命中在第⑤笔已清零**(出站 Hello 改走 [`Engine::hello_watermarks`] 的有界形,
/// 收端改走 [`ops_serve::OpsWorks::on_hello`] 的计划),留作 `cfg(test)` 对拍基准:
/// 「有界子集在一次装得下时与全表逐字相同」同样需要它当参照。
#[cfg(test)]
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

/// 某条目名下曾贴过的全部图 id(按 image_add op 查,不看行在不在)——宿主
/// tombstone 落地时用它把名下的图从缺字节清单摘掉。本地删除与远端 replay 两条路
/// 共用这一份 SQL(口径漂移的老教训)。
fn images_of_item(conn: &Connection, item_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT entity_id FROM oplog WHERE entity = 'image' AND kind = 'image_add' \
             AND json_extract(payload, '$.item_id') = ?1",
        )
        .map_err(|e| e.to_string())?;
    let imgs: rusqlite::Result<Vec<String>> = stmt
        .query_map([item_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect();
    imgs.map_err(|e| e.to_string())
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

/// 测试便捷入口:来路恒中转。路由维度本身的专项测试显式调 [`Engine::on_msg`] 传
/// `Route::Lan`——这个薄壳只是让「与路由无关的既有测试」不必逐处写来路。
#[cfg(test)]
impl Engine {
    /// 中转会话建立,游标复位到「本机全部 op 都已被服务器接手」(= 本机水位):与路由
    /// 无关的既有测试不该被重推噪音干扰;游标复位本身的专项测试显式传 acked。
    pub(crate) fn relay_up(&mut self, conn: &Connection) -> Result<Vec<Output>, String> {
        let acked = watermark(conn, &self.device_id)?;
        self.on_relay_session_up(conn, acked)
    }

    fn on_relay_msg(
        &mut self,
        conn: &mut Connection,
        clock: &mut Clock,
        from: &str,
        msg: Msg,
    ) -> Result<Vec<Output>, String> {
        self.on_msg_v(conn, clock, from, Route::Relay, msg)
    }

    /// 输出收成返回值的薄壳。生产路径一律走 [`Engine::on_msg`] 的**出参**形——「已提交
    /// 的义务不随 Err 蒸发」靠调用方持有缓冲(实现审三轮 H1),而这个壳恰恰是那个被否掉
    /// 的形状:Err 时手里的输出就没了。故**专测失败路径的测试必须直接用出参形**,这里
    /// 只服务于「压根不看 Err」的既有测试,省得逐处声明一个 `Vec`。
    /// 同 [`Engine::on_msg_v`] 的用意:收成返回值的测试薄壳。
    fn freeze_v(
        &mut self,
        conn: &Connection,
        origin: &str,
        reason: String,
    ) -> Result<Vec<Output>, String> {
        let mut out = vec![];
        self.freeze(conn, origin, reason, &mut out)?;
        Ok(out)
    }

    pub(crate) fn on_msg_v(
        &mut self,
        conn: &mut Connection,
        clock: &mut Clock,
        from: &str,
        route: Route,
        msg: Msg,
    ) -> Result<Vec<Output>, String> {
        let mut out = vec![];
        self.on_msg(conn, clock, from, route, msg, &mut out)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    /// 夹具用的对端设备 id。**必须是规范 ULID**:第5笔起 `from` 要过
    /// [`ops_serve::vet_target`] 那把尺,随手起的 "PEERX" 会被整帧拒收。
    const PEER_ULID: &str = "01PEERXAAAAAAAAAAAAAAAAAAA";

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
        let engine = Engine::new_solo(&conn, BlobPolicy::Full).expect("engine");
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

    /// 一批引擎输出**真上线的那串消息**:`Send` 原样,`ServeBlob` 就地跑成块
    /// ([`serve_chunks`],走生产取数原语)。C′ 之后引擎不再产块,拿 `Output::Send`
    /// 过滤 chunk 的老写法会静默滤成空——那正是 263 那类「测试与实现漏在同一个假设里」
    /// 的形状,故所有「把应答喂给对端」的用例统一经此。
    fn wire_out(eng: &mut Engine, conn: &Connection, outs: Vec<Output>) -> Vec<Msg> {
        let mut v = vec![];
        for o in outs {
            match o {
                Output::Send { msg, .. } => v.push(msg),
                Output::ServeBlob(s) => v.extend(serve_chunks(conn, &s)),
                // 「来取活」的铃:第5笔起 ops 帧不再由引擎当场物化,而由消费腿逐帧取。
                // 这只夹具没有传输层,故就地抽干 —— 少了这一句,凡是靠 Hello/Want 补给
                // 的用例都会「照样绿,但绿得没有意义」(帧一枚都不会出现)。
                Output::ServeOps(_) => {}
                Output::Event(_) => {}
            }
        }
        for o in eng.drain_ops_for_test(conn).expect("drain ops") {
            if let Output::Send { msg, .. } = o {
                v.push(msg);
            }
        }
        v
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
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
            .unwrap();
        assert!(frame_rejected(&outs));
        assert!(eng.slots.is_empty());
        // 帧内 seq 非严格升序:同拒。
        let ops = vec![
            topic_op(DEV, 1_000, 2, "01TOPICAAAAAAAAAAAAAAAAAA1"),
            topic_op(DEV, 1_001, 2, "01TOPICAAAAAAAAAAAAAAAAAA2"),
        ];
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
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
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
            .unwrap();
        assert!(frame_rejected(&outs));
        assert!(eng.slots.is_empty());
        // 好帧照常入池应用(整帧拒收不留后遗症)。
        let op = topic_op(DEV, 1_000, 1, "01TOPICAAAAAAAAAAAAAAAAAA1");
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
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
            .on_relay_msg(
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
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
            .unwrap();
        assert!(!frame_rejected(&outs) && sends(&outs).is_empty(), "{outs:?}");
        // 缺口补上:连带 pending 里的 2 一起落地。
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op1] })
            .unwrap();
        assert!(!frame_rejected(&outs));
        assert_eq!(watermark(&conn, DEV).unwrap(), 2, "补洞后连续应用到队尾");
        assert!(eng.slots.get(DEV).is_none_or(|s| s.queue.is_empty()));
    }

    #[test]
    fn origin_forks_freeze_and_silence_the_origin() {
        let (mut conn, mut clock, mut eng) = fresh();
        let op1 = topic_op(DEV, 1_000, 1, "01TOPICCCCCCCCCCCCCCCCCC01");
        eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op1] })
            .unwrap();
        // 同 (origin, seq=1) 另一枚 op_id:分叉,冻结。
        let fork = topic_op(DEV, 9_999, 1, "01TOPICCCCCCCCCCCCCCCCCC02");
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![fork] })
            .unwrap();
        assert!(outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))));
        // 冻结后:该 origin 的合法新帧也静默丢弃。
        let op2 = topic_op(DEV, 1_002, 2, "01TOPICCCCCCCCCCCCCCCCCC03");
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
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
            .on_relay_msg(&mut conn, &mut clock, "OTHER", Msg::Ops { origin: me.clone(), ops: vec![ghost] })
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
            .on_relay_msg(&mut conn, &mut clock, "OTHER", Msg::Ops { origin: me.clone(), ops: vec![imposter] })
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
        eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![real.clone()] })
            .unwrap();
        assert_eq!(watermark(&conn, DEV).unwrap(), 1);
        let mut tampered = real.clone();
        tampered.payload = json!({"title": "换了内容", "created_at": "2026-07-08T00:00:00Z"});
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![tampered] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
            "同 op_id 异内容 = 分叉,不许当重传吞:{outs:?}"
        );
        // 真正的重传(逐字段全同)照旧静默吸收。
        let (mut c2, mut k2, mut e2) = fresh();
        e2.on_relay_msg(&mut c2, &mut k2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![real.clone()] })
            .unwrap();
        let outs = e2
            .on_relay_msg(&mut c2, &mut k2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![real] })
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
        eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
            .unwrap();
        let op1_late_hlc = topic_op(DEV, 9_000, 1, "01TOPICG000000000000000001"); // hlc > seq2 的
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op1_late_hlc] })
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
        eng2.on_relay_msg(&mut conn2, &mut clock2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![a1] })
            .unwrap();
        let a2_early_hlc = topic_op(DEV, 1_000, 2, "01TOPICH000000000000000002");
        let outs = eng2
            .on_relay_msg(&mut conn2, &mut clock2, DEV, Msg::Ops { origin: DEV.into(), ops: vec![a2_early_hlc] })
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
            .on_relay_msg(
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
            .on_relay_msg(&mut conn, &mut clock, "ADEV", Msg::Ops { origin: a.clone(), ops: a_ops })
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
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
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
        eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops })
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
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![fat(2), fat(3)] })
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
            .on_relay_msg(&mut conn, &mut clock, PEER_ULID, Msg::Hello { watermarks: BTreeMap::new(), lan: None })
            .unwrap();
        let me = clock.device_id();
        // 第5笔:Hello 不再当场物化补给帧,只登记一份对账计划并产一枚「来取活」的描述符;
        // 帧由消费腿逐帧取。判据因此分两层——**描述符必须出现**(否则没人会来取),
        // **抽出来的帧要和从前一样**。
        assert!(
            outs.iter().any(|o| matches!(o, Output::ServeOps(_))),
            "收下 Hello 必须产一枚描述符,否则这份对账计划没人来取:{outs:?}"
        );
        let served = eng.drain_ops_for_test(&conn).unwrap();
        let ops_frame = sends(&served)
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
            .on_relay_msg(&mut conn, &mut clock, PEER_ULID, Msg::Hello { watermarks: theirs, lan: None })
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
        let b_id = b_clock.device_id().to_string();
        // 中转会话 + 服务器在线快照:A 的中转腿 Up——blob 选路只认路由表
        // (lan-direct-plan §5.1),且「会话在 ∧ 对端在线」两层缺一不可(实现审 M2),
        // 没这两句 B 收到 have 也不会拉(「不凭空走中转」)。
        b_eng.relay_up(&b_conn).unwrap();
        b_eng.on_relay_peer_up(&a_id);

        // B 收 A 全量 op(借 hello 机制拿帧,顺带测追赶)。
        // 第5笔:Hello 只登记计划,帧要抽;且 `from` 从此过规范设备 id 那把尺,故这里
        // 用真身份(原先的 "A"/"B" 会被整帧拒收 —— 那正是新形该有的样子)。
        let mut frames = a_eng
            .on_relay_msg(&mut a_conn, &mut a_clock, &b_id, Msg::Hello { watermarks: BTreeMap::new(), lan: None })
            .unwrap();
        frames.extend(a_eng.drain_ops_for_test(&a_conn).unwrap());
        let mut b_out = vec![];
        for f in frames {
            if let Output::Send { msg, .. } = f {
                b_out.extend(b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap());
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
        let haves = a_eng.on_relay_msg(&mut a_conn, &mut a_clock, &b_clock.device_id().to_string(), Msg::BlobWant { image_id: img.clone() }).unwrap();
        let have_msg = match &haves[0] {
            Output::Send { msg, .. } => msg.clone(),
            other => panic!("期待 have,得到 {other:?}"),
        };
        let pulls = b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have_msg).unwrap();
        let pull_msg = match &pulls[0] {
            Output::Send { msg, lane, .. } => {
                assert_eq!(*lane, Lane::Direct, "拉流走 direct");
                msg.clone()
            }
            other => panic!("期待 pull,得到 {other:?}"),
        };
        let served = a_eng.on_relay_msg(&mut a_conn, &mut a_clock, &b_clock.device_id().to_string(), pull_msg).unwrap();
        for msg in wire_out(&mut a_eng, &a_conn, served) {
            let outs = b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
            assert!(!frame_rejected(&outs), "字节验货必须过(长度+sha256)");
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
            .on_relay_msg(
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
        b_eng.relay_up(&b_conn).unwrap(); // 会话在
        b_eng.on_relay_peer_up(&a_id); // A 的中转腿 Up(选路前提,§5.1)
        // B 拿到 A 的 op(借帧构造),进入缺字节态,再收 have 进入拉流。
        let frames = ops_frames(&a_conn, &a_id, 1, watermark(&a_conn, &a_id).unwrap(), "B").unwrap();
        for f in frames {
            if let Output::Send { msg, .. } = f {
                b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
            }
        }
        b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
        let live_transfer = b_eng.pulling[&img].transfer.clone();
        // 残帧(错 transfer):静默丢,进行中的拉流不受伤。
        let outs = b_eng
            .on_relay_msg(
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
        // 超量块(> add 声明的 10 字节):拉流作废回清单,**并按坏块收口**——shun 这条
        // 腿 + 罚它 + 当场重问(实现审二轮 M2:只作废就再没有触发器;先 shun 才不会
        // 重问一圈又撞回同一个作恶者)。
        let outs = b_eng
            .on_relay_msg(
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
        assert!(
            outs.iter().any(|o| matches!(o, Output::Send { to, lane: Lane::Mail, route_hint: RouteHint::Auto, msg: Msg::BlobWant { image_id } }
                if to == BROADCAST && image_id == &img)),
            "坏块作废后必须当场重问:{outs:?}"
        );
        assert!(b_eng.blob_penalized(&a_id, Route::Relay), "坏块 = 罚这条腿");
        // 重问引来的下一枚 have 还是它:被 shun 挡住,不会立刻再撞同一个作恶者。
        let outs = b_eng
            .on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() })
            .unwrap();
        assert!(outs.is_empty() && b_eng.pulling.is_empty(), "坏块来源已被 shun:{outs:?}");
    }

    #[test]
    fn failed_verification_shuns_the_source_and_asks_again() {
        // 实现审二轮 M2:终局验货不过(坏字节)与坏块同一收口——不 shun 就会立刻从同一
        // 来源再拉同一份坏字节,不重问就永远停在清单里。
        let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
        eng.on_relay_peer_up(&a_id);
        eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
        let transfer = eng.pulling[&img].transfer.clone();
        // 长度对得上(夹具 12 字节)但内容不是原图 → sha256 验货必挂。
        let outs = eng
            .on_relay_msg(
                &mut conn,
                &mut clock,
                &a_id,
                Msg::BlobChunk { image_id: img.clone(), transfer, idx: 0, last: true, data: vec![9u8; 12] },
            )
            .unwrap();
        assert!(frame_rejected(&outs), "坏字节要响亮报一次:{outs:?}");
        assert!(
            outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::BlobWant { image_id }, .. } if image_id == &img)),
            "验货失败后当场重问:{outs:?}"
        );
        assert!(eng.blob_penalized(&a_id, Route::Relay), "验货失败 = 罚这条腿");
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "坏字节不落地");
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
        const OTHER: &str = "OTHERPEERDEVICE00000000000";
        b.relay_up(&b_conn).unwrap(); // 会话在(两层缺一不可,实现审 M2)
        b.on_relay_peer_up(&a_id); // 两台的中转腿都 Up(选路前提,§5.1)
        b.on_relay_peer_up(OTHER);
        // B 拿到 A 的 op → 进缺字节态;A(沉默源)应 have → B 拉流。
        let frames = ops_frames(&a_conn, &a_id, 1, watermark(&a_conn, &a_id).unwrap(), "B").unwrap();
        for f in frames {
            if let Output::Send { msg, .. } = f {
                b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
            }
        }
        b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
        assert!(b.pulling.contains_key(&img), "have 后进入拉流");
        // 沉默:连续心跳到阈值,作废回清单 + 重发 want。
        let mut wants = vec![];
        for _ in 0..PULL_STALE_TICKS {
            wants = b.on_tick();
        }
        assert!(!b.pulling.contains_key(&img) && b.missing_blobs.contains(&img), "超时作废回清单");
        // 恰一枚:`fail_pull` 自带的重问与 `on_tick` 出口那一批会撞车(实现审二轮 L1——
        // `on_tick` 原先直接 extend,漏了去重)。
        assert_eq!(
            wants.iter().filter(|o| want_image_of(o) == Some(img.as_str())).count(),
            1,
            "作废时当场重发 want,且同图只发一枚:{wants:?}"
        );
        // 同一沉默来源(A)再应 have:这条腿被避开,不再拉它。
        let outs = b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
        assert!(outs.is_empty() && !b.pulling.contains_key(&img), "避开刚超时的来源");
        // 别的来源(C)应 have:正常拉流(shun 是 per (image, device, route),不是全局)。
        let _ = b.on_relay_msg(&mut b_conn, &mut b_clock, OTHER, Msg::BlobHave { image_id: img.clone() }).unwrap();
        assert!(b.pulling.contains_key(&img), "换来源可拉");
        // 中转重连是新会话:relay 维度的避开名单与惩罚清零(人人这条腿再给一次机会)。
        b.relay_up(&b_conn).unwrap();
        assert!(b.blob_shunned.is_empty(), "relay 会话重连清 relay 维度的避开名单");
        assert!(!b.blob_penalized(&a_id, Route::Relay), "同时清 relay 惩罚");
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
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::SpaceNameChanged))),
            "space op 落地必须发专用事件:{outs:?}"
        );
        // 另一 origin 的更低 HLC 迟到写:LwwStale 只记账,不发事件。
        let other = "BREMTE00000000000000000001";
        let stale = mk_space(other, 1_000, 1, json!("旧名"));
        let outs2 = eng
            .on_relay_msg(&mut conn, &mut clock, other, Msg::Ops { origin: other.into(), ops: vec![stale] })
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
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op] })
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
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![op2] })
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
            .on_relay_msg(&mut conn, &mut clock, "AREMOTE", Msg::Ops { origin: "AREMTE00000000000000000001".into(), ops: vec![add] })
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::ImagesRenumbered { content_rewritten: true, .. }))),
            "翻案 + 正文修正:{outs:?}"
        );
        // 第5笔:「当场广播」= 当场**登记**并摇铃(描述符),帧由消费腿取。两层都验:
        // 只验描述符会漏掉「登记的区间不对」,只验帧会漏掉「没人来取」。
        assert!(
            outs.iter().any(|o| matches!(o, Output::ServeOps(s) if s.to == OpsServeTo::Broadcast)),
            "回放中发射的修正 op 必须当场摇铃:{outs:?}"
        );
        let served = eng.drain_ops_for_test(&conn).unwrap();
        let pushed_own_op = sends(&served).iter().any(|m| matches!(m, Msg::Ops { origin, .. } if origin == &me));
        assert!(pushed_own_op, "而且抽得出那一枚本机 op:{served:?}");
        let content: String =
            conn.query_row("SELECT content FROM items WHERE id = ?1", [&item], |r| r.get(0)).unwrap();
        assert_eq!(content, "定稿:见图2");
    }

    /// **`ops_notice` 的正文必须是 `(target, class)` 的纯函数**——§6.2 ③ 要的三条去重
    /// 语义(同一条不重报 / 新的盖旧的 / 被盖掉之后允许再报)整个挂在这一条上,换来的是
    /// **零新状态**:`set_status` 本就「整只快照没变就不发事件」。
    ///
    /// 日后往正文里掺进任何随请求变的量(seq / 计数 / 时刻),去重就**静默失效**——每一枚
    /// 都成了「新快照」,状态面开始刷屏,而没有任何测试会红。故这条得有人守。
    #[test]
    fn an_ops_notice_is_a_pure_function_of_target_and_class() {
        const OTHER: &str = "01PEER9AAAAAAAAAAAAAAAAAAA";
        let text = |t: &str, c: OpsNoticeClass| match ops_notice(t, c) {
            Output::Event(Event::OpsNotice { text }) => text,
            other => panic!("ops_notice 必须产一枚 advisory 事件:{other:?}"),
        };
        let base = text(DEV, OpsNoticeClass::Overload);
        assert_eq!(base, text(DEV, OpsNoticeClass::Overload), "同 target 同类 → 必须逐字相同");
        assert_ne!(base, text(DEV, OpsNoticeClass::Collapsed), "换一类必须换话(不然盖不掉)");
        assert_ne!(base, text(OTHER, OpsNoticeClass::Overload), "换一台必须换话");
        assert_ne!(
            base,
            text(BROADCAST, OpsNoticeClass::Overload),
            "广播那一格说的是「本机新增内容」,与定向对账不是一回事"
        );
    }

    /// **有界 Hello 与它替下的全表扫必须给出同一份事实**(§6.2 ⑧ 留 [`watermarks`] 当
    /// 对拍基准的全部理由;少了这只测,那个基准就只是块没人看的化石)。
    ///
    /// 旧 [`watermarks`] 是 `GROUP BY origin` 全表扫(设计期实测 500 万行 / 2000 origin
    /// 下 157.8 ms,且是**持着库锁在协调者里**跑的);新路按预算取子集 + 跨 Hello 轮转。
    /// **换算法不许换答案**。
    ///
    /// 两格分开断,少哪一格都能让假实现绿:
    /// * 预算够 → 一枚就等于全表,**且游标复位**(轮转不启用,与旧路逐字同形);
    /// * 预算极小 → 单枚必须是**真子集**(不然「有界」是假的),而绕满一圈的并集仍等于
    ///   全表(不然轮转在饿死某些 origin —— 表现出来就是「对端永远收不到我这一格的真实
    ///   水位」,而那种坏法在单枚上看着完全正常)。
    #[test]
    fn the_bounded_hello_watermarks_agree_with_the_full_table_scan_they_replaced() {
        let (conn, _clock, _eng) = fresh();
        // 五个 origin,水位刻意各不相同:全都一样的话「取错了行」也照样对得上。
        for (i, n) in [3i64, 1, 7, 2, 5].into_iter().enumerate() {
            let origin = format!("01RGN{i}AAAAAAAAAAAAAAAAAAAA");
            assert_eq!(origin.len(), 26, "origin 必须是 26 字符(oplog 的 origin 由 hlc 尾段生成)");
            for seq in 1..=n {
                conn.execute(
                    "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                     VALUES (?1, ?2, 'topic', '01TOPICWMARK000000000000X', 'create', ?3, ?4)",
                    (
                        Ulid::new().to_string(),
                        Hlc { wall_ms: 1_000 + seq as u64, counter: 0, device_id: origin.clone() }
                            .encode(),
                        serde_json::to_string(&json!({"title": "t"})).unwrap(),
                        seq,
                    ),
                )
                .unwrap();
            }
        }
        let full = watermarks(&conn).unwrap();
        assert_eq!(full.len(), 5, "五个 origin 都得在");

        // ① 预算够:一枚 = 全表,游标复位。
        let mut cursor = ops_serve::HelloCursor::default();
        let one = ops_serve::bounded_watermarks(&conn, &mut cursor, 64 * 1024).unwrap();
        assert_eq!(one, full, "装得下就必须与旧路逐字相同");
        assert_eq!(cursor, ops_serve::HelloCursor::default(), "装得下 → 游标复位,轮转不启用");

        // ② 预算极小:单枚是真子集,绕满一圈的并集仍是全表。
        let mut cursor = ops_serve::HelloCursor::default();
        let mut union: BTreeMap<String, i64> = BTreeMap::new();
        for round in 1..=20 {
            let part = ops_serve::bounded_watermarks(&conn, &mut cursor, 1).unwrap();
            assert!(!part.is_empty(), "预算再小也得至少带一条(带不动 = 游标不前进 = 死循环)");
            assert!(part.len() < full.len(), "1 字节预算还能带全 = 有界是假的");
            union.extend(part);
            if union == full {
                break;
            }
            assert!(round < 20, "轮转该在几枚之内绕完,实跑 {round} 枚仍缺:{union:?}");
        }
        assert_eq!(union, full, "轮转拼出来的并集必须与全表逐字相同");
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
                outs.extend(eng.on_relay_msg(conn, clock, src_dev, msg).unwrap());
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
        let mut b_eng = Engine::new_solo(&b_conn, BlobPolicy::MetadataOnly).expect("light engine");
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
            .on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::Hello { watermarks: BTreeMap::new(), lan: None })
            .unwrap();
        assert!(!any_blob_want(&outs), "hello 不重发 want:{outs:?}");

        // 重连:hello 照发,want 零。
        let outs = b_eng.relay_up(&b_conn).unwrap();
        assert!(outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::Hello { .. }, .. })));
        assert!(!any_blob_want(&outs), "重连不派生缺图清单:{outs:?}");

        // 防御:天上掉的 have / chunk(非本策略发起)一律忽略,不建行不崩(A 的中转腿
        // 特意置 Up——挡住它的必须是轻端策略,不是「没路可走」)。
        b_eng.on_relay_peer_up(&a_id);
        let outs =
            b_eng.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, Msg::BlobHave { image_id: img.clone() }).unwrap();
        assert!(outs.is_empty() && b_eng.pulling.is_empty());
        let outs = b_eng
            .on_relay_msg(
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
        // M1 测试④:轻端库换回 Full 策略重建引擎,on_runtime_started 的 derive_missing_blobs
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
        let mut b_light = Engine::new_solo(&b_conn, BlobPolicy::MetadataOnly).expect("light");
        let item = notes::capture(&mut a_conn, &mut a_clock, "轻端期间的图").unwrap();
        let bytes: Vec<u8> = (100u8..200).collect();
        let (img, _) = images::attach(&mut a_conn, &mut a_clock, &item, &bytes, "image/png").unwrap();
        let a_id = a_clock.device_id().to_string();
        let b_id = b_clock.device_id().to_string();
        let outs = feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b_light);
        assert!(!any_blob_want(&outs));
        drop(b_light);

        // 同一库、Full 策略重建(引擎状态本就可丢):装配即发现缺口(on_runtime_started
        // 派生清单),会话建立时把 want 发出去。
        let mut b_full = Engine::new_solo(&b_conn, BlobPolicy::Full).expect("full");
        b_full.on_runtime_started(&b_conn).unwrap();
        let outs = b_full.relay_up(&b_conn).unwrap();
        b_full.on_relay_peer_up(&a_id); // 在线快照恒在会话建立之后(先后颠倒即被清掉)
        let want = outs
            .iter()
            .find_map(|o| match o {
                Output::Send { msg: Msg::BlobWant { image_id }, .. } => Some(image_id.clone()),
                _ => None,
            })
            .expect("切回 Full 必须重新发现缺图并发 want");
        assert_eq!(want, img);
        // 走完 have → pull → chunk,行建齐。
        let haves = a_eng.on_relay_msg(&mut a_conn, &mut a_clock, &b_id, Msg::BlobWant { image_id: img.clone() }).unwrap();
        let have = match &haves[0] {
            Output::Send { msg, .. } => msg.clone(),
            other => panic!("期待 have,得到 {other:?}"),
        };
        let pulls = b_full.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have).unwrap();
        let pull = match &pulls[0] {
            Output::Send { msg, .. } => msg.clone(),
            other => panic!("期待 pull,得到 {other:?}"),
        };
        let served = a_eng.on_relay_msg(&mut a_conn, &mut a_clock, &b_id, pull).unwrap();
        for msg in wire_out(&mut a_eng, &a_conn, served) {
            b_full.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
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
        let mut b_light = Engine::new_solo(&b_conn, BlobPolicy::MetadataOnly).expect("light");
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
        let mut b_light = Engine::new_solo(&b_conn, BlobPolicy::MetadataOnly).expect("light");
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
            eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(i), ops: vec![op] })
                .unwrap();
        }
        assert_eq!(eng.slots.len(), 2);
        // 第三个 origin 到来:驱逐最旧(dev0),为它发无状态 want(from_seq = 水位+1 = 1)。
        let op = topic_op(&dev(2), 3_000, 2, "01TOPICEVICT00000000000002");
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(2), ops: vec![op] })
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
        eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(0), ops }).unwrap();
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
            eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(i), ops: vec![op] })
                .unwrap();
        }
        assert!(eng.slots.len() <= 8, "槽数恒有界:{}", eng.slots.len());
        // 第二轮:round-robin 重投完整段 [seq1, seq2](模拟 want 的应答):无论槽还
        // 在不在,帧到即连续应用(在槽的 seq2 判重传丢弃)——一轮内全员必须收敛,
        // 无活锁、无永久饥饿。
        for i in 0..n {
            let ops = vec![history[i][0].clone(), history[i][1].clone()];
            eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev(i), ops }).unwrap();
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
            .on_relay_msg(&mut conn, &mut clock, "RELAY-A", Msg::Ops { origin: DEV.into(), ops: vec![bad.clone()] })
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
            .on_relay_msg(&mut conn, &mut clock, "RELAY-B", Msg::Ops { origin: DEV.into(), ops: vec![good.clone()] })
            .unwrap();
        assert!(outs.is_empty(), "隔离后帧到即丢:{outs:?}");
        let (.., last2, _) = {
            let r = quarantine_row(&conn, DEV).unwrap();
            (r.0, r.4, r.5, r.6)
        };
        assert_eq!(last2.as_deref(), Some("RELAY-B"), "relay_from_last 必须跟进最近投递者");
        // 重启(新引擎实例):隔离态从表装载,依旧丢帧——「重启即忘」正是要关的洞。
        let mut eng2 = Engine::new_solo(&conn, BlobPolicy::Full).unwrap();
        let outs = eng2
            .on_relay_msg(&mut conn, &mut clock, "RELAY-C", Msg::Ops { origin: DEV.into(), ops: vec![good] })
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
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![vocab] })
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
        eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: "DEPDEV0000000000000000001X".into(), ops: vec![orphan] })
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
        eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c1] })
            .unwrap();
        let c2 = topic_op(DEV, 2_000, 2, "01TOPICAPPLYSTAGE00000001");
        let outs = eng
            .on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c2] })
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
        eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![bad] })
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
            let outs = eng.freeze_v(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "伪造分叉".into()).unwrap();
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
        // 上界是**结构事实**(实现审 H1):到顶之后再来多少个分叉,表都不许再涨——
        // 旧写法「先插后判」下 breaker 只挡「新 origin」,已在册 origin 逐个来一遍
        // 就能把表撑到全部历史 origin 数(引擎活到 runtime 生命期后即真内存增长面)。
        for i in 100..110 {
            let outs = eng
                .freeze_v(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "又一个分叉".into())
                .unwrap();
            assert!(
                !outs.iter().any(|o| matches!(o, Output::Event(Event::OriginFrozen { .. }))),
                "到顶后不再往表里加,也不再报 OriginFrozen(否则每帧刷屏)"
            );
        }
        assert_eq!(eng.frozen.len(), FROZEN_CAP, "冻结表恒不超上限");
    }

    #[test]
    fn breaker_survives_restart_and_only_blocks_new_origins() {
        let (mut conn, mut clock, mut eng) = fresh();
        // 先让 DEV 在册(水位 1),再触发 breaker。
        let c1 = topic_op(DEV, 1_000, 1, "01TOPICBRKKNOWN0000000001");
        eng.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c1] })
            .unwrap();
        for i in 0..=FROZEN_CAP {
            eng.freeze_v(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "伪造分叉".into()).unwrap();
        }
        assert!(eng.breaker.is_some());
        // 重启:breaker 从 sync_meta 装载,fail-closed 不忘。
        let mut eng2 = Engine::new_solo(&conn, BlobPolicy::Full).unwrap();
        assert!(eng2.breaker.is_some(), "breaker 必须跨重启");
        // 新 origin 拒收(报一次 FrameRejected,再来静默)。
        let newcomer = topic_op("BRANDNEWDEV000000000000001", 1_000, 1, "01TOPICBRKNEW000000000001");
        let outs = eng2
            .on_relay_msg(&mut conn, &mut clock, "X", Msg::Ops { origin: "BRANDNEWDEV000000000000001".into(), ops: vec![newcomer.clone()] })
            .unwrap();
        assert!(frame_rejected(&outs), "新 origin 必须被拒:{outs:?}");
        assert_eq!(watermark(&conn, "BRANDNEWDEV000000000000001").unwrap(), 0);
        let outs = eng2
            .on_relay_msg(&mut conn, &mut clock, "X", Msg::Ops { origin: "BRANDNEWDEV000000000000001".into(), ops: vec![newcomer] })
            .unwrap();
        assert!(outs.is_empty(), "同 origin 每会话只报一次");
        // 已在册 origin(DEV,水位 1)照常同步。
        let c2 = topic_op(DEV, 2_000, 2, "01TOPICBRKKNOWN0000000002");
        eng2.on_relay_msg(&mut conn, &mut clock, DEV, Msg::Ops { origin: DEV.into(), ops: vec![c2] })
            .unwrap();
        assert_eq!(watermark(&conn, DEV).unwrap(), 2, "已在册 origin 不受 breaker 影响");
        // 显式复位:清 KV + 内存镜像,新 origin 恢复接收。
        eng2.reset_breaker(&conn).unwrap();
        assert!(eng2.breaker.is_none());
        let again = topic_op("BRANDNEWDEV000000000000001", 3_000, 1, "01TOPICBRKNEW000000000002");
        eng2.on_relay_msg(&mut conn, &mut clock, "X", Msg::Ops { origin: "BRANDNEWDEV000000000000001".into(), ops: vec![again] })
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
                .on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev, ops: vec![bad] })
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
            eng.on_relay_msg(&mut conn, &mut clock, "R", Msg::Ops { origin: dev.to_string(), ops: vec![bad] })
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
        let outs = reverify_ok(&mut eng, &mut conn, &mut clock);
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

    /// 测试小助手:本测不该有本地故障时,把输出取出来。
    fn reverify_ok(eng: &mut Engine, conn: &mut Connection, clock: &mut Clock) -> Vec<Output> {
        let mut out = vec![];
        eng.reverify_quarantined(conn, clock, &mut out).expect("本测不该有本地故障");
        out
    }

    fn quarantine_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM sync_quarantine", [], |r| r.get(0)).unwrap()
    }

    /// 造 N 行「新校验器会接受」的待重验隔离行(故每行被放出来时都会发一枚 want)。
    fn seed_reverifiable(conn: &mut Connection, clock: &mut Clock, eng: &mut Engine, n: usize) {
        for i in 0..n {
            let dev = reverify_dev(i);
            let bad = poison_op(&dev, 1_000 + i as u64, 1);
            eng.on_relay_msg(conn, clock, "R", Msg::Ops { origin: dev, ops: vec![bad] }).unwrap();
        }
        conn.execute("UPDATE sync_quarantine SET validator_ver = 0", []).unwrap();
        for i in 0..n {
            let fixed =
                topic_op(&reverify_dev(i), 2_000 + i as u64, 1, &format!("01TPCRVB{:018}", i));
            conn.execute(
                "UPDATE sync_quarantine SET op_blob = ?2 WHERE origin = ?1",
                rusqlite::params![reverify_dev(i), serde_json::to_vec(&fixed).unwrap()],
            )
            .unwrap();
        }
    }

    fn reverify_dev(i: usize) -> String {
        format!("RVBATCHDEV{i:016}")
    }

    /// 把槽池塞满,返回「下一个会被 LRU 驱逐的那个 origin」。
    ///
    /// 每个槽的队头都是 seq 2(水位 0,有洞),故 `drain` 一律走「等 want 补」那条 break
    /// ——槽稳稳占着,不会被顺手清空。
    fn fill_slots(conn: &Connection, eng: &mut Engine) -> String {
        for i in 0..eng.slot_cap {
            let origin = format!("EVICTDEV{i:018}");
            let op = topic_op(&origin, 3_000 + i as u64, 2, &format!("01TPCEVCT{i:017}"));
            eng.slot_insert(conn, &origin, PendingOp { op, relay_from: "R".into() }, &mut vec![])
                .expect("塞槽本身不该失败");
        }
        assert_eq!(eng.slots.len(), eng.slot_cap, "槽池必须真的满了,否则驱逐根本不发生");
        eng.slots.iter().min_by_key(|(_, s)| s.touched).map(|(o, _)| o.clone()).expect("满额必非空")
    }

    /// 一枚合法的「新 origin 单条 op」帧,连 origin 一起给出。
    fn newcomer_frame(tag: u64) -> (String, Msg) {
        let origin = format!("NEWC0MERDEV{tag:015}");
        let op = topic_op(&origin, 9_000 + tag, 1, &format!("01TPCNEWCOMER{tag:013}"));
        (origin.clone(), Msg::Ops { origin, ops: vec![op] })
    }

    /// **L-d‴ 的心脏:隔离重验必须有界批**(同族第五例)。
    ///
    /// 每恢复一行发一枚广播 `Want`,而每链发送队列只有 256 帧;表的真实天花板是本地
    /// origin 总数(`QUARANTINE_MAX_ROWS` 只是 breaker 跳闸点,不是行上界),故不封批
    /// 就是「一次输入吐几百枚帧」。这里用 N=20 > BATCH=16 把「有界」与「一口气全放」
    /// 区分开——**不封批的话 released 会是 20**。
    #[test]
    fn reverify_releases_at_most_one_batch_per_call() {
        let (mut conn, mut clock, mut eng) = fresh();
        const N: usize = 20;
        assert!(N > QUARANTINE_REVERIFY_BATCH, "夹具必须真的越过批上限");
        seed_reverifiable(&mut conn, &mut clock, &mut eng, N);
        assert_eq!(quarantine_count(&conn), N as i64);

        let outs = reverify_ok(&mut eng, &mut conn, &mut clock);

        let released = N as i64 - quarantine_count(&conn);
        assert_eq!(
            released, QUARANTINE_REVERIFY_BATCH as i64,
            "一次调用至多放一批(不封批会是 {N})"
        );
        let wants = sends(&outs).iter().filter(|m| matches!(m, Msg::Want { .. })).count();
        assert_eq!(
            wants, QUARANTINE_REVERIFY_BATCH,
            "帧数必须跟着批走(每放一行一枚 want):{outs:?}"
        );
        assert!(eng.reverify_backlog, "还有余量,续做位必须置起来");
    }

    /// **有界批的另一半:余量必须收敛,且做完要落位**(不许静默截断、也不许永远空转)。
    ///
    /// 续做的**触发器**在传输层(挂恒在心跳),见 `transport` 的
    /// `heartbeat_drains_quarantine_reverify_backlog`;这只测钉的是引擎侧的可收敛性。
    #[test]
    fn reverify_batches_converge_and_backlog_clears_when_done() {
        let (mut conn, mut clock, mut eng) = fresh();
        const N: usize = 20;
        seed_reverifiable(&mut conn, &mut clock, &mut eng, N);

        reverify_ok(&mut eng, &mut conn, &mut clock);
        assert_eq!(quarantine_count(&conn), (N - QUARANTINE_REVERIFY_BATCH) as i64);
        assert!(eng.has_reverify_backlog(), "还有余量,续做位必须置起来");

        let second = reverify_ok(&mut eng, &mut conn, &mut clock);
        assert_eq!(quarantine_count(&conn), 0, "第二拍把余量做完");
        assert_eq!(
            sends(&second).iter().filter(|m| matches!(m, Msg::Want { .. })).count(),
            N - QUARANTINE_REVERIFY_BATCH,
            "续做那一批也各发一枚追帧 want:{second:?}"
        );
        assert!(!eng.has_reverify_backlog(), "做完必须落位,否则每拍空跑一次 SELECT");

        let third = reverify_ok(&mut eng, &mut conn, &mut clock);
        assert!(third.is_empty(), "工作集已空,不该再产任何输出:{third:?}");
    }

    /// **装配即置位**:表里可能攒着上个版本留下的待重验行,而 `reverify_quarantined` 的
    /// 另一个调用点是会话仪式——纯 LAN 冷启动**根本没有中转会话**,不置位就永远没人做。
    /// 端到端那一半(心跳真把它做掉)在 `transport` 侧那只测里。
    #[test]
    fn freshly_assembled_engine_starts_with_backlog_set() {
        let (conn, _clock, _eng) = fresh();
        let restarted = Engine::new_solo(&conn, BlobPolicy::Full).expect("engine");
        assert!(
            restarted.has_reverify_backlog(),
            "新装引擎必须假定「可能有待重验行」——它拿不到也不该拿会话仪式当唯一触发器"
        );
    }

    /// **重验尾部必须 outbound**(实现审 H4)。`drain` 可以产出**本机**修正 op——回放
    /// 「图 N」撞号翻案会真写一枚 `set_field`;`on_ops` 尾部本来就跟着一次 `outbound`,
    /// 而重验这条路原先 drain 完直接返回,会话仪式那边又是**先 outbound 后 reverify**,
    /// 两头都兜不到,稳定的纯 LAN 会话里那枚修正 op 可以无限期不发。
    ///
    /// 这里拿一枚**普通本机 op** 当探针:它同样只可能被尾部那次 `outbound` 带出去。
    #[test]
    fn reverify_pushes_local_ops_after_drain() {
        let (mut conn, mut clock, mut eng) = fresh();
        seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
        // 本机写一笔:进了 oplog,但出站游标还没推过它。
        crate::notes::capture(&mut conn, &mut clock, "重验尾部该把我推出去").unwrap();

        let outs = reverify_ok(&mut eng, &mut conn, &mut clock);

        assert!(
            outs.iter().any(|o| matches!(o, Output::ServeOps(s) if s.to == OpsServeTo::Broadcast)),
            "恢复一行之后必须顺带把本机待推 op 登记并摇铃:{outs:?}"
        );
        let served = eng.drain_ops_for_test(&conn).unwrap();
        assert!(
            sends(&served).iter().any(|m| matches!(m, Msg::Ops { .. })),
            "而且抽得出那一枚:{served:?}"
        );
    }

    /// **已提交的义务必须随输出交出去,哪怕整笔 Err**(实现审二轮 H1)。
    ///
    /// 批内前面几行可能已经 DELETE、已经进 pending,它们的追帧 want 与 `slot_insert` 的
    /// 驱逐 want 都只在输出里;这些输出若随 `Err` 一起蒸发,`reverify_backlog` 也救不回来
    /// ——它只能重扫**仍在表里**的行,重建不了已删行的义务。故引擎写的是**调用方持有**的
    /// 缓冲。这里让**尾部**失败(丢掉 `topics` 表,前面的 watermark/slot_insert/DELETE 全
    /// 走完,`drain` 落地那枚 topic op 时才炸),断言 Err 之下那枚 want **还在**。
    #[test]
    fn reverify_keeps_already_committed_outputs_even_on_error() {
        let (mut conn, mut clock, mut eng) = fresh();
        seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
        conn.execute("DROP TABLE topics", []).unwrap();

        let mut out = vec![];
        let r = eng.reverify_quarantined(&mut conn, &mut clock, &mut out);

        assert!(r.is_err(), "尾部 drain 必须响亮失败,不然这只测什么也没证:{r:?}");
        assert!(
            sends(&out).iter().any(|m| matches!(m, Msg::Want { .. })),
            "已放行那行的追帧 want 必须随输出交出去,不许跟着 Err 蒸发:{out:?}"
        );
    }

    /// **失败安全:先把会失败的事做完,再动那份唯一材料**(实现审 H3)。
    ///
    /// 恢复分支原先 `DELETE` 打头,其后的 watermark 查询 / `slot_insert` 一旦本地故障,
    /// 这枚 op **既没进 oplog、隔离表里那份唯一完整材料也已经没了**。这里把 `oplog` 表
    /// 弄坏(drop 掉)制造真实的本地故障,断言两件事:①隔离行**还在**(材料没丢);
    /// ②续做位**仍是 true**(纯 LAN 下还有人来重试)。
    #[test]
    fn reverify_local_fault_keeps_material_and_retry_flag() {
        let (mut conn, mut clock, mut eng) = fresh();
        seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
        assert_eq!(quarantine_count(&conn), 1);

        // watermark 查询要读 oplog:删表 = 恢复分支走到一半必 Err。
        conn.execute("DROP TABLE oplog", []).unwrap();
        let mut out = vec![];
        let err = eng.reverify_quarantined(&mut conn, &mut clock, &mut out);
        assert!(err.is_err(), "本地故障必须响亮报出,不许吞:{err:?}");

        assert_eq!(quarantine_count(&conn), 1, "失败了就不许把唯一那份材料删掉");
        assert!(eng.has_reverify_backlog(), "失败必须留着续做位,否则纯 LAN 下再没人重试");
    }

    /// **H1 的最内层:破坏性提交之前,先把会失败的事做完**(实现审三轮)。
    ///
    /// 槽池满额时 `slot_insert` 要 LRU 驱逐一个槽,并为它发一枚**无状态** want —— 那是
    /// 被丢掉的那段缺口此后**唯一**的自愈信号。原先的排法是「先删槽、再查水位」:查询
    /// 一失败,槽已经没了,而 want 连构造都构造不出来,缺口从此没人认领也没人知道。
    #[test]
    fn slot_eviction_asks_before_it_drops() {
        let (conn, _clock, mut eng) = fresh();
        let victim = fill_slots(&conn, &mut eng);

        // 驱逐要先查被驱逐者的水位(读 oplog):删表 = 那一步必真失败。
        conn.execute("DROP TABLE oplog", []).unwrap();
        let mut out = vec![];
        let origin = format!("NEWC0MERDEV{:015}", 1);
        let op = topic_op(&origin, 9_001, 1, &format!("01TPCNEWCOMER{:013}", 1));
        let r = eng.slot_insert(&conn, &origin, PendingOp { op, relay_from: "R".into() }, &mut out);

        assert!(r.is_err(), "水位查不到就该响亮失败,不然这只测什么也没证:{r:?}");
        assert!(
            eng.slots.contains_key(&victim),
            "查询失败时被驱逐者必须还在槽里——删了它就等于把那段缺口丢进黑洞"
        );
        assert!(out.is_empty(), "没真发出去的 want 不许假装发过:{out:?}");
    }

    /// **H1 的另一半:最内层产出的义务也要活过外层的 `?`**(实现审三轮)。
    ///
    /// 二轮只把「输出交给调用方持有」改到了最外层,`slot_insert` 那枚驱逐 want 仍先落进
    /// helper 的私有 `Vec`。而驱逐**已经提交**(槽真删了),恢复分支后面任何一步失败都把
    /// 它带走 —— 这里让尾部 `drain` 炸,断言那枚 want 还在。
    #[test]
    fn reverify_keeps_the_eviction_want_from_the_innermost_helper() {
        let (mut conn, mut clock, mut eng) = fresh();
        seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
        let victim = fill_slots(&conn, &mut eng);
        // 恢复分支的 watermark/slot_insert/DELETE 全走完,`drain` 落地那枚 topic op 时才炸。
        conn.execute("DROP TABLE topics", []).unwrap();

        let mut out = vec![];
        let r = eng.reverify_quarantined(&mut conn, &mut clock, &mut out);

        assert!(r.is_err(), "尾部 drain 必须响亮失败,不然这只测什么也没证:{r:?}");
        assert!(
            sends(&out)
                .iter()
                .any(|m| matches!(m, Msg::Want { origin, .. } if *origin == victim)),
            "被驱逐那个槽的无状态 want 必须活过这枚 Err(它是那段缺口唯一的信号):{out:?}"
        );
    }

    /// **同一条纪律在 `on_msg` 那一跳**(实现审三轮 H1 的最外层):一枚帧处理到一半炸了,
    /// 它此前**已经做成**的事(这里是驱逐一个槽)的通知不许跟着 Err 蒸发。
    #[test]
    fn a_frame_that_blows_up_midway_still_hands_back_what_it_already_did() {
        let (mut conn, mut clock, mut eng) = fresh();
        let victim = fill_slots(&conn, &mut eng);
        conn.execute("DROP TABLE topics", []).unwrap(); // 入池后 drain 落地时才炸。

        let mut out = vec![];
        let (_, frame) = newcomer_frame(2);
        let r = eng.on_msg(&mut conn, &mut clock, "R", Route::Relay, frame, &mut out);

        assert!(r.is_err(), "drain 必须响亮失败,不然这只测什么也没证:{r:?}");
        assert!(
            sends(&out)
                .iter()
                .any(|m| matches!(m, Msg::Want { origin, .. } if *origin == victim)),
            "槽已经被这枚帧驱逐掉了,它的 want 不许随 Err 一起没:{out:?}"
        );
    }

    /// 只让 `sync_meta` 的 **poison_breaker 那一条**写不进去(别的键照写,不然时钟自己
    /// 先炸)。触发器体在执行时才解析名字,故这是 `SQLITE_ERROR` 类的真实本地故障。
    fn break_breaker_writes(conn: &Connection) {
        conn.execute(
            "CREATE TRIGGER tmp_breaker_boom BEFORE INSERT ON sync_meta \
             WHEN NEW.key = 'poison_breaker' BEGIN SELECT 1 FROM no_such_table_boom; END",
            [],
        )
        .unwrap();
    }

    /// **到顶那一枚:先置 breaker,再落隔离行**(实现审四轮 H1)。
    ///
    /// 反着排的话,`trip_breaker` 一失败 breaker 仍是 None,而这个 origin 已经进了
    /// `quarantined` —— 它后续的帧从此走早退分支,**再没有人回来试第二次**;攻击者接着
    /// 拿别的已在册 origin 重演一遍,表照涨,这道资源上界被打回原形。
    #[test]
    fn quarantine_at_cap_trips_the_breaker_before_it_writes_the_row() {
        let (mut conn, mut clock, mut eng) = fresh();
        // 隔离表填到「再来一行就到顶」。
        for i in 0..(QUARANTINE_MAX_ROWS - 1) {
            conn.execute(
                "INSERT INTO sync_quarantine (origin, op_id, origin_seq, op_sha256, reason, \
                 error_stage, validator_ver, at) \
                 VALUES (?1, ?2, 1, ?3, '毒', 'shape', 1, '2026-08-01')",
                rusqlite::params![
                    format!("CAPDEV{i:020}"),
                    format!("01CAPOP{i:019}"),
                    "0".repeat(64), // 指纹档(op_blob NULL)照样占一行,这里只要行数。
                ],
            )
            .unwrap();
        }
        break_breaker_writes(&conn);

        let bad = poison_op(DEV, 1_000, 1);
        let mut out = vec![];
        let r = eng.on_msg(
            &mut conn,
            &mut clock,
            "R",
            Route::Relay,
            Msg::Ops { origin: DEV.into(), ops: vec![bad] },
            &mut out,
        );

        assert!(r.is_err(), "breaker 写不进去就该响亮失败,不然这只测什么也没证:{r:?}");
        assert!(eng.breaker.is_none(), "夹具:breaker 确实没置上");
        assert_eq!(
            quarantine_count(&conn),
            QUARANTINE_MAX_ROWS - 1,
            "闸没落成就不许把这一行记进去——记了它,这个 origin 此后走早退分支,没人再试第二次"
        );
        assert!(
            !eng.quarantined.contains(DEV),
            "同理:入了册就等于把「再试一次」的路堵死了"
        );
    }

    /// **冻结到顶那一支同款**(实现审四轮 H3):先置 breaker,再拆槽。
    #[test]
    fn freeze_at_cap_keeps_the_slot_when_the_breaker_write_fails() {
        let (conn, _clock, mut eng) = fresh();
        let victim = fill_slots(&conn, &mut eng);
        for i in 0..FROZEN_CAP {
            eng.frozen.insert(format!("FRZNDEV{i:019}"), "夹具".into());
        }
        break_breaker_writes(&conn);

        let r = eng.freeze_v(&conn, &victim, "分叉".into());

        assert!(r.is_err(), "breaker 写不进去就该响亮失败:{r:?}");
        assert!(
            eng.slots.contains_key(&victim),
            "闸没落成就不许先把槽拆了——这一枚分叉既没记下也没闸住"
        );
    }

    /// **收尾要用的库事实必须在 apply 之前取**(实现审四轮 H2)。
    ///
    /// 排在 apply 之后的话,那两下查询就成了「op 已写进 oplog、水位已推进、它自己也已经
    /// 离开队列」之后的失败点 —— 缺字节登记 / 死图清理从此**没有人重来**(`settle_pending`
    /// 只记得「还欠一次 drain」,重放不了「哪一枚 op 还欠 settle」)。
    ///
    /// 「收尾不会失败」这件事本身由**类型**钉死:`settle_outcome` 不返回 `Result`,想在
    /// 里面查库都编译不过。剩下要钉的只有「预查排在 apply 之前」—— 行为测在这里造不出
    /// 可控差别(两条路碰的是同两张表:`reconcile_item_images` 也读写 `item_image`、
    /// apply 必写 oplog,弄坏任一张都让两条路同时失败、终局同形),故**诚实降级成按源码
    /// 钉**顺序。
    #[test]
    fn settle_facts_are_read_before_the_op_is_applied() {
        let src = include_str!("engine.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        let at = prod.find("    fn drain(").expect("必有 drain");
        let body =
            &prod[at..at + prod[at..].find("fn settle_outcome(").expect("其后即 settle_outcome")];
        let pre = body.find("settle_precheck(").expect("必先取收尾要用的库事实");
        let take = body.find(".remove(&head_seq)").expect("必从队列取走队头");
        let apply = body.find("replay::apply_remote_op(").expect("必 apply");
        assert!(pre < take && take < apply, "顺序必须是 预查 → 取队头 → apply");
    }

    /// **「先把会失败的事做完,再动破坏性提交」三处的顺序**(实现审四轮 H1/H3)。
    ///
    /// `on_ops` 的 pending 超限那一支造不出可控的行为测(它前面已经查过好几次 oplog,
    /// 弄坏 oplog 会先炸在别处),故**诚实降级成按源码钉**;另两处各自有行为测,这里
    /// 一并钉住顺序,免得日后有人「顺手」把某一处调回去。
    #[test]
    fn destructive_commits_come_after_the_fallible_work() {
        let src = include_str!("engine.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        let seg = |from: &str, to: &str| -> String {
            let a = prod.find(from).unwrap_or_else(|| panic!("锚点不见了:{from}"));
            let b = prod[a..].find(to).unwrap_or_else(|| panic!("锚点不见了:{to}"));
            prod[a..a + b].to_string()
        };
        // ① `slot_insert` 的 LRU 驱逐:查水位 → 拆槽。
        let evict = seg("fn slot_insert(", "self.touch_seq += 1;");
        assert!(
            evict.find("watermark(conn, &evict)").expect("驱逐必查水位")
                < evict.find("self.slots.remove(&evict)").expect("驱逐必拆槽"),
            "驱逐:水位要在拆槽之前查"
        );
        // ② `on_ops` 的 pending 超限:查水位 → 拆槽。
        let over = seg("if over_cap {", "self.emit_wants(");
        assert!(
            over.find("watermark(conn, &origin)").expect("超限必查水位")
                < over.find("self.slots.remove(&origin)").expect("超限必拆槽"),
            "pending 超限:水位要在拆槽之前查(那枚 want 是此刻唯一的重取信号)"
        );
        // ③ `quarantine_origin` 的到顶:置 breaker → 落行。
        let quar = seg("fn quarantine_origin(", "self.quarantined.insert(");
        assert!(
            quar.find("self.trip_breaker(").expect("到顶必置 breaker")
                < quar.find("INSERT INTO sync_quarantine").expect("必落隔离行"),
            "隔离到顶:breaker 要在落行之前置"
        );
    }

    /// **失败路径上,出口那两件照跑**(实现审三轮 H1 的连带项)。
    ///
    /// 来路改写与发问边沿都是**只此一次**的:下一枚帧的 `missing_before` 已是新值,这一
    /// 跳错过就得等下一次偶然的「满转空 / 又贴了新图」。行为测造不出可控场景(要让
    /// `drain` 恰好炸在 image_add 已落地、别的 op 还没轮到的那一刻),故**按源码钉**:
    /// `dispatch_msg` 的结果必须先扣住,两件跑完了才把那枚 Err 交出去。
    #[test]
    fn on_msg_defers_the_frame_error_until_after_its_exit_work() {
        let src = include_str!("engine.rs");
        let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
        let head = prod.find("    pub fn on_msg(").expect("必有 on_msg");
        let body = &prod[head..prod.find("    fn dispatch_msg(").expect("其后即 dispatch_msg")];
        let call = body
            .find("let done = self.dispatch_msg(")
            .expect("结果必须先扣住(当场 `?` 就把出口两件跳过去了)");
        let rewrite =
            body.find("*route_hint = RouteHint::Require(route);").expect("必有来路改写");
        let ask = body.find("self.append_want_batch(out);").expect("必有发问边沿");
        assert!(call < rewrite && rewrite < ask, "顺序必须是 扣住结果 → 来路改写 → 发问边沿");
        assert!(
            body[ask..].contains("\n        done\n"),
            "那枚 Err 必须留到出口两件之后才交出去"
        );
    }

    /// **H2:行已放出隔离表,`drain` 却失败了——这笔债只有 `settle_pending` 记得**。
    ///
    /// `DELETE` 一成功,那些行就**永远不会再被 `WHERE` 选中**。原先的续做位只表示「SQL
    /// 里还可能有行」,下一拍 `rows` 空就把它清成 false:既不会再 drain 也不会 outbound,
    /// 留下「已归池却没结算的 op」和「翻案产出却没推出去的本机修正 op」两类无主义务。
    #[test]
    fn reverify_still_owes_a_drain_after_the_row_is_gone() {
        let (mut conn, mut clock, mut eng) = fresh();
        seed_reverifiable(&mut conn, &mut clock, &mut eng, 1);
        // **可逆**的本地故障:触发器体在执行时才解析名字,故这是 SQLITE_ERROR(→
        // LocalFault),不是约束违例(那会被判成 InvalidOp 重新隔离,跑的就不是这条路了)。
        conn.execute(
            "CREATE TRIGGER tmp_boom BEFORE INSERT ON topics \
             BEGIN SELECT 1 FROM no_such_table_boom; END",
            [],
        )
        .unwrap();

        let mut out = vec![];
        let r = eng.reverify_quarantined(&mut conn, &mut clock, &mut out);
        assert!(r.is_err(), "drain 必须真失败:{r:?}");
        assert_eq!(quarantine_count(&conn), 0, "行确实已经放出表了——不然跑的不是这条路");
        assert!(eng.needs_reverify_tick(), "债还欠着,门槛必须还是 true");

        // 故障消失,下一拍:`WHERE` 已经一行都选不到,只有那一位记得还欠着 drain。
        conn.execute("DROP TRIGGER tmp_boom", []).unwrap();
        let mut out2 = vec![];
        eng.reverify_quarantined(&mut conn, &mut clock, &mut out2).expect("这一拍该成");

        assert_eq!(
            watermark(&conn, &reverify_dev(0)).unwrap(),
            1,
            "那枚 op 必须在这一拍真落地,而不是躺在池里等一枚偶然的 Ops 帧"
        );
        assert!(!eng.needs_reverify_tick(), "两件都做成了才许落位");
    }

    /// 冻结表到顶后,breaker 闸口升级为「拒收一切尚未 frozen/quarantine 在册的 origin」
    /// (实现审 H1 的另一半)——**连已在册的也拒**,本测的夹具正是一个已在册 origin。
    ///
    /// 光靠 `freeze` 那边不插表还不够:旧闸只拦「新 origin」(本地日志无其 op 的),
    /// 已在册 origin 照样一路走到分叉检测。到顶意味着**已无处安全记录新的分叉**,
    /// 此时再放行就是让分叉再也拦不住——这一刀才让 `FROZEN_CAP` 成为真上界。
    #[test]
    fn breaker_at_frozen_cap_rejects_even_registered_origins() {
        let (mut conn, mut clock, mut eng) = fresh();
        // 一个**已在册**的正常 origin(本地日志有它的 op,故老闸放行)。
        const KNOWN: &str = "KN0WNDEV000000000000000001";
        let ops = |seq: i64| Msg::Ops {
            origin: KNOWN.into(),
            ops: vec![topic_op(KNOWN, 1_000 + seq as u64, seq, &format!("01TOPICKN0WN{seq:013}"))],
        };
        eng.on_relay_msg(&mut conn, &mut clock, KNOWN, ops(1)).unwrap();
        assert_eq!(watermark(&conn, KNOWN).unwrap(), 1, "夹具前提:它已在册");
        // 分叉风暴把冻结表塞满并撑到 breaker。
        for i in 0..=FROZEN_CAP {
            eng.freeze_v(&conn, &format!("FRGDDEV{i:03}0000000000000000"), "伪造分叉".into())
                .unwrap();
        }
        assert!(eng.breaker.is_some() && eng.frozen.len() == FROZEN_CAP);
        // 已在册也不再放行:整帧拒收,水位纹丝不动。
        let outs = eng.on_relay_msg(&mut conn, &mut clock, KNOWN, ops(2)).unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Event(Event::FrameRejected { .. }))),
            "冻结表到顶后必须拒收未在册 origin 的帧:{outs:?}"
        );
        assert_eq!(watermark(&conn, KNOWN).unwrap(), 1, "拒收 = 不落地");
    }

    // ---- 引擎活到 runtime 生命期(lan-direct-plan 不变量 6,L-c2a) --------------------

    /// 本地删掉宿主条目 → 名下缺字节的图当场出清单、在飞拉流一并作废。
    ///
    /// 引擎随会话生灭时这条靠「下次装配重新 derive」兜着;活到 runtime 生命期之后
    /// 兜底没了,不清就是每次会话仪式都对死图广播一遍谁也答不了的 want。
    #[test]
    fn local_tombstone_evicts_dead_images_from_the_missing_list() {
        let (mut a_conn, mut a_clock, _a) = fresh();
        let (mut b_conn, mut b_clock, mut b) = fresh();
        let a_id = a_clock.device_id().to_string();
        let kept = notes::capture(&mut a_conn, &mut a_clock, "留着的条目").unwrap();
        let (img_kept, _) =
            images::attach(&mut a_conn, &mut a_clock, &kept, &[1u8; 9], "image/png").unwrap();
        let doomed = notes::capture(&mut a_conn, &mut a_clock, "待删的条目").unwrap();
        let (img_doomed, _) =
            images::attach(&mut a_conn, &mut a_clock, &doomed, &[2u8; 9], "image/png").unwrap();
        let doomed2 = notes::capture(&mut a_conn, &mut a_clock, "也要删的条目").unwrap();
        let (img_doomed2, _) =
            images::attach(&mut a_conn, &mut a_clock, &doomed2, &[4u8; 9], "image/png").unwrap();
        b.on_runtime_started(&b_conn).unwrap();
        b.relay_up(&b_conn).unwrap();
        feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
        assert!(
            [&img_kept, &img_doomed, &img_doomed2].iter().all(|i| b.missing_blobs.contains(*i)),
            "夹具前提:三张图的字节都还没到"
        );
        // 待删那张已经在拉了(证明作废的是「清单 ∪ 在飞」两处,不是只清单)。
        b.on_relay_peer_up(&a_id);
        let outs = b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have(&img_doomed)).unwrap();
        assert!(pull_of(&outs).is_some() && b.pulling.contains_key(&img_doomed), "夹具前提:在飞");

        // 用户在 B 上把那条连图一起删了(回收站 → 彻底删)。
        notes::archive(&mut b_conn, &mut b_clock, &doomed).unwrap();
        notes::purge(&mut b_conn, &mut b_clock, &doomed).unwrap();
        b.on_local_ops_settled(&b_conn).unwrap();
        assert!(!b.pulling.contains_key(&img_doomed), "死图的在飞拉流必须作废");
        assert!(!b.missing_blobs.contains(&img_doomed), "死图必须出缺字节清单");
        assert!(b.missing_blobs.contains(&img_kept), "没被删的那张一动不能动");
        // 再删一条,这次**不手动结算**:会话仪式必须自己先结算再按清单发 want
        // (结算收在 `on_relay_session_up` 第一步的那条契约,靠这只测守着)。
        notes::archive(&mut b_conn, &mut b_clock, &doomed2).unwrap();
        notes::purge(&mut b_conn, &mut b_clock, &doomed2).unwrap();
        let outs = b.relay_up(&b_conn).unwrap();
        let asked: Vec<String> = sends(&outs)
            .iter()
            .filter_map(|m| match m {
                Msg::BlobWant { image_id } => Some(image_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(asked, vec![img_kept], "会话仪式只该问活着的那张:{asked:?}");
    }

    /// 结算游标单调只进:扫过的窗口不重扫。
    ///
    /// 不然「删过又因别的缘由回了清单」的同一枚 id 会被旧窗口里的 tombstone 反复
    /// 摘掉——而缺字节清单是可丢内存态,回清单的路子不止一条(路由失效、坏块、
    /// deny 都会把图退回来)。
    #[test]
    fn local_settled_cursor_never_rescans() {
        let (mut a_conn, mut a_clock, _a) = fresh();
        let (mut b_conn, mut b_clock, mut b) = fresh();
        let a_id = a_clock.device_id().to_string();
        let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
        let (img, _) =
            images::attach(&mut a_conn, &mut a_clock, &item, &[3u8; 12], "image/png").unwrap();
        b.on_runtime_started(&b_conn).unwrap();
        feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
        notes::archive(&mut b_conn, &mut b_clock, &item).unwrap();
        notes::purge(&mut b_conn, &mut b_clock, &item).unwrap();
        b.on_local_ops_settled(&b_conn).unwrap();
        assert!(!b.missing_blobs.contains(&img));
        // 图因别的缘由回了清单(路由失效 / 坏块 / deny 都会把图退回来)。
        b.missing_blobs.insert(img.clone());
        // 再记一笔本地写,把水位推到游标之上——**逼结算真去扫一段**。少了这一步,
        // 「max <= 游标」的早返回会替扫描下界背书,下界写成 0 也测不出来。
        notes::capture(&mut b_conn, &mut b_clock, "本地又记一条").unwrap();
        b.on_local_ops_settled(&b_conn).unwrap();
        assert!(b.missing_blobs.contains(&img), "结算过的窗口不许重扫");
    }

    /// 会话仪式复位的是 **UI 去重位**,不是引擎的数据事实。
    ///
    /// 引擎跨会话存活后这条线必须钉死:去重位(挂起原因 / 偏斜提示 / breaker 拒帧)
    /// 不复位就变成「每引擎报一次」——重连清空了状态面的 error,用户此后再也看不到
    /// 仍在挂起的那条;而冻结、隔离、缺字节清单是引擎的当前事实,换条中转会话不构成
    /// 忘掉它们的理由。
    #[test]
    fn session_up_resets_ui_dedup_but_keeps_engine_facts() {
        let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
        let _ = a_id;
        eng.frozen.insert("FRZNDEV0000000000000000002".into(), "分叉".into());
        // 未知词汇 = 版本偏斜挂起。挂起的 origin 要等**别的 origin 落地**才解锁重试
        // (drain 的既有语义),故重试触发器统一用另一台设备的合法 op。
        const SPND: &str = "SPNDDEV0000000000000000001";
        const OTHER: &str = "0THERDEV000000000000000003";
        let suspend_spnd = |eng: &mut Engine, conn: &mut Connection, clock: &mut Clock| {
            let mut op = topic_op(SPND, 5_000, 1, "01TOPICSUSPEND00000000001");
            op.kind = "kind_from_the_future".into();
            let outs = eng
                .on_relay_msg(conn, clock, SPND, Msg::Ops { origin: SPND.into(), ops: vec![op] })
                .unwrap();
            outs.iter().any(|o| matches!(o, Output::Event(Event::OriginSuspended { .. })))
        };
        let retry_spnd = |eng: &mut Engine, conn: &mut Connection, clock: &mut Clock, seq: i64| {
            let op = topic_op(OTHER, 6_000 + seq as u64, seq, &format!("01TOPIC0THER{seq:013}"));
            let outs = eng
                .on_relay_msg(conn, clock, OTHER, Msg::Ops { origin: OTHER.into(), ops: vec![op] })
                .unwrap();
            outs.iter().any(|o| matches!(o, Output::Event(Event::OriginSuspended { .. })))
        };
        assert!(suspend_spnd(&mut eng, &mut conn, &mut clock), "首次挂起必报");
        assert!(!retry_spnd(&mut eng, &mut conn, &mut clock, 1), "同因不重报");

        // 换一条中转会话。
        eng.relay_up(&conn).unwrap();
        assert!(eng.frozen.contains_key("FRZNDEV0000000000000000002"), "冻结是数据事实,不随会话忘");
        assert!(eng.missing_blobs.contains(&img), "缺字节清单同理");
        assert!(
            retry_spnd(&mut eng, &mut conn, &mut clock, 2),
            "新会话必须重新报一次仍在挂起的那条"
        );
    }

    // ---- 路由维度(lan-direct-plan §5.1/§5/§6) ----------------------------------------

    /// 一台缺一张图的引擎:A 端真 attach 一张图,B 端收完 op(行不建)→ 进缺字节清单。
    /// B 已「装配 + 中转会话建立」但**无任何对端在线**(路由表空),故默认无健康腿:
    /// 各测试自己按需 `on_relay_peer_up` / `on_lan_link_up`。
    /// 返回 (B 的库, B 的钟, B 的引擎, 图 id, A 的 device_id)。
    fn peer_missing_one_image() -> (Connection, Clock, Engine, String, String) {
        let (mut a_conn, mut a_clock, _a) = fresh();
        let (mut b_conn, mut b_clock, mut b) = fresh();
        let item = notes::capture(&mut a_conn, &mut a_clock, "带图条目").unwrap();
        let (img, _) =
            images::attach(&mut a_conn, &mut a_clock, &item, &[3u8; 12], "image/png").unwrap();
        let a_id = a_clock.device_id().to_string();
        // 真接线顺序:装配即活 → 中转会话建立(→ 各测试自己置对端在线/链路)。
        b.on_runtime_started(&b_conn).unwrap();
        b.relay_up(&b_conn).unwrap();
        feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
        assert!(b.missing_blobs.contains(&img), "夹具前提:B 缺这张图的字节");
        (b_conn, b_clock, b, img, a_id)
    }

    fn have(img: &str) -> Msg {
        Msg::BlobHave { image_id: img.into() }
    }

    /// C′ 的取数原语:块边界算对、末块标志对、**行没了/换了行一律 `None`**(调用方据此
    /// 回 deny)。这是分段供流唯一的取数点,切块这件事只有它一处实现。
    #[test]
    fn read_blob_chunk_walks_the_boundaries_and_notices_a_vanished_row() {
        let (mut conn, mut clock, _e) = fresh();
        let item = notes::capture(&mut conn, &mut clock, "带图").unwrap();
        // 刻意不整除:末块必须是短的那一段。
        let size = BLOB_CHUNK_BYTES * 2 + 7;
        let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let (img, _) = images::attach(&mut conn, &mut clock, &item, &bytes, "image/png").unwrap();
        let (rowid, total): (i64, i64) = conn
            .query_row("SELECT rowid, length(data) FROM item_image WHERE id = ?1", [&img], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let serve = BlobServe {
            to: "01PEERAAAAAAAAAAAAAAAAAAAA".into(),
            route: Route::Lan,
            image_id: img.clone(),
            transfer: "01TRANSFER0000000000000042".into(),
            rowid,
            total,
        };
        assert_eq!(serve.chunks(), 3, "两整块 + 一小截");
        assert!(!serve.is_last(1) && serve.is_last(2));
        let mut got = vec![];
        for idx in 0..serve.chunks() {
            let chunk = read_blob_chunk(&conn, &serve, idx).unwrap().expect("行还在");
            let want = if idx == 2 { 7 } else { BLOB_CHUNK_BYTES };
            assert_eq!(chunk.len(), want, "第 {idx} 块长度");
            got.extend_from_slice(&chunk);
        }
        assert_eq!(got, bytes, "逐块拼回来必须与原图逐位相等");
        assert!(read_blob_chunk(&conn, &serve, 3).is_err(), "越界取块 = 本机 bug,响亮报");

        images::remove(&mut conn, &mut clock, &img).unwrap();
        assert!(
            read_blob_chunk(&conn, &serve, 0).unwrap().is_none(),
            "行没了必须 None(调用方据此回 deny,不让收端干等 stale)"
        );
        // rowid 被别的图复用:光看 rowid 会把别人的字节当成这张图发出去。
        let other = notes::capture(&mut conn, &mut clock, "另一条").unwrap();
        let (_img2, _) =
            images::attach(&mut conn, &mut clock, &other, &bytes, "image/png").unwrap();
        let reused: i64 =
            conn.query_row("SELECT rowid FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(reused, rowid, "夹具前提:删空后新插入必然拿回同一个 rowid");
        assert!(
            read_blob_chunk(&conn, &serve, 0).unwrap().is_none(),
            "rowid 被复用时必须靠 id 复核认出来(光看 rowid 会把别人的字节当成这张图发出去)"
        );
    }

    /// 放大面(263 codex 顺带点名):`BlobPull` 的 `image_id`/`transfer` 是已鉴权对端可控的
    /// 任意字符串,而供流要把它们**逐块抄进每一枚 BlobChunk**——不复核形态,一枚长串就能
    /// 被放大 128 倍写上线。不合 ULID = 响亮拒帧,且**不回 deny**(回 deny 等于把同一份长
    /// 串再抄一遍出去)。
    #[test]
    fn blob_pull_with_a_malformed_id_is_rejected_without_echoing_it() {
        let (mut conn, mut clock, mut eng) = fresh();
        let item = notes::capture(&mut conn, &mut clock, "带图").unwrap();
        let (img, _) =
            images::attach(&mut conn, &mut clock, &item, &[7u8; 40], "image/png").unwrap();
        let long = "X".repeat(4096);
        for (image_id, transfer) in
            [(img.clone(), long.clone()), (long.clone(), "01TRANSFER0000000000000042".into())]
        {
            let outs = eng
                .on_relay_msg(
                    &mut conn,
                    &mut clock,
                    "01PEERAAAAAAAAAAAAAAAAAAAA",
                    Msg::BlobPull { image_id, transfer },
                )
                .unwrap();
            assert!(frame_rejected(&outs), "形态不合必须响亮拒:{outs:?}");
            assert!(
                !outs.iter().any(|o| matches!(
                    o,
                    Output::ServeBlob(_)
                        | Output::Send { msg: Msg::BlobDeny { .. } | Msg::BlobChunk { .. }, .. }
                )),
                "拒帧那一路一个字节都不许回给它:{outs:?}"
            );
        }
        // 合法形态照常供流(阴性对照:上面那两条不是「什么都不答」蒙的)。
        let ok = eng
            .on_relay_msg(
                &mut conn,
                &mut clock,
                "01PEERAAAAAAAAAAAAAAAAAAAA",
                Msg::BlobPull { image_id: img, transfer: "01TRANSFER0000000000000042".into() },
            )
            .unwrap();
        assert!(matches!(&ok[..], [Output::ServeBlob(_)]), "合法拉流必须产出供流:{ok:?}");
    }

    /// §10 C′ 的收端窗口:全局同时只许一笔在飞拉流(不然 N 张缺图就是 N 份最大 32 MiB 的
    /// 攒块缓冲),**且槽一腾出来必须补问下一张**——封了窗口又不补问就是把清单锁死。
    #[test]
    fn the_receive_window_is_one_and_refills_when_it_frees() {
        let (mut a_conn, mut a_clock, _a) = fresh();
        let (mut b_conn, mut b_clock, mut b) = fresh();
        let a_id = a_clock.device_id().to_string();
        let item = notes::capture(&mut a_conn, &mut a_clock, "两张图").unwrap();
        let (one, _) =
            images::attach(&mut a_conn, &mut a_clock, &item, &[1u8; 20], "image/png").unwrap();
        let (two, _) =
            images::attach(&mut a_conn, &mut a_clock, &item, &[2u8; 24], "image/png").unwrap();
        b.on_runtime_started(&b_conn).unwrap();
        b.relay_up(&b_conn).unwrap();
        b.on_relay_peer_up(&a_id);
        feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
        assert_eq!(b.missing_blobs.len(), 2, "夹具前提:B 缺两张");

        // 两枚 have 一起到:只许起一笔。
        b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have(&one)).unwrap();
        let outs = b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have(&two)).unwrap();
        assert_eq!(b.pulling.len(), 1, "收端窗口 = 1");
        assert!(pull_of(&outs).is_none(), "窗口满时不许再起一笔:{outs:?}");
        assert!(b.missing_blobs.contains(&two), "第二张留在清单里,不是被丢了");

        // 第一笔走完 → 槽腾出 → 当场补问(不必等心跳)。
        let pulled = b.pulling.keys().next().unwrap().clone();
        let transfer = b.pulling[&pulled].transfer.clone();
        let src = if pulled == one { &[1u8; 20][..] } else { &[2u8; 24][..] };
        let outs = b
            .on_relay_msg(
                &mut b_conn,
                &mut b_clock,
                &a_id,
                Msg::BlobChunk {
                    image_id: pulled.clone(),
                    transfer,
                    idx: 0,
                    last: true,
                    data: src.to_vec(),
                },
            )
            .unwrap();
        assert!(b.pulling.is_empty(), "终块到齐 = 槽腾出");
        assert!(
            outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::BlobWant { image_id }, .. }
                if image_id != &pulled)),
            "槽腾出必须补问下一张:{outs:?}"
        );
    }

    /// 264 实现审 H1:**块形必须与声明字节数严格对上**。原先只查「序号连号 ∧ 不超声明
    /// 字节」,于是一串空块全部合法通过、每一枚又把 idle 计时清零——`buf` 永不增长、
    /// transfer 永不结束、也永不判死;收端窗口封到一笔之后,这不再只是劫持一张图,而是
    /// **整条图字节通道停摆**(别的图的 have 全被窗口挡在门外)。
    ///
    /// 四种坏形状各来一次,每次都必须走 [`Engine::fail_pull`] 的收口(窗口腾出 + 图回
    /// 清单 + 当场重问),而不是被静默收下。
    #[test]
    fn malformed_chunk_shapes_cannot_hold_the_receive_window() {
        // 声明 300 KiB = 两块(256 KiB + 51,200 B)。
        const SIZE: usize = 300 * 1024;
        let tail = SIZE - BLOB_CHUNK_BYTES;
        let bad: Vec<(&str, u32, bool, usize)> = vec![
            ("空块", 0, false, 0),
            ("短的非末块", 0, false, BLOB_CHUNK_BYTES - 1),
            ("非末块却标了 last", 0, true, BLOB_CHUNK_BYTES),
            ("末块长度不对", 1, true, tail - 1),
        ];
        for (what, idx, last, len) in bad {
            let (mut a_conn, mut a_clock, _a) = fresh();
            let (mut b_conn, mut b_clock, mut b) = fresh();
            let a_id = a_clock.device_id().to_string();
            let item = notes::capture(&mut a_conn, &mut a_clock, "带图").unwrap();
            let (img, _) = images::attach(
                &mut a_conn,
                &mut a_clock,
                &item,
                &vec![7u8; SIZE],
                "image/png",
            )
            .unwrap();
            b.on_runtime_started(&b_conn).unwrap();
            b.relay_up(&b_conn).unwrap();
            b.on_relay_peer_up(&a_id);
            feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
            b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, have(&img)).unwrap();
            let transfer = b.pulling[&img].transfer.clone();
            // 坏形状之前先合法推进一块(末块那一形要 idx=1 才够得着)。
            if idx == 1 {
                b.on_relay_msg(
                    &mut b_conn,
                    &mut b_clock,
                    &a_id,
                    Msg::BlobChunk {
                        image_id: img.clone(),
                        transfer: transfer.clone(),
                        idx: 0,
                        last: false,
                        data: vec![7u8; BLOB_CHUNK_BYTES],
                    },
                )
                .unwrap();
            }
            let outs = b
                .on_relay_msg(
                    &mut b_conn,
                    &mut b_clock,
                    &a_id,
                    Msg::BlobChunk {
                        image_id: img.clone(),
                        transfer,
                        idx,
                        last,
                        data: vec![7u8; len],
                    },
                )
                .unwrap();
            assert!(b.pulling.is_empty(), "{what}:窗口必须当场腾出");
            assert!(b.missing_blobs.contains(&img), "{what}:图回清单");
            // 恰一枚:回清单必配重问,而**同一张图一轮只问一次**(实现审 L1——fail_pull
            // 自带的 rewant 与出口那批会撞车)。
            assert_eq!(
                outs.iter().filter(|o| want_image_of(o) == Some(img.as_str())).count(),
                1,
                "{what}:该图恰问一枚:{outs:?}"
            );
            // **必须拒在块形闸上**,不许被收下、攒进 buf、一路跑到终局验货才失败:那会
            // 白攒一整笔、把「形态不合」报成「坏字节」,而「非末块却标了 last」这一形正是
            // 靠这条才与「验货失败」区分得开(否则两条路的可观测终局一模一样)。
            assert!(!frame_rejected(&outs), "{what}:形态不合该在块形闸上拒,不该跑到验货:{outs:?}");
            assert!(b.blob_penalized(&a_id, Route::Relay), "{what}:坏块 = 罚这条腿");
        }
    }

    /// 264 实现审 H2:**一次引擎输入产出的 `BlobWant` 有硬上界**。原先 hello / 会话仪式 /
    /// 新 image_add 各自遍历全量缺字节清单——一枚合法 `Ops` 帧最多 500 条 op,全是
    /// `image_add` 就是 500 枚帧,而每链发送队列只有 256 帧:一次 dispatch 撞穿、断链、
    /// 重建后再换一轮 hello 又来一遍,与 263 那个 bug 同族(负载从「单图 128 块」换成了
    /// 「清单 N 枚 want」)。
    #[test]
    fn one_input_never_produces_more_wants_than_the_link_queue_can_take() {
        let (mut a_conn, mut a_clock, _a) = fresh();
        let (mut b_conn, mut b_clock, mut b) = fresh();
        let a_id = a_clock.device_id().to_string();
        let item = notes::capture(&mut a_conn, &mut a_clock, "一堆图").unwrap();
        const N: usize = 120; // > BLOB_WANT_BATCH,且够多到能看出「不是全量」
        for i in 0..N {
            images::attach(&mut a_conn, &mut a_clock, &item, &[(i % 251) as u8; 16], "image/png")
                .unwrap();
        }
        b.on_runtime_started(&b_conn).unwrap();
        b.relay_up(&b_conn).unwrap();

        // ① 一帧塞满 image_add 的 ops:登记进清单,但产出的 want 不许超批。
        let frames =
            ops_frames(&a_conn, &a_id, 1, watermark(&a_conn, &a_id).unwrap(), "B").unwrap();
        let mut most = 0usize;
        for f in frames {
            let Output::Send { msg, .. } = f else { continue };
            let outs = b.on_relay_msg(&mut b_conn, &mut b_clock, &a_id, msg).unwrap();
            most = most.max(outs.iter().filter(|o| want_image_of(o).is_some()).count());
        }
        assert_eq!(b.missing_blobs.len(), N, "清单该登记的一张不少");
        assert!(most <= BLOB_WANT_BATCH, "一帧最多问 {BLOB_WANT_BATCH} 张,实见 {most}");
        assert!(most > 0, "也不能一张都不问(那就没人推进了)");

        // ② hello 换来的缺图 want 同样有界。
        let outs = b
            .on_relay_msg(
                &mut b_conn,
                &mut b_clock,
                &a_id,
                Msg::Hello { watermarks: BTreeMap::new(), lan: None },
            )
            .unwrap();
        let wants = outs.iter().filter(|o| want_image_of(o).is_some()).count();
        assert!(wants <= BLOB_WANT_BATCH, "hello 最多问 {BLOB_WANT_BATCH} 张,实见 {wants}");
        assert!(wants > 0, "也不能一张都不问(实现审二轮 L3:只断上界的话,改成『不发问』照样绿)");

        // ③ 会话仪式同样有界(原先它也遍历全量清单)。
        let outs = b.relay_up(&b_conn).unwrap();
        let wants = outs.iter().filter(|o| want_image_of(o).is_some()).count();
        assert!(wants <= BLOB_WANT_BATCH, "会话仪式最多问 {BLOB_WANT_BATCH} 张,实见 {wants}");
        assert!(wants > 0, "会话仪式也得真问(同上)");

        // ④ 心跳这一路同样有界,且**同图不重复**(二轮 L1:`fail_pull` 的重问与这一批
        //    会撞车,`on_tick` 原先漏了去重)。
        let outs = b.on_tick();
        let wants: Vec<&str> = outs.iter().filter_map(want_image_of).collect();
        assert!(wants.len() <= BLOB_WANT_BATCH, "心跳最多问 {BLOB_WANT_BATCH} 张,实见 {}", wants.len());
        let uniq: HashSet<&&str> = wants.iter().collect();
        assert_eq!(uniq.len(), wants.len(), "一轮里同一张图不许问两枚:{wants:?}");
    }

    /// 补问的**轮转**:清单里那张排最前的图若根本没人有,恒取最小就会把后面的永久挡住。
    /// 心跳每拍推一格游标,故清单里每张都在 N 拍内被问到。
    #[test]
    fn the_refill_cursor_rotates_so_no_missing_image_is_starved() {
        let (mut a_conn, mut a_clock, _a) = fresh();
        let (mut b_conn, mut b_clock, mut b) = fresh();
        let a_id = a_clock.device_id().to_string();
        let item = notes::capture(&mut a_conn, &mut a_clock, "三张图").unwrap();
        let mut imgs = vec![];
        for i in 0..3u8 {
            let (id, _) =
                images::attach(&mut a_conn, &mut a_clock, &item, &[i + 1; 16], "image/png").unwrap();
            imgs.push(id);
        }
        b.on_runtime_started(&b_conn).unwrap();
        b.relay_up(&b_conn).unwrap();
        feed_all_ops(&a_conn, &a_id, &mut b_conn, &mut b_clock, &mut b);
        assert_eq!(b.missing_blobs.len(), 3);

        // 谁也不应答:光靠心跳,三拍之内三张都得被问到一次。
        let mut asked: HashSet<String> = HashSet::new();
        for _ in 0..3 {
            for o in b.on_tick() {
                if let Output::Send { msg: Msg::BlobWant { image_id }, .. } = o {
                    asked.insert(image_id);
                }
            }
        }
        assert_eq!(asked.len(), 3, "三拍内三张全被问过:{asked:?}");
    }

    /// 取出唯一一枚 BlobPull 的 (路由意向, transfer)。
    fn pull_of(outs: &[Output]) -> Option<(RouteHint, String)> {
        outs.iter().find_map(|o| match o {
            Output::Send { route_hint, msg: Msg::BlobPull { transfer, .. }, .. } => {
                Some((*route_hint, transfer.clone()))
            }
            _ => None,
        })
    }

    #[test]
    fn blob_route_picks_lan_first_and_never_conjures_a_route() {
        // §5.1:选路只看路由健康表——两条腿都不 Up 就**不拉**(图留在清单),
        // 绝不「先试服务器再靠 Nack 学状态」;两条都 Up 时 LAN 优先。
        let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
        // ① 无腿:have 到了也不拉,图仍在缺字节清单。
        let outs = eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
        assert!(pull_of(&outs).is_none(), "无健康腿不许发 pull:{outs:?}");
        assert!(eng.pulling.is_empty() && eng.missing_blobs.contains(&img), "图留在清单等重来");
        // ② 只有中转腿:走中转。
        eng.on_relay_peer_up(&a_id);
        let outs = eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
        let (hint, _) = pull_of(&outs).expect("有中转腿必拉");
        assert_eq!(hint, RouteHint::Require(Route::Relay));
        assert_eq!(eng.pulling[&img].route, Route::Relay);
        // ③ 两条腿都在:LAN 优先(重来一遍:先把这笔拉流作废)。
        eng.on_relay_peer_down(&a_id);
        eng.on_relay_peer_up(&a_id);
        eng.on_lan_link_up(&conn, &a_id, 7).unwrap();
        let outs = eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
        let (hint, _) = pull_of(&outs).expect("两条腿都在也得拉");
        assert_eq!(hint, RouteHint::Require(Route::Lan), "LAN 优先");
        assert_eq!(eng.pulling[&img].generation, 7, "transfer 绑住链路代次");
    }

    /// 打 `times` 拍心跳(§6.2 ⑥):推进引擎 tick,并让 [`OpsWorks::on_tick`] 把冷却里
    /// 停着的对账/补洞义务放行。
    ///
    /// sans-io 夹具没有协调者,这一拍**得自己打**。少了它,「同一对端的第二枚 Hello」
    /// 恒停在 `pending`,于是任何跟在它后面的判据验的其实都是冷却 —— 那正是 292 栽过的
    /// 「判据看的那一格压根不由被测那件事决定」。
    fn beat_ops(eng: &mut Engine, conn: &Connection, times: u64) {
        for _ in 0..times {
            eng.on_tick();
            // 这一拍产出的帧本测不关心(要的只是「冷却到点」这个副作用)。
            let _ = eng.ops_tick(conn, &mut vec![]).expect("ops tick");
        }
    }

    #[test]
    fn arrival_leg_affinity_pins_directed_answers_only() {
        // §5/§6:定向应答沿来路(LAN 到达 → Require(Lan));广播帧不改写(补洞 want /
        // 缺图 want 该问所有人);direct lane 恒钉来路(同一 transfer 不跨路)。
        let (mut conn, mut clock, mut eng, _img, a_id) = peer_missing_one_image();
        // LAN 到达的 hello:定向 BlobWant 钉 Require(Lan)。
        let outs = eng
            .on_msg_v(
                &mut conn,
                &mut clock,
                &a_id,
                Route::Lan,
                Msg::Hello { watermarks: BTreeMap::new(), lan: None },
            )
            .unwrap();
        // 第5笔:**来路亲和搬到了描述符上**。补给帧不再由引擎当场产出,故「沿来路答」
        // 这件事此后钉在 `OpsServeTo::Peer{route}` 里 —— 由它决定摇哪条腿的铃(投递面
        // 照 `BlobServe.route` 的成例分路)。判据跟着搬,语义一个字没变。
        let supply = outs
            .iter()
            .find_map(|o| match o {
                Output::ServeOps(OpsServe { to: OpsServeTo::Peer { device, route } }) => {
                    Some((device.clone(), *route))
                }
                _ => None,
            })
            .expect("hello 换来定向补给的描述符");
        assert_eq!(supply.0, a_id, "定向补给它");
        assert_eq!(supply.1, Route::Lan, "沿来路答");
        assert!(
            !eng.drain_ops_for_test(&conn).unwrap().is_empty(),
            "而且真抽得出补给帧(描述符不该指向一份空计划)"
        );
        // 同一枚 hello 换来的**缺图 want 是广播**:§5「广播帧一律不改写——补洞 want /
        // 缺图 want 是该让所有人知道的,不因某帧来路窄化收件面」。264 起 hello 的缺图
        // 发问统一走有界轮转批([`Engine::want_batch`]),不再按对端定向问全量清单。
        let want = outs
            .iter()
            .find(|o| matches!(o, Output::Send { msg: Msg::BlobWant { .. }, .. }))
            .expect("hello 换来缺图 want");
        let Output::Send { to, route_hint, .. } = want else { unreachable!() };
        assert_eq!(to, BROADCAST, "缺图 want 该问所有人");
        assert_eq!(*route_hint, RouteHint::Auto, "广播不因来路窄化收件面");
        // 同一枚 hello 经中转到达:定向补给照 Auto(留着「对端中转离线补投 lan」那条腿)。
        //
        // ⚠ 先打够心跳:第⑤笔起**同一对端的第二枚 Hello 受对账冷却管**
        // (`RECONCILE_COOLDOWN_TICKS`),不放行的话下面那句 expect 验的是冷却、不是来路亲和。
        beat_ops(&mut eng, &conn, ops_serve::RECONCILE_COOLDOWN_TICKS);
        let outs = eng
            .on_relay_msg(
                &mut conn,
                &mut clock,
                &a_id,
                Msg::Hello { watermarks: BTreeMap::new(), lan: None },
            )
            .unwrap();
        // 同前:来路亲和钉在描述符上。中转到达 → 描述符绑 `Route::Relay`。
        let supply = outs
            .iter()
            .find_map(|o| match o {
                Output::ServeOps(OpsServe { to: OpsServeTo::Peer { device, route } }) => {
                    Some((device.clone(), *route))
                }
                _ => None,
            })
            .expect("hello 换来定向补给的描述符");
        assert_eq!(supply.0, a_id);
        assert_eq!(supply.1, Route::Relay, "中转到达就绑中转腿");
        // 广播帧不改写:LAN 到达的 ops 帧留下缺口 → 广播 want 仍是 Auto。
        let op2 = topic_op(DEV, 1_002, 2, "01TOPICROUTE0000000000001");
        let outs = eng
            .on_msg_v(
                &mut conn,
                &mut clock,
                DEV,
                Route::Lan,
                Msg::Ops { origin: DEV.into(), ops: vec![op2] },
            )
            .unwrap();
        let bcast = outs
            .iter()
            .find(|o| matches!(o, Output::Send { msg: Msg::Want { .. }, .. }))
            .expect("洞在 1,必广播 want");
        let Output::Send { to, route_hint, .. } = bcast else { unreachable!() };
        assert_eq!(to, BROADCAST);
        assert_eq!(*route_hint, RouteHint::Auto, "广播不因来路窄化收件面");
        // direct lane:经中转到达的 pull,块也钉 Require(Relay)(不许中途改道)。
        let mut serving = fresh();
        let item = notes::capture(&mut serving.0, &mut serving.1, "供块方").unwrap();
        let (simg, _) =
            images::attach(&mut serving.0, &mut serving.1, &item, &[5u8; 8], "image/png").unwrap();
        let served = serving
            .2
            .on_relay_msg(
                &mut serving.0,
                &mut serving.1,
                "PULLERDEV00000000000000001",
                Msg::BlobPull { image_id: simg, transfer: "01TRANSFER0000000000000042".into() },
            )
            .unwrap();
        // C′ 之后「块沿来路发」这条不变量由**描述符绑的那条腿**承载(§10):引擎不再产
        // 块,故也不再有一串 `Require(Relay)` 的 Send 可看。
        assert!(
            matches!(&served[..], [Output::ServeBlob(s)] if s.route == Route::Relay),
            "供流描述符必须绑来路那条腿:{served:?}"
        );
    }

    #[test]
    fn chunks_from_another_leg_are_dropped() {
        // §5.1 收端闸:同一 transfer 的块永不跨路——供块方若改道发来,持有者丢弃,
        // 不变量不指望发送端自律。
        let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
        eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
        let outs = eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
        let (_, transfer) = pull_of(&outs).expect("LAN 腿拉流");
        let chunk = Msg::BlobChunk {
            image_id: img.clone(),
            transfer: transfer.clone(),
            idx: 0,
            last: true,
            data: vec![3u8; 12],
        };
        // 经中转送来同一 transfer 的块:丢(不建行、拉流不动)。
        eng.on_relay_msg(&mut conn, &mut clock, &a_id, chunk.clone()).unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "换腿来的块不落地");
        assert!(eng.pulling.contains_key(&img), "拉流不受伤");
        // 沿本腿送来:照常建行。
        eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, chunk).unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "沿本腿的块照常建行");
    }

    #[test]
    fn relay_session_up_resets_only_the_relay_dimension() {
        // 二轮 H1:中转重连**不许**误伤 lan 维度——lan 在飞拉流、lan 惩罚、lan shun 全留;
        // relay 维度则整体重置(在飞作废、惩罚与 shun 清零)。
        let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
        const OTHER: &str = "OTHERPEERROUTE000000000001";
        // lan 腿上起一笔拉流,另给 relay 腿人为记一笔惩罚 + shun。
        eng.on_lan_link_up(&conn, &a_id, 3).unwrap();
        eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
        assert_eq!(eng.pulling[&img].route, Route::Lan);
        eng.penalize_blob(&a_id, Route::Relay);
        eng.penalize_blob(OTHER, Route::Lan);
        eng.blob_shunned
            .entry(img.clone())
            .or_default()
            .extend([(a_id.clone(), Route::Relay), (OTHER.to_string(), Route::Lan)]);
        eng.relay_up(&conn).unwrap();
        assert_eq!(eng.pulling[&img].route, Route::Lan, "lan 在飞拉流不受中转重连影响");
        assert!(!eng.blob_penalized(&a_id, Route::Relay), "relay 惩罚清零");
        assert!(eng.blob_penalized(OTHER, Route::Lan), "lan 惩罚照留");
        let shunned = eng.blob_shunned.get(&img).expect("lan 的 shun 条目还在");
        assert!(!shunned.contains(&(a_id.clone(), Route::Relay)), "relay 的 shun 清零");
        assert!(shunned.contains(&(OTHER.to_string(), Route::Lan)), "lan 的 shun 照留");
        assert_eq!(eng.route_up_generation(&a_id, Route::Lan), Some(3), "lan 连接态与代次不动");
    }

    #[test]
    fn relay_down_and_lan_link_down_stay_in_their_own_lane() {
        // §5.1/§6:会话级 relay 断只丢 relay 连接态、惩罚照留;对端级 down 只动那一台;
        // lan link_down 只作废**该代次**——glare 换链后迟到的旧代断链通报打不掉新链。
        let (conn, _clock, mut eng, _img, a_id) = peer_missing_one_image();
        eng.on_relay_peer_up(&a_id);
        eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
        eng.penalize_blob(&a_id, Route::Relay);
        eng.on_relay_session_down();
        assert_eq!(eng.route_up_generation(&a_id, Route::Relay), None, "relay 腿断");
        assert!(eng.blob_penalized(&a_id, Route::Relay), "惩罚独立于 socket 代次,不清");
        assert_eq!(eng.route_up_generation(&a_id, Route::Lan), Some(1), "lan 腿不受牵连");
        // glare:新链(代次 2)顶上,旧代 1 的断链通报迟到 → 新链必须活着。
        eng.on_lan_link_up(&conn, &a_id, 2).unwrap();
        eng.on_lan_link_down(&a_id, 1);
        assert_eq!(eng.route_up_generation(&a_id, Route::Lan), Some(2), "旧代断链不许打掉新链");
        // lan 腿的惩罚同样独立于 socket 代次:断链、重建都不清。
        eng.penalize_blob(&a_id, Route::Lan);
        eng.on_lan_link_down(&a_id, 2);
        assert_eq!(eng.route_up_generation(&a_id, Route::Lan), None, "本代断链才置 Absent");
        assert!(eng.blob_penalized(&a_id, Route::Lan), "断链不清 lan 惩罚");
        eng.on_lan_link_up(&conn, &a_id, 3).unwrap();
        assert!(eng.blob_penalized(&a_id, Route::Lan), "重建链路也不清 lan 惩罚");
    }

    #[test]
    fn hello_routes_are_pinned_by_their_purpose() {
        // §2/§6:带 lan 通告的**权威** Hello 只许走鉴权路(`Require(Relay)`,否则被 §2
        // 的缓存规则整枚忽略);传输层触发的定向 Hello 按用途钉腿(公钥收敛走中转、
        // 断网期水位互换走 lan),绝不因「中转在线」而改道。
        let (conn, _clock, mut eng, _img, a_id) = peer_missing_one_image();
        let outs = eng.relay_up(&conn).unwrap();
        let Output::Send { to, route_hint, .. } = outs
            .iter()
            .find(|o| matches!(o, Output::Send { msg: Msg::Hello { .. }, .. }))
            .expect("会话仪式必发 hello")
        else {
            unreachable!()
        };
        assert_eq!(to, BROADCAST);
        assert_eq!(*route_hint, RouteHint::Require(Route::Relay), "权威 Hello 钉中转");
        for route in [Route::Relay, Route::Lan] {
            let made = eng.make_hello(&conn, &a_id, route).unwrap();
            assert_eq!(made.len(), 1, "水位游标没满额时不该带 advisory:{made:?}");
            let Output::Send { to, lane, route_hint, msg } = made.into_iter().next().unwrap()
            else {
                unreachable!()
            };
            assert_eq!(to, a_id);
            assert_eq!(lane, Lane::Mail);
            assert_eq!(route_hint, RouteHint::Require(route), "定向 Hello 钉调用方点的腿");
            assert!(matches!(msg, Msg::Hello { lan: None, .. }), "引擎产出的 Hello 恒不带通告");
        }
    }

    #[test]
    fn runtime_started_twice_is_a_loud_error() {
        // 实现审 L2:重复派生会把在飞的图塞回缺字节清单,破掉「清单与在飞互斥」——
        // 不静默容忍(那会让下一枚 have 顶掉正在走的 transfer),响亮报错。
        let (conn, _clock, mut eng, _img, _a_id) = peer_missing_one_image();
        let err = eng.on_runtime_started(&conn).expect_err("第二次装配初始化必须报错");
        assert!(err.contains("只许一次"), "{err}");
    }

    #[test]
    fn lan_link_down_only_invalidates_its_own_generation_transfers() {
        // §5.1:link_down 只作废该代次上的在飞 transfer。
        let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
        eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
        eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
        assert_eq!(eng.pulling[&img].generation, 1);
        eng.on_lan_link_down(&a_id, 99); // 别代的断链通报:不动这笔
        assert!(eng.pulling.contains_key(&img), "别代断链不作废本代 transfer");
        eng.on_lan_link_down(&a_id, 1);
        assert!(
            !eng.pulling.contains_key(&img) && eng.missing_blobs.contains(&img),
            "本代断链 = 整笔作废回清单"
        );
    }

    #[test]
    fn stale_lan_pull_penalizes_that_leg_then_falls_back_to_relay() {
        // §5.1 完整一圈:LAN 半死链路(Ping 活着、块黑洞)→ stale 作废 + 罚 LAN 腿 +
        // shun (图, 对端, LAN) → 重发 want → 下一枚 have 按表改走中转(不是原地重试);
        // 惩罚只挡 blob,mail/Hello 照走;到期后 shun 与惩罚一并清,不永久。
        let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
        eng.on_relay_peer_up(&a_id);
        eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
        eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
        assert_eq!(eng.pulling[&img].route, Route::Lan);
        let mut wants = vec![];
        for _ in 0..PULL_STALE_TICKS {
            wants = eng.on_tick();
        }
        assert!(
            wants.iter().any(|o| matches!(o, Output::Send { msg: Msg::BlobWant { image_id }, .. } if image_id == &img)),
            "作废时当场重发 want:{wants:?}"
        );
        assert!(eng.blob_penalized(&a_id, Route::Lan), "罚的是那条腿");
        assert!(!eng.blob_penalized(&a_id, Route::Relay), "另一条腿无辜");
        // 惩罚不挡 mail:LAN 到达的 hello 照答(penalty 只挡 blob 选路)。
        let outs = eng
            .on_msg_v(
                &mut conn,
                &mut clock,
                &a_id,
                Route::Lan,
                Msg::Hello { watermarks: BTreeMap::new(), lan: None },
            )
            .unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::BlobWant { .. }, .. })),
            "惩罚只挡 blob 选路,hello 应答照走"
        );
        // 下一枚 have:LAN 被罚 → 改走中转(新 transfer)。
        let outs = eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
        let (hint, _) = pull_of(&outs).expect("换腿重拉");
        assert_eq!(hint, RouteHint::Require(Route::Relay), "重选其它健康腿 = 改走中转");
        assert_eq!(eng.pulling[&img].route, Route::Relay);
        // 惩罚到期:清惩罚 + 清该腿的 per-image shun(不永久 shun)。这段 tick 里中转腿
        // 也会因黑洞被罚一次(没人喂块),故只断言 LAN 腿这一条——「表里终究不留惩罚」
        // 由 property test 的第 ④ 条兜。
        for _ in 0..BLOB_PENALTY_TICKS {
            eng.on_tick();
        }
        assert!(!eng.blob_penalized(&a_id, Route::Lan), "惩罚到期");
        assert!(
            eng.blob_shunned.get(&img).is_none_or(|s| !s.contains(&(a_id.clone(), Route::Lan))),
            "到期一并清该腿的 shun:{:?}",
            eng.blob_shunned
        );
    }

    #[test]
    fn relay_peer_up_needs_the_current_session() {
        // 三轮 M1 + 实现审 M2:(X,Relay)=Up 须「会话在 ∧ X 在线」两层同时成立——
        // ① 无会话时 peer_up 是 no-op(fail-closed,不许造出指向不存在中转的路由);
        // ② 新会话把旧会话的在线事实整体清空,故接线顺序恒是「会话建立 → 在线快照」。
        let (conn, _clock, mut eng, _img, a_id) = peer_missing_one_image();
        eng.on_relay_session_down();
        eng.on_relay_peer_up(&a_id);
        assert_eq!(eng.route_up_generation(&a_id, Route::Relay), None, "无会话不许置 Up");
        eng.relay_up(&conn).unwrap();
        eng.on_relay_peer_up(&a_id);
        assert!(eng.route_up_generation(&a_id, Route::Relay).is_some(), "会话内置位有效");
        // 重连:新会话清掉旧会话的在线事实,得重新等在线快照。
        eng.relay_up(&conn).unwrap();
        assert_eq!(eng.route_up_generation(&a_id, Route::Relay), None, "旧会话的在线事实作废");
    }

    #[test]
    fn relay_session_up_resets_the_unacked_outbound_cursor() {
        // 实现审 H1:游标复位是**会话仪式的一部分**——已发未 ack 的本机 op 必须在重连后
        // 重推(引擎跨会话存活后,这是唯一的重推触发器);重复由对端 op_id 幂等吸收。
        //
        // 第5笔改的是**这件事怎么做**:`outbound` 不再当场物化帧,而是把
        // 「`[last_pushed+1, …)` 还欠着」登记进 BROADCAST work;会话仪式**保守合并**
        // `[acked+1, current_max]`(§6.2 ⑦ 一轮 H4:不是复位工作游标 —— 此刻可能仍有
        // LAN ticket 在飞)。故判据从「回了几枚帧」改成「**抽得出几枚帧**」:抽的是真
        // 取数路,登记没做对就一枚也抽不出来。
        let (mut conn, mut clock, mut eng) = fresh();
        eng.relay_up(&conn).unwrap();
        notes::capture(&mut conn, &mut clock, "还没被服务器接手的一笔").unwrap();
        let mut outs = vec![];
        eng.outbound(&conn, &mut outs).unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::ServeOps(s) if s.to == OpsServeTo::Broadcast)),
            "本机新 op 让 BROADCAST 从没活变有活,必须产一枚描述符:{outs:?}"
        );
        let first = eng.drain_ops_for_test(&conn).unwrap();
        assert_eq!(first.len(), 1, "抽得出那一帧:{first:?}");
        let mut again = vec![];
        eng.outbound(&conn, &mut again).unwrap();
        assert!(again.is_empty(), "登记位已推进,不重复登记");
        assert!(eng.drain_ops_for_test(&conn).unwrap().is_empty(), "也没有第二枚帧可抽");
        // 断线重连,服务器一个 ack 也没落(acked = 0)→ 同一帧必须重推。
        eng.on_relay_session_down();
        let outs = eng.on_relay_session_up(&conn, 0).unwrap();
        assert!(
            outs.iter().any(|o| matches!(o, Output::Send { msg: Msg::Hello { .. }, .. })),
            "会话仪式照发 hello"
        );
        let redo = eng.drain_ops_for_test(&conn).unwrap();
        assert_eq!(redo.len(), 1, "未 ack 的 op 重连后由保守合并加回、重新抽得出:{redo:?}");
    }

    #[test]
    fn invalidated_pulls_ask_again_at_once() {
        // 实现审 H2:路由失效 / 换代 / deny 让图退回缺字节清单后**没有任何定时器看着它**
        // (on_tick 只管在飞拉流),故每个「回清单」出口都必须当场再问一轮——否则另一条
        // 腿明明健康,也要等下一次偶然的 hello 才换腿。
        let (mut conn, mut clock, mut eng, img, a_id) = peer_missing_one_image();
        // 重问的形状也钉死:广播 + mail lane + Auto——发成 direct 或钉在刚失效的腿上,
        // 等于没问(§5.1/§6)。
        let asks = |outs: &[Output]| {
            outs.iter().any(|o| matches!(o, Output::Send { to, lane, route_hint, msg: Msg::BlobWant { image_id } }
                if to == BROADCAST && *lane == Lane::Mail && *route_hint == RouteHint::Auto && image_id == &img))
        };
        // ① 中转腿在飞 → 会话断:回清单 + 当场重问。
        eng.on_relay_peer_up(&a_id);
        eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
        assert_eq!(eng.pulling[&img].route, Route::Relay);
        let outs = eng.on_relay_session_down();
        assert!(asks(&outs), "会话断:作废的图当场重问:{outs:?}");
        // ② 会话重连也算「回清单」的一种:在飞的 relay 拉流作废,且本次仪式的 want 里
        //    必须含它(否则重连反而把在拉的图丢没了)。
        eng.relay_up(&conn).unwrap();
        eng.on_relay_peer_up(&a_id);
        eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
        assert!(eng.pulling.contains_key(&img));
        let outs = eng.relay_up(&conn).unwrap();
        assert!(!eng.pulling.contains_key(&img), "重连作废旧会话的在飞拉流");
        assert!(asks(&outs), "会话仪式的 want 里必须含刚作废的图:{outs:?}");
        // ③ 对端级 down 同理。
        eng.on_relay_peer_up(&a_id);
        eng.on_relay_msg(&mut conn, &mut clock, &a_id, have(&img)).unwrap();
        let outs = eng.on_relay_peer_down(&a_id);
        assert!(asks(&outs), "对端离线:作废的图当场重问:{outs:?}");
        // ④ lan 链路断 + glare 换代同理。
        eng.on_lan_link_up(&conn, &a_id, 1).unwrap();
        eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
        let outs = eng.on_lan_link_down(&a_id, 1);
        assert!(asks(&outs), "链路断:作废的图当场重问:{outs:?}");
        eng.on_lan_link_up(&conn, &a_id, 2).unwrap();
        eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
        let outs = eng.on_lan_link_up(&conn, &a_id, 3).unwrap();
        assert!(asks(&outs), "glare 换代:旧代作废的图当场重问:{outs:?}");
        // ⑤ deny(拒者已无行,这一问不与谁成环)。换代已作废上一笔,先重建一笔。
        eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
        let transfer = eng.pulling[&img].transfer.clone();
        let outs = eng
            .on_msg_v(
                &mut conn,
                &mut clock,
                &a_id,
                Route::Lan,
                Msg::BlobDeny { image_id: img.clone(), transfer: transfer.clone() },
            )
            .unwrap();
        assert!(asks(&outs), "deny:回清单当场另寻来源:{outs:?}");
        // 换腿来的 deny 不作数(来路复核):先重建一笔拉流,再从中转腿送同一枚 deny。
        eng.on_msg_v(&mut conn, &mut clock, &a_id, Route::Lan, have(&img)).unwrap();
        let transfer = eng.pulling[&img].transfer.clone();
        let outs = eng
            .on_relay_msg(
                &mut conn,
                &mut clock,
                &a_id,
                Msg::BlobDeny { image_id: img.clone(), transfer },
            )
            .unwrap();
        assert!(outs.is_empty() && eng.pulling.contains_key(&img), "换腿的 deny 不动拉流");
    }

    /// 路由状态表 property test(§11 的表驱动一项;**是 24 种子 × 120 步随机事件流,
    /// 不是全排列**——全排列的口径归 L-c3 的集成测):随机事件流 × 三台对端,每步
    /// 复核四条不变量——① 在飞 transfer 的腿必是「当前 Up 且代次相符」;② 发出的
    /// `Require(r)` 必落在当时 Up 的腿上;③ 一张图同时最多一笔 transfer(清单与在飞
    /// 互斥、并集恒含该图);④ 惩罚与 shun 必然到期(静默足够多心跳后表里不留惩罚、
    /// shun 清空)——不震荡、不永久 shun。
    #[test]
    fn route_state_table_property_holds_under_random_event_streams() {
        const PEERS: [&str; 3] = [
            "ROUTEPROPDEV00000000000001",
            "ROUTEPROPDEV00000000000002",
            "ROUTEPROPDEV00000000000003",
        ];
        for seed in 1u64..=24 {
            let (mut conn, mut clock, mut eng, img, _a_id) = peer_missing_one_image();
            let mut rng = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
            let mut next = || {
                rng ^= rng >> 12;
                rng ^= rng << 25;
                rng ^= rng >> 27;
                rng = rng.wrapping_mul(0x2545_F491_4F6C_DD1D);
                rng
            };
            let mut lan_gen = 0u64;
            for step in 0..120 {
                let peer = PEERS[(next() % 3) as usize];
                let outs = match next() % 9 {
                    0 => eng.relay_up(&conn).unwrap(),
                    1 => eng.on_relay_session_down(),
                    2 => eng.on_relay_peer_up(peer),
                    3 => eng.on_relay_peer_down(peer),
                    4 => {
                        lan_gen += 1;
                        eng.on_lan_link_up(&conn, peer, lan_gen).unwrap()
                    }
                    5 => {
                        // 一半用当前代次、一半用陈旧代次(迟到通报)。
                        let g = if next() % 2 == 0 { lan_gen } else { lan_gen.saturating_sub(1) };
                        eng.on_lan_link_down(peer, g)
                    }
                    6 => eng.on_tick(),
                    7 => {
                        let route = if next() % 2 == 0 { Route::Lan } else { Route::Relay };
                        eng.on_msg_v(&mut conn, &mut clock, peer, route, have(&img)).unwrap()
                    }
                    _ => {
                        // 半块:让 transfer 有进展但不完成(stale 计时清零)。
                        let (transfer, route) = match eng.pulling.get(&img) {
                            Some(p) => (p.transfer.clone(), p.route),
                            None => continue,
                        };
                        eng.on_msg_v(
                            &mut conn,
                            &mut clock,
                            peer,
                            route,
                            Msg::BlobChunk {
                                image_id: img.clone(),
                                transfer,
                                idx: 0,
                                last: false,
                                data: vec![1u8],
                            },
                        )
                        .unwrap()
                    }
                };
                let where_ = format!("种子 {seed} 第 {step} 步");
                // ① 在飞 transfer 的腿必须还活着且代次相符。
                for (image_id, pull) in &eng.pulling {
                    assert_eq!(
                        eng.route_up_generation(&pull.from, pull.route),
                        Some(pull.generation),
                        "{where_}:{image_id} 的 transfer 挂在已死/换代的腿上"
                    );
                }
                // ② 钉了 `Require(Lan)` 就必须真有那条链路(帧无处可投 = 白丢)。
                //    `Require(Relay)` **刻意不查 Up**:mail 走中转不要求对端在线(进信箱
                //    就是投达),direct 的对端离线由服务器 Nack 收口——那不是不变量。
                //    但**拉流的 BlobPull** 是选路算出来的,它的腿必须当场 Up。
                for o in &outs {
                    let Output::Send { to, route_hint: RouteHint::Require(r), msg, .. } = o else {
                        continue;
                    };
                    if *r == Route::Lan || matches!(msg, Msg::BlobPull { .. }) {
                        assert!(
                            eng.route_up_generation(to, *r).is_some(),
                            "{where_}:钉了 Require({r:?}) 却没有那条腿({msg:?})"
                        );
                    }
                }
                // ③ 一张图同时最多一笔 transfer,且它恒在「清单 ∪ 在飞」里(不丢图)。
                assert!(
                    eng.missing_blobs.contains(&img) ^ eng.pulling.contains_key(&img),
                    "{where_}:图既不在清单也不在拉流(或两处都在)"
                );
            }
            // ④ 静默到底:惩罚与 shun 必然到期(不永久),且表不留垃圾条目
            //    (Absent 且无惩罚的条目必须被删,否则表随事件流单调涨)。
            for _ in 0..(BLOB_PENALTY_TICKS + PULL_STALE_TICKS as u64 + 2) {
                eng.on_tick();
            }
            assert!(
                eng.routes.values().all(|st| st.blob_penalty_until.is_none()),
                "种子 {seed}:惩罚必然到期"
            );
            assert!(eng.blob_shunned.is_empty(), "种子 {seed}:shun 不许永久");
            assert!(
                eng.routes.values().all(|st| st.connectivity != Connectivity::Absent),
                "种子 {seed}:路由表不许留「Absent 且无惩罚」的垃圾条目:{:?}",
                eng.routes
            );
        }
    }
}
