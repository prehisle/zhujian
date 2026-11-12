// 侧栏「看板」组(multiboard-plan §6;用户拍 ④ / ⑥ / ⑨):`看板 ▾` 下面展开各块看板,
// 拖动排序(最上面那块 = 默认看板,随记「转待办」落这里),底部「+ 新建看板」,收容区非空时
// 再多一行「已删除的看板 / 列里还有 N 张卡」。
// ⭐ **渐进式披露**(用户 2026-11-11 拍,推翻 plan §6「恒展开」的字面):只有一块看板时各块与「+ 新建看板」
// 都不展开(新建入口在列管理面底部),同 411/D2 单空间时侧栏不显空间徽章;收容区那一行按数据显形,有卡就出。
//
// ⭐ 每块看板一个入口,点了 = 记住这台在看哪块(`boards.ts` setCurrentBoard,本机 UI 态)+ 切到看板视图
// (看板视图已挂着就只换那一块、不整页重挂 —— notebook 那边的 reselect)。
// ⭐ 拖一张卡到某块看板名上 = 挪过去(落对方落点列首,用户拍 ⑥);显示条件 = 接收条件(R1):拖着时放得进的那几块
// 整体轻亮起,卡自己那块、落点 ⊥ 的不亮也不接。
// ⭐ 右键一块看板名 = 改名 / 管理看板 / 删除这块看板(C14;删除走列管理那条命令与前置,不空就响亮拒,种子看板不给)。
// ⭐ 展开时每块看板名右侧灰小字写卡数(C13:`open_items`,0 不写)。
// ⛔ 这里不拥有任何判定:名单、默认、死活、卡数、收容计数都是 core 给的(list_boards / list_board_columns)。
import { type BoardColumn, loadBoardColumns } from "./board-columns";
import {
  type Board,
  BOARD_ACTIVE,
  BOARD_DATA,
  type BoardData,
  BOARDS_CHANGED,
  CARD_DRAG,
  acceptsDraggingCard,
  boardName,
  boardViewLive,
  boardsChanged,
  deleteBoard,
  draggingCardId,
  activeBoardMark,
  holdingCount,
  liveBoards,
  loadBoards,
  moveTaskToBoard,
  renameBoard,
  reorderBoard,
  setCurrentBoard,
  setDraggingCard,
} from "./boards";
import { focusBoardView, focusTask } from "./board";
import { currentSpaceId } from "./space";
import { openNewBoard } from "./board-new";
import { openColumnManager } from "./column-manager";
import { confirmDialog } from "./confirm-dialog";
import { el, onDragTarget } from "./dom";
import { errText } from "./err";
import { armDismiss } from "./hotkey-menu";
import { t } from "./i18n";
import { toastAction, toastError, toastGo } from "./toast";

/** `navigate` = 把看板视图摆到眼前(notebook:已挂着就让它就地换块,否则切过去)。 */
type Nav = { navigate: () => void };

let host: HTMLElement | null = null;
let nav: Nav | null = null;
let seq = 0;
/** 侧栏里正在被拖着排序的那块看板(与拖卡那根轴互斥)。 */
let draggingBoard: string | null = null;
/** 上一次画的那份(右键「删除」要数这块看板上还有几张卡;改名收场后补画)。 */
let lastBoards: Board[] = [];
let lastCols: BoardColumn[] = [];
/** 行内改名在场:这期间来的重画先压着(否则输入框被整组 replaceChildren 掉),收场后补一次。 */
let renaming = false;
let paintPending = false;

/** 挂上侧栏那一组。 */
export function initBoardNav(h: HTMLElement, n: Nav): void {
  host = h;
  nav = n;
  // 看板视图挂着时它的 load 会经 BOARD_DATA 把新数据交过来 ⇒ 侧栏不再自己问一遍(D10:一次改动只取一趟)。
  document.addEventListener(BOARDS_CHANGED, () => {
    if (!boardViewLive()) void refreshBoardNav();
  });
  document.addEventListener(BOARD_ACTIVE, paintActive);
  document.addEventListener(CARD_DRAG, paintDropTargets);
  document.addEventListener(BOARD_DATA, (e) => {
    const d = (e as CustomEvent<BoardData>).detail;
    if (d.space !== currentSpaceId()) return; // 切空间的窄窗里迟到的那份不画
    seq++; // 在途的那趟自取作废:这份更新
    paint(d.boards, d.cols);
  });
  void refreshBoardNav();
}

/** 重取重画(启动、回窗、切空间、看板变更都走这里)。看板视图挂着时跳过:它自己的 load 会把同一份交过来。 */
export async function refreshBoardNav(): Promise<void> {
  if (!host || boardViewLive()) return;
  const mine = ++seq;
  let boards: Board[];
  let cols: BoardColumn[];
  try {
    [boards, cols] = await Promise.all([loadBoards(), loadBoardColumns()]);
  } catch {
    // 读不到(切空间的窄窗 / 库正在换):这一组先空着,下一次刷新补上 —— 看板视图自己会把错误说出来。
    if (mine === seq) host.replaceChildren();
    return;
  }
  if (mine !== seq || !host) return;
  paint(boards, cols);
}

function paint(boards: Board[], cols: BoardColumn[]): void {
  if (!host) return;
  lastBoards = boards;
  lastCols = cols;
  if (renaming) {
    paintPending = true;
    return;
  }
  const held = holdingCount(cols);
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
  // 900 C8:重画前焦点在这一组里的哪一枚(某块看板那一行 / 「+ 新建看板」)⇒ 重画后还给新那枚。此前整组
  // replaceChildren 之后焦点掉到 body(新建看板「建好」、键盘在这一组里时别处来的一次重画,都是这一形)。
  const a = document.activeElement;
  const focusKey = a instanceof HTMLElement && host.contains(a) ? (a.classList.contains("bn-add") ? ".bn-add" : a.dataset.board !== undefined ? `[data-board="${CSS.escape(a.dataset.board)}"]` : null) : null;
  host.replaceChildren(...rows);
  if (focusKey !== null) host.querySelector<HTMLElement>(focusKey)?.focus({ preventScroll: true });
  paintActive();
  paintDropTargets();
}

/** 侧栏是否展开了各块看板(≥2 块)。展开时「看板」那一项让出高亮,只亮下面那一块(用户 2026-11-11 拍)。 */
let expanded = false;

function paintActive(): void {
  if (!host) return;
  const on = activeBoardMark();
  document.querySelector('.sidebar nav button[data-view="board"]')?.classList.toggle("sub-on", expanded && on !== null);
  for (const b of host.querySelectorAll<HTMLElement>("[data-board]")) b.classList.toggle("active", b.dataset.board === on);
}

/** 拖卡途中:放得进的那几块整体轻亮(C16);收拖即摘。 */
function paintDropTargets(): void {
  if (!host) return;
  for (const row of host.querySelectorAll<HTMLElement>(".bn-item")) {
    const b = lastBoards.find((x) => x.id === row.dataset.board);
    row.classList.toggle("can-drop", b !== undefined && acceptsDraggingCard(b));
  }
}

function item(b: Board, live: Board[]): HTMLElement {
  const name = boardName(b);
  // C13(第二波):名字右侧灰小字写这块看板上还有几张没完成的卡(core `open_items`,R7 口径:不在完成列的活卡,
  // 不含收容区);0 不写。⛔ 只是展示 —— 删不删得掉看板仍由 core 现场判(askDelete)。
  const row = el("button", { className: "bn-item", type: "button" }, [
    el("span", { className: "bn-name", textContent: name }),
    ...(b.open_items > 0 ? [el("span", { className: "bn-n", textContent: String(b.open_items) })] : []),
  ]);
  row.dataset.board = b.id;
  row.title = b.is_default ? t("bnav.defaultTitle", { name }) : t("bnav.itemTitle", { name });
  row.addEventListener("click", () => {
    setCurrentBoard(b.id);
    nav?.navigate();
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openRowMenu(row, b, e);
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
    // 拖卡到这块看板名上:接收条件 = 亮起条件(acceptsDraggingCard)。
    if (acceptsDraggingCard(b)) {
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
    if (card !== null && acceptsDraggingCard(b)) {
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
        // 回执带「去看看」(同卡片 ⋯「挪到看板 ▸」那条):切到那块看板、定位这张卡。
        toastGo(t("boards.movedTo", { board: name }), t("inbox.goSee"), () => {
          setCurrentBoard(b.id);
          focusTask(card);
          nav?.navigate();
        });
        boardsChanged();
      })();
    }
  });
  return row;
}

function clearHints(): void {
  host?.querySelectorAll(".bn-item").forEach((x) => x.classList.remove("drop-before", "drop-after", "card-hover"));
}

// ---- 右键菜单(C14):改名 / 管理看板 / 删除这块看板 ------------------------------------------
// 皮用卡片 ⋯ 菜单那一身(`.hk-menu` / `.hk-item`,hotkey-menu.css);收法同卡上的选择器(armDismiss:Esc / 点别处)。

let closeMenu: (() => void) | null = null;

function openRowMenu(row: HTMLElement, b: Board, e: MouseEvent): void {
  closeMenu?.();
  const acts: { label: string; danger?: boolean; run: () => void }[] = [
    { label: t("bnav.menuRename"), run: () => startRename(row, b) },
    { label: t("bnav.menuManage"), run: () => openColumnManager({ boardId: b.id, onChanged: boardsChanged }) },
    // 种子看板永不可删(core 同拒)⇒ 不给这一项,⛔ 不摆一枚永远被拒的。
    ...(b.deletable ? [{ label: t("bnav.menuDelete"), danger: true, run: () => void askDelete(b) }] : []),
  ];
  const menu = el("div", { className: "hk-menu bn-menu" });
  menu.setAttribute("role", "menu");
  for (const a of acts) {
    const it = el("button", { className: a.danger ? "hk-item danger" : "hk-item", type: "button" }, [
      el("span", { className: "hk-label", textContent: a.label }),
    ]);
    it.setAttribute("role", "menuitem");
    it.addEventListener("click", () => {
      // 900 C8:先把焦点还给这一行再跑 —— 随后打开的面板(管理看板 / 删除确认)记它为 opener,关掉时还得回来;
      // 改名那一项自己会把焦点带进输入框。此前菜单项一摘焦点就在 body 上,面板关掉后无处可还。
      close(true);
      a.run();
    });
    menu.append(it);
  }
  menu.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".hk-item")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  });
  document.body.append(menu);
  // 键盘开的(菜单键 / Shift+F10)没有指针坐标 ⇒ 贴着这一行下沿开。
  const r = row.getBoundingClientRect();
  const keyOpened = e.clientX === 0 && e.clientY === 0;
  const x = keyOpened ? r.left + 12 : e.clientX;
  const y = keyOpened ? r.bottom : e.clientY;
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - m.width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - m.height - 6)}px`;
  const teardown = armDismiss(menu, () => close(true));
  function close(refocus: boolean): void {
    teardown();
    menu.remove();
    closeMenu = null;
    if (refocus && row.isConnected) row.focus({ preventScroll: true }); // 关完焦点还给打开它的那一行
  }
  closeMenu = () => close(false);
  menu.querySelector<HTMLButtonElement>(".hk-item")?.focus({ preventScroll: true });
}

/** 行内改名:这一行原地换成一枚输入框。回车 / 点别处 = 存,Esc = 不改。no-op 闸同列管理(比显示名,
 *  别把本端字典里的种子名写进库)。 */
function startRename(row: HTMLElement, b: Board): void {
  if (!row.isConnected) return;
  const shown = boardName(b);
  const input = el("input", { className: "bn-rename", type: "text", value: shown });
  input.setAttribute("aria-label", t("bnav.menuRename"));
  renaming = true;
  row.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    renaming = false;
    if (input.isConnected) input.replaceWith(row);
    if (paintPending) {
      paintPending = false;
      paint(lastBoards, lastCols);
    }
  };
  const commit = async (fromBlur: boolean): Promise<void> => {
    if (done) return;
    const next = input.value.trim();
    if (next === "") {
      // 回车时说清;点别处时清空了名字 = 不改(别把焦点硬拽回来)。
      if (fromBlur) finish();
      else toastError(t("cols.emptyBoardName"));
      return;
    }
    if (next === shown) {
      finish();
      return;
    }
    try {
      await renameBoard(b.id, next);
    } catch (err) {
      toastError(errText(err));
      finish();
      return;
    }
    finish();
    boardsChanged();
  };
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void commit(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
      if (row.isConnected) row.focus({ preventScroll: true });
    }
  });
  input.addEventListener("blur", () => void commit(true));
}

/** 删这块看板:走列管理那条命令与前置。上面还有卡 ⇒ 响亮拒(说还剩几张,同列管理那句);空了再问一次。 */
async function askDelete(b: Board): Promise<void> {
  // 现取一份:侧栏手上那份可能旧了(别的设备刚往这块放了卡)。core 照样会在写事务里再查一遍。
  let cols: BoardColumn[];
  try {
    cols = await loadBoardColumns();
  } catch (err) {
    toastError(errText(err));
    return;
  }
  const n = cols.filter((c) => c.kind === "task" && c.board_id === b.id).reduce((s, c) => s + c.live_items, 0);
  if (n > 0) {
    toastError(t("cols.deleteBoardBlocked", { n }));
    return;
  }
  const name = boardName(b);
  const yes = await confirmDialog({
    title: t("bnav.deleteQ", { name }),
    body: t("bnav.deleteBody"),
    ok: t("cols.deleteYes"),
    cancel: t("cols.cancel"),
    focus: "cancel",
    returnFocusOnOk: false,
    panelClass: "bn-delete-ask",
  });
  if (!yes) return;
  try {
    await deleteBoard(b.id);
  } catch (err) {
    toastError(errText(err)); // core 的人话原样说(并发里刚有卡挪进来等)
    return;
  }
  toastAction(t("bnav.deleted", { name }));
  boardsChanged();
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
