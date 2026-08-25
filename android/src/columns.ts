// 看板列的**读侧**登记处(B-f 第 1 段,手机端)。
//
// board-columns-plan 起 `items.stage` 不再是六值枚举,而是指向 `board_column` 一行的身份
// ⇒ 「有哪几列、叫什么、哪几列能落卡」全部来自库(唯一正式子 = core 的 `board::list_columns`)。
// ⛔ 本文件之外的任何模块都不许再写 `"todo"`/`"doing"`/`"confirming"`/`"done"` 这类清单。
//
// ⚠ **手机只做读侧**(2026-08-25 用户拍板,plan §8.6 四):建列 / 改名 / 排序 / 删列只在桌面。
// ⚠ 桌面那棵树另有一份同形的 `src/board-columns.ts` —— 两个前端不共享代码、字典也各一份
// (同 filter-bar 与 filter.ts 的既有形)。⛔ 判据只有一条:两份都照 `kind` / `deleted` 分。

import { t } from "./i18n";

/** 一列的当前态(与 `zhujian-mobile` 的 `BoardColumn` DTO 逐字段一致)。 */
export type BoardColumn = {
  id: string;
  /** 同步来的原文。⚠ `title_overridden === false` 时**不是**要显示的串,见 columnLabel()。 */
  title: string;
  /** `idea` | `task`。 */
  kind: string;
  system: boolean;
  /** §7.1d 的终态判据:false ⇒ 名字还是 canonical ⇒ 按 id 查本端字典。 */
  title_overridden: boolean;
  /** 已删 = 只读收容区(§4.3):卡只出不进。 */
  deleted: boolean;
  live_items: number;
  deletable: boolean;
};

// 当前空间的全部列,已由 core 按 `(position, id)` 排好。
//
// ⚠ **模块级可变态**(memory `module-state-hoisting-checklist`):它与 main.ts 的 lastItems /
// allFilterTopics 同族 —— 每一轮 refreshOnce 在**同一个 space 守卫之后**整体换掉。⛔ 别在
// 别处零散地改它,也别在切空间时留着旧空间那份(refreshOnce 与时间轴同批取、同批落)。
let columns: BoardColumn[] = [];

/** 一轮加载落定:整体替换。⛔ 不做增量合并 —— 那会造出「半个空间的列」。 */
export function setColumns(cols: BoardColumn[]): void {
  columns = cols;
}

/**
 * 挂着产品语义、故永不可删的那两列(core 的 `board::LANDING_COLUMN` / `DONE_COLUMN`)。
 *
 * ⭐ **前端有这两个字面量是安全的,理由是 480 那条裁决**:这两列**只禁删**(可改名、可排
 * 序),id 永不消失 ⇒ 「撤回为灵感只许从落点列走」「进哪一列盖 done_at / 能不能入成就册」
 * 这些角色恒钉在这两个 id 上。⛔ 但别把它们扩成第二份「有哪几列」。
 */
export const LANDING_COLUMN = "todo";
export const DONE_COLUMN = "done";

/** 六个种子列的 canonical 名住在**本端字典**里(§7.1d;core 只答「有没有被改过名」)。
 *
 *  ⚠ 灵感那两列(`inbox`/`filed`)**刻意不在表里**:灵感是纸面的默认态、不盖印
 *  (这正是 STAGE_LABEL 从来就没有它们的原因)。 */
const SEED_NAME: Record<string, string> = {
  todo: t("ui.stageTodo"),
  doing: t("ui.stageDoing"),
  confirming: t("ui.stageConfirming"),
  done: t("ui.stageDone"),
};

function nameOf(c: BoardColumn): string {
  if (c.title_overridden) return c.title;
  const canonical = SEED_NAME[c.id];
  // ⛔ 不写兜底(铁律):没改过名却查不到 canonical = 库里有本端不认识的种子 id,那是损坏。
  if (canonical === undefined) throw new Error(`board column ${c.id} is canonical-named but has no local name`);
  return canonical;
}

/** 任务面要分的那几组 = **任务列** ∧ (**活着** ∨ **还扣着卡**)。
 *
 *  后半句是 §4.3 的只读收容区:对端删了一列而本端还有卡在里面,那一列**必须**还画得出来,
 *  否则卡就从任务面上「不见了」。空组不显(146 §2.1)⇒ 卡拖光后它自然消失。 */
export const boardColumns = (): BoardColumn[] =>
  columns.filter((c) => c.kind === "task" && (!c.deleted || c.live_items > 0));

/** **能落卡**的那几列(滑动链、stage picker 的目标域):任务列 ∧ 活着。
 *  已删的列不在内 —— core 的 `is_live_task_column` 会拒,UI 不该给一条注定被拒的路。 */
export const liveTaskColumns = (): BoardColumn[] => columns.filter((c) => c.kind === "task" && !c.deleted);

/** 这个 stage 该显示的印文;**不是任务列(或列还没加载)= undefined**。
 *  ⚠ 调用方拿 undefined 当「灵感 / 不盖印」用,与从前 `STAGE_LABEL[stage]` 的语义一字不差。 */
export function stageLabel(stage: string): string | undefined {
  const c = columns.find((x) => x.id === stage);
  return c && c.kind === "task" ? nameOf(c) : undefined;
}

/** 任务态判定(与 stageLabel 同一份真相源)。 */
export const isTaskStage = (stage: string): boolean => stageLabel(stage) !== undefined;
