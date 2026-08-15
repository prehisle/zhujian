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
///
/// ⚠ **「合法握手」按当前名册算**(identity-plan §5.11;367 第②笔的第③笔):材料全对、
/// 但对端已不在本账户的设备名单里,记的是**对端的账**(花那一枚),不是本机侧的退款路
/// ——理由写在 `handshake` 步骤 ⑦ 那段注释里(这枚令牌是 pre-auth 唯一的速率闸)。
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
    /// 该空间的**权威名册闸**(identity-plan §5.11;367 第②笔的第③笔)。
    ///
    /// ⭐ **交进来的是把手,不是快照**:它与 `EngineSlot::gate` 是**同一只 `Arc`**,故
    /// 「app 级准入表这一份会不会与每空间那一份说不同的话」在类型层就不存在(§5.11
    /// item ②/③)。也正因如此,§5.11-⑧ 那「会话收场三处一起清」在实现上收成两处 ——
    /// 第三处是第一处的推论。
    pub gate: Arc<Mutex<lan::RosterGate>>,
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
    /// 见 [`Registration::gate`]。**不进 [`SpaceEntry::same_identity`]**:它不是身份的一
    /// 部分,换了把手不该换代(换代 = abort 掉全部在飞握手);而「同一个 `run` 里恒是
    /// 同一只 `Arc`」由 [`LanAdmission::register`] 里那句 `debug_assert` 守着。
    gate: Arc<Mutex<lan::RosterGate>>,
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

/// 一只在飞的 pre-auth 握手任务认下的东西(还没解析出 Intro 之前什么都没认下)。
///
/// **刻意不带代次**:撤位与换代都是「整个空间一起打」([`abort_bound_to`]),没有哪一处
/// 按代次挑人 —— 存一个从来没人读的字段就是给下一个人留一处会漂的事实。每只任务自证用
/// 的那份代次在它自己栈上的 [`Bound::epoch`] 里。
struct TaskBound {
    space: String,
    /// 拨入方 device_id(= `Intro.from`)。**名册闸按它挑该 abort 谁**
    /// (identity-plan §5.11 item ④:原先只有 space,「只 abort 新被拒的那些」就无从谈起)。
    peer: String,
}

/// 一只在飞的 pre-auth 握手任务。
struct Inflight {
    /// 已认下的空间与对端(还没解析出 Intro 时是 `None`)。撤位与名册闸按它挑该 abort 谁。
    bound: Option<TaskBound>,
    abort: Option<tokio::task::AbortHandle>,
    /// 撤位时这只任务已被判死,但**句柄还没装上**(多线程 runtime 下,新任务可能在
    /// `accept_loop` 调 [`LanAdmission::set_abort`] 之前就跑到了认空间那一步)。没有这
    /// 一位的话那次 abort 会静默落空——正确性不受影响(它随后的逐步自证照样拒绝移交),
    /// 但它会一直占着 pre-auth 名额直到 10s 超时。置位后由 `set_abort` 当场补刀。
    doomed: bool,
    /// 这只任务**被取消**时,那枚预占的令牌算谁的账(§10;codex 实现审 L1)。
    ///
    /// 病:`serve_conn` 的分类记账写在 `handshake` 返回**之后**,而 abort 会把整只 future
    /// 连同那一句一起丢掉 ⇒ [`ConnGuard::spend`] 停在默认的 `false` = 退款。于是同一条名册
    /// 裁决会因**竞速**给出两个答案:握手先跑到步骤 ⑦ 就记对端的账,`apply_denied` 先 abort
    /// 就记本机的账还退款。
    ///
    /// 形:**取消的理由由下手的那一方在表锁内写下**,不靠被取消者自己跑到哪一步 ——
    /// 名册判死置 `true`(那是关于对端的持久授权裁决),撤位 / 换代([`abort_bound_to`])
    /// 保持 `false`(本机侧的处境)。[`LanAdmission::settle`] 摘条目时连同 `spend` 一起结清。
    charged: bool,
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
    /// 退过多少枚令牌(见 [`LanAdmission::refunds_for_test`])。**「这一次算谁的账」没有
    /// 别的观测面** —— 桶里的水位会随时间自己补回来,拿它当判据是场竞速。
    refunds: u64,
    /// 名册判死过多少只在飞握手(**单调,永不减**;每只至多计一次,见 [`doom_denied`])。
    /// 读取面在 [`LanAdmission::doomed_total`](`cfg(test)`);字段本身编进生产 = 8 字节
    /// 加一次极低频自增,codex 实现审判定可接受(要零生产探针就得连字段一起条件编译)。
    doomed_total: u64,
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
                refunds: 0,
                doomed_total: 0,
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
        // ⛔ **表锁只活在这个块里**(384 实现审 L1 的第二半):三个 abort 调用点里只有这一处
        // 「拿到把手之后锁还要接着用」。原先写的是一句 `drop(t)` —— 而**把那句删掉照样编译**
        // (`MutexGuard` 是有析构的局部量,活到词法作用域末尾;NLL 不会因为最后一次借用结束
        // 就提前放锁),于是锁内 abort 会**悄悄回潮**,而结构锚看不见这里(`register` 不吃
        // `&mut Table`)、行为测在今天的 tokio 行为下也分不出锁内锁外。⇒ 改成块作用域:
        // 「持锁时不 abort」于是与 `deregister` / `apply_denied` 同形,是**作用域的结构事实**。
        let (port, doomed) = {
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
                // ⛔ **名册闸也在这里刷**(identity-plan §5.11):这条路每 15 秒走一次(拨号
                // 巡查恒幂等续注册),漏掉它就等于把「表里那份 = 最后一次注册交进来的那只」
                // 变成一句没人守的话。今天它必是同一只 `Arc`(`owner` 进了 `same_identity`,
                // 而 `owner` 每个 `run` 换一次、`EngineSlot::retire` 又刻意不换 gate),故这
                // 句赋值是**恒等操作** —— 下面这句 `debug_assert` 把「恒等」从假设变成被核
                // 对的事实,免得日后谁把 gate 的所有权挪个地方,两份就悄悄漂了(§5.11 item ②)。
                debug_assert!(
                    Arc::ptr_eq(&e.gate, &reg.gate),
                    "同一代身份续注册却换了名册闸把手:准入表与引擎槽会各拿一份会漂的名单"
                );
                e.gate = reg.gate;
                e.handoff = reg.handoff;
                e.active = reg.active;
                e.db = reg.db;
                // 这条路一个把手都没拿到(不换代 = 谁都不 abort),故直接从函数返回,
                // 锁随之落地。
                return Ok(port);
            }
            t.next_epoch += 1;
            let epoch = t.next_epoch;
            let doomed = abort_bound_to(&mut t, &reg.space_id);
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
                    gate: reg.gate,
                    handoff: reg.handoff,
                },
            );
            (port, doomed)
        };
        // ⛔ **放锁之后才 abort**(§5.11-⑨ 那条纪律的第二处兑现):被 abort 的任务析构时要
        // 回**这张表**交还并发额度([`ConnGuard`]),锁内调它就是新造一条跨结构锁序。
        for h in doomed {
            h.abort();
        }
        Ok(port)
    }

    /// 摘条目(§6「supervisor `stop` 先摘准入条目 + 取消该代未移交的 pre-auth 任务」;
    /// LanReady 的三档撤位与 `run` 收场同样经它)。**认注册者号**:旧 runtime 迟到的那声
    /// 注销摘不掉新 runtime 的条目。
    pub(crate) fn deregister(&self, space_id: &str, owner: u64) {
        // ⛔ 表锁是**这条 `let` 语句里的临时量**,它在这一句末尾就落地了(同
        // [`LanAdmission::apply_denied`]);`abort()` 在下一句,故「持锁时不 abort」是语句
        // 作用域的结构事实,不是一句要人记得的纪律。
        let doomed = drop_entry(&mut self.lock(), space_id, owner);
        for h in doomed {
            h.abort();
        }
    }

    /// **最终撤席**(supervisor 的 `stop` / `begin_reset` 专用):摘条目 + abort 未移交
    /// 握手,**并记下撤销水位**——同代及更早的注册此后一律拒(见 [`LanAdmission::register`]
    /// 里那段:旧 runtime 的巡查会拿着还没失效的席位把条目复活)。新 runtime 的更高代次
    /// 照常注册,故这不是「这个空间从此不能直连」。
    pub(crate) fn revoke(&self, space_id: &str, owner: u64) {
        // 同 [`LanAdmission::deregister`]:锁内只标死并复制把手,`abort()` 出了这个块才调。
        let doomed = {
            let mut t = self.lock();
            let w = t.revoked.entry(space_id.to_string()).or_insert(0);
            *w = (*w).max(owner);
            drop_entry(&mut t, space_id, owner)
        };
        for h in doomed {
            h.abort();
        }
    }

    /// 名册一变,**当场**判死那些新被拒的对端在飞的**入站**握手(identity-plan §5.11;
    /// 出站那一半在 [`Dialer::abort_denied`])。
    ///
    /// ⚠ **触发器不是判据**:安全恒靠 `handshake` 步骤 ⑦ 每次问**当前** gate,这一句只是
    /// 让不合法的那条不必等到 handoff 才被拒。判据用 [`lan::NewlyDenied::hits`](**这次**
    /// 才变得不准连)而不是 `allows`(此刻准不准)—— 后者会把「只多了一台无关设备」
    /// 「只改了 admin 标记」这类无关变更也拿来 abort 一批合法握手(§5.11 三轮 M3 那张表)。
    ///
    /// ⛔ **`abort()` 放锁之后再调**(§5.11 四轮 L1 / item ⑨):被 abort 的任务析构时要
    /// 回**这张表**交还并发额度([`ConnGuard`]),锁内调它就是新造一条跨结构锁序。
    /// 这条纪律**今天四处一律**:本函数 / [`abort_bound_to`] 的三个调用点 /
    /// [`LanAdmission::set_abort`] 的补刀 —— 立规那一轮只有本函数照办、剩下三处记成
    /// 「tokio 版本绑定债」,这笔债已在 384 清掉。
    /// 安全线性化点 = 「gate 已换 ∧ 握手已标 doomed」,**不是**「`abort()` 真的调到了」,
    /// 故放锁到 abort 之间那一小段没有漏窗:此刻交上来的链在步骤 ⑦ 与协调者 install
    /// 那两道闸下照样装不上。
    ///
    /// **每空间**(§5.11 item ⑩):只动 `space_id` 那一格的任务,甲空间的名册更新碰不到
    /// 乙空间里同名的 device_id。
    pub(crate) fn apply_denied(&self, space_id: &str, denied: &lan::NewlyDenied) {
        // ⛔ 表锁是**这条 `let` 语句里的临时量**,它在这一句末尾就落地了;`abort()` 在下
        // 一句,故「持锁时不 abort」是语句作用域的结构事实,不是一句要人记得的纪律。
        let doomed = doom_denied(&mut self.lock(), space_id, denied);
        for h in doomed {
            h.abort();
        }
    }

    /// 表侧自证:这枚任务认下的那一代还在吗。
    fn epoch_current(&self, bound: &Bound) -> bool {
        self.lock().spaces.get(&bound.space).is_some_and(|e| e.epoch == bound.epoch)
    }

    /// 收一枚新连接的许可(§10 三道上界)。`None` = 静默丢。
    ///
    /// **令牌在这里就预占掉**(实现审 M1):只查不扣的话,同一枚令牌在结果回来之前能同时
    /// 放进最多 8 条连接(全局槽数),每补回一枚就又放一批——实际速率远超规格的 10/s。
    /// 预占 + [`Table::refund_token`](合法建链与本机侧原因才退)= 令牌是**一次性许可**,
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
        t.tasks
            .insert(id, Inflight { bound: None, abort: None, doomed: false, charged: false });
        Some(id)
    }

    /// 把 `accept_loop` spawn 出来的那只任务的 abort 句柄交进表里。
    ///
    /// ⛔ **补刀那一下也在放锁之后**(§5.11-⑨ 那条纪律的第三处兑现):补刀打的是一只正在
    /// 跑的任务,它析构时要回这张表交还额度([`ConnGuard`])。
    fn set_abort(&self, id: u64, abort: tokio::task::AbortHandle) {
        {
            let mut t = self.lock();
            // 任务可能已经跑完并自摘(guard 的 Drop);那就没有句柄可存。
            let Some(f) = t.tasks.get_mut(&id) else { return };
            if !f.doomed {
                f.abort = Some(abort);
                return;
            }
        }
        // 装句柄之前就被判死过 = 那次 abort 落了空,这里补刀(见 [`Inflight::doomed`])。
        abort.abort();
    }

    /// 任务收场:交还并发额度,**并在同一把锁里**把那枚预占的令牌结清([`ConnGuard`] 的
    /// 唯一出口)。
    ///
    /// ⭐ **一次取锁,不是两次**(379 可优化项第三条):此前是 `finish` 摘条目、放锁、再
    /// `refund` 第二次取锁,于是「在飞数已归零」与「令牌已结清」之间有一个真窗口 ——
    /// 靠那只测跑在 current-thread runtime 上才看不见。结清与摘条目原子化之后,
    /// 「`inflight() == 0` ⇒ 这一枚的账已经落定」在**任何** runtime 上都成立,
    /// 判据不再由调度器背书。
    ///
    /// `spend` = 这只任务**自己跑完**得出的分类;条目上的 [`Inflight::charged`] 是**别人在
    /// 它跑到那一步之前就下的**判决(名册判死)。⛔ **两个判决源缺一不可**(codex 实现审
    /// L1):只看前者的话,「被 abort 掉的那只」永远停在默认的退款上 —— 同一条名册裁决
    /// 因此会因竞速给出两个答案。
    fn settle(&self, id: u64, ip: IpAddr, spend: bool) {
        let mut t = self.lock();
        let charged = t.tasks.remove(&id).is_some_and(|f| f.charged);
        if let Some(n) = t.per_ip.get_mut(&ip) {
            *n -= 1;
            if *n == 0 {
                t.per_ip.remove(&ip);
            }
        }
        if !spend && !charged {
            t.refund_token();
        }
    }

    /// 测试用直接退款口(生产侧只经 [`LanAdmission::settle`] 走 [`Table::refund_token`])。
    #[cfg(test)]
    fn refund(&self) {
        self.lock().refund_token();
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
            // **认下哪个空间,就拿哪个空间的名册闸**(identity-plan §5.11):device_id 是
            // 「设备 × 空间」粒度,拿甲空间的名册去判乙空间的对端就是张冠李戴。这一格由
            // 「从命中的那条 `SpaceEntry` 上取」保证,不是靠调用方传对。
            gate: Arc::clone(&e.gate),
            handoff: e.handoff.clone(),
        };
        if let Some(f) = t.tasks.get_mut(&id) {
            f.bound = Some(TaskBound { space, peer: intro.from.to_string() });
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

    /// 这只在飞握手被判死了吗。**名册闸那条触发器的「立刻」观测面**:`abort()` 之后
    /// 任务什么时候真落地由调度器说了算,而判死位是 `apply_denied` 当场写下的
    /// (378 那条教训:凡是「等一个计数归零」的判据,先问一句「它自己会不会归零」)。
    #[cfg(test)]
    pub(crate) fn doomed_for_test(&self, id: u64) -> bool {
        self.lock().tasks.get(&id).is_some_and(|f| f.doomed)
    }

    /// 同上,但不认任务号(跨模块的接线用例拿不到号)。**判死位没有第二个写者**:
    /// 撤位/换代那条写的也是它,而那两件事在这类用例里根本没发生;超时自己收场则是
    /// **摘条目**,数出来是 0 不是 1 —— 故「恰好一只被判死」这条判据不会被别的机制背书。
    /// 退过多少枚令牌(§10「这一次算谁的账」的观测面)。**桶的水位当不了判据**:它按
    /// 10/s 自己补,取样早几毫秒晚几毫秒答案就不同;计数是单调的,问什么时候都一样。
    #[cfg(test)]
    pub(crate) fn refunds_for_test(&self) -> u64 {
        self.lock().refunds
    }

    /// 名册**一共**判死过多少只在飞握手。⭐ **单调、永不减**,故它是「整机接线」那只用例
    /// 唯一站得住的判据:`doomed_count()` 会随任务收场自己归零(那只握手本来就有 10s 上限),
    /// 拿它去轮询就是在跟被测对象的自愈赛跑 —— 赢了是运气,输了是随机红。
    #[cfg(test)]
    pub(crate) fn doomed_total(&self) -> u64 {
        self.lock().doomed_total
    }

    #[cfg(test)]
    pub(crate) fn doomed_count(&self) -> usize {
        self.lock().tasks.values().filter(|f| f.doomed).count()
    }
}

impl Table {
    fn tokens_sub(&mut self) {
        self.bucket.tokens = (self.bucket.tokens - 1.0).max(0.0);
    }

    /// 退还预占的那一枚令牌(§10):合法建链与**本机侧**原因(身份换代 / 条目已摘 /
    /// 移交队满)才退——那不是对端的无效尝试,拿它去关限速阀等于让真攻击更容易打空桶。
    /// 对端给的东西不对 / 超时 = 留着不退,那正是「无效尝试」要花的那一枚。
    fn refund_token(&mut self) {
        self.refunds += 1;
        let now = Instant::now();
        self.bucket.refill(now);
        self.bucket.tokens = (self.bucket.tokens + 1.0).min(PREAUTH_FAIL_BURST);
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
///
/// ⛔ 同 [`abort_bound_to`]:**函数体里一个 `abort` 都不许有**,把手交回调用方放锁后再打。
#[must_use = "把手丢掉 = 摘了条目却没取消旧任务,那正是准入表要关的那扇窗"]
fn drop_entry(t: &mut Table, space_id: &str, owner: u64) -> Vec<tokio::task::AbortHandle> {
    if !t.spaces.get(space_id).is_some_and(|e| e.owner == owner) {
        return vec![];
    }
    t.spaces.remove(space_id);
    t.dups.remove(space_id);
    abort_bound_to(t, space_id)
}

/// 把该空间里**新被名册拒掉**的在飞握手判死,并把它们的 abort 把手交回调用方
/// ([`LanAdmission::apply_denied`] 在放锁之后才真去 abort)。
///
/// ⛔ **这个函数体里一个 `abort` 都不许有**(§5.11 item ⑨,与 [`abort_bound_to`] /
/// [`drop_entry`] 同受结构锚 `no_helper_holding_the_table_lock_aborts` 管):它跑在调用方
/// 的表锁里。**384 之前它是这一族里唯一照办的那只**,故那时的注释写「唯一持着表锁的那一半」
/// —— 今天四处一律,别再照那句读。
///
/// 上界:`tasks` 至多 [`PREAUTH_MAX_INFLIGHT`] 条,`hits` 是 O(log N)、N ≤ 32(服务端的
/// `MAX_ROSTER_DEVICES`),故这段临界区的长度由常量定、与数据规模无关。
fn doom_denied(
    t: &mut Table,
    space_id: &str,
    denied: &lan::NewlyDenied,
) -> Vec<tokio::task::AbortHandle> {
    let mut out = vec![];
    let mut doomed_total = t.doomed_total;
    for f in t.tasks.values_mut() {
        let Some(b) = &f.bound else { continue };
        if b.space != space_id || !denied.hits(&b.peer) {
            continue;
        }
        // **只数「第一次被名册判死」**(codex 实现审 GO 轮的精度备注):`charged` 只有这里
        // 写,故它就是「这只任务此前被名册判过死没有」。不加这一格的话,一只尚未落地的
        // 任务经历「重新加入 → 再次移除」会被计两次,而这个计数的**名字**说的是握手只数
        // —— 注释里的断言与它数的东西必须是同一件事(314 那条教训)。
        if !f.charged {
            doomed_total += 1;
        }
        // 先判死再交把手:句柄可能还没装上(同 [`abort_bound_to`] 那场赛跑),那一位让
        // `set_abort` 接着补刀,故这次判死绝不会静默落空。
        f.doomed = true;
        // **取消的理由在这里就写死**(codex 实现审 L1):被名册摘掉是关于**对端**的持久
        // 授权裁决,故它那枚预占的令牌不退 —— 与「跑到步骤 ⑦ 才被拒」记同一笔账,不因
        // 「谁先跑到」而变。⚠ 撤位 / 换代那条路([`abort_bound_to`])**刻意不置这一位**:
        // 那是本机侧的处境,照旧退款。
        f.charged = true;
        // 判死位与记账位都写完了,才轮到把把手交出去 —— 交出去之后这只任务随时可能落地。
        if let Some(a) = &f.abort {
            out.push(a.clone());
        }
    }
    t.doomed_total = doomed_total;
    out
}

/// 判死认在该空间的全部未移交任务,并把它们的 abort 把手交回调用方(§6:撤位与换代都要
/// **当场**取消,不等它们自己到超时——「摘了条目但旧任务还能交一条链」正是准入表要关的窗)。
///
/// ⛔ **这个函数体里一个 `abort` 都不许有**(§5.11 item ⑨,与 [`doom_denied`] 同一条纪律,
/// 由结构锚 `no_helper_holding_the_table_lock_aborts` 守着):它跑在调用方的表锁里。
/// 调用方三处([`LanAdmission::register`] 换代 / [`LanAdmission::deregister`] /
/// [`LanAdmission::revoke`])一律**放锁之后**才 abort。
///
/// 安全线性化点 = 「条目已换代/已摘 ∧ 握手已标 doomed」,**不是**「`abort()` 真的调到了」,
/// 故放锁到 abort 之间那一小段没有漏窗:此刻交上来的链在自证代次与协调者 install 那两道闸
/// 下照样装不上。
#[must_use = "把手丢掉 = 这次撤位/换代静默落空,那些任务会一直占着 pre-auth 名额到 10s 超时"]
fn abort_bound_to(t: &mut Table, space_id: &str) -> Vec<tokio::task::AbortHandle> {
    let mut out = vec![];
    for f in t.tasks.values_mut() {
        let Some(b) = &f.bound else { continue };
        if b.space != space_id {
            continue;
        }
        // 先判死再交把手:句柄可能还没装上(多线程 runtime 下 `set_abort` 与任务开跑是
        // 赛跑),那一位让 `set_abort` 接着补刀,故这次撤位绝不会静默落空。
        f.doomed = true;
        if let Some(a) = &f.abort {
            out.push(a.clone());
        }
    }
    out
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
    /// 该空间名册闸的把手(identity-plan §5.11)。**与准入表、引擎槽手上那只是同一份**,
    /// 故「交 handoff 之前问的是当前名册」是结构事实,不是一份拷贝碰巧还新鲜。
    gate: Arc<Mutex<lan::RosterGate>>,
    handoff: mpsc::Sender<AdoptedLink>,
}

/// 名册闸此刻放行这台对端吗(identity-plan §5.11 的**判据**那一半)。
///
/// **四处共用这一句**(入站步骤 ⑦ / 出站 `dial_one` / 拨号巡查的 spawn 前闸 / 协调者
/// 装链前的 `EngineSlot::gate_allows`):各写一遍就是同一条规则的第二份描述
/// (first-draft-checklist 14),而这四处必须永远说同一句话。
///
/// ⛔ **锁只在这一句里活**:名册闸是叶子锁(见 `EngineSlot::gate`),持有它的时候不许再
/// 去拿任何别的锁,故它与紧邻的 `id.current()`(要库锁)恒是先后两次独立取锁、绝不嵌套。
pub(crate) fn gate_allows(gate: &Arc<Mutex<lan::RosterGate>>, peer: &str) -> bool {
    gate.lock().expect("roster gate mutex poisoned").allows(peer)
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
        // 摘条目 + 结清令牌**在同一把锁里**(见 [`LanAdmission::settle`] 的头注):此前是
        // 两次取锁,而「两个判决源缺一不可」那条形如今由 `settle` 的签名端着 —— 它把
        // `spend` 吃进去,没有一个可以被下一个人丢掉的返回值(那正是 L1 的形状)。
        self.adm.settle(self.id, self.ip, self.spend);
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
    // ⛔ **名册闸的入站那一道,挂在同一句自证上**(identity-plan §5.11;**不新开生命周期
    // 入口**):从 ② 认下空间到这里跨了三次 `.await`,名册这期间可能已经把这台摘掉,而
    // 此刻它还没进链路集 —— 「拆现有链」什么也拆不到,只有这一句拦得住这条路。
    //
    // ⭐ **算「对端的无效尝试」(花那一枚令牌),不走本机侧的退款路**。这一格是本笔自己
    // 定的形,理由:①`admit_conn` 那枚令牌是 pre-auth 唯一的**速率**闸,退了款就等于给
    // 一台已被移除的设备开了条「无限次让本机验签」的路(它手上的 K_acc 与钉住的公钥都还
    // 是真的,前面几道闸一道也拦不住它);②`Aborted` 那一档的语义是「**本机**此刻服务不
    // 了」(换代 / 条目已摘 / 移交队满),而名册拒绝是一条关于**对端**的、持久的授权裁决,
    // 不是本机的临时处境;③代价是对称的:合法对端只在「名册刚变、它还不知道」那几分钟里
    // 被记账,而它自带 15s→300s 退避,相对 10/s 的桶是可忽略量。
    if !gate_allows(&bound.gate, intro.from) {
        return PreAuth::Rejected;
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

    /// 名册一变,**当场**取消那些新被拒的对端的在飞出站握手(identity-plan §5.11)。
    ///
    /// ⚠ 这是**触发器不是判据**:安全靠的是三道闸各自问一次当前 gate,这一句只是让不合法
    /// 的那条不必等到 handoff 才被拒。故它按 [`lan::NewlyDenied::hits`](**这次**才变得
    /// 不准)而不是 `allows`(此刻准不准)—— 后者会把「只多了一台无关设备」「只改了 admin
    /// 标记」这类无关变更也拿来 abort 一批合法握手(§5.11 三轮 M3 拍死的那张表)。
    pub(crate) fn abort_denied(&mut self, denied: &lan::NewlyDenied) {
        self.inflight.retain(|peer, h| {
            let doomed = denied.hits(peer);
            if doomed {
                h.abort();
            }
            !doomed
        });
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
        // 权威名册闸(identity-plan §5.11)。**传的是把手不是快照**:spawn 出去的那只握手
        // 任务要在交 handoff 之前拿**当时**的名册再问一次,拷一份进去就是「各存一份会漂的
        // 名单」(§5.11 item ②)。
        gate: &Arc<Mutex<lan::RosterGate>>,
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
            // ⛔ **名册闸,在 spawn 之前**(identity-plan §5.11 item ⑤ 的前一半):不在册的
            // 对端一只任务都不该起。与下面那几种一样属于「**结构上**不该拨」,故照它们的
            // 办法顺手清掉退避条目 —— 留着的话它那个早已过期的 `next` 会把巡查时刻永远钉在
            // 过去(空转)。名册退回 `None` 或它重新在册时,恒在的空闲巡查会再拨。
            if !gate_allows(gate, &peer) {
                self.peers.remove(&peer);
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
                gate: Arc::clone(gate),
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
    /// 权威名册闸的把手(identity-plan §5.11)。**与协调者手上那只是同一份**,故「交
    /// handoff 之前问的是当前名册」是结构事实,不是一份拷贝碰巧还新鲜。
    gate: Arc<Mutex<lan::RosterGate>>,
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
    // ③ 跨过写 Confirm 那次 await 了:**交 handoff 之前**最后自证。⛔ 名册闸的第二道也
    // 挂在这一句上(identity-plan §5.11 item ⑤ 的后一半;**不新开生命周期入口**):从
    // `round` 里那次 spawn 前的复核到这里跨了好几次 await,名册这期间可能已经把它摘掉,
    // 而此刻它还没进链路集 —— 「拆现有链」什么也拆不到,只有这一句拦得住这条路。
    // 两次取锁**先后独立、绝不嵌套**(gate 是叶子锁)。
    if !gate_allows(&b.gate, peer) || !b.id.current() {
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
        adm.lock().tasks.get_mut(&id).expect("在表上").bound =
            Some(TaskBound { space: "s1".into(), peer: "01PEERAAAAAAAAAAAAAAAAAAAA".into() });
        let victim = tokio::spawn(async { std::future::pending::<()>().await });
        let doomed = abort_bound_to(&mut adm.lock(), "s1");
        assert!(doomed.is_empty(), "句柄还没交上去,这一下一个把手都收不到");
        assert!(!victim.is_finished(), "句柄还没交上去,这一下当然打不着");
        adm.set_abort(id, victim.abort_handle());
        // 限时:没补刀的话这只任务永远跑下去,拿超时当红比让整轮测试挂死体面。
        let done = tokio::time::timeout(Duration::from_secs(2), victim).await;
        assert!(done.expect("补刀该当场生效").expect_err("该被取消").is_cancelled());
    }

    /// 注册一个 s1 条目;交回 handoff 的接收端(调用方留着,别让通道提前关)。
    fn register_s1(
        adm: &Arc<LanAdmission>,
        owner: u64,
        k_acc: [u8; 32],
    ) -> mpsc::Receiver<AdoptedLink> {
        let (handoff, rx) = mpsc::channel(4);
        adm.register(Registration {
            space_id: "s1".into(),
            owner,
            account_id: "01ACCTAAAAAAAAAAAAAAAAAAAA".into(),
            self_device: "01SELFAAAAAAAAAAAAAAAAAAAA".into(),
            k_acc,
            self_seed: [7u8; 32],
            db: Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap())),
            active: Arc::new(Mutex::new(HashSet::new())),
            gate: Arc::new(Mutex::new(lan::RosterGate::default())),
            handoff,
        })
        .expect("注册");
        rx
    }

    /// 摆一只「已认下 s1、abort 句柄也已经交上去」的在飞任务,交回它的 join 把手。
    fn plant_bound_task(adm: &Arc<LanAdmission>) -> tokio::task::JoinHandle<()> {
        let id = adm.admit_conn(Ipv4Addr::LOCALHOST.into()).expect("该放行");
        adm.lock().tasks.get_mut(&id).expect("在表上").bound =
            Some(TaskBound { space: "s1".into(), peer: "01PEERAAAAAAAAAAAAAAAAAAAA".into() });
        let victim = tokio::spawn(async { std::future::pending::<()>().await });
        adm.set_abort(id, victim.abort_handle());
        victim
    }

    /// ⛔ **三个调用点必须真的扣扳机**(384 清 379 那笔「锁内 abort」债时新造出来的义务):
    /// [`abort_bound_to`] 从「函数体里直接打」改成「锁内标死、把手交回调用方」之后,
    /// **谁去 abort** 就从函数体里的一句代码变成了**调用方的**义务。`#[must_use]` 只在编译期
    /// 喊一嗓子(本 crate 不 `deny(warnings)`),挡不住「收了把手却不打」,故三处各要一条
    /// 行为字据。
    ///
    /// ⚠ 靶子刻意是**一只永不自了的 `pending()` 任务** + 2 秒上界:拿真握手当靶子的话,
    /// 「忘了 abort」会被那 10 秒的握手超时兜成绿的 —— 慢十秒,但还是绿。
    #[tokio::test]
    async fn every_caller_of_abort_bound_to_actually_pulls_the_trigger() {
        for case in ["deregister", "revoke", "register(换代)"] {
            let adm = LanAdmission::ephemeral();
            let _rx = register_s1(&adm, 1, [5u8; 32]);
            let victim = plant_bound_task(&adm);
            match case {
                "deregister" => adm.deregister("s1", 1),
                "revoke" => adm.revoke("s1", 1),
                // 换了身份指纹(这里换 K_acc)= 换代:旧代未移交的任务当场取消。
                _ => drop(register_s1(&adm, 1, [6u8; 32])),
            }
            let done = tokio::time::timeout(Duration::from_secs(2), victim)
                .await
                .unwrap_or_else(|_| panic!("{case}:把手交回来了,却没人扣扳机"));
            assert!(done.expect_err("该被取消").is_cancelled(), "{case}:该当场被取消");
        }
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
            gate: Arc::new(Mutex::new(lan::RosterGate::default())),
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
            gate: Arc::new(Mutex::new(lan::RosterGate::default())),
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

    // ---- 权威名册闸的入站那一份(identity-plan §5.11;367 第②笔的第③笔) ----------

    /// 造一份名册闸(拥有式,调用方自己留把手)。
    fn gate_of(devices: Option<&[&str]>) -> Arc<Mutex<lan::RosterGate>> {
        let g = Arc::new(Mutex::new(lan::RosterGate::default()));
        drop(push_roster(&g, devices));
        g
    }

    /// 换一份名册,交回判据(**只多一台无关设备**这种变更算出来的判据命中不了任何人)。
    fn push_roster(g: &Arc<Mutex<lan::RosterGate>>, devices: Option<&[&str]>) -> lan::NewlyDenied {
        let entries: Option<Vec<sync_proto::RosterEntry>> = devices.map(|ds| {
            ds.iter().map(|d| sync_proto::RosterEntry { device: (*d).into(), admin: false }).collect()
        });
        let mut lock = g.lock().unwrap();
        lock.apply_roster(entries.as_deref())
    }

    /// 注册一个空间(只填名册闸用例关心的那几件;账户与 K_acc 由调用方分开,免得
    /// `resolve_intro` 多命中)。
    fn register_space(
        adm: &Arc<LanAdmission>,
        space: &str,
        acct: &str,
        me: &str,
        k_acc: [u8; 32],
        gate: &Arc<Mutex<lan::RosterGate>>,
    ) {
        adm.register(Registration {
            space_id: space.into(),
            owner: 1,
            account_id: acct.into(),
            self_device: me.into(),
            k_acc,
            self_seed: [7u8; 32],
            db: Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap())),
            active: Arc::new(Mutex::new(HashSet::new())),
            gate: Arc::clone(gate),
            handoff: mpsc::channel(4).0,
        })
        .expect("注册");
    }

    /// 手工摆一只「已认下空间与对端」的在飞握手(真跑一遍三步握手太重,而这几只用例要
    /// 验的是**表怎么挑人**)。返回任务号与那只永远不会自己结束的 future 的把手。
    fn fake_inflight(
        adm: &Arc<LanAdmission>,
        ip: IpAddr,
        space: &str,
        peer: &str,
    ) -> (u64, tokio::task::JoinHandle<()>) {
        let id = adm.admit_conn(ip).expect("该放行");
        adm.lock().tasks.get_mut(&id).expect("在表上").bound =
            Some(TaskBound { space: space.into(), peer: peer.into() });
        // **刻意 `pending` 到底**:它自己永远不会收场,故「被取消了」这条判据不可能被
        // 任何超时预算背书(378 那条教训的同族)。
        let task = tokio::spawn(async { std::future::pending::<()>().await });
        adm.set_abort(id, task.abort_handle());
        (id, task)
    }

    /// **多空间隔离**(§5.11 item ⑩):甲空间的名册更新不得碰乙空间 —— 哪怕两边**是同一个
    /// device_id**(device_id 是「设备 × 空间」粒度,拿甲的名册去判乙的对端就是张冠李戴)。
    ///
    /// 同轮带 §5.14-3c⑤ 那条阴性:**只多了一台无关设备**不许 abort 任何人。
    #[tokio::test]
    async fn a_roster_change_only_dooms_handshakes_bound_to_that_space() {
        const PEER: &str = "01PEERAAAAAAAAAAAAAAAAAAAA";
        const OTHER: &str = "01OTHERAAAAAAAAAAAAAAAAAAA";
        let adm = LanAdmission::ephemeral();
        let g1 = gate_of(Some(&[PEER, OTHER]));
        // 三只在飞:甲/PEER、**乙/同一个 PEER**、甲/别的对端。
        let (id_a, victim) = fake_inflight(&adm, Ipv4Addr::new(10, 0, 0, 1).into(), "s1", PEER);
        let (id_b, bystander_space) =
            fake_inflight(&adm, Ipv4Addr::new(10, 0, 0, 2).into(), "s2", PEER);
        let (id_c, bystander_peer) =
            fake_inflight(&adm, Ipv4Addr::new(10, 0, 0, 3).into(), "s1", OTHER);

        // 阴性:只多了一台无关设备 —— 一只都不许判死。
        let denied = push_roster(&g1, Some(&[PEER, OTHER, "01STRANGER0000000000000000"]));
        adm.apply_denied("s1", &denied);
        assert!(!adm.doomed_for_test(id_a), "无关变更不得当成它被移除(§5.11 三轮 M3)");

        // 阳性:把 PEER 从**甲**的名册里摘掉。
        let denied = push_roster(&g1, Some(&[OTHER]));
        adm.apply_denied("s1", &denied);
        // 判死位是**当场**写下的,故立刻问就问得出来(不必等 abort 真落地)。
        assert!(adm.doomed_for_test(id_a), "甲空间里被摘的那只该当场判死");
        assert!(!adm.doomed_for_test(id_b), "乙空间里同名的 device_id 一根汗毛都不许动");
        assert!(!adm.doomed_for_test(id_c), "同空间但没被摘的对端不许动");

        // 而且真的取消了(判死位只说「记了账」,这一句说「刀真的落下了」)。
        let done = tokio::time::timeout(Duration::from_secs(2), victim).await;
        assert!(done.expect("该当场取消").expect_err("该被取消").is_cancelled());
        assert!(!bystander_space.is_finished() && !bystander_peer.is_finished(), "旁人还活着");
        bystander_space.abort();
        bystander_peer.abort();
    }

    /// **闸是每空间的**,而且「拿哪一份」由**命中的那条准入条目**决定,不是调用方传对的:
    /// `bind_task` 从解析出来的那个空间上取把手(§5.11 那句「别用一个 app 级全局集合」)。
    #[tokio::test]
    async fn a_bound_handshake_carries_the_gate_of_the_space_it_resolved_to() {
        const ACCT1: &str = "01ACCT1AAAAAAAAAAAAAAAAAAA";
        const ACCT2: &str = "01ACCT2AAAAAAAAAAAAAAAAAAA";
        const ME1: &str = "01SELF1AAAAAAAAAAAAAAAAAAA";
        const ME2: &str = "01SELF2AAAAAAAAAAAAAAAAAAA";
        const PEER: &str = "01PEERAAAAAAAAAAAAAAAAAAAA";
        let adm = LanAdmission::ephemeral();
        let (g1, g2) = (gate_of(Some(&[PEER])), gate_of(Some(&["01NOBODYAAAAAAAAAAAAAAAAAA"])));
        register_space(&adm, "s1", ACCT1, ME1, [5u8; 32], &g1);
        register_space(&adm, "s2", ACCT2, ME2, [6u8; 32], &g2);

        // 一枚打给**乙**空间的 Intro(MAC 绑 ACCT2/K_acc2,故只可能命中 s2)。
        let (_d, wire) = lan::LanDialer::start(&lan::DialParams {
            account_id: ACCT2,
            k_acc: &[6u8; 32],
            self_seed: &[9u8; 32],
            self_device: PEER,
            peer_device: ME2,
            peer_pubkey: &[1u8; 32],
        });
        let intro = lan::Intro::parse(&wire).expect("形态合法");
        let id = adm.admit_conn(Ipv4Addr::LOCALHOST.into()).expect("该放行");
        let bound = adm.bind_task(id, &intro).expect("该恰命中 s2");
        assert_eq!(bound.space, "s2");
        assert!(Arc::ptr_eq(&bound.gate, &g2), "拿的必须是命中那个空间的名册闸");
        assert!(
            !gate_allows(&bound.gate, PEER),
            "乙空间的名册里没有它 —— 甲空间在册这件事一点都不该管用"
        );
    }

    /// 结构锚(§5.11-⑨):**持着准入表锁的那一半里,一个 `abort` 都不许有**。
    ///
    /// ⭐ **判据是签名不是函数名**(384 从「只守 `doom_denied` 一只」推广而来)。两族都算
    /// 「已经在表锁里」:①吃 `&mut Table` 的自由函数(**参数名不限** —— 384 实现审 L1:
    /// 原先写死匹配 `t: &mut Table`,于是一只正常命名的 `table: &mut Table` 会被静默漏掉,
    /// 而阳性对照那句照样通过);②`impl Table` 里的全部方法(拿得到 `&mut self` 就等于拿得到
    /// `tasks`)。这样写的用意是它**自己长大** —— 日后新写的锁内助手不必有人记得回来加白名单。
    ///
    /// ⚠ **诚实边界(三条)**:
    /// 1. 今天违反它也测不出行为差别 —— 实测 tokio 1.52.3 的 `abort()` 不会在调用线程上
    ///    当场丢掉那只 future(故 [`ConnGuard`] 的析构不会当场回头来拿这把锁)。这条锚守的
    ///    是**设计规则**(不新造跨结构锁序),不是一个今天观测得到的故障。⭐ 而正因为
    ///    「今天不是 bug」,原先那三处锁内 abort 才被记成「tokio 版本绑定债」躺了一轮;
    ///    这条锚推广开之后,那笔债就不必再靠人记得还了。
    /// 2. 它只认这两族的**签名**。持着 `MutexGuard` 却把 `&mut` 拆成别的形状传下去
    ///    (例如吃 `&mut HashMap<u64, Inflight>`),这道锚看不见。
    /// 3. ⛔ **`LanAdmission` 自己那些直接持 `MutexGuard` 的方法不在扫描面内**
    ///    ——`register` 是其中唯一「拿到把手之后锁还接着用」的一处,它靠的是**块作用域**
    ///    (见那只函数的头注),不是这道锚。
    #[test]
    fn no_helper_holding_the_table_lock_aborts() {
        let src = include_str!("lan_net.rs");
        let prod = src.split("\nmod tests {").next().expect("生产段");
        // **先把注释整条剔掉再匹配**(mutation-check 铁律 9):这一段的散文里本来就要点名
        // 「锁内直接 abort」这类字样,拿原文匹配的话锚会命中自己的注释。
        let prod: String =
            prod.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
        // 从一句 `fn ` 的起点切出「函数名 + 函数体」。
        let cut = |f: usize| -> (&str, &str) {
            let name = prod[f + 3..].split('(').next().expect("函数名").trim();
            let body = &prod[f..];
            let end = body.find("\n}\n").or_else(|| body.find("\n    }\n")).expect("函数体的收尾");
            (name, &body[..end])
        };
        let mut checked: Vec<&str> = vec![];
        // ①吃 `&mut Table` 的自由函数(参数名不限:匹配的是**类型**那一半)。
        for (i, _) in prod.match_indices(": &mut Table") {
            checked.push(cut(prod[..i].rfind("fn ").expect("签名总在某只 fn 里")).0);
        }
        // ②`impl Table` 里的全部方法。
        let imp = prod.find("\nimpl Table {").expect("`impl Table` 还在吗");
        let imp_body = &prod[imp..][..prod[imp..].find("\n}\n").expect("impl 块的收尾")];
        for (i, _) in imp_body.match_indices("    fn ") {
            checked.push(cut(imp + i + 4).0);
        }
        for name in &checked {
            let f = prod.find(&format!("fn {name}(")).expect("刚扫到的");
            // 判据是**调用**(`abort(`),不是名字:这些函数体本来就要读 `f.abort` 那个字段、
            // 也要在注释里点名 `set_abort` 的补刀路 —— 判成「出现 abort 三个字母就红」的话,
            // 这道锚从写下的第一天起就恒红,而恒红与恒绿一样答不出问题。
            assert!(
                !cut(f).1.contains("abort("),
                "`{name}` 跑在表锁里,它里面出现 `abort(` 就是把跨结构锁序新造了回来\
                 (§5.11-⑨);abort 的正当位置是把手交回调用方、放锁之后再打"
            );
        }
        // ⛔ 阳性对照:锚必须真的**扫到过东西**。全被改名 / 全被挪走时它会静默变绿,而
        // 「一只都没扫到」与「每只都干净」在断言上长得一模一样(339 那条教训)。
        checked.sort_unstable();
        checked.dedup();
        assert_eq!(
            checked,
            ["abort_bound_to", "doom_denied", "drop_entry", "refund_token", "tokens_sub"],
            "锁内那一族变了 —— 新增的要么确认它不 abort,要么这道锚已经扫不到东西了"
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
