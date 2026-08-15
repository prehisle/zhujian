//! 信封层协议(sync-protocol §3)——**服务器唯一可读面**,字段最小化:from/to/lane/
//! 序号与不透明 `blob`(域子钥下的密文,服务器不可解析;HLC、水位、op 类型、图字节
//! 全在密文内层,见 src-tauri `sync/engine.rs::Msg` 与 `sync/crypto.rs`)。
//!
//! 本 crate 是 `server/`(zhujian-syncd)与 src-tauri 客户端(P2-g 接线)的共用底座:
//! 信封类型、规格常量、签名 payload 构造。**线上格式纪律与内层一致**(P2-d 定):
//! CBOR、serde 默认表示(externally tagged——变体名作单键 map,unit 变体编成纯字符串),
//! 变体名/字段名即协议,黄金向量测试焊死;改名 = 协议破坏。信封层没有独立版本字段
//! ——服务器与客户端由同一运营者部署、随仓库一起演进,信封变体的增删=双端同轮升级
//! (密文内层的版本纪律见 `crypto::PROTO_VER`,与信封无关)。
//!
//! 签名 payload 是 **`前缀 ‖ 字段` 直接拼接**(§4 字面)。拼接无歧义的前提是全部
//! 变长字段定长化:nonce 恒 32B、account/device 恒 26 字符 ULID、pubkey 恒 32B——
//! 服务器在验签前用 [`is_ulid`] 与长度检查把形态钉死(不合 = 拒,不进验签),
//! 客户端侧由 ULID/密钥生成器天然保证。

use serde::{Deserialize, Serialize};

// ---- 规格常量(sync-protocol §3/§4) ----

/// 帧大小上限(§3:服务器拒超;WS 消息层强制)。
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// 客户端心跳节奏(§3)。
pub const HEARTBEAT_SECS: u64 = 30;
/// 静默判死(§3:服务器读超时)。
pub const SILENCE_TIMEOUT_SECS: u64 = 90;
/// 信箱字节上限(§4:64 MiB,与帧数上限先到为准)。
pub const MAILBOX_MAX_BYTES: usize = 64 * 1024 * 1024;
/// 信箱帧数上限(§4:8192)。
pub const MAILBOX_MAX_FRAMES: usize = 8192;
/// 信箱 TTL(§4:72h,惰性驱逐+定期清扫)。
pub const MAILBOX_TTL_SECS: u64 = 72 * 3600;
/// 配对槽 TTL(§4:10 分钟,单次使用)。
pub const PAIR_SLOT_TTL_SECS: u64 = 600;
/// 纪元席位租约 TTL(billing-plan §5:未消费 ≈2 小时即失效;正常流程在同一条
/// 短连接内「求租→注册」秒级消费,长 TTL 只是仪式重试的余量)。
pub const SEAT_LEASE_TTL_SECS: u64 = 2 * 3600;
/// 广播收件人约定值(§3;与 src-tauri `engine::BROADCAST` 同值)。
pub const BROADCAST: &str = "*";
/// 权威名册的条数硬上界(identity-plan §5.13)。
///
/// **为什么需要一个常量**:`device_cap` 只在**注册那一刻**判,`load` 不校验存量账户
/// 的设备数,而硬帽是可配置的、历史上调高再调低就会留下超编账户 —— 于是「一份名册
/// 有多大」由数据说了算,这一格没有上界(设计审一轮 H6)。
///
/// **32 的依据**:覆盖今天 8 席 + 未来 16 席档 + 纪元切换临时的第 17 席,留一倍余量。
/// 最大 roster ≈ 1.4 KiB;32 条连接全 fan-out ≈ 45 KiB wire(见 `golden_max_roster_frame`)。
/// 服务端**三处同源引用它**:`device_cap` 启动校验 / `load` 存量校验 / `build_roster`;
/// 要超过 32 得连同设备硬帽与那张资源表一起改。
pub const MAX_ROSTER_DEVICES: usize = 32;

/// [`ClientMsg::RosterReq`] 两次**应答**之间的最短间隔(identity-plan §5.13)。
///
/// **住在协议层是因为两端都要读它**:服务端拿它限频(超频回
/// [`ServerMsg::RosterNack`]`{busy}`),客户端拿它校验自己那台调度机的常量约束
/// —— §5.4 五轮 M1 算错过一次,真正要挡的是「**换新那一刻旧请求的年龄**」,
/// 于是 `PULL_DEADLINE >= REFRESH_DEADLINE + ROSTER_REQ_MIN_GAP`。抄成两份必漂。
pub const ROSTER_REQ_MIN_GAP_SECS: u64 = 5;

/// challenge nonce 长度(§4:32B 随机)。
pub const CHALLENGE_LEN: usize = 32;
/// Ed25519 公钥长度。
pub const ED25519_PUB_LEN: usize = 32;
/// Ed25519 签名长度。
pub const ED25519_SIG_LEN: usize = 64;

/// 签名域隔离前缀(§4:签名恒带前缀防跨用途复用)。
pub const SIG_AUTH_V1: &str = "zhujian-sync-auth-v1";
/// 首台注册签名前缀(§4;payload 含本连接 challenge,自证私钥持有且防离线重放)。
pub const SIG_REGISTER_FIRST_V1: &str = "zhujian-sync-register-first-v1";
/// 后续注册签名前缀(§4;老设备背书,已鉴权通道内,重放=幂等重注册同一 (device,pub),无害)。
pub const SIG_REGISTER_DEVICE_V1: &str = "zhujian-sync-register-device-v1";
/// 纪元席位租约签名前缀(billing-plan §5:已鉴权 sponsor 发起并签名,绑定具体
/// 新 device/pubkey 不可换目标;重放=同目标幂等重求租,无害——与 register_device
/// 同一「已鉴权通道内无 nonce」论证)。
pub const SIG_SEAT_LEASE_V1: &str = "zhujian-sync-seat-lease-v1";
/// 设备管理签名前缀(identity-plan §5.5)。**绑 nonce**——与 register_device /
/// seat_lease 不同:那两条的重放是**幂等无害**的(重复注册同一个目标),移除不是
/// (一枚签名在别的连接上重放可能命中一台同 id 被重新注册的设备)。nonce 本来就是
/// `dispatch` 的入参,代价为零的封闭窗口就该封。payload 见 [`device_admin_sig_payload`]。
pub const SIG_DEVICE_ADMIN_V1: &str = "zhujian-sync-device-admin-v1";

/// `Err.code` 的机器可判值(msg 是人读中文,细节进服务器日志)。
pub mod err_code {
    /// 鉴权失败(封禁/未注册/坏签名——对外不细分,不给探测面)。
    pub const AUTH_FAILED: &str = "auth_failed";
    /// register_first 时账户已有设备:走配对加入,别抢首台(§4 并发败者也落这)。
    pub const NOT_FIRST: &str = "not_first";
    /// device_id 已在 registry 且不属于这次注册(§4 全局唯一守护:整库拷贝复用身份)。
    pub const DEVICE_ID_TAKEN: &str = "device_id_taken";
    /// direct 指名收件人不在线(§3)。
    pub const NOT_ONLINE: &str = "not_online";
    /// send 指名了本账户 registry 之外的收件人。
    pub const UNKNOWN_DEVICE: &str = "unknown_device";
    /// 配对槽不存在/已用/已过期(§4:单次使用,烧了就没有)。
    pub const BAD_SLOT: &str = "bad_slot";
    /// 账户设备数已触**服务器安全硬帽**(epoch-plan §5.2 / billing-plan §5 两层判据
    /// 的容量层;任何 entitlement 也不能越过,席位租约同拒)。
    pub const ACCOUNT_FULL: &str = "account_full";
    /// 账户**套餐席位**已满(billing-plan §5 两层判据的商业层:先移除一台设备再
    /// 添加;与 account_full 区分——这层靠提额可解,那层不行)。
    pub const SEAT_LIMIT: &str = "seat_limit";
    /// 服务器资源面已到上限(全局配对槽数等),稍后再试。
    pub const BUSY: &str = "busy";
    /// 形态或状态不合法(非 ULID、长度错、未鉴权越权、鉴权后重复鉴权等)。
    pub const BAD_REQUEST: &str = "bad_request";
    /// 服务器内部错误(registry 落盘失败等;内存态已回滚,重试或找运营者)。
    pub const INTERNAL: &str = "internal";
    /// 账户受限(billing-plan §6,工序 4)。**旧客户端可见性**:无 caps 旧客户端
    /// 进入受限时收此**非致命** Err(现有状态面至少一条可见错误);声明
    /// [`crate::CAP_ACCOUNT_STATUS_V1`] 的新客户端改收 [`crate::ServerMsg::AccountStatusV1`]。
    pub const ACCOUNT_THROTTLED: &str = "account_throttled";

    // ---- 无编号 `Err` 的归属白名单(identity-plan §5.5,设计审三轮 H1) ----
    //
    // 由来:`Err` 没有请求号,而仓里存在**第三方主动异步** `Err`——[`ACCOUNT_THROTTLED`]
    // (fastlane 首次越额的 ENTER 推送 / admin 状态变更,推给未声明 account_status_v1 的
    // 连接)。客户端若按「有 flow 在飞就归它」结账,那枚推送会把正在等结果的
    // `DeviceAdmin` / `Pair` flow **提前错误结掉**,真正的回执随后到达时 flow 已被清掉。
    // 故归属改成白名单:只有下面列出的 code 能结对应的 flow,其余一切 `Err` 只进状态面。
    //
    // ⛔ **这两张表是客户端对无编号 `Err` 的归属判据,不是服务端选择错误码的菜单**;
    // 服务端仍须按具体失败语义映射 code,别照着白名单挑一个回(七轮)。
    //
    // ⚠ **维护契约(不是「免疫」)**:将来新增的主动推送 `Err` 必须用一个**不在**任何
    // 表里的 code。若有人给主动推送复用了 `BUSY` / `BAD_REQUEST`,照样会被误认——
    // 五轮 L1 打掉了我原来那句「白名单对将来任何新增的主动推送都免疫」。
    //
    // ⚠ **名册刷新 flow 刻意没有白名单**:它的失败面是**有编号**的
    // [`crate::ServerMsg::RosterNack`],故一枚无编号 `Err` 永远不该结它。

    /// 配对 flow(`PairOpen` → `PairMsg` → 末端 `RegisterDevice` 三段的实际错误码并集;
    /// `PairJoin` 走 joiner 专用短连接,不在 live flow 面内)。
    pub const PAIR_FLOW_ERRORS: &[&str] = &[
        BAD_SLOT,
        BUSY,
        SEAT_LIMIT,
        ACCOUNT_FULL,
        DEVICE_ID_TAKEN,
        BAD_REQUEST,
        AUTH_FAILED,
        INTERNAL,
    ];

    /// 设备管理 flow([`crate::ClientMsg::DeviceAdmin`])。`BUSY` 在表里是因为**限频**
    /// 会产生它(四轮 M1:加一道闸的同轮要回头看「它产生的新错误码有没有人认」)。
    pub const DEVICE_ADMIN_FLOW_ERRORS: &[&str] =
        &[BAD_REQUEST, UNKNOWN_DEVICE, INTERNAL, AUTH_FAILED, BUSY];
}

/// 能力名:客户端声明「我懂 [`ServerMsg::AccountStatusV1`],请下发」(billing-plan
/// §6,工序 4)。挂在 [`ClientMsg::Auth`]/[`ClientMsg::RegisterFirst`] 的 `caps`。
pub const CAP_ACCOUNT_STATUS_V1: &str = "account_status_v1";

/// 能力名:客户端声明「我懂权威名册这一套」(identity-plan §5.4/§5.5)——
/// [`ServerMsg::Roster`] / [`ServerMsg::DeviceAdminOk`] / [`ServerMsg::RosterNack`]
/// **三条都只发给声明了它的连接**。挂在 [`ClientMsg::Auth`]/[`ClientMsg::RegisterFirst`]
/// 的 `caps`。
///
/// ⛔ **能力探测不许用新的 `ClientMsg`**:老服务器收到不认识的信封会 `bad_request`
/// **并断开**——那等于「点开设备面板就把同步会话打断一次」。故**唯一的能力信号是
/// attach 那一枚推送**:本会话收到过 [`ServerMsg::Roster`] ⇒ 服务器认得这套,之后发
/// [`ClientMsg::RosterReq`] / [`ClientMsg::DeviceAdmin`] 才是安全的;没收到 ⇒ 一个新
/// 信封都不发(§5.10-2,这道闸要落在 core 不只 UI)。
pub const CAP_DEVICE_ROSTER_V1: &str = "device_roster_v1";

/// caps 入口卫生 + 成员判定(§6:≤16 项、每项 ≤32 字节、仅 ASCII、未知忽略、
/// 重复无所谓)。只回答「是否声明了某能力」:扫描上界 16 项挡异常长列表,
/// 超 32 字节 / 非 ASCII 的项跳过——**不因垃圾项拒绝整个 Auth**(那会把鉴权连坐)。
pub fn has_capability(caps: &[String], name: &str) -> bool {
    caps.iter()
        .take(16)
        .filter(|c| c.len() <= 32 && c.is_ascii())
        .any(|c| c.as_str() == name)
}

// ---- 信封类型(§3) ----

/// 客户端 → 服务器。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ClientMsg {
    /// 首台设备注册(§4 TOFU:账户未封禁 **且** 从未初始化——open-signup 起准入开放,账户 ULID 客户端自生成;
    /// 「检查零设备 + 插入首台」账户级原子,并发双首台恰一胜)。
    /// sig 用 **消息自带的 pubkey** 验(自证新私钥持有),payload 见
    /// [`register_first_sig_payload`]。成功即视同 authed。
    RegisterFirst {
        account: String,
        device: String,
        #[serde(with = "serde_bytes")]
        pubkey: Vec<u8>,
        #[serde(with = "serde_bytes")]
        sig: Vec<u8>,
        /// 能力协商(billing-plan §6,工序 4):客户端声明它懂哪些可选服务器消息。
        /// **缺省(空)不序列化**——旧客户端/旧线上字节逐字节不变(黄金向量钉死),
        /// 且旧服务端按 CBOR 命名 map 忽略未知键(前向兼容,有测)。服务端按
        /// [`has_capability`] 卫生化判定;目前唯一能力 [`CAP_ACCOUNT_STATUS_V1`]。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        caps: Vec<String>,
    },
    /// 挑战应答鉴权(§4):对连接 challenge 的签名,payload 见 [`auth_sig_payload`]。
    Auth {
        account: String,
        device: String,
        #[serde(with = "serde_bytes")]
        sig: Vec<u8>,
        /// 能力协商(§6,工序 4);语义同 [`ClientMsg::RegisterFirst::caps`]。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        caps: Vec<String>,
    },
    /// 发密文帧(§3):n=连接内单调序号(ack 回显);to=device_id 或 [`BROADCAST`];
    /// blob=域子钥下的密文,服务器只路由不解析。
    Send {
        n: u64,
        to: String,
        lane: Lane,
        #[serde(with = "serde_bytes")]
        blob: Vec<u8>,
    },
    /// 老设备为新设备背书注册(§4;配对流程内发起,§6)。发起连接必须已鉴权,
    /// sig_by_old 用 **发起设备的已注册公钥** 验,payload 见 [`register_device_sig_payload`]。
    RegisterDevice {
        account: String,
        new_device: String,
        #[serde(with = "serde_bytes")]
        new_pubkey: Vec<u8>,
        #[serde(with = "serde_bytes")]
        sig_by_old: Vec<u8>,
    },
    /// 纪元席位租约(billing-plan §5:纪元切换「先预注册新身份、后吊旧身份」在
    /// 满席时刻需要 +1;已鉴权 sponsor 发起,允许**一次** quota +1 但绝不越硬帽)。
    /// 绑定具体 new_device/new_pubkey 不可换目标;每账户同时最多一枚(新求租烧旧
    /// 开新);register_device 精确匹配后原子消费。sig_by_old 用 **发起设备的已注册
    /// 公钥** 验,payload 见 [`seat_lease_sig_payload`]。
    SeatLease {
        account: String,
        new_device: String,
        #[serde(with = "serde_bytes")]
        new_pubkey: Vec<u8>,
        #[serde(with = "serde_bytes")]
        sig_by_old: Vec<u8>,
    },
    /// 设备管理(identity-plan §5.5;须已鉴权)。三个动作合一条——共用同一套鉴权、
    /// 同一把锁、同一个签名域。授权判据只有一条正式子(§5.3),**全仓只留那一份**:
    ///
    /// ```text
    /// authorized = caller_is_admin OR (action == Remove AND target == caller)
    /// ```
    ///
    /// `sig` 用**本连接验签那把公钥**对应的私钥签,payload 见 [`device_admin_sig_payload`]
    /// (绑 nonce)。形态闸先于验签:`is_ulid(account) && is_ulid(target) &&
    /// sig.len() == 64` 不过就 `bad_request`,不进验签。
    DeviceAdmin {
        account: String,
        /// 26 位规范 ULID(动作的目标设备;`target == caller` 即自助退出)。
        target: String,
        action: DeviceAction,
        #[serde(with = "serde_bytes")]
        sig: Vec<u8>,
    },
    /// 拉一枚当前名册(identity-plan §5.4:**推送可丢,正确性靠这条**——服务端的
    /// `push()` 就是 `try_send().is_ok()`,通道满时那枚帧静默消失)。
    ///
    /// **不签名**:连接已鉴权,且它没有任何特权效果——名册只含**自己账户**的
    /// device_id,那是发起方本来就有权知道的东西(它今天已经能从 [`ServerMsg::Peer`]
    /// 看到在线的那些)。`n` = 连接内单调请求号(照 `Send.n` 的形):[`ServerMsg::Roster`]
    /// 既是推送又是应答,**没有请求号就证不了「收到的这枚是本次拉取的应答」**,一枚
    /// 早就在飞的旧推送会让面板提前开放(设计审一轮 H3)。
    RosterReq { n: u64 },
    /// 开配对槽(须已鉴权;§4:TTL 10 分钟、单次使用)。
    PairOpen,
    /// 入配对槽(未鉴权连接唯一的业务入口,且限一槽;§4)。
    PairJoin { slot: u64 },
    /// 配对盲桥透传(SPAKE2 帧;§6。服务器只转发,不看内容)。
    PairMsg {
        slot: u64,
        #[serde(with = "serde_bytes")]
        blob: Vec<u8>,
    },
    /// 主动关槽(§4「SPAKE2 密钥确认失败 → 发起端主动关槽,槽烧毁」的信封面;
    /// 双方都可发——joiner 确认失败同样烧槽,在线猜测恒只有一次)。
    PairClose { slot: u64 },
    /// 心跳(§3;服务器回 Pong)。
    Ping,
}

/// 服务器 → 客户端。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ServerMsg {
    /// 连接即发(§4):32B 随机;auth/register_first 的签名覆盖它(防离线重放)。
    Challenge {
        #[serde(with = "serde_bytes")]
        nonce: Vec<u8>,
    },
    /// 鉴权通过(auth 或 register_first 成功)。
    Authed,
    /// 协议错误(code 见 [`err_code`];致命错误随后断开)。
    Err { code: String, msg: String },
    /// 投递(§3):含清信箱与实时,同队 FIFO 保序;**回显发送方原 to**
    /// (指名 device_id 或 `"*"`,收端重构 AAD 用,§2)。
    Deliver {
        from: String,
        to: String,
        #[serde(with = "serde_bytes")]
        blob: Vec<u8>,
    },
    /// send 被接受:完成在线转发 + 离线入箱(§5.2:**不是**对端已收,
    /// 对端兜底恒靠水位)。mail 恒 Ack(入箱即接手);direct 在线转发才 Ack。
    Ack { n: u64 },
    /// send 的业务性失败(n 对应那条 send,连接不断):direct 指名收件人不在线
    /// (not_online)、收件人不在本账户 registry(unknown_device)。P2-g:direct 的
    /// Nack = 对端不可达信号,engine 拉流换源用。
    Nack { n: u64, code: String },
    /// register_device 成功(发起的老设备收;配对流程「设备已加入」的信号)。
    Registered { device: String },
    /// 席位租约已授(billing-plan §5;device 回显租约目标供关联)。失败走 Err
    /// (seat 闸双错误码 / device_id_taken)。
    SeatLease { device: String },
    /// 配对槽已开(§4;配对码 `slot-SECRET` 的 slot 半,SECRET 走带外人眼)。
    PairSlot { slot: u64 },
    /// 配对盲桥透传(对端的 SPAKE2 帧)。
    PairMsg {
        slot: u64,
        #[serde(with = "serde_bytes")]
        blob: Vec<u8>,
    },
    /// 配对对端事件(发起端收 Joined;任一方收 Left/Closed 即槽已烧)。
    PairPeer { event: PairEvent },
    /// 账户内在线状态(元数据,帮助对端决定何时发 hello;§3)。
    Peer { device: String, online: bool },
    /// 心跳应答。
    Pong,
    /// 账户授权状态(billing-plan §6,工序 4;**仅对声明 [`CAP_ACCOUNT_STATUS_V1`]
    /// 能力者下发**——旧客户端不声明能力故永不收到本变体,不触发「未知变体
    /// DecodeError 断连」)。粗粒度只读展示,取值全派生自服务器亲见的元数据与
    /// wire 字节计数,不含任何用户内容。
    ///
    /// **客户端契约(Required-1,未来渲染轮必须遵守)**:多帧到达时**取
    /// `status_revision` 最大者为准、丢弃更小的**,不是「后到覆盖」——ENTER 推送
    /// (连接线程)与 admin 推送(另一线程)可乱序到达同一连接,revision 单调但
    /// 发送序不保证。`status_revision` 单调性限单次服务器启动(跨重启复位)。
    AccountStatusV1 {
        status_revision: u64,
        /// 服务器当前 UTC 时刻(RFC3339)。
        server_now: String,
        /// 账户显式设置过的档位名(None=从未设置=隐含免费档)。
        configured_tier: Option<String>,
        /// server_now 时刻的生效档位名(到期/无记录=免费档)。
        effective_tier: String,
        /// 显式记录的到期时刻(RFC3339;None=不过期)。取 **configured** 那份——
        /// effective 到期后回免费档会丢失原到期时刻。
        expires_at: Option<String>,
        /// 当前活跃(未吊销)设备数。
        seat_count: u32,
        /// 生效可执行席位上限 = `min(套餐席位, 服务器硬帽 device_cap)`。
        seat_quota: u32,
        /// 本 UTC 月已计 wire 字节(达量计数口径)。
        fastlane_used: u64,
        /// 本月已授高速额度高水位(grant;`fastlane_used > fastlane_quota` 即 RateLimited)。
        fastlane_quota: u64,
        /// 生效受限原因集合(工序 4 只可能空或 `{FastlaneExhausted}`)。
        restriction_reasons: Vec<Restriction>,
        /// 受限时的达量速率(**字节/秒**);`0` = 不限速(Open)。
        effective_rate_bps: u64,
        /// 计量周期(UTC 月)起(RFC3339)。
        period_start: String,
        /// 计量周期止=下月初(RFC3339)。
        period_end: String,
        /// 数据面态(工序 4 只可能 `Open`/`RateLimited`;`SeatClosed` 工序 6)。
        data_plane: DataPlane,
    },
    /// 权威名册(identity-plan §5.4;**仅对声明 [`CAP_DEVICE_ROSTER_V1`] 者下发**)。
    /// 三个时机:`Authed` 之后**搬信箱之前**推一枚(能力信号)/ 对
    /// [`ClientMsg::RosterReq`] 的应答 / 成员集合真变化时重推。
    ///
    /// **客户端契约:两条判据必须分家**(设计审二轮 M1)——
    ///
    /// ```text
    /// matching_request = (request == Some(pending.n))   // 决定「结不结账」
    /// apply_payload    = (revision >= current_revision) // 决定「更不更新名册」
    /// ```
    ///
    /// 反例:我的应答带 revision 10,而一枚并发成员变更的推送带 revision 11 **先到**;
    /// 按「revision 更小就丢弃」处理会把那枚**匹配我请求号**的应答整个丢掉 ⇒ UI 刷新
    /// 错误超时。正确处置 = **结账但不倒灌**。反过来,`request == None` 或号对不上的
    /// `Roster` 不结账,但 revision 更新时**照样应用**(它仍是权威名册)。
    Roster {
        /// `Some(n)` = 这是对那一枚 [`ClientMsg::RosterReq`] 的应答;`None` = 服务器主动推送。
        request: Option<u64>,
        /// 单账户单调计数器。**比较只在单条会话内有效**——服务器重启即复位,而重启
        /// 必然断连、会话必然重建、客户端的名册必然回「不知道」,这一格由会话边界
        /// 自然闭合(故不需要 `server_instance_id`)。
        revision: u64,
        devices: Vec<RosterEntry>,
    },
    /// [`ClientMsg::DeviceAdmin`] 的定向成功回执(客户端比对 target+action 才结账)。
    DeviceAdminOk { target: String, action: DeviceAction },
    /// [`ClientMsg::RosterReq`] 的**失败**面(identity-plan §5.5,设计审二轮 H2)。
    ///
    /// 没有它,失败只能走**无编号**的 [`ServerMsg::Err`],而那枚 Err 会被客户端认给
    /// 正在等结果的 UI 命令(周期拉取撞限频回 `busy` ⇒ 结掉 `DeviceAdmin` flow)。
    /// ⚠ **不复用既有 [`ServerMsg::Nack`]**:那个 `n` 是 `Send` 的连接内序号,两个
    /// 序列共用一个变体会撞号。
    RosterNack { n: u64, code: String },
}

/// 受限原因(billing-plan §4;线上枚举,与服务端内部 `throttle::RestrictionReason`
/// 解耦、服务端做映射)。工序 4 只 `FastlaneExhausted` 可达,其余供后续工序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Restriction {
    FastlaneExhausted,
    SeatOverage,
    AdminAbuse,
}

/// 数据面态(billing-plan §6 `AccountStatusV1.data_plane`)。工序 4 只 `Open`/
/// `RateLimited` 可达;`SeatClosed`(数据面关闭)随 SeatOverage 在工序 6 落。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DataPlane {
    Open,
    RateLimited,
    SeatClosed,
}

/// 设备管理动作([`ClientMsg::DeviceAdmin`];identity-plan §5.3 三句话)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeviceAction {
    /// 移除设备:服务器面吊销(鉴权拒 + 当场 kick + 清信箱 + 烧配对槽)。
    /// **任何设备都能移除自己**(自助退出),移除别人要管理位。
    Remove,
    /// 设为管理设备(要管理位)。
    GrantAdmin,
    /// 取消管理设备(要管理位;不得让 `admins` 变空)。
    RevokeAdmin,
}

/// 签名域里 `action` 那一个字节。**写死成独立常量,不许依赖 Rust 枚举顺序或
/// `as u8` 的隐式判别值**(identity-plan §5.5 M2):线上的 [`DeviceAction`] 走 CBOR
/// **变体名**,而签名域这一字节是**另一份协议**——重排变体不得改变它,故它自己
/// 进黄金向量(`golden_device_admin_action_bytes`)。
const ACTION_REMOVE: u8 = 0x01;
const ACTION_GRANT_ADMIN: u8 = 0x02;
const ACTION_REVOKE_ADMIN: u8 = 0x03;

impl DeviceAction {
    fn sig_byte(self) -> u8 {
        match self {
            DeviceAction::Remove => ACTION_REMOVE,
            DeviceAction::GrantAdmin => ACTION_GRANT_ADMIN,
            DeviceAction::RevokeAdmin => ACTION_REVOKE_ADMIN,
        }
    }
}

/// 权威名册的一行([`ServerMsg::Roster`];identity-plan §5.4)。
///
/// **只带 device_id 与管理标记,不带别名**——别名是 E2EE 的,服务器根本不知道。
/// 界面上的名字 = **服务器名册 ⋈ 本地 `device_profile`**:有别名显别名,没有就显
/// 最短唯一前缀。这一条同时解释了为什么 `device_profile` 的行不能删。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RosterEntry {
    pub device: String,
    pub admin: bool,
}

/// 投递通道(§3):mail=收件设备离线则入信箱(op/ctl 控制帧);
/// direct=仅在线,不入信箱(boot/blob 大流量;指名收件人离线回 `err{not_online}`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Lane {
    Mail,
    Direct,
}

/// 配对对端事件(`PairPeer.event`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairEvent {
    /// 有人入了你开的槽(发起端启动 SPAKE2 的信号)。
    Joined,
    /// 对端连接断开(槽已烧)。
    Left,
    /// 对端主动关槽(密钥确认失败;槽已烧)。
    Closed,
}

// ---- 编解码(CBOR 线上格式) ----

/// 解码失败:不是本协议的帧(或双端版本漂移)。调用方拒收/断开,fail-fast。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeError;

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "信封无法解码(不是本协议的帧?)")
    }
}

impl std::error::Error for DecodeError {}

/// 编信封(CBOR)。输出字节即线上格式,黄金向量测试焊死。
pub fn encode<T: Serialize>(msg: &T) -> Vec<u8> {
    let mut buf = Vec::new();
    ciborium::into_writer(msg, &mut buf).expect("CBOR 编码进内存 Vec 无失败路径");
    buf
}

/// 解信封。
pub fn decode<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, DecodeError> {
    ciborium::from_reader(bytes).map_err(|_| DecodeError)
}

// ---- 签名 payload(§4;双端共用,逐字节一致) ----

/// auth:`"zhujian-sync-auth-v1" ‖ nonce ‖ account ‖ device`。
pub fn auth_sig_payload(nonce: &[u8], account: &str, device: &str) -> Vec<u8> {
    [
        SIG_AUTH_V1.as_bytes(),
        nonce,
        account.as_bytes(),
        device.as_bytes(),
    ]
    .concat()
}

/// register_first:`"zhujian-sync-register-first-v1" ‖ nonce ‖ account ‖ device ‖ pubkey`。
pub fn register_first_sig_payload(
    nonce: &[u8],
    account: &str,
    device: &str,
    pubkey: &[u8],
) -> Vec<u8> {
    [
        SIG_REGISTER_FIRST_V1.as_bytes(),
        nonce,
        account.as_bytes(),
        device.as_bytes(),
        pubkey,
    ]
    .concat()
}

/// register_device:`"zhujian-sync-register-device-v1" ‖ account ‖ new_device ‖ new_pubkey`
/// (§4 字面,无 nonce——已鉴权通道内,重放只是幂等重注册)。
pub fn register_device_sig_payload(account: &str, new_device: &str, new_pubkey: &[u8]) -> Vec<u8> {
    [
        SIG_REGISTER_DEVICE_V1.as_bytes(),
        account.as_bytes(),
        new_device.as_bytes(),
        new_pubkey,
    ]
    .concat()
}

/// seat_lease:`"zhujian-sync-seat-lease-v1" ‖ account ‖ new_device ‖ new_pubkey`
/// (与 register_device 同构:已鉴权通道内,重放=同目标幂等重求租)。
pub fn seat_lease_sig_payload(account: &str, new_device: &str, new_pubkey: &[u8]) -> Vec<u8> {
    [
        SIG_SEAT_LEASE_V1.as_bytes(),
        account.as_bytes(),
        new_device.as_bytes(),
        new_pubkey,
    ]
    .concat()
}

/// device_admin:`"zhujian-sync-device-admin-v1" ‖ nonce(32B) ‖ account(26B) ‖
/// caller(26B) ‖ target(26B) ‖ action(1B)`(identity-plan §5.5)。
///
/// 两处与既有三条签名路不同,各有理由:
/// - **绑 nonce**:register_device / seat_lease 的重放是幂等无害的,移除不是——一枚
///   签名在别的连接上重放可能命中一台同 id 被重新注册的设备。产品路径上极窄(重新
///   加入必然换 device_id),但 nonce 现成可用,**代价为零的封闭窗口就该封**。
/// - **把 caller 也写进 payload**:验签用的是本会话公钥、已经绑住了发起方;写进去是
///   让这枚签名**自描述**(「这台设备,在这条连接上,要对那台做这件事」),照 254
///   那条「类型封不变量要绑全部输入」的纪律。
pub fn device_admin_sig_payload(
    nonce: &[u8],
    account: &str,
    caller: &str,
    target: &str,
    action: DeviceAction,
) -> Vec<u8> {
    [
        SIG_DEVICE_ADMIN_V1.as_bytes(),
        nonce,
        account.as_bytes(),
        caller.as_bytes(),
        target.as_bytes(),
        &[action.sig_byte()],
    ]
    .concat()
}

/// ULID 形态校验:26 字符、大写 Crockford base32(无 I/L/O/U)、首字符 ≤ '7'
/// (128-bit 上限)。account_id/device_id 的入口守卫——**定长形态是签名 payload
/// 拼接无歧义的前提**,不合 = 拒,不进验签。
pub fn is_ulid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 26
        && b[0] <= b'7'
        && b.iter().all(|&c| {
            matches!(c,
                b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    const ACCT: &str = "01JZFAKEACCT0000000000AAAA";
    const DEV_A: &str = "01JZFAKEDEVA0000000000AAAA";
    const DEV_B: &str = "01JZFAKEDEVB0000000000BBBB";

    /// 黄金向量(全变体):信封的 CBOR 字节形态即协议(与内层 Msg 同纪律,P2-d 定)。
    /// 这些断言失败 = 线上格式变了 = 双端不兼容,别改断言,改回代码。
    #[test]
    fn golden_client_msgs() {
        let cases: Vec<(ClientMsg, &str)> = vec![
            // 空 caps skip 序列化:字节与工序 4 前逐字节相同(前向兼容锚,勿改断言)。
            (
                ClientMsg::RegisterFirst { account: "A".into(), device: "D".into(), pubkey: vec![7; 2], sig: vec![8; 2], caps: vec![] },
                "a16d52656769737465724669727374a4676163636f756e746141666465766963656144667075626b657942070763736967420808",
            ),
            (
                ClientMsg::Auth { account: "A".into(), device: "D".into(), sig: vec![1, 2], caps: vec![] },
                "a16441757468a3676163636f756e74614166646576696365614463736967420102",
            ),
            // 带 caps 的 Auth:map 多一个 "caps" 键(工序 4 新线上形态)。
            (
                ClientMsg::Auth { account: "A".into(), device: "D".into(), sig: vec![1, 2], caps: vec![CAP_ACCOUNT_STATUS_V1.into()] },
                "a16441757468a4676163636f756e74614166646576696365614463736967420102646361707381716163636f756e745f7374617475735f7631",
            ),
            (
                ClientMsg::Send { n: 7, to: BROADCAST.into(), lane: Lane::Mail, blob: vec![0xaa, 0xbb] },
                "a16453656e64a4616e0762746f612a646c616e65644d61696c64626c6f6242aabb",
            ),
            (
                ClientMsg::Send { n: 8, to: "B".into(), lane: Lane::Direct, blob: vec![0xcc] },
                "a16453656e64a4616e0862746f6142646c616e656644697265637464626c6f6241cc",
            ),
            (
                ClientMsg::RegisterDevice { account: "A".into(), new_device: "E".into(), new_pubkey: vec![9; 2], sig_by_old: vec![10; 2] },
                "a16e5265676973746572446576696365a4676163636f756e7461416a6e65775f64657669636561456a6e65775f7075626b65794209096a7369675f62795f6f6c64420a0a",
            ),
            (
                ClientMsg::SeatLease { account: "A".into(), new_device: "E".into(), new_pubkey: vec![9; 2], sig_by_old: vec![10; 2] },
                "a169536561744c65617365a4676163636f756e7461416a6e65775f64657669636561456a6e65775f7075626b65794209096a7369675f62795f6f6c64420a0a",
            ),
            // unit 变体编成纯字符串(非单键 map)——这也是协议的一部分。
            (ClientMsg::PairOpen, "68506169724f70656e"),
            (ClientMsg::PairJoin { slot: 123456789 }, "a168506169724a6f696ea164736c6f741a075bcd15"),
            (
                ClientMsg::PairMsg { slot: 123456789, blob: vec![0xff] },
                "a167506169724d7367a264736c6f741a075bcd1564626c6f6241ff",
            ),
            (ClientMsg::PairClose { slot: 123456789 }, "a16950616972436c6f7365a164736c6f741a075bcd15"),
            (ClientMsg::Ping, "6450696e67"),
            // 367:设备管理。action 走 CBOR **变体名**(与签名域那一字节是两份协议)。
            (
                ClientMsg::DeviceAdmin { account: "A".into(), target: "T".into(), action: DeviceAction::Remove, sig: vec![1, 2] },
                "a16b44657669636541646d696ea4676163636f756e74614166746172676574615466616374696f6e6652656d6f766563736967420102",
            ),
            (
                ClientMsg::DeviceAdmin { account: "A".into(), target: "T".into(), action: DeviceAction::GrantAdmin, sig: vec![1, 2] },
                "a16b44657669636541646d696ea4676163636f756e74614166746172676574615466616374696f6e6a4772616e7441646d696e63736967420102",
            ),
            (
                ClientMsg::DeviceAdmin { account: "A".into(), target: "T".into(), action: DeviceAction::RevokeAdmin, sig: vec![1, 2] },
                "a16b44657669636541646d696ea4676163636f756e74614166746172676574615466616374696f6e6b5265766f6b6541646d696e63736967420102",
            ),
            (ClientMsg::RosterReq { n: 7 }, "a169526f73746572526571a1616e07"),
        ];
        for (msg, want) in cases {
            assert_eq!(hex(&encode(&msg)), *want, "{msg:?}");
        }
    }

    #[test]
    fn golden_server_msgs() {
        let cases: Vec<(ServerMsg, &str)> = vec![
            (
                ServerMsg::Challenge { nonce: vec![0x11; 2] },
                "a1694368616c6c656e6765a1656e6f6e6365421111",
            ),
            (ServerMsg::Authed, "66417574686564"),
            (
                ServerMsg::Err { code: "auth_failed".into(), msg: "no".into() },
                "a163457272a264636f64656b617574685f6661696c6564636d7367626e6f",
            ),
            (
                ServerMsg::Deliver { from: "F".into(), to: "*".into(), blob: vec![9] },
                "a16744656c69766572a36466726f6d614662746f612a64626c6f624109",
            ),
            (ServerMsg::Ack { n: 42 }, "a16341636ba1616e182a"),
            (
                ServerMsg::Nack { n: 43, code: "not_online".into() },
                "a1644e61636ba2616e182b64636f64656a6e6f745f6f6e6c696e65",
            ),
            (ServerMsg::Registered { device: "E".into() }, "a16a52656769737465726564a1666465766963656145"),
            (ServerMsg::SeatLease { device: "E".into() }, "a169536561744c65617365a1666465766963656145"),
            (ServerMsg::PairSlot { slot: 123456789 }, "a16850616972536c6f74a164736c6f741a075bcd15"),
            (
                ServerMsg::PairMsg { slot: 123456789, blob: vec![0xee] },
                "a167506169724d7367a264736c6f741a075bcd1564626c6f6241ee",
            ),
            (
                ServerMsg::PairPeer { event: PairEvent::Joined },
                "a1685061697250656572a1656576656e74664a6f696e6564",
            ),
            (
                ServerMsg::PairPeer { event: PairEvent::Left },
                "a1685061697250656572a1656576656e74644c656674",
            ),
            (
                ServerMsg::PairPeer { event: PairEvent::Closed },
                "a1685061697250656572a1656576656e7466436c6f736564",
            ),
            (
                ServerMsg::Peer { device: "D".into(), online: true },
                "a16450656572a2666465766963656144666f6e6c696e65f5",
            ),
            (ServerMsg::Pong, "64506f6e67"),
            // 工序 4:AccountStatusV1 全字段(免费档/Open 样例)。字段顺序即线上形态,
            // 改字段名/序=破坏兼容,别改断言、改回代码。
            (
                ServerMsg::AccountStatusV1 {
                    status_revision: 1,
                    server_now: "2026-07-22T00:00:00Z".into(),
                    configured_tier: None,
                    effective_tier: "free".into(),
                    expires_at: None,
                    seat_count: 1,
                    seat_quota: 2,
                    fastlane_used: 0,
                    fastlane_quota: 314572800,
                    restriction_reasons: vec![],
                    effective_rate_bps: 0,
                    period_start: "2026-07-01T00:00:00Z".into(),
                    period_end: "2026-08-01T00:00:00Z".into(),
                    data_plane: DataPlane::Open,
                },
                "a16f4163636f756e745374617475735631ae6f7374617475735f7265766973696f6e016a7365727665725f6e6f7774323032362d30372d32325430303a30303a30305a6f636f6e666967757265645f74696572f66e6566666563746976655f7469657264667265656a657870697265735f6174f66a736561745f636f756e74016a736561745f71756f7461026d666173746c616e655f75736564006e666173746c616e655f71756f74611a12c00000737265737472696374696f6e5f726561736f6e7380726566666563746976655f726174655f627073006c706572696f645f737461727474323032362d30372d30315430303a30303a30305a6a706572696f645f656e6474323032362d30382d30315430303a30303a30305a6a646174615f706c616e65644f70656e",
            ),
            // 367:名册三条。`request` 是 Option<u64> —— Some 编成裸值、None 编成 null(f6),
            // 两支各钉一条(客户端靠它区分「应答」与「主动推送」)。
            (
                ServerMsg::Roster {
                    request: Some(5),
                    revision: 9,
                    devices: vec![RosterEntry { device: "D".into(), admin: true }],
                },
                "a166526f73746572a3677265717565737405687265766973696f6e09676465766963657381a26664657669636561446561646d696ef5",
            ),
            (
                ServerMsg::Roster { request: None, revision: 0, devices: vec![] },
                "a166526f73746572a36772657175657374f6687265766973696f6e00676465766963657380",
            ),
            (
                ServerMsg::DeviceAdminOk { target: "T".into(), action: DeviceAction::GrantAdmin },
                "a16d44657669636541646d696e4f6ba266746172676574615466616374696f6e6a4772616e7441646d696e",
            ),
            (
                ServerMsg::RosterNack { n: 3, code: "busy".into() },
                "a16a526f737465724e61636ba2616e0364636f64656462757379",
            ),
        ];
        for (msg, want) in cases {
            assert_eq!(hex(&encode(&msg)), *want, "{msg:?}");
        }
    }

    /// 全变体 CBOR 往返(黄金向量之外的结构完整性)。
    #[test]
    fn roundtrip_all_variants() {
        let client: Vec<ClientMsg> = vec![
            ClientMsg::RegisterFirst {
                account: ACCT.into(),
                device: DEV_A.into(),
                pubkey: vec![7; 32],
                sig: vec![8; 64],
                caps: vec![],
            },
            ClientMsg::Auth {
                account: ACCT.into(),
                device: DEV_A.into(),
                sig: vec![8; 64],
                caps: vec![CAP_ACCOUNT_STATUS_V1.into()],
            },
            ClientMsg::Send {
                n: 42,
                to: DEV_B.into(),
                lane: Lane::Direct,
                blob: vec![1, 2, 3],
            },
            ClientMsg::RegisterDevice {
                account: ACCT.into(),
                new_device: DEV_B.into(),
                new_pubkey: vec![9; 32],
                sig_by_old: vec![10; 64],
            },
            ClientMsg::SeatLease {
                account: ACCT.into(),
                new_device: DEV_B.into(),
                new_pubkey: vec![9; 32],
                sig_by_old: vec![10; 64],
            },
            ClientMsg::PairOpen,
            ClientMsg::PairJoin { slot: 123456 },
            ClientMsg::PairMsg { slot: 123456, blob: vec![0xff] },
            ClientMsg::PairClose { slot: 123456 },
            ClientMsg::Ping,
            ClientMsg::DeviceAdmin {
                account: ACCT.into(),
                target: DEV_B.into(),
                action: DeviceAction::RevokeAdmin,
                sig: vec![11; 64],
            },
            ClientMsg::RosterReq { n: u64::MAX },
        ];
        for msg in client {
            assert_eq!(decode::<ClientMsg>(&encode(&msg)).unwrap(), msg);
        }
        let server: Vec<ServerMsg> = vec![
            ServerMsg::Challenge { nonce: vec![0; 32] },
            ServerMsg::Authed,
            ServerMsg::Err { code: err_code::AUTH_FAILED.into(), msg: "拒".into() },
            ServerMsg::Deliver { from: DEV_A.into(), to: BROADCAST.into(), blob: vec![5; 100] },
            ServerMsg::Ack { n: 42 },
            ServerMsg::Nack { n: 43, code: err_code::NOT_ONLINE.into() },
            ServerMsg::Registered { device: DEV_B.into() },
            ServerMsg::SeatLease { device: DEV_B.into() },
            ServerMsg::PairSlot { slot: 123456 },
            ServerMsg::PairMsg { slot: 123456, blob: vec![0xee] },
            ServerMsg::PairPeer { event: PairEvent::Left },
            ServerMsg::PairPeer { event: PairEvent::Closed },
            ServerMsg::Peer { device: DEV_A.into(), online: true },
            ServerMsg::Pong,
            ServerMsg::AccountStatusV1 {
                status_revision: 42,
                server_now: "2026-07-22T12:34:56Z".into(),
                configured_tier: Some("personal".into()),
                effective_tier: "personal".into(),
                expires_at: Some("2027-07-22T00:00:00Z".into()),
                seat_count: 3,
                seat_quota: 4,
                fastlane_used: 2_147_483_648,
                fastlane_quota: 2_147_483_648,
                restriction_reasons: vec![Restriction::FastlaneExhausted],
                effective_rate_bps: 1_048_576,
                period_start: "2026-07-01T00:00:00Z".into(),
                period_end: "2026-08-01T00:00:00Z".into(),
                data_plane: DataPlane::RateLimited,
            },
            ServerMsg::Roster {
                request: Some(u64::MAX),
                revision: u64::MAX,
                devices: vec![
                    RosterEntry { device: DEV_A.into(), admin: true },
                    RosterEntry { device: DEV_B.into(), admin: false },
                ],
            },
            ServerMsg::Roster { request: None, revision: 1, devices: vec![] },
            ServerMsg::DeviceAdminOk { target: DEV_B.into(), action: DeviceAction::Remove },
            ServerMsg::RosterNack { n: 9, code: err_code::BUSY.into() },
        ];
        for msg in server {
            assert_eq!(decode::<ServerMsg>(&encode(&msg)).unwrap(), msg);
        }
    }

    /// 字节字段必须是 CBOR bytes(0x40+ major type 2),不是逐元素数组——
    /// serde_bytes 掉了会膨胀近一倍且和对端互拒。
    #[test]
    fn blob_encodes_as_cbor_bytes() {
        let msg = ClientMsg::PairMsg { slot: 1, blob: vec![0u8; 64] };
        let bytes = encode(&msg);
        // 64B 的 bytes 编码是 0x58 0x40(bytes, len 64);逐元素数组会是 0x98 0x40。
        let needle = [0x58u8, 0x40];
        assert!(
            bytes.windows(2).any(|w| w == needle),
            "blob 没按 CBOR bytes 编码:{}",
            hex(&bytes)
        );
    }

    #[test]
    fn decode_rejects_garbage_and_unknown_variant() {
        assert_eq!(decode::<ClientMsg>(b"not cbor"), Err(DecodeError));
        // 未知变体(将来新增的信封消息)在旧端 = DecodeError,断开重来,不静默吞。
        let unknown = encode(&ServerMsg::Pong); // "Pong" 不是 ClientMsg 变体
        assert_eq!(decode::<ClientMsg>(&unknown), Err(DecodeError));
    }

    /// 签名 payload 的字节形态(双端逐字节一致的对拍基准)。
    #[test]
    fn sig_payloads() {
        let nonce = [0x11u8; 32];
        let auth = auth_sig_payload(&nonce, ACCT, DEV_A);
        assert_eq!(&auth[..SIG_AUTH_V1.len()], SIG_AUTH_V1.as_bytes());
        assert_eq!(auth.len(), SIG_AUTH_V1.len() + 32 + 26 + 26);

        let pubkey = [0x22u8; 32];
        let rf = register_first_sig_payload(&nonce, ACCT, DEV_A, &pubkey);
        assert_eq!(rf.len(), SIG_REGISTER_FIRST_V1.len() + 32 + 26 + 26 + 32);
        assert_eq!(&rf[rf.len() - 32..], &pubkey[..]);

        let rd = register_device_sig_payload(ACCT, DEV_B, &pubkey);
        assert_eq!(rd.len(), SIG_REGISTER_DEVICE_V1.len() + 26 + 26 + 32);

        let da = device_admin_sig_payload(&nonce, ACCT, DEV_A, DEV_B, DeviceAction::Remove);
        assert_eq!(&da[..SIG_DEVICE_ADMIN_V1.len()], SIG_DEVICE_ADMIN_V1.as_bytes());
        assert_eq!(da.len(), SIG_DEVICE_ADMIN_V1.len() + 32 + 26 + 26 + 26 + 1);
        // caller 与 target 都在 payload 里,且**顺序固定**:调换二者必得不同字节
        // (否则「A 踢 B」的签名就能当「B 踢 A」用)。
        assert_ne!(
            da,
            device_admin_sig_payload(&nonce, ACCT, DEV_B, DEV_A, DeviceAction::Remove)
        );
        // 绑 nonce:换一条连接的 challenge 即换一枚 payload(重放窗口封闭)。
        assert_ne!(
            da,
            device_admin_sig_payload(&[0x99u8; 32], ACCT, DEV_A, DEV_B, DeviceAction::Remove)
        );

        let sl = seat_lease_sig_payload(ACCT, DEV_B, &pubkey);
        assert_eq!(&sl[..SIG_SEAT_LEASE_V1.len()], SIG_SEAT_LEASE_V1.as_bytes());
        assert_eq!(sl.len(), SIG_SEAT_LEASE_V1.len() + 26 + 26 + 32);
        // 域前缀隔离:同字段的 register_device 与 seat_lease payload 绝不同字节。
        assert_ne!(sl, rd);
    }

    /// **签名域里 action 那一字节是另一份协议**(identity-plan §5.5 M2):线上走 CBOR
    /// 变体名,签名走这一个字节。它不许依赖枚举顺序或 `as u8`,故自己进黄金向量——
    /// 重排 [`DeviceAction`] 的变体、或给它插一个新变体,本测都必须岿然不动。
    #[test]
    fn golden_device_admin_action_bytes() {
        let nonce = [0u8; 32];
        for (action, want) in [
            (DeviceAction::Remove, 0x01u8),
            (DeviceAction::GrantAdmin, 0x02),
            (DeviceAction::RevokeAdmin, 0x03),
        ] {
            let p = device_admin_sig_payload(&nonce, ACCT, DEV_A, DEV_B, action);
            assert_eq!(*p.last().unwrap(), want, "{action:?} 的签名字节");
        }
        // 三个动作两两互不相同——否则「取消管理位」的签名能当「移除」用。
        let p = |a| device_admin_sig_payload(&nonce, ACCT, DEV_A, DEV_B, a);
        assert_ne!(p(DeviceAction::Remove), p(DeviceAction::GrantAdmin));
        assert_ne!(p(DeviceAction::GrantAdmin), p(DeviceAction::RevokeAdmin));
        assert_ne!(p(DeviceAction::Remove), p(DeviceAction::RevokeAdmin));
    }

    /// 无编号 `Err` 的归属白名单(identity-plan §5.5 六轮点名的三只里的前两只;
    /// 第三只「服务端主动状态推送 helper 拒用 flow code」住 server)。
    /// ⚠ 「测一个字符串等于某常量」是同义反复,**不写**——白名单元素直接引用现有
    /// 常量,「里面每个 code 都真实存在」已由**编译器**保证。
    #[test]
    fn flow_error_whitelists() {
        // ① 两张表内部无重复。
        for (name, table) in [
            ("PAIR", err_code::PAIR_FLOW_ERRORS),
            ("DEVICE_ADMIN", err_code::DEVICE_ADMIN_FLOW_ERRORS),
        ] {
            let mut seen = std::collections::BTreeSet::new();
            for code in table {
                assert!(seen.insert(*code), "{name}_FLOW_ERRORS 内部重复:{code}");
            }
        }
        // ② `account_throttled` 不属于任何 flow —— 它正是那条**第三方主动异步**推送,
        // 也是整套白名单存在的理由(三轮 H1)。它一旦落进任一张表,那条 flow 就会
        // 被一枚与自己无关的状态推送提前结账。
        assert!(!err_code::PAIR_FLOW_ERRORS.contains(&err_code::ACCOUNT_THROTTLED));
        assert!(!err_code::DEVICE_ADMIN_FLOW_ERRORS.contains(&err_code::ACCOUNT_THROTTLED));
    }

    /// 黄金边界(identity-plan §5.13 H3/H6):[`MAX_ROSTER_DEVICES`] 台的**最大** roster
    /// 帧编码后既要过 WS 帧上限,也要守住设计阶段算的那个量级。
    ///
    /// ⚠ 单看「不超 1 MiB」没有意义——那只保证「实现者最后挑的那个值不超上限」,
    /// 替代不了设计阶段的资源判断(理论 wire 极限约 24,384 台)。真正有牙齿的是
    /// 下面那条 ≈1.4 KiB 的紧边界:它同时锚住 §5.13 那张表里的 fan-out 估算
    /// (32 条连接全 fan-out ≈ 45 KiB wire),形状一变就红。
    #[test]
    fn golden_max_roster_frame() {
        let devices: Vec<RosterEntry> = (0..MAX_ROSTER_DEVICES)
            .map(|i| {
                let device = format!("01JZFAKEDEV{i:02}{}", "0".repeat(13));
                assert!(is_ulid(&device), "夹具本身得是合法 ULID:{device}");
                RosterEntry { device, admin: true }
            })
            .collect();
        // 最坏情况:revision 取满、request 取 Some(满)——两个变长整数都吃 9 字节。
        let frame = encode(&ServerMsg::Roster {
            request: Some(u64::MAX),
            revision: u64::MAX,
            devices,
        });
        assert!(frame.len() <= MAX_FRAME_BYTES, "roster 帧撞 WS 上限:{}", frame.len());
        assert!(
            frame.len() <= 1500,
            "roster 帧比 §5.13 算的 ≈1.4 KiB 大了({});资源表要重算",
            frame.len()
        );
    }

    #[test]
    fn is_ulid_gate() {
        assert!(is_ulid("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert!(is_ulid(ACCT));
        assert!(!is_ulid("")); // 空
        assert!(!is_ulid("01ARZ3NDEKTSV4RRFFQ69G5FA")); // 25 字符
        assert!(!is_ulid("01ARZ3NDEKTSV4RRFFQ69G5FAVX")); // 27 字符
        assert!(!is_ulid("01arz3ndektsv4rrffq69g5fav")); // 小写
        assert!(!is_ulid("01ARZ3NDEKTSV4RRFFQ69G5FAL")); // L 不在字母表
        assert!(!is_ulid("81ARZ3NDEKTSV4RRFFQ69G5FAV")); // 首字符 > 7
        assert!(!is_ulid(BROADCAST)); // "*" 不是设备
    }

    /// 前向兼容命根子(四组跨版本测②「新客→旧服」):新客户端给 Auth 多带 caps
    /// (map 多一键),旧服务端(不知 caps 的旧结构)必须忽略它、照常解码。依据=
    /// ciborium 命名 map + serde `IgnoredAny` 跳过未知键;若哪天有人给 Auth/
    /// RegisterFirst 加 `deny_unknown_fields` 或改数组编码,本测即红、当场拦住。
    #[test]
    fn caps_forward_compat_old_decoder_ignores() {
        // 旧服务端的视图(工序 4 前的字段形态,无 caps)。
        #[derive(Deserialize, PartialEq, Debug)]
        enum OldClientMsg {
            RegisterFirst {
                account: String,
                device: String,
                #[serde(with = "serde_bytes")]
                pubkey: Vec<u8>,
                #[serde(with = "serde_bytes")]
                sig: Vec<u8>,
            },
            Auth {
                account: String,
                device: String,
                #[serde(with = "serde_bytes")]
                sig: Vec<u8>,
            },
        }
        // Auth 带 caps → 旧结构解码忽略 caps。
        let auth = ClientMsg::Auth {
            account: "A".into(),
            device: "D".into(),
            sig: vec![1, 2],
            caps: vec![CAP_ACCOUNT_STATUS_V1.into()],
        };
        assert_eq!(
            decode::<OldClientMsg>(&encode(&auth)).expect("旧服务端须忽略 Auth 的 caps"),
            OldClientMsg::Auth { account: "A".into(), device: "D".into(), sig: vec![1, 2] }
        );
        // RegisterFirst 带 caps → 同样忽略。
        let reg = ClientMsg::RegisterFirst {
            account: "A".into(),
            device: "D".into(),
            pubkey: vec![7, 7],
            sig: vec![8, 8],
            caps: vec![CAP_ACCOUNT_STATUS_V1.into(), "future_cap".into()],
        };
        assert_eq!(
            decode::<OldClientMsg>(&encode(&reg)).expect("旧服务端须忽略 RegisterFirst 的 caps"),
            OldClientMsg::RegisterFirst {
                account: "A".into(),
                device: "D".into(),
                pubkey: vec![7, 7],
                sig: vec![8, 8]
            }
        );
    }

    /// caps 卫生化(§6):≤16 项扫描、超 32B/非 ASCII 跳过、重复无妨、垃圾不连坐。
    #[test]
    fn has_capability_sanitizes() {
        assert!(has_capability(&[CAP_ACCOUNT_STATUS_V1.into()], CAP_ACCOUNT_STATUS_V1));
        assert!(!has_capability(&[], CAP_ACCOUNT_STATUS_V1));
        assert!(!has_capability(&["future_cap".into()], CAP_ACCOUNT_STATUS_V1)); // 未知忽略
        // 目标混在垃圾里仍认(超 32B / 非 ASCII 项跳过,不连坐)。
        let mixed = vec!["x".repeat(33), "naïve".into(), CAP_ACCOUNT_STATUS_V1.into()];
        assert!(has_capability(&mixed, CAP_ACCOUNT_STATUS_V1));
        // 超 16 项:目标落第 17 位不认(扫描上界挡异常长列表)。
        let mut long: Vec<String> = (0..16).map(|i| format!("cap{i}")).collect();
        long.push(CAP_ACCOUNT_STATUS_V1.into());
        assert!(!has_capability(&long, CAP_ACCOUNT_STATUS_V1));
        // 重复无妨。
        assert!(has_capability(
            &[CAP_ACCOUNT_STATUS_V1.into(), CAP_ACCOUNT_STATUS_V1.into()],
            CAP_ACCOUNT_STATUS_V1
        ));
    }
}
