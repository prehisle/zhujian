//! 格式层的测试(backup-plan §10 里落在纯格式上的那些)。
//!
//! ⭐ **通用纪律**(三轮设计审 M4 逼出来的):每只测都要断到「失败发生在**哪一阶段**」——
//! `Parse`(结构闸)/ `Auth`(AEAD)/ `Digest`(末尾比对)/ `WrongKey`。
//! ⛔ 只断 `is_err()` 会被**同一条路上更靠后的另一道闸**背书成绿,那是假绿不是测试。

use super::*;
use ciborium::value::Value;

const KEY_A: [u8; 32] = [7u8; 32];
const KEY_B: [u8; 32] = [9u8; 32];
const SALT_A: [u8; SALT_LEN] = [3u8; SALT_LEN];
/// 小块:让几百字节的样本也能造出**多帧**(单帧的话「重排 / 删中间帧」根本无从测起)。
const SMALL_CHUNK: u32 = CHUNK_MIN;

fn meta() -> TrailerMeta {
    TrailerMeta {
        space_id: "main".into(),
        space_name: Some("书房".into()),
        created_at: "2026-08-16T00:00:00Z".into(),
        app_version: "0.2.33".into(),
        user_version: 35,
    }
}

/// 造一份正常文件。`plain` 长度刻意跨过好几个块。
fn make(plain: &[u8], key: &BackupKey, salt: [u8; SALT_LEN], chunk: u32) -> Vec<u8> {
    let mut out = Vec::new();
    write_backup(&mut &plain[..], &mut out, key, salt, chunk, &meta()).expect("写备份");
    out
}

fn sample_plain(n: usize) -> Vec<u8> {
    // 别用全 0:那样"帧被换成另一帧"这类篡改可能碰巧还原成同样的明文。
    (0..n).map(|i| (i % 251) as u8).collect()
}

fn read(bytes: &[u8], key: &BackupKey) -> Result<(Trailer, Vec<u8>), ReadError> {
    let mut out = Vec::new();
    let t = read_backup(&mut &bytes[..], &mut out, key)?;
    Ok((t, out))
}

/// 头在文件里的位置:`magic(6) ‖ hdr_len(4) ‖ hdr`。
fn hdr_span(bytes: &[u8]) -> std::ops::Range<usize> {
    let n = u32::from_le_bytes(bytes[6..10].try_into().unwrap()) as usize;
    10..10 + n
}

/// 把头解成通用 CBOR Value,交给回调改,再按新长度写回去(`hdr_len` 一并更新)。
fn remap_header(bytes: &[u8], f: impl FnOnce(&mut Vec<(Value, Value)>)) -> Vec<u8> {
    let span = hdr_span(bytes);
    let v: Value = ciborium::from_reader(&bytes[span.clone()]).unwrap();
    let Value::Map(mut m) = v else { panic!("头不是 map") };
    f(&mut m);
    let mut re = Vec::new();
    ciborium::into_writer(&Value::Map(m), &mut re).unwrap();
    let mut out = Vec::new();
    out.extend_from_slice(&bytes[..6]);
    out.extend_from_slice(&(re.len() as u32).to_le_bytes());
    out.extend_from_slice(&re);
    out.extend_from_slice(&bytes[span.end..]);
    out
}

/// 逐帧切出 `(kind, 帧整段字节)`,供「重排 / 删 / 复制」这几只用。
fn split_frames(bytes: &[u8]) -> (Vec<u8>, Vec<(u8, Vec<u8>)>) {
    let span = hdr_span(bytes);
    let head = bytes[..span.end].to_vec();
    let mut frames = Vec::new();
    let mut p = span.end;
    while p < bytes.len() {
        let kind = bytes[p];
        let n = u32::from_le_bytes(bytes[p + 1..p + 5].try_into().unwrap()) as usize;
        frames.push((kind, bytes[p..p + 5 + n].to_vec()));
        p += 5 + n;
    }
    (head, frames)
}

fn join(head: &[u8], frames: &[(u8, Vec<u8>)]) -> Vec<u8> {
    let mut out = head.to_vec();
    for (_, f) in frames {
        out.extend_from_slice(f);
    }
    out
}

// ---- 1 往返 ------------------------------------------------------------------------

#[test]
fn round_trip_recovers_the_exact_bytes() {
    let key = BackupKey::from_bytes(KEY_A);
    let plain = sample_plain(SMALL_CHUNK as usize * 3 + 777); // 刻意不是整块
    let file = make(&plain, &key, SALT_A, SMALL_CHUNK);
    let (t, got) = read(&file, &key).expect("解得开");
    assert_eq!(got, plain, "解出来的明文要逐字节相同");
    assert_eq!(t.plain_bytes, plain.len() as u64);
    assert_eq!(t.space_id, "main");
    assert_eq!(t.space_name.as_deref(), Some("书房"));
}

#[test]
fn round_trip_handles_empty_and_single_byte() {
    let key = BackupKey::from_bytes(KEY_A);
    for n in [0usize, 1, SMALL_CHUNK as usize] {
        let plain = sample_plain(n);
        let file = make(&plain, &key, SALT_A, SMALL_CHUNK);
        let (t, got) = read(&file, &key).unwrap_or_else(|e| panic!("n={n} 解不开:{e}"));
        assert_eq!(got, plain, "n={n}");
        assert_eq!(t.plain_bytes, n as u64, "n={n}");
    }
}

// ---- 1b 黄金向量 --------------------------------------------------------------------

/// ⭐ **没有它,encoder 与 decoder 会一起漂移而往返照样全绿**(三轮 M4)——
/// 而 §4 是要给笔②当规格的,漂了就毁约。
///
/// 钉死的输入:钥 / salt / **chunk** / 明文 / **trailer 的全部元数据**。
/// ⛔ 这个哈希变了 = 线上格式变了 = **必须升魔数里的版本字节**,不是"改个测试期望值"。
#[test]
fn golden_vector_is_byte_stable() {
    let key = BackupKey::from_bytes(KEY_A);
    let file = make(&sample_plain(5000), &key, SALT_A, SMALL_CHUNK);

    // ⭐ 先断**形**再断哈希:一个裸哈希红了,下一个人看不出「到底哪儿变了」。
    assert_eq!(&file[..6], &MAGIC, "魔数");
    let (_, frames) = split_frames(&file);
    assert_eq!(frames.len(), 3, "5000 字节 / 4096 一块 = 两个数据帧 + 一个 trailer");
    assert_eq!(frames[0].0, KIND_DATA);
    assert_eq!(frames[2].0, KIND_TRAILER);
    assert_eq!(frames[0].1.len(), 5 + SMALL_CHUNK as usize + TAG_LEN as usize, "满块帧的总长");

    let digest = Sha256::digest(&file);
    assert_eq!(
        hex(&digest),
        "840e1e08f74c7c1c494a1f8e595d79a54fe5d39f943f757a8cfbb50b2989da3a",
        "格式字节变了。若这是有意改格式,先升 MAGIC 末字节,再改这个期望值"
    );
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---- 2 缺 trailer ------------------------------------------------------------------

/// ⚠ 三轮纠过:这只**只钉「缺 trailer 必拒」**。
/// ⛔ 别声称它钉住了「`kind` 进 AAD」—— 那是结构闸先拒的,`kind` 从 AAD 里删掉它照样绿。
/// 钉 AAD 的是下面的 `frame_kind_is_bound_into_aad`。
#[test]
fn missing_trailer_is_rejected_by_the_structure_gate() {
    let key = BackupKey::from_bytes(KEY_A);
    let file = make(&sample_plain(9000), &key, SALT_A, SMALL_CHUNK);
    let (head, mut frames) = split_frames(&file);
    assert_eq!(frames.last().unwrap().0, KIND_TRAILER, "夹具前提:末帧是 trailer");
    frames.pop();
    match read(&join(&head, &frames), &key) {
        Err(ReadError::Parse(_)) => {}
        other => panic!("砍掉 trailer 必须结构闸拒,实得 {other:?}"),
    }
}

// ---- 3 重排 -------------------------------------------------------------------------

#[test]
fn swapping_two_data_frames_fails_authentication() {
    let key = BackupKey::from_bytes(KEY_A);
    let file = make(&sample_plain(SMALL_CHUNK as usize * 3), &key, SALT_A, SMALL_CHUNK);
    let (head, mut frames) = split_frames(&file);
    assert!(frames.len() >= 4, "夹具前提:至少三个数据帧 + trailer");
    frames.swap(0, 1);
    // ⭐ 断 Auth,不是断 Err:只断 Err 的话,末尾 plain_sha256 那道闸也能代答。
    assert_eq!(read(&join(&head, &frames), &key).unwrap_err(), ReadError::Auth);
}

#[test]
fn deleting_a_middle_frame_fails_authentication() {
    let key = BackupKey::from_bytes(KEY_A);
    let file = make(&sample_plain(SMALL_CHUNK as usize * 3), &key, SALT_A, SMALL_CHUNK);
    let (head, mut frames) = split_frames(&file);
    frames.remove(1);
    assert_eq!(read(&join(&head, &frames), &key).unwrap_err(), ReadError::Auth);
}

// ---- 4 错钥 -------------------------------------------------------------------------

#[test]
fn wrong_key_says_wrong_key_not_just_decrypt_failed() {
    let file = make(&sample_plain(3000), &BackupKey::from_bytes(KEY_A), SALT_A, SMALL_CHUNK);
    assert_eq!(
        read(&file, &BackupKey::from_bytes(KEY_B)).unwrap_err(),
        ReadError::WrongKey,
        "要报「不是这把钥的」,不是含糊的解密失败"
    );
}

// ---- 5 翻一位 -----------------------------------------------------------------------

#[test]
fn flipping_one_ciphertext_bit_fails_authentication() {
    let key = BackupKey::from_bytes(KEY_A);
    let mut file = make(&sample_plain(3000), &key, SALT_A, SMALL_CHUNK);
    let span = hdr_span(&file);
    let target = span.end + 8; // 第一帧密文里
    file[target] ^= 0x01;
    assert_eq!(read(&file, &key).unwrap_err(), ReadError::Auth);
}

// ---- 5a 改 header 里的 chunk ---------------------------------------------------------

/// ⭐ **这只是一轮那条 H 的守门人**:AAD 若退回「只绑 key_check/idx/kind」,`chunk` 就既不进
/// KDF 也不进 AAD,改它会被**静默接受**。
///
/// ⚠ 样本讲究(三轮点名):改成的值必须**仍在合法区间**、**CBOR 仍合法**、且**大于实际帧长**
/// —— 否则拒它的是长度闸 / 区间闸,不是 AAD。
#[test]
fn tampering_chunk_in_header_fails_authentication() {
    let key = BackupKey::from_bytes(KEY_A);
    let file = make(&sample_plain(9000), &key, SALT_A, SMALL_CHUNK);
    let bumped = remap_header(&file, |m| {
        for (k, v) in m.iter_mut() {
            if k == &Value::Text("chunk".into()) {
                *v = Value::Integer((SMALL_CHUNK + 1).into());
            }
        }
    });
    // 自证样本落在该落的格上:新值仍合法、且比真实帧大。
    assert!((CHUNK_MIN..=CHUNK_MAX).contains(&(SMALL_CHUNK + 1)));
    assert_eq!(read(&bumped, &key).unwrap_err(), ReadError::Auth);
}

// ---- 5b header 重编码 ----------------------------------------------------------------

/// ⭐ **这只才是钉「AAD 绑的是 header 原始字节」的那只**:字段换序之后语义完全相同、
/// 解码照样成功,唯一能拒它的就是 AAD。
#[test]
fn reordering_header_fields_fails_authentication() {
    let key = BackupKey::from_bytes(KEY_A);
    let file = make(&sample_plain(3000), &key, SALT_A, SMALL_CHUNK);
    let reordered = remap_header(&file, |m| m.reverse());
    // 自证:换序后的头**解得开**(所以拒它的不是解析闸)。
    let span = hdr_span(&reordered);
    let v: Result<Header, _> = ciborium::from_reader(&reordered[span]);
    assert!(v.is_ok(), "换序后的头本身应当仍可解码,否则这只测钉的是解析闸不是 AAD");
    assert_eq!(read(&reordered, &key).unwrap_err(), ReadError::Auth);
}

/// 未知键 / 重复键由**解析规则**拒 —— 与 AAD 无关,故与上面那只分开(三轮 M4)。
#[test]
fn unknown_or_duplicate_header_keys_are_rejected_by_the_parser() {
    let key = BackupKey::from_bytes(KEY_A);
    let file = make(&sample_plain(3000), &key, SALT_A, SMALL_CHUNK);

    let with_unknown = remap_header(&file, |m| {
        m.push((Value::Text("extra".into()), Value::Integer(1.into())));
    });
    match read(&with_unknown, &key) {
        Err(ReadError::Parse(_)) => {}
        other => panic!("未知键必须被解析闸拒,实得 {other:?}"),
    }

    let with_dup = remap_header(&file, |m| {
        let first = m[0].clone();
        m.push(first);
    });
    match read(&with_dup, &key) {
        Err(ReadError::Parse(_)) => {}
        other => panic!("重复键必须被解析闸拒,实得 {other:?}"),
    }
}

// ---- 5c′ 帧级:kind 进 AAD -------------------------------------------------------------

/// ⭐ **三轮判「端到端翻 kind」根本造不出来**:合法 kind 序列恒是 `0,0,…,0,1`,
/// `0→1` 必出现两个 trailer、`1→0` 必没有 trailer ⇒ 结构闸**必然**先代答。
/// ⇒ 钉「`kind` 进 AAD」只能在**帧级**做:同一把 key / nonce / idx / 密文,只换 `kind` 去解。
#[test]
fn frame_kind_is_bound_into_aad() {
    let key = BackupKey::from_bytes(KEY_A);
    let hdr_frame = b"pretend-header-bytes";
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.file_key(&SALT_A)));
    let idx = 5u64;
    let plain = b"hello";

    let ct = cipher
        .encrypt(
            &nonce_for(idx),
            Payload { msg: plain.as_slice(), aad: &frame_aad(hdr_frame, idx, KIND_DATA) },
        )
        .unwrap();

    // 同 key / nonce / idx / 密文,只把 kind 换成 trailer:
    let as_trailer = cipher.decrypt(
        &nonce_for(idx),
        Payload { msg: &ct, aad: &frame_aad(hdr_frame, idx, KIND_TRAILER) },
    );
    assert!(as_trailer.is_err(), "换了 kind 就必须解不开 —— 否则 kind 没进 AAD");

    // 对照组:kind 不变时解得开(证明失败确实是 kind 造成的,不是别的)。
    let same = cipher.decrypt(
        &nonce_for(idx),
        Payload { msg: &ct, aad: &frame_aad(hdr_frame, idx, KIND_DATA) },
    );
    assert_eq!(same.unwrap(), plain);
}

/// 同族:`idx` 也必须进 AAD(不然帧可以整体平移)。
#[test]
fn frame_idx_is_bound_into_aad() {
    let key = BackupKey::from_bytes(KEY_A);
    let hdr_frame = b"pretend-header-bytes";
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.file_key(&SALT_A)));
    let ct = cipher
        .encrypt(&nonce_for(1), Payload { msg: b"x".as_slice(), aad: &frame_aad(hdr_frame, 1, KIND_DATA) })
        .unwrap();
    // 只改 AAD 里的 idx(nonce 仍用 1):单独证明 AAD 那一半在起作用。
    assert!(cipher
        .decrypt(&nonce_for(1), Payload { msg: &ct, aad: &frame_aad(hdr_frame, 2, KIND_DATA) })
        .is_err());
}

// ---- 5d trailer 之后追加 --------------------------------------------------------------

#[test]
fn trailing_garbage_after_trailer_is_rejected() {
    let key = BackupKey::from_bytes(KEY_A);
    let file = make(&sample_plain(3000), &key, SALT_A, SMALL_CHUNK);

    let mut with_garbage = file.clone();
    with_garbage.push(0x00);
    match read(&with_garbage, &key) {
        Err(ReadError::Parse(_)) => {}
        other => panic!("trailer 后追加一个字节就要拒,实得 {other:?}"),
    }

    // 更凶的一形:后面拼一整份**合法**文件。
    let mut two = file.clone();
    two.extend_from_slice(&file);
    match read(&two, &key) {
        Err(ReadError::Parse(_)) => {}
        other => panic!("拼第二份合法文件也要拒,实得 {other:?}"),
    }
}

// ---- 5e / 5f 长度闸(纯函数直测)-------------------------------------------------------

/// ⭐ 三轮 M4:⛔ **别造 4 GiB 的样本去看「最后返回了 Err」** —— 那证明不了「先判再分配」。
/// 直接测那个纯函数。
#[test]
fn length_gates_reject_before_allocating() {
    // 数据帧:上界 = chunk + tag
    assert!(checked_frame_len(KIND_DATA, CHUNK_DEFAULT + TAG_LEN, CHUNK_DEFAULT).is_ok());
    assert!(matches!(
        checked_frame_len(KIND_DATA, CHUNK_DEFAULT + TAG_LEN + 1, CHUNK_DEFAULT),
        Err(ReadError::Parse(_))
    ));
    // u32::MAX 这种"撑爆"的值:在**判断阶段**就拒,不会走到分配。
    assert!(matches!(
        checked_frame_len(KIND_DATA, u32::MAX, CHUNK_DEFAULT),
        Err(ReadError::Parse(_))
    ));
    // 比标签还短 = 不可能合法。
    assert!(matches!(checked_frame_len(KIND_DATA, TAG_LEN - 1, CHUNK_DEFAULT), Err(ReadError::Parse(_))));
    // 不认识的 kind。
    assert!(matches!(checked_frame_len(0x02, 100, CHUNK_DEFAULT), Err(ReadError::Parse(_))));

    // trailer 有**自己的**上界(§8 那个洞):它不跟着 chunk 走。
    assert!(checked_frame_len(KIND_TRAILER, TRAILER_MAX + TAG_LEN, CHUNK_DEFAULT).is_ok());
    assert!(matches!(
        checked_frame_len(KIND_TRAILER, TRAILER_MAX + TAG_LEN + 1, CHUNK_DEFAULT),
        Err(ReadError::Parse(_))
    ));
    // ⭐ 反向自证:trailer 的闸**不是**由 chunk 代答的 —— chunk 很大时它照样卡在 8 KiB。
    assert!(matches!(
        checked_frame_len(KIND_TRAILER, CHUNK_MAX, CHUNK_MAX),
        Err(ReadError::Parse(_))
    ));

    // 头长闸
    assert!(checked_hdr_len(HDR_MAX).is_ok());
    assert!(matches!(checked_hdr_len(HDR_MAX + 1), Err(ReadError::Parse(_))));
    assert!(matches!(checked_hdr_len(0), Err(ReadError::Parse(_))));
    assert!(matches!(checked_hdr_len(u32::MAX), Err(ReadError::Parse(_))));
}

#[test]
fn chunk_out_of_range_is_rejected_both_ways() {
    assert!(checked_chunk(CHUNK_MIN).is_ok());
    assert!(checked_chunk(CHUNK_MAX).is_ok());
    assert!(matches!(checked_chunk(CHUNK_MIN - 1), Err(ReadError::Parse(_))));
    assert!(matches!(checked_chunk(CHUNK_MAX + 1), Err(ReadError::Parse(_))));
}

// ---- 11 key_check 每文件不同 -----------------------------------------------------------

/// 一轮 M:恒定 `key_id` 是明文里的**跨文件关联句柄**(第三方能把同一把钥的所有文件、
/// 所有空间串成一串)。改成每文件派生之后,这只钉住它**真的每份不同**、且**都还认得出**。
#[test]
fn key_check_differs_per_file_yet_still_identifies_the_key() {
    let key = BackupKey::from_bytes(KEY_A);
    let f1 = make(&sample_plain(100), &key, [1u8; SALT_LEN], SMALL_CHUNK);
    let f2 = make(&sample_plain(100), &key, [2u8; SALT_LEN], SMALL_CHUNK);

    let kc = |f: &[u8]| {
        let span = hdr_span(f);
        let h: Header = ciborium::from_reader(&f[span]).unwrap();
        h.key_check
    };
    assert_ne!(kc(&f1), kc(&f2), "同一把钥的两份文件不许共用一个明文凭据");

    // 两份都仍能被这把钥认出来(不是靠"认不出"实现的不可关联)。
    assert!(read(&f1, &key).is_ok());
    assert!(read(&f2, &key).is_ok());
    // 换把钥:两份都报 WrongKey。
    assert_eq!(read(&f1, &BackupKey::from_bytes(KEY_B)).unwrap_err(), ReadError::WrongKey);
    assert_eq!(read(&f2, &BackupKey::from_bytes(KEY_B)).unwrap_err(), ReadError::WrongKey);
}

/// 同族:salt 变了,**子钥**也必须跟着变(不然"每文件一把子钥"就是空话,而计数器 nonce
/// 的合法性全靠它)。
#[test]
fn file_key_depends_on_salt() {
    let key = BackupKey::from_bytes(KEY_A);
    assert_ne!(key.file_key(&[1u8; SALT_LEN]), key.file_key(&[2u8; SALT_LEN]));
    // 且与验钥凭据是**分离**的派生(同 salt 下两者不相干)。
    let fk = key.file_key(&SALT_A);
    assert_ne!(&fk[..KEY_CHECK_LEN], &key.key_check(&SALT_A)[..]);
}

// ---- 14 plain_bytes 与 plain_sha256 各自都必要 --------------------------------------------

/// ⭐ 三轮 M4:两道末尾闸要**各篡改一只**,证明**两道都必要** ——
/// 只留一道时另一道要红。用私有件手工造一份 trailer 说谎的文件。
#[test]
fn both_trailer_digest_fields_are_load_bearing() {
    let key = BackupKey::from_bytes(KEY_A);
    let plain = sample_plain(3000);

    for (tag, doctor) in [
        ("长度说谎", (|t: &mut Trailer| t.plain_bytes += 1) as fn(&mut Trailer)),
        ("哈希说谎", |t: &mut Trailer| t.plain_sha256[0] ^= 0xFF),
    ] {
        let file = craft_with_doctored_trailer(&plain, &key, SALT_A, SMALL_CHUNK, doctor);
        assert_eq!(
            read(&file, &key).unwrap_err(),
            ReadError::Digest,
            "{tag}:必须在末尾比对那一档拒"
        );
    }
}

/// 造一份「除 trailer 里那两格外一切正常」的文件 —— 生产路径不可能产出它,所以只能在这里
/// 用私有件手工拼(测试自己走一遍写侧的形,不去改生产代码开测试后门)。
fn craft_with_doctored_trailer(
    plain: &[u8],
    key: &BackupKey,
    salt: [u8; SALT_LEN],
    chunk: u32,
    doctor: fn(&mut Trailer),
) -> Vec<u8> {
    let mut good = Vec::new();
    let mut t = write_backup(&mut &plain[..], &mut good, key, salt, chunk, &meta()).unwrap();
    doctor(&mut t);

    let (head, frames) = split_frames(&good);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.file_key(&salt)));
    let idx = (frames.len() - 1) as u64; // trailer 的序号 = 数据帧个数
    let mut tbytes = Vec::new();
    ciborium::into_writer(&t, &mut tbytes).unwrap();

    let mut out = head.clone();
    for (kind, f) in frames.iter().take(frames.len() - 1) {
        assert_eq!(*kind, KIND_DATA);
        out.extend_from_slice(f);
    }
    write_frame(&mut out, &cipher, &head, idx, KIND_TRAILER, &tbytes).unwrap();
    out
}

// ---- 杂项结构闸 ---------------------------------------------------------------------

#[test]
fn empty_or_truncated_prefix_is_rejected() {
    let key = BackupKey::from_bytes(KEY_A);
    let file = make(&sample_plain(3000), &key, SALT_A, SMALL_CHUNK);
    for cut in [0usize, 1, 5, 6, 9, 10, 12] {
        match read(&file[..cut.min(file.len())], &key) {
            Err(ReadError::Parse(_)) => {}
            other => panic!("截到 {cut} 字节必须结构闸拒,实得 {other:?}"),
        }
    }
}

#[test]
fn wrong_magic_is_rejected() {
    let key = BackupKey::from_bytes(KEY_A);
    let mut file = make(&sample_plain(100), &key, SALT_A, SMALL_CHUNK);
    file[5] = 0x02; // 版本字节
    match read(&file, &key) {
        Err(ReadError::Parse(m)) => assert!(m.contains("魔数"), "错误话术要说清是魔数:{m}"),
        other => panic!("版本字节不同必须当场拒,实得 {other:?}"),
    }
}

/// ⛔ **错误话术里刻意不复述 `VACUUM INTO` 四个字**(backup-plan §7.1):`db.rs:912` 那道
/// 工作区级审计锚是**按词法出现数**的,复述一次就会让 `into` 桶多一格。
/// 这只测把那条纪律钉在机器上,不靠人记得。
#[test]
fn this_module_never_spells_the_audited_phrase() {
    let src = include_str!("../backup.rs");
    let prod = crate::sync::production_src(src, "backup.rs");
    let hits = prod.to_ascii_lowercase().matches("vacuum into").count();
    assert_eq!(
        hits, 0,
        "backup.rs 的生产段出现了 `VACUUM INTO` 字样。格式层不该有它;引擎层那一处 SQL 是\
         唯一允许的,且错误话术不许复述 —— 见 backup-plan §7.1"
    );
}
