//! P2-d 加密层 —— sync-protocol §2 的落实(密钥体系与帧加密的纯函数层)。
//!
//! 不碰 DB、不持 socket:封帧 = 内层消息 --CBOR--> 明文 --域子钥 XChaCha20-Poly1305
//! (24B 随机 nonce 前置)--> 信封 `blob`;解帧反之。**79 起 seal/open 泛型化**:
//! op/ctl/blob 域装 `engine::Msg`,boot 域装 `boot::BootMsg`(两个消息空间由域子钥
//! + AAD domain 隔死)。P2-g 把本层接在 transport 与 engine 之间——engine 的输入
//! 输出恒是明文 `Msg`,本层落地对它零改动。
//!
//! * **域子钥**:HKDF-SHA256(K_acc, info = `"zhujian/sync/v1/" + domain`),domain ∈
//!   op/ctl/boot/blob——一个域的密文在另一域解密必败(子钥不同)。
//! * **AAD = CBOR 数组 `[ver, account_id, from_device, to, domain]`**(评审①-L1 的
//!   双保险):密文绑定协议版本、账户、来源、去向与域;跨账户/跨设备/跨域拼接、
//!   改投他人(服务器改 deliver 标签)全都解密失败。`to` 取信封原值(指名 device_id
//!   或广播 `"*"`,由服务器 deliver 回显供收端重构,§3)。
//! * **恢复码 = K_acc 的 Crockford base32**(52 字符,4 字符一组 `-` 连接;§2 强制
//!   仪式的数据面)。解析按 Crockford 规范容错(不分大小写、O→0、I/L→1)——这是
//!   规范自带的抄录容错,不是回退兜底;长度/字符/尾填充任一不合 = 拒(fail-fast)。
//!
//! 线上格式从此钉死(改 = 协议破坏):`Msg` 的 CBOR 表示(serde 默认 externally
//! tagged)、HKDF info 前缀、AAD 元组形态、`nonce ‖ ciphertext‖tag` 布局。本文件的
//! 黄金向量测试把它们焊在测试里;标准算法向量(RFC 5869 / XChaCha20-Poly1305 draft)
//! 证明底座参数没用错。

use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::{AeadCore, Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::Sha256;

/// 协议版本(AAD 首元素)。凡改动线上格式(Msg 形态/AAD/布局)必须升它。
pub const PROTO_VER: u64 = 1;
/// HKDF 域信息前缀(§2)。
const HKDF_INFO_PREFIX: &str = "zhujian/sync/v1/";
/// XChaCha20 nonce 长度(24B 随机,192-bit 空间无碰撞之虞,§2)。
const NONCE_LEN: usize = 24;
/// Poly1305 认证标签长度。
const TAG_LEN: usize = 16;

/// 加密域(§2)。域字符串既进 HKDF info 又进 AAD——隔离双保险。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    /// op 帧(`Msg::Ops`,mail lane)。
    Op,
    /// 控制帧(`Msg::Hello`/`Want`,mail lane;P2-g 起启用,transport 的域映射即协议)。
    Ctl,
    /// 引导快照流(§6.2,direct)。
    Boot,
    /// 图字节流(§5.4,direct)。
    Blob,
}

impl Domain {
    pub fn as_str(self) -> &'static str {
        match self {
            Domain::Op => "op",
            Domain::Ctl => "ctl",
            Domain::Boot => "boot",
            Domain::Blob => "blob",
        }
    }
}

/// 帧地址五元组(AAD 的字段来源;ver 是常量不在此)。收端以**信封**的 from/to 重构
/// ——服务器篡改任一标签即解密失败。
#[derive(Debug, Clone, Copy)]
pub struct FrameAddr<'a> {
    pub account_id: &'a str,
    pub from_device: &'a str,
    /// 指名 device_id 或广播 `"*"`(engine::BROADCAST;deliver 回显原值)。
    pub to: &'a str,
    pub domain: Domain,
}

/// 解帧失败。任何一种都意味着帧不可信,整帧拒收(engine 侧记 FrameRejected)。
#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// 短于 nonce+tag 的物理下限,不可能是本协议的帧。
    TooShort,
    /// AEAD 认证失败:密钥、AAD(账户/来源/去向/域/版本)、密文遭改,任一不符都落这。
    Decrypt,
    /// 解密通过但 CBOR 不是合法 Msg(对端版本更新引入了未知顶层变体,或对端 bug)。
    /// 后果推演(codex P2-d 轮 M1):水位不推进、hello/want 会反复重取同一批 op,
    /// 响亮卡住直到升级——不是静默丢失;P2-g 传输层必须把它转成用户可见的
    /// 「对端版本较新,请升级」状态,不许吞成日志。
    Codec,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::TooShort => write!(f, "帧太短"),
            OpenError::Decrypt => write!(f, "解密失败(密钥或帧地址不符)"),
            OpenError::Codec => write!(f, "帧内容无法解码(对端版本较新?)"),
        }
    }
}

/// 域子钥:HKDF-SHA256(K_acc, info = 前缀 + domain) → 32B(§2)。
pub fn domain_key(k_acc: &[u8; 32], domain: Domain) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, k_acc);
    let info = [HKDF_INFO_PREFIX.as_bytes(), domain.as_str().as_bytes()].concat();
    let mut okm = [0u8; 32];
    hk.expand(&info, &mut okm)
        .expect("32B 远在 HKDF-SHA256 输出上限(8160B)内");
    okm
}

/// AAD:CBOR 数组 [ver, account, from, to, domain](§2)。字节形态钉死为 CBOR
/// preferred serialization(definite-length 数组、最短长度前缀;ciborium 天然如此,
/// 黄金向量测试焊住)——收端重构必须**逐字节**相等才解得开,「语义等价但字节不同」
/// 的 CBOR(indefinite-length 等)一律解密失败;将来别端实现以黄金向量对拍
/// (codex P2-d 轮 M2)。
fn frame_aad(addr: &FrameAddr) -> Vec<u8> {
    let mut buf = Vec::new();
    ciborium::into_writer(
        &(
            PROTO_VER,
            addr.account_id,
            addr.from_device,
            addr.to,
            addr.domain.as_str(),
        ),
        &mut buf,
    )
    .expect("CBOR 编码进内存 Vec 无失败路径");
    buf
}

/// 封帧:内层消息 → CBOR → 域子钥 AEAD。输出即信封 `blob`(布局 `nonce ‖ ct‖tag`,§3)。
/// 泛型按域取内层类型:op/ctl/blob 域是 `engine::Msg`,boot 域是 `boot::BootMsg`
/// (P2-f)——域子钥 + AAD 的 domain 字段本就把两个消息空间隔死,拼不过界。
pub fn seal_msg<T: Serialize>(k_acc: &[u8; 32], addr: &FrameAddr, msg: &T) -> Vec<u8> {
    let mut plain = Vec::new();
    ciborium::into_writer(msg, &mut plain).expect("CBOR 编码进内存 Vec 无失败路径");
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&domain_key(k_acc, addr.domain)));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(
            &nonce,
            Payload { msg: &plain, aad: &frame_aad(addr) },
        )
        .expect("XChaCha20-Poly1305 加密无失败路径");
    let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    blob
}

/// 解帧:收端以自己重构的地址五元组解。跨账户/跨设备/跨域拼接、改投他人、密文
/// 篡改,全部在 `Decrypt` 一步拒收。
pub fn open_msg<T: DeserializeOwned>(
    k_acc: &[u8; 32],
    addr: &FrameAddr,
    blob: &[u8],
) -> Result<T, OpenError> {
    if blob.len() < NONCE_LEN + TAG_LEN {
        return Err(OpenError::TooShort);
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&domain_key(k_acc, addr.domain)));
    let plain = cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload { msg: ct, aad: &frame_aad(addr) },
        )
        .map_err(|_| OpenError::Decrypt)?;
    ciborium::from_reader(plain.as_slice()).map_err(|_| OpenError::Codec)
}

// ---- 恢复码(K_acc 的人眼形态,§2 强制仪式) ----

/// Crockford base32 编码字母表(排除 I/L/O/U)。pair.rs 的配对码 SECRET 同一套。
pub(crate) const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Crockford 单字符解码(规范自带的抄录容错:不分大小写、O→0、I/L→1);
/// 字母表外(含被刻意排除的 U)= None。恢复码与配对码 SECRET 共用。
pub(crate) fn crockford_char_value(raw: char) -> Option<u32> {
    let c = raw.to_ascii_uppercase();
    match c {
        '0' | 'O' => Some(0),
        '1' | 'I' | 'L' => Some(1),
        '2'..='9' => Some(c as u32 - '0' as u32),
        'A'..='H' => Some(c as u32 - 'A' as u32 + 10),
        'J' | 'K' => Some(c as u32 - 'J' as u32 + 18),
        'M' | 'N' => Some(c as u32 - 'M' as u32 + 20),
        'P'..='T' => Some(c as u32 - 'P' as u32 + 22),
        'V'..='Z' => Some(c as u32 - 'V' as u32 + 27),
        _ => None,
    }
}
/// 有效字符数:256 bit / 5 ≈ 52,末字符低 4 bit 恒为填充 0。
const RECOVERY_CHARS: usize = 52;
/// 显示分组宽度(4 字符一组,13 组)。
const RECOVERY_GROUP: usize = 4;

/// 恢复码解析失败(输入是人手抄录,错误要能指认)。
#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryCodeError {
    /// 出现 Crockford 字母表外的字符(含被刻意排除的 U)。
    BadChar(char),
    /// 有效字符数不是 52。
    BadLength(usize),
    /// 末字符的填充位非 0:不是本编码器产物(抄错的响亮形态)。
    NonCanonical,
}

impl std::fmt::Display for RecoveryCodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecoveryCodeError::BadChar(c) => write!(f, "恢复码含无效字符「{c}」"),
            RecoveryCodeError::BadLength(n) => {
                write!(f, "恢复码长度不对(有效字符 {n} 个,应为 {RECOVERY_CHARS} 个)")
            }
            RecoveryCodeError::NonCanonical => write!(f, "恢复码校验不过,请核对最后一组"),
        }
    }
}

/// K_acc → 恢复码:Crockford base32,4 字符一组 `-` 连接(§2 的显示形态)。
pub fn recovery_code(k_acc: &[u8; 32]) -> String {
    let mut chars = Vec::with_capacity(RECOVERY_CHARS);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in k_acc {
        acc = ((acc << 8) | u32::from(b)) & 0xFFFF; // 只留有效低位(bits ≤ 12)
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            chars.push(CROCKFORD[((acc >> bits) & 31) as usize]);
        }
    }
    // 256 = 51*5 + 1:剩 1 个数据 bit,左移补 4 个 0 bit 成第 52 字符。
    chars.push(CROCKFORD[((acc << (5 - bits)) & 31) as usize]);
    chars
        .chunks(RECOVERY_GROUP)
        .map(|g| std::str::from_utf8(g).expect("字母表是 ASCII"))
        .collect::<Vec<_>>()
        .join("-")
}

/// 恢复码 → K_acc。跳过 `-`/空格,不分大小写,O→0、I/L→1(Crockford 规范的抄录
/// 容错);其余任何不合 = 拒。
pub fn parse_recovery_code(input: &str) -> Result<[u8; 32], RecoveryCodeError> {
    let mut out = [0u8; 32];
    let mut filled = 0usize;
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut nchars = 0usize;
    for raw in input.chars() {
        if raw == '-' || raw == ' ' {
            continue;
        }
        let v: u32 = match crockford_char_value(raw) {
            Some(v) => v,
            None => return Err(RecoveryCodeError::BadChar(raw)),
        };
        nchars += 1;
        if nchars > RECOVERY_CHARS {
            return Err(RecoveryCodeError::BadLength(nchars));
        }
        acc = ((acc << 5) | v) & 0xFFF; // 只留有效低位(bits ≤ 12)
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out[filled] = (acc >> bits) as u8;
            filled += 1;
        }
    }
    if nchars != RECOVERY_CHARS {
        return Err(RecoveryCodeError::BadLength(nchars));
    }
    // 52*5 - 32*8 = 4:恰余 4 个填充 bit,必须为 0(非规范形态拒,fail-fast)。
    debug_assert_eq!(filled, 32);
    debug_assert_eq!(bits, 4);
    if acc & ((1 << bits) - 1) != 0 {
        return Err(RecoveryCodeError::NonCanonical);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::RemoteOp;
    use crate::sync::engine::{Msg, BROADCAST};
    use serde_json::json;
    use std::collections::BTreeMap;

    fn unhex(s: &str) -> Vec<u8> {
        let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(compact.len() % 2 == 0, "hex 长度须为偶数");
        compact
            .as_bytes()
            .chunks(2)
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn k(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    fn addr<'a>(account: &'a str, from: &'a str, to: &'a str, domain: Domain) -> FrameAddr<'a> {
        FrameAddr { account_id: account, from_device: from, to, domain }
    }

    /// payload 覆盖 JSON 全部形态(string/int/float 不进 payload——oplog 只有
    /// json_valid 的业务值:字符串/整数/数组/对象/bool/null),CBOR 往返无损的证明。
    fn sample_msg() -> Msg {
        Msg::Ops {
            origin: "01JZDEV1CE00000000000000AB".into(),
            ops: vec![RemoteOp {
                op_id: "01JZOP0000000000000000000A".into(),
                hlc: "0000018f4e5d2c00-00000000-01JZDEV1CE00000000000000AB".into(),
                entity: "item".into(),
                entity_id: "01JZITEM000000000000000000".into(),
                kind: "set_field".into(),
                payload: json!({
                    "field": "content",
                    "value": "正文带中文",
                    "n": 42,
                    "flags": [true, false, null],
                    "nested": {"k": "v"}
                }),
                origin_seq: 7,
            }],
        }
    }

    // ---- 标准算法向量:证明底座参数没用错 ----

    #[test]
    fn hkdf_sha256_matches_rfc5869_case_1() {
        let ikm = unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        let salt = unhex("000102030405060708090a0b0c");
        let info = unhex("f0f1f2f3f4f5f6f7f8f9");
        let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
        let mut okm = [0u8; 42];
        hk.expand(&info, &mut okm).unwrap();
        assert_eq!(
            hex(&okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    #[test]
    fn xchacha20poly1305_matches_ietf_draft_vector() {
        // draft-irtf-cfrg-xchacha-03 附录 A.3.2(sunscreen 文)。
        let key = unhex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
        let nonce = unhex("404142434445464748494a4b4c4d4e4f5051525354555657");
        let aad = unhex("50515253c0c1c2c3c4c5c6c7");
        let plain: &[u8] = b"Ladies and Gentlemen of the class of '99: If I could offer you \
only one tip for the future, sunscreen would be it.";
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
        let out = cipher
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad: &aad })
            .unwrap();
        let (ct, tag) = out.split_at(out.len() - TAG_LEN);
        assert_eq!(
            hex(ct),
            "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440b\
f3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc3694\
88f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e"
        );
        assert_eq!(hex(tag), "c0875924c1c7987947deafd8780acf49");
    }

    // ---- 域子钥 ----

    #[test]
    fn domain_keys_are_pairwise_distinct_and_pinned() {
        let k_acc = k(0);
        let all = [Domain::Op, Domain::Ctl, Domain::Boot, Domain::Blob];
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(domain_key(&k_acc, *a), domain_key(&k_acc, *b));
            }
        }
        // 黄金向量:info 前缀/域名字符串是线上格式,重构漂移必须在此响亮。
        assert_eq!(
            hex(&domain_key(&k_acc, Domain::Op)),
            "3c7f61920d4163b7a29fe1b2985aa5c43eaa97dd2a5b6dab18ab4b852a23d1a3"
        );
    }

    // ---- 封帧/解帧 ----

    #[test]
    fn seal_open_round_trips_across_all_domains() {
        let k_acc = k(7);
        for domain in [Domain::Op, Domain::Ctl, Domain::Boot, Domain::Blob] {
            let a = addr("01JZACCT000000000000000000", "dev-a", BROADCAST, domain);
            let msg = sample_msg();
            let blob = seal_msg(&k_acc, &a, &msg);
            assert_eq!(open_msg::<Msg>(&k_acc, &a, &blob).unwrap(), msg);
        }
    }

    #[test]
    fn seal_uses_fresh_random_nonce_each_time() {
        let k_acc = k(7);
        let a = addr("acct", "dev-a", "dev-b", Domain::Op);
        let msg = Msg::Hello { watermarks: BTreeMap::new() };
        let b1 = seal_msg(&k_acc, &a, &msg);
        let b2 = seal_msg(&k_acc, &a, &msg);
        assert_ne!(b1, b2, "同帧两封必须得不同 blob(随机 nonce)");
        assert_ne!(b1[..NONCE_LEN], b2[..NONCE_LEN]);
        assert_eq!(open_msg::<Msg>(&k_acc, &a, &b1).unwrap(), open_msg::<Msg>(&k_acc, &a, &b2).unwrap());
    }

    #[test]
    fn open_rejects_cross_account_and_wrong_key() {
        let msg = Msg::Want { origin: "o".into(), from_seq: 1 };
        let sealed = seal_msg(&k(7), &addr("acct-1", "dev-a", BROADCAST, Domain::Op), &msg);
        // 换账户(同钥):AAD 不同 → 拒。
        assert_eq!(
            open_msg::<Msg>(&k(7), &addr("acct-2", "dev-a", BROADCAST, Domain::Op), &sealed),
            Err(OpenError::Decrypt)
        );
        // 换 K_acc(同 AAD):钥不同 → 拒。
        assert_eq!(
            open_msg::<Msg>(&k(8), &addr("acct-1", "dev-a", BROADCAST, Domain::Op), &sealed),
            Err(OpenError::Decrypt)
        );
    }

    #[test]
    fn open_rejects_forged_from_device() {
        // 服务器改 deliver 的 from 标签冒充别机 → 收端重构 AAD 不符 → 拒。
        let msg = Msg::Want { origin: "o".into(), from_seq: 1 };
        let sealed = seal_msg(&k(7), &addr("acct", "dev-a", BROADCAST, Domain::Op), &msg);
        assert_eq!(
            open_msg::<Msg>(&k(7), &addr("acct", "dev-b", BROADCAST, Domain::Op), &sealed),
            Err(OpenError::Decrypt)
        );
    }

    #[test]
    fn open_rejects_cross_domain_splice() {
        // op 域的密文拼到 blob 域投递:子钥与 AAD 双双不符 → 拒(评审①-L1)。
        let msg = Msg::Want { origin: "o".into(), from_seq: 1 };
        let sealed = seal_msg(&k(7), &addr("acct", "dev-a", BROADCAST, Domain::Op), &msg);
        assert_eq!(
            open_msg::<Msg>(&k(7), &addr("acct", "dev-a", BROADCAST, Domain::Blob), &sealed),
            Err(OpenError::Decrypt)
        );
    }

    #[test]
    fn open_rejects_redirected_to() {
        // 定向帧被改投他人(或改成广播)→ to 进了 AAD → 拒。
        let msg = Msg::BlobHave { image_id: "img".into() };
        let sealed = seal_msg(&k(7), &addr("acct", "dev-a", "dev-b", Domain::Op), &msg);
        assert_eq!(
            open_msg::<Msg>(&k(7), &addr("acct", "dev-a", "dev-c", Domain::Op), &sealed),
            Err(OpenError::Decrypt)
        );
        assert_eq!(
            open_msg::<Msg>(&k(7), &addr("acct", "dev-a", BROADCAST, Domain::Op), &sealed),
            Err(OpenError::Decrypt)
        );
    }

    #[test]
    fn open_rejects_tampered_or_truncated_blob() {
        let k_acc = k(7);
        let a = addr("acct", "dev-a", BROADCAST, Domain::Op);
        let mut sealed = seal_msg(&k_acc, &a, &Msg::Want { origin: "o".into(), from_seq: 1 });
        // 尾字节翻一位(动 tag)→ 拒。
        *sealed.last_mut().unwrap() ^= 1;
        assert_eq!(open_msg::<Msg>(&k_acc, &a, &sealed), Err(OpenError::Decrypt));
        *sealed.last_mut().unwrap() ^= 1;
        // 掐掉尾字节(tag 残缺)→ 拒。
        assert_eq!(
            open_msg::<Msg>(&k_acc, &a, &sealed[..sealed.len() - 1]),
            Err(OpenError::Decrypt)
        );
        // 物理下限之下 → TooShort。
        assert_eq!(
            open_msg::<Msg>(&k_acc, &a, &sealed[..NONCE_LEN + TAG_LEN - 1]),
            Err(OpenError::TooShort)
        );
        assert_eq!(open_msg::<Msg>(&k_acc, &a, &[]), Err(OpenError::TooShort));
    }

    // ---- 线上格式黄金向量 ----

    #[test]
    fn frame_aad_bytes_are_pinned() {
        // AAD 是 AEAD 认证的一部分,字节形态就是协议(codex P2-d 轮 M2):
        // definite-length 五元数组 + 最短前缀。将来别端实现以此对拍。
        assert_eq!(
            hex(&frame_aad(&addr("acct", "dev-a", BROADCAST, Domain::Op))),
            concat!(
                "85",           // array(5)
                "01",           // 1 (PROTO_VER)
                "6461636374",   // "acct"
                "656465762d61", // "dev-a"
                "612a",         // "*"
                "626f70",       // "op"
            )
        );
    }

    #[test]
    fn payload_integers_survive_cbor_round_trip() {
        // payload 数字纪律(codex P2-d 轮 L1):业务整数(seq/bytes/priority…)必须
        // 是 CBOR integer 且经往返仍是整数——i64 全域无损、不漂成 float。float 到达
        // 时 replay 侧 as_i64() 读不出 → Err 挂起,fail-fast 不静默。
        let op = RemoteOp {
            payload: json!({
                "max": i64::MAX,
                "min": i64::MIN,
                "neg": -1,
                "zero": 0,
            }),
            ..match sample_msg() {
                Msg::Ops { mut ops, .. } => ops.remove(0),
                _ => unreachable!(),
            }
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&op, &mut buf).unwrap();
        let back: RemoteOp = ciborium::from_reader(buf.as_slice()).unwrap();
        assert_eq!(back.payload["max"].as_i64(), Some(i64::MAX));
        assert_eq!(back.payload["min"].as_i64(), Some(i64::MIN));
        assert_eq!(back.payload["neg"].as_i64(), Some(-1));
        assert_eq!(back.payload["zero"].as_i64(), Some(0));
        assert!(back.payload["max"].is_i64() && !back.payload["max"].is_f64());
        // float 往返仍是 float(不静默取整):读端 as_i64()=None → 挂起。
        let mut buf = Vec::new();
        ciborium::into_writer(&json!({"n": 42.0}), &mut buf).unwrap();
        let v: serde_json::Value = ciborium::from_reader(buf.as_slice()).unwrap();
        assert!(v["n"].is_f64() && v["n"].as_i64().is_none());
    }

    #[test]
    fn msg_cbor_wire_format_is_pinned() {
        // externally tagged:{"Want": {"origin": "abc", "from_seq": 5}}。
        let mut buf = Vec::new();
        ciborium::into_writer(&Msg::Want { origin: "abc".into(), from_seq: 5 }, &mut buf)
            .unwrap();
        assert_eq!(
            hex(&buf),
            concat!(
                "a1",                 // map(1)
                "6457616e74",         // "Want"
                "a2",                 // map(2)
                "666f726967696e",     // "origin"
                "63616263",           // "abc"
                "6866726f6d5f736571", // "from_seq"
                "05",                 // 5
            )
        );
        // BlobChunk.data 必须是 CBOR bytes(0x43…),不是逐元素数组(serde_bytes 生效)。
        let chunk = Msg::BlobChunk {
            image_id: "i".into(),
            transfer: "t".into(),
            idx: 0,
            last: true,
            data: vec![1, 2, 3],
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&chunk, &mut buf).unwrap();
        assert_eq!(
            hex(&buf),
            concat!(
                "a1",
                "69426c6f624368756e6b", // "BlobChunk"
                "a5",
                "68696d6167655f6964", // "image_id"
                "6169",               // "i"
                "687472616e73666572", // "transfer"
                "6174",               // "t"
                "63696478",           // "idx"
                "00",                 // 0
                "646c617374",         // "last"
                "f5",                 // true
                "6464617461",         // "data"
                "43010203",           // bytes(3) 01 02 03
            )
        );
        // 解回相等(bytes 路径反向也通)。
        let back: Msg = ciborium::from_reader(buf.as_slice()).unwrap();
        assert_eq!(back, chunk);
    }

    // ---- 恢复码 ----

    #[test]
    fn recovery_code_round_trips_and_is_grouped() {
        let mut key = [0u8; 32];
        for (i, b) in key.iter_mut().enumerate() {
            *b = (i as u8) * 7 + 3;
        }
        let code = recovery_code(&key);
        assert_eq!(code.len(), RECOVERY_CHARS + RECOVERY_CHARS / RECOVERY_GROUP - 1);
        assert!(code.split('-').all(|g| g.len() == RECOVERY_GROUP));
        assert!(code
            .chars()
            .all(|c| c == '-' || CROCKFORD.contains(&(c as u8))));
        assert_eq!(parse_recovery_code(&code).unwrap(), key);
    }

    #[test]
    fn recovery_code_parse_accepts_human_variants() {
        let key = k(0); // 全零 → 52 个 '0':别名替换可控。
        let canonical = recovery_code(&key);
        assert_eq!(parse_recovery_code(&canonical.to_lowercase()).unwrap(), key);
        assert_eq!(parse_recovery_code(&canonical.replace('-', " ")).unwrap(), key);
        assert_eq!(parse_recovery_code(&canonical.replace('-', "")).unwrap(), key);
        // Crockford 别名:O→0、I/L→1。
        assert_eq!(parse_recovery_code(&canonical.replace('0', "O")).unwrap(), key);
        assert_eq!(parse_recovery_code(&canonical.replace('0', "o")).unwrap(), key);
        let key1 = {
            // 造一把编码里出现 '1' 的钥:全 0xFF → 'Z' 居多?直接用真往返验证别名:
            // 把规范码中的 '1' 替换成 'I'/'L' 后仍解回原钥。
            let mut kk = [0u8; 32];
            kk[31] = 0x01; // 尾部出 '0…04' 类字符;确保存在可替换字符再断言。
            kk
        };
        let c1 = recovery_code(&key1);
        if c1.contains('1') {
            assert_eq!(parse_recovery_code(&c1.replace('1', "I")).unwrap(), key1);
            assert_eq!(parse_recovery_code(&c1.replace('1', "l")).unwrap(), key1);
        }
    }

    #[test]
    fn recovery_code_rejects_bad_input() {
        let key = k(0);
        let code = recovery_code(&key);
        // 少一字符 / 多一字符。
        assert_eq!(
            parse_recovery_code(&code[..code.len() - 1]),
            Err(RecoveryCodeError::BadLength(RECOVERY_CHARS - 1))
        );
        assert_eq!(
            parse_recovery_code(&format!("{code}0")),
            Err(RecoveryCodeError::BadLength(RECOVERY_CHARS + 1))
        );
        // 字母表外字符(U 被 Crockford 刻意排除)。
        assert_eq!(
            parse_recovery_code(&format!("U{}", &code[1..])),
            Err(RecoveryCodeError::BadChar('U'))
        );
        assert_eq!(
            parse_recovery_code(&format!("@{}", &code[1..])),
            Err(RecoveryCodeError::BadChar('@'))
        );
        // 末字符填充位非 0(全零钥的末字符是 '0',换 '1' 只动填充位)→ 非规范拒。
        let mut chars: Vec<char> = code.chars().collect();
        let last = chars.len() - 1;
        assert_eq!(chars[last], '0');
        chars[last] = '1';
        assert_eq!(
            parse_recovery_code(&chars.iter().collect::<String>()),
            Err(RecoveryCodeError::NonCanonical)
        );
    }
}
