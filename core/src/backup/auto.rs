//! 自动备份的配置、运行痕迹与**本机产出账**(backup-plan §15,codex 设计审四弹 GO)。
//!
//! # ⛔ 三件事先说清楚,不然后面每一段都会读错
//!
//! 1. **这里没有钥**。备份钥住 `.backup.json`(`config.rs`),本模块一个字节都碰不到它 ——
//!    所以本文件的坏掉政策与那边**刚好相反**:那边坏了要劝阻用户重设(重设 = 已有备份永远
//!    打不开),这边坏了**响亮拒绝自动备份 + 允许一键重置**(里面没有不可再生的东西)。
//! 2. ⛔ **绝不给 `.backup.json` 加字段**(§15.4):`deny_unknown_fields` 是双向的,而笔①-a
//!    与笔①-b 会同一次发版出去 —— **一旦发过版**,再加字段就等于「回退一版 = 备份完全不可用」。
//! 3. ⭐ **账(ledger)是本模块存在的核心**,不是顺手记的日志:它同时承担三件事 ——
//!    「**这份是不是我(本机、自动)产的**」「**它们的真实产出先后**」「**盘上那个名字底下
//!    还是不是我记的那一份**」。轮转的删除授权**只**来自它。
//!
//! # ⛔ 轮转为什么长这样(四轮设计审逐条打出来的,别"简化")
//!
//! | 当时形 | 反例 | 现行形 |
//! |---|---|---|
//! | 扫目录 + 按文件名匹配 | 手动与自动**共用同一个命名规则**,trailer 里既没来源也没机器身份 ⇒ 删掉用户 purge 前手动存的 checkpoint;两台机器备到同一网盘目录**互删** | 只删**账里**的 |
//! | 按文件名时间戳排序 | 系统时钟回拨 ⇒ 「唯一含救命数据的那份」名字看起来最旧被删,**而它验得过**;⛔ 全解一遍也治不了(trailer 的 `created_at` 同样来自墙钟) | 按账里的 `seq` |
//! | 只处理「超出 keep 的那几项」 | 留下的那 `keep` 份**自己可能是坏的 / 被搬走的** ⇒ 坏项占着名额,有效的旧恢复点被挤掉 | **逐项验到凑够 `keep` 份有效** |
//! | `{file, seq}` 就够 | §4 自己写着「整份文件被另一份合法文件替换,自包含格式识别不了」⇒ 同名换成另一份**同钥同空间**的手动备份,两道全过而被删 | 账里存 **salt 指纹** + **canonical 目录** |
//! | 本趟新产物免验计 1 | 自验发生在备份返回**之前**,而那之后文件**已经对外可见**(`Admitted` 只排除朱简自己的并发,挡不住网盘客户端)⇒ 新产物被截断时,计数会在一份"较新的空库"处凑够,把唯一有效的旧份删掉 | **当前产物也走四道**;不过就**零删除** |

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use super::config::create_private;
use super::engine::MadeBackup;
use super::{BackupKey, ReadError, SALT_LEN};

/// 每天一次。
pub(crate) const DEFAULT_EVERY_MINUTES: u32 = 1440;
/// 每空间保留最近 3 份(用户 2026-08-17 当面拍)。
pub(crate) const DEFAULT_KEEP: u32 = 3;
/// ⛔ **`keep` 的下界是 2,不是 1**(设计审 H4):当前产物固定不删 ⇒ `keep ≤ 1` 等于
/// 「每趟把该空间的历史删光」,而**新产物可能正是 purge 之后的空库** —— 那一趟就把删库前
/// 最后一个恢复点清掉了,与本功能的动机(防删库跑路)正好相反。
pub(crate) const MIN_KEEP: u32 = 2;

const TMP_PREFIX: &str = ".backup-auto.json.tmp-";

// ---- 盘上的形 ---------------------------------------------------------------------

/// 账里的一条:**本机、自动**产出的一份备份。
///
/// ⭐ 四个字段各自承重,少一个就有一条真实的误删路径(见模块头注那张表)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LedgerEntry {
    /// **严格 basename**(不含任何路径分隔符),且必须符合本空间的产物命名形。
    pub file: String,
    /// 产出当时 `made.path` 父目录的 **canonical** 形。
    /// ⛔ **后续只 canonicalize 本趟目录去比它,绝不重新解释这里存的路径** ——
    /// 反例:产出时 `/link → A`,后来 `/link → B`,两边都重新解析会**双双得到 B**,
    /// 于是旧 A 的 cohort 被错误授权到 B 上(设计审三弹 M1)。
    pub dir: String,
    /// 那份文件 header 里的 16 字节 salt(十六进制),= **身份指纹**。
    pub salt: String,
    /// 产出序号,**单调递增、与墙钟无关** —— 「真实产出先后」的唯一真相源。
    pub seq: u64,
}

/// `.backup-auto.json` 的全部内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AutoFile {
    /// ⛔ 默认**关**:仪式跑完 ≠ 用户同意后台每天往磁盘写东西。
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_every")]
    pub every_minutes: u32,
    #[serde(default = "default_keep")]
    pub keep: u32,
    #[serde(default)]
    pub next_seq: u64,
    /// 上次**成功**(`made` 非空)那一趟的 UTC 时刻。墙钟那把尺读它。
    #[serde(default)]
    pub last_success_at: Option<String>,
    /// 上次那一趟的人话结论(⭐ **持久**,设计审四弹 M2:轮转停滞这种事不能只靠
    /// 每进程只弹一次的 banner)。
    #[serde(default)]
    pub last_result: Option<String>,
    /// `space_id → 本机自动产出账`。
    #[serde(default)]
    pub ledger: BTreeMap<String, Vec<LedgerEntry>>,
}

fn default_every() -> u32 {
    DEFAULT_EVERY_MINUTES
}
fn default_keep() -> u32 {
    DEFAULT_KEEP
}

impl Default for AutoFile {
    fn default() -> AutoFile {
        AutoFile {
            enabled: false,
            every_minutes: DEFAULT_EVERY_MINUTES,
            keep: DEFAULT_KEEP,
            next_seq: 0,
            last_success_at: None,
            last_result: None,
            ledger: BTreeMap::new(),
        }
    }
}

/// 本模块的失败。⛔ **每一种都要让自动备份停下来并显红**,不许静默按默认值跑 ——
/// 那会把用户「我关掉了自动备份」的意思悄悄改回"开着"。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AutoError {
    /// 读不了 / 解析不了。
    Corrupt(String),
    /// 解析得开,但值越界(合法域见 [`AutoFile::validate`])。
    Invalid(String),
    /// IO 故障。
    Io(String),
}

impl std::fmt::Display for AutoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AutoError::Corrupt(m) => write!(
                f,
                "自动备份设置读不了({m})——自动备份已停下。手动备份不受影响;\
                 这个文件里没有备份钥,确认无误后可以直接重置它"
            ),
            AutoError::Invalid(m) => write!(
                f,
                "自动备份设置里有不合法的值({m})——自动备份已停下,一个文件都没产、也没删"
            ),
            AutoError::Io(m) => write!(f, "读写自动备份设置失败:{m}"),
        }
    }
}

impl AutoFile {
    /// ⛔ **合法域一次判完,任一不过 = 响亮拒绝自动备份、零产物零删除**(设计审 H4 + M1)。
    /// 判据:这个文件是**可手改**的,而账一旦出现重复 / 回退的 `seq`,
    /// 「真实产出顺序」这条根就没了。
    pub(crate) fn validate(&self) -> Result<(), AutoError> {
        let bad = |m: String| Err(AutoError::Invalid(m));
        if self.every_minutes < 1 {
            return bad("every_minutes 至少是 1".into());
        }
        if self.keep < MIN_KEEP {
            return bad(format!(
                "keep 至少是 {MIN_KEEP}(留 1 份等于每次把该空间的历史删光,\
                 而新产出那份可能恰好是数据被删之后的空库)"
            ));
        }
        let mut seen_files: BTreeMap<(&str, &str), &str> = BTreeMap::new();
        for (space_id, entries) in &self.ledger {
            let mut seqs = std::collections::BTreeSet::new();
            for e in entries {
                if !is_plain_basename(&e.file) {
                    return bad(format!("账里的文件名不是单纯的文件名:{}", e.file));
                }
                if !file_belongs_to_space(&e.file, space_id) {
                    return bad(format!(
                        "账里的 {} 不符合空间 {space_id} 的备份文件命名形",
                        e.file
                    ));
                }
                if unhex_salt(&e.salt).is_none() {
                    return bad(format!("账里 {} 的 salt 不是 {SALT_LEN} 字节十六进制", e.file));
                }
                if e.dir.trim().is_empty() {
                    return bad(format!("账里 {} 没有落点目录", e.file));
                }
                if !seqs.insert(e.seq) {
                    return bad(format!("空间 {space_id} 的账里 seq {} 重复了", e.seq));
                }
                if e.seq >= self.next_seq {
                    return bad(format!(
                        "账里 seq {} 不小于 next_seq {} —— 序号回退过,产出先后不可信了",
                        e.seq, self.next_seq
                    ));
                }
                // ⛔ 同一份文件(同目录同名)不许在两个空间的账里各记一次:
                // 那样两边会各自按自己的 keep 去处置它。
                if let Some(other) = seen_files.insert((e.dir.as_str(), e.file.as_str()), space_id)
                {
                    if other != space_id {
                        return bad(format!("{} 同时记在空间 {other} 与 {space_id} 名下", e.file));
                    }
                    return bad(format!("{} 在同一个空间的账里出现了两次", e.file));
                }
            }
        }
        Ok(())
    }
}

/// 「是不是一个单纯的文件名」——⛔ 不许有任何路径成分。
fn is_plain_basename(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && Path::new(name).file_name().map(|f| f == std::ffi::OsStr::new(name)).unwrap_or(false)
}

/// 严格匹配 `engine::file_name_for` 那个形:`zhujian-<空间 id 前 8>-<YYYYMMDDTHHMMSSZ>-<26 位 ULID>.zjbak`。
///
/// ⚠ **它只是候选集的第一道**,⛔ 绝不是「这是一份有效备份」的判据(§3.3 那条通用纪律):
/// 承重的是账 + 全量验证 + trailer 的 `space_id` + salt 指纹。
fn file_belongs_to_space(name: &str, space_id: &str) -> bool {
    let Some(rest) = name.strip_suffix(".zjbak") else { return false };
    let Some(rest) = rest.strip_prefix("zhujian-") else { return false };
    let parts: Vec<&str> = rest.split('-').collect();
    if parts.len() != 3 {
        return false;
    }
    let short: String = space_id.chars().take(8).collect();
    if parts[0] != short {
        return false;
    }
    let stamp = parts[1].as_bytes();
    if stamp.len() != 16 || stamp[8] != b'T' || stamp[15] != b'Z' {
        return false;
    }
    if !stamp[..8].iter().chain(&stamp[9..15]).all(|c| c.is_ascii_digit()) {
        return false;
    }
    crate::spaces::is_ulid_name(parts[2])
}

fn hex_salt(b: &[u8; SALT_LEN]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex_salt(s: &str) -> Option<[u8; SALT_LEN]> {
    if s.len() != SALT_LEN * 2 {
        return None;
    }
    let mut out = [0u8; SALT_LEN];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

// ---- 读写 ---------------------------------------------------------------------------

/// 读。**文件不在 = 从没开过自动备份**(默认值,`enabled = false`),⛔ 这不是错误 ——
/// 与 `.backup.json` 的 `NotConfigured` 是两回事:那边"没配过"意味着还没有钥,这边只意味着
/// 用户从没打开过这个开关。
///
/// ⭐ **半截 temp 直接删**(⛔ 与 `.backup.json` 的 `InterruptedWrite` fatal **相反**):
/// 判据不是"要不要谨慎",是**里面有没有不可再生的东西** —— 这里没有钥;而且本模块的所有
/// 读写都在 `BackupCoordinator` 的临界区内做(§15.4),盘上不可能有两个写者 ⇒ 看到 temp
/// 就**确定**是死进程留下的(设计审二弹 M3)。
pub(crate) fn load(path: &Path) -> Result<AutoFile, AutoError> {
    sweep_temps(path);
    let txt = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AutoFile::default()),
        Err(e) => return Err(AutoError::Io(format!("读自动备份设置失败:{e}"))),
    };
    let file: AutoFile = serde_json::from_str(&txt)
        .map_err(|e| AutoError::Corrupt(format!("JSON 不合法或有不认识的字段:{e}")))?;
    file.validate()?;
    Ok(file)
}

fn sweep_temps(path: &Path) {
    let Some(dir) = path.parent() else { return };
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        if entry.file_name().to_str().is_some_and(|n| n.starts_with(TMP_PREFIX)) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// 显式故障注入:让**下一次** `save` 报「写不进去」(用完即自动复位)。
// ⛔ `cfg(test)` 门控,发版二进制里一个字节都没有(与 `staging::FAIL_CLEANUP` 同形)。
// ⭐ 它测的是设计审 H5 那条:**结论写不进盘时,失败不能只写进那个刚写失败的文件**。
#[cfg(test)]
thread_local! {
    pub(crate) static FAIL_SAVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 原子写:同目录 temp(**从创建那一刻就 0600**)→ fsync → rename 覆盖。
///
/// ⚠ 这里用 `rename` 覆盖**是对的**(设置就该被替换),⛔ 与备份产物那边的 `O_EXCL` 直落
/// 刚好相反 —— 两种落盘、两种原语,别互相照抄。
pub(crate) fn save(path: &Path, file: &AutoFile) -> Result<(), AutoError> {
    #[cfg(test)]
    if FAIL_SAVE.with(|c| c.replace(false)) {
        return Err(AutoError::Io("(测试注入)写不进自动备份设置".into()));
    }
    let dir = path.parent().ok_or_else(|| AutoError::Io("配置路径没有父目录".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| AutoError::Io(format!("建配置目录失败:{e}")))?;
    let tmp = dir.join(format!("{TMP_PREFIX}{}", ulid::Ulid::new()));
    let body = serde_json::to_string_pretty(file)
        .map_err(|e| AutoError::Io(format!("序列化自动备份设置失败:{e}")))?;
    let mut f =
        create_private(&tmp).map_err(|e| AutoError::Io(format!("建临时设置失败:{e}")))?;
    let wrote = (|| -> std::io::Result<()> {
        use std::io::Write;
        f.write_all(body.as_bytes())?;
        f.sync_all()
    })();
    drop(f);
    if let Err(e) = wrote {
        let _ = std::fs::remove_file(&tmp);
        return Err(AutoError::Io(format!("写临时设置失败:{e}")));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AutoError::Io(format!("发布自动备份设置失败:{e}")));
    }
    Ok(())
}

// ---- due 判定 -----------------------------------------------------------------------

/// 墙钟那把尺:距上次**成功**够不够一个间隔。
///
/// ⭐ `last_success` 落在**未来**(系统时钟被改 / 时区错乱)⇒ **判 due** —— 方向选安全那侧
/// (多备一份 ≠ 数据损失);频率由**单调钟**那把尺压住(见 `BackupCoordinator`),
/// ⛔ 只有一把尺时这里会变成"每 60 秒备一次"。
pub(crate) fn due(now: OffsetDateTime, last: Option<OffsetDateTime>, every_minutes: u32) -> bool {
    match last {
        None => true,
        Some(t) => now < t || (now - t) >= Duration::minutes(i64::from(every_minutes)),
    }
}

/// 墙钟那把尺该不该往前走 —— ⭐ **判据是「这一趟至少备成了一个空间」**(§15.2 那张表)。
///
/// ⛔ 与「有没有 `failed` / `fatal`」无关:它是**「多久备一次」的尺,不是「有没有出错」的尺**。
/// 部分成功也更新 —— 否则一个空间失败就会让整台机器**每次重启都整批重跑**,而那个空间
/// 下一趟多半照旧失败。代价(失败的那个空间要等下一个间隔)由 UI 上看得见的失败原因兜着,
/// 用户等不及可以点「立即备份」。
pub(crate) fn wall_clock_should_advance(made: usize) -> bool {
    made > 0
}

pub(crate) fn parse_stamp(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

pub(crate) fn stamp_now() -> String {
    OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()
}

// ---- 轮转 ---------------------------------------------------------------------------

/// 一个空间这一趟的轮转结果。⭐ **四类各自成格**:UI 要把它们分开显示,
/// ⛔ 别收成一句"清理完成"。
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RotationReport {
    /// 真删掉的旧备份。
    pub removed: Vec<String>,
    /// **摘账**了(从此不再自动管):已证明无效 / 身份不符 / 落点改过。
    pub unmanaged: Vec<(String, String)>,
    /// **留账下轮再试**:瞬时 IO / 删不掉 / 读不到文件身份。
    pub retry: Vec<(String, String)>,
    /// `Some` = **本空间这一轮零删除**(当前产物复验没过 / 目录解析不出来)。
    pub stalled: Option<String>,
}

impl RotationReport {
    pub(crate) fn is_quiet(&self) -> bool {
        self.unmanaged.is_empty() && self.retry.is_empty() && self.stalled.is_none()
    }
}

// 测试注入:在轮转的两个关键时刻各停一下,让测试改动盘上的东西。
// ⛔ `cfg(test)` 门控 —— 发版二进制里一个字节都没有(与 `staging::FAIL_CLEANUP` 同形);
// ⭐ 设计审二弹/三弹点名要用它:那两个窗口(自验后→轮转前、verify→delete)靠别的办法命不中。
#[cfg(test)]
thread_local! {
    // 当前产物**验之前**跑一次(造「自验之后、轮转之前文件被换掉」那个窗口)。
    pub(crate) static BEFORE_CURRENT_VERIFY: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        const { std::cell::RefCell::new(None) };
    // 某个待删项**验过之后、取第二次文件身份之前**跑一次(verify→delete 的 TOCTOU 窗口)。
    pub(crate) static BEFORE_DELETE: std::cell::RefCell<Option<Box<dyn FnMut(&Path)>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn hook_before_current_verify() {
    BEFORE_CURRENT_VERIFY.with(|h| {
        if let Some(f) = h.borrow_mut().as_mut() {
            f()
        }
    });
}
#[cfg(not(test))]
fn hook_before_current_verify() {}

#[cfg(test)]
fn hook_before_delete(p: &Path) {
    BEFORE_DELETE.with(|h| {
        if let Some(f) = h.borrow_mut().as_mut() {
            f(p)
        }
    });
}
#[cfg(not(test))]
fn hook_before_delete(_p: &Path) {}

/// 四道判定的结论(§15.3 规则 5 + 四弹 M1 的三档分流)。
enum Check {
    /// 在、解得开、`space_id` 相符、salt 相符。
    Valid,
    /// 文件不在了 —— 静静摘账,不报。
    Gone,
    /// **已证明**内容或身份无效 ⇒ 摘账 + 报。
    Invalid(String),
    /// **瞬时** IO ⇒ 留账下轮再试 + 报。
    Transient(String),
}

/// 四道:①在 ②全量解得开 ③trailer 的 `space_id` 恰等本空间 ④header 的 salt 恰等账里那枚。
fn check(path: &Path, space_id: &str, want_salt: [u8; SALT_LEN], key: &BackupKey) -> Check {
    match super::verify_file(path, key) {
        Err(ReadError::Missing) => Check::Gone,
        Err(ReadError::Io(m)) => Check::Transient(m),
        Err(e) => Check::Invalid(e.to_string()),
        Ok(v) if v.trailer.space_id != space_id => Check::Invalid(format!(
            "它里面记的空间是 {},不是 {space_id}",
            v.trailer.space_id
        )),
        Ok(v) if v.salt != want_salt => Check::Invalid(
            "这个名字底下已经不是我备出来的那一份了(文件身份变了)——不再自动管它".into(),
        ),
        Ok(_) => Check::Valid,
    }
}

/// 跑一个空间的轮转。**调用方必须持着本趟备份的那把 `Admitted`**(§15.3 规则 2)。
///
/// ⭐ 目录**只从本趟产物取**,⛔ 不重读配置 —— 否则「备份落 A、返回后用户改到 B、轮转拿 A 的
/// 成功授权删 B 里的文件」(设计审一弹 H1)。
pub(crate) fn rotate_space(
    file: &mut AutoFile,
    space_id: &str,
    made: &MadeBackup,
    key: &BackupKey,
) -> RotationReport {
    let mut out = RotationReport::default();
    let keep = file.keep as usize;

    let Some(parent) = made.path.parent() else {
        out.stalled = Some("备份产物没有父目录,这一轮不清理任何东西".into());
        return out;
    };
    let dir_canon = match std::fs::canonicalize(parent) {
        Ok(p) => p,
        Err(e) => {
            out.stalled = Some(format!(
                "认不出备份目录的真实位置({e}),这一轮不清理任何东西"
            ));
            return out;
        }
    };
    let Some(name) = made.path.file_name().and_then(|n| n.to_str()) else {
        out.stalled = Some("备份产物的文件名不是合法 UTF-8,这一轮不清理任何东西".into());
        return out;
    };

    // 本趟产物先入账(⭐ 即便下面复验不过也要入账:否则下一轮没人管它)。
    let seq = file.next_seq;
    file.next_seq = match file.next_seq.checked_add(1) {
        Some(n) => n,
        None => {
            out.stalled = Some("产出序号溢出了,这一轮不清理任何东西".into());
            return out;
        }
    };
    let entries = file.ledger.entry(space_id.to_string()).or_default();
    entries.push(LedgerEntry {
        file: name.to_string(),
        dir: dir_canon.display().to_string(),
        salt: hex_salt(&made.salt),
        seq,
    });

    // ---- 当前产物也走一遍四道(⛔ 三弹 H1:自验发生在备份返回之前,那之后文件已经对外可见)
    hook_before_current_verify();
    match check(&made.path, space_id, made.salt, key) {
        Check::Valid => {}
        other => {
            let why = match other {
                Check::Gone => "刚备好的那份文件已经不在了".to_string(),
                Check::Invalid(m) | Check::Transient(m) => {
                    format!("刚备好的那份文件复验没过:{m}")
                }
                Check::Valid => unreachable!(),
            };
            // ⛔ **立即终止本空间的轮转,连旧账都不再扫**(四弹 M2:最容易审计的「零删除」保证)。
            out.stalled = Some(format!("{why} —— 这一轮一个旧备份都没清理"));
            return out;
        }
    }

    // ---- 从新到旧逐项验,凑够 keep 份「有效」之后再遇到的有效项才可删 ----------------
    let mut valid = 1usize; // 当前产物(刚验过)
    let mut kept: Vec<LedgerEntry> = Vec::new();
    let entries = file.ledger.entry(space_id.to_string()).or_default();
    let mut rest: Vec<LedgerEntry> = std::mem::take(entries);
    rest.sort_by(|a, b| b.seq.cmp(&a.seq)); // 新 → 旧
    for e in rest {
        if e.seq == seq {
            kept.push(e); // 当前产物那条,已计数,不再处置
            continue;
        }
        // cohort:落点改过之后,旧目录那些条目摘账 + 报(⛔ 不删:我们没有在那个目录里的授权)
        if e.dir != dir_canon.display().to_string() {
            out.unmanaged.push((
                format!("{}/{}", e.dir, e.file),
                "备份落点改过了,旧目录里的这份从此归你自己管".into(),
            ));
            continue;
        }
        let path = dir_canon.join(&e.file);
        let Some(want) = unhex_salt(&e.salt) else {
            // validate() 已经挡过;真到这儿说明账被改坏了,保守处置:不删、摘账。
            out.unmanaged.push((path.display().to_string(), "账里的指纹读不出来".into()));
            continue;
        };
        match check(&path, space_id, want, key) {
            Check::Gone => {} // 静静摘账
            Check::Transient(m) => {
                out.retry.push((path.display().to_string(), m));
                kept.push(e);
            }
            Check::Invalid(m) => out.unmanaged.push((path.display().to_string(), m)),
            Check::Valid => {
                if valid < keep {
                    valid += 1;
                    kept.push(e);
                    continue;
                }
                match delete_verified(&path) {
                    Ok(true) => out.removed.push(path.display().to_string()),
                    Ok(false) => {} // 删的时候已经不在了 —— 摘账即可
                    Err(m) => {
                        out.retry.push((path.display().to_string(), m));
                        kept.push(e);
                    }
                }
            }
        }
    }
    kept.sort_by_key(|e| e.seq);
    *file.ledger.entry(space_id.to_string()).or_default() = kept;
    out
}

/// 删一份**刚刚验过**的旧备份。
///
/// ⭐ **删之前再取一次文件身份,与验之前那次比**(设计审二弹 H2 的 TOCTOU):验完到
/// `remove_file` 之间那个文件可能被换掉。⛔ **取身份本身失败也一律不删**(四弹 M1):
/// 读不到身份是**瞬时 IO 故障**的形,不是"这份文件不是我的"的证据 —— 留账下轮再试。
///
/// ⚠ **诚实边界:这只把窗口收窄到极小,消灭不了它** —— `native_file_key` 是「打开-取值-关闭」
/// 不持句柄,而 `remove_file` 走的仍是路径;Unix 没有通用的"按 fd 删"。v1 照实记录。
fn delete_verified(path: &Path) -> Result<bool, String> {
    let before = crate::spaces::native_file_key(path)?;
    hook_before_delete(path);
    let now = crate::spaces::native_file_key(path)?;
    if now != before {
        return Err("正要删的时候这个文件被换掉了 —— 没有删它".into());
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("删不掉:{e}")),
    }
}

#[cfg(test)]
mod tests;
