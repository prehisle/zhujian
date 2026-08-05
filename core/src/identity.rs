//! 设备身份的人话层(identity-plan §2,0033)—— 设备别名的读写编排 + 条目署名的翻译。
//!
//! 这个系统里没有「用户」:有的是 `device_id`(26 位规范 ULID,「设备 × 空间」粒度)。
//! 本模块给它加一层人能读的名字,并把条目的 `born_device` 翻成那个名字。
//!
//! **署名粒度就是设备,不引入「人 / 成员」这一层**(§0 已拍板):一个人两台设备就让
//! 别名重名(两台都叫「娟娟」),用重名近似「人」,零额外机制。
//!
//! `device_profile` 是**多实例 LWW 寄存器**,与 `space_profile`(0028 单例)同形:
//! 无 create、无 tombstone,首条 `set_field` 即 UPSERT,并发走字段级 LWW 天然收敛。
//! 唯一差别是 entity_id = 该设备的 device_id 而不是固定字面量。
//!
//! ⚠ **名册的口径是「见过的设备」,不是「当前在册的设备」**(§2.3):被服务端吊销的
//! 设备,它的 alias 行照样在(op 早已收敛进每台设备的库)。UI 上不能拿它当权威在册
//! 名单用——那件事要等 §5「移除设备」补服务端下发的名册。

use rusqlite::{Connection, OptionalExtension};

use crate::clock::Clock;

/// 一台设备在本账户里的名字。`alias == None` = 从未命名或**显式清名**(两者在寄存器
/// 语义里不同——前者无行、后者有行 alias 为 NULL——但对显示层是同一件事:没有名字)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceEntry {
    pub device_id: String,
    pub alias: Option<String>,
}

/// 全量设备名册,按 device_id 排序(跨端收敛,不用问服务器)。
/// 同时喂三处:本机别名设置、条目署名翻译、将来的成员列表 UI。
pub fn device_roster(conn: &Connection) -> Result<Vec<DeviceEntry>, String> {
    let mut stmt = conn
        .prepare("SELECT device_id, alias FROM device_profile ORDER BY device_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(DeviceEntry { device_id: r.get(0)?, alias: r.get(1)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// 某台设备的别名。外层 Option = 行在不在,内层 = 显式清名;flatten 后二者都是「没名字」
/// ——**缺省绝不由后端编造**(design-rules「绝不回退兜底」;人话缺省归前端,同 space_name)。
pub fn device_alias(conn: &Connection, device_id: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT alias FROM device_profile WHERE device_id = ?1", [device_id], |r| {
        r.get::<_, Option<String>>(0)
    })
    .optional()
    .map(|o| o.flatten())
    .map_err(|e| e.to_string())
}

/// 改设备别名(编排层,照 `spaces::set_space_name` 的形):同事务「UPSERT 行 + 发射 op +
/// HLC 水位落盘」;幂等 no-op(同名重存)不发射不取号。锁序契约 = 写命令统一的
/// **db → clock**(调用方经 `ActiveRuntime::write_locks` 或同序自取)。
///
/// `alias` 入口先 trim;**trim 后为空即视作清名**(`None`),不落空串——空串在寄存器里
/// 不是合法值(线上规范只认「非空且已 trim 的字符串」或 null),让 UI 的「清空输入框」
/// 有个明确落点,而不是撞一句错误。随后进共享线上校验
/// (`replay::validate_device_alias_value`,与 replay/boot 单一真相源)。
///
/// `device_id` **不锁本机**:名册是账户内共享的,给别的设备改名是合法操作(冲突走
/// 字段级 LWW)。但形态必须规范——非规范 id 会白得一行。**这不给行数设上界**:合法
/// ULID 要多少有多少,`device_profile` 的行数与 items/topics 同级、无协议上界
/// (codex 301 实现审 M3;真要绑到「账户设备数」需要服务端下发的权威名册,那是 §5)。
pub fn set_device_alias(
    conn: &mut Connection,
    clock: &mut Clock,
    device_id: &str,
    alias: Option<&str>,
) -> Result<(), String> {
    if !crate::clock::is_canonical_device_id(device_id) {
        return Err(format!("设备 id 非规范形(须 26 位 ULID):{device_id}"));
    }
    let alias = alias.map(str::trim).filter(|s| !s.is_empty());
    crate::replay::validate_device_alias_value(&match alias {
        Some(s) => serde_json::Value::String(s.into()),
        None => serde_json::Value::Null,
    })?;
    // 幂等 no-op **必须同时看「行在不在」**:已有行 alias=NULL 与无行,读出来都是 None,
    // 但前者已有 op 背书、后者没有。只比值会让「首次清名」这一笔悄悄不发 op,留下一行
    // 无背书的行(或干脆不建行),把状态⟺日志双向审计推红。
    let existing: Option<Option<String>> = conn
        .query_row("SELECT alias FROM device_profile WHERE device_id = ?1", [device_id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if existing.as_ref().map(|a| a.as_deref()) == Some(alias) {
        return Ok(()); // 行在且值同:没写就没有 op。
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO device_profile (device_id, alias) VALUES (?1, ?2) \
         ON CONFLICT(device_id) DO UPDATE SET alias = excluded.alias",
        (device_id, alias),
    )
    .map_err(|e| e.to_string())?;
    crate::oplog::device_set_alias(&tx, clock, device_id)?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, repo};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn fresh() -> (Connection, Clock) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-identity-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open migrated db");
        let clock = Clock::load(&conn).expect("load clock");
        (conn, clock)
    }

    /// 造一枚**停在指定版本**的库,并在里面播一条「v32 收端形状」的条目:items 行按
    /// 那枚库的列面写(v32 没有 born_device 列),而 create op 的 payload 由调用方给
    /// ——这正是 v32 收到 v33 端 create op 时的真实形状(payload 原样入库、值被丢弃)。
    fn v32_db_with_create_payload(tag: &str, born: Option<serde_json::Value>) -> (Connection, String) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-id34-{tag}-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).expect("开库");
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        db::run_migrations(&conn, 32).expect("跑到 v32");
        let mut clock = Clock::load(&conn).expect("load clock");
        let id = ulid::Ulid::new().to_string();
        let now = "2026-01-01T00:00:00Z";
        // v32 的 apply_item_create:INSERT 列表里**没有** born_device,payload 里那个值
        // 在这一步被静默丢掉。
        conn.execute(
            "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage) \
             VALUES (?1, '来自新端的条目', 'inbox', ?2, ?2, 'inbox')",
            (&id, now),
        )
        .expect("播 v32 列面的 items 行");
        let hlc = clock.tick(&conn).expect("取号");
        let origin_seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
                [hlc.device_id.as_str()],
                |r| r.get(0),
            )
            .expect("取 origin_seq");
        let mut payload = serde_json::json!({
            "content": "来自新端的条目",
            "stage": "inbox",
            "created_at": now,
            "born_stage": "inbox",
            "due_on": null,
            "priority": null,
            "position": null,
        });
        // 三格的差别全在这一键上:带规范值 / 压根没这键(真 pre-0033)/ 带非文本值。
        if let Some(v) = born {
            payload["born_device"] = v;
        }
        crate::oplog::append_remote(
            &conn,
            &ulid::Ulid::new().to_string(),
            &hlc.encode(),
            "item",
            &id,
            "create",
            &payload,
            origin_seq,
        )
        .expect("播 create op");
        (conn, id)
    }

    fn born_device_of(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row("SELECT born_device FROM items WHERE id = ?1", [id], |r| r.get(0))
            .expect("读 born_device")
    }

    /// 0034:v33 端发的 create op 恒带 `born_device`,而 v32 端 ①shape 放行额外键
    /// ②整个 payload 原样进日志 ③它的 INSERT 没这列、值被静默丢 ④水位推进、op 永不
    /// 重放。于是那台设备升级到 0033 之后,行上 NULL 而自己的日志里明写着值——署名
    /// 永久丢失,**且 0033 同轮把 born_device 加进了 `ITEM_LWW_FIELDS`,这库从此
    /// strict_battery 恒红**(压实自验收 / certify / 供快照三条路全挂)。
    ///
    /// 这条路 0033 的头注只分析了反方向(旧端发缺键 → 新端收),codex 301 实现审 H1。
    #[test]
    fn migration_0034_recovers_the_born_device_a_v32_reader_dropped() {
        let me = {
            // 先拿一枚库问出「本机 device_id 长什么样」——夹具要的是规范形,而 Crockford
            // 去掉了 I/L/O/U,手写常量连踩三次,不如问真的。
            let (conn, _) = fresh();
            conn.query_row("SELECT value FROM sync_meta WHERE key = 'device_id'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
        };

        // ① 带规范值:v32 丢了,0034 必须取回来。
        let (conn, id) = v32_db_with_create_payload("hit", Some(serde_json::json!(me)));
        let cols: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('items') WHERE name = 'born_device'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cols, 0, "夹具必须真的是 v32 形状(连这列都还没有),否则测的不是那条路");
        db::run_migrations(&conn, db::SCHEMA_VERSION).expect("前滚到当前版");
        assert_eq!(
            born_device_of(&conn, &id).as_deref(),
            Some(me.as_str()),
            "日志里明写着的署名必须被取回"
        );
        crate::sync::boot::strict_battery(&conn).expect("恢复之后状态⟺日志必须自洽");

        // ② 真 pre-0033(payload 压根没这键):不猜、不填,保持未知。
        let (conn2, id2) = v32_db_with_create_payload("miss", None);
        db::run_migrations(&conn2, db::SCHEMA_VERSION).expect("前滚到当前版");
        assert_eq!(born_device_of(&conn2, &id2), None, "缺键 = 未知,绝不回填");
        crate::sync::boot::strict_battery(&conn2).expect("两边都是 NULL,IS 相等,不误报");

        // ③ 非文本值:不恢复。写进 TEXT 列会被列亲和性转成 '12345',而审计比的是
        // `IS json_extract(...)`——TEXT 与 INTEGER 永远不相等,恢复了照样红。
        let (conn3, id3) = v32_db_with_create_payload("type", Some(serde_json::json!(12345)));
        db::run_migrations(&conn3, db::SCHEMA_VERSION).expect("前滚到当前版");
        assert_eq!(born_device_of(&conn3, &id3), None, "非文本值不许恢复");

        // ④⑤ **非规范文本**也不恢复(302 二轮 M1,我一轮判错了):长度不对 / 含 Crockford
        // 排除的 I·L·O·U。恢复它 = 把一个协议非法**且永不可改**的值物化进不可变列,此后
        // 产品路径再也修不掉。指望 `audit_op_shapes` 去兜是错的 —— 它在 strict_battery 里
        // 是**短路的第一道**(后面的 LWW 审计根本不会跑,所以「两处各红一次」的顾虑不存在),
        // 而且它**不在开库路径上**(只在 compact / certify / 供快照那几个入口)。
        // 两格分别由**两道不同的闸**承重,别用一个「小写又太短」的值把两道一起糊过去:
        //   * `01DEV` —— 字符集全合法、只是长度不对 ⇒ 唯一守卫是 `length(v) = 26`;
        //   * 含 `I` 的 26 位 —— 长度正好、只是撞了 Crockford 排除的 I/L/O/U ⇒ 唯一守卫是 GLOB。
        for (tag, bad) in [("len", "01DEV"), ("crockford", "01DEVIAAAAAAAAAAAAAAAAAAAA")] {
            let (c, i) = v32_db_with_create_payload(tag, Some(serde_json::json!(bad)));
            db::run_migrations(&c, db::SCHEMA_VERSION).expect("前滚到当前版");
            assert_eq!(born_device_of(&c, &i), None, "非规范 device_id 不许落进不可变列:{bad}");
        }
    }

    /// 0034 的规范形闸是 [`crate::clock::is_canonical_device_id`] 的 **SQL 镜像**(SQL 引用
    /// 不了 Rust 常量,只能靠这只测把两把尺锁在一起)。样本里每个值都让两把尺各判一次,
    /// 不一致就红。
    ///
    /// ⚠️ **它红了不是去改 0034** —— 那是已应用的历史迁移,改它就是真实库分叉。该做的是想
    /// 清楚「老库升级那一刻按旧尺放行的值,今天还认不认」,再决定要不要新增一条迁移收紧。
    #[test]
    fn the_sql_mirror_of_the_canonical_device_id_gate_agrees_with_the_rust_one() {
        let (conn, _) = fresh();
        // 与 0034 那两行逐字同源。
        const SQL: &str = "SELECT length(?1) = 26 AND ?1 NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'";
        // 长度靠 repeat 自证,别手数 —— 夹具里的 device_id 已经数错过三次。
        let ok = format!("01DEV{}", "A".repeat(21));
        assert!(
            crate::clock::is_canonical_device_id(&ok),
            "样本里必须有一个真合法的,否则两把尺一起恒 false 也能过"
        );
        let mut samples = vec![
            ok.clone(),
            ok.to_lowercase(),                    // 小写
            "01DEV".to_string(),                  // 太短
            format!("01DEV{}", "A".repeat(22)),   // 太长
            format!("01DEV-{}", "A".repeat(20)),  // 连字符
            String::new(),                        // 空
        ];
        // Crockford 排除的四个字母:只有 Rust 那把尺认得出,表 CHECK 那把(0-9A-Z)认不出。
        samples.extend("ILOU".chars().map(|c| format!("01DEV{c}{}", "A".repeat(20))));
        for s in &samples {
            let sql_says: bool = conn.query_row(SQL, [s], |r| r.get(0)).unwrap();
            assert_eq!(
                sql_says,
                crate::clock::is_canonical_device_id(s),
                "两把尺对 {s:?} 判得不一样"
            );
        }
    }

    /// 0034 取值的口径必须与 [`crate::sync::boot`] 的 `count_field_mismatches`
    /// **逐字一致**(`ORDER BY hlc DESC LIMIT 1`),否则「修完仍然红」。
    ///
    /// 每实体恰一条 create 由 `audit_create_multiplicity` 另行保证,所以这只测造的是
    /// 一枚**已经坏了的库**(同一条目两条 create)。它当然不该过 battery——但恢复步
    /// 选谁,必须和审计选谁是同一个人。否则这道口径就只是注释里的一句声明。
    #[test]
    fn migration_0034_picks_the_same_create_op_the_audit_would() {
        let early = "01DEVAAAAAAAAAAAAAAAAAAAAA";
        let late = "01DEVBBBBBBBBBBBBBBBBBBBBB";
        let (conn, id) = v32_db_with_create_payload("two", Some(serde_json::json!(early)));
        // 补一条 HLC 更晚的 create(同 entity_id):clock 单调,后取的号必然更大。
        let mut clock = Clock::load(&conn).unwrap();
        let hlc = clock.tick(&conn).unwrap();
        let origin_seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
                [hlc.device_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        crate::oplog::append_remote(
            &conn,
            &ulid::Ulid::new().to_string(),
            &hlc.encode(),
            "item",
            &id,
            "create",
            &serde_json::json!({
                "content": "来自新端的条目",
                "stage": "inbox",
                "created_at": "2026-01-01T00:00:00Z",
                "born_stage": "inbox",
                "due_on": null,
                "priority": null,
                "position": null,
                "born_device": late,
            }),
            origin_seq,
        )
        .unwrap();
        db::run_migrations(&conn, db::SCHEMA_VERSION).expect("前滚到当前版");
        assert_eq!(
            born_device_of(&conn, &id).as_deref(),
            Some(late),
            "取 HLC 最大那条 —— 与审计同口径,不是「第一条」"
        );
    }

    /// 0034 的 `WHERE born_device IS NULL` **只填空、绝不改写**——它是冻结触发器缺席
    /// 期间的替身(恢复步必须先 DROP 掉那只触发器才动得了列,那段时间里守住「出生设备
    /// 是史实」的就只剩这个判据)。
    ///
    /// 两格:①正常库重跑一遍,值不动;②行值与日志说的**不一样**的库(人为造:撤下冻结
    /// 触发器再改列——生产路径做不到,恶意/损坏的源库能),恢复步照样不许把它「改回」
    /// 日志说的那个值。把坏账洗成另一种坏账不是它的职责,那是 strict_battery 该响亮
    /// 报出来的事。
    #[test]
    fn migration_0034_only_fills_blanks_and_never_rewrites() {
        const RECOVER: &str = include_str!("../migrations/0034_recover_born_device_from_log.sql");
        let (conn, _) = fresh();
        let id = repo::add_item(&conn, "本机建的").unwrap();
        crate::oplog::item_create(&conn, &mut Clock::load(&conn).unwrap(), &id).unwrap();
        let before = born_device_of(&conn, &id).expect("本机建的必有署名");

        // ① 正常库重跑:一个字都不许动。
        conn.execute_batch(RECOVER).expect("恢复步重跑");
        assert_eq!(born_device_of(&conn, &id).as_deref(), Some(before.as_str()), "已有值不许被碰");

        // ② 行值 ≠ 日志赢家的库:仍然不许改写。撤下冻结触发器改完列**原样装回**——
        // 库要处在正常形态(触发器在位、只是列值被篡改过),否则恢复步第一句 DROP 就
        // 没东西可撤,测的就不是它了。
        let other = "01DEVBBBBBBBBBBBBBBBBBBBBB";
        conn.execute_batch(&format!(
            "DROP TRIGGER trg_item_born_device_frozen; \
             UPDATE items SET born_device = '{other}'; \
             CREATE TRIGGER trg_item_born_device_frozen \
             BEFORE UPDATE OF born_device ON items \
             FOR EACH ROW \
             WHEN OLD.born_device IS NOT NEW.born_device \
             BEGIN \
                 SELECT RAISE(ABORT, '出生设备是史实,不可修改'); \
             END;"
        ))
        .unwrap();
        conn.execute_batch(RECOVER).expect("恢复步在损坏库上也得跑得完");
        assert_eq!(
            born_device_of(&conn, &id).as_deref(),
            Some(other),
            "行上有值就不是这一步的活,别把坏账洗成另一种坏账"
        );
    }

    fn device_ops(conn: &Connection) -> Vec<(String, serde_json::Value)> {
        let mut stmt = conn
            .prepare(
                "SELECT entity_id, payload FROM oplog WHERE entity = 'device' ORDER BY hlc",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    serde_json::from_str(&r.get::<_, String>(1)?).unwrap(),
                ))
            })
            .unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    #[test]
    fn set_alias_writes_row_and_emits_one_op() {
        let (mut conn, mut clock) = fresh();
        let me = clock.device_id().to_string();
        set_device_alias(&mut conn, &mut clock, &me, Some("  书房台式机  ")).unwrap();
        assert_eq!(device_alias(&conn, &me).unwrap().as_deref(), Some("书房台式机"), "入口先 trim");
        let ops = device_ops(&conn);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].0, me, "entity_id = 被命名设备的 device_id");
        assert_eq!(ops[0].1["field"], "alias");
        assert_eq!(ops[0].1["value"], "书房台式机");
        assert_eq!(
            device_roster(&conn).unwrap(),
            vec![DeviceEntry { device_id: me, alias: Some("书房台式机".into()) }]
        );
    }

    #[test]
    fn same_alias_is_a_silent_noop_but_first_clear_is_not() {
        let (mut conn, mut clock) = fresh();
        let me = clock.device_id().to_string();
        set_device_alias(&mut conn, &mut clock, &me, Some("甲")).unwrap();
        set_device_alias(&mut conn, &mut clock, &me, Some("甲")).unwrap();
        assert_eq!(device_ops(&conn).len(), 1, "同值幂等:没写就没有 op");
        // 清名:行在、alias=NULL、**必须发 op**(否则留一行无背书的行)。
        set_device_alias(&mut conn, &mut clock, &me, Some("   ")).unwrap();
        assert_eq!(device_alias(&conn, &me).unwrap(), None);
        let ops = device_ops(&conn);
        assert_eq!(ops.len(), 2, "清名是一次真实变更");
        assert!(ops[1].1["value"].is_null(), "清名的规范表示是 JSON null");
        // 已清过再清一次才是 no-op。
        set_device_alias(&mut conn, &mut clock, &me, None).unwrap();
        assert_eq!(device_ops(&conn).len(), 2);
    }

    /// 首次清名的**回归锚**:若 no-op 判据只比值(不看行在不在),这一笔会被判成
    /// 幂等而不落行不发 op,`device_profile` 与日志一致性无从建立。
    #[test]
    fn clearing_alias_on_a_never_named_device_creates_a_backed_row() {
        let (mut conn, mut clock) = fresh();
        let me = clock.device_id().to_string();
        set_device_alias(&mut conn, &mut clock, &me, None).unwrap();
        assert_eq!(device_roster(&conn).unwrap().len(), 1, "清名也建行(显式清名是规范表示)");
        assert_eq!(device_ops(&conn).len(), 1, "且有 op 背书");
    }

    #[test]
    fn rejects_non_canonical_device_id_and_oversized_alias() {
        let (mut conn, mut clock) = fresh();
        let me = clock.device_id().to_string();
        let err = set_device_alias(&mut conn, &mut clock, "不是ULID", Some("x")).unwrap_err();
        assert!(err.contains("非规范形"), "{err}");
        let long = "啊".repeat(100); // 300 字节 > 200
        let err = set_device_alias(&mut conn, &mut clock, &me, Some(&long)).unwrap_err();
        assert!(err.contains("超长"), "{err}");
        assert_eq!(device_ops(&conn).len(), 0, "拒了就一条 op 都不许留");
    }

    /// **fail-closed 那一条**(identity-plan §6.3 单列的三点之一,first-draft-checklist
    /// 「规格给了判据、实现容易漏」的地方)。
    ///
    /// `sync_meta` 的 device_id 行**刻意不预插**(0019:SQL 里没有随机源),由
    /// `Clock::load` 首启生成。若那行不存在,触发器里 `NEW.x <> (SELECT ...)` 求值为
    /// NULL(不是 TRUE)→ WHEN 不触发 → **静默放行**,落下一个永不可改的错署名。
    /// 迁移里那句 `OR NOT EXISTS (SELECT 1 FROM sync_meta ...)` 就是堵这个洞的;
    /// 拿掉它,本测必须变红。
    /// ⚠ 这只测**两半各由不同的子句在守**,拆开写才有阴性对照的意义:
    ///
    /// * 上半(生产路径)靠 `NEW.born_device IS NULL` —— `add_item` 的子查询在无身份时
    ///   取到 NULL,第一条析取项就 ABORT 了;
    /// * 下半(显式带值)才是 `OR NOT EXISTS (SELECT 1 FROM sync_meta ...)` 那句唯一守
    ///   得住的地方 —— `'X' <> (SELECT ... )` 在行不存在时求值为 **NULL(不是 TRUE)**,
    ///   WHEN 不触发 → **静默放行**一个永不可改的错署名。
    ///
    /// 只写上半会得到一只被别的子句背书的假绿(变异掉那句 `NOT EXISTS` 照样通过)。
    #[test]
    fn insert_is_fail_closed_when_the_device_has_no_identity_yet() {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-identity-noid-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        // **刻意不跑 Clock::load**:这枚库还没有设备身份。
        let conn = db::open(&path).expect("open migrated db");
        let has: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_meta WHERE key = 'device_id'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(has, 0, "前提:这枚库还没有设备身份");

        // 上半:生产路径(born_device 取到 NULL)。
        let err = repo::add_item(&conn, "无身份时不许落行").unwrap_err();
        assert!(err.to_string().contains("必须如实记录出生设备"), "{err}");

        // 下半:**显式带一个非 NULL 的 born_device**。这里 `<>` 的右操作数是 NULL,
        // 三值逻辑下整个比较为 NULL —— 唯一还能拦住它的就是那句 `NOT EXISTS`。
        let err = conn
            .execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage, born_device) \
                 VALUES ('x', '无身份却自称有出身', 'inbox', 't', 't', 'inbox', '01DEVZZZZZZZZZZZZZZZZZZZZZ')",
                [],
            )
            .unwrap_err();
        assert!(err.to_string().contains("必须如实记录出生设备"), "{err}");

        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "两半都拒了,一行都不许留");
    }

    /// 状态⟺日志:行上的 born_device 必须等于它自己 create op 说的那个。
    ///
    /// 这条是 `boot::ITEM_LWW_FIELDS` 里那一项**唯一**的守卫。该表名为 LWW,实际审的是
    /// 「表列 == 日志赢家」;对不可变列(born_stage / born_device)退化成「行上的出生
    /// 史实 == create op 说的出生史实」—— 正是快照篡改要伪造的那一格。
    ///
    /// 用「先 DROP 掉冻结触发器再改列」模拟被篡改的快照:生产路径永远做不到这件事
    /// (触发器无豁免),但恶意/损坏的源库能。
    #[test]
    fn strict_battery_catches_a_born_device_that_disagrees_with_its_create_op() {
        let (conn, mut clock) = fresh();
        let id = repo::add_item(&conn, "真身").unwrap();
        crate::oplog::item_create(&conn, &mut clock, &id).unwrap();
        crate::sync::boot::strict_battery(&conn).expect("没动手脚时必过");

        conn.execute_batch("DROP TRIGGER trg_item_born_device_frozen;").unwrap();
        conn.execute(
            "UPDATE items SET born_device = '01DEVZZZZZZZZZZZZZZZZZZZZZ' WHERE id = ?1",
            [&id],
        )
        .unwrap();
        let err = crate::sync::boot::strict_battery(&conn)
            .expect_err("行与日志矛盾必须被严格电池拒");
        assert!(err.contains("born_device"), "{err}");
    }

    /// `strict_battery` 里那只 device 语义审计的**独立**守卫(变异对照 ⑬ 补)。
    ///
    /// boot 引导路上另有一道「双侧独立预审」跑在合并之前,`import_rejects_device_profile_
    /// state_log_mismatch_both_sides` 守的是那一道 —— 把 `strict_battery` 里这只整个摘掉,
    /// 那只测照样绿。但 `strict_battery` 还被**另外三条路**调用:压实自验收、`certify`、
    /// 快照供货闸,那些路上没有预审。故它需要一只只走它的测。
    #[test]
    fn strict_battery_catches_an_unbacked_device_profile_row() {
        let (conn, mut clock) = fresh();
        let id = repo::add_item(&conn, "数据").unwrap();
        crate::oplog::item_create(&conn, &mut clock, &id).unwrap();
        crate::sync::boot::strict_battery(&conn).expect("没动手脚时必过");

        // 直插一行无 op 背书的 device_profile(该表无触发器守护,模拟损坏)。
        conn.execute(
            "INSERT INTO device_profile (device_id, alias) VALUES ('01DEVZZZZZZZZZZZZZZZZZZZZZ', '幽灵')",
            [],
        )
        .unwrap();
        let err = crate::sync::boot::strict_battery(&conn)
            .expect_err("行在无 op 必须被严格电池拒");
        assert!(err.contains("device 语义审计") && err.contains("行在无 op"), "{err}");
    }

    /// 冒名与冻结:别的设备的 id 插不进来,已落的署名改不动。
    #[test]
    fn born_device_rejects_impostors_and_is_frozen_forever() {
        let (conn, mut clock) = fresh();
        let me = clock.device_id().to_string();
        let other = "01DEVZZZZZZZZZZZZZZZZZZZZZ";
        assert_ne!(me, other);
        // 冒名:单机路径只认本机 id。
        let err = conn
            .execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage, born_device) \
                 VALUES ('x', '冒名', 'inbox', 't', 't', 'inbox', ?1)",
                [other],
            )
            .unwrap_err();
        assert!(err.to_string().contains("必须如实记录出生设备"), "{err}");
        // 冻结:已落的署名改不动,**无回放豁免**(照 born_stage,0025 原文「导入只
        // INSERT,永不改写出生态」)——连置了 sync_replay_active 也拦。
        let id = repo::add_item(&conn, "真身").unwrap();
        for exempt in [false, true] {
            if exempt {
                conn.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", []).unwrap();
            }
            let err = conn
                .execute("UPDATE items SET born_device = ?1 WHERE id = ?2", (other, &id))
                .unwrap_err();
            assert!(err.to_string().contains("出生设备是史实"), "exempt={exempt}: {err}");
            if exempt {
                conn.execute("DELETE FROM sync_replay_active", []).unwrap();
            }
        }
        let _ = &mut clock;
    }

    /// 署名的地基:本机建的条目,born_device 必须是本机 device_id,且能翻成别名。
    #[test]
    fn locally_created_items_are_signed_by_this_device() {
        let (mut conn, mut clock) = fresh();
        let me = clock.device_id().to_string();
        set_device_alias(&mut conn, &mut clock, &me, Some("娟娟的手机")).unwrap();
        let id = repo::add_item(&conn, "想法").unwrap();
        let born: Option<String> = conn
            .query_row("SELECT born_device FROM items WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(born.as_deref(), Some(me.as_str()));
        assert_eq!(device_alias(&conn, &born.unwrap()).unwrap().as_deref(), Some("娟娟的手机"));
    }
}
