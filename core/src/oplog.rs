//! 本地操作日志(oplog)—— sync-plan P1「oplog 骨架」的发射层。
//!
//! 每个写命令在**同一事务**里完成「改数据 + 追加 op + HLC 水位落盘」三件事(调用方
//! 持事务;`append` 内部 `Clock::tick` 取号会顺带把 last_hlc 写回 sync_meta)。事后
//! 补发没有位置:崩溃窗口丢 op = 那次修改永远不同步,是静默分叉。
//!
//! op 词汇表(sync-plan §3.1,存储层 CHECK 兜底):
//!   * item/topic:`create`(出生快照)/ `set_field`(字段级 LWW 的最小单元,payload
//!     `{"field","value"}`,一个字段一条 op)/ `tombstone`(销毁,payload `{}`);
//!   * link(item_topic,entity_id = "item_id:topic_id"):`link_add` / `link_remove`
//!     (OR-set:remove 的 payload 带 `observed` = 发射时本地日志里该 link 的全部
//!     add op_id——「remove 只删它见过的 add」的弹药,合并判定在 replay.rs);
//!   * image:`image_add`(元数据,字节走旁路)/ `image_tombstone`。
//!
//! 发射的原则是**读行发声**:助手在写入之后读回当前行值来充填 payload,而不是让调用方
//! 转述——写入过程中算出来的值(落列的 fractional 排序键、批量 sealed_at 的统一时间戳)
//! 只有行上才是真相。同一命令内多次发射按序取号,HLC 严格递增,后写的 op 天然赢得 LWW。
//! position 自 0021 起是 fractional index 字符串(0021 前的历史 op 里是整数——append-only
//! 不改写,回放层按「0021 前的 op 只存在于本机日志」处理,见迁移抬头注释)。
//!
//! 不进 op 的:`items.updated_at` / `topics.created_at` 之外的簿记、`item_revisions`
//! (本地派生,各端回放时由自己的触发器长出历史)。topic tombstone 不展开级联 link
//! 死亡(FK 级联是共享 schema 知识,回放同样生效)。
//!
//! 0024 起 op 带**第三根轴** `origin_seq`(源设备发射序号,每 origin 从 1 连续):
//! op_id=身份、HLC=合并排序轴、origin_seq=传输与水位轴,并存不互代——HLC 不稠密,
//! 收端靠连续号检测信箱丢帧留下的缺口(sync-protocol §5.1)。

use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::clock::Clock;

/// 单一追加入口:取一枚 HLC(水位随同事务落盘)+ 本设备下一枚 origin_seq、写一行 op。
/// entity/kind 由各助手传入模块内常量,永远不是用户输入;非法搭配被 0020 的 CHECK
/// 拦下(必是 bug)。
///
/// origin_seq 取号 = 本 origin 的 MAX+1。安全前提**不是** append-only 本身(它只解释
/// 「无删除故无洞」),而是「进程内单写者(全部写路径过 lib.rs `write_locks` 全局互斥)
/// + 取号与数据写同一事务」——并发双读同一 MAX 的窗口不存在;`UNIQUE(origin, origin_seq)`
/// 是响亮兜底,前提被破坏(如未来多进程开同库)时撞索引失败,不静默分叉(sync-protocol §7)。
fn append(
    conn: &Connection,
    clock: &mut Clock,
    entity: &str,
    entity_id: &str,
    kind: &str,
    payload: Value,
) -> Result<(), String> {
    let hlc = clock.tick(conn)?;
    let origin_seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM oplog WHERE origin = ?1",
            [hlc.device_id.as_str()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            Ulid::new().to_string(),
            hlc.encode(),
            entity,
            entity_id,
            kind,
            payload.to_string(),
            origin_seq,
        ),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 远端 op 原样入库(回放层 replay.rs 专用):保留远端的 op_id、HLC 与 origin_seq,
/// **不取号**——本地日志是「本机见过的全部 op」,远端 op 的身份/时间戳/序号都是既成
/// 史实(per-origin 连续性由收端引擎的严格连续应用保证,sync-protocol §5.3)。词汇表
/// 仍由 0020 的 CHECK 兜底;hlc 或 (origin, origin_seq) 撞 UNIQUE = 两枚不同 op 声称
/// 同一坐标,数据损坏,fail-fast。
pub fn append_remote(
    conn: &Connection,
    op_id: &str,
    hlc: &str,
    entity: &str,
    entity_id: &str,
    kind: &str,
    payload: &Value,
    origin_seq: i64,
) -> Result<(), rusqlite::Error> {
    // 裸 rusqlite 错误外抛:调用方(replay::apply_remote_op)按错误码分型
    // (约束违例 = 数据驱动的 InvalidOp,其余 = LocalFault),不在这里压成字符串。
    conn.execute(
        "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (op_id, hlc, entity, entity_id, kind, payload.to_string(), origin_seq),
    )?;
    Ok(())
}

// ---- item ------------------------------------------------------------------------

/// 条目出生:读回刚插入的行,payload = 出生快照。archived_at/sealed_at 生而为 NULL
/// (0014/0017 触发器禁「生而归档」),不进快照;updated_at 是本地簿记,不同步。
pub fn item_create(conn: &Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let payload = conn
        .query_row(
            "SELECT content, stage, created_at, born_stage, due_on, priority, position \
             FROM items WHERE id = ?1",
            [id],
            |r| {
                Ok(json!({
                    "content": r.get::<_, String>(0)?,
                    "stage": r.get::<_, String>(1)?,
                    "created_at": r.get::<_, String>(2)?,
                    "born_stage": r.get::<_, String>(3)?,
                    "due_on": r.get::<_, Option<String>>(4)?,
                    "priority": r.get::<_, Option<i64>>(5)?,
                    "position": r.get::<_, Option<String>>(6)?,
                }))
            },
        )
        .map_err(|e| format!("读取条目出生快照失败({id}):{e}"))?;
    append(conn, clock, "item", id, "create", payload)
}

/// 条目字段变更:每个字段一条 set_field op,值从行上读回(写后调用)。字段名是模块内
/// 白名单,传错字段是编程错误,fail-fast。
pub fn item_set(
    conn: &Connection,
    clock: &mut Clock,
    id: &str,
    fields: &[&str],
) -> Result<(), String> {
    for field in fields {
        let value = read_item_field(conn, id, field)?;
        append(conn, clock, "item", id, "set_field", json!({ "field": field, "value": value }))?;
    }
    Ok(())
}

/// 条目销毁(inbox 硬删 / 回收站彻底删除)。行已不在,payload 空;级联走共享 schema。
pub fn item_tombstone(conn: &Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    append(conn, clock, "item", id, "tombstone", json!({}))
}

/// items 上参与同步的字段(白名单)。born_stage/created_at 不可变、只在出生快照里;
/// updated_at 是本地簿记。列名来自这里的固定字面量,永远不拼用户输入。
fn read_item_field(conn: &Connection, id: &str, field: &str) -> Result<Value, String> {
    let sql = format!("SELECT {field} FROM items WHERE id = ?1");
    let value = match field {
        // NOT NULL 文本字段
        "content" | "stage" => conn
            .query_row(&sql, [id], |r| r.get::<_, String>(0))
            .map(Value::from),
        // 可空文本字段(position 自 0021 起是 fractional index 字符串)
        "due_on" | "archived_at" | "sealed_at" | "position" => conn
            .query_row(&sql, [id], |r| r.get::<_, Option<String>>(0))
            .map(Value::from),
        // 可空整数字段
        "priority" => conn
            .query_row(&sql, [id], |r| r.get::<_, Option<i64>>(0))
            .map(Value::from),
        other => panic!("item set_field 不认识的字段(必是 bug):{other}"),
    };
    value.map_err(|e| format!("读取条目字段 {field} 失败({id}):{e}"))
}

// ---- topic -----------------------------------------------------------------------

/// 标签出生:payload = {title, created_at}。updated_at 以 set_field 走(它驱动 chip
/// 顺序,是用户可见状态)。
pub fn topic_create(conn: &Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    let payload = conn
        .query_row(
            "SELECT title, created_at FROM topics WHERE id = ?1",
            [id],
            |r| {
                Ok(json!({
                    "title": r.get::<_, String>(0)?,
                    "created_at": r.get::<_, String>(1)?,
                }))
            },
        )
        .map_err(|e| format!("读取标签出生快照失败({id}):{e}"))?;
    append(conn, clock, "topic", id, "create", payload)
}

/// 标签字段变更(title / updated_at / color),值从行上读回。color 可空(NULL = 无色),
/// 读成 `Option<String>` → None 时 payload 的 value 落 JSON null(与 due_on/priority 等
/// 可空字段同款);title/updated_at 恒非空,读成 Option 后必是 Some,序列化不变。
pub fn topic_set(
    conn: &Connection,
    clock: &mut Clock,
    id: &str,
    fields: &[&str],
) -> Result<(), String> {
    for field in fields {
        let sql = match *field {
            "title" | "updated_at" | "color" => format!("SELECT {field} FROM topics WHERE id = ?1"),
            other => panic!("topic set_field 不认识的字段(必是 bug):{other}"),
        };
        let value: Option<String> = conn
            .query_row(&sql, [id], |r| r.get(0))
            .map_err(|e| format!("读取标签字段 {field} 失败({id}):{e}"))?;
        append(conn, clock, "topic", id, "set_field", json!({ "field": field, "value": value }))?;
    }
    Ok(())
}

/// 标签销毁。它名下 link 的死亡由 FK 级联承载(回放同样生效),不逐条发 link_remove。
pub fn topic_tombstone(conn: &Connection, clock: &mut Clock, id: &str) -> Result<(), String> {
    append(conn, clock, "topic", id, "tombstone", json!({}))
}

// ---- space(profile 单例寄存器,space-name-sync-plan §3) ---------------------------

/// 空间名变更(唯一 space 字段)。读行发声:调用方(spaces::set_space_name 编排层)
/// 先 UPSERT `space_profile`,这里读回落 payload——行必须已在(读不到 = 编排 bug,
/// fail-fast)。无 create/无 tombstone;NULL = 显式清名,payload value 落 JSON null。
pub fn space_set_name(conn: &Connection, clock: &mut Clock) -> Result<(), String> {
    let value: Option<String> = conn
        .query_row("SELECT name FROM space_profile WHERE key = 'profile'", [], |r| r.get(0))
        .map_err(|e| format!("读取空间名失败(编排层应先落行):{e}"))?;
    append(conn, clock, "space", "profile", "set_field", json!({ "field": "name", "value": value }))
}

// ---- link (item_topic) -------------------------------------------------------------

/// link 的 op 身份:条目与标签的配对。定长 ULID 中间一个冒号,可拆可索引。
fn link_entity_id(item_id: &str, topic_id: &str) -> String {
    format!("{item_id}:{topic_id}")
}

/// 打标签(item_topic 插入之后)。幂等 no-op(已有该标签)不发射——没写就没有 op。
pub fn link_add(
    conn: &Connection,
    clock: &mut Clock,
    item_id: &str,
    topic_id: &str,
) -> Result<(), String> {
    append(
        conn,
        clock,
        "link",
        &link_entity_id(item_id, topic_id),
        "link_add",
        json!({ "item_id": item_id, "topic_id": topic_id }),
    )
}

/// 去标签(item_topic 删除之后)。同样只在真删了行时发射。payload 的 `observed` 是
/// 发射时本地日志里该 link 的**全部** add op_id(OR-set:remove 只删它见过的 add;
/// 全量列表含已死的 add,多记无害)——回放端凭它放过并发的、没见过的 add。
pub fn link_remove(
    conn: &Connection,
    clock: &mut Clock,
    item_id: &str,
    topic_id: &str,
) -> Result<(), String> {
    let entity_id = link_entity_id(item_id, topic_id);
    let mut stmt = conn
        .prepare(
            "SELECT op_id FROM oplog \
             WHERE entity = 'link' AND entity_id = ?1 AND kind = 'link_add' ORDER BY hlc",
        )
        .map_err(|e| e.to_string())?;
    let observed: Vec<String> = stmt
        .query_map([&entity_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    append(
        conn,
        clock,
        "link",
        &entity_id,
        "link_remove",
        json!({ "item_id": item_id, "topic_id": topic_id, "observed": observed }),
    )
}

// ---- image -----------------------------------------------------------------------

/// 配图挂上(item_image 插入之后):op 只带元数据(编号、MIME、字节数、sha256),
/// 字节本体走旁路分块密文流(sync-protocol §5.4),不进 op 通道。sha256 是旁路到货的
/// 完整性锚(0024 起新发射带;更早的 op 无 hash——旧图只经引导快照到达,不走旁路)。
pub fn image_add(conn: &Connection, clock: &mut Clock, image_id: &str) -> Result<(), String> {
    let (item_id, seq, mime, data) = conn
        .query_row(
            "SELECT item_id, seq, mime, data FROM item_image WHERE id = ?1",
            [image_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .map_err(|e| format!("读取配图元数据失败({image_id}):{e}"))?;
    let sha256: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
    let payload = json!({
        "item_id": item_id,
        "seq": seq,
        "mime": mime,
        "bytes": data.len() as i64,
        "sha256": sha256,
    });
    append(conn, clock, "image", image_id, "image_add", payload)
}

/// 配图删除(行已不在,item_id 由调用方删前读好传入)。
pub fn image_tombstone(
    conn: &Connection,
    clock: &mut Clock,
    image_id: &str,
    item_id: &str,
) -> Result<(), String> {
    append(conn, clock, "image", image_id, "image_tombstone", json!({ "item_id": item_id }))
}

// ---- 读回(测试与将来的同步层) -----------------------------------------------------

/// 一条 op 的完整读回形态。
#[cfg(test)]
pub struct Op {
    pub op_id: String,
    pub hlc: String,
    pub kind: String,
    pub payload: Value,
}

/// 某个对象的 op 流,按 HLC 序(= 发生序)。测试断言与将来的合并层共用。
#[cfg(test)]
pub fn ops_for(conn: &Connection, entity: &str, entity_id: &str) -> Vec<Op> {
    let mut stmt = conn
        .prepare(
            "SELECT op_id, hlc, kind, payload FROM oplog \
             WHERE entity = ?1 AND entity_id = ?2 ORDER BY hlc",
        )
        .expect("prepare ops_for");
    let rows = stmt
        .query_map((entity, entity_id), |r| {
            Ok(Op {
                op_id: r.get(0)?,
                hlc: r.get(1)?,
                kind: r.get(2)?,
                payload: serde_json::from_str(&r.get::<_, String>(3)?)
                    .expect("oplog payload 必须是合法 JSON"),
            })
        })
        .expect("query ops_for");
    rows.collect::<rusqlite::Result<_>>().expect("collect ops_for")
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
            .join(format!("ys-nb-oplog-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open migrated db");
        let clock = Clock::load(&conn).expect("load clock");
        (conn, clock)
    }

    #[test]
    fn append_assigns_monotonic_hlc_and_valid_ulid_op_id() {
        let (conn, mut clock) = fresh();
        let id = repo::add_item(&conn, "想法").unwrap();
        item_set(&conn, &mut clock, &id, &["content"]).unwrap();
        item_set(&conn, &mut clock, &id, &["content"]).unwrap();
        let ops = ops_for(&conn, "item", &id);
        assert_eq!(ops.len(), 2);
        assert!(ops[0].hlc < ops[1].hlc, "同对象 op 流按 HLC 严格递增");
        assert!(Ulid::from_string(&ops[0].op_id).is_ok(), "op_id 是合法 ULID");
        // 取号的水位随事务落盘了。
        let watermark: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key = 'last_hlc'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(format!("{watermark}-{}", &ops[1].hlc[23..]), ops[1].hlc, "水位 = 最后一枚 op 的时间戳");
    }

    #[test]
    fn oplog_is_append_only_at_storage_level() {
        let (conn, mut clock) = fresh();
        let id = repo::add_item(&conn, "想法").unwrap();
        item_create(&conn, &mut clock, &id).unwrap();
        let err = conn.execute("UPDATE oplog SET kind = 'tombstone'", []).unwrap_err();
        assert!(err.to_string().contains("不可改写"), "{err}");
        let err = conn.execute("DELETE FROM oplog", []).unwrap_err();
        assert!(err.to_string().contains("不可删除"), "{err}");
    }

    #[test]
    fn storage_rejects_vocabulary_mismatch() {
        let (conn, _clock) = fresh();
        // link 实体不许用 item 的 kind——CHECK 兜住词汇表(代码传错必是 bug)。
        let err = conn
            .execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES ('op1', 'h1', 'link', 'a:b', 'set_field', '{}', 1)",
                [],
            )
            .unwrap_err();
        assert!(err.to_string().contains("CHECK"), "{err}");
    }

    #[test]
    fn item_create_snapshots_the_born_row() {
        let (conn, mut clock) = fresh();
        let id = repo::add_item(&conn, "捕获的灵感").unwrap();
        item_create(&conn, &mut clock, &id).unwrap();
        let ops = ops_for(&conn, "item", &id);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].kind, "create");
        assert_eq!(ops[0].payload["content"], "捕获的灵感");
        assert_eq!(ops[0].payload["stage"], "inbox");
        assert_eq!(ops[0].payload["born_stage"], "inbox");
        assert!(ops[0].payload["position"].is_null());
        assert!(ops[0].payload["created_at"].is_string());
    }

    #[test]
    fn item_set_reads_values_off_the_row_including_nulls() {
        let (conn, mut clock) = fresh();
        let id = repo::insert_task(&conn, "任务", Some("2026-07-10"), Some(2)).unwrap();
        item_set(&conn, &mut clock, &id, &["stage", "due_on", "priority", "position", "archived_at"]).unwrap();
        let ops = ops_for(&conn, "item", &id);
        let by_field: std::collections::HashMap<String, &Value> = ops
            .iter()
            .map(|o| (o.payload["field"].as_str().unwrap().to_string(), &o.payload["value"]))
            .collect();
        assert_eq!(by_field["stage"], &json!("todo"));
        assert_eq!(by_field["due_on"], &json!("2026-07-10"));
        assert_eq!(by_field["priority"], &json!(2));
        assert_eq!(by_field["position"], &json!("a0"), "0021 起 position 是 fractional 键");
        assert_eq!(by_field["archived_at"], &Value::Null);
    }

    #[test]
    #[should_panic(expected = "不认识的字段")]
    fn item_set_rejects_unknown_field() {
        let (conn, mut clock) = fresh();
        let id = repo::add_item(&conn, "x").unwrap();
        let _ = item_set(&conn, &mut clock, &id, &["updated_at"]); // 簿记字段不在白名单
    }

    #[test]
    fn link_and_topic_and_image_ops_roundtrip() {
        let (conn, mut clock) = fresh();
        let item = repo::add_item(&conn, "想法").unwrap();
        let topic = repo::insert_topic(&conn, "标签").unwrap();

        topic_create(&conn, &mut clock, &topic).unwrap();
        topic_set(&conn, &mut clock, &topic, &["title", "updated_at"]).unwrap();
        let tops = ops_for(&conn, "topic", &topic);
        assert_eq!(tops.len(), 3);
        assert_eq!(tops[0].payload["title"], "标签");

        repo::link_item_topic(&conn, &item, &topic).unwrap();
        link_add(&conn, &mut clock, &item, &topic).unwrap();
        repo::unlink_item_topic(&conn, &item, &topic).unwrap();
        link_remove(&conn, &mut clock, &item, &topic).unwrap();
        let lops = ops_for(&conn, "link", &format!("{item}:{topic}"));
        assert_eq!(lops.len(), 2);
        assert_eq!(lops[0].kind, "link_add");
        assert_eq!(lops[1].kind, "link_remove");
        assert_eq!(lops[1].payload["topic_id"], json!(topic));

        let img = "01IMGIMGIMGIMGIMGIMGIMG000";
        repo::next_image_seq(&conn, &item).unwrap();
        repo::insert_item_image(&conn, img, &item, 1, &[1u8, 2, 3], "image/png").unwrap();
        image_add(&conn, &mut clock, img).unwrap();
        repo::delete_item_image(&conn, img).unwrap();
        image_tombstone(&conn, &mut clock, img, &item).unwrap();
        let iops = ops_for(&conn, "image", img);
        assert_eq!(iops.len(), 2);
        assert_eq!(iops[0].payload["seq"], json!(1));
        assert_eq!(iops[0].payload["mime"], "image/png");
        assert_eq!(iops[0].payload["bytes"], json!(3));
        assert_eq!(
            iops[0].payload["sha256"],
            json!("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"),
            "image_add 带字节 sha256(旁路完整性锚,0024)"
        );
        assert_eq!(iops[1].payload["item_id"], json!(item));
    }

    // ---- origin_seq:第三轴(0024) ---------------------------------------------------

    #[test]
    fn append_numbers_origin_seq_contiguously_in_hlc_order() {
        let (conn, mut clock) = fresh();
        let a = repo::add_item(&conn, "甲").unwrap();
        item_create(&conn, &mut clock, &a).unwrap();
        item_set(&conn, &mut clock, &a, &["content"]).unwrap();
        let topic = repo::insert_topic(&conn, "标签").unwrap();
        topic_create(&conn, &mut clock, &topic).unwrap();
        repo::link_item_topic(&conn, &a, &topic).unwrap();
        link_add(&conn, &mut clock, &a, &topic).unwrap();

        let rows: Vec<(String, i64, String)> = {
            let mut stmt = conn
                .prepare("SELECT hlc, origin_seq, origin FROM oplog ORDER BY hlc")
                .unwrap();
            let it = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap();
            it.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(rows.len(), 4);
        for (i, (hlc, seq, origin)) in rows.iter().enumerate() {
            assert_eq!(*seq, i as i64 + 1, "本机发射序号连续 1..n,且 seq 序 == hlc 序");
            assert_eq!(origin, &hlc[23..], "origin 生成列 == hlc 内嵌的设备号");
            assert_eq!(origin, clock.device_id(), "本机 op 的 origin 就是本机 device_id");
        }
    }

    #[test]
    fn storage_guards_origin_seq_axis() {
        let (conn, mut clock) = fresh();
        let id = repo::add_item(&conn, "想法").unwrap();
        item_create(&conn, &mut clock, &id).unwrap();
        let (hlc, seq): (String, i64) = conn
            .query_row("SELECT hlc, origin_seq FROM oplog LIMIT 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        // 同 (origin, origin_seq) 第二枚 op:UNIQUE 响亮兜底(取号前提被破坏时不静默分叉)。
        let dup_hlc = format!("fffffffffffff-00000000-{}", &hlc[23..]);
        let err = conn
            .execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES ('opdup', ?1, 'item', 'x', 'tombstone', '{}', ?2)",
                (&dup_hlc, seq),
            )
            .unwrap_err();
        assert!(err.to_string().contains("UNIQUE"), "{err}");
        // origin_seq < 1 不是合法序号(连续号从 1 起)。
        let err = conn
            .execute(
                "INSERT INTO oplog (op_id, hlc, entity, entity_id, kind, payload, origin_seq) \
                 VALUES ('opzero', ?1, 'item', 'x', 'tombstone', '{}', 0)",
                [&dup_hlc],
            )
            .unwrap_err();
        assert!(err.to_string().contains("CHECK"), "{err}");
    }
}
