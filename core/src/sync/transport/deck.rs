use super::*;

/// **投递面**(L-c2c):引擎输出的唯一出口 + 入帧的唯一入口,**两条腿、在线离线共用**。
///
/// 为什么非要有这么一层:直连的收发必须在**没有中转会话**时也照跑(不变量 6 / §5「本机
/// 中转离线:全部 mail 走各 lan 链路」),而 [`Ctx`] 是「一条已鉴权 WSS 会话」的东西。把
/// `dispatch`/`feed` 收进这里,离线泵与会话循环用的就是同一份选路与同一份收帧管道——
/// 复制一份「离线专用的收帧路径」才是真风险(L-b/L-c1/L-c2a 三笔实现审同一条教训)。
///
/// 中转腿在不在由 [`RelayLeg`] 说,**不是一个可忘的 bool**:`Up` 才带得出 socket 与信封
/// 序号,故「离线时误往中转发一帧」在类型层不存在。
pub(super) struct Deck<'a> {
    pub(super) db: &'a Arc<Mutex<Connection>>,
    pub(super) clock: &'a Arc<Mutex<Clock>>,
    pub(super) status: &'a Arc<Mutex<SyncStatus>>,
    pub(super) events: &'a mpsc::UnboundedSender<SyncEvent>,
    pub(super) cfg: &'a SyncConfig,
    pub(super) slot: &'a mut EngineSlot,
    pub(super) relay: RelayLeg<'a>,
}

/// 中转腿的在场形。
pub(super) enum RelayLeg<'a> {
    /// 本机中转会话不在(断 WAN 冷启动 / 退避重连 / 空间不足等待):§5「全部 mail 走各
    /// lan 链路」——收件面由 [`Engine::lan_backfill_peers`] 给出,与「中转在线时对端离线
    /// 才补投」**是同一条规则**(那时全部对端的 relay 腿都是 Absent),故没有第二套分支。
    Down,
    Up { ws: &'a mut Ws, sess: &'a mut RelaySession },
}

impl Deck<'_> {
    pub(super) fn set_status(&self, f: impl FnOnce(&mut SyncStatus)) {
        set_status(self.status, self.events, f);
    }

    fn toast(&self, msg: String) {
        let _ = self.events.send(SyncEvent::Toast(msg));
    }

    /// 引导中吗(引擎槽空 = 还没拿到首份快照)。
    fn booting(&self) -> bool {
        self.slot.booting()
    }

    fn relay_up(&self) -> bool {
        matches!(self.relay, RelayLeg::Up { .. })
    }

    /// 通告面(§2)。`None` = 中转腿不在——通告面**在 lan 那条腿上根本不存在**(单一权威
    /// 路:只有经 deliver 到达的帧算数,往 lan 帧里塞通告是白费字节),不是「忘了处理」。
    pub(super) fn ad(&mut self) -> Option<AdDeck<'_>> {
        let RelayLeg::Up { sess, .. } = &mut self.relay else { return None };
        Some(AdDeck {
            db: self.db,
            status: self.status,
            events: self.events,
            cfg: self.cfg,
            slot: self.slot,
            ad: &mut sess.ad,
        })
    }

    /// 链路集变了之后刷一次槽的事实(链路数进状态面 + 活跃对端进准入表的视图)。
    /// **走 [`EngineSlot::apply_status`] 那个唯一出口**:L-c3a 起链路集除了链路数还要
    /// 对外发布活跃对端(§4 步骤 1 的第四道闸),再手写一格就是第二处真相源。
    fn refresh_lan_status(&self) {
        self.set_status(|s| self.slot.apply_status(s));
    }

    /// 交给新链写泵的供流上下文(§10 C′)。**每条链一份克隆**:写泵得能在协调者忙着别的
    /// 事时独立取数、封帧、写 socket。
    pub(super) fn serve_ctx(&self) -> ServeCtx {
        ServeCtx {
            db: Arc::clone(self.db),
            status: Arc::clone(self.status),
            events: self.events.clone(),
            account_id: self.cfg.account_id.clone(),
            device_id: self.cfg.device_id.clone(),
            k_acc: self.cfg.k_acc,
            device_seed: self.cfg.device_seed,
            ops: Arc::clone(&self.slot.ops),
            ops_changed: Arc::clone(&self.slot.ops_changed),
        }
    }

    // ---- 入帧:解封 → 引擎 ------------------------------------------------------------

    /// 一枚密文帧的解封与分流(**两条腿共用**):两道地址闸 → 逐域试解 → 引导中整帧
    /// 丢弃 → 数据帧入 [`Deck::feed`]。引导帧不在此处理,**原样交回调用方**——引导编排
    /// (源端/收端状态机、临时快照、latch)是会话的活,而 boot 帧 v1 恒走中转(§5),lan
    /// 那边收到即拒。
    ///
    /// **两道地址闸**(307 收 `from`,308 收 `to`)。
    ///
    /// **`from` 必须是完整的规范设备 id**(307;尺只此一把:
    /// [`crate::clock::is_canonical_device_id`],与 `vet_target` / `vet_watermarks` /
    /// `replay` 同源)。这一格是 305 那轮 codex 纠正我的地方:我当时报「持 K_acc 的成员封
    /// 一枚 `from = "*"` 的 Hello 就能给 BROADCAST 开出 active 计划」,而**成员单独作恶做
    /// 不到** —— `ClientMsg::Send` 根本没有 `from` 字段,服务端从已鉴权连接自行构造
    /// `Deliver.from`,成员按 `"*"` 封的密文到收端会用真 device id 重构 AAD → 解不开;
    /// LAN 那条另有 [`lan::check_frame_addr`] 要求 `Frame.from` 等于握手验签得到的对端。
    /// 要**成员与中转串通**才做得到,故这道闸是**纵深防御,不是现存可达漏洞**。
    ///
    /// 校验的是「是不是规范设备 id」而**不是特判 `"*"`**(codex 原话):真正要挡的是
    /// 「`from` 被当成 `on_hello` / `on_want` 的 target 用出去」,而那把尺的合法域是
    /// `BROADCAST ∪ 规范设备 id` —— 只堵掉字面的星号,任何别的畸形值照样能建 target。
    /// 做了它顺带把「**BROADCAST 不得拥有 active 计划**」这条阴性结论钉死在入口上。
    ///
    /// **拒一枚帧,不拆会话**:与本函数另两条拒收臂(变体-域不符 / 解不开)同档。这条路
    /// 上的帧还没解密、什么都没做成,是惰性的;而 `on_wire` 的 `Err` 在两条腿上都是
    /// session-fatal,拿它答远端递来的一个畸形字段,等于把「拆掉本机会话」这根杠杆递出去。
    pub(super) async fn on_wire(
        &mut self,
        ingress: Ingress,
        from: &str,
        to: &str,
        blob: &[u8],
    ) -> Result<Option<BootMsg>, String> {
        if !crate::clock::is_canonical_device_id(from) {
            let text = format!("拒收一枚帧:发件设备 id 不合规范({from:?})");
            self.set_status(|s| s.error = Some(text));
            return Ok(None);
        }
        // **收件人必须是本机或广播**(308;codex 307 轮 L 收紧过的判据)。注意这**不是**
        // 「`to` 也过一遍 `is_canonical_device_id`」—— 只要求语法规范的话,一枚发给**第三台
        // 设备**的合法帧照样进得来,而它会一路走到 `feed` 的 `directed = to == 本机` 判成
        // false,以别人的信封身份影响本机的通告应答面(§2 的隐式索要)。地址归属这件事,
        // LAN 那条腿从 L-c2c 起就是这么要求的([`lan::check_frame_addr`],不符即断链);
        // 中转腿此前一直敞着,本笔与它对齐。
        //
        // 与 `from` 那道同一条:**成员单独作恶做不到**(服务端按信箱路由,`to` 不是本机的
        // 帧压根不会投给本机;AAD 又把 `to` 钉死,改一个字节就解不开),要**成员与中转
        // 串通**才做得到 —— 纵深防御,不是现存可达漏洞。处置也同一条:拒这一枚帧、只进
        // advisory 面、**不拆会话**。
        //
        // 位置在 `open_deliver` **之前**,故也排在 `directed` 判定产生任何行为之前。
        if to != self.cfg.device_id && to != BROADCAST {
            let text = format!("拒收 {from} 的帧:收件人既不是本机也不是广播({to:?})");
            self.set_status(|s| s.error = Some(text));
            return Ok(None);
        }
        match open_deliver(self.cfg, from, to, blob) {
            Opened::Data(msg) => {
                // 引导中整帧丢弃(模块注释;hello 互补会重取)。**通告也一起丢**:此刻库
                // 正处在「fresh 待导入」的窗口里,不许往 sync_meta 添任何行;LanReady 本就
                // 要求引擎在场(不变量 6),引导期学不学公钥毫无区别。
                if self.booting() {
                    return Ok(None);
                }
                self.feed(ingress, from, to, msg).await?;
                Ok(None)
            }
            Opened::Boot(bm) => Ok(Some(bm)),
            Opened::Skew => {
                self.report_skew();
                Ok(None)
            }
            Opened::WrongDomain(domain) => {
                // 认证通过但变体不属于该域:协议映射被破坏(对端实现漂移),按协议
                // 错误拒收——不是 skew(skew 会劝人升级,这里升级也没用)。
                let text = format!("拒收 {from} 的帧:变体与加密域 {domain} 不符(对端实现漂移?)");
                self.set_status(|s| s.error = Some(text));
                Ok(None)
            }
            Opened::Undecryptable => {
                let text = format!("收到无法解密的帧(来自 {from};密钥不一致?)");
                self.set_status(|s| s.error = Some(text));
                Ok(None)
            }
        }
    }

    fn report_skew(&mut self) {
        if !self.slot.notices.skew_toasted {
            self.slot.notices.skew_toasted = true;
            self.toast("对端版本较新,请升级朱简后继续同步".into());
        }
        self.set_status(|s| s.skew = true);
    }

    /// 一帧内层消息入引擎的**唯一入口**(两条腿共用):来路 → [`Route`] 的映射只此一处
    /// (§2/§5「来路是传输层内部事实,绝不取自对端字段」),通告吸收也收在这里。
    ///
    /// `to` = 信封上的收件人(本机 device_id 或广播),只用来判「这是不是定向发给本机的
    /// Hello」= §2 的隐式索要。它同样是传输层事实(服务器回显的信封 / LanWire 的地址闸,
    /// 两者都在解密前后各有一道 AAD 保险)。
    async fn feed(
        &mut self,
        ingress: Ingress,
        from: &str,
        to: &str,
        msg: Msg,
    ) -> Result<(), String> {
        let route = route_of(ingress);
        // 吸收要在引擎处理这枚 Hello **之前**(它得先读到旧缓存),但回帧**之后**才发:
        // advisory 面的一个发送失败点不许挡住这枚 Hello 的水位进引擎(codex 审 M4)。
        // 中转腿不在时压根没有通告面可言(§2 单一权威路:只有经 deliver 到达的才算),
        // 故 `Down` 形直接没有这段——不是忘了,是那条路上没有这件事。
        let directed = to == self.cfg.device_id;
        let ad_outs = match &msg {
            Msg::Hello { lan: Some(ad), .. } => {
                let ad = ad.clone();
                match self.ad() {
                    None => vec![],
                    Some(mut face) => face.absorb_lan_ad(from, &ad, ingress, directed),
                }
            }
            _ => vec![],
        };
        // 追赶分批(§8 锁序):大 ops 帧拆 ≤100 条子帧,批间放锁不饿死 UI 命令。
        // 合法帧的连续切片仍是合法帧(升序性质保持),校验语义不变。
        let batches: Vec<Msg> = match msg {
            Msg::Ops { origin, ops } if ops.len() > OPS_LOCK_BATCH => ops
                .chunks(OPS_LOCK_BATCH)
                .map(|c| Msg::Ops { origin: origin.clone(), ops: c.to_vec() })
                .collect(),
            m => vec![m],
        };
        let mut changed = false;
        // 出错也要走完出口那几件(实现审三轮 H1 + 四轮 M1),故把第一枚 Err 扣到最后:
        // 前面几批可能已经落地了,`Changed` 与状态快照是它们唯一的通知,被 `?` 跳过就
        // 得等下一次偶然的刷新。
        let mut fault: Result<(), String> = Ok(());
        for m in batches {
            changed |= matches!(&m, Msg::Ops { .. })
                || matches!(&m, Msg::BlobChunk { last: true, .. });
            // 输出交由**调用方**持有(实现审三轮 H1):这枚子批处理到一半的本地故障,
            // 不该带走它此前已经**做成**的那些事的通知(隔离行已落表、槽已驱逐、翻案已
            // 落库)。故先投出去,再让那枚 Err 收场。
            let mut outs = vec![];
            let done = {
                let mut conn = self.db.lock().expect("db mutex poisoned");
                let mut clk = self.clock.lock().expect("clock mutex poisoned");
                self.slot
                    .get()
                    .expect("booting 已在 on_wire 挡掉")
                    .on_msg(&mut conn, &mut clk, from, route, m, &mut outs)
            };
            let sent = self.dispatch(outs).await;
            // 引擎的本地故障优先报(投递失败常只是它的后果),与改前同序。
            if let Err(e) = done.and(sent) {
                fault = Err(e);
                break;
            }
        }
        // 这枚 Hello 的水位已进引擎,通告回帧现在才上线(顺序即上一段那条契约)。
        let ad_sent = self.dispatch(ad_outs).await;
        if changed {
            let _ = self.events.send(SyncEvent::Changed);
        }
        // 引擎内存态照进状态快照(挂起数/冻结清单/隔离与 breaker;set_status 内容
        // 不变不发事件)。
        let (suspended, mut frozen, poison) = {
            let e = self.slot.peek().expect("上面刚用过");
            (e.suspended_count(), e.frozen.keys().cloned().collect::<Vec<_>>(), e.poison_status())
        };
        frozen.sort();
        self.set_status(|s| {
            s.suspended = suspended;
            s.frozen = frozen;
            s.quarantined = poison.0;
            s.poison_breaker = poison.1;
        });
        fault?;
        ad_sent?;
        Ok(())
    }

    // ---- 出帧:§5 选路 ----------------------------------------------------------------

    /// 引擎输出的**唯一投递口**。
    ///
    /// 用工作队列而不是递归:入队失败要当场断链并通报引擎,而通报本身又产出帧(「回清单
    /// 必配重问」,§6)。终止性 = 每次投递失败都**单调地少掉一条 lan 腿**——要么摘掉一条
    /// 链路对象(`Failed`,链路数有硬上界 [`LAN_LINKS_MAX`]),要么从路由表抹掉那条腿
    /// (`NoLink`,H2);两者本轮都不会被加回(建链只经 [`Deck::lan_adopt`]),故队列必空。
    /// 供流([`Output::ServeBlob`])走同一条论证:它只在 lan 腿失败时产出帧,而那正是
    /// 「少掉一条腿」的那一步。
    /// 隔离重验的**续做一拍**(L-d‴ 实现审 H1/H2):有余量才动库,每拍至多放一批。
    ///
    /// 为什么挂心跳而不是 `on_msg` 出口:① 心跳是**恒在**的时间轴(不变量 6:断 WAN 也
    /// 照跳),而 `on_msg` 要有人发帧才来——一批全是 `InvalidOp` 时连 want 都不产,链路
    /// 稳定就再没有下一枚帧;② `Deck::feed` 会把 >`OPS_LOCK_BATCH` 的 ops 帧切成子批
    /// **逐批**喂进 `on_msg`,挂那儿等于「每枚线帧最多五批」,预算白封;③ 续做的 `?`
    /// 会连坐吞掉那枚帧自己已经处理成功的输出。
    ///
    /// 锁序照 §8 契约(先 db 后 clock),与 [`Deck::feed`] 同款;取完即放,不跨 await。
    pub(super) fn reverify_tick(&mut self) -> Vec<Output> {
        // 门槛问的是「还有活吗」:除了 SQL 侧的余量,还含「行已放出表、drain 却欠着」
        // 那笔债(实现审三轮 H2)——两者为何一位就够,论证在 `needs_reverify_tick`。
        if !self.slot.get().is_some_and(|e| e.needs_reverify_tick()) {
            return vec![];
        }
        let mut out = vec![];
        let done = {
            let mut conn = self.db.lock().expect("db mutex poisoned");
            let mut clk = self.clock.lock().expect("clock mutex poisoned");
            self.slot
                .get()
                .expect("上面刚查过在场")
                .reverify_quarantined(&mut conn, &mut clk, &mut out)
        };
        // **失败只进 advisory 槽,绝不左右心跳的主职责**(实现审二轮 H2):一个可复现的
        // 重验错误若能把这一拍的返回值染成 Err,`on_tick` 已产出的重问帧会被丢掉、
        // `lan_beat` 更是永远轮不到 —— LAN 的 Ping 与 90s 静默判死一起停摆,而那是
        // 不变量 6 明说「断 WAN 也不许停」的东西。隔离表的维护失败不配掐心跳。
        // 已提交的义务(驱逐 want / 恢复 want / 已放行行的追帧 want)由 `out` 带出去:
        // 引擎那侧改成写调用方的缓冲,故 Err 也不丢它们(同轮 H1)。
        if let Err(e) = done {
            self.set_status(|s| s.error = Some(format!("隔离重验失败(下一拍重试):{e}")));
        }
        out
    }

    /// **对账控制帧重发债的续做一拍**(§6.1 九轮 H1 的第三件;L-d″ 第④笔下半)。
    ///
    /// 债的三件必须同一提交上齐(§6.1 十轮),这是消费的那一件:`busy` 掉的那枚 Hello /
    /// ops Want **没有任何别的重发轴** —— Hello 不周期发送,`Engine::on_tick` 里只有图侧
    /// 的续问。故把它挂到**恒在的心跳**上,与 `reverify_tick` 同一条论证。
    ///
    /// **重发的是一枚广播 Hello,不是把原帧存下来重放**:①水位图现构造才是最新的(存下来
    /// 的那份一旦过期,重放反而把对端的水位往回带);②ops Want **可折叠进这枚 Hello** ——
    /// 缺席按 0 就足以让持有高水位的对端重新建立 Range/Reconcile,不必单独重发 Want。
    ///
    /// ⚠ **构造走 [`Engine::make_hello`] 这个既有的唯一出口**,本笔**不新增任何
    /// `watermarks()` 调用点**(§6.2 ⑨-5「④ 不能自己另造一条全表 Hello」)。第⑤笔把
    /// 那个出口换成有界形之后,这一拍**自动**跟着变有界——两笔在这里交界的方式就是
    /// 「复用同一处」,而不是各造一份再想办法对齐。
    ///
    /// **债不在这里清**:只有它的 Ack 才清(§6.1 九轮 H1)。故服务器持续 busy 时,这一拍
    /// 每次心跳重发一枚,频率由心跳定 —— 有界,且不是热循环。
    pub(super) fn reconcile_tick(&mut self) -> Result<Vec<Output>, String> {
        if self.slot.reconcile_debt.is_none() || !self.relay_up() {
            return Ok(vec![]);
        }
        let Some(engine) = self.slot.peek() else { return Ok(vec![]) };
        let conn = self.db.lock().expect("db mutex poisoned");
        engine.make_hello(&conn, BROADCAST, Route::Relay)
    }

    pub(super) async fn dispatch(&mut self, outs: Vec<Output>) -> Result<(), String> {
        // 测试栅栏:见 [`arm_dispatch_barrier`]。生产构建里这两行根本不存在。
        #[cfg(test)]
        dispatch_barrier().await;
        let mut queue: VecDeque<Output> = outs.into();
        while let Some(o) = queue.pop_front() {
            match o {
                Output::Event(ev) => self.on_engine_event(ev),
                Output::Send { to, lane, route_hint, msg } => {
                    let more = self.send_out(&to, lane, route_hint, &msg).await?;
                    queue.extend(more);
                }
                Output::ServeBlob(serve) => {
                    let more = self.serve_blob(serve).await?;
                    queue.extend(more);
                }
                Output::ServeOps(serve) => {
                    let more = self.serve_ops(serve).await?;
                    queue.extend(more);
                }
            }
        }
        Ok(())
    }

    /// 一声 op 追赶的唤醒落到哪条腿上(§6.2 ② 的四分路由)。
    ///
    /// **描述符里一个游标、一枚 op 都没有**(见 [`OpsServe`]):该发什么由消费腿自己去问
    /// [`EngineSlot::ops`] 里那份计划。故这里只做一件事——把铃摇对地方。
    ///
    /// 定向那两支**绑产出那一刻的来路腿**(来路亲和,同 `BlobServe.route`):不查「此刻
    /// 还有哪些腿」,那是 [`Deck::ops_changed_tick`] 那条名单路的事。
    async fn serve_ops(&mut self, serve: OpsServe) -> Result<Vec<Output>, String> {
        match serve.to {
            OpsServeTo::Peer { device, route: Route::Lan } => {
                self.slot.lan.wake_ops(&device);
                Ok(vec![])
            }
            OpsServeTo::Peer { route: Route::Relay, .. } => self.relay_data_pump().await,
            OpsServeTo::Broadcast => self.broadcast_ops_pump().await,
        }
    }

    /// **本机 origin 那一格只摇当时的权威完成腿**(§6.2 ①):relay 会话在场 → 中转泵;
    /// 不在 → 离线泵乐观消费。
    ///
    /// **绝不同时摇两类**:补投是权威腿发帧时顺手 fan-out 的([`Deck::fan_out_broadcast`]),
    /// 不是第二个消费者。抢先提交的补投腿会让 BROADCAST 游标越过 relay,而稳定长会话里
    /// 没有任何事件会把它带回来。
    ///
    /// (定向 target 是另一套:两条腿各去争同一枚 per-target 在飞位,谁先武装谁做,输的那条
    /// 撞 `Occupied` 跳过 —— 见 [`Deck::ops_changed_tick`] 与 [`ops_serve::OpsWorks::yield_relay`]。)
    async fn broadcast_ops_pump(&mut self) -> Result<Vec<Output>, String> {
        if self.relay_up() {
            return self.relay_data_pump().await;
        }
        self.offline_broadcast_pump().await
    }

    /// **断网期本机 origin 的追赶**(§6.2 ①「relay 不在场时可乐观消费与提交」)。
    ///
    /// 为什么由协调者消费而不是让各条 LAN 写泵去抢:BROADCAST 的在飞位只有一枚,谁抢到谁
    /// 提交、游标随即前进 —— **别的对端那一帧就永远补不上了**(没有 per-leg frontier,
    /// §6.2 ① 的备选形正是因为要 per-leg 状态才被否掉)。放在协调者里,一枚帧封一次、
    /// 投给全部合格腿,与 [`Deck::fan_out_broadcast`]、`send_out` 的 `Auto` 臂逐字同形,
    /// 「谁算合格」仍只有 [`Engine::lan_backfill_peers`] 一个判据出口。
    ///
    /// **乐观提交**:LAN 没有回执,写成即提交(与 L-c2c 那条「断网期内存游标乐观推进」
    /// 同一条)。丢了的由中转恢复时的保守合并补回 —— 持久 `last_pushed` 一个字节都不动。
    ///
    /// 一次调用**至多一枚帧**:与两条泵同一条纪律,回合的检查点归调用它的那一处。
    async fn offline_broadcast_pump(&mut self) -> Result<Vec<Output>, String> {
        if self.relay_up() {
            return Ok(vec![]); // 权威腿在场:这条路不该被走到(两个调用点都已分流)。
        }
        // **一条合格腿都没有就一个字节都别取**:取了也没人收,而 `commit` 会照样推进游标,
        // 一趟自唤醒就能把整份计划空转掉。丢的不是数据(持久 `last_pushed` 没动,中转恢复
        // 时的保守合并会把 `[acked+1, max]` 整个加回来),但那是白扫一遍库。
        // 续做所有者 = 新链接入那一下(`lan_adopt` 摇 `ops_changed`)。
        if self.slot.peek().is_none_or(|e| e.lan_backfill_peers().is_empty()) {
            return Ok(vec![]);
        }
        let ctx = self.serve_ctx();
        let (frame, ticket) = match ops_prepare(&ctx, BROADCAST) {
            // 换代 / 没活 / 别人占着 / 空转:都不出帧。空转的游标已在临界区里提交过。
            OpsTurn::Recast | OpsTurn::Idle | OpsTurn::Occupied | OpsTurn::Spun => {
                return Ok(vec![])
            }
            OpsTurn::Failed(why) => return Err(format!("ops 供流取数失败:{why}")),
            OpsTurn::Frame(frame, ticket) => (frame, ticket),
        };
        p305!(
            "offline_send origin={} seqs={}..{}({})",
            &frame.origin[frame.origin.len().saturating_sub(6)..],
            frame.ops.first().expect("取数产出的帧恒非空").origin_seq,
            frame.ops.last().expect("取数产出的帧恒非空").origin_seq,
            frame.ops.len()
        );
        let msg = Msg::Ops { origin: frame.origin, ops: frame.ops };
        let FanOut { mut back, delivered } = self.fan_out_broadcast(&msg);
        p305!("offline_send delivered={delivered} 条腿");
        if delivered == 0 {
            // **一条腿都没投出去:游标一步不许进**(codex 实现审一轮 M)。断网期这条腿自己
            // 就是权威,没有别人在等 Ack —— 照 relay 那套「旁腿失败不回滚」搬过来,那一段
            // 就从内存游标上过去了。三种成因(封不出帧 / 合格腿刚好全断 / 全部入队失败)
            // 处置相同:work 原样留着,等新链接入或下一拍心跳。
            //
            // **静默交回**(不摇铃):摇了就是「取帧 → 投不出 → 交回 → 摇铃 → 再取同一段」
            // 的热循环,与中转腿 Nack 那条同族。
            ticket.rollback_quiet()?;
            self.set_status(|s| {
                s.lan_warning =
                    Some("断网期的本机新增内容一条直连腿都没投出去(已保留,等新链)".into())
            });
            back.shrink_to_fit();
            return Ok(back);
        }
        // **投完才提交**(同两条泵):投不出去时凭据不推进游标,下一次唤醒取到的还是同一段。
        //
        // 续做那一声**就在这句里**:`commit` 走 [`OpsTicket::settle`],占→空当场摇 —— 断网期
        // 没有回执来驱动下一枚,全靠它接力。这里**刻意不再补一句** `notify_one()`:铃是边沿
        // 合并器只留一枚存量,补的那句一个字节的差别都做不出来,而它会伪装成一道独立的防护
        // (变异对照里正是这么露的馅:拆掉它 13 条里没有一条变红)。
        ticket.commit()?;
        back.shrink_to_fit();
        Ok(back)
    }

    /// 心跳的 ops 面(§6.2 ⑥)。照 [`Deck::reverify_tick`] 的成例挂**现有**心跳的两个调用点
    /// (会话内那一臂 + 离线泵),**不新增 select 臂**(§6.1 实现期硬约束 2)。
    ///
    /// 两件:①本机 origin 的追赶每拍从持久事实重新派生(撞过 `Overload` 的那次登记只有这里
    /// 补得回来);②冷却到点把义务提成可跑工作、收回上一拍给直连的让位,随后由
    /// [`Deck::ops_changed_tick`] 那一趟统一选腿。
    ///
    /// **`on_tick` 不再交精确名单**(codex 实现审二轮 L1):`busy` 释放窗口之后仍 runnable
    /// 的、中转腿刚断而描述符当初绑的是 relay 的,那份名单**一个都不报**(它只报 false→true
    /// 的边沿),而它们的续做所有者只剩这一拍;`idle_runnable_targets()` 是它的超集,差集只有
    /// 「在飞位占着」那一档 —— 摇了也只拿得到 `Occupied`。故不是两趟,是一趟更宽的。
    ///
    /// **输出不蒸发**(§6.2 ③″ 第 4 条):引擎那半即使返回 `Err`,已经写进缓冲的描述符与
    /// advisory 也先发出去,再让错误收场。
    pub(super) async fn ops_tick(&mut self) -> Result<(), String> {
        // **收回上一拍给直连的让位:排在最前,不许挂在下面任何一件的成败上**(二轮 H)。
        // 引擎那半前面隔着 `outbound` 的 `?`,搭在它后面的话一次读库失败就能让让位跨过
        // 好几拍(「已提交的义务不许随 `?` 蒸发」,268 那条);也必须早于下面那趟 sweep,
        // 否则没有直连腿时中转要多等一整拍才重试。
        lock_ops(&self.slot.ops).clear_relay_yields();
        let mut outs = vec![];
        let ticked = {
            let conn = self.db.lock().expect("db mutex poisoned");
            match self.slot.get() {
                None => Ok(()),
                Some(e) => e.ops_tick(&conn, &mut outs),
            }
        };
        let sent = self.dispatch(outs).await;
        ticked.and(sent)?;
        self.ops_changed_tick().await
    }

    /// **有腿交回了在飞位**(§6.2 ④′):扫出此刻「有活 ∧ 在飞位空」的 target,摇直连的铃,
    /// 再跑**一次**全局数据泵。
    ///
    /// **一趟至多一次全局泵**(codex 实现审二轮 M)。上一版是「逐 target 调一个
    /// 已撤掉的 `wake_ops_target`」,而它在中转在场时每次都进一趟全局
    /// [`Deck::relay_data_pump`] —— 64 个 target × 每趟跑满 K=8 回合 = 一拍最坏约 512 次
    /// 取数,`pump_ops` 在 K 处留的那枚 permit 拦不住**当前这趟 sweep 继续调下一轮泵**。
    /// 不会重复占窗、也不会多翻 ops/blob 的 1:1(窗口一占,后续全早返回),但 K 那条
    /// 「跑 8 次就交回协调者」的延迟与公平上界被整个打掉了。
    ///
    /// 拆法:**逐 target 的那一半只摇 LAN 铃**(不摸库、不 await),**全局泵这一半整趟只跑
    /// 一次**。中转腿本就按自己的 round-robin 选 target,逐个摇它没有任何额外信息。
    ///
    /// 三条纪律照旧:
    /// * **在 work 锁内最多扫 [`ops_serve::OPS_TARGET_MAX`] 项、只复制名单**;
    /// * **放掉 work 锁之后**才查路由、摇 relay / LAN 铃(守住「持 work 时不得再取
    ///   db/clock/status/lan」);
    /// * **不自旋**:这里不做「扫完还有活就再 notify」。窗口占用期间那样做会热循环——
    ///   真正能解除条件的那枚 Ack 反倒要跟热循环抢协调者。续做所有者按情形各有其人
    ///   (relay 窗口 = Ack/Nack/session-down;per-target 在飞位 = 那枚凭据的交回;
    ///   K 到限 = [`Deck::pump_ops`] 自己留的那枚 permit)。
    ///
    /// **中转在场时无条件泵一次**(哪怕名单是空的):心跳那根「`busy` 释放窗口后保留 work、
    /// 等下一拍重泵」的恒在续做轴就是靠这一句 —— 二轮 M 把它与本趟合并成唯一一次之后,
    /// 有条件跑就会把图字节那半的续做一起漏掉(ops 名单空 ≠ blob 待办空)。
    pub(super) async fn ops_changed_tick(&mut self) -> Result<(), String> {
        let targets = lock_ops(&self.slot.ops).idle_runnable_targets();
        // ① 定向 target:摇它那条直连腿。**BROADCAST 不摇**(§6.2 ①:本机 origin 只许权威
        //    完成腿消费,补投是权威腿发帧时顺手 fan-out 的,不是第二个消费者)。
        let mut broadcast = false;
        for target in &targets {
            if target == BROADCAST {
                broadcast = true;
                continue;
            }
            self.slot.lan.wake_ops(target);
        }
        // ② 全局数据泵:整趟一次。中转在场 = 权威完成腿是它;不在场时本机 origin 那一格
        //    改由离线泵乐观消费(定向的那些上面已经摇过直连了,这里没有第二件事可做)。
        let outs = if self.relay_up() {
            self.relay_data_pump().await?
        } else if broadcast {
            self.offline_broadcast_pump().await?
        } else {
            vec![]
        };
        self.dispatch(outs).await
    }

    /// 一笔图字节供流落到哪条腿上(§10 C′)。**两条腿两种形,但都不物化整图**:
    ///
    /// * `Lan` —— 非阻塞把描述符交给**创建时那条具体链路**,块由该链写泵自己逐块产出,
    ///   协调者当场返回。这正是 263 那个 bug 的修法:整图 128 枚帧一次性入队才会撞每链
    ///   8 MiB 上界、断链、然后重拨重死循环。
    /// * `Relay` —— 协调者内逐块取数直发。中转腿的 `send_relay().await` 本就占着协调者
    ///   (§5「两路发送无共享阻塞点」的正确读法 = **可选的 LAN 腿**不许拖住中转,中转
    ///   主路自身的 await 照旧),故这里同步走完与改动前同形;变的只是「一块一读」取代
    ///   「整图物化 + 128 枚 Output」,峰值内存从 ~64 MiB 降到 256 KiB(顺带把 §10
    ///   记的「中转路供流分批」同轮对齐了)。
    async fn serve_blob(&mut self, serve: BlobServe) -> Result<Vec<Output>, String> {
        match serve.route {
            Route::Lan => {
                let to = serve.to.clone();
                Ok(match self.slot.lan.enqueue_serve(&to, serve) {
                    Ok(()) => vec![],
                    Err(e) => self.on_lan_send_failed(&to, e),
                })
            }
            Route::Relay => self.serve_blob_relay(serve).await,
        }
    }

    /// 中转腿上的供流**入队**(L-d″ 第④笔;这里原本是一个跑完整图的 `for` 循环)。
    ///
    /// **为什么拆掉那个循环**(§6.1 五轮 Q5,263 真机字据):一张 32 MiB 的图 = 128 枚
    /// `send_relay().await` 全在协调者栈上跑完,其间 Ack/Nack 处理不了、runtime 心跳跑
    /// 不了、LAN 链路的 `last_rx` 也刷不了 —— 下一次 `lan_beat` 就按 90s 把**健康的**
    /// 直连链整批判死。一次调用的产出量由图的大小说了算,正是「工作量由数据规模说了算
    /// = 缺一道常量闸」。
    ///
    /// 现在:入队 → 泵一块 → 立刻回协调者,后续块由回执驱动
    /// (见 [`Deck::relay_data_pump`])。
    async fn serve_blob_relay(&mut self, serve: BlobServe) -> Result<Vec<Output>, String> {
        if !self.relay_up() {
            // 同「`Require(Relay)` 送不出」那条:引擎此刻已知道会话断了,丢的由重连时的
            // 会话仪式补齐(收端那边会 stale 换来源)。
            let text = format!("发往 {} 的图字节供流钉了中转,但会话不在(已丢弃)", serve.to);
            self.set_status(|s| s.lan_warning = Some(text));
            return Ok(vec![]);
        }
        let to = serve.to.clone();
        let (image_id, transfer) = (serve.image_id.clone(), serve.transfer.clone());
        if !self.slot.relay_data.enqueue(BlobJob { serve, next_idx: 0 }) {
            // 满额 fail-closed:沿同 transfer 回一枚 deny,收端据此回清单另寻来源——不
            // 静默丢(那会让它干等到 stale)。**这枚 deny 不占数据窗口**:它没有后续块,
            // 走普通 direct 路,故它的回执也不该去释放别人的窗口。
            self.set_status(|s| {
                s.lan_warning = Some(format!(
                    "中转待发供流已满({RELAY_SERVE_QUEUE} 笔),拒了 {to} 的取图"
                ))
            });
            return Ok(vec![Output::Send {
                to,
                lane: Lane::Direct,
                route_hint: RouteHint::Require(Route::Relay),
                msg: Msg::BlobDeny { image_id, transfer },
            }]);
        }
        self.relay_data_pump().await
    }

    /// **中转全局数据窗口的泵**(§6.2 ① 的归宿形 (C)):窗口空 ∧ 待办非空 → 备**一枚**
    /// 数据帧发出去、占住窗口,**随即返回协调者**——不在一次调用里循环。
    ///
    /// 三个调用点共一条恒在轴:①新描述符入队后;②回执释放窗口后;③**心跳**。第三个
    /// 不是冗余:`busy` 那一格明写「释放窗口、保留 work、等心跳重试」,少了它,那笔 work
    /// 就只能等下一次偶然的新 pull——「靠一个信号触发,而信号可能不来」的同族。
    ///
    /// **轮转出队**(队首取、发完回队尾,见 [`RelayData::requeue`])**不是为了公平好看,
    /// 是活性必需**:收端那笔 `Pull` 有 `PULL_STALE_TICKS` = 2 拍(60s)的无进展死线,
    /// 若让一张 128 块的图独占窗口跑到底,排在它后面那台对端的拉流会**先被对端自己判死**,
    /// 然后回清单重问——白跑一整轮。**队首优先在快链上也照样让队尾饿死**,轮转不会。
    ///
    /// ⚠ **但它不是无条件成立的结构证明**(codex 实现审 M2 纠了我把算式当证明):这里是
    /// 全局 stop-and-wait,N 笔并发时每笔约每 **N 个中转往返**才拿到一块,故要人人守住
    /// 「每 60s 至少一块」就得有
    ///
    /// > 有效吞吐 > `N × 256 KiB / 60s`  —— N=16 时 ≈ **68 KiB/s(0.56 Mbit/s)**,
    /// > N=3 时 ≈ 13 KiB/s,N=2 时 ≈ 8.5 KiB/s。
    ///
    /// **低于该值时轮转反而更差**:16 笔各约 67s 才得一块 → 全体 stale、一笔都完不成,
    /// 而串行至少能一笔一笔做完。**这是明示的承载假设,不是被证明的性质**。
    ///
    /// 准确的一句话(codex 实现审二轮 L1 纠了我上一版的自相矛盾 —— 我一边写「低速零完成」
    /// 一边写「没造出新失败模式」):**轮转改善的是承载假设成立时的多 peer 活性;低于承载线
    /// 会引入已知的「零完成」过载退化,本版明确接受,过载调度另排**(§12.1)。
    ///
    /// 接受它的理由:①每台设备的收端窗口是 1 笔(engine 的 `MAX_ACTIVE_PULLS`),故 N ≤
    /// 席位数,而真实拓扑是 2-3 台同时取图 → 门槛降到 0.07–0.11 Mbit/s;②那条 60s 线本就是
    /// 收端「这个来源太慢,换一个」的设计动作(`fail_pull` → shun → rewant),故退化区里
    /// 系统仍在做它设计好的事,只是没人能从**本机**取成。**过载调度(维持不住全体最低进度
    /// 时收敛到少数几笔)是新机制、要动设计,不在本笔切。**
    ///
    /// 一次调用的产出有常量上界:待办 ≤ [`RELAY_SERVE_QUEUE`] 笔(见
    /// [`RelayData::peers_with_work`]),循环至多把它们各弹一次,故**至多 16 枚帧**——
    /// 要么全是 deny(行没了那一路不占窗口,可以接着取下一笔),要么若干枚 deny 加末尾
    /// 那 **1** 枚数据帧。加上 ops 那条腿之后**这个数不变**:它至多 [`OPS_TURNS_PER_CHECKPOINT`]
    /// 个回合、至多产 1 枚数据帧(且那一枚一出来两条腿都收工),故一次调用仍是
    /// 「≤16 枚 deny + ≤1 枚数据帧」,只是摸库次数多了 ≤8 次(每次 ≤64 个索引探针)。
    ///
    /// **两类数据按 1:1 轮转**(第④笔下半;§6.1 M3):上一件归谁,这一件就先问另一类;
    /// **那一类此刻没活就当场让给另一类,绝不空等**(`busy` 掉的那一类同理——它的 work
    /// 留着等心跳,不阻塞另一类)。一次调用仍**至多占上一枚窗口**。
    pub(super) async fn relay_data_pump(&mut self) -> Result<Vec<Output>, String> {
        if !self.relay_up() || self.slot.relay_data.inflight.is_some() {
            return Ok(vec![]);
        }
        let mut back = vec![];
        // 1:1 的落地形:先问上一件的**另一类**。两个 `?` 里任一 `Armed` 都直接收工——
        // 窗口只有一枚。
        let ops_first = !self.slot.relay_data.last_was_ops;
        let first = if ops_first {
            self.pump_ops(&mut back).await?
        } else {
            self.pump_blob(&mut back).await?
        };
        let turn = match first {
            PumpTurn::Armed | PumpTurn::Recast => first,
            // 这一类没活:当场把机会让给另一类(**不空等**)。
            PumpTurn::NoWork => {
                if ops_first {
                    self.pump_blob(&mut back).await?
                } else {
                    self.pump_ops(&mut back).await?
                }
            }
        };
        if matches!(turn, PumpTurn::Recast) {
            // 换代了就一枚都不发,**连已攒的 deny 也丢**——它们会被旧 K_acc 封上线,与
            // [`session_wrapup`] 那条「落闸就不投」同一条纪律。
            return Ok(vec![]);
        }
        Ok(back)
    }

    /// ops 那条腿的一回合:**按 target 轮转**取一枚帧(§6.2 ⑨-4 的六条规则 + 规则⑦ 的
    /// K 检查点)。
    ///
    /// 规则落地处一一对应:
    /// * ①**帧/回合边界 round-robin**、②**BROADCAST 与定向同级**——候选名单由
    ///   [`ops_serve::OpsWorks::runnable_after`] 按 target 字典序绕圈给出,BROADCAST 只是
    ///   其中一个键,没有特权;
    /// * ③遇 `Occupied` **跳到下一个 target**,不让整枚窗口睡下;
    /// * ④单次扫描 ≤ [`ops_serve::OPS_TARGET_MAX`](表本身的上界)且取回 ≤ K 项;
    /// * ⑤各种结果下游标**一律前移**到最后检查过的那一项(不前移就每轮从表头偏置);
    /// * ⑥Ack/Nack 释放窗口后从**下一个** target 继续(游标停在刚发过那个,`runnable_after`
    ///   是「严格大于」);
    /// * ⑦**K = [`OPS_TURNS_PER_CHECKPOINT`]**:**每次真正进入 `prepare_next` 都计一次**
    ///   (`Frame`/`Spun`/`Occupied`/`Idle` 一律计),连续不出帧到 K 就停、回协调者形成
    ///   真实的公平检查点 —— **续做所有者是心跳那一拍**(第⑤笔上线 `ops_changed` 之后
    ///   改由释放方摇铃,§6.2 ④′)。
    ///
    /// **`Spun` 照样消耗一个回合**:它没往线上放一个字节,却实实在在摸了一次库(单次
    /// 至多跳 64 个已齐 origin ≈ 5 ms 持锁)。按帧记的话,一串长空转能把协调者钉住。
    ///
    /// **候选逐回合现取,不是先抓一张名单**:每跑完一回合状态就变了(游标进了 / 那份 work
    /// 空了 / 别的腿武装了它),照老名单接着跑就是拿过期事实做决策;而只有一个 runnable
    /// target 时,「名单长度」还会把 K 悄悄压成 1 —— 一份长计划就要每拍才走一格。
    pub(super) async fn pump_ops(&mut self, back: &mut Vec<Output>) -> Result<PumpTurn, String> {
        let ctx = self.serve_ctx();
        for _ in 0..OPS_TURNS_PER_CHECKPOINT {
            let after = self.slot.relay_data.ops_rr.clone();
            let next = lock_ops(&self.slot.ops).next_runnable_after(after.as_deref());
            let Some(target) = next else { return Ok(PumpTurn::NoWork) };
            // 游标**先于取数**前移:无论这一回合的结果是什么,下一回合都得从它的下一个起
            // (规则⑤)。放在结果分支里写的话,`Frame` 那条早返回会把前移漏掉。
            self.slot.relay_data.ops_rr = Some(target.clone());
            match ops_prepare(&ctx, &target) {
                // 换代:一枚都不发(与 blob 那半同一条纪律)。
                OpsTurn::Recast => return Ok(PumpTurn::Recast),
                // 名单一放锁就可能过期(另一条腿在这中间武装了它 / 它的活被别人做完了):
                // 跳到下一个 target,**不让整枚窗口睡下**。
                OpsTurn::Idle | OpsTurn::Occupied => continue,
                // 空转:游标已在同一临界区里提交过,这一回合没有字节要写。
                OpsTurn::Spun => continue,
                // 取数或提交真出错 = 本机故障:**响亮收场**(与 LAN 那条腿同一条纪律,
                // 只是这边的「收场」是断本条中转会话)。
                OpsTurn::Failed(why) => return Err(format!("ops 供流取数失败:{why}")),
                OpsTurn::Frame(frame, ticket) => {
                    // 本机 origin 的那一帧要驱动持久 `last_pushed`(§6.2 ⑨-1),故序号在
                    // 发之前就绑进 `Sent`;非本机 origin 恒 `None`。
                    let own_max_seq = (frame.origin == self.cfg.device_id).then(|| {
                        frame.ops.last().expect("取数产出的帧恒非空").origin_seq
                    });
                    p305!(
                        "relay_send target={target} origin={} seqs={}..{}({}) own_max_seq={own_max_seq:?}",
                        &frame.origin[frame.origin.len().saturating_sub(6)..],
                        frame.ops.first().expect("取数产出的帧恒非空").origin_seq,
                        frame.ops.last().expect("取数产出的帧恒非空").origin_seq,
                        frame.ops.len()
                    );
                    let msg = Msg::Ops { origin: frame.origin, ops: frame.ops };
                    self.send_relay_ops(OpsJob { own_max_seq, ticket }, &msg).await?;
                    // **BROADCAST 的 LAN 补投就在这一处**(§6.2 ① 的 (C)):权威腿发完
                    // 顺手 fan-out,与 `send_out` 的 `Auto` 臂逐字同形。定向 target 不补投
                    // ——它此刻走中转正是因为那条腿在,补投面只服务「relay 腿不在」的对端。
                    if target == BROADCAST {
                        // `delivered` 在这条腿上**明确不看**(§6.2 ①(C)):权威帧已经在
                        // 窗口里等 relay 的 Ack,补投腿一条都没成也不许回滚那枚 ticket。
                        back.extend(self.fan_out_broadcast(&msg).back);
                    }
                    return Ok(PumpTurn::Armed);
                }
            }
        }
        // **K 到限:自留一枚续做 permit**(§6.2 ④′「三件」之二)。跑到这里 = 连着 K 个回合
        // 都没出帧,但表里可能还有可尝试项 —— 回协调者形成真实的公平检查点之后,得有人把
        // 我们叫回来。第④笔那版的续做所有者是心跳那一拍(30s 量级的**兜底**,不是唤醒
        // 机制),第⑤笔起由这枚 permit 接手。
        //
        // 这不是 ④′-6 禁的那种「扫完还有活就自唤醒」热循环:那条禁的是**窗口占用期间**为
        // 领不到的 work 反复摇铃;这里窗口恰恰是空的(一枚都没武装成),permit 醒来后的
        // 那一趟扫描要么真领到活、要么扫出空名单就此打住,不会自己再摇。
        self.slot.ops_changed.notify_one();
        Ok(PumpTurn::NoWork)
    }

    /// 权威 relay 帧发出之后的 LAN 补投(§6.2 ① 的 (C) 与二轮 M5 的失败语义)。
    ///
    /// **失败绝不回滚权威 ticket**:补投腿入队失败 = 摘该腿 + 更新路由 + advisory(走
    /// [`Deck::push_lan`] 那条与本链失败**完全相同**的收口),而那一枚 relay 帧的成败
    /// 只由它自己的 Ack/Nack 说了算。结构上也保证得了:凭据此刻已经在窗口里,这个函数
    /// 根本碰不到它。
    fn fan_out_broadcast(&mut self, msg: &Msg) -> FanOut {
        let targets = self.slot.peek().map(Engine::lan_backfill_peers).unwrap_or_default();
        if targets.is_empty() {
            return FanOut { back: vec![], delivered: 0 };
        }
        // 封不出来 = 本机的问题(身份/编码),**一条腿都没投出去**。调用方据 delivered=0
        // 决定去留,这里不静默当成「投完了」。
        let Some(bytes) = self.seal_for_lan(BROADCAST, msg) else {
            return FanOut { back: vec![], delivered: 0 };
        };
        let (mut back, mut delivered) = (Vec::new(), 0usize);
        for peer in targets {
            // 两格各取各的:收口帧照旧攒进 `back`(旁链被摘也在里面),成败单记一格。
            let LanPush { outs, ok } = self.push_lan(&peer, &bytes);
            back.extend(outs);
            delivered += usize::from(ok);
        }
        FanOut { back, delivered }
    }

    /// blob 那条腿的一回合(第④笔上半的原泵体,拆成两类之后独立成函数)。
    async fn pump_blob(&mut self, back: &mut Vec<Output>) -> Result<PumpTurn, String> {
        while let Some(job) = self.slot.relay_data.pending.pop_front() {
            let idx = job.next_idx;
            // **自证身份 + 取数,同一把锁里办完**,与 LAN 写泵同口径(§6 ⑤;C′ 实现审
            // 二轮 M)。拆了循环之后单次持锁只剩一块,但这道闸照留:两次取锁之间仍有
            // 「查完身份、换代提交、再读块」那个窄窗,而块是拿 `self.cfg` 封的。
            let read = {
                let conn = self.db.lock().expect("db mutex poisoned");
                if !identity_still_current_conn(
                    &conn,
                    &self.cfg.account_id,
                    &self.cfg.device_id,
                    &self.cfg.k_acc,
                    &self.cfg.device_seed,
                ) {
                    // 换代了就一枚都不发,连已攒的 deny 也丢(由调用方统一丢弃)——它们会被
                    // **旧 K_acc** 封上线,与 [`session_wrapup`] 那条「落闸就不投」同一条
                    // 纪律。收端等 stale 换来源,而会话本身随即被外层栅栏收掉。
                    return Ok(PumpTurn::Recast);
                }
                read_blob_chunk(&conn, &job.serve, idx)
            };
            let data = match read {
                Ok(Some(data)) => data,
                Ok(None) => {
                    back.push(blob_deny_out(&job.serve));
                    continue;
                }
                Err(e) => {
                    let image_id = job.serve.image_id.clone();
                    self.set_status(|s| {
                        s.error = Some(format!("读 {image_id} 的第 {idx} 块失败:{e}"))
                    });
                    back.push(blob_deny_out(&job.serve));
                    continue;
                }
            };
            let msg = Msg::BlobChunk {
                image_id: job.serve.image_id.clone(),
                transfer: job.serve.transfer.clone(),
                idx,
                last: job.serve.is_last(idx),
                data,
            };
            self.send_relay_blob(job, &msg).await?;
            return Ok(PumpTurn::Armed);
        }
        Ok(PumpTurn::NoWork)
    }

    /// **占窗口 + 封发,同一个函数体**(codex 实现审 L1)。
    ///
    /// 「发一枚标 `ServeBlob` 的帧」与「占住窗口」必须同生共死:分开写的话,类型上谁都
    /// 能只做其中一件,而回执到达时两边就对不上了。凭据在这里发号并同时进 `Sent`,故
    /// [`Ctx::relay_blob_acked`] / [`Ctx::on_nack`] 拿回执核号就是运行期的那道闸。
    ///
    /// **先占窗口再发帧**(同 268 那条「先置 breaker 再落行」):反过来排的话,「已发出但
    /// 窗口还没占」那一瞬里任何一个泵的调用点都会再备一枚,同刻两枚数据帧在飞 —— 那正是
    /// 这枚窗口存在的意义。发失败 = 会话必收场(`send_envelope` 的写失败一路穿透到
    /// `session`),窗口由 [`session_wrapup`] 清。
    pub(super) async fn send_relay_blob(&mut self, job: BlobJob, msg: &Msg) -> Result<(), String> {
        let to = job.serve.to.clone();
        let ticket = self.slot.relay_data.occupy_blob(job)?;
        self.send_relay_as(&to, Lane::Direct, msg, Some(Sent::ServeBlob { ticket, to: to.clone() }))
            .await
    }

    /// [`Deck::send_relay_blob`] 的 ops 形:**占窗口 + 封发同一个函数体**,理由逐字相同。
    ///
    /// 多出来的一件:`job` 里攥着 RAII 凭据,而 `occupy_ops` **把它移进窗口**——从此
    /// 「窗口被清」与「凭据被交回」是同一件事,不存在「窗口空了而在飞位还占着」的半态。
    /// 发失败 = 会话必收场,窗口由 [`session_wrapup`] 清,凭据随之 `Drop` 回滚。
    pub(super) async fn send_relay_ops(&mut self, job: OpsJob, msg: &Msg) -> Result<(), String> {
        let target = job.ticket.target().to_string();
        let own_max_seq = job.own_max_seq;
        let ticket = self.slot.relay_data.occupy_ops(job)?;
        let kind = Sent::ServeOps { ticket, target: target.clone(), own_max_seq };
        self.send_relay_as(&target, Lane::Mail, msg, Some(kind)).await
    }

    /// 一枚待发帧落到哪条腿上(§5,一处一义)。返回值 = 投递失败的收口帧(断链通报产出的
    /// 重问),由 [`Deck::dispatch`] 接着走。
    async fn send_out(
        &mut self,
        to: &str,
        lane: Lane,
        route_hint: RouteHint,
        msg: &Msg,
    ) -> Result<Vec<Output>, String> {
        match route_hint {
            // 钉死中转:带 lan 通告的权威 Hello 只许走鉴权路(§2 单一权威路)。
            RouteHint::Require(Route::Relay) => {
                if self.relay_up() {
                    self.send_relay(to, lane, msg).await?;
                } else {
                    // 中转不在 = 丢帧。引擎此刻已知道会话断了(`on_relay_session_down` 是
                    // 会话收场的第一手),不必再通报;丢的由重连时的会话仪式补齐。
                    let text = format!("发往 {to} 的帧钉了中转,但会话不在(已丢弃)");
                    self.set_status(|s| s.lan_warning = Some(text));
                }
                Ok(vec![])
            }
            // 来路亲和的应答 / blob transfer 绑定的那条腿(§5.1:绝不静默改路)。
            RouteHint::Require(Route::Lan) => {
                if to == BROADCAST {
                    // 引擎的出口改写跳过广播帧,故这形只可能是接线漂移。
                    self.set_status(|s| {
                        s.error = Some("内部错:广播帧要求走局域网直连(已丢弃)".into())
                    });
                    return Ok(vec![]);
                }
                let Some(bytes) = self.seal_for_lan(to, msg) else { return Ok(vec![]) };
                Ok(self.push_lan(to, &bytes).outs)
            }
            RouteHint::Auto => {
                // 主路:中转在线就走中转(不变量 1「默认只走中转,唯一副本路」)。
                if self.relay_up() {
                    self.send_relay(to, lane, msg).await?;
                }
                // 补投面(§5 例外③;本机中转离线时同一条规则自然涵盖「全部 mail 走 lan」)。
                // **只 mail**:direct 的帧恒钉路由(§6),Auto+direct 只可能是接线漂移。
                if lane != Lane::Mail {
                    if !self.relay_up() {
                        self.set_status(|s| {
                            s.error = Some(format!("内部错:发往 {to} 的 direct 帧没钉路由,而中转不在(已丢弃)"))
                        });
                    }
                    return Ok(vec![]);
                }
                let targets = match self.slot.peek() {
                    None => vec![],
                    Some(engine) if to == BROADCAST => engine.lan_backfill_peers(),
                    Some(engine) if engine.lan_backfill(to) => vec![to.to_string()],
                    Some(_) => vec![],
                };
                if targets.is_empty() {
                    return Ok(vec![]);
                }
                let Some(bytes) = self.seal_for_lan(to, msg) else { return Ok(vec![]) };
                let mut back = vec![];
                for peer in targets {
                    back.extend(self.push_lan(&peer, &bytes).outs);
                }
                Ok(back)
            }
        }
    }

    /// 封一枚要走 lan 腿的帧:**同一套密文帧,只换运输管子**(§0)——同 K_acc、同域子钥、
    /// 同 AAD 五元组,外面只多一层 [`lan::LanWire::Frame`] 供收端重构 AAD。故广播帧封一次
    /// 就能投给每条链(AAD 的 `to` 恒是信封上那个)。
    ///
    /// **绝不注入 lan 通告**(§2 单一权威路):收端只认经中转 deliver 到达的通告,往 lan
    /// 帧里塞是白费字节。`None` = 封不出(帧超 1 MiB;引擎的帧上界 256 KiB 使这只可能是
    /// 本机 bug)——响亮记一笔并丢,绝不发半帧。
    pub(super) fn seal_for_lan(&self, to: &str, msg: &Msg) -> Option<Arc<Vec<u8>>> {
        match seal_lan_frame(
            &self.cfg.k_acc,
            &self.cfg.account_id,
            &self.cfg.device_id,
            to,
            msg,
        ) {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                self.set_status(|s| s.error = Some(format!("内部错:局域网帧封不出({e})")));
                None
            }
        }
    }

    /// 往一条链路入队一枚已封好的帧。失败 = **断该链并通报引擎**(§5 故障隔离 +
    /// §6「`Require` 送不出必随即通报该路由 down」);返回的输出由调用方接着 dispatch
    /// (回清单的图当场重问)。
    pub(super) fn push_lan(&mut self, peer: &str, bytes: &Arc<Vec<u8>>) -> LanPush {
        let LanEnqueue { evicted, outcome } = self.slot.lan.enqueue(peer, bytes);
        let ok = outcome.is_ok();
        // 顺序刻意如此:**先把已经发生的破坏性动作交代掉**,再谈本次这一笔的成败。旁链
        // 走的是与本链失败**完全相同**的那条收口(路由 down + 状态面 + 重问),受害者不是
        // 收件人而已——分两处写迟早漂(与 `on_lan_send_failed` 合并帧/供流的道理相同)。
        let mut outs = vec![];
        for (victim, err) in evicted {
            outs.extend(self.on_lan_send_failed(&victim, err));
        }
        if let Err(e) = outcome {
            outs.extend(self.on_lan_send_failed(peer, e));
        }
        LanPush { outs, ok }
    }

    /// 投不出去的收口(帧与图字节供流**共用**:两者的失败面一模一样,分两处写迟早漂)。
    fn on_lan_send_failed(&mut self, peer: &str, err: LanSendErr) -> Vec<Output> {
        match err {
            LanSendErr::NoLink => {
                // 引擎以为有这条腿而链路集里没有 = **死腿**(移交半途失败 / 断链通报丢了 /
                // 补投目标刚好同刻断了)。**当场把它从路由表抹掉并重问**(实现审 H2):
                // 只记一句告警等于把这条腿留成永久黑洞——mail 没有 stale 定时器兜底,选路
                // 会一直往这条不存在的链路投。仍不静默改走中转(§5.1 禁「凭空走」),丢的
                // 那帧由重问/hello 互补自愈。
                let outs = self
                    .slot
                    .get()
                    .map(|e| e.on_lan_leg_missing(peer))
                    .unwrap_or_default();
                self.refresh_lan_status();
                let text = format!("发往 {peer} 的帧要求局域网直连,但本机没有该链路");
                self.set_status(|s| s.lan_warning = Some(text));
                outs
            }
            LanSendErr::Failed { generation, why } => {
                // 链路已由链路集摘掉(集合是它的),引擎跟着换态。
                let outs = self
                    .slot
                    .get()
                    .map(|e| e.on_lan_link_down(peer, generation))
                    .unwrap_or_default();
                self.refresh_lan_status();
                let text = format!("与 {peer} 的局域网直连已断:{why}");
                self.set_status(|s| s.lan_warning = Some(text));
                outs
            }
        }
    }

    fn on_engine_event(&mut self, ev: Event) {
        match ev {
            // 单槽覆盖即可:去重由 [`set_status`] 的「快照没变不发事件」给出(见
            // [`SyncStatus::ops_notice`])。**不弹 toast** —— 这两档是资源面的 advisory,
            // 不是要用户当场做点什么的事。
            Event::OpsNotice { text } => self.set_status(|s| s.ops_notice = Some(text)),
            Event::SpaceNameChanged => {
                let _ = self.events.send(SyncEvent::SpaceNameChanged);
            }
            Event::ImagesRenumbered { renumbered, content_rewritten } => {
                let list = renumbered
                    .iter()
                    .map(|(_, old, new)| format!("图{old}→图{new}"))
                    .collect::<Vec<_>>()
                    .join("、");
                let mut msg = format!("两台设备同时贴图,本机配图编号顺延:{list}");
                if content_rewritten {
                    msg.push_str("(正文引用已同步修正)");
                }
                self.toast(msg);
                let _ = self.events.send(SyncEvent::Changed);
            }
            Event::OriginFrozen { origin, reason } => {
                self.toast(format!("同步已冻结一台设备的历史(需人工处理):{reason}"));
                self.set_status(|s| {
                    if !s.frozen.contains(&origin) {
                        s.frozen.push(origin);
                        s.frozen.sort();
                    }
                    s.error = Some(reason);
                });
            }
            Event::OriginSuspended { origin, reason } => {
                // 挂起多是瞬态(依赖未到,落地即解);只进状态不弹提示。
                self.set_status(|s| {
                    s.error = Some(format!("部分同步暂挂(来源 {origin}):{reason}"));
                });
            }
            Event::OriginQuarantined { origin, relay_from, reason } => {
                // 持久隔离(毒 op,§4):常驻告警——双坐标都报(origin ≠ 必然的作恶
                // 发送者,吊谁由运营者判断),状态快照在 `Deck::feed` 里随引擎照进。
                self.toast(format!(
                    "已隔离一台设备的非法数据(来源 {origin},经 {relay_from} 投递):{reason}"
                ));
                self.set_status(|s| {
                    if !s.quarantined.contains(&origin) {
                        s.quarantined.push(origin);
                        s.quarantined.sort();
                    }
                    s.error = Some(reason);
                });
            }
            Event::PoisonBreakerTripped { reason } => {
                self.toast(format!(
                    "同步保护闸已闭合(拒收新设备数据,须人工处理后复位):{reason}"
                ));
                self.set_status(|s| s.poison_breaker = Some(reason));
            }
            Event::FrameRejected { from, reason } => {
                self.set_status(|s| s.error = Some(format!("拒收 {from} 的帧:{reason}")));
            }
            Event::ClockSkew { ahead_hours } => {
                if !self.slot.notices.clock_skew_toasted {
                    self.slot.notices.clock_skew_toasted = true;
                    self.toast(format!(
                        "检测到另一台设备的时间比本机快约 {ahead_hours} 小时,可能让它的编辑总是「胜出」;请检查两台设备的系统时间"
                    ));
                }
                self.set_status(|s| s.clock_skew = true);
            }
        }
    }

    /// 中转腿的封帧与发送。**通告注入点就在这里**(§2「注入点在传输层封帧前」):单点,
    /// 故「哪些 Hello 带通告」不必在各调用点重复判断——会话仪式的广播 Hello、收敛的定向回
    /// Hello、将来的补发,一律经此。
    async fn send_relay(&mut self, to: &str, lane: Lane, msg: &Msg) -> Result<(), String> {
        self.send_relay_as(to, lane, msg, None).await
    }

    /// [`Deck::send_relay`] 的**显式分类**形(L-d″ 第④笔)。`kind = Some(..)` 时不按
    /// `msg` 的形状猜属于哪一类已发信封——理由见 [`Sent::ServeBlob`]:同样是
    /// `Msg::BlobChunk`/`Msg::BlobDeny`,窗口泵发出的那一枚要驱动窗口,而引擎在
    /// `on_blob_pull` 里直接产的那枚一个窗口都没占过。
    async fn send_relay_as(
        &mut self,
        to: &str,
        lane: Lane,
        msg: &Msg,
        kind: Option<Sent>,
    ) -> Result<(), String> {
        let injected = match msg {
            Msg::Hello { watermarks, lan: None } => {
                let ad = self.ad().and_then(|mut face| face.local_lan_ad());
                Some(Msg::Hello { watermarks: watermarks.clone(), lan: ad })
            }
            // 引擎产出的 Hello 恒 `None`(engine.rs 单测锚着)。真带了 = 接线漂移:原样
            // 发出去会把一枚**没落库**的序号封上线(收端从此只认更大的),响亮记一笔、
            // 把通告摘掉再发——水位该到的照到。
            Msg::Hello { watermarks, lan: Some(_) } => {
                self.set_status(|s| {
                    s.error = Some("内部错:引擎产出的 Hello 带了局域网通告(已摘除)".into());
                });
                Some(Msg::Hello { watermarks: watermarks.clone(), lan: None })
            }
            _ => None,
        };
        let msg = injected.as_ref().unwrap_or(msg);
        let domain = msg_domain(msg);
        let blob = crypto::seal_msg(
            &self.cfg.k_acc,
            &FrameAddr {
                account_id: &self.cfg.account_id,
                from_device: &self.cfg.device_id,
                to,
                domain,
            },
            msg,
        );
        let kind = match kind {
            Some(k) => k,
            None => match msg {
                // **对账控制帧按形状认**(L-d″ 第④笔下半)。这与「`Sent` 的分类不许按
                // `msg` 形状猜」不矛盾:上半那条针对的是**同一形状两种窗口语义**(窗口泵发
                // 的 `BlobChunk` 要驱动窗口,引擎直接产的那枚一个窗口都没占过)。中转腿上的
                // Hello/Want 只有一种语义 —— 对账控制帧,`busy` 必须重试 —— 没有第二个
                // 语义相反的生产者。
                //
                // **但「谁能还债」不按形状放宽**(codex 实现审一轮 H1):只有**广播 Hello**
                // 还得动,因为债的内容就是「替所有对端重建一份水位图」,定向 Hello 只覆盖
                // 一台、Want 更不是。带的号是**发它这一刻**的债号,故一枚债挂上之前就构造好
                // 的 Hello 清不掉这笔新债。
                Msg::Hello { .. } if to == BROADCAST => {
                    Sent::ReconcileCtl { discharges: self.slot.reconcile_debt }
                }
                Msg::Hello { .. } | Msg::Want { .. } => Sent::ReconcileCtl { discharges: None },
                _ if lane == Lane::Direct => Sent::Direct { to: to.to_string() },
                _ => Sent::Other,
            },
        };
        let wire_lane = match lane {
            Lane::Mail => WireLane::Mail,
            Lane::Direct => WireLane::Direct,
        };
        self.send_envelope(to, wire_lane, blob, kind).await
    }

    pub(super) async fn send_envelope(
        &mut self,
        to: &str,
        lane: WireLane,
        blob: Vec<u8>,
        kind: Sent,
    ) -> Result<(), String> {
        let RelayLeg::Up { ws, sess } = &mut self.relay else {
            return Err("内部错:中转腿不在,发不出信封".into());
        };
        sess.n += 1;
        // **收件人在这里一处记下**(见 [`Tracked`]):回执要拿它去清 unknown 怀疑标,
        // 而「这一枚投给谁」是**发送入口**的事实,不是各 `Sent` 变体的可选装饰。
        let target = (to != BROADCAST).then(|| to.to_string());
        sess.tracked.insert(sess.n, Tracked { sent: kind, target });
        let n = sess.n;
        send_client(ws, &ClientMsg::Send { n, to: to.into(), lane, blob }).await
    }

    // ---- 局域网链路的四件事:移交 / 事件 / 心跳 / 断网期定向 Hello ---------------------

    /// 移交一条握手已完成的链路(§6 三条代次契约的落地点,**唯一入口**——四步的顺序在
    /// 这个函数里,没有「调用方记得先通报再入表」的空间):
    ///   ① 仲裁与容量在**改动任何状态之前**判(败者/超额者直接关掉,引擎压根不知道);
    ///   ② `on_lan_link_up` **先**通报引擎(它据此换代、作废旧代在飞 transfer);
    ///   ③ 新链**才**进发送表(此后入队即绑这个对象);
    ///   ④ 通报产出的帧(定向 Hello / 重问 want)最后入队。
    ///
    /// 这四步在同一个协调者事件里跑完、期间不处理任何别的链路事件(**run-to-completion**:
    /// select 只在循环顶点重新选臂),故没有「新链的块被当成旧代 transfer 收下」的窗口。
    pub(super) async fn lan_adopt(&mut self, adopted: AdoptedLink) -> Result<(), String> {
        // LanReady 撤位期(未配置 / 配置残缺 / 纪元封闸 / 引导中):fail-closed,直接关。
        if !self.slot.lan_ready() {
            return Ok(());
        }
        if let Err(why) = self.slot.lan.admit(&adopted.established) {
            self.set_status(|s| s.lan_warning = Some(why));
            return Ok(());
        }
        let peer = adopted.established.peer.clone();
        let Some(generation) = self.slot.lan.next_generation() else {
            self.set_status(|s| {
                s.lan_warning = Some("局域网链路代次号已用尽,本机不再接受新的直连".into())
            });
            return Ok(());
        };
        let outs = {
            let conn = self.db.lock().expect("db mutex poisoned");
            let engine = self.slot.get().expect("lan_ready 已查引擎在场");
            engine.on_lan_link_up(&conn, &peer, generation)?
        };
        let serve_ctx = self.serve_ctx();
        self.slot.lan.install(generation, &self.cfg.device_id, adopted, serve_ctx);
        // 拨号退避复位(§7):这条链**两个方向**都算——对端拨进来的链一样说明它在场,
        // 没道理还按上一轮攒起来的退避去拨它。
        self.slot.dial.on_link_up(&peer);
        self.refresh_lan_status();
        // **新消费者出现了**(§6.2 ④′ 那一段的另一半):计划表跨链路生灭活着,这条链刚接上
        // 时里面可能早就躺着它有资格消费的 work —— 而摇铃的三条来路(请求到达 / 冷却到点 /
        // 别人交回在飞位)此刻一条都不会发生。少了这一下,那些 work 要等下一拍心跳(≤30s),
        // 断 WAN 冷启动时甚至更久。摇的是**槽那根线**而不是这条链的 `ops_wake`:该唤醒谁由
        // 协调者按 [`Deck::ops_changed_tick`] 那把统一的尺子算,不在这里另判一遍。
        self.slot.ops_changed.notify_one();
        self.dispatch(outs).await
    }

    /// 一条链路上抬的事件(**唯一消费点**):先认代次——迟到的旧代事件在此丢弃,绝不让它
    /// 打掉新链、也绝不喂进引擎(§5.1 / §6 代次契约)。
    pub(super) async fn lan_event(&mut self, ev: LanInbound) -> Result<(), String> {
        let LanInbound { peer, generation, event } = ev;
        let current = self.slot.lan.touch(&peer, generation);
        match event {
            _ if !current => Ok(()),
            LanEvent::Pong => Ok(()),
            LanEvent::Ping => {
                let Some(bytes) = lan_wire_bytes(&lan::LanWire::Pong {}).ok() else {
                    return Ok(());
                };
                let outs = self.push_lan(&peer, &bytes).outs;
                self.dispatch(outs).await
            }
            LanEvent::Frame { from, to, blob } => {
                match self.on_wire(Ingress::LanFrame, &from, &to, &blob).await? {
                    None => Ok(()),
                    Some(_) => {
                        // 引导帧恒走中转(§5):lan 上收到 = 对端实现漂移,拒。
                        self.set_status(|s| {
                            s.lan_warning = Some(format!("拒收 {from} 经局域网发来的引导帧"))
                        });
                        Ok(())
                    }
                }
            }
        }
    }

    /// 一条链路的死讯(**独立通道的唯一消费点**,§10):代次不符 = 早已被替换/摘掉的那条
    /// 链,引擎那边也早换代了,不必再通报。
    pub(super) async fn lan_fault(&mut self, f: LanFault) -> Result<(), String> {
        if !self.slot.lan.holds(&f.peer, f.generation) {
            return Ok(());
        }
        self.lan_down(&f.peer, f.generation, &f.why).await
    }

    /// 一条链路收场:摘链 + 通报引擎(只作废该代次的在飞拉流,并当场重问)。
    async fn lan_down(&mut self, peer: &str, generation: u64, why: &str) -> Result<(), String> {
        self.slot.lan.close(peer, generation);
        let outs = self
            .slot
            .get()
            .map(|e| e.on_lan_link_down(peer, generation))
            .unwrap_or_default();
        self.refresh_lan_status();
        let text = format!("与 {peer} 的局域网直连已断:{why}");
        self.set_status(|s| s.lan_warning = Some(text));
        self.dispatch(outs).await
    }

    /// 心跳一刻的链路面(§3):静默 ≥90s 判死 + 给活着的各发一枚 Ping。**跟着 runtime
    /// 那根心跳跑**(在线离线共用),故断 WAN 期间链路照样保活、照样判死。
    pub(super) async fn lan_beat(&mut self) -> Result<(), String> {
        let (dead, alive) = self.slot.lan.beats();
        for (peer, generation) in dead {
            self.lan_down(&peer, generation, "链路静默超时(90 秒无帧)").await?;
        }
        if alive.is_empty() {
            return Ok(());
        }
        let Ok(bytes) = lan_wire_bytes(&lan::LanWire::Ping {}) else { return Ok(()) };
        let mut outs = vec![];
        for peer in alive {
            outs.extend(self.push_lan(&peer, &bytes).outs);
        }
        self.dispatch(outs).await
    }

    /// 断网期的定向 Hello(§5:「本机中转离线 → 立即对全部活跃 lan 对端发一帧定向
    /// Hello、断线期间每 60s 重发」)。不对称断网时两端的水位互换**不能依赖对端事件的
    /// 新鲜度**(二轮 M5):本机主动问,来路亲和保证对端的应答沿同一条链回来。
    pub(super) async fn lan_offline_hello(&mut self) -> Result<(), String> {
        let peers = self.slot.lan.peers();
        if peers.is_empty() {
            return Ok(());
        }
        let outs = {
            let conn = self.db.lock().expect("db mutex poisoned");
            let Some(engine) = self.slot.peek() else { return Ok(()) };
            let mut outs = vec![];
            for peer in &peers {
                outs.extend(engine.make_hello(&conn, peer, Route::Lan)?);
            }
            outs
        };
        self.dispatch(outs).await
    }
}
