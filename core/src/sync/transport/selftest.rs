use super::*;

// ---- M3 网络栈真机闸门诊断(android-plan §9) ----

/// [`net_probe`] 的单项结果:`name` 是稳定标识,`detail` 是佐证或失败原因(人话)。
#[derive(Debug, Clone, Serialize)]
pub struct ProbeStep {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

fn probe_step(name: &'static str, r: Result<String, String>) -> ProbeStep {
    match r {
        Ok(detail) => ProbeStep { name, ok: true, detail },
        Err(detail) => ProbeStep { name, ok: false, detail },
    }
}

/// M3 网络栈真机闸门(android-plan §9):逐项真跑同步栈的密码学与网络路径,给安卓
/// 诊断页当验收面——62 的 rusqlite 绿灯不外推到 WSS(ring 含 C/汇编、依赖 NDK clang,
/// 必须真机逐项证)。跑的就是真同步用的那套代码(pair/crypto/dial),不是平行实现;
/// 单测对本地服务全绿 = 诊断逻辑正确,真机再跑只剩平台差异。六项独立跑完不短路:
/// 诊断要全景,红哪项报哪项。
pub async fn net_probe(server_url: &str) -> Vec<ProbeStep> {
    vec![
        probe_step("tls-provider", probe_tls_provider()),
        probe_step("os-rng", probe_os_rng()),
        probe_step("ed25519", probe_ed25519()),
        probe_step("spake2-pair", probe_pair_roundtrip()),
        probe_step("xchacha-hkdf", probe_frame_roundtrip()),
        probe_step("wss-challenge", probe_challenge(server_url).await),
    ]
}

/// ring 提供者已装(app 壳 run() 的 install_default 纪律,android-plan §1 M2)+
/// TLS 客户端配置可构造(84 真机回归锚 `wss_tls_provider_present` 的运行期形态)。
fn probe_tls_provider() -> Result<String, String> {
    let p = rustls::crypto::CryptoProvider::get_default().ok_or_else(|| {
        "CryptoProvider 未安装——app 壳 run() 必须先 install_default".to_string()
    })?;
    let _ = rustls::ClientConfig::builder()
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth();
    Ok(format!("ring 已装({} 套密码组),TLS 配置可构造", p.cipher_suites.len()))
}

/// 系统熵源(密钥/nonce 的唯一来源):两把 32B 各异且非全零。
fn probe_os_rng() -> Result<String, String> {
    let mut a = [0u8; 32];
    let mut b = [0u8; 32];
    OsRng.try_fill_bytes(&mut a).map_err(|e| format!("OsRng 不可用:{e}"))?;
    OsRng.try_fill_bytes(&mut b).map_err(|e| format!("OsRng 不可用:{e}"))?;
    if a == [0u8; 32] || a == b {
        return Err("OsRng 输出可疑(全零或两次相同)".into());
    }
    Ok(format!("32B×2 各异(首 4B {})", hex(&a[..4])))
}

/// Ed25519 生钥/签名/验签(设备鉴权钥同款路径),含篡改必败的反向证。
fn probe_ed25519() -> Result<String, String> {
    let (seed, pubkey) = pair::gen_device_key();
    let signing = SigningKey::from_bytes(&seed);
    let msg = b"zhujian net-probe m3";
    let sig = signing.sign(msg);
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&pubkey)
        .map_err(|e| format!("公钥不是合法曲线点:{e}"))?;
    use ed25519_dalek::Verifier;
    vk.verify(msg, &sig).map_err(|e| format!("验签失败:{e}"))?;
    if vk.verify(b"tampered", &sig).is_ok() {
        return Err("篡改消息竟验签通过".into());
    }
    Ok(format!("签验 OK(pub 首 4B {})", hex(&pubkey[..4])))
}

/// SPAKE2 配对全流程本地对跑(Opener×Joiner 互喂,pair.rs 单测同款盲桥驱动):
/// 双向材料(账户 K_acc / 设备公钥)逐字节对得上——SPAKE2 群运算 + 会话子钥
/// XChaCha 封解在本设备真跑了一遍。
fn probe_pair_roundtrip() -> Result<String, String> {
    let slot: u64 = 0xD1A6;
    let secret = pair::gen_secret();
    let mut k_acc = [0u8; 32];
    OsRng.try_fill_bytes(&mut k_acc).map_err(|e| format!("OsRng 不可用:{e}"))?;
    let account_id = ulid::Ulid::new().to_string();
    let grant = AccountGrant {
        account_id: account_id.clone(),
        k_acc: k_acc.to_vec(),
        server_url: "wss://probe.invalid/ws".into(),
    };
    let (_seed, pubkey) = pair::gen_device_key();
    let device_id = ulid::Ulid::new().to_string();
    let enroll = DeviceEnroll { device_id: device_id.clone(), pubkey: pubkey.to_vec() };

    let mut opener = pair::Opener::new(slot, &secret, grant);
    let mut joiner = pair::Joiner::new(slot, &secret, enroll);
    let mut to_joiner: Vec<Vec<u8>> = vec![];
    for out in opener.on_joined().map_err(|e| e.to_string())? {
        match out {
            PairOutput::Send(b) => to_joiner.push(b),
            other => return Err(format!("on_joined 不该输出 {other:?}")),
        }
    }
    let (reg_device, reg_pubkey) = 'bridge: loop {
        let mut to_opener: Vec<Vec<u8>> = vec![];
        for b in to_joiner.drain(..) {
            for out in joiner.on_msg(&b).map_err(|e| e.to_string())? {
                match out {
                    PairOutput::Send(x) => to_opener.push(x),
                    // §4 账户闸停点:自检即刻放行(闸逻辑不在诊断范围)。
                    PairOutput::GrantPending { .. } => {
                        for a in joiner.approve().map_err(|e| e.to_string())? {
                            match a {
                                PairOutput::Send(x) => to_opener.push(x),
                                other => return Err(format!("approve 不该输出 {other:?}")),
                            }
                        }
                    }
                    other => return Err(format!("Register 前 joiner 不该输出 {other:?}")),
                }
            }
        }
        if to_opener.is_empty() {
            return Err("配对对跑停摆(双方无帧可发也没到 Register)".into());
        }
        for b in to_opener.drain(..) {
            for out in opener.on_msg(&b).map_err(|e| e.to_string())? {
                match out {
                    PairOutput::Send(x) => to_joiner.push(x),
                    PairOutput::Register { device_id, pubkey } => {
                        break 'bridge (device_id, pubkey);
                    }
                    other => return Err(format!("opener 不该输出 {other:?}")),
                }
            }
        }
    };
    if reg_device != device_id || reg_pubkey != pubkey {
        return Err("opener 收到的设备材料与 joiner 发出的不一致".into());
    }
    let outs = opener.on_registered().map_err(|e| e.to_string())?;
    let done = match outs.first() {
        Some(PairOutput::Send(b)) => b.clone(),
        _ => return Err("on_registered 首条输出不是 Done 线报".into()),
    };
    match joiner.on_msg(&done).map_err(|e| e.to_string())?.as_slice() {
        [PairOutput::Granted(g)]
            if g.k_acc.as_slice() == k_acc.as_slice() && g.account_id == account_id => {}
        _ => return Err("joiner 拿到的账户材料与 opener 交付的不一致".into()),
    }
    Ok("SPAKE2 全流程 + 材料 AEAD 封解一致".into())
}

/// op 域封解帧 roundtrip(真同步收发的主路径):HKDF 域子钥 + XChaCha20-Poly1305 +
/// AAD 五元组;附反向证:错域解必败(域隔离在干活)。
fn probe_frame_roundtrip() -> Result<String, String> {
    let mut k_acc = [0u8; 32];
    OsRng.try_fill_bytes(&mut k_acc).map_err(|e| format!("OsRng 不可用:{e}"))?;
    let acct = ulid::Ulid::new().to_string();
    let from = ulid::Ulid::new().to_string();
    let addr = FrameAddr { account_id: &acct, from_device: &from, to: "*", domain: Domain::Op };
    let plain = format!("zhujian net-probe {}", hex(&k_acc[..4]));
    let blob = crypto::seal_msg(&k_acc, &addr, &plain);
    let opened: String = crypto::open_msg(&k_acc, &addr, &blob).map_err(|e| e.to_string())?;
    if opened != plain {
        return Err("解帧内容与封入不一致".into());
    }
    let wrong = FrameAddr { domain: Domain::Ctl, ..addr };
    if crypto::open_msg::<String>(&k_acc, &wrong, &blob) != Err(OpenError::Decrypt) {
        return Err("错域解帧竟通过(域隔离失效)".into());
    }
    Ok(format!("op 域封解 {}B 帧 OK,错域必拒", blob.len()))
}

/// 拨号到收 Challenge:DNS → TCP → (wss 则 rustls 握手,webpki roots 验证书)→
/// WS 升级 → 服务器首帧 Challenge。到这步,传输栈的平台面全部趟过;不注册不鉴权,
/// 对生产服务器零副作用。
async fn probe_challenge(server_url: &str) -> Result<String, String> {
    let url = ws_endpoint(server_url)?;
    let mut ws = dial(&url).await?;
    let nonce = expect_challenge(&mut ws).await?;
    let _ = ws.close(None).await;
    Ok(format!("{url} 已收到 Challenge({}B nonce)", nonce.len()))
}

