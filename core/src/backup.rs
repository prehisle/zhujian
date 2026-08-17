//! 加密备份(backup-plan 笔①-a)—— **格式层**:`.zjbak` 的封与解。
//!
//! 规格是 [`docs/backup-plan.md`] §4,**本文件是它的唯一实现**;改这里 = 改格式 = 破坏
//! 笔②的恢复能力,必须升魔数里的版本字节。五轮 codex 设计审收口(threadId
//! `01a00a47-4630-7510-9abf-14f328147d47`)。
//!
//! ```text
//! magic   6B   "ZJBAK" 0x01
//! hdr_len 4B   u32 LE(上界 HDR_MAX)
//! hdr     N B  CBOR { v, key_check:8B, salt:16B, chunk:u32 }
//! frames  …    重复 [ kind u8 ][ len u32 LE ][ 密文 ]
//!              kind = 0x00 数据 | 0x01 trailer(恰一帧,必须最后,其后立即 EOF)
//! ```
//!
//! **三条撑着整个安全性的判据**(动之前先读 backup-plan §4「信任根」):
//!
//! 1. **每份文件一把子钥**:`K_file = HKDF-SHA256(ikm = K_backup, salt = 每文件 16B 随机,
//!    info = "zhujian/backup/v1")`。计数器 nonce 之所以合法,**全靠这一条** ——
//!    ⛔ 同一个 salt 绝不许用来加密第二份内容;取随机数失败**不许兜底**(响亮失败、不产文件)。
//! 2. **AAD 绑整个头的原始字节**(`magic ‖ hdr_len ‖ hdr`),不是挑几个字段进。挑字段的话
//!    每加一个头字段都得记得同步 AAD,漏一个就是一个静默可篡改面 —— 一轮设计审的那条 H
//!    正是「`chunk` 既不进 KDF 也不进 AAD ⇒ 改它被静默接受」。
//! 3. **`kind` 进 AAD**:末帧因此有**显式身份**,不靠「读到 EOF 反推」。截断 / 重排 / 删帧 /
//!    复制帧 / 头篡改 / 追加垃圾,一律**整文件验证失败**。
//!    ⚠ 口径是「**整文件**失败」,不是「每一帧都解不开」——别把这句写强(一轮 L)。
//!
//! ⛔ **本格式给不出的两件**(别在文档或 UI 里说过头):①同 salt 重复时,两份文件里 idx 相同
//! 的帧可以互换且认证通过(所以信任根写死在 OS CSPRNG 上);②整份文件被另一份合法文件替换,
//! 自包含格式识别不了 —— 那是「你手上这份是不是你要的那份」的问题,靠文件名与 trailer 里的
//! `created_at` / `space_id` 给人看。

mod config;
mod coordinator;
mod engine;
mod staging;

/// ⭐ **本模块对 crate 外只出这一组名字**(lib.rs 那条窄公开面):壳拿到的是
/// 「备份码字符串」「文件路径」「人话状态」,拿不到 `BackupKey` 的字节,也碰不到
/// 引擎与 staging —— 所有入口必须经 [`BackupCoordinator`]。
pub use coordinator::{
    BackupCoordinator, BackupError, BackupFailed, BackupMade, BackupPaths, BackupReport,
    BackupStatus, Busy, Leftover,
};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

// ---- 格式常量(钉死;改 = 改格式)------------------------------------------------

/// 魔数 6 字节:`ZJBAK` + 版本字节。**版本进魔数**——认不出当场拒,不进 CBOR 里"商量"。
const MAGIC: [u8; 6] = [b'Z', b'J', b'B', b'A', b'K', 0x01];
/// 头 CBOR 的字节上界。头里只有四个定长字段,4 KiB 是**极宽松**的余量;
/// 它的作用是「分配之前先判」,不是"刚好够用"。
const HDR_MAX: u32 = 4096;
/// trailer 明文的字节上界(§8 的那个洞):空间名正常有 200B 上限,但 catalog 读名字那条路
/// **不复跑**那条语义校验,损坏库能给出异常大的字符串 ⇒ 这里必须自己有闸。
const TRAILER_MAX: u32 = 8 * 1024;
/// 默认块大小。⚠ 与 `BOOT_CHUNK_BYTES` **同值是巧合不是约束** —— 那个绑着线协议的帧上界,
/// 这个只是本地文件的分块。各自定名,别耦合。
const CHUNK_DEFAULT: u32 = 256 * 1024;
const CHUNK_MIN: u32 = 4 * 1024;
const CHUNK_MAX: u32 = 4 * 1024 * 1024;
/// Poly1305 标签长度。
const TAG_LEN: u32 = 16;
/// 帧类型:数据 / trailer。**它进 AAD**,翻转即认证失败。
const KIND_DATA: u8 = 0x00;
const KIND_TRAILER: u8 = 0x01;

/// 文件子钥的 HKDF info。
const INFO_FILE: &[u8] = b"zhujian/backup/v1";
/// 验钥凭据的 HKDF info。⭐ 它**也吃 salt** ⇒ `key_check` 每文件不同,
/// 明文里因此**没有跨文件的关联句柄**(一轮 M:恒定 `key_id` 能把同一把钥的所有文件串起来)。
const INFO_KEY_CHECK: &[u8] = b"zhujian/backup/v1/key-check";
/// AAD 首元素(域串)。
const AAD_DOMAIN: &str = "zhujian/backup/v1";

/// 格式版本号(头里的 `v`)。与魔数末字节同步升。
const FORMAT_V: u64 = 1;

const SALT_LEN: usize = 16;
const KEY_CHECK_LEN: usize = 8;

// ---- 密钥 -----------------------------------------------------------------------

/// 备份钥。⛔ **不出 crate**(与 `k_acc` / `device_seed` 同一条窄公开面纪律,lib.rs 头注):
/// 壳拿到的只有「备份码字符串」与「文件路径」,拿不到字节。
struct BackupKey([u8; 32]);

impl BackupKey {
    fn from_bytes(b: [u8; 32]) -> BackupKey {
        BackupKey(b)
    }

    /// 每文件子钥:`HKDF-SHA256(ikm = K_backup, salt, info)`。
    fn file_key(&self, salt: &[u8; SALT_LEN]) -> [u8; 32] {
        let mut okm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(salt), &self.0)
            .expand(INFO_FILE, &mut okm)
            .expect("32B 远在 HKDF-SHA256 输出上限(8160B)内");
        okm
    }

    /// 验钥凭据。HKDF-Expand 的输出是**前缀稳定**的流,所以「expand 到 8B」与
    /// 「expand 到 32B 再取前 8B」等价 —— 规格里写的是后者,这里取前者,同一个值。
    fn key_check(&self, salt: &[u8; SALT_LEN]) -> [u8; KEY_CHECK_LEN] {
        let mut okm = [0u8; KEY_CHECK_LEN];
        Hkdf::<Sha256>::new(Some(salt), &self.0)
            .expand(INFO_KEY_CHECK, &mut okm)
            .expect("8B 远在 HKDF-SHA256 输出上限内");
        okm
    }
}

// ---- 头与 trailer -----------------------------------------------------------------

/// 文件头。⛔ `deny_unknown_fields` + serde 派生的重复键拒绝,是 §4 解析规则第 1 条的落实:
/// **恰好这四个键,类型严格,重复 / 未知一律拒**。
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Header {
    v: u64,
    #[serde(with = "serde_bytes")]
    key_check: Vec<u8>,
    #[serde(with = "serde_bytes")]
    salt: Vec<u8>,
    chunk: u32,
}

/// 末帧明文:元数据**在密文里**,文件名之外不泄露用户信息(§9 的那张泄露表)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Trailer {
    pub plain_bytes: u64,
    #[serde(with = "serde_bytes")]
    pub plain_sha256: Vec<u8>,
    pub space_id: String,
    pub space_name: Option<String>,
    pub created_at: String,
    pub app_version: String,
    pub user_version: i64,
}

/// 造 trailer 时由调用方给的那几格(`plain_bytes` / `plain_sha256` 由写入过程自己算出来,
/// 不许调用方传 —— 传了就有"两份描述"的漂移面)。
#[derive(Debug, Clone)]
struct TrailerMeta {
    pub space_id: String,
    pub space_name: Option<String>,
    pub created_at: String,
    pub app_version: String,
    pub user_version: i64,
}

// ---- 读侧的错误分档 ----------------------------------------------------------------

/// ⭐ **分三档是给测试用的**(§10 的通用纪律):每只测都要断到「失败发生在哪一阶段」,
/// 只断 `is_err()` 会被同一条路上更靠后的另一道闸背书成绿。
#[derive(Debug, PartialEq, Eq)]
enum ReadError {
    /// 结构闸:魔数 / 长度 / 帧序 / 未知键 / trailer 不在末尾 / 其后还有字节。
    Parse(String),
    /// AEAD 认证失败(篡改、换帧、改头、翻 kind)。
    Auth,
    /// 全部解完之后,长度或哈希对不上。
    Digest,
    /// `key_check` 不符 —— 「**这份不是这把钥的**」,不是含糊的解密失败。
    WrongKey,
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Parse(m) => write!(f, "备份文件结构不对:{m}"),
            ReadError::Auth => write!(f, "备份文件认证失败(被改过,或不是这把钥的)"),
            ReadError::Digest => write!(f, "备份文件长度或校验和对不上"),
            ReadError::WrongKey => write!(f, "这份备份不是当前备份码对应的"),
        }
    }
}

// ---- AAD 与 nonce -------------------------------------------------------------------

/// `AAD = CBOR [ 域串, bstr(magic ‖ hdr_len_le ‖ hdr 原始字节), idx, kind ]`。
///
/// ⭐ 绑的是**原始字节**而不是解析后的字段:CBOR 换序 / 非规范整数 / 加未知键,一律改变
/// 这段 bstr ⇒ 认证失败。**加新头字段不会漏绑**,这是结构性的。
fn frame_aad(hdr_frame: &[u8], idx: u64, kind: u8) -> Vec<u8> {
    let mut out = Vec::new();
    ciborium::into_writer(
        &(AAD_DOMAIN, serde_bytes::Bytes::new(hdr_frame), idx, kind),
        &mut out,
    )
    .expect("CBOR 编码进内存 Vec 无失败路径");
    out
}

/// `nonce = 0x00 × 16 ‖ idx(u64 LE)`。**合法只因为子钥每文件唯一**(见文件头注判据 1)。
fn nonce_for(idx: u64) -> XNonce {
    let mut n = [0u8; 24];
    n[16..].copy_from_slice(&idx.to_le_bytes());
    *XNonce::from_slice(&n)
}

// ---- 帧长闸(纯函数,单独可测)---------------------------------------------------

/// 帧密文长度闸:**分配之前判**。
///
/// ⭐ 单独成函数是为了让 §10 的 5e 能**直接测它** —— 造一个 4 GiB 的样本去看「最后返回了
/// Err」证明不了「先判再分配」(三轮 M4)。
fn checked_frame_len(kind: u8, len: u32, chunk: u32) -> Result<usize, ReadError> {
    let cap = match kind {
        KIND_DATA => chunk.saturating_add(TAG_LEN),
        KIND_TRAILER => TRAILER_MAX.saturating_add(TAG_LEN),
        other => {
            return Err(ReadError::Parse(format!("帧类型 {other} 不认识(只许 0x00 / 0x01)")))
        }
    };
    if len < TAG_LEN {
        return Err(ReadError::Parse(format!("帧长 {len} 比认证标签还短")));
    }
    if len > cap {
        return Err(ReadError::Parse(format!("帧长 {len} 超上界 {cap}")));
    }
    Ok(len as usize)
}

/// 头长闸,同上。
fn checked_hdr_len(len: u32) -> Result<usize, ReadError> {
    if len == 0 {
        return Err(ReadError::Parse("头长为 0".into()));
    }
    if len > HDR_MAX {
        return Err(ReadError::Parse(format!("头长 {len} 超上界 {HDR_MAX}")));
    }
    Ok(len as usize)
}

fn checked_chunk(chunk: u32) -> Result<(), ReadError> {
    if !(CHUNK_MIN..=CHUNK_MAX).contains(&chunk) {
        return Err(ReadError::Parse(format!(
            "块大小 {chunk} 不在 [{CHUNK_MIN}, {CHUNK_MAX}] 内"
        )));
    }
    Ok(())
}

// ---- 写 ---------------------------------------------------------------------------

/// 把 `plain` 流式封成 `.zjbak` 写进 `out`,返回 trailer(内含算出来的长度与哈希)。
///
/// **内存 O(块)**:同时活着的只有「一块明文 + 一块密文」= `2 × chunk + 16`(§8)。
///
/// ⚠ `salt` 由调用方给 —— 生产侧必须**每建一份文件当场新取 16B OsRng**;测试侧固定 salt
/// 才能做黄金向量。⛔ 生产侧绝不许复用(文件头注判据 1)。
fn write_backup<R: Read, W: Write>(
    plain: &mut R,
    out: &mut W,
    key: &BackupKey,
    salt: [u8; SALT_LEN],
    chunk: u32,
    meta: &TrailerMeta,
) -> Result<Trailer, String> {
    checked_chunk(chunk).map_err(|e| e.to_string())?;

    let hdr = Header {
        v: FORMAT_V,
        key_check: key.key_check(&salt).to_vec(),
        salt: salt.to_vec(),
        chunk,
    };
    let mut hdr_bytes = Vec::new();
    ciborium::into_writer(&hdr, &mut hdr_bytes).expect("CBOR 编码进内存 Vec 无失败路径");
    let hdr_len = u32::try_from(hdr_bytes.len()).map_err(|_| "头过长".to_string())?;
    checked_hdr_len(hdr_len).map_err(|e| e.to_string())?;

    // AAD 绑的这一段 = magic ‖ hdr_len ‖ hdr,与落盘的前缀逐字节相同。
    let mut hdr_frame = Vec::with_capacity(MAGIC.len() + 4 + hdr_bytes.len());
    hdr_frame.extend_from_slice(&MAGIC);
    hdr_frame.extend_from_slice(&hdr_len.to_le_bytes());
    hdr_frame.extend_from_slice(&hdr_bytes);
    out.write_all(&hdr_frame).map_err(|e| format!("写备份头失败:{e}"))?;

    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.file_key(&salt)));
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; chunk as usize];
    let mut total: u64 = 0;
    let mut idx: u64 = 0;

    loop {
        let n = read_full(plain, &mut buf).map_err(|e| format!("读明文失败:{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total = total.checked_add(n as u64).ok_or("明文长度溢出 u64")?;
        write_frame(out, &cipher, &hdr_frame, idx, KIND_DATA, &buf[..n])?;
        idx = idx.checked_add(1).ok_or("帧序号溢出 u64(拒绝回绕)")?;
        if n < buf.len() {
            break; // 读到尾了
        }
    }

    let trailer = Trailer {
        plain_bytes: total,
        plain_sha256: hasher.finalize().to_vec(),
        space_id: meta.space_id.clone(),
        space_name: meta.space_name.clone(),
        created_at: meta.created_at.clone(),
        app_version: meta.app_version.clone(),
        user_version: meta.user_version,
    };
    let mut tbytes = Vec::new();
    ciborium::into_writer(&trailer, &mut tbytes).expect("CBOR 编码进内存 Vec 无失败路径");
    if tbytes.len() > TRAILER_MAX as usize {
        return Err(format!("trailer {} 字节,超上界 {TRAILER_MAX}", tbytes.len()));
    }
    write_frame(out, &cipher, &hdr_frame, idx, KIND_TRAILER, &tbytes)?;
    out.flush().map_err(|e| format!("刷写备份失败:{e}"))?;
    Ok(trailer)
}

fn write_frame<W: Write>(
    out: &mut W,
    cipher: &XChaCha20Poly1305,
    hdr_frame: &[u8],
    idx: u64,
    kind: u8,
    plain: &[u8],
) -> Result<(), String> {
    let ct = cipher
        .encrypt(
            &nonce_for(idx),
            Payload { msg: plain, aad: &frame_aad(hdr_frame, idx, kind) },
        )
        .expect("XChaCha20-Poly1305 加密无失败路径");
    let len = u32::try_from(ct.len()).map_err(|_| "帧过长".to_string())?;
    out.write_all(&[kind]).map_err(|e| format!("写帧类型失败:{e}"))?;
    out.write_all(&len.to_le_bytes()).map_err(|e| format!("写帧长失败:{e}"))?;
    out.write_all(&ct).map_err(|e| format!("写帧失败:{e}"))?;
    Ok(())
}

// ---- 读 ---------------------------------------------------------------------------

/// 解一份 `.zjbak`:逐帧解进 `out`,末尾比对 `plain_bytes` 与 `plain_sha256` **两格**。
///
/// 自验(§3 幕⑦)= 拿 `std::io::sink()` 当 `out` 调它 —— **同一条路**,不另写一份校验逻辑
/// (checklist §14:同一条规则的第二份描述就是漂移源)。
fn read_backup<R: Read, W: Write>(
    src: &mut R,
    out: &mut W,
    key: &BackupKey,
) -> Result<Trailer, ReadError> {
    // ---- 头 ----
    let mut magic = [0u8; 6];
    read_exact(src, &mut magic)?;
    if magic != MAGIC {
        return Err(ReadError::Parse("魔数不对,这不是朱简备份文件(或版本不同)".into()));
    }
    let mut lenb = [0u8; 4];
    read_exact(src, &mut lenb)?;
    let hdr_len = u32::from_le_bytes(lenb);
    let hdr_n = checked_hdr_len(hdr_len)?;
    let mut hdr_bytes = vec![0u8; hdr_n];
    read_exact(src, &mut hdr_bytes)?;

    let hdr: Header = ciborium::from_reader(hdr_bytes.as_slice())
        .map_err(|e| ReadError::Parse(format!("头解码失败(未知键 / 重复键 / 类型不符):{e}")))?;
    if hdr.v != FORMAT_V {
        return Err(ReadError::Parse(format!("格式版本 {} 不认识", hdr.v)));
    }
    if hdr.salt.len() != SALT_LEN || hdr.key_check.len() != KEY_CHECK_LEN {
        return Err(ReadError::Parse("头里的 salt / key_check 长度不对".into()));
    }
    checked_chunk(hdr.chunk)?;
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&hdr.salt);

    // ⭐ 先验钥:这样「不是这把钥的」能报得明确,而不是含糊的解密失败。
    if key.key_check(&salt).as_slice() != hdr.key_check.as_slice() {
        return Err(ReadError::WrongKey);
    }

    let mut hdr_frame = Vec::with_capacity(MAGIC.len() + 4 + hdr_bytes.len());
    hdr_frame.extend_from_slice(&MAGIC);
    hdr_frame.extend_from_slice(&hdr_len.to_le_bytes());
    hdr_frame.extend_from_slice(&hdr_bytes);

    // ---- 帧 ----
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.file_key(&salt)));
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut idx: u64 = 0;

    loop {
        let mut kindb = [0u8; 1];
        match src.read(&mut kindb) {
            Ok(0) => {
                // 读到 EOF 却还没见过 trailer。
                return Err(ReadError::Parse("文件在 trailer 之前就结束了(被截断?)".into()));
            }
            Ok(_) => {}
            Err(e) => return Err(ReadError::Parse(format!("读帧类型失败:{e}"))),
        }
        let kind = kindb[0];
        let mut lenb = [0u8; 4];
        read_exact(src, &mut lenb)?;
        let n = checked_frame_len(kind, u32::from_le_bytes(lenb), hdr.chunk)?;
        let mut ct = vec![0u8; n];
        read_exact(src, &mut ct)?;

        let plain = cipher
            .decrypt(
                &nonce_for(idx),
                Payload { msg: &ct, aad: &frame_aad(&hdr_frame, idx, kind) },
            )
            .map_err(|_| ReadError::Auth)?;

        if kind == KIND_TRAILER {
            // trailer 之后必须立即 EOF —— 挡「追加垃圾 / 再拼一整份合法文件」。
            let mut extra = [0u8; 1];
            match src.read(&mut extra) {
                Ok(0) => {}
                Ok(_) => {
                    return Err(ReadError::Parse("trailer 之后还有字节(追加了东西?)".into()))
                }
                Err(e) => return Err(ReadError::Parse(format!("读 trailer 尾失败:{e}"))),
            }
            let t: Trailer = ciborium::from_reader(plain.as_slice())
                .map_err(|e| ReadError::Parse(format!("trailer 解码失败:{e}")))?;
            if t.plain_bytes != total || t.plain_sha256.as_slice() != hasher.finalize().as_slice() {
                return Err(ReadError::Digest);
            }
            return Ok(t);
        }

        hasher.update(&plain);
        total = total
            .checked_add(plain.len() as u64)
            .ok_or_else(|| ReadError::Parse("明文长度溢出 u64".into()))?;
        out.write_all(&plain).map_err(|e| ReadError::Parse(format!("写出明文失败:{e}")))?;
        idx = idx
            .checked_add(1)
            .ok_or_else(|| ReadError::Parse("帧序号溢出 u64".into()))?;
    }
}

/// 自验:把一份落好的 `.zjbak` 整个读回来解一遍,明文丢进 `io::sink()`。
///
/// ⛔ **走的是与恢复完全同一条路**([`read_backup`]),不另写一份校验逻辑
/// (checklist §14:同一条规则的第二份描述就是漂移源)——所以「自验过了」与「笔②解得开」
/// 是同一件事,不是两件长得像的事。
///
/// ⛔ **不抽验**:「备份成功」这四个字的意思就是「每帧可认证 + 末帧读得出 + 长度与哈希
/// 都相符」,抽验背书不了这个口径。
/// ⚠ 它证明的是「**刚写出的这个逻辑文件完整可读**」(很可能读的还是 page cache),
/// **不是**「介质经历断电之后这份文件还完好」。别把它说成后者。
fn verify_file(path: &std::path::Path, key: &BackupKey) -> Result<Trailer, ReadError> {
    let mut f = std::fs::File::open(path)
        .map_err(|e| ReadError::Parse(format!("打开备份文件失败:{e}")))?;
    read_backup(&mut f, &mut std::io::sink(), key)
}

// ---- 小工具 -------------------------------------------------------------------------

/// 读满 `buf` 或读到 EOF,返回读到的字节数(`Read::read` 允许短读,直接用会把一块切碎)。
fn read_full<R: Read>(r: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

fn read_exact<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<(), ReadError> {
    let n = read_full(r, buf).map_err(|e| ReadError::Parse(format!("读失败:{e}")))?;
    if n != buf.len() {
        return Err(ReadError::Parse(format!(
            "文件提前结束(还差 {} 字节)",
            buf.len() - n
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
