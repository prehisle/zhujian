// 多看板的**读侧共享件 + 桌面写侧搬运**(multiboard-plan §6;第 3 段)。
//
// ⭐ 角色(落点 / 完成列)、默认看板、死活**全由 core 解析**(`board::list_boards` 的 `landing` /
// `done` / `is_default` / `deleted`)⇒ 前端只读这几格,⛔ 别在这里另算一份(plan §4 末行)。
// 写命令的每道拒绝都是 core 出的人话,原样透传。
//
// 「现在看的是哪块看板」是**这台屏幕怎么看**的属性(同 last-view / 排序轴):存 localStorage、
// 按空间各记一份、⛔ 不进同步。记着的那块不在了(删了 / 别的空间)就回到默认看板 —— 那不是静默
// 兜底,是「这台还没选过 / 选过的已经没了」。
import { currentSpaceId, invoke } from "./space";
import { t } from "./i18n";
import type { BoardColumn } from "./board-columns";

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
  /** 种子看板不可删。 */
  deletable: boolean;
};

/** 种子看板的 id(core `board::SEED_BOARD`)。⛔ 只用来查本端字典的显示名,别拿它判角色。 */
const SEED_BOARD = "tasks";

/** 全部看板(含已删的,收容区靠它说来处),core 已按 `(position, id)` 排好。 */
export const loadBoards = (): Promise<Board[]> => invoke<Board[]>("list_boards");

/** 显示名。种子看板没改过名 ⇒ 本端字典(同种子列 §7.1d);⛔ 不写兜底,查不到是损坏。 */
export function boardName(b: Board): string {
  if (b.title_overridden) return b.title;
  if (b.id === SEED_BOARD) return t("boards.seedName");
  throw new Error(`board ${b.id} is canonical-named but has no local name`);
}

/** 活看板(侧栏、挪到看板的候选),保持 core 给的顺序。 */
export const liveBoards = (boards: Board[]): Board[] => boards.filter((b) => !b.deleted);

/** 全部活看板解析后的完成列 —— 「这张卡完成了没有」的唯一读法(到期汇总、灰章、导出的 [x])。 */
export function doneColumnSet(boards: Board[]): Set<string> {
  return new Set(liveBoards(boards).flatMap((b) => (b.done ? [b.done] : [])));
}

/** 收容区的列(plan §3a):任务列 ∧ (列已删 ∨ 看板已删) ∧ 还扣着活卡。 */
export function holdingColumns(cols: BoardColumn[]): BoardColumn[] {
  return cols.filter((c) => c.kind === "task" && (c.deleted || c.board_deleted) && c.live_items > 0);
}

/** 收容区里一共几张卡(侧栏那一行的 N)。 */
export const holdingCount = (cols: BoardColumn[]): number =>
  holdingColumns(cols).reduce((n, c) => n + c.live_items, 0);

// ---- 当前看板(本机 UI 态,不同步) ----------------------------------------------------

const curKey = (space: string): string => `zhujian.board-current.${space}`;

/** 这台在这个空间里正看着的那块:记着的那块还活着就是它,否则默认看板。 */
export function currentBoard(boards: Board[], space = currentSpaceId()): Board {
  const live = liveBoards(boards);
  const saved = localStorage.getItem(curKey(space));
  const hit = live.find((b) => b.id === saved);
  if (hit) return hit;
  const dflt = live.find((b) => b.is_default);
  // 种子看板不可删 ⇒ 活看板恒非空、恒有一块是默认。缺了是 core 契约断了,响亮抛。
  if (!dflt) throw new Error("no live default board");
  return dflt;
}

export function setCurrentBoard(id: string, space = currentSpaceId()): void {
  localStorage.setItem(curKey(space), id);
}

// ---- 变更广播 ---------------------------------------------------------------------------
// 看板 / 列 / 卡跨看板挪动之后,侧栏(看板名单、收容计数)与看板视图都要重取。两处互不 import,
// 走一枚文档事件。⛔ 别拿它传数据:收到的人自己重取(core 是唯一真相)。
export const BOARDS_CHANGED = "zhujian:boards-changed";
export function boardsChanged(): void {
  document.dispatchEvent(new CustomEvent(BOARDS_CHANGED));
}

// 看板视图告诉侧栏「此刻在看哪块」(看板 id / 收容区 / null = 不在看板视图),侧栏据此点亮那一行。
export const BOARD_ACTIVE = "zhujian:board-active";
let active: string | null = null;
export function markActiveBoard(id: string | null): void {
  if (id === active) return;
  active = id;
  document.dispatchEvent(new CustomEvent(BOARD_ACTIVE));
}
export const activeBoardMark = (): string | null => active;

// 看板视图每次取完数据把那两份交给侧栏(收容计数会因还原 / 取消归档 / 挪卡而变,侧栏不必再问一遍)。
// ⛔ 只许交**同一空间**刚取到的快照(看板视图按 mountSpace 守着)。
export const BOARD_DATA = "zhujian:board-data";
export type BoardData = { space: string; boards: Board[]; cols: BoardColumn[] };
export function shareBoardData(d: BoardData): void {
  document.dispatchEvent(new CustomEvent<BoardData>(BOARD_DATA, { detail: d }));
}

// ---- 拖卡到侧栏看板名(用户拍 ⑥) ------------------------------------------------------
// 看板视图拖起一张卡时登记它的 id,侧栏看板名据此决定接不接放(显示条件 = 接收条件)。
let draggingCard: string | null = null;
export const setDraggingCard = (id: string | null): void => {
  draggingCard = id;
};
export const draggingCardId = (): string | null => draggingCard;

// ---- 写侧(纯桌面;每道拒绝由 core 出) ---------------------------------------------------

/** 建看板连同初始列;`doneIndex` = 哪一列是完成列(null = 纯分类)。返回新看板 id。 */
export const createBoard = (title: string, columns: string[], doneIndex: number | null): Promise<string> =>
  invoke<string>("create_board", { title, columns, doneIndex });
export const renameBoard = (id: string, title: string): Promise<void> => invoke<void>("rename_board", { id, title });
export const reorderBoard = (id: string, prevId: string | null, nextId: string | null): Promise<void> =>
  invoke<void>("reorder_board", { id, prevId, nextId });
export const setBoardLanding = (id: string, column: string): Promise<void> =>
  invoke<void>("set_board_landing", { id, column });
/** `column = null` = 取消完成列(看板变纯分类)。 */
export const setBoardDone = (id: string, column: string | null): Promise<void> =>
  invoke<void>("set_board_done", { id, column });
export const deleteBoard = (id: string): Promise<void> => invoke<void>("delete_board", { id });
/** 跨看板挪卡:落对方落点列首。 */
export const moveTaskToBoard = (id: string, boardId: string): Promise<void> =>
  invoke<void>("move_task_to_board", { id, boardId });
