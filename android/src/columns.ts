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
// (同 filter-bar 与 filter.ts 的既有形)。⛔ 判据只有一条:都照 core 给的 `accepts_cards` / `held` /
// `landing` / `done` 分(mbopt E24:「活列」「收容区」两条规则 core 解析好了给,前端⛔ 别再拿 `kind` / `deleted` /
// `board_deleted` 自己拼)。

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
  /** core 解析:卡此刻能不能落进这一列(活任务列 ∧ 看板活着)。看板上画哪几列、卡能换到哪几列只看它。灵感列恒 false。 */
  accepts_cards: boolean;
  /** core 解析:这一列上的活卡属收容区(任务列 ∧ (列已删 ∨ 看板已删);判列不判有没有卡)。灵感列恒 false。
   *  ⭐ 任务列里 `accepts_cards` 与 `held` 恰好一真一假(两处不重不漏)。 */
  held: boolean;
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
  /** 这块看板**活列**上的活卡数(⚠ 不含收容区的卡;已删看板恒 0)。⛔ 别拿它推「删看板合不合法」—— 那由 core 命令现场判。 */
  live_items: number;
  /** 其中不在完成列里的(没有完成列 = 全部活卡)—— 切换排上看板名旁那个数(mbopt C13 / R7)。 */
  open_items: number;
};

// 当前空间的全部列 / 全部看板,已由 core 按 `(position, id)` 排好。
//
// ⚠ **模块级可变态**(memory `module-state-hoisting-checklist`):它与 main.ts 的 lastItems /
// allFilterTopics 同族 —— 每一轮 refreshOnce 在**同一个 space 守卫之后**整体换掉。⛔ 别在
// 别处零散地改它,也别在切空间时留着旧空间那份(refreshOnce 与时间轴同批取、同批落)。
let columns: BoardColumn[] = [];
let boards: Board[] = [];
// id → 行(mbopt M14):一次重画里每张卡要问四五回「这一列是谁 / 属于哪块看板」,逐次 `find` 是 O(列数) × 卡数。
// 与上面两份同批换(只在 setColumns / setBoards 里建),⛔ 别在别处单改其一。
let colById = new Map<string, BoardColumn>();
let boardById = new Map<string, Board>();

/** 一轮加载落定:整体替换。⛔ 不做增量合并 —— 那会造出「半个空间的列」。 */
export function setColumns(cols: BoardColumn[]): void {
  columns = cols;
  colById = new Map(cols.map((c) => [c.id, c]));
}

/** 同 setColumns:看板与列要同一轮落(main.ts refreshOnce 同批取)。切空间时清成 []。 */
export function setBoards(bs: Board[]): void {
  boards = bs;
  boardById = new Map(bs.map((b) => [b.id, b]));
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

/** 活看板(切换条),保持 core 给的顺序。 */
export const liveBoards = (): Board[] => boards.filter((b) => !b.deleted);

/** 放得进卡的活看板(「挪到看板 ▸」「放进看板 ▸」的候选,mbopt R1:显示条件 = 接收条件)。
 *  落点 ⊥(core 解析:这块看板只剩完成列 / 一列都没有)的那块不列 —— 点了 core 也是响亮拒。 */
export const landableBoards = (): Board[] => liveBoards().filter((b) => b.landing !== null);

/** 默认看板(活看板里排最前那块;种子不可删 ⇒ 恒有)。缺了是 core 契约断了,响亮抛。 */
export function defaultBoard(): Board {
  const d = boards.find((b) => !b.deleted && b.is_default);
  if (!d) throw new Error("no live default board");
  return d;
}

/** 这一列属于哪块看板(灵感列 / 不认识的 stage = undefined)。 */
export function boardOfStage(stage: string): Board | undefined {
  const c = colById.get(stage);
  if (!c || c.board_id === null) return undefined;
  return boardById.get(c.board_id);
}

/** 这个 stage 的卡在收容区里吗(plan §3a;只出不进:没有勾、没有换列、只能「挪到看板」)。
 *  判据 = core 的 `held`(mbopt E24)。⚠ 不看还有没有卡 —— 判的是「这张卡在不在收容区」。 */
export const isHeldStage = (stage: string): boolean => colById.get(stage)?.held === true;

/** 收容区的列:`held` 且还扣着活卡的那几列(空了就不显,同桌面 holdingColumns;mbopt E24 / plan §3a)。 */
export const holdingColumns = (): BoardColumn[] => columns.filter((c) => c.held && c.live_items > 0);

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
  const hit = saved === null ? undefined : boardById.get(saved);
  if (hit && !hit.deleted) return hit;
  // 种子看板不可删 ⇒ 活看板恒非空、恒有一块是默认(defaultBoard 缺了就响亮抛)。
  return defaultBoard();
}

/** 一个「正看着的」的身份串(活看板 id 或 `HOLDING`):比较「换没换看板」、按看板记横滚位置用。 */
export const viewId = (v: Board | typeof HOLDING): string => (v === HOLDING ? HOLDING : v.id);

export function setCurrentView(space: string, id: string): void {
  localStorage.setItem(curKey(space), id);
}

/** 切换条要不要出(渐进式披露,plan §6 末 ①):活看板 ≥ 2 块,或收容区里有卡。 */
export const switcherShown = (): boolean => liveBoards().length >= 2 || holdingCount() > 0;

// ---- 任务面按当前看板分组 -----------------------------------------------------------

/** 任务面要分的那几组:那块看板上 `accepts_cards` 的列(core 解析的活任务列);看着收容区时 = 收容区的列。
 *  ⚠ 0043 起删掉的列(哪怕看板还活着)不再作为只读列留在看板上,统一进收容区(plan §3a;它的 `held` 为真、`accepts_cards` 为假)。
 *  `v` 由调用方解析一次传进来(mbopt M14:一次重画只读一次 localStorage,见 main.ts projectTimeline)。 */
export function boardColumns(v: Board | typeof HOLDING): BoardColumn[] {
  if (v === HOLDING) return holdingColumns();
  return columns.filter((c) => c.board_id === v.id && c.accepts_cards);
}

/** 这张卡能被换到哪几列(状态 picker、横滑链):它**自己那块活看板**上 `accepts_cards` 的列;收容区里的卡 = 空(只能挪出)。
 *  已删的列不在内 —— core 的 `is_live_task_column` 会拒,UI 不该给一条注定被拒的路(执行仍由 core 现场校验)。 */
export function liveColumnsOf(stage: string): BoardColumn[] {
  if (isHeldStage(stage)) return [];
  const c = colById.get(stage);
  if (!c || c.board_id === null) return []; // 灵感列 / 不认识的 stage:不在任何看板上
  return columns.filter((x) => x.board_id === c.board_id && x.accepts_cards);
}

/** 这个 stage 该显示的印文;**不是任务列(或列还没加载)= undefined**。
 *  ⚠ 调用方拿 undefined 当「灵感 / 不盖印」用,与从前 `STAGE_LABEL[stage]` 的语义一字不差。 */
export function stageLabel(stage: string): string | undefined {
  const c = colById.get(stage);
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
