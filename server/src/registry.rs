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

use std::collections::{BTreeMap, HashSet};
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
    /// account → 授权参数(billing-plan §3;无记录=免费档默认,fail-closed)。
    /// 只由 admin 写,规模有账户数上界(set 要求账户已存在)。
    entitlements: BTreeMap<String, Entitlement>,
    /// account → 未消费的纪元席位租约(billing-plan §5,工序 2)。**每账户同时最多
    /// 一枚**(新求租烧旧开新)、纯内存不落盘(论证见 [`SeatLease`]);只有已鉴权
    /// sponsor 能开 → 规模有账户数上界,过期由 [`Self::sweep_seat_leases`] 清。
    seat_leases: BTreeMap<String, SeatLease>,
    /// 封禁表文件路径(SIGHUP 热重载重读它;`path` 是 registry.json)。
    banlist_path: PathBuf,
    path: PathBuf,
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

impl Registry {
    /// 封禁表必须存在(空文件=零封禁,运维意图显式;缺文件=部署残缺,fail-fast);
    /// registry 文件不存在 = 空(首启,首次注册时创建)。
    pub fn load(banlist_path: &Path, registry_path: PathBuf) -> io::Result<Self> {
        let banned = parse_banlist(banlist_path)?;

        let (accounts, entitlements) = match fs::read_to_string(&registry_path) {
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
                (accounts, entitlements)
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (BTreeMap::new(), BTreeMap::new()),
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

        Ok(Registry {
            banned,
            accounts,
            entitlements,
            seat_leases: BTreeMap::new(),
            banlist_path: banlist_path.to_owned(),
            path: registry_path,
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
    ) -> Result<(), SetEntitlementError> {
        ent.validate().map_err(SetEntitlementError::Invalid)?;
        match self.accounts.get(account) {
            None => return Err(SetEntitlementError::UnknownAccount),
            Some(devs) if devs.is_empty() => return Err(SetEntitlementError::SealedAccount),
            Some(_) => {}
        }
        let prev = self.entitlements.insert(account.to_owned(), ent);
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                crate::logln(format!(
                    "ERROR registry 落盘失败,已回滚 entitlement 设置 {account}:{e}"
                ));
                match prev {
                    Some(p) => {
                        self.entitlements.insert(account.to_owned(), p);
                    }
                    None => {
                        self.entitlements.remove(account);
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
            _ => Entitlement::free_default(),
        }
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
        self.accounts.entry(account.to_owned()).or_default().insert(device.to_owned(), pubkey);
        self.persist_or_rollback(account, device)
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
        let out = self.persist_or_rollback(account, new_device);
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
        if self.accounts.get(account).map_or(0, |d| d.len()) >= device_cap {
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
                self.accounts
                    .entry(account.to_owned())
                    .or_default()
                    .insert(device.to_owned(), key);
                Err(RevokeError::Persist)
            }
        }
    }

    fn persist_or_rollback(&mut self, account: &str, device: &str) -> Result<(), RegisterError> {
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                crate::logln(format!("ERROR registry 落盘失败,已回滚 {account}/{device}:{e}"));
                if let Some(devs) = self.accounts.get_mut(account) {
                    devs.remove(device);
                    if devs.is_empty() {
                        self.accounts.remove(account);
                    }
                }
                Err(RegisterError::Persist)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 封禁夹具账号(合法 26 位 ULID 形态——parse_banlist 逐行严格校验)。
    const BANNED_A: &str = "01BANNEDBANNEDBANNEDBANNED";
    const BANNED_B: &str = "02BANNEDBANNEDBANNEDBANNED";

    fn fresh(dir: &Path) -> Registry {
        let bl = dir.join("banlist.txt");
        fs::write(&bl, "# 封禁表(open-signup:准入开放,此处只放要拒的账户)\n").unwrap();
        Registry::load(&bl, dir.join("registry.json")).unwrap()
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zhujian-syncd-test-{name}-{}", std::process::id()));
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
            assert_eq!(r.set_entitlement("ACCT_A", paid.clone()), Ok(()));
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

    /// set 的拒绝面:未知账户(typo 防线)/ 空墓碑(重开 runbook 手删账户条目不许
    /// 留孤儿 entitlement,159 codex M2)/ 结构不变量(tier 形态 / seat_quota 0)。
    #[test]
    fn set_entitlement_rejects_unknown_sealed_and_bad_params() {
        let dir = tmpdir("ent-reject");
        let now = t("2026-07-19T00:00:00Z");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        assert_eq!(
            r.set_entitlement("ACCT_NOPE", Entitlement::free_default()),
            Err(SetEntitlementError::UnknownAccount)
        );
        let bad_quota = Entitlement { seat_quota: 0, ..Entitlement::free_default() };
        assert!(matches!(
            r.set_entitlement("ACCT_A", bad_quota),
            Err(SetEntitlementError::Invalid(_))
        ));
        let bad_tier = Entitlement { tier: "有 空格".into(), ..Entitlement::free_default() };
        assert!(matches!(
            r.set_entitlement("ACCT_A", bad_tier),
            Err(SetEntitlementError::Invalid(_))
        ));
        // 拒绝零副作用:仍是默认、盘上无记录。
        assert!(r.configured_entitlement("ACCT_A").is_none());
        // 空墓碑(吊光归零)拒设;account_exists 对墓碑与未知都是 false。
        r.register_first("ACCT_B", "D9", [9; 32]).unwrap();
        assert_eq!(r.revoke_device("ACCT_B", "D9"), Ok(RevokeOutcome::AccountSealed));
        assert_eq!(
            r.set_entitlement("ACCT_B", Entitlement::free_default()),
            Err(SetEntitlementError::SealedAccount)
        );
        assert!(r.account_exists("ACCT_A") && !r.account_exists("ACCT_B") && !r.account_exists("ACCT_NOPE"));
        assert_eq!(r.effective_entitlement("ACCT_B", now), Entitlement::free_default());
    }

    /// 落盘失败 = 回滚内存设置(首设回滚成「无记录」,改设回滚回旧值)。
    #[test]
    fn set_entitlement_persist_failure_rolls_back() {
        let dir = tmpdir("ent-rollback");
        let mut r = fresh(&dir);
        r.register_first("ACCT_A", "D1", [1; 32]).unwrap();
        let v1 = Entitlement { seat_quota: 4, ..Entitlement::free_default() };
        r.set_entitlement("ACCT_A", v1.clone()).unwrap();
        // registry.json 换成同名目录:save 的 rename 必败。
        fs::remove_file(dir.join("registry.json")).unwrap();
        fs::create_dir(dir.join("registry.json")).unwrap();
        let v2 = Entitlement { seat_quota: 16, ..Entitlement::free_default() };
        assert_eq!(r.set_entitlement("ACCT_A", v2), Err(SetEntitlementError::Persist));
        // 旧值仍在,未生效不装成功。
        assert_eq!(r.configured_entitlement("ACCT_A"), Some(&v1));
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
        r.set_entitlement("ACCT_A", paid).unwrap();
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
        r.set_entitlement("ACCT_A", big).unwrap();
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
