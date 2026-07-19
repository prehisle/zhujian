//! P2-f 配对 —— sync-protocol §6.1 的落实(新设备入账户的 SPAKE2 口令认证密钥交换)。
//!
//! sans-io 状态机,不持 socket:输入 = 对端经服务器盲桥(`pair_msg`)透传来的字节 +
//! 服务器事件(Joined/Registered),输出 = 待发盲桥字节与终局动作。P2-g 的传输层把
//! [`PairOutput`] 映射到信封(`ClientMsg::PairMsg/RegisterDevice`),把 `ServerMsg::
//! PairPeer{Joined}`/`Registered` 映射回 [`Opener::on_joined`]/[`Opener::on_registered`]。
//!
//! 协议(§6.1,消息序即线上纪律,乱序 = 协议失败烧槽):
//!
//! ```text
//! opener                                joiner
//!   │──── Pake{A} ────────────────────────▶│   (双方以配对码 SECRET 为口令跑 SPAKE2,
//!   │◀─────────────────────── Pake{B} ─────│    identities = 固定常量 + slot)
//!   │◀──────────────────── Confirm{macJ} ──│   (joiner 先自证知道口令)
//!   │──── Confirm{macO} ──────────────────▶│   (opener 验过才回确认……
//!   │──── Grant{账户材料密文} ─────────────▶│    ……并在同批交出账户材料)
//!   │◀─────────────── Enroll{设备材料密文} ─│
//!   │  (发 register_device,等 Registered)  │
//!   │──── Done ───────────────────────────▶│
//! ```
//!
//! * **密钥确认 = HMAC over transcript,双向**:spake2 crate 的会话密钥本身就是完整
//!   transcript(identities、双方 PAKE 消息、口令绑定群元素)的哈希,故对
//!   HKDF(key, 方向 info) 派生的确认子钥做 HMAC 即绑定了整个 transcript;方向 info
//!   不同,反射对端的确认值必不过。**joiner 先确认**:opener(账户材料持有方)在
//!   验过对端确实知道 SECRET 之前,不发出任何秘密。确认不过 = Err,调用方发
//!   `PairClose` 烧槽——服务器 MITM 对 40 bit 口令恒只有一次在线猜测(§4)。
//! * **材料交换走会话子钥 AEAD**(XChaCha20-Poly1305,AAD 绑 slot 与方向):老→新
//!   `AccountGrant{account_id, k_acc, server_url}`,新→老 `DeviceEnroll{device_id,
//!   ed25519_pub}`。SPAKE2 之上再封一层不是纵深冗余——PAKE 只产钥,机密性要 AEAD 兑现。
//! * **配对码 `slot-SECRET`**:slot 是服务器发的寻址(9 位数字,§4),SECRET 是
//!   opener 本机生成的 8 位 Crockford base32(≈40 bit,一次性);解析容错沿
//!   Crockford 规范(不分大小写、O→0、I/L→1,crypto.rs 同一套字表)。
//! * 任何一步失败(解码/乱序/确认不过/密文不开/材料形态不合)= [`PairError`],状态机
//!   即死(后续调用恒 Err);**调用方义务:收到 Err 立即发 `PairClose`**。超时不在
//!   本层(服务器槽 TTL 10 分钟兜底,P2-g 传输层自设 UI 超时)。
//! * 线上格式纪律与内层 Msg 同(P2-d):[`PairWire`] 的 CBOR externally tagged 形态
//!   由黄金向量焊死,改名 = 协议破坏。
//!
//! 秘密材料(K_acc/会话钥)在内存不作擦除(zeroize)处理——与 §2「K_acc 明文存
//! sync_meta」同一条诚实边界:本地内存/磁盘不在威胁模型内,加壳是安全剧场。

use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::{AeadCore, Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use sync_proto::is_ulid;

use super::crypto::{crockford_char_value, CROCKFORD};

/// 配对码 SECRET 的字符数(8 × 5 bit = 40 bit,§4/§6.1)。
pub const SECRET_CHARS: usize = 8;
/// SPAKE2 identities 的固定常量半(另一半是 slot,见 [`identities`])。
const ID_OPENER: &str = "zhujian-pair-opener-v1";
const ID_JOINER: &str = "zhujian-pair-joiner-v1";
/// 会话密钥派生 info(HKDF-SHA256 over SPAKE2 输出;方向确认子钥各一、材料子钥一)。
const INFO_CONFIRM_OPENER: &str = "zhujian/pair/v1/confirm-opener";
const INFO_CONFIRM_JOINER: &str = "zhujian/pair/v1/confirm-joiner";
const INFO_SESSION: &str = "zhujian/pair/v1/session";
/// 密钥确认 HMAC 的消息标签(密钥已各含方向与 transcript,标签只是域名义)。
const CONFIRM_LABEL: &[u8] = b"zhujian-pair-key-confirm-v1";
/// 材料 AEAD 的 AAD 首元素(版本铭牌;slot 与方向随后,见 [`session_aad`])。
const SESSION_AAD_V1: &str = "zhujian-pair-v1";
/// 材料密文方向标(AAD 元素;反向重放必不开)。
const DIR_GRANT: &str = "grant";
const DIR_ENROLL: &str = "enroll";

const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;

// ---- 线上消息(盲桥字节;CBOR externally tagged,黄金向量焊死) ----

/// 配对盲桥上的线上消息(`pair_msg.blob` 的内容;服务器不可读不必读)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PairWire {
    /// SPAKE2 交换消息(两方向各一条;spake2 crate 输出自带 side 标记)。
    Pake {
        #[serde(with = "serde_bytes")]
        msg: Vec<u8>,
    },
    /// 密钥确认(HMAC,32B;joiner 先发)。
    Confirm {
        #[serde(with = "serde_bytes")]
        mac: Vec<u8>,
    },
    /// 老→新:账户材料(会话子钥 AEAD 下的 [`AccountGrant`])。
    Grant {
        #[serde(with = "serde_bytes")]
        sealed: Vec<u8>,
    },
    /// 新→老:设备材料(会话子钥 AEAD 下的 [`DeviceEnroll`])。
    Enroll {
        #[serde(with = "serde_bytes")]
        sealed: Vec<u8>,
    },
    /// 老→新:register_device 已获服务器确认(joiner 可断开重连走 auth → 引导)。
    Done,
}

/// 账户材料(§6.1 步骤 4 的「老→新」明文形态;CBOR)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountGrant {
    pub account_id: String,
    /// K_acc(32B;解密后由 [`open_grant`] 钉长度)。
    #[serde(with = "serde_bytes")]
    pub k_acc: Vec<u8>,
    pub server_url: String,
}

/// 设备材料(「新→老」明文形态;CBOR)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceEnroll {
    pub device_id: String,
    /// Ed25519 公钥(32B;opener 侧过曲线点校验,垃圾字节不拿去烧 device_id,§4)。
    #[serde(with = "serde_bytes")]
    pub pubkey: Vec<u8>,
}

/// 状态机输出(调用方按序执行;Send 映射 `ClientMsg::PairMsg{slot, blob}`)。
#[derive(Debug, PartialEq)]
pub enum PairOutput {
    /// 发一条盲桥字节。
    Send(Vec<u8>),
    /// joiner:Grant 已解出、**Enroll 尚未发出**——两阶段账户闸的停点
    /// (multispace-plan §4:`Grant → gate → Enroll`)。调用方在此裁决账户唯一性:
    /// 拒 = 直接 `PairClose`(老端从未收到 Enroll、从不注册,本机设备身份不烧);
    /// 过 = 调 [`Joiner::approve`] 拿 Enroll 继续。工序 7/8 审查 H1:原先 gate 卡在
    /// Done 之后,误扫已占用账户会白白烧掉本机 device_id。
    GrantPending { account_id: String },
    /// opener:材料齐了,发 `register_device{new_device, new_pubkey}`(§6.1 步骤 5);
    /// 收到 `Registered` 后调 [`Opener::on_registered`]。
    Register { device_id: String, pubkey: [u8; 32] },
    /// joiner 终局:拿到账户材料(随后断开重连走 auth → 引导,§6.1 步骤 6)。
    Granted(AccountGrant),
    /// opener 终局(Done 线报已在同批 Send 里)。
    Finished,
}

/// 配对失败(状态机即死;调用方发 `PairClose` 烧槽 + UI 报错)。
#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    /// 盲桥字节不是合法 PairWire(对端版本漂移或搅局者)。
    Codec,
    /// 消息与当前状态不符(乱序/重复/会话已死)。
    Protocol(&'static str),
    /// SPAKE2 交换失败(对端消息坏形态)。
    Pake,
    /// 密钥确认不过:对端不知道正确的配对码(或中间人在猜,§4 烧槽语义)。
    ConfirmMismatch,
    /// 材料密文解不开(会话钥不符——理论上确认已挡,防御在此响亮)。
    Sealed,
    /// 材料形态不合(k_acc/pubkey 长度、ULID 形态、公钥不是合法曲线点)。
    Material(&'static str),
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairError::Codec => write!(f, "配对消息无法解码(两端版本不一致?)"),
            PairError::Protocol(w) => write!(f, "配对协议乱序:{w}"),
            PairError::Pake => write!(f, "配对密钥交换失败"),
            PairError::ConfirmMismatch => write!(f, "配对码校验不过(对端输入的配对码不对?)"),
            PairError::Sealed => write!(f, "配对材料解密失败"),
            PairError::Material(w) => write!(f, "配对材料不合法:{w}"),
        }
    }
}

// ---- 配对码(slot-SECRET 的人眼形态) ----

/// 生成一次性 SECRET(8 位 Crockford base32,40 bit 系统熵)。
pub fn gen_secret() -> String {
    let mut raw = [0u8; 5]; // 5 字节 = 40 bit = 8 × 5 bit,整除无填充。
    OsRng.fill_bytes(&mut raw);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = String::with_capacity(SECRET_CHARS);
    for &b in &raw {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(CROCKFORD[((acc >> bits) & 31) as usize] as char);
        }
    }
    out
}

/// 配对码显示形态:`slot-SEC1-SEC2`(slot 补零到 9 位,SECRET 4+4 分组;§4 slot 9 位)。
pub fn pair_code(slot: u64, secret: &str) -> String {
    assert_eq!(secret.len(), SECRET_CHARS, "SECRET 恒 8 字符(gen_secret 产物)");
    assert!(slot < 1_000_000_000, "slot 恒 9 位以内(服务器 §4 语义)");
    format!("{slot:09}-{}-{}", &secret[..4], &secret[4..])
}

/// 配对码解析失败(人手输入,错误要能指认)。
#[derive(Debug, PartialEq, Eq)]
pub enum PairCodeError {
    /// 缺分隔符 / slot 段不是纯数字。
    BadSlot,
    /// SECRET 段有效字符数不是 8。
    BadLength(usize),
    /// SECRET 段出现 Crockford 字母表外的字符。
    BadChar(char),
}

impl std::fmt::Display for PairCodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairCodeError::BadSlot => write!(f, "配对码开头应是 9 位数字槽号(形如 123456789-XXXX-XXXX)"),
            PairCodeError::BadLength(n) => {
                write!(f, "配对码长度不对(槽号后应有 {SECRET_CHARS} 个字符,读到 {n} 个)")
            }
            PairCodeError::BadChar(c) => write!(f, "配对码含无效字符「{c}」"),
        }
    }
}

/// 解析人手输入的配对码 → (slot, 规范形 SECRET)。跳过空格,SECRET 段跳过 `-`、
/// 不分大小写、O→0、I/L→1(Crockford 规范容错;规范化保证双端口令字节一致)。
/// slot 段要求**恰 9 位数字**(显示端即 9 位,照抄;宽进只会养出非规范形态,
/// codex P2-f 轮 L1)。
pub fn parse_pair_code(input: &str) -> Result<(u64, String), PairCodeError> {
    let trimmed: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let Some((slot_part, secret_part)) = trimmed.split_once('-') else {
        return Err(PairCodeError::BadSlot);
    };
    if slot_part.len() != 9 || !slot_part.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PairCodeError::BadSlot);
    }
    let slot: u64 = slot_part.parse().map_err(|_| PairCodeError::BadSlot)?;
    let mut secret = String::with_capacity(SECRET_CHARS);
    for raw in secret_part.chars() {
        if raw == '-' {
            continue;
        }
        let v = crockford_char_value(raw).ok_or(PairCodeError::BadChar(raw))?;
        if secret.len() >= SECRET_CHARS {
            return Err(PairCodeError::BadLength(secret.len() + 1));
        }
        secret.push(CROCKFORD[v as usize] as char);
    }
    if secret.len() != SECRET_CHARS {
        return Err(PairCodeError::BadLength(secret.len()));
    }
    Ok((slot, secret))
}

// ---- 设备鉴权钥(§1:入账户时生成) ----

/// 生成设备 Ed25519 钥对:(签名种子, 公钥)。种子即 dalek `SigningKey` 字节形态,
/// P2-g 存 `sync_meta.device_key`;公钥经 [`DeviceEnroll`] 交老端背书注册。
pub fn gen_device_key() -> ([u8; 32], [u8; 32]) {
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    (seed, signing.verifying_key().to_bytes())
}

// ---- 会话密钥机械 ----

/// SPAKE2 会话密钥 → 三把子钥(方向确认 × 2 + 材料 AEAD)。
struct SessionKeys {
    confirm_opener: [u8; 32],
    confirm_joiner: [u8; 32],
    session: [u8; 32],
}

fn derive(key: &[u8], info: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, key);
    let mut okm = [0u8; 32];
    hk.expand(info.as_bytes(), &mut okm)
        .expect("32B 远在 HKDF-SHA256 输出上限内");
    okm
}

fn session_keys(pake_key: &[u8]) -> SessionKeys {
    SessionKeys {
        confirm_opener: derive(pake_key, INFO_CONFIRM_OPENER),
        confirm_joiner: derive(pake_key, INFO_CONFIRM_JOINER),
        session: derive(pake_key, INFO_SESSION),
    }
}

/// 密钥确认值:HMAC-SHA256(方向确认子钥, 固定标签)。子钥经 SPAKE2 密钥派生,
/// 而 spake2 的密钥 = H(完整 transcript)——「HMAC over transcript」的落实(§6.1)。
fn confirm_mac(confirm_key: &[u8; 32]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(confirm_key).expect("HMAC 任意钥长");
    mac.update(CONFIRM_LABEL);
    mac.finalize().into_bytes().into()
}

/// 常数时间比较(单次失败即烧槽,时序面本就只有一发;此为卫生习惯)。
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 材料 AEAD 的 AAD:CBOR 数组 [版本铭牌, slot, 方向](绑槽防跨会话拼接、绑方向防
/// 反射;字节形态同 crypto.rs 的 preferred serialization 纪律)。
fn session_aad(slot: u64, dir: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    ciborium::into_writer(&(SESSION_AAD_V1, slot, dir), &mut buf)
        .expect("CBOR 编码进内存 Vec 无失败路径");
    buf
}

fn seal_session(session: &[u8; 32], slot: u64, dir: &str, plain: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(session));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, Payload { msg: plain, aad: &session_aad(slot, dir) })
        .expect("XChaCha20-Poly1305 加密无失败路径");
    let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    blob
}

fn open_session(
    session: &[u8; 32],
    slot: u64,
    dir: &str,
    blob: &[u8],
) -> Result<Vec<u8>, PairError> {
    if blob.len() < NONCE_LEN + TAG_LEN {
        return Err(PairError::Sealed);
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(session));
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: &session_aad(slot, dir) })
        .map_err(|_| PairError::Sealed)
}

fn identities(slot: u64) -> (Identity, Identity) {
    (
        Identity::new(format!("{ID_OPENER}/{slot}").as_bytes()),
        Identity::new(format!("{ID_JOINER}/{slot}").as_bytes()),
    )
}

fn encode_wire(msg: &PairWire) -> Vec<u8> {
    let mut buf = Vec::new();
    ciborium::into_writer(msg, &mut buf).expect("CBOR 编码进内存 Vec 无失败路径");
    buf
}

fn decode_wire(blob: &[u8]) -> Result<PairWire, PairError> {
    ciborium::from_reader(blob).map_err(|_| PairError::Codec)
}

// ---- opener(老端,账户材料持有方) ----

enum OpenerState {
    /// 等 `pair_peer{joined}`(SPAKE2 首发攒在手里)。
    AwaitJoined { spake: Spake2<Ed25519Group>, first: Vec<u8> },
    /// 已发 Pake{A},等对端的 Pake{B}。
    AwaitPake { spake: Spake2<Ed25519Group> },
    /// 密钥已成,等 joiner 先确认。
    AwaitConfirm { keys: SessionKeys },
    /// 已回确认 + 已发 Grant,等对端设备材料。
    AwaitEnroll { keys: SessionKeys },
    /// 已输出 Register,等调用方拿到服务器 `Registered` 回执。
    AwaitRegistered,
    /// 终局 / 已失败。
    Dead,
}

/// 配对发起端(§6.1 的老端)。构造后按事件驱动:`on_joined` → `on_msg`×N →
/// `on_registered`;任何 Err 后状态机即死,调用方发 `PairClose`。
pub struct Opener {
    slot: u64,
    grant: AccountGrant,
    state: OpenerState,
}

impl Opener {
    /// `secret` 是本机 [`gen_secret`] 产物(规范形);`grant` 是要交付的账户材料
    /// (k_acc 必须 32B,fail-fast——它来自本机 sync_meta,长度不对是库损坏)。
    pub fn new(slot: u64, secret: &str, grant: AccountGrant) -> Opener {
        assert_eq!(grant.k_acc.len(), 32, "K_acc 恒 32B(sync_meta 损坏?)");
        let (id_o, id_j) = identities(slot);
        let (spake, first) =
            Spake2::<Ed25519Group>::start_a(&Password::new(secret.as_bytes()), &id_o, &id_j);
        Opener { slot, grant, state: OpenerState::AwaitJoined { spake, first } }
    }

    /// 服务器报 `pair_peer{joined}`:发出 SPAKE2 首帧。
    pub fn on_joined(&mut self) -> Result<Vec<PairOutput>, PairError> {
        match std::mem::replace(&mut self.state, OpenerState::Dead) {
            OpenerState::AwaitJoined { spake, first } => {
                self.state = OpenerState::AwaitPake { spake };
                Ok(vec![PairOutput::Send(encode_wire(&PairWire::Pake { msg: first }))])
            }
            _ => Err(PairError::Protocol("此刻不该有人入槽")),
        }
    }

    /// 收到对端盲桥字节。
    pub fn on_msg(&mut self, blob: &[u8]) -> Result<Vec<PairOutput>, PairError> {
        let wire = decode_wire(blob)?;
        match (std::mem::replace(&mut self.state, OpenerState::Dead), wire) {
            (OpenerState::AwaitPake { spake }, PairWire::Pake { msg }) => {
                let key = spake.finish(&msg).map_err(|_| PairError::Pake)?;
                self.state = OpenerState::AwaitConfirm { keys: session_keys(&key) };
                Ok(vec![])
            }
            (OpenerState::AwaitConfirm { keys }, PairWire::Confirm { mac }) => {
                // joiner 先自证;不过 = 对端(或中间人)不知道口令,烧槽。
                if !ct_eq(&mac, &confirm_mac(&keys.confirm_joiner)) {
                    return Err(PairError::ConfirmMismatch);
                }
                let my_mac = confirm_mac(&keys.confirm_opener);
                let grant_plain = {
                    let mut buf = Vec::new();
                    ciborium::into_writer(&self.grant, &mut buf)
                        .expect("CBOR 编码进内存 Vec 无失败路径");
                    buf
                };
                let sealed = seal_session(&keys.session, self.slot, DIR_GRANT, &grant_plain);
                self.state = OpenerState::AwaitEnroll { keys };
                Ok(vec![
                    PairOutput::Send(encode_wire(&PairWire::Confirm { mac: my_mac.to_vec() })),
                    PairOutput::Send(encode_wire(&PairWire::Grant { sealed })),
                ])
            }
            (OpenerState::AwaitEnroll { keys }, PairWire::Enroll { sealed }) => {
                let plain = open_session(&keys.session, self.slot, DIR_ENROLL, &sealed)?;
                let enroll: DeviceEnroll =
                    ciborium::from_reader(plain.as_slice()).map_err(|_| PairError::Codec)?;
                if !is_ulid(&enroll.device_id) {
                    return Err(PairError::Material("device_id 不是合法 ULID"));
                }
                let pubkey: [u8; 32] = enroll
                    .pubkey
                    .as_slice()
                    .try_into()
                    .map_err(|_| PairError::Material("公钥长度不是 32B"))?;
                // 曲线点校验(§4 服务器同款):垃圾字节不拿去注册烧 device_id。
                if ed25519_dalek::VerifyingKey::from_bytes(&pubkey).is_err() {
                    return Err(PairError::Material("公钥不是合法 Ed25519 曲线点"));
                }
                self.state = OpenerState::AwaitRegistered;
                Ok(vec![PairOutput::Register { device_id: enroll.device_id, pubkey }])
            }
            _ => Err(PairError::Protocol("opener 收到与当前步骤不符的消息")),
        }
    }

    /// 调用方收到服务器 `Registered` 回执:通报对端并终局。
    pub fn on_registered(&mut self) -> Result<Vec<PairOutput>, PairError> {
        match std::mem::replace(&mut self.state, OpenerState::Dead) {
            OpenerState::AwaitRegistered => Ok(vec![
                PairOutput::Send(encode_wire(&PairWire::Done)),
                PairOutput::Finished,
            ]),
            _ => Err(PairError::Protocol("此刻不该有注册回执")),
        }
    }
}

// ---- joiner(新端) ----

enum JoinerState {
    /// 已入槽,等 opener 的 Pake{A}(自己的 Pake{B} 攒在手里)。
    AwaitPake { spake: Spake2<Ed25519Group>, second: Vec<u8> },
    /// 已发 Pake{B} + 自己的确认,等 opener 的确认。
    AwaitConfirm { keys: SessionKeys },
    /// 对端已确认,等账户材料。
    AwaitGrant { keys: SessionKeys },
    /// Grant 已解出、等调用方账户闸裁决(§4 停点):[`Joiner::approve`] 才发 Enroll。
    AwaitApproval { keys: SessionKeys, grant: AccountGrant },
    /// 材料已到手 + 已发 Enroll,等 Done。
    AwaitDone { grant: AccountGrant },
    Dead,
}

/// 配对加入端(§6.1 的新端)。构造(输入解析自 [`parse_pair_code`])后 `pair_join`,
/// 之后纯按 `on_msg` 驱动;终局输出 [`PairOutput::Granted`]。
pub struct Joiner {
    slot: u64,
    enroll: DeviceEnroll,
    state: JoinerState,
}

impl Joiner {
    /// `secret` 取 [`parse_pair_code`] 的规范形;`enroll` 是本机设备材料
    /// ([`gen_device_key`] 的公钥 + 本机 device_id)。
    pub fn new(slot: u64, secret: &str, enroll: DeviceEnroll) -> Joiner {
        assert_eq!(enroll.pubkey.len(), 32, "Ed25519 公钥恒 32B(gen_device_key 产物)");
        let (id_o, id_j) = identities(slot);
        let (spake, second) =
            Spake2::<Ed25519Group>::start_b(&Password::new(secret.as_bytes()), &id_o, &id_j);
        Joiner { slot, enroll, state: JoinerState::AwaitPake { spake, second } }
    }

    /// 收到对端盲桥字节。
    pub fn on_msg(&mut self, blob: &[u8]) -> Result<Vec<PairOutput>, PairError> {
        let wire = decode_wire(blob)?;
        match (std::mem::replace(&mut self.state, JoinerState::Dead), wire) {
            (JoinerState::AwaitPake { spake, second }, PairWire::Pake { msg }) => {
                let key = spake.finish(&msg).map_err(|_| PairError::Pake)?;
                let keys = session_keys(&key);
                let my_mac = confirm_mac(&keys.confirm_joiner);
                self.state = JoinerState::AwaitConfirm { keys };
                Ok(vec![
                    PairOutput::Send(encode_wire(&PairWire::Pake { msg: second })),
                    PairOutput::Send(encode_wire(&PairWire::Confirm { mac: my_mac.to_vec() })),
                ])
            }
            (JoinerState::AwaitConfirm { keys }, PairWire::Confirm { mac }) => {
                // opener 的确认不过 = 自己连的不是持真口令的老端(中间人),不交设备材料。
                if !ct_eq(&mac, &confirm_mac(&keys.confirm_opener)) {
                    return Err(PairError::ConfirmMismatch);
                }
                self.state = JoinerState::AwaitGrant { keys };
                Ok(vec![])
            }
            (JoinerState::AwaitGrant { keys }, PairWire::Grant { sealed }) => {
                let plain = open_session(&keys.session, self.slot, DIR_GRANT, &sealed)?;
                let grant: AccountGrant =
                    ciborium::from_reader(plain.as_slice()).map_err(|_| PairError::Codec)?;
                if !is_ulid(&grant.account_id) {
                    return Err(PairError::Material("account_id 不是合法 ULID"));
                }
                if grant.k_acc.len() != 32 {
                    return Err(PairError::Material("K_acc 长度不是 32B"));
                }
                if grant.server_url.is_empty() {
                    return Err(PairError::Material("server_url 为空"));
                }
                // §4 停点:Enroll 攒着不发,等调用方账户闸裁决(approve)。
                let account_id = grant.account_id.clone();
                self.state = JoinerState::AwaitApproval { keys, grant };
                Ok(vec![PairOutput::GrantPending { account_id }])
            }
            (JoinerState::AwaitDone { grant }, PairWire::Done) => {
                self.state = JoinerState::Dead;
                Ok(vec![PairOutput::Granted(grant)])
            }
            _ => Err(PairError::Protocol("joiner 收到与当前步骤不符的消息")),
        }
    }

    /// 账户闸放行(§4 `Grant → gate → Enroll` 的第三步):发出 Enroll、转等 Done。
    /// 只在 [`PairOutput::GrantPending`] 之后合法;gate 拒绝就不调它,直接 `PairClose`
    /// ——老端从未见到 Enroll,注册从未发生。
    pub fn approve(&mut self) -> Result<Vec<PairOutput>, PairError> {
        match std::mem::replace(&mut self.state, JoinerState::Dead) {
            JoinerState::AwaitApproval { keys, grant } => {
                let enroll_plain = {
                    let mut buf = Vec::new();
                    ciborium::into_writer(&self.enroll, &mut buf)
                        .expect("CBOR 编码进内存 Vec 无失败路径");
                    buf
                };
                let sealed = seal_session(&keys.session, self.slot, DIR_ENROLL, &enroll_plain);
                self.state = JoinerState::AwaitDone { grant };
                Ok(vec![PairOutput::Send(encode_wire(&PairWire::Enroll { sealed }))])
            }
            _ => Err(PairError::Protocol("approve 只在 GrantPending 停点合法")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    const ACCT: &str = "01JZFAKEACCT0000000000AAAA";
    const DEV_B: &str = "01JZFAKEDEVB0000000000BBBB";

    fn grant() -> AccountGrant {
        AccountGrant {
            account_id: ACCT.into(),
            k_acc: vec![7u8; 32],
            server_url: "wss://sync.zhujian.app/ws".into(),
        }
    }

    fn enroll() -> DeviceEnroll {
        let (_seed, pubkey) = gen_device_key();
        DeviceEnroll { device_id: DEV_B.into(), pubkey: pubkey.to_vec() }
    }

    /// 全流程消息驱动:把一端的 Send 逐条喂给另一端,返回 opener 的 Register 参数
    /// 与 joiner 的 Granted。模拟服务器盲桥(只透传字节,保序)。
    fn run_to_register(
        opener: &mut Opener,
        joiner: &mut Joiner,
    ) -> Result<(String, [u8; 32]), PairError> {
        let mut to_joiner: Vec<Vec<u8>> = vec![];
        for out in opener.on_joined()? {
            match out {
                PairOutput::Send(b) => to_joiner.push(b),
                other => panic!("on_joined 只该发盲桥字节,得到 {other:?}"),
            }
        }
        loop {
            let mut to_opener: Vec<Vec<u8>> = vec![];
            for b in to_joiner.drain(..) {
                for out in joiner.on_msg(&b)? {
                    match out {
                        PairOutput::Send(x) => to_opener.push(x),
                        // §4 账户闸停点:盲桥测试即刻放行(拒路另有专测)。
                        PairOutput::GrantPending { .. } => {
                            for a in joiner.approve()? {
                                match a {
                                    PairOutput::Send(x) => to_opener.push(x),
                                    other => panic!("approve 只该发盲桥字节,得到 {other:?}"),
                                }
                            }
                        }
                        PairOutput::Granted(_) => panic!("Register 之前不该 Granted"),
                        other => panic!("joiner 不该输出 {other:?}"),
                    }
                }
            }
            for b in to_opener.drain(..) {
                for out in opener.on_msg(&b)? {
                    match out {
                        PairOutput::Send(x) => to_joiner.push(x),
                        PairOutput::Register { device_id, pubkey } => {
                            assert!(to_joiner.is_empty(), "Register 后不该还有待发帧");
                            return Ok((device_id, pubkey));
                        }
                        other => panic!("opener 不该输出 {other:?}"),
                    }
                }
            }
            assert!(!to_joiner.is_empty(), "对跑停摆:双方都无帧可发也没到 Register");
        }
    }

    #[test]
    fn full_flow_hands_over_account_and_device_material() {
        let secret = gen_secret();
        let mut opener = Opener::new(123_456_789, &secret, grant());
        let en = enroll();
        let mut joiner = Joiner::new(123_456_789, &secret, en.clone());

        let (device_id, pubkey) = run_to_register(&mut opener, &mut joiner).unwrap();
        assert_eq!(device_id, en.device_id);
        assert_eq!(pubkey.to_vec(), en.pubkey);

        // 服务器回 Registered:opener 发 Done + 终局;joiner 收 Done 拿到账户材料。
        let outs = opener.on_registered().unwrap();
        assert_eq!(outs.len(), 2);
        let PairOutput::Send(done) = &outs[0] else { panic!("首条应是 Done 线报") };
        assert_eq!(outs[1], PairOutput::Finished);
        let got = joiner.on_msg(done).unwrap();
        assert_eq!(got, vec![PairOutput::Granted(grant())]);
    }

    #[test]
    fn wrong_secret_burns_at_openers_confirm_check() {
        let mut opener = Opener::new(1, "AAAAAAAA", grant());
        let mut joiner = Joiner::new(1, "BBBBBBBB", enroll());
        // A → joiner:回 B + 确认(joiner 无从知道口令不对)。
        let a = match &opener.on_joined().unwrap()[0] {
            PairOutput::Send(b) => b.clone(),
            _ => unreachable!(),
        };
        let outs = joiner.on_msg(&a).unwrap();
        let (b, mac_j) = match (&outs[0], &outs[1]) {
            (PairOutput::Send(b), PairOutput::Send(m)) => (b.clone(), m.clone()),
            _ => unreachable!(),
        };
        // opener:PAKE 完成(密钥各异但双方不知),确认一到即拆穿。
        assert_eq!(opener.on_msg(&b).unwrap(), vec![]);
        assert_eq!(opener.on_msg(&mac_j), Err(PairError::ConfirmMismatch));
        // 状态机已死:后续任何消息恒 Err。
        assert!(matches!(opener.on_msg(&mac_j), Err(PairError::Protocol(_))));
    }

    #[test]
    fn tampered_pake_message_fails_before_any_material_flows() {
        let secret = gen_secret();
        let mut opener = Opener::new(9, &secret, grant());
        let mut joiner = Joiner::new(9, &secret, enroll());
        let mut a = match &opener.on_joined().unwrap()[0] {
            PairOutput::Send(b) => b.clone(),
            _ => unreachable!(),
        };
        // 翻转 PAKE 群元素一位(中间人替换消息):密钥两边不同,joiner 的确认过不了
        // opener 的验;这里直接断 opener 侧拆穿。
        let last = a.len() - 1;
        a[last] ^= 1;
        let outs = match joiner.on_msg(&a) {
            // 坏群元素可能直接解不出(Pake Err)——同样是烧槽,协议安全。
            Err(PairError::Pake) => return,
            Ok(outs) => outs,
            Err(e) => panic!("意外错误:{e:?}"),
        };
        let (b, mac_j) = match (&outs[0], &outs[1]) {
            (PairOutput::Send(b), PairOutput::Send(m)) => (b.clone(), m.clone()),
            _ => unreachable!(),
        };
        assert_eq!(opener.on_msg(&b).unwrap(), vec![]);
        assert_eq!(opener.on_msg(&mac_j), Err(PairError::ConfirmMismatch));
    }

    #[test]
    fn tampered_grant_ciphertext_is_rejected_by_joiner() {
        let secret = gen_secret();
        let mut opener = Opener::new(2, &secret, grant());
        let mut joiner = Joiner::new(2, &secret, enroll());
        let a = match &opener.on_joined().unwrap()[0] {
            PairOutput::Send(b) => b.clone(),
            _ => unreachable!(),
        };
        let outs = joiner.on_msg(&a).unwrap();
        let (b, mac_j) = match (&outs[0], &outs[1]) {
            (PairOutput::Send(b), PairOutput::Send(m)) => (b.clone(), m.clone()),
            _ => unreachable!(),
        };
        opener.on_msg(&b).unwrap();
        let outs = opener.on_msg(&mac_j).unwrap();
        let (mac_o, grant_wire) = match (&outs[0], &outs[1]) {
            (PairOutput::Send(m), PairOutput::Send(g)) => (m.clone(), g.clone()),
            _ => unreachable!(),
        };
        joiner.on_msg(&mac_o).unwrap();
        // 篡改 Grant 密文尾字节(tag):解不开,烧槽。
        let mut wire: PairWire = ciborium::from_reader(grant_wire.as_slice()).unwrap();
        if let PairWire::Grant { sealed } = &mut wire {
            let last = sealed.len() - 1;
            sealed[last] ^= 1;
        }
        assert_eq!(joiner.on_msg(&encode_wire(&wire)), Err(PairError::Sealed));
    }

    #[test]
    fn out_of_order_and_garbage_messages_kill_the_session() {
        let secret = gen_secret();
        let mut opener = Opener::new(3, &secret, grant());
        // 还没人入槽就来消息:乱序。
        assert!(matches!(
            opener.on_msg(&encode_wire(&PairWire::Done)),
            Err(PairError::Protocol(_))
        ));
        let mut joiner = Joiner::new(3, &secret, enroll());
        // joiner 首步等 Pake,来 Confirm:乱序。
        assert!(matches!(
            joiner.on_msg(&encode_wire(&PairWire::Confirm { mac: vec![0; 32] })),
            Err(PairError::Protocol(_))
        ));
        // 非 CBOR 垃圾:Codec。
        let mut j2 = Joiner::new(3, &secret, enroll());
        assert_eq!(j2.on_msg(b"not-cbor"), Err(PairError::Codec));
    }

    #[test]
    fn enroll_material_is_validated_before_register() {
        // 直接对材料校验逻辑做端到端:joiner 交上来的公钥若不是合法曲线点,opener
        // 不输出 Register(§4:垃圾 32B 不拿去烧 device_id)。注意全零等「特殊」
        // 字节串反而是合法压缩点——非法点得实找(约一半 y 无解,[n;32] 里必有)。
        let bad_pub = (0u8..=255)
            .map(|n| [n; 32])
            .find(|b| ed25519_dalek::VerifyingKey::from_bytes(b).is_err())
            .expect("256 个候选里总有解压失败的字节串");
        let secret = gen_secret();
        let mut opener = Opener::new(4, &secret, grant());
        let bad = DeviceEnroll { device_id: DEV_B.into(), pubkey: bad_pub.to_vec() };
        let mut joiner = Joiner::new(4, &secret, bad);
        let err = run_to_register(&mut opener, &mut joiner).unwrap_err();
        assert_eq!(err, PairError::Material("公钥不是合法 Ed25519 曲线点"));
    }

    #[test]
    fn pair_code_round_trips_with_crockford_tolerance() {
        let secret = gen_secret();
        assert_eq!(secret.len(), SECRET_CHARS);
        assert!(secret.bytes().all(|b| CROCKFORD.contains(&b)));
        let code = pair_code(123_456_789, &secret);
        assert_eq!(code.len(), 9 + 1 + 4 + 1 + 4);
        let (slot, parsed) = parse_pair_code(&code).unwrap();
        assert_eq!(slot, 123_456_789);
        assert_eq!(parsed, secret);
        // 容错:小写、去分组、加空格。
        assert_eq!(parse_pair_code(&code.to_lowercase()).unwrap().1, secret);
        assert_eq!(parse_pair_code(&code.replace('-', " -")).unwrap().1, secret);
        // slot 补零显示照样解析。
        let (slot, _) = parse_pair_code(&pair_code(42, &secret)).unwrap();
        assert_eq!(slot, 42);
        // Crockford 别名:O→0、I/l→1。用固定 SECRET(确保含 0 与 1)+ 全 9 的 slot
        // (别名替换只动 SECRET 段,别误伤槽号里的数字)。
        let code = pair_code(999_999_999, "01ABCDEF");
        let aliased = code.replace('0', "O").replace('1', "l");
        assert_eq!(parse_pair_code(&aliased).unwrap(), (999_999_999, "01ABCDEF".into()));
    }

    #[test]
    fn pair_code_rejects_bad_input() {
        assert_eq!(parse_pair_code("no-slot-here"), Err(PairCodeError::BadSlot));
        assert_eq!(parse_pair_code("ABCDEFGH"), Err(PairCodeError::BadSlot));
        assert_eq!(parse_pair_code(""), Err(PairCodeError::BadSlot));
        // slot 段要求恰 9 位数字(显示端即 9 位,照抄;codex P2-f 轮 L1)。
        assert_eq!(parse_pair_code("123-ABCD-EFGH"), Err(PairCodeError::BadSlot));
        assert_eq!(parse_pair_code("1234567890-ABCD-EFGH"), Err(PairCodeError::BadSlot));
        assert_eq!(parse_pair_code("123456789-ABCD"), Err(PairCodeError::BadLength(4)));
        assert_eq!(
            parse_pair_code("123456789-ABCD-EFGH-2222"),
            Err(PairCodeError::BadLength(9))
        );
        // U 被 Crockford 刻意排除。
        assert_eq!(
            parse_pair_code("123456789-ABCD-EFGU"),
            Err(PairCodeError::BadChar('U'))
        );
    }

    #[test]
    fn gen_secret_and_device_key_are_fresh_each_time() {
        assert_ne!(gen_secret(), gen_secret(), "40 bit 撞一次可以买彩票了");
        let (seed1, pub1) = gen_device_key();
        let (seed2, pub2) = gen_device_key();
        assert_ne!(seed1, seed2);
        assert_ne!(pub1, pub2);
        // 公钥必过曲线点校验(opener 侧同一校验)。
        assert!(ed25519_dalek::VerifyingKey::from_bytes(&pub1).is_ok());
    }

    /// PairWire 线上格式黄金向量(externally tagged;与内层 Msg / 信封同纪律)。
    /// 断言失败 = 线上格式变了 = 新旧端配对互不认,别改断言,改回代码。
    #[test]
    fn pair_wire_golden_vectors() {
        let cases: Vec<(PairWire, &str)> = vec![
            (
                PairWire::Pake { msg: vec![0xAA, 0xBB] },
                "a16450616b65a1636d736742aabb",
            ),
            (
                PairWire::Confirm { mac: vec![0x01] },
                "a167436f6e6669726da1636d61634101",
            ),
            (
                PairWire::Grant { sealed: vec![0x02] },
                "a1654772616e74a1667365616c65644102",
            ),
            (
                PairWire::Enroll { sealed: vec![0x03] },
                "a166456e726f6c6ca1667365616c65644103",
            ),
            (PairWire::Done, "64446f6e65"),
        ];
        for (msg, want) in cases {
            let got = encode_wire(&msg);
            assert_eq!(hex(&got), want, "{msg:?} 的 CBOR 字节形态漂了");
            assert_eq!(decode_wire(&got).unwrap(), msg);
        }
    }
}
