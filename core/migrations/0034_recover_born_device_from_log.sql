-- migration 0034: 从 create op 日志恢复 born_device —— 补 0033 的混版漏项。
-- identity-plan §3.5;codex 301 实现审一轮 H1。
--
-- **病**(0033 只分析了一个方向,漏了反方向):
--
--   v33 端发的 item create **恒带** born_device 键。v32 端收到它时:
--     ① validate_op_shape 的 ("item","create") 臂只校验**它认识的键**,额外键放行;
--     ② oplog::append_remote 把**整个 payload 原样入库**——那个键就此躺在它的日志里;
--     ③ 而 v32 的 apply_item_create 的 INSERT 列表里根本没有 born_device 这一列,值被
--        **静默丢弃**;
--     ④ op 成功应用 → 水位推进 → 这条 op **永不重放**。
--
--   于是这台设备升级到 0033 之后:items 行上是 NULL,而它自己的 create op 在日志里明写着
--   出生设备。0033 只 `ALTER TABLE ... ADD COLUMN`,没有任何一步会去看那条日志——**署名
--   永久丢失,且升级不自愈**(要等的东西已经来过了)。
--
--   更要命的是第二段后果:0033 同轮把 born_device 加进了 `boot::ITEM_LWW_FIELDS`(状态⟺
--   日志比对)。于是这样的库从此 **strict_battery 恒红**——纪元压实自验收 / certify /
--   给别的新设备供 boot 快照,三条路全挂。这已经不是「少个署名」,是把一台设备的数据层
--   健康判据打成永久失败。
--
-- **修法**:对「行上 NULL 而自己的 create op 说了值」的行,按**与审计逐字相同的口径**
-- 把值取回来。这不违背 §3.1「谁创建的不可从 oplog 派生」——那条讲的是**不许从 op 的
-- origin 反推**(压实会把 origin 整表重写成锚点设备);这里取的是 create payload 里**显式
-- 写着的那个值**,是日志里的一手史实,不是推断。
--
-- 三个刻意的判据,逐条说清:
--
--   * **`ORDER BY hlc DESC LIMIT 1`**(不是 ASC)。口径必须与 `boot::count_field_mismatches`
--     **逐字一致**,否则「修完仍然红」。那里对每个字段取的是「create 初值与全部 set_field
--     里 HLC 最大者」,born_device 的 set_field 被协议禁,于是退化成「HLC 最大的那条 create」。
--     每实体恰一条 create 由 audit_create_multiplicity 另行保证,这里只负责不跟审计打架。
--
--   * **只恢复「文本 ∧ 规范 device_id」的值**,判据是 `replay::validate_device_id_value`
--     (即 `clock::is_canonical_device_id`)的 SQL 镜像:26 位、Crockford 大写去 I/L/O/U。
--     这两半的理由不同:
--       - **类型**:非文本值(数字/对象/布尔)写进 TEXT 列会被列亲和性转成字符串,而审计比的
--         是 `t.born_device IS (SELECT json_extract(...))` —— TEXT '123' 与 INTEGER 123
--         永远不相等,这类行无论恢不恢复都过不了审计。
--         ⚠️ **诚实标注:这道闸与下面两道在今天的 JSON 值域里完全重叠,没有独立行为测。**
--         要触发「类型非文本、却又通过 length=26 ∧ 字符集」得有一个 26 位整数,而 JSON 整数
--         最多 20 位(u64),再大就成 REAL、字符串形带 `.`/`e` 又撞 GLOB。留着它是为了**把
--         意图写在明处**,而不是让「非文本不恢复」这件事依赖「JSON 数值范围」这种跨层论证。
--       - **字符集**(302 二轮 M1,我一轮判错了):非规范文本(伪造的 'abc')恢复后确实能让
--         LWW 审计过,但代价是**把一个协议非法、且永不可改的值物化进不可变列**,此后产品
--         路径再也修不掉它。我原以为「交给 audit_op_shapes 去拒」够了 —— **不够**:
--         ① `strict_battery` 里 `audit_op_shapes(conn)?` 是**短路返回**,后面的 LWW 审计
--            根本不会跑,所以「两个函数为同一件事各红一次」这个顾虑不存在;
--         ② `audit_op_shapes` **不在开库路径上**(只在 compact / certify / 供快照那几个入口),
--            普通用户天天开库,那个非法值不会被任何人拦下。
--       列保持 NULL 才是干净的:该 op 本身非法这件事,由它该去的那道闸去报。
--
--   * **`WHERE born_device IS NULL`**。它**不是**「触发器缺席期间挡住别人写入」的守卫——
--     迁移跑在 runner 的 `BEGIN IMMEDIATE` 事务里,DROP/UPDATE/CREATE 全事务化,外部写入
--     本来就进不来(302 二轮 L:我一轮把理由写错了,判据本身是对的)。它真正守的是:
--     **恢复步自己只填混版丢掉的空,绝不把已有的不可变史实改写成日志赢家**。去掉它,一枚
--     「行值与日志不符」的坏库会被这一步**静默洗账**,而那本该是 strict_battery 响亮报出来
--     的事。行为测 `migration_0034_only_fills_blanks_and_never_rewrites` 第二格守的就是它。
--
-- 冻结触发器必须先撤后建:它**无回放豁免**(0033 原文「导入只 INSERT,永不改写出生态」),
-- 连 sync_replay_active 都放不过去,所以恢复步只能在它不在场时做。整条迁移在一个事务里,
-- 中途失败整体回滚、旧触发器原样还在。
--
-- 跨版本同步政策(每条新迁移必须声明,见 db.rs 头「迁移作者规则」):
--   **纯本地 schema 修复,新旧客户端混跑安全**。不新增/不改动任何 oplog 词汇、不发射 op、
--   不改协议;只是把本地状态对齐到本地日志早就写着的事实。0033 从未上生产,故对现网用户
--   而言 0033+0034 是一次性的 v32→v34 升级。

DROP TRIGGER trg_item_born_device_frozen;

UPDATE items SET born_device = (
    SELECT json_extract(payload, '$.born_device') FROM oplog
     WHERE entity = 'item' AND entity_id = items.id AND kind = 'create'
     ORDER BY hlc DESC LIMIT 1)
WHERE born_device IS NULL
  AND EXISTS (
      SELECT 1 FROM (
          SELECT json_extract(payload, '$.born_device') AS v,
                 json_type(payload, '$.born_device') AS t
            FROM oplog
           WHERE entity = 'item' AND entity_id = items.id AND kind = 'create'
           ORDER BY hlc DESC LIMIT 1)
       WHERE t = 'text'
         AND length(v) = 26
         AND v NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*');

-- 原样重建(与 0033 那份逐字一致)。
--
-- ⚠️ **两份定义 = v33 / v34 两个 schema 检查点,两份都是历史,谁都不该再改**(302 二轮 L)。
-- 当前 v34 库上活着的是**这一份**;0033 那份跑到这里就被上面那句 DROP 掉了,只在「库恰好
-- 停在 v33」的暂态里有效。将来要改冻结触发器的行为,**新增 0035 去 DROP + CREATE** ——
-- 别回头动 0033/0034,改已应用的迁移就是真实库分叉。
-- (302 变异对照实测:把 0033 那份的 WHEN 改坏,测试照样绿 —— 因为这一份又把它建回来了。
--  所以行为测与变异都必须打**这一份**。)
CREATE TRIGGER trg_item_born_device_frozen
BEFORE UPDATE OF born_device ON items
FOR EACH ROW
WHEN OLD.born_device IS NOT NEW.born_device
BEGIN
    SELECT RAISE(ABORT, '出生设备是史实,不可修改');
END;
