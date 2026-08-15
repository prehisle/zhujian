//! 服务器唯一持久化面(sync-protocol §4/§11):账户封禁表 + 设备公钥 registry。
//! 只含元数据(账户号/设备号/公钥),零用户内容。
//!
//! * 封禁表(open-signup:准入开放,白名单已翻转):运营者手编的文本文件,一行一个
//!   被封禁的 account_id(`#` 整行注释、空行跳过),启动读一次、SIGHUP 热重载
//!   (`systemctl reload`,即时失权由 hub::reload_banlist 编排;见 deploy §2)。
//!   **每行必须是合法 26 位 ULID**(open-signup §1.1):白名单时代拼错一行=误拒
//!   (安全),封禁表拼错一行=目标账户静默未封(危险)——非法行带行号整份拒收、
//!   保留旧集合。
//! * registry:JSON 文件(公钥 hex,人可查),注册时同步落盘——**内存态与盘上
//!   恒一致**:落盘失败当场回滚内存插入并把错误上抛(fail-fast,不留「内存有、
//!   盘上无、重启后设备凭空消失」的静默分叉)。
//! * 写路径全部在调用方的 `Mutex<Registry>` 锁内完成,「检查 + 插入 + 落盘」
//!   天然原子(§4 register_first 的账户级原子 TOFU 靠这个)。

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 吊销失败(admin 面的映射见 lib.rs)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeError {
    /// 账户或设备不在 registry(先 GET /admin/devices 核对再吊)。
    NotFound,
    /// device-only 吊销时给了 account 且与真实属主不符(open-signup §1.5):
    /// **零副作用拒绝**,绝不静默按 device 吊别的账户。
    OwnerMismatch,
    /// device 反查见多个属主 = 全局唯一不变量已被破坏(load 已 fail-fast,内存态
    /// 走到这只能是逻辑 bug)——INTERNAL 拒绝,绝不任选其一吊。
    Corrupt,
    /// 落盘失败(内存已回滚,绑定仍在——吊销未生效,响亮报错别装成功)。
    Persist,
}

/// 吊销成功的结果形态(#1 硬化):admin 据此如实回执——是否把账户吊成了空墓碑。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeOutcome {
    /// 删掉一台设备,账户仍有幸存设备。
    DeviceRevoked,
    /// 删掉的是账户最后一台设备,账户归零并留作空墓碑——同 device_id 不再允许自助
    /// 重 TOFU,重新启用需运营者显式重开。
    AccountSealed,
}

/// 账户授权参数(billing-plan §3,工序 1)。**纯商业元数据预留**:席位闸/限速的
/// 执行在工序 2/3,本轮只有存取面——但盘上形态与默认语义从此定死。
/// 与封禁表正交(§1 四层表):封禁管「能不能来」,entitlement 管「来了给多少」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entitlement {
    /// 档位=参数组的公开命名(free/personal/large/…);admin 可对任意账户设任意参数,
    /// 执行只看参数不看名字。
    pub tier: String,
    /// 到期时刻(UTC);None = 不过期(免费档/运营者手动长期)。到期语义在工序 2
    /// 执行层(参数回免费档),存储层只存不判。
    pub expires_at: Option<time::OffsetDateTime>,
    pub seat_quota: u32,
    pub fastlane_bytes_per_month: u64,
}

/// 免费档默认参数(billing-plan §2;fastlane 是草值,开闸前按真实观测定)。
pub const FREE_TIER: &str = "free";
pub const FREE_SEAT_QUOTA: u32 = 2;
pub const FREE_FASTLANE_BYTES_PER_MONTH: u64 = 300 * 1024 * 1024;

/// 创号闸默认值(2026-07-31 防御评审:开放创号下 register_first 可被脚本无限刷——
/// 账户条目永不回收 + 每次创号全量重写 registry.json,进程自身必须有硬闸,不再只靠
/// 反代/系统层兜)。令牌桶**只对「真要新建账户」花令牌**:幂等重试 / NotFirst /
/// 封禁 / 墓碑都不花,老用户的鉴权与背书注册完全不经此闸。
pub const SIGNUP_BURST: u32 = 20;
/// 每枚令牌的补墨间隔(20 深 + 每分钟 1 枚:一群朋友同晚装机够用,脚本刷号封顶)。
pub const SIGNUP_REFILL_SECS: u64 = 60;
/// 账户目录硬上界(绝对磁盘/写放大封顶;到顶=运营容量事件,ERROR 告警人工处置)。
pub const MAX_ACCOUNTS: usize = 10_000;

/// 用户面设备管理的**每账户**令牌桶参数(identity-plan §5.13,367)。
/// 连接级那一份的参数住 `conn.rs`(它是连接自己的状态,不进 registry)。
pub const DEVICE_ADMIN_BURST_ACCOUNT: u32 = 10;
/// 每 10s 补一枚(连接级与账户级同节奏)。
pub const DEVICE_ADMIN_REFILL_SECS: u64 = 10;

/// 令牌桶(创号闸与设备管理闸共用)。
///
/// ⛔ **同一份补墨算术只留一份**:那段纳秒口径的商、「补满即以 `now` 重起算」、
/// 「桶满期间不攒历史时长」三条语义抄第二遍必漂(first-draft-checklist 第 14 条)。
/// 既有创号闸的两只边界测(亚毫秒 refill / 补墨语义)因此**同时**是本结构的测。
#[derive(Debug, Clone)]
pub(crate) struct TokenBucket {
    burst: u32,
    refill: std::time::Duration,
    tokens: u32,
    last: Option<std::time::Instant>,
}

impl TokenBucket {
    pub(crate) fn new(burst: u32, refill: std::time::Duration) -> Self {
        Self { burst, refill, tokens: burst, last: None }
    }

    /// 取一枚令牌,取得到回 true。单调钟由调用方给(生产 `Instant::now()`,单元测
    /// 合成 `Instant` 烤补墨边界)。调用方保证 `burst ≥ 1` 且 `refill` 非零。
    pub(crate) fn take(&mut self, now: std::time::Instant) -> bool {
        self.refill(&now);
        if self.tokens == 0 {
            return false;
        }
        self.tokens -= 1;
        true
    }

    /// **只补墨、不消费**。抽出来是因为 [`Self::is_full_at`] 也要它:补墨算术抄第二遍
    /// 必漂(checklist 第 14 条),而这份纳秒口径的算术正是当初把桶抽成一份的理由。
    fn refill(&mut self, now: &std::time::Instant) {
        let now = *now;
        let last = *self.last.get_or_insert(now);
        let deficit = self.burst - self.tokens;
        if deficit == 0 {
            self.last = Some(now);
        } else {
            // 纳秒整数口径(codex M4:毫秒截断会让亚毫秒 refill 静默改语义;refill
            // 非零由调用方断言,除零不可达)。商全程留 u128、比较后才窄转
            // (codex 二轮 L1:as u64 是静默截断点,虽要 584 年 uptime 才碰得到)。
            let refills = now.saturating_duration_since(last).as_nanos() / self.refill.as_nanos();
            if refills >= u128::from(deficit) {
                self.tokens = self.burst;
                self.last = Some(now);
            } else if refills > 0 {
                // refills < deficit ≤ burst(u32),窄转换不 truncate。
                self.tokens += refills as u32;
                self.last = Some(last + self.refill * refills as u32);
            }
        }
    }

    /// 桶在 `now` 这一刻是满的 = 这个账户没有欠账,条目可被 sweep 回收(回收后重建
    /// 即满桶,语义相同)。
    ///
    /// ⚠ **必须先补墨再判**(实现审弹二 L1):原先只看 `tokens == burst`,而任何一次
    /// `take` 都会把它打到 `burst - 1` 并**永远停在那里**(下次 `take` 补满、随即又消费
    /// 回去)⇒ **凡是用过的条目 sweep 一个都回收不了**,那句「满桶条目由 sweep 回收」
    /// 是一句没人兑现的话。
    fn is_full_at(&mut self, now: std::time::Instant) -> bool {
        self.refill(&now);
        self.tokens == self.burst
    }
}

impl Entitlement {
    /// **fail-closed 默认**(billing-plan §3):无记录按免费档执行——绝不静默给出
    /// 更宽参数,也绝不因「没设置」拒绝服务。
    pub fn free_default() -> Self {
        Entitlement {
            tier: FREE_TIER.to_owned(),
            expires_at: None,
            seat_quota: FREE_SEAT_QUOTA,
            fastlane_bytes_per_month: FREE_FASTLANE_BYTES_PER_MONTH,
        }
    }

    /// 结构不变量(set 与 load 同一把尺,坏数据两条路都响亮拒):tier 非空 ≤32
    /// 可见 ASCII(与 caps 同纪律);seat_quota ≥1(0 席=账户瘫痪,处置走封禁/
    /// AdminAbuse,不许借参数当哑闸)。fastlane 不设下限(0=全程达量速率,合法参数)。
    fn validate(&self) -> Result<(), String> {
        if self.tier.is_empty() || self.tier.len() > 32 {
            return Err(format!("tier 长度须 1..=32:{:?}", self.tier));
        }
        if !self.tier.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(format!("tier 只许可见 ASCII:{:?}", self.tier));
        }
        if self.seat_quota == 0 {
            return Err("seat_quota 须 ≥1(0 席请用封禁表/吊销处置,不用授权参数)".into());
        }
        Ok(())
    }
}

/// RFC3339 → UTC 时刻(admin 入口与 load 共用同一解析器,两条路一致)。
pub(crate) fn parse_expires(s: &str) -> Result<time::OffsetDateTime, String> {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .map_err(|e| format!("expires_at 不是合法 RFC3339(如 2027-07-19T00:00:00Z):{e}"))
}

/// 当月已授 fastlane 高水位(billing-plan §4,工序 3;169)。**quota 是月度已授权益、
/// 不是首帧观察后才授予**(codex 六轮设计审 B):升级即时抬、到期/降档当月不倒扣、
/// 新月按 `period_start` 时刻的 effective 重建。与 entitlement 同一 registry 持久化
/// 边界(每写落盘、强一致——meter 的粗 checkpoint 只承载 `fastlane_used`,grant 绝不
/// 走那条弱持久化)。`period` = UTC (年, 月),有序比较(向前滚月/墙钟回拨保留未来)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub period: (i32, u8),
    pub quota: u64,
}

/// UTC 时刻 → (年, 月)(`period_id=YYYY-MM` 的机器形;月 ∈ 1..=12)。
pub(crate) fn month_of(t: time::OffsetDateTime) -> (i32, u8) {
    (t.year(), u8::from(t.month()))
}

/// (年, 月) → 当月 UTC 月初 00:00:00(grant_floor 按此时刻算 entitlement 的有效额度)。
pub(crate) fn month_start_utc(t: time::OffsetDateTime) -> time::OffsetDateTime {
    let (y, m) = month_of(t);
    let month = time::Month::try_from(m).expect("month_of 恒返回 1..=12");
    time::Date::from_calendar_date(y, month, 1)
        .expect("每月都有 1 号")
        .midnight()
        .assume_utc()
}

/// (年,月) period → 当月 UTC 月初(AccountStatusV1.period_start,工序4)。
/// **前提:period 已过 [`period_representable`]**(sidecar 装载校验 + month_of(now) 天然合法)。
pub(crate) fn period_start_utc(period: (i32, u8)) -> time::OffsetDateTime {
    let (y, m) = period;
    let month = time::Month::try_from(m).expect("period 月 ∈ 1..=12");
    time::Date::from_calendar_date(y, month, 1)
        .expect("period 已过 period_representable 校验")
        .midnight()
        .assume_utc()
}

/// period 的下一个月(12 月→次年 1 月;`checked_add` 防 i32::MAX 溢出——实现审 M2)。
fn next_period((y, m): (i32, u8)) -> Option<(i32, u8)> {
    if m >= 12 {
        Some((y.checked_add(1)?, 1))
    } else {
        Some((y, m + 1))
    }
}

/// (年,月) period → 下月 UTC 月初(AccountStatusV1.period_end,工序4)。
/// **前提:period 已过 [`period_representable`]**。
pub(crate) fn period_end_utc(period: (i32, u8)) -> time::OffsetDateTime {
    let next = next_period(period).expect("period 已过 period_representable 校验");
    period_start_utc(next)
}

/// period 的 start 与 next-month end 是否都能被 `time::Date` 表示(工序4,实现审 M2)。
/// 损坏 sidecar 的极端年份(9999+ / i32::MAX)不能进 AccountStatusV1 构造——否则
/// period_end_utc 的 +1 溢出或 `from_calendar_date().expect()` panic。装载 sidecar 时
/// 校验,不过=按现有损坏语义整份从零。
pub(crate) fn period_representable(period: (i32, u8)) -> bool {
    let (y, m) = period;
    let Ok(month) = time::Month::try_from(m) else { return false };
    if time::Date::from_calendar_date(y, month, 1).is_err() {
        return false;
    }
    let Some((ny, nm)) = next_period(period) else { return false };
    let Ok(nmonth) = time::Month::try_from(nm) else { return false };
    time::Date::from_calendar_date(ny, nmonth, 1).is_ok()
}

/// (年, 月) → `"YYYY-MM"`(落盘人可 diff)。
fn format_period((y, m): (i32, u8)) -> String {
    format!("{y:04}-{m:02}")
}

/// `"YYYY-MM"` → (年, 月);月须 1..=12(坏数据 load 响亮拒,同 entitlement 纪律)。
fn parse_period(s: &str) -> Result<(i32, u8), String> {
    let (y, m) = s.split_once('-').ok_or_else(|| format!("period 不是 YYYY-MM:{s:?}"))?;
    let year: i32 = y.parse().map_err(|_| format!("period 年份非法:{s:?}"))?;
    let month: u8 = m.parse().map_err(|_| format!("period 月份非法:{s:?}"))?;
    if !(1..=12).contains(&month) {
        return Err(format!("period 月份须 1..=12:{s:?}"));
    }
    Ok((year, month))
}

/// set_entitlement 失败(admin 面映射见 lib.rs)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetEntitlementError {
    /// 账户不在 registry(typo 防线:entitlement 只对已存在账户设——open-signup 下
    /// 账户号由客户端自生成,预设不可能,先创号后授权)。
    UnknownAccount,
    /// 账户已「吊光归零」封存(空墓碑):授权无意义且会与重开 runbook 的手删账户
    /// 条目互相留孤儿(159 codex M2)——重开后再设。
    SealedAccount,
    /// 参数不过结构不变量(带原因,admin 400 原样回显)。
    Invalid(String),
    /// 落盘失败(内存已回滚,设置未生效)。
    Persist,
}

/// 注册失败(→ 信封 err code 的映射见 conn.rs)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterError {
    /// 账户在封禁表(对外并进 auth_failed,不给探测面)。
    Banned,
    /// register_first 时账户已有设备:走配对加入,别抢首台(并发败者也落这;
    /// 首台注册成功后的客户端重试也落这——它该转 auth,私钥在手必过)。
    NotFirst,
    /// 账户已被「吊光归零」封存(#1 硬化):revoke 掉账户最后一台设备后,账户条目
    /// 留作空墓碑,同 device_id 不得再自助 register_first、也不得被 register_device
    /// 插回;重新启用需运营者显式重开。对外并进 auth_failed,不给探测面。
    AccountSealed,
    /// register_device 目标账户从未初始化(不在 registry)。正常背书路径必有在线
    /// sponsor → 账户必非空,故此错只在防御性 / 非常规调用出现(registry 层硬不变量)。
    AccountNotInitialized,
    /// device_id 已在 registry 且不属于这次注册(§4 全局唯一守护:整库拷贝复用
    /// 设备身份,必须响亮失败,不许静默顶替)。
    DeviceIdTaken,
    /// 账户设备数已触**服务器安全硬帽**(epoch-plan §5.2 #2 / billing-plan §5 两层
    /// 判据的容量层):任何 entitlement 与席位租约都不能越过。**判定恒在幂等分支
    /// 之后**——纪元切换的预注册崩溃重试(同账户同钥)满额时也必须放行。
    AccountFull,
    /// 账户**套餐席位**已满(billing-plan §5 两层判据的商业层,工序 2):
    /// `seat_count ≥ effective_entitlement.seat_quota` 且无匹配租约。先移除一台
    /// 设备再添加;与 AccountFull 双错误码区分——这层提额可解,那层不行。
    SeatLimit,
    /// 落盘失败(内存已回滚)。
    Persist,
    /// register_first 创号令牌桶已空(洪泛闸,2026-07-31 评审):稍后重试。
    /// 对外并进 busy——只有「真要新建账户」才走到这,老用户不受牵连。
    SignupThrottled,
    /// 账户目录已达 [`MAX_ACCOUNTS`] 硬上界:拒新创号(运营容量事件,conn 层
    /// ERROR 告警;抬 Config 上界或人工清理墓碑后恢复)。对外并进 busy。
    DirectoryFull,
}

/// 纪元席位租约(billing-plan §5,工序 2):纪元切换「先预注册新身份、后吊旧身份」
/// 在满席时刻需要 +1——已鉴权 sponsor 显式求租,`register_device` 精确匹配后原子
/// 消费,允许一次商业 quota +1 但**绝不越硬帽**。
///
/// **纯内存、刻意不落盘**(与 billing-plan v4 文字「与 registry 同一持久化边界」的
/// 显式偏差):正常流程在同一条短连接内「求租→注册」秒级消费,服务器重启必然同时
/// 断掉该连接——客户端整流程重试自然重新求租,未消费租约丢了无害;消费=同一次
/// save 里「删租约+插设备」原子完成,「重启不复活已消费租约」空成立。不落盘 =
/// registry.json 零格式演进、零回滚红线升级。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatLease {
    pub sponsor: String,
    pub new_device: String,
    pub new_pubkey: [u8; 32],
    pub expires_at: time::OffsetDateTime,
}

/// grant_seat_lease 失败(→ 信封 err code 的映射见 conn.rs)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatLeaseError {
    /// 账户在封禁表(对外并进 auth_failed)。
    Banned,
    /// 目标 device_id 已被别的账户/别的钥占用——租了也注册不上,早拒早诚实。
    DeviceIdTaken,
    /// 账户已触硬帽:租约「绝不越硬帽」,求租即拒(别等注册才失败)。
    AccountFull,
}

pub struct Registry {
    banned: HashSet<String>,
    /// account → device → ed25519 公钥。BTreeMap 让落盘 JSON 稳定有序(人可 diff)。
    accounts: BTreeMap<String, BTreeMap<String, [u8; 32]>>,
    /// account → 该账户的**管理设备**集合(identity-plan §5.3;367)。**与 accounts
    /// 并行的独立 map**,不改 accounts 的值形——后者一变,`pubkey_of`/`devices_of`/
    /// 路由 fanout 全要动。
    ///
    /// 不变量(load 与每条写路径都守):`admins.keys() ⊆ accounts.keys()` 且
    /// `∀a. admins[a] ⊆ accounts[a].keys()`。**空集合的唯一规范表示 = 没有该 account
    /// 键**,不是 `a: []`(§5.6-2 二轮 M3;load 遇到显式空集合即拒启,不静默规范化)。
    ///
    /// ⚠ **命名避让**:本文件已有 [`Self::owner_of_device`],那个 owner 指的是
    /// 「哪个账户拥有这个 device_id」,与「管理设备」毫无关系。内部一律用 `admins`,
    /// **不许用 `owner`**(309 的陈账:名字对不上,下一个人就对不上)。
    ///
    /// ⛔ **不变量「admins 不得变空」只约束用户面**(hub 的 `device_admin`);运营者面
    /// (`/admin/`)**刻意保留**破坏它的能力——设/清 admins、吊销任何设备(含最后一台
    /// 管理设备),那是「只设了一台管理设备而它丢了」时的逃生口。故本层的
    /// [`Self::set_admin`] 与 [`Self::revoke_device`] **不检查非空**,别以为是漏了。
    admins: BTreeMap<String, BTreeSet<String>>,
    /// account → 授权参数(billing-plan §3;无记录=免费档默认,fail-closed)。
    /// 只由 admin 写,规模有账户数上界(set 要求账户已存在)。
    entitlements: BTreeMap<String, Entitlement>,
    /// account → 未消费的纪元席位租约(billing-plan §5,工序 2)。**每账户同时最多
    /// 一枚**(新求租烧旧开新)、纯内存不落盘(论证见 [`SeatLease`]);只有已鉴权
    /// sponsor 能开 → 规模有账户数上界,过期由 [`Self::sweep_seat_leases`] 清。
    seat_leases: BTreeMap<String, SeatLease>,
    /// account → 当月已授 fastlane 高水位(billing-plan §4 工序 3;169)。**随 registry
    /// 每写落盘**(与 entitlement 同一持久化边界),由 admin `set_entitlement`、sweeper
    /// 月初滚月([`Self::roll_grants_to_current_month`])写;数据热路径只读
    /// [`Self::effective_grant_quota`]。规模有账户数上界。
    grants: BTreeMap<String, Grant>,
    /// 免费档月度 fastlane 额度(169;默认 [`FREE_FASTLANE_BYTES_PER_MONTH`],由 Hub
    /// 从 Config 注入——生产 300MiB「草值」,测试可注小值烤限速)。只影响无显式
    /// entitlement 账户的 effective fastlane;其余字段仍走 free_default 常量。
    free_fastlane: u64,
    /// 免费档席位数(默认 [`FREE_SEAT_QUOTA`]=2,由 Hub 从 Config 注入——推广期
    /// 生产设 4[`--free-seat-quota`],收费期改回默认不重编;测试恒用常量默认 2)。
    /// 只影响无显式 entitlement 账户的 effective seat_quota;硬帽 device_cap 仍两层取 min。
    free_seat: u32,
    /// 封禁表文件路径(SIGHUP 热重载重读它;`path` 是 registry.json)。
    banlist_path: PathBuf,
    path: PathBuf,
    /// 创号闸参数(2026-07-31 评审;默认 [`SIGNUP_BURST`]/[`SIGNUP_REFILL_SECS`]/
    /// [`MAX_ACCOUNTS`],由 Hub 从 Config 注入,测试注小值烤洪泛路径)。桶态纯运行期
    /// 不落盘(重启=满桶,无害:上界护的是持续洪泛,不是瞬时突刺)。
    max_accounts: usize,
    signup: TokenBucket,
    /// account → 用户面设备管理的令牌桶(367,§5.13)。**纯内存不落盘**(同
    /// `seat_leases`);只为真正发过 `DeviceAdmin` 的账户建条目,满桶即由
    /// [`Self::sweep_admin_buckets`] 回收 ⇒ 规模有账户数上界,不随时间单调增长。
    admin_buckets: BTreeMap<String, TokenBucket>,
}

/// 落盘形态(公钥 hex;entitlements `serde(default)`——旧 registry.json 无此键
/// 照常加载,空 map 不写键、未设过授权的生产文件字节不变)。
/// `deny_unknown_fields`(159 codex H2 的前向教训):本版之前的二进制对未知顶层键
/// 是「静默吞掉、下次保存抹掉」——将来再加键时,本版会响亮拒启而不是静默丢数据。
/// 回滚红线(deploy §2):entitlement 首次写入后,不得让 159 之前的旧二进制再写盘。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskForm {
    accounts: BTreeMap<String, BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    entitlements: BTreeMap<String, EntitlementDisk>,
    /// 当月已授 fastlane 高水位(169,工序 3;serde default——旧文件无此键照常加载、
    /// 空 map 不写键=未触发限速的生产文件字节不变)。回滚红线见 deploy §2:grant
    /// 首写后旧二进制(deny_unknown_fields)会响亮拒启,须先删 `grants` 键再回滚。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    grants: BTreeMap<String, GrantDisk>,
    /// account → 管理设备集合(367;serde default——旧文件无此键照常加载、空 map 不
    /// 写键=尚无任何管理设备的生产文件字节不变)。
    /// ⛔ **回滚红线(deploy §2)**:`admins` 键一旦写进 registry.json,旧二进制
    /// (`deny_unknown_fields`)会**响亮拒启**——这是 159 刻意设计的行为,不是 bug。
    /// 回滚不许「恢复部署前的备份」(那会把部署后合法的注册/吊销一起撤销,最危险的
    /// 是**把已吊销的设备复活**),只能停写后基于**当前**文件做受控降级转换:只摘
    /// `admins` 键、保留当前 accounts/entitlements/grants(§5.10-3)。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    admins: BTreeMap<String, BTreeSet<String>>,
}

/// entitlement 落盘形态(expires_at 存 RFC3339 文本,人可查)。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EntitlementDisk {
    tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    seat_quota: u32,
    fastlane_bytes_per_month: u64,
}

/// grant 落盘形态(period 存 `"YYYY-MM"` 文本,人可查)。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantDisk {
    period: String,
    quota: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let hi = (chunk[0] as char).to_digit(16).unwrap() as u8;
        let lo = (chunk[1] as char).to_digit(16).unwrap() as u8;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

/// 封禁表文件 → 账户集合(一行一个 account_id,`#` 整行注释与空行跳过)。
/// load 与 reload_banlist 共用,两条路径解析规则恒一致。
/// **逐行 is_ulid 严格校验**(open-signup §1.1):非法行(拼错/行内注释/形态不对)
/// 带行号整份报错——封禁表方向上,静默跳过一行 = 目标账户没被封,fail-open 危险。
fn parse_banlist(path: &Path) -> io::Result<HashSet<String>> {
    let raw = fs::read_to_string(path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("读封禁表 {} 失败:{e}(一行一个 account_id,# 整行注释)", path.display()),
        )
    })?;
    let mut banned = HashSet::new();
    for (idx, line) in raw.lines().enumerate() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        if !sync_proto::is_ulid(l) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "封禁表 {} 第 {} 行不是合法 26 位账户号:{l:?}——整份拒收、保留旧集合(行内注释不支持;先离线校验再原子替换,见 deploy §2)",
                    path.display(),
                    idx + 1
                ),
            ));
        }
        banned.insert(l.to_owned());
    }
    Ok(banned)
}

/// 封禁表离线校验(main.rs `--validate-banlist`,open-signup §1.6 运维纪律):
/// 与 load/reload 完全同一解析器——校验过的文件,原子替换后 reload 必过。
pub fn validate_banlist(path: &Path) -> io::Result<usize> {
    parse_banlist(path).map(|s| s.len())
}

/// registry 离线校验(main.rs `--validate-registry`;identity-plan §5.16.5-1)。
///
/// **升级前必跑**:367 给 load 加了两道新的拒启判据(账户设备数 ≤
/// [`sync_proto::MAX_ROSTER_DEVICES`]、admins 三条不变量),而现网 registry 是历史
/// 数据——超编账户是**可能存在**的(硬帽历史上调高再调低就会留下),别等升上去
/// 才发现拒启。拿一份现网 registry.json 的副本跑它,过了再部署。
///
/// ⛔ **内容判据与正式 [`Registry::load`] 同源**:本函数**就是**调 load,不许各写一遍
/// (§5.14 3d)。
///
/// ⚠ **它证明的范围就这么大,别说成「校验过就一定起得来」**(实现审弹一 L3:我原话
/// 是「校验过的文件,新二进制必启得来」,被 `device_cap` 那个反例当场证伪)。准确的
/// 一句是:**给定这份 banlist,这份 registry 文件过得了 `Registry::load` 的内容判据**。
/// 启动还要过配置闸(`device_cap ≤ MAX_ROSTER_DEVICES`、throttle 上界…)、端口、
/// 内存包络 —— 那些本函数一个都不看。
///
/// ⚠ **存在性这一格必须自己判,不能靠 load**(实现审弹一 M1):`load` 把 `NotFound`
/// 当**首启空 registry**——那对服务器是对的(首次注册时创建),但对本函数是**假绿**:
/// 路径拼错 / 副本没拷过来,回的是「ok,账户 0 个」。而这只工具存在的全部理由,就是
/// 「升级前拿一份现网副本跑一遍」——它答错的那一刻,正是最需要它答对的那一刻。
/// 故先要求目标存在且是**普通文件**(目录会让 load 报别的错,同样不许当合法)。
pub fn validate_registry(banlist_path: &Path, registry_path: PathBuf) -> io::Result<String> {
    let display = registry_path.display().to_string();
    match fs::metadata(&registry_path) {
        Ok(m) if m.is_file() => {}
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{display} 不是普通文件(校验的对象必须是一份 registry.json)"),
            ))
        }
        Err(e) => {
            return Err(io::Error::new(
                e.kind(),
                format!("读不到 {display}:{e}(校验对象必须存在——路径拼错时绝不回「合法」)"),
            ))
        }
    }
    let reg = Registry::load(banlist_path, registry_path)?;
    let accounts = reg.accounts.len();
    let devices: usize = reg.accounts.values().map(|d| d.len()).sum();
    let max_devices = reg.accounts.values().map(|d| d.len()).max().unwrap_or(0);
    // 「有几个账户还没回填管理设备」正是 §5.16.5-2 那张回填清单要的数——没回填的
    // 账户,新服上线后用户面**按设计 fail-closed**(不是 bug)。
    let without_admins: Vec<&str> = reg
        .accounts
        .iter()
        .filter(|(a, devs)| !devs.is_empty() && !reg.admins.contains_key(*a))
        .map(|(a, _)| a.as_str())
        .collect();
    Ok(format!(
        "ok:{display} 合法。账户 {accounts} 个 / 设备 {devices} 台 / 单账户最多 {max_devices} 台(上限 {})。\n未设管理设备的账户 {} 个{}",
        sync_proto::MAX_ROSTER_DEVICES,
        without_admins.len(),
        if without_admins.is_empty() {
            String::new()
        } else {
            format!(
                ":\n  {}\n  ⚠ 这些账户在新服上线后,用户面的设备管理整条不可用(fail-closed,不是 bug)——\n    照 identity-plan §5.16.5-2 逐个 POST /admin/set-admin 回填,并记下「账户 / device_id / 确认人」。",
                without_admins.join("\n  ")
            )
        }
    ))
}

impl Registry {
    /// 封禁表必须存在(空文件=零封禁,运维意图显式;缺文件=部署残缺,fail-fast);
    /// registry 文件不存在 = 空(首启,首次注册时创建)。
    pub fn load(banlist_path: &Path, registry_path: PathBuf) -> io::Result<Self> {
        let banned = parse_banlist(banlist_path)?;

        let (accounts, entitlements, grants, admins) = match fs::read_to_string(&registry_path) {
            Ok(json) => {
                let disk: DiskForm = serde_json::from_str(&json).map_err(|e| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("registry {} 不是合法 JSON:{e}", registry_path.display()),
                    )
                })?;
                let mut accounts = BTreeMap::new();
                for (acct, devices) in disk.accounts {
                    let mut m = BTreeMap::new();
                    for (dev, key_hex) in devices {
                        let key = unhex32(&key_hex).ok_or_else(|| {
                            io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!("registry 里 {acct}/{dev} 的公钥不是 64 位 hex"),
                            )
                        })?;
                        m.insert(dev, key);
                    }
                    accounts.insert(acct, m);
                }
                // entitlement 与 set 同一把尺校验(fail-fast 拒启:registry 只由本
                // 进程与运维之手写,坏条目=人工编辑或 bug,绝不静默丢弃或降免费档
                // ——billing-plan §1-6)。
                let mut entitlements = BTreeMap::new();
                for (acct, e) in disk.entitlements {
                    if !accounts.contains_key(&acct) {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!(
                                "registry {} 损坏:entitlement 指向不存在的账户 {acct}(拒启,人工核对)",
                                registry_path.display()
                            ),
                        ));
                    }
                    let expires_at = match e.expires_at {
                        None => None,
                        Some(s) => Some(parse_expires(&s).map_err(|msg| {
                            io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!("registry 里 {acct} 的 entitlement:{msg}"),
                            )
                        })?),
                    };
                    let ent = Entitlement {
                        tier: e.tier,
                        expires_at,
                        seat_quota: e.seat_quota,
                        fastlane_bytes_per_month: e.fastlane_bytes_per_month,
                    };
                    ent.validate().map_err(|msg| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("registry 里 {acct} 的 entitlement:{msg}"),
                        )
                    })?;
                    entitlements.insert(acct, ent);
                }
                // grant(169,工序 3):与 entitlement 同一把尺——指向不存在账户 / period
                // 形态坏 = 拒启(计量态也不许静默丢弃)。
                let mut grants = BTreeMap::new();
                for (acct, g) in disk.grants {
                    if !accounts.contains_key(&acct) {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!(
                                "registry {} 损坏:grant 指向不存在的账户 {acct}(拒启,人工核对)",
                                registry_path.display()
                            ),
                        ));
                    }
                    let period = parse_period(&g.period).map_err(|msg| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("registry 里 {acct} 的 grant:{msg}"),
                        )
                    })?;
                    grants.insert(acct, Grant { period, quota: g.quota });
                }
                (accounts, entitlements, grants, disk.admins)
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                (BTreeMap::new(), BTreeMap::new(), BTreeMap::new(), BTreeMap::new())
            }
            Err(e) => return Err(e),
        };

        // device 全局唯一的磁盘态守护(open-signup §1.5 双层之一):device-only
        // 吊销反查依赖它,坏 registry 直接拒启,绝不带着歧义上线。
        {
            let mut owner_of: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
            for (acct, devs) in &accounts {
                for dev in devs.keys() {
                    if let Some(prev) = owner_of.insert(dev.as_str(), acct.as_str()) {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!(
                                "registry {} 损坏:device {dev} 同时属于账户 {prev} 与 {acct}(device 全局唯一被破坏,拒启)",
                                registry_path.display()
                            ),
                        ));
                    }
                }
            }
        }

        // 名册容量硬闸(identity-plan §5.13,设计审一轮 H6 / 二轮 H3)。**存量超编即
        // 拒启,不静默截断**——截断会藏掉设备,比帧过大危险得多。「N 有多大」此前
        // 由数据说了算:`device_cap` 只在**注册那一刻**判、load 从不校验存量,而硬帽
        // 是可配置的、历史上调高再调低就会留下超编账户。
        // ⚠ 这道闸与离线 validator(`--validate-registry`)**同源**——validator 就是
        // 调本函数,不许各写一遍判据。
        for (acct, devs) in &accounts {
            if devs.len() > sync_proto::MAX_ROSTER_DEVICES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "registry {} 里账户 {acct} 有 {} 台设备,超过 MAX_ROSTER_DEVICES={}(拒启:名册帧有硬上界,截断会藏掉设备——先用 admin 面吊销到限内,升级前请跑 --validate-registry)",
                        registry_path.display(),
                        devs.len(),
                        sync_proto::MAX_ROSTER_DEVICES
                    ),
                ));
            }
        }

        // admins 的两条不变量 + 空集合唯一规范表示(§5.6-2 二轮 M3)。与 entitlement /
        // grant 同一把尺:坏条目 = 人工编辑或 bug,**响亮拒启**,绝不静默丢弃或规范化。
        for (acct, set) in &admins {
            if set.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "registry {} 损坏:账户 {acct} 的 admins 是显式空集合——空的唯一规范表示是**没有该键**(拒启,人工核对)",
                        registry_path.display()
                    ),
                ));
            }
            let Some(devs) = accounts.get(acct) else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "registry {} 损坏:admins 指向不存在的账户 {acct}(拒启,人工核对)",
                        registry_path.display()
                    ),
                ));
            };
            for dev in set {
                if !devs.contains_key(dev) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "registry {} 损坏:{acct} 的管理设备 {dev} 不在该账户设备表里(幽灵管理位,拒启)",
                            registry_path.display()
                        ),
                    ));
                }
            }
        }

        Ok(Registry {
            banned,
            accounts,
            admins,
            entitlements,
            seat_leases: BTreeMap::new(),
            grants,
            free_fastlane: FREE_FASTLANE_BYTES_PER_MONTH,
            free_seat: FREE_SEAT_QUOTA,
            banlist_path: banlist_path.to_owned(),
            path: registry_path,
            max_accounts: MAX_ACCOUNTS,
            signup: TokenBucket::new(
                SIGNUP_BURST,
                std::time::Duration::from_secs(SIGNUP_REFILL_SECS),
            ),
            admin_buckets: BTreeMap::new(),
        })
    }

    /// 重读封禁表文件、替换内存集合,返回当前封禁数(SIGHUP 经 hub::reload_banlist
    /// 调用——即时失权的 kick/烧槽编排在 hub,registry 只换集合;设备 registry 是
    /// 另一根轴、不受影响)。读/解析失败 = **保留旧集合**并上抛错误(fail-safe:
    /// 坏文件绝不把封禁集合清空放行,也绝不误封)。
    /// 调用方持 `Mutex<Registry>` 锁 → 与 conn.rs 鉴权路径互斥,换集合对在途鉴权原子。
    pub fn reload_banlist(&mut self) -> io::Result<usize> {
        let fresh = parse_banlist(&self.banlist_path)?;
        self.banned = fresh;
        Ok(self.banned.len())
    }

    /// 原子落盘:tmp 写 + rename(Windows 的 std rename 会替换已存在目标)。
    /// 耗时观测(open-signup L6:每注册全量重写整个 registry.json,开放准入后账户数
    /// 可被陌生人推大——save 变慢是最早的退化信号,超阈值响亮报 WARN 进 journal)。
    fn save(&self) -> io::Result<()> {
        let started = std::time::Instant::now();
        let disk = DiskForm {
            accounts: self
                .accounts
                .iter()
                .map(|(a, devs)| {
                    (a.clone(), devs.iter().map(|(d, k)| (d.clone(), hex(k))).collect())
                })
                .collect(),
            entitlements: self
                .entitlements
                .iter()
                .map(|(a, e)| {
                    let expires_at = e.expires_at.map(|t| {
                        t.format(&time::format_description::well_known::Rfc3339)
                            .expect("load/set 只收 RFC3339 解析成功的时刻,回写无失败路径")
                    });
                    (
                        a.clone(),
                        EntitlementDisk {
                            tier: e.tier.clone(),
                            expires_at,
                            seat_quota: e.seat_quota,
                            fastlane_bytes_per_month: e.fastlane_bytes_per_month,
                        },
                    )
                })
                .collect(),
            grants: self
                .grants
                .iter()
                .map(|(a, g)| {
                    (a.clone(), GrantDisk { period: format_period(g.period), quota: g.quota })
                })
                .collect(),
            admins: self.admins.clone(),
        };
        let json = serde_json::to_string_pretty(&disk).expect("BTreeMap<String,_> 序列化无失败路径");
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json)?;
        let out = fs::rename(&tmp, &self.path);
        let elapsed = started.elapsed();
        if elapsed.as_millis() > 200 {
            crate::logln(format!(
                "WARN registry 落盘慢:{}ms,账户数 {}(开放准入下的退化信号,见 deploy §6 观测)",
                elapsed.as_millis(),
                self.accounts.len()
            ));
        }
        out
    }

    pub fn is_banned(&self, account: &str) -> bool {
        self.banned.contains(account)
    }

    pub fn pubkey_of(&self, account: &str, device: &str) -> Option<[u8; 32]> {
        self.accounts.get(account)?.get(device).copied()
    }

    /// 账户全部已注册设备(路由 fanout 的收件人全集;信箱只为它们开)。
    pub fn devices_of(&self, account: &str) -> Vec<String> {
        self.accounts
            .get(account)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// device_id 在整个 registry 里的归属(§4 全局唯一守护的查询面)。
    fn device_owner(&self, device: &str) -> Option<(&str, &[u8; 32])> {
        self.accounts
            .iter()
            .find_map(|(a, devs)| devs.get(device).map(|k| (a.as_str(), k)))
    }

    /// device → 属主账户反查(open-signup §1.5,admin device-only 吊销用)。
    /// 内存态多 owner = 全局唯一不变量被破坏(load 已拒启、插入路径都先查
    /// device_owner,走到这只能是逻辑 bug)——Err,调用方 INTERNAL 拒绝。
    pub fn owner_of_device(&self, device: &str) -> Result<Option<String>, ()> {
        let mut owners =
            self.accounts.iter().filter(|(_, devs)| devs.contains_key(device)).map(|(a, _)| a);
        let first = owners.next().cloned();
        if owners.next().is_some() {
            return Err(());
        }
        Ok(first)
    }

    /// 账户在 registry 且未封存(admin 面存在性判断;空墓碑不算——它挡一切自助路)。
    pub fn account_exists(&self, account: &str) -> bool {
        self.accounts.get(account).is_some_and(|devs| !devs.is_empty())
    }

    /// 设置账户授权参数(billing-plan §3 工序 1,admin 面唯一写入口)。
    /// 「检查 + 换内存 + 落盘」在调用方的 `Mutex<Registry>` 锁内原子;落盘失败回滚
    /// 内存(设置未生效,响亮报错)。成功即内存态生效——将来工序 2/3 的执行闸在同
    /// 一把锁下读 [`Self::effective_entitlement`],**即时生效不依赖 SIGHUP**。
    /// 只对已存在且未封存的账户设(typo 防线;空墓碑拒——授权无意义,且重开
    /// runbook 手删账户条目会留下孤儿 entitlement 触发拒启,159 codex M2)。
    pub fn set_entitlement(
        &mut self,
        account: &str,
        ent: Entitlement,
        now: time::OffsetDateTime,
    ) -> Result<(), SetEntitlementError> {
        ent.validate().map_err(SetEntitlementError::Invalid)?;
        match self.accounts.get(account) {
            None => return Err(SetEntitlementError::UnknownAccount),
            Some(devs) if devs.is_empty() => return Err(SetEntitlementError::SealedAccount),
            Some(_) => {}
        }
        // grant 高水位(169,工序 3;codex B):升级即时抬、到期/降档当月不倒扣。
        // 顺序钉死——先按**旧** entitlement 取本月基值(base)与变更前 effective,
        // 再覆盖 entitlement、取变更后 effective,grant.quota = max(三者)。
        let now_month = month_of(now);
        let old_eff_now = self.effective_entitlement(account, now).fastlane_bytes_per_month;
        // 本月 grant 基值:同月已有则用其 quota(已含既往抬升);否则(缺省/跨月/回拨)
        // 按 period_start 时刻的**旧** entitlement 重建(捕获月初有效额度,不受月中到期影响)。
        let (base_period, base_quota) = match self.grants.get(account) {
            Some(g) if g.period == now_month => (g.period, g.quota),
            // 墙钟回拨(grant 在未来月):保留未来 period 与 quota,不倒退重建。
            Some(g) if g.period > now_month => (g.period, g.quota),
            _ => (
                now_month,
                self.effective_entitlement(account, month_start_utc(now))
                    .fastlane_bytes_per_month,
            ),
        };
        // 快照供回滚(entitlement + grant 同一 save 事务,失败一并还原)。
        let prev_ent = self.entitlements.insert(account.to_owned(), ent);
        let prev_grant = self.grants.get(account).cloned();
        let new_eff_now = self.effective_entitlement(account, now).fastlane_bytes_per_month;
        self.grants.insert(
            account.to_owned(),
            Grant { period: base_period, quota: base_quota.max(old_eff_now).max(new_eff_now) },
        );
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                crate::logln(format!(
                    "ERROR registry 落盘失败,已回滚 entitlement+grant 设置 {account}:{e}"
                ));
                match prev_ent {
                    Some(p) => {
                        self.entitlements.insert(account.to_owned(), p);
                    }
                    None => {
                        self.entitlements.remove(account);
                    }
                }
                match prev_grant {
                    Some(g) => {
                        self.grants.insert(account.to_owned(), g);
                    }
                    None => {
                        self.grants.remove(account);
                    }
                }
                Err(SetEntitlementError::Persist)
            }
        }
    }

    /// 账户在 `now` 时刻的**生效授权参数**(billing-plan §3/§5 到期语义的参数轴):
    /// 显式记录且未到期 → 原样;已到期(`expires_at ≤ now`)或无记录 → 免费档默认
    /// (fail-closed)。时间显式入参——执行闸(工序 2/3)与展示各自报时,存取层不
    /// 偷读墙钟(159 codex M1:名为 effective 就得真判到期)。两条刻意不在这层:
    /// 「当月 fastlane 不倒扣」在工序 3 计数层组合;「到期宽限同步期」是工序 2
    /// 执行闸的缓冲(宽限内不进 SeatOverage),不是参数变化。
    pub fn effective_entitlement(&self, account: &str, now: time::OffsetDateTime) -> Entitlement {
        match self.entitlements.get(account) {
            Some(e) if e.expires_at.is_none_or(|t| t > now) => e.clone(),
            _ => self.free_entitlement(),
        }
    }

    /// 免费档 effective(fastlane 走 Config 注入的 [`Self::free_fastlane`]、seat_quota 走
    /// 注入的 [`Self::free_seat`],其余走 [`Entitlement::free_default`] 常量)。
    fn free_entitlement(&self) -> Entitlement {
        Entitlement {
            seat_quota: self.free_seat,
            fastlane_bytes_per_month: self.free_fastlane,
            ..Entitlement::free_default()
        }
    }

    /// Config 注入免费档 fastlane 额度(Hub::new 调;生产 300MiB,测试可注小值)。
    pub fn set_free_fastlane(&mut self, bytes: u64) {
        self.free_fastlane = bytes;
    }

    /// Config 注入免费档席位数(Hub::new 调;推广期生产 4,测试恒默认 2)。**调用方
    /// 保证 ≥1**(0 席=免费账户全瘫、且 free_entitlement 不过 [`Entitlement::validate`]
    /// ——CLI `--free-seat-quota` 解析处已拒 0)。
    pub fn set_free_seat(&mut self, quota: u32) {
        self.free_seat = quota;
    }

    /// Config 注入创号闸参数(Hub::new 调;测试注小值烤洪泛路径)。桶重置为满、
    /// 基点清零(注入即换闸,不继承旧参数下攒的进度)。调用方保证三值均 ≥1/非零
    /// (serve_inner fail-fast 校验)。
    pub fn set_signup_limits(
        &mut self,
        burst: u32,
        refill: std::time::Duration,
        max_accounts: usize,
    ) {
        // fail-fast(serve_inner 已校验;这里是最后防线——0 值会让 signup_take
        // 除零/永拒,绝不静默容忍)。
        assert!(burst >= 1 && !refill.is_zero() && max_accounts >= 1, "创号闸参数须非零");
        self.signup = TokenBucket::new(burst, refill);
        self.max_accounts = max_accounts;
    }

    /// 创号令牌桶:按 `now` 补墨后取一枚,空桶 = false(算术见 [`TokenBucket::take`])。
    fn signup_take(&mut self, now: std::time::Instant) -> bool {
        self.signup.take(now)
    }

    /// 用户面设备管理的**每账户**令牌桶(367,§5.13):按 `now` 补墨后取一枚。
    ///
    /// ⛔ **只有通过授权、且不是幂等的请求才扣**(三轮 M4 / 四轮 M2)——判定顺序只有
    /// 一份,在 `hub::device_admin`,这里只管桶。扣早了的后果:任一非管理设备都能持续
    /// 发越权请求把账户桶耗干,让真正的管理设备长期收到 busy(共享桶被无权者压制)。
    pub fn device_admin_take(&mut self, account: &str, now: std::time::Instant) -> bool {
        self.admin_buckets
            .entry(account.to_owned())
            .or_insert_with(|| {
                TokenBucket::new(
                    DEVICE_ADMIN_BURST_ACCOUNT,
                    std::time::Duration::from_secs(DEVICE_ADMIN_REFILL_SECS),
                )
            })
            .take(now)
    }

    /// 回收满桶条目(hub 定期清扫调):满桶 = 没欠账,删掉与留着语义相同(下次重建
    /// 即满桶)。⇒ `admin_buckets` 的规模有**近期活跃账户数**上界。
    ///
    /// `now` 显式入参(与本文件其余单调钟同纪律):判「满不满」**必须先按时间补墨**,
    /// 否则用过的条目一个也回收不掉,见 [`TokenBucket::is_full_at`]。
    pub fn sweep_admin_buckets(&mut self, now: std::time::Instant) -> usize {
        let before = self.admin_buckets.len();
        self.admin_buckets.retain(|_, b| !b.is_full_at(now));
        before - self.admin_buckets.len()
    }

    /// 账户在 `now` 所在 UTC 月的**生效 fastlane 额度**(billing-plan §4 工序 3;169)。
    /// FastlaneExhausted 的唯一 quota 判据(数据热路径只读)。有序月份语义:
    /// * grant.period == 本月 → `grant.quota`(已含月中升级抬升、月初 floor)。
    /// * grant.period < 本月 / 缺省 → 按 `period_start` 时刻 effective 重建(**只读不落盘**;
    ///   sweeper [`Self::roll_grants_to_current_month`] 负责持久化滚月)。
    /// * grant.period > 本月(墙钟回拨)→ 保留 `grant.quota` 并告警,绝不重建旧月。
    pub fn effective_grant_quota(&self, account: &str, now: time::OffsetDateTime) -> u64 {
        let now_month = month_of(now);
        match self.grants.get(account) {
            Some(g) if g.period == now_month => g.quota,
            Some(g) if g.period > now_month => {
                crate::logln(format!(
                    "WARN grant 墙钟回拨:账户 {account} grant.period={:?} > 当前 {now_month:?},保留未来 grant 不重建",
                    g.period
                ));
                g.quota
            }
            _ => self
                .effective_entitlement(account, month_start_utc(now))
                .fastlane_bytes_per_month,
        }
    }

    /// sweeper 月初滚月(169,工序 3;codex B):把 grant.period < 本月(或缺省)的账户
    /// 向前重置为 `{本月, grant_floor(period_start)}`——**基值按 UTC 月初时刻算 effective**
    /// (不是 sweeper 执行的 now),故月初早于到期也能捕获到期前额度。批量改动**一次
    /// save**;落盘失败**回滚全部内存 grant**(保 registry「盘内一致」不变量)。墙钟回拨
    /// 的未来 grant 保留、不动。返回本轮滚了多少账户。
    pub fn roll_grants_to_current_month(&mut self, now: time::OffsetDateTime) -> io::Result<usize> {
        let now_month = month_of(now);
        let period_start = month_start_utc(now);
        let accounts: Vec<String> = self.accounts.keys().cloned().collect();
        let mut changed: Vec<(String, Option<Grant>)> = Vec::new();
        for acct in accounts {
            // 空墓碑账户不建 grant(无设备=无同步,授权无意义)。
            if self.accounts.get(&acct).is_none_or(|d| d.is_empty()) {
                continue;
            }
            let needs = match self.grants.get(&acct) {
                Some(g) => g.period < now_month, // 未来月(回拨)/本月:不动
                None => true,
            };
            if needs {
                let floor =
                    self.effective_entitlement(&acct, period_start).fastlane_bytes_per_month;
                let prev = self.grants.insert(acct.clone(), Grant { period: now_month, quota: floor });
                changed.push((acct, prev));
            }
        }
        if changed.is_empty() {
            return Ok(0);
        }
        let n = changed.len();
        match self.save() {
            Ok(()) => Ok(n),
            Err(e) => {
                for (acct, prev) in changed {
                    match prev {
                        Some(g) => {
                            self.grants.insert(acct, g);
                        }
                        None => {
                            self.grants.remove(&acct);
                        }
                    }
                }
                crate::logln(format!("ERROR grant 滚月落盘失败,已回滚 {n} 个内存 grant:{e}"));
                Err(e)
            }
        }
    }

    /// 账户目录总条数(含空墓碑;创号闸的分母,serve_inner 启动时用它核对超额)。
    pub fn account_count(&self) -> usize {
        self.accounts.len()
    }

    /// 显式设置过的授权记录(admin 查询用,与「默认免费档」可区分;None=从未设置)。
    pub fn configured_entitlement(&self, account: &str) -> Option<&Entitlement> {
        self.entitlements.get(account)
    }

    /// 首台注册(§4 TOFU;open-signup 起准入开放):未封禁 && 账户**从未初始化**
    /// (不在 registry,fresh 直接 TOFU 建档——账户 ULID 由客户端创号那刻自生成)
    /// && device_id 全局未见。调用方持锁,「检查 + 插入 + 落盘」原子;并发双首台恰一胜。
    /// **#1 硬化**:账户存在但空(被吊光归零的墓碑)= AccountSealed 硬拒,绝不与
    /// 「从未见过的新账户」混同——否则被吊设备能自助重 TOFU 满血回来。
    ///
    /// **幂等重试(P2-h H1)**:账户唯一设备恰是本次的 `(device, pubkey)` = 前次首台
    /// 注册已落盘、客户端在提升本地配置前崩溃、带同一份 pending 密钥重来。放行返回 Ok,
    /// 让客户端据此把 pending 密钥提升为正式配置(否则它永卡 NotFirst,而那台设备正是
    /// 它自己)。**不破恰一胜**:并发两台**不同**设备各自 `(device, pubkey)` 不同,绝不
    /// 同时命中此分支;同设备**异钥**(垃圾/攻击)= 落 NotFirst 不放行。
    ///
    /// **席位闸在此路空成立**(billing-plan §5 执行点覆盖 register_first 的落实说明):
    /// 首台注册插的恒是第 1 席,而 `Entitlement::validate` 钉死 seat_quota ≥ 1、硬帽
    /// 配置恒 ≥ 1——`1 ≤ min(quota, cap)` 恒真,不写永假的死检查。
    pub fn register_first(
        &mut self,
        account: &str,
        device: &str,
        pubkey: [u8; 32],
    ) -> Result<(), RegisterError> {
        if self.is_banned(account) {
            return Err(RegisterError::Banned);
        }
        // 三态区分(#1 硬化):真 fresh(不在 map)才走 TOFU;空墓碑(吊光归零)
        // 硬拒 AccountSealed;非空账户走既有 NotFirst→配对(幂等重试例外)。
        match self.accounts.get(account) {
            None => {}
            Some(devs) if devs.len() == 1 && devs.get(device) == Some(&pubkey) => {
                return Ok(()); // 前次成功后的同设备同钥重试:幂等放行。
            }
            Some(devs) if devs.is_empty() => return Err(RegisterError::AccountSealed),
            Some(_) => return Err(RegisterError::NotFirst),
        }
        if self.device_owner(device).is_some() {
            return Err(RegisterError::DeviceIdTaken);
        }
        // 创号闸(2026-07-31 评审):此下恒是「真要新建账户」路径(上面幂等/墓碑/
        // NotFirst 全部早返)。目录硬上界在前(到顶谁也不建、不花令牌),令牌桶在
        // 最后一步(桶花掉才插行;落盘失败不退令牌——磁盘故障期更该收紧)。
        if self.accounts.len() >= self.max_accounts {
            return Err(RegisterError::DirectoryFull);
        }
        if !self.signup_take(std::time::Instant::now()) {
            return Err(RegisterError::SignupThrottled);
        }
        // ⛔ **「谁自动成为管理设备」绑在「fresh 账户的首次插入」上,不是绑在
        // `register_first` 这个入口上**(identity-plan §5.6-2 三轮 M5,**这是一条真的
        // 提权路**):本函数对「账户唯一设备恰为同 device 同钥」是幂等 `Ok` **早返**的
        // (上面第二臂),若把建 admin 写在那条早返**之前**,存量单设备账户(admins
        // 无键)只要自己重放一枚 `RegisterFirst`,就能**绕过运营者手工回填直接拿到
        // 管理位**。走到这一行的只可能是真 fresh 账户,故此处是唯一正确的落点。
        self.accounts.entry(account.to_owned()).or_default().insert(device.to_owned(), pubkey);
        self.admins.insert(account.to_owned(), BTreeSet::from([device.to_owned()]));
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                crate::logln(format!("ERROR registry 落盘失败,已回滚 {account}/{device}:{e}"));
                // 四条持久写路径之一(§5.6-2)。fresh 建档失败要**连账户键一起删**,
                // 且 **admins 那条也必须删掉**——留下就是一个指向不存在账户的幽灵
                // 管理位,下次启动直接撞 load 的不变量拒启。
                if let Some(devs) = self.accounts.get_mut(account) {
                    devs.remove(device);
                    if devs.is_empty() {
                        self.accounts.remove(account);
                    }
                }
                self.admins.remove(account);
                Err(RegisterError::Persist)
            }
        }
    }

    /// 后续注册(§4:老设备背书,验签在调用方)。同账户同钥重放 = 幂等 Ok;
    /// device_id 已在任何别处(异账户,或同账户异钥)= 拒。**幂等判断恒在一切配额
    /// 判断之前**(epoch-plan §2.2 registry 实现注记):纪元切换预注册「Ack 后崩、
    /// 同 bundle 重试」发生在满额瞬间(+1 后恰满)时,幂等重放不得被配额误拒——
    /// 这也是「租约消费后 Registered 因 kick 未送达」重试重新取得的依据。
    ///
    /// **两层席位闸(billing-plan §5,工序 2;`now` 显式入参,与 entitlement 同纪律)**:
    /// 1. 硬帽层:`seat_count ≥ device_cap` → [`RegisterError::AccountFull`]——服务器
    ///    安全容量,租约也不能越(「绝不越硬帽」),故先判;
    /// 2. 商业层:`seat_count ≥ effective_entitlement.seat_quota + 租约匹配 ? 1 : 0`
    ///    → [`RegisterError::SeatLimit`]。租约精确匹配(目标 device+pubkey、未过期)
    ///    才 +1,且成功注册即**同一次 save 原子消费**(落盘失败连租约一起回滚)。
    pub fn register_device(
        &mut self,
        account: &str,
        new_device: &str,
        pubkey: [u8; 32],
        device_cap: usize,
        now: time::OffsetDateTime,
    ) -> Result<(), RegisterError> {
        if self.is_banned(account) {
            return Err(RegisterError::Banned);
        }
        match self.device_owner(new_device) {
            Some((acct, key)) if acct == account && *key == pubkey => return Ok(()),
            Some(_) => return Err(RegisterError::DeviceIdTaken),
            None => {}
        }
        let seat_count = self.accounts.get(account).map_or(0, |d| d.len());
        // 0. 协议硬帽层(实现审弹一 M2):**这一格是本层自己的不变量,不许只靠调用方**。
        //    `device_cap` 是**入参**——今天它恒来自启动已校验的 `Config`(`serve_inner`
        //    拒启 `device_cap > MAX_ROSTER_DEVICES`),故网络面到不了这里;但 `Registry`
        //    与本方法是 `pub`,一个传 33 的调用方就能让第 33 台**成功落盘**,而下次
        //    `load` 会因超编**拒启** ⇒ 「成功落盘的状态下次一定 load 得动」这条被证伪。
        //    ⚠ **这一层不「拒绝错配置」,别把它说大了**(实现审弹一 L1):`device_cap=33`
        //    而当前只有 3 台时,本函数照样放行 —— 它只保证**长不过 32**。真正拒绝
        //    `device_cap > MAX` 那个配置的是 `serve_inner` 的启动闸。
        //    两道闸分开写(而不是 `min()`)是为了**出处可查**:审计时一眼看得出哪一格
        //    来自协议硬帽、哪一格来自配置。⚠ 二者在「每次只加一台」下**行为等价**,故
        //    这个取舍是可读性取舍,没有、也不可能有一只行为测能把它俩分开。
        if seat_count >= sync_proto::MAX_ROSTER_DEVICES {
            return Err(RegisterError::AccountFull);
        }
        if seat_count >= device_cap {
            return Err(RegisterError::AccountFull);
        }
        // 租约匹配 = 同账户、同目标 (device, pubkey)、未过期(到点即失效,与
        // entitlement「恰在到期点=已过期」同口径)。
        let lease_match = self.seat_leases.get(account).is_some_and(|l| {
            l.new_device == new_device && l.new_pubkey == pubkey && l.expires_at > now
        });
        let quota = self.effective_entitlement(account, now).seat_quota as usize;
        if seat_count >= quota + usize::from(lease_match) {
            return Err(RegisterError::SeatLimit);
        }
        // registry 层硬不变量(#1 硬化,不倚赖唯一调用方 hub::register_endorsed 的
        // sponsor 租约永不变):device_id 未占用时,只能往**已初始化且非空**的账户
        // 背书插设备。空墓碑(吊光归零)/ 从未初始化都拒——否则会把墓碑重新插活,
        // 且 persist_or_rollback 失败回滚会把空墓碑误删回 fresh。正常背书路径必有
        // 在线 sponsor → 账户必非空,不误伤。
        match self.accounts.get(account) {
            Some(devs) if !devs.is_empty() => {}
            Some(_) => return Err(RegisterError::AccountSealed),
            None => return Err(RegisterError::AccountNotInitialized),
        }
        // 消费=插入+删租约+落盘同生共死:目标已注册成功,租约使命完成即删
        // (无论这次是否靠它 +1——留着只是过期垃圾);落盘失败连租约一起还原。
        let consumed = if lease_match { self.seat_leases.remove(account) } else { None };
        self.accounts.entry(account.to_owned()).or_default().insert(new_device.to_owned(), pubkey);
        // 四条持久写路径之二(§5.6-2)。⚠ **admins 在这条路上不涉及**——背书进来的新
        // 设备默认不是管理设备,故没有管理位要建、也没有要回滚的。**这句是「想过了,
        // 不涉及」,不是漏了。**
        //
        // ⛔ 保存/回滚**内联在此**、不再走通用 helper(设计审二轮裁决):原先
        // `persist_or_rollback` 被本函数与 `register_first` 共用,而两者的回滚义务并不
        // 相同(那边要连账户键与 admins 一起删)。共用面一存在,下一个人就得靠读注释
        // 才知道「这次调用该不该带 admins」——**把共用面去掉比给它造一个类型更便宜**。
        // 这里删完必不空(进门前已断言账户非空),故没有「删到空要不要摘账户键」那一格。
        let out = match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                crate::logln(format!(
                    "ERROR registry 落盘失败,已回滚 {account}/{new_device}:{e}"
                ));
                if let Some(devs) = self.accounts.get_mut(account) {
                    devs.remove(new_device);
                }
                Err(RegisterError::Persist)
            }
        };
        if out.is_err() {
            if let Some(l) = consumed {
                self.seat_leases.insert(account.to_owned(), l);
            }
        }
        out
    }

    /// 求纪元席位租约(billing-plan §5,工序 2;唯一开租入口,调用方=hub 在
    /// registry 锁内)。已鉴权 sponsor 为**具体目标** (new_device, new_pubkey) 求租;
    /// 每账户同时最多一枚——新求租**烧旧开新**(同目标重放=刷新 TTL,幂等无害)。
    ///
    /// 判定次序(与 register_device 同哲学):
    /// 1. 封禁 → Banned(对外并进 auth_failed);
    /// 2. 目标已是本账户同钥设备 → **Ok 不开租**(消费后崩溃重试路:注册会走幂等
    ///    分支,不需要租约);
    /// 3. 目标 device_id 被别处占用 → DeviceIdTaken(租了也注册不上,早拒);
    /// 4. `seat_count ≥ device_cap` → AccountFull(租约绝不越硬帽,求租即拒)。
    /// 商业 quota **刻意不在此判**——租约的存在意义就是允许超 quota 一次。
    pub fn grant_seat_lease(
        &mut self,
        account: &str,
        sponsor: &str,
        new_device: &str,
        new_pubkey: [u8; 32],
        device_cap: usize,
        now: time::OffsetDateTime,
        ttl: std::time::Duration,
    ) -> Result<(), SeatLeaseError> {
        if self.is_banned(account) {
            return Err(SeatLeaseError::Banned);
        }
        match self.device_owner(new_device) {
            Some((acct, key)) if acct == account && *key == new_pubkey => {
                // 目标已在编(消费后崩溃重试路):注册会走幂等分支,不需要租约。
                // 「每账户最多一枚 + 新求租烧旧」对此分支同样成立(codex 160 M1):
                // 不烧的话,先前另一目标的旧租约在 TTL 内仍是可被消费的悬空 +1。
                self.seat_leases.remove(account);
                return Ok(());
            }
            Some(_) => return Err(SeatLeaseError::DeviceIdTaken),
            None => {}
        }
        let seat_count = self.accounts.get(account).map_or(0, |d| d.len());
        // 协议硬帽同 [`Self::register_device`] 那一格(实现审弹一 M2):**早拒**,
        // 别发一枚注定消费不掉的租约(register_device 那道闸会拦下它)。
        if seat_count >= sync_proto::MAX_ROSTER_DEVICES {
            return Err(SeatLeaseError::AccountFull);
        }
        if seat_count >= device_cap {
            return Err(SeatLeaseError::AccountFull);
        }
        self.seat_leases.insert(
            account.to_owned(),
            SeatLease {
                sponsor: sponsor.to_owned(),
                new_device: new_device.to_owned(),
                new_pubkey,
                expires_at: now + ttl,
            },
        );
        Ok(())
    }

    /// 清过期席位租约(hub 定期清扫调;消费与匹配处已按 `expires_at > now` 惰性
    /// 判死,这里只是回收内存)。返回清掉的数量(日志用)。
    pub fn sweep_seat_leases(&mut self, now: time::OffsetDateTime) -> usize {
        let before = self.seat_leases.len();
        self.seat_leases.retain(|_, l| l.expires_at > now);
        before - self.seat_leases.len()
    }

    /// 单设备吊销(android-plan §8 H1):删该设备公钥绑定并落盘,此后该设备重连
    /// 鉴权即拒(pubkey_of 落空)。幸存设备不牵连、封禁表不动、k_acc 不换。
    /// **#1 硬化**:吊的是账户唯一设备时,账户条目**留作空墓碑**(不再 remove)——
    /// 封禁与否无关,也不允许同 device_id 自助重 TOFU(register_first 见空墓碑即
    /// AccountSealed),封杀自足;重新启用需运营者显式重开。返回 RevokeOutcome 告知
    /// 是否吊成了空墓碑,admin 据此如实回执。落盘失败 = 回滚内存删除并报错(内存态
    /// 与盘上恒一致,吊销未生效绝不装成功)。
    pub fn revoke_device(
        &mut self,
        account: &str,
        device: &str,
    ) -> Result<RevokeOutcome, RevokeError> {
        let Some(devs) = self.accounts.get_mut(account) else {
            return Err(RevokeError::NotFound);
        };
        let Some(key) = devs.remove(device) else {
            return Err(RevokeError::NotFound);
        };
        // 空则留作墓碑(#1:不 remove 账户条目),据此回执 AccountSealed。
        let sealed = devs.is_empty();
        // 367:管理位跟着设备走。**含 admin 面这条路**——不摘就会留下一个指向不存在
        // 设备的幽灵管理位,下次启动直接撞 load 的不变量拒启。摘到空即删键(空集合的
        // 唯一规范表示)。⚠ 本层**不检查「会不会把 admins 摘空」**:运营者面刻意保留
        // 这个能力(逃生口),不变量只约束用户面(见 [`Registry::admins`] 头注)。
        let was_admin = self.admins.get_mut(account).is_some_and(|set| set.remove(device));
        if self.admins.get(account).is_some_and(|s| s.is_empty()) {
            self.admins.remove(account);
        }
        match self.save() {
            Ok(()) => Ok(if sealed {
                RevokeOutcome::AccountSealed
            } else {
                RevokeOutcome::DeviceRevoked
            }),
            Err(e) => {
                crate::logln(format!(
                    "ERROR registry 落盘失败,已回滚吊销 {account}/{device}:{e}"
                ));
                // 四条持久写路径之三:**净变化必须为零**,管理位也得原样还回去。
                self.accounts
                    .entry(account.to_owned())
                    .or_default()
                    .insert(device.to_owned(), key);
                if was_admin {
                    self.admins.entry(account.to_owned()).or_default().insert(device.to_owned());
                }
                Err(RevokeError::Persist)
            }
        }
    }

    /// 设 / 取消管理设备(identity-plan §5.3;367)。**唯一的管理位写入口**——用户面
    /// (hub `device_admin`)与运营者面(`/admin/set-admin`)都走它。
    ///
    /// 幂等:已是 / 已不是即 `Ok(false)`(**没变化**),调用方据此**不 save、不升
    /// revision、不 fan-out**(§5.13 M1:管理设备可以无限交替 Grant/Revoke,每次都触发
    /// 全量落盘 + 全账户 fan-out;幂等无变化不做事就砍掉了那条路)。真变了回 `Ok(true)`。
    ///
    /// ⛔ **本层不守「admins 不得变空」**:那条不变量只约束用户面,运营者面要能把最后
    /// 一台管理设备清掉(逃生口的另一半,见 [`Registry::admins`] 头注)。
    ///
    /// 四条持久写路径之四(§5.6-2:**我原设计整个漏了它的回滚**)。落盘失败回滚到
    /// **精确旧状态**——`on=true` 撤销刚插的、`on=false` 恢复刚删的,两条臂都要真跑。
    pub fn set_admin(
        &mut self,
        account: &str,
        device: &str,
        on: bool,
    ) -> Result<bool, RegisterError> {
        // 形态前置:只对在册设备设管理位(否则就是造幽灵管理位,load 会拒启)。
        if !self.accounts.get(account).is_some_and(|d| d.contains_key(device)) {
            return Err(RegisterError::AccountNotInitialized);
        }
        let had = self.admins.get(account).is_some_and(|s| s.contains(device));
        if had == on {
            return Ok(false); // 幂等:不动内存、不落盘。
        }
        if on {
            self.admins.entry(account.to_owned()).or_default().insert(device.to_owned());
        } else {
            if let Some(set) = self.admins.get_mut(account) {
                set.remove(device);
            }
            // 摘掉最后一位即删键——空集合的唯一规范表示是「没有该键」。
            if self.admins.get(account).is_some_and(|s| s.is_empty()) {
                self.admins.remove(account);
            }
        }
        match self.save() {
            Ok(()) => Ok(true),
            Err(e) => {
                crate::logln(format!(
                    "ERROR registry 落盘失败,已回滚管理位 {account}/{device} on={on}:{e}"
                ));
                if on {
                    // 撤销刚插的(它此前一定不在,故连带把可能新建的空集合删掉)。
                    if let Some(set) = self.admins.get_mut(account) {
                        set.remove(device);
                    }
                    if self.admins.get(account).is_some_and(|s| s.is_empty()) {
                        self.admins.remove(account);
                    }
                } else {
                    // 恢复刚删的(可能连键一起删掉了,or_default 重建)。
                    self.admins.entry(account.to_owned()).or_default().insert(device.to_owned());
                }
                Err(RegisterError::Persist)
            }
        }
    }

    /// 这台设备是不是本账户的管理设备(用户面授权判据的一半,§5.3)。
    pub fn is_admin(&self, account: &str, device: &str) -> bool {
        self.admins.get(account).is_some_and(|s| s.contains(device))
    }

    /// 本账户的管理设备台数(用户面不变量「不得让 admins 变空」的判据)。
    pub fn admin_count(&self, account: &str) -> usize {
        self.admins.get(account).map_or(0, |s| s.len())
    }

    /// 本账户有没有管理设备。`false` = 存量未回填 ⇒ 用户面 `DeviceAdmin` **整条不可用**
    /// (fail-closed;⚠ 含自助退出——不变量只说「不得**变**空」,对**已经**是空的账户
    /// 约束为零,放行自助退出会让存量账户被逐台退到空、直接撞出账户封存)。
    pub fn has_admins(&self, account: &str) -> bool {
        self.admins.contains_key(account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 工序4(实现审 M2):period_representable 守极端年份;representable 的构造不 panic。
    #[test]
    fn period_representable_guards_extreme_years() {
        assert!(period_representable((2026, 7)));
        assert!(period_representable((2026, 12)), "12 月→次年 1 月应可表示");
        assert!(!period_representable((2026, 13)), "坏月拒");
        assert!(!period_representable((i32::MAX, 1)), "极端年份 start 不可表示");
        assert!(!period_representable((i32::MAX, 12)), "极端年份 +1 溢出(checked_add None)");
        // representable 的 period 构造不 panic(period_end_utc 走 next_period 的 checked_add)。
        let _ = period_start_utc((2026, 12));
        assert_eq!(
            period_end_utc((2026, 12)),
            period_start_utc((2027, 1)),
            "2026-12 的 period_end = 2027-01 月初"
        );
    }

    /// 封禁夹具账号(合法 26 位 ULID 形态——parse_banlist 逐行严格校验)。
    const BANNED_A: &str = "01BANNEDBANNEDBANNEDBANNED";
    const BANNED_B: &str = "02BANNEDBANNEDBANNEDBANNED";

    fn fresh(dir: &Path) -> Registry {
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 封禁表(open-signup:准入开放,此处只放要拒的账户)\n").unwrap();
        Registry::load(&bl, dir.join("registry.json")).unwrap()
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = crate::test_temp::dir().join(format!("zhujian-syncd-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 测试基准「现在」(now 显式入参,测试不读墙钟保确定性)。
    fn t0() -> time::OffsetDateTime {
        t("2026-07-19T00:00:00Z")
    }

    /// 租约测试 TTL(值本身不进断言,只要「t0 + TTL 未过、TTL 后已过」可控)。
    const LEASE_TTL: std::time::Duration = std::time::Duration::from_secs(2 * 3600);

    #[test]
    fn open_admission_and_tofu() {
        let dir = tmpdir("tofu");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, format!("# 封禁\n{BANNED_A}\n")).unwrap();
        let mut r = Registry::load(&bl, dir.join("registry.json")).unwrap();
        // 封禁账户拒;从未见过的账户(open-signup)直接 TOFU 放行。
        assert_eq!(r.register_first(BANNED_A, "D1", [1; 32]), Err(RegisterError::Banned));
        // 封禁对背书注册同样生效(判定先于一切)。
        assert_eq!(r.register_device(BANNED_A, "DX", [5; 32], 8, t0()), Err(RegisterError::Banned));
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Ok(()));
        // 同设备同钥重放 = 幂等 Ok(H1 客户端崩溃重试的落地面)。
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Ok(()));
        // 同设备异钥(垃圾/抢注)= 拒,不放行。
        assert_eq!(r.register_first("ACCT_A", "D1", [9; 32]), Err(RegisterError::NotFirst));
        // 账户已有首台、换设备号 = 拒(并发败者/第二台都走配对)。
        assert_eq!(r.register_first("ACCT_A", "D2", [2; 32]), Err(RegisterError::NotFirst));
        // device_id 全局唯一:另一账户抢 D1(公钥不同或相同都拒——设备恒属一账户)。
        assert_eq!(r.register_first("ACCT_B", "D1", [9; 32]), Err(RegisterError::DeviceIdTaken));
        assert_eq!(r.register_first("ACCT_B", "D1", [1; 32]), Err(RegisterError::DeviceIdTaken));
    }

    /// 创号闸(2026-07-31 评审):令牌桶只对「真要新建账户」花令牌。证法(codex
    /// M5:桶已空时的幂等放行证不了「不花」):burst=2,创 A 花第 1 枚,然后幂等
    /// 重试 ×2、NotFirst ×2——若它们花令牌,B 就建不成;B 建成 = 第 2 枚还在。
    #[test]
    fn register_first_signup_gates() {
        let dir = tmpdir("signup-gates");
        let mut r = fresh(&dir);
        r.set_signup_limits(2, std::time::Duration::from_secs(3600), 10);
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Ok(()));
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Ok(()));
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Ok(()));
        assert_eq!(r.register_first("ACCT_A", "D2", [2; 32]), Err(RegisterError::NotFirst));
        assert_eq!(r.register_first("ACCT_A", "D2", [2; 32]), Err(RegisterError::NotFirst));
        assert_eq!(r.register_first("ACCT_B", "D2", [2; 32]), Ok(()));
        // 两枚都花在真创号上,第三个新账户才被限流。
        assert_eq!(r.register_first("ACCT_C", "D3", [3; 32]), Err(RegisterError::SignupThrottled));
    }

    /// 目录硬上界在令牌判定**之前**且不烧令牌(codex M5):max=1、burst=2——B 撞
    /// 上界时桶里明明还有令牌,仍报 DirectoryFull 而非 Throttled;白盒复核那枚令牌
    /// 原封未动。存量账户的背书注册不受创号闸影响。
    #[test]
    fn register_first_directory_cap_before_bucket_and_keeps_token() {
        let dir = tmpdir("signup-cap");
        let mut r = fresh(&dir);
        r.set_signup_limits(2, std::time::Duration::from_secs(3600), 1);
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Ok(()));
        assert_eq!(r.register_first("ACCT_B", "D2", [2; 32]), Err(RegisterError::DirectoryFull));
        assert_eq!(r.register_first("ACCT_B", "D2", [2; 32]), Err(RegisterError::DirectoryFull));
        let now = std::time::Instant::now();
        assert!(r.signup_take(now), "DirectoryFull 不该烧令牌");
        assert!(!r.signup_take(now), "只该剩那一枚(A 花掉的没复活)");
        assert_eq!(r.register_device("ACCT_A", "D4", [4; 32], 8, t0()), Ok(()));
    }

    /// 亚毫秒 refill 的纳秒口径(codex M4/二轮 L1):500µs 一枚——毫秒 floor 实现
    /// (除数 .max(1ms))会把 1ms 只算 1 枚补墨,本测在 t0+1ms 连取两枚,退回毫秒
    /// 实现即红。
    #[test]
    fn signup_bucket_submillisecond_refill() {
        let dir = tmpdir("signup-subms");
        let mut r = fresh(&dir);
        let step = std::time::Duration::from_micros(500);
        r.set_signup_limits(2, step, 100);
        let t0 = std::time::Instant::now();
        assert!(r.signup_take(t0));
        assert!(r.signup_take(t0));
        assert!(!r.signup_take(t0 + std::time::Duration::from_micros(499)));
        // 1ms = 两个 500µs 间隔:补满 2 枚。
        assert!(r.signup_take(t0 + std::time::Duration::from_millis(1)));
        assert!(r.signup_take(t0 + std::time::Duration::from_millis(1)));
        assert!(!r.signup_take(t0 + std::time::Duration::from_millis(1)));
    }

    /// 令牌桶补墨口径:每 refill 间隔一枚、补满以 now 重起算、满桶不攒历史时长。
    #[test]
    fn signup_bucket_refill_semantics() {
        let dir = tmpdir("signup-bucket");
        let mut r = fresh(&dir);
        let step = std::time::Duration::from_secs(60);
        r.set_signup_limits(2, step, 100);
        let t0 = std::time::Instant::now();
        // 满桶(2 枚)期间基点随取推进:连取两枚成功、第三枚失败。
        assert!(r.signup_take(t0));
        assert!(r.signup_take(t0));
        assert!(!r.signup_take(t0));
        // 不满一个间隔:仍空。
        assert!(!r.signup_take(t0 + step / 2));
        // 过一个间隔补一枚,取走后又空。
        assert!(r.signup_take(t0 + step));
        assert!(!r.signup_take(t0 + step));
        // 一次过两个间隔补满(封顶 burst=2),第三枚仍无——满桶不攒历史。
        let t1 = t0 + step * 10;
        assert!(r.signup_take(t1));
        assert!(r.signup_take(t1));
        assert!(!r.signup_take(t1));
    }

    /// 设备管理令牌条目**真的回收得掉**(实现审弹二 L1)。
    ///
    /// 原先 `is_full` 不补墨就判,而任何一次 `take` 都把桶打到 `burst - 1` 并**永远停
    /// 在那里**(下次 take 补满、随即又消费回去)⇒ 凡是用过的条目 sweep 一个都回收不
    /// 了,「那张表的规模有账户数上界」全靠一句没人兑现的话撑着。
    ///
    /// 三格一红一绿:欠着账时**不许**收 / 补墨补满之后**必须**收 / 没用过的条目本来
    /// 就不该在表里。
    #[test]
    fn admin_bucket_sweep_reclaims_after_refill() {
        let dir = tmpdir("admin-bucket-sweep");
        let mut r = fresh(&dir);
        let t0 = std::time::Instant::now();
        let step = std::time::Duration::from_secs(DEVICE_ADMIN_REFILL_SECS);
        assert_eq!(r.sweep_admin_buckets(t0), 0, "还没人用过,表是空的");
        assert!(r.device_admin_take("ACCT_A", t0));
        assert_eq!(r.admin_buckets.len(), 1);
        // 欠着一枚 ⇒ 不许回收(回收=遗忘欠账,等于白送一次 burst)。
        assert_eq!(r.sweep_admin_buckets(t0), 0, "欠着账的条目不许收");
        assert_eq!(r.admin_buckets.len(), 1);
        // 差一点点还不满(补墨要**整**个间隔)。
        assert_eq!(r.sweep_admin_buckets(t0 + step / 2), 0);
        // 一个整间隔之后补满 ⇒ 收得掉。
        assert_eq!(r.sweep_admin_buckets(t0 + step), 1, "补满了就该收");
        assert!(r.admin_buckets.is_empty());
    }

    #[test]
    fn register_device_idempotent_and_guard() {
        let dir = tmpdir("regdev");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        assert_eq!(r.register_device("ACCT_A", "D2", [2; 32], 8, t0()), Ok(()));
        // 同账户同钥重放 = 幂等。
        assert_eq!(r.register_device("ACCT_A", "D2", [2; 32], 8, t0()), Ok(()));
        // 同账户异钥 = 身份被复用,拒。
        assert_eq!(r.register_device("ACCT_A", "D2", [3; 32], 8, t0()), Err(RegisterError::DeviceIdTaken));
        // 异账户 = 拒(无论公钥)。
        assert_eq!(r.register_device("ACCT_B", "D2", [2; 32], 8, t0()), Err(RegisterError::DeviceIdTaken));
        assert_eq!(r.devices_of("ACCT_A"), vec!["D1".to_string(), "D2".to_string()]);
    }

    /// 设备配额(epoch-plan §5.2 #2)+ **幂等先于配额**回归锚(§2.2 registry 注记):
    /// 纪元切换预注册把账户推到恰满(+1)后「Ack 后崩、同 bundle 重试」——同账户
    /// 同钥重放必须放行,配额若先判就把崩溃恢复堵死。新设备满额拒 = AccountFull。
    #[test]
    fn device_cap_rejects_new_but_idempotent_replay_passes_at_cap() {
        let dir = tmpdir("cap");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        assert_eq!(r.register_device("ACCT_A", "D2", [2; 32], 2, t0()), Ok(()));
        // 恰满(2/2):新设备拒。
        assert_eq!(r.register_device("ACCT_A", "D3", [3; 32], 2, t0()), Err(RegisterError::AccountFull));
        // 满额下的幂等重放(同账户同钥)必须放行——判定次序的回归锚。
        assert_eq!(r.register_device("ACCT_A", "D2", [2; 32], 2, t0()), Ok(()));
        // 满额下同 device_id 异钥仍是 DeviceIdTaken(不许配额错误掩盖身份错误)。
        assert_eq!(r.register_device("ACCT_A", "D2", [9; 32], 2, t0()), Err(RegisterError::DeviceIdTaken));
        // 吊一台腾位后新设备可入(纪元切换 runbook §8 工序 2 的「满则先吊一台」)。
        assert_eq!(r.revoke_device("ACCT_A", "D2"), Ok(RevokeOutcome::DeviceRevoked));
        assert_eq!(r.register_device("ACCT_A", "D3", [3; 32], 2, t0()), Ok(()));
    }

    /// 落盘失败 = 回滚内存插入(codex P2-e M4:不留「内存有、盘上无」分叉)。
    #[test]
    fn persist_failure_rolls_back() {
        let dir = tmpdir("rollback");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空封禁表\n").unwrap();
        // registry 指向不存在的子目录:save 的 tmp 写必败。
        let mut r = Registry::load(&bl, dir.join("no-such-dir").join("registry.json")).unwrap();
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Err(RegisterError::Persist));
        assert_eq!(r.pubkey_of("ACCT_A", "D1"), None);
        assert!(r.devices_of("ACCT_A").is_empty());
        // 回滚后账户仍是「零设备」:换个能落盘的路径依旧能当首台(状态没被污染)。
        assert_eq!(r.register_first("ACCT_A", "D2", [2; 32]), Err(RegisterError::Persist));
        assert_eq!(r.pubkey_of("ACCT_A", "D2"), None);
    }

    #[test]
    fn persist_roundtrip() {
        let dir = tmpdir("persist");
        {
            let mut r = fresh(&dir);
            r.register_first("ACCT_A", "D1", [7; 32]).unwrap();
            r.register_device("ACCT_A", "D2", [8; 32], 8, t0()).unwrap();
        }
        // 重新 load:注册结果都在(封禁表文件同一份)。
        let r2 = fresh(&dir);
        assert_eq!(r2.pubkey_of("ACCT_A", "D1"), Some([7; 32]));
        assert_eq!(r2.pubkey_of("ACCT_A", "D2"), Some([8; 32]));
        assert_eq!(r2.pubkey_of("ACCT_A", "D3"), None);
    }

    /// H1 单设备吊销 + #1 硬化:删绑定并落盘;幸存设备不动;device_id 释放可被幸存
    /// 设备背书重配;**吊光最后一台 → 账户留作空墓碑(AccountSealed),同 device_id
    /// 不得自助重 TOFU**。
    #[test]
    fn revoke_device_semantics() {
        let dir = tmpdir("revoke");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        // 不存在的账户/设备 = NotFound(先查再吊)。
        assert_eq!(r.revoke_device("ACCT_B", "D1"), Err(RevokeError::NotFound));
        assert_eq!(r.revoke_device("ACCT_A", "DX"), Err(RevokeError::NotFound));
        // 吊 D2:账户仍有 D1 幸存 → DeviceRevoked;D2 鉴权面即失。
        assert_eq!(r.revoke_device("ACCT_A", "D2"), Ok(RevokeOutcome::DeviceRevoked));
        assert_eq!(r.pubkey_of("ACCT_A", "D2"), None);
        assert_eq!(r.pubkey_of("ACCT_A", "D1"), Some([1; 32]));
        // 落盘持久:重 load 后吊销结果仍在。
        let r2 = fresh(&dir);
        assert_eq!(r2.pubkey_of("ACCT_A", "D2"), None);
        assert_eq!(r2.pubkey_of("ACCT_A", "D1"), Some([1; 32]));
        // 重复吊 = NotFound(幂等由调用方看错误码,不装成功)。
        assert_eq!(r.revoke_device("ACCT_A", "D2"), Err(RevokeError::NotFound));
        // 吊销后 device_id 释放:幸存设备(账户非空)背书可重注册(合法重配路径)。
        assert_eq!(r.register_device("ACCT_A", "D2", [9; 32], 8, t0()), Ok(()));
        // 吊光账户全部设备 → 最后一台吊出 AccountSealed,账户留作空墓碑。
        assert_eq!(r.revoke_device("ACCT_A", "D2"), Ok(RevokeOutcome::DeviceRevoked));
        assert_eq!(r.revoke_device("ACCT_A", "D1"), Ok(RevokeOutcome::AccountSealed));
        assert!(r.devices_of("ACCT_A").is_empty());
        // #1 硬化:空墓碑不许同 device_id / 任何设备自助重 TOFU(旧行为 Ok = 红线洞)。
        assert_eq!(r.register_first("ACCT_A", "D3", [3; 32]), Err(RegisterError::AccountSealed));
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Err(RegisterError::AccountSealed));
    }

    /// #1 硬化:空墓碑经落盘 + 重 load 仍封存,register_first 与 register_device 双拒;
    /// 从未初始化账户的 register_device = AccountNotInitialized、但仍可当首台 TOFU。
    #[test]
    fn sealed_account_blocks_reregister_across_reload() {
        let dir = tmpdir("sealed");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        assert_eq!(r.revoke_device("ACCT_A", "D1"), Ok(RevokeOutcome::AccountSealed));
        // 空墓碑:两条注册路都拒。
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Err(RegisterError::AccountSealed));
        assert_eq!(r.register_device("ACCT_A", "D2", [2; 32], 8, t0()), Err(RegisterError::AccountSealed));
        // 落盘 + 重 load 后墓碑仍在(空账户条目 `{}` 往返)。
        let mut r2 = fresh(&dir);
        assert_eq!(r2.register_first("ACCT_A", "D1", [1; 32]), Err(RegisterError::AccountSealed));
        assert!(r2.devices_of("ACCT_A").is_empty());
        // 从未初始化的账户:register_device = AccountNotInitialized(防御性);
        // 但它是真 fresh,仍可正常当首台 TOFU。
        assert_eq!(
            r2.register_device("ACCT_B", "DX", [3; 32], 8, t0()),
            Err(RegisterError::AccountNotInitialized)
        );
        assert_eq!(r2.register_first("ACCT_B", "DX", [3; 32]), Ok(()));
    }

    /// 吊销落盘失败 = 回滚(绑定仍在,吊销未生效不装成功)。
    // ---- 367:管理设备(admins)---------------------------------------------

    /// 手工写一份 registry.json 再 load —— 用来造「存量文件」与「损坏文件」,
    /// 那两类状态**造不出来**(正常写路径恒守不变量),只能从盘上来。
    fn load_with_registry(dir: &Path, json: &str) -> io::Result<Registry> {
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空封禁表\n").unwrap();
        let path = dir.join("registry.json");
        fs::write(&path, json).unwrap();
        Registry::load(&bl, path)
    }

    fn key_hex(b: u8) -> String {
        format!("{b:02x}").repeat(32)
    }

    /// ⛔ **一条真的提权路**(设计审三轮 M5):`register_first` 对「账户唯一设备恰为
    /// 同 device 同钥」是**幂等早返**的。若把「自动设 admin」写在那条早返之前,存量
    /// 单设备账户(admins 无键)只要自己重放一枚 `RegisterFirst`,就能绕过运营者的
    /// 手工回填直接拿到管理位。
    ///
    /// 一红一绿对照:fresh 账户**必须**拿到管理位(否则这测退化成「什么都不做也绿」)。
    #[test]
    fn admins_only_born_from_a_fresh_account_insert() {
        let dir = tmpdir("admins-fresh-only");
        // 绿:真 fresh 账户 → 首台即管理设备。
        let mut r = fresh(&dir);
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Ok(()));
        assert!(r.is_admin("ACCT_A", "D1"));
        assert!(r.has_admins("ACCT_A"));
        // 背书进来的第二台**不是**管理设备(默认不给)。
        assert_eq!(r.register_device("ACCT_A", "D2", [2; 32], 8, t0()), Ok(()));
        assert!(!r.is_admin("ACCT_A", "D2"));

        // 红:存量账户(有设备、admins 无键)重放同钥 RegisterFirst → 幂等 Ok,
        // 但**管理位一格都不许长出来**。
        let dir2 = tmpdir("admins-legacy-replay");
        let mut old = load_with_registry(
            &dir2,
            &format!(r#"{{"accounts":{{"ACCT_A":{{"D1":"{}"}}}}}}"#, key_hex(1)),
        )
        .unwrap();
        assert!(!old.has_admins("ACCT_A"), "存量文件本来就没有管理设备");
        assert_eq!(old.register_first("ACCT_A", "D1", [1; 32]), Ok(()), "同钥重放仍是幂等 Ok");
        assert!(!old.has_admins("ACCT_A"), "幂等重放绝不许补出管理位(提权路)");
        assert!(!old.is_admin("ACCT_A", "D1"));
    }

    /// load 的三条 admins 不变量 + 空集合唯一规范表示,逐条各一只(§5.6-2 二轮 M3)。
    /// 全部**响亮拒启**,不静默丢弃、不静默规范化——与 entitlement / grant 同一把尺。
    #[test]
    fn load_rejects_broken_admins() {
        let acct = format!(r#""accounts":{{"ACCT_A":{{"D1":"{}"}}}}"#, key_hex(1));
        for (i, (name, json)) in [
            // ① 显式空集合 = 非规范表示(规范表示是「没有该键」)。
            ("显式空集合", format!(r#"{{{acct},"admins":{{"ACCT_A":[]}}}}"#)),
            // ② 指向不存在的账户(register_first 落盘失败没删干净就会长这样)。
            ("幽灵账户", format!(r#"{{{acct},"admins":{{"ACCT_B":["D1"]}}}}"#)),
            // ③ 指向不在该账户设备表里的设备(revoke 没同步摘 admins 就会长这样)。
            ("幽灵管理位", format!(r#"{{{acct},"admins":{{"ACCT_A":["DX"]}}}}"#)),
        ]
        .into_iter()
        .enumerate()
        {
            // ⚠ 目录名按**序号**取,别按 name 派生:`"显式空集合"` 与 `"幽灵管理位"`
            // 都是 15 字节,按长度取会让两格共用一个目录。
            let dir = tmpdir(&format!("admins-bad-{i}"));
            let Err(err) = load_with_registry(&dir, &json) else {
                panic!("{name}:这份文件必须拒启");
            };
            assert_eq!(err.kind(), io::ErrorKind::InvalidData, "{name}");
        }
        // 阴性对照:同一份文件写成规范形就该正常加载(证明上面三条红不是被别的东西拒的)。
        let dir = tmpdir("admins-good");
        let r = load_with_registry(&dir, &format!(r#"{{{acct},"admins":{{"ACCT_A":["D1"]}}}}"#))
            .expect("规范形必须加载得了");
        assert!(r.is_admin("ACCT_A", "D1"));
    }

    /// 存量账户超 `MAX_ROSTER_DEVICES` 即**拒启**(设计审一轮 H6):`device_cap` 只在
    /// 注册那刻判、load 从不校验存量,而硬帽可调低 ⇒ 超编账户是能存在的。
    /// **不静默截断**——截断会藏掉设备,比帧过大危险得多。
    #[test]
    fn load_rejects_account_over_roster_capacity() {
        let cap = sync_proto::MAX_ROSTER_DEVICES;
        let devs = |n: usize| {
            (0..n).map(|i| format!(r#""D{i}":"{}""#, key_hex(0))).collect::<Vec<_>>().join(",")
        };
        // 恰好到顶:放行(边界的另一半——否则「拒启」可能只是因为别的原因)。
        let dir = tmpdir("roster-cap-ok");
        let ok = load_with_registry(&dir, &format!(r#"{{"accounts":{{"A":{{{}}}}}}}"#, devs(cap)));
        assert!(ok.is_ok(), "恰好 {cap} 台必须过");
        // 超一台:拒启。
        let dir = tmpdir("roster-cap-over");
        let Err(err) =
            load_with_registry(&dir, &format!(r#"{{"accounts":{{"A":{{{}}}}}}}"#, devs(cap + 1)))
        else {
            panic!("超编必须拒启");
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("MAX_ROSTER_DEVICES"), "错误要点名那道闸:{err}");
    }

    /// **成功落盘的状态,下次一定 load 得动**(实现审弹一 M2)。
    ///
    /// 反例长这样:`register_device` 的容量闸此前**只信入参 `device_cap`**,而
    /// `MAX_ROSTER_DEVICES` 只由 `serve_inner` 在启动时校配置。传一个 33 进来,第 33 台
    /// 就会**成功写盘**,而下次 `load` 因超编**拒启** —— 一次成功的写把服务器锁在门外。
    ///
    /// ⚠ 判据挑的是**「写完还起得来」**,不是「第 33 台被拒」:后者只证明有一道闸,
    /// 前者才是这道闸存在的**理由**。故这只测最后真的去 `load` 一次落盘结果。
    #[test]
    fn no_successful_write_can_leave_a_registry_that_refuses_to_load() {
        let cap = sync_proto::MAX_ROSTER_DEVICES;
        let dir = tmpdir("write-gate-roster-cap");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空封禁表\n").unwrap();
        let path = dir.join("registry.json");
        let mut r = Registry::load(&bl, path.clone()).unwrap();
        r.register_first("ACCT_A", "D0", [0; 32]).unwrap();
        // 商业层那道闸不是本测的被测对象,先把它抬开 —— 否则拒第 33 台的会是 seat_quota,
        // 这只测就变成「另一道闸背书成绿」(first-draft-checklist 第 13 条)。
        r.set_entitlement(
            "ACCT_A",
            Entitlement {
                tier: "test".into(),
                expires_at: None,
                seat_quota: cap as u32 + 8,
                fastlane_bytes_per_month: FREE_FASTLANE_BYTES_PER_MONTH,
            },
            t0(),
        )
        .unwrap();
        // 调用方传一个**越过协议硬帽**的 device_cap(今天 serve_inner 拒启这种配置,
        // 但 Registry 是 pub,本层的不变量必须自己守)。
        let bogus_cap = cap + 1;
        for i in 1..cap {
            r.register_device("ACCT_A", &format!("D{i}"), [i as u8; 32], bogus_cap, t0())
                .unwrap_or_else(|e| panic!("第 {} 台该进得来:{e:?}", i + 1));
        }
        assert_eq!(r.devices_of("ACCT_A").len(), cap, "先填到恰好到顶");
        // 到顶之后再来一台:拒,而且拒它的是**协议硬帽**不是 device_cap(后者是 33)。
        assert_eq!(
            r.register_device("ACCT_A", "DOVER", [99; 32], bogus_cap, t0()),
            Err(RegisterError::AccountFull),
            "到了协议硬帽就该拒,哪怕调用方给的帽子更大"
        );
        // ⭐ 真正的判据:盘上现在这份,新二进制起得来。
        Registry::load(&bl, path).expect("成功落盘的 registry 必须 load 得动");
        // 租约那条路同样早拒(别发一枚注定消费不掉的租约)。
        assert_eq!(
            r.grant_seat_lease("ACCT_A", "D0", "DOVER", [99; 32], bogus_cap, t0(), LEASE_TTL),
            Err(SeatLeaseError::AccountFull)
        );
    }

    /// L1(实现审弹一):`set_admin(on=true)` 的回滚里那句「连带把**新建的**空集合删掉」
    /// 此前没有测 —— 既有那只用的账户 `admins` 键**本来就在**(首台注册建的),于是
    /// 「从无到有建了键、回滚要把键也删掉」这一格谁也没走。
    ///
    /// 它漏掉的后果与 [`no_successful_write_can_leave_a_registry_that_refuses_to_load`]
    /// 同族:留下 `{"ACCT_A": []}` 这个**非规范表示**,内存里看着人畜无害,直到**下一次
    /// 成功落盘**把它写进文件 —— 再下次启动就撞 load 那道「显式空集合即拒启」。
    #[test]
    fn set_admin_rollback_removes_a_key_it_created_from_nothing() {
        let dir = tmpdir("admins-set-rollback-fromnothing");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空封禁表\n").unwrap();
        let path = dir.join("registry.json");
        // 存量形:账户有两台设备,**admins 一个键都没有**(未回填)。
        fs::write(
            &path,
            format!(
                r#"{{"accounts":{{"ACCT_A":{{"D1":"{}","D2":"{}"}}}}}}"#,
                key_hex(1),
                key_hex(2)
            ),
        )
        .unwrap();
        let mut r = Registry::load(&bl, path.clone()).unwrap();
        assert!(!r.has_admins("ACCT_A"), "前置:这个账户此刻一个管理设备都没有");
        // 落盘失败:把目标文件换成目录。
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(r.set_admin("ACCT_A", "D1", true), Err(RegisterError::Persist));
        assert!(!r.has_admins("ACCT_A"), "刚**新建**的那个键要连键一起删掉");
        assert!(r.admins.is_empty(), "整张表回到出厂态,不许留下 ACCT_A:[]");
        // ⭐ 判据落到真实后果上:恢复落盘能力,让**下一次成功的写**把当前内存态写出去,
        // 它必须仍是 load 得动的(留下空集合的话,这一步写出的文件下次启动就拒)。
        //
        // ⚠ **这一步必须挑一条不碰 `admins` 的持久写**(实现审弹一 L2):我第一版写的是
        // `set_admin(D2, true)` —— 它会把残留的 `ACCT_A: []` **顺手修成** `["D2"]`,于是
        // 坏回滚实现照样能过,整段没有牙齿。`set_entitlement` 只动 entitlements,残留的
        // 空集合会被原样写进文件。
        fs::remove_dir(&path).unwrap();
        r.set_entitlement(
            "ACCT_A",
            Entitlement {
                tier: "test".into(),
                expires_at: None,
                seat_quota: 4,
                fastlane_bytes_per_month: FREE_FASTLANE_BYTES_PER_MONTH,
            },
            t0(),
        )
        .expect("恢复之后要写得出去");
        Registry::load(&bl, path).expect("回滚之后写出的 registry 必须 load 得动");
    }

    /// 四条持久写路径之一:`register_first` 落盘失败 → 设备、账户键、**admins 键**
    /// 三样一起回滚。留下 admins 就是个指向不存在账户的幽灵管理位,下次启动撞 load。
    #[test]
    fn register_first_persist_failure_rolls_back_admins_too() {
        let dir = tmpdir("admins-rollback-first");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空封禁表\n").unwrap();
        let mut r = Registry::load(&bl, dir.join("no-such-dir").join("registry.json")).unwrap();
        assert_eq!(r.register_first("ACCT_A", "D1", [1; 32]), Err(RegisterError::Persist));
        assert!(!r.has_admins("ACCT_A"), "幽灵管理位必须一起回滚");
        assert!(r.admins.is_empty());
    }

    /// 四条持久写路径之二:`register_device` 落盘失败**只**删刚加的那台;admins 在这条
    /// 路上不涉及(新设备默认不是管理设备),幸存设备的管理位一格不动。
    #[test]
    fn register_device_persist_failure_leaves_admins_alone() {
        let dir = tmpdir("admins-rollback-endorse");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        // 注册成功后把 registry.json 换成同名目录:save 的 rename 必败。
        fs::remove_file(dir.join("registry.json")).unwrap();
        fs::create_dir(dir.join("registry.json")).unwrap();
        assert_eq!(
            r.register_device("ACCT_A", "D2", [2; 32], 8, t0()),
            Err(RegisterError::Persist)
        );
        assert_eq!(r.pubkey_of("ACCT_A", "D2"), None, "刚加的那台要删掉");
        assert_eq!(r.pubkey_of("ACCT_A", "D1"), Some([1; 32]), "幸存设备不许被误删");
        assert!(r.is_admin("ACCT_A", "D1"), "幸存设备的管理位一格不动");
    }

    /// 管理位跟着设备走:吊销即摘、摘到空即删键(规范表示)、落盘持久。
    /// ⚠ 本层**不**拦「把 admins 摘空」——运营者面的逃生口,不变量只约束用户面。
    #[test]
    fn revoke_device_drops_the_admin_bit() {
        let dir = tmpdir("admins-revoke");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        assert_eq!(r.set_admin("ACCT_A", "D2", true), Ok(true));
        // 吊掉一台管理设备:另一台仍在册,键还在。
        assert_eq!(r.revoke_device("ACCT_A", "D2"), Ok(RevokeOutcome::DeviceRevoked));
        assert!(!r.is_admin("ACCT_A", "D2"));
        assert!(r.is_admin("ACCT_A", "D1"));
        // 吊掉最后一台管理设备:运营者面**允许**,且 admins 键随之消失(空=无键)。
        assert_eq!(r.revoke_device("ACCT_A", "D1"), Ok(RevokeOutcome::AccountSealed));
        assert!(!r.has_admins("ACCT_A"));
        assert!(r.admins.is_empty(), "空集合的唯一规范表示是没有该键");
        // 落盘持久且**重 load 不撞不变量**(摘不干净就会在这一步拒启)。
        let r2 = fresh(&dir);
        assert!(!r2.has_admins("ACCT_A"));
    }

    /// 四条持久写路径之三:吊销落盘失败 → 设备与**管理位**净变化为零。
    #[test]
    fn revoke_persist_failure_restores_the_admin_bit() {
        let dir = tmpdir("admins-revoke-rollback");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        fs::remove_file(dir.join("registry.json")).unwrap();
        fs::create_dir(dir.join("registry.json")).unwrap();
        assert_eq!(r.revoke_device("ACCT_A", "D1"), Err(RevokeError::Persist));
        assert_eq!(r.pubkey_of("ACCT_A", "D1"), Some([1; 32]));
        assert!(r.is_admin("ACCT_A", "D1"), "管理位也得原样还回去");
    }

    /// `set_admin` 的幂等与规范表示。幂等那格是 §5.13 M1 的落地:管理设备可以无限
    /// 交替 Grant/Revoke,每次都触发全量落盘 + 全账户 fan-out;**无变化就不做事**
    /// 砍掉了那条路,故这里断的是「回 false」——调用方据它决定不 save、不升 revision。
    #[test]
    fn set_admin_idempotent_and_canonical_empty() {
        let dir = tmpdir("admins-set");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        // 已是管理设备再设 → 无变化。
        assert_eq!(r.set_admin("ACCT_A", "D1", true), Ok(false));
        // 真变化 → true。
        assert_eq!(r.set_admin("ACCT_A", "D2", true), Ok(true));
        assert_eq!(r.set_admin("ACCT_A", "D2", true), Ok(false));
        assert_eq!(r.set_admin("ACCT_A", "D2", false), Ok(true));
        assert_eq!(r.set_admin("ACCT_A", "D2", false), Ok(false), "已不是再取消也是无变化");
        // 不在册的设备不许拿管理位(否则就是造幽灵管理位,load 会拒启)。
        assert_eq!(
            r.set_admin("ACCT_A", "DX", true),
            Err(RegisterError::AccountNotInitialized)
        );
        assert_eq!(
            r.set_admin("ACCT_B", "D1", true),
            Err(RegisterError::AccountNotInitialized)
        );
        // 运营者面可以清空(逃生口的另一半),清空即删键。
        assert_eq!(r.set_admin("ACCT_A", "D1", false), Ok(true));
        assert!(r.admins.is_empty());
        let r2 = fresh(&dir);
        assert!(!r2.has_admins("ACCT_A"), "清空要落盘");
    }

    /// 四条持久写路径之四(**我原设计整个漏了它的回滚**)。`on=true` 与 `on=false`
    /// 是两条**不同**的回滚臂,两个方向都要真跑(二轮 M5)。
    #[test]
    fn set_admin_persist_failure_rolls_back_both_arms() {
        // 臂一:on=true 落盘失败 → 撤销刚插的(连带把新建的空集合删掉)。
        let dir = tmpdir("admins-set-rollback-on");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        fs::remove_file(dir.join("registry.json")).unwrap();
        fs::create_dir(dir.join("registry.json")).unwrap();
        assert_eq!(r.set_admin("ACCT_A", "D2", true), Err(RegisterError::Persist));
        assert!(!r.is_admin("ACCT_A", "D2"), "刚插的管理位要撤掉");
        assert!(r.is_admin("ACCT_A", "D1"), "别的管理位不许受牵连");

        // 臂二:on=false 落盘失败 → 恢复刚删的(且那次删可能把整个键删掉了)。
        let dir = tmpdir("admins-set-rollback-off");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        fs::remove_file(dir.join("registry.json")).unwrap();
        fs::create_dir(dir.join("registry.json")).unwrap();
        assert_eq!(r.set_admin("ACCT_A", "D1", false), Err(RegisterError::Persist));
        assert!(r.is_admin("ACCT_A", "D1"), "刚删的管理位要恢复(键也得重建)");
        assert!(r.has_admins("ACCT_A"));
    }

    /// 离线 validator 与正式 load **同源**(§5.14 3d:两份判据不许各写一遍)——
    /// 它就是调 load,故「校验过的文件,新二进制必启得来」是结构事实。
    /// 回执里那份「未设管理设备的账户」清单 = §5.16.5-2 回填工序要的那张表。
    #[test]
    fn validate_registry_is_the_same_predicate_as_load() {
        let dir = tmpdir("validate-registry");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空封禁表\n").unwrap();
        // 坏文件:load 拒启 ⇒ validator 必须也拒(而不是给个「看着合理」的绿)。
        let bad = dir.join("bad.json");
        fs::write(&bad, format!(r#"{{"accounts":{{"ACCT_A":{{"D1":"{}"}}}},"admins":{{"ACCT_A":[]}}}}"#, key_hex(1))).unwrap();
        assert!(validate_registry(&bl, bad.clone()).is_err());
        assert!(Registry::load(&bl, bad).is_err());
        // 存量好文件:过,且点名「ACCT_A 还没设管理设备」。
        let legacy = dir.join("legacy.json");
        fs::write(&legacy, format!(r#"{{"accounts":{{"ACCT_A":{{"D1":"{}"}}}}}}"#, key_hex(1)))
            .unwrap();
        let report = validate_registry(&bl, legacy).expect("存量文件必须过");
        assert!(report.starts_with("ok:"), "{report}");
        assert!(report.contains("ACCT_A"), "回填清单要点名那个账户:{report}");
        // 已回填的文件:过,且清单为空。
        let filled = dir.join("filled.json");
        fs::write(
            &filled,
            format!(
                r#"{{"accounts":{{"ACCT_A":{{"D1":"{}"}}}},"admins":{{"ACCT_A":["D1"]}}}}"#,
                key_hex(1)
            ),
        )
        .unwrap();
        let report = validate_registry(&bl, filled).expect("已回填的文件必须过");
        assert!(report.contains("未设管理设备的账户 0 个"), "{report}");
    }

    /// **路径拼错时绝不回「合法」**(实现审弹一 M1)。
    ///
    /// `load` 把 `NotFound` 当首启空 registry —— 那对服务器是对的,对这只**升级前必跑**
    /// 的工具是假绿:`--validate-registry typo.json` 会回「ok,账户 0 个 / 未设管理设备
    /// 的账户 0 个」,而它答错的这一刻正是最需要它答对的一刻(实测过,回执逐字如此)。
    /// 存在性这一格因此由 validator 自己判,内容判据仍与 load 同源。
    #[test]
    fn validate_registry_refuses_a_target_that_is_not_a_file() {
        let dir = tmpdir("validate-registry-missing");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空封禁表\n").unwrap();
        // ① 不存在的路径:必须红,且**不许**被当成「空 registry」。
        let missing = dir.join("no-such-registry.json");
        let Err(e) = validate_registry(&bl, missing) else {
            panic!("路径不存在时绝不许回「合法」——那是升级前唯一那道闸的假绿");
        };
        assert_eq!(e.kind(), io::ErrorKind::NotFound);
        // ② 目录:同样不是一份 registry。
        //    ⚠ **判「红没红」在这一格没有牙齿** —— 目录 `load` 自己也会拒(read_to_string
        //    失败),摘掉这道闸照样红(变异 ② 当场证明)。这道闸买到的是**给运维的那句
        //    话**:「你指的不是一份文件」比「不是合法 JSON」有用得多。故判据钉**拒它的
        //    是哪道闸**,不是「拒没拒」(first-draft-checklist 第 13 条)。
        let asdir = dir.join("adirectory.json");
        fs::create_dir(&asdir).unwrap();
        let Err(e) = validate_registry(&bl, asdir) else { panic!("目录不是一份 registry") };
        assert!(
            e.to_string().contains("不是普通文件"),
            "该由 validator 自己那道闸拒,并说清楚为什么;现在拒它的是别处:{e}"
        );
        // ③ 一红一绿对照:同一目录下真有一份合法文件时,它照样过 —— 否则上面两条
        //    可能只是因为 banlist 或别的什么而红。
        let good = dir.join("good.json");
        fs::write(&good, format!(r#"{{"accounts":{{"ACCT_A":{{"D1":"{}"}}}}}}"#, key_hex(1)))
            .unwrap();
        assert!(validate_registry(&bl, good).expect("合法文件必须过").starts_with("ok:"));
    }

    #[test]
    fn revoke_persist_failure_rolls_back() {
        let dir = tmpdir("revoke-rollback");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        // 注册成功后把 registry.json 换成同名目录:save 的 rename 必败。
        fs::remove_file(dir.join("registry.json")).unwrap();
        fs::create_dir(dir.join("registry.json")).unwrap();
        assert_eq!(r.revoke_device("ACCT_A", "D1"), Err(RevokeError::Persist));
        assert_eq!(r.pubkey_of("ACCT_A", "D1"), Some([1; 32])); // 绑定仍在。
    }

    /// SIGHUP 热重载:重读文件即时反映封禁/解封,且不碰已注册设备绑定。
    #[test]
    fn reload_banlist_picks_up_edits() {
        let dir = tmpdir("reload");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空\n").unwrap();
        let mut r = Registry::load(&bl, dir.join("registry.json")).unwrap();
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();

        fs::write(&bl, format!("{BANNED_A}\n{BANNED_B}\n")).unwrap();
        assert_eq!(r.reload_banlist().unwrap(), 2);
        assert!(r.is_banned(BANNED_A));
        assert!(r.is_banned(BANNED_B));
        assert!(!r.is_banned("ACCT_A"));
        // 已注册设备绑定不随封禁表重载改变(registry 是另一根轴)。
        assert_eq!(r.pubkey_of("ACCT_A", "D1"), Some([1; 32]));
        // 解封同样即时。
        fs::write(&bl, format!("# 解封 B\n{BANNED_A}\n")).unwrap();
        assert_eq!(r.reload_banlist().unwrap(), 1);
        assert!(!r.is_banned(BANNED_B));
    }

    /// 坏/缺文件 = 保留旧封禁集合并报错(fail-safe 方向反转后仍安全:绝不把封禁
    /// 清空放行,也绝不误封)。
    #[test]
    fn reload_banlist_bad_file_keeps_old() {
        let dir = tmpdir("reload-bad");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, format!("{BANNED_A}\n")).unwrap();
        let mut r = Registry::load(&bl, dir.join("registry.json")).unwrap();
        fs::remove_file(&bl).unwrap();
        assert!(r.reload_banlist().is_err());
        assert!(r.is_banned(BANNED_A)); // 旧集合保留。
    }

    /// 解析严格化(open-signup §1.1 H1):拼错行 / 行内注释 = 整份拒收带行号,
    /// 旧集合保留——封禁表方向上静默跳过一行 = 目标账户没被封(fail-open,危险)。
    #[test]
    fn reload_banlist_rejects_malformed_lines() {
        let dir = tmpdir("reload-strict");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, format!("{BANNED_A}\n")).unwrap();
        let mut r = Registry::load(&bl, dir.join("registry.json")).unwrap();

        // 拼错(少一位)。
        fs::write(&bl, format!("{}\n", &BANNED_B[..25])).unwrap();
        let e = r.reload_banlist().unwrap_err();
        assert!(e.to_string().contains("第 1 行"), "带行号:{e}");
        assert!(r.is_banned(BANNED_A), "旧集合保留");

        // 行内注释(不是整行注释)。
        fs::write(&bl, format!("{BANNED_B} # 某某的账户\n")).unwrap();
        assert!(r.reload_banlist().is_err());
        assert!(r.is_banned(BANNED_A) && !r.is_banned(BANNED_B), "旧集合保留、新行未生效");

        // 首启同规则:坏文件直接拒启。
        assert!(Registry::load(&bl, dir.join("registry2.json")).is_err());
    }

    /// 测试基准时刻(entitlement 的 now 显式入参,测试不读墙钟保确定性)。
    fn t(s: &str) -> time::OffsetDateTime {
        parse_expires(s).unwrap()
    }

    /// entitlement 存取(billing-plan §3 工序 1):无记录=免费档默认(fail-closed);
    /// set 后即时生效、落盘重 load 仍在;**到期判定**(159 codex M1):expires_at
    /// 过了 now = 参数回免费档;别的账户不受影响。
    #[test]
    fn entitlement_default_free_set_persist_and_expiry() {
        let dir = tmpdir("ent");
        let now = t("2026-07-19T00:00:00Z");
        let paid = Entitlement {
            tier: "personal".into(),
            expires_at: Some(t("2027-07-19T00:00:00Z")),
            seat_quota: 4,
            fastlane_bytes_per_month: 2 * 1024 * 1024 * 1024,
        };
        {
            let mut r = fresh(&dir);
            r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
            r.register_first("ACCT_B", "D9", [9; 32]).unwrap();
            // 无记录 = 免费档默认;configured 可区分「从未设置」。
            assert_eq!(r.effective_entitlement("ACCT_A", now), Entitlement::free_default());
            assert_eq!(r.effective_entitlement("ACCT_A", now).seat_quota, FREE_SEAT_QUOTA);
            assert!(r.configured_entitlement("ACCT_A").is_none());
            assert_eq!(r.set_entitlement("ACCT_A", paid.clone(), now), Ok(()));
            assert_eq!(r.effective_entitlement("ACCT_A", now), paid);
            assert_eq!(r.configured_entitlement("ACCT_A"), Some(&paid));
            // 别的账户仍是默认。
            assert_eq!(r.effective_entitlement("ACCT_B", now), Entitlement::free_default());
        }
        // 落盘持久:重 load 后设置仍在(expires_at RFC3339 往返)。
        let r2 = fresh(&dir);
        assert_eq!(r2.effective_entitlement("ACCT_A", now), paid);
        assert_eq!(r2.effective_entitlement("ACCT_B", now), Entitlement::free_default());
        // 到期语义:过期时刻起参数回免费档(恰在到期点=已过期;configured 仍可查)。
        assert_eq!(r2.effective_entitlement("ACCT_A", t("2027-07-19T00:00:00Z")), Entitlement::free_default());
        assert_eq!(r2.effective_entitlement("ACCT_A", t("2028-01-01T00:00:00Z")), Entitlement::free_default());
        assert_eq!(r2.configured_entitlement("ACCT_A"), Some(&paid));
    }

    /// 免费档席位数 Config 旋钮(推广期生产 4):`set_free_seat` 只抬无显式 entitlement
    /// 账户的 effective seat_quota,不碰 fastlane、不碰已设 entitlement;默认仍 2。
    #[test]
    fn free_seat_quota_knob_lifts_free_tier_only() {
        let dir = tmpdir("free-seat");
        let now = t("2026-07-19T00:00:00Z");
        let mut r = fresh(&dir);
        r.register_first("ACCT_FREE", "D1", [1; 32]).unwrap();
        r.register_first("ACCT_PAID", "D2", [2; 32]).unwrap();
        // 默认 = 常量 2(测试基线,单元测别的地方都靠这个)。
        assert_eq!(r.effective_entitlement("ACCT_FREE", now).seat_quota, FREE_SEAT_QUOTA);
        // 已设显式 entitlement 的账户走自己的席位,不受旋钮影响。
        let paid = Entitlement { seat_quota: 16, ..Entitlement::free_default() };
        r.set_entitlement("ACCT_PAID", paid.clone(), now).unwrap();
        // 注入推广期 4:免费账户抬到 4,fastlane 仍是免费档默认,付费账户不变。
        r.set_free_seat(4);
        let free_eff = r.effective_entitlement("ACCT_FREE", now);
        assert_eq!(free_eff.seat_quota, 4);
        assert_eq!(free_eff.fastlane_bytes_per_month, FREE_FASTLANE_BYTES_PER_MONTH);
        assert_eq!(free_eff.tier, FREE_TIER);
        assert_eq!(r.effective_entitlement("ACCT_PAID", now).seat_quota, 16);
    }

    /// set 的拒绝面:未知账户(typo 防线)/ 空墓碑(重开 runbook 手删账户条目不许
    /// 留孤儿 entitlement,159 codex M2)/ 结构不变量(tier 形态 / seat_quota 0)。
    #[test]
    fn set_entitlement_rejects_unknown_sealed_and_bad_params() {
        let dir = tmpdir("ent-reject");
        let now = t("2026-07-19T00:00:00Z");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        assert_eq!(
            r.set_entitlement("ACCT_NOPE", Entitlement::free_default(), now),
            Err(SetEntitlementError::UnknownAccount)
        );
        let bad_quota = Entitlement { seat_quota: 0, ..Entitlement::free_default() };
        assert!(matches!(
            r.set_entitlement("ACCT_A", bad_quota, now),
            Err(SetEntitlementError::Invalid(_))
        ));
        let bad_tier = Entitlement { tier: "有 空格".into(), ..Entitlement::free_default() };
        assert!(matches!(
            r.set_entitlement("ACCT_A", bad_tier, now),
            Err(SetEntitlementError::Invalid(_))
        ));
        // 拒绝零副作用:仍是默认、盘上无记录。
        assert!(r.configured_entitlement("ACCT_A").is_none());
        // 空墓碑(吊光归零)拒设;account_exists 对墓碑与未知都是 false。
        r.register_first("ACCT_B", "D9", [9; 32]).unwrap();
        assert_eq!(r.revoke_device("ACCT_B", "D9"), Ok(RevokeOutcome::AccountSealed));
        assert_eq!(
            r.set_entitlement("ACCT_B", Entitlement::free_default(), now),
            Err(SetEntitlementError::SealedAccount)
        );
        assert!(r.account_exists("ACCT_A") && !r.account_exists("ACCT_B") && !r.account_exists("ACCT_NOPE"));
        assert_eq!(r.effective_entitlement("ACCT_B", now), Entitlement::free_default());
    }

    /// 落盘失败 = 回滚内存设置(首设回滚成「无记录」,改设回滚回旧值)。
    #[test]
    fn set_entitlement_persist_failure_rolls_back() {
        let dir = tmpdir("ent-rollback");
        let now = t("2026-07-19T00:00:00Z");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        let v1 = Entitlement { seat_quota: 4, ..Entitlement::free_default() };
        r.set_entitlement("ACCT_A", v1.clone(), now).unwrap();
        // registry.json 换成同名目录:save 的 rename 必败。
        fs::remove_file(dir.join("registry.json")).unwrap();
        fs::create_dir(dir.join("registry.json")).unwrap();
        let v2 = Entitlement { seat_quota: 16, ..Entitlement::free_default() };
        assert_eq!(r.set_entitlement("ACCT_A", v2, now), Err(SetEntitlementError::Persist));
        // 旧值仍在,未生效不装成功。
        assert_eq!(r.configured_entitlement("ACCT_A"), Some(&v1));
    }

    // ---- grant 高水位(169,工序 3;codex 六轮设计审)----

    const GIB2: u64 = 2 * 1024 * 1024 * 1024;

    fn paid_ent(fastlane: u64, expires: Option<&str>) -> Entitlement {
        Entitlement {
            tier: "personal".into(),
            expires_at: expires.map(t),
            seat_quota: 4,
            fastlane_bytes_per_month: fastlane,
        }
    }

    /// grant 月初按 `period_start` 建:月初早于到期也捕获到期前高额度(codex B 反例)。
    #[test]
    fn grant_floor_captures_pre_expiry() {
        let dir = tmpdir("grant-floor");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        // 6/20 设 paid 2GiB、7/15 到期。
        r.set_entitlement("ACCT_A", paid_ent(GIB2, Some("2026-07-15T00:00:00Z")), t("2026-06-20T00:00:00Z")).unwrap();
        // 滚到 7 月(now=7/20 已过到期):grant_floor 按 7/1 时刻算,paid 仍在 → 2GiB。
        assert_eq!(r.roll_grants_to_current_month(t("2026-07-20T00:00:00Z")).unwrap(), 1);
        // 7/20 的 fastlane 判据 = 2GiB(尽管 effective 已回免费档)。
        assert_eq!(r.effective_grant_quota("ACCT_A", t("2026-07-20T00:00:00Z")), GIB2);
        assert_eq!(r.effective_entitlement("ACCT_A", t("2026-07-20T00:00:00Z")).fastlane_bytes_per_month, FREE_FASTLANE_BYTES_PER_MONTH);
    }

    /// 升级即时抬、降档当月不降、新月重建。
    #[test]
    fn grant_upgrade_raises_downgrade_holds_new_month_rebuilds() {
        let dir = tmpdir("grant-hw");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        // 7/10 升 paid 2GiB(不过期)。
        r.set_entitlement("ACCT_A", paid_ent(GIB2, None), t("2026-07-10T00:00:00Z")).unwrap();
        assert_eq!(r.effective_grant_quota("ACCT_A", t("2026-07-15T00:00:00Z")), GIB2);
        // 7/20 降回免费档 fastlane:当月 grant 不倒扣,仍 2GiB。
        r.set_entitlement("ACCT_A", paid_ent(FREE_FASTLANE_BYTES_PER_MONTH, None), t("2026-07-20T00:00:00Z")).unwrap();
        assert_eq!(r.effective_grant_quota("ACCT_A", t("2026-07-25T00:00:00Z")), GIB2);
        // 8 月滚月:按 8/1 effective 重建 = 现档 300MiB。
        assert_eq!(r.roll_grants_to_current_month(t("2026-08-01T00:00:00Z")).unwrap(), 1);
        assert_eq!(r.effective_grant_quota("ACCT_A", t("2026-08-05T00:00:00Z")), FREE_FASTLANE_BYTES_PER_MONTH);
    }

    /// 有序月份:grant 在未来月(墙钟回拨)→ 保留、不重建旧月。
    #[test]
    fn grant_wall_clock_back_keeps_future() {
        let dir = tmpdir("grant-back");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.set_entitlement("ACCT_A", paid_ent(GIB2, None), t("2026-07-10T00:00:00Z")).unwrap();
        // grant.period=2026-07;查 6 月(回拨)→ 保留 2GiB,不重建 6 月免费。
        assert_eq!(r.effective_grant_quota("ACCT_A", t("2026-06-30T23:00:00Z")), GIB2);
    }

    /// 无帧授权:升级→无任何数据帧→到期→次月滚月前的 fastlane 判据仍取本月高 grant。
    #[test]
    fn grant_no_traffic_still_high() {
        let dir = tmpdir("grant-notraffic");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        // 7/1 前设 paid、7/10 到期;7 月无任何 set/roll 之外的动作。
        r.set_entitlement("ACCT_A", paid_ent(GIB2, Some("2026-07-10T00:00:00Z")), t("2026-06-25T00:00:00Z")).unwrap();
        r.roll_grants_to_current_month(t("2026-07-02T00:00:00Z")).unwrap(); // sweeper 月初建 grant[7]=2GiB
        // 7/20(到期后、无流量):仍 2GiB。
        assert_eq!(r.effective_grant_quota("ACCT_A", t("2026-07-20T00:00:00Z")), GIB2);
    }

    /// 滚月落盘持久 + 幂等(同月再滚=0 改动)。
    #[test]
    fn grant_roll_persists_and_idempotent() {
        let dir = tmpdir("grant-roll");
        {
            let mut r = fresh(&dir);
            r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
            assert_eq!(r.roll_grants_to_current_month(t("2026-07-05T00:00:00Z")).unwrap(), 1);
            // 同月再滚:0 改动。
            assert_eq!(r.roll_grants_to_current_month(t("2026-07-25T00:00:00Z")).unwrap(), 0);
        }
        // 重 load:grant 持久(免费档 fastlane)。
        let r2 = fresh(&dir);
        assert_eq!(r2.effective_grant_quota("ACCT_A", t("2026-07-30T00:00:00Z")), FREE_FASTLANE_BYTES_PER_MONTH);
    }

    /// 滚月落盘失败 → 回滚全部内存 grant(盘内一致不变量)。
    #[test]
    fn grant_roll_save_fail_rolls_back_all() {
        let dir = tmpdir("grant-roll-fail");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_first("ACCT_B", "D9", [9; 32]).unwrap();
        // save 的 rename 必败。
        fs::remove_file(dir.join("registry.json")).unwrap();
        fs::create_dir(dir.join("registry.json")).unwrap();
        assert!(r.roll_grants_to_current_month(t("2026-07-05T00:00:00Z")).is_err());
        // 内存 grant 全回滚:两账户读回 rebuild(免费档),grants map 未留半成品
        // (无从直接读私有 map,借 effective_grant_quota 的 rebuild 路径=免费档验证)。
        assert_eq!(r.effective_grant_quota("ACCT_A", t("2026-07-05T00:00:00Z")), FREE_FASTLANE_BYTES_PER_MONTH);
    }

    /// 旧 registry.json(无 grants 键)照常加载=全员 rebuild;坏 period = 拒启。
    #[test]
    fn grant_disk_compat_and_bad_period_rejected() {
        let dir = tmpdir("grant-disk");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空\n").unwrap();
        // 无 grants 键:加载成功,rebuild 到免费档。
        let old = dir.join("old.json");
        fs::write(&old, r#"{"accounts":{"ACCT_A":{"D1":"0101010101010101010101010101010101010101010101010101010101010101"}}}"#).unwrap();
        let r = Registry::load(&bl, old).unwrap();
        assert_eq!(r.effective_grant_quota("ACCT_A", t("2026-07-05T00:00:00Z")), FREE_FASTLANE_BYTES_PER_MONTH);
        // 坏 period(月份 13):拒启。
        let bad = dir.join("bad.json");
        fs::write(&bad, r#"{"accounts":{"ACCT_A":{"D1":"0101010101010101010101010101010101010101010101010101010101010101"}},"grants":{"ACCT_A":{"period":"2026-13","quota":1}}}"#).unwrap();
        assert!(Registry::load(&bl, bad).is_err());
    }

    /// 旧 registry.json(无 entitlements 键)照常加载=全员免费档默认(serde default
    /// 前向兼容锚);坏 entitlement(指向不存在账户 / 坏 expires_at / 0 席)= 拒启。
    #[test]
    fn entitlement_disk_compat_and_corrupt_rejected_at_load() {
        let dir = tmpdir("ent-disk");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 空\n").unwrap();
        let old = dir.join("old-registry.json");
        fs::write(
            &old,
            r#"{"accounts":{"ACCT_A":{"D1":"0101010101010101010101010101010101010101010101010101010101010101"}}}"#,
        )
        .unwrap();
        let r = Registry::load(&bl, old).unwrap();
        assert_eq!(
            r.effective_entitlement("ACCT_A", t("2026-07-19T00:00:00Z")),
            Entitlement::free_default()
        );

        // 未设置过授权的库:save 不写 entitlements 键(生产文件字节形态不变)。
        let mut r2 = fresh(&dir);
        r2.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        assert!(!fs::read_to_string(dir.join("registry.json")).unwrap().contains("entitlements"));

        let acct = r#""ACCT_A":{"D1":"0101010101010101010101010101010101010101010101010101010101010101"}"#;
        for (name, ent_json) in [
            ("孤儿账户", r#""ACCT_NOPE":{"tier":"free","seat_quota":2,"fastlane_bytes_per_month":1}"#),
            ("坏时刻", r#""ACCT_A":{"tier":"free","expires_at":"下周","seat_quota":2,"fastlane_bytes_per_month":1}"#),
            ("零席位", r#""ACCT_A":{"tier":"free","seat_quota":0,"fastlane_bytes_per_month":1}"#),
        ] {
            let bad = dir.join("bad-ent.json");
            fs::write(&bad, format!(r#"{{"accounts":{{{acct}}},"entitlements":{{{ent_json}}}}}"#)).unwrap();
            assert!(Registry::load(&bl, bad).is_err(), "{name} 必须拒启");
        }

        // deny_unknown_fields 锚(159 codex H2 的前向教训):未知顶层键=更新的格式,
        // 本版必须响亮拒启——绝不「静默吞掉、下次保存抹掉」。
        let future = dir.join("future.json");
        fs::write(&future, format!(r#"{{"accounts":{{{acct}}},"seat_leases":{{}}}}"#)).unwrap();
        assert!(Registry::load(&bl, future).is_err(), "未知顶层键必须拒启");
    }

    /// device 反查(open-signup §1.5):属主命中/未知 None;磁盘态跨账户重复
    /// device = load 拒启(反查依赖全局唯一,双层守护的磁盘层)。
    #[test]
    fn owner_of_device_and_duplicate_device_rejected_at_load() {
        let dir = tmpdir("owner");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        assert_eq!(r.owner_of_device("D1"), Ok(Some("ACCT_A".into())));
        assert_eq!(r.owner_of_device("DX"), Ok(None));

        // 手工伪造跨账户重复 device 的 registry.json:load 必须拒启。
        let bad = dir.join("bad-registry.json");
        fs::write(
            &bad,
            r#"{"accounts":{"ACCT_A":{"D1":"0101010101010101010101010101010101010101010101010101010101010101"},"ACCT_B":{"D1":"0202020202020202020202020202020202020202020202020202020202020202"}}}"#,
        )
        .unwrap();
        let bl = dir.join("banlist.txt");
        let err = Registry::load(&bl, bad).err().expect("跨账户重复 device 必须拒启");
        assert!(err.to_string().contains("同时属于"), "拒启并点名:{err}");
    }

    // ---- 两层席位闸 + 纪元席位租约(billing-plan §5,工序 2) ----

    /// 商业层:免费档 2 席满 → 第三台 SeatLimit(不是 AccountFull,双错误码);
    /// admin 提额即时生效;到期(effective 回免费档)后再拒。
    #[test]
    fn seat_quota_gates_register_device_and_raise_unblocks() {
        let dir = tmpdir("seat-quota");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        // 免费档 2/2 满:第三台拒,且错误码是商业层的 SeatLimit。
        assert_eq!(
            r.register_device("ACCT_A", "D3", [3; 32], 8, t0()),
            Err(RegisterError::SeatLimit)
        );
        // 拒绝零副作用:设备没进去。
        assert_eq!(r.pubkey_of("ACCT_A", "D3"), None);
        // 幂等重放在配额之前:满席下同账户同钥重放必须放行。
        assert_eq!(r.register_device("ACCT_A", "D2", [2; 32], 8, t0()), Ok(()));
        // admin 提额(4 席、一年后到期)→ 即时生效,第三台可入。
        let paid = Entitlement {
            tier: "personal".into(),
            expires_at: Some(t("2027-07-19T00:00:00Z")),
            seat_quota: 4,
            ..Entitlement::free_default()
        };
        r.set_entitlement("ACCT_A", paid, t0()).unwrap();
        assert_eq!(r.register_device("ACCT_A", "D3", [3; 32], 8, t0()), Ok(()));
        assert_eq!(r.register_device("ACCT_A", "D4", [4; 32], 8, t0()), Ok(()));
        // 4/4 满:第五台 SeatLimit。
        assert_eq!(
            r.register_device("ACCT_A", "D5", [5; 32], 8, t0()),
            Err(RegisterError::SeatLimit)
        );
        // 到期后 effective 回免费档(2 席):4 台在编不动,但再加照拒(到期语义
        // 只回参数,不删数据不吊设备——billing-plan §5)。
        let expired = t("2027-07-19T00:00:00Z");
        assert_eq!(
            r.register_device("ACCT_A", "D5", [5; 32], 8, expired),
            Err(RegisterError::SeatLimit)
        );
        assert_eq!(r.devices_of("ACCT_A").len(), 4, "到期不删在编设备");
    }

    /// 容量层先于商业层:硬帽处恒 AccountFull——提额解不了,错误码不许误导。
    #[test]
    fn hard_cap_precedes_seat_quota() {
        let dir = tmpdir("seat-cap-first");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        // quota 拉到 16,硬帽 2:触帽报 AccountFull 而非 SeatLimit。
        let big = Entitlement { seat_quota: 16, ..Entitlement::free_default() };
        r.set_entitlement("ACCT_A", big, t0()).unwrap();
        assert_eq!(
            r.register_device("ACCT_A", "D3", [3; 32], 2, t0()),
            Err(RegisterError::AccountFull)
        );
    }

    /// 租约正路:满席求租 → +1 注册成 → 消费即失(再加第四台仍拒);消费后
    /// 崩溃重试(同账户同钥)靠幂等分支放行;已注册目标再求租 = Ok 不开租。
    #[test]
    fn seat_lease_allows_one_over_quota_then_consumed() {
        let dir = tmpdir("seat-lease");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        // 满席直接注册拒(对照)。
        assert_eq!(
            r.register_device("ACCT_A", "D3", [3; 32], 8, t0()),
            Err(RegisterError::SeatLimit)
        );
        // 求租(sponsor=D1,目标 D3)→ 同目标注册放行。
        r.grant_seat_lease("ACCT_A", "D1", "D3", [3; 32], 8, t0(), LEASE_TTL).unwrap();
        assert_eq!(r.register_device("ACCT_A", "D3", [3; 32], 8, t0()), Ok(()));
        // 消费即失:3/2 超编,第四台拒(租约不可叠加、不可复用)。
        assert_eq!(
            r.register_device("ACCT_A", "D4", [4; 32], 8, t0()),
            Err(RegisterError::SeatLimit)
        );
        // 消费后崩溃重试:同账户同钥重放 = 幂等 Ok(完成门专项:Registered 因
        // kick 未送达,客户端重试靠「幂等先于配额」重新取得)。
        assert_eq!(r.register_device("ACCT_A", "D3", [3; 32], 8, t0()), Ok(()));
        // 重试若整流程重来会先重新求租:目标已注册同钥 → Ok 且不开新租约
        // (随后注册仍走幂等;不留可被挪用的悬空 +1)。
        r.grant_seat_lease("ACCT_A", "D1", "D3", [3; 32], 8, t0(), LEASE_TTL).unwrap();
        assert_eq!(
            r.register_device("ACCT_A", "D4", [4; 32], 8, t0()),
            Err(RegisterError::SeatLimit),
            "已注册目标的求租不得给别的设备留 +1"
        );
    }

    /// 租约绑定具体目标不可挪用:异 device / 异钥都不 +1 且不消费;
    /// 新求租烧旧开新(每账户最多一枚)。
    #[test]
    fn seat_lease_bound_to_target_and_max_one() {
        let dir = tmpdir("seat-lease-bind");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        r.grant_seat_lease("ACCT_A", "D1", "D3", [3; 32], 8, t0(), LEASE_TTL).unwrap();
        // 异 device 不沾光。
        assert_eq!(
            r.register_device("ACCT_A", "D4", [4; 32], 8, t0()),
            Err(RegisterError::SeatLimit)
        );
        // 同 device 异钥不沾光(绑定 pubkey)。
        assert_eq!(
            r.register_device("ACCT_A", "D3", [9; 32], 8, t0()),
            Err(RegisterError::SeatLimit)
        );
        // 未消费:换目标重新求租 = 烧旧开新,旧目标失效、新目标可入。
        r.grant_seat_lease("ACCT_A", "D1", "D4", [4; 32], 8, t0(), LEASE_TTL).unwrap();
        assert_eq!(
            r.register_device("ACCT_A", "D3", [3; 32], 8, t0()),
            Err(RegisterError::SeatLimit),
            "旧租约已被烧"
        );
        assert_eq!(r.register_device("ACCT_A", "D4", [4; 32], 8, t0()), Ok(()));
    }

    /// 「绝不越硬帽」:触帽求租即拒 AccountFull;quota 再高、租约在手,注册时
    /// 硬帽层照样先拒。
    #[test]
    fn seat_lease_never_exceeds_hard_cap() {
        let dir = tmpdir("seat-lease-cap");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        // 触帽(cap=2)求租即拒。
        assert_eq!(
            r.grant_seat_lease("ACCT_A", "D1", "D3", [3; 32], 2, t0(), LEASE_TTL),
            Err(SeatLeaseError::AccountFull)
        );
        // 宽帽求到租,注册时硬帽收紧(防御性次序锚):硬帽层仍先拒。
        r.grant_seat_lease("ACCT_A", "D1", "D3", [3; 32], 8, t0(), LEASE_TTL).unwrap();
        assert_eq!(
            r.register_device("ACCT_A", "D3", [3; 32], 2, t0()),
            Err(RegisterError::AccountFull)
        );
    }

    /// 租约过期:到点(恰在 expires_at)即失效不 +1;sweep 回收。
    #[test]
    fn seat_lease_expires_and_swept() {
        let dir = tmpdir("seat-lease-ttl");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        r.grant_seat_lease("ACCT_A", "D1", "D3", [3; 32], 8, t0(), LEASE_TTL).unwrap();
        let at_expiry = t0() + LEASE_TTL;
        assert_eq!(
            r.register_device("ACCT_A", "D3", [3; 32], 8, at_expiry),
            Err(RegisterError::SeatLimit),
            "恰在到期点 = 已过期(与 entitlement 同口径)"
        );
        assert_eq!(r.sweep_seat_leases(at_expiry), 1);
        assert_eq!(r.sweep_seat_leases(at_expiry), 0);
    }

    /// 租约消费与落盘同生共死:落盘失败 → 设备回滚 **且租约还原**(不然重试时
    /// 租约已凭空蒸发,合法纪元切换被卡死)。
    #[test]
    fn seat_lease_restored_on_persist_failure() {
        let dir = tmpdir("seat-lease-rollback");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        r.grant_seat_lease("ACCT_A", "D1", "D3", [3; 32], 8, t0(), LEASE_TTL).unwrap();
        // registry.json 换成同名目录:save 的 rename 必败。
        fs::remove_file(dir.join("registry.json")).unwrap();
        fs::create_dir(dir.join("registry.json")).unwrap();
        assert_eq!(
            r.register_device("ACCT_A", "D3", [3; 32], 8, t0()),
            Err(RegisterError::Persist)
        );
        assert_eq!(r.pubkey_of("ACCT_A", "D3"), None, "设备已回滚");
        // 修好磁盘重试:租约must还在,同目标注册放行(若租约被吞,这里会 SeatLimit)。
        fs::remove_dir(dir.join("registry.json")).unwrap();
        assert_eq!(r.register_device("ACCT_A", "D3", [3; 32], 8, t0()), Ok(()));
    }

    /// codex 160 M1 回归锚:「已注册同钥目标 Ok 不开租」分支**必须烧掉现存租约**
    /// ——否则先租 D3、再求已注册 D2(Ok),D3 的旧租约在 TTL 内仍是悬空 +1。
    #[test]
    fn granting_for_registered_target_burns_existing_lease() {
        let dir = tmpdir("seat-lease-burn-on-registered");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        r.register_device("ACCT_A", "D2", [2; 32], 8, t0()).unwrap();
        r.grant_seat_lease("ACCT_A", "D1", "D3", [3; 32], 8, t0(), LEASE_TTL).unwrap();
        // 求已注册同钥目标 D2:Ok,且必须把 D3 的旧租约一并烧掉。
        assert_eq!(
            r.grant_seat_lease("ACCT_A", "D1", "D2", [2; 32], 8, t0(), LEASE_TTL),
            Ok(())
        );
        assert_eq!(
            r.register_device("ACCT_A", "D3", [3; 32], 8, t0()),
            Err(RegisterError::SeatLimit),
            "旧租约必须已被烧,不留悬空 +1"
        );
    }

    /// 求租的拒绝面:封禁 / 目标 device 被别处占用 / 已注册同钥目标 = Ok 不开租。
    #[test]
    fn grant_seat_lease_rejects_banned_and_taken() {
        let dir = tmpdir("seat-lease-reject");
        let bl = dir.join("banlist.txt");
        fs::write(&bl, format!("{BANNED_A}\n")).unwrap();
        let mut r = Registry::load(&bl, dir.join("registry.json")).unwrap();
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        assert_eq!(
            r.grant_seat_lease(BANNED_A, "DX", "DY", [7; 32], 8, t0(), LEASE_TTL),
            Err(SeatLeaseError::Banned)
        );
        // 目标 device_id 已被 ACCT_A 占用:别的账户求租即拒(早拒早诚实)。
        r.register_first("ACCT_B", "E1", [5; 32]).unwrap();
        assert_eq!(
            r.grant_seat_lease("ACCT_B", "E1", "D1", [1; 32], 8, t0(), LEASE_TTL),
            Err(SeatLeaseError::DeviceIdTaken)
        );
        // 同账户异钥同 device:同样 DeviceIdTaken。
        assert_eq!(
            r.grant_seat_lease("ACCT_A", "D1", "D1", [9; 32], 8, t0(), LEASE_TTL),
            Err(SeatLeaseError::DeviceIdTaken)
        );
        // 已注册同钥目标:Ok 不开租(消费后崩溃重试路)。
        assert_eq!(
            r.grant_seat_lease("ACCT_A", "D1", "D1", [1; 32], 8, t0(), LEASE_TTL),
            Ok(())
        );
    }
}
