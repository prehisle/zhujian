use super::*;

// ---- 专用短连接流程(命令面直调,不经传输任务) ----

/// 创建账户(§8;open-signup 无感创号):账户 ULID 本函数自生成——服务器准入
/// 开放,fresh 账户直接 TOFU,用户全程无码。专用短连接 register_first(§4 原子
/// TOFU 首台),成功即写配置(含纪元标记)并返回恢复码(强制仪式的数据面)。
/// 之后 poke `Control::Reconfigured` 让传输任务上线。
///
/// 碰撞论证(open-signup §1.4):ULID = 48-bit 时间戳 + 80-bit 随机,与 device/
/// item 身份同一假设强度;撞上服务器已有账户也只得 not_first,发生在写本地配置
/// 之前,重试即换新 ID。
///
/// 本包装**只许尾调用**(词法闸钉着):生成与网络全在 `create_account_as` 内、
/// 严格电池之后,包装层不得再加任何暂停点。
pub async fn create_account(
    db: &Arc<Mutex<Connection>>,
    server_url: &str,
) -> Result<String, String> {
    create_account_as(db, server_url, None).await
}

/// 定点账户版(`create_account` 的全部实现;`fixed_account_id` 是 `pub(crate)`
/// 测试注入口,公开面只有 None=自生成——open-signup §2 不留第二公开入口)。
pub(crate) async fn create_account_as(
    db: &Arc<Mutex<Connection>>,
    server_url: &str,
    fixed_account_id: Option<&str>,
) -> Result<String, String> {
    let url = ws_endpoint(server_url)?;
    let device_id = {
        let conn = db.lock().expect("db mutex poisoned");
        if load_config(&conn)?.is_some() {
            return Err("本机已加入账户".into());
        }
        // 创号端严格认证(epoch-plan §3.5,create_account 关旁路):「创号新库天生零
        // legacy」不是事实——main 空间允许先有本地记录。RegisterFirst **之前**就跑
        // 严格电池,不过则网络注册都不发生(legacy 未配置库要无损创号:先走本地身份
        // 轮换压实 epoch::compact,再回来创号)。
        boot::strict_battery(&conn).map_err(|e| {
            format!("本空间历史数据早于同步纪元,不能直接创建账户(严格审计:{e})——先执行压实/认证,或清空本空间")
        })?;
        meta_get(&conn, "device_id")?.ok_or_else(|| "sync_meta 缺 device_id".to_string())?
    };
    // 账户身份在严格电池**之后**才产生(open-signup §2 顺序纪律,审 L5):公开路
    // 自生成,同一值随后用于签名与 save_config;电池不过则连 ID 都不生成。
    let account_id = match fixed_account_id {
        Some(id) => id.to_owned(),
        None => ulid::Ulid::new().to_string(),
    };
    let account_id = account_id.as_str();
    // 密钥材料 attempt 内存生成、Done 才落库(multispace-plan §4:不进 pending)。
    // 注册后、落库前中断(取消/崩溃)= 服务器留下孤儿注册:重试自生成新账户 ULID、
    // 同 device_id 撞 device_id_taken(文案带设备号);恢复=运营者按 device 反查
    // 吊销孤儿后**原库原样重试,不清库**(open-signup §1.5)。不加恢复机械。
    let mut k_acc = [0u8; 32];
    OsRng.fill_bytes(&mut k_acc);
    let (seed, _pub) = pair::gen_device_key();
    let pubkey = pubkey_of(&seed);
    let code = crypto::recovery_code(&k_acc);
    // 把解析器焊在生成路径上:编解不再互逆 = 实现漂移,当场响亮(恢复流程 P2-h 用它)。
    assert_eq!(crypto::parse_recovery_code(&code), Ok(k_acc), "恢复码编解必须互逆");

    let mut ws = dial(&url).await?;
    let nonce = expect_challenge(&mut ws).await?;
    let signing = SigningKey::from_bytes(&seed);
    let sig = signing.sign(&register_first_sig_payload(&nonce, account_id, &device_id, &pubkey));
    send_client(&mut ws, &ClientMsg::RegisterFirst {
        account: account_id.into(),
        device: device_id.clone(),
        pubkey: pubkey.to_vec(),
        sig: sig.to_bytes().to_vec(),
        // 创号的**专用短连接**:注册完即关,壳层随后才起 live 会话。名册那个 cap 刻意
        // 不声明(367),同纪元预注册那条短连接 —— 推来也没人消费,白占在途额度。
        caps: vec![],
    })
    .await?;
    loop {
        match recv_server(&mut ws, HANDSHAKE_SECS).await? {
            ServerMsg::Authed => break,
            ServerMsg::Err { code, msg } => {
                // 创号三类错误单独映射(open-signup §2:账户 ULID 自生成后语义
                // 全变——NOT_FIRST 不再意味着「用户的老账户」,只能是生成 ID 撞上
                // 已有/并发占用;AUTH_FAILED 只能是封禁或服务端异常;DEVICE_ID_TAKEN
                // 才是孤儿恢复正路,文案带本机 device_id 供运营者按设备反查吊销,
                // **不要清库**——main 的本地记录会被白白清掉,吊销后原库原样重试)。
                return Err(match code.as_str() {
                    err_code::DEVICE_ID_TAKEN => format!(
                        "设备身份仍被之前的注册占用(多半是上次创号中断留下的孤儿):不要清库——把本机设备号 {device_id} 报给运营者吊销后,在本空间原样重试"
                    ),
                    err_code::NOT_FIRST => "账户标识冲突(生成的账户号撞上了已有账户,概率极低):重试一次即换新号".to_string(),
                    err_code::AUTH_FAILED => "服务器拒绝创建账户(账户可能被封禁,或服务端版本不符)".to_string(),
                    _ => human_err(&code, &msg),
                });
            }
            _ => continue,
        }
    }
    // 提交边界纪律(phone-space-plan §1.2,对齐 pair_join):`save_config` 是
    // **最后线性化点**,且 Authed 之后到返回**一个 await 都没有**——连 close 都
    // 不发(同步 drop 关 TCP;实现审 M1:礼貌 close 可以无界 Pending,不切空间
    // 就永远「创建中」、切空间就把已注册变孤儿)。服务器对突然断开本就有 detach
    // 处理。壳层用 shutdown select! 包住本 future 时,取消要么落在提交前(什么
    // 都没写),要么根本抢不进提交后——绝不「报已取消、账户实已落库、码丢失」。
    drop(ws);
    {
        let mut conn = db.lock().expect("db mutex poisoned");
        save_config(&mut conn, account_id, &k_acc, &seed, server_url, true)?;
    }
    Ok(code)
}

/// 加入账户(§8 sync_pair_join):专用短连接入配对槽跑 SPAKE2(joiner 侧),拿到
/// 账户材料即写配置(不落纪元标记——引导未做)。之后 poke `Control::Reconfigured`,
/// 传输任务 auth 后见 bootstrapped_at 缺席自动走引导。
///
/// `account_gate`:两阶段账户唯一闸(multispace-plan §4,`Grant → gate → Enroll`)
/// ——joiner 在 [`PairOutput::GrantPending`] 停点交出 account_id,Err = PairClose
/// 走人:**Enroll 从未发出、老端从不注册、配置一个键都不写**,本机设备身份不烧、
/// 重扫别的账户照常(工序 7/8 审查 H1:gate 若卡在 Done 之后,误扫已占用账户会
/// 白白烧掉本机 device_id)。裁决先于一切可见状态:材料从未落库,并发控制命令
/// 看不到任何中间态。
pub async fn pair_join(
    db: &Arc<Mutex<Connection>>,
    server_url: &str,
    code: &str,
    account_gate: impl Fn(&str) -> Result<(), String> + Send,
) -> Result<(), String> {
    let url = ws_endpoint(server_url)?;
    let (slot, secret) = pair::parse_pair_code(code).map_err(|e| e.to_string())?;
    let device_id = {
        let conn = db.lock().expect("db mutex poisoned");
        if load_config(&conn)?.is_some() {
            return Err("本机已加入账户".into());
        }
        // 提前响亮(legacy 数据给人话指引);导入事务内还会重验,这里不是并发方案。
        boot::check_fresh_to_account(&conn)?;
        meta_get(&conn, "device_id")?.ok_or_else(|| "sync_meta 缺 device_id".to_string())?
    };
    // 设备种子 attempt 内存生成、Done 才随配置落库(multispace-plan §4:不进 pending)。
    // enroll 后、落库前崩溃 = 同 device_id 换新 pubkey 重试会撞 device_id_taken
    // → 人话指引清掉该空间重来(§4 拍板:服务器残留一个永不上线的 device_id 可接受)。
    let (seed, _pub) = pair::gen_device_key();
    let pubkey = pubkey_of(&seed);
    let mut joiner =
        pair::Joiner::new(slot, &secret, DeviceEnroll { device_id, pubkey: pubkey.to_vec() });

    let mut ws = dial(&url).await?;
    send_client(&mut ws, &ClientMsg::PairJoin { slot }).await?;
    let grant: AccountGrant = loop {
        match recv_server(&mut ws, PAIR_TIMEOUT_SECS).await? {
            ServerMsg::Challenge { .. } => continue, // 连接即发;配对入口用不上。
            ServerMsg::PairMsg { blob, .. } => {
                let outs = match joiner.on_msg(&blob) {
                    Ok(o) => o,
                    Err(e) => {
                        let _ = send_client(&mut ws, &ClientMsg::PairClose { slot }).await;
                        return Err(e.to_string());
                    }
                };
                let mut got = None;
                for o in outs {
                    match o {
                        PairOutput::Send(b) => {
                            send_client(&mut ws, &ClientMsg::PairMsg { slot, blob: b }).await?;
                        }
                        // §4 两阶段停点(工序 7/8 审查 H1):Grant 解出、Enroll 未发。
                        // gate 拒 = PairClose 走人——老端从未收到 Enroll、register_device
                        // 从未发生,本机设备身份不烧、重扫别的账户照常。
                        PairOutput::GrantPending { account_id } => {
                            if let Err(e) = account_gate(&account_id) {
                                let _ =
                                    send_client(&mut ws, &ClientMsg::PairClose { slot }).await;
                                let _ = ws.close(None).await;
                                return Err(e);
                            }
                            for a in joiner.approve().map_err(|e| e.to_string())? {
                                match a {
                                    PairOutput::Send(b) => {
                                        send_client(&mut ws, &ClientMsg::PairMsg { slot, blob: b })
                                            .await?;
                                    }
                                    other => return Err(format!("approve 不该输出 {other:?}")),
                                }
                            }
                        }
                        PairOutput::Granted(g) => got = Some(g),
                        other => return Err(format!("joiner 不该输出 {other:?}")),
                    }
                }
                if let Some(g) = got {
                    break g;
                }
            }
            ServerMsg::PairPeer { event: PairEvent::Left | PairEvent::Closed } => {
                return Err("配对被对端中止(配对码不对,或对方已关闭)".into());
            }
            ServerMsg::Err { code, msg } => return Err(human_err(&code, &msg)),
            _ => continue,
        }
    };
    let k: [u8; 32] = grant
        .k_acc
        .as_slice()
        .try_into()
        .map_err(|_| "账户材料 K_acc 长度不对".to_string())?;
    // save_config 必须是本 future 最后一个、其后无 await 的线性化点(工序 9 二审 H1):
    // 外层壳把 pair_join 未决 + shutdown 当「取消」——若提交后还有 await(旧顺序里
    // 的 ws.close),shutdown 落在那一刻会把「配置已落盘的成功配对」误报成「已取消」
    // (DB 已配、catalog 却显示未配,重启才自愈)。故先 best-effort 关 socket(此时
    // 尚未提交:落此 await 被取消 = 本地未配置、§19),再提交、立即返回(无 await)。
    let _ = ws.close(None).await;
    {
        let mut conn = db.lock().expect("db mutex poisoned");
        save_config(&mut conn, &grant.account_id, &k, &seed, &grant.server_url, false)?;
    }
    Ok(())
}

