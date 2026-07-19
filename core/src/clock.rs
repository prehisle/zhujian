//! 设备身份 + HLC 混合逻辑时钟 —— sync-plan P1「device_id + HLC 时钟模块」(一切合并的前提)。
//!
//! 同步的合并规则是字段级 LWW:谁「后写」谁赢,且所有设备必须各自独立得出同一结论。
//! 墙钟不可信(设备间偏差 / NTP 回拨 / 手动改时),单靠墙钟会把用户更新的编辑判输给
//! 旧值。HLC 用 (墙钟毫秒, 逻辑计数器) 两级时间戳补上因果:
//!   * 取号 tick(本地写一次):墙钟前进 → (now, 0);墙钟停滞/回拨 → 冻结墙钟分量、
//!     计数器 +1。本机发出的时间戳严格单调,时钟回拨也不破。
//!   * 观察 observe(见到远端 op):把本机水位推到 max(自己, 远端)。因果由此而来——
//!     凡是见过的 op,之后本地取的号必然更大,「新编辑被旧值吃掉」不可能发生。
//!   * 全序:按 (wall_ms, counter, device_id) 比较,平局由 device_id 确定性裁决,
//!     所有设备结论一致。
//!
//! 状态两行落在 sync_meta(迁移 0019):`device_id` 首启生成、触发器冻结永不改写;
//! `last_hlc` 是本机已发出/已见过的最大时间戳水位,每次取号/观察随调用方连接落盘——
//! 崩溃 + 时钟回拨叠加时,重启从它恢复,永不发出倒退的时间戳。
//!
//! 分工注记:op_id(ULID)是 op 的**身份**(去重、水位向量数「收到第几条」),HLC 是
//! **排序轴**(LWW 比大小只看它)。ULID 生成时只取一次墙钟、不做观察,保证不了因果,
//! 两者并存于 op 结构、不互相替代。
use rusqlite::{Connection, OptionalExtension};
use ulid::Ulid;

/// 一枚 HLC 时间戳。**字段顺序就是比较优先级**(derive Ord 按声明序逐字段比):
/// wall_ms → counter → device_id,勿调整字段顺序。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hlc {
    pub wall_ms: u64,
    pub counter: u32,
    pub device_id: String,
}

impl Hlc {
    /// 定长可排序编码 `{13位hex毫秒}-{8位hex计数器}-{device_id}`:定宽 + hex 小写
    /// 保证**字典序 == 逻辑序**,SQLite 文本列直接 ORDER BY 即得 HLC 全序,不必解析。
    pub fn encode(&self) -> String {
        format!("{}-{}", encode_watermark(self.wall_ms, self.counter), self.device_id)
    }

    /// 解析 `encode` 的输出;非规范形态(大写 hex、错位分隔符)一律拒。
    /// **device_id 形状收紧(epoch-plan §5.1 core #5)**:恰 26 字符规范 Crockford
    /// base32(ULID 形态,大写、无 I/L/O/U)——设备身份只出自 `Ulid::new()`,任何
    /// 别的形状都是伪造;不收紧则每个伪造 origin 白得一份水位/池/挂起状态,
    /// 「伪造无限 origin」的内存 DoS 从这里开闸。
    /// 生产调用方:replay(远端 op 的 hlc 入水位前必先过它)与 engine 的入池硬校验。
    pub fn parse(s: &str) -> Result<Hlc, String> {
        let bad = || format!("非法的 HLC 编码:{s}");
        if s.len() != 23 + 26 || !s.is_ascii() || s.as_bytes()[22] != b'-' {
            return Err(bad());
        }
        let (wall_ms, counter) = parse_watermark(&s[..22]).map_err(|_| bad())?;
        let device = &s[23..];
        if !device.bytes().all(is_crockford_upper) {
            return Err(bad());
        }
        Ok(Hlc { wall_ms, counter, device_id: device.to_string() })
    }
}

/// 规范 Crockford base32 字母表(ULID 编码字符集):0-9 + 大写 A-Z 去 I/L/O/U。
const fn is_crockford_upper(b: u8) -> bool {
    matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
}

/// 本机的 HLC 时钟:设备身份 + 已发出/已见过的最大时间戳水位。
/// 水位每次变动都随调用方连接写回 sync_meta(将来与 op 落库同一事务),崩溃不倒退。
pub struct Clock {
    device_id: String,
    last_wall_ms: u64,
    last_counter: u32,
}

impl Clock {
    /// 从库加载(含首启初始化):device_id 缺失 = 首次启动,生成 ULID 落库;
    /// last_hlc 缺失 = 从未取过号,水位从零起(下次 tick 自然抬到当前墙钟)。
    /// sync_meta 内容损坏 = fail-fast 报错,不猜不修。
    pub fn load(conn: &Connection) -> Result<Clock, String> {
        let device_id = match meta_get(conn, "device_id")? {
            Some(v) => v,
            None => {
                let id = Ulid::new().to_string();
                meta_insert(conn, "device_id", &id)?;
                id
            }
        };
        let (last_wall_ms, last_counter) = match meta_get(conn, "last_hlc")? {
            Some(v) => parse_watermark(&v)?,
            None => (0, 0),
        };
        Ok(Clock { device_id, last_wall_ms, last_counter })
    }

    /// 本设备的永久身份(engine 装配 / transport 鉴权 / oplog 取号都读它)。
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// 本地写一次,取一枚新时间戳——严格大于本机已发出/已见过的一切,水位落盘。
    pub fn tick(&mut self, conn: &Connection) -> Result<Hlc, String> {
        self.tick_at(conn, wall_now_ms())
    }

    fn tick_at(&mut self, conn: &Connection, now_ms: u64) -> Result<Hlc, String> {
        if now_ms > self.last_wall_ms {
            self.last_wall_ms = now_ms;
            self.last_counter = 0;
        } else {
            // 墙钟停滞(同毫秒连续写)或回拨:冻结墙钟分量,计数器顶上。
            self.last_counter = self
                .last_counter
                .checked_add(1)
                .expect("HLC 计数器溢出——同一墙钟毫秒内取号超过 u32 上限,必是 bug");
        }
        self.persist(conn)?;
        Ok(Hlc {
            wall_ms: self.last_wall_ms,
            counter: self.last_counter,
            device_id: self.device_id.clone(),
        })
    }

    /// 见到一枚远端时间戳:把水位推到 max(自己, 远端)。观察**不取号**——「看见」本身
    /// 不需要时间戳,只需保证下一次 tick 严格大于一切已见(计数器 +1 由 tick 完成)。
    /// 生产调用方:replay::apply_remote_op 与 boot 导入(observe 导入日志的 max HLC)。
    pub fn observe(&mut self, conn: &Connection, remote: &Hlc) -> Result<(), String> {
        if (remote.wall_ms, remote.counter) > (self.last_wall_ms, self.last_counter) {
            self.last_wall_ms = remote.wall_ms;
            self.last_counter = remote.counter;
            self.persist(conn)?;
        }
        Ok(())
    }

    fn persist(&self, conn: &Connection) -> Result<(), String> {
        conn.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('last_hlc', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [encode_watermark(self.last_wall_ms, self.last_counter)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

fn meta_insert(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT INTO sync_meta (key, value) VALUES (?1, ?2)", [key, value])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 「墙钟-计数器」水位的定长编码:13 位 hex 毫秒 + '-' + 8 位 hex 计数器(小写定宽)。
/// 13 位 hex = 2^52 毫秒 ≈ 公元 14 万年,绰绰有余;越界必是 bug,assert 拦下。
fn encode_watermark(wall_ms: u64, counter: u32) -> String {
    assert!(wall_ms < (1u64 << 52), "wall_ms 超出 13 位 hex 上限,必是 bug:{wall_ms}");
    format!("{wall_ms:013x}-{counter:08x}")
}

fn parse_watermark(s: &str) -> Result<(u64, u32), String> {
    let bad = || format!("非法的 HLC 水位编码:{s}");
    if s.len() != 22 || !s.is_ascii() || s.as_bytes()[13] != b'-' {
        return Err(bad());
    }
    let wall_ms = u64::from_str_radix(&s[..13], 16).map_err(|_| bad())?;
    let counter = u32::from_str_radix(&s[14..], 16).map_err(|_| bad())?;
    // 回编码必须逐字相等:拒绝大写/带符号等 from_str_radix 也认、但破坏字典序的形态。
    if encode_watermark(wall_ms, counter) != s {
        return Err(bad());
    }
    Ok((wall_ms, counter))
}

/// 本机当前墙钟(UNIX 毫秒)。engine 的时钟偏斜提示(§11 SHOULD,L1)对比远端 HLC
/// 的 wall_ms 与它——**取原始系统时间**,不用 `Clock::last_wall_ms`:后者可能已被上一个
/// 偏斜远端 op 的 observe 抬高,拿它当基准会漏报持续偏斜。
pub(crate) fn wall_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 1970,拒绝取号")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A fully-migrated database in a unique temp file.
    fn fresh_db() -> Connection {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-clock-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        db::open(&path).expect("open migrated db")
    }

    fn hlc(wall_ms: u64, counter: u32, device_id: &str) -> Hlc {
        Hlc { wall_ms, counter, device_id: device_id.to_string() }
    }

    #[test]
    fn load_generates_device_id_once_and_persists() {
        let conn = fresh_db();
        let c1 = Clock::load(&conn).expect("first load");
        let c2 = Clock::load(&conn).expect("second load");
        assert_eq!(c1.device_id(), c2.device_id(), "device_id 一经生成必须稳定");
        assert!(Ulid::from_string(c1.device_id()).is_ok(), "device_id 应是合法 ULID");
        let stored: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key = 'device_id'", [], |r| r.get(0))
            .expect("device_id row");
        assert_eq!(stored, c1.device_id());
    }

    #[test]
    fn tick_advances_with_wall_clock() {
        let conn = fresh_db();
        let mut clock = Clock::load(&conn).unwrap();
        let a = clock.tick_at(&conn, 100).unwrap();
        assert_eq!((a.wall_ms, a.counter), (100, 0));
        assert_eq!(a.device_id, clock.device_id());
        let b = clock.tick_at(&conn, 200).unwrap();
        assert_eq!((b.wall_ms, b.counter), (200, 0));
        assert!(b > a);
    }

    #[test]
    fn tick_freezes_wall_and_counts_on_stall_or_rollback() {
        let conn = fresh_db();
        let mut clock = Clock::load(&conn).unwrap();
        let a = clock.tick_at(&conn, 100).unwrap(); // (100,0)
        let b = clock.tick_at(&conn, 100).unwrap(); // 同毫秒:计数器顶上
        let c = clock.tick_at(&conn, 60).unwrap(); // 回拨:墙钟分量冻结,不倒退
        assert_eq!((b.wall_ms, b.counter), (100, 1));
        assert_eq!((c.wall_ms, c.counter), (100, 2));
        let watermark: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key = 'last_hlc'", [], |r| r.get(0))
            .expect("last_hlc row");
        assert_eq!(watermark, encode_watermark(100, 2), "水位应随每次取号落盘");
        let d = clock.tick_at(&conn, 101).unwrap(); // 墙钟追上来:回到 (now, 0)
        assert_eq!((d.wall_ms, d.counter), (101, 0));
        assert!(a < b && b < c && c < d, "本机发出的时间戳必须严格单调");
    }

    #[test]
    fn observe_makes_next_tick_dominate_remote() {
        let conn = fresh_db();
        let mut clock = Clock::load(&conn).unwrap();
        clock.tick_at(&conn, 100).unwrap();
        // 远端墙钟快了一小时——观察后,本地墙钟再落后也压得住它。
        let remote = hlc(3_600_000_000, 5, "REMOTE-DEVICE");
        clock.observe(&conn, &remote).unwrap();
        let next = clock.tick_at(&conn, 101).unwrap();
        assert!(next > remote, "见过的 op 之后取的号必须更大(因果)");
        assert_eq!((next.wall_ms, next.counter), (3_600_000_000, 6));
    }

    #[test]
    fn observe_older_or_equal_remote_is_noop() {
        let conn = fresh_db();
        let mut clock = Clock::load(&conn).unwrap();
        let issued = clock.tick_at(&conn, 100).unwrap(); // (100,0)
        clock.observe(&conn, &hlc(90, 40, "R")).unwrap(); // 更旧(计数器再大也旧)
        clock.observe(&conn, &hlc(100, 0, "R")).unwrap(); // 水位相等
        let next = clock.tick_at(&conn, 90).unwrap();
        assert_eq!((next.wall_ms, next.counter), (100, 1), "旧/等水位不得拉低本机时钟");
        assert!(next > issued);
    }

    #[test]
    fn ties_break_by_device_id() {
        let a = hlc(100, 1, "AAAAAAAAAAAAAAAAAAAAAAAAAA");
        let b = hlc(100, 1, "BBBBBBBBBBBBBBBBBBBBBBBBBB");
        assert!(a < b, "墙钟+计数器全同时,由 device_id 确定性裁决");
        assert!(a.encode() < b.encode(), "编码后的字典序必须给出同一结论");
    }

    #[test]
    fn encoding_sorts_exactly_like_ord() {
        // 含「9 vs 16」对抗例:无定宽编码时字典序 "10" < "9" 会排错,定宽 hex 排对。
        let mut by_encode = vec![
            hlc(16, 0, "AAA"),
            hlc(9, 0, "AAA"),
            hlc(9, 16, "AAA"),
            hlc(9, 2, "ZZZ"),
            hlc(9, 2, "AAA"),
            hlc(1_751_800_000_000, 1, "01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        ];
        let mut by_ord = by_encode.clone();
        by_ord.sort();
        by_encode.sort_by(|x, y| x.encode().cmp(&y.encode()));
        assert_eq!(by_encode, by_ord, "字典序必须与逻辑序完全一致");
    }

    #[test]
    fn encode_parse_roundtrip_and_reject_garbage() {
        let h = hlc(1_751_800_000_000, 7, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert_eq!(Hlc::parse(&h.encode()).unwrap(), h);
        assert_eq!(parse_watermark(&encode_watermark(9, 0)).unwrap(), (9, 0));
        for bad in [
            "",                              // 空
            "0000000000009-00000000",        // 只有水位、没有 device_id 段
            "000000000000A-00000000-DEV",    // 大写 hex(破坏字典序,拒规范外形态)
            "0000000000009+00000000-DEV",    // 分隔符错位
            "0000000000009-0000000-DEV",     // 计数器只有 7 位
            "00000000000009-00000000-DEV",   // 墙钟 14 位
            "0000000000009-00000000-",       // 空 device_id
        ] {
            assert!(Hlc::parse(bad).is_err(), "该拒未拒:{bad}");
        }
        assert!(parse_watermark("000000000000A-00000000").is_err(), "水位同样拒大写");
    }

    #[test]
    fn restart_restores_watermark_and_stays_monotonic() {
        let conn = fresh_db();
        let mut c1 = Clock::load(&conn).unwrap();
        c1.tick_at(&conn, 100).unwrap();
        let last = c1.tick_at(&conn, 100).unwrap(); // (100,1)
        drop(c1);
        // 重启 + 墙钟回拨叠加:从落盘水位恢复,新时间戳仍严格更大。
        let mut c2 = Clock::load(&conn).unwrap();
        assert_eq!(c2.device_id(), last.device_id);
        let next = c2.tick_at(&conn, 50).unwrap();
        assert!(next > last, "重启后不得发出倒退的时间戳");
        assert_eq!((next.wall_ms, next.counter), (100, 2));
    }

    #[test]
    #[should_panic(expected = "HLC 计数器溢出")]
    fn counter_overflow_panics() {
        let conn = fresh_db();
        let mut clock = Clock::load(&conn).unwrap();
        clock.last_wall_ms = 100;
        clock.last_counter = u32::MAX;
        let _ = clock.tick_at(&conn, 100); // 墙钟未前进,计数器无处可加 → fail-fast
    }

    #[test]
    fn device_id_frozen_at_storage_level() {
        let conn = fresh_db();
        let mut clock = Clock::load(&conn).unwrap();
        clock.tick_at(&conn, 100).unwrap(); // last_hlc 行就位
        let err = conn
            .execute("UPDATE sync_meta SET value = 'evil' WHERE key = 'device_id'", [])
            .unwrap_err();
        assert!(err.to_string().contains("设备身份不可改写"), "{err}");
        let err = conn
            .execute("UPDATE sync_meta SET key = 'stolen' WHERE key = 'device_id'", [])
            .unwrap_err();
        assert!(err.to_string().contains("设备身份不可改写"), "{err}");
        let err = conn
            .execute("DELETE FROM sync_meta WHERE key = 'device_id'", [])
            .unwrap_err();
        assert!(err.to_string().contains("设备身份不可删除"), "{err}");
        // last_hlc 行必须保持可写——时钟每次取号都更新它。
        conn.execute(
            "UPDATE sync_meta SET value = '0000000000064-00000000' WHERE key = 'last_hlc'",
            [],
        )
        .expect("last_hlc 行不受冻结触发器影响");
    }

    /// device_id 形状收紧(epoch-plan §5.1 core #5):恰 26 字符规范 Crockford。
    /// 不收紧则每个伪造 origin 白得一份水位/池/挂起状态,「伪造无限 origin」DoS 开闸。
    #[test]
    fn parse_rejects_non_ulid_device_ids() {
        let real = Ulid::new().to_string();
        let good = Hlc { wall_ms: 42, counter: 7, device_id: real };
        assert_eq!(Hlc::parse(&good.encode()).unwrap(), good, "真 ULID 设备号照常往返");
        for dev in [
            "",                             // 空
            "SHORTDEV",                     // 太短
            "PEERDEV00000000000000000012",  // 28 字符,太长
            "ILOU0000000000000000000000",   // 26 字符但含 Crockford 排除字母 I/L/O/U
            "peerdev0000000000000000001",   // 26 字符但小写
            "abcdefghjkmnpqrstvwxyz0123",   // 26 字符但小写(规范形态是大写)
            "PEERDEV000000000000000000-",   // 26 字符但含分隔符
        ] {
            let s = format!("{}-{dev}", encode_watermark(42, 7));
            assert!(Hlc::parse(&s).is_err(), "非规范设备号必须拒:{dev:?}");
        }
    }
}
