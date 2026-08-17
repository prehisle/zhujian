//! 备份配置与备份钥(backup-plan §5 / §3.4.1 第 9 格)。
//!
//! `.backup.json` 住 app 配置目录,与 `.hotkeys.json` 同族:**纯本地、不进 DB、不同步**。
//! ⛔ **core 收壳传入的路径,不自猜 app-data**(与 `spaces::WriterLease` 同一条纪律)。
//!
//! # ⛔ 与 `.hotkeys.json` **相反**的那一条:坏了必须响亮拒
//!
//! 热键读坏了退回默认键是 fail-safe(`lib.rs:3272` 明写),**备份钥不行** ——
//! 退回默认 = **当场生成一把新钥**,用户已有的全部备份文件从此**永远解不开,且没有任何提示**。
//! 所以本模块**一个 `unwrap_or_default()` 都没有**,解析失败一律 Err。
//!
//! # 原子持久化,以及它自己的那个坑
//!
//! 写配置 = 先写同目录的 `.backup.json.tmp-<ULID>`(**从创建那一刻就是 0600**)→ fsync →
//! rename 覆盖。⚠ 这里用 `rename` **是对的**:配置就该被替换。
//! (⛔ 与 §3.3 的备份文件相反 —— 那边绝不许覆盖,所以用 `O_EXCL` 直落。**两种落盘,两种原语,
//! 别互相照抄。**)
//!
//! ⭐ **`final 不存在而 temp 存在` 是一条 fatal,不是"当首次使用"**(设计审四轮 M2):
//! 首次生成钥 + 用户回输校验通过之后,若写盘恰好失败,下次启动把它当首次使用**再生成一把新钥**
//! —— 用户抄在纸上的旧码对不上这批文件,**而他不会知道**。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::BackupKey;

/// 落盘的 JSON 形。⛔ 不存 `key_id`:§4 起验钥凭据是**每文件派生**的 `key_check`,
/// 没有跨文件恒定的那一枚了(一轮 M:恒定 id = 明文里的关联句柄)。
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct OnDisk {
    /// 32 字节备份钥的十六进制。⚠ **明文** —— 这是「两人自用 + 只有手动备份 + 风险已写明」
    /// 三条前提下的取舍,不是「keychain 没有安全价值」(backup-plan §5.1,四轮 L1 收窄过)。
    key_hex: String,
    /// 备份落点目录。
    dir: String,
}

/// 读出来的配置。密钥**不出 crate**:壳拿到的只有 [`BackupSettings::dir`] 与备份码字符串。
pub(crate) struct BackupSettings {
    pub(crate) key: BackupKey,
    pub(crate) dir: PathBuf,
}

/// 配置层的失败。**每一种都要能被 UI 分开认领**(fail-fast:别退化成一句"操作失败")。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConfigError {
    /// 还没配过(首次使用)。**这不是错误**,是"该走仪式了"。
    NotConfigured,
    /// ⭐ 见模块头注:`final` 不在而 `temp` 在 —— 上次写盘死在半路。
    /// ⛔ **绝不许当首次使用重新生成钥。**
    InterruptedWrite(Vec<PathBuf>),
    /// 文件在,但读不了 / 解析不了 / 字段不合法。⛔ 不许自愈。
    Corrupt(String),
    /// IO 故障。
    Io(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::NotConfigured => write!(f, "还没设置备份"),
            ConfigError::InterruptedWrite(ps) => write!(
                f,
                "上次保存备份设置没写完({} 个半成品还在:{})——\
                 别删它们,也别重新设置(那会生成一把新钥、让已有备份再也打不开);\
                 先把配置目录恢复好",
                ps.len(),
                ps.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
            ),
            ConfigError::Corrupt(m) => write!(
                f,
                "备份设置读不了({m})。⛔ 别重新设置——那会生成一把新的备份钥,\
                 已有的备份文件将永远无法解开。先把这个文件修好或找回"
            ),
            ConfigError::Io(m) => write!(f, "读写备份设置失败:{m}"),
        }
    }
}

/// 临时文件名前缀(与 `.backup.json` **同目录**,发布靠 rename)。
const TMP_PREFIX: &str = ".backup.json.tmp-";

/// 列出同目录里的半成品。⚠ 只认**我们自己**那个前缀,别的一律不碰。
fn stale_temps(config_path: &Path) -> Result<Vec<PathBuf>, ConfigError> {
    let dir = config_path.parent().ok_or_else(|| ConfigError::Io("配置路径没有父目录".into()))?;
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        // 配置目录还不存在 = 首次使用,不是故障。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(ConfigError::Io(format!("读配置目录失败:{e}"))),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| ConfigError::Io(format!("读配置目录项失败:{e}")))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(TMP_PREFIX) {
            out.push(entry.path());
        }
    }
    out.sort();
    Ok(out)
}

/// 读配置。⛔ **没有任何一条路径会"顺手生成一把钥"** —— 生成只发生在 [`create`]。
pub(crate) fn load(config_path: &Path) -> Result<BackupSettings, ConfigError> {
    let txt = match std::fs::read_to_string(config_path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // ⭐ 四轮 M2 那一格:final 不在,但半成品在 ⇒ 上次写盘死在半路,不是首次使用。
            let temps = stale_temps(config_path)?;
            if !temps.is_empty() {
                return Err(ConfigError::InterruptedWrite(temps));
            }
            return Err(ConfigError::NotConfigured);
        }
        Err(e) => return Err(ConfigError::Io(format!("读备份设置失败:{e}"))),
    };
    let on_disk: OnDisk =
        serde_json::from_str(&txt).map_err(|e| ConfigError::Corrupt(format!("JSON 不合法:{e}")))?;
    let key = unhex32(&on_disk.key_hex)
        .ok_or_else(|| ConfigError::Corrupt("key_hex 不是 32 字节十六进制".into()))?;
    if on_disk.dir.trim().is_empty() {
        return Err(ConfigError::Corrupt("dir 为空".into()));
    }
    Ok(BackupSettings { key: BackupKey::from_bytes(key), dir: PathBuf::from(on_disk.dir) })
}

/// 把**已经生成好**的备份钥落盘。⚠ 调用方必须先走完回输校验仪式(§5)再调它。
///
/// ⭐ **生成与落盘刻意分开**(`BackupCoordinator::begin_setup` 生成、仪式过了才调这里):
/// 仪式的整个过程里那把钥只在进程内,用户中途关掉面板 = 盘上什么都没变,下次是干净的
/// 首次使用。⛔ 反过来「先落盘再让用户抄」则会留下一把**没人抄过**的钥。
///
/// ⛔ 若已经有配置,**拒**(不覆盖)—— 换钥是另一件事,得单独设计(旧备份怎么办)。
pub(crate) fn create(
    config_path: &Path,
    dir: &Path,
    key: [u8; 32],
) -> Result<BackupKey, ConfigError> {
    match load(config_path) {
        Ok(_) => return Err(ConfigError::Corrupt("已经设置过备份了,不能重复生成钥".into())),
        Err(ConfigError::NotConfigured) => {}
        Err(e) => return Err(e), // ⭐ InterruptedWrite / Corrupt 一律拦在这里
    }
    save(config_path, &OnDisk { key_hex: hex32(&key), dir: dir_string(dir)? })?;
    Ok(BackupKey::from_bytes(key))
}

/// 只改落点目录,不动钥。
pub(crate) fn set_dir(config_path: &Path, dir: &Path) -> Result<(), ConfigError> {
    let txt = std::fs::read_to_string(config_path)
        .map_err(|e| ConfigError::Io(format!("读备份设置失败:{e}")))?;
    let mut on_disk: OnDisk =
        serde_json::from_str(&txt).map_err(|e| ConfigError::Corrupt(format!("JSON 不合法:{e}")))?;
    on_disk.dir = dir_string(dir)?;
    save(config_path, &on_disk)
}

fn dir_string(dir: &Path) -> Result<String, ConfigError> {
    dir.to_str()
        .map(str::to_string)
        .ok_or_else(|| ConfigError::Io("备份目录路径不是合法 UTF-8".into()))
}

/// 原子写:同目录 temp(0600)→ fsync → rename 覆盖。
fn save(config_path: &Path, on_disk: &OnDisk) -> Result<(), ConfigError> {
    let dir = config_path.parent().ok_or_else(|| ConfigError::Io("配置路径没有父目录".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| ConfigError::Io(format!("建配置目录失败:{e}")))?;
    let tmp = dir.join(format!("{TMP_PREFIX}{}", ulid::Ulid::new()));

    let body = serde_json::to_string_pretty(on_disk)
        .map_err(|e| ConfigError::Io(format!("序列化备份设置失败:{e}")))?;

    // ⭐ **从创建那一刻就 0600**,不是写完再 chmod —— 中间那一瞬明文钥就在盘上(四轮 M2)。
    let mut f = create_private(&tmp).map_err(|e| ConfigError::Io(format!("建临时配置失败:{e}")))?;
    let write = (|| -> std::io::Result<()> {
        use std::io::Write;
        f.write_all(body.as_bytes())?;
        f.sync_all()
    })();
    drop(f);
    if let Err(e) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(ConfigError::Io(format!("写临时配置失败:{e}")));
    }
    if let Err(e) = std::fs::rename(&tmp, config_path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(ConfigError::Io(format!("发布备份设置失败:{e}")));
    }
    Ok(())
}

/// 建一个「只有本人可读写」的新文件。Unix 走 `mode(0o600)`;
/// ⚠ **Windows 侧继承 app 配置目录的 ACL,做不到等价的一行**(backup-plan §5.1 记档)。
pub(super) fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

/// 32 字节 OS CSPRNG。⛔ **失败不许兜底**(§4 的信任根):响亮 Err,不产钥、不产文件。
pub(crate) fn random_key() -> Result<[u8; 32], ConfigError> {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut k = [0u8; 32];
    chacha20poly1305::aead::OsRng
        .try_fill_bytes(&mut k)
        .map_err(|e| ConfigError::Io(format!("取随机数失败(拒绝用任何替代来源):{e}")))?;
    Ok(k)
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests;
