//! L-b 局域网直连(加速层)的纯逻辑层 —— `docs/lan-direct-plan.md` §2/§3/§4/§7 的落实。
//!
//! sans-io、不持 socket、不碰 DB:输入 = 已读满的一帧 [`LanWire`] + 调用方代入的事实
//! (准入材料、对端公钥缓存、本机子网、墙钟毫秒),输出 = 待发帧与终局判定。IO 宿主
//! (监听 / 拨号 / 链路集 / 通告落库 / generation 双检)是 L-c 的 transport。
//!
//! 三根锚(违反任何一条 = 设计失败,§1):
//! * **内容安全 = 帧层 E2EE 照旧**:数据面 [`LanWire::Frame`] 里的 blob 就是中转路
//!   同一枚密文(同 K_acc、同域子钥、同 AAD 五元组),本层只换运输管子、不叠第二层。
//! * **链路准入 = 设备身份证明**(§4 三步握手):双方各证明「持 K_acc(封解 lan 域)
//!   ∧ 持该 device_id 经**服务器鉴权路**钉住的那把 Ed25519 私钥」。只持恢复码
//!   (= K_acc)的自造设备没有任何合法对端缓存过它的公钥,建不了链。
//! * **公钥单一权威路**(§2):对端验证钥只从**经中转 deliver 到达**的 Hello 学得、
//!   首见即钉死;LAN 到达帧的 lan 字段整体忽略([`Ingress`] 由 socket 所有者构造,
//!   绝不取自对端字段),同 device_id 后到异钥 = 响亮禁用该对端直连(不覆盖写)。
//!
//! 被 MAC / 被签的材料一律 **CBOR definite 数组**,与 `crypto::frame_aad` 同字节纪律,
//! 黄金向量焊死(改 = 协议破坏)。`sig` 的被签字节是**嵌套数组** `[T, role]`——T 本身
//! 是 CBOR 数组值、原样嵌进去,不是它的编码字节串,别端实现照黄金向量对拍。
//!
//! [`LAN_VER`] 是 LanWire / 握手的独立版本轴,与 `crypto::PROTO_VER` 无关:局域网帧
//! 永不过中转,升它不牵动混版兼容(不符 = 静默关 + 诊断计数,无 skew UI)。
//!
//! 握手失败一律**静默关闭**(fail-closed):[`LanError`] 只供诊断计数与单测指认,
//! 不回给对端——枚举面(§9)不许被错误码喂养。

use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::OsRng;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_bytes::Bytes;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::net::Ipv4Addr;
use sync_proto::{is_ulid, RosterEntry};

use super::crypto::{self, ct_eq, Domain, FrameAddr, OpenError};
use super::engine::BROADCAST;

// ---- 一处一数的上界与常量(§10) ----

/// LanWire / 握手的版本轴(§3)。不符 = 静默关 + 诊断计数。
pub const LAN_VER: u64 = 1;
/// 局域网监听默认端口(§6;被占退临时端口、端口随通告)。
pub const DEFAULT_LAN_PORT: u16 = 24618;
/// 帧上限(§3/§10)。
pub const LAN_FRAME_MAX: usize = 1024 * 1024;
/// pre-auth 帧上限(§3 钉的是「首帧 ≤4 KiB」;Accept/Confirm 各约 200B,故 L-c 的读端
/// 对**握手完成前的每一帧**都用这个上限——比规格严、零代价,握手期收不到大帧)。
pub const LAN_PREAUTH_FRAME_MAX: usize = 4 * 1024;
/// 单条通告地址的文本上限(§10 未列;首版自检补的资源上界——`addrs` 是对端可控字符串,
/// 只限条数不限长度的话,一枚 Hello 能往 `sync_meta` 灌近 1 MiB)。45 = IPv6 文本形余量,
/// 留着将来加 IPv6 候选时不必动这条;非 IPv4 的条目由 [`check_candidate`] 在拨号时拒。
pub const MAX_ADDR_TEXT: usize = 45;
/// 双方 nonce 长度(§4)。
pub const NONCE_LEN: usize = 32;
/// 重复抑制缓存:每空间条数上限(§10;满 = 拒新 Intro,fail-closed 只影响直连)。
pub const DUP_CACHE_CAP: usize = 1024;
/// 重复抑制缓存 TTL(§10;条目一经登记保留到 TTL,**不因握手失败提前删**)。
pub const DUP_CACHE_TTL_MS: u64 = 10 * 60 * 1000;
/// 通告地址条数上限(§2/§10)。
pub const MAX_LISTEN_ADDRS: usize = 8;
/// `listen` 作为拨号候选的时效(§2/§7;逾期 = 不拨,这是「断网可用」的诚实边界)。
/// pubkey / ad_seq 不设时效。
pub const LISTEN_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// Intro MAC 的 transcript 标签(§4;与 T 的标签刻意不同字面)。
const INTRO_MAC_LABEL: &str = "zhujian/lan-intro/v1";
/// 握手 transcript T 的标签(§4)。
const HS_LABEL: &str = "zhujian-lan-hs-v1";
/// 被签材料的角色尾(§4:方向绑定,反射/搬运必不过)。
const ROLE_D: &str = "D";
const ROLE_L: &str = "L";

// ---- 线上消息(§3;CBOR externally tagged,黄金向量焊死) ----

/// 局域网 socket 上的线上消息(**只在局域网 socket 上存在**,永不过中转)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum LanWire {
    /// 拨入方首帧,明文(§4 步骤 1)。不携账户 ULID 与目标 id——两者绑进 `mac`
    /// 由验证方代入,故明文只泄露拨入方自己的 device ULID(§9 元数据面已披露)。
    Intro {
        ver: u64,
        from: String,
        #[serde(with = "serde_bytes")]
        nonce_d: Vec<u8>,
        #[serde(with = "serde_bytes")]
        mac: Vec<u8>,
    },
    /// 监听方应答(§4 步骤 2):blob = lan 域密文(AAD from=L、to=D)装 [`LanMsg::Accept`]。
    Accept {
        #[serde(with = "serde_bytes")]
        blob: Vec<u8>,
    },
    /// 拨入方确认(§4 步骤 3):blob = lan 域密文(AAD from=D、to=L)装 [`LanMsg::Confirm`]。
    Confirm {
        #[serde(with = "serde_bytes")]
        blob: Vec<u8>,
    },
    /// 数据面:blob = 现有 op/ctl/blob 域密文,from/to 供收端重构 AAD(与服务器
    /// `deliver` 回显同构)。收端校验见 [`check_frame_addr`]。
    Frame {
        from: String,
        to: String,
        #[serde(with = "serde_bytes")]
        blob: Vec<u8>,
    },
    /// 格式层心跳(§3:30s 发 / 静默 90s 判死;路由级活性另见 §5.1)。
    Ping {},
    Pong {},
}

/// lan 域密文的内层消息(§4;域子钥 + AAD domain 把它与 `engine::Msg`/`BootMsg` 隔死)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum LanMsg {
    Accept {
        #[serde(with = "serde_bytes")]
        nonce_d: Vec<u8>,
        #[serde(with = "serde_bytes")]
        nonce_l: Vec<u8>,
        #[serde(with = "serde_bytes")]
        sig_l: Vec<u8>,
    },
    Confirm {
        #[serde(with = "serde_bytes")]
        nonce_l: Vec<u8>,
        #[serde(with = "serde_bytes")]
        sig_d: Vec<u8>,
    },
}

// ---- Hello 捎带的通告(§2;刻意不加顶层 ctl 变体) ----

/// `Msg::Hello.lan` 的载荷:本设备的验证钥 + 单调通告序号 + 可选监听落点。
///
/// **pubkey = 本设备既有 Ed25519 设备鉴权钥的验证钥**(不新造密钥)。新版设备一律带
/// `Some(LanAd)`;开监听的才带 `listen: Some`(手机恒 `None`,§13 不做手机监听)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LanAd {
    #[serde(with = "serde_bytes")]
    pub pubkey: Vec<u8>,
    /// 持久单调通告序号(§2;**仅本地广告正式刷新时递增**,收对端 Hello 绝不递增)。
    pub ad_seq: u64,
    pub listen: Option<LanListen>,
}

/// 监听落点(§2:addrs ≤ [`MAX_LISTEN_ADDRS`],通告侧只写私网 IPv4 文本形)。
///
/// **收端的契约是「有界原文入缓存、拨号时过滤」**(codex L-b 审 L4 的取舍):
/// [`merge_peer_ad`] 只管条数、单条文本长度([`MAX_ADDR_TEXT`])与端口非 0,不校验每条
/// 是否真是私网 IPv4——那一刀由 [`check_candidate`] 在拨号时逐条落下(公网/环回/组播/
/// 非直连子网全拒)。**刻意不在 merge 处拒整枚通告**:一条看不懂的地址(如将来的 IPv6
/// 候选)不该让同一枚通告里的合法 IPv4 一起作废。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LanListen {
    pub port: u16,
    pub addrs: Vec<String>,
}

/// `sync_meta` 键 `lan_peer:<device_id>` 的值(CBOR;**设备本地、永不同步、boot 不
/// 导入**)。pubkey 首见钉住不覆盖写,listen/received_at 只随 ad_seq 推进而更新。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LanPeerAd {
    /// **私有**(codex L-b 二审):公开它,「[`Self::usable_pubkey`] 是唯一读口」就只是
    /// 约定——L-c 照样能直接读 `.pubkey` 塞进 [`IntroGate`],把冲突禁用位绕过去。
    #[serde(with = "serde_bytes")]
    pubkey: Vec<u8>,
    /// **同 id 异钥冲突已发生过 → 该对端直连永久禁用,粘滞**(L-b 实现审 M3)。
    /// 只增不减:随缓存一起落库,重启仍禁用;此后连原钥的新通告也不解封——解封只有
    /// 换 device_id 或走纪元轮换。建模在记录里而不是只当一次性返回值,是因为「L-c 记得
    /// 另开一个持久禁用键」这种自律迟早会漏。`serde(default)` 让 0.2.24 之前落的旧记录
    /// (无此字段)读成 `false`,不必迁移。
    #[serde(default)]
    key_conflict: bool,
    pub ad_seq: u64,
    pub listen: Option<LanListen>,
    /// 收到该通告时的本机墙钟毫秒([`LISTEN_TTL_MS`] 的起点)。
    pub received_at: u64,
}

impl LanPeerAd {
    /// 可用于握手验签的对端验证钥:冲突禁用后恒 `None`。**[`IntroGate::peer_pubkey`] 与
    /// 拨号侧的唯一读口**——字段私有,所以这不是纪律而是编译期事实。
    pub fn usable_pubkey(&self) -> Option<[u8; 32]> {
        if self.key_conflict {
            return None;
        }
        self.pubkey.as_slice().try_into().ok()
    }

    /// 是否已因同 id 异钥被禁用(诊断/UI 用;判「能不能建链」请用 [`Self::usable_pubkey`])。
    pub fn is_disabled(&self) -> bool {
        self.key_conflict
    }
}

/// 帧的来路(§2/L1)。**由 socket 所有者构造,绝不取自对端字段**,解密后全程携带:
/// 公钥/地址缓存只认 [`Ingress::RelayDeliver`](服务器已鉴权 `from` + AAD 双保险)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ingress {
    RelayDeliver,
    LanFrame,
}

// ---- 错误面(全部 = 静默关 + 诊断计数) ----

#[derive(Debug, PartialEq, Eq)]
pub enum LanError {
    /// 字节不是合法 LanWire(对端漂移或陌生服务)。
    Codec,
    /// 帧体超上限(pre-auth 4 KiB / 数据面 1 MiB)。
    TooLarge(usize),
    /// `Intro.ver` ≠ [`LAN_VER`](advisory 能力轴,无 skew UI)。
    Version(u64),
    /// 与当前步骤不符 / 状态机已死 / 字段形态不合。
    Protocol(&'static str),
    /// MAC 零命中:没有任何 LanReady 空间认这枚 Intro(fail-closed)。
    NoMatch,
    /// MAC 多命中:绝不「取第一个」(fail-closed,§4 步骤 1)。
    Ambiguous,
    /// 重复抑制缓存命中((from, nonce_d) 已见,「花掉即花掉」)。
    Duplicate,
    /// 重复抑制缓存已满:拒新 Intro(fail-closed,只影响直连)。
    DupCacheFull,
    /// 无缓存公钥:不 TOFU、不建链,等权威路收敛(§2 定向回 Hello)。
    NoPeerKey,
    /// 该空间与该对端已有活跃链(同对端恒单活跃写者,§7)。
    LinkExists,
    /// lan 域密文解不开(钥/AAD 方向/账户不符,或搅局帧)。
    Sealed,
    /// nonce 回显不符(新鲜性/交错会话)。
    NonceMismatch,
    /// Ed25519 严格验签不过(坏签名 / 跨会话搬运 / 角色反射)。
    BadSignature,
    /// 材料形态不合(长度 / ULID / 非法曲线点)。
    Material(&'static str),
}

impl std::fmt::Display for LanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LanError::Codec => write!(f, "局域网帧无法解码"),
            LanError::TooLarge(n) => write!(f, "局域网帧超上限({n} 字节)"),
            LanError::Version(v) => write!(f, "局域网协议版本不符(对端 {v})"),
            LanError::Protocol(w) => write!(f, "局域网握手乱序:{w}"),
            LanError::NoMatch => write!(f, "局域网 Intro 无匹配空间"),
            LanError::Ambiguous => write!(f, "局域网 Intro 多空间命中(拒)"),
            LanError::Duplicate => write!(f, "局域网 Intro 重复(已抑制)"),
            LanError::DupCacheFull => write!(f, "局域网重复抑制缓存已满"),
            LanError::NoPeerKey => write!(f, "尚未从服务器鉴权路学得该设备的验证钥"),
            LanError::LinkExists => write!(f, "该对端已有活跃直连链路"),
            LanError::Sealed => write!(f, "局域网握手密文解不开"),
            LanError::NonceMismatch => write!(f, "局域网握手 nonce 回显不符"),
            LanError::BadSignature => write!(f, "局域网握手签名验证不过"),
            LanError::Material(w) => write!(f, "局域网握手材料不合法:{w}"),
        }
    }
}

// ---- 编解码(§3:u32 BE ‖ CBOR) ----

/// 链路阶段:决定帧上限。**刻意不让调用方裸传 `usize`**(codex L-b 审 M4:传错一个
/// 数就突破全局 1 MiB 不变量),只能在这两个语义之间选。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramePhase {
    /// 握手完成前(Intro/Accept/Confirm)。规格 §3 钉的是「首帧 ≤4 KiB」,实现把它
    /// 收紧到握手期每帧——三种握手帧的材料都是定长的百字节级,零代价缩攻击面。
    PreAuth,
    /// 握手已建链:数据面与心跳。
    Established,
}

impl FramePhase {
    pub fn max_body(self) -> usize {
        match self {
            FramePhase::PreAuth => LAN_PREAUTH_FRAME_MAX,
            FramePhase::Established => LAN_FRAME_MAX,
        }
    }
}

/// CBOR 帧体(黄金向量焊死这一层)。
pub fn encode_wire(wire: &LanWire) -> Vec<u8> {
    let mut buf = Vec::new();
    ciborium::into_writer(wire, &mut buf).expect("CBOR 编码进内存 Vec 无失败路径");
    buf
}

/// 上线字节:`u32 BE 长度 ‖ CBOR 帧体`。超 [`LAN_FRAME_MAX`] = 本机 bug,响亮 Err
/// (调用方断链,绝不截断后发半帧)。
pub fn frame_bytes(wire: &LanWire) -> Result<Vec<u8>, LanError> {
    let body = encode_wire(wire);
    if body.len() > LAN_FRAME_MAX {
        return Err(LanError::TooLarge(body.len()));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// **分配前**判长度前缀(codex L-b 审 M4):读端拿到 4 字节前缀就先过这道闸,别照着
/// 对端给的数字去 `Vec::with_capacity`——u32 能声明 4 GiB,等读满再查上限已经晚了。
/// 双闸:阶段上限 ∧ 绝对 [`LAN_FRAME_MAX`];0 长度帧也拒(CBOR 至少一字节)。
pub fn checked_body_len(prefix: [u8; 4], phase: FramePhase) -> Result<usize, LanError> {
    let n = u32::from_be_bytes(prefix) as usize;
    if n == 0 {
        return Err(LanError::Codec);
    }
    if n > phase.max_body() || n > LAN_FRAME_MAX {
        return Err(LanError::TooLarge(n));
    }
    Ok(n)
}

/// 解一帧帧体(长度已由 [`checked_body_len`] 过闸;此处再查一遍是纵深)。
///
/// **严格「一帧一个值」**(codex L-b 审 L5):CBOR 解出一个值后必须**恰好耗尽** body,
/// 尾随垃圾一律拒——否则协议的接受集大于黄金向量定义的那一个,别语言的严格 decoder
/// 与本端互操作时会分叉。
pub fn decode_wire(body: &[u8], phase: FramePhase) -> Result<LanWire, LanError> {
    if body.len() > phase.max_body() || body.len() > LAN_FRAME_MAX {
        return Err(LanError::TooLarge(body.len()));
    }
    let mut cursor = std::io::Cursor::new(body);
    let wire: LanWire = ciborium::from_reader(&mut cursor).map_err(|_| LanError::Codec)?;
    if cursor.position() as usize != body.len() {
        return Err(LanError::Codec);
    }
    Ok(wire)
}

/// 数据面地址校验(§3):`from` 必须 == 握手绑定并验过签的链路对端(传输层权威值),
/// `to` 必须是本机 device_id 或广播;不符整帧拒收。
pub fn check_frame_addr(
    link_peer: &str,
    self_device: &str,
    from: &str,
    to: &str,
) -> Result<(), LanError> {
    if from != link_peer {
        return Err(LanError::Protocol("Frame.from 不是本链路对端"));
    }
    if to != self_device && to != BROADCAST {
        return Err(LanError::Protocol("Frame.to 不是本机也不是广播"));
    }
    Ok(())
}

// ---- 唯一 transcript(§4,评审二轮 M1;字段序恒 D 前 L 后) ----

/// `mac = HMAC-SHA256(K_mac, CBOR[label, LAN_VER, account, D, L, nonce_d])`。
/// account 与 L 不上明文,由验证方代入自己的空间材料重算(§4)。
pub fn intro_mac(
    k_mac: &[u8; 32],
    account_id: &str,
    d: &str,
    l: &str,
    nonce_d: &[u8],
) -> [u8; 32] {
    let mut buf = Vec::new();
    ciborium::into_writer(
        &(INTRO_MAC_LABEL, LAN_VER, account_id, d, l, Bytes::new(nonce_d)),
        &mut buf,
    )
    .expect("CBOR 编码进内存 Vec 无失败路径");
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(k_mac).expect("HMAC 任意钥长");
    mac.update(&buf);
    mac.finalize().into_bytes().into()
}

/// `T = CBOR[label, LAN_VER, account, D, L, nonce_d, nonce_l]`(§4 的唯一 transcript)。
/// 交错会话 / UKS / 签名搬运全由它封死:换账户、换 D‖L、换任一 nonce 都得不同 T。
fn transcript(account_id: &str, d: &str, l: &str, nonce_d: &[u8], nonce_l: &[u8]) -> Vec<u8> {
    let mut buf = Vec::new();
    ciborium::into_writer(
        &(
            HS_LABEL,
            LAN_VER,
            account_id,
            d,
            l,
            Bytes::new(nonce_d),
            Bytes::new(nonce_l),
        ),
        &mut buf,
    )
    .expect("CBOR 编码进内存 Vec 无失败路径");
    buf
}

/// 被签字节 `CBOR[T, role]`:**T 原样嵌为内层数组**(不是它的编码字节串)。
/// 手工拼字节(而非再走 serde)才能让「T 只算一次」与「嵌套形态」同时成立。
fn sig_payload(t: &[u8], role: &str) -> Vec<u8> {
    debug_assert!(role.len() == 1, "角色尾恒单字符(D/L)");
    let mut out = Vec::with_capacity(1 + t.len() + 2);
    out.push(0x82); // array(2)
    out.extend_from_slice(t);
    out.push(0x61); // text(1)
    out.extend_from_slice(role.as_bytes());
    out
}

/// `link_id = SHA-256(T)`——**T 的编码字节直接做哈希,不像 `sig_payload` 那样再套一层
/// CBOR 数组**(规格 §7 原写「Hash(CBOR[T])」,照字面会算成 `SHA256(0x81‖T)`;已同轮
/// 改稿钉成这一种。两侧算不出同一把尺 = §7 要避免的双断,别端实现照黄金向量对拍)。
/// 用途 = §7 glare 同方向多链的共同尺:双方同有 transcript,
/// 字典序最小者胜——两侧拿同一把尺比 incumbent 与 candidate,不会「各关各的」双断)。
fn link_id(t: &[u8]) -> [u8; 32] {
    Sha256::digest(t).into()
}

fn sign(seed: &[u8; 32], payload: &[u8]) -> [u8; 64] {
    SigningKey::from_bytes(seed).sign(payload).to_bytes()
}

/// Ed25519 **严格**验签 + 合法曲线点解析(§4:小阶点/非规范 R 一律拒)。
fn verify(pubkey: &[u8; 32], payload: &[u8], sig: &[u8]) -> Result<(), LanError> {
    let vk = VerifyingKey::from_bytes(pubkey).map_err(|_| LanError::BadSignature)?;
    let sig: [u8; 64] = sig.try_into().map_err(|_| LanError::BadSignature)?;
    vk.verify_strict(payload, &Signature::from_bytes(&sig))
        .map_err(|_| LanError::BadSignature)
}

fn fresh_nonce() -> [u8; NONCE_LEN] {
    let mut n = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut n);
    n
}

fn lan_addr<'a>(account_id: &'a str, from: &'a str, to: &'a str) -> FrameAddr<'a> {
    FrameAddr { account_id, from_device: from, to, domain: Domain::Lan }
}

fn seal_lan(k_acc: &[u8; 32], account_id: &str, from: &str, to: &str, msg: &LanMsg) -> Vec<u8> {
    crypto::seal_msg(k_acc, &lan_addr(account_id, from, to), msg)
}

fn open_lan(
    k_acc: &[u8; 32],
    account_id: &str,
    from: &str,
    to: &str,
    blob: &[u8],
) -> Result<LanMsg, LanError> {
    match crypto::open_msg::<LanMsg>(k_acc, &lan_addr(account_id, from, to), blob) {
        Ok(m) => Ok(m),
        Err(OpenError::Codec) => Err(LanError::Protocol("lan 域密文里不是合法 LanMsg")),
        Err(_) => Err(LanError::Sealed),
    }
}

fn nonce32(v: &[u8], what: &'static str) -> Result<[u8; NONCE_LEN], LanError> {
    v.try_into().map_err(|_| LanError::Material(what))
}

// ---- 重复抑制缓存(§4 步骤 1 / §10) ----

/// 每空间一只:`(from, nonce_d)` 见过即拒。**不是完整防重放**(Intro 无时间戳 = 刻意
/// 不引入时钟依赖):被捕获的 Intro 在 TTL 后可再诱出一帧 Accept + 占一个 ≤2s 的后置
/// 槽,由 §10 限速与槽上限兜底,残余已记入 §9。
///
/// 条目**一经登记保留到 TTL,不因握手失败提前删**(「花掉即花掉」)。满 = 拒新 Intro。
///
/// **时间轴 = 单调毫秒刻度,不是墙钟**(codex L-b 审 L6):L-c 必须喂单调源
/// (`Instant` 起点的差值)。墙钟回拨会让条目远超 10 分钟不过期,满缓存就长期拒新 Intro
/// ——白送一个局域网可用性 DoS;握手态本就是内存态、无跨重启需求,没必要背时钟跳变。
#[derive(Debug, Default)]
pub struct DupCache {
    /// (from, nonce_d) → 到期刻度(单调 ms)。
    seen: HashMap<(String, [u8; NONCE_LEN]), u64>,
}

impl DupCache {
    pub fn new() -> DupCache {
        DupCache { seen: HashMap::new() }
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    /// 未见 = 登记并 `Ok`;已见 = [`LanError::Duplicate`];满 = [`LanError::DupCacheFull`]。
    /// 每次调用先清过期(≤1024 条 × ≤10/s,扫一遍的成本可忽略)。
    ///
    /// `now_ms` = **单调**刻度(见类型注释)。
    pub fn check_and_register(
        &mut self,
        from: &str,
        nonce_d: &[u8; NONCE_LEN],
        now_ms: u64,
    ) -> Result<(), LanError> {
        self.seen.retain(|_, expire| *expire > now_ms);
        let key = (from.to_string(), *nonce_d);
        if self.seen.contains_key(&key) {
            return Err(LanError::Duplicate);
        }
        if self.seen.len() >= DUP_CACHE_CAP {
            return Err(LanError::DupCacheFull);
        }
        // 溢出无实际路径(单调刻度 + 10 分钟);饱和加法免得算术 panic 变成拒服务。
        self.seen.insert(key, now_ms.saturating_add(DUP_CACHE_TTL_MS));
        Ok(())
    }
}

// ---- 权威名册闸(identity-plan §5.11;367 第②笔) ----

/// **每空间一枚的直连准入闸**:把服务器下发的权威名册投影成 device-id 集合,拿它判
/// 「这台对端还准不准直连」。
///
/// ```text
/// None      => 放行(从没收到过名册 / 会话已收场 / 服务器连不上)
/// Some(set) => 对端必须在 set 里,否则不建链、已建的拆掉
/// ```
///
/// ⛔ **`None` 绝不许被折成空集合**(§5.11):那会把 fail-open 当场翻成「谁都不许连」,
/// 而「路由器断了外网也照样同步」是直连的招牌承诺。两者在类型上分得开,这个区分**就是**
/// 那条规则的可执行面(测里有一红一绿对照)。反过来 `Some(空集)` 是服务器**真说了**空,
/// 照规则挡住所有人 —— 客户端不复算服务端「`admins` 非空 ⇒ 名册非空」那条不变量
/// (371 那条纪律:判据只许有一份,在服务器那边)。
///
/// ⚠ **它是每空间的**,不是 app 级的:device_id 是「设备 × 空间」粒度,拿甲空间的名册
/// 去判乙空间的对端就是张冠李戴(§5.11)。类型封不了这一格 —— 封它的是宿主给它的位置
/// (每空间一枚引擎槽 / 准入表按 space_id 分条),故那两处各欠一只多空间隔离测。
///
/// **不落盘**(§5.11 规则 3):纯内存态,没有任何持久化入口,故「进程重开且服务器连不上
/// 时这道闸不在」是结构事实。
///
/// **上界**:[`RosterGate::apply_roster`] 是 O(N log N)、[`RosterGate::allows`] 是
/// O(log N),N = 名册条数。服务端把 N 闸在 [`sync_proto::MAX_ROSTER_DEVICES`] = 32。
/// ⚠ **客户端刻意不另设条数闸**:369 起 `RosterSched.roster` 已经无闸存着同一份数据,
/// 这里再加一道就是同一条规则的第二份描述、而且两份必然漂(first-draft-checklist 14)。
/// 客户端这一侧的真实上界仍是既有的 WS 帧 1 MiB(约 24k 条)。要加得在 `on_roster` 那
/// **一处**入口连 `RosterSched` 一起改 —— 记进可优化项,不在本笔顺手做。
#[derive(Debug, Default)]
pub struct RosterGate {
    /// `None` = 不知道。⛔ **别给它加 `unwrap_or_default()` 一类的读法。**
    allowed: Option<BTreeSet<String>>,
}

impl RosterGate {
    /// **安全判据**:这台对端此刻准直连吗。`None` ⇒ 恒 `true`(fail-open)。
    ///
    /// 三道闸(入站 handoff 前 / 出站 handoff 前 / 链路集最终 install)问的都是这一句,
    /// 且都问**当前**的它 —— §5.11「判据与触发器是两件事」的判据那一半。
    ///
    /// ⚠ **不问「本机在不在名册里」**:判据只关于对端。本机被别人移除时服务器直接
    /// `Abort` 这条连接,本会话随即收场、三处 gate 一起清回 `None`;在客户端另判一次
    /// 等于把服务器的不变量抄第二遍。
    pub fn allows(&self, peer: &str) -> bool {
        allows_in(&self.allowed, peer)
    }

    /// **唯一写入口**(§5.11:内容比较由 gate 自己做,不许调用方先算个 bool 传进来)。
    ///
    /// `None` = 退回 fail-open,故会话收场那次清场也走这一句 —— **不另开 `clear()`**:
    /// 一条规则一个正式子,而且「`Some → None` 谁也不 abort」因此成了同一个算式的推论,
    /// 不是收场路径上一条要人记得的例外(§5.11-⑧)。
    ///
    /// 投影(丢掉 `admin` 标记、去重、排序)是私有实现细节,外面拿不到半成品 ——
    /// 于是「admin 标记与 revision 不属于 LAN 判据」是结构事实,不是纪律(§5.11 收窄④)。
    pub fn apply_roster(&mut self, roster: Option<&[RosterEntry]>) -> NewlyDenied {
        let after: Option<BTreeSet<String>> =
            roster.map(|r| r.iter().map(|e| e.device.clone()).collect());
        let before = std::mem::replace(&mut self.allowed, after.clone());
        NewlyDenied { before, after }
    }
}

/// [`RosterGate::apply_roster`] 交回的**判据**(不是名单)。
///
/// ⛔ `#[must_use]`(§5.11 点名:算出来却没人用的值,285 那条的反面)。
///
/// ⭐ **§5.11 那张四行表在这里是一句话的推论,不是四个分支**:
///
/// ```text
/// hits(peer) = 换之前放行(peer) ∧ 换之后不放行(peer)
/// ```
///
/// | gate 变化 | 表说 abort 谁 | 这句话算出来的 |
/// |---|---|---|
/// | `None → Some(S)` | 已绑定但不在 S 里的 | 旧的恒放行 ⇒ 命中 ⟺ `peer ∉ S` |
/// | `Some(A) → Some(B)` | 只 `A − B` | 命中 ⟺ `peer ∈ A ∧ peer ∉ B` |
/// | `Some(_) → None` | 谁也不 | 新的恒放行 ⇒ 恒不命中 |
/// | 只多设备 / 只改 admin / 同内容新 revision | 不 abort | 投影后 `A ⊆ B` 或 `A = B` ⇒ 差集空 |
///
/// 写成四个分支的话,「只改 admin 不算移除」这类阴性性质要靠每个分支各自维护;写成这
/// 一句,它们全是同一个算式的推论 —— §5.14-3c⑤ 那只阴性对照因此测的是**推论**,而不是
/// 另一条并行实现。
///
/// **拥有式,不借 gate**:调用方要一手拿着它、一手改链路集与准入表(那两处都要 `&mut`),
/// 借着 gate 就借不动了。代价 = 克隆一份 ≤32 条的集合。
#[must_use]
#[derive(Debug)]
pub struct NewlyDenied {
    before: Option<BTreeSet<String>>,
    after: Option<BTreeSet<String>>,
}

impl NewlyDenied {
    /// 这台对端**是被这次名册变更新拒掉的**吗(⇒ 该拆链 / 该 abort 它那只在飞握手)。
    ///
    /// ⚠ 「此刻不准连」与「这次才变得不准连」是两件事:本来就不在册的对端只满足前者,
    /// 它没有链要拆、也没有握手要 abort。**安全判据恒是 [`RosterGate::allows`]**,
    /// 这一句只回答「这次要动谁」(§5.11:generation 那半只是触发器,不参与判定)。
    pub fn hits(&self, peer: &str) -> bool {
        allows_in(&self.before, peer) && !allows_in(&self.after, peer)
    }
}

/// 闸的判定本体(`None` = fail-open)。**两个类型共用这一句** —— 各写一遍就是同一条
/// 规则的第二份描述,而它俩必须永远一致([`NewlyDenied::hits`] 正是拿两侧的它作差)。
fn allows_in(set: &Option<BTreeSet<String>>, peer: &str) -> bool {
    match set {
        None => true,
        Some(s) => s.contains(peer),
    }
}

// ---- 监听侧准入(§4 步骤 1 / §6 准入表) ----

/// 准入表的材料面(§6:app 级单例监听器持 space → 条目;generation 双检与 handoff
/// 归 L-c)。每空间一条——**device_id 是每空间各自的身份**,故 `self_device` 随空间。
#[derive(Debug, Clone)]
pub struct LanAdmit<'a> {
    pub space_id: &'a str,
    pub account_id: &'a str,
    pub k_acc: &'a [u8; 32],
    /// 本机设备签名种子(`sync_meta.device_key`;每空间各自一把)。
    pub self_seed: &'a [u8; 32],
    /// 本空间的本机 device_id(即握手里的 L)。
    pub self_device: &'a str,
}

/// 拨入首帧的字段面(形态已校验;`resolve_intro` 与 [`LanListener::accept`] 共用)。
#[derive(Debug, Clone, Copy)]
pub struct Intro<'a> {
    /// 拨入方 device_id(D)。
    pub from: &'a str,
    pub nonce_d: &'a [u8; NONCE_LEN],
    pub mac: &'a [u8; NONCE_LEN],
}

impl<'a> Intro<'a> {
    /// 形态校验:必须是 Intro 变体、ver 相符、from 是合法 ULID、nonce/mac 恰 32B。
    pub fn parse(wire: &'a LanWire) -> Result<Intro<'a>, LanError> {
        let LanWire::Intro { ver, from, nonce_d, mac } = wire else {
            return Err(LanError::Protocol("首帧不是 Intro"));
        };
        if *ver != LAN_VER {
            return Err(LanError::Version(*ver));
        }
        if !is_ulid(from) {
            return Err(LanError::Material("Intro.from 不是合法 ULID"));
        }
        Ok(Intro {
            from,
            nonce_d: nonce_d.as_slice().try_into().map_err(|_| {
                LanError::Material("Intro.nonce_d 长度不是 32B")
            })?,
            mac: mac
                .as_slice()
                .try_into()
                .map_err(|_| LanError::Material("Intro.mac 长度不是 32B"))?,
        })
    }
}

/// 「全表恰一命中」这件事的**凭据**(codex L-b 审 M1)。字段私有 + 构造函数只在
/// [`resolve_intro`] 里 → 本模块外造不出来,[`LanListener::accept`] 只收它:L-c 想建链
/// 就绕不过唯一性闸(原先两步都公开,误写成「取第一个匹配就 accept」是现实风险)。
///
/// 它借着准入表活(`'e`),所以「resolve 完再重排/换代准入表」这条 TOCTOU 由借用检查器
/// 直接堵死——凭据在手期间那张表连改都改不动。
/// **凭据同时绑住被解析的那枚 Intro**(codex L-b 二审):只绑 admit 的话
/// `accept(&resolve(intro_a), intro_b)` 仍写得出来——凭据证明的是 intro_a 全表唯一,
/// 而 accept 里的 MAC 复验只能证明 intro_b 匹配选中的那个空间,「过了全表唯一性扫描」
/// 这句话就没人担保了。绑在一起后,建链入口连「换一枚 Intro」都无处可换。
#[derive(Debug)]
pub struct ResolvedIntro<'e, 'a, 'w> {
    admit: &'e LanAdmit<'a>,
    intro: Intro<'w>,
    index: usize,
}

impl<'e, 'a, 'w> ResolvedIntro<'e, 'a, 'w> {
    /// 命中的空间(L-c 拿它取 generation / 链路集 / 该空间的 DupCache)。
    pub fn space_id(&self) -> &'a str {
        self.admit.space_id
    }
    /// 命中条目在准入表里的下标。
    pub fn index(&self) -> usize {
        self.index
    }
    /// 拨入方 device_id(L-c 建链前查链路集/公钥缓存要用)。
    pub fn peer(&self) -> &'w str {
        self.intro.from
    }
}

/// 逐 LanReady 空间代入 (account, L=自身) 重算 MAC:**恰一命中才继续,零命中或多命中
/// 一律拒**(§4 步骤 1 的 fail-closed,绝不「取第一个」)。
///
/// 全表扫完才判定——多命中要靠扫完才看得见,顺带免了「早返回」的时序侧信道。**不跳过
/// 任何条目**(严格「逐全部 LanReady 空间代入」):就算某空间的本机 id 恰等于 `intro.from`,
/// 也照算照数,自连由 [`LanListener::accept`] 显式拒。
pub fn resolve_intro<'e, 'a, 'w>(
    entries: &'e [LanAdmit<'a>],
    intro: &Intro<'w>,
) -> Result<ResolvedIntro<'e, 'a, 'w>, LanError> {
    let mut hit: Option<usize> = None;
    let mut hits = 0usize;
    for (i, e) in entries.iter().enumerate() {
        let want = intro_mac(
            &crypto::lan_mac_key(e.k_acc),
            e.account_id,
            intro.from,
            e.self_device,
            intro.nonce_d,
        );
        if ct_eq(&want, intro.mac) {
            hits += 1;
            hit = Some(i);
        }
    }
    match (hits, hit) {
        (1, Some(i)) => Ok(ResolvedIntro { admit: &entries[i], intro: *intro, index: i }),
        (0, _) => Err(LanError::NoMatch),
        _ => Err(LanError::Ambiguous),
    }
}

/// 调用方代入的两条链路级事实(§4 步骤 1 的后两闸)。
#[derive(Debug, Clone, Copy)]
pub struct IntroGate<'a> {
    /// `lan_peer:<from>` 里钉住的验证钥;`None` = 从未经权威路学得 → 不 TOFU、不建链
    /// (活性由 §2 定向回 Hello 补)。**同 id 异钥被禁用的对端,调用方在此传 `None`**。
    pub peer_pubkey: Option<&'a [u8; 32]>,
    /// 该空间与该对端是否已有活跃链(同对端恒单活跃写者,§7)。
    pub peer_link_active: bool,
}

/// 握手终局:链路已建。**握手完成 ≠ 可路由**——还要过 §7 glare 仲裁(peer-map 锁内、
/// 以 [`Self::link_id`] 当同方向多链的共同尺),败者在发出任何 `Frame` 前关闭。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanEstablished {
    /// 已验过签的链路对端 device_id(数据面 `Frame.from` 的权威值、quarantine 的
    /// `relay_from` 取值)。
    pub peer: String,
    pub link_id: [u8; 32],
}

// ---- 监听方(L)状态机 ----

enum ListenerState {
    /// 已发 Accept,等 Confirm。
    AwaitConfirm { t: Vec<u8>, nonce_l: [u8; NONCE_LEN] },
    /// 终局 / 已失败:后续任何帧恒 Err。
    Dead,
}

/// 监听方(§4 的 L)。构造即完成步骤 1-2(验 Intro → 出 Accept),之后只等 Confirm。
pub struct LanListener {
    account_id: String,
    k_acc: [u8; 32],
    self_device: String,
    peer_device: String,
    peer_pubkey: [u8; 32],
    state: ListenerState,
}

impl LanListener {
    /// §4 步骤 1-2。闸序照规格逐条:MAC(唯一命中由 [`ResolvedIntro`] 凭据担保,这里
    /// 对命中空间**复验一遍**是纵深)→ 重复抑制(登记即花掉)→ 缓存公钥 → 已有活跃链。
    ///
    /// 返回待发的 [`LanWire::Accept`];任何 `Err` = 静默关闭。
    pub fn accept(
        resolved: &ResolvedIntro<'_, '_, '_>,
        gate: &IntroGate<'_>,
        dup: &mut DupCache,
        now_ms: u64,
    ) -> Result<(LanListener, LanWire), LanError> {
        let admit = resolved.admit;
        let intro = &resolved.intro;
        if admit.self_device == intro.from {
            return Err(LanError::Protocol("Intro.from 是本机 device_id"));
        }
        let want = intro_mac(
            &crypto::lan_mac_key(admit.k_acc),
            admit.account_id,
            intro.from,
            admit.self_device,
            intro.nonce_d,
        );
        if !ct_eq(&want, intro.mac) {
            return Err(LanError::NoMatch);
        }
        dup.check_and_register(intro.from, intro.nonce_d, now_ms)?;
        let peer_pubkey = *gate.peer_pubkey.ok_or(LanError::NoPeerKey)?;
        if gate.peer_link_active {
            return Err(LanError::LinkExists);
        }
        let nonce_l = fresh_nonce();
        let t = transcript(
            admit.account_id,
            intro.from,
            admit.self_device,
            intro.nonce_d,
            &nonce_l,
        );
        // 监听方用本空间的设备私钥签(证明「持该 device_id 经权威路钉住的那把私钥」)。
        let sig_l = sign(admit.self_seed, &sig_payload(&t, ROLE_L));
        let blob = seal_lan(
            admit.k_acc,
            admit.account_id,
            admit.self_device,
            intro.from,
            &LanMsg::Accept {
                nonce_d: intro.nonce_d.to_vec(),
                nonce_l: nonce_l.to_vec(),
                sig_l: sig_l.to_vec(),
            },
        );
        Ok((
            LanListener {
                account_id: admit.account_id.to_string(),
                k_acc: *admit.k_acc,
                self_device: admit.self_device.to_string(),
                peer_device: intro.from.to_string(),
                peer_pubkey,
                state: ListenerState::AwaitConfirm { t, nonce_l },
            },
            LanWire::Accept { blob },
        ))
    }

    /// §4 步骤 3 的收端:解 Confirm → 回显核对 → 以缓存 pubkey[D] 严格验签 → 建链。
    pub fn on_confirm(&mut self, wire: &LanWire) -> Result<LanEstablished, LanError> {
        // **先置死再看帧**(codex L-b 审 M2):任何 Err 都必须让状态机终局,包括「收到
        // 的根本不是 Confirm」这一路——否则攻击者可以先塞一帧 Ping 制造协议错误、再补
        // 合法 Confirm 完成握手,「一次失败即死」的契约就只剩口头。
        let (t, nonce_l) = match std::mem::replace(&mut self.state, ListenerState::Dead) {
            ListenerState::AwaitConfirm { t, nonce_l } => (t, nonce_l),
            ListenerState::Dead => return Err(LanError::Protocol("握手已终局")),
        };
        let LanWire::Confirm { blob } = wire else {
            return Err(LanError::Protocol("此刻只该收 Confirm"));
        };
        // AAD from=D、to=L:方向反射(拿自己发的 Accept 回灌)在此解不开。
        let msg = open_lan(
            &self.k_acc,
            &self.account_id,
            &self.peer_device,
            &self.self_device,
            blob,
        )?;
        let LanMsg::Confirm { nonce_l: echo, sig_d } = msg else {
            return Err(LanError::Protocol("lan 密文里不是 Confirm"));
        };
        if !ct_eq(&echo, &nonce_l) {
            return Err(LanError::NonceMismatch);
        }
        verify(&self.peer_pubkey, &sig_payload(&t, ROLE_D), &sig_d)?;
        Ok(LanEstablished { peer: self.peer_device.clone(), link_id: link_id(&t) })
    }
}

// ---- 拨入方(D)状态机 ----

enum DialerState {
    AwaitAccept,
    Dead,
}

/// 拨入方(§4 的 D)。[`Self::start`] 出 Intro,[`Self::on_accept`] 出 Confirm + 建链。
pub struct LanDialer {
    account_id: String,
    k_acc: [u8; 32],
    self_seed: [u8; 32],
    self_device: String,
    peer_device: String,
    peer_pubkey: [u8; 32],
    nonce_d: [u8; NONCE_LEN],
    state: DialerState,
}

/// 拨号材料(§7:调用方拨号前已确认缓存里有 `{pubkey, listen}` 且 listen 未逾期)。
#[derive(Debug, Clone, Copy)]
pub struct DialParams<'a> {
    pub account_id: &'a str,
    pub k_acc: &'a [u8; 32],
    /// 本机设备签名种子(`sync_meta.device_key`)。
    pub self_seed: &'a [u8; 32],
    /// 本空间的本机 device_id(即 D)。
    pub self_device: &'a str,
    /// 目标 device_id(即 L)。
    pub peer_device: &'a str,
    /// 目标的验证钥——**只经服务器鉴权路学得并首见钉住**(§2)。
    pub peer_pubkey: &'a [u8; 32],
}

impl LanDialer {
    /// 出首帧 Intro:MAC 绑 (账户, D, L, nonce_d) —— 目标绑定即「IP 易主到别台合法
    /// 设备」时对方算不出同一枚 MAC,响亮失败等新通告,不静默改绑(§4)。
    pub fn start(p: &DialParams<'_>) -> (LanDialer, LanWire) {
        let nonce_d = fresh_nonce();
        let mac = intro_mac(
            &crypto::lan_mac_key(p.k_acc),
            p.account_id,
            p.self_device,
            p.peer_device,
            &nonce_d,
        );
        let wire = LanWire::Intro {
            ver: LAN_VER,
            from: p.self_device.to_string(),
            nonce_d: nonce_d.to_vec(),
            mac: mac.to_vec(),
        };
        (
            LanDialer {
                account_id: p.account_id.to_string(),
                k_acc: *p.k_acc,
                self_seed: *p.self_seed,
                self_device: p.self_device.to_string(),
                peer_device: p.peer_device.to_string(),
                peer_pubkey: *p.peer_pubkey,
                nonce_d,
                state: DialerState::AwaitAccept,
            },
            wire,
        )
    }

    /// §4 步骤 2 的收端 + 步骤 3 的发端:解 Accept → nonce_d 回显 → 以缓存 pubkey[L]
    /// 严格验签 → 回 Confirm 并建链。
    pub fn on_accept(&mut self, wire: &LanWire) -> Result<(LanWire, LanEstablished), LanError> {
        // 先置死再看帧(同 [`LanListener::on_confirm`],codex L-b 审 M2)。
        match std::mem::replace(&mut self.state, DialerState::Dead) {
            DialerState::AwaitAccept => {}
            DialerState::Dead => return Err(LanError::Protocol("握手已终局")),
        }
        let LanWire::Accept { blob } = wire else {
            return Err(LanError::Protocol("此刻只该收 Accept"));
        };
        // AAD from=L、to=D。
        let msg = open_lan(
            &self.k_acc,
            &self.account_id,
            &self.peer_device,
            &self.self_device,
            blob,
        )?;
        let LanMsg::Accept { nonce_d: echo, nonce_l, sig_l } = msg else {
            return Err(LanError::Protocol("lan 密文里不是 Accept"));
        };
        if !ct_eq(&echo, &self.nonce_d) {
            return Err(LanError::NonceMismatch);
        }
        let nonce_l = nonce32(&nonce_l, "Accept.nonce_l 长度不是 32B")?;
        let t = transcript(
            &self.account_id,
            &self.self_device,
            &self.peer_device,
            &self.nonce_d,
            &nonce_l,
        );
        verify(&self.peer_pubkey, &sig_payload(&t, ROLE_L), &sig_l)?;
        let sig_d = sign(&self.self_seed, &sig_payload(&t, ROLE_D));
        let blob = seal_lan(
            &self.k_acc,
            &self.account_id,
            &self.self_device,
            &self.peer_device,
            &LanMsg::Confirm { nonce_l: nonce_l.to_vec(), sig_d: sig_d.to_vec() },
        );
        Ok((
            LanWire::Confirm { blob },
            LanEstablished { peer: self.peer_device.clone(), link_id: link_id(&t) },
        ))
    }
}

// ---- 通告缓存的合并规则(§2:单一权威路 + 首见钉住 + 单调序号) ----

/// [`merge_peer_ad`] 的判定。**没有 `Err`**:通告是 advisory 字段,任何不合都只影响
/// 直连,绝不牵动这枚 Hello 的水位处理(§2「相同/更小序号只照常处理 Hello 水位」)。
#[derive(Debug, PartialEq)]
pub enum AdMerge {
    /// 不动缓存(LAN 来路 / 序号不新)——正常路径,带理由供诊断。
    Ignore(&'static str),
    /// 写 `lan_peer:<from>`。**唯一落库出口**(codex L-b 二审):首见 / 序号推进 / 冲突
    /// 禁用三种起因全走这一条,L-c 只有一个分支要接——「记得给 KeyConflict 也落一次库」
    /// 这种自律没有存在空间。起因只供诊断与 UI 分流。
    Store { record: LanPeerAd, cause: StoreCause },
    /// 通告形态不合(公钥长度 / 非法曲线点 / addrs 超限 / 端口 0)→ 忽略 + 诊断计数。
    Malformed(&'static str),
}

/// [`AdMerge::Store`] 的起因。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum StoreCause {
    /// 首见钉住。
    FirstSeen,
    /// `ad_seq` 推进 → 更新 listen 与 received_at。
    Advanced,
    /// 同 id 异钥 → **禁用该对端直连**,写回「原钉住的钥 + 禁用位」(新钥绝不覆盖写)。
    /// L-c 应把它转成常驻告警:同 id 异钥只能是攻击或克隆。
    KeyConflict,
}

/// §2 的缓存规则,一处一义:
/// * 只有 [`Ingress::RelayDeliver`] 到达的帧才写缓存(服务器已鉴权 `from` + AAD 双保险);
///   LAN 到达帧的 lan 字段**整体忽略**——否则同网攻击者可自证地址、绕过权威路。
/// * pubkey 首见钉住;异钥 = [`AdMerge::KeyConflict`]。
/// * **仅当 `ad_seq > 缓存值` 才更新 listen 与 `received_at`**:**本机已有水位时**,恶意中转重放旧 Hello
///   密文延不了旧地址的寿(它只剩本就拥有的流量 DoS);收到 `u64::MAX` 可钉住,其后
///   更小值不为「恢复可用」而收。
pub fn merge_peer_ad(
    cached: Option<&LanPeerAd>,
    ad: &LanAd,
    ingress: Ingress,
    now_ms: u64,
) -> AdMerge {
    if ingress == Ingress::LanFrame {
        return AdMerge::Ignore("LAN 来路的 lan 字段整体忽略(§2 单一权威路)");
    }
    // 已禁用的对端:**先于一切形态校验**返回(codex L-b 二审——放在公钥解析之后的话,
    // 已禁用 peer 发一枚畸形公钥会得到 Malformed 而不是 Ignore,与「此后一律 Ignore」
    // 的说法不符;安全上无差别,但说到做到)。
    if let Some(old) = cached {
        if old.key_conflict {
            return AdMerge::Ignore("该对端已因同 id 异钥禁用(粘滞,换 id 或纪元才解)");
        }
    }
    let pubkey: [u8; 32] = match ad.pubkey.as_slice().try_into() {
        Ok(k) => k,
        Err(_) => return AdMerge::Malformed("通告公钥长度不是 32B"),
    };
    if VerifyingKey::from_bytes(&pubkey).is_err() {
        return AdMerge::Malformed("通告公钥不是合法 Ed25519 曲线点");
    }
    // 公钥同一性判定**先于** listen 校验(L-b 审 M3):否则「异钥 + 畸形 listen」只报
    // Malformed,冲突被掩盖掉,禁用永不触发。
    if let Some(old) = cached {
        if !ct_eq(&old.pubkey, &pubkey) {
            return AdMerge::Store {
                record: LanPeerAd { key_conflict: true, ..old.clone() },
                cause: StoreCause::KeyConflict,
            };
        }
    }
    if let Some(listen) = &ad.listen {
        if listen.addrs.len() > MAX_LISTEN_ADDRS {
            return AdMerge::Malformed("通告地址条数超上限");
        }
        if listen.addrs.iter().any(|a| a.len() > MAX_ADDR_TEXT) {
            return AdMerge::Malformed("通告地址文本超上限");
        }
        if listen.port == 0 {
            return AdMerge::Malformed("通告端口为 0");
        }
    }
    let fresh = LanPeerAd {
        pubkey: pubkey.to_vec(),
        key_conflict: false,
        ad_seq: ad.ad_seq,
        listen: ad.listen.clone(),
        received_at: now_ms,
    };
    match cached {
        None => AdMerge::Store { record: fresh, cause: StoreCause::FirstSeen },
        // 公钥同一性已在上面判过(异钥/已禁用都已返回),这里只剩序号轴。
        Some(old) if ad.ad_seq > old.ad_seq => {
            AdMerge::Store { record: fresh, cause: StoreCause::Advanced }
        }
        Some(_) => AdMerge::Ignore("通告序号不新(旧 Hello 重放/重复投递)"),
    }
}

// ---- 本机通告序号(§2 + 三轮 L2:溢出与持久化纪律) ----

/// `sync_meta.lan_ad_seq` 的 canonical 解析:纯 ASCII 数字、无符号、无前导零
/// (「0」自身除外)、不越界。负号 / 前导 `+` / 前导零 / 越界一律拒(fail-fast——
/// 计数器是单调性的唯一凭据,宽进等于养出非规范形态)。
pub fn parse_ad_seq(raw: &str) -> Result<u64, String> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("lan_ad_seq 不是十进制无符号整数:{raw:?}"));
    }
    if raw.len() > 1 && raw.starts_with('0') {
        return Err(format!("lan_ad_seq 有前导零(非规范形):{raw:?}"));
    }
    raw.parse::<u64>().map_err(|_| format!("lan_ad_seq 越界:{raw:?}"))
}

/// 下一个通告序号:`checked_add`,到 `u64::MAX` 即**禁用本设备通告并报错、绝不回绕**
/// (回绕 = 收端「更小序号不收」会把本机永久钉死在旧地址上)。
///
/// 调用纪律(§2):**计数器落库成功才封发**——先发后落的崩溃窗口会让同一序号发两次
/// 不同 listen,收端只认第一枚。
pub fn next_ad_seq(cur: u64) -> Result<u64, String> {
    cur.checked_add(1)
        .ok_or_else(|| "lan_ad_seq 已到 u64::MAX:本设备局域网通告停用(绝不回绕)".to_string())
}

// ---- 候选过滤(§7:必须落在本机当前活动接口的直连子网内) ----

/// 本机一个活动接口的直连子网(L-c 由平台枚举填;**接口枚举的跨平台实现是 L-c 定点
/// 风险**)。`prefix > 32` 在构造处即拒,不许进过滤器。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalSubnet {
    /// 字段私有(codex L-b 审 L1):公开字段等于让调用方绕过 [`Self::new`] 造出
    /// `prefix > 32`,`mask()` 的移位当场 panic——平台枚举一出错就把网络输入路径变成
    /// 崩溃点。不变量由类型兑现,不靠注释。
    addr: Ipv4Addr,
    prefix: u8,
}

impl LocalSubnet {
    pub fn new(addr: Ipv4Addr, prefix: u8) -> Result<LocalSubnet, String> {
        if prefix > 32 {
            return Err(format!("子网前缀不合法:/{prefix}"));
        }
        Ok(LocalSubnet { addr, prefix })
    }

    pub fn addr(self) -> Ipv4Addr {
        self.addr
    }

    pub fn prefix(self) -> u8 {
        self.prefix
    }

    fn mask(self) -> u32 {
        if self.prefix == 0 {
            0
        } else {
            u32::MAX << (32 - self.prefix)
        }
    }

    fn contains(self, ip: Ipv4Addr) -> bool {
        (u32::from(ip) & self.mask()) == (u32::from(self.addr) & self.mask())
    }

    /// 该子网的网络地址与广播地址(/31、/32 无此语义 → None)。
    fn edges(self) -> Option<(Ipv4Addr, Ipv4Addr)> {
        if self.prefix >= 31 {
            return None;
        }
        let net = u32::from(self.addr) & self.mask();
        Some((Ipv4Addr::from(net), Ipv4Addr::from(net | !self.mask())))
    }
}

/// 候选被拒的理由(诊断计数 + 单测阴性对照的指认面)。
#[derive(Debug, PartialEq, Eq)]
pub enum CandidateReject {
    /// 不是合法 IPv4 文本形(IPv6 候选 v1 不做,§13)。
    NotIpv4,
    /// 0.0.0.0。
    Unspecified,
    /// 127/8。
    Loopback,
    /// 非 RFC1918 私网(公网 / 169.254 链路本地 / 100.64 CGNAT / 组播 / 全 1 广播)。
    NotPrivate,
    /// 本机自己的地址。
    SelfAddr,
    /// 落在本机某子网内但是该子网的网络地址。
    NetworkAddr,
    /// 同上,广播地址。
    BroadcastAddr,
    /// 不在本机任何活动接口的直连子网内(**不是裸 RFC1918 全段**:同号段陌生网络里
    /// 误拨会泄一帧 Intro,§9 已披露,故过滤要窄)。
    OutsideSubnets,
}

/// 单条通告地址 → 可拨 IP,或拒因。
pub fn check_candidate(
    text: &str,
    subnets: &[LocalSubnet],
) -> Result<Ipv4Addr, CandidateReject> {
    let ip: Ipv4Addr = text.parse().map_err(|_| CandidateReject::NotIpv4)?;
    if ip.is_unspecified() {
        return Err(CandidateReject::Unspecified);
    }
    if ip.is_loopback() {
        return Err(CandidateReject::Loopback);
    }
    if !ip.is_private() {
        return Err(CandidateReject::NotPrivate);
    }
    // 自身要跨全部接口比(只比命中子网那一枚会漏掉「多接口下同 IP 属另一张网卡」)。
    if subnets.iter().any(|s| s.addr == ip) {
        return Err(CandidateReject::SelfAddr);
    }
    if !subnets.iter().any(|s| s.contains(ip)) {
        return Err(CandidateReject::OutsideSubnets);
    }
    // 边界要对**每一个**命中子网都判,不是「取第一个」(codex L-b 审 L2):枚举顺序里
    // 先来个 /16、后面才是更具体的 /24 时,取第一个会把 /24 的广播地址当普通主机放行。
    // 逐个拒 = 与「最长前缀优先」的真实出接口同向,且不依赖枚举顺序。
    for sub in subnets.iter().copied().filter(|s| s.contains(ip)) {
        if let Some((net, bcast)) = sub.edges() {
            if ip == net {
                return Err(CandidateReject::NetworkAddr);
            }
            if ip == bcast {
                return Err(CandidateReject::BroadcastAddr);
            }
        }
    }
    Ok(ip)
}

/// `listen` 是否仍在 [`LISTEN_TTL_MS`] 内。**逾期 = 不拨**——这是 §0「断网可用」的
/// 诚实边界(长期与世隔绝后直连也需先见一次中转刷新通告)。
/// `received_at` 在未来(本机时钟回拨)照样算新鲜:钟走回来自会到期,不额外造机械。
pub fn listen_fresh(ad: &LanPeerAd, now_ms: u64) -> bool {
    now_ms.saturating_sub(ad.received_at) <= LISTEN_TTL_MS
}

/// 缓存条目 → 可拨候选。无 listen / 逾期 = 空;否则逐条过滤(顺序保通告序,拒因由
/// [`check_candidate`] 供诊断)。
pub fn dial_candidates(
    ad: &LanPeerAd,
    subnets: &[LocalSubnet],
    now_ms: u64,
) -> Vec<std::net::SocketAddrV4> {
    // 冲突禁用的对端一个候选都不给(与 [`LanPeerAd::usable_pubkey`] 同一条粘滞语义)。
    if ad.key_conflict {
        return vec![];
    }
    let Some(listen) = &ad.listen else { return vec![] };
    if listen.port == 0 || !listen_fresh(ad, now_ms) {
        return vec![];
    }
    listen
        .addrs
        .iter()
        .take(MAX_LISTEN_ADDRS)
        .filter_map(|a| check_candidate(a, subnets).ok())
        .map(|ip| std::net::SocketAddrV4::new(ip, listen.port))
        .collect()
}

/// **§7 一级规则(方向优先级)**:本机该不该向这台对端发起拨号。
///
/// 两侧代入的是**同一份事实**——「我在不在监听」既是各自的本地真相,也正是各自
/// `LanAd.listen` 通告出去的那一件——故正常态下同一对设备恒**只有一个方向**在拨;
/// glare 的主要来路(双向同时拨)在这一步就没了,peer-map 的二级规则(`link_id` 字典序,
/// §7)只用来收同方向的并发重试。
///
/// * **本机不监听**(手机壳 / 监听口没绑上)= 拨出专用端,**恒是合法方向**,哪怕本机
///   device_id 更大。少了这一条,「手机 id 大于桌面」时两边都不拨、直连永远起不来
///   (三轮 M3 点名的正是这个误杀)。
/// * 双方皆可监听:**小 device_id 发起**的方向优先。
///
/// 对端不监听不必在这里判:那种对端根本没有可拨的地址,[`dial_candidates`] 给空清单。
///
/// **短暂的两侧不一致是安全的**:本机刚绑上/刚丢掉监听口而通告还没发出去的窗口里,
/// 两边可能同时拨(二级规则收成一条)或都不拨(下一枚通告即自愈)——两种都不留坏态。
pub fn should_dial(self_listening: bool, self_device: &str, peer_device: &str) -> bool {
    !self_listening || self_device < peer_device
}

/// 通告侧:本机哪些地址值得写进 `LanListen.addrs`(仅私网 IPv4;多于
/// [`MAX_LISTEN_ADDRS`] 张网卡时取前 8——通告是 advisory,余下靠中转,L-c 记诊断)。
pub fn advertisable_addrs(subnets: &[LocalSubnet]) -> Vec<String> {
    subnets
        .iter()
        .map(|s| s.addr)
        .filter(|ip| ip.is_private() && !ip.is_loopback() && !ip.is_unspecified())
        .take(MAX_LISTEN_ADDRS)
        .map(|ip| ip.to_string())
        .collect()
}

#[cfg(test)]
mod tests;
