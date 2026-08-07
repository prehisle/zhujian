use super::*;

/// **通告面**(§2:唯一权威路 = 经中转 deliver 到达的 Hello)。刻意与 [`Deck`] 分开成一
/// 个更小的借用面:它要的只是「库 + 引擎(读水位)+ 状态面 + 本会话的几枚去重位」,**不要
/// socket**——通告是 advisory 面,拿不到中转腿时它整个不存在(见 [`Deck::ad`])。
pub(super) struct AdDeck<'a> {
    pub(super) db: &'a Arc<Mutex<Connection>>,
    pub(super) status: &'a Arc<Mutex<SyncStatus>>,
    pub(super) events: &'a mpsc::UnboundedSender<SyncEvent>,
    pub(super) cfg: &'a SyncConfig,
    pub(super) slot: &'a mut EngineSlot,
    pub(super) ad: &'a mut AdFace,
}

impl AdDeck<'_> {
    pub(super) fn set_status(&self, f: impl FnOnce(&mut SyncStatus)) {
        set_status(self.status, self.events, f);
    }

    fn toast(&self, msg: String) {
        let _ = self.events.send(SyncEvent::Toast(msg));
    }

    /// 吸收对端 Hello 捎带的通告。**唯一调用点在 [`Deck::feed`]**(词法锚
    /// `lan_ad_absorbed_only_from_the_single_feed_entry` 钉着):和入引擎收在同一个入口,
    /// 才不会有「lan 那条腿忘了不写缓存」的漏法——来路是 [`Ingress`],由 socket 所有者
    /// 代入,`merge_peer_ad` 对 `LanFrame` 整体忽略。
    ///
    /// 返回待发的收敛回帧(§2 触发① / 定向 Hello 的应答)。通告面的任何失败**只进
    /// [`SyncStatus::lan_warning`]**:advisory 字段绝不牵动这枚 Hello 的水位处理(§2),
    /// 也绝不占用正确性面的 `error` 槽(codex 审 M3)。
    ///
    /// `directed` = 这枚 Hello 是**定向发给本机**的(信封 `to` == 本机 device_id,不是
    /// 广播)。§2 的定向 Hello 就是一次隐式索要:「我把我的通告给你,请把你的给我」——
    /// 故即便对端早已在缓存里(不是首见、无从跃迁),也按 peer/会话应答一次。少了它,
    /// **非对称缓存永不收敛**(codex 审 M1:A 有 B 的钥、B 没有 A 的,B 索要而 A 判
    /// 「已缓存」不答,B 只能等 A 重连)。
    pub(super) fn absorb_lan_ad(
        &mut self,
        from: &str,
        ad: &LanAd,
        ingress: Ingress,
        directed: bool,
    ) -> Vec<Output> {
        // 两道总闸(都只忽略通告,这枚 Hello 的水位照常处理):
        // ① 归属没对齐 = 通告面整个关掉(二审 M1:半态下发通告会让序号复用或倒退,而
        //    缓存里可能还留着上一代身份的记录);
        // ② 本机自己的通告被原样反射回来——恶意中转把本机发的 `to="*"` 密文回灌即可,
        //    AAD 合法、不需要 K_acc。**显式拒**,不赖「正常服务器不回灌发送者」这条外部
        //    行为(审 L1):写进去会污染授权缓存、诱出无意义回帧,还给日后的拨号留个自连
        //    候选。
        if !self.ad.ready || from == self.cfg.device_id {
            return vec![];
        }
        let now_ms = crate::clock::wall_now_ms();
        let mut outs: Vec<Output> = vec![];
        let solicited = lan_ad_answer_needed(directed, ingress, self.ad.answered.contains(from));
        let merged = {
            let conn = self.db.lock().expect("db mutex poisoned");
            let engine = self.slot.peek().expect("feed 已过 booting 闸");
            let mut go = || -> Result<Option<lan::StoreCause>, String> {
                let cached = read_peer_ad(&conn, from)?;
                match lan::merge_peer_ad(cached.as_ref(), ad, ingress, now_ms) {
                    lan::AdMerge::Ignore(_) => {
                        // 已在缓存里(序号不新 / 已禁用):唯一还要出帧的情形 = 对端定向
                        // 索要。禁用的对端也答——本机通告没什么可保密的,且不答会让对端
                        // 每会话白问一次。
                        if solicited {
                            outs.extend(engine.make_hello(&conn, from, Route::Relay)?);
                        }
                        Ok(None)
                    }
                    lan::AdMerge::Malformed(why) => Err(format!("局域网通告不合法:{why}")),
                    lan::AdMerge::Store { record, cause } => {
                        // 硬容量闸只挡**新记录**(二审 M2):已在册的序号推进与冲突禁用
                        // 照写——满额绕掉粘滞禁用才是真事故。
                        if cause == lan::StoreCause::FirstSeen
                            && count_peer_ads(&conn)? >= MAX_LAN_PEER_RECORDS
                        {
                            return Err(format!(
                                "局域网通告缓存已满({MAX_LAN_PEER_RECORDS} 条):新对端的直连不可用,中转同步照常"
                            ));
                        }
                        // **先备好回帧、再落库**(codex 审 M4):`FirstSeen` 是收敛的唯一
                        // 一次性跃迁,落库成功而回帧生成失败 = 跃迁被吃掉、此后只剩
                        // Advanced,那台对端再也等不到本机通告(除非本机重连)。这一颠倒
                        // 让「跃迁已消费而回帧不存在」在任何失败点都造不出来。
                        let reply: Vec<Output> = if lan_ad_reply_needed(cause) || solicited {
                            // 定向回 Hello 走**鉴权路**(§2:带通告的权威 Hello 只许经
                            // 中转,LAN 到达的 lan 字段收端整体忽略,发过去等于没发)。
                            engine.make_hello(&conn, from, Route::Relay)?
                        } else {
                            vec![]
                        };
                        write_peer_ad(&conn, from, &record)?;
                        outs.extend(reply);
                        Ok(Some(cause))
                    }
                }
            };
            go()
        };
        // 锁已放:下面才碰状态面(status 锁不与 db 锁嵌套)。
        // 限频位只记「应答过索要」这件事,**不记触发① 的回帧**:① 每对端一生一次,拿它
        // 顺手把索要额度也花掉的话,那一帧万一丢了(对端正引导 / 中转丢帧),对端此后
        // 索要就再也没人答——非对称缓存又卡住了(codex 审 M1 要修的正是这个)。
        if solicited && !outs.is_empty() {
            self.ad.answered.insert(from.to_string());
        }
        match merged {
            // 首见钉住 / 序号推进 / 不新的重复投递:正常路径,不打扰用户。
            Ok(None) => {}
            Ok(Some(lan::StoreCause::FirstSeen)) | Ok(Some(lan::StoreCause::Advanced)) => {
                // **新通告 = 退避复位**(§7 明写的三条复位信号之一;codex 二轮 M1:只
                // `kick()` 把计时器拨到现在没用——巡查照样被这台对端自己的退避挡住,
                // 「新 IP 不必等 300s」就成了空话)。首见给了公钥、推进给了新落点,两种
                // 都是「它此刻大概在场」的强信号。
                self.slot.dial.kick_peer(from);
            }
            Ok(Some(lan::StoreCause::KeyConflict)) => {
                // 同 id 异钥只能是攻击或克隆(正常换钥必换 device_id 或走纪元轮换):
                // 该对端直连已**粘滞禁用**并落库。提示每会话一次,清单进状态面常驻
                // (装配时从缓存重检,故跨重启仍在)。
                if self.ad.conflict_reported.insert(from.to_string()) {
                    self.toast(format!(
                        "设备 {from} 的局域网身份钥与首次记下的不一致,已停用与它的直连(需人工核查)"
                    ));
                }
                let peer = from.to_string();
                self.set_status(|s| {
                    if !s.lan_disabled.contains(&peer) {
                        s.lan_disabled.push(peer);
                        s.lan_disabled.sort();
                    }
                });
            }
            Err(e) => {
                if self.ad.warned.insert(from.to_string()) {
                    self.set_status(|s| s.lan_warning = Some(format!("{from}:{e}")));
                }
            }
        }
        outs
    }

    /// §2 收敛触发②:服务器说某对端在线、而本机**没有**它的验证钥 → 定向 Hello 把本机
    /// 通告送过去(按 peer / 会话限频一次)。双盲(两端都缺对端公钥)时这是加速解锁点
    /// ——对方收到即钉住,并按触发① 回一帧;两侧的 ② 对称。
    ///
    /// 它只是**加速**:对端正在引导时这一帧被整帧丢弃(模块注释),收敛的保证归触发①
    /// ——对端引导完的会话仪式必广播一枚带通告的 Hello,本机首见钉住即回一帧。
    ///
    /// 缓存**在册但被冲突禁用**的对端不发:粘滞禁用只有换 device_id 或纪元轮换才解,
    /// 再问也无用。
    pub(super) fn lan_hello_if_key_missing(&mut self, peer: &str) -> Vec<Output> {
        if !self.ad.ready || self.ad.asked.contains(peer) || self.slot.peek().is_none() {
            return vec![];
        }
        let made = {
            let conn = self.db.lock().expect("db mutex poisoned");
            match read_peer_ad(&conn, peer) {
                Err(e) => Err(e),
                Ok(Some(_)) => Ok(None),
                Ok(None) => self
                    .slot
                    .peek()
                    .expect("上一行已查在场")
                    .make_hello(&conn, peer, Route::Relay)
                    .map(Some),
            }
        };
        match made {
            Ok(None) => vec![],
            Ok(Some(outs)) => {
                self.ad.asked.insert(peer.to_string());
                outs
            }
            Err(e) => {
                if self.ad.warned.insert(peer.to_string()) {
                    self.set_status(|s| s.lan_warning = Some(format!("{peer}:{e}")));
                }
                vec![]
            }
        }
    }

    /// 本机这一枚 [`LanAd`](§2)。序号在**本会话首次封发 Hello** 时递增并落库;其后同一
    /// 会话内**只要 listen 没变就重用**(定向回 Hello 也重用)。listen 一变即换号——
    /// 「序号绑内容」的理由见 [`AdFace::published`]。
    pub(super) fn local_lan_ad(&mut self) -> Option<LanAd> {
        if self.ad.off || !self.ad.ready {
            return None;
        }
        let listen = self.slot.lan.listen.clone();
        let reuse = match &self.ad.published {
            Some((seq, published)) if *published == listen => Some(*seq),
            _ => None,
        };
        let seq = match reuse {
            Some(seq) => seq,
            None => {
                let bumped = {
                    let conn = self.db.lock().expect("db mutex poisoned");
                    bump_ad_seq(&conn)
                };
                match bumped {
                    Ok(seq) => {
                        self.ad.published = Some((seq, listen.clone()));
                        seq
                    }
                    Err(e) => {
                        // 到 u64::MAX(绝不回绕)或落库失败:本设备通告停用,Hello 照发。
                        self.ad.off = true;
                        self.set_status(|s| s.lan_warning = Some(e));
                        return None;
                    }
                }
            }
        };
        Some(LanAd { pubkey: pubkey_of(&self.cfg.device_seed).to_vec(), ad_seq: seq, listen })
    }
}

/// 离线期的投递面(没有中转腿):`run` 与 [`offline_wait`] 用它 dispatch 心跳、本地结算、
/// 链路事件产出的帧——L-c2a 那轮这些帧「无腿可走被丢」,有了 lan 腿它们才真送得出去。
pub(super) fn offline_deck<'a>(
    t: &'a Transport,
    cfg: &'a SyncConfig,
    slot: &'a mut EngineSlot,
) -> Deck<'a> {
    Deck {
        db: &t.db,
        clock: &t.clock,
        status: &t.status,
        events: &t.events,
        cfg,
        slot,
        relay: RelayLeg::Down,
    }
}

