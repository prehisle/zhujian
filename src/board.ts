import {
  type MoveResult,
  type SpaceInfo,
  currentSpaceId,
  distinctSpaceLabels,
  invoke,
  listSpaces,
  moveItemToSpace,
  moveOutcomeText,
  movePartialClear,
  movePartialMark,
  movePartialNote,
  spaceLabel,
} from "./space";
import { autoGrow } from "./autogrow";
import { createComposeController } from "./compose-controller";
import { copyButton, copyText } from "./clipboard";
import { toastAction } from "./toast";
import { buildItemDeepLink } from "./deeplink";
import { armLocate } from "./locate";
import {
  type FilterState,
  type TimeBucket,
  applyFilter,
  applyTimeFilter,
  filterActive,
  reconcileKindFilter,
  reconcileTopicFilter,
  renderFilterPills,
  renderKindPills,
  renderTimePills,
  selectedTopicLabels,
  soleTopicFilter,
  wireFilterInput,
} from "./filter-bar";
import {
  type BoardColumn,
  DONE_COLUMN,
  LANDING_COLUMN,
  boardColumns,
  columnName,
  loadBoardColumns,
} from "./board-columns";
import { type Act, SATELLITE_LAYERS, armDismiss, createHotkeyController, registerViewKeys } from "./hotkey-menu";
import {
  type ImageMeta,
  REPASTE_HINT,
  imageStrip,
  listImages,
  renderContent,
  wirePasteToAttach,
} from "./item-images";
import {
  closeComments,
  commentBadge,
  loadCommentCounts,
  openComments,
  refreshOpenComments,
} from "./item-comments";
import type { View, ViewCtx } from "./notebook";
import { applyTagColor } from "./tag-color";
import { renderTagPicker } from "./tag-picker";
import { type TaskItem, dayKey, dayLabel, dueState, localToday, metaRow, startOfWeek } from "./tasktime";
import { identitySig, loadIdentity, signatureChip } from "./identity";
import { t } from "./i18n";
import "./board.css";

// 跨视图「跳到这张任务卡」通道(搜索命中任务 → 跳看板并高亮)。模块级——
// 发起方先 focusTask(id) 再 navigate("board")。看板 load() 里、**seq 守卫之后**(确认是
// 最新那一发)才消费它:命中卡给一记朱砂脉冲(复用 pulseId)并滚到视野中央;陈旧/离场的
// load 不碰它,离开看板时 unmount 清掉。用完即清,后续刷新不重放。
let focusId: string | null = null;
export function focusTask(id: string): void {
  focusId = id;
}

// 跨视图「落在哪个子视图」通道(ui-audit P1 #8:搜索命中回收站/归档的任务 → 直达对应
// 列表)。boardView 本身刻意 mount 级(transient peek),这里只是「下一次 mount 的落点」
// 请求:mount 时消费、用完即清,后续正常 mount 仍落看板。
let pendingView: BoardView | null = null;
export function focusBoardView(v: BoardView): void {
  pendingView = v;
}

// 看板的列。**B-f 第 1 段起从库里来**(board-columns-plan:`items.stage` 指向 `board_column`
// 一行的身份,列可改名 / 排序 / 增删)⇒ ⛔ 这里不再有四值字面量,取法与「画哪几列」的判据
// 都在共享件 `board-columns.ts`。手工工具照旧:没有 AI「建议」列,新任务恒生在落点列
// (`LANDING_COLUMN`),此后随手拖。'待确认' 仍只是 进行中 与 已完成 之间的可选停靠位。

// ---- small DOM helper (same shape as inbox.ts) ------------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

const btn = (label: string, kind: string, onclick: () => void) =>
  el("button", { className: `act ${kind}`, textContent: label, onclick });

// ---- 一键复制为 Markdown ----------------------------------------------------
// One task → one bullet. A card in the 完成 column is a checked item, every other
// column unchecked (a Markdown task list has only those two marks — the column a card
// sits under is the状态). A multi-line title is collapsed to one line so it stays one bullet.
function mdLine(item: TaskItem, status: string): string {
  const box = status === DONE_COLUMN ? "[x]" : "[ ]";
  return `- ${box} ${item.title.replace(/\s*\n\s*/g, " ").trim()}`;
}
function columnMarkdown(name: string, status: string, items: TaskItem[]): string {
  return [`## ${name}`, ...items.map((t) => mdLine(t, status))].join("\n");
}
// The whole board: each non-empty column in board order, blank line between.
function boardMarkdown(cols: BoardColumn[], items: TaskItem[]): string {
  return cols
    .map((c) => ({ name: columnName(c), status: c.id, inCol: items.filter((t) => t.status === c.id) }))
    .filter((c) => c.inCol.length > 0)
    .map((c) => columnMarkdown(c.name, c.status, c.inCol))
    .join("\n\n");
}

const SKELETON = `
  <header data-tauri-drag-region>
    <h1>${t("board.title")}</h1>
    <span class="spacer" data-tauri-drag-region></span>
    <button class="hbtn" id="add-task" type="button" title="${t("board.newTask")}">+ <span class="lbl">${t("board.newTask")}</span> <kbd class="k">N</kbd></button>
    <span class="copy-slot" id="copy-slot"></span>
    <span class="head-tools">
      <button class="hbtn" id="seal-toggle" title="${t("board.sealTitle")}"><span class="lbl">${t("board.sealLbl")}</span><span class="tn" id="seal-n">0</span> <kbd class="k">G</kbd></button>
      <button class="hbtn" id="trash-toggle" title="${t("board.trashTitle")}"><span class="lbl">${t("board.trashLbl")}</span><span class="tn" id="trash-n">0</span> <kbd class="k">R</kbd></button>
    </span>
  </header>
  <div class="compose" id="compose" hidden>
    <textarea class="compose-input" id="compose-input" rows="1" placeholder="${t("board.composePlaceholder")}"></textarea>
    <button class="compose-add" id="compose-add" type="button">${t("board.composeAdd")}</button>
    <button class="compose-close" id="compose-close" type="button">${t("board.composeDone")}</button>
    <span class="compose-err" id="compose-err"></span>
  </div>
  <div class="filter-row" id="filter-row" hidden>
    <div class="kind-filter" id="kind-filter"></div>
    <div class="time-filter" id="time-filter"></div>
    <div class="filter-main">
      <div class="topic-filter" id="topic-filter"></div>
      <input class="filter-text" id="board-filter" type="search" placeholder="${t("board.filterPlaceholder")}" autocomplete="off" spellcheck="false" />
    </div>
  </div>
  <div class="op-err" id="op-err" hidden>
    <span class="op-err-msg" id="op-err-msg"></span>
    <button class="act ghost" id="op-err-x" type="button">${t("board.gotIt")}</button>
  </div>
  <main id="board"></main>
`;

// One topic, for the filter bar and the per-card topic picker. `color` (`#RRGGBB` or
// null) tints the filter pill's dot so categories read at a glance. `kind`(自由文本
// 类型,0031)或 null = 无类型 —— 类型轴 pill 行(renderKindPills)据它分组。
type TopicOpt = { id: string; title: string; color: string | null; kind: string | null };

// 删除确认偏好 (a UI-only preference, kept in localStorage — not product data, so
// it never participates in any DB invariant). Missing/unreadable → the safe default
// is "show the confirm". Writing is fail-soft: if it can't persist we don't pretend
// it did, and the confirm simply keeps appearing next time (the honest fallback).
const ARCHIVE_CONFIRM_KEY = "ysNotebook.taskArchiveConfirmDismissed";
function archiveConfirmDismissed(): boolean {
  try {
    return localStorage.getItem(ARCHIVE_CONFIRM_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberArchiveConfirmDismissed(): boolean {
  try {
    localStorage.setItem(ARCHIVE_CONFIRM_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

// Three views in one column: the kanban, the 回收站 (soft-deleted tasks), and the
// 归档 (成就归档 — sealed done tasks, viewable, not deletable).
type BoardView = "board" | "trash" | "sealed";

// The 标签/文本 filter must survive leaving and returning to the board. navigate() in
// notebook.ts unmounts+remounts on every view switch, so a mount-scope value would
// reset the selection to 所有 each time you switch away and back (and on Ctrl+Alt+M).
// Module scope keeps it (same rationale as topics.ts's `expanded`); only one board is
// mounted at a time, so a single shared value is correct. The 回收站 toggle (boardView)
// stays mount-scope on purpose — it's a transient peek, so a fresh mount lands on the
// board, not the trash. 行为(pills/口径/Esc)在共享件 filter-bar.ts,与灵感同源。
const filter: FilterState = { kind: "all", topics: [], text: "" };

// 时间轴(461):与 filter 同款模块态存活理由(跨 mount/切视图保住选择)。与 kind/
// topics/text 三维正交,单独一格状态——不塞进 FilterState,免得 check-filter-parity
// 的逐字一致门禁把它当成两端必须同步的一部分(那道闸只钉 FilterState 里已有的三维)。
let timeFilter: TimeBucket = "all";

// 新建任务的草稿/暂存配图过桥、断电恢复、失败通知与 in-flight 闸:模块态与保存链
// 骨架全在共享编排件 compose-controller.ts(353,与灵感「记下灵感」同源收拢;历轮
// codex 修复的出处注释随迁到那边)。看板特有的载荷/空输入策略/错误落点等在 mount 里
// 的 bindSave 接线;这里每视图一份控制器实例,跨 mount 存活。
const composeCtl = createComposeController({
  draftKey: "zhujian.board-draft",
  imagesKey: "zhujian.board-images",
});

/** 空间两来路 H1(notebook.ts 草稿探针的模块态半边):新建任务的文字存底或暂存图
 *  还攥在模块态里 = 有未保存内容(DOM 里的 textarea 由探针另一半覆盖)。 */
export function boardHasStashedDraft(): boolean {
  return composeCtl.hasStashedDraft();
}

// 图部分失败的看板文案(353:原先两处同串手抄——unmount 过桥横幅与就地提示——收成一处)。
function partialImgMsg(failed: number): string {
  return t("board.partialImg", { n: failed }) + REPASTE_HINT;
}

export function mount(root: HTMLElement, _ctx: ViewCtx): View {
  // 本 mount 归属的空间:切空间时 notebook 先翻 current 再 unmount,unmount 时现取会
  // 把 A 空间的草稿标成 B 的——必须在这里捕获(codex P1 审 H1)。
  const mountSpace = currentSpaceId();
  const view = el("div", { className: "v-board view" });
  view.innerHTML = SKELETON;
  root.replaceChildren(view);

  const board = view.querySelector("#board") as HTMLElement;
  const copySlot = view.querySelector("#copy-slot") as HTMLElement;
  const filterRow = view.querySelector("#filter-row") as HTMLElement;
  const filterBar = view.querySelector("#topic-filter") as HTMLElement;
  const kindBar = view.querySelector("#kind-filter") as HTMLElement;
  const timeBar = view.querySelector("#time-filter") as HTMLElement;
  const filterInput = view.querySelector("#board-filter") as HTMLInputElement;
  const trashToggle = view.querySelector("#trash-toggle") as HTMLButtonElement;
  const trashN = view.querySelector("#trash-n") as HTMLElement;
  const sealToggle = view.querySelector("#seal-toggle") as HTMLButtonElement;
  const sealN = view.querySelector("#seal-n") as HTMLElement;
  const addTaskBtn = view.querySelector("#add-task") as HTMLButtonElement;
  const compose = view.querySelector("#compose") as HTMLElement;
  const composeInput = view.querySelector("#compose-input") as HTMLTextAreaElement;
  const composeAdd = view.querySelector("#compose-add") as HTMLButtonElement;
  const composeClose = view.querySelector("#compose-close") as HTMLButtonElement;
  const composeErr = view.querySelector("#compose-err") as HTMLElement;
  const opErrBar = view.querySelector("#op-err") as HTMLElement;
  const opErrMsg = view.querySelector("#op-err-msg") as HTMLElement;

  // 卡级操作失败的非破坏性横幅(ui-audit P0 #6):写在看板上方、不替换任何内容——
  // renderError(整版错误页)只留给「读取失败」。新一次操作入口先清旧错,横幅本身
  // 可点「知道了」收起。
  function showOpError(msg: string): void {
    opErrMsg.textContent = msg;
    opErrBar.hidden = false;
  }
  function clearOpError(): void {
    opErrBar.hidden = true;
    opErrMsg.textContent = "";
  }
  (view.querySelector("#op-err-x") as HTMLButtonElement).addEventListener("click", clearOpError);

  let boardView: BoardView = pendingView ?? "board";
  pendingView = null;
  // Local calendar day for due-date highlighting; refreshed on each load so the
  // board stays correct if the window is left open across midnight.
  let today = localToday();

  // topicFilter is module-scope (survives view switches); allTopics feeds the filter
  // bar and the per-card picker, rebuilt each load.
  let allTopics: TopicOpt[] = [];

  // 本看板要画的列(= 任务列 ∧ 活着或还扣着卡,判据在 board-columns.ts),每次 load 重取。
  // ⚠ **mount 级,不是模块级**:切空间 = 换一整套列,模块级会把 A 空间的列画到 B 上
  // (memory `module-state-hoisting-checklist` 那五坑的第一条)。首帧空数组 —— load()
  // 之前没有任何渲染路径读它。
  let cols: BoardColumn[] = [];

  // Fingerprint of the last rendered state. load() runs on every window refocus
  // (alt-tab back) but skips the DOM rebuild when this matches — refresh without flicker.
  let lastSig = "";
  // 各列滚动位(status → scrollTop):全量重画 replaceChildren 会把列滚动清零,长列里
  // 任何写操作后都跳回列顶。load() 重画定局处先记、renderBoard 落 DOM 后还原(与灵感
  // savedScroll 同规,ui-guidelines §3.6)。mount 级即可——同 lastSig,视图重挂即重来。
  const colScroll = new Map<string, number>();
  // load() 代次(codex 二审 H1):并发/重叠的 load 里,await 回来若已非最新那一发就不许
  // 落 DOM——否则旧响应会盖掉新响应、并拆掉刚设好的跳转脉冲。跨视图跳转的 focus 消费也
  // 挪到 load() 同步入口(见下),boardView 中途被 G/R 切走也不会把 focusId 悬着。
  let loadSeq = 0;
  // mount 已死的硬闸(codex P1 审 M1):unmount 后仍在途的 flush/save 链不许重启一轮
  // 全新的 load()——那会拿新 seq 通过守卫、在脱离 DOM 的旧看板上渲染、抢食模块级 focusId。
  let unmounted = false;

  // The card currently being dragged: {id, from-column}. Drop targets read this
  // rather than dataTransfer, so a status move never depends on the platform
  // serializing drag data (and synthetic e2e drags work the same way).
  let dragging: { id: string; from: string } | null = null;

  // 拖拽打标签(1a/1b)的第二根拖拽轴:被拖动的标签 pill 的 topic id。与 `dragging`
  // 互斥并存——卡片重排只认 `dragging`(列体/归档区),打标签只认 `draggingTopic`(卡片/
  // pill 互为落点)。两条 dragover/drop 各自先查自己那根、对方拖动时早返回,天然不打架。
  let draggingTopic: string | null = null;

  // 单一编辑态(全局只允许一张卡进编辑)。开编辑走 requestEdit→load():load 把所有卡重渲为
  // 视图态(关掉任何旧编辑态),renderBoard 里命中 pendingEditId 的那张卡再自动开编辑——
  // 结构上保证只有一个编辑态、且开在全新元素上。activeEditCleanup 拆掉编辑态的文档级按键监听。
  let pendingEditId: string | null = null;
  let activeEditCleanup: (() => void) | null = null;
  // (ui-audit P1 #9b)重画前把开着的编辑器的未保存改动落盘(与灵感「开别的卡先 commit
  // 本卡」同规):返回是否真写了——写了就得重取重画,以落盘后的真相为准。
  let activeEditFlush: (() => Promise<boolean>) | null = null;
  function requestEdit(id: string): void {
    pendingEditId = id;
    void load();
  }

  // Whether a topic filter is active. When filtered the column DOM holds only the
  // VISIBLE subset, so a drop goes through reorder_task_visible (which merges the
  // visible reorder back into the full column server-side) instead of the unfiltered
  // strong-contract reorder_task. Set per load().
  let filtered = false;

  // Serialize drag mutations: ignore a new drag/drop while one is still in flight
  // (a rapid second drop could otherwise build its order from a pre-refresh DOM and
  // silently clobber the first). Cleared once the reload after the mutation lands.
  let busy = false;

  // 悬停选中 + ⋯ 速查菜单 + 单键派发(与灵感共用同一控制器、键义一致)。每次 load() 重渲
  // 前 reset(),卸载时 destroy()。
  const hk = createHotkeyController();

  // 可移入的其他空间(cross-space-move v1):挂载时取一次——空间集变化必经
  // notebook 空间菜单(切换/新建)→ 视图重挂即重取。空 = 单空间,「移动」不出现。
  let otherSpaces: SpaceInfo[] = [];
  void listSpaces()
    .then((all) => {
      otherSpaces = all.filter((sp) => sp.alive && sp.id !== currentSpaceId());
    })
    .catch(() => {});

  // ---- mutations: call the backend, then reflect the new truth by reloading --
  async function call(cmd: string, args: Record<string, unknown>): Promise<void> {
    clearOpError();
    try {
      await invoke(cmd, args);
    } catch (err) {
      // The task may have moved under us (stale view) — surface, don't swallow.
      // 横幅就地报错 + 重载对齐真相,绝不把整个看板换成错误页(ui-audit P0 #6)。
      showOpError(String(err));
      load();
      return;
    }
    load();
  }

  const archive = (id: string) => call("archive_task", { id });
  const revert = (id: string) => call("revert_task_to_inbox", { id });
  const restore = (id: string) => call("restore_task", { id });
  const purgeOne = (id: string) => call("purge_task", { id });
  const purgeAll = () => call("purge_archived_tasks", {});
  // 成就归档(sealed 轴,与回收站分开):归档=干完的活入册,可查、不可删;取消归档回
  // 「已完成」列尾。删除归档条目没有直接入口——先取消归档回看板,再走正常两段式。
  const sealOne = (id: string) => call("seal_task", { id });
  const sealAllDone = () => call("seal_done_tasks", {});
  const unseal = (id: string) => call("unseal_task", { id });

  function clearDropHovers(): void {
    board.querySelectorAll(".drop-hover").forEach((e) => e.classList.remove("drop-hover"));
  }

  // 打标签拖拽的落点高亮(卡片或 pill),与 clearDropHovers 同规:每次 dragover 先清全场
  // 再点亮当前一枚,不靠 dragleave(它在子元素间穿梭会闪)。pill 在 filterBar、卡片在
  // board,两处都扫。
  function clearTagHovers(): void {
    for (const host of [board, filterBar])
      host.querySelectorAll(".tag-drop-hover").forEach((e) => e.classList.remove("tag-drop-hover"));
  }
  // 某任务卡当前是否已挂某标签(读卡上的 chip;chip 带 data-topic-id,见 topicTags）。
  // 拖拽两向共用的去重判据——已挂就不作落点、不落库(link 唯一键会报错)。
  function taskHasTopic(taskId: string, topicId: string): boolean {
    const cardEl = board.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
    return !!cardEl?.querySelector(`.chip.topic.set[data-topic-id="${topicId}"]`);
  }
  // 把一个标签加到某任务(拖拽落点的落库,复用 call 的横幅报错 + 重载对齐);已挂则 no-op。
  function dropTagOnTask(taskId: string, topicId: string): void {
    if (taskHasTopic(taskId, topicId)) return;
    void call("add_task_topic", { id: taskId, topicId });
  }

  // 标签 pill 双向拖拽接线(每次 renderFilterPills 后调,pills 每轮重建)。真标签 pill
  // (带 data-topic-id;所有/无标签不带)既是拖源(pill→card)也是落点(card→pill)。
  function wireTagPills(): void {
    for (const pill of filterBar.querySelectorAll<HTMLElement>(".tf-pill[data-topic-id]")) {
      const topicId = pill.dataset.topicId!;
      pill.draggable = true;
      pill.addEventListener("dragstart", (e) => {
        draggingTopic = topicId;
        pill.classList.add("tag-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.setData("text/plain", topicId);
          e.dataTransfer.effectAllowed = "copy";
        }
      });
      pill.addEventListener("dragend", () => {
        draggingTopic = null;
        pill.classList.remove("tag-dragging");
        clearTagHovers();
      });
      // 任务卡拖到本 pill = 给那张卡打这个标签(card→pill)。只认 dragging(卡片重排轴);
      // 已挂该标签则不作落点(dropTagOnTask 里也再兜一道)。
      pill.addEventListener("dragover", (e) => {
        if (!dragging || taskHasTopic(dragging.id, topicId)) return;
        e.preventDefault();
        clearTagHovers();
        detachDropLine(); // 卡片拖出列区,别让列里的插入线残留
        pill.classList.add("tag-drop-hover");
      });
      pill.addEventListener("drop", (e) => {
        if (!dragging) return;
        e.preventDefault();
        const taskId = dragging.id;
        dragging = null;
        clearTagHovers();
        dropTagOnTask(taskId, topicId);
      });
    }
  }

  // 乐观移位改了某列的成员数,同一帧把列头计数徽章也改掉——否则它要等随后的 load() 才刷新,
  // 会留下「卡已挪走、数字还没动」的一拍延迟(手势即回执 ui-guidelines §3.6 的完形)。真相仍
  // 由 load() 校正:成功值相同、失败时连卡带数字一起复原。列 section 身上带 `data-col="<列 id>"`、
  // 每列只有一个 .col-count,按列 id 即可唯一定位。
  function bumpColCount(status: string, delta: number): void {
    // ⛔ 走 `[data-col=…]` 而不是 `.col.${status}`:自定义列的 id 是 ULID、可能以数字开头,
    // 那种 class 选择器**非法**(querySelector 直接抛)。ULID 与种子 id 都只含字母数字,
    // 属性选择器里安全。
    const span = board.querySelector<HTMLElement>(`.col[data-col="${status}"] .col-count`);
    if (span) span.textContent = String(Number(span.textContent) + delta);
  }

  // ---- drag-reorder helpers --------------------------------------------------
  // The card the drop would land *before* (by pointer Y vs each card's midpoint),
  // or null to append at the end. The dragged card carries `.dragging`, so it is
  // excluded from the midpoint scan.
  function dragAfterElement(body: HTMLElement, y: number): HTMLElement | null {
    let closest: { offset: number; el: HTMLElement | null } = {
      offset: Number.NEGATIVE_INFINITY,
      el: null,
    };
    for (const child of body.querySelectorAll<HTMLElement>(".tcard:not(.dragging)")) {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
    }
    return closest.el;
  }

  // A single reused insertion marker. It is repositioned only when the target slot
  // actually changes — never destroyed and recreated on every dragover frame, which
  // is what made the old marker blink/flicker badly during a drag.
  const dropLine = el("div", { className: "drop-line" });

  function detachDropLine(): void {
    dropLine.remove();
  }

  // Move the marker to the slot a drop would land, only if that slot changed since
  // the last frame (no DOM churn when the pointer hovers within one slot).
  function placeDropLine(body: HTMLElement, y: number): void {
    const after = dragAfterElement(body, y);
    const ref = after ?? null;
    if (dropLine.parentElement === body && dropLine.nextElementSibling === ref) return;
    if (after) body.insertBefore(dropLine, after);
    else body.append(dropLine);
  }

  // Persist an UNFILTERED drag-reorder (within a column, or across columns inserting
  // at a spot). `baseIds` is the target column's full order BEFORE the move (stale-view
  // check), `orderedIds` its complete order after. The backend validates + writes
  // atomically. `busy` serializes against a second drop landing mid-flight.
  async function reorder(
    id: string,
    from: string,
    to: string,
    baseIds: string[],
    orderedIds: string[],
  ): Promise<void> {
    if (busy) return;
    busy = true;
    clearOpError();
    try {
      await invoke("reorder_task", {
        id,
        fromStatus: from,
        toStatus: to,
        baseTargetIds: baseIds,
        orderedIds,
      });
      await load();
    } catch (err) {
      showOpError(String(err)); // 拖拽失败横幅报错 + 重载对齐(ui-audit P0 #6)
      await load();
    } finally {
      busy = false;
    }
  }

  // Persist a FILTERED drag-reorder: the column DOM is only the visible subset, so the
  // frontend sends the target column's visible cards before (`baseVisible`) and after
  // (`visibleAfter`, including the dragged card) the move. The backend reads the full
  // column and merges the visible reorder back in, keeping hidden cards put. Same
  // `busy` serialization as reorder().
  async function reorderVisible(
    id: string,
    from: string,
    to: string,
    baseVisible: string[],
    visibleAfter: string[],
  ): Promise<void> {
    if (busy) return;
    busy = true;
    clearOpError();
    try {
      await invoke("reorder_task_visible", {
        id,
        fromStatus: from,
        toStatus: to,
        baseVisibleIds: baseVisible,
        visibleAfter,
      });
      await load();
    } catch (err) {
      showOpError(String(err));
      await load();
    } finally {
      busy = false;
    }
  }

  // ---- 新建任务 compose ------------------------------------------------------
  // The textarea auto-grows to fit its content (titles may span lines now) via the
  // shared autogrow.ts; CSS caps each box (compose 160 / edit 200). Reset to one
  // row when cleared.

  // 新建任务的暂存配图(共享件 pendingImages,同捕获浮窗/灵感 compose):任务回车才建,
  // 图先暂存预览,create_task 拿到 id 再挂上。compose 条常驻不重建,接一次即可。
  // composeCtl.imgs 是模块级(P1 #9d):root 从上一个 mount 搬过来,未提交的预览还在。
  compose.insertBefore(composeCtl.imgs.root, composeErr);
  composeCtl.imgs.wire(composeInput);

  // 刚在本视图新建的任务:下一次渲染给它一记朱砂脉冲(.just-born),用完即清——
  // 只有「此刻新生」的卡片有入场感,存量看板安安静静(同灵感 compose)。
  let pulseId: string | null = null;
  // 跳转定位(搜索/深链接/剪贴板「打开」冷着陆命中的卡):下一次渲染给它**持续常亮**的
  // .just-located(区别于 born 的一次性涟漪),留到下次点击/滚动才消(见 locate.ts)。
  let locateId: string | null = null;

  // 保存链走共享编排件(353):in-flight 闸/载荷冻结/必落账/在场守卫在骨架里
  // (compose-controller.ts),这里只接看板特有的形。
  const submitNewTask = composeCtl.bindSave({
    space: mountSpace,
    input: composeInput,
    errEl: composeErr,
    liveErrSelector: ".v-board #compose-err",
    liveInputSelector: "#compose-input",
    isUnmounted: () => unmounted,
    command: "create_task",
    prepare: (submitted) => {
      const title = submitted.trim();
      if (!title) {
        // 只粘了图没写标题:标题是任务的必填项(后端拒空),别把这次回车静默吞掉。
        if (composeCtl.imgs.count() > 0) composeErr.textContent = t("board.titleBeforeImages");
        return null;
      }
      // 恰好筛了单一具体标签时,新任务归到它(唯一归属才明确);所有 / 无标签 / 多标签(OR)
      // → 生而无标签(多标签下归属不明,别猜)。原子随 create_task 携带(与灵感的二次
      // 挂载是刻意分歧:任务归属是载荷的一部分)。
      const topicId = soleTopicFilter(filter);
      return { payload: { title: submitted, topicId }, soleTopic: topicId };
    },
    showErr: (el, msg) => {
      el.textContent = msg;
    },
    onDeadMount: (failed) => {
      // 部分失败先记账(活的看板 mount 用 op-err 横幅当场亮出来;不在场就过桥给
      // 下一个 mount)。
      if (failed > 0 && currentSpaceId() === mountSpace) {
        const msg = partialImgMsg(failed);
        const liveMsg = document.querySelector<HTMLElement>(".v-board #op-err-msg");
        const liveBar = document.querySelector<HTMLElement>(".v-board #op-err");
        if (liveMsg !== null && liveBar !== null) {
          liveMsg.textContent = msg;
          liveBar.hidden = false;
        } else {
          composeCtl.postNotice(msg, mountSpace);
        }
      }
    },
    onSaved: (id, topicId, failed) => {
      // 文本过滤下新建:新卡多半不含过滤词,会被当场滤到隐身——清掉过滤让它可见。
      if (filter.text !== "") {
        filter.text = "";
        filterInput.value = "";
      }
      // 标签筛选下新建:单选具体标签会归到该标签、本就可见,不清;但多标签(OR)下新卡
      // 生而无标签、不在任何被筛标签下 = 会隐身,清掉标签筛选让它可见(含「无标签」筛选时
      // 新卡天然在视野,不清)。
      if (topicId === null && filter.topics.length > 0 && !filter.topics.includes("none")) {
        filter.topics = [];
      }
      // 时间筛选下新建:新卡创建时刻=现在,归「近1天」桶;筛的是别的档(近7天/7天前)
      // 会把新卡当场筛没——清掉让它可见(同上面文本/标签筛选的处理,461)。
      if (timeFilter !== "all" && timeFilter !== "1d") {
        timeFilter = "all";
      }
      composeErr.textContent = failed > 0 ? partialImgMsg(failed) : "";
      pulseId = id; // 下一次渲染给这张新卡一记朱砂脉冲
      load(); // the new 'todo' appears at the front of the 待办 column
      composeInput.focus(); // stay open for rapid entry
    },
  });

  function setComposeOpen(open: boolean): void {
    compose.hidden = !open;
    addTaskBtn.classList.toggle("on", open);
    composeErr.textContent = "";
    if (open) composeInput.focus();
  }

  // 文本过滤:输入即筛,走 load() 单一渲染路径(行为在共享件,细节见 filter-bar.ts)。
  wireFilterInput(filterInput, filter, () => void load());

  // 上个 mount 留下的草稿/暂存图:同空间才灌回并把 compose 开回来;空间对不上整体
  // 丢弃(P1 #9d + codex H1 空间隔离)。mountSpace 在 mount 顶部捕获。
  composeCtl.discardForeignDraft(mountSpace);
  if (composeCtl.draftText() !== "" || composeCtl.imgs.count() > 0) {
    composeInput.value = composeCtl.takeDraftText();
    setComposeOpen(true);
    autoGrow(composeInput);
  }
  // 断电恢复:首个 mount 回填暂存图(空间对不上的已被上面 discard 清掉,restore 读到空存;
  // 重开正常场景=恢复上次空间,图属本空间)。IndexedDB 异步——填好若有图且 compose 还
  // 关着,把它开出来让用户看见(纯图无字草稿也不至于藏在收起的 compose 里)。仅一次。
  composeCtl.restoreImagesOnce(() => {
    if (!unmounted && composeCtl.imgs.count() > 0 && compose.hidden) setComposeOpen(true);
  });
  // 上个 mount 死后才失败的保存:错误过桥到这,领走显示(codex 三审 M)。
  // 先开 compose 再写错误——setComposeOpen 内部会清 composeErr,顺序反了就白写。
  {
    const bridged = composeCtl.takeNotice(mountSpace);
    if (bridged !== null) {
      setComposeOpen(true);
      composeErr.textContent = bridged;
    }
  }

  addTaskBtn.addEventListener("click", () => setComposeOpen(compose.hidden));
  composeAdd.addEventListener("click", () => void submitNewTask());
  composeClose.addEventListener("click", () => setComposeOpen(false));
  composeInput.addEventListener("input", () => {
    autoGrow(composeInput);
    composeCtl.persistText(composeInput.value, mountSpace); // 断电恢复:输入即写
  });
  composeInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合期的 Enter 是上屏,不是提交(ui-audit P0 #1)
    // Enter submits; Shift+Enter inserts a newline (let the default through).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submitNewTask();
    } else if (e.key === "Escape") {
      setComposeOpen(false);
    }
  });

  // Trash-card actions: restore (reversible, no confirm) or permanently delete.
  function trashActions(item: TaskItem): HTMLElement {
    const acts = el("div", { className: "acts" });
    acts.append(
      btn(t("board.restore"), "primary", () => restore(item.id)),
      btn(t("board.deleteForever"), "ghost", () =>
        confirmInline(acts, t("board.deleteForeverQ"), t("board.deleteForever"), () => purgeOne(item.id))),
    );
    return acts;
  }

  // 归档卡片的唯一操作:取消归档(可逆、无确认,同回收站「还原」)。刻意没有删除入口——
  // 归档是史实(不可删);想删先取消归档回看板,再走正常两段式删除。
  function sealedActions(item: TaskItem): HTMLElement {
    const acts = el("div", { className: "acts" });
    acts.append(btn(t("board.unseal"), "ghost", () => unseal(item.id)));
    return acts;
  }

  // Two-step confirm — no modal, swap the pills in place (matches inbox.ts).
  // 移动到其他空间(cross-space-move v1):picker 进卡片的 .acts 行内宿主(与删除
  // 确认同宿主,confirm-q 在场即挂起单键)。告知「编辑历史永久删除」先于提交(§4);
  // 结果分道:仅 moved 重载看板(卡片随重载消失);copied_but_source_kept 保留卡片、
  // 原因原话展示(不提供重跑,重复优于丢失);两预检拒各有人话。
  function openMoveSpace(acts: HTMLElement, itemId: string): void {
    const err = el("span", { className: "confirm-q", textContent: "" });
    const labels = distinctSpaceLabels(otherSpaces);
    let moving = false;
    const chipBtns = otherSpaces.map((sp) =>
      el("button", {
        className: "act primary",
        textContent: labels.get(sp.id) ?? spaceLabel(sp),
        onclick: () => void doMove(sp.id),
      }),
    );
    const cancelBtn = el("button", { className: "act ghost", textContent: t("board.cancel"), onclick: () => void load() });
    // 部分成功的终点(codex 实现审 #2):目标已建,提交按钮永久移除、只留说明与
    // 「知道了(刷新)」——绝不提供重跑整个移动;刷新让卡片显出触发拒删的最新状态。
    const stopForPartial = (msg: string): void => {
      err.textContent = msg;
      acts.replaceChildren(
        err,
        el("button", { className: "act ghost", textContent: t("board.gotItRefresh"), onclick: () => void load() }),
      );
    };
    const doMove = async (target: string): Promise<void> => {
      if (moving) return; // in-flight 闸:双击/连点不并发提交
      moving = true;
      chipBtns.forEach((b) => (b.disabled = true));
      const sourceSpace = currentSpaceId(); // 发起那一刻的源空间(登记键)
      // 部分成功:**先落登记**(独立于 DOM,取消/重渲/切空间/重启都冲不掉,该条目
      // 的「移动」入口随之隐藏),再更新眼前的 picker;picker 已脱离 DOM 就重载看板,
      // 让登记提示以卡面常驻形态冒出来。
      const settlePartial = (msg: string): void => {
        movePartialMark(sourceSpace, itemId, msg);
        if (acts.isConnected) stopForPartial(msg);
        else if (currentSpaceId() === sourceSpace) void load();
      };
      let r: MoveResult;
      try {
        r = await moveItemToSpace(sourceSpace, target, itemId);
      } catch (e) {
        // 抛错 = 目标什么都没建(目标 commit 后的失败一律走结构化结果),可重试。
        err.textContent = String(e);
        moving = false;
        chipBtns.forEach((b) => (b.disabled = false));
        return;
      }
      // 话术=space.ts::moveOutcomeText 一份(此前与 inbox 逐字两抄),这里只留 DOM 反应。
      const text = moveOutcomeText(r, labels.get(target) ?? target);
      switch (r.outcome) {
        case "moved":
          // 回执(228):卡片默默消失等于没回话,且安卓那边一直给绿条——端间不该分叉。
          toastAction(text);
          // 迟到(期间取消/重渲/切空间)也只在还在源空间时重载,把移走的卡收掉。
          if (currentSpaceId() === sourceSpace) void load();
          return;
        case "copied_but_source_kept":
        case "copied_but_source_unconfirmed":
          settlePartial(text);
          return;
        case "images_pending":
        case "dangling_refs":
          err.textContent = text;
          moving = false;
          chipBtns.forEach((b) => (b.disabled = false));
          return;
        default: {
          const exhaustive: never = r;
          return exhaustive;
        }
      }
    };
    acts.replaceChildren(
      el("span", { className: "confirm-q", textContent: t("board.moveTo") }),
      ...chipBtns,
      cancelBtn,
      err,
    );
  }

  // 破坏性确认响应 Esc/点别处(ui-audit P1 #12):确认态复用 armDismiss(与 ⋯ 菜单/
  // 选择器同一套手势)。teardown 挂 mount 级单值——同时至多一个确认在场,新确认先
  // 收旧的;load() 重画/unmount 也收,文档级监听不悬空。
  let confirmOff: (() => void) | null = null;
  function disarmConfirm(): void {
    if (confirmOff) {
      confirmOff();
      confirmOff = null;
    }
  }

  function confirmInline(acts: HTMLElement, question: string, yes: string, onYes: () => void): void {
    disarmConfirm();
    confirmOff = armDismiss(acts, () => {
      confirmOff = null;
      void load();
    });
    acts.replaceChildren(
      el("span", { className: "confirm-q", textContent: question }),
      el("button", {
        className: "act ghost",
        textContent: t("board.cancel"),
        onclick: () => {
          disarmConfirm();
          void load();
        },
      }),
      el("button", {
        className: "act primary",
        textContent: yes,
        onclick: () => {
          disarmConfirm();
          onYes();
        },
      }),
    );
  }

  // 删除 a board card: straight to 回收站 if the user opted out of the confirm, else
  // an inline confirm explaining it's recoverable + a 不再提示 checkbox.
  function requestArchive(acts: HTMLElement, id: string): void {
    if (archiveConfirmDismissed()) {
      archive(id);
      return;
    }
    const dontAsk = el("input", { type: "checkbox" });
    disarmConfirm();
    confirmOff = armDismiss(acts, () => {
      confirmOff = null;
      void load();
    });
    acts.replaceChildren(
      el("span", { className: "confirm-q", textContent: t("board.archiveQ") }),
      el("label", { className: "dont-ask" }, [dontAsk, document.createTextNode(t("board.dontAskAgain"))]),
      el("button", {
        className: "act ghost",
        textContent: t("board.cancel"),
        onclick: () => {
          disarmConfirm();
          void load();
        },
      }),
      el("button", {
        className: "act primary",
        textContent: t("board.delete"),
        // Persist the opt-out before deleting; if the write fails we don't pretend it
        // stuck — the confirm just shows again next time. Either way the delete runs.
        onclick: () => {
          disarmConfirm();
          if (dontAsk.checked) rememberArchiveConfirmDismissed();
          archive(id);
        },
      }),
    );
  }

  // A card's tags (M:N). Each current tag is a chip with a ✕ to drop it; the ⋯ menu's
  // 标签 opens a keepOpen picker of the tags not yet on the card — pick/create adds one
  // and the picker stays put so you can add several in a row (each write = add_task_topic, or
  // add_task_topic_by_title when the typed name is new; remove = remove_task_topic).
  // Adds reflect in place (item.topics + a live `have`) and
  // reconcile the whole board with one load() when the picker closes; remove reloads at
  // once. draggable:false keeps a chip click from starting a card drag.
  function topicTags(item: TaskItem): { root: HTMLElement; openPicker: () => void } {
    const wrap = el("span", { className: "slot topic-slot" });
    // 选择器 keepOpen 连加:选/建一个即就地更新——落库成功后把标签并进 item.topics 与
    // have、**不整板重载**(load() 会拆掉卡片连带选择器);连续加多个,收起时(openPicker 的
    // armDismiss)才补一发 load() 对齐全局真相(筛选 pills 计数、其它卡)。失败=横幅就地报错、
    // 不改本地态,选择器留场可重试。返回是否真加上,供 openPicker 决定收起时要不要重载。
    async function addTag(topicId: string, have: Set<string>): Promise<boolean> {
      clearOpError();
      try {
        await invoke("add_task_topic", { id: item.id, topicId });
      } catch (e) {
        showOpError(String(e)); // 横幅就地报错,卡片与选择器都保持在场(ui-audit P0 #6)
        return false;
      }
      const tp = allTopics.find((t) => t.id === topicId);
      if (tp) item.topics.push({ id: tp.id, title: tp.title, color: tp.color });
      have.add(topicId);
      return true;
    }
    // 新建并挂上:输入的名字在库里不存在时才走到这。**一条命令走完**(add_task_topic_by_title
    // = core 单事务:验任务仍活跃 → 同名复用/缺则新建 → 挂链)。⛔ 别改回 create_topic 拿 id 再
    // add 的两步:第一步成、第二步败会留下一枚没人要的空标签,且两调之间目标可能已被远端归档
    // (codex 120 设计审 M9;安卓那端一直是单事务,386 第③条把桌面这端补齐)。校验空/超长仍在
    // core 里,失败原样报错、选择器留场可重试。
    // 返回的 id 可能是**既有**标签:本地 allTopics 落后于库(远端刚同步来同名标签)时,后端按
    // 标题复用而不是新建 —— 故先按 id 查重再并进 allTopics / item.topics,别盲push 造重复。
    async function createTag(title: string, have: Set<string>): Promise<boolean> {
      clearOpError();
      let id: string;
      try {
        id = await invoke<string>("add_task_topic_by_title", { id: item.id, title });
      } catch (e) {
        showOpError(String(e)); // 横幅就地报错,卡片与选择器都保持在场(ui-audit P0 #6)
        return false;
      }
      let tp = allTopics.find((x) => x.id === id);
      if (!tp) {
        // core 里 title 是 trim 过的;本地这份只活到收起时那发 load(),用同一口径免得候选里
        // 出现带空格的影子名。
        tp = { id, title: title.trim(), color: null, kind: null };
        allTopics.push(tp);
      }
      if (have.has(id)) return true; // 后端幂等 no-op(那标签已在卡上)—— 别再往 chips 里加一枚
      item.topics.push({ id: tp.id, title: tp.title, color: tp.color });
      have.add(id);
      return true;
    }
    async function removeTag(topicId: string): Promise<void> {
      clearOpError();
      try {
        await invoke("remove_task_topic", { id: item.id, topicId });
      } catch (e) {
        showOpError(String(e));
        return;
      }
      load();
    }
    function renderChips(): void {
      // ㊺: only the set-tag chips show on the card (display + a ✕ to drop each — a precise
      // per-tag op, kept inline). Adding a tag has no on-card ＋ button anymore; it opens
      // the picker from the ⋯ menu's 标签 (openPicker). A tagless card shows nothing here.
      const chips = item.topics.map((tp) => {
        const chip = el("span", { className: "chip topic set", draggable: false });
        // 筛某个标签时,卡片上那枚同名 chip 是纯冗余(筛出来的卡本就都带它)——标 redundant
        // 交给 CSS 藏起来,消掉视觉噪音。**仍留在 DOM 里**:拖拽打标签的去重判据 taskHasTopic
        // 读这枚 chip,真删掉会误判「未挂」→ 拖回该 pill 重复 add_task_topic 报错(旁路不变量)。
        if (soleTopicFilter(filter) === tp.id) chip.classList.add("redundant");
        chip.dataset.topicId = tp.id; // 拖拽打标签的去重判据(taskHasTopic 读它;ULID 选择器安全)
        applyTagColor(chip, tp.color); // 有色标签的 chip 着色(左色条 + 极淡底),便于一眼定位
        chip.append(
          el("span", { className: "chip-label", textContent: tp.title }),
          el("button", {
            className: "chip-x",
            textContent: "✕",
            draggable: false,
            title: t("board.removeTag"),
            onclick: () => void removeTag(tp.id),
          }),
        );
        return chip;
      });
      wrap.replaceChildren(...chips);
    }
    // 输入即筛选的标签选择器:打字先过滤已有标签(把已存在的顶到眼前、引导复用),只有当
    // 输入名跟任何标签都不精确匹配时,才冒出「创建『xxx』」——「先复用」是默认路径,顺手挡住
    // 手滑造近似重复(标签视图有「合并」正因为重复会发生)。Esc / 点别处 收起,无「取消」钮。
    function openPicker(): void {
      const have = new Set(item.topics.map((t) => t.id));
      let changed = false;
      // 收起(Esc / 点选择器之外):把 chips 画回;只有连加期间真加过标签,才补一发 load() 把
      // 整板(筛选 pills 计数、其它卡)对齐后端真相——纯打开又取消不重画整板,省一次闪。
      armDismiss(wrap, () => {
        renderChips();
        if (changed) void load();
      });
      // 选择器 UI(搜索 + 候选 + Enter 复用/新建)走共享件 tag-picker.ts(与灵感同源),keepOpen
      // 让选完不收起、可连续加多个:选既有 = add_task_topic,输入新名 = add_task_topic_by_title
      // (core 单事务建+挂,见 addTag / createTag)。回调落定后由 tag-picker 就地重渲候选(已加的即时隐藏)。
      renderTagPicker(wrap, {
        allTopics,
        have,
        keepOpen: true,
        onPick: (topicId) =>
          addTag(topicId, have).then((ok) => {
            if (ok) changed = true;
          }),
        onCreate: (title) =>
          createTag(title, have).then((ok) => {
            if (ok) changed = true;
          }),
      });
    }
    renderChips();
    return { root: wrap, openPicker };
  }

  function card(item: TaskItem, mode: "board" | "trash" | "sealed"): HTMLElement {
    // Highlight a due card at a glance: overdue/today wear a 朱砂 accent.
    const st = mode === "board" ? dueState(item.due_on, today) : "none";
    const dueCls = st === "overdue" || st === "today" ? ` due-${st}` : "";
    const modeCls = mode === "board" ? item.status : mode === "trash" ? "archived" : "sealed";
    const titleP = el("p", { className: "ttitle", textContent: item.title });
    const c = el("article", { className: `tcard ${modeCls}${dueCls}` }, [titleP]);
    if (item.id === pulseId) {
      // 刚新建的任务落列首:一记朱砂脉冲(theme.css .just-born),用完即清。只在 born-pulse
      // 结束时摘 class——卡片自己的入场动画也会冒泡 animationend(同灵感 row)。
      pulseId = null;
      c.classList.add("just-born");
      const onEnd = (e: AnimationEvent) => {
        if (e.animationName !== "born-pulse") return;
        c.classList.remove("just-born");
        c.removeEventListener("animationend", onEnd);
      };
      c.addEventListener("animationend", onEnd);
    }
    if (item.id === locateId) {
      // 跳转定位冷着陆:持续常亮的朱砂高亮(theme.css .just-located),armLocate 挂一次性关闭
      // ——留到下次点击/滚动才淡出,免得「还没看清是哪条就消失了」。用完即清。
      locateId = null;
      c.classList.add("just-located");
      armLocate(c);
    }

    // ---- 配图 (item images) ----
    // Cached so the 标题 can linkify 「图N」 and the read-only strip renders without refetching
    // on every paint. A 图N with no matching image stays plain text (renderContent's rule).
    let imgs: ImageMeta[] = [];
    function paintTitle(): void {
      titleP.replaceChildren(renderContent(item.title, imgs));
    }
    async function loadImages(): Promise<void> {
      try {
        imgs = await listImages(item.id);
      } catch {
        imgs = [];
      }
      paintTitle();
    }

    if (mode === "trash") {
      c.append(trashActions(item));
    } else if (mode === "sealed") {
      c.append(sealedActions(item));
    } else {
      // 完成时刻(0030):已完成卡显示「完成于 <日>」。done_at 可能为 null(本功能上线前
      // 完成的老卡)——那就不显示。dayLabel 与归档册同口径(今天/昨天/M月D日)。
      if (item.status === DONE_COLUMN && item.done_at) {
        c.append(el("div", { className: "done-at", textContent: t("board.doneAt", { day: dayLabel(item.done_at) }) }));
      }
      // due/priority: pure-display chips on the card; edits open from the ⋯ menu (㊺).
      // 失败走 op-err 横幅(非破坏),renderError 只留给读取失败(ui-audit P0 #6)。
      const meta = metaRow(item, today, load, showOpError);
      // 署名(0033):只在活跃看板显——回收站/归档册是「已处理完」的语境,不铺
      // (2026-08-05 用户拍板的铺开范围)。挂进 due/priority 那一行末尾。
      if (boardView === "board") {
        const sig = signatureChip(mountSpace, item.born_device);
        if (sig) meta.root.append(sig);
        // 留言徽章(§4.7):N=0 不显(那时的入口在 ⋯ 菜单的「留言」)。回收站/归档册
        // 不铺——同署名的铺开范围。
        const badge = commentBadge(mountSpace, item.id, () => void load());
        if (badge) meta.root.append(badge);
      }
      c.append(meta.root);
      // tags (M:N): set-tag chips show on the card (each with a ✕ to drop it); adding a
      // tag opens the picker from the ⋯ menu's 标签 (㊺). Reuses .task-meta chip styling.
      const tags = topicTags(item);
      c.append(el("div", { className: "task-meta task-topic" }, [tags.root]));
      // The permanent action-button row is gone: operations now live behind the ⋯
      // corner menu (hover it for the shortcut cheat-sheet) + single-key shortcuts when
      // the card is active — same hover-select model as 灵感. `acts` stays only as the
      // inline-confirm host for 删除 / 撤回 (empty in view mode → collapses via CSS).
      const acts = el("div", { className: "acts" });
      c.append(acts);
      // 部分成功登记(cross-space-move):目标已建、源还在——提示常驻卡面、随重渲
      // /重启存续;「移动」入口由 actionsFor 同步藏起,处理完点解除恢复。
      {
        const partialMsg = movePartialNote(item.id);
        if (partialMsg) {
          acts.replaceChildren(
            el("span", { className: "confirm-q", textContent: partialMsg }),
            el("button", {
              className: "act ghost",
              textContent: t("board.partialHandled"),
              onclick: () => {
                movePartialClear(item.id);
                void load();
              },
            }),
          );
        }
      }

      // ⋯ menu + single-key shortcuts. Declared once, drive BOTH the menu and the
      // keyboard (single source of truth). Keys match 灵感 where they overlap
      // (E 编辑 / C 复制 / L 标签 / D 删除), so the muscle memory transfers.
      const copyFeedback = async (): Promise<string> => {
        try {
          await copyText(item.title);
          return t("board.copied");
        } catch {
          return t("board.copyFailed");
        }
      };
      // 复制这条任务的深链接(zhujian://open?…&item=…):粘到别的笔记 / 发给对方设备都能
      // 直接打开它(见 deeplink.ts)。菜单反馈复用 copy 一族的「点一下闪一下」。
      const copyLinkFeedback = async (): Promise<string> => {
        try {
          await copyText(await buildItemDeepLink(item.id));
          return t("board.linkCopied");
        } catch {
          return t("board.copyFailed");
        }
      };
      // 列间移动: advance/retreat the card one column. The target column's current DOM
      // order (excludes this card — cross-column) is the base; the card appends to the
      // end of the target column. Routes through the same reorder paths as a drop, so a
      // topic filter is honoured (visible-merge server-side).
      function moveCol(dir: number): void {
        if (busy) return;
        // ⚠ 序就是 `cols` 的序(core 已按 position 排好)。已删的列虽然画在看板上,却**不是
        // 移动目标** —— 与拖放同规(core 会拒),故先滤掉它们再找左右邻居。
        const live = cols.filter((c) => !c.deleted);
        const i = live.findIndex((col) => col.id === item.status);
        const t = i + dir;
        if (i < 0 || t < 0 || t >= live.length) return;
        const toStatus = live[t].id;
        const targetBody = board.querySelector(`.col[data-col="${toStatus}"] .col-body`);
        const base = targetBody
          ? [...targetBody.querySelectorAll<HTMLElement>(".tcard")].map((x) => x.dataset.taskId!)
          : [];
        const ordered = [...base, item.id];
        targetBody?.append(c); // 手势即回执:按键即挪到目标列尾(与拖放同规),load() 校正
        bumpColCount(item.status, -1); // 移列必跨列:源 −1、目标 +1(与拖放同规)
        bumpColCount(toStatus, 1);
        if (filtered) reorderVisible(item.id, item.status, toStatus, base, ordered);
        else reorder(item.id, item.status, toStatus, base, ordered);
      }
      // 截止 / 优先级 / 标签: the on-card chips are pure display now (㊺), so the menu opens
      // the editors directly via the meta/tag controllers — one source of truth, no chip click.
      function actionsFor(): Act[] {
        const list: Act[] = [
          { label: t("board.edit"), key: "E", run: () => requestEdit(item.id) },
          { label: t("board.copy"), key: "C", feedback: copyFeedback },
          { label: t("board.copyLink"), key: "K", feedback: copyLinkFeedback },
          { label: t("board.tags"), key: "L", run: tags.openPicker },
          { label: t("board.due"), key: "S", run: meta.openDue },
          { label: t("board.priority"), key: "P", run: meta.openPri },
          // 留言(§4.7,与灵感同键):N=0 时卡片上没有徽章,这里是写第一条的唯一入口。
          { label: t("board.comments"), key: "Y", run: () => openComments(mountSpace, item.id, () => void load()) },
        ];
        // 左右邻居按**活着的**列算(同 moveCol:已删的列不是移动目标)。卡自己在一个已删
        // 的列里时 `i < 0` ⇒ 两条都不出 —— 那是对的:它只能被拖走或走别的动作。
        const live = cols.filter((col) => !col.deleted);
        const i = live.findIndex((col) => col.id === item.status);
        if (i >= 0 && i < live.length - 1)
          list.push({ label: t("board.moveToCol", { col: columnName(live[i + 1]) }), key: "]", run: () => moveCol(1) });
        if (i > 0)
          list.push({ label: t("board.moveToCol", { col: columnName(live[i - 1]) }), key: "[", run: () => moveCol(-1) });
        // 归档: only a 已完成 card can enter the 成就册 (viewable, undeletable). Key A
        // (Archive) — the view-level key for the 归档 view is G, deliberately different
        // (card keys and view keys share the document and must not collide).
        if (item.status === DONE_COLUMN)
          list.push({ label: t("board.seal"), key: "A", run: () => sealOne(item.id) });
        // 撤回为灵感: a 灵感 is just a not-yet-clarified task, so only the least-mature
        // column (待办) may retreat into it. Single-entity: flips the SAME subject's stage
        // back to 灵感 (已归类 if it still carries a tag, else 未归类) — nothing is deleted.
        if (item.status === LANDING_COLUMN)
          list.push({
            label: t("board.revertToIdea"),
            key: "B",
            run: () =>
              confirmInline(acts, t("board.revertQ"), t("board.revertYes"), () => revert(item.id)),
          });
        // 删除 → soft-archive into 回收站 (reversible). The FIRST time it shows an inline
        // confirm with a 不再提示 opt-out (persisted), after which it deletes straight away.
        // 移动到其他空间(cross-space-move v1):≥2 空间才出现。
        if (otherSpaces.length > 0 && !movePartialNote(item.id))
          list.push({ label: t("board.move"), key: "M", run: () => openMoveSpace(acts, item.id) });
        list.push({ label: t("board.delete"), key: "D", run: () => requestArchive(acts, item.id), danger: true });
        return list;
      }
      // A card mid inline-rename / mid-confirm owns the keyboard (its own Enter/Esc).
      const handle = hk.register(
        c,
        actionsFor,
        () => !!c.querySelector(".edit-form") || !!c.querySelector(".confirm-q"),
      );
      c.append(handle.menu());

      // Board cards move by drag, not buttons. The closure `dragging` carries the id;
      // dataset.taskId lets a drop read the column's order straight from the DOM.
      c.dataset.taskId = item.id;
      c.draggable = true;
      c.addEventListener("dragstart", (e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        dragging = { id: item.id, from: item.status };
        c.classList.add("dragging");
        // 归档条只对能落进去的拖动现身(done 卡),显示条件=接收条件。
        if (item.status === DONE_COLUMN) board.classList.add("drag-done");
        e.dataTransfer?.setData("text/plain", item.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      c.addEventListener("dragend", () => {
        dragging = null;
        c.classList.remove("dragging");
        board.classList.remove("drag-done");
        clearDropHovers();
        detachDropLine();
      });

      // 标签 pill 拖到本卡 = 给本卡打这个标签(pill→card)。只认 draggingTopic;卡片重排
      // (dragging)时早返回,交给列体处理。stopPropagation 免得冒泡到列体的 dragover/drop
      // (列体本就 !dragging 自退,双保险)。已挂该标签则不作接收目标(无高亮、不落库)。
      c.addEventListener("dragover", (e) => {
        if (draggingTopic === null || item.topics.some((t) => t.id === draggingTopic)) return;
        e.preventDefault();
        e.stopPropagation();
        clearTagHovers();
        c.classList.add("tag-drop-hover");
      });
      c.addEventListener("drop", (e) => {
        if (draggingTopic === null) return;
        e.preventDefault();
        e.stopPropagation();
        const topicId = draggingTopic;
        draggingTopic = null;
        clearTagHovers();
        dropTagOnTask(item.id, topicId);
      });

      // 双击卡片 = 默认操作「编辑」(和单键 E 同一入口)。双击在 chip / ⋯ 菜单 / 按钮 /
      // 输入框上时不劫持,正在改名或确认中也不触发(让那张表单自己的键生效)。
      c.addEventListener("dblclick", (e) => {
        if (c.querySelector(".edit-form") || c.querySelector(".confirm-q")) return;
        if ((e.target as HTMLElement).closest("a, button, input, textarea, .chip, .hk-menu-wrap, .img-strip")) return;
        requestEdit(item.id);
      });

      // 单一编辑态:这张卡被 requestEdit 选中 → 重渲后自动进编辑(openEdit 是函数声明、已提升)。
      // 必须推迟到 board.replaceChildren 把卡挂上 DOM 之后再开 —— openEdit 里 autoGrow 靠
      // scrollHeight 测高、focus() 也只对已挂载元素生效,游离态测出来高度为 0 会把框压塌。
      // queueMicrotask 在当前同步栈(含 attach)跑完后、绘制前执行,既量得对又无闪烁。
      if (pendingEditId === item.id) {
        pendingEditId = null;
        queueMicrotask(() => openEdit());
      }
    }

    // ---- 编辑 (inline rename) ----
    // A draggable parent blocks text selection inside a child input, so the card
    // is made non-draggable while editing; load() restores a fresh draggable card.
    function openEdit(): void {
      c.draggable = false;
      const input = el("textarea", { className: "edit-input", rows: 1, value: item.title });
      const err = el("span", { className: "edit-err" });

      // 配图编辑器:在标题框粘贴截图(Ctrl+V)→ 挂为下一张「图N」;缩略图可删(编号不复用)。
      // ＋图 选文件入口已删——配图统一靠粘贴(Ctrl+V)。
      const imgEditor = el("div", { className: "img-editor" });
      const imgErr = el("p", { className: "img-err", hidden: true });
      const strip = imageStrip(item.id, { editable: true });
      const onImgErr = (e: unknown) => {
        imgErr.textContent = String(e);
        imgErr.hidden = false;
      };
      const afterAttach = () => {
        imgErr.hidden = true;
        void strip.reload();
      };
      wirePasteToAttach(input, item.id, afterAttach, onImgErr);
      imgEditor.append(strip.root, imgErr);

      let saving = false; // 幂等:点别处/回车/切卡可能并发触发,保存中再触发直接让位
      const save = async () => {
        if (saving) return;
        saving = true;
        try {
          await invoke("rename_task", { id: item.id, title: input.value });
        } catch (e) {
          // 竞态下编辑器可能已被重画拆走:错误必须落在还看得见的地方(op-err 横幅),
          // 附草稿不无声(codex P1 审 H3)。
          if (err.isConnected) err.textContent = String(e);
          else showOpError(t("board.renameFailed", { title: item.title, err: String(e), draft: input.value }));
          saving = false;
          return;
        }
        activeEditFlush = null; // 已落盘:随后的 load() 不得再 flush 同一改动(会造重复版本)
        load(); // 重渲会拆掉本编辑态的文档级监听(activeEditCleanup)
      };
      // 提交编辑:空标题(后端拒空)或没改动都当「取消」——直接重渲回视图、不打后端(no-op
      // rename 也会 UPDATE 触发历史归档、留一条重复版本,所以未改动必须短路)。真有改动才 save。
      const commit = (): void => {
        if (input.value.trim() === "" || input.value === item.title) {
          void load();
          return;
        }
        void save();
      };
      input.addEventListener("input", () => autoGrow(input));
      // Esc 取消 / Enter 提交 监听在文档级,而非输入框上 —— 焦点离开框(点了缩略图 /
      // 卡片空白)时也生效。Shift+Enter 仍在框内换行(shiftKey 让位)。别的输入框(如 compose
      // 新任务)保留自己的键:目标是另一个 input/textarea 时不劫持。load() 会拆掉这些监听。
      const onKey = (e: KeyboardEvent) => {
        if (e.isComposing) return; // IME 组合期的 Enter/Esc 属于输入法,不是提交/取消(ui-audit P0 #1)
        const t = e.target;
        if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t !== input) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          activeEditFlush = null; // Esc = 明确丢弃:load() 的落盘钩不得把它救回来
          void load();
        }
      };
      // 点这张卡以外的任何地方 = 默认保存(需求:点别处即提交)。落点在本卡内(标题框 /
      // 缩略图 / 提示行)不算离开;看大图遮罩、别卡的 ⋯ 菜单浮层、留言浮层(portal 到 body)也放行
      // ——那是编辑态的卫星 UI,不该误触发保存(白名单=SATELLITE_LAYERS,一处登记)。
      const onDown = (e: MouseEvent): void => {
        const t = e.target as HTMLElement;
        if (c.contains(t)) return;
        if (t.closest(SATELLITE_LAYERS)) return;
        commit();
      };
      document.addEventListener("keydown", onKey);
      document.addEventListener("mousedown", onDown);
      activeEditCleanup = () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("mousedown", onDown);
      };
      // 刷新前落盘(P1 #9b):此前 load() 重画只摘监听、半打的标题静默蒸发(远端一有
      // 动静就丢)。未改动/空/保存中 = 无事(false);失败上 op-err 横幅并附草稿,不无声。
      activeEditFlush = async () => {
        const v = input.value;
        if (saving || v.trim() === "" || v === item.title) return false;
        try {
          await invoke("rename_task", { id: item.id, title: v });
          return true;
        } catch (e) {
          showOpError(t("board.renameFailed", { title: item.title, err: String(e), draft: v }));
          return false;
        }
      };

      // 编辑态显示该任务的标签(纯展示):编辑标题时能一眼看到挂了哪些标签。增删标签仍走
      // ⋯ 菜单(㊺:卡片分信息/操作),且此处若内联删标签会触发 load() 重渲、冲掉未保存的
      // 标题,故只读。无标签则整行收起(nodes 为空)。
      const tagView = el(
        "div",
        { className: "task-meta task-topic" },
        item.topics.map((tp) => {
          const chip = el("span", { className: "chip topic set" }, [
            el("span", { className: "chip-label", textContent: tp.title }),
          ]);
          applyTagColor(chip, tp.color);
          return chip;
        }),
      );
      // Enter/点别处 保存、Esc 取消、Ctrl+V 配图 都是隐式手势,不再常驻一行说明书。
      c.replaceChildren(el("div", { className: "edit-form" }, [input, tagView, err, imgEditor]));
      input.focus();
      input.select();
      autoGrow(input);
    }

    // Read-only thumbnail strip — both board & trash cards show their images (editing them
    // lives in board-mode openEdit). Appended last so it sits below the meta/tags.
    c.append(imageStrip(item.id, { editable: false }).root);
    void loadImages(); // linkify the 标题 once the metas arrive

    return c;
  }

  function renderBoard(items: TaskItem[]): void {
    board.className = "board-wrap";
    // 复制看板: copies every non-empty column as Markdown. Built from the currently
    // shown tasks, so it respects the active filters (标签 and/or 文本).
    copySlot.replaceChildren(copyButton(boardMarkdown(cols, items), "hbtn", t("board.copyBoard")));
    const sections = cols.map((col) => {
      const status = col.id;
      const name = columnName(col);
      const inCol = items.filter((t) => t.status === status);
      const head = el("div", { className: "col-head" }, [
        el("span", { className: "col-name", textContent: name }),
        el("span", { className: "col-count", textContent: String(inCol.length) }),
      ]);
      // §4.3 的只读收容区:这一列已被(多半是对端)删掉,但本端还有卡扣在里面。列头挂一枚
      // 「已删除」标,卡只出不进(下面不给它接 dragover/drop);卡拖光了它自然不再出现。
      if (col.deleted) head.append(el("span", { className: "col-gone", textContent: t("board.colDeleted") }));
      // 复制本列为 Markdown (only when the column has cards).
      if (inCol.length > 0) head.append(copyButton(columnMarkdown(name, status, inCol), "col-copy", t("board.copy")));
      // 一键全部归档(仅 已完成 列、非空时):干完的活整列入成就册。非破坏、可逐条取消
      // 归档,但批量动一整列仍值得一次行内确认(swap 在列头的 slot 里,不弹窗)。
      if (status === DONE_COLUMN && inCol.length > 0) {
        const slot = el("span", { className: "seal-all-slot" });
        slot.append(
          btn(t("board.sealAll"), "ghost", () =>
            confirmInline(slot, t("board.sealAllQ", { n: inCol.length }), t("board.seal"), sealAllDone)),
        );
        head.append(slot);
      }
      const body = el("div", { className: "col-body" });
      // 空列不放占位符:col-body 是 flex:1 自撑满、仍是有效拖放目标,列头的「0」计数已说明空。
      if (inCol.length > 0) body.append(...inCol.map((t) => card(t, "board")));

      // 一节列身。⭐ **class 与 data-col 两份是有意的**:`class` 那份是 CSS 与 e2e 选择器
      // 的老口径(`.col.done` 之类),而**查列一律走 `data-col`** —— 自定义列的 id 是 ULID,
      // 可能以数字开头,`.col.01J…` 是**非法 CSS 选择器**(querySelector 当场抛)。
      // ⛔ 别把机器读的那一份挪回 class。
      const section = (extra: string): HTMLElement => {
        const sec = el("section", { className: `col ${status}${extra}` }, [head, body]);
        sec.dataset.col = status;
        return sec;
      };

      // 已删的列**不接放**:core 的 `is_live_task_column` 会拒(§4.3「卡只出不进」),
      // 这里不注册 dragover ⇒ 光标就是「不可放下」,而不是放下去再报错。⛔ 别改成
      // 「接下来再报错」——那是把一条已知的拒绝演成一次失败操作。
      if (col.deleted) return section(" col-readonly");

      // The column body is a drop target: a drop reorders within this column, or —
      // from another column — moves the task here AND inserts it at the dropped spot.
      // Under a topic filter the DOM is only the visible subset, so the drop routes to
      // reorder_task_visible (merged server-side); see the drop handler below.
      // Hover highlight is managed centrally here (clear all, set the one under the
      // pointer) rather than via dragleave — dragleave fires as the pointer crosses
      // child cards, and toggling the class off/on each time made the column blink.
      body.addEventListener("dragover", (e) => {
        if (!dragging) return;
        e.preventDefault();
        clearDropHovers();
        body.classList.add("drop-hover");
        placeDropLine(body, e.clientY);
      });
      body.addEventListener("drop", (e) => {
        e.preventDefault();
        const d = dragging;
        dragging = null;
        const after = dragAfterElement(body, e.clientY);
        clearDropHovers();
        detachDropLine();
        if (!d) return;
        // 上一单还在途:整个手势不接——reorder() 会静默拒,先做乐观移位会留下无人
        // 持久化的假位置(手势即回执的旁路复核:不落账就不动 DOM)。
        if (busy) return;
        // The target column's current order (DOM): includes the dragged card for a
        // same-column move, excludes it for a cross-column one — matching what the
        // backend sees as `base_target_ids` before the move.
        const base = [...body.querySelectorAll<HTMLElement>(".tcard")].map((c) => c.dataset.taskId!);
        const others = base.filter((x) => x !== d.id);
        const idx = after ? others.indexOf(after.dataset.taskId!) : others.length;
        const ordered = [...others.slice(0, idx), d.id, ...others.slice(idx)];
        // Same column, unchanged order → nothing to persist.
        if (d.from === status && ordered.join(" ") === base.join(" ")) return;
        // 手势即回执(ui-guidelines §3.6):松手这一帧就把卡挪进落点——此前视觉上原卡
        // 一直留在旧位,dragend 摘掉半透明后会「先弹回原位、重载后再跳到目标」。base
        // 已按移动前的 DOM 取好,这里挪的只是元素;真相由随后的 load() 校正(失败同样
        // 由它复原)。ULID 仅字母数字,选择器安全。
        const dropped = board.querySelector<HTMLElement>(`[data-task-id="${d.id}"]`);
        if (dropped) body.insertBefore(dropped, after);
        // 跨列才改列计数:源列 −1、目标列 +1(同列内重排成员数不变,故按 from≠target 判)。
        if (d.from !== status) {
          bumpColCount(d.from, -1);
          bumpColCount(status, 1);
        }
        if (filtered) reorderVisible(d.id, d.from, status, base, ordered);
        else reorder(d.id, d.from, status, base, ordered);
      });
      return section("");
    });

    // The 归档 drop strip below the columns — only a 已完成 card may land here.
    const zone = el("div", { className: "archive-zone" }, [
      el("span", { className: "az-label", textContent: t("board.archiveZoneHint") }),
    ]);
    zone.addEventListener("dragover", (e) => {
      if (dragging && dragging.from === DONE_COLUMN) {
        e.preventDefault();
        clearDropHovers();
        zone.classList.add("drop-hover");
        detachDropLine(); // a column line shouldn't linger while hovering 归档
      }
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-hover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drop-hover");
      const d = dragging;
      dragging = null;
      if (!d || d.from !== DONE_COLUMN) return;
      // 真归档(成就册),不再是丢回收站——「归档」一词自此只有一个意思(概念隔离)。
      // 手势即回执:松手即离场,不等重载才消失;失败由 sealOne 内的 load() 复原。
      board.querySelector(`[data-task-id="${d.id}"]`)?.remove();
      bumpColCount(DONE_COLUMN, -1); // 卡即刻离场,计数同帧扣掉,别等 sealOne 内的 load()
      sealOne(d.id);
    });

    const cols_wrap = el("div", { className: "cols" }, sections);
    board.replaceChildren(cols_wrap, zone);
    // 还原各列滚动位(记录见 load() 重画定局处;列变短时 scrollTop 由浏览器自钳位)。
    for (const sec of board.querySelectorAll<HTMLElement>(".col")) {
      const colBody = sec.querySelector<HTMLElement>(".col-body");
      const id = sec.dataset.col;
      if (colBody && id) colBody.scrollTop = colScroll.get(id) ?? 0;
    }
  }

  function renderTrash(items: TaskItem[]): void {
    if (items.length === 0) {
      renderCentered(
        el("div", { className: "big", textContent: t("board.trashEmpty") }),
        el("div", { textContent: t("board.trashEmptyHint") }),
      );
      return;
    }
    board.className = "trash";
    const bar = el("div", { className: "trash-bar" }, [
      el("span", { className: "grow", textContent: t("board.trashCount", { n: items.length }) }),
    ]);
    const clear = btn(t("board.emptyTrash"), "ghost", () =>
      confirmInline(bar, t("board.purgeAllQ", { n: items.length }), t("board.purgeAllYes"), purgeAll));
    bar.append(clear);
    const list = el("div", { className: "trash-list" }, items.map((t) => card(t, "trash")));
    board.replaceChildren(bar, list);
  }

  // 归档册:干完的活按**完成日**分组成时间轴(0030 决定 A:完成时刻优先,老卡无 done_at
  // 时回落归档日 sealed_at;同灵感 ㊳ 的按天分组,共享 dayKey/dayLabel)。批量归档不再把
  // 一周的活压成归档那天——答得准「什么时候干完」。只读 + 每卡一个「取消归档」;无删除入口。
  function renderSealed(items: TaskItem[]): void {
    if (items.length === 0) {
      renderCentered(
        el("div", { className: "big", textContent: t("board.sealedEmpty") }),
        el("div", { textContent: t("board.sealedEmptyHint") }),
      );
      return;
    }
    board.className = "trash sealed-view";
    // 分组时刻 = 完成时刻优先、老卡回落归档时刻(后端已按同一 COALESCE 降序排好)。
    // sealed_at 契约上恒非 null,故 groupTs 必得一个可比时刻。
    const groupTs = (t: TaskItem): string => t.done_at ?? t.sealed_at!;
    // 头部一行统计(纯派生、只算不存):本周**完成**几条 + 累计成就。计数口径 = 完成日
    // (回落归档日),与下面按完成日分组同轴,故称「本周完成」而非「本周归档」——上周完成、
    // 本周才入册的不会误算进本周(决定 A 的措辞收口)。
    const monday = startOfWeek();
    const week = items.filter((t) => new Date(groupTs(t)) >= monday).length;
    const bar = el("div", { className: "trash-bar" }, [
      el("span", { className: "grow", textContent: t("board.sealedStats", { week, total: items.length }) }),
    ]);
    const list = el("div", { className: "trash-list" });
    let lastDay = "";
    for (const t of items) {
      // list_sealed_tasks 只返回已归档行,sealed_at 恒非 null(契约);缺了是真 bug,fail fast。
      if (!t.sealed_at) throw new Error(`归档条目缺 sealed_at:${t.id}`);
      const ts = groupTs(t);
      const k = dayKey(ts);
      if (k !== lastDay) {
        lastDay = k;
        list.append(el("div", { className: "tl-date", textContent: dayLabel(ts) }));
      }
      list.append(card(t, "sealed"));
    }
    board.replaceChildren(bar, list);
  }

  function renderCentered(...children: Node[]): void {
    board.className = "centered";
    board.replaceChildren(el("div", { className: "center" }, children));
  }

  function renderEmpty(): void {
    renderCentered(
      el("div", { className: "big", textContent: t("board.empty") }),
      el("div", {
        textContent: t("board.emptyHint"),
      }),
    );
  }

  function renderFilteredEmpty(): void {
    // 文本过滤(可能叠着标签)筛空:提示词本身,别让用户以为看板空了。
    const q = filter.text.trim();
    if (q !== "") {
      renderCentered(
        el("div", { className: "big", textContent: t("board.noMatch", { q }) }),
        el("div", { textContent: t("board.noMatchHint") }),
      );
      return;
    }
    // 只有时间轴在筛(类型/标签都是「全部」):selectedTopicLabels 会给出空标签,
    // 「「」下没有任务」是句坏文案——单独给时间轴一句话(461)。
    if (filter.kind === "all" && filter.topics.length === 0 && timeFilter !== "all") {
      renderCentered(
        el("div", { className: "big", textContent: t("board.noTasksInTime") }),
        el("div", { textContent: t("board.noTasksInTimeHint") }),
      );
      return;
    }
    const label = selectedTopicLabels(filter, allTopics).join(t("board.listSeparator"));
    renderCentered(
      el("div", { className: "big", textContent: t("board.noTasksUnder", { label }) }),
      el("div", { textContent: t("board.noTasksUnderHint") }),
    );
  }

  // 只给「读取失败」(load 整批拉取挂了)用;卡级操作失败走 op-err 横幅。带「重试」
  // ——错误页把看板整个替换掉了,总得给一条不切视图的回头路(ui-audit P0 #6)。
  function renderError(message: string): void {
    renderCentered(
      el("div", { className: "big", textContent: t("board.loadFailed") }),
      el("div", { className: "err-box", textContent: message }),
      el("button", { className: "act ghost", textContent: t("board.retry"), onclick: () => void load() }),
    );
  }

  // `refocus` is set only by the window-refocus reload (alt-tab back): that path
  // skips the DOM rebuild when nothing changed, so refreshing doesn't flicker. Every
  // other caller (mutations, toggles, first load) renders unconditionally — image
  // attach/detach refreshes via strip.reload() and isn't in list_tasks, so an explicit
  // load() must always repaint to relink body 图N chips.
  async function load(refocus = false): Promise<void> {
    if (unmounted) return; // 死 mount 不再发起任何加载(codex M1)
    today = localToday();
    const seq = ++loadSeq;
    try {
      const [active, archived, sealed, topics, allCols, , cmCounts] = await Promise.all([
        invoke<TaskItem[]>("list_tasks"),
        invoke<TaskItem[]>("list_archived_tasks"),
        invoke<TaskItem[]>("list_sealed_tasks"),
        invoke<TopicOpt[]>("list_topics"),
        // 看板列(B-f 第 1 段):同样**并发**取。⚠ 它与 list_tasks 是两次独立读,中间那一
        // 瞬对端可能刚删掉一列 —— 无害:两份都是快照,最坏是这一帧少画/多画一列的收容区,
        // 下一次 load 就对上了。⛔ 别为它去开一条「一次读两样」的合并命令(那要在 core 里
        // 造第二份口径)。
        loadBoardColumns(),
        // 设备名册(0033 署名):与列表**并发**取,不给渲染加一跳延迟。
        loadIdentity(mountSpace),
        // 留言计数(0035 徽章):同样并发;列表另走分页(§4.14.2 第 4 条)。
        loadCommentCounts(mountSpace),
      ]);
      if (seq !== loadSeq) return; // 有更晚的 load 已在途:旧响应不落 DOM(否则盖新画/拆脉冲)
      // focus 只由**确认最新**的这一发消费(codex 三审 H1):放在 seq 守卫之后取走——陈旧的
      // load 直接 return、不碰 focusId,跳转请求因此永远交给真正会渲染的那一发,不会丢。
      const focus = focusId;
      focusId = null;
      allTopics = topics;
      cols = boardColumns(allCols);

      // 死标签回落 + 匹配口径归一(trim+忽略大小写)都在共享件;回落是纯状态修正
      // (no DOM),必须先于指纹。
      reconcileTopicFilter(filter, allTopics);
      reconcileKindFilter(filter, allTopics); // 死类型回落 + 切类型后标签轴归一(纯状态,先于指纹)
      const q = filter.text.trim().toLowerCase();

      // Fingerprint everything that affects the DOM; an idle refocus whose fingerprint
      // matches the last render bails before touching a single card (no flicker). An
      // open inline editor / hover state survives such a refocus untouched.
      // 留言计数进指纹:别的设备写了一条留言,任务数据一个字节没变、只有徽章要变数字
      // ——不进指纹的话 refocus 刷新会在这一格短路掉(同灵感)。
      const sig = JSON.stringify([
        boardView,
        filter.kind,
        filter.topics,
        timeFilter,
        q,
        today,
        active,
        archived,
        sealed,
        topics,
        // 列进指纹:别台设备给列改了名 / 调了顺序 / 删了一列,任务数据一个字节没变、
        // 变的只有列头与列序 —— 不进指纹的话 refocus 刷新会在这一格短路掉(同 cmCounts)。
        cols,
        cmCounts,
        // 设备名册(317):同 cmCounts 的理由——别台设备改别名时任务数据不动,变的
        // 只有署名 chip 与留言层里那行作者。
        identitySig(mountSpace),
      ]);
      // `=== true`, not truthy: `load` is also wired as a bare onclick handler in a few
      // places, so a stray MouseEvent must never count as a refocus and skip the repaint.
      // pendingEditId 在场时不短路(codex 二审 M):requestEdit 的那发若被更新的同签名
      // refocus 顶掉,短路会把「开编辑」饿死——编辑请求必须由真正渲染的一发兑现。
      if (refocus === true && sig === lastSig && pendingEditId === null) return;
      lastSig = sig;

      // Cards are about to be replaced — drop any stale hover-select / open menu first,
      // and tear down a previous editor's document-level key listener (it would leak
      // otherwise). Placed after the refocus short-circuit so an idle refocus whose
      // fingerprint matches keeps an open editor (and its listener) untouched.
      // 重画已成定局:开着的编辑器先落盘再画(P1 #9b)。先摘监听防 await 期间重入;
      // 真写了就以落盘后的真相重取重画(flush 已清空,重入的 load 不再进这条分支)。
      if (activeEditFlush) {
        const flushEdit = activeEditFlush;
        activeEditFlush = null;
        if (activeEditCleanup) {
          activeEditCleanup();
          activeEditCleanup = null;
        }
        const wrote = await flushEdit();
        // flush 的 await 里 mount 可能死了/更新的 load 已在途(codex 二审 M):本发作废。
        if (unmounted || seq !== loadSeq) return;
        if (wrote) {
          void load();
          return;
        }
      }
      // 重画已定局:先记下各列滚动位(renderBoard 落 DOM 后还原;切去回收站/归档再回
      // 来,还原的也是看板上一次的现场)。
      for (const sec of board.querySelectorAll<HTMLElement>(".col")) {
        const colBody = sec.querySelector<HTMLElement>(".col-body");
        const id = sec.dataset.col;
        if (colBody && id) colScroll.set(id, colBody.scrollTop);
      }
      hk.reset();
      // 留言浮层:宿主还在就重拉第一页,已经离开这个视图(删了 / 移走了 / 撤回成灵感)
      // 就关掉——别让人对着不在了的条目写话(同灵感)。
      refreshOpenComments(mountSpace, [...active, ...archived, ...sealed].map((t) => t.id));
      disarmConfirm(); // 卡片将被整批替换:在场确认的文档级监听一并收走
      if (activeEditCleanup) {
        activeEditCleanup();
        activeEditCleanup = null;
      }
      // Cleared here; renderBoard re-adds the 复制看板 button. Trash/empty states have
      // nothing to copy, so the slot stays empty.
      copySlot.replaceChildren();

      // The toggles always reflect the live counts.
      trashN.textContent = String(archived.length);
      trashToggle.classList.toggle("active", boardView === "trash");
      trashToggle.firstChild!.textContent = boardView === "trash" ? t("board.backToBoard") : t("board.trashLbl");
      sealN.textContent = String(sealed.length);
      sealToggle.classList.toggle("active", boardView === "sealed");
      sealToggle.firstChild!.textContent = boardView === "sealed" ? t("board.backToBoard") : t("board.sealLbl");

      // 新建任务 only makes sense on the board, not in the 回收站/归档.
      addTaskBtn.hidden = boardView !== "board";
      if (boardView !== "board") setComposeOpen(false);

      // 搜索直达回收站/归档(P1 #8):目标在列表才脉冲+滚动;已离场(还原/取消归档的
      // 窄窗)静态落列表,不残留。
      if (boardView === "trash") {
        filterRow.hidden = true;
        if (focus !== null && archived.some((t) => t.id === focus)) locateId = focus;
        renderTrash(archived);
        if (focus !== null) board.querySelector(".just-located")?.scrollIntoView({ block: "center" });
        return;
      }
      if (boardView === "sealed") {
        filterRow.hidden = true;
        if (focus !== null && sealed.some((t) => t.id === focus)) locateId = focus;
        renderSealed(sealed);
        if (focus !== null) board.querySelector(".just-located")?.scrollIntoView({ block: "center" });
        return;
      }
      // 只显示 / 只计数「落在画出来的那几列里」的卡,列头计数因此永远与看板上的卡一致。
      // ⭐ **B-f 第 1 段起这一句不再会静默吞卡**:`cols` 是从库里查来的,已删但还扣着卡的
      // 列也在里面(§4.3 收容区)⇒ 每张活着的任务卡都必有归宿。⚠ 它仍是一道 fail-safe:
      // 真出现「卡的 stage 不在任何画出来的列里」= 那一列凭空消失了,那时宁可少画一张卡也
      // 不让列头计数与看板打架 —— 但那是**损坏**,不是常态。
      const visible = active.filter((t) => cols.some((c) => c.id === t.status));

      // 跨视图跳转(搜索命中任务 → 看板):focus 已在上方 seq 守卫之后取走(`focus`)。
      // 目标仍在看板(boardView==='board' 且在 visible)才动作——**在过滤之前**清掉标签/
      // 文本筛选让目标必然进 shown(跳转即揭示,不被筛掉白跳),并设 locateId 让下方 card()
      // 给它持续高亮;真正的滚动在 renderBoard 落 DOM 后做。目标已离开看板(归档/入册/删
      // 的窄窗)= 不高亮/不滚动,静态落看板(它的归宿),状态不残留。
      const focusOnBoard = focus !== null && visible.some((t) => t.id === focus);
      if (focusOnBoard) {
        filter.kind = "all";
        filter.topics = [];
        filter.text = "";
        filterInput.value = "";
        timeFilter = "all"; // 时间轴同理清掉,别让旧选中把跳转目标筛没了
        locateId = focus;
      }

      // The filter row (状态[时间]/标签 pills + 文本过滤框) only appears once there is
      // something to filter. Pills 计数与三维应用都在共享件(与灵感同源);文本只匹配
      // 当前标题。时间轴(461)在类型轴之下、标签轴之上——独立第四维,先按创建时间
      // 分区圈定,类型/标签 pill 的计数与筛选都在这个已收窄的集合里算(同 kind 圈定
      // topics 的先后关系)。
      filterRow.hidden = visible.length === 0;
      const timeNarrowed = applyTimeFilter(visible, timeFilter, (t) => t.created_at);
      if (visible.length > 0) {
        renderTimePills(timeBar, visible, (t) => t.created_at, timeFilter, (b) => {
          timeFilter = b;
          void load();
        });
        // 类型轴在标签 pills 之上(路线 A 钻取器);renderKindPills 无 kind 时清空、CSS
        // :empty 隐整行。标签 pills 随 kind 收到该类型内(见 filter-bar.ts)。
        renderKindPills(kindBar, timeNarrowed, allTopics, filter, () => void load());
        renderFilterPills(filterBar, timeNarrowed, allTopics, filter, () => void load());
        wireTagPills();
      }

      const shown = applyFilter(timeNarrowed, filter, (t) => t.title, allTopics);

      // Filtered(时间/标签/文本任一激活): the column DOM is only the visible subset, so
      // drops route through reorder_task_visible (merged server-side). Unfiltered: the
      // strong-contract path.
      filtered = timeFilter !== "all" || filterActive(filter);

      if (visible.length === 0) renderEmpty();
      else if (shown.length === 0) renderFilteredEmpty();
      else {
        renderBoard(shown);
        // 目标已清筛 → 必在 shown 里;落 DOM 后滚到视野中央(ULID 仅字母数字,选择器安全)。
        if (focusOnBoard) {
          board
            .querySelector<HTMLElement>(`[data-task-id="${focus}"]`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    } catch (err) {
      if (seq !== loadSeq) return; // 旧请求晚失败:新请求已成功渲染,别用旧错误盖掉(codex 三审 H2)
      lastSig = ""; // error path painted — let the next load re-render even if data matches
      disarmConfirm(); // 换错误页也是整批替换:在场确认的文档级监听一并收走(codex 二审 M)
      renderError(String(err));
    }
  }

  function toggleTrash(): void {
    boardView = boardView === "trash" ? "board" : "trash";
    load();
  }
  trashToggle.addEventListener("click", toggleTrash);

  function toggleSealed(): void {
    boardView = boardView === "sealed" ? "board" : "sealed";
    load();
  }
  sealToggle.addEventListener("click", toggleSealed);

  // 视图级全局单键(不悬停卡片也生效;键义和卡片单键错开):N 新建任务、R 回收站切换、
  // G 归档切换(卡片单键 A 是「归档这张卡」,视图键须错开)。全屏时鼠标要跑到右上角很远,
  // 键盘直达。
  const teardownViewKeys = registerViewKeys([
    { key: "N", run: () => { if (boardView === "board") setComposeOpen(true); } },
    { key: "R", run: toggleTrash },
    { key: "G", run: toggleSealed },
  ]);

  composeCtl.setLiveReload(() => void load()); // 本 mount 即当前活看板:旧保存链落账后经它通知重读(codex 四审 M)
  void load();

  return {
    unmount() {
      // 作废本 mount 的在途 load(codex 四审 H):loadSeq 是 mount 局部,但 focusId 是模块
      // 全局——不 bump 的话,旧 mount 晚回的 load 仍满足自己的 seq 守卫,会消费掉后来新
      // mount 的 focusId、在已脱离 DOM 的旧看板上渲染,新看板反而拿不到跳转。顺带清 focusId,
      // 明确取消"离开看板时尚未落地的这次定位"。
      unmounted = true;
      composeCtl.setLiveReload(null); // navigate 恒先 unmount 再 mount:新 mount 会立即接管
      loadSeq++;
      focusId = null;
      disarmConfirm(); // 在场确认的文档级 Esc/mousedown 监听不跨 mount 存活
      // (P1 #9a)开着的编辑器:摘文档级监听,**刻意不 flush**——unmount 可能因切空间
      // 而来,此刻 invoke 已注入新空间 id,绝不能把旧条目的标题写进新空间(112 结算哲学:
      // 写命令携带「动作那一刻看到的空间」,这里没有动作,只有离场)。
      if (activeEditCleanup) {
        activeEditCleanup();
        activeEditCleanup = null;
      }
      activeEditFlush = null;
      closeComments(); // 浮层 portal 在 body 上,不随视图根节点走:切视图/切空间必须自己收
      teardownViewKeys();
      hk.destroy(); // tear down the document keydown + any lingering menu listeners
      // (P1 #9d)compose 草稿与暂存图跨视图存活:文字过桥进模块态,composeCtl.imgs 本身
      // 模块级、root 随下一个 mount 搬家(此前这里 clear 掉=切个视图就丢图)。空间标记
      // 用 mount 时捕获的 mountSpace(codex H1)。
      composeCtl.stashDraft(composeInput.value, mountSpace);
      root.replaceChildren();
    },
    onFocus() {
      load(true);
    },
  };
}
