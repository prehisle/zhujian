// 侧栏「看板」组(multiboard-plan §6;用户拍 ④ / ⑥ / ⑨):`看板 ▾` 下面展开各块看板,
// 拖动排序(最上面那块 = 默认看板,随记「转待办」落这里),底部「+ 新建看板」,收容区非空时
// 再多一行「已删除的看板 / 列里还有 N 张卡」。
// ⭐ **渐进式披露**(用户 2026-11-11 拍,推翻 plan §6「恒展开」的字面):只有一块看板时各块与「+ 新建看板」
// 都不展开(新建入口在列管理面底部),同 411/D2 单空间时侧栏不显空间徽章;收容区那一行按数据显形,有卡就出。
//
// ⭐ 每块看板一个入口,点了 = 记住这台在看哪块(`boards.ts` setCurrentBoard,本机 UI 态)+ 切到看板视图。
// ⭐ 拖一张卡到某块看板名上 = 挪过去(落对方落点列首,用户拍 ⑥);显示条件 = 接收条件:正在看的那块不接。
// ⛔ 这里不拥有任何判定:名单、默认、死活、收容计数都是 core 给的(list_boards / list_board_columns)。
import { loadBoardColumns } from "./board-columns";
import {
  type Board,
  BOARD_ACTIVE,
  BOARD_DATA,
  type BoardData,
  BOARDS_CHANGED,
  activeBoardMark,
  boardName,
  boardsChanged,
  draggingCardId,
  holdingCount,
  liveBoards,
  loadBoards,
  moveTaskToBoard,
  reorderBoard,
  setCurrentBoard,
  setDraggingCard,
} from "./boards";
import { focusBoardView } from "./board";
import { currentSpaceId } from "./space";
import { openNewBoard } from "./board-new";
import { el, onDragTarget } from "./dom";
import { errText } from "./err";
import { t } from "./i18n";
import { toastAction, toastError } from "./toast";

type Nav = { navigate: () => void };

let host: HTMLElement | null = null;
let nav: Nav | null = null;
let seq = 0;
/** 侧栏里正在被拖着排序的那块看板(与拖卡那根轴互斥)。 */
let draggingBoard: string | null = null;

/** 挂上侧栏那一组。`navigate` = 切到看板视图(notebook 的 navigate("board"))。 */
export function initBoardNav(h: HTMLElement, n: Nav): void {
  host = h;
  nav = n;
  document.addEventListener(BOARDS_CHANGED, () => void refreshBoardNav());
  document.addEventListener(BOARD_ACTIVE, paintActive);
  document.addEventListener(BOARD_DATA, (e) => {
    const d = (e as CustomEvent<BoardData>).detail;
    if (d.space !== currentSpaceId()) return; // 切空间的窄窗里迟到的那份不画
    seq++; // 在途的那趟自取作废:这份更新
    paint(d.boards, holdingCount(d.cols));
  });
  void refreshBoardNav();
}

/** 重取重画(启动、回窗、同步落地、切空间、看板变更都走这里)。 */
export async function refreshBoardNav(): Promise<void> {
  if (!host) return;
  const mine = ++seq;
  let boards: Board[];
  let held: number;
  try {
    const [b, cols] = await Promise.all([loadBoards(), loadBoardColumns()]);
    boards = b;
    held = holdingCount(cols);
  } catch {
    // 读不到(切空间的窄窗 / 库正在换):这一组先空着,下一次刷新补上 —— 看板视图自己会把错误说出来。
    if (mine === seq) host.replaceChildren();
    return;
  }
  if (mine !== seq || !host) return;
  paint(boards, held);
}

function paint(boards: Board[], held: number): void {
  if (!host) return;
  const live = liveBoards(boards);
  expanded = live.length > 1;
  const rows: HTMLElement[] = [];
  if (expanded) {
    rows.push(...live.map((b) => item(b, live)));
    const add = el("button", { className: "bn-add", type: "button", textContent: t("bnav.add") });
    add.addEventListener("click", () => openNewBoard(() => nav?.navigate()));
    rows.push(add);
  }
  if (held > 0) {
    const h = el("button", { className: "bn-holding", type: "button", textContent: t("bnav.holding", { n: held }) });
    h.dataset.board = "holding";
    h.addEventListener("click", () => {
      focusBoardView("holding");
      nav?.navigate();
    });
    rows.push(h);
  }
  host.replaceChildren(...rows);
  paintActive();
}

/** 侧栏是否展开了各块看板(≥2 块)。展开时「看板」那一项让出高亮,只亮下面那一块(用户 2026-11-11 拍)。 */
let expanded = false;

function paintActive(): void {
  if (!host) return;
  const on = activeBoardMark();
  document.querySelector('.sidebar nav button[data-view="board"]')?.classList.toggle("sub-on", expanded && on !== null);
  for (const b of host.querySelectorAll<HTMLElement>("[data-board]")) b.classList.toggle("active", b.dataset.board === on);
}

function item(b: Board, live: Board[]): HTMLElement {
  const name = boardName(b);
  const row = el("button", { className: "bn-item", type: "button" }, [el("span", { className: "bn-name", textContent: name })]);
  row.dataset.board = b.id;
  row.title = b.is_default ? t("bnav.defaultTitle", { name }) : name;
  row.addEventListener("click", () => {
    setCurrentBoard(b.id);
    nav?.navigate();
  });

  // 拖动排序(形同列管理那套:按落点上下半算前后邻居、只写被拖那一枚)。
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    draggingBoard = b.id;
    setDraggingCard(null);
    row.classList.add("dragging");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    draggingBoard = null;
    row.classList.remove("dragging");
    clearHints();
  });
  onDragTarget(row, (e) => {
    if (draggingBoard !== null) {
      if (draggingBoard === b.id) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      clearHints();
      row.classList.add(e.clientY > r.top + r.height / 2 ? "drop-after" : "drop-before");
      return;
    }
    // 拖卡到这块看板名上:正在看的那块不接(卡本来就在它上面)。
    if (draggingCardId() !== null && activeBoardMark() !== b.id && b.landing !== null) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      clearHints();
      row.classList.add("card-hover");
    }
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after", "card-hover"));
  row.addEventListener("drop", (e) => {
    const card = draggingCardId();
    if (draggingBoard !== null && draggingBoard !== b.id) {
      e.preventDefault();
      const after = row.classList.contains("drop-after");
      const id = draggingBoard;
      clearHints();
      void dropReorder(id, b.id, after, live);
      return;
    }
    if (card !== null && activeBoardMark() !== b.id && b.landing !== null) {
      e.preventDefault();
      clearHints();
      setDraggingCard(null);
      void (async () => {
        try {
          await moveTaskToBoard(card, b.id);
        } catch (err) {
          toastError(errText(err));
          return;
        }
        toastAction(t("boards.movedTo", { board: name }));
        boardsChanged();
      })();
    }
  });
  return row;
}

function clearHints(): void {
  host?.querySelectorAll(".bn-item").forEach((x) => x.classList.remove("drop-before", "drop-after", "card-hover"));
}

async function dropReorder(dragId: string, targetId: string, after: boolean, live: Board[]): Promise<void> {
  const ids = live.map((b) => b.id);
  const sibs = ids.filter((id) => id !== dragId);
  const i = sibs.indexOf(targetId);
  if (i < 0) return;
  const prevId = after ? targetId : (sibs[i - 1] ?? null);
  const nextId = after ? (sibs[i + 1] ?? null) : targetId;
  const d = ids.indexOf(dragId);
  if ((ids[d - 1] ?? null) === prevId && (ids[d + 1] ?? null) === nextId) return; // 落回原位
  try {
    await reorderBoard(dragId, prevId, nextId);
  } catch (err) {
    toastError(errText(err));
    return;
  }
  boardsChanged();
}
