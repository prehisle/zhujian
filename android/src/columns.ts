// 看板与看板列的**读侧**登记处(B-f 第 1 段起管列;0043 第 4 段起连看板一起管,手机端)。
//
// board-columns-plan 起 `items.stage` 不再是六值枚举,而是指向 `board_column` 一行的身份
// ⇒ 「有哪几列、叫什么、哪几列能落卡」全部来自库(唯一正式子 = core 的 `board::list_columns`)。
// multiboard-plan(0043)起一个空间有多块看板,「新卡落点」与「完成」是**每块看板自己的两根指针**,
// 由 core 解析好放在 `board::list_boards` 的 `landing` / `done` 里 ⇒ 本文件只读那两格。
// ⛔ 本文件之外的任何模块都不许再写 `"todo"`/`"doing"`/`"confirming"`/`"done"` 这类清单,
//    也别拿列 id 字面量判「是不是完成 / 落点」(plan §1 不变量 3)。
//
// ⚠ **手机只做读侧 + 切看板 + 挪卡**(用户拍 ⑩;board-columns §8.6 四):建 / 删看板、改列、指定角色只在桌面。
// ⚠ 桌面那棵树另有同形的 `src/board-columns.ts` / `src/boards.ts` —— 两个前端不共享代码、字典也各一份
// (同 filter-bar 与 filter.ts 的既有形)。⛔ 判据只有一条:都照 core 给的 `kind` / `deleted` /
// `board_deleted` / `landing` / `done` 分。

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
  /** 已删:还扣着卡的话住收容区(multiboard-plan §3a),卡只出不进。 */
  deleted: boolean;
  live_items: number;
  deletable: boolean;
  /** 0043:属于哪块看板(灵感两列 null)。 */
  board_id: string | null;
  /** 0043:所在看板已删 ⇒ 这一列住收容区。 */
  board_deleted: boolean;
};

/** 一块看板的当前态(与壳的 `Board` DTO 逐字段一致)。 */
export type Board = {
  id: string;
  /** 同步来的原文。⚠ `title_overridden === false` 时按本端字典显示,见 boardName()。 */
  title: string;
  title_overridden: boolean;
  /** core 解析后的落点;null = 这块看板放不进卡。 */
  landing: string | null;
  /** core 解析后的完成列;null = 纯分类(没有「完成」、没有成就归档)。 */
  done: string | null;
  deleted: boolean;
  /** 默认看板 = 活看板里排最前那块(随记「转待办」落这里)。 */
  is_default: boolean;
  deletable: boolean;
};

// 当前空间的全部列 / 全部看板,已由 core 按 `(position, id)` 排好。
//
// ⚠ **模块级可变态**(memory `module-state-hoisting-checklist`):它与 main.ts 的 lastItems /
// allFilterTopics 同族 —— 每一轮 refreshOnce 在**同一个 space 守卫之后**整体换掉。⛔ 别在
// 别处零散地改它,也别在切空间时留着旧空间那份(refreshOnce 与时间轴同批取、同批落)。
let columns: BoardColumn[] = [];
let boards: Board[] = [];

/** 一轮加载落定:整体替换。⛔ 不做增量合并 —— 那会造出「半个空间的列」。 */
export function setColumns(cols: BoardColumn[]): void {
  columns = cols;
}

/** 同 setColumns:看板与列要同一轮落(main.ts refreshOnce 同批取)。切空间时清成 []。 */
export function setBoards(bs: Board[]): void {
  boards = bs;
}

/** 六个种子列的 canonical 名住在**本端字典**里(§7.1d;core 只答「有没有被改过名」)。
 *
 *  ⚠ 灵感那两列(`inbox`/`filed`)**刻意不在表里**:灵感是纸面的默认态、不盖印
 *  (这正是 STAGE_LABEL 从来就没有它们的原因)。
 *  ⭐ 这里的 id 只用来**查名字**,⛔ 不判角色(角色看 Board 的 landing / done)。 */
const SEED_NAME: Record<string, string> = {
  todo: t("ui.stageTodo"),
  doing: t("ui.stageDoing"),
  confirming: t("ui.stageConfirming"),
  done: t("ui.stageDone"),
};

/** 种子看板的 id(core `board::SEED_BOARD`)。⛔ 只用来查本端字典的显示名,别拿它判角色。 */
const SEED_BOARD = "tasks";

function nameOf(c: BoardColumn): string {
  if (c.title_overridden) return c.title;
  const canonical = SEED_NAME[c.id];
  // ⛔ 不写兜底(铁律):没改过名却查不到 canonical = 库里有本端不认识的种子 id,那是损坏。
  if (canonical === undefined) throw new Error(`board column ${c.id} is canonical-named but has no local name`);
  return canonical;
}

/** 看板显示名。种子看板没改过名 ⇒ 本端字典(同种子列 §7.1d);⛔ 不写兜底,查不到是损坏。 */
export function boardName(b: Board): string {
  if (b.title_overridden) return b.title;
  if (b.id === SEED_BOARD) return t("boards.seedName");
  throw new Error(`board ${b.id} is canonical-named but has no local name`);
}

/** 全部看板(含已删,归档册按看板筛要认得删掉那块的来处),保持 core 给的顺序。 */
export const allBoards = (): Board[] => boards;

/** 活看板(切换条、挪到看板的候选),保持 core 给的顺序。 */
export const liveBoards = (): Board[] => boards.filter((b) => !b.deleted);

/** 这一列属于哪块看板(灵感列 / 不认识的 stage = undefined)。 */
export function boardOfStage(stage: string): Board | undefined {
  const c = columns.find((x) => x.id === stage);
  if (!c || c.board_id === null) return undefined;
  return boards.find((b) => b.id === c.board_id);
}

/** 这一列在收容区里吗(plan §3a):任务列 ∧ (列已删 ∨ 看板已删)。⚠ 不看还有没有卡 —— 判的是「这张卡在不在收容区」。 */
function heldColumn(c: BoardColumn): boolean {
  return c.kind === "task" && (c.deleted || c.board_deleted);
}

/** 这个 stage 的卡在收容区里吗(只出不进:没有勾、没有换列、只能「挪到看板」)。 */
export const isHeldStage = (stage: string): boolean => {
  const c = columns.find((x) => x.id === stage);
  return c !== undefined && heldColumn(c);
};

/** 收容区的列:还扣着活卡的那几列(空了就不显,同桌面 holdingColumns)。 */
export const holdingColumns = (): BoardColumn[] => columns.filter((c) => heldColumn(c) && c.live_items > 0);

/** 收容区里一共几张卡(切换条那一格的 N)。 */
export const holdingCount = (): number => holdingColumns().reduce((n, c) => n + c.live_items, 0);

/** 「这张卡完成了没有」的唯一读法:它所在的**活**看板解析后的完成列就是它(到期汇总、勾、灰章)。
 *  收容区里的卡不算完成(看板已删 ⇒ 没有完成角色;列已删 ⇒ 不是完成列)。 */
export function isDoneStage(stage: string): boolean {
  if (isHeldStage(stage)) return false;
  const b = boardOfStage(stage);
  return b !== undefined && !b.deleted && b.done === stage;
}

/** 这张卡所在看板的落点列(撤回为随记只许从它走;取消勾 = 点回它)。收容区 / 放不进卡 = null。 */
export function landingOfStage(stage: string): string | null {
  if (isHeldStage(stage)) return null;
  const b = boardOfStage(stage);
  return b && !b.deleted ? b.landing : null;
}

/** 这张卡所在看板有完成列吗(有才出勾;纯分类看板没有「完成」)。 */
export function boardHasDone(stage: string): boolean {
  if (isHeldStage(stage)) return false;
  const b = boardOfStage(stage);
  return b !== undefined && !b.deleted && b.done !== null;
}

// ---- 当前看板(本机 UI 态,不同步) ----------------------------------------------------
// 「现在看的是哪块看板」是**这台屏幕怎么看**的属性(同桌面 boards.ts):存 localStorage、按空间各记一份、
// ⛔ 不进同步。记着的那块不在了(删了 / 别的空间)就回到默认看板 —— 不是静默兜底,是「这台还没选过 /
// 选过的已经没了」。`HOLDING` = 正看着收容区(它空了也回默认看板:空收容区不画)。

export const HOLDING = "@holding";
const curKey = (space: string): string => `zhujian.board-current.${space}`;

/** 这台在这个空间里正看着的:一块活看板,或收容区(`HOLDING`)。 */
export function currentView(space: string): Board | typeof HOLDING {
  const saved = localStorage.getItem(curKey(space));
  if (saved === HOLDING && holdingCount() > 0) return HOLDING;
  const live = liveBoards();
  const hit = live.find((b) => b.id === saved);
  if (hit) return hit;
  const dflt = live.find((b) => b.is_default);
  // 种子看板不可删 ⇒ 活看板恒非空、恒有一块是默认。缺了是 core 契约断了,响亮抛。
  if (!dflt) throw new Error("no live default board");
  return dflt;
}

export function setCurrentView(space: string, id: string): void {
  localStorage.setItem(curKey(space), id);
}

/** 切换条要不要出(渐进式披露,plan §6 末 ①):活看板 ≥ 2 块,或收容区里有卡。 */
export const switcherShown = (): boolean => liveBoards().length >= 2 || holdingCount() > 0;

// ---- 任务面按当前看板分组 -----------------------------------------------------------

/** 任务面要分的那几组:当前看板的活任务列;看着收容区时 = 收容区的列。
 *  ⚠ 0043 起删掉的列(哪怕看板还活着)不再作为只读列留在看板上,统一进收容区(plan §3a)。 */
export function boardColumns(space: string): BoardColumn[] {
  const v = currentView(space);
  if (v === HOLDING) return holdingColumns();
  return columns.filter((c) => c.kind === "task" && c.board_id === v.id && !c.deleted && !c.board_deleted);
}

/** 这张卡能被换到哪几列(状态 picker、横滑链):它**自己那块活看板**的活任务列;收容区里的卡 = 空(只能挪出)。
 *  已删的列不在内 —— core 的 `is_live_task_column` 会拒,UI 不该给一条注定被拒的路。 */
export function liveColumnsOf(stage: string): BoardColumn[] {
  if (isHeldStage(stage)) return [];
  const c = columns.find((x) => x.id === stage);
  if (!c || c.kind !== "task" || c.board_id === null) return [];
  return columns.filter((x) => x.kind === "task" && x.board_id === c.board_id && !x.deleted && !x.board_deleted);
}

/** 这个 stage 该显示的印文;**不是任务列(或列还没加载)= undefined**。
 *  ⚠ 调用方拿 undefined 当「灵感 / 不盖印」用,与从前 `STAGE_LABEL[stage]` 的语义一字不差。 */
export function stageLabel(stage: string): string | undefined {
  const c = columns.find((x) => x.id === stage);
  return c && c.kind === "task" ? nameOf(c) : undefined;
}

/** 收容区那一组的节头:「看板」· 列名(看板查不到就只给列名,同桌面 holdingFrom)。 */
export function holdingLabel(stage: string): string {
  const col = stageLabel(stage)!;
  const b = boardOfStage(stage);
  return b ? t("boards.holdingFrom", { board: boardName(b), col }) : col;
}

/** 任务态判定(与 stageLabel 同一份真相源)。 */
export const isTaskStage = (stage: string): boolean => stageLabel(stage) !== undefined;
