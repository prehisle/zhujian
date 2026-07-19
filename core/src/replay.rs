//! 远端 op 回放 —— sync-plan P1「触发器回放豁免标志」:`apply_remote_op` 独立入口。
//!
//! 单机写路径(lib.rs 命令 → notes/task/images 编排)发射 op;本模块是它的镜像——
//! **应用别的设备发来的 op**,并落实删除墓碑 A 案的两条回放契约(sync-plan §3.5):
//!
//!   ① **tombstone 是实体存在性的不可逆事实,不是 LWW 里的一个字段值**:某实体一旦
//!      有 tombstone op,后续再高 HLC 的 create/set_field/image_add 也不复活它
//!      (delete-wins-sticky)。判定查 oplog——行已硬删,记忆在日志不在表。
//!   ② **父 tombstone 支配子 link/image**:收到 item/topic tombstone 靠本地 FK CASCADE
//!      清子物(与单机同一条共享 schema 知识);晚到的、指向已 tombstone 父的
//!      link_add/image_add 一律只记账、**绝不为子 op 重建父行**;级联后才到的
//!      child tombstone / link_remove 是幂等 no-op,不报同步错。
//!
//! 核心机械(顺序有讲究,codex 评审定稿):
//!
//!   * **每 op 一个事务**:置回放标志(sync_replay_active 单行表,0022 的守护触发器
//!     WHEN 查它豁免)→ **先记账**(oplog::append_remote,保留远端 op_id/HLC)→ 分发
//!     应用 → observe 推 HLC 水位 → 清标志 → 提交。任何 Err 整体回滚,标志随事务
//!     消失,不存在泄漏到正常写路径的窗口。
//!   * **先记账再应用**:全部判定(tombstone sticky / 字段 LWW / OR-set 存活)都查
//!     oplog,当前 op 必须已在场——否则 OR-set 重算看不到自己,两端必分叉。
//!   * **字段级 LWW**:某字段的赢家 = 该实体 create + 该字段全部 set_field 里 HLC 最大
//!     的那条(create 快照写下字段初值,必须参赛;HLC 全局唯一,无平局)。当前 op 已
//!     入账,故「应用与否」= 自己是不是唯一的 MAX。输家只记账(它仍是史实,也是将来
//!     判定的依据)——**读日志重建状态的人必须走同一套判定,不能把 op 流当「全部生效
//!     过」的流水账**。
//!   * **link 的 OR-set**:remove 的 payload 带 `observed`(发射时其本地日志里该 link
//!     的全部 add op_id);某 add 存活 ⟺ 它不被任何 remove 的 observed 覆盖;行状态 =
//!     「存活 add ≥ 1」。并发的、remove 没见过的 add 因此活下来——这就是「remove 只删
//!     它见过的 add」。0022 前发射的 remove 没有 observed 键——**遗留形态只随引导快照
//!     导入、不走帧**(帧入口拒缺 key),读法=「覆盖一切更低 HLC 的同关联 add」(单机
//!     史实总序=HLC 序,与 boot.rs 审计同口径;真机验收 2026-07-09 抓的误拒,codex 复审)。
//!   * **所有 oplog 判定都带 entity 谓词**(item/topic/image 的 id 都是 ULID,理论可
//!     碰撞;少了 entity 就是确定性串扰)。
//!
//! 调用方契约(sync-protocol §5.3 弱化形,由 sync::engine 兑现):**per-origin 按
//! origin_seq(== 该 origin 内的 HLC 序)升序、跨 origin 任意交错**,Err-挂起-重试
//! 兜住跨 origin 因果。活性论证:op 的因果依赖(编辑依赖 create、link 依赖两端行)
//! 恒指向更低 HLC 的 op(observe:能引用必先见过),每条队内按 HLC 升序放行,依赖链
//! 沿 HLC 严格递减、必终结于无依赖的 op——无环、必有进展,不会互锁。LWW/tombstone-
//! sticky/OR-set 判定全按日志全集重算,与到达序无关(codex 一轮已核:乱序但最终全到,
//! 终局与全局 HLC 升序喂入一致)。set_field/link 撞上「行缺失且无 tombstone」= 依赖
//! 尚未到达,fail-fast 拒收整条 op(事务回滚、不记账、不推水位),由引擎挂起该 origin
//! 队头、每有 op 落地对全部挂起头重试到不动点。
//!
//! 「图N」并发撞号(sync-plan §3.1 明示放宽的一处):有效编号 = 该条目全部 image_add
//! op 按 HLC 升序逐条分配的**纯函数**(原号空闲得原号,撞号者顺延 max+1;最早 add 之前
//! 的号全是 op 纪元前的遗产,视为已占用),行上的 seq 只是它的缓存,由
//! reconcile_item_images 在每条 image_add 回放时核对翻案。正文「见图N」只修正**本机
//! 背书的文本**(content 的 LWW 胜者出自本机、且图的 add 早于胜者),且走有 op 背书的
//! 正道(发真 set_field);别机文本的「图N」指写作者视野的图、按同一纯函数分配,全局
//! 自然一致。翻案发生时返回 RenumberedLocalImages——**P2 必须把它转成用户可见提示**。
//!
//! 刻意不做的:批量回放、水位向量、传输(P2);图片字节(走 P2 旁路,image_add 不建
//! 行,行等字节到达再建——**旁路建行前必须查该 image 的 tombstone,行的 seq 必须取
//! 建行时刻 reconcile_item_images 重算的有效编号**,这是留给 P2 的契约);对 LWW 终态
//! 做无 op 背书的「修补」(两端修补时机随到达序漂移,必不收敛——终态允许违反单机
//! 不变量,读层按 stage 谓词查询不受伤)。

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::clock::{Clock, Hlc};
use crate::oplog;

/// 一条远端 op 的完整形态(oplog 行的镜像;P2 的传输层负责从密文帧解出它)。
/// P2-d 起随 `sync::engine::Msg::Ops` 走 CBOR 线上格式:字段名即线上键,改名 =
/// 协议破坏;payload 是 `serde_json::Value`,JSON 各形态经 CBOR 往返无损(有测)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteOp {
    pub op_id: String,
    pub hlc: String,
    pub entity: String,
    pub entity_id: String,
    pub kind: String,
    pub payload: Value,
    /// 源设备发射序号(0024 第三轴)。本层原样记账;「per-origin 连续、只喂
    /// watermark+1」是收端引擎(P2-c)的职责,不在每 op 里重复校验。
    pub origin_seq: i64,
}

/// op 校验器版本(epoch-plan §4 升级重验状态机的筛选轴):`validate_op_shape` /
/// apply 层状态型校验的判定规则**每次实质变更必须 +1**——quarantine 行记下隔离时的
/// 版本,engine 在重验时只对 `validator_ver < VALIDATOR_VER` 的行以新规则重跑,
/// 「升级修好了误判」的自助恢复路全靠它区分新旧规则。v1 = 严格纪元首版(2a 工序1:
/// 删三处 legacy 容忍 + born_stage:null 收编 + typed 分型);v2 = 0028 space 词汇
/// (空间名跨端同步:space/profile 单例寄存器 + name 值域,space-name-sync-plan §4.3)。
pub(crate) const VALIDATOR_VER: i64 = 2;

/// typed poison 错误分型(epoch-plan §4):`validate_op_shape` 与 `apply_remote_op`
/// 返回**同一枚举**,分型在源头、不靠错误字符串事后分类。engine 按型分道:
/// UnsupportedVocab/DependencyMissing 挂起重试(既有自愈语义),InvalidOp 持久隔离
/// (quarantine,工序2 接线),LocalFault 原样冒泡(不隔离不挂起,会话层处置)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpError {
    /// 词汇表外的 entity/kind/field = 版本偏斜(对端较新),挂起 + UI 提示升级。
    UnsupportedVocab(String),
    /// 已知词汇下的形态/值域非法、身份自相矛盾,以及依赖本地日志的状态型非法
    /// (重复 create/重复 image_add/把库推进约束违例等)= 毒 op。
    InvalidOp(String),
    /// 跨 origin 因果依赖未到(行缺失且无墓碑):挂起、每有进展重试,崩溃即丢无害。
    DependencyMissing(String),
    /// 本地 IO/SQL 故障:与 op 内容无关,冒泡给会话层。
    LocalFault(String),
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpError::UnsupportedVocab(m)
            | OpError::InvalidOp(m)
            | OpError::DependencyMissing(m)
            | OpError::LocalFault(m) => f.write_str(m),
        }
    }
}

/// SQLite 错误的分型:约束违例是**数据驱动**的(op 内容把库推进非法态,如撞 CHECK/
/// UNIQUE)= InvalidOp;其余(IO/busy/损坏)与 op 内容无关 = LocalFault。
fn db_err(ctx: &str, e: rusqlite::Error) -> OpError {
    match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            OpError::InvalidOp(format!("{ctx}:{e}"))
        }
        _ => OpError::LocalFault(format!("{ctx}:{e}")),
    }
}

/// 纯 SELECT / 簿记类失败与 op 内容无关,一律本地故障。
fn local(e: impl std::fmt::Display) -> OpError {
    OpError::LocalFault(e.to_string())
}

/// 应用结果。除 AlreadySeen 外,op 都已记入本地日志、水位已推进。
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// op 语义已落地(建行/改行/删行,或幂等地本就处于目标状态)。
    Applied,
    /// op_id 已在本地日志——重放/重传,整体跳过(当时已 observe 过,水位早已覆盖)。
    AlreadySeen,
    /// 字段级 LWW 输给已见过的更高 HLC 写,只记账不动行。
    LwwStale,
    /// 实体自身已有 tombstone,永不复活(契约①),只记账。
    SuppressedByTombstone,
    /// 父实体已 tombstone,子 op 只记账、绝不重建父行(契约②)。
    ParentGone,
    /// 「图N」并发撞号:这条远端 image_add 与本地已落行的图并发取到同号,HLC 大的
    /// 本地图已确定性顺延到新号(行 seq 已改)。P2 必须把它转成用户可见提示
    /// (sync-plan §3.1「正文引用同步修正**并提示**」的提示义务)。
    RenumberedLocalImages {
        /// 被顺延的本地图:(image_id, 旧「图N」, 新「图N」)。
        renumbered: Vec<(String, i64, i64)>,
        /// 正文「见图N」是否已同步修正(仅当 content 的 LWW 胜者文本出自本机)。
        content_rewritten: bool,
    },
}

/// 应用一条远端 op。见模块注释;错误 = 拒收整条 op(事务回滚,不记账不推水位),
/// 且按 [`OpError`] 分型(epoch-plan §4)。
pub fn apply_remote_op(
    conn: &mut Connection,
    clock: &mut Clock,
    op: &RemoteOp,
) -> Result<Outcome, OpError> {
    let hlc = Hlc::parse(&op.hlc).map_err(OpError::InvalidOp)?;
    // op-shape 单一真相源(与 boot 引导审计共用):畸形 op 早拒,不开事务(bedrock-fix §9)。
    // 词汇表校验并在其中(未知 entity/kind = UnsupportedVocab)。
    validate_op_shape(op)?;

    let tx = conn.transaction().map_err(local)?;
    match logged_op_matches(&tx, op).map_err(local)? {
        Some(true) => return Ok(Outcome::AlreadySeen), // 事务无写,drop 即回滚。
        Some(false) => {
            return Err(OpError::InvalidOp(format!(
                "op {} 已在日志但内容/坐标不同(分叉或数据损坏),拒收",
                op.op_id
            )));
        }
        None => {}
    }
    tx.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", [])
        .map_err(local)?;
    oplog::append_remote(
        &tx,
        &op.op_id,
        &op.hlc,
        &op.entity,
        &op.entity_id,
        &op.kind,
        &op.payload,
        op.origin_seq,
    )
    .map_err(|e| db_err(&format!("远端 op 入库失败({})", op.op_id), e))?;

    let outcome = match (op.entity.as_str(), op.kind.as_str()) {
        ("item", "create") => apply_item_create(&tx, op)?,
        ("item", "set_field") => apply_item_set_field(&tx, op)?,
        ("item", "tombstone") => apply_entity_tombstone(&tx, "items", &op.entity_id)?,
        ("topic", "create") => apply_topic_create(&tx, op)?,
        ("topic", "set_field") => apply_topic_set_field(&tx, op)?,
        ("topic", "tombstone") => apply_entity_tombstone(&tx, "topics", &op.entity_id)?,
        ("link", _) => apply_link(&tx, op)?,
        ("image", "image_add") => apply_image_add(&tx, clock, op, &hlc)?,
        ("image", "image_tombstone") => apply_image_tombstone(&tx, op)?,
        ("space", "set_field") => apply_space_set_field(&tx, op)?,
        _ => unreachable!("词汇表已在入口校验"),
    };

    clock.observe(&tx, &hlc).map_err(local)?;
    tx.execute("DELETE FROM sync_replay_active", []).map_err(local)?;
    tx.commit().map_err(local)?;
    Ok(outcome)
}

// ---- 分发:item / topic ----------------------------------------------------------

/// item create:出生快照落行。updated_at = 快照 created_at(出生时刻两者相等,不伪造
/// 新鲜度);archived_at/sealed_at 生而 NULL(不在快照里,0014/0017 语义)。单机发射的
/// 快照 stage 恒 == born_stage(发射端出生时刻读行);**纪元压实基线的 create 是现值
/// 快照**(epoch-plan §2.3):stage = 压实时刻现值、born_stage = 史实(可 null =
/// pre-0018「未知不回填」)——`trg_item_born_stage_required` 在回放豁免下放行(0025)。
fn apply_item_create(tx: &Connection, op: &RemoteOp) -> Result<Outcome, OpError> {
    if has_tombstone(tx, "item", &op.entity_id).map_err(local)? {
        return Ok(Outcome::SuppressedByTombstone);
    }
    if row_exists(tx, "items", &op.entity_id).map_err(local)? {
        // create 每实体恰一条(op_id 幂等已挡重放);撞上已存在的行 = 状态型非法
        // (重复 create / 引导逻辑出错),不是可合并的冲突。
        return Err(OpError::InvalidOp(format!(
            "回放异常:item {} 的 create 撞上已存在的行",
            op.entity_id
        )));
    }
    let p = &op.payload;
    let inv = OpError::InvalidOp;
    tx.execute(
        "INSERT INTO items (id, content, stage, created_at, updated_at, archived_at, \
                            due_on, priority, position, sealed_at, born_stage) \
         VALUES (?1, ?2, ?3, ?4, ?4, NULL, ?5, ?6, ?7, NULL, ?8)",
        (
            &op.entity_id,
            str_field(p, "content").map_err(inv)?,
            str_field(p, "stage").map_err(inv)?,
            str_field(p, "created_at").map_err(inv)?,
            opt_str_field(p, "due_on").map_err(inv)?,
            opt_int_field(p, "priority").map_err(inv)?,
            opt_str_field(p, "position").map_err(inv)?,
            opt_str_field(p, "born_stage").map_err(inv)?,
        ),
    )
    .map_err(|e| db_err(&format!("回放 item create 失败({})", op.entity_id), e))?;
    Ok(Outcome::Applied)
}

/// item set_field:字段级 LWW。赢了 UPDATE 单字段并摸 updated_at(items 的 updated_at
/// 是**本地簿记**、不在同步白名单里,语义是「本行最后一次变化」——远端变更落地也算);
/// 输了只记账。值域(stage 枚举/due_on 格式/priority 1..3/position 形态)由表 CHECK
/// 把关,非法值 = 数据损坏,fail-fast 拒收。
fn apply_item_set_field(tx: &Connection, op: &RemoteOp) -> Result<Outcome, OpError> {
    if has_tombstone(tx, "item", &op.entity_id).map_err(local)? {
        return Ok(Outcome::SuppressedByTombstone);
    }
    if !row_exists(tx, "items", &op.entity_id).map_err(local)? {
        return Err(OpError::DependencyMissing(format!(
            "回放依赖未到:item {} 的 set_field 先于 create(引擎挂起重试,§5.3)",
            op.entity_id
        )));
    }
    let field = str_field(&op.payload, "field").map_err(OpError::InvalidOp)?;
    let value = item_field_value(&field, field_value(&op.payload).map_err(OpError::InvalidOp)?)
        .map_err(OpError::InvalidOp)?;
    if !is_latest_field_write(tx, "item", &op.entity_id, &field, &op.hlc).map_err(local)? {
        return Ok(Outcome::LwwStale);
    }
    tx.execute(
        &format!(
            "UPDATE items SET {field} = ?1, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2"
        ),
        (value, &op.entity_id),
    )
    .map_err(|e| db_err(&format!("回放 item set_field {field} 失败({})", op.entity_id), e))?;
    Ok(Outcome::Applied)
}

/// topic create:payload 只有 {title, created_at};updated_at 是**同步字段**(驱动
/// chip 顺序),出生约定 = created_at(与 repo::insert_topic 同一语义),此后的值走它
/// 自己的 set_field op。
fn apply_topic_create(tx: &Connection, op: &RemoteOp) -> Result<Outcome, OpError> {
    if has_tombstone(tx, "topic", &op.entity_id).map_err(local)? {
        return Ok(Outcome::SuppressedByTombstone);
    }
    if row_exists(tx, "topics", &op.entity_id).map_err(local)? {
        return Err(OpError::InvalidOp(format!(
            "回放异常:topic {} 的 create 撞上已存在的行",
            op.entity_id
        )));
    }
    tx.execute(
        "INSERT INTO topics (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        (
            &op.entity_id,
            str_field(&op.payload, "title").map_err(OpError::InvalidOp)?,
            str_field(&op.payload, "created_at").map_err(OpError::InvalidOp)?,
        ),
    )
    .map_err(|e| db_err(&format!("回放 topic create 失败({})", op.entity_id), e))?;
    Ok(Outcome::Applied)
}

/// topic set_field:白名单 title/updated_at/color(见 [`topic_field_value`]),都是同步
/// 字段——**严格写 payload 值,不摸任何别的列**(updated_at 若摸 now,两端必写出不同值,
/// 确定性分叉)。color 可空(NULL = 无色,允许清空)。
fn apply_topic_set_field(tx: &Connection, op: &RemoteOp) -> Result<Outcome, OpError> {
    if has_tombstone(tx, "topic", &op.entity_id).map_err(local)? {
        return Ok(Outcome::SuppressedByTombstone);
    }
    if !row_exists(tx, "topics", &op.entity_id).map_err(local)? {
        return Err(OpError::DependencyMissing(format!(
            "回放依赖未到:topic {} 的 set_field 先于 create(引擎挂起重试,§5.3)",
            op.entity_id
        )));
    }
    let field = str_field(&op.payload, "field").map_err(OpError::InvalidOp)?;
    let value = topic_field_value(&field, field_value(&op.payload).map_err(OpError::InvalidOp)?)
        .map_err(OpError::InvalidOp)?;
    if !is_latest_field_write(tx, "topic", &op.entity_id, &field, &op.hlc).map_err(local)? {
        return Ok(Outcome::LwwStale);
    }
    tx.execute(
        &format!("UPDATE topics SET {field} = ?1 WHERE id = ?2"),
        (value, &op.entity_id),
    )
    .map_err(|e| db_err(&format!("回放 topic set_field {field} 失败({})", op.entity_id), e))?;
    Ok(Outcome::Applied)
}

/// space profile 单例寄存器(space-name-sync-plan §3.3):**无 create、无 tombstone**,
/// 恰零或一行('profile')。无「行不存在→DependencyMissing」一说——寄存器没有出生
/// 事件,首条 set_field 就是 UPSERT;LWW 与 topic 同款字段级比较(参赛者只有 set_field,
/// 全日志 MAX(hlc) 是唯一赢家)。「行不存在∧本 op 非赢家」在诚实历史下不可达(非赢家
/// 意味着更晚的赢家 op 已在日志、其应用时已落行),若真出现是本地既有损坏,由 strict
/// battery 的双向审计拒,live 不在此加状态检查。
fn apply_space_set_field(tx: &Connection, op: &RemoteOp) -> Result<Outcome, OpError> {
    let field = str_field(&op.payload, "field").map_err(OpError::InvalidOp)?;
    // shape 层已限 field=="name";这里按白名单读值(String 或 null),与 topic 同构。
    let value: Option<String> = match field_value(&op.payload).map_err(OpError::InvalidOp)? {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        other => {
            return Err(OpError::InvalidOp(format!("space 字段 {field} 期待字符串或 null:{other}")))
        }
    };
    if !is_latest_field_write(tx, "space", &op.entity_id, &field, &op.hlc).map_err(local)? {
        return Ok(Outcome::LwwStale);
    }
    tx.execute(
        "INSERT INTO space_profile (key, name) VALUES ('profile', ?1) \
         ON CONFLICT(key) DO UPDATE SET name = excluded.name",
        [&value],
    )
    .map_err(|e| db_err("回放 space set_field 失败", e))?;
    Ok(Outcome::Applied)
}

/// item/topic tombstone:DELETE 该行(回放豁免下,删除守护/归档不可删让路;FK CASCADE
/// 清 link/image/counter/revisions——与单机彻底删除同一条共享 schema 知识)。行本就
/// 不在 = 幂等(本地已删过 / 已被父级联),同样 Applied:op 的语义「该实体已死」成立。
fn apply_entity_tombstone(tx: &Connection, table: &str, id: &str) -> Result<Outcome, OpError> {
    tx.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [id])
        .map_err(|e| db_err(&format!("回放 tombstone 失败({table} {id})"), e))?;
    Ok(Outcome::Applied)
}

// ---- 分发:link -------------------------------------------------------------------

/// link_add / link_remove 同一处置:记账已在主流程做完,这里按 OR-set 重算该 link 的
/// 存活性并把 item_topic 行同步过去。add 与 remove 谁先谁后、来几条,结果都由日志的
/// 纯函数判定,天然收敛。
fn apply_link(tx: &Connection, op: &RemoteOp) -> Result<Outcome, OpError> {
    let item_id = str_field(&op.payload, "item_id").map_err(OpError::InvalidOp)?;
    let topic_id = str_field(&op.payload, "topic_id").map_err(OpError::InvalidOp)?;
    // entity_id 与 payload 必须指同一个配对:日志按 entity_id 重算、行按 payload 增删,
    // 两者不一致就是「不由本 op 背书」的表状态,坏 op 一律拒收(codex 二轮抓的洞)。
    // validate_op_shape 已在入口拦过,这里是 apply 层的纵深防御(引导导入的日志绕过入口)。
    if op.entity_id != format!("{item_id}:{topic_id}") {
        return Err(OpError::InvalidOp(format!(
            "link op 的 entity_id 与 payload 不一致:{} vs {item_id}:{topic_id}",
            op.entity_id
        )));
    }
    // observed 必带且为字符串数组(严格纪元,epoch-plan §3.1):无 observed 的遗留
    // 形态已被纪元压实消灭,live 与 boot 同拒——形状在入口钉死求响亮(重算 SQL 已是
    // NOT EXISTS + `je.value = a.op_id`,NULL 元素永不相等、毒化不了判定——但引导导入
    // 的日志绕过本入口,这里是第二道防线)。
    if op.kind == "link_remove" {
        match op.payload.get("observed") {
            Some(Value::Array(a)) if a.iter().all(Value::is_string) => {}
            other => {
                return Err(OpError::InvalidOp(format!(
                    "link_remove 的 observed 必带且为字符串数组(严格纪元),收到:{other:?}"
                )))
            }
        }
    }
    // 契约②:父实体一旦 tombstone,子 op 只记账;级联后才到的 child op 幂等不报错。
    if has_tombstone(tx, "item", &item_id).map_err(local)?
        || has_tombstone(tx, "topic", &topic_id).map_err(local)?
    {
        return Ok(Outcome::ParentGone);
    }
    if !row_exists(tx, "items", &item_id).map_err(local)?
        || !row_exists(tx, "topics", &topic_id).map_err(local)?
    {
        return Err(OpError::DependencyMissing(format!(
            "回放依赖未到:link {} 的父实体行缺失且无 tombstone(引擎挂起重试,§5.3)",
            op.entity_id
        )));
    }
    // 存活 add = 不被任何 remove 的 observed 覆盖的 add(纯 OR-set)。无 observed 的
    // 遗留 remove 宽语义分支已随纪元切换删除(epoch-plan §3.1):严格形态下这种 op
    // 进不了日志(live 入口与 boot 审计同拒),压实把存量史实消灭——boot.rs 审计的
    // 重算与此同口径,两处必须一起改。
    let alive: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM oplog a \
             WHERE a.entity = 'link' AND a.entity_id = ?1 AND a.kind = 'link_add' \
               AND NOT EXISTS ( \
                   SELECT 1 FROM oplog r, \
                        json_each(COALESCE(json_extract(r.payload, '$.observed'), '[]')) je \
                   WHERE r.entity = 'link' AND r.entity_id = ?1 AND r.kind = 'link_remove' \
                     AND je.value = a.op_id)",
            [&op.entity_id],
            |r| r.get(0),
        )
        .map_err(|e| local(format!("OR-set 存活重算失败({}):{e}", op.entity_id)))?;
    if alive > 0 {
        tx.execute(
            "INSERT OR IGNORE INTO item_topic (item_id, topic_id) VALUES (?1, ?2)",
            (&item_id, &topic_id),
        )
    } else {
        tx.execute(
            "DELETE FROM item_topic WHERE item_id = ?1 AND topic_id = ?2",
            (&item_id, &topic_id),
        )
    }
    .map_err(|e| db_err(&format!("OR-set 行同步失败({})", op.entity_id), e))?;
    Ok(Outcome::Applied)
}

// ---- 分发:image ------------------------------------------------------------------

/// image_add:op 只带元数据,字节走 P2 旁路——**不建 item_image 行**;把这条 add 并进
/// 该条目的「图N」有效编号核对(reconcile_item_images):counter 水位推平;若与本地
/// 已落行的图并发撞号,HLC 大的本地图确定性顺延改号(0016「编号永不改指」在多写者下
/// 的唯一放宽,sync-plan §3.1),正文「见图N」跟着修正——**只改本机背书的文本**:
/// content 的 LWW 胜者 op 出自本机、且该图的 add 早于胜者(写正文时图已在场)才改;
/// 胜者出自别机时,那段文本的「图N」指写作者视野的图,其所指按同一纯函数分配、全局
/// 一致,本机代改反而会改错。图自身的 tombstone 已在场(乱序)也照做核对(编号用过
/// 就是用过),但标记为被压制——P2 字节到达时同样要查 tombstone,不为死图建行。
fn apply_image_add(
    tx: &Connection,
    clock: &mut Clock,
    op: &RemoteOp,
    hlc: &Hlc,
) -> Result<Outcome, OpError> {
    let inv = OpError::InvalidOp;
    let item_id = str_field(&op.payload, "item_id").map_err(inv)?;
    let seq = int_field(&op.payload, "seq").map_err(inv)?;
    if seq < 1 {
        return Err(inv(format!("image_add 的 seq 必须 ≥1,收到:{seq}")));
    }
    // 元数据形状随手钉死(白名单同 0016 的 mime CHECK):P2 字节旁路建行时要靠它们。
    // validate_op_shape 已在入口拦过;引导导入的日志绕过入口,这里是纵深防御。
    let mime = str_field(&op.payload, "mime").map_err(inv)?;
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp" | "image/gif") {
        return Err(inv(format!("image_add 的 mime 不在白名单:{mime}")));
    }
    let declared_bytes = int_field(&op.payload, "bytes").map_err(inv)?;
    if declared_bytes < 1 {
        return Err(inv("image_add 的 bytes 必须 ≥1".to_string()));
    }
    // 声明值封顶(codex 三轮 Medium):收端攒块按声明值设限,声明本身无上限 = 仍是
    // 无界内存。与本地 attach 同一条协议级红线(images::MAX_IMAGE_BYTES)。
    if declared_bytes > crate::images::MAX_IMAGE_BYTES as i64 {
        return Err(inv(format!(
            "image_add 声明的 bytes {declared_bytes} 超过上限 {}",
            crate::images::MAX_IMAGE_BYTES
        )));
    }
    // sha256 必带(严格纪元,epoch-plan §3.1):0024 起发射恒带;无 hash 的遗留 op
    // 已被纪元压实消灭(压实对现存字节现算 sha)。64 位小写 hex 与发射端 oplog.rs 一致。
    let sha = str_field(&op.payload, "sha256").map_err(inv)?;
    if sha.len() != 64 || !sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(inv(format!("image_add 的 sha256 形态非法:{sha}")));
    }
    // 该图已有 tombstone(乱序先到)时,其声称的宿主必须与本 add 一致——假 tombstone
    // (item_id 对不上)能把合法图永久压死且不进缺字节清单,是静默丢图(codex 二轮
    // #2);对称于 apply_image_tombstone 里「tombstone 对 add」的反向校验。
    let bad_ts: Option<String> = tx
        .query_row(
            "SELECT json_extract(payload, '$.item_id') FROM oplog \
             WHERE entity = 'image' AND entity_id = ?1 AND kind = 'image_tombstone' \
               AND json_extract(payload, '$.item_id') != ?2 LIMIT 1",
            (&op.entity_id, &item_id),
            |r| r.get(0),
        )
        .optional()
        .map_err(local)?;
    if let Some(bad) = bad_ts {
        return Err(inv(format!(
            "image_add 的宿主 {item_id} 与已在场 tombstone 声称的 {bad} 不一致,拒收"
        )));
    }
    // 同一图至多一条 add(item/topic create 的「每实体恰一条」同款):第二条 = 数据
    // 损坏,拒收——纯函数会把一个 image_id 当两张图分配,行缓存无从对齐(codex 抓的洞)。
    let add_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM oplog \
             WHERE entity = 'image' AND entity_id = ?1 AND kind = 'image_add'",
            [&op.entity_id],
            |r| r.get(0),
        )
        .map_err(local)?;
    if add_count != 1 {
        return Err(inv(format!(
            "回放异常:image {} 已有 image_add,重复的 add 拒收",
            op.entity_id
        )));
    }
    if has_tombstone(tx, "item", &item_id).map_err(local)? {
        return Ok(Outcome::ParentGone); // 父行已死,counter 行也已随 CASCADE 消失。
    }
    if !row_exists(tx, "items", &item_id).map_err(local)? {
        return Err(OpError::DependencyMissing(format!(
            "回放依赖未到:image {} 的宿主 item {item_id} 行缺失且无 tombstone(引擎挂起重试,§5.3)",
            op.entity_id
        )));
    }
    let renumbered = reconcile_item_images(tx, &item_id)?;
    if !renumbered.is_empty() {
        let content_rewritten =
            rewrite_local_content_refs(tx, clock, &item_id, hlc, &renumbered).map_err(local)?;
        return Ok(Outcome::RenumberedLocalImages {
            renumbered: renumbered
                .into_iter()
                .map(|r| (r.image_id, r.old_seq, r.new_seq))
                .collect(),
            content_rewritten,
        });
    }
    if has_tombstone(tx, "image", &op.entity_id).map_err(local)? {
        return Ok(Outcome::SuppressedByTombstone);
    }
    Ok(Outcome::Applied)
}

/// image_tombstone:删本地图行;行不在(字节从未到 / 已随父级联)= 幂等。payload 的
/// item_id 与日志里该图 add 的宿主不一致 = 两条 op 各说各话,数据损坏,拒收。
fn apply_image_tombstone(tx: &Connection, op: &RemoteOp) -> Result<Outcome, OpError> {
    let item_id = str_field(&op.payload, "item_id").map_err(OpError::InvalidOp)?;
    let add_item: Option<String> = tx
        .query_row(
            "SELECT json_extract(payload, '$.item_id') FROM oplog \
             WHERE entity = 'image' AND entity_id = ?1 AND kind = 'image_add' LIMIT 1",
            [&op.entity_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(local)?
        .flatten();
    if let Some(add_item) = add_item {
        if add_item != item_id {
            return Err(OpError::InvalidOp(format!(
                "image_tombstone 的 item_id 与其 add 不一致:{item_id} vs {add_item}"
            )));
        }
    }
    tx.execute("DELETE FROM item_image WHERE id = ?1", [&op.entity_id])
        .map_err(|e| db_err(&format!("回放 image_tombstone 失败({})", op.entity_id), e))?;
    Ok(Outcome::Applied)
}

/// 旁路字节到达的处置结果(§5.4;engine 据此维护缺字节清单)。
#[derive(Debug, PartialEq, Eq)]
pub enum BytesOutcome {
    /// 行已建,「图N」= 建行时刻的有效编号。
    Applied { seq: i64 },
    /// 图或宿主已 tombstone,字节丢弃(不为死图建行,72 契约)。
    Dropped,
    /// 行已在(重复拉取),幂等跳过。
    AlreadyPresent,
}

/// 图字节旁路到达,建 item_image 行——72 契约的 P2 兑现(sync-protocol §5.4):
/// 元数据以日志里该图的 image_add op 为准(engine 只对已应用的 add 拉字节,日志必有);
/// 验货长度必查、op 带 sha256 则 hash 必查(0024 起新发射都带;更早的 op 只经引导快照
/// 到达,不走旁路);查图与宿主的 tombstone(死图不建行);行 seq 取**建行时刻**
/// effective_seqs 重算的有效编号(不取 payload.seq——它可能已被撞号顺延);回放豁免
/// 事务内插行(快照终态可能违反单机耦合不变量;编号不变量若被破坏由 UNIQUE(item_id,
/// seq) 响亮兜底)。不发射 op、不 observe(该 op 早在 image_add 记账时入过水位);
/// created_at 是本地簿记 = 字节落地时刻。
pub fn apply_image_bytes(
    conn: &mut Connection,
    image_id: &str,
    data: &[u8],
) -> Result<BytesOutcome, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (item_id, mime, bytes, sha256): (String, String, i64, Option<String>) = tx
        .query_row(
            "SELECT json_extract(payload, '$.item_id'), json_extract(payload, '$.mime'), \
                    CAST(json_extract(payload, '$.bytes') AS INTEGER), \
                    json_extract(payload, '$.sha256') \
             FROM oplog WHERE entity = 'image' AND entity_id = ?1 AND kind = 'image_add'",
            [image_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("字节到达但日志无 image_add(引擎只该对已应用的 add 拉字节):{image_id}"))?;
    if data.len() as i64 != bytes {
        return Err(format!(
            "图字节验货失败({image_id}):长度 {} != op 声明的 {bytes}",
            data.len()
        ));
    }
    // 防御性封顶:走 op 通道的 add 已在 apply_image_add 验过声明值,这里兜的是
    // 引导快照带进来的日志(P2-f 表级导入不过 apply_remote_op)。
    if data.len() > crate::images::MAX_IMAGE_BYTES {
        return Err(format!("图字节验货失败({image_id}):超过单图上限"));
    }
    if let Some(expect) = sha256 {
        use sha2::{Digest, Sha256};
        let got: String = Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect();
        if got != expect {
            return Err(format!("图字节验货失败({image_id}):sha256 不符"));
        }
    }
    if has_tombstone(&tx, "image", image_id)? || has_tombstone(&tx, "item", &item_id)? {
        return Ok(BytesOutcome::Dropped); // 事务无写,drop 即回滚。
    }
    if row_exists(&tx, "item_image", image_id)? {
        return Ok(BytesOutcome::AlreadyPresent);
    }
    if !row_exists(&tx, "items", &item_id)? {
        return Err(format!(
            "字节到达但宿主 item {item_id} 行缺失且无 tombstone(不该发生:add 应用时行必在):{image_id}"
        ));
    }
    let seq = effective_seqs(&tx, &item_id)
        .map_err(|e| e.to_string())?
        .and_then(|(map, _)| map.get(image_id).map(|(eff, _)| *eff))
        .ok_or_else(|| format!("「图N」分配表里没有 {image_id}(必是 bug:其 add 已在日志)"))?;
    tx.execute("INSERT INTO sync_replay_active (flag) VALUES (1)", [])
        .map_err(|e| e.to_string())?;
    let n = crate::repo::insert_item_image(&tx, image_id, &item_id, seq, data, &mime)
        .map_err(|e| format!("旁路建图行失败({image_id},图{seq}):{e}"))?;
    if n != 1 {
        return Err(format!("旁路建图行失败({image_id}):影响 {n} 行"));
    }
    tx.execute("DELETE FROM sync_replay_active", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(BytesOutcome::Applied { seq })
}

// ---- 「图N」有效编号:撞号顺延的纯函数(sync-plan §3.1 放宽条款的落实) --------------

/// 一张被顺延的本地图:行 seq 已从 old_seq 改到 new_seq。add_hlc 是它的 image_add op
/// 的时间戳,供正文修正过滤(正文写于该图存在之前时,「图N」不可能指它,不改)。
struct Renumber {
    image_id: String,
    old_seq: i64,
    new_seq: i64,
    add_hlc: String,
}

/// 「图N」有效编号的**分配段**(纯函数):对 `item_id` 的全部 image_add op 按 HLC 升序
/// 逐条分配,返回 image_id → (有效号, add_hlc) 与全组最大有效号;无 add op 返回 None。
/// reconcile_item_images(行核对与翻案)与 apply_image_bytes(字节到达建行)共用这
/// 唯一分配点,不许另写分配(codex 评审契约)。
pub(crate) fn effective_seqs(
    tx: &Connection,
    item_id: &str,
) -> Result<Option<(HashMap<String, (i64, String)>, i64)>, OpError> {
    let mut stmt = tx
        .prepare(
            "SELECT entity_id, hlc, CAST(json_extract(payload, '$.seq') AS INTEGER) \
             FROM oplog \
             WHERE entity = 'image' AND kind = 'image_add' \
               AND json_extract(payload, '$.item_id') = ?1 \
             ORDER BY hlc",
        )
        .map_err(local)?;
    let adds: Vec<(String, String, i64)> = stmt
        .query_map([item_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(local)?
        .collect::<rusqlite::Result<_>>()
        .map_err(local)?;
    let Some(floor) = adds.iter().map(|a| a.2).min().map(|s| s - 1) else {
        return Ok(None);
    };

    let mut taken: HashSet<i64> = HashSet::new();
    let mut effective: HashMap<String, (i64, String)> = HashMap::new();
    let mut max_seen = floor;
    for (image_id, add_hlc, want) in adds {
        // 撞号顺延用 checked_add + 上限(codex 二审):两张图都声明近上限 seq 时,顺延不得
        // 越过 MAX_IMAGE_SEQ——live 与 boot 共用本函数,故同拒;不封则 counter 被抬过上限、
        // 下次 attach 的 +1 失败成本地 DoS。want 分支已由 validate_op_shape 封在 ≤ 上限。
        let eff = if want > floor && !taken.contains(&want) {
            want
        } else {
            max_seen
                .checked_add(1)
                .filter(|&s| s <= crate::images::MAX_IMAGE_SEQ)
                .ok_or_else(|| {
                    // 数据驱动的越界(op 集合把顺延推过上限)= InvalidOp,非本地故障。
                    OpError::InvalidOp(format!(
                        "「图N」有效编号超上限 {}(撞号顺延)",
                        crate::images::MAX_IMAGE_SEQ
                    ))
                })?
        };
        taken.insert(eff);
        max_seen = max_seen.max(eff);
        effective.insert(image_id, (eff, add_hlc));
    }
    Ok(Some((effective, max_seen)))
}

/// 「图N」有效编号核对:对 `item_id` 的**全部 image_add op**(本地发射 + 远端回放,
/// 日志里都有)按 HLC 升序逐条分配——原号空闲得原号,撞号者顺延到
/// max(floor, 已分配最大) + 1(HLC 大者顺延,恒得新号)。floor = 最早一条 add 的
/// payload.seq − 1:它之前的号全是 op 纪元(0020)前的遗产图/洞,一律视为已占用、
/// 永不再分配;任何 add 的 seq = 发射端当时 counter+1 ≥ 引导快照 counter+1 > 遗产
/// 上界,故 floor 永不误伤有 op 的图(引导快照带 counter 表,0023 起钉死
/// 「counter ≥ 一切已用编号」)。两端见到同一集合必得同一分配——**行上的 seq 只是
/// 本函数的缓存**,对不上的本地行(翻案,链式可多张)在回放豁免下改 seq 对齐,按
/// 新号降序改:顺延恒 new > old,降序时目标号必已腾空,不撞 UNIQUE(item_id, seq)。
/// counter 水位同步推到全组最大有效号。P2 的字节旁路建行、引导后的校验都必须走本
/// 函数,不许另写分配(codex 评审契约)。
fn reconcile_item_images(tx: &Connection, item_id: &str) -> Result<Vec<Renumber>, OpError> {
    let Some((effective, max_seen)) = effective_seqs(tx, item_id)? else {
        return Ok(vec![]); // 无 add op 无从核对(调用方刚记账过,不该发生)。
    };

    tx.execute(
        "INSERT INTO item_image_counter (item_id, last_seq) VALUES (?1, ?2) \
         ON CONFLICT(item_id) DO UPDATE SET last_seq = max(last_seq, excluded.last_seq)",
        (item_id, max_seen),
    )
    .map_err(|e| db_err(&format!("「图N」编号水位推平失败({item_id})"), e))?;

    // diff 本地已落行的图(无 add op 的遗产行不在 map:其号 ≤ floor,永不被分配)。
    let mut stmt = tx
        .prepare("SELECT id, seq FROM item_image WHERE item_id = ?1")
        .map_err(local)?;
    let rows: Vec<(String, i64)> = stmt
        .query_map([item_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(local)?
        .collect::<rusqlite::Result<_>>()
        .map_err(local)?;
    let mut renumbered: Vec<Renumber> = rows
        .into_iter()
        .filter_map(|(id, row_seq)| {
            let (eff, add_hlc) = effective.get(&id)?;
            (*eff != row_seq).then(|| Renumber {
                image_id: id,
                old_seq: row_seq,
                new_seq: *eff,
                add_hlc: add_hlc.clone(),
            })
        })
        .collect();
    renumbered.sort_by(|a, b| b.new_seq.cmp(&a.new_seq));
    for r in &renumbered {
        tx.execute(
            "UPDATE item_image SET seq = ?1 WHERE id = ?2",
            (r.new_seq, &r.image_id),
        )
        .map_err(|e| {
            db_err(&format!("「图N」顺延改号失败({} {}→{})", r.image_id, r.old_seq, r.new_seq), e)
        })?;
    }
    Ok(renumbered)
}

/// 翻案后的正文修正(条件见 apply_image_add 抬头)。改写走**有 op 背书**的正道:
/// UPDATE 行(trg_item_archive_on_edit 照常把旧文归档进历史)+ 发射真正的 content
/// set_field——先 observe 当前远端 op(它可能是未来时间戳),取号必大于一切已见
/// (含 content 旧胜者),修正 op 稳赢 LWW,各端由它收敛,不靠各自猜。返回是否改写。
fn rewrite_local_content_refs(
    tx: &Connection,
    clock: &mut Clock,
    item_id: &str,
    current: &Hlc,
    renumbered: &[Renumber],
) -> Result<bool, String> {
    let winner_hlc: Option<String> = tx
        .query_row(
            "SELECT MAX(hlc) FROM oplog \
             WHERE entity = 'item' AND entity_id = ?1 \
               AND (kind = 'create' \
                    OR (kind = 'set_field' AND json_extract(payload, '$.field') = 'content'))",
            [item_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let Some(winner_hlc) = winner_hlc else {
        return Ok(false); // 引导前的遗产条目(无 create op):文本无 op 背书,不代改。
    };
    if Hlc::parse(&winner_hlc)?.device_id != clock.device_id() {
        return Ok(false);
    }
    // 只改「写正文时已在场」的图(add 早于胜者文本):先写「见图1」后贴图的文本,
    // 其「图1」不指这张图,改了就是造谣(codex 抓的洞)。
    let map: HashMap<i64, i64> = renumbered
        .iter()
        .filter(|r| r.add_hlc < winner_hlc)
        .map(|r| (r.old_seq, r.new_seq))
        .collect();
    if map.is_empty() {
        return Ok(false);
    }
    let content: String = tx
        .query_row("SELECT content FROM items WHERE id = ?1", [item_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let Some(fixed) = rewrite_image_refs(&content, &map) else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE items SET content = ?1, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
        (&fixed, item_id),
    )
    .map_err(|e| format!("「图N」正文修正失败({item_id}):{e}"))?;
    clock.observe(tx, current)?;
    oplog::item_set(tx, clock, item_id, &["content"])?;
    Ok(true)
}

/// 「图N」扫描出的一段:原样文本,或一处「图<数字串>」命中(无数字时 n=None,
/// digits 为空串——「图」字本体不含在 Text 段里,由消费方自己重排)。
enum RefSeg<'a> {
    Text(&'a str),
    Ref { digits: &'a str, n: Option<i64> },
}

/// 「图N」引用的**唯一扫描器**:改写(回放翻案)与提取(移动预检)都从这里走,
/// 匹配语义只此一份(cross-space-move M3:不许各写一套解析)。语义对齐前端
/// item-images.ts 的 `图(\d+)`:「图」后的连续 ASCII 数字串按数值(「图03」≡图3),
/// 断在任何非数字处(「图30」≠「图3」)。
fn scan_image_refs(text: &str, mut f: impl FnMut(RefSeg<'_>)) {
    let mut rest = text;
    while let Some(at) = rest.find('图') {
        f(RefSeg::Text(&rest[..at]));
        let tail = &rest[at + '图'.len_utf8()..];
        let digits_len = tail.find(|c: char| !c.is_ascii_digit()).unwrap_or(tail.len());
        let digits = &tail[..digits_len];
        f(RefSeg::Ref { digits, n: digits.parse::<i64>().ok() });
        rest = &tail[digits_len..];
    }
    f(RefSeg::Text(rest));
}

/// 正文「图N」引用改写:单遍扫描,按映射表把旧号一次换成新号(3→4 与 4→5 并存时绝
/// 不串改;命中改写成规范形)。没有一处命中返回 None。
fn rewrite_image_refs(text: &str, map: &HashMap<i64, i64>) -> Option<String> {
    let mut out = String::with_capacity(text.len());
    let mut changed = false;
    scan_image_refs(text, |seg| match seg {
        RefSeg::Text(t) => out.push_str(t),
        RefSeg::Ref { digits, n } => {
            out.push('图');
            match n.and_then(|n| map.get(&n)) {
                Some(new_seq) => {
                    out.push_str(&new_seq.to_string());
                    changed = true;
                }
                None => out.push_str(digits),
            }
        }
    });
    changed.then_some(out)
}

/// 正文里被「图N」引用的编号集合(同一扫描器的提取投影)。跨空间移动的悬空引用
/// 预检用它(cross-space-move §2.3② M3)。
pub(crate) fn referenced_image_seqs(text: &str) -> HashSet<i64> {
    let mut seqs = HashSet::new();
    scan_image_refs(text, |seg| {
        if let RefSeg::Ref { n: Some(n), .. } = seg {
            seqs.insert(n);
        }
    });
    seqs
}

// ---- 判定(全部查 oplog,全部带 entity 谓词) ---------------------------------------

/// op_id 已在本地日志时,核对是否**同一枚 op**(六字段逐一相等;payload 按 Value 语义
/// 比)。None = op_id 不在日志。「重复/已见」的一切判定都必须走完整比对而不是只看
/// op_id——同 op_id 不同内容/坐标(坏客户端、克隆库改写日志)若被当幂等吞掉,两端
/// 水位都齐、hello/want 永不再修,是静默分叉(codex 四轮)。engine 与 apply_remote_op
/// 共用此单一判定。
pub(crate) fn logged_op_matches(conn: &Connection, op: &RemoteOp) -> Result<Option<bool>, String> {
    let row: Option<(String, String, String, String, String, i64)> = conn
        .query_row(
            "SELECT hlc, entity, entity_id, kind, payload, origin_seq FROM oplog WHERE op_id = ?1",
            [&op.op_id],
            |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.map(|(hlc, entity, entity_id, kind, payload, origin_seq)| {
        let logged_payload: Value = serde_json::from_str(&payload).expect("oplog payload 必须是合法 JSON");
        hlc == op.hlc
            && entity == op.entity
            && entity_id == op.entity_id
            && kind == op.kind
            && origin_seq == op.origin_seq
            && logged_payload == op.payload
    }))
}

/// 实体是否已有 tombstone(契约①的记忆——行已硬删,记忆在日志)。
fn has_tombstone(conn: &Connection, entity: &str, entity_id: &str) -> Result<bool, String> {
    let kind = if entity == "image" { "image_tombstone" } else { "tombstone" };
    conn.query_row(
        "SELECT 1 FROM oplog WHERE entity = ?1 AND entity_id = ?2 AND kind = ?3 LIMIT 1",
        (entity, entity_id, kind),
        |_| Ok(()),
    )
    .optional()
    .map(|o| o.is_some())
    .map_err(|e| e.to_string())
}

/// 字段级 LWW:当前 op(已入账)是不是该字段的最后一笔写。参赛者 = create(快照写下
/// 字段初值)+ 该字段的全部 set_field;HLC 全局唯一,「最新」= 自己是唯一 MAX。
fn is_latest_field_write(
    conn: &Connection,
    entity: &str,
    entity_id: &str,
    field: &str,
    hlc: &str,
) -> Result<bool, String> {
    let max: Option<String> = conn
        .query_row(
            "SELECT MAX(hlc) FROM oplog \
             WHERE entity = ?1 AND entity_id = ?2 \
               AND (kind = 'create' \
                    OR (kind = 'set_field' AND json_extract(payload, '$.field') = ?3))",
            (entity, entity_id, field),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(max.as_deref() == Some(hlc))
}

fn row_exists(conn: &Connection, table: &str, id: &str) -> Result<bool, String> {
    conn.query_row(&format!("SELECT 1 FROM {table} WHERE id = ?1"), [id], |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
        .map_err(|e| e.to_string())
}

// ---- payload 读取(形状不对 = 拒收整条 op,fail-fast) ------------------------------

/// item 同步字段白名单 + 值类型(与 oplog::read_item_field 一一对应)。SQLite 弱类型,
/// 这里先把 JSON 类型钉死,值域(枚举/格式/范围)再由表 CHECK 把关。
fn item_field_value(field: &str, v: &Value) -> Result<SqlValue, String> {
    match field {
        "content" | "stage" => match v {
            Value::String(s) => Ok(SqlValue::Text(s.clone())),
            other => Err(format!("item 字段 {field} 期待字符串,收到:{other}")),
        },
        "due_on" | "archived_at" | "sealed_at" | "position" => match v {
            Value::String(s) => Ok(SqlValue::Text(s.clone())),
            Value::Null => Ok(SqlValue::Null),
            other => Err(format!("item 字段 {field} 期待字符串或 null,收到:{other}")),
        },
        "priority" => match v {
            Value::Number(n) => n
                .as_i64()
                .map(SqlValue::Integer)
                .ok_or_else(|| format!("item 字段 priority 期待整数,收到:{n}")),
            Value::Null => Ok(SqlValue::Null),
            other => Err(format!("item 字段 priority 期待整数或 null,收到:{other}")),
        },
        other => Err(format!("item set_field 不认识的字段:{other}")),
    }
}

/// topic 同步字段白名单 + 值类型(与 oplog::topic_set 一一对应)。title/updated_at 恒
/// 字符串;color 可空(NULL = 无色,允许清空,与 item 的 due_on/priority 同款)。
fn topic_field_value(field: &str, v: &Value) -> Result<SqlValue, String> {
    match field {
        "title" | "updated_at" => match v {
            Value::String(s) => Ok(SqlValue::Text(s.clone())),
            other => Err(format!("topic 字段 {field} 期待字符串,收到:{other}")),
        },
        "color" => match v {
            Value::String(s) => Ok(SqlValue::Text(s.clone())),
            Value::Null => Ok(SqlValue::Null),
            other => Err(format!("topic 字段 color 期待字符串或 null,收到:{other}")),
        },
        other => Err(format!("topic set_field 不认识的字段:{other}")),
    }
}

const STAGES: [&str; 6] = ["inbox", "filed", "todo", "doing", "confirming", "done"];

/// item set_field 的**形态 + 内在值域**校验(shape 层,boot+live 共用)。值域(stage 枚举 /
/// priority 1..3 / due_on 规范日历日)**必须放共享层、不能只放 boot** ——否则 live 会在 LWW
/// 输家上走 LwwStale 跳过、不撞列 CHECK 而收下,boot-only 审计却拒 = 反向分歧(codex 二审 1.3)。
/// content/archived_at/sealed_at 无 DB 级值域 CHECK,仅类型。错误分型(epoch-plan §4):
/// **词汇表外的字段名 = UnsupportedVocab**(将来版本可能新增同步字段,旧端挂起等升级);
/// created_at/born_stage 是已知词汇但**协议禁 set**(出生/史实不可改写)= InvalidOp。
fn validate_item_field_shape(field: &str, v: &Value) -> Result<(), OpError> {
    let inv = OpError::InvalidOp;
    match field {
        "position" => validate_position_shape(v).map_err(inv),
        "stage" => validate_stage_value(v).map_err(inv),
        "priority" => validate_priority_value(v).map_err(inv),
        "due_on" => validate_due_on_value(v).map_err(inv),
        "content" | "archived_at" | "sealed_at" => {
            item_field_value(field, v).map(|_| ()).map_err(inv)
        }
        "created_at" | "born_stage" => {
            Err(inv(format!("item 字段 {field} 是出生/史实字段,协议禁 set_field")))
        }
        other => Err(OpError::UnsupportedVocab(format!("item set_field 不认识的字段:{other}"))),
    }
}

/// topic set_field 的形态校验(shape 层,boot+live 共用);分型口径同
/// [`validate_item_field_shape`]:created_at 已知但禁 set = InvalidOp,未知字段 =
/// UnsupportedVocab。
fn validate_topic_field_shape(field: &str, v: &Value) -> Result<(), OpError> {
    let inv = OpError::InvalidOp;
    match field {
        "title" | "updated_at" | "color" => topic_field_value(field, v).map(|_| ()).map_err(inv),
        "created_at" => Err(inv("topic 字段 created_at 是出生字段,协议禁 set_field".into())),
        other => Err(OpError::UnsupportedVocab(format!("topic set_field 不认识的字段:{other}"))),
    }
}

/// 空间名的**线上规范**(space-name-sync-plan §3.1,codex 二轮 M2 钉死):null(显式
/// 清名),或满足 `value == value.trim()` ∧ 非空 ∧ 原始 UTF-8 ≤ 200 字节的字符串。
/// **三处共用的单一函数**:本地发射(spaces::set_space_name,入口先 trim 再进来)、
/// 存量补发(heal_legacy_space_name)、远端回放/审计(本分支)——replay 只验证、
/// 绝不静默修改远端 payload(带首尾空白的远端值=非规范→拒,不存在「validator 按
/// trim 后判合法、物化却存原串」的含糊)。
pub(crate) const SPACE_NAME_MAX_BYTES: usize = 200;
pub(crate) fn validate_space_name_value(v: &Value) -> Result<(), String> {
    match v {
        Value::Null => Ok(()),
        Value::String(s) => {
            if s != s.trim() {
                return Err(format!("space name 带首尾空白(非规范):{s:?}"));
            }
            if s.is_empty() {
                return Err("space name 不得为空串(清名用 null)".into());
            }
            if s.len() > SPACE_NAME_MAX_BYTES {
                return Err(format!(
                    "space name 超长({} 字节 > 上限 {SPACE_NAME_MAX_BYTES})",
                    s.len()
                ));
            }
            Ok(())
        }
        other => Err(format!("space name 期待字符串或 null:{other}")),
    }
}

/// space set_field 的形态校验(shape 层,boot+live 共用):field 白名单唯 "name";
/// 未知字段 = UnsupportedVocab(将来版本可能扩 profile 字段,旧端挂起等升级)。
fn validate_space_field_shape(field: &str, v: &Value) -> Result<(), OpError> {
    match field {
        "name" => validate_space_name_value(v).map_err(OpError::InvalidOp),
        other => Err(OpError::UnsupportedVocab(format!("space set_field 不认识的字段:{other}"))),
    }
}

/// born_stage 值域(create 专用):stage 六枚举 ∪ **null**。null 是 pre-0018「未知
/// 不回填」史实的协议承载(epoch-plan §2.3 收编)——压实基线以它出生,live 也合法;
/// born_stage 不可 set_field 的规则不变、`idea_stats` 只数已知出生行,无副作用面。
fn validate_born_stage_value(v: &Value) -> Result<(), String> {
    match v {
        Value::Null => Ok(()),
        other => validate_stage_value(other)
            .map_err(|_| format!("item born_stage 期待 stage 枚举或 null:{other}")),
    }
}

/// stage 值域(6 枚举;mirror 0021 列 CHECK,该 CHECK 未被 0022 回放豁免,故 live 回放会撞)。
fn validate_stage_value(v: &Value) -> Result<(), String> {
    match v {
        Value::String(s) if STAGES.contains(&s.as_str()) => Ok(()),
        other => Err(format!("item stage 不在枚举 {STAGES:?}:{other}")),
    }
}

/// priority 值域(null 或 1/2/3;mirror 0021 列 CHECK)。
fn validate_priority_value(v: &Value) -> Result<(), String> {
    match v {
        Value::Null => Ok(()),
        Value::Number(n) if matches!(n.as_i64(), Some(1..=3)) => Ok(()),
        other => Err(format!("item priority 期待 1/2/3 或 null:{other}")),
    }
}

/// due_on 值域(null 或规范日历日 YYYY-MM-DD;mirror 0021 列 CHECK 的 date(x)=x)。
fn validate_due_on_value(v: &Value) -> Result<(), String> {
    match v {
        Value::Null => Ok(()),
        Value::String(s) if is_canonical_date(s) => Ok(()),
        other => Err(format!("item due_on 期待规范日历日 YYYY-MM-DD 或 null:{other}")),
    }
}

/// 严格 YYYY-MM-DD 真实公历日(至少与 SQLite `date(x)=x` 同严;更严只让 boot/live 一致地
/// 多拒、不生分歧)。诚实生产值都是命令层产的规范日,不会误伤。
fn is_canonical_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if b.iter().enumerate().any(|(i, &c)| i != 4 && i != 7 && !c.is_ascii_digit()) {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) =
        (s[0..4].parse::<i32>(), s[5..7].parse::<u32>(), s[8..10].parse::<u32>())
    else {
        return false;
    };
    if !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let dim = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    day <= dim
}

/// position 值形态(create + set_field 共用):null / 合法 frindex 键字符串。
/// **严格纪元(epoch-plan §3.1)**:0021 前的 legacy int 容忍已删——纪元压实把存量
/// int position op 消灭(基线 create 带现值 frindex 键),live 与 boot 同拒。字符串
/// 须镜像 0022 的 position **单列** CHECK:非空、首字符 ASCII 字母、全字符 ASCII
/// 字母数字。int / float / 负数 / bool / object / array 一律拒。
fn validate_position_shape(v: &Value) -> Result<(), String> {
    match v {
        Value::Null => Ok(()),
        Value::String(s) => {
            if !s.is_empty()
                && s.as_bytes()[0].is_ascii_alphabetic()
                && s.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                Ok(())
            } else {
                Err(format!("item position 字符串不符 frindex 键形态(首字母 + 全字母数字):{s}"))
            }
        }
        other => Err(format!("item position 期待合法 frindex 键或 null(严格纪元):{other}")),
    }
}

/// 纯 op-shape 校验(bedrock-fix §9 核心):无状态依赖的结构不变量,live
/// `apply_remote_op` 与 boot 引导审计 `audit_op_shapes` **单一真相源**——闭合
/// 「引导审计口径比 replay 松→坏快照过审→诚实设备回放 Err→origin 永久挂起+静默分叉」。
/// **严格纪元(epoch-plan §3.1)**:此前刻意容忍的 3 处 legacy 形态(int position /
/// link_remove 缺 observed / image_add 缺 sha256)已删——纪元压实把存量松形态消灭,
/// 账本里不再存在任何合法的松形态,boot 与 live 无例外同口径。
/// **`born_stage: null` 是协议正式词汇**(epoch-plan §2.3):pre-0018 行的出生态是
/// 「未知不回填」的史实,压实基线以 null 承载;op 无 provenance,live 也合法。
/// 错误分型(§4):未知 entity/kind/field = UnsupportedVocab(版本偏斜),其余 InvalidOp。
pub(crate) fn validate_op_shape(op: &RemoteOp) -> Result<(), OpError> {
    let p = &op.payload;
    let inv = OpError::InvalidOp;
    match (op.entity.as_str(), op.kind.as_str()) {
        ("item", "create") => {
            str_field(p, "content").map_err(inv)?;
            str_field(p, "created_at").map_err(inv)?;
            // create payload 的硬列值域也要审(codex 二审 1.1):终态 ≠ create payload 时
            // (后续 set_field 覆盖),boot bulk-INSERT 终态合法过审,而 live 在 create 当场
            // 用非法初值插表撞 CHECK Err——非对称。故 create 与 set_field 同一套值域。
            validate_stage_value(p.get("stage").ok_or_else(|| inv("item create 缺 stage".into()))?)
                .map_err(inv)?;
            validate_born_stage_value(
                p.get("born_stage").ok_or_else(|| inv("item create 缺 born_stage".into()))?,
            )
            .map_err(inv)?;
            if let Some(v) = p.get("due_on") {
                validate_due_on_value(v).map_err(inv)?;
            }
            if let Some(v) = p.get("priority") {
                validate_priority_value(v).map_err(inv)?;
            }
            if let Some(pos) = p.get("position") {
                validate_position_shape(pos).map_err(inv)?;
            }
        }
        ("item", "set_field") => {
            let field = str_field(p, "field").map_err(inv)?;
            validate_item_field_shape(&field, field_value(p).map_err(inv)?)?;
        }
        ("topic", "create") => {
            str_field(p, "title").map_err(inv)?;
            str_field(p, "created_at").map_err(inv)?;
        }
        ("topic", "set_field") => {
            let field = str_field(p, "field").map_err(inv)?;
            validate_topic_field_shape(&field, field_value(p).map_err(inv)?)?;
        }
        ("item", "tombstone") | ("topic", "tombstone") => {}
        ("link", "link_add") | ("link", "link_remove") => {
            let item_id = str_field(p, "item_id").map_err(inv)?;
            let topic_id = str_field(p, "topic_id").map_err(inv)?;
            if op.entity_id != format!("{item_id}:{topic_id}") {
                return Err(inv(format!(
                    "link op 的 entity_id 与 payload 不一致:{} vs {item_id}:{topic_id}",
                    op.entity_id
                )));
            }
            if op.kind == "link_remove" {
                // observed 必带且为字符串数组(严格纪元):缺键的遗留形态已被压实消灭。
                match p.get("observed") {
                    Some(Value::Array(a)) if a.iter().all(Value::is_string) => {}
                    other => {
                        return Err(inv(format!(
                            "link_remove 的 observed 必带且为字符串数组(严格纪元),收到:{other:?}"
                        )))
                    }
                }
            }
        }
        ("image", "image_add") => {
            str_field(p, "item_id").map_err(inv)?;
            let seq = int_field(p, "seq").map_err(inv)?;
            if !(1..=crate::images::MAX_IMAGE_SEQ).contains(&seq) {
                return Err(inv(format!(
                    "image_add 的 seq 越界(1..={}):{seq}",
                    crate::images::MAX_IMAGE_SEQ
                )));
            }
            let mime = str_field(p, "mime").map_err(inv)?;
            if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp" | "image/gif") {
                return Err(inv(format!("image_add 的 mime 不在白名单:{mime}")));
            }
            let bytes = int_field(p, "bytes").map_err(inv)?;
            if !(1..=crate::images::MAX_IMAGE_BYTES as i64).contains(&bytes) {
                return Err(inv(format!("image_add 的 bytes 越界:{bytes}")));
            }
            // sha256 必带且 64-hex(严格纪元):0024 起发射恒带,无 hash 的遗留 op
            // 已被压实消灭(压实对现存字节现算 sha)。
            match p.get("sha256") {
                Some(Value::String(s))
                    if s.len() == 64
                        && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) => {}
                other => {
                    return Err(inv(format!(
                        "image_add 的 sha256 必带且为 64 位小写 hex(严格纪元),收到:{other:?}"
                    )))
                }
            }
        }
        ("image", "image_tombstone") => {
            str_field(p, "item_id").map_err(inv)?;
        }
        ("space", "set_field") => {
            // 单例寄存器:entity_id 恒为字面量 'profile'(space-name-sync-plan §3.1)。
            // 已知词汇下的坐标非法 = InvalidOp(不是版本偏斜——任何合法版本都不会发)。
            if op.entity_id != "profile" {
                return Err(inv(format!(
                    "space op 的 entity_id 必须是 'profile'(单例寄存器),收到:{}",
                    op.entity_id
                )));
            }
            let field = str_field(p, "field").map_err(inv)?;
            validate_space_field_shape(&field, field_value(p).map_err(inv)?)?;
        }
        _ => {
            // 词汇表外 = 版本偏斜(对端较新):挂起等升级,不隔离(epoch-plan §4)。
            // 注:space 的 create/tombstone 也落到这里(寄存器无此词汇)——分不清
            // 「坏实现」与「更新的协议」,按 fail-safe 的挂起处置;存储层 0028 CHECK
            // 同拒,双保险。
            return Err(OpError::UnsupportedVocab(format!(
                "未知 op entity/kind:{}/{}",
                op.entity, op.kind
            )));
        }
    }
    Ok(())
}

fn field_value(p: &Value) -> Result<&Value, String> {
    p.get("value").ok_or_else(|| "payload 缺 value 键".to_string())
}

fn str_field(p: &Value, key: &str) -> Result<String, String> {
    match p.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        other => Err(format!("payload 的 {key} 期待字符串,收到:{other:?}")),
    }
}

fn opt_str_field(p: &Value, key: &str) -> Result<Option<String>, String> {
    match p.get(key) {
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(Value::Null) | None => Ok(None),
        other => Err(format!("payload 的 {key} 期待字符串或 null,收到:{other:?}")),
    }
}

fn opt_int_field(p: &Value, key: &str) -> Result<Option<i64>, String> {
    match p.get(key) {
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("payload 的 {key} 期待整数,收到:{n}")),
        Some(Value::Null) | None => Ok(None),
        other => Err(format!("payload 的 {key} 期待整数或 null,收到:{other:?}")),
    }
}

fn int_field(p: &Value, key: &str) -> Result<i64, String> {
    match p.get(key) {
        Some(Value::Number(n)) => n
            .as_i64()
            .ok_or_else(|| format!("payload 的 {key} 期待整数,收到:{n}")),
        other => Err(format!("payload 的 {key} 期待整数,收到:{other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, images, notes, oplog, repo, task};
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};
    use ulid::Ulid;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn fresh() -> (Connection, Clock) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("ys-nb-replay-{}-{}.sqlite3", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).expect("open migrated db");
        let clock = Clock::load(&conn).expect("load clock");
        (conn, clock)
    }

    /// 一个库的全部 op,按 HLC 升序(= 回放喂入序)。
    fn all_ops(conn: &Connection) -> Vec<RemoteOp> {
        let mut stmt = conn
            .prepare(
                "SELECT op_id, hlc, entity, entity_id, kind, payload, origin_seq \
                 FROM oplog ORDER BY hlc",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok(RemoteOp {
                    op_id: r.get(0)?,
                    hlc: r.get(1)?,
                    entity: r.get(2)?,
                    entity_id: r.get(3)?,
                    kind: r.get(4)?,
                    payload: serde_json::from_str(&r.get::<_, String>(5)?).unwrap(),
                    origin_seq: r.get(6)?,
                })
            })
            .unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    /// per-origin origin_seq 连续 1..max 无洞(0024 不变量;镜像收敛后两端都得成立)。
    fn assert_per_origin_seq_contiguous(conn: &Connection) {
        let holes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (SELECT COUNT(*) AS c, MIN(origin_seq) AS mn, \
                 MAX(origin_seq) AS mx FROM oplog GROUP BY origin) WHERE mn != 1 OR mx != c",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(holes, 0, "每个 origin 的 origin_seq 必须连续 1..max 无洞");
    }

    fn feed_all(conn: &mut Connection, clock: &mut Clock, ops: &[RemoteOp]) {
        for op in ops {
            apply_remote_op(conn, clock, op).expect("apply remote op");
        }
    }

    /// 手工「远端」时间戳:异设备号 + 指定墙钟。低位用 1970 纪元附近,高位用 2100 年。
    fn remote_hlc(wall_ms: u64, counter: u32) -> String {
        Hlc { wall_ms, counter, device_id: "RMTDEV0000000000000000000X".into() }.encode()
    }
    const FUTURE_MS: u64 = 4_102_444_800_000; // 2100-01-01,恒高于测试期的本地墙钟。

    /// 合成 image_add 的占位 sha256(op 通道上的 add 必带,形态合法即可;真字节比对
    /// 发生在 apply_image_bytes)。
    const TEST_SHA: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    /// 合成 op 的 origin_seq 取号:进程内全局递增。只需满足库内 (origin, origin_seq)
    /// 唯一(UNIQUE 兜底);连续性是 P2-c 引擎的喂入契约、非 replay 层职责,测试合成
    /// op 不伪造它。
    static SYNTH_SEQ: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1);

    fn mk(hlc: &str, entity: &str, entity_id: &str, kind: &str, payload: Value) -> RemoteOp {
        RemoteOp {
            op_id: Ulid::new().to_string(),
            hlc: hlc.to_string(),
            entity: entity.into(),
            entity_id: entity_id.into(),
            kind: kind.into(),
            payload,
            origin_seq: SYNTH_SEQ.fetch_add(1, Ordering::SeqCst),
        }
    }

    fn oplog_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap()
    }

    // ---- space profile 单例寄存器(0028,space-name-sync-plan §3.3) ----

    fn profile_row(conn: &Connection) -> Option<Option<String>> {
        conn.query_row("SELECT name FROM space_profile WHERE key = 'profile'", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()
        .unwrap()
    }

    #[test]
    fn space_set_field_upserts_and_lww_converges() {
        let (mut conn, mut clock) = fresh();
        // 首条 set_field 即 UPSERT(无 create,无 DependencyMissing 一说)。
        let op1 = mk(
            &remote_hlc(FUTURE_MS, 1),
            "space",
            "profile",
            "set_field",
            json!({"field": "name", "value": "家庭"}),
        );
        assert_eq!(apply_remote_op(&mut conn, &mut clock, &op1).unwrap(), Outcome::Applied);
        assert_eq!(profile_row(&conn), Some(Some("家庭".into())));
        // 更高 HLC 赢家改名。
        let op2 = mk(
            &remote_hlc(FUTURE_MS + 10, 0),
            "space",
            "profile",
            "set_field",
            json!({"field": "name", "value": "新家"}),
        );
        assert_eq!(apply_remote_op(&mut conn, &mut clock, &op2).unwrap(), Outcome::Applied);
        // 迟到的低 HLC 写:LwwStale 只记账不动行。
        let stale = mk(
            &remote_hlc(FUTURE_MS + 5, 0),
            "space",
            "profile",
            "set_field",
            json!({"field": "name", "value": "旧名"}),
        );
        assert_eq!(apply_remote_op(&mut conn, &mut clock, &stale).unwrap(), Outcome::LwwStale);
        assert_eq!(profile_row(&conn), Some(Some("新家".into())));
        // 显式清名(null)以最高 HLC 到来:行保留、name 落 NULL(规范表示)。
        let clear = mk(
            &remote_hlc(FUTURE_MS + 20, 0),
            "space",
            "profile",
            "set_field",
            json!({"field": "name", "value": null}),
        );
        assert_eq!(apply_remote_op(&mut conn, &mut clock, &clear).unwrap(), Outcome::Applied);
        assert_eq!(profile_row(&conn), Some(None), "清名 = 行在、name NULL");
    }

    #[test]
    fn space_op_shape_gate_rejects_bad_coordinates_and_vocab() {
        let (mut conn, mut clock) = fresh();
        let apply = |conn: &mut Connection, clock: &mut Clock, op: &RemoteOp| {
            apply_remote_op(conn, clock, op).unwrap_err()
        };
        // entity_id ≠ 'profile':已知词汇下坐标非法 = InvalidOp。
        let bad_id = mk(
            &remote_hlc(FUTURE_MS, 1),
            "space",
            "somewhere",
            "set_field",
            json!({"field": "name", "value": "x"}),
        );
        assert!(matches!(apply(&mut conn, &mut clock, &bad_id), OpError::InvalidOp(_)));
        // 未知 space 字段 = UnsupportedVocab(版本偏斜,挂起等升级)。
        let bad_field = mk(
            &remote_hlc(FUTURE_MS, 2),
            "space",
            "profile",
            "set_field",
            json!({"field": "icon", "value": "x"}),
        );
        assert!(matches!(apply(&mut conn, &mut clock, &bad_field), OpError::UnsupportedVocab(_)));
        // 寄存器无 create/tombstone:词汇表外 = UnsupportedVocab(存储层 CHECK 双保险)。
        let create = mk(&remote_hlc(FUTURE_MS, 3), "space", "profile", "create", json!({}));
        assert!(matches!(apply(&mut conn, &mut clock, &create), OpError::UnsupportedVocab(_)));
        // 线上规范(M2):带首尾空白 / 空串 / 超 200 字节 = InvalidOp,replay 绝不代 trim。
        for bad in [json!(" 家庭 "), json!(""), json!("长".repeat(70))] {
            let op = mk(
                &remote_hlc(FUTURE_MS, 4),
                "space",
                "profile",
                "set_field",
                json!({"field": "name", "value": bad}),
            );
            assert!(matches!(apply(&mut conn, &mut clock, &op), OpError::InvalidOp(_)));
        }
        // 全拒于 shape 层:零记账、零落行。
        assert_eq!(oplog_rows(&conn), 0);
        assert_eq!(profile_row(&conn), None);
    }

    #[test]
    fn local_rename_emits_op_and_mirror_replay_converges() {
        let (mut a, mut ca) = fresh();
        crate::spaces::set_space_name(&mut a, &mut ca, "甲空间").unwrap();
        // 幂等 no-op(同名重存)不发射——没写就没有 op。
        crate::spaces::set_space_name(&mut a, &mut ca, "甲空间").unwrap();
        assert_eq!(oplog_rows(&a), 1);
        crate::spaces::set_space_name(&mut a, &mut ca, "乙空间").unwrap();
        // 镜像库全量回放:名字收敛。
        let (mut b, mut cb) = fresh();
        feed_all(&mut b, &mut cb, &all_ops(&a));
        assert_eq!(profile_row(&b), Some(Some("乙空间".into())));
        assert_eq!(crate::spaces::space_name(&b).unwrap().as_deref(), Some("乙空间"));
    }

    fn flag_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM sync_replay_active", [], |r| r.get(0)).unwrap()
    }

    /// 一张表的确定性指纹(排除 items.updated_at——它是本地簿记,两端刻意不同)。
    fn fingerprint(conn: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = conn.prepare(sql).unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }
    const ITEMS_FP: &str = "SELECT id||'|'||content||'|'||stage||'|'||created_at \
        ||'|'||COALESCE(archived_at,'∅')||'|'||COALESCE(due_on,'∅')||'|'||COALESCE(priority,'∅') \
        ||'|'||COALESCE(position,'∅')||'|'||COALESCE(sealed_at,'∅')||'|'||COALESCE(born_stage,'∅') \
        FROM items ORDER BY id";
    const TOPICS_FP: &str = "SELECT id||'|'||title||'|'||created_at||'|'||updated_at \
        ||'|'||COALESCE(color,'∅') FROM topics ORDER BY id";
    const LINKS_FP: &str =
        "SELECT item_id||'|'||topic_id FROM item_topic ORDER BY item_id, topic_id";
    const IMG_COUNTER_FP: &str =
        "SELECT item_id||'|'||last_seq FROM item_image_counter ORDER BY item_id";

    // ---- 端到端:远端真实历史 → 本地回放收敛 ---------------------------------------

    #[test]
    fn mirror_replaying_full_remote_history_converges_all_tables() {
        // 「远端设备」跑一整套真实单机命令(覆盖全部 op kind),把它的日志按 HLC 序喂给
        // 本地空库——四张同步表必须逐行相等。这就是「两端应用同一组 op 后状态一致」。
        let (mut r, mut rc) = fresh();
        let idea = notes::capture(&mut r, &mut rc, "远端灵感").unwrap();
        notes::edit(&mut r, &mut rc, &idea, "远端灵感(改)").unwrap();
        let topic = notes::create_topic(&mut r, &mut rc, "标签甲").unwrap();
        notes::file_to_topic(&mut r, &mut rc, &idea, Some(topic.as_str()), None).unwrap();
        notes::rename_topic(&mut r, &mut rc, &topic, "标签甲(新名)").unwrap();
        notes::set_topic_color(&mut r, &mut rc, &topic, Some("#3f7a99".into())).unwrap();
        let task_id = task::create(&mut r, &mut rc, "远端任务", Some("2026-07-10"), Some(2), Some(topic.as_str())).unwrap();
        task::transition(&mut r, &mut rc, &task_id, "doing").unwrap();
        task::set_due(&mut r, &mut rc, &task_id, None).unwrap();
        task::set_priority(&mut r, &mut rc, &task_id, Some(1)).unwrap();
        let t2 = notes::create_topic(&mut r, &mut rc, "标签乙").unwrap();
        task::add_topic(&mut r, &mut rc, &task_id, &t2).unwrap();
        task::remove_topic(&mut r, &mut rc, &task_id, &topic).unwrap();
        let (img, _seq) = images::attach(&mut r, &mut rc, &task_id, &[1, 2, 3], "image/png").unwrap();
        images::remove(&mut r, &mut rc, &img).unwrap();
        let (_img2, _s2) = images::attach(&mut r, &mut rc, &task_id, &[4, 5], "image/png").unwrap();
        let done = task::create(&mut r, &mut rc, "干完归档", None, None, None).unwrap();
        task::transition(&mut r, &mut rc, &done, "done").unwrap();
        task::seal(&mut r, &mut rc, &done).unwrap();
        let trashed = task::create(&mut r, &mut rc, "进回收站再销毁", None, None, None).unwrap();
        task::archive(&mut r, &mut rc, &trashed).unwrap();
        task::purge(&mut r, &mut rc, &trashed).unwrap();
        let gone = notes::capture(&mut r, &mut rc, "随手记随手扔").unwrap();
        notes::delete_inbox(&mut r, &mut rc, &gone).unwrap();

        let (mut l, mut lc) = fresh();
        feed_all(&mut l, &mut lc, &all_ops(&r));

        assert_eq!(fingerprint(&l, ITEMS_FP), fingerprint(&r, ITEMS_FP), "items 收敛");
        assert_eq!(fingerprint(&l, TOPICS_FP), fingerprint(&r, TOPICS_FP), "topics 收敛(含 updated_at 字节级相等)");
        assert_eq!(fingerprint(&l, LINKS_FP), fingerprint(&r, LINKS_FP), "item_topic 收敛");
        assert_eq!(fingerprint(&l, IMG_COUNTER_FP), fingerprint(&r, IMG_COUNTER_FP), "「图N」高水位收敛");
        // 图片字节走 P2 旁路:本地不建 item_image 行,但编号水位已推平。
        let local_imgs: i64 = l.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap();
        assert_eq!(local_imgs, 0, "image_add 只推水位不建行(字节未到)");
        assert_eq!(flag_rows(&l), 0, "回放标志绝不泄漏");
        // 0024 第三轴:发射端连续取号、回放端原样记账,两端日志 per-origin 都无洞
        // (这正是水位 = MAX(origin_seq) 派生不存的前提)。
        assert_per_origin_seq_contiguous(&r);
        assert_per_origin_seq_contiguous(&l);
    }

    // ---- 幂等 / LWW ------------------------------------------------------------------

    #[test]
    fn replay_is_idempotent_per_op_id() {
        let (mut r, mut rc) = fresh();
        notes::capture(&mut r, &mut rc, "一条").unwrap();
        let ops = all_ops(&r);

        let (mut l, mut lc) = fresh();
        assert_eq!(apply_remote_op(&mut l, &mut lc, &ops[0]).unwrap(), Outcome::Applied);
        let n = oplog_rows(&l);
        assert_eq!(apply_remote_op(&mut l, &mut lc, &ops[0]).unwrap(), Outcome::AlreadySeen);
        assert_eq!(oplog_rows(&l), n, "重放不重复记账");
    }

    #[test]
    fn lww_higher_hlc_wins_lower_stales_and_local_history_grows() {
        let (mut l, mut lc) = fresh();
        let id = notes::capture(&mut l, &mut lc, "本地原文").unwrap();

        // 更低 HLC 的远端编辑(1970 纪元):输给本地 create,只记账。
        let stale = mk(&remote_hlc(1_000, 0), "item", &id, "set_field",
            json!({"field": "content", "value": "旧世界的编辑"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &stale).unwrap(), Outcome::LwwStale);
        let content: String =
            l.query_row("SELECT content FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(content, "本地原文", "stale 不动行");

        // 更高 HLC 的远端编辑:赢,行变,且本地触发器照常长出历史(archive_on_edit 不豁免)。
        let win = mk(&remote_hlc(FUTURE_MS, 0), "item", &id, "set_field",
            json!({"field": "content", "value": "远端胜"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &win).unwrap(), Outcome::Applied);
        let content: String =
            l.query_row("SELECT content FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(content, "远端胜");
        let revs: i64 = l
            .query_row("SELECT COUNT(*) FROM item_revisions WHERE item_id=?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(revs, 1, "回放远端编辑,本地照样归档旧文(item_revisions 本地派生)");
        assert_eq!(flag_rows(&l), 0);
    }

    // ---- tombstone:删任意行 / sticky / 父子契约 ---------------------------------------

    #[test]
    fn tombstone_deletes_any_stage_and_cascades_children() {
        let (mut l, mut lc) = fresh();
        // filed 行(带标签):单机路径连硬删都不许(删除守护),远端 tombstone 必须能删。
        let idea = notes::capture(&mut l, &mut lc, "已归类").unwrap();
        let topic = notes::create_topic(&mut l, &mut lc, "标签").unwrap();
        notes::file_to_topic(&mut l, &mut lc, &idea, Some(topic.as_str()), None).unwrap();
        // sealed 行(带图):归档不可删守护同样让路。
        let sealed = task::create(&mut l, &mut lc, "已入册", None, None, None).unwrap();
        task::transition(&mut l, &mut lc, &sealed, "done").unwrap();
        task::seal(&mut l, &mut lc, &sealed).unwrap();
        // (图挂在 filed 那条上,顺便验 CASCADE。)
        images::attach(&mut l, &mut lc, &idea, &[9], "image/png").unwrap();

        for (n, id) in [&idea, &sealed].into_iter().enumerate() {
            let ts = mk(&remote_hlc(FUTURE_MS, n as u32), "item", id, "tombstone", json!({}));
            assert_eq!(apply_remote_op(&mut l, &mut lc, &ts).unwrap(), Outcome::Applied);
            assert!(!row_exists(&l, "items", id).unwrap(), "行已删({id})");
        }
        let (links, imgs, counters): (i64, i64, i64) = (
            l.query_row("SELECT COUNT(*) FROM item_topic", [], |r| r.get(0)).unwrap(),
            l.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap(),
            l.query_row("SELECT COUNT(*) FROM item_image_counter", [], |r| r.get(0)).unwrap(),
        );
        assert_eq!((links, imgs, counters), (0, 0, 0), "FK CASCADE 清空全部子物");
    }

    #[test]
    fn tombstone_is_sticky_nothing_resurrects() {
        let (mut r, mut rc) = fresh();
        let id = notes::capture(&mut r, &mut rc, "将死之行").unwrap();
        let ops = all_ops(&r);

        let (mut l, mut lc) = fresh();
        feed_all(&mut l, &mut lc, &ops);
        let ts = mk(&remote_hlc(FUTURE_MS, 0), "item", &id, "tombstone", json!({}));
        apply_remote_op(&mut l, &mut lc, &ts).unwrap();

        // 更高 HLC 的编辑不复活(契约①:tombstone 不是 LWW 字段值)。
        let edit = mk(&remote_hlc(FUTURE_MS, 9), "item", &id, "set_field",
            json!({"field": "content", "value": "诈尸"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &edit).unwrap(), Outcome::SuppressedByTombstone);
        // 同实体再来一条 create(不同 op_id)也不复活。
        let re_create = mk(&remote_hlc(FUTURE_MS, 10), "item", &id, "create",
            json!({"content": "诈尸", "stage": "inbox", "created_at": "2026-07-07T00:00:00Z",
                   "born_stage": "inbox", "due_on": null, "priority": null, "position": null}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &re_create).unwrap(), Outcome::SuppressedByTombstone);
        assert!(!row_exists(&l, "items", &id).unwrap(), "行永不回来");
    }

    #[test]
    fn parent_tombstone_dominates_child_ops() {
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "父条目").unwrap();
        let topic = notes::create_topic(&mut l, &mut lc, "父标签").unwrap();

        let ts = mk(&remote_hlc(FUTURE_MS, 0), "item", &item, "tombstone", json!({}));
        apply_remote_op(&mut l, &mut lc, &ts).unwrap();

        // 晚到的、指向已死父的 link_add / image_add:只记账,绝不重建父行。
        let link_id = format!("{item}:{topic}");
        let add = mk(&remote_hlc(FUTURE_MS, 1), "link", &link_id, "link_add",
            json!({"item_id": item, "topic_id": topic}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &add).unwrap(), Outcome::ParentGone);
        let img_add = mk(&remote_hlc(FUTURE_MS, 2), "image", "01IMGDEAD0000000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 3, "sha256": TEST_SHA}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &img_add).unwrap(), Outcome::ParentGone);
        assert!(!row_exists(&l, "items", &item).unwrap(), "父行没有被子 op 重建");

        // 级联后才到的 child link_remove / image_tombstone:幂等,不报同步错。
        let rm = mk(&remote_hlc(FUTURE_MS, 3), "link", &link_id, "link_remove",
            json!({"item_id": item, "topic_id": topic, "observed": []}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &rm).unwrap(), Outcome::ParentGone);
        let img_ts = mk(&remote_hlc(FUTURE_MS, 4), "image", "01IMGDEAD0000000000000000X", "image_tombstone",
            json!({"item_id": item}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &img_ts).unwrap(), Outcome::Applied);
    }

    /// typed poison 分型在源头钉死(epoch-plan §4):依赖未到 = DependencyMissing(挂起
    /// 自愈);词汇表外 = UnsupportedVocab(版本偏斜,挂起等升级);已知词汇下的非法 =
    /// InvalidOp(毒 op,工序2 起持久隔离)。分型错位的代价:毒 op 被当版本偏斜永久
    /// 挂起空转,或依赖未到被隔离误杀——所以型别本身是行为契约,必须锚死。
    #[test]
    fn op_errors_are_typed_at_source() {
        let (mut l, mut lc) = fresh();
        // 依赖未到:set_field 先于 create(行缺失且无墓碑)。
        let orphan = mk(&remote_hlc(FUTURE_MS, 0), "item", "01NOSUCHITEM0000000000000X", "set_field",
            json!({"field": "content", "value": "无主"}));
        assert!(matches!(apply_remote_op(&mut l, &mut lc, &orphan),
            Err(OpError::DependencyMissing(_))), "行缺失无墓碑必须归型 DependencyMissing");
        // 词汇表外:未知 kind / 未知 set_field 字段(将来版本的新词汇,旧端挂起等升级)。
        let new_kind = mk(&remote_hlc(FUTURE_MS, 1), "item", "X", "brand_new_kind", json!({}));
        assert!(matches!(apply_remote_op(&mut l, &mut lc, &new_kind),
            Err(OpError::UnsupportedVocab(_))), "未知 kind 必须归型 UnsupportedVocab");
        let item = notes::capture(&mut l, &mut lc, "分型锚点").unwrap();
        let new_field = mk(&remote_hlc(FUTURE_MS, 2), "item", &item, "set_field",
            json!({"field": "brand_new_field", "value": 1}));
        assert!(matches!(apply_remote_op(&mut l, &mut lc, &new_field),
            Err(OpError::UnsupportedVocab(_))), "未知字段必须归型 UnsupportedVocab");
        // 毒 op:严格纪元删掉的三形态(int position / 缺 observed / 缺 sha256)与
        // 已知但禁 set 的史实字段,全部 InvalidOp。
        let int_pos = mk(&remote_hlc(FUTURE_MS, 3), "item", &item, "set_field",
            json!({"field": "position", "value": 7}));
        assert!(matches!(apply_remote_op(&mut l, &mut lc, &int_pos),
            Err(OpError::InvalidOp(_))), "int position(严格纪元)必须归型 InvalidOp");
        let no_sha = mk(&remote_hlc(FUTURE_MS, 4), "image", "01NOSHAIMG00000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8}));
        assert!(matches!(apply_remote_op(&mut l, &mut lc, &no_sha),
            Err(OpError::InvalidOp(_))), "缺 sha256(严格纪元)必须归型 InvalidOp");
        let set_born = mk(&remote_hlc(FUTURE_MS, 5), "item", &item, "set_field",
            json!({"field": "born_stage", "value": "todo"}));
        assert!(matches!(apply_remote_op(&mut l, &mut lc, &set_born),
            Err(OpError::InvalidOp(_))), "set born_stage(史实禁改)必须归型 InvalidOp");
    }

    /// `born_stage: null` 是协议正式词汇(epoch-plan §2.3 收编):纪元压实基线的
    /// create 是现值快照——stage = 压实时刻现值(可 ≠ born_stage)、born_stage = 史实
    /// (pre-0018 行为 null,「未知不回填」)。live 回放必须落行(0025 的回放豁免放行
    /// 0018 出生守护),行上 born_stage 为 NULL、stage 为现值。
    #[test]
    fn create_with_null_born_stage_is_first_class() {
        let (mut l, mut lc) = fresh();
        let op = mk(&remote_hlc(FUTURE_MS, 0), "item", "01NULLBORNITEM0000000000X", "create",
            json!({"content": "压实基线行", "stage": "done", "created_at": "2026-01-01T00:00:00Z",
                   "born_stage": null, "due_on": null, "priority": null, "position": null}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &op).unwrap(), Outcome::Applied);
        let (stage, born): (String, Option<String>) = l
            .query_row(
                "SELECT stage, born_stage FROM items WHERE id = '01NULLBORNITEM0000000000X'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stage, "done", "stage = 压实时刻现值");
        assert_eq!(born, None, "born_stage 保持 NULL(未知不回填,不造假史实)");
        // 值域仍然封死:null 之外只有 stage 六枚举。
        let bad = mk(&remote_hlc(FUTURE_MS, 1), "item", "01BADBORNITEM00000000000X", "create",
            json!({"content": "x", "stage": "inbox", "created_at": "t2",
                   "born_stage": 42, "due_on": null, "priority": null, "position": null}));
        assert!(matches!(apply_remote_op(&mut l, &mut lc, &bad), Err(OpError::InvalidOp(_))),
            "born_stage 非枚举非 null 必须拒");
    }

    // ---- 豁免只对回放,单机守护原样 -----------------------------------------------------

    #[test]
    fn sealed_guards_exempt_for_replay_but_hold_locally() {
        let (mut l, mut lc) = fresh();
        let id = task::create(&mut l, &mut lc, "并发归档场景", None, None, None).unwrap();
        // 远端在它 done 时合法归档;本地此刻 stage 还是 todo(LWW 并发的常态)。
        // seal_only_done 若不豁免,这条合法 op 会被本地瞬时状态拒掉 → 两端分叉。
        let seal = mk(&remote_hlc(FUTURE_MS, 0), "item", &id, "set_field",
            json!({"field": "sealed_at", "value": "2026-07-07T08:00:00Z"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &seal).unwrap(), Outcome::Applied);

        // sealed 行上更高 HLC 的远端编辑必须落地(sealed_frozen 豁免)。
        let edit = mk(&remote_hlc(FUTURE_MS, 1), "item", &id, "set_field",
            json!({"field": "content", "value": "归档后远端改的标题"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &edit).unwrap(), Outcome::Applied);

        // 单机路径:同样的写在守护下照样 ABORT(标志表是空的)。
        assert!(l.execute("UPDATE items SET content='本地想改' WHERE id=?1", [&id]).is_err(),
            "sealed_frozen 对本地写照拦");
        assert!(l.execute("DELETE FROM items WHERE id=?1", [&id]).is_err(),
            "sealed_no_delete 对本地删照拦");
    }

    #[test]
    fn coupling_guards_exempt_midstate_but_hold_locally() {
        let (mut r, mut rc) = fresh();
        let id = notes::capture(&mut r, &mut rc, "远端转待办").unwrap();
        notes::promote_to_task(&mut r, &mut rc, &id, "远端转待办").unwrap();
        let ops = all_ops(&r);
        // promote 发射 stage 在前、position 在后(oplog::item_set 按字段序取号)——
        // 逐 op 回放必然经过「stage=todo 而 position 仍 NULL」的中间态,0021 的表 CHECK
        // 会当场炸;0022 降级 + 豁免后必须走得通,终态与远端一致。
        let (mut l, mut lc) = fresh();
        feed_all(&mut l, &mut lc, &ops);
        assert_eq!(fingerprint(&l, ITEMS_FP), fingerprint(&r, ITEMS_FP), "终态收敛");

        // 单机路径的耦合守护原样:灵感态带 position / 任务态丢 position 都被拒。
        let (stage, position): (String, Option<String>) = l
            .query_row("SELECT stage, position FROM items WHERE id=?1", [&id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!((stage.as_str(), position.is_some()), ("todo", true));
        assert!(l.execute("UPDATE items SET position=NULL WHERE id=?1", [&id]).is_err(),
            "任务态丢排序键,本地照拦");
        assert!(
            l.execute(
                "INSERT INTO items (id, content, stage, created_at, updated_at, born_stage, due_on) \
                 VALUES ('X1', 'x', 'inbox', 't', 't', 'inbox', '2026-07-10')",
                []
            )
            .is_err(),
            "灵感态带 due,本地照拦"
        );
    }

    // ---- link 的 OR-set ---------------------------------------------------------------

    #[test]
    fn or_set_concurrent_add_survives_unseen_remove() {
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "条目").unwrap();
        let topic = notes::create_topic(&mut l, &mut lc, "标签").unwrap();
        // 本地打上标签(真实发射 link_add)。
        notes::file_to_topic(&mut l, &mut lc, &item, Some(topic.as_str()), None).unwrap();
        let link_id = format!("{item}:{topic}");

        // 远端并发 remove:它只见过自己那边的 add(observed 不含本地这枚)——本地 add 存活。
        let rm_blind = mk(&remote_hlc(FUTURE_MS, 0), "link", &link_id, "link_remove",
            json!({"item_id": item, "topic_id": topic, "observed": ["01FAKEREMOTEADD0000000000X"]}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &rm_blind).unwrap(), Outcome::Applied);
        let linked: i64 = l
            .query_row("SELECT COUNT(*) FROM item_topic WHERE item_id=?1", [&item], |r| r.get(0))
            .unwrap();
        assert_eq!(linked, 1, "remove 只删它见过的 add,并发 add 活下来");

        // 远端补收到本地 add 后再 remove(observed 覆盖它)——这次删掉。
        let local_add_id: String = l
            .query_row(
                "SELECT op_id FROM oplog WHERE entity='link' AND entity_id=?1 AND kind='link_add'",
                [&link_id],
                |r| r.get(0),
            )
            .unwrap();
        let rm_seen = mk(&remote_hlc(FUTURE_MS, 1), "link", &link_id, "link_remove",
            json!({"item_id": item, "topic_id": topic, "observed": [local_add_id]}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &rm_seen).unwrap(), Outcome::Applied);
        let linked: i64 = l
            .query_row("SELECT COUNT(*) FROM item_topic WHERE item_id=?1", [&item], |r| r.get(0))
            .unwrap();
        assert_eq!(linked, 0, "observed 覆盖全部 add 后,行删除");
    }

    #[test]
    fn or_set_remove_before_add_is_sticky_and_readd_lives() {
        // 远端库:打标签 → 去标签 → 再打(第二枚 add 是新 op_id,不被旧 remove 的
        // observed 覆盖)。本地乱序喂:remove 先于它 observed 的 add——最终 link 必须在。
        let (mut r, mut rc) = fresh();
        let item = notes::capture(&mut r, &mut rc, "条目").unwrap();
        let topic = notes::create_topic(&mut r, &mut rc, "标签").unwrap();
        notes::file_to_topic(&mut r, &mut rc, &item, Some(topic.as_str()), None).unwrap();
        r.execute("DELETE FROM item_topic WHERE item_id=?1", [&item]).unwrap();
        oplog::link_remove(&r, &mut rc, &item, &topic).unwrap();
        repo::link_item_topic(&r, &item, &topic).unwrap();
        oplog::link_add(&r, &mut rc, &item, &topic).unwrap();

        let mut ops = all_ops(&r);
        // 把该 link 的 remove 挪到它 observed 的第一枚 add 之前(创建类 op 保持最前)。
        let rm_at = ops.iter().position(|o| o.kind == "link_remove").unwrap();
        let add_at = ops.iter().position(|o| o.kind == "link_add").unwrap();
        assert!(add_at < rm_at);
        ops.swap(add_at, rm_at);

        let (mut l, mut lc) = fresh();
        feed_all(&mut l, &mut lc, &ops);
        // remove 先到:它 observed 的第一枚 add 后到即死;第二枚 add(remove 没见过)存活。
        let linked: i64 = l
            .query_row("SELECT COUNT(*) FROM item_topic WHERE item_id=?1", [&item], |r| r.get(0))
            .unwrap();
        assert_eq!(linked, 1, "去了又打回:第二枚 add 存活,link 在");
        assert_eq!(fingerprint(&l, LINKS_FP), fingerprint(&r, LINKS_FP), "乱序后仍与远端收敛");
    }

    // ---- 判定的 entity 隔离 / image / 水位 / 拒收 --------------------------------------

    #[test]
    fn entity_scope_prevents_ulid_crosstalk() {
        // 手工造同一枚 id 的 item 与 topic(真实 ULID 不会撞,判定查询若丢了 entity
        // 谓词,这里就串扰):topic 的 tombstone 绝不能压制同 id 的 item。
        let (mut l, mut lc) = fresh();
        let shared = "01SAMEIDSAMEIDSAMEIDSAMEIX";
        let c_item = mk(&remote_hlc(FUTURE_MS, 0), "item", shared, "create",
            json!({"content": "同号条目", "stage": "inbox", "created_at": "2026-07-07T00:00:00Z",
                   "born_stage": "inbox", "due_on": null, "priority": null, "position": null}));
        let c_topic = mk(&remote_hlc(FUTURE_MS, 1), "topic", shared, "create",
            json!({"title": "同号标签", "created_at": "2026-07-07T00:00:00Z"}));
        let ts_topic = mk(&remote_hlc(FUTURE_MS, 2), "topic", shared, "tombstone", json!({}));
        feed_all(&mut l, &mut lc, &[c_item, c_topic, ts_topic]);

        assert!(row_exists(&l, "items", shared).unwrap(), "item 不被同号 topic 的墓碑波及");
        assert!(!row_exists(&l, "topics", shared).unwrap());
        let edit = mk(&remote_hlc(FUTURE_MS, 3), "item", shared, "set_field",
            json!({"field": "content", "value": "还活着"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &edit).unwrap(), Outcome::Applied);
    }

    #[test]
    fn image_add_pushes_seq_watermark_without_row() {
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "带图条目").unwrap();
        // 远端已用到「图3」(删过前两张):本地水位必须一步推到 3。
        let add = mk(&remote_hlc(FUTURE_MS, 0), "image", "01REMOTEIMG00000000000000X", "image_add",
            json!({"item_id": item, "seq": 3, "mime": "image/png", "bytes": 8, "sha256": TEST_SHA}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &add).unwrap(), Outcome::Applied);
        let (rows, last): (i64, i64) = (
            l.query_row("SELECT COUNT(*) FROM item_image", [], |r| r.get(0)).unwrap(),
            l.query_row("SELECT last_seq FROM item_image_counter WHERE item_id=?1", [&item], |r| r.get(0)).unwrap(),
        );
        assert_eq!((rows, last), (0, 3), "不建行,只推水位");
        // 本地随后取号从 4 起——「图N」跨端永不复用。
        let next = repo::next_image_seq(&l, &item).unwrap();
        assert_eq!(next, 4);
        // 低 seq 的旧 op 后到:水位不倒退(max 语义)。
        let add_old = mk(&remote_hlc(FUTURE_MS, 1), "image", "01REMOTEIMG00000000000001X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8, "sha256": TEST_SHA}));
        apply_remote_op(&mut l, &mut lc, &add_old).unwrap();
        let last: i64 = l
            .query_row("SELECT last_seq FROM item_image_counter WHERE item_id=?1", [&item], |r| r.get(0))
            .unwrap();
        assert_eq!(last, 4, "包含本地取号在内的高水位不被旧 op 拉低");
    }

    #[test]
    fn observe_makes_local_ticks_dominate_replayed_hlc() {
        let (mut l, mut lc) = fresh();
        let c_item = mk(&remote_hlc(FUTURE_MS, 5), "item", "01OBSERVEITEM000000000000X", "create",
            json!({"content": "未来的 op", "stage": "inbox", "created_at": "2026-07-07T00:00:00Z",
                   "born_stage": "inbox", "due_on": null, "priority": null, "position": null}));
        apply_remote_op(&mut l, &mut lc, &c_item).unwrap();
        let next = lc.tick(&l).unwrap().encode();
        assert!(next.as_str() > remote_hlc(FUTURE_MS, 5).as_str(),
            "回放后本地取号严格支配一切已见({next})");
    }

    #[test]
    fn rejects_bad_ops_without_side_effects() {
        let (mut l, mut lc) = fresh();
        let n0 = oplog_rows(&l);

        // 非法词汇 / 非法 HLC / set_field 先于 create(无 tombstone)——全拒收。
        let bad_vocab = mk(&remote_hlc(FUTURE_MS, 0), "link", "a:b", "set_field", json!({}));
        assert!(apply_remote_op(&mut l, &mut lc, &bad_vocab).is_err());
        let mut bad_hlc = mk(&remote_hlc(FUTURE_MS, 1), "item", "X", "tombstone", json!({}));
        bad_hlc.hlc = "不是时间戳".into();
        assert!(apply_remote_op(&mut l, &mut lc, &bad_hlc).is_err());
        let orphan = mk(&remote_hlc(FUTURE_MS, 2), "item", "01NOSUCHITEM0000000000000X", "set_field",
            json!({"field": "content", "value": "无主"}));
        assert!(apply_remote_op(&mut l, &mut lc, &orphan).is_err(), "行缺失且无墓碑 = 依赖未到,Err 交引擎挂起");
        let bad_field = mk(&remote_hlc(FUTURE_MS, 3), "item", "01NOSUCHITEM0000000000000X", "create",
            json!({"content": "x", "stage": "inbox", "created_at": "t",
                   "born_stage": "inbox", "due_on": 7, "priority": null, "position": null}));
        assert!(apply_remote_op(&mut l, &mut lc, &bad_field).is_err(), "payload 类型不对 = 拒收");
        assert_eq!(oplog_rows(&l), n0, "拒收的 op 一概不记账(事务整体回滚)");

        // link 的形状洞(codex 二轮):entity_id 与 payload 不一致 / observed 含非字符串。
        let item = notes::capture(&mut l, &mut lc, "有主条目").unwrap();
        let topic = notes::create_topic(&mut l, &mut lc, "有主标签").unwrap();
        let n1 = oplog_rows(&l);
        let mismatched = mk(&remote_hlc(FUTURE_MS, 4), "link", "别的:配对", "link_add",
            json!({"item_id": item, "topic_id": topic}));
        assert!(apply_remote_op(&mut l, &mut lc, &mismatched).is_err(), "entity_id 与 payload 不一致 = 拒收");
        let null_observed = mk(&remote_hlc(FUTURE_MS, 5), "link", &format!("{item}:{topic}"), "link_remove",
            json!({"item_id": item, "topic_id": topic, "observed": [null]}));
        assert!(apply_remote_op(&mut l, &mut lc, &null_observed).is_err(),
            "observed 含 null = 拒收(否则 SQL 三值逻辑误杀全部 add)");
        let missing_observed = mk(&remote_hlc(FUTURE_MS, 7), "link", &format!("{item}:{topic}"), "link_remove",
            json!({"item_id": item, "topic_id": topic}));
        assert!(apply_remote_op(&mut l, &mut lc, &missing_observed).is_err(),
            "缺 observed = 拒收(post-70 发射恒带;遗留形态只随引导快照导入,codex 复审②)");
        let bad_mime = mk(&remote_hlc(FUTURE_MS, 6), "image", "01BADMIMEIMG0000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "text/html", "bytes": 8, "sha256": TEST_SHA}));
        assert!(apply_remote_op(&mut l, &mut lc, &bad_mime).is_err(), "mime 不在白名单 = 拒收");
        assert_eq!(oplog_rows(&l), n1, "坏 link/image op 不记账");

        assert_eq!(flag_rows(&l), 0, "Err 路径回滚,标志不泄漏");
    }

    // ---- 「图N」并发撞号:顺延纯函数 / 翻案 / 正文修正 ---------------------------------

    #[test]
    fn rewrite_image_refs_matches_whole_numbers_and_swaps_atomically() {
        let map: HashMap<i64, i64> = [(3, 5)].into();
        assert_eq!(
            rewrite_image_refs("见图3与图30,另见图03", &map).as_deref(),
            Some("见图5与图30,另见图5"),
            "整词命中(图03 按数值也是图3,改写成规范形),图30 不动"
        );
        // 3→4 与 4→5 并存:单遍替换,原文的图3 绝不被二次改到 5。
        let chain: HashMap<i64, i64> = [(3, 4), (4, 5)].into();
        assert_eq!(rewrite_image_refs("图3、图4、图5", &chain).as_deref(), Some("图4、图5、图5"));
        assert_eq!(rewrite_image_refs("无引用,图 与 图abc 不算", &map), None, "无命中返回 None");
    }

    #[test]
    fn referenced_image_seqs_agrees_with_rewrite_semantics() {
        // 提取器与改写器同一份匹配语义(cross-space-move M3):图03≡3、图30≠3、
        // 「图」后无数字不算、多处引用全收。
        let seqs = referenced_image_seqs("见图3与图30,另见图03;图 与 图abc 不算");
        assert_eq!(seqs, HashSet::from([3, 30]));
        assert!(referenced_image_seqs("纯文字").is_empty());
        // 与 rewrite 的命中判定一致:凡 rewrite 会改的号,提取器必报;不改的(30)也在
        // 集合里——预检语义是「引用了哪些号」,比改写更宽(引用存在即须被现存图覆盖)。
        let map: HashMap<i64, i64> = [(3, 5)].into();
        assert!(rewrite_image_refs("见图3与图30,另见图03", &map).is_some());
        assert!(seqs.contains(&3) && seqs.contains(&30));
    }

    #[test]
    fn image_seq_collision_remote_higher_defers_remote_and_local_row_stays() {
        // 本地先取到图1(hlc 小,保号);远端并发的图1(hlc 大)顺延——本地行不动,
        // counter 推到顺延号,本地随后取号从顺延号之后继续。
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "带图条目").unwrap();
        let (local_img, s) = images::attach(&mut l, &mut lc, &item, &[1], "image/png").unwrap();
        assert_eq!(s, 1);
        let add = mk(&remote_hlc(FUTURE_MS, 0), "image", "01REMOTEIMGA0000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8, "sha256": TEST_SHA}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &add).unwrap(), Outcome::Applied,
            "顺延的是远端图(本地无行),不算本地翻案");
        let row_seq: i64 = l
            .query_row("SELECT seq FROM item_image WHERE id=?1", [&local_img], |r| r.get(0))
            .unwrap();
        assert_eq!(row_seq, 1, "保号方的行原样");
        let counter: i64 = l
            .query_row("SELECT last_seq FROM item_image_counter WHERE item_id=?1", [&item], |r| r.get(0))
            .unwrap();
        assert_eq!(counter, 2, "counter 覆盖远端图的顺延号");
        let (_i3, s3) = images::attach(&mut l, &mut lc, &item, &[2], "image/png").unwrap();
        assert_eq!(s3, 3, "本地随后取号跳过双方已用的一切编号");
    }

    #[test]
    fn image_seq_collision_local_higher_renumbers_row_and_rewrites_content() {
        // 远端图1 的 hlc 更小(它保号):本地图1 翻案顺延成图2,行 seq 改写(回放豁免、
        // 只许改 seq),本机背书的正文「见图1」同步修正为「见图2」,旧文进编辑历史,
        // 修正走真正的 content set_field op(各端由它收敛)。
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "初稿").unwrap();
        let (local_img, _) = images::attach(&mut l, &mut lc, &item, &[1], "image/png").unwrap();
        notes::edit(&mut l, &mut lc, &item, "详见图1,勿删").unwrap();
        let revs_before: i64 = l
            .query_row("SELECT COUNT(*) FROM item_revisions WHERE item_id=?1", [&item], |r| r.get(0))
            .unwrap();

        // 远端 add 的 hlc 用 1970 纪元:恒小于本地一切(并发离线取号的极端形态)。
        let add = mk(&remote_hlc(1_000, 0), "image", "01REMOTEIMGB0000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8, "sha256": TEST_SHA}));
        let out = apply_remote_op(&mut l, &mut lc, &add).unwrap();
        assert_eq!(out, Outcome::RenumberedLocalImages {
            renumbered: vec![(local_img.clone(), 1, 2)],
            content_rewritten: true,
        });
        let (row_seq, content): (i64, String) = l
            .query_row(
                "SELECT i.seq, t.content FROM item_image i JOIN items t ON t.id = i.item_id \
                 WHERE i.id = ?1",
                [&local_img],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((row_seq, content.as_str()), (2, "详见图2,勿删"));
        let revs_after: i64 = l
            .query_row("SELECT COUNT(*) FROM item_revisions WHERE item_id=?1", [&item], |r| r.get(0))
            .unwrap();
        assert_eq!(revs_after, revs_before + 1, "修正 UPDATE 照常把旧文归档进历史");
        // 修正 op 真实入账,是 content 的新胜者(hlc 支配一切已见)。
        let fix_ops: i64 = l
            .query_row(
                "SELECT COUNT(*) FROM oplog WHERE entity='item' AND entity_id=?1 \
                 AND kind='set_field' AND json_extract(payload,'$.field')='content' \
                 AND json_extract(payload,'$.value')='详见图2,勿删'",
                [&item],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fix_ops, 1, "正文修正必须有 op 背书");
        // 单机守护未松动:回放事务之外照样禁改图行。
        assert!(l.execute("UPDATE item_image SET seq = 9 WHERE id = ?1", [&local_img]).is_err(),
            "trg_item_image_immutable 对本地写照拦");
    }

    #[test]
    fn image_seq_chain_renumber_moves_multiple_rows_without_unique_clash() {
        // 链式翻案:本地图1、图2 在场,远端更早的图1 到达——本地图1 顶到 2、图2 顶到 3,
        // 降序改行不撞 UNIQUE(item_id, seq)。
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "链式").unwrap();
        let (img_a, _) = images::attach(&mut l, &mut lc, &item, &[1], "image/png").unwrap();
        let (img_b, _) = images::attach(&mut l, &mut lc, &item, &[2], "image/png").unwrap();
        let add = mk(&remote_hlc(1_000, 0), "image", "01REMOTEIMGC0000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8, "sha256": TEST_SHA}));
        let out = apply_remote_op(&mut l, &mut lc, &add).unwrap();
        assert_eq!(out, Outcome::RenumberedLocalImages {
            renumbered: vec![(img_b.clone(), 2, 3), (img_a.clone(), 1, 2)],
            content_rewritten: false,
        });
        let seqs: Vec<i64> = {
            let mut stmt = l
                .prepare("SELECT seq FROM item_image WHERE item_id = ?1 ORDER BY seq")
                .unwrap();
            let rows = stmt.query_map([&item], |r| r.get(0)).unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(seqs, vec![2, 3]);
        let counter: i64 = l
            .query_row("SELECT last_seq FROM item_image_counter WHERE item_id=?1", [&item], |r| r.get(0))
            .unwrap();
        assert_eq!(counter, 3);
    }

    #[test]
    fn content_from_another_device_is_never_rewritten() {
        // content 的 LWW 胜者出自别机:那段文本里的「图1」指写作者视野的图(按同一纯
        // 函数分配,全局一致),本机翻案时不代改。
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "本机初稿").unwrap();
        images::attach(&mut l, &mut lc, &item, &[1], "image/png").unwrap();
        let remote_edit = mk(&remote_hlc(FUTURE_MS, 0), "item", &item, "set_field",
            json!({"field": "content", "value": "远端说:见图1"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &remote_edit).unwrap(), Outcome::Applied);

        let add = mk(&remote_hlc(1_000, 0), "image", "01REMOTEIMGD0000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8, "sha256": TEST_SHA}));
        let out = apply_remote_op(&mut l, &mut lc, &add).unwrap();
        assert!(matches!(&out, Outcome::RenumberedLocalImages { content_rewritten: false, .. }),
            "翻案照做,文本不动:{out:?}");
        let content: String =
            l.query_row("SELECT content FROM items WHERE id=?1", [&item], |r| r.get(0)).unwrap();
        assert_eq!(content, "远端说:见图1");
    }

    #[test]
    fn content_written_before_the_image_existed_is_not_rewritten() {
        // 正文写于贴图之前(「见图1」是前瞻引用,写时那张图还不存在):图被顺延也不改
        // 这段文本——add 晚于 content 胜者,过滤条挡下(codex 抓的洞)。
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "先写:见图1").unwrap();
        let (local_img, _) = images::attach(&mut l, &mut lc, &item, &[1], "image/png").unwrap();
        let add = mk(&remote_hlc(1_000, 0), "image", "01REMOTEIMGE0000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8, "sha256": TEST_SHA}));
        let out = apply_remote_op(&mut l, &mut lc, &add).unwrap();
        assert_eq!(out, Outcome::RenumberedLocalImages {
            renumbered: vec![(local_img, 1, 2)],
            content_rewritten: false,
        });
        let content: String =
            l.query_row("SELECT content FROM items WHERE id=?1", [&item], |r| r.get(0)).unwrap();
        assert_eq!(content, "先写:见图1", "前瞻引用保持原样,宁提示不改错");
    }

    #[test]
    fn duplicate_image_add_and_mismatched_tombstone_are_rejected() {
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "宿主").unwrap();
        let (local_img, _) = images::attach(&mut l, &mut lc, &item, &[1], "image/png").unwrap();
        let n0 = oplog_rows(&l);
        // 同一 image_id 的第二条 add(不同 op_id):纯函数会把它当两张图,拒收。
        let dup = mk(&remote_hlc(FUTURE_MS, 0), "image", &local_img, "image_add",
            json!({"item_id": item, "seq": 7, "mime": "image/png", "bytes": 8, "sha256": TEST_SHA}));
        assert!(apply_remote_op(&mut l, &mut lc, &dup).is_err());
        // tombstone 声称的宿主与 add 不一致:两条 op 各说各话,拒收。
        let bad_ts = mk(&remote_hlc(FUTURE_MS, 1), "image", &local_img, "image_tombstone",
            json!({"item_id": "01SOMEOTHERITEM0000000000X"}));
        assert!(apply_remote_op(&mut l, &mut lc, &bad_ts).is_err());
        assert_eq!(oplog_rows(&l), n0, "拒收的 op 不记账");
        assert_eq!(flag_rows(&l), 0);
    }

    #[test]
    fn replaying_same_op_id_with_different_content_is_rejected_not_already_seen() {
        // codex 四轮:AlreadySeen 的判定必须比完整 op——同 op_id 异内容当幂等吞掉
        // 就是静默分叉,这里要响亮拒收(引擎层同款判定另有冻结)。
        let (mut l, mut lc) = fresh();
        let real = mk(&remote_hlc(1_000, 0), "topic", "01TOPICSAMEID000000000000X", "create",
            json!({"title": "原始", "created_at": "2026-07-08T00:00:00Z"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &real).unwrap(), Outcome::Applied);
        assert_eq!(apply_remote_op(&mut l, &mut lc, &real).unwrap(), Outcome::AlreadySeen,
            "逐字段全同 = 真重传,幂等");
        let mut tampered = real;
        tampered.payload = json!({"title": "被改写", "created_at": "2026-07-08T00:00:00Z"});
        assert!(apply_remote_op(&mut l, &mut lc, &tampered).is_err(),
            "同 op_id 异内容 = 拒收,不许装 AlreadySeen");
        let title: String = l
            .query_row("SELECT title FROM topics WHERE id = '01TOPICSAMEID000000000000X'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "原始");
    }

    #[test]
    fn image_add_rejects_missing_sha_and_mismatched_preceding_tombstone() {
        // codex 二轮 #7:op 通道上的 add 必带合法 sha256(旧无 hash op 只该走引导快照);
        // codex 二轮 #2:乱序先到的 tombstone 若声称别的宿主,后到的合法 add 会被它
        // 永久压死且不进缺字节清单——两条 op 各说各话 = 拒收,不静默丢图。
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "宿主").unwrap();
        let n0 = oplog_rows(&l);
        let no_sha = mk(&remote_hlc(FUTURE_MS, 0), "image", "01IMGNOSHA000000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8}));
        assert!(apply_remote_op(&mut l, &mut lc, &no_sha).is_err(), "缺 sha256 = 拒收");
        let bad_sha = mk(&remote_hlc(FUTURE_MS, 1), "image", "01IMGNOSHA000000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8, "sha256": "ABC"}));
        assert!(apply_remote_op(&mut l, &mut lc, &bad_sha).is_err(), "sha256 形态非法 = 拒收");
        let huge = mk(&remote_hlc(FUTURE_MS, 9), "image", "01IMGHUGE0000000000000000X", "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png",
                "bytes": (crate::images::MAX_IMAGE_BYTES as i64) + 1, "sha256": TEST_SHA}));
        assert!(apply_remote_op(&mut l, &mut lc, &huge).is_err(),
            "声明 bytes 超上限 = 拒收(否则收端按声明攒块仍是无界内存)");
        assert_eq!(oplog_rows(&l), n0, "拒收不记账");

        // tombstone 先到(声称宿主是别人)→ 合法 add 后到:宿主对不上,拒收整条 add
        // (而不是 SuppressedByTombstone 静默压死)。
        let img = "01IMGTSFIRST0000000000000X";
        let ts = mk(&remote_hlc(FUTURE_MS, 2), "image", img, "image_tombstone",
            json!({"item_id": "01SOMEOTHERITEM0000000000X"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &ts).unwrap(), Outcome::Applied, "无 add 在场的墓碑幂等收下");
        let add = mk(&remote_hlc(FUTURE_MS, 3), "image", img, "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/png", "bytes": 8, "sha256": TEST_SHA}));
        assert!(apply_remote_op(&mut l, &mut lc, &add).is_err(), "宿主与先到墓碑不一致 = 拒收");
        assert_eq!(flag_rows(&l), 0);
    }

    #[test]
    fn image_bytes_verify_then_build_row_dropped_for_dead_and_idempotent() {
        // 旁路字节到达(§5.4/72 契约):远端 image_add 应用后行不建;字节到 → 验货
        // (长度+sha256)建行、seq 取重算值;重复到达幂等;墓碑图丢字节不建行。
        let (mut l, mut lc) = fresh();
        let item = notes::capture(&mut l, &mut lc, "旁路宿主").unwrap();
        let data = [9u8, 8, 7, 6];
        let sha: String = {
            use sha2::{Digest, Sha256};
            Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
        };
        let img = "01REMOTEBYTES000000000000X";
        let add = mk(&remote_hlc(1_000, 0), "image", img, "image_add",
            json!({"item_id": item, "seq": 1, "mime": "image/webp", "bytes": 4, "sha256": sha}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &add).unwrap(), Outcome::Applied);
        // 长度不符 / sha 不符:拒,不建行。
        assert!(apply_image_bytes(&mut l, img, &[9, 8, 7]).is_err(), "长度必验");
        assert!(apply_image_bytes(&mut l, img, &[0, 0, 0, 0]).is_err(), "sha256 必验");
        // 验货过:建行,seq = 重算有效号,mime 取自 op。
        assert_eq!(apply_image_bytes(&mut l, img, &data).unwrap(), BytesOutcome::Applied { seq: 1 });
        let (seq, mime, got): (i64, String, Vec<u8>) = l
            .query_row("SELECT seq, mime, data FROM item_image WHERE id = ?1", [img], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!((seq, mime.as_str(), got.as_slice()), (1, "image/webp", &data[..]));
        assert_eq!(
            apply_image_bytes(&mut l, img, &data).unwrap(),
            BytesOutcome::AlreadyPresent,
            "重复拉取幂等"
        );
        assert_eq!(flag_rows(&l), 0, "豁免标志绝不泄漏");
        // 墓碑先到的图:字节到达只配 Dropped,永不建行(72 契约:不为死图建行)。
        let img2 = "01REMOTEBYTES000000000000Y";
        let add2 = mk(&remote_hlc(2_000, 0), "image", img2, "image_add",
            json!({"item_id": item, "seq": 2, "mime": "image/png", "bytes": 4, "sha256": sha}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &add2).unwrap(), Outcome::Applied);
        let ts2 = mk(&remote_hlc(2_001, 0), "image", img2, "image_tombstone",
            json!({"item_id": item}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &ts2).unwrap(), Outcome::Applied);
        assert_eq!(apply_image_bytes(&mut l, img2, &data).unwrap(), BytesOutcome::Dropped);
        let rows: i64 = l
            .query_row("SELECT COUNT(*) FROM item_image WHERE id = ?1", [img2], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn mirror_concurrent_image_seq_converges_both_ends() {
        // 双库端到端:同一条目两端离线各贴一张图,都取到图1。互喂全量 op 后:hlc 小者
        // 保号,hlc 大者(带行的那端自己)翻案成图2 并修正自己的正文,行编号分配、
        // counter、content 三者两端收敛。
        let (mut a, mut ac) = fresh();
        let item = notes::capture(&mut a, &mut ac, "两端同贴").unwrap();
        let (mut b, mut bc) = fresh();
        feed_all(&mut b, &mut bc, &all_ops(&a));

        let (img_a, sa) = images::attach(&mut a, &mut ac, &item, &[0xA], "image/png").unwrap();
        // 把 B 的时钟推到 A 的 add 之后(模拟 B 端墙钟偏快),使 B 的并发取号 hlc 更大
        // ——撞号裁决因此确定:A 保号,B 顺延。图号 counter 不动,B 照样取到 1。
        let a_add_hlc: String = a
            .query_row("SELECT hlc FROM oplog WHERE entity='image' AND entity_id=?1", [&img_a], |r| r.get(0))
            .unwrap();
        bc.observe(&b, &Hlc::parse(&a_add_hlc).unwrap()).unwrap();
        let (img_b, sb) = images::attach(&mut b, &mut bc, &item, &[0xB], "image/png").unwrap();
        assert_eq!((sa, sb), (1, 1), "两端离线并发,各自都取到图1");
        notes::edit(&mut b, &mut bc, &item, "B 端注:见图1").unwrap();

        // B 收 A 的全量:A 的 add(hlc 小)保号,B 自己的行翻案 1→2,正文跟着修正。
        feed_all(&mut b, &mut bc, &all_ops(&a));
        let (b_row, b_content): (i64, String) = b
            .query_row(
                "SELECT i.seq, t.content FROM item_image i JOIN items t ON t.id=i.item_id WHERE i.id=?1",
                [&img_b],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((b_row, b_content.as_str()), (2, "B 端注:见图2"));

        // A 收 B 的全量(含 B 的修正 op):A 的行保号,content 落 B 的修正文本。
        feed_all(&mut a, &mut ac, &all_ops(&b));
        let (a_row, a_content): (i64, String) = a
            .query_row(
                "SELECT i.seq, t.content FROM item_image i JOIN items t ON t.id=i.item_id WHERE i.id=?1",
                [&img_a],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((a_row, a_content.as_str()), (1, "B 端注:见图2"));
        assert_eq!(fingerprint(&a, IMG_COUNTER_FP), fingerprint(&b, IMG_COUNTER_FP), "「图N」水位收敛");
        assert_eq!(fingerprint(&a, ITEMS_FP), fingerprint(&b, ITEMS_FP), "items 收敛(含修正后的 content)");
        assert_eq!(flag_rows(&a) + flag_rows(&b), 0);
    }

    #[test]
    fn dirty_lww_end_state_does_not_break_local_editing() {
        // 并发合并的合法脏终态:stage 被 LWW 拉回灵感态,position 死值留在行上
        // (对端撤回 vs 本端拖动)。本地日常操作必须不被误拦。
        let (mut l, mut lc) = fresh();
        let id = task::create(&mut l, &mut lc, "并发拉扯的卡", None, None, None).unwrap();
        let back = mk(&remote_hlc(FUTURE_MS, 0), "item", &id, "set_field",
            json!({"field": "stage", "value": "filed"}));
        assert_eq!(apply_remote_op(&mut l, &mut lc, &back).unwrap(), Outcome::Applied);
        let (stage, pos): (String, Option<String>) = l
            .query_row("SELECT stage, position FROM items WHERE id=?1", [&id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!((stage.as_str(), pos.is_some()), ("filed", true), "脏终态如预期:灵感态带 position 死值");

        // 本地编辑正文(不触耦合触发器)照常;编辑历史照长。
        notes::edit(&mut l, &mut lc, &id, "改个说法").unwrap();
        // 本地再转待办:显式写 stage+position,耦合满足,脏值被正常路径冲干净。
        notes::promote_to_task(&mut l, &mut lc, &id, "改个说法").unwrap();
        let (stage, pos): (String, Option<String>) = l
            .query_row("SELECT stage, position FROM items WHERE id=?1", [&id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!((stage.as_str(), pos.is_some()), ("todo", true));
    }
}
