//! 空间(space)= 账户 = 独立同步流 = 独立库文件——「存在与身份」的共享层
//! (multispace-plan §2/§3/§5/§10/§13,工序 2+3;97 桌面壳 spaces.rs 上抬至此,
//! 桌面/安卓两壳共用)。**编排不在这里**:live 会话(开库/起停 transport)归
//! `sync::supervisor`,策略(桌面不设上限、手机同刻单活跃)归各壳。
//!
//! - **发现**:主库 `notebook.sqlite3` 是单列保留项(space_id = "main");同目录
//!   其余库只认严格 ULID 白名单 `<26 位 Crockford>.sqlite3`——boot 崩溃残留、备份
//!   副本、`-wal`/`-shm`、建库暂存 `.creating-*` 一概不认。
//! - **跨库身份四不变量**:space_id / 物理文件 / device_id / account_id 全局唯一,
//!   违者响亮拒(服务器只会把同库两开当「同设备重连」互 kick,不会替你发现;
//!   origin_seq 取号竞争必须在壳层挡)。
//! - **只读描述符(exact-match)**:catalog 扫描用只读连接读身份摘要,**绝不能用
//!   `db::open`**(它读写 + 切 WAL + 跑迁移);`user_version` 必须恰为当前版本——
//!   本版本不迁移旧库「尽量救活」,版本不符 = 清库重配(§10/§19,本地可丢前提)。
//! - **严格聚合器 `SpaceCatalog::load`(工序 6 首件)**:整目录「全部候选成功或
//!   整体 Err」,手机壳的唯一入口(§2.1 fail-closed;桌面 eager 开库路径另有
//!   容忍政策,不走它)。
//! - **单写者租约**:目录级 OS 排他锁,防第二个进程绕过 app 层单实例门双写
//!   (HLC 回退 / origin_seq 争号 / 同 device_id 互顶,毒都在「双写者」)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags};

use crate::clock::Clock;
use crate::db;

/// 主库(第一空间)的固定 space_id。非 ULID 形态,与文件名空间永不相撞。
pub const MAIN_SPACE: &str = "main";

/// 严格 ULID 文件名白名单:恰 26 字符、全部落在 Crockford base32 大写字母表
/// (0-9 与 A-Z 去 I/L/O/U),且首字符 ≤ '7'(ULID 128 bit,首字符只承载 3 bit
/// ——"8".."Z" 开头是数值溢出的非法串)。刻意不走解析库——那些按规范容错
/// 小写/混淆字符,白名单要的是「我们自己生成的规范形态」,其余(含手工改名)一概不认。
pub fn is_ulid_name(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 26
        && matches!(b[0], b'0'..=b'7')
        && b.iter().all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z'))
}

/// 发现空间库文件:主库恒在列(单列保留项、恒排第一);`scan_dir` 下只认
/// `<严格 ULID>.sqlite3`,按文件名排序(ULID 字典序 = 创建序,显示序稳定)。
/// `scan_dir = None` = e2e/YS_DB_PATH 模式:禁扫生产空间,只有主库。
/// `max_spaces = Some(n)`:发现数超过 n = Err(调用方响亮拒启,不静默截断;
/// 两壳当前都传 None(不设发现上限)——桌面 109 决定①去了硬限、手机本就无上限)。
pub fn discover(
    main_db: &Path,
    scan_dir: Option<&Path>,
    max_spaces: Option<usize>,
) -> Result<Vec<(String, PathBuf)>, String> {
    let mut found = vec![(MAIN_SPACE.to_string(), main_db.to_path_buf())];
    if let Some(dir) = scan_dir {
        let mut extra: Vec<(String, PathBuf)> = Vec::new();
        let entries = std::fs::read_dir(dir).map_err(|e| format!("读空间目录失败 {}:{e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读空间目录项失败:{e}"))?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(stem) = name.strip_suffix(".sqlite3") else { continue };
            if !is_ulid_name(stem) {
                continue;
            }
            extra.push((stem.to_string(), entry.path()));
        }
        extra.sort_by(|a, b| a.0.cmp(&b.0));
        found.extend(extra);
    }
    if let Some(max) = max_spaces {
        if found.len() > max {
            let names: Vec<&str> = found.iter().map(|(id, _)| id.as_str()).collect();
            return Err(format!(
                "发现 {} 个空间库,超过本版本上限 {}:{}。多出的库文件不是本版本创建的——请把多余的 <ULID>.sqlite3 移出数据目录再启动",
                found.len(),
                max,
                names.join(", ")
            ));
        }
    }
    Ok(found)
}

// ---- 物理文件身份(multispace-plan §13) ----

/// 平台原生物理文件标识:同一物理文件的任何名字(symlink **和 hardlink**)归一到
/// 同一 key——canonicalize 只解析 symlink、归一不了 hardlink,故相等判定用文件系统
/// 身份不用路径字符串。**可复制的值**(catalog descriptor 可长期持有,不占打开的
/// 文件句柄);不支持的平台 fail closed,不得降级 canonicalize。
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct NativeFileKey {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(windows)]
    volume: u64,
    #[cfg(windows)]
    index: u64,
}

/// 现算一枚物理文件身份(打开-取-关,不驻留句柄)。
pub fn native_file_key(path: &Path) -> Result<NativeFileKey, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::metadata(path)
            .map_err(|e| format!("读文件身份失败 {}:{e}", path.display()))?;
        Ok(NativeFileKey { dev: m.dev(), ino: m.ino() })
    }
    #[cfg(windows)]
    {
        let f = std::fs::File::open(path)
            .map_err(|e| format!("读文件身份失败 {}:{e}", path.display()))?;
        let info = winapi_util::file::information(&f)
            .map_err(|e| format!("读文件身份失败 {}:{e}", path.display()))?;
        Ok(NativeFileKey {
            volume: info.volume_serial_number(),
            index: info.file_index(),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err("此平台不支持物理文件身份判定(fail closed,不降级 canonicalize)".into())
    }
}

// ---- 身份四不变量 ----

/// 一个空间的身份三元组 + id(四不变量的输入;每次校验现读,不存快照防腐)。
pub struct SpaceIdentity {
    pub id: String,
    pub file: NativeFileKey,
    pub device_id: String,
    pub account_id: Option<String>,
}

/// 从一条活的库连接上现读身份三元组(文件身份现算)。
pub fn read_identity(id: &str, path: &Path, conn: &Connection, clock: &Clock) -> Result<SpaceIdentity, String> {
    Ok(SpaceIdentity {
        id: id.to_string(),
        file: native_file_key(path)?,
        device_id: clock.device_id().to_string(),
        account_id: crate::sync::transport::account_id(conn)?,
    })
}

/// 身份裁决的两级结论(「违者响亮拒启 transport」的实现精化)。携带的字符串是
/// **纯诊断**(撞了什么、为什么毒);**处置话术归策略层**——桌面容忍(Hard=不装载
/// 陈列、Soft=停同步本地照用,壳拼接各自的后缀),手机严格 catalog 一律整体拒
/// ([`SpaceCatalog::load`],处置=清库重配)。诊断与处置若焊死在一起,两种政策
/// 必有一种在对用户说错话。
pub enum Veto {
    /// 同一物理库的第二个名字(symlink/硬链接):**不装载**。第二条连接 + 第二只
    /// 同 device_id 的时钟会破坏「进程内单写者取号」——连本地写都不能给,不只是停同步。
    Hard(String),
    /// 独立库但身份撞(整库复制的同 device_id / 同账户):毒性都在上通道那一刻
    /// (同 origin 双流 / 同信箱互灌),本地数据本身无害——桌面据此只停同步。
    Soft(String),
}

/// 跨库身份四不变量纯校验:按列表序先到先得,后来者与已接受者相撞 = veto
/// (主库恒排第一 = 永不被 veto);被 veto 者不占坑(一个死空间不连坐后来者)。
/// space_id 唯一性由发现层(文件名 + main 保留字)保证,这里只兜底断言。
pub fn identity_vetoes(all: &[SpaceIdentity]) -> HashMap<String, Veto> {
    let mut vetoes = HashMap::new();
    let mut seen_file: HashMap<NativeFileKey, &str> = HashMap::new();
    let mut seen_device: HashMap<&str, &str> = HashMap::new();
    let mut seen_account: HashMap<&str, &str> = HashMap::new();
    let mut seen_id: HashMap<&str, ()> = HashMap::new();
    for s in all {
        assert!(seen_id.insert(&s.id, ()).is_none(), "space_id 重复:{}(发现层失守)", s.id);
        if let Some(prev) = seen_file.get(&s.file) {
            vetoes.insert(
                s.id.clone(),
                Veto::Hard(format!(
                    "与「{prev}」实际是同一个库文件(符号链接/硬链接?)——同库两开会破坏写入次序"
                )),
            );
            continue;
        }
        if let Some(prev) = seen_device.get(s.device_id.as_str()) {
            vetoes.insert(
                s.id.clone(),
                Veto::Soft(format!(
                    "此空间与「{prev}」的设备身份(device_id)相同——库文件是整库复制出来的?两库同身份上线会互相顶替、历史分叉"
                )),
            );
            continue;
        }
        if let Some(acc) = s.account_id.as_deref() {
            if let Some(prev) = seen_account.get(acc) {
                vetoes.insert(
                    s.id.clone(),
                    Veto::Soft(format!(
                        "此空间与「{prev}」配的是同一个同步账户——空间=账户,一空间一账户"
                    )),
                );
                continue;
            }
            seen_account.insert(acc, &s.id);
        }
        seen_file.insert(s.file, &s.id);
        seen_device.insert(&s.device_id, &s.id);
    }
    vetoes
}

// ---- 只读描述符(multispace-plan §2 两层模型的 catalog 层) ----

/// 一个空间的 catalog 摘要:身份 + 显示名,全是**可复制的值**(不持库连接/文件句柄)。
/// 手机端非当前空间只留这一层;激活 runtime 时须重算 [`native_file_key`] 与此比对
/// (防运行期文件被替换)。
#[derive(Debug, Clone)]
pub struct SpaceDescriptor {
    pub id: String,
    pub path: PathBuf,
    pub name: Option<String>,
    pub device_id: String,
    pub account_id: Option<String>,
    pub file: NativeFileKey,
}

/// 严格 catalog 检查里「schema 恰为当前版本」不能只信一个可手改的版本号——
/// 这些核心表必须全部在场(触发器/索引级差异会在真用时响亮,但「壳子库谎称
/// 当前版」这种整层缺失要在 catalog 就拒)。
const CORE_TABLES: &[&str] = &[
    "items",
    "topics",
    "item_topic",
    "item_revisions",
    "item_image",
    "item_image_counter",
    "sync_meta",
    "oplog",
    // 0022 的回放豁免单行标志表:items/item_image 的多只写保护触发器查询它,
    // 缺了 = 第一笔业务写就炸(catalog 就要拒,不许拖到写入时)。
    "sync_replay_active",
    // 0028 的空间 profile 物化单行表(空间名跨端同步的状态侧)。
    "space_profile",
];

/// 只读读取一个空间的描述符:**不跑迁移、不写库、不切 WAL**(`db::open` 是读写
/// 打开,catalog 扫描绝不能用它)。检查:可打开 → `user_version` 恰为当前版本
/// (§10 exact-match)→ 核心表全在(版本号声称不算数)→ 设备身份在且为规范
/// ULID → 同步配置要么零键要么四键全有(半套配置不许溜过 catalog、拖到 transport
/// 才炸)→ 现算文件身份。任一失败 = Err;严格 catalog(fail-closed)语境下调用方
/// 应整体拒绝正常启动并提示清库重配,不做「部分可用」。
pub fn read_descriptor(id: &str, path: &Path) -> Result<SpaceDescriptor, String> {
    // TOCTOU 双检(前半):开库前先取一次物理身份;读取全部完成后再取一次,
    // 不等 = 路径在读取途中被换,descriptor 会混合旧库元数据与新文件 key——整体拒。
    let key_before = native_file_key(path)?;
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("空间 {id} 库打不开(只读){}:{e}", path.display()))?;
    let uv: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| format!("空间 {id} 读 user_version 失败:{e}"))?;
    // 版本分流(codex 设计审 H3):太新 = 只能升级程序,**绝不劝清库**(清了新数据
    // 就没了);太旧 = 启动预处理应已前滚(prepare_mobile_catalog),仍见旧版说明
    // 库在预处理后被换过等异常。
    if uv > db::SCHEMA_VERSION {
        return Err(format!(
            "空间 {id} 的数据版本({uv})比本程序({})新——请安装新版朱笺;不要清除数据",
            db::SCHEMA_VERSION
        ));
    }
    if uv != db::SCHEMA_VERSION {
        return Err(format!(
            "空间 {id} 的数据版本({uv})与本程序({})不符——库未经启动升级(扫描途中被替换?),请清本地数据后重新配对",
            db::SCHEMA_VERSION
        ));
    }
    let placeholders = vec!["?"; CORE_TABLES.len()].join(",");
    let n: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ({placeholders})"),
            rusqlite::params_from_iter(CORE_TABLES.iter()),
            |r| r.get(0),
        )
        .map_err(|e| format!("空间 {id} 读表清单失败:{e}"))?;
    if n != CORE_TABLES.len() as i64 {
        return Err(format!(
            "空间 {id} 缺核心表({n}/{})——库结构残缺(版本号却声称当前),请清本地数据后重新配对",
            CORE_TABLES.len()
        ));
    }
    let meta = |key: &str| -> Result<Option<String>, String> {
        use rusqlite::OptionalExtension;
        conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .map_err(|e| format!("空间 {id} 读 sync_meta[{key}] 失败:{e}"))
    };
    let device_id = meta("device_id")?.ok_or_else(|| {
        format!("空间 {id} 缺设备身份(device_id)——库不完整,请清本地数据后重新配对")
    })?;
    if !is_ulid_name(&device_id) {
        return Err(format!(
            "空间 {id} 的设备身份不是规范 ULID(「{device_id}」)——库被改动过,请清本地数据后重新配对"
        ));
    }
    // 同步配置:零键或四键,且密钥形态合法(与 transport::load_config 同口径,
    // 但在 catalog 就响亮——孤儿键/坏 hex 不许溜过 catalog、拖到 transport 才炸)。
    let account_id = meta("account_id")?;
    let k_acc = meta("k_acc")?;
    let device_key = meta("device_key")?;
    let server_url = meta("server_url")?;
    match (&account_id, &k_acc, &device_key, &server_url) {
        (None, None, None, None) => {}
        (Some(_), Some(k), Some(d), Some(_)) => {
            for (key, v) in [("k_acc", k), ("device_key", d)] {
                if let Err(e) = crate::sync::transport::unhex32(v) {
                    return Err(format!(
                        "空间 {id} 的同步配置损坏({key} 不是合法密钥形态:{e})——请清本地数据后重新配对"
                    ));
                }
            }
        }
        _ => {
            return Err(format!(
                "空间 {id} 的同步配置残缺(四键只有部分在)——写入中断的库,请清本地数据后重新配对"
            ));
        }
    }
    // TOCTOU 双检(后半):descriptor 携带的 key 取自读取完成之后,且必须与开库
    // 之前一致。只报事实诊断,处置(桌面重启扫描/手机清库重配)归壳(codex 工序 6
    // 审查 L2:core 的处置话术会与封锁页「唯一恢复=清数据」打架)。
    let key_after = native_file_key(path)?;
    if key_after != key_before {
        return Err(format!(
            "空间 {id} 的库文件在读取途中被替换({})",
            path.display()
        ));
    }
    // 显示名(0028 起在 space_profile;上方核心表在场检查已含它,版本恰等背书列面)。
    let name: Option<String> = {
        use rusqlite::OptionalExtension;
        conn.query_row("SELECT name FROM space_profile WHERE key = 'profile'", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()
        .map(|o| o.flatten())
        .map_err(|e| format!("空间 {id} 读 space_profile 失败:{e}"))?
    };
    Ok(SpaceDescriptor {
        id: id.to_string(),
        path: path.to_path_buf(),
        name,
        device_id,
        account_id,
        file: key_after,
    })
}

// ---- 严格 catalog 聚合器(multispace-plan §2.1,工序 6 首件) ----

/// 一个数据目录的完整空间 catalog:全部空间的只读描述符,主库恒排第一
/// (space_id = `main`)、其余按 ULID 升序(= 创建序)。只有 [`SpaceCatalog::load`]
/// 整体成功才存在——**没有「部分可用」的 catalog**(字段私有,构不出部分实例)。
#[derive(Debug)]
pub struct SpaceCatalog {
    spaces: Vec<SpaceDescriptor>,
}

impl SpaceCatalog {
    /// 严格 fail-closed 聚合:发现 → 逐候选 [`read_descriptor`] → 四不变量,
    /// **全部候选成功才有 catalog,任一失败 = 整体 Err**——刻意不给壳「忽略某个
    /// descriptor 错误」的组合空间(codex 工序 2-5 实现审查 M5 约定)。调用方拿到
    /// Err 应整体拒绝正常启动、提示清库重配(§2.1/§19),不开库、不开放配对/创建/
    /// 捕获/同步。主库缺席同样是 Err:catalog 是只读层,fresh 建库归壳(先建再来)。
    /// 身份四不变量在这里按**手机政策**裁决:Hard/Soft 一律致命(桌面的
    /// 「Soft=停同步本地照用」容忍是壳层政策,不在此层)。
    pub fn load(
        main_db: &Path,
        scan_dir: Option<&Path>,
        max_spaces: Option<usize>,
    ) -> Result<SpaceCatalog, String> {
        let mut spaces = Vec::new();
        for (id, path) in discover(main_db, scan_dir, max_spaces)? {
            spaces.push(read_descriptor(&id, &path)?);
        }
        let idents: Vec<SpaceIdentity> = spaces
            .iter()
            .map(|d| SpaceIdentity {
                id: d.id.clone(),
                file: d.file,
                device_id: d.device_id.clone(),
                account_id: d.account_id.clone(),
            })
            .collect();
        let vetoes = identity_vetoes(&idents);
        // 报错按发现序取第一个(HashMap 迭代序不稳定,报错要可复现)。
        for d in &spaces {
            if let Some(Veto::Hard(m) | Veto::Soft(m)) = vetoes.get(&d.id) {
                return Err(format!("空间 {}:{m}", d.id));
            }
        }
        Ok(SpaceCatalog { spaces })
    }

    /// 主空间描述符(发现层保证主库恒在列、恒排第一)。
    pub fn main(&self) -> &SpaceDescriptor {
        &self.spaces[0]
    }

    /// 全部空间描述符(主库恒第一;只读——「不存在部分 catalog」由字段私有封死)。
    pub fn spaces(&self) -> &[SpaceDescriptor] {
        &self.spaces
    }
}

/// 从 catalog descriptor 打开空间库的读写连接(手机壳 §10 exact-current 政策的
/// 开库正道)。与 `db::open` 的差别是三条铁律:**绝不隐式建库**(NO_CREATE)、
/// **绝不跑迁移**、**先验后写**——`user_version` 在这条连接上复验恰为当前版本、
/// 路径物理身份与 descriptor 比对,全过了才切 WAL。catalog 通过后文件被换的
/// **普通单次替换窗口**在这里闭合:换进来的旧版库会在任何写入/切 WAL 之前被拒,
/// 而不是先被 `db::open` 的迁移链「救活」再由 activate 发现(codex 工序 6 审查
/// H1;持有 app 私有目录写权限者的精确 ABA 超出威胁模型——那种能力足以直接改库,
/// 与 §13 文件身份的边界一致)。
pub fn open_space(desc: &SpaceDescriptor) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        &desc.path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("空间 {} 库打不开 {}:{e}", desc.id, desc.path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let uv: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| format!("空间 {} 读 user_version 失败:{e}", desc.id))?;
    // 版本分流与 read_descriptor 同口径(H3):太新绝不劝清库。
    if uv > db::SCHEMA_VERSION {
        return Err(format!(
            "空间 {} 的数据版本({uv})比本程序({})新——请安装新版朱笺;不要清除数据",
            desc.id,
            db::SCHEMA_VERSION
        ));
    }
    if uv != db::SCHEMA_VERSION {
        return Err(format!(
            "空间 {} 的数据版本({uv})与本程序({})不符——库未经启动升级(扫描后被替换?),请清本地数据后重新配对",
            desc.id,
            db::SCHEMA_VERSION
        ));
    }
    let key = native_file_key(&desc.path)?;
    if key != desc.file {
        return Err(format!(
            "空间 {} 的库文件在扫描后被替换({})",
            desc.id,
            desc.path.display()
        ));
    }
    // 全部验过才第一笔写:切 WAL(与 db::open 同款 set-and-verify fail-fast)。
    let mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "wal", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if mode != "wal" {
        return Err(format!("SQLite 拒绝 WAL 模式(journal_mode={mode})"));
    }
    conn.pragma_update(None, "foreign_keys", true).map_err(|e| e.to_string())?;
    Ok(conn)
}

// ---- 手机启动地基:前滚迁移 + 严格 catalog 一段式(收回「安卓不跑迁移」) ----

/// 启动封锁的类型分域(codex 设计审 H3):前端封锁页按 kind 分流处置,
/// **`UpgradeRequired` 的页面绝不许出现「清除数据」**——单设备用户照做即真丢数据,
/// 恰是本案要消灭的死路。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupBlockKind {
    /// 库比本程序新(装了旧包):唯一出路 = 安装新版朱笺。
    UpgradeRequired,
    /// 环境性失败(磁盘满 / IO / 库忙):重启或释放空间后重试,数据无恙。
    Retryable,
    /// 程序侧问题(迁移 bug / 约束违例 / API 误用):数据完好,升级或重装朱笺再试,
    /// **绝不清库**(codex 实现审 H1:迁移失败的事务已回滚,数据没坏是程序坏)。
    RepairRequired,
    /// 恢复 = 清库重配(§19,本地可丢)。**只许由明确判断产生**(低于手机下限 /
    /// 主库缺失且有附属空间 / SQLite 亲口报 Corrupt / 严格 catalog 证实的结构残缺),
    /// 绝不作默认分支(codex 实现审 H1)。
    ResetRequired,
}

/// 带类型的启动封锁错误(手机壳 Gate 的数据源)。message 是诊断人话;
/// 处置指引(升级 / 重试 / 清库)由前端按 kind 分流,不在这里拼。
#[derive(Debug)]
pub struct StartupError {
    pub kind: StartupBlockKind,
    pub message: String,
}

impl StartupError {
    /// 只给「明确判断」用(H1):低于下限 / 目录残缺 / catalog 证实的结构问题。
    fn reset(message: String) -> StartupError {
        StartupError { kind: StartupBlockKind::ResetRequired, message }
    }
    fn retry(message: String) -> StartupError {
        StartupError { kind: StartupBlockKind::Retryable, message }
    }
    fn from_sqlite(e: &rusqlite::Error, message: String) -> StartupError {
        StartupError { kind: classify_sqlite_error(e), message }
    }
}

/// rusqlite 错误分域(H3;codex 实现审 H1 收紧):**默认非破坏性**——清库(Reset)
/// 只许由 SQLite 亲口报的结构损坏产生;环境性失败归「重试」;其余(约束违例 /
/// authorizer 拒 / API 误用 / 未知)是程序或迁移的 bug,数据完好,归「修复」
/// (装新版再试),绝不劝清库。
fn classify_sqlite_error(e: &rusqlite::Error) -> StartupBlockKind {
    use rusqlite::ffi::ErrorCode::*;
    match e.sqlite_error_code() {
        Some(DatabaseCorrupt | NotADatabase) => StartupBlockKind::ResetRequired,
        Some(
            DiskFull | SystemIoFailure | DatabaseBusy | DatabaseLocked | OutOfMemory
            | PermissionDenied | ReadOnly | CannotOpen | FileLockingProtocolFailed
            | OperationInterrupted | OperationAborted | SchemaChanged,
        ) => StartupBlockKind::Retryable,
        _ => StartupBlockKind::RepairRequired,
    }
}

/// 手机前滚迁移预处理(codex 设计审 H1/M2/M3;调用契约:WriterLease 已持、
/// transport 未启、严格 catalog 之前)。两阶段:
///
/// 1. **全候选只读预检**(M2):固定 discover 快照,逐库读 `user_version` 分域——
///    比本程序新 = `UpgradeRequired`、低于 [`db::MOBILE_MIGRATION_FLOOR`] =
///    `ResetRequired`(1-27 老迁移带崩溃窗,绝不对既有正式库原地跑,H1)、`[28, 当前)` 记入
///    待迁清单。**存在任何拒项则整体不写**——绝不「先升级前面的库、再发现后面的
///    必拒」。
/// 2. **逐库前滚**:RW 打开(NO_CREATE)→ 同连接复验文件身份与 uv(M3:预检与 RW
///    打开之间的换库窗口在此闭合,`run_migrations` 的降级 assert 在手机上不可达)→
///    `synchronous=FULL` set-and-verify(迁移提交的耐久性;WAL 缺省 NORMAL 下硬断电
///    可丢最近一笔提交——原子性不破但会重跑,FULL 直接免掉)→ 迁移(0029 起每条
///    自带事务与 uv,断电任意点:事务中回滚重跑 / COMMIT 后重启跳过)。
///
/// 跨库无原子事务、也不需要(codex 设计审):每库每条迁移各自原子,停在两库/两条
/// 迁移之间 = 重启续完。heal 一类数据自愈**刻意不在这里做**(M4:迁移器只管 schema;
/// 遗留名自愈在激活正道,严格 catalog 身份裁决之后)。
fn migrate_discovered_spaces(main_db: &Path, dir: &Path) -> Result<(), StartupError> {
    let found = discover(main_db, Some(dir), None).map_err(StartupError::retry)?;
    // 阶段 1:只读预检,全过才动第一笔写。
    let mut pending: Vec<(String, PathBuf, NativeFileKey)> = Vec::new();
    for (id, path) in found {
        let key = native_file_key(&path).map_err(StartupError::retry)?;
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| {
            StartupError::from_sqlite(&e, format!("空间 {id} 库打不开(升级预检){}:{e}", path.display()))
        })?;
        let uv: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|e| {
                StartupError::from_sqlite(&e, format!("空间 {id} 读 user_version 失败(升级预检):{e}"))
            })?;
        drop(conn);
        if uv > db::SCHEMA_VERSION {
            return Err(StartupError {
                kind: StartupBlockKind::UpgradeRequired,
                message: format!(
                    "空间 {id} 的数据版本({uv})比本程序({})新",
                    db::SCHEMA_VERSION
                ),
            });
        }
        if uv < db::MOBILE_MIGRATION_FLOOR {
            return Err(StartupError::reset(format!(
                "空间 {id} 的数据版本({uv})低于本程序支持下限({})——不是本程序创建的库",
                db::MOBILE_MIGRATION_FLOOR
            )));
        }
        if uv < db::SCHEMA_VERSION {
            pending.push((id, path, key));
        }
    }
    // 阶段 2:逐库前滚。
    for (id, path, key_precheck) in pending {
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| {
            StartupError::from_sqlite(&e, format!("空间 {id} 库打不开(升级){}:{e}", path.display()))
        })?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| StartupError::from_sqlite(&e, e.to_string()))?;
        let key_now = native_file_key(&path).map_err(StartupError::retry)?;
        if key_now != key_precheck {
            // 预检后被换 = 异常一瞬(WriterLease 下近乎不可能);重启重扫即得新裁决,
            // 不是清库事由(H1:Reset 只留给明确判断)。
            return Err(StartupError::retry(format!(
                "空间 {id} 的库文件在升级预检后被替换({})",
                path.display()
            )));
        }
        let uv: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|e| StartupError::from_sqlite(&e, e.to_string()))?;
        if uv > db::SCHEMA_VERSION {
            return Err(StartupError {
                kind: StartupBlockKind::UpgradeRequired,
                message: format!("空间 {id} 的数据版本({uv})比本程序新"),
            });
        }
        if uv < db::MOBILE_MIGRATION_FLOOR {
            return Err(StartupError::reset(format!(
                "空间 {id} 的数据版本({uv})低于本程序支持下限"
            )));
        }
        if uv == db::SCHEMA_VERSION {
            continue;
        }
        let sync_mode: i64 = conn
            .pragma_update(None, "synchronous", "FULL")
            .and_then(|()| conn.pragma_query_value(None, "synchronous", |r| r.get(0)))
            .map_err(|e| {
                StartupError::from_sqlite(&e, format!("空间 {id} 设 synchronous=FULL 失败:{e}"))
            })?;
        if sync_mode != 2 {
            return Err(StartupError {
                kind: StartupBlockKind::RepairRequired,
                message: format!("空间 {id} 拒绝 synchronous=FULL(={sync_mode})"),
            });
        }
        conn.pragma_update(None, "foreign_keys", true)
            .map_err(|e| StartupError::from_sqlite(&e, e.to_string()))?;
        // run_migrations 的失败事务已回滚、数据完好(runner 自有事务):分域绝不落
        // Reset 默认——Corrupt/NotADatabase 才 Reset(SQLite 亲口),环境性归重试,
        // 其余=迁移 bug 归修复(codex 实现审 H1)。
        db::run_migrations(&conn, i64::MAX).map_err(|e| {
            StartupError::from_sqlite(
                &e,
                format!("空间 {id} 升级数据格式失败(v{uv}→v{}):{e}", db::SCHEMA_VERSION),
            )
        })?;
    }
    Ok(())
}

/// 手机启动地基一段式(codex 设计审 L1:安卓壳 `load_spaces` 编排下沉,时序单一
/// 真相源;调用契约:WriterLease 已持、transport 未启):
/// 清扫 → 重置续完 → fresh/残缺裁决 → 必要时建当前版主库 → **前滚迁移**(M1:
/// 在 fresh 判据之后——主库缺失+附属空间在的必封锁目录,一笔都不写)→ 严格 catalog。
/// 任何 Err 由壳转成封锁页(Gate),按 kind 分流处置。
pub fn prepare_mobile_catalog(data_dir: &Path) -> Result<SpaceCatalog, StartupError> {
    // 「加入空间」半途死掉的 `.joining-*` 槽严格清扫(space-entry-plan §3.4):槽可能
    // 含 K_acc/设备私钥/账户明文,删除失败 = 封锁正常启动,不静默。删不掉是权限/IO
    // 一类环境事,重启重试,不是清库事由(codex 二轮 M)。
    sweep_stale_joining(data_dir).map_err(StartupError::retry)?;
    sweep_stale_creating(data_dir);
    // main 重置续完(epoch-plan §7):journal 在场 = 上次重置未完成,必须在 fresh
    // 判据/严格 catalog **之前**续完——否则「main 缺失+别的空间在」会被误判成
    // 目录残缺进封锁页。续完产物就是 fresh 未配置空库,后续流程照常。续完失败
    // (磁盘满/IO)= 先重试,不扩大成清整个数据目录(codex 二轮 M)。
    resume_main_reset(data_dir)
        .map_err(|e| StartupError::retry(format!("main 空间重置续完失败:{e}")))?;
    let main_db = data_dir.join("notebook.sqlite3");
    if !main_db.exists() {
        // fresh 判据 = 整目录没有任何正式空间库(codex 工序 6 审查 M1):主库丢了
        // 但 ULID 空间还在 ≠ 全新安装,是不完整的既有目录——静默补一个空 main 会
        // 把残缺伪装成正常,必须封锁。白名单口径复用发现层,不另写一份。
        let found = discover(&main_db, Some(data_dir), None).map_err(StartupError::retry)?;
        if found.len() > 1 {
            return Err(StartupError::reset(format!(
                "主空间库(notebook.sqlite3)缺失,但目录里还有 {} 个空间库——空间目录不完整,不是全新安装",
                found.len() - 1
            )));
        }
        // 全新安装:staging→原子归位建主库(当前 schema + 永久设备身份)。首启中途
        // 被杀只留 `.creating-main`(上面那行 sweep 掉、这次重建,fresh 自愈),
        // 绝不留半成品 main 把全新安装逼进封锁页。启动统一从只读 catalog 起步。
        // 建库失败(磁盘满等)= 重试;此刻已确认目录零正式库,无数据可清。
        create_main_db(data_dir).map_err(StartupError::retry)?;
    }
    migrate_discovered_spaces(&main_db, data_dir)?;
    SpaceCatalog::load(&main_db, Some(data_dir), None)
        .map_err(|e| classify_catalog_failure(&main_db, data_dir, e))
}

/// 严格 catalog 失败的分域(codex 实现审 H1 + 二轮 H:catalog 的 String 错误不许
/// 压成 Reset)。不嗅探错误文本,重跑一遍只读版本预检拿**地面真相**:有任何候选比
/// 本程序新 → UpgradeRequired(文字与类型不再自相矛盾);**复判自身的失败也按域
/// 返回、绝不静默吞**(拿不到地面真相就不下「清库」结论);无未来版时,原错误的
/// 类型已被 String 擦除、不能证明结构损坏——默认「修复」(非破坏),Reset 只留给
/// 明确判断(floor / 主库缺失有附属 / SQLite 亲口 Corrupt)。
fn classify_catalog_failure(main_db: &Path, dir: &Path, message: String) -> StartupError {
    let found = match discover(main_db, Some(dir), None) {
        Ok(f) => f,
        Err(e) => return StartupError::retry(format!("{message}(复判目录失败:{e})")),
    };
    for (_, path) in found {
        let conn = match Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(c) => c,
            Err(e) => {
                return StartupError::from_sqlite(&e, format!("{message}(复判开库失败:{e})"))
            }
        };
        match conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)) {
            Ok(uv) if uv > db::SCHEMA_VERSION => {
                return StartupError { kind: StartupBlockKind::UpgradeRequired, message }
            }
            Ok(_) => {}
            Err(e) => {
                return StartupError::from_sqlite(&e, format!("{message}(复判读版本失败:{e})"))
            }
        }
    }
    StartupError { kind: StartupBlockKind::RepairRequired, message }
}

// ---- 显示名(0028 起账户内共享数据,space-name-sync-plan) ----

/// 空间显示名(`space_profile` 单行物化表,op-backed):0028 起随 oplog 跨设备同步、
/// boot 引导单例合并携带。缺省 None——缺省显示的人话由前端定,**后端绝不主动写**,
/// 用户真改名才落行。读 nullable 列:外层 Option=行在不在,内层 Option=显式清名,
/// flatten 后二者都显缺省(codex 一轮 H2 注记)。
pub fn space_name(conn: &Connection) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT name FROM space_profile WHERE key = 'profile'", [], |r| {
        r.get::<_, Option<String>>(0)
    })
    .optional()
    .map(|o| o.flatten())
    .map_err(|e| e.to_string())
}

/// 改空间名(编排层,space-name-sync-plan §4.2):同事务「UPSERT 行 + 发射 op +
/// HLC 水位落盘」;幂等 no-op(同名重存)不发射不取号。锁序契约 = 写命令统一的
/// **db → clock**(调用方经 `ActiveRuntime::write_locks` 或同序自取)。入口先 trim
/// 再进共享线上规范校验(`validate_space_name_value`,与 replay/boot 单一真相源)。
pub fn set_space_name(conn: &mut Connection, clock: &mut Clock, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("空间名不能为空".into());
    }
    crate::replay::validate_space_name_value(&serde_json::Value::String(name.into()))?;
    if space_name(conn)?.as_deref() == Some(name) {
        return Ok(()); // 幂等 no-op:没写就没有 op。
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO space_profile (key, name) VALUES ('profile', ?1) \
         ON CONFLICT(key) DO UPDATE SET name = excluded.name",
        [name],
    )
    .map_err(|e| e.to_string())?;
    crate::oplog::space_set_name(&tx, clock)?;
    tx.commit().map_err(|e| e.to_string())
}

/// 存量名补发自愈步(space-name-sync-plan §5,codex 一轮 H4/二轮 H1):v27 的
/// `sync_meta['space_name']` 已退役,遗留值在此**原样**补记进 op 流(逐字迁移合法
/// 用户值,不截断不合成缺省——「后端绝不主动写」的边界)。**开库常驻**:每次打开
/// v28 库都跑,发现遗留 key 才动手;原子事务「校验旧值 → UPSERT profile → 发射 op →
/// 删旧 key」,失败整体回滚、旧 key 完整保留,绝不形成「行有 op 无」。调用方契约:
/// WriterLease 下、transport 启动前(两壳装配点)。超限/非规范旧值 = 响亮 Err
/// (开库失败,fail-fast;现实量级不可达,留闸即可)。
pub fn heal_legacy_space_name(conn: &mut Connection, clock: &mut Clock) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let legacy: Option<String> = conn
        .query_row("SELECT value FROM sync_meta WHERE key = 'space_name'", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(legacy) = legacy else {
        return Ok(()); // 无遗留(fresh v28 库 / 已补发过):无事发生。
    };
    if legacy.trim().is_empty() {
        // 显式政策:纯空白/空串遗留 = 「无名」,清 key 不合成 op(旧实现写入时拒空,
        // 这种值只可能来自手改库;当无名恢复比拒开库更合理——没有用户意图可保真)。
        conn.execute("DELETE FROM sync_meta WHERE key = 'space_name'", [])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    // 非空遗留值**原样**交共享 validator 裁决(codex 实现审 M3):这里绝不代 trim
    // ——带首尾空白的值(手改库)响亮拒开库,而不是静默规范化;「逐字迁移用户值」
    // 才站得住「后端绝不主动写」。旧 UI 写入时已 trim,诚实存量不受影响。
    crate::replay::validate_space_name_value(&serde_json::Value::String(legacy.clone()))
        .map_err(|e| format!("遗留空间名不符线上规范,拒绝开库(手工处理后重试):{e}"))?;
    let name = legacy.as_str();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO space_profile (key, name) VALUES ('profile', ?1) \
         ON CONFLICT(key) DO UPDATE SET name = excluded.name",
        [name],
    )
    .map_err(|e| e.to_string())?;
    crate::oplog::space_set_name(&tx, clock)?;
    tx.execute("DELETE FROM sync_meta WHERE key = 'space_name'", []).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// ---- 建库(multispace-plan §3,M4 坍缩版) ----

/// staging 建库的原子骨架:`.creating-<tag>.sqlite3` staging(默认 DELETE rollback
/// journal,不切 WAL——关连接后目录里只有一个文件可挪)→ 全部迁移 + 生独立
/// device_id + `init` 定制 → 关连接 → **hard_link 原子归位**(目标已存在即失败 =
/// no-clobber;最终路径由正常 `db::open` 切回 WAL)。staging→归位只为一件事:
/// **一次正常成功返回真的是完整库**,半成品永远只是 `.creating-*`——由启动
/// [`sweep_stale_creating`] 无条件清,绝不伪装成正式空间;刻意不做目录 fsync 级
/// 抗断电(本地可丢,§19)。归位走 [`publish_no_clobber`]:桌面/宿主 hard_link
/// (FAT/部分网络盘不支持则响亮失败);**Android app 私有目录拒 link(),改 renameat2
/// 的 RENAME_NOREPLACE**——两路都是「目标已存在即失败」的原子 no-clobber。
fn stage_and_publish(
    dir: &Path,
    tag: &str,
    final_name: &str,
    init: impl FnOnce(&mut Connection, &mut Clock) -> Result<(), String>,
) -> Result<PathBuf, String> {
    let staging = dir.join(format!(".creating-{tag}.sqlite3"));
    let path = dir.join(final_name);
    // 终点必须尚不存在:撞上既有文件/手工同名 = 响亮拒,绝不覆盖既有库。这里只是
    // 友好预检;真正的原子 no-clobber 在发布段的 hard_link(rename 在 Windows/Unix
    // 都会覆盖既存目标,hard_link 目标已存在则失败)。
    if path.exists() {
        return Err(format!("空间库文件已存在 {}(撞名?)", path.display()));
    }
    // staging 由本次独占创建(同名残留启动时已清,仍以 create_new 防御):这一步
    // 失败不做任何清理——文件不是本次的;它成功之后 staging 才归本次所有,后续
    // 任何失败允许(且只会)删到这枚本次创建的文件。
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(|e| format!("创建空间暂存库失败 {}:{e}", staging.display()))?;
    let build = || -> Result<(), String> {
        // 刻意不走 db::open:staging 不切 WAL,免掉 -wal/-shm 的归位处理。
        let mut conn = Connection::open(&staging).map_err(|e| format!("建空间库失败:{e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", true).map_err(|e| e.to_string())?;
        db::run_migrations(&conn, i64::MAX).map_err(|e| format!("建空间库迁移失败:{e}"))?;
        // 首启生成独立 device_id(独立库 = 独立设备身份);时钟交给 init(建库期
        // 的写编排要发射 op,如 create_space 的命名——codex 一轮 M4:别丢弃它),
        // 内存态用后即弃——正式打开时由调用方 Clock::load 恒等加载。
        let mut clock = Clock::load(&conn)?;
        init(&mut conn, &mut clock)?;
        conn.close().map_err(|(_, e)| format!("关空间暂存库失败:{e}"))?;
        Ok(())
    };
    if let Err(e) = build() {
        let _ = std::fs::remove_file(&staging);
        return Err(e);
    }
    // 原子 no-clobber 发布(目标已存在即失败,「绝不覆盖既有库」由文件系统语义而非
    // 上面的 exists 预检保证):桌面/宿主 hard_link,Android 改 renameat2——见
    // [`publish_no_clobber`]。失败留下的 staging 由本段清(它是本次独占创建的)。
    if let Err(e) = publish_no_clobber(&staging, &path) {
        let _ = std::fs::remove_file(&staging);
        return Err(format!("空间库归位失败 {} → {}:{e}", staging.display(), path.display()));
    }
    Ok(path)
}

/// staging→final 的原子 no-clobber 发布(目标已存在即失败,绝不覆盖既有库)。
/// 桌面/宿主:hard_link(目标存在即失败;rename 会静默覆盖)+ unlink staging 名
/// ——与正式库同 inode,删失败无害(启动 [`sweep_stale_creating`] 再删一次名字,
/// 库本体无损)。
#[cfg(not(target_os = "android"))]
fn publish_no_clobber(staging: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::hard_link(staging, path)?;
    let _ = std::fs::remove_file(staging);
    Ok(())
}

/// Android 专路:app 私有目录(SELinux `app_data_file`)拒 `link()`(os error 13,
/// 真机 create_space 归位崩），改 renameat2 的 `RENAME_NOREPLACE`——同为原子
/// no-clobber(目标存在即 `EEXIST`),且 rename 后 staging 名随之消失、无需再 unlink。
/// /data 私有区 f2fs/ext4 支持该 flag;不支持则响亮 errno 上抛(fail-fast,不静默
/// 覆盖、不回退)。
#[cfg(target_os = "android")]
fn publish_no_clobber(staging: &Path, path: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(staging.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "staging 路径含 NUL"))?;
    let to = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目标路径含 NUL"))?;
    // SAFETY: 两个指针指向本函数局部 CString 的 NUL 结尾缓冲,活到 syscall 返回;
    // renameat2 只在调用期间读它们、不留存。minSdk=30 保证该符号在目标设备存在。
    let rc = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            // android 的 renameat2 flags 形参是 u32,而 RENAME_NOREPLACE 常量是 i32。
            libc::RENAME_NOREPLACE as libc::c_uint,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// 新建一个空间库(ULID 命名,[`stage_and_publish`] 原子骨架 + 显示名必填)。
/// 同步不自动配——空间=账户,进哪个账户由用户在该空间里创号/配对决定。
pub fn create_space(dir: &Path, name: &str) -> Result<(String, PathBuf), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("空间名不能为空".into());
    }
    let id = ulid::Ulid::new().to_string();
    let path = stage_and_publish(dir, &id, &format!("{id}.sqlite3"), |conn, clock| {
        set_space_name(conn, clock, name)
    })?;
    Ok((id, path))
}

/// fresh 建主库(工序 6,手机壳的 §10「新建库」路):`notebook.sqlite3` 走与
/// [`create_space`] 同一条 staging→原子归位骨架——中途死掉只留 `.creating-main`
/// (下次启动 sweep 掉重来,fresh 自愈),绝不留「半成品 main」把全新安装逼进
/// 「清库重配」封锁页。刻意不写显示名(主空间缺省人话由前端定,后端绝不主动写);
/// 桌面不用它——桌面主库走 `db::open` 迁移正道,半成品由续跑迁移自愈。
pub fn create_main_db(dir: &Path) -> Result<PathBuf, String> {
    stage_and_publish(dir, MAIN_SPACE, "notebook.sqlite3", |_, _| Ok(()))
}

/// 启动清残留:上次建库中途死掉的 `.creating-*`(含其 `-journal`)无条件删——
/// staging 从未 rename 归位就不是空间(multispace-plan §2.1)。**重置孤儿一并清**
/// (epoch-plan §7):非 main 空间重置以「删主库」为提交点,之后删 -wal/-shm 前
/// 崩溃会留孤儿——主库不在的 `-wal`/`-shm` 不属于任何空间,发现面也看不见它,
/// 启动扫掉即完成恢复路径(绝无半态:主库在 = 空间完整,主库不在 = 空间已除)。
pub fn sweep_stale_creating(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(".creating-") {
            let _ = std::fs::remove_file(entry.path());
        }
        for suffix in ["-wal", "-shm"] {
            if let Some(base) = name.strip_suffix(suffix) {
                if !dir.join(base).exists() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

// ---- 「加入空间」的隐式空槽(space-entry-plan §3.1/§3.4) ----

/// `.joining-<ulid>` 槽文件的全套可能残留(主文件 + rollback journal + WAL/SHM;
/// 槽全程 DELETE journal,WAL/SHM 正常不存在,清扫仍覆盖以防实现漂移)。
fn joining_sidecars(staging: &Path) -> [PathBuf; 4] {
    let base = staging.as_os_str().to_os_string();
    let with = |suffix: &str| {
        let mut s = base.clone();
        s.push(suffix);
        PathBuf::from(s)
    };
    [staging.to_path_buf(), with("-journal"), with("-wal"), with("-shm")]
}

/// 严格删除一枚槽的全部文件:任一删除失败 = Err(**不静默**——`.joining-*` 可能含
/// 完整明文数据、K_acc、设备私钥,残留不可接受);不存在的文件视为成功(幂等)。
/// [`JoiningSlot::abort`] 与 [`sweep_stale_joining`] 共用本例程。
fn remove_joining_files(staging: &Path) -> Result<(), String> {
    let mut errs = Vec::new();
    for p in joining_sidecars(staging) {
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => errs.push(format!("{}:{e}", p.display())),
        }
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(format!("加入空间的暂存库删除失败(含账户密钥材料,不可残留):{}", errs.join(";")))
    }
}

/// 启动清扫(space-entry-plan §3.4):上次「加入空间」半途死掉的 `.joining-*` 槽
/// **严格**清除。与 [`sweep_stale_creating`] 的静默政策刻意不同:`.creating-*` 是
/// 无配置半成品,删不掉无所谓;`.joining-*` 配对成功后含 K_acc/设备私钥/账户全量
/// 明文,删除失败必须**封锁正常启动**(调用方拿 Err 进封锁页/拒启,111 Gate 先例)。
/// 调用方契约:WriterLease 之后、任何 catalog/transport 之前。
pub fn sweep_stale_joining(dir: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("读空间目录失败 {}:{e}", dir.display()))?;
    let mut errs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读空间目录项失败:{e}"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(".joining-") {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => errs.push(format!("{}:{e}", entry.path().display())),
        }
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(format!("加入空间的暂存库删除失败(含账户密钥材料,不可残留):{}", errs.join(";")))
    }
}

/// 「加入空间」的隐式空槽(space-entry-plan §3.1):`.joining-<ulid>` staging 库,
/// 跨数分钟的 async 配对 + 引导全程都在 staging 上进行,**成功 publish 之前用户
/// 不可见**(发现白名单不认 `.joining-*`)。与 `stage_and_publish`(同步闭包、建完
/// 即发布)刻意分开——那条路必发名字 op(`create_space` 名字必填),占位名会以新
/// HLC 压过账户名(codex 一轮 M2);槽**零名字 op**,账户名随 boot 干净到达。
///
/// 硬合同(codex 二轮 M1 / 三轮 M3):
/// - 全程 **DELETE journal**,禁走 `db::open`/`open_space`(它们永久切 WAL);
/// - `close(self)` typestate:DB **与 Clock** 都要 `Arc::try_unwrap` 证明只剩一份,
///   `Connection::close` 也可能失败——**任何失败都把槽所有权原样返还**([`CloseFailure`]),
///   既不 publish 也不假装 abort 已安全完成;仅 [`ClosedJoiningSlot`] 可 `publish()`;
/// - 顺序写死:close → publish → catalog/runtime 以新连接打开;
/// - `abort()` 删除失败返回 Err(不许静默;回执不得谎称「无痕」);
/// - Drop 只做 best-effort 兜底删除,权威清扫在 [`sweep_stale_joining`]。
pub struct JoiningSlot {
    id: String,
    staging: PathBuf,
    /// Option 只服务 close/abort 的所有权搬运(消费路径 take 走;活槽恒 Some)。
    db: Option<Arc<Mutex<Connection>>>,
    clock: Option<Arc<Mutex<Clock>>>,
    /// close/abort 已接管文件所有权(消费路径),Drop 兜底不再动文件。
    defused: bool,
}

/// [`JoiningSlot::close`] 的失败形:槽与连接所有权**原样返还**(rusqlite close 失败
/// 本就返还 Connection),调用方可重试 close 或 abort,fail-closed。
pub struct CloseFailure {
    pub slot: JoiningSlot,
    pub error: String,
}

/// 已关闭连接的槽(typestate:只有它能 publish;此刻盘上只有一个主文件可挪)。
#[derive(Debug)]
pub struct ClosedJoiningSlot {
    id: String,
    staging: PathBuf,
}

/// [`ClosedJoiningSlot::publish`] 的成功回执。**桌面 hard_link 发布不是单步**:final
/// link 成功后 staging unlink 仍可失败——此时空间已真实发布,`cleanup_error` 携带
/// 残留说明(启动 [`sweep_stale_joining`] 会再清一次名字,库本体无损),**绝不当作
/// 未发布再 abort**(codex 三轮 M3)。
#[derive(Debug)]
pub struct PublishedSlot {
    pub id: String,
    pub path: PathBuf,
    pub cleanup_error: Option<String>,
}

impl JoiningSlot {
    /// 建槽:生成最终 ULID、`.joining-<ulid>.sqlite3` 独占创建、全部迁移 + 独立
    /// device_id;创建后断言 `space_profile` 零行、`space` op 零条、同步配置零键、
    /// journal_mode=DELETE(§3.1 的槽不变量,任一不成立 = 编排/迁移 bug,响亮)。
    pub fn create(dir: &Path) -> Result<JoiningSlot, String> {
        let id = ulid::Ulid::new().to_string();
        let staging = dir.join(format!(".joining-{id}.sqlite3"));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|e| format!("创建加入暂存库失败 {}:{e}", staging.display()))?;
        let build = || -> Result<(Connection, Clock), String> {
            // 刻意不走 db::open:槽全程 DELETE journal 不切 WAL(close 后目录里只有
            // 一个文件可挪,免掉 -wal/-shm 的归位处理)。
            let conn = Connection::open(&staging).map_err(|e| format!("建加入暂存库失败:{e}"))?;
            conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
            conn.pragma_update(None, "foreign_keys", true).map_err(|e| e.to_string())?;
            db::run_migrations(&conn, i64::MAX).map_err(|e| format!("加入暂存库迁移失败:{e}"))?;
            let clock = Clock::load(&conn)?;
            let mode: String = conn
                .pragma_query_value(None, "journal_mode", |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if mode != "delete" {
                return Err(format!("加入暂存库 journal_mode={mode}(必须 delete,槽不变量被破坏)"));
            }
            let profile_rows: i64 = conn
                .query_row("SELECT COUNT(*) FROM space_profile", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let space_ops: i64 = conn
                .query_row("SELECT COUNT(*) FROM oplog WHERE entity = 'space'", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if profile_rows != 0 || space_ops != 0 {
                return Err(format!(
                    "加入暂存库带出生名字(profile {profile_rows} 行 / space op {space_ops} 条)——占位名会压过账户名,槽必须零名字"
                ));
            }
            if crate::sync::transport::load_config(&conn)?.is_some() {
                return Err("加入暂存库天生带同步配置(必是 bug)".into());
            }
            Ok((conn, clock))
        };
        match build() {
            Ok((conn, clock)) => Ok(JoiningSlot {
                id,
                staging,
                db: Some(Arc::new(Mutex::new(conn))),
                clock: Some(Arc::new(Mutex::new(clock))),
                defused: false,
            }),
            Err(e) => {
                let _ = remove_joining_files(&staging);
                Err(e)
            }
        }
    }

    /// 槽将来发布成的正式 space_id(= 最终文件名的 ULID)。
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn staging_path(&self) -> &Path {
        &self.staging
    }

    /// 槽库连接(配对写配置 / staging transport 用;调用方在 close 前必须放掉全部
    /// clone——close 以 `Arc::try_unwrap` 证明)。
    pub fn db(&self) -> Arc<Mutex<Connection>> {
        self.db.as_ref().expect("活槽恒持连接").clone()
    }

    pub fn clock(&self) -> Arc<Mutex<Clock>> {
        self.clock.as_ref().expect("活槽恒持时钟").clone()
    }

    /// 关闭槽连接(typestate)。失败把槽原样返还:残留 Arc(transport 没收干净)、
    /// `Connection::close` 被拒都走 [`CloseFailure`]——此时**绝不 publish**(类型上
    /// 就做不到:publish 只在 [`ClosedJoiningSlot`] 上)。close 成功后断言 WAL/SHM
    /// 不存在(DELETE journal 合同的出口复核)。
    pub fn close(mut self) -> Result<ClosedJoiningSlot, CloseFailure> {
        // DB 与 Clock 都要证明只剩一份(codex 二轮 M1:Clock 漏证会让迟到的写命令
        // 拿旧钟对已发布库取号)。db 为 None = 上次 close 已关连接、败在出口复核,
        // 重试直接跳到复核。
        if let Some(db_arc) = self.db.take() {
            let db = match Arc::try_unwrap(db_arc) {
                Ok(m) => m,
                Err(back) => {
                    self.db = Some(back);
                    return Err(CloseFailure {
                        error: "槽库连接仍被引用(transport 未收干净),拒绝关闭".into(),
                        slot: self,
                    });
                }
            };
            // Clock 先解出**值**、暂不销毁:Connection::close 仍可能失败,失败时
            // db 与 clock 都要原样放回(codex 一轮 M2:只还 db 会留下 clock=None
            // 的残废槽,重试 close / clock() 直接 panic)。
            let clock_val = match Arc::try_unwrap(self.clock.take().expect("连接在则时钟在")) {
                Ok(m) => m.into_inner().expect("clock mutex poisoned"),
                Err(back) => {
                    self.clock = Some(back);
                    self.db =
                        Some(Arc::new(Mutex::new(db.into_inner().expect("db mutex poisoned"))));
                    return Err(CloseFailure {
                        error: "槽时钟仍被引用(写编排未收干净),拒绝关闭".into(),
                        slot: self,
                    });
                }
            };
            let conn = db.into_inner().expect("db mutex poisoned");
            if let Err((conn, e)) = conn.close() {
                // rusqlite close 失败返还 Connection:槽所有权(连接 + 时钟)原样
                // 交回调用方,可重试 close 或 abort。(安全 API 下 close 只会因
                // 未终结语句失败、rusqlite 又不让语句逃出锁作用域——此路无法用安全
                // API 注入,合同以代码结构背书;WAL 残留失败路另有行为测试。)
                self.db = Some(Arc::new(Mutex::new(conn)));
                self.clock = Some(Arc::new(Mutex::new(clock_val)));
                return Err(CloseFailure {
                    error: format!("关闭槽库连接失败:{e}"),
                    slot: self,
                });
            }
        }
        for suffix in ["-wal", "-shm"] {
            let mut side = self.staging.as_os_str().to_os_string();
            side.push(suffix);
            if Path::new(&side).exists() {
                return Err(CloseFailure {
                    error: format!(
                        "槽库关闭后仍有 {} 残留(DELETE journal 合同被破坏)",
                        Path::new(&side).display()
                    ),
                    slot: self,
                });
            }
        }
        self.defused = true; // 文件所有权移交 ClosedJoiningSlot。
        Ok(ClosedJoiningSlot { id: std::mem::take(&mut self.id), staging: std::mem::take(&mut self.staging) })
    }

    /// 放弃槽:关连接后严格删除全部槽文件。**任一步失败 = Err**(不许静默;调用方
    /// 回执不得谎称「无痕」,启动清扫会再试并在失败时封锁)。连接还开着时 Windows
    /// 删不动文件——收不干净就如实报,不硬删。
    pub fn abort(mut self) -> Result<(), String> {
        self.defused = true;
        let staging = std::mem::take(&mut self.staging);
        drop(self.clock.take());
        if let Some(db_arc) = self.db.take() {
            match Arc::try_unwrap(db_arc) {
                Ok(m) => {
                    let conn = m.into_inner().expect("db mutex poisoned");
                    if let Err((_conn, e)) = conn.close() {
                        return Err(format!("放弃槽时关连接失败(文件未删,启动清扫兜底):{e}"));
                    }
                }
                Err(_back) => {
                    return Err("放弃槽时连接仍被引用(文件未删,启动清扫兜底)".into());
                }
            }
        }
        remove_joining_files(&staging)
    }
}

impl Drop for JoiningSlot {
    fn drop(&mut self) {
        if self.defused {
            return;
        }
        // best-effort 兜底(连接可能仍开着,Windows 上会删不动):权威清扫在启动
        // sweep_stale_joining,失败静默可接受——这是兜底不是合同。
        let _ = remove_joining_files(&self.staging);
    }
}

impl ClosedJoiningSlot {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn staging_path(&self) -> &Path {
        &self.staging
    }

    /// no-clobber 原子发布成正式 `<ulid>.sqlite3`。桌面/宿主 hard_link + unlink
    /// staging(unlink 失败 = `Published { cleanup_error }`,**绝不当作未发布**);
    /// Android renameat2(RENAME_NOREPLACE,staging 名随之消失)。失败(link/rename
    /// 本身)= Err,槽文件原样留在 staging(调用方 abort 或留给启动清扫)。
    pub fn publish(self) -> Result<PublishedSlot, (ClosedJoiningSlot, String)> {
        let path = self.staging.parent().expect("槽必有父目录").join(format!("{}.sqlite3", self.id));
        #[cfg(not(target_os = "android"))]
        {
            if let Err(e) = std::fs::hard_link(&self.staging, &path) {
                return Err((self, format!("空间库发布失败(hard_link):{e}")));
            }
            let cleanup_error = std::fs::remove_file(&self.staging)
                .err()
                .map(|e| format!("空间已发布,但暂存名清理失败(重启后自动清理):{e}"));
            Ok(PublishedSlot { id: self.id, path, cleanup_error })
        }
        #[cfg(target_os = "android")]
        {
            match publish_no_clobber(&self.staging, &path) {
                Ok(()) => Ok(PublishedSlot { id: self.id, path, cleanup_error: None }),
                Err(e) => Err((self, format!("空间库发布失败(renameat2):{e}"))),
            }
        }
    }

    /// 放弃已关闭的槽(publish 前反悔/取消):严格删除,失败 Err。
    pub fn abort(self) -> Result<(), String> {
        remove_joining_files(&self.staging)
    }
}

// ---- 空间重置:清除本机副本(epoch-plan §7) ----

/// main 空间重置的可恢复 journal 文件名(见 [`reset_main_files`] 的次序说明)。
const RESET_MAIN_JOURNAL: &str = ".reset-main.journal";

/// 非 main 空间的重置文件步(epoch-plan §7 步骤 5;调用方契约:该空间的
/// [`ResetTicket`](crate::sync::supervisor::ResetTicket) 在手 = 会话侧已收场、
/// 连接已 drop、墓碑挡着并发激活;目录级 WriterLease 全程保持——它正保护删除
/// 窗口不被第二进程插入)。
///
/// 崩溃契约(§7 步骤 7):**删主库是提交点**——提交点之前崩 = 旧库完整(-wal 还在,
/// 一次都没动);之后崩 = 空间已除,孤儿 -wal/-shm 由启动 [`sweep_stale_creating`]
/// 清;绝无「主库在、-wal 没了」的丢提交半态(那才是必须避免的次序)。
pub fn reset_space_files(dir: &Path, id: &str) -> Result<(), String> {
    if id == MAIN_SPACE {
        return Err("main 空间走 reset_main_files(原地重建空库,不可摘除)".into());
    }
    if !is_ulid_name(id) {
        return Err(format!("空间 id 形态不对:{id}"));
    }
    let db = dir.join(format!("{id}.sqlite3"));
    // 提交点:删主库(unlink 原子)。不存在 = 重复调用/恢复路径,幂等继续清孤儿。
    match std::fs::remove_file(&db) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删空间库失败 {}:{e}", db.display())),
    }
    for suffix in ["-wal", "-shm"] {
        let side = dir.join(format!("{id}.sqlite3{suffix}"));
        match std::fs::remove_file(&side) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("删空间附属文件失败 {}:{e}", side.display())),
        }
    }
    Ok(())
}

/// main 空间重置(epoch-plan §7 特例):main 不可从目录摘除(「main 缺失+其他空间
/// 在」会被严格启动判异常,111 fail-closed),重置 = **原地换成当前 schema 的未
/// 配置空库**。
///
/// 实现是**三平台统一的 journal 路**,不走「staging + rename-over 原子替换」:
/// rename-over 只替换主库文件,旧 `-wal` 还留在原地——新空库配旧 wal 的现场并不
/// 干净(SQLite 按 salt 拒认是实现细节,不拿正确性赌它);journal 先行则每一步
/// 崩溃都可续完,替换物又是**确定性的空库**(重建 ≡ 续传,staging 丢了就重建):
///
/// 1. 写 journal(fsync)——从这一刻起「重置必将完成」;
/// 2. 删旧三件套(db/-wal/-shm,任意顺序,journal 在场半态无所谓);
/// 3. [`create_main_db`] 重建未配置空库(staging→原子归位既有骨架);
/// 4. 删 journal。
///
/// 崩溃在 1 前 = 旧库完整;1-4 之间 = 启动 [`resume_main_reset`] 见 journal 续完。
/// 调用方契约同 [`reset_space_files`](ResetTicket 在手、WriterLease 全程保持)。
pub fn reset_main_files(dir: &Path) -> Result<PathBuf, String> {
    write_reset_journal(dir)?;
    complete_main_reset(dir)
}

/// journal 落盘(fsync 到文件本体;目录项耐久性刻意不追——本地可丢 §19,追的是
/// 「journal 在则必续完」的单向性,不是断电原子)。
fn write_reset_journal(dir: &Path) -> Result<(), String> {
    let journal = dir.join(RESET_MAIN_JOURNAL);
    let f = std::fs::File::create(&journal)
        .map_err(|e| format!("写重置 journal 失败 {}:{e}", journal.display()))?;
    f.sync_all().map_err(|e| format!("journal fsync 失败:{e}"))?;
    Ok(())
}

/// journal 在场时的续完体(重置正路与启动恢复共用):删旧三件套 → 重建空库 →
/// 删 journal。幂等——任一步已做过都能安全重跑。
fn complete_main_reset(dir: &Path) -> Result<PathBuf, String> {
    for name in ["notebook.sqlite3", "notebook.sqlite3-wal", "notebook.sqlite3-shm"] {
        let p = dir.join(name);
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("删旧主库失败 {}:{e}", p.display())),
        }
    }
    // 上次崩溃可能留下 .creating-main staging(create_main_db 的 no-clobber 会撞它):
    // staging 从未归位就不是库,清掉重建(sweep 同款语义)。
    let _ = std::fs::remove_file(dir.join(".creating-main.sqlite3"));
    let path = create_main_db(dir)?;
    std::fs::remove_file(dir.join(RESET_MAIN_JOURNAL))
        .map_err(|e| format!("清重置 journal 失败:{e}"))?;
    Ok(path)
}

/// 启动恢复(两壳在**严格启动/catalog 装载之前**调):journal 在场 = 上次 main
/// 重置未完成,续完(Ok(true));不在 = 无事(Ok(false),不碰任何文件)。
/// 111 的 fail-closed 启动会把「main 缺失」判异常——恢复必须先于它跑。
pub fn resume_main_reset(dir: &Path) -> Result<bool, String> {
    if !dir.join(RESET_MAIN_JOURNAL).exists() {
        return Ok(false);
    }
    complete_main_reset(dir)?;
    Ok(true)
}

// ---- 单写者租约(multispace-plan §5) ----

/// 数据目录级单写者租约:OS 排他文件锁,持到进程退出(含被杀,OS 收回)。防第二个
/// 进程绕过 app 层单实例门同开库——两份内存 Clock 会写回退 `last_hlc`、两写者争同
/// origin_seq、同 device_id 两 transport 互顶;双进程双写坏的**不是本地耐久性,而是
/// 正确性**,不能以「反正能清库重配」砍掉。
///
/// **底层锁实现分平台**(真机验收 113 揪出):Windows LockFileEx / 非 android Unix
/// flock 走 std 稳定化的 `File::try_lock`(1.89);但 **`target_os="android"` 的 std
/// `try_lock` 是未实现桩、恒返回 `Unsupported`**(bionic 未接),故 Android 直接调
/// `libc::flock`(bionic 支持;锁随 fd 关闭释放,与本租约「句柄存活=锁存活」一致)。
/// 宿主机 cargo test 全在 Windows/Linux、走 std 路径,照不出 Android 这条——必须真机。
///
/// **锁文件永不 unlink**(unlink 后 inode 复用:第三进程锁「新文件」与第二进程锁
/// 「旧文件」互不相见 = 双 writer);锁不加在 SQLite 主文件上(别搅 SQLite 自己的
/// 锁协议)。core 收壳传入的锁路径、不自猜 app-data(e2e/YS_DB_PATH 按目标 DB
/// 派生独立锁,与开发中的生产实例互不误伤)。
#[derive(Debug)]
pub struct WriterLease {
    /// 句柄存活 = 锁存活;Drop 只关句柄放锁,**不删文件**。
    _file: std::fs::File,
}

impl WriterLease {
    pub fn acquire(path: &Path) -> Result<WriterLease, String> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)
            .map_err(|e| format!("开写者锁文件失败 {}:{e}", path.display()))?;
        match try_lock_exclusive(&file) {
            Ok(true) => Ok(WriterLease { _file: file }),
            Ok(false) => Err(format!(
                "另一个朱笺进程正在使用此数据目录(写者锁被占:{})——请先退出那个进程再启动",
                path.display()
            )),
            Err(e) => Err(format!("取写者锁失败 {}:{e}", path.display())),
        }
    }
}

/// 取排他非阻塞锁。`Ok(true)`=拿到、`Ok(false)`=被别的进程占(WouldBlock)、`Err`=真故障。
/// Windows 桌面 + 宿主机测试走此路:std 稳定化的 `File::try_lock`(1.89),行为不变。
#[cfg(not(target_os = "android"))]
fn try_lock_exclusive(file: &std::fs::File) -> std::io::Result<bool> {
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(std::fs::TryLockError::WouldBlock) => Ok(false),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

/// Android 专路:std `try_lock` 在 bionic 上恒 `Unsupported`,直接 `libc::flock`。
/// `LOCK_EX|LOCK_NB` 非阻塞排他;被占时 errno=EWOULDBLOCK(Linux 上 == EAGAIN)。
/// flock 锁绑在 open file description 上,随 fd(即 `WriterLease._file`)关闭而释放。
#[cfg(target_os = "android")]
fn try_lock_exclusive(file: &std::fs::File) -> std::io::Result<bool> {
    use std::os::unix::io::AsRawFd;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
        Ok(false)
    } else {
        Err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 身份带真文件 key(hardlink 归一靠它),测试也就用真文件。
    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zj-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ident(dir: &Path, id: &str, file: &str, device: &str, account: Option<&str>) -> SpaceIdentity {
        let path = dir.join(file);
        if !path.exists() {
            std::fs::write(&path, b"x").unwrap();
        }
        SpaceIdentity {
            id: id.into(),
            file: native_file_key(&path).unwrap(),
            device_id: device.into(),
            account_id: account.map(String::from),
        }
    }

    // ---- 手机启动地基:前滚迁移(prepare_mobile_catalog) ----

    /// 手工造一枚 vN 旧版库(带设备身份 + 一条真实捕获):模拟「上个版本的 app
    /// 建的库,覆盖装新版后首启」。create_main_db/create_space 只会建当前版,造旧版
    /// 只能走 runner 直控。
    fn build_old_db(path: &Path, through: i64) -> (i64, i64) {
        let mut conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        db::run_migrations(&conn, through).unwrap();
        let mut clock = Clock::load(&conn).unwrap();
        crate::notes::capture(&mut conn, &mut clock, "升级前的数据").unwrap();
        let ops: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        (ops, items)
    }

    fn uv_of(path: &Path) -> i64 {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap()
    }

    /// 幸福路:v28 的 main + 附属空间(模拟两台现网手机覆盖装 v29)→ 一段式启动
    /// 前滚到当前版、数据与 oplog 原样、catalog/开库正道全通。
    #[test]
    fn prepare_mobile_catalog_forward_migrates_v28() {
        let dir = tmp_dir("fwd28");
        let main = dir.join("notebook.sqlite3");
        let extra = dir.join("01JBBBBBBBBBBBBBBBBBBBBBBB.sqlite3");
        let (main_ops, main_items) = build_old_db(&main, 28);
        let (extra_ops, _) = build_old_db(&extra, 28);
        let cat = prepare_mobile_catalog(&dir).expect("v28 库必须被前滚救活,不进封锁页");
        assert_eq!(cat.spaces().len(), 2);
        assert_eq!(uv_of(&main), db::SCHEMA_VERSION);
        assert_eq!(uv_of(&extra), db::SCHEMA_VERSION);
        let conn = open_space(cat.main()).unwrap();
        let ops: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!((ops, items), (main_ops, main_items), "前滚零数据触碰");
        drop(conn);
        let conn2 = open_space(&cat.spaces()[1]).unwrap();
        let ops2: i64 = conn2.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        assert_eq!(ops2, extra_ops);
        drop(conn2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 错误分域(codex 实现审 H1):Reset 只许 SQLite 亲口的结构损坏;环境性归重试;
    /// 约束违例 / authorizer 拒(SQLITE_AUTH)/ 未知 = 程序 bug 归修复,绝不劝清库。
    #[test]
    fn classify_sqlite_error_never_defaults_to_reset() {
        use rusqlite::ffi;
        let err = |code: i32| {
            rusqlite::Error::SqliteFailure(ffi::Error::new(code), None)
        };
        assert_eq!(classify_sqlite_error(&err(ffi::SQLITE_CORRUPT)), StartupBlockKind::ResetRequired);
        assert_eq!(classify_sqlite_error(&err(ffi::SQLITE_NOTADB)), StartupBlockKind::ResetRequired);
        for code in [
            ffi::SQLITE_FULL,
            ffi::SQLITE_IOERR,
            ffi::SQLITE_BUSY,
            ffi::SQLITE_LOCKED,
            ffi::SQLITE_NOMEM,
            ffi::SQLITE_PERM,
            ffi::SQLITE_READONLY,
            ffi::SQLITE_CANTOPEN,
            ffi::SQLITE_PROTOCOL,
            ffi::SQLITE_INTERRUPT,
            ffi::SQLITE_ABORT,
            ffi::SQLITE_SCHEMA,
        ] {
            assert_eq!(classify_sqlite_error(&err(code)), StartupBlockKind::Retryable, "{code}");
        }
        // FK 自验收失败 / authorizer 拒 / 内部错 / 未知:数据完好(事务已回滚),
        // 归修复——**默认分支绝不是 Reset**。
        for code in [
            ffi::SQLITE_CONSTRAINT_FOREIGNKEY,
            ffi::SQLITE_AUTH,
            ffi::SQLITE_INTERNAL,
            ffi::SQLITE_MISUSE,
            ffi::SQLITE_ERROR,
        ] {
            assert_eq!(classify_sqlite_error(&err(code)), StartupBlockKind::RepairRequired, "{code}");
        }
    }

    /// 严格 catalog 失败的地面真相复判(H1 打架修复 + 二轮 H):目录里真有未来版库 →
    /// kind=UpgradeRequired(文字与类型不再自相矛盾);没有 → 原错误类型已被 String
    /// 擦除、不能证明结构损坏,默认「修复」非破坏,**绝不默认 Reset**。
    #[test]
    fn classify_catalog_failure_sees_future_version() {
        let dir = tmp_dir("catfail");
        let main = dir.join("notebook.sqlite3");
        build_old_db(&main, db::SCHEMA_VERSION);
        {
            let conn = Connection::open(&main).unwrap();
            conn.pragma_update(None, "user_version", db::SCHEMA_VERSION + 1).unwrap();
        }
        let e = classify_catalog_failure(&main, &dir, "任意 catalog 错误".into());
        assert_eq!(e.kind, StartupBlockKind::UpgradeRequired);
        {
            let conn = Connection::open(&main).unwrap();
            conn.pragma_update(None, "user_version", db::SCHEMA_VERSION).unwrap();
        }
        let e = classify_catalog_failure(&main, &dir, "任意 catalog 错误".into());
        assert_eq!(e.kind, StartupBlockKind::RepairRequired);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// H1:低于手机下限(v27 与 uv=0)= ResetRequired 拒且**零写**——1-27 老迁移带
    /// 崩溃窗,绝不对安卓既有正式库原地跑;「现网没有旧库」不能代替代码闸。
    #[test]
    fn prepare_mobile_catalog_rejects_uv0() {
        let dir = tmp_dir("uv0");
        // 裸 Connection::open 建出的空库:uv=0、无任何表。
        drop(Connection::open(dir.join("notebook.sqlite3")).unwrap());
        let err = prepare_mobile_catalog(&dir).unwrap_err();
        assert_eq!(err.kind, StartupBlockKind::ResetRequired);
        assert!(err.message.contains("支持下限"), "{}", err.message);
        assert_eq!(uv_of(&dir.join("notebook.sqlite3")), 0, "拒 = 零写");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prepare_mobile_catalog_rejects_below_floor_untouched() {
        let dir = tmp_dir("floor");
        let main = dir.join("notebook.sqlite3");
        let (ops_before, _) = build_old_db(&main, 27);
        let err = prepare_mobile_catalog(&dir).unwrap_err();
        assert_eq!(err.kind, StartupBlockKind::ResetRequired);
        assert!(err.message.contains("支持下限"), "{}", err.message);
        assert_eq!(uv_of(&main), 27, "拒 = 零写,uv 不动");
        let conn = Connection::open_with_flags(&main, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let ops: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        assert_eq!(ops, ops_before);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M2:任一候选比本程序新 = UpgradeRequired,且**旧的同伴一笔都不迁**——
    /// 绝不「先升级前面的库、再发现后面的必拒」。
    #[test]
    fn prepare_mobile_catalog_future_version_blocks_all_writes() {
        let dir = tmp_dir("future");
        let main = dir.join("notebook.sqlite3");
        build_old_db(&main, 28);
        let extra = dir.join("01JCCCCCCCCCCCCCCCCCCCCCCC.sqlite3");
        build_old_db(&extra, db::SCHEMA_VERSION);
        {
            let conn = Connection::open(&extra).unwrap();
            conn.pragma_update(None, "user_version", db::SCHEMA_VERSION + 1).unwrap();
        }
        let err = prepare_mobile_catalog(&dir).unwrap_err();
        assert_eq!(err.kind, StartupBlockKind::UpgradeRequired);
        assert!(err.message.contains("比本程序"), "{}", err.message);
        assert_eq!(uv_of(&main), 28, "预检拒 = 旧同伴零写(不许先迁 main 再发现拒)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M1:主库缺失 + 旧版附属空间在 = 目录残缺封锁,且附属空间**零写**
    /// (迁移在 fresh 判据之后,必封锁的目录一笔不写)。
    #[test]
    fn prepare_mobile_catalog_main_missing_leaves_old_sibling_untouched() {
        let dir = tmp_dir("nomain");
        let extra = dir.join("01JDDDDDDDDDDDDDDDDDDDDDDD.sqlite3");
        build_old_db(&extra, 28);
        let err = prepare_mobile_catalog(&dir).unwrap_err();
        assert_eq!(err.kind, StartupBlockKind::ResetRequired);
        assert!(err.message.contains("不完整"), "{}", err.message);
        assert!(!dir.join("notebook.sqlite3").exists(), "封锁路不许建库");
        assert_eq!(uv_of(&extra), 28, "封锁路不许迁移附属空间");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// L2:当前版库 = 零逻辑写(uv/oplog/items/**整面 schema** 原样;-shm sidecar
    /// 之类物理层不在断言面)。
    #[test]
    fn prepare_mobile_catalog_current_version_zero_logical_write() {
        let dir = tmp_dir("zerow");
        let main = dir.join("notebook.sqlite3");
        let (ops_before, items_before) = build_old_db(&main, db::SCHEMA_VERSION);
        let schema_fp = |conn: &Connection| -> (i64, String) {
            conn.query_row(
                "SELECT COUNT(*), COALESCE(GROUP_CONCAT(COALESCE(sql,''), ';'), '') \
                 FROM (SELECT sql FROM sqlite_master ORDER BY type, name)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        let fp_before = {
            let conn = Connection::open_with_flags(&main, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            schema_fp(&conn)
        };
        let cat = prepare_mobile_catalog(&dir).unwrap();
        assert_eq!(cat.spaces().len(), 1);
        assert_eq!(uv_of(&main), db::SCHEMA_VERSION);
        let conn = Connection::open_with_flags(&main, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let ops: i64 = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!((ops, items), (ops_before, items_before));
        assert_eq!(schema_fp(&conn), fp_before, "schema 整面指纹原样");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 空间名(0028 op-backed + 存量补发自愈,space-name-sync-plan §4.2/§5) ----

    fn space_ops(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM oplog WHERE entity = 'space'", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn create_space_name_is_op_backed_from_birth() {
        let dir = tmp_dir("name-birth");
        let (_id, path) = create_space(&dir, "  新空间  ").unwrap();
        let conn = crate::db::open(&path).unwrap();
        assert_eq!(space_name(&conn).unwrap().as_deref(), Some("新空间"), "入口 trim");
        assert_eq!(space_ops(&conn), 1, "建库命名从第一刻就是 op-backed(§4.2)");
        // battery 双向审计过(行⟺op;strict_battery 是 boot/epoch 同一套)。
        crate::sync::boot::strict_battery(&conn).unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn heal_legacy_space_name_migrates_once_and_is_idempotent() {
        let dir = tmp_dir("heal");
        let main = create_main_db(&dir).unwrap();
        let mut conn = crate::db::open(&main).unwrap();
        let mut clk = Clock::load(&conn).unwrap();
        // 无遗留 = 无事发生(fresh v28 库)。
        heal_legacy_space_name(&mut conn, &mut clk).unwrap();
        assert_eq!(space_ops(&conn), 0);
        // 模拟 v27 遗留(0028 迁移刻意不动 sync_meta,补发归本步)。
        conn.execute("INSERT INTO sync_meta (key, value) VALUES ('space_name', '老名字')", [])
            .unwrap();
        heal_legacy_space_name(&mut conn, &mut clk).unwrap();
        assert_eq!(space_name(&conn).unwrap().as_deref(), Some("老名字"));
        assert_eq!(space_ops(&conn), 1, "补发恰一条 op");
        let legacy: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_meta WHERE key = 'space_name'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy, 0, "旧 key 已删");
        // 幂等:再跑不重发。
        heal_legacy_space_name(&mut conn, &mut clk).unwrap();
        assert_eq!(space_ops(&conn), 1);
        crate::sync::boot::strict_battery(&conn).unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn heal_legacy_space_name_rejects_oversize_and_keeps_key() {
        let dir = tmp_dir("heal-over");
        let main = create_main_db(&dir).unwrap();
        let mut conn = crate::db::open(&main).unwrap();
        let mut clk = Clock::load(&conn).unwrap();
        let long = "长".repeat(70); // 210 字节 > 200 上限
        conn.execute("INSERT INTO sync_meta (key, value) VALUES ('space_name', ?1)", [&long])
            .unwrap();
        let err = heal_legacy_space_name(&mut conn, &mut clk).unwrap_err();
        assert!(err.contains("超长"), "响亮拒:{err}");
        // 失败整体回滚:旧 key 完整保留、无行无 op(绝不「行有 op 无」)。
        let legacy: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_meta WHERE key = 'space_name'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy, 1);
        assert_eq!(space_name(&conn).unwrap(), None);
        assert_eq!(space_ops(&conn), 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// codex 实现审 M3:非空遗留值**原样**裁决(带首尾空白 = 响亮拒、不代 trim);
    /// 纯空白 = 显式「无名」政策(清 key、不合成 op)。
    #[test]
    fn heal_legacy_space_name_verbatim_and_whitespace_policy() {
        // 带首尾空白:拒开库、key 原样保留(绝不静默规范化)。
        let dir = tmp_dir("heal-pad");
        let main = create_main_db(&dir).unwrap();
        let mut conn = crate::db::open(&main).unwrap();
        let mut clk = Clock::load(&conn).unwrap();
        conn.execute("INSERT INTO sync_meta (key, value) VALUES ('space_name', ' 家庭 ')", [])
            .unwrap();
        let err = heal_legacy_space_name(&mut conn, &mut clk).unwrap_err();
        assert!(err.contains("空白"), "原样裁决响亮拒:{err}");
        let legacy: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key = 'space_name'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy, " 家庭 ", "key 原样保留");
        assert_eq!(space_ops(&conn), 0);
        // 纯空白:按「无名」恢复——清 key、零行零 op。
        conn.execute("UPDATE sync_meta SET value = '   ' WHERE key = 'space_name'", []).unwrap();
        heal_legacy_space_name(&mut conn, &mut clk).unwrap();
        let gone: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_meta WHERE key = 'space_name'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(gone, 0);
        assert_eq!(space_name(&conn).unwrap(), None);
        assert_eq!(space_ops(&conn), 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ulid_whitelist_is_strict() {
        assert!(is_ulid_name("01JT0000000000000000000000"));
        assert!(is_ulid_name("7ZZZZZZZZZZZZZZZZZZZZZZZZZ")); // 数值上限
        assert!(!is_ulid_name("notebook")); // 主库名不是 ULID
        assert!(!is_ulid_name("01jt0000000000000000000000")); // 小写不认(规范形态才认)
        assert!(!is_ulid_name("01JT000000000000000000000")); // 25 位
        assert!(!is_ulid_name("01JT00000000000000000000000")); // 27 位
        assert!(!is_ulid_name("01JT00000000000000000000I0")); // I 不在 Crockford 表
        assert!(!is_ulid_name("8ZZZZZZZZZZZZZZZZZZZZZZZZZ")); // 首字符 >7 = 128bit 溢出
        assert!(!is_ulid_name("ZZZZZZZZZZZZZZZZZZZZZZZZZZ"));
        assert!(!is_ulid_name("boot-snapshot-01JT00000000")); // boot 残留形态
    }

    #[test]
    fn vetoes_same_file_device_account() {
        let dir = tmp_dir("vetoes");
        let all = [
            ident(&dir, "main", "notebook.sqlite3", "DEV1", Some("ACC1")),
            ident(&dir, "01A", "notebook.sqlite3", "DEV2", None), // 同文件 → hard
            ident(&dir, "01B", "b.sqlite3", "DEV1", None),        // 同设备身份 → soft
            ident(&dir, "01C", "c.sqlite3", "DEV3", Some("ACC1")), // 同账户 → soft
        ];
        let v = identity_vetoes(&all);
        assert!(!v.contains_key("main"), "主库排第一永不被 veto");
        assert!(matches!(&v["01A"], Veto::Hard(m) if m.contains("同一个库文件")));
        assert!(matches!(&v["01B"], Veto::Soft(m) if m.contains("device_id")));
        assert!(matches!(&v["01C"], Veto::Soft(m) if m.contains("同一个同步账户")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hardlink_is_same_file_hard_veto() {
        // canonicalize 归一不了 hardlink,身份判定必须走物理文件身份(dev+ino /
        // volume+index)。
        let dir = tmp_dir("hardlink");
        std::fs::write(dir.join("notebook.sqlite3"), b"x").unwrap();
        std::fs::hard_link(dir.join("notebook.sqlite3"), dir.join("01ZLINK.sqlite3")).unwrap();
        let all = [
            ident(&dir, "main", "notebook.sqlite3", "DEV1", None),
            ident(&dir, "01A", "01ZLINK.sqlite3", "DEV2", None),
        ];
        let v = identity_vetoes(&all);
        assert!(matches!(&v["01A"], Veto::Hard(_)), "hardlink 必须判成同库:{:?}", v.keys());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vetoed_space_does_not_reserve_identity() {
        // 被 veto 者不占坑:01A 与 main 同文件被 hard 掉后,01B 与「01A 的 device」
        // 相同不算撞(那个身份从未被接受)。
        let dir = tmp_dir("noreserve");
        let all = [
            ident(&dir, "main", "notebook.sqlite3", "DEV1", None),
            ident(&dir, "01A", "notebook.sqlite3", "DEVX", None),
            ident(&dir, "01B", "b.sqlite3", "DEVX", None),
        ];
        let v = identity_vetoes(&all);
        assert!(matches!(&v["01A"], Veto::Hard(_)));
        assert!(!v.contains_key("01B"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vetoes_clean_set_is_empty() {
        let dir = tmp_dir("clean");
        let all = [
            ident(&dir, "main", "notebook.sqlite3", "DEV1", Some("ACC1")),
            ident(&dir, "01A", "a.sqlite3", "DEV2", Some("ACC2")),
        ];
        assert!(identity_vetoes(&all).is_empty());
        // 未配置账户(None)彼此不算撞。
        let none = [
            ident(&dir, "main", "notebook.sqlite3", "DEV1", None),
            ident(&dir, "01A", "a.sqlite3", "DEV2", None),
        ];
        assert!(identity_vetoes(&none).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discover_whitelists_and_caps() {
        let dir = tmp_dir("discover");
        let main = dir.join("notebook.sqlite3");
        std::fs::write(&main, b"x").unwrap();
        // 白名单外的文件全被无视(boot 残留 / 备份 / wal / 小写 / 建库暂存)。小写例
        // 的字母序列刻意与下面的大写合法库不同名:Windows 文件系统大小写不敏感,
        // 同序列的大小写两个名字是同一个文件。
        for junk in [
            "boot-snapshot-01JT0000000000000000000000.sqlite3",
            "boot-recv-01JT0000000000000000000000.sqlite3",
            "notebook-backup.sqlite3",
            "notebook.sqlite3-wal",
            "01zz0000000000000000000000.sqlite3",
            ".creating-01JT0000000000000000000009.sqlite3",
        ] {
            std::fs::write(dir.join(junk), b"x").unwrap();
        }
        let found = discover(&main, Some(&dir), Some(2)).unwrap();
        assert_eq!(found.len(), 1, "只有主库:{found:?}");

        // 一个合法 ULID 库 → 两空间;两个 → 超上限响亮报错(泛测 cap 机制本身,
        // 传 Some(2) 只为压边界;两壳生产都传 None 不设上限)。
        std::fs::write(dir.join("01JT0000000000000000000000.sqlite3"), b"x").unwrap();
        let found = discover(&main, Some(&dir), Some(2)).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].0, MAIN_SPACE, "主库恒排第一");
        assert_eq!(found[1].0, "01JT0000000000000000000000");

        std::fs::write(dir.join("01JT0000000000000000000001.sqlite3"), b"x").unwrap();
        let err = discover(&main, Some(&dir), Some(2)).unwrap_err();
        assert!(err.contains("超过本版本上限"), "{err}");
        // 手机无产品上限(max=None):同一目录三库照常全发现。
        let found = discover(&main, Some(&dir), None).unwrap();
        assert_eq!(found.len(), 3);

        // e2e 模式(scan_dir=None):同一目录再乱也只有主库。
        let found = discover(&main, None, Some(2)).unwrap();
        assert_eq!(found.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_space_stages_migrates_then_renames() {
        let dir = tmp_dir("create");
        let (id, path) = create_space(&dir, "  家庭  ").unwrap();
        assert!(is_ulid_name(&id));
        assert_eq!(path, dir.join(format!("{id}.sqlite3")));
        assert!(path.exists());
        // staging 与 journal 不残留;不切 WAL 故无 -wal/-shm。
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != &format!("{id}.sqlite3"))
            .collect();
        assert!(leftovers.is_empty(), "建库不留任何暂存/journal:{leftovers:?}");
        // 只读描述符即读得出:恰为当前版本、device_id 已生成、显示名已 trim 落行。
        let d = read_descriptor(&id, &path).unwrap();
        assert_eq!(d.name.as_deref(), Some("家庭"));
        assert!(!d.device_id.is_empty());
        assert_eq!(d.account_id, None, "同步不自动配");
        // 发现层认它。
        let main = dir.join("notebook.sqlite3");
        std::fs::write(&main, b"x").unwrap();
        let found = discover(&main, Some(&dir), Some(2)).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[1].0, id);
        // 空名拒。
        assert!(create_space(&dir, "   ").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- JoiningSlot(space-entry-plan §3.1/§3.4) ----

    /// 幸福路:建槽(零名字 op / DELETE journal / 零配置)→ close → publish →
    /// 正式库被发现层认、描述符可读;staging 无残留。
    #[test]
    fn joining_slot_create_close_publish_roundtrip() {
        let dir = tmp_dir("join-happy");
        let slot = JoiningSlot::create(&dir).unwrap();
        let id = slot.id().to_string();
        assert!(is_ulid_name(&id));
        assert!(slot.staging_path().exists());
        {
            let db = slot.db();
            let conn = db.lock().unwrap();
            let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
            assert_eq!(mode, "delete", "槽全程 DELETE journal");
            let n: i64 =
                conn.query_row("SELECT COUNT(*) FROM space_profile", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "槽零名字");
        }
        let closed = slot.close().unwrap_or_else(|f| panic!("close 应过:{}", f.error));
        let published = closed.publish().unwrap_or_else(|(_, e)| panic!("publish 应过:{e}"));
        assert_eq!(published.id, id);
        assert!(published.cleanup_error.is_none(), "{:?}", published.cleanup_error);
        assert!(published.path.exists());
        // 全目录只剩正式库(staging 名已清)。
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![format!("{id}.sqlite3")], "无 staging 残留:{names:?}");
        let d = read_descriptor(&id, &published.path).unwrap();
        assert_eq!(d.name, None, "槽零名字:账户名只随 boot 到达");
        assert_eq!(d.account_id, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// typestate 关闭证明:残留 Arc(db 或 clock)= close 拒且槽所有权原样返还
    /// (publish 只在 Closed 态上,类型层面「close 失败绝不 publish」);放掉残留
    /// clone 后重试即过。
    #[test]
    fn joining_slot_close_refuses_while_referenced() {
        let dir = tmp_dir("join-refs");
        let slot = JoiningSlot::create(&dir).unwrap();
        let held_db = slot.db();
        let f = slot.close().expect_err("db Arc 残留必拒");
        assert!(f.error.contains("连接仍被引用"), "{}", f.error);
        let slot = f.slot;
        drop(held_db);
        let held_clock = slot.clock();
        let f = slot.close().expect_err("clock Arc 残留必拒");
        assert!(f.error.contains("时钟仍被引用"), "{}", f.error);
        let slot = f.slot;
        drop(held_clock);
        // 失败返还的槽完好可续用:连接照常可查,close 重试即过。
        {
            let db = slot.db();
            let conn = db.lock().unwrap();
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0);
        }
        let closed = slot.close().unwrap_or_else(|f| panic!("放净后 close 应过:{}", f.error));
        closed.abort().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// abort 严格删除:成功后目录零残留;连接被别人攥着时 Err 如实报(不谎称无痕)。
    #[test]
    fn joining_slot_abort_is_strict() {
        let dir = tmp_dir("join-abort");
        let slot = JoiningSlot::create(&dir).unwrap();
        let held = slot.db();
        let err = slot.abort().expect_err("连接被引用时 abort 必须如实失败");
        assert!(err.contains("仍被引用"), "{err}");
        drop(held);
        // 槽已被 abort 消费(文件留给启动清扫);严格清扫把它收干净。
        sweep_stale_joining(&dir).unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        // 干净 abort:零残留。
        let slot = JoiningSlot::create(&dir).unwrap();
        slot.abort().unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// close 失败路的「返还可续用」合同(codex 一轮 M2 的行为面):出口复核失败
    /// (WAL 残留注入)→ CloseFailure 返还槽;清除障碍后**重试 close 即过**、可
    /// publish——失败绝不留下残废槽。(Connection::close 本体的失败无法用安全 API
    /// 注入,其返还路径由同一段代码结构背书,见 close 内注释。)
    #[test]
    fn joining_slot_close_failure_is_retryable() {
        let dir = tmp_dir("join-retry");
        let slot = JoiningSlot::create(&dir).unwrap();
        let wal = {
            let mut s = slot.staging_path().as_os_str().to_os_string();
            s.push("-wal");
            PathBuf::from(s)
        };
        std::fs::write(&wal, b"fake").unwrap();
        let f = slot.close().expect_err("WAL 残留必拒(DELETE journal 合同)");
        assert!(f.error.contains("残留"), "{}", f.error);
        std::fs::remove_file(&wal).unwrap();
        let closed = f.slot.close().unwrap_or_else(|f| panic!("清障后重试应过:{}", f.error));
        let published = closed.publish().unwrap_or_else(|(_, e)| panic!("{e}"));
        assert!(published.path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 桌面发布不是单步(§3.1):hard_link 成功后 staging unlink 失败 = 已发布 +
    /// `cleanup_error`,**绝不当作未发布**。注入:Windows 上用不带 FILE_SHARE_DELETE
    /// 的句柄占住 staging 名(std File::open 即是),删除必败。
    #[cfg(windows)]
    #[test]
    fn publish_reports_cleanup_error_when_staging_unlink_blocked() {
        let dir = tmp_dir("join-unlink");
        let slot = JoiningSlot::create(&dir).unwrap();
        let staging = slot.staging_path().to_path_buf();
        let closed = slot.close().unwrap_or_else(|f| panic!("{}", f.error));
        // std 默认 share_mode 含 FILE_SHARE_DELETE(删得动),注入须显式收窄。
        let hold = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0x1) // FILE_SHARE_READ:不许并发删除
                .open(&staging)
                .unwrap()
        };
        let published = closed.publish().unwrap_or_else(|(_, e)| panic!("发布本体应成功:{e}"));
        assert!(published.path.exists(), "空间已真实发布");
        assert!(
            published.cleanup_error.is_some(),
            "unlink 被占住必须如实报 cleanup_error,不许静默"
        );
        drop(hold);
        sweep_stale_joining(&dir).unwrap();
        assert!(!staging.exists(), "启动清扫补删 staging 名(与正式库同 inode,库无损)");
        assert!(published.path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// publish no-clobber:目标已存在(撞名)= Err 且槽返还,既有库一个字节不动。
    #[test]
    fn joining_slot_publish_never_clobbers() {
        let dir = tmp_dir("join-clobber");
        let slot = JoiningSlot::create(&dir).unwrap();
        let target = dir.join(format!("{}.sqlite3", slot.id()));
        std::fs::write(&target, b"pre-existing").unwrap();
        let closed = slot.close().unwrap_or_else(|f| panic!("{}", f.error));
        let (closed, err) = closed.publish().expect_err("目标在场必拒");
        assert!(err.contains("发布失败"), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), b"pre-existing", "既有文件不动");
        closed.abort().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 严格清扫:`.joining-*` 全套(主文件/journal/wal/shm)清光,正式库与
    /// `.creating-*`(归 sweep_stale_creating 管)不动;发现层从不认 `.joining-*`。
    #[test]
    fn sweep_stale_joining_clears_slots_only() {
        let dir = tmp_dir("join-sweep");
        let ulid = "01JT0000000000000000000000";
        for f in [
            format!(".joining-{ulid}.sqlite3"),
            format!(".joining-{ulid}.sqlite3-journal"),
            format!(".joining-{ulid}.sqlite3-wal"),
            format!(".joining-{ulid}.sqlite3-shm"),
        ] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        std::fs::write(dir.join(format!("{ulid}.sqlite3")), b"formal").unwrap();
        std::fs::write(dir.join(".creating-x.sqlite3"), b"x").unwrap();
        // 发现层不认 .joining-*(publish 前用户不可见)。
        let main = dir.join("notebook.sqlite3");
        std::fs::write(&main, b"m").unwrap();
        let found = discover(&main, Some(&dir), None).unwrap();
        assert_eq!(found.len(), 2, "只有 main + 正式库:{found:?}");
        sweep_stale_joining(&dir).unwrap();
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                ".creating-x.sqlite3".to_string(),
                format!("{ulid}.sqlite3"),
                "notebook.sqlite3".to_string()
            ],
            "槽全清、其余不动"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_removes_stale_creating_files() {
        let dir = tmp_dir("sweep");
        std::fs::write(dir.join(".creating-01JT0000000000000000000000.sqlite3"), b"x").unwrap();
        std::fs::write(dir.join(".creating-01JT0000000000000000000000.sqlite3-journal"), b"x").unwrap();
        std::fs::write(dir.join("01JT0000000000000000000000.sqlite3"), b"x").unwrap();
        sweep_stale_creating(&dir);
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["01JT0000000000000000000000.sqlite3".to_string()], "正式库不动、暂存全清");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 重置孤儿(epoch-plan §7):主库不在的 -wal/-shm 是「删主库提交点之后」崩溃
    /// 的残渣,启动扫掉;主库还在的 -wal/-shm 是活库的一部分,**绝不能动**。
    #[test]
    fn sweep_clears_orphan_wal_but_keeps_live_sidecars() {
        let dir = tmp_dir("sweep-orphan");
        std::fs::write(dir.join("01JT0000000000000000000000.sqlite3-wal"), b"x").unwrap();
        std::fs::write(dir.join("01JT0000000000000000000000.sqlite3-shm"), b"x").unwrap();
        std::fs::write(dir.join("notebook.sqlite3"), b"x").unwrap();
        std::fs::write(dir.join("notebook.sqlite3-wal"), b"x").unwrap();
        sweep_stale_creating(&dir);
        assert!(!dir.join("01JT0000000000000000000000.sqlite3-wal").exists(), "孤儿 wal 清");
        assert!(!dir.join("01JT0000000000000000000000.sqlite3-shm").exists(), "孤儿 shm 清");
        assert!(dir.join("notebook.sqlite3-wal").exists(), "活库的 wal 一根手指都不能动");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 空间重置(epoch-plan §7) ----

    #[test]
    fn reset_space_files_removes_three_and_is_idempotent() {
        let dir = tmp_dir("reset-sp");
        let (id, path) = create_space(&dir, "要重置的").unwrap();
        {
            let mut conn = crate::db::open(&path).unwrap();
            let mut clk = Clock::load(&conn).unwrap();
            set_space_name(&mut conn, &mut clk, "改个名").unwrap();
        }
        // 正常关连接 SQLite 会自删 -wal/-shm;强杀进程会留下——手造残留模拟后者。
        std::fs::write(dir.join(format!("{id}.sqlite3-wal")), b"x").unwrap();
        std::fs::write(dir.join(format!("{id}.sqlite3-shm")), b"x").unwrap();
        reset_space_files(&dir, &id).unwrap();
        for suffix in ["", "-wal", "-shm"] {
            assert!(!dir.join(format!("{id}.sqlite3{suffix}")).exists(), "三件套全除:{suffix}");
        }
        // 幂等(恢复路径重跑):不存在不报错。
        reset_space_files(&dir, &id).unwrap();
        // main 与坏 id 响亮拒。
        assert!(reset_space_files(&dir, MAIN_SPACE).unwrap_err().contains("reset_main_files"));
        assert!(reset_space_files(&dir, "not-a-ulid").unwrap_err().contains("形态"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// main 重置的 journal 续完:每个崩溃点(journal 后/删旧后/staging 残留)重启
    /// 恢复都收敛到「fresh 未配置空库 + journal 已清」;无 journal 时恢复是 no-op
    /// (阴性对照:已有数据一字不动)。
    #[test]
    fn reset_main_journal_resume_completes_at_every_crash_point() {
        // 阴性对照:无 journal,resume 不碰任何文件。
        let dir = tmp_dir("reset-main-noop");
        let main = create_main_db(&dir).unwrap();
        {
            let mut conn = crate::db::open(&main).unwrap();
            let mut clk = Clock::load(&conn).unwrap();
            set_space_name(&mut conn, &mut clk, "有数据").unwrap();
        }
        assert!(!resume_main_reset(&dir).unwrap(), "无 journal = no-op");
        {
            let conn = crate::db::open(&main).unwrap();
            assert_eq!(space_name(&conn).unwrap().as_deref(), Some("有数据"), "数据不动");
        }
        let _ = std::fs::remove_dir_all(&dir);

        // 崩溃点逐个模拟:每个点之后 resume 都续完到同一终态。
        let fresh_and_clean = |dir: &Path| {
            assert!(!dir.join(RESET_MAIN_JOURNAL).exists(), "journal 已清");
            let conn = crate::db::open(&dir.join("notebook.sqlite3")).unwrap();
            assert_eq!(space_name(&conn).unwrap(), None, "重建的是未配置空库");
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0);
            assert!(
                crate::sync::transport::account_id(&conn).unwrap().is_none(),
                "配置四元组全空"
            );
        };
        // ① journal 刚落盘就崩(旧库还在)。
        let dir = tmp_dir("reset-main-p1");
        let main = create_main_db(&dir).unwrap();
        {
            let mut conn = crate::db::open(&main).unwrap();
            let mut clk = Clock::load(&conn).unwrap();
            set_space_name(&mut conn, &mut clk, "旧数据").unwrap();
        }
        std::fs::write(dir.join(RESET_MAIN_JOURNAL), b"").unwrap();
        assert!(resume_main_reset(&dir).unwrap());
        fresh_and_clean(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        // ② 旧三件套已删、新库未建就崩。
        let dir = tmp_dir("reset-main-p2");
        std::fs::write(dir.join(RESET_MAIN_JOURNAL), b"").unwrap();
        assert!(resume_main_reset(&dir).unwrap());
        fresh_and_clean(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        // ③ create_main_db 的 staging 残留(半成品)在场。
        let dir = tmp_dir("reset-main-p3");
        std::fs::write(dir.join(RESET_MAIN_JOURNAL), b"").unwrap();
        std::fs::write(dir.join(".creating-main.sqlite3"), b"half").unwrap();
        assert!(resume_main_reset(&dir).unwrap());
        fresh_and_clean(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        // ④ 正路一次走完(有旧数据 → fresh)。
        let dir = tmp_dir("reset-main-p4");
        let main = create_main_db(&dir).unwrap();
        {
            let mut conn = crate::db::open(&main).unwrap();
            let mut clk = Clock::load(&conn).unwrap();
            set_space_name(&mut conn, &mut clk, "旧数据").unwrap();
        }
        reset_main_files(&dir).unwrap();
        fresh_and_clean(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_descriptor_rejects_version_mismatch_and_incomplete() {
        let dir = tmp_dir("desc");
        // 旧版本库(迁到 25 为止)→ exact-match 拒,人话带两个版本号。
        let old = dir.join("old.sqlite3");
        {
            let conn = Connection::open(&old).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, db::SCHEMA_VERSION - 1).unwrap();
        }
        let err = read_descriptor("01OLD", &old).unwrap_err();
        assert!(err.contains("数据版本") && err.contains("重新配对"), "{err}");
        // 当前版本但从未生成 device_id → 库不完整拒。
        let bare = dir.join("bare.sqlite3");
        {
            let conn = Connection::open(&bare).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, i64::MAX).unwrap();
        }
        let err = read_descriptor("01BARE", &bare).unwrap_err();
        assert!(err.contains("device_id"), "{err}");
        // 版本号声称当前、实际只是壳子库(缺核心表)→ 拒(M4:不能只信整数)。
        let husk = dir.join("husk.sqlite3");
        {
            let conn = Connection::open(&husk).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 PRAGMA user_version = {};",
                db::SCHEMA_VERSION
            ))
            .unwrap();
        }
        let err = read_descriptor("01HUSK", &husk).unwrap_err();
        assert!(err.contains("缺核心表"), "{err}");
        // device_id 不是规范 ULID(被改动过的库)→ 拒。
        let odd = dir.join("odd.sqlite3");
        {
            let conn = Connection::open(&odd).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, i64::MAX).unwrap();
            conn.execute("INSERT INTO sync_meta(key,value) VALUES('device_id','not-a-ulid')", [])
                .unwrap();
        }
        let err = read_descriptor("01ODD", &odd).unwrap_err();
        assert!(err.contains("规范 ULID"), "{err}");
        // 半套同步配置(有 account_id 缺其余键)→ catalog 就拒,不拖到 transport 才炸。
        let half = dir.join("half.sqlite3");
        {
            let conn = Connection::open(&half).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, i64::MAX).unwrap();
            crate::clock::Clock::load(&conn).unwrap();
            conn.execute(
                "INSERT INTO sync_meta(key,value) VALUES('account_id','01AAAAAAAAAAAAAAAAAAAAACCT')",
                [],
            )
            .unwrap();
        }
        let err = read_descriptor("01HALF", &half).unwrap_err();
        assert!(err.contains("残缺"), "{err}");
        // 孤儿密钥(无 account_id 却残留 k_acc)同样是「部分键」→ 拒。
        let orphan = dir.join("orphan.sqlite3");
        {
            let conn = Connection::open(&orphan).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, i64::MAX).unwrap();
            crate::clock::Clock::load(&conn).unwrap();
            conn.execute(
                &format!("INSERT INTO sync_meta(key,value) VALUES('k_acc','{}')", "00".repeat(32)),
                [],
            )
            .unwrap();
        }
        let err = read_descriptor("01ORPH", &orphan).unwrap_err();
        assert!(err.contains("残缺"), "{err}");
        // 四键齐但密钥不是合法 hex32 → catalog 就拒,不拖到 transport 解码才炸。
        let badhex = dir.join("badhex.sqlite3");
        {
            let conn = Connection::open(&badhex).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, i64::MAX).unwrap();
            crate::clock::Clock::load(&conn).unwrap();
            conn.execute_batch(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','01AAAAAAAAAAAAAAAAAAAAACCT'),
                   ('k_acc','zz'),('device_key','zz'),('server_url','ws://x');",
            )
            .unwrap();
        }
        let err = read_descriptor("01HEX", &badhex).unwrap_err();
        assert!(err.contains("密钥形态"), "{err}");
        // 只缺 0022 的回放豁免标志表(触发器依赖):版本/其余表全对也拒。
        let noflag = dir.join("noflag.sqlite3");
        {
            let conn = Connection::open(&noflag).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, i64::MAX).unwrap();
            crate::clock::Clock::load(&conn).unwrap();
            conn.execute_batch("DROP TABLE sync_replay_active;").unwrap();
        }
        let err = read_descriptor("01FLAG", &noflag).unwrap_err();
        assert!(err.contains("缺核心表"), "{err}");
        // 不存在的文件:只读打开响亮失败,绝不隐式建库。
        assert!(read_descriptor("01NONE", &dir.join("none.sqlite3")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn catalog_load_all_or_nothing() {
        let dir = tmp_dir("catalog");
        let main = dir.join("notebook.sqlite3");
        // 主库缺席 = Err:catalog 是只读层,fresh 建库归壳(先建再来)。
        assert!(SpaceCatalog::load(&main, Some(&dir), None).is_err());
        // 主库(db::open 正道:WAL)+ 一个正式空间 → Ok,主库恒第一。
        {
            let conn = db::open(&main).unwrap();
            crate::clock::Clock::load(&conn).unwrap();
        }
        let (id, _path) = create_space(&dir, "家庭").unwrap();
        let cat = SpaceCatalog::load(&main, Some(&dir), None).unwrap();
        assert_eq!(cat.spaces.len(), 2);
        assert_eq!(cat.main().id, MAIN_SPACE);
        assert_eq!(cat.spaces[1].id, id);
        // 任一候选坏(旧版本库)→ 整体 Err——不给壳「忽略这个空间」的组合空间,
        // 哪怕主库与家庭空间都完好(M5 约定的锚)。
        let old = dir.join("01JT0000000000000000000000.sqlite3");
        {
            let conn = Connection::open(&old).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, db::SCHEMA_VERSION - 1).unwrap();
        }
        let err = SpaceCatalog::load(&main, Some(&dir), None).unwrap_err();
        assert!(err.contains("数据版本"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_space_verifies_before_first_write() {
        let dir = tmp_dir("open-space");
        let (id, path) = create_space(&dir, "家庭").unwrap();
        let desc = read_descriptor(&id, &path).unwrap();
        // 正道:验过才切 WAL。
        {
            let conn = open_space(&desc).unwrap();
            let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
            assert_eq!(mode, "wal");
        }
        // catalog 之后文件被换成旧版库:必须在任何写入/切 WAL 之前拒,被换的库一个
        // 字节都不许动(H1 锚——db::open 会把它迁到当前版本「救活」,这正是要防的)。
        std::fs::remove_file(&path).unwrap();
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, db::SCHEMA_VERSION - 1).unwrap();
        }
        let err = open_space(&desc).unwrap_err();
        assert!(err.contains("数据版本"), "{err}");
        {
            let conn = Connection::open(&path).unwrap();
            let uv: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
            assert_eq!(uv, db::SCHEMA_VERSION - 1, "被换的旧库不许被迁移动过");
            let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
            assert_eq!(mode, "delete", "被换的旧库不许被切 WAL");
        }
        // 版本恰好当前但换了 inode(同名重建):物理身份与 descriptor 不符 → 拒。
        std::fs::remove_file(&path).unwrap();
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "foreign_keys", true).unwrap();
            db::run_migrations(&conn, i64::MAX).unwrap();
            Clock::load(&conn).unwrap();
        }
        let err = open_space(&desc).unwrap_err();
        assert!(err.contains("被替换"), "{err}");
        // 文件缺席:NO_CREATE,绝不隐式建库。
        std::fs::remove_file(&path).unwrap();
        assert!(open_space(&desc).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn catalog_load_fail_closed_on_identity_collision() {
        let dir = tmp_dir("catalog-veto");
        let main = dir.join("notebook.sqlite3");
        {
            let conn = db::open(&main).unwrap();
            crate::clock::Clock::load(&conn).unwrap();
        }
        let (id, fam) = create_space(&dir, "家庭").unwrap();
        // 同账户两库:桌面政策只是 Soft(停同步本地照用),严格 catalog 一律整体拒。
        for p in [&main, &fam] {
            let conn = Connection::open(p).unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','01AAAAAAAAAAAAAAAAAAAAACCT'),
                   ('k_acc','{z}'),('device_key','{z}'),('server_url','wss://x');",
                z = "00".repeat(32),
            ))
            .unwrap();
        }
        let err = SpaceCatalog::load(&main, Some(&dir), None).unwrap_err();
        assert!(err.contains(&id) && err.contains("同一个同步账户"), "{err}");
        // 撤掉账户撞车 → Ok;再造 hardlink 第二名(Hard)→ 又整体拒。
        {
            let conn = Connection::open(&fam).unwrap();
            conn.execute("DELETE FROM sync_meta WHERE key IN ('account_id','k_acc','device_key','server_url')", [])
                .unwrap();
        }
        assert!(SpaceCatalog::load(&main, Some(&dir), None).is_ok());
        let link = dir.join("01JT0000000000000000000001.sqlite3");
        std::fs::hard_link(&main, &link).unwrap();
        let err = SpaceCatalog::load(&main, Some(&dir), None).unwrap_err();
        assert!(err.contains("同一个库文件"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writer_lease_is_exclusive_until_released() {
        let dir = tmp_dir("lease");
        let lock = dir.join("writer.lock");
        let held = WriterLease::acquire(&lock).unwrap();
        let err = WriterLease::acquire(&lock).unwrap_err();
        assert!(err.contains("另一个朱笺进程"), "{err}");
        drop(held);
        let _again = WriterLease::acquire(&lock).unwrap();
        assert!(lock.exists(), "锁文件永不 unlink");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
