//! live 会话编排(multispace-plan §2/§6,工序 4):谁的库开着、谁的 transport
//! 在跑,这里是唯一真相源。状态机 `Stopped → Running → Stopping → Stopped`——
//! activate 即 Running(成功点 = **本地 runtime 就绪**,不等网络);stop 先翻
//! Stopping(继续占 permit、挡同 id 重激活与新命令),拉高停机 watch 信号,await
//! 任务真退出后才移除表项。停机信号在 transport 的任何 await 点生效(含拨号/
//! 握手/引导中,session future 被取消;SQLite 同步段天然跑完,撕不裂事务)。
//!
//! 策略参数化(multispace-plan §1 决定④):手机 `max_live=1`(同刻单活跃,切空间
//! = stop 旧 → activate 新);桌面 `max_live=usize::MAX`(eager 全连所有发现的
//! 空间,不设上限)。两端差异只剩这一个参数与壳侧编排。
//!
//! 代次(generation):每次 activate 全局递增。事件通道本身即代次隔离(每次
//! activate 一条新通道、旧通道随旧任务消亡),壳桥接 UI 事件时据 generation 丢弃
//! 迟到代次(手机切空间用;桌面 v1 不停机,自然用不上)。
//!
//! **stop 返回 ≠ 旧 `Arc<ActiveRuntime>` 已消亡**(multispace-plan §6:切换不做
//! drain-to-zero;未发 op 留本地、已发未 ack 重发幂等)。契约:壳的业务命令**每次
//! 现查表**(`get`),不得跨 await 长持 Arc;切换/停机与业务写的互斥由壳编排
//! (桌面 lifecycle 锁先例、手机工序 8 的 foreground/session 分离)。极端迟到写
//! 落在旧库自己的 oplog/时钟上,不与新 runtime 争号;同 id 重激活的取号唯一性
//! 由 0024 的 UNIQUE(origin, origin_seq) 响亮兜底。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::{mpsc, watch, Notify};

use super::transport::{self, BlobPolicy, Control, SyncEvent, SyncStatus};
use crate::clock::Clock;
use crate::spaces::NativeFileKey;

/// 一个 live 空间的运行时:独立库连接 + 独立 HLC 时钟 + 独立同步传输的命令面
/// (状态快照 + 控制通道)。锁是空间私有的,跨空间命令互不阻塞。
pub struct ActiveRuntime {
    pub id: String,
    /// 库文件路径(未 canonicalize 的原始形态,给 UI/日志看)。
    pub path: PathBuf,
    /// 激活代次(每次 activate 全局递增,见模块注释)。
    pub generation: u64,
    pub db: Arc<Mutex<Connection>>,
    pub clock: Arc<Mutex<Clock>>,
    pub status: Arc<Mutex<SyncStatus>>,
    pub control: mpsc::Sender<Control>,
    /// 身份四不变量没过时的人话说明:此空间 transport 未启(sync_* 命令响亮拒),
    /// 本地数据照常可用。None = 正常。启动时定一次;配对/创号完成后重查可再置入
    /// (四不变量的三个校验时机),故带锁。
    pub sync_veto: Mutex<Option<String>>,
    /// 停机信号发送端(stop 拉高;veto 空间无任务,拉了也没人听,无害)。
    shutdown: watch::Sender<bool>,
    /// transport 任务句柄(veto 空间无任务 = None);stop 取走 await,超时放回可重试。
    join: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// transport 以 [`transport::TransportExit::ReopenRequired`] 收场后的壳侧信号
    /// (space-entry-plan §3.2):引导已提交但连接须重开——本 runtime 的业务写从此
    /// 拒(见 [`ActiveRuntime::restart_required`]),壳层义务 = stop 后重新 activate,
    /// 或提示重启。**不会自动变化**:ActiveRuntime 不因 transport 退出而离表。
    restart_required: Arc<Mutex<Option<String>>>,
    /// H1(工序 9 二审):跨 await 的长命令(配对/创号/改名/改服务器)登记器。stop
    /// 靠它等这些命令释放旧 runtime/连接后再放行下一次激活,堵住「命令未结束就切走
    /// 再切回、开出第二条写连接」。**独立 Arc**:OpGuard 只持它、不持 ActiveRuntime,
    /// 故 guard drop 通知 stop 时,命令侧不因 guard 还残着一个连接 Arc 而留下短窗口。
    ops: Arc<OpTracker>,
}

/// 跨 await 长命令的登记器(H1)。独立于 [`ActiveRuntime`],故 [`OpGuard`] 不持连接。
#[derive(Default)]
struct OpTracker {
    state: Mutex<OpState>,
    /// active_ops 归零时唤醒等待的 stop。
    done: Notify,
}

#[derive(Default)]
struct OpState {
    /// stop 已开始:不再接受新长命令(`begin` 返回 None)。
    closing: bool,
    /// 在飞的跨 await 长命令数(配对等仍在用这个 runtime/连接的命令)。
    active_ops: usize,
}

impl OpTracker {
    fn begin(self: &Arc<Self>) -> Option<OpGuard> {
        let mut st = self.state.lock().expect("ops mutex poisoned");
        if st.closing {
            return None;
        }
        st.active_ops += 1;
        Some(OpGuard { tracker: self.clone() })
    }
}

/// [`ActiveRuntime::begin_op`] 的 RAII 凭据:活着 = 一条长命令仍在用这个 runtime;
/// drop = 释放,归零时唤醒等待的 stop(H1)。只持独立的 [`OpTracker`],不持连接。
pub struct OpGuard {
    tracker: Arc<OpTracker>,
}

impl Drop for OpGuard {
    fn drop(&mut self) {
        let mut st = self.tracker.state.lock().expect("ops mutex poisoned");
        st.active_ops -= 1;
        if st.active_ops == 0 {
            self.tracker.done.notify_waiters();
        }
    }
}

impl ActiveRuntime {
    /// 写命令的统一入口锁:先库后钟(全局唯一顺序,防死锁)。每个写编排在自己的
    /// 事务里完成「改数据 + 发射 op + HLC 水位落盘」三件事——见 notes/task/images。
    pub fn write_locks(&self) -> (MutexGuard<'_, Connection>, MutexGuard<'_, Clock>) {
        (
            self.db.lock().expect("db mutex poisoned"),
            self.clock.lock().expect("clock mutex poisoned"),
        )
    }

    /// 读 veto 快照(命令层在动同步面前查)。
    pub fn veto(&self) -> Option<String> {
        self.sync_veto.lock().expect("veto mutex poisoned").clone()
    }

    /// 登记一次跨 await 的长命令(配对/创号/改名/改服务器,H1)。返回 None = 空间
    /// 正在停止(切换已在收场),别再开长命令。guard 释放时递减,归零唤醒等待的
    /// stop——stop 靠它确保旧 runtime/连接真被放手后,才让调用方激活出下一条连接。
    pub fn begin_op(&self) -> Option<OpGuard> {
        self.ops.begin()
    }

    /// 订阅本 runtime 的停机信号(H1:长命令据此在切换发起时取消——不发 Enroll、
    /// 不烧本机身份;Enroll 已发后的取消按 §19 清库重配)。
    pub fn subscribe_shutdown(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    /// Some = transport 已以 ReopenRequired 收场(引导已提交、原连接不可续用):
    /// 壳层的业务写闸必须查它并响亮拒(space-entry-plan §3.2「旧 runtime 不再接受
    /// 写」),可执行动作 = stop 后重新 activate,或提示用户重启。
    pub fn restart_required(&self) -> Option<String> {
        self.restart_required.lock().expect("restart mutex poisoned").clone()
    }
}

/// 表槽:Running 可查可用;Stopping 占着 permit、对命令面不可见(`get` 拒),
/// 等 stop 把任务 join 干净才消失——绝不出现「表里没了、任务还活着」的暗态。
/// Starting(工序 9 二审 M1):reserve 已占坑 + 占 permit,但**尚未开任何连接**;
/// commit 前对命令面不可见。让「重复/超限」在开第二条读写连接之前就被拒(原先
/// activate 先开库后查槽,回滚/恢复路径会瞬时开出第二条连接)。
/// Resetting(epoch-plan §7,codex 三轮必修 5):重置墓碑——**Arc 已从槽移出**
/// (槽持着 Arc 时 try_unwrap 必败;提前删槽又开重启窗),同 id 的 get/reserve/
/// activate/stop 全拒,直到文件操作完成后按 token 删除。文件操作失败 = 墓碑留下
/// (fail-closed:宁封锁不双写)。
enum Slot {
    Starting(u64),
    Running(Arc<ActiveRuntime>),
    Stopping(Arc<ActiveRuntime>),
    Resetting(u64),
}

/// 一次激活的装配参数。conn/clock 由调用方先开好传入——**开库策略归壳**:桌面
/// eager 全开(发现→逐库 `db::open`→四不变量裁决→逐个 activate,行为不变);手机
/// 从 catalog descriptor 激活时才开库。
pub struct ActivateSpec {
    pub id: String,
    pub path: PathBuf,
    /// catalog descriptor 记录的物理文件身份(multispace-plan §2:激活时重算复核,
    /// 防运行期文件被替换)。None = 不经 catalog 的激活(桌面 eager 路径:身份四
    /// 不变量在活连接上另行裁决)。
    pub expected_file: Option<NativeFileKey>,
    /// 事件通道发送端(壳造、壳桥接到 UI;每次 activate 一条新通道)。
    pub events: mpsc::UnboundedSender<SyncEvent>,
    /// 引导快照临时目录(transport 的 data_dir;与库同卷,快照 VACUUM INTO 免跨盘拷)。
    pub boot_dir: PathBuf,
    /// 图字节旁路策略(android-plan §4 M1 语义保留):两端壳现均注 Full(117 手机
    /// 反转);显式注入,无默认值。
    pub blob_policy: BlobPolicy,
    /// 是否应答别机的引导快照请求(两端壳现均 true,phone-space-plan 对称升格;
    /// false 仍是合法配置)。true 也不等于随叫随供——字节有洞时 transport 的
    /// boot_serve_snapshot 防线静默拒供(§1.1,端无关)。
    pub allow_boot_source: bool,
    /// Some = 身份四不变量没过:不 spawn transport(控制通道成死信箱,sync_*
    /// 命令响亮拒),状态固化「off + 原因」,本地数据照常可用。
    pub sync_veto: Option<String>,
}

/// live 会话的唯一编排者(multispace-plan §2)。
pub struct SpaceSupervisor {
    /// transport 任务的宿主 runtime(壳传入:tauri 的 tokio;测试 `Handle::current()`)。
    rt: tokio::runtime::Handle,
    /// 同刻 live 上限(手机 1 / 桌面 = usize::MAX 不设上限),Stopping 也计入——permit 在任务
    /// 真退出前不交还。超限 activate 响亮拒、不排队:「新空间只在旧空间交还 permit
    /// 后起」的次序由壳的切换编排保证(先 stop 成功、后 activate)。
    max_live: usize,
    /// app 级局域网监听器与准入表(lan-direct-plan §6;L-c3a)。**每 app 一枚**——
    /// 一台机器只有一个 24618 端口,而桌面壳 eager 装配全部空间,故 socket 只有一只、
    /// 拨入方靠 Intro 的 MAC 自证它找的是哪个空间。`None` = 本端不监听(手机壳:§6
    /// 「手机壳不监听、只拨出」,拨号器归 L-c3b)。
    lan: Option<Arc<transport::LanAdmission>>,
    generation: AtomicU64,
    live: RwLock<HashMap<String, Slot>>,
}

impl SpaceSupervisor {
    /// `lan` = app 级局域网监听器(桌面壳传 `Some`,手机壳与测试传 `None`)。
    pub fn new(
        rt: tokio::runtime::Handle,
        max_live: usize,
        lan: Option<Arc<transport::LanAdmission>>,
    ) -> SpaceSupervisor {
        assert!(max_live >= 1, "max_live 至少 1");
        SpaceSupervisor {
            rt,
            max_live,
            lan,
            generation: AtomicU64::new(0),
            live: RwLock::new(HashMap::new()),
        }
    }

    /// 命令面唯一入口:读锁查表 → clone Arc → 放锁,绝不持表锁做 SQL/网络/等控制
    /// 通道。Stopping 空间对命令面不可见(响亮拒,不给正在停的空间派新活)。
    pub fn get(&self, id: &str) -> Result<Arc<ActiveRuntime>, String> {
        match self.live.read().expect("live lock poisoned").get(id) {
            Some(Slot::Running(rt)) => Ok(rt.clone()),
            Some(Slot::Stopping(_)) => Err(format!("空间 {id} 正在停止")),
            Some(Slot::Starting(_)) => Err(format!("空间 {id} 正在启动")),
            Some(Slot::Resetting(_)) => Err(format!("空间 {id} 正在重置(本机副本清除中)")),
            None => Err(format!("未知空间:{id}")),
        }
    }

    /// 快照全部 **Running** 空间(表序不稳定,调用方自己排;Stopping 是切换瞬态,
    /// 不算「在场」)。
    pub fn all(&self) -> Vec<Arc<ActiveRuntime>> {
        self.live
            .read()
            .expect("live lock poisoned")
            .values()
            .filter_map(|s| match s {
                Slot::Running(rt) => Some(rt.clone()),
                Slot::Stopping(_) | Slot::Starting(_) | Slot::Resetting(_) => None,
            })
            .collect()
    }

    /// 占 permit 的空间数(Running + Stopping:permit 在任务真退出前不交还)。
    pub fn count(&self) -> usize {
        self.live.read().expect("live lock poisoned").len()
    }

    /// 目标空间在表中**完全无槽位**(Stopped/从未激活)。跨空间移动为非 live 目标
    /// 开一次性写连接前必须证明它成立(codex 安卓实现审 #1):`get` 拒不足够——
    /// Resetting 墓碑(重置半途保留)也让 `get` 拒,但那时目标正被重置,`open_space`
    /// 会绕过墓碑写坏它;唯有「表里没有这个 id 的任何槽」才安全。
    pub fn is_stopped(&self, id: &str) -> bool {
        !self.live.read().expect("live lock poisoned").contains_key(id)
    }

    /// 激活一个空间(便捷路:reserve + commit 融合;桌面 eager 装配用,conn 已先开)。
    /// 成功点 = 本地 runtime 就绪(不等网络)。手机切换/遍历走分开的 reserve → 开库
    /// → commit(M1:开第二条读写连接前先占坑),不走这里。
    pub fn activate(
        &self,
        spec: ActivateSpec,
        conn: Connection,
        clock: Clock,
    ) -> Result<Arc<ActiveRuntime>, String> {
        let reservation = self.reserve(&spec.id)?;
        reservation.commit(spec, conn, clock)
    }

    /// 原子预留一个空间槽(工序 9 二审 M1):表写锁内查重复/上限、占 permit、插入
    /// `Starting`——**先于开任何读写连接**。调用方随后开库(NO_CREATE/先验后写)、装
    /// Clock,再 [`Reservation::commit`] 换成 Running;开库/复核失败由预留的 RAII Drop
    /// 只删自己那枚 token 的 Starting(不误删后来者),permit 随之交还。reserve→commit
    /// 之间全同步无 await,预留不会被并发编排搅动。
    pub fn reserve(&self, id: &str) -> Result<Reservation<'_>, String> {
        let mut live = self.live.write().expect("live lock poisoned");
        if live.contains_key(id) {
            return Err(format!("空间 {id} 已激活或正在启动/停止(重复激活是编排 bug)"));
        }
        if live.len() >= self.max_live {
            return Err(format!(
                "live 空间已达上限 {}(先停当前空间、等它真退出,再激活)",
                self.max_live
            ));
        }
        // 代次预留时分配、commit 复用作 runtime generation:失败留下代次空洞无害。
        let token = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        live.insert(id.to_string(), Slot::Starting(token));
        Ok(Reservation { sup: self, id: id.to_string(), token, active: true })
    }

    /// 把预留兑成 Running(唯一装配点):catalog 文件身份复核(在活连接上)→ 挂 oplog
    /// 写通知 update_hook(rusqlite 每连接仅一只)→ 起 transport → `Starting(token)`
    /// 原子换 `Running`。复核失败 → Err,预留由 Drop 释放。
    fn commit_reservation(
        &self,
        token: u64,
        spec: ActivateSpec,
        conn: Connection,
        clock: Clock,
    ) -> Result<Arc<ActiveRuntime>, String> {
        // catalog 复核(multispace-plan §2):descriptor 记录的物理文件身份与现算
        // 不符 = 文件在 catalog 扫描后被替换,拒绝激活。同时把传入的 conn 绑到
        // 同一物理文件上(误装「path=B、conn=A」会让 UI 显示 B、transport 实际
        // 操作 A——rusqlite 的 Connection::path 给出真打开的文件)。
        if let Some(want) = spec.expected_file {
            let got = crate::spaces::native_file_key(&spec.path)?;
            if got != want {
                return Err(format!(
                    "空间 {} 的库文件身份与 catalog 记录不符(文件被替换?)",
                    spec.id
                ));
            }
            let conn_path = conn
                .path()
                .ok_or_else(|| format!("空间 {} 的连接没有文件路径(内存库?)", spec.id))?;
            let conn_key = crate::spaces::native_file_key(std::path::Path::new(conn_path))?;
            if conn_key != want {
                return Err(format!(
                    "空间 {} 传入的库连接与 catalog 记录不是同一个文件(装配错位)",
                    spec.id
                ));
            }
        }
        let configured = transport::account_id(&conn)?.is_some();
        let generation = token; // 预留时已分配,复用作代次。
        // 取 live 写锁,**先验预留仍在(Starting(token))再建**——绝不 spawn 了 transport
        // 才发现槽没了(避免 detached 任务 + permit 泄漏,codex 二审 M2)。spawn 非阻塞,
        // 锁跨它无妨(原 activate 亦在锁内 spawn)。reserve→commit 全同步无 await,正常
        // 恒命中;命不中 = 编排 bug(如错传 spec.id),纯早退、不产生副作用。
        let mut live = self.live.write().expect("live lock poisoned");
        match live.get(&spec.id) {
            Some(Slot::Starting(t)) if *t == token => {}
            _ => return Err(format!("空间 {} 的预留已不在(编排 bug:错传 spec.id?)", spec.id)),
        }
        let wrote = Arc::new(Notify::new());
        transport::hook_oplog_writes(&conn, wrote.clone());
        let db = Arc::new(Mutex::new(conn));
        let clock = Arc::new(Mutex::new(clock));
        let status = Arc::new(Mutex::new(SyncStatus::default()));
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let restart_required: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let join = if let Some(v) = &spec.sync_veto {
            // 拒启 transport;状态照实(configured 反映库里配置)+ error 说明原因,
            // 前端状态点见 error 即红。ctl_rx 随此分支 drop = 控制通道死信箱。
            let mut st = status.lock().expect("sync status mutex poisoned");
            st.configured = configured;
            st.state = "off".into();
            st.error = Some(v.clone());
            None
        } else {
            let t = transport::Transport {
                db: db.clone(),
                clock: clock.clone(),
                status: status.clone(),
                events: spec.events,
                control: ctl_rx,
                wrote,
                data_dir: spec.boot_dir,
                blob_policy: spec.blob_policy,
                allow_boot_source: spec.allow_boot_source,
                shutdown: shutdown_rx,
                // 正式 runtime 不用 BootCommitted latch(那是「加入空间」staging
                // transport 的接收位;main onboarding 的引导完成走既有事件/状态)。
                boot_commit: Arc::new(Mutex::new(None)),
                // 「须重开」旗直通 runtime(space-entry-plan §3.2 codex 一轮 M3):
                // transport 在 DETACH 终败**判定那一刻**置位,壳层写闸即时拒写——
                // 下面 run 返回后的 wrapper 赋值只是幂等兜底。
                restart_flag: restart_required.clone(),
                // 本空间在 app 级监听器上的席位(§6 准入表的键 = 空间 id)。壳没给
                // 监听器(手机)= None,直连的监听面整个不存在。
                lan: self.lan.as_ref().map(|a| transport::LanHost {
                    space_id: spec.id.clone(),
                    admission: Arc::clone(a),
                    // 注册者号 = 本次激活的代次(全局递增、永不复用),故 `stop` 说得出
                    // 「摘谁的」而不必等 transport 自己退出(lan-direct-plan §6:停机要
                    // **先**摘准入条目,再走既有停机 watch)。
                    owner: generation,
                }),
            };
            let restart = restart_required.clone();
            Some(self.rt.spawn(async move {
                // 结构化退出落壳侧信号(space-entry-plan §3.2 三轮 M2):transport
                // 自己已放弃重连,这里把「须重开」翻成 runtime 级 restart_required
                // ——壳的业务写闸据此拒写,直到 stop→重新 activate 或重启。
                if let transport::TransportExit::ReopenRequired { error } =
                    transport::run(t).await
                {
                    *restart.lock().expect("restart mutex poisoned") = Some(error);
                }
            }))
        };
        let rt = Arc::new(ActiveRuntime {
            id: spec.id.clone(),
            path: spec.path,
            generation,
            db,
            clock,
            status,
            control: ctl_tx,
            sync_veto: Mutex::new(spec.sync_veto),
            shutdown: shutdown_tx,
            join: Mutex::new(join),
            restart_required,
            ops: Arc::new(OpTracker::default()),
        });
        // 发布:Starting(token) → Running(仍持着上面验预留时取的同一把 live 写锁,
        // 验→建→插整段原子;槽从验到此从未放开)。
        live.insert(spec.id.clone(), Slot::Running(rt.clone()));
        Ok(rt)
    }

    /// **先摘局域网准入条目,再拉停机信号**(lan-direct-plan §6 / L-c3a 实现审 H1):翻
    /// Stopping 之后这个空间就不该再收下任何新的直连拨入了,而准入条目若要等 transport
    /// 自己退出才由 `AdmitLease` 摘,「已 Stopping 却还在认新链」的窗口就等于整个停机耗时
    /// (在飞长命令 + join,上界 10s)。同一句顺带 abort 该空间全部未移交的 pre-auth 握手
    /// 任务。幂等:transport 收场时那声 `deregister` 号对得上也只是重复摘一次。
    fn drop_lan_seat(&self, id: &str, generation: u64) {
        if let Some(lan) = &self.lan {
            // **最终撤席**(不是临时撤位):这一代 runtime 正在停机 / 重置,而它的 transport
            // 可能还没观察到停机信号——它每 15s 一轮的拨号巡查会拿着仍然存在的席位再注册
            // 一次,把条目复活(codex L-c3b 四轮 H1)。revoke 记下水位,同代及更早一律拒。
            lan.revoke(id, generation);
        }
    }

    /// 安全停机:Running→Stopping(占着 permit、`get` 即拒)→ 挡新长命令 + 拉高停机
    /// 信号 → 等在飞长命令(配对)放手旧 runtime/连接 → await 任务真退出 → 移除表项。
    /// 两段等待共用一个 10s deadline。任一步未按时完成 = Err 响亮,空间**留在 Stopping**
    /// (可再次 stop 重试)——绝不「从表消失但任务/长命令还活着」。对 Stopping 空间重复
    /// 调用 = 重试(信号幂等)。Starting(仅预留、无 runtime)不可停。
    pub async fn stop(&self, id: &str) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let rt = {
            let mut live = self.live.write().expect("live lock poisoned");
            match live.get_mut(id) {
                None => return Err(format!("未知空间:{id}")),
                Some(Slot::Starting(_)) => {
                    return Err(format!("空间 {id} 正在启动(预留中),无法停止"))
                }
                Some(Slot::Resetting(_)) => {
                    return Err(format!("空间 {id} 正在重置,无法停止"))
                }
                Some(slot) => {
                    let rt = match slot {
                        Slot::Running(rt) | Slot::Stopping(rt) => rt.clone(),
                        Slot::Starting(_) | Slot::Resetting(_) => unreachable!("已在上面拦截"),
                    };
                    *slot = Slot::Stopping(rt.clone());
                    rt
                }
            }
        };
        // 挡新长命令(begin_op 从此返回 None)+ 拉高停机信号(独立 watch:bounded
        // 控制通道可能被排队命令占位,不许拖住停机;任务与在飞长命令都在各自 await
        // 点收到)。veto 空间无任务、无人听,send 失败无妨。
        rt.ops.state.lock().expect("ops mutex poisoned").closing = true;
        self.drop_lan_seat(id, rt.generation);
        let _ = rt.shutdown.send(true);
        // H1:先等在飞的长命令(配对)放手旧 runtime/连接,调用方才可安全激活出下一
        // 条连接。notified 先登记(enable)再查计数,零丢唤醒;归零即过。超时=留
        // Stopping 可重试(半死长命令是要暴露的 bug)。
        loop {
            let waiter = rt.ops.done.notified();
            tokio::pin!(waiter);
            waiter.as_mut().enable();
            if rt.ops.state.lock().expect("ops mutex poisoned").active_ops == 0 {
                break;
            }
            if tokio::time::timeout_at(deadline, waiter).await.is_err() {
                return Err(format!(
                    "空间 {id} 有长命令(配对?)未在时限内退出——空间保持停止中,可重试"
                ));
            }
        }
        let handle = rt.join.lock().expect("join mutex poisoned").take();
        if let Some(mut h) = handle {
            match tokio::time::timeout_at(deadline, &mut h).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    // 任务 panic:不会再动库,移除表项、响亮上报(不吞成「停好了」)。
                    self.live.write().expect("live lock poisoned").remove(id);
                    return Err(format!("空间 {id} 传输任务异常退出:{e}"));
                }
                Err(_) => {
                    // 超时:handle 放回、空间留在 Stopping 继续占 permit——半死任务
                    // 是要暴露的 bug,不做「假装停干净」;再次 stop 可重试等待。
                    *rt.join.lock().expect("join mutex poisoned") = Some(h);
                    return Err(format!(
                        "空间 {id} 传输任务未在 10s 内退出(仍在收尾?)——空间保持停止中,可重试"
                    ));
                }
            }
        } else if rt.veto().is_none() {
            // 无 handle 又非 veto:另一个 stop 正拿着 handle 在等——别抢,响亮排队。
            return Err(format!("空间 {id} 的另一个停止操作正在等待任务退出"));
        }
        self.live.write().expect("live lock poisoned").remove(id);
        Ok(())
    }

    /// 空间重置的会话侧收场(epoch-plan §7,codex 三轮必修 5 的次序钉死):
    ///
    /// 1. `Running(Arc) → Resetting(token)` **原子换态**——Arc 从槽移出、槽留墓碑,
    ///    同 id 的 get/reserve/activate/stop 从这一刻起全拒(含新 boot 供流:供流
    ///    命令也经 `get`);空间不在表里(未激活)则直接插墓碑——文件操作期间同样
    ///    不许有人把它激活出来;
    /// 2. 挡新长命令 + 拉停机信号 + 等在飞长命令归零 + join transport 任务(与
    ///    [`stop`](Self::stop) 同一套等待,10s deadline);
    /// 3. 对移出的 runtime `Arc::try_unwrap`(**强引用归零证明**——调用方必须先放掉
    ///    自己手里的全部 Arc;短暂重试吸收在途命令的尾巴)→ 显式 drop `Connection`
    ///    (Unix/Android 上「删得动文件」不等于「没人写」:unlink 打开中的库会让旧
    ///    runtime 继续写匿名 inode,同路径再建新库 = 真双写分叉);
    /// 4. 返回 [`ResetTicket`]:**然后**调用方才做文件操作(spaces::reset_*),成功后
    ///    [`finish_reset`](Self::finish_reset) 按 token 删墓碑。
    ///
    /// 任一步失败 = Err 且**墓碑留下**(fail-closed:宁封锁不双写;重启进程后墓碑
    /// 消失,库若还在就恢复正常,库删了一半则按发现/journal 恢复语义走)。
    pub async fn begin_reset(&self, id: &str) -> Result<ResetTicket, String> {
        let token = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let rt = {
            let mut live = self.live.write().expect("live lock poisoned");
            match live.get(id) {
                None => {
                    // 未激活的空间:直接立墓碑,挡住文件操作期间的并发激活。
                    live.insert(id.to_string(), Slot::Resetting(token));
                    return Ok(ResetTicket { id: id.to_string(), token });
                }
                Some(Slot::Running(_)) => {
                    let Some(Slot::Running(rt)) = live.insert(id.to_string(), Slot::Resetting(token))
                    else {
                        unreachable!("上一行已证是 Running")
                    };
                    rt
                }
                Some(Slot::Starting(_)) => return Err(format!("空间 {id} 正在启动,无法重置")),
                Some(Slot::Stopping(_)) => return Err(format!("空间 {id} 正在停止,稍后重试")),
                Some(Slot::Resetting(_)) => return Err(format!("空间 {id} 已在重置中")),
            }
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        // 与 stop 同一套收场:挡新长命令、停机信号、等在飞长命令、join 任务。
        rt.ops.state.lock().expect("ops mutex poisoned").closing = true;
        self.drop_lan_seat(id, rt.generation);
        let _ = rt.shutdown.send(true);
        loop {
            let waiter = rt.ops.done.notified();
            tokio::pin!(waiter);
            waiter.as_mut().enable();
            if rt.ops.state.lock().expect("ops mutex poisoned").active_ops == 0 {
                break;
            }
            if tokio::time::timeout_at(deadline, waiter).await.is_err() {
                return Err(format!(
                    "空间 {id} 有长命令未在时限内退出——空间保持封锁(重置未完成),重启应用后重试"
                ));
            }
        }
        let handle = rt.join.lock().expect("join mutex poisoned").take();
        if let Some(h) = handle {
            match tokio::time::timeout_at(deadline, h).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    // 任务 panic:不会再动库,重置可以继续(墓碑仍在)。
                    // 与 stop 不同不上抛——重置本就要删这个库。
                    eprintln!("WARN 空间 {id} 传输任务异常退出(重置继续):{e}");
                }
                Err(_) => {
                    return Err(format!(
                        "空间 {id} 传输任务未在时限内退出——空间保持封锁(重置未完成),重启应用后重试"
                    ));
                }
            }
        }
        // 强引用归零证明:调用方已放掉自己的 Arc,这里短暂重试吸收在途命令尾巴。
        let mut rt = rt;
        let runtime = loop {
            match Arc::try_unwrap(rt) {
                Ok(owned) => break owned,
                Err(back) => {
                    rt = back;
                    if tokio::time::Instant::now() >= deadline {
                        return Err(format!(
                            "空间 {id} 的运行时仍被引用(有命令未放手)——空间保持封锁,重启应用后重试"
                        ));
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        };
        // 显式 drop Connection(强引用归零后 db Arc 必是最后一份;transport 已退出)。
        let db = Arc::try_unwrap(runtime.db)
            .map_err(|_| format!("空间 {id} 的库连接仍被引用(必是 bug)——空间保持封锁"))?;
        let conn = db.into_inner().expect("db mutex poisoned");
        drop(conn);
        Ok(ResetTicket { id: id.to_string(), token })
    }

    /// 重置文件操作全部成功后删墓碑(按 token,防误删后来者)。文件操作失败就**别
    /// 调它**——墓碑留下 fail-closed。
    pub fn finish_reset(&self, ticket: ResetTicket) {
        let mut live = self.live.write().expect("live lock poisoned");
        if matches!(live.get(&ticket.id), Some(Slot::Resetting(t)) if *t == ticket.token) {
            live.remove(&ticket.id);
        }
    }
}

/// [`SpaceSupervisor::begin_reset`] 的凭据:持有 = 会话侧已收场(连接已 drop)、
/// 墓碑在场,可以做文件操作;文件操作成功后交回 [`SpaceSupervisor::finish_reset`]。
/// **刻意不做 Drop 自动删墓碑**——文件操作失败时墓碑必须留下(fail-closed)。
#[derive(Debug)]
pub struct ResetTicket {
    id: String,
    token: u64,
}

impl ResetTicket {
    pub fn space_id(&self) -> &str {
        &self.id
    }
}

/// [`SpaceSupervisor::reserve`] 的凭据(M1):持坑到 [`commit`](Reservation::commit)
/// 或 Drop。commit 前 supervisor 表里是 `Starting(token)`,对命令面不可见、却已占
/// permit——开库/复核在此凭据保护下进行,失败即释放,绝不留下「开了连接却没进表」。
pub struct Reservation<'a> {
    sup: &'a SpaceSupervisor,
    id: String,
    token: u64,
    /// 仍未 commit:Drop 要回收这枚 Starting。commit 成功后置 false。
    active: bool,
}

impl Reservation<'_> {
    /// 把预留兑成 Running(见 [`SpaceSupervisor::commit_reservation`])。成功后不再由
    /// Drop 回收;失败(开库/复核 Err)保留 `active`,由 Drop 释放这枚 Starting。
    pub fn commit(
        mut self,
        spec: ActivateSpec,
        conn: Connection,
        clock: Clock,
    ) -> Result<Arc<ActiveRuntime>, String> {
        // 运行期(非 debug_assert)守 id 一致:错传 spec.id 直接 Err,让 Drop 清掉
        // 本预留(codex 二审 M2:release 下 debug_assert 空转会致 permit 泄漏)。
        if spec.id != self.id {
            return Err(format!(
                "commit 的 spec.id={} 与预留 id={} 不符(编排 bug)",
                spec.id, self.id
            ));
        }
        let r = self.sup.commit_reservation(self.token, spec, conn, clock);
        // **只在成功时**置 active=false(槽已成 Running,Drop 不再动)。任何 Err 都
        // 保留 active,交给带 token 的 Drop 裁决:槽仍是我的 Starting(token) 就回收、
        // 否则(已被换/已不在)matches! 守卫自然 no-op——不按错误字符串分类(M2)。
        if r.is_ok() {
            self.active = false;
        }
        r
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut live = self.sup.live.write().expect("live lock poisoned");
        // 只回收自己那枚 token 的 Starting(防 ABA:别删掉同 id 的后来者)。
        if matches!(live.get(&self.id), Some(Slot::Starting(t)) if *t == self.token) {
            live.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests;
