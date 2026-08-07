use super::*;

pub(super) async fn lan_read_pump(
    mut rd: tokio::net::tcp::OwnedReadHalf,
    peer: String,
    self_device: String,
    generation: u64,
    inbound: mpsc::Sender<LanInbound>,
    faults: mpsc::Sender<LanFault>,
) {
    let why = loop {
        let event = match read_lan_frame(&mut rd).await {
            Err(e) => break e,
            Ok(lan::LanWire::Frame { from, to, blob }) => {
                // `from` 由握手钉死、`to` 只许本机或广播(§3)。不符 = 这条链的对端不是
                // 当初验过签的那台,或实现漂移——**拒帧并断链**(比 §3 字面的「整帧拒收」
                // 严一档:链路的身份前提已经不成立,留着它没有意义)。
                if let Err(e) = lan::check_frame_addr(&peer, &self_device, &from, &to) {
                    break format!("帧地址不符:{e}");
                }
                LanEvent::Frame { from, to, blob }
            }
            Ok(lan::LanWire::Ping {}) => LanEvent::Ping,
            Ok(lan::LanWire::Pong {}) => LanEvent::Pong,
            // 建链后又来握手帧:协议错误。别给「先塞一枚坏帧、再补合法帧」留窗口
            // (同 L-b 审 M2 那条纪律,只是换到了数据面)。
            Ok(_) => break "建链后又收到握手帧".to_string(),
        };
        if inbound.send(LanInbound { peer: peer.clone(), generation, event }).await.is_err() {
            return; // 协调者已走(runtime 收场):没人可通报
        }
    };
    let _ = faults.send(LanFault { peer, generation, why }).await;
}

/// 一帧:`u32 BE 长度 ‖ CBOR`。长度前缀先过 [`lan::checked_body_len`] 再分配(L-b 审 M4:
/// u32 能声明 4 GiB,等读满再查上限已经晚了)。
async fn read_lan_frame(rd: &mut tokio::net::tcp::OwnedReadHalf) -> Result<lan::LanWire, String> {
    use tokio::io::AsyncReadExt;
    let mut prefix = [0u8; 4];
    rd.read_exact(&mut prefix).await.map_err(|e| format!("读长度前缀:{e}"))?;
    let n = lan::checked_body_len(prefix, lan::FramePhase::Established).map_err(|e| e.to_string())?;
    let mut body = vec![0u8; n];
    rd.read_exact(&mut body).await.map_err(|e| format!("读帧体:{e}"))?;
    lan::decode_wire(&body, lan::FramePhase::Established).map_err(|e| e.to_string())
}

/// 写端:协调者封好的帧 + **自己逐块驱动的图字节供流**(§10 C′ 第 3 条)+ **自己逐帧
/// 驱动的 op 追赶供流**(§6.1 消费面第一条腿,L-d″ 第②笔)。链路对象被丢弃 = 两根队列的
/// 发送端都没了 = 静默收场(那是协调者主动摘链/撤位,无需通报)。
///
/// 一轮的次序就是流控本身:
///   ① **控制/数据帧优先**——它们在**块边界**插队。一张 32 MiB 的图在千兆网上也要写好
///      几秒,Ping / Hello / ops 不该跟在它后面排队;一块 256 KiB ≈ 23ms,插队延迟就是
///      这个量级。
///   ② **新的供流描述符先接进来**(第②笔补的一手):blob 原先只从 ③ 的 select 里取,而
///      ops 腿一旦持续有活就永远走不到 ③——描述符会在通道里干等到 ops 追完。加了第二条
///      数据腿之后,「新图什么时候被看见」必须与「ops 忙不忙」无关。
///   ③ **两条数据腿按帧边界 1:1 轮转**(§6.1):blob 发下一块 / ops 发下一帧,一轮至多
///      一件。**发送窗口都 = 1**(取数 → 封帧 → `write_all` → 丢缓冲):峰值内存是一块
///      /一帧而不是整图/整段;`write_all` 的背压就是 TCP 的背压,协调者不参与。
///   ④ 都没活才睡在 select 上(控制帧 / 新供流 / ops 唤醒铃三根)。
///
/// 轮转粒度是**回合**不是帧:ops 的一次取数可能是空转(该 origin 对端已齐),它没往线上
/// 放一个字节,但**摸了一次库**——按帧记的话,一段长空转会让 blob 一块都发不出去。
///
/// 饿死面(诚实记账):控制帧持续不断时两条数据腿都会被一直推后。真实里控制帧稀疏(心跳
/// 30s / 事件驱动),且那种情形下链路本就在忙;换成「轮流各发一枚」会让控制面延迟随图长度
/// 抖动,不划算。
///
/// **连着几回 ops 就得让出一次**(276 记的那条消费方义务;实现审两轮各纠了我一次)。
/// 一轮 M1 推翻了我「LAN 侧不需要」的阴性结论:摸库这件事没有任何背压,而 `std::sync` 的
/// 锁不保证公平,16 条链一起扫足以把 UI 的写按住。二轮 M1 又推翻了我的第一版修法——
/// **只数空转不够**(loopback / 快接收方 / 大接收窗口下 `write_all` 可以立即 Ready,
/// `spawn_blocking(...).await` 也没有「必先 Pending 一次」的契约),而「灭 armed + 自己
/// 摇铃」根本不产生调度让出(`Notified` 已 ready 时 select 直接过)。
/// 故:**凡摸库的回合都计数**,到 [`OPS_TURNS_PER_CHECKPOINT`] 就 `yield_now` 真让出一次。
pub(super) async fn lan_write_pump(
    mut wr: tokio::net::tcp::OwnedWriteHalf,
    peer: String,
    generation: u64,
    mut out: mpsc::Receiver<Arc<Vec<u8>>>,
    mut serves: mpsc::Receiver<BlobServe>,
    ops_wake: Arc<Notify>,
    queued: Arc<AtomicUsize>,
    serve_ctx: ServeCtx,
    faults: mpsc::Sender<LanFault>,
) {
    use tokio::io::AsyncWriteExt;
    /// 一枚已封好的帧写出去(队列记账只对协调者入队的那根做——供流的块从没进过队列)。
    macro_rules! write_frame {
        ($bytes:expr, $accounted:expr) => {{
            let bytes: Arc<Vec<u8>> = $bytes;
            match wr.write_all(&bytes).await {
                Ok(()) => {
                    if $accounted {
                        queued.fetch_sub(bytes.len(), AtomicOrdering::SeqCst);
                    }
                }
                Err(e) => break format!("写链路:{e}"),
            }
        }};
    }
    let mut active: Option<(BlobServe, u32)> = None;
    // ops 腿的四个位:**有没有活**(唤醒铃驱动;起手先看一眼,建链那一刻可能就有)、
    // **卡在哪一帧上**(封不出的那一段的段头;见 `ops_stuck`)、**这次唤醒已经连空转几回**
    // (见 `OPS_IDLE_SPINS_PER_WAKE`)、**上一回合归谁**(1:1 轮转)。
    let mut ops_armed = true;
    // `ops_stuck` = 封不出的那一帧的**段头**(origin + 首枚 origin_seq)。
    // **刻意不是一枚「这条腿死了」的永久位**(实现审 H1):卡住的是**那一段**,不是这条
    // 链——中转腿把同一段发出去并提交之后,计划的头就往前走了,这条健康的直连链没有任何
    // 理由跟着陪葬。故记段头:再取到**同一段**就退回去接着睡(不重复报、不自旋),取到
    // **别的段**说明头动过了,当场清位照发。
    let mut ops_stuck: Option<(String, i64)> = None;
    let mut ops_turns = 0usize;
    let mut last_turn_ops = false;
    let why = loop {
        // ① 控制/数据帧优先(块边界插队)。
        match out.try_recv() {
            Ok(bytes) => {
                write_frame!(bytes, true);
                continue;
            }
            // 链路对象已被丢弃(摘链/撤位/替换):这只任务马上会被 abort,先自行收场。
            Err(mpsc::error::TryRecvError::Disconnected) => return,
            Err(mpsc::error::TryRecvError::Empty) => {}
        }
        // ② 新的供流描述符先接进来(见上:不能只靠 ③ 的 select 取)。
        if active.is_none() {
            match serves.try_recv() {
                Ok(serve) => active = Some((serve, 0)),
                Err(mpsc::error::TryRecvError::Disconnected) => return,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
        }
        // ③ 两条数据腿 1:1:这一回合归谁。两边都有活时按上一回合翻面。
        let ops_ready = ops_armed;
        let turn = match (ops_ready, active.is_some()) {
            (false, false) => None,
            (true, false) => Some(true),
            (false, true) => Some(false),
            (true, true) => Some(!last_turn_ops),
        };
        if turn == Some(true) {
            last_turn_ops = true;
            ops_turns += 1;
            // **逐帧取数 + 逐帧自证身份,同一把锁里办完**(§6 ⑤ 的第七条出口,与 C′ 逐块
            // 自证同一把尺)。整段丢进 `spawn_blocking` 的理由同 C′:`Mutex<Connection>`
            // 是同步锁,16 条链的写泵一起堵在 tokio worker 上会把 runtime 占成阻塞等待者。
            let ctx = serve_ctx.clone();
            // **这条腿只服务定向 work,一个字都不碰 BROADCAST**(§6.2 ①)。本机 origin 的
            // 追赶恒由协调者消费:中转在场时是 relay 泵(权威完成腿),不在场时是
            // [`Deck::offline_broadcast_pump`] —— 两条都在发帧的同一处 fan-out 给全部合格
            // 直连腿。让每条链各自去抢 BROADCAST 的话,一枚窗口只有一个赢家,**别的对端
            // 那一帧就永远补不上**(游标已被赢家推过去了)。
            let target = peer.clone();
            // 测试栅栏:见 [`arm_ops_handoff_barrier`]。它**必须停在闭包里**——两把锁已放掉、
            // 产出还没交回等待方,那正是「凭据造出来了但没人来领」的那个窗口。
            #[cfg(test)]
            let gate = ops_handoff_gate();
            let turn = tokio::task::spawn_blocking(move || {
                let turn = ops_prepare(&ctx, &target);
                #[cfg(test)]
                ops_handoff_hold(gate);
                turn
            })
            .await;
            match turn {
                // 阻塞池那只任务垮了(锁中毒 / 池已关):走正常的死讯出口,别跟着 panic。
                Err(e) => break format!("ops 供流取数任务异常:{e}"),
                Ok(OpsTurn::Recast) => break "本机身份已换代:ops 供流中止并拆链".to_string(),
                // 没活:等下一次唤醒(铃带存量,故「响铃时我正在取数」不会丢)。
                Ok(OpsTurn::Idle) => ops_armed = false,
                // 空转:游标已在同一临界区里提交过了,这一回合没有字节要写。
                Ok(OpsTurn::Spun) => {}
                // **窗口被中转那条腿占着**(第④笔下半兑现的义务①):正常争用,睡下等唤醒
                // ——**绝不拆链**。这里与 `Idle` 处置相同而分成两条臂,是因为**唤醒的所有者
                // 不同**:`Idle` 等的是「这个对端有新活了」(三个生产入口摇铃),
                // `Occupied` 等的是「那一笔在飞的交回了窗口」。
                //
                // **293(第⑤笔)起两条都真有主**:后者由 §6.2 ④′ 的 `ops_changed` 接手
                // ——每槽一枚 `Arc<Notify>`,占用→空闲那一次转移由释放方摇,协调者扫出
                // 「有活 ∧ 在飞位空」的 target 再逐个选腿。**唯一刻意不摇的**是中转腿 Nack
                // 那条(摇了就是当场重发 = 热循环),它的续做所有者是心跳那一拍。
                Ok(OpsTurn::Occupied) => ops_armed = false,
                // 取数或提交真出错:**响亮收场拆链**(实现审 H2)。
                //
                // 原先这里是「报一次 advisory 然后灭 armed」,那等于把一个本机故障伪装成
                // 「此刻没活」,接着干等一枚未必再来的铃——真错误绝不能靠偶然信号续做。
                // 拆链是可恢复的:摘腿、重拨、重建,而库真的坏了的话中转腿照样会响亮。
                Ok(OpsTurn::Failed(why)) => break format!("ops 供流取数失败:{why}"),
                Ok(OpsTurn::Frame(frame, ticket)) => {
                    // 这一段的**段头**:封不出时拿它记「卡在哪」,取到别的段就说明头动过了。
                    // 空帧走的是 `frame: None` 那一支,故这里恒非空(实现审二轮 L1:原来写
                    // 的是 `map_or(0, …)`,那是给一个不可能的情形悄悄编一个 seq)。
                    let first = frame.ops.first().expect("取数产出的帧恒非空").origin_seq;
                    let head = (frame.origin.clone(), first);
                    if ops_stuck.as_ref() == Some(&head) {
                        // 还是那一段(没人推进过它):退回去接着睡,**不重复报也不自旋**。
                        drop(ticket);
                        ops_armed = false;
                        continue;
                    }
                    ops_stuck = None;
                    p305!(
                        "lan_send peer={} origin={} seqs={}..{}({})",
                        &peer[peer.len().saturating_sub(6)..],
                        &frame.origin[frame.origin.len().saturating_sub(6)..],
                        frame.ops.first().expect("取数产出的帧恒非空").origin_seq,
                        frame.ops.last().expect("取数产出的帧恒非空").origin_seq,
                        frame.ops.len()
                    );
                    let msg = Msg::Ops { origin: frame.origin, ops: frame.ops };
                    match seal_lan_frame(
                        &serve_ctx.k_acc,
                        &serve_ctx.account_id,
                        &serve_ctx.device_id,
                        &peer,
                        &msg,
                    ) {
                        // 封不出 = 这一帧越过了 lan 腿的线上上限([`lan::LAN_FRAME_MAX`])。
                        // 单条超大 op 独占一帧时它真能到 1 MiB(§10 六轮 M4),而回滚**不推进
                        // 游标** —— 下一回合取到的还是同一段,照发就是死自旋。
                        //
                        // 记**段头**而不是判这条链死(实现审 H1):这一段过不去,不代表这条
                        // 链过不去——中转腿把它发出去并提交之后,头一动这里就自动接着供。
                        Err(e) => {
                            serve_ctx.warn(format!(
                                "局域网 ops 帧封不出({e});这一段改由中转腿供,本链跳过它"
                            ));
                            ops_stuck = Some(head);
                            ops_armed = false;
                        }
                        Ok(bytes) => {
                            // 测试栅栏:见 [`arm_ops_barrier`]。生产构建里这两行根本不存在。
                            #[cfg(test)]
                            ops_barrier().await;
                            write_frame!(bytes, false);
                            // **写成了才提交**(§6.1 十轮契约):失败 / 断链 / 换代一律走
                            // `rollback`,而那是 [`OpsTicket`] 的 `Drop` 兜底的事。
                            //
                            // 提交不上 = 在飞位已经不是这一笔了 = 所有权不变量破了(合法的
                            // 「work 整只没了」在 `settle` 里回的是 `Ok`)。**响亮收场**,不
                            // 降级成一枚静默的位:帧已经出门,而游标没动。
                            if let Err(e) = ticket.commit() {
                                break format!("ops 供流凭据交不回:{e}");
                            }
                        }
                    }
                }
            }
            // **每 N 回合真让出一次**(实现审二轮 M1)。上一版是「灭 armed + 给自己摇铃」,
            // 而 `Notified` 已 ready 时 select 根本不保证让出——那只是把计数分了段,调度上
            // 什么也没发生。`yield_now` 才有契约:它必先回一次 `Pending`,协调者与别的任务
            // 因此拿得到真实的检查点,那把 `Mutex<Connection>` 也才有机会易手。
            if ops_turns >= OPS_TURNS_PER_CHECKPOINT {
                ops_turns = 0;
                tokio::task::yield_now().await;
            }
            continue;
        }
        // ③b 供流的下一块。
        if let Some((serve, idx)) = active.take() {
            last_turn_ops = false;
            // **逐块自证身份 + 取数,同一把锁里办完**(§6 ⑤ 那条纪律的第六条出口;实现
            // 审 M1)。C′ 之后块是写泵**自己封**的,而 `k_acc` 是建链那一刻的快照——一张
            // 32 MiB 的图要写好几秒,纪元压实恰在其间完成的话,后续每一块都是拿旧身份封
            // 的帧;换代不保证有人 poke 控制通道(压实是库自己悄悄换的),故这一问必须真
            // 读库,且与会话循环、离线泵、pre-auth 握手同一把尺([`identity_still_current`])。
            // 两次分开取锁的话,「查完身份、换代提交、再读块」这个窄窗会漏一块过去。
            //
            // **整段丢进 `spawn_blocking`**(实现审 M2):`Mutex<Connection>` 是同步锁,16
            // 条链的写泵一起堵在 tokio worker 上,遇到 UI 长写 / VACUUM / 压实就能把 runtime
            // 的 worker 占成阻塞等待者,连心跳和死讯消费都跟着卡。搬到阻塞池里,worker 只
            // 等一个 join;每块一次任务跳转,相对 256 KiB 的 I/O 可忽略。
            //
            // 取数**当场放锁**:绝不跨 socket await 持 DB 锁,也不为慢链持跨整图的 read
            // transaction(那会长期钉住 WAL)。行中途被删 → 沿同 transfer 回 BlobDeny,让
            // 收端立刻回清单另寻来源,而不是干等 60s stale。
            //
            // **残余(诚实记账)**:放锁之后到 `write_all` 之前仍有一个 **≤1 帧**的窗口
            // ——要消掉它就得跨 socket 写持库锁,那是 §10 明令禁止的。协调者入队的帧本来
            // 也有同一个残余(封帧早于换代提交),故这不是新增面。
            let ctx = serve_ctx.clone();
            let bound = serve.clone();
            let read = tokio::task::spawn_blocking(move || {
                let conn = ctx.db.lock().expect("db mutex poisoned");
                if !identity_still_current_conn(
                    &conn,
                    &ctx.account_id,
                    &ctx.device_id,
                    &ctx.k_acc,
                    &ctx.device_seed,
                ) {
                    return Err(None); // 换代:调用方拆链
                }
                read_blob_chunk(&conn, &bound, idx).map_err(Some)
            })
            .await;
            let read = match read {
                // 阻塞池那只任务垮了(锁中毒 / 池已关):**走正常的死讯出口**而不是跟着
                // panic(实现审二轮 L2)——writer 一 panic 就跳过 `LanFault`,摘腿与诊断
                // 得等下一次 Ping 或入队失败才发现,晚一拍。
                Err(e) => break format!("供流取数任务异常:{e}"),
                Ok(Err(None)) => break "本机身份已换代:供流中止并拆链".to_string(),
                Ok(Err(Some(e))) => Err(e),
                Ok(Ok(v)) => Ok(v),
            };
            let msg = match read {
                Ok(Some(data)) => Msg::BlobChunk {
                    image_id: serve.image_id.clone(),
                    transfer: serve.transfer.clone(),
                    idx,
                    last: serve.is_last(idx),
                    data,
                },
                Ok(None) => Msg::BlobDeny {
                    image_id: serve.image_id.clone(),
                    transfer: serve.transfer.clone(),
                },
                Err(e) => {
                    serve_ctx.warn(format!("读 {} 的第 {idx} 块失败:{e}", serve.image_id));
                    Msg::BlobDeny {
                        image_id: serve.image_id.clone(),
                        transfer: serve.transfer.clone(),
                    }
                }
            };
            let more = matches!(msg, Msg::BlobChunk { last: false, .. });
            match seal_lan_frame(
                &serve_ctx.k_acc,
                &serve_ctx.account_id,
                &serve_ctx.device_id,
                &serve.to,
                &msg,
            ) {
                // 封不出 = 本机 bug(块恒 ≤256 KiB,远低于 lan 的 1 MiB 帧上界):这一笔
                // 就此作废,收端等 stale 换来源;链路本身没毛病,不断。
                Err(e) => serve_ctx.warn(format!("局域网供流帧封不出({e})")),
                Ok(bytes) => {
                    write_frame!(bytes, false);
                    // 测试栅栏:见 [`arm_serve_barrier`]。生产构建里这两行根本不存在。
                    #[cfg(test)]
                    serve_barrier(idx).await;
                    if more {
                        active = Some((serve, idx + 1));
                    }
                }
            }
            continue;
        }
        // ④ 都空:睡着等。三根都是取消安全的,select 丢掉的那些不丢消息——`Notified` 被
        //    丢弃时若已收下那一声,tokio 会把它交回铃上(故不是「唤醒丢在 select 里」)。
        //    取到的帧**出了 select 块再写**:select 的分支 future 在处置块跑完前一直借着
        //    `out`,把 `write_all` 塞进臂里等于给借用检查器添无谓的难题。
        let mut pending: Option<Arc<Vec<u8>>> = None;
        tokio::select! {
            frame = out.recv() => match frame {
                Some(bytes) => pending = Some(bytes),
                None => return,
            },
            serve = serves.recv() => match serve {
                Some(serve) => active = Some((serve, 0)),
                None => return,
            },
            // 铃只说「去看一眼」:该发什么、发到哪一段,恒由引擎槽里那份计划说了算。
            // 终局之后照收这一声(`ops_dead` 那道闸在 ③ 的 `ops_ready` 上,一处一判):
            // 在这里再加一道 `if !ops_dead` 只是把同一个判据抄第二遍,而它**没有任何变异
            // 能证伪**——摘掉它,醒来的那一轮照样被 `ops_ready` 挡回 select。
            () = ops_wake.notified() => ops_armed = true,
        }
        if let Some(bytes) = pending {
            write_frame!(bytes, true);
        }
    };
    // 死讯走**独立通道**(§10):数据面此刻可能正满着,而这声正是最不能等的一声。
    let _ = faults.send(LanFault { peer, generation, why }).await;
}

impl ServeCtx {
    /// 供流泵的诊断出口:只写 advisory 面的 `lan_warning`,**绝不占正确性面的 `error`
    /// 槽**(L-c2b 实现审 M3 的既有纪律)。
    pub(super) fn warn(&self, text: String) {
        set_status(&self.status, &self.events, |s| s.lan_warning = Some(text));
    }
}

