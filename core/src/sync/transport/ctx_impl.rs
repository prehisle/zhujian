use super::*;

impl Ctx<'_> {
    /// 借出投递面(会话内恒是 `Up` 形:socket 与信封序号都在手)。
    pub(super) fn deck<'a>(&'a mut self, ws: &'a mut Ws) -> Deck<'a> {
        Deck {
            db: &self.db,
            clock: &self.clock,
            status: &self.status,
            events: &self.events,
            cfg: self.cfg,
            slot: &mut *self.engine,
            relay: RelayLeg::Up { ws, sess: &mut self.sess },
        }
    }

    pub(super) async fn dispatch(&mut self, ws: &mut Ws, outs: Vec<Output>) -> Result<(), String> {
        self.deck(ws).dispatch(outs).await
    }

    pub(super) fn set_status(&self, f: impl FnOnce(&mut SyncStatus)) {
        set_status(&self.status, &self.events, f);
    }

    fn toast(&self, msg: String) {
        let _ = self.events.send(SyncEvent::Toast(msg));
    }

    /// 引导中吗(引擎槽空 = 还没拿到首份快照)。
    fn booting(&self) -> bool {
        self.engine.booting()
    }

    /// **中转会话仪式**并宣告在线(§6):装配引擎(引导刚完成的路;正常路早在
    /// `run` 里装配好了)→ 结算本地 op → 游标复位到已 ack 位 + 只重置 relay 维度 +
    /// 广播 hello 与缺图 want(一次原子仪式,实现审 H1)→ 补喂引导期攒的在线快照 →
    /// 推送离线期间攒下的本地 op → 隔离行升级重验。引导完成后**必须**经此(boot.rs
    /// 接线契约)。
    pub(super) async fn relay_session_up(&mut self, ws: &mut Ws) -> Result<(), String> {
        let known_peers: Vec<String> = self.peers.iter().cloned().collect();
        let (hello_outs, push_outs, pushed, reverify_outs, reverified, poison) = {
            let mut conn = self.db.lock().expect("db mutex poisoned");
            let mut clk = self.clock.lock().expect("clock mutex poisoned");
            self.engine.reconcile(&conn, self.cfg)?;
            // 「每会话弹一次」的提示位随会话复位(L-c2a 那条线;位子住在槽里是因为断网期
            // 也要有个地方记,见 [`EngineSlot::notices`])。
            self.engine.notices = Notices::default();
            let engine = self.engine.get().ok_or("引导已提交但引擎未装配(bootstrapped_at 缺席?)")?;
            // 出站游标复位与本地删除结算都收在这一个会话仪式入口里(§6 / 实现审 H1):
            // acked = sync_meta 里服务器已确认过的位置,「已发未 ack」的 op 由此在重连
            // 后重推。
            let mut hello = engine.on_relay_session_up(&conn, read_last_pushed(&conn)?)?;
            // 引导期间收到过的在线快照/上线事件补进路由表(§5.1:(X,Relay)=Up 须
            // 「会话在 ∧ X 在线」两层成立,故**必在 session_up 之后**)——漏了它,引导
            // 完成后这些对端的 blob 选路会以为无路可走,图字节要等下一次 Peer 事件才拉。
            for peer in &known_peers {
                hello.extend(engine.on_relay_peer_up(peer));
            }
            let mut push = vec![];
            let pushed = engine.outbound(&conn, &mut push);
            // 升级重验状态机(§4):校验器升过版就对隔离行重跑——修好的误判自助
            // 恢复(op 归池 + want 追帧),仍非法的抬版本保留。
            // 输出交由调用方持有(同轮 H1):Err 也不丢已提交的义务——这里的 `?` 会把
            // 整个会话仪式收场,而 `reverify` 里已累计的那些 want 就是靠它带出去的。
            let mut reverify = vec![];
            let reverified = engine.reverify_quarantined(&mut conn, &mut clk, &mut reverify);
            let poison = engine.poison_status();
            (hello, push, pushed, reverify, reverified, poison)
        };
        // **引导刚完成那一跳的 LanReady 置位**(§6):引擎是上面这一行才装配起来的,而
        // `run` 顶的准入表对齐早在引导之前跑过、当时槽还空着。漏了这一次,刚入伙的设备
        // 要等到下一次中转重连才收得下直连——那个窗口可以是几小时。已注册的空间在这里
        // 是幂等续注册(同注册者同指纹不换代),故正常路每会话跑一次也不扰动在飞握手。
        lan_sync_admission(
            self.seat.clone().as_ref(),
            self.engine,
            &self.db,
            &self.status,
            &self.events,
            self.cfg,
        );
        // 中转重连 = 拨号退避**全部复位**(§7)。中转回来了通常意味着网络刚变过(换了
        // wifi / 路由器重启),攒到 300s 的退避此刻已无意义;新落点随之而来的通告也会
        // 各自 kick 一次,两条触发不互斥。
        self.engine.dial.kick_all();
        self.set_status(|s| {
            s.state = "online".into();
            s.error = None;
            s.quarantined = poison.0;
            s.poison_breaker = poison.1;
        });
        self.dispatch(ws, hello_outs).await?;
        self.dispatch(ws, push_outs).await?;
        // 同重验那条(H1):**先投再判** —— `outbound` 已经登记进计划表的义务,不许被它
        // 自己那半的错误连带吞掉。
        pushed?;
        // 先把已累计的义务投出去,再看重验本身成没成(同轮 H1):顺序反了的话,
        // 一次本地故障会连带丢掉这一批里已经放行那几行的追帧 want。
        self.dispatch(ws, reverify_outs).await?;
        reverified?;
        // **新会话建立后唤醒跨会话保留的活**(§6.2 ⑨-8 第三条;L-d″ 第④笔下半):窗口与
        // 待办都住在槽里、跨会话存活,而上一条会话收场时窗口是被**清空**的 —— 没有这一下,
        // 那些 work 只能等下一拍心跳(≤30s)或下一枚偶然的新 pull。ops 那半同理:计划表
        // 在槽里原样留着,新会话一起来就该接着供。
        let resume = self.deck(ws).relay_data_pump().await?;
        self.dispatch(ws, resume).await?;
        // ops 那半走同一条唤醒线(§6.2 ④′「消费者重新出现时也要唤醒」):**不只 BROADCAST**
        // ——断 WAN 期间攒下的定向 work 也在表里躺着,而中转刚回来正是它们最该被服务的时候。
        // `relay_data_pump` 只顾得上一枚窗口,这一声才把「还有谁能被叫醒」问全。
        self.engine.ops_changed.notify_one();
        Ok(())
    }

    /// 窗口里那一枚块被服务器接手:该笔供流推进一块、回待办**队尾**,随即泵下一枚
    /// (L-d″ 第④笔)。
    async fn relay_blob_acked(
        &mut self,
        ws: &mut Ws,
        ticket: RelayDataTicket,
    ) -> Result<(), String> {
        // 凭据对不上 / 窗口是空的 = 接线漂移,响亮(见 [`RelayData::take_inflight`])。
        let mut job = self.engine.relay_data.take_blob(ticket)?;
        let last = job.serve.is_last(job.next_idx);
        job.next_idx += 1;
        if !last {
            self.engine.relay_data.requeue(job);
        }
        let outs = self.deck(ws).relay_data_pump().await?;
        self.dispatch(ws, outs).await
    }

    /// 窗口里那一枚 ops 帧被服务器接手(L-d″ 第④笔下半)。
    ///
    /// **顺序是本函数的全部内容**(§6.1「`ServeOps` 承载本机 origin 时的顺序」+ §6.2 ⑨-1):
    /// ①取回窗口 → ②**先把 `last_pushed` 落库** → ③成功之后**才**提交 work 游标 →
    /// ④再泵下一枚。(unknown 清标已经在 [`Ctx::on_ack`] 那一处对**所有**带 target 的回执
    /// 统一做掉了,codex 实现审一轮 M1;这里不再各做一份。)
    ///
    /// 反过来排(先提交游标后落库)就会出现「游标说发过了、库说没接手」:下次会话仪式
    /// 从持久 `last_pushed` 重载,那段 op 再没有人发。而落库失败时凭据还在 `job` 手上,
    /// 随着这一路 `Err` 返回被 `Drop` **交回 rollback**——游标一步没动,会话收场重发。
    async fn relay_ops_acked(
        &mut self,
        ws: &mut Ws,
        ticket: RelayDataTicket,
        own_max_seq: Option<i64>,
    ) -> Result<(), String> {
        p305!("ACK relay ops own_max_seq={own_max_seq:?} -> bump+commit");
        let job = self.engine.relay_data.take_ops(ticket)?;
        if let Some(max_seq) = own_max_seq {
            let conn = self.db.lock().expect("db mutex poisoned");
            bump_last_pushed(&conn, max_seq)?;
        }
        job.ticket.commit()?;
        let outs = self.deck(ws).relay_data_pump().await?;
        self.dispatch(ws, outs).await
    }

    /// `unknown_device` 的**跨代探针**(§6.1 八轮 H1 + 九轮 M1;只对定向 `ServeOps`)。
    ///
    /// 三步:①首次只记下当时的中转 generation,**工作照留**——发送者被旧连接顶替那一档
    /// 里,重连后第二次发送即 Ack,一点工作都不该丢;②同一代的尾帧不算第二击;③**更晚
    /// 一代仍 unknown** = 那台真的不在 registry 了,取消该 target 的 relay work 并**响亮
    /// 报一次**(丢同步工作不许静默)。少了第三步,「结束会话 → 跨会话 work 续做 → 又
    /// unknown」就是永久重连循环。
    ///
    /// 会话不在(引擎没装配 / 刚断)时不探:那时既没有 generation 可记,也没有「下一代
    /// 重试一次」的语义;标记留着不动,下一个真会话里再判。
    fn probe_unknown_target(&mut self, target: &str) {
        let Some(generation) = self.engine.peek().and_then(Engine::relay_session_generation) else {
            return;
        };
        let verdict = lock_ops(&self.engine.ops).note_unknown(target, generation);
        if verdict == ops_serve::UnknownVerdict::Cancelled {
            self.set_status(|s| {
                s.lan_warning = Some(format!(
                    "换了一条会话仍不认识 {target}:已取消它的 op 追赶供流"
                ))
            });
        }
    }

    /// Nack 的处置:**先按 `code` 分发,再按 `Sent` 细分**(§6.1 八轮 M1)。
    ///
    /// 原来的形是反的 —— 顶层 match 的是 `Sent`,`code` 全程只有一处 `let _ = code;`。
    /// 于是**任何** Nack 落在 `Sent::Direct` 上都被读成「该对端此刻不在线」,连 `busy`
    /// 也会错误打掉一条对端的中转路由。第④笔建统一的数据窗口时必须一并改:留着旧解释,
    /// 同一个 code 就会在相邻两个分支里拥有相反语义。
    ///
    /// **`unknown_device` 恒 session-fatal**(§6.1 八轮定形):服务端拿同一个 code 表达
    /// 三件事,其中两件(`from` 不在 registry / 本连接已不是该设备的当前在线连接)是
    /// **发送者自己**的问题,而线上那个 code 一个字节都不带来源。fail-closed = 释放窗口、
    /// 游标不提交、响亮收场。
    ///
    /// **`ServeOps` 与 `ReconcileCtl` 两行在第④笔下半接齐**,第⑤笔起两条都在生产路径上
    /// 跑:前者由 `on_hello` / `on_want` / `outbound` 登记的义务喂出来,后者是 Hello 与
    /// ops Want 本身。
    async fn on_nack(&mut self, ws: &mut Ws, sent: Option<Sent>, code: &str) -> Result<(), String> {
        // ① 「每条 Send 必有恰一枚回执」是 `tracked` 自排水的全部依据,破了就别猜。
        //    **排在最前**(codex 实现审 8):原先它排在 `unknown_device` 之后,于是一枚
        //    「n 不在册」会被先诊断成身份失权 —— 收场动作虽同,报出来的原因是错的。
        let Some(sent) = sent else {
            return Err(format!("内部错:收到 n 不在册的 Nack({code})"));
        };
        // ② 窗口先释放,且在任何别的 `?` 之前:一枚送不出去的收口帧不该把窗口永久留在
        //    「在飞」(§6.1 六轮 H2 的同一条)。`busy` 保留 work 等心跳重试,其余作废本笔。
        //    **凭据对不上 / 窗口本来就空 = 响亮**,与 Ack 那一路对称(codex 实现审 L1:
        //    原先这里 `inflight` 为空时静默成功,等于无声丢掉一笔 work)。
        match &sent {
            Sent::ServeBlob { ticket, .. } => {
                let job = self.engine.relay_data.take_blob(*ticket)?;
                if code == err_code::BUSY {
                    self.engine.relay_data.requeue(job);
                }
            }
            Sent::ServeOps { ticket, target, .. } => {
                // 取回即**回滚**:Nack 一律不推进游标,那份 work 原样留在计划表里 ——
                // 「busy 保留 work」因此是结构事实,不需要像 blob 那样再 requeue 一次
                // (blob 的续做态在描述符里,ops 的在游标里)。
                //
                // **静默交回**(不摇 `ops_changed`):裸 `Drop` 会摇铃,而铃响 = 协调者当场
                // 扫一遍 idle-runnable 再泵 —— 这一枚刚被 Nack 的 work 立刻又合格,于是
                // 「发→Nack→发」就是热循环,正撞第④笔钉死的那条(§6.1 `ServeOps` 行:
                // busy **释放窗口 / 不推进游标 / 保留 work / 不许当场重发**)。
                //
                // ⚠ 与 §6.2 ④′「每一次 occupied→free 都 notify」有出入,是**刻意的收窄**:
                // 那条的目的是「别让 `Occupied` 变成永久停摆」,而这条路的续做所有者写得死
                // ——心跳那一拍的 `relay_data_pump`(与 blob 腿 busy 后的做法逐字相同),
                // 停摆有界。反过来照摇的话换来的是无界重发,两害相权。
                //
                // **对所有 code 都静默**,不只 `busy`:`not_online`(对端此刻不在线)与
                // `unknown_device`(收场重连)当场重发同样只会再撞一次同样的 Nack。
                self.engine.relay_data.take_ops(*ticket)?.ticket.rollback_quiet()?;
                // **本拍让位给直连,并当场摇它的铃**(codex 实现审二轮 H)。
                //
                // 光「不摇 `ops_changed`」不够:下一次唤醒(心跳 sweep / 别处摇的铃)里
                // `relay_data_pump` 是**同步**跑在摇 LAN 铃之前的,当场就把这枚在飞位重新
                // 占回去了 —— `notify_one` 不产生调度检查点(第②笔那条「自己摇铃不算让出」
                // 的老坑,**第三次**)。于是「中转会话稳定在、数据面持续 busy、直连稳定
                // 可用」时,LAN 确定性地永远只拿得到 `Occupied`。
                //
                // 两件缺一不可:`yield_relay` 把它从**中转腿的**候选枚举里摘一拍(结构上
                // 让位,不指望赢竞速),`wake_ops` 把这一拍的机会真交到直连腿手上(不然要
                // 白等到下一拍心跳)。让位由下一拍 `Deck::ops_tick` 的第一句收回,故没有直连腿时退化成
                // 原来的「保留 work,等心跳 relay 重试」,一拍不多。
                //
                // **BROADCAST 不让位**(§6.2 ①):本机 origin 只许权威完成腿消费。
                if target != BROADCAST {
                    lock_ops(&self.engine.ops).yield_relay(target);
                    self.engine.lan.wake_ops(target);
                }
            }
            _ => {}
        }
        // 同 target 的阳性证据清 unknown 怀疑(§6.1 九轮 M1 ②)**不在这里**:它与 Ack
        // 那条路合并到了 [`Ctx::handle_server`] 的一处(codex 实现审二轮 M1),判据取
        // `Tracked::target` 而不是「这枚 `Sent` 变体碰巧带没带 to」。
        // ③ unknown_device 对**所有** `Sent` 变体一律结束会话(含引导两格)。
        if code == err_code::UNKNOWN_DEVICE {
            // 跨会话存活的**定向** `ServeOps` 另配一枚有限探针(§6.1 八轮 H1):不然
            // 「结束会话 → work 跨会话续做 → 又 unknown」就是永久重连循环。BROADCAST 与
            // 本机 outbound **不探**——它们没有「目标被移除」这种解释,未 Ack 段照留。
            if let Sent::ServeOps { target, .. } = &sent {
                if target != BROADCAST {
                    self.probe_unknown_target(target);
                }
            }
            self.engine.relay_data.clear();
            return Err(format!("服务器回 {code}:本连接的设备身份此刻不被承认,收场重连"));
        }
        match sent {
            // ④ not_online 是**唯一**允许标 peer down 的 code(§6.1 八轮 M1)。
            Sent::BootReq if code == err_code::NOT_ONLINE => {
                // 请求对象不在线(刚掉线的竞态):换一台。
                self.boot_rotate();
                self.try_boot_request(ws).await?;
            }
            Sent::BootOut if code == err_code::NOT_ONLINE => {
                // 接收方掉线:作废供流,删临时快照(drop 先落 File 句柄再删)。
                if let Some(bo) = self.boot_out.take() {
                    discard_boot_out(bo);
                }
            }
            Sent::Direct { to } | Sent::ServeBlob { to, .. } if code == err_code::NOT_ONLINE => {
                // 服务器投不到 = 该对端此刻不在线:只是它的**中转腿**不可达(§6 对端级),
                // lan 腿与惩罚都不该被连带;作废的在飞拉流由入口自带的 want 另寻来源。
                // 该对端**待办里那一笔**(若有)不在这里清:它下次被泵到时会再撞一枚
                // `not_online` 而各自作废,故队列自排水、不需要第二处清理。**代价写准**
                // (codex 二轮 L1):不止「一枚帧」——还可能要等下一拍心跳才重泵,且满额
                // 期间会有短暂的 deny→rewant churn。有界,且不会再让旧整图续跑,故接受;
                // `Peer{online:false}` 的主动清理留到下一笔连同 ops 那条腿一起决定。
                let outs =
                    self.engine.get().map(|e| e.on_relay_peer_down(&to)).unwrap_or_default();
                self.dispatch(ws, outs).await?;
            }
            // ④ ReconcileCtl 撞 busy:**只置一枚位**(§6.1 九轮 H1)。不保存整帧、不保存
            //    水位图 —— 重发的内容由下一拍心跳([`Deck::reconcile_tick`])重新构造,
            //    故不会把一枚过期的水位图重放上线;再次 busy 仍保留该位,**Ack 后才清**。
            //    **刻意不在这里立即重发**:那就是热循环(与 `ServeBlob` 同一条纪律)。
            Sent::ReconcileCtl { .. } if code == err_code::BUSY => {
                // **换新号**(codex 实现审一轮 H1):此刻已在飞的那些广播 Hello 都是这笔债
                // 挂上**之前**构造的,它们的 Ack 一律不算还这一笔。代价至多是下一拍再发
                // 一枚,而反过来(复用旧号)就是把「服务器没接手」这件事静默销账。
                self.engine.set_reconcile_debt()?;
            }
            // ④′ **本机 origin(BROADCAST)那枚 ops 撞 busy:同样置一笔债**
            //    (lan-direct-plan §12.1,295 真机量出的活性缺口)。
            //
            //    缺口三条叠加:①本机 op 挂 BROADCAST,而它那条补投面([`Deck::fan_out_broadcast`])
            //    的名单出口 [`Engine::lan_backfill_peers`] 只收「lan 腿 Up **∧ relay 腿不 Up**」
            //    的对端 —— 中转在线的对端由信箱负责,不平行投第二份;295 那一幕恰是**两端
            //    都在中转上在线、只有数据面 busy**,故补投集恒空(§12.1 原文把这条写成
            //    「`relay_up()` 时不 fan-out」,那是按本机会话说的,判据其实在**对端**那一维);
            //    ②**BROADCAST 恒不让位**(§6.2 ①——让给 LAN 就是「谁抢到谁提交」,别的对端
            //    那一帧永远补不上,这条不改);③唯一能把它变成「会让位的定向 work」的对端 Hello **不
            //    周期发送**,而债此前只有**自己的 Hello 被 Nack** 才置。于是数据面 busy 而
            //    控制面通时,债当场被 Ack 清掉,**再没有任何一根轴会重新问一次** —— 本机
            //    新写的内容无限期停摆(实测 193s 零到达),而直连就在旁边闲着。
            //
            //    修法刻意**不新造状态**:置一下这枚已经存在的位,后面全走既有路径 ——
            //    心跳经 `make_hello` 重建一枚广播 Hello(小帧在数据面 busy 期照样通,295
            //    正是靠「债当场被 Ack」证明的)→ 对端发现自己落后 → 回 Want → 本机登记
            //    **定向** work → 撞 busy → **让位** → 直连接走。
            //
            //    **为什么不给 BROADCAST 也开直连口子**:那个入口才真要新状态(得有一根
            //    「中转数据面持续拒了我 N 拍」的判据),而 §6.2 ① 否掉 per-leg frontier 正
            //    是因为那要新状态。
            //
            //    **只收窄到 BROADCAST**:定向 work 撞 busy 已经有让位这条既有出路(上面那
            //    句 `yield_relay` + `wake_ops`),再记一笔债就是白多发水位图。
            //
            //    代价自限:持续 busy 期**每拍至多多一枚广播 Hello**。它有多大要按闸说,不能
            //    凭印象 —— 水位图上界是 [`ops_serve::OPS_WATERMARK_BYTES_PER_TARGET`] = **64 KiB**
            //    (加 CBOR/AEAD/信封的固定开销),远在单帧 1 MiB 闸之下;走 `Require(Relay)`
            //    故不碰 LAN 每链 8 MiB 那道队列闸。(一轮我在这里写「几百字节」,是低估:
            //    codex 实现审 L1。)
            //
            //    ⚠ **适用边界:这条修法要「控制面通得过」**(codex 实现审同轮点名)。服务端
            //    **没有独立的控制面预算** —— `admit` 在分 lane 之前就能回 BUSY,故 Hello 与
            //    数据帧吃同一份额度。真把额度压到连 64 KiB 的 Hello 都过不去时(台架
            //    `busy-syncd --budget-global-bytes 1`),会话靠 Ping/Pong 活着、债每拍重试,
            //    但对端**永远看不到我的水位**,§12.1 那四条件的宽泛表述照样能长期停摆。
            //    这不否定本修法:295 实测的正是「数据面 busy 而控制面通」(债当场被 Ack 清掉),
            //    而那一档现在有出路了。剩下的那一档要治得给控制面单开预算 = 服务端的事,
            //    已记进 §12.1。
            Sent::ServeOps { target, .. } if code == err_code::BUSY && target == BROADCAST => {
                self.engine.set_reconcile_debt()?;
            }
            // ④ busy:**一格都不标 peer down**。引导两格由既有的 30s 步超时 + 换源兜住;
            //    `Direct`(BlobPull/BlobDeny)与 `Other`(BlobWant/BlobHave)由既有的
            //    stale / 重问轴自愈;`ServeBlob`/`ServeOps` 的 work 上面已保留,续做挂心跳
            //    —— **刻意不在同一个 Nack 事件里立即重泵**,那就是热循环。
            //    (`ServeOps` 里 BROADCAST 那一格已被 ④′ 接走:work 照样保留,只是**另外**
            //    还欠一笔债 —— 它是那一格唯一能变成「会让位的定向 work」的轴。)
            //    **busy 的那一类不阻塞另一类**:窗口已在 ② 里释放,下一拍心跳的泵按 1:1
            //    先问另一类,故一条 ops 的 busy 不会挡住图字节,反之亦然。
            _ if code == err_code::BUSY => {}
            // ⑤ mail lane 收到 not_online = 协议漂移(服务端只对 direct 指名帧回它),
            //    未知 code = 将来的服务器漂移。两者都响亮收场,不静默。
            _ => return Err(format!("服务器回了处置不了的 Nack code:{code}")),
        }
        Ok(())
    }

    /// 这一枚回执的收件人还在册的**阳性证据**:清掉它的 `unknown_device` 怀疑标。
    /// 广播帧([`Tracked::target`] 为 `None`)与不在册的回执一律不清。
    fn clear_unknown_for(&mut self, tracked: &Option<Tracked>) {
        if let Some(t) = tracked.as_ref().and_then(|t| t.target.as_deref()) {
            lock_ops(&self.engine.ops).clear_unknown(t);
        }
    }

    /// 回执的处置(`unknown` 清标已由调用方一处做完,见 [`Ctx::clear_unknown_for`])。
    async fn on_ack(&mut self, ws: &mut Ws, sent: Option<Sent>) -> Result<(), String> {
        match sent {
            Some(Sent::ServeBlob { ticket, .. }) => self.relay_blob_acked(ws, ticket).await,
            Some(Sent::ServeOps { ticket, own_max_seq, .. }) => {
                self.relay_ops_acked(ws, ticket, own_max_seq).await
            }
            // 对账控制帧被服务器接手 = 那笔债还清了(§6.1 九轮 H1:**只有它的 Ack 才清**,
            // 构造成功 / 入队成功 / `send_client` 返回成功都不算;而「它」到底是哪一枚,
            // 由 `discharges` 带的债号说了算,见 [`Sent::ReconcileCtl`])。
            Some(Sent::ReconcileCtl { discharges }) => {
                // 号对上才清:`None`(普通 Want / 定向 Hello)与旧号(债挂上之前构造的
                // 那枚)都不算还债。**不响亮**——这不是接线漂移,是本来就允许的交错(与
                // 数据窗口那两只 `take_*` 的响亮不同:那边同刻至多一枚,对不上就只可能是
                // 接错线)。
                if discharges.is_some() && discharges == self.engine.reconcile_debt {
                    self.engine.reconcile_debt = None;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    // ---- 服务器消息分发 ----

    pub(super) async fn handle_server(&mut self, ws: &mut Ws, msg: ServerMsg) -> Result<(), String> {
        match msg {
            ServerMsg::Deliver { from, to, blob } => self.on_deliver(ws, &from, &to, &blob).await,
            // **同 target 的阳性证据两条路一处清**(codex 实现审一、二轮 M1)。Ack 恒是
            // 阳性:服务端验过那台的 registry 并接手了这一枚。`busy`/`not_online` 同理
            // ——服务端也是验过之后才回得出它们;`unknown_device` 当然不在其列,它正是
            // 那条负面证据。判据取 [`Tracked::target`],与这一枚是什么 `Sent` 无关。
            ServerMsg::Ack { n } => {
                let t = self.sess.tracked.remove(&n);
                self.clear_unknown_for(&t);
                self.on_ack(ws, t.map(|t| t.sent)).await
            }
            ServerMsg::Nack { n, code } => {
                let t = self.sess.tracked.remove(&n);
                if code == err_code::BUSY || code == err_code::NOT_ONLINE {
                    self.clear_unknown_for(&t);
                }
                self.on_nack(ws, t.map(|t| t.sent), &code).await
            }
            ServerMsg::Peer { device, online } => {
                if online {
                    // 对端级 relay 连接态的**唯一**置位路径(§6 三轮 M1):不许拿
                    // 「收到过它的帧」当在线证据——mail 可能来自信箱,发送者早已离线。
                    let outs =
                        self.engine.get().map(|e| e.on_relay_peer_up(&device)).unwrap_or_default();
                    self.dispatch(ws, outs).await?;
                    // §6.2 ⑦ 的第四件:给它的追赶计划发一枚一次性加速券。**只发券、不摇铃**
                    // ——券不改变可跑性,效果兑现在下一枚 Hello 或下一拍心跳上。形态不合
                    // (`ServerMsg::Peer.device` 在线协议里仍是裸 `String`)= 服务端协议漂移,
                    // 响亮结束当前 session。
                    let mut ops = vec![];
                    let admitted = match self.engine.get() {
                        None => Ok(()),
                        Some(e) => e.on_peer_online_ops(&device, &mut ops),
                    };
                    self.dispatch(ws, ops).await?;
                    admitted?;
                    // §2 收敛触发②:它在线而本机缺它的验证钥 → 定向回一帧本机通告。
                    let outs = self
                        .deck(ws)
                        .ad()
                        .map(|mut face| face.lan_hello_if_key_missing(&device))
                        .unwrap_or_default();
                    self.dispatch(ws, outs).await?;
                    // §7 拨号时机之三:服务器说它上线了 = 它刚起来的强信号,该复位它那份
                    // 退避当场再拨一次(它上一轮可能正好在重启,把本机的退避拖到了 300s)。
                    self.engine.dial.kick_peer(&device);
                    if !self.peers.contains(&device) {
                        self.peers.push_back(device);
                    }
                } else {
                    self.peers.retain(|d| d != &device);
                    let outs =
                        self.engine.get().map(|e| e.on_relay_peer_down(&device)).unwrap_or_default();
                    self.dispatch(ws, outs).await?;
                    // §5/二轮 M5:对端的中转腿刚没了,而 lan 腿可能正通着——当场沿 lan
                    // 定向问一枚 Hello 互换水位,不等对端事件的新鲜度(它已经不新鲜了)。
                    if self.engine.peek().is_some() && self.engine.lan.count() > 0 {
                        let outs = {
                            let conn = self.db.lock().expect("db mutex poisoned");
                            let engine = self.engine.peek().expect("上一行已查");
                            match engine.lan_backfill(&device) {
                                true => engine.make_hello(&conn, &device, Route::Lan)?,
                                false => vec![],
                            }
                        };
                        self.dispatch(ws, outs).await?;
                    }
                    if self.boot_peer.as_deref() == Some(&device) {
                        self.boot_rotate();
                    }
                }
                let n = self.peers.len();
                self.set_status(|s| s.peers_online = n);
                if self.booting() {
                    self.try_boot_request(ws).await?;
                }
                Ok(())
            }
            ServerMsg::PairSlot { slot } => {
                let Some(p) = self.pair.as_mut() else { return Ok(()) };
                if p.slot.is_some() {
                    return Ok(());
                }
                p.slot = Some(slot);
                let grant = AccountGrant {
                    account_id: self.cfg.account_id.clone(),
                    k_acc: self.cfg.k_acc.to_vec(),
                    server_url: self.cfg.server_url.clone(),
                };
                p.opener = Some(pair::Opener::new(slot, &p.secret, grant));
                let code = pair::pair_code(slot, &p.secret);
                // 槽已到:整段配对改按码的真实 TTL 计时(开槽阶段短 deadline 作废)。
                p.deadline = Instant::now() + Duration::from_secs(PAIR_TIMEOUT_SECS);
                let delivered = p.reply.take().map(|r| r.send(Ok(code)).is_ok()).unwrap_or(false);
                if !delivered {
                    // 壳层已放弃等待(receiver drop):没人会展示这个码,留着只会让
                    // 之后每次 PairStart 都撞「已有配对在进行中」直到 TTL——立即
                    // 收口烧槽(§1.3,codex r2 N1)。
                    self.fail_pair(ws, "配对码无人接收(发起方已放弃等待)".into(), true).await;
                }
                Ok(())
            }
            ServerMsg::PairPeer { event } => match event {
                PairEvent::Joined => {
                    let _ = self.events.send(SyncEvent::Pair {
                        phase: "joined",
                        detail: "对方已连上,正在校验配对码".into(),
                    });
                    let step = self.pair.as_mut().and_then(|p| p.opener.as_mut()).map(|o| o.on_joined());
                    self.drive_pair(ws, step).await
                }
                PairEvent::Left | PairEvent::Closed => {
                    if self.pair.is_some() {
                        // 槽已随对端关闭而死:不回发 PairClose——对烧掉的槽再 Close
                        // 会招来一条迟到的 bad_slot Err,若新配对已开新槽,它会被
                        // 误杀(工序 7/8 H1 测试抓出;老路径则是状态面幽灵错误)。
                        self.fail_pair(ws, "对方离开(配对码不对,或对方取消)".into(), false)
                            .await;
                    }
                    Ok(())
                }
            },
            ServerMsg::PairMsg { slot, blob } => {
                let step = match self.pair.as_mut() {
                    Some(p) if p.slot == Some(slot) => {
                        p.opener.as_mut().map(|o| o.on_msg(&blob))
                    }
                    _ => None,
                };
                self.drive_pair(ws, step).await
            }
            ServerMsg::Registered { device } => {
                let _ = self.events.send(SyncEvent::Pair {
                    phase: "registering",
                    detail: format!("设备 {device} 已注册"),
                });
                let step = self.pair.as_mut().and_then(|p| p.opener.as_mut()).map(|o| o.on_registered());
                self.drive_pair(ws, step).await
            }
            // ⛔ **无编号 `Err` 的归属改成白名单**(§5.5 设计审三轮 H1),不许再用「有 flow
            // 在飞就归它」。仓里今天就有一条主动异步推送:未声明 `CAP_ACCOUNT_STATUS_V1`
            // 的连接会被推 `Err{account_throttled}`(fastlane 首次越额 + admin 状态变更)。
            // 交错 = `DeviceAdmin` 正在等结果 → 任意一枚 `Send` 触发首次越额 → 服务端异步
            // 推那枚 `Err` → 客户端提前错误结账 → 真正的 `DeviceAdminOk` 到达时 flow 已被
            // 清掉。Pair flow 一样中招。
            //
            // ⚠ 白名单**不等于**「对将来任何新增的主动推送免疫」(五轮 L1 打掉了我那句
            // 过强的话)。准确条件是:**将来任何主动推送的 `Err` 必须用一个不在任何 flow
            // 白名单里的 code**;某天有人给主动推送复用了 `busy`/`bad_request`,照样会被
            // 误认。那条契约的可执行面在服务端(主动推送 helper 的 `debug_assert`)。
            //
            // `RosterRefresh` **刻意不在这张表里**:它的失败面是带号的 `RosterNack`,
            // 故一枚无编号 `Err` 永远不该结它。
            ServerMsg::Err { code, msg } => {
                let text = human_err(&code, &msg);
                let c = code.as_str();
                // ⛔ 归属一旦被「上一笔按 deadline 放弃」污染,这条连接上的无编号 `Err`
                // 就再也证不了自己属于谁(弹三 M1),一律只进状态面。
                if self.err_attribution_poisoned {
                    self.set_status(|s| s.error = Some(text));
                } else if self.pair.is_some() && err_code::PAIR_FLOW_ERRORS.contains(&c) {
                    // bad_slot = 槽已死:别再回发 PairClose 补刀——对死槽的 Close
                    // 只会招来下一枚无法归属的迟到错误(工序 7/8 二审 M1)。
                    let close = code != err_code::BAD_SLOT;
                    self.fail_pair(ws, text, close).await;
                } else if self.admin.is_some() && err_code::DEVICE_ADMIN_FLOW_ERRORS.contains(&c) {
                    self.settle_admin(Err(text));
                } else {
                    self.set_status(|s| s.error = Some(text));
                }
                Ok(())
            }
            // SeatLease 回执只属于纪元预注册的专用短连接(register_pending_identity);
            // live 连接不求租,迟到/串线的回执与握手噪音同待遇。
            ServerMsg::Challenge { .. }
            | ServerMsg::Authed
            | ServerMsg::Pong
            | ServerMsg::SeatLease { .. } => Ok(()),
            // 工序4:AccountStatusV1 只对声明 account_status_v1 能力者下发;本轮客户端不
            // 声明,故正常永不收到。收到=服务端门控 bug——**忽略**(非断连:良性控制帧,
            // 不改同步数据/密钥/水位;声明 cap 与渲染属未来轮,服务端阴性测负责抓门控)。
            ServerMsg::AccountStatusV1 { .. } => Ok(()),
            // 权威名册(§5.4)。**两条判据分家**(二轮 M1):`request` 号只管「结不结账」,
            // `revision` 只管「用不用这份数据」。反过来 `request == None` 的主动推送不结账,
            // 但 revision 更新时照样应用 —— 它仍是权威名册。
            ServerMsg::Roster { request, revision, devices } => {
                // ⛔ 状态面的写入是**传进去的回调**,不是「回来之后自己记得写」
                // (弹三 M2):顺序「先写状态面、再结账」由调度机内部保证,调用方
                // 没有把它写反的余地。两个字段是 `Ctx` 的不同成员,分别借得开。
                let (status, events) = (&self.status, &self.events);
                self.roster.on_roster(request, revision, devices, |snap| {
                    set_status(status, events, |s| s.roster = snap);
                });
                Ok(())
            }
            // `RosterReq` 的失败面(二轮 H2)。三格处置见 `RosterSched::on_nack`;
            // ⛔ `busy` 绝不许把已有的 `Some(roster)` 清成 `None`。
            ServerMsg::RosterNack { n, code } => {
                self.roster.on_nack(n, human_err(&code, ""));
                Ok(())
            }
            // 定向成功回执:**比对 target + action 才结账**(§5.7-3)。对不上 = 上一笔
            // 已超时命令的迟到回执,丢。
            ServerMsg::DeviceAdminOk { target, action } => {
                if self.admin.as_ref().is_some_and(|f| f.target == target && f.action == action) {
                    self.settle_admin(Ok(()));
                }
                Ok(())
            }
        }
    }

    // ---- 设备管理与名册(identity-plan §5.4/§5.7) ----

    /// 设备管理命令的**唯一结账出口**(§5.5 五轮:成功 / `Err` / deadline / 断连四条路
    /// 都走这里,`take()` 只在这里做一次)。同步、无 await —— `Ctx::Drop` 里调得动。
    ///
    /// 没有 flow 就什么也不做:一枚 `auth_failed` 结完账之后紧接着的断连清场看到 `None`,
    /// **不得再报第二次失败**。
    pub(super) fn settle_admin(&mut self, r: Result<(), String>) {
        if let Some(f) = self.admin.take() {
            let _ = f.reply.send(r);
        }
    }

    /// **按 deadline 放弃一笔 flow**(实现审弹三 M1)。
    ///
    /// 病:无编号 `Err` 的归属判据只有「此刻哪笔 flow 在飞 + code 在不在白名单」,
    /// 而它**没有请求号**。于是:命令 A 发出 → 服务端那枚 `Err{busy}` 因下行积压迟到
    /// → A 到点被本地结账 → 同一条连接上起命令 B → A 的迟到 `busy` 到达 → **B 被错误
    /// 结掉**,而 B 随后仍可能在服务端真的执行 —— 客户端已经向 UI 报了失败。
    /// 互斥域只挡「两笔同时在飞」,挡不住「上一笔超时后,迟到回执落进下一笔」。
    /// 两张白名单有重合 code,故 Pair↔Admin 之间**互相**也串得动。
    ///
    /// 修法**不动线协议**(不加请求号):一旦有一笔 flow 是按 deadline 放弃的
    /// (= 结果未确认、服务器那枚回执可能仍在路上),这条连接上的无编号 `Err` 归属
    /// **从此不再可信** —— 此后一律只进状态面,flow 一律靠自己的 deadline 收场。
    /// 代价 = 那之后的失败要等满 deadline 才报(慢,但绝不错判);毒性随会话结束而消失
    /// (`Ctx` 每会话新建)。
    pub(super) fn abandon_flow_by_deadline(&mut self) {
        self.err_attribution_poisoned = true;
    }

    /// 三条 UI 发起的服务器命令共用一个互斥域(§5.7-4):配对 / 设备管理 / 名册刷新。
    /// 理由是它们都靠**无编号**的 `ServerMsg::Err` 认失败,两笔同时在飞会把 Err 认错主。
    /// ⚠ 恒在轴那枚周期拉取**不占**这个域(它有 `request` 号可自证,且不该被一个开着的
    /// 浮层饿死)。
    fn ui_command_busy(&self) -> bool {
        self.pair.is_some() || self.admin.is_some() || self.roster.ui_busy()
    }

    /// **能力闸**(§5.10-2 一轮 M4):本会话收到过 `Roster` 吗。没有就本地回错、**一个
    /// 新信封都不发** —— 老服务器收到不认识的 `ClientMsg` 会 `bad_request` 并断开,
    /// 那等于「点一下设备面板就把同步会话打断一次」。
    ///
    /// ⚠ 措辞不许说「服务器版本较旧」:新服务器的 attach 推送同样可能丢(§5.4)。
    fn roster_cap_gate(&self) -> Result<(), String> {
        match self.roster.cap_seen() {
            true => Ok(()),
            false => Err("尚未确认服务器支持,暂不可用".into()),
        }
    }

    pub(super) async fn on_device_admin(
        &mut self,
        ws: &mut Ws,
        target: String,
        action: DeviceAction,
        reply: AdminReply,
    ) -> Result<(), String> {
        if let Err(e) = self.roster_cap_gate() {
            let _ = reply.send(Err(e));
            return Ok(());
        }
        if self.ui_command_busy() {
            let _ = reply.send(Err("已有操作在进行中,请稍后再试".into()));
            return Ok(());
        }
        // **形态闸先于签名**(§5.5,与既有三条签名路同纪律):定长形态是拼接无歧义的
        // 前提。服务端也判,这里判是不让一枚必被拒的帧白跑一趟。
        if !crate::clock::is_canonical_device_id(&target) {
            let _ = reply.send(Err("设备编号形态不合法".into()));
            return Ok(());
        }
        let sig = self.signing.sign(&device_admin_sig_payload(
            &self.nonce,
            &self.cfg.account_id,
            &self.cfg.device_id,
            &target,
            action,
        ));
        // ⛔ **先把 flow 装进 `Ctx`,再发帧**(实现审弹三 L1)。反过来写的话,
        // `send_client(...).await` 那一段里 `reply` 还躺在这个栈帧上 —— 外层 shutdown
        // 直接取消 session future 时,它随栈帧一起 drop,`Ctx::Drop` **看不见它**,于是
        // 结账没经过 `settle_admin()`(oneshot 的 receiver 收到 `Canceled`,两壳虽然都把
        // 它映射成诚实的断连文案,但「五路统一结账 / 所有退出点在 Drop 交汇」这句就不成立)。
        // 装进去之后:发帧失败也好、future 被取消也好,一律由 `Drop` 收口。
        // `RosterRefresh` 那条本来就是这个所有权顺序(waiter 先挂进调度机再发帧)。
        self.admin = Some(AdminFlow {
            target: target.clone(),
            action,
            deadline: Instant::now() + DEVICE_ADMIN_DEADLINE,
            reply,
        });
        send_client(ws, &ClientMsg::DeviceAdmin {
            account: self.cfg.account_id.clone(),
            target,
            action,
            sig: sig.to_bytes().to_vec(),
        })
        .await?;
        Ok(())
    }

    pub(super) async fn on_roster_refresh(
        &mut self,
        ws: &mut Ws,
        reply: RosterReply,
    ) -> Result<(), String> {
        if let Err(e) = self.roster_cap_gate() {
            let _ = reply.send(Err(e));
            return Ok(());
        }
        if self.ui_command_busy() {
            let _ = reply.send(Err("已有操作在进行中,请稍后再试".into()));
            return Ok(());
        }
        // 三格全在调度机里(§5.4「UI 请求刷新」):无 pending 就发新的、pending 还剩得多
        // 就**搭车不发帧**、快到期就作废旧 n 换新。`None` = 已挂上 waiter 但不发帧。
        if let Some(n) = self.roster.on_ui_request(Instant::now(), reply) {
            send_client(ws, &ClientMsg::RosterReq { n }).await?;
        }
        Ok(())
    }

    /// 名册恒在轴的一拍(§5.4)。挂在既有心跳上,**不新开生命周期入口**。
    pub(super) async fn roster_tick(&mut self, ws: &mut Ws) -> Result<(), String> {
        if let Some(n) = self.roster.on_tick(Instant::now()) {
            send_client(ws, &ClientMsg::RosterReq { n }).await?;
        }
        Ok(())
    }

    // ---- 密文帧:逐域试解 → 引擎/引导 ----

    /// 中转腿到达的一枚密文帧。**来路由本 socket 的所有者在此代入**(§2/§5:来路是传输层
    /// 内部事实,绝不取自对端字段)——服务器已鉴权 `from` + AAD 双保险,这一条正是「唯一
    /// 权威路」的字面。引导帧由投递面交回,在这里进引导编排。
    async fn on_deliver(
        &mut self,
        ws: &mut Ws,
        from: &str,
        to: &str,
        blob: &[u8],
    ) -> Result<(), String> {
        match self.deck(ws).on_wire(Ingress::RelayDeliver, from, to, blob).await? {
            None => Ok(()),
            Some(bm) => self.on_boot_msg(ws, from, bm).await,
        }
    }

    // ---- 引导(新端拉流 / 老端供流) ----

    pub(super) async fn try_boot_request(&mut self, ws: &mut Ws) -> Result<(), String> {
        if !self.booting() || self.boot_peer.is_some() {
            return Ok(());
        }
        let Some(target) = self.peers.front().cloned() else {
            return Ok(()); // 没同伴在线:保持 booting,等 Peer 事件。
        };
        let blob = crypto::seal_msg(
            &self.cfg.k_acc,
            &FrameAddr {
                account_id: &self.cfg.account_id,
                from_device: &self.cfg.device_id,
                to: &target,
                domain: Domain::Boot,
            },
            &BootMsg::Req,
        );
        self.deck(ws).send_envelope(&target.clone(), WireLane::Direct, blob, Sent::BootReq).await?;
        self.boot_peer = Some(target);
        self.boot_deadline = Some(Instant::now() + Duration::from_secs(BOOT_STEP_SECS));
        Ok(())
    }

    /// 放弃当前引导尝试(超时/对方掉线/坏流),轮转候选,等下一次 try_boot_request。
    pub(super) fn boot_rotate(&mut self) {
        self.boot_peer = None;
        self.boot_recv = None; // Drop 兜底清临时文件。
        self.boot_deadline = None;
        if self.peers.len() > 1 {
            self.peers.rotate_left(1);
        }
    }

    async fn on_boot_msg(&mut self, ws: &mut Ws, from: &str, bm: BootMsg) -> Result<(), String> {
        match bm {
            BootMsg::Req => {
                // 老端供快照。自己也在引导 = 无从供给,静默(对方超时换人,§6.2
                // 并发引导);已有一流在供,同样静默。缺字节者拒当源(phone-space-
                // plan §1.1,判定在 boot_serve_snapshot):MetadataOnly 库的
                // item_image 天生不完整、Full 端字节未拉完时也有缺口,不许把
                // 「全量引导」悄悄变成部分克隆——同一静默语义,对方超时轮转到
                // 全量端。
                if !self.allow_boot_source || self.booting() || self.boot_out.is_some() {
                    return Ok(());
                }
                let snap = {
                    let conn = self.db.lock().expect("db mutex poisoned");
                    boot_serve_snapshot(&conn, &self.data_dir)
                };
                match snap {
                    Ok(Some(snap)) => match BootSender::new(&snap) {
                        Ok(sender) => {
                            self.boot_out =
                                Some(BootOut { to: from.into(), sender, path: snap.path });
                        }
                        Err(e) => {
                            // BootSender::new 失败:make_snapshot 已产文件,别把明文副本留在盘上(#4)。
                            let _ = std::fs::remove_file(&snap.path);
                            self.set_status(|s| s.error = Some(format!("无法供应引导快照:{e}")));
                        }
                    },
                    // 字节有洞:静默不供,对方超时轮转到全量端(与「已在供流」同形态)。
                    Ok(None) => {}
                    Err(e) => {
                        // 本机故障(完整性查询失败/磁盘满等):响亮进状态(对方会换人)。
                        self.set_status(|s| s.error = Some(format!("无法供应引导快照:{e}")));
                    }
                }
                Ok(())
            }
            BootMsg::Offer { transfer, bytes, sha256 } => {
                if !self.booting() || self.boot_peer.as_deref() != Some(from) {
                    return Ok(()); // 残帧/未请求的 Offer:丢。
                }
                match BootReceiver::start(&self.data_dir, from, &transfer, bytes, &sha256) {
                    Ok(r) => {
                        // 可用空间预检(android-plan §3):导入峰值 ≈「临时快照 +
                        // 正式库 + WAL」三份并存。**必须在 BootReceiver::start 的协议
                        // sanity(bytes ∈ (0, 8GiB]、transfer ULID)之后**——否则坏
                        // 对端伪造的天文/负数 bytes 会被误判成「本机空间不足」,把
                        // 轮转到正常快照源的路堵死(codex P4-d 轮 M2)。空间不够 =
                        // 置 space_blocked,session 立即断连(源端下一块吃 Nack 即
                        // 止流,不白发 8GiB)、外层固定长等待(M1/复核 M,见
                        // BOOT_SPACE_RETRY_SECS 注释);拿不到统计的平台(Windows)
                        // 不拦,写盘 fail-fast 兜底。
                        if let Some(free) = free_space(&self.data_dir) {
                            if let Some(need) = boot_space_shortfall(free, bytes) {
                                drop(r); // Drop 兜底删掉刚建的临时收流文件。
                                let text = format!(
                                    "初始同步空间不足:快照 {},导入峰值约需 {},本机仅剩 {}——请清理存储,{} 分钟后自动重试",
                                    human_bytes(bytes as u64),
                                    human_bytes(need),
                                    human_bytes(free),
                                    BOOT_SPACE_RETRY_SECS / 60
                                );
                                self.toast(text.clone());
                                self.set_status(|s| s.error = Some(text));
                                self.space_blocked = true;
                                return Ok(());
                            }
                        }
                        self.boot_recv = Some(r);
                        self.boot_deadline =
                            Some(Instant::now() + Duration::from_secs(BOOT_STEP_SECS));
                        let _ = self
                            .events
                            .send(SyncEvent::BootProgress { received: 0, total: bytes });
                    }
                    Err(e) => {
                        self.set_status(|s| s.error = Some(format!("引导流开启失败:{e}")));
                        self.boot_rotate();
                        self.try_boot_request(ws).await?;
                    }
                }
                Ok(())
            }
            BootMsg::Chunk { transfer, idx, last, data } => {
                let Some(recv) = self.boot_recv.as_mut() else {
                    return Ok(()); // 没有进行中的收流:残帧,丢。
                };
                match recv.on_chunk(from, &transfer, idx, last, &data) {
                    Ok(ChunkOutcome::More) => {
                        self.boot_deadline =
                            Some(Instant::now() + Duration::from_secs(BOOT_STEP_SECS));
                        let (received, total) = recv.progress();
                        let _ = self.events.send(SyncEvent::BootProgress { received, total });
                        Ok(())
                    }
                    Ok(ChunkOutcome::Ignored) => Ok(()),
                    Ok(ChunkOutcome::Complete) => {
                        let (received, total) = recv.progress();
                        let _ = self.events.send(SyncEvent::BootProgress { received, total });
                        self.finish_boot(ws).await
                    }
                    Err(e) => {
                        self.set_status(|s| s.error = Some(format!("引导流中断:{e}")));
                        self.boot_rotate();
                        self.try_boot_request(ws).await
                    }
                }
            }
        }
    }

    async fn finish_boot(&mut self, ws: &mut Ws) -> Result<(), String> {
        let path = self
            .boot_recv
            .as_ref()
            .expect("Complete 必有收流器")
            .path()
            .to_path_buf();
        // 接线契约:fresh 校验到 commit 持同一把写锁(先 db 后 clock,与 write_locks
        // 同序),引导与本地命令/引擎应用互斥;import_snapshot 事务内还会重验 fresh。
        let import = {
            let mut conn = self.db.lock().expect("db mutex poisoned");
            let mut clk = self.clock.lock().expect("clock mutex poisoned");
            let r = boot::import_snapshot(&mut conn, &mut clk, &path);
            // 「须重开」旗与导入共临界区(codex 二轮 M2):排队在这把 db 锁上的业务
            // 写,拿到锁时旗必已在——「先查旗(None)→ 阻塞在锁上 → 导入提交放锁 →
            // 抢到锁写进已判废连接」的竞态从此关死(壳层写闸配套改成**锁内复核**)。
            if let Ok(boot::ImportOutcome::CommittedNeedsReopen { error, .. }) = &r {
                *self.restart_flag.lock().expect("restart_flag mutex poisoned") =
                    Some(error.clone());
            }
            r
        };
        let _ = std::fs::remove_file(&path);
        self.boot_recv = None;
        self.boot_peer = None;
        self.boot_deadline = None;
        match import {
            Ok(boot::ImportOutcome::Committed { report, post_commit_error }) => {
                // BootCommitted latch(space-entry-plan §3.2 三轮 M1):持久提交 +
                // 事务内 integrity 已过、relay_session_up **之前** take+send。receiver
                // 已关(JoinManager 放弃)不视为错误——latch 只是通知位。
                if let Some(tx) =
                    self.boot_commit.lock().expect("boot_commit mutex poisoned").take()
                {
                    let _ = tx.send(BootCommitNotice {
                        report: report.clone(),
                        post_commit_error: post_commit_error.clone(),
                        needs_reopen: false,
                    });
                }
                self.toast(format!(
                    "初始同步完成:{} 条内容、{} 张配图已就位",
                    report.items, report.images
                ));
                if let Some(w) = post_commit_error {
                    self.set_status(|s| s.error = Some(w));
                }
                // 库已提交,先通知本地读库再碰网络(codex 实现审 M1):relay_session_up
                // 里的 hello/push 可失败提前返回,事件排它后面 = 名字落了库、壳却
                // 到重启才知道。事件只驱动本地重读,不依赖网络恢复。
                let _ = self.events.send(SyncEvent::Changed);
                // boot 物化绕过 apply_remote_op(§4.7 三入口之二,codex 二轮 H2):
                // 名字可能随快照刚到,专用事件让壳刷空间名(无名也无害,只是重读)。
                let _ = self.events.send(SyncEvent::SpaceNameChanged);
                // 接线契约:导入抬了水位,必须装配引擎再走会话仪式(boot.rs 注释)。
                self.relay_session_up(ws).await?;
                Ok(())
            }
            Ok(boot::ImportOutcome::CommittedNeedsReopen { report, error }) => {
                // 库已可信提交、连接却还挂着 boot 库(§3.2):「须重开」旗已在上方
                // **导入临界区内**落下(codex 二轮 M2),这里只做状态与 latch;
                // **禁止在原 Connection 上 relay_session_up**,置位让 session 以
                // ReopenRequired 收场(run 整体退出、不重连)。
                self.set_status(|s| {
                    s.state = "off".into();
                    s.error = Some(format!("初始同步已完成,但需要重启同步会话:{error}"));
                });
                if let Some(tx) =
                    self.boot_commit.lock().expect("boot_commit mutex poisoned").take()
                {
                    let _ = tx.send(BootCommitNotice {
                        report,
                        post_commit_error: Some(error.clone()),
                        needs_reopen: true,
                    });
                }
                let _ = self.events.send(SyncEvent::Changed);
                let _ = self.events.send(SyncEvent::SpaceNameChanged);
                self.reopen_required = Some(error);
                Ok(())
            }
            Err(e) => {
                // 整体回滚无痕:报错并稍后换一台重试(快照损坏/版本不同,文案已是人话)。
                self.toast(format!("初始同步失败:{e}"));
                self.set_status(|s| s.error = Some(e));
                self.boot_rotate();
                self.boot_deadline =
                    Some(Instant::now() + Duration::from_secs(BOOT_STEP_SECS));
                Ok(())
            }
        }
    }

    /// 供流泵:每次 select 空转发一块(与收帧/心跳互相穿插,不独占循环)。
    pub(super) async fn pump_boot_out(&mut self, ws: &mut Ws) -> Result<(), String> {
        let step = {
            let bo = self.boot_out.as_mut().expect("select 守卫已判");
            match bo.sender.next_msg() {
                Ok(Some(msg)) => Some((bo.to.clone(), msg)),
                Ok(None) => None,
                Err(e) => {
                    self.set_status(|s| s.error = Some(format!("引导供流中断:{e}")));
                    None
                }
            }
        };
        match step {
            Some((to, msg)) => {
                let blob = crypto::seal_msg(
                    &self.cfg.k_acc,
                    &FrameAddr {
                        account_id: &self.cfg.account_id,
                        from_device: &self.cfg.device_id,
                        to: &to,
                        domain: Domain::Boot,
                    },
                    &msg,
                );
                self.deck(ws).send_envelope(&to, WireLane::Direct, blob, Sent::BootOut).await
            }
            None => {
                if let Some(bo) = self.boot_out.take() {
                    discard_boot_out(bo);
                }
                Ok(())
            }
        }
    }

    // ---- 配对(opener 侧;joiner 走 pair_join 专用连接) ----

    pub(super) async fn on_pair_start(
        &mut self,
        ws: &mut Ws,
        reply: oneshot::Sender<Result<String, String>>,
    ) -> Result<(), String> {
        if self.booting() {
            let _ = reply.send(Err("正在初始同步,完成后再发起配对".into()));
            return Ok(());
        }
        if self.pair.is_some() {
            let _ = reply.send(Err("已有配对在进行中".into()));
            return Ok(());
        }
        // 367:互斥域从「只看配对」扩到三条命令(§5.7-4)。设备管理 / 名册刷新在飞时
        // 开配对,那枚无编号 `Err` 就有两个候选主人了。
        if self.ui_command_busy() {
            let _ = reply.send(Err("已有操作在进行中,请稍后再试".into()));
            return Ok(());
        }
        send_client(ws, &ClientMsg::PairOpen).await?;
        self.pair = Some(PairFlow {
            secret: pair::gen_secret(),
            slot: None,
            opener: None,
            reply: Some(reply),
            // 先按开槽阶段计短时;PairSlot 到达时重置为码的真实 TTL(§1.3)。
            deadline: Instant::now() + Duration::from_secs(PAIR_OPEN_SECS),
        });
        Ok(())
    }

    /// 驱动 opener 状态机的一步输出(None = 当下没有配对在跑,消息是残帧,丢)。
    async fn drive_pair(
        &mut self,
        ws: &mut Ws,
        step: Option<Result<Vec<PairOutput>, pair::PairError>>,
    ) -> Result<(), String> {
        let Some(step) = step else { return Ok(()) };
        let outs = match step {
            Ok(o) => o,
            Err(e) => {
                self.fail_pair(ws, e.to_string(), true).await;
                return Ok(());
            }
        };
        let slot = self.pair.as_ref().and_then(|p| p.slot).expect("有 opener 必有 slot");
        for o in outs {
            match o {
                PairOutput::Send(blob) => {
                    send_client(ws, &ClientMsg::PairMsg { slot, blob }).await?;
                }
                PairOutput::Register { device_id, pubkey } => {
                    let sig = self.signing.sign(&register_device_sig_payload(
                        &self.cfg.account_id,
                        &device_id,
                        &pubkey,
                    ));
                    send_client(ws, &ClientMsg::RegisterDevice {
                        account: self.cfg.account_id.clone(),
                        new_device: device_id,
                        new_pubkey: pubkey.to_vec(),
                        sig_by_old: sig.to_bytes().to_vec(),
                    })
                    .await?;
                }
                PairOutput::Granted(_) | PairOutput::GrantPending { .. } => {
                    return Err("opener 不该输出 joiner 侧变体(编排 bug)".into());
                }
                PairOutput::Finished => {
                    self.pair = None;
                    let _ = self.events.send(SyncEvent::Pair {
                        phase: "done",
                        detail: "新设备已加入账户,正在初始同步".into(),
                    });
                }
            }
        }
        Ok(())
    }

    /// 配对失败收口:烧槽(PairClose,`close_slot`——对端已关时槽已死,别再关)
    /// + 回执/事件。任何一步失败后配对码即作废(服务器 MITM 恒只有一次在线猜测,§4)。
    pub(super) async fn fail_pair(&mut self, ws: &mut Ws, why: String, close_slot: bool) {
        let Some(mut p) = self.pair.take() else { return };
        if let Some(r) = p.reply.take() {
            let _ = r.send(Err(why.clone()));
        }
        if close_slot {
            if let Some(slot) = p.slot {
                let _ = send_client(ws, &ClientMsg::PairClose { slot }).await;
            }
        }
        let _ = self.events.send(SyncEvent::Pair { phase: "failed", detail: why });
    }
}
