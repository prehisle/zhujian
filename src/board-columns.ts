// 看板列的**读侧**共享件(B-f 第 1 段)+ **桌面独有的写侧四条 + 一枚只读探针**(第 2 段)。
//
// board-columns-plan 起 `items.stage` 不再是六值枚举,而是指向 `board_column` 一行的身份
// ⇒ 「有哪几列、叫什么、哪几列进看板」全部来自库。这三件事在 core 已有唯一正式子
// (`board::list_columns`,含不变量 3「灵感态 vs 任务态由列的 kind 说了算」),本文件只做
// 搬运层该做的三件:**取、显示名、看板画哪几列**。⛔ 别在别的视图里再拼一份。
//
// ⚠ 安卓那棵树另有一份同形的(`android/src/columns.ts`)—— 两个前端不共享代码、字典也各
// 一份,这是仓里既有的形(同 filter-bar 与 android/src/filter.ts)。⛔ 但**判据只有一条**:
// 两份都必须照 `kind` / `deleted` 分,谁都不许回到四值字面量。

import { invoke } from "./space";
import { t } from "./i18n";

/** 一列的当前态(与两只壳的 `BoardColumn` DTO 逐字段一致)。 */
export type BoardColumn = {
  id: string;
  /** 同步来的原文。⚠ `title_overridden === false` 时**不是**要显示的串,见 columnName()。 */
  title: string;
  /** `idea` | `task`。 */
  kind: string;
  /** 系统列(灵感那两列):不可改名、不可删。 */
  system: boolean;
  /** §7.1d 的终态判据:false ⇒ 名字还是 canonical ⇒ 按 id 查本端字典。 */
  title_overridden: boolean;
  /** 已删 = 只读收容区(§4.3):卡只出不进。 */
  deleted: boolean;
  /** 该列上未归档未封存的条目数(后端算的,⛔ 别拿 list_tasks 再数一遍当第二份口径)。 */
  live_items: number;
  /** 这一列**允许**删吗(480 定案)。⚠ 不是「现在能不能删」——非空还要先清空。 */
  deletable: boolean;
};

/** 全部列(含已删的),已由 core 按 `(position, id)` 排好。⛔ 前端别再排一次(0022:同键并列合法)。 */
export const loadBoardColumns = (): Promise<BoardColumn[]> => invoke<BoardColumn[]>("list_board_columns");

/**
 * 挂着产品语义、故永不可删的那两列(core 的 `board::LANDING_COLUMN` / `DONE_COLUMN`)。
 *
 * ⭐ **前端有这两个字面量是安全的,理由是 480 那条裁决**:这两列**只禁删**(可改名、可排
 * 序),id 永不消失 ⇒ 「新任务落哪儿」「进哪一列盖 done_at / 能不能入成就册」这些角色恒
 * 钉在这两个 id 上。⛔ 但别把它们扩成第二份「有哪几列」——那是 loadBoardColumns 的活。
 */
export const LANDING_COLUMN = "todo";
export const DONE_COLUMN = "done";

/**
 * 六个种子列的 canonical 名住在**本端字典**里(§7.1d)。
 *
 * ⭐ core 只答「有没有被改过名」这个布尔,canonical 串一个字都不出 core ⇒ 「三份 canonical
 * title 会漂」这个问题被消掉而不是被门禁看住。
 *
 * ⚠ 灵感那两列(`inbox`/`filed`)**刻意不在表里**:今天两端的灵感视图都不印列名(灵感是
 * 纸面的默认态)。要印那天在这里加一行 + 加一个字典键,⛔ 别改成回落到 id。
 */
const SEED_NAME: Record<string, string> = {
  todo: t("board.colTodo"),
  doing: t("board.colDoing"),
  confirming: t("board.colConfirming"),
  done: t("board.colDone"),
};

/**
 * 这一列该显示的名字。
 *
 * ⛔ **不写兜底**(铁律):没改过名却查不到 canonical = 库里有一个本端不认识的种子 id,
 * 那是损坏,响亮抛。用户自己建的列恒 `title_overridden === true`,走不到这条路。
 *
 * ⚠ **调用方只许喂任务列** —— 灵感那两列是「没改过名 ∧ 没有本端名」,喂进来就炸
 * (484 真栽:`topics.ts` 第一版把全部列 map 过去,标签视图一 load 就在第一行挂)。
 * ⛔ 别为此加回落:抛是对的,该收窄的是定义域。
 */
export function columnName(c: BoardColumn): string {
  if (c.title_overridden) return c.title;
  const canonical = SEED_NAME[c.id];
  if (canonical === undefined) throw new Error(`board column ${c.id} is canonical-named but has no local name`);
  return canonical;
}

/**
 * 看板要画的列 = **任务列** ∧ (**活着** ∨ **还扣着卡**)。
 *
 * 后半句就是 §4.3 那个只读收容区:对端删掉一列、本端正好有卡在里面 —— 列行保留、卡继续
 * 引用它。⛔ 那时**必须**把这一列画出来,否则卡就从看板上「不见了」(而它其实还在库里)。
 * 用户把卡拖走后它自然消失(下一次 load 时 live_items 归零)。
 * ⚠ 已删的列**不是拖放目标**(core 的 `is_live_task_column` 会拒)⇒ 画它的人要记得不接放。
 */
export function boardColumns(cols: BoardColumn[]): BoardColumn[] {
  return cols.filter((c) => c.kind === "task" && (!c.deleted || c.live_items > 0));
}

// ---- 写侧(B-f 第 2 段;⭐ **只有桌面有这一半** —— 安卓只做读侧,2026-08-25 用户拍板) ----
//
// ⛔ **这四条不是「前端的写命令」,是 core 那四条的搬运工**:每一道拒绝(空名 / 系统列 /
// 已删的列 / 角色列 / 非空列 / 发送端闸)都在 core 里,壳原样透传那句人话。
// ⛔ 前端**一句谓词都不许写**(plan §8.1-2:B-f 不拥有任何数据安全判定)——「按钮该不该灰」
// 的答案只有两个来源:`list_board_columns` 给的 `deletable`/`live_items`/`deleted`,
// 与下面那枚只读探针给的 `can_manage`。

/** 新建一个任务列(落在最右)。返回新列 id。 */
export const createColumn = (title: string): Promise<string> => invoke<string>("create_board_column", { title });

/** 给一列改名。⚠ 调用前先过 no-op 闸,见 column-manager.ts 里那段(英文档下的真陷阱)。 */
export const renameColumn = (id: string, title: string): Promise<void> =>
  invoke<void>("rename_board_column", { id, title });

/** 把一列落到 `prevId` 与 `nextId` 之间(null = 真·列端边界)。形同 `reorder_topic`(189)。 */
export const reorderColumn = (id: string, prevId: string | null, nextId: string | null): Promise<void> =>
  invoke<void>("reorder_board_column", { id, prevId, nextId });

/** 删一列 = 盖墓碑(行永不物理删除)。非空 / 系统列 / 角色列由 core 响亮拒。 */
export const deleteColumn = (id: string): Promise<void> => invoke<void>("delete_board_column", { id });

/** 发送端闸此刻的判词(§5)。 */
export type ColumnGate = {
  can_manage: boolean;
  /** 拒的那句人话,**core 出的原文**;放行时 null。 */
  reason: string | null;
  /** 机器可读的拒因。⛔ 前端只据它分支,别去 match 中文文案。 */
  blocked_by: "config_transition" | "peers" | null;
};

/**
 * 「现在能不能管理列」——**只读**探针。
 *
 * ⛔ **它绝不会立闩**(2026-08-25 用户拍板②:不给闩加新的置位路径):壳走的是 core 那条
 * 无副作用的 `gate::explain`,不是把写闸包一层。⚠ 它答的是**问的那一刻** —— 真正的授权
 * 永远是四条写命令自己事务里的那道闸,故上面四条该失败时照样会失败,⛔ 别把它当前置校验。
 */
export const loadColumnGate = (): Promise<ColumnGate> => invoke<ColumnGate>("board_column_gate");
