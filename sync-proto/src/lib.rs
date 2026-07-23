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
}

/// 能力名:客户端声明「我懂 [`ServerMsg::AccountStatusV1`],请下发」(billing-plan
/// §6,工序 4)。挂在 [`ClientMsg::Auth`]/[`ClientMsg::RegisterFirst`] 的 `caps`。
pub const CAP_ACCOUNT_STATUS_V1: &str = "account_status_v1";

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

        let sl = seat_lease_sig_payload(ACCT, DEV_B, &pubkey);
        assert_eq!(&sl[..SIG_SEAT_LEASE_V1.len()], SIG_SEAT_LEASE_V1.as_bytes());
        assert_eq!(sl.len(), SIG_SEAT_LEASE_V1.len() + 26 + 26 + 32);
        // 域前缀隔离:同字段的 register_device 与 seat_lease payload 绝不同字节。
        assert_ne!(sl, rd);
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
