use super::*;

async fn connect_and_auth(
    t: &mut Transport,
    cfg: &SyncConfig,
    pumps: &mut Pumps,
    url: &str,
) -> Result<Connected, String> {
    let wrote = t.wrote.clone();
    // **首次连接就被卡死的那一路也得有断网期 Hello**(实现审二轮 M1):这只计时器出生是空的,
    // 而「会话收场后置成立刻」在从没连上过时根本轮不到,`until(None)` 又永不就绪——于是坏中转
    // 卡住第一次握手时,§5 要的 60s 定向 Hello 一枚都不会发。进建连即武装;**只有鉴权成功才
    // 清**(拨号失败也清的话,退避 1s 起步时就成了每秒一枚的 Hello 洪流)。
    if pumps.lan_hello_due.is_none() {
        pumps.lan_hello_due = Some(Instant::now());
    }
    let mut connecting = std::pin::pin!(async {
        let mut ws = dial(url).await?;
        let nonce = expect_challenge(&mut ws).await?;
        let signing = SigningKey::from_bytes(&cfg.device_seed);
        let sig = signing.sign(&auth_sig_payload(&nonce, &cfg.account_id, &cfg.device_id));
        send_client(&mut ws, &ClientMsg::Auth {
            account: cfg.account_id.clone(),
            device: cfg.device_id.clone(),
            sig: sig.to_bytes().to_vec(),
            caps: vec![], // 工序4:本轮客户端不声明能力(编译兼容;声明 cap 与渲染属未来轮)。
        })
        .await?;
        loop {
            match recv_server(&mut ws, HANDSHAKE_SECS).await? {
                ServerMsg::Authed => return Ok(ws),
                ServerMsg::Err { code, msg } => return Err(human_err(&code, &msg)),
                _ => continue,
            }
        }
    });
    loop {
        let woke = tokio::select! {
            r = &mut connecting => return r.map(Connected::Ready),
            // 建连期**照收控制面**(实现审二轮 H1):这一段现在会做真活,把 `Reconfigured`
            // 一直积在通道里等于「配置改了却要等坏中转先超时」——纯换 server_url 那种连身份
            // 指纹都察觉不到,能被卡到天荒地老。
            c = t.control.recv() => match c {
                None => return Ok(Connected::HostGone),
                Some(Control::Reconfigured) => return Ok(Connected::Reconfigured),
                Some(Control::PairStart { reply }) => {
                    let _ = reply.send(Err("正在连接服务器,请稍后再试".into()));
                    Woke::Handled
                }
            },
            w = pump_wait(pumps, &wrote, true) => w,
        };
        if matches!(pump_apply(t, pumps, Some(cfg), woke).await, Pumped::GateTripped) {
            return Ok(Connected::Reconfigured);
        }
    }
}

/// [`connect_and_auth`] 的三种收场。
enum Connected {
    Ready(Ws),
    /// 建连期间配置/身份变了(收到 `Reconfigured`,或栅栏自证落下):回 `run` 顶重来。
    Reconfigured,
    /// 控制通道的发送端没了 = 壳层走了(同会话循环那一路)。
    HostGone,
}

impl Drop for Ctx<'_> {
    fn drop(&mut self) {
        // #4(codex 二审):session 任何退出点(Reconfigured/HostGone/断线/错误)都清源端
        // 明文快照。boot_recv 有自己的 Drop;kill/crash 残留由 app setup 的 sweep 兜底。
        if let Some(bo) = self.boot_out.take() {
            discard_boot_out(bo);
        }
    }
}

pub(super) async fn session(
    t: &mut Transport,
    cfg: &SyncConfig,
    backoff: &mut u64,
    pumps: &mut Pumps,
    // 通告面归属已对齐吗(false = 本轮整个关掉通告面,见 reconcile_lan_ad_owner)。
    lan_ad_ready: bool,
) -> Result<SessionEnd, String> {
    let url = ws_endpoint(&cfg.server_url)?;
    // 建连与挑战应答鉴权(§4):**这一段泵照转**(实现审 H1,见 [`connect_and_auth`])。
    let mut ws = match connect_and_auth(t, cfg, pumps, &url).await? {
        // **鉴权成功到会话仪式之间再自证一次**(实现审四轮 H1):建连期最后一次栅栏检查与
        // 服务器回 `Authed` 之间是一段谁也没查的窗口,而紧随其后的会话仪式(`reconcile` +
        // `on_relay_session_up` + Hello/Want/离线 op)全是拿 `cfg` 干的活——身份恰在这一窗
        // 换代,那一整轮就会被**旧 K_acc** 封了发出去。连接状态机切进会话状态机的这一步,
        // 是「拿当前身份干活」的第四条出口(前三条 = 会话循环各臂 / 泵 / 收场重问)。
        Connected::Ready(ws) => {
            if session_gate_tripped(&t.db, cfg) {
                return Ok(SessionEnd::Reconfigured);
            }
            ws
        }
        Connected::Reconfigured => return Ok(SessionEnd::Reconfigured),
        Connected::HostGone => return Ok(SessionEnd::HostGone),
    };
    *backoff = 1; // 鉴权成功才算连上,退避归位。
    // 拆开借:引擎槽要交给 `ctx`,别的几件留在本地给 select 臂用(读端与移交通道刻意不
    // 住在链路集里,否则那条臂会与 `ctx` 的可变借用打架,见 [`LanLinks::inbound_tx`])。
    let Pumps { slot, tick, handoff, lan_inbound, lan_faults, lan_hello_due, seat, .. } = pumps;
    let signing = SigningKey::from_bytes(&cfg.device_seed);
    // 中转会话**真建立了**才清断网期 Hello 的计时(§5 只在断线期间重发)。放在拨号之前
    // 清是个陷阱:拨号失败每轮都清一次,`run` 那句 `is_none()` 就永远成立,退避 1s 起步时
    // 等于每秒往每条链发一枚 Hello——一枚 advisory 的保活帧变成洪流。
    *lan_hello_due = None;

    let mut ctx = Ctx {
        db: t.db.clone(),
        clock: t.clock.clone(),
        status: t.status.clone(),
        events: t.events.clone(),
        data_dir: t.data_dir.clone(),
        cfg,
        signing,
        allow_boot_source: t.allow_boot_source,
        engine: slot,
        peers: VecDeque::new(),
        boot_peer: None,
        boot_recv: None,
        boot_deadline: None,
        boot_out: None,
        pair: None,
        space_blocked: false,
        reopen_required: None,
        boot_commit: t.boot_commit.clone(),
        restart_flag: t.restart_flag.clone(),
        sess: RelaySession { n: 0, tracked: HashMap::new(), ad: AdFace::new(lan_ad_ready) },
        seat: seat.clone(),
    };

    // 引导判据 = 运行时有没有把引擎交给我(`EngineSlot::reconcile` 内已判
    // bootstrapped_at):槽空 = fresh-to-account 加入者,先拿快照(§6.2)。
    if ctx.engine.booting() {
        ctx.set_status(|s| s.state = "booting".into());
    } else {
        ctx.relay_session_up(&mut ws).await?;
    }

    let control = &mut t.control;
    let wrote = t.wrote.clone();
    // 释放 → 唤醒那根线(§6.2 ④′)。**克隆把手挂在循环外**:`ctx.engine` 在 select 的
    // 别的臂里被可变借用,而铃只是个 `Arc`。它住引擎槽、跨会话存活,故上一条会话没消费
    // 掉的那枚 permit 会被新会话第一轮 select 直接领走 —— 不丢。
    let ops_changed = Arc::clone(&ctx.engine.ops_changed);
    let mut last_rx = Instant::now();

    loop {
        // 封闸/身份换代栅栏(实现审 M1 四轮定形):在 frame/wrote/tick 三臂**做实际
        // 工作之前**各查一次、不节流——节流或只挂循环顶都留「唤醒事件先于下次检查」
        // 的单帧跨闸窗;逐事件几条点查 SELECT 相对帧处理本身的整事务可忽略。
        //
        // **刻意不再 `biased`**(L-c2c):多了 lan 那两条臂之后,固定臂序就是「谁饿死谁」
        // ——中转帧的追赶洪流会把 lan 臂连同心跳一起饿死(链路 90s 静默即被误判死、图的
        // 惩罚永不到期),反过来 lan 洪流也能饿死中转臂。随机选臂两条腿都不会被对方拖死
        // (同 L-c2a 实现审 M2 从离线泵里删 `biased` 的理由);控制通道的及时性由「每轮
        // 都被轮询」保证,停机另有 `run` 外层那只 select 兜底。
        let woke = tokio::select! {
            c = control.recv() => match c {
                None => return Ok(SessionEnd::HostGone),
                Some(Control::Reconfigured) => return Ok(SessionEnd::Reconfigured),
                Some(Control::PairStart { reply }) => {
                    if session_gate_tripped(&t.db, cfg) {
                        let _ = reply.send(Err("纪元切换进行中,暂不能发起配对".into()));
                        return Ok(SessionEnd::Reconfigured);
                    }
                    ctx.on_pair_start(&mut ws, reply).await?;
                    Woke::Handled
                }
            },
            frame = ws.next() => {
                let frame = frame
                    .ok_or_else(|| "连接断开".to_string())?
                    .map_err(|e| format!("连接错误:{e}"))?;
                last_rx = Instant::now();
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                match frame {
                    WsMsg::Binary(b) => {
                        let msg = sync_proto::decode::<ServerMsg>(&b)
                            .map_err(|_| "服务器帧无法解码(两端版本不一致?)".to_string())?;
                        ctx.handle_server(&mut ws, msg).await?;
                        if ctx.space_blocked {
                            // 空间不足:立即收场断连(源端下一块吃 Nack 即止流),
                            // 外层按 SpaceBlocked 固定长等待,不走 1s 退避。
                            let _ = ws.close(None).await;
                            return Ok(SessionEnd::SpaceBlocked);
                        }
                        if let Some(e) = ctx.reopen_required.take() {
                            // 引导已提交但连接须重开(§3.2):断连收场,run 整体
                            // 退出——**绝不进重连循环**,也绝不在原连接 relay_session_up。
                            let _ = ws.close(None).await;
                            return Ok(SessionEnd::ReopenRequired(e));
                        }
                    }
                    WsMsg::Close(_) => return Err("服务器关闭了连接".into()),
                    _ => {}
                }
                Woke::Handled
            },
            _ = wrote.notified() => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                let mut outs = vec![];
                let done = {
                    let conn = ctx.db.lock().expect("db mutex poisoned");
                    match ctx.engine.get() {
                        // 本地写落地:先结算(删图/删条目让缺字节清单少一项,L-c2a),
                        // 再推新 op。
                        Some(e) => e
                            .on_local_ops_settled(&conn)
                            .and_then(|()| e.outbound(&conn, &mut outs)),
                        None => Ok(()),
                    }
                };
                // 输出不蒸发(§6.2 ③″ 第 4 条):先投已累计的,再让错误收场。
                ctx.dispatch(&mut ws, outs).await?;
                done?;
                Woke::Handled
            },
            // **有腿交回了在飞位**(§6.2 ④′)。铃是边沿合并器、带一枚存量,故「摇的时候
            // 协调者正忙」不会丢。臂里只做「扫名单 + 摇铃」,一枚数据帧的准备仍在泵里。
            _ = ops_changed.notified() => Woke::OpsChanged,
            _ = tick.tick() => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                if last_rx.elapsed() >= Duration::from_secs(SILENCE_TIMEOUT_SECS) {
                    return Err("服务器长时间无响应,重连".into());
                }
                send_client(&mut ws, &ClientMsg::Ping).await?;
                // 图拉流「无进展」超时(M1):应了 BlobHave 却沉默的来源被作废、换来源。
                if let Some(e) = ctx.engine.get() {
                    let outs = e.on_tick();
                    if !outs.is_empty() {
                        ctx.dispatch(&mut ws, outs).await?;
                    }
                }
                // 同一刻的链路面(§3):Ping 与 90s 静默判死跟着这根心跳走。
                ctx.deck(&mut ws).lan_beat().await?;
                // ops 追赶那一拍(§6.2 ⑥;L-d″ 第⑤笔):本机 origin 重新派生 + 冷却到点
                // 放行 + 收回上一拍给直连的让位,随后那一趟 sweep 摇直连的铃并跑**一次**
                // 全局数据泵。
                //
                // **中转数据窗口的恒在续做轴就在这一句里**(L-d″ 第④笔;二轮 M 合并):
                // `busy` 那一格释放窗口后保留 work、刻意不当场重发,靠这一拍重泵 —— 不然
                // 那笔供流只能干等下一次偶然的新 pull(「靠一个信号触发,而信号可能不来」
                // 的同族)。原先这里另有一句独立的 `relay_data_pump()`,那等于给同一拍**再**
                // 发一整个 K 的额度;合并之后一拍恰好一次,K 那条公平上界才真成立。
                ctx.deck(&mut ws).ops_tick().await?;
                // 对账控制帧的重发债(§6.1 九轮 H1;L-d″ 第④笔下半):`busy` 掉的那枚
                // Hello / ops Want 没有别的重发轴,同样挂这根恒在心跳。**排在数据泵之后**
                // ——一枚 mail 控制帧不该跟数据窗口抢这一拍的先手,而它自己不占窗口。
                let ctl = ctx.deck(&mut ws).reconcile_tick()?;
                if !ctl.is_empty() {
                    ctx.dispatch(&mut ws, ctl).await?;
                }
                // 隔离重验的续做(L-d‴):跟着这根恒在心跳走,每拍至多一批。**必须排在
                // `lan_beat` 之后**,与离线泵那条同序(实现审三轮 M1:一度写反了——
                // 注释说在后、代码在前;重验输出的 dispatch 一失败,这一拍的 `lan_beat`
                // 就被 `?` 跳过了)。重验自身的错误只进 advisory 槽,不掐心跳。
                let rev = ctx.deck(&mut ws).reverify_tick();
                if !rev.is_empty() {
                    ctx.dispatch(&mut ws, rev).await?;
                }
                Woke::Handled
            },
            _ = until(ctx.pair.as_ref().map(|p| p.deadline)) => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                // 两段 deadline 两句话:槽还没到 = 开槽超时(15s);到了 = 码过期(§1.3)。
                let why = if ctx.pair.as_ref().is_some_and(|p| p.slot.is_none()) {
                    "等服务器分配配对槽超时".to_string()
                } else {
                    "配对超时(配对码 10 分钟内有效)".to_string()
                };
                ctx.fail_pair(&mut ws, why, true).await;
                Woke::Handled
            },
            _ = until(ctx.boot_deadline) => {
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                // 等 Offer/块超时:换下一台在线设备重试(对方可能也在引导,§6.2)。
                ctx.boot_rotate();
                ctx.try_boot_request(&mut ws).await?;
                Woke::Handled
            },
            _ = std::future::ready(()), if ctx.boot_out.is_some() => {
                // boot_out 恒就绪,两次 tick 间可推完整快照——供流也必须先过闸
                // (旧纪元库在切换中当引导源,正是隔离不变量要断的路)。
                if session_gate_tripped(&t.db, cfg) {
                    return Ok(SessionEnd::Reconfigured);
                }
                ctx.pump_boot_out(&mut ws).await?;
                Woke::Handled
            },
            ev = lan_inbound.recv() => {
                Woke::Lan(ev.expect("链路集自持一枚 sender,通道不会关"))
            },
            f = lan_faults.recv() => {
                Woke::LanDown(f.expect("链路集自持一枚 sender,通道不会关"))
            },
            Some(adopted) = handoff.recv() => Woke::Adopt(adopted),
            // 拨号巡查(§7):中转在线时照拨——直连是加速层,与中转在不在无关。
            _ = until(ctx.engine.dial_due()) => Woke::Dial,
        };
        // lan 那两件在 select 之外处理:臂里直接 `ctx.…()` 会与臂上的借用打架。**这也正是
        // 「run-to-completion」的形**(§6 代次契约之一)——一枚事件与它产出的全部输出在
        // 这里一路跑完,期间不会回到 select 去处理别的链路事件。
        match woke {
            Woke::Handled => {}
            // **lan 那三件也得过闸**(实现审三轮 H1):它们与 frame/wrote/tick 一样会拿当前
            // 身份封解帧、落库、接纳新链——漏掉就正是拍板禁止的「单帧跨闸窗」:身份换代后,
            // 只要一枚 lan 帧或一次链路移交先于中转帧被选中,就会用旧 K_acc 解封应用、或以
            // 旧身份认下一条新链。
            Woke::Lan(_) | Woke::LanDown(_) | Woke::Adopt(_) | Woke::Dial | Woke::OpsChanged
                if session_gate_tripped(&t.db, cfg) =>
            {
                return Ok(SessionEnd::Reconfigured);
            }
            Woke::OpsChanged => ctx.deck(&mut ws).ops_changed_tick().await?,
            Woke::Lan(ev) => ctx.deck(&mut ws).lan_event(ev).await?,
            Woke::LanDown(f) => ctx.deck(&mut ws).lan_fault(f).await?,
            Woke::Adopt(adopted) => ctx.deck(&mut ws).lan_adopt(adopted).await?,
            // 拨号巡查 + 本机通告地址对齐(§7;见 [`lan_dial_tick`])。失败只进 advisory
            // 面,绝不拖累中转会话;地址真变了那枚广播 Hello 走中转发出去。
            Woke::Dial => {
                let outs = lan_dial_tick(
                    &ctx.db,
                    &ctx.status,
                    &ctx.events,
                    cfg,
                    ctx.seat.clone().as_ref(),
                    ctx.engine,
                    Some(&ctx.sess.ad),
                );
                ctx.dispatch(&mut ws, outs).await?;
            }
            // 会话在的时候这三件归上面那些臂 / 归离线泵。
            Woke::Tick | Woke::Wrote | Woke::LanHello => {}
        }
    }
}
