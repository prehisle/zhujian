//! 局域网直连的 **IO 面**(lan-direct-plan §6 / §7 / §10;L-c3a):本机接口枚举 +
//! app 级监听器与准入表 + pre-auth 握手任务。线协议、握手状态机、候选过滤那些**纯逻辑**
//! 在 [`super::lan`],这里只做「socket 与表」——两层分家的理由同 L-b:握手的密码学部分
//! 要能在没有 socket 的地方逐条对抗测。
//!
//! **为什么监听器是 app 级单例而不是每空间一只**(§6):一台机器只有一个 24618 端口,而
//! 桌面壳 eager 装配全部空间。故 socket 只有一只,拨入方靠 Intro 的 MAC 自证它找的是哪
//! 个空间(§4 步骤 1「逐 LanReady 空间代入,恰一命中才继续」)——准入表就是那份「逐空间
//! 代入」的材料,条目由各空间自己的 transport 注册与注销。
//!
//! **握手任务是第五条「拿当前身份干活」的出口**(§6 ⑤,L-c2c 五轮收口时立的开工约束):
//! 它跑在协调者之外、handoff 之前,既不在会话循环也不在离线泵里,故那四条出口的栅栏一条
//! 都盖不到它。本模块的对策 = 每个任务绑 `(space, epoch, 身份指纹)`,**每次跨 `.await`
//! 之后、发 Accept 或交 handoff 之前**重新自证(表侧 [`LanAdmission::epoch_current`] +
//! 库侧 [`transport::identity_still_current`]),失效即关 socket;撤位/停机则由
//! [`LanAdmission::deregister`] 当场 abort 该代全部未移交的任务。任务**只许产出
//! [`AdoptedLink`]**:它不碰引擎、不碰 peer-map、自己不发一枚 `Frame`。

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 拨号巡查的时刻用 **tokio 的钟**:协调者那边是 `sleep_until` 在等它,而 tokio 的
/// `pause()/advance()` 只拨得动这一只——用 `std::time::Instant` 的话,「退避到点」在
/// 测试里就只能靠真等。
use tokio::time::Instant as Deadline;

use rusqlite::Connection;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use super::lan;
use super::transport::{self, AdoptedLink};

// ---- §10 资源上界(一处一数) ------------------------------------------------------

/// pre-auth 全局并发。
const PREAUTH_MAX_INFLIGHT: usize = 8;
/// 每源 IP 并发。
const PREAUTH_MAX_PER_IP: usize = 2;
/// 无效尝试的全局令牌桶:10/s,桶深 10。**只有失败才花令牌**——合法握手一枚不花,故
/// 洪流打空桶时正常设备的直连仍能在下一秒挤进来;桶空即**静默丢**新连接(§10)。
const PREAUTH_FAIL_PER_SEC: f64 = 10.0;
const PREAUTH_FAIL_BURST: f64 = 10.0;
/// 首帧 2s / Accept 后等 Confirm 2s / 全握手 10s(§3 / §10)。
const FIRST_FRAME_SECS: u64 = 2;
const CONFIRM_SECS: u64 = 2;
const HANDSHAKE_SECS: u64 = 10;

const _: () = assert!(
    PREAUTH_MAX_INFLIGHT == 8 && PREAUTH_MAX_PER_IP == 2,
    "§10:pre-auth 全局并发 ≤8、每源 IP ≤2;改这两个数要同改 lan-direct-plan §10"
);

// ---- 本机接口枚举(§7 候选过滤与 §2 通告地址的共同料) ------------------------------

/// 本机当前活动接口的直连 IPv4 子网。**这是规格点名的「L-c 定点风险」**(跨平台枚举);
/// 实现取 `if-addrs`(unix 走 `getifaddrs`、windows 走 `GetAdaptersAddresses`,安卓在其
/// 支持矩阵内且 `getifaddrs` 的 `__INTRODUCED_IN(24)` 低于本项目 minSdk 30)。
///
/// **失败响亮**(不回退兜底):枚举不出来就不通告 listen、也不拨号——猜一个「裸 RFC1918
/// 全段」当候选正是 §7 要避免的误拨面。环回与不合法前缀逐条剔除,别的一律照收:是不是
/// 私网、是不是自身、在不在直连子网内,统统由 [`lan::check_candidate`] 在拨号时判。
pub(crate) fn local_subnets() -> Result<Vec<lan::LocalSubnet>, String> {
    let mut out = enumerate_subnets()?;
    // **规范形**(codex 二轮 L1):OS 的枚举顺序不保证稳定,而这份清单同时喂给「本机通告
    // 地址」与「网络变化判据」——顺序一抖就会误判成换网:白发一枚 Hello、白烧一个通告
    // 序号、还把全部退避清了。排序 + 去重让「同一组网卡」恒得同一份清单。**收在这个唯一
    // 出口**(不是收在枚举里面),故合成局域网那条测试路走的也是规范形。
    out.sort_by_key(|s| (u32::from(s.addr()), s.prefix()));
    out.dedup();
    Ok(out)
}

fn enumerate_subnets() -> Result<Vec<lan::LocalSubnet>, String> {
    // 合成局域网(见 [`TestNet`]):装了就顶掉真实枚举——同一台机器上的两实例集成测
    // 在结构上过不了 §7 的候选过滤,而过滤规则本身仍原样跑在这张合成网卡上。
    #[cfg(test)]
    if let Some(net) = TEST_NET.with(|c| c.borrow().as_ref().map(|n| n.subnets.clone())) {
        return net.ok_or_else(|| "枚举本机网络接口失败(合成局域网)".to_string());
    }
    let ifaces = if_addrs::get_if_addrs().map_err(|e| format!("枚举本机网络接口失败:{e}"))?;
    let mut out = vec![];
    for i in ifaces {
        let if_addrs::IfAddr::V4(v4) = i.addr else { continue };
        if v4.ip.is_loopback() || v4.ip.is_unspecified() {
            continue;
        }
        // 前缀不合法 = 那一张网卡整条跳过(`LocalSubnet::new` 的字段私有闸把 panic 面
        // 挡在构造处,这里只需别把它当致命错误——一张怪网卡不该让整机不能直连)。
        if let Ok(sub) = lan::LocalSubnet::new(v4.ip, v4.prefixlen) {
            out.push(sub);
        }
    }
    Ok(out)
}

// ---- 准入表 ------------------------------------------------------------------------

/// 一个空间交给监听器的材料(§6 准入表的一行)。
pub(crate) struct Registration {
    pub space_id: String,
    /// 注册者号(见 [`next_owner`]):注销时对得上才摘。
    pub owner: u64,
    pub account_id: String,
    pub self_device: String,
    pub k_acc: [u8; 32],
    pub self_seed: [u8; 32],
    /// 该空间的库(握手任务据它自证身份、读 `lan_peer:<from>` 的钉住公钥)。
    pub db: Arc<Mutex<Connection>>,
    /// 协调者发布的「此刻有活跃链的对端」(见 [`Registration::active`] 的用法说明)。
    /// **advisory 早退闸**:§4 步骤 1 的「已有活跃链 = 静默关」;权威仲裁恒在协调者的
    /// `LanLinks::admit`(§7 二级规则),故这份视图偏一拍两边都安全——说有其实没有 =
    /// 对端退避后重来;说没有其实有 = 落到 `admit` 按 `link_id` 判。
    pub active: Arc<Mutex<HashSet<String>>>,
    pub handoff: mpsc::Sender<AdoptedLink>,
}

/// 表里一行的当前态。
struct SpaceEntry {
    owner: u64,
    /// 注册代次(**全表单调、永不复用**):握手任务拿它自证「我认下的那个空间还是这一
    /// 代」。它比 supervisor 的 runtime generation 更细——同一 runtime 内换身份也会换
    /// 代,故「旧代连接可投递一帧」的窗口在表这一侧不存在(§6)。
    epoch: u64,
    account_id: String,
    self_device: String,
    k_acc: [u8; 32],
    self_seed: [u8; 32],
    db: Arc<Mutex<Connection>>,
    active: Arc<Mutex<HashSet<String>>>,
    handoff: mpsc::Sender<AdoptedLink>,
}

impl SpaceEntry {
    /// 身份指纹(账户 / 设备 / K_acc)相同 = 同一代身份,注册可原样续用不换代。
    fn same_identity(&self, r: &Registration) -> bool {
        self.owner == r.owner
            && self.account_id == r.account_id
            && self.self_device == r.self_device
            && self.k_acc == r.k_acc
            && self.self_seed == r.self_seed
    }
}

/// 一只在飞的 pre-auth 握手任务。
struct Inflight {
    /// 已认下的空间与代次(还没解析出 Intro 时是 `None`)。撤位按它挑该 abort 谁。
    bound: Option<(String, u64)>,
    abort: Option<tokio::task::AbortHandle>,
    /// 撤位时这只任务已被判死,但**句柄还没装上**(多线程 runtime 下,新任务可能在
    /// `accept_loop` 调 [`LanAdmission::set_abort`] 之前就跑到了认空间那一步)。没有这
    /// 一位的话那次 abort 会静默落空——正确性不受影响(它随后的逐步自证照样拒绝移交),
    /// 但它会一直占着 pre-auth 名额直到 10s 超时。置位后由 `set_abort` 当场补刀。
    doomed: bool,
}

/// 无效尝试的令牌桶(§10)。
struct Bucket {
    tokens: f64,
    last: Instant,
}

impl Bucket {
    fn refill(&mut self, now: Instant) {
        let dt = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + dt * PREAUTH_FAIL_PER_SEC).min(PREAUTH_FAIL_BURST);
    }
}

struct Table {
    /// 惰性绑定的落点(§7:首个已配置同步空间的 transport 注册时才 bind)。绑上之后
    /// **不再解绑**:端口一变通告序号就得递增、对端缓存里的旧端口即刻作废,为「此刻恰好
    /// 没有 LanReady 空间」付这个代价不值。
    port: Option<u16>,
    accept: Option<tokio::task::JoinHandle<()>>,
    next_epoch: u64,
    next_task: u64,
    spaces: HashMap<String, SpaceEntry>,
    /// 每空间的重复抑制缓存(§4)。**与 `spaces` 分家住**:`resolve_intro` 借的是
    /// `spaces`(不可变),而 `accept` 要 `&mut DupCache`——同一个 map 里两件事借不开。
    dups: HashMap<String, lan::DupCache>,
    tasks: HashMap<u64, Inflight>,
    per_ip: HashMap<IpAddr, usize>,
    bucket: Bucket,
    /// 重复抑制缓存的时间轴:**单调刻度不是墙钟**(L-b L6:墙钟回拨会让条目超期不失效、
    /// 满缓存长期拒新 Intro)。
    start: Instant,
    /// 收到过多少枚拨入连接(见 [`LanAdmission::admit_conn`] 里那条注释)。
    arrivals: u64,
    /// 注册(含幂等续注册)次数(见 [`LanAdmission::registrations`])。
    registrations: u64,
    /// **最终撤销水位**:space → 已被 supervisor 最终撤席的最高注册者号。见
    /// [`LanAdmission::revoke`]。
    ///
    /// **真实上界 = 本进程生命期内被撤席过的不同 space_id 数**(codex 五轮 L1 校正了原先
    /// 「条数 = 空间数」那句不实的说法):同一空间反复 stop/reset 只覆盖同一格,但建了又
    /// 删的不同空间会各留一格。每格 = 一个 ULID + 一个 u64,而每个空间都要用户显式建库或
    /// 加入才存在,故实际到不了值得回收的量级。**刻意不回收**:「更高 owner 注册成功就删
    /// 水位」会让更老的迟到撤席重新变成可复活面(四轮 H1 那个洞),而安全的回收时机要等
    /// 「该空间全部旧 transport 都已 join」——那是 supervisor 的事实,不该拿进这张表里。
    /// 排在 261 可优化项。
    revoked: HashMap<String, u64>,
}

/// **app 级监听器与准入表**(§6)。桌面壳一枚;手机壳不监听故整个不建(`Transport.lan`
/// 传 `None`)。
pub struct LanAdmission {
    /// 监听落点。生产恒 `0.0.0.0:24618`(被占退临时端口);测试走
    /// [`LanAdmission::ephemeral`] 绑 `127.0.0.1:0`,免并跑用例抢同一个端口。
    bind: SocketAddr,
    /// 指向自己的弱引用(`Arc::new_cyclic` 装):接受循环拿它,表被丢弃时循环自己收场。
    /// **刻意是 `Weak`**——强引用会成环,测试里每个用例一枚表就永远不释放。
    me: std::sync::Weak<LanAdmission>,
    inner: Mutex<Table>,
}

impl LanAdmission {
    pub fn new() -> Arc<LanAdmission> {
        LanAdmission::at(SocketAddr::from((Ipv4Addr::UNSPECIFIED, lan::DEFAULT_LAN_PORT)))
    }

    /// 测试用:绑环回随机端口(用例之间不抢 24618)。
    #[cfg(test)]
    pub(crate) fn ephemeral() -> Arc<LanAdmission> {
        LanAdmission::at(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
    }

    fn at(bind: SocketAddr) -> Arc<LanAdmission> {
        Arc::new_cyclic(|me| LanAdmission {
            bind,
            me: me.clone(),
            inner: Mutex::new(Table {
                port: None,
                accept: None,
                next_epoch: 0,
                next_task: 0,
                spaces: HashMap::new(),
                dups: HashMap::new(),
                tasks: HashMap::new(),
                per_ip: HashMap::new(),
                bucket: Bucket { tokens: PREAUTH_FAIL_BURST, last: Instant::now() },
                start: Instant::now(),
                arrivals: 0,
                registrations: 0,
                revoked: HashMap::new(),
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Table> {
        self.inner.lock().expect("lan admission mutex poisoned")
    }

    /// 注册/续注册一个空间,返回**本机监听端口**(调用方拿它填 `LanAd.listen`)。
    ///
    /// 幂等:同一注册者、同一身份指纹 = 原样续用(**不换代**,否则每轮重连都会把在飞的
    /// 握手全 abort 掉);换了身份 = 换代并当场 abort 旧代未移交的任务(§4「本机身份换代
    /// 由 session_gate 拆全部 lan 链路」的 pre-auth 那一半)。
    ///
    /// 首个注册者顺带**惰性绑定**监听 socket。绑不上(端口全被占 / 无权限)= 响亮 `Err`
    /// ——调用方据此不通告 listen(通告一个连不上的端口只会让对端白拨)。
    pub(crate) fn register(&self, reg: Registration) -> Result<u16, String> {
        let mut t = self.lock();
        t.registrations += 1;
        // **已被最终撤销的代次不许回来**(codex 四轮 H1):stop/reset 的顺序是「先摘条目 →
        // 再拉停机信号 → 最后等 transport 退出」,而那个 transport 观察到停机之前,它每
        // 15s 一轮的拨号巡查还会拿着**仍然存在的** `AdmitSeat` 幂等续注册一次——放行就等于
        // 把「Stopping 之后不再认新链」那道闸重新打开(条目复活、新拨入又命中得了)。
        // 只在这把锁内判,故与撤席之间没有缝;更高代次(新 runtime)照常。
        if t.revoked.get(&reg.space_id).is_some_and(|w| reg.owner <= *w) {
            return Err("本 runtime 的局域网席位已撤销(空间正在停机或重置)".into());
        }
        if t.port.is_none() {
            let (listener, port) = bind_listener(self.bind)?;
            t.accept = Some(tokio::spawn(accept_loop(self.me.clone(), listener)));
            t.port = Some(port);
        }
        let port = t.port.expect("刚绑上");
        if t.spaces.get(&reg.space_id).is_some_and(|e| e.same_identity(&reg)) {
            // 同一代身份续注册:只把可能换了的把手刷新(handoff 通道随 `run` 生灭)。
            let e = t.spaces.get_mut(&reg.space_id).expect("刚查过在");
            e.handoff = reg.handoff;
            e.active = reg.active;
            e.db = reg.db;
            return Ok(port);
        }
        t.next_epoch += 1;
        let epoch = t.next_epoch;
        abort_bound_to(&mut t, &reg.space_id);
        t.dups.insert(reg.space_id.clone(), lan::DupCache::new());
        t.spaces.insert(
            reg.space_id.clone(),
            SpaceEntry {
                owner: reg.owner,
                epoch,
                account_id: reg.account_id,
                self_device: reg.self_device,
                k_acc: reg.k_acc,
                self_seed: reg.self_seed,
                db: reg.db,
                active: reg.active,
                handoff: reg.handoff,
            },
        );
        Ok(port)
    }

    /// 摘条目(§6「supervisor `stop` 先摘准入条目 + 取消该代未移交的 pre-auth 任务」;
    /// LanReady 的三档撤位与 `run` 收场同样经它)。**认注册者号**:旧 runtime 迟到的那声
    /// 注销摘不掉新 runtime 的条目。
    pub(crate) fn deregister(&self, space_id: &str, owner: u64) {
        drop_entry(&mut self.lock(), space_id, owner);
    }

    /// **最终撤席**(supervisor 的 `stop` / `begin_reset` 专用):摘条目 + abort 未移交
    /// 握手,**并记下撤销水位**——同代及更早的注册此后一律拒(见 [`LanAdmission::register`]
    /// 里那段:旧 runtime 的巡查会拿着还没失效的席位把条目复活)。新 runtime 的更高代次
    /// 照常注册,故这不是「这个空间从此不能直连」。
    pub(crate) fn revoke(&self, space_id: &str, owner: u64) {
        let mut t = self.lock();
        let w = t.revoked.entry(space_id.to_string()).or_insert(0);
        *w = (*w).max(owner);
        drop_entry(&mut t, space_id, owner);
    }

    /// 表侧自证:这枚任务认下的那一代还在吗。
    fn epoch_current(&self, bound: &Bound) -> bool {
        self.lock().spaces.get(&bound.space).is_some_and(|e| e.epoch == bound.epoch)
    }

    /// 收一枚新连接的许可(§10 三道上界)。`None` = 静默丢。
    ///
    /// **令牌在这里就预占掉**(实现审 M1):只查不扣的话,同一枚令牌在结果回来之前能同时
    /// 放进最多 8 条连接(全局槽数),每补回一枚就又放一批——实际速率远超规格的 10/s。
    /// 预占 + [`LanAdmission::refund`](合法建链与本机侧原因才退)= 令牌是**一次性许可**,
    /// 而「合法握手净零消耗」这条语义不变。
    fn admit_conn(&self, ip: IpAddr) -> Option<u64> {
        let mut t = self.lock();
        // 「有人连过来过」的计数(测试锚):§7 一级规则的阴性对照要能指认「大 id 那端一枚
        // Intro 都没发」——那件事在**对端的监听口上**才看得见。记在三道上界之前,故被静默
        // 丢掉的连接也算数。
        t.arrivals += 1;
        let now = Instant::now();
        t.bucket.refill(now);
        if t.bucket.tokens < 1.0 {
            return None;
        }
        if t.tasks.len() >= PREAUTH_MAX_INFLIGHT {
            return None;
        }
        if t.per_ip.get(&ip).copied().unwrap_or(0) >= PREAUTH_MAX_PER_IP {
            return None;
        }
        t.next_task += 1;
        let id = t.next_task;
        t.tokens_sub();
        *t.per_ip.entry(ip).or_insert(0) += 1;
        t.tasks.insert(id, Inflight { bound: None, abort: None, doomed: false });
        Some(id)
    }

    fn set_abort(&self, id: u64, abort: tokio::task::AbortHandle) {
        let mut t = self.lock();
        // 任务可能已经跑完并自摘(guard 的 Drop);那就没有句柄可存。
        let Some(f) = t.tasks.get_mut(&id) else { return };
        // 装句柄之前就被判死过 = 那次 abort 落了空,这里补刀(见 [`Inflight::doomed`])。
        if f.doomed {
            abort.abort();
            return;
        }
        f.abort = Some(abort);
    }

    /// 任务收场:交还并发额度。
    fn finish(&self, id: u64, ip: IpAddr) {
        let mut t = self.lock();
        t.tasks.remove(&id);
        if let Some(n) = t.per_ip.get_mut(&ip) {
            *n -= 1;
            if *n == 0 {
                t.per_ip.remove(&ip);
            }
        }
    }

    /// 退还预占的那一枚令牌(§10):合法建链与**本机侧**原因(身份换代 / 条目已摘 /
    /// 移交队满)才退——那不是对端的无效尝试,拿它去关限速阀等于让真攻击更容易打空桶。
    /// 对端给的东西不对 / 超时 = 留着不退,那正是「无效尝试」要花的那一枚。
    fn refund(&self) {
        let mut t = self.lock();
        let now = Instant::now();
        t.bucket.refill(now);
        t.bucket.tokens = (t.bucket.tokens + 1.0).min(PREAUTH_FAIL_BURST);
    }

    /// 全表恰一命中 → 认下空间与代次(§4 步骤 1)。**认下即登记进任务表**,此后撤位能
    /// 精确 abort 到它。
    fn bind_task(&self, id: u64, intro: &lan::Intro<'_>) -> Option<Bound> {
        let mut t = self.lock();
        let space = {
            let entries = admit_entries(&t.spaces);
            lan::resolve_intro(&entries, intro).ok()?.space_id().to_string()
        };
        let e = t.spaces.get(&space)?;
        let bound = Bound {
            space: space.clone(),
            epoch: e.epoch,
            id: LanIdentity {
                account_id: e.account_id.clone(),
                self_device: e.self_device.clone(),
                k_acc: e.k_acc,
                self_seed: e.self_seed,
                db: Arc::clone(&e.db),
            },
            active: Arc::clone(&e.active),
            handoff: e.handoff.clone(),
        };
        if let Some(f) = t.tasks.get_mut(&id) {
            f.bound = Some((space, bound.epoch));
        }
        Some(bound)
    }

    /// §4 步骤 1-2 的临界区:**重解析一次全表**(凭据只在锁内活,故「resolve 完再换代」
    /// 这条 TOCTOU 由借用检查器堵死)→ 必须仍命中同一空间同一代 → `accept` 里按规格闸序
    /// 逐条判(MAC 复验 → 重复抑制登记 → 缓存公钥 → 已有活跃链)。
    fn accept(
        &self,
        bound: &Bound,
        intro: &lan::Intro<'_>,
        gate: &lan::IntroGate<'_>,
    ) -> AcceptOutcome {
        let mut t = self.lock();
        let now_ms = t.start.elapsed().as_millis() as u64;
        let Table { spaces, dups, .. } = &mut *t;
        // 下面三条「不合」全是**本机侧**的:条目在这一窗里换代 / 被摘 / 重解析改指别的
        // 空间——都不是对端的无效尝试,故与 `PeerRejected` 分型(§10 的令牌只花在后者
        // 身上,见 [`TokenLease`])。
        if !spaces.get(&bound.space).is_some_and(|e| e.epoch == bound.epoch) {
            return AcceptOutcome::LocalStale;
        }
        let entries = admit_entries(&*spaces);
        let Ok(resolved) = lan::resolve_intro(&entries, intro) else {
            return AcceptOutcome::LocalStale;
        };
        if resolved.space_id() != bound.space.as_str() {
            return AcceptOutcome::LocalStale;
        }
        let Some(dup) = dups.get_mut(&bound.space) else { return AcceptOutcome::LocalStale };
        // 这一步的 Err 才是对端的事:重复抑制、无钉住的公钥、已有活跃链、材料不对。
        match lan::LanListener::accept(&resolved, gate, dup, now_ms) {
            Ok((listener, wire)) => AcceptOutcome::Ready(listener, wire),
            Err(_) => AcceptOutcome::PeerRejected,
        }
    }

    #[cfg(test)]
    pub(crate) fn listen_port(&self) -> Option<u16> {
        self.lock().port
    }

    #[cfg(test)]
    pub(crate) fn epoch_of(&self, space_id: &str) -> Option<u64> {
        self.lock().spaces.get(space_id).map(|e| e.epoch)
    }

    /// 测试用:把令牌桶按在某个水位(时间轴一并重置,故不会被「跑到这里已过了几毫秒」
    /// 悄悄补上)。
    #[cfg(test)]
    pub(crate) fn set_tokens_for_test(&self, tokens: f64) {
        self.lock().bucket = Bucket { tokens, last: Instant::now() };
    }

    #[cfg(test)]
    pub(crate) fn inflight(&self) -> usize {
        self.lock().tasks.len()
    }

    /// 这个监听口收到过多少枚拨入连接(§7 一级规则的观测面)。
    #[cfg(test)]
    pub(crate) fn arrivals(&self) -> u64 {
        self.lock().arrivals
    }

    /// 注册过多少次(**巡查还活着**的观测面:每轮 `lan_dial_tick` 都会幂等续注册一次)。
    #[cfg(test)]
    pub(crate) fn registrations(&self) -> u64 {
        self.lock().registrations
    }
}

impl Table {
    fn tokens_sub(&mut self) {
        self.bucket.tokens = (self.bucket.tokens - 1.0).max(0.0);
    }
}

/// 借出「逐 LanReady 空间代入」的材料面(`LanAdmit` 里全是 `&str`/`&[u8;32]`,借的正是
/// 这张表)。**按 space_id 排序**:多命中的判定与顺序无关,但排序让诊断与测试可复现。
fn admit_entries(spaces: &HashMap<String, SpaceEntry>) -> Vec<lan::LanAdmit<'_>> {
    let mut v: Vec<lan::LanAdmit<'_>> = spaces
        .iter()
        .map(|(k, e)| lan::LanAdmit {
            space_id: k.as_str(),
            account_id: &e.account_id,
            k_acc: &e.k_acc,
            self_seed: &e.self_seed,
            self_device: &e.self_device,
        })
        .collect();
    v.sort_by(|a, b| a.space_id.cmp(b.space_id));
    v
}

/// 摘一条准入条目(**认注册者号**:旧 runtime 迟到的那声注销摘不掉新 runtime 的条目)。
/// [`LanAdmission::deregister`](临时撤位,同一个 `run` 之后还可能回来)与
/// [`LanAdmission::revoke`](最终撤席)共用这一手。
fn drop_entry(t: &mut Table, space_id: &str, owner: u64) {
    if !t.spaces.get(space_id).is_some_and(|e| e.owner == owner) {
        return;
    }
    t.spaces.remove(space_id);
    t.dups.remove(space_id);
    abort_bound_to(t, space_id);
}

/// abort 掉认在该空间的全部未移交任务(§6:撤位与换代都要**当场**取消,不等它们自己
/// 到超时——「摘了条目但旧任务还能交一条链」正是准入表要关的窗)。
fn abort_bound_to(t: &mut Table, space_id: &str) {
    for f in t.tasks.values_mut() {
        let Some((s, _)) = &f.bound else { continue };
        if s != space_id {
            continue;
        }
        // 先判死再 abort:句柄可能还没装上(多线程 runtime 下 `set_abort` 与任务开跑是
        // 赛跑),那一位让 `set_abort` 接着补刀,故这次撤位绝不会静默落空。
        f.doomed = true;
        if let Some(a) = &f.abort {
            a.abort();
        }
    }
}

/// [`LanAdmission::accept`] 的三种结局。**刻意不是 `Option`**(实现审二轮 M1):
/// 「本机侧不合」与「对端给的东西不对」混成一个 `None` 的话,撤位换代那一刻的失败会被
/// 记成一次无效尝试、白花一枚令牌。
enum AcceptOutcome {
    Ready(lan::LanListener, lan::LanWire),
    /// 本机侧:条目换代 / 被摘 / 重解析改指别的空间。
    LocalStale,
    /// 对端侧:重复抑制、无钉住的公钥、已有活跃链、材料不对。
    PeerRejected,
}

/// 一枚握手任务绑住的本机身份(§6 ⑤ 的「身份指纹」那一件)。**入站与出站共用同一个
/// 类型、同一个 [`Self::current`]**:两侧对称不是靠两处各写一遍同样的四件比对,而是
/// 结构事实——拨号侧要松一档得先把这个类型改坏。
#[derive(Clone)]
struct LanIdentity {
    account_id: String,
    self_device: String,
    k_acc: [u8; 32],
    self_seed: [u8; 32],
    /// 该空间的库(自证身份、读 `lan_peer:<peer>` 的钉住公钥)。
    db: Arc<Mutex<Connection>>,
}

impl LanIdentity {
    /// 库侧自证(§6 ⑤):与会话循环、离线泵那几条出口**同一把尺**——pending 身份封闸 +
    /// 账户/设备/K_acc/种子四件逐一比对。换代不保证有人 poke 控制通道(纪元压实是库自己
    /// 悄悄换的),故这一问必须真读库,不能只信表。
    fn current(&self) -> bool {
        transport::identity_still_current(
            &self.db,
            &self.account_id,
            &self.self_device,
            &self.k_acc,
            &self.self_seed,
        )
    }
}

/// 握手任务认下的那一代空间(全是拷贝:锁在这之后就放掉了)。
struct Bound {
    space: String,
    epoch: u64,
    id: LanIdentity,
    active: Arc<Mutex<HashSet<String>>>,
    handoff: mpsc::Sender<AdoptedLink>,
}

// ---- 监听 socket ------------------------------------------------------------------

/// 绑监听口:先试规格端口 24618,被占退临时端口(§7);两次都失败 = 响亮 `Err`。
fn bind_listener(bind: SocketAddr) -> Result<(TcpListener, u16), String> {
    let std_listener = match std::net::TcpListener::bind(bind) {
        Ok(l) => l,
        Err(first) => {
            let fallback = SocketAddr::new(bind.ip(), 0);
            std::net::TcpListener::bind(fallback)
                .map_err(|e| format!("局域网监听绑不上({bind}:{first};临时端口:{e})"))?
        }
    };
    std_listener.set_nonblocking(true).map_err(|e| format!("监听口设非阻塞失败:{e}"))?;
    let port = std_listener
        .local_addr()
        .map_err(|e| format!("读监听端口失败:{e}"))?
        .port();
    let listener =
        TcpListener::from_std(std_listener).map_err(|e| format!("监听口交给 tokio 失败:{e}"))?;
    Ok((listener, port))
}

/// 接受循环。**持 `Weak`**:表被丢弃(测试里每个用例一枚)时循环自己收场,不靠谁记得
/// abort;生产上它活到进程结束。
async fn accept_loop(adm: std::sync::Weak<LanAdmission>, listener: TcpListener) {
    loop {
        let Ok((stream, addr)) = listener.accept().await else {
            // accept 出错多是瞬态(fd 用尽 / 对端 RST):歇一拍再来,别把监听器烧成死循环。
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        };
        let Some(adm) = adm.upgrade() else { return };
        let ip = addr.ip();
        // 上界不过 = **静默丢**(§10:直连不可用,中转照常)。
        let Some(id) = adm.admit_conn(ip) else { continue };
        let task = tokio::spawn(serve_conn(Arc::clone(&adm), stream, id, ip));
        adm.set_abort(id, task.abort_handle());
    }
}

/// 一枚 pre-auth 握手的结局。
enum PreAuth {
    /// 链路已交给协调者。
    Adopted,
    /// 对端给的东西不对(格式 / MAC / 签名 / 重放 / 无缓存公钥……)= 花一枚令牌。
    Rejected,
    /// **本机侧**的原因(身份换代 / 条目已摘 / handoff 队满):不花令牌——那是本机的
    /// 处境,不是对端的无效尝试,拿它去关限速阀会让真攻击更容易打空桶。
    Aborted,
}

async fn serve_conn(adm: Arc<LanAdmission>, stream: TcpStream, id: u64, ip: IpAddr) {
    let mut guard = ConnGuard { adm: Arc::clone(&adm), id, ip, spend: false };
    let out = tokio::time::timeout(
        Duration::from_secs(HANDSHAKE_SECS),
        handshake(&adm, stream, id),
    )
    .await;
    // 只有「对端给的东西不对」与全握手超时才**真花掉**那一枚(§10 的「无效尝试」;慢速
    // 攻击正是超时那一条要挡的)。别的一律走 guard 的默认退款——见 [`ConnGuard::spend`]。
    guard.spend = !matches!(out, Ok(PreAuth::Adopted) | Ok(PreAuth::Aborted));
}

/// 并发额度的交还点。**放在 `Drop` 里**:abort 落在 `.await` 上会展开这只任务,guard
/// 照样析构——「撤位 abort 之后额度漏了没还」在结构上不存在。
struct ConnGuard {
    adm: Arc<LanAdmission>,
    id: u64,
    ip: IpAddr,
    /// 这一枚预占的令牌该花掉吗。**默认 false = 退款**(实现审二轮 M1):撤位 abort 会
    /// 把这只任务连同它后面的分类记账一起丢掉,`Drop` 却照跑——把「花掉」做成需要显式
    /// 置位的例外,本机侧的取消(stop / reset / 身份换代 / panic)就自动不算无效尝试。
    /// 反过来写(默认花掉、成功再退)的话,一次撤位最多白烧 8 枚全局令牌。
    spend: bool,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.adm.finish(self.id, self.ip);
        if !self.spend {
            self.adm.refund();
        }
    }
}

/// §4 的三步握手(监听侧)。**每一步 `Err`/不合都直接 return**——socket 随栈上的
/// `stream` 一起落地(codex L-b 点名的「所有 `Err` 之后 socket 必关」)。
async fn handshake(adm: &Arc<LanAdmission>, mut stream: TcpStream, id: u64) -> PreAuth {
    // ① 首帧 Intro:2s、≤4 KiB(长度前缀在**分配前**过闸,见 `read_wire`)。
    let Ok(Ok(wire)) = tokio::time::timeout(
        Duration::from_secs(FIRST_FRAME_SECS),
        read_wire(&mut stream, lan::FramePhase::PreAuth),
    )
    .await
    else {
        return PreAuth::Rejected;
    };
    let Ok(intro) = lan::Intro::parse(&wire) else { return PreAuth::Rejected };

    // ② 认空间:全表恰一命中(零命中/多命中一律静默关)。
    let Some(bound) = adm.bind_task(id, &intro) else { return PreAuth::Rejected };

    // ③ **跨过一次 `.await` 了,先自证**(§6 ⑤),再取两条门面事实。
    if !bound.id.current() {
        return PreAuth::Aborted;
    }
    let peer_ad = {
        let conn = bound.id.db.lock().expect("db mutex poisoned");
        transport::read_peer_ad(&conn, intro.from)
    };
    // 缓存读不动 = 当「没缓存」就等于让首见钉住反复触发(§2),故 fail-closed 直接关。
    let Ok(peer_ad) = peer_ad else { return PreAuth::Aborted };
    let pubkey = peer_ad.as_ref().and_then(|a| a.usable_pubkey());
    let link_active = bound
        .active
        .lock()
        .expect("lan active view mutex poisoned")
        .contains(intro.from);
    let gate = lan::IntroGate { peer_pubkey: pubkey.as_ref(), peer_link_active: link_active };

    // ④ 临界区里过闸并出 Accept(重复抑制的槽在这里烧掉:花掉即花掉)。**表侧代次的
    // 自证就在这个临界区里**(`accept` 头一件事就是复核 `bound.epoch`),故 ③ 的库侧 +
    // ④ 的表侧合起来正是「发 Accept 之前重新自证」那一条(§6 ⑤)——③ 到下面这行写出
    // 之间**没有 `.await`**(全是同步的锁与纯计算),再补一次检查只是同一份读数抄两遍。
    let (mut listener, accept) = match adm.accept(&bound, &intro, &gate) {
        AcceptOutcome::Ready(l, w) => (l, w),
        AcceptOutcome::LocalStale => return PreAuth::Aborted,
        AcceptOutcome::PeerRejected => return PreAuth::Rejected,
    };
    if write_wire(&mut stream, &accept).await.is_err() {
        return PreAuth::Rejected;
    }

    // ⑥ 等 Confirm:2s(§10「Accept 发出后等 Confirm ≤2s」——重放旧 Intro 至多占一个
    // 2s 的后置槽,不是 10s)。
    let Ok(Ok(wire)) = tokio::time::timeout(
        Duration::from_secs(CONFIRM_SECS),
        read_wire(&mut stream, lan::FramePhase::PreAuth),
    )
    .await
    else {
        return PreAuth::Rejected;
    };
    let Ok(established) = listener.on_confirm(&wire) else { return PreAuth::Rejected };

    // ⑦ **交 handoff 之前最后自证一次**(§6 ⑤)。
    if !adm.epoch_current(&bound) || !bound.id.current() {
        return PreAuth::Aborted;
    }
    // `try_send` 不 await:协调者一有空就取,队满(4 枚)说明它正忙——关掉这条,对端
    // 退避后重来,绝不让握手任务挂在通道上占着 pre-auth 名额。
    match bound.handoff.try_send(AdoptedLink { established, stream }) {
        Ok(()) => PreAuth::Adopted,
        Err(_) => PreAuth::Aborted,
    }
}

// ---- 帧的读写(pre-auth 面;L-c3b 的拨号器同用) --------------------------------------

/// 读一枚 [`lan::LanWire`]。长度前缀**在分配前**过阶段上限(§3 / L-b M4):`u32` 能声明
/// 4 GiB,等读满再查已经晚了。恰读 4+n 字节,**绝不多读一个字节**——握手完成后这条
/// socket 原样交给链路集的读泵,预读会把对端紧接着发来的第一枚数据帧吞掉。
pub(crate) async fn read_wire<R: tokio::io::AsyncRead + Unpin>(
    rd: &mut R,
    phase: lan::FramePhase,
) -> Result<lan::LanWire, String> {
    let mut prefix = [0u8; 4];
    rd.read_exact(&mut prefix).await.map_err(|e| format!("读长度前缀:{e}"))?;
    let n = lan::checked_body_len(prefix, phase).map_err(|e| e.to_string())?;
    let mut body = vec![0u8; n];
    rd.read_exact(&mut body).await.map_err(|e| format!("读帧体:{e}"))?;
    lan::decode_wire(&body, phase).map_err(|e| e.to_string())
}

pub(crate) async fn write_wire<W: tokio::io::AsyncWrite + Unpin>(
    wr: &mut W,
    wire: &lan::LanWire,
) -> Result<(), String> {
    let bytes = lan::frame_bytes(wire).map_err(|e| e.to_string())?;
    wr.write_all(&bytes).await.map_err(|e| format!("写帧:{e}"))
}

// ---- 拨号器(lan-direct-plan §7;L-c3b) ----------------------------------------------

/// 每对端退避:15s 起、翻倍、封顶 300s(§7 / §10)。**规格数值锚**同 `LAN_OFFLINE_HELLO_SECS`
/// 那条(实现审三轮 M1):行为测把它压到毫秒级去验形状,数值由这行守着。
const DIAL_BACKOFF_BASE_SECS: u64 = 15;
const DIAL_BACKOFF_MAX_SECS: u64 = 300;
const _: () = assert!(
    DIAL_BACKOFF_BASE_SECS == 15 && DIAL_BACKOFF_MAX_SECS == 300,
    "§7/§10:拨号退避 15s→300s;改这两个数要同改 lan-direct-plan §7/§10"
);
/// 空闲巡查间隔(见 [`Dialer::due`])。**规格数值锚**同 `LAN_OFFLINE_HELLO_SECS` 那条:
/// 行为测拿线程局部覆盖位把它压到毫秒级去验「计时器还武装着」,那条测因此证不了这个数。
const DIAL_IDLE_POLL_SECS: u64 = 15;
const _: () = assert!(
    DIAL_IDLE_POLL_SECS == 15,
    "§7/§10:空闲巡查 15s;改这个数要同改 lan-direct-plan §7/§10"
);

/// 巡查间隔(测试可压到毫秒级,见 [`IdlePollGuard`])。
fn dial_idle_poll() -> Duration {
    #[cfg(test)]
    if let Some(ms) = IDLE_POLL_MS.with(|c| c.get()) {
        return Duration::from_millis(ms);
    }
    Duration::from_secs(DIAL_IDLE_POLL_SECS)
}

#[cfg(test)]
thread_local! {
    static IDLE_POLL_MS: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// 巡查间隔覆盖位的 RAII 把手(实现审三轮 M1 的教训:线程局部覆盖位必须由 guard 复位,
/// 否则同一条测试工作线程上后面的用例会被传染)。
#[cfg(test)]
pub(crate) struct IdlePollGuard;

#[cfg(test)]
impl IdlePollGuard {
    pub(crate) fn install(ms: u64) -> IdlePollGuard {
        IDLE_POLL_MS.with(|c| c.set(Some(ms)));
        IdlePollGuard
    }
}

#[cfg(test)]
impl Drop for IdlePollGuard {
    fn drop(&mut self) {
        IDLE_POLL_MS.with(|c| c.set(None));
    }
}
/// 每空间在飞的出站握手上界(§10)。远低于链路上界 16——拨号是本机主动行为,不是对端
/// 可灌的面;有它只是为了「64 条缓存记录同时到期」时不一次性开 64 只任务。
const DIAL_MAX_INFLIGHT: usize = 4;
/// 单个候选地址的 TCP 连接超时(局域网内正常是亚毫秒;这个数是给「地址已易主、对方装了
/// 防火墙丢包」那种情形的)。
const DIAL_CONNECT_SECS: u64 = 2;
/// 发出 Intro 后等 Accept(与监听侧「Accept 发出后等 Confirm ≤2s」同一档,§10)。
const DIAL_ACCEPT_SECS: u64 = 2;

/// 出站握手那两道计时(整只任务 [`HANDSHAKE_SECS`] / 等 Accept [`DIAL_ACCEPT_SECS`])。
/// **测试可整体拉长**,见 [`DialBudgetGuard`]。
fn dial_handshake_budget() -> Duration {
    #[cfg(test)]
    if let Some(secs) = DIAL_BUDGET_SECS.with(|c| c.get()) {
        return Duration::from_secs(secs);
    }
    Duration::from_secs(HANDSHAKE_SECS)
}

fn dial_accept_budget() -> Duration {
    #[cfg(test)]
    if let Some(secs) = DIAL_BUDGET_SECS.with(|c| c.get()) {
        return Duration::from_secs(secs);
    }
    Duration::from_secs(DIAL_ACCEPT_SECS)
}

#[cfg(test)]
thread_local! {
    static DIAL_BUDGET_SECS: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// 出站握手计时的覆盖位(RAII 把手,理由同 [`IdlePollGuard`])。
///
/// **为什么非有它不可**:验「撤位当场取消在飞的出站握手」时,阳性判据是「socket 现在就
/// 关了」,而它之所以**可证伪**,全靠「没人取消的话这只任务得等自己的计时到点才落地」。
/// 生产的那两个数是 2s / 10s,于是用例的等待窗口只能取 1s —— 满载并行下一次调度抖动就
/// 能把这道余量吃光,那正是 302 / 310 记的两只 flaky(真机上从来没有这个问题:它们红在
/// 宿主调度,不在被测行为)。把余量从秒级拉到分钟级,窗口宽度就与负载无关了。
#[cfg(test)]
pub(crate) struct DialBudgetGuard;

#[cfg(test)]
impl DialBudgetGuard {
    pub(crate) fn install(secs: u64) -> DialBudgetGuard {
        DIAL_BUDGET_SECS.with(|c| c.set(Some(secs)));
        DialBudgetGuard
    }
}

#[cfg(test)]
impl Drop for DialBudgetGuard {
    fn drop(&mut self) {
        DIAL_BUDGET_SECS.with(|c| c.set(None));
    }
}

/// 一台对端的拨号退避(§7:15s→300s 抖动)。
struct Backoff {
    /// 下次可发起的时刻。
    next: Deadline,
    /// **下次**失败后要等的秒数(发起那一刻就翻倍记账,见 [`Dialer::round`])。
    delay: u64,
}

/// **拨号器**(§7;每空间一只,住在 [`super::transport::EngineSlot`] 里)。
///
/// 与监听器的三处不同,都是形状上的:
/// * 监听器是 **app 级单例**(一台机器一个 24618 端口),拨号器**每空间各拨各的**——
///   要拨谁由该空间自己的 `lan_peer:*` 缓存说了算,手机壳没有监听器也照样拨(§7)。
/// * 它住在引擎槽里,故「撤位即取消在飞拨号」与「撤位即拆链」是**同一个结构事实**
///   ([`super::transport::EngineSlot::retire`]),不靠谁记得调一句 cancel。
/// * 结局不回传:握手成功由 `lan_adopt` 那条既有路径通知([`Dialer::on_link_up`]),
///   失败什么也不发生——故退避记账必须在**发起那一刻**做完,不能等结果回来。
pub(crate) struct Dialer {
    /// 移交通道(`run` 自持的那一枚的克隆)。`None` = 本 `run` 不拨号(部分单测)。
    handoff: Option<mpsc::Sender<AdoptedLink>>,
    /// 每对端退避。**只为真发起过的对端建条目**:被方向规则/无钥/无候选挡掉的对端不留
    /// 条目,否则它们的过期时刻会把 [`Dialer::due`] 永远钉在过去(空转)。
    peers: HashMap<String, Backoff>,
    /// 在飞的出站握手(每对端至多一只)。
    inflight: HashMap<String, tokio::task::JoinHandle<()>>,
    /// 下次巡查时刻。`None` = 不挂计时器(没引擎 / 缓存里一台对端都没有)。
    due: Option<Deadline>,
    /// 上一轮看到的本机子网(规范形)。**它变了 = 网络变化**——§7 三条退避复位信号之一,
    /// 而这件事没有 OS 通知,每轮的接口枚举就是唯一观测点。刻意不拿「本机通告 listen 变没
    /// 变」当判据:手机壳压根没有 listen,那样就只有桌面管用(codex 二轮 M1)。
    subnets: Option<Vec<lan::LocalSubnet>>,
    /// 发起过多少枚拨号(测试锚:方向规则的阴性对照要能指认「大 id 那端一枚都没发」)。
    #[cfg(test)]
    attempts: u64,
}

impl Dialer {
    pub(crate) fn new(handoff: Option<mpsc::Sender<AdoptedLink>>) -> Dialer {
        Dialer {
            handoff,
            peers: HashMap::new(),
            inflight: HashMap::new(),
            due: None,
            subnets: None,
            #[cfg(test)]
            attempts: 0,
        }
    }

    /// 下次该巡查的时刻(给协调者的 select 臂用)。
    pub(crate) fn due(&self) -> Option<Deadline> {
        self.due
    }

    /// 立刻巡查一轮(不动退避):新通告到达、引擎刚装配。
    pub(crate) fn kick(&mut self) {
        self.due = Some(Deadline::now());
    }

    /// 这台对端**退避复位**并立刻巡查:服务器说它上线了(§7 的拨号时机之一)——那是它
    /// 刚起来的强信号,不该让上一轮攒到 300s 的退避挡着。
    pub(crate) fn kick_peer(&mut self, peer: &str) {
        self.peers.remove(peer);
        self.kick();
    }

    /// **全部退避复位**并立刻巡查:中转重连(§7「新通告、网络变化、中转重连复位」)。
    pub(crate) fn kick_all(&mut self) {
        self.peers.clear();
        self.kick();
    }

    /// 与这台对端建上链了(两个方向都算):清掉它的退避条目——链在的时候不必排巡查,
    /// 链断之后下一轮空闲巡查(≤15s)会重新发起,且是从 15s 基数起而不是接着上次翻倍。
    pub(crate) fn on_link_up(&mut self, peer: &str) {
        self.peers.remove(peer);
    }

    /// 撤位(§6 ⑤「stop / 撤位要同时取消入站与出站全部未移交的握手任务」)。
    pub(crate) fn retire(&mut self) {
        for (_, h) in self.inflight.drain() {
            h.abort();
        }
        self.peers.clear();
        self.due = None;
    }

    /// 巡查一轮:该拨的拨出去。**同步**(读库 + spawn,不 await),故它天然是
    /// run-to-completion 的一件事。
    ///
    /// 上界:一轮最多开到 [`DIAL_MAX_INFLIGHT`] 只任务;每只任务自带 10s 全握手上限。
    pub(crate) fn round(
        &mut self,
        cfg_account: &str,
        self_device: &str,
        k_acc: &[u8; 32],
        self_seed: &[u8; 32],
        db: &Arc<Mutex<Connection>>,
        self_listening: bool,
        // 本机有监听席位吗(桌面壳 = 有)。**它决定「一台对端都没缓存」时计时器摘不摘**:
        // 本机通告地址的刷新与准入注册的重试**只由这条巡查驱动**(codex 三轮 H1),摘了
        // 就再也没有「下一轮」——换网之后新地址永远发不出去,而对端正等着拨它。手机壳没有
        // 这半件事,故那时可以整个摘掉。
        host_seat: bool,
        linked: &dyn Fn(&str) -> bool,
    ) -> Option<String> {
        let now = Deadline::now();
        // **先把下次时刻按到安全值**:下面任何一处提前返回时,`due` 都不能留在过去
        // ——留在过去 = 计时器立刻又就绪 = 空转烧 CPU。
        self.due = Some(now + dial_idle_poll());
        let Some(handoff) = self.handoff.clone() else {
            self.due = host_seat.then(|| now + dial_idle_poll());
            return None;
        };
        self.inflight.retain(|_, h| !h.is_finished());
        // 枚举失败 = **不拨号**(§7:不猜「裸 RFC1918 全段」)。每轮重新枚举,故换了 wifi
        // / 插拔网线之后的候选是新的——这也是「网络变化」在没有 OS 通知时的那条替代路。
        let subnets = match local_subnets() {
            Ok(v) => v,
            Err(e) => return Some(e),
        };
        // 网络变化 = 全部退避复位(§7)。第一轮只是记下当前形态,不算变化。
        if self.subnets.as_deref().is_some_and(|seen| seen != subnets.as_slice()) {
            self.peers.clear();
        }
        self.subnets = Some(subnets.clone());
        let now_ms = crate::clock::wall_now_ms();
        let ads = {
            let conn = db.lock().expect("db mutex poisoned");
            transport::read_all_peer_ads(&conn)
        };
        let ads = match ads {
            Ok(v) => v,
            Err(e) => return Some(e),
        };
        if ads.is_empty() {
            // 缓存里一台对端都没有:拨号这半件没得做。**但本机通告与准入那半件还得巡查**
            // (codex 三轮 H1)——它俩现在只由这条巡查驱动,计时器一摘就没有「下一轮」:
            // 换网之后新地址永远发不出去,而按方向规则本该拨过来的对端正拿着旧地址。
            // 手机壳(无席位)没有那半件事,故可以整个摘掉,等下一枚通告来 kick。
            self.due = host_seat.then(|| now + dial_idle_poll());
            return None;
        }
        for (peer, ad) in ads {
            // 已有活跃链 / 正在飞:不必再拨(条目在建链那一刻已由 `on_link_up` 清掉)。
            if linked(&peer) {
                self.peers.remove(&peer);
                continue;
            }
            if self.inflight.contains_key(&peer) {
                continue;
            }
            // §7 一级规则 + 「拨号前置」三条(禁用/无钥、无 listen、逾期、候选全被过滤掉)。
            // **这几种是「结构上不该拨」,故顺手清掉条目**:留着的话它那个早已过期的
            // `next` 会把巡查时刻永远钉在过去。
            let usable = lan::should_dial(self_listening, self_device, &peer)
                .then(|| ad.usable_pubkey())
                .flatten();
            let Some(pubkey) = usable else {
                self.peers.remove(&peer);
                continue;
            };
            let targets = lan::dial_candidates(&ad, &subnets, now_ms);
            if targets.is_empty() {
                self.peers.remove(&peer);
                continue;
            }
            // 退避未到:留着条目——它正是下次该醒来的时刻。
            if self.peers.get(&peer).is_some_and(|b| b.next > now) {
                continue;
            }
            if self.inflight.len() >= DIAL_MAX_INFLIGHT {
                break;
            }
            let delay = self.peers.get(&peer).map_or(DIAL_BACKOFF_BASE_SECS, |b| b.delay);
            // **先排下一次、再拨**(结局不回传):建上链 → `on_link_up` 清条目;没建上 →
            // 到点再来一枚,退避照 §7 翻倍封顶。
            self.peers.insert(
                peer.clone(),
                Backoff {
                    next: now + Duration::from_secs(delay) + dial_jitter(delay),
                    delay: (delay * 2).min(DIAL_BACKOFF_MAX_SECS),
                },
            );
            let bound = DialBound {
                id: LanIdentity {
                    account_id: cfg_account.to_string(),
                    self_device: self_device.to_string(),
                    k_acc: *k_acc,
                    self_seed: *self_seed,
                    db: Arc::clone(db),
                },
                handoff: handoff.clone(),
            };
            let task = tokio::spawn(dial_task(bound, peer.clone(), pubkey, targets));
            self.inflight.insert(peer, task);
            #[cfg(test)]
            {
                self.attempts += 1;
            }
        }
        let soonest = self.peers.values().map(|b| b.next).min();
        let idle = now + dial_idle_poll();
        // 空闲巡查是**链路死后重拨的结构性来路**:链断的通报散在好几处(死讯 / 队满摘链 /
        // 静默判死 / 撤位),让每一处都记得通知拨号器就是一条迟早会漏的自律;隔一会儿回头
        // 看一眼则谁也不用记得。缓存空时上面已经把计时器摘了,故这不是无条件的空转。
        self.due = Some(soonest.map_or(idle, |s| s.min(idle)));
        None
    }

    /// 测试探针:给某台对端摆一份还没到期的退避(真造一份得先拨一次,太重)。
    #[cfg(test)]
    pub(crate) fn backoff_for_test(&mut self, peer: &str, secs: u64) {
        self.peers.insert(
            peer.to_string(),
            Backoff { next: Deadline::now() + Duration::from_secs(secs), delay: secs },
        );
    }

    /// 测试探针:这台对端此刻还压着退避吗(复位信号的观测面)。
    #[cfg(test)]
    pub(crate) fn has_backoff(&self, peer: &str) -> bool {
        self.peers.contains_key(peer)
    }

    #[cfg(test)]
    pub(crate) fn attempts(&self) -> u64 {
        self.attempts
    }

    /// **还活着**的出站握手只数。刻意不是 `self.inflight.len()`——那张表只在巡查开头
    /// 剪枝,拿它当「跑完了没」会把已收场的任务算进去,用例就会误以为下一轮的跳过是
    /// 在飞闸挡的(其实该是退避挡的),那正是「被别的机制背书」型假绿。
    #[cfg(test)]
    pub(crate) fn inflight(&self) -> usize {
        self.inflight.values().filter(|h| !h.is_finished()).count()
    }
}

impl Drop for Dialer {
    /// `run` 收场(停机 / 须重开 / 未配置退出)即取消全部未移交的出站握手——写成 `Drop`
    /// 的理由同 [`AdmitLease`]:出口太多,漏一处就留一只还会往已经没人收的通道里塞链路的
    /// 任务。(它们塞进去也无害:读端随 `Pumps` 一起没了,`AdoptedLink` 落地即关 socket。)
    fn drop(&mut self) {
        for h in self.inflight.values() {
            h.abort();
        }
    }
}

/// 退避抖动:0..delay/4 秒。两端同时重连中转时的「一起醒来」由它散开(方向规则已经让
/// 同一对设备只有一个方向在拨,故这里的抖动主要是给多对端的场面)。
fn dial_jitter(delay_secs: u64) -> Duration {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut b = [0u8; 2];
    chacha20poly1305::aead::OsRng.fill_bytes(&mut b);
    let span = (delay_secs * 250).max(1);
    Duration::from_millis(u64::from(u16::from_le_bytes(b)) % span)
}

/// 一枚出站握手绑住的东西(§6 ⑤:身份指纹 + 只许产出 [`AdoptedLink`] 的那条出口)。
/// 空间是隐含的——拨号器每空间一只,库把手与移交通道都是那个空间的。
struct DialBound {
    id: LanIdentity,
    handoff: mpsc::Sender<AdoptedLink>,
}

/// 一个候选地址试完的结局。
enum DialStep {
    /// 这个地址没走通,试下一个。
    Unreachable,
    /// 别再试了:链已移交,或本机侧已收场(身份换代)。
    Done,
}

/// 一枚出站握手任务(§4 的 D 侧)。**只产出 [`AdoptedLink`]**:不碰引擎、不碰 peer-map、
/// 自己不发一枚 `Frame`(§6 ⑤)。全握手 10s 上限与监听侧同一个数,逐个候选试下去也超不
/// 过它——超了就整只任务落地,socket 随栈一起关。
async fn dial_task(
    b: DialBound,
    peer: String,
    peer_pubkey: [u8; 32],
    targets: Vec<std::net::SocketAddrV4>,
) {
    let _ = tokio::time::timeout(dial_handshake_budget(), async {
        for addr in targets {
            if matches!(dial_one(&b, &peer, &peer_pubkey, addr).await, DialStep::Done) {
                return;
            }
        }
    })
    .await;
}

/// 往一个候选地址走完 §4 的三步。**每次跨 `.await` 之后、发 `Intro`/`Confirm` 或交
/// handoff 之前重新自证**(§6 ⑤,与监听侧对称);任何一步不合都直接 return,socket 随
/// 栈上的 `stream` 一起落地。
async fn dial_one(
    b: &DialBound,
    peer: &str,
    peer_pubkey: &[u8; 32],
    addr: std::net::SocketAddrV4,
) -> DialStep {
    let Ok(Ok(mut stream)) = tokio::time::timeout(
        Duration::from_secs(DIAL_CONNECT_SECS),
        TcpStream::connect(connect_addr(addr)),
    )
    .await
    else {
        return DialStep::Unreachable;
    };
    // ① 跨过 connect 那次 await 了:**发 Intro 之前**自证。
    if !b.id.current() {
        return DialStep::Done;
    }
    let (mut dialer, intro) = lan::LanDialer::start(&lan::DialParams {
        account_id: &b.id.account_id,
        k_acc: &b.id.k_acc,
        self_seed: &b.id.self_seed,
        self_device: &b.id.self_device,
        peer_device: peer,
        peer_pubkey,
    });
    if write_wire(&mut stream, &intro).await.is_err() {
        return DialStep::Unreachable;
    }
    let Ok(Ok(accept)) = tokio::time::timeout(
        dial_accept_budget(),
        read_wire(&mut stream, lan::FramePhase::PreAuth),
    )
    .await
    else {
        // 对端在某一步静默关了(§4 的四道闸都是静默拒),或那个地址上根本不是自己人。
        return DialStep::Unreachable;
    };
    // ② 跨过等 Accept 那次 await 了:**发 Confirm 之前**自证。
    if !b.id.current() {
        return DialStep::Done;
    }
    let Ok((confirm, established)) = dialer.on_accept(&accept) else {
        return DialStep::Unreachable;
    };
    if write_wire(&mut stream, &confirm).await.is_err() {
        return DialStep::Unreachable;
    }
    // ③ 跨过写 Confirm 那次 await 了:**交 handoff 之前**最后自证。
    if !b.id.current() {
        return DialStep::Done;
    }
    // `try_send` 不 await:队满(4 枚)说明协调者正忙,关掉这条、退避后重来,绝不挂在
    // 通道上占着在飞名额。到这一步对端已经答过,不必再试它别的地址。
    let _ = b.handoff.try_send(AdoptedLink { established, stream });
    DialStep::Done
}

/// 真正去连的地址。生产恒是候选本身;测试可整体改写到环回(见 [`TestNet`])。
fn connect_addr(addr: std::net::SocketAddrV4) -> SocketAddr {
    #[cfg(test)]
    if TEST_NET.with(|c| c.borrow().as_ref().is_some_and(|n| n.loopback)) {
        return SocketAddr::from((Ipv4Addr::LOCALHOST, addr.port()));
    }
    SocketAddr::V4(addr)
}

/// 测试专用的「合成局域网」。
///
/// **为什么非要有它**:§7 的候选过滤在结构上不允许「一台机器两实例」——对端通告的地址
/// 就是本机自己的地址(`SelfAddr` 拒),改通告环回又是 `Loopback` 拒。而 L-c3b 要验的
/// 是「拨号 → 握手 → 移交 → 收敛」那条路。故用例给一张**合成网卡**(过滤器跑的仍是真
/// 规则:私网、在直连子网内、非自身、非网络/广播地址),只把最后那一步真去连的地址改写
/// 到环回、端口照对端通告的原样用。过滤器本身的九类拒因在 `lan.rs` 逐条单测。
#[cfg(test)]
struct TestNet {
    /// `None` = 装成「接口枚举失败」(桌面拿不到网卡时 `listen` 会被置 None,那也是一条
    /// 该发出去的通告——见 `lan_dial_tick` 的 `Some → None` 那一路)。
    subnets: Option<Vec<lan::LocalSubnet>>,
    loopback: bool,
}

#[cfg(test)]
thread_local! {
    static TEST_NET: std::cell::RefCell<Option<TestNet>> =
        const { std::cell::RefCell::new(None) };
}

/// 合成局域网的 RAII 把手(实现审三轮 M1 的教训:线程局部覆盖位**必须**由 guard 复位,
/// 否则同一条测试工作线程上后面的用例会被传染,那正是「额外的东西帮着背书」型假绿)。
#[cfg(test)]
pub(crate) struct TestNetGuard;

#[cfg(test)]
impl TestNetGuard {
    /// `self_addr/prefix` = 合成网卡;拨号一律改到环回(端口不动)。
    pub(crate) fn install(self_addr: &str, prefix: u8) -> TestNetGuard {
        TestNetGuard::install_many(&[(self_addr, prefix)])
    }

    /// 多张合成网卡,**顺序由用例定**(枚举顺序抖动那条用例要的正是这个)。
    pub(crate) fn install_many(cards: &[(&str, u8)]) -> TestNetGuard {
        let subs = cards
            .iter()
            .map(|(a, p)| {
                lan::LocalSubnet::new(a.parse().expect("合成网卡地址"), *p).expect("合成网卡前缀")
            })
            .collect();
        TEST_NET
            .with(|c| *c.borrow_mut() = Some(TestNet { subnets: Some(subs), loopback: true }));
        TestNetGuard
    }

    /// 装成「一张网卡都枚举不出来」(§7:失败即不通告不拨号)。
    pub(crate) fn fail() -> TestNetGuard {
        TEST_NET.with(|c| *c.borrow_mut() = Some(TestNet { subnets: None, loopback: true }));
        TestNetGuard
    }
}

#[cfg(test)]
impl Drop for TestNetGuard {
    fn drop(&mut self) {
        TEST_NET.with(|c| *c.borrow_mut() = None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机接口枚举**在这台机器上真的跑得通**(定点风险的地面真相):至少不报错,且
    /// 拿到的每条子网前缀合法、地址非环回。
    #[test]
    fn enumerating_local_subnets_works_on_this_platform() {
        let subs = local_subnets().expect("本机接口枚举不该失败");
        for s in &subs {
            assert!(s.prefix() <= 32, "前缀越界的条目不该进表");
            assert!(!s.addr().is_loopback(), "环回不进直连子网表");
        }
    }

    /// 撤位那一刻 abort 句柄还没装上(多线程 runtime 下 `accept_loop` 的 spawn 与
    /// `set_abort` 跟任务开跑是赛跑),那次 abort 会静默落空——**判死位负责补刀**
    /// (实现审 H1 的第二个窗口)。这里把窗口摆成确定时刻:先登记一只已认下空间的任务、
    /// **不给句柄**,撤位,然后才把句柄交上去。
    #[tokio::test]
    async fn a_task_doomed_before_its_abort_handle_arrives_still_gets_cancelled() {
        let adm = LanAdmission::ephemeral();
        let ip: IpAddr = Ipv4Addr::LOCALHOST.into();
        let id = adm.admit_conn(ip).expect("头一枚该放行");
        // 假装它已经认下了空间(`bind_task` 那一步),但句柄还在路上。
        adm.lock().tasks.get_mut(&id).expect("在表上").bound = Some(("s1".into(), 1));
        let victim = tokio::spawn(async { std::future::pending::<()>().await });
        abort_bound_to(&mut adm.lock(), "s1");
        assert!(!victim.is_finished(), "句柄还没交上去,这一下当然打不着");
        adm.set_abort(id, victim.abort_handle());
        // 限时:没补刀的话这只任务永远跑下去,拿超时当红比让整轮测试挂死体面。
        let done = tokio::time::timeout(Duration::from_secs(2), victim).await;
        assert!(done.expect("补刀该当场生效").expect_err("该被取消").is_cancelled());
    }

    /// §10 的令牌是**一次性许可**:预占在放行那一刻就扣掉,故一枚令牌最多放行一条连接
    /// ——只查不扣的话,同一枚令牌在结果回来之前能同时喂进最多 8 条(全局槽数)。
    /// 阳性对照在同一条里:补满之后又放得进去。
    #[tokio::test]
    async fn one_token_admits_exactly_one_connection() {
        let adm = LanAdmission::ephemeral();
        adm.set_tokens_for_test(1.0);
        // 两个不同源 IP,故挡住第二条的只可能是令牌桶(每源 IP 上界是 2)。
        let a: IpAddr = Ipv4Addr::new(10, 0, 0, 1).into();
        let b: IpAddr = Ipv4Addr::new(10, 0, 0, 2).into();
        assert!(adm.admit_conn(a).is_some(), "第一条该放行");
        assert!(adm.admit_conn(b).is_none(), "同一枚令牌不许放行第二条");
        adm.refund();
        assert!(adm.admit_conn(b).is_some(), "退款之后又放得进去(合法握手净零消耗)");
    }

    /// `accept` 的三种结局必须分得开(实现审二轮 M1):**本机侧不合**(条目在这一窗里
    /// 换代 / 被摘)绝不能和「对端给的东西不对」混成一个 `None`——混了的话撤位换代那一刻
    /// 的失败会被记成一次无效尝试、白花一枚令牌。三态在同一条里走一遍:正路 `Ready` →
    /// 同一枚 Intro 重放 `PeerRejected`(重复抑制)→ 代次对不上 `LocalStale`。
    #[tokio::test]
    async fn accept_tells_a_stale_seat_apart_from_a_bad_peer() {
        const ACCT: &str = "01ACCTAAAAAAAAAAAAAAAAAAAA";
        const ME: &str = "01SELFAAAAAAAAAAAAAAAAAAAA";
        const PEER: &str = "01PEERAAAAAAAAAAAAAAAAAAAA";
        let k_acc = [5u8; 32];
        let adm = LanAdmission::ephemeral();
        let db = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        let (handoff, _rx) = mpsc::channel(4);
        let active = Arc::new(Mutex::new(HashSet::new()));
        adm.register(Registration {
            space_id: "s1".into(),
            owner: 1,
            account_id: ACCT.into(),
            self_device: ME.into(),
            k_acc,
            self_seed: [7u8; 32],
            db: Arc::clone(&db),
            active: Arc::clone(&active),
            handoff: handoff.clone(),
        })
        .expect("注册");
        let epoch = adm.epoch_of("s1").expect("条目在");
        let (_d, wire) = lan::LanDialer::start(&lan::DialParams {
            account_id: ACCT,
            k_acc: &k_acc,
            self_seed: &[9u8; 32],
            self_device: PEER,
            peer_device: ME,
            peer_pubkey: &[1u8; 32],
        });
        let intro = lan::Intro::parse(&wire).expect("形态合法");
        let gate = lan::IntroGate { peer_pubkey: Some(&[1u8; 32]), peer_link_active: false };
        let bound = |epoch: u64| Bound {
            space: "s1".into(),
            epoch,
            id: LanIdentity {
                account_id: ACCT.into(),
                self_device: ME.into(),
                k_acc,
                self_seed: [7u8; 32],
                db: Arc::clone(&db),
            },
            active: Arc::clone(&active),
            handoff: handoff.clone(),
        };
        assert!(matches!(adm.accept(&bound(epoch), &intro, &gate), AcceptOutcome::Ready(..)));
        assert!(
            matches!(adm.accept(&bound(epoch), &intro, &gate), AcceptOutcome::PeerRejected),
            "同一枚 Intro 重放 = 重复抑制,这才是对端的账"
        );
        assert!(
            matches!(adm.accept(&bound(epoch + 1), &intro, &gate), AcceptOutcome::LocalStale),
            "代次对不上 = 本机侧的事,不许算成无效尝试"
        );
    }

    /// 令牌桶:桶深内连花 10 枚即空,一秒后回满。
    #[test]
    fn the_failure_bucket_drains_and_refills() {
        let mut b = Bucket { tokens: PREAUTH_FAIL_BURST, last: Instant::now() };
        for _ in 0..10 {
            b.tokens = (b.tokens - 1.0).max(0.0);
        }
        assert_eq!(b.tokens, 0.0);
        b.refill(Instant::now() + Duration::from_secs(1));
        assert!(b.tokens >= PREAUTH_FAIL_PER_SEC - 0.001, "一秒该回满一整桶");
    }
}
