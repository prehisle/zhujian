use super::*;
use crate::sync::engine::Msg;
use std::collections::BTreeMap;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "hex 长度须为偶数");
    s.as_bytes()
        .chunks(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}

const ACCT: &str = "01JZFAKEACCT0000000000AAAA";
const DEV_D: &str = "01JZFAKEDEVD0000000000DDDD";
const DEV_X: &str = "01JZFAKEDEVX0000000000XXXX";
/// 第三台(交错会话/多命中用)。
const DEV_Z: &str = "01JZFAKEDEVZ0000000000ZZZZ";
const NOW: u64 = 1_800_000_000_000;

/// 两台设备的全套材料(账户共用 K_acc,各自一把 Ed25519 钥)。
struct Peers {
    k_acc: [u8; 32],
    d_seed: [u8; 32],
    d_pub: [u8; 32],
    l_seed: [u8; 32],
    l_pub: [u8; 32],
}

fn peers() -> Peers {
    let (d_seed, d_pub) = crate::sync::pair::gen_device_key();
    let (l_seed, l_pub) = crate::sync::pair::gen_device_key();
    Peers { k_acc: [7u8; 32], d_seed, d_pub, l_seed, l_pub }
}

impl Peers {
    fn dial_params(&self) -> DialParams<'_> {
        DialParams {
            account_id: ACCT,
            k_acc: &self.k_acc,
            self_seed: &self.d_seed,
            self_device: DEV_D,
            peer_device: DEV_X,
            peer_pubkey: &self.l_pub,
        }
    }
    fn admit(&self) -> LanAdmit<'_> {
        LanAdmit {
            space_id: "space-1",
            account_id: ACCT,
            k_acc: &self.k_acc,
            self_seed: &self.l_seed,
            self_device: DEV_X,
        }
    }
    fn gate(&self) -> IntroGate<'_> {
        IntroGate { peer_pubkey: Some(&self.d_pub), peer_link_active: false }
    }
}

/// 每一帧都过真实编解码(长度上限按阶段代入)——测试里省掉这一步就测不到 CBOR
/// 形态与 serde_bytes 生效。
fn wire_roundtrip(w: &LanWire) -> LanWire {
    let framed = frame_bytes(w).expect("测试帧远在 1 MiB 内");
    let (len, body) = framed.split_at(4);
    assert_eq!(u32::from_be_bytes(len.try_into().unwrap()) as usize, body.len());
    let phase = match w {
        LanWire::Intro { .. } | LanWire::Accept { .. } | LanWire::Confirm { .. } => {
            FramePhase::PreAuth
        }
        _ => FramePhase::Established,
    };
    decode_wire(body, phase).expect("自产帧必解得开")
}

/// 测试快捷:一步走完「唯一解析 → accept」(生产侧 L-c 这两步也紧邻)。
fn resolve_and_accept<'a>(
    admits: &[LanAdmit<'a>],
    intro: &Intro<'_>,
    gate: &IntroGate<'_>,
    dup: &mut DupCache,
    now_ms: u64,
) -> Result<(LanListener, LanWire), LanError> {
    let resolved = resolve_intro(admits, intro)?;
    LanListener::accept(&resolved, gate, dup, now_ms)
}

/// 跑完整三步握手,返回 (D 侧终局, L 侧终局)。
fn full_handshake(p: &Peers) -> Result<(LanEstablished, LanEstablished), LanError> {
    let mut dup = DupCache::new();
    let (mut dialer, intro_w) = LanDialer::start(&p.dial_params());
    let intro_w = wire_roundtrip(&intro_w);
    let intro = Intro::parse(&intro_w)?;
    let admits = [p.admit()];
    let resolved = resolve_intro(&admits, &intro)?;
    let (mut listener, accept_w) = LanListener::accept(&resolved, &p.gate(), &mut dup, NOW)?;
    let (confirm_w, d_est) = dialer.on_accept(&wire_roundtrip(&accept_w))?;
    let l_est = listener.on_confirm(&wire_roundtrip(&confirm_w))?;
    Ok((d_est, l_est))
}

// ---- §4 正路 ----

#[test]
fn three_step_handshake_establishes_both_sides_with_same_link_id() {
    let p = peers();
    let (d_est, l_est) = full_handshake(&p).unwrap();
    assert_eq!(d_est.peer, DEV_X, "D 侧对端 = 监听方");
    assert_eq!(l_est.peer, DEV_D, "L 侧对端 = 拨入方");
    // §7 glare 的共同尺:双方同有 transcript,必得同一枚 link_id。
    assert_eq!(d_est.link_id, l_est.link_id);
    // 两次握手 nonce 各异 → link_id 各异(同方向多链才比得出胜者)。
    let (d2, _) = full_handshake(&p).unwrap();
    assert_ne!(d_est.link_id, d2.link_id);
}

// ---- §4 反路:MAC 绑定与 fail-closed ----

#[test]
fn intro_mac_binds_account_and_both_identities() {
    let k = crypto::lan_mac_key(&[7u8; 32]);
    let n = [0xAAu8; 32];
    let base = intro_mac(&k, ACCT, DEV_D, DEV_X, &n);
    // 换账户 / 换 D / 换 L / 换 nonce / 换 K_mac:五个坐标各自都得不同 MAC。
    assert_ne!(base, intro_mac(&k, "01JZOTHERACCT000000000BBB", DEV_D, DEV_X, &n));
    assert_ne!(base, intro_mac(&k, ACCT, DEV_Z, DEV_X, &n));
    assert_ne!(base, intro_mac(&k, ACCT, DEV_D, DEV_Z, &n));
    assert_ne!(base, intro_mac(&k, ACCT, DEV_D, DEV_X, &[0xABu8; 32]));
    assert_ne!(base, intro_mac(&crypto::lan_mac_key(&[8u8; 32]), ACCT, DEV_D, DEV_X, &n));
    // D‖L 换序 ≠ 原值(字段序恒 D 前 L 后,不按「本机/对端」——评审二轮 M1)。
    assert_ne!(base, intro_mac(&k, ACCT, DEV_X, DEV_D, &n));
}

#[test]
fn intro_for_wrong_target_or_wrong_account_is_rejected() {
    let p = peers();
    let mut dup = DupCache::new();
    // 拨向 DEV_Z 的 Intro(MAC 绑的 L = DEV_Z),送到 DEV_X 的监听器 → 不认。
    let (_, intro_w) = LanDialer::start(&DialParams {
        peer_device: DEV_Z,
        ..p.dial_params()
    });
    let intro_w = wire_roundtrip(&intro_w);
    let intro = Intro::parse(&intro_w).unwrap();
    let admits = [p.admit()];
    assert_eq!(resolve_intro(&admits, &intro).err(), Some(LanError::NoMatch));
    // 顺带记一笔:走 resolve→accept 的正道也拒。**accept 拿不到凭据就压根调不了**
    // ——`ResolvedIntro` 字段私有、只由 resolve_intro 造,「跳过唯一性闸直接 accept」
    // 这条误用路径在类型层就不存在(codex L-b 审 M1),故此处只能断言解析这一步。
    assert_eq!(
        resolve_and_accept(&admits, &intro, &p.gate(), &mut dup, NOW).err(),
        Some(LanError::NoMatch)
    );
    assert_eq!(dup.len(), 0, "MAC 都不认的 Intro 不该占重复抑制槽");
    // 错账户:同一对设备、K_acc 相同,但 account 串不同 → MAC 不符。
    let other = LanAdmit { account_id: "01JZOTHERACCT000000000BBB", ..p.admit() };
    let (_, ok_intro_w) = LanDialer::start(&p.dial_params());
    let ok_intro_w = wire_roundtrip(&ok_intro_w);
    let ok_intro = Intro::parse(&ok_intro_w).unwrap();
    assert_eq!(resolve_intro(&[other], &ok_intro).err(), Some(LanError::NoMatch));
    // 换 K_acc(持恢复码的自造设备够不上:它连 MAC 都算不对)。
    let stranger = [9u8; 32];
    let alien = LanAdmit { k_acc: &stranger, ..p.admit() };
    assert_eq!(resolve_intro(&[alien], &ok_intro).err(), Some(LanError::NoMatch));
}

#[test]
fn resolve_intro_is_fail_closed_on_zero_and_multi_hit() {
    let p = peers();
    let (_, intro_w) = LanDialer::start(&p.dial_params());
    let intro_w = wire_roundtrip(&intro_w);
    let intro = Intro::parse(&intro_w).unwrap();
    // 零命中(空表 / 不相干空间)。
    assert_eq!(resolve_intro(&[], &intro).err(), Some(LanError::NoMatch));
    // 恰一命中。
    let noise = LanAdmit { space_id: "space-noise", self_device: DEV_Z, ..p.admit() };
    let two = [noise.clone(), p.admit()];
    let hit = resolve_intro(&two, &intro).unwrap();
    assert_eq!(hit.index(), 1);
    assert_eq!(hit.space_id(), "space-1", "凭据须带出命中空间(L-c 取 generation 用)");
    // 多命中:两个空间材料完全同款(同账户+同 K_acc+同 device_id,克隆库的形态)
    // → 绝不「取第一个」。
    let clone_a = LanAdmit { space_id: "space-a", ..p.admit() };
    let clone_b = LanAdmit { space_id: "space-b", ..p.admit() };
    assert_eq!(resolve_intro(&[clone_a, clone_b], &intro).err(), Some(LanError::Ambiguous));
}

#[test]
fn intro_form_and_version_are_checked_before_anything_else() {
    let p = peers();
    let (_, good) = LanDialer::start(&p.dial_params());
    let LanWire::Intro { from, nonce_d, mac, .. } = good.clone() else { unreachable!() };
    // 版本不符 = advisory 拒(静默关 + 诊断计数,无 skew UI)。
    let v2 = LanWire::Intro { ver: 2, from: from.clone(), nonce_d: nonce_d.clone(), mac: mac.clone() };
    assert_eq!(Intro::parse(&v2).err(), Some(LanError::Version(2)));
    // from 不是 ULID。
    let bad_from = LanWire::Intro { ver: LAN_VER, from: "nope".into(), nonce_d: nonce_d.clone(), mac: mac.clone() };
    assert!(matches!(Intro::parse(&bad_from), Err(LanError::Material(_))));
    // nonce / mac 长度不是 32B。
    let short_n = LanWire::Intro { ver: LAN_VER, from: from.clone(), nonce_d: vec![0; 31], mac: mac.clone() };
    assert!(matches!(Intro::parse(&short_n), Err(LanError::Material(_))));
    let short_m = LanWire::Intro { ver: LAN_VER, from, nonce_d, mac: vec![0; 16] };
    assert!(matches!(Intro::parse(&short_m), Err(LanError::Material(_))));
    // 不是 Intro 变体。
    assert!(matches!(Intro::parse(&LanWire::Ping {}), Err(LanError::Protocol(_))));
}

// ---- §4 反路:公钥、签名、nonce、重复抑制 ----

#[test]
fn listener_refuses_when_peer_pubkey_was_never_learned_via_relay() {
    // §2 的活性代价:无缓存公钥 = 不 TOFU、不建链,等权威路定向回 Hello 收敛。
    let p = peers();
    let mut dup = DupCache::new();
    let (_, intro_w) = LanDialer::start(&p.dial_params());
    let intro_w = wire_roundtrip(&intro_w);
    let intro = Intro::parse(&intro_w).unwrap();
    let gate = IntroGate { peer_pubkey: None, peer_link_active: false };
    assert_eq!(
        resolve_and_accept(&[p.admit()], &intro, &gate, &mut dup, NOW).err(),
        Some(LanError::NoPeerKey)
    );
    // 「花掉即花掉」:失败也不退条目,同一枚 Intro 重来即 Duplicate。
    assert_eq!(dup.len(), 1);
    assert_eq!(
        resolve_and_accept(&[p.admit()], &intro, &p.gate(), &mut dup, NOW).err(),
        Some(LanError::Duplicate)
    );
}

#[test]
fn listener_refuses_second_link_to_same_peer() {
    let p = peers();
    let mut dup = DupCache::new();
    let (_, intro_w) = LanDialer::start(&p.dial_params());
    let intro_w = wire_roundtrip(&intro_w);
    let intro = Intro::parse(&intro_w).unwrap();
    let gate = IntroGate { peer_pubkey: Some(&p.d_pub), peer_link_active: true };
    assert_eq!(
        resolve_and_accept(&[p.admit()], &intro, &gate, &mut dup, NOW).err(),
        Some(LanError::LinkExists)
    );
}

#[test]
fn dup_suppression_rejects_replayed_intro_until_ttl_then_burns_a_slot_again() {
    let mut dup = DupCache::new();
    let n = [1u8; 32];
    assert!(dup.check_and_register(DEV_D, &n, NOW).is_ok());
    assert_eq!(dup.check_and_register(DEV_D, &n, NOW), Err(LanError::Duplicate));
    // 别的 from / 别的 nonce 是别的条目。
    assert!(dup.check_and_register(DEV_Z, &n, NOW).is_ok());
    assert!(dup.check_and_register(DEV_D, &[2u8; 32], NOW).is_ok());
    // TTL 边界:恰到期那一刻仍算已见(> now 才留),过一毫秒即可再花一次
    // ——这就是 §9 记账的「每 10 分钟诱出一帧 Accept」残余,不是完整防重放。
    assert_eq!(
        dup.check_and_register(DEV_D, &n, NOW + DUP_CACHE_TTL_MS - 1),
        Err(LanError::Duplicate)
    );
    assert!(dup.check_and_register(DEV_D, &n, NOW + DUP_CACHE_TTL_MS + 1).is_ok());
}

#[test]
fn dup_cache_is_capped_and_fails_closed_when_full() {
    let mut dup = DupCache::new();
    for i in 0..DUP_CACHE_CAP {
        let mut n = [0u8; 32];
        n[..8].copy_from_slice(&(i as u64).to_be_bytes());
        dup.check_and_register(DEV_D, &n, NOW).unwrap();
    }
    assert_eq!(dup.len(), DUP_CACHE_CAP);
    assert_eq!(
        dup.check_and_register(DEV_D, &[0xFFu8; 32], NOW),
        Err(LanError::DupCacheFull),
        "满 = 拒新 Intro(fail-closed,只影响直连)"
    );
    // 过期条目一清,又能收(不是永久卡死)。
    assert!(dup.check_and_register(DEV_D, &[0xFFu8; 32], NOW + DUP_CACHE_TTL_MS + 1).is_ok());
    assert_eq!(dup.len(), 1);
}

/// 起一个真会话,把 L 的 Accept 内层消息改一改再封回去,返回**配对的** D 侧状态机
/// ——nonce_d 必须与那枚 Accept 同源,否则回显先拒、测不到签名那一层(造反例时最容易
/// 踩的坑:换个 dialer 就变成了在测 NonceMismatch)。
fn tweaked_session(p: &Peers, f: impl FnOnce(&mut LanMsg)) -> (LanDialer, LanWire) {
    let mut dup = DupCache::new();
    let (dialer, intro_w) = LanDialer::start(&p.dial_params());
    let intro = Intro::parse(&intro_w).unwrap();
    let (_l, accept_w) =
        resolve_and_accept(&[p.admit()], &intro, &p.gate(), &mut dup, NOW).unwrap();
    let LanWire::Accept { blob } = accept_w else { unreachable!() };
    let mut msg = crypto::open_msg::<LanMsg>(&p.k_acc, &accept_addr(), &blob).unwrap();
    f(&mut msg);
    (dialer, LanWire::Accept { blob: crypto::seal_msg(&p.k_acc, &accept_addr(), &msg) })
}

/// Accept 的 AAD 方向:L→D。
fn accept_addr() -> FrameAddr<'static> {
    FrameAddr { account_id: ACCT, from_device: DEV_X, to: DEV_D, domain: Domain::Lan }
}
/// Confirm 的 AAD 方向:D→L。
fn confirm_addr() -> FrameAddr<'static> {
    FrameAddr { account_id: ACCT, from_device: DEV_D, to: DEV_X, domain: Domain::Lan }
}

#[test]
fn dialer_rejects_bad_signature_and_wrong_signer() {
    let p = peers();
    // 坏签名(翻一位)。
    let (mut d, bad) = tweaked_session(&p, |m| {
        if let LanMsg::Accept { sig_l, .. } = m {
            let last = sig_l.len() - 1;
            sig_l[last] ^= 1;
        }
    });
    assert_eq!(d.on_accept(&wire_roundtrip(&bad)).err(), Some(LanError::BadSignature));
    // 签名长度不对。
    let (mut d, short) = tweaked_session(&p, |m| {
        if let LanMsg::Accept { sig_l, .. } = m {
            sig_l.truncate(32);
        }
    });
    assert_eq!(d.on_accept(&wire_roundtrip(&short)).err(), Some(LanError::BadSignature));
    // 阴性对照:一字不改的同一条造法必须走通(证明上面拒的是签名,不是造法本身)。
    let (mut d, ok) = tweaked_session(&p, |_| {});
    d.on_accept(&wire_roundtrip(&ok)).unwrap();
}

#[test]
fn member_impersonating_another_member_fails_at_the_signature() {
    // §4 的核心性质:持 K_acc(= 恢复码在手)能封解 lan 域、能算对 MAC,但拿不到
    // DEV_X 的设备私钥 → 冒充 DEV_X 建链必败在验签。这是「链路准入 = 设备身份
    // 证明」相对「仅持 K_acc」的全部差别。
    let real = peers();
    let (other_seed, _other_pub) = crate::sync::pair::gen_device_key();
    let mut dup = DupCache::new();
    let (mut d, intro_w) = LanDialer::start(&real.dial_params());
    let intro = Intro::parse(&intro_w).unwrap();
    // 监听侧材料全对(同账户、同 K_acc、自称同一个 device_id),只有签名私钥是别的
    // ——MAC 算得对、lan 域封得开,签名过不了。
    let admit = LanAdmit { self_seed: &other_seed, ..real.admit() };
    let (_l, forged) =
        resolve_and_accept(&[admit], &intro, &real.gate(), &mut dup, NOW).unwrap();
    assert_eq!(d.on_accept(&wire_roundtrip(&forged)).err(), Some(LanError::BadSignature));
}

#[test]
fn weak_public_keys_are_rejected_by_strict_verification() {
    // §4「Ed25519 一律严格验签」加的正是这一刀:小阶公钥(取 Edwards 恒等元)配上
    // (R = 恒等元, S = 0) 这种签名,在**宽松**验签下等式成立、任意消息都蒙得过;
    // verify_strict 直接判 WeakPublicKey 拒。变异专项——把 verify_strict 降级成
    // verify,本测试当场红(不加它,「严格」二字没有测试守着)。
    use ed25519_dalek::Verifier;
    let mut identity = [0u8; 32];
    identity[0] = 1; // 压缩形恒等元(y=1, x=0)
    let vk = VerifyingKey::from_bytes(&identity).expect("恒等元是合法曲线点");
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&identity); // R = 恒等元;S = 0
    assert!(
        vk.verify(b"any message", &Signature::from_bytes(&sig)).is_ok(),
        "宽松验签吃下去——这就是不能用它的理由"
    );
    assert_eq!(verify(&identity, b"any message", &sig), Err(LanError::BadSignature));
    // 阴性对照:真钥真签名照过(证明拒的是弱钥,不是 verify() 全拒)。
    let (seed, pubkey) = crate::sync::pair::gen_device_key();
    assert!(verify(&pubkey, b"any message", &sign(&seed, b"any message")).is_ok());
}

#[test]
fn nonce_echo_must_match_on_both_directions() {
    let p = peers();
    // D 侧:Accept 回显的 nonce_d 不是自己发的那枚。
    let (mut d, tweaked) = tweaked_session(&p, |m| {
        if let LanMsg::Accept { nonce_d, .. } = m {
            nonce_d[0] ^= 0xFF;
        }
    });
    assert_eq!(d.on_accept(&wire_roundtrip(&tweaked)).err(), Some(LanError::NonceMismatch));
    // nonce_l 长度不对(D 侧在算 T 之前钉长度)。
    let (mut d, short_l) = tweaked_session(&p, |m| {
        if let LanMsg::Accept { nonce_l, .. } = m {
            nonce_l.truncate(16);
        }
    });
    assert!(matches!(d.on_accept(&wire_roundtrip(&short_l)), Err(LanError::Material(_))));

    // L 侧:Confirm 回显的 nonce_l 不是自己发的那枚。
    let mut dup = DupCache::new();
    let (mut dialer, intro_w) = LanDialer::start(&p.dial_params());
    let intro = Intro::parse(&intro_w).unwrap();
    let (mut listener, accept_w) =
        resolve_and_accept(&[p.admit()], &intro, &p.gate(), &mut dup, NOW).unwrap();
    let (confirm_w, _) = dialer.on_accept(&accept_w).unwrap();
    let LanWire::Confirm { blob } = confirm_w else { unreachable!() };
    let mut msg = crypto::open_msg::<LanMsg>(&p.k_acc, &confirm_addr(), &blob).unwrap();
    if let LanMsg::Confirm { nonce_l, .. } = &mut msg {
        nonce_l[31] ^= 0xFF;
    }
    let forged = LanWire::Confirm { blob: crypto::seal_msg(&p.k_acc, &confirm_addr(), &msg) };
    assert_eq!(
        listener.on_confirm(&wire_roundtrip(&forged)).err(),
        Some(LanError::NonceMismatch)
    );
}

#[test]
fn aad_direction_reflection_is_rejected() {
    // §4:Accept 封 AAD from=L,to=D。反射(把对方的密文原样回灌)在 AEAD 一步拒
    // ——方向绑在 AAD 里,不靠字段自述。
    let p = peers();
    let mut dup = DupCache::new();
    let (mut dialer, intro_w) = LanDialer::start(&p.dial_params());
    let intro = Intro::parse(&intro_w).unwrap();
    let (mut listener, accept_w) =
        resolve_and_accept(&[p.admit()], &intro, &p.gate(), &mut dup, NOW).unwrap();
    let LanWire::Accept { blob } = accept_w.clone() else { unreachable!() };
    // 把 L 自己发的 Accept 密文塞进 Confirm 帧壳回给 L:L 以 (from=D,to=L) 重构 → 解不开。
    assert_eq!(
        listener.on_confirm(&LanWire::Confirm { blob }).err(),
        Some(LanError::Sealed)
    );
    // 反向:D 的 Confirm 密文塞进 Accept 帧壳回给 D。
    let (confirm_w, _) = dialer.on_accept(&accept_w).unwrap();
    let LanWire::Confirm { blob: c_blob } = confirm_w else { unreachable!() };
    let (mut d2, _) = LanDialer::start(&p.dial_params());
    assert_eq!(d2.on_accept(&LanWire::Accept { blob: c_blob }).err(), Some(LanError::Sealed));
    // 方向对、内层装错变体:响亮 Protocol(不静默当成对的那个)。
    let wrong_inner = LanWire::Accept {
        blob: crypto::seal_msg(
            &p.k_acc,
            &accept_addr(),
            &LanMsg::Confirm { nonce_l: vec![0; 32], sig_d: vec![0; 64] },
        ),
    };
    let (mut d3, _) = LanDialer::start(&p.dial_params());
    assert!(matches!(d3.on_accept(&wrong_inner), Err(LanError::Protocol(_))));
}

#[test]
fn lan_domain_ciphertext_needs_the_lan_subkey() {
    // Domain::Lan 与 op/ctl/boot/blob 域隔死:lan 密文换域解必败(经中转投递的
    // lan 帧因此恒 Undecryptable,transport 侧另有回归锚)。
    let p = peers();
    let msg = LanMsg::Confirm { nonce_l: vec![1; 32], sig_d: vec![2; 64] };
    let blob = crypto::seal_msg(&p.k_acc, &confirm_addr(), &msg);
    for d in [Domain::Op, Domain::Ctl, Domain::Boot, Domain::Blob] {
        let addr = FrameAddr { domain: d, ..confirm_addr() };
        assert_eq!(
            crypto::open_msg::<LanMsg>(&p.k_acc, &addr, &blob).err(),
            Some(OpenError::Decrypt),
            "{d:?} 域不该解得开 lan 密文"
        );
    }
    assert!(crypto::open_msg::<LanMsg>(&p.k_acc, &confirm_addr(), &blob).is_ok());
}

#[test]
fn state_machines_die_after_terminal_step() {
    let p = peers();
    let mut dup = DupCache::new();
    let (mut dialer, intro_w) = LanDialer::start(&p.dial_params());
    let intro = Intro::parse(&intro_w).unwrap();
    let (mut listener, accept_w) =
        resolve_and_accept(&[p.admit()], &intro, &p.gate(), &mut dup, NOW).unwrap();
    let (confirm_w, _) = dialer.on_accept(&accept_w).unwrap();
    listener.on_confirm(&confirm_w).unwrap();
    // 重放同一枚 Accept / Confirm:状态机已死,恒 Err。
    assert!(matches!(dialer.on_accept(&accept_w), Err(LanError::Protocol(_))));
    assert!(matches!(listener.on_confirm(&confirm_w), Err(LanError::Protocol(_))));
}

#[test]
fn interleaved_sessions_cannot_swap_accept_or_confirm() {
    // §11 transcript 交错专项:同一对设备并发两会话(nonce 各异),材料互搬必拒。
    // 注意 AAD 在两会话里**逐字节相同**(同账户同设备同域)——拒的是 nonce 绑定,
    // 这正是唯一 transcript 要挡的那一刀。
    let p = peers();
    let mut dup = DupCache::new();
    // 三个独立会话(A 当阴性对照,B 当搬运受害者,C 供搬运材料)——每个状态机
    // 一次失败即死,所以搬运实验不能跟对照共用同一只。
    let (mut d_a, i_a) = LanDialer::start(&p.dial_params());
    let (mut d_b, i_b) = LanDialer::start(&p.dial_params());
    let (mut d_c, i_c) = LanDialer::start(&p.dial_params());
    assert_ne!(i_a, i_b, "并发会话 nonce_d 必不同");
    assert_ne!(i_b, i_c);
    let n_a = Intro::parse(&i_a).unwrap();
    let n_b = Intro::parse(&i_b).unwrap();
    let n_c = Intro::parse(&i_c).unwrap();
    let (mut l_a, a_a) = resolve_and_accept(&[p.admit()], &n_a, &p.gate(), &mut dup, NOW).unwrap();
    let (mut l_b, _a_b) = resolve_and_accept(&[p.admit()], &n_b, &p.gate(), &mut dup, NOW).unwrap();
    let (_l_c, a_c) = resolve_and_accept(&[p.admit()], &n_c, &p.gate(), &mut dup, NOW).unwrap();

    // ① 会话 A 的 Accept 喂给会话 B 的 D → nonce_d 回显不符。
    assert_eq!(d_b.on_accept(&wire_roundtrip(&a_a)).err(), Some(LanError::NonceMismatch));
    // ② 会话 C 的 Confirm 喂给会话 B 的 L → nonce_l 回显不符。
    let (c_c, est_c) = d_c.on_accept(&wire_roundtrip(&a_c)).unwrap();
    assert_eq!(l_b.on_confirm(&wire_roundtrip(&c_c)).err(), Some(LanError::NonceMismatch));
    // 一次搬运即断链,不给第二次机会(状态机已死)。
    assert!(matches!(l_b.on_confirm(&wire_roundtrip(&c_c)), Err(LanError::Protocol(_))));
    // ③ 阴性对照:会话 A 自己的两帧照样走通(证明 ①② 不是「什么都拒」的假绿)。
    let (c_a, est_a_d) = d_a.on_accept(&wire_roundtrip(&a_a)).unwrap();
    let est_a_l = l_a.on_confirm(&wire_roundtrip(&c_a)).unwrap();
    assert_eq!(est_a_d.link_id, est_a_l.link_id);
    // ④ 不同会话的 link_id 必异(§7 同方向多链靠它选胜者)。
    assert_ne!(est_a_d.link_id, est_c.link_id);
}

#[test]
fn signature_role_tag_cannot_be_swapped() {
    // sig_L 与 sig_D 同 transcript、只差角色尾:搬运必拒(§4 的方向绑定)。
    let p = peers();
    let nonce_l = [0x5Au8; 32];
    // 反例:用 role=D 的签名冒充 sig_l。
    let (mut d, i) = LanDialer::start(&p.dial_params());
    let n = Intro::parse(&i).unwrap();
    let t = transcript(ACCT, DEV_D, DEV_X, n.nonce_d, &nonce_l);
    let swapped = LanWire::Accept {
        blob: crypto::seal_msg(
            &p.k_acc,
            &accept_addr(),
            &LanMsg::Accept {
                nonce_d: n.nonce_d.to_vec(),
                nonce_l: nonce_l.to_vec(),
                sig_l: sign(&p.l_seed, &sig_payload(&t, ROLE_D)).to_vec(),
            },
        ),
    };
    assert_eq!(d.on_accept(&wire_roundtrip(&swapped)).err(), Some(LanError::BadSignature));
    // 阴性对照:同一枚手工 Accept,只把角色尾改回 L → 过。证明拒的是角色。
    let (mut d2, i2) = LanDialer::start(&p.dial_params());
    let n2 = Intro::parse(&i2).unwrap();
    let t2 = transcript(ACCT, DEV_D, DEV_X, n2.nonce_d, &nonce_l);
    let ok = LanWire::Accept {
        blob: crypto::seal_msg(
            &p.k_acc,
            &accept_addr(),
            &LanMsg::Accept {
                nonce_d: n2.nonce_d.to_vec(),
                nonce_l: nonce_l.to_vec(),
                sig_l: sign(&p.l_seed, &sig_payload(&t2, ROLE_L)).to_vec(),
            },
        ),
    };
    d2.on_accept(&wire_roundtrip(&ok)).unwrap();
}

// ---- §3 数据面地址校验 ----

#[test]
fn frame_addr_must_match_the_authenticated_link_peer() {
    // from 取握手绑定的对端(传输层权威值),不认帧里的自述;to 只许本机或广播。
    assert!(check_frame_addr(DEV_D, DEV_X, DEV_D, DEV_X).is_ok());
    assert!(check_frame_addr(DEV_D, DEV_X, DEV_D, BROADCAST).is_ok());
    // 冒充第三台(quarantine 的 relay_from 栽赃面就靠这条挡住)。
    assert!(matches!(
        check_frame_addr(DEV_D, DEV_X, DEV_Z, DEV_X),
        Err(LanError::Protocol(_))
    ));
    // 投给别人(转发面)。
    assert!(matches!(
        check_frame_addr(DEV_D, DEV_X, DEV_D, DEV_Z),
        Err(LanError::Protocol(_))
    ));
}

#[test]
fn frame_size_limits_are_enforced_on_both_directions() {
    // 编码侧:超 1 MiB 响亮 Err(绝不截断后发半帧)。
    let huge = LanWire::Frame {
        from: DEV_D.into(),
        to: DEV_X.into(),
        blob: vec![0u8; LAN_FRAME_MAX],
    };
    assert!(matches!(frame_bytes(&huge), Err(LanError::TooLarge(_))));
    let ok = LanWire::Frame {
        from: DEV_D.into(),
        to: DEV_X.into(),
        blob: vec![0u8; 8 * 1024],
    };
    assert!(frame_bytes(&ok).is_ok());
    // 解码侧:pre-auth 阶段 4 KiB 上限(握手前收不下 8 KiB 的数据帧)。
    let body = encode_wire(&ok);
    assert!(body.len() > LAN_PREAUTH_FRAME_MAX && body.len() < LAN_FRAME_MAX);
    assert!(matches!(
        decode_wire(&body, FramePhase::PreAuth),
        Err(LanError::TooLarge(_))
    ));
    assert!(decode_wire(&body, FramePhase::Established).is_ok());
    // 垃圾字节 = Codec。
    assert_eq!(decode_wire(b"not-cbor", FramePhase::Established), Err(LanError::Codec));
}

// ---- §3/§4 线上格式黄金向量(断言失败 = 线上格式变了 = 两端互不认;别改断言,改回代码) ----

#[test]
fn lan_wire_golden_vectors() {
    let cases: Vec<(LanWire, &str)> = vec![
        (
            LanWire::Intro {
                ver: 1,
                from: "dev-d".into(),
                nonce_d: vec![0xAA, 0xBB],
                mac: vec![0xCC],
            },
            concat!(
                "a1",                   // map(1)
                "65496e74726f",         // "Intro"
                "a4",                   // map(4)
                "63766572",             // "ver"
                "01",                   // 1
                "6466726f6d",           // "from"
                "656465762d64",         // "dev-d"
                "676e6f6e63655f64",     // "nonce_d"
                "42aabb",               // bytes(2) aa bb
                "636d6163",             // "mac"
                "41cc",                 // bytes(1) cc
            ),
        ),
        (
            LanWire::Accept { blob: vec![0x01] },
            concat!(
                "a1",
                "66416363657074", // "Accept"
                "a1",
                "64626c6f62", // "blob"
                "4101",
            ),
        ),
        (
            LanWire::Confirm { blob: vec![0x02] },
            concat!("a1", "67436f6e6669726d", "a1", "64626c6f62", "4102"),
        ),
        (
            LanWire::Frame { from: "a".into(), to: "b".into(), blob: vec![0x03] },
            concat!(
                "a1",
                "654672616d65", // "Frame"
                "a3",
                "6466726f6d",   // "from"
                "6161",         // "a"
                "62746f",       // "to"
                "6162",         // "b"
                "64626c6f62",   // "blob"
                "4103",
            ),
        ),
        (LanWire::Ping {}, concat!("a1", "6450696e67", "a0")),
        (LanWire::Pong {}, concat!("a1", "64506f6e67", "a0")),
    ];
    for (wire, want) in cases {
        let got = encode_wire(&wire);
        assert_eq!(hex(&got), want, "{wire:?} 的 CBOR 字节形态漂了");
        assert_eq!(decode_wire(&got, FramePhase::Established).unwrap(), wire);
    }
}

#[test]
fn lan_msg_golden_vectors() {
    let cases: Vec<(LanMsg, &str)> = vec![
        (
            LanMsg::Accept { nonce_d: vec![1], nonce_l: vec![2], sig_l: vec![3] },
            concat!(
                "a1",
                "66416363657074", // "Accept"
                "a3",
                "676e6f6e63655f64", // "nonce_d"
                "4101",
                "676e6f6e63655f6c", // "nonce_l"
                "4102",
                "657369675f6c",     // "sig_l"
                "4103",
            ),
        ),
        (
            LanMsg::Confirm { nonce_l: vec![4], sig_d: vec![5] },
            concat!(
                "a1",
                "67436f6e6669726d", // "Confirm"
                "a2",
                "676e6f6e63655f6c",
                "4104",
                "657369675f64", // "sig_d"
                "4105",
            ),
        ),
    ];
    for (msg, want) in cases {
        let mut buf = Vec::new();
        ciborium::into_writer(&msg, &mut buf).unwrap();
        assert_eq!(hex(&buf), want, "{msg:?} 的 CBOR 字节形态漂了");
        let back: LanMsg = ciborium::from_reader(buf.as_slice()).unwrap();
        assert_eq!(back, msg);
    }
}

#[test]
fn transcript_and_signed_bytes_are_pinned() {
    // §4 的被 MAC / 被签材料:definite 数组、字段序恒 D 前 L 后。别端实现照此对拍。
    // (编码器不校验 ULID 形态——形态校验在 Intro::parse / 状态机,故这里用短串。)
    let t = transcript("acct", "dev-d", "dev-x", &[0xAAu8; 32], &[0xBBu8; 32]);
    let want_t = format!(
        "{}{}{}{}{}{}5820{}5820{}",
        "87",                                 // array(7)
        "71",                                 // text(17)
        "7a68756a69616e2d6c616e2d68732d7631", // "zhujian-lan-hs-v1"
        "01",                                 // LAN_VER
        "6461636374",                         // "acct"
        "656465762d64656465762d78",           // "dev-d" ‖ "dev-x"
        "aa".repeat(32),
        "bb".repeat(32),
    );
    assert_eq!(hex(&t), want_t, "transcript T 的字节形态漂了");
    // 被签字节 = 嵌套数组 [T, role]:array(2) ‖ T 原样 ‖ text(1) role。
    assert_eq!(hex(&sig_payload(&t, ROLE_D)), format!("82{}6144", hex(&t)));
    assert_eq!(hex(&sig_payload(&t, ROLE_L)), format!("82{}614c", hex(&t)));
    // Intro MAC:先钉死**被 MAC 的消息字节**(结构),再断言 intro_mac 恰是它的
    // HMAC(用法)——两层都锁住,不是拿实现跟自己对拍的空测。
    let want_mac_msg = unhex(&format!(
        "{}{}{}{}{}{}5820{}",
        "86",                                     // array(6)
        "74",                                     // text(20)
        "7a68756a69616e2f6c616e2d696e74726f2f7631", // "zhujian/lan-intro/v1"
        "01",
        "6461636374",
        "656465762d64656465762d78",
        "aa".repeat(32),
    ));
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(&[0u8; 32]).unwrap();
    m.update(&want_mac_msg);
    let want_mac: [u8; 32] = m.finalize().into_bytes().into();
    assert_eq!(intro_mac(&[0u8; 32], "acct", "dev-d", "dev-x", &[0xAAu8; 32]), want_mac);
    // link_id = SHA-256(T)。
    assert_eq!(hex(&link_id(&t)), hex(Sha256::digest(&t).as_slice()));
}

// ---- §2 Hello 双形态 + 零版本偏斜(LegacyMsgV1 冻结对拍) ----

/// **冻结**的现网 `Msg`(桌面 0.2.24 / 安卓 0.3.21 起在产的形态,`Hello` 无 lan
/// 字段)。它存在的唯一目的:守住 §2「零版本偏斜」的四条断言——将来谁给 `Msg` 加
/// `deny_unknown_fields`、换序列化器、或把 `lan` 的 `skip_serializing_if` 删掉,
/// 这里当场红。**永远别照着新 Msg 更新它**;真要升协议,改的是 `PROTO_VER`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum LegacyMsgV1 {
    Ops { origin: String, ops: Vec<crate::replay::RemoteOp> },
    Hello { watermarks: BTreeMap<String, i64> },
    Want { origin: String, from_seq: i64 },
    BlobWant { image_id: String },
    BlobHave { image_id: String },
    BlobPull { image_id: String, transfer: String },
    BlobDeny { image_id: String, transfer: String },
    BlobChunk {
        image_id: String,
        transfer: String,
        idx: u32,
        last: bool,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
}

fn cbor(v: &impl Serialize) -> Vec<u8> {
    let mut buf = Vec::new();
    ciborium::into_writer(v, &mut buf).unwrap();
    buf
}

fn sample_watermarks() -> BTreeMap<String, i64> {
    BTreeMap::from([("01JZFAKEORIGIN00000000AAAA".to_string(), 42i64)])
}

fn sample_ad() -> LanAd {
    LanAd {
        pubkey: vec![0x11; 32],
        ad_seq: 7,
        listen: Some(LanListen {
            port: DEFAULT_LAN_PORT,
            addrs: vec!["192.168.1.7".into()],
        }),
    }
}

#[test]
fn hello_without_lan_is_byte_identical_to_the_frozen_legacy_form() {
    // ①(探针实证的四项之一)None 的字节形态与现网**逐字节一致** → 黄金向量与
    // 混版解密全不受影响,这正是「不升 PROTO_VER」得以成立的前提。
    let new_none = cbor(&Msg::Hello { watermarks: sample_watermarks(), lan: None });
    let legacy = cbor(&LegacyMsgV1::Hello { watermarks: sample_watermarks() });
    assert_eq!(hex(&new_none), hex(&legacy));
    // 顺带钉死这一形态的字节(map(1) Hello → map(1) watermarks)。
    assert_eq!(
        hex(&new_none),
        concat!(
            "a1",                                     // map(1)
            "6548656c6c6f",                           // "Hello"
            "a1",                                     // map(1)
            "6a77617465726d61726b73",                 // "watermarks"
            "a1",                                     // map(1)
            "781a",                                   // text(26)
            "30314a5a46414b454f524947494e303030303030303041414141", // origin ULID
            "182a",                                   // 42
        )
    );
}

#[test]
fn hello_with_lan_is_readable_by_the_frozen_old_decoder() {
    // ② 旧端解新帧 = Ok 且忽略 lan(水位照读)→ 混版下老端不 Codec、不骚扰 skew。
    let with_lan = cbor(&Msg::Hello { watermarks: sample_watermarks(), lan: Some(sample_ad()) });
    let old: LegacyMsgV1 = ciborium::from_reader(with_lan.as_slice())
        .expect("旧解码器必须能读新帧(serde 派生忽略未知字段)");
    assert_eq!(old, LegacyMsgV1::Hello { watermarks: sample_watermarks() });
    // ③ 新端解旧帧 = Ok 得 None(serde 对缺席 Option 特判)。
    let legacy = cbor(&LegacyMsgV1::Hello { watermarks: sample_watermarks() });
    let new: Msg = ciborium::from_reader(legacy.as_slice()).unwrap();
    assert_eq!(new, Msg::Hello { watermarks: sample_watermarks(), lan: None });
    // ④ 新端解新帧 = 原样往返(通告不丢)。
    let back: Msg = ciborium::from_reader(with_lan.as_slice()).unwrap();
    assert_eq!(back, Msg::Hello { watermarks: sample_watermarks(), lan: Some(sample_ad()) });
    // 手机形态(listen: None)也往返无损。
    let phone = LanAd { listen: None, ..sample_ad() };
    let bytes = cbor(&Msg::Hello { watermarks: BTreeMap::new(), lan: Some(phone.clone()) });
    let back: Msg = ciborium::from_reader(bytes.as_slice()).unwrap();
    assert_eq!(back, Msg::Hello { watermarks: BTreeMap::new(), lan: Some(phone) });
    assert!(ciborium::from_reader::<LegacyMsgV1, _>(bytes.as_slice()).is_ok());
}

#[test]
fn frozen_legacy_msg_still_matches_new_msg_on_every_other_variant() {
    // lan 只动 Hello;其余变体的线上字节必须**一字不改**(冻结类型逐变体对拍)。
    let cases: Vec<(Msg, LegacyMsgV1)> = vec![
        (
            Msg::Want { origin: "o".into(), from_seq: 5 },
            LegacyMsgV1::Want { origin: "o".into(), from_seq: 5 },
        ),
        (
            Msg::BlobWant { image_id: "i".into() },
            LegacyMsgV1::BlobWant { image_id: "i".into() },
        ),
        (
            Msg::BlobHave { image_id: "i".into() },
            LegacyMsgV1::BlobHave { image_id: "i".into() },
        ),
        (
            Msg::BlobPull { image_id: "i".into(), transfer: "t".into() },
            LegacyMsgV1::BlobPull { image_id: "i".into(), transfer: "t".into() },
        ),
        (
            Msg::BlobDeny { image_id: "i".into(), transfer: "t".into() },
            LegacyMsgV1::BlobDeny { image_id: "i".into(), transfer: "t".into() },
        ),
        (
            Msg::BlobChunk {
                image_id: "i".into(),
                transfer: "t".into(),
                idx: 1,
                last: true,
                data: vec![9],
            },
            LegacyMsgV1::BlobChunk {
                image_id: "i".into(),
                transfer: "t".into(),
                idx: 1,
                last: true,
                data: vec![9],
            },
        ),
        (
            Msg::Ops { origin: "o".into(), ops: vec![] },
            LegacyMsgV1::Ops { origin: "o".into(), ops: vec![] },
        ),
    ];
    for (new, old) in cases {
        assert_eq!(hex(&cbor(&new)), hex(&cbor(&old)), "{new:?} 的线上字节漂了");
    }
}

// ---- §2 通告缓存:单一权威路 + 首见钉住 + 单调序号 ----

fn cached(pubkey: &[u8; 32], ad_seq: u64, received_at: u64) -> LanPeerAd {
    LanPeerAd {
        pubkey: pubkey.to_vec(),
        ad_seq,
        listen: Some(LanListen { port: 1111, addrs: vec!["192.168.1.9".into()] }),
        received_at,
        key_conflict: false,
    }
}

#[test]
fn same_hello_ciphertext_updates_cache_via_relay_but_never_via_lan() {
    // §2/L1 的阴性对照:**同一枚合法 Hello 密文**分经两类 ingress 注入——Relay 更新
    // 缓存,Lan 一字不动。来路是 socket 所有者的构造事实,不取自对端字段,所以攻击者
    // 在局域网里自证地址这条路不存在。
    let (_seed, pubkey) = crate::sync::pair::gen_device_key();
    let k_acc = [7u8; 32];
    let ad = LanAd { pubkey: pubkey.to_vec(), ad_seq: 3, listen: sample_ad().listen };
    let hello = Msg::Hello { watermarks: sample_watermarks(), lan: Some(ad) };
    // 真封一帧 ctl 域密文,两条来路解出的是同一个 Msg(字节完全同源)。
    let addr = FrameAddr {
        account_id: ACCT,
        from_device: DEV_D,
        to: BROADCAST,
        domain: Domain::Ctl,
    };
    let blob = crypto::seal_msg(&k_acc, &addr, &hello);
    let opened: Msg = crypto::open_msg(&k_acc, &addr, &blob).unwrap();
    let Msg::Hello { lan: Some(ad), .. } = opened else { panic!("该解出带 lan 的 Hello") };

    match merge_peer_ad(None, &ad, Ingress::RelayDeliver, NOW) {
        AdMerge::Store { record: stored, cause } => {
            assert_eq!(cause, StoreCause::FirstSeen);
            assert_eq!(stored.pubkey, pubkey.to_vec());
            assert_eq!(stored.ad_seq, 3);
            assert_eq!(stored.received_at, NOW);
        }
        other => panic!("Relay 来路该写缓存,得到 {other:?}"),
    }
    assert!(
        matches!(merge_peer_ad(None, &ad, Ingress::LanFrame, NOW), AdMerge::Ignore(_)),
        "LAN 来路的 lan 字段必须整体忽略"
    );
    // 已有缓存时,LAN 来路的更高序号照样不许动它。
    let old = cached(&pubkey, 3, NOW - 1000);
    let newer = LanAd { ad_seq: 99, ..ad.clone() };
    assert!(matches!(
        merge_peer_ad(Some(&old), &newer, Ingress::LanFrame, NOW),
        AdMerge::Ignore(_)
    ));
    assert!(matches!(
        merge_peer_ad(Some(&old), &newer, Ingress::RelayDeliver, NOW),
        AdMerge::Store { .. }
    ));
}

#[test]
fn stale_or_replayed_ad_seq_never_refreshes_listen_or_ttl() {
    // §2/二轮 M3:恶意中转重放旧 Hello 密文延不了旧地址的寿——只有 ad_seq 严格
    // 大于缓存值才刷新 listen 与 received_at。
    let (_s, pubkey) = crate::sync::pair::gen_device_key();
    let old = cached(&pubkey, 5, NOW - 1000);
    let mk = |seq: u64, port: u16| LanAd {
        pubkey: pubkey.to_vec(),
        ad_seq: seq,
        listen: Some(LanListen { port, addrs: vec!["192.168.1.99".into()] }),
    };
    // 倒序 / 相同:忽略(TTL 不刷新、listen 不改)。
    for seq in [0u64, 4, 5] {
        assert!(
            matches!(merge_peer_ad(Some(&old), &mk(seq, 2222), Ingress::RelayDeliver, NOW), AdMerge::Ignore(_)),
            "ad_seq={seq} 不该刷新缓存"
        );
    }
    // 推进一格:更新 listen 与 received_at。
    match merge_peer_ad(Some(&old), &mk(6, 2222), Ingress::RelayDeliver, NOW) {
        AdMerge::Store { record: s, cause } => {
            assert_eq!(cause, StoreCause::Advanced);
            assert_eq!(s.ad_seq, 6);
            assert_eq!(s.received_at, NOW);
            assert_eq!(s.listen.unwrap().port, 2222);
        }
        other => panic!("序号推进该写缓存,得到 {other:?}"),
    }
    // MAX 钉住后,更小值不为「恢复可用」而收(三轮 L2)。
    let pinned = cached(&pubkey, u64::MAX, NOW);
    assert!(matches!(
        merge_peer_ad(Some(&pinned), &mk(u64::MAX - 1, 3333), Ingress::RelayDeliver, NOW),
        AdMerge::Ignore(_)
    ));
    assert!(matches!(
        merge_peer_ad(Some(&pinned), &mk(u64::MAX, 3333), Ingress::RelayDeliver, NOW),
        AdMerge::Ignore(_)
    ));
}

#[test]
fn same_device_id_with_a_different_pubkey_is_loudly_disabled() {
    // §2 首见钉住:正常换钥必换 device_id / 走纪元,同 id 异钥只能是攻击或克隆
    // → 响亮禁用该对端直连,**不覆盖写**(缓存里那把仍是权威路首见的那把)。
    let (_s1, first) = crate::sync::pair::gen_device_key();
    let (_s2, second) = crate::sync::pair::gen_device_key();
    let old = cached(&first, 1, NOW);
    let conflicting = LanAd { pubkey: second.to_vec(), ad_seq: 100, listen: None };
    let AdMerge::Store { record, cause: StoreCause::KeyConflict } =
        merge_peer_ad(Some(&old), &conflicting, Ingress::RelayDeliver, NOW)
    else {
        panic!("同 id 异钥该报冲突,且必须走唯一落库出口");
    };
    // 带回的记录 = 原钉住的钥 + 粘滞禁用位:调用方照常落库,禁用随之持久。
    assert!(record.key_conflict);
    assert_eq!(record.pubkey, first.to_vec(), "新钥绝不覆盖写");
    assert_eq!(record.ad_seq, old.ad_seq, "冲突不推进序号");
    assert_eq!(record.usable_pubkey(), None, "禁用后拿不到验签钥");
    assert!(dial_candidates(&record, &subnets(), NOW).is_empty(), "禁用后一个候选都不给");

    // **粘滞**:落库重载后仍禁用,连原钥的新通告也不解封(codex L-b 审 M3)。
    let reloaded: LanPeerAd = {
        let mut buf = Vec::new();
        ciborium::into_writer(&record, &mut buf).unwrap();
        ciborium::from_reader(buf.as_slice()).unwrap()
    };
    assert!(reloaded.key_conflict, "禁用位必须过得了 CBOR 往返");
    let back_to_first = LanAd { pubkey: first.to_vec(), ad_seq: 200, listen: None };
    assert!(matches!(
        merge_peer_ad(Some(&reloaded), &back_to_first, Ingress::RelayDeliver, NOW),
        AdMerge::Ignore(_)
    ));

    // **异钥 + 畸形 listen 也必须报冲突,不许被 Malformed 掩盖**(公钥判定先于 listen)。
    let sneaky = LanAd {
        pubkey: second.to_vec(),
        ad_seq: 100,
        listen: Some(LanListen { port: 0, addrs: vec!["!!!".repeat(40)] }),
    };
    assert!(matches!(
        merge_peer_ad(Some(&old), &sneaky, Ingress::RelayDeliver, NOW),
        AdMerge::Store { cause: StoreCause::KeyConflict, .. }
    ));

    // 同一把钥、序号推进 = 正常路径(证明上面拒的是换钥不是别的)。
    let same = LanAd { pubkey: first.to_vec(), ad_seq: 2, listen: None };
    assert!(matches!(
        merge_peer_ad(Some(&old), &same, Ingress::RelayDeliver, NOW),
        AdMerge::Store { .. }
    ));
}

#[test]
fn legacy_cache_records_without_the_conflict_bit_load_as_enabled() {
    // codex L-b 二审:原测试只跑「新记录写、新记录读」,`#[serde(default)]` 其实没被
    // 测到——删掉它变异也不会红。这里用**冻结的旧记录形状**(无 key_conflict)编码,
    // 断言新类型读得进来且默认未禁用。
    #[derive(Serialize)]
    struct LegacyLanPeerAd {
        #[serde(with = "serde_bytes")]
        pubkey: Vec<u8>,
        ad_seq: u64,
        listen: Option<LanListen>,
        received_at: u64,
    }
    let (_s, pubkey) = crate::sync::pair::gen_device_key();
    let legacy = LegacyLanPeerAd {
        pubkey: pubkey.to_vec(),
        ad_seq: 3,
        listen: Some(LanListen { port: 24618, addrs: vec!["192.168.1.4".into()] }),
        received_at: NOW,
    };
    let mut buf = Vec::new();
    ciborium::into_writer(&legacy, &mut buf).unwrap();
    let loaded: LanPeerAd = ciborium::from_reader(buf.as_slice())
        .expect("旧记录(无 key_conflict)必须读得进新类型");
    assert!(!loaded.is_disabled(), "缺席 = 未禁用,不是禁用");
    assert_eq!(loaded.usable_pubkey(), Some(pubkey));
    assert_eq!(loaded.ad_seq, 3);
    // 旧记录照样能继续按序号推进(不需要迁移)。
    let next = LanAd { pubkey: pubkey.to_vec(), ad_seq: 4, listen: None };
    assert!(matches!(
        merge_peer_ad(Some(&loaded), &next, Ingress::RelayDeliver, NOW),
        AdMerge::Store { cause: StoreCause::Advanced, .. }
    ));
}

#[test]
fn accept_still_reverifies_the_mac_of_its_capability() {
    // M1 的纵深:凭据绑住 Intro 后,「换一枚 Intro」从生产侧已不可写;但 accept 里那次
    // MAC 复验仍留着,防日后 resolve_intro 被错重构成「返回首项」。测试模块是 lan 的
    // 子模块,能伪造凭据 —— 正好用它证明复验真的在守门(生产侧构造不出)。
    let p = peers();
    let mut dup = DupCache::new();
    // 一枚拨向 DEV_Z 的 Intro(MAC 绑的 L = DEV_Z),硬塞给 DEV_X 空间的凭据。
    let (_, foreign_w) = LanDialer::start(&DialParams { peer_device: DEV_Z, ..p.dial_params() });
    let foreign = Intro::parse(&foreign_w).unwrap();
    let admits = [p.admit()];
    let forged = ResolvedIntro { admit: &admits[0], intro: foreign, index: 0 };
    assert_eq!(
        LanListener::accept(&forged, &p.gate(), &mut dup, NOW).err(),
        Some(LanError::NoMatch)
    );
    assert_eq!(dup.len(), 0, "MAC 复验不过时不该占重复抑制槽");
}

#[test]
fn malformed_ads_are_ignored_without_touching_the_hello() {
    // 通告是 advisory:形态不合只影响直连(诊断计数),绝不牵动这枚 Hello 的水位处理
    // ——所以 merge_peer_ad 根本没有 Err 出口。
    let bad_len = LanAd { pubkey: vec![0u8; 31], ad_seq: 1, listen: None };
    assert!(matches!(
        merge_peer_ad(None, &bad_len, Ingress::RelayDeliver, NOW),
        AdMerge::Malformed(_)
    ));
    // 非法曲线点(约一半 32B 串解压失败)。
    let bad_point = (0u8..=255)
        .map(|n| [n; 32])
        .find(|b| ed25519_dalek::VerifyingKey::from_bytes(b).is_err())
        .expect("256 个候选里总有解压失败的");
    assert!(matches!(
        merge_peer_ad(None, &LanAd { pubkey: bad_point.to_vec(), ad_seq: 1, listen: None }, Ingress::RelayDeliver, NOW),
        AdMerge::Malformed(_)
    ));
    let (_s, pubkey) = crate::sync::pair::gen_device_key();
    // addrs 超上限。
    let flood = LanAd {
        pubkey: pubkey.to_vec(),
        ad_seq: 1,
        listen: Some(LanListen {
            port: 1,
            addrs: (0..MAX_LISTEN_ADDRS + 1).map(|i| format!("192.168.1.{i}")).collect(),
        }),
    };
    assert!(matches!(
        merge_peer_ad(None, &flood, Ingress::RelayDeliver, NOW),
        AdMerge::Malformed(_)
    ));
    // 单条地址文本超上限(对端可控字符串的资源上界:不限长度就能往 sync_meta 灌 1 MiB)。
    let long_addr = LanAd {
        pubkey: pubkey.to_vec(),
        ad_seq: 1,
        listen: Some(LanListen { port: 1, addrs: vec!["1".repeat(MAX_ADDR_TEXT + 1)] }),
    };
    assert!(matches!(
        merge_peer_ad(None, &long_addr, Ingress::RelayDeliver, NOW),
        AdMerge::Malformed(_)
    ));
    // 恰到上限 = 收(边界不误杀)。
    let at_limit = LanAd {
        pubkey: pubkey.to_vec(),
        ad_seq: 1,
        listen: Some(LanListen { port: 1, addrs: vec!["1".repeat(MAX_ADDR_TEXT)] }),
    };
    assert!(matches!(
        merge_peer_ad(None, &at_limit, Ingress::RelayDeliver, NOW),
        AdMerge::Store { .. }
    ));
    // 端口 0。
    let zero_port = LanAd {
        pubkey: pubkey.to_vec(),
        ad_seq: 1,
        listen: Some(LanListen { port: 0, addrs: vec!["192.168.1.5".into()] }),
    };
    assert!(matches!(
        merge_peer_ad(None, &zero_port, Ingress::RelayDeliver, NOW),
        AdMerge::Malformed(_)
    ));
}

// ---- §2 + 三轮 L2:ad_seq 的持久化与溢出纪律 ----

#[test]
fn ad_seq_parsing_is_canonical_only() {
    assert_eq!(parse_ad_seq("0").unwrap(), 0);
    assert_eq!(parse_ad_seq("7").unwrap(), 7);
    assert_eq!(parse_ad_seq(&u64::MAX.to_string()).unwrap(), u64::MAX);
    // 负号 / 前导 + / 前导零 / 空 / 非数字 / 越界:一律拒(fail-fast,不猜)。
    for bad in ["-1", "+1", "007", "", " 1", "1 ", "1e3", "0x10", "18446744073709551616"] {
        assert!(parse_ad_seq(bad).is_err(), "{bad:?} 该被拒");
    }
}

#[test]
fn ad_seq_saturates_loudly_instead_of_wrapping() {
    // MAX-1 → MAX 是最后一次合法通告;再发即 fail-fast 禁用本设备通告。
    assert_eq!(next_ad_seq(u64::MAX - 1).unwrap(), u64::MAX);
    assert!(next_ad_seq(u64::MAX).is_err(), "绝不回绕(回绕 = 收端永久钉死在旧地址)");
    assert_eq!(next_ad_seq(0).unwrap(), 1);
}

// ---- §7 候选过滤 ----

fn subnets() -> Vec<LocalSubnet> {
    vec![
        LocalSubnet::new("192.168.1.10".parse().unwrap(), 24).unwrap(),
        LocalSubnet::new("10.5.0.7".parse().unwrap(), 16).unwrap(),
    ]
}

#[test]
fn dial_candidates_must_sit_in_a_local_directly_connected_subnet() {
    let s = subnets();
    // 正路:同子网内的别台主机。
    assert_eq!(check_candidate("192.168.1.20", &s).unwrap(), "192.168.1.20".parse::<Ipv4Addr>().unwrap());
    assert!(check_candidate("10.5.9.9", &s).is_ok(), "/16 内的别号段照样是直连子网");
    // 公网 / 环回 / 未指定 / 链路本地 / CGNAT / 组播 / 全 1 广播:全拒。
    assert_eq!(check_candidate("203.0.113.5", &s), Err(CandidateReject::NotPrivate));
    assert_eq!(check_candidate("127.0.0.1", &s), Err(CandidateReject::Loopback));
    assert_eq!(check_candidate("0.0.0.0", &s), Err(CandidateReject::Unspecified));
    assert_eq!(check_candidate("169.254.1.1", &s), Err(CandidateReject::NotPrivate));
    assert_eq!(check_candidate("100.64.0.1", &s), Err(CandidateReject::NotPrivate));
    assert_eq!(check_candidate("224.0.0.1", &s), Err(CandidateReject::NotPrivate));
    assert_eq!(check_candidate("255.255.255.255", &s), Err(CandidateReject::NotPrivate));
    // 自身地址(两张网卡都要比,不只比命中那一枚)。
    assert_eq!(check_candidate("192.168.1.10", &s), Err(CandidateReject::SelfAddr));
    assert_eq!(check_candidate("10.5.0.7", &s), Err(CandidateReject::SelfAddr));
    // 网络地址 / 子网广播地址。
    assert_eq!(check_candidate("192.168.1.0", &s), Err(CandidateReject::NetworkAddr));
    assert_eq!(check_candidate("192.168.1.255", &s), Err(CandidateReject::BroadcastAddr));
    assert_eq!(check_candidate("10.5.255.255", &s), Err(CandidateReject::BroadcastAddr));
    // **私网但不在本机任何直连子网内**:这是「不是裸 RFC1918 全段」那一刀。
    assert_eq!(check_candidate("192.168.9.9", &s), Err(CandidateReject::OutsideSubnets));
    assert_eq!(check_candidate("172.16.0.5", &s), Err(CandidateReject::OutsideSubnets));
    // 不是 IPv4 文本形(IPv6 候选 v1 不做)。
    assert_eq!(check_candidate("fe80::1", &s), Err(CandidateReject::NotIpv4));
    assert_eq!(check_candidate("192.168.1", &s), Err(CandidateReject::NotIpv4));
    assert_eq!(check_candidate("", &s), Err(CandidateReject::NotIpv4));
    // /31 点对点无网络/广播语义:对端地址可拨。
    let p2p = vec![LocalSubnet::new("192.168.4.0".parse().unwrap(), 31).unwrap()];
    assert!(check_candidate("192.168.4.1", &p2p).is_ok());
    // 前缀不合法在构造处就拒,进不了过滤器。
    assert!(LocalSubnet::new("192.168.1.1".parse().unwrap(), 33).is_err());
}

#[test]
fn expired_listen_is_not_dialed() {
    // §0/§7/二轮 L2 的诚实边界:30 天没经中转见过对端通告,直连也不拨
    // ——「断网可用」的前提是双方缓存的通告未逾期。
    let (_s, pubkey) = crate::sync::pair::gen_device_key();
    let s = subnets();
    let ad = LanPeerAd {
        pubkey: pubkey.to_vec(),
        ad_seq: 1,
        listen: Some(LanListen { port: 24618, addrs: vec!["192.168.1.20".into()] }),
        received_at: NOW,
        key_conflict: false,
    };
    assert!(listen_fresh(&ad, NOW + LISTEN_TTL_MS));
    assert_eq!(dial_candidates(&ad, &s, NOW + LISTEN_TTL_MS).len(), 1);
    assert!(!listen_fresh(&ad, NOW + LISTEN_TTL_MS + 1));
    assert!(
        dial_candidates(&ad, &s, NOW + LISTEN_TTL_MS + 1).is_empty(),
        "逾期 listen 不拨(阴性对照)"
    );
    // 无 listen(手机侧通告)= 没有可拨候选。
    let phone = LanPeerAd { listen: None, ..ad.clone() };
    assert!(dial_candidates(&phone, &s, NOW).is_empty());
    // 混合地址:只留过滤得过的那些,顺序保通告序。
    let mixed = LanPeerAd {
        listen: Some(LanListen {
            port: 24618,
            addrs: vec![
                "203.0.113.9".into(),
                "192.168.1.30".into(),
                "192.168.1.10".into(), // 本机自己
                "10.5.1.1".into(),
            ],
        }),
        ..ad
    };
    let got: Vec<String> =
        dial_candidates(&mixed, &s, NOW).iter().map(|a| a.ip().to_string()).collect();
    assert_eq!(got, vec!["192.168.1.30".to_string(), "10.5.1.1".to_string()]);
}

/// §7 一级规则(方向优先级):同一对设备两侧代入各自的事实,**恰有一方**算出「该我
/// 拨」。三形照 §7 的 glare 测试清单摆:双方皆监听 / 手机 id 更大 / 手机 id 更小。
#[test]
fn exactly_one_side_dials_under_the_direction_rule() {
    let small = "01AAAAAAAAAAAAAAAAAAAAAAAA";
    let big = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
    // ① 双方皆可监听:小 id 拨,大 id 不拨。
    assert!(should_dial(true, small, big));
    assert!(!should_dial(true, big, small));
    // ② 一端不监听(手机)且 **id 更大**:它仍是唯一合法拨出方——这正是三轮 M3 点名
    //    「桌面侧规则不误杀」的那一形。桌面(监听、id 更小)也算得「该我拨」,但手机
    //    通告里没有 listen,`dial_candidates` 给空清单,故实际只有手机拨得出去。
    assert!(should_dial(false, big, small), "不监听的那端恒是合法方向");
    // ③ 手机 id 更小:同样照拨(与 id 无关)。
    assert!(should_dial(false, small, big));
    // ④ 双方都不监听(手机↔手机,§13 明示不做):两边都"愿意"拨,但两边都没有可拨的
    //    地址,故不会真拨出去。
    assert!(should_dial(false, small, big) && should_dial(false, big, small));
}

#[test]
fn advertised_addrs_are_private_only() {
    let s = vec![
        LocalSubnet::new("203.0.113.7".parse().unwrap(), 24).unwrap(),
        LocalSubnet::new("127.0.0.1".parse().unwrap(), 8).unwrap(),
        LocalSubnet::new("192.168.1.10".parse().unwrap(), 24).unwrap(),
        LocalSubnet::new("10.5.0.7".parse().unwrap(), 16).unwrap(),
    ];
    assert_eq!(advertisable_addrs(&s), vec!["192.168.1.10".to_string(), "10.5.0.7".to_string()]);
    assert!(advertisable_addrs(&[]).is_empty());
}

// ---- codex L-b 实现审补齐的锚 ----

#[test]
fn listener_rejects_bad_or_foreign_signature_on_confirm() {
    // codex L-b 审 M5:L 侧对 `Confirm.sig_d` 的验签原先没有变异锚——删掉那次 verify
    // 也没测试会红。这条守住「双向」设备证明的另一半。
    let p = peers();
    // 造一枚握手到「等 Confirm」的 L,并按需重封 Confirm 内层。
    let remake_confirm = |mutate: &dyn Fn(&mut LanMsg)| -> (LanListener, LanWire) {
        let mut dup = DupCache::new();
        let (mut d, intro_w) = LanDialer::start(&p.dial_params());
        let intro = Intro::parse(&intro_w).unwrap();
        let (listener, accept_w) =
            resolve_and_accept(&[p.admit()], &intro, &p.gate(), &mut dup, NOW).unwrap();
        let (confirm_w, _) = d.on_accept(&accept_w).unwrap();
        let LanWire::Confirm { blob } = confirm_w else { unreachable!() };
        let mut msg = crypto::open_msg::<LanMsg>(&p.k_acc, &confirm_addr(), &blob).unwrap();
        mutate(&mut msg);
        (
            listener,
            LanWire::Confirm { blob: crypto::seal_msg(&p.k_acc, &confirm_addr(), &msg) },
        )
    };
    // ① 签名翻一位(nonce 回显仍对 → 只可能挡在验签)。
    let (mut l, bad) = remake_confirm(&|m| {
        if let LanMsg::Confirm { sig_d, .. } = m {
            let last = sig_d.len() - 1;
            sig_d[last] ^= 1;
        }
    });
    assert_eq!(l.on_confirm(&wire_roundtrip(&bad)).err(), Some(LanError::BadSignature));
    assert!(matches!(l.on_confirm(&wire_roundtrip(&bad)), Err(LanError::Protocol(_))), "验签不过即死");
    // ② 签名截短。
    let (mut l, short) = remake_confirm(&|m| {
        if let LanMsg::Confirm { sig_d, .. } = m {
            sig_d.truncate(32);
        }
    });
    assert_eq!(l.on_confirm(&wire_roundtrip(&short)).err(), Some(LanError::BadSignature));
    // ③ 第三把钥签的(冒充 D:持 K_acc 但没有 D 的私钥)。
    let (other_seed, _) = crate::sync::pair::gen_device_key();
    let mut dup = DupCache::new();
    let (mut d, intro_w) = LanDialer::start(&p.dial_params());
    let intro = Intro::parse(&intro_w).unwrap();
    let (mut l, accept_w) =
        resolve_and_accept(&[p.admit()], &intro, &p.gate(), &mut dup, NOW).unwrap();
    let (confirm_w, _) = d.on_accept(&accept_w).unwrap();
    let LanWire::Confirm { blob } = confirm_w else { unreachable!() };
    let msg = crypto::open_msg::<LanMsg>(&p.k_acc, &confirm_addr(), &blob).unwrap();
    let LanMsg::Confirm { nonce_l, .. } = msg else { unreachable!() };
    // 同一 transcript、正确角色,只是签名者不对。
    let t = transcript(ACCT, DEV_D, DEV_X, intro.nonce_d, &nonce_l);
    let forged = LanWire::Confirm {
        blob: crypto::seal_msg(
            &p.k_acc,
            &confirm_addr(),
            &LanMsg::Confirm {
                nonce_l: nonce_l.clone(),
                sig_d: sign(&other_seed, &sig_payload(&t, ROLE_D)).to_vec(),
            },
        ),
    };
    assert_eq!(l.on_confirm(&wire_roundtrip(&forged)).err(), Some(LanError::BadSignature));
    // ④ 阴性对照:同一条造法换回 D 的真私钥 → 过(证明拒的是签名者)。
    let mut dup2 = DupCache::new();
    let (mut d2, intro_w2) = LanDialer::start(&p.dial_params());
    let intro2 = Intro::parse(&intro_w2).unwrap();
    let (mut l2, accept_w2) =
        resolve_and_accept(&[p.admit()], &intro2, &p.gate(), &mut dup2, NOW).unwrap();
    let (confirm_w2, _) = d2.on_accept(&accept_w2).unwrap();
    l2.on_confirm(&wire_roundtrip(&confirm_w2)).unwrap();
}

#[test]
fn active_link_gate_still_burns_the_dup_slot() {
    // codex L-b 审 M5:原测试只断言 LinkExists,把「已有活跃链」闸移到重复登记**之前**
    // 也不会红——而闸序一换,同一枚 Intro 就能在链路断开后被重放。
    let p = peers();
    let mut dup = DupCache::new();
    let (_, intro_w) = LanDialer::start(&p.dial_params());
    let intro_w = wire_roundtrip(&intro_w);
    let intro = Intro::parse(&intro_w).unwrap();
    let busy = IntroGate { peer_pubkey: Some(&p.d_pub), peer_link_active: true };
    assert_eq!(
        resolve_and_accept(&[p.admit()], &intro, &busy, &mut dup, NOW).err(),
        Some(LanError::LinkExists)
    );
    assert_eq!(dup.len(), 1, "登记必须发生在活跃链闸之前");
    // 链路断了、闸放开,同一枚 Intro 仍然是「花掉了」。
    assert_eq!(
        resolve_and_accept(&[p.admit()], &intro, &p.gate(), &mut dup, NOW).err(),
        Some(LanError::Duplicate)
    );
}

#[test]
fn wrong_outer_frame_kills_the_handshake() {
    // codex L-b 审 M2:「收到的不是该收的那个变体」也必须终局——否则可以先塞一帧 Ping
    // 制造协议错误、再补合法帧完成握手。
    let p = peers();
    let mut dup = DupCache::new();
    let (mut d, intro_w) = LanDialer::start(&p.dial_params());
    let intro = Intro::parse(&intro_w).unwrap();
    let (mut l, accept_w) =
        resolve_and_accept(&[p.admit()], &intro, &p.gate(), &mut dup, NOW).unwrap();
    // D 侧:先喂一帧 Ping → Err,此后连合法 Accept 也不再收。
    assert!(matches!(d.on_accept(&LanWire::Ping {}), Err(LanError::Protocol(_))));
    assert!(matches!(d.on_accept(&accept_w), Err(LanError::Protocol(_))));
    // L 侧同理(拿另一条会话的合法 Confirm 当「后补的合法帧」)。
    let mut dup2 = DupCache::new();
    let (mut d2, intro_w2) = LanDialer::start(&p.dial_params());
    let intro2 = Intro::parse(&intro_w2).unwrap();
    let (_l2, accept_w2) =
        resolve_and_accept(&[p.admit()], &intro2, &p.gate(), &mut dup2, NOW).unwrap();
    let (confirm_w2, _) = d2.on_accept(&accept_w2).unwrap();
    assert!(matches!(l.on_confirm(&LanWire::Pong {}), Err(LanError::Protocol(_))));
    assert!(matches!(l.on_confirm(&confirm_w2), Err(LanError::Protocol(_))));
}

#[test]
fn length_prefix_is_checked_before_allocation() {
    // codex L-b 审 M4:读端拿到 4 字节前缀就得判,别照对端给的数字去分配。
    let big = (LAN_FRAME_MAX as u32 + 1).to_be_bytes();
    assert!(matches!(
        checked_body_len(big, FramePhase::Established),
        Err(LanError::TooLarge(_))
    ));
    // u32 上限(≈4 GiB)在分配前就被挡住。
    assert!(matches!(
        checked_body_len(u32::MAX.to_be_bytes(), FramePhase::Established),
        Err(LanError::TooLarge(_))
    ));
    // 握手期上限更窄。
    let mid = (LAN_PREAUTH_FRAME_MAX as u32 + 1).to_be_bytes();
    assert!(matches!(checked_body_len(mid, FramePhase::PreAuth), Err(LanError::TooLarge(_))));
    assert_eq!(
        checked_body_len(mid, FramePhase::Established).unwrap(),
        LAN_PREAUTH_FRAME_MAX + 1
    );
    // 零长度帧不合法(CBOR 至少一字节)。
    assert_eq!(checked_body_len([0, 0, 0, 0], FramePhase::PreAuth), Err(LanError::Codec));
    // 边界值照收。
    assert_eq!(
        checked_body_len((LAN_PREAUTH_FRAME_MAX as u32).to_be_bytes(), FramePhase::PreAuth)
            .unwrap(),
        LAN_PREAUTH_FRAME_MAX
    );
}

#[test]
fn decode_wire_requires_exactly_one_value_per_frame() {
    // codex L-b 审 L5:严格「一帧一个值」——尾随垃圾拒,否则协议接受集大于黄金向量
    // 定义的那一个,别语言的严格 decoder 与本端会分叉。
    let ok = encode_wire(&LanWire::Ping {});
    assert!(decode_wire(&ok, FramePhase::Established).is_ok());
    let mut trailing = ok.clone();
    trailing.push(0xF6); // 追一个合法 CBOR null
    assert_eq!(decode_wire(&trailing, FramePhase::Established), Err(LanError::Codec));
    let mut junk = ok;
    junk.extend_from_slice(b"xx");
    assert_eq!(decode_wire(&junk, FramePhase::Established), Err(LanError::Codec));
}

#[test]
fn subnet_edges_are_rejected_regardless_of_enumeration_order() {
    // codex L-b 审 L2:重叠子网下「取第一个命中」会把更具体子网的广播地址当普通主机
    // 放行。两种枚举顺序都必须拒。
    let wide = LocalSubnet::new("192.168.1.10".parse().unwrap(), 16).unwrap();
    let narrow = LocalSubnet::new("192.168.1.10".parse().unwrap(), 24).unwrap();
    for order in [vec![wide, narrow], vec![narrow, wide]] {
        assert_eq!(
            check_candidate("192.168.1.255", &order),
            Err(CandidateReject::BroadcastAddr),
            "/24 的广播地址在 {order:?} 下被放行了"
        );
        assert_eq!(
            check_candidate("192.168.1.0", &order),
            Err(CandidateReject::NetworkAddr)
        );
        // 阴性对照:普通主机照过。
        assert!(check_candidate("192.168.1.77", &order).is_ok());
        // /16 自己的广播地址也拒。
        assert_eq!(
            check_candidate("192.168.255.255", &order),
            Err(CandidateReject::BroadcastAddr)
        );
    }
    // 构造闸:非法前缀进不来,字段私有故绕不过 new()。
    assert!(LocalSubnet::new("192.168.1.1".parse().unwrap(), 33).is_err());
    assert_eq!(narrow.addr(), "192.168.1.10".parse::<Ipv4Addr>().unwrap());
    assert_eq!(narrow.prefix(), 24);
}

#[test]
fn lan_ad_wire_format_is_pinned_for_both_shapes() {
    // codex L-b 审 L3:旧端忽略未知字段守不住**新版之间**的格式。桌面形态
    // (listen: Some)与手机形态(listen: None)各钉一份十六进制。
    let desktop = LanAd {
        pubkey: vec![0xAB; 32],
        ad_seq: 7,
        listen: Some(LanListen { port: 24618, addrs: vec!["10.0.0.2".into()] }),
    };
    assert_eq!(
        hex(&cbor(&desktop)),
        format!(
            "{}{}{}{}{}{}{}{}{}{}{}",
            "a3",                       // map(3)
            "667075626b6579",           // "pubkey"
            "5820",                     // bytes(32)
            "ab".repeat(32),
            "6661645f736571",           // "ad_seq"
            "07",                       // 7
            "666c697374656e",           // "listen"
            "a2",                       // map(2)
            "64706f727419602a",         // "port" / 24618 = 0x602a
            "656164647273",             // "addrs"
            "816831302e302e302e32",     // ["10.0.0.2"]
        ),
        "LanAd(桌面形态)的 CBOR 字节形态漂了"
    );
    let phone = LanAd { pubkey: vec![0xAB; 32], ad_seq: 1, listen: None };
    assert_eq!(
        hex(&cbor(&phone)),
        format!(
            "{}{}{}{}{}{}{}{}",
            "a3",
            "667075626b6579",
            "5820",
            "ab".repeat(32),
            "6661645f736571",
            "01",
            "666c697374656e",
            "f6", // null
        ),
        "LanAd(手机形态)的 CBOR 字节形态漂了"
    );
    // pubkey 必须是 CBOR bytes(0x58 0x20…),不是逐元素数组(serde_bytes 生效)。
    assert!(hex(&cbor(&phone)).contains(&format!("5820{}", "ab".repeat(32))));
    // 两形态都原样往返。
    for ad in [desktop, phone] {
        let back: LanAd = ciborium::from_reader(cbor(&ad).as_slice()).unwrap();
        assert_eq!(back, ad);
    }
}

#[test]
fn every_msg_variant_is_accounted_for_against_the_frozen_type() {
    // codex L-b 审 L3 的第二半:穷举 match 当锚——将来给 `Msg` 加顶层变体,这里编译
    // 不过,迫使加的人当场面对「顶层变体 = 协议破坏 = 必须升 PROTO_VER」这条纪律
    // (engine.rs 的 Msg 文档写着,但没有东西强制)。
    fn legacy_counterpart(m: &Msg) -> Option<&'static str> {
        match m {
            Msg::Hello { .. } => None, // 唯一被 lan 动过的变体,另有双形态对拍
            Msg::Ops { .. } => Some("Ops"),
            Msg::Want { .. } => Some("Want"),
            Msg::BlobWant { .. } => Some("BlobWant"),
            Msg::BlobHave { .. } => Some("BlobHave"),
            Msg::BlobPull { .. } => Some("BlobPull"),
            Msg::BlobDeny { .. } => Some("BlobDeny"),
            Msg::BlobChunk { .. } => Some("BlobChunk"),
        }
    }
    assert_eq!(legacy_counterpart(&Msg::Want { origin: "o".into(), from_seq: 1 }), Some("Want"));
    assert_eq!(
        legacy_counterpart(&Msg::Hello { watermarks: BTreeMap::new(), lan: None }),
        None
    );
}

// ---- 权威名册闸(identity-plan §5.11;367 第②笔) ----

/// 第四台。四象限探针要「两边都在 / 只在旧的里 / 只在新的里 / 两边都不在」四格,
/// 现成的三个常量差一个。
const DEV_W: &str = "01JZFAKEDEVW0000000000WWWW";

fn roster(entries: &[(&str, bool)]) -> Vec<RosterEntry> {
    entries.iter().map(|(d, a)| RosterEntry { device: (*d).to_string(), admin: *a }).collect()
}

/// §5.14 五轮收敛点名的 `gate_transition_cases`:四种 `Option<Set>` 变化 → newly-denied。
///
/// 每行给探针两列期望:`allows`(换完之后此刻准不准连)与 `hits`(是不是**这次**才变得
/// 不准)。⭐ **两列必须分开断**——它们是两件事,而把「本来就不在册」误算成 newly-denied
/// 正是最容易写出来的那个 bug(见 `NewlyDenied::hits` 的注释);只断一列的话,第 2、8 行
/// 那个 `W` 探针就白站了。
#[test]
fn gate_transition_cases() {
    struct Case {
        what: &'static str,
        before: Option<&'static [(&'static str, bool)]>,
        after: Option<&'static [(&'static str, bool)]>,
        /// (peer, 换完之后 allows, 这次 hits)
        probes: &'static [(&'static str, bool, bool)],
    }

    let cases = [
        Case {
            what: "None → Some(S):不在 S 里的全是新被拒的(旧的恒放行 ⇒ 差集不是空集)",
            before: None,
            after: Some(&[(DEV_D, true), (DEV_Z, false)]),
            probes: &[
                (DEV_D, true, false),
                (DEV_Z, true, false),
                (DEV_X, false, true),
                (DEV_W, false, true),
            ],
        },
        Case {
            what: "Some(A) → Some(B):只有 A−B 算新拒;两边都不在的此刻不准连、但不是这次才变的",
            before: Some(&[(DEV_D, true), (DEV_X, false)]),
            after: Some(&[(DEV_D, true), (DEV_Z, false)]),
            probes: &[
                (DEV_D, true, false),
                (DEV_X, false, true),
                (DEV_Z, true, false),
                (DEV_W, false, false),
            ],
        },
        Case {
            what: "Some(_) → None:退回 fail-open,谁也不 abort(会话收场走的就是这一格)",
            before: Some(&[(DEV_D, true)]),
            after: None,
            probes: &[(DEV_D, true, false), (DEV_X, true, false), (DEV_W, true, false)],
        },
        Case {
            what: "None → None:什么也没发生",
            before: None,
            after: None,
            probes: &[(DEV_D, true, false), (DEV_X, true, false)],
        },
        Case {
            what: "只多了一台无关设备:不得被当成 peer 已被移除(§5.14-3c⑤)",
            before: Some(&[(DEV_D, true), (DEV_X, false)]),
            after: Some(&[(DEV_D, true), (DEV_X, false), (DEV_Z, false)]),
            probes: &[
                (DEV_D, true, false),
                (DEV_X, true, false),
                (DEV_Z, true, false),
                (DEV_W, false, false),
            ],
        },
        Case {
            what: "只改 admin 标记:投影后同集合,谁也不 abort(§5.14-3c⑤)",
            before: Some(&[(DEV_D, false), (DEV_X, true)]),
            after: Some(&[(DEV_D, true), (DEV_X, false)]),
            probes: &[(DEV_D, true, false), (DEV_X, true, false), (DEV_W, false, false)],
        },
        Case {
            what: "同内容的新 revision 又来一枚:不 abort",
            before: Some(&[(DEV_D, true), (DEV_X, false)]),
            after: Some(&[(DEV_D, true), (DEV_X, false)]),
            probes: &[(DEV_D, true, false), (DEV_X, true, false), (DEV_W, false, false)],
        },
        Case {
            what: "Some(空集):服务器真说了空 ⇒ 挡住所有人,在册过的那些是这次才被拒的",
            before: Some(&[(DEV_D, true), (DEV_X, false)]),
            after: Some(&[]),
            probes: &[(DEV_D, false, true), (DEV_X, false, true), (DEV_W, false, false)],
        },
        Case {
            what: "顺序与重复条目不影响投影(集合语义)",
            before: Some(&[(DEV_D, true), (DEV_X, false)]),
            after: Some(&[(DEV_X, false), (DEV_D, true), (DEV_X, false)]),
            probes: &[(DEV_D, true, false), (DEV_X, true, false)],
        },
    ];

    for c in &cases {
        let mut gate = RosterGate::default();
        // 先摆好「换之前」那一份。布景这一步产出的判据与本例无关,**显式丢掉** ——
        // 这里刻意不写一句「顺手断一下」的弱断言:它在 `before.is_some()` 的那几行会
        // 恒真,而恒真的断言是无效变异,比一句 `drop` 更会骗人(自检清单 11)。
        drop(gate.apply_roster(c.before.map(roster).as_deref()));
        let denied = gate.apply_roster(c.after.map(roster).as_deref());
        for (peer, allows, hits) in c.probes {
            assert_eq!(gate.allows(peer), *allows, "{}:allows({peer})", c.what);
            assert_eq!(denied.hits(peer), *hits, "{}:hits({peer})", c.what);
        }
    }
}

/// ⛔ **`None` 绝不许被折成空集合**(§5.11)—— 一红一绿对照,单独站着。
///
/// 两次 `allows(DEV_X)` 的输入差别只有那一个 `Option`,结论却正好相反:有名册且不在册
/// ⇒ 拒;没有名册 ⇒ 放行。把 `None` 折成空集合的实现会让**第二句**跟着变成拒 ——
/// 「路由器断了外网也照样同步」这条招牌承诺当场失效,而且失效得很安静(状态面只会显示
/// `lan_peers = 0`)。这是这道闸最贵的错法,故不并进上面那张矩阵。
#[test]
fn unknown_roster_is_fail_open_and_never_folds_into_an_empty_set() {
    let mut gate = RosterGate::default();
    // 绿:出厂态 = 从没收到过名册 ⇒ 谁都放行。
    assert!(gate.allows(DEV_X), "出厂态必须 fail-open");
    assert!(gate.allows(DEV_D));

    // 红:服务器说了话,而 X 不在册 —— 且 X 正是「这次才被拒的」那一类。
    let denied = gate.apply_roster(Some(&roster(&[(DEV_D, true)])));
    assert!(!gate.allows(DEV_X), "有名册且不在册 ⇒ 拒");
    assert!(gate.allows(DEV_D), "在册的不受影响");
    assert!(denied.hits(DEV_X), "None → Some 时,不在册的对端就是这次新被拒的");
    assert!(!denied.hits(DEV_D));

    // 绿:退回「不知道」⇒ 又放行(而不是「上一份名册继续拦着」或「空集合拦住所有人」)。
    let denied = gate.apply_roster(None);
    assert!(gate.allows(DEV_X), "退回 None 必须 fail-open");
    assert!(gate.allows(DEV_D));
    assert!(!denied.hits(DEV_X), "Some → None 谁也不 abort");
}
