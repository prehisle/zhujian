//! 看板列(`board_column`)—— board-columns-plan B 系列的数据层。
//!
//! `items.stage` 自迁移 0036 起不再是六值枚举,而是**指向 `board_column` 一行的身份**:
//! 列的名称 / 顺序 / 增删成为同步事实,「灵感态 vs 任务态」这条二分由列的 `kind` 承载
//! (不变量 3),灵感那两列(`inbox`/`filed`)是不可改不可删的系统列(不变量 2)。
//!
//! # 本模块今天负责什么
//!
//! **B-b 第 1 段(本轮)= schema 检查点**:只有 [`SEED_COLUMNS`] 这份唯一 seed 描述源,
//! 以及两道跟着它走的审计([`audit_seed_columns`] / [`audit_tombstone_apply_empty`],
//! 由 `boot::strict_battery` 消费)。**本地命令面与 read model 是 B-b 第 2 段**,
//! 实体面(oplog 词汇 / replay 两臂 / shape / boot 审计 / epoch 基线与指纹 /
//! `entity_registry` 十一面)整个归 **B-c**(plan §8.1-1)。
//!
//! # ⭐ 为什么 [`SEED_COLUMNS`] 必须是**唯一**的 seed 描述源(plan §7.1e,七轮判 H)
//!
//! 「哪六个 id 是种子」这份知识要出现在**六处**:迁移 SQL / replay apply 的 seed 分支 /
//! `count_unbacked_rows` 豁免 / `audit_op_preconditions` 分支 / `audit_create_multiplicity`
//! 禁令 / epoch 基线分类。**漂一处就是一个安静的洞**,而最坏后果跨过了「门禁停止扩张线」
//! 那条判据(CLAUDE.md 工作节奏 5):
//!
//! * 漏掉一个真 seed id ⇒ 合法 seed op 被当普通用户 op,**boot/fresh 可能永久拒**;
//! * 把普通用户 id 错列成 seed ⇒ 无 create 背书的行被豁免,**可能穿过 boot/battery =
//!   静默不同步**;
//! * epoch 漏掉 seed ⇒ 合成错误的 create,远端撞已有 genesis 行或错误隔离。
//!
//! ⇒ 上述六个面**全部消费这一份**;迁移 SQL 里仍有固定字面量(它必须是字面量,见下),
//! 两者的一致性由 [`audit_seed_columns`] 在每次严格电池上逐字段核。
//! ⛔ **不给 `entity_registry` 加「seed policy」第 12 面**(七轮明确否):它只登记**实体级**
//! 的面,而 seed 例外是**同一个 `board_column` 在已有五个面上的特殊值策略**,不是新实体面。
//!
//! # ⚠ 种子分两类,不是一类(plan §7.1a,codex 五轮推翻了「六个一律是 schema 常量」)
//!
//! 共同点:两类都**不发 `board_column/create`**(否则 V1 就给旧端发了它不认识的新 entity)。
//! 差别在**此后**:
//!
//! | 行类 | 同步语义 | 校验 |
//! |---|---|---|
//! | `inbox`/`filed`(`system=1`) | 真 schema-owned:**永无** create/set_field/tombstone | 与 canonical 行**逐字段严格相等**,`tombstoned_at` 必须 NULL |
//! | 四个 task 种子(`system=0`) | **schema-seeded implicit genesis**:不发 create,但此后 `title`/`position`/`tombstone` **全走普通 op** | 只核出生字段;⛔ **title/position/墓碑不与默认值盲比**——按不变量 2 它们可改名、可排序、可删,那就是用户数据 |

use rusqlite::Connection;

/// 一个种子列的 canonical 出生形。**六行的唯一描述源**(见模块头注)。
///
/// ⚠ 字段全是 `&'static str` / `bool` 的**值**而不是从库里读出来的:它要能在「库还没建
/// 起来」「库是坏的」两种语境下当判据用。
pub(crate) struct SeedColumn {
    /// 旧 stage 字面量。⛔ **不给旧列换 ULID**:`items.stage` 存量行、`born_stage` 存量值、
    /// `oplog` 里全部历史 op 的 payload 都写着这六个字面量,而 oplog 是 append-only 史实
    /// (0020 触发器)⇒ 换 id 就得重写历史。存量数据零改动,只是 FK 从此指得到人。
    pub(crate) id: &'static str,
    /// 迁移里那份 canonical 中文名。⚠ **不是显示文案**:显示走 plan §7.1d 的**终态判据**
    /// (`title != canonical` ⇒ 用同步来的名;相等 ⇒ 按 id 查本端字典),判据在 core 求值,
    /// ⛔ canonical 串不进前端。
    pub(crate) canonical_title: &'static str,
    /// `idea` | `task`。出生字段,协议禁 `set_field`,存储层由 `trg_board_column_birth_immutable` 冻结。
    pub(crate) kind: &'static str,
    /// 系统列 = 不可删(所有者轴)。⚠ 与 `kind`(流程空间轴)是**两根不同的轴**,
    /// 别把「不可删」退化成 `kind='idea'`——那样就表达不了将来的「不可删的 task 列」。
    pub(crate) system: bool,
    /// frindex 排序键。迁移里写死的固定值(见 [`SEED_COLUMNS`] 头上那段)。
    pub(crate) position: &'static str,
    /// ⛔ **迁移文件里写死的 canonical 字面量**,不是各端各取一次当前时间:seed 行无 op
    /// 背书,各端时刻不同 = 一个**无 op 可依的分叉**(codex 五轮)。
    pub(crate) created_at: &'static str,
}

/// 迁移 0036 种下的六行。**顺序 == `position` 的升序**(读序另由 `(position, id)` 定)。
///
/// ⚠ 这份**必须与 `core/migrations/0036_board_column.sql` 里那条 INSERT 逐字段相等**,
/// 由 [`audit_seed_columns`] 与本模块的单测两头钉住。⛔ 改这里就要改那里 —— 迁移是
/// append-only 的史实,真要改 canonical 值只能新增一条迁移(0034 判例)。
pub(crate) const SEED_COLUMNS: &[SeedColumn] = &[
    SeedColumn {
        id: "inbox",
        canonical_title: "未归类",
        kind: "idea",
        system: true,
        position: "a0",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "filed",
        canonical_title: "已归类",
        kind: "idea",
        system: true,
        position: "a1",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "todo",
        canonical_title: "待办",
        kind: "task",
        system: false,
        position: "a2",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "doing",
        canonical_title: "进行中",
        kind: "task",
        system: false,
        position: "a3",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "confirming",
        canonical_title: "待确认",
        kind: "task",
        system: false,
        position: "a4",
        created_at: "2026-08-24T00:00:00.000Z",
    },
    SeedColumn {
        id: "done",
        canonical_title: "已完成",
        kind: "task",
        system: false,
        position: "a5",
        created_at: "2026-08-24T00:00:00.000Z",
    },
];

/// 种子行的值一致性审计(plan §7.1e:「并进已有的 migration / strict-battery 验收」)。
///
/// **两类种子核的东西不一样**(plan §7.1a,⛔ 别把四个 task 种子也拿去与默认值盲比):
///
/// * 六个都核:行在 + `kind` + `system` + `created_at`。这三格是**出生字段**——协议禁
///   `set_field`(白名单只有 `title`/`position`),存储层另有 `trg_board_column_birth_immutable`
///   冻结 kind/system ⇒ 任何一格漂了都不是用户干的,是 bug 或库被改过。
/// * `system=1` 那两个另核:`title` + `position` + `tombstoned_at IS NULL`。它们**永不接受
///   任何 op**(不变量 2),故这三格也恒是 canonical 值。
/// * 四个 task 种子的 `title`/`position`/`tombstoned_at` **刻意不核**:可改名、可排序、可删
///   ⇒ 那是**用户数据**,由合并后的 oplog 物化(B-c 的 op-backed 语义审计管它,不归这里)。
///
/// ⚠ 诚实边界:它答得了「这六行还是不是它们自己」,答不了「有没有多出一个假冒的系统列」
/// ——那一格归 B-c 的出生校验(「非保留 id 却 `system=1`」)。
pub(crate) fn audit_seed_columns(conn: &Connection) -> Result<(), String> {
    for seed in SEED_COLUMNS {
        let row = conn
            .query_row(
                "SELECT title, kind, system, position, created_at, tombstoned_at \
                 FROM board_column WHERE id = ?1",
                [seed.id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .map_err(|e| format!("种子列「{}」读不到({e})——库结构残缺,整体拒", seed.id))?;
        let (title, kind, system, position, created_at, tombstoned_at) = row;
        if kind != seed.kind {
            return Err(format!(
                "种子列「{}」的 kind 是「{kind}」,应为「{}」(出生字段被改写)",
                seed.id, seed.kind
            ));
        }
        if system != i64::from(seed.system) {
            return Err(format!(
                "种子列「{}」的 system 是 {system},应为 {}(出生字段被改写)",
                seed.id,
                i64::from(seed.system)
            ));
        }
        if created_at != seed.created_at {
            return Err(format!(
                "种子列「{}」的 created_at 是「{created_at}」,应为「{}」\
                 (它是迁移里写死的 canonical 字面量,漂了 = 两端会分叉)",
                seed.id, seed.created_at
            ));
        }
        if !seed.system {
            continue;
        }
        if title != seed.canonical_title {
            return Err(format!(
                "系统列「{}」的 title 是「{title}」,应为「{}」(系统列不可改名)",
                seed.id, seed.canonical_title
            ));
        }
        if position != seed.position {
            return Err(format!(
                "系统列「{}」的 position 是「{position}」,应为「{}」(系统列不可排序)",
                seed.id, seed.position
            ));
        }
        if tombstoned_at.is_some() {
            return Err(format!("系统列「{}」带着墓碑标记——系统列不可删除", seed.id));
        }
    }
    Ok(())
}

/// 墓碑授权表的**空表审计**(plan §2.3「授权行泄漏」那节,八轮把它的定位改准了)。
///
/// ⭐ **它不是**「防止第二枚正常 op 重复授权」的机制 —— 那件事由
/// `trg_board_column_tombstone_consume` 在触发器里当场消费授权行做掉(⑥),
/// 不靠 apply 记得删。**这道审计只干三件**:发现实现 bug、报告残留状态、
/// 在 boot / strict battery 上 fail-closed。
///
/// 判据 = 常态恒空:授权行的生命周期整个关在一枚 tombstone 的写事务里(先记 oplog →
/// 登记授权 → UPDATE 行 → ⑥ 消费),事务失败即随回滚消失。**跨事务还留着 = 有一条路径
/// 绕过了 ⑥**,那是 H 级数据损坏路径的信号,⛔ 别当成清理没做干净就顺手删了了事。
pub(crate) fn audit_tombstone_apply_empty(conn: &Connection) -> Result<(), String> {
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM sync_board_column_tombstone_apply", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if n > 0 {
        return Err(format!(
            "墓碑授权表残留 {n} 行(常态恒空)——有路径绕过了 trg_board_column_tombstone_consume,\
             整体拒;⛔ 别直接删了事,先查那条路径"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
